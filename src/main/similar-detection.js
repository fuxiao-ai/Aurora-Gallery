/**
 * 相似照片检测引擎
 * 三层分组架构：
 *   第零层：dHash 精确匹配（SQL GROUP BY，秒级）
 *   第一层：文件夹内近似匹配（LSH + BFS，分钟级）
 *   第二层：跨文件夹按需实时查询（内存 LSH 索引）
 */

'use strict';

const { hammingDistanceEarlyExit } = require('./perceptual-hash');

/**
 * 第零层：dHash 精确匹配的组列表
 * 直接调用 database.js 的 SQL 查询
 */
function getExactDhashGroups(db, page, pageSize) {
  var lim = Math.max(1, Math.min(parseInt(pageSize, 10) || 40, 500));
  var off = Math.max(0, (Math.max(1, parseInt(page, 10) || 1) - 1) * lim);
  return db.getDuplicateDhashGroups(lim, off);
}

/**
 * 第一层：文件夹内近似匹配（BFS 连通分量）
 * 对 dHash 唯一的照片，按 folder_path 分区做 BFS
 * @param {object} db
 * @param {number} threshold 汉明距离阈值（默认 12）
 * @returns {Array<Array<number>>} 分组数组，每组是 photo_id 列表
 */
function buildFolderSimilarGroups(db, threshold) {
  threshold = Math.max(0, Math.min(parseInt(threshold, 10) || 12, 64));

  // 1. 获取 dHash 唯一的照片（排除第零层已覆盖的）
  var rows = db
    .prepare(
      `SELECT id, folder_path, dhash FROM photos
     WHERE dhash IS NOT NULL AND TRIM(dhash) != ''
       AND dhash NOT IN (
         SELECT dhash FROM photos WHERE dhash IS NOT NULL
         GROUP BY dhash HAVING COUNT(*) > 1
       )
     ORDER BY folder_path ASC, id ASC`,
    )
    .all();

  // 2. 按 folder_path 分区
  var byFolder = {};
  for (var i = 0; i < rows.length; i++) {
    var fp = rows[i].folder_path;
    if (!byFolder[fp]) byFolder[fp] = [];
    byFolder[fp].push({ id: rows[i].id, dhash: rows[i].dhash });
  }

  // 3. 每个文件夹内做 BFS
  var allGroups = [];
  var folders = Object.keys(byFolder);
  for (var f = 0; f < folders.length; f++) {
    var photos = byFolder[folders[f]];
    if (photos.length < 2) continue;
    var groups = bfsGroups(photos, threshold);
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].length >= 2) {
        allGroups.push(groups[g]);
      }
    }
  }
  return allGroups;
}

/**
 * 单层 BFS：对同一组照片找汉明距离 <= threshold 的连通分量
 * @param {Array<{id:number,dhash:string}>} photos
 * @param {number} threshold
 * @returns {Array<Array<number>>}
 */
function bfsGroups(photos, threshold) {
  var n = photos.length;
  if (n < 2) return [];
  var visited = new Set();
  var groups = [];

  for (var i = 0; i < n; i++) {
    var startId = photos[i].id;
    if (visited.has(startId)) continue;

    var group = [];
    var queue = [i]; // 存索引而非 id，方便访问 dhash
    visited.add(startId);

    while (queue.length > 0) {
      var curIdx = queue.shift();
      var cur = photos[curIdx];
      group.push(cur.id);

      for (var j = 0; j < n; j++) {
        if (j === curIdx) continue;
        var other = photos[j];
        if (visited.has(other.id)) continue;
        if (hammingDistanceEarlyExit(cur.dhash, other.dhash, threshold) <= threshold) {
          visited.add(other.id);
          queue.push(j);
        }
      }
    }

    if (group.length >= 2) {
      groups.push(group);
    }
  }
  return groups;
}

/**
 * 第二层：按需实时查询某张照片的跨文件夹相似照片
 * @param {object} db
 * @param {number} photoId
 * @param {number} threshold
 * @returns {Array<number>} 相似 photo_id 列表
 */
