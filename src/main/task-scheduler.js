const { Worker } = require('worker_threads');
const path = require('path');
const { estimateEtaSecondsSmoothed } = require('./utils');
const { getThumbOptions, serializeScanOptionsForWorker } = require('./settings');
const { getTaskState, getFailedPathsLastRun } = require('./thumbnail-backfill');

/** 文件夹扫描在 worker 线程执行，状态供进度与 IPC 读取 */
let scanWorker = null;
let scanWorkerDoneReceived = false;
let workerScanIsActive = false;
let workerScanProgress = {
  current: 0,
  total: 0,
  status: 'idle',
  currentFile: '',
};
/** 当前目录扫描开始时间（毫秒），用于预计剩余时间 */
let workerScanStartedAt = 0;
const scanQueue = [];
let isScanQueueProcessing = false;
let currentScanTask = null;
let scanTaskIdSeq = 0;
let sqliteDbPath = null;

/** 缩略图自动回填状态 */
const thumbnailBackfill = {
  running: false,
  cancelled: false,
  startedAt: 0,
  total: 0,
  done: 0,
  success: 0,
  currentFile: '',
  failedPaths: [],
  failedPathsLastRun: [],
};

/** 重复检测状态 */
const duplicateHash = {
  running: false,
  cancelled: false,
  startedAt: 0,
  total: 0,
  done: 0,
  currentFile: '',
};

/** 无效文件清理任务状态 */
const invalidCleanupTask = {
  running: false,
  checked: 0,
  total: 0,
  deleted: 0,
};

function setSqliteDbPath(path) {
  sqliteDbPath = path;
}

function isFolderScanRunning() {
  return !!workerScanIsActive;
}

function terminateScanWorkerSilently() {
  if (!scanWorker) return;
  try {
    scanWorker.removeAllListeners();
    scanWorker.terminate();
  } catch (e) {}
  scanWorker = null;
}

function runFolderScanInWorker(normalizedRootPath, settings) {
  return new Promise(function (resolve) {
    if (!sqliteDbPath) {
      resolve({ cancelled: false, error: '数据库路径未初始化' });
      return;
    }
    scanWorkerDoneReceived = false;
    workerScanIsActive = true;
    workerScanStartedAt = Date.now();
    workerScanProgress = { current: 0, total: 0, status: 'scanning', currentFile: '' };
    var lastHeartbeatAt = Date.now();
    var heartbeatWatchTimer = null;

    var workerPath = path.join(__dirname, '..', 'scan-worker.js');
    var w;
    try {
      w = new Worker(workerPath, {
        workerData: {
          dbPath: sqliteDbPath,
          rootPath: normalizedRootPath,
          thumbOptions: getThumbOptions(settings),
          scanOptions: serializeScanOptionsForWorker(settings),
        },
      });
    } catch (spawnErr) {
      workerScanIsActive = false;
      workerScanStartedAt = 0;
      resolve({
        cancelled: false,
        error: spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr),
      });
      return;
    }
    scanWorker = w;

    function finish(result) {
      if (scanWorkerDoneReceived) return;
      scanWorkerDoneReceived = true;
      workerScanIsActive = false;
      workerScanStartedAt = 0;
      if (heartbeatWatchTimer) {
        clearInterval(heartbeatWatchTimer);
        heartbeatWatchTimer = null;
      }
      // 确保渲染层能看到最终状态（否则队列处理中会一直显示旧的 0%）
      try {
        if (result && result.cancelled) {
          workerScanProgress = { current: 0, total: 0, status: 'cancelled', currentFile: '' };
        } else if (result && result.error) {
          workerScanProgress = {
            current: 0,
            total: 0,
            status: 'error',
            currentFile: '',
            error: result.error,
          };
        } else {
          // 正常完成：保持 done
          workerScanProgress = Object.assign({}, workerScanProgress, { status: 'done' });
        }
      } catch (e0) {}
      var cur = scanWorker;
      scanWorker = null;
      if (cur) {
        cur.terminate().catch(function () {});
      }
      resolve(result);
    }

    // worker 理论上每 300ms 都会发 progress；若长期无任何消息，说明 worker 卡死或通信异常
    heartbeatWatchTimer = setInterval(function () {
      if (scanWorkerDoneReceived) return;
      var silentMs = Date.now() - lastHeartbeatAt;
      // Worker 在加载大库映射 / 全量枚举时可能数秒～数十秒无消息；过短会误杀。真死锁仍会被终止。
      var scanWorkerHeartbeatMs = 120000;
      if (silentMs > scanWorkerHeartbeatMs) {
        finish({
          cancelled: false,
          error:
            '扫描线程无响应（超过 ' +
            Math.round(silentMs / 1000) +
            ' 秒），已终止。请重试添加目录/重新扫描。',
        });
      }
    }, 5000);

    w.on('message', function (msg) {
      lastHeartbeatAt = Date.now();
      if (!msg || !msg.type) return;
      if (msg.type === 'progress' && msg.p) {
        workerScanProgress = Object.assign(
          { current: 0, total: 0, status: 'scanning', currentFile: '' },
          msg.p,
        );
      }
      if (msg.type === 'done') {
        if (msg.finalProgress) {
          workerScanProgress = Object.assign(
            { current: 0, total: 0, status: 'done', currentFile: '' },
            msg.finalProgress,
          );
        }
        finish({
          cancelled: !!msg.cancelled,
          error: msg.error || null,
          scanResult: msg.scanResult || null,
        });
      }
    });

    w.on('error', function (err) {
      finish({
        cancelled: false,
        error: err && err.message ? err.message : String(err),
      });
    });

    w.on('exit', function (code) {
      if (code !== 0 && !scanWorkerDoneReceived) {
        finish({
          cancelled: false,
          error: '扫描线程异常退出（代码 ' + code + '）',
        });
      }
    });
  });
}

