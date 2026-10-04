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
 * `runGetStatsAgg` 用的那条语句。单独抽出来是为了让回归能对它跑 `EXPLAIN QUERY PLAN` ——
 * 这条查询的性能全靠「每个指标各自走一条覆盖索引」，塌回成一条 `SELECT COUNT(*), SUM(...) FROM photos`
 * 不会算错数、只会悄悄从 0.9 秒变成 5.8 秒，光靠比对结果值抓不住。
 */
function statsAggSql() {
  const videoIn =
    "'mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2'";
  const fileTypeNorm = "lower(replace(file_type, '.', ''))";
  return `SELECT
           (SELECT COUNT(*) FROM photos) AS c_total,
           (SELECT COALESCE(SUM(file_size), 0) FROM photos) AS sum_size,
           (SELECT COUNT(DISTINCT folder_path) FROM photos) AS c_distinct_folders,
           (SELECT COUNT(*) FROM photos WHERE ${fileTypeNorm} IN (${videoIn})) AS c_video,
           (SELECT COALESCE(SUM(file_size), 0) FROM photos WHERE ${fileTypeNorm} IN (${videoIn})) AS sum_video_size,
           (SELECT COUNT(*) FROM photos WHERE is_favorite = 1) AS c_fav,
           (SELECT MIN(date_taken) FROM photos) AS min_date,
           (SELECT MAX(date_taken) FROM photos) AS max_date`;
}

/**
 * 顶栏 / 侧栏的全库统计。
 *
 * ⚠️ 必须写成**每个指标一条子查询**，不能合成一趟 `SELECT COUNT(*), SUM(...), COUNT(DISTINCT ...) FROM photos`。
 * 一趟写法的 SELECT 列表同时要 file_size / file_type / is_favorite / date_taken / folder_path 五列，
 * 没有任何一个索引能同时覆盖它们，SQLite 只能 `SCAN photos`——而 `photos` 的 `thumbnail` BLOB 内联在行中间
 * （见 `database.js` 的 createCoreSchema），整表扫描等于把十几 GB 的缩略图溢出页读一遍。
 *
 * 拆开之后每条都能吃到一条已有的覆盖索引（真库 1,224,615 行 / 12.97 GB 实测）：
 *
 * | 指标 | 执行计划 | 耗时 |
 * | --- | --- | ---: |
 * | `COUNT(*)` | COVERING INDEX idx_photos_hasThumb | 0.5 ms |
 * | `SUM(file_size)` | COVERING INDEX idx_photos_size | 80.7 ms |
 * | `COUNT(DISTINCT folder_path)` | COVERING INDEX idx_photos_folder | 188.3 ms |
 * | 视频张数 | COVERING INDEX idx_photos_type | 353.1 ms |
 * | 视频体积 | INDEX idx_photos_agg_root_folder_video（只回表 25,585 行视频） | 116.3 ms |
 * | 收藏张数 | COVERING INDEX idx_photos_favorite | 0.0 ms |
 * | `MIN/MAX(date_taken)` | COVERING INDEX idx_photos_date | 0.0 ms |
 *
 * 同一份结果：一趟 **5803 ms** → 拆开 **888 ms**（6.5×），且**不需要新增任何索引**。
 *
 * 唯一会退化的情形是「视频占比很高」的库：`SUM(file_size) WHERE 视频` 需要 file_type 与 file_size 两列，
 * 现有索引都不覆盖；本机库只有 25,585 张视频（2%）所以 116 ms 就够了。真遇到视频为主的库，
 * 再补一个表达式索引 `(lower(replace(file_type,'.','')), file_size)`（约 20 MB / 122 万行）即可把这条也变成
 * 纯索引扫描——合成库上实测整条统计从 157 ms 降到 27.7 ms。**当前刻意不加**，避免为少数库付索引写入成本。
 *
 * @param {import('better-sqlite3').Database} db
 */
