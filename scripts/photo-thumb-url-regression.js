#!/usr/bin/env node
'use strict';

/**
 * 浏览层「混规格缩略图」契约回归（2026-10-07）。
 *
 * ## 这条契约是什么
 *
 * 缩略图不再是「一种规格」：存量行是 256/jpeg，重建跑的过程中库里**同时**存在
 * 256/jpeg、512/webp、以及各种中间态。浏览层必须能同时正确显示它们，且**重建过的行
 * 要立刻显示新图**。
 *
 * 两件事各自都能单独把这条弄坏，而且都是静默的：
 *
 * ① **列表行不带规格**（`thumb_size` / `thumb_format`）。
 *    服务端那侧早就认识这两列（响应头按行派生），但**列表查询**一直没取 —— 于是客户端
 *    拿不到「这一行是什么规格」。症状取决于谁在用：缓存键退回只用原图字段（见 ②），
 *    或干脆没有键。
 *
 * ② **缓存键不随规格变化**。缩略图重建**不动原图**：`file_size` / `date_modified` 一个字节
 *    都没变，所以沿用它拼出的 URL 在重建前后**完全相同**。而
 *    · 网页端 `/thumb/:id` 是 `Cache-Control: public, max-age=86400`；
 *    · 桌面端 `thumb://<id>` 进 Chromium 的内存缓存。
 *    两条路都不会去问服务端「变了没」⇒ 重建跑完了、界面还在显示旧档位的图，
 *    而且**看起来完全正常**（图是好的，只是旧的）。
 *
 * ## 为什么封面单独有一条约定
 *
 * 三条封面查询的主体是 `ROW_NUMBER() OVER (PARTITION BY folder_path)` —— 它会把整棵子树的
 * 行物化一遍（真库单根 90 万行 / 数分钟）。把基线列清单整个塞进去 = 把物化宽度撑大约 8%，
 * 白等十几秒；而封面只有**每目录一行**。所以封面走 `thumbSpecColumnsPrefixed()`：
 * 最终 SELECT 上按主键回查一次（几千次 PK 探针）。第 3 组把这条钉住，否则「统一成
 * photoListColumns()」这种看起来更干净的改动会悄悄让封面查询变慢。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const acorn = require('acorn');

const PhotoDatabase = require('../src/database');
const photoListColumnsModule = require('../src/main/photo-list-columns');
const heavy = require('../src/db-heavy-read');

const ROOT = path.join(__dirname, '..');

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** 与 `thumbnail-regen-regression.js` 同一套实现（负向断言必须剥注释）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function parse(src, file) {
  try {
    return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (eScript) {
    try {
      return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (eModule) {
      throw new Error('无法解析 ' + file + '：' + eModule.message, { cause: eModule });
    }
  }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walk(node[key], visit);
  }
}

function functionBodyByName(src, name) {
  const ast = parse(src, name);
  let found = null;
  walk(ast, (node) => {
    if (found) return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
      found = src.slice(node.body.start, node.body.end);
    }
  });
  return found;
}

function tempPath(tag) {
  return path.join(os.tmpdir(), `aurora-thumb-url-${tag}-${Date.now()}-${Math.random()}.db`);
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    } catch (e) {}
  }
}

function makePhoto(rootId, fileName, folder, thumbnail, thumbSize, thumbFormatValue) {
  return {
    rootId,
    folderPath: folder,
    fileName,
    filePath: path.join(folder, fileName),
    fileSize: 4096,
    fileType: 'jpg',
    width: 100,
    height: 100,
    dateTaken: '2026-01-01T00:00:00',
    dateModified: '2026-01-01T00:00:00',
    thumbnail,
    hasThumbnail: thumbnail ? 1 : 0,
    thumbSize,
    thumbFormat: thumbFormatValue,
  };
}

const SPEC_A = { size: 256, format: 'jpeg' };
const SPEC_B = { size: 512, format: 'webp' };

/**
 * 每一行都断言「带规格」：缺了就是字段在 SQL 那一层被丢掉。
 *
 * 两层断言缺一不可：
 *   · key 存在 —— 直接对应失效（客户端拼不出键）；
 *   · **值来自这一行** —— 只判 key 会让「`SELECT 0 AS thumb_size`」这类写法也过。
 *     所以要求每行的规格落在夹具那两个已知值里，且当夹具给的是多样本时**必须见到**两种
 *     （退化成常量就只可能见到一种）。
 */
