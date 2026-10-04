'use strict';

/**
 * 「查找相似照片」的 SQL 变量上限回归。
 *
 * 线上故障：`Error invoking remote method 'maintenance-find-similar-photos':
 * SqliteError: too many SQL variables`
 *
 * 根因是 `WHERE id IN (?,?,...,?)` 把候选 id 全部展开成宿主参数，撞上 SQLite 的
 * `SQLITE_MAX_VARIABLE_NUMBER`（本机 SQLite 3.53.0 实测 32766）。而候选集在本项目
 * 的真实量级下**必然**超标：LSH 只有 16 band × 4 bit = 256 个桶，全库平均每桶约 1.5 万张，
 * 任何照片的 16 个桶并起来就是十几万候选。所以这不是边缘情况，是必现场景。
 *
 * 本脚本做四件事：
 *   ① 自检文档里的上限常量与实测一致（换 SQLite 版本会在这里提醒）；
 *   ② 用 40000 个 id 直接验证新的 JSON 单参数写法可用、且与「分块 IN」结果逐字节一致；
 *   ③ 端到端跑 `findSimilarPhotos`：造 4 万张同 hash 照片（候选 39999 > 32766），
 *      断言不抛错、结果条数正确 —— 旧代码在这里必抛 too many SQL variables；
 *   ④ 静态守住「不许再展开 `IN (?,?,...)`」。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PhotoDatabase = require('../src/database');
const similarDetection = require('../src/main/similar-detection');
const { getDhashBuckets, hammingDistanceEarlyExit } = require('../src/main/perceptual-hash');
const { SQLITE_MAX_VARIABLES, idListPredicate, toIdListJson } = require('../src/main/sql-id-list');

/** 造一个能把旧写法打爆的候选规模：39999 个候选 > 32766 上限。 */
const FIXTURE_PHOTOS = 40000;
const DHASH = '8cc9d9c38e968ccc';

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

/** 「分块 IN」参照实现：与 json_each 结果必须逐字节一致。 */
function chunkedInQuery(db, table, columns, ids, chunkSize) {
  const out = [];
  for (let start = 0; start < ids.length; start += chunkSize) {
    const part = ids.slice(start, start + chunkSize);
    const placeholders = part.map(() => '?').join(',');
    const stmt = db.prepare(
      'SELECT ' + columns + ' FROM ' + table + ' WHERE id IN (' + placeholders + ')',
    );
    out.push(...stmt.all(...part));
  }
  return out;
}

function testDocumentedLimitMatchesReality(db) {
  const naiveInWorks = (n) => {
    const placeholders = new Array(n).fill('?').join(',');
    try {
      db.prepare('SELECT 1 WHERE 1 IN (' + placeholders + ')').all(...new Array(n).fill(1));
      return true;
    } catch (error) {
      if (!/too many SQL variables/.test(String(error.message))) throw error;
      return false;
    }
  };
  assert.equal(
    naiveInWorks(SQLITE_MAX_VARIABLES),
    true,
    'SQLITE_MAX_VARIABLES=' + SQLITE_MAX_VARIABLES + ' 应该被 SQLite 接受',
  );
  assert.equal(
    naiveInWorks(SQLITE_MAX_VARIABLES + 1),
    false,
    'SQLite 参数上限变了（不再恰好是 ' +
      SQLITE_MAX_VARIABLES +
      '）——请用 scripts 里的办法重新量，并同步更新 src/main/sql-id-list.js 的常量与注释',
  );
  console.log('  ✓ ① 文档里的上限 ' + SQLITE_MAX_VARIABLES + ' 与实测一致');
}

function testJsonIdListAgainstChunkedReference(db, ids) {
  const viaJson = db
    .prepare('SELECT id FROM photos WHERE ' + idListPredicate('id') + ' ORDER BY id')
    .all(toIdListJson(ids))
    .map((row) => row.id);
  const viaChunked = chunkedInQuery(db, 'photos', 'id', ids, 30000)
    .map((row) => row.id)
    .sort((a, b) => a - b);

  assert.equal(viaJson.length, ids.length, 'JSON 单参数应取回全部 ' + ids.length + ' 个 id');
  assert.deepEqual(viaJson, viaChunked, 'json_each 与分块 IN 的结果必须逐字节一致');
  console.log('  ✓ ② ' + ids.length + ' 个 id：JSON 单参数可用，且与分块 IN 结果一致');
}

