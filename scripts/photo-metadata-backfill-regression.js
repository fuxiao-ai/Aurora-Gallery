'use strict';
/**
 * 照片元数据回填回归：`photos.width` / `photos.height` 的补全链路。
 *
 * 背景（2026-10-04）：本机 1224 万行的库里 `width` / `height` 与 EXIF 各列**全是空的**，
 * 但列本身都在。原因是两阶段导入 —— `scanner.js` 的 `GENERATE_THUMBNAILS_DURING_SCAN = false`
 * 让 `processFile()` 整块跳过元数据提取，而当时的补全任务只写缩略图与 dHash，
 * 明明已经把每个文件用 sharp 打开过，却从不调 `.metadata()`。
 * 于是面板上「尺寸 / 宽高比 / 总像素」三行只能靠预览时的 sharp 实时回补撑着。
 *
 * 这一轮把「缺尺寸」纳入补全任务的候选谓词，让它在生成缩略图 / 补 dHash 的同时，
 * 用**同一个 sharp 实例**顺手读一次文件头（零额外磁盘 I/O）。
 *
 * 🔴 教训（2026-10-05，T6）：实现曾经只落在 `src/main/thumbnail-backfill.js` —— 而那个文件是
 * **未接线的孤儿副本**，运行时根本不会执行。于是**本脚本一路是假绿**：断言全过，线上却
 * 一行尺寸都没写，候选集（含 `width IS NULL OR width = 0`）永不收敛，每轮补全都重走全库。
 * 孤儿链已删除，断言现在钉 `src/main.js` 的 `runRowsWithThumbConcurrency` —— **活的那一份**。
 * 写「某条契约实现了」的守护时，必须先确认被钉的文件在运行时真的会被 `require`。
 *
 * 本脚本钉住这条链路里最容易静默坏掉的几处：
 *   1. 🔴 **谓词必须同源**。「缺什么」这个判断分散在三个查询方法里，各写一份一定会漂；
 *      漂的后果是**静默空转**（进度条分母 1200 万、任务却几乎不动）或**重复白干**。
 *   2. 🔴 **候选行必须带 `dhash` / `width` / `height` 三列**。少了 `dhash`，上层就判断不出
 *      「这次命中只是因为缺尺寸」，会对每一行重算 dHash —— 那是整图解码，比读文件头贵几个数量级。
 *   3. 🔴 **原图尺寸只能来自 `.metadata()`**。`toBuffer()` 返回的 `info.width/height` 是
 *      **输出（缩略图）**的尺寸，用错会把整库分辨率写成 256×256，而且不报任何错。
 *   4. 🔴 **尺寸不降级**：只在拿到正尺寸时才写库，不能把已有的真实值覆盖成 0。
 *   5. 🔴 **候选顺序必须是倒序（最新入库优先），且游标与排序同向**（2026-10-05）：补全的可见
 *      收益只落在用户刚导入的那批照片上，而它们正是 id 最大的那批；升序会让人对着空卡片等
 *      全部历史积压补完。本机真实库实测首批 100 行：升序 269ms / 倒序 2ms（两个方向都走
 *      `SEARCH photos USING INTEGER PRIMARY KEY`，**一次完整跑的代价相同**，倒序只是把有用的
 *      行提前）。顺序写反或游标不单调 = 同一轮对刚失败的行死循环重试，所以这里既钉文本也钉行为。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DB = 'src/database.js';
/** 补全任务的**活实现**就在 main.js（`runRowsWithThumbConcurrency`），没有独立模块文件 */
const BACKFILL_IMPL = 'src/main.js';
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

/** 取一段函数 / 方法体的文本，用于「这行必须在这个函数里」类断言 */
function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

const dbSrc = read(DB);
const implSrc = read(BACKFILL_IMPL);
const runSrc = read(RUN_REGRESSIONS);

// ---------------------------------------------------- 1. 候选谓词必须单一来源

const predBody = bodyOf(dbSrc, '_sqlBackfillPendingExpr() {');
check('夹具自证：取到了 _sqlBackfillPendingExpr 的函数体', predBody.length > 0);
// 计数 = 「谓词方法定义 1 处 + 每个候选查询各 1 处」。2026-10-05 删掉零调用点的
// 升序旧版 `getPhotosMissingThumbnails` 后从 4 变 3。**改下限之前先数一遍真实引用**
// （`grep -c _sqlBackfillPendingExpr src/database.js`），别为了让它绿就顺手放宽。
check(
  '谓词方法存在且被导出使用点引用',
  (dbSrc.match(/_sqlBackfillPendingExpr\(\)/g) || []).length >= 3,
  String((dbSrc.match(/_sqlBackfillPendingExpr\(\)/g) || []).length),
);
check('🔴 谓词含「缺缩略图」支（走 _sqlNeedsThumbnailExpr() 单一来源）', predBody.includes('_sqlNeedsThumbnailExpr()'));
check('🔴 谓词含「缺 dhash」条件', predBody.includes('dhash IS NULL') && predBody.includes("TRIM(dhash) = ''"));
check('🔴 谓词含「缺尺寸」的两个条件（库里存的是 0 不是 NULL，只判 IS NULL 一张都命中不了）', predBody.includes('width IS NULL') && predBody.includes('width = 0'));

// 🔴 「缺缩略图」那一支在 2026-10-06 搬进了独立方法 `_sqlNeedsThumbnailExpr()` ——
//    本体得单独钉，否则上面那条「引用了它」的断言在**方法被掏空**时照样绿。
const thumbNeedBody = bodyOf(dbSrc, '_sqlNeedsThumbnailExpr() {');
check('夹具自证：取到了 _sqlNeedsThumbnailExpr 的函数体', thumbNeedBody.length > 0);
check('🔴 「缺缩略图」判据仍以 has_thumbnail = 0 为入口', thumbNeedBody.includes('has_thumbnail = 0'));
check(
  '🔴 「缺缩略图」判据必须带失败记账列（不然读不了的文件每轮被取出、每轮白读一次盘、永不收敛）',
  thumbNeedBody.includes('thumb_fail_mtime'),
);
// 🔴 2026-10-06：自愈判据本体搬进共用方法 `_sqlFailMarkerRetryableExpr(col)`（两个失败标记列
//    —— `thumb_fail_mtime` 管解码路、`header_fail_mtime` 管文件头路 —— **必须同一条规则**）。
//    于是「IFNULL 两侧兜」这类断言的对象从 `_sqlNeedsThumbnailExpr` 换成了它。
//    ⚠️ 别为了让它绿就把断言挪回调用方：那样两列各写一份时会同时绿，正是要防的漂移。
check(
  '🔴 「缺缩略图」判据必须走共用实现（两列同一条自愈规则，各写一份迟早漂开）',
  thumbNeedBody.includes("_sqlFailMarkerRetryableExpr('thumb_fail_mtime')"),
);
const retryableBody = bodyOf(dbSrc, '_sqlFailMarkerRetryableExpr(col) {');
check('夹具自证：取到了 _sqlFailMarkerRetryableExpr 的函数体', retryableBody.length > 0);
// ⚠️ 两侧都要 IFNULL。真正会分叉的组合**只有一个**：**盖章时这行有日期、之后
//    `date_modified` 被清成 NULL**（文件被删 / 重扫后日期清空 —— 状态确实变了、本该重试）。
//    · 裸比较：`'旧日期' <> NULL` → NULL（当假）⇒ 这行**被永久排除**，再也不会被处理
//    · IFNULL：`'旧日期' <> ''` → 真 ⇒ 回到候选集，会被重试
//    ⚠️ 别想成「老数据 date_modified 为 NULL 就会出问题」——那种行的标记列同样是 NULL，
//    被同一谓词里的 `IS NULL OR` 那一支救回来了，裸比较照样对。
//    2026-10-06 实测：把两侧 IFNULL 删掉，**行为面 5 条全绿、只有静态断言红**；
//    于是补了 6c 节末尾那个 #5 号夹具，让行为面也咬得住它。
check(
  '🔴 失败标记判据两侧都要 IFNULL（盖章后日期被清成 NULL 的行，裸比较会把它永久排除）',
  retryableBody.includes("'') <> IFNULL(date_modified") &&
    retryableBody.includes('IFNULL('),
);
// 只判「还在集合里」是不够的：判定必须走 `IS NULL` 那一支，否则「从没试过」的行进不来。
check(
  '🔴 失败标记判据必须放行「从没试过」的行（标记列 IS NULL）',
  retryableBody.includes('IS NULL OR IFNULL('),
);

