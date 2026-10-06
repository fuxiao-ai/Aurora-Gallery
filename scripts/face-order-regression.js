'use strict';
/**
 * 人脸「读取顺序」契约守护。
 *
 * ## 守的是什么
 *
 * 人脸聚类的结果依赖**节点下标**——`chineseWhispers` 的初始标签是 `labels[i] = i`、
 * 平票靠 `heap.nodes[]` 的数组顺序决胜、每轮巡访是「先对下标做 Fisher-Yates」；
 * `representatives()` 的数组顺序还决定 `groupScore` 抽哪 16 个成员、以及 `put()` 里
 * `for (const [person] of representatives)` 的平票归属。
 *
 * 而 `faces.id` 是**插入顺序 = 扫描顺序**（父表 `scans` 带 `ON DELETE CASCADE` ⇒
 * 重扫一张照片就删掉重插、拿新的高位 id）。所以只要读顺序还挂在 `faces.id` 上：
 *   ① 把索引扫描改成倒序（"最新入库优先"，本次的目标）就会改动归组结果；
 *   ② **重扫任意一张照片**就会把它挪到聚类节点序的末尾 —— 同内容重跑给出不同分组。
 *
 * 契约：所有聚类读取一律走 `FACE_ORDER = 'ORDER BY f.photo_id, f.id'`（内容决定）。
 * 唯一豁免是 `photos()` 的分页游标（人物页无限滚动，与聚类无关）。
 *
 * ## 为什么行为面这样测
 *
 * 一开始想「用两种插入顺序建库，比 regroup 的划分是否相同」——**测不出判别性**：
 * 实测等距/链式夹具在 CW 下都塌成连通分量，而连通分量的划分对下标不敏感。
 * 所以改成**直接观测读取顺序本身**：用 `folder` 归组让所有脸落进同一个人，
 * 再按内容识别 `representatives()` 里向量出现的先后。插入顺序相反的两个库若都得到
 * 同一个内容序，就说明读顺序确实由内容决定。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');
const Database = require('better-sqlite3');
const { FaceStore } = require('../src/ai/face-store');
const { VECTOR_DIM, normalize, unpack } = require('../src/ai/face-model');

const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'src', 'ai', 'face-store.js');
const WORKER = path.join(ROOT, 'src', 'workers', 'face-worker.js');
const RUN = path.join(ROOT, 'scripts', 'run-regressions.js');

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}
const read = (p) => fs.readFileSync(p, 'utf8');
/**
 * 剥掉注释，但**保持长度与换行** —— 否则「这行代码里有没有 `ORDER BY f.id`」会被
 * 注释骗过去：`FACE_ORDER` 那段说明里就引用了旧写法三次。
 *
 * ⚠️ 走 acorn（它自己懂注释与正则字面量的区别）。本项目已有先例：
 * 状态机版不认含引号的正则，会从那里错位、之后所有注释都剥不掉 ⇒ 假红/假绿。
 * 见 `home-page-regression.js:67` 与 `dead-reference-regression.js:223`。
 */
function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}
/** 取一段方法体，用于「这行必须在这个函数里」类断言 */
function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

const storeSrc = stripComments(read(STORE));
const workerSrc = stripComments(read(WORKER));
const runSrc = read(RUN);

// ------------------------------------------------ 1. 规范顺序是单一来源

check(
  '夹具自证：acorn 确实剥掉了注释（否则注释里引用的旧写法会被当成结构判据）',
  !storeSrc.includes('不要退回') && !workerSrc.includes('静默零扫'),
);

check(
  '🔴 FACE_ORDER 存在且就是内容序（photo_id, id）',
  /const FACE_ORDER = 'ORDER BY f\.photo_id, f\.id';/.test(storeSrc),
);

