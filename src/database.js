const logger = require('./main/logger');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
// 拍摄参数的内容列清单只有一份（`src/main/exif-meta.js`）：那边负责「字段 ↔ 列」的映射，
// 这边用它派生「文件内容变了要连带置空哪些列」。两边各抄一份 = 加了列忘了清 = 脏数据。
const {
  EXIF_METADATA_COLUMNS,
  EXIF_FIELD_SPECS,
  EXIF_COLUMN_TYPES,
  EXIF_SCHEMA_VERSION,
} = require('./main/exif-meta');
// `getPhotos` 的 total 记忆化（住在 worker 进程里，桌面端与网页端共用同一份）。
const photosTotalCache = require('./photos-total-cache');
// 「媒体档索引 hint」与「伴生视频排除条件」的唯一真相源（谓词、索引名都在那边）。
// 🔴 这里**只消费**、不许自己拼索引名或谓词：部分索引的匹配是**逐字**的，抄一份就等着静默失效。
//    依赖方向是单向的（`db-heavy-read` 只 require `stats-agg-cache` / `path`，不 require 本文件），
//    所以放在模块顶部是安全的、没有循环 require。
const heavy = require('./db-heavy-read');

/**
 * 「文件名包含」那条路钉的索引名（DDL 在本文件的 `createCoreSchema`）。
 *
 * 写成常量是因为它同时出现在两处：DDL 与 `searchPhotos({ nameOnly })` 的 `INDEXED BY`。
 * 🔴 `INDEXED BY` 指向**不存在**的索引是直接抛 `no such index`（不是静默降级），
 *    所以加 hint 前一律过 `heavy.hasIndex()` 闸门 —— 夹具/半建成库上少一条索引不该让
 *    「搜文件名」整条功能报错。这条纪律与 `db-heavy-read#mediaCountIndexHint` 同源。
 */
const NAME_LIKE_INDEX = 'idx_photos_name';

/**
 * 把用户输入变成 LIKE **字面量**：`%` / `_` / `\` 一律当普通字符（配 `ESCAPE '\'` 使用）。
 *
 * 不转义的话「搜 50%」等于「搜 50 + 任意后缀」，而 Windows 路径里到处是 `\` —— 一半的
 * 关键词搜索会静默答非所问。**唯一真相源**：`searchFolders` 与 `searchPhotos` 的
 * `nameOnly` 分支都从这里取，各写一份必然漂移。
 *
 * ⚠️ 调用方若还要做「分隔符归一」（`/` → `\`），**必须归一在前、转义在后** ——
 *    归一化插进去的那个 `\` 自己就是转义符，顺序反了会被这一步吃掉。
 */