function assertRowsCarrySpec(label, rows, opts) {
  const o = opts || {};
  assert(Array.isArray(rows) && rows.length > 0, label + '：夹具没有产出任何行（下面几条会假绿）');
  for (const row of rows) {
    assert(
      Object.prototype.hasOwnProperty.call(row, 'thumb_size'),
      label + ' 的行缺 thumb_size —— 客户端拼不出会随重建变化的缓存键',
    );
    assert(
      Object.prototype.hasOwnProperty.call(row, 'thumb_format'),
      label + ' 的行缺 thumb_format',
    );
    assert(
      Number(row.thumb_size) === SPEC_A.size || Number(row.thumb_size) === SPEC_B.size,
      label + '：thumb_size=' + JSON.stringify(row.thumb_size) + ' 不是夹具里的任何一档' +
        '（常量 / 错列 / 没接到真实值）',
    );
    assert(
      row.thumb_format === SPEC_A.format || row.thumb_format === SPEC_B.format,
      label + '：thumb_format=' + JSON.stringify(row.thumb_format) + ' 不是夹具里的任何一格',
    );
  }
  if (o.mayBeSingle) return;
  assert(
    rows.some((r) => Number(r.thumb_size) === SPEC_B.size && r.thumb_format === SPEC_B.format),
    label + '：多行样本里一行都没取到 512/webp 的规格 —— 列接上了但没接到真实值',
  );
}

// ------------------------------------------------- 1. 所有会画缩略图的列表都带规格

/**
 * 行为面（主力）：在真库上把每个**会到达浏览层**的取数入口都跑一遍。
 *
 * 为什么不用「正则扫 SQL 里有没有 thumb_size」：那种断言在「把列接进了一条没人走的
 * 分支」「SELECT 写的是常量」时照样绿。这里直接看**返回的行对象**。
 */