const CLUSTER_READS = [
  ['representatives() {', 'representatives'],
  ['regroupByCluster(options) {', 'regroupByCluster'],
  ['regroupByFolder(options) {', 'regroupByFolder'],
  ['regroupByDomain(options) {', 'regroupByDomain'],
];
for (const [sig, label] of CLUSTER_READS) {
  const body = bodyOf(storeSrc, sig);
  check('夹具自证：取到了 ' + label + ' 的函数体', body.length > 0);
  check('🔴 ' + label + ' 的读取用 ${FACE_ORDER}（内容序）', body.includes('${FACE_ORDER}'));
  check(
    '🔴 ' + label + ' 里不得再出现字面 ORDER BY f.id（= 挂回插入序）',
    !/ORDER BY\s+f\.id/.test(body),
  );
}

// `photos()` 是唯一豁免：人物页无限滚动的分页游标，游标值就是 `f.id` 本身
const byIdHits = storeSrc.match(/ORDER BY\s+f\.id\b/g) || [];
const photosBody = bodyOf(storeSrc, 'photos(personId, after = 0) {');
check(
  '夹具自证：取到了 photos() 的函数体（豁免项）',
  photosBody.length > 0 && /ORDER BY\s+f\.id/.test(photosBody),
);
check(
  '🔴 全文 `ORDER BY f.id` 只允许剩 photos() 那一处（多一处 = 聚类又挂回了插入序）',
  byIdHits.length === 1,
  '实测 ' + byIdHits.length + ' 处',
);

// ------------------------------------------------ 2. 扫描方向：倒序 + 排他上界

const batchBody = bodyOf(storeSrc, 'batch(beforeId) {');
check('夹具自证：取到了 batch() 的函数体', batchBody.length > 0);
check('🔴 batch() 的游标是排他上界 `p.id < ?`', batchBody.includes('p.id < ?'));
check('🔴 batch() 按主键倒序取（最新入库优先）', /ORDER BY p\.id DESC/.test(batchBody));
check(
  '🔴 batch() 不得残留升序写法（`p.id > ?` / `ORDER BY p.id` 无 DESC）',
  !batchBody.includes('p.id > ?') && !/ORDER BY p\.id(?! DESC)/.test(batchBody),
);
check('batch() 的批大小仍是 8 张/批', /LIMIT 8/.test(batchBody));

const maxBody = bodyOf(storeSrc, 'maxPhotoId() {');
check('夹具自证：取到了 maxPhotoId() 的函数体', maxBody.length > 0);
check(
  '🔴 maxPhotoId() 取 photos 的最大 id（游标起点用；`id` 是 rowid 别名 ⇒ 索引定位）',
  /MAX\(id\)/.test(maxBody) && maxBody.includes('photos'),
);

// ------------------------------------------------ 3. 调用端必须同向（只改查询 = 静默零扫）

check(
  '🔴 索引循环起手 `store.maxPhotoId() + 1`（写成 0 ⇒ `p.id < 0` 恒空、任务秒完成却一张没扫）',
  /beforeId\s*=\s*store\.maxPhotoId\(\)\s*\+\s*1/.test(workerSrc),
);
check('🔴 索引循环取批走 `store.batch(beforeId)`', workerSrc.includes('store.batch(beforeId)'));
check(
  '🔴 游标续接必须写回 `beforeId = photo.id`（倒序下最后一行是最小 id ⇒ 严格递减）',
  workerSrc.includes('beforeId = photo.id'),
);
check(
  '🔴 face-worker 不得残留旧游标名（`store.batch(after)` / `after = photo.id`）',
  !workerSrc.includes('store.batch(after)') && !/\bafter\s*=\s*photo\.id/.test(workerSrc),
);
check(
  '⚠️ 人物页分页仍用 args.after（那是 UI 分页参数，与扫描游标无关，别一起改）',
  workerSrc.includes('store.photos(args.personId, args.after)'),
);

// ------------------------------------------------ 4. 行为面：读顺序由内容决定

const FACE_AXIS = [0, 1, 2];
function axisVector(axis) {
  const v = new Float32Array(VECTOR_DIM);
  v[axis] = 1;
  return normalize(v);
}
/** 按内容识别一个向量（它是第几个基轴），与它第几个入库无关 */
function axisOf(vector) {
  let best = -1;
  let bestValue = -Infinity;
  for (let i = 0; i < vector.length; i++)
    if (vector[i] > bestValue) {
      bestValue = vector[i];
      best = i;
    }
  return best;
}