// 🔴 候选谓词**第二支**：每个缺失项都要配**自己那一路**的失败标记（2026-10-06 补）。
//    只门第一支是不够的 —— 读不了的文件 width=0 / dhash=NULL / exif_mtime=NULL ⇒ 第二支恒真，
//    它们从第一支漏出来照样留在候选集里（真库实测 10/10 命中，约 162 MB/轮 白读）。
// ⚠️ 不能写成 `includes("… AND _sqlFailMarkerRetryableExpr")`：源码里那是**两段字符串字面量
//    拼接**（中间隔着 `" +` 与 `this.`），逐字匹配必然落空 ⇒ 断言假红。改成比**先后顺序**，
//    既不依赖格式，又能真正证明「dhash 那一段被它门住了」而不是「谓词里恰好有这个词」。
const iDhashCond = predBody.indexOf("(dhash IS NULL OR TRIM(dhash) = '')");
const iThumbGate = predBody.indexOf("_sqlFailMarkerRetryableExpr('thumb_fail_mtime')");
const iWidthCond = predBody.indexOf('(width IS NULL OR width = 0)');
check(
  '🔴 第二支的「缺 dHash」必须由解码路标记门住（thumb_fail_mtime 紧跟其条件之后）',
  iDhashCond >= 0 && iThumbGate > iDhashCond && (iWidthCond < 0 || iThumbGate < iWidthCond),
  'dhash=' + iDhashCond + ' gate=' + iThumbGate + ' width=' + iWidthCond,
);
check(
  '🔴 第二支「缺尺寸」必须由文件头路标记门住（header_fail_mtime）',
  predBody.includes("_sqlFailMarkerRetryableExpr('header_fail_mtime')"),
);
check(
  '🔴 第二支「缺拍摄参数」同样由文件头路标记门住，且与尺寸项是**并列**关系（不是一个粗判）',
  (predBody.match(/_sqlFailMarkerRetryableExpr\('header_fail_mtime'\)/g) || []).length === 2,
  String((predBody.match(/_sqlFailMarkerRetryableExpr\('header_fail_mtime'\)/g) || []).length),
);

// 🔴 视频必须被排除在「缺 dHash / 缺尺寸」之外（2026-10-06）。
//    `processOne` 对视频既不读尺寸也不算 dHash（两处都是 `!isVideo && …`），
//    于是「dHash 为空的视频」永远算不出 dHash、尺寸也永远不写 ⇒ 留在候选集里就是死行：
//    每轮必然被取到、处理完又原样留下，白烧批次，而且 `getMissingThumbnailCount()` 的
//    收敛断言（本脚本第 5 节要求它归零）在**任何带视频的库**上都不可满足。
//    本机真实库实测：26,609 个视频全缺 width/height，其中 25,585 个已有缩略图 ⇒ 纯空跑。
check(
  '🔴 缺 dHash / 缺尺寸三支被 is_image 门住（否则视频永久占用候选集）',
  predBody.includes('_sqlFileTypeIsImageExpr()'),
);
// ⚠️ 顺序是承重的：「缺缩略图」支必须在 is_image 门**之外**（且写在前）。
//    视频真正欠的只有缩略图 —— 一旦把这一支也门进 is_image，1,024 个无缩略图的视频
//    就永远补不上，而且不报任何错（候选集里根本不会再出现它们）。
{
  const iThumb = predBody.indexOf('_sqlNeedsThumbnailExpr()');
  const iImg = predBody.indexOf('_sqlFileTypeIsImageExpr()');
  check(
    '🔴 「缺缩略图」支留在 is_image 门外，且写在门之前（视频也要缩略图）',
    iThumb >= 0 && iImg > iThumb,
    `thumb=${iThumb} img=${iImg}`,
  );
}

for (const [method, pred] of [
  ['getMissingThumbnailCount() {', '_sqlBackfillPendingExpr()'],
  ['getPhotosMissingThumbnailsBefore(beforeId, limit) {', '_sqlBackfillPendingExpr()'],
  // 2026-10-06：补全任务的第一趟（只补缺缩略图的）走这条，谓词是另一个。
  ['getPhotosLackingThumbnailBefore(beforeId, limit) {', '_sqlNeedsThumbnailExpr()'],
]) {
  const short = method.split('(')[0];
  const body = bodyOf(dbSrc, method);
  check('夹具自证：取到了 ' + short + ' 的函数体', body.length > 0);
  check('🔴 ' + short + ' 引用统一谓词（不自己再写一份）', body.includes(pred));
  check(
    short + ' 没有内联重复的待补条件',
    !body.includes('has_thumbnail = 0') && !body.includes('dhash IS NULL'),
  );
}

// 零调用点的方法一律删掉（2026-10-05）。留着的代价不是「多几行」，而是**旧方向的活标本**：
// `getPhotosMissingThumbnails` 与活的 `...Before` 只差一个词，后来人照它写就是升序；
// `markMissingFilesAsNotExists` 是「兼容主进程旧调用名」的壳，而主进程早已不那样调。
check(
  '🔴 已删的零调用点方法不得再现（升序旧版 / 旧 dHash 批次查询 / 旧的兼容壳）',
  !dbSrc.includes('getPhotosMissingThumbnails(') &&
    !dbSrc.includes('getDhashBackfillPhotosAfter') &&
    !dbSrc.includes('markMissingFilesAsNotExists'),
  '出现即说明有人把旧写法搬回来了',
);

// ---------------------------------------------------- 2. 候选行必须带判断所需的列

