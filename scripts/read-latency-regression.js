'use strict';

/**
 * 「前台那几类操作不再被慢查询拖住」四件事的守护（2026-10-06）。
 *
 * 来源是只读审计 `docs/foreground-operation-latency-audit.md`：用户列的 6 类前台操作全走
 * 读池 worker（结构上已排除主进程被拖），真正慢的是 **3 条 SQL 自己**。本文件钉住其中四件改动：
 *
 *   ① 读池 worker 补 `cache_size` / `mmap_size`（与主进程同源）
 *   ② `getPhotos` 的 `total` 记忆化（键 = SQL 原样 + 有界 TTL + 显式复位）
 *   ③ `getFolderTree` 的覆盖索引 `(root_id, folder_path, date_taken)`
 *   ④ `getPhotos({rootId})` 的排序索引 `(root_id, date_taken)`
 *
 * ③④ 的「只许定义在 deferred-index-worker 里」由 `maintenance-regression.js` 的延迟索引
 * 白名单负责（那里是既有契约的家），本文件只负责**执行计划**：证明这两条索引真的让计划
 * 从「回表 / 临时排序」变成「覆盖 / 顺势」，并且**没有把别的查询带偏**。
 *
 * 跑法：`node scripts/run-regressions.js`（或单独
 * `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/read-latency-regression.js`）
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const PhotoDatabase = require('../src/database');
const pool = require('../src/db-read-worker-pool');
const photosTotalCache = require('../src/photos-total-cache');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * 取源码切片。找不到标记就**当场失败** —— 否则「切不到 ⇒ 切片是空串 ⇒ `assert.ok(!/X/.test(切片))`
 * 通过」会让反向断言全部假绿（本项目踩过这个坑：断言读空函数体）。
 */
function sliceOf(source, startMarker, endMarker, label) {
  const from = source.indexOf(startMarker);
  assert.ok(from >= 0, `哨兵：没找到 ${label} 的起点标记「${startMarker}」—— 后面的断言会变成空跑`);
  const to = source.indexOf(endMarker, from + startMarker.length);
  assert.ok(to > from, `哨兵：没找到 ${label} 的终点标记「${endMarker}」`);
  return source.slice(from, to);
}

