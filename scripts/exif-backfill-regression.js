'use strict';
/**
 * 拍摄参数（EXIF）回填回归：`photos` 的 9 个拍摄参数字段 + `exif_mtime` 标记列。
 *
 * 背景（2026-10-06）：真实库 166 万行里 `camera_make` 非空的**一条都没有**。不是「没有带 EXIF
 * 的照片」，而是**两段链路都不产**：`scanner.js#GENERATE_THUMBNAILS_DURING_SCAN = false`
 * 让扫描期整块跳过元数据提取（EXIF 解析就写在那个 `if` 里面），而缩略图补全虽然把每个文件都
 * 用 sharp 打开过，却只读尺寸与 dHash。于是信息面板的「拍摄参数 / 设备 / 位置」三组恒空。
 *
 * 本轮让补全任务在**同一次** `sharp.metadata()` 里顺手解析 EXIF（零额外磁盘 I/O），
 * 顺带修掉旧解析代码里三处静默取错（都被 `catch` 吞掉、不报任何错）：
 *   · 只翻 `exif.Photo` —— 而 `Make`/`Model` 在 IFD0（`Image`）、GPS 在 `GPSInfo`
 *     ⇒ 品牌、型号、定位**永远**取空；
 *   · `DateTimeOriginal` 被 `exif-reader` 转成 `Date` 后又用 `String()` 拼成
 *     `Wed Oct 06 2026 11:22:33 GMT+0800 (...)` 落库；
 *   · GPS 是 `[度, 分, 秒]` 数组，**绑不进 SQLite**（抛错 → 整段 EXIF 一起丢）。
 *
 * 🔴 本脚本钉住的四条静默失效：
 *   1. 「已检查」被误判成「有没有值」（`camera_make IS NULL`）⇒ 截图 / 网图 / PNG
 *      **永远**留在候选集里：每轮被取出来、读完文件头、写回一堆 null，任务永不收敛。
 *   2. 标记列的迁移时机：它被**随时可调**的只读谓词引用，必须 `init()` 同步加；
 *      等到任务开跑才迁移 ⇒ 老库启动后第一次点开就 `no such column`。
 *   3. 扫描侧「文件内容变了」的置空清单漏了 EXIF 组 ⇒ 换过的文件还挂着旧相机的型号。
 *   4. 扫描期与补全任务各写一份解析 ⇒ 同一张照片「扫描时没有、补全后有」的字段时有时无。
 *      本脚本因此要求两处 `require('./main/exif-meta')`，且各自都不许直接 require exif-reader。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXIF_MOD = 'src/main/exif-meta.js';
const MAIN = 'src/main.js';
const DB = 'src/database.js';
const SCANNER = 'src/scanner.js';
const RUN_REGRESSIONS = 'scripts/run-regressions.js';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

const exifSrc = read(EXIF_MOD);
const mainSrc = read(MAIN);
const dbSrc = read(DB);
const scannerSrc = read(SCANNER);
const runSrc = read(RUN_REGRESSIONS);

// =========================================================== 1. 解析必须只有一份

check(
  '🔴 扫描期与补全任务共用同一个解析模块（否则字段会「扫码时有、补全后没有」）',
  scannerSrc.includes("require('./main/exif-meta')") && mainSrc.includes("require('./main/exif-meta')"),
);
check(
  '🔴 两处都不许自己 require exif-reader（各写一份 = 一定漂移）',
  !scannerSrc.includes("require('exif-reader')") && !mainSrc.includes("require('exif-reader')"),
);
check(
  '旧的 parseExifDate 私有实现不得再现（零调用点的方法留着就是旧方向的活标本）',
  !scannerSrc.includes('Scanner.prototype.parseExifDate') && !scannerSrc.includes('.parseExifDate('),
);
check(
  '🔴 解析必须按 IFD 归属取值：IFD0 的 Image + Exif 子 IFD 的 Photo + GPSInfo 一个都不能少',
  exifSrc.includes('exif.Image') && exifSrc.includes('exif.Photo') && exifSrc.includes('exif.GPSInfo'),
  '只翻 Photo 就是旧 bug：Make/Model/GPS 永远取空',
);
check(
  '🔴 三处归一化必须在（日期→日期串、GPS 数组→十进制度、非 ASCII 的 Buffer→字符串）',
  exifSrc.includes('function formatExifDate') &&
    exifSrc.includes('function toDecimalDegrees') &&
    exifSrc.includes('Buffer.isBuffer(value)'),
);
check(
  '🔴 extractExifFields 声明了「绝不抛」的契约（没有 EXIF 是常态，必须能照常写标记）',
  /function extractExifFields\(/.test(exifSrc) && /catch \(e\) \{[\s\S]{0,80}return out;/.test(exifSrc),
);

// =========================================================== 2. 标记列与谓词

const needExifBody = bodyOf(dbSrc, '_sqlNeedsExifExpr() {');
check('夹具自证：取到了 _sqlNeedsExifExpr 的函数体', needExifBody.length > 0);
check(
  '🔴 判据只看标记列 exif_mtime IS NULL（不是 camera_make IS NULL）',
  needExifBody.includes('exif_mtime IS NULL') && !needExifBody.includes('camera_make'),
);
check(
  '🔴 候选判据带版本号（只判 exif_mtime 的话，扩一次字段就让跑过的行永久缺新列）',
  needExifBody.includes('exif_ver') && needExifBody.includes('EXIF_SCHEMA_VERSION'),
  needExifBody.replace(/\s+/g, ' ').trim(),
);

// 🔴 「谓词说该补 / 处理说不用补」的漂移守卫 —— 两处必须判**同一组列**。
//    原委（2026-10-06 真机）：候选谓词加上版本判据后，`processOne` 的 needExif 仍只判
//    `exif_mtime`。于是旧口径跑过的行**每轮被取出来**（谓词说该补）、
//    **每轮被判「不需要读」而跳过**（processOne 说不用补）、原样写回 ⇒
//    新扩出来的列永远补不上，候选集也永不收敛。真库实测 9,799 行正落在这条死路上，
//    `exif_ver` 一行未写、而它们整段命中候选谓词。
//    ⇒ 判据只留一份：`photoNeedsExif()` 是 `_sqlNeedsExifExpr()` 的 JS 孪生。
const sqlExprCols = (needExifBody.match(/\b(exif_mtime|exif_ver)\b/g) || []).filter(
  (v, i, a) => a.indexOf(v) === i,
);
const twinBody = bodyOf(dbSrc, 'photoNeedsExif(row) {');
check('夹具自证：取到了 photoNeedsExif 的函数体', twinBody.length > 0);
check(
  '🔴 photoNeedsExif 是 _sqlNeedsExifExpr 的 JS 孪生：SQL 里判的每一列它都要判',
  sqlExprCols.length > 0 && sqlExprCols.every((c) => twinBody.includes(c)),
  'SQL 判的列 = ' + sqlExprCols.join('+') + '；孪生体命中 = ' + sqlExprCols.filter((c) => twinBody.includes(c)).join('+'),
);
check(
  '🔴 孪生体也认版本常量（把 2 写死会在下次 bump 时静默失效）',
  twinBody.includes('EXIF_SCHEMA_VERSION'),
);
check(
  '🔴 孪生体把「空串 / 空白标记」也算成没看过（SQL 侧 IS NULL 不取这类行 ⇒ 这里保守多读一次文件头，方向安全）',
  /String\(seenAt\)\.trim\(\) === ''/.test(twinBody),
  twinBody.replace(/\s+/g, ' ').trim(),
);

const predBody = bodyOf(dbSrc, '_sqlBackfillPendingExpr() {');
check('夹具自证：取到了 _sqlBackfillPendingExpr 的函数体', predBody.length > 0);
check(
  '🔴 待补谓词引用了 exif 支（且走的是标记列判据那一份，不是内联重写）',
  predBody.includes('_sqlNeedsExifExpr()'),
);
check(
  '🔴 「没看过 EXIF」被 is_image 门住（视频没有 EXIF，否则又是一类永不收敛的死行）',
  predBody.indexOf('_sqlNeedsExifExpr()') > predBody.indexOf('_sqlFileTypeIsImageExpr()'),
);

const pickBody = bodyOf(dbSrc, 'getPhotosMissingThumbnailsBefore(beforeId, limit) {');
check('夹具自证：取到了候选查询的函数体', pickBody.length > 0);
const pickCols = pickBody.split('FROM')[0];
check(
  '🔴 候选 SELECT 必须带 exif_mtime（少了它每行都判成「没看过」⇒ 对全库白写一遍）',
  /(^|[,\s])exif_mtime(\s|,|$)/m.test(pickCols),
);
check(
  '🔴 候选 SELECT 必须带 exif_ver（少了它 photoNeedsExif 判不出「旧版看过」⇒ 旧行永远补不上）',
  /(^|[,\s])exif_ver(\s|,|$)/m.test(pickCols),
);

// 迁移时机：必须落在 init() 里同步执行
const initBody = bodyOf(dbSrc, 'init() {');
check('夹具自证：取到了 init() 的函数体', initBody.length > 0);
check(
  '🔴 exif_mtime 的迁移在 init() 里同步跑（它被随时可调的只读谓词引用，不能等任务开跑）',
  initBody.includes('this.ensurePhotosExifColumn()'),
);
check(
  '🔴 该列也进了核心 schema（新库一开始就有，不必靠迁移）',
  /exif_mtime\s+TEXT/.test(dbSrc.split('createCoreSchema()')[1] || ''),
);

// 扫描侧：内容变更要把 EXIF 组连同标记一起置空
const invalidated = bodyOf(dbSrc, 'var SCAN_INVALIDATED_ON_CONTENT_CHANGE = [');
check('夹具自证：取到了 SCAN_INVALIDATED_ON_CONTENT_CHANGE', invalidated.length > 0);
check(
  '🔴 文件内容变了要清掉 exif_mtime（否则换过的文件永远不会被重新读一次文件头）',
  invalidated.includes("'exif_mtime = NULL'"),
);
check(
  '🔴 内容列清单从 exif-meta 派生，不在 database.js 里另抄一份列名',
  invalidated.includes('EXIF_METADATA_COLUMNS.map'),
);

// 写入方法
const updExifBody = bodyOf(dbSrc, 'updatePhotoExif(photoId, fields, dateModified) {');
check('夹具自证：取到了 updatePhotoExif 的函数体', updExifBody.length > 0);
// 🔴 SQL 现在**从注册表生成**（`getExifUpdateStmt()` 按 `EXIF_METADATA_COLUMNS` 拼 SET 子句），
//    所以「写没写某一列」不能靠在源码里找列名字面量 —— 那只能证明「有个字符串提到了它」。
//    真判据是「生成的 SQL 是否覆盖每个注册列」，由第 4 节的**真 Statement** 断言（读回 `.source`）负责。
//    这里只钉住「SET 与参数两处必须同源」这条结构：
check(
  '🔴 updatePhotoExif 的参数按注册表顺序绑定（两处各写一遍 = 静默串列）',
  updExifBody.includes('EXIF_FIELD_SPECS') && updExifBody.includes('coerceExifValue'),
);
check(
  '🔴 updatePhotoExif 复用预编译语句（60 列 × 163 万次，每次重新 prepare 是热路径纯浪费）',
  updExifBody.includes('this.getExifUpdateStmt()'),
);
const exifStmtBody = bodyOf(dbSrc, 'getExifUpdateStmt() {');
check('夹具自证：取到了 getExifUpdateStmt 的函数体', exifStmtBody.length > 0);
check(
  '🔴 SET 子句从 EXIF_METADATA_COLUMNS 派生（别在这里再抄一份 58 列清单）',
  exifStmtBody.includes('EXIF_METADATA_COLUMNS') && !exifStmtBody.includes('camera_make = ?'),
  exifStmtBody.includes('camera_make = ?') ? '发现手抄的列名' : '',
);
// ⚠️ 判「顺序」必须按行比对，不能用 `[\s\S]{0,200}` 这种跨行量词 ——
//    跨行兜底会把「两行都存在但顺序反了」也判成通过（本项目已经栽过一次）。
const stmtLines = exifStmtBody.split('\n');
const idxMtime = stmtLines.findIndex((l) => l.includes("exif_mtime = ?"));
const idxVer = stmtLines.findIndex((l) => l.includes("exif_ver = ?"));
check(
  '🔴 账本两列写在 SET 末尾，且 mtime 在 ver 之前（与 updatePhotoExif 的参数顺序逐位一致）',
  idxMtime >= 0 && idxVer === idxMtime + 1,
  idxMtime + ',' + idxVer,
);

// ---- 2c. 版本列：扩字段后，**已经跑过的行**必须能被重新取出来 ----
// 原委：`exif_mtime` 是**二元**标记（看过就再也不看）。只靠它的话，扩一次字段会让
// 已经跑过的行永久缺新列 —— 不报错、不写日志，只是那些照片在面板上永远少几行。
// 真库实测（2026-10-06）：扩字段时回填才跑到 0.60%，所以版本列能救回那 9,799 行。
check(
  '🔴 候选判据带版本号（只判 exif_mtime 的话，扩一次字段就让跑过的行永久缺新列）',
  dbSrc.includes('IFNULL(exif_ver, 0) < ') && dbSrc.includes('EXIF_SCHEMA_VERSION'),
);
check(
  '🔴 版本号的唯一来源是 exif-meta.js（在 database.js 里另写一个数字 = 两处必然漂移）',
  !/EXIF_SCHEMA_VERSION\s*=\s*\d/.test(dbSrc),
);
check(
  '🔴 内容变更时版本号也一起清（否则换过的文件被当成「已经看过当前口径」）',
  invalidated.includes("'exif_ver = NULL'"),
);

// ---- 2b. 真实拍摄时间：独立一列，绝不并进 date_taken ----
//
// 原委（真实库 166 万行实测）：`date_taken` 全库等于 `date_modified` —— 扫描期唯一给它赋值的
// 那行住在 `GENERATE_THUMBNAILS_DURING_SCAN`（= false）分支里，所以「取不到就拿文件时间兜底」
// 每行都命中，它装的是**文件落盘时间**。而真实拍摄时间只有 ~23% 的照片取得到（其余无 EXIF
// 或有 EXIF 但无拍摄时间），且多数与库内值差**几年**。
// 🔴 一旦把 EXIF 时间写进 `date_taken`，时间线（排序默认列 + `GROUP BY date(date_taken)`
//    + `idx_photos_date`）就变成「23% 真 + 77% 原样」的混合口径 —— 同一天拍的两张会分落
//    相隔几千天的两处。所以只能另开一列，由信息面板展示，**不参与排序**。

const exifMeta = require(path.join(ROOT, EXIF_MOD));
check(
  '🔴 exif_date_taken 进了 EXIF_METADATA_COLUMNS（内容变更置空清单从它派生，漏了就是脏数据）',
  exifMeta.EXIF_METADATA_COLUMNS.indexOf('exif_date_taken') >= 0,
  exifMeta.EXIF_METADATA_COLUMNS.join(','),
);
check(
  '🔴 列清单与字段映射双向一一对应（少一个方向 = 「解析出来了但没落库」或反过来）',
  (() => {
    const mapped = Object.keys(exifMeta.EXIF_FIELD_COLUMNS).map(
      (k) => exifMeta.EXIF_FIELD_COLUMNS[k],
    );
    if (mapped.length !== exifMeta.EXIF_METADATA_COLUMNS.length) return false;
    return exifMeta.EXIF_METADATA_COLUMNS.every((c) => mapped.indexOf(c) >= 0);
  })(),
  exifMeta.EXIF_METADATA_COLUMNS.length + ' vs ' + Object.keys(exifMeta.EXIF_FIELD_COLUMNS).length,
);
check(
  'EXIF_FIELD_COLUMNS.dateTaken 映射到 exif_date_taken（名称漂了就是「解析成功但落库丢字段」）',
  exifMeta.EXIF_FIELD_COLUMNS.dateTaken === 'exif_date_taken',
  String(exifMeta.EXIF_FIELD_COLUMNS.dateTaken),
);

// 核心 schema：把切片夹在 createCoreSchema 与 ensurePhotosExifColumn 之间，
// 免得「迁移里有、schema 里没有」也被匹配到（那样新库仍要靠 ALTER 才能有这一列）。
const coreSchemaSrc = (() => {
  const a = dbSrc.indexOf('createCoreSchema()');
  const b = dbSrc.indexOf('ensurePhotosExifColumn(', a);
  return a < 0 || b < a ? '' : dbSrc.slice(a, b);
})();
check('夹具自证：取到了 createCoreSchema 的切片', coreSchemaSrc.length > 0);
check(
  '🔴 核心 schema 有 exif_date_taken（新库一开始就有，不必靠迁移）',
  /exif_date_taken\s+TEXT/.test(coreSchemaSrc),
);
check('🔴 核心 schema 有 exif_mtime（同上，两者必须同时存在）', /exif_mtime\s+TEXT/.test(coreSchemaSrc));

const ensureExifBody = bodyOf(dbSrc, 'ensurePhotosExifColumn() {');
check('夹具自证：取到了 ensurePhotosExifColumn 的函数体', ensureExifBody.length > 0);
// 🔴 迁移现在从注册表**派生**（列名 + 类型），所以判据也换成「派生源接上了没有」，
//    而不是在函数体里找某个列名字面量 —— 后者对 58 列来说既写不全也拦不住漏列。
//    真判据（老库缺列 ⇒ 首次取批 no such column）由第 4 节在真库上验证。
check(
  '🔴 迁移的列清单与类型都从注册表派生（否则加了字段必须回来手工补 ALTER）',
  ensureExifBody.includes('EXIF_METADATA_COLUMNS') && ensureExifBody.includes('EXIF_COLUMN_TYPES'),
);
check(
  '🔴 账本两列显式进迁移计划（它们不在解析注册表里，派生不出来）',
  ensureExifBody.includes("['exif_mtime', 'TEXT']") &&
    ensureExifBody.includes("['exif_ver', 'INTEGER']"),
);
check(
  '🔴 列名探测只做一次 PRAGMA（逐列调 hasPhotosColumn 会变成 50 次表结构遍历）',
  (ensureExifBody.match(/PRAGMA table_info\(photos\)/g) || []).length === 1,
  String((ensureExifBody.match(/PRAGMA table_info\(photos\)/g) || []).length),
);
check(
  '🔴 单列 ALTER 失败不阻断其余列（并发实体会撞 duplicate column name，那是幂等命中）',
  ensureExifBody.includes('added.push(') && /duplicate column name/i.test(ensureExifBody),
);

const infoBody = bodyOf(dbSrc, 'getPhotoInfo(photoId) {');
check('夹具自证：取到了 getPhotoInfo 的函数体', infoBody.length > 0);
check(
  '🔴 getPhotoInfo 查得出 exif_date_taken（面板要显示什么，就得先 SELECT 出来）',
  infoBody.includes('exif_date_taken'),
);

// 🔴 最关键的一条：写入端不许碰时间线那一列。
// `date_taken` 只在 INSERT 时由扫描侧写一次，任何后台任务都不许覆盖它。
// 注意断言要排除 `exif_date_taken`（前缀是 `exif_`，`\b` 在 `_` 与 `d` 之间不成立，
// 但仍显式用 `[^_\w]` 挡住前缀，免得有人把这一列改名成 `date_taken2` 之类绕过去）。
check(
  '🔴 updatePhotoExif 绝不写 date_taken（时间线只能由扫描写；覆盖它 = 时间线撕裂）',
  !/(^|[^_\w])date_taken\s*=/m.test(updExifBody),
  /\bdate_taken\s*=/.test(updExifBody) ? '发现等号赋值' : '',
);

// =========================================================== 3. 补全任务侧接线

const oneBody = bodyOf(mainSrc, 'async function processOne(row) {');
check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);
check(
  '🔴 补全任务自己也不许写 date_taken（绕过 updatePhotoExif 另起一条 UPDATE = 上面那条断言就白钉了）',
  !/(^|[^_\w])date_taken\s*=/m.test(oneBody),
);
// ⚠️ 这两条必须**只看 needExif 的那一行**，不能再用 `[^;]*` 跨行匹配：
//    声明行本身长这样 —— `!(row.exif_mtime && String(row.exif_mtime).trim())` ——
//    里面出现过**两次** `row.exif_mtime`，只把前半段改成 `row.camera_make` 时，
//    跨行正则还能被后半段救活 ⇒ **假绿**（牙齿验证实测撞到过）。
const needExifLine = (oneBody.match(/var needExif = [^\n]*/) || [''])[0];
check('夹具自证：取到了 needExif 的声明行', needExifLine.length > 0, needExifLine);
check(
  '🔴 needExif 走 db.photoNeedsExif()（判据只留一份；手写 !(row.exif_mtime && …) 会漏掉版本判据）',
  needExifLine.includes('db.photoNeedsExif('),
  needExifLine,
);
check(
  '🔴 needExif 不许手写标记列的判断（手写必然只判得出一个列，迟早与 _sqlNeedsExifExpr 漂开）',
  !/row\.exif_mtime|row\.camera_make/.test(needExifLine),
  needExifLine,
);
check(
  '🔴 视频不参与 EXIF 回填（sharp 读不了视频）',
  needExifLine.includes('!isVideo'),
  needExifLine,
);
check(
  '🔴 尺寸与拍摄参数来自同一次 metadata：`needSize || needExif` 才去读文件头',
  (oneBody.match(/if \(needSize \|\| needExif\)/g) || []).length === 2,
  String((oneBody.match(/if \(needSize \|\| needExif\)/g) || []).length),
);
check(
  '🔴 只有读到文件头（header 非空）才写标记 —— 读盘失败不许当成「看过了、没有 EXIF」',
  /if \(needExif && header\)/.test(oneBody),
);
check(
  '🔴 写回调用在 processOne 里（不是定义完就没人用）',
  oneBody.includes('db.updatePhotoExif('),
);
const readHeaderBody = bodyOf(mainSrc, 'async function readHeaderMeta(', '\n}');
check('夹具自证：取到了 readHeaderMeta 的函数体', readHeaderBody.length > 0);
check(
  '🔴 一次 metadata 同时产出尺寸与 exif',
  readHeaderBody.includes('.metadata()') && readHeaderBody.includes('extractExifFields(meta)'),
);
check(
  '🔴 读不到文件头返回 null（三态里的第三态：不许写标记）',
  readHeaderBody.includes('catch') && readHeaderBody.includes('return null'),
);
check(
  '🔴 尺寸只认正数（0 视为读不到，不许把整库分辨率覆盖成 0）',
  readHeaderBody.includes('meta.width > 0') && readHeaderBody.includes('meta.height > 0'),
);
check(
  '旧的 readOriginalSize 已被 readHeaderMeta 取代（同名残留 = 两个函数各读一次文件头）',
  !mainSrc.includes('readOriginalSize'),
);

