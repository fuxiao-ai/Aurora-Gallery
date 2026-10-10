'use strict';
/**
 * 搜图页「关键词」档的目录检索契约（`database.js#searchFolders` + 全链路接线）。
 *
 * 守三件事，每一件都是从本项目已踩过的坑里长出来的：
 *
 *   ① **语义**：目录是按 `folder_path` 子串匹配出来的，每个目录带照片数与一张封面；
 *      LIKE 元字符（`%` / `_` / `\`）必须是**字面量** —— 否则搜「50%」会命中「500」，
 *      而 Windows 路径里到处是 `\`，不转义的话一半的搜索都是错的。
 *   ② **性能形态**：这条查询必须走 `idx_photos_folder` 的**覆盖索引**扫描、不回表。
 *      一旦有人在 WHERE 上再加一列（`file_type` / `live_still_id`），规划器就会放弃覆盖
 *      索引去逐行回表 —— 真库上那是 **105,954 ms** 那一档，而且不会报错。
 *   ③ **接线**：`searchFolders` 要同时出现在 worker 的 op 列表、主进程 IPC、preload、
 *      renderer api 四处。少一处 = IPC 直接抛 `photoAPI method unavailable`，
 *      而静态检查全绿。
 *   ④ **文件名口径**：搜图页「文件」组只留**文件名里包含**关键词的（`searchPhotos`
 *      的 `nameOnly`）。丢掉它不会报错、结果也非空 —— 只是那一组悄悄变成「文件名**或
 *      所在目录**命中」，把「文件夹」组该表达的东西重复列一遍。
 *      这条路刻意**不复用 FTS**（FTS5 是分词前缀，`"日子"*` 匹配不到 `海边的日子_001.jpg`），
 *      而是钉 `idx_photos_name` 覆盖索引 —— 1,200,000 行夹具实测它 1~265 ms 且不随命中密度
 *      变化，而「不加 hint + ORDER BY date_taken」在零命中时要走 **11,522 ms**。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const PhotoDatabase = require('../src/database');

const db = new Database(':memory:');
db.exec(`CREATE TABLE photos (
  id INTEGER PRIMARY KEY, root_id INTEGER, file_name TEXT, file_path TEXT,
  folder_path TEXT, file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER,
  date_taken TEXT, date_modified TEXT, has_thumbnail INTEGER, is_favorite INTEGER
); CREATE TABLE root_folders (id INTEGER PRIMARY KEY, path TEXT);
  -- 真库在建库时就有这两条索引，夹具必须同样具备：
  -- 没有 idx_photos_folder，上面「覆盖索引 + 不回表」那条断言测的就不是真实形态；
  -- 没有 idx_photos_name，nameOnly 那条路会因为 hasIndex 闸门**静默退回不加 hint**，
  -- 于是计划断言变成「在测一个产品根本不会走的分支」。
  CREATE INDEX idx_photos_folder ON photos(folder_path);
  CREATE INDEX idx_photos_name ON photos(file_name)`);
{
  // 跑**真实的迁移函数**补列（与 query-regression 同一条纪律）：手抄列定义必然漂移。
  // ⚠️ `ensurePhotosThumbnailMetaColumns()` 现在也是必需的：列清单收口到
  //    `photo-list-columns.js` 之后，`searchPhotos` / `searchFolders` 的封面查询都会
  //    SELECT `thumb_size` / `thumb_format`（浏览层要拿它们拼缓存键），夹具缺列即 `no such column`。
  // ⚠️ `ensurePhotosOrgMetaColumns()`（2026-10-09）同理：`photoListColumns()` 加了
  //    `rating` / `flag`（组织元数据），`searchPhotos` 的列清单随之带上这两列 ⇒
  //    夹具缺列就在 `db.prepare` 那一刻抛 `no such column: rating`。
  //    这也正是「列清单必须收口到唯一源」的代价面：加一列会波及每一份手写夹具，
  //    但反过来，不收口就会像 `thumb_size` 那次一样**静默**给出 `undefined`。
  const migrator = Object.create(PhotoDatabase.prototype);
  migrator.db = db;
  migrator.ensurePhotosLivePhotoColumns();
  migrator.ensurePhotosThumbnailMetaColumns();
  migrator.ensurePhotosOrgMetaColumns();
}
// 夹具刻意用 **Windows 反斜杠**：真库的 `folder_path` 就是这种形状，
// 而「用户输入 `/` 也要命中」这条归一规则只有在反斜杠库上才测得出来。
const insert = db.prepare(
  `INSERT INTO photos
     (id, root_id, file_name, file_path, folder_path, file_size, file_type,
      width, height, date_taken, date_modified, has_thumbnail, is_favorite)
   VALUES (?, 1, ?, ?, ?, 1, ?, 1, 1, '2026-01-01 10:00:00', '2026-01-01 10:00:00', ?, 0)`,
);
function add(id, folder, type, thumb) {
  insert.run(id, `${id}.${type}`, `${folder}\\${id}.${type}`, folder, type, thumb ? 1 : 0);
}
/** 文件名要能被断言指定时用这个（`add` 的文件名是 `<id>.<ext>`）。 */
function addNamed(id, name, folder, type, thumb) {
  insert.run(id, name, `${folder}\\${name}`, folder, type, thumb ? 1 : 0);
}
// K:\COS\2024\05 里有 3 张（2 图 + 1 视频），封面取**名字最小**的那张图
add(1, 'K:\\COS\\2024\\05', 'jpg', true);
add(2, 'K:\\COS\\2024\\05', 'jpg', false);
add(3, 'K:\\COS\\2024\\05', 'mp4', true);
// 同名的另一处：只有中间那层命中（`2024` 出现在路径中段，不在末段）
add(4, 'K:\\COS\\2024\\06', 'jpg', true);
// 末段命中但只有 1 张 —— 用来验「末段命中优先于照片数多」
add(5, 'K:\\COS\\Beach Trip', 'jpg', true);
// 元字符：目录名真的带 `_` 和 `%`
add(6, 'K:\\COS\\a_%x', 'jpg', true);
add(7, 'K:\\COS\\axxx', 'jpg', true);
// ── 文件名口径（`nameOnly`）的判据行 ──
// 8：**文件名**含「海边」，但所在目录不含 ⇒ 只有 nameOnly 才该找到它
addNamed(8, '\u6D77\u8FB9_001.jpg', 'K:\\COS\\zzz', 'jpg', true);
// 9：**文件名**含「7777」，目录不含 ⇒ 只有文件组找得到它（与上面 1~4 的「目录命中」互补）
addNamed(9, 'IMG_7777.jpg', 'K:\\COS\\zzz', 'jpg', true);
// 10 / 11：文件名里的 `%` 与 `_` 必须是**字面量**（不转义的话 `a_%x` 会命中 `axxx_file`）
addNamed(10, 'a_%x_literal.jpg', 'K:\\COS\\zzz', 'jpg', true);
addNamed(11, 'axxx_file.jpg', 'K:\\COS\\zzz', 'jpg', true);