function runBehavior() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-face-order-'));
  let asc = null;
  let desc = null;
  let fresh = null;
  try {
    const dbPath = path.join(directory, 'photos.db');
    const source = new Database(dbPath);
    source.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, file_type TEXT,
      file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    const PHOTOS = 30;
    // 全部放在同一目录：`folder` 归组下它们必然落进同一个人，与相似度无关 ——
    // 这样 `representatives()` 里向量的先后就**纯粹**反映读取顺序。
    const sameFolder = (n) => '/fixtures/album/' + n + '.jpg';
    for (let i = 1; i <= PHOTOS; i++)
      source
        .prepare('INSERT INTO photos VALUES (?, ?, ?, ?, 10, ?, NULL, 100, 100, 0, 0)')
        .run(i, sameFolder(i), i + '.jpg', 'jpg', '2026-09-27');
    source.close();

    const photo = (n) => ({
      id: n,
      file_name: n + '.jpg',
      file_path: sameFolder(n),
      file_size: 10,
      date_modified: '2026-09-27',
    });
    /** 按给定顺序「跑一遍索引」；只有前 3 张带脸，且分属 3 个互不相同的基轴 */
    const scan = (label, order) => {
      const store = new FaceStore(dbPath, path.join(directory, label + '.sqlite'));
      const representatives = store.representatives();
      for (const n of order) {
        const axis = FACE_AXIS[n - 1];
        const detections =
          axis === undefined
            ? []
            : [{ vector: axisVector(axis), thumbnail: Buffer.from('fixture'), box: [0, 0, 1, 1] }];
        store.put(photo(n), detections, representatives, { grouping: 'folder', groupingDepth: 2 });
      }
      return store;
    };

    asc = scan('asc', [1, 2, 3]);
    desc = scan('desc', [3, 2, 1]);

    const argmaxSeq = (store) => {
      const map = store.representatives();
      const out = [];
      for (const vectors of map.values()) for (const v of vectors) out.push(axisOf(v));
      return out;
    };

    // 夹具自证：两个库的插入顺序确实相反（否则下面两条都是废话）
    const rawA = asc.source.prepare('SELECT f.id, f.photo_id FROM faces f ORDER BY f.id').all();
    const rawD = desc.source.prepare('SELECT f.id, f.photo_id FROM faces f ORDER BY f.id').all();
    check(
      '夹具自证：两个库按 `ORDER BY f.id` 读出来的照片序**相反**（插入顺序确实不同）',
      JSON.stringify(rawA.map((r) => r.photo_id)) === '[1,2,3]' &&
        JSON.stringify(rawD.map((r) => r.photo_id)) === '[3,2,1]',
      'asc=' + JSON.stringify(rawA.map((r) => r.photo_id)) + ' desc=' + JSON.stringify(rawD.map((r) => r.photo_id)),
    );

    const seqA = argmaxSeq(asc);
    const seqD = argmaxSeq(desc);
    check(
      '夹具自证：两个库各取到 3 个向量、且都落在同一个人下（folder 归组的自证）',
      seqA.length === 3 && seqD.length === 3 && asc.representatives().size === 1,
      'asc=' + JSON.stringify(seqA) + ' desc=' + JSON.stringify(seqD),
    );
    check(
      '🔴 契约（行为面）：插入顺序相反的两个库，representatives() 的向量**内容序相同** —— ' +
        '否则 `groupScore` 的抽样成员与 put() 的平票归属都会随扫描方向漂移',
      JSON.stringify(seqA) === JSON.stringify(seqD) && seqA.length === 3,
      'asc=' + JSON.stringify(seqA) + ' desc=' + JSON.stringify(seqD),
    );
    check(
      '🔴 内容序就是 photo_id 序（向量按所属照片升序出现），不是插入序',
      JSON.stringify(seqA) === JSON.stringify([0, 1, 2]),
      JSON.stringify(seqA),
    );
    check(
      '夹具自证：faces.id 与 photo_id 的对应关系在两库间是发散的（否则上面那条可能是蒙的）',
      JSON.stringify(rawA.map((r) => [r.id, r.photo_id])) !==
        JSON.stringify(rawD.map((r) => [r.id, r.photo_id])),
    );
    // 🔴 判别性自证：在**旧顺序**（`ORDER BY f.id`）下两个库的内容序必须不同 ——
    // 否则上面那条「内容序相同」在改动前也成立，等于什么都没钉住。
    const legacySeq = (store) =>
      store.source
        .prepare('SELECT f.vector FROM faces f ORDER BY f.id')
        .all()
        .map((r) => axisOf(unpack(r.vector)));
    check(
      '🔴 判别性自证：换成旧的 `ORDER BY f.id` 读，两库内容序**确实不同** —— ' +
        '证明「内容序相同」这条不是空的（改动前它是红的）',
      JSON.stringify(legacySeq(asc)) !== JSON.stringify(legacySeq(desc)),
      'legacy asc=' + JSON.stringify(legacySeq(asc)) + ' legacy desc=' + JSON.stringify(legacySeq(desc)),
    );

    // -------------------------------------------- 5. 行为面：batch() 倒序游标不漏不重

    // 另起一个**没跑过任何 put()** 的库：上面两个库的 photo 1..3 已有 scans 行，
    // 会被 pending 谓词跳过（这不是 bug，但会让「覆盖全部 30 张」的断言算错分母）。
    fresh = new FaceStore(dbPath, path.join(directory, 'fresh.sqlite'));
    let cursor = fresh.maxPhotoId() + 1;
    const seen = [];
    for (let guard = 0; guard < 100; guard++) {
      const rows = fresh.batch(cursor);
      if (!rows.length) break;
      seen.push(...rows.map((r) => r.id));
      cursor = rows[rows.length - 1].id;
    }
    const descending = seen.every((v, i) => i === 0 || v < seen[i - 1]);
    check(
      '夹具自证：起手游标 = maxPhotoId() + 1，且第一次就取满 8 张（batch 的批大小）',
      fresh.maxPhotoId() === PHOTOS && fresh.batch(PHOTOS + 1).length === 8,
      'max=' + fresh.maxPhotoId() + ' 首批=' + fresh.batch(PHOTOS + 1).length,
    );
    check(
      '🔴 契约（行为面）：batch() 从最大 id 起严格递减、覆盖全部 30 张、不重不漏',
      seen.length === PHOTOS && descending && new Set(seen).size === PHOTOS,
      'n=' + seen.length + ' 严格递减=' + descending + ' 首=' + seen[0] + ' 尾=' + seen[seen.length - 1],
    );
    check(
      '🔴 游标是排他上界：以某 id 为界取不到该 id（这就是「不对同一行死循环重扫」的机制）',
      fresh.batch(3).length === 2 && fresh.batch(3).every((r) => r.id < 3),
      JSON.stringify(fresh.batch(3).map((r) => r.id)),
    );
    check(
      '⚠️ 起手必须用 `maxPhotoId() + 1`、不能用 0：`batch(0)` 为空（0 会让 `p.id < 0` 恒空 —— ' +
        '这正是「只改查询不改调用端」的静默失败现场）',
      fresh.batch(0).length === 0,
    );
  } finally {
    try {
      if (asc) asc.close();
      if (desc) desc.close();
      if (fresh) fresh.close();
    } catch (e) {
      void e;
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  }
}

try {
  runBehavior();
} catch (error) {
  check('行为面整体执行完成', false, error && error.message);
}

// ------------------------------------------------ 6. 登记进全量回归

check(
  '本守护已登记进 scripts/run-regressions.js',
  runSrc.includes("'face-order-regression.js'"),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[face-order-regression] 人脸读取顺序契约（内容序，与扫描方向解耦）\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[face-order-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[face-order-regression] PASS（' + notes.length + ' 项）\n');
