'use strict';
/**
 * 「缩略图与 dHash 共用一次解码」回归（2026-10-06）。
 *
 * 背景：`main.js#processOne` 同一个文件既要生成缩略图、又要算 dHash。旧写法是
 * `sharp(path)` 出缩略图、再 `computeDhash(path)` —— **同一张图被完整解码两遍**。
 * 真机 40 张实测：53.9ms → 22.5ms，**省 58%**（这部分是纯白干的 CPU + 读盘）。
 * 修法：`perceptual-hash.js#computeDhashFromPipeline(pipeline)`，从已打开的管线 clone 出去。
 *
 * 2026-10-06 扩面 —— **再加一样产物：查重指纹（SHA-256）**。
 * 缩略图补全与「重复文件比对」在准入上**互斥**（`thumbnailBackfillBlockReason` /
 * `duplicateHashBlockReason` 互相拦截）⇒ 两者永远串行。而它们读的是同一个文件的同一份字节：
 * 补全这边 `sharp` 解码一遍，查重那边 `processDupHashRowsChunk` 再逐字节读一遍。
 * 现在 `processOne` 改成「一次 `readFile` 的 Buffer 同时喂 `sharp` 与 `crypto`」——
 * 一次读盘出**三样**（缩略图 / dHash / SHA-256）。CPU 侧几乎不增，省的是整次读盘。
 *
 * 这一扩面又带来两条必须钉住的静默失效（本脚本 [2b] / [2c] 两组）：
 *   - 候选 SELECT 少了 `file_hash` ⇒ 每行都判成「缺指纹」⇒ 对全库候选反复重算 SHA（白烧读盘）；
 *   - 前置的 `ensureDuplicateHashSchema()` 掉了 ⇒ 老库上取批那一刻 `no such column`，回填当场挂。
 *
 * 🔴 为什么这条必须被钉住（两处静默失效都足以毁掉数据）：
 *
 * 1. **dHash 是相似聚类的输入**。它不是「差不多的指纹」，而是阈值比较的**被减数**：
 *    位差会直接把阈值边缘的配对翻面（本机真实库就是 198 万行）。所以「共用解码」这条优化
 *    的**唯一合法性前提是逐位相同**。实测 40/40 相同 —— 本脚本把它变成每次 CI 都验的事实。
 *
 * 2. **顺序是承重墙**。`processOne` 里那个实例接下来要 `.rotate()`（缩略图要跟随 EXIF 方向），
 *    而 dHash 历来**不旋转**（旧路径 `computeDhash(row.file_path)` 就没有 `.rotate()`）。
 *    一旦有人把取 dHash 的语句挪到 `.rotate()` 之后，**带方向信息的照片会全部换一套位** ——
 *    不报错、不写日志，只是相似照片的判定从此不一样了。
 *    ⚠️ 受害面**仅限带 EXIF 方向**的照片：无方向的图 `.rotate()` 是空操作，位不变。
 *    本脚本两组期望值分开验，避免把「空操作」误读成「顺序无所谓」。
 *
 * 判定口径：静态部分走 **acorn 剥注释**（本文件与 `main.js` 的注释里都引用了 `.rotate()` 与
 * `computeDhash(row.file_path)` 这些旧写法，不剥注释就会假绿）；行为部分用**运行时生成的真图**
 * （含一张 EXIF orientation=6 的），不依赖仓库里任何二进制夹具。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main.js');
const DB = path.join(ROOT, 'src', 'database.js');
const HASH = path.join(ROOT, 'src', 'main', 'perceptual-hash.js');
const FILE_HASH = path.join(ROOT, 'src', 'main', 'file-hash.js');
/** 缩略图「缩放 + 编码」的唯一出口 —— 旋转那一刀 2026-10-07 从 main.js 收进了这里。 */
const THUMB_FMT = path.join(ROOT, 'src', 'main', 'thumb-format.js');

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  \u2713 ' + name);
  } else {
    failed++;
    console.log('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 剥掉注释，但**保持长度与换行** —— 否则「这句代码在不在 `.rotate()` 之前」会被注释骗过去。
 * ⚠️ 走 acorn（它自己懂注释与正则字面量）：状态机版不认含引号的正则，会从那里错位。
 * 本项目已有先例，见 `face-order-regression.js:62`、`home-page-regression.js:67`。
 */
function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}
function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}
/**
 * 取「从某个签名到另一个签名」之间的整段。
 *
 * ⚠️ `bodyOf` 对 `runThumbnailBackfill` **不能用**：那个函数体里 `try {` … `} finally {`
 * 的闭合括号本身就长在 2 列上，`'\n  }'` 会匹配到 `} finally` 那行，把 finally 整段切掉
 * —— 而「写了指纹就失效重复分组缓存」恰恰住在 finally 里，切掉了就变成假绿。
 */
