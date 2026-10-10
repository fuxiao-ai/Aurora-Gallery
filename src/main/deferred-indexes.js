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
 * ⚠️ 2026-10-07 起这里**不再只服务前台只读查询**：⑦ 那条服务的是「补全任务的第二趟取批」。
 *    留在本清单而不是 worker 里，理由不变 —— 这里的 DDL 是**完整、可直接 exec** 的字符串，
 *    回归能原样搬到夹具上验证（部分索引的 `WHERE` 是拼出来的，别处抄不了）。
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
  // ⑥ 「排除 Live Photo 伴生视频」（2026-10-06）。
  //    `all` 档要排掉伴生 MOV，而 `live_still_id` 在 `photos` 里排在缩略图 BLOB **之后**
  //    且没有任何独立索引 ⇒ 一句 `COALESCE(live_still_id, 0) = 0` 就把
  //    `SCAN photos USING COVERING INDEX idx_photos_hasThumb` 打成**逐行回表**：
  //    真库（1,656,580 行 / dpr 1）实测 **478 ms → 105,954 ms**（慢 221 倍），
  //    而结果**只排掉 1 行** ⇒ 前端等不到就超时，「所有文件」直接显示「图片加载失败」。
  //
  //    这条部分索引让改写后的子查询 `WHERE live_still_id > 0` 落到 **1 个条目**上，
  //    外层 `id NOT IN (…)` 就能重新拿回覆盖扫描（`db-heavy-read#liveCompanionExcludeCondition`）。
  //
  //    ⚠️ **索引名写成字面量、谓词从 `heavy` 取**（与 ③ 完全同一种写法）：
  //       谓词必须逐字一致（SQLite 部分索引匹配是逐字的，差一个字符就静默失效、不报错），
  //       所以它只能有一份；而**名字**写成字面量是为了让
  //       `scripts/maintenance-regression.js` 的「延迟索引不许出现在启动路径」白名单
  //       能用一条源码正则看到它（拼接出来的名字那条第款就看不见了）。
  //       两边是否仍一致由 `scripts/read-latency-regression.js` 断言。
  //    ⚠️ 形态刻意是 `ON photos(id)`，**不是** `ON photos(live_still_id)`：外层只消费子查询
  //       吐出的 id 集合、从不读 live_still_id ⇒ 只要 id 一列就够，而且写成单列 id 后
  //       子查询被这条索引**完全覆盖**（真库上条目数 1、整条索引 1 页）。
  //    ⚠️ 它也**不需要** `INDEXED BY` hint：`NOT IN` 的子查询是唯一能命中它的形状，
  //       实测规划器会自己选（计划里出现 `LIST SUBQUERY` + 走这条索引 + `CREATE BLOOM FILTER`）。
  {
    name: 'idx_photos_live_companion',
    sql:
      'CREATE INDEX IF NOT EXISTS idx_photos_live_companion ON photos(id) WHERE ' +
      heavy.LIVE_COMPANION_PRED,
  },
  // ⑦ 「缩略图补全第二趟取批」的候选索引（2026-10-07 加）。
  //
  //    `getPhotosMissingThumbnailsBefore()` 是全工程**唯一一条「谓词完全无索引可依 + 倒序 LIMIT」**
  //    的取批 ⇒ 计划恒为 `SEARCH photos USING INTEGER PRIMARY KEY (rowid<?)`，代价 = 游标到
  //    第一个命中行的**距离**，而不是批大小。真库（1,656,580 行）实测：id 1,181,504 以上共
  //    **80 万行「候选 = 0」**（早就补完了），而第二趟每轮都从 `MAX(id)+1` 起手 ⇒
  //    **每轮白扫 75.7 万行回表 = 159,601 ms**，跑在主进程 ⇒ `eventLoop.maxDelayMs = 159699`、
  //    界面整整卡死两分半。对照第一趟走 `idx_photos_hasThumb` = **8 ms**。
  //
  //    ⚠️ 「每轮」而不是「一次」：候选上界随补全推进**逐轮下移** ⇒ 白扫只会越来越长。
  //
  //    形态刻意是 `ON photos(id) WHERE <核心谓词>`（与 `idx_photos_missing_thumb` /
  //    `idx_photos_dhash_pending` 同一种写法）：倒序扫这条**部分**索引时，收敛区里它**一个条目都没有**
  //    ⇒ 零回表、凑满即停。⚠️ 只建索引不够：还得让取批 SQL 里带一个**与这个 WHERE 逐字相同**的
  //    冗余合取项（见 `db-heavy-read#BACKFILL_PENDING_CORE_PRED` 的注释），否则规划器证不出蕴含、
  //    计划照旧不动（夹具实测过）。
  //
  //    ⚠️ 谓词**从 `heavy` 取、名字写成字面量**（与 ③⑥ 同一种写法）：谓词必须逐字一致，
  //    所以只能有一份；而**名字**是字面量才能让 `scripts/maintenance-regression.js` 的
  //    「延迟索引不许出现在启动路径」白名单用一条源码正则看到它。
  //    两边是否仍一致由 `scripts/thumb-backfill-metadata-fetch-regression.js` 断言。
  //
  //    ⚠️ `rebuildOnChange: true` —— 这条 DDL 里烤了 `EXIF_SCHEMA_VERSION`
  //    （`IFNULL(exif_ver, 0) < N`），**升版后必须重建**，否则「查询要 `< N+1`、索引 WHERE 还是 `< N`」
  //    蕴含证不出来 ⇒ 第二趟**静默**退回全表扫（不报错、不写日志，只是界面又卡两分半）。
  //    `deferred-index-worker.js` 会比对 `sqlite_master.sql` 与期望 DDL，不同就 DROP + CREATE。
  //    这是本工程第一条**会随版本变化**的索引 DDL，所以只有它带这个标记。
  //
  //    ⚠️ 建索引的代价：核心谓词引用的四列 `has_thumbnail`(cid 12) / `dhash`(29) /
  //    `exif_mtime`(34) / `exif_ver`(36) **全在 `thumbnail`（cid 11）之后** ⇒ 每行都要穿
  //    7.6 KB 的溢出页链。真库整表回表实测 ~250 s ⇒ 本条约 **3~5 分钟**，且会长时间独占写库闸门
  //    ⇒ **只许 deferred worker 建，绝不许进启动路径**。
  {
    name: 'idx_photos_backfill_pending',
    rebuildOnChange: true,
    sql:
      'CREATE INDEX IF NOT EXISTS idx_photos_backfill_pending ON photos(id) WHERE ' +
      heavy.BACKFILL_PENDING_CORE_PRED,
  },
  // ⑧ 组织元数据：评分（rating，0-5）筛选维度（2026-10-09 加）。
  //
  //    ⚠️ 与 ③⑥⑦ 不同，这两条的谓词**没有**「逐字一致」的约束 —— 用的是普通索引，
  //    不涉及部分索引的 WHERE 匹配，所以不需要从 `heavy` 取谓词、也不写 INDEXED BY hint。
  //
  //    ⚠️ 形态刻意是**普通索引**而不是部分索引（`WHERE rating > 0` 之类）：
  //    冲片工作流里「还剩哪些没评分」（rating = 0）是常查的一档，部分索引恰好把它
  //    排除在外 ⇒ 那条查询反而退回全表扫。flag 那条同理（要能查 flag = 'none'）。
  //
  //    ⚠️ 必须在延迟侧建、不许出现在启动路径：`rating` / `flag` 是 2026-10-09 后加的列，
  //    cid 排在 `thumbnail`（内联 BLOB）之后 ⇒ 建索引要整表回扫，真库（1,656,580 行）
  //    上是几十秒到几分钟量级，且会长时间独占写库闸门。
  //    ⇒ `database.js#ensurePhotosOrgMetaColumns()` 只做 O(1) 的 ADD COLUMN，
  //      里面有断言保证不出现任何 CREATE INDEX。
  {
    name: 'idx_photos_rating',
    sql: 'CREATE INDEX IF NOT EXISTS idx_photos_rating ON photos(rating)',
  },
  // ⑨ 组织元数据：标记（flag，none/pick/reject）筛选维度（2026-10-09 加）。
  {
    name: 'idx_photos_flag',
    sql: 'CREATE INDEX IF NOT EXISTS idx_photos_flag ON photos(flag)',
  },
];

module.exports = {
  PHASE5_INDEXES: PHASE5_INDEXES,
  VIDEO_TYPE_PRED: VIDEO_TYPE_PRED,
  IMAGE_TYPE_PRED: IMAGE_TYPE_PRED,
};
