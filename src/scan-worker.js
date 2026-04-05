/**
 * 在独立 Worker 线程中执行文件夹扫描，避免占满主进程事件循环导致前端卡顿。
 * 使用与主进程相同的数据库路径（WAL 下可并发读；扫描内部分批 COMMIT 缩短写锁）。
 */
const { parentPort, workerData } = require('worker_threads');
const Database = require('./database');
const Scanner = require('./scanner');

function rebuildScanOptions(data) {
  var names = data && Array.isArray(data.skipDirNames) ? data.skipDirNames : [];
  var set = new Set();
  for (var i = 0; i < names.length; i++) {
    set.add(String(names[i]).toLowerCase());
  }
  return {
    followSymlinks: !!(data && data.followSymlinks),
    maxDepth: data && parseInt(data.maxDepth, 10) >= 0 ? parseInt(data.maxDepth, 10) : 0,
    skipDirNameSet: set,
    includeRaw: !data || data.includeRaw !== false,
    diskProfile: data && data.diskProfile ? String(data.diskProfile).toLowerCase() : 'auto',
    ioThrottleMs: data && parseInt(data.ioThrottleMs, 10) > 0 ? parseInt(data.ioThrottleMs, 10) : 0,
  };
}

var scanner = null;

parentPort.on('message', function (msg) {
  if (!scanner || !msg || !msg.type) return;
  if (msg.type === 'cancel') scanner.cancelScan();
  else if (msg.type === 'pause') scanner.pauseScan();
  else if (msg.type === 'resume') scanner.resumeScan();
});

(async function () {
  var wd = workerData;
  if (!wd || !wd.dbPath || !wd.rootPath) {
    parentPort.postMessage({
      type: 'done',
      cancelled: false,
      finalProgress: {
        status: 'error',
        current: 0,
        total: 0,
        currentFile: '',
        error: 'invalid workerData',
      },
      error: 'invalid workerData',
    });
    return;
  }

  var db;
  try {
    db = new Database(wd.dbPath);
  } catch (e) {
    parentPort.postMessage({
      type: 'done',
      cancelled: false,
      finalProgress: { status: 'error', current: 0, total: 0, currentFile: '' },
      error: e && e.message ? e.message : String(e),
    });
    return;
  }

  var scanOpts = rebuildScanOptions(wd.scanOptions);
  var thumbOpts =
    wd.thumbOptions && typeof wd.thumbOptions === 'object'
      ? wd.thumbOptions
      : { size: 256, quality: 75 };

  scanner = new Scanner(db, {
    getThumbOptions: function () {
      return thumbOpts;
    },
    getScanOptions: function () {
      return scanOpts;
    },
  });

  var iv = setInterval(function () {
    try {
      if (scanner) {
        parentPort.postMessage({ type: 'progress', p: scanner.getProgress() });
      }
    } catch (e) {}
  }, 300);

  try {
    var scanResult = await scanner.scanFolder(wd.rootPath);
    var fp = scanner.getProgress();
    var cancelled = fp.status === 'cancelled';
    parentPort.postMessage({
      type: 'done',
      cancelled: cancelled,
      finalProgress: fp,
      scanResult: scanResult || null,
      error: null,
    });
  } catch (err) {
    var fp2 = scanner
      ? scanner.getProgress()
      : { status: 'error', current: 0, total: 0, currentFile: '' };
    fp2.status = 'error';
    fp2.error = err && err.message ? err.message : String(err);
    parentPort.postMessage({
      type: 'done',
      cancelled: false,
      finalProgress: fp2,
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    clearInterval(iv);
    scanner = null;
    try {
      db.close();
    } catch (e2) {}
  }
})();
