'use strict';

var idListPredicate = require('./sql-id-list').idListPredicate;

/**
 * 「缩略图全量重跑」的**待办队列**：DDL、取批 SQL、游标语义 —— 全部收在这一个模块里。
 *
 * ## 为什么是一个「物化队列」，而不是一句带谓词的取批
 *
 * 目标规格（档位 / 编码格式）是**设置里的值**，随时会变。于是「哪些行需要重跑」= `thumb_size <> 目标
 * OR thumb_format <> 目标`，一条**完全无索引可依**的谓词。直接拿它做「倒序 + LIMIT」的取批，
 * 就是项目里已经踩过一次的那个坑（`getPhotosMissingThumbnailsBefore` 真库实测**每轮白扫 75.7 万行
 * = 159.6 s 主线程阻塞**，见 `docs/contracts/thumbnail-backfill.md`）：
 * 代价 = **游标到第一个命中行的距离**，而不是批大小；而且它在「尾巴」上最惨 ——
 * 全库只剩几百张待重跑时，每一批都要从高位扫到底才能凑够一批。
 *
 * 为什么不照抄那边的解法（给谓词建一条部分索引）：那边的谓词是**常量**
 * （`IFNULL(exif_ver,0) < N` 之类），可以烤进索引；这里的谓词里带着**运行期才定的目标值**，
 * 烤进去就意味着「用户每改一次档位，都得 DROP + CREATE 一条要穿 7.6 KB 溢出页链、
 * 真库三四分钟的索引」—— 比任务本身还贵。而且它还得动态生成 DDL，
 * `deferred-indexes.js` 那套「静态清单 + 回归能原样搬」的保障全失效。
 *
 * ⇒ 改成**一次登记、之后按主键倒序抽干**：
 *   ① 登记（enqueue）：把两侧规格与目标不符的行**一次性**放进 `thumb_regen_queue`（一张只有 id 的表）。
 *      代价是**一遍有界的区间扫描**（按 id 区间分块，块内代价 ∝ 块内行数，与目标值无关）；
 *   ② 抽干（drain）：`SELECT … FROM thumb_regen_queue WHERE id <= ? ORDER BY id DESC LIMIT ?`
 *      —— 队列是**小表**（主键索引），一个条目就是一次定位，**代价 ∝ 批大小**，
 *      尾巴上不再白扫；取完即 `DELETE WHERE id <= ?`。
 *
 * 顺带白拿的三样东西：
 *   · **进度分母是精确值**（登记时累加，不是抽样估计 ⇒ UI 不用写「约」）；
 *   · **可续跑**：队列在库里，进程被关掉再打开，剩下的行还在（`done/total` 也在 meta 行里）；
 *   · **取消 = 暂停**：已抽干的那部分不会重做，剩下的留在队列里。
 *
 * ## 两条必须守住的约定
 *
 * 🔴 **取批 SQL 里绝不能再出现规格谓词**。一旦有人「顺手」把它加回去，代价就从
 *    ∝ 批大小变成 ∝ 白扫距离 —— 静默地慢，慢在界面上（主进程卡死），而不是慢在日志里。
 *    `scripts/thumbnail-regen-regression.js` 断言这条语句的形态（无 residual 谓词 + 走主键倒序）。
 *
 * 🔴 **规格谓词只有一份**（下面的 `SPEC_MISMATCH_PRED`）。它同时被三处消费：
 *    登记 SQL、`database.js#countThumbnailsNeedingRegen()`、回归断言。
 *    各写一份的下场是「登记用的是新口径、计数用的是旧口径」——两个数谁也不等于谁，且都不报错。
 */

/** 待办队列表名（只有 id 一列：它是一张「还有哪些行没抽干」的清单，不复制任何别的字段）。 */
var QUEUE_TABLE = 'thumb_regen_queue';

/** 队列的元信息表名（单行，`k = 1`）。 */
var META_TABLE = 'thumb_regen_meta';

/**
 * 「两侧规格与目标不符」的谓词。**唯一真相源。**
 *
 * ⚠️ 两列都要判：档位不同（256 vs 512）与格式不同（jpeg vs webp）是**两件独立的事**，
 *    只判其中一个就会出现「换了档位，格式没换」这种半吊子状态。
 * ⚠️ 存量行的 `thumb_size = 0` / `thumb_format = ''` 天然命中本谓词（`0 <> 512`、`'' <> 'webp'`）
 *    —— 那正是「本列引入之前生成的老图」，必须重跑。**刻意不为它们特判**：
 *    加一条 `IS NULL OR = 0` 只会让谓词更长、更容易与别的副本漂开，结论一模一样。
 */
