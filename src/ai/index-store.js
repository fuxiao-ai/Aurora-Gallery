'use strict';

const Database = require('better-sqlite3');
const { MODEL_KEY, DIMENSIONS, pack, score, dot } = require('./embedding');
const { serializeTags, parseTags } = require('./photo-tags');

/**
 * 匹配阈值的默认值，口径是**基线差**：`sim(查询, 图片) − sim(泛化文本, 图片)`。
 * 起因为什么不能用原始余弦，见 embedding.js 里 GENERIC_TEXT 的注释与 docs/local-ai-search.md。
 *
 * ## 这个数现在是「地板」，不是「全部门槛」（2026-10-07 起）
 *
 * 固定全局阈值的两难：定高了把「排序正确但分数低」的概念整条杀掉，定低了往屏幕上灌噪声
 * ——0.01→0.02 那一档的**边际精确率只有约 2.8%**（Δ命中/Δ返回 ≈ 20.8/741）。所以实际过滤
 * 改用**自适应阈值**：
 *
 *     effective = max(threshold, ADAPTIVE_ALPHA × top1)      // ADAPTIVE_ALPHA = 0.3
 *
 * 它只负责「别把地板设得比真命中还高」，收紧交给每个查询自己的 top1 ——
 * 同一个 α 在低分查询上几乎不生效，只在高分查询上收尺子。**取值保持 `0.01` 不变**
 * （曾经跟着 α 一起下调到 0.002，被实测推翻，理由见下）。
 *
 * ## 台架：α 与 Tmin 的二维表（`sweep-adaptive.js`，1500 张子集）
 *
 *   α     Tmin    P@set   R@set    F1      零返回   平均返回
 *   0     0.01    0.107   0.341   0.163    1/27     1136     ← 旧行为（α=0 就是纯固定阈值）
 *   0.3   0.01    0.116   0.256   **0.160**   1/27      646     ← 现在
 *   0.3   0.002   0.114   0.265   0.159    0/27      667     ← 一度取过这个，已撤回
 *
 * ## 🔴 为什么 Tmin 留在 0.01 而不是 0.002（2026-10-07 真库探针推翻）
 *
 * 当初选 0.002 的**唯一**理由是「零返回 1/27 → 0/27」。真库实测（`probe-adaptive-live.js`，
 * 7,374 张、32 个查询、Pass B 全量分数复算与产品实现**逐值交叉验证通过**）证明这条理由不成立：
 *
 *   ① 零返回 ⟺ `top1 < Tmin`（连最大值都不够线 ⇒ 一张都返回不了）。真库上 27 个概念的
 *      top1 **最小值 = 0.0120 > 0.01** ⇒ 地板 0.01 就已经一个都饿不死了，把地板降下去
 *      在这台库上换不到任何召回。台架那 1/27 是 **1,500 张子集**的产物：样本少 ⇒ 最大值低
 *      ⇒ 有概念 top1 < 0.01。**差异来自语料规模，不是实现不一致。**
 *      规模越大 top1 只会越高 ⇒ 全库（75 万行）比这件事上真库更安全，不是更危险。
 *   ② 地板的真正作用是**保护低分查询**（`α×top1 ≤ Tmin` 时由它兜底）。0.01 时 **13/27** 个
 *      概念吃这份保护；0.002 时是 **0/27** —— 地板等于消失，低分查询失去兜底：
 *      `JK制服` 61→222、`洗手间` 21→60、`绳艺` 216→356 张，平均返回 +3.0%。
 *   ③ 代价是可量的：**负对照开始漏进来**。「汽车」在 0.01 下 0 张、0.002 下 **5 张**；
 *      「咖啡」0 张 → **1 张**（达标 0 张的负对照 4/5 → 2/5）。这些正是 tag 路线要压的误报。
 *   ④ 台架上 `(0.3, 0.01)` 的 F1 **0.160 本来就高于** `(0.3, 0.002)` 的 0.159 ⇒ 两个语料
 *      都指向 0.01。
 *   ⇒ 结论：**M1 的收益全部来自 α，与地板无关**（见 ① 下面的数字）；降地板是净负收益。
 *
 * ⚠️ **M1 的收益口径**（真库同批扫出，27 个确有内容的概念）：α 把 **14/27** 个概念的生效阈值
 *    抬到 0.01 之上（高分查询收尺子），平均返回 **1196 → 646/701**（−41%~−46%），
 *    而**零返回 0 → 0 不变**。`丝袜` 3352→1233、`空姐` 4971→2249、`制服` 3486→1942
 *    —— 这才是「不准」被修好的地方，量级远大于地板那一项。
 *
 * ⚠️ 调这个数之前必须重跑 `sweep-adaptive.js`（二维表）**加** `probe-adaptive-live.js`
 *    （真库复算）。只跑台架会被小语料的零返回误导 —— 这正是这次撤回的教训。
 * ⚠️ 用户显式设的阈值**永远优先**（它进 `max()` 的第一项）：设 0.05 时 `α×top1` 通常还不到
 *    0.05，自适应等于不生效，用户的手动收紧仍然说话算数。
 * ⚠️ `photo-tags.js#TAG_THRESHOLD`（0.015）与这里**是同一把尺子但不是同一个数**，别跟着改。
 */
