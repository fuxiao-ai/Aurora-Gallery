'use strict';

/**
 * 启动期一次性库迁移：缩略图补全查询索引 + `has_thumbnail` 标记修复。
 *
 * 两条硬约束，都是线上真跑出来的：
 *
 * 1) **数据修复只能跑一次。**
 *    `UPDATE photos SET has_thumbnail = 0 WHERE has_thumbnail = 1 AND thumbnail IS NULL`
 *    在 122 万张 / 12.9 GB 的真库上实测 76 秒——SQLite 会走 `idx_photos_hasThumb` 取到
 *    122 万行 rowid 再逐行回表读 `thumbnail`（冷缓存下每次都是随机读）。而它整段跑在一个
 *    写事务里，于是启动后 8 秒起跑的维护 worker 等满 `busy_timeout = 8000` 仍然抢不到锁，
 *    抛 `database is locked`；同一时刻 db-read-worker 队列被拖到 120 秒超时。
 *    现在用 `schema_migrations` 记一笔，这个库上跑过就不再跑，之后每次启动是 O(1)
 *    （一条主键命中的 SELECT）。
 *
 * 2) **真需要修时也不许长时间占写锁。**
 *    按 id 区间分批做**只读**候选扫描，只对命中的小批开写事务，批间让出事件循环。
 *    历史版本写入不一致的库照样能被修干净，但维护 / 读取再也不会被挡住几十秒。
 *
 * 关于报告：`CREATE INDEX IF NOT EXISTS` 命中已有索引时是零成本的，所以旧代码那句无条件的
 * 「created thumbnail missing indexes」纯属误导——它每次都打印，无论有没有建索引、花了多久。
 * 现在如实回报建了哪几个索引、扫了多少行、修了多少行、各花多久，日志要能直接回答
 * 「这次启动到底慢在哪一步」。
 */

var Database = require('better-sqlite3');
var worker_threads = require('worker_threads');
var workerData = worker_threads.workerData;

var dbPath = workerData && workerData.dbPath;
if (!dbPath) {
  process.exit(1);
}

/** 迁移键带版本与月份：将来若真的需要在这批库上重跑一次，改键名即可，不要清表。 */
var MARKER_KEY = 'thumbnail-flag-repair-2026-09';
var BATCH_ROWS = 20000;

var db = new Database(dbPath);
db.pragma('busy_timeout = 8000');

var started = Date.now();
var report = {
  indexesCreated: [],
  marker: '',
  scanned: 0,
  fixed: 0,
  batches: 0,
  elapsedMs: 0,
};

function post(payload) {
  try {
    worker_threads.parentPort.postMessage(payload);
  } catch (e) {
    void e;
  }
}

function hasTable(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function hasIndex(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

/** 只建真正缺的那个索引；已存在的连 SQL 都不执行，更不会记进报告。 */
function ensureIndexes() {
  if (!hasTable('photos')) return;
  var wanted = [
    [
      'idx_photos_id_hasThumb',
      'CREATE INDEX IF NOT EXISTS idx_photos_id_hasThumb ON photos(id, has_thumbnail)',
    ],
    [
      'idx_photos_missing_thumb',
      'CREATE INDEX IF NOT EXISTS idx_photos_missing_thumb ON photos(id) WHERE has_thumbnail = 0',
    ],
  ];
  for (var i = 0; i < wanted.length; i += 1) {
    if (hasIndex(wanted[i][0])) continue;
    db.exec(wanted[i][1]);
    report.indexesCreated.push(wanted[i][0]);
  }
}

function readMarker() {
  if (!hasTable('schema_migrations')) return '';
  var row = db.prepare('SELECT applied_at FROM schema_migrations WHERE key = ?').get(MARKER_KEY);
  return row ? String(row.applied_at) : '';
}

function writeMarker(note) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  db.prepare('INSERT OR REPLACE INTO schema_migrations (key, applied_at) VALUES (?, ?)').run(
    MARKER_KEY,
    new Date().toISOString() + '|' + note,
  );
}

/**
 * 分批只读扫描 + 小批写入。
 *
 * 用 `id > ? AND id <= ?` 的区间谓词，SQLite 能走 `idx_photos_hasThumb` 的
 * (has_thumbnail, rowid) 复合键做范围扫描，不会像 `ORDER BY id LIMIT n` 那样每批都重排一次。
 * 批次之间 `setTimeout(step, 0)` 让出——别的连接（维护 / 读取）在这段里能正常拿到锁。
 */
function repairFlags(done) {
  var bounds = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM photos').get() || {};
  // 空表时 MIN/MAX 是 NULL。**不能用 `!lo` 判断**——id 可以合法地等于 0，
  // 那样会把「表里有 id=0 的行」误判成空表，直接跳过整次修复（真跑出来过）。
  if (bounds.lo == null || bounds.hi == null) {
    done();
    return;
  }
  var lo = Number(bounds.lo);
  var hi = Number(bounds.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    done();
    return;
  }
  var pick = db.prepare(
    'SELECT id FROM photos WHERE id > ? AND id <= ? AND has_thumbnail = 1 AND thumbnail IS NULL',
  );
  var countRange = db.prepare('SELECT COUNT(*) AS n FROM photos WHERE id > ? AND id <= ?');
  var fixOne = db.prepare('UPDATE photos SET has_thumbnail = 0 WHERE id = ?');
  var fixBatch = db.transaction(function (ids) {
    for (var i = 0; i < ids.length; i += 1) fixOne.run(ids[i]);
  });

  // 谓词是 `id > cursor`，所以起点要退一格，否则 id 最小的那一行永远扫不到。
  var cursor = lo - 1;
  function step() {
    var end = Math.min(hi, cursor + BATCH_ROWS);
    report.batches += 1;
    report.scanned += Number(countRange.get(cursor, end).n) || 0;
    var rows = pick.all(cursor, end);
    if (rows.length) {
      fixBatch(
        rows.map(function (row) {
          return row.id;
        }),
      );
      report.fixed += rows.length;
    }
    cursor = end;
    if (cursor >= hi) {
      done();
      return;
    }
    setTimeout(step, 0);
  }
  step();
}

function finish() {
  writeMarker(report.fixed ? 'repaired:' + report.fixed : 'clean');
  report.marker = 'written';
  report.elapsedMs = Date.now() - started;
  post(report);
  db.close();
  process.exit(0);
}

try {
  ensureIndexes();
  var appliedAt = readMarker();
  if (appliedAt) {
    // 已经修过：一次主键查询就结束，不扫任何一行。
    report.marker = 'already-applied';
    report.appliedAt = appliedAt;
    report.elapsedMs = Date.now() - started;
    post(report);
    db.close();
    process.exit(0);
  }
  repairFlags(finish);
} catch (error) {
  report.failed = true;
  report.error = error && error.message ? error.message : String(error);
  report.elapsedMs = Date.now() - started;
  post(report);
  try {
    db.close();
  } catch (e) {
    void e;
  }
  process.exit(0);
}