// 与 worker 里完全同形的调用方式：共享实现、不走构造函数迁移。
const reader = Object.create(PhotoDatabase.prototype);
reader.db = db;
reader._ftsAvailable = false;

// ① 基本命中：目录数、照片数、封面
const byYear = reader.searchFolders('2024', { limit: 12 });
assert.equal(byYear.total, 2, 'two folders match “2024”');
assert.equal(byYear.folders.length, 2);
assert.equal(byYear.folders[0].folder_path, 'K:\\COS\\2024\\05', 'more photos ranks first');
assert.equal(byYear.folders[0].folder_photo_count, 3);
assert.equal(
  byYear.folders[0].id,
  1,
  'cover prefers an image with a thumbnail, then the smallest file name',
);
assert.equal(byYear.folders[0].has_thumbnail, true);

// ② 末段命中优先于「只是路径中段命中」，哪怕后者照片更多
const byWord = reader.searchFolders('05', {});
assert.equal(byWord.total, 1);
assert.equal(byWord.folders[0].folder_path, 'K:\\COS\\2024\\05');
const leafFirst = reader.searchFolders('Beach', { limit: 12 });
assert.equal(leafFirst.folders.length, 1);
assert.equal(leafFirst.folders[0].folder_path, 'K:\\COS\\Beach Trip');

// ③ LIKE 元字符是字面量：`%` / `_` 不当代配符
const pct = reader.searchFolders('a_%x', {});
assert.equal(pct.total, 1, '“%” must not match “axxx”');
assert.equal(pct.folders[0].folder_path, 'K:\\COS\\a_%x');
const underscore = reader.searchFolders('a_', {});
assert.equal(underscore.total, 1, '“_” must not match “axxx”');
assert.equal(underscore.folders[0].folder_path, 'K:\\COS\\a_%x');
const backslash = reader.searchFolders('COS\\2024', {});
assert.equal(backslash.total, 2, 'a literal backslash in the query still matches');

// ④ 分隔符归一：库里是 `\`，用户输入 `/` 也要命中（反过来同理）
const slash = reader.searchFolders('2024/05', {});
assert.equal(slash.total, 1, 'user-typed “/” is normalized to the separator the library uses');
assert.equal(slash.folders[0].folder_path, 'K:\\COS\\2024\\05');

// ⑤ limit 只截返回、不改 total（界面要报「共 N 个目录」）
const capped = reader.searchFolders('COS', { limit: 1 });
assert.equal(capped.total, 6, 'total is the full match count, not the page size');
assert.equal(capped.folders.length, 1);

