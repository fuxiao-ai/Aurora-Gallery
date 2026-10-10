'use strict';

const path = require('path');
const Database = require('better-sqlite3');

/**
 * JoyTag 标签倒排索引（第二路检索）的**唯一真相源**：DDL / 阈值 / 取词 / 打分口径全在这里。
 *
 * 它和 `index-store.js`（CLIP 向量路）是**两套并列的东西**，刻意不合并：
 * 向量路答「任意中文查询」，标签路答「这个词表里有的概念」；两路的分数**不同量纲**
 * （基线差 vs sigmoid 概率），所以阈值各有自己的实测定档，别互抄。
 *
 * ## 索引结构
 *
 * ```
 * tag_meta   (key, value)                   -- schema_version / model / vocab_key / 建库时间…
 * tag_vocab  (tag_id PK, tag UNIQUE)        -- tag_id **就是** JoyTag 输出下标（见下）
 * tag_photo  (photo_id PK, source_spec, engine, tagged_at)   -- 每张图的**来源凭证**
 * photo_tag  (photo_id, tag_id, score, PRIMARY KEY(photo_id, tag_id)) WITHOUT ROWID
 * idx_tag_score ON photo_tag(tag_id, score DESC)             -- 真正的倒排
 * ```
 *
 * ### 🔴 `tag_id` 用 JoyTag 的**输出下标**，不是自增
 * 标签表的语义就是「行号 = 输出下标」（`ai/tag-labels.js` 的 `indexOf`）。用它当主键有三个好处：
 * ① 重建索引不产生 id 漂移（自增依赖插入顺序，改一处就全表错位）；
 * ② 可以直接 `labelAt(tag_id)` 反查标签、不需要第二张映射表；
 * ③ 「标签表换了」这件事能被 `tag_meta.vocab_key` 一把判废。
 *
 * ### 🔴 凭证是**每张图**一行（`tag_photo`），不是每个 (图,标签) 一行
 * 计划草案写的是「索引内每行都带 `source_spec` / `engine`」。逐 (图,标签) 存会把同一份字符串
 * 重复 40 遍（7374 张 × ~40 标签），而这两个字段的**粒度和「这张图是怎么被打标的」一样粗** ——
 * 所以正确的载体是 `tag_photo(photo_id)`。判废能力一点没少：`DELETE FROM photo_tag WHERE photo_id IN
 * (SELECT photo_id FROM tag_photo WHERE source_spec <> ?)` 照样支持 M5 那种「缩略图换规格后重打」。
 * 守护会断言**没有孤儿**：不允许出现有 `photo_tag` 行、却没有 `tag_photo` 行的 photo_id。
 */

/**
 * 索引库的**文件名**。产品侧路径（`tagIndexPath`）与台架建索引器都用这个名字。
 *
 * ⚠️ 只定义这一处：查询侧按它找库、建库侧按它写库，两边各拼一次就会出现
 * 「索引建好了但搜图说没有索引」这种最难查的静默不一致（两者都不报错）。
 */
const TAG_INDEX_FILE = 'tag-index.sqlite';

/**
 * 产品侧 tag 索引库的路径：`<aiPath>/tag-index.sqlite`（`aiPath` = `UserData/ai-search`）。
 *
 * 刻意**与 CLIP 索引库（`semantic-index.sqlite`）分开文件**：
 * ① 两者可以独立重建（换词表/换标签表只会判废 tag 那一份）；
 * ② 重跑 CLIP 索引（百万库上是几天的事）不该让 tag 路跟着一起消失；
 * ③ M3 的全部验收（守护 + 1500 张台架）都是在**独立库**上做的，合并进一个文件等于
 *    把已验证的东西重新暴露一次风险，换不来任何收益。
 */
function tagIndexPath(aiPath) {
  return path.join(aiPath, TAG_INDEX_FILE);
}

/** 表结构版本。改 DDL 必须抬它，否则老库会被当成新库用（`init()` 不会重建）。 */
const TAG_INDEX_SCHEMA_VERSION = 1;

/** 索引里 model 字段的取值。模型换了这个也要换，否则新旧行混在一起。 */
const TAG_INDEX_MODEL = 'joytag';

