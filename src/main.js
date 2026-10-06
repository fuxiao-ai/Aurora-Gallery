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
/**
 * 用户交互抢占信号：搜图查询进行中时，后台长任务在批次边界停下让位。
 * 与内嵌网页 API 共用同一份单例（同进程），所以网页端搜图也会让后台任务让位。
 */
const { interactionPreempt } = require('./main/interaction-preempt');
/**
 * 照片信息面板的字段注册表：与渲染端 / 网页端**同一份**。
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
/** 搜图匹配阈值的范围与默认值：唯一定义处（src/ai/index-store.js），设置默认值从它取。 */
const { MATCH_THRESHOLD_RANGE } = require('./ai/index-store');
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

/** 各任务 ETA 平滑状态（新任务 startedAt 变化时重置） */
var etaSmoothByKey = Object.create(null);

/**
 * 根据已开始耗时与完成量估算剩余秒数；不足数据时返回 null。
 * 平均速度 = done / elapsed（件/毫秒），剩余毫秒 = remaining / rate，须除以 1000 才是秒（此前误把毫秒当秒）。
 */
function estimateEtaSeconds(startedAt, done, total) {
  if (!startedAt || total <= 0) return null;
  var remaining = total - done;
  if (remaining <= 0) return 0;
  if (done < 1) return null;
  var elapsed = Date.now() - startedAt;
  if (elapsed < 800) return null;
  // 前段波动大：至少完成 3 件，或已运行 5s 再估（二者满足其一）
  if (done < 3 && elapsed < 5000) return null;
  var rate = done / elapsed;
  if (rate <= 0) return null;
  var etaMs = remaining / rate;
  var sec = Math.ceil(etaMs / 1000);
  return Math.max(1, sec);
}

/**
 * 对 ETA 做指数平滑，减少 UI 轮询时的抖动；taskKey 区分目录扫描/缩略图等。
 */
function estimateEtaSecondsSmoothed(taskKey, startedAt, done, total) {
  if (!taskKey) return estimateEtaSeconds(startedAt, done, total);
  if (!startedAt) {
    delete etaSmoothByKey[taskKey];
    return null;
  }
  var raw = estimateEtaSeconds(startedAt, done, total);
  if (raw == null) {
    delete etaSmoothByKey[taskKey];
    return null;
  }
  if (raw === 0) {
    delete etaSmoothByKey[taskKey];
    return 0;
  }
  var st = etaSmoothByKey[taskKey];
  if (!st || st.startedAt !== startedAt) {
    etaSmoothByKey[taskKey] = { startedAt: startedAt, eta: raw };
    return raw;
  }
  var blended = Math.round(0.38 * raw + 0.62 * st.eta);
  if (blended < 1) blended = 1;
  etaSmoothByKey[taskKey].eta = blended;
  return blended;
}

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
  'scan-files': '写入照片记录',
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
 *    而且前提也不成立：**库在 `LOCALAPPDATA`（系统盘），只有照片在 `K:` / `G:` 外接盘**
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
   *    曾经拿它当分母，结果因为「倒序走 + 缺缩略图的行几乎全在低位老照片上」，
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
var autoBackfillScheduled = false;
var autoDuplicateHashScheduled = false;
var autoDuplicateHashRetryTimer = null;
var sqliteDbPath = '';
var semanticSearch = null;
/** 照片信息面板读「AI 内容标签」的只读通道（标签在搜图索引库里，不在 photos 表）。 */
var semanticTags = null;
var faceService = null;
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
    duplicateHashTask.running ||
    invalidCleanupTask.running ||
    startupInvalidCleanupTask.running
  );
}
/** 当前挡着库的是谁：给界面一句能行动的话，而不是笼统的「后台任务进行中」。 */
function dbWriteBusyLabel() {
  var name = dbWriteQueue.busyName();
  if (!name) return '';
  if (name === 'thumbnail-fix') return '数据库迁移（缩略图标记）';
  if (name === 'deferred-index') return '数据库索引补齐';
  if (name === 'fts-index') return '文件名索引重建';
  if (name === 'invalid-cleanup') return '清理失效文件记录';
  // 回填 / 重复哈希现在是**按批次**占写锁的，批间会放开让别的任务过，
  // 所以它们也会出现在 busyName() 里（过去这两个任务压根不进队）。
  if (name === 'thumbnail-backfill') return '缩略图补全';
  if (name === 'dup-hash') return '重复文件比对';
  // 扫描（T2 起）也占闸门：它是最长的一个占用者，报出名字比笼统的「后台任务」有用得多
  if (name === 'scan') return '目录扫描';
  // 手动维护这两条一直漏了映射 → 界面会直接显示英文任务名
  if (name === 'maintenance-rebuild-thumbnail-flags') return '重建缩略图标记';
  if (name === 'maintenance-optimize-database') return '优化数据库（VACUUM）';
  return name;
}
/** 维护被挡时的文案：能让用户知道在等谁、等的是什么，比笼统的 busy 有用得多。 */
function maintenanceBusyMessage() {
  var label = dbWriteBusyLabel();
  // 不再写「启动期」：T2 起扫描、手动维护也走同一条队列，被挡住的未必是启动期任务
  if (label) return '后台任务进行中（' + label + '），请等它跑完再试';
  return '后台任务进行中，请稍后再试';
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
    { label: '数据库所在分区', free: maintenanceGuard.freeDiskBytes(path.dirname(sqliteDbPath)) },
    { label: '系统临时目录', free: maintenanceGuard.freeDiskBytes(os.tmpdir()) },
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
/** 空洞少到可忽略时直说：这次优化基本只是重建统计信息，别为了几 MB 重写整库。 */
function vacuumReclaimHint(estimate) {
  if (!estimate || estimate.reclaimable * 100 >= estimate.fileSize) return '';
  return '（几乎没有空洞，本次优化的主要收益是重建统计信息）';
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
      error: locked ? '数据库被其他程序占用，请关闭后重试（' + raw + '）' : raw,
    };
    logger.error('Database maintenance failed:', error);
    if (operation !== 'ensureFtsIndex' && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, { type: 'error', message: maintenanceResult.error });
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
  return getVideoFrameThumb().buildVideoPlaceholderJpeg(opts);
}

