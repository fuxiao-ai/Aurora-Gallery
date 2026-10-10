'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { MODEL_KEY, DIMENSIONS, GENERIC_TEXT, loadEncoder, dot } = require('../ai/embedding');
const { IndexStore, MAX_RESULTS } = require('../ai/index-store');
/**
 * `ready.json` 的**读写判据**只有一个实现（`isSearchReady` / `writeSearchReady`），
 * 主进程 `semantic-search.js#status()` 也 require 同一对函数 —— 否则「界面说没就绪、
 * worker 说有」这种两边不一致迟早出现，而且两边都不报错。
 */
const { isSearchReady, writeSearchReady } = require('../ai/bundled-models');
/**
 * tag 倒排路（M4）——本文件只管**查询侧**的三样东西，别把它们混起来：
 *   · `TagIndexStore` —— 独立库的**只读**句柄（`<aiPath>/tag-index.sqlite`，与 CLIP 库分开文件）；
 *   · `tagFusion` —— 纯函数的融合层（RRF + route 标注 + tag 路自述），不含任何 IO；
 *   · `tagIndexPath` —— 库路径的**唯一来源**。自己 `path.join(root, 'tag-index.sqlite')`
 *     会造出第二份路径真相，而「索引建好了但搜图说没有索引」正是两边各写一份的典型后果。
 *
 * ⚠️ **建索引侧不在这里**（2026-10-08 拆分）：JoyTag 那一路整体搬去了
 * `semantic-tag-worker.js`，与 CLIP 这一路**并行**跑（cpu ∥ dml，实测 1.41×，
 * 完整推导见 `docs/contracts/semantic-search.md`）。搬过去的理由：同进程多 ONNX 会话
 * 只有 `cpu + dml` 一种组合能跑 ⇒ 两个会话必须分属两个线程；顺带本进程不再载
 * `joytag-model`（少一份 ORT，也不再有「谁先 require」的 DLL 次序问题）。
 */
const {
  TagIndexStore,
  tagIndexPath,
  TAG_ROUTE_RANGE,
  TAG_MAX_RESULTS,
} = require('../ai/tag-index-store');
const tagFusion = require('../ai/tag-fusion');
const {
  readCachedWordVectors,
  computeTags,
  indexesOf,
  vocabKey,
  TAG_LANG,
  TAG_BATCH,
} = require('../ai/photo-tags');
const vocabulary = require('../ai/search-vocabulary');
sharp.concurrency(1);
/**
 * 只需要**文本**编码器的操作。下载模型要验证两种编码器、建索引要编码图片，两者都必须带视觉
 * 那份（约 270 MB 常驻内存）；搜索与预选词打分只用文本，带上就是白花内存。
 * 新增操作时先想清楚它要不要编码图片，别默默继承默认值。
 */
const TEXT_ONLY_OPERATIONS = new Set(['search', 'suggest']);
/**
 * 预选词默认返回几个 / 最多返回几个。
 *
 * 返回的不是「界面要显示的那 5 个」而是**一个池子**：界面从池子里洗牌抽 5 个，
 * 「换一批」就是再洗一次，因此不需要为「换一批」重新跑一遍模型。池子太小则洗牌没有可见变化
 * （18 词池随机抽 5，两批重复率很高），太大则 IPC 负载与前端渲染都白花 —— 24 是实测够用的折中。
 *
 * 🔴 **这两个数以 `search-vocabulary.js` 为唯一定义处**（2026-10-09 起）：预选词的常规路径
 *    已经改走主进程只读 SQL（`SemanticTags.suggestTerms`），它同样要夹这两个数。这里再写一份
 *    的后果不是报错，而是「同一个界面元素被两条路服务时条数不同」，而界面只摆 5 个
 *    （`SUGGEST_COUNT`）⇒ 差 24 还是 64 **在界面上看不出来**。
 */