/**
 * **入库线**：低于它的标签不写进索引（概率口径，sigmoid 输出）。
 *
 * 为什么必须有：JoyTag 有 5813 个头，几乎每张图在几百个头上都能拿到 0.05~0.2 的「噪声概率」。
 * 全存既不划算（行数 ×20）也没用 —— 查询线是 0.55，低于入库线的分数**永远不可能被查到**。
 *
 * ⚠️ 入库线必须**明显低于**查询线，否则就是「存的时候丢掉了本来能命中的行」。
 *    0.15 是词表构建时用的正样本门槛，两处取同一个数是有意的（`docs/contracts/semantic-search.md`）。
 */
const STORE_MIN_SCORE = 0.15;

/**
 * **展示线**（读侧）：界面上「某个标签有哪些图 / 某张图有哪些标签」只显示置信度 **≥** 它的行。
 *
 * 与入库线是**两个不同的问题**：入库线管「值不值得存」，展示线管「值不值得当成结论摆给人看」。
 * 入库线 0.15 是照「查询线 0.55」定的（存下来的行将来可能被查到），它**从没考虑过**
 * 「直接把这些行当结论展示」这一种用法 —— 而标签导航页与照片信息面板正是这种用法。
 *
 * 2026-10-09 实测（活跃库 2032 张已打标 / `photo_tag` 113,280 行）：
 * - 15..29 区间占 **69,066 行（61%）**；1752 个标签里 **892 个「最高分 <30」**
 *   —— 即这些标签在整个目录里没有一张有把握的图；
 * - 抽 top1 肉眼核对：`black_hair`(83) ✓黑发 / `blue_sky`(22) **✗ 没有天空**（浅色床单）/
 *   `cat`(21) **✗ 没有猫** ⇒ 误报全部落在低分区。
 *
 * 取 0.35 的代价（同一份数据）：保留 35,059 行（30.9%）、723 个标签（41.3%）；
 * 2032 张图**每张仍有 ≥1 个标签**（不会出现「点进去全空」）。要更松/更紧只改这一个数：
 * 0.30 → 39.0% 行 / 49.1% 标签；0.40 → 25.1% 行 / 34.1% 标签。
 *
 * ⚠️ **导航页与照片信息面板（`JoyTagTags`）必须共用这一条线**：两处口径不一致会造出
 *    比「两边都低」更糟的错位 —— 面板里列着「蓝天」，去导航页点「蓝天」却是 0 张。
 * ⚠️ 展示线必须 **≥** 入库线（低于它的行根本不存在，写了也没用）。
 *
 * ## 这个值现在是**默认值**，不是硬编码（2026-10-09 用户诉求「设置可调，调了怎么生效」）
 *
 * 上面的取舍表是「一个数」的取舍，而不同库的噪声水平不一样（拍得糊的库 0.35 仍会漏噪声、
 * 拍得干净的库 0.35 又砍得太狠）⇒ 用户应当能自己挪。可调范围与夹取在 `TAG_DISPLAY_RANGE`
 * / `clampDisplayMinScore()`；**读侧不再直接读本常量**，而是读设置项 `aiTagDisplayThreshold`，
 * 本常量只作为「设置缺失 / 非法 / 老配置没有这个键」时的回落值。
 */
const DISPLAY_MIN_SCORE = 0.35;

/**
 * **查询线**（概率口径）：一条查询词条的标签分要达到它才算命中。
 *
 * 取 `0.55` 有两个依据，**都与别的产物对齐**（不是随手挑的）：
 * ① `scripts/tag-vocab-coverage.json` 的 `threshold` 就是 `0.55`（那份冻结快照记录了每个词条
 *    在 0.50/0.55/0.60 三档的命中数，`tag-vocab-regression` 钉着 `=== 0.55`）——
 *    产品查询线跟它不一致，就会出现「词表验证说能用、真查却是空的」这类静默漂移；
 * ② 台架阈值扫描（`.workbuddy/bench/rank-joytag.txt`）显示：**F1 最优在 0.5（0.355）**，
 *    但 0.5 起负对照开始漏（雪山 1 / 咖啡 1 / 鲜花 5 张），0.6 基本干净而召回掉到 0.246。
 *    0.55 取在「误报已压住、召回还没塌」的那一段，与 M4 计划写的「0.55–0.6」一致。
 *
 * ⇒ 一句话：**0.55 是精度侧的取法，0.5 是 F1 侧的取法**。两者差的那 0.05 是「宁可少给几张、
 *    也别给错」的取舍，而用户可以在 `TAG_ROUTE_RANGE` 里自己挪。
 */
