'use strict';
// tag 词表（`src/ai/tag-vocabulary.js`）的守护。
//
// 这一份词表是 tag 检索路线的**唯一词源**：中文查询词 → danbooru 标签。
// 它出错的方式全都是**静默**的 —— 界面不报错，只是没有结果，所以必须在这里钉死。
//
// ## 钉四类错
//
//   ① 标签不存在。`tags` 里写了一个 JoyTag 标签表里没有的词 ⇒ 该词在这条路线上
//      **恒 0 命中**。这类错最像「本库没有这种图」，没有任何提示，用户只会觉得搜不出来。
//      正面教材与反面教材：「空姐」的 `flight_attendant` 在 danbooru 里有、在**这个模型的
//      5813 标签表里没有** —— 所以「空姐」必须显式 unsupported，不能写上去凑数。
//   ② `missing` 写错。把一个**其实存在**的标签声明成「缺」⇒ 白白丢掉一个可用词。
//      2026-10-07 建表第一版就写错了 34 条（`rock`/`lightning`/`selfie`/`castle`… 全都在表里，
//      只是我按家族正则扫的时候漏了）。这条断言就是那次失误的止损线。
//   ③ 词表与查询词表脱钩。`tag-vocabulary` 的键必须与 `search-vocabulary#TERMS` 的中文侧
//      **逐词对齐**：少一个 = 那个词静默失去 tag 路；多一个 = 表里躺着一个查不到的键。
//   ④ 哑词（有标签但实测恒 0 命中）。这一条靠**冻结快照**（`scripts/tag-vocab-coverage.json`，
//      由 `.workbuddy/bench/run-tag-vocab-validate.js` 在 1500 张真语料上跑出来）。
//      ⚠️ 新增/改动词条后必须**重跑那个脚本并更新快照**，否则这条断言会红 —— 这是故意的：
//      词表是本方案的 P0，不允许「加了就跑，跑没跑过没人知道」。
//
// ## 反向验证
//
// 最后一段用**内存里改过的副本**跑同一组断言，证明它们不是恒真：
// 删掉一个词的 tags ⇒ 必须被 ② 抓到；塞一个不存在的标签 ⇒ 必须被 ① 抓到。
// 一个永远绿的守护比没有守护更糟（它把「假绿」变成了可引用的证据）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const VOCAB_FILE = path.join(ROOT, 'src', 'ai', 'tag-vocabulary.js');
const COVERAGE_FILE = path.join(__dirname, 'tag-vocab-coverage.json');
const STRUCT_FILE = path.join(__dirname, 'tag-vocab-structure.json');

const tagLabels = require(path.join(ROOT, 'src', 'ai', 'tag-labels.js'));
const { TERMS, vocabFingerprint } = require(VOCAB_FILE);
const { TERMS: QUERY_TERMS } = require(path.join(ROOT, 'src', 'ai', 'search-vocabulary.js'));

/**
 * `probes.js` 的 32 个概念（图包目录名 = 零成本弱标签，有正样本计数）。
 * 这 32 个词里只有 17 个在 308 预选词表里，其余 15 个（女仆 / 护士 / 死库水 / 网袜 …）
 * 是**用户会打、界面却没预选**的词。它们必须留在表里 —— 见下面 ③b 的理由。
 * ⚠️ 这份清单是**证据**不是实现：改它等于改验收范围，得先动 `probes.js`。
 */
const EVIDENCE = [
  '制服', 'JK制服', '比基尼', '泳装', '空姐', '女仆', '黑丝', '白丝', '丝袜', '网袜',
  '旗袍', '吊带', '毛衣', '短裙', '内衣', '蕾丝', '死库水', '绳艺', '兔子', '护士',
  '圣诞', '教室', '浴室', '洗手间', '停车场', '猫', '蛋糕', '雪山', '汽车', '咖啡',
  '鲜花', '婴儿',
];

/**
 * 读标签表。走 `src/ai/tag-labels.js` 这个**唯一入口**（原来这里自己 `readFileSync`，
 * 于是「标签表是哪一版」只有守护知道，产品代码一无所知 —— 手工插一行会让全库索引
 * 下标集体后移，而所有守护照样全绿）。
 *
 * 这里只断言表自身的形状；「表是哪一版」由下面的指纹断言管。
 */
