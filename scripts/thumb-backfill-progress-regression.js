'use strict';
/**
 * 缩略图补全进度回归：进度条的**分子 / 分母**与**三态**（2026-10-06）。
 *
 * ## 这个任务到底是什么
 *
 * 面板上那条进度条的主语早就不是「缩略图」了 —— 它是**一次读盘出多样**的混合任务：
 * 缺缩略图的补缩略图、缺 dHash 的补 dHash、缺原图尺寸的补尺寸、缺拍摄参数的补 EXIF。
 * 候选集谓词 `_sqlBackfillPendingExpr()` 就是这四支的并集。
 *
 * ## 走过两段弯路（两次都是被真实库推翻的）
 *
 * **第一段**：分母用 `thumbnailBackfill.total`，而它是**滚动累加**的（每批 `+= rows.length`），
 * 语义是「本轮已取出多少行」，UI 当「待补总数」用 ⇒ `total - done` 恒等于当前批次剩余
 * （≤ 100 行），百分比在 0 ↔ 100% 之间锯齿。
 *
 * **第二段**：改成「还缺几张缩略图」（`has_thumbnail = 0`，走 covering index，16 ms）。
 * 推理是「用户等的是图 ⇒ 分母就该是图」，并预测进度条会停在 22%。
 * 实测把两个前提都推翻了：
 *   ① 候选集约 156 万行里真正缺缩略图的只有 **339,913**；
 *   ② 补全按 id **倒序**走（最新入库优先），而缺缩略图的行**几乎全压在低位老照片**上
 *      —— `id 1,900,000~1,999,999` 只有 **10 行**缺，`1,600,000~1,899,999` 才是那 33.9 万。
 * 于是任务从 `MAX(id)` 往下走的**头 2 万行里缺缩略图的是 0 行** ⇒ 分子恒 0、分母 339,913
 * ⇒ 进度条在 **0%** 上趴了十几分钟一动不动，用户报上来的是「一直显示 0」。
 *
 * ## 现在的口径
 *
 *   - **主分子** = 本轮**已处理的行数**（`thumbnailBackfill.done`，每处理一行 ++）
 *   - **主分母** = **候选集规模**（`estimatePendingCandidateCount()`）—— 与任务真正的工作量
 *     对齐，百分比和剩余时间跟着它走
 *   - **副指标** = 预览图（`thumbs` / `thumbTotal`）+ 实补细项（`sized` / `dhashed` /
 *     `hashed` / `exifFilled`），让「不只是在做预览图」在界面上看得见
 *
 * ### 为什么主分母是「抽样估计值」而不是精确计数
 *
 * 候选谓词判的列（`dhash` / `width` / `file_type` / `exif_mtime` / `exif_ver`）一个索引都
 * 没有 ⇒ 精确 `COUNT(*)` 只能 `SCAN photos`，本机 14.17 GB / 1,656,580 行实测 **80~95 秒**，
 * 而且那还是它与正在读图的补全任务抢同一块盘时量到的。走 id 轴抽样点查（约 2000 次主键定位）
 * 是亚秒级。代价：它是**估计值**，UI 必须带「约」。
 *
 * ## 本脚本钉住的东西
 *
 * 1. 🔴 **主分母必须与候选集同源**（引用 `_sqlBackfillPendingExpr()`）。手抄一份 = 分数
 *    与真实工作量悄悄脱钩，不报错。
 * 2. 🔴 **抽样必须沿 id 轴点查**，且**空洞 id 不计入样本** —— 记成「未命中」会让命中率偏低
 *    ⇒ 分母偏小 ⇒ 百分比偏高、剩余时间偏乐观。这条有行为面断言（删一半行后估计值仍准）。
 * 3. 🔴 **主计量是「已处理行数」**，预览图张数只能出现在副行 —— 否则回流到「一直显示 0」。
 * 4. 🔴 **分母未就绪 / 估计失败都不许画百分比**（`0 / 0` = 把「不知道」画成「没进展」）。
 * 5. 🔴 **副分母 `countPhotosLackingThumbnail()` 的代价必须真的落在 covering index 上**。
 *    用真库 `EXPLAIN` 钉死：计划里要有 `COVERING INDEX`、opcode 里不许有 `Column` /
 *    `SeekRowid`。这是本脚本唯一能证明「16 ms 这个前提还成立」的地方。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = 'src/main.js';
const DB = 'src/database.js';
const WORKER = 'src/workers/db-read-worker.js';
const SCAN_FLOW = 'src/renderer/scan-flow.js';
const APP = 'src/renderer/app.js';
const I18N = 'src/renderer/i18n.js';
const HTML = 'src/renderer/index.html';
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

/** 取一段函数 / 方法体的文本（闭合括号与签名同缩进时用 bodyOf） */
function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

/** 取 [startSig, endSig) 之间的文本 —— 用于「闭合括号不在预期缩进」的块（如 try/finally） */
function sliceBetween(src, startSig, endSig) {
  const s = src.indexOf(startSig);
  if (s < 0) return '';
  const e = src.indexOf(endSig, s + startSig.length);
  return e < 0 ? src.slice(s) : src.slice(s, e);
}

/** 出现次数 */
function countOf(src, needle) {
  let n = 0;
  let i = -1;
  while ((i = src.indexOf(needle, i + 1)) >= 0) n++;
  return n;
}

const mainSrc = read(MAIN);
const dbSrc = read(DB);
const workerSrc = read(WORKER);
const scanFlowSrc = read(SCAN_FLOW);
const appSrc = read(APP);
const i18nSrc = read(I18N);
const htmlSrc = read(HTML);
const runSrc = read(RUN_REGRESSIONS);

// ---------------------------------------------- 1. 两个计数：各司其职，都不许被对方吞并

// 副分母：只判 has_thumbnail = 0（一列 ⇒ 才走得上 covering index）。
const lackBody = bodyOf(dbSrc, 'countPhotosLackingThumbnail() {');
check('夹具自证：取到了 countPhotosLackingThumbnail 的函数体', lackBody.length > 0);
check(
  '🔴 副分母的谓词只有 has_thumbnail = 0（一列 ⇒ 才走得上 covering index）',
  lackBody.includes('has_thumbnail = 0'),
);
for (const forbidden of ['dhash', 'width', 'height', 'exif_mtime', 'file_type']) {
  check(
    '🔴 副分母谓词不含 `' + forbidden + '`（含了就等于回表读 BLOB，16ms 变 80s）',
    !lackBody.includes(forbidden),
  );
}
check(
  '🔴 副分母**没有**引用 `_sqlBackfillPendingExpr()`（否则又变回候选集口径）',
  !lackBody.includes('_sqlBackfillPendingExpr'),
);

