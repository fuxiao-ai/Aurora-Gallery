'use strict';
// 标签主题分类（`src/ai/tag-categories.js`）的守护。
//
// 这份分类是标签导航页「分类 → 子类 → 标签」三级树的**唯一真相源**。它出错的方式
// 全是**静默**的：界面不报错，只是某个标签出现在错误的分类下、或者干脆掉进「其他」，
// 用户找不到就当「库里没有」。所以这里把四类错钉死：
//
//   ① **覆盖退化**。规则表被改坏（token 写错、规则顺序被调）⇒ 大批标签掉进 `other`。
//      界面上表现为「其他」分类突然变大，而没有任何报错。判据 = `other` 数量**上限**。
//      为什么是上限而不是 `=== 0`：分类是**开放**的，标签表换代一定会有没见过的词；
//      硬凑 0 只会逼出「一个标签一条特例」的不可维护写法。上限是**实测值 + 余量**，
//      规则退化几个百分点就会红。
//      ①b 上限还必须有**下界**（`OTHER_CEILING < other + 500`）—— 否则把它抬成 99999
//      就是恒真断言，而「永远接不到东西的上限」与正常上限长得一模一样（牙齿验证第 8 例）。
//   ② **结构自洽**。子类引用了不存在的顶层、子类 id 重复、树里出现无标签的空节点 ——
//      这些会让导航页渲染出点不开的节点或整块消失。
//   ③ **语义错位**。规则表的顺序是**承重**的（`school_uniform` 必须在 `school` 之前被
//      「制服」接住）。顺序被调会导致一类标签整体换分类，且不会报错 ⇒ 用**定点断言**
//      把几条承重关系钉住，改坏立刻红。
//   ④ **匹配语义退化**。规则必须按「下划线边界短语」匹配，不能退化成裸子串：
//      裸子串会让 `loli` 命中 `hololive`（`ai/tag-labels.js` 记着这个坑）。
//      判据 = 一组**必须不相等/必须相等**的配对（见下面第四组）。
//
// ## 反向验证（本文件最后一段）
//
// 末尾用**内存里改过的副本**跑同一组判据，证明它们不是恒真：
// 把某条 token 抽掉 ⇒ 必须被 ① 抓到；把 `school_uniform` 规则挪到 `school` 之后 ⇒
// 必须被 ③ 抓到；把短语匹配换成裸子串 ⇒ 必须被 ④ 抓到。
// 一个永远绿的守护比没有守护更糟 —— 它把「假绿」变成了可引用的证据。
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CATEGORIES_FILE = path.join(ROOT, 'src', 'ai', 'tag-categories.js');

const tagLabels = require(path.join(ROOT, 'src', 'ai', 'tag-labels.js'));
const cats = require(CATEGORIES_FILE);

/**
 * `other` 的数量上限。
 *
 * 实测值来自「真库 tag 索引里已出现的 1752 个标签全部落位、全量 5813 条里余下 1217 条
 * 落 other」这一状态。那 1217 条**几乎全是还没在库里出现过的冷门角色/画师人名**
 * （`hakurei_reimu` / `kagamine_rin` 这一类）—— 它们的判据需要作品名或人名清单，
 * 会随标签表换代而变，所以刻意不去追。
 *
 * ⚠️ 这个数字是**上限不是目标**：它只用来抓「规则被改坏导致覆盖退化」。
 *    真要往下压，做法是往 SERIES / 人名清单里补，补完**同时**把这里改小。
 */
const OTHER_CEILING = 1300;