// =========================================================== 4. 行为面：解析结果必须对

// ---- 4a. 真图（sharp 写的 EXIF）：IFD0 的 Make / Model 必须被读出来 ----
// 旧代码只翻 exif.Photo，`Make`/`Model` 在 IFD0 ⇒ 这两项**永远是 null**。
async function testRealJpeg() {
  const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
  const { extractExifFields } = require(path.join(ROOT, EXIF_MOD));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exif-backfill-real-'));
  const file = path.join(dir, 'a.jpg');
  try {
    const buf = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'TestMake', Model: 'TestModel' } })
      .toBuffer();
    fs.writeFileSync(file, buf);
    const meta = await sharp(file).metadata();
    check('夹具自证：sharp 写进去的 EXIF 能被读回来', !!meta.exif);
    const f = extractExifFields(meta);
    check('🔴 IFD0 的 Make 被读出来（旧实现只翻 Photo，这一项永远是 null）', f.cameraMake === 'TestMake', String(f.cameraMake));
    check('🔴 IFD0 的 Model 被读出来', f.cameraModel === 'TestModel', String(f.cameraModel));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  }
}

// ---- 4b. 手工 TIFF：三个 IFD 全覆盖（含 GPS 的 [度,分,秒] 数组） ----
// sharp 的 withExif 只能写 IFD0/IFD1，**写不了 GPS**，所以这里自己拼一个最小 TIFF。
const T_ASCII = 2;
const T_SHORT = 3;
const T_LONG = 4;
const T_RATIONAL = 5;
// 本轮扩字段时补的三个类型：`byte`（GPS 海拔基准 / XP* 关键词的 UTF-16LE 字节）、
// `undefined`（ExifVersion / ComponentsConfiguration 这类「字节串但类型是 7」的标签）、
// `srational`（ExposureBiasValue 这类**带符号**有理数 —— 用无符号编码会把 -0.7 读成一个巨大的正数）。
const T_BYTE = 1;
const T_UNDEFINED = 7;
const T_SRATIONAL = 10;