function checkEveryListCarriesSpec() {
  const dbPath = tempPath('lists');
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    const rootId = db.addRootFolder('C:\\thumbspec\\root');
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const folderA = 'C:\\thumbspec\\root\\a';
    const folderB = 'C:\\thumbspec\\root\\b';
    db.insertPhoto(makePhoto(rootId, 'a1.jpg', folderA, buf, SPEC_A.size, SPEC_A.format));
    db.insertPhoto(makePhoto(rootId, 'a2.jpg', folderA, buf, SPEC_B.size, SPEC_B.format));
    // ⚠️ 目录 b 里让 **512/webp 那张排在最前**（封面挑选是「图片优先 → file_name ASC」，
    //    见 `_folderCoverPickOrderBySql`）。不这么排的话两个目录的封面都会是 256/jpeg，
    //    而下面「必须见到 512/webp」那条断言就会假红 —— 假红与真回归长得一样，别留给下一个人。
    db.insertPhoto(makePhoto(rootId, 'b0.jpg', folderB, buf, SPEC_B.size, SPEC_B.format));
    db.insertPhoto(makePhoto(rootId, 'b1.jpg', folderB, buf, SPEC_A.size, SPEC_A.format));

    assertRowsCarrySpec('getPhotos', db.getPhotos({ page: 1, pageSize: 10 }).photos);
    assertRowsCarrySpec(
      'getPhotos(lite)',
      db.getPhotos({ page: 1, pageSize: 10, lite: true }).photos,
    );
    assertRowsCarrySpec(
      'getFolderPhotos',
      db.getFolderPhotos(folderA, { page: 1, pageSize: 10 }).photos,
    );
    assertRowsCarrySpec(
      'getFolderPhotos(lite)',
      db.getFolderPhotos(folderA, { page: 1, pageSize: 10, lite: true }).photos,
    );
    assertRowsCarrySpec(
      'getRandomPreviewPhotoBatch',
      db.getRandomPreviewPhotoBatch({ limit: 10 }),
    );
    // 单行探针：随机档挑到哪一行不确定 ⇒ 只断言「带规格且值来自该行」
    assertRowsCarrySpec(
      'getPreviewAdjacentPhoto(random)',
      [db.getPreviewAdjacentPhoto({ currentId: 2, mode: 'random' })],
      { mayBeSingle: true },
    );
    // 顺序档是确定的：date_taken ASC 下 id=1 的下一条就是 id=2（512/webp）
    assertRowsCarrySpec(
      'getPreviewAdjacentPhoto(sequential)',
      [
        db.getPreviewAdjacentPhoto({
          currentId: 1,
          mode: 'sequential',
          sortBy: 'date_taken',
          sortOrder: 'ASC',
        }),
      ],
    );
    // 搜图页「文件」分支（走 LIKE，与 FTS 那条路共用同一份 photoCols）
    assertRowsCarrySpec('searchPhotos(nameOnly)', db.searchPhotos('a', { nameOnly: true }).photos);
    // 搜图页「目录」分支：封面行是手写白名单，最容易漏（见第 2 组）
    const folderHits = db.searchFolders('thumbspec', {}).folders;
    assert(
      folderHits.length > 0,
      'searchFolders 夹具没有产出目录行（封面白名单那几条会假绿）',
    );
    assertRowsCarrySpec('searchFolders(目录封面)', folderHits);
    console.log('[thumb-url] list entry points ok');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    cleanup(dbPath);
  }

  // 两条**窄投影**（重复项 / 相似项那一侧的行直接拼 `thumb://<id>?v=`）
  const dbPath2 = tempPath('narrow');
  let db2 = null;
  try {
    db2 = new PhotoDatabase(dbPath2);
    db2.ensureDhashSchema();
    db2.ensureDuplicateHashSchema();
    const rootId = db2.addRootFolder('C:\\thumbspec\\narrow');
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const folder = 'C:\\thumbspec\\narrow\\f';
    db2.insertPhoto(makePhoto(rootId, 'n1.jpg', folder, buf, SPEC_A.size, SPEC_A.format));
    db2.insertPhoto(makePhoto(rootId, 'n2.jpg', folder, buf, SPEC_B.size, SPEC_B.format));
    db2.db.prepare("UPDATE photos SET file_hash = 'H', dhash = 'DH'").run();

    assertRowsCarrySpec('getPhotosByFileHash', db2.getPhotosByFileHash('H'));
    assertRowsCarrySpec('getPhotosByDhash', db2.getPhotosByDhash('DH'));
    console.log('[thumb-url] narrow projections ok');
  } finally {
    if (db2) {
      try {
        db2.close();
      } catch (e) {}
    }
    cleanup(dbPath2);
  }

  // 三条封面路径（桌面 `getFolderCovers` 两条分支 + 网页子目录封面）
  const dbPath3 = tempPath('covers');
  let db3 = null;
  try {
    db3 = new PhotoDatabase(dbPath3);
    const rootId = db3.addRootFolder('C:\\thumbspec\\covers');
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    db3.insertPhoto(makePhoto(rootId, 'c1.jpg', 'C:\\thumbspec\\covers\\a', buf, SPEC_A.size, SPEC_A.format));
    db3.insertPhoto(makePhoto(rootId, 'c2.jpg', 'C:\\thumbspec\\covers\\a', buf, SPEC_B.size, SPEC_B.format));
    db3.insertPhoto(makePhoto(rootId, 'c3.jpg', 'C:\\thumbspec\\covers\\b', buf, SPEC_B.size, SPEC_B.format));

    assertRowsCarrySpec('runGetFolderCovers(legacy)', heavy.runGetFolderCovers(db3.db, { rootId: rootId }).covers);
    assertRowsCarrySpec(
      'runGetFolderCovers(paged)',
      heavy.runGetFolderCovers(db3.db, { rootId: rootId, page: 1, pageSize: 10 }).covers,
    );
    assertRowsCarrySpec(
      'runGetImmediateSubfolderCovers',
      heavy.runGetImmediateSubfolderCovers(db3.db, { parentPath: 'C:\\thumbspec\\covers' }),
    );
    console.log('[thumb-url] cover paths ok');
  } finally {
    if (db3) {
      try {
        db3.close();
      } catch (e) {}
    }
    cleanup(dbPath3);
  }
}

