'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');

const { labels } = require('../ai/tag-labels');
const { toZh } = require('../ai/tag-zh');
const cats = require('../ai/tag-categories');
const { TAG_DISPLAY_RANGE, quantize, tagIndexPath, tagIdOf } = require('../ai/tag-index-store');

/**
 * 「标签导航页」的**只读**数据服务（分类树 / 节点下的标签 / 某标签有哪些图）。
 *
 * ## 为什么又是一个跨库只读连接
 *
 * 标签在 **tag 索引库**（`ai-search/tag-index.sqlite`）里，不在 `photos` 表 ——
 * 与 `main/semantic-tags.js` 的 `SemanticTags` / `JoyTagTags` 是同一类来源。
 * 而**读工作池只挂一个库**（`db-read-worker-pool` 一旦换 `dbPath` 就把整个池 terminate 重建），
 * 所以「查 tag 库」这一步**不能**塞进 worker 池，只能像 `JoyTagTags` 一样在主进程自开连接。
 *
 * ⚠️ 因此本模块**只碰 tag 库**，绝不碰主库：需要一个标签下的照片**行**时，
 *    这里只返回 `photo_id`（有序），由 `main.js` 用 `photoListColumns()` + `idListPredicate()`
 *    回主库取行。职责切开的好处是「索引库读不到」与「主库读不到」是两种独立故障，
 *    各自的降级互不牵连。
 *
 * ## 失败一律降级，绝不抛
 *
 * 与既有两条只读通道同一条取向：tag 库可能不存在（从没建过索引）、可能正被索引 worker
 * 占着写锁、可能刚重建过。这些都不是「错误」，只是「此刻读不到」⇒ 返回空结构，
 * 界面显示「标签索引还没建好」而不是报错。
 *
 * ## 命中数是**按节点懒算**的，不是全表聚合
 *
 * `photo_tag` 现在是 11 万行（2032 张图），全表 `GROUP BY tag_id` 只要 8 ms —— 但**不能**
 * 按这个读数设计：索引覆盖到全库（165 万张、每张 ~56 个标签）时那是 **~9000 万行**，
 * 全表聚合会变成几十秒的主线程阻塞。所以命中数只在**打开某个节点时**、对该节点的标签
 * 算一次（`WHERE tag_id IN (...)` 走 `idx_tag_score` 的区间扫描），代价与该节点的命中行数成正比。
 * 树本身只给「这个节点有多少个标签」，以及「其中有多少已出现在索引里」—— 这俩从 `tag_vocab`
 * 现算，与库规模无关。
 */

/** 一个标签最多回多少张图（分页由调用方给，这里只兜住内存）。 */
const TAG_PHOTOS_MAX_PAGE_SIZE = 200;

/** 搜索一次最多回多少个标签（避免「a」这种查询把 5813 条全吐出去）。 */
const SEARCH_TAG_LIMIT = 120;

class TagNav {
  /**
   * @param {string} aiPath `ai-search/` 目录（tag 索引库所在处）
   * @param {{displayMinScore?: () => number}} [options] 展示线（读侧分数线）的**取值器**。
   *
   * 🔴 **必须传函数、不能传数值**：设置项 `aiTagDisplayThreshold` 是可以在运行期改的
   *    （设置页里拖一下就好），而本服务在启动时构造一次、活到进程结束。传数值 =
   *    改完必须重启才生效；传函数 = 每次查询现取，**下一次取数就生效**。
   *    同理**不要**缓存第一次读到的值（`this._line` 之类）—— 那就是把函数又变回了数值。
   *    不传时回落 `TAG_DISPLAY_RANGE.default`（守护/探针直接 new 出来的场合）。
   */
  constructor(aiPath, options) {
    this.aiPath = aiPath;
    this.options = options || {};
    this.connection = null;
    /** 已确认读不到（tag 库不存在 / 打不开）⇒ 不再反复 stat。 */
    this.unavailable = false;
  }

