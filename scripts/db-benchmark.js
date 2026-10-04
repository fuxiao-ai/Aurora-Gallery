'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const assert = require('node:assert/strict');
const pool = require('../src/db-read-worker-pool');
const { runDatabaseMaintenance } = require('../src/main/database-maintenance');

async function measure(operation) {
  let previous = performance.now();
  let maxDelay = 0;
  let peakRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelay = Math.max(maxDelay, now - previous - 10);
    previous = now;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  const started = performance.now();
  try {
    await operation();
    const elapsedMs = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      elapsedMs: Math.round(elapsedMs),
      maxEventLoopDelayMs: Math.round(maxDelay),
      peakProcessRssMb: Math.round(peakRss / 1024 / 1024),
    };
  } finally {
    clearInterval(timer);
  }
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-benchmark-'));
  const dbPath = path.join(directory, 'synthetic.db');
  const db = new Database(dbPath);
  const results = [];
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE photos (
      id INTEGER PRIMARY KEY, root_id INTEGER, file_name TEXT, file_path TEXT,
      folder_path TEXT, file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER,
      date_taken TEXT, date_modified TEXT, thumbnail BLOB, has_thumbnail INTEGER, is_favorite INTEGER
    ); CREATE INDEX idx_photos_folder ON photos(folder_path);
    CREATE INDEX idx_photos_date ON photos(date_taken);`);
    let previousSize = 0;
    for (const size of [100000, 1000000]) {
      db.prepare(
        `WITH RECURSIVE seq(n) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT n+1 FROM seq WHERE n < ?
      ) INSERT INTO photos SELECT n, 1, n || '.jpg', 'C:/photos/' || n || '.jpg',
        'C:/photos/child' || (n % 100) || '/deep', 1024, 'jpg', 100, 100,
        '2026-01-' || printf('%02d', (n % 28)+1) || ' 10:00:00',
        '2026-01-01 10:00:00', NULL, 0, 0 FROM seq`,
      ).run(previousSize + 1, size);
      previousSize = size;
      for (const [name, operation, options] of [
        ['date', 'getDatePhotos', { dateStr: '2026-01-01' }],
        ['firstPage', 'getPhotos', { page: 1 }],
        ['deepPage', 'getPhotos', { page: size / 100 }],
        ['childCovers', 'getImmediateSubfolderCovers', { parentPath: 'C:/photos/child1' }],
      ]) {
        results.push({
          rows: size,
          name,
          ...(await measure(async () => {
            const result = await pool.run(dbPath, operation, options);
            if (name === 'childCovers') assert.equal(result[0].folder_photo_count, size / 100);
            else assert.equal(result.photos.length, 100);
          })),
        });
      }
      results.push({
        rows: size,
        name: 'vacuum',
        ...(await measure(() => runDatabaseMaintenance(dbPath, 'optimizeDatabase'))),
      });
      if (size === 1000000) {
        const explain = () =>
          db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT id FROM photos WHERE folder_path LIKE ? ESCAPE '\\'",
            )
            .all('C:/photos/child1/%')
            .map((row) => row.detail);
        const before = explain();
        db.exec('CREATE INDEX idx_photos_folder_nocase ON photos(folder_path COLLATE NOCASE)');
        results.push({
          rows: size,
          name: 'childCoversWithPrefixIndex',
          beforePlan: before,
          afterPlan: explain(),
          ...(await measure(async () => {
            const result = await pool.run(dbPath, 'getImmediateSubfolderCovers', {
              parentPath: 'C:/photos/child1',
            });
            assert.equal(result[0].folder_photo_count, size / 100);
          })),
        });
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      description:
        'Synthetic metadata only; excludes images, network, UI rendering and scanning. RSS includes workers.',
      results,
    };
    fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, '..', 'docs', 'performance-results.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    pool.terminate();
    db.close();
    // rm retries account for asynchronous Worker termination on Windows.
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