function findSimilarPhotos(db, photoId, threshold) {
  threshold = Math.max(0, Math.min(parseInt(threshold, 10) || 12, 64));

  var row = db.prepare('SELECT dhash FROM photos WHERE id = ?').get(photoId);
  if (!row || !row.dhash) return [];
  var dhash = row.dhash;

  // 构建 LSH 查询条件
  var buckets = [];
  for (var i = 0; i < 16; i++) {
    buckets.push(parseInt(dhash[i], 16));
  }

  // UNION 查询 16 个 band 的候选
  var conditions = [];
  for (var b = 0; b < 16; b++) {
    conditions.push('(band = ' + b + ' AND bucket = ' + buckets[b] + ')');
  }
  var sql =
    'SELECT DISTINCT photo_id FROM photo_dhash_lsh WHERE photo_id != ? AND (' +
    conditions.join(' OR ') +
    ')';
  var candidates = db.prepare(sql).all(photoId);

  // 精确过滤汉明距离
  var results = [];
  if (candidates.length === 0) return results;

  // 批量查询候选的 dhash
  var ids = candidates
    .map(function (c) {
      return c.photo_id;
    })
    .filter(function (id) {
      return isFinite(id) && id > 0;
    });
  if (ids.length === 0) return results;

  var placeholders = ids
    .map(function () {
      return '?';
    })
    .join(',');
  var candStmt = db.prepare(
    'SELECT id, dhash FROM photos WHERE id IN (' + placeholders + ') AND dhash IS NOT NULL',
  );
  var candRows = candStmt.all.apply(candStmt, ids);

  for (var j = 0; j < candRows.length; j++) {
    var cr = candRows[j];
    if (cr.dhash && hammingDistanceEarlyExit(dhash, cr.dhash, threshold) <= threshold) {
      results.push(cr.id);
    }
  }
  return results;
}

// ───────────────────────────────────────────────
// 内存 LSH 索引（第二层优化）
// ───────────────────────────────────────────────

/**
 * 从数据库全量加载构建内存 LSH 倒排索引
 * @param {object} db
 * @returns {object} { index: Map<band:bucket, photoId[]>, dhashMap: Map<photoId, dhash> }
 */
function buildLshIndex(db) {
  var rows = db
    .prepare('SELECT photo_id, band, bucket FROM photo_dhash_lsh ORDER BY photo_id, band')
    .all();
  var index = new Map();
  var dhashMap = new Map();

  // 同时加载 photos.dhash
  var dhashRows = db
    .prepare("SELECT id, dhash FROM photos WHERE dhash IS NOT NULL AND TRIM(dhash) != ''")
    .all();
  for (var d = 0; d < dhashRows.length; d++) {
    dhashMap.set(dhashRows[d].id, dhashRows[d].dhash);
  }

  // 构建倒排索引
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var key = r.band + ':' + r.bucket;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r.photo_id);
  }

  return { index: index, dhashMap: dhashMap };
}

/**
 * 使用内存 LSH 索引快速查询相似照片（比纯 SQL 快 5-10 倍）
 * @param {number} photoId
 * @param {number} threshold
 * @param {object} lshIndex 由 buildLshIndex() 构建
 * @returns {Array<number>}
 */
function findSimilarPhotosWithIndex(photoId, threshold, lshIndex) {
  threshold = Math.max(0, Math.min(parseInt(threshold, 10) || 12, 64));
  var dhash = lshIndex.dhashMap.get(photoId);
  if (!dhash) return [];

  var buckets = [];
  for (var i = 0; i < 16; i++) {
    buckets.push(parseInt(dhash[i], 16));
  }

  var candidateSet = new Set();
  for (var band = 0; band < 16; band++) {
    var key = band + ':' + buckets[band];
    var list = lshIndex.index.get(key);
    if (list) {
      for (var k = 0; k < list.length; k++) {
        if (list[k] !== photoId) candidateSet.add(list[k]);
      }
    }
  }

  var results = [];
  candidateSet.forEach(function (cid) {
    var cdhash = lshIndex.dhashMap.get(cid);
    if (cdhash && hammingDistanceEarlyExit(dhash, cdhash, threshold) <= threshold) {
      results.push(cid);
    }
  });
  return results;
}

module.exports = {
  getExactDhashGroups: getExactDhashGroups,
  buildFolderSimilarGroups: buildFolderSimilarGroups,
  findSimilarPhotos: findSimilarPhotos,
  buildLshIndex: buildLshIndex,
  findSimilarPhotosWithIndex: findSimilarPhotosWithIndex,
};
