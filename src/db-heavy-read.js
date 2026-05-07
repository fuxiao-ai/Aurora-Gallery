'use strict';

/**
 * 与 root_folder_stats_cache.media_key 一致（all / image / video）
 */
function rootFolderStatsCacheMediaKey(options) {
  options = options || {};
  var m = String(options.mediaType || '').toLowerCase();
  if (m === 'image') return 'image';
  if (m === 'video') return 'video';
  return 'all';
}

/**
 * 若缓存已覆盖当前所有根目录行则直接返回，否则 null（走全表聚合）
 * @param {import('better-sqlite3').Database} db
 */
function tryReadRootFolderStatsCache(db, options) {
  try {
    var chk = db
      .prepare(
        "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'root_folder_stats_cache' LIMIT 1",
      )
      .get();
    if (!chk) return null;
    var mediaKey = rootFolderStatsCacheMediaKey(options);
    var rootCountRow = db.prepare('SELECT COUNT(*) AS c FROM root_folders').get();
    var rootCount = rootCountRow ? Number(rootCountRow.c) : 0;
    if (rootCount === 0) return null;
    var rows = db
      .prepare(
        `SELECT rf.id AS id, rf.path AS path, rf.name AS name,
                c.photo_count AS photo_count, c.folder_count AS folder_count, c.video_count AS video_count
         FROM root_folders rf
         INNER JOIN root_folder_stats_cache c ON c.root_id = rf.id AND c.media_key = ?
         ORDER BY rf.name ASC`,
      )
      .all(mediaKey);
    if (rows.length === rootCount) return rows;
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 仅统计单个 root_id（WHERE root_id = ?），用于扫描结束后增量回填 root_folder_stats_cache，避免清缓存后依赖全库 GROUP BY。
 * @param {import('better-sqlite3').Database} db
 * @param {number} rootId
 * @param {{ mediaType?: string }} [options]
 * @returns {{ photo_count: number, folder_count: number, video_count: number } | null}
 */
function runAggregateStatsForSingleRoot(db, rootId, options) {
  rootId = parseInt(rootId, 10);
  if (!isFinite(rootId) || rootId <= 0) return null;
  options = options || {};
  var media = String(options.mediaType || '').toLowerCase();
  var mediaWhere;
  if (media === 'image') {
    mediaWhere =
      "p.root_id = ? AND lower(replace(p.file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  } else if (media === 'video') {
    mediaWhere =
      "p.root_id = ? AND lower(replace(p.file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  } else {
    mediaWhere = 'p.root_id = ?';
  }
  var videoPred =
    "lower(replace(p.file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  var countRow = db
    .prepare(
      `
      SELECT
        COUNT(*) AS photo_count,
        COALESCE(SUM(CASE WHEN ${videoPred} THEN 1 ELSE 0 END), 0) AS video_count
      FROM photos p
      WHERE ${mediaWhere}
    `,
    )
    .get(rootId);
  var folderRow = db
    .prepare(
      `
      SELECT COUNT(*) AS folder_count FROM (
        SELECT DISTINCT p.folder_path
        FROM photos p
        WHERE ${mediaWhere}
      )
    `,
    )
    .get(rootId);
  return {
    photo_count: countRow ? Number(countRow.photo_count) || 0 : 0,
    folder_count: folderRow ? Number(folderRow.folder_count) || 0 : 0,
    video_count: countRow ? Number(countRow.video_count) || 0 : 0,
  };
}

/**
 * 只读聚合查询（供主库与 db-read Worker 共用），避免与 PhotoDatabase 类循环依赖。
 * @param {import('better-sqlite3').Database} db
 */
function runGetRootFoldersAgg(db, options) {
  options = options || {};
  var cached = tryReadRootFolderStatsCache(db, options);
  if (cached) return cached;
  const { mediaType } = options;
  var media = String(mediaType || '').toLowerCase();
  var mediaWhere = '';
  if (media === 'image') {
    mediaWhere =
      " AND lower(replace(p.file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  } else if (media === 'video') {
    mediaWhere =
      " AND lower(replace(p.file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  }
  var videoPred =
    "lower(replace(p.file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  var mediaWhereBare = mediaWhere.replace(/\bp\./g, '');
  var videoPredBare = videoPred.replace(/\bp\./g, '');
  /** 两步：先按 root_id 聚合件数/视频数，再对 (root_id, folder_path) 去重后计目录数；利于走 (root_id, folder_path) 索引，避免单语句内 COUNT(DISTINCT) 与大 GROUP BY 耦合 */
  var rows = db
    .prepare(
      `
      WITH counts AS (
        SELECT
          root_id,
          COUNT(*) AS photo_count,
          COALESCE(SUM(CASE WHEN ${videoPredBare} THEN 1 ELSE 0 END), 0) AS video_count
        FROM photos
        WHERE 1 = 1 ${mediaWhereBare}
        GROUP BY root_id
      ),
      folder_counts AS (
        SELECT d.root_id, COUNT(*) AS folder_count
        FROM (
          SELECT DISTINCT root_id, folder_path
          FROM photos
          WHERE 1 = 1 ${mediaWhereBare}
        ) AS d
        GROUP BY d.root_id
      )
      SELECT
        rf.id AS id,
        rf.path AS path,
        rf.name AS name,
        COALESCE(c.photo_count, 0) AS photo_count,
        COALESCE(f.folder_count, 0) AS folder_count,
        COALESCE(c.video_count, 0) AS video_count
      FROM root_folders rf
      LEFT JOIN counts c ON c.root_id = rf.id
      LEFT JOIN folder_counts f ON f.root_id = rf.id
      ORDER BY rf.name ASC
    `,
    )
    .all();

  if (rows && rows.length > 0) {
    return rows;
  }

  var path = require('path');
  var mediaWhereP2 = mediaWhere.replace(/\bp\./g, 'p2.');
  var fallbackRows = db
    .prepare(
      `
      WITH counts AS (
        SELECT
          p.root_id AS id,
          MIN(p.folder_path) AS path,
          COUNT(p.id) AS photo_count,
          COALESCE(SUM(CASE WHEN ${videoPred} THEN 1 ELSE 0 END), 0) AS video_count
        FROM photos p
        WHERE 1 = 1 ${mediaWhere}
        GROUP BY p.root_id
      ),
      folder_counts AS (
        SELECT d.root_id, COUNT(*) AS folder_count
        FROM (
          SELECT DISTINCT p2.root_id, p2.folder_path
          FROM photos p2
          WHERE 1 = 1 ${mediaWhereP2}
        ) AS d
        GROUP BY d.root_id
      )
      SELECT
        c.id AS id,
        c.path AS path,
        c.photo_count AS photo_count,
        COALESCE(f.folder_count, 0) AS folder_count,
        c.video_count AS video_count
      FROM counts c
      LEFT JOIN folder_counts f ON f.root_id = c.id
      ORDER BY c.path ASC
    `,
    )
    .all();

  for (var i = 0; i < fallbackRows.length; i++) {
    var item = fallbackRows[i];
    item.name = path.basename(item.path || '');
  }
  return fallbackRows;
}

/**
 * 仅 root_folders 表，与 PhotoDatabase.getRootFolders 的 lite 分支一致（供 Worker 使用，避免主进程同步读库卡死窗口）。
 * @param {import('better-sqlite3').Database} db
 */
function runGetRootFoldersLite(db) {
  var liteRows = db.prepare('SELECT id, path, name FROM root_folders ORDER BY name ASC').all();
  if (liteRows && liteRows.length > 0) {
    for (var li = 0; li < liteRows.length; li++) {
      liteRows[li].photo_count = null;
      liteRows[li].folder_count = null;
      liteRows[li].video_count = null;
    }
    return liteRows;
  }
  return [];
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetStatsAgg(db) {
  const videoIn =
    "'mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2'";
  const row = db
    .prepare(
      `SELECT
           COUNT(*) AS c_total,
           COALESCE(SUM(file_size), 0) AS sum_size,
           COUNT(DISTINCT folder_path) AS c_distinct_folders,
           COALESCE(
             SUM(CASE WHEN lower(replace(file_type, '.', '')) IN (${videoIn}) THEN 1 ELSE 0 END),
             0
           ) AS c_video,
           COALESCE(
             SUM(CASE WHEN lower(replace(file_type, '.', '')) IN (${videoIn}) THEN file_size ELSE 0 END),
             0
           ) AS sum_video_size,
           COALESCE(SUM(CASE WHEN is_favorite = 1 THEN 1 ELSE 0 END), 0) AS c_fav,
           MIN(date_taken) AS min_date,
           MAX(date_taken) AS max_date
         FROM photos`,
    )
    .get();

  // 统计人脸数据
  var faceStats = { totalFaces: 0, photosWithFaces: 0 };
  try {
    var hasFacesTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='faces'")
      .get();
    if (hasFacesTable) {
      // 总人脸数
      var totalFacesRow = db.prepare('SELECT COUNT(*) AS c FROM faces').get();
      faceStats.totalFaces = totalFacesRow && totalFacesRow.c ? Number(totalFacesRow.c) : 0;
      // 包含至少一张人脸的图片数
      var photosWithFacesRow = db.prepare('SELECT COUNT(DISTINCT photo_id) AS c FROM faces').get();
      faceStats.photosWithFaces =
        photosWithFacesRow && photosWithFacesRow.c ? Number(photosWithFacesRow.c) : 0;
    }
  } catch (e) {
    // 表不存在忽略
  }

  const roots = db.prepare('SELECT COUNT(*) as count FROM root_folders').get();

  return {
    totalPhotos: row ? row.c_total : 0,
    totalSize: row ? row.sum_size : 0,
    videoPhotos: row ? row.c_video : 0,
    videoSize: row ? row.sum_video_size : 0,
    totalFolders: row ? row.c_distinct_folders : 0,
    totalRoots: roots ? roots.count : 0,
    favoritePhotos: row ? row.c_fav : 0,
    earliestDate: row ? row.min_date : undefined,
    latestDate: row ? row.max_date : undefined,
    totalFaces: faceStats.totalFaces,
    photosWithFaces: faceStats.photosWithFaces,
  };
}

function sqlFileTypeIsImageExpr() {
  return "lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
}

function sqlFileTypeIsVideoExpr() {
  return "lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
}

function folderCoverPickOrderBySql() {
  return 'CASE WHEN ' + sqlFileTypeIsImageExpr() + ' THEN 0 ELSE 1 END ASC, file_name ASC, id ASC';
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetFolderTree(db, rootId) {
  return db
    .prepare(
      `
      SELECT folder_path, COUNT(id) as photo_count,
        MIN(date_taken) as earliest_date, MAX(date_taken) as latest_date
      FROM photos WHERE root_id = ?
      GROUP BY folder_path
      ORDER BY folder_path
    `,
    )
    .all(rootId);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetFolderCovers(db, options) {
  const opts = options || {};
  const { rootId, mediaType } = opts;
  const conditions = [];
  const params = [];

  var media = String(mediaType || '').toLowerCase();
  if (rootId) {
    conditions.push('root_id = ?');
    params.push(rootId);
  }
  if (media === 'image') {
    conditions.push(sqlFileTypeIsImageExpr());
  } else if (media === 'video') {
    conditions.push(sqlFileTypeIsVideoExpr());
  }

  const whereClause = 'WHERE 1=1' + (conditions.length ? ' AND ' + conditions.join(' AND ') : '');

  var hasPaging =
    Object.prototype.hasOwnProperty.call(opts, 'page') ||
    Object.prototype.hasOwnProperty.call(opts, 'pageSize');

  var coverOrderSql = folderCoverPickOrderBySql();

  if (!hasPaging) {
    const legacySql = `
        WITH filtered AS (
          SELECT id, file_name, folder_path, has_thumbnail, file_type
          FROM photos
          ${whereClause}
        ),
        ranked AS (
          SELECT
            id,
            file_name,
            folder_path,
            has_thumbnail,
            ROW_NUMBER() OVER (
              PARTITION BY folder_path
              ORDER BY ${coverOrderSql}
            ) AS rn,
            COUNT(*) OVER (PARTITION BY folder_path) AS folder_photo_count
          FROM filtered
        )
        SELECT id, file_name, folder_path, has_thumbnail, folder_photo_count
        FROM ranked
        WHERE rn = 1
        ORDER BY folder_path ASC
      `;
    const rows = db.prepare(legacySql).all(...params);
    return {
      covers: rows,
      total: rows.length,
      page: 1,
      pageSize: rows.length,
      totalPages: 1,
    };
  }

  var page = Math.max(1, parseInt(opts.page, 10) || 1);
  var pageSizeRaw = parseInt(opts.pageSize, 10);
  var pageSize = pageSizeRaw > 0 ? Math.min(pageSizeRaw, 500) : 100;
  var offset = (page - 1) * pageSize;

  var countRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
          SELECT folder_path FROM photos ${whereClause} GROUP BY folder_path
        )`,
    )
    .get(...params);
  var totalFolders = countRow && countRow.c != null ? Number(countRow.c) : 0;
  var totalPages = totalFolders <= 0 ? 1 : Math.ceil(totalFolders / pageSize);
  if (page > totalPages) {
    page = totalPages;
    offset = (page - 1) * pageSize;
  }

  var pathRows = db
    .prepare(
      `SELECT folder_path FROM photos ${whereClause} GROUP BY folder_path ORDER BY folder_path ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset);

  if (!pathRows.length) {
    return {
      covers: [],
      total: totalFolders,
      page: page,
      pageSize: pageSize,
      totalPages: totalPages,
    };
  }

  var paths = pathRows.map(function (r) {
    return r.folder_path;
  });
  var ph = paths.map(function () {
    return '?';
  });
  var inParams = params.slice().concat(paths);
  var inWhere = whereClause + ' AND folder_path IN (' + ph.join(',') + ')';

  var sql = `
      WITH filtered AS (
        SELECT id, file_name, folder_path, has_thumbnail, file_type
        FROM photos
        ${inWhere}
      ),
      ranked AS (
        SELECT
          id,
          file_name,
          folder_path,
          has_thumbnail,
          ROW_NUMBER() OVER (
            PARTITION BY folder_path
            ORDER BY ${coverOrderSql}
          ) AS rn,
          COUNT(*) OVER (PARTITION BY folder_path) AS folder_photo_count
        FROM filtered
      )
      SELECT id, file_name, folder_path, has_thumbnail, folder_photo_count
      FROM ranked
      WHERE rn = 1
      ORDER BY folder_path ASC
    `;
  var covers = db.prepare(sql).all(...inParams);
  return {
    covers: covers,
    total: totalFolders,
    page: page,
    pageSize: pageSize,
    totalPages: totalPages,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ rootId?: number, sortOrder?: string }} [options]
 */
function runGetDateGroups(db, options) {
  options = options || {};
  var rootId = options.rootId;
  var dir = String(options.sortOrder || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  var whereClause = 'WHERE date_taken IS NOT NULL';
  var params = [];
  if (rootId) {
    whereClause += ' AND root_id = ?';
    params.push(rootId);
  }
  return db
    .prepare(
      'SELECT date(date_taken) as date, COUNT(*) as count FROM photos ' +
        whereClause +
        ' GROUP BY date(date_taken) ORDER BY date ' +
        dir,
    )
    .all(...params);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} dateStr
 * @param {{ sortBy?: string, sortOrder?: string, page?: number, pageSize?: number, favoritesOnly?: boolean, mediaType?: string, lite?: boolean }} [options]
 */
function runGetDatePhotos(db, dateStr, options) {
  options = options || {};
  var sortBy = options.sortBy || 'file_name';
  var sortOrder = options.sortOrder || 'ASC';
  var page = Math.max(1, parseInt(options.page, 10) || 1);
  var pageSize = Math.max(1, Math.min(parseInt(options.pageSize, 10) || 100, 500));
  var favoritesOnly = options.favoritesOnly;
  var mediaType = options.mediaType;
  var lite = options.lite === true;
  var offset = (page - 1) * pageSize;
  var dir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  var allowedSort = ['date_taken', 'date_modified', 'file_name', 'file_size', 'folder_path'];
  var order = allowedSort.indexOf(sortBy) >= 0 ? sortBy : 'file_name';
  var mediaSql = '';
  if (String(mediaType || '').toLowerCase() === 'image') {
    mediaSql =
      " AND lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  } else if (String(mediaType || '').toLowerCase() === 'video') {
    mediaSql =
      " AND lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
  }
  var whereSql = favoritesOnly
    ? 'date(date_taken) = ? AND is_favorite = 1' + mediaSql
    : 'date(date_taken) = ?' + mediaSql;
  var total = db.prepare('SELECT COUNT(*) as count FROM photos WHERE ' + whereSql).get(dateStr);
  var photoCols = lite
    ? 'id, file_name, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite'
    : 'id, file_name, file_path, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite';
  var photos = db
    .prepare(
      'SELECT ' +
        photoCols +
        ' FROM photos WHERE ' +
        whereSql +
        ' ORDER BY ' +
        order +
        ' ' +
        dir +
        ' LIMIT ? OFFSET ?',
    )
    .all(dateStr, pageSize, offset);
  return {
    photos: photos,
    total: total ? total.count : 0,
    page: page,
    pageSize: pageSize,
    totalPages: Math.ceil((total ? total.count : 0) / pageSize),
  };
}

/** 与 database 重复比对一致：非视频扩展视为图片侧 */
function sqlDupImageTypeExpr() {
  return "lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
}

function sqlNeedsFileHashExpr() {
  return "(file_hash IS NULL OR TRIM(file_hash) = '')";
}

function sqlHasFileHashExpr() {
  return "file_hash IS NOT NULL AND TRIM(file_hash) != ''";
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetHashAllPhotoCount(db) {
  var row = db
    .prepare(
      'SELECT COUNT(*) AS c FROM photos WHERE ' +
        sqlDupImageTypeExpr() +
        ' AND ' +
        sqlNeedsFileHashExpr(),
    )
    .get();
  return row && row.c != null ? Number(row.c) : 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetDuplicateGroupCountByHash(db, minCount) {
  var mc = Math.max(2, parseInt(minCount, 10) || 2);
  var row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT file_hash FROM photos
         WHERE ${sqlHasFileHashExpr()}
           AND ${sqlDupImageTypeExpr()}
         GROUP BY file_hash
         HAVING COUNT(*) >= ?
       )`,
    )
    .get(mc);
  return row && row.c != null ? Number(row.c) : 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetDuplicatePhotoCountByHash(db, minCount) {
  var mc = Math.max(2, parseInt(minCount, 10) || 2);
  var row = db
    .prepare(
      `SELECT COALESCE(SUM(cnt), 0) AS c FROM (
         SELECT COUNT(*) AS cnt FROM photos
         WHERE ${sqlHasFileHashExpr()}
           AND ${sqlDupImageTypeExpr()}
         GROUP BY file_hash
         HAVING COUNT(*) >= ?
       )`,
    )
    .get(mc);
  return row && row.c != null ? Number(row.c) : 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function runGetDuplicateGroupsByHash(db, limit, offset, minCount) {
  var lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  var off = Math.max(0, parseInt(offset, 10) || 0);
  var mc = Math.max(2, parseInt(minCount, 10) || 2);
  return db
    .prepare(
      `SELECT file_hash,
              COUNT(*) AS duplicate_count,
              SUM(file_size) AS total_size
       FROM photos
       WHERE ${sqlHasFileHashExpr()}
         AND ${sqlDupImageTypeExpr()}
       GROUP BY file_hash
       HAVING COUNT(*) >= ?
       ORDER BY duplicate_count DESC, file_hash ASC
       LIMIT ? OFFSET ?`,
    )
    .all(mc, lim, off);
}

/**
 * 重复项侧栏一页：单次 Worker 往返，避免主进程 GROUP BY 卡死。
 * @param {import('better-sqlite3').Database} db
 * @param {{ page?: number, pageSize?: number, minCount?: number }} options
 */
function runGetDuplicateHashGroupsBundle(db, options) {
  options = options || {};
  var pageSize = Math.max(1, Math.min(500, parseInt(options.pageSize, 10) || 100));
  var page = Math.max(1, parseInt(options.page, 10) || 1);
  var minCount = Math.max(2, parseInt(options.minCount, 10) || 2);
  var total = runGetDuplicateGroupCountByHash(db, minCount);
  var groups = runGetDuplicateGroupsByHash(db, pageSize, (page - 1) * pageSize, minCount);
  var totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    groups: groups,
    total: total,
    page: page,
    pageSize: pageSize,
    totalPages: totalPages,
  };
}

module.exports = {
  rootFolderStatsCacheMediaKey: rootFolderStatsCacheMediaKey,
  tryReadRootFolderStatsCache: tryReadRootFolderStatsCache,
  runAggregateStatsForSingleRoot: runAggregateStatsForSingleRoot,
  runGetRootFoldersAgg: runGetRootFoldersAgg,
  runGetRootFoldersLite: runGetRootFoldersLite,
  runGetStatsAgg: runGetStatsAgg,
  runGetFolderTree: runGetFolderTree,
  runGetFolderCovers: runGetFolderCovers,
  runGetDateGroups: runGetDateGroups,
  runGetDatePhotos: runGetDatePhotos,
  runGetHashAllPhotoCount: runGetHashAllPhotoCount,
  runGetDuplicateGroupCountByHash: runGetDuplicateGroupCountByHash,
  runGetDuplicatePhotoCountByHash: runGetDuplicatePhotoCountByHash,
  runGetDuplicateGroupsByHash: runGetDuplicateGroupsByHash,
  runGetDuplicateHashGroupsBundle: runGetDuplicateHashGroupsBundle,
};
