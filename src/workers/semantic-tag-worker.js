'use strict';

/**
 * JoyTag tag 倒排的**独立 worker**（2026-10-08 起：与 CLIP 那一路**并行**，见下）。
 *
 * ## 为什么它是一个单独的 worker 文件（而不是 `semantic-worker.js` 里的一个分支）
 *
 * 「CLIP(cpu) ∥ JoyTag(dml) 两条路并行」实测（`bench/probe-parallel.js par`，同批真实缩略图）：
 * 串行合趟 587 ms/张 ⇒ 并行 416 ms/张（临界路径 = JoyTag 那一路），重叠率 100%，**1.41×**
 * （全库 11.2 → 8.0 天）。前提与代价（完整推导见 `docs/contracts/semantic-search.md`）：
 *   · **同进程多 ONNX 会话只有 `cpu + dml` 这一种组合能跑** ⇒ 两个会话必须分属两个线程；
 *   · 核显与 CPU 抢同一份内存带宽 ⇒ CLIP 那路被拖慢 59%（191 → 304），收益没有
 *     「max(191,396)=396 ⇒ 1.48×」那么漂亮，但仍值 1.41×；
 *   · 图片递不过线程 ⇒ JoyTag 必须**自己从库里取图**（比顺手递 bytes 多付约 7 ms/张，可忽略）。
 *
 * 拆成独立文件还有三条顺带的好处：
 *   · 本进程**只有 joytag-model 这一份 ONNX**（不 require `../ai/embedding`，不载
 *     `@huggingface/transformers`）—— `onnxruntime.dll` 双副本名冲突（joytag-index.md §9）
 *     在这个进程里从根上不存在；
 *   · 不载 SigLIP2，省约 1 GB 内存；
 *   · CLIP worker（`semantic-worker.js`）里那一整块 tag 跟踪代码随之搬空，两条路的代码
 *     物理隔离，谁也改不坏谁的取批。
 *
 * ## 与 CLIP 路的分工（为什么不再需要 `offer()`）
 *
 * 旧结构里 tag 覆盖面 = `offer()`（CLIP 循环顺手递图）∪ `drain()`（自己的游标扫全库），
 * 那是因为 drain 排在 CLIP **之后**跑。并行结构里本 worker **从起跑就自己扫全库**
 * （同一台发动机、同一套 `hasPhoto()` 精确判重），覆盖面天然就是全库 —— `offer()` 的
 * 「省一次解码」红利（约 7 ms/张）抵不过「两条路都要协调」的复杂度，**整体退役**。
 * 代价是「新库首建」时每张图多解一次码（实测已计入上面 396/416 那两个数）。
 *
 * ## 消息协议（与 `semantic-worker.js` 同一套，父进程按「信封」分发）
 *   · 进度帧：**只许 `tag*` 前缀的键**（父进程是 `Object.assign(this.state, …)` 共享合并，
 *     碰 `done` / `total` / `phase` 就是拿 tag 的分母盖掉 CLIP 的分母——守护 ② 钉死）；
 *   · `{ done: true, result }` / `{ done: true, error }`：信封与 `semantic-worker.js` 同形，
 *     `result` 里只有 `{ tags }`（父进程只从这里取 tags，别的不许漏进共享字段）；
 *   · `{ cancel: true }` ⇒ `check()` 开始抛 `AI_CANCELLED`。
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  TagIndexStore,
  tagIndexPath,
  TAG_INDEX_MODEL,
  STORE_MIN_SCORE,
} = require('../ai/tag-index-store');
const tagLabels = require('../ai/tag-labels');
const { vocabFingerprint } = require('../ai/tag-vocabulary');
/**
 * JoyTag 打标编码器（模型身份 / 预处理 / 批量前向的唯一真相源）。
 *
 * ⚠️ 保持**模块级** require：本进程唯一的那份 `onnxruntime-node` 在这里进内存。
 * （在旧的单 worker 结构里，这条 require 必须发生在 `loadEncoder()` 拉进
 * `@huggingface/transformers` 之前，否则两份 `onnxruntime.dll` 名冲突会让进程原生 abort。
 * 拆分后本进程没有 transformers，冲突不存在了；模块级这个纪律保留 —— 万一将来有人把
 * 两个 worker 合回一个进程，它仍然是对的。静态断言见 `scripts/joytag-index-regression.js`。）
 */
