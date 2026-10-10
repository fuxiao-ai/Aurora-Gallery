'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  labelsAtIndexes,
  parseTags,
  TAG_LANG,
  vocabKey,
} = require('../ai/photo-tags');
// 预选词的词表（`labelsFor`）与两个条数上限（`SUGGEST_LIMIT_*`）。**条数上限不在本文件另写一份**：
// worker 那条老路也在夹同样两个数，两处各写一份的后果是「同一个界面元素被两条路服务时条数不同」，
// 而界面只摆 5 个 ⇒ 差 24 还是 64 在界面上看不出来（静默分叉）。
const {
  labelsFor,
  SUGGEST_LIMIT_DEFAULT,
  SUGGEST_LIMIT_MAX,
} = require('../ai/search-vocabulary');
// 词表指纹要用 `MODEL_KEY` 参与哈希：库里的 `tags_key` 就是 `vocabKey(MODEL_KEY, 词表)` 算出来的
// （见 `photo-tags.js#vocabKey` 的两个写入方：索引流程与补标签流程）。
const { MODEL_KEY } = require('../ai/embedding');
const { toZh } = require('../ai/tag-zh');
// 画面标签的**归属**（子类 / 顶层分类）要跟着标签一起给渲染端 —— 渲染层没有这份表，
// 而「跳标签导航页」必须带上 `node`/`category` 才能展开树并高亮（见 `tag-nav-ui.js#selectTag`）。
const cats = require('../ai/tag-categories');
// 展示线唯一源：与标签导航页共用同一个取值口径（两处分家会造出「面板有、导航 0 张」的错位）。
const { TAG_DISPLAY_RANGE, quantize } = require('../ai/tag-index-store');

/**
 * 「主题标签」的**只读**通道。
 *
 * 两个消费方，同一张表（`embeddings.tags`）、同一条连接，只是取法不同：
 *   · 图片信息面板「按图取标签」—— 按主键取一行的 `tags`（`tagsFor`）；
 *   · 搜图页「预选词」—— 把整张表转置成「词 → 命中张数」（`suggestTerms`，2026-10-09 起）。
 *
 * ## 为什么主进程要单独开一个连接
 *
 * 标签存在**搜图索引库**（`ai-search/semantic-index.sqlite` 的 `embeddings.tags`）里，
 * 不在 `photos` 表 —— 它是索引的派生物，随索引一起重建。而 `getPhotoInfo()` 走的是主库连接，
 * 跨不了库；把一个可能不存在的库 ATTACH 到**可写**的主库连接上风险更大（ATTACH/DETACH
 * 在写事务里会失败，而主库连接正是写闸门服务的对象）。所以这里照 `get-photo-dimensions`
 * 的先例另开一条独立的只读路径。
 *
 * ## 为什么不复用 IndexStore
 *
 * `IndexStore` 构造时会 ATTACH 主库（worker 需要 join photos 拿缩略图）。主进程已经有
 * 主库连接了，再挂一次既浪费又绕；面板只需要按主键取一行的 `tags`，轻量只读连接足够。
 *
 * ## 失败一律降级，绝不抛
 *
 * 索引库可能不存在（从没建过索引）、可能正被索引 worker 占着写锁、也可能刚重建过。
 * 这些都不是「错误」，只是「此刻读不到」→ 返回空数组，界面据此不显示这一行
 * （与「空值整行隐藏」的既定取向一致）。面板是只读展示，不该因为搜图索引的可用性而失败。
 */
class SemanticTags {
  constructor(aiPath) {
    this.aiPath = aiPath;
    this.connection = null;
    /** 已确认读不到（索引库不存在 / 打不开）→ 不再反复 stat，免得每张图片都白试一次。 */
    this.unavailable = false;
  }

  indexFile() {
    return path.join(this.aiPath, 'semantic-index.sqlite');
  }

  /**
   * 惰性建连接并复用。
   *
   * `readonly: true` 是硬要求：主进程这一侧**只读**，绝不写索引库（写是 worker 的唯一职责，
   * 两个写入者会互相拿到 `SQLITE_BUSY`）。`busy_timeout` 兜住 checkpoint 瞬间的锁。
   */
  conn() {
    if (this.connection) return this.connection;
    if (this.unavailable) return null;
    try {
      const file = this.indexFile();
      if (!fs.existsSync(file)) {
        this.unavailable = true;
        return null;
      }
      this.connection = new Database(file, { readonly: true, fileMustExist: true });
      this.connection.pragma('busy_timeout = 2000');
      return this.connection;
    } catch (_) {
      this.unavailable = true;
      return null;
    }
  }

