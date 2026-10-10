'use strict';

/**
 * `getPhotos` 的 `total` 记忆化。
 *
 * ## 为什么需要
 *
 * `getPhotos` 每页都跑一次 `SELECT COUNT(*) FROM photos WHERE 1=1 …`。真库
 * （1,656,580 行）实测：**默认参数下整条 42.3 ms，其中 COUNT 占 38.2 ms**，真正取 100 行
 * 只要 0.3 ms。而这个数**只随行数变化** —— 翻页时压根不变，所以每翻一页都在重算同一个数。
 *
 * 更糟的是它**吃负载抖动**：同一时段 8 次实测 `52.1 / 53.0 / 57.9 / 58.7 / 60.6 / 60.9 /
 * 64.8 / 239.2 ms`（中位 60、最坏 239），另一时段同一查询 38.2 ms。越贵的查询越吃 CPU 与
 * 页缓存带宽，越容易被后台任务放大。缓存掉之后命中路径不进 SQLite，天然对抖动免疫。
 *
 * ## 键 = SQL 本身（这是本模块唯一重要的设计决定）
 *
 * `COUNT(*)` 的结果**只由 whereClause + 绑定参数决定**，所以键就是这两样的原样拼接。
 * 这样「以后加了新筛选项，却忘了把它加进缓存键」这类漂移**在结构上不可能发生** ——
 * 不变量是「同一条 SQL + 同一组参数 ⇒ 同一个数」，键取 SQL 即恒成立。
 * 反面做法（键按字段白名单手搓，如 `rootId|favoritesOnly|mediaType`）一旦漏一个字段
 * 就会**静默返回别人的计数**，而且不报错、不写日志。
 *
 * 由此推出：`page` / `pageSize` / `sortBy` / `sortOrder` / `lite` **天然被隔离**在同一份缓存之外
 * 的唯一正确方式，就是让它们根本不参与 whereClause —— 它们确实不参与（只进 LIMIT/OFFSET/ORDER BY）。
 *
 * ## 失效：TTL 有界 + 显式清空，两条缺一不可
 *
 * ① **TTL = 5 s**（`PHOTOS_TOTAL_TTL_MS`）：这是**最坏情况陈旧度上界**，覆盖所有「改了行数但
 *    调用方没清缓存」的路径（含将来新加的）。5 s 与 `main.js#THUMB_TOTAL_REFRESH_MS` 取同一个
 *    数，全工程「派生计数有多新」就一个数字要记。
 * ② **主进程显式清空**：`dbReadWorkerPool.invalidateReadCaches()` → worker 收到
 *    `{ op: '__cache_reset' }` 就清空。挂在已有的目录缓存失效点上（扫描收尾 / 移入回收站 /
 *    删除记录 / 移除目录）+ 收藏切换 + 失效记录清理，共 6 处。
 *
 * 🔴 **为什么不做「数据版本号」**：那要求把「哪次写改了行数」表达成一个可比较的版本，
 * 而写路径分散（扫描批内 INSERT、失效清理 DELETE、级联删除…），只要有**一处**忘了 bump，
 * 缓存就会一直返回旧值、直到 TTL 兜底 —— 也就是说版本号方案并没有真的消掉 TTL，
 * 只是多了一份「可能忘」的清单。反过来，隐性失效必须**有界**，所以 TTL 是硬的、不可省的；
 * 显式清空只是把已知路径从「≤5 s」压到「立刻」。
 *
 * 🔴 **不许把这份缓存用于任何正确性判定**（只喂「共 N 张」与 `totalPages`）。
 * 它是**有界陈旧**的显示量：删除一张图片后最坏 5 s 内页面数还是旧的。
 *
 * ## 为什么住在 worker 进程里
 *
 * `getPhotos` 只在读池 worker 里执行（`database.js#getPhotos` 只被 `db-read-worker.js`
 * 经原型借用调用；桌面端 IPC 与网页端 `web-server.js` 都走 `runDbReadWorkerOnly`）。
 * 所以这份缓存**天然同时覆盖桌面端与网页端**，且不需要任何 IPC / 主进程改动。
 * 池里 3 个 worker = 最多 3 份各自独立的缓存；顺序翻页时请求总落在同一个空闲槽上，命中率不受影响。
 */

/** 最坏情况陈旧度上界；与 `main.js#THUMB_TOTAL_REFRESH_MS` 同值（全工程一个数）。 */
var PHOTOS_TOTAL_TTL_MS = 5000;
/**
 * 条目上限。键是 SQL 文本，取值域天然极小（无过滤 / 每根 / 仅收藏 / 图或视频 的若干组合，
 * 量级是「几十」）—— 这个上限是防御性的，不是容量规划。
 */
var PHOTOS_TOTAL_MAX_ENTRIES = 64;

/** key -> { total, at }；Map 保持插入顺序，淘汰时删最旧的那个键。 */
var entries = new Map();
var hits = 0;
var misses = 0;

/**
 * @param {string} whereClause
 * @param {Array} params
 * @returns {string}
 */
function keyOf(whereClause, params) {
  var key = String(whereClause || '');
  var list = Array.isArray(params) ? params : [];
  for (var i = 0; i < list.length; i++) {
    // \u0000 不可能出现在 SQL 文本或本项目任何筛选参数里（rootId 是整数，mediaType 是白名单词）
    // ⇒ 不同 (sql, params) 组不会被拼成同一个键。
    key += '\u0000' + String(list[i]);
  }
  return key;
}

/**
 * @param {string} whereClause
 * @param {Array} params
 * @param {number} [nowMs]
 * @returns {number|null} 命中返回计数，未命中/已过期返回 null
 */
function get(whereClause, params, nowMs) {
  var key = keyOf(whereClause, params);
  var entry = entries.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (now - entry.at >= PHOTOS_TOTAL_TTL_MS) {
    entries.delete(key);
    misses++;
    return null;
  }
  hits++;
  return entry.total;
}

/**
 * @param {string} whereClause
 * @param {Array} params
 * @param {number} total
 * @param {number} [nowMs]
 */
function set(whereClause, params, total, nowMs) {
  var value = Number(total);
  if (!isFinite(value) || value < 0) return;
  var key = keyOf(whereClause, params);
  // 先删再插：让这个键移到 Map 末尾（最旧淘汰才不会误伤刚写过的条目）。
  entries.delete(key);
  entries.set(key, { total: value, at: typeof nowMs === 'number' ? nowMs : Date.now() });
  while (entries.size > PHOTOS_TOTAL_MAX_ENTRIES) {
    var oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** 显式清空：主进程在「行数变了」的动作之后经 `dbReadWorkerPool.invalidateReadCaches()` 调用。 */
function invalidateAll() {
  entries.clear();
}

/** 诊断 / 回归用。**不是**给业务逻辑读的状态。 */
function stats() {
  return {
    size: entries.size,
    hits: hits,
    misses: misses,
    ttlMs: PHOTOS_TOTAL_TTL_MS,
    maxEntries: PHOTOS_TOTAL_MAX_ENTRIES,
  };
}

/** 仅回归用：把命中计数归零，不影响已缓存的条目。 */
function resetStats() {
  hits = 0;
  misses = 0;
}

module.exports = {
  get: get,
  set: set,
  invalidateAll: invalidateAll,
  stats: stats,
  resetStats: resetStats,
  keyOf: keyOf,
  PHOTOS_TOTAL_TTL_MS: PHOTOS_TOTAL_TTL_MS,
  PHOTOS_TOTAL_MAX_ENTRIES: PHOTOS_TOTAL_MAX_ENTRIES,
};
