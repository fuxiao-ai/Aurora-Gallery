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
  db.prepare('INSERT INTO root_folders VALUES (1, ?)').run('C:/photos');
  const insert = db.prepare('INSERT INTO photos VALUES (?,1,?,?,?,1,?,1,1,?,?,1,0)');
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

  console.log('[query-regression] PASS');
} finally {
  db.close();
}
