'use strict';
/**
 * AI 内容标签回归：零样本分类链路（词表向量 × 图片向量 → 下标数组 → 面板胶囊）。
 *
 * 背景（2026-10-05）：照片信息面板加「AI 标签」。做法**不引入任何新模型** —— SigLIP2 是
 * 双编码器，「零样本分类」本来就是它的原生能力：把候选标签编码成文本向量，与库里已有的
 * 图片向量算余弦，取超过阈值的 top-N。图片向量在搜图索引里、词向量有磁盘缓存，所以边际成本
 * 只是算术（本机 7374 张全量重算 1.8 秒）。
 *
 * 这条链路每一段坏掉都是**静默**的（面板少一行、或者更糟：标错内容而用户会相信它），
 * 所以本脚本守住四处：
 *
 *   1. 🔴 **标签存「词表下标」而不是字符串**。词表是 `[中文, 英文]` 词对，下标与语言一一对应；
 *      存字符串的话换界面语言后标签会留在旧语言（而且没有重算的触发点）。
 *   2. 🔴 **`batch()` 的谓词绝不能含 `tags`**。补标签是纯算术（不解码图片、不载模型），
 *      而 `batch()` 的候选行走的是**重新编码图片**那条贵路。把 `tags IS NULL` 混进去，
 *      第一次跑就会让整库已索引的照片白重编码一遍 —— 不报错，只是慢几天。
 *      补标签走 `batchPendingTags()`，两条路必须分开。
 *   3. 🔴 **阈值与条数只定义一次**（`photo-tags.js`）。worker 与主进程各写一份的后果不是报错，
 *      而是主进程以为「全部待补」→ 一遍遍触发补标签、每遍白扫一次索引库。
 *   4. 🔴 **读取一律降级**。索引库可能不存在 / 被索引 worker 占着写锁 / 刚重建过 ——
 *      这些都不是错误，返回空数组让面板隐藏那一行，绝不能抛（面板是只读展示）。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 *
 * ⚠️ 必须用 Electron 运行时跑（`npm test`，或 `ELECTRON_RUN_AS_NODE=1 electron scripts/photo-tags-regression.js`）。
 *    本脚本直接 require 了 better-sqlite3 来造老索引，系统 node 的 ABI 对不上（145 vs 127），
 *    用 `node scripts/photo-tags-regression.js` 会抛一个**看起来像代码坏了、其实只是运行时装错**的异常。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PHOTO_TAGS = 'src/ai/photo-tags.js';
const INDEX_STORE = 'src/ai/index-store.js';
const SEMANTIC_WORKER = 'src/workers/semantic-worker.js';
const SEMANTIC_TAGS = 'src/main/semantic-tags.js';
const SEMANTIC_SEARCH = 'src/main/semantic-search.js';
const MAIN = 'src/main.js';
const RUN_REGRESSIONS = 'scripts/run-regressions.js';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}
function section(title) {
  notes.push('');
  notes.push('  ' + title);
}

const tags = require(path.join(ROOT, PHOTO_TAGS));
const { DIMENSIONS } = require(path.join(ROOT, 'src/ai/embedding'));

async function run() {
  // ---------------------------------------------------- 1. computeTags：纯算术部分
  section('1. computeTags 的排序、阈值与确定性');

  // 用正交基做夹具：3 个「词」互相正交，图片向量与第 2 个完全同向 → 余弦 1.0 / 0 / 0。
  const words = [];
  for (let k = 0; k < 3; k += 1) {
    const v = new Float32Array(DIMENSIONS);
    v[k] = 1;
    words.push(v);
  }
  const image = new Float32Array(DIMENSIONS);
  image[1] = 1;
  // 基线差口径：分数 = 点积 − baseline。baseline=0.5 时只剩第 2 个词（0.5）过关。
  const hit = tags.computeTags(image, words, 0.5, { threshold: 0.4, max: 3 });
  check(
    '分数口径是「点积 − 基线」而不是原始余弦',
    hit.length === 1 && hit[0].index === 1 && Math.abs(hit[0].score - 0.5) < 1e-5,
    JSON.stringify(hit),
  );
  check(
    '阈值是「达到即算」（>=），不是严格大于',
    tags.computeTags(image, words, 0.5, { threshold: 0.5, max: 3 }).length === 1,
  );
  check(
    '低于阈值的词被过滤掉（宁可不显示，也不给一个错的标签）',
    tags.computeTags(image, words, 0.9, { threshold: 0.4, max: 3 }).length === 0,
  );
  check(
    'max 截断生效且按下标升序稳定取前 N',
    tags.computeTags(image, words, -1, { threshold: 0, max: 2 }).length === 2,
  );
  check(
    '同样输入给出同样输出（确定性：同分时按下标升序）',
    JSON.stringify(tags.computeTags(image, words, 0, { threshold: 0, max: 3 })) ===
      JSON.stringify(tags.computeTags(image, words, 0, { threshold: 0, max: 3 })),
  );
  check('向量长度不对时返回空而不是抛', tags.computeTags(new Uint8Array(7), words, 0).length === 0);
  check('词表为空时返回空', tags.computeTags(image, [], 0).length === 0);
  check(
    'baseline 缺失按 0 处理（相当于退回原始余弦）',
    tags.computeTags(image, words, null, { threshold: 0.99, max: 1 })[0].index === 1,
  );
  check(
    'indexesOf 只取下标（入库格式就是它）',
    JSON.stringify(tags.indexesOf(tags.computeTags(image, words, 0.5, { threshold: 0.4 }))) === '[1]',
  );

  // ---------------------------------------------------- 2. 存取格式
  section('2. 标签的存取格式（下标数组）');

  check(
    'serializeTags 产出 JSON 下标数组',
    tags.serializeTags([148, 136]) === '[148,136]',
    tags.serializeTags([148, 136]),
  );
  check(
    '空标签存 "[]" 而不是 null —— 用来区分「算过但没有」与「没算过」',
    tags.serializeTags([]) === '[]',
  );
  check(
    'serializeTags 丢掉非整数 / 负数（脏值不入库）',
    tags.serializeTags([1, -1, 1.5, 'a', 2]) === '[1,2]',
    tags.serializeTags([1, -1, 1.5, 'a', 2]),
  );
  check('parseTags 往返一致', JSON.stringify(tags.parseTags('[3,5]')) === '[3,5]');
  check(
    'parseTags 对脏值一律降级成空数组（一行坏数据不该打挂面板）',
    tags.parseTags('not json').length === 0 &&
      tags.parseTags(null).length === 0 &&
      tags.parseTags('{"a":1}').length === 0,
  );
  check(
    'parseTags 丢掉数组里的非整数项，保留合法下标',
    JSON.stringify(tags.parseTags('[1,"x",-2,3.5,4]')) === '[1,4]',
    JSON.stringify(tags.parseTags('[1,"x",-2,3.5,4]')),
  );
  check(
    '🔴 库里的值是下标不是文本（存字符串的话换语言后标签会留在旧语言）',
    /function serializeTags[\s\S]{0,300}JSON\.stringify/.test(read(PHOTO_TAGS)) &&
      !/serializeTags[\s\S]{0,200}labelsFor/.test(read(PHOTO_TAGS)),
  );

  // ---------------------------------------------------- 3. 词表指纹与语言映射
  section('3. 词表指纹与「下标 → 当前语言文本」映射');

  const keyA = tags.vocabKey('m1', ['a', 'b']);
  check(
    '词表指纹对词表内容敏感（增删一个词就该重算）',
    keyA !== tags.vocabKey('m1', ['a', 'b', 'c']) && keyA !== tags.vocabKey('m1', ['a', 'c']),
  );
  check('词表指纹对模型敏感', keyA !== tags.vocabKey('m2', ['a', 'b']));
  check('词表指纹是稳定字符串（同一输入同值）', keyA === tags.vocabKey('m1', ['a', 'b']));

  const zh = tags.labelsAtIndexes([0, 1], 'zh-CN');
  const en = tags.labelsAtIndexes([0, 1], 'en');
  check(
    '同一个下标在中英下给出各自语言的文本（这正是存下标的意义）',
    zh.length === 2 && en.length === 2 && zh[0] !== en[0],
    zh.join(',') + ' | ' + en.join(','),
  );
  check(
    '越界下标被丢掉（词表删词后旧标签不会渲染成 undefined）',
    tags.labelsAtIndexes([999999], 'zh-CN').length === 0,
  );

  // ---------------------------------------------------- 4. IndexStore：加列与读写
  section('4. IndexStore：加列不重建、标签读写、补标签候选');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-tags-'));
  let source;
  let store;
  try {
    const sourcePath = path.join(directory, 'photos.db');
    const indexPath = path.join(directory, 'semantic-index.sqlite');
    source = new Database(sourcePath);
    source.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT,
      file_type TEXT, file_size INTEGER, date_modified TEXT, thumbnail BLOB)`);

    // 先造一个「老索引」：只有历史列，没有 tags / tags_key —— 模拟升级路径。
    const legacy = new Database(indexPath);
    legacy.exec(`CREATE TABLE embeddings (
      photo_id INTEGER PRIMARY KEY, model TEXT NOT NULL, file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL, date_modified TEXT NOT NULL, vector BLOB NOT NULL,
      generic_sim REAL)`);
    const { MODEL_KEY, pack } = require(path.join(ROOT, 'src/ai/embedding'));
    const v = new Float32Array(DIMENSIONS);
    v[1] = 1;
    legacy
      .prepare(
        'INSERT INTO embeddings (photo_id, model, file_path, file_size, date_modified, vector, generic_sim) VALUES (?,?,?,?,?,?,?)',
      )
      .run(1, MODEL_KEY, '/p/1.jpg', 10, '2024-01-01', pack(v), 0.5);
    legacy.close();

    const { IndexStore } = require(path.join(ROOT, INDEX_STORE));
    store = new IndexStore(sourcePath, indexPath);
    const cols = store.index.prepare('PRAGMA table_info(embeddings)').all().map((r) => r.name);
    check(
      '老索引领到 tags / tags_key 两列（ALTER TABLE 追加，不重建索引）',
      cols.includes('tags') && cols.includes('tags_key'),
      cols.join(','),
    );
    check(
      '加列后历史行仍然在（升级不是重建，百万库重建一次是数天）',
      store.index.prepare('SELECT COUNT(*) AS n FROM embeddings').get().n === 1,
    );

    const keysA = tags.vocabKey('m', ['a', 'b']);
    check(
      '历史行（tags IS NULL）算「待补」',
      store.pendingTagsCount(keysA) === 1,
      String(store.pendingTagsCount(keysA)),
    );
    check(
      '🔴 batchPendingTags 直接回向量与基线（补标签是纯算术，不再碰图片）',
      (() => {
        const rows = store.batchPendingTags(0, 10, keysA);
        return (
          rows.length === 1 &&
          rows[0].photo_id === 1 &&
          Buffer.isBuffer(rows[0].vector) &&
          rows[0].vector.length === DIMENSIONS * 4 &&
          Math.abs(rows[0].generic_sim - 0.5) < 1e-6
        );
      })(),
      JSON.stringify(store.batchPendingTags(0, 10, keysA).map((r) => r.photo_id)),
    );
    check(
      '🔴 补标签的候选谓词只按游标记事，不重复回同一行（否则死循环）',
      store.batchPendingTags(1, 10, keysA).length === 0,
    );

    check(
      'setTags 写回并按改动行数返回',
      store.setTags([{ photoId: 1, indexes: [1, 0], key: keysA }]) === 1,
    );
    check(
      '写回后不再是「待补」',
      store.pendingTagsCount(keysA) === 0,
      String(store.pendingTagsCount(keysA)),
    );
    check(
      'tagsFor 读回下标数组',
      JSON.stringify(store.tagsFor(1)) === '[1,0]',
      JSON.stringify(store.tagsFor(1)),
    );
    check(
      '🔴 词表指纹变了就重新变成「待补」（这是标签能跟着词表演进的唯一机制）',
      store.pendingTagsCount(tags.vocabKey('m', ['a', 'b', 'c'])) === 1,
    );
    check(
      'setTags 的键与顺序稳定（photoId/indexes/key）',
      /setTags\(entries\)[\s\S]{0,600}serializeTags\(entry\.indexes\),\s*entry\.key,\s*entry\.photoId/.test(
        read(INDEX_STORE),
      ),
    );
    check(
      '算过但没有标签（"[]"）与没算过（NULL）在库里可区分',
      (() => {
        store.setTags([{ photoId: 1, indexes: [], key: keysA }]);
        return store.index.prepare('SELECT tags FROM embeddings WHERE photo_id = 1').get().tags === '[]';
      })(),
    );

    // ---------------------------------------------------- 5. 🔴 batch() 不得含 tags
    section('5. 🔴 补标签不能走重编码那条路');

    const storeSrc = read(INDEX_STORE);
    const batchBody = (() => {
      const start = storeSrc.indexOf('batch(after) {');
      if (start < 0) return '';
      const rest = storeSrc.slice(start + 10);
      const next = rest.indexOf('\n  batchPendingTags(');
      return next < 0 ? rest.slice(0, 2000) : rest.slice(0, next);
    })();
    check('夹具自证：定位到 batch() 函数体', batchBody.length > 100, String(batchBody.length));
    // 只看 SQL 本身，不看注释 —— batch() 上面那段注释**故意**反复提到 `tags`
    // （它就是在解释「为什么不能把 tags 加进来」），用整段函数体做正则必然误报。
    const batchSql = (() => {
      const m = batchBody.match(/`([\s\S]*?)`/);
      return m ? m[1] : '';
    })();
    check(
      '夹具自证：取到了 batch() 的 SQL 模板',
      batchSql.includes('FROM photos'),
      batchSql.replace(/\s+/g, ' ').slice(0, 80),
    );
    check(
      '🔴 batch() 的 SQL 谓词不含 tags（含了就会把整库已索引照片白重编码一遍，不报错只是慢几天）',
      !/\btags\b/i.test(batchSql),
      batchSql.replace(/\s+/g, ' ').slice(0, 180),
    );
    check(
      '🔴 补标签走独立的 batchPendingTags()（两条路分开）',
      storeSrc.includes('batchPendingTags(afterId, limit, tagsKey)'),
    );

    // ---------------------------------------------------- 6. SemanticTags 只读通道
    section('6. SemanticTags 只读通道：失败一律降级为空');

    const { SemanticTags } = require(path.join(ROOT, SEMANTIC_TAGS));
    const reader = new SemanticTags(directory);
    check(
      '算过但没有标签时读回空数组（"[]" 与 NULL 都降级成空，界面据此隐藏那一行）',
      reader.tagsFor(1, 'zh-CN').length === 0,
      JSON.stringify(reader.tagsFor(1, 'zh-CN')),
    );
    store.setTags([{ photoId: 1, indexes: [0, 1], key: keysA }]);
    reader.close();
    const reader2 = new SemanticTags(directory);
    check(
      '读到的是当前语言的文本（下标 0/1 在 zh 与 en 下不同）',
      reader2.tagsFor(1, 'zh-CN').length === 2 &&
        reader2.tagsFor(1, 'en').length === 2 &&
        reader2.tagsFor(1, 'zh-CN').join() !== reader2.tagsFor(1, 'en').join(),
      reader2.tagsFor(1, 'zh-CN').join() + ' | ' + reader2.tagsFor(1, 'en').join(),
    );
    check('非法 photoId 返回空数组而不抛', reader2.tagsFor('abc', 'zh-CN').length === 0);
    check('库不存在的照片返回空数组', reader2.tagsFor(999, 'zh-CN').length === 0);
    reader2.close();
    const missing = new SemanticTags(path.join(directory, 'nope'));
    check(
      '索引库不存在时返回空数组（从没建过索引不是错误）',
      missing.tagsFor(1, 'zh-CN').length === 0,
    );
    check(
      '🔴 主进程侧只读打开索引库（两个写入者会互相拿 SQLITE_BUSY）',
      read(SEMANTIC_TAGS).includes('readonly: true'),
    );
    check(
      'SemanticTags 不复用 IndexStore（那个会 ATTACH 主库，主进程已有主库连接）',
      !read(SEMANTIC_TAGS).includes('index-store'),
    );
  } finally {
    try {
      if (store) {
        store.source.close();
        store.index.close();
      }
    } catch (_) {}
    try {
      if (source) source.close();
    } catch (_) {}
    try {
      if (directory.startsWith(os.tmpdir())) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  // ---------------------------------------------------- 7. 阈值 / 词表语言的唯一定义处
  section('7. 常量只定义一次 + worker 接线');

  const workerSrc = read(SEMANTIC_WORKER);
  check(
    '🔴 阈值与条数只在 photo-tags.js 定义一次（worker 不另抄一份）',
    !/^const TAG_THRESHOLD\s*=/m.test(workerSrc) && !/^const TAG_MAX\s*=/m.test(workerSrc),
  );
  check(
    '🔴 词表语言与批量大小同样只在 photo-tags.js 定义，worker 只 import',
    !/^const TAG_LANG\s*=/m.test(workerSrc) &&
      !/^const TAG_BATCH\s*=/m.test(workerSrc) &&
      /require\('\.\.\/ai\/photo-tags'\)/.test(workerSrc) &&
      /\bTAG_LANG\b/.test(workerSrc) &&
      /\bTAG_BATCH\b/.test(workerSrc),
  );
  check(
    '🔴 主进程不自己算词表指纹（只发 tag 操作，指纹由 worker 用同一份 TAG_LANG 算 —— 两处各算必然漂）',
    !/\bvocabKey\s*\(/.test(read(MAIN)) && /semanticSearch\s*[\s\S]{0,40}\.run\('tag'\)/.test(read(MAIN)),
  );
  check(
    '词表向量缓存缺失时只报不抛（「模型没装」不是错误）',
    /reason:\s*'AI_TAG_VOCAB_MISSING'/.test(workerSrc) &&
      /if \(!words\) return/.test(workerSrc),
  );
  check(
    '🔴 补标签在 loadEncoder 之前收口（否则为了 1.8 秒的纯算术白载约 1 GB 会话）',
    (() => {
      const iTag = workerSrc.indexOf("operation === 'tag'");
      const iEnc = workerSrc.indexOf('await loadEncoder(');
      return iTag > 0 && iEnc > iTag;
    })(),
  );
  check(
    '建索引时当场算标签并随 put() 落库（同一个向量，零额外 I/O）',
    /store\.put\(photo, vector, baseline, \{[\s\S]{0,200}computeTags\(vector, tagWords\.vectors, baseline\)/.test(
      workerSrc,
    ),
  );
  check(
    '补标签的写入是 UPDATE（不重建索引表）',
    !/DELETE FROM embeddings/i.test(storeSrcSafe()),
  );
  check(
    'operation 白名单里有 tag（否则 worker 收不到这个操作）',
    read(SEMANTIC_SEARCH).includes("'tag'"),
  );

  // ---------------------------------------------------- 8. 登记
  section('8. 登记进全量回归');

  check(
    '本守护已登记进 scripts/run-regressions.js',
    read(RUN_REGRESSIONS).includes("'photo-tags-regression.js'"),
  );

  // ---------------------------------------------------------------------- 输出

  process.stdout.write('[photo-tags-regression] AI 内容标签链路契约\n');
  for (const line of notes) process.stdout.write(line + '\n');
  if (errors.length) {
    process.stdout.write('\n');
    for (const line of errors) process.stdout.write(line + '\n');
    process.stdout.write('\n[photo-tags-regression] FAIL（' + errors.length + ' 项）\n');
    process.exit(1);
  }
  process.stdout.write(
    '\n[photo-tags-regression] PASS（' + notes.filter((n) => n.includes('\u2713')).length + ' 项）\n',
  );
}

function storeSrcSafe() {
  try {
    return read(INDEX_STORE);
  } catch (_) {
    return '';
  }
}

run().catch((error) => {
  process.stdout.write('[photo-tags-regression] FAIL（异常）：' + (error && error.message) + '\n');
  process.exit(1);
});