// ------------------------------------------------- 2. 封面行的白名单与列清单一致

/**
 * 🔴 封面行是**手写的白名单对象**（`folderCoverRow`）：SQL 里取了、白名单里没写，
 *    界面照样拿不到，而且不报错。所以断言两份列表逐位一致。
 */
function checkCoverWhitelistParity() {
  const mod = photoListColumnsModule;
  const sqlFields = mod.FOLDER_COVER_FIELDS;
  const rowKeys = Object.keys(mod.folderCoverRow(null));
  assert(
    sqlFields.length === rowKeys.length && sqlFields.every((f, i) => f === rowKeys[i]),
    'FOLDER_COVER_FIELDS（SQL 投影）与 folderCoverRow（对外白名单）必须逐位一致：SQL=' +
      sqlFields.join(',') +
      ' 白名单=' +
      rowKeys.join(','),
  );
  // `id` / `file_name` / `has_thumbnail` 是封面卡片画图与判「有没有图」的既有契约，不许丢
  for (const required of ['id', 'file_name', 'has_thumbnail']) {
    assert(sqlFields.indexOf(required) >= 0, '封面列清单丢了 ' + required);
  }
  // 基线列清单必须带规格两列，且两列挨在一起（读的人要能看出它们是一个整体）
  const base = mod.PHOTO_LIST_FIELDS;
  assert(base.indexOf('thumb_size') >= 0, '基线列清单缺 thumb_size');
  assert(base.indexOf('thumb_format') >= 0, '基线列清单缺 thumb_format');
  assert(
    base.indexOf('thumb_format') === base.indexOf('thumb_size') + 1,
    'thumb_size / thumb_format 必须相邻（它们是同一个事实的两半）',
  );
  // 判据函数本身：`lite` 只准减 `file_path`，`liveMotion:false` 只准减 `live_motion_id`
  const lite = mod.photoListColumns({ lite: true });
  assert(lite.indexOf('file_path') < 0, 'lite 必须去掉 file_path');
  assert(lite.indexOf('thumb_size') >= 0, 'lite 不许去掉 thumb_size（列清单与投影宽窄无关）');
  const noLive = mod.photoListColumns({ liveMotion: false });
  assert(noLive.indexOf('live_motion_id') < 0, 'liveMotion:false 必须去掉 live_motion_id');
  assert(noLive.indexOf('thumb_format') >= 0, 'liveMotion:false 不许去掉 thumb_format');

  // 字面量不许再长回来：基线清单的形状一旦出现在别处就是「又抄了一份」
  const srcDir = path.join(ROOT, 'src');
  const offenders = [];
  (function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (path.basename(entry.name) === 'photo-list-columns.js') continue;
      const text = stripComments(fs.readFileSync(full, 'utf8'));
      // 两种曾经的写法：整条基线 + `has_thumbnail, is_favorite` 形状
      if (/id, file_name, (file_path, )?folder_path, file_size, file_type/.test(text)) {
        offenders.push(path.relative(ROOT, full));
      }
      if (/has_thumbnail, is_favorite/.test(text)) {
        offenders.push(path.relative(ROOT, full) + '(has_thumbnail, is_favorite)');
      }
      if (/SELECT id, file_name, has_thumbnail FROM photos/.test(text)) {
        offenders.push(path.relative(ROOT, full) + '(封面窄投影字面量)');
      }
    }
  })(srcDir);
  assert(
    offenders.length === 0,
    '这些文件里又写出了列表列清单字面量（必须走 photo-list-columns.js）：' + offenders.join(', '),
  );
  console.log('[thumb-url] column source of truth ok');
}

