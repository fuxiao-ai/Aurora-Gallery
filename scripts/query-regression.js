'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const heavy = require('../src/db-heavy-read');
const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE photos (
    id INTEGER PRIMARY KEY, root_id INTEGER, file_name TEXT, file_path TEXT,
    folder_path TEXT, file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER,
    date_taken TEXT, date_modified TEXT, has_thumbnail INTEGER, is_favorite INTEGER
  ); CREATE TABLE root_folders (id INTEGER PRIMARY KEY, path TEXT)`);
  // 🔴 夹具是**手工建表**、绕过了 `PhotoDatabase.init()`，所以必须自己把「迁移才会补的列」
  //    补齐 —— `_buildPreviewScopeWhere` / `getPhotos` 的谓词会引用它们（如 live_still_id），
  //    缺列就当场 `no such column`，看起来像代码 bug 而不是夹具问题。
  //    这里跑**真实的迁移函数**而不是手抄列定义：手抄的话每次加列都要同步改夹具，必然漂移。
  //
  //    ⚠️ 2026-10-07 又踩了一次同一个坑，只是这次不是缺 live_still_id 而是缺
  //    `thumb_size` / `thumb_format`：浏览层要拿这两列拼缩略图缓存键，于是**列清单被
  //    收口到 `photo-list-columns.js` 后，所有列表查询（含封面查询）都开始 SELECT 它们**。
  //    夹具没补 ⇒ `db.prepare` 当场 `no such column`，报错栈落在查询实现里，看起来像代码 bug。
  //    结论不变：夹具只建「建库期的骨架列」，其余一律交给迁移函数。
  {
    const PhotoDatabaseForMigration = require('../src/database');
    const migrator = Object.create(PhotoDatabaseForMigration.prototype);
    migrator.db = db;
    migrator.ensurePhotosLivePhotoColumns();
    migrator.ensurePhotosThumbnailMetaColumns();
    // 组织元数据两列 + 标签两张表（2026-10-09）：`photoListColumns()` 已把 rating / flag
    // 收进基线，于是**所有列表查询**（含 db-heavy-read 那几条）都开始 SELECT 它们。
    // 夹具不补 ⇒ `db.prepare` 当场 `no such column`，而报错栈落在查询实现里，
    // 看起来像代码 bug —— 这正是本段开头记的那条纪律（夹具只建骨架列、其余交给迁移）。
    migrator.ensurePhotosOrgMetaColumns();
    migrator.ensureOrgTagSchema();
  }
  db.prepare('INSERT INTO root_folders VALUES (1, ?)').run('C:/photos');
  // 🔴 列名必须**逐列写出来**，不许用位置式 `VALUES (?,1,?...13 个)`：
  //    位置式会在「迁移补了新列」的那一刻变成 `table photos has N columns but M values were supplied`，
  //    而报错栈落在 `db.prepare` 上（不在任何业务代码里），看起来像查询实现写错了。
  //    显式列名则天然免疫后续加列 —— 与上面「跑真实迁移函数而非手抄列定义」是同一条纪律。
  const insert = db.prepare(
    `INSERT INTO photos
       (id, root_id, file_name, file_path, folder_path, file_size, file_type,
        width, height, date_taken, date_modified, has_thumbnail, is_favorite)
     VALUES (?, 1, ?, ?, ?, 1, ?, 1, 1, ?, ?, 1, 0)`,
  );
  function add(id, folder, date, type = 'jpg') {
    insert.run(id, `${id}.${type}`, `${folder}/${id}.${type}`, folder, type, date, date);
  }
  add(1, 'C:/photos/child/deep', '2026-01-01T10:00:00');
  add(2, 'C:/photos/child/deep', '2026-01-01 23:59:59.999');
  add(3, 'C:/photos/child', '2026-01-02 00:00:00', 'mp4');
  add(4, 'C:/photos/a_%/nested', '2026-01-01 11:00:00');
  add(5, 'C:/photos/axxx/nested', '2026-01-01 12:00:00');
  const day = heavy.runGetDatePhotos(db, '2026-01-01', {});
  assert.equal(day.total, 4, 'ISO and space timestamps including last millisecond');
  assert.equal(heavy.runGetDatePhotos(db, '2026-01-02', {}).total, 1);
  const covers = heavy.runGetImmediateSubfolderCovers(db, { parentPath: 'C:/photos/' });
  const child = covers.find((row) => row.folder_path === 'C:/photos/child');
  assert.equal(child.folder_photo_count, 3, 'count photos throughout child subtree');
  assert.ok(child.id, 'parent without direct photos still has a cover');
  const images = heavy.runGetImmediateSubfolderCovers(db, {
    parentPath: 'C:/photos',
    mediaType: 'image',
  });
  assert.equal(images.find((row) => row.folder_path.endsWith('/child')).folder_photo_count, 2);
  const special = heavy.runGetImmediateSubfolderCovers(db, { parentPath: 'C:/photos/a_%' });
  assert.equal(special.length, 1);
  assert.equal(special[0].folder_photo_count, 1, 'LIKE metacharacters are literal');
  assert.equal(special[0].id, 4);
  add(6, 'C:\\photos\\windows\\deep', '2026-01-03 00:00:00');
  const windows = heavy.runGetImmediateSubfolderCovers(db, { parentPath: 'C:\\photos\\windows' });
  assert.equal(windows[0].id, 6, 'Windows separators match stored paths');
  assert.equal(windows[0].folder_path, 'C:/photos/windows/deep');
  assert.throws(() => heavy.runGetDatePhotos(db, '2026-02-30', {}), /Invalid date/);
  const beforeIndex = heavy.runGetImmediateSubfolderCovers(db, { parentPath: 'C:/photos' });
  db.exec('CREATE INDEX idx_photos_folder_nocase ON photos(folder_path COLLATE NOCASE)');
  assert.deepEqual(
    heavy.runGetImmediateSubfolderCovers(db, { parentPath: 'C:/photos' }),
    beforeIndex,
  );
  const PhotoDatabase = require('../src/database');
  const reader = Object.create(PhotoDatabase.prototype);
  reader.db = db;
  assert.equal(reader.getDatePhotos('2026-01-01').total, 4, 'shared synchronous date contract');
  assert.ok(
    reader
      ._buildPreviewScopeWhere({ view: 'date', date: '2026-01-01' })
      .params.includes('2026-01-02'),
  );
  add(7, '/album/📷/nested', '2026-01-04 00:00:00');
  assert.equal(
    heavy.runGetImmediateSubfolderCovers(db, { parentPath: '/album/📷' })[0].folder_path,
    '/album/📷/nested',
    'SQLite character offsets support supplementary Unicode',
  );
  assert.equal(
    heavy.runGetImmediateSubfolderCovers(db, { parentPath: '/' })[0].folder_path,
    '/album',
  );

  // ── 顶栏全库统计：每条指标必须各自走覆盖索引 ──────────────────────────────
  // 塌回成一条 `SELECT COUNT(*), SUM(file_size), COUNT(DISTINCT folder_path) ... FROM photos`
  // 不会算错任何一个数（本回归下面的数值断言照样过），只会让计划从「6 条覆盖索引」退回
  // `SCAN photos + USE TEMP B-TREE FOR count(DISTINCT)` —— photos 的 thumbnail BLOB 内联在行中间，
  // 整表扫描等于把十几 GB 缩略图溢出页读一遍。真库 122 万行 / 12.97 GB 实测 5603 ms → 748 ms。
  // 数值抓不住这种回退，必须断言执行计划。
  const statsDb = new Database(':memory:');
  try {
    statsDb.exec(`CREATE TABLE photos (
      id INTEGER PRIMARY KEY, root_id INTEGER, folder_path TEXT NOT NULL, file_name TEXT NOT NULL,
      file_path TEXT UNIQUE NOT NULL, file_size INTEGER DEFAULT 0, file_type TEXT DEFAULT '',
      width INTEGER, height INTEGER, date_taken TEXT, date_modified TEXT, thumbnail BLOB,
      has_thumbnail INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0);
      CREATE INDEX idx_photos_folder ON photos(folder_path);
      CREATE INDEX idx_photos_date ON photos(date_taken);
      CREATE INDEX idx_photos_type ON photos(file_type);
      CREATE INDEX idx_photos_size ON photos(file_size);
      CREATE INDEX idx_photos_favorite ON photos(is_favorite);
      CREATE INDEX idx_photos_root ON photos(root_id);
      CREATE INDEX idx_photos_hasThumb ON photos(has_thumbnail);`);
    const fixture = statsDb.prepare(
      'INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type, date_taken, date_modified, has_thumbnail) VALUES (?,?,?,?,?,?,?,?,1)',
    );
    statsDb.transaction(() => {
      for (let i = 1; i <= 20000; i += 1) {
        const folder = 'K:\\album' + (i % 500);
        fixture.run(
          1 + (i % 3),
          folder,
          i + '.jpg',
          folder + '\\' + i + '.jpg',
          1000 + i,
          i % 7 === 0 ? 'mp4' : 'jpg',
          '2020-01-01 10:00:00',
          '2020-01-01 10:00:00',
        );
      }
    })();
    statsDb.exec('ANALYZE');
    const plan = statsDb
      .prepare('EXPLAIN QUERY PLAN ' + heavy.statsAggSql())
      .all()
      .map((row) => row.detail);
    for (const index of [
      'idx_photos_hasThumb',
      'idx_photos_size',
      'idx_photos_folder',
      'idx_photos_type',
      'idx_photos_favorite',
      'idx_photos_date',
    ]) {
      assert.ok(
        plan.some((detail) => detail.includes('COVERING INDEX ' + index)),
        `全库统计必须让每个指标各自走覆盖索引 ${index}，否则会退化成整表扫描；实际计划：${plan.join(' | ')}`,
      );
    }
    assert.ok(
      !plan.some((detail) => /TEMP B-TREE/.test(detail)),
      `全库统计不许再建临时 B 树（说明又塌回一条全表聚合了）；实际计划：${plan.join(' | ')}`,
    );
  } finally {
    statsDb.close();
  }

  // 拆开之后数值必须与原实现逐字段一致 —— 用独立写的单指标查询对答案。
  const stats = heavy.runGetStatsAgg(db);
  const one = (sql) => db.prepare(sql).get().n;
  assert.equal(stats.totalPhotos, one('SELECT COUNT(*) n FROM photos'));
  assert.equal(stats.totalSize, one('SELECT COALESCE(SUM(file_size), 0) n FROM photos'));
  assert.equal(stats.totalFolders, one('SELECT COUNT(DISTINCT folder_path) n FROM photos'));
  assert.equal(stats.favoritePhotos, one('SELECT COUNT(*) n FROM photos WHERE is_favorite = 1'));
  assert.equal(
    stats.videoPhotos,
    one(
      "SELECT COUNT(*) n FROM photos WHERE lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')",
    ),
  );
  assert.equal(
    stats.videoSize,
    one(`SELECT COALESCE(SUM(file_size), 0) n FROM photos WHERE lower(replace(file_type, '.', '')) IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')`),
  );
  assert.equal(stats.earliestDate, one('SELECT MIN(date_taken) n FROM photos'));
  assert.equal(stats.latestDate, one('SELECT MAX(date_taken) n FROM photos'));

  // ── 随机幻灯批次：必须是「先随机取 id、再按 id 回表」的两段式 ──────────────
  // 一趟式 `SELECT <12 列> FROM photos ... ORDER BY RANDOM() LIMIT n` 会把所有行先物化进临时 B 树，
  // 而 photos 的缩略图 BLOB 内联在行中间 —— 真库实测 3742 ms vs 两段式 100 ms（37×）。
  const batch = reader.getRandomPreviewPhotoBatch({ view: 'all', mediaType: 'all', limit: 5 });
  assert.equal(batch.length, 5, 'limit 小于总数时按 limit 取');
  assert.equal(new Set(batch.map((row) => row.id)).size, 5, '同一批里不许出现重复照片');
  assert.ok(
    batch.every((row) => row.file_path && row.file_name && row.has_thumbnail !== undefined),
    '要带齐网格与预览需要的列（外层按 id 回表的那一段不能漏列）',
  );
  const wholeBag = reader.getRandomPreviewPhotoBatch({ view: 'all', mediaType: 'all', limit: 100 });
  assert.equal(wholeBag.length, 7, 'limit 大于总数时返回全部');
  const withoutExcluded = reader.getRandomPreviewPhotoBatch({
    view: 'all',
    mediaType: 'all',
    limit: 100,
    excludeIds: [1, 2, 3],
  });
  assert.equal(withoutExcluded.length, 4, 'excludeIds 必须在随机取 id 那一段就排掉');
  assert.ok(withoutExcluded.every((row) => ![1, 2, 3].includes(row.id)));
  const scoped = reader.getRandomPreviewPhotoBatch({
    view: 'date',
    date: '2026-01-02',
    mediaType: 'all',
    limit: 100,
  });
  assert.deepEqual(
    scoped.map((row) => row.id),
    [3],
    '日期作用域照样生效（含作用域参数绑定的顺序：作用域参数在前、LIMIT 在后）',
  );

  // 静态契约：`getRandomPreviewPhotoBatch` 的 SQL 必须保持两段式形状。
  // 单看返回值抓不住——一趟式与两段式取回的是同一份随机集合（调用方还会自己洗牌），
  // 只有 SQL 形状变了才会回到 3.7 秒。
  const databaseSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'database.js'),
    'utf8',
  );
  assert.ok(
    databaseSource.includes('FROM photos WHERE id IN (SELECT id FROM photos '),
    'getRandomPreviewPhotoBatch 必须写成两段式：先在子查询里随机取 id，再按主键回表',
  );
  assert.ok(
    !databaseSource.includes("FROM photos ' + cond +"),
    'getRandomPreviewPhotoBatch 不许再出现「一趟式 SELECT 列 + ORDER BY RANDOM()」',
  );

  // ── 媒体档过滤：四个入口必须给同一套语义 ──────────────────────────────────
  //
  // 2026-10-06 实测到的真 bug：`getFolderPhotos` 与 `searchPhotos` 只取了
  // `mediaConds[0]`，而 `_pushMediaTypeCondition` 在 `video` 档会 push **两条**
  // （排除伴生视频 + 视频扩展名）⇒ 那两个入口的「视频」档**把照片也列出来**。
  // 夹具实测（6 jpg + 4 mp4 + 1 mov + 1 伴生 MOV）：
  //   · `getFolderPhotos(video)` 返回 **11** 行（应为 5）；
  //   · `searchPhotos('IMG', video)` 返回 **6** 张 jpg（应为 0）。
  // 而用 `join(' AND ')` 的 `getPhotos` 两个都对 —— 同一个 `mediaType` 在四个入口上
  // 分叉，正是本项目最擅长静默产生的那种 bug。
  //
  // ⇒ 这一节按「**同一个 mediaType 在四个入口上的集合必须一致**」写断言。
  //    它抓的是**消费者**（谁把条件用丢了），不是某一条 SQL 的写法 ——
  //    将来再加一个入口 / 再加一条媒体档条件，只要有人又把条件截断，这里就红。
  {
    const photosTotalCache = require('../src/photos-total-cache');
    // 🔴 这四行放进**独立的 root_id = 2 + 独立目录**：四个入口必须能被收窄到同一批行，
    //    否则「四个入口一致」只能比成「都包含 b.mov」，那种断言抓不住多余项。
    //    `folder_path` 用**反斜杠**：`getFolderPhotos` 会把入参的 `/` 归一成 `\` 再等值匹配
    //    （见那个函数的 `normalizedPath`），存正斜杠就一行都匹配不上。
    const MF = 'C:\\photos\\mf';
    db.prepare('INSERT INTO root_folders (id, path) VALUES (2, ?)').run(MF);
    const insMf = db.prepare(
      `INSERT INTO photos
         (id, root_id, file_name, file_path, folder_path, file_size, file_type,
          width, height, date_taken, date_modified, has_thumbnail, is_favorite, live_still_id)
       VALUES (?, 2, ?, ?, ?, 1, ?, 1, 1, '2026-02-01 10:00:00', '2026-02-01 10:00:00', 1, 0, ?)`,
    );
    insMf.run(101, 'a.jpg', MF + '\\a.jpg', MF, 'jpg', null);
    insMf.run(102, 'a.mov', MF + '\\a.mov', MF, 'mov', 101); // 真伴生视频（指向 a.jpg）
    insMf.run(103, 'b.mov', MF + '\\b.mov', MF, 'mov', 0); // 探查过、不是伴生
    insMf.run(104, 'c.jpg', MF + '\\c.jpg', MF, 'jpg', null); // 还没探查

    const names = (rows) => rows.map((r) => r.file_name).sort().join(',');
    // 四个入口，**全部收窄到 root_id = 2 / 这个目录 / 这个搜索词**（详见各分支）。
    const outOf = {
      'getPhotos(rootId=2)': (mt) => {
        photosTotalCache.invalidateAll();
        return reader.getPhotos({ rootId: 2, mediaType: mt, pageSize: 100 }).photos;
      },
      getFolderPhotos: (mt) =>
        reader.getFolderPhotos(MF, { mediaType: mt, pageSize: 100 }).photos,
      'searchPhotos("mf")': (mt) => {
        photosTotalCache.invalidateAll();
        return reader.searchPhotos('mf', { mediaType: mt, pageSize: 100 }).photos;
      },
      'getRandomPreviewPhotoBatch(rootId=2)': (mt) =>
        reader.getRandomPreviewPhotoBatch({ view: 'root', rootId: 2, mediaType: mt, limit: 100 }),
    };
    const entries = Object.keys(outOf);

    // ① `video` 档：四个入口都必须**只**给「探查过、不是伴生」的那个 mov。
    for (const name of entries) {
      assert.equal(
        names(outOf[name]('video')),
        'b.mov',
        `🔴 ${name} 的「视频」档只许给 b.mov —— 出现 jpg 说明 ` +
          `\`_pushMediaTypeCondition\` 的第二条（file_type 视频）被消费者丢了`,
      );
    }
    // ② `image` 档：四个入口都只给两张 jpg。
    for (const name of entries) {
      assert.equal(names(outOf[name]('image')), 'a.jpg,c.jpg', `${name} 的「图片」档只许给两张 jpg`);
    }

    // ③ `all` 档：**索引未就绪时四个入口都不排伴生视频**（4 行）。
    //    为什么刻意不排：`all` 是唯一没有别的限定条件的档，`COALESCE(live_still_id,0)=0`
    //    压在整表上会让计划从覆盖扫描退化成逐行回表 —— 真库实测 478 ms → **105,954 ms**，
    //    只排掉 1 行，用户看到的是「所有文件」报「照片加载失败」。
    assert.equal(
      heavy.liveCompanionExcludeCondition(db),
      null,
      '哨兵：夹具上还没有那条部分索引 ⇒ 闸门必须是 null',
    );
    for (const name of entries) {
      assert.equal(
        names(outOf[name]('all')),
        'a.jpg,a.mov,b.mov,c.jpg',
        `${name} 的「所有文件」档在索引未就绪时必须**刻意不排**伴生视频`,
      );
    }

    // ④ 建上部分索引 ⇒ 闸门打开。
    db.exec(
      'CREATE INDEX IF NOT EXISTS ' +
        heavy.LIVE_COMPANION_INDEX +
        ' ON photos(id) WHERE ' +
        heavy.LIVE_COMPANION_PRED,
    );
    heavy.clearIndexCache(db);
    assert.equal(
      heavy.liveCompanionExcludeCondition(db),
      'id NOT IN (SELECT id FROM photos WHERE ' + heavy.LIVE_COMPANION_PRED + ')',
      '哨兵：索引就绪后闸门必须放行',
    );
    // 列表类入口必须排掉伴生视频。
    for (const name of [
      'getPhotos(rootId=2)',
      'getFolderPhotos',
      'getRandomPreviewPhotoBatch(rootId=2)',
    ]) {
      assert.equal(
        names(outOf[name]('all')),
        'a.jpg,b.mov,c.jpg',
        `${name} 的「所有文件」档在索引就绪后必须排掉伴生视频`,
      );
    }
    // 🔴 `searchPhotos` **刻意不排**（与 `_pushMediaTypeCondition` 的
    //    `preserveLiveCompanion` 对应）：`hasExtraFilter` 一旦被判成 true，
    //    两条经过标定的优化会同时失效（total 324×、取一页 230×），而收益只是少显示 1 行。
    assert.equal(
      names(outOf['searchPhotos("mf")']('all')),
      'a.jpg,a.mov,b.mov,c.jpg',
      '🔴 searchPhotos 的「所有文件」档**刻意不排**伴生视频 —— ' +
        '排了会把 hasExtraFilter 打开，代价是 total 324× / 取一页 230×',
    );
    // 预览作用域必须与「产出当前列表的那个函数」一致：除了 `view === 'search'`，
    // 其余视图的列表都来自 `getPhotos` / `getFolderPhotos` / `getRandomPreviewPhotoBatch`
    // ⇒ 都要排 —— 否则出现「列表里没有这张卡、预览的上一张/下一张却跳得到它」。
    const exclusion = 'id NOT IN (SELECT id FROM photos WHERE ' + heavy.LIVE_COMPANION_PRED + ')';
    for (const scope of [
      { view: 'root', rootId: 2, mediaType: 'all' },
      { view: 'folder', path: MF, mediaType: 'all' },
    ]) {
      assert.ok(
        reader._buildPreviewScopeWhere(scope).whereSql.includes(exclusion),
        `🔴 view=${scope.view} 的预览作用域必须排伴生视频：` +
          reader._buildPreviewScopeWhere(scope).whereSql,
      );
    }
    const scopeSearch = reader._buildPreviewScopeWhere({
      view: 'search',
      q: 'mf',
      mediaType: 'all',
    }).whereSql;
    assert.ok(
      !scopeSearch.includes('id NOT IN'),
      '🔴 `view=search` 的预览作用域**不许**排 —— 它的列表来自 searchPhotos，那边刻意不排：' +
        scopeSearch,
    );
    // `image` / `video` 档的作用域不受这条闸门影响（各有自己的谓词）。
    assert.ok(
      !reader._buildPreviewScopeWhere({ view: 'root', rootId: 2, mediaType: 'video' }).whereSql.includes(
        'id NOT IN',
      ),
      '`video` 档的预览作用域走 COALESCE 那条谓词，不该出现 `id NOT IN`',
    );
    // 收尾：DROP 掉，别影响别的断言。
    db.exec('DROP INDEX IF EXISTS ' + heavy.LIVE_COMPANION_INDEX);
    heavy.clearIndexCache(db);
  }

  // ── 根目录聚合统计（「文件」侧栏那三档）：必须逐根走覆盖索引 / 部分索引 ────────
  //
  // 2026-10-07 用户报「仅图片时，加载照片失败」。查下来这条链是：
  //   `app.js#loadRootFolders` → `api.getRootFolders({mediaType:'image'})` → 读池
  //   → `runGetRootFoldersAgg`。它原先在缓存未命中时**一趟扫全表**（`SUM(CASE WHEN 视频…)`
  //   要 `file_type`、`SELECT DISTINCT root_id, folder_path` 要物化 166 万行）——
  //   真库实测 **60 秒还没跑完**，而读池 `JOB_TIMEOUT_MS = 120000`（**含排队时间**）
  //   ⇒ 被掐掉 + retire 一个 worker，排在同池后面的浏览请求跟着一起过 deadline
  //   ⇒ 前端 catch 显示「照片加载失败」。
  //
  // 这一节抓的是**形状**而不是数值：数值断言抓不住「塌回整表扫」——整表写法算出来的数
  // 一模一样，只是慢几十倍（同一份判据见 `read-latency-regression` 的 P0-1 段）。
  // 所以做法是**在运行期录下这个函数真正发出去的 SQL**，断言每一条碰 `photos` 的
  // select 都钉了 `INDEXED BY`。它观察的是行为（发了什么语句），不是源码文本，
  // 所以既抓得住「把 hint 删掉」，也不怕注释里写什么都无所谓。
  {
    const AGG = 'D:\\agg';
    // 🔴 夹具的 `root_folders` 是手工建的、只有 `(id, path)`（见文件头那段说明），
    //    而聚合要按 `name` 排序并回传它 ⇒ 这里补列，并把四根都写上名字。
    //    不用 `INSERT ... VALUES (id, path, name)`：位置式插入会在「迁移补列」那一刻变成
    //    `table root_folders has N columns but M values were supplied`，报错栈还不落在业务代码里。
    db.exec('ALTER TABLE root_folders ADD COLUMN name TEXT');
    db.prepare('INSERT INTO root_folders (id, path) VALUES (3, ?)').run(AGG + '\\zzz-agg3');
    db.prepare('INSERT INTO root_folders (id, path) VALUES (4, ?)').run(AGG + '\\zzz-agg4');
    db.prepare('UPDATE root_folders SET name = ? WHERE id = ?').run('aaa-agg1', 1);
    db.prepare('UPDATE root_folders SET name = ? WHERE id = ?').run('bbb-agg2', 2);
    db.prepare('UPDATE root_folders SET name = ? WHERE id = ?').run('zzz-agg3', 3);
    db.prepare('UPDATE root_folders SET name = ? WHERE id = ?').run('zzz-agg4', 4);
    // 真库里这两条是 `createCoreSchema` 建的（夹具绕过了 init，得自己补），
    // 否则「不扫表」这条计划断言在小夹具上也无从成立。
    db.exec('CREATE INDEX IF NOT EXISTS idx_photos_root ON photos(root_id)');
    db.exec('CREATE INDEX IF NOT EXISTS ' + heavy.AGG_ALL_FOLDER_INDEX + ' ON photos(root_id, folder_path)');
    // 部分索引（`AGG_*`）在夹具上默认不存在（真库由 deferred-index-worker 建）
    // ⇒ 不建的话两条媒体档都会退化成无 hint，这一节就白写了。
    db.exec(
      'CREATE INDEX IF NOT EXISTS ' +
        heavy.AGG_IMAGE_INDEX +
        ' ON photos(root_id, folder_path) WHERE ' +
        heavy.IMAGE_TYPE_PRED,
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS ' +
        heavy.AGG_VIDEO_INDEX +
        ' ON photos(root_id, folder_path) WHERE ' +
        heavy.VIDEO_TYPE_PRED,
    );
    heavy.clearIndexCache(db);

    const insAgg = db.prepare(
      `INSERT OR REPLACE INTO photos
         (id, root_id, file_name, file_path, folder_path, file_size, file_type,
          width, height, date_taken, date_modified, has_thumbnail, is_favorite, live_still_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1, '2026-03-01 10:00:00', '2026-03-01 10:00:00', 1, 0, NULL)`,
    );
    // root 3：3 张图片（分布在 2 个目录）+ 1 条视频；再补两行**边界 file_type**
    //   · `''`（存量行就是空串）—— `'' NOT IN (视频后缀)` 为真 ⇒ 算图片；
    //   · `NULL` —— `NOT IN` 遇 NULL 得 NULL（不匹配）⇒ **两个档都不算**。
    insAgg.run(301, 3, 'a.jpg', AGG + '\\p1\\a.jpg', AGG + '\\p1', 'jpg');
    insAgg.run(302, 3, 'b.jpg', AGG + '\\p1\\b.jpg', AGG + '\\p1', 'jpg');
    insAgg.run(303, 3, 'c.jpg', AGG + '\\p2\\c.jpg', AGG + '\\p2', 'jpg');
    insAgg.run(304, 3, 'd.mp4', AGG + '\\p2\\d.mp4', AGG + '\\p2', 'mp4');
    insAgg.run(305, 3, 'e.unknown', AGG + '\\p2\\e.unknown', AGG + '\\p2', '');
    insAgg.run(306, 3, 'f.nulltype', AGG + '\\p2\\f.nulltype', AGG + '\\p2', null);
    // root 4：只有一个目录、一张图。
    insAgg.run(401, 4, 'g.png', AGG + '\\p3\\g.png', AGG + '\\p3', 'png');

    const recorded = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = function (sql) {
      recorded.push(String(sql));
      return realPrepare(sql);
    };
    let aggRows;
    try {
      // 前置：夹具上 `root_folder_stats_cache` 必须是空的，否则读到缓存就绕过被测代码。
      assert.equal(
        heavy.tryReadRootFolderStatsCache(db, { mediaType: 'image' }),
        null,
        '前置：夹具上不许有根目录统计缓存，否则这一节测的是缓存不是聚合',
      );
      const byId = (rows) =>
        Object.fromEntries(
          rows
            .filter((r) => r.id === 3 || r.id === 4)
            .map((r) => [r.id, { p: r.photo_count, f: r.folder_count, v: r.video_count }]),
        );

      aggRows = heavy.runGetRootFoldersAgg(db, { mediaType: 'image' });
      assert.deepEqual(
        byId(aggRows),
        { 3: { p: 4, f: 2, v: 0 }, 4: { p: 1, f: 1, v: 0 } },
        '🔴 「仅图片」档的逐根聚合值错了：root 3 应为 4 张（3 jpg + 空 file_type）/ 2 个目录 / 0 视频；' +
          'NULL file_type 那一行两档都不算',
      );
      aggRows = heavy.runGetRootFoldersAgg(db, { mediaType: 'video' });
      assert.deepEqual(
        byId(aggRows),
        { 3: { p: 1, f: 1, v: 1 }, 4: { p: 0, f: 0, v: 0 } },
        '「视频」档的逐根聚合值错了（root 3 只该有 1 条 mp4）',
      );
      aggRows = heavy.runGetRootFoldersAgg(db, {});
      assert.deepEqual(
        byId(aggRows),
        { 3: { p: 6, f: 2, v: 1 }, 4: { p: 1, f: 1, v: 0 } },
        '「所有媒体」档的逐根聚合值错了（root 3 应是 6 行：4 图 + 1 空 file_type + 1 NULL）',
      );
    } finally {
      db.prepare = realPrepare;
    }

    // 形状断言 ①：两条**媒体档**查询必须钉住部分索引。
    //    为什么不能只靠计划断言：小夹具上规划器**会**自己选中那条部分索引，而真库上它
    //    一定不会（同一形状实测 71,617 ms vs 275 ms）——「夹具上没问题、真库上慢 260 倍」
    //    是本项目反复踩过的假绿形态（见 `scan-tail-watchdog-regression` 的同一段说明）。
    const photoSelects = recorded.filter((s) => /from\s+photos/i.test(s));
    // ⚠️ 只断言**存在**，不要写「>= 6 条」：条数是实现细节（逐根 = 每根 1~2 条），
    //    换个实现就误报 —— 反向验证实测：退回整表兜底时只剩 3 条，于是先红在这条上，
    //    把真正的形状断言挡在后面。契约是「不许回表整表扫」，不是「必须查几趟」。
    assert.ok(photoSelects.length >= 1, `应录到 photos 聚合查询，实际 ${photoSelects.length}`);
    for (const sql of photoSelects) {
      // ⚠️ 判据必须**排除** `NOT IN` —— `NOT IN ('mp4'` 里含有子串 `IN ('mp4'`，
      //    用 `/IN \('mp4'/` 会把「仅图片」档的语句误判成「仅视频」档（第一次就跑红了）。
      const isVideoBranch = /IN \('mp4'/.test(sql) && !/NOT IN \('mp4'/.test(sql);
      if (isVideoBranch) {
        assert.ok(
          sql.includes('INDEXED BY ' + heavy.AGG_VIDEO_INDEX),
          '🔴 「仅视频」档的聚合没钉部分索引 ' +
            heavy.AGG_VIDEO_INDEX +
            '。SQL: ' +
            sql.replace(/\s+/g, ' ').slice(0, 160),
        );
      } else if (/NOT IN \('mp4'/.test(sql)) {
        assert.ok(
          sql.includes('INDEXED BY ' + heavy.AGG_IMAGE_INDEX),
          '🔴 「仅图片」档的聚合没钉部分索引 ' +
            heavy.AGG_IMAGE_INDEX +
            ' —— 真库上会回表 91 万行（275 ms → 71,617 ms）。SQL: ' +
            sql.replace(/\s+/g, ' ').slice(0, 160),
        );
      }
    }
    // 形状断言 ②：**任何一条都不许对本表做「非覆盖」的整表 `SCAN`**。
    //    这一条就是那个 bug 的指纹：原先那趟整表 CTE 里 `SUM(CASE WHEN 视频…)` 要
    //    `file_type`（排在缩略图 BLOB **之后**，取它只能逐行回表）、`SELECT DISTINCT`
    //    要物化 166 万行 ⇒ 真库上 60 秒都跑不完。
    //    ⚠️ 数值断言抓不住它：整表写法算出来的数**一模一样**，只是慢几十倍
    //    （反向验证实测：退回整表形状时三条数值断言全绿，只有计划断言变红）。
    // 🔴 「非覆盖整表 SCAN」判据 —— **唯一一份**，本节的自检与正式断言共用它。
    //
    // 判「整表扫」有两层坑，**两层都是靠反向构造反例才发现的假绿**（写错时全绿放行）：
    //
    //   1. **别名**：SQLite 计划里显示的是**别名**。退回的整表 CTE 写的是
    //      `FROM photos p` / `FROM photos p2` ⇒ 计划里是 `SCAN p` / `SCAN p2`。
    //      按表名写 `/SCAN photos/` ⇒ **三例全放过、判据完全失效**。
    //   2. **`USING INDEX` ≠ 不回表**：那条 CTE 的计划实际是
    //      `SCAN p USING INDEX idx_photos_agg_root_folder_image` —— 它顺着部分索引
    //      逐个索引项**回表**取 `file_type`，一样是 91 万次回表、一样慢。
    //      所以「有 USING 就放过」还是错的。
    //
    // 真正的指纹 = 对本表的**非 COVERING 整表 `SCAN`**：
    //   · `SCAN x USING COVERING INDEX i` = 遍历索引、**不回表**（COUNT 类主力，放行）
    //   · `SEARCH x USING … INDEX i (root_id=?)` = 等值定位（放行）
    //   · `SCAN x` / `SCAN x USING INDEX i` = 逐行回表，穿过缩略图 BLOB 之后的
    //     溢出页链（**要禁的**，真库上就是 60 s 跑不完的那条）
    //
    // `SCAN (subquery-1)` / `SCAN d` / `SCAN c`（CTE 名）不匹配表名分支，自动放行。
    const isNonCoveringTableScan = (d) =>
      /\bSCAN (?:photos|p\d*)\b/.test(d) && !/USING COVERING INDEX/.test(d);

    // 🔴 判据自检：先拿一条**已知必须判红**的反例 SQL 验判据本身。
    //    上面两层坑的共同点是「判据错了但全绿」——光读代码看不出来，只有反向构造反例才露。
    //    所以把反向验证**内建**在这里：反例与真实兜底 CTE 同形（`FROM photos p` /
    //    `photos p2`、无 hint、无 `root_id = ?` 等值条件）。只跑 `EXPLAIN QUERY PLAN`
    //    （**不执行**），开销可忽略。
    const counterExampleSql = `
      WITH counts AS (
        SELECT p.root_id AS id, COUNT(p.id) AS photo_count,
               COALESCE(SUM(CASE WHEN lower(replace(p.file_type, '.', '')) IN ('mp4','mov') THEN 1 ELSE 0 END), 0) AS video_count
        FROM photos p GROUP BY p.root_id
      ),
      folder_counts AS (
        SELECT d.root_id, COUNT(*) AS folder_count
        FROM (SELECT DISTINCT p2.root_id, p2.folder_path FROM photos p2) AS d
        GROUP BY d.root_id
      )
      SELECT c.id, c.photo_count, COALESCE(f.folder_count, 0) AS folder_count, c.video_count
      FROM counts c LEFT JOIN folder_counts f ON f.root_id = c.id ORDER BY c.photo_count`;
    const counterExamplePlan = realPrepare('EXPLAIN QUERY PLAN ' + counterExampleSql)
      .all()
      .map((r) => String(r.detail || ''));
    assert.ok(
      counterExamplePlan.some(isNonCoveringTableScan),
      '🔴 判据自检失败：反例（整表 CTE 形状 `FROM photos p`）理应被判红，实际被放过 —— ' +
        '说明「非覆盖整表 SCAN」判据失效（多半又漏了别名，或把 `USING INDEX` 当成了不回表），' +
        '本节其余计划断言全是**假绿**。计划: ' +
        counterExamplePlan.join(' | '),
    );

    let indexedCount = 0;
    for (const sql of photoSelects) {
      // ⚠️ better-sqlite3 在 prepare 时按 `?` 个数校验实参（`Too few parameter values were
      //    provided`），即便只是 `EXPLAIN QUERY PLAN` 也得把占位符补齐 —— 不能省 `.all(…)` 的实参。
      const placeholders = (sql.match(/\?/g) || []).length;
      const details = realPrepare('EXPLAIN QUERY PLAN ' + sql)
        .all(...new Array(placeholders).fill(0))
        .map((r) => String(r.detail || ''));
      for (const detail of details) {
        if (isNonCoveringTableScan(detail)) {
          assert.fail(
            '🔴 根目录聚合里有一条查询在整表扫 `photos` 且**不回表就取不到列**（逐行穿过缩略图' +
              '溢出页链，真库 60 s 未跑完 ⇒ 读池 120 s deadline ⇒ 前端「照片加载失败」）：' +
              '`' +
              detail +
              '` ｜ 计划: ' +
              details.join(' | ') +
              ' ｜ SQL: ' +
              sql.replace(/\s+/g, ' ').slice(0, 140),
          );
        }
      }
      if (details.some((d) => /\bSEARCH\b|USING COVERING INDEX/.test(d))) indexedCount++;
    }
    assert.ok(indexedCount > 0, '应至少有一条查询靠索引定位（SEARCH / 覆盖扫），而不是全部整表回表');
    // `name` 必须带上（侧栏按名字排序／显示），且顺序是按 name ASC。
    const names = aggRows.map((r) => r.name);
    assert.deepEqual(
      names,
      names.slice().sort((a, b) => String(a).localeCompare(String(b))),
      '根目录行必须按 name ASC 返回',
    );

    // 收尾：DROP 掉夹具索引，别影响别的断言。
    db.exec('DROP INDEX IF EXISTS ' + heavy.AGG_IMAGE_INDEX);
    db.exec('DROP INDEX IF EXISTS ' + heavy.AGG_VIDEO_INDEX);
    heavy.clearIndexCache(db);
  }

  console.log('[query-regression] PASS');
} finally {
  db.close();
}