const DEFAULT_MATCH_THRESHOLD = 0.01;
/**
 * 自适应阈值的 α：`effective = max(threshold, ADAPTIVE_ALPHA × top1)`。
 * 口径推导与二维扫描见 `.workbuddy/bench/sweep-adaptive.js`、`docs/semantic-search-model-selection.md`。
 *
 * 取 0.3 是**拐点**选择，不是 F1 最优：Tmin=0.01 那一行上 α ∈ [0.2, 0.3] 的 F1 只差
 * 0.002（0.162 / 0.160，在噪声范围内），而平均返回 **1013 → 646（−36%）**。
 * 用户抱怨的是「一堆不相关的图」⇒ 拿 0.002 的 F1 换 36% 的噪声是划算的。
 * 再往上开始真亏：0.4 时 F1 0.154、0.5 时 0.140（收得太狠，`有命中` 也从 22/27 掉到 20/27）。
 */
const ADAPTIVE_ALPHA = 0.3;
/**
 * 单次返回的**内部**上限。它只约束内存，不参与「谁达标」：达标数另由 matched 给出。
 * 之所以必须有：阈值调到 0 时「一张图片」这种泛化查询能命中全库的一大半，百万库里
 * 那就是上百万个行对象同时驻留 —— 那是崩溃而不是功能。
 */
const MAX_RESULTS = 5000;
/**
 * 设置项允许的范围。下限 0 等于不过滤。**默认值只在这里定义**，
 * 主进程的设置默认值从本模块取，避免两处漂移。
 * ⚠️ 上限 **0.03 → 0.15**（2026-10-07，见 `docs/semantic-search-tag-plan.md` M1）：
 *    原来的 0.03 是**刻意留着**的，但它比真命中还低 —— 真命中能到 0.08（「丝袜」0.0796），
 *    也就是说用户根本收不到「只留最匹配的」那一段，等于在设置里摆了一个无效档位
 *    （0.03 时已严到 11/27 个概念零返回、平均只返回 111 张）。放开到 0.15 才有收尺子的空间。
 * ⚠️ **两处同改**：`src/web/js/semantic-search.js#MATCH_RANGE`（渲染层拿不到本模块，
 *    只能各写一份），`scripts/semantic-regression.js` 会解析两边逐值比对 —— 中间态会让套件红。
 */
const MATCH_THRESHOLD_RANGE = { min: 0, max: 0.15, default: DEFAULT_MATCH_THRESHOLD };
/** 基线补算攒够这么多条就落库。 */
const BASELINE_FLUSH = 20000;

/**
 * 待建索引候选集的谓词 —— **唯一源**（2026-10-08 抽出来）。
 *
 * 🔴 `batch()`（真取批）与 `estimatePendingCount()`（进度分母的抽样估计）**必须逐字同源**。
 *    分母与候选集不同源 ⇒ 百分比与真实工作量脱钩，而且**不会报错**：界面上只是那个百分比
 *    慢慢变得没有意义。本工程已经栽过一次同形的坑（缩略图补全那边靠
 *    `db-read-worker` 复用 `_sqlBackfillPendingExpr()` 本身来解决，这里用共享常量达到同一效果）。
 *
 * 判据 = 「**没有向量**，或向量的三样指纹与当前 `photos` 行**不一致**」
 * （图片被替换 / 改动过 ⇒ 之前的向量已经不对，必须重编码）。
 * 唯一的 `?` = `MODEL_KEY`：换模型 ⇒ 整库重编码。
 *
 * ⚠️ 别名 `p` / `e` 与 `semantic` 库名是调用方约定好的，两处调用都保持同样的 FROM/JOIN。
 */
const CANDIDATE_PRED =
  "(e.photo_id IS NULL OR e.model != ? OR e.file_path != p.file_path" +
  " OR e.file_size != p.file_size OR e.date_modified != COALESCE(p.date_modified, ''))";

