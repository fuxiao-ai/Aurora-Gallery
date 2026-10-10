'use strict';
// 预选词（`ai-search-suggest`）的守护。
//
// ## 这个功能的两条路
//
// 2026-10-09 起，预选词**按入参形状分岔**（桌面端 `main.js` 的 IPC handler 与网页端
// `web-server.js` 的 `/api/ai-search-suggest` 各自分岔，判据一致）：
//
//   · `{ lang, limit }` —— **常规路径**，界面唯一的用法。主进程直接把索引库里的
//     `embeddings.tags` 转置成「词 → 有多少张图把它排进 top-3 标签」
//     （`SemanticTags.suggestTerms`）。**不起 worker、不载模型**，实测 40 ms（GROUP BY）
//     + 30 ms（分母 COUNT）≈ 70 ms。
//   · `['词', …]` / `{ candidates: […] }` —— 老契约，对**指定的**词打分。只有 worker 那条路
//     能对**词表外**的任意词真去打分（SQL 路只能在 308 词的词表里查下标，词表外的词一律 0）。
//
// ## 这份守护要钉的五件事（全是静默失效）
//
// ① **`tags_key` 过滤**。`tags` 里存的是**词表下标**，词表一改，同一个下标指向的是另一个概念
//    —— 不过滤就会把「丝袜」的位置报成别的词，**不报错、数值也像真的**。
//    这是本文件最重的一条（牙齿验证里把 `WHERE embeddings.tags_key = ?` 改成
//    `IS NOT NULL`（连带去掉绑定参数）必须精确变红）。
// ①b **同分次序**。`ORDER BY hits DESC, idx ASC` 里那截 `idx ASC` 是承重的：夹具刻意让同分的
//    那一对**写入顺序与下标顺序相反**，删掉那截实测返回 `['丝袜','校服','制服']`（同分那对反转）
//    ⇒ 精确变红。少了它，同一份库两次进搜图页就可能摆出不同的词。
// ② **`hits` 不是张数**。它是「有多少张图把该词排进 top-3 标签」（`TAG_MAX = 3` 每图只留 3 个、
//    阈值用的是 `TAG_THRESHOLD = 0.015` 而不是检索的 0.01），与「搜它能返回多少张照片」**不相等**。
//    它只用于「挡掉 0 命中」与排序。判据 = **返回条目的键集合恰好 `{text, hits}`** ——
//    形状里多一个 `count`/`matched`/`total` 就会有人拿它当张数显示，所以加了字段必须来这里改契约。
// ③ **只读 + 全量**。这条路不许出现 `semanticSearch` / `loadEncoder` / `run('suggest'` ——
//    一旦有人把它改回起 worker，用户看到的「进搜图页等 4 秒（冷启 17 秒）」就回来了，
//    而且静态检查、界面、日志**全都不会报警**。
// ④ **降级不抛**。索引库不存在 / 打不开 / 查询炸了都必须回 `{ sampled: 0, terms: [] }`，
//    界面据此把预选词整块收起（既有取向）。抛出去 = 搜图页打不开。
// ⑤ **条数上限唯一定义处**。`SUGGEST_LIMIT_DEFAULT / MAX` 同时被两条路夹取，
//    各写一份的后果是「同一个界面元素被两条路服务时条数不同」，而界面只摆 5 个
//    （`SUGGEST_COUNT`）⇒ 差 24 还是 64 **在界面上看不出来**。
//
// ## 为什么敢用真夹具库
//
// ①②④⑤ 都是**行为**，只有真跑一遍才算数（本仓的教训：结构断言读不出行为）。
// 夹具是一张只有 `(photo_id, tags, tags_key)` 三列的表 —— 与生产表同形，但不需要向量、
// 不载模型、毫秒级建好。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
/**
 * 结构断言**一律先剥注释**。本仓踩过这个坑：注释里为了讲清楚「为什么不再走老路」而提到
 * `loadEncoder` / `semanticSearch`，裸读源码的断言就会把解释当成违规 —— 于是要么被迫写得
 * 看不懂，要么把断言改成看不懂的正则。剥掉注释，断言才只对**代码**说话。
 */
const code = (relative) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const { SemanticTags } = require(path.join(ROOT, 'src', 'main', 'semantic-tags.js'));
const {
  labelsFor,
  SUGGEST_LIMIT_DEFAULT,
  SUGGEST_LIMIT_MAX,
} = require(path.join(ROOT, 'src', 'ai', 'search-vocabulary.js'));
const { TAG_LANG, vocabKey } = require(path.join(ROOT, 'src', 'ai', 'photo-tags.js'));
const { MODEL_KEY } = require(path.join(ROOT, 'src', 'ai', 'embedding.js'));

