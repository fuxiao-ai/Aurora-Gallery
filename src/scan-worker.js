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

  console.log('[scan-worker] init root=' + wd.rootPath);
  var db;
  try {
    db = new Database(wd.dbPath);
    console.log('[scan-worker] db.open ok');
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
    /**
     * 阶段自报（scanner 在进入每个长阶段前调一次）。
     *
     * 两条用途，缺一不可：
     * ① 它是一条**真实消息**，主进程侧的心跳看门狗据此重置安静计时 —— 于是看门狗量的是
     *    「每个阶段各自多久」而不是「整段扫描多久」；
     * ② 万一还是被终止，错误信息里能说出卡在哪一步（`main.js#SCAN_PHASE_LABELS`）。
     * 注意它**不能**替代 scanner 侧的按批让出：线程真被同步代码占住时这里也发不出去。
     */
    onPhase: function (name) {
      try {
        parentPort.postMessage({ type: 'phase', name: String(name) });
      } catch (e) {}
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
    console.log('[scan-worker] scan.start root=' + wd.rootPath);
    var scanResult = await scanner.scanFolder(wd.rootPath);
    var fp = scanner.getProgress();
    var cancelled = fp.status === 'cancelled';
    console.log('[scan-worker] scan.done status=' + fp.status + ' current=' + fp.current + ' total=' + fp.total);
    parentPort.postMessage({
      type: 'done',
      cancelled: cancelled,
      finalProgress: fp,
      scanResult: scanResult || null,
      error: null,
    });
  } catch (err) {
    console.error('[scan-worker] scan.error', err && err.message ? err.message : String(err));
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