  /**
   * 当前生效的展示线（概率，0.01–0.95 之外的脏值一律回落默认值）。
   *
   * 这里**只挑「有值 / 合法」**，不做夹取（夹取是 `main.js#ensureSettingsShape` 用
   * `clampDisplayMinScore()` 的唯一职责）：两处各夹一次，就会出现「面板显示 A、SQL 用 B」，
   * 而这种分歧在界面上只表现为「张数对不上」，没有任何报错。
   */
  displayMinScore() {
    const read = this.options.displayMinScore;
    const value = typeof read === 'function' ? Number(read()) : NaN;
    return Number.isFinite(value) ? value : TAG_DISPLAY_RANGE.default;
  }

  /**
   * 展示线的**整数分**（SQL 里的 `score >= ?`）。
   *
   * 🔴 一律走 `quantize()`（唯一量化实现，floor）而**不是** `Math.round(线 × 100)`：
   *    入库时分数就是 `quantize(概率)` 存下的整数，只有同一个函数换算才能保证
   *    「概率 ≥ 线」与「整数分 ≥ 换算结果」**逐行等价**（证明见 `tag-index-store.js#quantize`）。
   *    设置值被 `clampDisplayMinScore()` 对齐到 2 位小数，两种写法此刻恰好同值 ——
   *    但「此刻恰好同值」不是可以依赖的性质，换个步长就分叉。
   */
  displayMinScoreInt() {
    return quantize(this.displayMinScore());
  }