// 主分母：**必须**与候选集同源。
const estBody = bodyOf(dbSrc, 'estimatePendingCandidateCount(samples) {');
check('夹具自证：取到了 estimatePendingCandidateCount 的函数体', estBody.length > 0);
check(
  '🔴 主分母与候选集**同源**（引用 _sqlBackfillPendingExpr()，不手抄第二份谓词）',
  estBody.includes('_sqlBackfillPendingExpr()'),
  '分母与候选集不同源 ⇒ 百分比与真实工作量脱钩，且不报错',
);
check(
  '🔴 抽样沿 id 轴**点查**（`WHERE id = ?`），不是 `id % k = 0`（那样照样全表扫）',
  estBody.includes('WHERE id = ?'),
);
check(
  '🔴 空洞 id **不计入样本**（`if (!row) continue`）—— 记成「未命中」会让分母系统性偏小',
  /if\s*\(\s*!row\s*\)\s*continue/.test(estBody),
);
{
  const skipIdx = estBody.indexOf('if (!row) continue');
  const sampleIdx = estBody.indexOf('sampled++');
  check(
    '🔴 `sampled++` 在跳过空洞**之后**（命中率的分母只数真实存在的行）',
    skipIdx >= 0 && sampleIdx > skipIdx,
    'skip=' + skipIdx + ' sampled=' + sampleIdx,
  );
}
check(
  '🔴 命中判定要求 `=== 1`（谓词返回 0/1；NULL 既不是 0 也不是 1，不算命中）',
  estBody.includes('Number(row.hit) === 1'),
);
check(
  '🔴 估计值 = 命中率 × **总行数**（用 `COUNT(*)` 换算，不是拿 MAX(id) 冒充行数）',
  estBody.includes('(hits / sampled) * total') && estBody.includes('COUNT(*)'),
);
check(
  '🔴 样本数有上下限夹住（0 / 负数 / 天量样本都不许把主进程拖住）',
  estBody.includes('Math.max(50') && estBody.includes('Math.min(20000'),
);
check(
  '🔴 空库直接短路（total/maxId 为 0 时不许除零）',
  /if\s*\(\s*total\s*<=\s*0\s*\|\|\s*maxId\s*<=\s*0\s*\)/.test(estBody),
);

// 反向守护：候选集计数**必须**继续引用统一谓词。
// 如果有人把 `getMissingThumbnailCount()` 改成分母口径，dhash / 尺寸 / 拍摄参数
// 就再也不在候选集里 —— 任务会「跑完」却一行元数据都没补，且不报错。
const missingBody = bodyOf(dbSrc, 'getMissingThumbnailCount() {');
check('夹具自证：取到了 getMissingThumbnailCount 的函数体', missingBody.length > 0);
check(
  '🔴 候选集计数仍引用统一谓词（不许被改成分母口径）',
  missingBody.includes('_sqlBackfillPendingExpr()'),
);
check(
  '🔴 候选集计数里**不许**出现裸的 has_thumbnail = 0（那是副分母的活）',
  !missingBody.includes('has_thumbnail = 0'),
);

// ---------------------------------------------- 2. 读 worker：两个 op 都复用唯一实现

check(
  '🔴 读 worker 注册了两个分母 op（缺预览图数 / 候选集估计）',
  workerSrc.includes("'getPendingThumbCount'") && workerSrc.includes("'estimatePendingCount'"),
);
{
  const workerBranch = sliceBetween(
    workerSrc,
    "msg.op === 'getPendingThumbCount'",
    "msg.op === 'getDuplicateGroupCountByHash'",
  );
  check('夹具自证：取到了 worker 的两个分母分支', workerBranch.length > 0);
  check(
    '🔴 两个分支都复用 PhotoDatabase 的唯一实现（不在这里手抄第二次谓词）',
    workerBranch.includes('PhotoDatabase.prototype') &&
      workerBranch.includes('countPhotosLackingThumbnail()') &&
      workerBranch.includes('estimatePendingCandidateCount('),
  );
  check(
    '🔴 worker 分支里不出现裸 SQL（抄第二份 = 两边悄悄漂开）',
    // ⚠️ 只判 `.prepare(`，不判谓词名：注释里点名 `_sqlBackfillPendingExpr()` 说明「复用的是哪个
    //    实现」是好事，把注释也算进断言就等于「禁止解释」。
    !workerBranch.includes('.prepare(') &&
      !workerBranch.includes('has_thumbnail'),
  );
}

// ---------------------------------------------- 3. 进度对象：主口径 + 副口径 + 三态