function sliceBetween(src, fromSig, toSig) {
  const a = src.indexOf(fromSig);
  if (a < 0) return '';
  const b = src.indexOf(toSig, a + fromSig.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

// ============================================================ 1. 哈希核心必须同源

console.log('\n[1] 哈希核心只有一份');
{
  const hashSrc = stripComments(read(HASH));
  check(
    '夹具自证：acorn 确实剥掉了注释',
    !hashSrc.includes('一条硬约束') && !hashSrc.includes('逐位相同'),
  );
  check('hashFromRaw 存在（把 9×8 原始像素转 hex 的唯一入口）', /function hashFromRaw\s*\(/.test(hashSrc));

  const byPath = bodyOf(hashSrc, 'async function computeDhash(input) {', '\n}');
  const byPipeline = bodyOf(hashSrc, 'async function computeDhashFromPipeline(pipeline) {', '\n}');
  check('夹具自证：取到了两个函数的函数体', byPath.length > 0 && byPipeline.length > 0);
  check('🔴 两条路都调 hashFromRaw（否则位算法会各自漂）', 
    byPath.includes('hashFromRaw(raw)') && byPipeline.includes('hashFromRaw(raw)'),
  );
  check(
    '🔴 两条路用同一组算子（greyscale → resize(9,8,fill) → raw）',
    /greyscale\(\)[\s\S]*resize\(9, 8, \{ fit: 'fill' \}\)[\s\S]*\.raw\(\)/.test(byPath) &&
      /clone\(\)[\s\S]*greyscale\(\)[\s\S]*resize\(9, 8, \{ fit: 'fill' \}\)[\s\S]*\.raw\(\)/.test(byPipeline),
  );
  check(
    '🔴 computeDhashFromPipeline 内部 clone（不消费调用方那条管线）',
    byPipeline.includes('clone()'),
  );
  check(
    '🔴 两条路都**不许**出现 rotate（dHash 是不旋转的）',
    !byPath.includes('rotate') && !byPipeline.includes('rotate'),
  );
}

// ============================================================ 2. processOne 的取用姿势

console.log('\n[2] processOne 取 dHash 的位置');
{
  const mainSrc = stripComments(read(MAIN));
  // 🔴 夹具自证必须指向**那句话真正所在**的文件，否则恒真。
  //
  // 2026-10-08 复核实测：这里原来只有一条
  //   `check('夹具自证：main.js 剥注释后不再含那句提示性说明', !mainSrc.includes('否则带 EXIF 方向的图片'))`
  // —— **两个方向同时失效**，它不红、不报错、也不写日志（典型的「假牙」）：
  //   ① 「旋转那一刀」2026-10-07 已从 `main.js` 收进 `src/main/perceptual-hash.js`，
  //      那句话现在住在 `HASH` 里，`main.js` 根本没有 ⇒ 目标选错了文件；
  //   ② 就算选对文件，先 `stripComments` 再断言「不含这句**注释**」也是恒真的 ——
  //      剥注释这一步已经把它抹成空格了，源码怎么写都为真。
  // ⇒ 拆成两条各有牙的（形状照抄本文件 §1 的第 113 行那条）：
  //    · 第 1 条读 `HASH` 剥注释 —— stripComments 真坏掉时它会红（证明剥注释有效）；
  //    · 第 2 条读**未剥**的 `main.js` —— 那句说明被贴回 main.js 时它会红。
  check(
    '夹具自证：acorn 确实剥掉了注释（指向真正含这句的 perceptual-hash.js，而不是 main.js）',
    !stripComments(read(HASH)).includes('否则带 EXIF 方向的图片'),
  );
  check(
    '夹具自证：那句说明只许留在 perceptual-hash.js，不许贴回 main.js（贴回去会误导「位算法在那边」）',
    !read(MAIN).includes('否则带 EXIF 方向的图片'),
  );

  const oneBody = bodyOf(mainSrc, 'async function processOne(row) {');
  check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);
  check(
    '🔴 缩略图分支里用 computeDhashFromPipeline(instance) 白用那次解码',
    oneBody.includes('computeDhashFromPipeline(instance)'),
  );
  check(
    '🔴 仍然保留按路径的回落（已有缩略图、只缺 dHash 的那一大批走它）',
    oneBody.includes('computeDhash(row.file_path)'),
  );
  check(
    '🔴 用「试过了」的标志位而非结果本身判（结果 null = 解码失败，也是试过了）',
    oneBody.includes('dhashDecodeUsed'),
  );

  // -------------------------------------------------- 2a. 第二趟也必须共用同一个实例
  //
  // 2026-10-07：第二趟（`skipThumbnail`，已有缩略图只补元数据的那一批）原本是
  // 「建实例读文件头」+「`computeDhash(row.file_path)` 再重新打开整图解码」= **同一份字节读两遍**。
  // 而这一支恰恰行数最多（真库实测第二支候选 1,044,733 行）⇒ 多余的那次读盘被乘在这个量级上。
  // 真机 30 张（0.1~50 MB）实测 18,740ms → 5,551ms，**省 70%**。
  //
  // 🔴 必须钉住的两条：
  //   ① 建实例的**条件要把 `needDhash` 一起算进来** —— 只写 `(needSize || needExif)` 时，
  //      「只缺 dHash」的行根本拿不到实例 ⇒ 读两遍照旧，**不报错、不写日志、静态也全绿**
  //      （这是本轮差点漏掉的假绿）。
  //   ② 「已经打开过实例」这件事也要落到第二趟的 dHash 上，别让这条优化只活在注释里。
  const skipBranch = sliceBetween(mainSrc, 'if (skipThumbnail) {', '} else {');
  check('夹具自证：取到了 skipThumbnail 分支', skipBranch.length > 0);
  check(
    '🔴 第二趟的建实例条件必须含 needDhash（只看 needSize||needExif ⇒ 「只缺 dHash」的行读两遍）',
    /if \(needSize \|\| needExif \|\| needDhash\)/.test(skipBranch),
  );
  check(
    '🔴 第二趟把同一个实例交给 computeDhashFromPipeline（不再按路径重新打开）',
    /computeDhashFromPipeline\(siSkip\.instance\)/.test(skipBranch),
  );
  check(
    '🔴 第二趟仍然置 dhashDecodeUsed（下面靠它与结果一起判要不要退回按路径）',
    /dhashDecodeUsed = true/.test(skipBranch),
  );
  check(
    '🔴 建实例在读头与取 dHash **之前**（两个产物同一次打开）',
    skipBranch.indexOf('createSharpInput(') <
      skipBranch.indexOf('computeDhashFromPipeline(siSkip.instance)') &&
      skipBranch.indexOf('computeDhashFromPipeline(siSkip.instance)') >= 0,
  );
  check(
    '🔴 回落判据是「先看结果、再按路径」（只认标志位 ⇒ pipeline 算出 null 的行连老路都不给走）',
    /dhashDecodeUsed && dhashFromDecode/.test(oneBody),
  );

  // 顺序：取 dHash 必须早于「旋转那一刀」
  // ⚠️ 锚点在 2026-10-06 换了形态，两个坑一次踩全：
  //    ① **不要把入参写进锚点** —— 这里可能传 `sharedBuf || row.file_path`（共用一次读盘），
  //       写死入参会让断言在**没有任何真实回归**的情况下变红，假红和假绿一样坏。
  //    ② **更不要钉具体实现调用**（原锚点 `var instance = loadSharp()(`）：接线一旦收进
  //       `src/main/sharp-input.js`，调用点统一变成 `await createSharpInput(...)`，
  //       锚点就整体失效 —— 本轮真的红了 4 条，而契约（同一实例、顺序不变）完好无损。
  //    ⇒ 钉「**建实例这件事发生在哪里**」，不钉它是怎么建的。
  //
  // 🔴 2026-10-07 **第三次**踩同一个坑：`rotate()` 被收进 `resizeThumb()`
  //    （缩放+编码的唯一出口，见 `thumb-format.js`），processOne 里再也没有 `.rotate()` 字面量
  //    ⇒ 锚点再次整体失效（`rotate=-1`）。这次不再「换个名字接着钉实现调用」，而是钉
  //    **行为**：旋转可能由 `.rotate()` 直接写出，也可能由 `resizeThumb()` 代劳，取两者中更早的那个。
  //    判据不变 —— dHash 必须取在**任何旋转发生之前**。
  //    旋转本身也有独立守护（见下方 [2c] 那组：`resizeThumb` 必须先转再缩）。
  const iInst = oneBody.indexOf('await createSharpInput(');
  const iDhash = oneBody.indexOf('computeDhashFromPipeline(instance)');
  const iRotateDirect = oneBody.indexOf('.rotate()');
  const iRotateViaThumb = oneBody.indexOf('resizeThumb(');
  const iRotate = [iRotateDirect, iRotateViaThumb]
    .filter((i) => i >= 0)
    .reduce((a, b) => Math.min(a, b), Infinity);
  check(
    '夹具自证：四个锚点都找得到（否则下面的顺序断言会假绿）',
    iInst >= 0 && iDhash >= 0 && iRotate !== Infinity,
    `inst=${iInst} dhash=${iDhash} rotate=${iRotateDirect} resizeThumb=${iRotateViaThumb}`,
  );
  check(
    '🔴 dHash 取在旋转之前（dHash 不旋转；挪到后面会让带 EXIF 方向的照片全换一套位）',
    iInst >= 0 && iDhash > iInst && iRotate !== Infinity && iRotate > iDhash,
    `inst=${iInst} dhash=${iDhash} rotate=${iRotateDirect} resizeThumb=${iRotateViaThumb}`,
  );
  check(
    '🔴 needDhash 只算一次（不许在缩略图分支里重算一遍谓词）',
    (oneBody.match(/var needDhash =/g) || []).length === 1,
  );

  // 🔴 旋转的**承重墙现在在 `thumb-format.js#resizeThumb()` 里**（2026-10-07 收敛）：
  //    processOne 只负责「先算 dHash、再调 resizeThumb」，顺序对不对取决于两处 ——
  //    上面钉了调用点，这里钉被调用的那一刀本身。
  //    ① `.rotate()` 必须在 `.resize()` **之前**（EXIF 方向先摆正再缩放，反了会按未旋转的长边缩放）；
  //    ② 缩略图这条路上 `.rotate()` 只许出现在这一个函数的返回值里 ——
  //       多一处 = 又出现「两条路各自旋转」的分叉。
  const thumbFmtSrc = stripComments(read(THUMB_FMT));
  // ⚠️ `thumb-format.js` 里 `resizeThumb` 是**顶层**函数（闭合括号在 0 列），
  //    与 main.js 里那些嵌在 `app.whenReady` 回调里的（`'\n  }'`）不同 ⇒ 必须显式传 tail。
  const resizeBody = bodyOf(
    thumbFmtSrc,
    'function resizeThumb(instance, size, quality) {',
    '\n}',
  );
  check('夹具自证：取到了 thumb-format.js#resizeThumb', resizeBody.length > 0);
  const rRot = resizeBody.indexOf('.rotate()');
  const rRes = resizeBody.indexOf('.resize(');
  check(
    '🔴 resizeThumb 先 .rotate() 再 .resize()（顺序反了：按未旋转的长边缩放）',
    rRot >= 0 && rRes >= 0 && rRot < rRes,
    `rotate=${rRot} resize=${rRes}`,
  );
  check(
    '🔴 缩略图算子只有 resizeThumb 一处旋转点（多一处 = 两条路各转一次）',
    (thumbFmtSrc.match(/\.rotate\(\)/g) || []).length === 1,
    'rotate() 出现 ' + (thumbFmtSrc.match(/\.rotate\(\)/g) || []).length + ' 次',
  );
}

// ============================================== 2b. 一次读盘出三样（缩略图 + dHash + SHA-256）

console.log('\n[2b] 缩略图补全顺带算查重指纹');
{
  const mainSrc = stripComments(read(MAIN));
  const oneBody = bodyOf(mainSrc, 'async function processOne(row) {');
  check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);

  check(
    '🔴 needHash 的判据读 row.file_hash（拿不到 ⇒ 对全库候选反复重算 SHA，白烧读盘）',
    /var needHash = [^\n]*row\.file_hash/.test(oneBody),
  );
  check(
    '🔴 共享读取有单文件上限（超大文件退回「各读各的」，内存是常数）',
    oneBody.includes('THUMB_SHARED_READ_MAX_BYTES') &&
      /var THUMB_SHARED_READ_MAX_BYTES = \d+ \* 1024 \* 1024;/.test(mainSrc),
  );
  check(
    '🔴 尺寸读取与缩略图解码都把**同一份 Buffer** 交给 sharp（两处调用点各一次）',
    // ⚠️ 锚点从 `loadSharp()(sharedBuf || row.file_path` 改为入口本身：
    //    入参形态收进了 bridge（`createSharpInput(filePath, buf)`），这里只该关心
    //    「两处都把自己的 sharedBuf 递进去了」——数的是**传参**，不是实现名。
    (oneBody.match(/createSharpInput\(row\.file_path, sharedBuf \|\| null\)/g) || []).length === 2,
  );
  check(
    '🔴 有 sharedBuf 就对内存算 SHA，没有才回流式（两条路都必须留着）',
    oneBody.includes('hashBufferSha256(sharedBuf)') &&
      oneBody.includes('await hashFileSha256(row.file_path'),
  );
  check(
    '🔴 摘要写回 file_hash 那一列，参数与查重任务逐位一致',
    oneBody.includes('db.updatePhotoHash(row.id, digest, row.date_modified, row.file_size)'),
  );
  check(
    '🔴 顺序：读盘必须**紧挨在**建 sharp 实例之前（放后面 = sharp 已按路径读过一遍，共享读取白做）',
    // `\s*` 是**故意**的：允许换行与（已被剥成空白的）注释，但**不允许夹带别的语句**。
    // 这正是契约本身 —— 「两份读盘之间不能再插一次读盘」。
    /sharedBuf = await tryReadShared\(row\.file_path\);\s*var si\w* = await createSharpInput\(row\.file_path, sharedBuf \|\| null\)/.test(
      oneBody,
    ),
  );

  // ⚠️ 必须显式给结束标记：`bodyOf` 的默认值是 `'\n  }'`（**2 空格缩进**的闭合括号）。
  //    2026-10-08 `tryReadShared` 从「补全函数内部」提到**模块作用域**（重跑那一趟也要用它），
  //    闭合括号随之变成 `\n}` —— 用默认值会切在 `\n  } catch (eRead) {` 那一行上，
  //    于是 `catch` 与 `return null` 全被切掉，这条断言**假红**（看着像函数不满足契约，
  //    其实只是提取器把结尾认错了）。凡是被提到模块作用域的函数，取函数体都要显式给 tail。
  const helper = bodyOf(mainSrc, 'async function tryReadShared(filePath) {', '\n}');
  check('夹具自证：取到了 tryReadShared 的函数体', helper.length > 0);
  check(
    '🔴 读不到时返回 null 而**不抛**（抛出去 = 把「文件已不在磁盘」记成一次缩略图失败）',
    helper.includes('catch') && helper.includes('return null'),
  );
}

// ============================================== 2c. 数据库侧的接线不变量

console.log('\n[2c] 候选查询与延迟迁移列同生共死');
{
  const dbSrc = stripComments(read(DB));
  const mainSrc = stripComments(read(MAIN));

  const pickBody = bodyOf(dbSrc, 'getPhotosMissingThumbnailsBefore(beforeId, limit) {');
  check('夹具自证：取到了候选查询的函数体', pickBody.length > 0);
  check(
    '🔴 候选 SELECT 必须带 file_hash（processOne 靠它判 needHash）',
    /SELECT[\s\S]*\bfile_hash\b/.test(pickBody),
  );

  // `runThumbnailBackfill` 的 bodyOf 会被 `} finally {` 截断（见 sliceBetween 的注释）
  const preflight = sliceBetween(
    mainSrc,
    'async function runThumbnailBackfill(limit) {',
    '/** 并行算摘要：慢盘场景更保守',
  );
  check('夹具自证：取到了 runThumbnailBackfill 的整段（含 finally）', preflight.includes('finally'));
  check(
    '🔴 前置同批里同时 ensure dhash 与 duplicate-hash 两套列',
    preflight.includes('ensureDhashSchema') && preflight.includes('ensureDuplicateHashSchema'),
  );
  check(
    '🔴 列迁移必须早于第一次取批（`file_hash` / `dhash` 都是延迟迁移列，老库上少了就是 `no such column`）',
    preflight.indexOf('ensureDuplicateHashSchema') <
      preflight.indexOf('getPhotosMissingThumbnailsBefore'),
  );
  check(
    '🔴 顺带写了指纹就必须失效重复分组缓存（否则重复项页面显示旧结果 = 静默错数据）',
    preflight.includes('thumbnailBackfill.hashed') &&
      preflight.includes('clearDuplicateHashGroupsCache(') &&
      /if \(thumbnailBackfill\.hashed > 0\)/.test(preflight),
  );
}

// ============================================================ 3. 行为面：逐位相同

/** 造一张明显不对称的图（对称图旋转后可能恰好同值，会让「旋转会改变位」的断言失去意义） */
async function makeFixtures(dir) {
  const w = 240;
  const h = 180;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // 横向渐变 + 几个不对称暗块（保证旋转后 9×8 的差值模式必然改变）
      let v = Math.round((x / (w - 1)) * 200) + 20;
      if (x > 20 && x < 60 && y > 110 && y < 160) v = 10;
      if (x > 150 && x < 200 && y > 15 && y < 45) v = 240;
      raw[i] = v;
      raw[i + 1] = Math.min(255, Math.round(v * 0.6) + 10);
      raw[i + 2] = Math.max(0, 240 - v);
    }
  }
  const base = path.join(dir, 'plain.jpg');
  const exif = path.join(dir, 'exif6.jpg');
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(base);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(exif);
  return { base, exif };
}