class IndexStore {
  constructor(sourcePath, indexPath) {
    this.index = new Database(indexPath);
    this.index.pragma('journal_mode = WAL');
    this.index.pragma('busy_timeout = 3000');
    this.index.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      photo_id INTEGER PRIMARY KEY, model TEXT NOT NULL, file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL, date_modified TEXT NOT NULL, vector BLOB NOT NULL,
      generic_sim REAL, tags TEXT, tags_key TEXT
    )`);
    // 老索引没有后面几列：逐列补上（新增列落在末尾，与上面的建表顺序一致）。
    // 历史行留 NULL，检索时按需补算并写回 —— 不需要重建索引（百万库重建一次是数天）。
    try {
      this.index.exec('ALTER TABLE embeddings ADD COLUMN generic_sim REAL');
    } catch (_) {}
    /**
     * `tags` 是**词表下标数组**的 JSON（如 `[148,136]` = 丝袜 / 制服），不是字符串 ——
     * 下标与语言一一对应（见 `photo-tags.js`），所以换界面语言不需要重算标签。
     * `tags_key` 是词表指纹：换了词表（增删词）旧标签就作废，而 `batch()` 看不见词表变化，
     * 只能靠这个指纹判定「该重算」。
     */
    try {
      this.index.exec('ALTER TABLE embeddings ADD COLUMN tags TEXT');
    } catch (_) {}
    try {
      this.index.exec('ALTER TABLE embeddings ADD COLUMN tags_key TEXT');
    } catch (_) {}
    try {
      this.source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      this.source.pragma('busy_timeout = 3000');
      this.source.prepare('ATTACH DATABASE ? AS semantic').run(indexPath);
    } catch (error) {
      if (this.source) this.source.close();
      this.index.close();
      throw error;
    }
  }

  /**
   * 待建索引的候选批次：**主键倒序（最新入库优先）**。
   *
   * 🔴 方向是刻意倒序的（2026-10-05，与缩略图补全 / 查重指纹 / 失效清理同一条策略）：
   *    用户导入新图片之后立刻就想「搜得到」，而倒序让刚加入的那批先编码；
   *    若用户中途停掉索引（百万库上很常见），留在后面的只是**最老**那批，而不是他刚导入的。
   *    `beforeId` 是**排他上界**，调用方取「本批最后一行的 id」续接（倒序下那是**最小** id）。
   */
  batch(before) {
    return this.source
      .prepare(
        `SELECT p.id, p.file_path, p.file_name, p.file_type, p.file_size,
      COALESCE(p.date_modified, '') AS date_modified, p.thumbnail
      FROM photos p LEFT JOIN semantic.embeddings e ON e.photo_id = p.id
      WHERE p.id < ? AND ${CANDIDATE_PRED}
      ORDER BY p.id DESC LIMIT 16`,
      )
      .all(before, MODEL_KEY);
  }

  /**
   * 待建索引候选集规模的**抽样估计值** —— 进度条的分母（2026-10-08 加）。
   *
   * ## 为什么必须抽样，不能精确 COUNT
   *
   * 候选谓词的判断列（`model` / `file_path` / `file_size` / `date_modified`）在 `photos` 上
   * **一个可用的索引都没有**，而且是**跨库 JOIN**（`photos LEFT JOIN semantic.embeddings`）
   * ⇒ 精确 `COUNT(*)` 只能把整张 `photos` 全表扫一遍再与索引库 join。
   * 进度分母等不起这个（缩略图那边同形的 `COUNT` 在本机真库实测 **80~95 秒**），
   * 更不该反过来把**正在编码**的索引任务拖慢 —— 分母只是给用户看「大概还要多久」。
   *
   * ## 手法与 `database.js#estimatePendingCandidateCount()` 完全相同
   *
   * **id 轴等距抽样点查**：`step = maxId / samples`，逐个 `WHERE p.id = ?` 做命中判定，
   * 再按 `hits / sampled × total` 放大。约 2000 次主键定位 ⇒ 亚秒级。
   * 🔴 **id 空洞（该 id 上没有行）不计入样本**：算进去会系统性拉低命中率。
   *    `photos.id` 是自增但有删除留下的洞（本机真库 id ∈ [324737, 1981503] 而总行数 165 万）。
   *
   * ⚠️ 结果是**估计值**（±1% 量级）⇒ 调用方必须标成「约」；且它只在任务起手算一次，
   *    是**起始快照**：跑动中新入库的图片不在里面，分子可能反超分母 ⇒ 消费端要夹 `max`。
   * ⚠️ **失败一律由调用方兜底**：本方法会抛（比如索引库还没 ATTACH 好），
   *    而「估不出分母」只该让百分比消失，**不该让整个索引任务失败**。
   */
  estimatePendingCount(samples) {
    var want = Number(samples);
    if (!isFinite(want) || want <= 0) want = 2000;
    want = Math.max(50, Math.min(20000, Math.round(want)));
    var head = this.source.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM photos').get();
    var total = head && head.c != null ? Number(head.c) : 0;
    var maxId = head && head.m != null ? Number(head.m) : 0;
    if (total <= 0 || maxId <= 0) {
      return { total: total, sampled: 0, hits: 0, estimate: total };
    }
    var step = Math.max(1, Math.floor(maxId / want));
    // 谓词与 `batch()` 同一个常量 ⇒ 改一个字两处一起生效（这就是抽常量的全部理由）
    var hitStmt = this.source.prepare(
      `SELECT ${CANDIDATE_PRED} AS hit FROM photos p
       LEFT JOIN semantic.embeddings e ON e.photo_id = p.id WHERE p.id = ?`,
    );
    var sampled = 0;
    var hits = 0;
    for (var id = step; id <= maxId; id += step) {
      var row = hitStmt.get(MODEL_KEY, id);
      if (!row) continue; // id 空洞：不计入样本
      sampled++;
      if (Number(row.hit) === 1) hits++;
    }
    return {
      total: total,
      sampled: sampled,
      hits: hits,
      estimate: sampled > 0 ? Math.round((hits / sampled) * total) : total,
    };
  }

