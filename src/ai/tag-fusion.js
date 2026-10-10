'use strict';

/**
 * tag 路 × CLIP 路的**融合层**（M4）。
 *
 * ## 它为什么是一个独立模块，而不是写进 worker
 *
 * 融合的全部内容是「两串已排好序的 id、一个公式、一张 route 标签」，**不含任何 IO**。
 * 留在这里它就能被回归直接喂假数据逐值断言；写进 `semantic-worker.js` 就只能靠读源码文本猜。
 * 本仓已有先例（`ai-index-gate.js`）：**判据要放在能被真跑的地方**。
 *
 * ## 为什么是 RRF 而不是「把两个分数加权平均」
 *
 * 两路的分数**量纲不同、且都不可比**：
 *   · CLIP 路是「基线差」`adjusted = dot(q,v) − generic_sim`，典型区间 0.01–0.15（地板 0.01）；
 *   · tag 路是标签置信度（0.55 起才算命中），典型区间 0.55–0.95。
 * 加权平均要先做一套归一化，而归一化要挑参考集 —— 挑谁都是拍脑袋，且**换一份库就失效**。
 * RRF（Reciprocal Rank Fusion）只用**名次**，天生对量纲免疫，也是「两路都排得不错」时的稳妥解。
 *
 * ## K = 60 的含义（别当成随手取的常数）
 *
 * `score = Σ 1/(K + rank)`，rank 从 1 起。K 越大，名次差的权重越小、两路越「平等」；
 * K 越小，只有排在最前的少数几条能拿到高分。60 是 RRF 原论文与本仓台架都在用的取值，
 * 它的效果是：**第 1 名与第 2 名只差 1/(60+1) − 1/(60+2) ≈ 0.00027**，
 * 也就是「同一路内部的名次差被压得很小，真正的区分度来自**两路都命中**」。
 * ⇒ 这正是我们要的性质：`route='both'` 的条目必然浮到前面，而单路命中内部仍保持各自的名次。
 *
 * ## 一条刻意不做的事
 *
 * **不给 tag 路做「分数归一化后并入 similarity」**。`similarity` 的语义是 CLIP 的基线差，
 * 界面的阈值滑杆、`matched` 的口径、以及 7,374 行既有向量全都是这个口径；
 * 往里混进一个 0.55–0.95 的数会让「阈值 0.05」这种设置瞬间失去意义。
 * 所以 tag 独有的条目 `similarity = null`（界面据此不显示匹配度条），分数另给 `tagScore`。
 */

const vocabulary = require('./tag-vocabulary');

/** RRF 的 K。改它必须同时改台架读数与 CHANGELOG —— 它直接决定排序。 */
const RRF_K = 60;

/**
 * **tag 路**取前多少名参与融合。
 *
 * ⚠️ 只截断 tag 路，**不截断 CLIP 路**（见 `fuse` 的注释：CLIP 全量参与才不会让结果变少）。
 * 这个值同时承担一个**安全职责**：`route='tag'` 的候选最终要按 id 去主库补图片行，
 * 补的那条 SQL 用 `IN (?,?,…)` 展开。SQLite 的参数上限是 32766，
 * 而 tag 独有条目**最多** `FUSE_DEPTH` ⇒ 200（守护钉着 `FUSE_DEPTH ≤ 1000`）。
 * 要把它调大到四位数，就得改用 `src/main/sql-id-list.js` 那套 `json_each`。
 */
const FUSE_DEPTH = 200;

const ROUTE_TAG = 'tag';
const ROUTE_CLIP = 'clip';
const ROUTE_BOTH = 'both';

/**
 * 把用户输入解析成 tag 路的入参，并**如实说明为什么用不了**。
 *
 * 四种结果必须可区分（界面各有一句话）：
 *   · `inVocab && supported` ⇒ tag 路参与，`entry = {tags, mode}`；
 *   · `inVocab && !supported` ⇒ 词表里有这个词，但它的标签**不在模型标签表里**
 *     （`missing` 就是缺哪些）⇒ 不能当「0 结果」，要说「这个词没法用标签检索」；
 *   · `!inVocab` ⇒ **自由词**（「穿黑丝的女生」这种句子）⇒ 只走 CLIP。
 *     这是绝大多数查询的形态，**必须与「0 结果」分开**；
 *   · 空串 ⇒ `term === ''`，调用方不该走到这里（查询入口已挡）。
 *
 * ⚠️ `lookup` 是**精确键匹配**（trim 后查表），不是分词/子串匹配 —— tag 路的入口
 * 就是「预选词/词表词」，这也是它精度高的原因。别顺手改成「包含即命中」：
 * 那会让「黑丝」命中「黑丝袜」这类不同条目，而分数的量纲是按整条查询标定的。
 */
