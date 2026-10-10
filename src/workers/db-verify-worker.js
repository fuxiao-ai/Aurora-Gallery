'use strict';

/**
 * 副本校验 —— **跑在独立线程里**的那一半（只取数，判定交给 `data-dir.js#judgeCopy`）。
 *
 * 🔴 **为什么必须离开主线程**：唯一能查 b-tree 结构的一道是 `PRAGMA quick_check`，
 *    而它要把整个库读完。真库实测（18,345,889,792 字节 / 4,478,977 页）**318,948 ms
 *    ≈ 5 分 19 秒**。放在主进程里同步跑 ⇒ 这 5 分钟里主线程一点动不了、进度事件一条都发不出去、
 *    窗口被系统标成「无响应」。用户报的「正在检查新位置的数据时卡死」就是这个 ——
 *    **它不是死锁，是主线程被一个纯 I/O 长任务占住**（见 CLAUDE.md 的
 *    「Critical: Main Thread Blocking Issues」）。
 *
 * ⚠️ 顺带把最便宜的那道放最前面：`page_count × page_size` 与文件大小一比，
 *    真库实测 **103 ms** 就能判出「复制被截断」，而截断恰恰是最可能的那种坏
 *    （复制中断、目标盘写满）。等于花一毫秒，挡掉最常见的一类。
 *
 * 只读打开：**绝不改副本任何一个字节**（判据是「这份文件能不能当主库用」，
 * 校验动作本身不许成为变量）。
 */

const { parentPort, workerData } = require('worker_threads');
const dataDirLib = require('../main/data-dir');

var dbPath = workerData && workerData.dbPath;
var expectPhotoCount =
  workerData && workerData.expectPhotoCount != null ? workerData.expectPhotoCount : null;

function post(msg) {
  try {
    parentPort.postMessage(msg);
  } catch (e) {
    void e;
  }
}

function finish(payload) {
  post(payload);
  // 自己退：主进程那边只等一条结果消息，不依赖 exit 事件（免得两头都等对方）
  process.exit(0);
}

var t0 = Date.now();
var Sqlite;
try {
  Sqlite = require('better-sqlite3');
} catch (e) {
  finish({
    ok: false,
    code: 'NO_SQLITE',
    error: '无法检查新位置的数据（数据库组件不可用）：' + (e && e.message ? e.message : e),
  });
  return;
}

var handle = null;
try {
  var header = dataDirLib.readSqliteHeader(dbPath);
  var headerMs = Date.now() - t0;

  /**
   * 🔴 **截断就先判死，别再去打开、更别去读那 5 分钟**。这条不是为了快，是为了
   *    「同一份坏副本不要花两次 18 GB 的 I/O 才发现它坏」—— 复制本身已经读过一遍了。
   *    而且被截断的库往往连 `new Database()` 都开不了，只靠 open 的话报出来的是
   *    「文件打不开」，用户看不出是「没拷完」。
   *    ⚠️ 这一步用 `judgeCopySize`（只管截断），**不是** `judgeCopy` —— 后者见到
   *    「结构检查还没做」会判 CORRUPT，拿它当预检会把每个好副本都判死。
   */
  var pre = dataDirLib.judgeCopySize(header.fileSize, header.declaredBytes);
  if (pre && !pre.ok) {
    finish({
      ok: false,
      code: pre.code,
      error: pre.error,
      fileSize: header.fileSize,
      declaredBytes: header.declaredBytes,
      headerMs: headerMs,
      elapsedMs: Date.now() - t0,
    });
  } else {
    post({
      __phase: 'judge.started',
      headerMs: headerMs,
      fileSize: header.fileSize,
      declaredBytes: header.declaredBytes,
      headerOk: header.ok,
      headerReason: header.reason || '',
    });

    handle = new Sqlite(dbPath, { readonly: true, fileMustExist: true });

    var tQuick = Date.now();
    var row = handle.pragma('quick_check');
    var verdict = row && row[0] ? String(row[0].quick_check) : '';
    var quickCheckMs = Date.now() - tQuick;

    var tCount = Date.now();
    var countRow = handle.prepare('SELECT COUNT(*) AS n FROM photos').get();
    var photoCount = Number(countRow && countRow.n) || 0;
    var countMs = Date.now() - tCount;

    var judged = dataDirLib.judgeCopy({
      verdict: verdict,
      photoCount: photoCount,
      expectPhotoCount: expectPhotoCount,
      fileSize: header.fileSize,
      declaredBytes: header.declaredBytes,
    });
    finish({
      ok: !!judged.ok,
      code: judged.code,
      error: judged.error,
      photoCount: judged.photoCount,
      verdict: verdict,
      fileSize: header.fileSize,
      declaredBytes: header.declaredBytes,
      headerMs: headerMs,
      quickCheckMs: quickCheckMs,
      countMs: countMs,
      elapsedMs: Date.now() - t0,
    });
  }
} catch (e) {
  finish({
    ok: false,
    code: 'UNREADABLE',
    error: '新位置的数据文件打不开：' + (e && e.message ? e.message : e),
    elapsedMs: Date.now() - t0,
  });
} finally {
  if (handle) {
    try {
      handle.close();
    } catch (e2) {
      void e2;
    }
  }
}