const pickBody = bodyOf(dbSrc, 'getPhotosMissingThumbnailsBefore(beforeId, limit) {');
for (const col of ['dhash', 'width', 'height']) {
  check(
    '🔴 候选查询 SELECT 带上 ' + col + '（少了它上层无法判断该不该跳过重算）',
    new RegExp('(^|[,\\s])' + col + '(\\s|,|$)', 'm').test(pickBody.split('FROM')[0]),
  );
}
check(
  '🔴 候选查询按主键**倒序**取（最新入库优先；改回升序 = 用户对着新导入的空卡片等全部积压）',
  pickBody.includes('id < ?') && pickBody.includes('ORDER BY id DESC'),
);
check(
  '🔴 候选查询的游标与排序同向且单调（`id < ?` + DESC；写反/不推进 = 对失败行死循环重试）',
  !pickBody.includes('id > ?') && !pickBody.includes('ORDER BY id ASC'),
);

// ------------------------------------- 2b. 调用端必须与候选查询同向（只改一处 = 静默取不到行）

check(
  '🔴 补全主循环与倒序同向：起手 `MAX(id) + 1`、用本批最后一行的 id 续接、不再有 After 版本' +
    '（只改查询不改调用端 ⇒ 首次游标 0 会让 `id < 0` 恒空，任务「秒完成」却一行没补）',
  implSrc.includes('var beforeId = db.getMaxPhotoId() + 1;') &&
    /beforeId = rows\[rows\.length - 1\]\.id;/.test(implSrc) &&
    !implSrc.includes('getPhotosMissingThumbnailsAfter('),
);

// ---------------------------------------------------- 3. 读文件头（尺寸 + 拍摄参数）
//
// 2026-10-06 起 `readOriginalSize` 改名为 `readHeaderMeta` 并**顺带**返回 `exif` —— 尺寸与
// 拍摄参数装在同一个文件头的同一段字节里，分两次调用就是同一个文件被打开两遍。
// ⚠️ 锚点跟着改名走：这里钉的是**新名字**（旧名残留 = 两个函数各读一次文件头，见
//    `exif-backfill-regression.js` 里那条「readOriginalSize 不得再现」）。

const sizeFn = bodyOf(implSrc, 'async function readHeaderMeta(', '\n}');
check('夹具自证：取到了 readHeaderMeta 的函数体', sizeFn.length > 0);
check('readHeaderMeta 用 sharp 的 metadata()', sizeFn.includes('.metadata()'));
check('🔴 readHeaderMeta 只接受正尺寸（0 视为读不到）', sizeFn.includes('meta.width > 0') && sizeFn.includes('meta.height > 0'));
check('🔴 readHeaderMeta 不碰 toBuffer 的 info（那是缩略图尺寸，会写错整库分辨率）', !sizeFn.includes('toBuffer'));
check('🔴 全文件不出现 resolveWithObject（防止有人改用 toBuffer 的 info 当原图尺寸）', !implSrc.includes('resolveWithObject'));
check('readHeaderMeta 读失败时静默返回 null，不抛', sizeFn.includes('catch') && sizeFn.includes('return null'));

// ---------------------------------------------------- 4. processOne：同一实例、不做白工