  indexFile() {
    return tagIndexPath(this.aiPath);
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

  close() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (_) {}
      this.connection = null;
    }
  }

  /**
   * 索引里**已经出现过**的标签集合（= `tag_vocab` 的全部行）。
   *
   * 这份集合是导航页「显不显示某个标签」的唯一判据：分类体系是全量 5813 条的，
   * 但库里还没打标到的标签**点进去必然是空的** —— 与其给用户一个点开没图的死节点，
   * 不如只列有内容的（分类树仍然显示「共 N 个标签 / 已有 M 个」让用户知道进度）。
   *
   * 每次都重新读：`tag_vocab` 最多 5813 行（一次 SELECT 的量级），换取「不会因为缓存
   * 过期而显示已失效的标签」。缓存的代价在这个规模上不成比例。
   */
  indexedTags() {
    const conn = this.conn();
    if (!conn) return { set: new Set(), rows: 0 };
    try {
      const rows = conn.prepare('SELECT tag_id, tag FROM tag_vocab').all();
      const set = new Set();
      for (const r of rows) set.add(r.tag);
      return { set, rows: rows.length };
    } catch (_) {
      this.close();
      return { set: new Set(), rows: 0 };
    }
  }

  /** 索引规模（给界面显示「标签索引仍在建立」这类提示用）。 */
  status() {
    const conn = this.conn();
    if (!conn) return { available: false, tags: 0, photos: 0 };
    try {
      const tags = conn.prepare('SELECT COUNT(*) AS c FROM tag_vocab').get().c;
      const photos = conn.prepare('SELECT COUNT(*) AS c FROM tag_photo').get().c;
      return { available: true, tags, photos };
    } catch (_) {
      this.close();
      return { available: false, tags: 0, photos: 0 };
    }
  }

  /**
   * 分类树（两级：顶层分类 → 子类），**不含标签**。
   *
   * 每个子类给两个数：
   *   - `tagTotal`：分类体系判给它的标签总数（全量 5813 口径）
   *   - `tagIndexed`：其中**已出现在索引里**的个数（= 点开有内容的那些）
   * 顶层分类同样给这两个数的合计数。`tagIndexed === 0` 的节点界面应当置灰 ——
   * 这正是「索引还在建」时用户唯一能看懂的信号。
   *
   * ⚠️ `label` 是**兜底名**（分类体系里的中文名），界面一律优先用自己的 i18n 词条
   *    （`tagnav.cat.<id>` / `tagnav.sub.<id>`）；缺词条时才回落到它。
   *    带上它的意义是「新增一个子类不会在界面上渲染出机器 id 字面量」——
   *    忘了补词条只会显示中文，而不是 `clothes_top` 这种东西。
   */
  tree() {
    const { set: indexed } = this.indexedTags();
    const out = [];
    for (const c of cats.CATEGORIES) {
      const subs = [];
      let catTotal = 0;
      let catIndexed = 0;
      for (const s of cats.SUBS) {
        if (s.category !== c.id) continue;
        const tags = cats.tagsOf(s.id);
        let n = 0;
        for (const t of tags) if (indexed.has(t)) n++;
        catTotal += tags.length;
        catIndexed += n;
        subs.push({ id: s.id, label: s.label, tagTotal: tags.length, tagIndexed: n });
      }
      if (!subs.length) continue;
      out.push({ id: c.id, label: c.label, tagTotal: catTotal, tagIndexed: catIndexed, subs });
    }
    return out;
  }

  /**
   * 某个节点（顶层分类 id 或子类 id）下的标签，**带命中数**，按命中数降序。
   *
   * 只返回索引里已出现过的标签（见 `indexedTags`），并且**只返回展示线以上有内容的那些**
   * （命中数 0 的一个都不给 —— 那是个点了没图的死节点，见下面的 filter）。命中数在这一层算：
   * 一次 `WHERE tag_id IN (?) GROUP BY tag_id`，只覆盖这个节点的标签，不扫全表。
   *
   * @param {string} nodeId 顶层分类 id（`clothing`）或子类 id（`uniform`）
   * @param {string} locale `'en'` 时返回英文原文，其余一律中文优先
   * @returns {{tags: Array<{tag:string, name:string, count:number}>, total:number, indexed:number}}
   *   `total` = 分类体系判给这个节点的标签数；`indexed` = 其中已出现在索引里的个数。
   *   ⚠️ `indexed` **不是** `tags.length`（后者是过滤后的）：界面用 `indexed > 0 && !tags.length`
   *   区分「还没索引到这儿」与「有标签但都低于展示线」—— 两种空态给用户的下一步动作完全不同。
   */
  node(nodeId, locale) {
    const id = String(nodeId || '');
    const isCategory = cats.CATEGORIES.some((c) => c.id === id);
    const isSub = cats.SUB_IDS.has(id);
    if (!isCategory && !isSub) return { tags: [], total: 0, indexed: 0 };

    let candidates = [];
    if (isSub) candidates = cats.tagsOf(id);
    else {
      for (const s of cats.SUBS) if (s.category === id) candidates.push(...cats.tagsOf(s.id));
    }
    const { set: indexed } = this.indexedTags();
    const present = candidates.filter((t) => indexed.has(t));

    const counts = this.countsForTags(present);
    const tags = present
      .map((t) => ({
        tag: t,
        name: locale === 'en' ? t : toZh(t) || t,
        // 分类体系里有、索引里也有，但**展示线以下**的行占了大多数 —— 这个数见下面的 filter，
        // 它同时是「卡片上写几张」的那个数（`countsForTags` 与 `rankedPhotoIds` 同口径）。
        count: counts.get(t) || 0,
      }))
      // 🔴 命中数为 0 的标签**不进列表**：它在界面上是一个「看起来能点、点进去什么都没有」的
      //    死节点。这个过滤以前是反的（回 0、由界面置灰），代价实测很大 —— 2032 张图的库里，
      //    默认展示线 0.35 下有 1029 / 1752 个已索引标签是 0（占 58.7%），标签页过半是灰字。
      //    过滤之后 `tags.length < indexed` 是**设计如此**，不是漏了：`indexed` 是过滤前的
      //    候选数，界面正是靠它区分「这儿还没索引」与「有标签但都低于展示线」两种空态。
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    return { tags, total: candidates.length, indexed: present.length };
  }

  /**
   * 一批标签各自的命中数（一次查询，走 `idx_tag_score`）。
   *
   * `tag_id` 用标签表下标（`ai/tag-labels#indexOf`）——**不查 `tag_vocab` 再映射**：
   * 索引的 `tag_id` 契约就是「JoyTag 输出下标」（见 `ai/tag-index-store.js` 的 DDL 注释），
   * 拿标签名再回查一次是多余的一次往返，且引入「vocab 里没有这个名字」的分支。
   *
   * 🔴 分数线用**当前生效的展示线**（设置项 `aiTagDisplayThreshold`，默认 0.35），
   *    且必须与 `rankedPhotoIds` **同一个数**：这里给的是「卡片上写几张」，那边给的是
   *    「点进去真的有哪几张」。两处口径一旦分家，卡片写 1172、点进去 723 张，
   *    而界面不会报任何错（2026-10-09 抬线时钉的）。
   *    ⚠️ 取线必须**每次调用现取**（`this.displayMinScoreInt()`）—— 缓存成字段，
   *    「设置改了立刻生效」就变成了「下次重启才生效」，且症状只是数字不更新。
   *
   * @param {string[]} tagList
   * @returns {Map<string, number>} tag → 命中图片数
   */
  countsForTags(tagList) {
    const out = new Map();
    const conn = this.conn();
    if (!conn || !tagList.length) return out;
    const ids = [];
    const byId = new Map();
    for (const t of tagList) {
      const id = tagIdOf(t);
      if (id === null) continue;
      ids.push(id);
      byId.set(id, t);
    }
    if (!ids.length) return out;
    try {
      const minScore = this.displayMinScoreInt();
      // 分段查询：SQLite 的 `?` 上限是 32766，这里按 900 一批，避免节点标签过多时爆参数。
      const CHUNK = 900;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const holes = slice.map(() => '?').join(',');
        const rows = conn
          .prepare(
            `SELECT tag_id, COUNT(*) AS c FROM photo_tag WHERE tag_id IN (${holes}) AND score >= ? GROUP BY tag_id`,
          )
          .all(...slice, minScore);
        for (const r of rows) out.set(byId.get(r.tag_id), r.c);
      }
    } catch (_) {
      this.close();
      return new Map();
    }
    return out;
  }

  /**
   * 某个标签下的照片 id（**按标签分降序**），带总数。
   *
   * 排序用 `score DESC`（分数 = 该标签在这张图上的置信度）：分数高的在前，
   * 也就是「最典型地属于这个标签」的图先出来 —— 与 tag 检索路的口径一致。
   *
   * 🔴 分数线用**当前生效的展示线**（设置项 `aiTagDisplayThreshold`，默认 0.35），
   *    **不是**入库线（0.15）、也不是查询线（0.55）：
   *    - 用入库线会把 JoyTag 的「噪声概率」当结论摆出来。实测 15..29 区间占全部倒排行的 61%，
   *      抽 top1 肉眼核对到的误报（`blue_sky` 0.22 其实没有天空、`cat` 0.21 其实没有猫）全在那里；
   *    - 用查询线（0.55）又会悄悄漏掉一批**确实对但模型没把握**的行，界面同样看不出来。
   *    默认值的实测依据与代价写在 `ai/tag-index-store.js#DISPLAY_MIN_SCORE` 的注释里，
   *    可调范围（下界=入库线、上界=查询线）见 `TAG_DISPLAY_RANGE`。
   *
   * ⚠️ 这个数必须与 `countsForTags` 相同（卡片写几张 ↔ 点进去有几张）——
   *    两处都走 `displayMinScoreInt()`，所以「同口径」是由**同一个取值点**保证的。
   *
   * @returns {{ids:number[], total:number}} 读不到时 `{ids: [], total: 0}`
   */
  rankedPhotoIds(tag, page, pageSize) {
    const out = { ids: [], total: 0 };
    const conn = this.conn();
    if (!conn) return out;
    const tagId = tagIdOf(tag);
    if (tagId === null) return out;
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(Math.max(1, Number(pageSize) || 120), TAG_PHOTOS_MAX_PAGE_SIZE);
    try {
      const minScore = this.displayMinScoreInt();
      const rows = conn
        .prepare(
          `SELECT photo_id FROM photo_tag WHERE tag_id = ? AND score >= ?
           ORDER BY score DESC, photo_id DESC LIMIT ? OFFSET ?`,
        )
        .all(tagId, minScore, size, (p - 1) * size);
      const total = conn
        .prepare('SELECT COUNT(*) AS c FROM photo_tag WHERE tag_id = ? AND score >= ?')
        .get(tagId, minScore).c;
      return { ids: rows.map((r) => r.photo_id), total };
    } catch (_) {
      this.close();
      return out;
    }
  }

  /**
   * 搜标签（英文标签名 / 中文显示名，子串匹配、大小写不敏感）+ 搜节点名。
   *
   * 子串匹配是刻意的：用户输入的是片段（「裙」「hair」），要求完整词才命中会让搜索
   * 在最常见的用法下失效。代价是短查询会命中很多 —— 所以结果**按命中数降序**并截断，
   * 「有内容的排前面」把噪声压到看不见。
   *
   * 只在**索引里已出现**的标签中搜（搜出来点开没图没有意义），并且**命中数为 0 的照样不吐**
   * —— 与 `node()` 同一条过滤（见那边的注释）。
   *
   * @returns {{tags: Array<{tag,name,count,node}>, nodes: Array<{kind,id,category}>, indexed:number}}
   *   `indexed` = 过滤**前**命中到的标签数（口径与 `node()` 的 `indexed` 一致：匹配到的、
   *   已出现在索引里的个数）。界面靠它区分「一个都没匹配上」与「匹配到的都低于展示线」。
   *   ⚠️ 它也因此**不**等于 `tags.length`（后者还受了 `SEARCH_TAG_LIMIT` 截断）。
   */
  search(keyword, locale) {
    const q = String(keyword == null ? '' : keyword).trim().toLowerCase();
    if (!q) return { tags: [], nodes: [], indexed: 0 };

    // ① 节点名：模块里的中文兜底名 + 机器 id。界面用 i18n 名重贴标签，
    //    所以这里回 id 就够了 —— 不必让服务端知道当前语言。
    const nodes = [];
    for (const c of cats.CATEGORIES) {
      if (c.id.includes(q) || c.label.toLowerCase().includes(q)) nodes.push({ kind: 'category', id: c.id });
    }
    for (const s of cats.SUBS) {
      if (s.id.includes(q) || s.label.toLowerCase().includes(q)) nodes.push({ kind: 'sub', id: s.id });
    }

    // ② 标签名：英文原文 + 中文显示名都参与匹配
    const { set: indexed } = this.indexedTags();
    const hits = [];
    for (const t of labels()) {
      if (!indexed.has(t)) continue;
      const zh = toZh(t);
      const name = locale === 'en' ? t : zh || t;
      if (t.toLowerCase().includes(q) || (zh && zh.toLowerCase().includes(q)) || name.toLowerCase().includes(q)) {
        hits.push(t);
      }
    }

    const counts = this.countsForTags(hits);
    const tags = hits
      .map((t) => {
        const c = cats.categoryOf(t);
        const zh = toZh(t);
        return {
          tag: t,
          name: locale === 'en' ? t : zh || t,
          count: counts.get(t) || 0,
          node: c.sub,
          category: c.category,
        };
      })
      // 同 `node()`：0 命中的标签不给界面（否则搜「裙」会吐一屏点开没图的词）。
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, SEARCH_TAG_LIMIT);

    // 过滤**前**的命中数。`hits.length` 而不是 `tags.length`：后者已经被 0 命中过滤
    // 与条数截断动过了，拿它当「匹配到几个」会让界面把「都低于展示线」误判成「没匹配上」。
    return { tags, nodes, indexed: hits.length };
  }
}

module.exports = { TagNav, TAG_PHOTOS_MAX_PAGE_SIZE, SEARCH_TAG_LIMIT };