function escapeLikeLiteral(value) {
  return String(value == null ? '' : value).replace(/[\\%_]/g, function (ch) {
    return '\\' + ch;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 组织元数据（评分 / 标记 / 用户标签）的取值域与归一 —— 2026-10-09
//
// 🔴 **实现在 `./main/org-meta-filter.js`**，这里只是取回来用。
//    理由：同一份判据还要被 `db-heavy-read.js`（读 Worker 的执行体）用到，而那个模块
//    **不能** require 本文件（本文件反过来 require 它，成环）。所以判据住在叶子模块，
//    两边都从那里取 —— 与 `photo-list-columns.js` 同一种结构。
//    **别把归一函数挪回本文件**：那等于把那条循环 require 又打开一次，而循环 require
//    的症状是「有时拿得到、有时是空对象」，取决于谁先被加载。这不是理论风险：
//    `database.js#getDatePhotos` 就是委托给 `db-heavy-read.js` 的。
//
//    ⚠️ 老库上「列加没加」与「表建没建」是两件事：加列在 `ensurePhotosOrgMetaColumns()`，
//    建表在 `ensureOrgTagSchema()`，两个都在 `init()` 里被无条件调用。
// ─────────────────────────────────────────────────────────────────────────────
const {
  RATING_MIN,
  RATING_MAX,
  FLAG_VALUES,
  normalizeRating,
  normalizeFlag,
  normalizeTagName,
  normalizeTagDisplayName,
  pushOrgMetaConditions,
  hasOrgMetaFilter,
} = require('./main/org-meta-filter');
// 取值域常量在本文件里没有直接引用点（写入走上面两个归一函数、筛选走
// `pushOrgMetaConditions`），留着 `void` 是为了让「唯一真相源的入口就在这个文件里」
// 这件事看得见 —— 读到 `normalizeFlag()` 时不必先跳去别处才知道取值域有几个值。
void RATING_MIN;
void RATING_MAX;
void FLAG_VALUES;

// 缩略图编码格式的白名单与 MIME 映射**只有一份**，在 `./main/thumb-format`：
// 写入端收口归一化（脏字符串会让迁移判据 `thumb_format <> 'webp'` 永远为真），
// 服务端按同一份表把 `thumb_format` 翻成响应头。各抄一份 = 迟早出现
// 「字节是 WebP、头写着 JPEG」这种不报错、只是不解码的静默失效。
const { normalizeThumbFormat } = require('./main/thumb-format');

// 「缩略图全量重跑」的队列表 / 取批 SQL / 规格谓词**只有一份**，在 `./main/thumb-regen-queue`：
// 登记、取批、计数三处如果各写一份谓词，就会出现「登记按新口径、计数按旧口径」——
// 两个数谁也不等于谁，而且都不报错（见该模块头部的约定）。
const thumbRegenQueue = require('./main/thumb-regen-queue');
// 「按 id 列表过滤/删除」的唯一安全形状（`json_each` 单参数，不展开 `?,?,…`）。
const { toIdListJson } = require('./main/sql-id-list');
// 图片「列表行」的列清单**只有一份**，在 `./main/photo-list-columns`：
// 15 处 SQL 各抄一份的做法加一列就漏一处，而漏掉的症状是静默的（字段在 SQL 那层丢掉 →
// JS 侧 undefined → 消费端回落硬编码）。`thumb_size` / `thumb_format` 正是被漏掉过的那两列，
// 而浏览层的缓存键需要它们（见该模块头部）。
const {
  photoListColumns,
  folderCoverColumns,
  folderCoverRow,
} = require('./main/photo-list-columns');

/**
 * 连接级 PRAGMA 的唯一真相源（`cache_size` / `mmap_size`）。
 *
 * 🔴 这两个值同时作用于**两条连接**，必须同源：
 *   ① 主进程的写连接 —— 由 `applyDeferredCachePragma()` / `applyDeferredMmapPragma()` 应用
 *      （刻意分步、首窗后 250ms，避免单次 PRAGMA 卡住主线程）；
 *   ② 读池 worker 的只读连接 —— `src/workers/db-read-worker.js#openDb()`。
 *
 * 为什么读池那条更要紧：**最贵的查询全在它手上**。它过去一个都没设 ⇒ 吃 SQLite 默认值
 * （cache 2 MB、mmap 关闭），而它跑的是 `getFolderTree` 这种「91 万行回表 + MIN/MAX 聚合」。
 * 真库（1,656,580 行 / 14.5 GB）实测：`getFolderTree` 单根 >4 分钟未返回；回表聚合几乎全靠
 * OS page cache 兜底，而 14.5 GB 的库不可能全缓存。
 *
 * ⇒ 数值只许在**这里**改一次。worker 那边引用常量（`PhotoDatabase.DB_CACHE_SIZE_KB`），
 *   各抄一份数字 = 将来只改一处，另一条连接静默变慢且不报错。
 */
const DB_CACHE_SIZE_KB = -131072; // 负值 = KB ⇒ -131072 KB = 128 MB
const DB_MMAP_SIZE_BYTES = 1073741824; // 1 GB

/**
 * 搜图取一页时，从「FTS 驱动」切换到「日期索引序」的**命中数**门槛。
 *
 * 🔴 这个数是**真库上标定**出来的（`.workbuddy/tmp/sql-search-tuning.log`，
 *    9 个词从 544,235 命中一直铺到 0 命中），不是拍的 —— 而且**实测推翻了我最初的保守判断**：
 *
 *     | 命中数 | FTS 驱动 | 索引序 | 赢家 |
 *     | ---: | ---: | ---: | --- |
 *     | 544,235（`IMG`） | 29,379 ms | **151 ms** | 索引序 195× |
 *     | 224,491（`2024`） | 6,059 ms | **63 ms** | 索引序 97× |
 *     | 203,934（`2025`） | 1,280 ms | **58 ms** | 索引序 22× |
 *     | 51,298（`DSC`） | **56 ms** | 89 ms | FTS 驱动 1.6× |
 *     | 16,590（`DSC0`） | **22 ms** | 65 ms | FTS 驱动 2.9× |
 *     | 0（不存在的词） | **0.3 ms** | 135 ms | FTS 驱动 450× |
 *
 *    ⇒ 交叉点落在 **51,298 与 203,934 之间**。
 *    ⇒ 两侧代价**极度不对称**：FTS 驱动的耗时随命中数**超线性**涨（51k→204k 只多了 4 倍命中，
 *      耗时却涨了 23 倍：56 → 1,280 ms），而索引序近似**恒定**（58~89 ms，冷读最坏 184 ms）。
 *      所以「阈值取错」的代价一边是几十毫秒、另一边是**几十秒**。
 *    ⇒ 取 **100,000**：比实测交叉点略高，宁可让中等命中数多花 30~300 ms，
 *      也绝不让大命中数掉进秒级。搜「IMG」这类相机通用前缀（本机 544,235 命中）是最常见的
 *      搜法，它必须走索引序 —— 195× 的收益就在这一档。
 *
 * ⚠️ 别把它想成「精确的交叉点」：交叉点会随磁盘状态、页缓存、库规模漂移，
 *    这里要的只是「站在安全的一侧」。
 *
 * @type {number}
 */
const SEARCH_INDEX_ORDER_MIN_HITS = 100000;
/**
 * 索引序用的索引名。它在 `createCoreSchema` 里建（建库时就有，不是 `deferred-index-worker`
 * 那批运行期索引），但仍走 `hasIndex()` 判一遍 —— `INDEXED BY` 指向不存在的索引是
 * **直接抛 `no query solution`**，不是变慢。
 */
const SEARCH_INDEX_ORDER_INDEX = 'idx_photos_date';

/**
 * 给**只读**连接套上同一套连接级 PRAGMA。
 *
 * 只读连接不写库文件，`cache_size` / `mmap_size` 纯粹是本地读缓存 —— 多占内存、不占锁，
 * 所以不进 `dbWriteQueue`（那会把一把它根本不需要的锁占住）。
 *
 * @param {import('better-sqlite3').Database} conn
 */
function applyReadConnectionPragmas(conn) {
  conn.pragma('busy_timeout = 8000');
  conn.pragma('cache_size = ' + DB_CACHE_SIZE_KB);
  conn.pragma('mmap_size = ' + DB_MMAP_SIZE_BYTES);
}

/**
 * 扫描收尾阶段「按 id 区间分批」的批大小。
 *
 * 🔴 这不是性能调优参数，是**看门狗契约**的一部分：`scan-worker` 主进程侧有一条
 * 「120 秒收不到任何消息就认定线程卡死并 `terminate()`」的看门狗
 * （`main.js#runFolderScanInWorker`）。worker 是单线程，同步 SQL 期间连 300ms 一次的
 * progress 心跳都发不出去，所以**任何一段同步工作都不能超过看门狗阈值**。
 * 真库（1,656,580 行 / 13.3 GB）实测：`K:\COS` 一根 912,222 行，一次性
 * `SELECT id, file_path … WHERE root_id = ?` 的 `.all()` 单次同步 57,367 ms、逐行比对
 * 13,703 ms；拆成 20,000 行一批后总耗时 30,990 ms、**单批最大 1,433 ms**。
 */
var SCAN_TAIL_BATCH_ROWS = 20000;

/** 分批之间的让出点：必须是**宏任务**让出（`setImmediate`），微任务让不出心跳。 */
function yieldToEventLoop() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

/**
 * 扫描写入的图片列清单 —— `getInsertStmt()`（新增）与 `getUpdateFileFactsStmt()`
 * （同路径文件内容变更）**共用同一份顺序**。
 *
 * 🔴 这是一份**单一真相源**：两条语句的参数顺序必须逐位一致，散着写两份字符串一定会漂移，
 * 而漂移的症状是**静默串列**（比如把 `date_modified` 写进 `date_taken`），不报错、不抛异常。
 * `scanner.js#processFile` 只构造一次参数数组，UPDATE 走的是同一数组去掉 `file_path` 那一项
 * （`file_path` 在 UPDATE 里只作 `WHERE`，不参与 `SET`），顺序由本常量保证。
 *
 * ⚠️ `file_path` 在第 4 位（下标 3）。`scanner.js` 依赖这个下标做 `splice(3, 1)`，
 * 挪动它必须同步改那边 —— 那里有对应的断言守着。
 */
var SCAN_WRITE_COLUMNS = [
  'root_id',
  'folder_path',
  'file_name',
  'file_path',
  'file_size',
  'file_type',
  'width',
  'height',
  'date_taken',
  'date_modified',
  'thumbnail',
  'has_thumbnail',
  'thumb_size',
  'thumb_format',
  'camera_make',
  'camera_model',
  'lens_model',
  'focal_length',
  'aperture',
  'iso_speed',
  'shutter_speed',
  'gps_latitude',
  'gps_longitude',
];

/**
 * 「同一个路径的文件内容变了」时，必须**额外置空**的派生列（本次扫描产不出来的那些）。
 *
 * 🔴 判定「过期」的**唯一**位置就在这里（见 CONTRACTS §P2-2）：后台任务的候选谓词保持简单，
 * 不自己判 mtime/size。
 *
 * 为什么只有两组：
 * - 缩略图四列（`thumbnail` / `has_thumbnail` / `thumb_size` / `thumb_format`）**不在这里** ——
 *   它们由 `SET` 子句按本次扫描的结果直接覆盖。扫描期不生成缩略图时
 *   （`scanner.js#GENERATE_THUMBNAILS_DURING_SCAN === false`）写的就是 0 / `''`（未知），
 *   旧缩略图自然失效；生成过时写的就是新图。两条路都不会留下旧值。
 * - `dhash*` 与 `file_hash` / `hash_*` **必须在这里**置空：它们由别的后台任务
 *   （dHash 回填 / 查重指纹）产出，扫描根本不碰这两组列，不主动清就是**脏数据**——
 *   文件换过了指纹却还是旧的，会报出早已不存在的重复对。
 * - 拍摄参数组（`camera_make` … `gps_longitude` + `exif_date_taken`）**同理必须在这里**：
 *   它们由缩略图补全任务顺带从文件头读出来，扫描同样不产出。不清就是「换了相机拍的新文件
 *   还挂着旧相机的型号」，以及「换过的文件仍显示旧文件的拍摄时间」。
 *   连带 `exif_mtime`（「已检查」标记）一起清 —— 它是这组列**唯一的**失效开关。
 */
var SCAN_INVALIDATED_ON_CONTENT_CHANGE = [
  'dhash = NULL',
  'dhash_mtime = NULL',
  'dhash_size = NULL',
  'file_hash = NULL',
  'hash_mtime = NULL',
  'hash_size = NULL',
  'exif_mtime = NULL',
  // 版本列与标记列同生共死：内容变了就该按**当前口径**重读一遍，而不是当作「已经看过 v2」。
  'exif_ver = NULL',
].concat(
  // 拍摄参数的内容列：清单从 `exif-meta.js` 派生，别在这里再抄一遍列名
  EXIF_METADATA_COLUMNS.map(function (col) {
    return col + ' = NULL';
  }),
);

/** `coerceExifValue` 认定为数值的字段类型 */
var EXIF_NUMERIC_TYPES = { int: 1, number: 1, gpsAltitude: 1, dmsLat: 1, dmsLon: 1 };

/**
 * 把 `extractExifFields()` 的值按字段类型**再归一化一次**再绑进 SQLite。
 *
 * 🔴 为什么不能直接绑：better-sqlite3 对 `undefined`、数组、Buffer 会**抛**，
 *    而这条语句跑在补全任务的热路径上（每张图片一次），抛出会被上层的 `try/catch` 吞掉 ⇒
 *    症状是「批量回填静默零写入」，没有日志、也不中断任务。
 *    这里对非文本类型拿到数组/Buffer 一律放弃该字段（宁可空着，也不写垃圾或炸掉整行）。
 */
function coerceExifValue(v, type) {
  if (v === undefined || v === null || v === '') return null;
  if (EXIF_NUMERIC_TYPES[type]) {
    var n = Number(v);
    if (!isFinite(n)) return null;
    return type === 'int' ? Math.round(n) : n;
  }
  if (Array.isArray(v) || Buffer.isBuffer(v)) return null;
  return String(v);
}

class PhotoDatabase {
  constructor(dbPath) {
    /** 主库文件路径（用于人物聚类快照库 ATTACH 等） */
    this._dbFilePath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 8000');
    this.db.pragma('foreign_keys = ON');
    /** 大缓存与 mmap 分步应用，避免单次 PRAGMA 长时间卡住主线程 */
    this._deferredCacheApplied = false;
    this._deferredMmapApplied = false;
    /** file_hash / hash_* 列：首次重复哈希时再迁移 */
    this._duplicateHashSchemaDone = false;
    /** `updatePhotoExif` 的预编译语句缓存（60 个占位符，热路径上每次 prepare 太贵） */
    this._exifUpdateStmt = null;
    /** 根目录聚合计数缓存表（root_folder_stats_cache） */
    this._rootStatsCacheSchemaDone = false;
    /** 聚合/重复比对辅助索引：由 `src/workers/deferred-index-worker.js` 在首窗后建，主进程不碰（见该文件头注释） */
    /**
     * 缩略图缺失索引 + 数据修复：首窗后再建，避免大库启动阶段长时间阻塞主线程。
     * 存 Promise 而不是布尔：调用方靠它在 worker 退出后把「谁在写库」注册进串行闸门。
     */
    this._deferredThumbnailFixPromise = null;
    /** Intl.Collator 首次排序再创建 */
    this.fileNameNaturalCollator = null;
    this.init();
  }

  applyDeferredCachePragma() {
    if (this._deferredCacheApplied) return;
    this._deferredCacheApplied = true;
    try {
      this.db.pragma('cache_size = ' + DB_CACHE_SIZE_KB);
    } catch (e) {
      void e;
    }
  }

  applyDeferredMmapPragma() {
    if (this._deferredMmapApplied) return;
    this._deferredMmapApplied = true;
    try {
      this.db.pragma('mmap_size = ' + DB_MMAP_SIZE_BYTES);
    } catch (e) {
      void e;
    }
  }

  /** 一次应用缓存 + mmap（兼容旧调用） */
  applyDeferredIoPragmas() {
    this.applyDeferredCachePragma();
    this.applyDeferredMmapPragma();
  }

  // ⚠️ 这里曾经有一组「延迟索引」的主线程同步版本：`applyDeferredPhotoIndexes()` 以及它调用的
  // `ensurePhotosRootFolderCompositeIndex()` / `ensurePhotosAggPartialIndexes()` /
  // `ensurePhotosDupHashPendingIndex()`。它们**一个调用点都没有**，SQL 却和真正在跑的
  // `src/workers/deferred-index-worker.js` 逐字重复 —— 同一批索引两个真相源，改一处必漏另一处。
  // 已于 2026-09-29 删除。启动期那批 `CREATE INDEX` / `ALTER TABLE` 的**唯一定义处**
  // 就是那个 worker（由 `main.js` 经 `db-write-queue` 以 `deferred-index` 名义入队）。
  // 要加索引 / 加列，改 worker；不要再在主线程加一份同步版本 —— 那等于在启动路径上拿主进程
  // 跑几次大表 CREATE INDEX 并长时间独占写锁（`maintenance-regression` 的静态契约会拦住它）。
  // ⚠️ 刻意**不写条数**：以前这里写「7 个 `CREATE INDEX`」，而 worker 里实际只有 6 条 ——
  //    散文里的数字没人校，必然漂。要看规模去看 worker。

  /**
   * 缩略图补全加速索引 + has_thumbnail 数据修复；在 Worker 线程中执行，避免阻塞主线程。
   *
   * 返回的 Promise 在 **worker 退出之后**才 resolve（不是消息到达时）——连接还开着就等于
   * 还占着库，调用方要拿它把这段时间登记进 `db-write-queue`，否则维护 worker 会在它跑到
   * 一半时点火，等满 `busy_timeout = 8000` 撞 `database is locked`（线上就这么出的）。
   * 重复调用返回同一个 Promise，不会起第二个 worker。
   */
  applyDeferredThumbnailFix() {
    if (this._deferredThumbnailFixPromise) return this._deferredThumbnailFixPromise;
    var dbPath = this._dbFilePath;
    var path = require('path');
    var Worker = require('worker_threads').Worker;
    var self = this;
    this._deferredThumbnailFixPromise = new Promise(function (resolve) {
      var worker = new Worker(path.join(__dirname, 'workers', 'thumbnail-fix-worker.js'), {
        workerData: { dbPath: dbPath },
      });
      var report = null;
      worker.on('message', function (msg) {
        report = msg;
      });
      worker.on('error', function (e) {
        report = { failed: true, error: e && e.message ? e.message : String(e) };
      });
      worker.on('exit', function (code) {
        // No report at all = the worker died before it could say anything (e.g. OOM).
        self._deferredThumbnailFixReport = report || {
          failed: true,
          error: 'thumbnail-fix worker exited: ' + code,
        };
        resolve(self._deferredThumbnailFixReport);
      });
    });
    return this._deferredThumbnailFixPromise;
  }

  getNaturalCollator() {
    if (!this.fileNameNaturalCollator) {
      this.fileNameNaturalCollator = new Intl.Collator('zh-CN', {
        numeric: true,
        sensitivity: 'base',
      });
    }
    return this.fileNameNaturalCollator;
  }

  applyNaturalNameTieSort(rows, sortBy, sortOrder) {
    if (!Array.isArray(rows) || rows.length <= 1) return rows;
    if (sortBy !== 'date_taken' && sortBy !== 'date_modified') return rows;
    var dir = String(sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    var collator = this.getNaturalCollator();
    rows.sort(function (a, b) {
      var av = a && a[sortBy] != null ? String(a[sortBy]) : '';
      var bv = b && b[sortBy] != null ? String(b[sortBy]) : '';
      if (av !== bv) {
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        return dir === 'ASC' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      var an = a && a.file_name != null ? String(a.file_name) : '';
      var bn = b && b.file_name != null ? String(b.file_name) : '';
      var nameCmp = collator.compare(an, bn);
      if (nameCmp !== 0) return nameCmp;
      return Number((a && a.id) || 0) - Number((b && b.id) || 0);
    });
    return rows;
  }

  /**
   * 浏览工具栏「仅图片 / 仅视频」：与 _buildPreviewScopeWhere、getRootFolders 使用同一套扩展名集合。
   * @param {string[]} conditions SQL 片段数组，将 push 一条 file_type 条件（若 mediaType 为 all 则不变）
   */
  /** 与封面选取、筛选共用：视为「图片侧」的扩展名（非下列视频扩展） */
  _sqlFileTypeIsImageExpr() {
    return "lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  }

  /** 视频扩展集合（与 _sqlFileTypeIsImageExpr 互斥） */
  _sqlFileTypeIsVideoExpr() {
    return "lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  }

  /**
   * 「这行是 Live Photo 的**伴生视频**」的谓词。
   *
   * 🔴 全项目只允许这一份：桌面端浏览列表（`_pushMediaTypeCondition`）、预览作用域
   *    （`_buildPreviewScopeWhere`）、根目录统计（`root_folder_stats_cache.video_count`）
   *    三处必须共用。各写一份 = 漂移 = 某一端「总数说 12 个视频、列表只列出 9 个」
   *    这种没人报的 bug。
   *
   * ⚠️ 只写 `live_still_id > 0`，**不要**包 `COALESCE(live_still_id, 0) > 0`：
   *    NULL 与 `> 0` 比较在 SQL 里得 NULL（不匹配），而那个语义正好是
   *    「还没探查过 ⇒ 先当普通视频看待」，是我们想要的。包上 COALESCE 表面上
   *    结果一样，却会掩盖「尚未探查」这个状态 —— 而
   *    `SELECT COUNT(*) FROM photos WHERE live_still_id IS NULL` 是排查
   *    「配对任务到底跑没跑」的唯一读数。
   */
  _sqlLiveStillIsMotionExpr() {
    return 'live_still_id > 0';
  }

  /**
   * `_sqlLiveStillIsMotionExpr()` 的**取反**。
   *
   * 🔴 必须单独有一个方法、**不能**写成 `'NOT (' + _sqlLiveStillIsMotionExpr() + ')'`：
   *    SQL 是三值逻辑，`NOT (NULL > 0)` 求值为 **NULL**（不是 TRUE）⇒ 谓词不匹配。
   *    而 `live_still_id` 为 NULL 的行是**绝大多数**（全库只有「探查过的 mov」才非 NULL：
   *    图片、png、mp4、未探查的 mov 全是 NULL）。
   *    症状在「所有媒体」档最明显：图片会**整批消失**，只剩视频 —— 而「视频」档
   *    看起来完全正常（那个档本来就只要视频）。2026-10-06 的端到端夹具实测抓到了它。
   *    ⇒ 取反一律用 `COALESCE(live_still_id, 0) = 0`。
   */
  _sqlNotLiveStillIsMotionExpr() {
    return 'COALESCE(live_still_id, 0) = 0';
  }

  /**
   * 「补全任务待处理」的统一谓词 —— 缩略图 / dHash / 原图尺寸 / 拍摄参数四者任一缺失即命中。
   *
   * 🔴 必须与 `src/main.js#runRowsWithThumbConcurrency` 的处理逻辑**同源**：那个任务在拿到候选行后
   * 除了生成缩略图与 dHash，还会读一次 sharp metadata 并回填 `width` / `height`
   * （见 `updatePhotoDimensions`）**以及拍摄参数**（见 `updatePhotoExif`），所以「缺尺寸」
   * 与「没看过 EXIF」都是它的职责范围。
   * ⚠️ 2026-10-05 之前这里指向的 `src/main/thumbnail-backfill.js` 是一个**从未被运行时加载**的
   * 孤儿模块 —— 实现只落在它里面，于是这条谓词与活代码长期不同源：候选集永不收敛、每轮补全
   * 走遍全库。该逻辑已移植进 `main.js`，孤儿文件已删除（守护 `module-reachability-regression`）。
   * 只改一边的症状是**静默空转**：进度条分母变成 1200 万，任务却几乎不动，或者反过来
   * 任务在补尺寸但计数压根不认。
   *
   * ⚠️ `width IS NULL OR width = 0` **两个条件都要写**：两阶段导入的存量库里尺寸缺失
   *    存的是 `0` 而不是 `NULL`，只判 `IS NULL` 一张都命中不了。
   * ⚠️ 视频的 dHash 恒为 `NULL`（视频不做感知哈希），所以视频会长期留在候选集里；
   *    但它已有缩略图时 `processOne` 会立刻跳过，代价只是一次索引命中，可接受。
   */
  _sqlBackfillPendingExpr() {
    // 🔴 后四支必须被 `is_image` 门住。`processOne` 对**视频**既不读尺寸
    //    （`needSize = !isVideo && …`）、不算 dHash（`needDhash = !isVideo && …`），
    //    也不读拍摄参数（`needExif = !isVideo && …`），
    //    而「dHash 为空」「没看过 EXIF」的视频永远填不上 ⇒ 留在候选集里就是
    //    **每轮必然被取到、处理完又原样留在集合里的死行**。
    //    本机真实库（166 万行）实测：全部 **26,609** 个视频都缺 width/height，
    //    其中 **25,585** 个已有缩略图 ⇒ 纯空跑（每轮白烧约 256 个批次，而且
    //    「待补数」**永远不归零** —— `getMissingThumbnailCount()` 的收敛断言在带视频的库上不可满足）。
    //    视频真正欠的只有缩略图，由第一支（`_sqlNeedsThumbnailExpr()`）覆盖（实测 1,024 个）。
    //    ⚠️ 这一支**不能**一并挪进 `is_image` 里 —— 视频的缩略图是能生成的（ffmpeg / 占位图兜底），
    //       门进 `is_image` 就等于把 1,024 个视频的缩略图永远放弃。
    return (
      '(' +
      this._sqlNeedsThumbnailExpr() +
      ' OR (' +
      this._sqlFileTypeIsImageExpr() +
      ' AND (' +
      // 🔴 第二支的**每一项都要配自己那一路的失败标记**（2026-10-06 补）。
      //
      // 为什么：`thumb_fail_mtime` 只门住了**第一支**（缺缩略图），第二支一个都不认它。
      // 而「读不了的文件」正好 `width = 0` / `dhash = NULL` / `exif_mtime = NULL`
      // ⇒ 它们**从第一支漏进第二支**，照样留在候选集里 —— 每轮被取出、每轮重读一遍原文件，
      // 而且主分母（候选集规模）**永远归不了零**。
      // 本机实测（2026-10-06 15:10，真库）：已盖章失败的 10 行（9 个 18 MB 的 .CR2
      // + 1 个截断 JPEG）**10/10 命中第二支** ⇒ 每轮白读约 162 MB。
      //
      // 分工按「缺的那一项**靠什么**才能补上」：
      //   dHash 缺      ← 要**解码** ⇒ 失败标记 `thumb_fail_mtime`
      //   尺寸 / EXIF 缺 ← 只读**文件头** ⇒ 失败标记 `header_fail_mtime`
      // ⚠️ 三个子条件**不能**合并成一个 `AND`/`OR` 的粗判：一个文件可以「头读得出、解码读不出」
      //    （截断 JPEG：尺寸与 EXIF 已经补上了，只差 dHash）—— 那种行只该被 thumb 那一路门住，
      //    用 header 那一路去门它会把尺寸/EXIF 的重试一起关掉。
      // ⚠️ 视频不会走到这里：整个第二支仍被 `is_image` 门着。
      "((dhash IS NULL OR TRIM(dhash) = '') AND " +
      this._sqlFailMarkerRetryableExpr('thumb_fail_mtime') +
      ') OR ((width IS NULL OR width = 0) AND ' +
      this._sqlFailMarkerRetryableExpr('header_fail_mtime') +
      ') OR (' +
      this._sqlNeedsExifExpr() +
      ' AND ' +
      this._sqlFailMarkerRetryableExpr('header_fail_mtime') +
      '))))'
    );
  }

  /**
   * 「补全还有活可干」的**核心谓词**（只看「缺什么」，不看失败标记 / `date_modified`）。
   *
   * 🔴 它的**唯一消费者**是第二趟取批：`getPhotosMissingThumbnailsBefore()` 把它**逐字**当成
   *    一个**逻辑冗余**的合取项放进 WHERE，好让规划器能用上部分索引
   *    `idx_photos_backfill_pending`（索引的 WHERE 就是这一串）。
   *
   * 为什么必须冗余一份、而不是只建索引：SQLite 用部分索引的条件是「查询的 WHERE **蕴含**
   * 索引的 WHERE」。`_sqlBackfillPendingExpr()` 是个「四支 OR + 逐支 residual（失败标记 /
   * `date_modified`）」的形状，规划器证不出它蕴含本串（夹具实测：索引存在、WHERE 不动时
   * 计划**仍是** `SEARCH photos USING INTEGER PRIMARY KEY (rowid<?)`）。把本串当成一棵
   * **与索引 WHERE 完全相同**的子树显式合取进去，蕴含就退化成一次表达式树相等比较。
   *
   * ⚠️ 语义零变化的前提是 `_sqlBackfillPendingExpr() ⟹ 本串`。这条由
   *    `scripts/thumb-backfill-metadata-fetch-regression.js` 用活代码逐字断言
   *    （不是靠这段注释）—— 两边任一改动而没同步，加进 WHERE 就不再是冗余项，而是**改口径**。
   *
   * ⚠️ 实现（含「后三支被 `IMAGE_TYPE_PRED` 门住、第一支不许门」的理由）在
   *    `src/db-heavy-read.js#BACKFILL_PENDING_CORE_PRED` —— 那边是唯一真相源
   *    （`src/main/deferred-indexes.js` 的索引 DDL 也取同一份）。
   */
  _sqlBackfillPendingCoreExpr() {
    return heavy.BACKFILL_PENDING_CORE_PRED;
  }

  /**
   * 「这一行**还缺缩略图**，而且值得再试一次」的判据 —— 候选谓词的第一支。
   *
   * 🔴 为什么不直接写 `has_thumbnail = 0`（2026-10-06 修正）：
   *    那一支是**无条件**入选的，于是**读不了的文件**（Canon 旧式 RAW 的旧式 JPEG 压缩、
   *    被截断的 JPEG）永远停在里面 —— 每轮开局被取出、每轮白读一次盘（.CR2 单个 18 MB）、
   *    每轮失败，且**失败不留任何痕迹**。本机实测 10 行，而且正好是全库**最高** id
   *    （`G:\国模\依华_20140318_151P\4322.CR2`~`4330.CR2`），也就是任务每轮最先撞上的位置。
   *    ⇒ 每次启动都先白烧 160 MB 读取 + 10 次失败，而库里分不出「还没轮到」与「试过失败了」。
   *
   * 判据的语义（与 `exif_mtime` **刻意不同**，别照抄那一套）：
   *    `exif_mtime` 只回答「看过没」（二元），所以必须再配一个 `exif_ver` 管「看过第几版」。
   *    缩略图这边不需要版本号（规格变了是靠 `thumb_size`/`thumb_format` 另外判），
   *    需要的是**能自愈**：记下「失败当时该行是什么 date_modified」，文件被替换后
   *    `date_modified` 会变 ⇒ 下面的 `<>` 自动把这一行放回候选集，**不依赖用户重新扫描**。
   *    （这比 `hash_mtime` / `exif_mtime` 那套「靠扫描时置空派生列」更省一条链。）
   *
   * 自愈判据本身抽在 `_sqlFailMarkerRetryableExpr()` 里（两个失败标记列**共用一份实现**）。
   *
   * ⚠️ 不要指望它走 `idx_photos_hasThumb` 的覆盖索引：`thumb_fail_mtime` / `date_modified`
   *    都不在索引里，判定要回表。但回表次数 = 「倒序扫到的行数」而不是「全库缺缩略图的行数」
   *    —— `ORDER BY id DESC LIMIT n` 凑满 n 行就停，所以只要失败行是**少数**，代价可忽略。
   */
  _sqlNeedsThumbnailExpr() {
    return 'has_thumbnail = 0 AND ' + this._sqlFailMarkerRetryableExpr('thumb_fail_mtime');
  }

  /**
   * 「某个失败标记列说：这一行**还值得再试一次**」的通用判据。
   *
   * 语义 = 标记列记的是「**失败当时**该行的 `date_modified`」⇒ 文件被替换后日期一变，
   * `<>` 自动成立、把这一行放回候选集（**自愈，不依赖用户重新扫描**）。
   * 见 `markThumbFailed()` / `markHeaderFailed()` 的 JSDoc：那两个写入口都必须传**行当前的
   * `date_modified`**，绝不能传 `Date.now()`（时间戳只会前进、永远不可能相等 ⇒ 那行永远回不来）。
   *
   * ⚠️ NULL 必须**两侧都兜**：`date_modified` 在老数据上可能是 NULL，写成裸的
   *    `col <> date_modified` 会得到 NULL（当假处理）⇒ **那些行被永久排除**，
   *    而它们正是最需要补的老图片。用 `IFNULL(..., '')` 把「两边都空」判成**相等**。
   *    唯一的真牙是「盖章时有日期、之后 `date_modified` 被清成 NULL」——
   *    裸比较得 NULL（永久排除）vs 有 IFNULL 得真（回来重试）。
   *
   * 🔴 两个标记列**共用这一个实现**是刻意的：`thumb_fail_mtime`（解码这一路）与
   *    `header_fail_mtime`（文件头这一路）必须是同一条自愈规则。各写一份迟早漂开，
   *    而漂开的症状是「某一路的失败行永远回不来」——不报错、不写日志。
   *
   * @param {string} col 标记列名（`thumb_fail_mtime` / `header_fail_mtime`）
   */
  _sqlFailMarkerRetryableExpr(col) {
    return '(' + col + " IS NULL OR IFNULL(" + col + ", '') <> IFNULL(date_modified, ''))";
  }

  /**
   * 「拍摄参数还没读过（或读过的是旧口径）」的判据。
   *
   * 🔴 判**标记列**，不判内容列有没有值：截图 / 网图 / PNG 本来就没有 EXIF，
   *    用 `camera_make IS NULL` 判会让这几类图片永远留在候选集里 —— 每轮被取出来、
   *    读完文件头、写回一堆 null，却永远不算「已补」。见 `ensurePhotosExifColumn()`。
   *
   * 🔴 第二个判据 `exif_ver` 管「看过**第几版**」。`exif_mtime` 是**二元**标记（看过就再也不看），
   *    只靠它的话，扩一次字段会让**已经跑过的行永久缺新列** —— 不报错、不写日志，
   *    只是那些图片在面板上永远少几行。版本号在 `src/main/exif-meta.js#EXIF_SCHEMA_VERSION` 单点维护。
   */
  _sqlNeedsExifExpr() {
    return '(exif_mtime IS NULL OR IFNULL(exif_ver, 0) < ' + EXIF_SCHEMA_VERSION + ')';
  }

  /**
   * `_sqlNeedsExifExpr()` 的 **JS 孪生**：这一行**在本进程里**还要不要读一次文件头。
   *
   * 🔴 这不是「顺手多加一个函数」，而是补一个**静默数据缺失**的洞：
   *    `_sqlNeedsExifExpr()` 一旦加上版本判据，它就变成**两个列**的判据（`exif_mtime` + `exif_ver`），
   *    而 `processOne` 原来只判 `exif_mtime`。两者一漂开就出现这样一条死路 ——
   *      · 候选查询：`IFNULL(exif_ver, 0) < 2` 为真 ⇒ 这行**每轮都被取出来**；
   *      · `processOne`：`exif_mtime` 有值 ⇒ 判「不需要读」⇒ **跳过**；
   *      · 结果：行被原样写回，`exif_ver` 永远是 NULL ⇒ **永远补不上新扩出来的列**，
   *        而且候选集**永不收敛**（每轮启动都白取一遍）。
   *    本机真实库实测（2026-10-06 12:23）：旧口径跑过的 9,799 行整段命中候选谓词、
   *    却全部拿不到新列，`exif_ver` 一个都没写上 —— 正是这条死路。
   *
   * 🔴 判的这一组列必须与 `_sqlNeedsExifExpr()` **逐列相同**。守护
   *    `exif-backfill-regression` 会从那条 SQL 里机械抽出列名与这里比对，
   *    所以将来再加标记列时，只改 SQL 会被当场抓红。
   *
   * ⚠️ 调用方仍需自己判 `!isVideo`：视频本来就不读拍摄参数（见 `_sqlBackfillPendingExpr()` 的注释），
   *    这不是本函数该管的事 —— 它只回答「按标记列看，这行的拍摄参数是不是旧口径」。
   *
   * ⚠️ `row` 必须由 `getPhotosMissingThumbnailsBefore()` 取出来，它的 SELECT 列表**必须带**
   *    `exif_mtime` 与 `exif_ver`。少任何一列，这里就会把有值的行判成「没看过」或反之。
   */
  photoNeedsExif(row) {
    if (!row) return true;
    var seenAt = row.exif_mtime;
    if (seenAt === null || seenAt === undefined || String(seenAt).trim() === '') return true;
    return !(Number(row.exif_ver) >= EXIF_SCHEMA_VERSION);
  }

  /**
   * 「所有目录」与子目录封面共用：未筛选时优先首张图片，再按文件名、id；已筛选 image/video 时等价于按文件名、id。
   * 用于 WINDOW 的 ORDER BY 子句或 SELECT ... ORDER BY。
   */
  _folderCoverPickOrderBySql() {
    return (
      'CASE WHEN ' +
      this._sqlFileTypeIsImageExpr() +
      ' THEN 0 ELSE 1 END ASC, file_name ASC, id ASC'
    );
  }

  /**
   * 注入「媒体类型」条件（`all` / `image` / `video`）。
   *
   * 🔴 Live Photo 的伴生视频**不算一个独立的媒体项** —— 它依附于那张图片
   *    （iOS / Google Photos 的「所有图片」视图里，一张 Live Photo 只占一个位置）。
   *    所以 `all` 与 `video` 两档都要把它排除；`image` 档天然不涉及（伴生视频的扩展名是视频，
   *    永远落不到图片侧）。「看这段动态」的唯一入口是预览里的实况按钮
   *    （由图片行的 `live_motion_id` 驱动），不靠它在列表里露脸。
   *
   * ## `all` 档的排除条件必须**自适应**（2026-10-06 治本，**别退回直接写 COALESCE**）
   *
   * 曾经写成 `COALESCE(live_still_id, 0) = 0`，那是个**灾难**：`all` 是四个调用方里唯一
   * **没有别的限定条件**的档（`root_id` / `folder_path` / FTS 谓词全缺席），于是它被直接压在
   * 整张 `photos` 表上；而它匹配 **99.9999%** 的行 —— 真库实测分布：`live_still_id` 为 NULL
   * **1,652,026** 行、= 0 **4,553** 行、> 0 只有 **1** 行。`live_still_id` 又排在缩略图 BLOB
   * **之后**且**不在任何索引里** ⇒ 规划器只能放弃覆盖索引、逐行回表去读它：
   *
   *    | `SELECT COUNT(*) FROM photos …` | 结果 | 耗时 | 计划 |
   *    | --- | ---: | ---: | --- |
   *    | 无 WHERE | 1,656,580 | **478 ms** | `SCAN photos USING COVERING INDEX idx_photos_hasThumb` |
   *    | `WHERE COALESCE(live_still_id,0)=0` | 1,656,579 | **105,954 ms** | `SCAN photos`（回表） |
   *
   *    这一步挂在 `getPhotos()` 的**第一步**（COUNT 先算 totalPages，`photosTotalCache`
   *    首次必然未命中）⇒「所有文件」入口要等近两分钟才出结果，前端先超时 ⇒
   *    `loadPhotos` 的 catch 接管 ⇒ 界面上就是「图片加载失败」（2026-10-06 用户报告）。
   *    现象**只**出现在这一个档，三档差异正好解释得通：`image` 档早退不带谓词、
   *    `video` 档有部分索引 `idx_photos_agg_root_folder_video` 把它先筛到 2.6 万行再算。
   *
   * ## 治本写法：换谓词形状 + 让索引来兜
   *
   * 条件改成 `id NOT IN (SELECT id FROM photos WHERE live_still_id > 0)`
   * （由 `db-heavy-read.js#liveCompanionExcludeCondition` 提供，本文件**不自己拼**）：
   *  · 子查询被**部分索引** `idx_photos_live_companion`（`WHERE live_still_id > 0`，
   *    真库上只有 **1 个条目**、**1 页**）兜住 ⇒ 子查询本身微秒级；
   *  · 外层仍是 `SCAN photos USING COVERING INDEX …`（**不回表**）+ `CREATE BLOOM FILTER`。
   *  结果值与 `COALESCE` 写法**逐个相同**。`scripts/read-latency-regression.js` 钉住这一点。
   *
   * 🔴 **索引就绪之前一律不加**（`liveCompanionExcludeCondition` 返回 `null` ⇒ 这里 `push` 都不做）。
   *    这不是「先凑合」——实测过：**没有那条索引时，`NOT IN` 写法与 `COALESCE` 一样慢**
   *    （带内联 BLOB 的夹具上 231 ms vs 231 ms；索引就绪后 `NOT IN` 是 4 ms）。
   *    因为子查询自己会退化成 `SCAN photos` 回表。所以自适应闸门是**必需**的，不是优化：
   *    宁可多显示 1 行（那张伴生 MOV 露出来），也绝不回到 106 秒。
   *
   * @param {string[]} conditions 收集器（会被就地 push）
   * @param {string} [mediaType] `'all'` / `'image'` / `'video'`
   * @param {{ preserveLiveCompanion?: boolean }} [options]
   *    `preserveLiveCompanion: true` ⇒ `all` 档**刻意不排**伴生视频。目前只有一个调用方需要它
   *    （`searchPhotos`），理由写在那边的调用点上。
   */
  _pushMediaTypeCondition(conditions, mediaType, options) {
    var m = String(mediaType || 'all').toLowerCase();
    if (m === 'image') {
      conditions.push(this._sqlFileTypeIsImageExpr());
      return;
    }
    if (m === 'video') {
      conditions.push(this._sqlNotLiveStillIsMotionExpr());
      conditions.push(this._sqlFileTypeIsVideoExpr());
      return;
    }
    // `all`（含任何未知值）：索引就绪才加；未就绪时返回 null ⇒ 刻意不加。
    if (options && options.preserveLiveCompanion) return;
    var exclude = heavy.liveCompanionExcludeCondition(this.db);
    if (exclude) conditions.push(exclude);
  }

  /**
   * 把组织元数据（评分 / 标记 / 标签）三个筛选维度推进条件收集器。
   *
   * 🔴 实现在 `./main/org-meta-filter.js`（叶子模块），本方法只是把它挂到实例上 ——
   *    为的是与 `_pushMediaTypeCondition` 对称，好让 `main.js` / `db-heavy-read.js`
   *    这些「手上只有 db 对象」的地方能直接调 `db._pushOrgMetaConditions(...)`。
   *
   * ## 为什么是**共用一份**而不是各查询各写一份
   *
   * 用同一套判据的地方有六处：`getPhotos`（总览）、`getFolderPhotos`（目录页）、
   * `runGetDatePhotos`（日期页）、`searchPhotos`（搜图页）、`fetchTagNavPhotoRows`
   * （标签导航页）、`_buildPreviewScopeWhere`（预览作用域/邻图）。
   * 各写一份必然漂移，而漂移的症状是「列表筛出来的和预览翻页翻到的不是同一批图」——
   * 只在翻到页边界或按「上一张/下一张」时才看得出来，且完全不报错。
   *
   * ⚠️ 判据细节（`!= null` 而非 truthy、标签 AND 语义、`photos.id` 前缀）全部写在
   *    那个叶子模块的文件头注释里，改之前先读那里。契约见
   *    `docs/contracts/org-metadata.md`「筛选作用域」章。
   */
  _pushOrgMetaConditions(conditions, params, options) {
    pushOrgMetaConditions(conditions, params, options);
  }

  createCoreSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS root_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        added_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        folder_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT UNIQUE NOT NULL,
        file_size INTEGER DEFAULT 0,
        file_type TEXT DEFAULT '',
        width INTEGER DEFAULT 0,
        height INTEGER DEFAULT 0,
        date_taken TEXT,
        date_modified TEXT,
        thumbnail BLOB,
        has_thumbnail INTEGER DEFAULT 0,
        -- 缩略图规格：生成时的**目标档位**（最长边）与编码格式。
        -- 注意：0 / 空串 表示「本列引入之前的存量」，语义是**未知**，不是「没有缩略图」；
        -- 判断有没有缩略图一律看 has_thumbnail 列，不要看这两列。
        thumb_size INTEGER DEFAULT 0,
        thumb_format TEXT DEFAULT '',
        -- 缩略图生成**失败**的记账列（2026-10-06 新增）：记的是「尝试失败当时」该行的 date_modified。
        -- 为什么必须有：has_thumbnail = 0 恒为真，而**读不了的文件**（Canon 旧式 RAW、被截断的 JPEG）
        --   每轮被取出、每轮读一次盘、每轮失败 —— 永不收敛。本机实测：9 个 18 MB 的 .CR2 排在
        --   全库最高 id，任务每轮开局必然先撞上它们、必然白读 160 MB，且失败后**不留任何痕迹**，
        --   库里分不出「还没轮到」与「试过失败了」。
        -- 与 exif_mtime 的关键差别：EXIF 那套只判「看过没」，这里必须**能自愈** —— 文件被替换后
        --   date_modified 会变，_sqlNeedsThumbnailExpr() 里的 <> 自动把它放回候选集，
        --   不依赖用户重新扫描。见 database.js#_sqlNeedsThumbnailExpr()。
        -- 注意：0 / 空串 表示「本列引入之前的存量」，语义是**没失败过**；判断有没有缩略图仍看 has_thumbnail。
        thumb_fail_mtime TEXT,
        -- 「文件头都读不出来」的记账列（2026-10-06 新增，与 thumb_fail_mtime 分工见下）。
        -- 为什么不能只有 thumb_fail_mtime：那只门住了候选谓词的**第一支**（缺缩略图），
        --   而候选谓词的**第二支**（是图片 AND (dhash 缺 OR width 0 OR EXIF 待补)）判的是
        --   另一组列。读不了的文件正好 width=0 / dhash=NULL / exif_mtime=NULL ⇒ 第二支恒为真
        --   ⇒ 它们从第一支漏出来、照样留在候选集里，每轮被取出、每轮重读一遍原文件。
        --   本机实测：9 个 18 MB 的 .CR2 + 1 个截断 JPEG，10/10 命中第二支（约 162 MB/轮 白读），
        --   而且候选集规模（主分母）因此永远归不了零。
        -- 分工（两列各管自己那一路，别混）：
        --   thumb_fail_mtime  ← 只记「解码这一路失败」（缩略图 / dHash 都要解码）
        --   header_fail_mtime ← 只记「文件头读不出来」（原图尺寸 / 拍摄参数只读文件头）
        --   注意「解码失败但文件头读到了」是真实存在的一类（截断 JPEG）：它只盖 thumb_fail_mtime，
        --   尺寸与 EXIF 照样补得上 —— 这正是 bug B 的修复效果，别把它一起排除掉。
        -- 与 thumb_fail_mtime 完全同构：记「失败当时该行的 date_modified」⇒ 文件被替换后
        --   date_modified 一变就自动回到候选集（自愈，不依赖重新扫描）。
        header_fail_mtime TEXT,
        -- Live Photo 配对两列（2026-10-06 新增）。三态语义**别混**，见
        -- ensurePhotosLivePhotoColumns() 的长注释：
        --   live_still_id（**视频行**上）NULL = 还没探查过 / 0 = 探查过、不是伴生 / >0 = 伴生视频，值为图片 id
        --   live_motion_id（**图片行**上）0 = 无伴生视频（存量默认值）/ >0 = 有，值为 MOV 的 id
        live_still_id INTEGER,
        live_motion_id INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        -- 派生来源（2026-10-09 新增）：0 = 原始文件；>0 = 由该 id 派生（目前只有裁剪副本）。
        -- 为什么需要这一列：裁剪产物会作为一个**正常行**进 photos 表（用户要能在图库里看到它），
        --   而扫描器、统计口径、重复检测、AI 索引都会看见它 —— 没有来源标记时，
        --   「这张是哪来的」只能靠文件名猜；删原图时也无从判断要不要连带处理派生件。
        -- 语义与 live_motion_id 同构：0 表示「非派生」。迁移见 ensurePhotosDerivedColumn()。
        derived_from INTEGER DEFAULT 0,
        -- 组织元数据两列（2026-10-09 新增）。取值域与语义：
        --   rating：0 = 未评分 / 1-5 = 星级。刻意用 0 而不是 NULL 表示「未评分」
        --     （与 is_favorite 的 0/1 同风格，排序与筛选都不必处理 NULL 分支）。
        --   flag：三态 none / pick / reject，默认 none。
        -- 🔴 取消标记必须**幂等**（清标记不管当前是什么态都归 none），不许做成
        --    「再按一次同一个键 = 取消」的 toggle：冲片是盲操作，用户分不清
        --    「刚才那下按上了没有」，toggle 会误清已经标好的行。
        --    理由、快捷键取舍（左手区 Z/X/C）与完整契约见 docs/contracts/org-metadata.md。
        -- ⚠️ 老库由 ensurePhotosOrgMetaColumns() 补列（O(1)）；索引走 PHASE5_INDEXES
        --    在后台建 —— 这两列在表末尾，百万行库上建索引要整表回扫，几十秒起，
        --    绝不许进启动路径。
        rating INTEGER DEFAULT 0,
        flag TEXT DEFAULT 'none',
        camera_make TEXT,
        camera_model TEXT,
        lens_model TEXT,
        focal_length REAL,
        aperture REAL,
        iso_speed INTEGER,
        shutter_speed TEXT,
        gps_latitude REAL,
        gps_longitude REAL,
        -- 拍摄参数（EXIF）回填的「已检查」标记：记的是**读取当时**该行的 date_modified。
        -- 🔴 非 NULL = 这行已经试过读文件头 —— **不代表读到了 EXIF**（截图 / 网图 / PNG 本就没有）。
        --    候选谓词判的必须是这一列，不是「camera_make IS NULL」：后者会让本来就没有 EXIF
        --    的图片永远留在候选集里，任务永不收敛（与 dhash 对视频那类死行同一个坑）。
        exif_mtime TEXT,
        -- EXIF 里的**真实拍摄时间**。🔴 刻意与 date_taken 分成两列、且**不参与排序**：
        --    date_taken 现全库等于 date_modified（文件落盘时间），是排序默认列 + 日期分组
        --    + idx_photos_date 的唯一输入；而真实拍摄时间只有 ~23% 的图片取得到，
        --    覆盖过去会让时间线变成「23% 真 + 77% 原样」的混合口径（同一天拍的分落两处）。
        --    原委见 src/main/exif-meta.js 里 formatExifDate 上方的长注释。
        exif_date_taken TEXT,
        -- ⚠️ 上面只列了拍摄参数的**第一批**列。后来扩出来的那 48 列（方向 / 曝光补偿 / 测光 /
        --    闪光 / 白平衡 / 器材序列号 / 软件 / Windows 关键词 …）刻意**不写在这里**，
        --    统一由 ensurePhotosExifColumn() 从 src/main/exif-meta.js 的注册表派生并迁移 ——
        --    两处各抄一份 60 列的清单必然漂移。新建库也走 init() ⇒ 一样会被补齐。
        --    ⚠️ 本段在模板字符串里，注释中**不能出现反引号**（会当场截断 SQL）。
        FOREIGN KEY (root_id) REFERENCES root_folders(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_path);
      CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date_taken);
      CREATE INDEX IF NOT EXISTS idx_photos_date_mod ON photos(date_modified);
      CREATE INDEX IF NOT EXISTS idx_photos_root ON photos(root_id);
      CREATE INDEX IF NOT EXISTS idx_photos_root_date_mod ON photos(root_id, date_modified);
      CREATE INDEX IF NOT EXISTS idx_photos_root_folder ON photos(root_id, folder_path);
      CREATE INDEX IF NOT EXISTS ${NAME_LIKE_INDEX} ON photos(file_name);
      CREATE INDEX IF NOT EXISTS idx_photos_type ON photos(file_type);
      CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(is_favorite);
      CREATE INDEX IF NOT EXISTS idx_photos_hasThumb ON photos(has_thumbnail);
      -- ⚠️ 组织元数据两个筛选维度（rating / flag）的索引**刻意不在这里建**，尽管这里是
      --    新库的唯一入口 —— 也不在 ensurePhotosOrgMetaColumns() 里建。两个理由：
      --      ① 这两列是后加的，cid 排在 thumbnail（内联 BLOB）**之后**，建索引要整表回扫
      --         ⇒ 百万行库上几十秒到几分钟，且长时间独占写库闸门；
      --      ② scripts/maintenance-regression.js 有一条**显式登记清单**逐条断言
      --         「这条建索引语句只许出现在 deferred-index-worker.js 或
      --         main/deferred-indexes.js 里」，在别的 src/ 文件里出现就算红。
      --    所以它们登记在 src/main/deferred-indexes.js 的 PHASE5_INDEXES，由延迟索引
      --    worker 在首窗后台建（新库是空表，worker 一跑就是 O(1)）。见那个文件的开头。
      --    ⚠️ 本段在模板字符串里，注释中**不能出现反引号**（会当场截断 SQL）。

      -- ⚠️ 组织元数据的两张表（tags / photo_tags）**刻意不在这里建**，尽管这里是新库
      --    的唯一入口：老库走不到 createCoreSchema（init 只在表缺失时调它），
      --    所以 DDL 只许有一份、放在 ensureOrgTagSchema() 里由 init() 无条件调用。
      --    写两份的后果是「改一处忘另一处」，而症状是老库上 no such table（表没建出来）。
    `);
  }

  hasTable(tableName) {
    var row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(String(tableName || ''));
    return !!(row && row.name);
  }

  ensureCoreSchemaReady() {
    if (this.hasTable('root_folders') && this.hasTable('photos')) {
      return;
    }
    // 自愈：异常库或首次创建中断时，尝试重建核心表结构
    this.createCoreSchema();
    if (!this.hasTable('root_folders') || !this.hasTable('photos')) {
      throw new Error('core schema bootstrap failed: missing root_folders/photos');
    }
  }

  init() {
    if (!this.hasTable('root_folders') || !this.hasTable('photos')) {
      this.createCoreSchema();
    }
    this.ensureCoreSchemaReady();
    this.ensureRootFolderStatsCacheSchema();
    this.ensureFtsSchema();
    // 缩略图规格两列**必须在 init 里同步加**，不能像 is_favorite 那样延时：
    // 扫描 / 回填 / 网页端按需生成都会经 insertPhoto / updatePhotoThumbnail 写这两列，
    // 一旦列还没加上（老库首次启动），那几条语句会直接 `no such column` 全部失败。
    // ALTER TABLE ADD COLUMN 带常量 DEFAULT 是 O(1)，不会拖慢启动。
    this.ensurePhotosThumbnailMetaColumns();
    // 缩略图**全量重跑**的两张表（队列表 + 单行 meta）也在这里同步建：
    // 「待重跑多少张」是设置页随时会读的读数，老库上若表还没建，就是用户点开设置页
    // 报 `no such table`（而不是启动时炸，启动日志里看不出来）。
    // 两张表都是 O(1) 的 `CREATE TABLE IF NOT EXISTS`（队列表只可能有一条主键，
    // 空表就是 1 页），不拖慢百万级库的启动。
    this.ensureThumbRegenSchema();
    // `exif_mtime` 同理必须在这里同步加：`_sqlBackfillPendingExpr()` 引用了它，
    // 而那个谓词会被「待补数」这类随时可调的只读查询用到（不像 dhash / file_hash
    // 只在补全任务开跑前才被碰）。老库上少这一列 = 启动后第一次点开就 no such column。
    this.ensurePhotosExifColumn();
    // Live Photo 配对两列同理必须在这里**同步**加：判「这行还是不是待探查的伴生视频」
    // 的谓词会被 mediaType=video 的列表查询与统计引用（随时可调），老库上少这一列 =
    // 用户点开就 `no such column`，而且**不是启动时炸**，启动日志里看不出来。
    this.ensurePhotosLivePhotoColumns();
    // `derived_from`（图片编辑的裁剪副本来源）同理必须在这里**同步**加：编辑是用户
    // 随时会触发的操作，老库上少这一列 ⇒ 第一次裁剪就 `no such column`，
    // 而且**不是启动时炸**，启动日志里看不出来。带常量 DEFAULT 的 ADD COLUMN 是 O(1)。
    this.ensurePhotosDerivedColumn();
    // 组织元数据两列（`rating` / `flag`）同理必须**在这里同步加**：它们是预览工具条、
    // 网格角标、筛选栏随时会读的列，老库上少任一列 ⇒ 用户点开就 `no such column`，
    // 而且**不是启动时炸**（启动日志里看不出来）。带常量 DEFAULT 的 ADD COLUMN 是 O(1)。
    // ⚠️ 它们的索引**不在这里**建，见 PHASE5_INDEXES。
    this.ensurePhotosOrgMetaColumns();
    // tags / photo_tags 两张表同样在这里同步建：`CREATE TABLE IF NOT EXISTS` 是 O(1)，
    // 而「有哪些标签」是筛选栏与设置页随时会读的读数（老库上少这两张表 = 点开就报错）。
    this.ensureOrgTagSchema();
    // ensurePhotosIsFavoriteColumn: 首窗后延时调度，避免大库 PRAGMA/CREATE INDEX 阻塞启动
    // 孤立行清理见 deleteOrphanPhotosWithoutRoot，由 main 在首窗后异步写入
  }

  /**
   * 确保 photos 表有 `derived_from` 列（图片编辑：裁剪副本的来源）。
   *
   * 语义：`0` = 原始文件；`>0` = 由该 id 派生（与 `live_motion_id` 的 0 = 无 同构）。
   *
   * ⚠️ 必须与缩略图那两列一样在 `init()` 里**同步**加，不能像 is_favorite 那样延时：
   *    编辑是用户随时会触发的操作，老库上少这一列 ⇒ 第一次裁剪就 `no such column`，
   *    而且**不是启动时炸**（启动日志里看不出来）。
   */
  ensurePhotosDerivedColumn() {
    if (!this.hasTable('photos')) return;
    if (this._photosDerivedColumnDone) return;
    try {
      var pragma = this.db.prepare('PRAGMA table_info(photos)').all();
      for (var i = 0; i < pragma.length; i++) {
        if (pragma[i].name === 'derived_from') {
          this._photosDerivedColumnDone = true;
          return;
        }
      }
      this.db.exec('ALTER TABLE photos ADD COLUMN derived_from INTEGER DEFAULT 0;');
      this._photosDerivedColumnDone = true;
      logger.log('[db migration] added missing derived_from column to photos table');
    } catch (e) {
      logger.error(
        '[db migration] ensurePhotosDerivedColumn failed: ' + (e && e.message ? e.message : e),
      );
    }
  }

  /**
   * 确保 photos 表有组织元数据两列：`rating`（0-5）与 `flag`（none/pick/reject）。
   *
   * ⚠️ 必须与缩略图那几列一样在 `init()` 里**同步**加，不能像 is_favorite 那样延时：
   *    这两列是预览工具条、网格角标、筛选栏**随时会读**的列，老库上少任一列 ⇒
   *    用户点开就 `no such column`，而且**不是启动时炸**（启动日志里看不出来）。
   *    带常量 DEFAULT 的 ADD COLUMN 是 O(1)，不拖慢启动。
   *
   * 🔴 索引**刻意不在这里建**（`idx_photos_rating` / `idx_photos_flag` 在
   *    `src/main/deferred-indexes.js#PHASE5_INDEXES`）：这两列是后加的，cid 排在
   *    `thumbnail`（内联 BLOB）之后，建索引要整表回扫 ⇒ 百万行库上几十秒起，
   *    且长时间独占写库闸门。新库在空表上由 `createCoreSchema` 直接建（O(1)）。
   *    ⚠️ 这也是 `scripts/maintenance-regression.js` 那条「延迟索引不许出现在启动路径」
   *    白名单的成立前提：本函数里**不许**出现 CREATE INDEX 语句。
   */
  ensurePhotosOrgMetaColumns() {
    if (!this.hasTable('photos')) return;
    if (this._photosOrgMetaDone) return;
    try {
      if (!this.hasPhotosColumn('rating')) {
        this.db.exec('ALTER TABLE photos ADD COLUMN rating INTEGER DEFAULT 0;');
        logger.log('[db migration] added missing rating column to photos table');
      }
      if (!this.hasPhotosColumn('flag')) {
        this.db.exec("ALTER TABLE photos ADD COLUMN flag TEXT DEFAULT 'none';");
        logger.log('[db migration] added missing flag column to photos table');
      }
      this._photosOrgMetaDone = true;
    } catch (e) {
      logger.error(
        '[db migration] ensurePhotosOrgMetaColumns failed: ' + (e && e.message ? e.message : e),
      );
    }
  }

  /**
   * 确保 `tags` / `photo_tags` 两张表存在（用户自定义标签，2026-10-09）。
   *
   * ## 为什么 DDL 只在这里、不在 createCoreSchema
   *
   * 老库（已有 `photos`）**走不到** `createCoreSchema` —— `init()` 只在核心表缺失时才调它。
   * 把 DDL 写在那边等于「新库建得出、老库永远建不出来」，症状是老库上第一次点开标签
   * 就 `no such table`（不是启动时炸，启动日志里看不出来）。只写在这里是安全的：
   * `init()` **无条件**调用本函数，新库同样走这条路。
   *
   * ## 🔴 与 AI 自动标签刻意分立（别合并）
   *
   * AI 画面标签住在**另一个库**（`ai-search/tag-index.sqlite` 的 `tag_vocab` / `photo_tag`），
   * 是只读的推断结果、词表固定 5813 项、由 JoyTag 模型产出。这里是**用户自己写的**：
   * 可增删改、进主库、随数据库备份走。两者共表或共用一个「标签」概念，界面上就会把
   * 「AI 说这张图里有校服」和「我标它为客户 A」混成同一件事 —— 语义完全不同。
   *
   * ## 列语义
   *
   * · `name` 用户看到的原文；`normalized_name` 归一后的键（trim + 折叠内部空白 + 转小写），
   *   UNIQUE 建在归一列上 ⇒ 「 客户A 」「客户a」「客户A 」判为同一个标签。
   *   🔴 归一规则的唯一实现处是 `normalizeTagName()`，别在别处再写一遍 trim/lower。
   * · `photo_tags` 用两列联合主键天然去重（同一标签不会重复挂到同一张图上）。
   *   主键索引服务「按图查标签」，`idx_photo_tags_tag` 服务「按标签查图」。
   *
   * ⚠️ `ON DELETE CASCADE` **是真生效的**（不是装饰）：`open()` 里设了
   *    `PRAGMA foreign_keys = ON`（见该处）。所以删 `photos` 行时 `photo_tags`
   *    的关联会由 SQLite 自动清理，删除路径**不必**也不该再手写一遍清理 ——
   *    写两遍会让「级联失效」这种故障被第二遍掩盖，从而在别处（如 tags 计数）才暴露。
   *    同理删 `tags` 行时它的全部关联也会跟着走。
   */
  ensureOrgTagSchema() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS photo_tags (
          photo_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now', 'localtime')),
          PRIMARY KEY (photo_id, tag_id),
          FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags(tag_id);
      `);
    } catch (e) {
      logger.error('[db migration] ensureOrgTagSchema failed: ' + (e && e.message ? e.message : e));
    }
  }

  /**
   * 确保 photos 表有 is_favorite 列（收藏功能）。
   * 旧版本数据库创建时没有这个列，需要 ALTER TABLE 添加。
   */
  ensurePhotosIsFavoriteColumn() {
    if (!this.hasTable('photos')) return;
    try {
      // 检查列是否已存在
      var hasColumn = false;
      var pragma = this.db.prepare('PRAGMA table_info(photos)').all();
      for (var i = 0; i < pragma.length; i++) {
        if (pragma[i].name === 'is_favorite') {
          hasColumn = true;
          break;
        }
      }
      if (!hasColumn) {
        // 添加列，默认 0（未收藏）
        this.db.exec('ALTER TABLE photos ADD COLUMN is_favorite INTEGER DEFAULT 0;');
        logger.log('[db migration] added missing is_favorite column to photos table');
      }
      // 确保 is_favorite 有索引（旧版本可能缺少）
      try {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(is_favorite);');
      } catch (eIdx) {
        logger.error(
          '[db migration] create idx_photos_favorite failed:',
          eIdx && eIdx.message ? eIdx.message : eIdx,
        );
      }
    } catch (e) {
      logger.error(
        '[db migration] ensure is_favorite column failed:',
        e && e.message ? e.message : e,
      );
      void e;
    }
  }

  /** photos 表上是否有某一列。迁移函数共用，避免每处都抄一遍 PRAGMA 循环。 */
  hasPhotosColumn(name) {
    if (!this.hasTable('photos')) return false;
    var target = String(name || '');
    var pragma = this.db.prepare('PRAGMA table_info(photos)').all();
    for (var i = 0; i < pragma.length; i++) {
      if (pragma[i].name === target) return true;
    }
    return false;
  }

  /**
   * 确保 photos 表有 `thumb_size` / `thumb_format` / `thumb_fail_mtime` / `header_fail_mtime` 四列
   * （缩略图元信息 + 两个失败记账列）。
   *
   * 为什么要有规格两列：在此之前**全库没有任何地方记录缩略图是用什么档位、什么格式生成的**，
   * 于是「换了 thumbSize 之后哪些图还是旧的」「哪些图还是 JPEG 需要转 WebP」这类问题
   * 既查不出来也没法做增量迁移，只能整表硬跑。列加上之后，这两个问题都变成一句 WHERE。
   *
   * 为什么要有失败记账列（2026-10-06）：候选谓词里的 `has_thumbnail = 0` 是**无条件**入选的，
   * 而读不了的文件（Canon 旧式 RAW、被截断的 JPEG）会永远停在那里 —— 每轮开局被取出、
   * 每轮白读一次盘（.CR2 单个 18 MB）、每轮失败，且**失败不留任何痕迹**，
   * 库里分不出「还没轮到」与「试过失败了」。本机实测 10 行（9 个 CR2 + 1 个截断 JPEG）
   * 正好排在**全库最高 id**，也就是任务每轮最先撞上的位置。
   *
   * 🔴 两列分工（2026-10-06 同一轮补上 `header_fail_mtime`，因为只加一列**没修干净**）：
   *    `thumb_fail_mtime` 只门住候选谓词的**第一支**（缺缩略图）；第二支
   *    （`是图片 AND (dhash 缺 OR width 0 OR EXIF 待补)`）判的是另一组列，一个都不认它。
   *    而读不了的文件正好 `width=0` / `dhash=NULL` / `exif_mtime=NULL` ⇒ **从第一支漏进第二支**，
   *    照样每轮被取出。实测 10/10 命中第二支（约 162 MB/轮 白读），且主分母（候选集规模）
   *    因此永远归不了零。⇒ 两个标记列各管自己那一路：
   *      `thumb_fail_mtime`  ← 解码路（缩略图 / dHash）
   *      `header_fail_mtime` ← 文件头路（原图尺寸 / 拍摄参数）
   *    ⚠️ 别把「解码失败但文件头读到了」（截断 JPEG）也盖成 header 失败 —— 它尺寸与 EXIF
   *       照样补得上，那正是 bug B 的修复效果。
   *
   * 🔴 **刻意不回填历史行**：`0` / `''` / NULL 就是「本列引入之前的存量」。
   *    全表 `UPDATE photos SET thumb_size = 256` 会独占写锁扫完整个 12 GB 库
   *    （项目里已有这条红线），而它在迁移判断上和 `0` 是等价的——两者都需要重生成。
   *    与其花一次全表写锁换一个不改变结论的数字，不如老实留着「未知」。
   *    对 `thumb_fail_mtime` 更明显：回填等于给全库盖一个「失败过」的章，语义直接错。
   *
   * ALTER TABLE ADD COLUMN 带常量 DEFAULT 是 O(1)（只改 schema、不重写数据），
   * 所以这个函数放在 `init()` 里**同步**调用也不会拖慢百万级库的启动。
   */
  ensurePhotosThumbnailMetaColumns() {
    if (!this.hasTable('photos')) return { added: [] };
    var added = [];
    try {
      if (!this.hasPhotosColumn('thumb_size')) {
        this.db.exec('ALTER TABLE photos ADD COLUMN thumb_size INTEGER DEFAULT 0;');
        added.push('thumb_size');
      }
      if (!this.hasPhotosColumn('thumb_format')) {
        this.db.exec("ALTER TABLE photos ADD COLUMN thumb_format TEXT DEFAULT '';");
        added.push('thumb_format');
      }
      // 🔴 `thumb_fail_mtime` 必须在这里**同步**加：它被 `_sqlNeedsThumbnailExpr()` 引用，
      //    而那个谓词是候选查询（含「第一趟只取缺缩略图」那条）的 WHERE —— 老库上少这一列，
      //    补全任务**第一次取批**就 `no such column`（不是启动时炸，启动日志里看不出来）。
      //    与 `exif_mtime` 同理：被随时可调的只读谓词引用的列，不能等到任务开跑才迁移。
      //    ALTER TABLE ADD COLUMN 不带 DEFAULT 是 O(1)，不拖慢百万级库的启动。
      if (!this.hasPhotosColumn('thumb_fail_mtime')) {
        this.db.exec('ALTER TABLE photos ADD COLUMN thumb_fail_mtime TEXT;');
        added.push('thumb_fail_mtime');
      }
      // `header_fail_mtime` 同理必须在这里**同步**加：候选谓词的第二支引用了它，
      // 而那条谓词会被「待补数」这类随时可调的只读查询用到（`estimatePendingCandidateCount`
      // 的抽样点查、`getPhotosMissingThumbnailsBefore` 的取批）。老库上少这一列 =
      // 启动后第一次取批就 `no such column`，而且**不是启动时炸**，启动日志里看不出来。
      if (!this.hasPhotosColumn('header_fail_mtime')) {
        this.db.exec('ALTER TABLE photos ADD COLUMN header_fail_mtime TEXT;');
        added.push('header_fail_mtime');
      }
      if (added.length) {
        logger.log('[db migration] added missing thumbnail meta columns: ' + added.join(', '));
      }
    } catch (e) {
      var message = e && e.message ? e.message : String(e);
      // 主进程 / scan-worker / web-server 各持一个 Database 实例，启动早期可能同时跑这里。
      // 后到的那个会撞 `duplicate column name` —— 那是幂等命中，不是故障。
      if (/duplicate column name/i.test(message)) {
        logger.log('[db migration] thumbnail meta columns already added by another connection');
        return { added: added };
      }
      logger.error('[db migration] ensure thumbnail meta columns failed:', message);
    }
    return { added: added };
  }

  /**
   * 确保 photos 表有 Live Photo 配对两列。
   *
   * ## 为什么需要它们
   *
   * iPhone 的 Live Photo 是**一对文件**：`IMG_1234.HEIC`（静帧）+ `IMG_1234.MOV`（约 3 秒）。
   * 没有这两列时，扫描器会把伴生 MOV 当成一个**独立视频**收进来 ⇒ 同一张图片在库里
   * 出现两次（图片列表一次、视频列表一次），视频总数也被灌水。
   *
   * ## 三态语义（🔴 别混，NULL 与 0 的区别是承重的）
   *
   *   `live_still_id` —— 记在**视频行**上：
   *     `NULL` = 还没探查过
   *     `0`    = 探查过，**不是**伴生视频
   *     `> 0`  = 是伴生视频，值是配对图片的 `photos.id`
   *   `live_motion_id` —— 记在**图片行**上：
   *     `0`    = 无伴生视频（也是存量默认值）
   *     `> 0`  = 有伴生视频，值是那段 MOV 的 `photos.id`
   *
   * 🔴 为什么 `live_still_id` 非要区分 NULL 与 0：只判「= 0」会让配对任务每一轮
   *    把全部 MOV 重新读一遍盘（真库有 4554 个，单次探查实测 3~23 ms，其中还有
   *    GB 级文件），而**绝大多数视频永远也不会**是 Live Photo。这与 `exif_mtime` /
   *    `thumb_fail_mtime` 是同一套「已检查标记」思路。
   *
   * 🔴 为什么判据不能是文件名配对：真库实测「同目录同 basename 的 图片 + 视频」
   *    有 **5677 对**，其中体积比 > 300% 的就有 **4525 对** —— 那是写真集
   *    「封面图 + 正片」的标准形态，按文件名判伴生会**凭空藏掉用户几千个视频**。
   *    唯一可靠判据是 Apple 写进 MOV 的 `com.apple.quicktime.content.identifier`，
   *    详见 `src/main/live-photo.js` 头注释。
   *
   * `ALTER TABLE ADD COLUMN` 带常量 DEFAULT 是 O(1)（只改 schema、不重写数据），
   * 所以放在 `init()` 里同步调用也不拖慢百万级库的启动。存量行**刻意不回填**：
   * `live_still_id` 留 NULL 正好表示「还没探查过」，正是配对任务要的起点。
   *
   * @returns {{added: string[]}}
   */
  ensurePhotosLivePhotoColumns() {
    if (!this.hasTable('photos')) return { added: [] };
    var added = [];
    try {
      if (!this.hasPhotosColumn('live_motion_id')) {
        this.db.exec('ALTER TABLE photos ADD COLUMN live_motion_id INTEGER DEFAULT 0;');
        added.push('live_motion_id');
      }
      // ⚠️ 这一列**刻意不带 DEFAULT**：DEFAULT 0 会把「还没查过」一次性抹成
      //    「查过、不是伴生」，配对任务就再也不认领存量行了（且没有别的列能区分）。
      if (!this.hasPhotosColumn('live_still_id')) {
        this.db.exec('ALTER TABLE photos ADD COLUMN live_still_id INTEGER;');
        added.push('live_still_id');
      }
      if (added.length) {
        logger.log('[db migration] added missing live photo columns: ' + added.join(', '));
      }
    } catch (e) {
      var message = e && e.message ? e.message : String(e);
      // 主进程 / scan-worker / web-server 各持一个 Database 实例，启动早期可能同时跑这里。
      // 后到的那个会撞 `duplicate column name` —— 那是幂等命中，不是故障。
      if (/duplicate column name/i.test(message)) {
        logger.log('[db migration] live photo columns already added by another connection');
        return { added: added };
      }
      logger.error('[db migration] ensure live photo columns failed:', message);
    }
    return { added: added };
  }

  /**
   * 确保 photos 表有 `exif_mtime` 列 —— 拍摄参数回填的「已检查」标记。
   *
   * 🔴 为什么必须有这一列：判「这行还要不要读 EXIF」**不能**看内容列有没有值。
   *    `camera_make IS NULL` 对「截图 / 网图 / PNG」恒为真，而这些图片**永远也不会有 EXIF**
   *    ⇒ 它们会一轮一轮被取出来、处理完又原样留下，任务**永不收敛**（与 `_sqlBackfillPendingExpr`
   *    里视频那类死行是同一个坑）。标记列把「本来就没有」和「还没看过」彻底分开。
   *
   * 🔴 与 `thumb_size` / `thumb_format` 一起放在 `init()` 里**同步**加（见那边的注释）：
   *    这些列被随时可调的只读谓词引用，不能等到补全任务开跑时才迁移。
   *    `ALTER TABLE ADD COLUMN` 不带 DEFAULT 是 O(1)，不会拖慢百万级库的启动。
   *
   * 🔴 本方法同时是**拍摄参数全部内容列**（当前 58 列）的迁移点：列名与类型都从
   *    `src/main/exif-meta.js` 的注册表派生 ⇒ 扩字段只改那张表，这里一个字都不用动。
   *    少了任何一列就是 `updatePhotoExif` 当场 `no such column`（第一次取批时炸，启动日志看不出来）。
   *    逐列 ALTER、单列失败不阻断其余列；并发实例撞 `duplicate column name` 是幂等命中。
   *
   * @returns {{added: string[]}}
   */
  ensurePhotosExifColumn() {
    if (!this.hasTable('photos')) return { added: [] };
    var added = [];
    try {
      // 一次 PRAGMA 取回全部列名：本方法现在要核对 50 列，逐列调 `hasPhotosColumn()`
      // 就会变成 50 次 `PRAGMA table_info`（每次都要遍历整张表的结构）。
      var existing = {};
      var pragma = this.db.prepare('PRAGMA table_info(photos)').all();
      for (var p = 0; p < pragma.length; p++) existing[pragma[p].name] = true;

      // 账本列 —— **不在**解析注册表里：它们是「回填记账」，不是从文件里读出来的内容。
      //   `exif_mtime` = 看过没；`exif_ver` = 看过第几版（见 `_sqlNeedsExifExpr()`）。
      var plan = [
        ['exif_mtime', 'TEXT'],
        ['exif_ver', 'INTEGER'],
      ];
      // 内容列：列名与类型全部从 `exif-meta.js` 的注册表派生，别在这里再抄一遍列名。
      for (var c = 0; c < EXIF_METADATA_COLUMNS.length; c++) {
        var exifCol = EXIF_METADATA_COLUMNS[c];
        plan.push([exifCol, EXIF_COLUMN_TYPES[exifCol] || 'TEXT']);
      }
      for (var n = 0; n < plan.length; n++) {
        if (existing[plan[n][0]]) continue;
        this.db.exec('ALTER TABLE photos ADD COLUMN ' + plan[n][0] + ' ' + plan[n][1] + ';');
        existing[plan[n][0]] = true;
        added.push(plan[n][0]);
      }
      if (added.length) {
        logger.log('[db migration] added missing exif meta column(s): ' + added.join(', '));
      }
    } catch (e) {
      var message = e && e.message ? e.message : String(e);
      // 主进程 / scan-worker / web-server 各持一个 Database 实例，启动早期可能同时跑这里。
      // 后到的那个会撞 `duplicate column name` —— 那是幂等命中，不是故障。
      if (/duplicate column name/i.test(message)) {
        logger.log('[db migration] exif meta column already added by another connection');
        return { added: added };
      }
      logger.error('[db migration] ensure exif meta column failed:', message);
    }
    return { added: added };
  }

  /**
   * 缩略图规格分布：`{ size, format, n }` 按数量倒序。
   *
   * ⚠️ 无索引，会扫整张表——12 GB 的库上是**几十秒级**的只读查询，
   * 只允许从维护/统计入口调用，**不要**放到首屏或每次进设置页时跑。
   *
   * @returns {Array<{size: number, format: string, n: number}>}
   */
  getThumbnailSpecStats() {
    if (!this.hasPhotosColumn('thumb_size') || !this.hasPhotosColumn('thumb_format')) return [];
    return this.db
      .prepare(
        `SELECT thumb_size AS size, thumb_format AS format, COUNT(*) AS n
         FROM photos
         WHERE thumbnail IS NOT NULL
         GROUP BY thumb_size, thumb_format
         ORDER BY n DESC`,
      )
      .all();
  }

  /**
   * 待重生成的缩略图张数：档位不等于目标、或格式不等于目标的行。
   *
   * 🔴 谓词从 `thumb-regen-queue#SPEC_MISMATCH_PRED` 取、**行集判据与登记 SQL 逐字同源**
   *    （同一个 `has_thumbnail = 1`）。过去这里写的是 `thumbnail IS NOT NULL`，
   *    与登记的 `has_thumbnail = 1` 是**两个集合**：库里有标志位与 BLOB 不一致的行
   *    （`openHomePage` 那条口径注释记过这个三态），于是「预计要重跑 N 张」与实际处理的张数
   *    对不上 —— 不报错，只是数字永远差一点。
   *
   * ⚠️ 无索引，扫整张表：12 GB 的库上是**几十秒级**的只读查询。只允许从维护入口 /
   *    回归脚本调用，**不要**放到首屏或每次进设置页时跑（设置页的读数是队列的行数，O(页)）。
   */
  countThumbnailsNeedingRegen(targetSize, targetFormat) {
    if (!this.hasPhotosColumn('thumb_size') || !this.hasPhotosColumn('thumb_format')) return 0;
    var size = parseInt(targetSize, 10) || 0;
    var format = String(targetFormat || '');
    var row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM photos
         WHERE has_thumbnail = 1 AND (${thumbRegenQueue.SPEC_MISMATCH_PRED})`,
      )
      .get(size, format);
    return row ? Number(row.n) || 0 : 0;
  }

  /**
   * 建「全量重跑」的两张表（队列表 + 单行 meta）。幂等、O(1)，在 `init()` 里同步调用。
   */
  ensureThumbRegenSchema() {
    try {
      for (var i = 0; i < thumbRegenQueue.DDL.length; i++) {
        this.db.exec(thumbRegenQueue.DDL[i]);
      }
      // 单行 meta 的兜底插入：`INSERT OR IGNORE` 只在缺行时写一条全默认值，
      // 之后所有写入都是 UPDATE（不做 UPSERT —— 两个连接并发建库时 UPSERT 可能覆盖，
      // 而这个「覆盖」会丢掉正在跑的进度）。
      this.db
        .prepare(`INSERT OR IGNORE INTO ${thumbRegenQueue.META_TABLE} (k) VALUES (1)`)
        .run();
    } catch (e) {
      var message = e && e.message ? e.message : String(e);
      logger.error('[db migration] ensure thumb regen schema failed:', message);
    }
  }

  /** 单行 meta（目标规格 / 阶段 / 游标 / 累计计数）。缺行时返回全默认值，不返回 null。 */
  thumbRegenMeta() {
    try {
      var row = this.db
        .prepare(`SELECT * FROM ${thumbRegenQueue.META_TABLE} WHERE k = 1`)
        .get();
      if (!row) return null;
      return {
        signature: String(row.signature || ''),
        phase: String(row.phase || ''),
        enqueueCursor: Number(row.enqueueCursor) || 0,
        targetSize: Number(row.targetSize) || 0,
        targetFormat: String(row.targetFormat || ''),
        total: Number(row.total) || 0,
        done: Number(row.done) || 0,
        failed: Number(row.failed) || 0,
        missing: Number(row.missing) || 0,
        updatedAt: Number(row.updatedAt) || 0,
      };
    } catch (e) {
      logger.warn('[thumb-regen] meta read failed:', e && e.message ? e.message : e);
      return null;
    }
  }

  /**
   * 写 meta（只更新传进来的字段）。
   *
   * ⚠️ 用「白名单字段 + 逐字段 UPDATE」而不是 UPSERT：调用方只关心自己那几个字段，
   *    整行覆盖会把并发写的另一个字段（比如 `enqueueCursor` 与 `done`）抹回旧值。
   */
  thumbRegenWriteMeta(patch) {
    var keys = Object.keys(patch || {});
    if (!keys.length) return;
    var allowed = {
      signature: 1,
      phase: 1,
      enqueueCursor: 1,
      targetSize: 1,
      targetFormat: 1,
      total: 1,
      done: 1,
      failed: 1,
      missing: 1,
      updatedAt: 1,
    };
    var sets = [];
    var values = [];
    for (var i = 0; i < keys.length; i++) {
      if (!allowed[keys[i]]) continue;
      // ⚠️ `undefined` 必须**跳过**而不是绑进去：better-sqlite3 遇到 undefined 直接抛
      //    （不是写 NULL），而调用方很自然会写 `signature: reset ? sig : undefined`。
      if (patch[keys[i]] === undefined) continue;
      sets.push(keys[i] + ' = ?');
      values.push(patch[keys[i]]);
    }
    if (!sets.length) return;
    sets.push('updatedAt = ?');
    values.push(Number(patch.updatedAt) || Date.now());
    values.push(1);
    this.db
      .prepare(`UPDATE ${thumbRegenQueue.META_TABLE} SET ${sets.join(', ')} WHERE k = ?`)
      .run(values);
  }

  /** 队列里还剩多少行（O(队列页数)，与全库行数无关）。 */
  thumbRegenCount() {
    try {
      var row = this.db.prepare(thumbRegenQueue.COUNT_SQL).get();
      return row ? Number(row.n) || 0 : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 登记**一块** id 区间：`(idFrom, idTo]`，倒序推进（与后台任务方向统一 = 主键倒序）。
   *
   * 一个事务里做三件事（顺序固定，缺一即留下不一致状态）：
   *   ① 若 `resetSignature` 非空（= 旧队列作废）⇒ 清空队列 + 重置 meta；
   *   ② 把区间内「规格与目标不符」的行放进队列；
   *   ③ 落盘游标 / 累计张数 / 阶段。
   *
   * 🔴 阶段推进也在这里：扫到 `idFrom <= 0`（全库扫完）时**同一个事务**里把阶段置 `draining`。
   *    分成两次写的话，崩在中间就是「全库扫完了、阶段还是 enqueueing」⇒
   *    下次启动从 `enqueueCursor = 0` 重扫一遍全库（几十秒到几分钟的白扫，而且不报错）。
   *
   * @param {number} idFrom 闭区间下界（0 表示已扫到库底）
   * @param {number} idTo 开区间上界
   * @param {number} targetSize 目标档位
   * @param {string} targetFormat 目标编码格式
   * @param {string} [resetSignature] 非空 = 先清空重置，并把身份串写成它
   * @param {number} [totalBefore] 本块之前已累计的登记张数（重置时忽略，从 0 起算）
   * @returns {{inserted: number, total: number, phase: string}}
   */
  thumbRegenEnqueueChunk(idFrom, idTo, targetSize, targetFormat, resetSignature, totalBefore) {
    var self = this;
    var out = { inserted: 0, total: 0, phase: 'enqueueing' };
    var from = Number(idFrom) || 0;
    var to = Number(idTo) || 0;
    var size = parseInt(targetSize, 10) || 0;
    var format = String(targetFormat || '');
    var tx = this.db.transaction(function () {
      var before = Number(totalBefore) || 0;
      if (resetSignature) {
        self.db.exec(thumbRegenQueue.CLEAR_SQL);
        before = 0;
      }
      var info = self.db
        .prepare(thumbRegenQueue.ENQUEUE_SQL)
        .run(from, to, size, format);
      out.inserted = info && Number(info.changes) ? Number(info.changes) : 0;
      out.total = before + out.inserted;
      out.phase = from <= 0 ? 'draining' : 'enqueueing';
      var patch = {
        signature: resetSignature || undefined,
        phase: out.phase,
        enqueueCursor: from,
        targetSize: size,
        targetFormat: format,
        total: out.total,
        updatedAt: Date.now(),
      };
      if (resetSignature) {
        // 新队列的 done / failed 必须归零：不清就是「新队列背着旧队列的进度」——
        // 分母从 0 起、分子几百万人，进度条一上来就是 100%。
        patch.done = 0;
        patch.failed = 0;
      }
      self.thumbRegenWriteMeta(patch);
    });
    tx();
    return out;
  }

  /**
   * 抽干**一批**之后的收口：删掉这一批 + 累加记账 + 推进阶段。**同一个事务**。
   *
   * 🔴 删除的判据是**这一批的 id 列表**，不是「`id <= 本批最小 id`」。队列是**稀疏**的
   *    （只有规格不符的行在里面），游标内含会连带删掉「比本批最小 id 更小、但还没取过」的行 ——
   *    `done` 照样加满，那批行却**再也不会被重跑**（静默少做，且进度条显示已完成）。
   *    开工前用「游标内含」在夹具上验证过，正是被本仓的 `thumbnail-regen-regression` 抓住的。
   * ⚠️ id 列表走 `json_each`（`main/sql-id-list.js`），不展开成 `?,?,…`：
   *    批大小是常量（50），超限不可能发生，但项目里那条「禁 `IN (?,?,…)` 展开全部 id」的红线
   *    是因为展开写法**迟早**会被用到「全部 id」上 —— 这里从一开始就不给那个形状。
   * 🔴 `done` 用**实际删除行数**累加（不是批大小）：这样它与队列的真实消耗永远一致，
   *    不会出现「进度条走完、队列还剩一堆」这种要专门去对账的状态。
   *
   * @param {number[]} ids 本批真正取出来并处理过的 id
   * @param {{failed?: number, missing?: number}} delta 本批的失败 / 已消失张数
   * @returns {{deleted: number, done: number, failed: number, missing: number, total: number, remaining: number, phase: string}}
   */
  thumbRegenFinishBatch(ids, delta) {
    var self = this;
    var out = { deleted: 0, done: 0, failed: 0, missing: 0, total: 0, remaining: 0, phase: '' };
    var failAdd = Math.max(0, Number(delta && delta.failed) || 0);
    var missAdd = Math.max(0, Number(delta && delta.missing) || 0);
    var json = toIdListJson(ids);
    var tx = this.db.transaction(function () {
      var info = self.db.prepare(thumbRegenQueue.DELETE_BATCH_SQL).run(json);
      out.deleted = info && Number(info.changes) ? Number(info.changes) : 0;
      var meta = self.thumbRegenMeta() || {};
      out.total = Number(meta.total) || 0;
      out.done = (Number(meta.done) || 0) + out.deleted;
      out.failed = (Number(meta.failed) || 0) + failAdd;
      out.missing = (Number(meta.missing) || 0) + missAdd;
      out.remaining = Math.max(0, out.total - out.done);
      out.phase = out.remaining > 0 ? 'draining' : 'done';
      self.thumbRegenWriteMeta({
        done: out.done,
        failed: out.failed,
        missing: out.missing,
        // 队列抽干 ⇒ 阶段直接推到 `done`（设置页据此说「已完成」而不是「还有 N 张」）
        phase: out.phase,
        updatedAt: Date.now(),
      });
    });
    tx();
    return out;
  }

  /**
   * 队列已空时的收口：把 `done` 对齐 `total` 并把阶段置 `done`。
   *
   * 正常路径下 `done === total`（`done` 按实际删除行数累加），这一步只是把**任何**历史漂移
   * （外部改库 / 早期版本写的行）抹平。少了它，界面会永远停在「还有 N 张待重建」
   * 而任务其实已经结束 —— 静默的假读数。
   */
  thumbRegenMarkDrained() {
    var self = this;
    var out = { total: 0, done: 0, failed: 0 };
    var tx = this.db.transaction(function () {
      var meta = self.thumbRegenMeta() || {};
      out.total = Number(meta.total) || 0;
      out.done = out.total;
      out.failed = Number(meta.failed) || 0;
      self.thumbRegenWriteMeta({
        done: out.done,
        phase: 'done',
        enqueueCursor: 0,
        updatedAt: Date.now(),
      });
    });
    tx();
    return out;
  }

  /**
   * 取一批待重跑的行（**倒序**；`LEFT JOIN` 保证 `photos` 里已消失的行也能被取出来）。
   *
   * @param {number} cursor 游标（内含）
   * @param {number} limit 批大小
   */
  thumbRegenFetchBatch(cursor, limit) {
    return this.db
      .prepare(thumbRegenQueue.FETCH_SQL)
      .all(Number(cursor) || 0, Math.max(1, parseInt(limit, 10) || 1));
  }

  /**
   * 删掉「本批已处理过」的行（`id <= 游标`，游标 = 本批最小 id）。
   *
   * ⚠️ 为什么要用「游标内含」而不是「id 列表」：批内每个 id 都要拼进 SQL，
   *    而项目有一条红线是「禁 `WHERE id IN (?,?,…)` 展开全部 id」（上限 32766 个 `?`，
   *    见 `src/main/sql-id-list.js`）。走游标就只有一句、与批大小无关。
   * 🔴 前提是**调用方必须处理完整批**才允许删（失败的行也记账后删除）——
   *    中途 break 掉再删，就会把没处理的行一起「记成已完成」，队列再也补不回来。
   * @returns {number} 实际删除的行数（= 本批在队列里的行数，`done` 的累加依据）
   */
  thumbRegenDeleteDrained(cursor) {
    var info = this.db
      .prepare(thumbRegenQueue.DELETE_DRAINED_SQL)
      .run(Number(cursor) || 0);
    return info && Number(info.changes) ? Number(info.changes) : 0;
  }

  /**
   * 缩略图补全的两个加速索引 + `has_thumbnail` 标记修复**只在 worker 里做**，见
   * `src/workers/thumbnail-fix-worker.js`（由 applyDeferredThumbnailFix 调度）。
   *
   * 这里刻意不再保留**主线程的同步版本**：它曾经存在过（同名 ensurePhotosThumbnailMissingIndex），
   * 无人调用却带着一模一样的全表 UPDATE，谁哪天顺手接上就是一次几十秒的主进程写锁占用。
   * 需要手动重算标记请用维护里的 `rebuildThumbnailFlags`，那条路走独立的维护 worker。
   */

  /** 根目录全量统计缓存：避免每次启动对百万级 photos 全表 GROUP BY（冷启动首次仍须计算并回填） */
  ensureRootFolderStatsCacheSchema() {
    if (this._rootStatsCacheSchemaDone) return;
    this._rootStatsCacheSchemaDone = true;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS root_folder_stats_cache (
          root_id INTEGER NOT NULL,
          media_key TEXT NOT NULL,
          photo_count INTEGER NOT NULL DEFAULT 0,
          folder_count INTEGER NOT NULL DEFAULT 0,
          video_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (root_id, media_key),
          FOREIGN KEY (root_id) REFERENCES root_folders(id) ON DELETE CASCADE
        );
      `);
    } catch (e) {
      this._rootStatsCacheSchemaDone = false;
      throw e;
    }
  }

  /**
   * FTS5 全文索引：对 file_name + folder_path 建立分词索引，搜索从 O(N) LIKE 扫描变为 O(1) 查找。
   * content='photos' + content_rowid='id' 只存索引不存原文，触发器自动同步增删改。
   * 首次调用时 rebuild 一次，后续幂等跳过。
   */
  ensureFtsSchema() {
    if (this._ftsSchemaDone) return;
    if (!this.hasTable('photos')) return;
    try {
      const isNewIndex = !this.hasTable('photos_fts');
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
          file_name,
          folder_path,
          content='photos',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS photos_fts_ai AFTER INSERT ON photos BEGIN
          INSERT INTO photos_fts(rowid, file_name, folder_path)
          VALUES (new.id, new.file_name, new.folder_path);
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS photos_fts_ad AFTER DELETE ON photos BEGIN
          INSERT INTO photos_fts(photos_fts, rowid, file_name, folder_path)
          VALUES ('delete', old.id, old.file_name, old.folder_path);
        END;
      `);
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS photos_fts_au AFTER UPDATE OF file_name, folder_path ON photos BEGIN
          INSERT INTO photos_fts(photos_fts, rowid, file_name, folder_path)
          VALUES ('delete', old.id, old.file_name, old.folder_path);
          INSERT INTO photos_fts(rowid, file_name, folder_path)
          VALUES (new.id, new.file_name, new.folder_path);
        END;
      `);
      this._ftsAvailable = true;
      if (isNewIndex && this.hasTable('aurora_maintenance_state')) {
        this.db.prepare("DELETE FROM aurora_maintenance_state WHERE name = 'fts-v1'").run();
      }
      this._ftsSchemaDone = true;
      logger.log('[db] FTS5 schema ready');
    } catch (e) {
      this._ftsAvailable = false;
      this._ftsSchemaDone = true;
      logger.warn('[db] FTS5 not available, falling back to LIKE:', e && e.message ? e.message : e);
    }
  }

  /** Called in the maintenance Worker; the transaction makes the completion marker crash-safe. */
  ensureFtsIndex() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS aurora_maintenance_state (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL)',
    );
    return this.db
      .transaction(() => {
        if (this.db.prepare("SELECT 1 FROM aurora_maintenance_state WHERE name = 'fts-v1'").get()) {
          return { skipped: true };
        }
        if (
          !this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'photos_fts' AND type = 'table'")
            .get()
        ) {
          return { skipped: true, reason: 'fts_unavailable' };
        }
        this.db.exec("INSERT INTO photos_fts(photos_fts) VALUES('rebuild')");
        this.db
          .prepare("INSERT INTO aurora_maintenance_state VALUES ('fts-v1', ?)")
          .run(new Date().toISOString());
        return { rebuilt: true };
      })
      .immediate();
  }

  isFtsIndexReady() {
    return (
      this._ftsAvailable &&
      this.hasTable('aurora_maintenance_state') &&
      !!this.db.prepare("SELECT 1 FROM aurora_maintenance_state WHERE name = 'fts-v1'").get()
    );
  }

  /** Explicit forced rebuild; startup uses ensureFtsIndex in a Worker instead. */
  rebuildFtsIndex() {
    if (!this._ftsAvailable) return;
    try {
      var t = Date.now();
      this.db.exec("INSERT INTO photos_fts(photos_fts) VALUES('rebuild');");
      logger.log('[db] FTS5 rebuild done in', Date.now() - t, 'ms');
    } catch (e) {
      logger.error('[db] FTS5 rebuild failed:', e && e.message ? e.message : e);
    }
  }

  /** 构建 FTS5 MATCH 表达式：每个 token 加前缀匹配 *，多 token 用 AND 连接。 */
  _buildFtsQuery(query) {
    if (!query) return '';
    var tokens = query.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    return tokens
      .map(function (t) {
        return '"' + t.replace(/"/g, '""') + '"*';
      })
      .join(' ');
  }

  rootFolderStatsCacheMediaKey(options) {
    return require('./db-heavy-read').rootFolderStatsCacheMediaKey(options);
  }

  mergeRootFolderStatsCache(rows, options) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    this.ensureRootFolderStatsCacheSchema();
    var mediaKey = this.rootFolderStatsCacheMediaKey(options || {});
    var insert = this.db.prepare(
      `INSERT OR REPLACE INTO root_folder_stats_cache (root_id, media_key, photo_count, folder_count, video_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    var tx = this.db.transaction(function () {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || r.id == null) continue;
        insert.run(
          r.id,
          mediaKey,
          Number(r.photo_count) || 0,
          Number(r.folder_count) || 0,
          Number(r.video_count) || 0,
        );
      }
    });
    tx();
  }

  invalidateRootFolderStatsCache(rootId) {
    if (rootId == null) return;
    try {
      this.ensureRootFolderStatsCacheSchema();
      this.db.prepare('DELETE FROM root_folder_stats_cache WHERE root_id = ?').run(rootId);
    } catch (e) {
      void e;
    }
  }

  /**
   * 按单根重算 all/image/video 写入 root_folder_stats_cache，不碰其他根；扫描结束或需精确单根修正时调用。
   *
   * 🔴 **异步 + 三档之间让出**，调用端必须 `await`（`scanner.js` 的收尾段）。
   * 三档聚合各自是一次同步 SQL；改写后单档仍有数百 ms～2.6 s（`K:\COS` 912,222 行实测
   * all=2,595 ms / image=383 ms / video=54 ms），要让 `scan-worker` 的 300 ms 心跳
   * 在这段里发得出去，只能在档与档之间给事件循环让路。
   *
   * 读与写**分开**：先把三档算完（只读，可让出），最后一次性落库（单个同步事务，微秒级）。
   * 代价是「算」与「写」之间理论上可能被别人插进一次并发写，但本方法的调用点就在扫描收尾、
   * 且扫描整段占着写库闸门（`dbWriteQueue.run('scan')`），所以落库值仍然是那一时刻的聚合。
   */
  async refreshRootFolderStatsCacheForRoot(rootId, options) {
    if (rootId == null) return;
    var rid = parseInt(rootId, 10);
    if (!isFinite(rid) || rid <= 0) return;
    options = options || {};
    var yieldFn = typeof options.yieldFn === 'function' ? options.yieldFn : yieldToEventLoop;
    this.ensureRootFolderStatsCacheSchema();
    // `heavy` 是模块顶部那一份（不再就地 require —— 就地声明会**遮蔽**它，读代码时
    // 分不清这一处用的是哪个绑定）。
    if (typeof heavy.runAggregateStatsForSingleRoot !== 'function') return;
    var exists = this.db.prepare('SELECT 1 AS x FROM root_folders WHERE id = ? LIMIT 1').get(rid);
    if (!exists) return;
    var variants = [
      { key: 'all', opts: {} },
      { key: 'image', opts: { mediaType: 'image' } },
      { key: 'video', opts: { mediaType: 'video' } },
    ];
    var computed = [];
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var stats = heavy.runAggregateStatsForSingleRoot(this.db, rid, v.opts);
      if (stats) computed.push({ key: v.key, stats: stats });
      if (i < variants.length - 1) await yieldFn();
    }
    if (!computed.length) return;
    var insert = this.db.prepare(
      `INSERT OR REPLACE INTO root_folder_stats_cache (root_id, media_key, photo_count, folder_count, video_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    var tx = this.db.transaction(function () {
      for (var j = 0; j < computed.length; j++) {
        var c = computed[j];
        insert.run(rid, c.key, c.stats.photo_count, c.stats.folder_count, c.stats.video_count);
      }
    });
    tx();
  }

  invalidateAllRootFolderStatsCache() {
    try {
      if (!this.hasTable('root_folder_stats_cache')) return;
      this.db.prepare('DELETE FROM root_folder_stats_cache').run();
    } catch (e) {
      void e;
    }
  }

  /**
   * 删除 root_id 已不存在的图片行（历史脏数据）。大库时略耗时，宜在窗口出现后调用。
   */
  deleteOrphanPhotosWithoutRoot() {
    this.db.exec(`
      DELETE FROM photos WHERE root_id NOT IN (SELECT id FROM root_folders);
    `);
    this.invalidateAllRootFolderStatsCache();
  }

  /** 为重复项 SHA-256 扩展 photos 列（幂等） */
  ensureDuplicateHashSchema() {
    if (this._duplicateHashSchemaDone) return;
    try {
      this.db.exec('ALTER TABLE photos ADD COLUMN file_hash TEXT');
    } catch (e) {}
    try {
      this.db.exec('ALTER TABLE photos ADD COLUMN hash_mtime TEXT');
    } catch (e) {}
    try {
      this.db.exec('ALTER TABLE photos ADD COLUMN hash_size INTEGER');
    } catch (e) {}
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash)');
    } catch (e) {}
    this._duplicateHashSchemaDone = true;
  }

  /** 为感知哈希 dHash 扩展 photos 列与 LSH 辅助表（幂等） */
  ensureDhashSchema() {
    if (this._dhashSchemaDone) return;
    // photos 表新增列
    try {
      this.db.exec('ALTER TABLE photos ADD COLUMN dhash TEXT');
    } catch (e) {}
    try {
      this.db.exec('ALTER TABLE photos ADD COLUMN dhash_mtime TEXT');
    } catch (e) {}
    try {
      this.db.exec('ALTER TABLE photos ADD COLUMN dhash_size INTEGER');
    } catch (e) {}
    // dhash 索引
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_photos_dhash ON photos(dhash)');
    } catch (e) {}
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_photos_dhash_pending ON photos(id) WHERE dhash IS NULL OR TRIM(dhash) = ''",
      );
    } catch (e) {}
    // dHash 存量补充：覆盖索引让 ORDER BY file_path 无需回表
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_photos_dhash_backfill ON photos(file_path) WHERE has_thumbnail = 1 AND (dhash IS NULL OR TRIM(dhash) = '')",
      );
    } catch (e) {}
    // LSH 辅助表（WITHOUT ROWID 节省存储）
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS photo_dhash_lsh (
          photo_id INTEGER NOT NULL,
          band INTEGER NOT NULL,
          bucket INTEGER NOT NULL,
          PRIMARY KEY (photo_id, band),
          FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
        ) WITHOUT ROWID
      `);
    } catch (e) {}
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_lsh_lookup ON photo_dhash_lsh(band, bucket)');
    } catch (e) {}
    this._dhashSchemaDone = true;
  }

  /**
   * 写入 dHash 并同步更新 LSH 辅助表（同一事务）
   * @param {number} photoId
   * @param {string} dhash 16 位 hex
   * @param {number[]} buckets 16 个 4-bit 整数
   * @param {string} dateModified
   * @param {number} fileSize
   * @returns {{changes:number}}
   */
  updatePhotoDhash(photoId, dhash, buckets, dateModified, fileSize) {
    this.ensureDhashSchema();
    var id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return { changes: 0 };

    var self = this;
    var tx = this.db.transaction(function () {
      // 1. 更新 photos 表
      if (dhash == null || dhash === '') {
        self.db
          .prepare(
            'UPDATE photos SET dhash = NULL, dhash_mtime = NULL, dhash_size = NULL WHERE id = ?',
          )
          .run(id);
      } else {
        self.db
          .prepare('UPDATE photos SET dhash = ?, dhash_mtime = ?, dhash_size = ? WHERE id = ?')
          .run(
            String(dhash),
            dateModified != null ? String(dateModified) : null,
            Number(fileSize) || 0,
            id,
          );
      }
      // 2. 删除旧 LSH 记录（幂等：支持重新计算）
      self.db.prepare('DELETE FROM photo_dhash_lsh WHERE photo_id = ?').run(id);
      // 3. 插入新 LSH 记录（16 条）
      if (dhash != null && dhash !== '' && Array.isArray(buckets) && buckets.length === 16) {
        var insertLsh = self.db.prepare(
          'INSERT INTO photo_dhash_lsh (photo_id, band, bucket) VALUES (?, ?, ?)',
        );
        for (var band = 0; band < 16; band++) {
          insertLsh.run(id, band, buckets[band]);
        }
      }
    });
    tx();
    return { changes: 1 };
  }

  /** 第零层：dHash 精确重复的组列表（SQL GROUP BY，秒级） */
  getDuplicateDhashGroups(limit, offset) {
    this.ensureDhashSchema();
    var lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
    var off = Math.max(0, parseInt(offset, 10) || 0);
    return this.db
      .prepare(
        `SELECT dhash, COUNT(*) AS duplicate_count, SUM(file_size) AS total_size
         FROM photos
         WHERE dhash IS NOT NULL AND TRIM(dhash) != ''
         GROUP BY dhash
         HAVING COUNT(*) > 1
         ORDER BY duplicate_count DESC, dhash ASC
         LIMIT ? OFFSET ?`,
      )
      .all(lim, off);
  }

  /** 获取指定 dHash 的所有图片 */
  getPhotosByDhash(dhash) {
    this.ensureDhashSchema();
    var h = dhash != null ? String(dhash) : '';
    if (!h) return [];
    return this.db
      .prepare(
        // 与 `getPhotosByFileHash` 同一条约定：窄投影可以，但缩略图规格两列不能少
        // （这一侧的行会直接拼成 `thumb://<id>?v=…`）。
        `SELECT id, file_name, file_path, folder_path, file_size, date_modified,
                has_thumbnail, thumb_size, thumb_format, file_type
         FROM photos
         WHERE dhash = ?
         ORDER BY id ASC`,
      )
      .all(h);
  }

  /** 存量补充：有缩略图但无 dHash 的图片数量 */
  getDhashBackfillPhotoCount() {
    this.ensureDhashSchema();
    var row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM photos WHERE has_thumbnail = 1 AND (dhash IS NULL OR TRIM(dhash) = '')",
      )
      .get();
    return row && row.c != null ? Number(row.c) : 0;
  }

  /** 尚无 file_hash 的图片数量（非视频）；已有指纹的不重复计算 */
  _sqlNeedsFileHashExpr() {
    return "(file_hash IS NULL OR TRIM(file_hash) = '')";
  }

  getHashAllPhotoCount() {
    this.ensureDuplicateHashSchema();
    var row = this.db
      .prepare(
        'SELECT COUNT(*) AS c FROM photos WHERE ' +
          this._sqlFileTypeIsImageExpr() +
          ' AND ' +
          this._sqlNeedsFileHashExpr(),
      )
      .get();
    return row && row.c != null ? Number(row.c) : 0;
  }

  /**
   * 按 id **倒序**分批拉取「仍无哈希」的图片行（供主进程 runDuplicateHashDetection）。
   *
   * 🔴 **方向刻意是倒序的**（2026-10-05，与缩略图补全同一条策略）：用户导入新图片之后最想做的
   *    就是查重，而「刚加入的」正是 id 最大的那批；升序会让新导入的排在全部历史积压之后。
   *    查询写法与理由同 `getPhotosMissingThumbnailsBefore()`：两个方向都走主键区间扫描，
   *    一次完整跑的代价相同，倒序只是把有用的行提前。
   *
   * 🔴 游标与排序必须同向且单调：调用方取「本批最后一行的 id」续接（倒序下那是**最小** id）。
   */
  getHashAllPhotosBefore(beforeId, batchSize) {
    this.ensureDuplicateHashSchema();
    var bid = Math.max(0, parseInt(beforeId, 10) || 0);
    var lim = Math.max(1, Math.min(parseInt(batchSize, 10) || 2000, 5000));
    return this.db
      .prepare(
        `SELECT id, file_path, file_name, file_size, date_modified,
                file_hash, hash_mtime, hash_size
         FROM photos
         WHERE id < ? AND ` +
          this._sqlFileTypeIsImageExpr() +
          ' AND ' +
          this._sqlNeedsFileHashExpr() +
          `
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(bid, lim);
  }

  /**
   * 写入或清空 SHA-256；digest 为空则清空指纹列
   */
  updatePhotoHash(photoId, digest, dateModified, fileSize) {
    this.ensureDuplicateHashSchema();
    var id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return { changes: 0 };
    if (digest == null || digest === '') {
      return this.db
        .prepare(
          'UPDATE photos SET file_hash = NULL, hash_mtime = NULL, hash_size = NULL WHERE id = ?',
        )
        .run(id);
    }
    return this.db
      .prepare('UPDATE photos SET file_hash = ?, hash_mtime = ?, hash_size = ? WHERE id = ?')
      .run(
        String(digest),
        dateModified != null ? String(dateModified) : null,
        Number(fileSize) || 0,
        id,
      );
  }

  getDuplicateGroupCountByHash(minCount) {
    this.ensureDuplicateHashSchema();
    var mc = Math.max(2, parseInt(minCount, 10) || 2);
    var row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT file_hash FROM photos
           WHERE file_hash IS NOT NULL AND TRIM(file_hash) != ''
             AND ` +
          this._sqlFileTypeIsImageExpr() +
          `
           GROUP BY file_hash
           HAVING COUNT(*) >= ?
         )`,
      )
      .get(mc);
    return row && row.c != null ? Number(row.c) : 0;
  }

  /**
   * 每组至少 minCount 张且同 file_hash；带分页
   */
  getDuplicateGroupsByHash(limit, offset, minCount) {
    this.ensureDuplicateHashSchema();
    var lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
    var off = Math.max(0, parseInt(offset, 10) || 0);
    var mc = Math.max(2, parseInt(minCount, 10) || 2);
    return this.db
      .prepare(
        `SELECT file_hash,
                COUNT(*) AS duplicate_count,
                SUM(file_size) AS total_size
         FROM photos
         WHERE file_hash IS NOT NULL AND TRIM(file_hash) != ''
           AND ` +
          this._sqlFileTypeIsImageExpr() +
          `
         GROUP BY file_hash
         HAVING COUNT(*) >= ?
         ORDER BY duplicate_count DESC, file_hash ASC
         LIMIT ? OFFSET ?`,
      )
      .all(mc, lim, off);
  }

  /** 所有「重复组」内的图片总数（每组内多张都计入） */
  getDuplicatePhotoCountByHash(minCount) {
    this.ensureDuplicateHashSchema();
    var mc = Math.max(2, parseInt(minCount, 10) || 2);
    var row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cnt), 0) AS c FROM (
           SELECT COUNT(*) AS cnt FROM photos
           WHERE file_hash IS NOT NULL AND TRIM(file_hash) != ''
             AND ` +
          this._sqlFileTypeIsImageExpr() +
          `
           GROUP BY file_hash
           HAVING COUNT(*) >= ?
         )`,
      )
      .get(mc);
    return row && row.c != null ? Number(row.c) : 0;
  }

  getPhotosByFileHash(fileHash) {
    this.ensureDuplicateHashSchema();
    var h = fileHash != null ? String(fileHash) : '';
    if (!h) return [];
    return this.db
      .prepare(
        // 列清单窄是**刻意的**（重复项行只画「一张缩略图 + 文件名 + 路径 + 大小」）。
        // 但 `thumb_size` / `thumb_format` 不能少：重复项那一侧的 `<img>` 用的是
        // 缩略图缓存键（`renderer/utils.js#thumbCacheVersion`），少了规格就永远命中旧缓存。
        `SELECT id, file_name, file_path, folder_path, file_size, date_modified,
                has_thumbnail, thumb_size, thumb_format, file_type
         FROM photos
         WHERE file_hash = ?
         ORDER BY id ASC`,
      )
      .all(h);
  }

  addRootFolder(folderPath) {
    const name = path.basename(folderPath);
    const stmt = this.db.prepare('INSERT OR IGNORE INTO root_folders (path, name) VALUES (?, ?)');
    stmt.run(folderPath, name);
    /**
     * 🔴 **一律回表查 id，绝不用 `lastInsertRowid` 判断。**
     *
     * `sqlite3_last_insert_rowid()` 是**连接级**的「上一次成功插入的 rowid」，
     * `INSERT OR IGNORE` 真的被忽略时它**不会归零**，而是**保留上一次插入**（可能是别的表！）的值。
     * 于是重复登记一个已存在的根目录时，这里会返回一个**不属于 `root_folders` 的 id**
     * （比如上一批 photos 的 rowid）⇒ 之后每一行的写入都撞
     * `FOREIGN KEY constraint failed` ⇒ 扫描把**全部文件**静默跳过，只打一行 `SKIP (FK)`，
     * 用户看到的是「扫描完成，0 张」。
     *
     * ⚠️ 线上 worker 场景碰不到它（`scan-worker` 用新连接，`last_insert_rowid` 初始为 0，
     * 恰好是 falsy），但**同一个连接里先插过图片、再登记根目录**就会中招 ——
     * `scripts/scan-incremental-update-regression.js` 钉了这条（真跑：插一行 photos
     * 再重复 addRootFolder，第二次必须仍返回同一个 id）。
     */
    const row = this.db.prepare('SELECT id FROM root_folders WHERE path = ?').get(folderPath);
    return row ? row.id : null;
  }

  removeRootFolder(rootPath) {
    const normalizedPath = rootPath.replace(/\//g, '\\');
    const root = this.db.prepare('SELECT id FROM root_folders WHERE path = ?').get(normalizedPath);
    if (root) {
      this.db.prepare('DELETE FROM photos WHERE root_id = ?').run(root.id);
      this.db.prepare('DELETE FROM root_folders WHERE id = ?').run(root.id);
    }
  }

  getRootFolders(options = {}) {
    /** 仅 root_folders 表，不做 photos 聚合；管理页可先秒开列表再异步补统计 */
    if (options.lite === true) {
      var liteRows = this.db
        .prepare('SELECT id, path, name FROM root_folders ORDER BY name ASC')
        .all();
      if (liteRows && liteRows.length > 0) {
        for (var li = 0; li < liteRows.length; li++) {
          liteRows[li].photo_count = null;
          liteRows[li].folder_count = null;
          liteRows[li].video_count = null;
        }
        return liteRows;
      }
      /** lite 不再回退全表 photos 聚合（曾导致 get-root-folders 数十秒卡死）；无根目录行则空列表 */
      return [];
    }
    var aggRows = require('./db-heavy-read').runGetRootFoldersAgg(this.db, options);
    try {
      this.mergeRootFolderStatsCache(aggRows, options);
    } catch (eM) {
      void eM;
    }
    return aggRows;
  }

  getFolderTree(rootId) {
    return require('./db-heavy-read').runGetFolderTree(this.db, rootId);
  }

  getStats() {
    return require('./db-heavy-read').runGetStatsAgg(this.db);
  }

  getStartupDiagnostics() {
    var hasRootFolders = this.hasTable('root_folders');
    var hasPhotos = this.hasTable('photos');
    var rootCount = 0;
    var photoCount = 0;
    if (hasRootFolders) {
      var rc = this.db.prepare('SELECT COUNT(*) AS count FROM root_folders').get();
      rootCount = Number(rc && rc.count) || 0;
    }
    if (hasPhotos) {
      var pc = this.db.prepare('SELECT COUNT(*) AS count FROM photos').get();
      photoCount = Number(pc && pc.count) || 0;
    }
    return {
      hasRootFolders: hasRootFolders,
      hasPhotos: hasPhotos,
      rootCount: rootCount,
      photoCount: photoCount,
    };
  }

  togglePhotoFavorite(photoId) {
    const row = this.db.prepare('SELECT is_favorite FROM photos WHERE id = ?').get(photoId);
    if (!row) return null;
    const next = row.is_favorite ? 0 : 1;
    this.db.prepare('UPDATE photos SET is_favorite = ? WHERE id = ?').run(next, photoId);
    return { is_favorite: next };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 组织元数据：评分 / 标记 / 用户标签（2026-10-09）
  //
  // 三个维度与「收藏」的关系：收藏是**累积**语义（我喜欢的，长期不动），
  // 这三者是**工作流**语义（这一批我要哪些、这张够不够好、这张归哪个项目）。
  // 不要因为「都是用户写的标记」就把它们并成一个概念 —— 界面上是三个独立控件。
  // 完整契约见 `docs/contracts/org-metadata.md`。
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 设置评分（0 = 取消评分，1-5 = 星级）。
   *
   * 归一在 `normalizeRating()`（取值域的唯一定义处），越界值**夹取**而不抛错 ——
   * 理由写在那个函数上。返回 `null` 只在「这一行不存在」时发生（界面据此判断丢弃回包）。
   */
  setPhotoRating(photoId, rating) {
    const id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return null;
    const value = normalizeRating(rating);
    const info = this.db.prepare('UPDATE photos SET rating = ? WHERE id = ?').run(value, id);
    if (!info.changes) return null;
    return { id: id, rating: value };
  }

  /**
   * 设置标记（'none' / 'pick' / 'reject'）。
   *
   * 🔴 本方法**幂等**：传什么就是什么，无论当前是什么态。刻意**不做**「传同一个值就翻转」
   *    那种 toggle —— 冲片是盲操作（左手一路按 X 过片），toggle 会让「以为没按上、
   *    其实按上了」的再按一次把已经标好的行清掉，而用户当时正在看下一张，
   *    根本不知道上一张的标记没了。取消标记是**独立动作**（传 'none'），
   *    对应独立的键位与按钮。
   */
  setPhotoFlag(photoId, flag) {
    const id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return null;
    const value = normalizeFlag(flag);
    const info = this.db.prepare('UPDATE photos SET flag = ? WHERE id = ?').run(value, id);
    if (!info.changes) return null;
    return { id: id, flag: value };
  }

  /** 取某张图的全部标签（按名字不区分大小写排序，界面直接用）。 */
  getPhotoTags(photoId) {
    const id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return [];
    try {
      return this.db
        .prepare(
          `SELECT t.id AS id, t.name AS name
             FROM photo_tags pt
             JOIN tags t ON t.id = pt.tag_id
            WHERE pt.photo_id = ?
            ORDER BY t.name COLLATE NOCASE ASC`,
        )
        .all(id);
    } catch (e) {
      // 表还没建出来（老库首次启动、迁移尚未跑完）不许把预览打挂 —— 与 tag-nav 的
      // 「库不存在一律空结构、绝不抛」同一种取向。
      return [];
    }
  }

  /**
   * **全量替换**某张图的标签集合。返回替换后的完整集合。
   *
   * ## 为什么是全量替换而不是 add/remove
   *
   * 界面上标签是一组 chip，用户回车提交时手上就是完整的最终集合。拆成 diff 会让
   * 桌面端与网页端各写一套增删逻辑，而那一套必然在「同一个标签被快速连按两次」时
   * 分叉（第二下的 remove 打在第一下刚 add 出来的行上，结果取决于到达顺序）。
   * 全量替换天然没有这个问题：后到的提交整体覆盖先到的。
   *
   * ## 行为
   *
   * · 不存在的标签**自动创建** —— 用户打一个新标签不该先去别处建它。
   * · 归一后为空的项直接丢弃（用户敲了个空格又回车）。
   * · 按归一键去重，保留**第一次出现的原文写法**（「客户A」在前就不会被「客户a」覆盖）。
   * · 整体一个事务：半途失败留下「删了一半」比整个失败更难收拾。
   * · **不清理**「已无人使用」的标签：那会让用户刚建好、还没挂图的标签凭空消失。
   *   回收交给显式的 `deleteTag()`，标签列表里带使用计数，用户看得到哪些是 0 张。
   */
  setPhotoTags(photoId, names) {
    const id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return null;
    // 🔴 行不存在 ⇒ 返回 null，**与 `setPhotoRating` / `setPhotoFlag` 一致**
    //    （两个调用方都有对应的分支：`main.js` 回「图片记录不存在」、`web-server.js` 回 404）。
    //
    //    绝不能用「让外键报错」来代替这一次检查：`photo_tags.photo_id` 上的外键是**真开着**的
    //    （`better-sqlite3` 默认 `foreign_keys = 1`，`open()` 里又显式设了一次），
    //    所以往不存在的 id 上挂标签会抛 `FOREIGN KEY constraint failed` ——
    //    后果是上面那两个 `if (!result)` 分支**永不可达**，而用户拿到一句英文数据库错误
    //    （评分的路径同一情形给的是「图片记录不存在」）。2026-10-09 由
    //    `scripts/org-metadata-regression.js` 的真库夹具抓出。
    //
    //    另两个 setter 用 `info.changes` 判存在（更便宜，写入本身必然改行）；
    //    这里不行：一张图**本来就可能没有任何标签**，`changes === 0` 是合法结果，
    //    分不出「这张图没标签」与「这张图不存在」。所以只能显式查一次主键。
    if (!this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)) return null;
    const list = Array.isArray(names) ? names : [];
    // 归一 + 去重：Map 的 key 是归一键，value 是保留的显示名。
    const wanted = new Map();
    for (const raw of list) {
      const name = normalizeTagDisplayName(raw);
      if (!name) continue;
      const key = normalizeTagName(name);
      if (!key || wanted.has(key)) continue;
      wanted.set(key, name);
    }

    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(id);
      const findTag = this.db.prepare('SELECT id FROM tags WHERE normalized_name = ?');
      const insertTag = this.db.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)');
      const link = this.db.prepare(
        'INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)',
      );
      for (const entry of wanted) {
        const key = entry[0];
        const name = entry[1];
        let row = findTag.get(key);
        if (!row) {
          insertTag.run(name, key);
          // 🔴 回查而不是用 `lastInsertRowid`：本工程明令禁用它（见扫描写入那组契约）。
          //    UNIQUE 索引上的定点查询，成本可忽略。
          row = findTag.get(key);
        }
        if (row) link.run(id, row.id);
      }
    });
    run();
    return { id: id, tags: this.getPhotoTags(id) };
  }

  /**
   * 列出全部标签 + 各自被多少张照片使用（按使用量降序）。
   *
   * ⚠️ 计数用 `LEFT JOIN` + 聚合，**不要**写成「取在用的 tag_id 再去查」那种子查询：
   *    那样「0 张照片的标签」会被整个漏掉 —— 而用户恰恰需要看到它们才能决定删不删。
   */
  listTags() {
    try {
      return this.db
        .prepare(
          `SELECT t.id AS id, t.name AS name, COUNT(pt.photo_id) AS photo_count
             FROM tags t
             LEFT JOIN photo_tags pt ON pt.tag_id = t.id
            GROUP BY t.id, t.name
            ORDER BY photo_count DESC, t.name COLLATE NOCASE ASC`,
        )
        .all();
    } catch (e) {
      return [];
    }
  }

  /**
   * 重命名标签。归一后与别的标签撞名时**合并**到那个既有标签上（关联搬过去再删掉自己）。
   *
   * 🔴 合并而不是报错，是用户最自然的预期：「客户A」改名成「客户a」不该被拒绝说
   *    「已存在」—— 在他眼里那本来就是同一个标签（而且界面上的 chip 长得一模一样）。
   *    返回的 `id` 可能是**目标标签**的 id，调用方必须以返回值为准刷新列表。
   */
  renameTag(tagId, newName) {
    const id = parseInt(tagId, 10);
    if (!isFinite(id) || id <= 0) return null;
    const name = normalizeTagDisplayName(newName);
    const key = normalizeTagName(name);
    if (!key) return null;
    const run = this.db.transaction(() => {
      const target = this.db.prepare('SELECT id FROM tags WHERE normalized_name = ?').get(key);
      if (target && Number(target.id) === id) {
        this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
        return id;
      }
      if (target) {
        // 撞名 ⇒ 把本标签的全部关联搬到目标上（OR IGNORE 天然去重），再删掉本标签。
        this.db
          .prepare('UPDATE OR IGNORE photo_tags SET tag_id = ? WHERE tag_id = ?')
          .run(target.id, id);
        this.db.prepare('DELETE FROM photo_tags WHERE tag_id = ?').run(id);
        this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
        return Number(target.id);
      }
      this.db
        .prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?')
        .run(name, key, id);
      return id;
    });
    const outId = run();
    return { id: outId, name: name };
  }

  /**
   * 删除标签（连同它在 `photo_tags` 里的全部关联）。
   *
   * ⚠️ 关联**不手写删除**：`PRAGMA foreign_keys = ON` 是真开着的（见 `open()`），
   *    `photo_tags.tag_id` 上的 `ON DELETE CASCADE` 会处理。手写一遍会让「级联失效」
   *    这类故障被第二遍掩盖，从而只在别处（标签计数）才暴露。
   */
  deleteTag(tagId) {
    const id = parseInt(tagId, 10);
    if (!isFinite(id) || id <= 0) return false;
    const info = this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    return info.changes > 0;
  }

  getPhotos(options = {}) {
    const {
      sortBy = 'date_taken',
      sortOrder = 'DESC',
      page = 1,
      pageSize = 100,
      rootId,
      favoritesOnly,
      mediaType,
      lite = false,
    } = options;
    const offset = (page - 1) * pageSize;

    // `rating` 进排序白名单（2026-10-09）：按评分浏览是评分功能的主要用法之一
    // （「5 星的排前面看一遍」）。`rating` 有索引 ⇒ 退化成索引序扫描，不必临时排序。
    const allowedSort = [
      'date_taken',
      'date_modified',
      'file_name',
      'file_size',
      'folder_path',
      'rating',
    ];
    const order = allowedSort.includes(sortBy) ? sortBy : 'date_taken';
    const dir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const conditions = [];
    const params = [];

    if (rootId) {
      conditions.push('root_id = ?');
      params.push(rootId);
    }
    if (favoritesOnly) {
      conditions.push('is_favorite = 1');
    }
    this._pushMediaTypeCondition(conditions, mediaType);
    // 组织元数据三个筛选维度（评分 / 标记 / 标签）。与 `_buildPreviewScopeWhere`
    // 共用同一个收集器 ⇒ 预览里「上一张/下一张」的集合与浏览列表**必然一致**。
    this._pushOrgMetaConditions(conditions, params, options);

    const whereClause = 'WHERE 1=1' + (conditions.length ? ' AND ' + conditions.join(' AND ') : '');

    // 🔴 P0-1：`root_id = ? AND <媒体档谓词>` 形状的 COUNT 必须**钉住**已有的部分索引。
    //    规划器不会自己选它 —— 它以为 `idx_photos_root (root_id)` 更便宜。真库
    //    （1,656,580 行 / 14 GB）实测 root 23（912,222 行）：自选 71,617 ms、加 hint 275 ms
    //    （图片档）/ 10 ms（视频档），结果值逐个相同。差在 `idx_photos_root` 只含 `(root_id)`
    //    ⇒ 数 91 万行要回表 91 万次去读 `file_type`；部分索引把非目标档排除在索引之外。
    //    索引名与「存在才加」的判断都在 `db-heavy-read.js#mediaCountIndexHint`（唯一真相源）。
    //    ⚠️ hint 刻意**不进** `photosTotalCache` 的键：那个键的不变量是「同一条 SQL + 同一组
    //    参数 ⇒ 同一个数」，而 hint 只改执行计划、不改结果值；并进键反而会把同一份计数
    //    按索引状态拆成两条、白占条目。
    const countIndexHint = heavy.mediaCountIndexHint(
      this.db,
      rootId,
      mediaType,
    );

    // total 的记忆化见 `src/photos-total-cache.js`（为什么、键怎么取、失效两条腿都在那里）。
    // 一句话：真库默认参数下整条 42.3 ms 里 COUNT 占 38.2 ms，而它只随行数变化、翻页根本不变。
    const cachedTotal = photosTotalCache.get(whereClause, params);
    let totalCount;
    if (cachedTotal != null) {
      totalCount = cachedTotal;
    } else {
      const totalRow = this.db
        .prepare(`SELECT COUNT(*) as count FROM photos${countIndexHint} ${whereClause}`)
        .get(...params);
      totalCount = Number(totalRow.count) || 0;
      photosTotalCache.set(whereClause, params, totalCount);
    }
    // 列清单唯一真相源（含 thumb_size / thumb_format —— 浏览层的缓存键要用）
    const photoCols = photoListColumns({ lite: lite });
    const photos = this.db
      .prepare(
        `SELECT ${photoCols}
       FROM photos ${whereClause}
       ORDER BY ${order} ${dir} NULLS LAST
       LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, offset);
    this.applyNaturalNameTieSort(photos, order, dir);

    // 将 better-sqlite3 row 对象转为纯 JS 对象，避免 IPC 克隆失败
    const plainPhotos = photos.map(function (row) {
      var obj = {};
      for (var key in row) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          obj[key] = row[key];
        }
      }
      return obj;
    });

    return {
      photos: plainPhotos,
      total: totalCount,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(totalCount / Number(pageSize)),
    };
  }

  _normalizePreviewSort(sortBy, sortOrder) {
    var allowedSort = ['date_taken', 'date_modified', 'file_name', 'file_size'];
    var order = allowedSort.includes(sortBy) ? sortBy : 'date_taken';
    var dir = String(sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    return { order, dir };
  }

  _buildPreviewScopeWhere(options = {}) {
    var where = [];
    var params = [];
    var view = String(options.view || 'all');
    var media = String(options.mediaType || 'all').toLowerCase();

    if (view === 'root') {
      var rootId = parseInt(options.rootId, 10);
      if (isFinite(rootId) && rootId > 0) {
        where.push('root_id = ?');
        params.push(rootId);
      }
    } else if (view === 'folder') {
      var folderPath = options.path ? String(options.path) : '';
      if (folderPath) {
        var normalizedPath = folderPath.replace(/\//g, '\\');
        var incSubPrev = options.includeSubfolders !== false;
        if (incSubPrev) {
          // GLOB 是大小写敏感的，可以走 idx_photos_folder 索引
          where.push('(folder_path = ? OR folder_path GLOB ?)');
          params.push(normalizedPath, normalizedPath + '\\*');
        } else {
          where.push('folder_path = ?');
          params.push(normalizedPath);
        }
      }
    } else if (view === 'date') {
      var d = options.date ? String(options.date) : '';
      if (d) {
        // 范围查询替代 date(date_taken) = ?，让索引生效
        where.push('date_taken >= ? AND date_taken < ?');
        params.push(d, heavy.nextCalendarDate(d));
      }
    } else if (view === 'search') {
      var q = options.q ? String(options.q) : '';
      if (q) {
        if (this.isFtsIndexReady()) {
          var ftsQ = this._buildFtsQuery(q);
          if (ftsQ) {
            where.push('photos.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)');
            params.push(ftsQ);
          }
        } else {
          var term = '%' + q + '%';
          where.push('(file_name LIKE ? OR folder_path LIKE ?)');
          params.push(term, term);
        }
      }
    } else if (view === 'favorites') {
      where.push('is_favorite = 1');
    }

    if (media === 'image') {
      where.push(this._sqlFileTypeIsImageExpr());
    } else if (media === 'video') {
      // 🔴 与 `_pushMediaTypeCondition` **同一套判据**（含 Live Photo 伴生视频的排除）。
      //    这里原先硬编码了第二份扩展名清单 —— 与 `_sqlFileTypeIsVideoExpr()` 逐字相同，
      //    但两份各自演化：任何一边增删格式（上一轮加 `.tga` 那批时就差点漏掉这里）
      //    都会让「预览里上一张/下一张」的集合与「浏览列表」分叉。
      where.push(this._sqlNotLiveStillIsMotionExpr());
      where.push(this._sqlFileTypeIsVideoExpr());
    } else if (view !== 'search') {
      // `all` 档：🔴 判据不是「哪个档」，而是「**产出当前列表的那个函数**加了什么」——
      //    本函数存在的唯一理由就是让预览作用域与列表集合一致，否则出现
      //    「列表里有这张卡、预览却跳不到它」（`app.js` 的上一张/下一张会当场露馅）。
      //      · 列表来自 `getPhotos` / `getFolderPhotos`（root / folder / date / all 视图）
      //        ⇒ 那边会排伴生视频 ⇒ 这里跟着排；
      //      · 列表来自 `searchPhotos`（`view === 'search'`）⇒ 那边**刻意不排**
      //        （理由见那边的调用点）⇒ 这里也必须不排。
      //    两边的排除条件都来自同一个 `heavy.liveCompanionExcludeCondition`、
      //    走同一个「索引就绪才排」的闸门 ⇒ 状态天然同步，不会一边加一边不加。
      var liveExclude = heavy.liveCompanionExcludeCondition(this.db);
      if (liveExclude) where.push(liveExclude);
    }

    // 组织元数据三维度（评分 / 标记 / 标签）：与 `getPhotos` **共用同一个收集器**
    // ⇒ 预览里「上一张 / 下一张」翻到的集合与浏览列表筛出来的必然一致。
    // 这是本函数存在的唯一理由的又一处应用（同一段道理，见上面 liveExclude 的注释）：
    // 一旦这里漏加，症状是「列表筛出 5 张、预览却能翻到第 6 张」——
    // 只在按左右键翻到边界时才看得出来，而且不报错。
    // 🔴 新增筛选维度时，`getPhotos` 与这里必须**同时**接上同一个收集器。
    this._pushOrgMetaConditions(where, params, options);

    return {
      whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '',
      params: params,
    };
  }

  /**
   * 随机幻灯批次：在预览作用域内一次取最多 limit 张（默认 100），供前端打乱后顺序播放。
   * 使用 ORDER BY RANDOM() 仅每批一次，而非每张换片一次。
   *
   * ⚠️ 这条语句必须写成**两段式**（先在子查询里随机取 id，再按 id 回表），不能写成一趟
   * `SELECT <12 列> FROM photos WHERE ... ORDER BY RANDOM() LIMIT n`。原因在真库上量得很清楚：
   * `photos` 的 `thumbnail` BLOB 内联在行中间（见 createCoreSchema），4 KB 以上的缩略图走溢出页，
   * 整表扫描要把十几 GB 读一遍；而 `ORDER BY RANDOM()` 又强制把**所有**行先物化进临时 B 树。
   * 实测 122 万行 / 12.97 GB 的库（`ORDER BY RANDOM() LIMIT 100`）：
   *
   * | 写法 | 全部 | 仅图片 | 排除 80 个 id |
   * | --- | ---: | ---: | ---: |
   * | 一趟式 | 3742 ms | 629 ms | 3807 ms |
   * | 两段式 | 100 ms | 166 ms | 254 ms |
   *
   * 计划也印证了：一趟式是 `SCAN photos + USE TEMP B-TREE FOR ORDER BY`，两段式的内层
   * `SELECT id FROM photos` 能吃到只含 id 的覆盖索引（`idx_photos_root` / `idx_photos_folder` /
   * 部分索引），排序只在小索引上做，外层再走主键回表——只碰命中那 n 行。
   * **随机性是同一份**：内层仍是均匀无放回的 `ORDER BY RANDOM() LIMIT n`，集合语义与原来逐位相同
   * （调用方本来就只关心集合，取回后自己洗牌，见 web 端 `shuffleWebSlideshowBatch`）。
   */
  getRandomPreviewPhotoBatch(options = {}) {
    var limit = parseInt(options.limit, 10);
    if (!isFinite(limit) || limit <= 0) limit = 100;
    if (limit > 500) limit = 500;
    var scope = this._buildPreviewScopeWhere(options);
    var whereSql = scope.whereSql;
    var qp = scope.params.slice();
    var excludeIds = Array.isArray(options.excludeIds) ? options.excludeIds : [];
    var validEx = [];
    for (var i = 0; i < excludeIds.length && validEx.length < 80; i++) {
      var eid = parseInt(excludeIds[i], 10);
      if (isFinite(eid) && eid > 0) validEx.push(eid);
    }
    var condParts = [];
    if (whereSql) {
      condParts.push(whereSql.replace(/^WHERE\s+/i, ''));
    }
    if (validEx.length) {
      condParts.push(
        'id NOT IN (' +
          validEx
            .map(function () {
              return '?';
            })
            .join(',') +
          ')',
      );
      for (var j = 0; j < validEx.length; j++) qp.push(validEx[j]);
    }
    var cond = condParts.length ? 'WHERE ' + condParts.join(' AND ') : 'WHERE 1=1';
    var countSql = 'SELECT COUNT(*) as c FROM photos ' + cond;
    var cntRow = this.db.prepare(countSql).get(...qp);
    var total = cntRow && cntRow.c != null ? Number(cntRow.c) : 0;
    if (!isFinite(total) || total <= 0) return [];
    var n = Math.min(limit, total);
    var cols = photoListColumns();
    // 两段式：内层只排 id（走覆盖索引，不读胖行），外层按主键取列表列。见方法注释里的实测表。
    var sql =
      'SELECT ' +
      cols +
      ' FROM photos WHERE id IN (SELECT id FROM photos ' +
      cond +
      ' ORDER BY RANDOM() LIMIT ?)';
    var qall = qp.slice();
    qall.push(n);
    return this.db.prepare(sql).all(...qall) || [];
  }

  getPreviewAdjacentPhoto(options = {}) {
    var currentId = parseInt(options.currentId, 10);
    if (!isFinite(currentId) || currentId <= 0) return null;
    var mode = String(options.mode || 'sequential').toLowerCase();
    var direction = String(options.direction || 'next').toLowerCase() === 'prev' ? 'prev' : 'next';
    var sortMeta = this._normalizePreviewSort(options.sortBy, options.sortOrder);
    var order = sortMeta.order;
    var dir = sortMeta.dir;
    var scope = this._buildPreviewScopeWhere(options);
    var whereSql = scope.whereSql;
    var params = scope.params.slice();

    var current = this.db
      .prepare(
        `SELECT id, file_name, file_size, date_taken, date_modified
         FROM photos
         WHERE id = ?`,
      )
      .get(currentId);
    if (!current) return null;

    var currentOrderValue = current[order];
    var currentName = current.file_name != null ? String(current.file_name) : '';
    var cmpIsAsc = direction === 'next' ? dir === 'ASC' : dir !== 'ASC';
    var cmpOp = cmpIsAsc ? '>' : '<';
    var sortDir = cmpIsAsc ? 'ASC' : 'DESC';
    var wrapDir = sortDir;
    var orderExpr = order === 'file_size' ? `COALESCE(${order}, 0)` : `COALESCE(${order}, '')`;
    var currentOrderCmp =
      order === 'file_size' ? Number(currentOrderValue || 0) : String(currentOrderValue || '');

    if (mode === 'random') {
      var seed = parseInt(options.seed, 10);
      if (!isFinite(seed)) seed = 1;
      seed = Math.abs(seed % 2147483647);
      if (seed === 0) seed = 1;
      var scoreExpr = `((CAST(id AS INTEGER) * 1103515245 + ${seed}) & 2147483647)`;
      var currentScore = ((currentId * 1103515245 + seed) & 2147483647) >>> 0;
      var randWhereSql = whereSql ? whereSql + ' AND ' : 'WHERE ';
      // 拆成两段查询，避免 (a OR b) 干扰优化器，且第二段仅按 id 排序
      var randSql1 = `
        SELECT ${photoListColumns()}
        FROM photos
        ${randWhereSql} (${scoreExpr} > ?)
        ORDER BY ${scoreExpr} ASC, id ASC
        LIMIT 1
      `;
      var randRow = this.db.prepare(randSql1).get(...params, currentScore);
      if (!randRow) {
        var randSql2 = `
          SELECT ${photoListColumns()}
          FROM photos
          ${randWhereSql} (${scoreExpr} = ? AND id > ?)
          ORDER BY id ASC
          LIMIT 1
        `;
        randRow = this.db.prepare(randSql2).get(...params, currentScore, currentId);
      }
      if (randRow) return randRow;
      // 环绕到「序首」：用 MIN(score) 聚合 + 同分最小 id，避免全表 ORDER BY 排序卡死主进程
      var minScoreSql = `SELECT MIN(${scoreExpr}) AS m FROM photos ${whereSql}`;
      var minScoreRow = this.db.prepare(minScoreSql).get(...params);
      var minScore =
        minScoreRow && minScoreRow.m != null && minScoreRow.m !== '' ? minScoreRow.m : null;
      if (minScore == null) return null;
      var randWrapPickSql = `
        SELECT ${photoListColumns()}
        FROM photos
        ${randWhereSql} (${scoreExpr} = ?)
        ORDER BY id ASC
        LIMIT 1
      `;
      return this.db.prepare(randWrapPickSql).get(...params, minScore) || null;
    }

    var baseWhereSql = whereSql ? whereSql + ' AND ' : 'WHERE ';
    var nextWhereSql =
      baseWhereSql +
      `(
        (${orderExpr} ${cmpOp} ?)
        OR (${orderExpr} = ? AND COALESCE(file_name, '') ${cmpOp} ?)
        OR (${orderExpr} = ? AND COALESCE(file_name, '') = ? AND id ${cmpOp} ?)
      )`;
    var rowSql = `
      SELECT ${photoListColumns()}
      FROM photos
      ${nextWhereSql}
      ORDER BY ${orderExpr} ${sortDir}, COALESCE(file_name, '') ${sortDir}, id ${sortDir}
      LIMIT 1
    `;
    var seqRow = this.db
      .prepare(rowSql)
      .get(
        ...params,
        currentOrderCmp,
        currentOrderCmp,
        currentName,
        currentOrderCmp,
        currentName,
        currentId,
      );
    if (seqRow) return seqRow;

    var seqWrapSql = `
      SELECT ${photoListColumns()}
      FROM photos
      ${whereSql}
      ORDER BY ${orderExpr} ${wrapDir}, COALESCE(file_name, '') ${wrapDir}, id ${wrapDir}
      LIMIT 1
    `;
    return this.db.prepare(seqWrapSql).get(...params) || null;
  }

  getFolderPhotos(folderPath, options = {}) {
    const {
      sortBy = 'file_name',
      sortOrder = 'ASC',
      page = 1,
      pageSize = 100,
      favoritesOnly,
      mediaType,
      lite = false,
      includeSubfolders = true,
    } = options;
    const offset = (page - 1) * pageSize;
    const dir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    // `rating` 与 `getPhotos` 的白名单保持一致（2026-10-09）：目录页也能按评分排。
    const allowedSort = ['date_taken', 'date_modified', 'file_name', 'file_size', 'rating'];
    const order = allowedSort.includes(sortBy) ? sortBy : 'file_name';

    // 标准化路径：统一使用反斜杠（Windows）
    const normalizedPath = folderPath.replace(/\//g, '\\');
    const incDesc = includeSubfolders !== false;
    // GLOB 是大小写敏感的，可以走 idx_photos_folder 索引
    // LIKE 默认大小写不敏感（ASCII），与 BINARY 索引不匹配会导致全表扫描
    const pathBindArgs = incDesc ? [normalizedPath, normalizedPath + '\\*'] : [normalizedPath];

    const mediaConds = [];
    this._pushMediaTypeCondition(mediaConds, mediaType);
    // 🔴 **`join(' AND ')`，不是 `mediaConds[0]`**（2026-10-06 修）。
    //    `_pushMediaTypeCondition` 在 `video` 档会 push **两条**（排除伴生视频 + 视频扩展名），
    //    只取第一条 = 丢掉 `file_type` 谓词 = 「视频」档把**图片也列出来**。
    //    实测（夹具 6 jpg + 4 mp4 + 1 mov + 1 伴生 MOV）：本函数 `video` 档返回 11 行（应为 5），
    //    而同参数的 `getPhotos`（用 `join(' AND ')`）正确返回 5 —— 两处不一致正是这个 `[0]`。
    //    改为 `join` 对 `image` 档是恒等变换（那是单条），所以没有副作用。
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds.join(' AND ') : '';

    // 组织元数据筛选（2026-10-09）：与 `getPhotos` **同一个条件收集器**。
    // 🔴 不补这一处的症状是「总览页筛了、点进目录却没筛」—— 用户以为自己看的是
    //    「仅 5 星」，其实目录页给的是全部。不报错、不写日志，纯粹静默不一致。
    //    作用域口径见 `docs/contracts/org-metadata.md`「筛选作用域」章。
    const orgConds = [];
    const orgParams = [];
    this._pushOrgMetaConditions(orgConds, orgParams, options);
    const orgSql = orgConds.length ? ' AND ' + orgConds.join(' AND ') : '';
    // 绑定顺序必须与 SQL 里占位符出现顺序一致：路径两条 → 收藏 → 组织元数据。
    const bindArgs = pathBindArgs.concat(orgParams);

    const baseWhereSql = incDesc ? '(folder_path = ? OR folder_path GLOB ?)' : 'folder_path = ?';
    const whereSql = favoritesOnly
      ? `${baseWhereSql} AND is_favorite = 1${mediaSql}${orgSql}`
      : `${baseWhereSql}${mediaSql}${orgSql}`;
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
      .get(...bindArgs);
    const video = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM photos
         WHERE ${whereSql}
           AND lower(replace(file_type, '.', '')) IN
             ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')`,
      )
      .get(...bindArgs);
    // 列清单唯一真相源（含 thumb_size / thumb_format —— 浏览层的缓存键要用）
    const photoCols = photoListColumns({ lite: lite });
    const photos = this.db
      .prepare(
        `SELECT ${photoCols}
       FROM photos WHERE ${whereSql}
       ORDER BY ${order} ${dir}
       LIMIT ? OFFSET ?`,
      )
      .all(...bindArgs, pageSize, offset);
    this.applyNaturalNameTieSort(photos, order, dir);

    // 将 better-sqlite3 row 对象转为纯 JS 对象，避免 IPC 克隆失败
    var plainPhotos = photos.map(function (row) {
      var obj = {};
      for (var key in row) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          obj[key] = row[key];
        }
      }
      return obj;
    });

    return {
      photos: plainPhotos,
      total: Number(total.count),
      videoCount: video ? Number(video.count) : 0,
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(Number(total.count) / Number(pageSize)),
    };
  }

  getDateGroups(options = {}) {
    const { rootId, sortOrder = 'desc' } = options;
    const dir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    let whereClause = 'WHERE date_taken IS NOT NULL';
    const params = [];

    if (rootId) {
      whereClause += ' AND root_id = ?';
      params.push(rootId);
    }

    return this.db
      .prepare(
        `
      SELECT date(date_taken) as date, COUNT(*) as count
      FROM photos ${whereClause}
      GROUP BY date(date_taken)
      ORDER BY date ${dir}
    `,
      )
      .all(...params);
  }

  getDatePhotos(dateStr, options = {}) {
    const result = require('./db-heavy-read').runGetDatePhotos(this.db, dateStr, options);
    this.applyNaturalNameTieSort(
      result.photos,
      options.sortBy || 'file_name',
      options.sortOrder || 'ASC',
    );
    return result;
  }

  /**
   * 取某行的缩略图 BLOB **连同它的编码格式**。
   *
   * 🔴 `format` 不是可有可无的附加信息，它是**服务端唯一能知道该回哪个 `Content-Type` 的来源**：
   *    两个服务层（桌面 `thumb://` 协议、网页端 `/thumb/:id`、安卓端走同一条）都只能从库里的
   *    `thumb_format` 派生响应头。这里少带一个字段 ⇒ 那两处就只能硬编码 `image/jpeg` ⇒
   *    库里一旦出现 WebP 行，发出去的就是「字节是 WebP、头写着 JPEG」，浏览器**不报错、
   *    只是不解码**（页面上一片空白，最难查的一类）。
   *    ⇒ 改这条 SELECT 的列清单时把它当契约改，守护见 `thumbnail-spec-regression` 第 4 组。
   *
   * ⚠️ `format` 可能是 `''`（未知：本列引入之前的存量行）或白名单外的脏值，调用端**一律**
   *    过 `thumbMimeType()`，不要自己比字符串 —— 存量行实测全是 JPEG，回落是 `image/jpeg`。
   *
   * @returns {{thumbnail: Buffer, format: string}|null}
   */
  getThumbnail(photoId) {
    var photo = this.db
      .prepare('SELECT thumbnail, has_thumbnail, thumb_format FROM photos WHERE id = ?')
      .get(photoId);

    if (!photo) return null;

    if (photo.has_thumbnail && photo.thumbnail) {
      return { thumbnail: photo.thumbnail, format: normalizeThumbFormat(photo.thumb_format) };
    }
    return null;
  }

  getMissingThumbnailCount() {
    var row = this.db
      .prepare('SELECT COUNT(*) as count FROM photos WHERE ' + this._sqlBackfillPendingExpr())
      .get();
    return row ? row.count : 0;
  }

  /**
   * 「还缺缩略图」的图片数 —— 补全进度的**副指标**（「预览图 +N / 共 M」里的 M）。
   *
   * 🔴 它**刻意不与** `getMissingThumbnailCount()` 同源，两者回答的是两个问题：
   *    - `getMissingThumbnailCount()` / `estimatePendingCandidateCount()` = **任务候选集**
   *      （缺缩略图 / 缺 dHash / 缺尺寸 / 没看过 EXIF）= 「这个任务还有多少活要干」，
   *      必须与 `_sqlBackfillPendingExpr()` 同源；
   *    - 本方法 = 「还差几张预览图」。
   *
   * 🔴 **主进度条的分子 / 分母都不是它**（分子 = 已处理行数、分母 = 候选集估计值，
   *    见 `estimatePendingCandidateCount()`）。这是 2026-10-06 用真实库翻掉的一个错判：
   *    当初的推理是「用户等的是图 ⇒ 分母就该是缩略图」，并预测进度条会停在 22%。
   *    实测把两个前提都推翻了 ——
   *      ① 候选集约 156 万行里，真正缺缩略图的只有 **339,913**；
   *      ② 补全按 id **倒序**走（最新入库优先），而缺缩略图的行**几乎全压在低位老图片**上：
   *         `id 1,900,000~1,999,999` 只有 **10 行**缺，`1,600,000~1,899,999` 才是那 33.9 万。
   *    于是任务从 `MAX(id)` 往下走的**头 2 万行里缺缩略图的是 0 行** ⇒ 分子恒 0、
   *    分母 339,913 ⇒ 进度条在 **0%** 上趴了十几分钟一动不动，用户看到的是「卡住了」。
   *    ⚠️ 所以主口径必须是「已处理行数 / 候选集规模」：它与任务真正的工作量对齐，
   *    百分比与剩余时间都跟着它走。本方法退居副指标。
   *
   * 🔴 正因为谓词只有 `has_thumbnail = 0` 一列，它才负担得起「每轮补全都算一次」：
   *    走 `idx_photos_hasThumb` 的 **covering index**，零回表。本机实测 **16 ms**；
   *    对照 `getMissingThumbnailCount()` 是 **76 秒级**（`SCAN photos` + 每行穿过缩略图
   *    BLOB 的溢出页链回表取 `dhash` / `width` / `file_type` / `exif_mtime`）。
   *    `EXPLAIN` 证据钉在 `scripts/thumb-backfill-progress-regression.js`。
   *
   * ⚠️ 语义是**快照**：调用方（`runThumbnailBackfill`）在任务开始时取一次当副指标的 M，
   *    跑动期间不再刷新 —— 并发入库的新图片不在里面，所以分子可能反超分母，两个方向都由调用方夹住。
   * ⚠️ `has_thumbnail IS NULL` 的行两边都不计入（`_sqlBackfillPendingExpr()` 同样只判 `= 0`）。
   *
   * ⚠️ **刻意含「已盖章失败」的行**（2026-10-06 补记）：谓词只有 `has_thumbnail = 0` 一列，
   *    不问 `thumb_fail_mtime`。所以这个数比「还会出图的张数」**偏大**，
   *    副作用是副行的 `预览图 N / 待补 M` 可能永远差着那几十张。
   *    **这是有意的取舍，别去「修」**：多引用 `thumb_fail_mtime` + `date_modified` 就要求回表，
   *    covering index 直接失效（14 ms → 339,913 次回表），而它是在任务面板里每轮刷新都调的。
   *    真正需要「待补」精确值的地方走 `getPhotosLackingThumbnailBefore()`（那份谓词带失败记账）。
   */
  countPhotosLackingThumbnail() {
    var row = this.db
      .prepare('SELECT COUNT(*) as count FROM photos WHERE has_thumbnail = 0')
      .get();
    return row && row.count != null ? Number(row.count) : 0;
  }

  /**
   * 抽样估计「补全候选集」的规模 —— 补全主进度条的**分母**。
   *
   * 🔴 为什么是抽样、而不是精确 `COUNT(*)`：
   *    候选谓词（`_sqlBackfillPendingExpr()`）判的列（`dhash` / `width` / `file_type` /
   *    `exif_mtime` / `exif_ver`）**一个索引都没有** ⇒ 精确计数只能 `SCAN photos`。
   *    本机真实库（1,656,580 行 / 14.17 GB）实测 **80~95 秒**；而且那还只是「与正在跑的
   *    补全任务抢同一块盘」的量级 —— 补全此刻正在逐张读图，再压一次全表扫，两头都慢。
   *    进度分母不值得让用户等一分半，更不值得把补全本身拖慢。
   *
   * 🔴 抽样沿 **id 轴均匀铺点**、每个点走主键点查（`WHERE id = ?`），不是 `id % k = 0` ——
   *    后者同样要扫全表，等于没省。
   *
   * 🔴 点查「不存在的 id」**不计入样本**，而不是记成「未命中」：`id` 有空洞（删除过的行），
   *    把空洞算成未命中会让命中率偏低 ⇒ 估计值偏小 ⇒ 分母偏小 ⇒ **百分比偏高、剩余时间
   *    偏乐观**，是方向最坏的那种偏差。只对**真实存在的行**算命中率，估计才无偏。
   *
   * ⚠️ 结果是**估计值**（不是真值）：本机 2000 样本 × 命中率 ~94% 下，标准误约
   *    ±0.5%（相对），分母 156 万上的绝对误差约 ±8 千行。UI 必须带「约」。
   *    UI 侧还要把分子夹在分母之内（并发入库会让分子反超）。
   * ⚠️ 语义同样是**起始快照**，跑动期间不刷新。
   *
   * ~2000 次主键点查，本机实测亚秒级（对照精确计数的 80 秒）。
   */
  estimatePendingCandidateCount(samples) {
    var want = Number(samples);
    if (!isFinite(want) || want <= 0) want = 2000;
    want = Math.max(50, Math.min(20000, Math.round(want)));
    var head = this.db.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM photos').get();
    var total = head && head.c != null ? Number(head.c) : 0;
    var maxId = head && head.m != null ? Number(head.m) : 0;
    if (total <= 0 || maxId <= 0) {
      return { total: total, sampled: 0, hits: 0, estimate: total };
    }
    var step = Math.max(1, Math.floor(maxId / want));
    var hitStmt = this.db.prepare(
      'SELECT (' + this._sqlBackfillPendingExpr() + ') AS hit FROM photos WHERE id = ?',
    );
    var sampled = 0;
    var hits = 0;
    for (var id = step; id <= maxId; id += step) {
      var row = hitStmt.get(id);
      if (!row) continue; // id 空洞：这个 id 上没有行，不计入样本（见上面的注释）
      sampled++;
      if (Number(row.hit) === 1) hits++;
    }
    return {
      total: total,
      sampled: sampled,
      hits: hits,
      estimate: sampled > 0 ? Math.round((hits / sampled) * total) : total,
    };
  }

  /**
   * 取 `id < beforeId` 的待补行（缺缩略图 / 缺 dHash / 缺原图尺寸）中 **id 最大**的一批
   * —— 即**最新入库的优先补**。
   *
   * 🔴 **方向刻意是倒序的**（2026-10-05）：补全的可见收益只落在「用户刚导入、正在翻看」的
   *    那批图片上，而它们正是 id 最大的那批。升序会让刚导入的图片排在**全部历史积压之后**，
   *    用户扫完一个新目录却要等老行全部补完才看到图。本机真实库（1,656,594 行，
   *    id ∈ [324737, 1981503]，待补 1,556,474 行）实测首批 100 行：升序 **269ms**
   *    （低位区间命中率仅 ~7%，每命中 1 行要跳十几行）、倒序 **2ms**（高位区间几乎 100% 命中）。
   *    两个方向都走 `SEARCH photos USING INTEGER PRIMARY KEY`（谓词用不上索引），
   *    所以**一次完整跑的代价相同**，倒序只是把有用的行提前，不是「更快」而是「更早看见」。
   *
   * 🔴 游标必须与排序**同向且单调**：本方法配 `ORDER BY id DESC`，上层取「本批最后一行的 id」
   *    续接 —— 倒序下最后一行是**最小** id，于是游标严格递减。方向写反或游标不推进，
   *    都会让同一轮对刚失败的那些行反复重试（死循环）。
   *
   * ⚠️ `dhash` / `width` / `height` **必须出现在 SELECT 里**：上层靠它们判断
   *    「这次命中只是因为缺尺寸」，从而跳过 `computeDhash`（整图解码）与重复的
   *    metadata 读取 —— 少了这三列，每一行都会被白解码一遍。
   *
   * ⚠️ `file_hash` 同理，别顺手删：`processOne` 靠它判断**这行的查重指纹算过没**，
   *    从而决定要不要在下一次读盘里顺带把 SHA-256 也算出来（见那里的注释）。
   *    少了它 ⇒ 每行都判成「缺指纹」⇒ 对**全库候选**反复重算 SHA-256，不报错、只是白烧读盘。
   *
   * ⚠️ `exif_mtime` 与 `exif_ver` 也必须带上：`processOne` 靠它们判断**这行的拍摄参数
   *    看过没、看的是第几版**（`photoNeedsExif()`），决定要不要在**同一次**
   *    `sharp.metadata()` 里顺手解析 EXIF。少了它们 ⇒ 判据走兜底 ⇒ 要么每行都判成
   *    「没看过」对全库反复写同一批 null，要么把「旧版看过」的行整段跳过、新列永远补不上。
   *
   * 🔴 `dhash` 与 `file_hash` 都是**延迟迁移列**，靠 `runThumbnailBackfill` 开跑前那次
   *    `dbWriteQueue.run` 里的 `ensureDhashSchema()` + `ensureDuplicateHashSchema()` 保证存在。
   *    老库上少了任一列，这条 SELECT 直接 `no such column`（在**第一次取批**时炸，不是启动时）。
   *    ⚠️ `exif_mtime` / `exif_ver` **不在这条路上**：它们由 `init()` 同步加
   *    （见 `ensurePhotosExifColumn()`），因为被随时可调的只读谓词引用，不能等到任务开跑。
   *
   * 🔴 SELECT 列表与 `_sqlBackfillPendingExpr()` **同生共死**：谓词里判了哪一列，
   *    这里就必须取出来 —— `processOne` 的 `needSize` / `needDhash` / `needExif`
   *    （后者见 `photoNeedsExif()`）全靠这几个字段做决定。少取一列不报错，
   *    而是**那条判据永远走兜底分支**：漏了 `exif_ver` 时，扩列前跑过的行会被判成
   *    「已看过」而整段跳过 —— 行留在候选集里、每轮被取出来、每轮被跳过，
   *    新列永远补不上（本机实测 9,799 行落在这条死路上）。
   *
   * ⚠️ 视频的 dHash 恒为 `NULL` ⇒ 会长期留在候选集里（但 `processOne` 立刻跳过），
   *    代价只是一次索引命中，可接受。见 `_sqlBackfillPendingExpr()` 的注释。
   */
  getPhotosMissingThumbnailsBefore(beforeId, limit) {
    // 🔴 WHERE 里那个 `_sqlBackfillPendingCoreExpr()` 是**逻辑冗余**的（`_sqlBackfillPendingExpr()`
    //    蕴含它）—— 它的唯一作用是让规划器能用上部分索引 `idx_photos_backfill_pending`。
    //
    //    不做这一步的代价（真库实测，2026-10-07）：计划是 `SEARCH photos USING INTEGER PRIMARY KEY
    //    (rowid<?)` ⇒ **谓词完全用不上索引**，代价 = 游标到第一个命中行的**距离**而不是批大小。
    //    真库 id 1,181,504 以上 80 万行「候选 = 0」（早补完了），而本趟每轮都从 `MAX(id)+1`
    //    起手 ⇒ **每轮白扫 75.7 万行回表 = 159,601 ms，跑在主进程 ⇒ 界面卡死两分半**
    //    （`eventLoop.maxDelayMs = 159699`）。加上这个合取项后，倒序扫的是**部分索引**：
    //    收敛区里它一个条目都没有 ⇒ 零回表、凑满即停。
    //
    //    ⚠️ 这一串必须与索引 WHERE **逐字相同**（同一份常量 ⇒ 天然相同），
    //       差一个字符就是静默退回上面那个全表扫。
    //    ⚠️ 它**不是**闸门：无论索引在不在，加上它结果都一样（逻辑冗余）⇒ 不需要 `hasIndex` 判。
    return this.db
      .prepare(
        `SELECT id, file_path, file_size, date_modified, has_thumbnail, dhash, width, height,
                file_hash, exif_mtime, exif_ver
       FROM photos
       WHERE id < ? AND ${this._sqlBackfillPendingCoreExpr()} AND ${this._sqlBackfillPendingExpr()}
       ORDER BY id DESC
       LIMIT ?`,
      )
      .all(beforeId, limit);
  }

  /**
   * 补全任务**第一趟**的取数：只要「还缺缩略图、且值得再试」的行。
   *
   * 🔴 为什么要单独一趟（2026-10-06 用户报「预览图计数一直是 0」的根因）：
   *    缩略图补全与元数据回填**共用同一条 id 倒序游标**，而 `EXIF_SCHEMA_VERSION` 升一版
   *    会让**全库**重新入选。于是游标从最高 id 起手时，前面几万行全是
   *    「早有缩略图、只缺新 EXIF 字段」的行 —— 走 `skipThumbnail` 分支，一张图都不产出。
   *    本机实测：id 1,889,290 以上只剩 10 行缺缩略图，而缺口全压在
   *    id 1,502,489~1,889,290 的 **33.9 万行**里 ⇒ 界面长时间显示「预览图 0 张」，
   *    用户合理地以为任务卡住了（实测 90 秒窗口 `has_thumbnail=1` 总数纹丝不动）。
   *    拆出一趟之后：`idx_photos_hasThumb` 的倒序扫第一个命中就是 id 1,889,290
   *    ⇒ 任务开局立刻开始出图，不必先爬完那几万行元数据。
   *
   * ⚠️ 游标必须与第二趟（`getPhotosMissingThumbnailsBefore`）**各自独立**，
   *    两边都从 `MAX(id)+1` 起手、各自递减。共用一条游标会静默跳过中间所有行：
   *    第一趟把游标拉到 1,889,290 之后，第二趟再也取不到 1,889,291~1,981,503 那批 ——
   *    不报错、不写日志，只是那些行的元数据永远补不上（本项目踩过同类的坑）。
   *
   * SELECT 列表与 `getPhotosMissingThumbnailsBefore()` **逐列相同**：`processOne` 的
   * `needSize` / `needDhash` / `needExif` / `needHash` 全靠这几个字段做决定，少取一列
   * 就会让对应判据**永远走兜底分支**（不报错，静默做错事）。这也是第二趟能直接复用
   * 同一个 `processOne` 的原因。
   *
   * 🔴 **本方法必须 `INDEXED BY idx_photos_missing_thumb`**（2026-10-07 加）。
   *    上面那个 WHERE（`has_thumbnail = 0 AND <失败标记可重试>`）同时蕴含第二趟新索引
   *    `idx_photos_backfill_pending` 的核心谓词（后者的第一支就是 `has_thumbnail = 0`）
   *    ⇒ 那条索引一建出来，规划器就可以合法地改用它。而两者条目数差三个数量级：
   *    真库实测 `idx_photos_missing_thumb` 条目 ≈ **0**（缩略图早补齐了）、新索引条目 ≈ **86 万**
   *    ⇒ 改用它 = 逐行回表 86 万次（外推 ~200 s），而现在是 **8 ms**。
   *    这是「新增部分索引把既有查询带偏」的典型形态：**不报错、不写日志，只是突然慢 2 万倍**。
   *    ⚠️ 走 `heavy.hasIndex()` 判存在才加 hint：`INDEXED BY` 指向不存在的索引是**报错**
   *    （`no query solution`），不是变慢；而这条索引由启动期 worker 建，起手那几秒可能还没有。
   *    反向对照（钉住之后第一趟仍走这条索引、且新索引不会把它带偏）见
   *    `scripts/thumb-backfill-metadata-fetch-regression.js`。
   */
  getPhotosLackingThumbnailBefore(beforeId, limit) {
    var pin = heavy.hasIndex(this.db, heavy.MISSING_THUMB_INDEX)
      ? ' INDEXED BY ' + heavy.MISSING_THUMB_INDEX
      : '';
    return this.db
      .prepare(
        `SELECT id, file_path, file_size, date_modified, has_thumbnail, dhash, width, height,
                file_hash, exif_mtime, exif_ver
       FROM photos${pin}
       WHERE id < ? AND ${this._sqlNeedsThumbnailExpr()}
       ORDER BY id DESC
       LIMIT ?`,
      )
      .all(beforeId, limit);
  }

  /**
   * 倒序补全的起始游标：`MAX(id) + 1`（升序版本对应 `0`，两边都是「比边界多退/进一格」，
   * 否则 id 最大 / 最小的那一行永远扫不到）。
   *
   * `id` 是 INTEGER PRIMARY KEY（rowid 别名）→ `MAX(id)` 是一次索引定位，**不是全表扫**，
   * 可以放心在补全开始前调一次（与 `getMissingThumbnailCount()` 那种真 `SCAN photos` 不同）。
   */
  getMaxPhotoId() {
    var row = this.db.prepare('SELECT MAX(id) AS hi FROM photos').get();
    var hi = row && row.hi != null ? Number(row.hi) : 0;
    return Number.isFinite(hi) && hi > 0 ? hi : 0;
  }

  /**
   * 写入缩略图，并**如实记录它的规格**（目标档位 / 编码格式）。
   *
   * 🔴 `spec` 不是可有可无的装饰：新的 BLOB 一进来，这一行上原有的规格记录就失效了。
   *    所以拿不到规格时必须写回 `0` / `''`（未知），**绝不能沿用旧值**——
   *    「记录写着 256、BLOB 其实是 1024」比「没有记录」更坏，因为它会让将来的迁移
   *    误判成「这张已经符合目标档位」从而跳过。
   *
   * @param {number} photoId
   * @param {Buffer} thumbnailBuffer
   * @param {{size?: number, format?: string}} [spec] 生成参数；省略则两列记为未知
   */
  updatePhotoThumbnail(photoId, thumbnailBuffer, spec) {
    var size = spec && Number.isFinite(Number(spec.size)) ? parseInt(spec.size, 10) : 0;
    var format = normalizeThumbFormat(spec && spec.format);
    this.db
      .prepare(
        `UPDATE photos
         SET thumbnail = ?, has_thumbnail = 1, thumb_size = ?, thumb_format = ?
         WHERE id = ?`,
      )
      .run(thumbnailBuffer, size, format, photoId);
  }

  /**
   * 写入一次「文件被编辑过」之后的文件级元数据。
   *
   * 🔴 `date_modified` 必须与扫描器写入的格式**逐字一致**
   *    （`scanner.js#formatMtimeFromDate` ⇒ `YYYY-MM-DD HH:MM:SS`）。
   *    它不只用于排序 / 日期分组：`thumb_fail_mtime` / `header_fail_mtime` / `exif_mtime` /
   *    `dhash_mtime` 四列记账时间戳**都拿它做判据**。格式差一个字符（例如带毫秒），
   *    那些「这行处理过了」的标记就永远不等于 `date_modified` ⇒ 后台补全会把这行
   *    **无限重试**，而且不报错、不写日志。
   *
   * 刻意**只管文件级两列**：尺寸走 `updatePhotoDimensions`、dHash 走 `updatePhotoDhash`、
   * 缩略图走 `updatePhotoThumbnail` —— 各自都已存在。合并成一条宽 UPDATE 会让
   * 「谁负责哪一列」变模糊，而漏一列的后果是静默的。
   */
  updatePhotoFileMeta(photoId, spec) {
    var id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return { changes: 0 };
    var s = spec || {};
    var size = Number(s.fileSize);
    return this.db
      .prepare('UPDATE photos SET file_size = ?, date_modified = ? WHERE id = ?')
      .run(
        Number.isFinite(size) && size >= 0 ? size : 0,
        s.dateModified != null ? String(s.dateModified) : null,
        id,
      );
  }

  /** 按 `file_path` 回查 id（`INSERT OR IGNORE` 之后取新行 id 用，禁 `lastInsertRowid`）。 */
  getPhotoIdByFilePath(filePath) {
    var row = this.db
      .prepare('SELECT id FROM photos WHERE file_path = ?')
      .get(String(filePath || ''));
    return row && row.id != null ? Number(row.id) : 0;
  }

  /** 标记「这一行是由 `sourceId` 派生的」（裁剪副本）。 */
  markPhotoDerived(photoId, sourceId) {
    var id = parseInt(photoId, 10);
    var src = parseInt(sourceId, 10);
    if (!isFinite(id) || id <= 0) return { changes: 0 };
    return this.db
      .prepare('UPDATE photos SET derived_from = ? WHERE id = ?')
      .run(isFinite(src) && src > 0 ? src : 0, id);
  }

  /**
   * 记下「这一行试过生成缩略图、但失败了」—— `_sqlNeedsThumbnailExpr()` 据此把它移出候选集。
   *
   * 🔴 传进来的必须是**这一行当前的 `date_modified`**（不是当前时间）：
   *    这一列存的是「失败当时该行是什么日期」，将来文件被替换、`date_modified` 一变，
   *    谓词里的 `<>` 就自动把它放回候选集。存 `Date.now()` 会让这一行**永远回不来**
   *    —— 时间戳只会前进，永远不可能等于那一行的 `date_modified`。
   *
   * ⚠️ 空值要写**空串**而不是 NULL：谓词是
   *    `thumb_fail_mtime IS NULL OR IFNULL(thumb_fail_mtime,'') <> IFNULL(date_modified,'')`，
   *    写 NULL 会让 `IS NULL` 为真 ⇒ 被判成「没失败过」⇒ 这行下一轮还会被取出来，
   *    白重试的坑原样留着。写空串则两侧都归 `''`、判相等 ⇒ 正确排除。
   *
   * ⚠️ **只在「文件读得到、但做不出图」时调用**。文件根本读不到的（磁盘没挂、已被删除）
   *    不许写这条标记：那是 `invalid-cleanup` 的活，而且外接盘没插时写标记等于把
   *    整个图库的缩略图补全都永久挡掉 —— 判据见 `main.js#processOne` 的失败分支。
   *
   * @param {number} photoId
   * @param {string|null|undefined} dateModified 该行当前的 `date_modified`
   */
  markThumbFailed(photoId, dateModified) {
    this.db
      .prepare('UPDATE photos SET thumb_fail_mtime = ? WHERE id = ?')
      .run(dateModified == null ? '' : String(dateModified), photoId);
  }

  /**
   * 记下「这一行试过**读文件头**、但读不出来」—— 候选谓词第二支据此把它的
   * 「缺尺寸 / 缺拍摄参数」两项移出候选集。
   *
   * 🔴 为什么不能复用 `thumb_fail_mtime`：两列管的**不是同一件事**，混用会误伤。
   *    真实的截断 JPEG 就是反例 —— 它 `metadata()` 成功（尺寸 4608×3456 + 9,687 B EXIF 都补上了）、
   *    只是**解码**失败。它该被 `thumb_fail_mtime` 从「缺 dHash」那一项里排除，
   *    但**绝不该**因此丢掉尺寸与 EXIF 的重试资格。
   *
   * 🔴 三条硬约束与 `markThumbFailed()` **逐条相同**（同一套自愈判据，
   *    共用 `_sqlFailMarkerRetryableExpr()`；两边漂开 = 某一路的失败行永远回不来）：
   *    ① 必须传**该行当前的 `date_modified`**，不是 `Date.now()`；
   *    ② 空值写**空串**不写 NULL（写 NULL 会让 `IS NULL` 为真 ⇒ 被判「没失败过」⇒ 白重试）；
   *    ③ **只在「文件读得到、但读不出文件头」时调用** —— 文件不在磁盘上（外接盘没插）不许盖章，
   *       否则会把整个图库的尺寸与拍摄参数补全永久挡掉，而且它不会自愈
   *       （盘没插时扫描同样读不到新日期）。判据见 `main.js#recordHeaderFailure`。
   *
   * @param {number} photoId
   * @param {string|null|undefined} dateModified 该行当前的 `date_modified`
   */
  markHeaderFailed(photoId, dateModified) {
    this.db
      .prepare('UPDATE photos SET header_fail_mtime = ? WHERE id = ?')
      .run(dateModified == null ? '' : String(dateModified), photoId);
  }

  photoExists(photoId) {
    var row = this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(photoId);
    return !!row;
  }

  /**
   * 清理「文件已不存在」的记录。
   *
   * 🔴 **扫描方向统一为倒序（新记录优先）**（2026-10-05，与缩略图补全 / 查重指纹同一条策略）：
   *    升级前只有**无游标**那一支是 `ORDER BY id DESC`，**带游标**那一支却是 `id > ? ORDER BY id ASC`
   *    —— 于是启动期第一批取最新 400 行、之后**跳到最老那一段再往新走**：同一个任务里两种方向
   *    混用，而且第二批还会与第一批重叠几百行（`lastId` 是那批里最小的 id）。
   *    现在统一成「从最新往老扫」，`beforeId` 是**排他上界**，传 0 / 不传 = 不限（从 MAX(id) 开始）。
   *
   * 语义上也本该如此：**刚导入 / 刚被搬走的图片最容易失效**，用户点「清理无效记录」先想看到的就是它们。
   */
  cleanupMissingFiles(options = {}) {
    var batchSize = parseInt(options && options.batchSize, 10);
    var hasBatchLimit = isFinite(batchSize) && batchSize > 0;
    var beforeId = parseInt(options && options.beforeId, 10);
    var hasBeforeId = isFinite(beforeId) && beforeId > 0;
    var rows;
    if (hasBatchLimit) {
      if (hasBeforeId) {
        // 按主键游标分批扫描（倒序，排他上界），避免重复检查同一批记录
        rows = this.db
          .prepare('SELECT id, file_path FROM photos WHERE id < ? ORDER BY id DESC LIMIT ?')
          .all(beforeId, batchSize);
      } else {
        // 启动阶段仅限量检查，避免百万级库冷启动时全表 existsSync 拖慢应用
        rows = this.db
          .prepare('SELECT id, file_path FROM photos ORDER BY id DESC LIMIT ?')
          .all(batchSize);
      }
    } else {
      rows = this.db.prepare('SELECT id, file_path FROM photos').all();
    }
    var removeIds = [];
    for (var i = 0; i < rows.length; i++) {
      var fp = rows[i].file_path;
      if (!fp || !fs.existsSync(fp)) {
        removeIds.push(rows[i].id);
      }
    }
    var deleted = 0;
    if (removeIds.length > 0) {
      var delStmt = this.db.prepare('DELETE FROM photos WHERE id = ?');
      this.db.exec('BEGIN TRANSACTION');
      try {
        for (var j = 0; j < removeIds.length; j++) {
          delStmt.run(removeIds[j]);
          deleted++;
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      if (deleted > 0) {
        this.invalidateAllRootFolderStatsCache();
      }
    }
    var lastId = 0;
    if (rows.length > 0) {
      lastId = rows[rows.length - 1].id;
    }
    return {
      checked: rows.length,
      deleted: deleted,
      lastId: lastId,
      hasMore: hasBatchLimit ? rows.length === batchSize : false,
    };
  }

  /**
   * 与 cleanupMissingFiles（带 batchSize）语义一致；existsSync 分段 + setImmediate 让出主线程，
   * 避免启动分批清理时连续数千次 stat 导致进程「未响应」。
   *
   * 🔴 游标同样是**倒序**的排他上界 `beforeId`（见 `cleanupMissingFiles` 的说明）；
   * 返回值里的 `lastId` = 本批**最后一行的 id**，倒序下即这批里**最小**的那个，
   * 直接拿去当下一批的 `beforeId`。方向混用会让批次重叠（旧代码就是这么错的）。
   */
  cleanupMissingFilesYielding(options = {}) {
    var self = this;
    var batchSize = parseInt(options && options.batchSize, 10);
    var hasBatchLimit = isFinite(batchSize) && batchSize > 0;
    if (!hasBatchLimit) {
      return Promise.reject(new Error('cleanupMissingFilesYielding requires positive batchSize'));
    }
    var beforeId = parseInt(options && options.beforeId, 10);
    var hasBeforeId = isFinite(beforeId) && beforeId > 0;
    var sliceSize = parseInt(options && options.existsSyncSlice, 10);
    if (!isFinite(sliceSize) || sliceSize < 8) sliceSize = 72;

    return new Promise(function (resolve, reject) {
      var rows;
      try {
        if (hasBeforeId) {
          rows = self.db
            .prepare('SELECT id, file_path FROM photos WHERE id < ? ORDER BY id DESC LIMIT ?')
            .all(beforeId, batchSize);
        } else {
          rows = self.db
            .prepare('SELECT id, file_path FROM photos ORDER BY id DESC LIMIT ?')
            .all(batchSize);
        }
      } catch (e) {
        reject(e);
        return;
      }

      if (!rows || rows.length === 0) {
        resolve({
          checked: 0,
          deleted: 0,
          lastId: hasBeforeId ? beforeId : 0,
          hasMore: false,
        });
        return;
      }

      var removeIds = [];
      var i = 0;

      function scanSlice() {
        var end = Math.min(i + sliceSize, rows.length);
        for (; i < end; i++) {
          var fp = rows[i].file_path;
          if (!fp || !fs.existsSync(fp)) {
            removeIds.push(rows[i].id);
          }
        }
        if (i < rows.length) {
          setImmediate(scanSlice);
        } else {
          runDeletes();
        }
      }

      function runDeletes() {
        var deleted = 0;
        var lastId = rows[rows.length - 1].id;
        if (removeIds.length === 0) {
          resolve({
            checked: rows.length,
            deleted: 0,
            lastId: lastId,
            hasMore: rows.length === batchSize,
          });
          return;
        }
        try {
          var delStmt = self.db.prepare('DELETE FROM photos WHERE id = ?');
          self.db.exec('BEGIN TRANSACTION');
          var j;
          for (j = 0; j < removeIds.length; j++) {
            delStmt.run(removeIds[j]);
            deleted++;
          }
          self.db.exec('COMMIT');
          if (deleted > 0) {
            self.invalidateAllRootFolderStatsCache();
          }
          resolve({
            checked: rows.length,
            deleted: deleted,
            lastId: lastId,
            hasMore: rows.length === batchSize,
          });
        } catch (e) {
          try {
            self.db.exec('ROLLBACK');
          } catch (e2) {
            void e2;
          }
          reject(e);
        }
      }

      setImmediate(scanSlice);
    });
  }

  rebuildThumbnailFlags() {
    this.db
      .prepare(
        `UPDATE photos
       SET has_thumbnail = CASE
         WHEN thumbnail IS NOT NULL AND length(thumbnail) > 0 THEN 1
         ELSE 0
       END`,
      )
      .run();
    var row = this.db
      .prepare(
        'SELECT COUNT(*) AS missing FROM photos WHERE has_thumbnail = 0 OR thumbnail IS NULL',
      )
      .get();
    return { missing: row ? row.missing : 0 };
  }

  optimizeDatabase() {
    // WAL 模式下先做 checkpoint，再分析与压缩
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec('ANALYZE');
    this.db.exec('VACUUM');
    return { success: true };
  }

  getFolderCovers(options = {}) {
    return require('./db-heavy-read').runGetFolderCovers(this.db, options || {});
  }

  /**
   * 目录浏览「子目录」封面：本层精确 folder_path；封面选取与 getFolderCovers 共用 _folderCoverPickOrderBySql。
   */
  getImmediateSubfolderCovers(parentFolderPath, childPaths, options = {}) {
    var opts = options || {};
    var rootId = opts.rootId;
    if (rootId == null) return [];
    if (!Array.isArray(childPaths) || childPaths.length === 0) return [];

    var conditions = ['root_id = ?'];
    var baseParams = [rootId];
    this._pushMediaTypeCondition(conditions, opts.mediaType);
    var whereSql = 'WHERE ' + conditions.join(' AND ');

    var pickOrder = this._folderCoverPickOrderBySql();
    var sqlCover =
      'SELECT ' +
      folderCoverColumns() +
      ' FROM photos ' +
      whereSql +
      ' AND folder_path = ? ORDER BY ' +
      pickOrder +
      ' LIMIT 1';
    var sqlCount = 'SELECT COUNT(*) AS c FROM photos ' + whereSql + ' AND folder_path = ?';

    var stmtCover = this.db.prepare(sqlCover);
    var stmtCount = this.db.prepare(sqlCount);
    var out = [];

    for (var i = 0; i < childPaths.length; i++) {
      var child = String(childPaths[i] || '');
      if (!child) continue;
      var paramsCount = baseParams.concat([child]);
      var cover = stmtCover.get.apply(stmtCover, baseParams.concat([child]));
      var countRow = stmtCount.get.apply(stmtCount, paramsCount);
      out.push(
        Object.assign(
          {
            folder_path: child,
            folder_photo_count: countRow ? Number(countRow.c) || 0 : 0,
          },
          folderCoverRow(cover),
        ),
      );
    }
    return out;
  }

  /**
   * Find rootId by any folder path inside it
   */
  findRootIdByPath(options) {
    var path = (options.path || '').trim();
    if (!path) return { rootId: null };
    // Normalize to forward slash for matching (database stores either)
    var pathNorm = path.replace(/\\/g, '/');
    // Use DISTINCT because multiple photos may be in the same folder
    var stmt = this.db.prepare('SELECT DISTINCT root_id FROM photos WHERE folder_path = ? LIMIT 1');
    var row = stmt.get(pathNorm);
    if (row && row.root_id) {
      return { rootId: Number(row.root_id) };
    }
    // Also try original path in case it's already correct
    if (pathNorm !== path) {
      var rowOrig = stmt.get(path);
      if (rowOrig && rowOrig.root_id) {
        return { rootId: Number(rowOrig.root_id) };
      }
    }
    // If not found, try with the parent - search for any photo under this path
    var stmtLike = this.db.prepare(
      'SELECT DISTINCT root_id FROM photos WHERE folder_path LIKE ? LIMIT 1',
    );
    var rowLike = stmtLike.get(pathNorm + '/%');
    if (rowLike && rowLike.root_id) {
      return { rootId: Number(rowLike.root_id) };
    }
    return { rootId: null };
  }

  /**
   * Get all immediate child folders under a parent path
   */
  getImmediateChildFolders(options) {
    var rootId = options.rootId;
    var parentPath = (options.parentPath || '').trim();
    if (!rootId || !parentPath) return [];

    // Normalize to forward slash for matching
    var parentNorm = parentPath.replace(/\\/g, '/');
    // Ensure parentPath ends with slash for LIKE matching
    var parentPrefix = parentNorm.endsWith('/') ? parentNorm : parentNorm + '/';
    // Get all distinct folder paths that are direct children of parent
    // Pattern: parentPath + [name], no more slashes after name
    var stmt = this.db.prepare(`
      SELECT DISTINCT folder_path
      FROM photos
      WHERE root_id = ?
        AND folder_path LIKE ?
        AND LENGTH(folder_path) - LENGTH(REPLACE(folder_path, '/', '')) = LENGTH(?) - LENGTH(REPLACE(?, '/', '')) + 1
      ORDER BY folder_path ASC
    `);
    var rows = stmt.all(rootId, parentPrefix + '%', parentPrefix, parentPrefix);
    // Normalize all output paths to forward slash
    return rows.map(function (r) {
      return r.folder_path.replace(/\\/g, '/');
    });
  }

  /**
   * Aggregate immediate child folder summaries from flat folder tree (same as desktop)
   */
  aggregateImmediateSubfolderSummaries(options) {
    var parentPath = (options.parentPath || '').trim();
    var flatRows = options.flatRows || [];
    if (!parentPath || !Array.isArray(flatRows) || flatRows.length === 0) return [];

    // Normalize path (same as desktop) - remove trailing slash
    var p = parentPath.replace(/[\\/]+$/, '');
    if (!p) return [];
    var pLow = p.toLowerCase();
    var pLen = p.length;
    var byChild = {};

    for (var i = 0; i < flatRows.length; i++) {
      var row = flatRows[i];
      var fp = (row.folder_path || '').replace(/\\/g, '/');
      if (!fp) continue;
      var fl = fp.toLowerCase();
      if (fl === pLow) continue;
      // Check if it's a direct child
      if (fl.indexOf(pLow + '/') !== 0) continue;
      var rel = fl.slice(pLen + 1);
      if (!rel) continue;
      var slash = rel.indexOf('/');
      var firstSeg = slash < 0 ? rel : rel.slice(0, slash);
      if (!firstSeg) continue;
      var childFull = p + '/' + firstSeg;
      var key = childFull.toLowerCase();
      if (!byChild[key]) {
        byChild[key] = {
          folder_path: childFull,
          folder_photo_count: 0,
        };
      }
      byChild[key].folder_photo_count += row.photo_count || 0;
    }

    // Convert to array
    var out = [];
    for (var k in byChild) {
      if (Object.prototype.hasOwnProperty.call(byChild, k)) {
        out.push(byChild[k]);
      }
    }
    return out;
  }

  getFullPhoto(photoId) {
    const photo = this.db
      .prepare('SELECT file_path, file_name, width, height FROM photos WHERE id = ?')
      .get(photoId);
    return photo || null;
  }

  /**
   * 图片编辑（旋转 / 翻转 / 裁剪）需要的那一组列。
   *
   * 🔴 **刻意不复用 `getFullPhoto()`**：那个方法只查 `file_path / file_name / width / height`
   *    （预览原图只需要这四列），**拿不到 `id` / `root_id` / `date_taken` / `file_type`**。
   *    而编辑要做三件事都依赖它们：把派生数据写回**同一行**（要 id）、清**那个根目录**的
   *    缓存（要 root_id）、让裁剪副本的 `date_taken` 跟随原图（要 date_taken）。
   *
   *    拿不到 id 的后果是**完全静默**的：所有 UPDATE 影响 0 行、`insertPhoto` 因
   *    `root_id` 为 NULL 撞 NOT NULL 被 `INSERT OR IGNORE` 吞掉 —— 不抛错、不写日志，
   *    界面上只表现为「编辑完没变化」。这条是实测踩出来的（`.workbuddy/tmp/photo-edit-integration-probe.js`）。
   */
  getPhotoForEdit(photoId) {
    var id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return null;
    var row = this.db
      .prepare(
        `SELECT id, root_id, file_path, folder_path, file_name, file_type,
                date_taken, date_modified, width, height
           FROM photos WHERE id = ?`,
      )
      .get(id);
    return row || null;
  }

  /**
   * 预览页「图片信息」面板的数据源。字段覆盖面由 `src/web/js/photo-info-fields.js`
   * 的注册表决定 —— 面板要显示什么，这里就得先查出来，两者一起改。
   *
   * `media_kind` 直接复用本类的视频扩展名集合（`_sqlFileTypeIsVideoExpr()`），
   * 不再在 JS 侧维护第二份扩展名清单，否则「仅视频」筛出来的和面板写的不一致。
   * `root_path` 走 LEFT JOIN：图片的 root_id 理论上必定命中，但外键没开强制，
   * 兜底成 NULL 而不是把整条记录丢掉。
   *
   * 🔴 这里**只带面板用得到的列**：`photos` 现在有 58 个拍摄参数列，但只有注册表里
   *    `panel: true` 的那批（见 `src/main/exif-meta.js#EXIF_PANEL_KEYS`）会被显示 ——
   *    其余 27 列（与已有列重复的派生值、技术标定值）**刻意不查**，否则每打开一张图片
   *    都要为它们多传一次 IPC 载荷，而界面一个字节都用不上。
   */
  getPhotoInfo(photoId) {
    const photo = this.db
      .prepare(
        `SELECT p.id, p.file_path, p.file_name, p.file_size, p.file_type, p.width, p.height,
                p.folder_path, p.date_taken, p.date_modified, p.is_favorite, p.has_thumbnail,
                p.file_hash, p.dhash,
                p.camera_make, p.camera_model, p.lens_model, p.focal_length, p.aperture,
                p.iso_speed, p.shutter_speed, p.gps_latitude, p.gps_longitude,
                p.exif_date_taken,
                p.orientation, p.exposure_bias, p.exposure_program, p.exposure_mode,
                p.metering_mode, p.light_source, p.flash, p.white_balance,
                p.scene_capture_type, p.max_aperture, p.focal_length_35mm, p.lens_spec,
                p.body_serial, p.lens_serial, p.gps_altitude, p.lens_make,
                p.software, p.image_datetime, p.color_space, p.user_comment,
                p.sub_sec_time,
                r.path AS root_path,
                CASE WHEN ${this._sqlFileTypeIsVideoExpr()} THEN 'video' ELSE 'image' END AS media_kind
         FROM photos p
         LEFT JOIN root_folders r ON r.id = p.root_id
         WHERE p.id = ?`,
      )
      .get(photoId);
    return photo || null;
  }

  deletePhotoById(photoId) {
    const meta = this.db.prepare('SELECT root_id FROM photos WHERE id = ?').get(photoId);
    const r = this.db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
    if (r.changes > 0) {
      if (meta && meta.root_id != null) {
        try {
          this.invalidateRootFolderStatsCache(meta.root_id);
        } catch (e) {
          void e;
        }
      }
    }
    return r.changes > 0;
  }

  updatePhotoDimensions(photoId, width, height) {
    const stmt = this.db.prepare('UPDATE photos SET width = ?, height = ? WHERE id = ?');
    const r = stmt.run(width, height, photoId);
    return r.changes > 0;
  }

  /**
   * 写入一次「拍摄参数回填」的结果（缩略图补全顺带读的那次文件头）。
   *
   * 🔴 `dateModified` 非空时**必须**一起写进 `exif_mtime` —— 它是这组列**唯一**的
   *    「已检查」标记，也是候选谓词（`_sqlNeedsExifExpr()`）唯一的判据。
   *    少了它，这行下一轮还会被取出来重新读一次文件头：任务永不收敛。
   *    ⚠️ 标记写的是**读取当时**该行的 `date_modified`；文件内容变了由扫描侧
   *    （`SCAN_INVALIDATED_ON_CONTENT_CHANGE`）把这组列连同标记一起置空。
   *
   * 🔴 字段为 `null` 的含义是「**文件里没有这一项**」，不是「没读到」，所以照样要写 ——
   *    只写非空字段会让「没有 EXIF 的图片」永远无法被标记为已看。
   *    （调用方只在**文件头读成功**时才调这里：读失败是「没看到文件」，不能标记。）
   *
   * 🔴 这里写的是 `exif_date_taken`（真实拍摄时间），**不是** `date_taken`。
   *    `date_taken` 是排序默认列 + 日期分组 + `idx_photos_date` 的唯一输入，
   *    而真实拍摄时间只有 ~23% 的图片取得到 ⇒ 覆盖它会把时间线变成
   *    「23% 真 + 77% 原样」的混合口径。原委见 `src/main/exif-meta.js#formatExifDate`。
   *    ⚠️ 因此这个 UPDATE **绝不许**把 `date_taken` 写进去（守护有断言钉这一条）。
   *
   * @param {number} photoId
   * @param {object} fields `exif-meta.js#extractExifFields()` 的返回（全 null 也合法）
   * @param {string|null} dateModified 该行的 `date_modified`（写进 `exif_mtime`）
   */
  updatePhotoExif(photoId, fields, dateModified) {
    var id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) return { changes: 0 };
    var stmt = this.getExifUpdateStmt();
    if (!stmt) return { changes: 0 };
    var f = fields || {};
    var args = [];
    // 参数顺序 = 注册表顺序（`getExifUpdateStmt()` 的 SET 子句就是按它拼的）——
    // 两处都从 `EXIF_FIELD_SPECS` 派生，所以「加了字段忘了绑参数」在结构上不可能发生。
    for (var i = 0; i < EXIF_FIELD_SPECS.length; i++) {
      args.push(coerceExifValue(f[EXIF_FIELD_SPECS[i].key], EXIF_FIELD_SPECS[i].type));
    }
    args.push(dateModified != null ? String(dateModified) : null); // exif_mtime
    args.push(EXIF_SCHEMA_VERSION); // exif_ver
    args.push(id);
    return stmt.run.apply(stmt, args);
  }

  /**
   * `updatePhotoExif` 的预编译语句（**缓存**，不是每次 `prepare`）。
   *
   * 🔴 为什么必须缓存：补全任务对**每一张**图片都要调一次 `updatePhotoExif`
   *    （真库 163 万张），而这条 SQL 现在有 60 个占位符 —— 每次重新 `prepare` 都要重新编译，
   *    在热路径上是纯浪费。列集合由 `EXIF_METADATA_COLUMNS` 单点决定，建好后不会变。
   */
  getExifUpdateStmt() {
    if (this._exifUpdateStmt) return this._exifUpdateStmt;
    try {
      this.ensurePhotosExifColumn();
      var setters = [];
      for (var i = 0; i < EXIF_METADATA_COLUMNS.length; i++) {
        setters.push(EXIF_METADATA_COLUMNS[i] + ' = ?');
      }
      // 账本两列写在最后，与 `updatePhotoExif` 的参数顺序一致
      setters.push('exif_mtime = ?');
      setters.push('exif_ver = ?');
      this._exifUpdateStmt = this.db.prepare(
        'UPDATE photos SET ' + setters.join(', ') + ' WHERE id = ?',
      );
      return this._exifUpdateStmt;
    } catch (e) {
      logger.error('[db] prepare exif update statement failed:', e && e.message ? e.message : String(e));
      return null;
    }
  }

  searchPhotos(query, options = {}) {
    const {
      page = 1,
      pageSize = 100,
      favoritesOnly,
      mediaType,
      lite = false,
      nameOnly = false,
    } = options;
    const offset = (page - 1) * pageSize;

    const mediaConds = [];
    // 🔴 `preserveLiveCompanion: true` —— `all` 档**刻意不排**伴生视频，**别"顺手补上"**。
    //    代价不是性能而是**功能**：`hasExtraFilter`（见下）的判据是
    //    `!!favoritesOnly || mediaConds.length > 0`，一旦 `all` 档也 push 一条，
    //    无筛选搜索就会被判成「有附加筛选」，于是**两条经过标定的优化同时失效**：
    //      · P0-2：total 从「直接问 `photos_fts`（真库 79.5 ms）」退回
    //        「`photos.id IN (SELECT rowid FROM photos_fts …)` + 回表（25,759.7 ms）」= **324×**；
    //      · P0-3：取一页从「索引序 141.2 ms」退回「物化后临时排序 32,428.3 ms」= **230×**。
    //    而收益只是「搜索结果里少显示 1 行」。并且语义上搜索本就该「搜什么显示什么」——
    //    用户搜那个 MOV 的文件名时，把它显示出来才是对的。
    //    ⚠️ `_buildPreviewScopeWhere` 在 `view === 'search'` 时同样不排（两边判据必须一致）。
    this._pushMediaTypeCondition(mediaConds, mediaType, { preserveLiveCompanion: true });
    // 🔴 **`join(' AND ')`，不是 `mediaConds[0]`**（2026-10-06 修）。
    //    `video` 档会 push 两条，只取第一条 = 丢掉 `file_type` 谓词 = 「视频」档不过滤视频。
    //    实测：`searchPhotos('IMG', { mediaType: 'video' })` 返回 6 张 jpg（应为 0）。
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds.join(' AND ') : '';

    // 组织元数据筛选（2026-10-09）。
    //
    // 🔴 **搜图页必须认它**，哪怕本函数的索引标定会被打断。理由是作用域：
    //    渲染端的 `fetchPhotosPage()` 在**顶部建一次** `options` 再分发给所有视图
    //    （`getPhotos` / `getFolderPhotos` / `getDatePhotos` / `searchPhotos` / 标签导航），
    //    而筛选栏是**全局**的。搜图页静默忽略 ⇒ 用户看到筛选栏写着「仅 5 星」、
    //    搜索框里却列着 3 星的图，且不报错。这与下面 `nameOnly` 那条注释的结论一致：
    //    **静默忽略调用方的筛选条件比慢更糟**。
    //
    // ⚠️ 代价与 `favoritesOnly` 完全同构：`rating` / `flag` 不在 `idx_photos_name` 里，
    //    带它们只能放弃那条覆盖索引 hint（退回全表扫）。冲片时「只搜自己标过 5 星的那批」
    //    本来就是少数操作，而筛出来是错的会让人不再信任筛选本身。
    const orgConds = [];
    const orgParams = [];
    this._pushOrgMetaConditions(orgConds, orgParams, options);
    const orgSql = orgConds.length ? ' AND ' + orgConds.join(' AND ') : '';
    const hasOrgFilter = hasOrgMetaFilter(options);

    // 列清单唯一真相源（含 thumb_size / thumb_format —— 浏览层的缓存键要用）
    const photoCols = photoListColumns({ lite: lite });

    // ══════════════════════════════════════════════════════════════════════════
    // `nameOnly`：文件名**包含**关键词（真子串）。搜图页「关键词」档的「文件」分组。
    // ══════════════════════════════════════════════════════════════════════════
    //
    // ## 为什么不能复用下面那条 FTS 路
    //
    // FTS5 只做**分词前缀**匹配，而 `unicode61` 把一整串汉字切成**一个** token ⇒
    // `file_name:"日子"*` 匹配不到 `海边的日子_001.jpg`、`"图片"*` 匹配不到
    // `微信图片_20240101.jpg`（夹具实测，两条都是空）。而这一档的用户语义就是
    // 「文件名里**包含**这几个字」，所以必须是 `%kw%`。这也正是本档要与
    // 浏览页搜索（FTS 分词）分开报数的原因：同一句话在两处的命中集本来就不同。
    //
    // ## 为什么必须钉 `INDEXED BY idx_photos_name`
    //
    // 1,200,000 行夹具实测（同一条语句的三种形态）：
    //
    //   | 取一页的写法 | 稀疏命中 | 中等 | 稠密（75 万命中） | **零命中** |
    //   | --- | ---: | ---: | ---: | ---: |
    //   | `INDEXED BY idx_photos_name` + `ORDER BY file_name` | 185 ms | 100 ms | **1 ms** | 265 ms |
    //   | `INDEXED BY idx_photos_name` + `ORDER BY date_taken` | 884 ms | 407 ms | 2,734 ms | 316 ms |
    //   | **不加 hint** + `ORDER BY date_taken` | 27 ms | 28 ms | 1 ms | **11,522 ms** 🔴 |
    //
    //   · 不加 hint 时规划器改走 `idx_photos_date` 倒序过滤：命中**稠密**时它最快，但每走一行
    //     都要回表读 `file_name` ⇒ 命中**稀疏或为 0** 时要把整条日期索引走完。
    //     **11,522 ms** 就是这么来的，而且它只在用户搜了个查不到的词时才出现。
    //   · `ORDER BY date_taken` 配覆盖索引则要 `USE TEMP B-TREE FOR ORDER BY`，把整个命中集
    //     排一遍 ⇒ 命中越多越亏（75 万命中 2,734 ms）。
    //   · 钉住覆盖索引后：`file_name` 就在索引里，LIKE 在**索引上**判定、不回表；
    //     `ORDER BY file_name` 由索引序直接满足（计划无 TEMP B-TREE）⇒ **1~265 ms，且不随
    //     命中密度变化**。这是它相对上面两条的关键性质：上界可控。
    //
    //   ⚠️ 刻意接受的代价：**排序是文件名，不是拍摄时间**。按时间排必须先拿到整个命中集
    //      （上面两行就是它的两种代价）。文件名搜索按名字排也符合直觉 —— 相邻名字挨在一起。
    //
    //   ⚠️ 命中数（`total`）另走一条**纯覆盖索引**扫描（只碰 `file_name` 一列），
    //      实测 170~223 ms 且同样不随密度变化；结果进 `photosTotalCache`，
    //      于是「更多」翻页不会再重算同一个数。
    //
    //   ⚠️ `favoritesOnly` / `mediaType` 的列不在 `idx_photos_name` 里，带它们只能放弃索引
    //      hint（退回全表扫）。搜图页没有这两个控件，所以实践中走不到；留着是因为
    //      **静默忽略调用方的筛选条件比慢更糟**。组织元数据（`orgSql`）同理。
    if (nameOnly) {
      const q = String(query == null ? '' : query).trim();
      if (!q) return { photos: [], total: 0, page, pageSize, totalPages: 0 };
      const extraSql = (favoritesOnly ? ' AND is_favorite = 1' : '') + mediaSql + orgSql;
      const nameWhere = `file_name LIKE ? ESCAPE '\\'${extraSql}`;
      // 覆盖索引只在「没有别的列参与筛选」且**索引真的在**时才钉（见 `NAME_LIKE_INDEX` 注释）。
      const hint =
        !extraSql && heavy.hasIndex(this.db, NAME_LIKE_INDEX)
          ? ` INDEXED BY ${NAME_LIKE_INDEX}`
          : '';
      const nameLike = '%' + escapeLikeLiteral(q) + '%';
      const countSql =
        `SELECT COUNT(*) AS count FROM photos${hint} WHERE ${nameWhere}`;
      // 🔴 缓存参数必须带上 `orgParams`：`whereSql` 里是 `rating = ?` 这种**占位符**，
      //    「rating=5」与「rating=1」的 SQL 文本**完全相同** ⇒ 只按文本做键会让两个不同的
      //    筛选共用同一个 total。而 `photos-total-cache` 的不变量是
      //    「同一条 SQL + 同一组参数 ⇒ 同一个数」，漏参数就破坏了它。
      const countParams = [nameLike].concat(orgParams);
      const cached = photosTotalCache.get('NAME|' + countSql, countParams);
      let nameTotal;
      if (cached != null) {
        nameTotal = cached;
      } else {
        nameTotal = Number(this.db.prepare(countSql).get(...countParams).count) || 0;
        photosTotalCache.set('NAME|' + countSql, countParams, nameTotal);
      }
      const namePhotos = nameTotal
        ? this.db
            .prepare(
              `SELECT ${photoCols} FROM photos${hint} WHERE ${nameWhere}
               ORDER BY file_name
               LIMIT ? OFFSET ?`,
            )
            .all(...countParams, pageSize, offset)
        : [];
      return {
        photos: namePhotos,
        total: nameTotal,
        page,
        pageSize,
        totalPages: Math.ceil(nameTotal / pageSize),
      };
    }

    // FTS5 primary path
    if (this.isFtsIndexReady()) {
      const ftsQuery = this._buildFtsQuery(query);
      if (!ftsQuery) {
        return { photos: [], total: 0, page, pageSize, totalPages: 0 };
      }
      const ftsSub = `photos.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)`;
      const whereSql = favoritesOnly
        ? `${ftsSub} AND is_favorite = 1${mediaSql}${orgSql}`
        : `${ftsSub}${mediaSql}${orgSql}`;
      /**
       * 有没有「FTS 之外」的筛选。它决定两件事，见下。
       * `mediaConds` 非空 ⇔ 请求了 image / video 档；`hasOrgFilter` ⇔ 请求了
       * 评分 / 标记 / 标签筛选（判据与 `pushOrgMetaConditions` 同源，见该函数）。
       */
      const hasExtraFilter = !!favoritesOnly || mediaConds.length > 0 || hasOrgFilter;

      // ── P0-2：total 直接问 FTS（真库 25,759.7 ms → 79.5 ms，324×）
      //
      // 🔴 现写法的代价在于写法本身：`photos.id IN (SELECT rowid FROM photos_fts WHERE MATCH ?)`
      //    会被 SQLite 物化成一张 54 万行的临时 list，然后**回到 `photos` 里一行一行确认**
      //    （计划：`SEARCH photos USING INTEGER PRIMARY KEY (rowid=?)` + `LIST SUBQUERY 1`）。
      //    而 `photos_fts` 是 `content='photos'` 的外部内容表，匹配的 rowid 全在 FTS 索引里
      //    ⇒ 无附加筛选时直接问 FTS 就是同一个数（实测 544,235 逐个相同）。
      //
      // ⚠️ **有**附加筛选时保留现写法：`is_favorite` / 媒体档只有 `photos` 表知道，
      //    而这两个条件都不在 FTS 索引里，逼着它回表 —— 那是语义要求，不是写法问题。
      //
      // ⚠️ 两者相等的依据是三个触发器（`photos_fts_ai/ad/au`）让外部内容表与 `photos` 同步。
      //    这条**不能靠「应该同步」四个字**：`scripts/read-latency-regression.js` 里有一条
      //    机械断言（同一组词、两种写法必须逐个相等），夹具上跑，守住它。
      //
      // ⚠️ total 也走 `photosTotalCache`：它只随命中集变化、**翻页时根本不变**，
      //    而与 `getPhotos` 共用同一套 TTL / 显式清空（搜完图去删图片，清空会一起生效）。
      //    键前缀 `SEARCH|` 把这里的键空间与 `getPhotos` 的分开，两组不变量互不干扰。
      const totalCacheKey = 'SEARCH|' + whereSql;
      // 🔴 `orgParams` 必须进参数列表：`whereSql` 里是 `rating = ?` / `flag = ?` 占位符，
      //    不同的筛选**值**对应**完全相同的 SQL 文本** ⇒ 只按文本做键会把
      //    「仅 5 星」与「仅 1 星」的 total 混成同一个。不变量是
      //    「同一条 SQL + 同一组参数 ⇒ 同一个数」，漏参数就破坏了它，
      //    而症状是「筛选一开就显示别人那一档的张数」，不报错。
      const totalCacheParams = [ftsQuery].concat(orgParams);
      const cachedSearchTotal = photosTotalCache.get(totalCacheKey, totalCacheParams);
      let totalCount;
      if (cachedSearchTotal != null) {
        totalCount = cachedSearchTotal;
      } else {
        const countSql = hasExtraFilter
          ? `SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`
          : `SELECT COUNT(*) as count FROM photos_fts WHERE photos_fts MATCH ?`;
        totalCount = Number(this.db.prepare(countSql).get(...totalCacheParams).count) || 0;
        photosTotalCache.set(totalCacheKey, totalCacheParams, totalCount);
      }

      // ── P0-3：取一页按命中规模分流（真库 32,428.3 ms → 141.2 ms，230×）
      //
      // 两条路各有一个「越……越亏」的方向，所以必须分流而不是替换：
      //   · 原写法（FTS 驱动）= 把**全部命中**物化再回表 + `USE TEMP B-TREE FOR ORDER BY`
      //     ⇒ 命中越多越亏（54 万命中要排 54 万行才取前 100）；
      //   · 索引序（`INDEXED BY idx_photos_date`）= 沿 `date_taken` 走、凑满一页就停
      //     ⇒ 命中越少越亏（冷门词要走到索引尽头才凑够 100 行）。
      //
      // 🔴 **只在无附加筛选时考虑索引序**：有 `favoritesOnly` / 媒体档时，附加条件只有
      //    `photos` 表知道 ⇒ 走索引序要沿途过滤，筛得越严放大得越多（视频档只占 1.5%）。
      //
      // 🔴 副作用（已知、可接受，`searchPhotos` 这条路本来就没有稳定并列序）：
      //    换索引序会让**同秒并列**（`date_taken` 到秒相同）的返回顺序改变。`getPhotos`
      //    有 `applyNaturalNameTieSort` 把并列拉成确定序，这条路**没有** ⇒ 并列项的先后
      //    在此之前就是未定义的。标定时核对过：只有含并列的词首行 id 会变。
      const indexOrderUsable =
        !hasExtraFilter &&
        totalCount >= SEARCH_INDEX_ORDER_MIN_HITS &&
        heavy.hasIndex(this.db, SEARCH_INDEX_ORDER_INDEX);
      const pageSql = indexOrderUsable
        ? `SELECT ${photoCols}
           FROM photos INDEXED BY ${SEARCH_INDEX_ORDER_INDEX}
           WHERE ${whereSql}
           ORDER BY date_taken DESC
           LIMIT ? OFFSET ?`
        : `SELECT ${photoCols}
           FROM photos WHERE ${whereSql}
           ORDER BY date_taken DESC
           LIMIT ? OFFSET ?`;
      const photos = this.db.prepare(pageSql).all(...totalCacheParams, pageSize, offset);
      return {
        photos,
        total: totalCount,
        page,
        pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      };
    }

    // LIKE fallback
    const searchTerm = `%${query}%`;
    const namePathOr = '(file_name LIKE ? OR folder_path LIKE ?)';
    const whereSql = favoritesOnly
      ? `${namePathOr} AND is_favorite = 1${mediaSql}${orgSql}`
      : `${namePathOr}${mediaSql}${orgSql}`;
    // 绑定顺序 = 占位符出现顺序：两个 LIKE 词 → `is_favorite = 1`（字面量、不占参）
    // → 媒体档（字面量、不占参）→ 组织元数据参数。
    const fbParams = [searchTerm, searchTerm].concat(orgParams);
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
      .get(...fbParams);
    const photos = this.db
      .prepare(
        `SELECT ${photoCols}
       FROM photos WHERE ${whereSql}
       ORDER BY date_taken DESC
       LIMIT ? OFFSET ?`,
      )
      .all(...fbParams, pageSize, offset);

    return {
      photos,
      total: total.count,
      page,
      pageSize,
      totalPages: Math.ceil(total.count / pageSize),
    };
  }

  /**
   * 关键词搜**目录**：按目录路径做子串匹配（大小写不敏感），返回命中的目录、每个目录的
   * 图片数与一张封面。与 `searchPhotos` 是两件事：那边返回**图片**（FTS 分词命中
   * `file_name` / `folder_path`），这边返回**目录** —— 搜图页「关键词」档的
   * 「文件夹」分组就是它。
   *
   * ## 为什么用 LIKE 扫 `idx_photos_folder`，而不是 FTS / 媒体档谓词
   *
   * 夹具（108,000 行 / 74 MB / 36,000 目录）+ 真库外推实测：
   *
   *    | 写法 | 计划 | 108k 行 |
   *    | --- | --- | ---: |
   *    | `folder_path LIKE ? GROUP BY folder_path` | `SCAN photos USING COVERING INDEX idx_photos_folder` | **27~49 ms** |
   *
   *   · **覆盖索引**是关键：只碰 `folder_path` 一列 ⇒ 1,656,580 行也**不回表**（BLOB 不进内存），
   *     外推真库 ≈ 0.4~0.8 s，且**没有** `USE TEMP B-TREE FOR GROUP BY`（索引本身按
   *     `folder_path` 有序，分组顺着扫就成）。
   *   · 🔴 **别往这条 WHERE 上再加任何别的列**（`file_type` / `live_still_id` 都行）：
   *     它们都不在 `idx_photos_folder` 里 ⇒ 规划器放弃覆盖索引、逐行回表去读，
   *     这就是 `COALESCE(live_still_id,0)=0` 那次 **105,954 ms** 的同一类坑。
   *     所以 `all` 档**刻意不排**伴生视频（多算一行，换来不回表），媒体档过滤也**不做** ——
   *     搜图页本来就没有媒体档控件（`ai-views.js#applyToolbar` 把它收起来了）。
   *   · 不走 FTS：命中的是**目录**而不是行，`photos.id IN (SELECT rowid FROM photos_fts …)`
   *     要把几十万 rowid 物化再回表（实测 25,759 ms 那条路）。
   *
   * ## 排序
   *
   * 「目录名（末段）命中」排在「路径中间某层命中」之前，同档内按图片数降序 —— 都在内存里排，
   * 因为 `GROUP BY` 的结果最多是**目录数**（真库 ~3 万），不是行数。
   *
   * @param {string} query 用户输入的关键词
   * @param {{ limit?: number }} [options]
   * @returns {{ folders: Array<{folder_path:string, folder_photo_count:number, id:number|null, file_name:string, has_thumbnail:boolean}>, total: number }}
   */
  searchFolders(query, options = {}) {
    var q = String(query || '').trim();
    if (!q) return { folders: [], total: 0 };
    var limit = Math.max(1, Math.min(60, parseInt(options.limit, 10) || 12));
    // 顺序不能反：**先**把用户输入的分隔符归一到库里用的那一种，**再**转义 LIKE 元字符。
    // 反过来的话，归一化插进去的那个 `\` 会被后面的转义吃掉（它自己就是转义符），
    // 于是搜「2024/05」实际去匹配「202405」—— 一个不报错的静默错。
    var sep = this._folderPathSeparator();
    var normalized = sep === '\\' ? q.replace(/\//g, '\\') : q.replace(/\\/g, '/');
    // 用户输入里的 `%` / `_` / `\` 一律当普通字符：不转义的话搜「50%」等于搜「50」+任意后缀。
    var escaped = escapeLikeLiteral(normalized);
    var needle = normalized;
    var like = '%' + escaped + '%';
    var rows = this.db
      .prepare(
        `SELECT folder_path, COUNT(*) AS photo_count
         FROM photos
         WHERE folder_path LIKE ? ESCAPE '\\'
         GROUP BY folder_path`,
      )
      .all(like);
    var needleLow = needle.toLowerCase();
    var scored = rows.map(function (row) {
      var p = String(row.folder_path || '');
      var parts = p.split(/[\\/]+/);
      var leaf = String(parts[parts.length - 1] || '');
      return {
        folder_path: p,
        photo_count: Number(row.photo_count) || 0,
        rank: leaf.toLowerCase().indexOf(needleLow) >= 0 ? 0 : 1,
      };
    });
    scored.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (b.photo_count !== a.photo_count) return b.photo_count - a.photo_count;
      return a.folder_path < b.folder_path ? -1 : a.folder_path > b.folder_path ? 1 : 0;
    });
    var total = scored.length;
    var page = scored.slice(0, limit);
    // 封面：每个目录一条**定点**查询（`folder_path = ?` 走索引区间扫描，只回表该目录那几行）。
    // 与 `getImmediateSubfolderCovers` 共用 `_folderCoverPickOrderBySql()` —— 各写一份就会出现
    // 「搜图页的目录封面和目录浏览里的不是同一张」。
    var pickOrder = this._folderCoverPickOrderBySql();
    var coverStmt = this.db.prepare(
      'SELECT ' +
        folderCoverColumns() +
        ' FROM photos WHERE folder_path = ? ORDER BY ' +
        pickOrder +
        ' LIMIT 1',
    );
    var folders = page.map(function (row) {
      var cover = coverStmt.get(row.folder_path);
      return Object.assign(
        { folder_path: row.folder_path, folder_photo_count: row.photo_count },
        folderCoverRow(cover),
      );
    });
    return { folders: folders, total: total };
  }

  /**
   * 库里 `folder_path` 用的是哪种分隔符（`\` 还是 `/`）。
   *
   * 用户的输入两边都可能（`2024/05` 与 `2024\05` 是同一个意思），而 LIKE 没法一次性匹配两种；
   * 用 `REPLACE(folder_path,'\','/')` 又能把**索引**搞没（列上套了表达式 ⇒ 回表）。
   * ⇒ 探一下库里真实用的那一种，再把用户输入归一到它。结果按实例缓存：分隔符不会中途变。
   *
   * 探针本身是覆盖索引上的 `LIMIT 1`（夹具实测 0.1 ms），不是全表扫。
   */
  _folderPathSeparator() {
    if (this._folderSep) return this._folderSep;
    var sep = '/';
    try {
      var row = this.db
        .prepare(
          "SELECT folder_path FROM photos WHERE folder_path LIKE '%' || char(92) || '%' LIMIT 1",
        )
        .get();
      if (row && String(row.folder_path || '').indexOf('\\') >= 0) sep = '\\';
    } catch (e) {
      sep = '/';
    }
    this._folderSep = sep;
    return this._folderSep;
  }

  // === Batch insert helpers for scanner ===
  // 获取指定根目录下所有已有文件的路径和修改时间（用于增量扫描去重）
  getExistingFiles(rootId) {
    return this.db
      .prepare('SELECT file_path, date_modified, file_size FROM photos WHERE root_id = ?')
      .all(rootId);
  }

  // 兼容扫描器的流式迭代调用，避免一次性加载大量记录
  iterateExistingFiles(rootId) {
    return this.db
      .prepare('SELECT file_path, date_modified, file_size FROM photos WHERE root_id = ?')
      .iterate(rootId);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  beginTransaction() {
    this.db.exec('BEGIN TRANSACTION');
  }

  commit() {
    this.db.exec('COMMIT');
  }

  rollback() {
    this.db.exec('ROLLBACK');
  }

  /**
   * 批量写入 dHash（单一事务，比逐条调用 updatePhotoDhash 快 10-50 倍）
   * @param {Array<{id,dhash,buckets,mtime,size}>} batch
   */
  updatePhotoDhashBatch(batch) {
    this.ensureDhashSchema();
    if (!Array.isArray(batch) || batch.length === 0) return;
    var self = this;
    var stmtUpdate = this.db.prepare(
      'UPDATE photos SET dhash = ?, dhash_mtime = ?, dhash_size = ? WHERE id = ?',
    );
    var stmtDeleteLsh = this.db.prepare('DELETE FROM photo_dhash_lsh WHERE photo_id = ?');
    var stmtInsertLsh = this.db.prepare(
      'INSERT INTO photo_dhash_lsh (photo_id, band, bucket) VALUES (?, ?, ?)',
    );
    var tx = this.db.transaction(function () {
      for (var i = 0; i < batch.length; i++) {
        var r = batch[i];
        var id = parseInt(r.id, 10);
        if (!isFinite(id) || id <= 0) continue;
        stmtUpdate.run(
          String(r.dhash),
          r.mtime != null ? String(r.mtime) : null,
          Number(r.size) || 0,
          id,
        );
        stmtDeleteLsh.run(id);
        if (Array.isArray(r.buckets) && r.buckets.length === 16) {
          for (var band = 0; band < 16; band++) {
            stmtInsertLsh.run(id, band, r.buckets[band]);
          }
        }
      }
    });
    tx();
    void self;
  }

  insertPhoto(photo) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO photos
        (root_id, folder_path, file_name, file_path, file_size, file_type,
         width, height, date_taken, date_modified, thumbnail, has_thumbnail,
         thumb_size, thumb_format,
         camera_make, camera_model, lens_model, focal_length, aperture,
         iso_speed, shutter_speed, gps_latitude, gps_longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      photo.rootId,
      photo.folderPath,
      photo.fileName,
      photo.filePath,
      photo.fileSize,
      photo.fileType,
      photo.width,
      photo.height,
      photo.dateTaken,
      photo.dateModified,
      photo.thumbnail,
      photo.hasThumbnail ? 1 : 0,
      // 没生成缩略图时规格必须是 0 / ''（未知），不能跟着传进来的档位走
      photo.thumbnail ? parseInt(photo.thumbSize, 10) || 0 : 0,
      photo.thumbnail ? normalizeThumbFormat(photo.thumbFormat) : '',
      photo.cameraMake || null,
      photo.cameraModel || null,
      photo.lensModel || null,
      photo.focalLength || null,
      photo.aperture || null,
      photo.isoSpeed || null,
      photo.shutterSpeed || null,
      photo.gpsLatitude || null,
      photo.gpsLongitude || null,
    );
  }

  /**
   * 扫描「新文件入库」用的语句。
   *
   * 🔴 保留 `OR IGNORE`：它承担**快速判重**的角色 —— `changes === 0` 就说明这个
   * `file_path` 已经有一行了。但「已存在」**不等于「不用管」**：路径一样、文件被换过的情况
   * 必须走 `getUpdateFileFactsStmt()`（见它的注释）。只留 `OR IGNORE` 一条写路径就是
   * 当年「候选永不收敛」的成因。
   *
   * 列清单与 `getUpdateFileFactsStmt()` 共用 `SCAN_WRITE_COLUMNS`，不许各写一份。
   */
  getInsertStmt() {
    return this.db.prepare(
      'INSERT OR IGNORE INTO photos (' +
        SCAN_WRITE_COLUMNS.join(', ') +
        ') VALUES (' +
        SCAN_WRITE_COLUMNS.map(function () {
          return '?';
        }).join(', ') +
        ')',
    );
  }

  /**
   * 扫描「同一个 `file_path`、但文件内容变了」时更新该行。
   *
   * 🔴 **为什么必须有这条路径**：`getInsertStmt()` 是 `INSERT OR IGNORE`，同路径已存在时
   * `changes === 0`，新的 `file_size` / `date_modified` 连同本次读到的元数据**全被丢弃**，
   * 于是下一轮扫描仍然判定它「已变更」⇒ **候选集永不收敛**；就地替换过的图片还会一直
   * 保留旧缩略图与旧指纹。全工程过去**没有任何** `UPDATE photos SET file_size / date_modified`。
   *
   * 参数顺序与 `getInsertStmt()` **逐位相同**（`SCAN_WRITE_COLUMNS`），只少了 `file_path`
   * 那一项 —— 它在 `SET` 里不出现，只在 `WHERE` 里用（列上有 UNIQUE 约束，走自动索引定位）。
   * 调用端（`scanner.js#processFile`）传的就是 INSERT 的同一份参数数组 `splice(3, 1)` 之后的结果。
   *
   * `dhash*` / `file_hash` / `hash_*` 这几列是**延迟迁移**出来的（`ensureDhashSchema` /
   * `ensureDuplicateHashSchema`），老库上可能还不存在。这里**按列实际存在与否裁剪 SET 子句**，
   * 刻意**不**在这条路径上触发迁移 —— 迁移里带着 `CREATE INDEX`，在扫描启动路径上同步跑
   * 会把首窗卡住（见 `ensureDuplicateHashSchema` 头注释）。
   *
   * ⚠️ `is_favorite` 不在此列：它是用户数据，与文件内容无关。
   *
   * @returns {import('better-sqlite3').Statement}
   */
  getUpdateFileFactsStmt() {
    var self = this;
    var setters = [];
    for (var i = 0; i < SCAN_WRITE_COLUMNS.length; i++) {
      var col = SCAN_WRITE_COLUMNS[i];
      if (col === 'file_path') continue;
      setters.push(col + ' = ?');
    }
    for (var j = 0; j < SCAN_INVALIDATED_ON_CONTENT_CHANGE.length; j++) {
      var fragment = SCAN_INVALIDATED_ON_CONTENT_CHANGE[j];
      var colName = fragment.split(' ')[0];
      var exists = typeof self.hasPhotosColumn === 'function' ? self.hasPhotosColumn(colName) : false;
      if (exists) setters.push(fragment);
    }
    return this.db.prepare(
      'UPDATE photos SET ' + setters.join(', ') + ' WHERE file_path = ?',
    );
  }

  // 兼容扫描器：当前库结构未启用 file_hash 时直接返回空候选
  findMissingHashRelocateCandidates(fileSize, currentFilePath) {
    void fileSize;
    void currentFilePath;
    return [];
  }

  // 兼容扫描器：按同名+同大小+同修改时间查找可重定位候选
  findRelocateCandidates(fileName, fileSize, dateModified, currentFilePath) {
    return this.db
      .prepare(
        `SELECT id, file_path
         FROM photos
         WHERE file_name = ?
           AND file_size = ?
           AND date_modified = ?
           AND file_path <> ?
         ORDER BY id DESC
         LIMIT 32`,
      )
      .all(fileName, fileSize, dateModified, currentFilePath);
  }

  // 兼容扫描器：把旧记录重定位到新路径，保留原有缩略图等字段
  relocatePhotoRecord(photoId, rootId, folderPath, filePath) {
    var fileName = path.basename(filePath || '');
    var r = this.db
      .prepare(
        `UPDATE photos
         SET root_id = ?, folder_path = ?, file_name = ?, file_path = ?
         WHERE id = ?`,
      )
      .run(rootId, folderPath, fileName, filePath, photoId);
    return r && r.changes > 0;
  }

  /**
   * 兼容扫描器：扫描完成后删除该根目录下已不存在的旧记录。
   *
   * 🔴 **按 id 区间分批 + 批间让出，禁止 `.all()` 一次性物化整根**，且调用端必须 `await`
   * （`scanner.js` 收尾段）。理由是同一个看门狗：真库 `K:\COS`（912,222 行）实测
   * 「一次性 `.all()` + 逐行比对」是一段 **71,070 ms 完全不发消息**的同步代码，
   * 早已越过 `main.js#runFolderScanInWorker` 的 120 秒阈值 —— 于是一个只是**正在读盘**的
   * 扫描被判成「线程无响应」并 `terminate()`，用户看到「自动扫描失败：扫描线程无响应…已终止」。
   * 分批后同一工作量总耗时 30,990 ms、单批最大 1,433 ms，心跳照发、扫描能跑完。
   *
   * ⚠️ 「主键倒序」那条统一方向约定**不适用**于这里：那条约定针对的是「本批没跑完就要下次继续」
   * 的后台补全类任务（最新入库优先）。这里是**一次扫尾必须看完全部行**的完整性遍历，
   * 方向不影响结果，只影响读盘顺序 —— 按 id 升序与 `idx_photos_root` 的 (root_id, rowid)
   * 顺序一致，是覆盖最顺的走法。
   *
   * @param {number} rootId
   * @param {Set<string>} scannedPathSet 本次枚举到的绝对路径；为空集时退回逐行 `fs.existsSync`
   * @param {{ batchSize?: number, yieldFn?: () => Promise<void> }} [options]
   * @returns {Promise<{ checked: number, deleted: number, markedMissing: number }>}
   */
  async cleanupStalePhotosForRoot(rootId, scannedPathSet, options) {
    options = options || {};
    var result = { checked: 0, deleted: 0, markedMissing: 0 };
    var rid = parseInt(rootId, 10);
    if (!isFinite(rid) || rid <= 0) return result;
    var batchSize =
      parseInt(options.batchSize, 10) > 0 ? parseInt(options.batchSize, 10) : SCAN_TAIL_BATCH_ROWS;
    var yieldFn = typeof options.yieldFn === 'function' ? options.yieldFn : yieldToEventLoop;
    var useScannedSet = !!(scannedPathSet && scannedPathSet.size > 0);
    // ❗ 必须带 ORDER BY id 才能让 `idx_photos_root`（rowid 有序）顺着走并靠 LIMIT 早停；
    // 少了它计划会退化成整表扫 + 临时排序（回归里钉了计划）。
    var pageStmt = this.db.prepare(
      'SELECT id, file_path FROM photos WHERE root_id = ? AND id > ? ORDER BY id LIMIT ?',
    );
    var delStmt = this.db.prepare('DELETE FROM photos WHERE id = ?');
    var cursor = 0;
    var checked = 0;
    var deleted = 0;
    for (;;) {
      var rows = pageStmt.all(rid, cursor, batchSize);
      if (!rows.length) break;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        checked++;
        var p = row && row.file_path ? String(row.file_path) : '';
        var stale = !p;
        if (!stale) {
          stale = useScannedSet ? !scannedPathSet.has(p) : !fs.existsSync(p);
        }
        if (stale) {
          delStmt.run(row.id);
          deleted++;
        }
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < batchSize) break;
      await yieldFn();
    }
    result.checked = checked;
    result.deleted = deleted;
    result.markedMissing = deleted;
    return result;
  }

  async backupToFile(destPath) {
    await this.db.backup(destPath);
  }

  close() {
    this.db.close();
  }
}

// 连接级 PRAGMA 常量的对外出口：读池 worker（`src/workers/db-read-worker.js`）靠它拿到
// 与主进程**逐位相同**的 cache_size / mmap_size，不许在那边再抄一份数字。
PhotoDatabase.DB_CACHE_SIZE_KB = DB_CACHE_SIZE_KB;
PhotoDatabase.DB_MMAP_SIZE_BYTES = DB_MMAP_SIZE_BYTES;
PhotoDatabase.applyReadConnectionPragmas = applyReadConnectionPragmas;

module.exports = PhotoDatabase;