const TAG_ROUTE_THRESHOLD = 0.55;

/** 查询线的可调范围。`min` 刻意不放到 0：0 会把几百个噪声标签全放进来。 */
const TAG_ROUTE_RANGE = { min: 0.2, max: 0.95, default: TAG_ROUTE_THRESHOLD };

/**
 * **展示线的可调范围**（设置项 `aiTagDisplayThreshold` 的限位）。
 *
 * ⚠️ **必须定义在 `TAG_ROUTE_THRESHOLD` 之后**：`const` 没有提升，写在前面读它
 *    会在模块加载时直接 `ReferenceError: Cannot access 'TAG_ROUTE_THRESHOLD' before
 *    initialization` —— 而这个文件是被 worker / 主进程 / 守护三处一起 require 的，
 *    报错会以「模块都加载不了」的形式出现在最不相关的地方。
 *
 * 上下界**不是随手取的**，它们就是那两条硬约束的化身（`docs/contracts/joytag-index.md` §4.1）：
 *   · `min = STORE_MIN_SCORE`（0.15）—— 低于入库线的行**在库里根本不存在**，
 *     再往下调滑杆只会让人以为「还能更松」，实际一点变化都没有；
 *   · `max = TAG_ROUTE_THRESHOLD`（0.55）—— 高过查询线就出现「导航点进去的图比搜得到的还少」，
 *     标签页看起来像缺图，而这**是配置出来的，不是数据如此**。
 *
 * 两端写成另两条线的引用（而不是各写一个字面量）还有一层用途：`scripts/tag-nav-regression.js`
 * 断言 `min === STORE_MIN_SCORE && max === TAG_ROUTE_THRESHOLD` —— 将来谁改了那两条线而忘了
 * 改这里，夹取区间就会与硬约束脱节，那一断言是唯一的报警器。
 *
 * 步长 0.01：与面板滑杆/输入框的步长一致，也让「设置里的值 ×100」恒为整数
 * （`quantize()` 的口径要求 —— 2 位小数时「概率 ≥ 线」与「整数分 ≥ 线×100」逐张等价）。
 */
const TAG_DISPLAY_RANGE = {
  min: STORE_MIN_SCORE,
  max: TAG_ROUTE_THRESHOLD,
  step: 0.01,
  default: DISPLAY_MIN_SCORE,
};

/**
 * 把任意输入夹到 `TAG_DISPLAY_RANGE` 内并对齐步长；空值/非法值回落默认值。
 *
 * 与 `ai/face-settings.js#clampThreshold` 逐条同构（那套写法已经被用了一年），
 * 唯一差别是这里**同时对齐 2 位小数**：读侧把线换算成整数分用的是 `quantize()`（floor），
 * 只有「设置值恰好是 2 位小数」时 `quantize(线)` 才与 `线 × 100` 逐值相等。
 * 不在这里收口，一个手改成 `0.345` 的设置会让界面显示 0.345、实际按 0.34 过滤 ——
 * 差一行、且没有任何地方报错。
 *
 * 空值回落**默认值**而不是最低档：清空输入框的意思通常是「我不想管它」，
 * 而 0.15 是「什么都放出来」的极端档，绝不是清空输入时想要的结果。
 *
 * ⚠️ 这是**唯一**的夹取实现（`main.js#ensureSettingsShape` 调它）。读侧不信任何外部值，
 *    但也不重复夹取 —— 两处各夹一次就会在「谁夹的」上分叉（面板显示 A、SQL 用 B）。
 */