const SUGGEST_LIMIT_DEFAULT = vocabulary.SUGGEST_LIMIT_DEFAULT;
const SUGGEST_LIMIT_MAX = vocabulary.SUGGEST_LIMIT_MAX;
/** 命中多少张才算「点下去有图」。1 是下限：要挡的是 0 张，命中 1 张点进去照样有图片可看。 */
const DEFAULT_MIN_HITS = 1;
/** 阈值只接受有限数；越界或缺失时交给 IndexStore 用默认值。 */
function matchThreshold(options) {
  const value = Number(options && options.threshold);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * tag 路的查询线（概率口径，0.55 起算命中）。
 *
 * 与 CLIP 阈值**刻意走两个键**（`threshold` / `tagThreshold`）：两者量纲不同，
 * 共用一个滑杆就必然出现「为了压住 tag 的误报把 CLIP 也砍没了」。
 *
 * 越界选择**夹取**而不是回默认值：滑杆正常不会传出界（界面自己按 `TAG_ROUTE_RANGE` 限位），
 * 能走到这里的只有被手工改坏的设置；此时「就近生效」比「悄悄跳回 0.55」可解释 ——
 * 后者会让用户以为「拖了没反应」。
 */
function tagThreshold(options) {
  const value = Number(options && options.tagThreshold);
  if (!Number.isFinite(value)) return TAG_ROUTE_RANGE.default;
  return Math.min(TAG_ROUTE_RANGE.max, Math.max(TAG_ROUTE_RANGE.min, value));
}

/**
 * tag 倒排库的**只读**句柄：惰性打开，并**缓存失败**。
 *
 * ① **只读**（`fileMustExist`）是必须的：可写打开会在「从没建过索引」的机器上**凭空造出一个
 *    空库文件**，于是「没有 tag 索引」被伪装成「tag 索引是空的」。这两件事在界面上长得一样
 *    （都是「tag 路没参与」），根因却完全不同 —— 前者要去建索引，后者要去查建索引为什么空转。
 * ② **惰性**：绝大多数查询用不上 tag 路（自由词），而每个 worker 实例只该为它付一次探测。
 * ③ **缓存失败**：库不存在时若每次搜索都重试，就是每次多一次 stat + 一次异常构造。
 *    ⚠️ 代价是「同一个 worker 内不再重试」。这不会把用户永久卡住：worker 是**一次性**的
 *    （主任务结束即退出、主进程把 `this.worker` 置 null，见 `semantic-search.js`），
 *    下一次搜索是一个全新的模块实例，探测会重来。真正会复用同一实例的只有 relay
 *    （索引进行中代跑搜索），而那时本来也轮不到重建索引。
 */
let tagStoreTried = false;
let tagStoreHandle = null;
function openTagStoreReadOnly() {
  if (tagStoreTried) return tagStoreHandle;
  tagStoreTried = true;
  try {
    tagStoreHandle = new TagIndexStore(tagIndexPath(root), { readOnly: true });
  } catch (_) {
    // 库不存在 / 版本不符 / 表缺失 —— 三种都在这里收敛成同一个结论（「这趟没有 tag 路」），
    // 由 `describeTag` 报成 `NO_INDEX`，界面说一句人话。
    tagStoreHandle = null;
  }
  return tagStoreHandle;
}

/**
 * tag 路的**接线**：惰性拿只读句柄 → 解析查询 → 查一次倒排 → 交给 `mergeRoutes` 融合。
 *
 * ⚠️ 这里**故意只做 IO**，全部判据（RRF、route 归属、`matched`/`truncated` 口径、
 *   `similarity = null` 的理由）都在 `src/ai/tag-fusion.js#mergeRoutes` —— 因为那个文件
 *   能被回归用真夹具库整条跑通，而这个文件裸 node 一 `require` 就 `TypeError`
 *   （顶层读 `workerData.aiPath`）。**判据必须放在能被真跑的地方**，本仓已有先例。
 */
function tagRoute(store, query, result, options) {
  const enabled = !(options && options.tagEnabled === false);
  const tagStore = enabled ? openTagStoreReadOnly() : null;
  const parsed = tagFusion.parseQuery(query);
  const threshold = tagThreshold(options);
  let tagResult = null;
  let failure = '';
  if (tagStore && parsed.supported) {
    try {
      tagResult = tagStore.query(parsed.entry, { threshold, limit: TAG_MAX_RESULTS });
    } catch (error) {
      // 查询失败（库被截断 / 半写 / 磁盘故障）⇒ 降级成纯 CLIP，但**必须报出来**：
      // 静默降级正是「搜图有时灵有时不灵」这类工单的来源，而它会把人送去查模型。
      tagResult = null;
      failure = error.message;
    }
  }
  return tagFusion.mergeRoutes({
    clip: result,
    parsed,
    enabled,
    available: !!tagStore,
    failure,
    tagThreshold: threshold,
    tagResult,
    maxResults: MAX_RESULTS,
    // `store` 是主库（CLIP 库）的句柄 —— `photosByIds` 走的是 `photos` 表，与 `embeddings` 同在
    // 主库；tag 倒排库只有 `{id, score}`，补不出图片行。
    photosByIds: (ids) => store.photosByIds(ids),
  });
}

let cancelled = false;
let controller;
let busy = false;
// 索引进行中会顺手服务只读搜索请求（见下面的 relay 分支）：复用这两个已经建好的对象，
// 不新开 ONNX 会话——并发载入**第二份 SigLIP2** 会因内存耗尽把进程搞死（实测：单份索引
// worker 已能把 24GB 机器的可用内存压到个位数 MB）。relay 的价值就是把这一份用起来。
let activeEncoder = null;
let activeStore = null;
// 泛化文本的向量：一次编码，索引与检索共用（relay 也要用，所以挂在模块上）。
let activeBaseline = null;
const root = workerData.aiPath;
/**
 * ⚠️ 这里**刻意不留** `readyFile` 常量：`<root>/ready.json` 的路径与判定都归
 * `bundled-models#isSearchReady / writeSearchReady`（与主进程同一对函数）。
 * 自己 `path.join(root, 'ready.json')` 再 `JSON.parse` 一遍 = 第二份判据 —— 主进程
 * 那边的 `status()` 现在也按磁盘派生 `ready`，两份一旦漂就是「界面说没就绪、
 * 索引却照跑」这种不报错的错。
 */
const indexPath = path.join(root, 'semantic-index.sqlite');
const cacheDir = path.join(root, 'models');
// 标签的参数（语言 / 阈值 / 条数 / 分批大小）只在 src/ai/photo-tags.js 定义一次，
// 这里与主进程都只是引用 —— 主进程还要用同一套值算词表指纹，各写一份必然漂。
const progress = (state) => parentPort.postMessage({ progress: state });
const check = () => {
  if (cancelled) throw new Error('AI_CANCELLED');
};
const imageTypes = new Set(
  'jpg jpeg png webp gif bmp tif tiff heic heif avif cr2 cr3 nef nrw arw dng orf rw2 raw raf pef srw'.split(
    ' ',
  ),
);

/**
 * 预选词词表向量的磁盘缓存。
 *
 * ## 为什么必须缓存
 *
 * 词表是几百条，编码一条要 **约 40 ms**（本项目实测：单条 `text()` 平均 39.4 ms，309 条 ≈ 12.9 s）。
 * 这个钱花在「进搜图页时的预选词」上完全不可接受 —— 它会变成打开页面后十几秒没反应。
 * 而**词的向量只跟模型有关、与图库无关**，所以在 `install` 时算一次存下来，之后每次 suggest
 * 都只是 base64 解码 + 几百次点积（实测合计约 1.2 s，其中 1.2 s 是扫取样向量）。
 *
 * ## 为什么不能靠「批处理」或「缩短 padding」省这个钱
 *
 * 都实测过，两条路都不通：
 *   - 批量编码**没有**加速：`padding: 'max_length', max_length: 64` 下每条都被补到 64，
 *     批 16 与逐条的总计算量一样（实测批 16 全量 12745 ms vs 逐条 12200 ms）。
 *   - 改成动态 padding（补到批内最长）确实快 15 倍（839 ms），但向量**完全不同**：
 *     同一句话 `max_length=64` 与动态 padding 的最大逐位差 **0.38**，而且它还会随
 *     「同批里有没有长句」而变（把「内衣」和一句长描述放一批，差值 0.44）。同理
 *     `max_length` 从 64 降到 32 就差 0.147、降到 16 差 0.38。
 *     SigLIP2 的 `pooler_output` 对补齐长度就是这么敏感，所以 padding 是个**不能动的刻度** ——
 *     整个检索的阈值标定（0.01）都是在 `max_length: 64` 下做的，改了预选词的向量口径，
 *     「预选词说有图、点下去 0 张」就会重新出现。
 *
 * 缓存按 `MODEL_KEY` + 语言 + **词表原文数组**校验：换模型或改词表都会自动失效重算，
 * 不需要手工清缓存。任何一步出错都静默退回现场计算，绝不会因此让 suggest 失败。
 */
function vocabCacheFile(lang) {
  return path.join(root, 'vocab-vectors-' + (lang === 'en' ? 'en' : 'zh') + '.json');
}
function readVocabCache(lang, labels) {
  try {
    const data = JSON.parse(fs.readFileSync(vocabCacheFile(lang), 'utf8'));
    if (data.model !== MODEL_KEY || !Array.isArray(data.vectors)) return null;
    if (data.labels.length !== labels.length) return null;
    for (let i = 0; i < labels.length; i += 1) if (data.labels[i] !== labels[i]) return null;
    const vectors = data.vectors.map((item) => {
      const values = new Float32Array(DIMENSIONS);
      Buffer.from(item, 'base64').copy(Buffer.from(values.buffer), 0);
      return values;
    });
    return vectors.length === labels.length ? vectors : null;
  } catch (_) {
    return null;
  }
}
function writeVocabCache(lang, labels, vectors) {
  try {
    const encoded = vectors.map((values) =>
      Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64'),
    );
    const payload = JSON.stringify({ model: MODEL_KEY, labels, vectors: encoded });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(vocabCacheFile(lang) + '.tmp', payload);
    fs.renameSync(vocabCacheFile(lang) + '.tmp', vocabCacheFile(lang));
  } catch (_) {
    /* 缓存写不进去只是慢一点，不是错误 */
  }
}
/** 拿到词表向量：优先磁盘缓存，没有就现算并落盘。 */
async function vocabVectors(encoder, lang, labels) {
  const cached = readVocabCache(lang, labels);
  if (cached) return cached;
  const vectors = await encoder.texts(labels);
  check();
  writeVocabCache(lang, labels, vectors);
  return vectors;
}

/**
 * 只读操作的实际执行：检索与预选词打分。`execute`（自己起 worker）与 relay（托给索引 worker）
 * 共用这一段，两条路径的行为因此不可能分叉。
 */
async function readOnly(encoder, store, baselineVector, operation, query, options) {
  if (operation === 'search') {
    const vector = await encoder.text(query);
    check();
    const result = await store.search(
      vector,
      { threshold: matchThreshold(options), baseline: baselineVector },
      () => cancelled,
    );
    // CLIP 路每张图的向量都要过一遍点积，是这条路上唯一的成本；tag 路是倒排取批。
    // 两者都跑完才谈得上融合 —— 融合的那一段**是同步的**（better-sqlite3 全同步），
    // 所以这里不 await：它不产生任何让出点，写在 `await store.search` 之后即可。
    const fused = tagRoute(store, query, result, options);
    return { ...result, ...fused, indexed: store.count() };
  }
  if (operation === 'suggest') {
    // 预选词打分。两种入参：
    //   - `options.candidates`（老契约）：界面给一组词，回答「这些词有没有内容」；
    //   - 只给 `options.lang`：**词源在服务端**（`src/ai/search-vocabulary.js`），
    //     对整份词表打分后按真实命中数取前 N 个返回。
    // 之所以把词表挪到服务端：词表从 18 个变成几百个，再让界面把整份词表传过来毫无意义，
    // 而且桌面端与网页端各写一份必然漂移（原来两边就是各抄一份 18 词池）。
    //
    // 🔴 **2026-10-09 起，界面只走 `candidates` 这一半**：只给 `lang` 的常规路径改走主进程
    //    只读 SQL（`src/main/semantic-tags.js#SemanticTags.suggestTerms`，同一条
    //    `embeddings.tags` 表转置统计，实测 **45 ms**）—— 老路要起只读 worker、载文本编码器
    //    （~2.1 s）、开索引（~0.7 s）、扫取样向量打分（~1.2 s），冷启还要现算 308 个词的
    //    向量（~13 s），而答案只是「哪些词点下去有图」。
    //    **本半条刻意保留**：只有它能对**词表外**的任意词真去打分（SQL 路只能在 308 词表里
    //    查下标，词表外的词一律 0）。两条路服务的是两个不同的问题，不是新旧替换关系 ——
    //    两侧的出口都在 `main.js` / `web-server.js` 里按入参形状分岔，别合并。
    const explicit = Array.isArray(options && options.candidates)
      ? options.candidates.map((item) => String(item == null ? '' : item).trim()).filter(Boolean)
      : null;
    // 语言的判定必须与 `search-vocabulary.labelsFor()` 完全同源，否则会出现
    // 「把英文词表存进 zh 缓存文件」这种错配（下次读取时标签对不上、白算一遍）。
    const lang = String((options && options.lang) || '')
      .toLowerCase()
      .startsWith('en')
      ? 'en'
      : 'zh';
    const labels =
      explicit && explicit.length ? explicit : vocabulary.labelsFor(options && options.lang);
    check();
    // 词表那条走磁盘缓存（几百条现码一次要十几秒，理由见 vocabCacheFile 的注释）；
    // 界面自带的那几个词是临时输入，不占缓存。
    const vectors =
      explicit && explicit.length ? await encoder.texts(labels) : await vocabVectors(encoder, lang, labels);
    check();
    const candidates = labels.map((text, index) => ({ text, vector: vectors[index] }));
    const scored = await store.scoreCandidates(
      candidates,
      { threshold: matchThreshold(options), baseline: baselineVector },
      () => cancelled,
    );
    const minHits = Number.isFinite(Number(options && options.minHits))
      ? Math.max(1, Math.trunc(Number(options.minHits)))
      : DEFAULT_MIN_HITS;
    const limit = Number.isFinite(Number(options && options.limit))
      ? Math.min(SUGGEST_LIMIT_MAX, Math.max(1, Math.trunc(Number(options.limit))))
      : SUGGEST_LIMIT_DEFAULT;
    const terms = candidates
      .map((candidate, index) => ({ text: candidate.text, hits: scored.hits[index] }))
      // 命中 0 的词一律不返回：预选词存在的意义就是「点下去有图」，返回 0 命中的词
      // 等于把「已知没结果」的东西摆给用户点（旧实现正是这么干的）。
      .filter((term) => term.hits >= minHits)
      // 命中数相同时按词表原始顺序（`Array.prototype.sort` 自 ES2019 起稳定，
      // 而 `candidates` 就是按词表顺序生成的），因此同一份库重跑结果完全一致。
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit);
    return { sampled: scored.sampled, terms };
  }
  throw new Error('AI_BAD_OPERATION');
}

