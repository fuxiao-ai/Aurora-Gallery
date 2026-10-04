'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const PhotoDatabase = require('../src/database');
const pool = require('../src/db-read-worker-pool');
const { runDatabaseMaintenance } = require('../src/main/database-maintenance');
const WebServer = require('../src/web-server');
const { EventEmitter } = require('node:events');

/** 递归列出 src/ 下的全部 .js（静态契约用；故意不引第三方依赖）。 */
function walkJsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkJsFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

/** 直接跑启动期那个一次性迁移 worker，拿它的报告。 */
function runThumbnailFixWorker(dbPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      path.join(__dirname, '..', 'src', 'workers', 'thumbnail-fix-worker.js'),
      { workerData: { dbPath } },
    );
    let report = null;
    worker.on('message', (message) => {
      report = message;
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (!report) reject(new Error('thumbnail-fix worker exited without a report: ' + code));
      else resolve(report);
    });
  });
}

async function removeTemporaryDirectory(directory) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-maintenance-test-'));
  const dbPath = path.join(directory, 'photos.db');
  let db;
  try {
    db = new PhotoDatabase(dbPath);
    const root = db.addRootFolder('C:\\test');
    db.insertPhoto({
      rootId: root,
      folderPath: 'C:\\test\\child',
      fileName: 'one.jpg',
      filePath: 'C:\\test\\child\\one.jpg',
      fileSize: 1,
      fileType: 'jpg',
      width: 1,
      height: 1,
      dateTaken: '2026-01-01 10:00:00',
      dateModified: '2026-01-01 10:00:00',
      thumbnail: Buffer.from([1]),
      hasThumbnail: 1,
    });
    db.db.exec('UPDATE photos SET has_thumbnail = 0');
    const result = await runDatabaseMaintenance(dbPath, 'rebuildThumbnailFlags');
    assert.equal(result.missing, 0);
    assert.equal(db.db.prepare('SELECT has_thumbnail FROM photos').get().has_thumbnail, 1);
    assert.equal((await runDatabaseMaintenance(dbPath, 'optimizeDatabase')).success, true);
    assert.equal(db.isFtsIndexReady(), false);
    assert.equal((await runDatabaseMaintenance(dbPath, 'ensureFtsIndex')).rebuilt, true);
    assert.equal(db.isFtsIndexReady(), true);
    assert.equal((await runDatabaseMaintenance(dbPath, 'ensureFtsIndex')).skipped, true);
    db.db.prepare("UPDATE photos SET file_name = 'updated.jpg'").run();
    assert.equal(db.searchPhotos('updated').total, 1, 'triggers keep the completed index current');
    db.db.prepare("UPDATE photos SET file_name = 'one.jpg'").run();
    await assert.rejects(runDatabaseMaintenance(dbPath, 'invalid'), /Unknown maintenance/);
    for (const [operation, options] of [
      ['getPhotos', {}],
      ['getFolderPhotos', { folderPath: 'C:\\test' }],
      ['searchPhotos', { query: 'one' }],
      ['getDatePhotos', { dateStr: '2026-01-01' }],
    ]) {
      const value = await pool.run(dbPath, operation, options);
      assert.equal(value.total, 1, operation);
    }
    for (const [handler, query] of [
      ['handlePhotos', {}],
      ['handleFolderPhotos', { path: 'C:\\test' }],
      ['handleSearch', { q: 'one' }],
      ['handleDatePhotos', { date: '2026-01-01' }],
    ]) {
      const response = await new Promise((resolve) => {
        const server = Object.create(WebServer.prototype);
        server.sqliteReadPath = dbPath;
        server.jsonResponse = (_res, data, status) => resolve({ data, status });
        server[handler]({}, new EventEmitter(), query);
      });
      assert.equal(response.status, 200, handler);
      assert.equal(response.data.total, 1, handler);
    }

    // ---------- 启动期一次性迁移 worker ----------
    // 真库上 `UPDATE ... WHERE has_thumbnail = 1 AND thumbnail IS NULL` 实测 76 秒，且整段
    // 跑在一个写事务里 —— 维护 worker 等满 busy_timeout=8000 必然失败（线上报的
    // `database is locked`）。所以它必须「修过一次就再也不跑」，这两条是守住这件事的。
    //
    // 顺手插一行 id = 0：曾经的写法用 `if (!lo)` 判空表，而 id 可以合法地等于 0，
    // 于是 MIN(id)=0 的库会被误判成空表、整次修复被静默跳过（真跑出来过）。
    db.db.exec(
      'INSERT INTO photos (id, root_id, folder_path, file_name, file_path, file_size, file_type, thumbnail, has_thumbnail) ' +
        'VALUES (0, ' +
        root +
        ", 'C:\\test', 'zero.jpg', 'C:\\test\\zero.jpg', 1, 'jpg', NULL, 1)",
    );
    const corrupted = db.db
      .prepare('UPDATE photos SET has_thumbnail = 1, thumbnail = NULL')
      .run().changes;
    const firstFix = await runThumbnailFixWorker(dbPath);
    assert.equal(firstFix.failed, undefined, '首次迁移不许失败');
    assert.equal(firstFix.fixed, corrupted, '「有标记但没缩略图」的脏数据要全被修掉');
    assert.equal(firstFix.marker, 'written', '修完要把「干过了」落到库里');
    assert.ok(firstFix.batches >= 1, '必须真的开过批次（MIN(id)=0 也不能被当成空表跳过）');
    assert.ok(firstFix.scanned >= corrupted, '扫过的行数不能比表里的行数少');
    assert.equal(
      db.db
        .prepare('SELECT COUNT(*) AS n FROM photos WHERE has_thumbnail = 1 AND thumbnail IS NULL')
        .get().n,
      0,
      '修完 has_thumbnail 必须与 thumbnail IS NULL 一致',
    );
    assert.deepEqual(
      firstFix.indexesCreated.slice().sort(),
      ['idx_photos_id_hasThumb', 'idx_photos_missing_thumb'],
      '两个缩略图查询索引第一次要真建出来',
    );

    const secondFix = await runThumbnailFixWorker(dbPath);
    assert.equal(secondFix.marker, 'already-applied', '第二次必须走「已修过」分支直接退出');
    assert.equal(secondFix.scanned, 0, '第二次一行都不许扫（这才是 O(1)）');
    assert.equal(secondFix.batches, 0, '第二次一批都不许开');
    assert.deepEqual(secondFix.indexesCreated, [], '索引已存在就不许再报「建了索引」');
    assert.ok(secondFix.elapsedMs < firstFix.elapsedMs, '已修过的分支必须更快');

    // ── 延迟索引只有一份定义（上一轮遗留的「同一批索引两个真相源」） ────────────
    // `src/database.js` 里曾有一组零调用的主线程同步版：applyDeferredPhotoIndexes() 及其三个
    // ensurePhotos* 子方法，SQL 与 src/workers/deferred-index-worker.js 逐字重复。两个真相源
    // 改一处必漏另一处，而且谁把主线程那份接上去，就等于在启动路径上跑几次大表 CREATE INDEX
    // 并长时间独占写锁。已于 2026-09-29 删除，这里钉住它别再回来。
    const dbSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf8');
    // 看的是「方法定义」而不是「出现过这个名字」——database.js 里留着一段说明它们为何被删的注释。
    for (const gone of [
      'applyDeferredPhotoIndexes',
      'ensurePhotosRootFolderCompositeIndex',
      'ensurePhotosAggPartialIndexes',
      'ensurePhotosDupHashPendingIndex',
    ]) {
      assert.ok(
        !new RegExp('^\\s*' + gone + '\\s*\\(', 'm').test(dbSource),
        `${gone} 不许再在 src/database.js 定义：零调用 + 与 deferred-index-worker 重复定义`,
      );
    }
    const workerSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'workers', 'deferred-index-worker.js'),
      'utf8',
    );
    for (const indexName of [
      'idx_photos_folder_nocase',
      'idx_photos_agg_root_folder_image',
      'idx_photos_agg_root_folder_video',
      'idx_photos_dup_hash_pending',
    ]) {
      assert.ok(
        workerSource.includes(indexName),
        `延迟索引 ${indexName} 的定义必须在 deferred-index-worker 里（那是唯一真相源）`,
      );
      const offenders = [];
      for (const file of walkJsFiles(path.join(__dirname, '..', 'src'))) {
        if (file.endsWith(path.join('workers', 'deferred-index-worker.js'))) continue;
        if (fs.readFileSync(file, 'utf8').includes('CREATE INDEX IF NOT EXISTS ' + indexName)) {
          offenders.push(path.relative(path.join(__dirname, '..'), file));
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `${indexName} 的 CREATE INDEX 只许在 deferred-index-worker 里出现，实际还有：${offenders.join(', ')}`,
      );
    }

    console.log('[maintenance-regression] PASS');
  } finally {
    pool.terminate();
    if (db) db.close();
    // Worker termination closes its read handles asynchronously on Windows.
    await removeTemporaryDirectory(directory);
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