function parseQuery(term) {
  const raw = String(term == null ? '' : term).trim();
  const entry = vocabulary.lookup(raw);
  const supported = vocabulary.isSupported(raw);
  return {
    term: raw,
    inVocab: !!entry,
    supported,
    entry: supported ? entry : null,
    missing: entry && entry.missing ? entry.missing.slice() : [],
  };
}

/**
 * RRF 融合。**纯函数**：只吃两串已排序的 `{id}`，吐排好序的 id 行 + 一份统计。
 *
 * ## 🔴 为什么 CLIP 路**全量**参与、只有 tag 路按 `depth` 截断
 *
 * 直觉写法是「两路各取前 200 一起融合」，但那样会**让结果变少**：CLIP 路的返回上限是 5000 条，
 * 截到 200 之后用户从「找到 3000 张」变成「最多 400 张」—— 一个纯粹的回退，
 * 而且它长得不像 bug（数字变了而已）。真正存在的约束只有一条：**tag 路的候选要按 id 回主库补
 * 图片行，而那条 SQL 是 `IN (?,…)` 展开的** ⇒ 必须是 **tag 路**被截断，不是 CLIP 路。
 *
 * 于是：CLIP 全量算 RRF，tag 取前 `depth`。深度外的 CLIP 条目 `rrf = 1/(K+rank)`，
 * 在数值上**必然**小于任何进了头部的条目（头部最小的 rrf 也 ≥ `1/(K+200)`），
 * 所以它们自动排在后面且保持原序 —— 不需要专门写一段「尾部拼接」，也就没有「忘了拼尾部」。
 *
 * @param {{clip?: Array<{id:number}>, tag?: Array<{id:number}>,
 *   k?: number, depth?: number}} input
 * @returns {{rows: Array<{id:number, route:string, rrf:number,
 *   clipRank:number|null, tagRank:number|null}>, stats: object}}
 */
