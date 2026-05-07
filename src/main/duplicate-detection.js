const logger = require('./logger');
const fs = require('fs');
const os = require('os');
const { runDbReadWorkerOnly } = require('../db-read-runner');
const { estimateEtaSecondsSmoothed } = require('./utils');

/** 大缓冲减少读系统调用；并发由 runDuplicateHashDetection 控制，避免机械盘一次性开太多流 */
const DUP_HASH_READ_BUFFER = 1024 * 1024;
/** 单文件哈希超时（毫秒），防止异常文件/设备导致任务长时间卡住不前 */
const DUP_HASH_FILE_TIMEOUT_MS = 90000;
const DUP_HASH_BG_LOG_MIN_INTERVAL_MS = 4000;

// Task state
let duplicateHashTask = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  hashed: 0,
  reused: 0,
  failed: 0,
  /** 库中待哈希但磁盘路径不存在，已跳过 */
  skippedMissing: 0,
  duplicateGroups: 0,
  duplicatePhotos: 0,
  currentFile: '',
  currentHash: '',
  phase: 'idle',
  startedAt: 0,
};

// Cache for duplicate groups paging
const duplicateHashGroupsCache = {
  minCount: 2,
  pageSize: 40,
  total: null,
  totalPages: null,
  pages: Object.create(null),
  warmedAt: 0,
};

let duplicateHashBgLogLastAt = 0;
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

function clearDuplicateHashGroupsCache(reason) {
  duplicateHashGroupsCache.total = null;
  duplicateHashGroupsCache.totalPages = null;
  duplicateHashGroupsCache.pages = Object.create(null);
  duplicateHashGroupsCache.warmedAt = 0;
  if (isDev && reason) {
    logger.log('[dup-groups-cache] cleared reason=%s', String(reason));
  }
}

function duplicateHashBgLog(stage, detail, force) {
  var now = Date.now();
  if (!force && now - duplicateHashBgLogLastAt < DUP_HASH_BG_LOG_MIN_INTERVAL_MS) return;
  duplicateHashBgLogLastAt = now;
  var elapsed =
    duplicateHashTask && duplicateHashTask.startedAt ? now - duplicateHashTask.startedAt : 0;
  var done = Number(duplicateHashTask && duplicateHashTask.done) || 0;
  var total = Number(duplicateHashTask && duplicateHashTask.total) || 0;
  var hashed = Number(duplicateHashTask && duplicateHashTask.hashed) || 0;
  var failed = Number(duplicateHashTask && duplicateHashTask.failed) || 0;
  var skippedMissing = Number(duplicateHashTask && duplicateHashTask.skippedMissing) || 0;
  if (detail != null && String(detail).length > 0) {
    logger.log(
      '[dup-hash-bg +%dms] %s | %s | done=%d/%d hashed=%d failed=%d missing=%d',
      elapsed,
      stage,
      String(detail),
      done,
      total,
      hashed,
      failed,
      skippedMissing,
    );
  } else {
    logger.log(
      '[dup-hash-bg +%dms] %s | done=%d/%d hashed=%d failed=%d missing=%d',
      elapsed,
      stage,
      done,
      total,
      hashed,
      failed,
      skippedMissing,
    );
  }
}

function hashFileSha256(filePath, shouldCancel) {
  return new Promise(function (resolve, reject) {
    var crypto = require('crypto');
    var hash = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath, { highWaterMark: DUP_HASH_READ_BUFFER });
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try {
        stream.destroy(new Error('hash timeout'));
      } catch (e0) {
        void e0;
      }
      reject(new Error('hash timeout'));
    }, DUP_HASH_FILE_TIMEOUT_MS);
    function done(err, digest) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(digest);
    }
    stream.on('data', function (chunk) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        try {
          stream.destroy(new Error('hash cancelled'));
        } catch (eStop) {
          void eStop;
        }
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', function (err) {
      done(err);
    });
    stream.on('end', function () {
      done(null, hash.digest('hex'));
    });
  });
}

