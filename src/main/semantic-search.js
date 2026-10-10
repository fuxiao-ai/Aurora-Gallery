'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('./logger');
// 任务进度百分比的唯一来源（边界规则见 `docs/contracts/background-tasks.md` §1.1）。
const { computePct } = require('./progress-pct');
// 任务预计剩余时间的唯一来源（口径见同契约 §7）。这里用的是**由速率反推**那一支：
// 这两个任务的 `startedAt` 在 worker 里（主进程够不着），速率由 worker 随进度自报。
const { estimateEtaSecondsFromRate } = require('./eta');
/**
 * 「模型是否已就绪」的**唯一判据**（`ready.json` 的 `model` 是否等于当前这一代）。
 * ⚠️ 与 worker 用的是**同一个函数**（`semantic-worker.js` 也 require 它）—— 两处各写一份
 *    `JSON.parse(readFileSync(...)).model === MODEL_KEY` 就是两份判据，迟早漂。
 * ⚠️ `bundled-models` 顶层只依赖 `fs` / `path` / `crypto`（守护钉住这条）：主进程 require 它是安全的。
 */
const { isSearchReady } = require('../ai/bundled-models');
/** ⚠️ `embedding.js` 只在**函数内部** require `onnxruntime-node`（见该文件 `loadEncoder`），
 *  所以这里取常量不会把 ORT 拖进主进程（`gpu-probe-regression` 有「主进程不许 require ORT」那条）。 */
const { MODEL_KEY } = require('../ai/embedding');

/**
 * 双 worker `index` 的**结算规则**（纯函数，回归直接单测）。
 *
 * @param {object|null} clip CLIP 路的收场信封 `{ done: true, result }` 或 `{ done: true, error }`；
 *   `null`/`undefined` = worker 没发 done 信封就没了（崩溃 / 被 terminate）。
 * @param {object|null} tag  JoyTag 路的收场信封，同上。
 * @returns {{error?: string, result?: object}}
 *
 * 规则（三条都不许改，改了必有一条守护红）：
 *   ① **取消优先于一切** —— 但必须**两边都是取消**才算取消：用户按取消后，某一边
 *      恰好撞上自己的错误时，报的应该是那个错误而不是「已取消」（否则真故障被吞）。
 *   ② **非取消的错误优先于取消** —— 一边真崩了、另一边因此被取消，任务必须报失败。
 *   ③ **结果以 CLIP 路为主体、`tags` 只从 tag 路取** —— 两路的 result 字段不许互相
 *      覆盖（tag 路的 result 里没有 done/indexed 等，若有同名键也是 bug，不能让它进来）。
 */
function mergeIndexOutcomes(clip, tag) {
  // 没发 done 信封就没了 = 崩溃 / 被 OOM 杀掉，与「报了错误」同罪（不许静默少一半）。
  const clipError = clip ? clip.error : 'AI_WORKER_EXIT';
  const tagError = tag ? tag.error : 'AI_WORKER_EXIT';
  const bothCancelled = clipError === 'AI_CANCELLED' && tagError === 'AI_CANCELLED';
  // ② 非取消的真错误优先于取消（两边都真崩时取 CLIP 路 —— 它是主路）。
  const realError =
    clipError && clipError !== 'AI_CANCELLED'
      ? clipError
      : tagError && tagError !== 'AI_CANCELLED'
        ? tagError
        : null;
  if (realError) return { error: realError };
  // ① 双取消（或取消传播中一边先收场）= 用户主动取消。
  if (bothCancelled || clipError === 'AI_CANCELLED' || tagError === 'AI_CANCELLED')
    return { error: 'AI_CANCELLED' };
  // ③ 双成：结果以 CLIP 路为主体、`tags` 只从 tag 路取。
  const result = { ...(clip.result || {}) };
  if (tag && tag.result && tag.result.tags !== undefined) result.tags = tag.result.tags;
  return { result };
}

/**
 * 只读请求（`search` / `suggest`）**能托给已有 worker 代跑**的操作集合。
 *
 * 判据与 worker 侧逐字对齐：`semantic-worker.js#execute` 里只有这三条路会走到
 * `activeEncoder = encoder; activeStore = store; activeBaseline = …`
 * （`status` / `tag` 提前 `return`，`install` 在验完两种编码器后也 `return` 了）
 * ⇒ 只有它们手里的那个 worker 才真的服务得了一次只读请求。
 */
const RELAY_CAPABLE_OPERATIONS = new Set(['index', 'search', 'suggest']);

/**
 * 「对端还没就位」时的退避重试预算（一次只读请求最多等这么久）。
 *
 * 用量级定：索引起手要 `loadEncoder`（注释里实测 ≈2.1 s，冷启更久）后才会设
 * `activeEncoder`，所以 8 × 500 ms = 4 s 足够覆盖它；再长就是真出事了，不该让用户干等。
 */
const RELAY_READY_ATTEMPTS = 8;
const RELAY_READY_DELAY_MS = 500;