const joytag = require('../ai/joytag-model');
const gpuProbe = require('../main/gpu-probe');
const logger = require('../main/logger');

const root = workerData.aiPath;
const cacheDir = path.join(root, 'models');
let cancelled = false;
let busy = false;
const progress = (state) => parentPort.postMessage({ progress: state });
const check = () => {
  if (cancelled) throw new Error('AI_CANCELLED');
};

/** 一趟扫描的取批窗口（`photos` 上按 id 倒序取多少个 id 判重一次）。 */
const TAG_SCAN_WINDOW = 64;

/**
 * tag 倒排建索引那一趟的发动机。
 *
 * ## 判重为什么不用 SQL 反连接
 *
 * `tag_photo` 住在**另一个 SQLite 文件**里，与 `photos` 没法反连接。唯一能让 SQLite
 * 做这件事的办法是 `ATTACH` 之后全表扫 `photos` —— 而这张表带 21 GB 内联缩略图，
 * 实测（真库 1,656,580 行）：走覆盖索引列出全部 id 要 **1106 ms**，走主键树带 BLOB
 * 则直接变成几十 GB 的读。所以判据反过来：**先在 `photos` 上按 id 取窗口，再用点查筛**。
 *
 * ⚠️ 每趟任务**从头扫**（游标是本次的局部变量，不落盘）。代价是「已全部打完」的那一趟
 * 要多做 1,656,580 次 `hasPhoto` 点查（实测约 5 s）；换来的是**失败可自动重试** ——
 * 没打成标的图不会因为「水位线过了」而永远漏掉，这对 `K:\COS` / `G:\T` 这种外置盘
 * （会掉线）是必须的。把水位线落盘的写法在这一点上是错的。
 */