// ⑥ 空词 / 无命中：返回空结构而不是抛错
assert.deepEqual(reader.searchFolders('', {}), { folders: [], total: 0 });
assert.deepEqual(reader.searchFolders('   ', {}), { folders: [], total: 0 });
assert.equal(reader.searchFolders('zzz-no-such-folder', {}).total, 0);

// ⑦ 性能形态：必须走覆盖索引、不回表（加一列谓词就会翻车，且不报错）
const plan = db
  .prepare(
    `EXPLAIN QUERY PLAN SELECT folder_path, COUNT(*) AS photo_count
     FROM photos WHERE folder_path LIKE ? ESCAPE '\\' GROUP BY folder_path`,
  )
  .all('%2024%');
const planText = plan.map((row) => String(row.detail)).join(' | ');
assert.ok(
  /COVERING INDEX idx_photos_folder/.test(planText),
  'folder keyword search must stay on the covering index, got: ' + planText,
);
assert.ok(
  !/TEMP B-TREE/.test(planText),
  'GROUP BY must ride the index order (no temp b-tree), got: ' + planText,
);

// ⑧ 接线：四处少一处就是「点了没反应」+ 静态检查全绿
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const worker = src('workers/db-read-worker.js');
assert.ok(
  /'searchFolders'/.test(worker) && /op === 'searchFolders'/.test(worker),
  'db-read-worker must both whitelist and dispatch searchFolders',
);
assert.ok(
  /ipcMain\.handle\(\s*'search-folders'/.test(src('main.js')),
  'main.js must register the search-folders IPC',
);
assert.ok(/searchFolders: function/.test(src('preload.js')), 'preload must expose searchFolders');
assert.ok(/searchFolders: function/.test(src('renderer/api.js')), 'renderer api must wrap it');

// ⑨ 桌面端搜图页必须有「关键词 / 语义」两个档位（一个框猜引擎 = 串档）
const shell = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
assert.ok(/id="aiSearchModeKeyword"/.test(shell), 'keyword mode button must exist');
assert.ok(/id="aiSearchModeSemantic"/.test(shell), 'semantic mode button must exist');
const views = src('renderer/ai-views.js');
assert.ok(/data-ai-search-mode/.test(views), 'mode switch must be wired by attribute, not by id');
assert.ok(/doKeywordSearch/.test(views), 'keyword search path must exist');

// ═══════════════════════════════════════════════════════════════════════════
// ⑩ 「文件」组只留**文件名中包含**关键词的（`searchPhotos({ nameOnly })`）
//
// 这一组断言防的是一个**极易溜过去的回归**：把 `nameOnly` 丢掉之后，代码照样跑、
// 结果照样有、界面上「文件」组照样是非空的 —— 只是那一组变成了「文件名**或所在目录**
// 命中」的照片，于是搜「2024」会把 `K:\COS\2024\05` 里的 3 张 `1.jpg/2.jpg/3.jpg`
// 全列出来（它们文件名里根本没有 2024）。而那正是「文件夹」组负责表达的事。
// ═══════════════════════════════════════════════════════════════════════════
reader._ftsAvailable = false; // 本夹具没有 FTS 表；`nameOnly` 这条路**不依赖** FTS

// ⑩-1 反向基础：**不带** nameOnly 时，4 张「仅目录命中」的照片确实会被搜出来
//      （这条同时证明下面的断言不是「夹具本来就搜不到」造成的假绿）
const both = reader.searchPhotos('2024', {});
assert.equal(both.total, 4, 'without nameOnly the folder-matched photos are included');
assert.deepEqual(
  both.photos.map((p) => p.id).sort((a, b) => a - b),
  [1, 2, 3, 4],
  'folder matches leak in when nameOnly is off — that is exactly what the flag must cut',
);

// ⑩-2 带 nameOnly 时，「2024」在文件组里是**零命中** —— 没有任何**文件名**含它
const nameOnly = reader.searchPhotos('2024', { nameOnly: true });
assert.equal(nameOnly.total, 0, 'no file name contains “2024”; folder hits must not leak in');
assert.equal(nameOnly.photos.length, 0);

// 反方向：只出现在文件组里的那一张（目录名不含它）
const named = reader.searchPhotos('7777', { nameOnly: true });
assert.equal(named.total, 1, 'nameOnly finds a file the folder group cannot see');
assert.equal(named.photos[0].id, 9);
assert.equal(named.photos[0].file_name, 'IMG_7777.jpg');
assert.equal(reader.searchFolders('7777', {}).total, 0, 'no folder contains “7777”');

// ⑩-3 两组不重叠：目录里没有「海边」，只有 id 8 的**文件名**有
assert.equal(reader.searchFolders('\u6D77\u8FB9', {}).total, 0, 'no folder contains 海边');
const byName = reader.searchPhotos('\u6D77\u8FB9', { nameOnly: true });
assert.equal(byName.total, 1, 'the file-name hit is still found by the file group');
assert.equal(byName.photos[0].id, 8);

// ⑩-4 LIKE 元字符在**文件名**这条路上也是字面量
const literalPct = reader.searchPhotos('a_%x', { nameOnly: true });
assert.equal(literalPct.total, 1, '“%”/“_” must not act as wildcards on file names either');
assert.equal(literalPct.photos[0].id, 10);
const literalUnderscore = reader.searchPhotos('a_', { nameOnly: true });
assert.equal(literalUnderscore.total, 1, '“_” must not match “axxx_file.jpg”');
assert.equal(literalUnderscore.photos[0].id, 10);

// ⑩-5 空词 / 无命中：空结构，不抛错
assert.deepEqual(reader.searchPhotos('   ', { nameOnly: true }), {
  photos: [],
  total: 0,
  page: 1,
  pageSize: 100,
  totalPages: 0,
});
assert.equal(reader.searchPhotos('zzz-no-such-file', { nameOnly: true }).total, 0);

// ⑩-6 分页：total 是全量命中数，page 只截返回；且**按文件名有序**
const paged = reader.searchPhotos('jpg', { nameOnly: true, pageSize: 2 });
assert.equal(paged.total, 10, 'total counts every file whose own name contains “jpg”');
assert.equal(paged.photos.length, 2);
const allNames = reader.searchPhotos('jpg', { nameOnly: true, pageSize: 100 }).photos.map((p) => p.file_name);
assert.deepEqual(
  allNames,
  allNames.slice().sort(),
  'the file group is ordered by file_name — that is what keeps the plan free of a temp b-tree',
);
assert.ok(allNames.every((n) => n.includes('jpg')), 'every row must match on its own name');

// ⑩-7 性能形态：计数必须走 `idx_photos_name` 的**覆盖索引**（只碰 file_name 一列、不回表）。
//      真库 1,200,000 行夹具实测：钉住覆盖索引 1~265 ms 且**不随命中密度变化**；
//      而「不加 hint + ORDER BY date_taken」在**零命中**时要走完整条日期索引逐行回表
//      = 11,522 ms。所以这条计划断言是**性能红线**，不是风格问题。
const namePlan = db
  .prepare(
    `EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM photos INDEXED BY idx_photos_name
     WHERE file_name LIKE ? ESCAPE '\\'`,
  )
  .all('%2024%')
  .map((row) => String(row.detail))
  .join(' | ');
assert.ok(
  /COVERING INDEX idx_photos_name/.test(namePlan),
  'file-name count must stay on the covering index, got: ' + namePlan,
);
const pagePlan = db
  .prepare(
    `EXPLAIN QUERY PLAN SELECT id, file_name FROM photos INDEXED BY idx_photos_name
     WHERE file_name LIKE ? ESCAPE '\\' ORDER BY file_name LIMIT 60`,
  )
  .all('%2024%')
  .map((row) => String(row.detail))
  .join(' | ');
assert.ok(
  /INDEX idx_photos_name/.test(pagePlan),
  'file-name paging must ride idx_photos_name, got: ' + pagePlan,
);
assert.ok(
  !/TEMP B-TREE/.test(pagePlan),
  'ORDER BY file_name must be satisfied by the index order, got: ' + pagePlan,
);

// ⑩-8 接线：`nameOnly` 必须真的从**两端**传下去，少一处就退回「目录也命中」而全绿
//
// ⚠️ 必须先**剥掉注释**再数：本文件两侧的注释里就写着 `nameOnly` 这几个字
//    （那是给人看的，不该算作接线）。不剥的话断言会随注释措辞漂移 —— 加一句注释
//    就能让「少传了一处」的负例照样通过。
const codeOnly = (s) =>
  String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const viewsCode = codeOnly(views);
assert.ok(/nameOnly:\s*true/.test(viewsCode), 'desktop keyword file group must pass nameOnly');
assert.equal(
  (viewsCode.match(/nameOnly:\s*true/g) || []).length,
  2,
  'both the first page and the “more” page must pass nameOnly',
);
const webViews = src('web/js/ai-views.js');
const webCode = codeOnly(webViews);
assert.ok(/nameOnly=1/.test(webCode), 'web keyword file group must pass nameOnly=1');
assert.equal(
  (webCode.match(/nameOnly=1/g) || []).length,
  2,
  'both the web first page and the “more” page must pass nameOnly=1',
);
assert.ok(
  /options\.nameOnly\s*=\s*true/.test(codeOnly(src('web-server.js'))),
  'web-server must translate the query flag into the db option',
);

console.log('keyword-search-regression: PASS');