function clearPendingScanQueue() {
  if (scanQueue.length === 0) return;
  var pending = scanQueue.splice(0, scanQueue.length);
  for (var i = 0; i < pending.length; i++) {
    pending[i].resolve({ success: false, cancelled: true });
  }
}

function getScanQueueStatus() {
  return {
    processing: isScanQueueProcessing,
    current: currentScanTask
      ? {
          id: currentScanTask.id,
          source: currentScanTask.source,
          rootPath: currentScanTask.rootPath,
        }
      : null,
    pendingCount: scanQueue.length,
    pending: scanQueue.map(function (t) {
      return { id: t.id, source: t.source, rootPath: t.rootPath };
    }),
  };
}

function getWorkerScanProgress() {
  return {
    ...workerScanProgress,
    etaSeconds: workerScanIsActive
      ? estimateEtaSecondsSmoothed(
          'scan',
          workerScanStartedAt,
          workerScanProgress.current,
          workerScanProgress.total,
        )
      : null,
  };
}

function enqueueScanTask(task) {
  return new Promise(function (resolve) {
    scanQueue.push({
      id: scanTaskIdSeq++,
      source: task.source || 'manual',
      rootPath: task.rootPath,
      beforeScan: task.beforeScan || null,
      resolve: resolve,
    });
    processScanQueue();
  });
}

async function yieldForPreviewPlaybackMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let mainWindowRef = null;

function setMainWindowRef(window) {
  mainWindowRef = window;
}

let resolveRootIdByPathRef = null;
let invalidateCatalogCacheForRootSafeRef = null;
let invalidateCatalogCachesSafeRef = null;
let scheduleAutoThumbnailBackfillRef = null;
let scheduleAutoDuplicateHashDetectionRef = null;

function setCatalogCacheCallbacks(
  resolveRootIdByPath,
  invalidateCatalogCacheForRootSafe,
  invalidateCatalogCachesSafe,
) {
  resolveRootIdByPathRef = resolveRootIdByPath;
  invalidateCatalogCacheForRootSafeRef = invalidateCatalogCacheForRootSafe;
  invalidateCatalogCachesSafeRef = invalidateCatalogCachesSafe;
}

function setAutoScheduleCallbacks(
  scheduleAutoThumbnailBackfill,
  scheduleAutoDuplicateHashDetection,
) {
  scheduleAutoThumbnailBackfillRef = scheduleAutoThumbnailBackfill;
  scheduleAutoDuplicateHashDetectionRef = scheduleAutoDuplicateHashDetection;
}

