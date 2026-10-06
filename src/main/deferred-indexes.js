'use strict';

/**
 * 「延迟索引」清单 —— 前台只读大查询缺的那批索引的**唯一真相源**（Phase 5）。
 *
 * ## 为什么单独抽一个模块（而不是留在 worker 里）
 *
 * `scripts/read-latency-regression.js` 要做两件事，两件都要求能拿到**完整 DDL**：
 *   ① 在夹具上照着 DDL 建索引，断言执行计划真的翻转（比如 `USE TEMP B-TREE FOR ORDER BY`
 *      消失、`USING INDEX` 变 `USING COVERING INDEX`）；
 *   ② 断言这些索引**没把别的查询带偏**（规划器多了候选，代价模型就可能挑错）。
 *
 * 而部分索引的 DDL 是**拼接**出来的（`... WHERE (file_hash IS NOT NULL AND TRIM(file_hash) != '') AND (...)`
 * 里嵌着视频档谓词），回归脚本没法从 worker 源码里用正则把 `WHERE` 整段提出来 ——
 * 提不到就只能「在回归里手抄一份等价 DDL」，那等于把同一件事写两遍，
 * 而 SQLite 的部分索引匹配又是**逐字**的（差一个字符索引就用不上，且不报错）。
 *
 * ⇒ 抽到这里：worker 与回归**同一份字符串**，没有「抄错」的可能。
 *
 * ## 视频档谓词的来源
 *
 * 从 `db-heavy-read.js` 取，**本文件不自己写后缀清单**。原因同上：谓词要逐字一致，
 * 而它同时被统计子查询、部分索引、`database.js#_sqlFileTypeIsImageExpr()` 消费。
 */

var heavy = require('../db-heavy-read');

/** 视频档谓词（`... IN (...)`），与 `db-heavy-read#VIDEO_TYPE_PRED` 同一份。 */
var VIDEO_TYPE_PRED = heavy.VIDEO_TYPE_PRED;
/** 图片档谓词（`... NOT IN (...)`），与 `db-heavy-read#IMAGE_TYPE_PRED` 同一份。 */
var IMAGE_TYPE_PRED = heavy.IMAGE_TYPE_PRED;

/**
 * Phase 5：前台只读大查询的第二批索引（2026-10-06 加）。
 *
 * 每一条的「真库实测慢成什么样」「夹具上补索引后计划怎么变」「为什么形态是这样」
 * 都写在 `src/workers/deferred-index-worker.js` 里 Phase 5 那段注释中（那里是决策记录），
 * 这里只留**可执行的定义**。
 *
 * 🔴 `sql` 必须是**完整、可直接 `db.exec()`** 的语句，且带 `IF NOT EXISTS`：
 *    - 完整 ⇒ 回归能原样搬到夹具上（部分索引的 `WHERE` 不能是运行时拼出来的）；
 *    - `IF NOT EXISTS` ⇒ 只在第一次真正建，之后每次启动都是空操作。
 *
 * ⚠️ **新增索引一律加到这里**，不要在 worker 里另起一段 —— 否则它就不在回归的覆盖范围内，
 *    而「没被回归覆盖的索引」正是本文件开头说的那种「抄错也发现不了」的状态。
 */
var PHASE5_INDEXES = [
  // ① 按根浏览 + 按文件名排序。五个排序键里只有 file_name / file_size 没有索引
  //    ⇒ 退化成 idx_photos_root + USE TEMP B-TREE FOR ORDER BY（真库实测 39,990 ms）。
  {
    name: 'idx_photos_root_name',
    sql: 'CREATE INDEX IF NOT EXISTS idx_photos_root_name ON photos(root_id, file_name)',
  },
  // ② 同上，另一条排序键。
  {
    name: 'idx_photos_root_size',
    sql: 'CREATE INDEX IF NOT EXISTS idx_photos_root_size ON photos(root_id, file_size)',
  },
  // ③ 查重：现状走 idx_photos_file_hash(file_hash)，但查询还要 file_size（求和）与
  //    file_type（谓词），两列都不在索引里 ⇒ 165 万次回表（每行带 7,614 字节内联 BLOB）。
  //    真库实测 174,281 ms，而结果只有 1 个重复组。
  //    ⚠️ 谓词与 `db-heavy-read.js#sqlHasFileHashExpr` + `sqlDupImageTypeExpr` 逐字相同。
  //    ⚠️ 与既有 `idx_photos_dup_hash_pending ((id) + 互补谓词)` 正好成对。
  {
    name: 'idx_photos_dup_hash_full',
    sql:
      'CREATE INDEX IF NOT EXISTS idx_photos_dup_hash_full ON photos(file_hash, file_size) WHERE ' +
      "(file_hash IS NOT NULL AND TRIM(file_hash) != '') AND (" +
      IMAGE_TYPE_PRED +
      ')',
  },
  // ④ 日期视图（全库）：`GROUP BY date(date_taken)` 是表达式分组，索引序对不上 ⇒
  //    原先只能 USE TEMP B-TREE FOR GROUP BY（真库实测全库 3,086.9 ms / 热 512.4 ms）。
  {
    name: 'idx_photos_date_day',
    sql: 'CREATE INDEX IF NOT EXISTS idx_photos_date_day ON photos(date(date_taken), date_taken)',
  },
  // ⑤ 日期视图（单根）。**形态与 ④ 刻意不同、不能互相顶替** —— 夹具上逐个试过五种 DDL
  //    （300,000 行、每行 7,600 字节 BLOB，复刻真库溢出页链）：
  //      · 裸 date(date_taken) 反而更慢（91.9 → 1,355 ms，因为 `WHERE date_taken IS NOT NULL`
  //        没有索引可依 ⇒ 每行回表）；
  //      · ④ 那种两列形态：全库 18.9 ms COVERING ✅ / 单根 475.6 ms；
  //      · 本条：单根 26.5 ms ✅。
  {
    name: 'idx_photos_root_date_day',
    sql:
      'CREATE INDEX IF NOT EXISTS idx_photos_root_date_day ON photos(root_id, date(date_taken))' +
      ' WHERE date_taken IS NOT NULL',
  },
];

module.exports = {
  PHASE5_INDEXES: PHASE5_INDEXES,
  VIDEO_TYPE_PRED: VIDEO_TYPE_PRED,
  IMAGE_TYPE_PRED: IMAGE_TYPE_PRED,
};