function readLabels() {
  const lines = tagLabels.labels();
  const empty = lines.findIndex((l) => l === '');
  assert.equal(empty, -1, '标签表中间不许有空行（第 ' + (empty + 1) + ' 行）');
  const labels = new Set(lines);
  assert.equal(labels.size, lines.length, '标签表不许有重复标签');
  assert.equal(
    lines.length,
    tagLabels.EXPECTED_LINES,
    '标签表行数 ' + lines.length + ' ≠ EXPECTED_LINES ' + tagLabels.EXPECTED_LINES +
      ' —— 行数就是 JoyTag 的输出维度，变了说明换了一版模型，tag 索引必须整体重建',
  );
  return labels;
}

/**
 * 结构与覆盖断言。抽成函数是为了能用「改过的副本」再跑一遍做反向验证。
 * @param {object} terms 词条表
 * @param {Set<string>} labels 模型标签表
 * @param {object|null} coverage 冻结覆盖率快照（null = 只做结构断言）
 */
function check(terms, labels, coverage) {
  const entries = Object.entries(terms);
  assert.ok(entries.length > 0, '词表不能是空的');

  let supported = 0;
  for (const [term, e] of entries) {
    const tags = Array.isArray(e.tags) ? e.tags : [];
    const missing = Array.isArray(e.missing) ? e.missing : [];

    // ① 标签必须在模型词表里
    for (const t of tags) {
      assert.ok(
        labels.has(t),
        '「' + term + '」的标签 `' + t + '` 不在 JoyTag 标签表里 —— 这个词在这条路线上会恒 0 命中',
      );
    }
    // ② missing 必须是真缺
    for (const t of missing) {
      assert.ok(
        !labels.has(t),
        '「' + term + '」把 `' + t + '` 声明成缺失，但它其实在标签表里 —— 白丢一个可用词',
      );
    }
    // 无标签必须给出理由，且不许两边都写
    if (!tags.length) {
      assert.ok(missing.length > 0, '「' + term + '」既没有标签也没有 missing 理由 —— 以后没人知道是漏了还是结论');
    }
    for (const t of tags) {
      assert.ok(!missing.includes(t), '「' + term + '」的 `' + t + '` 同时出现在 tags 与 missing 里');
    }
    // mode 只能是这两档
    if (e.mode !== undefined) {
      assert.ok(e.mode === 'any' || e.mode === 'all', '「' + term + '」的 mode 非法: ' + e.mode);
    }
    // 同一条目里不许重复标签（重复 = 打分时白算一遍，且说明是拼贴出来的）
    assert.equal(new Set(tags).size, tags.length, '「' + term + '」的 tags 里有重复项');
    if (tags.length) supported++;
  }

  // ③ 与查询词表对齐
  //
  // 方向是**单向**的：308 预选词表里的每一个都必须被覆盖（少一个 = 那个词静默失去 tag 路），
  // 但本文件**允许有额外的键**。因为检索框收的是自由词 —— 用户会打「女仆」「死库水」，
  // 而这些词不在界面的预选词表里，走的却是同一条管线。反过来卡死「不许有多余键」，
  // 就等于把「界面预选词」当成了「用户能搜的词」，这个等式本身是错的。
  const vocabKeys = new Set(Object.keys(terms));
  const queryKeys = new Set(QUERY_TERMS.map((p) => p[0]));
  const uncovered = [...queryKeys].filter((k) => !vocabKeys.has(k));
  assert.deepEqual(
    uncovered,
    [],
    '这些查询词没有被 tag 词表覆盖，会静默失去 tag 路: ' + uncovered.join(' '),
  );

  // ③b 有证据的概念一个都不能少
  //
  // `EVIDENCE` 是 `probes.js` 的 32 个概念 —— 它们用图包目录名当弱标签（`NO.053空姐`），
  // 有几十到几百张正样本，是**唯一一批有 ground truth 的用户意图**。
  // 这里只要求「词条存在」（可以是 tags 非空，也可以是显式 unsupported + 理由），
  // 不要求它可用：`黑丝`/`白丝`/`空姐` 正是台架上 tag 路打不出来的三个，
  // 它们必须以**结论**的形式留在表里，而不是从表里消失。
  const missingEvidence = EVIDENCE.filter((k) => !vocabKeys.has(k));
  assert.deepEqual(
    missingEvidence,
    [],
    '这些有正样本证据的概念在 tag 词表里查不到（可以留空，但必须留条目并写明缺什么）: ' +
      missingEvidence.join(' '),
  );

  // ④ 哑词
  //
  // 这一条分两层，因为「零命中」有两种完全不同的成因：
  //
  //   ④a 快照里必须有条目。改过词表就必须重跑语料验证（`.workbuddy/bench/run-tag-vocab-validate.js`
  //       + `report-tag-vocab.js`）并更新快照。这是**故意**让改动变麻烦的：词表是本方案的 P0，
  //       不允许「加了就跑、跑没跑过没人知道」。
  //
  //   ④b 有 ground truth 的概念不许哑。`evidence` 里那 20 来个概念的正样本来自图包目录名
  //       （`NO.053空姐`），是现成的「这张图里应该有什么」。**只有在这批图上，零命中才说明问题**：
  //       别的词零命中可能只是这个语料里没有那种内容（库里没有圣诞照，搜不出圣诞照是对的）。
  //       所以断言只下在 evidence 上，不下在全部词上 —— 把断言下在全部词上会逼人
  //       为了「让守护变绿」去给有内容的词硬凑标签，那正好是本末倒置。
  //
  //       门槛取 **0.15**（方案里 tag 倒排的入库阈值），不是 0：
  //         - 实测「停车场 → car」在 11 张停车场正样本上最大分 **0.0346** —— 比 0 大得多，
  //           但它是纯噪声，`>0` 这种门槛会放它过去。0.15 才拦得住。
  //         - 反过来说，门槛也不能更高：「蕾丝 → lace」在正样本上最大分 0.5124，
  //           已经贴着操作阈值 0.55 了；再抬高会开始误杀正确的映射。
  //       ⚠️ 弱标签有噪声（「泳装」那个图包里其实是内衣照 ⇒ 5 张正样本上 `swimsuit` 只有 0.31）。
  //          所以这条断言只用来抓「映射指向了完全不相干的标签」，不用来评价精度 —— 精度由 M4 的验收管。
  const MUTE_FLOOR = 0.15;
  if (coverage) {
    const snap = coverage.terms || {};
    const absent = [];
    for (const [term, e] of entries) {
      if (!e.tags.length) continue;
      if (!snap[term]) absent.push(term);
    }
    assert.deepEqual(
      absent,
      [],
      '这些词在覆盖率快照里没有记录 —— 改过词表就必须重跑 run-tag-vocab-validate.js 并更新快照: ' +
        absent.join(' '),
    );

    const ev = coverage.evidence || {};
    const mute = [];
    for (const term of EVIDENCE) {
      const e = terms[term];
      if (!e || !e.tags.length) continue; // 显式 unsupported 的（黑丝/白丝/空姐/停车场）不参与
      const row = ev[term];
      assert.ok(row, '「' + term + '」有正样本证据，但快照的 evidence 里没有它 —— 快照没重跑干净');
      // 负对照（雪山 / 汽车 / 咖啡 / 鲜花 / 婴儿）在这个语料里一张正样本都没有，
      // 没有观察就没有结论，跳过（它们的作用在 M4 是「误报数不许比 CLIP 多」）。
      if (!(row.positivesInCorpus > 0)) continue;
      if (!(row.maxOnPositives >= MUTE_FLOOR)) {
        mute.push(term + '(正样本 ' + row.positivesInCorpus + ' 张，max=' + row.maxOnPositives + ')');
      }
    }
    assert.deepEqual(
      mute,
      [],
      '这些概念**有正样本**，但映射的标签在正样本上连 ' +
        MUTE_FLOOR +
        ' 都到不了（哑词）—— 换标签，或降级为 unsupported: ' +
        mute.join(' '),
    );
  }

  return { total: entries.length, supported, threshold: coverage ? coverage.threshold : null, corpus: coverage ? coverage.corpus : null };
}