  /**
   * 倒序游标的起始值：`MAX(id) + 1`。
   *
   * 🔴 少了它，`batch(0)` 在倒序下等价于 `id < 0` —— **恒空**，索引任务会「秒完成」却一张不建，
   *    而且不报任何错（正是本仓最怕的静默失效）。`id` 是 rowid 别名，MAX 是一次索引定位。
   */
  maxPhotoId() {
    const row = this.source.prepare('SELECT MAX(id) AS hi FROM photos').get();
    const hi = row && row.hi != null ? Number(row.hi) : 0;
    return Number.isFinite(hi) && hi > 0 ? hi : 0;
  }

  /**
   * 补标签游标的起始值：`MAX(photo_id) + 1`。
   *
   * ⚠️ **不能借用上面的 `maxPhotoId()`**：补标签游走在 `embeddings.photo_id` 这个域上，
   * 而 `batch()` 游走在 `photos.id` 上。两者通常同域，但**图片被删而 embedding 行还在**时，
   * `MAX(embeddings.photo_id)` 可能大于 `MAX(photos.id)` —— 借用会让那些行落在游标之外，
   * 每一轮都被跳过（永远补不上标签，且没有任何报错）。
   */
  maxEmbeddingPhotoId() {
    const row = this.index.prepare('SELECT MAX(photo_id) AS hi FROM embeddings').get();
    const hi = row && row.hi != null ? Number(row.hi) : 0;
    return Number.isFinite(hi) && hi > 0 ? hi : 0;
  }

  /**
   * 🔴 **`tags` 绝不能加进上面 `batch()` 的谓词。**
   *
   * 那条谓词的语义是「这行的**向量**需要重新编码」，命中的行会被送去做一次
   * `encoder.image()`（SigLIP2 视觉塔前向 + 图片解码）。而「缺标签」是**另一回事** ——
   * 向量早就算好了，补标签只需读出来做点积，不需要碰磁盘上那张图。
   *
   * 把 `tags IS NULL` 混进去的后果不是报错而是**静默巨量浪费**：老索引里那 7374 行
   * 全都会因为缺标签被重新编码一遍（几分钟到十几分钟的白工），而且这个代价
   * 只有真跑一次才看得出来 —— 静态检查全绿。所以补标签必须走下面的
   * `batchPendingTags()`，两条路分开。
   */
  /**
   * 🟢 补标签的候选：**已经有向量、但标签缺失或词表指纹过期**的行。
   *
   * 一次查询同时把 `vector` / `generic_sim` 带回来。**不要拆成「先查 id 再逐个取向量」**：
   * 那样两个查询各有各的窗口，调用方稍不注意就会把 A 批的 id 配上 B 批的向量，
   * 而标签算错是静默的（没有报错，只是标错了图）。
   *
   * `limit` 同时约束内存：一条向量 3072 字节，限 200 就只有约 600 KB。
   *
   * 顺序与 `batch()` 一致为**主键倒序**（词表换了、整表指纹过期的那一轮，新入库的也该先补上标签）；
   * `beforeId` 是这个方向的**排他上界**，调用方用「本批最后一行的 photo_id」续接。
   */
  batchPendingTags(beforeId, limit, tagsKey) {
    return this.index
      .prepare(
        `SELECT photo_id, vector, generic_sim FROM embeddings
       WHERE photo_id < ? AND (tags IS NULL OR tags_key IS NULL OR tags_key != ?)
       ORDER BY photo_id DESC LIMIT ?`,
      )
      .all(beforeId, tagsKey, limit);
  }

