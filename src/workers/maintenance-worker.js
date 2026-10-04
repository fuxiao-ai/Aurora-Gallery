'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const PhotoDatabase = require('../database');

let db;
try {
  if (!['optimizeDatabase', 'rebuildThumbnailFlags', 'ensureFtsIndex'].includes(workerData.operation)) {
    throw new Error('Unknown maintenance operation');
  }
  db = new Database(workerData.dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 8000');
  // Reuse maintenance SQL without running schema initialization on a second connection.
  const result = PhotoDatabase.prototype[workerData.operation].call({ db });
  db.close();
  db = null;
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  if (db) db.close();
}
