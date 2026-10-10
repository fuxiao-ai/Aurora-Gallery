'use strict';
// tag 倒排索引（`src/ai/tag-index-store.js`）的守护。
//
// 这一层是 tag 检索路的**存储侧**：词表（M0）说「该查哪些标签」，这里说「标签落在哪张图上」。
// 它出错的方式和词表一样**静默** —— 界面不报错，只是搜出来少了、或者搜出一批不该有的。
//
// ## 钉六类错
//
//   ① **表结构与计划不符**。`photo_tag` 必须是 `WITHOUT ROWID` + PK `(photo_id, tag_id)`，
//      倒排索引必须是 `(tag_id, score DESC)` —— 少了 `DESC` 或把列顺序写反，查询会退化成
//      全表扫描（**结果还对**，只是从毫秒变几十秒，属于最难发现的一类退化）。
//   ② **`tag_id` 不是 JoyTag 输出下标**。如果用自增，重建一次索引 id 就全漂，
//      而 `test` 仍然全绿 —— 因为没有任何地方断言过 id 的含义。这里对着标签表逐值比对。
//   ③ **凭证缺失**。`source_spec` / `engine` 是「这批行是拿什么打的」的唯一记录；
//      缺了它，M5 换缩略图规格之后**无法分辨哪些行要重打**（只能整库重来）。
//      所以 `put()` 必须强制要求，且不许出现「有 tags 行、没有 tag_photo 行」的孤儿。
//   ④ **重复行 / 残影**。同一张图重打必须幂等：既不产生重复行，也不留下这一版已经没有的标签。
//   ⑤ **量化口径**。`floor(p×100) ≥ t ⟺ p ≥ t/100` 这条等价性是「用整数比较代替浮点比较」
//      的全部依据；换成 `round` 会在 0.4999 这类值上多放进一张。见下面 property 断言。
//   ⑥ **两处阈值漂开**。产品查询线 `TAG_ROUTE_THRESHOLD` 必须与词表覆盖率快照的
//      `threshold` 一致 —— 否则就是「词表在 0.55 上验证过、产品却按另一个数在查」。
//
// ## 反向验证（证明断言不是恒真）
// 结构断言抽成了 `assertStructure(db)`，最后拿一个**故意做错的夹具库**（PK 顺序反了、
// 没有 WITHOUT ROWID、索引少了 DESC）跑同一组断言，必须全部被抓到。
// 一个永远绿的守护比没有守护更糟 —— 它把「假绿」变成了可引用的证据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const STORE_FILE = path.join(ROOT, 'src', 'ai', 'tag-index-store.js');
const COVERAGE_FILE = path.join(__dirname, 'tag-vocab-coverage.json');

const {
  TagIndexStore,
  TAG_INDEX_SCHEMA_VERSION,
  STORE_MIN_SCORE,
  TAG_ROUTE_THRESHOLD,
  TAG_ROUTE_RANGE,
  quantize,
  tagIdOf,
} = require(STORE_FILE);
const tagLabels = require(path.join(ROOT, 'src', 'ai', 'tag-labels.js'));

/** 结构断言：抽成函数是为了能拿「故意做错的夹具库」反向验证它真的会红。 */
function assertStructure(db, where) {
  const sqlOf = (name) => {
    const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
    return row ? String(row.sql) : '';
  };

  const pt = sqlOf('photo_tag');
  assert.ok(pt, where + '：缺少表 photo_tag');
  assert.match(pt, /WITHOUT\s+ROWID/i, where + '：photo_tag 必须是 WITHOUT ROWID（省 2~3 字节/行 × 上亿行）');

  const pk = db
    .prepare('PRAGMA table_info(photo_tag)')
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  assert.deepEqual(
    pk,
    ['photo_id', 'tag_id'],
    where + '：photo_tag 的主键必须是 (photo_id, tag_id) 且顺序如此，实际 ' + JSON.stringify(pk),
  );

  const ix = db.prepare('PRAGMA index_xinfo(idx_tag_score)').all().filter((c) => c.key);
  assert.ok(ix.length >= 2, where + '：缺少倒排索引 idx_tag_score');
  assert.equal(ix[0].name, 'tag_id', where + '：idx_tag_score 第一列必须是 tag_id');
  assert.equal(ix[1].name, 'score', where + '：idx_tag_score 第二列必须是 score');
  assert.equal(
    ix[1].desc,
    1,
    where + '：idx_tag_score 的 score 必须 DESC —— 少了 DESC 结果还对、但「按标签取前 N」会退化成全扫',
  );

  const tv = db.prepare('PRAGMA index_list(tag_vocab)').all();
  assert.ok(
    tv.some((i) => i.unique === 1),
    where + '：tag_vocab.tag 必须有 UNIQUE（否则同一标签能有多个 id，join 会重复计数）',
  );
}

