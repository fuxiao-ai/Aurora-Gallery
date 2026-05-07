const logger = require('./main/logger');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
    /** 根目录聚合计数缓存表（root_folder_stats_cache） */
    this._rootStatsCacheSchemaDone = false;
    /** 聚合/重复比对辅助索引：首屏后再建，避免大库启动阶段长时间阻塞主线程 */
    this._deferredPhotoIndexesApplied = false;
    /** Intl.Collator 首次排序再创建 */
    this.fileNameNaturalCollator = null;
    this.init();
  }

  applyDeferredCachePragma() {
    if (this._deferredCacheApplied) return;
    this._deferredCacheApplied = true;
    try {
      this.db.pragma('cache_size = -131072'); // 128MB
    } catch (e) {
      void e;
    }
  }

  applyDeferredMmapPragma() {
    if (this._deferredMmapApplied) return;
    this._deferredMmapApplied = true;
    try {
      this.db.pragma('mmap_size = 1073741824'); // 1GB
    } catch (e) {
      void e;
    }
  }

  /** 一次应用缓存 + mmap（兼容旧调用） */
  applyDeferredIoPragmas() {
    this.applyDeferredCachePragma();
    this.applyDeferredMmapPragma();
  }

  /**
   * 侧栏目录树首屏就绪（notify-browse-ui-ready）后由 main 调度；12s 兜底仍可能触发。
   * 部分索引与大表扫描式 CREATE INDEX 迁出 init，减轻启动卡顿。幂等；索引未就绪前查询仍正确，仅可能略慢。
   */
  applyDeferredPhotoIndexes() {
    if (this._deferredPhotoIndexesApplied) return;
    this._deferredPhotoIndexesApplied = true;
    try {
      this.ensurePhotosRootFolderCompositeIndex();
      this.ensurePhotosAggPartialIndexes();
      this.ensurePhotosDupHashPendingIndex();
    } catch (e) {
      this._deferredPhotoIndexesApplied = false;
      throw e;
    }
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

  _pushMediaTypeCondition(conditions, mediaType) {
    var m = String(mediaType || 'all').toLowerCase();
    if (m === 'image') {
      conditions.push(this._sqlFileTypeIsImageExpr());
    } else if (m === 'video') {
      conditions.push(this._sqlFileTypeIsVideoExpr());
    }
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
        is_favorite INTEGER DEFAULT 0,
        FOREIGN KEY (root_id) REFERENCES root_folders(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_path);
      CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(date_taken);
      CREATE INDEX IF NOT EXISTS idx_photos_date_mod ON photos(date_modified);
      CREATE INDEX IF NOT EXISTS idx_photos_root ON photos(root_id);
      CREATE INDEX IF NOT EXISTS idx_photos_root_date_mod ON photos(root_id, date_modified);
      CREATE INDEX IF NOT EXISTS idx_photos_root_folder ON photos(root_id, folder_path);
      CREATE INDEX IF NOT EXISTS idx_photos_name ON photos(file_name);
      CREATE INDEX IF NOT EXISTS idx_photos_type ON photos(file_type);
      CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(is_favorite);
      CREATE INDEX IF NOT EXISTS idx_photos_hasThumb ON photos(has_thumbnail);
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
    this.createCoreSchema();
    this.ensureCoreSchemaReady();
    this.ensurePhotosIsFavoriteColumn();
    this.ensureRootFolderStatsCacheSchema();
    this.ensurePhotosThumbnailMissingIndex();
    // 孤立行清理见 deleteOrphanPhotosWithoutRoot，由 main 在首窗后异步写入
  }

  /**
   * 旧库可能缺 idx_photos_root_folder；根目录聚合 DISTINCT(folder_path) 依赖 (root_id, folder_path) 复合索引。
   */
  ensurePhotosRootFolderCompositeIndex() {
    if (!this.hasTable('photos')) return;
    try {
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_photos_root_folder ON photos(root_id, folder_path);',
      );
    } catch (e) {
      void e;
    }
  }

  /**
   * 与 db-heavy-read.runGetRootFoldersAgg 中 file_type 判定一致的部分索引：
   * 「仅图片 / 仅视频」下的 get-root-folders 可走更小 B-Tree，常比全表聚合快一个数量级。
   * （mediaType=all 仍须覆盖整表，索引无法消除 O(N)）
   */
  ensurePhotosAggPartialIndexes() {
    if (!this.hasTable('photos')) return;
    try {
      var imgPred = this._sqlFileTypeIsImageExpr();
      var vidPred = this._sqlFileTypeIsVideoExpr();
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_image ON photos(root_id, folder_path) WHERE ' +
          imgPred +
          ';\n' +
          'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_video ON photos(root_id, folder_path) WHERE ' +
          vidPred +
          ';',
      );
    } catch (e) {
      void e;
    }
  }

  /**
   * 重复比对「待处理张数」COUNT 与分批 getHashAllPhotosAfter：缩小扫描范围。
   */
  ensurePhotosDupHashPendingIndex() {
    if (!this.hasTable('photos')) return;
    this.ensureDuplicateHashSchema();
    try {
      var pending = '(' + this._sqlNeedsFileHashExpr() + ')';
      var img = '(' + this._sqlFileTypeIsImageExpr() + ')';
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_photos_dup_hash_pending ON photos(id) WHERE ' +
          pending +
          ' AND ' +
          img +
          ';',
      );
    } catch (e) {
      void e;
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

  /**
   * 缩略图补全查询加速：复合索引 (id, has_thumbnail) 让 `WHERE id > ? AND has_thumbnail = 0` 查询
   * 不需要全表扫描，可以直接利用索引顺序快速定位。解决大库启动补全查询卡死一分钟以上问题。
   */
  ensurePhotosThumbnailMissingIndex() {
    if (!this.hasTable('photos')) return;
    try {
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_photos_id_hasThumb ON photos(id, has_thumbnail);',
      );
      logger.log('[db migration] created idx_photos_id_hasThumb index for thumbnail backfill');
    } catch (e) {
      logger.error(
        '[db migration] create thumbnail missing index failed:',
        e && e.message ? e.message : e,
      );
      void e;
    }
  }

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
   */
  refreshRootFolderStatsCacheForRoot(rootId) {
    if (rootId == null) return;
    var rid = parseInt(rootId, 10);
    if (!isFinite(rid) || rid <= 0) return;
    this.ensureRootFolderStatsCacheSchema();
    var heavy = require('./db-heavy-read');
    if (typeof heavy.runAggregateStatsForSingleRoot !== 'function') return;
    var exists = this.db.prepare('SELECT 1 AS x FROM root_folders WHERE id = ? LIMIT 1').get(rid);
    if (!exists) return;
    var self = this;
    var insert = this.db.prepare(
      `INSERT OR REPLACE INTO root_folder_stats_cache (root_id, media_key, photo_count, folder_count, video_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    var variants = [
      { key: 'all', opts: {} },
      { key: 'image', opts: { mediaType: 'image' } },
      { key: 'video', opts: { mediaType: 'video' } },
    ];
    var tx = this.db.transaction(function () {
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        var stats = heavy.runAggregateStatsForSingleRoot(self.db, rid, v.opts);
        if (!stats) continue;
        insert.run(rid, v.key, stats.photo_count, stats.folder_count, stats.video_count);
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
   * 删除 root_id 已不存在的照片行（历史脏数据）。大库时略耗时，宜在窗口出现后调用。
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
    this._duplicateHashSchemaDone = true;
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
   * 按 id 升序分批拉取「仍无哈希」的图片行（供主进程 runDuplicateHashDetection）
   */
  getHashAllPhotosAfter(afterId, batchSize) {
    this.ensureDuplicateHashSchema();
    var aid = Math.max(0, parseInt(afterId, 10) || 0);
    var lim = Math.max(1, Math.min(parseInt(batchSize, 10) || 2000, 5000));
    return this.db
      .prepare(
        `SELECT id, file_path, file_name, file_size, date_modified,
                file_hash, hash_mtime, hash_size
         FROM photos
         WHERE id > ? AND ` +
          this._sqlFileTypeIsImageExpr() +
          ' AND ' +
          this._sqlNeedsFileHashExpr() +
          `
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(aid, lim);
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

  /** 所有「重复组」内的照片总数（每组内多张都计入） */
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
        `SELECT id, file_name, file_path, folder_path, file_size, date_modified, has_thumbnail, file_type
         FROM photos
         WHERE file_hash = ?
         ORDER BY id ASC`,
      )
      .all(h);
  }

  addRootFolder(folderPath) {
    const name = path.basename(folderPath);
    const stmt = this.db.prepare('INSERT OR IGNORE INTO root_folders (path, name) VALUES (?, ?)');
    const result = stmt.run(folderPath, name);
    // INSERT OR IGNORE 不插入时 lastInsertRowid 为 0，需要重新查询
    if (result.lastInsertRowid) {
      return result.lastInsertRowid;
    }
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

    const allowedSort = ['date_taken', 'date_modified', 'file_name', 'file_size', 'folder_path'];
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

    const whereClause = 'WHERE 1=1' + (conditions.length ? ' AND ' + conditions.join(' AND ') : '');

    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos ${whereClause}`)
      .get(...params);
    const photoCols = lite
      ? `id, file_name, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`
      : `id, file_name, file_path, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`;
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
      total: Number(total.count),
      page: Number(page),
      pageSize: Number(pageSize),
      totalPages: Math.ceil(Number(total.count) / Number(pageSize)),
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
          where.push('(folder_path = ? OR folder_path LIKE ?)');
          params.push(normalizedPath, normalizedPath + '\\%');
        } else {
          where.push('folder_path = ?');
          params.push(normalizedPath);
        }
      }
    } else if (view === 'date') {
      var d = options.date ? String(options.date) : '';
      if (d) {
        where.push('date(date_taken) = ?');
        params.push(d);
      }
    } else if (view === 'search') {
      var q = options.q ? String(options.q) : '';
      if (q) {
        var term = '%' + q + '%';
        where.push('(file_name LIKE ? OR folder_path LIKE ?)');
        params.push(term, term);
      }
    } else if (view === 'favorites') {
      where.push('is_favorite = 1');
    }

    if (media === 'image') {
      where.push(
        "lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')",
      );
    } else if (media === 'video') {
      where.push(
        "lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')",
      );
    }

    return {
      whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '',
      params: params,
    };
  }

  /**
   * 随机幻灯批次：在预览作用域内一次取最多 limit 张（默认 100），供前端打乱后顺序播放。
   * 使用 ORDER BY RANDOM() 仅每批一次，而非每张换片一次。
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
    var cols =
      'id, file_name, file_path, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite';
    var sql = 'SELECT ' + cols + ' FROM photos ' + cond + ' ORDER BY RANDOM() LIMIT ?';
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
        SELECT id, file_name, file_path, folder_path, file_size, file_type,
               width, height, date_taken, date_modified, has_thumbnail, is_favorite
        FROM photos
        ${randWhereSql} (${scoreExpr} > ?)
        ORDER BY ${scoreExpr} ASC, id ASC
        LIMIT 1
      `;
      var randRow = this.db.prepare(randSql1).get(...params, currentScore);
      if (!randRow) {
        var randSql2 = `
          SELECT id, file_name, file_path, folder_path, file_size, file_type,
                 width, height, date_taken, date_modified, has_thumbnail, is_favorite
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
        SELECT id, file_name, file_path, folder_path, file_size, file_type,
               width, height, date_taken, date_modified, has_thumbnail, is_favorite
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
      SELECT id, file_name, file_path, folder_path, file_size, file_type,
             width, height, date_taken, date_modified, has_thumbnail, is_favorite
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
      SELECT id, file_name, file_path, folder_path, file_size, file_type,
             width, height, date_taken, date_modified, has_thumbnail, is_favorite
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
    const allowedSort = ['date_taken', 'date_modified', 'file_name', 'file_size'];
    const order = allowedSort.includes(sortBy) ? sortBy : 'file_name';

    // 标准化路径：统一使用反斜杠（Windows）
    const normalizedPath = folderPath.replace(/\//g, '\\');
    const incDesc = includeSubfolders !== false;
    const pathBindArgs = incDesc ? [normalizedPath, normalizedPath + '\\%'] : [normalizedPath];

    const mediaConds = [];
    this._pushMediaTypeCondition(mediaConds, mediaType);
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds[0] : '';

    const baseWhereSql = incDesc ? '(folder_path = ? OR folder_path LIKE ?)' : 'folder_path = ?';
    const whereSql = favoritesOnly
      ? `${baseWhereSql} AND is_favorite = 1${mediaSql}`
      : `${baseWhereSql}${mediaSql}`;
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
      .get(...pathBindArgs);
    const video = this.db
      .prepare(
        `SELECT COUNT(*) as count
         FROM photos
         WHERE ${whereSql}
           AND lower(replace(file_type, '.', '')) IN
             ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')`,
      )
      .get(...pathBindArgs);
    const photoCols = lite
      ? `id, file_name, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`
      : `id, file_name, file_path, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`;
    const photos = this.db
      .prepare(
        `SELECT ${photoCols}
       FROM photos WHERE ${whereSql}
       ORDER BY ${order} ${dir}
       LIMIT ? OFFSET ?`,
      )
      .all(...pathBindArgs, pageSize, offset);
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
    const {
      sortBy = 'file_name',
      sortOrder = 'ASC',
      page = 1,
      pageSize = 100,
      favoritesOnly,
      mediaType,
      lite = false,
    } = options;
    const offset = (page - 1) * pageSize;
    const dir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const mediaConds = [];
    this._pushMediaTypeCondition(mediaConds, mediaType);
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds[0] : '';

    const whereSql = favoritesOnly
      ? 'date(date_taken) = ? AND is_favorite = 1' + mediaSql
      : 'date(date_taken) = ?' + mediaSql;
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
      .get(dateStr);
    const photoCols = lite
      ? `id, file_name, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`
      : `id, file_name, file_path, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`;
    const photos = this.db
      .prepare(
        `
      SELECT ${photoCols}
       FROM photos WHERE ${whereSql}
       ORDER BY ${sortBy} ${dir}
       LIMIT ? OFFSET ?
    `,
      )
      .all(dateStr, pageSize, offset);
    this.applyNaturalNameTieSort(photos, sortBy, dir);

    return {
      photos,
      total: total.count,
      page,
      pageSize,
      totalPages: Math.ceil(total.count / pageSize),
    };
  }

  getThumbnail(photoId) {
    var photo = this.db
      .prepare('SELECT thumbnail, has_thumbnail FROM photos WHERE id = ?')
      .get(photoId);

    if (!photo) return null;

    if (photo.has_thumbnail && photo.thumbnail) {
      return { thumbnail: photo.thumbnail };
    }
    return null;
  }

  getMissingThumbnailCount() {
    var row = this.db
      .prepare('SELECT COUNT(*) as count FROM photos WHERE has_thumbnail = 0 OR thumbnail IS NULL')
      .get();
    return row ? row.count : 0;
  }

  getPhotosMissingThumbnails(limit = 20000) {
    return this.db
      .prepare(
        `SELECT id, file_path
       FROM photos
       WHERE has_thumbnail = 0 OR thumbnail IS NULL
       ORDER BY id ASC
       LIMIT ?`,
      )
      .all(limit);
  }

  /** 仅取 id > afterId 的缺失缩略图，避免同一轮补全对失败记录死循环重试 */
  getPhotosMissingThumbnailsAfter(afterId, limit) {
    return this.db
      .prepare(
        `SELECT id, file_path
       FROM photos
       WHERE id > ?
        AND (has_thumbnail = 0 OR thumbnail IS NULL)
       ORDER BY id ASC
       LIMIT ?`,
      )
      .all(afterId, limit);
  }

  updatePhotoThumbnail(photoId, thumbnailBuffer) {
    this.db
      .prepare('UPDATE photos SET thumbnail = ?, has_thumbnail = 1 WHERE id = ?')
      .run(thumbnailBuffer, photoId);
  }

  photoExists(photoId) {
    var row = this.db.prepare('SELECT 1 FROM photos WHERE id = ?').get(photoId);
    return !!row;
  }

  cleanupMissingFiles(options = {}) {
    var batchSize = parseInt(options && options.batchSize, 10);
    var hasBatchLimit = isFinite(batchSize) && batchSize > 0;
    var afterId = parseInt(options && options.afterId, 10);
    var hasAfterId = isFinite(afterId) && afterId > 0;
    var rows;
    if (hasBatchLimit) {
      if (hasAfterId) {
        // 按主键游标分批扫描，避免重复检查同一批记录
        rows = this.db
          .prepare('SELECT id, file_path FROM photos WHERE id > ? ORDER BY id ASC LIMIT ?')
          .all(afterId, batchSize);
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
   */
  cleanupMissingFilesYielding(options = {}) {
    var self = this;
    var batchSize = parseInt(options && options.batchSize, 10);
    var hasBatchLimit = isFinite(batchSize) && batchSize > 0;
    if (!hasBatchLimit) {
      return Promise.reject(new Error('cleanupMissingFilesYielding requires positive batchSize'));
    }
    var afterId = parseInt(options && options.afterId, 10);
    var hasAfterId = isFinite(afterId) && afterId > 0;
    var sliceSize = parseInt(options && options.existsSyncSlice, 10);
    if (!isFinite(sliceSize) || sliceSize < 8) sliceSize = 72;

    return new Promise(function (resolve, reject) {
      var rows;
      try {
        if (hasAfterId) {
          rows = self.db
            .prepare('SELECT id, file_path FROM photos WHERE id > ? ORDER BY id ASC LIMIT ?')
            .all(afterId, batchSize);
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
          lastId: hasAfterId ? afterId : 0,
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

  /**
   * 兼容主进程旧调用名：
   * 启动时清理磁盘已不存在的记录，并返回统一字段。
   */
  markMissingFilesAsNotExists(options = {}) {
    var r = this.cleanupMissingFiles(options);
    return {
      checked: Number(r && r.checked) || 0,
      markedMissing: Number(r && r.deleted) || 0,
    };
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
      'SELECT id, file_name, has_thumbnail FROM photos ' +
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
      out.push({
        folder_path: child,
        folder_photo_count: countRow ? Number(countRow.c) || 0 : 0,
        id: cover ? cover.id : null,
        has_thumbnail: cover ? !!cover.has_thumbnail : false,
        file_name: cover && cover.file_name != null ? cover.file_name : '',
      });
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

  searchPhotos(query, options = {}) {
    const { page = 1, pageSize = 100, favoritesOnly, mediaType, lite = false } = options;
    const offset = (page - 1) * pageSize;
    const searchTerm = `%${query}%`;

    const mediaConds = [];
    this._pushMediaTypeCondition(mediaConds, mediaType);
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds[0] : '';

    const namePathOr = '(file_name LIKE ? OR folder_path LIKE ?)';
    const whereSql = favoritesOnly
      ? `${namePathOr} AND is_favorite = 1${mediaSql}`
      : `${namePathOr}${mediaSql}`;
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
      .get(searchTerm, searchTerm);
    const photoCols = lite
      ? `id, file_name, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`
      : `id, file_name, file_path, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`;
    const photos = this.db
      .prepare(
        `SELECT ${photoCols}
       FROM photos WHERE ${whereSql}
       ORDER BY date_taken DESC
       LIMIT ? OFFSET ?`,
      )
      .all(searchTerm, searchTerm, pageSize, offset);

    return {
      photos,
      total: total.count,
      page,
      pageSize,
      totalPages: Math.ceil(total.count / pageSize),
    };
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

  beginTransaction() {
    this.db.exec('BEGIN TRANSACTION');
  }

  commit() {
    this.db.exec('COMMIT');
  }

  rollback() {
    this.db.exec('ROLLBACK');
  }

  insertPhoto(photo) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO photos
        (root_id, folder_path, file_name, file_path, file_size, file_type,
         width, height, date_taken, date_modified, thumbnail, has_thumbnail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
  }

  getInsertStmt() {
    return this.db.prepare(`
      INSERT OR IGNORE INTO photos
        (root_id, folder_path, file_name, file_path, file_size, file_type,
         width, height, date_taken, date_modified, thumbnail, has_thumbnail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
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

  // 兼容扫描器：扫描完成后删除该根目录下已不存在的旧记录
  cleanupStalePhotosForRoot(rootId, scannedPathSet) {
    var rows = this.db.prepare('SELECT id, file_path FROM photos WHERE root_id = ?').all(rootId);
    var delStmt = this.db.prepare('DELETE FROM photos WHERE id = ?');
    var deleted = 0;
    var checked = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      checked++;
      var p = row && row.file_path ? String(row.file_path) : '';
      if (!p) {
        delStmt.run(row.id);
        deleted++;
        continue;
      }
      if (scannedPathSet && scannedPathSet.size > 0) {
        if (!scannedPathSet.has(p)) {
          delStmt.run(row.id);
          deleted++;
        }
      } else if (!fs.existsSync(p)) {
        delStmt.run(row.id);
        deleted++;
      }
    }
    return { checked: checked, deleted: deleted, markedMissing: deleted };
  }

  async backupToFile(destPath) {
    await this.db.backup(destPath);
  }

  close() {
    this.db.close();
  }
}

module.exports = PhotoDatabase;