function fuse(input) {
  const opts = input || {};
  const clip = Array.isArray(opts.clip) ? opts.clip : [];
  const tag = Array.isArray(opts.tag) ? opts.tag : [];
  const k = Number.isFinite(opts.k) ? Number(opts.k) : RRF_K;
  const depth = Number.isFinite(opts.depth) ? Number(opts.depth) : FUSE_DEPTH;
  const tagTop = tag.slice(0, depth);

  const rows = new Map();
  const touch = (id) => {
    let row = rows.get(id);
    if (!row) {
      row = { id, rrf: 0, clipRank: null, tagRank: null, route: ROUTE_CLIP };
      rows.set(id, row);
    }
    return row;
  };
  // rank 从 **1** 起（`1/(K+1)` 是第 1 名）。从 0 起会让 K 的语义变成「K−1」，与论文/台架都对不上。
  clip.forEach((photo, index) => {
    const row = touch(photo.id);
    row.clipRank = index + 1;
    row.rrf += 1 / (k + index + 1);
  });
  tagTop.forEach((photo, index) => {
    const row = touch(photo.id);
    row.tagRank = index + 1;
    row.rrf += 1 / (k + index + 1);
  });

  const list = [];
  for (const row of rows.values()) {
    // route 的判据是「**这一路里有没有它**」，不是「哪一路的分数高」——
    // 分数不可比（见文件头），拿它来判归属会得出随库漂移的结论。
    row.route = row.clipRank && row.tagRank ? ROUTE_BOTH : row.clipRank ? ROUTE_CLIP : ROUTE_TAG;
    list.push(row);
  }
  /**
   * 排序：`rrf` 降序 → `clipRank` 升序 → `tagRank` 升序 → `id` 升序。
   *
   * **写满四级的目的是让比较器成为「全序」**：对任意两条不同的行，它必须返回非 0。
   * 理由不是「浮点相等很常见」，而是**不同名次组合可以算出同一个 rrf**：
   * 最干净的一例是 `both` 在 (clipRank 62, tagRank 62) 上的 `2/122`，
   * 它在实数域上恰好等于 `clip` 在第 1 名上的 `1/61`。
   *
   * ⚠️ 把这件事说到什么程度才算准（别把它讲得比实际更强）：`Array.prototype.sort` 自
   * ES2019 起保证稳定、`Map` 保证插入顺序，而插入顺序恰好是「clip 先、tag 后」——
   * 所以**即使砍掉后面三级，现在的输出也是确定的**。写满四级的价值是把顺序变成**规格**，
   * 而不是「实现恰好如此」：比较器到达全序之后，结果与 sort 的稳定性、与遍历顺序都无关，
   * 「同一份库重跑结果一致」这条硬契约不再依赖两个语言细节同时成立。
   * 最后一级 `id` 在当前数据下**不会真的被用到**（`rrf` + 两个 rank 已经唯一确定一行），
   * 它只是让「全序」在代码里一眼可见；这也是为什么它排在最末。
   */
  list.sort((a, b) => {
    if (b.rrf !== a.rrf) return b.rrf - a.rrf;
    const ac = a.clipRank == null ? Infinity : a.clipRank;
    const bc = b.clipRank == null ? Infinity : b.clipRank;
    if (ac !== bc) return ac - bc;
    const at = a.tagRank == null ? Infinity : a.tagRank;
    const bt = b.tagRank == null ? Infinity : b.tagRank;
    if (at !== bt) return at - bt;
    return a.id - b.id;
  });

  let both = 0;
  let clipOnly = 0;
  let tagOnly = 0;
  for (const row of list) {
    if (row.route === ROUTE_BOTH) both += 1;
    else if (row.route === ROUTE_CLIP) clipOnly += 1;
    else tagOnly += 1;
  }
  return {
    rows: list,
    stats: {
      k,
      depth,
      both,
      clipOnly,
      tagOnly,
      total: list.length,
      /**
       * 两路各自**实际参与**的条数 —— 「为什么结果变少了」要靠它解释。
       * `clipVisited` 是全量（CLIP 路不截断，见 `fuse` 的注释）；`tagVisited` 到 `depth` 为止。
       */
      clipVisited: clip.length,
      tagVisited: tagTop.length,
      /** 两路都空 ⇒ 这一趟没有任何一路可用，界面要说「没找到」而不是「融合失败」 */
      empty: !list.length,
    },
  };
}

/**
 * tag 路的**自述**：这一趟它到底参没参与、为什么。
 *
 * 🔴 存在的理由：tag 路会**静默不参与**（库没建、词是自由词、用户关了开关），
 * 而这三种情况和「这个查询确实没有结果」在界面上长得一模一样 —— 用户唯一能得到的结论是
 * 「搜图不准」。所以 worker 必须把「tag 路为什么没参与」原样带上来，由界面说一句人话。
 */
function describeTag(input) {
  const opts = input || {};
  const parsed = opts.parsed || parseQuery('');
  const available = opts.available === true;
  const enabled = opts.enabled !== false;
  const failure = opts.failure ? String(opts.failure) : '';
  const hits = Number.isFinite(opts.hits) ? opts.hits : 0;
  let reason = '';
  /**
   * 🔴 **优先级是「这个词用不用得上 tag 路」在前，「tag 路本身在不在」在后**。
   *
   * 反过来的写法（先判索引、再判词）会让「没建索引的机器上**每一句**自由词查询」
   * 都得到 `NO_INDEX` —— 于是界面在用户随手打一句话时弹出「tag 索引未建立」。
   * 那句话本身没错，但它既不相关（自由词本来就走 CLIP），又会天天出现成噪声，
   * 最后被用户学会忽略 —— 真正该看的那一次（词表词 + 无索引）也就一起被忽略了。
   *
   * 按现在这个顺序：`FREE_TEXT` 与 `UNSUPPORTED` 是**关于查询词**的结论（与索引无关），
   * 只有在词**用得上** tag 路时，才轮到说「你关了开关 / 没建索引 / 查询炸了」。
   */
  if (!parsed.inVocab) reason = 'FREE_TEXT';
  else if (!parsed.supported) reason = 'UNSUPPORTED';
  else if (!enabled) reason = 'DISABLED';
  else if (!available) reason = 'NO_INDEX';
  // 库在、开关也开，但**查询当场抛了**（库被截断 / 半写 / 磁盘故障）。
  // 这一类比「没有索引」更需要说出来：它在同一台机器上是**间歇性**的，
  // 不说就会被读成「搜图时灵时不灵」，而排查方向会完全跑偏到模型上。
  else if (failure) reason = 'QUERY_FAILED';
  // `parsed` 到位、库也在、开关也开、查询没炸 ⇒ 这一趟 tag 路真的参与了
  const active = enabled && available && !failure && parsed.supported;
  return {
    enabled,
    available: !!opts.available,
    active,
    reason,
    term: parsed.term,
    tags: active && parsed.entry ? parsed.entry.tags.slice() : [],
    mode: active && parsed.entry ? parsed.entry.mode : '',
    missing: parsed.missing.slice(),
    hits,
    /**
     * 这一趟实际用的查询线（概率口径）。**即使 tag 路没参与也报出来**：
     * 界面的滑杆、守护的读数、以及「为什么这个词只出来 3 张」都要对着同一个数字说话。
     */
    threshold: Number.isFinite(opts.threshold) ? Number(opts.threshold) : 0,
    /** 融合后被丢弃的条数（主库里取不到图片行：已删、或指纹漂了）—— 静默丢是本仓大忌 */
    dropped: Number.isFinite(opts.dropped) ? opts.dropped : 0,
    /** 只有 `reason === 'QUERY_FAILED'` 时非空。原样带上来，别在这里改写成人话（那会丢栈上的信息） */
    failure,
  };
}