function enc(kind, value) {
  if (kind === 'ascii') {
    const data = Buffer.from(String(value) + '\0', 'ascii');
    return { type: T_ASCII, count: data.length, data };
  }
  if (kind === 'short' || kind === 'long') {
    const values = Array.isArray(value) ? value : [value];
    const width = kind === 'short' ? 2 : 4;
    const data = Buffer.alloc(values.length * width);
    values.forEach((v, i) => {
      if (kind === 'short') data.writeUInt16BE(v, i * 2);
      else data.writeUInt32BE(v, i * 4);
    });
    return { type: kind === 'short' ? T_SHORT : T_LONG, count: values.length, data };
  }
  if (kind === 'rational') {
    const data = Buffer.alloc(value.length * 8);
    value.forEach((p, i) => {
      data.writeUInt32BE(p[0], i * 8);
      data.writeUInt32BE(p[1], i * 8 + 4);
    });
    return { type: T_RATIONAL, count: value.length, data };
  }
  if (kind === 'srational') {
    const data = Buffer.alloc(value.length * 8);
    value.forEach((p, i) => {
      data.writeInt32BE(p[0], i * 8);
      data.writeInt32BE(p[1], i * 8 + 4);
    });
    return { type: T_SRATIONAL, count: value.length, data };
  }
  if (kind === 'byte' || kind === 'undefined') {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return { type: kind === 'byte' ? T_BYTE : T_UNDEFINED, count: data.length, data };
  }
  throw new Error('unknown kind ' + kind);
}

