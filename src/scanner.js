const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');

var IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.avif',
  '.svg',
  '.ico',
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2',
  '.raf',
  '.pef',
  '.x3f',
  '.crw',
  '.dcr',
]);

var VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.mpg',
  '.mpeg',
  '.m2ts',
  '.ts',
  '.3gp',
  '.3g2',
]);

var NORMAL_SCAN_WORKERS = 4;
var RAW_SCAN_WORKERS = 1;
/** 遍历目录时每处理若干项让出主线程，避免添加大目录时 Electron 界面卡死 */
var ENUMERATE_YIELD_EVERY = 400;
/** 扫描 Worker 内须定期 await，否则无法发送 progress 心跳（SQLite 同步迭代、stat 比对会占满线程） */
var WORKER_HEARTBEAT_YIELD_EVERY = 400;
/** 增量比对每文件 statSync，网络盘可能较慢，让出更勤 */
var PARTITION_STAT_YIELD_EVERY = 80;
/** 每个 worker 处理若干文件后让出（关闭「扫描期缩略图」时 processFile 几乎全同步） */
var PROCESS_YIELD_EVERY = 48;
/** 扫描写入分批提交，缩短 SQLite 写事务，便于主进程读库与 IPC */
var SCAN_TX_BATCH = 400;
/** 按批次导入文件，避免超大目录一次性处理过久 */
var SCAN_IMPORT_CHUNK = 500;
/** 百万级排障：仅在 --dev 时输出分阶段耗时日志 */
var SCAN_PERF_LOG = process.argv.indexOf('--dev') >= 0;

function yieldEventLoop() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