  /**
   * 某张图片的标签文本（跟随 `locale`）。
   *
   * @returns {string[]} 空数组 = 「没索引 / 索引了但没标签 / 索引库此刻读不到」三者之一。
   *   三者都让面板隐藏这一行，所以不再细分成不同返回值 —— 需要区分时（比如将来做
   *   「搜图索引状态」字段）再扩展。
   */
  tagsFor(photoId, locale) {
    const id = Number(photoId);
    if (!Number.isFinite(id)) return [];
    const conn = this.conn();
    if (!conn) return [];
    try {
      const row = conn.prepare('SELECT tags FROM embeddings WHERE photo_id = ?').get(id);
      if (!row) return [];
      // 库里存的是**词表下标**（见 photo-tags.js），这里才映射成当前语言的文本。
      return labelsAtIndexes(parseTags(row.tags), locale);
    } catch (_) {
      // 查询本身失败（库被换掉 / 磁盘出错）：丢掉这个连接，下次重开，本次降级成空。
      this.close();
      return [];
    }
  }

  /**
   * 预选词的**命中统计** —— 把 `embeddings.tags` 转置过来，得到「词 → 有多少张图把它算作自己
   * 的 top-3 标签」，按命中数降序返回前 N 个。
   *
   * ## 为什么改走这里（2026-10-09）
   *
   * 原来这条路要起一个只读 worker：`loadEncoder`（~2.1 s）+ 开索引（~0.7 s）+
   * 对 3000 张取样向量给 308 个词逐个点积（~1.2 s）≈ **4 s**；冷启还要现算 308 个词的
   * 词表向量（+12.9 s）。而答案只是「哪些词点下去有图」—— 同一份信息**已经躺在库里**了：
   * `embeddings.tags` 就是每张图 top-3 标签的词表下标（`photo-tags.js`）。
   * 转置统计实测 **开库到出结果 48 ms**（`GROUP BY` 本身 38–45 ms，本机 9406 行）。
   *
   * 两条路的另一个差别是**覆盖面**。老路是**取样**（`scoreCandidates` 取 3000 张，
   * 而本机那份索引的 `photo_id` 落在两个窄带上，窗口起点大量落进空档 ⇒ 实测只覆盖
   * **750 / 9406 = 8%**）；这里是**全量**转置，一条不漏。
   *
   * ## 🔴 `hits` 是什么、不是什么
   *
   * **不是「搜这个查询词能返回多少张照片」**，而是「**有多少张图把该词排进了自己的 top-3 标签**」。
   * 两个原因，都不是实现误差：
   *   · `TAG_MAX = 3` —— 每张图入库时最多留 3 个标签，其余概念就算分数很高也**没进库**；
   *   · `TAG_THRESHOLD = 0.015` 与检索用的 `MATCH_THRESHOLD`（0.01）**不是同一把尺子**
   *     （`photo-tags.js` 有专门注释解释「同一把尺子但不是同一个数」）。
   *
   * ⇒ **`hits` 只用于排序，外加「让 0 命中的词根本不进结果」**（后者由 `GROUP BY` 天然做到，
   *    见下面的注释）。绝不许把它当张数显示给用户，也不许拿它跟「找到 N 张照片」对齐 ——
   *    两者本来就不等，想显示张数要另外去问检索。当前界面只取 `terms[].text`（不显示 `hits`），
   *    所以这个约束在界面上看不出来，**只能靠契约与守护把它钉住**。
   *
   * ## 覆盖面：只等于「已打标」的那部分
   *
   * 标签由 `tag` 任务补（`semantic-worker.js#refreshTags`），没跑过就全是 `NULL`。
   * 返回里的 `sampled` = **这次真正数到多少行**（判据只有一条：`tags_key` 对得上；`tags` 为 NULL
   * 或空数组的行**也算在内** —— 它们分别是「没打过标」与「算过但一个都不达标」）。
   * ⚠️ 它与「全库有多少张图」**无关**；`sampled === 0` 时界面把预选词整块收起（既有取向）。
   *
   * ## 为什么必须按 `tags_key` 过滤
   *
   * `tags` 里存的是**词表下标**。词表一改（增删词），同一个下标指向的**是另一个概念** ——
   * 不过滤就会把「丝袜」的位置报成别的词，而且**不报错、数值也像真的**。
   * `tags_key` 是 `vocabKey(MODEL_KEY, 词表)` 的指纹（`photo-tags.js`），
   * 与 `IndexStore.pendingTagsCount()` 判「还有多少行待补」用的是**同一个判据** ——
   * 那里认为「无效」的行，这里也不许统计。
   *
   * @param {string} [locale] `en` 前缀取英文词表，其余取中文（与 worker 的判定**完全同源**）。
   * @param {number} [limit] 最多返回几个（夹在 `[1, SUGGEST_LIMIT_MAX]`，缺失取
   *   `SUGGEST_LIMIT_DEFAULT`）。返回的是**一个池子**，界面从里面洗牌抽 5 个。
   * @returns {{sampled:number, terms:{text:string,hits:number}[]}}
   *   读不到（没建索引 / 索引库被换掉 / 查询炸了）一律 `{sampled: 0, terms: []}`，**绝不抛** ——
   *   与 `tagsFor` 同一条取向：预选词是装饰性提示，不该因为索引可用性让搜图页打不开。
   */
  suggestTerms(locale, limit) {
    const conn = this.conn();
    if (!conn) return { sampled: 0, terms: [] };
    const language = String(locale || '')
      .toLowerCase()
      .startsWith('en')
      ? 'en'
      : 'zh';
    const wanted = Number(limit);
    const max = Number.isFinite(wanted)
      ? Math.min(SUGGEST_LIMIT_MAX, Math.max(1, Math.trunc(wanted)))
      : SUGGEST_LIMIT_DEFAULT;
    try {
      const key = vocabKey(MODEL_KEY, labelsFor(TAG_LANG));
      // 排序键里的 `idx ASC` 不是装饰：命中数相同时按**词表下标**（即词表原始顺序）定序，
      // 与 worker 那条路（对按词表顺序生成的候选数组做稳定排序）**逐位一致**。
      // 少了它，SQLite 给同分行的顺序是实现细节 —— 同一份库两次进搜图页会摆出不同的词。
      const rows = conn
        .prepare(
          `SELECT CAST(value AS INTEGER) AS idx, COUNT(*) AS hits
             FROM embeddings, json_each(embeddings.tags)
            WHERE embeddings.tags_key = ?
            GROUP BY idx
            ORDER BY hits DESC, idx ASC`,
        )
        .all(key);
      const sampled = conn
        .prepare('SELECT COUNT(*) AS n FROM embeddings WHERE tags_key = ?')
        .get(key).n;
      const labels = labelsFor(language);
      const terms = [];
      // ⚠️ 这里**刻意不再过滤 `hits > 0`**：`GROUP BY` 只产出「至少有一行贡献过」的组，
      //    `COUNT(*)` 不可能为 0 ⇒ 那种过滤是恒真分支（看着像在挡 0 命中，其实什么也没挡）。
      //    真正把「0 命中的词」挡在外面的是 **`tags_key` 过滤之后的连接**：一个词只要在所有
      //    有效行里都没出现，它连一行都产生不出来 —— 界面因此永远不会摆出点了没结果的词。
      for (const row of rows) {
        const text = labels[row.idx];
        if (typeof text === 'string' && text) terms.push({ text, hits: row.hits });
        if (terms.length >= max) break;
      }
      return { sampled, terms };
    } catch (_) {
      // 查询本身失败：丢掉这个连接下次重开，本次降级成空（与 `tagsFor` 同一处置）。
      this.close();
      return { sampled: 0, terms: [] };
    }
  }

