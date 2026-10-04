'use strict';

const dbReadWorkerPool = require('./db-read-worker-pool');

/** Heavy reads stay in the bounded worker pool; failures propagate to the caller. */
function runDbReadWorkerOnly(readPath, op, options, control) {
  if (!readPath || typeof readPath !== 'string') {
    return Promise.reject(new Error('db-read: missing readPath'));
  }
  return dbReadWorkerPool.run(readPath, op, options || {}, control);
}

module.exports = { runDbReadWorkerOnly };
