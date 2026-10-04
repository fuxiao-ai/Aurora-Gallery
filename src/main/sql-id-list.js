'use strict';

/**
 * 把「个数不定的 id 列表」安全地传给 SQLite。
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────
 * SQLite 对**单条语句**的宿主参数（`?`）个数有硬上限 `SQLITE_MAX_VARIABLE_NUMBER`。
 * 本项目随 better-sqlite3 12.9 打包的是 SQLite 3.53.0，实测：
 *   32766 个 `?` → 通过；32767 个 → 立刻抛 `SqliteError: too many SQL variables`。
 * （SQLite < 3.32 时这个上限只有 **999**，所以别把它当历史故事 —— 换 SQLite 版本后要重新量。）
 *
 * 曾经的写法是把 id 全部展开成 `WHERE id IN (?,?,...,?)`，于是「查找相似照片」在真实
 * 量级下**必然**失败，而不是偶发：
 *
 *   本机真库 1224615 张照片，其中 238936 张有 dHash；LSH 是 16 个 band × 4 bit，
 *   全库只有 256 个桶、平均每桶约 1.5 万张。任何一张照片的 16 个桶并起来就有十几万
 *   候选（实测最坏 179169 个）——**随机抽样 40 张，100% 超过 32766**。
 *   也就是说这条 LSH 索引在本库规模下几乎不做剪枝，候选集恒等于「全库有 dHash 的
 *   照片的一大半」。
 *
 * ── 修法 ──────────────────────────────────────────────────────────────
 * 改用 SQLite 内置的 JSON1 表值函数 `json_each`，**整个列表作为唯一一个参数**传进去，
 * 变量个数恒为 1，结构上不可能超限。
 *
 * 为什么不用「分块 IN」（每块 3 万个 `?`）——两种都试过，同一张最坏照片实测：
 *   分块 IN   2436ms（还要把约 1.2MB 的 `?,?,...` 拼进 SQL 文本）
 *   json_each 2032ms（JSON.stringify 179169 个 id 只用 5ms）
 * 结果集逐字节一致。json_each 更快、代码更少（没有循环、没有分块边界），故选它。
 *
 * ⚠️ 依赖 JSON1。SQLite 3.38（2022）起 JSON 函数是**核心功能**、编译期无法关闭，
 * 本项目打包的 3.53.0 自带。`scripts/sql-id-list-regression.js` 会显式断言
 * `json_each` 可用 —— 换 SQLite 版本时会在测试里炸出来，而不是在用户手里。
 */

/** 单条语句的宿主参数上限（本机 SQLite 3.53.0 实测值，不是猜的）。 */
const SQLITE_MAX_VARIABLES = 32766;

/**
 * 生成「按 id 列表过滤」的谓词，`?` 处绑 `toIdListJson(values)` 的结果。
 * @param {string} column 列名，如 `'id'` 或 `'photo_id'`
 */
function idListPredicate(column) {
  return String(column) + ' IN (SELECT value FROM json_each(?))';
}

/**
 * 把 id 数组转成可绑到 {@link idListPredicate} 那个 `?` 上的 JSON 字符串。
 *
 * 会顺手清洗：只保留有限的正整数（小数取整）。这样即使上游（例如渲染进程传来的数组）
 * 混进字符串、`NaN`、负数，也只是少几行结果，不会把整条语句变成语法错误。
 * 用 `Math.trunc` 而不是原样保留小数，是因为 `photos.id` 是 INTEGER 列 —— 传 `3.7`
 * 进去在 SQLite 里是 REAL，和 INTEGER 的 3 比不相等，会静默查空。
 *
 * @param {Array<number|string>} values
 * @returns {string} 形如 `[1,2,3]`
 */
function toIdListJson(values) {
  if (!Array.isArray(values) || values.length === 0) return '[]';
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var id = Math.trunc(Number(values[i]));
    if (Number.isFinite(id) && id > 0) out.push(id);
  }
  return JSON.stringify(out);
}

module.exports = {
  SQLITE_MAX_VARIABLES,
  idListPredicate,
  toIdListJson,
};