const oneBody = bodyOf(implSrc, 'async function processOne(row) {');
check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);
check('processOne 会读取文件头', oneBody.includes('readHeaderMeta('));
// 🔴 锚点在 2026-10-06 换了形态：接线统一收进 `src/main/sharp-input.js`（与网页端共用），
//    主进程只留薄壳 ⇒ 旧锚点 `var instance = loadSharp()(` 消失了。
//    ⚠️ **这是本文件第二次犯同一个错**（上次是「把入参写进锚点」）：锚点一旦钉具体实现调用，
//       抽象一层就假红 —— 而假红与真回归在输出上长得一模一样。
//       ⇒ 改成钉**行为链**：同一个标识符被 readHeaderMeta 与 resize 共用、且顺序不变。
//       `[\s\S]*?` 是顺序要求本身（match 顺序 = 源码顺序）。
// 🔴 2026-10-07 第三次：缩略图那一刀收进了 `thumb-format.js#resizeThumb()`，
//    `thumb = await instance…` 这个形态也没了（变成 `thumb = await resizeThumb(instance, …)`）。
//    ⚠️ 这次**不再把新函数名钉进去** —— 那只是把同一个错再犯一遍。锚点末段改成
//    「`thumb` 由**某个**以 `instance` 为第一实参的调用产出」，两种写法都能命中：
//      · 老形态 `thumb = await instance.rotate()…`
//      · 新形态 `thumb = await resizeThumb(instance, …)`
//    契约本身没变：**同一个实例**（文件只打开一次）且顺序是「先读头、后出图」。
const instChain = oneBody.match(
  /\bvar instance = \w+\.instance;[\s\S]*?readHeaderMeta\(instance\)[\s\S]*?\bthumb = await (?:\w+(?:\.\w+)*\s*\(\s*)?instance\b/,
);
check('🔴 拿尺寸与生成缩略图共用同一个 sharp 实例（文件只打开一次）', !!instChain);
// 「共用同一实例」的前提是那个实例**能读这个文件**：来源必须是兜底入口。
// 写回 `loadSharp()(path)` 会让 bmp / ico / cr2 重新变成「扫得进来、一张也出不了图」。
check(
  '🔴 实例必须来自兜底入口（否则 libvips 读不了的格式又变成空承诺）',
  oneBody.includes('createSharpInput('),
);
check('🔴 metadata 取在 resize 之前（同一实例），顺序不能颠倒', !!instChain);
check(
  '🔴 缺尺寸判定同时判 width 与 height（库里存 0，两个都要判）',
  /var needSize = [^;]*row\.width > 0[^;]*row\.height > 0/.test(oneBody),
);
check('视频不参与尺寸回填（sharp 读不了视频）', /var needSize = [^;]*!isVideo/.test(oneBody));
check(
  '🔴 dHash 已存在时跳过 computeDhash（否则扩谓词后会白全解码一整库）',
  oneBody.includes('row.dhash && String(row.dhash).trim()'),
);
check('isVideo 只算一次，不再散落重复调用', (oneBody.match(/isVideoPath\(/g) || []).length === 1);

// ---------------------------------------------------- 5. 写入：尺寸不降级

// 判据不是「某段文本里出现过守卫」，而是**逐处检查**：只要有一处 `updatePhotoDimensions`
// 不在「正尺寸」守卫之下，一次运行就足以把整库分辨率写成 0，而且不报任何错。
// 所以扫全文所有调用点，逐个回看它前面最近的那个守卫。
{
  const dimSites = [];
  {
    const re = /db\.updatePhotoDimensions\(/g;
    let m;
    while ((m = re.exec(implSrc)) !== null) dimSites.push(m.index);
  }
  check('夹具自证：main.js 里找得到 updatePhotoDimensions 调用点', dimSites.length > 0);
  const unguarded = dimSites.filter((i) => {
    const before = implSrc.slice(Math.max(0, i - 240), i);
    // 守卫的左花括号与被检查的调用之间不许再有别的语句（`[^{}]*$`）
    return !/if\s*\([^)]*width\s*>\s*0[^)]*height\s*>\s*0[^)]*\)\s*\{[^{}]*$/.test(before);
  });
  check(
    '🔴 每一处 updatePhotoDimensions 都在「正尺寸」守卫之下（不把已有真实值覆盖成 0）',
    unguarded.length === 0,
    unguarded.length ? '未受守卫的调用点偏移 ' + unguarded.join(',') : '',
  );
}

// ---------------------------------------------------- 6. 数据库侧的写入方法

check('database.js 提供 updatePhotoDimensions', dbSrc.includes('updatePhotoDimensions(photoId, width, height)'));
check(
  'updatePhotoDimensions 写的就是 photos 的 width / height 两列',
  dbSrc.includes('UPDATE photos SET width = ?, height = ? WHERE id = ?'),
);

// ---------------------------------------------------- 6b. 行为面：候选集必须真的会收敛

// 上面全是「读源码文本」的断言，而这次事故的教训正是**静态断言证明不了行为**：
// 契约曾经完整地写在孤儿文件里，文本断言 37 项全过，线上却一行尺寸都没写。
// 所以这里用真库把最致命的那条性质跑一遍：**补上尺寸之后，候选集必须缩小**。
// 这条性质一旦坏掉，症状是「进度条分母百万级、任务永远跑不完」，且没有任何报错。
{
  const os = require('node:os');
  const PhotoDatabase = require(path.join(ROOT, 'src', 'database.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-backfill-'));
  const dbPath = path.join(dir, 'photos.db');
  const dropDb = () => {
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
  };

  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    // 🔴 必须补这一步：候选查询 `getPhotosMissingThumbnailsBefore()` 的 SELECT 里带着
    //    `file_hash`，而它和 `dhash` 一样是 `ensureDuplicateHashSchema()` 延迟迁移出来的列。
    //    真实调用链里由 `runThumbnailBackfill` 开跑前那次 `dbWriteQueue.run` 保证；
    //    夹具若省掉它，取批那一刻就是 `no such column: file_hash`（本守护 2026-10-06 真撞过）。
    db.ensureDuplicateHashSchema();
    const rootId = db.addRootFolder('C:\\meta\\root');
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

    // 三行**只缺尺寸**：有缩略图 + 有 dhash，正是原 bug 里永远出不了候选集的那一类
    for (let i = 1; i <= 3; i++) {
      const filePath = 'C:\\meta\\root\\f\\p' + i + '.jpg';
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\meta\\root\\f',
        fileName: 'p' + i + '.jpg',
        filePath,
        fileSize: 10,
        fileType: 'jpg',
        width: 0,
        height: 0,
        dateTaken: '2026-01-01T00:00:00',
        dateModified: '2026-01-01T00:00:00',
        thumbnail: thumb,
        hasThumbnail: 1,
        thumbSize: 256,
        thumbFormat: 'jpeg',
      });
      db.updatePhotoDhash(i, '0000000000000000', [0], '2026-01-01T00:00:00', 10);
    }

    const before = db.getMissingThumbnailCount();
    check(
      '夹具自证：只有「缺尺寸」的行也计为待补（分母非零；否则下面那条断言没有意义）',
      before === 3,
      '实得 ' + before,
    );

    // 活代码 processOne 的写入端：拿到正尺寸才写
    for (let i = 1; i <= 3; i++) db.updatePhotoDimensions(i, 4000, 3000);

    // 2026-10-06 起「补上尺寸」**不再**够：这三行还没有 `exif_mtime`（拍摄参数没读过），
    // 而「没看过 EXIF」也是待补条件之一（见 `database.js#_sqlNeedsExifExpr()`）。
    // 这条断言不是「顺手放宽」——它同时钉死了「EXIF 支确实并进了同一个谓词」。
    const afterDims = db.getMissingThumbnailCount();
    check(
      '🔴 行为面：只补尺寸还不够 —— 拍摄参数没读过时仍算待补（EXIF 支确实并进了同一谓词）',
      afterDims === 3,
      '实得 ' + afterDims,
    );

    // processOne 的另一半写入端：拍摄参数。内容全 null 也**必须**写标记 —— 没有 EXIF 是常态
    // （截图 / 网图 / PNG），不写标记这一行就永远出不了候选集。
    for (let i = 1; i <= 3; i++) db.updatePhotoExif(i, null, '2026-01-01T00:00:00');

    const after = db.getMissingThumbnailCount();
    check(
      '🔴 行为面：尺寸与拍摄参数都补上后候选集收敛到 0（原 bug 的卡点 —— 不写标记则永不收敛）',
      after === 0,
      '实得 ' + after,
    );

    // 反向：写 0 的行必须**回到**候选集。否则「不降级」就退化成「假装补过就再也不过问」。
    db.updatePhotoDimensions(1, 0, 0);
    const afterZero = db.getMissingThumbnailCount();
    check(
      '行为面：尺寸被写成 0 的行重新回到候选集（0 视为缺失，不是「已补」）',
      afterZero === 1,
      '实得 ' + afterZero,
    );

    // 谓词口径：has_thumbnail / dhash / 尺寸 / EXIF 标记都在时，这一行就彻底出候选集
    const picked = db.getPhotosMissingThumbnailsBefore(999999, 10);
    check(
      '夹具自证：候选查询返回的行带着 width / height / dhash / exif_mtime（上层靠它们判断该不该跳过重算）',
      picked.length === 1 &&
        'width' in picked[0] &&
        'height' in picked[0] &&
        'dhash' in picked[0] &&
        'exif_mtime' in picked[0],
      JSON.stringify(picked[0] || null),
    );

    // 方向（行为面）：让 3 号也缺尺寸，剩下的待补行就是 {1, 3} —— 倒序必须**先给 3**
    db.updatePhotoDimensions(3, 0, 0);
    const desc = db.getPhotosMissingThumbnailsBefore(999999, 10);
    check(
      '🔴 行为面：候选行按 id **倒序**返回（最新入库优先）——先给 3 再给 1',
      desc.length === 2 && desc[0].id === 3 && desc[1].id === 1,
      JSON.stringify(desc.map((r) => r.id)),
    );

    // 游标（行为面）：以 3 为界再取，必须**严格小于** 3 —— 这就是「不对失败行死循环重试」的机制。
    // 若把谓词写法与排序方向弄反，这里会原样把 3 再取回来（同一轮无限重试）。
    const strictlyBefore = db.getPhotosMissingThumbnailsBefore(3, 10);
    check(
      '🔴 行为面：游标是严格上界（以 3 为界取不到 3）——同一轮不会重复取到刚失败的行',
      strictlyBefore.length === 1 && strictlyBefore[0].id === 1,
      JSON.stringify(strictlyBefore.map((r) => r.id)),
    );
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 不要把「跑不起来」伪装成通过：静默跳过的行为断言正是假绿的温床。
    check(
      '行为面：候选集收敛实验未抛错（若报 NODE_MODULE_VERSION，用 electron 跑本脚本，别用纯 node）',
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
    dropDb();
  }
}

