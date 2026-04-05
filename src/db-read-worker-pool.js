'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

/** 并发只读连接数（WAL 下多读者安全）。侧栏并行 getFolderTree 与 lite=no 的全量根目录统计共用单队列时会串行排队数十秒。 */
var POOL_SIZE = 3;

var workers = [];
var dbPathCached = '';
var pending = Object.create(null);
var nextId = 1;
var jobQueue = [];

function rejectAllPending(reason) {
  Object.keys(pending).forEach(function (k) {
    try {
      pending[k].reject(reason);
    } catch (e) {
      void e;
    }
    delete pending[k];
  });
}

function findIdleSlot() {
  var i;
  for (i = 0; i < workers.length; i++) {
    var s = workers[i];
    if (s && s.worker && !s.busy) return s;
  }
  return null;
}

function trySendNext() {
  while (jobQueue.length > 0) {
    var slot = findIdleSlot();
    if (!slot) return;
    var job = jobQueue.shift();
    slot.busy = true;
    pending[job.id] = { resolve: job.resolve, reject: job.reject, slot: slot };
    slot.worker.postMessage({ id: job.id, op: job.op, options: job.options });
  }
}

function attachSlotHandlers(slot) {
  slot.worker.on('message', function (m) {
    slot.busy = false;
    var p = pending[m.id];
    delete pending[m.id];
    if (p) {
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || 'db-read-worker error'));
    }
    trySendNext();
  });
  slot.worker.on('error', function (err) {
    slot.busy = false;
    rejectAllPending(err);
    trySendNext();
  });
}

function rejectQueuedJobs(reason) {
  while (jobQueue.length > 0) {
    var j = jobQueue.shift();
    try {
      j.reject(reason);
    } catch (e) {
      void e;
    }
  }
}

function destroyPool() {
  var i;
  for (i = 0; i < workers.length; i++) {
    var s = workers[i];
    if (s && s.worker) {
      try {
        s.worker.terminate();
      } catch (e) {
        void e;
      }
    }
  }
  workers = [];
}

function ensureWorker(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('db-read-worker-pool: invalid dbPath');
  }
  if (workers.length === POOL_SIZE && dbPathCached === dbPath) return;

  destroyPool();
  rejectAllPending(new Error('db worker restarted'));
  rejectQueuedJobs(new Error('db worker restarted'));
  dbPathCached = dbPath;

  var workerPath = path.join(__dirname, 'workers', 'db-read-worker.js');
  var j;
  for (j = 0; j < POOL_SIZE; j++) {
    var w = new Worker(workerPath, {
      workerData: { dbPath: dbPath },
    });
    var slot = { worker: w, busy: false };
    attachSlotHandlers(slot);
    workers.push(slot);
  }
  trySendNext();
}

/**
 * 与连接池无关的单次只读任务：池 job 失败或队列异常时再用，避免退回主进程跑大查询。
 */
function runOneshot(dbPath, op, options) {
  return new Promise(function (resolve, reject) {
    if (!dbPath || typeof dbPath !== 'string') {
      reject(new Error('db-read-worker-pool: invalid dbPath'));
      return;
    }
    var workerPath = path.join(__dirname, 'workers', 'db-read-worker.js');
    var w = new Worker(workerPath, {
      workerData: { dbPath: dbPath },
    });
    var settled = false;
    function finish(err, result) {
      if (settled) return;
      settled = true;
      try {
        w.removeAllListeners('message');
        w.removeAllListeners('error');
        w.terminate();
      } catch (e) {
        void e;
      }
      if (err) reject(err);
      else resolve(result);
    }
    w.on('message', function (m) {
      if (m && m.ok) finish(null, m.result);
      else finish(new Error((m && m.error) || 'db-read-worker error'));
    });
    w.on('error', function (err) {
      finish(err);
    });
    w.postMessage({ id: 1, op: op, options: options || {} });
  });
}

/**
 * 在独立线程执行只读重查询，主进程可继续响应窗口与 IPC。
 */
function run(dbPath, op, options) {
  return new Promise(function (resolve, reject) {
    try {
      ensureWorker(dbPath);
      var id = nextId++;
      jobQueue.push({
        id: id,
        op: op,
        options: options || {},
        resolve: resolve,
        reject: reject,
      });
      trySendNext();
    } catch (e) {
      reject(e);
    }
  });
}

function terminate() {
  destroyPool();
  dbPathCached = '';
  rejectQueuedJobs(new Error('db worker terminated'));
  rejectAllPending(new Error('db worker terminated'));
}

module.exports = {
  run: run,
  runOneshot: runOneshot,
  terminate: terminate,
};
