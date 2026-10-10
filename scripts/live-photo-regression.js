'use strict';

/**
 * Live Photo 支持的回归牙。
 *
 * ## 它守什么
 *
 * 1. **判据只能落在 Apple 的 identifier 上**，不能退化成文件名配对
 *    —— 后者在真库上有 5672 个「封面图 + 正片」假阳性（见 `src/main/live-photo.js`）。
 * 2. **三值逻辑**：`live_still_id` 的 NULL 与 0 是两件事（「还没查」与「查过不是」），
 *    而 `NOT (live_still_id > 0)` 对 NULL 行求值为 NULL ⇒ 会把**全部图片**从
 *    「所有媒体」档里吞掉。取反必须走 `COALESCE(live_still_id, 0) = 0`。
 * 2b. 🔴 **`all` 档的排除条件必须自适应**（2026-10-06 治本，`scripts/read-latency-regression.js`
 *    那边钉计划、这里钉行为）：`all` 是唯一没有别的限定条件的档，而该谓词匹配
 *    99.9999% 的行、`live_still_id` 又排在缩略图 BLOB 之后且无索引 ⇒ 直接把
 *    `COALESCE(...) = 0` 压上去会让计划退化成逐行回表（真库 478 ms → 105,954 ms，
 *    只排掉 1 行，用户看到的是「所有文件」报「照片加载失败」）。治本 = 换成
 *    `id NOT IN (SELECT id FROM photos WHERE live_still_id > 0)` + 部分索引
 *    `idx_photos_live_companion`，且**索引就绪之前一律不加**（那段时间 `NOT IN`
 *    与 `COALESCE` 一样慢，实测 231 ms vs 231 ms）。所以下面**两态都要断言**。
 * 3. **迁移的 DEFAULT**：`live_still_id` 一旦带 `DEFAULT 0`，存量库的行会被一次性
 *    填成「查过、不是伴生」，配对任务（认领 `IS NULL`）再也看不到它们 ⇒
 *    存量库永远配不出 Live Photo，且零报错。
 * 4. **字段传播**：`live_motion_id` 必须出现在照片列清单里，否则前端永远画不出角标。
 * 5. **收敛**：无论判定结果是什么都要落终态，否则每轮重读一遍盘。
 *
 * ## 样本为什么是代码合成的
 *
 * 回归牙**不许依赖外部素材**（换台机器就跳过 = 假绿）。所以这里用 `buildMov()` 手工
 * 拼出与 Apple 相机同构的 QuickTime atom（`moov/meta` 下的 `keys` + `ilst`，
 * 命名空间 `mdta`），并同时覆盖三种真实布局：
 *   · ISO 风格 `moov/meta`（带 4 字节 version+flags）
 *   · QuickTime 风格 `moov/udta/meta`
 *   · 历史写法：`meta` **不带** version+flags
 * 以及反例：结构一模一样但**没有那个 key** 的 MOV。
 *
 * 运行：`scripts/run-regressions.js`（或单独 `electron scripts/live-photo-regression.js`）
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const PhotoDatabase = require('../src/database');
const heavy = require('../src/db-heavy-read');
const pair = require('../src/main/live-photo-pair');
const livePhoto = require('../src/main/live-photo');

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) {
    pass++;
  } else {
    fails.push(name);
    console.log('  ✗ ' + name);
  }
}

// ---- MOV 合成工具 ----

const ZERO4 = Buffer.alloc(4);
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
/** `typeOrBytes` 可以是 4 字符 type，也可以是 4 字节 Buffer（ilst 子项存的是大端下标）。 */
function atomAt(typeOrBytes, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  if (Buffer.isBuffer(typeOrBytes)) typeOrBytes.copy(head, 4);
  else head.write(typeOrBytes, 4, 'latin1');
  return Buffer.concat([head, payload]);
}
function mdtaEntry(name) {
  const nb = Buffer.from(name, 'utf8');
  return Buffer.concat([u32(8 + nb.length), Buffer.from('mdta', 'latin1'), nb]);
}
/** ilst 的一项：`data` 子 atom = 类型指示(4) + locale(4) + UTF-8 值。 */
function dataAtom(value) {
  return atomAt('data', Buffer.concat([u32(1), ZERO4, Buffer.from(String(value), 'utf8')]));
}

const LIVE_ID = 'com.apple.quicktime.content.identifier';
const STILL_TIME = 'com.apple.quicktime.still-image-time';

/**
 * 合成一个 QuickTime 容器。
 * @param {string|null} liveId 非空 ⇒ key 列表里含 identifier 并带该值；空 ⇒ 只有无关的 key
 * @param {{qtStyle?:boolean, noFlags?:boolean}} [opts]
 */