// ---------------------------------------------------- 6.5 缩略图失败不许连累元数据（2026-10-06）

// 背景：`processOne` 原来只有一个 try 兜全局，而 `toBuffer()`（真正解码）排在
// `updatePhotoDimensions` / `updatePhotoExif` 之**前** ⇒ 一次解码失败会把**已经到手**的
// 尺寸与拍摄参数一起丢掉。本机实测那个被截断的 JPEG：`metadata()` 明明读出了
// 4608x3456 + 9,687B EXIF，却因为解码失败一样都没写进库 —— 于是**每一轮都白读 1.15 MB**。
// 同一处还漏了另一半：失败的行**不留任何痕迹**（width=0 / dhash=null / exif_ver=null），
// 库里分不出「还没轮到」与「试过失败了」，而候选谓词里的 `has_thumbnail = 0` 恒为真
// ⇒ 每轮开局重试、永不收敛（本机实测 9 个 18 MB 的 .CR2 正好排在全库最高 id）。
{
  const poBody = bodyOf(implSrc, 'async function processOne(row) {');
  check('夹具自证：取到了 processOne 的函数体', poBody.length > 0);
  const iThumbCatch = poBody.indexOf('catch (eThumb)');
  check(
    '🔴 缩略图生成必须单独一层 try/catch（`catch (eThumb)`）—— 不能与外层那个兜底共用',
    iThumbCatch > 0,
  );
  const iDims = poBody.indexOf('updatePhotoDimensions');
  const iExif = poBody.indexOf('updatePhotoExif');
  check(
    '🔴 写尺寸 / 写拍摄参数必须排在缩略图 catch **之后**（解码失败也要把 metadata 读到的东西写进库）',
    iThumbCatch > 0 && iDims > iThumbCatch && iExif > iThumbCatch,
    'catch=' + iThumbCatch + ' dims=' + iDims + ' exif=' + iExif,
  );
  check(
    '🔴 缩略图失败后必须调 recordThumbFailure（否则失败不留痕迹 ⇒ 每轮白重试、永不收敛）',
    poBody.includes('recordThumbFailure('),
  );
  // ⚠️ 顺序反过来的样子很容易「看起来更整齐」：把 `catch (eThumb)` 挪到函数末尾。
  //    那样前三条里只有第二条能挡住它 —— 所以第二条**必须**存在，不能嫌它啰嗦。
}

{
  const rtfBody = bodyOf(implSrc, 'async function recordThumbFailure(row, err, sharedBuf) {');
  check('夹具自证：取到了 recordThumbFailure 的函数体', rtfBody.length > 0);
  // 🔴 2026-10-06：可达性判据搬进共用方法 `fileReachableForFailureStamp()`（现在有**两个**
  //    盖章点：解码路 `recordThumbFailure` + 文件头路 `recordHeaderFailure`）。
  //    于是这里改成「两个盖章点都得走共用闸门」——比原来只钉一个函数体更强：
  //    单钉一处时，新加的那个盖章点可以完全不判可达性而断言照样绿。
  check(
    '🔴 只有「文件读得到」才盖失败章（盘没插时盖章 = 把整个图库的补全永久挡掉，且不会自愈）',
    rtfBody.includes('fileReachableForFailureStamp(') && rtfBody.includes('markThumbFailed('),
  );
  check(
    '🔴 「读不到」那一支必须 warn 级留现场（生产档 info 是静默的 ⇒ 零现场）',
    rtfBody.includes('logger.warn'),
  );
  check(
    '🔴 失败标记必须写「该行当前的 date_modified」，不能写当前时间（写时间戳 = 这行永远回不来）',
    rtfBody.includes('row.date_modified'),
  );

  const reachBody = bodyOf(implSrc, 'function fileReachableForFailureStamp(row, sharedBuf) {');
  check('夹具自证：取到了 fileReachableForFailureStamp 的函数体', reachBody.length > 0);
  check(
    '🔴 可达性判据优先用「共享读取拿到了字节」，否则退回 existsSync',
    reachBody.includes('sharedBuf') && reachBody.includes('existsSync'),
  );
}

// 🔴 2026-10-06 第二个盖章点：**文件头读不出来**（覆盖候选谓词第二支的「缺尺寸 / 缺拍摄参数」）。
//    没有它的时候，读不了的文件从第一支漏进第二支、永远留在候选集里（真库实测 10/10 命中）。
{
  // ⚠️ 上面那个块里的 `poBody` 是块作用域，这里要自己取一份。
  const poBody2 = bodyOf(implSrc, 'async function processOne(row) {');
  check('夹具自证：取到了 processOne 的函数体（header 路）', poBody2.length > 0);
  const rhfBody = bodyOf(implSrc, 'async function recordHeaderFailure(row, sharedBuf) {');
  check('夹具自证：取到了 recordHeaderFailure 的函数体', rhfBody.length > 0);
  check(
    '🔴 文件头路盖章点同样要过可达性闸门（与解码路共用一份，不许各写一份）',
    rhfBody.includes('fileReachableForFailureStamp(') && rhfBody.includes('markHeaderFailed('),
  );
  check('🔴 文件头路「读不到」也要 warn 留现场', rhfBody.includes('logger.warn'));
  check(
    '🔴 文件头路同样必须写「该行当前的 date_modified」（否则这行永远回不来）',
    rhfBody.includes('row.date_modified'),
  );

  // ⚠️ **不能**用 `header === null` 当判据：它也可能是「压根不需要读」（尺寸与 EXIF 都齐了），
  //    那样会把没试过的行也盖成失败章 —— 而那是**永久**排除。必须另有一个「试过」标志。
  check(
    '🔴 必须先判「试过读文件头」（headerTried）再盖章，不能只看 header === null',
    poBody2.includes('headerTried &&') && poBody2.includes('recordHeaderFailure('),
  );
  check(
    '🔴 headerTried 必须在**两处** readHeaderMeta 调用之前置位（漏一处 = 那条路的失败永不盖章）',
    (poBody2.match(/headerTried = true/g) || []).length === 2,
    String((poBody2.match(/headerTried = true/g) || []).length),
  );
  // 顺序：盖章点在缩略图 catch **之后**。CR2 那条路上 `readHeaderMeta()` 自己吞掉异常返回 null，
  // 根本走不到 `catch (eThumb)` ⇒ 两个章是两件独立的事，顺序错了就少盖一个。
  {
    const iHeaderStamp = poBody2.indexOf('recordHeaderFailure(');
    const iThumbCatch2 = poBody2.indexOf('catch (eThumb)');
    check(
      '🔴 文件头盖章点必须排在缩略图 catch 之后（否则解码抛异常时它被跳过）',
      iThumbCatch2 > 0 && iHeaderStamp > iThumbCatch2,
      'catch=' + iThumbCatch2 + ' headerStamp=' + iHeaderStamp,
    );
  }
  // dHash 的失败语义是**返回 null、从不抛** ⇒ 不显式盖章就永远留在第二支的「缺 dHash」里。
  check(
    '🔴 dHash 算不出时也要盖解码路失败章（computeDhash 返回 null 不抛，不盖就是永久留候选）',
    poBody2.includes('recordThumbFailure(row, null, sharedBuf)'),
  );
}