/**
 * 「已经有 worker 占着时，一次只读请求（search / suggest）该怎么走」—— 纯函数，回归直接单测。
 *
 * 🔴 历史坑（2026-10-09 用户报「语义搜索时提示后台任务正在运行，请稍后再试。不应该影响搜图」）：
 * 从前只有 `index` 能走 relay，其余一律 `AI_BUSY`。于是**只读的邻居**和**根本不含编码器的
 * 短任务**都会把搜图拒掉：
 *   · `suggest`：进搜图页就自动取预选词（载模型 ≈2.1 s + 开索引 ≈0.7 s + 打分 ≈1 s，
 *     冷启还要现算 308 个词的词表向量 ≈15 s）——这本来就是「用户正在用搜图」的那几秒；
 *   · `tag`：启动后 3 秒自动补 tag 倒排（`main.js` 的启动任务，1.8 s 纯算术）——
 *     用户在后台任务面板里**看得见**它，于是「后台任务正在运行」这句话看起来完全成立；
 *   · `status`：会话第一次查状态要起一个 worker（约 1 s）。
 * 三者都不该让搜图失败：前两者是只读，后者连编码器都没载过。
 *
 * @param {string} occupying 当前 worker 正在跑的操作（`state.operation`）
 * @param {boolean} workerExited 那个 worker 是否**已经退出**（退出了就只能自起 worker）
 * @returns {'relay' | 'spawn' | 'busy'}
 *   `relay` = 托给它（省一份模型，也是内存红线要的那条路）；
 *   `spawn` = 自己起一个只读 worker（只载文本编码器，约 900 MB）；
 *   `busy`  = 真的搜不了。
 */
function readRoute(occupying, workerExited) {
  // 模型正在下载：文件还没齐，另起 worker 也只会报 AI_MODEL_MISSING，还会和下载器抢同一批
  // 文件（以及多占一份 ≈900 MB）。保持拒绝，等下载完再搜。
  if (occupying === 'install') return 'busy';
  if (workerExited !== true && RELAY_CAPABLE_OPERATIONS.has(occupying)) return 'relay';
  // `status` / `tag` / 已退出的 worker：手里没有可复用的编码器 —— 自己起一个只读的。
  // ⚠️ 这一支**不会**和第二份 SigLIP2 撞上：那些操作本来就没载视觉编码器，
  //    而恰恰会因为「手里有编码器」才值得 relay 的 `index` 已经在上面被拦走了。
  return 'spawn';
}