function planOf(db, sql, params) {
  return db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(params || [])
    .map((row) => row.detail)
    .join(' | ');
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

/* ───────────────────────── ① 读池 worker 的连接级 PRAGMA 与主进程同源 ───────────────────────── */

function checkReadConnectionPragmas(fixtureDbPath) {
  const workerSource = readSource('src/workers/db-read-worker.js');
  const openDbBody = sliceOf(
    workerSource,
    'function openDb() {',
    '\n}\n',
    'src/workers/db-read-worker.js#openDb',
  );
  assert.match(
    openDbBody,
    /PhotoDatabase\.applyReadConnectionPragmas\(db\);/,
    '读池 worker 打开连接时必须走 database.js 的共用入口（唯一真相源），不许自己拼 PRAGMA',
  );
  for (const pragma of ['cache_size', 'mmap_size', 'busy_timeout']) {
    assert.ok(
      !new RegExp(pragma + '\\s*=').test(openDbBody),
      `openDb() 里不许再出现 ${pragma} 的字面量 —— 抄一份数字 = 将来只改主进程那处，这条连接静默变慢`,
    );
  }

  // 行为面：同一个库上开一条只读连接，套上共用入口之后，两个 PRAGMA 必须与主进程连接**逐位相同**。
  const readConn = new Database(fixtureDbPath, { readonly: true, fileMustExist: true });
  const mainConn = new Database(fixtureDbPath);
  try {
    PhotoDatabase.applyReadConnectionPragmas(readConn);
    mainConn.pragma('cache_size = ' + PhotoDatabase.DB_CACHE_SIZE_KB);
    mainConn.pragma('mmap_size = ' + PhotoDatabase.DB_MMAP_SIZE_BYTES);

    const readCache = readConn.pragma('cache_size', { simple: true });
    const readMmap = readConn.pragma('mmap_size', { simple: true });
    assert.equal(
      readCache,
      mainConn.pragma('cache_size', { simple: true }),
      '只读连接的 cache_size 必须与主进程连接一致（同源）',
    );
    assert.equal(
      readMmap,
      mainConn.pragma('mmap_size', { simple: true }),
      '只读连接的 mmap_size 必须与主进程连接一致（同源）',
    );
    // 单独钉住「值本身够大」：SQLite 默认 cache_size 是 -2000（2 MB），
    // 只断言「是负数」的话，把常量改回默认值也能过 —— 那就白改了。
    assert.ok(
      readCache <= -131072,
      `只读连接 cache_size 至少要 128 MB（当前 ${readCache} KB）；默认值 -2000 正是要修的东西`,
    );
    assert.ok(
      readMmap > 0,
      `只读连接必须真的开 mmap（当前 ${readMmap}）；0 = 关闭，也就是改动之前的默认状态`,
    );
    assert.equal(readConn.pragma('busy_timeout', { simple: true }), 8000);
  } finally {
    readConn.close();
    mainConn.close();
  }
}

/* ───────────────────────── ② `getPhotos` 的 total 记忆化 ───────────────────────── */

function checkTotalMemoModule() {
  const source = readSource('src/database.js');
  const getPhotosBody = sliceOf(
    source,
    '  getPhotos(options = {}) {',
    '\n  }\n',
    'src/database.js#getPhotos',
  );
  // 🔴 键必须取 `whereClause` 与 `params` **原样**，不许按字段名手搓。
  // 手搓键（`rootId + '|' + favoritesOnly + '|' + mediaType`）漏一个字段就会**返回别人的计数**，
  // 而且不报错、不写日志。取 SQL 本身则恒成立：同一条 SQL + 同一组参数 ⇒ 同一个数。
  assert.match(
    getPhotosBody,
    /photosTotalCache\.get\(whereClause,\s*params\)/,
    'total 命中判定必须用 (whereClause, params) 当键',
  );
  assert.match(
    getPhotosBody,
    /photosTotalCache\.set\(whereClause,\s*params,\s*totalCount\)/,
    'total 未命中时要写回缓存（键同上）',
  );
  assert.equal(
    (getPhotosBody.match(/SELECT COUNT\(\*\) as count FROM photos/g) || []).length,
    1,
    '全表 COUNT 只许剩一处（未命中分支）—— 留着「反正先算一遍再查缓存」等于没缓存',
  );
  assert.match(
    getPhotosBody,
    /total:\s*totalCount,/,
    '返回的 total 必须用记忆化后的值（别只缓存不消费）',
  );

  // 行为面：模块自身的语义（TTL 边界、键的隔离性、容量上限）。
  photosTotalCache.invalidateAll();
  photosTotalCache.resetStats();
  assert.equal(photosTotalCache.get('WHERE 1=1', []), null, '空缓存必须未命中');
  photosTotalCache.set('WHERE 1=1', [], 1234, 1000);
  assert.equal(
    photosTotalCache.get('WHERE 1=1', [], 1000),
    1234,
    '刚写进去的条目必须立刻能命中（TTL 归零 / 判据反向都会死在这条）',
  );
  assert.equal(
    photosTotalCache.get('WHERE 1=1', [], 1000),
    1234,
    '同一时刻重复取必须命中（翻页场景就是这条）',
  );
  const ttl = photosTotalCache.PHOTOS_TOTAL_TTL_MS;
  assert.equal(photosTotalCache.get('WHERE 1=1', [], 1000 + ttl - 1), 1234, 'TTL 之内必须还算命中');
  assert.equal(photosTotalCache.get('WHERE 1=1', [], 1000 + ttl), null, '到 TTL 立刻失效');

  // 键的两个维度都要能区分：SQL 不同 / 参数不同。
  photosTotalCache.set('WHERE 1=1 AND root_id = ?', [7], 5, 2000);
  assert.equal(photosTotalCache.get('WHERE 1=1 AND root_id = ?', [7], 2000), 5);
  assert.equal(
    photosTotalCache.get('WHERE 1=1 AND root_id = ?', [8], 2000),
    null,
    '参数不同必须是另一个键（否则会拿 root 7 的张数去当 root 8 的）',
  );
  assert.equal(
    photosTotalCache.get('WHERE 1=1 AND root_id = ? AND is_favorite = 1', [7], 2000),
    null,
    'SQL 不同必须是另一个键（加了筛选项却命中旧值 = 静默错数）',
  );
  assert.notEqual(
    photosTotalCache.keyOf('WHERE x = ?', ['1']),
    photosTotalCache.keyOf('WHERE x = ?1', []),
    '分隔符必须让「参数值」与「SQL 文本」不可互相冒充（否则两组不同 (sql, params) 会撞同一个键）',
  );

  // 容量有上限（键是 SQL 文本、取值域天然极小，这条是防御性的）。
  photosTotalCache.invalidateAll();
  for (let i = 0; i < 200; i++) photosTotalCache.set('WHERE root_id = ?', [i], i, 3000);
  assert.ok(
    photosTotalCache.stats().size <= photosTotalCache.PHOTOS_TOTAL_MAX_ENTRIES,
    `条目数必须被 ${photosTotalCache.PHOTOS_TOTAL_MAX_ENTRIES} 挡住（长跑进程不许无限涨）`,
  );

  // TTL 必须**有界且不为 0**：0 / 超大值都是把「陈旧度」这个旋钮悄悄拧坏。
  assert.ok(
    Number.isFinite(ttl) && ttl >= 1000 && ttl <= 30000,
    `total 的最坏陈旧度必须落在 1~30 s（当前 ${ttl} ms）：太小 = 缓存没意义，太大 = 删了照片页面数迟迟不对`,
  );
  const mainSource = readSource('src/main.js');
  const refreshMatch = /var THUMB_TOTAL_REFRESH_MS = (\d+);/.exec(mainSource);
  assert.ok(refreshMatch, '哨兵：没在 main.js 里找到 THUMB_TOTAL_REFRESH_MS 的声明');
  assert.equal(
    ttl,
    Number(refreshMatch[1]),
    'total 的 TTL 刻意与缩略图副指标的刷新节流取同一个数（「派生计数有多新」全工程只记一个数）。' +
      '若确实要让两者不同：先删掉这条断言，并同步改 src/photos-total-cache.js 里写着「同值」的那段注释。',
  );
  photosTotalCache.invalidateAll();
}

function checkResetPlumbing() {
  const poolSource = readSource('src/db-read-worker-pool.js');
  const workerSource = readSource('src/workers/db-read-worker.js');
  const mainSource = readSource('src/main.js');

  // 复位指令名必须两端逐字相同 —— 这类「同一个字符串写在两个文件里」是本项目的老坑。
  const posted = /postMessage\(\{\s*op:\s*'([^']+)'\s*\}\)/.exec(poolSource);
  assert.ok(posted, '哨兵：没在 db-read-worker-pool.js 里找到 postMessage({ op: ... })');
  const handled = /if \(msg && msg\.op === '([^']+)'\)/.exec(workerSource);
  assert.ok(handled, '哨兵：没在 db-read-worker.js 里找到 `if (msg && msg.op === ...)`');
  assert.equal(posted[1], handled[1], '读池复位指令名必须两端逐字相同');

  // 无条件复位不许出现在「每批都会走到」的位置：启动期失效清理每 450ms 一批、绝大多数
  // 批次 deleted = 0，无条件清等于把缓存打成空转。两条清理路径都必须是**条件**复位。
  assert.match(
    mainSource,
    /if \(Number\(r && r\.deleted\) > 0\) \{\s*try \{\s*dbReadWorkerPool\.invalidateReadCaches\(\);/s,
    '启动期失效清理：只在这一批真的删了行时清读池缓存（它每 450ms 一批、大多批 deleted = 0）',
  );
  assert.match(
    mainSource,
    /if \(totalDeleted > 0\) \{\s*try \{\s*dbReadWorkerPool\.invalidateReadCaches\(\);/s,
    '手动清理：整轮收尾清一次，不要逐批清（批间隔只有一次 setTimeout(0)）',
  );

  const favoriteBody = sliceOf(
    mainSource,
    "ipcMain.handle('photo-toggle-favorite'",
    "ipcMain.handle('show-photo-in-folder'",
    'main.js#photo-toggle-favorite',
  );
  assert.match(
    favoriteBody,
    /dbReadWorkerPool\.invalidateReadCaches\(\)/,
    '收藏切换会改「仅收藏」那一档的张数（行数没变、变的是 is_favorite 分布）⇒ 必须复位',
  );

  // 两个目录缓存失效入口同时就是「改行数」的动作。行数一变，total 就不再是
  // 「同一条 SQL 同一个数」，所以两件事绑在同一个入口上（4 个调用点自动全覆盖）。
  for (const [label, startMarker] of [
    ['invalidateCatalogCachesSafe', 'function invalidateCatalogCachesSafe() {'],
    ['invalidateCatalogCacheForRootSafe', 'function invalidateCatalogCacheForRootSafe(rootId) {'],
  ]) {
    assert.match(
      sliceOf(mainSource, startMarker, '\n}\n', 'main.js#' + label),
      /dbReadWorkerPool\.invalidateReadCaches\(\)/,
      `${label} 里必须一起复位读池缓存（扫描收尾 / 删除 / 移除根目录都走它）`,
    );
  }

  const callCount = (mainSource.match(/dbReadWorkerPool\.invalidateReadCaches\(\)/g) || []).length;
  assert.ok(
    callCount >= 5,
    `main.js 里的复位调用点太少（${callCount}）—— 预期覆盖：扫描收尾 / 移入回收站 / 删除记录 / ` +
      '移除根目录（经两个 invalidateCatalog* 入口）+ 收藏切换 + 两条失效清理',
  );
}

/* ───────────────── ② 端到端：真读池 worker 里的缓存真的在生效、也真的清得掉 ───────────────── */

async function checkTotalMemoEndToEnd(dbPath) {
  const writer = new Database(dbPath);
  try {
    const totalOf = async (page) => {
      const result = await pool.run(dbPath, 'getPhotos', { page: page, pageSize: 10 });
      return result.total;
    };
    const before = await totalOf(1);
    assert.ok(before > 0, '哨兵：夹具里得有照片，否则「total 不变」这种断言毫无意义');

    // 直接写库（不复位）⇒ 缓存必须**继续**返回旧值。这一条是「缓存真的接上了」的**唯一**硬证据：
    // 没有缓存时这里会立刻看到 +1，从而把这个断言打红。
    writer.prepare('INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type, has_thumbnail) VALUES (?,?,?,?,?,?,?)')
      .run(1, 'C:\\fixture\\a', 'added.jpg', 'C:\\fixture\\a\\added.jpg', 10, 'jpg', 0);
    assert.equal(
      await totalOf(1),
      before,
      '未复位时命中缓存：这证明 total 记忆化真的在读池 worker 里生效（否则应当是 before + 1）',
    );

    // 复位之后必须看到新值（end-to-end 打通 pool → worker → 缓存）。
    pool.invalidateReadCaches();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      await totalOf(1),
      before + 1,
      'invalidateReadCaches() 之后必须能读到新行 —— 复位指令没能到达 worker 就会卡在旧值上',
    );
  } finally {
    writer.close();
  }
}

/* ───────────────── ③④ 两条索引：执行计划真的变了，且没把别的查询带偏 ───────────────── */

function takeIndexDdl(workerSource, indexName) {
  const match = new RegExp(
    'CREATE INDEX IF NOT EXISTS ' + indexName + '\\b ON photos\\(([^)]*)\\)',
  ).exec(workerSource);
  assert.ok(match, `哨兵：deferred-index-worker.js 里没有 ${indexName} 的定义`);
  return { name: indexName, columns: match[1], ddl: 'CREATE INDEX ' + indexName + ' ON photos(' + match[1] + ')' };
}

function checkIndexPlans(dbPath) {
  const workerSource = readSource('src/workers/deferred-index-worker.js');
  // 夹具用的列清单**直接取自 worker 源码**（不是在这里手抄一遍）：
  // 谁把 worker 里的列改坏了（比如漏掉 date_taken），下面的计划断言就会当场红。
  const covering = takeIndexDdl(workerSource, 'idx_photos_root_folder_date');
  const sorted = takeIndexDdl(workerSource, 'idx_photos_root_date');
  assert.equal(
    covering.columns,
    'root_id, folder_path, date_taken',
    '覆盖索引的三列必须都在 —— 少了 date_taken 就退化成回表（真库单根 91 万次回表、>4 分钟）',
  );
  assert.equal(
    sorted.columns,
    'root_id, date_taken',
    '排序索引必须建在 date_taken 上（`getPhotos` 的默认排序键就是它），建到 date_modified 上等于没建',
  );

  const db = new PhotoDatabase(dbPath);
  try {
    const TREE_SQL = `
      SELECT folder_path, COUNT(id) as photo_count,
        MIN(date_taken) as earliest_date, MAX(date_taken) as latest_date
      FROM photos WHERE root_id = ?
      GROUP BY folder_path
      ORDER BY folder_path`;
    const PAGE_SQL =
      'SELECT id, file_name FROM photos WHERE 1=1 AND root_id = ? ORDER BY date_taken DESC NULLS LAST LIMIT ? OFFSET ?';
    // 线上那条 getFolderTree 就是 db-heavy-read.runGetFolderTree 的 SQL；对照一次防手抄走样。
    const liveTreeSql = require('../src/db-heavy-read')
      .runGetFolderTree.toString()
      .replace(/\s+/g, ' ');
    for (const fragment of ['GROUP BY folder_path', 'MIN(date_taken)', 'MAX(date_taken)', 'root_id = ?']) {
      assert.ok(liveTreeSql.includes(fragment), `哨兵：线上 getFolderTree 的 SQL 变了（缺「${fragment}」）`);
    }

    // ── 建索引之前：先钉住「旧计划真的是慢的那种形状」。
    // 少了这一步，下面的「新计划更快」就无法证伪 —— 万一旧计划本来就是覆盖扫描，
    // 断言照样通过，等于什么都没守住。
    const beforeTreePlan = planOf(db.db, TREE_SQL, [1]);
    assert.match(beforeTreePlan, /USING INDEX idx_photos_root_folder \(root_id=\?\)/);
    assert.ok(
      !/COVERING/.test(beforeTreePlan),
      '哨兵：本轮改动之前 getFolderTree 的计划必须**不是** covering（否则本文件的断言不具区分度）',
    );
    const beforePagePlan = planOf(db.db, PAGE_SQL, [1, 10, 0]);
    assert.match(
      beforePagePlan,
      /USE TEMP B-TREE FOR ORDER BY/,
      '哨兵：本轮改动之前 getPhotos({rootId}) 必须**在**做临时排序（否则本文件的断言不具区分力）',
    );

    db.db.exec(covering.ddl);
    db.db.exec(sorted.ddl);
    // 哨兵：两条索引必须真的建出来了，否则下面的计划断言会把「索引不存在」当成通过。
    const created = db.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_photos_root_folder_date','idx_photos_root_date')",
      )
      .all()
      .map((row) => row.name)
      .sort();
    assert.deepEqual(
      created,
      ['idx_photos_root_date', 'idx_photos_root_folder_date'],
      '哨兵：两条索引必须真的建出来了 —— 否则下面的计划断言会把「索引压根不存在」当成通过',
    );

    // ── 建索引之后：①「覆盖」取代「回表」，②临时排序消失。
    const treePlan = planOf(db.db, TREE_SQL, [1]);
    assert.match(
      treePlan,
      /USING COVERING INDEX idx_photos_root_folder_date \(root_id=\?\)/,
      'getFolderTree 必须走覆盖索引（否则 MIN/MAX(date_taken) 还要回表，真库单根 >4 分钟）：' + treePlan,
    );
    assert.ok(!/TEMP B-TREE/.test(treePlan), '覆盖索引让分组按索引顺序推进，不该再有临时 B 树：' + treePlan);
    assert.ok(!/SCAN photos/.test(treePlan), '不许退化成整表扫描：' + treePlan);

    const pagePlan = planOf(db.db, PAGE_SQL, [1, 10, 0]);
    assert.match(
      pagePlan,
      /USING INDEX idx_photos_root_date \(root_id=\?\)/,
      'getPhotos({rootId}) 必须走 (root_id, date_taken)，否则真库对 91 万行做临时排序（实测 70,594 ms）：' +
        pagePlan,
    );
    assert.ok(
      !/TEMP B-TREE/.test(pagePlan),
      '`ORDER BY date_taken DESC NULLS LAST` 必须被索引顺势满足（NULL 在 SQLite 里最小 ⇒ DESC 时天然排最后）：' +
        pagePlan,
    );

    // ── 反向：新索引不许把既有快速路径带偏（规划器有更多索引可挑，代价模型就可能挑错）。
    // `allowTempBTree`：日期分组**本来**就有 `USE TEMP B-TREE FOR GROUP BY`（`date()` 是表达式，
    // 索引给不了分组顺序），所以它只比「走哪条索引」，不参与「有没有临时 B 树」这条。
    const guardPlans = [
      ['全库计数', 'SELECT COUNT(*) FROM photos WHERE 1=1', [], /COVERING INDEX idx_photos_hasThumb/],
      ['单根计数', 'SELECT COUNT(*) FROM photos WHERE root_id = ?', [1], /COVERING INDEX idx_photos_root \(/],
      [
        '根内目录数（扫描收尾快速路径）',
        'SELECT COUNT(*) AS n FROM (SELECT DISTINCT folder_path FROM photos WHERE root_id = ?)',
        [1],
        /COVERING INDEX idx_photos_root_folder \(/,
      ],
      [
        '日期分组（无过滤）',
        'SELECT date(date_taken) AS d, COUNT(*) FROM photos WHERE date_taken IS NOT NULL GROUP BY d ORDER BY d DESC',
        [],
        /COVERING INDEX idx_photos_date/,
        { allowTempBTree: true },
      ],
      ['全库最早/最晚', 'SELECT MIN(date_taken) FROM photos', [], /COVERING INDEX idx_photos_date/],
      [
        '无过滤分页排序',
        'SELECT id, file_name FROM photos WHERE 1=1 ORDER BY date_taken DESC NULLS LAST LIMIT 100',
        [],
        /SCAN photos USING INDEX idx_photos_date/,
      ],
    ];
    for (const [label, sql, params, expected, options] of guardPlans) {
      const plan = planOf(db.db, sql, params);
      assert.match(plan, expected, `${label} 的执行计划被新索引带偏了：${plan}`);
      if (!(options && options.allowTempBTree)) {
        assert.ok(!/TEMP B-TREE/.test(plan), `${label} 本来没有临时 B 树，加索引后也不该有：${plan}`);
      }
    }
  } finally {
    db.close();
  }
}

/* ───────────────── P1（Phase 5）：六条新索引 —— 计划真的翻转，且没把别的查询带偏 ───────────────── */

/**
 * Phase 5 的 DDL **直接取自** `src/main/deferred-indexes.js` —— 与 worker 跑的是**同一份字符串**。
 *
 * 🔴 为什么不能在这里手抄一份「等价 DDL」：部分索引的 `WHERE` 是**拼接**出来的
 *    （视频档谓词嵌在里面），而 SQLite 的部分索引匹配是**逐字**的 —— 手抄错一个字符，
 *    索引就静默失效（不报错，只是规划器不再用它），而回归照样全绿。
 *    抽到 `deferred-indexes.js` 就是为了让「worker 建的」与「回归验的」不可能不一致。
 */
function checkPhase5IndexPlans(dbPath) {
  const list = require('../src/main/deferred-indexes').PHASE5_INDEXES;
  const heavy = require('../src/db-heavy-read');
  assert.equal(
    list.length,
    9,
    '哨兵：Phase 5 应当正好九条 —— 增删索引必须同步改本文件的断言，否则新增的索引不在覆盖范围内' +
      '（⑦ 是 2026-10-07 加的「补全第二趟取批」候选索引；' +
      '⑧⑨ 是 2026-10-09 加的组织元数据两个筛选维度 rating / flag）',
  );
  for (const item of list) {
    assert.ok(
      /^CREATE INDEX IF NOT EXISTS /.test(item.sql),
      `哨兵：${item.name} 的 DDL 必须带 IF NOT EXISTS（否则每次启动都重建整条索引）：${item.sql}`,
    );
    assert.ok(item.sql.includes(' ON photos('), `哨兵：${item.name} 必须建在 photos 上：${item.sql}`);
    assert.ok(
      item.sql.includes(' ' + item.name + ' ON photos('),
      `哨兵：${item.name} 的 DDL 里索引名必须就是 name 字段（两者不一致 ⇒ 名称查询查不到、` +
        `而 \`created\` 断言会把「建出来的其实是别的名字」当成通过）：${item.sql}`,
    );
  }
  // 五条普通 + 四条部分。部分索引**必须真的写出 WHERE** —— 漏了它就从「部分」变成「全列」，
  // 体积与选择性与设计意图都不一样（而且不会报错）。
  // ⚠️ 组织元数据那两条（rating / flag）**刻意是普通索引**：要能查 `flag = 'none'` /
  //    `rating = 0`（冲片里的「还剩哪些没标」），而部分索引恰好把这两档排除在外。
  assert.deepEqual(
    list
      .filter((i) => / WHERE /.test(i.sql))
      .map((i) => i.name)
      .sort(),
    [
      'idx_photos_backfill_pending',
      'idx_photos_dup_hash_full',
      'idx_photos_live_companion',
      'idx_photos_root_date_day',
    ],
    '哨兵：这四条必须是部分索引（WHERE 不能在重构里被悄悄丢掉）',
  );

  // 「同一个字符串写在两个文件里」的守（第 6 条索引的 WHERE 与 `database.js` 的判据同源）。
  // 🔴 为什么必须钉：SQLite 的部分索引匹配是**逐字**的 —— 两边差一个字符，索引就静默用不上
  //    （不报错），而 `all` 档那条 `NOT IN` 子查询会当场退回逐行回表（真库 105 秒）。
  const companion = list.find((i) => i.name === heavy.LIVE_COMPANION_INDEX);
  assert.ok(companion, '哨兵：Phase 5 必须含伴生视频那条部分索引 ' + heavy.LIVE_COMPANION_INDEX);
  assert.equal(
    companion.name,
    'idx_photos_live_companion',
    '索引名必须与 `db-heavy-read#LIVE_COMPANION_INDEX` 逐字一致（回归要按名字建 DROP）',
  );
  assert.ok(
    companion.sql.includes(' WHERE ' + heavy.LIVE_COMPANION_PRED),
    'DDL 的 WHERE 必须逐字来自 `db-heavy-read#LIVE_COMPANION_PRED`：' + companion.sql,
  );
  assert.equal(
    PhotoDatabase.prototype._sqlLiveStillIsMotionExpr.call({}),
    heavy.LIVE_COMPANION_PRED,
    '伴生视频谓词必须两处逐字相同（`database.js#_sqlLiveStillIsMotionExpr` vs `db-heavy-read#LIVE_COMPANION_PRED`）' +
      '—— 部分索引匹配是逐字的，差一个字符索引就静默失效',
  );
  assert.equal(
    heavy.liveCompanionExcludeCondition({ prepare: () => ({ get: () => null }) }),
    null,
    '🔴 闸门在「问不出索引存在性」时必须返回 null（宁可多显示 1 行，也绝不加回那个回表谓词）',
  );

  const IMG = heavy.IMAGE_TYPE_PRED;
  const db = new PhotoDatabase(dbPath);
  try {
    // `file_hash` 是**延迟迁移列** ⇒ 先确保它在（幂等），再填一部分值，
    // 让 `idx_photos_dup_hash_full` 的部分索引非空（空索引的规划器行为不代表生产）。
    // ⚠️ `dhash` 同理（也是延迟迁移列，且 ⑦ `idx_photos_backfill_pending` 的 WHERE 引用了它）
    //    —— 少了它，下面那条 `CREATE INDEX` 会当场 `no such column: dhash`。
    for (const col of ['file_hash', 'dhash']) {
      try {
        db.db.exec('ALTER TABLE photos ADD COLUMN ' + col + ' TEXT');
      } catch (eAlter) {
        void eAlter;
      }
    }
    db.db.exec("UPDATE photos SET file_hash = 'h' || (id % 50) WHERE id % 3 = 0");

    const SORT_NAME =
      'SELECT id FROM photos WHERE 1=1 AND root_id = ? ORDER BY file_name DESC NULLS LAST LIMIT ? OFFSET ?';
    const SORT_SIZE =
      'SELECT id FROM photos WHERE 1=1 AND root_id = ? ORDER BY file_size DESC NULLS LAST LIMIT ? OFFSET ?';
    const DUP =
      `SELECT file_hash FROM photos WHERE file_hash IS NOT NULL AND TRIM(file_hash) != '' AND ${IMG} GROUP BY file_hash HAVING COUNT(*) >= 2`;
    const DAY_ALL =
      'SELECT date(date_taken) AS d, COUNT(*) AS c FROM photos WHERE date_taken IS NOT NULL GROUP BY d ORDER BY d DESC';
    const DAY_ROOT =
      'SELECT date(date_taken) AS d, COUNT(*) AS c FROM photos WHERE date_taken IS NOT NULL AND root_id = ? GROUP BY d ORDER BY d DESC';

    // ── ① 建索引之前：先钉住「旧计划真的是慢的那种形状」。
    // 少了这一步，下面的「新计划更快」无法证伪 —— 万一旧计划本来就很好，断言照样通过。
    const beforeName = planOf(db.db, SORT_NAME, [1, 10, 0]);
    assert.match(beforeName, /USE TEMP B-TREE FOR ORDER BY/, '哨兵：按文件名排序在建索引前必须**在**做临时排序：' + beforeName);
    const beforeSize = planOf(db.db, SORT_SIZE, [1, 10, 0]);
    assert.match(beforeSize, /USE TEMP B-TREE FOR ORDER BY/, '哨兵：按体积排序在建索引前必须**在**做临时排序：' + beforeSize);
    const beforeDup = planOf(db.db, DUP, []);
    assert.match(beforeDup, /TEMP B-TREE FOR GROUP BY/, '哨兵：查重在建索引前必须是临时分组：' + beforeDup);
    const beforeDayAll = planOf(db.db, DAY_ALL, []);
    assert.match(beforeDayAll, /TEMP B-TREE FOR GROUP BY/, '哨兵：日期分组（全库）建索引前必须是临时分组：' + beforeDayAll);
    const beforeDayRoot = planOf(db.db, DAY_ROOT, [1]);
    assert.match(beforeDayRoot, /TEMP B-TREE FOR GROUP BY/, '哨兵：日期分组（单根）建索引前必须是临时分组：' + beforeDayRoot);

    // ── ② 建索引（DDL 原样取自清单），并确认**清单里每一条都真的建出来了**。
    for (const item of list) db.db.exec(item.sql);
    const created = db.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN (" +
          list.map(() => '?').join(',') +
          ')',
      )
      .all(...list.map((i) => i.name))
      .map((r) => r.name)
      .sort();
    assert.deepEqual(
      created,
      list.map((i) => i.name).sort(),
      '哨兵：清单里每条索引都必须真的建出来 —— 否则下面的计划断言会把「索引压根不存在」当成通过',
    );

    // ── ③ 建索引之后：临时排序 / 临时分组消失，且走对应的新索引。
    const afterName = planOf(db.db, SORT_NAME, [1, 10, 0]);
    assert.match(
      afterName,
      /USING COVERING INDEX idx_photos_root_name \(root_id=\?\)/,
      '按文件名排序必须走 (root_id, file_name)（否则真库 39,990 ms 的临时排序还在）：' + afterName,
    );
    assert.ok(!/TEMP B-TREE/.test(afterName), '临时排序必须消失：' + afterName);

    const afterSize = planOf(db.db, SORT_SIZE, [1, 10, 0]);
    assert.match(
      afterSize,
      /USING COVERING INDEX idx_photos_root_size \(root_id=\?\)/,
      '按体积排序必须走 (root_id, file_size)：' + afterSize,
    );
    assert.ok(!/TEMP B-TREE/.test(afterSize), '临时排序必须消失：' + afterSize);

    const afterDup = planOf(db.db, DUP, []);
    assert.match(
      afterDup,
      /USING INDEX idx_photos_dup_hash_full \(file_hash>\?\)/,
      '查重必须走 (file_hash, file_size) 部分索引（否则真库 165 万次回表、174 秒）：' + afterDup,
    );

    const afterDayAll = planOf(db.db, DAY_ALL, []);
    assert.match(
      afterDayAll,
      /USING COVERING INDEX idx_photos_date_day/,
      '日期分组（全库）必须走 (date(date_taken), date_taken) 且覆盖：' + afterDayAll,
    );
    assert.ok(!/TEMP B-TREE/.test(afterDayAll), '表达式索引让分组免临时表 ⇒ 不许再有临时 B 树：' + afterDayAll);

    const afterDayRoot = planOf(db.db, DAY_ROOT, [1]);
    assert.match(
      afterDayRoot,
      /USING INDEX idx_photos_root_date_day \(root_id=\?\)/,
      '日期分组（单根）必须走 (root_id, date(date_taken)) WHERE date_taken IS NOT NULL：' + afterDayRoot,
    );
    assert.ok(
      !/TEMP B-TREE/.test(afterDayRoot),
      '单根日期分组也不许再有临时分组（真库 2,311 ms 那条夹具上从 2.3 s 掉到 26 ms）：' + afterDayRoot,
    );

    // ── ⑧⑨ 组织元数据两列（rating / flag，2026-10-09）──
    //
    // 这两条与前面七条**形态不同**：它们不是「消除临时排序/分组」的索引，
    // 而是纯**等值筛选**维度（`WHERE rating = ?` / `WHERE flag = ?`）。
    // 所以不钉 `EXPLAIN QUERY PLAN` 的具体串 —— 那个会随列的选择性（多少张图被评过星）
    // 和夹具规模漂移，钉死它就是给自己造一个随数据变化而红的假牙。
    //
    // 改钉「这条索引能不能用于这个形状」：`INDEXED BY` 强制指路，索引不存在、
    // 或对该 WHERE 不可用时 SQLite 会**当场抛错**（`no such index` / `no query solution`），
    // 而不是静默降级。这是不依赖数据分布、又能真正证伪的判据。
    const forcedRating = db.db
      .prepare('SELECT id FROM photos INDEXED BY idx_photos_rating WHERE rating = ?')
      .all(5);
    assert.ok(
      Array.isArray(forcedRating),
      '按评分筛选必须能用 idx_photos_rating 求解（索引不存在或不可用会当场抛错）',
    );
    const forcedFlag = db.db
      .prepare('SELECT id FROM photos INDEXED BY idx_photos_flag WHERE flag = ?')
      .all('pick');
    assert.ok(
      Array.isArray(forcedFlag),
      '按标记筛选必须能用 idx_photos_flag 求解（索引不存在或不可用会当场抛错）',
    );
    // 🔴 负例（证明上面两条不是恒真）：拿一个不存在的索引名去 INDEXED BY 必须抛错。
    //    少了这条，若哪天 `INDEXED BY` 被改成被忽略的写法，上面两条会永远绿。
    let indexByThrew = false;
    try {
      db.db.prepare('SELECT id FROM photos INDEXED BY idx_photos_does_not_exist WHERE id = ?').all(1);
    } catch (eIndexBy) {
      indexByThrew = true;
    }
    assert.ok(indexByThrew, '负例哨兵：INDEXED BY 指向不存在的索引必须抛错（否则上面两条断言是恒真的）');

    // ── ④ 第 6 条（`idx_photos_live_companion`）：`all` 档排除伴生视频不许再回表 ──
    //
    // 这条索引治的是用户报告的「所有文件 → 照片加载失败」：`all` 档原先用
    // `COALESCE(live_still_id, 0) = 0` 排除伴生视频，而 `live_still_id` 排在缩略图 BLOB
    // 之后、没有任何索引 ⇒ 计划从「覆盖扫描」退化成「逐行回表」，真库 478 ms → 105,954 ms。
    // 治本 = 换谓词形状（`id NOT IN (子查询)`）+ 让这条部分索引兜住子查询。
    //
    // 🔴 两态都要钉：
    //    · **索引不在** ⇒ 子查询自己就是 `SCAN photos`（回表）⇒ 所以调用方必须**不加条件**。
    //      实测（60000 行带内联 BLOB）没索引时 `NOT IN` 与 `COALESCE` 一样慢：231 ms vs 231 ms；
    //      有索引后 `NOT IN` 是 **4 ms**。⇒ 自适应闸门是必需项，不是优化。
    //    · **索引在** ⇒ 子查询必须走它，且外层必须**仍是覆盖扫描**（那是快的唯一来源）。
    const EXCLUDE = 'SELECT COUNT(*) AS n FROM photos WHERE id NOT IN (' +
      'SELECT id FROM photos WHERE ' + heavy.LIVE_COMPANION_PRED + ')';
    const LEGACY = 'SELECT COUNT(*) AS n FROM photos WHERE COALESCE(live_still_id, 0) = 0';

    // 前提：夹具上 Phase 4 + Phase 5 的索引都在位了，但**第 6 条刚被上面的循环建出来**，
    // 所以这里必须先证明「去掉它」时子查询确实会退化成回表 —— 否则下面的「走索引」断言
    // 可能只是因为规划器无论如何都走覆盖扫描，等于什么都没守住。
    db.db.exec('DROP INDEX IF EXISTS ' + heavy.LIVE_COMPANION_INDEX);
    heavy.clearIndexCache(db.db);
    assert.equal(
      heavy.liveCompanionExcludeCondition(db.db),
      null,
      '哨兵：索引被 DROP 之后闸门必须立刻返回 null（`hasIndex` 命中 true 也带 TTL，不会留假阳性）',
    );
    const beforeExcludePlan = planOf(db.db, EXCLUDE, []);
    assert.match(
      beforeExcludePlan,
      /LIST SUBQUERY/,
      '哨兵：`NOT IN (子查询)` 形状必须在计划里体现为 LIST SUBQUERY：' + beforeExcludePlan,
    );
    assert.ok(
      /(^|\| )SCAN photos( \||$)/.test(beforeExcludePlan),
      '哨兵：索引不在时子查询必须退化成**非覆盖**的 `SCAN photos`（回表）——这正是不能用的原因：' +
        beforeExcludePlan,
    );
    assert.ok(
      !/idx_photos_live_companion/.test(beforeExcludePlan),
      '哨兵：索引都 DROP 了计划里不许再出现它：' + beforeExcludePlan,
    );

    // 重新建上（DDL 原样取自清单里那一条 —— 不是这里手抄的）。
    const companionDdl = list.find((i) => i.name === heavy.LIVE_COMPANION_INDEX);
    assert.ok(companionDdl, '哨兵：清单里必须有 ' + heavy.LIVE_COMPANION_INDEX);
    db.db.exec(companionDdl.sql);
    heavy.clearIndexCache(db.db);
    const gate = heavy.liveCompanionExcludeCondition(db.db);
    assert.equal(
      gate,
      'id NOT IN (SELECT id FROM photos WHERE ' + heavy.LIVE_COMPANION_PRED + ')',
      '闸门返回的条件必须是这个形状（外层靠它保住覆盖扫描）',
    );
    const afterExcludePlan = planOf(db.db, EXCLUDE, []);
    assert.match(
      afterExcludePlan,
      /USING INDEX idx_photos_live_companion/,
      '子查询必须走这条部分索引（真库上它只有 1 个条目 ⇒ 微秒级）：' + afterExcludePlan,
    );
    assert.match(
      afterExcludePlan,
      /SCAN photos USING COVERING INDEX/,
      '🔴 外层扫描**必须仍是覆盖索引**（不回表）—— 这是「478 ms 档」与「105,954 ms 档」的分界：' +
        afterExcludePlan,
    );
    // 值必须逐个相同：换的是计划形状，不是语义。
    const legacyN = db.db.prepare(LEGACY).get().n;
    const newN = db.db.prepare(EXCLUDE).get().n;
    assert.equal(legacyN, newN, '治本写法与 COALESCE 写法的结果必须逐个相同（夹具上）');

    // 收尾：把这条索引 DROP 掉，免得影响后面的 `checkMediaCountIndexHint`
    // （它有一条「规划器本来不选部分索引」的哨兵，多一条索引就可能把那条哨兵带偏）。
    db.db.exec('DROP INDEX IF EXISTS ' + heavy.LIVE_COMPANION_INDEX);
    heavy.clearIndexCache(db.db);
  } finally {
    db.close();
  }
}

/* ───────────────── P0-1：媒体档计数必须钉住已有的部分索引 ───────────────── */

/**
 * `mediaCountIndexHint` 的三条契约：**索引不存在时不许加 hint**（否则 `INDEXED BY` 直接抛
 * `no query solution`）、**形状不对时不许加**（无 rootId / mediaType 不是 image|video）、
 * **加了之后值逐个相同且计划真的换索引**。
 */
function checkMediaCountIndexHint(dbPath) {
  const heavy = require('../src/db-heavy-read');
  const db = new PhotoDatabase(dbPath);
  try {
    const IMG = heavy.IMAGE_TYPE_PRED;
    const VID = heavy.VIDEO_TYPE_PRED;

    // ① 索引**还不存在**时：必须返回空串，绝不能抛。
    //    `INDEXED BY` 指向不存在的索引是 `no query solution`（直接报错，不是变慢）——
    //    这条断言就是那个安全闸门的守门人。
    heavy.clearIndexCache(db.db);
    assert.equal(heavy.mediaCountIndexHint(db.db, 1, 'image'), '', '索引还不存在时不许加 hint');
    assert.equal(heavy.mediaCountIndexHint(db.db, 1, 'video'), '', '索引还不存在时不许加 hint');

    // ② 形状不对时也不加：mediaType 不是 image/video（含 'all' / undefined / 空）
    assert.equal(heavy.mediaCountIndexHint(db.db, 1, 'all'), '', 'all 档没有对应部分索引，不许加 hint');
    assert.equal(heavy.mediaCountIndexHint(db.db, 1, undefined), '', '未指定 mediaType 不许加 hint');
    assert.equal(heavy.mediaCountIndexHint(db.db, 1, 'IMAGE'), '', '⚠️ 大小写：这里刻意只认小写 —— 调用点必须先归一化');

    // ③ 没有 rootId 时也不加：部分索引**第一列就是 root_id**，没有等值条件只能整条索引扫
    assert.equal(heavy.mediaCountIndexHint(db.db, 0, 'image'), '', 'rootId=0 不许加 hint');
    assert.equal(heavy.mediaCountIndexHint(db.db, null, 'image'), '', 'rootId 为空不许加 hint');

    // ④ 先记下「不加 hint 时规划器选了什么」——这是「为什么需要 hint」的证据。
    //    少了它，下面「加了之后走部分索引」就无法证伪（万一规划器本来就会选，hint 是多余的）。
    const noHintPlan = planOf(
      db.db,
      `SELECT COUNT(*) FROM photos WHERE 1=1 AND root_id = ? AND ${IMG}`,
      [1],
    );
    assert.ok(
      !/idx_photos_agg_root_folder_image/.test(noHintPlan),
      '哨兵：规划器本来就会选部分索引的话，这条 hint 就没有存在理由（真库上它选了 idx_photos_root ⇒ 71,617 ms）：' +
        noHintPlan,
    );

    // ⑤ 建出那两条部分索引（Phase 1 的产物；夹具不走 deferred-index-worker ⇒ 这里照同一份谓词建）。
    // ⚠️ 但先得让**两个档都有行**：夹具 seed 的 `file_type` 全是 `'jpg'` ⇒ 视频档 0 行，
    //    而下面要断言「加 hint 后计数与不加时逐个相同」—— 0 == 0 不具区分度
    //    （真库上视频档虽只占 1.5%，但那 24,909 行正是它与图片档最贵的差别所在）。
    db.db.exec("UPDATE photos SET file_type = 'mp4' WHERE id % 20 = 0");
    db.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_image ON photos(root_id, folder_path) WHERE ${IMG}`,
    );
    db.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_video ON photos(root_id, folder_path) WHERE ${VID}`,
    );
    // 🔴 必须清掉存在性缓存：`hasIndex` 是按连接缓存的，而第 ① 步已经把「不存在」写进缓存
    //    （TTL 30 s）—— 不清就会在下一条断言里拿到假阴性。
    //    这**也是生产上真实存在的窗口**：读池 worker 长期存活、索引却是运行期才由
    //    deferred-index-worker 建的 ⇒ `hasIndex` 的 TTL 就是为了堵它。
    heavy.clearIndexCache(db.db);
    assert.equal(
      heavy.mediaCountIndexHint(db.db, 1, 'image'),
      ' INDEXED BY idx_photos_agg_root_folder_image',
      '索引存在 + image 档 + 有 rootId ⇒ 必须给出 hint',
    );
    assert.equal(
      heavy.mediaCountIndexHint(db.db, 1, 'video'),
      ' INDEXED BY idx_photos_agg_root_folder_video',
      '视频档必须给出视频那条索引',
    );

    // ⑥ 值必须逐个相同（hint 只换执行计划、不改语义），且计划真的换索引。
    for (const media of ['image', 'video']) {
      const pred = media === 'image' ? IMG : VID;
      const hint = heavy.mediaCountIndexHint(db.db, 1, media);
      const withHint = db.db
        .prepare(`SELECT COUNT(*) AS n FROM photos${hint} WHERE 1=1 AND root_id = ? AND ${pred}`)
        .get(1).n;
      const without = db.db
        .prepare(`SELECT COUNT(*) AS n FROM photos WHERE 1=1 AND root_id = ? AND ${pred}`)
        .get(1).n;
      assert.ok(
        without > 0,
        `哨兵：夹具里 ${media} 档必须有行，否则下面「值相同」是 0 == 0、不具区分度`,
      );
      assert.equal(withHint, without, `${media} 档：加 hint 后的计数必须与不加时逐个相同`);

      const plan = planOf(
        db.db,
        `SELECT COUNT(*) FROM photos${hint} WHERE 1=1 AND root_id = ? AND ${pred}`,
        [1],
      );
      assert.match(plan, /USING INDEX idx_photos_agg_root_folder_/, `加 hint 后必须走部分索引：${plan}`);
      assert.ok(
        !/idx_photos_root \(/.test(plan),
        `不许回落到 idx_photos_root —— 那正是真库 71,617 ms 的形状：${plan}`,
      );
    }

    // ⑦ `hasIndex` 的存在性缓存**必须有界**：TTL 常量得在、且是个有限正数。
    //    永久缓存 ⇒ 「worker 起手时索引还不存在」会被记死，索引建好后**再也不加 hint**，
    //    永远走慢路径，且不报错、不写日志。
    const source = readSource('src/db-heavy-read.js');
    const ttl = /var INDEX_PROBE_TTL_MS = (\d+)/.exec(source);
    assert.ok(ttl, '哨兵：db-heavy-read.js 里没有 INDEX_PROBE_TTL_MS —— 存在性缓存必须带 TTL');
    assert.ok(Number(ttl[1]) > 0 && Number(ttl[1]) <= 300000, `TTL 必须是有界正数，实测值 ${ttl[1]}`);
    assert.ok(
      /clearIndexCache: clearIndexCache/.test(source),
      '哨兵：必须导出 clearIndexCache（回归靠它模拟「索引后建出来」）',
    );
  } finally {
    db.close();
  }
}

/* ───────────────── P0-2 / P0-3：搜图 total 与取页的分流 ───────────────── */

/**
 * 三件事：
 *   ① **等价性** —— `COUNT(*) FROM photos_fts WHERE MATCH` 与旧写法
 *      （`photos.id IN (SELECT rowid FROM photos_fts WHERE MATCH)`）必须逐个相同。
 *      两者相等的依据是三个触发器让外部内容表与 `photos` 同步，**这条不能靠「应该同步」**。
 *   ② **取页换索引序之后，WHERE 必须仍然生效** —— 断言取到的每一行都真的在 FTS 命中集里。
 *      这是 P0-3 最危险的失效形态：hint 让 `IN (FTS)` 被短路 ⇒ 返回一堆没匹配的图。
 *   ③ **分流常量必须存在**，且索引名指向一条真索引（`INDEXED BY` 指向不存在的索引会抛）。
 */
function checkSearchIndexOrder(dbPath) {
  const dbSource = readSource('src/database.js');
  const idxMatch = /const SEARCH_INDEX_ORDER_INDEX = '([^']+)'/.exec(dbSource);
  assert.ok(idxMatch, '哨兵：database.js 里没有 SEARCH_INDEX_ORDER_INDEX 常量');
  const INDEX = idxMatch[1];
  const minMatch = /const SEARCH_INDEX_ORDER_MIN_HITS = (\d+)/.exec(dbSource);
  assert.ok(minMatch, '哨兵：database.js 里没有 SEARCH_INDEX_ORDER_MIN_HITS 常量');
  assert.ok(
    Number(minMatch[1]) > 0,
    '阈值必须是正数 —— 0 会让每个词都走索引序，冷门词从 0.5 ms 掉到 3,487 ms',
  );
  assert.ok(
    /totalCount >= SEARCH_INDEX_ORDER_MIN_HITS/.test(dbSource),
    '哨兵：分流判断必须挂在 totalCount 上（P0-2 拿到的那个数）',
  );
  assert.ok(
    /!hasExtraFilter &&/.test(dbSource),
    '哨兵：有附加筛选（收藏 / 媒体档）时不许走索引序 —— 那样要沿途过滤，筛得越严放大越多',
  );

  const db = new PhotoDatabase(dbPath);
  try {
    db.ensureFtsSchema();
    db.db.exec("INSERT INTO photos_fts(photos_fts) VALUES('rebuild');");
    const ftsQ = '"IMG"*';

    // ① 等价性
    const newTotal = db.db
      .prepare('SELECT COUNT(*) AS n FROM photos_fts WHERE photos_fts MATCH ?')
      .get(ftsQ).n;
    const oldTotal = db.db
      .prepare(
        'SELECT COUNT(*) AS n FROM photos WHERE photos.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?)',
      )
      .get(ftsQ).n;
    assert.ok(newTotal > 0, '哨兵：FTS 命中集不能为空（否则下面的等价性是 0 == 0）');
    assert.equal(
      newTotal,
      oldTotal,
      'P0-2 的直接问 FTS 与旧写法必须逐个相同 —— 不等就说明外部内容表与 photos 失同步',
    );

    const OLD_PAGE =
      'SELECT id, file_name FROM photos WHERE photos.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?) ORDER BY date_taken DESC LIMIT ? OFFSET ?';
    const NEW_PAGE =
      `SELECT id, file_name FROM photos INDEXED BY ${INDEX} WHERE photos.id IN (SELECT rowid FROM photos_fts WHERE photos_fts MATCH ?) ORDER BY date_taken DESC LIMIT ? OFFSET ?`;

    // ③ 索引名必须指向一条真索引
    const idxExists = db.db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name = ?")
      .get(INDEX);
    assert.ok(idxExists, `哨兵：SEARCH_INDEX_ORDER_INDEX 指向的 ${INDEX} 不存在（INDEXED BY 会直接抛错）`);

    // ② 旧形态的哨兵：必须在做临时排序 + 走主键（否则本文件的断言不具区分度）
    const oldPlan = planOf(db.db, OLD_PAGE, [ftsQ, 20, 0]);
    assert.match(
      oldPlan,
      /USING INTEGER PRIMARY KEY \(rowid=\?\)/,
      '哨兵：旧写法必须是对命中 rowid 逐个回表（真库 32,428 ms 的形状）：' + oldPlan,
    );

    // 新形态：走日期索引、临时排序消失
    const newPlan = planOf(db.db, NEW_PAGE, [ftsQ, 20, 0]);
    assert.match(
      newPlan,
      new RegExp('SCAN photos USING INDEX ' + INDEX),
      `走索引序时必须用 ${INDEX} 按序推进：` + newPlan,
    );
    assert.ok(
      !/TEMP B-TREE FOR ORDER BY/.test(newPlan),
      '索引序让 ORDER BY date_taken 顺势满足 ⇒ 不该再有临时排序：' + newPlan,
    );
    assert.match(
      newPlan,
      /LIST SUBQUERY 1/,
      '哨兵：FTS 子查询必须还在（它要是消失了，说明 WHERE 被短路 ⇒ 会返回没匹配的图）：' + newPlan,
    );

    // ④ 最要紧的一条：**换索引序之后 WHERE 仍然生效** —— 逐行核对命中集
    const hitIds = new Set(
      db.db
        .prepare('SELECT rowid AS id FROM photos_fts WHERE photos_fts MATCH ?')
        .all(ftsQ)
        .map((r) => r.id),
    );
    const rows = db.db.prepare(NEW_PAGE).all(ftsQ, 20, 0);
    assert.ok(rows.length > 0, '哨兵：新形态必须能取到行（否则「每行都命中」是空真）');
    for (const row of rows) {
      assert.ok(
        hitIds.has(row.id),
        `走索引序取到的 id=${row.id} 不在 FTS 命中集里 ⇒ hint 让 WHERE 失效了（会显示没匹配的图）`,
      );
    }
    // 两边的行数必须一致（同一页、同一 limit）
    const oldRows = db.db.prepare(OLD_PAGE).all(ftsQ, 20, 0);
    assert.equal(
      rows.length,
      oldRows.length,
      '两种形态取到的行数必须相同（并列序可以不同，但条数不能少）',
    );
  } finally {
    db.close();
  }
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-read-latency-'));
  const pragmaDbPath = path.join(directory, 'pragma.db');
  const planDbPath = path.join(directory, 'plans.db');
  const memoDbPath = path.join(directory, 'memo.db');
  const fixtures = [];
  try {
    for (const file of [pragmaDbPath, planDbPath, memoDbPath]) {
      const fixture = new PhotoDatabase(file);
      fixtures.push(fixture);
    }

    // ③④ 的计划断言要一个够大的 photos 表（规划器只在有真实选择空间时才会换索引）。
    // 列顺序与真库一致（root_id / folder_path / date_taken 都排在 thumbnail BLOB 之前），
    // 但**不放 BLOB**：夹具只用来问计划，不量耗时。
    const planDb = fixtures[1];
    const root = planDb.addRootFolder('C:\\fixture');
    assert.equal(root, 1, '哨兵：夹具的第一个根目录 id 应当是 1');
    const insert = planDb.db.prepare(
      `INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type,
         width, height, date_taken, date_modified, thumbnail, has_thumbnail, is_favorite)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const seed = planDb.db.transaction(() => {
      for (let i = 0; i < 6000; i++) {
        const folder = 'C:\\fixture\\' + (i % 300);
        const ts = '2026-0' + ((i % 9) + 1) + '-01 12:00:00';
        insert.run(
          root,
          folder,
          'IMG_' + i + '.jpg',
          folder + '\\IMG_' + i + '.jpg',
          1024,
          'jpg',
          100,
          100,
          ts,
          ts,
          null,
          i % 100 === 0 ? 0 : 1,
          i % 97 === 0 ? 1 : 0,
        );
      }
    });
    seed();

    // 记忆化那条 end-to-end 需要自己一个库（它会 INSERT 行、还会断言 total 先不变后变）。
    // 🔴 必须先登记根目录：`photos.root_id` 有 FK 约束，主进程连接开着 `foreign_keys = ON`，
    // 直接插 root_id=1 会当场撞 `FOREIGN KEY constraint failed`。
    const memoDb = fixtures[2];
    const memoRoot = memoDb.addRootFolder('C:\\memo');
    const memoInsert = memoDb.db.prepare(
      `INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type, has_thumbnail)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 5; i++) {
      memoInsert.run(memoRoot, 'C:\\memo\\a', 'm' + i + '.jpg', 'C:\\memo\\a\\m' + i + '.jpg', 1, 'jpg', 1);
    }

    checkReadConnectionPragmas(pragmaDbPath);
    checkTotalMemoModule();
    checkResetPlumbing();
    checkIndexPlans(planDbPath);
    // 顺序有依赖：Phase 5 的「建索引之前」哨兵要求 Phase 4 那两条索引**已经建好**
    // （这样「建前」才等于生产上的真实起点），而 `checkMediaCountIndexHint` 的
    // 「规划器本来不选部分索引」哨兵要求 Phase 4 + Phase 5 的索引都在位。
    checkPhase5IndexPlans(planDbPath);
    checkMediaCountIndexHint(planDbPath);
    checkSearchIndexOrder(planDbPath);
    await checkTotalMemoEndToEnd(memoDbPath);

    console.log('[read-latency-regression] PASS');
  } finally {
    pool.terminate();
    for (const fixture of fixtures) {
      try {
        fixture.close();
      } catch (e) {
        void e;
      }
    }
    await removeTemporaryDirectory(directory);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
