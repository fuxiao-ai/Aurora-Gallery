'use strict';

var Database = require('better-sqlite3');
var worker_threads = require('worker_threads');
var workerData = worker_threads.workerData;

var dbPath = workerData && workerData.dbPath;
if (!dbPath) {
  process.exit(1);
}

var db = new Database(dbPath);
db.pragma('busy_timeout = 8000');

// 建索引 = 「整表读一遍 + 排序」，`cache_size` 直接决定排序有多少页能留在内存、
// 有多少要溢出到临时文件。与**读池**用同一个数（唯一真相源在 `src/database.js`，
// 这里引用常量、不抄数字）：数值只许改一次，各抄一份 = 将来只改一处，另一条静默变慢。
// ⚠️ 本连接是**读写**的（要建索引），所以多占的这 128 MB 是真实的；读池那边的同值是纯读缓存。
try {
  var PhotoDatabaseForPragmas = require('../database');
  db.pragma('cache_size = ' + PhotoDatabaseForPragmas.DB_CACHE_SIZE_KB);
} catch (ePragma) {
  void ePragma;
}

var results = {};

/**
 * 逐条上报建索引进度（消息带 `__progress: true`）。
 *
 * 🔴 为什么必须有它（2026-10-06 加）：这个 worker 过去**只在退出时** postMessage 一次完整
 *    结果 ⇒ 一次十几分钟的建索引过程在落盘打点里**零现场**。真库实测过：写库闸门从启动
 *    12.7 s 被占，之后 6 分钟没有任何打点，同时缩略图补全面板又是假死的 ⇒ 用户和我都只能
 *    靠「库体积有没有在涨」猜它到底是慢还是死了。
 * ⚠️ 只在「这条索引真的不存在、这一轮真的开始建」时才发。已存在的走 `IF NOT EXISTS` 秒过，
 *    不发 —— 否则每次启动都会多出十几条纯噪音打点。
 * ⚠️ `ms` 是**建这一条索引的真实耗时**，这是全工程唯一的直接观测点（过去完全没有数字）。
 */
function postItem(kind, name, ok, ms, error) {
  try {
    if (!worker_threads.parentPort) return;
    worker_threads.parentPort.postMessage({
      __progress: true,
      kind: kind,
      name: name,
      ok: !!ok,
      ms: Number(ms) || 0,
      error: error ? String(error) : '',
    });
  } catch (ePost) {
    void ePost;
  }
}

/** 索引是否已存在 —— 决定这一轮是「真要建」还是 `IF NOT EXISTS` 秒过。 */
function indexExists(name) {
  try {
    return !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
      .get(name);
  } catch (eIdx) {
    void eIdx;
    // 查不出来就当不存在：宁可多打一条打点，也别把真正的建索引过程藏起来。
    return false;
  }
}

/** 库里那条索引**当时**建出来的原文（`sqlite_master.sql` 存的是执行时的原样文本）。 */
function storedIndexSql(name) {
  try {
    var row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
      .get(name);
    return row ? String(row.sql || '') : null;
  } catch (eSql) {
    void eSql;
    return null;
  }
}

/**
 * 比较 DDL 前做两件归一化：
 *
 * ① 折叠空白 —— 换行/缩进差异不算「定义变了」；
 * ② **剥掉 `IF NOT EXISTS`** —— SQLite 存进 `sqlite_master.sql` 时会把这半句删掉
 *    （官方文档列的规范化规则之一）。不剥的话库里那条**永远**等于不了清单里的 DDL，
 *    于是每次启动都判成「定义变了」⇒ DROP 再 CREATE ⇒ 白花几分钟建整条索引，
 *    而这正是本函数要避免的那个失败模式。
 */