// ------------------------------------------------- 3. 封面 SQL 不许把基线清单塞进窗口函数

function checkCoverSqlStaysNarrow() {
  const src = stripComments(readSource('src/db-heavy-read.js'));
  // 三条封面查询都必须走「按主键回查规格」那条路
  const viaPrefixed = (src.match(/thumbSpecColumnsPrefixed\(/g) || []).length;
  assert(
    viaPrefixed >= 3,
    '三条封面查询（legacy / paged / 子目录）都必须用 thumbSpecColumnsPrefixed()，实得 ' +
      viaPrefixed +
      ' 处',
  );
  assert(
    src.indexOf('photoListColumns()') < 0,
    'db-heavy-read.js 里出现了 photoListColumns() —— 封面的窗口函数会把整棵子树物化，' +
      '塞进整份基线清单等于把物化宽度撑大约 8%（真库数分钟级）。封面只许用 thumbSpecColumnsPrefixed()',
  );

  // 计划面：最终 SELECT 上那条 JOIN 必须是主键探针，不许变成扫 photos
  const dbPath = tempPath('plan');
  const Database = require('better-sqlite3');
  const raw = new Database(dbPath);
  try {
    raw.exec(`
      CREATE TABLE photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER, folder_path TEXT, file_name TEXT, file_path TEXT,
        file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER,
        date_taken TEXT, date_modified TEXT, thumbnail BLOB,
        has_thumbnail INTEGER DEFAULT 0, thumb_size INTEGER DEFAULT 0,
        thumb_format TEXT DEFAULT '', is_favorite INTEGER DEFAULT 0
      );
    `);
    const ins = raw.prepare(
      'INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type, has_thumbnail, thumb_size, thumb_format) VALUES (1,?,?,?,10,?,1,512,?)',
    );
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < 4; i++) {
        ins.run('C:\\p\\f' + f, 'p.jpg', 'C:\\p\\f' + f + '\\p.jpg', 'jpg', 'webp');
      }
    }
    const plan = raw
      .prepare(
        `EXPLAIN QUERY PLAN
         WITH filtered AS (SELECT id, file_name, folder_path, has_thumbnail, file_type FROM photos WHERE root_id = ?),
         ranked AS (SELECT id, file_name, folder_path, has_thumbnail,
             ROW_NUMBER() OVER (PARTITION BY folder_path ORDER BY id) AS rn,
             COUNT(*) OVER (PARTITION BY folder_path) AS folder_photo_count FROM filtered)
         SELECT r.id, r.folder_photo_count, ${photoListColumnsModule.thumbSpecColumnsPrefixed('p')}
         FROM ranked r JOIN photos p ON p.id = r.id WHERE r.rn = 1 ORDER BY r.folder_path ASC`,
      )
      .all(1)
      .map((r) => r.detail)
      .join(' | ');
    assert(
      /SEARCH p USING INTEGER PRIMARY KEY/.test(plan),
      '封面最终 SELECT 的 JOIN 不是主键探针（计划：' + plan + '）—— 封面只有每目录一行，' +
        '按主键回查是微秒级；退化成扫表就是每目录扫一遍 photos',
    );
    assert(
      !/SCAN p\b/.test(plan),
      '封面最终 SELECT 出现了 photos 的全表扫描（计划：' + plan + '）',
    );
    console.log('[thumb-url] cover sql narrow ok');
  } finally {
    try {
      raw.close();
    } catch (e) {}
    cleanup(dbPath);
  }
}

// ------------------------------------------------- 4. 缓存键必须随规格变化

/**
 * 🔴 这是本文件存在的**主因**：URL 不变 ⇒ 客户端永远拿旧字节。
 *
 * 断言方式（两条腿，缺一不可）：
 *   · **公式面**：两端的 `thumbCacheVersion` 都必须读 `thumb_size` 与 `thumb_format`，
 *     且**不许**退化成「原图键 + 后缀常量」；
 *   · **调用面**：所有拼 `thumb://` / `/thumb/` 的地方都必须带 `?v=`，且用的是缩略图键
 *     （不是原图键）；反过来，`photo://` / `/photo/` / `/preview-image/` 必须**继续**
 *     用原图键 —— 否则重建缩略图会把原图预览缓存也一起作废。
 */