  /** 待补标签的**总数**。只做 COUNT，不读 BLOB。 */
  pendingTagsCount(tagsKey) {
    const row = this.index
      .prepare(
        `SELECT COUNT(*) AS n FROM embeddings
       WHERE tags IS NULL OR tags_key IS NULL OR tags_key != ?`,
      )
      .get(tagsKey);
    return row ? row.n : 0;
  }

  /**
   * 批量写回标签。**事务包住**：补标签一次几千行，逐条自动提交会让索引库的
   * WAL 反复 fsync。失败整批丢（与 flushBaseline 同策）：下次补标签会重来。
   */
  setTags(entries) {
    if (!entries || !entries.length) return 0;
    const write = this.index.prepare(
      'UPDATE embeddings SET tags = ?, tags_key = ? WHERE photo_id = ?',
    );
    let written = 0;
    try {
      this.index.transaction(() => {
        for (const entry of entries) {
          written += write.run(serializeTags(entry.indexes), entry.key, entry.photoId).changes;
        }
      })();
    } catch (_) {
      return 0;
    }
    return written;
  }

  /** 单张图片的标签下标（`[]` = 算过但没有；NULL 与脏值同样降级成 `[]`）。 */
  tagsFor(photoId) {
    const row = this.index.prepare('SELECT tags FROM embeddings WHERE photo_id = ?').get(photoId);
    return parseTags(row && row.tags);
  }