function normalizeSqlText(s) {
  return String(s || '')
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 建一条索引，并按「这一轮是否真的在建」上报进度。**每条各自独立 try**（内部那个），
 * 任何一条失败（磁盘满 / 谓词笔误）都不影响其余条，且错误消息能对上具体是哪一条。
 *
 * @param {string} name 索引名（必须与 DDL 里的名字一致，否则存在性判断会一直为假）
 * @param {string} sql 完整、可直接 exec 的 DDL
 * @param {boolean} [rebuildOnChange] DDL 里**烤了会变的字面量**（目前只有 `EXIF_SCHEMA_VERSION`）
 *   时传 `true`：`IF NOT EXISTS` 只认名字、不认定义，版本一升就会留下一条**旧定义**的索引，
 *   而查询要的是新定义 ⇒ 蕴含证不出来 ⇒ 规划器静默退回全表扫（不报错、只是慢回几十秒）。
 *   传 `true` 时先比对 `sqlite_master.sql`，不同就 `DROP` 再建。
 *   ⚠️ **默认不传**：其余索引的 DDL 是稳定的，加上比对只会引入「历史文本与字面量差一个空格
 *   就在每次启动重建几分钟」的风险。
 * @returns {string} `'ok'` 或错误消息（与既有 `results.phaseN[name]` 的取值形态一致）
 */
function createIndexReporting(name, sql, rebuildOnChange) {
  if (rebuildOnChange) {
    var stored = storedIndexSql(name);
    if (stored !== null && normalizeSqlText(stored) !== normalizeSqlText(sql)) {
      // 定义变了：`IF NOT EXISTS` 会直接跳过 ⇒ 必须显式 DROP。名字来自本工程的字面量清单，
      // 仍然加引号（宁可多两个字符，也不让一个手误的名字变成 SQL 注入）。
      try {
        db.exec('DROP INDEX IF EXISTS "' + String(name).replace(/"/g, '""') + '"');
      } catch (eDrop) {
        void eDrop;
      }
    }
  }
  var existed = indexExists(name);
  if (!existed) postItem('start', name, false, 0, '');
  var startedAt = Date.now();
  try {
    db.exec(sql);
    if (!existed) postItem('done', name, true, Date.now() - startedAt, '');
    return 'ok';
  } catch (eCreate) {
    var msg = eCreate && eCreate.message ? eCreate.message : String(eCreate);
    if (!existed) postItem('done', name, false, Date.now() - startedAt, msg);
    return msg;
  }
}

// Phase 0: root_folder composite index
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_root_folder ON photos(root_id, folder_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_folder_nocase ON photos(folder_path COLLATE NOCASE)');
  results.phase0 = 'ok';
} catch (e) {
  results.phase0 = e && e.message ? e.message : String(e);
}

// Phase 1: aggregation partial indexes (image/video)
//
// 🔴 谓词**不再在这里手写**：它们与 `db-heavy-read.js` 的 `IMAGE_TYPE_PRED` / `VIDEO_TYPE_PRED`
//    必须**逐字相同**（SQLite 的部分索引匹配是逐字的，差一个字符索引就用不上，且不报错），
//    而那一份同时被统计子查询消费 ⇒ 唯一真相源在 `db-heavy-read.js`，这里只引用。
//    过去 worker 里另抄过一份后缀清单，那正是「三处各写一份、改一处漏两处」的形态。
var deferredIndexes = require('../main/deferred-indexes');
var imgPred = deferredIndexes.IMAGE_TYPE_PRED;
var vidPred = deferredIndexes.VIDEO_TYPE_PRED;
try {
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_image ON photos(root_id, folder_path) WHERE ' +
      imgPred,
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_video ON photos(root_id, folder_path) WHERE ' +
      vidPred,
  );
  results.phase1 = 'ok';
} catch (e) {
  results.phase1 = e && e.message ? e.message : String(e);
}

// Phase 2: duplicate hash pending index (needs hash columns first)
try {
  try { db.exec('ALTER TABLE photos ADD COLUMN file_hash TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN hash_mtime TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN hash_size INTEGER'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash)'); } catch (e) { void e; }

  var pending = "(file_hash IS NULL OR TRIM(file_hash) = '')";
  var img = '(' + imgPred + ')';
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_dup_hash_pending ON photos(id) WHERE ' +
      pending +
      ' AND ' +
      img,
  );
  results.phase2 = 'ok';
} catch (e) {
  results.phase2 = e && e.message ? e.message : String(e);
}

// Phase 3: EXIF metadata columns
try {
  try { db.exec('ALTER TABLE photos ADD COLUMN camera_make TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN camera_model TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN lens_model TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN focal_length REAL'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN aperture REAL'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN iso_speed INTEGER'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN shutter_speed TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN gps_latitude REAL'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN gps_longitude REAL'); } catch (e) { void e; }
  results.phase3 = 'ok';
} catch (e) {
  results.phase3 = e && e.message ? e.message : String(e);
}

// Phase 4: 只读大查询的覆盖索引（2026-10-06 加）
//
// 两条前台查询各自缺一条索引，缺的都不是「筛不出来」而是「筛出来还得回去拿列」：
//
//   ① `idx_photos_root_folder_date (root_id, folder_path, date_taken)` —— 给 `getFolderTree`。
//      `SELECT folder_path, COUNT(id), MIN(date_taken), MAX(date_taken) … GROUP BY folder_path`
//      过去吃 `idx_photos_root_folder (root_id, folder_path)`：分组免排序 ✅，但**不 covering**
//      ⇒ MIN/MAX 要的 `date_taken` 只能回表，真库 root 23（912,222 行 / 31,730 目录）实测
//      **>4 分钟未返回**（91 万次回表）。补上 date_taken 之后三列都在索引里，零回表：
//      45,000 行夹具上 113.8 ms → **5.8 ms**，计划从 `USING INDEX` 变 `USING COVERING INDEX`。
//
//   ② `idx_photos_root_date (root_id, date_taken)` —— 给 `getPhotos({rootId})`。
//      默认排序键是 `date_taken DESC`，而既有 `idx_photos_root_date_mod` 建在 `date_modified`
//      上 —— **与排序键不匹配**，所以优化器只能退到 `idx_photos_root` 再
//      `USE TEMP B-TREE FOR ORDER BY`（真库实测 **70,594 ms**）。名字故意与既有
//      `idx_photos_root_date_mod` 成对（同前缀，只差 `_mod`）。
//      同夹具上 112.2 ms → **1.5 ms**，且 `ORDER BY date_taken DESC NULLS LAST` 的
//      `NULLS LAST` 不挡索引（SQLite 里 NULL 最小 ⇒ DESC 时天然排最后；真库实测
//      `date_taken IS NULL` 共 0 行）。
//
// ⚠️ 建索引的代价（为什么必须留在这个 worker 里、不许进启动路径）：
//   - 真库 1,656,580 行，两条都要**整表读一遍 + 排序**，会长时间独占写库闸门；
//   - 但它**不需要穿缩略图溢出页链** —— 真库 `PRAGMA table_info(photos)` 实测列序是
//     `root_id` 1 / `folder_path` 2 / `date_taken` 9 / `thumbnail` **11**，三个索引列全部排在
//     那个 7,723 字节的内联 BLOB **之前**，只读每行的前段。
//     （对比：读 BLOB 之后的列要穿整条溢出页链，`db-heavy-read.js` 的 `SUM(file_size)` 就是那类。）
//   - 体积（真库 45,000 行夹具 dbstat 外推，folder_path 平均 23.1 字符）：
//     `idx_photos_root_folder_date` ≈ 87 MB、`idx_photos_root_date` ≈ 47 MB / 165 万行。
//
// ⚠️ `IF NOT EXISTS` ⇒ 只在第一次真正建；之后每次启动都是空操作（一句 sqlite_master 查询）。
//
// 为什么不用 `INDEXED BY` 钉住（`db-heavy-read.js` 的聚合计数是钉的）：那套钉法的前提是
// 「索引一旦存在就一定更优」。这里两条都是**规划器自己就会发现更优**的形态（covering / 免排序），
// 夹具上把全工程 16 条查询逐条对照过，只有「日期分组 + rootId」一条顺带变好（也从非 covering
// 变成 covering），没有任何一条被带偏。钉住反而会引入「索引还没建出来时 INDEXED BY 直接报
// no such index」的失败模式，以及读池 worker 长期持有 hasIndex 缓存造成的假阴性。
// 🔴 每条索引**各自独立 try**（2026-10-06 修）。
//    原来两条挤在同一个 try 里：第二条失败时，`results.phase4` 只留下一句消息，
//    看不出「第一条成了没有」。当时正赶上这个 worker 正在建第二条（索引还没出现在
//    `sqlite_master` 里），配上打包版 `logger` 只写 console、**根本不落文件**
//    ⇒ 现场看起来完全像「只建出来一条、且没有任何痕迹」的真实缺陷，我差点误报给用户。
//    逐条一个 try，谁成谁败在 `startup-performance.json` 里一目了然。
// ⚠️ `results` 只被 `main.js#runDeferredIndexWorker` 原样 `JSON.stringify` 落盘，
//    没有任何机器消费方读具体字段 ⇒ 这里由字符串改成对象是安全的，且更可读。
results.phase4 = {};
results.phase4.idx_photos_root_folder_date = createIndexReporting(
  'idx_photos_root_folder_date',
  'CREATE INDEX IF NOT EXISTS idx_photos_root_folder_date ON photos(root_id, folder_path, date_taken)',
);
results.phase4.idx_photos_root_date = createIndexReporting(
  'idx_photos_root_date',
  'CREATE INDEX IF NOT EXISTS idx_photos_root_date ON photos(root_id, date_taken)',
);

// Phase 5: 前台只读大查询的第二批索引（2026-10-06 加，见 `docs/sql-acceleration-audit.md` §3）
//
// 与 Phase 4 同源：都是「真库上确实慢、夹具上证明换索引能把执行计划翻转」，差别只是服务
// 另外几条前台查询。
//
//   ① `idx_photos_root_name (root_id, file_name)` —— 按根浏览 + 按文件名排序。
//      五个排序键里 `date_taken` / `date_modified` / `folder_path` 都有索引，
//      **只有 `file_name` 与 `file_size` 没有** ⇒ 退化成 `idx_photos_root`
//      + `USE TEMP B-TREE FOR ORDER BY`，真库实测 **39,990 ms**。
//      夹具（200,000 行）上补索引后 54.5 ms → **0.5 ms**，临时排序消失。
//   ② `idx_photos_root_size (root_id, file_size)` —— 同上，另一条排序键。
//
//   ③ `idx_photos_dup_hash_full (file_hash, file_size)` 部分索引 —— 查重。
//      现状走 `idx_photos_file_hash (file_hash)`，但查询还要 `file_size`（求和）与
//      `file_type`（谓词），两列都不在索引里 ⇒ **165 万次回表**（每行带 7,614 字节的内联
//      BLOB，回表极贵）。真库实测 **174,281 ms，而结果只有 1 个重复组**。
//      🔴 谓词必须与 `db-heavy-read.js#sqlHasFileHashExpr` + `sqlDupImageTypeExpr`
//      **逐字相同** —— SQLite 的部分索引匹配是**逐字**的，逻辑等价不算数。
//      改了那两处就必须同步改这里。（这里复用 Phase 1 的 `imgPred`，它已与
//      `sqlDupImageTypeExpr` 一致。）
//      ⚠️ 与既有 `idx_photos_dup_hash_pending ((id) + 互补谓词)` 正好成对。
//
//   ④ `idx_photos_date_day (date(date_taken), date_taken)` —— 日期视图（全库）。
//      `getDateGroups` 是 `GROUP BY date(date_taken)`：**表达式分组**让索引序对不上，
//      只能 `USE TEMP B-TREE FOR GROUP BY`。真库实测全库 **3,086.9 ms**（热 512.4 ms）。
//
//   ⑤ `idx_photos_root_date_day (root_id, date(date_taken)) WHERE date_taken IS NOT NULL`
//      —— 日期视图（单根）。**形态与 ④ 刻意不同**：夹具上逐个试过五种 DDL
//      （300,000 行、每行 7,600 字节 BLOB，复刻真库的溢出页链）：
//        · 裸 `date(date_taken)`：**反而更慢**（91.9 → 1,355 ms）—— 因为
//          `WHERE date_taken IS NOT NULL` 没有索引可依 ⇒ 每行回表；
//        · `(date(date_taken), date_taken)`：全库 18.9 ms COVERING ✅ / 单根 475.6 ms；
//        · `(root_id, date(date_taken)) WHERE date_taken IS NOT NULL`：单根 26.5 ms ✅。
//      ⇒ 两条**互补、不能互相顶替**：④ 管全库，⑤ 管单根。
//
// ⚠️ 建索引的代价（为什么必须留在这个 worker 里、不许进启动路径）：五条都要
//    **整表读一遍 + 排序**，会长时间独占写库闸门。体积按真库 165 万行外推合计约 250 MB
//    （`file_name` 最长，单条 ~60 MB），另需临时排序空间。
//    🔴 但这一批**不需要穿缩略图溢出页链** —— 用到的列 `root_id` 1 / `file_name` 3 /
//       `file_size` 5 / `file_type` 6 / `date_taken` 9 全部排在 `thumbnail`（cid 11）
//       **之前**，只读每行前段。
//       （对比：`dhash` 是 cid 29、在 BLOB 之后 ⇒ 「查找相似图片」那条候选索引
//        **刻意没做**：它的回表代价与收益都还没在真库上量过，不拿没量过的东西上生产。）
//
// ⚠️ `IF NOT EXISTS` ⇒ 只在第一次真正建；之后每次启动都是空操作（每条一句 sqlite_master
//    查询）。
// ⚠️ 为什么不像 `db-heavy-read.js` 的聚合计数那样用 `INDEXED BY` 钉住：这一批都是
//    **规划器自己就会发现更优**的形态（覆盖 / 免排序）。钉住反而引入「索引还没建出来时
//    `INDEXED BY` 直接报 no query solution」的失败模式。夹具上把全工程查询逐条对照过
//    反向影响（新增这五条后只有「全库 COUNT(*)」换了一条同样是 COVERING 的索引，无害）。
// ⚠️ 同样**逐条独立 try**：五条里任何一条失败（磁盘满 / 谓词笔误）都不该影响其余四条，
//    且失败原因要能被定位到**具体哪一条**。
// 🔴 清单本体在 `src/main/deferred-indexes.js`（**唯一真相源**），不在此处。
//    原因：那边能提供**完整、可直接 exec 的 DDL**（含部分索引的 `WHERE`，而它是拼接出来的），
//    `scripts/read-latency-regression.js` 要照着它在夹具上建索引、断言执行计划真的翻转。
//    留在这里的话回归只能「手抄一份等价 DDL」，而 SQLite 的部分索引匹配是逐字的
//    ⇒ 抄错一个字符就静默失效，回归也守不住。
var phase5List = deferredIndexes.PHASE5_INDEXES;
results.phase5 = {};
for (var p5 = 0; p5 < phase5List.length; p5++) {
  var entry5 = phase5List[p5];
  results.phase5[entry5.name] = createIndexReporting(
    entry5.name,
    entry5.sql,
    // 只有 DDL 里烤了 `EXIF_SCHEMA_VERSION` 的那条会带这个标记（见 `deferred-indexes.js` ⑦）
    entry5.rebuildOnChange === true,
  );
}

worker_threads.parentPort.postMessage(results);

db.close();
process.exit(0);
