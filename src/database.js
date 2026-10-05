const logger = require('./main/logger');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * 缩略图编码格式白名单。
 *
 * 写入端（扫描 / 回填 / 网页端按需生成）在生成时把**实际用的编码**传进来，这里收口校验，
 * 免得一个手误的字符串变成将来迁移判断不掉的脏数据 —— 迁移的判据是
 * `thumb_format <> 'webp'`，写进去一个 `'webP'` 会让那一行**永远被认为需要重生成**。
 *
 * 🔴 加 WebP 时要同步改三处：① 本白名单加 `'webp'`；② 各生成点的编码调用改成 `.webp()`；
 *    ③ 响应头的 `Content-Type` —— `web-server.js` / `main.js` 里硬编码了 8 处 `image/jpeg`。
 */
var THUMB_FORMAT_WHITELIST = ['jpeg', 'webp'];

/** 归一化：不在白名单里的一律返回 `''`（未知），而不是原样落库。 */
function normalizeThumbFormat(value) {
  var format = value ? String(value).trim().toLowerCase() : '';
  return THUMB_FORMAT_WHITELIST.indexOf(format) >= 0 ? format : '';
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

  // ⚠️ 这里曾经有一组「延迟索引」的主线程同步版本：`applyDeferredPhotoIndexes()` 以及它调用的
  // `ensurePhotosRootFolderCompositeIndex()` / `ensurePhotosAggPartialIndexes()` /
  // `ensurePhotosDupHashPendingIndex()`。它们**一个调用点都没有**，SQL 却和真正在跑的
  // `src/workers/deferred-index-worker.js` 逐字重复 —— 同一批索引两个真相源，改一处必漏另一处。
  // 已于 2026-09-29 删除。启动期这 7 个 `CREATE INDEX` + 13 次 `ALTER TABLE` 的**唯一定义处**
  // 就是那个 worker（由 `main.js` 经 `db-write-queue` 以 `deferred-index` 名义入队）。
  // 要加索引 / 加列，改 worker；不要再在主线程加一份同步版本 —— 那等于在启动路径上拿主进程
  // 跑几次大表 CREATE INDEX 并长时间独占写锁（`maintenance-regression` 的静态契约会拦住它）。

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
   * 「补全任务待处理」的统一谓词 —— 缩略图 / dHash / 原图尺寸三者任一缺失即命中。
   *
   * 🔴 必须与 `src/main.js#runRowsWithThumbConcurrency` 的处理逻辑**同源**：那个任务在拿到候选行后
   * 除了生成缩略图与 dHash，还会读一次 sharp metadata 并回填 `width` / `height`
   * （见 `updatePhotoDimensions`），所以「缺尺寸」也是它的职责范围。
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
    return "(has_thumbnail = 0 OR dhash IS NULL OR TRIM(dhash) = '' OR width IS NULL OR width = 0)";
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
        -- 缩略图规格：生成时的**目标档位**（最长边）与编码格式。
        -- 注意：0 / 空串 表示「本列引入之前的存量」，语义是**未知**，不是「没有缩略图」；
        -- 判断有没有缩略图一律看 has_thumbnail 列，不要看这两列。
        thumb_size INTEGER DEFAULT 0,
        thumb_format TEXT DEFAULT '',
        is_favorite INTEGER DEFAULT 0,
        camera_make TEXT,
        camera_model TEXT,
        lens_model TEXT,
        focal_length REAL,
        aperture REAL,
        iso_speed INTEGER,
        shutter_speed TEXT,
        gps_latitude REAL,
        gps_longitude REAL,
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
    // ensurePhotosIsFavoriteColumn: 首窗后延时调度，避免大库 PRAGMA/CREATE INDEX 阻塞启动
    // 孤立行清理见 deleteOrphanPhotosWithoutRoot，由 main 在首窗后异步写入
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
   * 确保 photos 表有 `thumb_size` / `thumb_format` 两列（缩略图规格）。
   *
   * 为什么要有这两列：在此之前**全库没有任何地方记录缩略图是用什么档位、什么格式生成的**，
   * 于是「换了 thumbSize 之后哪些图还是旧的」「哪些图还是 JPEG 需要转 WebP」这类问题
   * 既查不出来也没法做增量迁移，只能整表硬跑。列加上之后，这两个问题都变成一句 WHERE。
   *
   * 🔴 **刻意不回填历史行**：`0` / `''` 就是「本列引入之前的存量」。
   *    全表 `UPDATE photos SET thumb_size = 256` 会独占写锁扫完整个 12 GB 库
   *    （项目里已有这条红线），而它在迁移判断上和 `0` 是等价的——两者都需要重生成。
   *    与其花一次全表写锁换一个不改变结论的数字，不如老实留着「未知」。
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

  /** 待重生成的缩略图张数：档位不等于目标、或格式不等于目标的行。 */
  countThumbnailsNeedingRegen(targetSize, targetFormat) {
    if (!this.hasPhotosColumn('thumb_size') || !this.hasPhotosColumn('thumb_format')) return 0;
    var size = parseInt(targetSize, 10) || 0;
    var format = String(targetFormat || '');
    var row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM photos
         WHERE thumbnail IS NOT NULL
           AND (thumb_size <> ? OR thumb_format <> ?)`,
      )
      .get(size, format);
    return row ? Number(row.n) || 0 : 0;
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

  /** 获取指定 dHash 的所有照片 */
  getPhotosByDhash(dhash) {
    this.ensureDhashSchema();
    var h = dhash != null ? String(dhash) : '';
    if (!h) return [];
    return this.db
      .prepare(
        `SELECT id, file_name, file_path, folder_path, file_size, date_modified, has_thumbnail, file_type
         FROM photos
         WHERE dhash = ?
         ORDER BY id ASC`,
      )
      .all(h);
  }

  /** 存量补充：有缩略图但无 dHash 的照片数量 */
  getDhashBackfillPhotoCount() {
    this.ensureDhashSchema();
    var row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM photos WHERE has_thumbnail = 1 AND (dhash IS NULL OR TRIM(dhash) = '')",
      )
      .get();
    return row && row.c != null ? Number(row.c) : 0;
  }

  /**
   * 存量补充：按 file_path 顺序分批拉取「有缩略图但无 dHash」的照片
   * 顺序读盘优化：同文件夹文件连续，利用操作系统预读
   */
  getDhashBackfillPhotosAfter(afterId, batchSize) {
    this.ensureDhashSchema();
    var aid = Math.max(0, parseInt(afterId, 10) || 0);
    var lim = Math.max(1, Math.min(parseInt(batchSize, 10) || 2000, 5000));
    return this.db
      .prepare(
        `SELECT id, file_path, file_name, file_size, date_modified, file_type
         FROM photos
         WHERE id > ? AND has_thumbnail = 1 AND (dhash IS NULL OR TRIM(dhash) = '') AND file_path != ''
         ORDER BY file_path ASC
         LIMIT ?`,
      )
      .all(aid, lim);
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
        params.push(d, require('./db-heavy-read').nextCalendarDate(d));
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
    var cols =
      'id, file_name, file_path, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite';
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
    // GLOB 是大小写敏感的，可以走 idx_photos_folder 索引
    // LIKE 默认大小写不敏感（ASCII），与 BINARY 索引不匹配会导致全表扫描
    const pathBindArgs = incDesc ? [normalizedPath, normalizedPath + '\\*'] : [normalizedPath];

    const mediaConds = [];
    this._pushMediaTypeCondition(mediaConds, mediaType);
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds[0] : '';

    const baseWhereSql = incDesc ? '(folder_path = ? OR folder_path GLOB ?)' : 'folder_path = ?';
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
    const result = require('./db-heavy-read').runGetDatePhotos(this.db, dateStr, options);
    this.applyNaturalNameTieSort(
      result.photos,
      options.sortBy || 'file_name',
      options.sortOrder || 'ASC',
    );
    return result;
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
      .prepare('SELECT COUNT(*) as count FROM photos WHERE ' + this._sqlBackfillPendingExpr())
      .get();
    return row ? row.count : 0;
  }

  getPhotosMissingThumbnails(limit = 20000) {
    return this.db
      .prepare(
        `SELECT id, file_path, has_thumbnail
       FROM photos
       WHERE ${this._sqlBackfillPendingExpr()}
       ORDER BY id ASC
       LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * 仅取 id > afterId 的待补行（缺缩略图 / 缺 dHash / 缺原图尺寸），
   * 避免同一轮补全对失败记录死循环重试。
   *
   * ⚠️ `dhash` / `width` / `height` **必须出现在 SELECT 里**：上层靠它们判断
   *    「这次命中只是因为缺尺寸」，从而跳过 `computeDhash`（整图解码）与重复的
   *    metadata 读取 —— 少了这三列，1224 万行里每一行都会被白解码一遍。
   */
  getPhotosMissingThumbnailsAfter(afterId, limit) {
    return this.db
      .prepare(
        `SELECT id, file_path, file_size, date_modified, has_thumbnail, dhash, width, height
       FROM photos
       WHERE id > ? AND ${this._sqlBackfillPendingExpr()}
       ORDER BY id ASC
       LIMIT ?`,
      )
      .all(afterId, limit);
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

  /**
   * 预览页「照片信息」面板的数据源。字段覆盖面由 `src/web/js/photo-info-fields.js`
   * 的注册表决定 —— 面板要显示什么，这里就得先查出来，两者一起改。
   *
   * `media_kind` 直接复用本类的视频扩展名集合（`_sqlFileTypeIsVideoExpr()`），
   * 不再在 JS 侧维护第二份扩展名清单，否则「仅视频」筛出来的和面板写的不一致。
   * `root_path` 走 LEFT JOIN：照片的 root_id 理论上必定命中，但外键没开强制，
   * 兜底成 NULL 而不是把整条记录丢掉。
   */
  getPhotoInfo(photoId) {
    const photo = this.db
      .prepare(
        `SELECT p.id, p.file_path, p.file_name, p.file_size, p.file_type, p.width, p.height,
                p.folder_path, p.date_taken, p.date_modified, p.is_favorite, p.has_thumbnail,
                p.file_hash, p.dhash,
                p.camera_make, p.camera_model, p.lens_model, p.focal_length, p.aperture,
                p.iso_speed, p.shutter_speed, p.gps_latitude, p.gps_longitude,
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

  searchPhotos(query, options = {}) {
    const { page = 1, pageSize = 100, favoritesOnly, mediaType, lite = false } = options;
    const offset = (page - 1) * pageSize;

    const mediaConds = [];
    this._pushMediaTypeCondition(mediaConds, mediaType);
    const mediaSql = mediaConds.length ? ' AND ' + mediaConds[0] : '';

    const photoCols = lite
      ? `id, file_name, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`
      : `id, file_name, file_path, folder_path, file_size, file_type,
              width, height, date_taken, date_modified, has_thumbnail, is_favorite`;

    // FTS5 primary path
    if (this.isFtsIndexReady()) {
      const ftsQuery = this._buildFtsQuery(query);
      if (!ftsQuery) {
        return { photos: [], total: 0, page, pageSize, totalPages: 0 };
      }
      const ftsSub = `photos.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)`;
      const whereSql = favoritesOnly
        ? `${ftsSub} AND is_favorite = 1${mediaSql}`
        : `${ftsSub}${mediaSql}`;
      const total = this.db
        .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
        .get(ftsQuery);
      const photos = this.db
        .prepare(
          `SELECT ${photoCols}
         FROM photos WHERE ${whereSql}
         ORDER BY date_taken DESC
         LIMIT ? OFFSET ?`,
        )
        .all(ftsQuery, pageSize, offset);
      return {
        photos,
        total: total.count,
        page,
        pageSize,
        totalPages: Math.ceil(total.count / pageSize),
      };
    }

    // LIKE fallback
    const searchTerm = `%${query}%`;
    const namePathOr = '(file_name LIKE ? OR folder_path LIKE ?)';
    const whereSql = favoritesOnly
      ? `${namePathOr} AND is_favorite = 1${mediaSql}`
      : `${namePathOr}${mediaSql}`;
    const total = this.db
      .prepare(`SELECT COUNT(*) as count FROM photos WHERE ${whereSql}`)
      .get(searchTerm, searchTerm);
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

  getInsertStmt() {
    return this.db.prepare(`
      INSERT OR IGNORE INTO photos
        (root_id, folder_path, file_name, file_path, file_size, file_type,
         width, height, date_taken, date_modified, thumbnail, has_thumbnail,
         thumb_size, thumb_format,
         camera_make, camera_model, lens_model, focal_length, aperture,
         iso_speed, shutter_speed, gps_latitude, gps_longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