function buildMov(liveId, opts) {
  opts = opts || {};
  const keys = [];
  const values = [];
  if (liveId) {
    keys.push(LIVE_ID, STILL_TIME);
    values.push(liveId, '0');
  } else {
    keys.push('com.apple.quicktime.model');
    values.push('iPhone 12 Pro');
  }
  const keysAtom = atomAt(
    'keys',
    Buffer.concat([ZERO4, u32(keys.length)].concat(keys.map(mdtaEntry))),
  );
  const ilstAtom = atomAt(
    'ilst',
    Buffer.concat(values.map((v, i) => atomAt(u32(i + 1), dataAtom(v)))),
  );
  const metaBody = Buffer.concat([
    opts.noFlags ? Buffer.alloc(0) : ZERO4,
    atomAt('hdlr', Buffer.alloc(20)),
    keysAtom,
    ilstAtom,
  ]);
  const meta = atomAt('meta', metaBody);
  const moovBody = opts.qtStyle
    ? Buffer.concat([atomAt('mvhd', Buffer.alloc(100)), atomAt('udta', meta)])
    : Buffer.concat([atomAt('mvhd', Buffer.alloc(100)), meta]);
  return Buffer.concat([
    atomAt('ftyp', Buffer.from('qt  \u0000\u0000\u0000\u0000qt  ', 'latin1')),
    atomAt('moov', moovBody),
  ]);
}

// ---- 主流程 ----

const TMP = path.join(os.tmpdir(), 'aurora-live-photo-regression-' + process.pid);
let db = null;