/**
 * 指纹断言 —— **更新机制的检测端**。
 *
 * 这条链上有两个东西会被改，而它们都需要「改了就必须重跑」这个约束：
 *
 *   1. `joytag-labels.txt`（标签表）—— 它的**顺序就是输出下标**。手工插一行，
 *      全库 tag 索引的 `tag_id` 集体后移，而所有静态断言照样全绿。
 *      代价：`tag-vocab-coverage.json` 的每个数字都是旧标签表上测的，全部作废。
 *   2. `tag-vocabulary.js#TERMS`（词表映射）—— 改了映射，覆盖率快照里的
 *      那个词就不代表现在这条映射了。
 *
 * 判据用**内容哈希**而不是手写版本号：手写版本号在「忘了抬号」时无效，而那正是要抓的时刻。
 * 抽成函数是为了能在反向验证里传改过的副本 —— 一个恒真的断言比没有断言更糟。
 */
function checkFingerprints(coverage, structure, terms) {
  const labelFp = tagLabels.fingerprint();

  assert.ok(
    coverage.labelFile,
    '覆盖率快照里没有 labelFile 指纹 —— 它测的是哪一版标签表就无从判断。' +
      '跑 report-tag-vocab.js 重新生成',
  );
  assert.equal(
    coverage.labelFile.sha256,
    labelFp.sha256,
    'joytag-labels.txt 变了，但覆盖率快照还是旧标签表上的数字 —— 标签表顺序即输出下标，' +
      '换一版这份「哪个词有内容」的结论就整体作废。' +
      '重跑：run-tag-vocab-validate.js（约 1000 s）→ report-tag-vocab.js',
  );
  assert.equal(coverage.labelFile.lines, labelFp.lines, '覆盖率快照的标签表行数与当前不符');

  assert.ok(
    fs.existsSync(STRUCT_FILE),
    '缺少结构层快照 —— 跑 node scripts/tag-vocab-rebuild.js 生成',
  );
  assert.equal(
    structure.labelFile.sha256,
    labelFp.sha256,
    '结构层快照的标签表指纹与当前不符 —— 跑 node scripts/tag-vocab-rebuild.js',
  );
  assert.equal(
    structure.vocab.fingerprint,
    vocabFingerprint(terms),
    '词表内容变了（tags / mode / missing 之一），但结构层快照没重建 —— ' +
      '跑 node scripts/tag-vocab-rebuild.js（它会顺带告诉你还要不要重跑语料）',
  );
  return labelFp;
}