// ---------------------------------------------------- 6c. 行为面：失败记账真的会收敛（2026-10-06）

// 「读不了的文件每轮白重试」这条死循环，只有行为面能证明修好了 ——
// 静态断言最多证明 `thumb_fail_mtime` 出现在谓词文本里。
// 这里跑三条性质：① 盖章后退出候选集；② 文件日期一变就自己回来（自愈）；
// ③ `date_modified` 为 NULL 的行也得能退出（IFNULL 那一支，裸比较会在这类行上失效）。
{
  const os = require('node:os');
  const PhotoDatabase = require(path.join(ROOT, 'src', 'database.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-fail-'));
  const dbPath = path.join(dir, 'photos.db');
  const cleanup = () => {
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
  };

  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    // 🔴 两处延迟迁移**都必须补**：候选查询的 SELECT 同时带 `file_hash` 与 `dhash`
    //    （见 `getPhotosLackingThumbnailBefore`），这两列分别由
    //    `ensureDuplicateHashSchema()` 与 `ensureDhashSchema()` 延迟加出来。
    //    真实调用链里由 `runThumbnailBackfill` 开跑前那次 `dbWriteQueue.run` 同时保证
    //    （见 main.js:2531-2532 的两条 `if`）。
    //    ⚠️ 6b 节只写了一个也照样过 —— 因为那里调了 `updatePhotoDhash()`，而它自己
    //    内部就 `this.ensureDhashSchema()`；本节不写 dHash，于是 `dhash` 列根本不存在，
    //    取批那一刻直接 `no such column: dhash`（本守护 2026-10-06 真撞过）。
    //    ⇒ 夹具照抄「真实链路保证了什么」，别照抄上一个夹具碰巧能跑的样子。
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();
    const rootId = db.addRootFolder('C:\\thumbfail\\root');

    // 五行都缺缩略图：
    //   #1 正常行 —— 验「盖章后退出」+「日期一变就回来」
    //   #2 对照组 —— 从头到尾都不该消失（最后被成功补上缩略图，用来验反向）
    //   #3 `date_modified` 为 NULL —— 验「没日期也得能盖章退出」
    //   #4 专门验「失败标记写成 NULL」这个实现细节
    //   #5 专门验「盖章后日期被清空」—— `IFNULL` 唯一的真牙（见本节末尾）
    const addRow = (i, dateModified) =>
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\thumbfail\\root\\f',
        fileName: 'q' + i + '.jpg',
        filePath: 'C:\\thumbfail\\root\\f\\q' + i + '.jpg',
        fileSize: 10,
        fileType: 'jpg',
        width: 0,
        height: 0,
        dateTaken: null,
        dateModified,
        thumbnail: null,
        hasThumbnail: 0,
        thumbSize: 0,
        thumbFormat: '',
      });
    addRow(1, '2026-01-01T00:00:00');
    addRow(2, '2026-01-01T00:00:00');
    addRow(3, null);
    addRow(4, '2026-05-05T05:05:05');
    addRow(5, '2026-06-06T06:06:06');

    const idsOf = (rows) =>
      rows
        .map((r) => r.id)
        .sort((a, b) => a - b)
        .join(',');
    const lack = () => db.getPhotosLackingThumbnailBefore(999999, 50);

    check(
      '夹具自证：五行缺缩略图的都在第一趟候选里',
      idsOf(lack()) === '1,2,3,4,5',
      '实得 ' + idsOf(lack()),
    );

    // 只给 #1 盖章 —— 模拟「文件在磁盘上、但 sharp 解不了」那一类
    db.markThumbFailed(1, '2026-01-01T00:00:00');
    check(
      '🔴 行为面：盖过失败章的行**退出**候选集（否则每轮被取出、每轮白读一次盘、永不收敛）',
      idsOf(lack()) === '2,3,4,5',
      '实得 ' + idsOf(lack()),
    );

    // 文件被替换 ⇒ `date_modified` 变了 ⇒ 必须自己回到候选集（**不依赖重新扫描**）
    db.db
      .prepare('UPDATE photos SET date_modified = ? WHERE id = ?')
      .run('2026-09-09T09:09:09', 1);
    check(
      '🔴 行为面：文件的 date_modified 一变，失败行**自动回到**候选集（自愈，不靠扫描）',
      idsOf(lack()) === '1,2,3,4,5',
      '实得 ' + idsOf(lack()),
    );

    // #3 的 `date_modified` 是 NULL：盖章也得让它退出。
    // ⚠️ 这条断言**不**用来咬 `IFNULL`：谓词里 `date_modified` 为 NULL 时，裸 `< >` 得 NULL
    //    （当假）与 `IFNULL` 兜成 `''` 得假，**两种写法结果相同**，去掉 `IFNULL` 它照样绿
    //    （2026-10-06 实测，见文件末尾 #5 那段注释）。它咬的是「盖章这件事对没日期的行也生效」
    //    ——即 `markThumbFailed` 把 NULL 写成 `''` 而不是保持 NULL（写 NULL 会被当「没失败过」）。
    db.markThumbFailed(3, null);
    check(
      '🔴 行为面：date_modified 为 NULL 的行盖过章后同样退出（NULL 日期也要能收敛）',
      idsOf(lack()) === '1,2,4,5',
      '实得 ' + idsOf(lack()),
    );

    // #4：「失败标记留成 NULL」会怎样 —— 这是 `markThumbFailed()` 宁写空串不写 NULL 的理由。
    // 谓词第一支是 `thumb_fail_mtime IS NULL OR <日期比对>`，写 NULL 等于「看起来从没失败过」
    // ⇒ 该行**原地留在候选集**里，每轮被取出来、每轮白读一次盘。这里用裸 UPDATE 直接模拟
    // 「一个改成写 NULL 的实现」，把坑的机制钉成可执行证据。
    db.db.prepare('UPDATE photos SET thumb_fail_mtime = NULL WHERE id = ?').run(4);
    check(
      '🔴 行为面：失败标记写成 NULL 的行**留在**候选集（写 NULL = 白重试 ⇒ 必须写空串）',
      idsOf(lack()) === '1,2,4,5',
      '实得 ' + idsOf(lack()),
    );
    db.markThumbFailed(4, '2026-05-05T05:05:05');
    check(
      '🔴 行为面：同一个 id 改写成空串后立刻退出（与上一条对照，差别只在 NULL / 空串）',
      idsOf(lack()) === '1,2,5',
      '实得 ' + idsOf(lack()),
    );

    // 反向：**成功**补上缩略图的行，无论有没有盖章都不该再出现在第一趟候选里
    db.updatePhotoThumbnail(2, Buffer.from([0xff, 0xd8, 0xff, 0xdb]), { size: 256, format: 'jpeg' });
    check(
      '🔴 行为面：补上缩略图后退出第一趟候选（has_thumbnail 才是「有没有图」的唯一判据）',
      idsOf(lack()) === '1,5',
      '实得 ' + idsOf(lack()),
    );

    // #5：**这条才是 `IFNULL` 的牙**。前面四条都咬不住它 —— 因为「thumb_fail_mtime 写空串、
    // date_modified 为 NULL」这种组合下，裸比较 `'' <> NULL` 得 NULL（当假），
    // 与 `IFNULL` 兜成 `'' <> ''` 得假，**结果一模一样**（2026-10-06 实测：删掉两侧 IFNULL，
    // 行为面四条全绿、只有静态断言那条红）。
    // 真正会分叉的组合只有一个：**盖章时这行有日期，之后 `date_modified` 被清成 NULL**
    // （文件被删 / 重扫后日期清空 —— 状态确实变了，本该重试）。
    //   · 有 IFNULL：`'旧日期' <> ''` → 真 ⇒ 重新入选，重试
    //   · 裸比较  ：`'旧日期' <> NULL` → NULL(假) ⇒ **永久排除**，这行再也不会被处理
    // 两种写法在这条路径上给出相反结果，这才是 IFNULL 存在的理由。
    db.markThumbFailed(5, '2026-06-06T06:06:06');
    check(
      '夹具自证：盖章后 #5 退出（下面清空日期要看的起点）',
      idsOf(lack()) === '1',
      '实得 ' + idsOf(lack()),
    );
    db.db.prepare('UPDATE photos SET date_modified = NULL WHERE id = ?').run(5);
    check(
      '🔴 行为面：盖章后 date_modified 被清成 NULL ⇒ 该行回到候选集（裸比较会把它永久排除）',
      idsOf(lack()) === '1,5',
      '实得 ' + idsOf(lack()),
    );
  } catch (e) {
    check('行为面：失败记账实验未抛错', false, e && e.message);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    cleanup();
  }
}

