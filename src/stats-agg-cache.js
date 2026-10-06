'use strict';

/**
 * `getStats()`（顶栏统计条）的记忆化。
 *
 * ## 为什么需要
 *
 * `runGetStatsAgg()`（`db-heavy-read.js`）是 **8 条子查询 + faces 两条**，每条都是
 * 「沿某条索引把 165 万条目走一遍」。真库（1,656,580 行 / 14 GB）实测拆开：
 *
 *   | 子查询 | 冷 | 计划 |
 *   |---|---:|---|
 *   | `COUNT(*)` | 341 ms | `SCAN … COVERING INDEX idx_photos_hasThumb` |
 *   | `SUM(file_size)` | 1,429 ms | `SCAN … COVERING INDEX idx_photos_size` |
 *   | **`COUNT(DISTINCT folder_path)`** | **4,488 ms** | `SCAN … COVERING INDEX idx_photos_folder` |
 *   | 视频张数 | 1,460 ms | `SCAN … COVERING INDEX idx_photos_type` |
 *   | 视频体积 | 1,875 ms | `SCAN … INDEX idx_photos_agg_root_folder_video`（要回表 26,609 行） |
 *   | 收藏 / MIN / MAX | <2 ms | 走覆盖索引 |
 *   | faces 两条 | 99 / 90 ms | 覆盖索引 |
 *   | **整条（首次）** | **8,616 ms** | |
 *   | **整条（热）** | **949 ms** | |
 *
 * **没有一条是「算错」，全是「沿索引全走一遍」** —— 这个量级的代价付一次可以，
 * 而它的调用点有 11+ 处（启动 / 扫描收尾 / 回收站 / 维护 / 手动清理…），
 * 且同一批动作里往往连着调好几次，每次都要重算同一个数。
 *
 * ## 与 `photos-total-cache.js` 的关系
 *
 * **刻意不合并**：那份的键是「`getPhotos` 的 whereClause + 参数」，取值域是「几十种筛选组合」；
 * 这份**没有参数**（`runGetStatsAgg(db)`），全库只有一个数。强行共用一套会为了一个键
 * 把两份语义不同的东西绑在一起。两边的 **TTL / 失效点 / 住在 worker 里** 这三条是一致的。
 *
 * ## 键为什么还是留了一个参数
 *
 * 当前只有一个恒定键。留参数是为了**将来加筛选**（比如「按根统计」）时不必改调用方 ——
 * 而键始终取「语句本身」这条不变量不能破：键按字段白名单手搓，漏一个字段就会
 * **静默返回别人的统计**，不报错、不写日志。
 *
 * ## 失效：TTL 有界 + 显式清空，两条缺一不可
 *
 * ① **TTL = 5 s**：最坏情况陈旧度上界，覆盖所有「数据变了但调用方没清缓存」的路径
 * （含将来新加的）。5 s 与 `photos-total-cache.js` / `main.js#THUMB_TOTAL_REFRESH_MS`
 * 同值 —— 全工程「派生计数有多新」就一个数字要记。
 * ② **主进程显式清空**：`dbReadWorkerPool.invalidateReadCaches()` → worker 收到
 * `{ op: '__cache_reset' }` 就清空。挂在既有的目录缓存失效点上（扫描收尾 / 移入回收站 /
 * 删除记录 / 移除目录）+ 收藏切换 + 失效记录清理，共 6 处。
 *
 * 🔴 **为什么不做「数据版本号」**：那要求把「哪次写改了统计」表达成一个可比较的版本，
 * 而写路径分散（扫描批内 INSERT、失效清理 DELETE、级联删除…），只要有**一处**忘了 bump，
 * 缓存就会一直返回旧值直到 TTL 兜底 —— 版本号并没有真的消掉 TTL，只是多了一份
 * 「可能忘」的清单。反过来隐性失效必须**有界**，所以 TTL 是硬的、不可省的。
 *
 * 🔴 **不许把这份缓存用于任何正确性判定**（只喂顶栏那几个展示数字）。
 * 它是**有界陈旧**的显示量：删掉一个根目录后最坏 5 s 内「目录数」还是旧的。
 *
 * ## 为什么住在 worker 进程里
 *
 * `getStats` 只在读池 worker 里执行（`database.js#getStats` 只被 `db-read-worker.js`
 * 经原型借用调用），所以这份缓存**天然同时覆盖桌面端与网页端**，且不需要任何 IPC 改动。
 * 池里 3 个 worker = 最多 3 份各自独立的缓存；同一批连续调用总落在同一个空闲槽上，
 * 命中率不受影响。
 */

/** 最坏情况陈旧度上界；与 `photos-total-cache.js` / `main.js#THUMB_TOTAL_REFRESH_MS` 同值。 */
var STATS_AGG_TTL_MS = 5000;
/**
 * 条目上限。当前**只有一个键**（`runGetStatsAgg` 无参数），这个上限纯属防御 ——
 * 将来加了按根统计之类也远够用。
 */
var STATS_AGG_MAX_ENTRIES = 16;

/** @type {Map<string, {value: object, at: number}>} */
var entries = new Map();
var hits = 0;
var misses = 0;

/**
 * @param {string} [key]
 * @returns {string}
 */
function keyOf(key) {
  return String(key || 'all');
}

/**
 * @param {string} [key]
 * @param {number} [nowMs]
 * @returns {object|null} 命中返回**浅拷贝**（见下），未命中 / 已过期返回 null
 */
function get(key, nowMs) {
  var k = keyOf(key);
  var entry = entries.get(k);
  if (!entry) {
    misses++;
    return null;
  }
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (now - entry.at >= STATS_AGG_TTL_MS) {
    entries.delete(k);
    misses++;
    return null;
  }
  hits++;
  // 🔴 返回**浅拷贝**而不是缓存里那个对象：调用方（`database.js#getStats`）目前只是转发，
  //    但缓存对象一旦被谁就地改了一个字段，之后所有命中都会拿到被改过的值 —— 不报错、
  //    只有一次改动却污染全进程。11 个字段的浅拷贝成本可以忽略，换掉一整类隐患。
  return Object.assign({}, entry.value);
}

/**
 * @param {string} [key]
 * @param {object} value
 * @param {number} [nowMs]
 */
function set(key, value, nowMs) {
  if (!value || typeof value !== 'object') return;
  var k = keyOf(key);
  // 先删再插：让这个键移到 Map 末尾（最旧淘汰才不会误伤刚写过的条目）。
  entries.delete(k);
  entries.set(k, { value: value, at: typeof nowMs === 'number' ? nowMs : Date.now() });
  while (entries.size > STATS_AGG_MAX_ENTRIES) {
    var oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** 显式清空：主进程在「数据变了」的动作之后经 `dbReadWorkerPool.invalidateReadCaches()` 调用。 */
function invalidateAll() {
  entries.clear();
}

/** 诊断 / 回归用。**不是**给业务逻辑读的状态。 */
function stats() {
  return {
    size: entries.size,
    hits: hits,
    misses: misses,
    ttlMs: STATS_AGG_TTL_MS,
    maxEntries: STATS_AGG_MAX_ENTRIES,
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
  STATS_AGG_TTL_MS: STATS_AGG_TTL_MS,
  STATS_AGG_MAX_ENTRIES: STATS_AGG_MAX_ENTRIES,
};