function extractVideoThumbnailWithFfmpeg(filePath, opts) {
  return getVideoFrameThumb().extractVideoFrameJpeg(
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
 * 内容区 / 分页条 / 设置页）的底色按一个 alpha 乘子掺进 transparent，**照片与照片卡片一律不动**。
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
     *    与 `thumb-concurrency-cold.log`；16 核机器、24 / 80 张真实照片、只读不写库）：
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
    thumbSize: 256,
    thumbQuality: 75,
    /** 关闭主窗口：ask 弹出选择 | tray 直接托盘 | quit 直接退出 */
    windowCloseBehavior: 'ask',
    /** 预览底部主行显示项（管理设置中可关） */
    previewShowFileName: true,
    previewShowDateTaken: true,
    previewShowFileSize: true,
    previewShowDimensions: true,
    previewShowPosition: true,
    /**
     * 预览页「照片信息」面板显示哪些字段。
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
 */
function searchMatchOptions() {
  return { threshold: Number(settings.aiSearchMatchThreshold) };
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
  var sz = parseInt(settings.thumbSize, 10);
  if ([128, 192, 256, 320].indexOf(sz) < 0) settings.thumbSize = 256;
  var q = parseInt(settings.thumbQuality, 10);
  if (isNaN(q)) settings.thumbQuality = 75;
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

  // 照片信息面板的启用字段集：未知 id 丢掉、去重、按注册表顺序重排。
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
    size: parseInt(settings.thumbSize, 10) || 256,
    quality: parseInt(settings.thumbQuality, 10) || 75,
  };
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
  // 分母是**起始快照**：并发入库的新照片不在里面，分子可能反超。两头都夹住，
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
    /** 同 `done`；语义更直白的别名，给不方便读 `done` 的消费方 */
    processed: processed,
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
     * 🔴 它**刻意不做主口径**：补全按 id 倒序走，而缺缩略图的行几乎全压在低位老照片上
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
 * 被打开两次。补全任务本来就为这两个目的各要读一次，合并后**每张照片只开一次文件**。
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
 * 对一批待补全记录做有限并发处理（共享队列 + N 个 worker 协程）。
 */
async function runRowsWithThumbConcurrency(rows, yieldEvery) {
  var n = rows.length;
  if (n === 0) return;
  var conc = Math.min(getEffectiveThumbBackfillConcurrency(), n);
  var next = 0;

  /**
   * 共享读取：把整个文件读进内存，供 sharp 解码与 SHA-256 **共用同一份字节**。
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
        if (needSize || needExif) {
          headerTried = true;
          header = await readHeaderMeta(
            loadSharp()(sharedBuf || row.file_path, { failOnError: false }),
          );
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
            var instance = loadSharp()(sharedBuf || row.file_path, { failOnError: false });
            if (needSize || needExif) {
              headerTried = true;
              header = await readHeaderMeta(instance);
            }
            // 🔴 dHash 必须取在 `.rotate()` **之前**：dHash 历来是不旋转的（旧路径
            //    `computeDhash(row.file_path)` 就没有 `.rotate()`），带 EXIF 方向的照片
            //    一旦先旋转再算，位会全变 —— 而 dHash 是相似聚类的输入，位差会翻面。
            if (needDhash) {
              dhashFromDecode = await computeDhashFromPipeline(instance);
              dhashDecodeUsed = true;
            }
            thumb = await instance
              .rotate()
              .resize(topts.size, topts.size, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: topts.quality })
              .toBuffer();
          }
          db.updatePhotoThumbnail(row.id, thumb, { size: topts.size, format: 'jpeg' });
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
          // 缩略图分支已经解过一次码 ⇒ 直接用它的结果；否则（已有缩略图、还缺 dHash 的那一大批）
          // 才回落到「按路径重新打开并解码」。
          var dhash = dhashDecodeUsed ? dhashFromDecode : await computeDhash(row.file_path);
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
 * 摘要的两条入口（`hashFileSha256` / `hashBufferSha256`）已抽到 **`src/main/file-hash.js`**。
 *
 * 🔴 抽出去不是为了好看：两条路写的是同一列 `photos.file_hash`，而「重复项」按它分组 ——
 *    摘要一旦不一致，成对的照片会被**静默**分到两个组里。`file-hash.js` 不依赖 electron，
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
    if (service.status().busy) {
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
    var dbPath = path.join(userDataPath, 'photos.db');
    startupMetrics.setOutput(path.join(userDataPath, 'startup-performance.json'));
    var catalogCachePath = path.join(userDataPath, 'catalog-cache.db');
    sqliteDbPath = dbPath;
    semanticSearch = new (require('./main/semantic-search').SemanticSearch)(
      dbPath,
      path.join(path.dirname(dbPath), 'ai-search'),
      {
        // 搜图是纯只读：索引进行中把请求托给正在跑的索引 worker（它已经载好模型），
        // 用已落库的向量出结果，于是「边建索引边搜图」成立、结果只覆盖已索引的照片。
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
     * 「AI 内容标签」的读取通道。与搜图索引共用同一个 `ai-search` 目录，但它是
     * **独立的只读连接**：标签是索引库里的派生物（见 `src/ai/photo-tags.js`），
     * 而 `getPhotoInfo()` 只连主库、跨不了库。
     *
     * 惰性建连接 —— 从没建过搜图索引的用户不会有任何开销（连文件都不会去 stat 第二次）。
     */
    semanticTags = new (require('./main/semantic-tags').SemanticTags)(
      path.join(path.dirname(dbPath), 'ai-search'),
    );
    /**
     * 启动后顺手补一次「AI 内容标签」，补完再通知渲染端重画面板。
     *
     * ## 为什么必须有这一步
     *
     * 标签只在**建索引时**才算得出来（那一刻图片向量才在手上）。所以升级前就已经索引好的
     * 那批照片是永远没有标签的 —— 而用户装上新版本后第一件事恰恰是打开照片看标签。
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
        if (semanticSearch.status().busy) return;
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
    // 只读查询（搜图、人物列表、人物照片）不受这两个开关影响，索引期间照常可用。
    // 数据库维护期间同样要拦，但**只有独占整库的那两种**（VACUUM / 重建缩略图标记）：它们要
    // 重写整库，索引 worker 一边跑一边写会把维护顶成 `database is locked`。
    // ⚠️ 启动期的 FTS 索引刻意**不算**在这里（见 ai-index-gate.js）：它和 AI 索引走同一条
    // 写库队列，串行由队列保证；把它算进来就是过去那个误报——开机十几秒内点「建 AI 索引」
    // 会被回一句「数据库维护进行中」，而其实立刻就能跑。
    // 返回的是**错误码**而不是 false，界面才能说清「是数据库维护在占着」而不是笼统的「AI 任务正在运行」。
    semanticSearch.canRun = function () {
      return aiIndexCanRun({
        exclusiveMaintenance: exclusiveMaintenanceRunning,
        peerBusy: faceService.status().busy,
      });
    };
    faceService.canRun = function () {
      return aiIndexCanRun({
        exclusiveMaintenance: exclusiveMaintenanceRunning,
        peerBusy: semanticSearch.status().busy,
      });
    };
    // 搜图曾经另有一道闸门（人脸索引在跑时直接拒绝）。现已撤除：
    // 真正的约束是内存，而「人脸索引 + 一个搜图 worker」实测根本不崩——人脸模型才 41 MB，
    // 会崩的是**同一份 SigLIP2 被并发载入两遍**（内存耗尽），那条路已经由 relay 彻底堵死：
    // 搜图索引在跑时搜索托给同一个 worker，永远不会有第二份 SigLIP2。
    // 加上搜图现在只载文本编码器（textOnly，省掉视觉那约 95 MB），这条路径只会更轻。
    settingsFilePath = path.join(userDataPath, 'settings.json');
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
    loadSettings();

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
          headers: { 'Content-Type': 'image/jpeg' },
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
          try {
            db.updatePhotoThumbnail(photoId, vbuf, { size: topts.size, format: 'jpeg' });
          } catch (eUp) {}
          return new Response(vbuf, {
            headers: { 'Content-Type': 'image/jpeg' },
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
          semanticSearch: semanticSearch,
          faceService: faceService,
          getBrowseFolderIncludeSubfolders: function () {
            reloadSettingsFromDiskSilently();
            return settings.browseFolderIncludeSubfolders !== false;
          },
          /** 网页端搜图用与桌面同一份阈值：两边共用 sever 上的一套设置。 */
          getAiSearchMatchThreshold: function () {
            return settings.aiSearchMatchThreshold;
          },
          /** 网页端「照片信息」面板照用桌面端勾好的字段集 */
          getInfoPanelFields: function () {
            return settings.infoPanelFields;
          },
          /** 网页端「AI 标签」与桌面端同源（同一个只读连接，读数一致） */
          getPhotoAiTags: function (photoId, locale) {
            return semanticTags ? semanticTags.tagsFor(photoId, locale) : [];
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
        title: '选择照片文件夹',
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
      var confirmRes = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['取消', '确认清理'],
        defaultId: 0,
        cancelId: 0,
        title: '清理无效记录',
        message: '即将清理数据库中已不存在的文件记录。',
        detail: '建议先备份数据库（复制 photos.db）。此操作不可撤销，确认后继续？',
      });
      if (confirmRes !== 1) {
        return { success: false, error: '用户取消' };
      }
      if (typeof db.cleanupMissingFilesYielding !== 'function') {
        return { success: false, error: '当前版本不支持分批清理' };
      }
      invalidCleanupTask.running = true;
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
            // 倒序游标（0 = 不限上界）：新记录先查，刚被搬走的照片第一时间清掉
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
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['取消', '确认优化'],
        defaultId: 0,
        cancelId: 0,
        title: '优化数据库',
        message: '即将执行数据库 VACUUM 优化。',
        detail:
          '建议先使用备份功能备份数据库。大库可能耗时较长，优化期间请勿关闭应用。' +
          (estimate && estimate.need
            ? '本次需要额外约 ' +
              maintenanceGuard.formatBytes(estimate.need) +
              ' 临时空间，两处都要够：' +
              vacuumSpaceSummary() +
              '。库内可回收约 ' +
              maintenanceGuard.formatBytes(estimate.reclaimable) +
              vacuumReclaimHint(estimate) +
              '。'
            : ''),
      });
      if (confirmation.response !== 1) return { success: false, error: '用户取消' };
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

    // ── 相似照片检测（dHash）IPC ──

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

    /** 按 dHash 获取照片列表 */
    ipcMain.handle('maintenance-get-photos-by-dhash', function (event, dhash) {
      if (!dhash) return [];
      if (!db) return [];
      db.ensureDhashSchema();
      return db.getPhotosByDhash(String(dhash));
    });

    /** 第二层：单张照片的跨文件夹相似查询（按需实时） */
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

    /** 批量按 ID 查询照片详情 */
    ipcMain.handle('maintenance-get-photos-by-ids', function (event, ids) {
      if (!db || !Array.isArray(ids) || ids.length === 0) return [];
      // 调用方是「查找相似照片」的结果回传，长度跟着相似结果走 —— 同样不能展开成
      // `IN (?,?,...)`，理由与 similar-detection.js 里那处一致，见 src/main/sql-id-list.js。
      // （旧写法还把同一条 SQL prepare 了两次：一次给 .all、一次给 .apply 的 this。）
      var sql =
        'SELECT id, file_name, file_path, folder_path, file_size, file_type, width, height, date_taken, date_modified, has_thumbnail, is_favorite FROM photos WHERE ' +
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
      });
      return {
        scan: {
          active: isFolderScanRunning(),
          progress: scanProgress,
          queue: getScanQueueStatus(),
        },
        thumbs: getThumbnailBackfillProgress(),
        invalidCleanup: getInvalidCleanupTaskProgress(),
        duplicateHash: getDuplicateHashTaskProgress(),
        face: faceService ? faceService.status() : {},
        semantic: semanticSearch ? semanticSearch.status() : {},
        optimizing: optimizeTaskRunning,
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
          return { success: false, error: '无效的照片 ID' };
        }
        var photo = db.getFullPhoto(id);
        if (!photo || !photo.file_path) {
          return { success: false, error: '照片记录不存在' };
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
          return { success: false, error: '无效的照片 ID' };
        }
        var photo = db.getFullPhoto(id);
        if (!photo || !photo.file_path) {
          return { success: false, error: '照片记录不存在' };
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
          return { success: false, error: '无效的照片 ID' };
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
          return { success: false, error: '无效的照片 ID' };
        }
        var result = db.togglePhotoFavorite(id);
        if (!result) {
          return { success: false, error: '照片记录不存在' };
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

    ipcMain.handle('show-photo-in-folder', function (event, photoId) {
      try {
        var id = parseInt(photoId, 10);
        if (!id) {
          return { success: false, error: '无效的照片 ID' };
        }
        var photo = db.getFullPhoto(id);
        if (!photo || !photo.file_path) {
          return { success: false, error: '照片记录不存在' };
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
     * 照片信息面板的「AI 内容标签」。
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
     * 预选词打分。
     *
     * 两种入参形状都用：
     *   - `{ lang, limit }`：**正常路径**。词源在服务端（`src/ai/search-vocabulary.js` 的
     *     几百词开放词表），按真实命中数排序后返回前 N 个。界面不再自己带词表，
     *     于是桌面端与网页端不可能漂移。
     *   - `['词', ...]`（数组，老契约）：只对这几个词打分。留着是为了让老调用方与
     *     静态守护断言继续有效，正常界面已经不走这条路。
     * 失败就让界面自己决定怎么退化，不是致命错误。
     */
    ipcMain.handle('ai-search-suggest', function (_event, request) {
      var payload = searchMatchOptions();
      if (Array.isArray(request)) {
        var list = request.slice(0, 64).map(function (item) {
          return String(item == null ? '' : item);
        });
        if (!list.length) return Promise.resolve({ sampled: 0, terms: [] });
        payload.candidates = list;
      } else {
        var scope = request && typeof request === 'object' ? request : {};
        payload.lang = scope.lang ? String(scope.lang) : '';
        if (scope.limit !== undefined) payload.limit = Number(scope.limit);
      }
      // 预选词打分同样是「用户在用搜图」、同样要载文本编码器 —— 一并算作交互活跃。
      return interactionPreempt.withPreempt(function () {
        return semanticSearch.run('suggest', '', payload);
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
