'use strict';
// tag 路 × CLIP 路的**融合层**（M4，`src/ai/tag-fusion.js`）与它的接线守护。
//
// ## 这一层为什么最需要守护
//
// 融合本身没有「报错」这种形态。tag 路会**静默不参与**（词表里有这个词但没有对应标签、
// 倒排库没建、用户在设置里关了开关、查询当场抛异常），而这四种情况和「这个查询确实没结果」
// 在界面上长得**一模一样** —— 用户唯一能得到的结论是「搜图不准」。
// 同样静默的是 `matched` 的口径：它本来是「达标总数、不受返回上限截断」，
// 融合之后如果顺手写成 `photos.length`，既有契约就被悄悄改掉了，而数字看起来还挺合理。
//
// ## 钉七类错
//
//   ① **RRF 公式与名次起点**。`rank` 必须从 **1** 起（写 0 会让 K 的语义变成「K−1」，
//      与论文、与台架读数全部对不上，而排序看起来仍然「像那么回事」）。
//   ② **`route` 归属的判据**。必须是「这一路里有没有它」，不是「哪一路分数高」——
//      两路量纲不同（CLIP 基线差 vs 标签概率），拿分数判归属会得出随库漂移的结论。
//   ③ **CLIP 路不能被截断**。直觉写法「两路各取前 200」会让结果**变少**
//      （CLIP 上限 5000 → 200），而且长得不像 bug。只有 tag 路该按 `FUSE_DEPTH` 截断。
//   ④ **`matched` / `truncated` 的口径在「tag 没参与」时必须原样透传**（见上）。
//   ⑤ **tag 独有条目的 `similarity` 必须是 `null`**，不能是 0 —— 渲染层拿它画匹配度条，
//      0 会让「没有可比分数」被画成「分数是 0」，而阈值口径会被这套外来量纲污染。
//   ⑥ **主库补行的调用面**。`photosByIds` 只在 tag 路真给出候选时才该被调，且只对该被调的次数。
//      它是最容易「白查一遍主库」的地方（一次 `IN (?,…)` + 全表主键回表 ×200）。
//   ⑦ **三份镜面文案的 reason 集合一致**（桌面整页 / 桌面右栏 / 网页端）——
//      三份谁也 require 不到谁，只改一处就会有一端**永远少说一句话**。
//
// ## 反向验证（证明断言不是恒真）
// 结构断言抽成可复用的形式，最后拿**故意做错的输入**跑同一组断言，必须被抓到：
// 先构造「`both` 在 (62,62) 上的 rrf 恰好等于 `clip` 第 1 名的 rrf」（实数与浮点都成立），
// 再用一个只按 rrf 排、丢掉后三级的比较器跑同一份数据 —— 必须与真实实现排出不同顺序。
// 一个永远绿的守护比没有守护更糟：它把「假绿」变成了可引用的证据。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const FUSION = path.join(ROOT, 'src', 'ai', 'tag-fusion.js');
const TAG_STORE = path.join(ROOT, 'src', 'ai', 'tag-index-store.js');
const WORKER = path.join(ROOT, 'src', 'workers', 'semantic-worker.js');
const MAIN = path.join(ROOT, 'src', 'main.js');
const WEB_SERVER = path.join(ROOT, 'src', 'web-server.js');
const DESKTOP_PAGE = path.join(ROOT, 'src', 'web', 'js', 'semantic-search.js');
const DESKTOP_SIDEBAR = path.join(ROOT, 'src', 'renderer', 'ai-views.js');
const WEB_SIDEBAR = path.join(ROOT, 'src', 'web', 'js', 'ai-views.js');

const fusion = require(FUSION);
const { TAG_ROUTE_RANGE } = require(TAG_STORE);

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

/**
 * 剥掉注释再匹配。本仓已有先例（`gpu-probe-regression.js`）：
 * 注释里引用的旧写法会被正则当成结构判据，于是「把旧代码写进注释」就能骗过守护。
 */
function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}

const workerSrc = stripComments(fs.readFileSync(WORKER, 'utf8'));
const mainSrc = stripComments(fs.readFileSync(MAIN, 'utf8'));
const webServerSrc = stripComments(fs.readFileSync(WEB_SERVER, 'utf8'));
const desktopPageSrc = stripComments(fs.readFileSync(DESKTOP_PAGE, 'utf8'));
const desktopSidebarSrc = stripComments(fs.readFileSync(DESKTOP_SIDEBAR, 'utf8'));
const webSidebarSrc = stripComments(fs.readFileSync(WEB_SIDEBAR, 'utf8'));

/** 造一串 `{id}`，id 从 `from` 起递增。 */
function ids(from, count) {
  return Array.from({ length: count }, (unused, index) => ({ id: from + index }));
}
/** 从 `rows` 里取出 `id` 序列。 */
function idSeq(rows) {
  return rows.map((row) => row.id);
}

