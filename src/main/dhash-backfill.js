/**
 * dHash 存量补充任务
 * 处理「已有缩略图但缺少 dHash」的存量照片
 * 按 file_path 顺序读取，复用缩略图补全的任务模型（低并发、让出主线程、小批次提交）
 */

'use strict';

const logger = require('./logger');
const { computeDhash, getDhashBuckets } = require('./perceptual-hash');

// Task state
const dhashBackfill = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  hashed: 0,
  reused: 0,
  failed: 0,
  currentFile: '',
  startedAt: 0,
};

function getDhashBackfillConcurrency() {
  var n = (require('os').cpus() && require('os').cpus().length) || 2;
  if (n <= 4) return 1;
  if (n <= 8) return 2;
  return 3;
}

function getDhashBackfillTaskProgress() {
  var d = dhashBackfill.done;
  var tot = dhashBackfill.total;
  return {
    running: dhashBackfill.running,
    cancelled: dhashBackfill.cancelled,
    total: tot,
    done: d,
    hashed: dhashBackfill.hashed,
    reused: dhashBackfill.reused,
    failed: dhashBackfill.failed,
    currentFile: dhashBackfill.currentFile,
    phase: dhashBackfill.phase || 'idle',
    etaSeconds:
      d > 0 && tot > d
        ? Math.round(((Date.now() - dhashBackfill.startedAt) / d) * (tot - d))
        : 0,
  };
}

async function runDhashBackfill(db, yieldForPreviewPlaybackMs, emitBackgroundTasksChangedThrottled) {
  if (dhashBackfill.running) {
    return { started: false, reason: 'running' };
  }
  dhashBackfill.running = true;
  dhashBackfill.cancelled = false;
  dhashBackfill.done = 0;
  dhashBackfill.hashed = 0;
  dhashBackfill.reused = 0;
  dhashBackfill.failed = 0;
  dhashBackfill.currentFile = '';
  dhashBackfill.phase = 'counting';
  dhashBackfill.startedAt = Date.now();
  emitBackgroundTasksChangedThrottled(true);

  try {
    await yieldForPreviewPlaybackMs(10);

    var totalPending = db.getDhashBackfillPhotoCount();
    dhashBackfill.total = totalPending;
    emitBackgroundTasksChangedThrottled(true);

    if (totalPending === 0) {
      dhashBackfill.phase = 'idle';
      return { started: true };
    }

    dhashBackfill.phase = 'hashing';
    var batchSize = 2000;
    var subChunkSize = 24;
    var txSize = 1000;
    var afterId = 0;

    while (true) {
      if (dhashBackfill.cancelled) break;
      await yieldForPreviewPlaybackMs(80);

      var rows = db.getDhashBackfillPhotosAfter(afterId, batchSize);
      if (!rows || rows.length === 0) break;

      for (var sc = 0; sc < rows.length; sc += subChunkSize) {
        if (dhashBackfill.cancelled) break;
        await yieldForPreviewPlaybackMs(20);
        var slice = rows.slice(sc, sc + subChunkSize);
        await processDhashSlice(db, slice, txSize, yieldForPreviewPlaybackMs);
      }

      afterId = rows[rows.length - 1].id;
      emitBackgroundTasksChangedThrottled(false);
    }

    dhashBackfill.phase = 'idle';
    return { started: true };
  } catch (eRun) {
    logger.error('[dhash-backfill] error:', eRun && eRun.message ? eRun.message : String(eRun));
    throw eRun;
  } finally {
    dhashBackfill.running = false;
    dhashBackfill.currentFile = '';
    dhashBackfill.phase = dhashBackfill.cancelled ? 'cancelled' : 'idle';
    dhashBackfill.startedAt = 0;
    emitBackgroundTasksChangedThrottled(true);
  }
}

async function processDhashSlice(db, rows, txSize, yieldForPreviewPlaybackMs) {
  var len = rows.length;
  if (len === 0) return;
  var concurrency = getDhashBackfillConcurrency();
  var nextIndex = 0;
  var txBuffer = [];

  async function worker() {
    while (true) {
      if (dhashBackfill.cancelled) return;
      var my = nextIndex++;
      if (my >= len) return;
      var row = rows[my];
      dhashBackfill.currentFile = row && row.file_path ? row.file_path : '';

      try {
        // 哈希复活：检查 mtime/size 是否变化
        var needsHash = true;
        if (row.dhash_mtime && row.dhash_size != null) {
          if (String(row.dhash_mtime) === String(row.date_modified) && Number(row.dhash_size) === Number(row.file_size)) {
            needsHash = false;
            dhashBackfill.reused++;
          }
        }

        if (needsHash) {
          var dhash = await computeDhash(row.file_path);
          if (dhash) {
            txBuffer.push({
              id: row.id,
              dhash: dhash,
              buckets: getDhashBuckets(dhash),
              mtime: row.date_modified,
              size: row.file_size,
            });
            dhashBackfill.hashed++;
          } else {
            dhashBackfill.failed++;
          }
        }
      } catch (e) {
        dhashBackfill.failed++;
      }

      dhashBackfill.done++;

      // 达到事务批次大小就提交
      if (txBuffer.length >= txSize) {
        await commitDhashBatch(db, txBuffer);
        txBuffer = [];
        await yieldForPreviewPlaybackMs(8);
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, function () {
      return worker();
    }),
  );

  // 提交剩余
  if (txBuffer.length > 0) {
    await commitDhashBatch(db, txBuffer);
  }
}

function commitDhashBatch(db, batch) {
  return new Promise(function (resolve) {
    try {
      db.updatePhotoDhashBatch(batch);
    } catch (e) {
      logger.error('[dhash-backfill] batch commit failed:', e.message);
    }
    resolve();
  });
}

function cancelDhashBackfill() {
  dhashBackfill.cancelled = true;
}

function resetDhashBackfillTask() {
  dhashBackfill.running = false;
  dhashBackfill.cancelled = false;
  dhashBackfill.total = 0;
  dhashBackfill.done = 0;
  dhashBackfill.hashed = 0;
  dhashBackfill.reused = 0;
  dhashBackfill.failed = 0;
  dhashBackfill.currentFile = '';
  dhashBackfill.phase = 'idle';
  dhashBackfill.startedAt = 0;
}

module.exports = {
  runDhashBackfill: runDhashBackfill,
  cancelDhashBackfill: cancelDhashBackfill,
  getTaskState: function () {
    return dhashBackfill;
  },
  getDhashBackfillTaskProgress: getDhashBackfillTaskProgress,
  resetDhashBackfillTask: resetDhashBackfillTask,
};