function checkCacheKeyFollowsSpec() {
  const rendererUtils = stripComments(readSource('src/renderer/utils.js'));
  const webApp = stripComments(readSource('src/web/js/app.js'));

  const desktopBody = functionBodyByName(rendererUtils, 'thumbCacheVersion');
  const webBody = functionBodyByName(webApp, 'thumbCacheVersion');
  assert(desktopBody && desktopBody.length > 80, '夹具自证：没取到 renderer/utils.js#thumbCacheVersion');
  assert(webBody && webBody.length > 80, '夹具自证：没取到 web/js/app.js#thumbCacheVersion');

  for (const [label, body] of [
    ['renderer/utils.js#thumbCacheVersion', desktopBody],
    ['web/js/app.js#thumbCacheVersion', webBody],
  ]) {
    assert(body.indexOf('thumb_size') >= 0, label + ' 没有读 thumb_size ⇒ 键不随档位变化');
    assert(
      body.indexOf('thumb_format') >= 0,
      label + ' 没有读 thumb_format ⇒ 键不随编码格式变化（转 WebP 等于不生效）',
    );
    assert(
      body.indexOf('photoCacheVersion(') >= 0,
      label + ' 没有基于 photoCacheVersion()（原图字段仍要参与：换了原图缩略图也该失效）',
    );
  }
  // 两端公式必须同形：都用 `<原图键>-<档位><格式>`。逐字比对会把「实现风格」也钉死，
  // 所以只钉**连接方式**：`photoCacheVersion(…) + '-' + <size> + <format>` 这个顺序。
  const shape = /photoCacheVersion\([^)]*\)\s*\+\s*'-'\s*\+\s*\w+\s*\+\s*\w+/;
  assert(shape.test(desktopBody), '桌面端键的拼法变了（期望 `原图键 + "-" + 档位 + 格式`）');
  assert(
    shape.test(webBody),
    '网页端键的拼法变了（两端必须同形，否则同一张图在两端是两份缓存）',
  );

  // 调用面：桌面端 `thumb://`
  const rendererFiles = ['src/renderer/preview-flow.js', 'src/renderer/ui-grid.js', 'src/renderer/ui-duplicates.js'];
  let thumbSites = 0;
  for (const rel of rendererFiles) {
    const src = stripComments(readSource(rel));
    // `'thumb://' + X` 后面必须跟 `?v=`，且键取 thumbCacheVersion
    const re = /'thumb:\/\/'\s*\+\s*[^;]*?;/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      thumbSites += 1;
      assert(m[0].indexOf('?v=') >= 0, rel + ' 里有一处 ' + m[0].trim() + ' 没带 ?v= 缓存键');
      assert(
        m[0].indexOf('thumbCacheVersion(') >= 0,
        rel + ' 里有一处缩略图 URL 用的是原图键（或没有键）：' + m[0].trim(),
      );
    }
  }
  assert(thumbSites >= 4, '桌面端应至少找到 4 处 thumb:// 拼装点，实得 ' + thumbSites);

  // 调用面：网页端 `/thumb/`
  let webSites = 0;
  for (const rel of ['src/web/js/app.js', 'src/web/js/ai-views.js']) {
    const src = stripComments(readSource(rel));
    const re = /\/thumb\/'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      // ⚠️ 取的是**前后双向**窗口，不是「往后 400 字符」：键常常先算进一个局部变量
      //    （`var thumbVer = thumbCacheVersion(photo);`）再拼两处 URL（模糊占位 + 真图），
      //    只看后面会把「先算后拼」这种**更好**的写法判成没带键 —— 假红。
      //    窗口刻意放宽到 400/600，是因为拼接在这两个文件里都是多行字符串。
      const from = Math.max(0, m.index - 400);
      const window = src.slice(from, m.index + 600);
      webSites += 1;
      assert(
        window.indexOf('?v=') >= 0,
        rel + ' 里有一处 /thumb/ URL 附近没有 ?v= 缓存键：' + window.split('\n').slice(-4).join(' '),
      );
      assert(
        window.indexOf('thumbCacheVersion(') >= 0,
        rel +
          ' 里有一处 /thumb/ URL 附近没走 thumbCacheVersion()：' +
          window.split('\n').slice(-4).join(' '),
      );
    }
  }
  assert(webSites >= 4, '网页端应至少找到 4 处 /thumb/ 拼装点，实得 ' + webSites);

  // ai-views 是**先于 app.js 加载**的独立文件，键函数只能靠 deps 注入 ⇒ 注入不许少
  assert(
    /thumbCacheVersion:\s*thumbCacheVersion,/.test(webApp),
    'app.js 没有把 thumbCacheVersion 注入 ai-views 的 deps —— 那边的目录封面会静默退回「没有键」',
  );
  assert(
    /deps\.thumbCacheVersion/.test(stripComments(readSource('src/web/js/ai-views.js'))),
    'ai-views.js 没有从 deps 取 thumbCacheVersion',
  );

  // 反向：原图那几条路**不许**改用缩略图键
  const originalSites = [
    ['src/renderer/preview-flow.js', /'photo:\/\/'\s*\+\s*[^;]*?;/g],
    ['src/web/js/app.js', /'\/preview-image\/'\s*\+\s*[^;]*?;/g],
  ];
  for (const [rel, re] of originalSites) {
    const src = stripComments(readSource(rel));
    let m;
    let seen = 0;
    while ((m = re.exec(src)) !== null) {
      seen += 1;
      assert(
        m[0].indexOf('thumbCacheVersion(') < 0,
        rel + ' 里原图/预览 URL 用了缩略图键（' +
          m[0].trim() +
          '）—— 那会让重建缩略图把原图预览缓存也一起作废',
      );
    }
    assert(seen > 0, '夹具自证：' + rel + ' 里应能找到原图 URL 拼装点');
  }

  // Android：同一条契约的第三份实现（不共享代码，但必须也随规格变化）
  const kotlin = readSource('android-app/app/src/main/kotlin/com/foredawn/aurora/data/model/Photo.kt');
  // 判据走**字段名**而不是注解字面量：Kotlin 里序列化名写成 `@SerializedName("thumb_size")`，
  // 去掉引号转义的正则更耐改（注解换成 kotlinx 的 `@SerialName` 也不受影响）。
  assert(
    kotlin.indexOf('thumbSize') >= 0 && kotlin.indexOf('thumbFormat') >= 0,
    'Android 的 Photo 模型没有带缩略图规格 ⇒ 那边的封面/卡片在重建后要等一天才刷新',
  );
  assert(
    /fun thumbnailUrl\(baseUrl: String\)[\s\S]{0,700}?\/thumb\/\$id\?v=/.test(kotlin),
    'Android 的 thumbnailUrl() 没带 ?v= 缓存键（重建在这端等于不生效）',
  );
  assert(
    /fun thumbnailUrl\(baseUrl: String\)[\s\S]{0,700}?thumbSize/.test(kotlin),
    'Android 的 thumbnailUrl() 的键里没有档位 ⇒ 换档之后这端不刷新',
  );
  assert(
    /fun thumbnailUrl\(baseUrl: String\)[\s\S]{0,700}?thumbFormat/.test(kotlin),
    'Android 的 thumbnailUrl() 的键里没有编码格式 ⇒ 转 WebP 之后这端不刷新',
  );
  console.log('[thumb-url] cache key ok');
}

function run() {
  checkEveryListCarriesSpec();
  checkCoverWhitelistParity();
  checkCoverSqlStaysNarrow();
  checkCacheKeyFollowsSpec();
  console.log('[thumb-url] PASS (' + checks + ' checks)');
}

run();