/** 与入库时 processFile 一致，便于与库内 date_modified 比较 */
function formatMtimeFromDate(mtime) {
  if (!mtime || typeof mtime.toISOString !== 'function') return '';
  return mtime.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 增量比对用的路径键：Windows 下统一大小写与分隔符，避免库内路径与枚举路径不一致时误判为「全新文件」
 */
function normalizeScanPathKey(p) {
  if (!p) return '';
  try {
    var n = path.normalize(String(p));
    if (process.platform === 'win32') {
      n = n.replace(/\//g, '\\').toLowerCase();
    }
    return n;
  } catch (e) {
    return String(p);
  }
}

function sleepMs(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}
var RAW_EXTENSIONS = new Set([
  '.raw',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2',
  '.raf',
  '.pef',
  '.x3f',
  '.crw',
  '.dcr',
]);

/** 扫描时跳过的系统目录名（小写 basename；回收站等多以 . / $ 开头已由下方前缀规则覆盖） */
var SKIP_SYSTEM_DIR_BASENAMES = new Set([
  'system volume information',
  'recycler',
  'recovery',
  'lost+found',
  'perflogs',
  'msocache',
  '@eadir',
]);
// 两阶段导入：先快速入库路径，再通过“缩略图补全”后台生成缩略图
var GENERATE_THUMBNAILS_DURING_SCAN = false;

function defaultScanOptions() {
  return {
    followSymlinks: false,
    maxDepth: 0,
    skipDirNameSet: new Set(),
    includeRaw: true,
    diskProfile: 'auto',
    ioThrottleMs: 0,
  };
}

function resolveScanRuntimeProfile(scanOpts) {
  var profile = String((scanOpts && scanOpts.diskProfile) || 'auto').toLowerCase();
  var ioThrottleMs = parseInt(scanOpts && scanOpts.ioThrottleMs, 10);
  if (isNaN(ioThrottleMs) || ioThrottleMs < 0) ioThrottleMs = 0;
  if (ioThrottleMs > 100) ioThrottleMs = 100;
  if (profile === 'hdd') {
    return {
      profile: 'hdd',
      normalWorkers: 1,
      rawWorkers: 1,
      importChunk: 220,
      ioThrottleMs: Math.max(ioThrottleMs, 12),
    };
  }
  if (profile === 'ssd') {
    return {
      profile: 'ssd',
      normalWorkers: NORMAL_SCAN_WORKERS,
      rawWorkers: RAW_SCAN_WORKERS,
      importChunk: SCAN_IMPORT_CHUNK,
      ioThrottleMs: ioThrottleMs,
    };
  }
  // auto: 用保守配置兼容机械盘，避免随机 IO 抖动过大
  return {
    profile: 'auto',
    normalWorkers: 2,
    rawWorkers: 1,
    importChunk: 320,
    ioThrottleMs: Math.max(ioThrottleMs, 4),
  };
}

function Scanner(db, deps) {
  var getThumb;
  var getScanOpt;
  if (typeof deps === 'function') {
    getThumb = deps;
  } else if (deps && typeof deps === 'object') {
    getThumb = deps.getThumbOptions;
    getScanOpt = deps.getScanOptions;
  }
  this.db = db;
  this.getThumbOptions =
    typeof getThumb === 'function'
      ? getThumb
      : function () {
          return { size: 256, quality: 75 };
        };
  this.getScanOptions =
    typeof getScanOpt === 'function'
      ? getScanOpt
      : function () {
          return defaultScanOptions();
        };
  this.isScanning = false;
  this.cancelled = false;
  this.paused = false;
  this.progress = { current: 0, total: 0, status: 'idle', currentFile: '' };
  this.lastScanSummary = { cleanupDeleted: 0 };
  this.insertStmt = null;
  this.pauseWaiter = null;
  this._scanStartedAtMs = 0;
  this._scanStats = null;
}

Scanner.prototype.getProgress = function () {
  var out = Object.assign({}, this.progress);
  var elapsedMs = this._scanStartedAtMs ? Date.now() - this._scanStartedAtMs : 0;
  var scanned = Number(out.current) || 0;
  var filesPerSec = elapsedMs > 0 ? (scanned * 1000) / elapsedMs : 0;
  out.elapsedMs = elapsedMs;
  out.filesPerSec = Number(filesPerSec.toFixed(2));
  if (this._scanStats) {
    out.scanStats = Object.assign({}, this._scanStats);
  }
  return out;
};

Scanner.prototype.cancelScan = function () {
  this.cancelled = true;
  this.progress.status = 'cancelled';
  this.resumeScan();
};

Scanner.prototype.pauseScan = function () {
  if (!this.isScanning || this.cancelled) return false;
  this.paused = true;
  this.progress.status = 'paused';
  return true;
};

Scanner.prototype.resumeScan = function () {
  if (!this.isScanning) return false;
  var wasPaused = this.paused;
  this.paused = false;
  if (this.progress.status === 'paused') {
    this.progress.status = 'scanning';
  }
  if (this.pauseWaiter) {
    this.pauseWaiter();
    this.pauseWaiter = null;
  }
  return wasPaused;
};

Scanner.prototype.waitIfPaused = async function () {
  while (this.paused && !this.cancelled) {
    await new Promise((resolve) => {
      this.pauseWaiter = resolve;
    });
  }
};

Scanner.prototype.scanFolder = async function (rootPath) {
  if (this.isScanning) {
    throw new Error('Scanning in progress');
  }

  this.isScanning = true;
  this.cancelled = false;
  this.paused = false;
  this.progress = { current: 0, total: 0, status: 'scanning', currentFile: '' };
  this._scanStartedAtMs = Date.now();
  this._scanStats = {
    scanned: 0,
    skippedUnchanged: 0,
    inserted: 0,
    relocated: 0,
    ignored: 0,
    failed: 0,
  };
  this.lastScanSummary = { cleanupDeleted: 0 };
  var perfStartedAt = Date.now();
  var perfLastAt = perfStartedAt;
  function perfMark(label) {
    if (!SCAN_PERF_LOG) return;
    var now = Date.now();
    console.log(
      '[scan-perf] %s elapsed=%dms step=%dms',
      label,
      now - perfStartedAt,
      now - perfLastAt,
    );
    perfLastAt = now;
  }

  try {
    this.progress.status = 'enumerating';
    this._enumerateYieldCounter = 0;
    var files = [];
    var scanOpts = this.getScanOptions();
    var ioProfile = resolveScanRuntimeProfile(scanOpts);
    this.progress.scanProfile = ioProfile.profile;
    this.progress.ioThrottleMs = ioProfile.ioThrottleMs;
    this.progress.workerNormal = ioProfile.normalWorkers;
    this.progress.workerRaw = ioProfile.rawWorkers;
    await this.enumerateFiles(rootPath, files, 0, null, scanOpts);
    perfMark('enumerate-files');

    if (!scanOpts.includeRaw) {
      var kept = [];
      for (var fi = 0; fi < files.length; fi++) {
        var fpi = files[fi];
        var extRaw = path.extname(fpi).toLowerCase();
        if (!RAW_EXTENSIONS.has(extRaw)) kept.push(fpi);
        if (fi > 0 && fi % WORKER_HEARTBEAT_YIELD_EVERY === 0) {
          await yieldEventLoop();
        }
      }
      files = kept;
    }

    this.progress.current = 0;
    this.progress.status = 'scanning';
    // 扫描完成后用于对账：仅保留本次确认为“仍存在”的路径记录
    var scannedPathSet = new Set(files);
    perfMark('build-scanned-set');

    var rootId = this.db.addRootFolder(rootPath);

    if (!rootId) {
      throw new Error('无法添加根目录：' + rootPath);
    }

    // 加载已有文件（规范化路径 -> 修改时间+大小），用于快速增量比对
    var existingMap = new Map();
    var j = 0;
    for (var row of this.db.iterateExistingFiles(rootId)) {
      var mapKey = normalizeScanPathKey(row.file_path);
      existingMap.set(mapKey, {
        date_modified: row.date_modified,
        file_size: Number(row.file_size) || 0,
      });
      j++;
      if (j % WORKER_HEARTBEAT_YIELD_EVERY === 0) {
        await yieldEventLoop();
      }
    }
    perfMark('load-existing-map');

    this.insertStmt = this.db.getInsertStmt();
    this.db.beginTransaction();
    this._txBatchInserts = 0;

    // 单遍比对：未变更文件仅 stat 一次，不进入 worker；进度 total 仅为「需处理」数量，大库重扫体感明显加快
    var statCache = new Map();
    var normalFiles = [];
    var rawFiles = [];
    var skippedInc = 0;
    this.progress.currentFile = '检测变更…';
    for (var pi = 0; pi < files.length; pi++) {
      await this.waitIfPaused();
      if (this.cancelled) break;
      if (pi > 0 && pi % PARTITION_STAT_YIELD_EVERY === 0) {
        await yieldEventLoop();
      }
      this.progress.current = pi + 1;
      this.progress.total = files.length;
      var fpath = files[pi];
      var fst;
      try {
        fst = fs.statSync(fpath);
      } catch (eStat) {
        var extFail = path.extname(fpath).toLowerCase();
        if (RAW_EXTENSIONS.has(extFail)) rawFiles.push(fpath);
        else normalFiles.push(fpath);
        continue;
      }
      var modTime = formatMtimeFromDate(fst.mtime);
      var exRow = existingMap.get(normalizeScanPathKey(fpath));
      if (
        exRow &&
        String(exRow.date_modified || '').trim() === modTime &&
        Number(exRow.file_size) === Number(fst.size)
      ) {
        skippedInc++;
        continue;
      }
      statCache.set(fpath, fst);
      var extP = path.extname(fpath).toLowerCase();
      if (RAW_EXTENSIONS.has(extP)) rawFiles.push(fpath);
      else normalFiles.push(fpath);
    }
    if (this._scanStats) this._scanStats.skippedUnchanged = skippedInc;
    perfMark('incremental-partition');

    if (this.cancelled) {
      try {
        this._flushPendingScanBatchTransaction();
        this.db.commit();
      } catch (eC) {}
      this.progress.status = 'cancelled';
      return Object.assign({}, this.lastScanSummary);
    }

    this.progress.total = normalFiles.length + rawFiles.length;
    this.progress.current = 0;
    this.progress.currentFile = '';

    await this.processFileGroupInChunks(
      normalFiles,
      rootId,
      statCache,
      ioProfile.normalWorkers,
      ioProfile.importChunk,
      ioProfile.ioThrottleMs,
    );
    perfMark('scan-normal-files');
    await this.processFileGroupInChunks(
      rawFiles,
      rootId,
      statCache,
      ioProfile.rawWorkers,
      ioProfile.importChunk,
      ioProfile.ioThrottleMs,
    );
    perfMark('scan-raw-files');

    if (this.cancelled) {
      this.db.commit();
      this.progress.status = 'cancelled';
      return;
    }

    this._flushPendingScanBatchTransaction();
    // 关键：增量扫描后同步删除该根目录下已不存在的旧记录（含缩略图）
    var cleanupResult = { deleted: 0, markedMissing: 0 };
    if (this.db && typeof this.db.cleanupStalePhotosForRoot === 'function') {
      cleanupResult = this.db.cleanupStalePhotosForRoot(rootId, scannedPathSet) || cleanupResult;
    }
    this.lastScanSummary.cleanupDeleted =
      Number(cleanupResult.markedMissing) || Number(cleanupResult.deleted) || 0;
    this.db.commit();
    if (this.db && typeof this.db.refreshRootFolderStatsCacheForRoot === 'function') {
      try {
        this.db.refreshRootFolderStatsCacheForRoot(rootId);
      } catch (eInv) {
        void eInv;
      }
    }
    perfMark('cleanup-and-commit');
    this.progress.status = 'done';
    this.progress.cleanupDeleted = this.lastScanSummary.cleanupDeleted;
    return Object.assign({}, this.lastScanSummary);
  } catch (err) {
    this.progress.status = 'error';
    this.progress.error = err.message;
    try {
      this.db.commit();
    } catch (e) {}
    throw err;
  } finally {
    this.isScanning = false;
    this.paused = false;
    this.insertStmt = null;
    this.pauseWaiter = null;
  }
};

Scanner.prototype.processFileGroup = async function (files, rootId, statCache, workerCount) {
  if (!files || files.length === 0) return;
  var self = this;
  var cursor = 0;
  var workers = [];
  var count = Math.max(1, workerCount || 1);

  async function workerLoop() {
    var localYield = 0;
    while (true) {
      await self.waitIfPaused();
      if (self.cancelled) return;
      if (cursor >= files.length) return;
      var idx = cursor++;
      var filePath = files[idx];
      self.progress.current++;
      if (self._scanStats) self._scanStats.scanned++;
      self.progress.currentFile = path.basename(filePath);

      var preStat = statCache && statCache.get ? statCache.get(filePath) : null;
      var outcome = await self.processFile(filePath, rootId, preStat);
      if (self._scanStats) {
        if (outcome === 'inserted') self._scanStats.inserted++;
        else if (outcome === 'relocated') self._scanStats.relocated++;
        else if (outcome === 'ignored') self._scanStats.ignored++;
        else if (outcome === 'failed') self._scanStats.failed++;
      }
      if (++localYield % PROCESS_YIELD_EVERY === 0) await yieldEventLoop();
    }
  }

  for (var i = 0; i < count; i++) {
    workers.push(workerLoop());
  }
  await Promise.all(workers);
};

Scanner.prototype.processFileGroupInChunks = async function (
  files,
  rootId,
  statCache,
  workerCount,
  importChunkSize,
  ioThrottleMs,
) {
  if (!files || files.length === 0) return;
  var chunkSize =
    parseInt(importChunkSize, 10) > 0 ? parseInt(importChunkSize, 10) : SCAN_IMPORT_CHUNK;
  var throttle = parseInt(ioThrottleMs, 10) > 0 ? parseInt(ioThrottleMs, 10) : 0;
  for (var start = 0; start < files.length; start += chunkSize) {
    await this.waitIfPaused();
    if (this.cancelled) return;
    var end = Math.min(start + chunkSize, files.length);
    var chunk = files.slice(start, end);
    await this.processFileGroup(chunk, rootId, statCache, workerCount);
    // 每批处理后尽快提交，减少长事务造成的读写阻塞
    this._flushPendingScanBatchTransaction();
    if (throttle > 0) {
      await sleepMs(throttle);
    }
    await yieldEventLoop();
  }
};

Scanner.prototype._shouldSkipDirEntry = function (name, opts) {
  if (!name) return true;
  var lower = String(name).toLowerCase();
  // Unix/macOS 隐藏目录、相册旁常见元数据；Windows $ 开头的系统目录（含 $RECYCLE.BIN）
  if (lower.startsWith('.') || lower.startsWith('$')) return true;
  if (SKIP_SYSTEM_DIR_BASENAMES.has(lower)) return true;
  // chkdsk 恢复夹 found.000、found.001 …
  if (/^found\.\d+$/.test(lower)) return true;
  if (opts && opts.skipDirNameSet && opts.skipDirNameSet.size > 0) {
    if (opts.skipDirNameSet.has(lower)) return true;
  }
  return false;
};

Scanner.prototype.enumerateFiles = async function (dir, results, depth, visited, opts) {
  if (this.cancelled) return;
  opts = opts || defaultScanOptions();
  visited = visited || new Set();
  // 枚举阶段 total 未知，至少持续更新“当前目录/已发现数量”，避免 UI 长期 0% 像卡死
  try {
    this.progress.status = 'enumerating';
    this.progress.currentFile = dir || '';
    this.progress.current = Array.isArray(results) ? results.length : 0;
    this.progress.total = 0;
  } catch (e0) {}
  var realHere;
  try {
    realHere = fs.realpathSync(dir);
  } catch (err) {
    return;
  }
  if (visited.has(realHere)) return;
  visited.add(realHere);

  var entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }

  for (var i = 0; i < entries.length; i++) {
    await this.waitIfPaused();
    if (this.cancelled) return;
    if (++this._enumerateYieldCounter >= ENUMERATE_YIELD_EVERY) {
      this._enumerateYieldCounter = 0;
      await yieldEventLoop();
    }
    var entry = entries[i];
    var name = entry.name;
    if (this._shouldSkipDirEntry(name, opts)) continue;

    if (entry.isSymbolicLink() && !opts.followSymlinks) continue;

    var fullPath = path.join(dir, name);
    if (entry.isSymbolicLink() && opts.followSymlinks) {
      try {
        fullPath = fs.realpathSync(fullPath);
      } catch (e) {
        continue;
      }
    }

    var st;
    try {
      st = fs.statSync(fullPath);
    } catch (e2) {
      continue;
    }

    if (st.isDirectory()) {
      var nextDepth = depth + 1;
      if (opts.maxDepth > 0 && nextDepth > opts.maxDepth) continue;
      await this.enumerateFiles(fullPath, results, nextDepth, visited, opts);
    } else if (st.isFile()) {
      var ext = path.extname(fullPath).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
        results.push(fullPath);
        try {
          this.progress.current = results.length;
          this.progress.currentFile = fullPath;
        } catch (e3) {}
      }
    }
  }
};

