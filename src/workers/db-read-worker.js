'use strict';

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const heavy = require('../db-heavy-read');

var db = null;

function openDb() {
  if (db) return db;
  var p = workerData && workerData.dbPath;
  if (!p || typeof p !== 'string') {
    throw new Error('db-read-worker: missing dbPath');
  }
  db = new Database(p, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 8000');
  return db;
}

parentPort.on('message', function (msg) {
  var id = msg && msg.id;
  try {
    var database = openDb();
    var result;
    if (msg.op === 'getRootFolders') {
      var rfOpts = msg.options || {};
      result =
        rfOpts.lite === true
          ? heavy.runGetRootFoldersLite(database)
          : heavy.runGetRootFoldersAgg(database, rfOpts);
    } else if (msg.op === 'getStats') {
      result = heavy.runGetStatsAgg(database);
    } else if (msg.op === 'getFolderTree') {
      result = heavy.runGetFolderTree(database, msg.options && msg.options.rootId);
    } else if (msg.op === 'getFolderCovers') {
      result = heavy.runGetFolderCovers(database, msg.options || {});
    } else if (msg.op === 'getDateGroups') {
      result = heavy.runGetDateGroups(database, msg.options || {});
    } else if (msg.op === 'getDatePhotos') {
      var dp = msg.options || {};
      result = heavy.runGetDatePhotos(database, dp.dateStr, dp);
    } else if (msg.op === 'getHashAllPhotoCount') {
      result = heavy.runGetHashAllPhotoCount(database);
    } else if (msg.op === 'getDuplicateGroupCountByHash') {
      var og = msg.options || {};
      result = heavy.runGetDuplicateGroupCountByHash(database, og.minCount);
    } else if (msg.op === 'getDuplicatePhotoCountByHash') {
      var op = msg.options || {};
      result = heavy.runGetDuplicatePhotoCountByHash(database, op.minCount);
    } else if (msg.op === 'getDuplicateHashGroupsBundle') {
      result = heavy.runGetDuplicateHashGroupsBundle(database, msg.options || {});
    } else {
      throw new Error('db-read-worker: unknown op ' + String(msg && msg.op));
    }
    parentPort.postMessage({ id: id, ok: true, result: result });
  } catch (e) {
    parentPort.postMessage({
      id: id,
      ok: false,
      error: e && e.message ? e.message : String(e),
    });
  }
});