/** 拼一个最小可用的 TIFF/EXIF（大端）：sections[0] = IFD0，其余是子 IFD。 */
function buildTiff(sections) {
  const flat = sections.map((entries) =>
    entries.map((e) => ({
      tag: e.tag,
      v: e.pointerTo != null ? enc('long', 0) : enc(e.kind, e.value),
      pointerTo: e.pointerTo,
    })),
  );
  const ifdOffsets = [];
  let cursor = 8;
  for (const entries of flat) {
    ifdOffsets.push(cursor);
    cursor += 2 + entries.length * 12 + 4;
  }
  for (const entries of flat) {
    for (const e of entries) {
      if (e.pointerTo != null) e.v.data.writeUInt32BE(ifdOffsets[e.pointerTo], 0);
    }
  }
  const blobs = [];
  let dataCursor = cursor;
  for (const entries of flat) {
    for (const e of entries) {
      if (e.v.data.length > 4) {
        e.outOffset = dataCursor;
        blobs.push({ offset: dataCursor, data: e.v.data });
        dataCursor += e.v.data.length + (e.v.data.length % 2);
      } else {
        e.outOffset = null;
      }
    }
  }
  const buf = Buffer.alloc(dataCursor);
  buf.write('MM', 0, 'ascii');
  buf.writeUInt16BE(0x002a, 2);
  buf.writeUInt32BE(8, 4);
  flat.forEach((entries, si) => {
    let p = ifdOffsets[si];
    buf.writeUInt16BE(entries.length, p);
    p += 2;
    for (const e of entries) {
      buf.writeUInt16BE(e.tag, p);
      buf.writeUInt16BE(e.v.type, p + 2);
      buf.writeUInt32BE(e.v.count, p + 4);
      // ⚠️ 值字段在条目内的偏移是 **8**（tag2 + type2 + count4）：写 +6 会让 exif-reader
      //    把 type/count 的尾巴当偏移读，结果是「整段 EXIF 全 null、还不报错」。
      if (e.outOffset === null) e.v.data.copy(buf, p + 8);
      else buf.writeUInt32BE(e.outOffset, p + 8);
      p += 12;
    }
    buf.writeUInt32BE(0, p);
  });
  for (const b of blobs) b.data.copy(buf, b.offset);
  return buf;
}

