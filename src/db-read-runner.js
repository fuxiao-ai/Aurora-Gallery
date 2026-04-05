'use strict';

const dbReadWorkerPool = require('./db-read-worker-pool');

/**
 * 只读重查询固定落在 Worker：连接池失败后 oneshot 再试，不在主进程跑 better-sqlite3 同步大查询。
 */
function runDbReadWorkerOnly(readPath, op, options) {
  if (!readPath || typeof readPath !== 'string') {
    return Promise.reject(new Error('db-read: missing readPath'));
  }
  var opts = options || {};
  return dbReadWorkerPool.run(readPath, op, opts).catch(function () {
    return dbReadWorkerPool.runOneshot(readPath, op, opts);
  });
}

module.exports = {
  runDbReadWorkerOnly: runDbReadWorkerOnly,
};