const ZH = labelsFor('zh');
const EN = labelsFor('en');
/** 生产库里 `tags_key` 与写入方（索引流程 / 补标签流程）用的**同一个**指纹算法。 */
const KEY = vocabKey(MODEL_KEY, labelsFor(TAG_LANG));
const STALE = 't1:deadbeef';

/** 按中文名取词表下标（取不到就直接炸夹具，别让 typo 变成「这个词命中 0」这种假结论）。 */
function at(label) {
  const index = ZH.indexOf(label);
  assert.ok(index >= 0, '夹具依赖的词表项不存在：' + label);
  return index;
}

/**
 * 造一份与生产同形的索引库。
 * @param {string} dir `ai-search/` 目录
 * @param {{tags:number[]|null, key?:string}[]} rows 依次分配 `photo_id = 1,2,3…`
 */
function makeIndex(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'semantic-index.sqlite'));
  db.exec('CREATE TABLE embeddings (photo_id INTEGER PRIMARY KEY, tags TEXT, tags_key TEXT)');
  const insert = db.prepare('INSERT INTO embeddings (photo_id, tags, tags_key) VALUES (?, ?, ?)');
  rows.forEach((row, i) => {
    insert.run(
      i + 1,
      row.tags === null ? null : JSON.stringify(row.tags),
      row.key === undefined ? KEY : row.key,
    );
  });
  db.close();
  return dir;
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-suggest-'));
  const sock = at('丝袜');
  // 只在**旧词表指纹**的行里出现 ⇒ 过滤生效时它必须一个都不返回（第 ① 条的主判据）。
  const staleOnly = at('比基尼');
  /**
   * 同分的那一对（各 1 命中）。
   *
   * 🔴 期望顺序 = **词表下标升序**，而夹具的**写入顺序刻意相反** —— 否则「按插入顺序」
   *    与「按下标顺序」在夹具上给出同样的结果，这条断言就是恒真的。
   */
  const tied = [
    { label: '制服', index: at('制服') },
    { label: '校服', index: at('校服') },
  ].sort((a, b) => a.index - b.index);
  assert.ok(
    new Set([sock, tied[0].index, tied[1].index]).size === 3 && tied[0].index < tied[1].index,
    '夹具前提：三个词的下标互不相同，且同分那一对可以排出先后',
  );

  // ---- ① 行为面：真夹具库上跑一遍 ----
  {
    const dir = makeIndex(path.join(root, 'main'), [
      // 三张有效行：丝袜 3 命中；同分那一对按**下标大的先写、小的后写**（与期望顺序相反）
      { tags: [sock, tied[1].index] },
      { tags: [sock, tied[0].index] },
      { tags: [sock] },
      // 旧词表指纹的行：下标对着的是**另一个词表**，一条都不许计入
      { tags: [staleOnly, staleOnly], key: STALE },
      // 没打过标（`tags` 为 NULL）：json_each(NULL) 是 0 行，不该炸也不该计数
      { tags: null },
      // 「算过但一个都没达标」：入库写的是 `'[]'`，不是 NULL
      { tags: [] },
    ]);
    const tags = new SemanticTags(dir);
    const result = tags.suggestTerms('zh-CN', 24);
    // 🔴 第 ① 条先判：这是整条路上最危险的一处静默错位（数值看着像真的、就是不报错）
    assert.equal(
      result.terms.some((t) => t.text === ZH[staleOnly]),
      false,
      '🔴 旧词表指纹的行必须整行不计入：不过滤就会把「丝袜」的位置报成别的词，且不报错',
    );
    // 一个**任何一行都没提过**的词同样不许出现（「点下去什么都没有」的词不该被摆出来）
    assert.equal(
      result.terms.some((t) => t.text === ZH[at('灯笼夜景')]),
      false,
      '在当前词表下 0 命中的词不许出现在结果里（预选词的意义就是「点下去有图」）',
    );
    assert.deepEqual(
      result.terms.map((t) => t.text),
      ['丝袜', tied[0].label, tied[1].label],
      '按命中数降序；同分按下标升序（而不是写入顺序）—— 顺序必须逐位可复现',
    );
    // ⬆ 这一条对排序键里那截 `, idx ASC` 是**有牙齿**的：夹具刻意让那一对的**写入顺序与下标
    //   顺序相反**，把 `, idx ASC` 删掉后实测返回 ['丝袜', '校服', '制服']（同分那对的次序反转）
    //   ⇒ 精确变红。所以同分次序不需要另外做结构断言去「钉实现」。
    assert.deepEqual(
      result.terms.map((t) => t.hits),
      [3, 1, 1],
      'hits 是「有多少张图把它排进 top-3」，不是张数',
    );
    assert.equal(
      result.sampled,
      5,
      'sampled 只数「词表指纹对得上」的 5 行（含 tags 为 NULL / 空数组的那两张），' +
        '不算旧指纹那 1 行 —— 与全库张数无关',
    );
    // ⑤ 形状 = 契约：多一个 `count`/`matched` 就会有人拿它当张数显示（第 ② 条的判据）
    assert.deepEqual(
      Object.keys(result.terms[0]).sort(),
      ['hits', 'text'],
      '🔴 条目只许有 {text, hits} 两个键 —— hits 不是张数，多一个像张数的键就会误导',
    );

    // ② 同一份库重跑必须逐位一致（界面「重绘不跳变」依赖它）
    assert.deepEqual(tags.suggestTerms('zh-CN', 24), result, '同一份库重跑结果逐位一致');

    // ③ 英文界面拿英文词表，**下标一一对应**（切语言不需要重算标签）
    const english = tags.suggestTerms('en', 24);
    assert.deepEqual(
      english.terms.map((t) => t.text),
      [EN[sock], EN[tied[0].index], EN[tied[1].index]],
      'en 前缀取英文词表，且与中文是同一批下标',
    );
    assert.deepEqual(
      english.terms.map((t) => t.hits),
      result.terms.map((t) => t.hits),
      '换语言不改命中数',
    );

    // ④ 只读：句柄必须是真的只读（写是 worker 的唯一职责，两个写入者会互拿 SQLITE_BUSY）
    assert.equal(tags.conn().readonly, true, '主进程这条连接必须是只读的');
    assert.deepEqual(tags.suggestTerms('zh', 1).terms.length, 1, 'limit=1 只回 1 条');
    tags.close();
  }

  // ---- ② 行为面：条数夹取（与 worker 那条路共用同一对常量）----
  {
    // 70 个词、每个都只有 1 命中 —— 同分行多到足以暴露「排序键少了 idx」这类问题
    const dir = makeIndex(
      path.join(root, 'limit'),
      ZH.slice(0, 70).map((_, i) => ({ tags: [i] })),
    );
    const tags = new SemanticTags(dir);
    const byVocabOrder = ZH.slice(0, 70);
    assert.deepEqual(
      tags.suggestTerms('zh', 9999).terms.map((t) => t.text),
      byVocabOrder.slice(0, SUGGEST_LIMIT_MAX),
      '超上限夹到 SUGGEST_LIMIT_MAX（' + SUGGEST_LIMIT_MAX + '）',
    );
    assert.equal(
      tags.suggestTerms('zh').terms.length,
      SUGGEST_LIMIT_DEFAULT,
      '不给 limit 时取 SUGGEST_LIMIT_DEFAULT（' + SUGGEST_LIMIT_DEFAULT + '）',
    );
    assert.equal(tags.suggestTerms('zh', 0).terms.length, 1, 'limit=0 夹到 1（0 条 = 界面白跑一趟）');
    assert.equal(tags.suggestTerms('zh', -3).terms.length, 1, '负数同样夹到 1');
    assert.equal(tags.suggestTerms('zh', 50).terms.length, 50, '上限之内如实返回，不截不该截的');
    tags.close();
  }

  // ---- ③ 行为面：读不到一律降级，绝不抛 ----
  {
    const missing = new SemanticTags(path.join(root, '__nope__'));
    assert.deepEqual(
      missing.suggestTerms('zh', 24),
      { sampled: 0, terms: [] },
      '索引库不存在 ⇒ 空结果（界面据此整块收起）',
    );
    // 「没建过索引」只该让这一块收起，不该让搜图页打不开 —— 第二次调用不许再去 stat 一次
    assert.equal(missing.unavailable, true, '确认读不到之后要记住，别每张图都白试一次');
    const broken = new SemanticTags(root);
    fs.writeFileSync(path.join(root, 'semantic-index.sqlite'), 'not a sqlite file');
    assert.deepEqual(
      broken.suggestTerms('zh', 24),
      { sampled: 0, terms: [] },
      '库打不开 / 查询抛错也降级成空，不许把异常冒给搜图页',
    );
    fs.unlinkSync(path.join(root, 'semantic-index.sqlite'));
  }

  // ---- ④ 结构面：两条路的分岔接线（一律对**剥掉注释**的代码断言）----
  {
    const mainSrc = code('src/main.js');
    const serverSrc = code('src/web-server.js');
    const tagsSrc = code('src/main/semantic-tags.js');
    const workerSrc = code('src/workers/semantic-worker.js');
    const vocabSrc = code('src/ai/search-vocabulary.js');

    // 桌面端：常规路径走只读 SQL，老契约仍走 worker —— 两条都在，别把任一条摘掉
    assert.match(
      mainSrc,
      /ipcMain\.handle\('ai-search-suggest', function \(_event, request\) \{[\s\S]*?suggestTermsFromTags\(request\)/,
      '桌面端常规路径必须落到 suggestTermsFromTags（只读 SQL）',
    );
    assert.match(
      mainSrc,
      /ipcMain\.handle\('ai-search-suggest', function \(_event, request\) \{[\s\S]*?semanticSearch\.run\('suggest', '', payload\)/,
      '桌面端老契约（candidates）仍要托给 worker —— 只有它能对词表外的任意词打分',
    );
    // 网页端：同一条分岔，且能力由主进程注入
    assert.match(
      serverSrc,
      /prototype\.handleAiSearchSuggest[\s\S]*?self\.getAiSuggestTerms\(payload\)/,
      '网页端常规路径必须落到注入的 getAiSuggestTerms',
    );
    assert.match(
      serverSrc,
      /withPreempt\(\(\) => self\.semanticSearch\.run\('suggest', '', scoring\)\)/,
      '网页端老契约仍要托给 worker',
    );
    assert.match(
      mainSrc,
      /getAiSuggestTerms: function \(request\) \{\s*return suggestTermsFromTags\(request\);/,
      '主进程要把预选词能力注入给网页端（与 getPhotoAiTags 同一形态）',
    );

    // 🔴 「不起 worker、不载模型」要能被静态看出来 —— 这条路里不许出现任何编码器/服务
    for (const [name, src] of [
      ['semantic-tags.js', tagsSrc],
      ['main.js#suggestTermsFromTags', /function suggestTermsFromTags[\s\S]*?\n\}/.exec(mainSrc)[0]],
    ]) {
      assert.ok(
        !/loadEncoder|semanticSearch|createWorker|new Worker/.test(src),
        name + ' 里不许出现编码器 / worker —— 这条路的意义就是不起 worker、不载模型',
      );
    }
    assert.match(
      tagsSrc,
      /FROM embeddings, json_each\(embeddings\.tags\)/,
      '统计必须是 json_each 转置（全量），不是另外扫向量',
    );
    assert.match(
      tagsSrc,
      /WHERE embeddings\.tags_key = \?/,
      '🔴 词表指纹过滤必须在 SQL 里（上面第 ① 组是它的行为判据，这条是接线判据）',
    );
    assert.match(
      tagsSrc,
      /ORDER BY hits DESC, idx ASC/,
      '同分必须显式按下标升序定序（行为判据在第 ② 组；这条只保证那截子句还在）',
    );

    // ⑤ 条数上限只许有一份定义：两条路都从 search-vocabulary 取
    assert.match(
      vocabSrc,
      /const SUGGEST_LIMIT_DEFAULT = 24;\s*const SUGGEST_LIMIT_MAX = 64;/,
      '条数上限的唯一定义处是 search-vocabulary.js',
    );
    assert.match(
      workerSrc,
      /const SUGGEST_LIMIT_DEFAULT = vocabulary\.SUGGEST_LIMIT_DEFAULT;[\s\S]{0,400}?const SUGGEST_LIMIT_MAX = vocabulary\.SUGGEST_LIMIT_MAX;/,
      'worker 那条路要引用同一个定义，不许自己再写一个数',
    );
    assert.match(
      tagsSrc,
      /SUGGEST_LIMIT_MAX,\s*\} = require\('\.\.\/ai\/search-vocabulary'\)/,
      '只读路同样引用同一个定义',
    );
    assert.ok(
      !/SUGGEST_LIMIT_MAX\s*=\s*\d/.test(workerSrc) && !/SUGGEST_LIMIT_MAX\s*=\s*\d/.test(tagsSrc),
      '两条路都不许把 24 / 64 再写一遍',
    );

    // 本守护自己必须登记进套件（否则它跑不跑没人知道）
    assert.ok(
      read('scripts/run-regressions.js').includes("'suggest-terms-regression.js'"),
      '本守护已登记进 scripts/run-regressions.js',
    );
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(
    '[suggest-terms-regression] PASS —— 两条路分岔（只读 SQL / worker 老契约）、' +
      'tags_key 过滤、0 命中挡掉、排序确定性、' +
      '条数夹取 ' +
      1 +
      '..' +
      SUGGEST_LIMIT_MAX +
      '（缺省 ' +
      SUGGEST_LIMIT_DEFAULT +
      '）、降级不抛、上限唯一定义处',
  );
}

run();
