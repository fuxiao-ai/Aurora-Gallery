'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const heavy = require('../db-heavy-read');
const PhotoDatabase = require('../database');
const photosTotalCache = require('../photos-total-cache');
const statsAggCache = require('../stats-agg-cache');

var db = null;

function openDb() {
  if (db) return db;
  var p = workerData && workerData.dbPath;
  if (!p || typeof p !== 'string') {
    throw new Error('db-read-worker: missing dbPath');
  }
  db = new Database(p, { readonly: true, fileMustExist: true });
  // 🔴 连接级 PRAGMA 与主进程同源（唯一真相源在 `src/database.js`，别在这里抄数字）：
  // 这个连接跑的是**最贵的查询**（`getFolderTree` 的 91 万行回表聚合、`getStats` 的多条
  // 子查询），而它过去一个都没设 ⇒ 吃 SQLite 默认值（cache 2 MB、mmap 关闭），几乎全靠
  // OS page cache 兜底，14.5 GB 的库不可能全缓存。只读连接多占内存、不占锁。
  PhotoDatabase.applyReadConnectionPragmas(db);
  return db;
}

parentPort.on('message', function (msg) {
  // 主进程「行数变了」之后的显式清空（见 `src/photos-total-cache.js` 的失效段）。
  // **没有 id，也不回包** —— 与请求/响应那条路天然分开，所以它不会打乱 `slot.job` 的配对。
  // 排在前面的同步查询跑完、响应发回之后，本消息才被处理 ⇒ 那份（可能已过期的）缓存条目
  // 一定在它之后被清掉，清空不会输给在途查询。
  if (msg && msg.op === '__cache_reset') {
    photosTotalCache.invalidateAll();
    statsAggCache.invalidateAll();
    return;
  }
  var id = msg && msg.id;
  try {
    var database = openDb();
    var result;
    if (
      ['getPhotos', 'getFolderPhotos', 'searchPhotos', 'getRandomPreviewPhotoBatch'].includes(msg.op)
    ) {
      // Reuse the shared query implementation without constructor migrations or writes.
      const reader = Object.create(PhotoDatabase.prototype);
      reader.db = database;
      reader.fileNameNaturalCollator = null;
      reader._ftsAvailable = !!database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'photos_fts'")
        .get();
      const options = Object.assign({}, msg.options || {});
      options.page = Math.max(1, parseInt(options.page, 10) || 1);
      options.pageSize = Math.max(1, Math.min(500, parseInt(options.pageSize, 10) || 100));
      if (options.sortOrder !== undefined) options.sortOrder = String(options.sortOrder);
      if (msg.op === 'getFolderPhotos')
        result = reader.getFolderPhotos(options.folderPath, options);
      else if (msg.op === 'searchPhotos') result = reader.searchPhotos(options.query, options);
      else if (msg.op === 'getRandomPreviewPhotoBatch')
        result = reader.getRandomPreviewPhotoBatch(options);
      else result = reader.getPhotos(options);
    } else if (msg.op === 'getRootFolders') {
      var rfOpts = msg.options || {};
      result =
        rfOpts.lite === true
          ? heavy.runGetRootFoldersLite(database)
          : heavy.runGetRootFoldersAgg(database, rfOpts);
    } else if (msg.op === 'getStats') {
      result = heavy.runGetStatsAgg(database);
    } else if (msg.op === 'getFolderTree') {
      result = heavy.runGetFolderTree(database, msg.options && msg.options.rootId);
    } else if (msg.op === 'getFolderCovers') {
      result = heavy.runGetFolderCovers(database, msg.options || {});
    } else if (msg.op === 'getImmediateSubfolderCovers') {
      result = heavy.runGetImmediateSubfolderCovers(database, msg.options || {});
    } else if (msg.op === 'getDateGroups') {
      result = heavy.runGetDateGroups(database, msg.options || {});
    } else if (msg.op === 'getDatePhotos') {
      var dp = msg.options || {};
      result = heavy.runGetDatePhotos(database, dp.dateStr, dp);
    } else if (msg.op === 'getHashAllPhotoCount') {
      result = heavy.runGetHashAllPhotoCount(database);
    } else if (msg.op === 'getPendingThumbCount') {
      // 复用共享实现，**不在这里再抄一次谓词**：这个数会当补全进度的分母，而分母与
      // 候选谓词的关系是承重的（见 `countPhotosLackingThumbnail()` 的注释）——
      // 在 worker 里手抄第二份，等于给「两边悄悄漂开」留门。
      const thumbReader = Object.create(PhotoDatabase.prototype);
      thumbReader.db = database;
      result = thumbReader.countPhotosLackingThumbnail();
    } else if (msg.op === 'estimatePendingCount') {
      // 补全主进度条的**分母**。同样复用共享实现 —— 它内部用的是 `_sqlBackfillPendingExpr()`
      // 本身，也就是说：**谓词改一个字，分母自动跟着改**。在这里手抄一份抽样 SQL 是最容易
      // 漂的地方（分母与候选集不同源 ⇒ 百分比与真实工作量脱钩，而且不会报错）。
      const pendingReader = Object.create(PhotoDatabase.prototype);
      pendingReader.db = database;
      const pendOpts = msg.options || {};
      result = pendingReader.estimatePendingCandidateCount(pendOpts.samples);
    } else if (msg.op === 'getDuplicateGroupCountByHash') {
      var og = msg.options || {};
      result = heavy.runGetDuplicateGroupCountByHash(database, og.minCount);
    } else if (msg.op === 'getDuplicatePhotoCountByHash') {
      var op = msg.options || {};
      result = heavy.runGetDuplicatePhotoCountByHash(database, op.minCount);
    } else if (msg.op === 'getDuplicateHashGroupsBundle') {
      result = heavy.runGetDuplicateHashGroupsBundle(database, msg.options || {});
    } else {
      throw new Error('db-read-worker: unknown op ' + String(msg && msg.op));
    }
    parentPort.postMessage({ id: id, ok: true, result: result });
  } catch (e) {
    parentPort.postMessage({
      id: id,
      ok: false,
      error: e && e.message ? e.message : String(e),
    });
  }
});
