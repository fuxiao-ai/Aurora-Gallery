const startupMetrics = require('./main/startup-metrics').createStartupMetrics();
startupMetrics.mark('main.enter');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  shell,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
} = require('electron');
console.log(
  '[startup] Electron version:',
  process.versions.electron,
  'ABI:',
  process.versions.modules,
);
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const Database = require('./database');
const dbReadWorkerPool = require('./db-read-worker-pool');
const { runDatabaseMaintenance } = require('./main/database-maintenance');
const maintenanceGuard = require('./main/maintenance-guard');
/**
 * 图库数据目录（默认 userData，可整份迁到别的盘）的位置判定与迁移执行。
 * 纯逻辑（体检 / 复制 / 校验）都在 `src/main/data-dir.js`，这里只管编排与 IPC。
 */
const dataDirLib = require('./main/data-dir');
const { createDbWriteQueue, PRIORITY } = require('./main/db-write-queue');
/**
 * 查重指纹（SHA-256）的两条入口。抽成独立模块是为了让回归脚本能**真跑**着验证
 * 「流式读」与「对内存 Buffer」给出逐字符相同的摘要 —— 它们写的是同一列 `file_hash`。
 */
const { hashFileSha256, hashBufferSha256 } = require('./main/file-hash');
// 拍摄参数的解析只有一份（`src/main/exif-meta.js`），扫描期与补全任务共用 —— 见该模块头注释。
const { extractExifFields, hasAnyExifField } = require('./main/exif-meta');
/**
 * 「能不能建 AI 索引」的判据。剥成独立模块是为了能被回归脚本真跑 —— 这条判据曾经因为
 * 与 FTS 共用同一个开关，把开机期的正常点击误报成「数据库维护进行中」。
 */
const { aiIndexCanRun } = require('./main/ai-index-gate');
// 任务进度百分比的唯一来源（边界规则见 `docs/contracts/background-tasks.md` §1.1）。
const { computePct } = require('./main/progress-pct');
/**
 * 任务**预计剩余时间**的唯一来源（口径见 `docs/contracts/background-tasks.md` §7）。
 * ⚠️ 2026-10-08 从本文件搬出去的：原先 `estimateEtaSeconds` / `…Smoothed` 就住在这里，
 *    而人脸 / 搜图那两个任务的 `startedAt` 在 worker 里、够不着 ⇒ 它们只能另报速率，
 *    同一个面板里出现两种读法。搬进独立模块后两条口径并排放，且 `status()` 能 require 到。
 */
const {
  estimateEtaSecondsSmoothed,
} = require('./main/eta');
/**
 * 「这台机器有没有可用的 GPU 加速」的**唯一探测与唯一记录处**。
 *
 * 判据只有一条：真的建一个 dml 会话并跑出正确数值（细节在 `main/gpu-probe.js` 里）。
 * 别在别处再推断一次 —— `process.platform` / 包里有没有 DirectML.dll / `listSupportedBackends()`
 * 三条都会在纯 CPU 机器上给出「可用」，而差异要到几个月后有人抱怨「换了显卡没变快」时才暴露。
 */
const { createGpuProbe } = require('./main/gpu-probe');
/**
 * 用户交互抢占信号：搜图查询进行中时，后台长任务在批次边界停下让位。
 * 与内嵌网页 API 共用同一份单例（同进程），所以网页端搜图也会让后台任务让位。
 */
const { interactionPreempt } = require('./main/interaction-preempt');
/**
 * 图片信息面板的字段注册表：与渲染端 / 网页端**同一份**。
 * 主进程只取它的 id 白名单与默认集做设置项校验 —— 于是「设置页能勾的」与
 * 「面板能画的」不可能对不上（曾经这类双份硬编码清单漂过好几次）。
 */
const PHOTO_INFO_FIELDS = require('./web/js/photo-info-fields.js');

/**
 * 启动期写库任务串行闸门。缩略图标记修复 / 延迟索引 / FTS 维护各起一个 worker，
 * 过去各自 setTimeout 点火、互相不认识，后到的那个等满 busy_timeout=8000 就撞
 * `database is locked`。这里排成一队，并把队列状态并进 maintenanceBusy()，
 * 让界面触发的维护也知道该等、并报出在等谁。
 */
/**
 * 🔴 高频批次任务名单：它们现在**每一批都要重入队列**（见 `runThumbnailBackfill` /
 * `runDuplicateHashDetection`），若照常打点会把启动阶段埋点刷爆 —— 百万库上回填一批 100 张、
 * 重复哈希一个子批 24 张，走完全库就是几万条 `db-write.start/done`。
 * 这两个任务本来就各有自己的 logger 输出，这里静默即可。
 */
const DB_WRITE_QUIET_TASKS = {
  'thumbnail-backfill': true,
  'dup-hash': true,
  // 「全量重跑」同样是高频批次任务（登记每 4 万行一次、抽干每 50 张一次）⇒ 同上静默。
  // 它自己每批都有 logger 输出（`[runThumbnailRebuild]`），现场不缺。
  'thumb-regen': true,
  'thumb-regen-enqueue': true,
  // 扫描（T2 起占一次闸门、租约粒度 = 整次扫描）：时长无上界，一条 db-write.start/done
  // 跨度可能是几十分钟，混进启动阶段埋点会把「某阶段耗时」算成天文数字。
  scan: true,
};
const dbWriteQueue = createDbWriteQueue({
  onStart: function (name) {
    if (DB_WRITE_QUIET_TASKS[name]) return;
    startupStageLog('db-write.start', 'task=' + name);
  },
  onSettle: function (name, error) {
    if (DB_WRITE_QUIET_TASKS[name]) return;
    startupStageLog('db-write.done', 'task=' + name + (error ? ' error=' + error.message : ''));
  },
});
const { Readable } = require('stream');
const { runDbReadWorkerOnly } = require('./db-read-runner');
const browseRequests = require('./main/browse-requests');
const { CatalogCacheDb, normalizeMediaKey } = require('./catalog-cache-db');
const logger = require('./main/logger');
const similarDetection = require('./main/similar-detection');
const { idListPredicate, toIdListJson } = require('./main/sql-id-list');
const { computeDhash, computeDhashFromPipeline, getDhashBuckets } = require('./main/perceptual-hash');
const { createPhotoEditService } = require('./main/photo-edit-service');
// 缩略图格式 → 响应头 MIME：唯一真相源（白名单与「生成端编码格式」都在那边，`database.js` 共用同一份）。
// 🔴 `thumb://` 的响应头**必须**由「这一行实际存的格式」派生，不许硬编码 `image/jpeg`：
//    库里一旦出现 WebP 行，硬编码的头会让浏览器静默不解码（不报错，只是空白）。
const {
  thumbMimeType,
  resizeThumb,
  normalizeThumbSize,
  THUMB_ENCODE_FORMAT,
  THUMB_DEFAULT_SIZE,
  THUMB_DEFAULT_QUALITY,
} = require('./main/thumb-format');
// 「缩略图全量重跑」的队列表 / 取批 SQL / 规格谓词：唯一真相源（`database.js` 共用同一份）。
// 🔴 取批 SQL **不带规格谓词**这条约定写在该模块头部，改它之前先读那段。
const thumbRegenQueue = require('./main/thumb-regen-queue');
// 图片「列表行」的列清单唯一真相源（含 `thumb_size` / `thumb_format` —— 浏览层的缓存键要用）。
// 本文件里只有「按 id 批量取行」那一处列表查询，但它照样得从唯一源取：
// 抄一份就是下一次「加列漏一处」的起点，而漏了的症状是静默的。见 `photo-list-columns.js`。
const { photoListColumns } = require('./main/photo-list-columns');
/** 搜图匹配阈值的范围与默认值：唯一定义处（src/ai/index-store.js），设置默认值从它取。 */
const { MATCH_THRESHOLD_RANGE } = require('./ai/index-store');
/**
 * tag 检索路（M4）的查询线与可调范围：唯一定义处 `src/ai/tag-index-store.js`。
 * ⚠️ 与 `MATCH_THRESHOLD_RANGE` **必须是两份** —— 量纲不同（CLIP 是基线差 0.01–0.15，
 *    tag 是标签概率 0.2–0.95），共用一个区间就会「为了压住 tag 的误报把 CLIP 砍没」。
 *
 * `TAG_DISPLAY_RANGE` / `clampDisplayMinScore` 是**展示线**（读侧分数线）的可调范围与夹取：
 * 它管的是标签导航页与照片信息面板「哪些行算结论」，与上面的查询线是两件事，
 * 但**共用同一把尺子**（标签概率）⇒ 范围常量也放在同一个文件里，避免第二次口径分裂。
 */
const { TAG_ROUTE_RANGE, TAG_DISPLAY_RANGE, clampDisplayMinScore } = require('./ai/tag-index-store');
// 随包内置模型（`models/`）的播种层：只读 fs/path/crypto，不碰 electron 与原生模块，
// 因此可以在主进程顶部直接引，不会给启动加任何重量。
const bundledModels = require('./ai/bundled-models');

/** 懒加载：避免冷启动即解析 ffmpeg-static 路径（磁盘/解压成本） */
var cachedFfmpegStaticPath;
function getFfmpegStaticPath() {
  if (cachedFfmpegStaticPath !== undefined) {
    return cachedFfmpegStaticPath || null;
  }
  try {
    cachedFfmpegStaticPath = require('ffmpeg-static') || '';
  } catch (e) {
    cachedFfmpegStaticPath = '';
  }
  return cachedFfmpegStaticPath || null;
}

var videoFrameThumbModule = null;
function getVideoFrameThumb() {
  if (!videoFrameThumbModule) {
    videoFrameThumbModule = require('./video-frame-thumb');
  }
  return videoFrameThumbModule;
}

/** 延迟加载 sharp（libvips），缩短主进程冷启动到可显示窗口的时间 */
var sharpModule = null;
function loadSharp() {
  if (!sharpModule) {
    sharpModule = require('sharp');
  }
  return sharpModule;
}

/**
 * 「libvips 读不了的输入 → sharp 实例」的接线。**与网页端共用同一份**
 * （`src/main/sharp-input.js`）—— 两端各写一份必然漂移，而漂移的症状是
 * 「桌面端出得了图、网页端破图」，两端都"看起来正常"，只是少了一部分图片。
 *
 * 延迟加载：这条路径只有真的遇到 libvips 读不了的格式才会走到。
 */
var sharpInputModule = null;
function loadSharpInput() {
  if (!sharpInputModule) {
    sharpInputModule = require('./main/sharp-input');
  }
  return sharpInputModule;
}

// Face recognition removed

function isTrashAbortLikeError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  return /abort/i.test(String(err.message || err));
}

function escapePsSingleQuotedPath(filePath) {
  return String(filePath || '').replace(/'/g, "''");
}

/** Windows：Electron shell.trashItem 失败时的备用路径（VB FileSystem 送回收站） */
function moveFileToRecycleBinWindowsFallback(filePath) {
  var ps =
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('" +
    escapePsSingleQuotedPath(filePath) +
    "', 'OnlyErrorDialog', 'SendToRecycleBin')";
  var r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) {
    var detail = String((r.stderr || r.stdout || '').trim() || '退出码 ' + r.status);
    throw new Error(detail);
  }
}

/**
 * Windows 上 shell.trashItem 易报 AbortError / Operation was aborted；短延迟重试 + PowerShell 兜底。
 */
async function shellTrashItemWithFallback(absPath) {
  var lastErr;
  var attempts = 3;
  var i;
  for (i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 200 * i);
      });
    }
    try {
      await shell.trashItem(absPath);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (process.platform === 'win32' && fs.existsSync(absPath)) {
    try {
      moveFileToRecycleBinWindowsFallback(absPath);
      if (!fs.existsSync(absPath)) return;
      lastErr = new Error('回收站操作未完成，文件仍在原位置');
    } catch (ePs) {
      lastErr = ePs;
    }
  }
  throw lastErr || new Error('移入回收站失败');
}

function formatTrashFailureError(err) {
  var raw = err && err.message ? String(err.message) : String(err || '');
  if (isTrashAbortLikeError(err)) {
    return '移入回收站失败（操作被系统中断）。请关闭可能占用该文件的程序后重试；网络路径或只读介质可能不支持回收站。';
  }
  return raw || '移入回收站失败';
}

/**
 * ⚠️ 各任务的 ETA 求值**已搬到 `src/main/eta.js`**（2026-10-08）。
 *
 * 为什么搬：这套算法原先就地住在这个文件里，于是**只有主进程手上拿着 `startedAt` 的任务**
 * 用得上它；人脸 / 搜图的 `startedAt` 在 worker 里 ⇒ 它们改报 `ratePerMinute`，
 * 同一个后台任务面板里就出现了两种读法（契约 §7）。搬出去之后 `main/semantic-search.js#status()`
 * 也能 require 到它（那边派生 ETA），而且「由耗时反推」与「由速率反推」并排放在一起，
 * 两条口径的差别一眼能看见 —— 留在两个文件里迟早各写一份。
 *
 * 这里只 require `estimateEtaSecondsSmoothed`（下面五处调用点用的都是它）。
 * `estimateEtaSeconds` 本文件**没有**直接调用点（原先只有平滑版内部在用），所以不必引进来。
 */

var mainWindow;
var tray = null;
var isQuitting = false;
/** 与可执行文件/自定义图标一致，供 macOS 再次 createWindow 使用 */
var cachedAppIcon = null;
var db;
var catalogCache = null;
var webServer;
/** 文件夹扫描在 worker 线程执行，状态供进度与 IPC 读取 */
var scanWorker = null;
var scanWorkerDoneReceived = false;
var workerScanIsActive = false;
var workerScanProgress = {
  current: 0,
  total: 0,
  status: 'idle',
  currentFile: '',
};
/** 当前目录扫描开始时间（毫秒），用于预计剩余时间 */
var workerScanStartedAt = 0;
/**
 * worker 最近一次自报的「正在跑哪个阶段」（scan-worker → `{type:'phase'}`）。
 *
 * 只为一件事：心跳看门狗超时时能说出**卡在哪一步**。worker 是单线程，同步 SQL 期间连心跳都
 * 发不出去，所以「静默 120 秒」既可能是真死锁、也可能是某一阶段同步太久 —— 没有这个字段，
 * 报错只能是一句「线程无响应，请重试」，用户重试十次也还是同一句话。
 */
var workerScanLastPhase = '';
/** 阶段名 → 用户能看懂的说法（只用于报错文案，不影响逻辑） */
var SCAN_PHASE_LABELS = {
  start: '启动扫描线程',
  enumerate: '枚举文件',
  partition: '比对文件变更',
  'scan-files': '写入图片记录',
  'cleanup-stale': '清理失效记录',
  'refresh-stats': '重算目录统计',
  cancel: '响应取消',
};
var scanQueue = [];
/**
 * 规范化 rootPath → 扫描任务，用于**同目录去重**（见 `enqueueScanTask`）。
 * 没这个表的话，重复点「扫描」会真的排两次、扫两遍同一个目录。
 */
var scanTasksByRoot = new Map();
var isScanQueueProcessing = false;
var currentScanTask = null;
var scanTaskIdSeq = 1;
/** 单次补全任务记录的失败路径上限，避免极端情况下占用过多内存 */
var THUMB_BACKFILL_FAILED_PATHS_MAX = 50000;
/**
 * 缩略图补全**同时处理张数**的默认值与上界。**唯一真相源** ——
 * `createDefaultSettings()` 与 `normalizeGeneralSettings()` 的兜底都引用这两个常量，
 * 别在一处写 4、另一处写 3（那会让「默认值」与「非法值兜底」悄悄不一致，
 * 症状是「配置文件坏掉之后速度变了」，且不报错）。
 *
 * 为什么是 4 / 上限为什么是 8：见 `createDefaultSettings()` 里那张两轮实测表。
 * 一句话 —— 冷读（外接盘）拐在 4、热读拐在 8，12/16 无增益。
 *
 * ⚠️ 渲染层 `src/renderer/app.js#normalizeThumbBackfillConcurrency` 有**同一份兜底值**，
 *    它是独立进程、拿不到这里的常量。改这个数时三处一起改（这里两个常量 + 那边一个字面量）。
 */
var THUMB_BACKFILL_CONCURRENCY_DEFAULT = 4;
var THUMB_BACKFILL_CONCURRENCY_MAX = 8;
/**
 * 副指标「还缺多少张预览图」的刷新间隔。
 *
 * 🔴 它是**实时值**（2026-10-06 起），不是任务起始快照。改成实时的理由见
 *    `countPendingThumbnailsForProgress()`。
 *
 * 🔴 **5 s（2026-10-06 由 30 s 下调）—— 这个数是量出来的，不是拍的**：
 *    那次计数 = worker 里一句 `COUNT(*) WHERE has_thumbnail = 0`，命中覆盖索引
 *    `idx_photos_hasThumb`，本机实测**中位 14.0 ms**（8.0~14.6 ms，8 次）⇒
 *    占空比 14 ms / 5 s = **0.28%**；而读池本身占用率才 0.016%，加这点没关系。
 *    ⚠️ 原注释写「本机 150 ms、外接机械盘上会慢几个数量级」是**当时的估计、不是实测**，
 *    而且前提也不成立：**库在 `LOCALAPPDATA`（系统盘），只有图片在 `K:` / `G:` 外接盘**
 *    ⇒ 这个计数读的是本地库、根本不碰那块外接盘。所以「为了不抢外接盘而取 30 s」
 *    这条理由站不住（30 s 的真实后果是：读数每跳只降约 300 张 / 占 28.7 万基数的 0.1%，
 *    看着像卡住）。⚠️ 若将来把 UserData 挪到外接盘或网络路径，这条必须重新量。
 */
var THUMB_TOTAL_REFRESH_MS = 5000;
/**
 * 副指标刷新定时器的滴答间隔。
 *
 * 🔴 必须**严格小于** `THUMB_TOTAL_REFRESH_MS`：两者相等时，定时器只要早触发一点点
 *    就会被节流闸门挡掉，硬生生把一个 5 s 周期拖成 10 s（本项目踩过同类的定时器坑）。
 */
var THUMB_TOTAL_TICK_MS = 1000;
/** 副指标刷新定时器句柄（随补全任务起手 / 收尾，见 `start/stopPendingThumbRefreshTicker`）。 */
var thumbTotalRefreshTimer = null;
/** 副指标刷新是否**在途**。worker 慢时不许叠起来（每次都在扫同一个库）。 */
var thumbTotalRefreshInFlight = false;
/** 上次取「还缺多少张」的时刻，同时充当节流闸门（初始值 0 = 从未取过）。 */
var thumbTotalRefreshedAt = 0;
var thumbnailBackfill = {
  running: false,
  cancelled: false,
  /**
   * 本轮**已取出的候选行数**（含当前这一批里还没处理完的）。
   *
   * 🔴 它**曾经叫 `total` 并被 UI 当「总数」用**，而它是滚动累加的（每批 `+= rows.length`）——
   *    于是 `total - done` 恒等于「当前这批还剩几行」（≤ 100），百分比在 0↔100% 之间锯齿，
   *    剩余时间也只在批次尺度上打转。改名成 `fetched` 就是为了让任何残留的旧用法
   *    **立刻变成 undefined 而不是静默拿到一个错的数**；现在它只进日志。
   */
  fetched: 0,
  /**
   * 「**当前**还缺缩略图的张数」的**基线**（最近一次精确统计值）——副指标的 M。
   *
   * 🔴 它**不是**直接画到 UI 上的那个数。UI 要的是**实时值**，由
   *    `currentPendingThumbTotal()` = 本字段 − 「自基线以来新生成的缩略图数」（`thumbs` 增量）
   *    派生出来。
   *
   * 为什么必须派生：精确统计要沿索引扫 166 万条（本机实测 16 ms，但库在外接机械盘 /
   * 网络路径上可以慢几个数量级），**不可能每批都跑**；而它在两次统计之间**一动不动**。
   * 于是用户看到的是「预览图 N 在涨、还缺 M 不动」—— 2026-10-06 用户就是这么报上来的。
   * 对比之下旁边三项（拍摄信息 / 视觉指纹 / 查重指纹）都是累加器、每批都变，
   * 这一项显得尤其像坏了。
   *
   * ⚠️ 派生的前提是「**只有本任务会写出缩略图**」。运行期并发的**扫描入库**会新增缺图的行，
   *    这部分派生不出来 ⇒ 仍靠 `THUMB_TOTAL_REFRESH_MS`（5 s）周期精确统计纠偏，
   *    偏差有上界（最坏一个周期内新增的入库行数）。
   *
   * 🔴 **不是**主进度条的分母（主分母是 `pendingTotal`）。见 `countPhotosLackingThumbnail()`：
   *    曾经拿它当分母，结果因为「倒序走 + 缺缩略图的行几乎全在低位老图片上」，
   *    进度条在 0% 上趴了十几分钟不动。这条历史不能因为改了刷新方式就丢掉。
   * @type {number|null}
   */
  thumbTotal: null,
  /**
   * 取到 `thumbTotal` 那个基线**同一时刻**的 `thumbs` 值。
   *
   * 🔴 派生实时剩余时必须拿 `thumbs` **减它**再扣：不减就等于把「基线之前已经生成的那批」
   *    也当成从基线里扣掉了 ⇒ **越跑越低**，最后恒显示 0（而实际还有几十万张缺）。
   *    两者之间不能有 `await`（单线程下即原子），否则快照与基线会错位。
   */
  thumbTotalBaseThumbs: 0,
  /**
   * 主进度条的**分母**：任务起手时「候选集」规模的**抽样估计值**（约数，非精确值）。
   * 候选谓词要扫全表（实测 80~95 秒）⇒ 只能抽样，见 `estimatePendingCandidateCount()`。
   * @type {number|null}
   */
  pendingTotal: null,
  /**
   * 分母的取值状态，决定 UI 敢不敢画百分比：
   *   `'counting'` = 已发起统计、结果还没回来（异步走读 worker，**不在前台等**）
   *   `'ready'`    = `pendingTotal` 可用
   *   `'failed'`   = 统计失败 ⇒ 降级：只说「已处理 N 张」，不显示百分比与剩余时间
   * 未运行时为 `null`。
   * @type {'counting'|'ready'|'failed'|null}
   */
  pendingPhase: null,
  /**
   * 当前在跑哪一趟：`'thumbnail'` = 先补「还缺缩略图」的（会出图）；
   * `'metadata'` = 后补只缺 EXIF / dHash / 尺寸的（**本来就不出图**）。
   * 未运行时为 `null`。
   *
   * 🔴 为什么值得暴露：第二趟的 `thumbs` 恒为 0 是**设计如此**，不是卡住 ——
   *    UI 拿不到这个字段就只能显示「预览图 0 张」，用户合理地以为任务没干活
   *    （2026-10-06 用户就是这么报上来的）。
   * @type {'thumbnail'|'metadata'|null}
   */
  pass: null,
  /**
   * 每轮任务的**身份**：`runToken` 在起手时自增，异步统计回来时对不上就丢弃。
   * 没有它，上一轮迟到的分母会写进下一轮的状态 —— 不报错，只是百分比全错。
   */
  runToken: 0,
  /**
   * 本轮**新生成缩略图**的张数 —— **副指标**的 N（不是主分子；主分子是 `done`）。
   * 跳过早有缩略图、只补元数据的行不计。
   */
  thumbs: 0,
  /** 本轮顺带补出**原图尺寸**的行数：只进状态与日志，让用户看到「不只在做预览图」 */
  sized: 0,
  /** 本轮顺带补出 **dHash** 的行数：同上 */
  dhashed: 0,
  done: 0,
  success: 0,
  /** 本轮顺带补出的查重指纹（SHA-256）条数：只用于日志与分组缓存失效判据，不进 UI 状态 */
  hashed: 0,
  /** 本轮「试过读拍摄参数」的行数（写了 `exif_mtime` 标记）：只进日志 */
  exifChecked: 0,
  /** 其中真的解析出至少一项拍摄参数的行数（截图 / 网图 / PNG 本就没有 EXIF）：只进日志 */
  exifFilled: 0,
  failed: 0,
  currentFile: '',
  /** @type {number} */
  startedAt: 0,
  /** 当前任务中失败的文件路径（运行结束后会快照到 failedPathsLastRun） */
  /** @type {string[]} */
  failedPaths: [],
  /** 上一轮已结束任务中的失败路径，供导出（新任务运行期间仍保留直至本轮结束） */
  /** @type {string[]} */
  failedPathsLastRun: [],
};
/**
 * 「缩略图全量重跑」任务状态 —— 与 `thumbnailBackfill` **完全分开**的一份。
 *
 * 为什么不给补全加一个参数（三条理由，都是「合起来会静默错」那一类）：
 *   ① **候选集来源不同**。补全取「还没有缩略图的行」（`_sqlNeedsThumbnailExpr()`），
 *      重跑取**队列**（登记时按规格筛出来的行）。两边的取批代价特征还相反：
 *      补全走部分索引（真库实测 8 ms），重跑走队列表主键（代价 ∝ 批大小）。
 *   ② **进度口径不同**。补全的分母是**抽样估计**（候选谓词要扫全表，80~95 s）
 *      ⇒ UI 必须写「约」；重跑的分母是**精确值**（登记时 `INSERT` 的行数累加）
 *      ⇒ 写「约」反而是在说实话的地方含糊。
 *   ③ **准入互斥**。两者都要把整文件读一遍、抢同一块盘（本机 K:/G: 是外接机械盘），
 *      同时跑只会互相拖慢，谁先谁后交给用户决定。
 *
 * ⚠️ `total` / `done` / `failed` 三个计数**持久化**在 `thumb_regen_meta` 单行里：
 *    它们是「这条队列」的累计值，不是「本次进程」的值 —— 关掉应用再打开接着跑，
 *    进度条必须接着走，而不是从 0 重新数（分母重数会让百分比突然掉回去）。
 */
var thumbnailRebuild = {
  running: false,
  cancelled: false,
  /**
   * `'enqueueing'` = 正在登记（还没扫完全库的 id 空间）
   * `'draining'`   = 正在抽干队列里的行
   * `''`           = 未运行
   * @type {'enqueueing'|'draining'|''}
   */
  phase: '',
  /** 本轮登记进队列的累计张数（= 进度分母），持久化 */
  total: 0,
  /** 已抽干的张数（= 进度分子），持久化；含失败与「这行已不在库里」两类 */
  done: 0,
  /**
   * 🔴 **本次进程起手时 `done` 的快照** —— 只为把 ETA 的分子分母拉回同一口径。
   * `done` 是**跨重启累计**（存在 `thumb_regen_meta` 里），`startedAt` 却是本次进程的起手时刻
   * ⇒ 直接拿这两个算速率 = 「整条队列的累计完成量 ÷ 本次跑了多久」（2026-10-08 真库实测：
   * 重启续跑 21 分钟、`done` 38.7 万 ⇒ 速率被放大成 **305 张/秒**，而实测 17 张/秒
   * ⇒ 界面显示「预计剩余约 1 小时 9 分」，真实约 **20.7 小时**）。
   * 用这个快照把分子换成「这一趟真正做的量」后，remaining 不变、速率回到真值。
   * 与五个顺手产出计数同款：**本次进程口径、不持久化**。
   */
  doneAtStart: 0,
  /**
   * 同上，给 `failed` / `missing` 各留一份起手快照 —— 界面要报「**本次**重出多少、**本次**失败多少」。
   * 这三个数全是**跨重启累计**的（存在 meta 里），而副行另外五项（尺寸 / 拍摄信息 / 视觉指纹 /
   * 查重指纹 + 队列剩余）分别是本次与队列口径 ⇒ **同一条副行里不能一半累计、一半本次**。
   * 🔴 2026-10-08 用户指出：「已完成的不是这一次跑的」—— 首版把累计 `done` 当本次产出报，
   * 现场是「本次起了 21 分钟、界面报『已重出 387,250』」，其中 37 万是上一个进程做的。
   * 累计口径的正确去处是**主行的 `done / total`**（那是总账），以及空闲态的设置页文案。
   */
  failedAtStart: 0,
  missingAtStart: 0,
  failed: 0,
  /** 登记阶段**已扫过的行数**（id 区间宽度累计）：让「还在登记」那段时间有东西可看 */
  scanned: 0,
  /** 抽干阶段「队列里有、`photos` 里已经没有了」的张数 */
  missing: 0,
  /**
   * 下面五个是**顺手产出**的计数（2026-10-08 并入）：
   * 重跑本来就要把原图完整读一遍 + 解一次码，而补全那边的四样（原图尺寸 / 拍摄参数 /
   * dHash / 查重指纹）**吃的是同一次读盘与同一次解码** ⇒ 白并过来。
   * 不并的代价是同一批字节被读两遍：补全第二支在真库上还欠 **857,372 行**（2026-10-08 实测），
   * 而原图在 K:/G: 外接机械盘上，读盘就是这里的主导成本。
   * ⚠️ 它们**只统计本轮真的写进库的行数**（判据同补全：写成功了才自增），
   *    不是「看过的行数」—— 后者会让界面把「这行早就有值、跳过了」也算成产出。
   */
  sized: 0,
  exifChecked: 0,
  exifFilled: 0,
  dhashed: 0,
  hashed: 0,
  currentFile: '',
  /** @type {number} */
  startedAt: 0,
  /** 本轮的目标规格（起手时取一次快照；跑到一半改设置**不会**改这一轮的目标，见 `runThumbnailRebuild`） */
  targetSize: 0,
  targetFormat: '',
  runToken: 0,
  /** @type {string[]} */
  failedPaths: [],
  /** @type {string[]} */
  failedPathsLastRun: [],
};
/** 登记阶段一次扫多少个 id 区间宽度 —— 决定单次持写锁的时长上界（真库 4 万行约 5~10 s） */
var THUMB_REGEN_ENQUEUE_CHUNK = 40000;
/** 抽干阶段的批大小 */
var THUMB_REGEN_DRAIN_BATCH = 50;
var autoBackfillScheduled = false;
var autoDuplicateHashScheduled = false;
var autoDuplicateHashRetryTimer = null;
var sqliteDbPath = '';
/**
 * 图库数据目录（photos.db / ai-search / face-index / catalog-cache.db 落在哪）。
 * 默认等于 Electron 的 userData；设置页可以把它整份迁到别的盘，位置记在 settings.json。
 */
var libraryDataDir = '';
/**
 * 迁移一次的状态机。`running` 期间界面禁用「迁移」按钮，并且**不许再有任务去碰数据库**
 * —— 迁移前要先关掉全部连接，中途被别的任务重新打开会让「复制的是静态快照」这条前提失效。
 */
var dataDirMigration = { running: false, phase: '', copiedBytes: 0, totalBytes: 0, current: '' };
/**
 * 设置了 dataDir 但用不了（盘没插 / 权限不足）时回退到默认位置的**原因**，空串表示没回退。
 * 🔴 它必须能被界面读到：回退后库多半是空的，用户第一反应是「我的图片没了」，
 *    不把原因说出来就是一次静默失效。
 *
 * 这里放的是**给用户看的一句话**（「Z:\xxx 打不开」）；原始报错另存 `dataDirFallbackDetail`。
 * 两者分开是有意的：正文里塞 `EPERM: operation not permitted, mkdir 'Z:\...'`
 * 只会让人以为出了大事，而排查时又确实需要原文 —— 所以一句进正文、原文挂悬停。
 */
var dataDirFallbackReason = '';
var dataDirFallbackDetail = '';
var semanticSearch = null;
/** 图片信息面板读「主题标签」的只读通道（标签在搜图索引库里，不在 photos 表）。 */
var semanticTags = null;
/** 图片信息面板读「画面标签」（JoyTag）的只读通道（标签在 tag 索引库里，同样跨不了主库）。 */
var joyTagTags = null;
/** 「标签导航页」的数据服务（`main/tag-nav.js`）。同样惰性只读、读不到降级空结构。 */
var tagNav = null;
var faceService = null;
/** 启动期 GPU 能力探测器（每次启动探一次，结论落盘到搜图 AI 目录）。 */
var gpuProbe = null;
/**
 * 有维护任务在跑（**两种语义的或集**，供「界面显示优化中 / 长任务避让 / 禁止退出」使用）。
 *
 * ⚠️ 它**不再**是 AI 索引的准入判据 —— 见下面 `exclusiveMaintenanceRunning`。
 */
var optimizeTaskRunning = false;
/**
 * 只有**独占整库**的维护（VACUUM / 重建缩略图标记）才为真，AI 索引必须为它让路。
 *
 * 与 `optimizeTaskRunning` 分开的直接原因：启动期的 FTS 索引（`ensureFtsIndex`）也占着
 * `optimizeTaskRunning`，但它是**批量写**，与 AI 索引走同一条写库队列、彼此不会撞锁。
 * 两者共用一个变量时，开机十几秒内点「建 AI 索引」会被误报 `AI_MAINTENANCE`。
 * 判据本身在 `src/main/ai-index-gate.js`（可被回归真跑）。
 */
var exclusiveMaintenanceRunning = false;

var maintenanceResult = null;
function maintenanceBusy() {
  return (
    optimizeTaskRunning ||
    // 两套 AI 索引在跑时它们一直持有 photos.db 连接并反复写批次事务，此时做维护必然撞锁。
    aiIndexTaskBusy() ||
    // 启动期三个一次性写库任务（缩略图标记修复 / 延迟索引 / FTS 维护）各持一把写锁，
    // 队列里还有人没跑完就等于「库正被写」，同样不许插队。
    dbWriteQueue.isBusy() ||
    isScanQueueProcessing ||
    scanQueue.length > 0 ||
    isFolderScanRunning() ||
    thumbnailBackfill.running ||
    // 全量重跑同样在按批写库（每批几十行 UPDATE），维护任务撞上它必然等锁
    thumbnailRebuild.running ||
    duplicateHashTask.running ||
    invalidCleanupTask.running ||
    startupInvalidCleanupTask.running
  );
}
/**
 * 当前挡着库的是谁：给界面一句能行动的话，而不是笼统的「后台任务进行中」。
 *
 * 🔴 这里返回的每一句都会被拼进 `maintenanceBusyMessage()` 的「正在……，请等它完成后再试」，
 *    所以**必须是动词开头的短语**（「正在扫描目录」读得通，「正在目录扫描」读不通）。
 *    另外别再出现「数据库迁移」这种词：图库数据搬家（设置页那个功能）也叫迁移，
 *    两边撞名之后，用户看到「数据库迁移」根本不知道说的是哪件事。
 */
function dbWriteBusyLabel() {
  var name = dbWriteQueue.busyName();
  if (!name) return '';
  if (name === 'thumbnail-fix') return '校正缩略图记录';
  if (name === 'deferred-index') return '补齐数据库索引';
  if (name === 'fts-index') return '重建文件名索引';
  if (name === 'invalid-cleanup') return '清理失效记录';
  // 回填 / 重复哈希现在是**按批次**占写锁的，批间会放开让别的任务过，
  // 所以它们也会出现在 busyName() 里（过去这两个任务压根不进队）。
  if (name === 'thumbnail-backfill') return '补全缩略图';
  if (name === 'dup-hash') return '比对重复文件';
  // 全量重跑的两个票据名（登记 / 抽干）都报同一句 —— 它们对用户是同一件事
  if (name === 'thumb-regen' || name === 'thumb-regen-enqueue') return '重建全部缩略图';
  // 扫描（T2 起）也占闸门：它是最长的一个占用者，报出名字比笼统的「后台任务」有用得多
  if (name === 'scan') return '扫描目录';
  // 手动维护这两条一直漏了映射 → 界面会直接显示英文任务名
  if (name === 'maintenance-rebuild-thumbnail-flags') return '重建缩略图记录';
  if (name === 'maintenance-optimize-database') return '整理数据库';
  return name;
}
/** 维护被挡时的文案：能让用户知道在等谁、等的是什么，比笼统的 busy 有用得多。 */
function maintenanceBusyMessage() {
  var label = dbWriteBusyLabel();
  // 不再写「启动期」：T2 起扫描、手动维护也走同一条队列，被挡住的未必是启动期任务
  if (label) return '正在' + label + '，请等它完成后再试';
  return '图库正在处理其他任务，请稍后再试';
}
function aiIndexTaskBusy() {
  return maintenanceGuard.aiIndexBusy([semanticSearch, faceService], function (error) {
    logger.warn('[maintenance] AI status probe failed:', error && error.message);
  });
}
/** VACUUM 的空间开销与收益；取不到返回 null（表示不拦、也不显示数字）。 */
function vacuumSpaceEstimate() {
  try {
    const stats = {
      pageSize: db.db.pragma('page_size', { simple: true }),
      pageCount: db.db.pragma('page_count', { simple: true }),
      freePages: db.db.pragma('freelist_count', { simple: true }),
      fileSize: fs.statSync(sqliteDbPath).size,
    };
    return {
      need: maintenanceGuard.vacuumWorkspaceBytes(stats),
      reclaimable: maintenanceGuard.vacuumReclaimableBytes(stats),
      fileSize: stats.fileSize,
    };
  } catch (error) {
    logger.warn('[maintenance] vacuum space estimate failed:', error && error.message);
    return null;
  }
}
/** VACUUM 的临时库可能落地的两处位置，各自可用空间（-1 表示未知）。 */
function vacuumSpacePlaces() {
  return [
    { label: '图库数据所在磁盘', free: maintenanceGuard.freeDiskBytes(path.dirname(sqliteDbPath)) },
    { label: '系统临时文件夹', free: maintenanceGuard.freeDiskBytes(os.tmpdir()) },
  ];
}
/** 磁盘不够就直说差多少，而不是让它跑到一半 I/O 失败。返回空串表示放行。 */
function vacuumSpaceShortage() {
  const estimate = vacuumSpaceEstimate();
  if (!estimate || !estimate.need) return '';
  return maintenanceGuard.vacuumSpaceShortage(estimate.need, vacuumSpacePlaces());
}
/** 确认弹窗里那句「两处都够不够」的明细。 */
function vacuumSpaceSummary() {
  return vacuumSpacePlaces()
    .map(function (place) {
      return (
        place.label + ' ' + (place.free < 0 ? '未知' : maintenanceGuard.formatBytes(place.free))
      );
    })
    .join('、');
}
/** 空洞少到可忽略时直说：这次整理基本只是刷新统计信息，别为了几 MB 重写整库。 */
function vacuumReclaimHint(estimate) {
  if (!estimate || estimate.reclaimable * 100 >= estimate.fileSize) return '';
  return '（几乎回收不出空间，这次整理主要是刷新查询统计信息）';
}
async function performMaintenance(operation) {
  try {
    // A UI write must fail promptly rather than wait on the maintenance write lock.
    db.db.pragma('busy_timeout = 0');
    maintenanceResult = { operation, status: 'running' };
    const result = await runDatabaseMaintenance(sqliteDbPath, operation);
    maintenanceResult = { operation, status: 'complete', result };
    logger.info('Database maintenance complete:', operation, result);
  } catch (error) {
    // 闸门已经拦在前面了，这里再撞锁说明是没预料到的占用方（外部工具、别的实例）。
    // 裸的 `database is locked` 没人看得懂，换成一句能行动的话，同时保留原始信息便于排查。
    const raw = (error && error.message) || '';
    const locked = /database is locked|SQLITE_BUSY/i.test(raw);
    maintenanceResult = {
      operation,
      status: 'failed',
      error: locked
        ? '数据库被其他程序占用，暂时无法维护。请关闭占用它的程序（或另一个图库窗口）后重试。\n\n（' +
          raw +
          '）'
        : raw,
    };
    logger.error('Database maintenance failed:', error);
    if (operation !== 'ensureFtsIndex' && mainWindow && !mainWindow.isDestroyed()) {
      void alertInApp({
        variant: 'error',
        title: '数据库维护没有完成',
        message: maintenanceResult.error,
      });
    }
  } finally {
    db.db.pragma('busy_timeout = 8000');
    // 两个标志都在这里收口：`performMaintenance` 是维护的唯一出口（不论走哪个 operation、
    // 成功还是失败），漏清一个就会让 AI 索引被永久拒之门外 —— 那种卡死没有任何报错。
    optimizeTaskRunning = false;
    exclusiveMaintenanceRunning = false;
    emitBackgroundTasksChangedThrottled(true);
  }
}
/* ============ 主进程发起的提示 / 确认：一律交给渲染端画 ============ */

/**
 * 主进程没有界面，它自己弹的 `dialog.showMessageBox` 是**系统**外观 —— 暗色主题下白底、
 * 亮色主题下灰底，跟应用里其它弹窗（`#appDialogOverlay`，见 `styles.css` 的那一套
 * `--bg-card` / `--accent` 变量）是两套东西。所以提示统一走
 * 「主进程发请求 → 渲染端画 → 回传结果」；**只有渲染端用不了**（窗口没起、页面崩了、
 * 20 秒没人应答）才回落到系统弹窗 —— 那时候宁可难看，也不能一声不响。
 *
 * 🔴 每个请求带 id，超时与应答都必须**结算**：等在这里的调用方是「清理无效记录」
 *    这类确认框，悬挂就等于「点了按钮永远没反应」。
 */
var appDialogSeq = 0;
var pendingAppDialogs = new Map();
var APP_DIALOG_TIMEOUT_MS = 20000;

function resolveAppDialog(id, result) {
  var pending = pendingAppDialogs.get(id);
  if (!pending) return;
  pendingAppDialogs.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(result);
}

function askInAppDialog(options) {
  var opts = options || {};
  var mode = opts.type === 'confirm' ? 'confirm' : 'alert';
  return new Promise(function (resolve) {
    var wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (!wc) {
      resolve({ available: false, confirmed: false });
      return;
    }
    /**
     * 窗口收在托盘里时，画在窗口内的弹窗等于「提示了但看不见」（系统弹窗不会这样）。
     * 所以发之前先把窗口叫出来 —— 反正接下来就是要用户看一句话或者点一下。
     */
    try {
      if (!mainWindow.isVisible()) showMainWindow();
    } catch (e) {
      void e;
    }
    var id = ++appDialogSeq;
    var timer = setTimeout(function () {
      logger.warn('[dialog] 渲染端未应答，回落系统弹窗：' + (opts.title || ''));
      resolveAppDialog(id, { available: false, confirmed: false });
    }, APP_DIALOG_TIMEOUT_MS);
    pendingAppDialogs.set(id, { resolve: resolve, timer: timer, mode: mode });
    try {
      wc.send('app-dialog-request', {
        id: id,
        type: mode,
        title: opts.title || '',
        message: opts.message || '',
        okText: opts.okText || '',
        cancelText: opts.cancelText || '',
        // 有 i18n 键就让渲染端按当前语言渲染（主进程不该自己拼界面文案）；
        // 没有就用手传的原文（沿用它的是既有那些中文硬编码串）。
        i18n: opts.i18n || null,
      });
    } catch (e) {
      void e;
      resolveAppDialog(id, { available: false, confirmed: false });
    }
  });
}

/** 确认框：渲染端能画就用主题弹窗，画不了才回落系统弹窗。返回 true = 用户确认。 */
async function confirmInApp(options) {
  var opts = options || {};
  var res = await askInAppDialog(Object.assign({}, opts, { type: 'confirm' }));
  if (res.available) return res.confirmed === true;
  var picked = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['取消', opts.okText || '确认'],
    defaultId: 0,
    cancelId: 0,
    title: opts.title || '请确认',
    message: opts.message || '',
  });
  return picked === 1;
}

/** 提示框：同上，不需要结果。用 `void alertInApp(...)` 调用即可。 */
async function alertInApp(options) {
  var opts = options || {};
  var res = await askInAppDialog(Object.assign({}, opts, { type: 'alert' }));
  if (res.available) return;
  void dialog.showMessageBox(mainWindow, {
    type: opts.variant === 'error' ? 'error' : 'info',
    title: opts.title || '提示',
    message: opts.message || '',
  });
}

/* ==================== 数据目录（图库数据落在哪 / 怎么迁走） ==================== */

/**
 * 当前**实际生效**的数据目录。没解析过（启动早期）时退回 userData，调用方拿到的永远是
 * 一个可用路径，不会出现「空串拼出一个相对路径」这种静默落到当前工作目录的事故。
 */
function currentDataDir() {
  if (libraryDataDir) return libraryDataDir;
  try {
    return app.getPath('userData');
  } catch (e) {
    void e;
    return '';
  }
}

/**
 * 启动时把 settings.json 里的 `dataDir` 变成「真的能用」的目录。
 *
 * 🔴 **回退必须留痕**：配了 D 盘而 D 盘没插，最省事的做法是悄悄用回 C 盘默认位置，
 *    但那样界面会打开一个**空图库** —— 用户看到的是「图片全没了」，而这只是盘没插。
 *    所以回退时写 `dataDirFallbackReason`，首窗出来后弹一次，并在设置页常驻显示。
 */
function resolveDataDirPath(userDataPath) {
  var configured = String((settings && settings[dataDirLib.SETTING_KEY]) || '').trim();
  if (!configured) {
    dataDirFallbackReason = '';
    dataDirFallbackDetail = '';
    return userDataPath;
  }
  var resolved = dataDirLib.normalizeDirPath(configured);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    // 真的写一个字节再删：macOS/Windows 上「目录存在」不等于「可写」，
    // 而不可写会在几分钟后的第一次写库时才炸，那时现场已经不好认了。
    var probe = path.join(resolved, '.writetest');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    dataDirFallbackReason = '';
    dataDirFallbackDetail = '';
    return resolved;
  } catch (e) {
    // 面向用户的那句：只说「哪个位置、打不开」，不搬错误码。
    // 用「无法访问」而不是再说一次「打不开」：这句会被塞进设置页那句
    // 「你指定的位置这次打不开……（{reason}）」的括号里，重复用词会读成复读机。
    dataDirFallbackReason = '无法访问 ' + resolved;
    dataDirFallbackDetail = (e && e.message ? e.message : String(e)) || '';
    logger.warn(
      '[data-dir] 已配置的数据目录不可用（' +
        resolved +
        '）：' +
        dataDirFallbackDetail +
        ' → 本次回退到默认位置 ' +
        userDataPath,
    );
    return userDataPath;
  }
}

/** 给界面的一句「现在在哪、多大、还剩多少」。 */
function describeDataDir() {
  var dir = currentDataDir();
  var entries = dataDirLib.listEntries(dir);
  var total = dataDirLib.totalBytes(entries);
  var configured = String((settings && settings[dataDirLib.SETTING_KEY]) || '').trim();
  return {
    success: true,
    dataDir: dir,
    defaultDataDir: app.getPath('userData'),
    configuredDataDir: configured,
    isCustom: !!configured && !dataDirLib.isSameDir(configured, app.getPath('userData')),
    dbPath: sqliteDbPath || path.join(dir, 'photos.db'),
    entries: entries,
    totalBytes: total,
    dbFileBytes: (function () {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].name === 'photos.db') return Number(entries[i].bytes) || 0;
      }
      return 0;
    })(),
    freeBytes: maintenanceGuard.freeDiskBytes(dir),
    migrating: dataDirMigration.running,
    fallbackReason: dataDirFallbackReason || '',
    fallbackDetail: dataDirFallbackDetail || '',
  };
}

function emitDataDirProgress(patch) {
  dataDirMigration = Object.assign({}, dataDirMigration, patch || {});
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('data-dir-migrate-progress', {
        running: dataDirMigration.running,
        phase: dataDirMigration.phase,
        copiedBytes: dataDirMigration.copiedBytes,
        totalBytes: dataDirMigration.totalBytes,
        current: dataDirMigration.current,
        // 校验阶段的**已耗时**。⚠️ 这个字段必须显式列在这里：`emitDataDirProgress` 是白名单
        //    拼装的（不是整份透传），漏了它 = 校验那几分钟里界面一个字都不动 —— 用户报的
        //    「卡死」有一半就是这个观感（另一半是主线程真的被占住，见 `verifyCopiedLibrary`）。
        verifyMs: Number(dataDirMigration.verifyMs) || 0,
        percent:
          dataDirMigration.totalBytes > 0
            ? Math.min(100, Math.round((dataDirMigration.copiedBytes / dataDirMigration.totalBytes) * 100))
            : 0,
      });
    } catch (e) {
      void e;
    }
  }
}

/**
 * 迁移前把**所有**还握着数据库的东西放开。
 *
 * 复制 19 GB 要几分钟，这段时间库必须是静态的 —— 否则「复制的是某一时刻的快照」这条
 * 前提不成立，副本可能半新半旧。名单照抄 `before-quit` 那一套（那是本工程唯一一处
 * 已经把所有持有者列全的地方），再加 `db` / `catalogCache` 两个连接。
 */
function releaseRuntimeHandlesForMigration() {
  try {
    if (webServer && typeof webServer.stop === 'function') webServer.stop();
  } catch (e) {
    void e;
  }
  try {
    stopCloudflareTunnelInternal();
  } catch (e) {
    void e;
  }
  try {
    if (semanticSearch) semanticSearch.dispose();
  } catch (e) {
    void e;
  }
  try {
    if (semanticTags) semanticTags.close();
  } catch (e) {
    void e;
  }
  try {
    if (faceService) faceService.dispose();
  } catch (e) {
    void e;
  }
  try {
    dbReadWorkerPool.terminate();
  } catch (e) {
    void e;
  }
  try {
    if (catalogCache && typeof catalogCache.close === 'function') catalogCache.close();
  } catch (e) {
    void e;
  }
  try {
    if (db && typeof db.close === 'function') {
      // 先把 WAL 收进主库再关：干净关闭理论上也会做，但那是「理论」——
      // 真漏了的话，我们复制的 photos.db 会缺最后一次提交，而副本校验不一定抓得到。
      try {
        db.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (e2) {
        void e2;
      }
      db.close();
    }
  } catch (e) {
    void e;
  }
}

/**
 * 迁移要**独占整个库**，所以先把「失效记录清理」让开。
 *
 * 🔴 **为什么必须让，而不是「等它跑完」**：这个清理要**扫完整个库**。启动那一趟是
 *    每批 400 行、批间 450 ms（`START_DELAY_MS` / `STEP_DELAY_MS` / `BATCH_SIZE`），
 *    在 1,656,580 行的库上量级是**几十分钟到几小时**；而它整段都举着 `maintenanceBusy()`
 *    这把闸门 ⇒「等它跑完再迁移」实际上等于「今天别迁了」。用户报的就是这个
 *    （点迁移 → 「迁移没有完成。／正在清理失效记录，请等它完成后再试」）。
 *    它本身是**开机自检**、幂等、可续跑（下次启动从头再来一遍），中断没有任何副作用 ——
 *    迁移完应用会重启，重启后它照样跑。所以「迁移时不清理失效」是安全的取舍。
 *
 * **停的是批次边界**：在途那一批会跑完（它的写库票据还在队列里），所以紧接着的第一次
 * 迁移尝试**可能仍撞到写锁** —— 界面那边按 `code: 'BUSY'` 自动重试兜住，不是失败。
 *
 * @returns {Array<{label: string, scope: string}>} 被暂停的任务，给界面如实说明用
 */
function pauseInvalidCleanupForMigration() {
  var paused = [];
  if (startupInvalidCleanupTask.running) {
    startupInvalidCleanupTask.running = false;
    if (startupInvalidCleanupTask.timer) {
      clearTimeout(startupInvalidCleanupTask.timer);
      startupInvalidCleanupTask.timer = null;
    }
    startupStageLog('invalid-cleanup.paused', 'for=data-dir-migration');
    paused.push({ label: '清理失效记录', scope: 'startup' });
  }
  // 手动那一次也停：它同样举着闸门，而且续跑语义与自动那次一致（再点一次重来一遍）。
  if (invalidCleanupTask.running) {
    invalidCleanupTask.cancelled = true;
    paused.push({ label: '清理失效记录', scope: 'manual' });
  }
  if (paused.length) {
    logger.warn('[data-dir] 迁移要独占库，已暂停失效记录清理（这一趟作废，之后可重新开始）');
    emitBackgroundTasksChangedThrottled(true);
  }
  return paused;
}

/**
 * 校验副本能不能当主库用 —— 在**独立线程**里跑，不冻界面。
 *
 * 🔴 **为什么不能就地同步跑**：唯一能查结构的一道是 `PRAGMA quick_check`，它要读完整个库。
 *    真库实测（18,345,889,792 字节 / 4,478,977 页）**318,948 ms ≈ 5 分 19 秒**；同步跑在主进程里，
 *    这 5 分钟主线程一点动不了、进度事件一条都发不出去 ⇒ 窗口被系统标成「无响应」，
 *    用户看到的就是「**正在检查新位置的数据时卡死**」。它不是死锁 —— 换成 worker 之后
 *    界面全程可动、秒数在走，同样的 5 分钟就变成「在做事」。
 *
 * 判定本身不在这个文件里：worker 只取数，`dataDirLib#judgeCopy` 是**判据唯一源**
 * （同步那条路 `verifySqliteFile` 也调它，两边不会漂移）。
 *
 * 三条兜底都是「宁可说不知道，也不许把坏库放过去」：
 *  · worker 起不来 ⇒ 退回主进程同步校验（界面会冻，但结论是对的），并 warn 留痕；
 *  · worker 抛错 / 没留结果就退出 ⇒ 返回失败，**不返回 ok**；
 *  · 超过 `VERIFY_TIMEOUT_MS` 还没结果 ⇒ 判超时失败（quick_check 是纯 I/O、没有中间进度可判，
 *    所以这个上限只做「有个头」的兜底，给得很宽；真库 18 GB 量级实测 5.3 分钟）。
 *
 * @param {string} dbFile 副本里的 photos.db
 * @param {number|null} expectPhotoCount 源库行数（对照用，null = 不参与校验）
 * @returns {Promise<{ok: boolean, code?: string, error?: string, photoCount?: number}>}
 */
var VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
function verifyCopiedLibrary(dbFile, expectPhotoCount) {
  return new Promise(function (resolve) {
    var Worker = require('worker_threads').Worker;
    var t0 = Date.now();
    var worker;
    try {
      worker = new Worker(path.join(__dirname, 'workers', 'db-verify-worker.js'), {
        workerData: { dbPath: dbFile, expectPhotoCount: expectPhotoCount },
      });
    } catch (eSpawn) {
      logger.warn(
        '[data-dir] 校验 worker 起不来，退回主进程同步校验（界面会短暂无响应）：',
        eSpawn && eSpawn.message ? eSpawn.message : String(eSpawn),
      );
      resolve(dataDirLib.verifySqliteFile(dbFile, expectPhotoCount));
      return;
    }

    var settled = false;
    var heartbeat = null;
    var killer = null;
    function done(result) {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (killer) clearTimeout(killer);
      try {
        worker.terminate();
      } catch (eT) {
        void eT;
      }
      resolve(result);
    }

    // 心跳：光有一句「正在检查…」放 5 分钟，用户没法区分「在做事」和「死了」。
    // 秒数在走 = 它一直在读盘；真卡住了也能看出来走了多久。
    heartbeat = setInterval(function () {
      emitDataDirProgress({ phase: 'verify', verifyMs: Date.now() - t0 });
    }, 3000);

    killer = setTimeout(function () {
      logger.warn('[data-dir] 副本校验超时（' + Math.round(VERIFY_TIMEOUT_MS / 60000) + ' 分钟）');
      done({
        ok: false,
        code: 'TIMEOUT',
        error:
          '检查新位置的数据超过了 ' +
          Math.round(VERIFY_TIMEOUT_MS / 60000) +
          ' 分钟还没结束，这次没有切换过去 —— 图库数据没有变动，仍在原位置。',
      });
    }, VERIFY_TIMEOUT_MS);

    worker.on('message', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.__phase) {
        // 128 KB 页头一读完就知道「文件有没有被截断」，这条只用于留痕
        if (msg.__phase === 'judge.started') {
          longTaskStageLog(
            'data-dir.verify.judge-start',
            'headerMs=' + msg.headerMs + ' bytes=' + msg.fileSize,
          );
        }
        return;
      }
      // 无论是「通过」还是「没通过」，结论都从这一条消息来（worker 取数 + judgeCopy 判定）
      longTaskStageLog(
        'data-dir.verify.done',
        JSON.stringify({
          ok: !!msg.ok,
          code: msg.code || '',
          photoCount: msg.photoCount,
          headerMs: msg.headerMs,
          quickCheckMs: msg.quickCheckMs,
          countMs: msg.countMs,
          elapsedMs: msg.elapsedMs,
        }),
      );
      done(msg);
    });
    worker.on('error', function (eErr) {
      logger.error('[data-dir] 校验 worker 出错：', eErr && eErr.message ? eErr.message : String(eErr));
      done({
        ok: false,
        code: 'VERIFY_FAILED',
        error: '检查新位置的数据时出错：' + (eErr && eErr.message ? eErr.message : String(eErr)),
      });
    });
    worker.on('exit', function (code) {
      // 没留结果就退出了 ⇒ 不能当成通过（worker 自己的路径都会先 post 再 exit）
      if (settled) return;
      logger.error('[data-dir] 校验 worker 提前退出，code=' + code);
      done({
        ok: false,
        code: 'VERIFY_FAILED',
        error: '检查新位置的数据时进程提前结束（事件码 ' + code + '），这次没有切换过去。',
      });
    });
  });
}

/**
 * 一次完整的迁移：体检 → 放手 → 复制 → 校验 → 改设置 → 删旧 → 重启。
 *
 * 🔴 **失败也要重启**：走到「放手」之后，这个进程已经没有可用的数据库连接了，
 *    留在原地就是一个看起来正常、点什么都没反应的壳。所以无论成功失败都会重启，
 *    设置没改 ⇒ 重启后回到原来的库（复制失败不会丢数据，因为旧文件只在成功后才删）。
 */
async function runDataDirMigration(targetDir, removeSource) {
  var fromDir = currentDataDir();
  // 🔴 「被闸门挡住」必须带一个**可判定的 code**：这类拒绝是**暂时**的，调用方该重试而不是
  //    报错，而重试的判据如果钉在文案上（「后台任务进行中」），文案一改就静默失效 ——
  //    实测就这么中过一次：`maintenanceBusyMessage()` 换了说法，端到端探针的重试循环
  //    突然不再重试，7 项断言一起红，看着像迁移坏了。判据要么是 code，要么是结构化字段。
  if (dataDirMigration.running)
    return { success: false, code: 'BUSY', error: '正在迁移图库数据，请稍候' };
  var check = dataDirLib.validateTarget(fromDir, targetDir);
  if (!check.ok) return { success: false, code: check.code, error: check.error };
  // 先让「失效记录清理」让开（它可能还要跑几十分钟以上），再看闸门。
  var pausedTasks = pauseInvalidCleanupForMigration();
  /**
   * 🔴 **暂停是一次「已经发生的副作用」，所以每个出口都要带上它** —— 不只是成功那条。
   *    用户看不到自己的后台任务被悄悄改期：清理被停了却报「迁移失败」，他会以为
   *    什么都没发生，下次启动发现「清理又从头开始了」也找不到原因。这里用一层包装
   *    而不是在 5 个 return 上各写一遍，就是为了**新增出口时不可能漏**。
   */
  function withPaused(result) {
    if (pausedTasks && pausedTasks.length) result.pausedTasks = pausedTasks;
    return result;
  }

  if (maintenanceBusy())
    return withPaused({
      success: false,
      code: 'BUSY',
      error: maintenanceBusyMessage(),
    });

  var plan = dataDirLib.planMigration(fromDir, targetDir);
  if (!plan.ok) return withPaused({ success: false, code: plan.code || '', error: plan.error });
  if (!plan.entries.length)
    return withPaused({
      success: false,
      code: 'NO_DATA',
      error: '当前的位置里没有找到图库数据，无法迁移',
    });
  if (plan.shortageBytes > 0) {
    return withPaused({
      success: false,
      code: 'SPACE',
      error:
        '目标磁盘空间不够：需要 ' +
        maintenanceGuard.formatBytes(plan.needBytes) +
        '，现在只有 ' +
        (plan.freeBytes >= 0 ? maintenanceGuard.formatBytes(plan.freeBytes) : '未知') +
        '（还差 ' +
        maintenanceGuard.formatBytes(plan.shortageBytes) +
        '）。请换一个空间更大的位置，或先清理一些文件。',
    });
  }

  dataDirMigration.running = true;
  emitDataDirProgress({ phase: 'prepare', copiedBytes: 0, totalBytes: plan.totalBytes, current: '' });
  emitBackgroundTasksChangedThrottled(true);

  /**
   * 迁移前记下主库的行数，给副本当对照。
   * ⚠️ 刻意**不用** `db.getStats()`：那是走重读 worker 的聚合统计（带缓存、为界面服务），
   *    在大库上一次几秒到几十秒，而且它算的是「含视频的图片数」等一堆派生口径 ——
   *    这里要的只是「副本有没有少搬内容」，一行 COUNT(*) 足够。
   */
  var expectedCount = null;
  try {
    if (db && db.db) {
      var row = db.db.prepare('SELECT COUNT(*) AS n FROM photos').get();
      expectedCount = Number(row && row.n) || null;
    }
  } catch (e) {
    void e;
  }

  var handlesReleased = false;
  try {
    emitDataDirProgress({ phase: 'release', current: '正在关闭数据库连接…' });
    releaseRuntimeHandlesForMigration();
    handlesReleased = true;

    /**
     * 🔴 **关库之后必须重新盘点一次**：体检（plan）是在库还开着的时候量的，那时 `photos.db-wal`
     *    存在；`releaseRuntimeHandlesForMigration()` 里的 `wal_checkpoint(TRUNCATE)` 会把 WAL
     *    收进主库并删掉那个文件 ⇒ 拿体检时的清单去复制，第一条就撞 ENOENT（18 GB 搬到一半才炸，
     *    或者更糟：先炸在最后一个文件上）。反向也一样 —— 关库动作本身不该改变清单。
     */
    var copyEntries = dataDirLib.listEntries(fromDir);
    var copyTotal = dataDirLib.totalBytes(copyEntries);
    if (!copyEntries.length) {
      throw new Error('关闭数据库后，原位置的数据文件不见了 —— 可能在迁移开始前被移动或删除');
    }

    emitDataDirProgress({ phase: 'copy', current: copyEntries[0].name });
    var copied = await dataDirLib.copyDataDir({
      fromDir: fromDir,
      toDir: targetDir,
      entries: copyEntries,
      totalBytes: copyTotal,
      onProgress: function (p) {
        emitDataDirProgress({
          phase: 'copy',
          copiedBytes: p.copiedBytes,
          totalBytes: p.totalBytes,
          current: p.current,
        });
      },
    });

    emitDataDirProgress({ phase: 'verify', verifyMs: 0, current: '正在校验副本…' });
    // ⚠️ 必须是 await 的 worker 版：同步版会把这 5 分钟全占在主线程上（用户报的「卡死」）
    var verify = await verifyCopiedLibrary(path.join(targetDir, 'photos.db'), expectedCount);
    if (!verify.ok) {
      // 校验没过就**不许**改设置：宁可白复制一次，也不能把用户指向一个坏库。
      throw new Error(verify.error);
    }

    settings[dataDirLib.SETTING_KEY] = targetDir;
    ensureSettingsShape();
    saveSettings();

    var removal = { removed: [], failed: [] };
    if (removeSource) {
      emitDataDirProgress({ phase: 'cleanup', current: '正在清理旧位置…' });
      // 删的必须是**真正搬过去的那份**清单（= 关库后重新盘点的），不是体检时的清单。
      removal = await dataDirLib.removeSourceEntries(fromDir, copyEntries, function (fullPath) {
        return shell.trashItem(fullPath);
      });
      /**
       * 🔴 回收站**放不下**大文件是常态（实测 426 MB 的库就报 `Operation was aborted`，
       *    真实库是 18 GB 量级），而且进了回收站也**不释放**空间（要等清空）。
       *    用户就是为了腾空间才迁的 ⇒ 回收站失败就改为直接删除，两种方式分开记账，
       *    界面据此说清楚「到底是进了回收站还是直接删了」。
       */
      if (removal.failed.length) {
        var retryEntries = removal.failed.map(function (f) {
          return { name: f.name };
        });
        logger.warn(
          '[data-dir] 回收站放不下，改为直接删除：' +
            retryEntries
              .map(function (e) {
                return e.name;
              })
              .join('、'),
        );
        var retried = await dataDirLib.removeSourceEntries(fromDir, retryEntries, null);
        removal.removedPermanently = retried.removed;
        removal.failed = retried.failed;
        if (retried.failed.length) {
          logger.warn(
            '[data-dir] 直接删除也失败了（旧位置仍占空间）：' +
              retried.failed
                .map(function (f) {
                  return f.name + ' → ' + f.error;
                })
                .join('；'),
          );
        }
      }
    }

    emitDataDirProgress({ phase: 'done', current: '', running: false });
    return withPaused({
      success: true,
      dataDir: targetDir,
      copiedBytes: copied.copiedBytes,
      photoCount: verify.photoCount,
      removed: removal.removed || [],
      removedPermanently: removal.removedPermanently || [],
      removeFailed: removal.failed || [],
      restartRequired: true,
    });
  } catch (e) {
    var message = e && e.message ? e.message : String(e);
    logger.error('[data-dir] migration failed:', message);
    emitDataDirProgress({ phase: 'failed', current: message, running: false });
    return withPaused({ success: false, error: message, restartRequired: handlesReleased });
  } finally {
    dataDirMigration.running = false;
    emitBackgroundTasksChangedThrottled(true);
  }
}

var tunnelTask = {
  enabled: false,
  running: false,
  url: '',
  status: 'idle',
  error: '',
};
var tunnelProcess = null;
var tunnelStartTimeoutTimer = null;
var tunnelLogTail = [];
var duplicateHashTask = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  hashed: 0,
  reused: 0,
  failed: 0,
  /** 库中待哈希但磁盘路径不存在，已跳过 */
  skippedMissing: 0,
  duplicateGroups: 0,
  duplicatePhotos: 0,
  currentFile: '',
  currentHash: '',
  phase: 'idle',
  /** @type {number} */
  startedAt: 0,
};
var duplicateHashGroupsCache = {
  minCount: 2,
  pageSize: 40,
  total: null,
  totalPages: null,
  pages: Object.create(null),
  warmedAt: 0,
};

/** 相似检测（dHash）第零层精确匹配缓存 */
var similarDhashGroupsCache = {
  pageSize: 40,
  total: null,
  totalPages: null,
  pages: Object.create(null),
  warmedAt: 0,
};
function clearSimilarDhashGroupsCache(reason) {
  similarDhashGroupsCache.total = null;
  similarDhashGroupsCache.totalPages = null;
  similarDhashGroupsCache.pages = Object.create(null);
  similarDhashGroupsCache.warmedAt = 0;
  if (isDev && reason) {
    logger.log('[similar-dhash-cache] cleared reason=%s', String(reason));
  }
}

function clearDuplicateHashGroupsCache(reason) {
  duplicateHashGroupsCache.total = null;
  duplicateHashGroupsCache.totalPages = null;
  duplicateHashGroupsCache.pages = Object.create(null);
  duplicateHashGroupsCache.warmedAt = 0;
  if (isDev && reason) {
    logger.log('[dup-groups-cache] cleared reason=%s', String(reason));
  }
}
var duplicateHashBgLogLastAt = 0;
var DUP_HASH_BG_LOG_MIN_INTERVAL_MS = 4000;

function duplicateHashBgLog(stage, detail, force) {
  var now = Date.now();
  if (!force && now - duplicateHashBgLogLastAt < DUP_HASH_BG_LOG_MIN_INTERVAL_MS) return;
  duplicateHashBgLogLastAt = now;
  var elapsed =
    duplicateHashTask && duplicateHashTask.startedAt ? now - duplicateHashTask.startedAt : 0;
  var done = Number(duplicateHashTask && duplicateHashTask.done) || 0;
  var total = Number(duplicateHashTask && duplicateHashTask.total) || 0;
  var hashed = Number(duplicateHashTask && duplicateHashTask.hashed) || 0;
  var failed = Number(duplicateHashTask && duplicateHashTask.failed) || 0;
  var skippedMissing = Number(duplicateHashTask && duplicateHashTask.skippedMissing) || 0;
  if (detail != null && String(detail).length > 0) {
    logger.log(
      '[dup-hash-bg +%dms] %s | %s | done=%d/%d hashed=%d failed=%d missing=%d',
      elapsed,
      stage,
      String(detail),
      done,
      total,
      hashed,
      failed,
      skippedMissing,
    );
  } else {
    logger.log(
      '[dup-hash-bg +%dms] %s | done=%d/%d hashed=%d failed=%d missing=%d',
      elapsed,
      stage,
      done,
      total,
      hashed,
      failed,
      skippedMissing,
    );
  }
}
/** 预览随机播放/幻灯片进行中：后台任务降载，避免预览卡顿 */
var previewPlaybackActive = false;

function yieldForPreviewPlaybackMs(ms) {
  var t = typeof ms === 'number' && ms > 0 ? ms : 48;
  // 总是让出，即使没有视频播放，保证后台任务不会霸占主线程卡住 UI
  return new Promise(function (resolve) {
    setTimeout(resolve, t);
  });
}

var bgTasksChangedTimer = null;
var bgTasksChangedLastSentAt = 0;
var BG_TASKS_CHANGED_MIN_INTERVAL_MS = 200;
var startupInvalidCleanupTask = {
  running: false,
  timer: null,
  beforeId: 0,
};

/**
 * 目录类缓存（root_folders / folder_tree）与**读池里的 `getPhotos` total 记忆化**
 * （`src/photos-total-cache.js`）一起失效。
 *
 * 两者绑在同一个入口上不是巧合：会让目录结构变脏的动作（扫描收尾 / 删除 / 移除根目录）
 * 同时也是**改 photos 行数**的动作。行数一变，那份 total 就不再是「同一条 SQL 同一个数」了。
 * 挂在既有失效点上 ⇒ 这 4 个调用点自动都覆盖到，不用各加一行、也就不会漏一处。
 * （缓存另有 5 s TTL 兜底，所以这里漏掉也只会陈旧 ≤5 s。）
 */
function invalidateCatalogCachesSafe() {
  try {
    dbReadWorkerPool.invalidateReadCaches();
  } catch (ePool) {
    void ePool;
  }
  try {
    if (catalogCache && typeof catalogCache.invalidateAllCatalogCaches === 'function') {
      catalogCache.invalidateAllCatalogCaches();
    }
  } catch (e) {
    void e;
  }
}

function invalidateCatalogCacheForRootSafe(rootId) {
  try {
    dbReadWorkerPool.invalidateReadCaches();
  } catch (ePool) {
    void ePool;
  }
  try {
    if (catalogCache && typeof catalogCache.invalidateByRootId === 'function') {
      catalogCache.invalidateByRootId(rootId);
      return;
    }
  } catch (e) {
    void e;
  }
  invalidateCatalogCachesSafe();
}

function resolveRootIdByPath(rootPath) {
  try {
    if (!db || typeof db.getRootFolders !== 'function' || !rootPath) return null;
    var target = String(rootPath || '')
      .replace(/\//g, '\\')
      .toLowerCase();
    var rows = db.getRootFolders({ lite: true }) || [];
    for (var i = 0; i < rows.length; i++) {
      var p = String((rows[i] && rows[i].path) || '')
        .replace(/\//g, '\\')
        .toLowerCase();
      if (p === target) return parseInt(rows[i].id, 10) || null;
    }
  } catch (e2) {
    void e2;
  }
  return null;
}
var invalidCleanupTask = {
  running: false,
  /**
   * 🔴 **必须每次开跑前复位**：这个标志是批间循环的退出条件（见 `runInvalidCleanupBatch` 的
   * 调用处），一旦被置为 `true` 而下次启动前不复位，第二次点「清理失效记录」会**一批都不做
   * 就立刻结束** —— 界面上是「点了没反应」，日志里什么都没有。它原先只被读、从没被写过
   * （即永远的 `undefined`），为了给迁移让路才第一次真的会置位。
   */
  cancelled: false,
  checked: 0,
  deleted: 0,
  total: 0,
  currentFile: '',
  startedAt: 0,
};

var isDev = process.argv.includes('--dev');
var startupStageT0 = Date.now();
function startupStageLog(stage, detail) {
  startupMetrics.mark(stage);
  var elapsed = Date.now() - startupStageT0;
  if (detail != null && String(detail).length > 0) {
    logger.log('[startup-stage +%dms] %s | %s', elapsed, stage, String(detail));
  } else {
    logger.log('[startup-stage +%dms] %s', elapsed, stage);
  }
}
/**
 * 长任务进度打点：进 console **并**进 `startup-performance.json#longTasks`。
 *
 * 🔴 不能直接用 `startupStageLog`（它只写 `stages`）：`stages` 有 **120 s 采集截止**，
 *    而建索引这类**十几分钟**的独占写锁任务必然整段落在窗口外 ⇒ 打点被静默丢弃，
 *    看起来完全像「明明加了埋点还是没有现场」。见 `startup-metrics.js#markLong`。
 * ⚠️ 只给低频事件用（每条索引一两次、每个长阶段一次）。
 */
function longTaskStageLog(stage, detail) {
  var elapsed = Date.now() - startupStageT0;
  if (detail != null && String(detail).length > 0) {
    logger.log('[startup-stage +%dms] %s | %s', elapsed, stage, String(detail));
  } else {
    logger.log('[startup-stage +%dms] %s', elapsed, stage);
  }
  startupMetrics.markLong(stage, detail);
}
/**
 * 渲染层允许上报的启动阶段名（白名单）。
 * 渲染层送过来的字符串**绝不直接拼进日志** —— 这里是唯一的过滤点，
 * 见下方 `notify-startup-stage` 的 handler。
 *
 * 用途：把 `window.did-finish-load` → `renderer.first-grid-paint` 之间那段黑盒切开。
 * 本机 122 万张库实测那段有 **52 秒**没有任何标记（7.3s → 59.0s），
 * 导致「首屏在等谁」无法从数据回答。见 CONTRACTS §启动首帧。
 */
var RENDERER_STARTUP_STAGES = ['init.enter', 'settings.done', 'rootFolders.done', 'landing.done'];
var RAW_EXTENSIONS = new Set(['.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raw']);
var VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.mpg',
  '.mpeg',
  '.m2ts',
  '.ts',
  '.3gp',
  '.3g2',
]);

function isVideoPath(p) {
  try {
    var ext = path.extname(String(p || '')).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  } catch (e) {
    return false;
  }
}

function buildVideoPlaceholderThumbnail(opts) {
  return getVideoFrameThumb().buildVideoPlaceholderThumb(opts);
}

function extractVideoThumbnailWithFfmpeg(filePath, opts) {
  return getVideoFrameThumb().extractVideoFrameThumb(
    filePath,
    Object.assign({}, opts, { ffmpegPath: getFfmpegStaticPath() }),
  );
}

/**
 * 明确将 Electron/Chromium 数据落盘到当前用户可写目录，避免安装目录权限导致
 * "Unable to move/create cache (0x5)"。
 */
function configureWritableAppPaths() {
  try {
    var productFolder = app.getName() || '拂晓图库';
    var localAppDataRoot = process.env.LOCALAPPDATA || app.getPath('appData');
    var appRoot = path.join(localAppDataRoot, productFolder);
    var userDataRoot = path.join(appRoot, 'UserData');
    var sessionDataRoot = path.join(appRoot, 'SessionData');
    fs.mkdirSync(userDataRoot, { recursive: true });
    fs.mkdirSync(sessionDataRoot, { recursive: true });
    app.setPath('userData', userDataRoot);
    app.setPath('sessionData', sessionDataRoot);
  } catch (e) {
    // 回退到 Electron 默认路径，避免因路径设置失败阻断启动。
    logger.error('[path-init] failed, fallback to default:', e && e.message ? e.message : e);
  }
}

configureWritableAppPaths();

// === Settings ===
var settingsFilePath;

/**
 * 强调色 / 背景基调允许集。⚠️ 必须与渲染层 `ui-shell.js` 的 UI_ACCENT_ALLOWED / UI_BG_ALLOWED
 * 以及 `index.html` 首帧脚本里的 ACC / BG 表逐项一致（`theme-regression` 断言）。
 * `glass` / `aurora` 是「材质档」：面板 --glass / --bg-card 走半透明 rgba，把 body 里那层
 * `.aurora-bg` 极光透出来 —— 所以它们的视觉差异主要由**面板透明度**承载，--bg 只是基色。
 * 后四色 / 后四档（coral / indigo / green / red、paper / mist / forest / clay）是「自定义两维」
 * 的补充选项，**不被任何预设使用** → 选中时 themeStyle 解析为空串「自定义组合」，是预期行为。
 */
var UI_ACCENT_ALLOWED = [
  'violet',
  'cyan',
  'teal',
  'rose',
  'amber',
  'mono',
  'coral',
  'indigo',
  'green',
  'red',
];
var UI_BG_ALLOWED = [
  'default',
  'ink',
  'warm',
  'cool',
  'amoled',
  'glass',
  'aurora',
  'paper',
  'mist',
  'forest',
  'clay',
];

/**
 * 材质纹理允许集。⚠️ 必须与渲染层 `ui-shell.js` 的 UI_TEXTURE_ALLOWED、`index.html` 首帧脚本里的
 * TEX 表、网页端 `web-theme-shared.js` 的 WEB_TEXTURE_ALLOWED / TEXTURE_TOKENS 逐项一致
 * （`theme-regression` 断言）。
 *
 * 这是**第三个正交维度**（前两个是强调色 / 背景基调）：纹理画在 `body::after` 装饰层上，
 * 与底色、强调色、深浅任意叠加 → 「深林 + 亚麻布」「纯黑 + 颗粒」都能选。
 * `none` 档**不设属性**（与 `data-bg` 的 `default` 档同惯例）→ 渲染层走 `removeAttribute('data-texture')`，
 * CSS 侧只能写 `:not([data-texture])`。所以这里的 `none` 是**语义占位**，与另外三个下拉的
 * 「默认 / 自定义组合」占位项同理。
 *
 * ⚠️ 纹理**不被任何预设使用**（预设仍然只固定 theme/uiAccent/uiBackground 三个字段）→
 * 选中纹理时 `themeStyle` 照旧由三元组反推，**不受纹理影响**，这是预期行为。
 */
var UI_TEXTURE_ALLOWED = [
  'none',
  'grain',
  'paper',
  'linen',
  'frost',
  'grid',
  'dots',
  'stripe',
  'wood',
];

/**
 * 面板透明度允许集。⚠️ 必须与渲染层 `ui-shell.js` 的 UI_OPACITY_ALLOWED、`index.html`
 * 首帧脚本里的 OPA 表、网页端 `web-theme-shared.js` 的 WEB_OPACITY_ALLOWED / OPACITY_TOKENS
 * 逐项一致（`theme-regression` 断言）。
 *
 * 这是**第五个正交维度**：把「界面框架」那几张面（标题栏 / 顶栏 / 工具栏 / 侧栏 / 图标栏 /
 * 内容区 / 分页条 / 设置页）的底色按一个 alpha 乘子掺进 transparent，**图片与图片卡片一律不动**。
 * 与 `uiTexture` 同惯例：`opaque` 档**不设属性**（= 不设 `data-opacity`）→ 默认外观逐字节不变，
 * CSS 侧一律带 `html[data-opacity]` 闸门。
 *
 * 🔴 它与 `uiTexture` 一样**不被任何预设使用**（预设仍只固定 theme/uiAccent/uiBackground）
 * → 选中时 `themeStyle` 照旧由三元组反推，**不受透明度影响**，这是预期行为。
 * 🔴 见 `styles.css` 里 `--ui-alpha` 那组注释：只降面板 alpha 是看不出效果的，
 * 必须**同步提亮 `.aurora-blob`**（与 `glass` / `aurora` 两个材质档同一手）。
 */
var UI_OPACITY_ALLOWED = ['opaque', 'slight', 'medium', 'clear'];

/**
 * 窗口背景允许集 —— 外观家族的**第五个正交维度**，但它**不是配色维度，而是窗口级开关**。
 *
 * 语义：`solid`（默认）= 选中这一维之前的样子：窗口**不透明**，其余五维照常工作，
 * 视觉与性能零影响；`acrylic` = 整个窗口做成透明的「亚克力毛玻璃」，桌面透过面板显示。
 *
 * ⚠️ 它的机制与前五维**本质不同**，别照抄那五维的改法：
 *   1. 前五维全是「html 属性 → CSS 变量块」，改完当帧就变；这一维**一半在主进程** ——
 *      `transparent` / `backgroundColor` / `backgroundMaterial` 都是 `BrowserWindow` 的
 *      **创建参数，运行时改不了**（`setBackgroundMaterial` 是唯一的运行时接口，而且只能换
 *      已有材质的种类，不能把不透明窗口变透明）→ **改这一档必须重启**（或关闭主窗口后
 *      再从托盘/`activate` 唤出，那条路径会 `createWindow` 重建）。
 *   2. 渲染层那份 `data-window-backdrop` 只负责「让 body 与面板带上 alpha」，
 *      必须与窗口参数**同时成立**，缺一半就是「全黑」或「透不出去」的怪相。
 *   3. 它**不进顶栏 `#quickThemeStyle`**：那一栏的核心交互是「鼠标划过即预览」，
 *      而这一维在重启前**不可能**预览 → 放进去就是「划过毫无反应」的假承诺。
 *      所以它只有设置页一处入口，与 `windowCloseBehavior` 同级。
 *   4. 网页端不涉及（没有窗口）→ `src/web/**` 里**不该出现**这个字段。
 *
 * ⚠️ 生效范围：`backgroundMaterial: 'acrylic'` 只在 **Windows 11 22H2（10.0.22621）及以上**
 *    有效（见 `electron.d.ts` 里 `setBackgroundMaterial` 的原文）。更低的 Windows / macOS
 *    上窗口照样透明，但**没有系统模糊**（等于「直接看穿」）；系统「设置 → 个性化 → 颜色 →
 *    透明效果」关掉时，Windows 也会静默降级成实色。三种情况**都不报错**，属预期降级，
 *    只有主进程日志里会留一条 warn —— 见 `supportsAcrylicBackdrop()`。
 */
var UI_WINDOW_BACKDROP_ALLOWED = ['solid', 'acrylic-light', 'acrylic', 'acrylic-strong'];

/**
 * 这台机器能不能真的拿到「亚克力」模糊。判据只能是**内核版本号**：
 * Windows 11 在 `os.release()` 里依然自报 `10.0.22631` 这种形态（major 仍是 10），
 * 所以必须按 build ≥ 22621 判，不能按 major ≥ 11 判。
 *
 * ⚠️ 只用于**日志告警**，不用来否决设置：TransparentWindow 的「透明」部分是全平台可用的，
 * 缺了模糊只是观感差一档，没必要替用户把选项关掉（他也可能在 Linux/macOS 上就要看穿效果）。
 */
function supportsAcrylicBackdrop() {
  if (process.platform !== 'win32') return false;
  var m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(os.release() || ''));
  if (!m) return false;
  var major = parseInt(m[1], 10);
  var build = parseInt(m[3], 10);
  return major > 10 || (major === 10 && build >= 22621);
}

/** 外观风格 id → 渲染层 data-theme / data-accent / data-bg（与 renderer UI_THEME_PRESETS 一致） */
var THEME_STYLE_PRESETS = {
  // 深色 11 套（末尾两套是材质档：面板半透明，透出 .aurora-bg 极光层）
  midnight_classic: { theme: 'dark', uiAccent: 'violet', uiBackground: 'default' },
  ice_deep: { theme: 'dark', uiAccent: 'cyan', uiBackground: 'amoled' },
  amber_dawn: { theme: 'dark', uiAccent: 'amber', uiBackground: 'warm' },
  // 森影暮霭原为 dark+amber+cool，与晨光琥珀（dark+amber+warm）只差背景深浅，差异太小 → 改用 teal
  forest_shadow: { theme: 'dark', uiAccent: 'teal', uiBackground: 'cool' },
  ember_night: { theme: 'dark', uiAccent: 'rose', uiBackground: 'ink' },
  graphite_night: { theme: 'dark', uiAccent: 'mono', uiBackground: 'default' },
  nebula_violet: { theme: 'dark', uiAccent: 'violet', uiBackground: 'ink' },
  pine_abyss: { theme: 'dark', uiAccent: 'teal', uiBackground: 'default' },
  mocha_night: { theme: 'dark', uiAccent: 'amber', uiBackground: 'ink' },
  glass_night: { theme: 'dark', uiAccent: 'violet', uiBackground: 'glass' },
  aurora_night: { theme: 'dark', uiAccent: 'teal', uiBackground: 'aurora' },
  // 浅色 11 套（末尾两套是材质档）
  sky_light: { theme: 'light', uiAccent: 'cyan', uiBackground: 'ink' },
  cherry_blossom: { theme: 'light', uiAccent: 'rose', uiBackground: 'warm' },
  lavender_dusk: { theme: 'light', uiAccent: 'violet', uiBackground: 'warm' },
  arctic_mint: { theme: 'light', uiAccent: 'teal', uiBackground: 'cool' },
  desert_sand: { theme: 'light', uiAccent: 'amber', uiBackground: 'default' },
  paper_gray: { theme: 'light', uiAccent: 'mono', uiBackground: 'amoled' },
  sage_morning: { theme: 'light', uiAccent: 'teal', uiBackground: 'default' },
  apricot_haze: { theme: 'light', uiAccent: 'amber', uiBackground: 'ink' },
  frost_cyan: { theme: 'light', uiAccent: 'cyan', uiBackground: 'cool' },
  glass_day: { theme: 'light', uiAccent: 'cyan', uiBackground: 'glass' },
  aurora_dawn: { theme: 'light', uiAccent: 'violet', uiBackground: 'aurora' },
};

function inferThemeStyleFromTriple(theme, accent, bg) {
  var t = theme === 'light' ? 'light' : 'dark';
  var ids = Object.keys(THEME_STYLE_PRESETS);
  for (var ii = 0; ii < ids.length; ii++) {
    var id = ids[ii];
    var p = THEME_STYLE_PRESETS[id];
    var pt = p.theme === 'light' ? 'light' : 'dark';
    if (pt === t && p.uiAccent === accent && p.uiBackground === bg) return id;
  }
  return null;
}

/**
 * 归一外观设置：**三元组 (theme, uiAccent, uiBackground) 是唯一权威**，`themeStyle` 只是由它
 * 派生的标签；凑不出任何预设时置空串（渲染层显示「自定义组合」）。
 *
 * ⚠️ 不要再让 themeStyle 反过来覆盖 triple —— 强调色与背景基调现在是独立可选的，反向覆盖会把
 * 用户刚改的那一维静默吞掉（历史行为：改完强调色保存又被预设拍回去）。
 * 要「套用预设」必须由调用方把预设展开成三个字段再提交（渲染层 `UI_THEME_PRESETS` 已带三元组）。
 * 老配置无需迁移：旧版本每次归一都会把 triple 写成预设值，所以磁盘上的 triple 与 themeStyle 天然一致。
 */
function reconcileThemeStyleSettings() {
  settings.theme = settings.theme === 'light' ? 'light' : 'dark';
  if (UI_ACCENT_ALLOWED.indexOf(settings.uiAccent) < 0) settings.uiAccent = 'violet';
  if (UI_BG_ALLOWED.indexOf(settings.uiBackground) < 0) settings.uiBackground = 'default';
  if (UI_TEXTURE_ALLOWED.indexOf(settings.uiTexture) < 0) settings.uiTexture = 'none';
  if (UI_OPACITY_ALLOWED.indexOf(settings.uiOpacity) < 0) settings.uiOpacity = 'opaque';
  // 窗口背景是**窗口级开关**，不进三元组、也不影响 themeStyle 反推（预设一概不碰它）。
  if (UI_WINDOW_BACKDROP_ALLOWED.indexOf(settings.uiWindowBackdrop) < 0) {
    settings.uiWindowBackdrop = 'solid';
  }
  var inferred = inferThemeStyleFromTriple(
    settings.theme,
    settings.uiAccent,
    settings.uiBackground,
  );
  settings.themeStyle = inferred || '';
}

/** 新安装或配置文件损坏时的完整默认形状（与磁盘合并时以磁盘键覆盖同名字段） */
function createDefaultSettings() {
  return {
    autoScanOnStartup: false,
    /** 启动后空闲时自动补全缺失缩略图与 dHash（与扫描队列互斥） */
    autoThumbBackfillOnStartup: false,
    /**
     * 缩略图补全**同时处理张数**（1–8）。
     *
     * 🔴 默认 3 → 4（2026-10-06），依据是**两轮实测**（`.workbuddy/tmp/thumb-concurrency-probe.log`
     *    与 `thumb-concurrency-cold.log`；16 核机器、24 / 80 张真实图片、只读不写库）：
     *
     *     | 并发 | 热读（页缓存命中） | 冷读（外接盘、文件未缓存） |
     *     | ---: | ---: | ---: |
     *     | 1 | 18.4 张/秒 | 11.3 |
     *     | 3（旧默认） | 30.3 | 13.6 |
     *     | **4** | 42.1 | **19.8 ← 两轮里唯一的共同最优** |
     *     | 6 | 48.3 | （未测） |
     *     | **8** | **58.6 ← 热读最优** | **15.8 ← 冷读回落** |
     *     | 12 / 16 | 55.2 / 54.2（**无增益**） | — |
     *
     *    ⇒ 两轮拐点**不一样**：热读拐在 8，冷读拐在 4，而且 8 上冷读**反而变慢** ——
     *      外接 / 机械盘上并发随机读过高会互相抢寻道（并行度从 1.86 掉到 1.55）。
     *      用户的图库正是在 `K:\COS` / `G:\T` 这类盘上，首次补全大量是冷读
     *      ⇒ 取 **4**：两轮都接近最优，不押单边。
     *    ⇒ **上限 8 已经够**，不必再提高：12 / 16 实测无增益（并行度封顶 ~3.9，
     *      瓶颈是单张图内部的串行段，不是核数），提高上限只会白占内存。
     *    ⚠️ 改这里**不影响已有配置**（磁盘上的值优先于默认形状）—— 老用户要享受这次调整
     *      得自己去设置页改，这是刻意的：用户显式选过的值不该被一次升级悄悄覆盖。
     */
    thumbBackfillConcurrency: THUMB_BACKFILL_CONCURRENCY_DEFAULT,
    autoHashOnStartup: false,
    /** 启动后自动跑一遍搜图（语义）索引；缺多少补多少，**跑到底**，只能手动取消 */
    autoSemanticIndexOnStartup: false,
    /** 启动后自动跑一遍人脸索引；缺多少补多少，**跑到底**，只能手动取消 */
    autoFaceIndexOnStartup: false,
    /** 默认关闭局域网访问；本机 127.0.0.1 预览/HLS 仍可在内嵌服务启动后使用 */
    webLanEnabled: false,
    cloudflareTunnelAutoStart: false,
    themeStyle: 'midnight_classic',
    theme: 'dark',
    uiAccent: 'violet',
    uiBackground: 'default',
    /** 材质纹理（第三维，与强调色/背景基调正交）；'none' = 不铺纹理，渲染层不设 data-texture */
    uiTexture: 'none',
    /**
     * 面板透明度（第五维，与纹理同为正交维度）；'opaque' = 不设 data-opacity，
     * 界面框架保持各档原样。其余三档按 alpha 乘子把面板底色掺进 transparent。
     */
    uiOpacity: 'opaque',
    /**
     * 窗口背景（窗口级开关，与上面五维**正交**，预设一概不碰）。
     * 'solid' = 创建普通的不透明窗口（默认，零影响）；
     * 'acrylic' = 创建透明窗口 + 亚克力毛玻璃。
     * ⚠️ 它是 `BrowserWindow` 的**创建参数** → 改档必须重启才生效；只在 Windows 11 22H2+
     * 拿到系统模糊，其余平台/系统设置下会静默降级为「只看穿、不模糊」或实色。
     */
    uiWindowBackdrop: 'solid',
    subtitleFontFamily: 'system',
    subtitleFontSizePx: 22,
    subtitleFontWeight: 'medium',
    subtitleBgOpacity: 'none',
    subtitleColor: 'white',
    // 缩略图档位/画质：默认 512 / 75（2026-10-07 从 256 升档）。
    // ⚠️ 改这里只影响**之后新生成**的缩略图；存量要靠「重建全部缩略图」那个任务回填，
    //    所以两者之间会长期混档（`thumb_size` / `thumb_format` 逐行不同）——
    //    服务端按行派生 Content-Type 正是为了这一天。
    thumbSize: THUMB_DEFAULT_SIZE,
    thumbQuality: THUMB_DEFAULT_QUALITY,
    /** 关闭主窗口：ask 弹出选择 | tray 直接托盘 | quit 直接退出 */
    windowCloseBehavior: 'ask',
    /** 预览底部主行显示项（管理设置中可关） */
    previewShowFileName: true,
    previewShowDateTaken: true,
    previewShowFileSize: true,
    previewShowDimensions: true,
    previewShowPosition: true,
    /**
     * 预览页「图片信息」面板显示哪些字段。
     * 字段 id 的**唯一真相源** = `src/web/js/photo-info-fields.js`，这里只存「启用集」。
     * 默认值取注册表的默认集，不在这里抄一份 id 列表（抄一份就会漂）。
     */
    infoPanelFields: PHOTO_INFO_FIELDS.DEFAULT_FIELD_IDS.slice(),
    /** 主界面浏览默认：排序 / 每页条数 / 卡片宽度 */
    browseSortBy: 'date_taken',
    browseSortOrder: 'DESC',
    browsePageSize: 100,
    browseCardSize: 180,
    /** 启动默认页：welcome | all_photos | all_folders | last_position */
    launchDefaultPage: 'all_photos',
    browseCardRatio: '1 / 1',
    browseThumbCrop: false,
    browseCardLayout: 'masonry',
    /** 目录浏览：true=当前目录及所有子文件夹中的媒体；false=仅当前文件夹内直接存放的文件 */
    browseFolderIncludeSubfolders: true,
    /** 扫描：符号链接、深度、跳过目录名（每行一个）、是否索引 RAW */
    scanFollowSymlinks: false,
    scanMaxDepth: 0,
    scanSkipDirNames: '',
    scanIncludeRaw: true,
    /** 扫描 IO 档位：auto | hdd | ssd；auto 为保守自适应 */
    scanDiskProfile: 'auto',
    /** 额外 IO 节流（毫秒，0 关闭） */
    scanIoThrottleMs: 0,
    /** HLS 缓存上限（0 表示不限字节，目录数至少为 1） */
    hlsMaxCacheBytes: 1024 * 1024 * 1024,
    hlsMaxCacheEntries: 48,
    /** 界面语言：zh-CN | en */
    uiLocale: 'zh-CN',
    /**
     * 搜图匹配阈值（基线差口径，见 src/ai/embedding.js）。不再是「取相似度最高的 60 条」：
     * 达标即可，条数由它决定。0 表示不过滤，越大越严（可能一张都不返回）。
     */
    aiSearchMatchThreshold: MATCH_THRESHOLD_RANGE.default,
    /**
     * tag 检索层总开关（M4）。
     *
     * 默认**开**：tag 路的收益正是「预选词/词表词点下去更准」，而它在没有索引的机器上
     * 会自己降级成纯 CLIP（`tag.reason = 'NO_INDEX'`）—— 「默认开」不会让任何人变差。
     * 关掉它只有一个理由：用户觉得融合后的排序不如纯 CLIP。
     */
    aiSearchTagEnabled: true,
    /**
     * tag 路自己的查询线（标签概率口径，0.55 起算命中）。
     *
     * 与 `aiSearchMatchThreshold` **刻意分开**：两者量纲不同（基线差 vs 概率），
     * 共用一个滑杆必然出现「为了压住一边的误报把另一边砍没了」。
     * 范围与默认值同源 `TAG_ROUTE_RANGE`，不许在这里写字面量。
     */
    aiSearchTagThreshold: TAG_ROUTE_RANGE.default,
    /**
     * **标签展示线**（读侧分数线，只影响「标签怎么显示」，不影响任何检索）。
     *
     * 管两处：标签导航页的「某标签有哪些图 / 卡片上的 N 张」与照片信息面板的「画面标签」。
     * 低于这条线的 `photo_tag` 行**不当结论显示** —— 实测 15..29 那段占倒排行的 61%，
     * 抽 top1 肉眼核对时 `blue_sky` 0.22（图里没有天空）、`cat` 0.21（图里没有猫）全落在那里。
     *
     * 与 `aiSearchTagThreshold`（查询线）**刻意分开**：查询线管「搜得到什么」，
     * 展示线管「看到的算不算数」，两者既不同量级也不同用途（理由与实测见
     * `src/ai/tag-index-store.js#DISPLAY_MIN_SCORE`）。范围同源 `TAG_DISPLAY_RANGE`，
     * 不许在这里写字面量；越界由 `ensureSettingsShape()` 用 `clampDisplayMinScore()` 收口。
     *
     * ## 为什么做成设置项
     *
     * 默认 0.35 是**一次实测**的取舍（保留 30.9% 行 / 41.3% 标签 / 每张图仍有 ≥1 个标签），
     * 但不同库的噪声水平不一样：拍得糊的库 0.35 仍会漏噪声，拍得干净的库 0.35 又砍得太狠。
     * 硬编码等于把这个取舍替所有用户做了，而这是一个**纯口味**参数。
     *
     * ## 改完怎么生效（用户原话「调了怎么生效」）
     *
     * ① `update-settings` 把值写进内存的 `settings` 并 `saveSettings()` 落盘；
     * ② 两个读侧服务（`TagNav` / `JoyTagTags`）**不缓存这个值** —— 构造函数拿到的是一个
     *    getter（`function () { return settings.aiTagDisplayThreshold; }`），每次查询现取
     *    ⇒ **下一次取数就生效，不需要重启**（也不需要重建索引：分数线只影响读哪几行）；
     * ③ 界面上**已经画出来**的数字不会自己重画（标签页的子类计数有渲染层缓存），
     *    所以渲染端在写成功后会调 `tagNavUi.invalidateCounts()` 让缓存失效，见
     *    `src/renderer/app.js#tagLayer.write`。
     *
     * 🔴 老配置没有这个键 ⇒ 走默认 0.35（`Object.assign(createDefaultSettings(), parsed)`，
     *    缺键由默认形状补），不会退化成「什么都显示」。
     */
    aiTagDisplayThreshold: TAG_DISPLAY_RANGE.default,
    /**
     * 快捷键覆盖表 `{ 动作id: 绑定串 }`。
     *
     * **空对象 = 全部用默认键**（不是「全部禁用」）：动作与默认键的**唯一真相源**
     * 是 `src/renderer/shortcuts.js` 的注册表，这里只存「用户改过的那几个」。
     * 因此新增动作、调整默认键都不需要迁移这份数据。
     * 值为空串表示「用户显式解绑了该动作」。
     */
    shortcuts: {},
  };
}

var settings = createDefaultSettings();

/**
 * 搜图检索要带上的参数。阈值由设置在渲染进程侧改、主进程侧读，因此这里总是取当前值。
 * 传 undefined 时 IndexStore 会用它自己的默认值（两者同源，见 src/ai/index-store.js）。
 *
 * 两个 tag 键：
 *   · `tagEnabled` —— 用户开关（默认开）。worker 侧只**认 `false` 为关**（`=== false`），
 *     所以缺键等于开，老客户端/老设置不会因为少一个键把 tag 路静默关掉；
 *   · `tagThreshold` —— tag 路自己的查询线。越界由 worker 夹到 `TAG_ROUTE_RANGE` 内。
 *
 * ⚠️ 预选词（`ai-search-suggest`）的**常规路径已经不经过这里**（2026-10-09 起改走主进程只读 SQL，
 *    见 `suggestTermsFromTags()`）；只有它的**老契约形状**（`candidates`：给一组指定的词打分）
 *    仍会落进 worker 的 `suggest` 分支，而那个分支只做向量打分、不读这两个 tag 键。
 *    多带的两个键在那边是**未被消费**的，不会造成分叉 —— 但别反过来以为 suggest 有了 tag 能力。
 *    要给它加，得先在 worker 的 `suggest` 分支里真做出来。
 */
function searchMatchOptions() {
  return {
    threshold: Number(settings.aiSearchMatchThreshold),
    tagEnabled: settings.aiSearchTagEnabled !== false,
    tagThreshold: Number(settings.aiSearchTagThreshold),
  };
}

/**
 * 预选词的**常规路径**：主进程直接把 `embeddings.tags` 转置成「词 → 命中张数」。
 *
 * 不起 worker、不载任何模型 —— 答案（每张图 top-3 标签的词表下标）在建索引 / 补标签时就写进库了。
 * 实测 **48 ms**（老路 4 s、冷启 17 s，分解与理由见 `SemanticTags.suggestTerms` 的注释）。
 *
 * 🔴 **`hits` 不是张数**（准确含义见同一个注释）：它只用来「挡掉 0 命中」与排序。
 * 桌面端与网页端都走这一个函数，形状 `{sampled, terms:[{text,hits}]}` 与 worker 那条路**逐字段一致**，
 * 所以渲染层不需要知道这次是谁答的（也不需要改）。
 *
 * ⚠️ 不是异步的，但**调用方仍要用 `withPreempt()` 包住**：预选词与搜图一样是用户交互
 * （进搜图页就会自动要一次），后台长任务该在批次边界让位。
 */
function suggestTermsFromTags(request) {
  if (!semanticTags) return { sampled: 0, terms: [] };
  var scope = request && typeof request === 'object' ? request : {};
  return semanticTags.suggestTerms(scope.lang ? String(scope.lang) : '', scope.limit);
}

/** 供 IPC 返回，避免渲染进程持有主进程对象引用、并保证可结构化克隆 */
/**
 * 当前这个窗口**建窗时真正用的**那一档窗口背景（'solid' / 'acrylic'）。
 *
 * ⚠️ 必须与「设置里的值」（`settings.uiWindowBackdrop`）分开：窗口材质是**创建参数**，
 * 改设置**当帧不会**改变窗口本身。渲染层若拿设置值去设 `data-window-backdrop`，就会
 * 「窗口还是实色、body 却已经透明」→ 底色透到窗口自己的白色底板上 → 整个界面被洗白。
 * 所以只传这个「已生效值」给渲染层，由它决定要不要给 body 加 alpha。
 * 取值点只有 createWindow 一处；初值 'solid' = 还没有窗口时的状态。
 */
var windowBackdropAppliedAtLaunch = 'solid';

function cloneSettingsForIpc() {
  ensureSettingsShape();
  var payload = JSON.parse(JSON.stringify(settings));
  payload.hasWebPassword = !!(settings.webPassword && String(settings.webPassword).trim());
  /** 「已生效值」（见上方注释）。刻意**不写进 settings**（不进配置文件）——它是运行期事实，不是设置 */
  payload.uiWindowBackdropApplied = windowBackdropAppliedAtLaunch;
  return payload;
}

/**
 * 快捷键覆盖表的形态兜底。
 *
 * ⚠️ 这里**只校验形态、不校验动作 id**：动作表（`src/renderer/shortcuts.js`）
 * 活在渲染进程，主进程不认识它，硬抄一份白名单必然漂移。
 * 「未知动作 id 一律丢弃」由渲染进程的 `RendererShortcuts.setOverrides()` 负责，
 * 下次用户改键落库时自然会被清掉；这份兜底只保证存进来的是
 * 「字符串 → 字符串」且长度可控，避免被写进一个巨大的脏对象。
 */
function normalizeShortcutsSetting() {
  var raw = settings.shortcuts;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    settings.shortcuts = {};
    return;
  }
  var out = {};
  var keys = Object.keys(raw);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (typeof k !== 'string' || !k || k.length > 64) continue;
    var v = raw[k];
    if (v == null) continue;
    if (typeof v !== 'string') continue;
    if (v.length > 64) continue;
    out[k] = v;
  }
  settings.shortcuts = out;
}

/**
 * 网页端「设置」页要展示的**只读**设置快照。
 *
 * 🔴 这里是白名单，不是黑名单：只有被明确列出的键才会出去。
 * 网页端设置页是桌面端的只读镜像（与 `/api/info-fields` 同一条契约：
 * 桌面端是唯一写入口），所以任何一个键泄漏到局域网都没有意义，
 * 而「漏掉一个键」的代价只是设置页少显示一项 —— 反过来做成
 * 「把 settings 整个发出去、再删掉敏感字段」就会在某天新增敏感字段时静默泄漏。
 *
 * ⚠️ 绝不包含：`webPassword`（只出 `hasWebPassword` 布尔）、任何隧道凭据、
 * 任何本机绝对路径（目录清单网页端另有 `/api/root-folders`）。
 */
/**
 * 标签导航页：某个标签下的照片**行**（本地与网页端共用这一个实现）。
 *
 * ## 为什么在这里组合，而不是让 `TagNav` 自己取行
 *
 * 数据在两个库：`photo_id` 来自 **tag 索引库**（`ai-search/tag-index.sqlite`），
 * 照片行在**主库**（`photos` 表）。`TagNav` 刻意只碰 tag 库（见 `main/tag-nav.js` 的说明），
 * 所以这一步在主进程把两半拼起来 —— 而它同时也是**唯一**能同时拿到 `db` 的地方。
 *
 * ## 两个口径都复用既有实现，不另写一份
 *
 *   - 媒体档过滤走 `db._pushMediaTypeCondition()`（工程里「媒体档」的唯一判据；
 *     `all` 档排伴生视频靠它内部的索引自适应闸门，自己写 `NOT IN` 会退回全表回表）；
 *   - 取行用 `photoListColumns()` + `idListPredicate()`（与 `maintenance-get-photos-by-ids`
 *     同一套，`json_each` 而不是展开 `IN (?,?,…)`）。
 *
 * ## 排序由**索引侧**决定，这里只负责还原
 *
 * 顺序（标签置信度降序）在 `rankedPhotoIds` 里定，这里把 `IN (...)` 查出来的行
 * **按传入 id 顺序重排**回那个顺序 —— SQL 的 `IN` 不保证顺序，不还原就等于换成按主键排。
 *
 * ⚠️ 已知取舍：媒体档过滤在取行那一步做，所以 `photos.length` 可能小于 `rankedIds.length`
 *    （例如「只看视频」档下标签命中的全是图片）。`total` 取的是**索引侧**的总数，
 *    因此在「视频」档下会偏大。当前索引只覆盖静帧（JoyTag 只跑图片），实际只会出现在
 *    「视频」这一档；要精确就得把过滤下推到索引侧，而那会让两库的谓词耦合 —— 不值得。
 */
function fetchTagNavPhotoRows(tag, options) {
  var opt = options || {};
  var page = Math.max(1, parseInt(opt.page, 10) || 1);
  var pageSize = Math.min(Math.max(1, parseInt(opt.pageSize, 10) || 120), 200);
  var empty = { photos: [], total: 0, page: page, pageSize: pageSize, totalPages: 1 };
  if (!tagNav || !db || !tag) return empty;

  var ranked = tagNav.rankedPhotoIds(tag, page, pageSize);
  var totalPages = Math.max(1, Math.ceil(ranked.total / pageSize));
  if (!ranked.ids.length) {
    return { photos: [], total: ranked.total, page: page, pageSize: pageSize, totalPages: totalPages };
  }

  var conds = [];
  var condParams = [];
  db._pushMediaTypeCondition(conds, opt.mediaType);
  // 组织元数据筛选（2026-10-09）：渲染端的 `options` 是全局建一次、分发给所有视图的
  // （`app.js#fetchPhotosPage`），所以这一页同样会收到 `rating` / `flag` / `tagIds`。
  // 不认的症状是「筛选栏写着仅 5 星、标签页却给全部」—— 与 mediaType 当初漏掉时同一类。
  // ⚠️ 已知取舍（沿用 mediaType 那条）：过滤是在**取行那一步**做的，而 `total` 来自
  //    索引侧 ⇒ 筛选生效时 `photos.length` 会小于 `total`，分页数会偏大。要精确就得把
  //    谓词下推到索引侧，而那会让两个库的判据耦合 —— 不值得（见本函数上面的注释）。
  db._pushOrgMetaConditions(conds, condParams, opt);
  var where = conds.length ? ' AND ' + conds.join(' AND ') : '';
  var sql =
    'SELECT ' +
    photoListColumns({ lite: !!opt.lite }) +
    ' FROM photos WHERE ' +
    idListPredicate('id') +
    where;

  var rows;
  try {
    rows = db.prepare(sql).all(toIdListJson(ranked.ids), ...condParams);
  } catch (e) {
    logger.warn('get-tag-nav-photos query failed:', e && e.message ? e.message : e);
    return { photos: [], total: 0, page: page, pageSize: pageSize, totalPages: 1 };
  }

  var byId = new Map();
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    // `photo_id` 与 `id` 都给：列表渲染历史上两个名字都用过，少给一个就会在那条路径上变 undefined。
    row.photo_id = row.id;
    byId.set(row.id, row);
  }
  var photos = [];
  for (var j = 0; j < ranked.ids.length; j++) {
    var hit = byId.get(ranked.ids[j]);
    if (hit) photos.push(hit);
  }
  return { photos: photos, total: ranked.total, page: page, pageSize: pageSize, totalPages: totalPages };
}

function buildWebSettingsSnapshot() {
  try {
    reloadSettingsFromDiskSilently();
  } catch (e) {}
  var s = settings || {};
  var out = {
    // 浏览与显示
    browseSortBy: s.browseSortBy,
    browseSortOrder: s.browseSortOrder,
    browsePageSize: s.browsePageSize,
    browseCardSize: s.browseCardSize,
    browseCardLayout: s.browseCardLayout,
    browseCardRatio: s.browseCardRatio,
    browseThumbCrop: s.browseThumbCrop,
    browseFolderIncludeSubfolders: s.browseFolderIncludeSubfolders,
    videoClickBehavior: s.videoClickBehavior,
    infoPanelFields: s.infoPanelFields,
    subtitleFontFamily: s.subtitleFontFamily,
    subtitleFontSizePx: s.subtitleFontSizePx,
    subtitleFontWeight: s.subtitleFontWeight,
    subtitleColor: s.subtitleColor,
    // 媒体与存储
    thumbSize: s.thumbSize,
    thumbQuality: s.thumbQuality,
    hlsMaxCacheBytes: s.hlsMaxCacheBytes,
    hlsMaxCacheEntries: s.hlsMaxCacheEntries,
    // 后台任务
    autoScanOnStartup: s.autoScanOnStartup,
    autoThumbBackfillOnStartup: s.autoThumbBackfillOnStartup,
    autoHashOnStartup: s.autoHashOnStartup,
    autoSemanticIndexOnStartup: s.autoSemanticIndexOnStartup,
    autoFaceIndexOnStartup: s.autoFaceIndexOnStartup,
    thumbBackfillConcurrency: s.thumbBackfillConcurrency,
    similarThreshold: s.similarThreshold,
    aiSearchMatchThreshold: s.aiSearchMatchThreshold,
    // tag 检索层（M4）。⚠️ 这份快照是**白名单**（`cloneSettingsForIpc` 是整份克隆，无需在此维护），
    // 所以两个键必须在这里显式列出：漏了就是网页端设置页永远显示「标签检索关着」，
    // 而实际搜图是开着的 —— 典型的「后端做了、界面看不到」。
    aiSearchTagEnabled: s.aiSearchTagEnabled,
    aiSearchTagThreshold: s.aiSearchTagThreshold,
    // 标签**展示线**（读侧分数线）。网页端设置页现在不消费这份快照（2026-10-06 起只剩
    // 「这台设备自己的浏览偏好」），但白名单**成对维护**：将来任何客户端要显示 tag 三兄弟，
    // 少列一个就是「桌面端显示 0.35、那边显示 undefined」这种最难查的静默不一致。
    aiTagDisplayThreshold: s.aiTagDisplayThreshold,
    // 外观与行为
    themeStyle: s.themeStyle,
    theme: s.theme,
    uiAccent: s.uiAccent,
    uiBackground: s.uiBackground,
    uiTexture: s.uiTexture,
    uiOpacity: s.uiOpacity,
    uiWindowBackdrop: s.uiWindowBackdrop,
    uiLocale: s.uiLocale,
    launchDefaultPage: s.launchDefaultPage,
    windowCloseBehavior: s.windowCloseBehavior,
    // 网络与远程（只出「有没有设密码」，不出密码本身）
    webLanEnabled: s.webLanEnabled,
    cloudflareTunnelAutoStart: s.cloudflareTunnelAutoStart,
    hasWebPassword: !!(s.webPassword && String(s.webPassword).trim()),
    // 快捷键：动作名与键位都在渲染进程的注册表里，主进程只转发用户改过的覆盖表；
    // 网页端设置页只用它来判断「桌面端有没有改过」。
    shortcuts: s.shortcuts || {},
  };
  // 未设置的键（老配置里没有的）不要以 undefined 出现在 JSON 里
  for (var k in out) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] === undefined) delete out[k];
  }
  return out;
}

function ensureSettingsShape() {
  reconcileThemeStyleSettings();
  normalizeShortcutsSetting();
  // 缩略图档位：域的唯一真相源在 `./main/thumb-format#THUMB_SIZE_CHOICES`。
  // 🔴 这里不做「非法值 → 默认档」的静默回落，靠调用方给的值本来就该在域内；
  //    真要落错（老配置里手写过 512、或将来删档），回落到当前默认档而不是写死的 256。
  settings.thumbSize = normalizeThumbSize(settings.thumbSize);
  var q = parseInt(settings.thumbQuality, 10);
  if (isNaN(q)) settings.thumbQuality = THUMB_DEFAULT_QUALITY;
  else settings.thumbQuality = Math.max(50, Math.min(95, q));
  var wcb = settings.windowCloseBehavior;
  if (['ask', 'tray', 'quit'].indexOf(wcb) < 0) settings.windowCloseBehavior = 'ask';
  settings.autoScanOnStartup = !!settings.autoScanOnStartup;
  settings.autoThumbBackfillOnStartup = !!settings.autoThumbBackfillOnStartup;
  settings.autoHashOnStartup = !!settings.autoHashOnStartup;
  settings.autoSemanticIndexOnStartup = !!settings.autoSemanticIndexOnStartup;
  settings.autoFaceIndexOnStartup = !!settings.autoFaceIndexOnStartup;
  settings.webLanEnabled = settings.webLanEnabled === true;
  settings.cloudflareTunnelAutoStart = !!settings.cloudflareTunnelAutoStart;
  var subFamily = String(settings.subtitleFontFamily || '')
    .trim()
    .toLowerCase();
  if (['system', 'serif', 'mono'].indexOf(subFamily) < 0) subFamily = 'system';
  settings.subtitleFontFamily = subFamily;
  var subSizePx = parseInt(settings.subtitleFontSizePx, 10);
  if (isNaN(subSizePx)) {
    var legacy = String(settings.subtitleFontSize || '')
      .trim()
      .toLowerCase();
    if (legacy === 'md') subSizePx = 18;
    else if (legacy === 'xl') subSizePx = 26;
    else subSizePx = 22;
  }
  if (subSizePx < 12) subSizePx = 12;
  if (subSizePx > 72) subSizePx = 72;
  settings.subtitleFontSizePx = subSizePx;
  var subWeight = String(settings.subtitleFontWeight || '')
    .trim()
    .toLowerCase();
  if (['normal', 'medium', 'bold'].indexOf(subWeight) < 0) subWeight = 'medium';
  settings.subtitleFontWeight = subWeight;
  var subBg = String(settings.subtitleBgOpacity || '')
    .trim()
    .toLowerCase();
  if (['none', 'soft', 'medium', 'strong'].indexOf(subBg) < 0) subBg = 'none';
  settings.subtitleBgOpacity = subBg;
  var subColor = String(settings.subtitleColor || '')
    .trim()
    .toLowerCase();
  if (['white', 'yellow', 'cyan', 'green', 'orange', 'pink'].indexOf(subColor) < 0)
    subColor = 'white';
  settings.subtitleColor = subColor;
  if (settings.uiLocale !== 'en' && settings.uiLocale !== 'zh-CN') settings.uiLocale = 'zh-CN';
  var matchThreshold = Number(settings.aiSearchMatchThreshold);
  if (!isFinite(matchThreshold)) matchThreshold = MATCH_THRESHOLD_RANGE.default;
  settings.aiSearchMatchThreshold = Math.max(
    MATCH_THRESHOLD_RANGE.min,
    Math.min(MATCH_THRESHOLD_RANGE.max, matchThreshold),
  );
  /**
   * tag 检索层（M4）。两件事都必须在这里做：
   *   · **布尔归一**：老配置里没有这个键，`undefined !== false` 恰好等于「开」，
   *     但写进 JSON 再读回来可能变成字符串 `"false"`（手工改过配置文件）—— 那是**真值**，
   *     等于开关永远打不开、也永远关不掉。统一成布尔；
   *   · **夹取**：与 `aiSearchMatchThreshold` 同款。越界值（含 NaN）回默认值，
   *     否则 NaN 会一路传到 SQL 比较里、把查询变成「一张都不返回」。
   */
  if (typeof settings.aiSearchTagEnabled !== 'boolean') settings.aiSearchTagEnabled = true;
  var tagThreshold = Number(settings.aiSearchTagThreshold);
  if (!isFinite(tagThreshold)) tagThreshold = TAG_ROUTE_RANGE.default;
  settings.aiSearchTagThreshold = Math.max(
    TAG_ROUTE_RANGE.min,
    Math.min(TAG_ROUTE_RANGE.max, tagThreshold),
  );
  /**
   * 标签展示线（读侧分数线）。夹取**必须与上面同款**，但理由更强：这个值不经过 worker
   * 就**直接被拼进 SQL 的 `score >= ?`**（`tag-nav.js` / `semantic-tags.js`），
   * 没有一个下游会再兜一次。越界/NaN 穿过去，症状是「标签页整片空白 0 张」
   * 或「61% 的噪声行全冒出来」，而两者都不报错、也不写日志。
   *
   * ⚠️ 与 `aiSearchTagThreshold` **各夹一次、用各自的 range**：两条线量纲相同但语义不同
   *    （能不能搜到 vs 该不该显示），共用一个 clamp 就会在「谁该被谁管」上分叉。
   */
  settings.aiTagDisplayThreshold = clampDisplayMinScore(settings.aiTagDisplayThreshold);
  var previewBoolKeys = [
    'previewShowFileName',
    'previewShowDateTaken',
    'previewShowFileSize',
    'previewShowDimensions',
    'previewShowPosition',
  ];
  for (var pi = 0; pi < previewBoolKeys.length; pi++) {
    var pk = previewBoolKeys[pi];
    if (typeof settings[pk] !== 'boolean') settings[pk] = true;
  }

  // 图片信息面板的启用字段集：未知 id 丢掉、去重、按注册表顺序重排。
  // ⚠️ 空数组是**合法值**（用户可以把字段全关掉），必须原样保留 ——
  //    别写成 `if (!settings.infoPanelFields.length) 回默认`，那会让「全关」变成关不掉。
  //    非数组（含老版本 settings.json 里根本没有这个键）才回落默认集。
  settings.infoPanelFields = PHOTO_INFO_FIELDS.normalizeFieldIds(settings.infoPanelFields);

  var browseSortAllowed = ['date_taken', 'date_modified', 'file_name', 'file_size', 'folder_path'];
  if (browseSortAllowed.indexOf(settings.browseSortBy) < 0) settings.browseSortBy = 'date_taken';
  if (settings.browseSortOrder !== 'ASC' && settings.browseSortOrder !== 'DESC')
    settings.browseSortOrder = 'DESC';
  var bps = parseInt(settings.browsePageSize, 10);
  if ([10, 20, 50, 80, 100, 200].indexOf(bps) < 0) settings.browsePageSize = 20;
  else settings.browsePageSize = bps;
  var bcs = parseInt(settings.browseCardSize, 10);
  if (isNaN(bcs) || bcs < 80) bcs = 180;
  if (bcs > 400) bcs = 400;
  var browseCardTiers = [100, 140, 180, 320];
  var snapped = browseCardTiers[2];
  var bestD = Infinity;
  for (var bci = 0; bci < browseCardTiers.length; bci++) {
    var d = Math.abs(bcs - browseCardTiers[bci]);
    if (d < bestD) {
      bestD = d;
      snapped = browseCardTiers[bci];
    }
  }
  settings.browseCardSize = snapped;
  var bcr = String(settings.browseCardRatio || '').trim();
  if (bcr !== '1 / 1' && bcr !== '3 / 4' && bcr !== '4 / 3' && bcr !== '9 / 16' && bcr !== '16 / 9')
    bcr = '1 / 1';
  settings.browseCardRatio = bcr;
  settings.browseThumbCrop = !!settings.browseThumbCrop;
  var bcl = String(settings.browseCardLayout || '')
    .trim()
    .toLowerCase();
  if (bcl !== 'uniform' && bcl !== 'masonry') bcl = 'masonry';
  settings.browseCardLayout = bcl;
  settings.browseFolderIncludeSubfolders = settings.browseFolderIncludeSubfolders !== false;
  var launchDefaultPage = String(settings.launchDefaultPage || '')
    .trim()
    .toLowerCase();
  if (
    launchDefaultPage !== 'welcome' &&
    launchDefaultPage !== 'all_photos' &&
    launchDefaultPage !== 'all_folders' &&
    launchDefaultPage !== 'last_position'
  ) {
    launchDefaultPage = 'all_photos';
  }
  settings.launchDefaultPage = launchDefaultPage;

  settings.scanFollowSymlinks = !!settings.scanFollowSymlinks;
  var smd = parseInt(settings.scanMaxDepth, 10);
  if (isNaN(smd) || smd < 0) smd = 0;
  settings.scanMaxDepth = smd;
  if (typeof settings.scanSkipDirNames !== 'string') settings.scanSkipDirNames = '';
  if (typeof settings.scanIncludeRaw !== 'boolean') settings.scanIncludeRaw = true;
  var scanDiskProfile = String(settings.scanDiskProfile || '')
    .trim()
    .toLowerCase();
  if (scanDiskProfile !== 'hdd' && scanDiskProfile !== 'ssd' && scanDiskProfile !== 'auto') {
    scanDiskProfile = 'auto';
  }
  settings.scanDiskProfile = scanDiskProfile;
  var scanIoThrottleMs = parseInt(settings.scanIoThrottleMs, 10);
  if (isNaN(scanIoThrottleMs) || scanIoThrottleMs < 0) scanIoThrottleMs = 0;
  if (scanIoThrottleMs > 100) scanIoThrottleMs = 100;
  settings.scanIoThrottleMs = scanIoThrottleMs;

  var hmb = parseInt(settings.hlsMaxCacheBytes, 10);
  if (isNaN(hmb) || hmb < 0) hmb = 1024 * 1024 * 1024;
  // 防止误填超大值导致边界问题，上限 20GB；0 仍表示不限
  if (hmb > 20 * 1024 * 1024 * 1024) hmb = 20 * 1024 * 1024 * 1024;
  settings.hlsMaxCacheBytes = hmb;
  var hme = parseInt(settings.hlsMaxCacheEntries, 10);
  if (isNaN(hme) || hme < 1) hme = 48;
  if (hme > 1000) hme = 1000;
  settings.hlsMaxCacheEntries = hme;

  var tbc = parseInt(settings.thumbBackfillConcurrency, 10);
  // 兜底值必须与 `createDefaultSettings()` 一致 ⇒ 两处都引用常量，别各写一个字面量。
  if (isNaN(tbc) || tbc < 1) tbc = THUMB_BACKFILL_CONCURRENCY_DEFAULT;
  if (tbc > THUMB_BACKFILL_CONCURRENCY_MAX) tbc = THUMB_BACKFILL_CONCURRENCY_MAX;
  settings.thumbBackfillConcurrency = tbc;
}

function validateHlsRuntime(ffmpegPathValue, hlsRootDir) {
  var issues = [];
  if (!ffmpegPathValue || typeof ffmpegPathValue !== 'string' || !fs.existsSync(ffmpegPathValue)) {
    issues.push('ffmpeg path missing');
  }
  if (!hlsRootDir) {
    issues.push('hls root dir missing');
  } else {
    try {
      fs.mkdirSync(hlsRootDir, { recursive: true });
      var p = path.join(hlsRootDir, '.hls-write-test-' + Date.now() + '-' + process.pid + '.tmp');
      fs.writeFileSync(p, 'ok');
      fs.unlinkSync(p);
    } catch (e) {
      issues.push('hls root dir not writable');
    }
  }
  return {
    ok: issues.length === 0,
    issues: issues,
  };
}

function parseScanSkipDirNamesToSet(str) {
  var set = new Set();
  if (!str || typeof str !== 'string') return set;
  var lines = str.split(/[\r\n]+/);
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].trim();
    if (s) set.add(s.toLowerCase());
  }
  return set;
}

function getScanOptions() {
  ensureSettingsShape();
  return {
    followSymlinks: !!settings.scanFollowSymlinks,
    maxDepth: settings.scanMaxDepth || 0,
    skipDirNameSet: parseScanSkipDirNamesToSet(settings.scanSkipDirNames),
    includeRaw: settings.scanIncludeRaw !== false,
    diskProfile: settings.scanDiskProfile || 'auto',
    ioThrottleMs: parseInt(settings.scanIoThrottleMs, 10) || 0,
  };
}

function getThumbOptions() {
  ensureSettingsShape();
  return {
    size: normalizeThumbSize(settings.thumbSize),
    quality: parseInt(settings.thumbQuality, 10) || THUMB_DEFAULT_QUALITY,
  };
}

/** 图片编辑服务（桌面 IPC 与内嵌网页端**共用同一个实例**）。惰性创建，见下。 */
var photoEditService = null;

/**
 * 取（必要时创建）图片编辑服务。
 *
 * 🔴 桌面端与网页端**必须共用同一个实例**：服务内部的编辑是**全局串行**的（见
 *    `photo-edit-service.js` 里那条注释），两端各建一个实例就等于两条互不知情的队列，
 *    「桌面在转、手机同时在裁同一张」会互相覆盖。
 *
 * 🔴 缩略图档位必须传 `getThumbOptions`（而不是就地读 `settings`）：
 *    与服务内其他调用点用**同一份**档位解析，网页端那条路也走同一个函数，
 *    否则编辑后重算的缩略图会和库里的档位不一致 ⇒ 被重跑任务反复当成「待重生成」。
 */
function getPhotoEditService() {
  if (!photoEditService) {
    photoEditService = createPhotoEditService({
      db: db,
      getThumbOptions: getThumbOptions,
      videoExtensions: VIDEO_EXTENSIONS,
      invalidateForRoot: function (rootId) {
        invalidateCatalogCacheForRootSafe(rootId);
      },
      invalidateDerivedGroups: function () {
        // 像素 / 尺寸 / 指纹都变了 ⇒ 「重复」「相似」两个分组缓存必须作废。
        clearDuplicateHashGroupsCache('photo-edit');
        clearSimilarDhashGroupsCache('photo-edit');
      },
      logWarn: function (msg) {
        console.warn('[photo-edit] ' + msg);
      },
    });
  }
  return photoEditService;
}

function isFolderScanRunning() {
  return !!workerScanIsActive;
}

function serializeScanOptionsForWorker() {
  var so = getScanOptions();
  return {
    followSymlinks: !!so.followSymlinks,
    maxDepth: so.maxDepth || 0,
    includeRaw: so.includeRaw !== false,
    skipDirNames: so.skipDirNameSet ? Array.from(so.skipDirNameSet) : [],
    diskProfile: so.diskProfile || 'auto',
    ioThrottleMs: parseInt(so.ioThrottleMs, 10) || 0,
  };
}

function terminateScanWorkerSilently() {
  if (!scanWorker) return;
  try {
    scanWorker.removeAllListeners();
    scanWorker.terminate();
  } catch (e) {}
  scanWorker = null;
}

function runFolderScanInWorker(normalizedRootPath) {
  return new Promise(function (resolve) {
    if (!sqliteDbPath) {
      resolve({ cancelled: false, error: '数据库路径未初始化' });
      return;
    }
    scanWorkerDoneReceived = false;
    workerScanIsActive = true;
    workerScanStartedAt = Date.now();
    workerScanLastPhase = 'start';
    workerScanProgress = { current: 0, total: 0, status: 'scanning', currentFile: '' };
    logger.task('scan', 'start', 'root=' + normalizedRootPath, { startedAt: workerScanStartedAt });
    var lastHeartbeatAt = Date.now();
    var heartbeatWatchTimer = null;

    var workerPath = path.join(__dirname, 'scan-worker.js');
    var w;
    try {
      w = new Worker(workerPath, {
        workerData: {
          dbPath: sqliteDbPath,
          rootPath: normalizedRootPath,
          thumbOptions: getThumbOptions(),
          scanOptions: serializeScanOptionsForWorker(),
        },
      });
    } catch (spawnErr) {
      workerScanIsActive = false;
      workerScanStartedAt = 0;
      resolve({
        cancelled: false,
        error: spawnErr && spawnErr.message ? spawnErr.message : String(spawnErr),
      });
      return;
    }
    scanWorker = w;

    function finish(result) {
      if (scanWorkerDoneReceived) return;
      scanWorkerDoneReceived = true;
      workerScanIsActive = false;
      workerScanStartedAt = 0;
      if (heartbeatWatchTimer) {
        clearInterval(heartbeatWatchTimer);
        heartbeatWatchTimer = null;
      }
      // 确保渲染层能看到最终状态（否则队列处理中会一直显示旧的 0%）
      try {
        if (result && result.cancelled) {
          workerScanProgress = { current: 0, total: 0, status: 'cancelled', currentFile: '' };
        } else if (result && result.error) {
          workerScanProgress = {
            current: 0,
            total: 0,
            status: 'error',
            currentFile: '',
            error: result.error,
          };
        } else {
          // 正常完成：保持 done
          workerScanProgress = Object.assign({}, workerScanProgress, { status: 'done' });
        }
      } catch (e0) {}
      /**
       * 扫描结局落盘。理由同 phase 打点：生产档日志是静默的，
       * 「这次扫描到底跑完没有、是报错还是被取消」如果只打日志就等于没记录 ——
       * 用户说「自动扫描失败」时，我们手里就只剩一句他自己转述的文案。
       */
      try {
        var outcome = result && result.error
          ? 'error | ' + result.error
          : result && result.cancelled
            ? 'cancelled'
            : 'done';
        startupStageLog('scan.finish', outcome);
      } catch (eSM) {
        void eSM;
      }
      var cur = scanWorker;
      scanWorker = null;
      if (cur) {
        cur.terminate().catch(function () {});
      }
      resolve(result);
    }

    // worker 理论上每 300ms 都会发 progress；若长期无任何消息，说明 worker 卡死或通信异常
    heartbeatWatchTimer = setInterval(function () {
      if (scanWorkerDoneReceived) return;
      var silentMs = Date.now() - lastHeartbeatAt;
      // Worker 在加载大库映射 / 全量枚举时可能数秒～数十秒无消息；过短会误杀。真死锁仍会被终止。
      //
      // ⚠️ 这个阈值是**契约**，不是随便定的数：`scanner.js` 里每一个同步阶段都必须让它自己
      // 小于本值（做法是按批 + `await` 让出，见 `cleanupStalePhotosForRoot` /
      // `refreshRootFolderStatsCacheForRoot`）。真库上曾经有一处一次性 `.all()` 物化
      // 91 万行、单段同步 71 秒，叠上三条 61 秒的聚合，把一个只是**正在读盘**的健康扫描
      // 判成了「线程无响应」并终止。改阈值治不了这类问题，只会把误杀时间往后推。
      var scanWorkerHeartbeatMs = 120000;
      if (silentMs > scanWorkerHeartbeatMs) {
        var phaseLabel = SCAN_PHASE_LABELS[workerScanLastPhase] || workerScanLastPhase || '未知';
        logger.task('scan', 'heartbeat.timeout', 'silentMs=' + silentMs + ' phase=' + phaseLabel, {
          startedAt: workerScanStartedAt,
        });
        finish({
          cancelled: false,
          error:
            '扫描线程无响应（超过 ' +
            Math.round(silentMs / 1000) +
            ' 秒，最后阶段：' +
            phaseLabel +
            '），已终止。请重试添加目录/重新扫描。',
        });
      }
    }, 5000);

    w.on('message', function (msg) {
      lastHeartbeatAt = Date.now();
      if (!msg || !msg.type) return;
      if (msg.type === 'phase' && msg.name) {
        // 阶段自报：既证明线程活着（重置安静计时），也让超时文案能说出卡在哪一步
        workerScanLastPhase = String(msg.name);
        // 落盘留痕：生产档 `logger` 是静默的（`warn` 档丢掉 `info`），不写进
        // `startup-performance.json` 就等于事后没有任何现场 —— 「卡在哪个阶段、每段多久」
        // 是排查这条看门狗的唯一线索。每个阶段只在进入时自报一次，成本可忽略。
        startupStageLog('scan.phase.' + msg.name);
      }
      if (msg.type === 'progress' && msg.p) {
        workerScanProgress = Object.assign(
          { current: 0, total: 0, status: 'scanning', currentFile: '' },
          msg.p,
        );
      }
      if (msg.type === 'done') {
        if (msg.finalProgress) {
          workerScanProgress = Object.assign(
            { current: 0, total: 0, status: 'done', currentFile: '' },
            msg.finalProgress,
          );
        }
        var scanStatus = msg.error ? 'error' : msg.cancelled ? 'cancelled' : 'done';
        logger.task('scan', scanStatus, msg.error || '', {
          startedAt: workerScanStartedAt,
          current: msg.finalProgress ? msg.finalProgress.current : 0,
          total: msg.finalProgress ? msg.finalProgress.total : 0,
        });
        finish({
          cancelled: !!msg.cancelled,
          error: msg.error || null,
          scanResult: msg.scanResult || null,
        });
      }
    });

    w.on('error', function (err) {
      finish({
        cancelled: false,
        error: err && err.message ? err.message : String(err),
      });
    });

    w.on('exit', function (code) {
      /**
       * 🔴 判据必须是「有没有收到过 `done`」，**不是**「退出码是不是 0」。
       *
       * worker 在 `parentPort` 关闭、或事件循环里再没有任何 handle 时是**以 0 退出**的。
       * 旧代码只处理 `code !== 0`，于是这种「没发 done 就退出」的情况下主进程一直干等，
       * 直到 120 秒看门狗报出「扫描线程无响应（超过 123 秒），已终止」——
       * 用户以为**卡死**了，其实线程**早就退出了**，真正的死因（未捕获异常、栈）在那一刻就丢了，
       * 重试多少次都只会看到同一句话。
       */
      if (scanWorkerDoneReceived) return;
      /**
       * ⚠️ 必须**延后**再判定：worker 可能刚 `postMessage(done)` 就退出，而
       * `exit` 与 `message` 的**到达顺序没有保证**（跨线程投递）。立刻判定会把
       * 「正常完成」误报成「提前退出」。延后 500ms 对「发现线程已死」这件事没有代价 ——
       * 它本来要等 120 秒看门狗。
       */
      setTimeout(function () {
        if (scanWorkerDoneReceived) return;
        finish({
          cancelled: false,
          error:
            code === 0
              ? '扫描线程提前退出（未返回结果）'
              : '扫描线程异常退出（代码 ' + code + '）',
        });
      }, 500);
    });
  });
}

function loadSettings() {
  try {
    var data = fs.readFileSync(settingsFilePath, 'utf8');
    var parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings root must be object');
    }
    // 旧版 JSON 缺字段时用默认值补齐，避免读到半份对象导致行为像「没保存」
    settings = Object.assign(createDefaultSettings(), parsed);
  } catch (e) {
    logger.error('[settings] load failed, using defaults:', e && e.message ? e.message : e);
    settings = createDefaultSettings();
    saveSettings();
  }
  ensureSettingsShape();
}

/**
 * 每次 IPC 拉配置前从 settings.json 同步到内存，避免磁盘已更新（或外部修改）而主进程仍持旧对象，导致前端永远看到默认项。
 */
function reloadSettingsFromDiskSilently() {
  if (!settingsFilePath) return;
  try {
    if (!fs.existsSync(settingsFilePath)) return;
    var data = fs.readFileSync(settingsFilePath, 'utf8');
    var parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    settings = Object.assign(createDefaultSettings(), parsed);
    ensureSettingsShape();
  } catch (e) {
    logger.error('[settings] reload from disk failed:', e && e.message ? e.message : e);
  }
}

function saveSettings() {
  var tmpPath = settingsFilePath + '.tmp';
  try {
    ensureSettingsShape();
    var payload = JSON.stringify(settings, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    try {
      fs.renameSync(tmpPath, settingsFilePath);
    } catch (renErr) {
      // Windows 上目标已存在时 rename 可能失败，先删再替换，仍比直接写 settings.json 更不易留下半截文件
      try {
        if (fs.existsSync(settingsFilePath)) fs.unlinkSync(settingsFilePath);
      } catch (u) {}
      fs.renameSync(tmpPath, settingsFilePath);
    }
  } catch (e) {
    logger.error('[settings] save failed:', e && e.message ? e.message : e);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (e2) {}
  }
}

/**
 * 扫描任务的去重键：同一个目录不重复排队。
 *
 * 只做**字符串级**归一化（斜杠统一 / 去尾部反斜杠 / 小写），刻意不用 `path.resolve`——
 * 它会把相对路径按当前工作目录展开，反而可能把两个不同的相对目录判成同一个；
 * 而 Windows 路径大小写不敏感，小写化是安全且必要的。DB 里存的仍是原始大小写。
 */
function scanRootKey(rootPath) {
  return String(rootPath == null ? '' : rootPath)
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/**
 * 结束一个扫描任务。
 *
 * 🔴 **先摘去重表、再 resolve，顺序不能反。** 被 resolve 唤醒的调用方很可能立刻再点一次扫描
 * （或另一个文件夹的调用方紧接着入队），此时如果表里还挂着这个已经结束的任务，
 * 新请求会合并到一个永远不会再 settle 的 Promise 上 —— 界面就永久停在「准备中…」。
 */
function settleScanTask(task, payload) {
  if (task.key && scanTasksByRoot.get(task.key) === task) {
    scanTasksByRoot.delete(task.key);
  }
  task.resolve(payload);
}

function clearPendingScanQueue() {
  // 已被取出、还在等写库闸门放行的那个也要能被打断 —— 这时任务已经不在 scanQueue 里，
  // 也还没有 worker 可以 postMessage，只能靠这个标志（由占闸门后的第一件事检查）。
  if (currentScanTask && !currentScanTask.started) currentScanTask.cancelled = true;
  if (scanQueue.length === 0) return;
  var pending = scanQueue.splice(0, scanQueue.length);
  for (var i = 0; i < pending.length; i++) {
    pending[i].cancelled = true;
    settleScanTask(pending[i], { success: false, cancelled: true });
  }
}

function getScanQueueStatus() {
  return {
    processing: isScanQueueProcessing,
    current: currentScanTask
      ? {
          id: currentScanTask.id,
          source: currentScanTask.source,
          rootPath: currentScanTask.rootPath,
          // 已被取出、但还没拿到写库闸门 —— 界面必须能和「正在扫描」区分开，
          // 否则会显示成「正在扫描... 0%」这种假进度。
          waitingGate: !currentScanTask.started,
        }
      : null,
    pendingCount: scanQueue.length,
    pending: scanQueue.map(function (t) {
      return { id: t.id, source: t.source, rootPath: t.rootPath };
    }),
  };
}

/**
 * 排队一个目录扫描。
 *
 * 🔴 **不再同步拒绝。** 过去这里遇到 `optimizeTaskRunning || dbWriteQueue.isBusy()` 就直接返回
 * `{ success: false, error: '…请等它跑完再试' }`，把「库正忙」甩给用户自己去挑时机重试。
 * 但扫描在 `processScanQueue` 里本来就是**排队**语义（渲染端一直等这个 Promise 到扫描结束），
 * 所以正确做法是让扫描也进同一个写库闸门、老实排队，而不是让用户挨拒。
 *
 * 同一目录**合并**：已经在跑或已在排队的任务复用同一个 Promise（重复点击过去会真扫两遍）。
 * 付这点代价换来的是「一个目录同时只有一个扫描」，比排两次更符合直觉。
 */
function enqueueScanTask(task) {
  var key = scanRootKey(task.rootPath);
  var existing = scanTasksByRoot.get(key);
  if (existing) return existing.promise;

  var entry = {
    id: scanTaskIdSeq++,
    key: key,
    source: task.source || 'manual',
    rootPath: task.rootPath,
    beforeScan: task.beforeScan || null,
    /** 拿到写库闸门、即将起 worker 时置 true；false 期间的取消只能靠 cancelled 标志 */
    started: false,
    cancelled: false,
    resolve: null,
    promise: null,
    /**
     * 「这次扫描**已进入写库队列**」的信号（T5）。启动期提交器（`submitStartupWriteTasks`）
     * 靠它把「自动扫描排在修复类任务之前」变成事实而不是巧合 ——
     * `enqueueScanTask` 到 `dbWriteQueue.run('scan')` 之间隔着一个让路 await，
     * 提交器若在同一 tick 里接着 `run('thumbnail-fix')`，同档 FIFO 会把扫描顶到后面。
     */
    gate: null,
    gateResolve: null,
  };
  entry.promise = new Promise(function (resolve) {
    entry.resolve = resolve;
  });
  entry.gate = new Promise(function (resolve) {
    entry.gateResolve = resolve;
  });
  scanTasksByRoot.set(key, entry);
  scanQueue.push(entry);
  processScanQueue();
  return entry.promise;
}

async function processScanQueue() {
  if (isScanQueueProcessing) return;
  isScanQueueProcessing = true;
  var hasSuccessfulScan = false;
  while (scanQueue.length > 0) {
    await yieldForPreviewPlaybackMs(100);
    var task = scanQueue.shift();
    currentScanTask = task;
    try {
      // 🔴 扫描必须占住写库闸门。
      // `scan-worker` 在自己的连接上逐批 COMMIT，是一个**真实的写者**；它过去完全不认识
      // 这条件列，于是启动期的 thumbnail-fix / deferred-index / FTS 会和它同时持写锁
      // —— 队列的「串行」对扫描根本无效。整个扫描期间持队列是刻意的取舍：
      // 拿不到 worker 内部的批次边界，租约粒度就只能取「一次扫描」。
      // 代价是给扫描让路的是**整个扫描时长**。可接受：回填 / 重复哈希 / 失效清理本来
      // 就都有 isFolderScanRunning() 前置判断、扫描期间主动让路，所以只是顺序变诚实了。
      // 开机的自动扫描是 REPAIR（扫描产出的正是待修复的行，修数据正确性）；
      // 用户手动点的是 USER —— 人在等，要能插到回填 / FTS 这些建索引的活前面。
      var scanRun = dbWriteQueue.run(
        'scan',
        function () {
          // 排队期间被取消的：不要再起 worker（任务已被 shift 出去、还没开跑时，
          // cancel-scan 没有 worker 可以 postMessage，只能靠这个标志打断）
          if (task.cancelled) return Promise.resolve({ cancelled: true });
          task.started = true;
          if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('scan-start');
          }
          if (typeof task.beforeScan === 'function') {
            task.beforeScan();
          }
          var normalizedPath = task.rootPath.replace(/\//g, '\\');
          return runFolderScanInWorker(normalizedPath);
        },
        { priority: task.source === 'auto' ? PRIORITY.REPAIR : PRIORITY.USER },
      );
      // 🔴 信号必须在 `run()` **之后**发：`run` 是同步入队 + 同步 pump，走到这里本次扫描
      // 要么已 active、要么已在队首。启动期提交器 await 到它再提交修复类任务，
      // 「自动扫描在前」就成了事实。放在 `run()` 之前会让提交器抢先把 REPAIR 任务
      // 塞进队首（同档 FIFO），顺序又回到「谁先醒谁先跑」。
      if (typeof task.gateResolve === 'function') {
        task.gateResolve();
        task.gateResolve = null;
      }
      var wr = await scanRun;
      var resultPayload;
      if (wr && wr.error && !wr.cancelled) {
        resultPayload = { success: false, error: wr.error };
      } else if (wr && wr.cancelled) {
        resultPayload = { success: false, cancelled: true };
      } else {
        resultPayload = {
          success: true,
          cleanupDeleted:
            wr && wr.scanResult && Number(wr.scanResult.cleanupDeleted)
              ? Number(wr.scanResult.cleanupDeleted)
              : 0,
        };
        if (wr && wr.scanResult && wr.scanResult.perf && wr.scanResult.perf.length > 0) {
          var perf = wr.scanResult.perf;
          var totalMs = perf[perf.length - 1] ? perf[perf.length - 1].elapsed : 0;
          logger.task(
            'scan',
            'perf.summary',
            perf
              .map(function (p) {
                return p.label + '=' + p.step + 'ms';
              })
              .join(' '),
            { startedAt: workerScanStartedAt || Date.now(), totalMs: totalMs },
          );
        }
      }
      // 无论成功/失败/取消，都发送完成信号，让渲染层退出“准备中...”
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('scan-complete', task.rootPath, resultPayload);
      }
      if (resultPayload && resultPayload.success) {
        hasSuccessfulScan = true;
        var rid = resolveRootIdByPath(task.rootPath);
        if (rid) invalidateCatalogCacheForRootSafe(rid);
        else invalidateCatalogCachesSafe();
      }
      settleScanTask(task, resultPayload);
    } catch (err) {
      var errPayload = { success: false, error: err && err.message ? err.message : String(err) };
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('scan-complete', task.rootPath, errPayload);
      }
      settleScanTask(task, errPayload);
    }
    currentScanTask = null;
  }
  isScanQueueProcessing = false;
  if (hasSuccessfulScan) {
    scheduleAutoThumbnailBackfill();
    scheduleAutoDuplicateHashDetection();
    // 扫描刚往库里塞了新文件 —— 可能包含新的 Live Photo 对（含它们的伴生 MOV）。
    // 先让补图/查重排上（它们各自的延迟与本项独立），本项幂等地只认领
    // `live_still_id IS NULL` 的 MOV，因此重复触发是安全的。
    scheduleLivePhotoPairing(800);
  }
}

/**
 * 补全进度快照。**分母是缩略图口径**（还差几张预览图），不是候选集口径（任务还剩几行活）——
 * 两者在本机真实库上差 4 倍以上（34 万 vs 156 万），混用会让百分比与用户的等待时间脱钩。
 * 见 `database.js#countPhotosLackingThumbnail()`。
 *
 * 🔴 `phase` 是承重字段，UI 必须**先按它分支**再决定画不画百分比：
 *    分母没到手（`'counting'`）与分母为 0 是两件事 —— 前者是「还不知道」，后者是「没有要补的」。
 *    把前者画成 `0 / 0` + 空进度条，就是把「不知道」画成了「没进展」。
 */
/**
 * 「当前还缺多少张缩略图」的**实时值**（UI 副行的 `还缺 M`）。
 *
 * ## 为什么不能直接把 `thumbnailBackfill.thumbTotal` 画出去
 *
 * 那个字段是**最近一次精确统计**的结果，两次统计之间（`THUMB_TOTAL_REFRESH_MS` = 5 s，
 * 且带 in-flight 闸门，实际落在 5~10 s）**一动不动**。而旁边三项
 * （拍摄信息 / 视觉指纹 / 查重指纹）都是每批自增的累加器 ⇒ 用户看到「三项在涨、
 * 还缺不动」，合理地认为数字坏了。2026-10-06 用户报的就是这个。
 *
 * ## 派生公式
 *
 *     实时剩余 = 基线 − (本轮已生成缩略图数 − 取基线时的那个数)
 *
 * 口径上逐项对得上：能减少「还缺」的**只有**真的写出了缩略图这件事 ——
 * 只补了尺寸 / dHash / 指纹 / 拍摄参数的行不减（那些行本来就有缩略图），
 * 失败的行也不减（它仍然缺）。两者与 `thumbnailBackfill.thumbs` 的累加条件完全一致
 * （见 `processOne` 里 `thumbs++` 的注释：只在 `updatePhotoThumbnail` 之后自增）。
 *
 * ⚠️ 第二趟（`pass === 'metadata'`）本就不出图 ⇒ 这个数不动，那是**对的**，
 *    不是卡住；UI 拿 `pass` 区分。
 *
 * ⚠️ 结果是**下界**：并发**扫描入库**新加进来的缺图行不计（它们不在基线里），
 *    所以这个数可能偏小，由 5 s 的周期精确统计纠偏。宁可偏小也不能偏大 ——
 *    偏大意味着「明明还在补却显示 0」，会被当成「已跑完」。
 *
 * @returns {number} 非负整数；基线还没到手时返回 0（UI 的判据是 `> 0` ⇒ 不显示这一段）
 */
function currentPendingThumbTotal() {
  var base = thumbnailBackfill.thumbTotal;
  if (base == null) return 0;
  var baseValue = Number(base) || 0;
  var generated = (Number(thumbnailBackfill.thumbs) || 0) - (Number(thumbnailBackfill.thumbTotalBaseThumbs) || 0);
  if (!(generated > 0)) return baseValue;
  return Math.max(0, baseValue - generated);
}

function getThumbnailBackfillProgress() {
  /** 主分子：本轮**已处理的行数**（含只补了尺寸 / dHash / 指纹 / 拍摄参数、没出预览图的行） */
  var processed = Number(thumbnailBackfill.done) || 0;
  /** 副分子：本轮真的写出了预览图的张数 */
  var thumbs = Number(thumbnailBackfill.thumbs) || 0;
  /** 主分母：候选集规模的**抽样估计值**（约数） */
  var total = thumbnailBackfill.pendingTotal;
  var hasTotal = total != null && total > 0;
  // 分母是**起始快照**：并发入库的新图片不在里面，分子可能反超。两头都夹住，
  // 否则会显示「107%」和负的剩余时间。
  var denom = hasTotal ? Math.max(Number(total), processed) : 0;
  var pct = denom > 0 ? Math.min(100, Math.round((processed / denom) * 100)) : 0;
  var exportable = thumbnailBackfill.running
    ? thumbnailBackfill.failedPaths.length
    : thumbnailBackfill.failedPathsLastRun.length;
  return {
    running: thumbnailBackfill.running,
    cancelled: thumbnailBackfill.cancelled,
    /** `'counting'` | `'ready'` | `'failed'`；未运行时为 `null` */
    phase: thumbnailBackfill.running ? thumbnailBackfill.pendingPhase || 'counting' : null,
    /**
     * 当前趟：`'thumbnail'` | `'metadata'` | `null`（未运行）。
     * `'metadata'` 那一趟**本来就不出图** ⇒ UI 不能把「预览图 0 张」画成异常。
     */
    pass: thumbnailBackfill.running ? thumbnailBackfill.pass || 'thumbnail' : null,
    /**
     * 候选集规模的**估计值**（任务起始快照）⇒ UI 必须带「约」。
     * `null` = 还没统计出来。
     */
    total: hasTotal ? denom : null,
    /** 本轮**已处理的行数**（主分子）。任务真正在做的事由它体现 */
    done: processed,
    /**
     * ⚠️ 分母未就绪时它恒为 0，**不代表没进展** —— 只给不方便读 `phase` 的消费方兜底，
     *    UI 一律以 `phase` 为准。
     */
    pct: pct,
    /**
     * 副指标 · 预览图：`thumbTotal` = **当前**还缺缩略图的张数（`has_thumbnail = 0`），
     * `thumbs` = 本轮新生成的张数。
     *
     * ⚠️ 2026-10-06 起它是**派生实时值**（`currentPendingThumbTotal()`）：精确统计每 5 s 校准
     *    一次基线，两次统计之间按「本轮新生成了几张」递推 ⇒ 每批都在动，与旁边三项同节拍。
     *    在此之前它是「每 5 s 才跳一次的精确值」（注释里曾写「30 s」，早已过时），
     *    用户拿它对比旁边三个累加器就会认为这个数坏了。
     *
     * 🔴 它**刻意不做主口径**：补全按 id 倒序走，而缺缩略图的行几乎全压在低位老图片上
     *    （本机真实库：`id 1,900,000~1,999,999` 只有 10 行缺、`1,600,000~1,899,999` 才有 33.9 万）
     *    ⇒ 任务头几万行一张图都不出，拿它当分母会让进度条在 0% 上趴十几分钟。
     *    详见 `database.js#countPhotosLackingThumbnail()`。
     *    UI 的判据是 `> 0`，所以「还没统计出来」与「真的都补齐了」都表现为「不显示这一段」。
     */
    thumbs: thumbs,
    thumbTotal: currentPendingThumbTotal(),
    /** 细分产出：让「不只是在做预览图」在 UI 上看得见（否则用户只看到预览图 0 张） */
    sized: Number(thumbnailBackfill.sized) || 0,
    dhashed: Number(thumbnailBackfill.dhashed) || 0,
    hashed: Number(thumbnailBackfill.hashed) || 0,
    exifFilled: Number(thumbnailBackfill.exifFilled) || 0,
    success: thumbnailBackfill.success,
    failed: thumbnailBackfill.failed,
    currentFile: thumbnailBackfill.currentFile,
    // ETA 按**已处理行数**算：它与任务的总工作量对齐（分母就是候选集规模），
    // 而按预览图算会在头十几分钟里恒为 null。
    // ⚠️ taskKey 与旧口径的 `'thumbBackfill'` / `'thumbBackfillByThumbs'` 都分开，
    //    避免平滑状态被不同口径交替喂（那会把 ETA 变成两种速率的加权平均）。
    etaSeconds: hasTotal
      ? estimateEtaSecondsSmoothed(
          'thumbBackfillByProcessed',
          thumbnailBackfill.startedAt,
          processed,
          denom,
        )
      : null,
    failedPathsExportable: exportable,
  };
}

/**
 * 异步取「**当前**还缺几张缩略图」，写进 `thumbnailBackfill.thumbTotal`。
 *
 * 🔴 语义是**实时剩余**（2026-10-06 改），不是任务起始快照 —— 用户看到「预览图 N 涨、
 *    待补 M 一动不动」会以为数字坏了。改成实时之后 `N + M ≈ 起跑线`（恒等式），
 *    两个数同一时点、读起来自洽。它**不参与**任何百分比与 ETA（那两个走 `pendingTotal`），
 *    所以这次改动只影响副行那一段文字。
 *
 * ⚠️ 因此**绝不能**再夹 `Math.max(n, thumbs)`（旧快照口径下那条夹取是必要的：
 *    快照是分母、`thumbs` 是分子，分子不许超过分母）。实时口径下 N 与 M 是**互补**的，
 *    任务过半后必然 `M < N`；再夹一次就把 M 冻在 N 上、再也不降 —— 正是要修的毛病。
 *
 * 🔴 必须走读 worker，**不能**在主进程直接 `db.countPhotosLackingThumbnail()`：
 *    本机 14 GB 库实测 16 ms，但那是本地盘且页缓存热的情况；同一个库在外接机械盘
 *    （本机的图库就在 `K:\COS` 这类盘上）或网络路径上，扫 166 万条索引条目可以慢几个数量级
 *    —— 主进程同步等它，冻的是整个界面。worker 还自带超时，等不到就 reject ⇒ 降级。
 *
 * ⚠️ 结果要拿 `runToken` 对身份：任务可能已经结束、甚至已经开始了下一轮，这时把旧值
 *    写进新任务的状态 = 数字凭空变成上一轮的，不报错但读数是错的。
 * ⚠️ 拿不到就**留 `null`**（而不是写 0）：`thumbTotal = 0` 与「还没统计出来」在 UI 上
 *    必须能区分（副行的判据是 `> 0`）。⚠️ 实时口径下 0 是**合法值**（真的都补齐了），
 *    副行此时不显示这一段 —— 这是可接受的降级，比显示「还缺 0」与其他状态混淆要好。
 * ⚠️ 入口处先盖时间戳：初始那一次调用与周期刷新共用同一个节流闸门。
 */
async function countPendingThumbnailsForProgress() {
  var token = thumbnailBackfill.runToken;
  thumbTotalRefreshedAt = Date.now();
  if (!sqliteDbPath) return;
  try {
    var n = await runDbReadWorkerOnly(sqliteDbPath, 'getPendingThumbCount', {});
    if (token !== thumbnailBackfill.runToken) return; // 上一轮的迟到结果，丢弃
    // 🔴 先记「此刻已生成多少张」，再写基线。两者之间**不许有 await**（本函数当前满足，
    //    因为是连续两条赋值）—— 一旦插入挂起点，快照就可能落在基线之后，
    //    `thumbs − baseThumbs` 会把这之间生成的张数当成「基线之前」的，实时剩余系统性偏小。
    thumbnailBackfill.thumbTotalBaseThumbs = Number(thumbnailBackfill.thumbs) || 0;
    thumbnailBackfill.thumbTotal = Number(n) || 0;
  } catch (eCount) {
    if (token !== thumbnailBackfill.runToken) return;
    // warn 级：生产档 info 是静默的，这条日志是「为什么副行没有分母」的唯一现场
    logger.warn(
      '[thumb-backfill] count pending thumbnails failed, thumbnail sub-counter has no denominator:',
      eCount && eCount.message ? eCount.message : eCount,
    );
  }
  emitBackgroundTasksChangedThrottled(false);
}

/**
 * 刷新副指标（「还缺多少张预览图」）的**唯一入口**：按 `THUMB_TOTAL_REFRESH_MS` 节流。
 *
 * 两个调用点（缺一不可，各管一种情形）：
 *   ① `startPendingThumbRefreshTicker()` 的 1 s 定时器 —— **主节拍**；
 *   ② 主循环每批之后 —— 兜底（定时器万一被清掉，批次边界仍会刷新）。
 *
 * 🔴 为什么主节拍从「每批一次」改成**定时器**（2026-10-06）：补全一批 100 行、约 8~10 s，
 *    节流再短也白搭 —— 检查点被批次边界量化 ⇒ 30 s 的节流实际落在 30~40 s。
 *    改用定时器后节拍与批次解耦，读数才真的是「每 5 s 一次」。
 * 🔴 **不许 `await`**（调用点就是这么用的）：它是纯附属读数，让 worker 往返拖慢主循环
 *    等于用进度文字换补全速度。结果通过 `emitBackgroundTasksChangedThrottled` 回流到 UI。
 * 🔴 `thumbTotalRefreshInFlight` 是必需的，不是保险：这次计数在慢盘 / 大库上可能远超一个周期，
 *    没闸门就会每个滴答叠一个 worker 任务，各自扫一遍同一份索引 —— 反过来拖慢补全。
 */
function schedulePendingThumbRefresh() {
  if (thumbTotalRefreshInFlight) return;
  if (Date.now() - thumbTotalRefreshedAt < THUMB_TOTAL_REFRESH_MS) return;
  thumbTotalRefreshInFlight = true;
  void countPendingThumbnailsForProgress().finally(function () {
    thumbTotalRefreshInFlight = false;
  });
}

/**
 * 起手副指标定时器。**必须与 `stopPendingThumbRefreshTicker()` 成对**：
 * 任务收尾（含取消 / 抛异常）不清定时器 = 进程里留一个永远在跑的 1 s 定时器，
 * 关掉任务后还在打 worker、还在推 `background-tasks-changed`，静默耗电、查不出来源。
 */
function startPendingThumbRefreshTicker() {
  stopPendingThumbRefreshTicker();
  thumbTotalRefreshTimer = setInterval(schedulePendingThumbRefresh, THUMB_TOTAL_TICK_MS);
  // 刻意**不** `unref()`：它随任务存亡（任务在跑时本来就该有它），
  // 且主进程由窗口持有，不存在「定时器吊住进程不退」的问题。
}

/** 收尾副指标定时器（幂等：没起过 / 已清掉都安全）。 */
function stopPendingThumbRefreshTicker() {
  if (thumbTotalRefreshTimer) {
    clearInterval(thumbTotalRefreshTimer);
    thumbTotalRefreshTimer = null;
  }
}

/**
 * 异步估计「补全候选集」的规模 —— **主进度条的分子 / 分母**。
 *
 * 🔴 为什么不像缩略图那样做**精确**计数：候选谓词（`_sqlBackfillPendingExpr()`）判的列
 *    （`dhash` / `width` / `file_type` / `exif_mtime` / `exif_ver`）一个索引都没有 ⇒ 精确
 *    `COUNT(*)` 只能 `SCAN photos`，本机真实库实测 **80~95 秒**（还是它与补全任务抢同一块盘
 *    时量到的）。进度分母等不起一分半，更不该反过来把正在读图的补全拖慢。
 *    `estimatePendingCandidateCount()` 走 id 轴抽样点查：约 2000 次主键定位，亚秒级。
 *
 * ⚠️ 结果是**估计值**（±1% 量级）⇒ UI 必须带「约」；且它是**起始快照**，跑动中不刷新。
 * 🔴 身份判据与 `countPendingThumbnailsForProgress` 完全一致（`runToken`）：迟到的估计值
 *    写进下一轮状态会让百分比凭空变形，且不报错。
 */
async function countPendingCandidatesForProgress() {
  var token = thumbnailBackfill.runToken;
  if (!sqliteDbPath) {
    thumbnailBackfill.pendingPhase = 'failed';
    return;
  }
  try {
    var res = await runDbReadWorkerOnly(sqliteDbPath, 'estimatePendingCount', {});
    if (token !== thumbnailBackfill.runToken) return; // 上一轮的迟到结果，丢弃
    var est = res && typeof res === 'object' ? Number(res.estimate) : Number(res);
    if (!isFinite(est) || est <= 0) {
      thumbnailBackfill.pendingPhase = 'failed';
    } else {
      // 统计期间任务已经开跑 ⇒ 取更大值，别让分母小于分子
      thumbnailBackfill.pendingTotal = Math.max(est, Number(thumbnailBackfill.done) || 0);
      thumbnailBackfill.pendingPhase = 'ready';
    }
  } catch (eCount) {
    if (token !== thumbnailBackfill.runToken) return;
    thumbnailBackfill.pendingPhase = 'failed';
    // warn 级：生产档 info 是静默的，这条日志是「为什么没有百分比」的唯一现场
    logger.warn(
      '[thumb-backfill] estimate pending candidates failed, progress continues without denominator:',
      eCount && eCount.message ? eCount.message : eCount,
    );
  }
  emitBackgroundTasksChangedThrottled(false);
}

function getThumbnailBackfillFailedPathsForExport() {
  if (thumbnailBackfill.running) {
    return thumbnailBackfill.failedPaths.slice();
  }
  return thumbnailBackfill.failedPathsLastRun.slice();
}

function getInvalidCleanupTaskProgress() {
  var checked = Number(invalidCleanupTask.checked) || 0;
  var total = Number(invalidCleanupTask.total) || 0;
  return {
    running: !!invalidCleanupTask.running,
    checked: checked,
    deleted: Number(invalidCleanupTask.deleted) || 0,
    total: total,
    done: checked,
    /**
     * 🔴 百分比由**主进程**给，渲染端不再自己除（`docs/contracts/background-tasks.md` §1.1）。
     * `total` 起手是 0、之后才异步取到全库行数 ⇒ 靠 `computePct` 把那段画成 0%，
     * 而不是渲染端以前那种「没有总数就画满」——那会让条子先满、再掉回 0%，看着像倒退。
     */
    pct: computePct(checked, total),
    currentFile: invalidCleanupTask.currentFile || '',
    etaSeconds: estimateEtaSecondsSmoothed(
      'invalidCleanup',
      invalidCleanupTask.startedAt,
      checked,
      total,
    ),
  };
}

function emitBackgroundTasksChangedThrottled(force) {
  if (!mainWindow || !mainWindow.webContents) return;
  var now = Date.now();
  if (force) {
    if (bgTasksChangedTimer) {
      clearTimeout(bgTasksChangedTimer);
      bgTasksChangedTimer = null;
    }
    bgTasksChangedLastSentAt = now;
    mainWindow.webContents.send('background-tasks-changed');
    return;
  }
  var wait = BG_TASKS_CHANGED_MIN_INTERVAL_MS - (now - bgTasksChangedLastSentAt);
  if (wait <= 0) {
    bgTasksChangedLastSentAt = now;
    mainWindow.webContents.send('background-tasks-changed');
    return;
  }
  if (bgTasksChangedTimer) return;
  bgTasksChangedTimer = setTimeout(function () {
    bgTasksChangedTimer = null;
    bgTasksChangedLastSentAt = Date.now();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('background-tasks-changed');
    }
  }, wait);
}

function getThumbBackfillConcurrency() {
  ensureSettingsShape();
  return settings.thumbBackfillConcurrency;
}

function getEffectiveThumbBackfillConcurrency() {
  if (previewPlaybackActive) return 1;
  return getThumbBackfillConcurrency();
}

/**
 * 读原图的宽高（回填 `photos.width` / `photos.height`）。
 *
 * 为什么由补全任务承担：两阶段导入时 `scanner.js` 的 `GENERATE_THUMBNAILS_DURING_SCAN = false`
 * 整块跳过了元数据提取，而补全任务只写缩略图与 dHash —— 于是存量库里 `width` / `height`
 * 绝大多数是 **0 而不是 NULL**。本任务本来就要把这个文件用 sharp 打开一次
 * （`computeDhash` 甚至是整图解码），顺手读一次文件头是**零额外磁盘 I/O**。
 *
 * 🔴 不补尺寸不是「少了个字段」那么轻：`_sqlBackfillPendingExpr()` 把
 *    `width IS NULL OR width = 0` 算作待补条件，所以**只缺尺寸的行会永远留在候选集里** ——
 *    每一轮补全都重走一遍全库，且因为要重算 dHash 而把每张图整图解码。
 *    这正是 `database.js` 那条注释预警的「静默空转」。
 *
 * ⚠️ sharp 的 `metadata()` 读的是**输入图头部**，与后续 pipeline 无关，拿到的就是原图宽高。
 *    千万不要改用 `toBuffer()` 返回的 `info.width/height` —— 那是**输出（缩略图）**的尺寸，
 *    会把整库分辨率写错，而且不报任何错。
 * ⚠️ 传入的必须是**还没挂 pipeline** 的实例；读完可以继续用同一实例生成缩略图，文件只打开一次。
 * ⚠️ 任何失败（损坏文件、不支持的格式、无头的图）一律静默返回 null：绝不能影响缩略图与 dHash 主流程。
 *
 * @param {*} instance 已构造但未挂 pipeline 的 sharp 实例（可为 null）
 * @returns {Promise<{width:number,height:number}|null>}
 */
/**
 * 读一次**文件头**：同一个 `sharp.metadata()` 同时给出**原图尺寸**与**拍摄参数**。
 *
 * 为什么要合并成一次：`metadata()` 只读文件头（不解码像素），几乎是零成本，而
 * 「原图尺寸」与「拍摄参数」本来就装在同一段 EXIF/头部字节里 —— 分两次调用就是同一个文件
 * 被打开两次。补全任务本来就为这两个目的各要读一次，合并后**每张图片只开一次文件**。
 *
 * 🔴 返回值有三态，调用方**必须**区分：
 *   · `null`  —— 连文件头都读不到（文件已不在磁盘 / 损坏 / sharp 不认这个格式）。
 *     ⇒ **不许**写 `exif_mtime` 标记：这是「没看到文件」，不是「看过了没有 EXIF」。
 *       标了就等于把一次读盘失败永久当成结论，而且与 dHash 那边「失败留空、下轮重试」的口径不一致。
 *   · `{ width: 0, height: 0, exif: … }` —— 文件读到了，只是拿不到这两样（或本来就没有 EXIF）。
 *     ⇒ 尺寸照旧不写（`width > 0` 才落地），EXIF 标记照写。
 *
 * 🔴 尺寸只认**正数**：`0` / `null` 一律视为「读不到」。把这个 0 写进 `photos.width`
 *    会把整库分辨率覆盖成 0（尺寸是原图的，不是缩略图的 —— 不许改用 `toBuffer` 的 info）。
 */
async function readHeaderMeta(instance) {
  if (!instance) return null;
  try {
    var meta = await instance.metadata();
    if (!meta) return null;
    return {
      width: meta.width > 0 ? meta.width : 0,
      height: meta.height > 0 ? meta.height : 0,
      exif: extractExifFields(meta),
    };
  } catch (e) {
    // 读不到头部不影响缩略图。不写日志：损坏文件往往是批量导入的，会把日志刷爆。
    void e;
    return null;
  }
}

/**
 * 用 sharp 包一个「能读这个文件」的实例（libvips 读不了的格式先在共用模块里解成像素）。
 *
 * 抽出来是因为主进程里**两处**都要用：缩略图分支与「已有缩略图、只补尺寸/EXIF」的
 * `skipThumbnail` 分支。各写一份必然漂移 —— 而漂移的症状是
 * 「同一张图，走哪条分支决定读不读得到尺寸」。
 *
 * ⚠️ 实现（哪些扩展名抢跑、抠出来的东西怎么喂 sharp）**唯一来源**
 *    `src/main/sharp-input.js`，网页端用的是同一份。
 *
 * @returns {Promise<{instance:*, own:(object|null)}>}
 */
function createSharpInput(filePath, buf) {
  return loadSharpInput().createSharpInput(filePath, buf);
}

/**
 * 把「自己解出来的拍摄参数」并进 `header`。
 * 只有 `own.exif` 存在（老式 RAW 走容器 IFD）才需要 —— 内嵌预览段本身不带 APP1/EXIF。
 * ⚠️ 判据用 `!hasAnyExifField(...)` 而不是 `!header.exif`：后者可能是**空字段对象**。
 */
function mergeOwnExif(header, own) {
  if (!own || !own.exif) return header;
  if (!header) return { width: own.width || 0, height: own.height || 0, exif: own.exif };
  if (!hasAnyExifField(header.exif)) header.exif = own.exif;
  return header;
}

/**
 * 共享读取：把整个文件读进内存，供 sharp 解码与 SHA-256 **共用同一份字节**。
 *
 * 🔴 **两个调用方**（补全 `runRowsWithThumbConcurrency` 与重跑 `regenerateRowsWithConcurrency`）
 *    共用这一份实现 —— 它原来写在补全那个函数**内部**，2026-10-08 重跑也要用，
 *    于是提到模块作用域。提出来而不是抄一份，理由与 `pushFailedPath` 那类一样：
 *    这个函数的契约（**读不到时返回 null 而不抛**）是「文件读不到就不许盖失败章」
 *    那条红线的落点，各写一份迟早漂开，而漂开的后果不对称（多盖一次 = 把整个图库的
 *    补全永久挡在候选集外且不自愈）。
 *
 * 🔴 读不到时返回 `null` 而**不抛**：调用方会退回「按路径」，由那条路去决定要不要记失败。
 *    直接抛会把「文件已不在磁盘上」记成一次**缩略图失败**，而失败清单是给用户导出核对的
 *    —— 那些行本来就该由 `invalid-cleanup` 删掉，不该混进「缩略图生成失败」里。
 *    （与查重那边 `kind: 'missing'` 记 `skippedMissing` 而不是 `failed` 同一个口径。）
 */
async function tryReadShared(filePath) {
  try {
    return await fs.promises.readFile(filePath);
  } catch (eRead) {
    void eRead;
    return null;
  }
}

/**
 * 对一批待补全记录做有限并发处理（共享队列 + N 个 worker 协程）。
 */
async function runRowsWithThumbConcurrency(rows, yieldEvery) {
  var n = rows.length;
  if (n === 0) return;
  var conc = Math.min(getEffectiveThumbBackfillConcurrency(), n);
  var next = 0;

  /**
   * 把一条路径记进「失败清单」（用户可导出核对）。
   *
   * ⚠️ 抽成函数不是为了复用一行代码，是为了**避开 `no-redeclare`**：两处原本各自写
   *    `var fpe = row.file_path || '';`，而 `var` 是**函数作用域**（不是块作用域）——
   *    同一个 `processOne` 里出现两次就直接踩 lint error（2026-10-06 真踩到，基线是 0 error）。
   *    用 `var` 改 `let` 能骗过 lint，但那会让这两块的行为依赖「谁先执行」，反而更脆。
   *
   * ⚠️ 上限只挡新条目，满了之后后面的失败**不再记录**（用户实机 33.9 万缺口，无上限会撑爆内存）。
   *
   * ⚠️ **同一路径可能被记两次**：一行可以先「缩略图生成失败」（内层 catch）、
   *    再「元数据写入失败」（外层 catch），两处都会调这里。这是刻意的 ——
   *    导出清单给用户看的是「这行出过问题」，重复项无害且能看出它错了两件不同的事。
   */
  function pushFailedPath(filePath) {
    if (thumbnailBackfill.failedPaths.length >= THUMB_BACKFILL_FAILED_PATHS_MAX) return;
    var p = filePath || '';
    if (p) thumbnailBackfill.failedPaths.push(p);
  }

  /**
   * 「这个文件**此刻确实读得到**」—— 决定要不要盖失败章的唯一判据。
   *
   * 🔴 两个盖章点（`recordThumbFailure` / `recordHeaderFailure`）**必须共用这一份实现**：
   *    它是「文件读不到就不许盖章」这条红线的唯一落点，各写一份迟早漂开，
   *    而漂开的后果不对称 —— 多盖一次是**灾难**（外接盘没插的那段时间，把整个图库的
   *    补全永久挡在候选集外，且不会自愈：标记只在 `date_modified` 变了才失效，
   *    而盘没插时扫描同样读不到新日期），少盖一次只是多重试几轮。
   *
   * 判据优先用「共享读取有没有拿到字节」（`sharedBuf` 非空即文件在）；没走共享读取的
   * （超大文件 / 视频）才退回一次 `existsSync`。失败路径上多一次 stat 可以接受：
   * 量级是每轮个位数，而读不了的 `.CR2` 每个 18 MB —— 那才是原本被浪费掉的大头。
   */
  function fileReachableForFailureStamp(row, sharedBuf) {
    if (sharedBuf) return true;
    try {
      return fs.existsSync(row.file_path);
    } catch (eStat) {
      void eStat;
      return false;
    }
  }

  /**
   * 缩略图生成失败之后的收尾：决定要不要盖「试过失败」章（`photos.thumb_fail_mtime`）。
   *
   * 🔴 判据是「**文件读得到但做不出图**」，不是「失败了」：
   *    文件根本读不到的（外接盘没插、已被删除）**不许**盖章 ——
   *    ① 那是 `invalid-cleanup` 的活，不该混进「缩略图生成失败」；
   *    ② 盖了就是灾难（见 `fileReachableForFailureStamp` 的注释）。
   *    这跟 `readHeaderMeta()` 里「没读到文件头就不许写 `exif_mtime`」是同一条约定。
   */
  async function recordThumbFailure(row, err, sharedBuf) {
    if (!fileReachableForFailureStamp(row, sharedBuf)) {
      logger.warn(
        '[thumb-backfill] source file unreachable, kept in candidate set for invalid-cleanup:',
        row.file_path,
        err && err.message ? err.message : err,
      );
      return;
    }
    try {
      db.markThumbFailed(row.id, row.date_modified);
    } catch (eMark) {
      logger.warn(
        '[thumb-backfill] mark thumb_fail_mtime failed:',
        row.file_path,
        eMark && eMark.message ? eMark.message : eMark,
      );
    }
  }

  /**
   * 读不出**文件头**之后的收尾：决定要不要盖「试过失败」章（`photos.header_fail_mtime`）。
   *
   * 🔴 为什么需要第二个盖章点（2026-10-06，用户报「待补数是否要相应变动」时挖出来）：
   *    `thumb_fail_mtime` 只门住了候选谓词的**第一支**（缺缩略图），**第二支一个都不认它**
   *    （第二支判的是 `dhash` / `width` / `exif_mtime` / `exif_ver`）。而读不了的文件正好
   *    `width = 0` / `dhash = NULL` / `exif_mtime = NULL` ⇒ 它们**从第一支漏进第二支**，
   *    照样每轮被取出、每轮重读一遍原文件，候选集规模（进度主分母）也因此永远归不了零。
   *    真库实测：9 个 18 MB 的 `.CR2` + 1 个截断 JPEG，**10/10 命中第二支**（约 162 MB/轮）。
   *
   * 🔴 判据与 `recordThumbFailure` **逐条相同**（同一个「文件读得到」闸门，同一个自愈规则）：
   *    只在「文件读得到、但读不出文件头」时盖章 —— 盘没插时盖章会把尺寸与拍摄参数的补全
   *    永久挡掉且不自愈（理由见 `fileReachableForFailureStamp`）。
   *
   * ⚠️ 与 `thumb_fail_mtime` 的分工**不能混**：`readHeaderMeta()` 读不出头时返回 `null`，
   *    但它**内部已经吞掉了异常**，所以「头读不出」不会走到 `catch (eThumb)` —— 那两个章
   *    是两件独立的事，别指望一个能替另一个盖。
   */
  async function recordHeaderFailure(row, sharedBuf) {
    if (!fileReachableForFailureStamp(row, sharedBuf)) {
      logger.warn(
        '[thumb-backfill] source file unreachable, kept in candidate set for invalid-cleanup (header):',
        row.file_path,
      );
      return;
    }
    try {
      db.markHeaderFailed(row.id, row.date_modified);
    } catch (eMark) {
      logger.warn(
        '[thumb-backfill] mark header_fail_mtime failed:',
        row.file_path,
        eMark && eMark.message ? eMark.message : eMark,
      );
    }
  }

  async function processOne(row) {
    if (thumbnailBackfill.cancelled) return;
    thumbnailBackfill.currentFile = row.file_path || '';
    var isVideo = isVideoPath(row.file_path);
    var skipThumbnail = row.has_thumbnail === 1;
    // 已经有原图尺寸就不必再读文件头。⚠️ 库里缺尺寸存的是 0 而不是 NULL，两个条件都要判。
    var needSize = !isVideo && !(row.width > 0 && row.height > 0);
    // ⚠️ dHash 已存在时**必须跳过**：这行之所以进候选集可能只是因为缺 width/height，
    //    重算一遍等于白做一次整图解码（`computeDhash` 比读文件头贵几个数量级）。
    //    判据只在这里算一次，下面缩略图分支与写库分支共用。
    var needDhash = !isVideo && !(row.dhash && String(row.dhash).trim());
    // 缩略图分支已经把这个文件解码过了 ⇒ dHash 白用那次解码，不再重开一次文件。
    // `dhashDecodeUsed` 是「试过了」的标志（结果可能是 null = 解码失败），不能用结果本身判。
    var dhashFromDecode = null;
    var dhashDecodeUsed = false;
    // 拍摄参数（EXIF）：判据**一律走 `db.photoNeedsExif()`**，不许在这里手写。
    // 🔴 手写 `!(row.exif_mtime && String(row.exif_mtime).trim())` 只判了**一个**标记列，
    //    而候选谓词 `_sqlNeedsExifExpr()` 判的是**两个**（`exif_mtime` + `exif_ver`）。
    //    两者一漂开就是一条静默死路：老口径跑过的行**每轮被取出来**（谓词说该补）、
    //    **每轮被判「不需要读」而跳过**（这里说不用补）、原样写回 ⇒
    //    它永远拿不到新扩出来的列，候选集也永不收敛。
    //    本机真实库实测（2026-10-06 12:23）：旧口径跑过的 9,799 行全在这条死路上，
    //    `exif_ver` 一行未写。判据只留一份，改口径时两边自动同步。
    //    ⚠️ `row.exif_ver` 由 `getPhotosMissingThumbnailsBefore()` 的 SELECT 带出来 ——
    //      少取那一列，这里就会把「旧版看过」误判成「已看过」。
    var needExif = !isVideo && db.photoNeedsExif(row);
    // 文件头读**一次**的产物：`{ width, height, exif }`。
    // 用 `header` 而不是拆成 sizeInfo / exif 两份：尺寸与拍摄参数本来就来自同一个
    // `sharp.metadata()`，拆开写必然会有人再调一次（同一个文件被打开两遍）。
    // ⚠️ `null` 表示**连文件头都没读到**（文件不在 / 损坏 / 格式不认）——
    //    这时不许写 `exif_mtime` 标记，理由见 `readHeaderMeta()`。
    var header = null;
    // 「**试过**读文件头」的标志。与 `header` 分开是必须的：`header === null` 也可能是
    // 「压根不需要读」（尺寸与 EXIF 都齐了）⇒ 只看 `header` 会把没试过的行也盖成失败章，
    // 而那是**永久**排除（除非文件又变了）。判据只用 `(needSize || needExif)`。
    var headerTried = false;
    // 🔴 查重指纹（SHA-256）读的是**同一个文件的同一份字节**。而缩略图补全与查重
    //    在准入上互斥（`thumbnailBackfillBlockReason` / `duplicateHashBlockReason` 互相拦截）
    //    ⇒ 两者永远串行，不合并就是同一份字节被完整读两遍 —— 在这块 USB 外接机械盘上纯属白烧。
    //    合并后**一次读盘同时出缩略图 / dHash / SHA-256**。
    //    只对「同时缺 file_hash」的行生效（即与查重候选集的重叠部分），候选谓词不动。
    //    ⚠️ 判据必须用 `row.file_hash`（SELECT 里带着它），拿不到就会每行都重算一遍。
    var needHash = !isVideo && !(row.file_hash && String(row.file_hash).trim());
    // 共享读取 = 整份进内存；超大 / 大小未知的文件退回「各读各的」老路径
    //（见 THUMB_SHARED_READ_MAX_BYTES 的注释：宁可多读一遍，也不要把并发峰值撑爆）
    var shareRead = needHash && row.file_size > 0 && row.file_size <= THUMB_SHARED_READ_MAX_BYTES;
    var sharedBuf = null;
    try {
      if (skipThumbnail) {
        // 已有缩略图：不重新生成，只补原图尺寸
        thumbnailBackfill.success++;
        // 这一行也可能只需要 SHA-256（缩略图与 dHash 都在、只缺指纹的那部分）：
        // 照样只读一次，不必让查重任务回头把同一个文件再读一遍。
        if (shareRead) sharedBuf = await tryReadShared(row.file_path);
        // 🔴 文件头与 dHash **共用同一个 sharp 实例**（2026-10-07）。
        //
        //    旧写法在这里建实例**只为了读头**，下面 `needDhash` 又调 `computeDhash(row.file_path)`
        //    按路径**重新打开**文件并整图解码 —— 同一份字节读**两遍**。
        //    而这一支恰恰是补全里行数最多的那一大批（真库实测第二支候选 **1,044,733** 行，
        //    几乎全部 `has_thumbnail = 1`），「多余的那次读盘」被乘在这个量级上。
        //    真机 30 张（0.1 MB~50 MB，含 GIF / PNG）实测：18,740 ms → 5,551 ms，**省 70%**。
        //
        //    ⚠️ 建实例的**条件必须把 `needDhash` 一起算进来**：只写 `(needSize || needExif)` 时，
        //       「只缺 dHash、尺寸和 EXIF 都齐了」的行根本拿不到实例 ⇒ 优化等于没做，
        //       而且不报错、不写日志，只是「读了两遍」照旧（本趟里这类行占多数）。
        //    ⚠️ 顺序沿用缩略图分支那一条：**先读头再取 dHash**，且两者都不上 `.rotate()`
        //       —— dHash 历来不旋转，两条路必须是同一套位。
        if (needSize || needExif || needDhash) {
          // 这一支也可能碰上 libvips 读不了的格式（例如 .bmp 那批历史遗留缩略图），
          // 走同一个入口 ⇒ 尺寸 / 拍摄参数照样能补上。
          var siSkip = await createSharpInput(row.file_path, sharedBuf || null);
          if (needSize || needExif) {
            headerTried = true;
            header = mergeOwnExif(await readHeaderMeta(siSkip.instance), siSkip.own);
          }
          if (needDhash) {
            dhashFromDecode = await computeDhashFromPipeline(siSkip.instance);
            dhashDecodeUsed = true;
          }
        }
      } else {
        // 🔴 缩略图生成**单独一层 try**（2026-10-06）：它失败不许把下面几件事一起带走。
        //    尺寸与拍摄参数来自 `readHeaderMeta()`，而那一步只读文件头（`metadata()`），
        //    在解码**之前**就已经拿到手了。旧写法让一次 `toBuffer()` 异常把到手的数据一起丢
        //    —— 本机实测那个被截断的 JPEG：`metadata()` 明明读出了 4608x3456 + 9,687B EXIF，
        //    却因为解码失败一样都没写进库，于是**每一轮都白读 1.15 MB、每一轮都丢一次**。
        //    框在这里之后，失败的行照样能补上尺寸 / 拍摄参数 / dHash / 指纹，
        //    并靠 `thumb_fail_mtime` 退出候选集，不再无限重试。
        try {
          var topts = getThumbOptions();
          var thumb;
          if (isVideo) {
            thumb = await extractVideoThumbnailWithFfmpeg(row.file_path, topts);
            if (!thumb) {
              thumb = await buildVideoPlaceholderThumbnail(topts);
            }
          } else {
            // ⚠️ 用同一个 sharp 实例：先取原图尺寸（只读文件头、几乎零成本）再走 pipeline，
            //    文件只打开一次。两者**顺序不能颠倒**。
            // 🔴 共享读取时把**同一份 Buffer** 交给 sharp：sharp 从内存解码、不会再读盘。
            //    下面三样产物（原图尺寸 / dHash / 缩略图）与「按路径解码」必须逐位相同 ——
            //    同一段字节、同一组算子，回归脚本对两条路做逐位比对。
            if (shareRead) sharedBuf = await tryReadShared(row.file_path);
            // 🔴 libvips 读不了的格式（bmp / ico / pnm / tga / qoi / dib、老式 CR2）先自己
            //    解成像素再包成 sharp 实例 —— 这样下面「尺寸 / dHash / 缩略图」三样
            //    **一行都不用改**（它们本来就只认一个 sharp 实例），也就不会出现
            //    「两条路算出不同结果」。
            var si = await createSharpInput(row.file_path, sharedBuf || null);
            var instance = si.instance;
            if (needSize || needExif) {
              headerTried = true;
              header = mergeOwnExif(await readHeaderMeta(instance), si.own);
            }
            // 🔴 dHash 必须取在 `.rotate()` **之前**：dHash 历来是不旋转的（旧路径
            //    `computeDhash(row.file_path)` 就没有 `.rotate()`），带 EXIF 方向的图片
            //    一旦先旋转再算，位会全变 —— 而 dHash 是相似聚类的输入，位差会翻面。
            if (needDhash) {
              dhashFromDecode = await computeDhashFromPipeline(instance);
              dhashDecodeUsed = true;
            }
            // 🔴 「缩放 + 编码」收在 `resizeThumb()` 里（`rotate()` 也在那边）：格式换了只改
            //    `thumb-format.js#THUMB_ENCODE_FORMAT` 一处，记录进库的 `thumb_format`
            //    与下面写库时用的值是同一个常量，不会出现「字节是 A、记录写着 B」。
            thumb = await resizeThumb(instance, topts.size, topts.quality);
          }
          db.updatePhotoThumbnail(row.id, thumb, {
            size: topts.size,
            format: THUMB_ENCODE_FORMAT,
          });
          thumbnailBackfill.success++;
          // 进度条的**分子**：只有真写出了缩略图的行才计入。上面 `skipThumbnail` 那一支
          // （早就有图、只是来补尺寸 / 指纹 / 拍摄参数的）**不计** —— 计入就会让分子追上
          // 甚至反超分母。放在 `updatePhotoThumbnail` 之后：写库抛异常的行不算已补。
          thumbnailBackfill.thumbs++;
        } catch (eThumb) {
          thumbnailBackfill.failed++;
          pushFailedPath(row.file_path);
          await recordThumbFailure(row, eThumb, sharedBuf);
        }
      }
      // 原图尺寸惰性回补：只在拿到正尺寸时写 —— 库里已有真实值时不许被覆盖成 0
      if (header && header.width > 0 && header.height > 0) {
        db.updatePhotoDimensions(row.id, header.width, header.height);
        thumbnailBackfill.sized++;
      }
      // 拍摄参数：与尺寸共用**同一次** metadata 读盘（`header.exif`），这里不再碰盘。
      // 🔴 只有**读到了文件头**才写标记：`header === null` 是「没看到文件」（已不在磁盘 /
      //    损坏 / 格式不认），不是「看过了、没有 EXIF」。把一次读盘失败标成「已检查」，
      //    这行就永远不会再尝试 —— 而且与 dHash 那边「失败留空、下轮重试」的口径不一致。
      if (needExif && header) {
        db.updatePhotoExif(row.id, header.exif, row.date_modified);
        thumbnailBackfill.exifChecked++;
        if (hasAnyExifField(header.exif)) thumbnailBackfill.exifFilled++;
      }
      // 文件头读不出来 ⇒ 盖「试过、读不出头」章，让它退出候选谓词**第二支**里的
      // 「缺尺寸 / 缺拍摄参数」两项（见 `recordHeaderFailure` 的注释）。
      // 🔴 判据是「**试过**、且没拿到**可用尺寸**」，不是 `header === null`：
      //    `metadata()` 成功但报不出正尺寸的（极端格式）同样补不上 `width`/`height`，
      //    只看 null 会让它永久留在候选集里（`width IS NULL OR width = 0` 恒真）。
      //    ⚠️ 这一支**必须**在缩略图 try/catch **之后**：CR2 那条路上
      //    `readHeaderMeta()` 自己吞掉异常返回 null，根本走不到 `catch (eThumb)`，
      //    两个章是两件独立的事（一个管解码路、一个管文件头路）。
      //    而且 `header` 是异常**之前**就赋的值，所以这里读到的一定是本轮的真实结果。
      if (headerTried && !(header && header.width > 0 && header.height > 0)) {
        await recordHeaderFailure(row, sharedBuf);
      }
      // 同步计算 dHash（仅图片，文件系统缓存大概率还热着）
      if (needDhash) {
        try {
          // 缩略图分支已经把这个文件解码过 ⇒ 直接用它的结果；第二趟（`skipThumbnail`）
          // 也复用了 `siSkip` 那一个实例，同样白用那次解码。
          //
          // ⚠️ 判据必须**同时**看标志位与结果：`dhashDecodeUsed` 只说明「试过了」，
          //    结果可能是 `null`（解码失败）。只认标志位 ⇒ 那些行连「按路径再试一次」的机会都没有，
          //    直接被记成永久失败。真机实测就有这样的样本：某张动图在「已开实例的 pipeline」上算不出、
          //    在 `computeDhash(row.file_path)` 那条路上算得出。⇒ 必须**先看结果**，空了再退回老路。
          var dhash =
            dhashDecodeUsed && dhashFromDecode
              ? dhashFromDecode
              : await computeDhash(row.file_path);
          if (dhash) {
            db.updatePhotoDhash(
              row.id,
              dhash,
              getDhashBuckets(dhash),
              row.date_modified,
              row.file_size,
            );
            thumbnailBackfill.dhashed++;
          } else {
            // 🔴 「试过、算不出哈希」也要盖章（2026-10-06 补）。
            //    `computeDhash` / `computeDhashFromPipeline` 的失败语义是**返回 null、
            //    从不抛**（见 `perceptual-hash.js`）⇒ 这一支既不抛异常、也没有日志：
            //    不盖章的话，这一行会永远留在候选谓词第二支的「缺 dHash」那一项里。
            //    本机那个截断 JPEG 就是这么留在候选集里的（它解码失败 ⇒ dhash 恒 null，
            //    而它的尺寸与 EXIF 都补齐了，所以第一支与第二支的另外两项都拦不住它）。
            //    ⚠️ 章的语义是「**解码**这一路失败」——与 `thumb_fail_mtime` 的定位一致，
            //       与其「缩略图失败」的字面名不同；两个标记载荷同一路失败，共用
            //       `_sqlFailMarkerRetryableExpr()` 的自愈规则。
            logger.warn('[thumb-backfill] dHash unusable (decode failed) for:', row.file_path);
            await recordThumbFailure(row, null, sharedBuf);
          }
        } catch (eDhash) {
          logger.warn(
            '[thumb-backfill] dHash failed for:',
            row.file_path,
            eDhash && eDhash.message,
          );
        }
      }
      // 查重指纹：与上面共用同一次读盘。
      // 🔴 有 `sharedBuf` 就直接对内存算，**这一行不再碰盘**；没有（超大 / 大小未知的文件）
      //    才走流式 `hashFileSha256` —— 与查重任务内部那条路径语义一致，摘要逐字符相同。
      if (needHash) {
        try {
          var digest = sharedBuf
            ? hashBufferSha256(sharedBuf)
            : await hashFileSha256(row.file_path, function () {
                return thumbnailBackfill.cancelled;
              });
          if (digest) {
            db.updatePhotoHash(row.id, digest, row.date_modified, row.file_size);
            thumbnailBackfill.hashed++;
          }
        } catch (eHash) {
          logger.warn(
            '[thumb-backfill] SHA-256 failed for:',
            row.file_path,
            eHash && eHash.message,
          );
        }
      }
    } catch (e) {
      thumbnailBackfill.failed++;
      pushFailedPath(row.file_path);
    }
    thumbnailBackfill.done++;
    if (thumbnailBackfill.done % yieldEvery === 0) {
      emitBackgroundTasksChangedThrottled(false);
      await new Promise(function (resolve) {
        setImmediate(resolve);
      });
    }
  }

  async function worker() {
    while (true) {
      if (thumbnailBackfill.cancelled) return;
      var i = next++;
      if (i >= n) return;
      await processOne(rows[i]);
    }
  }

  var workers = [];
  for (var w = 0; w < conc; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

/**
 * 缩略图补全的准入判据 —— **IPC 入口（`start-thumbnail-backfill`）与任务内部共用这一处**。
 *
 * 🔴 为什么必须只有一份（2026-10-06 用户报「补齐缩略图点击之后不开始」的根因）：
 * 过去 IPC handler 只查 `optimizeTaskRunning` / `isFolderScanRunning()` /
 * `thumbnailBackfill.running` 三条，而 `runThumbnailBackfill()` 内部**多一条**
 * `duplicateHashTask.running`。于是当「重复文件比对」正跑着（逐文件算 SHA-256，小时级）时：
 * 三道闸全过 → IPC 返回 `{ success: true }` → 前端**不弹任何提示** →
 * 任务在 `setTimeout` 里立刻 `return { started: false, reason: 'maintenance' }`，
 * 而这个返回值**被丢弃**（调用点只挂 `.catch`）→ 界面刷新后显示「未运行」。
 * 用户看到的就是**点下去什么都没发生**；而这几条拒绝日志都是 `logger.log`（info），
 * 生产档级别是 `warn` ⇒ 连一行现场都没有。
 *
 * 判据刻意不含 `dbWriteQueue.isBusy()`：回填 / 重复哈希是**按批次**入队的，
 * 队列「批间空、批中满」→ 拿它当「库被长期占用」的信号会抖成「有时能启动、
 * 有时被静默跳过」，而自动回填那条路径不会重试，跳过就等于永久漏掉。
 * 这里只挡真正的长期占用者；队列里的短任务（thumbnail-fix / deferred-index / FTS）
 * 不拦启动 —— 本函数的批次自然会排队等它们，串行由队列保证。
 *
 * 🔴 新增拦截条件时**只能加在这里**，IPC 与任务内部会自动同步。
 *
 * @returns {string} 空串 = 放行；否则是可直接展示给用户的原因
 */
function thumbnailBackfillBlockReason() {
  if (optimizeTaskRunning) return '数据库维护进行中';
  if (isFolderScanRunning()) return '扫描进行中，请稍后再试';
  // 缩略图补全与重复比对都要把整文件读一遍、抢的是同一块盘（本机 K:/G: 是外接机械盘），
  // 同时跑只会互相拖慢；谁先谁后交给用户决定。
  if (duplicateHashTask.running) return '重复文件比对进行中，请稍后再试';
  if (thumbnailBackfill.running) return '补全已在进行中';
  // 与「全量重跑」**双向**互斥（那边也挡这里）：两者都要读完整文件、抢同一块盘。
  // 单向挡会留下「先起重跑、再起补全」的窗口。
  if (thumbnailRebuild.running) return '缩略图重建进行中，请稍后再试';
  return '';
}

async function runThumbnailBackfill(limit) {
  const blockReason = thumbnailBackfillBlockReason();
  if (blockReason) {
    // warn 级：被拒绝/被跳过正是最需要留现场的事件（用户只会说「点了没反应」）
    logger.warn('[runThumbnailBackfill] skipped: ' + blockReason);
    return { started: false, reason: blockReason };
  }
  const taskStart = Date.now();
  logger.log('[runThumbnailBackfill] task started, limit=', limit);
  if (thumbnailBackfill.running) {
    logger.log('[runThumbnailBackfill] already running, exiting');
    return { started: false, reason: 'running' };
  }
  thumbnailBackfill.running = true;
  thumbnailBackfill.cancelled = false;
  thumbnailBackfill.done = 0;
  thumbnailBackfill.success = 0;
  thumbnailBackfill.failed = 0;
  thumbnailBackfill.hashed = 0;
  thumbnailBackfill.sized = 0;
  thumbnailBackfill.dhashed = 0;
  thumbnailBackfill.exifChecked = 0;
  thumbnailBackfill.exifFilled = 0;
  thumbnailBackfill.currentFile = '';
  thumbnailBackfill.failedPaths = [];
  thumbnailBackfill.startedAt = Date.now();
  // 本轮身份：异步统计靠它对身份（见 countPendingThumbnailsForProgress / countPendingCandidatesForProgress）
  thumbnailBackfill.runToken++;
  thumbnailBackfill.fetched = 0;
  thumbnailBackfill.thumbs = 0;
  // 主分母先置空、phase 置 'counting'：UI 会显示「正在估计待补数量…」而不是 `0 / 0`。
  // 🔴 绝不能拿一个假的分母起跑（比如把 0 当分母）—— 那会让进度条在统计完成前的
  //    那段时间里显示 0%，与「统计失败」无法区分。
  thumbnailBackfill.pendingTotal = null;
  thumbnailBackfill.pendingPhase = 'counting';
  // 副指标（**当前**还缺预览图数）：
  //  ⚠️ 这里置空的是**基线**，不是 UI 上那个数 —— UI 画的是 `currentPendingThumbTotal()`
  //     派生出来的实时值，基线为 null 时它返回 0 ⇒ UI 只说「预览图 +N 张」，不说「还缺 0」。
  //  ⚠️ `thumbTotalBaseThumbs` 必须一起归零：它是「取基线那一刻的 thumbs」，跨轮残留会让
  //     新一轮的派生值从一个错误的高度起算（见该字段的注释）。
  thumbnailBackfill.thumbTotal = null;
  thumbnailBackfill.thumbTotalBaseThumbs = 0;
  // 节流闸门复位：上一轮结束后 `thumbTotalRefreshedAt` 停在旧时刻，不复位就会
  // 让新一轮的**第一次**周期刷新提前触发（甚至与初始那一次叠在一起）。
  thumbTotalRefreshedAt = Date.now();
  emitBackgroundTasksChangedThrottled(true);
  logger.log('[runThumbnailBackfill] state initialized');

  try {
    // 🔴 两个计数 + 副指标节拍器必须在**要写闸门之前**发起（2026-10-06 修）。
    //
    // 起因：面板上「正在估计待补数量…」长时间一动不动 —— 它是 `pendingPhase = 'counting'`
    // 画上去的，而**真正的估计**过去排在下面那句 `await dbWriteQueue.run('thumbnail-backfill')`
    // **之后**才发起。写闸门被长任务占着时（真库实测：`deferred-index` 建 7 条索引，独占
    // 6 分钟以上），这一段 await 就把估计永远挡在门外 ⇒ 面板既不显示分母、也不显示副指标，
    // 看起来像任务坏了。而这两个计数走的是**只读连接**，与写闸门本来就无关
    // （WAL 下读不被写阻塞），没有任何理由排在它后面。
    //
    // 顺序上仍满足「初始计数先盖时间戳、节拍器后起」：三条语句之间无 await。
    var thumbCountPromise = countPendingThumbnailsForProgress();
    var pendingCountPromise = countPendingCandidatesForProgress();
    // 副指标「还缺 M」的**主节拍**：1 s 滴答 + 5 s 节流 ⇒ 约 5 s 一跳，与批次边界解耦。
    // ⚠️ 起得太早只会白发一次（被节流挡住），所以放在初始计数之后；起在 `try` 内是因为
    //    收尾只在 `finally` 里清 —— 中途抛异常（含下面等闸门时被取消）也能停掉。
    startPendingThumbRefreshTicker();

    // 先确保 dhash 列和 LSH 表已创建。DDL 也要走队列：它同样写库、同样需要独占写锁，
    // 而且一旦与启动期的迁移任务并行，就是两边互相等 timeout。
    // 回填是**建性能索引**（INDEX）：晚做只是慢，该给修复类与用户手动操作让路。
    //
    // 🔴 `ensureDuplicateHashSchema()` 也**必须在这里**，不是「顺手加的」：下面第一次
    //    `getPhotosMissingThumbnailsBefore()` 的 SELECT 列表里就带着 `file_hash`，
    //    而它和 `dhash` 一样是**延迟迁移列** —— 老库上少任何一个，取批那一刻就是
    //    `no such column`，整个回填当场挂掉。⚠️ 这条 SELECT 的列表与本处必须**同生共死**。
    await dbWriteQueue.run(
      'thumbnail-backfill',
      function () {
        if (typeof db.ensureDhashSchema === 'function') db.ensureDhashSchema();
        if (typeof db.ensureDuplicateHashSchema === 'function') db.ensureDuplicateHashSchema();
      },
      { priority: PRIORITY.INDEX },
    );

    // 让出多次事件循环，让 UI 先更新状态再开始，避免启动就卡死
    logger.log('[runThumbnailBackfill] yielding for UI update');
    const yieldStart = Date.now();
    await yieldForPreviewPlaybackMs(50);
    await yieldForPreviewPlaybackMs(50);
    logger.log('[runThumbnailBackfill] yielded after', Date.now() - yieldStart, 'ms');

    // ⚠️ 上面两个 promise 在主循环之后必须被 await（与查重任务 `await totalPromise` 同一条
    //    策略）：短任务（只剩几十张）会在统计回来之前跑完，不 await 就是让它和 finally 抢着
    //    写状态。声明位置提前不影响这一点 —— 它们是在 import 之后、主循环之前发起的。

    var batchSize = 100; // 更小批次，保证频繁让出
    var maxToProcess = typeof limit === 'number' && limit > 0 ? limit : null;

    var processedInThisRun = 0;
    // 🔴 倒序补全的游标：起点比 MAX(id) 大一格，否则 id 最大那一行永远扫不到
    //（升序版本对应 `afterId = 0` + 谓词 `id > ?`，同样是「退一格」）。
    // 取 `MAX(id)` 是一次索引定位，代价 O(1)。
    //
    // 🔴 **两条游标，各自独立**（2026-10-06 改成两趟）：
    //    `thumbCursor` = 第一趟，只取 `_sqlNeedsThumbnailExpr()` 命中的行（还缺缩略图的）；
    //    `metaCursor`  = 第二趟，取其余候选（只缺 EXIF / dHash / 尺寸的行）。
    //    为什么必须分开：如果两趟共用一条游标，第一趟起手就把游标拉到「最大的那个缺图 id」
    //    （本机 = 1,889,290，索引倒序扫的第一个命中），第二趟于是**再也取不到它以上的行**
    //    —— 1,889,291~1,981,503 那批的元数据永远补不上。不报错、不写日志，静默丢活。
    var thumbCursor = db.getMaxPhotoId() + 1;
    var metaCursor = db.getMaxPhotoId() + 1;
    /**
     * 当前趟：`'thumbnail'`（先，出图）→ `'metadata'`（后，补元数据）。
     * 暴露给 UI 是为了让「预览图 N 张」为 0 的那段时间**有解释** ——
     * 第二趟本来就不出图，那不是卡住。
     * @type {'thumbnail'|'metadata'}
     */
    var pass = 'thumbnail';
    thumbnailBackfill.pass = pass;
    var yieldEvery = 20;
    logger.log(
      '[runThumbnailBackfill] starting main loop (two-pass: thumbnail -> metadata), batchSize=',
      batchSize,
    );

    while (true) {
      if (thumbnailBackfill.cancelled) {
        logger.log('[runThumbnailBackfill] cancelled, exiting loop');
        break;
      }

      // 交互抢占：用户正在搜图就在这里停下。**必须在入队之前** —— 进了写库队列再等，
      // 等于占着闸门干等，会把别的任务一起堵住。等满上限会自行放行，所以用户狂搜时
      // 回填仍以较低占空比推进，不会被饿死。
      await interactionPreempt.awaitIdle();

      // 查询前先让出，让 UI 完全响应一次
      await yieldForPreviewPlaybackMs(20);
      await yieldForPreviewPlaybackMs(20);

      var fetchLimit = batchSize;
      if (maxToProcess != null) {
        var left = maxToProcess - processedInThisRun;
        if (left <= 0) break;
        fetchLimit = Math.min(batchSize, left);
      }
      const queryStart = Date.now();
      const isThumbPass = pass === 'thumbnail';
      // const 而非 var：下面的批次要在闭包里引用它，块作用域保证每次迭代捕获到的是当轮的值
      const rows = isThumbPass
        ? db.getPhotosLackingThumbnailBefore(thumbCursor, fetchLimit)
        : db.getPhotosMissingThumbnailsBefore(metaCursor, fetchLimit);
      const queryTime = Date.now() - queryStart;
      logger.log(
        '[runThumbnailBackfill] fetched',
        rows.length,
        'rows before id',
        isThumbPass ? thumbCursor : metaCursor,
        '(' + pass + ' pass) in',
        queryTime,
        'ms',
      );

      // 记账：本轮已取出行数。**只进日志**，不再当分母 —— 它是滚动累加的，
      // 拿它当分母会让百分比在 0↔100% 之间锯齿（见 thumbnailBackfill.fetched 的注释）。
      thumbnailBackfill.fetched += rows.length;

      // 查询完成后立即让出，让 UI 更新一次
      await yieldForPreviewPlaybackMs(10);
      emitBackgroundTasksChangedThrottled(true);
      await yieldForPreviewPlaybackMs(10);

      if (rows.length === 0) {
        if (isThumbPass) {
          // 第一趟走完：缺缩略图的行要么补上了、要么盖了失败章 ⇒ 换第二趟补元数据。
          // ⚠️ 这里**不能** break：break 会让「只缺 EXIF / dHash / 尺寸」的那一大批
          //    永远没人补（本轮实测就有十几万行落在这类里）。
          pass = 'metadata';
          thumbnailBackfill.pass = pass;
          logger.log('[runThumbnailBackfill] thumbnail pass drained, switching to metadata pass');
          emitBackgroundTasksChangedThrottled(false);
          continue;
        }
        logger.log('[runThumbnailBackfill] no more rows, exiting loop');
        break;
      }

      if (thumbnailBackfill.cancelled) break;
      const batchStart = Date.now();
      // 🔴 每一批都重新排队，而不是把整轮补全圈在写锁里。启动期的 thumbnail-fix /
      // deferred-index / FTS 是无条件 run() 进队的、看不见 thumbnailBackfill.running，
      // 过去会和这里**同时持写锁**（本函数开头那次快照检查只管启动那一刻）。
      // 按批入队后：批间队列是空的，它们按 FIFO 插进来，天然互斥、天然让位。
      await dbWriteQueue.run(
        'thumbnail-backfill',
        function () {
          return runRowsWithThumbConcurrency(rows, yieldEvery);
        },
        { priority: PRIORITY.INDEX },
      );
      logger.log(
        '[runThumbnailBackfill] processed batch of',
        rows.length,
        'rows in',
        Date.now() - batchStart,
        'ms',
      );
      // 倒序：本批最后一行是**最小** id，游标严格递减 —— 同一轮不会重复取到刚失败的行
      // ⚠️ 两条游标各推各的，别写成一个：第一趟推完 thumbCursor 就换第二趟，
      //    两边都从 MAX(id)+1 起手，第二趟才能重新覆盖高位那批只缺元数据的行。
      if (isThumbPass) thumbCursor = rows[rows.length - 1].id;
      else metaCursor = rows[rows.length - 1].id;
      processedInThisRun += rows.length;

      // 副指标（还缺多少张预览图）按 `THUMB_TOTAL_REFRESH_MS` 节流刷新。
      // 🔴 **不 await**：它是附属读数，不许拖慢主循环；结果自己走 emit 回流到 UI。
      schedulePendingThumbRefresh();

      // 每批处理完多次让出，保证 UI 持续响应
      emitBackgroundTasksChangedThrottled(false);
      await yieldForPreviewPlaybackMs(20);
      await yieldForPreviewPlaybackMs(20);

      logger.log(
        '[runThumbnailBackfill] progress: processed',
        processedInThisRun,
        ', fetched',
        thumbnailBackfill.fetched,
        ', thumbs',
        thumbnailBackfill.thumbs,
      );

      if (maxToProcess != null && processedInThisRun >= maxToProcess) break;
    }

    // 主循环走完再等两个分母：短任务（只剩几十张）会在统计回来之前就跑完，
    // 不在这里收口就是让它与 finally 抢着写状态。计数函数自己吞掉异常，不会抛。
    await thumbCountPromise;
    await pendingCountPromise;

    const totalTime = Date.now() - taskStart;
    logger.log(
      '[runThumbnailBackfill] completed in',
      totalTime,
      'ms, processed',
      processedInThisRun,
      'total',
    );
    return { started: true };
  } finally {
    // 🔴 第一件事就停副指标定时器：它是本任务里**唯一「收尾之后还会自己动」**的东西。
    //    放最后清 = 中间任何一步抛异常，进程里就永久留一个 1 s 定时器：任务早结束了，
    //    它还在每 5 s 打一次 worker、推一次 `background-tasks-changed`，查不出来源。
    stopPendingThumbRefreshTicker();
    thumbnailBackfill.failedPathsLastRun = thumbnailBackfill.failedPaths.slice(
      0,
      THUMB_BACKFILL_FAILED_PATHS_MAX,
    );
    thumbnailBackfill.failedPaths = [];
    thumbnailBackfill.running = false;
    thumbnailBackfill.currentFile = '';
    thumbnailBackfill.startedAt = 0;
    // 三态只对「正在运行」有意义；完成态靠 `total` 说「这轮一共处理了多少张」（见 UI 的完成文案）。
    thumbnailBackfill.pendingPhase = null;
    emitBackgroundTasksChangedThrottled(true);
    // 🔴 这一轮顺手补了查重指纹 ⇒ 重复分组缓存里那些「组」已经过期（少算了由新指纹组成的组）。
    //    不清 = 用户看到「回填明明跑过，重复项页面还是旧结果」—— 是**静默的错数据**，不是「慢」。
    //    放 finally：取消 / 中途退出时也已经写了一部分指纹，同样必须失效。
    if (thumbnailBackfill.hashed > 0) {
      clearDuplicateHashGroupsCache('thumb-backfill-hashed');
    }
    logger.log(
      '[runThumbnailBackfill] task cleanup done, processed=' +
        thumbnailBackfill.done +
        ' (thumbs=' +
        thumbnailBackfill.thumbs +
        ', fetched=' +
        thumbnailBackfill.fetched +
        ', pendingTotal=' +
        String(thumbnailBackfill.pendingTotal) +
        ', thumbTotal=' +
        String(thumbnailBackfill.thumbTotal) +
        '), sized=' +
        thumbnailBackfill.sized +
        ', dhashed=' +
        thumbnailBackfill.dhashed +
        ', hashed=' +
        thumbnailBackfill.hashed +
        ', exif=' +
        thumbnailBackfill.exifFilled +
        '/' +
        thumbnailBackfill.exifChecked,
    );
  }
}

/**
 * 缩略图**全量重跑**的准入判据 —— **IPC 入口与任务内部共用这一处**。
 *
 * 🔴 与 `thumbnailBackfillBlockReason()` 同一条约定（那边的注释记着 2026-10-06 用户报的
 *    「点了没反应」）：两个入口各写一份判据的下场是「IPC 返回 `{success:true}`、
 *    任务在 `setTimeout` 里静默 return」—— 界面刷新后显示「未运行」，而拒绝日志还是 info 级。
 *    所以这里也**只留一份**，且任何拒绝都走 `logger.warn`（生产档 logger 是 warn）。
 *
 * ⚠️ 与补全**双向**互斥：这里挡补全，补全那边（`thumbnailBackfillBlockReason`）也挡这里。
 *    单向挡会留下「先起重跑、再起补全」这个窗口，而两者都要把整文件读一遍、
 *    抢的是同一块盘（本机 K:/G: 是外接机械盘）。
 */
function thumbnailRebuildBlockReason() {
  if (optimizeTaskRunning) return '数据库维护进行中';
  if (isFolderScanRunning()) return '扫描进行中，请稍后再试';
  if (duplicateHashTask.running) return '重复文件比对进行中，请稍后再试';
  if (thumbnailBackfill.running) return '缩略图补全进行中，请稍后再试';
  if (thumbnailRebuild.running) return '重建已在进行中';
  return '';
}

/**
 * 本轮的**目标规格快照**（档位 / 画质 / 编码格式）。
 *
 * 🔴 起手取一次就固定下来，跑到一半用户又改设置**不改这一轮的目标**：
 *    改了的话「这一轮到底在追哪个规格」就无解了 —— 队列里一半按新目标筛、一半按旧的，
 *    续跑时 `isQueueReusable()` 判废 ⇒ 整条队列从头登记，「进度条突然回到 0%」。
 *    想换目标就再点一次重建（那时会按新目标重新登记，这是有意的）。
 */
function getThumbnailRebuildTarget() {
  var topts = getThumbOptions();
  return {
    size: topts.size,
    quality: topts.quality,
    format: THUMB_ENCODE_FORMAT,
    signature: thumbRegenQueue.targetSignature(topts.size, THUMB_ENCODE_FORMAT),
  };
}

/** 重跑失败路径的记账（上限与补全同一口径 —— 用户实机 33.9 万缺口，无上限会撑爆内存）。 */
function pushRegenFailedPath(filePath) {
  if (thumbnailRebuild.failedPaths.length >= THUMB_BACKFILL_FAILED_PATHS_MAX) return;
  var p = filePath || '';
  if (p) thumbnailRebuild.failedPaths.push(p);
}

/**
 * 重跑一批：按目标规格**从原图**重新生成缩略图并写库，**并顺手补齐另外四样元数据**。
 *
 * 🔴 必须读原图，不能拿库里现有的缩略图重编码：档位是往上换的（256 → 512）时那张图
 *    本来就只有 256 的像素，放大它只会更糊 —— 而且「看起来跑完了」，用户以为升级成功。
 *
 * 🔴 **一趟解码出五样**（2026-10-08 并入）：补全那条路（`runRowsWithThumbConcurrency#processOne`）
 *    早就是「一次读盘出 缩略图 / 原图尺寸 / 拍摄参数 / dHash / 查重指纹」，
 *    而重跑此前**只出缩略图那样** ⇒ 同一批字节要被读两遍。真库实测（2026-10-08）：
 *    补全第二支还欠 **857,372 行**（缺 dHash 531,173 / 缺尺寸 530,641 / 需读 EXIF 857,372），
 *    而原图在 K:/G: 外接机械盘上 —— 读盘是这里的主导成本，不是 CPU。
 *    并入之后**判据、写入口、内存闸门全部复用补全那一套**（不另抄一份），
 *    顺序也照抄（见下面「顺序不能颠倒」那条）。
 *
 * ⚠️ 只在**写库票据内部**调用（调用方是 `dbWriteQueue.run('thumb-regen', …)`）：
 *    与补全同一套契约（每批一次入队 ⇒ 批间让位、批内独占）。
 * ⚠️ 并发度**沿用**「缩略图补全同时处理张数」那个设置，不复用 `getEffective…` 之外的新旋钮：
 *    做的是同一件事（读原图 + 解码 + 编码），两个旋钮只会让用户以为能分别调优。
 * ⚠️ 这里**不碰** `thumb_fail_mtime`：那一列的语义是「试过生成缩略图、失败了」，
 *    而这批行本来就有缩略图（只是规格旧），盖了章等于把「规格旧」记成「生成失败」，
 *    语义直接错。失败只记数与路径，用户下次重建还会再试一遍。
 *    ⇒ 同理，这里的 dHash 算不出来时**也不盖章**（只打 warn）：补全下一轮会照常重试它。
 *
 * 🔴 **本函数必须把 `rows` 整批抽干，不许按取消半途退出**（2026-10-08 修）：调用方按
 *    「本批取到的全部 id」删队列，半途退出会把没轮到的行**连坐删掉** —— `done` 加满、
 *    规格没换、且永不重跑（真库实测 42 行，落成 3 段连续 id = 三次取消各吃掉一批的尾巴）。
 *    取消改由**批次边界**承担；唯一允许中途放弃的只有「这一行在 `photos` 里已不存在」，
 *    那种行由调用方按 `missing` 记账，本来就没有活可干。
 *
 * @returns {Promise<{ok: number, failed: number}>}
 */
async function regenerateRowsWithConcurrency(rows, target) {
  var n = rows.length;
  var out = { ok: 0, failed: 0 };
  if (!n) return out;
  var conc = Math.min(getEffectiveThumbBackfillConcurrency(), n);
  var next = 0;
  var completed = 0;

  async function worker() {
    while (true) {
      // 🔴 **批内不许按取消提前退出**（2026-10-08 修，真库实测漏 42 行）。
      //    调用方的形状是「先把这一批做完、再按**本批取到的全部 id** 删队列」（见
      //    `runThumbRegenDrainPass`），所以这里一旦半途 `return`，没轮到的那几行就被
      //    **连坐删掉**：`done` 照样加满、规格却没换，而且它们已经不在队列里 ⇒
      //    **再也不会被重跑**（不报错、不写日志、界面照报「已完成」）。
      //    ⇒ 取消只在**批次边界**生效（外层 `while (!thumbnailRebuild.cancelled)`），
      //      这也正是 `cancel-thumbnail-rebuild` 那条 IPC 注释所声明的语义。
      //    ⚠️ 别为了「停止更跟手」把它加回来：代价是永久漏行，比多等一批（50 行）贵得多。
      var my = next++;
      if (my >= n) return;
      var row = rows[my];
      // LEFT JOIN 的空行（这条 id 在 photos 里已经没有了）不在这里记账，由调用方按 missing 处理
      if (!row || !row.file_path) continue;
      thumbnailRebuild.currentFile = row.file_path;
      var isVideoRow = isVideoPath(row.file_path);
      // 「这一行还缺什么」的四个门。判据**与补全逐字同源**（尤其 EXIF 那个必须走
      // `db.photoNeedsExif(row)`：手写 `!(row.exif_mtime && …)` 只判一个标记列，
      // 而候选谓词判的是两个 —— 漂开就是一条静默死路，见 `processOne` 里的长注释）。
      var needSize = !isVideoRow && !(row.width > 0 && row.height > 0);
      var needDhash = !isVideoRow && !(row.dhash && String(row.dhash).trim());
      var needExif = !isVideoRow && db.photoNeedsExif(row);
      var needHash = !isVideoRow && !(row.file_hash && String(row.file_hash).trim());
      // 共享读取 = 整份进内存；超大 / 大小未知的文件退回「查重指纹各读各的」老路径
      //（闸门与补全同一个常量，理由见 `THUMB_SHARED_READ_MAX_BYTES` 的注释）
      var sharedBuf = null;
      var header = null;
      var dhash = null;
      try {
        if (isVideoRow) {
          var vopts = { size: target.size, quality: target.quality };
          var vbuf = await extractVideoThumbnailWithFfmpeg(row.file_path, vopts);
          // 抽帧失败退回占位图（与补全同一口径：宁可给一张占位图，也不要让这一行停在旧规格）
          if (!vbuf) vbuf = await buildVideoPlaceholderThumbnail(vopts);
          db.updatePhotoThumbnail(row.id, vbuf, { size: target.size, format: target.format });
          out.ok++;
        } else {
          // 🔴 libvips 读不了的格式（bmp / ico / pnm / tga / qoi / dib、老式 CR2）走同一个入口，
          //    否则那批行在重跑里会「每轮都失败」—— 而它们在补全里本来是能出图的。
          if (needHash && row.file_size > 0 && row.file_size <= THUMB_SHARED_READ_MAX_BYTES) {
            sharedBuf = await tryReadShared(row.file_path);
          }
          var si = await createSharpInput(row.file_path, sharedBuf || null);
          var instance = si.instance;
          // 🔴 顺序不能颠倒：先读文件头（`metadata()`，几乎零成本）→ 再算 dHash → **最后**才缩放置换。
          //    dHash 必须取在 `.rotate()` **之前** —— 它历来是不旋转的（旧路径
          //    `computeDhash(row.file_path)` 就没有 `.rotate()`），带 EXIF 方向的图片一旦先旋转
          //    再算，位会全变，而 dHash 是相似聚类的输入，位差会翻面。
          //    `resizeThumb()` 内部会 `rotate()`（见 `thumb-format.js`），所以缩放在最后。
          if (needSize || needExif) {
            header = mergeOwnExif(await readHeaderMeta(instance), si.own);
          }
          if (needDhash) {
            dhash = await computeDhashFromPipeline(instance);
          }
          // 🔴 缩略图「缩放 + 编码」这一步单独一层 try：它失败不许把已经到手的
          //    尺寸 / 拍摄参数 / dHash 一起带走（补全那边为这个坑返工过一次，见 `processOne`）。
          try {
            var thumb = await resizeThumb(instance, target.size, target.quality);
            db.updatePhotoThumbnail(row.id, thumb, { size: target.size, format: target.format });
            out.ok++;
          } catch (eThumb) {
            out.failed++;
            pushRegenFailedPath(row.file_path);
            logger.warn(
              '[thumb-regen] 重生成失败：' +
                row.file_path +
                ' — ' +
                (eThumb && eThumb.message ? eThumb.message : String(eThumb)),
            );
          }
          // —— 四样顺手产出：与补全同序、同写入口。⚠️ 编码失败也照写（到手的就是到手的）。
          // 原图尺寸：只在拿到正尺寸时写 —— 库里已有真实值时不许被覆盖成 0
          if (header && header.width > 0 && header.height > 0) {
            db.updatePhotoDimensions(row.id, header.width, header.height);
            thumbnailRebuild.sized++;
          }
          // 拍摄参数：与尺寸共用**同一次**文件头读盘（`header.exif`），这里不再碰盘。
          // 🔴 只有**读到了文件头**才写标记：`header === null` 是「没看到文件」，不是
          //    「看过了、没有 EXIF」—— 判据与补全那处完全一致。
          if (needExif && header) {
            db.updatePhotoExif(row.id, header.exif, row.date_modified);
            thumbnailRebuild.exifChecked++;
            if (hasAnyExifField(header.exif)) thumbnailRebuild.exifFilled++;
          }
          if (needDhash) {
            if (dhash) {
              db.updatePhotoDhash(
                row.id,
                dhash,
                getDhashBuckets(dhash),
                row.date_modified,
                row.file_size,
              );
              thumbnailRebuild.dhashed++;
            } else {
              // `computeDhashFromPipeline` 的失败语义是**返回 null、从不抛**（见 `perceptual-hash.js`）
              // ⇒ 不写这一行日志就完全没有现场。这里**不盖章**，理由见函数头。
              logger.warn('[thumb-regen] dHash unusable (decode failed) for: ' + row.file_path);
            }
          }
          if (needHash) {
            try {
              var digest = sharedBuf
                ? hashBufferSha256(sharedBuf)
                : await hashFileSha256(row.file_path, function () {
                    return thumbnailRebuild.cancelled;
                  });
              if (digest) {
                db.updatePhotoHash(row.id, digest, row.date_modified, row.file_size);
                thumbnailRebuild.hashed++;
              }
            } catch (eHash) {
              logger.warn(
                '[thumb-regen] SHA-256 failed: ' +
                  row.file_path +
                  ' — ' +
                  (eHash && eHash.message ? eHash.message : String(eHash)),
              );
            }
          }
        }
      } catch (e) {
        out.failed++;
        pushRegenFailedPath(row.file_path);
        // warn 级：失败是这个任务里唯一需要留现场的事件（生产档 info 是静默的）
        logger.warn(
          '[thumb-regen] 重生成失败：' +
            row.file_path +
            ' — ' +
            (e && e.message ? e.message : String(e)),
        );
      }
      completed++;
      if (completed % 8 === 0) {
        emitBackgroundTasksChangedThrottled(false);
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: conc }, function () {
      return worker();
    }),
  );
  return out;
}

/**
 * 登记阶段：把「规格与目标不符」的行**按 id 区间倒序**放进队列。
 *
 * 代价特征：每一个区间是一遍**有界的**区间扫描（块内代价 ∝ 块内行数，与目标值无关）；
 * 每块一次入队 ⇒ 单次持写锁的时长有上界（真库 4 万行约 5~10 s），用户任务能插在块之间。
 *
 * ⚠️ 区间宽度**决定单次持锁时长**，别随手调大：整段一次 `INSERT … SELECT` 就是
 *    几十秒独占写锁（项目里已有「全表 UPDATE 会独占写锁扫完整个库」那条红线）。
 * @param {ReturnType<typeof getThumbnailRebuildTarget>} target
 * @param {boolean} reusable 队列能不能接着用（不能则第一块顺带清空 + 重置）
 */
async function runThumbRegenEnqueuePass(target, reusable) {
  thumbnailRebuild.phase = 'enqueueing';
  var meta = db.thumbRegenMeta();
  var savedPhase = reusable ? String((meta && meta.phase) || '') : '';
  // 🔴 只有「上次的登记确实没走完」才接着扫。`draining` / `done` 说明全库都扫过了 ——
  //    再扫一遍就是几十万行的白读（而且会把刚抽干的队列重新塞满 ⇒ 无限循环）。
  if (savedPhase === 'draining' || savedPhase === 'done') return;
  var cursor = reusable ? Number(meta && meta.enqueueCursor) || 0 : db.getMaxPhotoId() + 1;
  if (cursor <= 0) cursor = db.getMaxPhotoId() + 1;
  var total = Number(thumbnailRebuild.total) || 0;
  var firstChunk = true;

  while (!thumbnailRebuild.cancelled && cursor > 0) {
    // 交互抢占：用户正在搜图就在这里停下（与补全同一条，且**必须在入队之前**）
    await interactionPreempt.awaitIdle();
    var idTo = cursor;
    var idFrom = Math.max(0, idTo - THUMB_REGEN_ENQUEUE_CHUNK);
    // 只给第一块带上「作废旧队列」的标记 ⇒ 清空 + 重置 + 首块入库在**同一个事务**里，
    // 中途崩溃不会留下「队列空了、身份串还是旧的」这种状态（那种状态下 `isQueueReusable`
    // 会判「可以接着用」，于是去抽干一条空队列、报「重建完成」而其实什么都没做）。
    var resetSignature = firstChunk && !reusable ? target.signature : '';
    var chunk = await dbWriteQueue.run(
      'thumb-regen-enqueue',
      function () {
        return db.thumbRegenEnqueueChunk(
          idFrom,
          idTo,
          target.size,
          target.format,
          resetSignature,
          total,
        );
      },
      { priority: PRIORITY.IDLE },
    );
    firstChunk = false;
    if (chunk && Number(chunk.total) >= 0) total = Number(chunk.total) || 0;
    thumbnailRebuild.total = total;
    thumbnailRebuild.scanned += idTo - idFrom;
    cursor = idFrom;
    emitBackgroundTasksChangedThrottled(false);
    await yieldForPreviewPlaybackMs(20);
    await yieldForPreviewPlaybackMs(20);
  }
  // 取消 ⇒ 游标已经落盘，下次从断点接着登记（**不要**在这里写任何别的状态）
  if (thumbnailRebuild.cancelled) return;
  logger.log(
    '[runThumbnailRebuild] 登记完成：扫描 ' +
      thumbnailRebuild.scanned +
      ' 行，放进队列 ' +
      total +
      ' 张',
  );
}

/**
 * 抽干阶段：按主键倒序一批一批地重跑。
 *
 * 🔴 取批**没有规格谓词**（`thumb-regen-queue#FETCH_SQL`）：队列本身就是筛选结果。
 *    一旦有人「顺手」把谓词加回来，代价就从 ∝ 批大小变成 ∝ **游标到第一个命中行的距离**
 *    —— 尾巴上每批都要从高位扫到底（补全那边真库实测单批 159.6 s，见
 *    `docs/contracts/thumbnail-backfill.md`）。守护 `thumbnail-regen-regression` 盯着这条形态。
 */
async function runThumbRegenDrainPass(target) {
  thumbnailRebuild.phase = 'draining';
  var cursor = db.getMaxPhotoId() + 1;
  while (!thumbnailRebuild.cancelled) {
    await interactionPreempt.awaitIdle();
    await yieldForPreviewPlaybackMs(20);
    var rows = db.thumbRegenFetchBatch(cursor, THUMB_REGEN_DRAIN_BATCH);
    if (rows.length === 0) break;
    var lastId = rows[rows.length - 1].id;
    var batchIds = [];
    var missing = 0;
    for (var mi = 0; mi < rows.length; mi++) {
      batchIds.push(rows[mi].id);
      if (!rows[mi] || !rows[mi].file_path) missing++;
    }
    // const 而非 var：下面的闭包里要引用（块作用域保证每轮捕获到的是本批的值）
    const batchRows = rows;
    const batchMissing = missing;
    const batchIdList = batchIds;
    var finished = await dbWriteQueue.run(
      'thumb-regen',
      async function () {
        // 🔴 顺序固定：先生成、再删除、最后记账。删除与记账在**同一个事务**里
        //    （`thumbRegenFinishBatch`），中途崩溃只会「这批重做一遍」，不会出现
        //    「行已经不在队列里、`done` 没加」那种进度凭空少一截的状态。
        var res = await regenerateRowsWithConcurrency(batchRows, target);
        return db.thumbRegenFinishBatch(batchIdList, {
          failed: res.failed,
          missing: batchMissing,
        });
      },
      { priority: PRIORITY.IDLE },
    );
    // 内存计数以**库里的持久化值**为准（它跨重启累计；内存只负责画界面）
    if (finished) {
      thumbnailRebuild.done = Number(finished.done) || thumbnailRebuild.done;
      thumbnailRebuild.failed = Number(finished.failed) || thumbnailRebuild.failed;
      thumbnailRebuild.missing += batchMissing;
    }
    // 倒序：本批最后一行是**本批最小**的 id。
    // ⚠️ 游标仍然用「内含」（`id <= cursor`）：本批的行在上一句里已经被删掉了，
    //    所以重取到它的可能不存在；而队列是**稀疏**的，绝不能拿它当「删除下界」
    //    （那会连带删掉比它更小、还没取过的行 —— 那批行会永远拿不到重跑，进度条却显示完成）。
    cursor = lastId;
    emitBackgroundTasksChangedThrottled(false);
    await yieldForPreviewPlaybackMs(20);
    await yieldForPreviewPlaybackMs(20);
  }
  if (thumbnailRebuild.cancelled) return;
  // 队列已空 ⇒ 收口：把 `done` 对齐 `total`（正常路径下两者本来就相等）并把阶段推到 `done`。
  // 少了这一步，界面会永远停在「还有 N 张待重建」而任务其实已经结束。
  var final = await dbWriteQueue.run(
    'thumb-regen',
    function () {
      return db.thumbRegenMarkDrained();
    },
    { priority: PRIORITY.IDLE },
  );
  if (final) {
    thumbnailRebuild.done = Number(final.done) || thumbnailRebuild.done;
    thumbnailRebuild.failed = Number(final.failed) || thumbnailRebuild.failed;
  }
}

/**
 * 缩略图**全量重跑**：把库里「规格与当前设置不符」的缩略图重新生成一遍。
 *
 * 三个阶段（缺一不可，且每一阶段的进度都落盘，所以**关掉应用再打开能接着跑**）：
 *   ① 判废 / 重置：目标规格与队列的身份串不一致（用户改了档位）⇒ 清空重登记；
 *   ② 登记：按 id 区间倒序扫全库，把不符的行放进 `thumb_regen_queue`（游标落盘，可分块续跑）；
 *   ③ 抽干：按主键倒序一批一批重跑（批内生成 + 删除 + 记账）。
 *
 * ⚠️ **刻意不做「启动时自动续跑」**（尽管队列是可续的）：它是一遍全库重编码，
 *    在机械盘上以小时计，抢的还是用户正在浏览的那块盘。是否继续由用户在设置页点。
 *    队列与进度都在库里，不会因为没自动跑而丢。
 */
async function runThumbnailRebuild() {
  const blockReason = thumbnailRebuildBlockReason();
  if (blockReason) {
    logger.warn('[runThumbnailRebuild] skipped: ' + blockReason);
    return { started: false, reason: blockReason };
  }
  const taskStart = Date.now();
  const target = getThumbnailRebuildTarget();
  thumbnailRebuild.running = true;
  thumbnailRebuild.cancelled = false;
  thumbnailRebuild.failedPaths = [];
  thumbnailRebuild.currentFile = '';
  thumbnailRebuild.startedAt = Date.now();
  thumbnailRebuild.runToken++;
  thumbnailRebuild.targetSize = target.size;
  thumbnailRebuild.targetFormat = target.format;
  thumbnailRebuild.phase = 'enqueueing';
  thumbnailRebuild.missing = 0;
  thumbnailRebuild.scanned = 0;
  // 顺手产出的计数是**本次进程**的口径（不入 meta）：与补全那五个同款。
  // ⚠️ 接着上一条队列跑时**也必须归零** —— 它们描述的是「这次跑了多少」，
  //    不是「这条队列累计补齐了多少」，混起来会让界面把上一轮的产出算进这一轮。
  thumbnailRebuild.sized = 0;
  thumbnailRebuild.exifChecked = 0;
  thumbnailRebuild.exifFilled = 0;
  thumbnailRebuild.dhashed = 0;
  thumbnailRebuild.hashed = 0;
  emitBackgroundTasksChangedThrottled(true);
  logger.log('[runThumbnailRebuild] 启动，目标 = ' + target.signature);

  try {
    var meta = db.thumbRegenMeta();
    var reusable = thumbRegenQueue.isQueueReusable(meta, target.signature);
    if (reusable) {
      thumbnailRebuild.total = Number(meta.total) || 0;
      thumbnailRebuild.done = Number(meta.done) || 0;
      thumbnailRebuild.failed = Number(meta.failed) || 0;
      // 🔴 `missing` 也必须从 meta 恢复（2026-10-08）：它**参与**一个界面读数 ——
      //    重建那节的「已重出」= `done − failed − missing`。不恢复（只靠上面刚归零的内存值）
      //    就会少减「重启前那部分『行已不在库里』的行」，界面上的产出**偏大**。
      //    它不影响进度百分比与 ETA，所以错了也不会有人当场发现 —— 正是要在这里钉住。
      thumbnailRebuild.missing = Number(meta.missing) || 0;
      logger.log(
        '[runThumbnailRebuild] 接着上一条队列跑：阶段=' +
          String(meta.phase || '') +
          '，total=' +
          thumbnailRebuild.total +
          '，done=' +
          thumbnailRebuild.done,
      );
    } else {
      thumbnailRebuild.total = 0;
      thumbnailRebuild.done = 0;
      thumbnailRebuild.failed = 0;
      logger.log('[runThumbnailRebuild] 队列作废（目标规格变了 / 从未登记），将从全库重新登记');
    }
    // 🔴 ETA 的基线必须**在恢复完 `done` 之后**取：它是「本次进程起手时这条队列已经走到哪」。
    //    只在起手取一次（不是每批更新）—— 更新它就等于把速率算成瞬时值，ETA 会跟着抖。
    //    三个数一起取：界面要报的「本次重出 / 本次失败」也是同一套差值口径。
    thumbnailRebuild.doneAtStart = Number(thumbnailRebuild.done) || 0;
    thumbnailRebuild.failedAtStart = Number(thumbnailRebuild.failed) || 0;
    thumbnailRebuild.missingAtStart = Number(thumbnailRebuild.missing) || 0;

    // 让出几次事件循环，先让界面把「进行中」画出来（与补全同一手法）
    await yieldForPreviewPlaybackMs(50);

    await runThumbRegenEnqueuePass(target, reusable);
    if (thumbnailRebuild.cancelled) {
      logger.log('[runThumbnailRebuild] 登记阶段被取消，游标已落盘，下次接着登记');
      return { started: true, cancelled: true };
    }
    await runThumbRegenDrainPass(target);

    logger.log('[runThumbnailRebuild] 结束，用时 ' + (Date.now() - taskStart) + ' ms');
    return { started: true };
  } finally {
    thumbnailRebuild.failedPathsLastRun = thumbnailRebuild.failedPaths.slice(
      0,
      THUMB_BACKFILL_FAILED_PATHS_MAX,
    );
    thumbnailRebuild.failedPaths = [];
    thumbnailRebuild.running = false;
    thumbnailRebuild.currentFile = '';
    thumbnailRebuild.startedAt = 0;
    thumbnailRebuild.phase = '';
    emitBackgroundTasksChangedThrottled(true);
    logger.log(
      '[runThumbnailRebuild] 收尾：total=' +
        thumbnailRebuild.total +
        '，done=' +
        thumbnailRebuild.done +
        '，failed=' +
        thumbnailRebuild.failed +
        '，missing=' +
        thumbnailRebuild.missing +
        '，scanned=' +
        thumbnailRebuild.scanned,
    );
  }
}

/**
 * 重跑任务的进度读数（运行期；空闲态的读数见 `getThumbnailRebuildStatus()`）。
 *
 * ⚠️ 分母是**精确值**（登记时 `INSERT` 行数累加），不是抽样估计 ⇒ 文案里**不要**写「约」。
 * 🔴 `pending` 必须夹在 `>= 0`：分子是持久化值、分母也是，两者在「重置队列」那一瞬间
 *    可能读到一新一旧（例如 total 已归 0、done 还是上一轮的） ⇒ 不夹就会显示负数。
 */
function getThumbnailRebuildProgress() {
  var total = Number(thumbnailRebuild.total) || 0;
  var done = Number(thumbnailRebuild.done) || 0;
  var denom = Math.max(total, done);
  var pending = Math.max(0, total - done);
  var pct = denom > 0 ? Math.min(100, Math.round((done / denom) * 100)) : 0;
  /**
   * 🔴 ETA 的分子分母必须**同一个口径**（2026-10-08 修）：
   * `done` 跨重启累计、`startedAt` 是本次进程 ⇒ 直接喂进去 = 「整条队列的累计完成量 ÷
   * 本次跑了多久」。真库实测重启续跑 21 分钟时那是 **305 张/秒**（实测 17）⇒
   * 界面显示「预计剩余约 1 小时 9 分」，而真实约 **20.7 小时**（差 18 倍）。
   * 修法：以 `doneAtStart` 为基线，只用**这一趟真正做的量**算速率。
   * ⚠️ 第三、四个参数仍叫「已完成 / 总量」，但都换算到本次进程的坐标上 ——
   *    总量 = 本次已完成 + 还没做，两者相减后 remaining 不变（`pending`），速率才是真值。
   */
  var sessionDone = Math.max(0, done - (Number(thumbnailRebuild.doneAtStart) || 0));
  /**
   * 🔴 「本次进程」口径的三件套（2026-10-08 用户指出「**已完成的不是这一次跑的**」之后补的）。
   * `done` / `failed` / `missing` 都会跨重启累计 ⇒ 界面把它们直接当「本次重出多少」报，
   * 报了上一个进程的账。改成各自减去起手快照：
   *   · `rebuiltThisRun` = 本次抽干的行 − 本次失败 − 本次「行已不在库里」（**真的产出**）
   *   · `failedThisRun`  与副行那五项产出计数同口径（那五项本来就是本次进程）
   *   · `doneThisRun` 只作对照（= `done − doneAtStart`，含失败与 missing 两类）
   * 累计口径仍在 `done` / `failed` / `missing` 里原样保留：**主行的 `done / total` 就是总账**，
   * 空闲态的设置页文案（`getThumbnailRebuildStatus`）读的也是 meta 里的累计值。
   */
  var sessionFailed = Math.max(
    0,
    (Number(thumbnailRebuild.failed) || 0) - (Number(thumbnailRebuild.failedAtStart) || 0),
  );
  var sessionMissing = Math.max(
    0,
    (Number(thumbnailRebuild.missing) || 0) - (Number(thumbnailRebuild.missingAtStart) || 0),
  );
  var rebuiltThisRun = Math.max(0, sessionDone - sessionFailed - sessionMissing);
  var etaSeconds = null;
  if (thumbnailRebuild.running && total > 0) {
    etaSeconds = estimateEtaSecondsSmoothed(
      'thumbRebuild',
      thumbnailRebuild.startedAt,
      sessionDone,
      sessionDone + pending,
    );
  }
  return {
    running: thumbnailRebuild.running,
    cancelled: thumbnailRebuild.cancelled,
    /** `'enqueueing'`（还在登记）| `'draining'`（正在重跑）| `null`（未运行） */
    phase: thumbnailRebuild.running ? thumbnailRebuild.phase || 'enqueueing' : null,
    total: total,
    done: done,
    failed: Number(thumbnailRebuild.failed) || 0,
    /**
     * 登记阶段**已扫过的行数**。它是「还在登记」那段时间的唯一进展读数 ——
     * 那段时间一张图都还没重生成，只给 `done` 的话界面会一动不动（用户以为卡住了）。
     */
    scanned: Number(thumbnailRebuild.scanned) || 0,
    missing: Number(thumbnailRebuild.missing) || 0,
    pending: pending,
    pct: pct,
    /**
     * 顺手产出的五项（2026-10-08 并入）。**本次进程**的口径，不持久化。
     * ⚠️ 它们是**白名单拼装**的字段：漏一个 = 界面收得到事件却永远画不出那一项，
     *    看起来跟「这项没在补」一模一样。守护对这几个名字有断言。
     */
    sized: Number(thumbnailRebuild.sized) || 0,
    exifChecked: Number(thumbnailRebuild.exifChecked) || 0,
    exifFilled: Number(thumbnailRebuild.exifFilled) || 0,
    dhashed: Number(thumbnailRebuild.dhashed) || 0,
    hashed: Number(thumbnailRebuild.hashed) || 0,
    /**
     * 🔴 **本次进程**口径（与上面五项同款）。界面报「本次重出 N」要用 `rebuiltThisRun`，
     * **不许**拿累计的 `done` 去减 —— 那就是「已完成的不是这一次跑的」。
     * ⚠️ 与 `done` 一样是白名单拼装：漏一个字段 = 界面那项永远画不出/画错。
     */
    doneThisRun: sessionDone,
    failedThisRun: sessionFailed,
    rebuiltThisRun: rebuiltThisRun,
    currentFile: thumbnailRebuild.currentFile,
    targetSize: Number(thumbnailRebuild.targetSize) || 0,
    targetFormat: String(thumbnailRebuild.targetFormat || ''),
    /** 见函数开头那段：**按本次进程的速率**算，不是按整条队列的累计量（2026-10-08 修） */
    etaSeconds: etaSeconds,
  };
}

/**
 * 设置页用的**空闲态**读数：有没有待办、还差多少、目标是哪个、队列还算不算数。
 *
 * 🔴 只读 `thumb_regen_meta` 单行（O(1)），**绝不去数队列**：队列可以有一百多万行，
 *    `COUNT(*)` 是整条索引的扫描 —— 而设置页每次打开都会读它。
 *    `total` / `done` 本来就在 meta 里逐批维护，两者之差就是待办数。
 *
 * ⚠️ `stale = true` 表示「队列是按**旧**目标登记的」（用户改过档位还没重建）。
 *    这时 `pending` 是旧队列的残留数，**不代表真实待办**（真实值要扫全库才知道）——
 *    UI 必须换一句文案，别把旧数当新数画出来。
 */
function getThumbnailRebuildStatus() {
  var target = getThumbnailRebuildTarget();
  var meta = db ? db.thumbRegenMeta() : null;
  var total = Number(meta && meta.total) || 0;
  var done = Number(meta && meta.done) || 0;
  var stale = !thumbRegenQueue.isQueueReusable(meta, target.signature);
  return {
    targetSize: target.size,
    targetQuality: target.quality,
    targetFormat: target.format,
    queueSignature: meta ? String(meta.signature || '') : '',
    queuePhase: meta ? String(meta.phase || '') : '',
    stale: stale,
    total: total,
    done: done,
    failed: Number(meta && meta.failed) || 0,
    pending: stale ? 0 : Math.max(0, total - done),
    running: thumbnailRebuild.running,
    progress: getThumbnailRebuildProgress(),
  };
}

/**
 * 摘要的两条入口（`hashFileSha256` / `hashBufferSha256`）已抽到 **`src/main/file-hash.js`**。
 *
 * 🔴 抽出去不是为了好看：两条路写的是同一列 `photos.file_hash`，而「重复项」按它分组 ——
 *    摘要一旦不一致，成对的图片会被**静默**分到两个组里。`file-hash.js` 不依赖 electron，
 *    回归脚本才能**真跑**着对同一份内容两条路各算一次、逐字符比对（见 `perceptual-hash-share-regression`）。
 *    别把它们搬回本文件 —— 搬回来就再也验不了了。
 */

/**
 * 「共用一次读盘」允许**整份进内存**的单文件上限（64 MB）。
 *
 * 超过它的行退回「sharp 按路径流式解码 + `hashFileSha256` 流式读」的老路径：那是两次读盘，
 * 但内存是常数。判据用库里已有的 `file_size`，**不额外 stat**（本机 95 万次 stat 实测 1.1 分钟）。
 * 大小未知（`0` / NULL）时**不共享** —— 宁可多读一遍，也不要为省一次读盘把并发峰值撑爆。
 */
var THUMB_SHARED_READ_MAX_BYTES = 64 * 1024 * 1024;

/** 并行算摘要：慢盘场景更保守，避免随机读放大后反而变慢 */
function getDupHashConcurrency() {
  if (previewPlaybackActive) return 1;
  var n = (os.cpus() && os.cpus().length) || 2;
  if (n <= 2) return 2;
  if (n <= 4) return 2;
  if (n <= 8) return 3;
  return 4;
}

/**
 * 一小批行：多文件并行 SHA-256，再单笔事务写库，兼顾速度与取消粒度（按子批轮询间隔检查 cancelled）
 */
async function processDupHashRowsChunk(rows, yieldEvery) {
  var len = rows.length;
  if (len === 0) return;
  var concurrency = getDupHashConcurrency();
  var nextIndex = 0;
  var outcomes = new Array(len);
  var doneBase = Number(duplicateHashTask.done) || 0;
  var completedInChunk = 0;
  var progressEmitEvery = 4;

  async function worker() {
    while (true) {
      if (duplicateHashTask.cancelled) return;
      var my = nextIndex++;
      if (my >= len) return;
      var row = rows[my];
      if (duplicateHashTask.cancelled) return;
      duplicateHashTask.currentFile = row && row.file_path ? row.file_path : '';
      duplicateHashTask.currentHash = '';
      try {
        if (row.file_path && fs.existsSync(row.file_path)) {
          var digest = await hashFileSha256(row.file_path, function () {
            return !!duplicateHashTask.cancelled;
          });
          if (duplicateHashTask.cancelled) return;
          outcomes[my] = { kind: 'hashed', row: row, digest: digest };
        } else {
          outcomes[my] = { kind: 'missing', row: row };
        }
      } catch (e) {
        if (duplicateHashTask.cancelled) return;
        outcomes[my] = { kind: 'fail', row: row };
      }
      completedInChunk++;
      duplicateHashTask.done = doneBase + completedInChunk;
      if (completedInChunk % progressEmitEvery === 0) {
        emitBackgroundTasksChangedThrottled(false);
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, function () {
      return worker();
    }),
  );
  duplicateHashBgLog('chunk-hashed', 'rows=' + String(len), false);

  db.beginTransaction();
  try {
    for (var k = 0; k < len; k++) {
      if (duplicateHashTask.cancelled) break;
      var o = outcomes[k];
      if (!o) continue;
      duplicateHashTask.currentFile = o.row.file_path || '';
      if (o.kind === 'hashed') {
        db.updatePhotoHash(o.row.id, o.digest, o.row.date_modified, o.row.file_size);
        duplicateHashTask.hashed++;
        duplicateHashTask.currentHash = o.digest;
      } else if (o.kind === 'missing') {
        duplicateHashTask.skippedMissing++;
        duplicateHashTask.currentHash = '';
      } else {
        duplicateHashTask.failed++;
        duplicateHashTask.currentHash = '';
      }
      if ((k + 1) % yieldEvery === 0) {
        emitBackgroundTasksChangedThrottled(false);
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
      }
    }
  } finally {
    db.commit();
  }
  duplicateHashBgLog('chunk-committed', 'rows=' + String(len), false);
}

function getDuplicateHashTaskProgress() {
  var d = duplicateHashTask.done;
  var tot = duplicateHashTask.total;
  return {
    running: duplicateHashTask.running,
    cancelled: duplicateHashTask.cancelled,
    total: tot,
    done: d,
    // 百分比唯一来源（渲染端不再自己除）：见 `docs/contracts/background-tasks.md` §1.1。
    pct: computePct(d, tot),
    hashed: duplicateHashTask.hashed,
    reused: duplicateHashTask.reused,
    failed: duplicateHashTask.failed,
    skippedMissing: duplicateHashTask.skippedMissing || 0,
    duplicateGroups: duplicateHashTask.duplicateGroups,
    duplicatePhotos: duplicateHashTask.duplicatePhotos,
    currentFile: duplicateHashTask.currentFile,
    currentHash: duplicateHashTask.currentHash,
    phase: duplicateHashTask.phase || 'idle',
    mode: 'pending_only',
    etaSeconds: estimateEtaSecondsSmoothed('dupHash', duplicateHashTask.startedAt, d, tot),
  };
}

/**
 * 重复比对的准入判据 —— **IPC 入口（`maintenance-start-duplicate-hash-detection`）
 * 与任务内部共用这一处**，理由与 `thumbnailBackfillBlockReason()` 完全对称：
 * 过去 IPC 只查 `duplicateHashTask.running`，而任务内部**多一条** `thumbnailBackfill.running`
 * ⇒ 缩略图补全正跑着时点「开始获取」会返回 `{ success: true, started: true }`，
 * 而任务什么都没做（返回值被 `void` 丢弃），界面不给任何提示。
 *
 * 同 `runThumbnailBackfill`：刻意不用 `dbWriteQueue.isBusy()` 当判据（批次化后它会抖）。
 * 两个长任务不并行抢磁盘 —— 否则机械盘随机读写会互相拖垮（各自的批次虽然串行，
 * 但文件读取是并发的）。
 *
 * 🔴 新增拦截条件时**只能加在这里**。
 *
 * @returns {string} 空串 = 放行；否则是可直接展示给用户的原因
 */
function duplicateHashBlockReason() {
  if (optimizeTaskRunning) return '数据库维护进行中';
  if (isFolderScanRunning()) return '扫描进行中，请稍后再试';
  if (thumbnailBackfill.running) return '缩略图补全进行中，请稍后再试';
  // 「全量重跑」与补全是**同一类**占用（逐文件整读 + 抢同一块外接盘），所以拦住补全的
  // 那条判据也必须拦住它。2026-10-07 漏了这条：重跑跑着时点「开始获取」会照常返回
  // `{ success: true }`，而 `runDuplicateHashDetection()` 内部立刻 return（返回值被 void 丢弃）
  // ⇒ 又是那个「点了没反应」。这条由 `thumb-dup-admission-parity-regression` 的三闸行为面钉住。
  if (thumbnailRebuild.running) return '缩略图重建进行中，请稍后再试';
  if (duplicateHashTask.running) return '重复哈希任务已在运行';
  return '';
}

async function runDuplicateHashDetection() {
  const blockReason = duplicateHashBlockReason();
  if (blockReason) {
    logger.warn('[runDuplicateHashDetection] skipped: ' + blockReason);
    return { started: false, reason: blockReason };
  }
  clearDuplicateHashGroupsCache('dup-hash-start');
  duplicateHashTask.running = true;
  duplicateHashTask.cancelled = false;
  duplicateHashTask.done = 0;
  duplicateHashTask.hashed = 0;
  duplicateHashTask.reused = 0;
  duplicateHashTask.failed = 0;
  duplicateHashTask.skippedMissing = 0;
  duplicateHashTask.duplicateGroups = 0;
  duplicateHashTask.duplicatePhotos = 0;
  duplicateHashTask.currentFile = '';
  duplicateHashTask.currentHash = '';
  duplicateHashTask.phase = 'preparing';
  duplicateHashTask.startedAt = Date.now();
  duplicateHashBgLogLastAt = 0;
  duplicateHashBgLog('start', '', true);
  logger.task('dup-hash', 'start', '', { startedAt: duplicateHashTask.startedAt });
  emitBackgroundTasksChangedThrottled(true);
  try {
    /** 先让出主循环；待比对总数与收尾统计走只读 Worker，避免大库 COUNT/GROUP BY 占死主进程 */
    await new Promise(function (resolve) {
      setImmediate(resolve);
    });
    await dbWriteQueue.run(
      'dup-hash',
      function () {
        if (db && typeof db.ensureDuplicateHashSchema === 'function') {
          db.ensureDuplicateHashSchema();
        }
      },
      { priority: PRIORITY.INDEX },
    );
    var readPathDup = sqliteDbPath;
    if (!readPathDup) {
      throw new Error('duplicate-hash: database path unavailable');
    }
    duplicateHashTask.currentFile = '正在统计待比对数量…';
    duplicateHashTask.phase = 'counting';
    duplicateHashBgLog('counting.start', '', true);
    var totalPromise = runDbReadWorkerOnly(readPathDup, 'getHashAllPhotoCount', {})
      .then(function (n) {
        var total = Number(n) || 0;
        // 统计完成时 done 可能已前进，取更大值避免显示倒退
        duplicateHashTask.total = Math.max(total, Number(duplicateHashTask.done) || 0);
        duplicateHashBgLog('counting.done', 'total=' + String(duplicateHashTask.total), true);
      })
      .catch(function (eCount) {
        console.warn(
          '[duplicate-hash] count pending-only failed, continue without total:',
          eCount && eCount.message ? eCount.message : eCount,
        );
      })
      .finally(function () {
        if (duplicateHashTask.currentFile === '正在统计待比对数量…') {
          duplicateHashTask.currentFile = '';
        }
        emitBackgroundTasksChangedThrottled(false);
      });

    // 🔴 倒序游标：起点比 MAX(id) 大一格（与缩略图补全同一条策略 —— 新导入的先算指纹）
    var beforeId = db.getMaxPhotoId() + 1;
    duplicateHashTask.phase = 'hashing';
    duplicateHashBgLog('hashing.start', 'batchSize=2000 subChunk=24', true);
    var batchSize = 2000;
    /** 子批大小：控制「停止比对」后最多再算完多少张；并与并发路数相协调 */
    var subChunkSize = 24;
    var yieldEvery = 20;
    while (true) {
      if (duplicateHashTask.cancelled) break;
      // 交互抢占：与缩略图回填同理，在入队之前让位
      await interactionPreempt.awaitIdle();
      await yieldForPreviewPlaybackMs(80);
      var rows = db.getHashAllPhotosBefore(beforeId, batchSize);
      if (!rows || rows.length === 0) break;
      for (var sc = 0; sc < rows.length; sc += subChunkSize) {
        if (duplicateHashTask.cancelled) break;
        // 外层一批 2000 行会切成几十个子批，只在外层查一次不够 —— 用户搜图可能正好
        // 落在这批的中段，那时离下一个外层检查点还有很久。
        await interactionPreempt.awaitIdle();
        await yieldForPreviewPlaybackMs(20);
        // const 而非 var：下面要在闭包里引用它，块作用域保证每次迭代捕获到的是当轮子批
        const slice = rows.slice(sc, sc + subChunkSize);
        // 与缩略图回填同理：每个子批重新排队，让启动期写库任务能插进批次之间。
        await dbWriteQueue.run(
          'dup-hash',
          function () {
            return processDupHashRowsChunk(slice, yieldEvery);
          },
          { priority: PRIORITY.INDEX },
        );
      }
      // 倒序：本批最后一行是**最小** id，游标严格递减 —— 不会重复算刚失败的行
      beforeId = rows[rows.length - 1].id;
      duplicateHashBgLog(
        'batch.done',
        'beforeId=' + String(beforeId) + ' rows=' + String(rows.length),
        false,
      );
      emitBackgroundTasksChangedThrottled(false);
    }
    await totalPromise;

    if (!duplicateHashTask.cancelled) {
      duplicateHashTask.phase = 'summarizing';
      duplicateHashTask.currentFile = '正在汇总重复组…';
      duplicateHashBgLog('summarizing.start', '', true);
      await new Promise(function (resolve) {
        setImmediate(resolve);
      });
      duplicateHashTask.duplicateGroups = await runDbReadWorkerOnly(
        readPathDup,
        'getDuplicateGroupCountByHash',
        {
          minCount: 2,
        },
      );
      duplicateHashTask.duplicatePhotos = await runDbReadWorkerOnly(
        readPathDup,
        'getDuplicatePhotoCountByHash',
        {
          minCount: 2,
        },
      );
      try {
        var warm = await runDbReadWorkerOnly(readPathDup, 'getDuplicateHashGroupsBundle', {
          page: 1,
          pageSize: duplicateHashGroupsCache.pageSize,
          minCount: duplicateHashGroupsCache.minCount,
        });
        duplicateHashGroupsCache.total = Number(warm && warm.total) || 0;
        duplicateHashGroupsCache.totalPages = Number(warm && warm.totalPages) || 0;
        duplicateHashGroupsCache.pages[1] = Array.isArray(warm && warm.groups) ? warm.groups : [];
        duplicateHashGroupsCache.warmedAt = Date.now();
        if (isDev) {
          logger.log(
            '[dup-groups-cache] warmed page=1 groups=%d total=%d',
            duplicateHashGroupsCache.pages[1].length,
            duplicateHashGroupsCache.total,
          );
        }
      } catch (eWarm) {
        void eWarm;
      }
      duplicateHashBgLog(
        'summarizing.done',
        'groups=' +
          String(duplicateHashTask.duplicateGroups || 0) +
          ' photos=' +
          String(duplicateHashTask.duplicatePhotos || 0),
        true,
      );
    } else {
      duplicateHashBgLog('cancelled', '', true);
    }
    duplicateHashBgLog('finish', '', true);
    logger.task(
      'dup-hash',
      'done',
      'hashed=' +
        duplicateHashTask.hashed +
        ' failed=' +
        duplicateHashTask.failed +
        ' groups=' +
        duplicateHashTask.duplicateGroups,
      { startedAt: duplicateHashTask.startedAt },
    );
    return { started: true };
  } catch (eRun) {
    duplicateHashBgLog('error', eRun && eRun.message ? eRun.message : String(eRun), true);
    logger.task('dup-hash', 'error', eRun && eRun.message ? eRun.message : String(eRun), {
      startedAt: duplicateHashTask.startedAt,
    });
    throw eRun;
  } finally {
    duplicateHashTask.running = false;
    duplicateHashTask.currentFile = '';
    duplicateHashTask.currentHash = '';
    duplicateHashTask.phase = duplicateHashTask.cancelled ? 'cancelled' : 'idle';
    duplicateHashTask.startedAt = 0;
    emitBackgroundTasksChangedThrottled(true);
  }
}

async function tryRunThumbnailBackfillWhenIdle() {
  // 队列与扫描都空闲时再自动补图
  if (isScanQueueProcessing || scanQueue.length > 0 || isFolderScanRunning()) {
    // 🔴 这里的 `return` 等于「**本会话不再自动补**」：`scheduleAutoThumbnailBackfill`
    //    只给一次机会，只有扫描**成功**结束时才会重新排（见 `processScanQueue`）。
    //    过去这里静默返回 ⇒「开关开着却一直不补」完全无迹可查，
    //    只能靠用户报「十小时没动」才发现。打点落盘（`startup-performance.json`）。
    startupStageLog('auto-thumb-backfill.skip', 'scan busy（本会话不再自动重试）');
    return;
  }
  if (thumbnailBackfill.running) {
    startupStageLog('auto-thumb-backfill.skip', 'already running');
    return;
  }
  const result = await runThumbnailBackfill();
  if (result && result.started === false) {
    startupStageLog('auto-thumb-backfill.skip', result.reason || 'unknown');
  }
}

function scheduleAutoThumbnailBackfill() {
  if (autoBackfillScheduled) return;
  autoBackfillScheduled = true;
  setTimeout(async function () {
    autoBackfillScheduled = false;
    try {
      await tryRunThumbnailBackfillWhenIdle();
    } catch (e) {
      if (isDev) {
        logger.error('[AUTO-THUMB-BACKFILL] failed:', e && e.message ? e.message : String(e));
      }
    }
  }, 300);
}

/**
 * Live Photo 配对 —— 常驻、幂等、**没有设置开关**。
 *
 * 🔴 为什么刻意不做成开关（不像 autoHash / autoThumbBackfill）：它修的是**数据正确性**
 *    而不是可选的性能优化。不跑，Live Photo 的伴生 MOV 就会作为独立视频混进列表与统计，
 *    同一张图片在库里出现两次 —— 用户看到的是「一张图片有两个条目」，而他没有任何
 *    开关可以修。而且它天然幂等：只认领 `live_still_id IS NULL` 的行，首次全量跑完后
 *    每轮启动只剩「上次之后新导入的 MOV」，通常就是 0 个（不读盘、不写库，毫秒级返回）。
 *
 * 优先级 `IDLE`：真库首次有 4554 个候选，要读几千个文件头，必须让用户操作与
 * 「有终点的」修复类任务先走。放进写闸门的是**按批**提交的小事务（读盘在锁外），
 * 不会长时间独占写锁。
 *
 * 扫描期间主动让路（`shouldStop`）：扫描整段独占写闸门，且此刻库里正有大量行
 * 处于「刚插入、尚未配对」的中间态 —— 现在去配对等于对一批半成品下结论。
 */
var livePhotoPairingScheduled = false;
var livePhotoPairModule = null;

function loadLivePhotoPair() {
  if (!livePhotoPairModule) {
    livePhotoPairModule = require('./main/live-photo-pair');
  }
  return livePhotoPairModule;
}

/**
 * @param {string} reason 'startup' | 'after-scan'，只用于日志打点
 */
async function runLivePhotoPairingTask(reason) {
  if (!db || !db.db) return null;
  try {
    var stats = await loadLivePhotoPair().runLivePhotoPairing({
      db: db.db,
      queue: dbWriteQueue,
      priority: PRIORITY.IDLE,
      shouldStop: function () {
        return isFolderScanRunning();
      },
    });
    if (stats && stats.scanned > 0) {
      startupStageLog(
        'live-photo-pair.' + String(reason || ''),
        'scanned=' + stats.scanned + ' matched=' + stats.matched,
      );
      // 配对结果改变了「视频档 / 所有档」的集合（伴生视频被排除在外）⇒ 读池里
      // 记忆化的总数与列表缓存必须失效，否则界面会拿旧数字解释新列表。
      // 只在真的扫过东西时才失效：常态下本任务 scanned=0，不该动任何缓存。
      dbReadWorkerPool.invalidateReadCaches();
    }
    return stats;
  } catch (ePair) {
    logger.error(
      '[live-photo] pairing failed:',
      ePair && ePair.message ? ePair.message : String(ePair),
    );
    return null;
  }
}

function scheduleLivePhotoPairing(delayMs) {
  if (livePhotoPairingScheduled) return;
  livePhotoPairingScheduled = true;
  setTimeout(function () {
    livePhotoPairingScheduled = false;
    void runLivePhotoPairingTask('startup');
  }, typeof delayMs === 'number' ? delayMs : 1200);
}

/**
 * 自动查重被「扫描忙」推迟的次数。**只用于日志汇总**，不放宽任何抢占逻辑。
 *
 * 🔴 为什么需要它：这个排程每 5 秒会被自己重试一次，过去每次重试都打两条 stage
 * （`auto-dup-hash.schedule` + `auto-dup-hash.defer`），而 `startup-metrics` 的 stage
 * 数组有**条数上限** —— 两分钟就能把额度吃光，之后 `renderer.first-grid-paint`、
 * 扫描结束、看门狗超时**全部被静默丢弃**。线上那次「自动扫描失败」的现场就是这么丢的：
 * `startup-performance.json` 停在 115.9s，看起来像「记录中断」，其实是额度用完。
 */
var autoDuplicateHashDeferCount = 0;

function scheduleAutoDuplicateHashDetection() {
  if (autoDuplicateHashScheduled) return;
  // 重试进来的调用不再重复打 schedule 点（见上方注释）：只保留第一次
  var isRetry = autoDuplicateHashDeferCount > 0;
  autoDuplicateHashScheduled = true;
  if (!isRetry) startupStageLog('auto-dup-hash.schedule', 'delay=700ms');
  if (autoDuplicateHashRetryTimer) {
    clearTimeout(autoDuplicateHashRetryTimer);
    autoDuplicateHashRetryTimer = null;
  }
  setTimeout(async function () {
    autoDuplicateHashScheduled = false;
    if (!settings.autoHashOnStartup) return;
    // 与扫描互斥，减少机械盘随机读写竞争
    if (isScanQueueProcessing || scanQueue.length > 0 || isFolderScanRunning()) {
      autoDuplicateHashDeferCount += 1;
      // 只打**第一条**：这个分支每 5 秒就会走到一次，逐条打点会吃光 stage 额度（见变量注释）
      if (autoDuplicateHashDeferCount === 1) {
        startupStageLog('auto-dup-hash.defer', 'scan busy, retry every 5000ms');
      }
      autoDuplicateHashRetryTimer = setTimeout(function () {
        autoDuplicateHashRetryTimer = null;
        scheduleAutoDuplicateHashDetection();
      }, 5000);
      return;
    }
    if (duplicateHashTask.running) return;
    try {
      startupStageLog(
        'auto-dup-hash.start',
        autoDuplicateHashDeferCount > 0 ? 'deferredTimes=' + autoDuplicateHashDeferCount : '',
      );
      await runDuplicateHashDetection();
      startupStageLog('auto-dup-hash.done', 'deferredTimes=' + autoDuplicateHashDeferCount);
    } catch (e) {
      startupStageLog('auto-dup-hash.error', e && e.message ? e.message : String(e));
      if (isDev) {
        logger.error('[AUTO-DUP-HASH] failed:', e && e.message ? e.message : String(e));
      }
    }
  }, 700);
}

/**
 * 启动后自动跑「搜图索引」与「人脸索引」——设置页「启动后自动执行」的第 4、5 项。
 *
 * 🔴 **这两个是「跑到底」**（2026-10-06 用户拍板）。语义索引与人脸索引都**刻意不设墙钟超时**
 * （见 `semantic-search.js#spawn`：大库可能跑数天，固定 deadline 只会杀掉健康的长任务，
 * 它们有显式取消），所以一旦开跑就会占着 AI 索引槽位直到跑完或用户手动取消。
 * 这是刻意选的语义，**不要再给它们加时限**。
 *
 * 🔴 与扫描的关系是**让路**，不是并行：两者都吃同一块盘的随机 IO（本机 `K:\COS` 是
 * USB 外接机械盘）。让路用**无限延后重试**表达 —— 与「跑到底」的选择一致，不设次数上限。
 * ⚠️ 但 defer **只打第一条**：`startup-metrics` 的 stage 数组有条数上限，
 * 每 5 秒打一条会在两分钟内把首屏与扫描结局全挤掉（2026-10-06 那次故障现场就是这么丢的，
 * 见 `startup-metrics.js#MAX_STAGES`）。
 *
 * 🔴 走 `run('index')` 而不是 `start('index')`：`start` 是**发射后不管**（`void run(...)`），
 * 拿不到结束与失败，而这两条恰恰是排查时唯一想看的东西。两者最终调的是同一个 `run()`，
 * 路径等价（`start` 多一层 operation 白名单与 worker 冲突校验，这里已各自判过）。
 */
var autoAiIndexTasks = {
  semantic: { scheduled: false, started: false, deferCount: 0, reportedBusy: false },
  face: { scheduled: false, started: false, deferCount: 0, reportedBusy: false },
};

function scheduleAutoAiIndexOnStartup(kind, delayMs) {
  var isSemantic = kind === 'semantic';
  var state = autoAiIndexTasks[kind];
  if (!state || state.scheduled) return;
  var enabled = isSemantic
    ? settings.autoSemanticIndexOnStartup
    : settings.autoFaceIndexOnStartup;
  if (!enabled) return;
  var service = isSemantic ? semanticSearch : faceService;
  if (!service) return;
  var label = isSemantic ? 'auto-semantic-index' : 'auto-face-index';
  state.scheduled = true;
  var delay = parseInt(delayMs, 10) > 0 ? parseInt(delayMs, 10) : isSemantic ? 1200 : 1600;
  setTimeout(async function () {
    state.scheduled = false;
    if (state.started) return;
    // 自己已经在跑（可能是用户手动点的）：不重复启动，也不必重试
    if (service.status().running) {
      if (!state.reportedBusy) {
        state.reportedBusy = true;
        startupStageLog(label + '.skip', 'already running');
      }
      return;
    }
    var scanBusy = isScanQueueProcessing || scanQueue.length > 0 || isFolderScanRunning();
    // canRun() 返回的是**错误码**而不是布尔（'AI_MAINTENANCE' / false），照原样放进日志
    var gate = scanBusy
      ? 'SCAN_BUSY'
      : typeof service.canRun === 'function'
        ? service.canRun()
        : true;
    if (gate !== true) {
      state.deferCount += 1;
      if (state.deferCount === 1) {
        startupStageLog(label + '.defer', 'busy=' + String(gate) + ', retry every 5000ms');
      }
      setTimeout(function () {
        scheduleAutoAiIndexOnStartup(kind, 5000);
      }, 5000);
      return;
    }
    state.started = true;
    try {
      startupStageLog(
        label + '.start',
        state.deferCount > 0 ? 'deferredTimes=' + state.deferCount : '',
      );
      await service.run('index');
      startupStageLog(label + '.done', 'deferredTimes=' + state.deferCount);
    } catch (e) {
      // 失败允许下次启动再来一遍（本次会话不自动重排，免得失败后 5 秒一撞变成日志洪水）
      state.started = false;
      startupStageLog(label + '.error', e && e.message ? e.message : String(e));
    }
  }, delay);
}

/**
 * 跑一批「清理失效记录」。
 *
 * ⚠️ 这**不只是读**：`cleanupMissingFilesYielding` 内部是
 * `BEGIN TRANSACTION … DELETE FROM photos WHERE id = ? … COMMIT`，是一段独占写锁的事务。
 * 它过去两个调用点（启动期顺带清理 / 用户手动清理）都直接调用、**不认识写库队列**，
 * 于是「批量 DELETE」和「启动期缩略图标记修复 / 延迟索引 / FTS 维护」会同时抢同一把写锁：
 * 谁先拿到谁跑，后到的只能靠 `busy_timeout = 8000` 硬等，超了就 `database is locked`。
 * 实测（2026-09-29 真库启动记录）里 `invalid-cleanup` 的批次与队列里第一个任务的窗口
 * 完全重叠，只是那批恰好 `deleted = 0`（没真的写）才没炸。
 *
 * 所以从队列里排队走：同一时刻只有一个人持写锁。这里只包**单批**、不包整个清理循环，
 * 批次之间队列会空出来给扫描 / 其他维护插队，不会被一个长清理长期霸占。
 */
function runInvalidCleanupBatch(options) {
  // REPAIR：删的是磁盘上已不存在的记录，属**数据正确性**；虽只包单批，也不该被建索引的活压后
  return dbWriteQueue.run(
    'invalid-cleanup',
    function () {
      return db.cleanupMissingFilesYielding(options);
    },
    { priority: PRIORITY.REPAIR },
  );
}

/**
 * 失效清理被「别人忙」推迟的次数。**只用于打点收敛与日志汇总**，不放宽避让判断本身。
 *
 * 🔴 为什么需要它（与 `autoDuplicateHashDeferCount` 同一个病，这是漏掉的第二个入口）：
 * 下面那个让路分支每 5 秒会走到一次，过去**每次都打一条 stage**。`startup-metrics`
 * 的 stage 数组有上限（400 条），而这条打点的持续时长 = 「缩略图补全跑多久」——
 * 本机实测补全剩 33.2 万张 ≈ 6.4 小时，打满就是 4,600 条。当前没炸只是因为启动指标
 * 采集有 120s deadline 把它们挡在额度外（实测 120s 内 21 条），**那是运气**：
 * deadline 一变长就会重演 `auto-dup-hash` 那次「故障现场被挤掉、记录停在半截」的事故。
 * 口径与它保持一致：**只打第一条 + 收尾汇总**。
 */
var invalidCleanupDeferCount = 0;
/** 「被推迟过才补打」的那条 `invalid-cleanup.start` 是否已打过（避免每批都打）。 */
var invalidCleanupStartLogged = false;

function scheduleStartupInvalidCleanup() {
  if (startupInvalidCleanupTask.running) return;
  startupInvalidCleanupTask.running = true;
  // 倒序游标：0 = 不限上界（从最新记录往下扫，见 database.js#cleanupMissingFilesYielding）
  startupInvalidCleanupTask.beforeId = 0;
  startupStageLog('invalid-cleanup.schedule', 'startDelay=4500ms batch=400');
  /** 与 schedulePostWindowDeferredTasks 错开；小批量 + 间隔 + exists 让出，避免主进程假死 */
  var START_DELAY_MS = 4500;
  var STEP_DELAY_MS = 450;
  var RETRY_DELAY_MS = 5000;
  var BATCH_SIZE = 400;

  function finish() {
    startupStageLog(
      'invalid-cleanup.finish',
      'beforeId=' +
        String(startupInvalidCleanupTask.beforeId || 0) +
        (invalidCleanupDeferCount > 0 ? ' deferredTimes=' + invalidCleanupDeferCount : ''),
    );
    startupInvalidCleanupTask.running = false;
    if (startupInvalidCleanupTask.timer) {
      clearTimeout(startupInvalidCleanupTask.timer);
      startupInvalidCleanupTask.timer = null;
    }
  }

  function step() {
    if (!startupInvalidCleanupTask.running || !db) return finish();
    // 只避让「交互」与「扫描」—— 这两条才是本函数最初、也是仅有的避让理由
    //（原注释原文即「降低对交互和扫描的影响」）。**刻意不再避让缩略图补全 / 重复比对**：
    // ① 它俩是 INDEX 档的长任务（本机补全一次约 6.4 小时），避让 = 失效清理被**无限期**
    //    推迟；而本函数的 `PRIORITY.REPAIR`（=1，高于 INDEX=2）正是为「数据正确性优先于
    //    建索引」而设的 —— 避让发生在**入队之前** ⇒ 那个优先级对它们永远用不上，自相矛盾。
    // ② 本任务只做 `fs.existsSync`（元数据），不读文件内容、不解码，与补全抢的不是同一类
    //    I/O；真正需要写锁的 DELETE 段既被 `dbWriteQueue` 串行化，又因失效记录极稀而
    //    绝大多数批次压根不开事务（见 database.js#cleanupMissingFilesYielding）。
    // 实测（本机 165.7 万行真库）：每批 400 行占队列 40~385 ms（冷热差 10×，热态
    // 100~160 ms），相对补全一批约 7 s 只是 2.0%~5.5% 的额外延迟；2000 行样本里失效 0 行。
    if (
      isFolderScanRunning() ||
      // 用户正在搜图：这条是**抢占**（任务停下）
      interactionPreempt.active() ||
      // 预览播放：**降载**（照跑但降并发）
      previewPlaybackActive
    ) {
      invalidCleanupDeferCount += 1;
      // 只打**第一条**：这个分支每 5 秒会走到一次，逐条打点会吃光 stage 额度（见变量注释）
      if (invalidCleanupDeferCount === 1) {
        startupStageLog('invalid-cleanup.defer', 'busy, retry in 5000ms');
      }
      startupInvalidCleanupTask.timer = setTimeout(step, RETRY_DELAY_MS);
      return;
    }
    if (typeof db.cleanupMissingFilesYielding !== 'function') {
      finish();
      return;
    }
    // 被推迟过才补一条：正常路径（没被挡）保持原有打点数不变，不多消耗 stage 额度。
    // 这条是「等了多少次才真正开始」的唯一现场 —— 否则只能从 defer 与 finish 两条去反推。
    if (invalidCleanupDeferCount > 0 && !invalidCleanupStartLogged) {
      invalidCleanupStartLogged = true;
      startupStageLog('invalid-cleanup.start', 'deferredTimes=' + invalidCleanupDeferCount);
    }
    // 队列里排队跑：这批是写事务，别和启动期迁移抢写锁。
    runInvalidCleanupBatch({
      batchSize: BATCH_SIZE,
      beforeId: startupInvalidCleanupTask.beforeId,
      existsSyncSlice: 64,
    })
      .then(function (r) {
        if (!startupInvalidCleanupTask.running || !db) return finish();
        startupInvalidCleanupTask.beforeId =
          Number(r && r.lastId) > 0 ? Number(r.lastId) : startupInvalidCleanupTask.beforeId;
        // 这一批真的删了行 ⇒ `getPhotos` 的 total 记忆化立刻作废（见 photos-total-cache.js）。
        // 只在这条路径上清是**刻意**的：这个任务每 5 秒一批、本机实测绝大多数批次 deleted = 0，
        // 无条件清等于每 450ms 打自己一巴掌，缓存形同虚设。
        // ⚠️ 这条路径**不进** `invalidateCatalog*Safe()`（它删的是行、不动目录结构），所以要单独清。
        if (Number(r && r.deleted) > 0) {
          try {
            dbReadWorkerPool.invalidateReadCaches();
          } catch (eInv) {
            void eInv;
          }
        }
        if (isDev && r && r.checked) {
          logger.log(
            '[startup] invalid-cleanup chunk checked=%d deleted=%d lastId=%d',
            Number(r.checked) || 0,
            Number(r.deleted) || 0,
            Number(r.lastId) || 0,
          );
        }
        if (!r || !r.hasMore || !r.checked) {
          return finish();
        }
        startupInvalidCleanupTask.timer = setTimeout(step, STEP_DELAY_MS);
      })
      .catch(function (e) {
        logger.error('[startup] invalid-cleanup failed:', e && e.message ? e.message : String(e));
        finish();
      });
  }

  startupInvalidCleanupTask.timer = setTimeout(step, START_DELAY_MS);
}

/**
 * 首屏 did-finish-load 后再跑：这里只剩「连接级 PRAGMA」与「is_favorite 列补齐」。
 *
 * 🔴 **启动期写库任务的顺序不再由这里决定**（T5）：缩略图标记修复 / 索引补齐 / FTS
 * 过去各自 `setTimeout(+5s / +6s)` 点火，还要先 5s 轮询一次 `maintenanceBusy()`，
 * 实际顺序是「触发时刻 + 排队时间」的偶然组合 —— 结果只是建**性能索引**的 FTS
 * 常常排在修**数据正确性**的修复类之前。现在它们统一在 `submitStartupWriteTasks()`
 * 里**同一时刻**入队，先后由 `db-write-queue` 的 `(priority, seq)` 表达。
 *
 * 这里留下的两类刻意不进写库队列：
 *   ① `cache_size` / `mmap_size` —— 只作用于本连接的 PRAGMA，**不写库文件**，
 *      进队列反而会占住一把它根本不需要的锁；
 *   ② `is_favorite` 列 / 索引补齐 —— 它是唯一必须**早于**提交器的写库语句：
 *      UI 第一次查 `is_favorite` 时列必须已在，而此刻（首窗后 250ms）写库队列还是空的
 *      （提交器要等 browse-ui-ready），不存在撞锁。
 */
var postWindowDeferredTasksDone = false;
function schedulePostWindowDeferredTasks() {
  if (postWindowDeferredTasksDone) return;
  postWindowDeferredTasksDone = true;
  startupStageLog('post-window-deferred.schedule');
  // 两个 PRAGMA 合并成一次调用：过去 cache 在 +250ms、mmap 在 +2200ms，
  // 中间那 2 秒里 mmap 没开、读被放大（`applyDeferredIoPragmas` 是 database.js 已有的合并入口）。
  setTimeout(function () {
    try {
      if (db && typeof db.applyDeferredIoPragmas === 'function') {
        db.applyDeferredIoPragmas();
        startupStageLog('post-window-deferred.io-pragmas.done');
      }
    } catch (eP) {
      logger.error(
        '[startup] deferred-io-pragmas failed:',
        eP && eP.message ? eP.message : String(eP),
      );
    }
  }, 250);
  setTimeout(function () {
    try {
      if (db && typeof db.ensurePhotosIsFavoriteColumn === 'function') {
        db.ensurePhotosIsFavoriteColumn();
      }
    } catch (eFav) {
      logger.error(
        '[startup] deferred-favorite-column failed:',
        eFav && eFav.message ? eFav.message : String(eFav),
      );
    }
  }, 250);
  /**
   * 启动期 GPU 能力探测（+6s）。
   *
   * ## 为什么排在这里、为什么不更早
   *   ① 它**不是**首屏所需 —— 没有任何界面元素等它，早跑只会和「扫库 + 载缩略图 + 目录树」
   *      抢 CPU 与磁盘（探测自己也要载 ONNX 运行时、初始化 D3D12 设备）；
   *   ② 也**不能更晚到「用户点了建索引才跑」** —— 那时探测的两秒会摊进索引任务的启动里，
   *      而且「有没有 GPU」这个结论本来就应该在动手之前就知道（它是准入信息，不是任务副产品）。
   *
   * ## 为什么**不**在「AI 任务正在跑」时跳过（这里改过一次，别改回去）
   *   本版最初写的是「AI 忙就整轮跳过 + 打一条日志」。那个设计有个**界面说不圆**的洞：
   *   跳过一次 ⇒ `gpuProbe` 整轮没产出结论 —— 首次启动时那一行永远停在「检测中…」（用户会一直等），
   *   而非首次启动时它拿着上次的落盘值补一句「本次正在重测」——**本次根本没探**。
   *   界面是这功能存在的唯一理由（生产档 logger 是 warn，用户不会翻日志），所以不能说假话。
   *   而省下的代价也不值得：探测是**独立 worker** 里的一个 168 B 卷积（本机整轮 2.4 s，
   *   挂死另有 60 s 上限），且当前**所有 AI 任务都跑 CPU**（换 EP 属 M5）⇒ 并不存在
   *   「两个 dml 设备抢」这件事可避。
   *   ⚠️ 将来若真有任务用上 dml、且实测这 2 秒会打扰它，也**不许**改回静默跳过 ——
   *   要么把时机挪开，要么给「本次未探测」一个**独立的、界面显示得出来的状态**。
   */
  setTimeout(function () {
    if (!gpuProbe) return;
    void gpuProbe.ensure();
  }, 6000);
}

/** 自动扫描 / 补图 / 人脸等：等侧栏目录树首屏渲染完成后再启动，避免与目录 IPC 抢时序；12s 兜底仍可能触发 */
var autoStartupTasksRan = false;
var browseUiReadyStartupTimer = null;
/** 启动期写库任务是否已提交；browse-ui-ready 与 12s 兜底都会调，靠它幂等 */
var startupWriteTasksSubmitted = false;

/**
 * 延迟索引补齐 worker。那批 `CREATE INDEX` / `ALTER TABLE` 的**唯一定义处**是
 * `src/workers/deferred-index-worker.js`（主线程那套同步副本已于 2026-09-29 删除，
 * 别在主线程再加一份 —— 那等于在启动路径上拿主进程跑大表 CREATE INDEX 并长期独占写锁）。
 * （刻意不写条数：散文里的数字没人校，必然漂。）
 *
 * 返回的 Promise 在 **worker 退出（连接关掉）之后**才 resolve，不是消息到达时 ——
 * 连接还开着就等于还占着库，调用方要拿它把这段时间登记进写库队列，
 * 否则维护 worker 会在它跑到一半时点火，等满 `busy_timeout = 8000` 撞 `database is locked`。
 */
function runDeferredIndexWorker() {
  if (!sqliteDbPath) return Promise.resolve();
  return new Promise(function (resolve) {
    var path = require('path');
    var Worker = require('worker_threads').Worker;
    var worker;
    try {
      worker = new Worker(path.join(__dirname, 'workers', 'deferred-index-worker.js'), {
        workerData: { dbPath: sqliteDbPath },
      });
    } catch (eSpawn) {
      // 起不来也要 resolve：这个 Promise 不 settle 会把整条写库队列永久卡住。
      startupStageLog(
        'deferred-index.worker.done',
        JSON.stringify({ failed: true, error: eSpawn && eSpawn.message }),
      );
      resolve();
      return;
    }
    var reported = null;
    worker.on('message', function (msg) {
      // 🔴 逐条建索引进度（带 `__progress`）必须**立刻落盘**，不能像最终结果那样只存进
      //    `reported`、等 worker 退出时才写 —— 建索引是十几分钟级的独占写锁过程，
      //    「退出才写」就等于零现场（2026-10-06 真库上写闸门被占 6 分钟，打点里一条没有，
      //    只能靠库体积有没有涨来猜它是在跑还是死了）。条数很少：只对「真的不存在、
      //    这一轮真的在建」的索引发，已存在的走 `IF NOT EXISTS` 秒过、不发，不会刷爆埋点。
      if (msg && msg.__progress) {
        longTaskStageLog(
          'deferred-index.item.' + String(msg.name),
          msg.kind === 'start'
            ? 'start'
            : 'ms=' + msg.ms + (msg.error ? ' error=' + msg.error : ''),
        );
        return;
      }
      reported = msg;
    });
    worker.on('error', function (eIdx) {
      reported = { failed: true, error: eIdx && eIdx.message ? eIdx.message : String(eIdx) };
      logger.error('[startup] deferred-photo-indexes worker error:', reported.error);
    });
    worker.on('exit', function (code) {
      startupStageLog('deferred-index.worker.done', JSON.stringify(reported || { exit: code }));
      resolve();
    });
  });
}

/**
 * 提交开机的自动扫描，并**等到它进入写库队列**再返回。
 *
 * 🔴 为什么必须等：`enqueueScanTask` 到 `dbWriteQueue.run('scan')` 之间隔着一次
 * `yieldForPreviewPlaybackMs` 让路（`processScanQueue` 循环开头），而扫描在自己的连接上
 * 逐批 COMMIT —— 是个真实的写者、整段独占写库闸门。提交器若在同一 tick 里接着
 * `run('thumbnail-fix')`，那个 `seq` 更小，同档 FIFO 会把扫描顶到修复类**后面**，
 * 「扫描产出的正是待修复的行，扫描完再修」这个顺序就没了。
 * 等 gate 是最便宜的确定性做法：不改扫描队列结构、不引入「睡 200ms 赌一下」的延迟。
 *
 * @returns {Promise<boolean>} 本次是否真的有扫描要跑
 */
async function submitStartupAutoScan() {
  if (!sqliteDbPath) return false;
  if (!settings.autoScanOnStartup) return false;
  /** 根目录列表仅走只读 Worker（lite），不在主进程同步查库 */
  var roots;
  try {
    roots = await runDbReadWorkerOnly(sqliteDbPath, 'getRootFolders', { lite: true });
  } catch (eRoots) {
    logger.error(
      '[auto-scan-on-startup] getRootFolders worker failed:',
      eRoots && eRoots.message ? eRoots.message : eRoots,
    );
    return false;
  }
  if (!roots || !roots.length) return false;
  startupStageLog('auto-startup.auto-scan.enqueue', 'roots=' + String(roots.length));
  var gates = [];
  for (var i = 0; i < roots.length; i++) {
    enqueueScanTask({ rootPath: roots[i].path, source: 'auto' }).then(function (result) {
      if (!result.success && !result.cancelled) {
        logger.error('Auto scan failed:', result.error || 'unknown error');
      }
    });
    var entry = scanTasksByRoot.get(scanRootKey(roots[i].path));
    if (entry && entry.gate) gates.push(entry.gate);
  }
  await Promise.all(gates);
  return true;
}

/**
 * 修复类（REPAIR）→ 建索引类（INDEX）的提交。**这里的调用顺序 ≠ 执行顺序**：
 * 三个 `run()` 在同一 tick 里入队，实际先后由 `(priority, seq)` 决定（同档才看 seq）。
 *
 * 目标顺序（设计文档 §5）：thumbnail-fix（修数据）→ deferred-index（修数据）→ fts-index（建索引）。
 * 档位差让 fts 必然排在两个 REPAIR 之后，哪怕以后有人调整这里的调用顺序也不会反过来。
 */
function submitStartupRepairAndIndexTasks() {
  // REPAIR：缩略图标记修复 —— 补 `has_thumbnail` / 建缺失索引，修的是**数据正确性**
  void dbWriteQueue
    .run(
      'thumbnail-fix',
      function () {
        if (!db || typeof db.applyDeferredThumbnailFix !== 'function') return null;
        return db.applyDeferredThumbnailFix().then(function (report) {
          // 如实报告：到底建了哪几个索引、扫了多少行 / 修了多少行、花了多久。
          // 旧代码无条件打印「created thumbnail missing indexes」，每次启动都出现，
          // 排查时根本看不出它是在干活还是空转了几十秒。
          logger.log('[db migration] thumbnail-fix', JSON.stringify(report));
          return report;
        });
      },
      { priority: PRIORITY.REPAIR },
    )
    .catch(function (eThumb) {
      logger.error(
        '[startup] deferred-thumbnail-fix failed:',
        eThumb && eThumb.message ? eThumb.message : String(eThumb),
      );
    });

  // REPAIR：索引补齐 —— 缺索引的行检索不到，同属数据正确性
  void dbWriteQueue
    .run('deferred-index', runDeferredIndexWorker, { priority: PRIORITY.REPAIR })
    .catch(function (eIdx) {
      logger.error(
        '[startup] deferred-photo-indexes failed:',
        eIdx && eIdx.message ? eIdx.message : String(eIdx),
      );
    });

  // INDEX：文件名 FTS 索引 —— 建的是**性能索引**，推迟只影响搜索速度，
  // 不该压住修复类与用户手动操作。刻意**不设** `exclusiveMaintenanceRunning`：
  // FTS 是批量写，与 AI 索引共用同一条写库队列，串行由队列保证；
  // 把它算进「独占维护」就是启动期误报 `AI_MAINTENANCE` 的根源（见 ai-index-gate.js）。
  void dbWriteQueue
    .run(
      'fts-index',
      function () {
        startupStageLog('post-window-deferred.fts-worker.start');
        // 🔴「优化中」只在**真正开跑**时置位。排队 ≠ 在跑：提前置会让界面谎报维护中，
        // 还会把用户的手动维护拒之门外（`maintenanceBusy()` 含这个标志）。
        // 清零点仍在 `performMaintenance` 的 finally —— 那里是维护的唯一出口。
        optimizeTaskRunning = true;
        emitBackgroundTasksChangedThrottled(true);
        var settle = function () {
          // 双保险：正常路径下 performMaintenance 的 finally 已经清过；
          // 这里防「它在进自己的 try 之前就抛」导致标志永久残留
          // （那会让 AI 索引被永远拒之门外，而且没有任何报错）。
          optimizeTaskRunning = false;
          emitBackgroundTasksChangedThrottled(true);
        };
        return performMaintenance('ensureFtsIndex').then(
          function (value) {
            settle();
            return value;
          },
          function (error) {
            settle();
            throw error;
          },
        );
      },
      { priority: PRIORITY.INDEX },
    )
    .then(function () {
      startupStageLog(
        'post-window-deferred.fts-worker.' + (maintenanceResult && maintenanceResult.status),
      );
    })
    .catch(function (eFts) {
      logger.error('[startup] fts index failed:', eFts && eFts.message ? eFts.message : String(eFts));
    });
}

/**
 * 启动期写库任务**统一提交点**（T5）。
 *
 * 过去这几个任务各自 `setTimeout` 点火（+5s 缩略图标记修复 / +6s FTS / +8s 延迟索引，
 * 且 FTS 还要先 5s 轮询一次 `maintenanceBusy()`），实际执行顺序是「触发时刻 + 排队时间」
 * 的偶然组合。现在改成：首屏目录树就绪后**一次性**按优先级入队，
 * 先后由 `db-write-queue` 表达 —— 见设计文档 §5。
 *
 * 保留的唯一延迟是调用方那 3.5s（等目录树首屏渲染完），它负责的是
 * **别和 get-root-folders / get-folder-tree 抢只读 IO**，与排序无关。
 *
 * @param {string} reason 'browse-ui-ready' | 'fallback'
 */
function submitStartupWriteTasks(reason) {
  if (startupWriteTasksSubmitted) return;
  startupWriteTasksSubmitted = true;
  startupStageLog('startup-write-tasks.submit', 'reason=' + String(reason || ''));
  // settings 的读取收在这里：auto-scan / auto-hash / auto-thumb-backfill 三个开关都从它取
  reloadSettingsFromDiskSilently();
  void (async function () {
    try {
      await submitStartupAutoScan();
    } catch (eScan) {
      logger.error(
        '[startup] auto-scan submit failed:',
        eScan && eScan.message ? eScan.message : String(eScan),
      );
    }
    // 走到这里：若本次有自动扫描，它已占住写库闸门，下面三个必然排在它后面；
    // 没开自动扫描时它们就是队首。两种情况下顺序都由优先级表达。
    submitStartupRepairAndIndexTasks();
    // 失效清理：分批循环 + 自己的空闲避让（`runInvalidCleanupBatch` 走 REPAIR 档），
    // 每批之间让出队列 —— 上面三个占着队列时它会自动接着等，不再需要「错开 2200ms」的魔数。
    scheduleStartupInvalidCleanup();
  })();
}

/**
 * 自动哈希 / 自动回填。**自动扫描不在这里** —— 它由 `submitStartupWriteTasks()` 提交，
 * 因为「扫描排在修复类之前」需要它与那几个任务同处一个提交点（见那里的注释）。
 *
 * ⚠️ 这两个的 `setTimeout(300 / 700ms)` 不是排序手段，是「等首屏只读查询收尾」的降载延迟；
 * 两者内部都有 `isFolderScanRunning()` 前置判断，扫描期间会主动让路，
 * 而扫描结束（`processScanQueue` 末尾）也会再触发一次，不会漏。
 */
function runAutoStartupTasksOnce() {
  if (autoStartupTasksRan) return;
  autoStartupTasksRan = true;
  startupStageLog('auto-startup.run');
  if (settings.autoHashOnStartup) {
    scheduleAutoDuplicateHashDetection();
  }
  if (settings.autoThumbBackfillOnStartup) {
    scheduleAutoThumbnailBackfill();
  }
  // Live Photo 配对：**无开关**（它修的是数据正确性，见 `scheduleLivePhotoPairing`
  // 的注释）。刻意排在两个 AI 索引之前 —— 它读几千个文件头，而 AI 索引一旦起跑
  // 就长期占着索引槽位，先让这个「有终点」的任务落地。
  scheduleLivePhotoPairing(1500);
  // 「跑到底」的两个索引任务（见 scheduleAutoAiIndexOnStartup 的注释）。
  // 刻意排在最后：它们启动后会长时间占着 AI 索引槽位，让前面那些「有终点」的任务先落地。
  if (settings.autoSemanticIndexOnStartup) {
    scheduleAutoAiIndexOnStartup('semantic');
  }
  if (settings.autoFaceIndexOnStartup) {
    scheduleAutoAiIndexOnStartup('face');
  }
}

function resolveCloudflaredPath() {
  var candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(process.resourcesPath || '', 'bin', 'cloudflared.exe'));
    candidates.push(path.join(process.resourcesPath || '', 'cloudflared.exe'));
    candidates.push(path.join(process.cwd(), 'bin', 'cloudflared.exe'));
  } else {
    candidates.push(path.join(process.resourcesPath || '', 'bin', 'cloudflared'));
    candidates.push(path.join(process.resourcesPath || '', 'cloudflared'));
    candidates.push(path.join(process.cwd(), 'bin', 'cloudflared'));
  }
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (e0) {}
  }
  try {
    var cmd = process.platform === 'win32' ? 'where' : 'which';
    var r = spawnSync(cmd, ['cloudflared'], { windowsHide: true, encoding: 'utf8' });
    if (r && r.status === 0) {
      var out = String(r.stdout || '')
        .split(/\r?\n/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      if (out.length > 0) return out[0];
    }
  } catch (e1) {}
  return '';
}

function getTunnelPrerequisiteState() {
  var p = resolveCloudflaredPath();
  var ok = !!p;
  return {
    ok: ok,
    path: p,
    message: ok ? '' : '未找到 cloudflared，请安装或将 cloudflared 可执行文件放到 PATH',
  };
}

function getTunnelStatus() {
  var pre = getTunnelPrerequisiteState();
  return {
    enabled: !!tunnelTask.enabled,
    running: !!tunnelTask.running,
    url: tunnelTask.url || '',
    status: tunnelTask.status || 'idle',
    error: tunnelTask.error || '',
    ready: pre.ok,
    binaryPath: pre.path || '',
    prereqMessage: pre.message || '',
    logTail: Array.isArray(tunnelLogTail) ? tunnelLogTail.join('\n') : '',
  };
}

function stopCloudflareTunnelInternal() {
  tunnelLogTail = [];
  if (tunnelStartTimeoutTimer) {
    try {
      clearTimeout(tunnelStartTimeoutTimer);
    } catch (e0) {}
    tunnelStartTimeoutTimer = null;
  }
  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch (e) {}
    tunnelProcess = null;
  }
  tunnelTask.running = false;
  tunnelTask.url = '';
  tunnelTask.status = 'stopped';
}

function startCloudflareTunnelInternal() {
  if (tunnelProcess) return Promise.resolve(getTunnelStatus());
  var pre = getTunnelPrerequisiteState();
  if (!pre.ok) {
    throw new Error(pre.message);
  }
  if (!settings.webPassword || !String(settings.webPassword).trim()) {
    throw new Error('请先设置网页访问密码，再开启 Cloudflare Tunnel');
  }
  if (!webServer || !webServer.port) {
    throw new Error('Web 服务未就绪');
  }
  tunnelTask.running = true;
  tunnelTask.status = 'starting';
  tunnelTask.error = '';
  tunnelTask.url = '';
  tunnelLogTail = [];
  var localUrl = 'http://127.0.0.1:' + webServer.port;
  var proc = spawn(pre.path, ['tunnel', '--url', localUrl, '--no-autoupdate'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnelProcess = proc;
  var outputCarry = '';
  function extractTunnelUrlFromText(text) {
    var raw = String(text || '');
    // 去除常见 ANSI 颜色码，避免匹配失败
    var clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
    var m = clean.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com(?:\/[^\s"']*)?/);
    return m && m[0] ? m[0] : '';
  }
  function pushTunnelLogLines(text) {
    var clean = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
    var lines = clean.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = String(lines[i] || '').trimEnd();
      if (!s) continue;
      tunnelLogTail.push(s);
      if (tunnelLogTail.length > 40) tunnelLogTail.shift();
    }
  }
  function handleOutput(chunk) {
    // cloudflared 输出可能被拆分成多个 chunk，需拼接缓冲后再匹配
    var raw = String(chunk || '');
    pushTunnelLogLines(raw);
    outputCarry += raw;
    if (outputCarry.length > 8192) {
      outputCarry = outputCarry.slice(-4096);
    }
    var u = extractTunnelUrlFromText(outputCarry);
    if (u) {
      tunnelTask.url = u;
      tunnelTask.status = 'running';
      tunnelTask.error = '';
      if (tunnelStartTimeoutTimer) {
        try {
          clearTimeout(tunnelStartTimeoutTimer);
        } catch (eT) {}
        tunnelStartTimeoutTimer = null;
      }
    }
  }
  if (tunnelStartTimeoutTimer) {
    try {
      clearTimeout(tunnelStartTimeoutTimer);
    } catch (eTs0) {}
    tunnelStartTimeoutTimer = null;
  }
  tunnelStartTimeoutTimer = setTimeout(function () {
    if (!tunnelProcess || tunnelProcess !== proc) return;
    if (tunnelTask.url) return;
    tunnelTask.running = false;
    tunnelTask.status = 'error';
    tunnelTask.error = 'Tunnel 启动超时（未获取到公网地址）';
    try {
      proc.kill();
    } catch (eKill) {}
  }, 25000);
  if (proc.stdout) proc.stdout.on('data', handleOutput);
  if (proc.stderr) proc.stderr.on('data', handleOutput);
  proc.on('error', function (err) {
    if (tunnelStartTimeoutTimer) {
      try {
        clearTimeout(tunnelStartTimeoutTimer);
      } catch (eT2) {}
      tunnelStartTimeoutTimer = null;
    }
    tunnelTask.running = false;
    tunnelTask.status = 'error';
    var msg = err && err.message ? err.message : 'cloudflared 启动失败';
    if (err && err.code === 'ENOENT') {
      msg = '未找到 cloudflared，请安装或将 cloudflared 可执行文件放到 PATH';
    }
    tunnelTask.error = msg;
    tunnelProcess = null;
  });
  proc.on('exit', function (code) {
    if (tunnelStartTimeoutTimer) {
      try {
        clearTimeout(tunnelStartTimeoutTimer);
      } catch (eT3) {}
      tunnelStartTimeoutTimer = null;
    }
    tunnelTask.running = false;
    if (tunnelTask.status !== 'error') {
      tunnelTask.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0) tunnelTask.error = 'cloudflared 已退出，代码 ' + code;
    }
    tunnelProcess = null;
  });
  return Promise.resolve(getTunnelStatus());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function quitCompletely() {
  isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch (e) {}
  if (tray) {
    try {
      tray.destroy();
    } catch (e2) {}
    tray = null;
  }
  app.quit();
}

/** 与窗口一致：优先 src/web/app-icon-512.png，其次 src/app-icon.png，再回退 */
function resolveAppIcon() {
  var iconCandidates = [
    path.join(__dirname, 'web', 'app-icon-512.png'),
    path.join(__dirname, 'app-icon.png'),
  ];
  for (var ci = 0; ci < iconCandidates.length; ci++) {
    var iconPath = iconCandidates[ci];
    if (!fs.existsSync(iconPath)) continue;
    try {
      var custom = nativeImage.createFromPath(iconPath);
      if (!custom.isEmpty()) return Promise.resolve(custom);
    } catch (e) {}
  }
  function fromExeFileIcon() {
    return app.getFileIcon(app.getPath('exe'), { size: 'normal' }).then(function (img) {
      if (img && !img.isEmpty()) return img;
      return createTrayIconImage();
    });
  }
  // 打包版在部分 Windows 环境上对安装目录 exe 做 Shell 图标提取会长时间阻塞，窗口永远不出现
  if (process.platform === 'win32' && app.isPackaged) {
    return createTrayIconImage();
  }
  if (process.platform === 'win32') {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        console.warn('[icon] getFileIcon slow, using fallback tray icon');
        createTrayIconImage().then(resolve);
      }, 3000);
      fromExeFileIcon()
        .catch(function () {
          return createTrayIconImage();
        })
        .then(function (img) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(img);
        })
        .catch(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          createTrayIconImage().then(resolve);
        });
    });
  }
  return fromExeFileIcon().catch(function () {
    return createTrayIconImage();
  });
}

function createTrayIconImage() {
  return loadSharp()({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 123, g: 140, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
    .then(function (buf) {
      return nativeImage.createFromBuffer(buf);
    })
    .catch(function () {
      return nativeImage.createFromBuffer(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
    });
}

function getNormalizedUiLocale() {
  return settings && settings.uiLocale === 'en' ? 'en' : 'zh-CN';
}

function getLocalizedAppTitle() {
  return getNormalizedUiLocale() === 'en' ? 'Aurora Gallery' : '拂晓图库';
}

/** 窗口标题、托盘提示与托盘菜单（随 uiLocale 切换） */
function refreshTrayAndTitleLocalized() {
  ensureSettingsShape();
  var en = getNormalizedUiLocale() === 'en';
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setTitle(getLocalizedAppTitle());
    } catch (e) {}
  }
  if (tray) {
    try {
      tray.setToolTip(en ? 'Aurora Gallery (running in background)' : '拂晓图库（后台运行中）');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: en ? 'Show window' : '显示主窗口',
            click: function () {
              showMainWindow();
            },
          },
          { type: 'separator' },
          {
            label: en ? 'Quit Aurora Gallery' : '退出拂晓图库',
            click: function () {
              quitCompletely();
            },
          },
        ]),
      );
    } catch (e2) {}
  }
}

function setupTray(icon) {
  if (tray) return;
  try {
    tray = new Tray(icon);
  } catch (e) {
    if (isDev) console.warn('[tray] unavailable:', e && e.message ? e.message : String(e));
    return;
  }
  refreshTrayAndTitleLocalized();
  tray.on('click', function () {
    showMainWindow();
  });
}

function registerBackgroundShortcut() {
  try {
    globalShortcut.unregister('CommandOrControl+Shift+H');
    globalShortcut.unregister('Control+Q');
  } catch (e) {}
  var ok = globalShortcut.register('Control+Q', function () {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else showMainWindow();
  });
  if (!ok && isDev) console.warn('[shortcut] Ctrl+Q register failed');
}

/* ═══ 为什么主界面（窗口本身）刻意**不做**圆角 ═══════════════════════════════════════
 *
 * 2026-10-05 试过并放弃，别再花时间。三条路全部走死，且都是**实测打掉的**：
 *
 * ① CSS `body { border-radius }` —— 无效。body 没有背景时它的背景会「传播」成整个
 *    canvas 的底（CSS Backgrounds 3 §2.11.2），圆角直接被忽略（两张截图 md5 逐字节相同）。
 * ② 「html/body 透明 + 内层容器圆角」 —— 无效。四角变成**页面透明**，而
 *    `backgroundMaterial: 'acrylic'` 的系统模糊是铺满整个窗口矩形的，透明处露出的是
 *    亚克力底而不是桌面 → 出来是个「四角更淡的方窗口」。
 * ③ 窗口区域裁剪（`win` 的 `setShape`，底层 `SetWindowRgn`）—— **圆角是画出来了，但四角仍然
 *    不是桌面**。实测（4K / 150%，Electron 41）窗口左上角：桌面 = `rgb(248,253,255)`、
 *    窗口内 = `rgb(224,237,251)`、而圆角那条弧带 = `rgb(207,220,233)`，是一条**均匀的
 *    纯亚克力底**（不是渐变，所以也不是窗口阴影）—— 即 `setShape` 只裁掉了**渲染层**，
 *    DWM 的亚克力是其在自己的合成层上铺满整个窗口矩形的，**不跟随窗口区域**。
 *    用户对这条路的原话是「圆角还有底色，如果去不掉就恢复直角」，故整体回退。
 *
 * 结论：**在「窗口背景 = 亚克力」档下，四角的底色去不掉**。想要真圆角就只剩两条：
 *   要么放弃亚克力（`transparent` 但不带 `backgroundMaterial`，四角露桌面但没有毛玻璃，
 *   等于废掉窗口背景这一维）；要么窗口保持矩形、把圆角做到**渲染层的内容卡片**上。
 * 两者都不是「窗口四角圆角」，所以不做。
 *
 * ⚠️ 回归 `scripts/theme-regression.js` 里有一条断言钉着「不许再引入 `setShape` 窗口裁剪」。
 */

function createWindow(appIcon) {
  var winOpts = {
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: getLocalizedAppTitle(),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /** 避免部分环境下 sandbox + contextBridge 触发「object is not iterable」导致窗口闪退 */
      sandbox: false,
    },
  };
  /* 窗口背景 = 亚克力：三者必须**成套**出现，少一个都是坏观感 ——
   *   transparent       让窗口本身没有不透明底板。缺了它，body 再透明也只是「透到窗口自己的
   *                     底色」上（默认是白色），等于把界面洗成灰白。
   *   backgroundColor   '#00000000'（alpha=0）。不给的话 Windows 上首帧会先闪一块纯色底。
   *   backgroundMaterial 让系统模糊的是**桌面**而不是窗口底色 —— 这就是「毛玻璃」本体。
   * ⚠️ 三个都是**创建参数**，运行期改不了（这就是「改这档需重启」的原因）。
   * ⚠️ `backgroundMaterial` 只在 Windows 11 22H2+ 生效，其它平台不传（传了也是忽略）。 */
  // 白名单里除首项（solid）以外的都是透明档。主进程这一侧对三档的处理**完全相同**
  // （都走 transparent + acrylic 材质）——「程度」全部由渲染层 body 那层的 alpha 决定，
  // 见 styles.css 的 `html[data-window-backdrop='...'] body` 那组。
  var backdrop =
    settings && UI_WINDOW_BACKDROP_ALLOWED.indexOf(settings.uiWindowBackdrop) > 0
      ? settings.uiWindowBackdrop
      : 'solid';
  // 记下这个窗口**真正**用的档：渲染层靠它决定要不要给 body 加 alpha（见 windowBackdropAppliedAtLaunch）
  windowBackdropAppliedAtLaunch = backdrop;
  if (backdrop !== 'solid') {
    winOpts.transparent = true;
    winOpts.backgroundColor = '#00000000';
    if (supportsAcrylicBackdrop()) {
      winOpts.backgroundMaterial = 'acrylic';
    } else {
      logger.warn(
        '[window] uiWindowBackdrop=acrylic 但当前系统拿不到亚克力模糊（需要 Windows 11 22H2+），' +
          '将只做「透明」不做「模糊」：platform=%s release=%s',
        process.platform,
        String(os.release() || ''),
      );
    }
  } else {
    /* 🔴 首帧兜底色。窗口在 `new BrowserWindow` 这一刻就已经可见（全工程**没有**
     * `show:false` + `ready-to-show` 闸门），而页面要好几秒才 load 完 —— 本机 122 万张库
     * 实测 `create-window.done` 在 +1.1s、`window.did-finish-load` 在 +7.3s，
     * 也就是说有 **6 秒**窗口里什么都没有。这段空白期的底色就是 `backgroundColor`：
     * 原先 solid 档**完全不给**，走 Electron 默认的纯白，深色主题下是一记很刺眼的白闪。
     * 🔴 只按主题深浅给一个近似值，**不做 22 套预设各自的精确配色** —— 这几百毫秒里
     * 肉眼分不出 `#0a0a18` 与 `#120d09` 的差别，却会造出**第四张主题表**，
     * 破坏「`THEME_STYLE_PRESETS` 是唯一真相源」这条红线（见 CONTRACTS §外观 / §启动首帧）。
     * 取值 = styles.css 里 `--bg` 的两个默认档：深色 `#0a0a18`、浅色 `#f0f2fa`。 */
    winOpts.backgroundColor = settings && settings.theme === 'light' ? '#f0f2fa' : '#0a0a18';
  }
  if (appIcon && !appIcon.isEmpty()) {
    winOpts.icon = appIcon;
  }
  mainWindow = new BrowserWindow(winOpts);
  /* 启动即最大化（2026-10-09）：默认 1400×900 是按 100% 缩放屏定的，高 DPI
   * （本机 dpr≈1.5，1920 物理宽 ⇒ 逻辑只有 1280）下会被 workArea 压到更小，
   * 侧栏导航与浏览工具条都展示不全。最大化以 workArea 为上限，任何屏幕上
   * 都保证完整展示；用户手动还原后按 1400×900 落窗。渲染层本就监听
   * `window-maximized-change` 同步最大化态（见 preload 同名通道），无需新链路。 */
  mainWindow.maximize();

  mainWindow.webContents.on('render-process-gone', function (event, details) {
    var d = details || {};
    logger.error(
      '[renderer] process gone reason=%s exitCode=%s',
      d.reason != null ? d.reason : '',
      d.exitCode != null ? d.exitCode : '',
    );
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isDev) {
    setTimeout(function () {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      } catch (e) {}
    }, 500);
  }

  mainWindow.on('close', function (e) {
    if (isQuitting) return;
    e.preventDefault();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    ensureSettingsShape();
    var behavior = settings.windowCloseBehavior || 'ask';
    if (behavior === 'tray') {
      mainWindow.hide();
      return;
    }
    if (behavior === 'quit') {
      quitCompletely();
      return;
    }
    var wc = mainWindow.webContents;
    if (wc && !wc.isDestroyed() && !wc.isLoading()) {
      wc.send('show-close-chooser');
      return;
    }
    var en = getNormalizedUiLocale() === 'en';
    var res = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: en ? ['Run in background', 'Quit', 'Cancel'] : ['后台运行', '退出程序', '取消'],
      defaultId: 0,
      cancelId: 2,
      title: en ? 'Close Aurora Gallery' : '关闭拂晓图库',
      message: en
        ? 'Minimize to the system tray to keep running in the background, or quit completely.'
        : '请选择：最小化到系统托盘继续后台运行，或完全退出程序。',
      noLink: true,
    });
    if (res === 0) mainWindow.hide();
    else if (res === 1) quitCompletely();
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  mainWindow.on('maximize', function () {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized-change', true);
    }
  });
  mainWindow.on('unmaximize', function () {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized-change', false);
    }
  });
}

// 必须在 app.ready 之前注册，否则 <video> 等媒体元素拒绝从自定义协议加载流
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'video',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'photo',
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true },
  },
  {
    scheme: 'thumb',
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true },
  },
]);

app
  .whenReady()
  .then(function () {
    startupStageLog('app.whenReady');
    var userDataPath = app.getPath('userData');
    /**
     * 🔴 settings.json 必须**先于**数据库路径解析读到：数据目录存在它里面，
     *    而 `new Database()` 一进去就按给定路径建/开库 —— 顺序反了等于永远只能用默认位置。
     *    它本身**刻意留在 userData**（不跟着数据目录走）：迁移后要靠它记住新位置，
     *    也避免「D 盘没插 → 连配置都读不到」这种连环失效。
     */
    settingsFilePath = path.join(userDataPath, 'settings.json');
    loadSettings();
    var dataDirPath = resolveDataDirPath(userDataPath);
    libraryDataDir = dataDirPath;
    var dbPath = path.join(dataDirPath, 'photos.db');
    startupMetrics.setOutput(path.join(userDataPath, 'startup-performance.json'));
    var catalogCachePath = path.join(dataDirPath, 'catalog-cache.db');
    sqliteDbPath = dbPath;
    semanticSearch = new (require('./main/semantic-search').SemanticSearch)(
      dbPath,
      path.join(path.dirname(dbPath), 'ai-search'),
      {
        // 搜图是纯只读：索引进行中把请求托给正在跑的索引 worker（它已经载好模型），
        // 用已落库的向量出结果，于是「边建索引边搜图」成立、结果只覆盖已索引的图片。
        // 不能改成「另起一个 worker」——同一进程里并发载入第二份模型会把进程搞崩（实测）。
        // suggest（预选词打分）与 search 同为只读、同样只需文本编码器，走同一条路。
        concurrentReads: ['search', 'suggest'],
        relayReads: ['search', 'suggest'],
        // 检索与打分都不该冲掉索引进度（percent / processed / currentFile），保留原 phase。
        preserveProgress: ['search', 'suggest'],
      },
    );
    faceService = new (require('./main/face-service').FaceService)(
      dbPath,
      path.join(path.dirname(dbPath), 'face-index'),
    );
    /**
     * 启动期 GPU 能力探测。**每次启动都重探**（不拿旧文件当结论）：驱动更新、换卡、
     * 笔记本的独显直连开关都会改变答案，而这些一年要变好几次。旧文件只用于「本次探测
     * 还没跑完时界面先显示上一次的值」，且会打上 `stale` 标记。
     *
     * ⚠️ 探测本身在 worker 里跑（见 gpu-probe.js）：`InferenceSession.create` 的 `async`
     * 是假的（`setImmediate` 里同步执行 `loadModel`），本机实测 dml 建会话要 **约 2.0 秒**。
     * 放在这里只是**建探测器**，真正的探测在 `schedulePostWindowDeferredTasks` 里点火。
     */
    gpuProbe = createGpuProbe({
      aiPath: semanticSearch.aiPath,
      logger: logger,
    });
    /**
     * 探测结论只挂给**搜图**这一个服务。`status()` 的返回值同时喂着桌面端 IPC 与内嵌网页 API ——
     * 一处挂上，两个运行时一致，不必各自再读一次 `gpu.json`（读两次迟早漂）。
     *
     * ⚠️ **刻意不给人脸服务也挂一份**：`face-service.js#status()` 从不读 `this.gpuInfo`，
     * 挂了也是**无人消费的死接线** —— 读源码的人会以为人脸那条状态里带着 GPU 结论，实际没有
     * （本工程专门有过这类「后端算了、界面永远看不到」的静默失效）。人脸面板目前没有这一行；
     * 哪天要有，就**挂上和渲染一起加**，别为了对称先挂着。
     */
    var gpuInfo = function () {
      return gpuProbe ? gpuProbe.current() : null;
    };
    semanticSearch.gpuInfo = gpuInfo;
    /**
     * 「主题标签」的读取通道。与搜图索引共用同一个 `ai-search` 目录，但它是
     * **独立的只读连接**：标签是索引库里的派生物（见 `src/ai/photo-tags.js`），
     * 而 `getPhotoInfo()` 只连主库、跨不了库。
     *
     * 惰性建连接 —— 从没建过搜图索引的用户不会有任何开销（连文件都不会去 stat 第二次）。
     */
    semanticTags = new (require('./main/semantic-tags').SemanticTags)(
      path.join(path.dirname(dbPath), 'ai-search'),
    );
    /**
     * 「画面标签」（JoyTag）的读取通道 —— 与上面的 `SemanticTags` 平行：
     * 标签在 **tag 索引库**（`ai-search/tag-index.sqlite`）里，同样跨不了主库连接，
     * 惰性只读、读不到降级空数组（没建 tag 库的用户零开销）。
     * 中文映射在通道内做（`ai/tag-zh.js`），桌面与网页两端同源。
     */
    joyTagTags = new (require('./main/semantic-tags').JoyTagTags)(
      path.join(path.dirname(dbPath), 'ai-search'),
      /**
       * 展示线（读侧分数线）**按取值器注入，不传数值**：设置页里改一下 `aiTagDisplayThreshold`
       * 就立刻生效，不需要重启 —— 传数值就得重建这两个服务，而它们各持一条只读连接。
       * ⚠️ 这里**必须写成读模块级 `settings` 的函数**：`reloadSettingsFromDiskSilently()`
       *    是 `settings = Object.assign(...)`，**整个对象被换掉**。写成
       *    `var s = settings; () => s.x` 会永远读到那个已经被丢弃的旧对象 =
       *    「改了没反应」，而且不报错。
       */
      { displayMinScore: function () { return settings.aiTagDisplayThreshold; } },
    );
    /**
     * 「标签导航页」的数据服务（分类树 / 节点下的标签 / 某标签有哪些图）。
     *
     * 与 `joyTagTags` 同一类来源（tag 索引库），但职责**刻意切开**：
     * 本服务只碰 tag 库、只返回有序的 `photo_id`；回主库取照片**行**由下面的 IPC
     * handler 做（`photoListColumns()` + `idListPredicate()`）。
     * 这样「tag 库读不到」与「主库读不到」是两种独立故障，各自的降级互不牵连。
     */
    tagNav = new (require('./main/tag-nav').TagNav)(
      path.join(path.dirname(dbPath), 'ai-search'),
      /** 展示线取值器：与上一条 `joyTagTags` **必须是同一个来源**（同一个设置键），
       *  否则「卡片写几张」和「面板列着什么」会按两条线算，界面还是看不出来。 */
      { displayMinScore: function () { return settings.aiTagDisplayThreshold; } },
    );
    /**
     * 启动后顺手补一次「主题标签」，补完再通知渲染端重画面板。
     *
     * ## 为什么必须有这一步
     *
     * 标签只在**建索引时**才算得出来（那一刻图片向量才在手上）。所以升级前就已经索引好的
     * 那批图片是永远没有标签的 —— 而用户装上新版本后第一件事恰恰是打开图片看标签。
     * 补标签是纯点积（不解码图片、不载模型），本机 7374 行实测 **1.8 秒**，
     * 代价低到可以无条件跑。
     *
     * ## 三条跳过条件，任一命中就不跑
     *
     *   ① 从没建过索引 —— 没有向量就没有标签，连索引库文件都不打开；
     *   ② 索引任务正在跑 —— 它会顺手算标签，此时去抢索引库写锁只有坏处；
     *   ③ 模型没装 —— worker 会以 `AI_MODEL_MISSING` 收场，静默吞掉即可。
     *
     * 延迟几秒是为了避开启动高峰（扫库、载缩略图都在抢磁盘）。
     */
    setTimeout(function () {
      try {
        if (!semanticSearch || !semanticTags) return;
        if (!semanticTags.conn()) return;
        if (semanticSearch.status().running) return;
        void semanticSearch
          .run('tag')
          .then(function (result) {
            // 真的补到了才通知：否则每次启动都白推一次重画。
            if (result && result.tagged > 0 && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ai-tags-updated');
            }
          })
          .catch(function () {});
      } catch (_) {}
    }, 3000).unref();
    /**
     * 随包内置模型（`models/`）的首次播种。
     *
     * 安装包里带着 `resources/models`（开发态是仓库根的 `models/`）——人脸 YuNet + w600k_mbf、
     * 搜图 SigLIP2，于是「第一次用要先点一次下载模型」在随包发行时不再必须。三件事让它能放心：
     *   - **懒 + 只做一次**：钩在 `refresh()` 上，不占启动时间；memo 住，之后每次查状态只剩一次 `statSync`。
     *   - **幂等**：已就绪直接返回，不重复搬几百 MB；文件一律「缺了才补、尺寸不对才换」。
     *   - **只报不抛**：任何异常都降级回原来的「点按钮下载」，绝不把内置模型变成新的故障点。
     */
    var bundledModelsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'models')
      : path.join(__dirname, '..', 'models');
    var bundledModelsSeed = null;
    function ensureBundledModels() {
      if (!bundledModelsSeed) {
        bundledModelsSeed = Promise.resolve()
          .then(function () {
            return bundledModels.ensureBundledModels({
              modelsDir: bundledModelsDir,
              faceAiPath: faceService.aiPath,
              searchAiPath: semanticSearch.aiPath,
              // `ready.json` 里的 `model` 必须与 worker 认的键逐字符相同，因此这个键只有一个
              // 来源：`src/ai/embedding.js` 的 `MODEL_KEY`。取不到（版本对不上）时播种层什么都不做。
              modelKey: require('./ai/embedding').MODEL_KEY,
            });
          })
          .then(function (report) {
            if (bundledModels.reportSaysCopied(report))
              logger.log('[ai] 已从随包 models/ 播种模型: ' + JSON.stringify(report));
            return report;
          })
          .catch(function (error) {
            logger.warn('[ai] 播种随包模型失败: ' + (error && error.message ? error.message : error));
            return null;
          });
      }
      return bundledModelsSeed;
    }
    // 与 canRun 一样，按现有约定直接挂在实例上；两个运行时（IPC 与网页 API）的入口都是 refresh()。
    semanticSearch.beforeRefresh = ensureBundledModels;
    faceService.beforeRefresh = ensureBundledModels;
    // 下载模型与建索引互斥：同时跑会各占一套模型、反复读 photos.db，谁都跑不快。
    // 只读查询（搜图、人物列表、人物图片）不受这两个开关影响，索引期间照常可用。
    // 数据库维护期间同样要拦，但**只有独占整库的那两种**（VACUUM / 重建缩略图标记）：它们要
    // 重写整库，索引 worker 一边跑一边写会把维护顶成 `database is locked`。
    // ⚠️ 启动期的 FTS 索引刻意**不算**在这里（见 ai-index-gate.js）：它和 AI 索引走同一条
    // 写库队列，串行由队列保证；把它算进来就是过去那个误报——开机十几秒内点「建 AI 索引」
    // 会被回一句「数据库维护进行中」，而其实立刻就能跑。
    // 返回的是**错误码**而不是 false，界面才能说清「是数据库维护在占着」而不是笼统的「AI 任务正在运行」。
    semanticSearch.canRun = function () {
      return aiIndexCanRun({
        exclusiveMaintenance: exclusiveMaintenanceRunning,
        peerBusy: faceService.status().running,
      });
    };
    faceService.canRun = function () {
      return aiIndexCanRun({
        exclusiveMaintenance: exclusiveMaintenanceRunning,
        peerBusy: semanticSearch.status().running,
      });
    };
    // 搜图曾经另有一道闸门（人脸索引在跑时直接拒绝）。现已撤除：
    // 真正的约束是内存，而「人脸索引 + 一个搜图 worker」实测根本不崩——人脸模型才 41 MB，
    // 会崩的是**同一份 SigLIP2 被并发载入两遍**（内存耗尽），那条路已经由 relay 彻底堵死：
    // 搜图索引在跑时搜索托给同一个 worker，永远不会有第二份 SigLIP2。
    // 加上搜图现在只载文本编码器（textOnly，省掉视觉那约 95 MB），这条路径只会更轻。
    if (isDev) {
      var dbExists = false;
      var dbSize = 0;
      try {
        var st = fs.statSync(dbPath);
        dbExists = true;
        dbSize = Number(st && st.size) || 0;
      } catch (e0) {}
      logger.log('[startup] db path=%s exists=%s size=%d', dbPath, dbExists ? 'yes' : 'no', dbSize);
    }
    db = new Database(dbPath);
    startupStageLog('db.init.done');
    try {
      catalogCache = new CatalogCacheDb(catalogCachePath);
      catalogCache.gcExpired(Date.now());
    } catch (eCat) {
      catalogCache = null;
      console.warn(
        '[startup] catalog cache init failed:',
        eCat && eCat.message ? eCat.message : String(eCat),
      );
    }
    if (isDev) {
      setTimeout(function () {
        if (db && typeof db.getStartupDiagnostics === 'function') {
          try {
            var d = db.getStartupDiagnostics();
            logger.log(
              '[startup] db schema root_folders=%s photos=%s roots=%d photos=%d',
              d && d.hasRootFolders ? 'ok' : 'missing',
              d && d.hasPhotos ? 'ok' : 'missing',
              Number(d && d.rootCount) || 0,
              Number(d && d.photoCount) || 0,
            );
          } catch (e1) {
            console.warn(
              '[startup] db diagnostics failed:',
              e1 && e1.message ? e1.message : String(e1),
            );
          }
        }
      }, 100);
    }
    // `loadSettings()` 已经在解析数据目录之前跑过一次（见本函数开头），这里不再重复读盘。

    /** 内嵌 Web 服务就绪 URL；先占位 Promise，在首窗之后再 require/start，避免拖住 createWindow */
    var webServerReadyResolve;
    var webServerReady = new Promise(function (resolve) {
      webServerReadyResolve = resolve;
    });
    setTimeout(function () {
      try {
        webServerReadyResolve('');
      } catch (eWs) {
        void eWs;
      }
    }, 35000);

    // 孤儿行 / 大 PRAGMA / 无效文件分批清理：见 schedulePostWindowDeferredTasks（首屏加载完成后）

    // 注册自定义协议：thumb://photo-id 用于缩略图（视频无库内缩略图时按需 ffmpeg 抽帧并写回库）
    protocol.handle('thumb', async function (request) {
      var url = new URL(request.url);
      var photoId = parseInt(url.hostname, 10);
      if (isNaN(photoId) || photoId <= 0) {
        var fb0 = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
          'base64',
        );
        return new Response(fb0, { headers: { 'Content-Type': 'image/png' }, status: 200 });
      }

      var cached = db.getThumbnail(photoId);
      if (cached && cached.thumbnail) {
        return new Response(cached.thumbnail, {
          // 🔴 按这一行**实际存的格式**派生：`getThumbnail()` 把 `thumb_format` 一起带出来了。
          //    未知 / 空串（本列引入之前的存量行）回落 `image/jpeg` —— 那批实测全是 JPEG。
          headers: { 'Content-Type': thumbMimeType(cached.format) },
        });
      }

      var full = db.getFullPhoto(photoId);
      if (full && full.file_path && isVideoPath(full.file_path)) {
        var topts = getThumbOptions();
        var vbuf = await extractVideoThumbnailWithFfmpeg(full.file_path, topts);
        if (!vbuf) {
          try {
            vbuf = await buildVideoPlaceholderThumbnail(topts);
          } catch (ePl) {
            vbuf = null;
          }
        }
        if (vbuf && vbuf.length) {
          // 这一支是**当场生成**的：写入时记的就是 `THUMB_ENCODE_FORMAT`（抽帧与占位图都走
          // `resizeThumb()`），响应头取同一个值 —— 「记进库的格式」与「发出去的头」不许各写一份。
          try {
            db.updatePhotoThumbnail(photoId, vbuf, {
              size: topts.size,
              format: THUMB_ENCODE_FORMAT,
            });
          } catch (eUp) {}
          return new Response(vbuf, {
            headers: { 'Content-Type': thumbMimeType(THUMB_ENCODE_FORMAT) },
          });
        }
      }

      var fallback = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
        'base64',
      );
      return new Response(fallback, {
        headers: { 'Content-Type': 'image/png' },
        status: 200,
      });
    });

    // 注册自定义协议：photo://photo-id 用于预览原图
    protocol.handle('photo', async function (request) {
      var url = new URL(request.url);
      var photoId = parseInt(url.hostname, 10);
      var photo = db.getFullPhoto(photoId);

      if (photo && photo.file_path) {
        try {
          var ext = path.extname(photo.file_path).toLowerCase();
          if (RAW_EXTENSIONS.has(ext)) {
            // RAW 文件浏览器通常无法直接渲染，动态转为 JPEG 预览
            var rawJpeg = await loadSharp()(photo.file_path)
              .rotate()
              .jpeg({ quality: 88 })
              .toBuffer();
            // 这里的 `image/jpeg` 是**对的、且只此一处**：上面刚刚 `.jpeg()` 出这个 Buffer，
            // 它不是库里的缩略图（那条路走 `thumb://`，头由 `thumbMimeType()` 按行派生）。
            return new Response(rawJpeg, {
              headers: { 'Content-Type': 'image/jpeg' },
            });
          }
          var data = Readable.toWeb(fs.createReadStream(photo.file_path));
          var mimeMap = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml',
          };
          var contentType = mimeMap[ext] || 'image/jpeg';
          return new Response(data, {
            headers: { 'Content-Type': contentType },
          });
        } catch (e) {
          // 文件读取失败
        }
      }

      var fallback = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
        'base64',
      );
      return new Response(fallback, {
        headers: { 'Content-Type': 'image/png' },
        status: 200,
      });
    });

    // 注册自定义协议：video://photo-id 用于预览视频（支持 Range，便于拖动进度条）
    // 使用手动 ReadableStream + fs.read 分块读取，比 Readable.toWeb 更兼容 Chromium 媒体管线
    protocol.handle('video', async function (request) {
      var reqUrl = request.url;
      var url = new URL(reqUrl);
      var photoId = parseInt(url.hostname, 10);
      logger.log('[video-protocol] request url=%s photoId=%d', reqUrl, photoId);
      var photo = db.getFullPhoto(photoId);
      if (!photo || !photo.file_path) {
        logger.warn('[video-protocol] photo not found for id=%d', photoId);
        return new Response('Not Found', { status: 404 });
      }
      var fp = photo.file_path;
      if (!fp || !fs.existsSync(fp)) {
        logger.warn('[video-protocol] file missing: %s', fp);
        return new Response('Not Found', { status: 404 });
      }

      var ext = path.extname(fp).toLowerCase();
      var mimeMap = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.mpg': 'video/mpeg',
        '.mpeg': 'video/mpeg',
        '.ts': 'video/mp2t',
        '.m2ts': 'video/mp2t',
        '.3gp': 'video/3gpp',
        '.3g2': 'video/3gpp2',
      };
      var contentType = mimeMap[ext] || 'video/mp4';

      var stat;
      try {
        stat = fs.statSync(fp);
      } catch (e) {
        return new Response('Not Found', { status: 404 });
      }
      var size = Number(stat && stat.size) || 0;
      if (!size) {
        return new Response('Not Found', { status: 404 });
      }

      var range = null;
      try {
        range =
          request && request.headers && request.headers.get ? request.headers.get('range') : null;
      } catch (e2) {}
      logger.log('[video-protocol] file=%s size=%d range=%s', fp, size, range || '(none)');

      // 解析 Range: bytes=start-end
      var rangeStart = 0;
      var rangeEnd = size - 1;
      var isRangeRequest = false;
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        var m = range.match(/^bytes=(\d*)-(\d*)$/);
        var s = m && m[1] ? parseInt(m[1], 10) : 0;
        var e = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (isNaN(s) || s < 0) s = 0;
        if (isNaN(e) || e < 0) e = size - 1;
        if (s > e || s >= size) {
          logger.warn('[video-protocol] 416 range not satisfiable: %d-%d size=%d', s, e, size);
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': 'bytes */' + size },
          });
        }
        if (e >= size) e = size - 1;
        rangeStart = s;
        rangeEnd = e;
        isRangeRequest = true;
      }

      var readStart = rangeStart;
      var readEnd = rangeEnd;
      var totalBytes = readEnd - readStart + 1;
      var CHUNK_SIZE = 64 * 1024;

      var streamBody = new ReadableStream({
        type: 'bytes',
        start: function (controller) {
          this._fd = null;
          this._pos = readStart;
          this._remaining = totalBytes;
          this._buf = Buffer.alloc(CHUNK_SIZE);
          try {
            this._fd = fs.openSync(fp, 'r');
          } catch (err) {
            controller.error(err);
          }
        },
        pull: function (controller) {
          if (this._remaining <= 0) {
            controller.close();
            if (this._fd != null) {
              try {
                fs.closeSync(this._fd);
              } catch (_e) {}
              this._fd = null;
            }
            return;
          }
          var toRead = Math.min(CHUNK_SIZE, this._remaining);
          try {
            var bytesRead = fs.readSync(this._fd, this._buf, 0, toRead, this._pos);
            if (bytesRead <= 0) {
              controller.close();
              try {
                fs.closeSync(this._fd);
              } catch (_e2) {}
              this._fd = null;
              return;
            }
            controller.enqueue(this._buf.subarray(0, bytesRead));
            this._pos += bytesRead;
            this._remaining -= bytesRead;
          } catch (err) {
            controller.error(err);
            if (this._fd != null) {
              try {
                fs.closeSync(this._fd);
              } catch (_e3) {}
              this._fd = null;
            }
          }
        },
        cancel: function () {
          if (this._fd != null) {
            try {
              fs.closeSync(this._fd);
            } catch (_e4) {}
            this._fd = null;
          }
        },
      });

      if (isRangeRequest) {
        return new Response(streamBody, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes ' + readStart + '-' + readEnd + '/' + size,
            'Content-Length': String(totalBytes),
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }

      return new Response(streamBody, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    });

    function startEmbeddedWebServer() {
      if (webServer) {
        startupStageLog('embedded-web-server.skip', 'already started');
        return;
      }
      startupStageLog('embedded-web-server.start');
      var hlsSessionsDir = path.join(userDataPath, 'hls-sessions');
      var ff = getFfmpegStaticPath();
      var hlsHealth = validateHlsRuntime(ff, hlsSessionsDir);
      if (!hlsHealth.ok) {
        console.warn('[HLS] disabled on startup:', hlsHealth.issues.join(', '));
      }
      try {
        var WebServer = require('./web-server');
        webServer = new WebServer(db, undefined, {
          hlsRootDir: hlsSessionsDir,
          ffmpegPath: hlsHealth.ok ? ff : null,
          hlsMaxCacheBytes: settings.hlsMaxCacheBytes,
          hlsMaxCacheEntries: settings.hlsMaxCacheEntries,
          lanEnabled: settings.webLanEnabled === true,
          /** 与桌面预览共用主进程 sharp，限制网页大图转码并发，减轻左右切换卡死 */
          previewJpegMaxConcurrent: 2,
          previewJpegMaxQueue: 48,
          /** /api/root-folders、/api/stats 等大查询走只读 Worker，避免内嵌网页拖死主进程 */
          sqliteReadPath: dbPath,
          /**
           * 网页端改了组织元数据（评分 / 标记 / 标签）之后清读池缓存。
           *
           * 🔴 必须注入：读池归主进程管，`web-server.js` 不知道它的存在。不接的后果
           *    是「筛选栏开了、网页端点一下星，那一档的 total 最多陈旧 5 秒」
           *    （TTL 兜底）—— 不是错误结果，但桌面端是显式清的，两端口径要一致。
           *    与上面那组 `getXxx` 的注入同一种「把主进程的能力交出去」的形态。
           */
          onOrgMetaWritten: function () {
            invalidateReadCachesForOrgMeta('web');
          },
          semanticSearch: semanticSearch,
          faceService: faceService,
          /**
           * 图片编辑（旋转 / 翻转 / 裁剪）**与桌面端共用同一个服务实例** ——
           * 编辑是全局串行的，两端各建一个实例 = 两条队列，会互相覆盖。
           */
          photoEdit: getPhotoEditService(),
          /** 判「视频不可编辑」的扩展名清单，与桌面端同一份 */
          videoExtensions: VIDEO_EXTENSIONS,
          getBrowseFolderIncludeSubfolders: function () {
            reloadSettingsFromDiskSilently();
            return settings.browseFolderIncludeSubfolders !== false;
          },
          /**
           * 网页端按需生成缩略图时用的档位/画质：**必须**与桌面同一份，
           * 否则网页端会往库里写一批「永远不合档」的行，重跑任务每轮都把它们算成待重生成。
           */
          getThumbOptions: function () {
            reloadSettingsFromDiskSilently();
            return getThumbOptions();
          },
          /** 网页端搜图用与桌面同一份阈值：两边共用 sever 上的一套设置。 */
          getAiSearchMatchThreshold: function () {
            return settings.aiSearchMatchThreshold;
          },
          /**
           * 网页端搜图另加的 tag 检索层开关与查询线（M4）。与桌面走同一个 `settings`，
           * 所以「桌面关掉 tag 层」和「网页端关掉」是同一件事，不会一边开一边关。
           * 形状与 `searchMatchOptions()` 的后两个键一致，改一处必须改两处。
           */
          getAiSearchTagOptions: function () {
            return {
              tagEnabled: settings.aiSearchTagEnabled !== false,
              tagThreshold: Number(settings.aiSearchTagThreshold),
            };
          },
          /**
           * 网页端预选词与桌面端**同源同函数**：主进程按 `embeddings.tags` 转置统计，
           * 只读 SQL、不起 worker、不载模型（理由见 `SemanticTags.suggestTerms`）。
           *
           * 之所以做成注入的函数而不是把 `semanticTags` 整个交出去：这正是本文件里
           * `getPhotoAiTags` / `getTagNavPhotos` 那一批的形态 —— 网页端只该拿到「一个能力」，
           * 不该拿到一个能开连接、能换语言、能改状态的活对象。
           */
          getAiSuggestTerms: function (request) {
            return suggestTermsFromTags(request);
          },
          /** 网页端「图片信息」面板照用桌面端勾好的字段集 */
          getInfoPanelFields: function () {
            return settings.infoPanelFields;
          },
          /** 网页端「主题标签」与桌面端同源（同一个只读连接，读数一致） */
          getPhotoAiTags: function (photoId, locale) {
            return semanticTags ? semanticTags.tagsFor(photoId, locale) : [];
          },
          /** 网页端「画面标签」与桌面端同源（同一个只读连接，中文映射在通道内做） */
          getPhotoJoyTags: function (photoId, locale) {
            return joyTagTags ? joyTagTags.tagsFor(photoId, locale) : [];
          },
          /**
           * 网页端「标签导航页」与桌面端**同源同函数**（分类树只碰 tag 库；
           * 取照片行走 `fetchTagNavPhotoRows`，与 IPC 那条是同一个实现）。
           */
          getTagNavStatus: function () {
            return tagNav ? tagNav.status() : { available: false, tags: 0, photos: 0 };
          },
          getTagNavTree: function () {
            return tagNav ? tagNav.tree() : [];
          },
          getTagNavNode: function (nodeId, locale) {
            return tagNav ? tagNav.node(nodeId, locale) : { tags: [], total: 0, indexed: 0 };
          },
          getTagNavSearch: function (keyword, locale) {
            return tagNav ? tagNav.search(keyword, locale) : { tags: [], nodes: [], indexed: 0 };
          },
          getTagNavPhotos: function (tag, options) {
            return fetchTagNavPhotoRows(tag, options);
          },
          /** 网页端「设置」页只需要一份脱敏只读快照（见 buildWebSettingsSnapshot） */
          getSettingsSnapshot: function () {
            return buildWebSettingsSnapshot();
          },
        });
        webServer.setPassword(settings.webPassword || '');
        webServer
          .start()
          .then(function (port) {
            var localIP = webServer.getLocalIP();
            var webUrl = 'http://' + localIP + ':' + port;
            logger.log('Web server running at: ' + webUrl);
            startupStageLog('embedded-web-server.ready', webUrl);
            webServerReadyResolve(webUrl);
          })
          .catch(function (err) {
            logger.error('Failed to start web server:', err.message);
            webServerReadyResolve('');
          });
      } catch (e) {
        logger.error('Failed to create web server:', e && e.message ? e.message : String(e));
        webServerReadyResolve('');
      }
    }

    resolveAppIcon().then(function (appIcon) {
      startupStageLog('resolve-app-icon.done');
      cachedAppIcon = appIcon;
      createWindow(appIcon);
      startupStageLog('create-window.done');
      setupTray(appIcon);
      registerBackgroundShortcut();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.once('did-finish-load', function () {
          startupStageLog('window.did-finish-load');
          /**
           * 「配了数据目录却没用上」必须让用户看见（原因在 `resolveDataDirPath`）。
           * 时机挑在 `did-finish-load` **之后**：早于此时渲染端还没注册弹窗请求的监听，
           * 请求会掉在地上，等 20 秒超时再回落到一个系统弹窗 —— 那正是这次要摆脱的东西。
           */
          if (dataDirFallbackReason) {
            setTimeout(function () {
              void alertInApp({
                title: '图库数据位置打不开',
                i18n: {
                  titleKey: 'settings.storage.dataDirFallbackTitle',
                  messageKey: 'settings.storage.dataDirFallbackDialogFmt',
                  // 弹窗正文里**只放用户能读的那句**：`EPERM: operation not permitted, mkdir ...`
                  // 摆在对话框里像一份崩溃报告，而排查要的原文另有去处 ——
                  // 设置页那一行的悬停（`fallbackDetail`）与 `resolveDataDirPath` 的 warn 日志。
                  params: { reason: dataDirFallbackReason },
                },
                message:
                  '你指定的图库数据位置这次没能打开，本次启动已临时改用默认位置。\n\n' +
                  '所以图库看起来可能是空的 —— 图片并没有丢。\n\n' +
                  '如果它是移动硬盘或网络盘，接回来重启应用就能恢复；如果这个位置已经不用了，可以到「设置 → 媒体与存储」里改到新位置。\n\n' +
                  '（打不开的是：' +
                  dataDirFallbackReason +
                  '）',
              });
            }, 600);
          }
          schedulePostWindowDeferredTasks();
          setTimeout(startEmbeddedWebServer, 400);
        });
      }
    });
    // 页面加载异常未触发 did-finish-load 时仍执行延后任务与本机服务（HLS/网页 API）
    setTimeout(function () {
      startupStageLog('startup-fallback-12s.fire');
      if (!postWindowDeferredTasksDone) {
        schedulePostWindowDeferredTasks();
      }
      submitStartupWriteTasks('fallback');
      runAutoStartupTasksOnce();
      startEmbeddedWebServer();
    }, 12000);
    // Tunnel 默认不自动开启：仅在用户手动打开开关时启动
    tunnelTask.enabled = false;

    // === IPC Handlers ===
    ipcMain.once('notify-browse-photos-ready', () => {
      startupStageLog('renderer.first-grid-paint');
    });
    /**
     * 渲染层启动阶段上报。**只记指标，零副作用** —— 不碰任何状态、不触发任何任务。
     * 名字必须命中 `RENDERER_STARTUP_STAGES` 白名单：渲染层能往这里送任意字符串，
     * 不过滤就等于让页面往启动日志里写任意内容（也顺手挡住超长字符串）。
     */
    ipcMain.on('notify-startup-stage', (event, stage) => {
      var stageName = String(stage == null ? '' : stage);
      if (RENDERER_STARTUP_STAGES.indexOf(stageName) < 0) return;
      startupStageLog('renderer.' + stageName);
    });
    /**
     * 主题弹窗的回执（见 `askInAppDialog`）。id 对不上就丢弃 —— 超时后到达的迟到回执
     * 不能再去结算一个已经回落过系统弹窗的请求（那会让调用方拿到两个答案）。
     */
    ipcMain.on('app-dialog-response', (event, payload) => {
      var p = payload || {};
      resolveAppDialog(Number(p.id) || 0, { available: true, confirmed: p.confirmed === true });
    });
    ipcMain.on('begin-browse-request', (event, sequence) => {
      browseRequests.begin(event.sender, sequence);
    });

    ipcMain.on('notify-browse-ui-ready', function () {
      startupStageLog('ipc.notify-browse-ui-ready');
      if (browseUiReadyStartupTimer) {
        clearTimeout(browseUiReadyStartupTimer);
        browseUiReadyStartupTimer = null;
      }
      /**
       * 首屏目录渲染完 → 再等 3.5s 让 get-root-folders / get-folder-tree 的只读查询收尾。
       *
       * 🔴 这个延迟**只负责降载**（别和目录树抢 Worker 与磁盘 IO），**不负责排序**：
       * 之前 +5s thumbnail-fix / +6s FTS / +8s 延迟索引三处各自点火，顺序靠它们相互错开；
       * 现在改成同一次调用里按优先级一起入队（T5），谁先跑由 `db-write-queue` 决定。
       */
      browseUiReadyStartupTimer = setTimeout(function () {
        browseUiReadyStartupTimer = null;
        startupStageLog('auto-startup.timer.fire', 'after notify-browse-ui-ready');
        submitStartupWriteTasks('browse-ui-ready');
        runAutoStartupTasksOnce();
      }, 3500);
    });
    ipcMain.on('preview-playback-active', function (event, active) {
      previewPlaybackActive = active === true;
    });

    ipcMain.on('toggle-devtools', function () {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    });

    ipcMain.on('toggle-background-window', function () {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else showMainWindow();
    });

    ipcMain.on('quit-app-completely', function () {
      quitCompletely();
    });

    ipcMain.on('resolve-window-close', function (event, payload) {
      payload = payload || {};
      if (payload.saveDefault && (payload.behavior === 'tray' || payload.behavior === 'quit')) {
        settings.windowCloseBehavior = payload.behavior;
        ensureSettingsShape();
        saveSettings();
      }
      if (payload.action === 'tray') {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      } else if (payload.action === 'quit') {
        quitCompletely();
      }
    });

    ipcMain.handle('select-folder', async function () {
      var result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择图片文件夹',
      });
      if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
      return null;
    });

    ipcMain.handle('scan-folder', async function (event, folderPath) {
      return enqueueScanTask({ rootPath: folderPath, source: 'manual' });
    });

    ipcMain.handle('get-scan-progress', function () {
      if (isFolderScanRunning()) {
        return workerScanProgress;
      }
      return { status: 'idle', current: 0, total: 0, currentFile: '' };
    });

    ipcMain.handle('cancel-scan', function () {
      if (scanWorker) {
        scanWorker.postMessage({ type: 'cancel' });
      }
      clearPendingScanQueue();
      return { success: true };
    });

    ipcMain.handle('pause-scan', function () {
      if (scanWorker) {
        scanWorker.postMessage({ type: 'pause' });
        return { success: true };
      }
      return { success: false };
    });

    ipcMain.handle('resume-scan', function () {
      if (scanWorker) {
        scanWorker.postMessage({ type: 'resume' });
        return { success: true };
      }
      return { success: false };
    });

    ipcMain.handle('get-stats', async function () {
      var readPath = sqliteDbPath || dbPath;
      if (!readPath) {
        throw new Error('get-stats: database path unavailable');
      }
      return await runDbReadWorkerOnly(readPath, 'getStats', {});
    });

    ipcMain.handle('get-photo-info', function (event, photoId) {
      if (!db || !photoId) return null;
      return db.getPhotoInfo(Number(photoId));
    });

    ipcMain.handle('get-scan-queue-status', function () {
      return getScanQueueStatus();
    });

    ipcMain.handle('clear-scan-queue', function () {
      var count = scanQueue.length;
      clearPendingScanQueue();
      return { success: true, cleared: count };
    });

    ipcMain.handle('start-thumbnail-backfill', async function (event, limit) {
      const startTime = Date.now();
      logger.log('[start-thumbnail-backfill] IPC received, limit=', limit);
      // 🔴 判据与 `runThumbnailBackfill()` 内部**共用同一份**（过去这里漏了
      //    `duplicateHashTask.running`，导致「返回成功但任务什么都没做」的静默失败，
      //    用户报的就是「点击之后不开始」）。详见 `thumbnailBackfillBlockReason()`。
      const blocked = thumbnailBackfillBlockReason();
      if (blocked) {
        // warn 级：生产档 logger 是 warn，info 会被静默 —— 拒绝是最需要留现场的事件
        logger.warn('[start-thumbnail-backfill] rejected: ' + blocked);
        return { success: false, error: blocked };
      }
      // 立即返回，任务在后台异步运行，不要阻塞 IPC 响应
      setTimeout(() => {
        logger.log('[start-thumbnail-backfill] starting background task after IPC return');
        runThumbnailBackfill(limit).catch((err) => {
          logger.error('[start-thumbnail-backfill] task error:', err);
          thumbnailBackfill.running = false;
        });
      }, 0);
      const elapsed = Date.now() - startTime;
      logger.log('[start-thumbnail-backfill] IPC done in', elapsed, 'ms, returning success');
      return { success: true };
    });

    ipcMain.handle('get-thumbnail-backfill-progress', function () {
      return getThumbnailBackfillProgress();
    });

    ipcMain.handle('export-thumbnail-backfill-failed-paths', async function () {
      if (!mainWindow) {
        return { success: false, error: '窗口未就绪' };
      }
      try {
        var paths = getThumbnailBackfillFailedPathsForExport();
        if (paths.length === 0) {
          return { success: false, error: '暂无失败记录', empty: true };
        }
        var d = new Date();
        var pad2 = function (n) {
          return n < 10 ? '0' + n : '' + n;
        };
        var defaultName =
          'thumb-backfill-failed-' +
          d.getFullYear() +
          pad2(d.getMonth() + 1) +
          pad2(d.getDate()) +
          '-' +
          pad2(d.getHours()) +
          pad2(d.getMinutes()) +
          '.txt';
        var saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '导出缩略图补全失败路径',
          defaultPath: path.join(app.getPath('documents'), defaultName),
          filters: [{ name: '文本文件', extensions: ['txt'] }],
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { success: false, cancelled: true };
        }
        fs.writeFileSync(saveResult.filePath, paths.join('\r\n') + '\r\n', 'utf8');
        return { success: true, path: saveResult.filePath, count: paths.length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('cancel-thumbnail-backfill', function () {
      thumbnailBackfill.cancelled = true;
      emitBackgroundTasksChangedThrottled(false);
      return { success: true };
    });

    /**
     * 启动「缩略图全量重建」（把库里规格与当前设置不符的缩略图重跑一遍）。
     *
     * 🔴 准入判据与 `runThumbnailRebuild()` 内部**共用同一份**
     *    （`thumbnailRebuildBlockReason()`）。过去补全那条路两边各写一份，于是
     *    「IPC 返回 success、任务静默不跑」—— 用户看到「点了没反应」，没有任何现场。
     * 🔴 **必须立刻返回**：登记阶段要扫全库（真库几十秒起），在 handler 里 await 它
     *    就是把 IPC 挂住、界面转圈。
     */
    ipcMain.handle('start-thumbnail-rebuild', function () {
      const blocked = thumbnailRebuildBlockReason();
      if (blocked) {
        logger.warn('[start-thumbnail-rebuild] rejected: ' + blocked);
        return { success: false, error: blocked };
      }
      setTimeout(() => {
        runThumbnailRebuild().catch((err) => {
          logger.error('[start-thumbnail-rebuild] task error:', err);
          thumbnailRebuild.running = false;
          emitBackgroundTasksChangedThrottled(true);
        });
      }, 0);
      logger.log('[start-thumbnail-rebuild] IPC done, task scheduled');
      return { success: true };
    });

    ipcMain.handle('cancel-thumbnail-rebuild', function () {
      // ⚠️ 只置标志位：任务在**批次边界**自行收尾（与补全同一条）。
      //    强杀当前批次会留下「图已重生成、队列没删干净」的中间态。
      thumbnailRebuild.cancelled = true;
      emitBackgroundTasksChangedThrottled(false);
      return { success: true };
    });

    ipcMain.handle('get-thumbnail-rebuild-progress', function () {
      return getThumbnailRebuildProgress();
    });

    /**
     * 空闲态读数（设置页打开时读一次）：只要 meta 单行，O(1)。
     * ⚠️ 它**不是** `get-thumbnail-rebuild-progress` 的别名：那个只在运行期有意义，
     *    这个要在「没跑过任何一次」时也能答出「目标规格是什么、队列算不算数」。
     */
    ipcMain.handle('get-thumbnail-rebuild-status', function () {
      return getThumbnailRebuildStatus();
    });

    ipcMain.handle('maintenance-cleanup-missing-files', async function () {
      if (invalidCleanupTask.running) {
        return { success: false, error: '清理任务已在运行' };
      }
      // 清理是分批 DELETE（写事务），属于「库正被写」的一方：
      // 启动期迁移 / 扫描 / 补图 / 重复检测 / 写库队列里还有人在跑，都不许开枪。
      // 这里用的是一次性判断（不做重试），所以不会有「排队等队列空」的饥饿问题。
      if (maintenanceBusy()) {
        return { success: false, error: maintenanceBusyMessage() };
      }
      var confirmedCleanup = await confirmInApp({
        title: '清理失效记录',
        message:
          '图库里有记录的一部分图片，源文件已经不在磁盘上了（被删除或被移走）。\n\n' +
          '清理只是把这些记录从图库里移除 —— 图库中不再列出它们，磁盘上的文件一个都不会动。\n\n' +
          '这一步无法撤销。如果不放心，可以先在「数据库维护」里点「备份数据库」留一份。',
        okText: '开始清理',
      });
      if (!confirmedCleanup) {
        return { success: false, error: '用户取消' };
      }
      if (typeof db.cleanupMissingFilesYielding !== 'function') {
        return { success: false, error: '当前版本不支持分批清理' };
      }
      invalidCleanupTask.running = true;
      // 复位「已取消」：上一次可能被迁移让路打断过（见 pauseInvalidCleanupForMigration）。
      // 漏了这一行 = 用户再点一次「清理失效记录」时一批都不做就结束，且不报任何错。
      invalidCleanupTask.cancelled = false;
      invalidCleanupTask.checked = 0;
      invalidCleanupTask.deleted = 0;
      invalidCleanupTask.total = 0;
      invalidCleanupTask.currentFile = '';
      invalidCleanupTask.startedAt = Date.now();
      emitBackgroundTasksChangedThrottled(true);

      // 立即返回，任务在后台异步运行，不要阻塞 IPC 响应导致界面卡死
      setTimeout(() => {
        (async function () {
          try {
            try {
              if (db && typeof db.getStartupDiagnostics === 'function') {
                var d0 = db.getStartupDiagnostics();
                invalidCleanupTask.total = Number(d0 && d0.photoCount) || 0;
              }
            } catch (eDiag) {
              void eDiag;
            }
            var totalChecked = 0;
            var totalDeleted = 0;
            // 倒序游标（0 = 不限上界）：新记录先查，刚被搬走的图片第一时间清掉
            var beforeId = 0;
            var chunks = 0;
            var MAX_CHUNKS = 100000;
            while (
              chunks < MAX_CHUNKS &&
              invalidCleanupTask.running &&
              !invalidCleanupTask.cancelled
            ) {
              var r = await runInvalidCleanupBatch({
                batchSize: 1200,
                beforeId: beforeId,
                existsSyncSlice: 64,
              });
              chunks++;
              totalChecked += Number(r && r.checked) || 0;
              totalDeleted += Number(r && r.deleted) || 0;
              beforeId = Number(r && r.lastId) > 0 ? Number(r.lastId) : beforeId;
              invalidCleanupTask.checked = totalChecked;
              invalidCleanupTask.deleted = totalDeleted;
              invalidCleanupTask.currentFile = beforeId > 0 ? '已检查到记录 ID ' + beforeId : '';
              emitBackgroundTasksChangedThrottled(false);
              if (!r || !r.hasMore || !r.checked) break;
              // 短暂让出避免阻塞
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          } catch (err) {
            logger.error('Cleanup missing files error:', err);
          } finally {
            // 整轮只在**收尾**清一次（不是每批）：这个循环一批 1200 行、批间只 `setTimeout(0)`
            // 让出，逐批清等于把 `getPhotos` 的 total 缓存整轮打成空转。
            // 清的是读池里的 total 记忆化，见 `src/photos-total-cache.js`。
            if (totalDeleted > 0) {
              try {
                dbReadWorkerPool.invalidateReadCaches();
              } catch (eInv) {
                void eInv;
              }
            }
            invalidCleanupTask.running = false;
            invalidCleanupTask.currentFile = '';
            invalidCleanupTask.startedAt = 0;
            emitBackgroundTasksChangedThrottled(true);
          }
        })();
      }, 0);

      return { success: true };
    });

    ipcMain.handle('maintenance-rebuild-thumbnail-flags', function () {
      if (maintenanceBusy()) return { success: false, error: maintenanceBusyMessage() };
      optimizeTaskRunning = true;
      // 独占：要重写整库，AI 索引写一个批次就撞锁 —— 这就是下面 performMaintenance 之外
      // 唯一该拦 AI 索引的两处之一（另一处是 VACUUM）。
      exclusiveMaintenanceRunning = true;
      emitBackgroundTasksChangedThrottled(true);
      setTimeout(() => {
        void dbWriteQueue.run(
          'maintenance-rebuild-thumbnail-flags',
          () => performMaintenance('rebuildThumbnailFlags'),
          // USER：用户在设置页手动点的，人在等
          { priority: PRIORITY.USER },
        );
      }, 0);
      return { success: true };
    });

    ipcMain.handle('maintenance-optimize-database', async function () {
      if (maintenanceBusy()) return { success: false, error: maintenanceBusyMessage() };
      // VACUUM 要先另写一份临时库，磁盘不够就是跑到一半 I/O 失败；先算清楚再问要不要做。
      const shortage = vacuumSpaceShortage();
      if (shortage) return { success: false, error: shortage };
      const estimate = vacuumSpaceEstimate();
      const optimized = await confirmInApp({
        title: '整理数据库',
        message:
          '将重新整理图库数据库：回收删除记录后留下的零散空间，并刷新查询用的统计信息。\n\n' +
          '大库可能耗时较长，整理期间请不要关闭应用。' +
          (estimate && estimate.need
            ? '整理时要先另存一份临时数据，所以下面两处都要够：' +
              vacuumSpaceSummary() +
              '。本次需要额外约 ' +
              maintenanceGuard.formatBytes(estimate.need) +
              '，库内可回收约 ' +
              maintenanceGuard.formatBytes(estimate.reclaimable) +
              vacuumReclaimHint(estimate) +
              '。'
            : ''),
        okText: '开始整理',
      });
      if (!optimized) return { success: false, error: '用户取消' };
      // 弹窗期间可能有人起了扫描 / 索引，或者磁盘又被别的程序吃掉，所以复查一遍。
      if (maintenanceBusy()) return { success: false, error: maintenanceBusyMessage() };
      const recheck = vacuumSpaceShortage();
      if (recheck) return { success: false, error: recheck };
      optimizeTaskRunning = true;
      // 同上：VACUUM 期间不接受建 AI 索引（不是「稍慢」而是必然 database is locked）。
      exclusiveMaintenanceRunning = true;
      emitBackgroundTasksChangedThrottled(true);
      setTimeout(() => {
        void dbWriteQueue.run(
          'maintenance-optimize-database',
          () => performMaintenance('optimizeDatabase'),
          // USER：VACUUM 是用户确认后触发的，且不可中断，越早拿到锁越好
          { priority: PRIORITY.USER },
        );
      }, 0);
      return { success: true };
    });

    ipcMain.handle('maintenance-start-duplicate-hash-detection', async function () {
      // 判据与 `runDuplicateHashDetection()` 内部共用同一份（详见 `duplicateHashBlockReason()`）：
      // 过去这里漏了 `thumbnailBackfill.running`，会「返回成功但什么都不做」。
      const blocked = duplicateHashBlockReason();
      if (blocked) {
        logger.warn('[maintenance-start-duplicate-hash-detection] rejected: ' + blocked);
        return { success: false, error: blocked };
      }
      /** 勿 await 整段 runDuplicateHashDetection：大库可能跑数小时，invoke 会一直挂起，设置页「开始获取」像无响应 */
      void runDuplicateHashDetection().catch(function (err) {
        logger.error('[duplicate-hash]', err);
        try {
          duplicateHashTask.running = false;
          duplicateHashTask.currentFile = '';
          duplicateHashTask.currentHash = '';
          duplicateHashTask.startedAt = 0;
        } catch (e2) {
          void e2;
        }
        emitBackgroundTasksChangedThrottled(true);
      });
      return { success: true, started: true };
    });

    ipcMain.handle('maintenance-get-duplicate-hash-progress', function () {
      return getDuplicateHashTaskProgress();
    });

    ipcMain.handle('maintenance-cancel-duplicate-hash-detection', function () {
      duplicateHashTask.cancelled = true;
      duplicateHashTask.phase = 'cancelled';
      duplicateHashTask.currentFile = '正在停止…';
      duplicateHashBgLog('cancel-request', '', true);
      emitBackgroundTasksChangedThrottled(false);
      return { success: true };
    });

    ipcMain.handle('maintenance-get-duplicate-hash-groups', async function (event, options) {
      options = options || {};
      var readPathDup = sqliteDbPath || dbPath;
      if (!readPathDup) {
        throw new Error('maintenance-get-duplicate-hash-groups: database path unavailable');
      }
      if (db && typeof db.ensureDuplicateHashSchema === 'function') {
        db.ensureDuplicateHashSchema();
      }
      var pageSize = Math.max(1, Math.min(500, parseInt(options.pageSize, 10) || 100));
      var page = Math.max(1, parseInt(options.page, 10) || 1);
      var minCount = Math.max(2, parseInt(options.minCount, 10) || 2);
      var forceReload = options.forceReload === true;
      var startedAt = Date.now();
      if (
        !forceReload &&
        minCount === duplicateHashGroupsCache.minCount &&
        pageSize === duplicateHashGroupsCache.pageSize &&
        duplicateHashGroupsCache.total != null &&
        Object.prototype.hasOwnProperty.call(duplicateHashGroupsCache.pages, String(page))
      ) {
        var cachedGroups = duplicateHashGroupsCache.pages[String(page)] || [];
        var cachedResult = {
          groups: cachedGroups,
          total: Number(duplicateHashGroupsCache.total) || 0,
          page: page,
          pageSize: pageSize,
          totalPages: Number(duplicateHashGroupsCache.totalPages) || 0,
        };
        if (isDev) {
          logger.log(
            '[dup-groups] cache-hit page=%d pageSize=%d total=%d groups=%d elapsed=%dms',
            page,
            pageSize,
            cachedResult.total,
            cachedGroups.length,
            Date.now() - startedAt,
          );
        }
        return cachedResult;
      }
      if (isDev) {
        logger.log(
          '[dup-groups] request page=%d pageSize=%d minCount=%d force=%s',
          page,
          pageSize,
          minCount,
          forceReload ? 'yes' : 'no',
        );
      }
      var result = await runDbReadWorkerOnly(readPathDup, 'getDuplicateHashGroupsBundle', {
        page: page,
        pageSize: pageSize,
        minCount: minCount,
      });
      if (isDev) {
        logger.log(
          '[dup-groups] response groups=%d total=%d totalPages=%d elapsed=%dms',
          Array.isArray(result && result.groups) ? result.groups.length : 0,
          Number(result && result.total) || 0,
          Number(result && result.totalPages) || 0,
          Date.now() - startedAt,
        );
      }
      if (
        minCount === duplicateHashGroupsCache.minCount &&
        pageSize === duplicateHashGroupsCache.pageSize
      ) {
        duplicateHashGroupsCache.total = Number(result && result.total) || 0;
        duplicateHashGroupsCache.totalPages = Number(result && result.totalPages) || 0;
        duplicateHashGroupsCache.pages[String(page)] = Array.isArray(result && result.groups)
          ? result.groups
          : [];
        duplicateHashGroupsCache.warmedAt = Date.now();
      }
      return result;
    });

    ipcMain.handle('maintenance-get-photos-by-file-hash', function (event, fileHash) {
      if (!fileHash) return [];
      return db.getPhotosByFileHash(String(fileHash));
    });

    // ── 相似图片检测（dHash）IPC ──

    /** 第零层：dHash 精确匹配分组（秒级 SQL） */
    ipcMain.handle('maintenance-get-similar-dhash-groups', async function (event, options) {
      options = options || {};
      if (!db) throw new Error('database not initialized');
      db.ensureDhashSchema();
      var pageSize = Math.max(1, Math.min(500, parseInt(options.pageSize, 10) || 40));
      var page = Math.max(1, parseInt(options.page, 10) || 1);
      var forceReload = options.forceReload === true;
      var startedAt = Date.now();

      if (
        !forceReload &&
        similarDhashGroupsCache.total != null &&
        Object.prototype.hasOwnProperty.call(similarDhashGroupsCache.pages, String(page))
      ) {
        var cached = similarDhashGroupsCache.pages[String(page)] || [];
        if (isDev) {
          logger.log(
            '[similar-dhash] cache-hit page=%d groups=%d elapsed=%dms',
            page,
            cached.length,
            Date.now() - startedAt,
          );
        }
        return {
          groups: cached,
          total: Number(similarDhashGroupsCache.total) || 0,
          page: page,
          pageSize: pageSize,
          totalPages: Number(similarDhashGroupsCache.totalPages) || 0,
          mode: 'exact_dhash',
        };
      }

      var rows = similarDetection.getExactDhashGroups(db, page, pageSize);
      var groups = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || !r.dhash) continue;
        var photos = db.getPhotosByDhash(r.dhash);
        groups.push({
          dhash: r.dhash,
          duplicate_count: Number(r.duplicate_count) || 0,
          total_size: Number(r.total_size) || 0,
          photos: photos,
        });
      }

      var total = 0;
      try {
        var countRow = db.db
          .prepare(
            "SELECT COUNT(*) as c FROM (SELECT dhash FROM photos WHERE dhash IS NOT NULL AND TRIM(dhash) != '' GROUP BY dhash HAVING COUNT(*) > 1)",
          )
          .get();
        total = Number(countRow && countRow.c) || 0;
      } catch (eCount) {
        if (isDev) logger.log('[similar-dhash] count error:', eCount && eCount.message);
      }
      var totalPages = Math.max(1, Math.ceil(total / pageSize));

      similarDhashGroupsCache.total = total;
      similarDhashGroupsCache.totalPages = totalPages;
      similarDhashGroupsCache.pages[String(page)] = groups;
      similarDhashGroupsCache.warmedAt = Date.now();

      if (isDev) {
        logger.log(
          '[similar-dhash] page=%d groups=%d total=%d elapsed=%dms',
          page,
          groups.length,
          total,
          Date.now() - startedAt,
        );
      }
      return {
        groups: groups,
        total: total,
        page: page,
        pageSize: pageSize,
        totalPages: totalPages,
        mode: 'exact_dhash',
      };
    });

    /** 按 dHash 获取图片列表 */
    ipcMain.handle('maintenance-get-photos-by-dhash', function (event, dhash) {
      if (!dhash) return [];
      if (!db) return [];
      db.ensureDhashSchema();
      return db.getPhotosByDhash(String(dhash));
    });

    /** 第二层：单张图片的跨文件夹相似查询（按需实时） */
    ipcMain.handle('maintenance-find-similar-photos', function (event, options) {
      options = options || {};
      if (!db) return [];
      var photoId = parseInt(options.photoId, 10);
      var threshold =
        parseInt(options.threshold, 10) || parseInt(settings.similarThreshold, 10) || 12;
      if (!isFinite(photoId) || photoId <= 0) return [];
      try {
        db.ensureDhashSchema();
        var t0 = Date.now();
        var result = similarDetection.findSimilarPhotos(db, photoId, threshold);
        var elapsed = Date.now() - t0;
        if (elapsed > 5000) {
          logger.warn(
            '[maintenance-find-similar-photos] slow query: ' +
              elapsed +
              'ms for photoId=' +
              photoId,
          );
        }
        return result;
      } catch (e) {
        logger.error(
          '[maintenance-find-similar-photos] error for photoId=' + photoId + ':',
          e && e.message ? e.message : e,
        );
        throw e;
      }
    });

    /** 批量按 ID 查询图片详情 */
    ipcMain.handle('maintenance-get-photos-by-ids', function (event, ids) {
      if (!db || !Array.isArray(ids) || ids.length === 0) return [];
      // 调用方是「查找相似图片」的结果回传，长度跟着相似结果走 —— 同样不能展开成
      // `IN (?,?,...)`，理由与 similar-detection.js 里那处一致，见 src/main/sql-id-list.js。
      // （旧写法还把同一条 SQL prepare 了两次：一次给 .all、一次给 .apply 的 this。）
      var sql =
        'SELECT ' +
        photoListColumns({ liveMotion: false }) +
        ' FROM photos WHERE ' +
        idListPredicate('id');
      var rows = db.prepare(sql).all(toIdListJson(ids));
      var plain = [];
      for (var i = 0; i < rows.length; i++) {
        var obj = {};
        for (var key in rows[i]) {
          if (Object.prototype.hasOwnProperty.call(rows[i], key)) {
            obj[key] = rows[i][key];
          }
        }
        plain.push(obj);
      }
      return plain;
    });

    ipcMain.handle('get-background-tasks', function () {
      var sp = isFolderScanRunning()
        ? workerScanProgress
        : { status: 'idle', current: 0, total: 0, currentFile: '' };
      var spCur = sp.current || 0;
      var spTot = sp.total || 0;
      var scanProgress = Object.assign({}, sp, {
        etaSeconds: estimateEtaSecondsSmoothed('folderScan', workerScanStartedAt, spCur, spTot),
        // 百分比唯一来源（渲染端不再自己除）：见 `docs/contracts/background-tasks.md` §1.1。
        pct: computePct(spCur, spTot),
      });
      return {
        scan: {
          active: isFolderScanRunning(),
          progress: scanProgress,
          queue: getScanQueueStatus(),
        },
        thumbs: getThumbnailBackfillProgress(),
        /**
         * 缩略图**全量重建**的进度。与 `thumbs`（补全）分开报：两者的分子分母口径不同，
         * 合成一个字段就会让「补了 3 张」与「重跑了 3 张」在界面上分不清。
         */
        thumbRebuild: getThumbnailRebuildProgress(),
        invalidCleanup: getInvalidCleanupTaskProgress(),
        duplicateHash: getDuplicateHashTaskProgress(),
        face: faceService ? faceService.status() : {},
        semantic: semanticSearch ? semanticSearch.status() : {},
        /**
         * 🔴 「优化数据库」原先只报一个**裸布尔**（`optimizing`）—— 9 个任务里唯一没有状态
         *    对象的那个，于是「在跑」这个字段名在它身上与别处不同名（§1.1 点名的第三种写法）。
         *    包成对象后 `running` 与其余 8 个任务**同名、同位置**，渲染端读法统一成 `!!x.running`，
         *    不必再为它单写一个特例分支（特例分支正是漂移源）。
         * ⚠️ 它仍然**没有** `phase` / `total` / `done`：§11 记的「已知例外」（设置页触发、
         *    时长可控、无停止入口）⇒ 面板只能画「优化中 / 空闲」。
         */
        optimize: { running: !!optimizeTaskRunning },
      };
    });

    /**
     * **诊断数据**（不是后台任务）：上次维护的结果、交互抢占状态、写库队列快照。
     *
     * 🔴 2026-10-08 从 `get-background-tasks` 拆出来。它们原先和任务混在同一个返回对象里，
     *    而「后台任务」的判据是「跑得久 + 有进展 + 可中断」（见
     *    `docs/contracts/background-tasks.md` §0）。混着放的代价不是性能，是**误导后来改的人**：
     *    加一个新任务时容易顺手往同一处塞第四类字段；排查「任务为什么不开始」时又会以为
     *    `writeQueue` 本身就是一项任务。
     *
     * 拆开是**零风险**的：这三个字段没有渲染端消费者（只有探针单独取用过
     * `dbWriteQueue.snapshot()` 与 `interactionPreempt.status()`）。
     */
    ipcMain.handle('get-diagnostics', function () {
      return {
        maintenance: maintenanceResult,
        /**
         * 用户交互抢占状态。`active` 为真时后台长任务正在批次边界让位；
         * `holds` / `heldMs` 是累计让位次数与时长 —— 排查「后台为什么变慢了」的线索。
         */
        interaction: interactionPreempt.status(),
        /**
         * 写库队列的优先级快照：谁在跑、谁在等、各是什么档。
         * 排查「为什么某个任务迟迟不开始」时，看 `waiting` 里有没有更高档的任务压着它。
         */
        writeQueue: dbWriteQueue.snapshot(),
      };
    });

    ipcMain.handle('open-database-folder', function () {
      try {
        if (!sqliteDbPath) {
          return { success: false, error: '数据库路径未初始化' };
        }
        shell.showItemInFolder(sqliteDbPath);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    /** 设置页那一行「数据库位置」的全部读数（位置 / 体积 / 目标盘余量 / 是否迁移中）。 */
    ipcMain.handle('get-data-dir-info', function () {
      try {
        reloadSettingsFromDiskSilently();
        return describeDataDir();
      } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
      }
    });

    ipcMain.handle('select-data-dir', async function (_event, options) {
      try {
        var res = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory'],
          // 标题由渲染端传（`settings.storage.dataDirPickTitle`）：这是**系统**对话框，
          // 主进程这边没有 i18n 表，写死中文的话英文界面会弹一个中文标题的框。
          title: (options && options.title) || '选择图库数据的新位置',
          defaultPath: currentDataDir(),
        });
        if (!res || res.canceled || !res.filePaths || !res.filePaths.length) {
          return { success: false, cancelled: true };
        }
        var picked = res.filePaths[0];
        // 用户选的是「放到哪个位置」，真正落数据的目录要再套一层以产品命名的文件夹
        // （选中 `D:\` 时把 19 GB 摊在盘根是最常见的误操作，见 `data-dir.js` 的说明）。
        // 已经叫 AuroraGallery / 里面已有 photos.db 的两种情况不套，理由在 `resolveTargetDir`。
        var target = dataDirLib.resolveTargetDir(picked);
        if (!target.ok) return { success: false, code: target.code, error: target.error };
        // 选完立刻体检一次：把「目标就是当前位置 / 在当前目录里面」这类错误**在选的时候**
        // 挡回去，而不是等 19 GB 复制完才说不行；顺带把目标盘余量带回去给确认弹窗用。
        // ⚠️ 体检的是**最终**目录（含子文件夹），不是用户点中的那个 —— 否则
        //    「选中当前目录自己」会因为多了一层而误判成合法。
        var check = dataDirLib.validateTarget(currentDataDir(), target.dir);
        var plan = check.ok ? dataDirLib.planMigration(currentDataDir(), target.dir) : null;
        return {
          success: true,
          path: target.dir,
          // 用户实际点中的目录（`path` 可能比它多一层）——界面要如实说明会在哪儿新建文件夹
          pickedPath: picked,
          subfolder: !!target.subfolder,
          valid: check.ok,
          // `code` 给渲染端用：主进程的 `error` 只有中文，界面上按 code 取本地化文案，
          // 取不到才退回这句原文。
          code: check.code || '',
          error: check.error || '',
          plan: plan
            ? {
                totalBytes: plan.totalBytes,
                freeBytes: plan.freeBytes,
                needBytes: plan.needBytes,
                shortageBytes: plan.shortageBytes,
              }
            : null,
        };
      } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
      }
    });

    ipcMain.handle('migrate-data-dir', async function (event, payload) {
      var opts = payload || {};
      var targetDir = String(opts.targetDir || '').trim();
      /**
       * 迁移一旦走到「关闭数据库连接」这一步，本进程就再没有可用的库了 ⇒
       * 成功失败都要重启。留 1.5 秒给界面把结果（或错误）显示出来再退。
       */
      var result = await runDataDirMigration(targetDir, opts.removeSource !== false);
      if (result && result.restartRequired) {
        setTimeout(function () {
          try {
            app.relaunch();
          } catch (e) {
            logger.error('[data-dir] relaunch failed:', e && e.message ? e.message : e);
          }
          app.exit(0);
        }, 1500);
      }
      return result;
    });

    ipcMain.handle('backup-database', async function () {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (!sqliteDbPath || !mainWindow) {
        return { success: false, error: '数据库未就绪' };
      }
      var d = new Date();
      var pad = function (n) {
        return n < 10 ? '0' + n : '' + n;
      };
      var defaultName =
        'photos-backup-' +
        d.getFullYear() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        '.db';
      var defaultPath = path.join(app.getPath('documents'), defaultName);
      try {
        var saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '备份数据库',
          defaultPath: defaultPath,
          filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { success: false, cancelled: true };
        }
        await db.backupToFile(saveResult.filePath);
        return { success: true, path: saveResult.filePath };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('open-photo-external', async function (event, photoId) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var photo = db.getFullPhoto(id);
        if (!photo || !photo.file_path) {
          return { success: false, error: '图片记录不存在' };
        }
        if (!fs.existsSync(photo.file_path)) {
          return { success: false, error: '文件不存在' };
        }
        var errMsg = await shell.openPath(photo.file_path);
        if (errMsg) {
          return { success: false, error: errMsg };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('photo-move-to-trash', async function (event, photoId) {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var photo = db.getFullPhoto(id);
        if (!photo || !photo.file_path) {
          return { success: false, error: '图片记录不存在' };
        }
        var rootIdOfPhoto =
          photo && photo.root_id != null ? parseInt(photo.root_id, 10) || null : null;
        var fp = photo.file_path;
        if (fs.existsSync(fp)) {
          await shellTrashItemWithFallback(fp);
        }
        db.deletePhotoById(id);
        clearDuplicateHashGroupsCache('photo-move-to-trash');
        clearSimilarDhashGroupsCache('photo-move-to-trash');
        if (rootIdOfPhoto) invalidateCatalogCacheForRootSafe(rootIdOfPhoto);
        else invalidateCatalogCachesSafe();
        return { success: true };
      } catch (err) {
        return { success: false, error: formatTrashFailureError(err) };
      }
    });

    ipcMain.handle('photo-delete-record', function (event, photoId) {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var photoMeta = db.getFullPhoto(id);
        var rootIdOfPhoto =
          photoMeta && photoMeta.root_id != null ? parseInt(photoMeta.root_id, 10) || null : null;
        db.deletePhotoById(id);
        clearDuplicateHashGroupsCache('photo-delete-record');
        clearSimilarDhashGroupsCache('photo-delete-record');
        if (rootIdOfPhoto) invalidateCatalogCacheForRootSafe(rootIdOfPhoto);
        else invalidateCatalogCachesSafe();
        return { success: true };
      } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
      }
    });

    ipcMain.handle('photo-toggle-favorite', function (event, photoId) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var result = db.togglePhotoFavorite(id);
        if (!result) {
          return { success: false, error: '图片记录不存在' };
        }
        // 「仅收藏」那一档的 `COUNT(*)` 变了（行数没变，变的是 is_favorite 的分布）⇒
        // 清读池缓存。刻意**不清目录缓存**：收藏不影响目录结构 / 根目录统计。
        try {
          dbReadWorkerPool.invalidateReadCaches();
        } catch (eInv) {
          void eInv;
        }
        return { success: true, is_favorite: result.is_favorite };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 组织元数据：评分 / 标记 / 用户标签（2026-10-09）
    //
    // ## 为什么这些写操作必须清读池缓存
    //
    // 元数据（rating / flag / 标签）是**筛选维度**，不是纯展示字段。用户在「仅 5 星」
    // 那一档里按了 X 把当前图否掉，如果读池里还留着「仅 5 星」那份结果列表，
    // 列表上这一张会**继续存在**，而用户以为它已经被筛掉了 —— 这正是本工程最忌讳的
    // 「静态全绿、线上失效」。行数没变，变的是「哪些行属于这个筛选档」的分布，
    // 所以 `invalidateReadCaches()` 是必需的，不是保险。
    //
    // 目录缓存（`invalidateCatalogCachesSafe`）刻意**不动**：元数据不影响目录结构、
    // 分区计数、根目录统计 —— 与 `photo-toggle-favorite` 同一取向。
    //
    // 标签是跨表写（tags + photo_tags），影响面比 rating/flag 更大：标签列表本身有
    // 使用计数，`listTags()` 的结果也在读池里，所以标签类操作一律清缓存。
    // ─────────────────────────────────────────────────────────────────────────

    /** 清读池缓存的统一收口 —— 元数据写入只关心这一件事，写十遍不如一个函数。 */
    function invalidateReadCachesForOrgMeta(reason) {
      void reason;
      try {
        dbReadWorkerPool.invalidateReadCaches();
      } catch (eInv) {
        void eInv;
      }
    }

    ipcMain.handle('photo-set-rating', function (event, photoId, rating) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var result = db.setPhotoRating(id, rating);
        if (!result) {
          return { success: false, error: '图片记录不存在' };
        }
        invalidateReadCachesForOrgMeta('photo-set-rating');
        return { success: true, id: result.id, rating: result.rating };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('photo-set-flag', function (event, photoId, flag) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        // 🔴 传值是**幂等设值**，不是 toggle —— 见 preload.js 与 database.js#setPhotoFlag。
        //    「取消标记」走 `flag = 'none'`，由界面上的独立动作发出。
        var result = db.setPhotoFlag(id, flag);
        if (!result) {
          return { success: false, error: '图片记录不存在' };
        }
        invalidateReadCachesForOrgMeta('photo-set-flag');
        return { success: true, id: result.id, flag: result.flag };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('photo-get-tags', function (event, photoId) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        return { success: true, tags: db.getPhotoTags(id) };
      } catch (err) {
        return { success: false, error: err.message, tags: [] };
      }
    });

    ipcMain.handle('photo-set-tags', function (event, photoId, names) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var result = db.setPhotoTags(id, names);
        if (!result) {
          return { success: false, error: '图片记录不存在' };
        }
        invalidateReadCachesForOrgMeta('photo-set-tags');
        // 回包带**最终集合**（不是调用方传进来的那份）：归一、去重、自动建标签都发生在
        // 数据层，界面的 chip 必须以此为准，否则会显示成用户打的原样（含空格 / 大小写差异）。
        return { success: true, id: result.id, tags: result.tags };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('list-tags', function () {
      try {
        return { success: true, tags: db.listTags() };
      } catch (err) {
        return { success: false, error: err.message, tags: [] };
      }
    });

    ipcMain.handle('rename-tag', function (event, tagId, newName) {
      try {
        var result = db.renameTag(tagId, newName);
        if (!result) {
          return { success: false, error: '标签不存在或名称为空' };
        }
        invalidateReadCachesForOrgMeta('rename-tag');
        // 🔴 返回的 `id` 可能是**目标标签**的 id（归一后撞名 ⇒ 合并）。界面必须用这个
        //    返回值刷新，不能继续用自己手上那个旧 id —— 那个 id 已经被删了。
        return { success: true, id: result.id, name: result.name };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('delete-tag', function (event, tagId) {
      try {
        var ok = db.deleteTag(tagId);
        if (!ok) {
          return { success: false, error: '标签不存在' };
        }
        invalidateReadCachesForOrgMeta('delete-tag');
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    /**
     * 图片编辑（P0）：旋转 / 翻转，**写回原文件**。
     *
     * 🔴 `actions` 是**一串**动作（按顺序应用），不是单个动作：预览态编辑里用户连点的
     *    「转一下、翻一下、再转一下」攒成序列，保存时合成一条算子 ⇒ 只编码一次。
     *    传单个字符串仍然接受（`image-edit.js#normalizeActions` 兼容旧调用）。
     *
     * 返回**输出文件的真实尺寸与大小**，界面据此刷新缩略图与预览。
     * 🔴 前端不要自己推算新尺寸：90/270 档宽高对调、翻转不改变尺寸、EXIF 方向还要先归一化，
     *    组合起来有十几种情形，推算必然漏 —— 实测那条链路由 `image-edit.js` 给出。
     */
    ipcMain.handle('photo-edit-transform', async function (event, photoId, actions) {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      try {
        var r = await getPhotoEditService().transform(photoId, actions);
        return {
          success: true,
          id: r.id,
          width: r.width,
          height: r.height,
          size: r.size,
          // 渲染端靠它翻新 URL 缓存键（`utils.js#photoCacheVersion`），漏了会看到旧图
          dateModified: r.dateModified,
        };
      } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
      }
    });

    /**
     * 图片编辑（P1）：裁剪并**另存副本**（副本进库，成为一条正常照片行）。
     *
     * `rect` 用**用户看到的图**的坐标系（即 EXIF 已转正）；按 orientation 换算矩形这件事
     * 收在 `image-edit.js` 里 —— 两端各算一次必然有一端漏掉 90/270 的对调。
     */
    ipcMain.handle('photo-edit-crop', async function (event, photoId, rect) {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      try {
        var r = await getPhotoEditService().crop(photoId, rect);
        return {
          success: true,
          id: r.id,
          filePath: r.filePath,
          width: r.width,
          height: r.height,
          size: r.size,
          sourceId: r.sourceId,
        };
      } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
      }
    });

    /**
     * 图片编辑：**一次性**应用「一串变换 + 一个裁剪」（预览态编辑点「保存」的唯一入口）。
     *
     * 🔴 为什么不在这里拆成两次调用：`rect` 用的是**变换之后**那张图的坐标系，
     *    两次调用之间队列会让出，另一端可能插进来再改一次文件 ⇒ 裁错地方且不报错。
     *    顺序（先写回变换、再裁剪副本）收在 `photo-edit-service.js#applyEdit` 里。
     */
    ipcMain.handle('photo-edit-apply', async function (event, photoId, payload) {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      try {
        var p = payload || {};
        var r = await getPhotoEditService().applyEdit(photoId, {
          actions: p.actions,
          crop: p.crop,
        });
        return {
          success: true,
          id: r.id,
          width: r.width,
          height: r.height,
          size: r.size,
          // 渲染端靠它翻新 URL 缓存键（`utils.js#photoCacheVersion`），漏了会看到旧图
          dateModified: r.dateModified,
          crop: r.crop,
        };
      } catch (err) {
        return { success: false, error: err && err.message ? err.message : String(err) };
      }
    });

    ipcMain.handle('show-photo-in-folder', function (event, photoId) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的图片 ID' };
        }
        var photo = db.getFullPhoto(id);
        if (!photo || !photo.file_path) {
          return { success: false, error: '图片记录不存在' };
        }
        if (!fs.existsSync(photo.file_path)) {
          return { success: false, error: '文件不存在' };
        }
        shell.showItemInFolder(photo.file_path);
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('get-root-folders', async function (event, options) {
      options = options || {};
      var startedAt = Date.now();
      try {
        /** 只读大查询固定走有界 Worker 池，主进程不执行同步聚合。 */
        var readPath = sqliteDbPath || dbPath;
        if (!readPath) {
          throw new Error('get-root-folders: database path unavailable');
        }
        var mediaKey = normalizeMediaKey(options || {});
        if (
          options.lite !== true &&
          catalogCache &&
          typeof catalogCache.getRootFolders === 'function'
        ) {
          var cachedRows = catalogCache.getRootFolders(options);
          if (Array.isArray(cachedRows) && cachedRows.length > 0) {
            if (isDev) {
              logger.log(
                '[IPC:get-root-folders] cache hit count=%d elapsed=%dms media=%s',
                cachedRows.length,
                Date.now() - startedAt,
                mediaKey,
              );
            }
            return cachedRows;
          }
        }
        var rows = await runDbReadWorkerOnly(readPath, 'getRootFolders', options);
        if (isDev) {
          logger.log(
            '[IPC:get-root-folders] ok count=%d elapsed=%dms lite=%s',
            Array.isArray(rows) ? rows.length : 0,
            Date.now() - startedAt,
            options.lite === true ? 'yes' : 'no',
          );
        }
        /** Worker 只读连接无法写缓存；慢查询结果在主进程回填 root_folder_stats_cache，下次启动命中毫秒级 */
        var first = rows && rows.length ? rows[0] : null;
        var hasNumericStats = first && first.photo_count != null;
        if (
          options.lite !== true &&
          hasNumericStats &&
          db &&
          typeof db.mergeRootFolderStatsCache === 'function' &&
          Array.isArray(rows) &&
          rows.length > 0
        ) {
          try {
            db.mergeRootFolderStatsCache(rows, options);
          } catch (eCache) {
            void eCache;
          }
          try {
            if (catalogCache && typeof catalogCache.setRootFolders === 'function') {
              catalogCache.setRootFolders(rows, options, 24 * 60 * 60 * 1000);
            }
          } catch (eCC) {
            void eCC;
          }
        }
        return rows;
      } catch (err) {
        if (isDev) {
          logger.error(
            '[IPC:get-root-folders] fail elapsed=%dms error=%s',
            Date.now() - startedAt,
            err && err.message ? err.message : String(err),
          );
        }
        throw err;
      }
    });

    ipcMain.handle('get-folder-tree', async function (event, rootId, options) {
      var readPath = sqliteDbPath || dbPath;
      var opts = options || {};
      var payload = Object.assign({ rootId: rootId }, opts);
      if (!readPath) {
        throw new Error('get-folder-tree: database path unavailable');
      }
      if (catalogCache && typeof catalogCache.getFolderTree === 'function') {
        var cachedTree = catalogCache.getFolderTree(rootId, opts);
        if (Array.isArray(cachedTree) && cachedTree.length > 0) {
          return cachedTree;
        }
      }
      var treeRows = await runDbReadWorkerOnly(readPath, 'getFolderTree', payload);
      try {
        if (catalogCache && typeof catalogCache.setFolderTree === 'function') {
          catalogCache.setFolderTree(rootId, treeRows, opts, 24 * 60 * 60 * 1000);
        }
      } catch (eTree) {
        void eTree;
      }
      return treeRows;
    });

    ipcMain.handle('get-folder-covers', async function (event, options) {
      var opts = options || {};
      var readPath = sqliteDbPath || dbPath;
      if (!readPath) {
        throw new Error('get-folder-covers: database path unavailable');
      }
      return await runDbReadWorkerOnly(
        readPath,
        'getFolderCovers',
        opts,
        browseRequests.control(event.sender, opts),
      );
    });

    ipcMain.handle(
      'get-immediate-subfolder-covers',
      function (event, parentPath, childPaths, options) {
        return db.getImmediateSubfolderCovers(parentPath, childPaths, options || {});
      },
    );

    ipcMain.handle('get-photos', function (event, options) {
      return runDbReadWorkerOnly(
        sqliteDbPath,
        'getPhotos',
        options || {},
        browseRequests.control(event.sender, options),
      );
    });

    /**
     * 图片信息面板的「主题标签」。
     *
     * 走的是**独立于 `get-photo-info` 的一条路**：标签存在搜图索引库里（不在 photos 表），
     * 而 `getPhotoInfo` 只连主库。两条异步必须在渲染端**并进同一个对象再重画** ——
     * 分头渲染会变成「谁后到谁赢」，这是本项目已经踩过并按住的坑
     * （见 `renderer/app.js` 的 `patchInfo`）。
     *
     * `locale` 由调用方给：库里存的是**词表下标**，映射成哪国文字取决于界面语言。
     * 切语言时渲染端本来就会重画，所以这里按需映射、不缓存。
     */
    ipcMain.handle('get-photo-ai-tags', function (event, photoId, locale) {
      if (!semanticTags || !photoId) return [];
      return semanticTags.tagsFor(Number(photoId), locale);
    });

    /**
     * 「画面标签」（JoyTag）—— 与上面那条同构的跨库只读通道（tag-index.sqlite）。
     * `locale === 'en'` 时返回英文原文，否则返回中文映射（缺失回落英文）。
     */
    ipcMain.handle('get-photo-joy-tags', function (event, photoId, locale) {
      if (!joyTagTags || !photoId) return [];
      return joyTagTags.tagsFor(Number(photoId), locale);
    });

    /**
     * 「标签导航页」的四条通道（分类树 / 节点标签 / 搜索 / 某标签下的照片）。
     *
     * 前三条只碰 tag 索引库，直接转发给 `tagNav`；第四条要**跨库**（tag 库给有序 id、
     * 主库给照片行），所以走下面 `fetchTagNavPhotoRows` 这个显式组合。
     * 网页端复用同一个函数（注入进 `webServer`），保证两端读数一致。
     */
    ipcMain.handle('get-tag-nav-status', function () {
      return tagNav ? tagNav.status() : { available: false, tags: 0, photos: 0 };
    });
    ipcMain.handle('get-tag-nav-tree', function () {
      return tagNav ? tagNav.tree() : [];
    });
    ipcMain.handle('get-tag-nav-node', function (event, nodeId, locale) {
      return tagNav ? tagNav.node(nodeId, locale) : { tags: [], total: 0, indexed: 0 };
    });
    ipcMain.handle('get-tag-nav-search', function (event, keyword, locale) {
      return tagNav ? tagNav.search(keyword, locale) : { tags: [], nodes: [], indexed: 0 };
    });
    ipcMain.handle('get-tag-nav-photos', function (event, tag, options) {
      return fetchTagNavPhotoRows(tag, options);
    });

    ipcMain.handle('get-photo-dimensions', async function (event, photoId) {
      if (!db || !photoId) return null;
      var photo = db.getPhotoInfo(Number(photoId));
      if (!photo || !photo.file_path) return null;
      if (photo.width > 0 && photo.height > 0) {
        return { width: photo.width, height: photo.height };
      }
      try {
        var metadata = await require('sharp')(photo.file_path).metadata();
        if (metadata && metadata.width > 0 && metadata.height > 0) {
          db.updatePhotoDimensions(photoId, metadata.width, metadata.height);
          return { width: metadata.width, height: metadata.height };
        }
      } catch (e) {
        // sharp 解析失败，返回 null
      }
      return null;
    });

    ipcMain.handle('get-folder-photos', function (event, folderPath, options) {
      reloadSettingsFromDiskSilently();
      var opts = Object.assign({}, options || {});
      if (opts.includeSubfolders === undefined) {
        opts.includeSubfolders = settings.browseFolderIncludeSubfolders !== false;
      }
      return runDbReadWorkerOnly(
        sqliteDbPath,
        'getFolderPhotos',
        Object.assign(opts, { folderPath }),
        browseRequests.control(event.sender, opts),
      );
    });

    ipcMain.handle('get-date-groups', async function (event, options) {
      try {
        return await runDbReadWorkerOnly(sqliteDbPath, 'getDateGroups', options || {});
      } catch (e) {
        logger.error('get-date-groups worker failed:', e && e.message ? e.message : e);
        throw new Error('get-date-groups failed: db_read_unavailable', { cause: e });
      }
    });

    ipcMain.handle('get-date-photos', async function (event, dateStr, options) {
      try {
        var op = Object.assign({}, options || {}, { dateStr: dateStr });
        return await runDbReadWorkerOnly(
          sqliteDbPath,
          'getDatePhotos',
          op,
          browseRequests.control(event.sender, op),
        );
      } catch (e) {
        if (e && e.message === 'db-read cancelled') throw e;
        logger.error('get-date-photos worker failed:', e && e.message ? e.message : e);
        throw new Error('get-date-photos failed: db_read_unavailable', { cause: e });
      }
    });

    ipcMain.handle('get-full-photo', function (event, photoId) {
      return db.getFullPhoto(photoId);
    });

    ipcMain.handle('search-photos', function (event, query, options) {
      return runDbReadWorkerOnly(
        sqliteDbPath,
        'searchPhotos',
        Object.assign({}, options || {}, { query }),
        browseRequests.control(event.sender, options),
      );
    });

    /**
     * 关键词搜**目录**（搜图页「关键词」档的「文件夹」分组）。
     *
     * 与 `search-photos` 刻意**两条 IPC**：那边返回图片、这边返回目录，两者的分页、排序、
     * 代价模型都不同（详见 `database.js#searchFolders` 里关于覆盖索引与回表那段）。合成一条
     * 只会让调用方在「只要目录」时也得等图片那一半。
     */
    ipcMain.handle('search-folders', function (event, query, options) {
      return runDbReadWorkerOnly(
        sqliteDbPath,
        'searchFolders',
        Object.assign({}, options || {}, { query }),
        browseRequests.control(event.sender, options),
      );
    });

    ipcMain.handle('ai-search-status', async function () {
      return semanticSearch.refresh();
    });
    ipcMain.handle('ai-search-install', function () {
      var task = semanticSearch.start('install');
      emitBackgroundTasksChangedThrottled(true);
      return task;
    });
    ipcMain.handle('ai-search-index', function () {
      var task = semanticSearch.start('index');
      emitBackgroundTasksChangedThrottled(true);
      return task;
    });
    ipcMain.handle('ai-search-cancel', function () {
      return semanticSearch.cancel();
    });
    ipcMain.handle('ai-search-query', function (_event, query) {
      // 用户正等着这个结果 —— 让后台长任务在下一个批次边界停下，把 CPU 与磁盘让出来。
      // 只包查询，不包 install / index：那两个是长跑索引，抢占别的任务反而更慢。
      return interactionPreempt.withPreempt(function () {
        return semanticSearch.run('search', query, searchMatchOptions());
      });
    });
    /**
     * 预选词。
     *
     * **按入参形状分岔成两条路**（2026-10-09 起；不是新旧替换，是「两个不同的问题」）：
     *
     *   - `{ lang, limit }`：**常规路径**，界面唯一的用法。答案就是「这个库里哪些词点下去有图」，
     *     而这份信息**已经在索引库里**（`embeddings.tags` = 每张图的 top-3 标签词表下标）
     *     ⇒ 主进程开一条只读 SQL 转置统计即可（`suggestTermsFromTags`，实测 48 ms）。
     *   - `['词', ...]`（数组，老契约）：对这一组**指定的**词打分。界面已经不走这条，
     *     但只有它能回答「**词表外**的任意词有没有内容」—— 只读 SQL 路只能在 308 词的词表里
     *     查下标，词表外的词一律 0。所以它保留，仍走 worker 的 `suggest` 分支。
     *
     * 两条路的回答形状**逐字段一致**（`{ sampled, terms: [{ text, hits }] }`），
     * 渲染层不需要知道这次是谁答的。🔴 但 `hits` 的口径**两条路本来就不一样**
     *     （老路 = 用 CLIP 采样打分过的张数；只读路 = 把该词排进 top-3 标签的张数），
     *     所以它**只用于排序与挡掉 0 命中，不是张数**，不许显示给用户 ——
     *     详见 `SemanticTags.suggestTerms` 的注释。
     */
    ipcMain.handle('ai-search-suggest', function (_event, request) {
      if (Array.isArray(request)) {
        var list = request.slice(0, 64).map(function (item) {
          return String(item == null ? '' : item);
        });
        if (!list.length) return Promise.resolve({ sampled: 0, terms: [] });
        var payload = searchMatchOptions();
        payload.candidates = list;
        // 这条路要起只读 worker、载文本编码器 —— 算作交互活跃。
        return interactionPreempt.withPreempt(function () {
          return semanticSearch.run('suggest', '', payload);
        });
      }
      // 只读 SQL 读的是「用户正等着的界面元素」，同样算交互活跃（虽然它毫秒级、不会拖慢后台）。
      return interactionPreempt.withPreempt(function () {
        return Promise.resolve(suggestTermsFromTags(request));
      });
    });
    ipcMain.handle('face-action', function (_event, operation, args) {
      if (operation === 'status') return faceService.refresh();
      if (operation === 'install' || operation === 'index') {
        // 「另一套索引在跑 / 数据库维护在跑」都由 faceService.canRun 判定，
        // start() 会把拒因当错误码抛出去（AI_BUSY / AI_MAINTENANCE），这里不重复判断。
        var faceTask = faceService.start(operation);
        emitBackgroundTasksChangedThrottled(true);
        return faceTask;
      }
      if (operation === 'cancel') return faceService.cancel();
      return faceService.run(operation, args);
    });

    ipcMain.handle('remove-folder', function (event, rootPath) {
      var rid = resolveRootIdByPath(rootPath);
      var r = db.removeRootFolder(rootPath);
      if (rid) invalidateCatalogCacheForRootSafe(rid);
      else invalidateCatalogCachesSafe();
      return r;
    });

    ipcMain.handle('rescan-folder', async function (event, rootPath) {
      return enqueueScanTask({
        source: 'rescan',
        rootPath: rootPath,
      });
    });

    /**
     * 重扫**全部**根目录（设置页「重新扫描全部」）。语义与单目录 `rescan-folder` 完全一致，
     * 只是把 N 个任务一次性排上、等全部跑完再返回一个汇总。
     *
     * 🔴 根目录列表在**主进程**读（只读 Worker + lite），不拿渲染端 `state.rootFolders`：
     * 那是一份可能过时的缓存 —— 扫描刚在库里登记了新根、渲染端那一拍还没同步到时它是空的，
     * 结果就是「点了没反应」。此刻的事实只在库里。
     *
     * 并发仍然是串行的：`enqueueScanTask` 只是入队，真正执行在 `processScanQueue` 的
     * while 循环里逐个取，每个都整段独占 `dbWriteQueue` 的 'scan' 租约。所以这里
     * 「一次性全排上」不会变成并行写库，只是把队列一次性填满（用户能在任务条看到
     * 「扫描队列 · 还有 N 项等待」）。优先级与手动单扫同档（USER）。
     *
     * 中断：停止按钮走 `cancel-scan` → `clearPendingScanQueue()`，它会把**还在排队的**
     * 全部结算成 `cancelled`，本 Promise 随之解析 —— 所以「停止」停的是一整批。
     */
    ipcMain.handle('rescan-all-folders', async function () {
      var readRootsPath = sqliteDbPath || dbPath;
      if (!readRootsPath) return { success: false, error: 'database path unavailable' };
      var roots;
      try {
        roots = await runDbReadWorkerOnly(readRootsPath, 'getRootFolders', { lite: true });
      } catch (eRoots) {
        return {
          success: false,
          error: eRoots && eRoots.message ? eRoots.message : String(eRoots),
        };
      }
      var paths = [];
      if (Array.isArray(roots)) {
        for (var i = 0; i < roots.length; i++) {
          var p = roots[i] && roots[i].path;
          if (p) paths.push(p);
        }
      }
      if (paths.length === 0) return { success: false, error: 'empty' };
      var results = await Promise.all(
        paths.map(function (p) {
          return enqueueScanTask({ source: 'rescan', rootPath: p });
        }),
      );
      var failed = 0;
      var cancelled = 0;
      var cleanupDeleted = 0;
      var firstError = '';
      for (var j = 0; j < results.length; j++) {
        var r = results[j];
        if (r && r.success) {
          cleanupDeleted += Number(r.cleanupDeleted) || 0;
        } else if (r && r.cancelled) {
          cancelled++;
        } else {
          failed++;
          if (!firstError && r && r.error) firstError = r.error;
        }
      }
      return {
        success: true,
        total: paths.length,
        cancelled: cancelled,
        failed: failed,
        cleanupDeleted: cleanupDeleted,
        error: firstError,
      };
    });

    // 窗口控制
    ipcMain.on('window-minimize', function () {
      if (mainWindow) mainWindow.minimize();
    });
    ipcMain.on('window-maximize', function () {
      if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      }
    });
    ipcMain.on('window-close', function () {
      if (mainWindow) mainWindow.close();
    });
    ipcMain.handle('window-is-maximized', function () {
      return mainWindow ? mainWindow.isMaximized() : false;
    });

    // Web 服务器地址（渲染进程主动查询）
    ipcMain.handle('get-web-url', async function () {
      var url = await webServerReady;
      if (!settings.webLanEnabled) return '';
      return url || '';
    });

    ipcMain.handle('web-server-get-status', async function () {
      var url = await webServerReady;
      return {
        enabled: settings.webLanEnabled === true,
        running: !!(webServer && webServer.server),
        url: settings.webLanEnabled === true ? url || '' : '',
      };
    });

    ipcMain.handle('web-server-set-enabled', function (event, enabled) {
      settings.webLanEnabled = !!enabled;
      ensureSettingsShape();
      saveSettings();
      if (webServer && typeof webServer.setLanEnabled === 'function') {
        webServer.setLanEnabled(settings.webLanEnabled);
      }
      return {
        success: true,
        status: {
          enabled: settings.webLanEnabled,
          running: !!(webServer && webServer.server),
          url: settings.webLanEnabled ? 'pending' : '',
        },
      };
    });

    /** 桌面端 HLS 拉流用（127.0.0.1，与网页密码无关） */
    ipcMain.handle('get-web-local-base-url', async function () {
      await webServerReady;
      if (!webServer || !webServer.port) return '';
      return 'http://127.0.0.1:' + webServer.port;
    });

    ipcMain.handle('hls-stop-session', function (event, sessionId) {
      var sid = String(sessionId || '').trim();
      if (!/^[a-f0-9]{24}$/.test(sid)) {
        return { ok: false };
      }
      if (webServer && webServer.hlsManager) {
        webServer.hlsManager.stopSession(sid);
      }
      return { ok: true };
    });

    ipcMain.handle('tunnel-get-status', function () {
      return getTunnelStatus();
    });

    ipcMain.handle('tunnel-set-enabled', async function (event, enabled) {
      tunnelTask.enabled = !!enabled;
      if (!tunnelTask.enabled) {
        stopCloudflareTunnelInternal();
        return { success: true, status: getTunnelStatus() };
      }
      try {
        await startCloudflareTunnelInternal();
        return { success: true, status: getTunnelStatus() };
      } catch (err) {
        tunnelTask.status = 'error';
        tunnelTask.error = err && err.message ? err.message : String(err);
        tunnelTask.running = false;
        return { success: false, error: tunnelTask.error, status: getTunnelStatus() };
      }
    });

    // 设置相关
    ipcMain.handle('get-preview-adjacent-photo', async function (event, options) {
      if (!db || typeof db.getPreviewAdjacentPhoto !== 'function') return null;
      try {
        // 让出事件循环再跑同步 SQLite，减轻与其它 IPC / UI 更新同帧饿死
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
        // 随机幻灯每几秒一次：勿每次同步读 settings.json，避免磁盘与 JSON 解析拖慢换片
        var opts = Object.assign({}, options || {});
        if (opts.view === 'folder' && opts.includeSubfolders === undefined) {
          opts.includeSubfolders = settings.browseFolderIncludeSubfolders !== false;
        }
        return db.getPreviewAdjacentPhoto(opts) || null;
      } catch (e) {
        return null;
      }
    });

    ipcMain.handle('get-random-preview-batch', async function (event, options) {
      if (!db || typeof db.getRandomPreviewPhotoBatch !== 'function') return [];
      try {
        await new Promise(function (resolve) {
          setImmediate(resolve);
        });
        var opts = Object.assign({}, options || {});
        if (opts.view === 'folder' && opts.includeSubfolders === undefined) {
          opts.includeSubfolders = settings.browseFolderIncludeSubfolders !== false;
        }
        return db.getRandomPreviewPhotoBatch(opts) || [];
      } catch (e) {
        return [];
      }
    });
    ipcMain.handle('get-settings', function () {
      reloadSettingsFromDiskSilently();
      return cloneSettingsForIpc();
    });

    ipcMain.handle('update-settings', function (event, newSettings) {
      if (newSettings && typeof newSettings === 'object') {
        var keys = Object.keys(newSettings);
        for (var ki = 0; ki < keys.length; ki++) {
          settings[keys[ki]] = newSettings[keys[ki]];
        }
      }
      ensureSettingsShape();
      saveSettings();
      if (newSettings && Object.prototype.hasOwnProperty.call(newSettings, 'uiLocale')) {
        refreshTrayAndTitleLocalized();
      }
      // 同步 web 密码
      if (
        newSettings &&
        Object.prototype.hasOwnProperty.call(newSettings, 'webPassword') &&
        webServer
      ) {
        webServer.setPassword(settings.webPassword || '');
        if (!settings.webPassword || !String(settings.webPassword).trim()) {
          stopCloudflareTunnelInternal();
        }
      }
      return cloneSettingsForIpc();
    });

    ipcMain.handle('sync-ui-locale', function () {
      reloadSettingsFromDiskSilently();
      refreshTrayAndTitleLocalized();
      return { ok: true };
    });

    // 应用版本号（关于对话框用）。
    // 🔴 这个通道曾经「只有消费端、没有生产端」：实现在已删除的孤儿模块
    // `src/main/ipc-handlers.js` 里，`preload` 照发、渲染端用 `.catch(() => {})` 吞掉 rejection，
    // 于是关于对话框一直显示字面 `%VERSION%` 且不报任何错。
    // 机械防线见 `scripts/module-reachability-regression.js`（preload 发起的每个通道都必须有人注册）。
    ipcMain.handle('get-app-version', function () {
      return app.getVersion();
    });

    app.on('before-quit', function (event) {
      if (optimizeTaskRunning) {
        event.preventDefault();
        return;
      }
      isQuitting = true;
      if (semanticSearch) semanticSearch.dispose();
      if (semanticTags) semanticTags.close();
      if (faceService) faceService.dispose();
      if (startupInvalidCleanupTask.timer) {
        clearTimeout(startupInvalidCleanupTask.timer);
        startupInvalidCleanupTask.timer = null;
      }
      startupInvalidCleanupTask.running = false;
      terminateScanWorkerSilently();
      stopCloudflareTunnelInternal();
      if (webServer && typeof webServer.stop === 'function') {
        try {
          webServer.stop();
        } catch (eWs) {}
      }
      try {
        dbReadWorkerPool.terminate();
      } catch (ePool) {
        void ePool;
      }
    });

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(cachedAppIcon);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        showMainWindow();
      }
    });

    app.on('will-quit', function () {
      try {
        globalShortcut.unregisterAll();
      } catch (e) {}
      if (tray) {
        try {
          tray.destroy();
        } catch (e2) {}
        tray = null;
      }
    });
  })
  .catch(function (err) {
    var msg = err && err.stack ? err.stack : String(err);
    logger.error('[startup] fatal initialization error:', msg);
    try {
      var en0 = getNormalizedUiLocale() === 'en';
      dialog.showErrorBox(
        en0 ? 'Startup failed' : '启动失败',
        en0
          ? 'Initialization failed. Check the database and settings.\n\n' + msg
          : '应用初始化失败，请检查数据库与配置文件。\n\n' + msg,
      );
    } catch (e) {}
    app.quit();
  });

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