const progBody = bodyOf(mainSrc, 'function getThumbnailBackfillProgress() {', '\n}');
check('夹具自证：取到了 getThumbnailBackfillProgress 的函数体', progBody.length > 0);
check(
  '🔴 主分母是 `pendingTotal`（候选集估计值），**不是** `thumbTotal`',
  /var total = thumbnailBackfill\.pendingTotal/.test(progBody),
  '回流成 thumbTotal = 用户又会看到恒 0 的百分比',
);
check(
  '🔴 主分子是**已处理行数**（`thumbnailBackfill.done`）',
  /var processed = Number\(thumbnailBackfill\.done\)/.test(progBody),
);
check(
  '🔴 百分比 = 已处理行数 / 候选集估计值（与用户真实等待时间对齐）',
  progBody.includes('processed / denom'),
);
check('🔴 进度对象带 phase（UI 靠它决定敢不敢画百分比）', /phase:/.test(progBody));
check(
  '🔴 未运行时 phase 为 null（不许把「没跑」伪装成某个运行态）',
  /running\s*\?\s*thumbnailBackfill\.pendingPhase\s*\|\|\s*'counting'\s*:\s*null/.test(progBody),
);
check(
  '🔴 分母未就绪时 total 给 null（0 与 null 是两件事：没有要补的 vs 还不知道）',
  /total:\s*hasTotal\s*\?\s*denom\s*:\s*null/.test(progBody),
);
check(
  '🔴 分子反超分母时夹到 100%（分母是起始快照，并发入库会让它偏小）',
  progBody.includes('Math.min(100') && progBody.includes('Math.max(Number(total), processed)'),
);
check(
  '🔴 ETA 按**已处理行数**算（按预览图算会在头十几分钟里恒为 null）',
  // 只判 taskKey 名是不够的：把分子换成 `thumbs` 而 key 不动，分母照样是候选集，
  // ETA 就变成「用预览图产出速率去推候选集总工作量」，数值会大得离谱且不报错。
  (() => {
    const m = progBody.match(
      /estimateEtaSecondsSmoothed\(\s*'([^']+)',\s*thumbnailBackfill\.startedAt,\s*(\w+),/,
    );
    return !!m && m[1] === 'thumbBackfillByProcessed' && m[2] === 'processed';
  })(),
  (() => {
    const m = progBody.match(
      /estimateEtaSecondsSmoothed\(\s*'([^']+)',\s*thumbnailBackfill\.startedAt,\s*(\w+),/,
    );
    return m ? m[1] + ' / ' + m[2] : '(没匹配到调用)';
  })(),
);
check(
  '🔴 ETA 与旧口径不共用平滑状态（taskKey 已换两代）',
  // ⚠️ 判**实参**而不是「文件里出现过没有」：注释里点名旧 key（说明为什么换）是好事，
  //    用 includes 会连注释一起判，等于逼着后续改动不敢写解释。
  (() => {
    const m = progBody.match(/estimateEtaSecondsSmoothed\(\s*'([^']+)'/);
    return !!m && m[1] === 'thumbBackfillByProcessed';
  })(),
  (progBody.match(/estimateEtaSecondsSmoothed\(\s*'([^']+)'/) || [])[1] || '(没找到调用)',
);
check(
  '🔴 分母未就绪时不给 ETA（宁可不说，也不说一个骗人的数）',
  /etaSeconds:\s*hasTotal\s*\?/.test(progBody),
);
check(
  '🔴 滚动累加的 fetched 不许再进分母（它的唯一去处是日志）',
  !progBody.includes('fetched'),
);
for (const sub of ['thumbs:', 'thumbTotal:', 'sized:', 'dhashed:', 'hashed:', 'exifFilled:']) {
  check('🔴 副口径仍随进度输出：' + sub, progBody.includes(sub));
}

// ---------------------------------------------- 4. 任务：起手 / 计数 / 分子 / 收尾

check(
  '🔴 旧名 total 已从缩略图任务状态里消失（防「滚动值当分母」回流）',
  countOf(mainSrc, 'thumbnailBackfill.total') === 0,
  String(countOf(mainSrc, 'thumbnailBackfill.total')),
);
check(
  '🔴 旧名 thumbPhase 已消失（主分母改名 pendingPhase；残留 = 静默拿到旧语义）',
  countOf(mainSrc, 'thumbnailBackfill.thumbPhase') === 0,
  String(countOf(mainSrc, 'thumbnailBackfill.thumbPhase')),
);
check(
  '滚动账改名成 fetched 并继续累加（只是不再当分母）',
  mainSrc.includes('thumbnailBackfill.fetched += rows.length'),
);
{
  const initBlock = sliceBetween(
    mainSrc,
    'thumbnailBackfill.pendingTotal = null;',
    'emitBackgroundTasksChangedThrottled(true);',
  );
  check('夹具自证：取到了起手初始化块', initBlock.length > 0);
  check(
    "🔴 起手把主分母置 null + phase 置 counting（不许拿假分母起跑）",
    initBlock.includes("thumbnailBackfill.pendingPhase = 'counting'"),
  );
  check(
    '🔴 副分母（缺预览图数）同样置 null（置 0 会渲染成「待补 0」）',
    initBlock.includes('thumbnailBackfill.thumbTotal = null'),
  );
}
check(
  '🔴 起手自增 runToken（两个异步统计都靠它对身份）',
  mainSrc.includes('thumbnailBackfill.runToken++'),
);
check(
  '🔴 起手清零副口径计数（sized / dhashed）',
  mainSrc.includes('thumbnailBackfill.sized = 0') &&
    mainSrc.includes('thumbnailBackfill.dhashed = 0'),
);

{
  const countFn = bodyOf(mainSrc, 'async function countPendingThumbnailsForProgress() {', '\n}');
  check('夹具自证：取到了 countPendingThumbnailsForProgress 的函数体', countFn.length > 0);
  check(
    '🔴 副分母走读 worker（不在主进程同步等：慢盘上会冻界面）',
    countFn.includes("runDbReadWorkerOnly(sqliteDbPath, 'getPendingThumbCount'"),
  );
  check(
    // ⚠️ 必须是**计数**断言，不能只判「存在」：成功路径与 catch 路径各有一处对身份，
    //    存在性断言在删掉其中一处时仍然绿（本守护 2026-10-06 验牙时真撞上过）。
    '🔴 迟到的副分母按 runToken 丢弃，两条路各一处（成功 / 失败）',
    countOf(countFn, 'token !== thumbnailBackfill.runToken') === 2,
    String(countOf(countFn, 'token !== thumbnailBackfill.runToken')),
  );
  check(
    '🔴 副分母失败留 warn 现场（生产档 info 是静默的）',
    countFn.includes('logger.warn'),
  );
  // 🔴 反向断言（2026-10-06 改）：副分母从「任务起始快照」改成了「**实时剩余**」，
  //    于是那条 `Math.max(实测值, 已补张数)` 的夹取**必须删掉**。
  //    快照口径下它是必要的（快照是分母、thumbs 是分子，分子不许超过分母）；
  //    实时口径下 N 与 M 是**互补**关系（`N + M ≈ 起跑线`），任务过半后必然 `M < N` ——
  //    再夹一次就把 M 冻在 N 上、再也不降，正是要修的毛病。
  check(
    '🔴 副分母是实时剩余 ⇒ 不许再夹 Math.max(实测值, 已补张数)（会把实时值冻在分子上）',
    !countFn.includes('Math.max('),
  );
  check(
    '🔴 副分母入口处要盖时间戳（初始那一次与周期刷新共用同一个节流闸门）',
    countFn.includes('thumbTotalRefreshedAt = Date.now()'),
  );

  // 🔴 光把取数函数改成「实时」还不够：**必须在主循环里真的周期性调它**，否则它一辈子
  //    只跑任务开头那一次，读数仍是快照 —— 而注释里已经写着「实时」，属于典型的「名字撒谎」。
  const throttleFn = bodyOf(mainSrc, 'function schedulePendingThumbRefresh() {', '\n}');
  check('夹具自证：取到了 schedulePendingThumbRefresh 的函数体', throttleFn.length > 0);
  check(
    '🔴 周期刷新必须节流（按 THUMB_TOTAL_REFRESH_MS），否则每批都打一次 worker',
    throttleFn.includes('THUMB_TOTAL_REFRESH_MS'),
  );
  // ⚠️ 必须是**结构**断言，不能只判「出现过这个变量名」：只看名字的话，闸门被拆掉
  //    （早退删掉、或只留置位不复位）照样绿。三样缺一不可：早退 / 置位 / 复位。
  check(
    '🔴 周期刷新的「在途」闸门必须三样齐全（早退 + 置位 + 复位），否则慢盘上会叠起来',
    throttleFn.includes('if (thumbTotalRefreshInFlight) return;') &&
      throttleFn.includes('thumbTotalRefreshInFlight = true') &&
      throttleFn.includes('thumbTotalRefreshInFlight = false'),
  );
  {
    // 调用点：主循环每批处理完之后。`runThumbnailBackfill` 的函数体很长，
    // 取「批处理收尾」那一段来断言，避免把整个函数当 haystack（失败时 diff 刷屏）。
    const loopTail = sliceBetween(
      mainSrc,
      'processedInThisRun += rows.length;',
      'emitBackgroundTasksChangedThrottled(false);',
    );
    check('夹具自证：取到了主循环的批处理收尾片段', loopTail.length > 0);
    check(
      '🔴 主循环每批之后必须调 schedulePendingThumbRefresh()（不调 = 读数永远是开头那一次）',
      loopTail.includes('schedulePendingThumbRefresh()'),
    );
    check(
      '🔴 调用点**不许 await**（附属读数不许拖慢主循环）',
      !loopTail.includes('await schedulePendingThumbRefresh'),
    );
  }

  // 🔴 2026-10-06 加：主节拍从「每批一次」改成**定时器**。
  //    理由（用户报「变化较慢」）：一批 100 行约 8~10 s ⇒ 检查点被批次边界量化，
  //    30 s 的节流实际落在 30~40 s。定时器让节拍与批次解耦。
  //    这一节钉的是「定时器必须存在、必须成对、必须真的被接上」——三者缺一，
  //    要么读数退回批次节拍（看着更慢），要么在进程里泄漏一个永远在跑的 1 s 定时器。
  {
    const numOf = (name) => {
      const m = mainSrc.match(new RegExp('var ' + name + ' = (\\d+);'));
      return m ? Number(m[1]) : NaN;
    };
    const refreshMs = numOf('THUMB_TOTAL_REFRESH_MS');
    const tickMs = numOf('THUMB_TOTAL_TICK_MS');
    check(
      '夹具自证：两个节拍常量都取到了数字',
      Number.isFinite(refreshMs) && Number.isFinite(tickMs),
      'refresh=' + refreshMs + ' tick=' + tickMs,
    );
    // ⚠️ 必须**严格小于**：相等时定时器只要早触发一点点就被节流挡掉，5 s 周期拖成 10 s。
    //    这是本项目踩过的「定时器 vs 节流闸门」同族坑，用数字比较钉死，不看注释。
    check(
      '🔴 滴答间隔必须严格小于节流间隔（相等 ⇒ 一个周期被拖成两个）',
      Number.isFinite(refreshMs) && Number.isFinite(tickMs) && tickMs > 0 && tickMs < refreshMs,
      'tick=' + tickMs + ' < refresh=' + refreshMs,
    );
    check(
      '🔴 读数节拍不许悄悄退回 30 s（用户 2026-10-06 明确要求改快）',
      Number.isFinite(refreshMs) && refreshMs <= 10000,
      'THUMB_TOTAL_REFRESH_MS=' + refreshMs,
    );
    // ⚠️ 把**判据的形状**一起钉住：下面那段行为模拟复刻的是这条表达式的语义，
    //    形状一改（比如换成 `<=`）模拟就不再代表源码 —— 所以两者必须同生共死。
    check(
      '🔴 节流判据的形状（`Date.now() - 已取时刻 < 间隔`）不许改形',
      throttleFn.includes('if (Date.now() - thumbTotalRefreshedAt < THUMB_TOTAL_REFRESH_MS) return;'),
    );

    // 🔴 行为面：常量取自源码、判据按源码逐行复刻，走**虚拟时钟**跑一遍。
    //    静态比较只能证明「数字大小关系」，证明不了「这样写真的给出 5 s 一拍」。
    //    而 `Date.now() - last < refresh` 这条判据对**定时器早触发**是敏感的：
    //    滴答与节流相等时，每次早 1 ms 就会把一拍拖成两拍 —— 这里把它跑出来，不当推论。
    {
      const sim = (tick, refresh, spanMs) => {
        let last = 0; // thumbTotalRefreshedAt
        const fires = [];
        for (let t = 0; t <= spanMs; t += tick) {
          if (t - last < refresh) continue; // 节流闸门
          last = t; // 取数入口盖时间戳
          fires.push(t);
        }
        return fires;
      };
      const gapOf = (fires) => (fires.length < 2 ? 0 : fires[1] - fires[0]);
      const span = 60000;
      const firesReal = sim(tickMs, refreshMs, span);
      check(
        '🔴 行为面：真实常量下节拍 = THUMB_TOTAL_REFRESH_MS（节流真的按时间，不是按调用次数）',
        gapOf(firesReal) === refreshMs && firesReal.length === span / refreshMs,
        'fires=' + firesReal.length + ' gap=' + gapOf(firesReal),
      );
      check(
        '🔴 行为面：滴答小于节流时能吸收定时器早触发（一拍不超过 refresh + tick）',
        gapOf(sim(tickMs - 1, refreshMs, span)) <= refreshMs + tickMs,
        'gap=' + gapOf(sim(tickMs - 1, refreshMs, span)),
      );
      check(
        '🔴 反例（证明这条纪律不是洁癖）：滴答 == 节流 + 早触发 1 ms ⇒ 一拍拖成两拍',
        gapOf(sim(refreshMs - 1, refreshMs, span)) >= 2 * refreshMs - (refreshMs - 1),
        'gap=' + gapOf(sim(refreshMs - 1, refreshMs, span)),
      );
    }

    const startFn = bodyOf(mainSrc, 'function startPendingThumbRefreshTicker() {', '\n}');
    check('夹具自证：取到了 startPendingThumbRefreshTicker 的函数体', startFn.length > 0);
    check(
      '🔴 起手必须先停（幂等防重）：重复起手 = 进程里堆多个定时器，谁也停不掉',
      startFn.includes('stopPendingThumbRefreshTicker();'),
    );
    check(
      '🔴 起手必须用 THUMB_TOTAL_TICK_MS 建定时器并把句柄存下来（存不下来就没人能清）',
      startFn.includes('setInterval(schedulePendingThumbRefresh, THUMB_TOTAL_TICK_MS)') &&
        startFn.includes('thumbTotalRefreshTimer = setInterval'),
    );

    const stopFn = bodyOf(mainSrc, 'function stopPendingThumbRefreshTicker() {', '\n}');
    check('夹具自证：取到了 stopPendingThumbRefreshTicker 的函数体', stopFn.length > 0);
    check(
      '🔴 收尾三样齐全且幂等（判空 + clearInterval + 句柄置 null）',
      stopFn.includes('if (thumbTotalRefreshTimer)') &&
        stopFn.includes('clearInterval(thumbTotalRefreshTimer)') &&
        stopFn.includes('thumbTotalRefreshTimer = null'),
    );

    // 起手点：必须在 `runThumbnailBackfill` 的 try 内（收尾只在 finally 里清，
    // 起在 try 外就等于「抛异常时没人清」）。
    const startSite = sliceBetween(
      mainSrc,
      'var thumbCountPromise = countPendingThumbnailsForProgress();',
      'var batchSize = 100;',
    );
    check('夹具自证：取到了补全起手片段', startSite.length > 0, String(startSite.length));
    check(
      '🔴 补全任务起手必须真的起定时器（不调 = 这条主节拍形同虚设，读数退回批次节拍）',
      startSite.includes('startPendingThumbRefreshTicker();'),
    );

    // ⚠️ 顺序断言：`finally` 里必须在**任何清理动作之前**停定时器。
    //    放最后清 = 中间任何一步抛异常，进程里就永久留一个 1 s 定时器。
    // 🔴 必须用「从 finally 花括号开始往后找」的 indexOf —— 直接 `indexOf('stopPendingThumbRefreshTicker();')`
    //    命中的是 `startPendingThumbRefreshTicker()` 里那一句（它在文件里更靠前），
    //    于是「起手那句」替「收尾这句」作证 ⇒ 收尾真被删掉也照样绿（假绿）。
    const iSaveAnchor = mainSrc.indexOf(
      'thumbnailBackfill.failedPathsLastRun = thumbnailBackfill.failedPaths.slice(',
    );
    const iFinallyBrace = mainSrc.lastIndexOf('} finally {', iSaveAnchor);
    const iStopInFinally = mainSrc.indexOf('stopPendingThumbRefreshTicker();', iFinallyBrace);
    // ⚠️ 也从 finally 往后找：`thumbnailBackfill.running = false;` 在文件里出现**两次**
    //    （另一次在闲置/取消处理里），全局 indexOf 会命中别处、拿错位置做比较。
    const iRunningFalse = mainSrc.indexOf('thumbnailBackfill.running = false;', iFinallyBrace);
    check(
      '夹具自证：finally 段的锚点都取到了',
      iFinallyBrace > 0 && iSaveAnchor > 0 && iRunningFalse > 0,
      'brace=' + iFinallyBrace + ' save=' + iSaveAnchor + ' runningFalse=' + iRunningFalse,
    );
    check(
      '🔴 收尾必须停定时器，且**早于**任何其他清理（否则抛异常时泄漏定时器）',
      iStopInFinally > iFinallyBrace &&
        iStopInFinally < iSaveAnchor &&
        iStopInFinally < iRunningFalse,
      'stop@' + iStopInFinally + ' anchor=' + iFinallyBrace + ' save@' + iSaveAnchor,
    );
    // 反向：不许对它 `unref` —— 它随任务存亡，unref 类操作会让「任务跑着但定时器静默不跑」
    // 变成不可见的间歇故障（本项目在别处踩过同族问题）。
    check(
      '🔴 副指标定时器不许 unref（它随任务存亡，不靠它吊进程）',
      !startFn.includes('.unref('),
    );
  }
}

{
  const pendFn = bodyOf(mainSrc, 'async function countPendingCandidatesForProgress() {', '\n}');
  check('夹具自证：取到了 countPendingCandidatesForProgress 的函数体', pendFn.length > 0);
  check(
    '🔴 主分母走读 worker 的 estimatePendingCount',
    pendFn.includes("runDbReadWorkerOnly(sqliteDbPath, 'estimatePendingCount'"),
  );
  check(
    '🔴 迟到的估计值按 runToken 丢弃，两条路各一处（成功 / 失败）',
    countOf(pendFn, 'token !== thumbnailBackfill.runToken') === 2,
    String(countOf(pendFn, 'token !== thumbnailBackfill.runToken')),
  );
  check(
    "🔴 估计失败降级为 'failed' 且留下 warn 现场（生产档 info 是静默的）",
    pendFn.includes("thumbnailBackfill.pendingPhase = 'failed'") && pendFn.includes('logger.warn'),
  );
  check(
    '🔴 估计完成时取 max(估计值, 已处理行数)，避免分母小于分子',
    pendFn.includes('Math.max(est, Number(thumbnailBackfill.done) || 0)'),
  );
  check(
    '🔴 估计值非法（NaN / <= 0）时降级为 failed，而不是把 NaN 写进分母',
    /!\s*isFinite\(est\)\s*\|\|\s*est\s*<=\s*0/.test(pendFn),
  );
}

// 副分子：只在 `db.updatePhotoThumbnail(...)` 之后自增，且全文件只此一处。
// 放在 skipThumbnail 分支里（或写库之前）都会让副分子虚高。
check(
  '🔴 副分子 thumbs 全文件只自增一次（多一处 = 副分子虚高）',
  countOf(mainSrc, 'thumbnailBackfill.thumbs++') === 1,
  String(countOf(mainSrc, 'thumbnailBackfill.thumbs++')),
);
{
  const writeIdx = mainSrc.indexOf('db.updatePhotoThumbnail(row.id, thumb');
  const bumpIdx = mainSrc.indexOf('thumbnailBackfill.thumbs++');
  check(
    '🔴 副分子在写库成功**之后**才自增（写失败的行不算已补）',
    writeIdx > 0 && bumpIdx > writeIdx,
    `write=${writeIdx} bump=${bumpIdx}`,
  );
  const skipBranch = sliceBetween(mainSrc, 'if (skipThumbnail) {', '} else {');
  check('夹具自证：取到了 skipThumbnail 分支', skipBranch.length > 0);
  check(
    '🔴 「早就有图、只补元数据」的行不计入副分子',
    !skipBranch.includes('thumbnailBackfill.thumbs++'),
  );
}
check(
  '🔴 主分子 done 全文件只自增一次（多一处 = 已处理行数虚高）',
  countOf(mainSrc, 'thumbnailBackfill.done++') === 1,
  String(countOf(mainSrc, 'thumbnailBackfill.done++')),
);
{
  const sizedIdx = mainSrc.indexOf('thumbnailBackfill.sized++');
  const dimIdx = mainSrc.indexOf('db.updatePhotoDimensions(row.id');
  check(
    '🔴 sized 在真正写库之后自增（尺寸没写进库就不算补上）',
    dimIdx > 0 && sizedIdx > dimIdx,
    'dim=' + dimIdx + ' sized=' + sizedIdx,
  );
  const dhashIdx = mainSrc.indexOf('thumbnailBackfill.dhashed++');
  const updIdx = mainSrc.indexOf('db.updatePhotoDhash(');
  check(
    '🔴 dhashed 在真正写库之后自增',
    updIdx > 0 && dhashIdx > updIdx,
    'upd=' + updIdx + ' dhashed=' + dhashIdx,
  );
}

check(
  '🔴 主循环结束后 await 两个分母统计（短任务会在统计回来前跑完，不 await 就是与 finally 抢状态）',
  mainSrc.includes('await thumbCountPromise') && mainSrc.includes('await pendingCountPromise'),
);
check(
  '🔴 收尾把主分母 phase 归零（三态只对「正在运行」有意义）',
  // 起点用补全任务 finally 的第一句：`} finally {` 在 main.js 里不是唯一的
  sliceBetween(
    mainSrc,
    'thumbnailBackfill.failedPathsLastRun = thumbnailBackfill.failedPaths.slice(',
    'emitBackgroundTasksChangedThrottled(true);',
  ).includes('thumbnailBackfill.pendingPhase = null'),
);

// ---------------------------------------------- 5. 渲染层：主计量必须是「已处理行数」

{
  const thumbBlock = sliceBetween(scanFlowSrc, 'if (showThumb) {', 'if (showInvalidCleanup) {');
  check('夹具自证：取到了 scan-flow 的缩略图进度块', thumbBlock.length > 0);

  const readyBranch = sliceBetween(thumbBlock, 'if (tReady) {', '} else {');
  check('夹具自证：取到了任务面板的 ready 分支', readyBranch.length > 0);
  check(
    '🔴 主计数行用的是**已处理行数**（`thumbs.done`）',
    readyBranch.includes('formatNumber(thumbs.done)'),
  );
  check(
    '🔴 主计数行里**不许**出现预览图张数（那是副行的活；回流 = 用户又看到恒 0）',
    !readyBranch.includes('formatNumber(thumbs.thumbs)'),
  );
  check(
    '🔴 主计数行带「约」（分母是抽样估计值，不能装作精确）',
    readyBranch.includes('约'),
  );
  check(
    '🔴 进度条宽度夹在 0..100（分子可能因并发入库反超分母）',
    /Math\.min\(100,\s*Math\.max\(0,\s*thumbs\.pct/.test(readyBranch),
  );
  check(
    "🔴 任务面板按 phase 分支，ready 才画百分比",
    thumbBlock.includes('thumbs.phase === \'ready\''),
  );
  check(
    '🔴 分母未就绪时不说「x / y」（`0 / 0` = 把不知道画成没进展）',
    thumbBlock.includes("thumbs.phase === 'counting'") && thumbBlock.includes('正在估计'),
  );
  check(
    '🔴 分母未就绪时不显示剩余时间',
    thumbBlock.includes("tEta.textContent = ''"),
  );

  const detailLine = sliceBetween(scanFlowSrc, 'if (tdetail) {', 'if (tfile) {');
  check('夹具自证：取到了副行（产出细项）分支', detailLine.length > 0);
  check(
    '🔴 副行列出预览图与实补细项（否则用户只会看到一个 0）',
    detailLine.includes('预览图') &&
      detailLine.includes('thumbs.exifFilled') &&
      detailLine.includes('thumbs.dhashed'),
  );
  check(
    '🔴 副分母未就绪（thumbTotal = 0）时不许写「待补 0」',
    /thumbTotal\s*>\s*0/.test(detailLine),
  );
}

check(
  '🔴 任务面板 DOM 有副行容器（#thumbProgressDetail），且初始文案与 i18n 一致',
  htmlSrc.includes('id="thumbProgressDetail"') &&
    htmlSrc.includes('id="thumbProgressFill"') &&
    htmlSrc.includes('id="thumbProgressEta"'),
);

{
  const appReady = sliceBetween(
    appSrc,
    "'settings.task.thumbProgressRunning',",
    "'settings.task.thumbProgressCounting'",
  );
  check('夹具自证：取到了设置页 ready 分支', appReady.length > 0);
  check(
    '🔴 设置页主行也是**已处理**口径（done = 已处理行数）',
    appReady.includes('done: p.done') && appReady.includes('total: p.total'),
  );
  check(
    '🔴 设置页主行带「约」（分母是估计值）',
    appReady.includes('约'),
  );
  check(
    '🔴 设置页不再用 success 冒充进度（success 含「只补元数据」的行）',
    !appReady.includes('p.success'),
  );
}
check(
  "🔴 设置页那行也按 phase 分支（'counting' / 'failed' 各一套文案）",
  appSrc.includes("'settings.task.thumbProgressCounting'") &&
    appSrc.includes("'settings.task.thumbProgressNoTotal'") &&
    appSrc.includes("p.phase === 'counting'"),
);
check(
  '🔴 完成态也分「有分母 / 没分母」两套（不许出现 `共 null`）',
  appSrc.includes("'settings.task.thumbProgressDoneNoTotal'"),
);

// ---------------------------------------------- 6. i18n：两种语言都要有，且占位符一致

function i18nValues(src, key) {
  const needle = "'" + key + "'";
  const out = [];
  let i = -1;
  while ((i = src.indexOf(needle, i + 1)) >= 0) {
    const rest = src.slice(i + needle.length);
    const m = rest.match(/^:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/);
    out.push(m ? (m[1] != null ? m[1] : m[2]) : null);
  }
  return out;
}
function placeholders(s) {
  return Array.from(new Set(String(s || '').match(/\{[a-zA-Z]+\}/g) || []))
    .sort()
    .join(',');
}

for (const key of [
  'settings.task.thumbProgressRunning',
  'settings.task.thumbProgressCounting',
  'settings.task.thumbProgressNoTotal',
  'settings.task.thumbProgressDone',
  'settings.task.thumbProgressDoneNoTotal',
]) {
  const vals = i18nValues(i18nSrc, key);
  check(
    'i18n 两个语言都有 ' + key,
    vals.length >= 2 && vals.every((v) => v != null),
    String(vals.length),
  );
  if (vals.length >= 2 && vals.every((v) => v != null)) {
    const sets = vals.map(placeholders);
    check('占位符集合两语一致：' + key, sets.every((s) => s === sets[0]), sets.join(' | '));
  }
}

// 任务标题要跟上任务的真实内容（它早就不只补缩略图了）
{
  const titles = i18nValues(i18nSrc, 'task.thumbTitle');
  check(
    '🔴 任务标题已不再是「缩略图补全」一家之言（任务同时补尺寸 / dHash / 拍摄参数）',
    titles.length >= 2 && titles.every((v) => v != null && !/^缩略图补全$/.test(v)),
    titles.join(' | '),
  );
}

// ---------------------------------------------------------------------------
// 🔴 任务面板（scan-flow.js）的文案必须**真的走 i18n**，否则英文界面会露中文。
//
// 这条是**静默失效**的教科书案例：中文用户一切正常、截图一模一样，
// 改的人（和我）根本不会发现 —— 本轮就踩了：主行/副行写了 13 处裸中文，
// 中文守护全绿。判据有两条，缺一不可：
//   ① 每个 key 在 scan-flow.js 里被引用（写了英文词条但没人用 = 白写）
//   ② 英文词条本身不含 CJK（有人把英文值抄成中文 ⇒ 英文界面必然露中文）
// 刻意**不判**「源码里有没有中文字面量」：`tuiFmt(key, map, '已处理 …')` 的第三个参数
// 就是**故意的**兜底中文（i18n.js 万一没加载时的退路，app.js 的 tUi/tUiFmt 同款）。
// 判它等于把正确的写法一起判死。
// ---------------------------------------------------------------------------
{
  const PANEL_I18N_KEYS = [
    'task.thumbCount',
    'task.thumbCountCounting',
    'task.thumbCountNoTotal',
    'task.thumbDetailThumbs',
    'task.thumbDetailPending',
    'task.thumbDetailExif',
    'task.thumbDetailDhash',
    'task.thumbDetailHash',
    'task.thumbDetailFailed',
    'task.etaPrefix',
    'task.etaDays',
    'task.etaHours',
    'task.etaMinutes',
  ];
  const CJK = /[\u4e00-\u9fff]/;
  const missingRef = [];
  const zhNoCjk = [];
  const enHasCjk = [];
  const phMismatch = [];
  for (const key of PANEL_I18N_KEYS) {
    if (!scanFlowSrc.includes("'" + key + "'")) missingRef.push(key);
    const vals = i18nValues(i18nSrc, key);
    if (vals.length < 2 || vals.some((v) => v == null)) {
      missingRef.push(key + '(词条缺失)');
      continue;
    }
    // zh 块在文件里靠前，en 块靠后 ⇒ vals[0] / vals[1]
    if (!CJK.test(vals[0])) zhNoCjk.push(key);
    if (CJK.test(vals[1])) enHasCjk.push(key);
    // 占位符两语必须逐位一致：少一个 ⇒ 英文行里出现裸露的 `{total}` 或数值被吞
    if (placeholders(vals[0]) !== placeholders(vals[1])) {
      phMismatch.push(key + ' 中[' + placeholders(vals[0]) + '] vs 英[' + placeholders(vals[1]) + ']');
    }
  }
  check(
    '🔴 任务面板每个 i18n key 都被 scan-flow.js 真的引用（写了词条没人用 = 白写）',
    missingRef.length === 0,
    missingRef.length ? missingRef.join(', ') : PANEL_I18N_KEYS.length + ' 个全部被引用',
  );
  check(
    '🔴 中文词条确实含中文（防两语写反：英文抄进中文位，中文界面反而露英文）',
    zhNoCjk.length === 0,
    zhNoCjk.length ? zhNoCjk.join(', ') : 'ok',
  );
  check(
    '🔴 英文词条不含 CJK —— 含了 = 英文界面必然露中文（本轮踩过，中文守护全绿）',
    enHasCjk.length === 0,
    enHasCjk.length ? '露中文：' + enHasCjk.join(', ') : 'ok',
  );
  check(
    '🔴 每个 key 的中英占位符集合逐位一致（少一个 ⇒ 界面出现裸露的 {total}）',
    phMismatch.length === 0,
    phMismatch.length ? phMismatch.join(' | ') : 'ok',
  );

  // 预计剩余时间被四个面板共用，退回字符串拼接就等于四条路径一起露中文
  check(
    '🔴 formatEtaLine 走 i18n（四个面板共用它；退回字符串拼接 = 四条路径一起露中文）',
    /tuiFmt\(\s*'task\.etaPrefix'/.test(scanFlowSrc) &&
      !/return\s+'预计剩余约 '\s*\+/.test(scanFlowSrc),
    'ok',
  );
  // 🔴 必须**只判函数体**：这几条判据的「反例文字」常常就写在函数上方的 JSDoc 里
  //    （比如注释里写「必须判 `s !== key`」）—— 拿全文正则一判，注释自己把断言喂绿了。
  //    2026-10-06 验牙时 G7 就是这么假绿的。这是本项目那条元规则的又一次现形：
  //    **结构断言不许读注释**。
  const tuiBody = sliceBetween(scanFlowSrc, 'function tui(key, zhFallback) {', 'return zhFallback;');
  check('夹具自证：切出了 tui 函数体（不含上方 JSDoc）', tuiBody.length > 0, String(tuiBody.length));
  check(
    '🔴 tui 兜底判了 `s !== key`（词条缺失时 i18n.t 返回 key 本身，直接 return 会让界面显示 `task.thumbCount`）',
    /s\s*!==\s*key/.test(tuiBody),
    'ok',
  );
}

// ---------------------------------------------- 7. 行为面：真库证明「分母廉价」+ 抽样准确

// 上面全是读源码文本。而这条链路上有两个**无法从文本看出**的事实：
//   ① 副分母能在 16 ms 内算完，前提是它真的落在 covering index 上（谓词被改宽 ⇒
//      静态断言全绿、线上立刻退回 80 秒）；
//   ② 抽样估计是**无偏**的，前提是空洞 id 不计入样本。
// 所以这里用真 SQLite 跑 EXPLAIN 与计数（计划形状只取决于可用索引，与数据量无关）。
{
  const os = require('node:os');
  const PhotoDatabase = require(path.join(ROOT, 'src', 'database.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-progress-'));
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
    // `dhash` 是延迟迁移列（`_sqlBackfillPendingExpr()` 引用它）⇒ 夹具必须先 ensure，
    // 否则首次查询就是 `no such column: dhash`（这与生产路径同构：补全任务开跑前也这么干）。
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();
    const rootId = db.addRootFolder('C:\\thumb\\root');
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const base = {
      rootId,
      folderPath: 'C:\\thumb\\root\\f',
      fileSize: 10,
      dateTaken: '2026-01-01T00:00:00',
      dateModified: '2026-01-01T00:00:00',
    };

    // 3 张缺缩略图的图片（副分母命中）
    for (let i = 1; i <= 3; i++) {
      db.insertPhoto(
        Object.assign({}, base, {
          fileName: 'noThumb' + i + '.jpg',
          filePath: 'C:\\thumb\\root\\f\\noThumb' + i + '.jpg',
          fileType: 'jpg',
          width: 0,
          height: 0,
          hasThumbnail: 0,
        }),
      );
    }
    // 2 张**有缩略图但缺尺寸**的图片：不该进副分母，但必须进候选集（这正是两个数的差别）
    // ⚠️ 不能用 `lastInsertRowid` 取 id：`insertPhoto` 是 `INSERT OR IGNORE`，被忽略时不归零
    //    （项目里 `addRootFolder()` 踩过同一个坑）。一律按 file_path 回查。
    const idOf = (fp) => db.db.prepare('SELECT id FROM photos WHERE file_path = ?').get(fp).id;
    for (let i = 1; i <= 2; i++) {
      const fp = 'C:\\thumb\\root\\f\\metaOnly' + i + '.jpg';
      db.insertPhoto(
        Object.assign({}, base, {
          fileName: 'metaOnly' + i + '.jpg',
          filePath: fp,
          fileType: 'jpg',
          width: 0,
          height: 0,
          thumbnail: thumb,
          hasThumbnail: 1,
          thumbSize: 256,
          thumbFormat: 'jpeg',
        }),
      );
      db.updatePhotoDhash(idOf(fp), '0000000000000000', [0], '2026-01-01T00:00:00', 10);
    }
    // 1 个缺缩略图的视频：副分母要算它（视频真正欠的就是缩略图）
    db.insertPhoto(
      Object.assign({}, base, {
        fileName: 'clip.mp4',
        filePath: 'C:\\thumb\\root\\f\\clip.mp4',
        fileType: 'mp4',
        width: 0,
        height: 0,
        hasThumbnail: 0,
      }),
    );
    // 1 张 has_thumbnail 为 NULL 的图：**未知 ≠ 缺**，两边都不该把它当成「缺缩略图」。
    const nullFp = 'C:\\thumb\\root\\f\\unknown.jpg';
    db.insertPhoto(
      Object.assign({}, base, {
        fileName: 'unknown.jpg',
        filePath: nullFp,
        fileType: 'jpg',
        width: 4000,
        height: 3000,
        thumbnail: thumb,
        hasThumbnail: 1,
        thumbSize: 256,
        thumbFormat: 'jpeg',
      }),
    );
    const nullId = idOf(nullFp);
    db.db.prepare('UPDATE photos SET has_thumbnail = NULL WHERE id = ?').run(nullId);
    db.updatePhotoDhash(nullId, 'ffffffffffffffff', [0], '2026-01-01T00:00:00', 10);
    db.updatePhotoExif(nullId, null, '2026-01-01T00:00:00');

    const lack = db.countPhotosLackingThumbnail();
    check(
      '行为面：副分母 = 缺缩略图的张数（3 图 + 1 视频；有图只缺元数据的 2 行不计）',
      lack === 4,
      '实得 ' + lack,
    );

    const pending = db.getMissingThumbnailCount();
    check(
      '行为面：候选集 > 副分母（两个数确实不是一回事 —— 只缺元数据的活不在副分母里）',
      pending > lack,
      '候选=' + pending + ' 副分母=' + lack,
    );

    // 🔴 计划形状：副分母必须落在 covering index 上
    const planOf = (sql) =>
      db.db
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .all()
        .map((r) => r.detail)
        .join(' | ');
    const opsOf = (sql) => db.db.prepare('EXPLAIN ' + sql).all().map((r) => r.opcode);

    const lackSql = 'SELECT COUNT(*) FROM photos WHERE has_thumbnail = 0';
    const lackPlan = planOf(lackSql);
    check('🔴 副分母计数走 covering index（不回表）', lackPlan.includes('COVERING INDEX'), lackPlan);
    const lackOps = opsOf(lackSql);
    for (const bad of ['Column', 'SeekRowid', 'DeferredSeek']) {
      check(
        '🔴 副分母计数的 opcode 里没有 ' + bad + '（有 = 每行回表，穿缩略图 BLOB 的溢出页链）',
        !lackOps.includes(bad),
        lackOps.join(','),
      );
    }

    // 对照：候选集谓词**必然**回表 —— 这就是「不能拿它做精确分母」的可执行证据。
    // 谓词从活代码取（`_sqlBackfillPendingExpr()`），不在这里抄一份。
    const pendingOps = opsOf('SELECT COUNT(*) FROM photos WHERE ' + db._sqlBackfillPendingExpr());
    check(
      '🔴 对照：候选集**精确**计数回表读列（Column 存在）⇒ 与副分母代价数量级不同',
      pendingOps.includes('Column'),
      pendingOps.join(','),
    );

    // ---- 抽样估计的正确性（含「空洞 id 不计样本」这条最容易写错的分支）----
    // 造 100 行**全部**命中候选谓词、然后删掉前 50 行 ⇒ id 空间 [1,100] 里有一半是空洞。
    //   正确实现：sampled 只数存在的 50 行 ⇒ 命中率 50/50 = 1 ⇒ 估计 = 1 × 50 = 50 ✅
    //   错误实现（空洞记成未命中）：命中率 50/100 ⇒ 估计 = 25 ❌（分母减半 = 百分比翻倍）
    // 用独立库子集：先清空再插（上面的 7 行是给 EXPLAIN 用的）。
    db.db.prepare('DELETE FROM photos').run();
    for (let i = 1; i <= 100; i++) {
      db.insertPhoto(
        Object.assign({}, base, {
          fileName: 's' + i + '.jpg',
          filePath: 'C:\\thumb\\root\\f\\s' + i + '.jpg',
          fileType: 'jpg',
          width: 0,
          height: 0,
          thumbnail: thumb,
          hasThumbnail: 1,
          thumbSize: 256,
          thumbFormat: 'jpeg',
        }),
      );
    }
    // ⚠️ `photos.id` 是 AUTOINCREMENT ⇒ 表删空后新插入的 id **不**从 1 开始（延续 `sqlite_sequence`）。
    //    所以「删掉前一半」必须**按行数**删，不能写死 `id <= 50` —— 那样会删掉 43 行、剩下 57 行，
    //    空洞比例也就不是设计的一半了（本守护第一次跑就是这么红的）。
    db.db
      .prepare('DELETE FROM photos WHERE id IN (SELECT id FROM photos ORDER BY id LIMIT 50)')
      .run();
    const exact = db.getMissingThumbnailCount();
    const est = db.estimatePendingCandidateCount(2000);
    check('行为面夹具：删掉一半后剩 50 行且全部命中候选谓词', exact === 50, '实得 ' + exact);
    check(
      '🔴 行为面：抽样估计在**半数 id 是空洞**时仍然准确（空洞不计入样本）',
      est.estimate === exact,
      '估计=' + est.estimate + ' 精确=' + exact + ' sampled=' + est.sampled,
    );
    check(
      '🔴 行为面：sampled 只数真实存在的行（50 而不是 100）—— 这条直接钉住「空洞不算未命中」',
      est.sampled === exact,
      'sampled=' + est.sampled,
    );
    check('行为面：total 用 COUNT(*) 换算（等于当前行数）', est.total === exact, 'total=' + est.total);
    check(
      '行为面：样本数参数被夹在 [50, 20000]',
      (() => {
        const lo = db.estimatePendingCandidateCount(1);
        const hi = db.estimatePendingCandidateCount(999999);
        return lo.sampled > 0 && hi.sampled <= 20000;
      })(),
    );
    // 空库短路：不许除零、不许 NaN
    db.db.prepare('DELETE FROM photos').run();
    const emptyEst = db.estimatePendingCandidateCount(2000);
    check(
      '行为面：空库返回 0 而不是 NaN（分母为 0 时 UI 会显示 `NaN%`）',
      emptyEst.estimate === 0 && emptyEst.sampled === 0 && Number.isFinite(emptyEst.estimate),
      JSON.stringify(emptyEst),
    );
  } catch (e) {
    check('行为面夹具执行成功（真库 EXPLAIN + 抽样）', false, e && e.message ? e.message : String(e));
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

// ---------------------------------------------- 8. 登记进全量回归

check(
  '本守护已登记进 scripts/run-regressions.js',
  runSrc.includes("'thumb-backfill-progress-regression.js'"),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[thumb-backfill-progress-regression] 缩略图补全进度（分子 / 分母 / 三态）契约\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[thumb-backfill-progress-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[thumb-backfill-progress-regression] PASS（' + notes.length + ' 项）\n');
