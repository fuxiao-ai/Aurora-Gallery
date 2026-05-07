const logger = require('./logger');
const { getThumbOptions } = require('./settings');
const {
  loadSharp,
  getFfmpegStaticPath: _getFfmpegStaticPath,
  getVideoFrameThumb: _getVideoFrameThumb,
} = require('./utils');

/** 单次补全任务记录的失败路径上限，避免极端情况下占用过多内存 */
const THUMB_BACKFILL_FAILED_PATHS_MAX = 50000;

// Task state
const thumbnailBackfill = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  currentFile: '',
  startedAt: 0,
  failedPaths: [],
  failedPathsLastRun: [],
};

function getEffectiveThumbBackfillConcurrency(settings) {
  var n = parseInt(settings.thumbBackfillConcurrency, 10) || 1;
  return Math.max(1, Math.min(n, 8));
}

async function runRowsWithThumbConcurrency(
  db,
  rows,
  yieldEvery,
  settings,
  isVideoPathFunc,
  buildVideoPlaceholderThumbnailFunc,
  extractVideoThumbnailWithFfmpegFunc,
  yieldForPreviewPlaybackMs,
  emitBackgroundTasksChangedThrottled,
) {
  var n = rows.length;
  if (n === 0) return;
  var conc = Math.min(getEffectiveThumbBackfillConcurrency(settings), n);
  var next = 0;
  // 分小批次提交，控制内存峰值，每处理N张就写入一次
  // 使用较小批次减少数据库锁持有时间，让前台分页查询更顺畅
  // 背景补全不追求速度，优先保证前台操作流畅
  var miniBatchSize = 15;
  var results = [];

  async function processOne(row) {
    if (thumbnailBackfill.cancelled) return null;
    thumbnailBackfill.currentFile = row.file_path || '';
    var topts = getThumbOptions(settings);
    var result = null;

    // 跳过已删除的照片（避免删除后仍处理导致失败）
    if (!db.photoExists(row.id)) {
      thumbnailBackfill.done++;
      emitBackgroundTasksChangedThrottled(false);
      return null;
    }

    try {
      var thumb;
      if (isVideoPathFunc(row.file_path)) {
        thumb = await extractVideoThumbnailWithFfmpegFunc(row.file_path, topts);
        if (!thumb) {
          thumb = await buildVideoPlaceholderThumbnailFunc(topts);
        }
      } else {
        // 对损坏的 JPEG 尝试宽松解码，即使有警告也尽力输出缩略图
        thumb = await loadSharp()(row.file_path, { failOnError: false })
          .rotate()
          .resize(topts.size, topts.size, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: topts.quality })
          .toBuffer();
      }
      thumbnailBackfill.success++;
      result = { id: row.id, thumbnail: thumb };
    } catch (e) {
      // 任何错误都尝试生成占位图，尽可能减少缺失
      logger.error('Thumbnail generation failed for:', row.file_path, e.message);
      try {
        var placeholder = await buildVideoPlaceholderThumbnailFunc(topts);
        thumbnailBackfill.success++;
        result = { id: row.id, thumbnail: placeholder };
      } catch (fallbackErr) {
        thumbnailBackfill.failed++;
        if (thumbnailBackfill.failedPaths.length < THUMB_BACKFILL_FAILED_PATHS_MAX) {
          var fpe = row.file_path || '';
          if (fpe) thumbnailBackfill.failedPaths.push(fpe);
        }
      }
    }
    // 无论成功失败，计数都+1，确保进度准确
    thumbnailBackfill.done++;
    emitBackgroundTasksChangedThrottled(false);
    await new Promise(function (resolve) {
      setImmediate(resolve);
    });
    return result;
  }

  async function commitMiniBatch() {
    if (results.length === 0) return;
    // 小批次事务提交，平衡锁竞争和内存
    db.beginTransaction();
    try {
      for (var r of results) {
        db.updatePhotoThumbnail(r.id, r.thumbnail);
      }
      db.commit();
    } catch (e) {
      logger.error('Mini-batch commit failed:', e.message);
      db.rollback();
      // 单条重试，减少失败
      for (var r2 of results) {
        try {
          db.updatePhotoThumbnail(r2.id, r2.thumbnail);
          thumbnailBackfill.success++;
        } catch (singleErr) {
          logger.error('Single update failed:', r2.id, singleErr.message);
          thumbnailBackfill.failed++;
        }
      }
    }
    results = []; // 清空释放内存
    // 提交后主动让出给事件循环，让前台分页查询获得数据库锁
    // 这解决了背景补全时点击随机跳转分页卡顿问题
    await yieldForPreviewPlaybackMs(8);
  }

  async function worker() {
    while (true) {
      if (thumbnailBackfill.cancelled) return;
      var i = next++;
      if (i >= n) return;
      var result = await processOne(rows[i]);
      if (result) {
        results.push(result);
        // 达到小批次大小就提交
        if (results.length >= miniBatchSize) {
          await commitMiniBatch();
        }
      }
      // 定期让出保证进度更新到达UI
      if (next % yieldEvery === 0) {
        emitBackgroundTasksChangedThrottled(true);
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
      }
    }
  }

  var workers = [];
  for (var w = 0; w < conc; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  // 提交剩余的最后一批
  await commitMiniBatch();
}