/** 规则表的定点关系：`[标签, 期望子类, 为什么这条承重]`。 */
const ANCHORS = [
  ['1girl', 'count', '人数规则的承重项：`girl` 段不能先被性别规则抢走'],
  ['solo', 'count', '单段词也要落人数，不能掉进性别'],
  ['school_uniform', 'uniform', '必须在 school→indoor 之前命中，否则制服全变场景'],
  ['ooarai_school_uniform', 'uniform', '带前缀的制服变体，同样必须在 school→indoor 之前命中'],
  ['long_hair', 'hair', '外貌承重项'],
  ['black_hair', 'hair', '颜色修饰不能把标签抢走'],
  ['twintails', 'hair', '别名形态'],
  ['hairband', 'hair', 'hair* 家族里最容易误落头饰的一个'],
  ['blue_eyes', 'eyes', '眼睛承重项'],
  ['looking_at_viewer', 'gaze', '多段 gaze 词（短语匹配的受益者）'],
  ['open_mouth', 'mouth', '嘴部承重项'],
  ['smile', 'expression', '表情承重项'],
  ['thighhighs', 'legwear', '腿部穿戴'],
  ['bikini', 'swimwear', '泳装必须先于内衣'],
  ['nude', 'nudity', '成人必须先于人体/服饰，否则会被 body 抢走'],
  ['monochrome', 'palette', '色彩档'],
  ['from_above', 'angle', '视角档'],
  ['upper_body', 'shot', '景别档'],
  ['zhongli_(genshin_impact)', 'character', '`name_(作品)` 形态 ⇒ 角色（括号内含下划线）'],
  ['genshin_impact', 'series', '作品名'],
  ['hatsune_miku', 'character', '角色名'],
  ['touhou', 'series', '作品名'],
  ['simple_background', 'background', '背景档'],
  ['outdoors', 'outdoor', '室内外不能互串'],
  ['indoors', 'indoor', '室内外不能互串'],
  ['holding_sword', 'weapon', '武器必须先于手部动作'],
  ['^_^', 'emoticon', '表情符号（纯符号）'],
  [':d', 'emoticon', '表情符号（带一个字母）'],

  // 🔴 身份词当**前缀**的服饰标签 —— 这五条是牙齿验证逼出来的。
  //    第一版把「身份与职业」规则放在服饰之前，于是 `witch_hat` / `maid_uniform` /
  //    `nurse_cap` / `sailor_collar` / `police_uniform` 全被抢成「身份」，
  //    服饰节点凭空少掉一批标签，而当时**没有任何断言抓得到**
  //    （把 identity 规则挪回服饰之前，守护照样全绿 —— 牙齿验证第 4 例就是这样暴露的）。
  ['witch_hat', 'headwear', '身份词 `witch` 是服饰标签的前缀'],
  ['roswaal_mansion_maid_uniform', 'uniform', '身份词 `maid` 是服饰标签的前缀'],
  ['nurse_cap', 'headwear', '身份词 `nurse` 是服饰标签的前缀'],
  ['sailor_collar', 'accessory', '身份词 `sailor` 是服饰标签的前缀'],
  ['police_uniform', 'uniform', '身份词 `police` 是服饰标签的前缀'],
  ['military_uniform', 'uniform', '身份词 `military` 是服饰标签的前缀（这条规则在别处也有一份，两处都不许抢）'],
  ['maid_apron', 'clothes_top', '身份词 `maid` 前缀 + 围裙'],
  ['sailor_hat', 'headwear', '身份词 `sailor` 前缀 + 帽'],
  ['witch', 'identity', '身份词**本身**仍要落身份（前缀规则不能反过来吃掉它）'],
  ['nurse', 'identity', '身份词**本身**仍要落身份'],

  // 🔴 「后缀像 A、实际是 B」的陷阱 —— 2026-10-09 的真实错位（用户提问「盘腿坐为什么在媒介」）。
  //    `indian_style` 是**坐姿**（Danbooru: `implicates sitting`、Tag group = Posture，
  //    别名 `agura`／胡坐，官方译文就是「盘腿坐」），却被 `medium`（画风/技法）按 `_style`
  //    后缀收走。挪回 `medium` 或从 `posture` 删掉**都不会报错** —— `other` 只在
  //    1215 → 1216 之间挪一格，离 1300 上限还远 ⇒ 只有这条定点抓得到。
  ['indian_style', 'posture', '`_style` 后缀像画风、实际是坐姿；必须在 medium 之前被 posture 接住'],
];

