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
    // 延迟索引 DDL 有**两个合法家**（Phase 4 直接写在 worker 里；Phase 5 抽到
    // `src/main/deferred-indexes.js` 供回归复用同一份字符串，见那个文件开头）。
    // 两者之外的**任何** `src/` 文件出现同一条 DDL 都是问题：那是把大表建索引搬回启动路径。
    const DEFERRED_HOMES = [
      path.join('workers', 'deferred-index-worker.js'),
      path.join('main', 'deferred-indexes.js'),
    ];
    const phase5Source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'deferred-indexes.js'),
      'utf8',
    );
    // 🔴 这条「只许定义在延迟索引那一侧」的检查必须带**词边界**，不能用裸 `includes`。
    // 反例是现成的、而且一加索引就会撞上：`idx_photos_root_date` 是
    // `idx_photos_root_date_mod` 的**前缀**，而后者由 `database.js#createCoreSchema` 建
    // ⇒ 裸 `includes('CREATE INDEX IF NOT EXISTS idx_photos_root_date')` 会在
    // database.js 里命中那一行，报出「src/database.js 也建了这个索引」的**假红**。
    // （反向也危险：假红会被人用「把名字改长一点」绕过，而不是把索引搬回 worker。）
    // 下面那条哨兵断言就是钉住「\b 真的在起作用」，别哪天被顺手改回 includes。
    assert.ok(
      !new RegExp('CREATE INDEX IF NOT EXISTS ' + 'idx_photos_root_date' + '\\b').test(
        'CREATE INDEX IF NOT EXISTS idx_photos_root_date_mod ON photos(root_id, date_modified);',
      ),
      '哨兵：词边界的 `idx_photos_root_date\\b` 不许命中 `idx_photos_root_date_mod`（否则下面全是假红）',
    );
    for (const indexName of [
      'idx_photos_folder_nocase',
      'idx_photos_agg_root_folder_image',
      'idx_photos_agg_root_folder_video',
      'idx_photos_dup_hash_pending',
      // 2026-10-06 加的两条只读大查询覆盖/排序索引（见 deferred-index-worker 的 Phase 4）。
      // 一并登记在这里：它们同样是「大表 CREATE INDEX」，一旦被谁搬回启动路径
      // （比如有人在 main 里顺手补一条），代价是拿主进程独占写锁跑几分钟。
      'idx_photos_root_folder_date',
      'idx_photos_root_date',
      // Phase 5（`src/main/deferred-indexes.js`，DDL 只有一个真相源、worker 与回归共用）。
      // 原先这五条**没有登记**——因为这条守保护的是 worker 源码，而 Phase 5 的字面量在
      // `deferred-indexes.js` 里；补登记之后「Phase 5 全批也不许搬回启动路径」才真的被守住。
      'idx_photos_root_name',
      'idx_photos_root_size',
      'idx_photos_dup_hash_full',
      'idx_photos_date_day',
      'idx_photos_root_date_day',
      // 2026-10-06：`all` 档排除 Live Photo 伴生视频走的那条部分索引（只有 1 个条目，
      // 但**建它本身要全表扫一次** ⇒ 同样是延迟索引、同样不许出现在启动路径上）。
      'idx_photos_live_companion',
      // 2026-10-07：补全第二趟取批（`getPhotosMissingThumbnailsBefore`）的候选索引。
      // 它的 WHERE 引用的四列（has_thumbnail / dhash / exif_mtime / exif_ver）**全在
      // `thumbnail` BLOB 之后** ⇒ 建索引要逐行穿 7.6 KB 溢出页链，真库外推 3~5 分钟
      // ⇒ 更是必须留在延迟索引那一侧。
      'idx_photos_backfill_pending',
      // 2026-10-09：组织元数据两个筛选维度（rating / flag）。
      // 这两列是后加的、cid 排在 `thumbnail` 那串 BLOB 之后 ⇒ 建索引要整表回扫
      // （真库百万行级几十秒到几分钟）。`database.js#ensurePhotosOrgMetaColumns()`
      // 刻意只做 O(1) 的 ADD COLUMN、一条建索引语句都没有 —— 就靠这里守住。
      'idx_photos_rating',
      'idx_photos_flag',
    ]) {
      const pattern = new RegExp('CREATE INDEX IF NOT EXISTS ' + indexName + '\\b');
      assert.ok(
        pattern.test(workerSource) || pattern.test(phase5Source),
        `延迟索引 ${indexName} 的定义必须在 deferred-index-worker.js 或 main/deferred-indexes.js 里`,
      );
      const offenders = [];
      for (const file of walkJsFiles(path.join(__dirname, '..', 'src'))) {
        const relative = path.relative(path.join(__dirname, '..', 'src'), file);
        if (DEFERRED_HOMES.includes(relative)) continue;
        if (pattern.test(fs.readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(path.join(__dirname, '..'), file));
        }
      }
      assert.deepEqual(
        offenders,
        [],
        `${indexName} 的 CREATE INDEX 只许在延迟索引那两个文件里出现，实际还有：${offenders.join(', ')}`,
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