  close() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (_) {}
      this.connection = null;
    }
  }
}

/**
 * **信息面板每张最多显示多少个 JoyTag 标签**。
 *
 * JoyTag 每张图在入库线（0.15）以上平均留 ~56 个标签（真库 113,280 对 / 2,032 张），
 * 全部塞进面板胶囊会把「读数」变成「数据表」。取分数最高的前 N 个 —— 与 tag 路检索
 * 「按分数排序」的口径一致；面板是摘要，检索走的是完整倒排，两者不冲突。
 */
const JOYTAG_PANEL_LIMIT = 24;

/**
 * 「画面标签」（JoyTag）的**只读**通道 —— 与上面 `SemanticTags` 同构的第三类来源：
 * 标签在 **tag 索引库**（`ai-search/tag-index.sqlite`）里，不在 `photos` 表，
 * `getPhotoInfo()` 跨不了库 ⇒ 照既有先例另开一条惰性只读连接。
 *
 * 与 `SemanticTags` 的两处刻意差异：
 *   ① 表结构不同 —— `photo_tag(photo_id, tag_id, score)` JOIN `tag_vocab(tag_id, tag)`，
 *      按 `score DESC` 取前 `JOYTAG_PANEL_LIMIT` 个；
 *   ② **中文映射做在这一层**（`ai/tag-zh.js`）：桌面与网页两端拿到的都是翻译后的文本，
 *      两端自动同源。查不到的标签回落英文原文（映射表是显示层的，不追着打标进度补）。
 *
 * 失败一律降级返回空数组（库不存在 / 被 worker 占写锁 / 查询炸了），绝不抛 ——
 * 与 `SemanticTags` 同一条既定取向：面板是只读展示，不该因为索引可用性而失败。
 */
