'use strict';

var Database = require('better-sqlite3');
var worker_threads = require('worker_threads');
var workerData = worker_threads.workerData;

var dbPath = workerData && workerData.dbPath;
if (!dbPath) {
  process.exit(1);
}

var db = new Database(dbPath);
db.pragma('busy_timeout = 8000');

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_id_hasThumb ON photos(id, has_thumbnail)');
} catch (e) {
  void e;
}
try {
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_missing_thumb ON photos(id) WHERE has_thumbnail = 0',
  );
} catch (e) {
  void e;
}

var update = db.prepare(
  'UPDATE photos SET has_thumbnail = 0 WHERE has_thumbnail = 1 AND thumbnail IS NULL',
);
var r = update.run();

worker_threads.parentPort.postMessage({ changes: r.changes });

db.close();
process.exit(0);