async function runThumbnailBackfill(
  db,
  limit,
  settings,
  isVideoPathFunc,
  buildVideoPlaceholderThumbnailFunc,
  extractVideoThumbnailWithFfmpegFunc,
  yieldForPreviewPlaybackMs,
  emitBackgroundTasksChangedThrottled,
) {
  if (thumbnailBackfill.running) {
    return { started: false, reason: 'running' };
  }
  thumbnailBackfill.running = true;
  thumbnailBackfill.cancelled = false;
  thumbnailBackfill.done = 0;
  thumbnailBackfill.success = 0;
  thumbnailBackfill.failed = 0;
  thumbnailBackfill.currentFile = '';
  thumbnailBackfill.failedPaths = [];
  thumbnailBackfill.startedAt = Date.now();
  thumbnailBackfill.total = 0;
  emitBackgroundTasksChangedThrottled(true);

  try {
    // 让出多次事件循环，让 UI 先更新状态再开始查询，避免启动就卡死
    await yieldForPreviewPlaybackMs(10);
    await yieldForPreviewPlaybackMs(10);

    var batchSize = 200;
    var maxToProcess = typeof limit === 'number' && limit > 0 ? limit : null;
    var missingTotal = db.getMissingThumbnailCount();
    thumbnailBackfill.total =
      maxToProcess != null ? Math.min(maxToProcess, missingTotal) : missingTotal;
    emitBackgroundTasksChangedThrottled(true);

    var processedInThisRun = 0;
    var afterId = 0;
    var yieldEvery = 20;

    while (true) {
      if (thumbnailBackfill.cancelled) break;
      await yieldForPreviewPlaybackMs(72);
      var fetchLimit = batchSize;
      if (maxToProcess != null) {
        var left = maxToProcess - processedInThisRun;
        if (left <= 0) break;
        fetchLimit = Math.min(batchSize, left);
      }
      var rows = db.getPhotosMissingThumbnailsAfter(afterId, fetchLimit);
      // 让出事件循环让 UI 更新，查询后立即响应进度变化
      await yieldForPreviewPlaybackMs(10);
      if (rows.length === 0) break;

      if (thumbnailBackfill.cancelled) break;
      await runRowsWithThumbConcurrency(
        db,
        rows,
        yieldEvery,
        settings,
        isVideoPathFunc,
        buildVideoPlaceholderThumbnailFunc,
        extractVideoThumbnailWithFfmpegFunc,
        yieldForPreviewPlaybackMs,
        emitBackgroundTasksChangedThrottled,
      );
      afterId = rows[rows.length - 1].id;
      processedInThisRun += rows.length;
      emitBackgroundTasksChangedThrottled(false);
      if (maxToProcess != null && processedInThisRun >= maxToProcess) break;
    }

    return { started: true };
  } finally {
    thumbnailBackfill.failedPathsLastRun = thumbnailBackfill.failedPaths.slice(
      0,
      THUMB_BACKFILL_FAILED_PATHS_MAX,
    );
    thumbnailBackfill.failedPaths = [];
    thumbnailBackfill.running = false;
    thumbnailBackfill.currentFile = '';
    thumbnailBackfill.startedAt = 0;
    emitBackgroundTasksChangedThrottled(true);
  }
}

function cancelThumbnailBackfill() {
  thumbnailBackfill.cancelled = true;
}

function getTaskState() {
  return thumbnailBackfill;
}

function getFailedPathsLastRun() {
  return thumbnailBackfill.failedPathsLastRun;
}

module.exports = {
  THUMB_BACKFILL_FAILED_PATHS_MAX,
  runThumbnailBackfill,
  cancelThumbnailBackfill,
  getTaskState,
  getFailedPathsLastRun,
};