/** 并行算摘要：慢盘场景更保守，避免随机读放大后反而变慢 */
function getDupHashConcurrency() {
  var n = (os.cpus() && os.cpus().length) || 2;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 8) return 3;
  return 4;
}

async function processDupHashRowsChunk(
  db,
  rows,
  yieldEvery,
  yieldForPreviewPlaybackMs,
  duplicateHashTaskRef,
) {
  var len = rows.length;
  if (len === 0) return;
  var concurrency = getDupHashConcurrency();
  var nextIndex = 0;
  var outcomes = new Array(len);
  var doneBase = Number(duplicateHashTaskRef.done) || 0;
  var completedInChunk = 0;
  var progressEmitEvery = 4;

  async function worker() {
    while (true) {
      if (duplicateHashTaskRef.cancelled) return;
      var my = nextIndex++;
      if (my >= len) return;
      var row = rows[my];
      if (duplicateHashTaskRef.cancelled) return;
      duplicateHashTaskRef.currentFile = row && row.file_path ? row.file_path : '';
      duplicateHashTaskRef.currentHash = '';
      try {
        if (row.file_path && fs.existsSync(row.file_path)) {
          var digest = await hashFileSha256(row.file_path, function () {
            return !!duplicateHashTaskRef.cancelled;
          });
          if (duplicateHashTaskRef.cancelled) return;
          outcomes[my] = { kind: 'hashed', row: row, digest: digest };
        } else {
          outcomes[my] = { kind: 'missing', row: row };
        }
      } catch (e) {
        if (duplicateHashTaskRef.cancelled) return;
        outcomes[my] = { kind: 'fail', row: row };
      }
      completedInChunk++;
      duplicateHashTaskRef.done = doneBase + completedInChunk;
      if (completedInChunk % progressEmitEvery === 0) {
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, function () {
      return worker();
    }),
  );
  duplicateHashBgLog('chunk-hashed', 'rows=' + String(len), false);

  db.beginTransaction();
  try {
    for (var k = 0; k < len; k++) {
      if (duplicateHashTaskRef.cancelled) break;
      var o = outcomes[k];
      if (!o) continue;
      duplicateHashTaskRef.currentFile = o.row.file_path || '';
      if (o.kind === 'hashed') {
        db.updatePhotoHash(o.row.id, o.digest, o.row.date_modified, o.row.file_size);
        duplicateHashTaskRef.hashed++;
        duplicateHashTaskRef.currentHash = o.digest;
      } else if (o.kind === 'missing') {
        duplicateHashTaskRef.skippedMissing++;
        duplicateHashTaskRef.currentHash = '';
      } else {
        duplicateHashTaskRef.failed++;
        duplicateHashTaskRef.currentHash = '';
      }
      if ((k + 1) % yieldEvery === 0) {
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
        await yieldForPreviewPlaybackMs(20);
      }
    }
  } finally {
    db.commit();
  }
  duplicateHashBgLog('chunk-committed', 'rows=' + String(len), false);
}

function getDuplicateHashTaskProgress() {
  var d = duplicateHashTask.done;
  var tot = duplicateHashTask.total;
  return {
    running: duplicateHashTask.running,
    cancelled: duplicateHashTask.cancelled,
    total: tot,
    done: d,
    hashed: duplicateHashTask.hashed,
    reused: duplicateHashTask.reused,
    failed: duplicateHashTask.failed,
    skippedMissing: duplicateHashTask.skippedMissing || 0,
    duplicateGroups: duplicateHashTask.duplicateGroups,
    duplicatePhotos: duplicateHashTask.duplicatePhotos,
    currentFile: duplicateHashTask.currentFile,
    currentHash: duplicateHashTask.currentHash,
    phase: duplicateHashTask.phase || 'idle',
    mode: 'pending_only',
    etaSeconds: estimateEtaSecondsSmoothed('dupHash', duplicateHashTask.startedAt, d, tot),
  };
}

async function runDuplicateHashDetection(
  db,
  sqliteDbPath,
  yieldForPreviewPlaybackMs,
  emitBackgroundTasksChangedThrottled,
) {
  if (duplicateHashTask.running) {
    return { started: false, reason: 'running' };
  }
  clearDuplicateHashGroupsCache('dup-hash-start');
  duplicateHashTask.running = true;
  duplicateHashTask.cancelled = false;
  duplicateHashTask.done = 0;
  duplicateHashTask.hashed = 0;
  duplicateHashTask.reused = 0;
  duplicateHashTask.failed = 0;
  duplicateHashTask.skippedMissing = 0;
  duplicateHashTask.duplicateGroups = 0;
  duplicateHashTask.duplicatePhotos = 0;
  duplicateHashTask.currentFile = '';
  duplicateHashTask.currentHash = '';
  duplicateHashTask.phase = 'preparing';
  duplicateHashTask.startedAt = Date.now();
  duplicateHashBgLogLastAt = 0;
  duplicateHashBgLog('start', '', true);
  emitBackgroundTasksChangedThrottled(true);
  try {
    await new Promise(function (resolve) {
      setImmediate(resolve);
    });
    if (db && typeof db.ensureDuplicateHashSchema === 'function') {
      db.ensureDuplicateHashSchema();
    }
    var readPathDup = sqliteDbPath;
    if (!readPathDup) {
      throw new Error('duplicate-hash: database path unavailable');
    }
    duplicateHashTask.currentFile = '正在统计待比对数量…';
    duplicateHashTask.phase = 'counting';
    duplicateHashBgLog('counting.start', '', true);
    var totalPromise = runDbReadWorkerOnly(readPathDup, 'getHashAllPhotoCount', {})
      .then(function (n) {
        var total = Number(n) || 0;
        // 统计完成时 done 可能已前进，取更大值避免显示倒退
        duplicateHashTask.total = Math.max(total, Number(duplicateHashTask.done) || 0);
        duplicateHashBgLog('counting.done', 'total=' + String(duplicateHashTask.total), true);
      })
      .catch(function (eCount) {
        logger.warn(
          '[duplicate-hash] count pending-only failed, continue without total:',
          eCount && eCount.message ? eCount.message : eCount,
        );
      })
      .finally(function () {
        if (duplicateHashTask.currentFile === '正在统计待比对数量…') {
          duplicateHashTask.currentFile = '';
        }
        emitBackgroundTasksChangedThrottled(false);
      });

    var afterId = 0;
    duplicateHashTask.phase = 'hashing';
    duplicateHashBgLog('hashing.start', 'batchSize=2000 subChunk=24', true);
    var batchSize = 2000;
    /** 子批大小：控制「停止比对」后最多再算完多少张；并与并发路数相协调 */
    var subChunkSize = 24;
    var yieldEvery = 20;
    while (true) {
      if (duplicateHashTask.cancelled) break;
      await yieldForPreviewPlaybackMs(80);
      var rows = db.getHashAllPhotosAfter(afterId, batchSize);
      if (!rows || rows.length === 0) break;
      for (var sc = 0; sc < rows.length; sc += subChunkSize) {
        if (duplicateHashTask.cancelled) break;
        await yieldForPreviewPlaybackMs(20);
        var slice = rows.slice(sc, sc + subChunkSize);
        await processDupHashRowsChunk(
          db,
          slice,
          yieldEvery,
          yieldForPreviewPlaybackMs,
          duplicateHashTask,
        );
      }
      afterId = rows[rows.length - 1].id;
      duplicateHashBgLog(
        'batch.done',
        'afterId=' + String(afterId) + ' rows=' + String(rows.length),
        false,
      );
      emitBackgroundTasksChangedThrottled(false);
    }
    await totalPromise;

    if (!duplicateHashTask.cancelled) {
      duplicateHashTask.phase = 'summarizing';
      duplicateHashTask.currentFile = '正在汇总重复组…';
      duplicateHashBgLog('summarizing.start', '', true);
      await new Promise(function (resolve) {
        setImmediate(resolve);
      });
      duplicateHashTask.duplicateGroups = await runDbReadWorkerOnly(
        readPathDup,
        'getDuplicateGroupCountByHash',
        {
          minCount: 2,
        },
      );
      duplicateHashTask.duplicatePhotos = await runDbReadWorkerOnly(
        readPathDup,
        'getDuplicatePhotoCountByHash',
        {
          minCount: 2,
        },
      );
      try {
        var warm = await runDbReadWorkerOnly(readPathDup, 'getDuplicateHashGroupsBundle', {
          page: 1,
          pageSize: duplicateHashGroupsCache.pageSize,
          minCount: duplicateHashGroupsCache.minCount,
        });
        duplicateHashGroupsCache.total = Number(warm && warm.total) || 0;
        duplicateHashGroupsCache.totalPages = Number(warm && warm.totalPages) || 0;
        duplicateHashGroupsCache.pages[1] = Array.isArray(warm && warm.groups) ? warm.groups : [];
        duplicateHashGroupsCache.warmedAt = Date.now();
        if (isDev) {
          logger.log(
            '[dup-groups-cache] warmed page=1 groups=%d total=%d',
            duplicateHashGroupsCache.pages[1].length,
            duplicateHashGroupsCache.total,
          );
        }
      } catch (eWarm) {
        void eWarm;
      }
      duplicateHashBgLog(
        'summarizing.done',
        'groups=' +
          String(duplicateHashTask.duplicateGroups || 0) +
          ' photos=' +
          String(duplicateHashTask.duplicatePhotos || 0),
        true,
      );
    } else {
      duplicateHashBgLog('cancelled', '', true);
    }
    duplicateHashBgLog('finish', '', true);
    return { started: true };
  } catch (eRun) {
    duplicateHashBgLog('error', eRun && eRun.message ? eRun.message : String(eRun), true);
    throw eRun;
  } finally {
    duplicateHashTask.running = false;
    duplicateHashTask.currentFile = '';
    duplicateHashTask.currentHash = '';
    duplicateHashTask.phase = duplicateHashTask.cancelled ? 'cancelled' : 'idle';
    duplicateHashTask.startedAt = 0;
    emitBackgroundTasksChangedThrottled(true);
  }
}

function cancelDuplicateHashDetection() {
  duplicateHashTask.cancelled = true;
}

function resetDuplicateHashTask() {
  duplicateHashTask = {
    running: false,
    cancelled: false,
    total: 0,
    done: 0,
    hashed: 0,
    reused: 0,
    failed: 0,
    skippedMissing: 0,
    duplicateGroups: 0,
    duplicatePhotos: 0,
    currentFile: '',
    currentHash: '',
    phase: 'idle',
    startedAt: 0,
  };
}

function getDuplicateHashGroupsPage(page, minCount) {
  // Cache lookup with memory
  if (
    minCount !== duplicateHashGroupsCache.minCount &&
    minCount !== duplicateHashGroupsCache.minCount
  ) {
    duplicateHashGroupsCache.minCount = minCount;
    clearDuplicateHashGroupsCache('min-count-change');
  }
  if (duplicateHashGroupsCache.pages[page]) {
    return {
      page: page,
      minCount: minCount,
      total: duplicateHashGroupsCache.total,
      totalPages: duplicateHashGroupsCache.totalPages,
      groups: duplicateHashGroupsCache.pages[page],
      warmedAt: duplicateHashGroupsCache.warmedAt,
    };
  }
  return null;
}

function cacheDuplicateHashGroupsPage(page, groups, total, totalPages) {
  duplicateHashGroupsCache.pages[page] = groups;
  duplicateHashGroupsCache.total = total;
  duplicateHashGroupsCache.totalPages = totalPages;
}

module.exports = {
  // State getters
  getTaskState: () => duplicateHashTask,
  getCache: () => duplicateHashGroupsCache,
  // Functions
  clearDuplicateHashGroupsCache,
  runDuplicateHashDetection,
  cancelDuplicateHashDetection,
  resetDuplicateHashTask,
  getDuplicateHashTaskProgress,
  getDuplicateHashGroupsPage,
  cacheDuplicateHashGroupsPage,
};