function createTagIndexTrack(options) {
  const source = options.source;
  const cacheDir = options.cacheDir;
  const check = options.check;
  const report = options.progress;
  const stats = {
    done: 0,
    failed: 0,
    empty: 0,
    pairs: 0,
    skippedUnknown: 0,
    scanned: 0,
    batches: 0,
  };
  let batches = [];
  let encoder = null;
  let encoderError = '';
  let engine = '';
  let fallback = '';
  let lastError = '';
  /** 可写句柄。**要写第一行时才开** —— 见 `hasPhoto` 上方那段「空库不是没库」。 */
  let writer = null;
  /** 只读句柄，只为判重。库不存在时它是 `null`（= 一张都没打过标）。 */
  let probe = null;
  let probeTried = false;
  let identityWritten = false;
  let scanStmt = null;
  let rowStmt = null;

  /**
   * 来源凭证（`tag_photo.source_spec`）里「缩略图那一档」的拼法。
   *
   * `0` / `''` = **未知规格**（项目全局约定），不是「没有缩略图」—— 有没有缩略图看
   * 取图那一步是否回落到了原图。
   */
  function thumbSpec(size, format) {
    return 'thumb:' + (Number(size) || 0) + ':' + (format || '');
  }

  /**
   * 🔴 **可写打开会凭空造库，所以不许在「还没确定要写」之前开它。**
   *
   * 查询侧（搜索 worker 里的 `openTagStoreReadOnly`）靠「文件存不存在」区分「没有索引」
   * 与「索引是空的」；建索引侧如果一进来就 `new TagIndexStore(path)`（非只读），一台
   * **从没建过 tag 索引**的机器上就会立刻多出一个**空库**（表都在、`schema_version` 也在）。
   * 于是那个区分当场失效：界面看到库在、`tag_photo` 为空，会说「这个词没有命中」——
   * 而真相是**一次都没跑过**。这正是本仓最怕的静默失效形态，所以：
   *   · 判重走**只读**句柄（不存在就当「全都没打过」）；
   *   · 可写句柄等编码器真的装好、马上要写第一行时才开。
   */
  function hasPhoto(photoId) {
    if (writer) return writer.hasPhoto(photoId);
    if (!probeTried) {
      probeTried = true;
      try {
        probe = new TagIndexStore(tagIndexPath(root), { readOnly: true });
      } catch (_) {
        // 库不存在 / 版本不符 / 表缺失 —— 三种都收敛成同一个结论：这张图没打过标。
        probe = null;
      }
    }
    return probe ? probe.hasPhoto(photoId) : false;
  }

  /** 开可写句柄并写索引身份。**这是整个文件里唯一创建 tag 库的地方。** */
  function writableStore() {
    if (writer) return writer;
    writer = new TagIndexStore(tagIndexPath(root));
    return writer;
  }

  /**
   * 索引身份（`META_KEYS` 那几项）。**只在真的写出第一行前写一次**，之后每次任务刷新
   * `updated_at` 就够 —— 这一组字段的作用是「这份索引是哪一版模型 / 词表 / 预处理建的」，
   * 中途变值只可能是有人改了代码，那时库里的分数已经不可信了。
   *
   * ⚠️ `model` 用 `TAG_INDEX_MODEL`（与 `tag_meta.model` / `tag_photo.engine` 同一族），
   * 不是 `joytag.VERSION` —— 后者是**权重**的名字，`TAG_INDEX_MODEL` 是**索引**的名字。
   */
  function writeIdentity(store) {
    const fingerprint = tagLabels.fingerprint();
    store.setMeta('model', TAG_INDEX_MODEL);
    store.setMeta('label_sha256', fingerprint.sha256);
    store.setMeta('label_lines', String(fingerprint.lines));
    store.setMeta('vocab_key', vocabFingerprint());
    store.setMeta('prep_spec', joytag.PREP_SPEC);
    store.setMeta('min_score', String(STORE_MIN_SCORE));
    store.setMeta('engine', engine);
    if (!store.getMeta('created_at')) store.setMeta('created_at', String(Date.now()));
    identityWritten = true;
  }

  /** 一次取批：`photos` 上按 id 倒序取 ≤ `limit` 个 id（只列 id，不碰 BLOB）。 */
  function prepareStatements() {
    if (scanStmt) return;
    /**
     * `idx_photos_id_hasThumb`（`ON photos(id, has_thumbnail)`）是本工程里唯一一条
     * **覆盖全部行**的 id 索引，走它列 id 是纯索引扫描（真库 165 万行实测 1106 ms）。
     * 但它**不是 `db.init()` 建的**（由缩略图修复那趟维护任务创建），老库上可能没有 ——
     * 缺了就退回不加提示的形式，并**打一条 warn**（那时走的是主键树，会读到缩略图页，
     * 慢 1~2 个数量级；不许静默）。
     */
    let hasIdIndex = false;
    try {
      hasIdIndex = !!source
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_photos_id_hasThumb'",
        )
        .get();
    } catch (_) {
      // 查不动 sqlite_master 就按「没有」处理：下面那条 warn 会说出来，
      // 而「判不出索引在哪」不该让整趟建索引失败。
    }
    if (!hasIdIndex)
      logger.warn(
        '[ai] 缺 idx_photos_id_hasThumb：tag 建索引的取批会走主键树（要读缩略图页，慢 1~2 个数量级）',
      );
    scanStmt = source.prepare(
      (hasIdIndex ? 'SELECT id FROM photos INDEXED BY idx_photos_id_hasThumb' : 'SELECT id FROM photos') +
        ' WHERE id < ? ORDER BY id DESC LIMIT ?',
    );
    rowStmt = source.prepare(
      'SELECT id, thumbnail, file_path, thumb_size, thumb_format FROM photos WHERE id = ?',
    );
  }

  async function ensureEncoder() {
    if (encoder || encoderError) return encoder;
    try {
      encoder = await joytag.load(cacheDir, { provider: options.provider, check });
      engine = encoder.engine;
      fallback = encoder.fallback;
      if (fallback)
        // 🔴 回落必须**可见**：静默回落 CPU 会让人以为跑的是显卡，而实际整条链路都在 CPU 上，
        //    于是「换了显卡怎么没变快」永远查不出原因（与 gpu-probe.js 同一条纪律）。
        logger.warn('[ai] JoyTag 的 dml 会话建立失败，已回落 ' + engine + '：' + fallback);
      logger.log('[ai] JoyTag 打标引擎 = ' + engine + ' | 批 ' + encoder.batch);
    } catch (error) {
      encoderError = error && error.message ? error.message : String(error);
      // 模型缺失 / 校验不过 —— 只报不抛：本 worker 如实自述（界面说「tag 索引没建」
      // 而不是「搜图坏了」），CLIP 那一路在另一个线程里照跑、互不受影响。
      logger.warn('[ai] JoyTag 编码器不可用，本次不建 tag 索引：' + encoderError);
    }
    return encoder;
  }

  /**
   * 把攒下的图送进模型。
   *
   * 🔴 **必须凑批**：batch=1 时 GPU 比 CPU 还慢 31%，batch≥8 才反超 3.4×
   * （实测见 `joytag-model.js#BATCH`）。
   *
   * `force=true` 表示「把队列**清空**」（不是「强行跑一批」，理由见下面那段 —— 差一个尾巴）。
   *
   * 整批失败（模型报错 / 被取消）时**一张都不写**：游标照常前进，下一次任务会重新捞到它们
   * （`hasPhoto` 仍为假）。
   */
  async function flush(force) {
    if (!batches.length) return;
    const model = await ensureEncoder();
    if (!model) {
      batches = [];
      return;
    }
    if (!force && batches.length < model.batch) return;
    /**
     * 🔴 `force` 的语义是「把队列**清空**」，不是「强行跑一批」。
     *
     * 一次只 `splice(0, model.batch)` 的写法实测会错两件事：
     *
     * ① **`result.tags` 比库里实况少一个尾巴**。`stats()` 是在任务收尾**之前**取走的，
     *    没冲完的那些要等 `finish()` 才落库。实测老库补建那一趟报 `done:16 / pairs:896`，
     *    而同一时刻库里是 24 张 / 1742 对 —— 界面报一个比实际小的数，没人查得动。
     *    丢多少 = `TAG_SCAN_WINDOW`(64) − `batch`(16)。
     * ② **「drain 开头队列必空」的保证只有半截**。只冲一批的话，队列剩得下就不再成立。
     *
     * `force=false` 仍旧只跑一批（`break`），那条「没攒够就别跑」的语义一点没动。
     */
    for (;;) {
      const slice = batches.splice(0, model.batch);
      if (!slice.length) break;
      check();
      let scores;
      try {
        scores = await model.tag(slice.map((item) => item.bytes));
      } catch (error) {
        if (error && error.message === 'AI_CANCELLED') throw error;
        stats.failed += slice.length;
        if (!lastError) lastError = error && error.message ? error.message : String(error);
        return;
      }
      const store = writableStore();
      if (!identityWritten) writeIdentity(store);
      for (let i = 0; i < slice.length; i += 1) {
        try {
          const result = store.put(slice[i].id, scores[i], {
            sourceSpec: slice[i].sourceSpec,
            engine: model.engine,
          });
          stats.done += 1;
          stats.pairs += result.stored;
          stats.skippedUnknown += result.skippedUnknown;
          // 「打过标但一个都没留下」是阈值过滤的必然代价，但要能看见（与台架同口径）。
          if (!result.stored) stats.empty += 1;
        } catch (error) {
          stats.failed += 1;
          if (!lastError) lastError = error && error.message ? error.message : String(error);
        }
      }
      stats.batches += 1;
      if (!force) break;
    }
  }

  /** 已打过标的张数（没有库就是 0）。 */
  function taggedCount() {
    try {
      return Number((writer || probe).status().photos) || 0;
    } catch (_) {
      return 0;
    }
  }

  /**
   * 待办规模（**估计值**，只给用户看进度）。
   *
   * 单独 try：分母只是装饰，**估不出来只该让百分比消失，不该让整个任务失败**
   * （这是个要跑几十小时的任务，为一个进度读数把它弄死不可接受）。
   * 口径 = `photos` 行数 − `tag_photo` 行数。两张表在两个库里，所以它不是精确数，
   * 对外一律带 `totalEstimated: true`。
   */
  function estimatePending() {
    try {
      const photos = Number(source.prepare('SELECT COUNT(*) AS n FROM photos').get().n) || 0;
      return Math.max(0, photos - taggedCount());
    } catch (_) {
      return 0;
    }
  }

  /**
   * 报一次 tag 趟的进度。
   *
   * 🔴 **绝不许往 `done` / `total` / `failed` / `countPhase` / `phase` 这几个键里写。**
   *
   * 父进程收进度帧是 `Object.assign(this.state, message.progress)`
   * （`src/main/semantic-search.js#handleWorkerMessage`）—— 那是一套**共享**的扁平字段，
   * 不是按阶段分开的命名空间。而 tag 趟的分母（待打标张数）与 CLIP 趟的分母（待索引张数）
   * 差好几个数量级：直接写进去就是拿「24」盖掉「484000」，面板的分子 / 分母 / 百分比
   * 会一起变成另一件事的数字，而且**一个错都不报**。
   * （并行结构里两个 worker 的进度帧**都**走这同一个 `Object.assign` —— 能安全合并的前提
   * 正是「两边键集不相交」：CLIP 路写共享字段、本 worker 只写 `tag*`。这条边界由
   * `scripts/joytag-index-regression.js` 的 ② 钉死，两边哪边越界都必须红。）
   *
   * ⇒ tag 的数字一律走 `tag*` 前缀。**消费者是渲染端 AI 两节那段**
   * （`scan-flow.js#renderBackgroundTaskPanel` 的 `getElementById(prefix + 'TagCount')`
   * ⇒ `#taskSemanticTagCount`，画成与主行并列的第二条计数行；人脸节刻意没有这一格）。
   * 🔴 **这里不许上报百分比** —— `tagPct` 由 `main/semantic-search.js#status()` 用
   * `computePct(tagDone, tagTotal)` 派生（与主行 `pct` 同一规矩：主进程算、渲染端不自己除）。
   * 对应的字段在 `semantic-search.js` 的 `state` 起手里已登记并逐轮重置，改键名两边必须同改。
   */
  function announce(total, countPhase) {
    report({
      tagStage: 'tags',
      tagDone: stats.done + stats.failed,
      tagFailed: stats.failed,
      tagTotal: total,
      tagTotalEstimated: true,
      tagCountPhase: countPhase,
    });
  }

  /** 用**自己的游标**把全库扫完 —— 并行结构里这就是本 worker 的全部工作量。 */
  async function drain() {
    /**
     * 🔴 **开扫前先把队列冲空**（`force=true` 的清空语义）。
     *
     * 旧结构里这句冲的是「CLIP 循环攒下的半批」——不冲的话 `hasPhoto()` 还是假，
     * 同一张图会被收第二遍（实测过 `done` / `pairs` 翻倍，库里看不出异常）。
     * 并行结构里本 worker 起手时 `batches` 必空，这句是**幂等**的（空队列直接返回）；
     * 保留它是把「drain 开头队列必空」当成显式保证写出来 —— 将来谁往 drain 前面
     * 加攒批逻辑，这句会替他兜住。
     */
    await flush(true);
    prepareStatements();
    let maxId;
    try {
      maxId = Number(source.prepare('SELECT MAX(id) AS m FROM photos').get().m);
    } catch (error) {
      logger.warn('[ai] 取 MAX(photos.id) 失败，tag 补建跳过：' + (error && error.message));
      return;
    }
    if (!Number.isFinite(maxId)) return;
    /**
     * 先零成本地看一眼有没有活干：**已打标张数 === 照片张数**就整趟退出，
     * 于是「一切都已建好」的那一次点按不会去载 366 MB 的权重。
     * （两者是两个库的行数，理论上可能不等但都不缺；差一点也只是多扫一趟，不影响正确性。）
     */
    if (taggedCount() >= Number(source.prepare('SELECT COUNT(*) AS n FROM photos').get().n)) return;
    const total = estimatePending();
    announce(total, 'ready');
    let cursor = maxId + 1;
    for (;;) {
      check();
      const window = scanStmt.all(cursor, TAG_SCAN_WINDOW);
      if (!window.length) break;
      cursor = window[window.length - 1].id;
      stats.scanned += window.length;
      let offered = 0;
      for (const row of window) {
        if (hasPhoto(row.id)) continue;
        const photo = rowStmt.get(row.id);
        if (!photo) {
          stats.failed += 1;
          continue;
        }
        try {
          // 取图口径必须与 CLIP 循环**逐字同源**（同一条 512 内接链），否则同一张图
          // 在两条路上会产出不同的分数（守护 ① 逐字比对）。
          let bytes = null;
          let sourceSpec = 'file';
          if (photo.thumbnail && photo.thumbnail.length) {
            try {
              bytes = await joytag.prepareSource(photo.thumbnail);
              sourceSpec = thumbSpec(photo.thumb_size, photo.thumb_format);
            } catch (_) {
              bytes = null;
            }
          }
          if (!bytes) {
            bytes = await joytag.prepareSource(photo.file_path);
            sourceSpec = 'file';
          }
          batches.push({ id: photo.id, bytes, sourceSpec });
          offered += 1;
        } catch (error) {
          stats.failed += 1;
          if (!lastError) lastError = error && error.message ? error.message : String(error);
        }
      }
      await flush(true);
      if (offered) announce(total, 'ready');
      // 一个都没筛出来也要让出一次：整趟可能扫几百万行，不能让出点只由「有没有活」决定。
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    flush,
    drain,
    stats() {
      return {
        ...stats,
        engine: engine || null,
        fallback: fallback || '',
        error: encoderError || lastError || '',
        /** 已打过标的张数（本趟之后的库内实况）。 */
        indexed: taggedCount(),
      };
    },
    async finish() {
      try {
        await flush(true);
        if (writer) writer.setMeta('updated_at', String(Date.now()));
      } catch (_) {
        /* 收尾失败不值得把整趟任务打成失败：索引已经落库的部分都是有效数据 */
      }
      if (encoder) {
        await encoder.dispose();
        encoder = null;
      }
      if (probe) probe.close();
      if (writer) writer.close();
    },
  };
}