class JoyTagTags {
  /**
   * @param {string} aiPath `ai-search/` 目录（tag 索引库所在处）
   * @param {{displayMinScore?: () => number}} [options] 展示线的**取值器**（见 `tag-nav.js`
   *   同名参数：必须是函数，且不许把返回值缓存成字段 —— 设置改了要立刻生效）。
   */
  constructor(aiPath, options) {
    this.aiPath = aiPath;
    this.options = options || {};
    this.connection = null;
    /** 已确认读不到（tag 库不存在 / 打不开）→ 不再反复 stat，免得每张图片都白试一次。 */
    this.unavailable = false;
  }

  /** 当前生效的展示线（概率）。合法性兜底同 `TagNav#displayMinScore`（夹取只由主进程设置层做）。 */
  displayMinScore() {
    const read = this.options.displayMinScore;
    const value = typeof read === 'function' ? Number(read()) : NaN;
    return Number.isFinite(value) ? value : TAG_DISPLAY_RANGE.default;
  }

  indexFile() {
    return path.join(this.aiPath, 'tag-index.sqlite');
  }

  /** 惰性建连接并复用。**只读**：tag 库的唯一写入者是 tag worker（两个写入者会互拿 `SQLITE_BUSY`）。 */
  conn() {
    if (this.connection) return this.connection;
    if (this.unavailable) return null;
    try {
      const file = this.indexFile();
      if (!fs.existsSync(file)) {
        this.unavailable = true;
        return null;
      }
      this.connection = new Database(file, { readonly: true, fileMustExist: true });
      this.connection.pragma('busy_timeout = 2000');
      return this.connection;
    } catch (_) {
      this.unavailable = true;
      return null;
    }
  }

  /**
   * 某张图的画面标签（按分数降序、最多 `JOYTAG_PANEL_LIMIT` 个；中文优先，缺失回落英文）。
   *
   * 🔴 分数线用**当前生效的展示线**（设置项 `aiTagDisplayThreshold`，默认 0.35），
   *    与标签导航页**同一个取值口径**（`displayMinScore()` → `quantize()`）：
   *    面板是「把标签当结论摆给用户看」，低分区（实测 15..29 占倒排行的 61%）基本是 JoyTag 的
   *    噪声概率，摆出来就是错的。两处口径不一致更糟 —— 面板列着「蓝天」、导航里点「蓝天」0 张。
   *    默认值的实测依据见 `ai/tag-index-store.js#DISPLAY_MIN_SCORE`，可调范围见 `TAG_DISPLAY_RANGE`。
   *
   * ## 为什么回**结构化条目**而不是纯文本数组（2026-10-09 起）
   *
   * 面板上点「画面标签」要跳到**标签导航页的那个标签**，而导航页的节点 id 是**英文原名**、
   * 且要带上 `node`/`category` 才展开树（渲染层没有 `ai/tag-categories`，反查不了）。
   * 显示名是中文 —— 映射完就把原名丢掉的话，跳转只剩「拿中文名去猜节点」这一条死路。
   * 所以原名与归属在**这里**一起给出去，渲染端只负责摆出来。
   *
   * ⚠️ `ai_tags`（主题标签）**刻意保持纯文本数组**：它的词来自 308 条词表短语
   *    （「海滩」/`a beach`），**标签导航页里没有对应节点** ⇒ 只能搜图。两边形状不同
   *    不是疏忽，是「跳哪儿」本来就不同。
   *
   * @param {number} photoId
   * @param {string} locale 'en' 时 `name` 就是英文原名（不做中文映射）。
   * @returns {{tag:string,name:string,node:string,category:string}[]}
   *   空数组 = 「没打过标 / 没建 tag 库 / 此刻读不到 / 全部低于展示线」之一，
   *   界面据此整行隐藏 —— 四者不必区分。
   */
  tagsFor(photoId, locale) {
    const id = Number(photoId);
    if (!Number.isFinite(id)) return [];
    const conn = this.conn();
    if (!conn) return [];
    try {
      const rows = conn
        .prepare(
          `SELECT t.tag AS tag FROM photo_tag pt JOIN tag_vocab t ON t.tag_id = pt.tag_id
           WHERE pt.photo_id = ? AND pt.score >= ? ORDER BY pt.score DESC LIMIT ?`,
        )
        .all(id, quantize(this.displayMinScore()), JOYTAG_PANEL_LIMIT);
      if (!rows.length) return [];
      const english = locale === 'en';
      return rows.map((r) => {
        const tag = r.tag;
        const node = cats.subOf(tag);
        return {
          tag,
          name: english ? tag : toZh(tag) || tag,
          node,
          category: cats.SUB_TO_CATEGORY.get(node) || 'other',
        };
      });
    } catch (_) {
      // 查询本身失败：丢掉这个连接下次重开，本次降级成空。
      this.close();
      return [];
    }
  }

  close() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (_) {}
      this.connection = null;
    }
  }
}

module.exports = { SemanticTags, JoyTagTags, JOYTAG_PANEL_LIMIT };