var SPEC_MISMATCH_PRED = 'thumb_size <> ? OR thumb_format <> ?';

/**
 * 登记一批：闭开区间 `(?, ?]`，**倒序区间**由调用方保证（与后台任务方向统一 = 主键倒序）。
 *
 * ⚠️ 三个绑定值的顺序 = `idFrom`、`idTo`、`目标档位`、`目标格式`。
 * ⚠️ `INSERT OR IGNORE`：队列的存在性判断由主键做，重复登记（续跑时区间重叠）不报错、不重复。
 * ⚠️ 判据用 `has_thumbnail = 1`（有无缩略图看这一列，见 `MEMORY.md` 的口径约定）：
 *    「没有缩略图」的行是**补全任务**的活，不该混进重跑（两边的准入本来就互斥，
 *    但混进来会让「重跑完成」的定义变成「连缺图的行也补上了」）。
 */
var ENQUEUE_SQL =
  'INSERT OR IGNORE INTO ' +
  QUEUE_TABLE +
  ' (id) SELECT id FROM photos ' +
  'WHERE id > ? AND id <= ? AND has_thumbnail = 1 AND (' +
  SPEC_MISMATCH_PRED +
  ')';

/**
 * 取一批待重跑的行。**倒序**，`LIMIT` 直接兜住代价。
 *
 * 🔴 这里**不许**有任何规格 / `has_thumbnail` 谓词（见文件头那条约定）：
 *    队列本身就是「筛选结果」，再筛一遍等于把已经付过的代价重付一次，
 *    而且会重新引入「距离」这个不可控量。
 * ⚠️ `LEFT JOIN` 而不是 `JOIN`：`photos` 里已经没有的行（扫描删过、库被外部改过）
 *    也必须被取出来 —— 否则它会**永久卡在队首**，队列永远抽不干，任务每轮从它开始。
 *    `p.*` 全为 NULL 的行由调用方按「文件已不在库」记账并删除。
 * ⚠️ `file_path` 之外只带抽干时才需要的列（不取 `thumbnail`：那是一列 7.6 KB 的 BLOB，
 *    取批阶段一个字节都不需要）。
 */
/**
 * 抽干一批：按主键倒序、**只认队列游标**（没有任何规格谓词）。
 *
 * 🔴 列清单里除了「重出缩略图必需的」三列（`file_path` / `file_size` / `date_modified`），
 *    还有**四个「这行还缺什么」的门要读的列**：`dhash` / `width` / `height` /
 *    `file_hash` / `exif_mtime` / `exif_ver`。
 *    2026-10-08 起这一趟会**顺手补齐**原图尺寸 / 拍摄参数 / dHash / 查重指纹（见
 *    `main.js#regenerateRowsWithConcurrency`），而这四个门就是「要不要补」的判据 ——
 *    **少取一列不是报错，是每行都白重算一遍**（`processOne` 里有同款注释）。
 *    ⚠️ 不会因此多读盘：`p` 那一侧本来就是 `SEARCH p USING INTEGER PRIMARY KEY` 回表，
 *       多取几个**小列**只是多解析几个字段；`thumbnail` 那个大 BLOB **没被选中**，
 *       溢出页不会被读。
 */
var FETCH_SQL =
  'SELECT q.id AS id, p.file_path AS file_path, p.file_size AS file_size, ' +
  'p.date_modified AS date_modified, p.has_thumbnail AS has_thumbnail, ' +
  'p.thumb_size AS thumb_size, p.thumb_format AS thumb_format, ' +
  'p.dhash AS dhash, p.width AS width, p.height AS height, ' +
  'p.file_hash AS file_hash, p.exif_mtime AS exif_mtime, p.exif_ver AS exif_ver ' +
  'FROM ' +
  QUEUE_TABLE +
  ' q LEFT JOIN photos p ON p.id = q.id ' +
  'WHERE q.id <= ? ORDER BY q.id DESC LIMIT ?';