/**
 * 把 tag 路融进 CLIP 路的结果（M4）—— **整条融合的编排**，IO 全部靠注入。
 *
 * ## 为什么在纯函数模块里，而不是写在 worker 里
 *
 * 它做的事情只有两类：调 `fuse()`、以及按 id 去主库补图片行（`photosByIds`）。后者是唯一的 IO，
 * 而它**由调用方注入** ⇒ 这里仍然一行 `require('fs')`/`better-sqlite3` 都没有，
 * 回归可以直接喂两个真夹具库（或两个假对象）把它整条跑通。
 * 反过来，留在 `semantic-worker.js` 里就是**判据放在跑不到的地方**：
 * 那个文件顶层就读 `workerData.aiPath`，裸 node 一 `require` 就 `TypeError`
 * —— 只能靠读源码文本猜，而「读源码猜」正是本仓栽过的坑。
 *
 * ## 为什么**永远**返回同一组字段（哪怕 tag 路根本没参与）
 *
 * 界面的渲染只有一条路径：`photos[i].route` 标来源、`photos[i].similarity` 画匹配度条、
 * `tag.reason` 决定顶部提示。若「tag 没参与」时这些字段消失，界面就必须写两份分支，
 * 而两份分支里必然有一份没人跑过（本仓的老毛病，见 `photo-info-fields` 那一章）。
 * 所以纯 CLIP 时也要补齐：`route` 全为 `'clip'`、`tag.reason` 说清为什么没参与。
 *
 * ## 纯 CLIP 时结果与顺序必须**逐条不变**
 *
 * 只喂一路进 `fuse()`，`rrf = 1/(K+n)` 随名次 n **严格递减**（相邻两名之差是
 * `1/((K+n)(K+n+1))`，n ≤ 5000 时约 2.4e-4，远大于双精度可分辨的 1e-16），
 * 且 tie-break 的第二级就是 `clipRank` ⇒ 排序输出与输入**逐条一致**。
 * 这条由 `tag-fusion-regression` 直接断言，不是推理。
 *
 * ## `matched` 在两种情形下**口径不同**（有意，且必须照抄既有契约）
 *
 *   · tag 路**没参与**（开关关 / 没索引 / 自由词 / 查询失败 / 命中 0 张）⇒ 原样返回 CLIP 的
 *     `matched`。它的既有语义是「**达标总数**，不受 maxResults 截断」——守护钉着
 *     「threshold 0.5、maxResults 2 时 matched 仍是 3」。这里若改写成 `photos.length`
 *     就会把这个契约悄悄改掉。
 *   · tag 路**真的给出了候选** ⇒ 只能用融合后的条数。这是个**下界**（tag 路自己也有 5000 上限），
 *     届时 `truncated` 同时为 true，调用方据此知道「还有达标的没返回」。
 *     为了一个显示用的计数再扫一遍全库向量不值（点积是这条路的全部成本）。
 *
 * @param {{clip: object, parsed: object, enabled: boolean, available: boolean,
 *   failure?: string, tagThreshold?: number, tagResult?: object|null, maxResults?: number,
 *   photosByIds?: (ids:number[]) => Map<number, object>}} input
 *   `clip` 是 `IndexStore#search()` 的整个返回值（要它的 `photos` / `matched` / `truncated`）；
 *   `photosByIds` 只有 tag 路给出候选时才会被调到。
 * @returns {{photos: object[], matched: number, truncated: boolean, tag: object, fusion: object}}
 */