Scanner.prototype._maybeCommitScanBatch = function () {
  if (!this.insertStmt) return;
  this._txBatchInserts = (this._txBatchInserts || 0) + 1;
  if (this._txBatchInserts < SCAN_TX_BATCH) return;
  try {
    this.db.commit();
    this.db.beginTransaction();
    this._txBatchInserts = 0;
  } catch (e) {
    console.error('scan batch commit:', e && e.message ? e.message : e);
  }
};

Scanner.prototype._flushPendingScanBatchTransaction = function () {
  if (!this.insertStmt) return;
  if (!this._txBatchInserts) return;
  try {
    this.db.commit();
    this.db.beginTransaction();
    this._txBatchInserts = 0;
  } catch (e) {
    console.error('scan batch flush:', e && e.message ? e.message : e);
  }
};

Scanner.prototype.processFile = async function (filePath, rootId, preStat) {
  try {
    var stat = preStat || fs.statSync(filePath);
    var ext = path.extname(filePath).toLowerCase();

    var dateTaken = null;
    var width = 0;
    var height = 0;
    var thumbnail = null;

    if (GENERATE_THUMBNAILS_DURING_SCAN) {
      // 对所有图片格式都尝试读取元数据和生成缩略图（含 RAW）
      try {
        var metadata = await sharp(filePath).metadata();

        if (metadata.width) width = metadata.width;
        if (metadata.height) height = metadata.height;

        if (metadata.exif && metadata.exif.DateTimeOriginal) {
          dateTaken = this.parseExifDate(metadata.exif.DateTimeOriginal);
        }

        try {
          var topts = this.getThumbOptions();
          var tsz = topts.size || 256;
          var tq = topts.quality != null ? topts.quality : 75;
          var thumbBuffer = await sharp(filePath)
            .rotate()
            .resize(tsz, tsz, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: tq })
            .toBuffer();
          thumbnail = thumbBuffer;
        } catch (e) {}
      } catch (e) {}
    }

    var dateModified = stat.mtime.toISOString().replace('T', ' ').substring(0, 19);
    if (!dateTaken) {
      dateTaken = dateModified;
    }

    // 目录迁移场景优化：
    // 若存在“同名+同大小+同修改时间”的旧记录且旧路径已失效，则直接重定位该记录，
    // 保留其已有缩略图/哈希，避免重复插入后再清理。
    var fileName = path.basename(filePath);
    var hashCandidates = [];
    if (this.db && typeof this.db.findMissingHashRelocateCandidates === 'function') {
      hashCandidates = this.db.findMissingHashRelocateCandidates(stat.size, filePath) || [];
    }
    if (hashCandidates && hashCandidates.length > 0) {
      var fileHash = this.computeFileSha1(filePath);
      if (fileHash) {
        var matched = [];
        for (var hi = 0; hi < hashCandidates.length; hi++) {
          if (String(hashCandidates[hi].file_hash || '') === fileHash)
            matched.push(hashCandidates[hi]);
        }
        if (matched.length === 1) {
          var hm = matched[0];
          var movedByHash =
            this.db &&
            typeof this.db.relocatePhotoRecord === 'function' &&
            this.db.relocatePhotoRecord(hm.id, rootId, path.dirname(filePath), filePath);
          if (movedByHash) {
            this._maybeCommitScanBatch();
            return 'relocated';
          }
        }
      }
    }

    var cands = [];
    if (this.db && typeof this.db.findRelocateCandidates === 'function') {
      cands = this.db.findRelocateCandidates(fileName, stat.size, dateModified, filePath) || [];
    }
    var staleCands = [];
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      if (c && c.file_path && !fs.existsSync(c.file_path)) {
        staleCands.push(c);
      }
    }
    // 仅在唯一候选时执行重定位，避免同名同大小同时间文件串档
    var old = staleCands.length === 1 ? staleCands[0] : null;
    if (old) {
      var moved =
        this.db &&
        typeof this.db.relocatePhotoRecord === 'function' &&
        this.db.relocatePhotoRecord(old.id, rootId, path.dirname(filePath), filePath);
      if (moved) {
        this._maybeCommitScanBatch();
        return 'relocated';
      }
    }

    var ir = this.insertStmt.run(
      rootId,
      path.dirname(filePath),
      fileName,
      filePath,
      stat.size,
      ext.replace('.', ''),
      width,
      height,
      dateTaken,
      dateModified,
      thumbnail || null,
      thumbnail ? 1 : 0,
    );
    this._maybeCommitScanBatch();
    return ir && ir.changes > 0 ? 'inserted' : 'ignored';
  } catch (err) {
    // 跳过外键约束失败等数据库错误，不中断扫描
    if (err.message && err.message.indexOf('FOREIGN KEY') !== -1) {
      console.error('SKIP (FK): ' + filePath);
    } else {
      console.error('File error: ' + filePath, err.message);
    }
    return 'failed';
  }
};

Scanner.prototype.computeFileSha1 = function (filePath) {
  try {
    var h = crypto.createHash('sha1');
    var fd = fs.openSync(filePath, 'r');
    try {
      var buf = Buffer.allocUnsafe(1024 * 1024);
      while (true) {
        var n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  } catch (e) {
    return '';
  }
};

Scanner.prototype.parseExifDate = function (dateStr) {
  if (!dateStr) return null;
  return dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
};

module.exports = Scanner;