/**
 * 给「已有向量、但标签缺失或词表指纹过期」的行补标签。
 *
 * ## 为什么单独一个操作，而不是并进 index
 *
 * `index` 的 `batch()` 命中的行会被送去 `encoder.image()` **重新编码图片**（每张都要解码
 * 文件 + 跑一次视觉塔前向），因为那条谓词的语义是「向量需要重算」。而补标签一行图片都不用读：
 * 向量就是当初编码的结果，缺的只是「拿它与词表做点积」这一步。混进 index 的后果是
 * **静默巨量浪费** —— 老索引那 7374 行会因为缺标签被白重编码一遍，且这个代价只有真跑
 * 一次才看得出来（静态检查全绿）。
 *
 * ## 为什么它必须在 loadEncoder 之前返回
 *
 * 这里不需要任何 ONNX 会话：图片向量在库里、词表向量在磁盘缓存里、计算是点积。
 * 如果让它落到下面 `loadEncoder` 那条路上，为了 1.8 秒的纯算术要白载约 1 GB 的会话，
 * 而内存正是「索引在跑时还能不能搜图」的瓶颈（见 `semantic-search.js` 的 relay 注释）。
 */
function refreshTags() {
  const words = readCachedWordVectors(root, TAG_LANG, MODEL_KEY);
  // 没有词表向量 = 模型还没装 / 索引还没建过。**只报不抛**：这是「还没准备好」，
  // 不是错误，调用方据此提示用户去建索引即可。
  if (!words) return { tagged: 0, total: 0, reason: 'AI_TAG_VOCAB_MISSING' };
  const store = new IndexStore(workerData.dbPath, indexPath);
  try {
    const total = store.pendingTagsCount(words.key);
    if (!total) return { tagged: 0, total: 0 };
    // 倒序游标：从最大的 photo_id 往下补（新入库的先有标签）。
    // 游标域是 `embeddings.photo_id`，所以起点取的是 `maxEmbeddingPhotoId()` 而不是 `maxPhotoId()`。
    let cursor = store.maxEmbeddingPhotoId() + 1;
    let done = 0;
    for (;;) {
      check();
      const rows = store.batchPendingTags(cursor, TAG_BATCH, words.key);
      if (!rows.length) break;
      const entries = rows.map((row) => ({
        photoId: row.photo_id,
        indexes: indexesOf(computeTags(row.vector, words.vectors, row.generic_sim)),
        key: words.key,
      }));
      // 写失败就整批丢掉：游标照常前进，这一批的 tags 仍是 NULL，
      // 下一轮补标签会重新捞到它们（幂等，不会留下半写状态）。
      store.setTags(entries);
      // 倒序：最后一行是本批**最小**的 photo_id，游标严格递减
      cursor = rows[rows.length - 1].photo_id;
      done += rows.length;
      progress({ phase: 'tagging', done, total, totalEstimated: false });
      if (rows.length < TAG_BATCH) break;
    }
    return { tagged: done, total };
  } finally {
    store.close();
  }
}