function clampDisplayMinScore(value) {
  if (value === undefined || value === null || String(value).trim() === '')
    return TAG_DISPLAY_RANGE.default;
  const number = Number(value);
  if (!Number.isFinite(number)) return TAG_DISPLAY_RANGE.default;
  const stepped = Math.round(number / TAG_DISPLAY_RANGE.step) * TAG_DISPLAY_RANGE.step;
  return Math.min(TAG_DISPLAY_RANGE.max, Math.max(TAG_DISPLAY_RANGE.min, Number(stepped.toFixed(2))));
}

/** 单次查询最多返回多少张（只约束内存，不参与「谁达标」）。 */
const TAG_MAX_RESULTS = 5000;

/**
 * 概率 → 整数分（0–100）。
 *
 * 🔴 **必须 floor，不能用 round**。因为要把「浮点概率比较」换成「整数比较」而不改变语义，
 * 需要的是 `floor(p × 100) ≥ t ⟺ p ≥ t/100`（t 为整数）—— 这条**只有 floor 成立**：
 * `round` 会把 `p = 0.4999` 变成 50、于是在 t=50 处**多放进一张**（台架的浮点口径是排除的）。
 * 证明：`floor(x) ≥ t (t ∈ ℤ) ⟺ x ≥ t`。所以量化后阈值 50 与「概率 ≥ 0.50」**逐张等价**，
 * 这也是 M3 验收能要求「与台架逐值一致」的前提。
 *
 * 代价：小于 0.01 的精度丢了 —— 但查询线是 0.5 量级，1/100 的粒度远够。
 */
function quantize(probability) {
  const p = Number(probability);
  if (!isFinite(p) || p <= 0) return 0;
  if (p >= 1) return 100;
  return Math.floor(p * 100);
}

/** 整数分 → 概率下界（用于展示）。`dequantize(50) = 0.5`。 */
const dequantize = (score) => Number(score) / 100;

/** `tag_meta` 里那些「索引身份」字段的键名。改索引身份必须写全这几个，否则守护红。 */
const META_KEYS = ['schema_version', 'model', 'vocab_key', 'label_sha256', 'created_at', 'updated_at'];

class TagIndexStore {
  /**
   * @param {string} filePath 索引库路径。**必须显式传** —— 不设默认值，
   *   避免出现「以为在写副本、其实写了真库」这种探针事故（`index-store.js` 的探针注释同源）。
   * @param {{readOnly?: boolean}} [options] 查询侧**必须**传 `{readOnly: true}`（见下）。
   */
  constructor(filePath, options) {
    if (!filePath) throw new Error('TAG_INDEX_PATH_REQUIRED');
    this.path = filePath;
    this.readOnly = !!(options && options.readOnly);
    /**
     * 🔴 只读 + `fileMustExist`：**库不存在必须当场抛**，让调用方降级成「纯 CLIP」。
     *
     * 为什么这条不能省：可写打开会在「还没建过索引」的机器上**凭空造出一个空库文件**，
     * 于是「这台机器没有 tag 索引」被伪装成「tag 索引是空的」—— 两者都是 0 结果，
     * 但界面该说的话完全不同（「还没建索引」vs「这个词没有命中」）。
     * 这正是本仓最怕的静默失效形态：不报错、不写日志、静态全绿。
     *
     * 顺带：查询侧一律只读还让「索引在跑时还能搜图」这条既有能力**天然安全** ——
     * 第二个连接不参与写锁竞争（`semantic-worker.js` 的 relay 路径靠的就是这一点）。
     */
    this.db = this.readOnly
      ? new Database(filePath, { readonly: true, fileMustExist: true })
      : new Database(filePath);
    // ⚠️ `journal_mode = WAL` 是**库级持久设置**：只读连接改不了它（会抛），也无需改 ——
    //    建库那一次已经写进文件头了。放在 `if` 里不是优化，是正确性。
    if (!this.readOnly) this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 3000');
    this.init();
  }