function testJsonIdListSanitisesInput(db) {
  const rows = db
    .prepare('SELECT id FROM photos WHERE ' + idListPredicate('id') + ' ORDER BY id')
    .all(toIdListJson([1, '2', null, undefined, NaN, -5, 0, 3.7, 'x', Infinity]))
    .map((row) => row.id);
  // 夹具里只有 id 1..3。清洗后剩下 1、'2'→2、3.7→3（取整，否则 REAL 3.7 与 INTEGER 3
  // 在 SQLite 里比不相等会静默查空）。
  assert.deepEqual(rows, [1, 2, 3], '应清洗掉 null / NaN / 负数 / 0 / 非数字，小数取整');
  assert.equal(toIdListJson([]), '[]', '空数组应转成 []，不是空串');
  assert.equal(toIdListJson(null), '[]', '非数组入参应转成 []');
  assert.equal(toIdListJson(['x', null]), '[]', '全部非法时应退化成空列表');
  console.log('  ✓ ③ 脏输入被清洗，且空/非数组入参退化成 []（不会变成语法错误）');
}

async function testFindSimilarPhotosBeyondVariableLimit() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sql-id-list-'));
  const dbPath = path.join(directory, 'photos.db');
  let db;
  try {
    db = new PhotoDatabase(dbPath);
    db.ensureDhashSchema();
    const rootId = db.addRootFolder('C:\\fixture');
    const buckets = getDhashBuckets(DHASH);

    // 4 万张同 hash 照片：每张只需 1 条 LSH 行（band 0 命中候选查询的第一个条件），
    // 但候选集依然会是 39999 个 —— 这正是需要 > 32766 个宿主参数的场景。
    const insertMany = db.db.transaction(() => {
      const insertPhoto = db.db.prepare(
        `INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type,
                             width, height, dhash)
         VALUES (?, ?, ?, ?, 1, 'jpg', 1, 1, ?)`,
      );
      const insertLsh = db.db.prepare(
        'INSERT INTO photo_dhash_lsh (photo_id, band, bucket) VALUES (?, 0, ?)',
      );
      for (let i = 0; i < FIXTURE_PHOTOS; i++) {
        const info = insertPhoto.run(
          rootId,
          'C:\\fixture',
          'f' + i + '.jpg',
          'C:\\fixture\\f' + i + '.jpg',
          DHASH,
        );
        insertLsh.run(info.lastInsertRowid, buckets[0]);
      }
    });
    insertMany();

    const ids = db.db
      .prepare('SELECT id FROM photos ORDER BY id')
      .all()
      .map((row) => row.id);
    assert.equal(ids.length, FIXTURE_PHOTOS);

    // 先证明这个 fixture 真的会打爆旧写法 —— 否则下面的断言没有意义。
    const placeholders = ids.map(() => '?').join(',');
    assert.throws(
      () => db.db.prepare('SELECT id FROM photos WHERE id IN (' + placeholders + ')').all(...ids),
      /too many SQL variables/,
      'fixture 必须真的超过 ' + SQLITE_MAX_VARIABLES + ' 个参数，否则这条回归没有牙齿',
    );

    // 再证明新写法能扛住。旧代码在这里必抛错。
    const target = ids[0];
    const similar = similarDetection.findSimilarPhotos(db, target, 12);
    assert.equal(
      similar.length,
      FIXTURE_PHOTOS - 1,
      '同 hash 的 ' + FIXTURE_PHOTOS + ' 张里，除自己外的 ' + (FIXTURE_PHOTOS - 1) + ' 张都应命中',
    );
    assert.ok(!similar.includes(target), '结果不应包含自己');
    assert.equal(new Set(similar).size, similar.length, '结果不应有重复 id');

    // 阈值收紧到 0 时，同 hash 仍然全中（汉明距离 0）—— 顺手确认过滤逻辑没被改坏。
    assert.equal(similarDetection.findSimilarPhotos(db, target, 0).length, FIXTURE_PHOTOS - 1);
    // 换一张 dhash 完全不同的照片，候选能进但全部被汉明距离挡掉。
    const other = db.db.prepare('SELECT id FROM photos ORDER BY id DESC LIMIT 1').get().id;
    db.db.prepare('UPDATE photos SET dhash = ? WHERE id = ?').run('ffffffffffffffff', other);
    assert.equal(
      hammingDistanceEarlyExit(DHASH, 'ffffffffffffffff', 12) <= 12,
      false,
      '前提：两个 hash 的距离应大于阈值',
    );
    assert.equal(similarDetection.findSimilarPhotos(db, other, 12).length, 0);

    console.log(
      '  ✓ ④ findSimilarPhotos 在 ' +
        (FIXTURE_PHOTOS - 1) +
        ' 个候选（>' +
        SQLITE_MAX_VARIABLES +
        '）下返回 ' +
        similar.length +
        ' 条且不抛错',
    );
  } finally {
    if (db) db.close();
    await removeTemporaryDirectory(directory);
  }
}