/**
 * 建 tag 倒排索引（第二路）时，一次在 `photos` 上往下取多少个 id 来筛待办。
 *
 * 取 4× batch（64）是刻意的：筛掉已打标的那部分 id 靠的是 `tag_photo` 的**点查**，
 * 一次 64 个探针约 0.5 ms，而真正贵的是**取图**（读缩略图 BLOB + 两步 sharp）。
 * 窗口比一批大几倍，能保证「凑够一批要打的图」不必反复进出循环。
 */
async function execute(operation, query, options) {
  fs.mkdirSync(root, { recursive: true });
  if (operation === 'status') {
    // 判据与主进程 `status()` 共用一个函数（不要在这里再写一遍 JSON.parse 比对）。
    const ready = isSearchReady(root, MODEL_KEY);
    const store = new IndexStore(workerData.dbPath, indexPath);
    try {
      return { ready, indexed: store.count() };
    } finally {
      store.close();
    }
  }
  if (operation !== 'install') {
    // 模型没就绪（文件缺失 / 版本对不上 / JSON 坏了）一律在这里挡住，别让后面的编码器加载去背锅。
    if (!isSearchReady(root, MODEL_KEY)) throw new Error('AI_MODEL_MISSING');
  }
  // 补标签必须在 loadEncoder 之前收口（原因见 refreshTags 的注释）。
  if (operation === 'tag') return refreshTags();
  const originalFetch = global.fetch;
  if (operation === 'install') {
    controller = new AbortController();
    global.fetch = (url, options = {}) =>
      originalFetch(url, { ...options, signal: controller.signal });
  }
  let encoder;
  let store;
  try {
    progress({ phase: operation === 'install' ? 'downloading' : 'loading' });
    encoder = await loadEncoder(cacheDir, {
      download: operation === 'install',
      // 纯搜图只要文本编码器：视觉那份实测占约 270 MB 常驻内存，而内存正是「另一套索引
      // 在跑时还能不能搜图」的瓶颈。建索引必须能编码图片，所以那里保持两份都载——
      // 顺带一说，索引 worker 手里的这份文本编码器正是 relay 搜索复用的对象。
      textOnly: TEXT_ONLY_OPERATIONS.has(operation),
      progress: (event) => {
        check();
        if (event.status === 'progress')
          progress({ file: event.file, percent: Math.round(event.progress || 0) });
      },
    });
    check();
    if (operation === 'install') {
      // Validate both encoders before marking the local cache ready.
      await encoder.text(GENERIC_TEXT);
      await encoder.image(
        await sharp({ create: { width: 224, height: 224, channels: 3, background: '#888888' } })
          .png()
          .toBuffer(),
      );
      check();
      // 写 ready.json 也走共用实现（内部同样是 `.tmp` + rename，落盘原子）。
      writeSearchReady(root, MODEL_KEY);
      // 顺手把预选词的词表向量算好存下来：这一步正好在跑重活、编码器就在手上，多花的十几秒
      // 混在「下载模型」里没人会注意到；否则第一次进搜图页要为了预选词多等十几秒。
      progress({ phase: 'loading' });
      for (const lang of ['zh', 'en']) {
        const labels = vocabulary.labelsFor(lang);
        if (!readVocabCache(lang, labels)) await vocabVectors(encoder, lang, labels);
      }
      check();
      return { ready: true };
    }
    store = new IndexStore(workerData.dbPath, indexPath);
    // 交给索引循环里的只读搜索（relay）复用：编码器与库连接都已就绪，不必再开一份。
    activeEncoder = encoder;
    activeStore = store;
    // 基线只编码一次：检索时每张图片都要减掉它与泛化文本的相似度（原因见 embedding.js）。
    const baselineVector = await encoder.text(GENERIC_TEXT);
    check();
    activeBaseline = baselineVector;
    // 没有词表缓存就顺手补上（两种语言各约 13 秒）。放在这里而不是等 suggest：
    // 建索引本来就是个长任务，这十几秒混在里面看不见；等到进搜图页才算，
    // 用户看到的就是「打开页面后十几秒预选词一直不出来」。已经有缓存时这里是零成本。
    if (!TEXT_ONLY_OPERATIONS.has(operation)) {
      for (const lang of ['zh', 'en']) {
        const labels = vocabulary.labelsFor(lang);
        if (readVocabCache(lang, labels)) continue;
        progress({ phase: 'loading' });
        await vocabVectors(encoder, lang, labels);
        check();
      }
    }
    if (TEXT_ONLY_OPERATIONS.has(operation)) {
      // 预选词有专属于自己的进度文案（`suggest: 匹配预选词`）——它现在要编码几百个词、
      // 再扫一遍取样向量，耗时不再可以忽略，报成「搜索中」会让用户以为搜图卡住了。
      progress({ phase: operation === 'suggest' ? 'suggest' : 'searching' });
      // ⚠️ **必须是 `return await`，不能只写 `return`**。这不是风格问题：
      // `execute` 外层是 `try { ... } finally { store.close(); await encoder.dispose(); }`，
      // 而 `return <promise>` 会**先求值 promise、立刻执行 finally**，于是 `dispose()` 与
      // 仍在跑的 `readOnly()` 并发 —— 编码器会话被释放、SQLite 连接被关掉，而 `readOnly`
      // 还在用它们。实测症状就是**搜图和预选词全挂**：模型报
      // `An error occurred during model execution: "Error: Session already disposed."`，
      // 主进程只看到 `AI_WORKER_EXIT`/该错误串，且失败点随 dispose 与推理谁先跑完而漂移
      // （有时第一批判死、有时编码完 13 秒才在打分阶段死），所以极容易被当成随机故障。
      // 加 `await` 后 finally 会在 readOnly 真正结束后才执行，两条路径（search / suggest）
      // 一起恢复正常。回归见 scripts/semantic-regression.js 的静态契约。
      return await readOnly(encoder, store, baselineVector, operation, query, options);
    }
    /**
     * 标签要用的词表向量。与检索预选词**共用同一份磁盘缓存**，所以上面那个
     * 「没有缓存就编码一次」的循环（install/index 都会走）已经把这份数据备好了，
     * 这里通常是零成本读取。万一仍旧读不到（缓存被手工删掉等），退回现场编码一次 ——
     * 宁可贵 13 秒，也不能让整个建索引因为标签而失败。
     */
    const tagLabels = vocabulary.labelsFor(TAG_LANG);
    const tagCache = readCachedWordVectors(root, TAG_LANG, MODEL_KEY);
    const tagWords = {
      vectors: tagCache ? tagCache.vectors : await vocabVectors(encoder, TAG_LANG, tagLabels),
      key: vocabKey(MODEL_KEY, tagLabels),
    };
    check();
    // 🔴 倒序游标：起点比 MAX(id) 大一格，否则 id 最大那张永远扫不到；
    // 写 0 会让 `batch(0)` 等价于 `id < 0` 恒空 —— 任务「秒完成」却一张不建、不报错。
    let before = store.maxPhotoId() + 1;
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let indexed = store.count();
    /**
     * 分母：候选集规模的**抽样估计值**（只在起手算一次 ⇒ 它是**起始快照**）。
     *
     * 🔴 **单独 try**：分母只是给用户看「大概还要多久」的装饰信息，**估不出来只该让百分比消失，
     *    不该让整个索引失败** —— 这是个要跑几十小时的任务，为一个进度读数把它弄死不可接受。
     * ⚠️ 它必须与 `store.batch()` 同源（共享 `CANDIDATE_PRED`），否则百分比与真实工作量脱钩。
     *
     * 🔴 **必须先报 `'counting'` 再去估**（`docs/contracts/background-tasks.md` §3.1.4）。
     *    顺序反了的话，估算那段时间界面读到 `done = 0 / total = 0`，只能画成「完成 0」——
     *    与「估计失败」不可区分。三态与缩略图补全同一套（详见 `face-worker.js` 同一处的推导）。
     *
     * ⚠️ 三态 `countPhase` 与 `totalEstimated` **正交**：一个说「分母算到哪一步」，
     *    一个说「分母是估的还是精确数的」。合成一个字段 = `totalEstimated` 在「估成功」
     *    与「估失败」下取值相同 = 零信息量。
     */
    let estimatedTotal = 0;
    let countPhase = 'counting';
    progress({
      phase: 'indexing',
      done: processed,
      failed,
      skipped,
      indexed,
      total: 0,
      totalEstimated: true,
      countPhase,
    });
    try {
      const est = store.estimatePendingCount();
      estimatedTotal = Math.max(0, Number(est && est.estimate) || 0);
      countPhase = 'ready';
    } catch (eEst) {
      estimatedTotal = 0;
      countPhase = 'failed';
    }
    progress({
      phase: 'indexing',
      done: processed,
      failed,
      skipped,
      indexed,
      total: estimatedTotal,
      totalEstimated: true,
      countPhase,
    });
    const startedAt = Date.now();
    const report = (photo) =>
      progress({
        done: processed,
        failed,
        skipped,
        indexed,
        // 🔴 **完整路径**，不是 `file_name`：后台任务面板那条「文件」行要能定位到是哪张图，
        // 与缩略图补全 / 重建（`main.js` 的 `currentFile = row.file_path`）同口径。
        // `batch()` 的 SELECT 里现成有 `p.file_path`，取文件名是白白丢掉目录信息。
        currentFile: photo.file_path,
        ratePerMinute: Math.round(
          ((processed + failed) * 60000) / Math.max(1000, Date.now() - startedAt),
        ),
      });
    while (true) {
      check();
      const rows = store.batch(before);
      if (!rows.length) break;
      for (const photo of rows) {
        check();
        before = photo.id;
        if (!imageTypes.has(path.extname(photo.file_name).slice(1).toLowerCase())) {
          skipped++;
          report(photo);
          await new Promise((resolve) => setImmediate(resolve));
          continue;
        }
        try {
          // 同上：完整路径（面板「文件」行的口径，见 `report()` 里那条注释）。
          progress({ currentFile: photo.file_path });
          /**
           * ⚠️ 这条链**与 `joytag-model.js#prepareSource` 必须逐字同源**
           * （`scripts/joytag-index-regression.js` 会剥掉注释后逐字比对）。
           * JoyTag 那一路（`semantic-tag-worker.js`）自己取图走的就是 `prepareSource`；
           * 两处各写一份 = 同一张图在两条路下产出不同分数，而两边都不报错。
           */
          const prepare = (input) =>
            sharp(input, { limitInputPixels: 100000000 })
              .rotate()
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .removeAlpha()
              .jpeg()
              .toBuffer();
          let bytes;
          try {
            bytes = await prepare(photo.thumbnail || photo.file_path);
          } catch (error) {
            check();
            if (!photo.thumbnail) throw error;
            bytes = await prepare(photo.file_path);
          }
          const vector = await encoder.image(bytes);
          check();
          // 顺手把基线一起落库：这个向量就在手上，不存下来就要在第一次检索时补算一遍。
          const baseline = dot(baselineVector, vector);
          // 标签同理顺手算掉：图片向量与词表向量此刻都在手上，纯点积、不解码任何东西，
          // 边际成本≈0。漏算也不算错（batchPendingTags 之后会补），只是白多跑一趟。
          // ⚠️ 这是 **CLIP 词表**那一路标签（存 `embeddings.tags`）；JoyTag 倒排
          // （`tag-index.sqlite`）由并行的 `semantic-tag-worker.js` 负责，两套词表必须分立。
          store.put(photo, vector, baseline, {
            indexes: indexesOf(computeTags(vector, tagWords.vectors, baseline)),
            key: tagWords.key,
          });
          processed++;
          indexed++;
        } catch (error) {
          check();
          failed++;
          progress({ lastFailedId: photo.id, failure: 'AI_IMAGE_UNREADABLE' });
        }
        report(photo);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    /**
     * JoyTag 倒排那一趟**不在这里**：它由并行的 `semantic-tag-worker.js` 用自己的游标
     * 扫全库（并行结构里它的覆盖面天然就是全库，见该文件头注释）。本趟的返回值里
     * 因此不再有 `tags` —— 主进程会从 tag worker 的结果里取来补上。
     */
    return { indexed: store.count(), done: processed, failed, skipped };
  } finally {
    global.fetch = originalFetch;
    controller = null;
    activeEncoder = null;
    activeStore = null;
    activeBaseline = null;
    if (store) store.close();
    if (encoder) await encoder.dispose();
  }
}

parentPort.on('message', async (message) => {
  if (message.cancel) {
    cancelled = true;
    if (controller) controller.abort();
    return;
  }
  // 只读请求（检索 / 预选词打分）的 relay 单独走一路回话，任何时候都不当作一次主任务：
  // 否则「索引刚好结束」时它会被当成主任务跑完，父进程可能把搜索结果误当成
  // 索引结果（反过来本次搜索也永远等不到回话）。
  if (message.relay != null) {
    const ticket = message.relay;
    if (
      !TEXT_ONLY_OPERATIONS.has(message.operation) ||
      !activeEncoder ||
      !activeStore ||
      !activeBaseline
    ) {
      parentPort.postMessage({ relay: ticket, error: 'AI_BUSY' });
      return;
    }
    try {
      const result = await readOnly(
        activeEncoder,
        activeStore,
        activeBaseline,
        message.operation,
        message.query,
        message.options,
      );
      parentPort.postMessage({ relay: ticket, result });
    } catch (error) {
      parentPort.postMessage({
        relay: ticket,
        error: cancelled ? 'AI_CANCELLED' : error.message,
      });
    }
    return;
  }
  // 主任务（建索引）正在跑：其余消息一律不处理，等它跑完。
  if (busy) return;
  busy = true;
  cancelled = false;
  try {
    const result = await execute(message.operation, message.query, message.options);
    parentPort.postMessage({ done: true, result });
  } catch (error) {
    parentPort.postMessage({ done: true, error: cancelled ? 'AI_CANCELLED' : error.message });
  } finally {
    busy = false;
  }
});