function run() {
  // ---------- 常量：改它们会静默改排序，所以逐个钉死 ----------
  check('RRF 的 K 是 60', fusion.RRF_K === 60, 'K=' + fusion.RRF_K);
  check(
    'FUSE_DEPTH 落在 (0, 1000]',
    Number.isInteger(fusion.FUSE_DEPTH) && fusion.FUSE_DEPTH > 0 && fusion.FUSE_DEPTH <= 1000,
    'FUSE_DEPTH=' + fusion.FUSE_DEPTH,
  );
  // FUSE_DEPTH 同时承担一个安全职责：tag 独有条目要按 id 去主库补行，补的那条 SQL 用
  // `IN (?,…)` 展开（SQLite 参数上限 32766）。这是那个上限在**这一侧**的守门人。
  check(
    'FUSE_DEPTH 远小于 SQLite 参数上限 32766',
    fusion.FUSE_DEPTH * 4 < 32766,
    'FUSE_DEPTH * 4 = ' + fusion.FUSE_DEPTH * 4,
  );
  check('route 三个取值互异', new Set([fusion.ROUTE_TAG, fusion.ROUTE_CLIP, fusion.ROUTE_BOTH]).size === 3);

  // ---------- ① RRF 逐值：rank 从 1 起 ----------
  {
    const k = fusion.RRF_K;
    const one = fusion.fuse({ clip: ids(1, 1), tag: [] });
    assert.equal(one.rows.length, 1);
    check(
      '① 第 1 名的 rrf 是 1/(K+1)（rank 从 1 起）',
      one.rows[0].rrf === 1 / (k + 1),
      'rrf=' + one.rows[0].rrf + ' 期望 ' + 1 / (k + 1),
    );
    check('① 该条目 clipRank=1 且 tagRank=null', one.rows[0].clipRank === 1 && one.rows[0].tagRank === null);

    const both = fusion.fuse({ clip: ids(1, 3), tag: ids(1, 3) });
    check(
      '① 两路同一条时 rrf 是两项之和（不是取最大、不是平均）',
      both.rows[0].rrf === 1 / (k + 1) + 1 / (k + 1),
      'rrf=' + both.rows[0].rrf,
    );
    check('① route=both', both.rows[0].route === fusion.ROUTE_BOTH);
    check('① route=both 时两个 rank 都记着', both.rows[0].clipRank === 1 && both.rows[0].tagRank === 1);
  }

  // ---------- ② route 归属 ----------
  {
    // clip = 1..5、tag = 3..7 ⇒ 并集 1..7：both {3,4,5}、clipOnly {1,2}、tagOnly {6,7}
    const r = fusion.fuse({ clip: ids(1, 5), tag: ids(3, 5) });
    const byId = new Map(r.rows.map((row) => [row.id, row]));
    check(
      '② 只在一路里 ⇒ route 是该路',
      byId.get(1).route === fusion.ROUTE_CLIP && byId.get(7).route === fusion.ROUTE_TAG,
      'id1=' + byId.get(1).route + ' id7=' + byId.get(7).route,
    );
    check(
      '② 交集 ⇒ route=both（且每个 id 只出现一次）',
      byId.get(3).route === fusion.ROUTE_BOTH &&
        byId.get(5).route === fusion.ROUTE_BOTH &&
        r.rows.length === 7,
      'rows=' + r.rows.length,
    );
    check(
      '② 统计与 route 一致（3 both + 2 clipOnly + 2 tagOnly）',
      r.stats.both === 3 && r.stats.clipOnly === 2 && r.stats.tagOnly === 2 && r.stats.total === 7,
      JSON.stringify(r.stats),
    );
    check('② clipVisited 是全量、tagVisited 到深度', r.stats.clipVisited === 5 && r.stats.tagVisited === 5);
  }

  // ---------- ③ CLIP 不截断、只有 tag 被截断 ----------
  {
    const clipMany = fusion.fuse({ clip: ids(1, 1000), tag: [] });
    check(
      '③ CLIP 全量参与（1000 条就出 1000 行）',
      clipMany.rows.length === 1000,
      'rows=' + clipMany.rows.length,
    );
    const tagMany = fusion.fuse({ clip: [], tag: ids(10000, 300) });
    check(
      '③ tag 被截到 FUSE_DEPTH',
      tagMany.rows.length === fusion.FUSE_DEPTH && tagMany.stats.tagOnly === fusion.FUSE_DEPTH,
      'rows=' + tagMany.rows.length,
    );
    check('③ 深度外的 tag 条目一条都不出现', !idSeq(tagMany.rows).includes(10000 + fusion.FUSE_DEPTH));
    // 两路都有、且 tag 超出深度：总数应是「CLIP 全量 ∪ tag 前 depth」。
    // clip = 1..600，tag = 500..899 截到前 200 ⇒ 500..699，全落在 clip 区间里
    // ⇒ 并集 = 1..699 = 699 行（并全部 route=both）。
    const mixed = fusion.fuse({ clip: ids(1, 600), tag: ids(500, 400) });
    check(
      '③ 两路混合时总数 = CLIP 全量 ∪ tag 前 depth（699）',
      mixed.rows.length === 699,
      'rows=' + mixed.rows.length,
    );
    check(
      '③ 混合时 tag 侧超出的 200 条**没有**把 CLIP 的尾部挤掉',
      idSeq(mixed.rows).includes(600) && idSeq(mixed.rows).includes(1),
    );
  }

  // ---------- 纯 CLIP 恒等：关掉 tag 层时结果与顺序必须逐条不变 ----------
  {
    const clip = ids(7, 300);
    const r = fusion.fuse({ clip, tag: [] });
    check('纯 CLIP：顺序逐条不变', JSON.stringify(idSeq(r.rows)) === JSON.stringify(idSeq(clip)));
    check('纯 CLIP：全部 route=clip', r.rows.every((row) => row.route === fusion.ROUTE_CLIP));
    check('纯 CLIP：clipRank 就是下标 +1', r.rows.every((row, index) => row.clipRank === index + 1));
  }

  // ---------- 全序：真实的 rrf 相等必须被 tie-break 分出先后 ----------
  {
    const k = fusion.RRF_K;
    // `both` 在 (62, 62) 上的和恰等于 `clip` 第 1 名：2/(60+62) === 1/(60+1)。
    // 这不是「差不多」——在 double 上逐位相等（脚本里断言它，改 K 会当场红）。
    assert.equal(
      1 / (k + 62) + 1 / (k + 62),
      1 / (k + 1),
      '夹具前提：K=' + k + ' 下 2/(K+62) 与 1/(K+1) 必须逐位相等，否则这条用例失去意义',
    );
    const clip = ids(1, 62);
    // 61 条 tag 独有（id 1000..1060），第 62 条 tag 落在 id 62 上 ⇒ 它的 tagRank 是 62。
    const tag = ids(1000, 61).concat([{ id: 62 }]);
    const r = fusion.fuse({ clip, tag });
    const row1 = r.rows.find((row) => row.id === 1);
    const row62 = r.rows.find((row) => row.id === 62);
    check(
      'rrf 相等的前提成立（id1 与 id62 分数逐位相同）',
      row1.rrf === row62.rrf,
      row1.rrf + ' vs ' + row62.rrf,
    );
    check('全序：rrf 相等时 clipRank 小的在前', row1.clipRank < row62.clipRank);
    check(
      '全序：真实输出把 id1 排在 id62 前',
      r.rows.indexOf(row1) < r.rows.indexOf(row62),
      'pos1=' + r.rows.indexOf(row1) + ' pos62=' + r.rows.indexOf(row62),
    );
    /**
     * 输出必须**符合规格**：用一份独立写出来的四级比较器重排，结果必须是同一个数组。
     *
     * 这条才是真的在测「排序对不对」——若 `fuse` 返回未排序或按别的键排的输出，重排就会变。
     */
    const spec = (a, b) => {
      if (b.rrf !== a.rrf) return b.rrf - a.rrf;
      const ac = a.clipRank == null ? Infinity : a.clipRank;
      const bc = b.clipRank == null ? Infinity : b.clipRank;
      if (ac !== bc) return ac - bc;
      const at = a.tagRank == null ? Infinity : a.tagRank;
      const bt = b.tagRank == null ? Infinity : b.tagRank;
      if (at !== bt) return at - bt;
      return a.id - b.id;
    };
    check(
      '输出符合「rrf desc → clipRank asc → tagRank asc → id asc」规格（重排是同一个数组）',
      JSON.stringify(r.rows.slice().sort(spec).map((row) => row.id)) ===
        JSON.stringify(r.rows.map((row) => row.id)),
    );
    /**
     * **如实记下 tie-break 今天是「冗余」的**（别把它说成比实际更强）。
     *
     * `Array.prototype.sort` 自 ES2019 起保证稳定，`Map` 保证插入顺序，而 `fuse` 的插入顺序
     * 恰好是「clip 先、tag 后」—— 与四级比较器的前三级同序。所以只按 rrf 排**今天也会给出
     * 同一个答案**。tie-break 的价值在于把顺序变成**规格**而不是巧合。
     *
     * ⚠️ 这条断言存在的意义是「看着这个巧合」：一旦有人改了 `fuse` 的遍历顺序
     * （比如先 tag 后 clip），两者就会分叉，这条会红，提醒他「现在 tie-break 开始承重了」。
     */
    const onlyRrf = r.rows.slice().sort((a, b) => b.rrf - a.rrf);
    check(
      '记录：只按 rrf 排（丢掉 tie-break）今天也给出同一顺序 —— tie-break 目前是规格而非补丁',
      JSON.stringify(onlyRrf.map((row) => row.id)) === JSON.stringify(r.rows.map((row) => row.id)),
    );
  }

  // ---------- 确定性：同一输入跑两次逐值相同 ----------
  {
    const input = () => ({ clip: ids(5, 120), tag: ids(60, 90) });
    const a = fusion.fuse(input());
    const b = fusion.fuse(input());
    check('同一输入两次结果逐值相同', JSON.stringify(a.rows) === JSON.stringify(b.rows));
    check('stats 也逐值相同', JSON.stringify(a.stats) === JSON.stringify(b.stats));
  }

  // ---------- 空输入 ----------
  {
    const r = fusion.fuse({});
    check('空输入：rows 为空、empty=true、stats 全零', r.rows.length === 0 && r.stats.empty === true && r.stats.total === 0);
    const r2 = fusion.fuse({ clip: [], tag: [] });
    check('两路都空与不传参等价', JSON.stringify(r) === JSON.stringify(r2));
  }

  // ---------- parseQuery：四态必须可区分 ----------
  const vocabulary = require(path.join(ROOT, 'src', 'ai', 'tag-vocabulary.js'));
  {
    const keys = Object.keys(vocabulary.TERMS || {});
    const supportedTerm = keys.find((key) => vocabulary.TERMS[key].tags && vocabulary.TERMS[key].tags.length);
    const unsupportedTerm = keys.find((key) => !vocabulary.TERMS[key].tags || !vocabulary.TERMS[key].tags.length);
    // ⚠️ 这两条是**夹具前提**，写成 assert 而不是「找不到就跳过」：
    //    「跳过」会让守护在这两个态不可达时**静默少测一半**，而它仍然全绿。
    assert.ok(supportedTerm, '夹具前提：词表里必须有 supported（有标签）的词条');
    assert.ok(
      unsupportedTerm,
      '夹具前提：词表里必须有标签缺失的词条 —— 否则 UNSUPPORTED 这一态在本仓库里不可达，' +
        '而界面那句话就没有存在意义',
    );

    const ok = fusion.parseQuery(supportedTerm);
    check('parseQuery：词表词 ⇒ inVocab 且 supported', ok.inVocab === true && ok.supported === true, supportedTerm);
    check('parseQuery：supported 时 entry 带非空 tags 与 mode', !!(ok.entry && ok.entry.tags.length) && !!ok.entry.mode);
    check('parseQuery：supported 时 missing 是空数组（不是 undefined）', Array.isArray(ok.missing) && ok.missing.length === 0);

    const bad = fusion.parseQuery(unsupportedTerm);
    check(
      '🔴 parseQuery：词表词但标签缺失 ⇒ inVocab=true 且 supported=false（**绝不能当成「不在表里」**）',
      bad.inVocab === true && bad.supported === false,
      unsupportedTerm + ' ⇒ ' + JSON.stringify({ inVocab: bad.inVocab, supported: bad.supported }),
    );
    check('parseQuery：该态必须带出 missing（界面要说是缺哪些标签）', bad.missing.length > 0, JSON.stringify(bad.missing));
    check('parseQuery：该态不给 entry（调用方不许拿它去查）', bad.entry === null);

    const free = fusion.parseQuery('穿黑丝的女生走在雨里');
    check(
      'parseQuery：自由词 ⇒ inVocab=false、supported=false、entry=null',
      !free.inVocab && !free.supported && free.entry === null,
    );
    const empty = fusion.parseQuery('   ');
    check('parseQuery：空串 ⇒ term 为空且 inVocab=false', empty.term === '' && !empty.inVocab);
    check('parseQuery：会 trim 首尾空白', fusion.parseQuery('  ' + supportedTerm + '  ').inVocab === true);
  }

  // ---------- describeTag：五态 + **优先级** ----------
  {
    const supported = ['a', 'b'];
    const wordParse = { term: 'x', inVocab: true, supported: true, entry: { tags: supported, mode: 'any' }, missing: [] };
    const freeParse = { term: 'y', inVocab: false, supported: false, entry: null, missing: [] };
    const badParse = { term: 'z', inVocab: true, supported: false, entry: null, missing: ['nope'] };

    const free = fusion.describeTag({ parsed: freeParse, enabled: true, available: false });
    check(
      '🔴 自由词 + 无索引 ⇒ FREE_TEXT（不是 NO_INDEX）',
      free.reason === 'FREE_TEXT',
      'reason=' + free.reason,
    );
    check('自由词不 active', free.active === false);

    const unsupported = fusion.describeTag({ parsed: badParse, enabled: true, available: true });
    check('词表词但标签缺失 ⇒ UNSUPPORTED', unsupported.reason === 'UNSUPPORTED', 'reason=' + unsupported.reason);
    check('UNSUPPORTED 时把缺的标签带出来', unsupported.missing.length === 1 && unsupported.missing[0] === 'nope');

    const off = fusion.describeTag({ parsed: wordParse, enabled: false, available: true });
    check('开关关 ⇒ DISABLED', off.reason === 'DISABLED', 'reason=' + off.reason);
    check('DISABLED 时 active=false', off.active === false);

    const none = fusion.describeTag({ parsed: wordParse, enabled: true, available: false });
    check('开关开、无索引 ⇒ NO_INDEX', none.reason === 'NO_INDEX', 'reason=' + none.reason);

    const boom = fusion.describeTag({ parsed: wordParse, enabled: true, available: true, failure: 'database disk image is malformed' });
    check('查询抛异常 ⇒ QUERY_FAILED', boom.reason === 'QUERY_FAILED', 'reason=' + boom.reason);
    check('QUERY_FAILED 时把原始错误带出来', boom.failure.indexOf('malformed') >= 0);
    check('QUERY_FAILED 不 active（必须降级）', boom.active === false);

    const ok = fusion.describeTag({ parsed: wordParse, enabled: true, available: true, hits: 12, threshold: 0.55 });
    check('正常 ⇒ reason 为空且 active', ok.reason === '' && ok.active === true);
    check('active 时带出 tags 与 mode', ok.tags.length === 2 && ok.mode === 'any');
    check('active 时带出命中数与阈值', ok.hits === 12 && ok.threshold === 0.55);
    check('未传 dropped 时是 0（不是 undefined）', ok.dropped === 0);
  }

  // ---------- mergeRoutes：端到端（IO 注入，真跑） ----------
  {
    const rowsFor = (list) =>
      new Map(list.map((id) => [id, { id, photo_id: id, file_name: 'p' + id + '.jpg', similarity: 0.02 }]));
    const clipResult = (photos, extra) =>
      Object.assign({ photos, matched: photos.length, candidates: photos.length, threshold: 0.01, truncated: false }, extra || {});

    // (a) 纯 CLIP：必须逐条恒等，且 **photosByIds 一次都不许被调**
    {
      let calls = 0;
      const photos = [1, 2, 3].map((id) => ({ id, similarity: 0.03 - id * 0.005 }));
      const out = fusion.mergeRoutes({
        clip: clipResult(photos, { matched: 99, truncated: true }),
        parsed: fusion.parseQuery('自由词'),
        enabled: true,
        available: false,
        photosByIds: () => {
          calls += 1;
          return new Map();
        },
      });
      check('mergeRoutes 纯 CLIP：顺序逐条不变', JSON.stringify(out.photos.map((p) => p.id)) === '[1,2,3]');
      check('mergeRoutes 纯 CLIP：route 全为 clip', out.photos.every((p) => p.route === 'clip'));
      check(
        '④ mergeRoutes 纯 CLIP：matched / truncated **原样透传**',
        out.matched === 99 && out.truncated === true,
        'matched=' + out.matched + ' truncated=' + out.truncated,
      );
      check('⑥ mergeRoutes 纯 CLIP：photosByIds 一次都没被调', calls === 0, 'calls=' + calls);
      check('mergeRoutes 纯 CLIP：tag 自述解释得清', out.tag.reason === 'FREE_TEXT' && out.tag.active === false);
    }

    // (b) tag 参与：matched 改成融合条数，tag 独有条目 similarity 必须是 null
    {
      let seen = null;
      const clip = [{ id: 1, similarity: 0.04 }];
      const tagResult = { photos: [{ id: 1, score: 0.8, tags: ['a'] }, { id: 7, score: 0.7, tags: ['b'] }] };
      const out = fusion.mergeRoutes({
        clip: clipResult(clip, { matched: 1 }),
        parsed: { term: 'x', inVocab: true, supported: true, entry: { tags: ['a'], mode: 'any' }, missing: [] },
        enabled: true,
        available: true,
        tagThreshold: 0.55,
        tagResult,
        maxResults: 5000,
        photosByIds: (list) => {
          seen = list.slice();
          return rowsFor(list);
        },
      });
      check('⑥ photosByIds 只为「CLIP 路没有的 id」被调', JSON.stringify(seen) === '[7]', JSON.stringify(seen));
      check('② 交集条目的 route 是 both', out.photos.find((p) => p.id === 1).route === 'both');
      check('⑤ tag 独有条目 similarity 必须是 null（不是 0）', out.photos.find((p) => p.id === 7).similarity === null);
      check('② tag 独有条目 route 是 tag', out.photos.find((p) => p.id === 7).route === 'tag');
      check('tag 独有条目补出来的字段够画卡片', out.photos.find((p) => p.id === 7).file_name === 'p7.jpg');
      check('tagScore / tagTags 只在有命中的条目上出现', out.photos.find((p) => p.id === 1).tagScore === 0.8 && out.photos.find((p) => p.id === 7).tagTags[0] === 'b');
      check('④ tag 参与时 matched = 融合后条数', out.matched === 2, 'matched=' + out.matched);
      check('tag 参与时 tag.active 为真、hits 报出', out.tag.active === true && out.tag.hits === 2);
      check('fusion 统计随结果一起上来', out.fusion && out.fusion.both === 1 && out.fusion.tagOnly === 1);
    }

    // (c) 主库里取不到该 id（已删）⇒ 必须被计数，不许静默消失
    {
      const out = fusion.mergeRoutes({
        clip: clipResult([{ id: 1, similarity: 0.04 }]),
        parsed: { term: 'x', inVocab: true, supported: true, entry: { tags: ['a'], mode: 'any' }, missing: [] },
        enabled: true,
        available: true,
        tagResult: { photos: [{ id: 1, score: 0.8, tags: ['a'] }, { id: 404, score: 0.7, tags: ['a'] }] },
        maxResults: 5000,
        photosByIds: () => new Map(), // 404 查不到
      });
      check('取不到照片行的条目必须消失', !out.photos.some((p) => p.id === 404));
      check('🔴 消失的条数必须报出来（dropped）', out.tag.dropped === 1, 'dropped=' + out.tag.dropped);
    }

    // (d) 需要补行却没给 photosByIds ⇒ 必须抛（而不是悄悄少几张）
    {
      assert.throws(
        () =>
          fusion.mergeRoutes({
            clip: clipResult([]),
            parsed: { term: 'x', inVocab: true, supported: true, entry: { tags: ['a'], mode: 'any' }, missing: [] },
            enabled: true,
            available: true,
            tagResult: { photos: [{ id: 3, score: 0.9, tags: ['a'] }] },
            maxResults: 5000,
          }),
        /TAG_FUSION_PHOTOS_BY_IDS_REQUIRED/,
        '(d) 缺 photosByIds 时必须抛，不许少几张了事',
      );
      notes.push('  ✓ (d) 缺 photosByIds 时抛 TAG_FUSION_PHOTOS_BY_IDS_REQUIRED');
    }

    // (e) maxResults 截断：head 之外不补行、truncated 为真
    {
      let seen = null;
      const clip = ids(1, 10).map((row) => ({ id: row.id, similarity: 0.01 }));
      const out = fusion.mergeRoutes({
        clip: clipResult(clip),
        parsed: { term: 'x', inVocab: true, supported: true, entry: { tags: ['a'], mode: 'any' }, missing: [] },
        enabled: true,
        available: true,
        tagResult: { photos: ids(100, 50).map((row) => ({ id: row.id, score: 0.9, tags: ['a'] })) },
        maxResults: 4,
        photosByIds: (list) => {
          seen = list.slice();
          return rowsFor(list);
        },
      });
      check('maxResults 生效（head 长度为 4）', out.photos.length === 4, 'len=' + out.photos.length);
      /**
       * ⚠️ 期望值是 `[100, 101]` 而不是 `[]`，这是**正确的 RRF 行为**、不是漏截断：
       * tag 第 1、2 名的名次与 clip 第 1、2 名完全对称（都是 `1/(60+1)`、`1/(60+2)`），
       * 于是融合后的头部就是「clip 第 n 名、tag 第 n 名」逐对穿插 ——
       * head = [1(clip), 100(tag), 2(clip), 101(tag)]，要补的正是那两条 tag 独有。
       * 换句话说：**补行的数量上限由 `maxResults` 兜着**（不是由 `FUSE_DEPTH` 单独兜着），
       * 这条断言同时钉住「上限被尊重」与「穿插顺序没被改坏」。
       */
      check(
        '⑥ 只对 head 内的 id 补行（4 条 head 里恰好 2 条 tag 独有）',
        JSON.stringify(seen) === '[100,101]',
        JSON.stringify(seen),
      );
      check('截断时 truncated=true', out.truncated === true);
    }
  }

  // ---------- ⑥ 接线：worker 的 search 分支必须真的经过融合 ----------
  {
    const searchBlock = workerSrc.slice(
      workerSrc.indexOf("if (operation === 'search')"),
      workerSrc.indexOf("if (operation === 'suggest')"),
    );
    check('worker：search 分支存在', searchBlock.length > 0);
    check('worker：search 分支调用 tagRoute(...)', /tagRoute\s*\(/.test(searchBlock));
    check(
      'worker：融合结果真的盖回返回值（...fused）',
      /return\s*\{\s*\.\.\.result\s*,\s*\.\.\.fused/.test(searchBlock.replace(/\s+/g, ' ')),
      searchBlock.replace(/\s+/g, ' ').slice(0, 160),
    );
    check('worker：tag 库必须**只读**打开', /readOnly:\s*true/.test(workerSrc));
    check('worker：路径来自唯一来源 tagIndexPath(...)', /tagIndexPath\s*\(/.test(workerSrc));
    check(
      'worker：不许自己拼 tag-index.sqlite 路径（第二份路径真相）',
      !/['"]tag-index\.sqlite['"]/.test(workerSrc),
    );
    check(
      'worker：tag 路失败必须降级而不是把整次搜索搞挂',
      /catch\s*\([\w\s]*\)\s*\{[\s\S]{0,400}?failure\s*=/.test(workerSrc),
    );
    // 两个调用点（自己起 worker 的 execute / 索引进行中的 relay）都必须还在
    const calls = (workerSrc.match(/readOnly\s*\(/g) || []).length;
    check('worker：readOnly 的两个调用点都在', calls >= 3, 'matches=' + calls);
  }

  // ---------- 阈值范围两处一致（渲染层拿不到主进程模块，只能各写一份） ----------
  {
    const m = desktopPageSrc.match(
      /var\s+TAG_RANGE\s*=\s*\{\s*min:\s*([\d.]+)\s*,\s*max:\s*([\d.]+)\s*,\s*step:\s*([\d.]+)\s*,\s*default:\s*([\d.]+)\s*\}/,
    );
    check('渲染层存在 TAG_RANGE 定义', !!m, '未匹配到');
    if (m) {
      check('min 一致', Number(m[1]) === TAG_ROUTE_RANGE.min, m[1] + ' vs ' + TAG_ROUTE_RANGE.min);
      check('max 一致', Number(m[2]) === TAG_ROUTE_RANGE.max, m[2] + ' vs ' + TAG_ROUTE_RANGE.max);
      check('default 一致', Number(m[4]) === TAG_ROUTE_RANGE.default, m[4] + ' vs ' + TAG_ROUTE_RANGE.default);
    }
    // 两条阈值不许合并成一个区间（量纲不同）
    check(
      '渲染层 TAG_RANGE 与 MATCH_RANGE 是两份（不许合并）',
      /MATCH_RANGE\s*=/.test(desktopPageSrc) && /TAG_RANGE\s*=/.test(desktopPageSrc),
    );
    check(
      'default 落在 [min, max] 内且 min > 0',
      TAG_ROUTE_RANGE.min > 0 &&
        TAG_ROUTE_RANGE.default >= TAG_ROUTE_RANGE.min &&
        TAG_ROUTE_RANGE.default <= TAG_ROUTE_RANGE.max,
    );
  }

  // ---------- 展示线：可调范围两处一致 + 设置三项必经点（2026-10-09 起可调） ----------
  {
    const { TAG_DISPLAY_RANGE, DISPLAY_MIN_SCORE, STORE_MIN_SCORE } = require(TAG_STORE);
    const m = desktopPageSrc.match(
      /var\s+TAG_DISPLAY_RANGE\s*=\s*\{\s*min:\s*([\d.]+)\s*,\s*max:\s*([\d.]+)\s*,\s*step:\s*([\d.]+)\s*,\s*default:\s*([\d.]+)\s*\}/,
    );
    check('渲染层存在 TAG_DISPLAY_RANGE 定义', !!m, '未匹配到');
    if (m) {
      check('展示线 min 一致', Number(m[1]) === TAG_DISPLAY_RANGE.min, m[1] + ' vs ' + TAG_DISPLAY_RANGE.min);
      check('展示线 max 一致', Number(m[2]) === TAG_DISPLAY_RANGE.max, m[2] + ' vs ' + TAG_DISPLAY_RANGE.max);
      check('展示线 step 一致', Number(m[3]) === TAG_DISPLAY_RANGE.step, m[3] + ' vs ' + TAG_DISPLAY_RANGE.step);
      check(
        '展示线 default 一致',
        Number(m[4]) === TAG_DISPLAY_RANGE.default,
        m[4] + ' vs ' + TAG_DISPLAY_RANGE.default,
      );
    }
    // 三份区间不许合并（量纲/语义都不同）：CLIP 基线差 / tag 查询线 / tag 展示线。
    check(
      '渲染层三份区间各自独立（MATCH_RANGE / TAG_RANGE / TAG_DISPLAY_RANGE）',
      /MATCH_RANGE\s*=/.test(desktopPageSrc) &&
        /TAG_RANGE\s*=/.test(desktopPageSrc) &&
        /TAG_DISPLAY_RANGE\s*=/.test(desktopPageSrc),
    );
    // 上下界是两条硬约束的化身 —— 解析出来核一遍，别让它们漂。
    check(
      'TAG_DISPLAY_RANGE 的上下界 === 入库线 / 查询线',
      TAG_DISPLAY_RANGE.min === STORE_MIN_SCORE && TAG_DISPLAY_RANGE.max === TAG_ROUTE_RANGE.default,
      'min=' + TAG_DISPLAY_RANGE.min + ' max=' + TAG_DISPLAY_RANGE.max,
    );
    check(
      'TAG_DISPLAY_RANGE.default === DISPLAY_MIN_SCORE（默认值不许另抄一份）',
      TAG_DISPLAY_RANGE.default === DISPLAY_MIN_SCORE,
    );
    // 设置三项必经点：默认值 / 夹取 / 网页快照白名单。漏任何一项都是静默失效：
    // 默认值漏 ⇒ 老配置退化成「什么都显示」；夹取漏 ⇒ NaN 直达 SQL 的 score >= NaN；
    // 白名单漏 ⇒ 将来任何客户端显示 undefined（与 tag 两个键同款教训）。
    check(
      'main：默认值取自 TAG_DISPLAY_RANGE.default（不许写字面量）',
      /aiTagDisplayThreshold:\s*TAG_DISPLAY_RANGE\.default/.test(mainSrc),
    );
    check(
      'main：ensureSettingsShape 用 clampDisplayMinScore 夹取展示线',
      /settings\.aiTagDisplayThreshold\s*=\s*clampDisplayMinScore\(/.test(mainSrc),
    );
    check(
      'main：网页快照含 aiTagDisplayThreshold（白名单成对维护）',
      /aiTagDisplayThreshold:/.test(
        mainSrc.slice(mainSrc.indexOf('function buildWebSettingsSnapshot()'), mainSrc.indexOf('function buildWebSettingsSnapshot()') + 4000),
      ),
    );
    // 面板：展示线输入框**不随标签检索层开关置灰**（它管的是标签页显示，与搜索无关）。
    // ⚠️ 反面断言必须配**阳性对照**，否则「改名了」也会让它绿。
    check(
      '面板：查询线会随开关置灰（阳性对照）',
      /tagThresholdInput\.disabled\s*=/.test(desktopPageSrc),
    );
    check(
      '面板：展示线输入框不随开关置灰（它不属于标签检索层）',
      !/tagDisplayInput\.disabled\s*=/.test(desktopPageSrc),
    );
    check(
      '面板：展示线的读回有独立分支（并进 tagTouched 那段 = 拨过开关就永远回填不上）',
      /!tagDisplayTouched && tagDisplayInput/.test(desktopPageSrc) &&
        /tagDisplayThreshold/.test(desktopPageSrc),
    );
    check(
      '面板：展示线落库键名是 tagDisplayThreshold（部分更新，只写被改的那一个）',
      /tagLayer\.write\(\{\s*tagDisplayThreshold:\s*value\s*\}\)/.test(desktopPageSrc),
    );
  }

  // ---------- 设置键的三处必经点 ----------
  {
    check(
      'main：默认值取自 TAG_ROUTE_RANGE.default（不许写字面量）',
      /aiSearchTagThreshold:\s*TAG_ROUTE_RANGE\.default/.test(mainSrc),
    );
    check('main：默认值是布尔 true', /aiSearchTagEnabled:\s*true/.test(mainSrc));
    check(
      'main：setupOptions() 把两个键传下去',
      /tagEnabled:\s*settings\.aiSearchTagEnabled\s*!==\s*false/.test(mainSrc) &&
        /tagThreshold:\s*Number\(settings\.aiSearchTagThreshold\)/.test(mainSrc),
    );
    check(
      'main：ensureSettingsShape 把开关归一成布尔',
      /if\s*\(typeof\s+settings\.aiSearchTagEnabled\s*!==\s*['"]boolean['"]\)\s*settings\.aiSearchTagEnabled\s*=\s*true/.test(
        mainSrc,
      ),
    );
    check(
      'main：ensureSettingsShape 夹取查询线（越界 / NaN 都不会穿到 SQL）',
      /settings\.aiSearchTagThreshold\s*=\s*Math\.max\(\s*TAG_ROUTE_RANGE\.min,/.test(mainSrc),
    );
    // 网页端设置快照是**白名单**（`cloneSettingsForIpc` 是整份 JSON 克隆）：漏一个键 =
    // 网页端设置页永远显示「标签检索关着」，而实际搜图是开着的。
    // ⚠️ 取窗口而不是 `slice(indexOf(build), indexOf(clone))`：`cloneSettingsForIpc` 定义在
    //    `buildWebSettingsSnapshot` **之前**，那样切出来的是空串，断言会「因为没找到」而红。
    const snapshotStart = mainSrc.indexOf('function buildWebSettingsSnapshot()');
    check('main：存在 buildWebSettingsSnapshot', snapshotStart >= 0);
    const snapshot = mainSrc.slice(snapshotStart, snapshotStart + 4000);
    check('main：网页快照含 aiSearchTagEnabled', /aiSearchTagEnabled:/.test(snapshot));
    check('main：网页快照含 aiSearchTagThreshold', /aiSearchTagThreshold:/.test(snapshot));
    check(
      'main：向网页端注入 getAiSearchTagOptions（否则网页端搜图拿不到开关）',
      /getAiSearchTagOptions:\s*function/.test(mainSrc),
    );
  }

  // ---------- web-server：搜图那条路必须把 tag 选项带过去 ----------
  {
    check(
      'web-server：注入名被接住',
      /this\.getAiSearchTagOptions\s*=/.test(webServerSrc),
    );
    check(
      'web-server：搜图请求里带上 tagEnabled / tagThreshold',
      /options\.tagEnabled\s*=/.test(webServerSrc) && /options\.tagThreshold\s*=/.test(webServerSrc),
    );
    check(
      'web-server：预选词那条路**不许**带 tag 键（它不走 tag 路）',
      !/payload\.tagEnabled/.test(webServerSrc) && !/payload\.tagThreshold/.test(webServerSrc),
    );
  }

  // ---------- ⑦ 三份镜面的 reason 集合必须一致 ----------
  {
    const reasonsOf = (src) => {
      const found = new Set();
      const re = /(?:case\s+|reason\s*===\s*)'([A-Z_]+)'/g;
      let m;
      while ((m = re.exec(src))) found.add(m[1]);
      return [...found].sort();
    };
    const expected = ['DISABLED', 'NO_INDEX', 'QUERY_FAILED', 'UNSUPPORTED'];
    const a = reasonsOf(desktopPageSrc);
    const b = reasonsOf(desktopSidebarSrc);
    const c = reasonsOf(webSidebarSrc);
    check('镜面①桌面整页的 reason 集合完整', JSON.stringify(a) === JSON.stringify(expected), JSON.stringify(a));
    check('镜面②桌面右栏的 reason 集合完整', JSON.stringify(b) === JSON.stringify(expected), JSON.stringify(b));
    check('镜面③网页端的 reason 集合完整', JSON.stringify(c) === JSON.stringify(expected), JSON.stringify(c));
    for (const [name, src] of [
      ['桌面整页', desktopPageSrc],
      ['桌面右栏', desktopSidebarSrc],
      ['网页端', webSidebarSrc],
    ]) {
      check(name + '：状态行真的用上了 tagNote(...)', /tagNote\s*\(/.test(src));
      check(name + '：FREE_TEXT 刻意不提示（该 reason 不在集合里）', !reasonsOf(src).includes('FREE_TEXT'));
    }
  }

  // ---------- M4 顺手修掉的那个静默缺陷：top 不许取 photos[0].similarity ----------
  {
    check(
      '桌面整页：top 取全表最大值（不再取 photos[0]，否则首位是 tag 独有条目时整列匹配度条全消失）',
      /photos\.reduce\([\s\S]{0,200}?similarity/.test(desktopPageSrc),
      '未匹配到 photos.reduce',
    );
    check(
      '桌面整页：不再出现 `photos[0].similarity`',
      !/photos\[0\]\.similarity/.test(desktopPageSrc),
    );
    check('桌面整页：来源标注按 route 判（both 不标）', /route\s*!==\s*'tag'\s*&&\s*photo\.route\s*!==\s*'clip'/.test(desktopPageSrc));
  }

  // ---------- 反向验证：故意做错的实现必须被同一组断言抓到 ----------
  //
  // 一个永远绿的守护比没有守护更糟 —— 它把「假绿」变成了可引用的证据。
  // 下面这份 `naiveMerge` 是**最省事、也最容易顺手写出来**的版本，它踩的正是本守护钉的
  // 四个静默点：matched 口径、similarity 口径、dropped 计数、route 判据。
  // 逐条对照，确认每一条断言在错的实现上都会红 —— 否则说明它没有牙齿。
  {
    /** 想当然的实现：分数一锅端、缺失静默丢、matched 拿结果条数充数。 */
    function naiveMerge(clipPhotos, tagPhotos) {
      const out = new Map();
      for (const photo of clipPhotos) out.set(photo.id, { ...photo, route: 'clip' });
      for (const hit of tagPhotos) {
        const existing = out.get(hit.id);
        // 错法一：拿外来量纲（0.55–0.95 的标签概率）当 `similarity` 填进去
        if (existing) existing.route = 'both';
        else out.set(hit.id, { id: hit.id, file_name: 'p' + hit.id + '.jpg', similarity: 0, route: 'tag' });
      }
      const photos = [...out.values()];
      // 错法二：matched 直接用结果条数（把「达标总数、不受上限截断」这个既有契约改掉了）
      // 错法三：主库里取不到的条目静默消失，不报 dropped
      return { photos, matched: photos.length, truncated: false, tag: { dropped: 0 } };
    }

    const clipPhotos = [{ id: 1, similarity: 0.04 }];
    const tagPhotos = [{ id: 1, score: 0.8, tags: ['a'] }, { id: 7, score: 0.7, tags: ['b'] }];
    const got = naiveMerge(clipPhotos, tagPhotos);

    // ① matched 口径：差异只在「tag 没参与」时才露出来 —— 那时 CLIP 的 matched 是
    //    **达标总数（99）**、不受返回上限截断，而 photos.length 只有 1。
    check(
      '反向验证①：naive 的 matched=photos.length 与「原样透传」要求（99）不同 ⇒ 那条断言会红',
      naiveMerge(clipPhotos, []).matched !== 99,
      'naive=' + naiveMerge(clipPhotos, []).matched + ' 要求=99',
    );
    // ② similarity 口径：要求是 null（「没有可比分数」），naive 给 0（「分数是 0」）
    check(
      '反向验证②：naive 把 tag 独有条目的 similarity 填成 0 ⇒ 「必须是 null」断言会红',
      got.photos.find((photo) => photo.id === 7).similarity !== null,
      'naive=' + got.photos.find((photo) => photo.id === 7).similarity + ' 要求=null',
    );
    // ③ dropped 计数：喂一个主库里查不到的 id，naive 静默丢、dropped 仍是 0
    check(
      '反向验证③：naive 静默丢条目、dropped 恒为 0 ⇒ 「dropped 必须报出来」断言会红',
      naiveMerge(clipPhotos, tagPhotos.concat([{ id: 404, score: 0.9, tags: ['a'] }])).tag.dropped !== 1,
    );
    // ④ 对照：naive 在 route 判据上**是**对的 —— 说明上面的牙齿是逐条针对的，
    //    不是「随便什么实现都能撞红」。没有这条对照，前三条可能只是「naive 处处都错」。
    check(
      '反向验证④（对照）：naive 的 route 判据与要求一致 ⇒ 前三条是逐条针对的',
      got.photos.find((photo) => photo.id === 1).route === 'both' &&
        got.photos.find((photo) => photo.id === 7).route === 'tag',
    );
  }

  // ---------- 汇总 ----------
  if (errors.length) {
    console.error('[tag-fusion-regression] FAIL');
    for (const line of notes) console.error(line);
    for (const line of errors) console.error(line);
    process.exitCode = 1;
    return;
  }
  console.log('[tag-fusion-regression] PASS (' + notes.length + ' checks)');
  for (const line of notes) console.log(line);
}

try {
  run();
} catch (error) {
  console.error('[tag-fusion-regression] FAIL');
  for (const line of notes) console.error(line);
  console.error('  \u2717 未捕获异常: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
}