  /**
   * 建表（幂等）。已存在则只核对 schema 版本，**不做迁移** —— 版本不符直接抛，让人显式重建。
   *
   * ⚠️ 只读打开时**一条 DDL 都不发**：SQLite 的只读连接执行写语句会报
   *    `attempt to write a readonly database`，而 `CREATE TABLE IF NOT EXISTS` 在表已存在时
   *    虽然是 no-op，**但那是实现细节、不是契约** —— 查询热路径不该靠「大概不会写」来赌。
   *    改成只检查四张表在不在，少一张就抛（调用方据此降级）。
   */
  init() {
    if (this.readOnly) this.assertTables();
    else this.createTables();
    const known = this.getMeta('schema_version');
    if (known == null) {
      if (this.readOnly) {
        throw new Error('TAG_INDEX_SCHEMA_MISMATCH: 只读库里没有 schema_version（不是本模块建的库）');
      }
      this.setMeta('schema_version', String(TAG_INDEX_SCHEMA_VERSION));
    } else if (Number(known) !== TAG_INDEX_SCHEMA_VERSION) {
      throw new Error('TAG_INDEX_SCHEMA_MISMATCH: 库内 ' + known + ' vs 代码 ' + TAG_INDEX_SCHEMA_VERSION);
    }
    this._stmts = {
      putTag: this.db.prepare('INSERT OR IGNORE INTO tag_vocab (tag_id, tag) VALUES (?, ?)'),
      tagIdOf: this.db.prepare('SELECT tag_id FROM tag_vocab WHERE tag = ?'),
      putPhoto: this.db.prepare(
        'INSERT OR REPLACE INTO tag_photo (photo_id, source_spec, engine, tagged_at) VALUES (?, ?, ?, ?)',
      ),
      delTagsOf: this.db.prepare('DELETE FROM photo_tag WHERE photo_id = ?'),
      putPair: this.db.prepare('INSERT OR REPLACE INTO photo_tag (photo_id, tag_id, score) VALUES (?, ?, ?)'),
      hasPhoto: this.db.prepare('SELECT 1 FROM tag_photo WHERE photo_id = ?'),
      countPhotos: this.db.prepare('SELECT COUNT(*) AS n FROM tag_photo'),
      countPairs: this.db.prepare('SELECT COUNT(*) AS n FROM photo_tag'),
      countTags: this.db.prepare('SELECT COUNT(*) AS n FROM tag_vocab'),
    };
  }