const tmpFiles = [];
function tempStore() {
  const p = path.join(os.tmpdir(), 'aurora-tag-index-guard-' + process.pid + '-' + tmpFiles.length + '.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(p + suffix, { force: true });
    } catch (_) {}
  }
  tmpFiles.push(p);
  return { path: p, store: new TagIndexStore(p) };
}
function cleanup() {
  for (const p of tmpFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(p + suffix, { force: true });
      } catch (_) {}
    }
  }
}

function run() {
  // ---------- ⑥ 两处阈值不许漂 ----------
  assert.ok(fs.existsSync(COVERAGE_FILE), '缺少词表覆盖率快照 ' + path.relative(ROOT, COVERAGE_FILE));
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  assert.equal(
    coverage.threshold,
    TAG_ROUTE_THRESHOLD,
    '产品查询线 ' + TAG_ROUTE_THRESHOLD + ' 与词表覆盖率快照的 threshold ' + coverage.threshold +
      ' 不一致 —— 快照是在另一个阈值上验证的，改查询线必须重跑 run-tag-vocab-validate.js',
  );
  assert.ok(
    TAG_ROUTE_RANGE.min < TAG_ROUTE_THRESHOLD && TAG_ROUTE_THRESHOLD <= TAG_ROUTE_RANGE.max,
    'TAG_ROUTE_THRESHOLD 必须落在 TAG_ROUTE_RANGE 内',
  );
  assert.ok(TAG_ROUTE_RANGE.min > 0, 'TAG_ROUTE_RANGE.min 不许是 0 —— 0 会把几百个噪声标签全放进来');
  assert.ok(
    STORE_MIN_SCORE < TAG_ROUTE_RANGE.min,
    '入库线 ' + STORE_MIN_SCORE + ' 必须明显低于可调范围下限 ' + TAG_ROUTE_RANGE.min +
      '，否则「存的时候就把本来能命中的行丢了」',
  );
  assert.equal(TAG_INDEX_SCHEMA_VERSION, 1, '拿到新 schema 版本时要顺手复核结构断言还够不够');

  // ---------- ⑤ 量化口径：floor(p×100) ≥ t ⟺ p ≥ t/100 ----------
  // 这条等价性是「整数比较代替浮点比较」的全部依据，用穷举把它钉死。
  for (let t = 1; t <= 99; t += 1) {
    for (let k = 0; k <= 2000; k += 1) {
      const p = k / 2000; // 0 … 1，步长 5e-4
      assert.equal(
        quantize(p) >= t,
        p * 100 >= t,
        '量化等价性被破：p=' + p + ' t=' + t + ' quantize=' + quantize(p),
      );
    }
  }
  assert.equal(quantize(0.4999), 49, '必须 floor：0.4999 不能变成 0.5（换成 round 会多放进一张）');
  assert.equal(quantize(0.5), 50, '概率恰为查询线时必须算命中（floor(50) = 50）');
  assert.equal(quantize(0.999999), 99);
  assert.equal(quantize(1), 100);
  assert.equal(quantize(0), 0);
  assert.equal(quantize(NaN), 0, 'NaN 不能变成有效分');
  assert.equal(quantize(-1), 0);

  // ---------- ①②③④ 真实存储 ----------
  const { store } = tempStore();
  try {
    assertStructure(store.db, '真实建库');
    assert.equal(store.getMeta('schema_version'), String(TAG_INDEX_SCHEMA_VERSION), 'init() 必须写入 schema_version');

    // ② tag_id 必须等于 JoyTag 输出下标
    const tag = 'school_uniform';
    const expectedId = tagLabels.indexOf(tag);
    assert.ok(expectedId >= 0, '夹具前提：' + tag + ' 必须在标签表里');
    assert.equal(tagIdOf(tag), expectedId, 'tagIdOf 必须返回标签表下标');
    assert.equal(tagIdOf('definitely_not_a_real_tag'), null, '不存在的标签必须返回 null，不许编一个 id');

    // ③ put 必须先要凭证
    assert.throws(
      () => store.put(1, [[tag, 0.9]]),
      /TAG_INDEX_PROVENANCE_REQUIRED/,
      '③ 缺 source_spec / engine 时必须拒绝写入',
    );

    // 正常写入 + 未知标签必须被计数（静默 0 命中的来源要能被看见）
    const r1 = store.put(1, [[tag, 0.91], ['definitely_not_a_real_tag', 0.99], ['maid', 0.2], ['bikini', 0.14]], {
      sourceSpec: 'thumb:0:',
      engine: 'guard',
    });
    assert.equal(r1.stored, 2, '只有 ≥ STORE_MIN_SCORE 且标签存在的才入库（0.91 / 0.2）');
    assert.equal(r1.skippedUnknown, 1, '标签表里没有的标签必须被计数');
    assert.equal(
      store.db.prepare('SELECT tag_id FROM tag_vocab WHERE tag = ?').get(tag).tag_id,
      expectedId,
      '② 落库的 tag_id 必须是 JoyTag 输出下标，不是自增',
    );

    // ④ 幂等：同一张图重打，行数不变；且**这一版没有的标签必须消失**（不留残影）
    const before = store.status().pairs;
    store.put(1, [[tag, 0.91], ['maid', 0.2]], { sourceSpec: 'thumb:0:', engine: 'guard' });
    assert.equal(store.status().pairs, before, '重打同一张图不许改变行数');
    store.put(1, [[tag, 0.91]], { sourceSpec: 'thumb:0:', engine: 'guard' });
    assert.equal(store.status().pairs, before - 1, '这一版没给的标签必须被删掉，否则「按标签取图」会命中和当前状态不符的行');

    // ③ 孤儿：不许有 photo_tag 行而没有 tag_photo 行
    store.db.prepare('DELETE FROM tag_photo WHERE photo_id = 1').run();
    assert.ok(store.status().orphans > 0, '反向验证：删掉 tag_photo 之后孤儿检查必须能看见它');
    store.put(1, [[tag, 0.91]], { sourceSpec: 'thumb:0:', engine: 'guard' });

    // ---------- 查询语义 ----------
    store.put(2, [[tag, 0.80], ['skirt', 0.60]], { sourceSpec: 'thumb:0:', engine: 'guard' });
    store.put(3, [[tag, 0.99]], { sourceSpec: 'thumb:0:', engine: 'guard' });
    store.put(4, [['skirt', 0.70]], { sourceSpec: 'thumb:0:', engine: 'guard' });

    // any = 并集 + 取最大分。得分：3 = 0.99、1 = 0.91、2 = max(0.80, 0.60) = 0.80、4 = 0.70
    const any = store.query({ tags: [tag, 'skirt'], mode: 'any' }, { threshold: 0.55 });
    assert.deepEqual(
      any.photos.map((x) => x.id),
      [3, 1, 2, 4],
      'any 模式：并集、打分取最大分、按分降序',
    );
    assert.deepEqual(
      any.photos.find((x) => x.id === 2).tags.sort(),
      ['skirt', tag].sort(),
      'any 模式要回填「因为哪几个标签上榜」，且标签必须自己也达线',
    );
    assert.deepEqual(any.photos.find((x) => x.id === 4).tags, ['skirt'], '只靠 skirt 上榜的图不许挂着另一个标签');

    // all = 交集 + 取最小分
    const all = store.query({ tags: [tag, 'skirt'], mode: 'all' }, { threshold: 0.55 });
    assert.deepEqual(all.photos.map((x) => x.id), [2], 'all 模式必须只留下两个标签都达标的图');
    assert.equal(all.photos[0].score, 0.6, 'all 模式打分取最小分（短板）');

    // 阈值抬高会把边界那张挡掉
    assert.deepEqual(
      store.query({ tags: [tag], mode: 'any' }, { threshold: 0.92 }).photos.map((x) => x.id),
      [3],
      '阈值必须真的生效',
    );

    // missing：词条里标签表没有的词要能被看见（界面据此提示）
    const miss = store.query({ tags: [tag, 'definitely_not_a_real_tag'], mode: 'any' }, { threshold: 0.55 });
    assert.deepEqual(miss.missing, ['definitely_not_a_real_tag'], 'missing 必须报出标签表里没有的词');
    assert.deepEqual(miss.tags, [tag], 'missing 的词不参与查询');

    // 空词条：不许抛，返回空结果
    const empty = store.query({ tags: [], mode: 'any' }, { threshold: 0.55 });
    assert.deepEqual(empty.photos, [], '空词条必须返回空结果而不是抛');
    assert.equal(empty.truncated, false);

    // LIMIT 与 truncated 同口径（只表示受上限限制）
    const lim = store.query({ tags: [tag], mode: 'any' }, { threshold: 0.55, limit: 2 });
    assert.equal(lim.photos.length, 2, 'limit 必须生效');
    assert.equal(lim.truncated, true, 'limit 生效时必须报 truncated');
  } finally {
    store.close();
  }

  // ---------- schema 版本不符必须抛（不许静默按新结构用老库） ----------
  const { path: p2, store: s2 } = tempStore();
  s2.setMeta('schema_version', '999');
  s2.close();
  assert.throws(
    () => new TagIndexStore(p2),
    /TAG_INDEX_SCHEMA_MISMATCH/,
    'schema 版本不符必须抛，不许把老库当新库用',
  );
  const p2Clean = p2;
  const db2 = new Database(p2Clean);
  db2.prepare("UPDATE tag_meta SET value = '1' WHERE key = 'schema_version'").run();
  db2.close();
  // 修好之后必须能正常打开（证明上面的抛出来自版本比对，不是构造函数本来就会炸）
  const reopened = new TagIndexStore(p2Clean);
  assert.equal(reopened.status().schemaVersion, 1);
  reopened.close();

  // ---------- 反向验证：故意做错的夹具库必须被同一组结构断言抓到 ----------
  {
    const bad = path.join(os.tmpdir(), 'aurora-tag-index-bad-' + process.pid + '.sqlite');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(bad + suffix, { force: true });
      } catch (_) {}
    }
    tmpFiles.push(bad);
    const db = new Database(bad);
    db.exec(`
      CREATE TABLE tag_vocab (tag_id INTEGER, tag TEXT);
      CREATE TABLE photo_tag (photo_id INTEGER, tag_id INTEGER, score INTEGER, PRIMARY KEY (tag_id, photo_id));
      CREATE INDEX idx_tag_score ON photo_tag(tag_id, score);
    `);
    // ① PK 顺序反了 + 没有 WITHOUT ROWID + 索引少了 DESC + tag_vocab 没有 UNIQUE
    assert.throws(() => assertStructure(db, '坏夹具'), /WITHOUT ROWID/, '反向①a：没有 WITHOUT ROWID 必须被抓到');
    // 逐个放行、暴露下一条断言，证明每一条都不是被上一条掩护的。
    // ⚠️ `DROP TABLE` 会连表上的索引一起删掉，所以每次重建表之后要**重新建索引** ——
    //    写 `DROP INDEX` 会直接报 `no such index`（这一版就是这么红的）。
    const rebuild = (pk, withoutRowid, indexSql) =>
      db.exec(
        'DROP TABLE IF EXISTS photo_tag;' +
          'CREATE TABLE photo_tag (photo_id INTEGER, tag_id INTEGER, score INTEGER,' +
          ' PRIMARY KEY (' + pk + '))' + (withoutRowid ? ' WITHOUT ROWID' : '') + ';' +
          indexSql,
      );
    rebuild('tag_id, photo_id', true, 'CREATE INDEX idx_tag_score ON photo_tag(tag_id, score);');
    assert.throws(() => assertStructure(db, '坏夹具'), /主键必须是/, '反向①b：PK 顺序反了必须被抓到');
    rebuild('photo_id, tag_id', true, 'CREATE INDEX idx_tag_score ON photo_tag(tag_id, score);');
    assert.throws(() => assertStructure(db, '坏夹具'), /必须 DESC/, '反向①c：索引少了 DESC 必须被抓到');
    rebuild('photo_id, tag_id', true, 'CREATE INDEX idx_tag_score ON photo_tag(tag_id, score DESC);');
    assert.throws(() => assertStructure(db, '坏夹具'), /UNIQUE/, '反向①d：tag_vocab.tag 没有 UNIQUE 必须被抓到');
    db.exec('CREATE UNIQUE INDEX uq_tag_vocab_tag ON tag_vocab(tag);');
    assertStructure(db, '修好的夹具');
    db.close();
  }

  console.log('[tag-index-regression] PASS');
}

try {
  run();
} finally {
  cleanup();
}