/**
 * 大图夹具：**尺寸**才是这一组的判据 —— 要大到 libvips 会启用 `shrink-on-load`
 * （JPEG 的 DCT 域缩放），才能覆盖「两条路打开方式不同」那条真正的分歧路径。
 * 像素刻意做成斜向低频梯度 + 几处硬边：9×8 的差值模式对缩放误差敏感。
 */
async function makeBigFixtures(dir) {
  const out = [];
  for (const [w, h, quality, name] of [
    [4000, 3000, 92, 'big.jpg'],
    [6000, 4000, 70, 'big-lowq.jpg'],
    [3000, 3000, 90, 'big.png'],
  ]) {
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        let v = Math.round(((x * 0.7 + y * 0.3) / (w + h)) * 255);
        if ((x ^ y) % 997 < 3) v = 255 - v; // 稀疏硬边：缩放路径一变就容易被放大成不同的位
        raw[i] = v;
        raw[i + 1] = Math.round(v * 0.5) + 20;
        raw[i + 2] = 255 - v;
      }
    }
    const src = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
    const file = path.join(dir, name);
    if (name.endsWith('.png')) await src.png({ compressionLevel: 6 }).toFile(file);
    else await src.jpeg({ quality: quality }).toFile(file);
    out.push([name + ' ' + w + '×' + h, file]);
  }
  return out;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-phash-'));
  try {
    const { computeDhash, computeDhashFromPipeline } = require(HASH);
    check(
      '夹具自证：两个入口都导出了',
      typeof computeDhash === 'function' && typeof computeDhashFromPipeline === 'function',
    );

    const fx = await makeFixtures(tmp);

    console.log('\n[3] 共用解码的 dHash 必须逐位相同');
    // ⚠️ 「先 .rotate() 会换一套位」只在**带 EXIF 方向**的文件上成立 —— 无方向的图 `.rotate()`
    //    是空操作，位必然相同。这不是夹具缺陷，而正是风险的边界：受害面 = 全部带方向信息的照片。
    //    两组期望值刻意分开写，免得把「空操作」误当成「顺序无所谓」。
    for (const [label, file, rotateShouldChange] of [
      ['无 EXIF 方向', fx.base, false],
      ['EXIF orientation=6', fx.exif, true],
    ]) {
      const byPath = await computeDhash(file);
      const byPipeline = await computeDhashFromPipeline(sharp(file, { failOnError: false }));
      check(
        `🔴 ${label}：computeDhashFromPipeline 与 computeDhash 逐位相同`,
        !!byPath && byPath === byPipeline,
        `path=${byPath} pipeline=${byPipeline}`,
      );
      check(`${label}：dHash 是 16 位 hex`, /^[0-9a-f]{16}$/.test(byPath || ''), String(byPath));

      // 🔴 顺序的牙齿。
      const rotated = await computeDhashFromPipeline(sharp(file, { failOnError: false }).rotate());
      check(
        rotateShouldChange
          ? `🔴 ${label}：先 .rotate() 再算会得到不同的位（顺序是承重墙）`
          : `${label}：无方向信息时 .rotate() 是空操作，位不变（这是风险的边界）`,
        rotateShouldChange ? rotated && rotated !== byPipeline : rotated === byPipeline,
        `pipeline=${byPipeline} rotated=${rotated}`,
      );
    }

    check(
      'computeDhashFromPipeline 拿到 null 管线时返回 null，不抛',
      (await computeDhashFromPipeline(null)) === null,
    );
    check(
      'computeDhashFromPipeline 拿到坏路径时返回 null（不把异常抛给回填循环）',
      (await computeDhashFromPipeline(sharp(path.join(tmp, 'nope.jpg'), { failOnError: false }))) ===
        null,
    );

    // ---------------------------------------------------------------- 3b. 共用读取
    // 🔴 这条是「一次读盘出三样」的**唯一合法性前提**：把同一份 Buffer 交给 sharp，
    //    产物必须与「按路径打开」逐位/逐字节相同。差一个字节，缩略图会变、dHash 会翻面。
    console.log('\n[3b] 共用读取：Buffer 路径的产物必须与按路径逐位相同');
    const fileHash = require(FILE_HASH);
    check(
      '夹具自证：摘要模块两个入口都导出（且不依赖 electron，所以能在这里真跑）',
      typeof fileHash.hashFileSha256 === 'function' &&
        typeof fileHash.hashBufferSha256 === 'function',
    );

    const THUMB = { size: 256, quality: 80 };
    // 与 processOne 里那条缩略图管线**同一组算子**（精度比它低一档不影响的都照抄）
    const thumbOps = (input) =>
      sharp(input, { failOnError: false })
        .rotate()
        .resize(THUMB.size, THUMB.size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: THUMB.quality })
        .toBuffer();

    for (const [label, file] of [
      ['无 EXIF 方向', fx.base],
      ['EXIF orientation=6', fx.exif],
    ]) {
      const buf = fs.readFileSync(file);

      const thumbByPath = await thumbOps(file);
      const thumbByBuf = await thumbOps(buf);
      check(
        `🔴 ${label}：从 Buffer 解码的缩略图与按路径**逐字节相同**`,
        thumbByPath.equals(thumbByBuf),
        `path=${thumbByPath.length}B buf=${thumbByBuf.length}B`,
      );

      const metaByPath = await sharp(file, { failOnError: false }).metadata();
      const metaByBuf = await sharp(buf, { failOnError: false }).metadata();
      check(
        `🔴 ${label}：原图尺寸两条路一致（${metaByPath.width}×${metaByPath.height}）`,
        metaByPath.width === metaByBuf.width && metaByPath.height === metaByBuf.height,
        `path=${metaByPath.width}×${metaByPath.height} buf=${metaByBuf.width}×${metaByBuf.height}`,
      );

      const dhashByBuf = await computeDhashFromPipeline(sharp(buf, { failOnError: false }));
      check(
        `🔴 ${label}：Buffer 路径的 dHash 与按路径逐位相同`,
        !!dhashByBuf && dhashByBuf === (await computeDhash(file)),
        `path=${await computeDhash(file)} buf=${dhashByBuf}`,
      );

      const hByFile = await fileHash.hashFileSha256(file);
      const hByBuf = fileHash.hashBufferSha256(buf);
      check(
        `🔴 ${label}：流式读与内存 Buffer 两条路的 SHA-256 逐字符相同`,
        hByFile === hByBuf && /^[0-9a-f]{64}$/.test(hByFile),
        `file=${hByFile} buf=${hByBuf}`,
      );
    }

    // 负例：内容变了摘要必须变 —— 否则上面那句「相同」可能只是恒真断言（两边都返回空串也会过）
    check(
      '🔴 负例：内容多一个字节摘要必须变（证明上一条不是恒真）',
      fileHash.hashBufferSha256(Buffer.concat([fs.readFileSync(fx.base), Buffer.from([0])])) !==
        fileHash.hashBufferSha256(fs.readFileSync(fx.base)),
    );
    check(
      '负例：不存在的文件，流式那条必须 reject（不能被静默当成空文件）',
      await fileHash
        .hashFileSha256(path.join(tmp, 'definitely-missing.jpg'))
        .then(() => false)
        .catch(() => true),
    );

    // ------------------------------------------------------------ 3c. **大图**才有的一条塌陷路径
    //
    // 🔴 为什么 240×180 的合成图**不够用**（2026-10-07 补）：
    //    两条路的**打开方式不同** —— `computeDhash` 用 `{ sequentialRead: true }`，
    //    `createSharpInput` 用 `{ failOnError: false }`。小图上两者都走「整图解完再 resize」，
    //    逐位相同是**平凡**的；而 libvips 对**大图**会启用 `shrink-on-load`（JPEG 的 DCT 域缩放），
    //    那正是「同样是 9×8、中间却在另一条 jointed 路径上出结果」的高危区间。
    //    ⇒ 不验大图，「共用一次解码」这个前提就只是自我认证。
    //    真机 30 张 0.1~50 MB 实测：29/30 逐位相同，另 1 张**只有 pipeline 那条路算得出**（动图）。
    //
    //    ⇒ 断言写成「**更强的那一路**」：按路径算得出时，pipeline 必须给出**同一个值**；
    //      pipeline 算得出而按路径算不出是允许的（它只会多补不会少补）。反过来则必须 FAIL。
    console.log('\n[3c] 大图：shrink-on-load 那条路也不能算出另一套位');
    const bigOnes = await makeBigFixtures(tmp);
    for (const [label, file] of bigOnes) {
      const siBig = await require(path.join(ROOT, 'src', 'main', 'sharp-input.js')).createSharpInput(
        file,
        null,
      );
      const byPathBig = await computeDhash(file);
      const byPipeBig = await computeDhashFromPipeline(siBig.instance);
      check(
        `🔴 ${label}：pipeline 与按路径逐位相同`,
        !!byPathBig && byPathBig === byPipeBig,
        `path=${byPathBig} pipeline=${byPipeBig}`,
      );
      check(
        `🔴 ${label}：pipeline 不能比按路径**弱**（按路径算得出时它必须算得出）`,
        !(byPathBig && !byPipeBig),
        `path=${byPathBig} pipeline=${byPipeBig}`,
      );
    }
  } catch (e) {
    failed++;
    console.log('  \u2717 运行时异常: ' + (e && e.stack ? e.stack : String(e)));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  }

  console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