async function processScanQueue() {
  if (isScanQueueProcessing) return;
  isScanQueueProcessing = true;
  var hasSuccessfulScan = false;
  while (scanQueue.length > 0) {
    await yieldForPreviewPlaybackMs(100);
    var task = scanQueue.shift();
    currentScanTask = task;
    try {
      if (mainWindowRef && mainWindowRef.webContents) {
        mainWindowRef.webContents.send('scan-start');
      }
      if (typeof task.beforeScan === 'function') {
        task.beforeScan();
      }
      var normalizedPath = task.rootPath.replace(/\//g, '\\');
      var settings = require('../main').settings;
      var wr = await runFolderScanInWorker(normalizedPath, settings);
      var resultPayload;
      if (wr && wr.error && !wr.cancelled) {
        resultPayload = { success: false, error: wr.error };
      } else if (wr && wr.cancelled) {
        resultPayload = { success: false, cancelled: true };
      } else {
        resultPayload = {
          success: true,
          cleanupDeleted:
            wr && wr.scanResult && Number(wr.scanResult.cleanupDeleted)
              ? Number(wr.scanResult.cleanupDeleted)
              : 0,
        };
      }
      // 无论成功/失败/取消，都发送完成信号，让渲染层退出“准备中...”
      if (mainWindowRef && mainWindowRef.webContents) {
        mainWindowRef.webContents.send('scan-complete', task.rootPath, resultPayload);
      }
      if (resultPayload && resultPayload.success) {
        hasSuccessfulScan = true;
        var rid = resolveRootIdByPathRef(task.rootPath);
        if (rid && invalidateCatalogCacheForRootSafeRef) invalidateCatalogCacheForRootSafeRef(rid);
        else if (invalidateCatalogCachesSafeRef) invalidateCatalogCachesSafeRef();
      }
      task.resolve(resultPayload);
    } catch (err) {
      var errPayload = { success: false, error: err && err.message ? err.message : String(err) };
      if (mainWindowRef && mainWindowRef.webContents) {
        mainWindowRef.webContents.send('scan-complete', task.rootPath, errPayload);
      }
      task.resolve(errPayload);
    }
    currentScanTask = null;
  }
  isScanQueueProcessing = false;
  if (hasSuccessfulScan && scheduleAutoThumbnailBackfillRef) {
    scheduleAutoThumbnailBackfillRef();
    if (scheduleAutoDuplicateHashDetectionRef) scheduleAutoDuplicateHashDetectionRef();
  }
}

function getThumbnailBackfillProgress() {
  var state = getTaskState();
  var d = state.done;
  var tot = state.total;
  var exportable = state.running ? state.failedPaths.length : state.failedPathsLastRun.length;
  return {
    running: state.running,
    cancelled: state.cancelled,
    total: tot,
    done: d,
    success: state.success,
    failed: state.failed,
    currentFile: state.currentFile,
    etaSeconds: estimateEtaSecondsSmoothed('thumbBackfill', state.startedAt, d, tot),
    failedPathsExportable: exportable,
  };
}

function getThumbnailBackfillFailedPathsForExport() {
  return getFailedPathsLastRun().slice();
}

function getInvalidCleanupTaskProgress() {
  var checked = Number(invalidCleanupTask.checked) || 0;
  var total = Number(invalidCleanupTask.total) || 0;
  return {
    running: !!invalidCleanupTask.running,
    checked: checked,
    deleted: Number(invalidCleanupTask.deleted) || 0,
    total: total,
  };
}

function getDuplicateHashProgress() {
  var d = duplicateHash.done;
  var tot = duplicateHash.total;
  return {
    running: duplicateHash.running,
    cancelled: duplicateHash.cancelled,
    total: tot,
    done: d,
    currentFile: duplicateHash.currentFile,
    etaSeconds: estimateEtaSecondsSmoothed('dupHash', duplicateHash.startedAt, d, tot),
  };
}

function resetThumbnailBackfillState() {
  thumbnailBackfill.cancelled = false;
  thumbnailBackfill.running = false;
  thumbnailBackfill.startedAt = 0;
  thumbnailBackfill.total = 0;
  thumbnailBackfill.done = 0;
  thumbnailBackfill.success = 0;
  thumbnailBackfill.currentFile = '';
  thumbnailBackfill.failedPaths = [];
}

function cancelCurrentThumbnailBackfill() {
  thumbnailBackfill.cancelled = true;
}

function isThumbnailBackfillRunning() {
  return thumbnailBackfill.running;
}

function setThumbnailBackfillRunning(running) {
  thumbnailBackfill.running = running;
}

function setThumbnailBackfillProgress(current, total, currentFile) {
  thumbnailBackfill.done = current;
  thumbnailBackfill.total = total;
  thumbnailBackfill.currentFile = currentFile;
}

function incrementThumbnailBackfillSuccess() {
  thumbnailBackfill.success++;
}

function addThumbnailBackfillFailedPath(path) {
  thumbnailBackfill.failedPaths.push(path);
  thumbnailBackfill.failedPathsLastRun.push(path);
}

function finishThumbnailBackfill() {
  thumbnailBackfill.running = false;
  thumbnailBackfill.startedAt = 0;
}

function startThumbnailBackfill(total, startedAt) {
  resetThumbnailBackfillState();
  thumbnailBackfill.running = true;
  thumbnailBackfill.startedAt = startedAt;
  thumbnailBackfill.total = total;
}

function resetDuplicateHashState() {
  duplicateHash.cancelled = false;
  duplicateHash.running = false;
  duplicateHash.startedAt = 0;
  duplicateHash.total = 0;
  duplicateHash.done = 0;
  duplicateHash.currentFile = '';
}

function cancelCurrentDuplicateHash() {
  duplicateHash.cancelled = true;
}

function isDuplicateHashRunning() {
  return duplicateHash.running;
}

function setDuplicateHashRunning(running) {
  duplicateHash.running = running;
}

function setDuplicateHashProgress(current, total, currentFile) {
  duplicateHash.done = current;
  duplicateHash.total = total;
  duplicateHash.currentFile = currentFile;
}

function finishDuplicateHash() {
  duplicateHash.running = false;
  duplicateHash.startedAt = 0;
}

function startDuplicateHash(total, startedAt) {
  resetDuplicateHashState();
  duplicateHash.running = true;
  duplicateHash.startedAt = startedAt;
  duplicateHash.total = total;
}

function setInvalidCleanupProgress(checked, total, deleted) {
  invalidCleanupTask.checked = checked;
  invalidCleanupTask.total = total;
  invalidCleanupTask.deleted = deleted;
}

function setInvalidCleanupRunning(running) {
  invalidCleanupTask.running = running;
}

function isInvalidCleanupRunning() {
  return invalidCleanupTask.running;
}

module.exports = {
  // Scanning
  setSqliteDbPath,
  isFolderScanRunning,
  terminateScanWorkerSilently,
  clearPendingScanQueue,
  getScanQueueStatus,
  getWorkerScanProgress,
  enqueueScanTask,
  setMainWindowRef,
  setCatalogCacheCallbacks,
  setAutoScheduleCallbacks,
  yieldForPreviewPlaybackMs,

  // Thumbnail backfill
  getThumbnailBackfillProgress,
  getThumbnailBackfillFailedPathsForExport,
  resetThumbnailBackfillState,
  cancelCurrentThumbnailBackfill,
  isThumbnailBackfillRunning,
  setThumbnailBackfillRunning,
  setThumbnailBackfillProgress,
  incrementThumbnailBackfillSuccess,
  addThumbnailBackfillFailedPath,
  finishThumbnailBackfill,
  startThumbnailBackfill,

  // Duplicate hash detection
  getDuplicateHashProgress,
  resetDuplicateHashState,
  cancelCurrentDuplicateHash,
  isDuplicateHashRunning,
  setDuplicateHashRunning,
  setDuplicateHashProgress,
  finishDuplicateHash,
  startDuplicateHash,

  // Invalid cleanup
  getInvalidCleanupTaskProgress,
  setInvalidCleanupProgress,
  setInvalidCleanupRunning,
  isInvalidCleanupRunning,
};