// ------------------------------------ 6d. 行为面：两趟双游标必须互不干扰（2026-10-06）

// 6c 只验了第一趟的谓词。这次修复的另一半是**第一趟单独一条游标**（`thumbCursor`），
// 与第二趟的 `metaCursor` 各自从 `MAX(id)+1` 起手、各自递减。
//
// 为什么必须用行为面钉：第一趟跑起来后会**一路把游标拉到低位**（实机上拉到 id 1,889,290
// 那附近，因为再往下几万行全都已有缩略图、第一趟扫不到东西，会一直往下走）。此时第二趟
// 若共用这条游标，`WHERE id < 低值` 就把高位那几万行（1,889,291~1,981,503）**永久跳过**
// —— 不报错、不写日志、类型也正常，只是那些行的元数据再也补不上。
// 静态断言只能看见「有两个变量名」，看不见它们是否真的各走各的。
{
  const os = require('node:os');
  const PhotoDatabase = require(path.join(ROOT, 'src', 'database.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-pass-'));
  const dbPath = path.join(dir, 'photos.db');
  const cleanup = () => {
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
  };

  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    // 两条延迟迁移，理由同 6c 节（候选查询的 SELECT 同时带 file_hash 与 dhash）。
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();
    const rootId = db.addRootFolder('C:\\twopass\\root');
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

    // 三行都不写 EXIF ⇒ 三行都「缺元数据」，全在完整候选集里。
    // 差别只在缩略图：
    //   id 1 —— 缺缩略图（两趟都取得到）
    //   id 2 —— 缺缩略图（两趟都取得到）
    //   id 3 —— **有**缩略图，只缺元数据 ⇒ 只有第二趟取得到，且它是**最高 id**
    const addRow = (i, withThumb) =>
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\twopass\\root\\f',
        fileName: 'r' + i + '.jpg',
        filePath: 'C:\\twopass\\root\\f\\r' + i + '.jpg',
        fileSize: 10,
        fileType: 'jpg',
        width: 0,
        height: 0,
        dateTaken: null,
        dateModified: '2026-01-01T00:00:00',
        thumbnail: withThumb ? thumb : null,
        hasThumbnail: withThumb ? 1 : 0,
        thumbSize: withThumb ? 256 : 0,
        thumbFormat: withThumb ? 'jpeg' : '',
      });
    addRow(1, false);
    addRow(2, false);
    addRow(3, true);

    const idsOf = (rows) =>
      rows
        .map((r) => r.id)
        .sort((a, b) => a - b)
        .join(',');

    // 起始游标：两趟都从 `MAX(id) + 1` 起手（严格上界，最大的那一行也扫得到）
    const startCursor = db.getMaxPhotoId() + 1;
    const thumbBatch = db.getPhotosLackingThumbnailBefore(startCursor, 50);
    const metaBatch = db.getPhotosMissingThumbnailsBefore(startCursor, 50);

    check(
      '夹具自证：两趟起手游标相同且能覆盖最高 id（`MAX(id)+1` 是严格上界）',
      startCursor === 4 && idsOf(metaBatch) === '1,2,3',
      '游标 ' + startCursor + ' / 第二趟实得 ' + idsOf(metaBatch),
    );
    check(
      '🔴 第一趟只取「缺缩略图」的（有缩略图的 id 3 必须留给第二趟）',
      idsOf(thumbBatch) === '1,2',
      '实得 ' + idsOf(thumbBatch),
    );

    // 第一趟跑完一批后，它自己的游标被拉到本批最低位（这里是 id 1）。
    // 模拟调用端：`thumbCursor = rows[rows.length - 1].id`
    const thumbCursorAfter = thumbBatch[thumbBatch.length - 1].id;

    // 🔴 核心断言：第二趟用**自己的**游标（还是 4），必须仍能取到最高 id 的 id 3。
    //    如果实现改成共用一条游标（`id < thumbCursorAfter` = `id < 1`），id 3 就取不到了。
    const metaFromOwnCursor = idsOf(db.getPhotosMissingThumbnailsBefore(startCursor, 50));
    const metaFromSharedCursor = idsOf(db.getPhotosMissingThumbnailsBefore(thumbCursorAfter, 50));
    check(
      '🔴 行为面：第一趟跑完（游标降到 1）后，第二趟用自己的游标仍取到 id 3',
      metaFromOwnCursor === '1,2,3',
      '实得 ' + metaFromOwnCursor,
    );
    check(
      '夹具自证：共用第一趟那条游标确实会**丢掉**高位的 id 3（证明上面那条断言不是白写的）',
      metaFromSharedCursor === '',
      '实得 ' + metaFromSharedCursor,
    );
  } catch (e) {
    check('行为面：两趟双游标实验未抛错', false, e && e.message);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    cleanup();
  }
}

// ------------------------------ 6e. 行为面：第二支的两路失败标记（2026-10-06）