function mergeRoutes(input) {
  const opts = input || {};
  const clip = opts.clip || { photos: [], matched: 0, truncated: false };
  const clipPhotos = Array.isArray(clip.photos) ? clip.photos : [];
  const tagHits = opts.tagResult && Array.isArray(opts.tagResult.photos) ? opts.tagResult.photos : [];
  const limit = Number.isFinite(opts.maxResults) ? Number(opts.maxResults) : Infinity;
  const fused = fuse({ clip: clipPhotos, tag: tagHits, k: RRF_K, depth: FUSE_DEPTH });

  /**
   * ⚠️ 「tag 路参与了」的判据是**它真的给出了候选**，不是「开关开着且词在表里」。
   *    区分这两者是为了 `matched` 的口径（见上面的长注释）：若 tag 命中 0 张，
   *    融合结果与 CLIP 完全等价，此时就该沿用 CLIP 的（更精确的）`matched`。
   */
  const merged = tagHits.length > 0;
  const head = fused.rows.slice(0, limit);

  const clipById = new Map(clipPhotos.map((photo) => [photo.id, photo]));
  const tagById = new Map(tagHits.map((hit) => [hit.id, hit]));
  // tag 独有条目没有图片行（tag 库只有 `{id, score}`），要回主库补。
  // ⇒ **只对头部补**：`IN (?,…)` 展开的参数上限是 32766，而 `FUSE_DEPTH` 保证 ≤ 200
  //   （见 FUSE_DEPTH 的注释：这个上限正是它承担的安全职责）。
  const missingIds = [];
  for (const row of head) if (!clipById.has(row.id)) missingIds.push(row.id);
  const photosByIds = typeof opts.photosByIds === 'function' ? opts.photosByIds : null;
  if (missingIds.length && !photosByIds) throw new Error('TAG_FUSION_PHOTOS_BY_IDS_REQUIRED');
  const extraRows = missingIds.length ? photosByIds(missingIds) : new Map();

  const photos = [];
  let dropped = 0;
  for (const row of head) {
    const clipRow = clipById.get(row.id);
    // 复用 CLIP 路那一行**本体**（而不是拷一份）：这些行是 `search()` 当场构造出来的、
    // 只归本次调用所有，就地补字段省掉 5000 次对象展开。
    const photo = clipRow || extraRows.get(row.id);
    if (!photo) {
      // 主库里已经没有这张（已删）。本仓大忌是静默丢 —— 数量报进 `tag.dropped`。
      dropped += 1;
      continue;
    }
    photo.route = row.route;
    const hit = tagById.get(row.id);
    if (hit) {
      photo.tagScore = hit.score;
      photo.tagTags = hit.tags.slice();
    }
    // 🔴 tag 独有条目的 `similarity` 必须是 `null`，**不能是 0**：渲染层拿它画匹配度条，
    //    而 tag 的 0.55–0.95 是另一套量纲，塞进 CLIP 的基线差口径会让阈值滑杆整个失真
    //    （文件头有完整理由）。`null` 让界面明确「这条没有匹配度可显示」，0 则是在说谎。
    if (!clipRow) photo.similarity = null;
    photos.push(photo);
  }

  return {
    photos,
    matched: merged ? photos.length : clip.matched,
    truncated: merged ? fused.rows.length > limit || !!clip.truncated : !!clip.truncated,
    // `candidates` / `threshold` 由调用方保留 CLIP 的原始值：界面上的阈值滑杆就是 CLIP 阈值。
    tag: describeTag({
      parsed: opts.parsed,
      enabled: opts.enabled,
      available: opts.available,
      failure: opts.failure,
      hits: tagHits.length,
      dropped,
      threshold: opts.tagThreshold,
    }),
    fusion: fused.stats,
  };
}

module.exports = {
  RRF_K,
  FUSE_DEPTH,
  ROUTE_TAG,
  ROUTE_CLIP,
  ROUTE_BOTH,
  parseQuery,
  fuse,
  describeTag,
  mergeRoutes,
};