/** 抽干一批之后删掉**这一批**（按 id 列表，见 `thumbRegenFinishBatch` 的注释）。 */
var DELETE_BATCH_SQL =
  'DELETE FROM ' + QUEUE_TABLE + ' WHERE ' + idListPredicate('id');

var COUNT_SQL = 'SELECT COUNT(*) AS n FROM ' + QUEUE_TABLE;

var CLEAR_SQL = 'DELETE FROM ' + QUEUE_TABLE;

/** 单行元信息：目标规格 + 阶段 + 游标 + 计数（`total/done` 都是**累计值**，不是本轮值）。 */
var DDL = [
  'CREATE TABLE IF NOT EXISTS ' + QUEUE_TABLE + ' (id INTEGER PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS ' +
    META_TABLE +
    ' (' +
    'k INTEGER PRIMARY KEY CHECK (k = 1), ' +
    "signature TEXT NOT NULL DEFAULT '', " +
    "phase TEXT NOT NULL DEFAULT '', " +
    'enqueueCursor INTEGER NOT NULL DEFAULT 0, ' +
    'targetSize INTEGER NOT NULL DEFAULT 0, ' +
    "targetFormat TEXT NOT NULL DEFAULT '', " +
    'total INTEGER NOT NULL DEFAULT 0, ' +
    'done INTEGER NOT NULL DEFAULT 0, ' +
    'failed INTEGER NOT NULL DEFAULT 0, ' +
    // 「队列里有、`photos` 里已经没有了」的张数。它**不计入 failed**：
    // 那批行不是「重生成失败」，而是库与队列不同步（扫描删过），混进 failed 会让用户去
    // 找一批并不存在的坏文件。
    'missing INTEGER NOT NULL DEFAULT 0, ' +
    'updatedAt INTEGER NOT NULL DEFAULT 0)',
];

/**
 * 阶段（存在 meta 行里，决定「下次进来该干什么」）：
 *   `''`          从未登记过（等价于「没有待办」）
 *   `'enqueueing'` 登记还没走完全库（`enqueueCursor` 之下的区间尚未扫过）
 *   `'draining'`  登记已完整，正在抽干
 *   `'done'`      队列已空（`total` 那一批全部处理完）
 *
 * ⚠️ **刻意没有「已取消」这一档**：用户按停止只是结束当前这一次运行，
 *    队列和游标原样留在库里，下次进来接着干就是。为「谁按过停止」单独记一档的代价是
 *    「用户想继续却被旧状态挡住」，而收益只是文案上少一个字。
 */
var PHASES = ['', 'enqueueing', 'draining', 'done'];

/**
 * 目标规格的**身份串**。设置一变（档位 512 → 320，或将来换编码格式），旧队列立刻作废。
 *
 * ⚠️ **不含画质**：画质只影响字节，不影响「这一行符不符合目标」的判据（我们只记 `size` + `format`）。
 *    把它算进来会让「改画质」把整条队列判废、从头再登记一遍 —— 代价是一遍全库扫描，
 *    而实际要做的活一模一样（同样的行、同样的重编码）。
 */
function targetSignature(size, format) {
  return String(parseInt(size, 10) || 0) + '|' + String(format || '');
}

/**
 * 这条队列能不能接着用？不能就得先清空、重新登记。
 *
 * 🔴 判据是**身份串相等**，不是「队列非空」。后者会让「换了档位」沿着旧队列继续跑，
 *    跑完一看规格还是旧的 —— 用户看到的是「重建完了但还是糊的」，没有任何报错。
 */
function isQueueReusable(meta, signature) {
  if (!meta) return false;
  if (String(meta.signature || '') !== String(signature || '')) return false;
  return PHASES.indexOf(String(meta.phase || '')) >= 0;
}

module.exports = {
  QUEUE_TABLE: QUEUE_TABLE,
  META_TABLE: META_TABLE,
  SPEC_MISMATCH_PRED: SPEC_MISMATCH_PRED,
  ENQUEUE_SQL: ENQUEUE_SQL,
  FETCH_SQL: FETCH_SQL,
  DELETE_BATCH_SQL: DELETE_BATCH_SQL,
  COUNT_SQL: COUNT_SQL,
  CLEAR_SQL: CLEAR_SQL,
  DDL: DDL,
  PHASES: PHASES,
  targetSignature: targetSignature,
  isQueueReusable: isQueueReusable,
};