function run() {
  const labels = readLabels();
  assert.ok(fs.existsSync(COVERAGE_FILE), '缺少覆盖率快照 ' + path.relative(ROOT, COVERAGE_FILE));
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  assert.equal(coverage.threshold, 0.55, '覆盖率快照的阈值口径变了，守护里的 T 也要跟着改');

  const structure = JSON.parse(fs.readFileSync(STRUCT_FILE, 'utf8'));
  const labelFp = checkFingerprints(coverage, structure, TERMS);

  const stats = check(TERMS, labels, coverage);

  // ---------- 反向验证：证明上面四条断言不是恒真 ----------
  {
    const clone = () => JSON.parse(JSON.stringify(TERMS));

    // ① 塞一个不存在的标签 ⇒ 必须被抓到
    const a = clone();
    const first = Object.keys(a)[0];
    if (!a[first].tags.length) a[first].tags = ['definitely_not_a_real_tag'];
    else a[first].tags = a[first].tags.concat(['definitely_not_a_real_tag']);
    assert.throws(() => check(a, labels, null), /不在 JoyTag 标签表里/, '① 反向验证失败：不存在的标签没被抓到');

    // ② 把一个真标签声明成缺失 ⇒ 必须被抓到
    const b = clone();
    const real = [...labels][0];
    b[first] = { tags: [], missing: [real] };
    assert.throws(() => check(b, labels, null), /其实在标签表里/, '② 反向验证失败：误报缺失没被抓到');

    // ② 变体：把可用词的 tags 删空、又不给 missing ⇒ 必须被抓到
    const c = clone();
    c[first] = { tags: [] };
    assert.throws(() => check(c, labels, null), /既没有标签也没有 missing 理由/, '② 反向验证失败：无理由的 unsupported 没被抓到');

    // ③ 删掉一个查询词 ⇒ 必须被抓到
    const d = clone();
    delete d[first];
    assert.throws(() => check(d, labels, null), /没有被 tag 词表覆盖/, '③ 反向验证失败：漏词没被抓到');

    // ④b 把一个有证据的概念在快照里标成「正样本打不出分」⇒ 必须被抓到
    const g2 = clone();
    const cov3 = JSON.parse(JSON.stringify(coverage));
    assert.ok(cov3.evidence['制服'], '「制服」应当在 evidence 里，否则这条用例是空跑');
    assert.ok(cov3.evidence['制服'].positivesInCorpus > 0, '「制服」在快照里必须有正样本，否则这条用例被跳过');
    cov3.evidence['制服'] = Object.assign({}, cov3.evidence['制服'], { maxOnPositives: 0, h50: 0, h55: 0, h60: 0 });
    assert.throws(() => check(g2, labels, cov3), /哑词/, '④b 反向验证失败：正样本打不出分没被抓到');

    // ④a 变体：词表里有、快照里没有 ⇒ 必须被抓到（改词表就要重跑语料验证）
    const cov2 = JSON.parse(JSON.stringify(coverage));
    delete cov2.terms[first];
    assert.throws(() => check(TERMS, labels, cov2), /没有记录/, '④a 反向验证失败：快照缺条目没被抓到');

    // ③b 删掉一个有证据、但不在 308 预选词表里的概念 ⇒ 必须被抓到
    //     （挑「女仆」是因为它不在 308 里，所以不会先被 ③ 拦下 —— 这条用例要单独证明 ③b 有效）
    const g = clone();
    assert.ok(!QUERY_TERMS.some((p) => p[0] === '女仆'), '「女仆」应当不在 308 预选词表里，否则这条用例被 ③ 掩护了');
    delete g['女仆'];
    assert.throws(() => check(g, labels, null), /有正样本证据的概念/, '③b 反向验证失败：有证据的概念被删了没被抓到');

    // ⑤ 指纹断言不是恒真
    //   ⑤a 覆盖率快照的标签表指纹被改（模拟「换了标签表没重测」）⇒ 必须红
    const cov4 = JSON.parse(JSON.stringify(coverage));
    cov4.labelFile = Object.assign({}, cov4.labelFile, { sha256: 'deadbeef'.repeat(8) });
    assert.throws(
      () => checkFingerprints(cov4, structure, TERMS),
      /覆盖率快照还是旧标签表上的数字/,
      '⑤a 反向验证失败：标签表换了但覆盖率快照没重跑，没被抓到',
    );

    //   ⑤b 结构层快照的词表指纹被改（模拟「改了映射没重建结构快照」）⇒ 必须红
    const st4 = JSON.parse(JSON.stringify(structure));
    st4.vocab = Object.assign({}, st4.vocab, { fingerprint: 'tv1:0' });
    assert.throws(
      () => checkFingerprints(coverage, st4, TERMS),
      /结构层快照没重建/,
      '⑤b 反向验证失败：词表变了但结构快照没重建，没被抓到',
    );

    //   ⑤c 反向验证的前提：指纹本身必须对映射变化敏感，否则 ⑤a/⑤b 能过只是因为「恰好相等」
    const g3 = clone();
    const probeKey = Object.keys(g3)[0];
    g3[probeKey] = Object.assign({}, g3[probeKey], {
      tags: (g3[probeKey].tags || []).concat(['cat']),
    });
    assert.notEqual(vocabFingerprint(g3), vocabFingerprint(TERMS), '指纹对 tags 变化不敏感 ⇒ 上面的断言全无效');
    const g4 = clone();
    g4[probeKey] = Object.assign({}, g4[probeKey], { mode: g4[probeKey].mode === 'all' ? 'any' : 'all' });
    assert.notEqual(vocabFingerprint(g4), vocabFingerprint(TERMS), '指纹对 mode 变化不敏感');
    assert.equal(
      vocabFingerprint(JSON.parse(JSON.stringify(TERMS))),
      vocabFingerprint(TERMS),
      '同一份词表两次算出的指纹必须相同（否则每次跑守护都会红）',
    );
  }

  console.log(
    '[tag-vocab-regression] PASS —— 词条 ' +
      stats.total +
      '、可用 ' +
      stats.supported +
      '、不可用 ' +
      (stats.total - stats.supported) +
      '；标签表 ' +
      labels.size +
      ' @ sha256 ' +
      labelFp.sha256.slice(0, 12) +
      '…；覆盖率快照语料 ' +
      stats.corpus +
      ' 张 @ T=' +
      stats.threshold +
      '；候选池 ' +
      structure.pool.selectable +
      '（剔除 ' +
      structure.pool.excluded +
      '）其中 ' +
      structure.pool.chineseNamed +
      ' 个有中文名',
  );
}

run();