  /** 建表语句（**只在可写打开时执行**）。 */
  createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tag_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tag_vocab (
        tag_id INTEGER PRIMARY KEY,
        tag TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS tag_photo (
        photo_id INTEGER PRIMARY KEY,
        source_spec TEXT NOT NULL,
        engine TEXT NOT NULL,
        tagged_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS photo_tag (
        photo_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        score INTEGER NOT NULL,
        PRIMARY KEY (photo_id, tag_id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_tag_score ON photo_tag(tag_id, score DESC);
    `);
  }

  /**
   * 只读打开时的形状检查：少一张表就抛。
   *
   * 宁可**在此刻**抛（调用方立刻降级成纯 CLIP，界面说「tag 索引不可用」），
   * 也不要等到用户搜图时才在 `query()` 里 `no such table` —— 那时它会被当成一次搜索失败，
   * 而用户看到的是「搜图坏了」。
   */
  assertTables() {
    const have = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    for (const name of ['tag_meta', 'tag_vocab', 'tag_photo', 'photo_tag']) {
      if (!have.has(name)) throw new Error('TAG_INDEX_SCHEMA_MISSING: ' + name);
    }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM tag_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO tag_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value));
  }

  allMeta() {
    const out = {};
    for (const row of this.db.prepare('SELECT key, value FROM tag_meta').all()) out[row.key] = row.value;
    return out;
  }

  /** 这张图有没有打过标（续跑用）。 */
  hasPhoto(photoId) {
    return !!this._stmts.hasPhoto.get(photoId);
  }

  /**
   * 写一张图。
   *
   * @param {number} photoId
   * @param {Array<[string, number]>|Map<string, number>} scores 标签 → 概率（**未过滤**也可）
   * @param {{sourceSpec: string, engine: string, minScore?: number}} options
   * @returns {{stored: number, skippedUnknown: number}}
   *   `skippedUnknown` = 标签表里没有的标签（**静默 0 命中的来源**，必须能被看见）
   */
  put(photoId, scores, options) {
    const opts = options || {};
    if (!opts.sourceSpec || !opts.engine) throw new Error('TAG_INDEX_PROVENANCE_REQUIRED');
    const minScore = opts.minScore == null ? STORE_MIN_SCORE : Number(opts.minScore);
    const pairs = scores instanceof Map ? [...scores] : scores || [];
    let stored = 0;
    let skippedUnknown = 0;
    const now = Date.now();
    this.db.transaction(() => {
      // ⚠️ 先删旧行再写：重打一张图（换规格 / 换模型）不能留残影，否则「按标签取图」会
      //    命中一个这一版已经不存在的标签。这是**幂等**的关键一步。
      this._stmts.delTagsOf.run(photoId);
      this._stmts.putPhoto.run(photoId, String(opts.sourceSpec), String(opts.engine), now);
      for (const entry of pairs) {
        const tag = entry[0];
        const probability = Number(entry[1]);
        if (!isFinite(probability) || probability < minScore) continue;
        const id = tagIdOf(tag);
        if (id == null) {
          skippedUnknown += 1;
          continue;
        }
        this._stmts.putTag.run(id, tag);
        this._stmts.putPair.run(photoId, id, quantize(probability));
        stored += 1;
      }
    })();
    return { stored, skippedUnknown };
  }

  /**
   * 词条 → `{tag, tag_id}`。**只做解析与校验，一行都不写库。**
   *
   * ⚠️ 原 jsdoc 写的是「同时把新标签登记进 `tag_vocab`」，与实现矛盾 —— 那是错的：
   *    登记发生在 `put()` 里（`putTag`），这里只 resolve。留着正确的一版，免得下一个人
   *    照着注释去「补上登记」，把「词表里有、索引里查不到」伪装成「索引里查得到」。
   */
  resolveTags(tags) {
    const out = [];
    for (const raw of tags || []) {
      const tag = String(raw).trim();
      if (!tag) continue;
      const id = tagIdOf(tag);
      // ⚠️ 这里**不建**未知标签：`tag_vocab` 只应包含标签表里真有的标签，
      //    否则「词表里有、索引里查不到」会被伪装成「索引里查得到」。
      if (id == null) continue;
      out.push({ tag, tag_id: id });
    }
    return out;
  }

  /**
   * 查询词条。
   *
   * `mode` 语义与 `tag-vocabulary.js` 一致：`'any'` = 命中任一标签（打分取**最大分**）、
   * `'all'` = 每个标签都必须达标（打分取**最小分**，因为最弱的那个才是这条查询的短板）。
   *
   * @returns {{photos: Array<{id:number, score:number, tags:string[]}>,
   *   tags: string[], mode: string, threshold: number, missing: string[], truncated: boolean}}
   *   `missing` = 词条里在**标签表**里不存在的标签（界面据此提示「这个词没法用 tag 路」）
   */
  query(entry, options) {
    const opts = options || {};
    const mode = (entry && entry.mode) || 'any';
    const threshold = opts.threshold == null ? TAG_ROUTE_THRESHOLD : Number(opts.threshold);
    const limit = opts.limit == null ? TAG_MAX_RESULTS : Number(opts.limit);
    const wanted = (entry && entry.tags) || [];
    const resolved = this.resolveTags(wanted);
    const resolvedNames = new Set(resolved.map((r) => r.tag));
    const missing = wanted.map((t) => String(t).trim()).filter((t) => t && !resolvedNames.has(t));
    if (!resolved.length) {
      return { photos: [], tags: [], mode, threshold, missing, truncated: false };
    }
    const minScore = quantize(threshold);
    const ids = resolved.map((r) => r.tag_id);
    const holes = ids.map(() => '?').join(',');
    const rows =
      mode === 'all'
        ? this.db
            .prepare(
              `SELECT photo_id AS id, MIN(score) AS score FROM photo_tag
               WHERE tag_id IN (${holes}) AND score >= ?
               GROUP BY photo_id HAVING COUNT(*) = ?
               ORDER BY score DESC, photo_id ASC LIMIT ?`,
            )
            .all(...ids, minScore, ids.length, limit)
        : this.db
            .prepare(
              `SELECT photo_id AS id, MAX(score) AS score FROM photo_tag
               WHERE tag_id IN (${holes}) AND score >= ?
               GROUP BY photo_id
               ORDER BY score DESC, photo_id ASC LIMIT ?`,
            )
            .all(...ids, minScore, limit);

    // 命中标签回填：只说「这张图因为哪几个标签上榜」。⚠️ 只取已 resolve 的标签，
    // 且必须带同一个 score ≥ 线 —— 否则会出现「返回的分数 0.42 却挂着 0.42 的标签」这种自相矛盾。
    const photoIds = rows.map((r) => r.id);
    const byPhoto = new Map();
    if (photoIds.length) {
      const idHoles = photoIds.map(() => '?').join(',');
      const detail = this.db
        .prepare(
          `SELECT photo_id AS id, tag_id, score FROM photo_tag
           WHERE photo_id IN (${idHoles}) AND tag_id IN (${holes}) AND score >= ? ORDER BY score DESC`,
        )
        .all(...photoIds, ...ids, minScore);
      const nameOf = new Map(resolved.map((r) => [r.tag_id, r.tag]));
      for (const row of detail) {
        const list = byPhoto.get(row.id) || [];
        list.push(nameOf.get(row.tag_id));
        byPhoto.set(row.id, list);
      }
    }
    const photos = rows.map((r) => ({
      id: r.id,
      score: dequantize(r.score),
      tags: byPhoto.get(r.id) || [],
    }));
    return {
      photos,
      tags: resolved.map((r) => r.tag),
      mode,
      threshold,
      missing,
      // `truncated` 只表示「受返回上限限制」，不含被阈值挡掉的（与 `index-store.search` 同口径）。
      truncated: photos.length >= limit,
    };
  }

  /** 索引概况（守护与界面共用，别在别处再数一遍）。 */
  status() {
    const meta = this.allMeta();
    return {
      path: this.path,
      schemaVersion: Number(meta.schema_version),
      model: meta.model || null,
      vocabKey: meta.vocab_key || null,
      labelSha256: meta.label_sha256 || null,
      photos: this._stmts.countPhotos.get().n,
      pairs: this._stmts.countPairs.get().n,
      tags: this._stmts.countTags.get().n,
      /** 孤儿检查：有 `photo_tag` 行却没有 `tag_photo` 行的 photo_id 个数（必须是 0）。 */
      orphans: this.db
        .prepare('SELECT COUNT(DISTINCT photo_id) AS n FROM photo_tag WHERE photo_id NOT IN (SELECT photo_id FROM tag_photo)')
        .get().n,
      /** 反向孤儿：打过标签却一个标签都没留下的图（阈值过滤后正常会有，但数量要能看见）。 */
      emptyPhotos: this.db
        .prepare('SELECT COUNT(*) AS n FROM tag_photo WHERE photo_id NOT IN (SELECT photo_id FROM photo_tag)')
        .get().n,
    };
  }

  close() {
    try {
      this.db.close();
    } catch (_) {}
  }
}

/** 标签 → `tag_id`（= JoyTag 输出下标）。惰性建表，模块级缓存。 */
let TAG_INDEX_MAP = null;
function tagIdOf(tag) {
  if (!TAG_INDEX_MAP) {
    const labels = require('./tag-labels');
    TAG_INDEX_MAP = new Map();
    labels.labels().forEach((name, i) => {
      // 同名标签只认第一个下标（标签表里没有重复，这里只是防御）
      if (!TAG_INDEX_MAP.has(name)) TAG_INDEX_MAP.set(name, i);
    });
  }
  const id = TAG_INDEX_MAP.get(String(tag).trim());
  return id === undefined ? null : id;
}

module.exports = {
  TagIndexStore,
  TAG_INDEX_FILE,
  tagIndexPath,
  TAG_INDEX_SCHEMA_VERSION,
  TAG_INDEX_MODEL,
  STORE_MIN_SCORE,
  DISPLAY_MIN_SCORE,
  TAG_DISPLAY_RANGE,
  clampDisplayMinScore,
  TAG_ROUTE_THRESHOLD,
  TAG_ROUTE_RANGE,
  TAG_MAX_RESULTS,
  META_KEYS,
  quantize,
  dequantize,
  tagIdOf,
};