function testCraftedTiff() {
  const { extractExifFields } = require(path.join(ROOT, EXIF_MOD));
  const tiff = buildTiff([
    [
      { tag: 0x010f, kind: 'ascii', value: 'TestMake' },
      { tag: 0x0110, kind: 'ascii', value: 'TestModel' },
      { tag: 0x8769, pointerTo: 1 }, // ExifTag → Photo IFD
      { tag: 0x8825, pointerTo: 2 }, // GPSTag → GPS IFD
    ],
    [
      { tag: 0xa434, kind: 'ascii', value: 'TestLens 24-70' },
      { tag: 0x829d, kind: 'rational', value: [[28, 10]] }, // FNumber 2.8
      { tag: 0x829a, kind: 'rational', value: [[4, 1000]] }, // ExposureTime 1/250
      { tag: 0x8827, kind: 'short', value: [400] }, // ISOSpeedRatings
      { tag: 0x920a, kind: 'rational', value: [[50, 1]] }, // FocalLength
      { tag: 0x9003, kind: 'ascii', value: '2026:10:06 11:22:33' }, // DateTimeOriginal
    ],
    [
      { tag: 0x0001, kind: 'ascii', value: 'N' },
      { tag: 0x0002, kind: 'rational', value: [[39, 1], [54, 1], [268, 10]] },
      { tag: 0x0003, kind: 'ascii', value: 'E' },
      { tag: 0x0004, kind: 'rational', value: [[116, 1], [23, 1], [29, 1]] },
    ],
  ]);
  const f = extractExifFields({ exif: tiff });
  check('手工 TIFF：camera_make', f.cameraMake === 'TestMake', String(f.cameraMake));
  check('手工 TIFF：camera_model', f.cameraModel === 'TestModel', String(f.cameraModel));
  check('手工 TIFF：lens_model（在 Exif 子 IFD）', f.lensModel === 'TestLens 24-70', String(f.lensModel));
  check('手工 TIFF：focal_length（rational → 数值）', f.focalLength === 50, String(f.focalLength));
  check('手工 TIFF：aperture（FNumber 28/10）', f.aperture === 2.8, String(f.aperture));
  check('手工 TIFF：iso_speed', f.isoSpeed === 400, String(f.isoSpeed));
  check('手工 TIFF：shutter_speed 归一成 1/N', f.shutterSpeed === '1/250', String(f.shutterSpeed));
  check(
    '手工 TIFF：date_taken 归一成 YYYY-MM-DD HH:MM:SS（不是 Date.toString 的垃圾串）',
    f.dateTaken === '2026-10-06 11:22:33',
    String(f.dateTaken),
  );
  const expLat = 39 + 54 / 60 + 26.8 / 3600;
  const expLon = 116 + 23 / 60 + 29 / 3600;
  check(
    '🔴 GPS 纬度：[度,分,秒] 数组换算成十进制度（数组直接落库会抛，旧实现整段 EXIF 一起丢）',
    Math.abs(f.gpsLatitude - expLat) < 1e-9,
    String(f.gpsLatitude),
  );
  check(
    '🔴 GPS 经度同上',
    Math.abs(f.gpsLongitude - expLon) < 1e-9,
    String(f.gpsLongitude),
  );

  // 南半球 / 西经必须为负
  const { toDecimalDegrees } = require(path.join(ROOT, EXIF_MOD));
  check('南纬转负', toDecimalDegrees([33, 52, 0], 'S') < 0);
  check('西经转负', toDecimalDegrees([118, 15, 0], 'W') < 0);
  check('北纬为正', toDecimalDegrees([39, 54, 0], 'N') > 0);
  check('拿不到度就返回 null（不许写 0 —— 0,0 是几内亚湾，不是「未知」）', toDecimalDegrees(null, 'N') === null);

  // 坏字节 / 空 EXIF：必须返回全 null 且不抛
  let threw = false;
  let junk = null;
  try {
    junk = extractExifFields({ exif: Buffer.from('not an exif at all') });
  } catch (e) {
    threw = true;
    void e;
  }
  check('🔴 坏 EXIF 不抛异常（抛出去会被上层 catch 吞掉，那张照片连尺寸都不写了）', !threw);
  check(
    '🔴 坏 EXIF 返回全 null 字段对象（调用方据此照常写「已检查」标记）',
    junk && junk.cameraMake === null && junk.gpsLatitude === null && junk.dateTaken === null,
  );
  check('没有 exif 属性时也返回全 null', extractExifFields({ width: 8 }).cameraMake === null);
  check('metadata 为 null 时也返回全 null', extractExifFields(null).cameraMake === null);

  // ---- 4b-2. 本轮扩的 48 列：断言归一化后的**确切值**，不是「有没有读到」----
  // 🔴 为什么必须比具体值：归一化漏掉时**不会报错、也能绑进库** ——
  //    数组没换成文本、UTF-16 按 utf8 解成乱码、有符号有理数丢了负号，
  //    症状都只是「面板上那一行看起来怪」，没人会去查。
  const tiff2 = buildTiff([
    [
      { tag: 0x0112, kind: 'short', value: [6] }, // Orientation
      { tag: 0x0131, kind: 'ascii', value: 'TestSoft' }, // Software
      { tag: 0x0132, kind: 'ascii', value: '2026:10:06 11:22:33' }, // DateTime（IFD0）
      { tag: 0x013b, kind: 'ascii', value: 'TestArtist' }, // Artist
      { tag: 0x8298, kind: 'ascii', value: 'TestCopyright' }, // Copyright
      { tag: 0x9c9e, kind: 'byte', value: Buffer.from('假期', 'utf16le') }, // XPKeywords
      { tag: 0x0213, kind: 'short', value: [1] }, // YCbCrPositioning
      { tag: 0x8769, pointerTo: 1 }, // ExifTag → Photo IFD
      { tag: 0x8825, pointerTo: 2 }, // GPSTag → GPS IFD
    ],
    [
      { tag: 0x8822, kind: 'short', value: [3] }, // ExposureProgram
      { tag: 0x9207, kind: 'short', value: [5] }, // MeteringMode
      { tag: 0x9209, kind: 'short', value: [0] }, // Flash（位掩码）
      { tag: 0x9208, kind: 'short', value: [1] }, // LightSource
      { tag: 0x9204, kind: 'srational', value: [[-7, 10]] }, // ExposureBiasValue = -0.7
      { tag: 0xa402, kind: 'short', value: [1] }, // ExposureMode
      { tag: 0xa403, kind: 'short', value: [1] }, // WhiteBalance
      { tag: 0xa406, kind: 'short', value: [2] }, // SceneCaptureType
      { tag: 0x9205, kind: 'rational', value: [[28, 10]] }, // MaxApertureValue = 2.8
      { tag: 0xa405, kind: 'short', value: [35] }, // FocalLengthIn35mmFilm
      { tag: 0xa432, kind: 'rational', value: [[24, 1], [70, 1], [28, 10], [28, 10]] }, // LensSpecification
      { tag: 0xa433, kind: 'ascii', value: 'SONY' }, // LensMake
      { tag: 0xa431, kind: 'ascii', value: 'SN123' }, // BodySerialNumber
      { tag: 0xa435, kind: 'ascii', value: 'LS456' }, // LensSerialNumber
      { tag: 0xa001, kind: 'short', value: [1] }, // ColorSpace
      { tag: 0x9291, kind: 'ascii', value: '12' }, // SubSecTimeOriginal
      { tag: 0x9011, kind: 'ascii', value: '+08:00' }, // OffsetTimeOriginal
      { tag: 0x9286, kind: 'undefined', value: Buffer.from('ASCII\0\0\0hello comment', 'latin1') }, // UserComment
      { tag: 0x9000, kind: 'undefined', value: Buffer.from('0230', 'latin1') }, // ExifVersion
      { tag: 0x9101, kind: 'undefined', value: Buffer.from([1, 2, 3, 0]) }, // ComponentsConfiguration
    ],
    [
      { tag: 0x0005, kind: 'byte', value: Buffer.from([1]) }, // GPSAltitudeRef = 1 ⇒ 海平面以下
      { tag: 0x0006, kind: 'rational', value: [[125, 10]] }, // GPSAltitude = 12.5
    ],
  ]);
  const g = extractExifFields({ exif: tiff2 });
  check('扩字段：orientation', g.orientation === 6, String(g.orientation));
  check('扩字段：software（IFD0）', g.software === 'TestSoft', String(g.software));
  check(
    '扩字段：image_datetime（IFD0 的 DateTime 也要归一化成 ISO 样式）',
    g.imageDatetime === '2026-10-06 11:22:33',
    String(g.imageDatetime),
  );
  check('扩字段：artist', g.artist === 'TestArtist', String(g.artist));
  check('扩字段：copyright', g.copyright === 'TestCopyright', String(g.copyright));
  check(
    '🔴 扩字段：xp_keywords 按 UTF-16LE 解（按 utf8 解是乱码，而且乱码照样能落库 ⇒ 静默）',
    g.xpKeywords === '假期',
    String(g.xpKeywords),
  );
  check('扩字段：ycbcr_positioning', g.ycbcrPositioning === 1, String(g.ycbcrPositioning));
  check('扩字段：exposure_program', g.exposureProgram === 3, String(g.exposureProgram));
  check('扩字段：metering_mode', g.meteringMode === 5, String(g.meteringMode));
  check('🔴 扩字段：flash 是位掩码不是枚举（0 = 未闪光，不能当成「没有」丢掉）', g.flash === 0, String(g.flash));
  check('扩字段：light_source', g.lightSource === 1, String(g.lightSource));
  check('🔴 扩字段：exposure_bias 是带符号有理数（负号丢了会变成天文数字）', g.exposureBias === -0.7, String(g.exposureBias));
  check('扩字段：exposure_mode', g.exposureMode === 1, String(g.exposureMode));
  check('扩字段：white_balance', g.whiteBalance === 1, String(g.whiteBalance));
  check('扩字段：scene_capture_type', g.sceneCaptureType === 2, String(g.sceneCaptureType));
  check('扩字段：max_aperture', g.maxAperture === 2.8, String(g.maxAperture));
  check('扩字段：focal_length_35mm', g.focalLength35mm === 35, String(g.focalLength35mm));
  check(
    '🔴 扩字段：lens_spec 从 4 元数组格式化成「24-70mm f/2.8」（数组直接落库会抛）',
    g.lensSpec === '24-70mm f/2.8',
    String(g.lensSpec),
  );
  check('扩字段：lens_make', g.lensMake === 'SONY', String(g.lensMake));
  check('扩字段：body_serial', g.bodySerial === 'SN123', String(g.bodySerial));
  check('扩字段：lens_serial', g.lensSerial === 'LS456', String(g.lensSerial));
  check('扩字段：color_space', g.colorSpace === 1, String(g.colorSpace));
  check('扩字段：sub_sec_time', g.subSecTime === '12', String(g.subSecTime));
  check('扩字段：offset_time', g.offsetTime === '+08:00', String(g.offsetTime));
  check(
    '🔴 扩字段：user_comment 剥掉 8 字节编码头（不剥会带出一串 NUL 当注释）',
    g.userComment === 'hello comment',
    String(g.userComment),
  );
  check('扩字段：exif_version', g.exifVersion === '0230', String(g.exifVersion));
  check(
    '🔴 扩字段：components_configuration 从字节数组转十六进制文本（数组直接落库会抛）',
    g.componentsConfiguration === '01020300',
    String(g.componentsConfiguration),
  );
  check(
    '🔴 扩字段：GPS 海拔按 GPSAltitudeRef 取负（1 = 海平面以下）',
    g.gpsAltitude === -12.5,
    String(g.gpsAltitude),
  );
  check(
    '夹具自证：没写进 TIFF 的字段一律 null（不是 0、不是空串）',
    g.pixelXDimension === null && g.contrast === null && g.sharpness === null,
    JSON.stringify([g.pixelXDimension, g.contrast, g.sharpness]),
  );
  const { hasAnyExifField } = require(path.join(ROOT, EXIF_MOD));
  check('🔴 hasAnyExifField 认得出「这批字段里有真值」', hasAnyExifField(g) === true);
  const allNull = extractExifFields(null);
  check(
    '🔴 hasAnyExifField 对全 null 空壳返回 false（否则「本来就没有 EXIF」的照片永远留在候选集）',
    hasAnyExifField(allNull) === false,
  );
  check(
    '🔴 空壳对象覆盖全部 58 个字段（少了键 = 该字段永远 null，不报错）',
    Object.keys(allNull).length === exifMeta.EXIF_METADATA_COLUMNS.length,
    Object.keys(allNull).length + ' vs ' + exifMeta.EXIF_METADATA_COLUMNS.length,
  );
}