/** 退避等待（见 `RELAY_READY_ATTEMPTS`）。抽成一行是为了让「等一会儿再问」这件事只有一个实现。 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SemanticSearch {
  constructor(dbPath, aiPath, config = {}) {
    this.config = config;
    this.dbPath = dbPath;
    this.aiPath = aiPath;
    // 🔴 **建索引是双 worker**（2026-10-08 起）：`worker` = CLIP(cpu) 主路（仍是 relay
    // 搜图的服务对象），`tagWorker` = JoyTag(dml) 并行路（实测 1.41×，见
    // `docs/contracts/semantic-search.md`）。两路进度帧的键集**不相交**
    // （CLIP 写共享字段、tag 只写 `tag*`），所以 `Object.assign` 合并天然安全。
    this.worker = null;
    this.tagWorker = null;
    /**
     * 🔴 「`this.worker` 指向的那个 worker **已经退出**」—— 只读路由（`readRoute`）靠它。
     *
     * 为什么不能只看 `this.worker === null`：`index` 是**双 worker**，CLIP 路（`this.worker`）
     * 收场后 JoyTag 路还要继续跑（临界路径在它那边，大库上可能是几小时），而 `settle()` 要等
     * 两路都收场才清槽 ⇒ 这整段时间 `this.worker` 都指着一个**尸体**。往尸体上 `postMessage`
     * 既**不抛错**也**永远不回话**（实测），请求会一直挂到 120 s 超时 —— 用户看到的是
     * 「任务超时，请稍后重试」，而每次搜索都这样。
     */
    this.workerExited = false;
    this.state = { running: false, ready: false, indexed: 0, phase: 'idle' };
    this.replies = new Map(); // relay 票据 → 等待中的只读请求
    this.ticket = 0;
  }

  /**
   * 状态快照。桌面端 IPC（`ai-search-status` / `face-status`）与内嵌网页 API
   * （`/api/ai-search-status` / `/api/face-status`）**共用这一个返回值** ——
   * 所以任何「两边都该知道」的信息挂在这里就只挂一次，别在两个运行时各写一份。
   */
  status() {
    const out = { ...this.state };
    /**
     * GPU 能力探测结论（可选钩子，由 main.js 挂上）。
     *
     * 返回值可能是 `null` ——「还没探完 / 从没探过」与「探过、不可用」**必须可区分**：
     * 前者界面要显示「检测中/未知」，后者要显示「已回落 CPU」。把两者显示成同一句话，
     * 用户就分不清「这台机器没有 GPU」和「探测还没跑」。
     * 自己出错一律吞掉：能力探测是装饰信息，不该让「查状态」这个只读动作失败。
     */
    if (typeof this.gpuInfo === 'function') {
      try {
        out.gpu = this.gpuInfo();
      } catch (_) {
        out.gpu = null;
      }
    }
    /**
     * 🔴 **模型就绪状态必须在这里按磁盘实况派生，不能等某个任务跑过**（2026-10-08 修）。
     *
     * `this.state.ready` 是**缓存值**：起手 `false`，只在 worker 跑完时按白名单写回
     * （见 `spawn` 的 onDone 那段），而 `refresh()` 只在 `phase === 'idle'` 时才去跑一次
     * `status` 任务探明它 —— 于是有一条**不需要任何错误就能走通**的失效链：
     *
     *   ① 进程起来：`phase = 'idle'`、`ready = false`（起手值）；
     *   ② 第一个 AI 动作是「建立索引」⇒ `run('index')` 把 `phase` 定成 `'index'`；
     *   ③ 索引跑完 ⇒ `phase = 'complete'`。而 **`index` 的返回值里没有 `ready`**
     *      （只有 `install` / `status` 带，见 `semantic-worker.js`），所以它一直是 `false`；
     *   ④ 此后**再没有任何代码会去探它**（`phase` 已不是 `'idle'`），直到重启。
     *
     * 症状：模型文件明明齐全，界面却说「本地模型尚未就绪 / 请在桌面端完成下载」
     * （网页端 `web/js/ai-views.js#noticeFor`、桌面端 `renderer/ai-views.js` 搜图页空态，
     * 判据都是 `!ready`）。用户 2026-10-08 报的就是这个。
     *
     * 🔴 为什么放在这里是对的：`ready` 本质是**一个文件的属性**（`ready.json` 的 `model`
     * 字段），不是**某个任务的结果**。一次 `readFileSync` + 比一个字符串 —— 几十微秒，
     * 远低于「为它起一个 worker」（约 1 秒 + 开一次库），所以可以每次查状态都算。
     * 于是它不再依赖任何任务的时机，也不受 `AI_BUSY`（索引在跑时 `status` 会被拒）影响。
     *
     * ⚠️ 与 `state.ready` 的关系：两者**同源同判据**（都用 `isSearchReady`）⇒ 不会互相矛盾。
     *    `state.ready` 留着是因为 `install` 之后就它最近一次的结果，语义上不是错值。
     */
    out.ready = isSearchReady(this.aiPath, MODEL_KEY);
    /**
     * 🔴 **任务整体**进度百分比 —— 由主进程派生，渲染端不再自己除
     * （`docs/contracts/background-tasks.md` §1.1）。
     *
     * ⚠️ 与 `percent` **不是一回事**，别混：那个是**模型文件下载**的字节进度
     *    （只有 `phase === 'downloading'` 时才画在进度条上），分母是文件大小、不是任务工作量。
     *    两个字段同时存在是刻意的 —— 下载期间「整体进度」还没有意义（索引没开始）。
     */
    out.pct = computePct(out.done, out.total);
    /**
     * 🔴 **tag 倒排（第二路）自己的百分比** —— 与 `out.pct` 同源同规矩
     * （`progress-pct.js#computePct`，主进程派生、渲染端不自己除），只是换了分子分母。
     *
     * 为什么必须**另算一个**而不是复用 `out.pct`：`index` 这一趟里跑的是两件事
     * （CLIP 向量 / tag 倒排），分母差好几个数量级（待索引几十万 vs 待打标几千）。
     * 复用 = 用索引的分母算打标的百分比 —— 与 §10 那条「两套口径不许串」同一条红线，
     * 而这里是它在**派生层**的翻版（`Object.assign` 那处管的是上报层）。
     *
     * `tagTotal = 0`（还没估出分母 / 这一趟没跑 tag）时返回 0；渲染端另有 `tagTotal > 0`
     * 这道门，所以 0 不会被当成「0%」画出来。
     */
    out.tagPct = computePct(out.tagDone, out.tagTotal);
    /**
     * 🔴 **预计剩余时间** —— 与 `out.pct` / `out.tagPct` 同一处派生（主进程算、渲染端不自己除）。
     *
     * 为什么不是「让 worker 报」：worker 只该报**观测到的事实**（速率、已处理数），
     * 「还要多久」是拿这些事实做的**投影**，而投影要带上面板的口径（例如 `totalEstimated`）。
     * 放在这里还有一条硬理由 —— **桌面端 IPC 与内嵌网页 API 共用这一个返回值**
     * （`ai-search-status` 与 `/api/ai-search-status` 都走 `status()`）：
     * 算在 worker 里就得两边各转发一遍，算在这里两边自动都有。
     *
     * 🔴 **为什么这次才加**（2026-10-08 用户报「不显示预计完成时间」）：从前这两个任务
     *    **没有分母**（连待办总数是多少都不知道）⇒ 契约 §7 规定它们只报 `ratePerMinute`。
     *    后来加了**抽样估计分母**（`totalEstimated: true`，`estimatePendingCount()`），
     *    分母有了、ETA 就能算了，**但面板那两行元素一直没补** ⇒ 9 个任务里只有这两节
     *    没有「预计剩余」行。所以这是**欠账**，不是刻意的取舍。
     *    ⚠️ 分母是**估值** ⇒ 界面必须带「约」：`etaPrefix` 词条本身写的就是「预计剩余约 …」，
     *       且主行那格已经在用「约 N」表达同一个性质（`totalEstimated`），两处口径一致。
     *
     * `null` / `0` 的区别（渲染端一律画空行）：`null` = 还估不出来（没分母 / 没速率 /
     * 样本太少），`0` = 剩余的确实为 0。判据与边界全在 `main/eta.js`。
     */
    out.etaSeconds = estimateEtaSecondsFromRate(
      out.done,
      out.failed,
      out.total,
      out.ratePerMinute,
    );
    return out;
  }
  /**
   * 重活（下载模型 / 建索引）的准入闸门。`canRun` 返回 `false` 等价于 `AI_BUSY`，
   * 也可以返回一个错误码字符串来说明「到底是谁在占着」——界面据此给出准确提示
   * （比如数据库维护期间说「数据库维护进行中」而不是「AI 任务正在运行」）。
   * 返回 `true` / 未安装闸门都视为放行，此时返回空串。
   */
  gateDenialCode() {
    if (typeof this.canRun !== 'function') return '';
    const gate = this.canRun();
    if (gate === true || gate === undefined) return '';
    return typeof gate === 'string' ? gate : 'AI_BUSY';
  }
  /**
   * 查状态前先跑一遍「准备钩子」（可选，由调用方挂 `beforeRefresh`）。
   *
   * 目前唯一的用途是**播种随包内置模型**：安装包里的 `resources/models` 有现成的人脸与搜图
   * 模型，把它复制进用户目录之后状态才会变成「已就绪」。挂在 refresh 上而不是启动时，
   * 是因为两个运行时的入口都从这里进来 —— 桌面端是 `ai-search-status` / `face-action`，
   * 网页端是 `/api/ai-search-status` / `/api/face-status`，它们共用这两个服务实例，
   * 于是「谁先打开 AI 视图谁触发播种」，且只触发一次（钩子自己 memo）。
   *
   * 钩子失败一律吞掉：播种只是省一次下载，不该让「查状态」这个只读动作失败。
   */
  async refresh() {
    if (typeof this.beforeRefresh === 'function') {
      try {
        await this.beforeRefresh();
      } catch (error) {
        logger.warn('[ai] 状态查询前的准备步骤失败: ' + (error && error.message ? error.message : error));
      }
    }
    if (this.state.phase === 'idle') await this.run('status');
    return this.status();
  }

  run(operation, query, options) {
    if (
      !(this.config.operations || ['status', 'install', 'index', 'search', 'suggest', 'tag']).includes(
        operation,
      )
    )
      return Promise.reject(new Error('AI_BAD_OPERATION'));
    // 只读查询（concurrentReads）可以在主任务占用 worker 时并发执行，这样
    // 「搜图」在索引进行中就能拿已落库的向量出结果、「人物」页也能实时显示已识别结果。
    // 并发分支不写任务状态、不顶替主 worker，其余操作仍然串行。
    const concurrent = (this.config.concurrentReads || []).includes(operation);
    const relayed = (this.config.relayReads || []).includes(operation);
    const primary = !this.worker;
    if (!primary && !concurrent) return Promise.reject(new Error('AI_BUSY'));
    // canRun 只拦重活（下载模型 / 建索引）：两个服务同时跑会各占一套模型、抢着读 photos.db。
    // 它**不拦只读搜索**——「另一个索引在跑就拒绝搜图」的那道闸门（canSearch）已经撤除：
    // 那份担忧的根子是内存，而真正会把进程搞死的是**同一份 SigLIP2 被并发载入两遍**
    // （实测：死前可用内存只剩 5 MB）。那条路被两件事合力堵死：
    //   ① 只要那个 worker **手里握着编码器**（index / search / suggest），只读请求一律走 relay，
    //      不会并发出第二份 SigLIP2；
    //   ② 只有对端根本不含编码器（`status` / `tag`，或 worker 已退出）时才自起 worker，
    //      而那条路只载**文本**编码器（textOnly），实测常驻约 900 MB 而非约 1170 MB。
    // 因此另一个索引在跑时，搜图照常可用。
    if (operation === 'install' || operation === 'index') {
      // 🔴 双 worker 的第二道门：`primary` 只看 CLIP worker，而 JoyTag worker 在 CLIP
      // 路收场后可能还要独跑很久（临界路径在它那边）。漏了这道门，「CLIP 已完、tag 未完」
      // 的窗口里再点一次建索引 = 两套 CLIP + 一套 JoyTag 同进程并存，内存当场爆。
      if (this.tagWorker) return Promise.reject(new Error('AI_BUSY'));
      const denial = this.gateDenialCode();
      if (denial) return Promise.reject(new Error(denial));
    }
    if (
      operation === 'search' &&
      (typeof query !== 'string' || !query.trim() || query.length > 500)
    )
      return Promise.reject(new Error('AI_QUERY_INVALID'));
    const preserveProgress = (this.config.preserveProgress || []).includes(operation);
    const previousPhase = this.state.phase;
    if (primary)
      this.state = {
        ...this.state,
        running: true,
        phase: operation,
        operation,
        ...(preserveProgress
          ? {}
          : {
              error: '',
              file: '',
              currentFile: '',
              ratePerMinute: 0,
              percent: 0,
              done: 0,
              failed: 0,
              skipped: 0,
              /**
               * 🔴 进度条分母（候选集规模）。**必须在这里归零**：上面那块是**逐字段列的**、
               * 不是「清空后重建」，漏掉它 ⇒ 上一轮留下的 `total` 会跨任务活下来
               * （`index` 播下一个百万级分母、接着跑 `tag` / `search` 时界面照用那个假分母，
               * 而且**不报错**，只是百分比永远接近 0%）。
               * `totalEstimated` 同理：它标「这个分母是抽样估的，界面要写『约』」，
               * 残留 = 一个精确值被标成估算值（或反过来）。
               * 两个都由 worker 在任务起手重新上报；`total > 0` 是界面画百分比的门。
               */
              total: 0,
              totalEstimated: false,
              /**
               * 分母的**来路**（`docs/contracts/background-tasks.md` §3.1.4），三态与缩略图补全
               * 同一套：`'counting'` 还在估 / `'ready'` 已就绪 / `'failed'` 估失败；
               * `null` = 该阶段的分母**不经估算**（`install` 走下载器 `percent`、
               * `tag` 是精确 `COUNT`）—— 与「未运行」同值，渲染端两个分支都不会命中。
               *
               * 🔴 **必须与上面两个一起重置**：它是估算三态的第三角。漏了它，上一轮 `index`
               *    留下的 `'failed'` 会挂到下一轮 `tag` 上 —— 界面于是对着一个刚刚精确数出来的
               *    `COUNT` 说「总数估计失败」。同 §2「新字段必须同时进三个地方」。
               */
              countPhase: null,
              /**
               * tag 倒排（JoyTag 第二路）在**同一趟 `index` 里顺手建**的那部分进度。
               *
               * 🔴 刻意**另起一套字段**，不共用上面的 `done` / `total` / `countPhase`：
               * 两件事的分母差好几个数量级（待索引几十万 vs 待打标几千），
               * 而上面那套是 `Object.assign` 一把合并的**共享**字段 —— 混着写就是
               * 「打标的分母盖掉索引的分母」，分子分母百分比一起变成另一件事的数字，
               * 且不报错。tag 的数字一律走 `tag*` 前缀。
               *
               * 上报方是 `semantic-tag-worker.js`（并行 tag 路）里的 `announce()`
               * （`tagStage` / `tagDone` / `tagFailed` / `tagTotal` / `tagTotalEstimated` /
               * `tagCountPhase`，键名一一对应，改一边必须改另一边）。
               *
               * ⚠️ 消费者是渲染端 AI 两节那段（`scan-flow.js#renderBackgroundTaskPanel` 里
               * `document.getElementById(aiTask.prefix + 'TagCount')` ⇒ `#taskSemanticTagCount`），
               * 画成与主行**并列**的第二条计数行；人脸节刻意没有这一格。
               * 百分比不在这些字段里 —— 它由 `status()` 用 `computePct` 派生（见那边的 `tagPct`）。
               * 这里**必须逐轮重置**，免得上一轮的读数在新任务起手后继续挂着
               * （与 `total` / `countPhase` 那条坑同源）。
               */
              tagStage: null,
              tagDone: 0,
              tagFailed: 0,
              tagTotal: 0,
              tagTotalEstimated: false,
              tagCountPhase: null,
              // 人脸索引的收尾「全局聚类」可能被 `AUTO_REGROUP_LIMIT` **跳过**（大库上必然
              // 发生），此时人物划分只是索引期间的增量近似。这个标志是「跳过」唯一的对外通道，
              // 界面靠它解释「为什么分组不是最终结果」。`null` = 未知（本轮还没跑完/没跑过），
              // 与 `false`（跑了、跳过了）区分开 —— 否则上一轮的 `false` 会在新任务开始后
              // 继续挂在状态里，界面一直显示一句过时的提示。
              clustered: null,
            }),
      };
    // 已经有别的 worker 在跑：**优先**把只读请求托给它自己执行 —— 它已经载好编码器与库连接，
    // 另起一个 worker 会再载一份 **SigLIP2**，同进程里两份并存会因内存耗尽把进程搞死（实测）。
    //
    // 🔴 「托不了」不等于「搜不了」：路由表在纯函数 `readRoute` 里（回归直接单测它）。
    //    对端是 `status` / `tag`（压根没载编码器）或已经退出时，正确动作是**自己起一个只读
    //    worker**，而不是把用户挡回去 —— 从前这里只有 `relay` 一条路，其余全 `AI_BUSY`，
    //    于是「进搜图页自动取预选词」「启动后 3 秒自动补 tag」这些**只读/短任务**都会让
    //    搜图失败（2026-10-09 用户报的就是这个）。
    if (!primary && relayed) {
      const route = this.readRouting();
      if (route === 'busy') return Promise.reject(new Error('AI_BUSY'));
      if (route === 'relay')
        return this.relayWithRetry(operation, query, options).catch((error) => {
          // 重试预算用尽时对端可能已经**换了身份**（CLIP 路收场 / 索引整趟结束）：
          // 这时正确动作仍是自己起 worker，而不是把 AI_BUSY 抛给用户。
          if (String(error && error.message) !== 'AI_BUSY' || this.readRouting() !== 'spawn')
            throw error;
          return this.spawn(
            operation,
            query,
            { primary, preserveProgress, previousPhase },
            options,
          );
        });
    }
    return this.spawn(operation, query, { primary, preserveProgress, previousPhase }, options);
  }

  /**
   * 主 worker 的消息分发：relay 回话单独走一路，其余仍是进度 / 完成信号。
   * 抽成方法是为了能直接断言「回话如何落到等待中的请求上」，不必起真 worker。
   */
  handleWorkerMessage(message, { primary, worker, onDone }) {
    if (message.relay != null) {
      const pending = this.replies.get(message.relay);
      if (!pending) return; // 超时后迟到的回话：丢掉即可
      this.replies.delete(message.relay);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.progress && primary) Object.assign(this.state, message.progress);
    // ⚠️ `message.done`（**信封**上的布尔：worker 干完了）与结果里的 `result.done`
    //    （**数目**：本轮已处理的行数，见下方白名单）同名两义，别混。前者的兄弟是
    //    `{ done:true, error }`（worker 崩了也发 done）；后者只出现在 `result` 里。
    if (message.done) {
      onDone(message);
      void worker.terminate();
    }
  }

  /**
   * 「现在这一次只读请求该怎么走」—— 判据全在纯函数 `readRoute` 里，这里只负责从实例取参数。
   */
  readRouting() {
    return readRoute(this.state.operation, this.workerExited);
  }

  /**
   * 把只读请求投给正在跑的 worker —— **带退避重试**（`RELAY_READY_ATTEMPTS` × `RELAY_READY_DELAY_MS`）。
   *
   * 为什么要重试：索引刚起手时它的编码器还在载（`loadEncoder` 实测 ≈2.1 s，冷启更久），
   * 那几秒里 worker 对 relay 回的是 `AI_BUSY`。可那不是「忙，别搜」，而是「等我一秒」——
   * 直接抛给用户，界面就是一句「后台任务正在运行，请稍后再试」，而明明再过一两秒就能搜。
   * 所以这几秒在这一层等：等的是**对端就位**，不是「对端空下来」。
   *
   * 🔴 每轮重试都要**重看一次路由**：对端可能在等待期间收场（CLIP 路退出 / 整趟索引结束），
   *   那时路由就不再是 `relay`。继续投等于往尸体上 `postMessage`（静默吞掉 ⇒ 挂满超时），
   *   所以这里**立刻停下**并把 `AI_BUSY` 交回调用方，由它落到 `spawn` 那条路。
   *
   * ⚠️ 非 `AI_BUSY` 的错误（`AI_CANCELLED` / `AI_TIMEOUT` / 真错误）**不重试**：原样冒出去。
   *
   * @returns {Promise<object>} 搜索结果
   */
  async relayWithRetry(operation, query, options) {
    let lastBusy = null;
    for (let attempt = 0; attempt <= RELAY_READY_ATTEMPTS; attempt += 1) {
      if (this.readRouting() !== 'relay') break;
      if (attempt > 0) await delay(RELAY_READY_DELAY_MS);
      try {
        return await this.relay(operation, query, options);
      } catch (error) {
        if (String(error && error.message) !== 'AI_BUSY') throw error;
        lastBusy = error;
      }
    }
    throw lastBusy || new Error('AI_BUSY');
  }

  /**
   * 把只读请求投递给正在跑主任务的 worker，等它用 { relay: ticket } 回话。
   */
  relay(operation, query, options) {
    const worker = this.worker;
    // 只有「手里握着编码器 + 库连接」的那种 worker 才服务得了一次只读请求（判据 = `readRoute`
    // 用的同一张表）；已经退出的 worker 更不能投 —— 它会静默吞掉消息（见 `workerExited`）。
    if (!worker || this.workerExited || !RELAY_CAPABLE_OPERATIONS.has(this.state.operation))
      return Promise.reject(new Error('AI_BUSY'));
    const ticket = ++this.ticket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(ticket);
        reject(new Error('AI_TIMEOUT'));
      }, 120000);
      timer.unref();
      this.replies.set(ticket, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({
        operation,
        relay: ticket,
        query: typeof query === 'string' ? query.trim() : '',
        options: options || null,
      });
    });
  }
  /**
   * 起 worker 跑一个操作。
   *
   * 🔴 **`index` 是双 worker 并行**（其余操作单 worker，行为与从前逐字一致）：
   *   · CLIP 路 = `config.workerFile || 'semantic-worker.js'`（cpu）——进度走共享字段，
   *     relay 搜图仍由它服务（文本编码器在它手里）；
   *   · JoyTag 路 = `config.tagWorkerFile || 'semantic-tag-worker.js'`（dml）——进度只走
   *     `tag*`，结果里只取 `{ tags }`。
   * 两路的**结算必须等两边都收场**（临界路径在 JoyTag 那边，CLIP 先完时任务还没完）；
   * 一边失败（非取消）就取消另一边 —— 已落库的部分都是有效数据，但任务必须如实报失败，
   * 不能「悄悄少一半」。合并规则抽在 `mergeIndexOutcomes`（纯函数，回归直接单测它）。
   */
  spawn(operation, query, { primary, preserveProgress, previousPhase }, options) {
    return new Promise((resolve, reject) => {
      const pair = primary && operation === 'index';
      let clipWorker;
      let tagWorker;
      try {
        clipWorker = new Worker(
          path.join(__dirname, '../workers', this.config.workerFile || 'semantic-worker.js'),
          {
            workerData: { dbPath: this.dbPath, aiPath: this.aiPath },
          },
        );
        if (pair)
          tagWorker = new Worker(
            path.join(__dirname, '../workers', this.config.tagWorkerFile || 'semantic-tag-worker.js'),
            { workerData: { dbPath: this.dbPath, aiPath: this.aiPath } },
          );
      } catch (error) {
        if (primary) {
          this.state.running = false;
          this.state.phase = 'failed';
          this.state.error = error.message;
        }
        reject(error);
        return;
      }
      /**
       * 🔴 **只有主任务能占 `this.worker` 这个槽**（并发只读不许占）。
       *
       * 这个槽的语义是「谁在顶着任务状态」：`run()` 拿 `!this.worker` 当 `primary`，
       * `start()` 拿它判「能不能开始建索引」，relay 拿它找「谁手里有编码器」。
       * 并发只读（`primary === false`）的 worker 是一次性的、跑完就 `terminate()`，
       * 而它的收场走的是「不写状态、不碰槽」那一条 —— 若在这里把它写进槽，槽就永远
       * 指着一具尸体，后果是**之后再也起不来索引**（`start()`/`run('index')` 一律
       * `AI_BUSY`，直到重启）。所以这一行必须带 `primary` 门。
       */
      if (primary) {
        this.worker = clipWorker;
        this.workerExited = false;
      }
      if (pair) this.tagWorker = tagWorker;
      let outcome;
      let tagOutcome;
      let settled = false;
      // Large local libraries can take days. Indexing has explicit cancellation,
      // so a fixed wall-clock deadline would abort healthy long-running work.
      const timeout =
        operation === 'index'
          ? null
          : setTimeout(
              () => {
                outcome = { error: 'AI_TIMEOUT' };
                void clipWorker.terminate();
              },
              operation === 'install' ? 30 * 60 * 1000 : 120000,
            );
      if (timeout) timeout.unref();
      /**
       * 一边「非取消」地失败时取消另一边：不取消的话，失败方已经 settle 不了
       * （还要等另一边跑完几天才结算），而界面上任务挂着、主行进度冻结、错误不显示。
       * `AI_CANCELLED` 是用户主动取消的语义，让它从结算规则里走（见 `mergeIndexOutcomes`）。
       */
      const stopSibling = (byTag) => {
        const other = byTag ? clipWorker : tagWorker;
        if (other) other.postMessage({ cancel: true });
      };
      clipWorker.on('message', (message) =>
        this.handleWorkerMessage(message, {
          // ⚠️ 用调用方的 `primary`，不是恒真：并发只读（search/suggest）也走这里起 worker，
          //    它们的进度帧**不许**合并进共享 state（搜图帧会把正在跑的索引 phase 踩掉）。
          primary,
          worker: clipWorker,
          onDone: (done) => {
            outcome = done;
          },
        }),
      );
      clipWorker.on('error', (error) => {
        outcome = { error: error.message };
        if (pair) stopSibling(false);
      });
      clipWorker.on('exit', () => {
        clearTimeout(timeout);
        // worker 走了：还在等回话的 relay 请求必须立刻失败，否则调用方会一直挂到超时。
        // 用 AI_BUSY 而不是 AI_WORKER_EXIT：这几乎总是「索引刚好跑完」，重搜一次即可，
        // 界面据此给出一句能读懂的提示，而不是一个裸错误码。
        for (const pending of this.replies.values()) pending.reject(new Error('AI_BUSY'));
        this.replies.clear();
        // 🔴 而且**从此不能再往它身上投 relay**（`postMessage` 到已退出的 worker 不报错、
        //    也不回话 ⇒ 挂满 120 s 超时）。双 worker 下这段窗口特别长：CLIP 路收场后
        //    JoyTag 路还要跑几小时，而槽要等两路都收场才清（见 `workerExited`）。
        if (this.worker === clipWorker) this.workerExited = true;
        settle();
      });
      if (pair) {
        // tag worker 的进度帧同样要合并（键集不相交，见 `handleWorkerMessage`）；
        // 它没有 relay 回话、没有下载超时 —— 那两样都只属于 CLIP 路。
        tagWorker.on('message', (message) =>
          this.handleWorkerMessage(message, {
            primary: true,
            worker: tagWorker,
            onDone: (done) => {
              tagOutcome = done;
            },
          }),
        );
        tagWorker.on('error', (error) => {
          tagOutcome = { error: error.message };
          stopSibling(true);
        });
        tagWorker.on('exit', () => settle());
      }
      const settle = () => {
        if (settled) return;
        // 两路都必须收场才结算（单 worker 模式只看 CLIP 那一路）。
        if (pair && (!outcome || !tagOutcome)) return;
        settled = true;
        const merged = pair
          ? mergeIndexOutcomes(outcome, tagOutcome)
          : { error: outcome ? outcome.error : 'AI_WORKER_EXIT', result: outcome && outcome.result };
        if (primary) {
          this.worker = null;
          if (pair) this.tagWorker = null;
          this.state.running = false;
          if (merged.error) {
            this.state.phase = merged.error === 'AI_CANCELLED' ? 'cancelled' : 'failed';
            this.state.error = merged.error;
            if (merged.error !== 'AI_CANCELLED')
              logger.warn((this.config.label || 'Semantic search') + ' failed:', merged.error);
            reject(new Error(merged.error));
            return;
          }
          const result = merged.result || {};
          // ⚠️ 这份白名单决定了 worker 的返回值里**哪些字段能进入 `status()`**。漏一个
          //    就等于「后端做了、界面永远看不到」——`clustered` 曾经就是这样被丢掉的：
          //    `face-worker` 在超过 `AUTO_REGROUP_LIMIT` 时明确返回 `clustered:false`，
          //    但白名单里没有它，于是「本次索引没做全局聚类」这件事对界面完全不可见。
          //    新增可上报字段时，**先确认它在这里**。
          for (const key of [
            'ready',
            'indexed',
            'done', // ⚠️ 数目（本轮已处理的行数），不是「完成了」的布尔
            'failed',
            'skipped',
            'faces',
            'people',
            'clustered',
          ])
            if (result[key] !== undefined) this.state[key] = result[key];
          this.state.phase = preserveProgress ? previousPhase : 'complete';
          resolve(result);
        } else {
          // 并发只读：只回结果，绝不触碰 this.state / this.worker / this.tagWorker。
          if (merged.error) reject(new Error(merged.error));
          else resolve(merged.result);
        }
      };
      clipWorker.postMessage({
        operation,
        query: this.config.objectPayload
          ? query || {}
          : typeof query === 'string'
            ? query.trim()
            : '',
        options: options || null,
      });
      if (pair)
        tagWorker.postMessage({ operation, query: '', options: options || null });
    });
  }

  start(operation) {
    if (!['install', 'index'].includes(operation)) throw new Error('AI_BAD_OPERATION');
    // 🔴 双 worker：两路任一还在跑都算占着（`run()` 里的闸门只挡重活，这里是硬断言）。
    if (this.worker || this.tagWorker) throw new Error('AI_BUSY');
    const denial = this.gateDenialCode();
    if (denial) throw new Error(denial);
    void this.run(operation).catch(() => {}); // Failure is exposed in status and logged by run.
    return this.status();
  }

  cancel() {
    if (this.worker || this.tagWorker) {
      this.state.phase = 'stopping';
      // 🔴 两路都要停：只停 CLIP 路的话，JoyTag 那一路会继续跑完全库（几天），
      // 而 `state.phase` 已经是 'stopping' —— 任务看起来永远停不下来。
      if (this.worker) this.worker.postMessage({ cancel: true });
      if (this.tagWorker) this.tagWorker.postMessage({ cancel: true });
    }
    return this.status();
  }
  dispose() {
    if (this.worker) {
      this.worker.postMessage({ cancel: true });
      void this.worker.terminate();
    }
    if (this.tagWorker) {
      this.tagWorker.postMessage({ cancel: true });
      void this.tagWorker.terminate();
    }
  }
}
// `readRoute` / `RELAY_READY_ATTEMPTS` 导出是给回归用的：前者是只读路由的**唯一判据表**，
// 后者是退避预算 —— 测试要能钉住「多一次首投、之后有界重试」，自己抄一个数字就白钉了。
module.exports = { SemanticSearch, mergeIndexOutcomes, readRoute, RELAY_READY_ATTEMPTS };