// 这一节回答的是：**候选谓词第二支到底收不收敛**。
// 静态断言只能证明 `header_fail_mtime` 出现在谓词文本里 —— 而这次要修的死循环
// （读不了的文件从第一支漏进第二支、每轮白读原文件）恰恰是**行为**问题。
// 真库实测现场：9 个 18 MB 的 .CR2 + 1 个截断 JPEG，已盖章的 **10/10 仍命中第二支**。
{
  const os = require('node:os');
  const PhotoDatabase = require(path.join(ROOT, 'src', 'database.js'));
  // 版本号从活代码取（写死 2 会在升版那天变成假绿）
  const EXIF_VER = require(path.join(ROOT, 'src', 'main', 'exif-meta.js')).EXIF_SCHEMA_VERSION;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-gate-'));
  const dbPath = path.join(dir, 'photos.db');
  const cleanup = () => {
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
  };

  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    // 与 6c/6d 同理：`dhash` / `file_hash` 是延迟迁移列，候选查询的 SELECT 带它们
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();
    const rootId = db.addRootFolder('C:\\thumbgate\\root');

    /**
     * 造一行。`spec` 决定它像真实库里哪一类：
     *   {}                        → 还没轮到（什么标记都没有）
     *   { thumb: true }           → 解码路失败（缩略图 / dHash 做不出）
     *   { header: true }          → 文件头读不出来
     *   { width / dhash / exif }  → 各内容列
     */
    const addRow = (i, spec) => {
      const dateModified = '2026-03-03T03:03:03';
      const filePath = 'C:\\thumbgate\\root\\f\\g' + i + '.jpg';
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\thumbgate\\root\\f',
        fileName: 'g' + i + '.jpg',
        filePath,
        fileSize: 10,
        fileType: 'jpg',
        width: spec.width || 0,
        height: spec.width || 0,
        dateTaken: null,
        dateModified,
        thumbnail: null,
        hasThumbnail: spec.hasThumb ? 1 : 0,
        thumbSize: 0,
        thumbFormat: '',
      });
      // ⚠️ `insertPhoto()` **没有返回值**（它不 `return stmt.run(...)`），拿它的结果当 id 会得到
      //    `undefined`，后面所有 `WHERE id = ?` 都静默变成 no-op —— 夹具会「全都留在候选集里」，
      //    看起来像谓词坏了。必须按 `file_path` 回查 id。
      const id = db.db.prepare('SELECT id FROM photos WHERE file_path = ?').get(filePath).id;
      if (spec.dhash) db.db.prepare('UPDATE photos SET dhash = ? WHERE id = ?').run(spec.dhash, id);
      if (spec.exif)
        db.db
          .prepare('UPDATE photos SET exif_mtime = ?, exif_ver = ? WHERE id = ?')
          .run(dateModified, EXIF_VER, id);
      // 标记列一律走真实写入口（顺带验「空值写空串」那条规则）
      if (spec.thumb) db.markThumbFailed(id, dateModified);
      if (spec.header) db.markHeaderFailed(id, dateModified);
      return id;
    };

    // #1 还没轮到：什么都没有 ⇒ 该在候选里
    addRow(1, {});
    // #2 CR2 型：两个标记都盖了（头读不出 ⇒ 解码必然也读不出）⇒ 该退出
    addRow(2, { thumb: true, header: true });
    // #3 截断 JPEG 型：**头读到了**（尺寸 / EXIF 都齐），只有解码失败 ⇒ 它唯一缺的是 dHash，
    //    该由 `thumb_fail_mtime` 把它门掉；header 那一列必须保持 NULL
    addRow(3, { thumb: true, width: 4608, exif: true });
    // #4 只缺拍摄参数：有缩略图、有 dHash、有尺寸 ⇒ 该在候选里（走第二支的 exif 子条件）
    addRow(4, { hasThumb: true, width: 4000, dhash: 'aaaaaaaaaaaaaaaa' });
    // #5 只有**解码**章、内容列全缺 ⇒ **必须仍在候选里**。
    //    这一条是本节的承重反例：证明两个章**不能互相替代** —— 若把第二支写成
    //    「任一标记盖了就算失败」，#5 会被错误排除，它的尺寸与 EXIF 就永远补不上了。
    addRow(5, { thumb: true });

    const cand = () =>
      db.db
        .prepare(
          'SELECT id FROM photos WHERE ' + db._sqlBackfillPendingExpr() + ' ORDER BY id',
        )
        .all()
        .map((r) => r.id)
        .join(',');

    check(
      '夹具自证：候选集 = 还没轮到的 + 只缺 EXIF 的 + 只有解码章的（三行）',
      cand() === '1,4,5',
      '实得 ' + cand(),
    );
    check(
      '🔴 行为面：CR2 型（头读不出 + 解码失败，两章齐全）**退出**候选集',
      cand().indexOf('2') === -1,
      '实得 ' + cand(),
    );
    check(
      '🔴 行为面：截断 JPEG 型（只缺 dHash、只有解码章）也**退出**候选集 —— 靠 dhash 子条件被 thumb 章门住',
      cand().indexOf('3') === -1,
      '实得 ' + cand(),
    );
    check(
      '🔴 行为面：只盖解码章的行**不许**被排除（两个章不能互相替代，否则尺寸/EXIF 永远补不上）',
      cand().indexOf('5') >= 0,
      '实得 ' + cand(),
    );

    // #5 补上文件头路章 ⇒ 尺寸与 EXIF 两项也退出 ⇒ 整行离开候选
    db.markHeaderFailed(5, '2026-03-03T03:03:03');
    check(
      '🔴 行为面：补盖文件头章后，只缺尺寸/EXIF 的行**退出**候选集（第二支收敛）',
      cand() === '1,4',
      '实得 ' + cand(),
    );

    // 自愈：文件被替换 ⇒ date_modified 一变 ⇒ 两个标记同时失效 ⇒ 立刻回到候选集
    db.db.prepare('UPDATE photos SET date_modified = ? WHERE id = ?').run('2026-09-09T09:09:09', 5);
    check(
      '🔴 行为面：date_modified 一变，两路失败标记**同时**自愈、这一行回到候选集',
      cand() === '1,4,5',
      '实得 ' + cand(),
    );

    // 反向：#4 补齐拍摄参数（读完文件头写标记）⇒ 它离开候选集
    db.db
      .prepare('UPDATE photos SET exif_mtime = ?, exif_ver = ? WHERE id = ?')
      .run('2026-03-03T03:03:03', EXIF_VER, 4);
    check(
      '🔴 行为面：拍摄参数补上后只缺 EXIF 的行退出候选（判标记列、不判内容列有没有值）',
      cand() === '1,5',
      '实得 ' + cand(),
    );
  } catch (e) {
    check('行为面：第二支失败标记实验未抛错', false, e && e.message);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    cleanup();
  }
}

// ---------------------------------------------------- 7. 登记进全量回归

check(
  '本守护已登记进 scripts/run-regressions.js',
  runSrc.includes("'photo-metadata-backfill-regression.js'"),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[photo-metadata-backfill-regression] 照片元数据回填链路契约\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[photo-metadata-backfill-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[photo-metadata-backfill-regression] PASS（' + notes.length + ' 项）\n');