  /**
   * `genericSim` 在建索引时顺手算好（worker 已经拿得到向量），这样新索引一落库就带基线，
   * 不会再触发一次补算。
   *
   * `tags` 形如 `{indexes, key}`，**索引流程里当场算好**：worker 此刻手里既有刚编码出的
   * 图片向量、又有词表向量，算标签是纯点积，边际成本≈0。**不传就等于「这张还没算过」**
   * ——`batchPendingTags()` 之后会把它捞出来补，所以漏传不会丢数据，只会延后。
   */
  put(photo, vector, genericSim, tags) {
    this.index
      .prepare(
        `INSERT OR REPLACE INTO embeddings
       (photo_id, model, file_path, file_size, date_modified, vector, generic_sim, tags, tags_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        photo.id,
        MODEL_KEY,
        photo.file_path,
        photo.file_size,
        photo.date_modified,
        pack(vector),
        Number.isFinite(genericSim) ? genericSim : null,
        tags && Array.isArray(tags.indexes) ? serializeTags(tags.indexes) : null,
        tags && tags.key ? String(tags.key) : null,
      );
  }

  count() {
    return this.source
      .prepare(
        `SELECT COUNT(*) AS n FROM semantic.embeddings e JOIN photos p
      ON p.id = e.photo_id AND p.file_path = e.file_path AND p.file_size = e.file_size
      AND COALESCE(p.date_modified, '') = e.date_modified WHERE e.model = ?`,
      )
      .get(MODEL_KEY).n;
  }

  /**
   * 把刚好补齐的基线写回。失败就整批丢掉：下一次检索会重新算一遍，功能不受影响
   * （写不进去的原因通常是另一个索引 worker 正占着这个库的写锁）。
   */
  flushBaseline(pending) {
    if (!pending.length) return;
    const write = this.index.prepare('UPDATE embeddings SET generic_sim = ? WHERE photo_id = ?');
    try {
      this.index.transaction(() => {
        for (const [id, value] of pending) write.run(value, id);
      })();
    } catch (_) {}
    pending.length = 0;
  }

  /**
   * 按匹配阈值检索（不是「取前 N 条」）。
   *
   * 分数用**基线差**：每张图片先减掉它与泛化文本的相似度，剩下的才是这个查询自己带来的信号。
   * 因此返回的 `similarity` 不是原始余弦，而是这个差值 —— 阈值也作用在它上面。
   *
   * 过滤阈值是**自适应**的：`effective = max(threshold, ADAPTIVE_ALPHA × top1)`，
   * 即先用地板收一遍，再按这个查询自己的尺度收尺子（口径与实测见 ADAPTIVE_ALPHA 与
   * DEFAULT_MATCH_THRESHOLD 的注释）。用户设的 `threshold` 进 `max()` 第一项，
   * 所以**手动收紧永远优先**。
   *
   * @returns {Promise<{ photos: object[], matched: number, candidates: number,
   *   threshold: number, truncated: boolean }>}
   *   `matched` = 达到**生效**阈值之上的张数（自适应未生效时精确且不受 `MAX_RESULTS` 影响，
   *   生效时等于 `photos.length` 或它的下界）；
   *   `candidates` = 达到**用户地板**的张数（上了自适应之后它才是那个大数）；
   *   `truncated` = 还有达标但没返回的。
   *   `threshold` 回传的是**生效**的那个值，不是入参 —— 调用方要显示/记日志时用这个。
   */
  async search(query, options, cancelled) {
    const {
      threshold = DEFAULT_MATCH_THRESHOLD,
      baseline = null,
      maxResults = MAX_RESULTS,
    } = options || {};
    // 达到「用户地板」的张数。之所以不叫 matched：返回的 matched 是**生效阈值**之上的张数，
    // 两者在上了自适应之后不是同一个数（候选是超集）。
    let candidates = 0;
    const kept = [];
    const pending = [];
    let after = 0;
    const batch = this.source.prepare(`SELECT e.photo_id, e.vector, e.generic_sim, p.file_name,
      p.width, p.height, p.has_thumbnail, p.file_type, p.file_size, p.date_modified, p.is_favorite
      FROM semantic.embeddings e JOIN photos p ON p.id = e.photo_id
      AND p.file_path = e.file_path AND p.file_size = e.file_size
      AND COALESCE(p.date_modified, '') = e.date_modified
      WHERE e.model = ? AND e.photo_id > ? ORDER BY e.photo_id LIMIT 256`);
    while (true) {
      if (cancelled()) throw new Error('AI_CANCELLED');
      const rows = batch.all(MODEL_KEY, after);
      if (!rows.length) break;
      for (const row of rows) {
        after = row.photo_id;
        let base = row.generic_sim;
        if (base == null) {
          if (!baseline) throw new Error('AI_BASELINE_MISSING');
          base = score(baseline, row.vector);
          pending.push([row.photo_id, base]);
          if (pending.length >= BASELINE_FLUSH) this.flushBaseline(pending);
        }
        const adjusted = score(query, row.vector) - base;
        if (adjusted < threshold) continue;
        candidates += 1;
        delete row.vector;
        delete row.generic_sim;
        row.id = row.photo_id;
        row.similarity = adjusted;
        kept.push(row);
        // 攒到两倍上限就排一次、留最相近的那一批：内存有界，且留下的始终是正确的 top N。
        if (kept.length >= maxResults * 2) {
          kept.sort((a, b) => b.similarity - a.similarity || a.id - b.id);
          kept.length = maxResults;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.flushBaseline(pending);
    kept.sort((a, b) => b.similarity - a.similarity || a.id - b.id);

    // ---------- 自适应阈值：按这个查询自己的 top1 收尺子 ----------
    //
    // 为什么不需要为了求 top1 再扫一遍向量（点积是这里的全部成本）：
    //   1. `effective = max(threshold, α × top1) ≥ threshold` **恒成立** ——
    //      所以上面按 `threshold` 收集的 `kept` 一定是最终结果的**超集**，不会漏；
    //   2. `top1` 是最大值，而「攒到 2×maxResults 就排序截断」这种有界截断**必然先保住它**
    //      ⇒ 扫完时 `kept[0]` 就是真的 top1（哪怕底下还压着几十万张候选）。
    // 于是只剩「在已排序的 kept 上从头截掉不达标的尾巴」这一步，O(n) 且不碰向量。
    const top1 = kept.length ? kept[0].similarity : 0;
    // ⚠️ `threshold === 0` 是**显式关掉过滤**（滑杆拉到最左 = 「我全都要」），此时自适应也必须让路：
    //    写成无条件的 `max(0, α×top1)` 会替用户做决定，而用户恰恰明确说了「不要过滤」。
    //    这一条由 `semantic-regression` 的既有断言钉着（「阈值 0 时 1.0 与 0.0 都算达标」）。
    const effective =
      threshold > 0 ? Math.max(threshold, ADAPTIVE_ALPHA * top1) : 0;
    if (effective > threshold) {
      let cut = kept.length;
      while (cut > 0 && kept[cut - 1].similarity < effective) cut -= 1;
      kept.length = cut;
    }

    // `matched` 的口径 = **生效阈值**之上的总数。分两种情况不是因为含糊，而是因为
    // 「生效阈值」本身是扫完才知道的（它依赖 top1），而流式计数只有一次机会：
    //   - 自适应没生效（`effective === threshold`，**高阈值查询都走这条**）⇒ 直接用流式计数的
    //     `candidates`，**不受 maxResults 影响** —— 这是既有契约，由守护钉着
    //     （「threshold 0.5、maxResults 2 时 matched 仍是达标总数 3」）。
    //   - 自适应生效（`effective > threshold`）⇒ 只能用过滤后的 `kept.length`：候选没被
    //     maxResults 截断时它精确，被截断时它是**下界**（此时 `truncated` 同时为 true，
    //     调用方据此知道「还有达标的没返回」）。为这个数字再扫一遍向量不值 ——
    //     点积是这个方法的全部成本，而它换来的只是一个显示用的计数。
    const matched = effective > threshold ? kept.length : candidates;

    // ⚠️ `truncated` 的口径是**专指**「受返回上限限制而没全给」（既有契约，守护钉着
    // 「threshold 0.5、maxResults 2 时 truncated 必须是 true」）——**不含**被自适应砍掉的那批：
    // 那些是「不达标」，说成「截断」会让界面把「阈值收紧了」误报成「结果太多只显示一部分」。
    const truncated = kept.length > maxResults;
    if (truncated) kept.length = maxResults;
    return { photos: kept, matched, candidates, threshold: effective, truncated };
  }

  /**
   * 按 id 批量取图片行（**字段与口径与 `search()` 返回的行逐字段相同**）。
   *
   * ## 为什么需要它
   *
   * tag 倒排库只给 `{id, score}`（它那边没有图片行），而融合后这些条目要和 CLIP 路的条目
   * 一起渲染成卡片 ⇒ 必须回主库补齐。补的行若少一个字段，卡片上就是一处空白或一个「未知」——
   * 而缺字段**不会报错**，只会让人以为是数据问题。
   *
   * ## 刻意不校验指纹（与 `search()` 不同，是有意的）
   *
   * `search()` 那条查询要 JOIN `embeddings` 并逐列比对 `file_path` / `file_size` / `date_modified`，
   * 因为「向量是不是这一版图算的」直接决定分数可不可信。这里不校对：tag 索引是在**当时那张图**
   * 上建的，图片后来换了内容 ⇒ tag 确实可能不再成立，但那属于「索引陈旧」，该由重建解决；
   * 在这一层静默丢掉只会让「搜得到却点不开」。主库里真的没有的（已删）自然被过滤掉，
   * 数量由调用方报出来（`dropped`），不静默。
   *
   * ## 参数上限
   *
   * `IN (?,?,…)` 展开 `ids.length` 个参数，SQLite 的上限是 32766；本调用点的上游
   * （`src/ai/tag-fusion.js#FUSE_DEPTH`）保证并集 ≤ 800 ⇒ 安全。
   * ⚠️ 要把它调大到五位数，就得改用 `src/main/sql-id-list.js` 那套 `json_each`
   *   （那里有 32,766 的实测与三种写法的取舍）。
   *
   * @param {number[]} ids
   * @returns {Map<number, object>} id → 图片行（取不到的 id 不在里面）
   */
  photosByIds(ids) {
    const out = new Map();
    const list = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id > 0) : [];
    if (!list.length) return out;
    const holes = list.map(() => '?').join(',');
    const rows = this.source
      .prepare(
        `SELECT p.id, p.file_name, p.width, p.height, p.has_thumbnail, p.file_type,
          p.file_size, p.date_modified, p.is_favorite
          FROM photos p WHERE p.id IN (${holes})`,
      )
      .all(...list);
    for (const row of rows) {
      // `photo_id` 与 `id` 都给：`search()` 返回的行里两个都在（渲染层历史上用过两个名字），
      // 这里少给一个就会在那条路径上变成 `undefined`。
      row.photo_id = row.id;
      out.set(row.id, row);
    }
    return out;
  }

  /**
   * 给候选词打分：这些词在这个库里有没有内容。
   *
   * ## 为什么是「取样」而不是全库
   *
   * 命中数只需要区分「0 张 / 几十张 / 上千张」三档，取样几千条就够；而候选词现在有几百个，
   * 全量扫在百万库上要跑几百次全表，代价不成比例。
   *
   * ## 取样必须真的覆盖全库（2026-09-29 修）
   *
   * 老写法的窗口起点是 `1 + random * (maxId - windowSize)`，而 `maxId` 是**整个 id 空间的上界**。
   * 但入库的 photo_id 只占其中一小段（本机实测 7374 条向量只落在 `324737..332328`，而
   * `maxId` 就是 332328 附近、`maxId - windowSize` 仍远大于该段下界）—— 于是 6 个窗口里
   * 绝大多数起点都落在该段**之前**，`WHERE photo_id >= start ORDER BY photo_id LIMIT n`
   * 每次都返回**同一批最早的 n 行**，去重后 `sampled` 恒为 500/7374 = 6.8%。
   * 注释里写的「不要从最小的 id 连着读」这个防御因此**完全没有生效**，后果是
   * 本库真实有 84 张的「人物肖像」被判成 0 命中，预选词于是整体退回静态词库。
   *
   * 现在改成：起点在**入库 id 自己的范围** `[lo, hi]` 上等距铺开（不是随机），因此
   *   ① 每个窗口都落在真的有向量的区间里；
   *   ② 取样是确定性的 —— 「同一份设置重跑结果一致」是本项目的硬契约，随机取样会让
   *      预选词每次刷新都换一批，无法复现也无法断言；
   *   ③ 窗口之间不重叠（等距铺开 + 按 photo_id 去重兜底）。
   * 索引规模小于样本量时直接全量扫，不做窗口。
   *
   * ## 打分的循环顺序
   *
   * 外层行、内层候选词，且每行的 BLOB **只解码一次**成 `Float32Array`。反过来写（每个候选词
   * 各自扫一遍全库、各自 `readFloatLE`）在几百个候选词时会退化成几十亿次 Buffer 方法调用。
   */
  async scoreCandidates(candidates, options, cancelled) {
    const {
      threshold = DEFAULT_MATCH_THRESHOLD,
      baseline = null,
      sampleSize = 3000,
    } = options || {};
    if (!candidates.length || !baseline) return { sampled: 0, hits: [] };
    const bounds = this.index
      .prepare(
        'SELECT COALESCE(MIN(photo_id), 0) AS lo, COALESCE(MAX(photo_id), 0) AS hi, COUNT(*) AS n FROM embeddings',
      )
      .get();
    if (!bounds.n || !bounds.hi) return { sampled: 0, hits: [] };
    const range = this.source.prepare(
      `SELECT e.photo_id, e.vector, e.generic_sim FROM semantic.embeddings e JOIN photos p
      ON p.id = e.photo_id AND p.file_path = e.file_path AND p.file_size = e.file_size
      AND COALESCE(p.date_modified, '') = e.date_modified
      WHERE e.model = ? AND e.photo_id >= ? ORDER BY e.photo_id LIMIT ?`,
    );
    // 全量扫：把小库的取样误差直接消掉（几千条向量不值一提），也让回归里的断言可精确复现。
    const windows = [];
    if (bounds.n <= sampleSize) {
      windows.push([0, sampleSize]);
    } else {
      const windowCount = 8;
      const windowSize = Math.max(1, Math.ceil(sampleSize / windowCount));
      const span = Math.max(1, bounds.hi - bounds.lo);
      for (let w = 0; w < windowCount; w += 1)
        windows.push([bounds.lo + Math.floor((span * w) / windowCount), windowSize]);
    }
    const vectors = [];
    const seen = new Set();
    const pending = [];
    for (const [start, size] of windows) {
      for (const row of range.all(MODEL_KEY, start, size)) {
        // 等距铺开的窗口在库很密时仍可能重叠，按 photo_id 去重：同一张图片重复计分
        // 会让 hits 变成「命中次数」而不是「命中张数」。
        if (seen.has(row.photo_id)) continue;
        seen.add(row.photo_id);
        let base = row.generic_sim;
        if (base == null) {
          base = score(baseline, row.vector);
          pending.push([row.photo_id, base]);
        }
        const values = new Float32Array(DIMENSIONS);
        for (let i = 0; i < DIMENSIONS; i += 1) values[i] = row.vector.readFloatLE(i * 4);
        vectors.push({ values, base });
      }
    }
    this.flushBaseline(pending);
    const hits = new Array(candidates.length).fill(0);
    for (const { values, base } of vectors) {
      if (cancelled()) throw new Error('AI_CANCELLED');
      for (let i = 0; i < candidates.length; i += 1) {
        if (dot(candidates[i].vector, values) - base >= threshold) hits[i] += 1;
      }
    }
    return { sampled: vectors.length, hits };
  }

  close() {
    this.source.close();
    this.index.close();
  }
}

module.exports = { IndexStore, DEFAULT_MATCH_THRESHOLD, MAX_RESULTS, MATCH_THRESHOLD_RANGE };