/**
 * 第四组：匹配语义的配对判据 —— `[标签, 绝不许落的子类, 为什么这里会翻面]`。
 *
 * 这几条是「下划线边界短语匹配」与「裸子串匹配」的**分水岭**，全部来自实测
 * （`.workbuddy/tmp/probe-boundary-watershed.js` 拿真规则表跑两份引擎，挑出 1187 处差异
 * 里用户真看得见的那几条）。共同特征：标签名里含着一个属于别的类别的**片段**。
 *
 * ⚠️ 判据写成「不许等于某子类」而不是「必须等于某子类」，是因为这里要守的是
 *    **匹配方式**（有没有被抢走），不是最终落点 —— 落点会随规则表增补而变
 *    （`lolita_fashion` 今天就落在 `render`，明天补一条规则可能就挪走）。
 *    代价是 `forbidden` 可能被写成「一个谁也落不进去的桶」而成恒真断言 ⇒
 *    文件末尾的反向验证会用 `BARE_SUBSTRING_RULES` 把每条 `forbidden` 锚回现实。
 */
const SEMANTIC_PAIRS = [
  ['lolita_fashion', 'age', '`loli` 只是 `lolita` 的一段，边界不同 ⇒ 不许被判成年龄'],
  ['hololive', 'hand_action', '`loli` 是跨段拼出来的（holo+live）；实测裸子串还会被**单字母 token `v`** 命中'],
  ['glasses', 'body', '被 `ass` 命中 ⇒ 眼镜被当成身体部位（这句本身就是「裸子串不可用」的最好注脚）'],
  ['hatsune_miku', 'headwear', '角色名 `hatsune` 里含 `hat` ⇒ 人名不许被头饰规则抢走'],
  ['simple_background', 'body', '最常用的背景标签，被 `back` 命中 ⇒ 背景整类会塌进身体'],
  ['thighhighs', 'body', '过膝袜被 `thigh` 命中 ⇒ 腿部穿戴与腿本身必须分开'],
  ['necktie', 'body', '领带被 `neck` 命中 ⇒ 配饰与脖子必须分开'],
];

/**
 * **故意降级**的规则表：把每条 `seg`（下划线边界短语）判据换成**子串正则**。
 *
 * 它只给第四组的反向验证用 —— 拿真规则表喂**真引擎**（`cats.classifyWith`），
 * 证明「边界匹配」这件事是承重的，而不是在这里重写第二份匹配逻辑
 * （抄进守护的实现会随引擎演化而漂移，反向验证就变成自证）。
 *
 * ⚠️ token 里有 `(` `)` `.` `!` `?` `+` `*` 等正则元字符（`slip_(clothing)`、
 *    `love_live!`、`go-toubun_no_hanayome?`），**必须转义**，否则这条降级引擎会
 *    因为语法错误或误匹配而与手写的 `indexOf` 版不一致
 *    （已用 `.workbuddy/tmp/probe-pair-degrade.js` 全表 5813 条比对：差异 0）。
 */
const BARE_SUBSTRING_RULES = cats.RULES.map((r) => {
  if (!r.seg || !r.seg.length) return r;
  const escaped = r.seg.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return Object.assign({}, r, { re: new RegExp(escaped.join('|')) });
});