/**
 * 本 worker 的全部工作：读 GPU 探测结论 → 开自己的只读 photos 连接 → 全库扫一遍 tag。
 *
 * 🔴 **不许发 `phase` 帧**：`phase` 是父进程 `state` 的**共享**字段，两个 worker 并行时
 * CLIP 路在写它，这里再写就是互相踩（哪边后到哪边赢，且不报错）。本 worker 的进度
 * 只走 `tag*`（见 `announce` 上方那段）。
 */
async function execute() {
  fs.mkdirSync(root, { recursive: true });
  /**
   * 🔴 读 `gpu.json` 而不是在这里重新推断「有没有显卡」：能力探测的唯一真相源是
   * `main/gpu-probe.js`，两份推断必然漂。取不到结论（还没探完 / 从没探过）一律按 CPU 走，
   * 而 `joytag-model` 自己还有一道回落（回落必 warn）。
   */
  let tagVerdict = null;
  try {
    tagVerdict = gpuProbe.readVerdict(root);
  } catch (_) {
    // 取不到结论（还没探完 / 从没探过）就保持 null ⇒ 下面按 CPU 走。
  }
  /**
   * 自己开一条**只读**连接到 photos：不与 CLIP worker 共享任何句柄（跨线程也共享不了），
   * 也不参与写锁竞争 —— 本 worker 只写 `tag-index.sqlite`、只读 `photos`；CLIP worker
   * 只写 `semantic-index.sqlite`。两个写目标**分属两个文件**，WAL 下互不阻塞。
   */
  const tagSource = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  tagSource.pragma('busy_timeout = 5000');
  const tagTrack = createTagIndexTrack({
    source: tagSource,
    cacheDir,
    provider: tagVerdict && tagVerdict.available ? 'dml' : 'cpu',
    check,
    progress,
  });
  if (tagVerdict && !tagVerdict.available && tagVerdict.reason)
    logger.log(
      '[ai] JoyTag 走 CPU（GPU 探测结论：' +
        tagVerdict.reason +
        (tagVerdict.stale ? '，旧结论' : '') +
        '）',
    );
  try {
    await tagTrack.drain();
    const tagStats = tagTrack.stats();
    logger.task('semantic-index', 'tags', 'tag 倒排', {
      done: tagStats.done,
      failed: tagStats.failed,
      pairs: tagStats.pairs,
      engine: tagStats.engine || '(none)',
    });
    return { tags: tagStats };
  } finally {
    if (tagTrack)
      try {
        await tagTrack.finish();
      } catch (_) {
        /* 收尾失败只是少一次 updated_at，索引已落库的部分都是有效数据 */
      }
    tagSource.close();
  }
}

parentPort.on('message', async (message) => {
  if (message.cancel) {
    cancelled = true;
    return;
  }
  // 主任务正在跑：其余消息一律不处理，等它跑完（与 semantic-worker.js 同一纪律）。
  if (busy) return;
  busy = true;
  cancelled = false;
  try {
    const result = await execute();
    parentPort.postMessage({ done: true, result });
  } catch (error) {
    parentPort.postMessage({ done: true, error: cancelled ? 'AI_CANCELLED' : error.message });
  } finally {
    busy = false;
  }
});