function cleanup() {
  try {
    if (db) db.close();
  } catch (e0) {
    void e0;
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e1) {
    void e1;
  }
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ================= 1. MOV 解析器本身 =================
  {
    const cases = [
      ['ISO 风格 moov/meta', {}, LIVE_ID, true],
      ['QuickTime 风格 moov/udta/meta', { qtStyle: true }, LIVE_ID, true],
      ['meta 不带 version+flags', { noFlags: true }, LIVE_ID, true],
      ['反例：没有 identifier 的普通 MOV', {}, null, false],
      ['反例：没有 identifier（udta 布局）', { qtStyle: true }, null, false],
    ];
    for (const [label, opts, id, expect] of cases) {
      const p = path.join(TMP, 'probe-' + pass + '-' + fails.length + '.mov');
      fs.writeFileSync(p, buildMov(id, opts));
      const r = await livePhoto.inspectLiveMotion(p, fs.statSync(p).size);
      check('判据：' + label, r.isLivePhoto === expect);
    }

    // 取值：UUID 必须精确取出来（证明 keys/ilst 解析对，而不是「字符串撞上了」）
    const pv = path.join(TMP, 'value.mov');
    fs.writeFileSync(pv, buildMov('1234ABCD-0000-1111-2222-333344445555'));
    const rv = await livePhoto.inspectLiveMotion(pv, fs.statSync(pv).size);
    check('取值：identifier 的 UUID 被精确取出', rv.liveId === '1234ABCD-0000-1111-2222-333344445555');
    check('取值：still-image-time 标记被识别', rv.hasStillTime === true);

    // 截断文件不能抛异常，也不能误判
    const pt = path.join(TMP, 'trunc.mov');
    const full = buildMov(LIVE_ID.length ? 'ABCD-1' : null);
    fs.writeFileSync(pt, full.subarray(0, Math.floor(full.length / 2)));
    const rt = await livePhoto.inspectLiveMotion(pt, fs.statSync(pt).size);
    check('截断文件不抛异常且判否', rt.isLivePhoto === false);

    // 不存在的文件
    const rn = await livePhoto.inspectLiveMotion(path.join(TMP, 'nope.mov'), 1000);
    check('文件不存在时判否且不抛', rn.isLivePhoto === false);

    check('扩展名判据只认 .mov', livePhoto.couldBeLiveMotion('a.MOV') === true);
    check('扩展名判据排除 .mp4（真库 5920 个假配对里绝大多数是 mp4）', livePhoto.couldBeLiveMotion('a.mp4') === false);
  }

  // ================= 2. stem 规则 =================
  {
    const cases = [
      ['IMG_1234.HEIC', 'img_1234'],
      ['abc.1.jpg', 'abc.1'],
      ['no_dot_at_all', 'no_dot_at_all'],
      ['UPPER.MOV', 'upper'],
      ['中文 名.jpg', '中文 名'],
      ['a.b.c.jpeg', 'a.b.c'],
    ];
    for (const [name, expect] of cases) {
      check('stem：' + name + ' → ' + expect, livePhoto.stemOf('K:/x/' + name) === expect);
    }
  }

  // ================= 3. 建库 + 迁移 =================
  db = new PhotoDatabase(path.join(TMP, 'test.db'));
  db.init();

  check('迁移：live_still_id 列已建', db.hasPhotosColumn('live_still_id'));
  check('迁移：live_motion_id 列已建', db.hasPhotosColumn('live_motion_id'));
  {
    const cols = db.db.prepare('PRAGMA table_info(photos)').all();
    const still = cols.find((c) => c.name === 'live_still_id');
    const motion = cols.find((c) => c.name === 'live_motion_id');
    // 🔴 承重：带 DEFAULT 0 会让存量行一次性变成「查过、不是伴生」。
    check('🔴 迁移：live_still_id 必须无 DEFAULT（NULL 是「还没查过」）', still && still.dflt_value === null);
    check('迁移：live_motion_id 默认 0', motion && String(motion.dflt_value) === '0');
  }

  // 🔴 JS 的 `stemOf()` 与 SQL 里那条 substr 表达式必须**逐字等价**：一边用
  //    `lastIndexOf('.')` 算、另一边用 `length(file_name) - length(file_type) - 1` 算，
  //    在「文件名里含多个点」（`abc.1.jpg`）时就会分叉 —— 症状是「桌面端能配上、
  //    网页端配不上」这种两端不一致，极难从用户描述里定位。
  {
    const sqlStem = db.db.prepare(
      "SELECT lower(substr(?, 1, length(?) - length(replace(?, '.', '')) - 1)) AS s",
    );
    for (const pairOf of [
      ['IMG_1234.HEIC', 'heic'],
      ['abc.1.jpg', 'jpg'],
      ['a.b.c.jpeg', 'jpeg'],
      ['中文 名.jpg', 'jpg'],
    ]) {
      const got = sqlStem.get(pairOf[0], pairOf[0], pairOf[1]).s;
      check('stem 与 SQL 逐字等价：' + pairOf[0], got === livePhoto.stemOf('/x/' + pairOf[0]));
    }
  }

  // ================= 4. 配对 =================
  const folder = TMP;
  const write = (name, buf) => fs.writeFileSync(path.join(folder, name), buf);
  // ① 真 Live Photo
  write('IMG_0001.MOV', buildMov('AAAA1111-2222-3333-4444-555566667777'));
  write('IMG_0001.HEIC', Buffer.alloc(1200, 1));
  // ② 普通视频，无同名图片
  write('OTHER_0002.MOV', buildMov(null));
  // ③ 🔴 核心反例：**同名图片存在**但视频没有 identifier（写真集「封面图 + 正片」形态）
  write('FAKE_0003.MOV', buildMov(null));
  write('FAKE_0003.JPG', Buffer.alloc(2200, 2));
  // ④ 有 identifier 但没有同名图片
  write('LONE_0004.MOV', buildMov('BBBB1111-2222-3333-4444-555566667777'));
  // ⑤ 另一个真 Live Photo，用 QuickTime 风格布局（覆盖 udta 分支）
  write('IMG_0005.MOV', buildMov('CCCC1111-2222-3333-4444-555566667777', { qtStyle: true }));
  write('IMG_0005.JPG', Buffer.alloc(3300, 3));

  db.db.prepare("INSERT INTO root_folders (id, path, name) VALUES (1, ?, 't')").run(folder);
  const ins = db.db.prepare(
    `INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type)
     VALUES (1, ?, ?, ?, ?, ?)`,
  );
  const samples = [
    ['IMG_0001.HEIC', 'heic'],
    ['IMG_0001.MOV', 'mov'],
    ['OTHER_0002.MOV', 'mov'],
    ['FAKE_0003.JPG', 'jpg'],
    ['FAKE_0003.MOV', 'mov'],
    ['LONE_0004.MOV', 'mov'],
    ['IMG_0005.JPG', 'jpg'],
    ['IMG_0005.MOV', 'mov'],
  ];
  for (const [name, type] of samples) {
    const fp = path.join(folder, name);
    ins.run(folder, name, fp, fs.statSync(fp).size, type);
  }

  const stats = await pair.runLivePhotoPairing({ db: db.db });
  check('配对：取到 8 个候选里的全部 mov（5 个）', stats.scanned === 5);
  check('配对：只对「有同名图片」的读了盘（3 个）', stats.probed === 3);
  check('配对：识别出 2 对 Live Photo', stats.matched === 2);

  const byName = (n) =>
    db.db.prepare('SELECT id, live_still_id, live_motion_id FROM photos WHERE file_name = ?').get(n);

  check('配对：真 Live Photo 的 MOV 指向照片', byName('IMG_0001.MOV').live_still_id === byName('IMG_0001.HEIC').id);
  check('配对：照片反向指向 MOV', byName('IMG_0001.HEIC').live_motion_id === byName('IMG_0001.MOV').id);
  check('配对：QuickTime 风格布局（udta/meta）也能配上', byName('IMG_0005.MOV').live_still_id === byName('IMG_0005.JPG').id);
  check('🔴 配对：假配对（同名但无 identifier）必须落 0', byName('FAKE_0003.MOV').live_still_id === 0);
  check('🔴 配对：假配对的同名图片 live_motion_id 仍为 0', byName('FAKE_0003.JPG').live_motion_id === 0);
  check('配对：无同名图片的 MOV 落 0', byName('OTHER_0002.MOV').live_still_id === 0);
  check('配对：有 identifier 但无同名图片的 MOV 落 0', byName('LONE_0004.MOV').live_still_id === 0);
  check('收敛：所有候选都落了终态（没有 NULL 残留）', pair.countPendingPairing(db.db) === 0);

  const st2 = await pair.runLivePhotoPairing({ db: db.db });
  check('收敛：第二轮 0 候选（不会每轮重读盘）', st2.scanned === 0);

  // ================= 5. 三档列表过滤 =================
  const listOf = (mediaType) => db.getPhotos({ mediaType: mediaType, pageSize: 100 });
  const namesOf = (r) => r.photos.map((p) => p.file_name).sort().join(',');
  const imgList = listOf('image');
  const vidList = listOf('video');
  const allList = listOf('all');
  const allNames = namesOf(allList);
  const vidNames = namesOf(vidList);

  check('过滤：image 档 = 3 张图', imgList.photos.length === 3);
  check('过滤：video 档排除 2 个伴生视频 ⇒ 3 个', vidList.photos.length === 3);
  check('过滤：video 档不含 IMG_0001.MOV', vidNames.indexOf('IMG_0001.MOV') < 0);
  check('过滤：video 档不含 IMG_0005.MOV', vidNames.indexOf('IMG_0005.MOV') < 0);

  // 🔴 `all` 档排伴生视频**必须自适应**（2026-10-06 治本），两态都要钉住。
  //    为什么不能只钉一态：`all` 是唯一没有任何别的限定条件的档，把
  //    `COALESCE(live_still_id, 0) = 0` 直接压上去会让计划从「覆盖索引扫描」
  //    退化成「逐行回表」——真库实测 478 ms → **105,954 ms**，只排掉 1 行。
  //    ⇒ 改成 `id NOT IN (SELECT id FROM photos WHERE live_still_id > 0)`，
  //    由部分索引 `idx_photos_live_companion`（真库 1 个条目）兜住子查询；
  //    **索引没就绪时一律不加**（宁可多显示那 1 行）。
  const gateBefore = heavy.liveCompanionExcludeCondition(db.db);
  check('🔴 过滤：索引未就绪 ⇒ 闸门必须返回 null（不加任何条件）', gateBefore === null);
  check('🔴 过滤：索引未就绪 ⇒ all 档刻意不排伴生视频 ⇒ 8', allList.photos.length === 8);
  check('过滤：索引未就绪时 all 档确实含伴生 MOV（这是刻意的）', allNames.indexOf('IMG_0001.MOV') >= 0);
  // 🔴 这条守的是 SQL 三值逻辑的坑：`NOT (live_still_id > 0)` 会把
  //    live_still_id 为 NULL 的行（= 全部图片 + 全部未探查的视频）一并排除，
  //    「所有媒体」档只剩「查过、不是伴生」的那几个视频。
  check('🔴 过滤：all 档必须仍含图片（不能被 NULL 三值逻辑吃掉）', allNames.indexOf('IMG_0001.HEIC') >= 0);
  check('🔴 过滤：all 档含普通图片', allNames.indexOf('FAKE_0003.JPG') >= 0);
  check('过滤：all 档 total 与列表同一口径', allList.total === 8);
  check('过滤：video 档 total 与列表同一口径', vidList.total === 3);

  // 建上那条部分索引 ⇒ 闸门打开 ⇒ `all` 档必须切到「排掉」。
  db.db.exec(
    'CREATE INDEX IF NOT EXISTS ' +
      heavy.LIVE_COMPANION_INDEX +
      ' ON photos(id) WHERE ' +
      heavy.LIVE_COMPANION_PRED,
  );
  heavy.clearIndexCache(db.db);
  const gateAfter = heavy.liveCompanionExcludeCondition(db.db);
  check('🔴 过滤：索引就绪 ⇒ 闸门放行', gateAfter !== null);
  const allAfter = listOf('all');
  const afterNames = namesOf(allAfter);
  check('🔴 过滤：索引就绪后 all 档排除 2 个伴生视频 ⇒ 6', allAfter.photos.length === 6);
  check('过滤：索引就绪后 all 档不含 IMG_0001.MOV', afterNames.indexOf('IMG_0001.MOV') < 0);
  check('过滤：索引就绪后 all 档不含 IMG_0005.MOV', afterNames.indexOf('IMG_0005.MOV') < 0);
  check('🔴 过滤：索引就绪后 all 档必须仍含图片', afterNames.indexOf('IMG_0001.HEIC') >= 0);
  check('过滤：索引就绪后 all 档 total 与列表同一口径', allAfter.total === 6);
  // 治本写法与旧写法必须给出**同一个数** —— 换的是计划形状，不是语义。
  // 这条独立于上面那条长度断言：长度相同只说明这个夹具上没差别，
  // 而这里钉的是「两条 SQL 的集合逐行相同」，将来改谓词时它会先红。
  const legacyCount = db.db
    .prepare('SELECT COUNT(*) AS n FROM photos WHERE COALESCE(live_still_id, 0) = 0')
    .get().n;
  const newCount = db.db
    .prepare('SELECT COUNT(*) AS n FROM photos WHERE ' + gateAfter)
    .get().n;
  check(
    '🔴 过滤：治本写法与 COALESCE 写法结果逐个相同（' + legacyCount + ' vs ' + newCount + '）',
    Number(legacyCount) === Number(newCount),
  );
  // 索引就绪后 video 档不许被带偏
  check('过滤：索引就绪后 video 档不变（仍 3 个）', listOf('video').photos.length === 3);
  check('过滤：索引就绪后 image 档不变（仍 3 张）', listOf('image').photos.length === 3);

  // 🔴 必须把这条索引 **DROP 掉**再往下走：下一节的「存量库迁移路径」要
  //    `ALTER TABLE photos DROP COLUMN live_still_id`，而 SQLite 拒绝删除**被索引引用**
  //    的列（报 `error in index idx_photos_live_companion after drop column: no such column`）。
  //    ⚠️ 这条限制在**生产代码**里也成立：将来若真要删 `live_still_id`，
  //       必须先 `DROP INDEX idx_photos_live_companion`（它在 `PHASE5_INDEXES` 里，
  //       下次启动会被重新建回来 —— 所以删列这件事本身得连 DDL 一起改）。
  db.db.exec('DROP INDEX IF EXISTS ' + heavy.LIVE_COMPANION_INDEX);
  heavy.clearIndexCache(db.db);
  check('过滤：收尾 DROP 掉索引 ⇒ 闸门重新关闭', heavy.liveCompanionExcludeCondition(db.db) === null);

  // ================= 6. 字段传播 =================
  check('传播：列表行带 live_motion_id', allList.photos.every((p) => 'live_motion_id' in p));
  check(
    '传播：Live Photo 照片的 live_motion_id > 0',
    Number(allList.photos.find((p) => p.file_name === 'IMG_0001.HEIC').live_motion_id) > 0,
  );
  check(
    '传播：普通照片的 live_motion_id = 0',
    Number(allList.photos.find((p) => p.file_name === 'FAKE_0003.JPG').live_motion_id) === 0,
  );
  check(
    '传播：视频行也带 live_motion_id（默认 0）',
    vidList.photos.every((p) => Number(p.live_motion_id) === 0),
  );

  // ================= 7. 存量库迁移路径（ALTER TABLE） =================
  {
    db.db.exec('ALTER TABLE photos DROP COLUMN live_still_id');
    db.db.exec('ALTER TABLE photos DROP COLUMN live_motion_id');
    check('存量库：模拟把两列删掉', !db.hasPhotosColumn('live_still_id'));
    db.init();
    const cols2 = db.db.prepare('PRAGMA table_info(photos)').all();
    const still2 = cols2.find((c) => c.name === 'live_still_id');
    check('存量库：ALTER 路径加回了列', !!still2);
    check('🔴 存量库：ALTER 加回的 live_still_id 同样无 DEFAULT', still2 && still2.dflt_value === null);
    // 🔴 用户真实面对的就是这条路径：库里已有几万个视频行，列是后加的。
    //    DEFAULT 0 会让它们全部变成「查过、不是伴生」⇒ 永远配不出 Live Photo。
    const st3 = await pair.runLivePhotoPairing({ db: db.db });
    check('🔴 存量库：迁移后仍能认领老行', st3.scanned === 5);
    check('🔴 存量库：迁移后仍能配出 Live Photo', st3.matched === 2);
  }

  // ================= 8. 判据不可退化（结构断言） =================
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'live-photo-pair.js'), 'utf8');
    check('判据：定案条件必须引用 identifier 结果 isLivePhoto', /info\s*&&\s*info\.isLivePhoto/.test(src));
    check('判据：候选查询走 file_type 精确匹配（能用 idx_photos_type）', /file_type IN \(\$\{MOTION_TYPE_IN\}\)/.test(src));
    check(
      '🔴 判据：不许把 still-image-time / UUID 值升级成**必需**条件 —— ' +
        'readMdtaValue 只认 keys/ilst 一种布局，另外两种布局的真 Live Photo 会全漏',
      /^\s*isLivePhoto:\s*hasId,\s*$/m.test(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'live-photo.js'), 'utf8'),
      ),
    );
    const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf8');
    check(
      '🔴 取反判据必须用 COALESCE（禁 NOT (live_still_id > 0)）',
      dbSrc.indexOf("COALESCE(live_still_id, 0) = 0") >= 0 &&
        dbSrc.indexOf("'NOT (' + this._sqlLiveStillIsMotionExpr()") < 0,
    );

    // ---- UI 角标：两端都要画，且样式必须真的定义了 ----
    // ⚠️ 只断言「源码里有这个类名」是弱断言，但两条一起钉能抓住最常见的漏法：
    //    只加了 HTML 没加 CSS（角标变成无背景的裸文字）或只加了一端（桌面端有、网页端没有）。
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const gridSrc = readSrc('src/renderer/ui-grid.js');
    const webSrc = readSrc('src/web/js/app.js');
    check('UI：桌面端卡片画 Live 角标', gridSrc.indexOf('media-type-badge-live') >= 0);
    // 判据的真源已收敛到 `utils.js`（网格角标与预览播放按钮共用一个事实），
    // 所以「读 live_motion_id」这条落在那份唯一实现上，两处的转发另见第 9 节。
    check(
      'UI：判据真源（utils.js）读 live_motion_id',
      /isLivePhotoStill[\s\S]{0,400}live_motion_id/.test(readSrc('src/renderer/utils.js')),
    );
    check(
      'UI：桌面端角标转发到判据真源',
      /isLivePhotoStill\(photo\)\s*\{\s*return global\.RendererUtils\.isLivePhotoStill/.test(gridSrc),
    );
    check('UI：网页端卡片画 Live 角标', webSrc.indexOf('media-type-badge-live') >= 0);
    check('UI：桌面端角标样式已定义', readSrc('src/renderer/styles.css').indexOf('.media-type-badge-live') >= 0);
    check('UI：网页端角标样式已定义', readSrc('src/web/index.html').indexOf('.media-type-badge-live') >= 0);

    // ---- 网页端：预览内播放（与桌面端同构，两端都必须有入口） ----
    // ⚠️ 网页端 app.js 是经典脚本（`state` 就是全局），直接跑它要拖一整套 DOM ——
    //    所以这一组是**静态契约**；真正的行为验证在桌面端（见第 9 节，那边驱动真代码）。
    const webHtml = readSrc('src/web/index.html');
    check(
      '网页端：Live 判据只有一份（角标与播放按钮共用）',
      /function isWebLivePhotoStill\(photo\)[\s\S]{0,80}Number\(photo\.live_motion_id\) > 0/.test(webSrc),
    );
    check(
      '🔴 网页端：角标必须转发到 isWebLivePhotoStill（不许再内联一份）',
      webSrc.indexOf('if (isWebLivePhotoStill(photo)) {') >= 0,
    );
    check(
      '🔴 网页端：裸判据全文件只许出现一次（就在 isWebLivePhotoStill 里）',
      (webSrc.match(/Number\(photo\.live_motion_id\)\s*>\s*0/g) || []).length === 1,
    );
    check(
      '🔴 网页端：切图同步点必须落在图片/视频分支**之前**',
      (() => {
        // ⚠️ 锚点必须带上缩进：`syncWebLivePreview(photo, isVideo)` 这个子串在
        //    **函数定义**那一行也出现，只按裸子串找的话「删掉调用点」不会变红
        //    （反向验证时正是这里露的洞）。
        const iSync = webSrc.indexOf('\n  syncWebLivePreview(photo, isVideo);');
        const iBranch = webSrc.indexOf('function showImageInPreview()');
        return iSync > 0 && iBranch > 0 && iSync < iBranch;
      })(),
    );
    check(
      '网页端：关闭预览要收掉叠加层',
      (() => {
        const iClose = webSrc.indexOf('function closePreview(');
        const iStop = webSrc.indexOf('stopWebLivePlayback();', iClose);
        return iClose > 0 && iStop > iClose;
      })(),
    );
    check(
      '🔴 网页端：取流带的是伴生视频 id（motionId），不是照片 id',
      webSrc.indexOf("'/api/video-playback?id=' + motionId") >= 0,
    );
    check(
      '网页端：DOM 两个节点都在',
      /id="previewLiveVideo"/.test(webHtml) && /id="previewLiveBtn"/.test(webHtml),
    );
    check(
      '🔴 网页端：叠加层绝对定位 + 不吃指针事件',
      /\.preview-live-video\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/.test(webHtml),
    );
    check(
      '🔴 网页端：#previewLiveBtn 不许被 CSS 写成 display:none —— JS 显示时用的是 ' +
        'style.display=""（清内联值后回落到 CSS），写了就永远出不来',
      !/#previewLiveBtn\s*\{[^}]*display:\s*none/.test(webHtml),
    );
    check(
      '🔴 网页端：激活色必须用 id 选择器（.preview-action-btn.active 是收藏的粉色、特异性相同，靠顺序压不住）',
      /#previewLiveBtn\.active\s*\{/.test(webHtml),
    );
  }

  // ================= 9. 预览内播放伴生视频 =================
  // 这一节**驱动真代码**（vm 里跑 utils.js + ui-preview.js，喂假 DOM），
  // 而不是只断言源码里有几个字符串 —— 后者抓不住「切图没停上一段」这类顺序 bug。
  {
    const vm = require('node:vm');
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

    function makeVideo() {
      const listeners = Object.create(null);
      return {
        src: '',
        paused: true,
        onended: null,
        style: { display: 'none', transform: '' },
        _liveTryPlay: null,
        _hlsAttached: null,
        addEventListener(t, fn) {
          (listeners[t] = listeners[t] || []).push(fn);
        },
        removeEventListener(t, fn) {
          const arr = listeners[t] || [];
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        },
        fire(t) {
          if (t === 'ended' && typeof this.onended === 'function') this.onended();
          (listeners[t] || []).slice().forEach((fn) => fn());
        },
        listenerCount(t) {
          return (listeners[t] || []).length;
        },
        play() {
          this.paused = false;
          return Promise.resolve();
        },
        pause() {
          this.paused = true;
        },
        load() {},
        removeAttribute(name) {
          if (name === 'src') this.src = '';
        },
      };
    }

    function makeButton() {
      const label = { textContent: '' };
      const classes = new Set();
      return {
        style: { display: 'none' },
        classList: {
          toggle(c, on) {
            if (on) classes.add(c);
            else classes.delete(c);
          },
          contains(c) {
            return classes.has(c);
          },
        },
        querySelector() {
          return label;
        },
        _label: label,
      };
    }

    const tick = () => new Promise((r) => setTimeout(r, 0));
    const video = makeVideo();
    const btn = makeButton();
    let playbackAnswer = { mode: 'direct' };
    const sandbox = {
      console,
      setTimeout,
      fetch: () => Promise.resolve({ json: () => Promise.resolve(playbackAnswer) }),
    };
    sandbox.window = sandbox;
    sandbox.PhotoHlsAttach = {
      attach(v, url) {
        v._hlsAttached = url;
      },
      destroy(v) {
        v._hlsAttached = null;
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(readSrc('src/renderer/utils.js'), sandbox, { filename: 'utils.js' });
    vm.runInContext(readSrc('src/renderer/ui-preview.js'), sandbox, { filename: 'ui-preview.js' });
    const live = sandbox.RendererPreviewLive;
    const utils = sandbox.RendererUtils;

    const dom = {
      previewLiveVideo: video,
      previewLiveBtn: btn,
      previewImage: { style: { transform: 'scale(2)' } },
      previewOverlay: { classList: { contains: (c) => c === 'active' } },
    };
    const state = { previewIndex: 0, previewPhotos: [] };
    const api = {
      has: (n) => n === 'getWebLocalBaseUrl',
      call: () => Promise.resolve('http://127.0.0.1:9/'),
    };

    check('预览：单一判据已在 utils.js 落地', typeof utils.isLivePhotoStill === 'function');
    check('预览：utils 判据认得 live_motion_id', utils.isLivePhotoStill({ live_motion_id: 5 }));
    check(
      '预览：utils 判据排除 0 / null / 缺字段',
      !utils.isLivePhotoStill({ live_motion_id: 0 }) &&
        !utils.isLivePhotoStill({ live_motion_id: null }) &&
        !utils.isLivePhotoStill({}),
    );

    // ---- 显隐 ----
    state.previewPhotos = [{ id: 1, file_name: 'A.HEIC', live_motion_id: 0 }];
    live.syncPreviewLiveUi({ state, dom });
    check('预览：普通照片不显示实况按钮', btn.style.display === 'none');
    live.toggleLivePlayback({ state, dom, api });
    await tick();
    check(
      '预览：普通照片按不出播放（不能凭文件名猜伴生）',
      video.src === '' && !state.previewLivePlaying,
    );

    state.previewPhotos = [{ id: 2, file_name: 'B.HEIC', live_motion_id: 77 }];
    live.syncPreviewLiveUi({ state, dom });
    check('预览：Live Photo 显示实况按钮', btn.style.display === '');
    live.syncPreviewLiveUi({ state, dom, isVideo: true });
    check('预览：视频本身不给实况按钮（它走主播放器）', btn.style.display === 'none');
    live.syncPreviewLiveUi({ state, dom });
    check('预览：回到图片又显示', btn.style.display === '');

    // ---- 播放：必须用伴生视频的 id，不是照片的 id ----
    live.toggleLivePlayback({ state, dom, api });
    check('预览：按下后立刻进入播放态', state.previewLivePlaying === true);
    check('预览：叠加层放出来', video.style.display === '');
    check('预览：跟随当前缩放/旋转', video.style.transform === 'scale(2)');
    check('预览：按钮进入激活态', btn.classList.contains('active') === true);
    check('预览：按钮文案切到「停止」', btn._label.textContent === '停止');
    await tick();
    check(
      '🔴 播放：取的是伴生视频 id 77，不是照片 id 2',
      video.src === 'http://127.0.0.1:9/video/77?v=77',
    );
    check('播放：已开始播', video.paused === false);

    live.toggleLivePlayback({ state, dom, api });
    check('预览：再按一次即停', state.previewLivePlaying === false && video.src === '');
    check('预览：停下后叠加层收掉', video.style.display === 'none');
    check('预览：停下后按钮退出激活态', btn.classList.contains('active') === false);
    check(
      '🔴 播放：canplay 兜底监听必须摘掉（留着会被下一条动态的旧 play 抢）',
      video.listenerCount('canplay') === 0 && video._liveTryPlay === null,
    );

    // ---- HEVC 档：iPhone 的伴生视频常是 HEVC，必须落到 HLS 而不是直链 ----
    playbackAnswer = { mode: 'hls', ready: true, playlistUrl: '/hls/abc/playlist.m3u8' };
    live.toggleLivePlayback({ state, dom, api });
    await tick();
    check(
      '🔴 播放：HEVC 伴生视频走 HLS 转码档（直链会静默黑屏）',
      video._hlsAttached === 'http://127.0.0.1:9/hls/abc/playlist.m3u8',
    );
    live.toggleLivePlayback({ state, dom, api });
    check('播放：停止时解除 HLS 会话', video._hlsAttached === null);
    playbackAnswer = { mode: 'direct' };

    // ---- 🔴 切图必须无条件先停：上一张 Live → 下一张也 Live ----
    state.previewPhotos = [
      { id: 2, file_name: 'B.HEIC', live_motion_id: 77 },
      { id: 3, file_name: 'C.HEIC', live_motion_id: 88 },
    ];
    state.previewIndex = 0;
    live.syncPreviewLiveUi({ state, dom });
    live.toggleLivePlayback({ state, dom, api });
    await tick();
    check('预览：第一张已在播', state.previewLivePlaying === true && /\/video\/77/.test(video.src));
    state.previewIndex = 1;
    live.syncPreviewLiveUi({ state, dom });
    check('🔴 预览：切到另一张 Live Photo 也必须先停掉上一段', state.previewLivePlaying === false);
    check(
      '🔴 预览：切图后叠加层必须收掉（否则上一段会盖在新静止图上播完）',
      video.style.display === 'none' && video.src === '',
    );
    check('预览：新照片也是 Live ⇒ 按钮留着', btn.style.display === '');

    // ---- 异步链路迟到：用户已经翻页，不许再往叠加层灌 src ----
    state.previewPhotos = [{ id: 2, file_name: 'B.HEIC', live_motion_id: 77 }];
    state.previewIndex = 0;
    live.syncPreviewLiveUi({ state, dom });
    live.toggleLivePlayback({ state, dom, api });
    state.previewPhotos = [{ id: 9, file_name: 'D.JPG', live_motion_id: 0 }];
    state.previewIndex = 0;
    await tick();
    check('🔴 预览：翻页后迟到的异步结果不许再灌 src', video.src === '');

    // ---- 播完自动收回 ----
    state.previewPhotos = [{ id: 4, file_name: 'E.HEIC', live_motion_id: 99 }];
    state.previewIndex = 0;
    live.syncPreviewLiveUi({ state, dom });
    live.toggleLivePlayback({ state, dom, api });
    await tick();
    video.fire('ended');
    check('预览：播完自动收回', state.previewLivePlaying === false && video.style.display === 'none');
    check('预览：播完后按钮回到「实况」', btn._label.textContent === '实况');

    // ---- 关掉预览：必须收干净（否则叠加层在后台继续播） ----
    live.toggleLivePlayback({ state, dom, api });
    live.stopLivePlayback({ state, dom });
    check('预览：关闭预览时收掉叠加层', state.previewLivePlaying === false && video.src === '');

    // ---- 静态契约 ----
    const gridSrc2 = readSrc('src/renderer/ui-grid.js');
    const previewSrc = readSrc('src/renderer/ui-preview.js');
    const flowSrc = readSrc('src/renderer/preview-flow.js');
    const appSrc2 = readSrc('src/renderer/app.js');
    check(
      '🔴 单一判据：ui-grid 转发到 RendererUtils',
      /isLivePhotoStill\(photo\)\s*\{\s*return global\.RendererUtils\.isLivePhotoStill/.test(gridSrc2),
    );
    check(
      '🔴 单一判据：ui-preview 转发到 RendererUtils',
      /isLivePhotoStill\(photo\)\s*\{\s*return global\.RendererUtils\.isLivePhotoStill/.test(previewSrc),
    );
    check(
      '🔴 单一判据：两端都不许再出现裸的 live_motion_id > 0（两份判据会漂移）',
      !/Number\([\s\S]{0,40}live_motion_id\)\s*>\s*0/.test(gridSrc2) &&
        !/Number\([\s\S]{0,40}live_motion_id\)\s*>\s*0/.test(previewSrc),
    );
    check(
      '🔴 预览：同步点必须落在图片/视频分支**之前**（写进任一条分支只覆盖一半路径）',
      (() => {
        // 锚点带上调用点的前缀 `) `，否则会匹配到 options 解构那一侧的同名子串。
        const iSync = flowSrc.indexOf(') onSyncPreviewLiveButton(photo, isVideo);');
        const iBranch = flowSrc.indexOf('var overlay = dom.previewOverlay;');
        return iSync > 0 && iBranch > 0 && iSync < iBranch;
      })(),
    );
    check(
      '预览：关闭预览要收掉叠加层（转发到模块的唯一实现）',
      /previewLiveUi\.stopLivePlayback\(\{\s*state: state,\s*dom: dom/.test(appSrc2),
    );
    check('预览：按钮已接线', /bindClick\('previewLiveBtn'/.test(readSrc('src/renderer/ui-events.js')));
    check(
      '预览：DOM 两个节点都在',
      /id="previewLiveVideo"/.test(readSrc('src/renderer/index.html')) &&
        /id="previewLiveBtn"/.test(readSrc('src/renderer/index.html')),
    );
    const cssSrc = readSrc('src/renderer/styles.css');
    check(
      '🔴 预览：叠加层必须绝对定位（内层是 flex row，参与流会把图挤成半宽）',
      /\.preview-live-video\s*\{[^}]*position:\s*absolute/.test(cssSrc),
    );
    check(
      '预览：叠加层不许吃掉指针事件（底下那张图还要能拖拽/缩放）',
      /\.preview-live-video\s*\{[^}]*pointer-events:\s*none/.test(cssSrc),
    );
  }

  cleanup();
  const total = pass + fails.length;
  console.log(
    '[live-photo-regression] ' + (fails.length ? 'FAIL' : 'PASS') + ' ' + pass + '/' + total,
  );
  for (const f of fails) console.log('  FAIL: ' + f);
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => {
  cleanup();
  console.error('[live-photo-regression] 崩了:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