function run() {
  // ---- 准备：标签表与分类映射 ----
  const allLabels = tagLabels.labels();
  assert.ok(allLabels.length > 0, '标签表读不到');

  const bySub = new Map();
  for (const s of cats.SUBS) bySub.set(s.id, []);
  const unmapped = [];
  for (const label of allLabels) {
    const sub = cats.subOf(label);
    if (!bySub.has(sub)) unmapped.push(label + '→' + sub);
    else bySub.get(sub).push(label);
  }

  // ---- ① 覆盖退化 ----
  const otherCount = cats.tagsOf('other').length;
  assert.ok(
    otherCount <= OTHER_CEILING,
    '`other` 桶涨到 ' +
      otherCount +
      '（上限 ' +
      OTHER_CEILING +
      '）⇒ 规则表被改坏或覆盖退化。先跑 .workbuddy/tmp/report-tag-categories.js 看漏了什么',
  );
  // ①b 上限还必须**贴着实测值**，否则上面那条就是恒真断言。
  //
  // 牙齿验证第 8 例暴露的盲区：把 `OTHER_CEILING` 抬到 99999，① 照样全绿 ——
  // 「一个永远接不到东西的上限」和一个正常的上限长得一模一样。
  // 所以这里把上限钉成**实测值 ± 500 的带**，两个方向都要说话：
  //   · 上限比实测**大太多** ⇒ 抓不到覆盖退化（反向验证第 ① 例证明那种退化会涨 1000+）；
  //   · 上限比实测**小太多**（覆盖被改善、other 掉下来了）⇒ 上限没跟着往下压，
  //     白留了一段「谁掉进去都不报错」的真空带。
  // 500 这个数与反向验证第 ① 例的 `dropped > 500` 是**刻意咬合**的，改一处就得看另一处。
  assert.ok(
    Math.abs(OTHER_CEILING - otherCount) < 500,
    'OTHER_CEILING = ' +
      OTHER_CEILING +
      ' 与实测 other(' +
      otherCount +
      ') 相差 ' +
      Math.abs(OTHER_CEILING - otherCount) +
      '（须 < 500）⇒ 上限必须是「实测值 + 余量」：抬太大等于恒真断言，' +
      '覆盖改善后忘了改小则留下真空带。参考 .workbuddy/tmp/report-tag-categories.js',
  );
  assert.equal(unmapped.length, 0, '有标签落到了不存在的子类：' + unmapped.slice(0, 5).join('、'));

  // 全量覆盖：每个标签都在某一个子类里（把「分类是满射」这件事显式量出来，
  // 而不是靠「subOf 有兜底」隐式成立 —— 兜底坏了这里就会红）
  let total = 0;
  for (const list of bySub.values()) total += list.length;
  assert.equal(total, allLabels.length, '子类并集的标签数 ' + total + ' ≠ 标签表 ' + allLabels.length);

  // ---- ② 结构自洽 ----
  const categoryIds = new Set(cats.CATEGORIES.map((c) => c.id));
  const subIds = cats.SUBS.map((s) => s.id);
  assert.equal(new Set(subIds).size, subIds.length, '子类 id 有重复');

  // ②a **静态**检查规则表引用的子类 id（不能只在「实际落到哪」上查）。
  //     牙齿验证第 5 例暴露过这个盲区：往规则里塞一个不存在的子类 + 一个永不命中的
  //     token，动态检查（`unmapped`）恒为空 ⇒ 守护照旧全绿。规则表一旦被改坏成这样，
  //     那条规则是**静默死规则**（永远不生效），比报错还难查。
  const badRuleSubs = [];
  for (const r of cats.RULES) {
    if (!subIds.includes(r.sub)) badRuleSubs.push(r.sub);
  }
  assert.equal(
    badRuleSubs.length,
    0,
    '规则表引用了不存在的子类 id：' + [...new Set(badRuleSubs)].join('、'),
  );
  // ②b 覆盖表的值同样必须是合法子类（否则那批标签会落到 `other` 而不报错）
  const badOverrideSubs = Object.entries(cats.OVERRIDES)
    .filter(([, v]) => !subIds.includes(v))
    .map(([k, v]) => k + '→' + v);
  assert.equal(badOverrideSubs.length, 0, '覆盖表指向不存在的子类：' + badOverrideSubs.join('、'));
  // ②c 规则不许有「三种匹配方式都没给」的空转条目
  const emptyRules = cats.RULES.filter((r) => !r.re && !r.full && !(r.seg && r.seg.length));
  assert.equal(emptyRules.length, 0, '有 ' + emptyRules.length + ' 条规则没给任何匹配方式（永远不生效）');
  // ②d 每条规则都必须**真的命中过**至少一个标签（否则是死规则，属于规则表腐化）
  const fired = new Set();
  for (const label of allLabels) {
    const sub = cats.subOf(label);
    fired.add(sub);
  }
  const deadRules = cats.RULES.filter((r) => !fired.has(r.sub));
  assert.equal(
    deadRules.length,
    0,
    '有 ' +
      deadRules.length +
      ' 条规则从未命中任何标签（死规则）：' +
      deadRules.map((r) => r.sub).join('、'),
  );

  for (const s of cats.SUBS) {
    assert.ok(categoryIds.has(s.category), '子类 ' + s.id + ' 引用了不存在的顶层 ' + s.category);
    assert.ok(typeof s.label === 'string' && s.label.trim(), '子类 ' + s.id + ' 必须有兜底名');
  }
  const categorySeen = new Set();
  for (const c of cats.CATEGORIES) {
    assert.ok(typeof c.label === 'string' && c.label.trim(), '顶层 ' + c.id + ' 必须有兜底名');
    categorySeen.add(c.id);
  }
  assert.equal(
    categorySeen.size,
    cats.CATEGORIES.length,
    '顶层分类 id 有重复',
  );
  // 树：不许出现空节点（界面上会渲染成一个点不开的分组）
  const tree = cats.tree();
  for (const node of tree) {
    assert.ok(node.subs.length > 0, '顶层 ' + node.id + ' 在树里没有子类');
    for (const sub of node.subs) {
      assert.ok(sub.tagTotal > 0, '子类 ' + sub.id + ' 一个标签都没有（空节点）');
      assert.ok(subIds.includes(sub.id), '树里的子类 ' + sub.id + ' 不在 SUBS 里');
    }
  }
  // 每个子类都要在树里出现（无孤儿）
  const inTree = new Set();
  for (const node of tree) for (const sub of node.subs) inTree.add(sub.id);
  for (const id of subIds) {
    assert.ok(inTree.has(id), '子类 ' + id + ' 没有出现在 tree() 里（孤儿节点，界面点不到）');
  }

  // ---- ③ 语义错位（定点） ----
  for (const [tag, expect, why] of ANCHORS) {
    assert.ok(allLabels.includes(tag), '定点标签 ' + tag + ' 不在标签表里了（标签表换代？）');
    assert.equal(cats.subOf(tag), expect, tag + ' 应落 ' + expect + '（' + why + '）');
  }

  // ---- ④ 匹配语义（边界短语，不是裸子串） ----
  //
  // 这里只看**现场判定**。`forbidden` 值本身是否成立由文件末尾的反向验证
  // （用降级规则表跑真引擎）独立锚定 —— 两处各司其职，不重复计算。
  for (const [tag, forbidden, why] of SEMANTIC_PAIRS) {
    assert.ok(allLabels.includes(tag), '配对标签 ' + tag + ' 不在标签表里了（标签表换代？）');
    const sub = cats.subOf(tag);
    assert.notEqual(sub, forbidden, tag + ' 被判成了「' + forbidden + '」——' + why);
    assert.notEqual(sub, 'other', tag + ' 掉进了 other（' + why + '）');
  }
  assert.equal(cats.subOf('hololive'), 'series', '`hololive` 必须落作品，不能被 `loli` 抢走');

  // ---- 通用：分类必须是纯函数（同名标签两次判定必须一致） ----
  const again = new Map();
  for (const label of allLabels.slice(0, 400)) {
    const a = cats.subOf(label);
    const b = cats.subOf(label);
    assert.equal(a, b, 'subOf 不是纯函数：' + label);
    again.set(label, a);
  }

  const stats = cats.stats();
  assert.equal(
    Object.keys(stats).length,
    cats.CATEGORIES.length,
    'stats() 的键必须与顶层分类一一对应',
  );

  // ---- 反向验证：证明上面四组判据都**有牙齿** ----
  //
  // 手法：**用改过的规则表跑真正的匹配引擎**（`cats.classifyWith`）。不在这里重写一份
  // 匹配逻辑 —— 抄一份实现进守护，那份拷贝会随引擎演化而漂移，反向验证就变成自证。

  // ① 把「服饰」整条规则抽掉 ⇒ other 必须暴涨（证明上限判据不是恒真）
  {
    const stripped = cats.RULES.filter((r) => r.sub !== 'clothing');
    let dropped = 0;
    for (const label of allLabels) {
      if (cats.classifyWith(stripped, label) === 'other') dropped++;
    }
    assert.ok(
      dropped > 500,
      '抽掉「服饰」规则后只有 ' + dropped + ' 个标签掉进 other ⇒ 上限判据抓不到覆盖退化（假牙）',
    );
  }

  // ② 把「人名/作品」两类规则整块抽掉 ⇒ other 也必须明显上涨（作品与角色是第二大户）
  {
    const stripped = cats.RULES.filter((r) => r.sub !== 'character' && r.sub !== 'series');
    let dropped = 0;
    for (const label of allLabels) {
      if (cats.classifyWith(stripped, label) === 'other') dropped++;
    }
    assert.ok(
      dropped > otherCount + 300,
      '抽掉作品/角色规则后 other 只涨了 ' + (dropped - otherCount) + ' ⇒ 这两类规则没在承重',
    );
  }

  // ③ 把「制服」规则挪到「室内」之后 ⇒ 真引擎必须把 `school_uniform` 判成场景
  //
  // 这是规则表顺序里**唯一一条真正承重**的关系：`school_uniform` 同时含 `uniform` 与
  // `school` 两个短语，落在「制服」还是「室内」全看哪条规则在前。
  // ⚠️ 别把它做成 OVERRIDES：这里要守的就是「顺序」这件事本身。
  {
    const idxUniform = cats.RULES.findIndex((r) => r.seg && r.seg.includes('uniform'));
    const idxSchool = cats.RULES.findIndex((r) => r.seg && r.seg.includes('school'));
    assert.ok(idxUniform !== -1 && idxSchool !== -1, '定点断言依赖的两条规则必须都存在');
    assert.ok(
      idxUniform < idxSchool,
      '「制服」规则必须在「室内」之前（顺序是承重的：反了会让全部 `*_school_uniform` 变成场景）',
    );
    assert.equal(cats.subOf('school_uniform'), 'uniform', '`school_uniform` 应落制服');

    const reordered = cats.RULES.slice();
    const [uni] = reordered.splice(idxUniform, 1);
    const target = reordered.findIndex((r) => r.seg && r.seg.includes('school'));
    reordered.splice(target + 1, 0, uni);
    assert.equal(
      cats.classifyWith(reordered, 'school_uniform'),
      'indoor',
      '把「制服」挪到「室内」之后，真引擎仍判成制服 ⇒ 顺序不是承重的，那这条断言就是摆设',
    );
  }

  // ④ 把短语判据换成裸子串（**用真引擎跑降级规则表**）⇒ 第四组每条配对都必须翻面
  //
  // 这一段同时干两件事，缺一不可：
  //   (a) 证明第四组的判据**有牙齿** —— 匹配方式一退化，它们全会红；
  //   (b) 把每条 `forbidden` **锚回现实** —— 若它是「一个谁也落不进去的桶」，
  //       这里就凑不齐 `SEMANTIC_PAIRS.length` ⇒ 逼着人去按实测改，而不是留个恒真断言。
  {
    const stillRight = [];
    for (const [tag, forbidden] of SEMANTIC_PAIRS) {
      if (cats.classifyWith(BARE_SUBSTRING_RULES, tag) !== forbidden) stillRight.push(tag);
    }
    assert.equal(
      stillRight.length,
      0,
      '把匹配退化成裸子串后，这些配对**没有**翻面：' +
        stillRight.join('、') +
        ' ⇒ 要么它们的 forbidden 值已过期（请按实测改），要么第四组本来就是恒真断言',
    );

    // 规模：降级后判定改变的标签数必须成千 —— 证明「边界匹配」不是只护着那 7 条特例
    let divergent = 0;
    for (const label of allLabels) {
      if (cats.classifyWith(BARE_SUBSTRING_RULES, label) !== cats.subOf(label)) divergent++;
    }
    assert.ok(
      divergent > 800,
      '把匹配退化成裸子串后只有 ' +
        divergent +
        ' 个标签换了桶 ⇒ 规则表几乎不含「会被子串误伤」的词，匹配语义判据失去意义',
    );
  }

  // ⑤ 边界短语本身：`hair` 必须命中 `long_hair`，但当且仅当它落在段边界上
  {
    assert.ok(cats.phrasesOf('long_hair').has('hair'), '`long_hair` 应含短语 `hair`');
    assert.ok(cats.phrasesOf('long_hair').has('long_hair'), '跨段短语必须可用');
    assert.equal(cats.phrasesOf('hololive').has('loli'), false, '`hololive` 不该含短语 `loli`');
  }

  const catCounts = cats.CATEGORIES.map((c) => c.id + ':' + stats[c.id]).join(' ');
  console.log(
    '[tag-categories-regression] PASS —— 顶层 ' +
      cats.CATEGORIES.length +
      '、子类 ' +
      cats.SUBS.length +
      '、标签 ' +
      allLabels.length +
      '、未分类(other) ' +
      otherCount +
      '（上限 ' +
      OTHER_CEILING +
      '）；定点 ' +
      ANCHORS.length +
      ' 条；分布 ' +
      catCounts,
  );
}

run();
