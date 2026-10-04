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

var results = {};

// Phase 0: root_folder composite index
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_root_folder ON photos(root_id, folder_path)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_folder_nocase ON photos(folder_path COLLATE NOCASE)');
  results.phase0 = 'ok';
} catch (e) {
  results.phase0 = e && e.message ? e.message : String(e);
}

// Phase 1: aggregation partial indexes (image/video)
var imgPred =
  "lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
var vidPred =
  "lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
try {
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_image ON photos(root_id, folder_path) WHERE ' +
      imgPred,
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_video ON photos(root_id, folder_path) WHERE ' +
      vidPred,
  );
  results.phase1 = 'ok';
} catch (e) {
  results.phase1 = e && e.message ? e.message : String(e);
}

// Phase 2: duplicate hash pending index (needs hash columns first)
try {
  try { db.exec('ALTER TABLE photos ADD COLUMN file_hash TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN hash_mtime TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN hash_size INTEGER'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash)'); } catch (e) { void e; }

  var pending = "(file_hash IS NULL OR TRIM(file_hash) = '')";
  var img = '(' + imgPred + ')';
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_photos_dup_hash_pending ON photos(id) WHERE ' +
      pending +
      ' AND ' +
      img,
  );
  results.phase2 = 'ok';
} catch (e) {
  results.phase2 = e && e.message ? e.message : String(e);
}

// Phase 3: EXIF metadata columns
try {
  try { db.exec('ALTER TABLE photos ADD COLUMN camera_make TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN camera_model TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN lens_model TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN focal_length REAL'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN aperture REAL'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN iso_speed INTEGER'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN shutter_speed TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN gps_latitude REAL'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE photos ADD COLUMN gps_longitude REAL'); } catch (e) { void e; }
  results.phase3 = 'ok';
} catch (e) {
  results.phase3 = e && e.message ? e.message : String(e);
}

worker_threads.parentPort.postMessage(results);

db.close();
process.exit(0);