function testNoSqlVariableExpansionInSource() {
  const targets = ['src/main/similar-detection.js', 'src/main.js'];
  const root = path.join(__dirname, '..');
  for (const relative of targets) {
    const raw = fs.readFileSync(path.join(root, relative), 'utf8');
    // 只看代码，注释里保留「以前是这么写的」说明不算违规。
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const expansionPattern = /return\s+'\?'\s*;?\s*\}?\s*\)?\s*\.join\(','\)/;
    assert.equal(
      expansionPattern.test(code),
      false,
      relative + ' 里又出现了「把 id 展开成 IN (?,?,...)」的写法；请改用 src/main/sql-id-list.js',
    );
    assert.ok(
      code.includes('sql-id-list') || code.includes('idListPredicate'),
      relative + ' 应当使用 src/main/sql-id-list.js 的 idListPredicate/toIdListJson',
    );
  }
  console.log('  ✓ ⑤ 静态守住：两个文件都不再把 id 展开成 IN (?,?,...)');
}

async function run() {
  console.log('SQL 宿主参数上限 / 查找相似照片 回归');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sql-id-list-small-'));
  const dbPath = path.join(directory, 'photos.db');
  let db;
  try {
    db = new PhotoDatabase(dbPath);
    const rootId = db.addRootFolder('C:\\test');
    for (let i = 1; i <= 3; i++) {
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\test',
        fileName: 'photo-' + i + '.jpg',
        filePath: 'C:\\test\\photo-' + i + '.jpg',
        fileSize: 1,
        fileType: 'jpg',
        width: 1,
        height: 1,
      });
    }

    testDocumentedLimitMatchesReality(db.db);
    testJsonIdListSanitisesInput(db.db);
    testJsonIdListAgainstChunkedReference(db.db, []); // 空列表不应抛错
  } finally {
    if (db) db.close();
    await removeTemporaryDirectory(directory);
  }

  await testFindSimilarPhotosBeyondVariableLimit();

  const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sql-id-list-bulk-'));
  let bulk;
  try {
    bulk = new PhotoDatabase(path.join(bulkDir, 'photos.db'));
    const rootId = bulk.addRootFolder('C:\\bulk');
    const insert = bulk.db.prepare(
      `INSERT INTO photos (root_id, folder_path, file_name, file_path, file_size, file_type,
                           width, height)
       VALUES (?, 'C:\\bulk', ?, ?, 1, 'jpg', 1, 1)`,
    );
    const tx = bulk.db.transaction(() => {
      for (let i = 0; i < 40000; i++) insert.run(rootId, 'b' + i + '.jpg', 'C:\\bulk\\b' + i + '.jpg');
    });
    tx();
    const manyIds = bulk.db.prepare('SELECT id FROM photos ORDER BY id').all().map((r) => r.id);
    assert.equal(manyIds.length, 40000);
    assert.ok(manyIds.length > SQLITE_MAX_VARIABLES, '批量夹具应超过参数上限');
    testJsonIdListAgainstChunkedReference(bulk.db, manyIds);
  } finally {
    if (bulk) bulk.close();
    await removeTemporaryDirectory(bulkDir);
  }

  testNoSqlVariableExpansionInSource();
  console.log('SQL 宿主参数上限 / 查找相似照片 回归 全部通过');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