function runGetStatsAgg(db) {
  const row = db.prepare(statsAggSql()).get();

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
 * Web 端目录浏览「直接子目录」封面：单次查询替代 N+1。
 * 先根据 parentPath 找到 rootId，再 LIKE 找出所有直接子目录，最后窗口函数批量取封面。
 * @param {import('better-sqlite3').Database} db
 * @param {{ parentPath?: string, mediaType?: string }} [options]
 */
function runGetImmediateSubfolderCovers(db, options) {
  options = options || {};
  var normalized = String(options.parentPath || '').trim().replace(/\\/g, '/');
  var parentPath = normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
  if (!parentPath) return [];
  // Match descendants by literal path prefix, including parents with no direct photos.
  var prefix = parentPath.endsWith('/') ? parentPath : parentPath + '/';
  var escaped = prefix.replace(/[\\%_]/g, '\\$&') + '%';
  var windowsPrefix = prefix.replace(/\//g, '\\');
  var windowsEscaped = windowsPrefix.replace(/[\\%_]/g, '\\$&') + '%';
  var conditions = ["(folder_path LIKE ? ESCAPE '\\' OR folder_path LIKE ? ESCAPE '\\')"];
  var media = String(options.mediaType || '').toLowerCase();
  if (media === 'image') conditions.push(sqlFileTypeIsImageExpr());
  if (media === 'video') conditions.push(sqlFileTypeIsVideoExpr());
  var sql = `
    WITH descendants AS (
      SELECT id, file_name, file_type, has_thumbnail,
             substr(replace(folder_path, '\\', '/'), ?) AS relative_path
      FROM photos WHERE ${conditions.join(' AND ')}
    ), children AS (
      SELECT *, ? || CASE WHEN instr(relative_path, '/') > 0
        THEN substr(relative_path, 1, instr(relative_path, '/') - 1)
        ELSE relative_path END AS child_path
      FROM descendants WHERE relative_path != ''
    ), ranked AS (
      SELECT *, COUNT(*) OVER (PARTITION BY child_path) AS folder_photo_count,
        ROW_NUMBER() OVER (PARTITION BY child_path ORDER BY ${folderCoverPickOrderBySql()}) AS rn
      FROM children
    )
    SELECT child_path AS folder_path, folder_photo_count, id, has_thumbnail, file_name
    FROM ranked WHERE rn = 1 ORDER BY child_path ASC
  `;
  return db.prepare(sql).all(Array.from(prefix).length + 1, escaped, windowsEscaped, prefix);
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

/** Return the next calendar day for an ISO date, independent of the host timezone. */
function nextCalendarDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) throw new Error('Invalid date');
  var day = new Date(dateStr + 'T00:00:00.000Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== dateStr) {
    throw new Error('Invalid date');
  }
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

/** Query a calendar day using an indexed half-open range. */
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
  // 范围查询替代 date(date_taken) = ?，让 idx_photos_date 索引生效（1.7s → 38ms）
  var nextDate = nextCalendarDate(dateStr);
  var rangeWhere = favoritesOnly
    ? 'date_taken >= ? AND date_taken < ? AND is_favorite = 1' + mediaSql
    : 'date_taken >= ? AND date_taken < ?' + mediaSql;
  var total = db.prepare('SELECT COUNT(*) as count FROM photos WHERE ' + rangeWhere).get(dateStr, nextDate);
  var photoCols = lite
    ? 'id, file_name, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite'
    : 'id, file_name, file_path, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite';
  var photos = db
    .prepare(
      'SELECT ' +
        photoCols +
        ' FROM photos WHERE ' +
        rangeWhere +
        ' ORDER BY ' +
        order +
        ' ' +
        dir +
        ' LIMIT ? OFFSET ?',
    )
    .all(dateStr, nextDate, pageSize, offset);
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
  nextCalendarDate: nextCalendarDate,
  rootFolderStatsCacheMediaKey: rootFolderStatsCacheMediaKey,
  tryReadRootFolderStatsCache: tryReadRootFolderStatsCache,
  runAggregateStatsForSingleRoot: runAggregateStatsForSingleRoot,
  runGetRootFoldersAgg: runGetRootFoldersAgg,
  runGetRootFoldersLite: runGetRootFoldersLite,
  runGetStatsAgg: runGetStatsAgg,
  statsAggSql: statsAggSql,
  runGetFolderTree: runGetFolderTree,
  runGetFolderCovers: runGetFolderCovers,
  runGetImmediateSubfolderCovers: runGetImmediateSubfolderCovers,
  runGetDateGroups: runGetDateGroups,
  runGetDatePhotos: runGetDatePhotos,
  runGetHashAllPhotoCount: runGetHashAllPhotoCount,
  runGetDuplicateGroupCountByHash: runGetDuplicateGroupCountByHash,
  runGetDuplicatePhotoCountByHash: runGetDuplicatePhotoCountByHash,
  runGetDuplicateGroupsByHash: runGetDuplicateGroupsByHash,
  runGetDuplicateHashGroupsBundle: runGetDuplicateHashGroupsBundle,
};