// ---- 4c. 行为面：候选集必须真的收敛在标记列上 ----
function testConvergence() {
  const PhotoDatabase = require(path.join(ROOT, DB));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exif-backfill-db-'));
  const dbPath = path.join(dir, 'photos.db');
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    // `dhash` / `file_hash` 是延迟迁移列，而 `getPhotoInfo()` 的 SELECT 里带着它们。
    // 真实调用链由各自的 ensure 保证；夹具省掉这一步就是 `no such column`（本守护真撞过）。
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();
    const rootId = db.addRootFolder('C:\\exif\\root');
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const mtime = '2026-01-01 00:00:00';
    const addRow = (i) => {
      const filePath = 'C:\\exif\\root\\p' + i + '.jpg';
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\exif\\root',
        fileName: 'p' + i + '.jpg',
        filePath,
        fileSize: 10,
        fileType: 'jpg',
        width: 4000,
        height: 3000,
        dateTaken: mtime,
        dateModified: mtime,
        thumbnail: thumb,
        hasThumbnail: 1,
        thumbSize: 256,
        thumbFormat: 'jpeg',
      });
      db.updatePhotoDhash(i, '0000000000000000', [0], mtime, 10);
    };

    addRow(1);
    addRow(2);
    check(
      '🔴 「缩略图 / dHash / 尺寸都齐、只差拍摄参数」的行必须进候选集',
      db.getMissingThumbnailCount() === 2,
      '实得 ' + db.getMissingThumbnailCount(),
    );

    // 只把**内容列**写进去（绕过 updatePhotoExif）⇒ 标记列还是空的 ⇒ 仍算待补
    db.db.prepare('UPDATE photos SET camera_make = ? WHERE id = 1').run('SneakyMake');
    check(
      '🔴 判据是标记列不是内容列：光有 camera_make 而没有 exif_mtime 的行**仍然**待补',
      db.getMissingThumbnailCount() === 2,
      '实得 ' + db.getMissingThumbnailCount(),
    );

    // 走正常写回：内容全 null 也算「看过了」
    db.updatePhotoExif(1, null, mtime);
    db.updatePhotoExif(2, null, mtime);
    check(
      '🔴 行为面：写过标记后候选集归零 —— 截图 / 网图 / PNG 这类**没有 EXIF** 的照片也能收敛',
      db.getMissingThumbnailCount() === 0,
      '实得 ' + db.getMissingThumbnailCount(),
    );

    // 🔴 版本判据的行为面：把 exif_ver 抹掉 = 模拟「旧口径跑过的行」。
    //    它必须**重新进候选集**，且处理判据（photoNeedsExif）必须说「要读」——
    //    否则就是「取出来 → 判不需要 → 跳过」的死循环：行原样留下、候选集永不收敛、
    //    新扩出来的列永远补不上。本机真实库 9,799 行正是这样卡住的（2026-10-06）。
    db.db.prepare('UPDATE photos SET exif_ver = NULL WHERE id = 1').run();
    check(
      '🔴 「旧版看过」的行（只有 exif_mtime、exif_ver 为空）必须重新进候选集',
      db.getMissingThumbnailCount() === 1,
      '实得 ' + db.getMissingThumbnailCount(),
    );
    const staleRow = db.getPhotosMissingThumbnailsBefore(99999, 5)[0];
    check(
      '🔴 候选查询把 exif_ver 带出来了（少这一列，处理判据会把旧行误判成「已看过」）',
      !!staleRow && Object.prototype.hasOwnProperty.call(staleRow, 'exif_ver'),
      staleRow ? JSON.stringify(staleRow) : '(没取到行)',
    );
    check(
      '🔴 同口径：photoNeedsExif 判这一行必须说「要读」（false 就是取出来又跳过的死循环）',
      db.photoNeedsExif(staleRow) === true,
      'photoNeedsExif = ' + (staleRow ? db.photoNeedsExif(staleRow) : 'n/a'),
    );
    // 反之：新版标记的行不许再进候选集（否则每轮对全库白跑）
    db.updatePhotoExif(1, null, mtime);
    check(
      '🔴 按新版写回后候选集重新归零（版本号能收敛，不会永久滞留）',
      db.getMissingThumbnailCount() === 0,
      '实得 ' + db.getMissingThumbnailCount(),
    );

    // 内容真的落库了
    const info = db.getPhotoInfo(2);
    check('updatePhotoExif 的标记落库（getPhotoInfo 读得到）', !!info);
    check(
      '内容为 null 时写的就是 null（不是字符串 null）',
      info && info.camera_make === null,
      info ? JSON.stringify(info.camera_make) : 'no row',
    );
    check(
      '没写拍摄时间时 exif_date_taken 也是 null（不是字符串）',
      info && info.exif_date_taken === null,
      info ? JSON.stringify(info.exif_date_taken) : 'no row',
    );
    db.updatePhotoExif(
      1,
      { cameraMake: 'RealMake', isoSpeed: 200, dateTaken: '2011-03-03 00:00:00' },
      mtime,
    );
    const info1 = db.getPhotoInfo(1);
    check('updatePhotoExif 写入内容列', info1 && info1.camera_make === 'RealMake');
    check('updatePhotoExif 写入数值列', info1 && info1.iso_speed === 200);
    check(
      'updatePhotoExif 写入真实拍摄时间（exif_date_taken）',
      info1 && info1.exif_date_taken === '2011-03-03 00:00:00',
      info1 ? JSON.stringify(info1.exif_date_taken) : 'no row',
    );
    // 🔴 行为面的核心：写了 EXIF 拍摄时间之后，时间线那一列必须**一动不动**。
    // 它是排序默认列 + 日期分组 + idx_photos_date 的唯一输入，被覆盖就是时间线撕裂。
    check(
      '🔴 写 EXIF 拍摄时间不动时间线那一列（date_taken 仍是入库时的值）',
      info1 && info1.date_taken === mtime,
      info1 ? JSON.stringify(info1.date_taken) + ' vs ' + JSON.stringify(mtime) : 'no row',
    );

    // 非法 id 不许抛
    check('updatePhotoExif 非法 id 返回 changes:0 且不抛', db.updatePhotoExif(0, null, mtime).changes === 0);

    // 内容变更 ⇒ 标记被清 ⇒ 重新回到候选集（扫描侧置空清单的契约）
    const factsStmt = db.getUpdateFileFactsStmt();
    check('夹具自证：取到了变更更新语句', !!factsStmt && factsStmt.source.includes('exif_mtime = NULL'), factsStmt ? factsStmt.source.slice(0, 160) : 'no stmt');
    check(
      '🔴 内容变更时 exif_date_taken 也一起清（否则换过的文件仍显示旧文件的拍摄时间）',
      !!factsStmt && factsStmt.source.includes('exif_date_taken = NULL'),
      factsStmt ? factsStmt.source.slice(0, 240) : 'no stmt',
    );

    // 候选查询必须带 exif_mtime 列（上层靠它判 needExif）
    const picked = db.getPhotosMissingThumbnailsBefore(0, 10); // id < 0 ⇒ 空，但语句要能编译
    check('候选查询在带视频/EXIF 谓词后仍能编译执行', Array.isArray(picked));

    // ---- 续 2：本轮扩字段的两个前提（真 SQL 覆盖 / 版本列能救回跑过的行）----
    // 🔴 读回 Statement 的 `.source` 做机械比对 —— 上面那些「源码里有没有这个列名」的断言
    //    只能证明「有个字符串提到了它」，这里才是「它真的在 SET 子句里」。
    const updStmt = db.getExifUpdateStmt();
    check('夹具自证：取到了 EXIF 更新语句', !!updStmt && typeof updStmt.source === 'string');
    const updSrc = updStmt ? updStmt.source : '';
    const needCols = exifMeta.EXIF_METADATA_COLUMNS.concat(['exif_mtime', 'exif_ver']);
    const missingCols = needCols.filter((c) => !new RegExp('(^|[,\\s])' + c + '\\s*=').test(updSrc));
    check(
      '🔴 生成的 UPDATE 覆盖全部 58 个内容列 + 账本 2 列（列名写错、SET 漏列都在这里现形）',
      missingCols.length === 0,
      missingCols.join(','),
    );
    const phCount = (updSrc.match(/\?/g) || []).length;
    check(
      '🔴 占位符数 = 60 列 + 1 个 WHERE 的 id（少一个就是静默串列）',
      phCount === needCols.length + 1,
      String(phCount),
    );
    check(
      '🔴 生成的 UPDATE 绝不写 date_taken（时间线那一列只能由扫描写）',
      !/(^|[^_\w])date_taken\s*=/m.test(updSrc),
    );
    const colsNow = db.db.prepare('PRAGMA table_info(photos)').all().map((r) => r.name);
    const absentCols = needCols.filter((c) => colsNow.indexOf(c) < 0);
    check(
      '🔴 init() 同步迁移把 60 列都建出来了（老库首次启动缺一列 = 第一次取批就 no such column）',
      absentCols.length === 0,
      absentCols.join(','),
    );

    // 版本列：标记还停在「旧口径」的行必须重新回到候选集
    db.updatePhotoExif(1, null, mtime);
    check('夹具自证：写回后候选集为空', db.getMissingThumbnailCount() === 0, '实得 ' + db.getMissingThumbnailCount());
    db.db.prepare('UPDATE photos SET exif_ver = 1 WHERE id = 1').run();
    check(
      '🔴 旧版本口径的行重新进候选集（扩字段后靠它救回已经跑过的行；不然那些行永久缺新列）',
      db.getMissingThumbnailCount() === 1,
      '实得 ' + db.getMissingThumbnailCount(),
    );
    db.updatePhotoExif(1, null, mtime);
    const verRow = db.db.prepare('SELECT exif_ver AS v FROM photos WHERE id = 1').get();
    check(
      '写回时把版本号升到当前口径（否则下一轮又被判成待补，任务永不收敛）',
      db.getMissingThumbnailCount() === 0 &&
        !!verRow &&
        verRow.v === exifMeta.EXIF_SCHEMA_VERSION,
      'ver=' + (verRow ? verRow.v : 'null') + ' count=' + db.getMissingThumbnailCount(),
    );
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    check(
      '行为面：EXIF 回填收敛实验未抛错（若报 NODE_MODULE_VERSION，用 electron 跑本脚本）',
      false,
      msg,
    );
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
      } catch (e) {
        void e;
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch (e) {
      void e;
    }
  }
}

// ---------------------------------------------------- 5. 登记进全量回归

check(
  '本守护已登记进 scripts/run-regressions.js',
  runSrc.includes("'exif-backfill-regression.js'"),
);

// ---------------------------------------------------------------------- 输出

async function main() {
  await testRealJpeg();
  testCraftedTiff();
  testConvergence();

  process.stdout.write('[exif-backfill-regression] 拍摄参数回填链路契约\n');
  for (const line of notes) process.stdout.write(line + '\n');
  if (errors.length) {
    process.stdout.write('\n');
    for (const line of errors) process.stdout.write(line + '\n');
    process.stdout.write('\n[exif-backfill-regression] FAIL（' + errors.length + ' 项）\n');
    process.exit(1);
  }
  process.stdout.write('\n[exif-backfill-regression] PASS（' + notes.length + ' 项）\n');
}

main().catch((e) => {
  process.stdout.write(
    '[exif-backfill-regression] FAIL（未捕获异常）\n' + (e && e.stack ? e.stack : e) + '\n',
  );
  process.exit(1);
});
