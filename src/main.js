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
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const { Readable } = require('stream');
const Database = require('./database');
const dbReadWorkerPool = require('./db-read-worker-pool');
const { runDbReadWorkerOnly } = require('./db-read-runner');
const { CatalogCacheDb, normalizeMediaKey } = require('./catalog-cache-db');

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
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
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
    return (
      '移入回收站失败（操作被系统中断）。请关闭可能占用该文件的程序后重试；网络路径或只读介质可能不支持回收站。'
    );
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
var scanQueue = [];
var isScanQueueProcessing = false;
var currentScanTask = null;
var scanTaskIdSeq = 1;
/** 单次补全任务记录的失败路径上限，避免极端情况下占用过多内存 */
var THUMB_BACKFILL_FAILED_PATHS_MAX = 50000;
var thumbnailBackfill = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  success: 0,
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
var optimizeTaskRunning = false;
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
function clearDuplicateHashGroupsCache(reason) {
  duplicateHashGroupsCache.total = null;
  duplicateHashGroupsCache.totalPages = null;
  duplicateHashGroupsCache.pages = Object.create(null);
  duplicateHashGroupsCache.warmedAt = 0;
  if (isDev && reason) {
    console.log('[dup-groups-cache] cleared reason=%s', String(reason));
  }
}
var duplicateHashBgLogLastAt = 0;
var DUP_HASH_BG_LOG_MIN_INTERVAL_MS = 4000;

function duplicateHashBgLog(stage, detail, force) {
  var now = Date.now();
  if (!force && now - duplicateHashBgLogLastAt < DUP_HASH_BG_LOG_MIN_INTERVAL_MS) return;
  duplicateHashBgLogLastAt = now;
  var elapsed = duplicateHashTask && duplicateHashTask.startedAt ? now - duplicateHashTask.startedAt : 0;
  var done = Number(duplicateHashTask && duplicateHashTask.done) || 0;
  var total = Number(duplicateHashTask && duplicateHashTask.total) || 0;
  var hashed = Number(duplicateHashTask && duplicateHashTask.hashed) || 0;
  var failed = Number(duplicateHashTask && duplicateHashTask.failed) || 0;
  var skippedMissing = Number(duplicateHashTask && duplicateHashTask.skippedMissing) || 0;
  if (detail != null && String(detail).length > 0) {
    console.log(
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
    console.log(
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
  afterId: 0,
};

function invalidateCatalogCachesSafe() {
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
    var target = String(rootPath || '').replace(/\//g, '\\').toLowerCase();
    var rows = db.getRootFolders({ lite: true }) || [];
    for (var i = 0; i < rows.length; i++) {
      var p = String((rows[i] && rows[i].path) || '').replace(/\//g, '\\').toLowerCase();
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
  var elapsed = Date.now() - startupStageT0;
  if (detail != null && String(detail).length > 0) {
    console.log('[startup-stage +%dms] %s | %s', elapsed, stage, String(detail));
  } else {
    console.log('[startup-stage +%dms] %s', elapsed, stage);
  }
}
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
    console.error('[path-init] failed, fallback to default:', e && e.message ? e.message : e);
  }
}

configureWritableAppPaths();

// === Settings ===
var settingsFilePath;

/** 外观风格 id → 渲染层 data-theme / data-accent / data-bg（与 renderer UI_THEME_PRESETS 一致） */
var THEME_STYLE_PRESETS = {
  midnight_classic: { theme: 'dark', uiAccent: 'violet', uiBackground: 'default' },
  ice_deep: { theme: 'dark', uiAccent: 'cyan', uiBackground: 'amoled' },
  amber_dawn: { theme: 'dark', uiAccent: 'amber', uiBackground: 'warm' },
  sky_light: { theme: 'light', uiAccent: 'cyan', uiBackground: 'ink' },
  cherry_blossom: { theme: 'light', uiAccent: 'rose', uiBackground: 'warm' },
  arctic_mint: { theme: 'light', uiAccent: 'teal', uiBackground: 'cool' },
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

/** themeStyle 有效时以预设为准写回 triple；否则由旧 triple 推断 themeStyle（兼容无此字段的旧配置） */
function reconcileThemeStyleSettings() {
  var uiAccents = ['violet', 'cyan', 'teal', 'rose', 'amber', 'mono'];
  var uiBgs = ['default', 'ink', 'warm', 'cool', 'amoled'];
  var ids = Object.keys(THEME_STYLE_PRESETS);
  var ts = settings.themeStyle;
  if (typeof ts === 'string' && ids.indexOf(ts) >= 0) {
    var pack = THEME_STYLE_PRESETS[ts];
    settings.theme = pack.theme === 'light' ? 'light' : 'dark';
    settings.uiAccent = pack.uiAccent;
    settings.uiBackground = pack.uiBackground;
    if (uiAccents.indexOf(settings.uiAccent) < 0) settings.uiAccent = 'violet';
    if (uiBgs.indexOf(settings.uiBackground) < 0) settings.uiBackground = 'default';
    return;
  }
  if (settings.theme !== 'light') settings.theme = 'dark';
  if (uiAccents.indexOf(settings.uiAccent) < 0) settings.uiAccent = 'violet';
  if (uiBgs.indexOf(settings.uiBackground) < 0) settings.uiBackground = 'default';
  var inferred = inferThemeStyleFromTriple(
    settings.theme,
    settings.uiAccent,
    settings.uiBackground,
  );
  settings.themeStyle = inferred || 'midnight_classic';
  var p2 = THEME_STYLE_PRESETS[settings.themeStyle];
  settings.theme = p2.theme === 'light' ? 'light' : 'dark';
  settings.uiAccent = p2.uiAccent;
  settings.uiBackground = p2.uiBackground;
}

/** 新安装或配置文件损坏时的完整默认形状（与磁盘合并时以磁盘键覆盖同名字段） */
function createDefaultSettings() {
  return {
    autoScanOnStartup: false,
    /** 启动后空闲时自动补全缺失缩略图（与扫描队列互斥） */
    autoThumbBackfillOnStartup: false,
    /** 缩略图补全同时处理张数（1–8），过大易占内存并加重磁盘随机读 */
    thumbBackfillConcurrency: 3,
    autoHashOnStartup: false,
    /** 默认关闭局域网访问；本机 127.0.0.1 预览/HLS 仍可在内嵌服务启动后使用 */
    webLanEnabled: false,
    cloudflareTunnelAutoStart: false,
    themeStyle: 'midnight_classic',
    theme: 'dark',
    uiAccent: 'violet',
    uiBackground: 'default',
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
  };
}

var settings = createDefaultSettings();

/** 供 IPC 返回，避免渲染进程持有主进程对象引用、并保证可结构化克隆 */
function cloneSettingsForIpc() {
  ensureSettingsShape();
  var payload = JSON.parse(JSON.stringify(settings));
  payload.hasWebPassword = !!(settings.webPassword && String(settings.webPassword).trim());
  return payload;
}

function ensureSettingsShape() {
  reconcileThemeStyleSettings();
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
  settings.webLanEnabled = settings.webLanEnabled === true;
  settings.cloudflareTunnelAutoStart = !!settings.cloudflareTunnelAutoStart;
  var subFamily = String(settings.subtitleFontFamily || '').trim().toLowerCase();
  if (['system', 'serif', 'mono'].indexOf(subFamily) < 0) subFamily = 'system';
  settings.subtitleFontFamily = subFamily;
  var subSizePx = parseInt(settings.subtitleFontSizePx, 10);
  if (isNaN(subSizePx)) {
    var legacy = String(settings.subtitleFontSize || '').trim().toLowerCase();
    if (legacy === 'md') subSizePx = 18;
    else if (legacy === 'xl') subSizePx = 26;
    else subSizePx = 22;
  }
  if (subSizePx < 12) subSizePx = 12;
  if (subSizePx > 72) subSizePx = 72;
  settings.subtitleFontSizePx = subSizePx;
  var subWeight = String(settings.subtitleFontWeight || '').trim().toLowerCase();
  if (['normal', 'medium', 'bold'].indexOf(subWeight) < 0) subWeight = 'medium';
  settings.subtitleFontWeight = subWeight;
  var subBg = String(settings.subtitleBgOpacity || '').trim().toLowerCase();
  if (['none', 'soft', 'medium', 'strong'].indexOf(subBg) < 0) subBg = 'none';
  settings.subtitleBgOpacity = subBg;
  var subColor = String(settings.subtitleColor || '').trim().toLowerCase();
  if (['white', 'yellow', 'cyan', 'green', 'orange', 'pink'].indexOf(subColor) < 0)
    subColor = 'white';
  settings.subtitleColor = subColor;
  if (settings.uiLocale !== 'en' && settings.uiLocale !== 'zh-CN') settings.uiLocale = 'zh-CN';
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

  var browseSortAllowed = ['date_taken', 'date_modified', 'file_name', 'file_size', 'folder_path'];
  if (browseSortAllowed.indexOf(settings.browseSortBy) < 0) settings.browseSortBy = 'date_taken';
  if (settings.browseSortOrder !== 'ASC' && settings.browseSortOrder !== 'DESC')
    settings.browseSortOrder = 'DESC';
  var bps = parseInt(settings.browsePageSize, 10);
  if ([50, 100, 200, 300, 500].indexOf(bps) < 0) settings.browsePageSize = 100;
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
  if (
    bcr !== '1 / 1' &&
    bcr !== '3 / 4' &&
    bcr !== '4 / 3' &&
    bcr !== '9 / 16' &&
    bcr !== '16 / 9'
  )
    bcr = '1 / 1';
  settings.browseCardRatio = bcr;
  settings.browseThumbCrop = !!settings.browseThumbCrop;
  var bcl = String(settings.browseCardLayout || '').trim().toLowerCase();
  if (bcl !== 'uniform' && bcl !== 'masonry') bcl = 'masonry';
  settings.browseCardLayout = bcl;
  settings.browseFolderIncludeSubfolders = settings.browseFolderIncludeSubfolders !== false;
  var launchDefaultPage = String(settings.launchDefaultPage || '').trim().toLowerCase();
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
  var scanDiskProfile = String(settings.scanDiskProfile || '').trim().toLowerCase();
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
  if (isNaN(tbc) || tbc < 1) tbc = 3;
  if (tbc > 8) tbc = 8;
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
    workerScanProgress = { current: 0, total: 0, status: 'scanning', currentFile: '' };
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
      var scanWorkerHeartbeatMs = 120000;
      if (silentMs > scanWorkerHeartbeatMs) {
        finish({
          cancelled: false,
          error:
            '扫描线程无响应（超过 ' +
            Math.round(silentMs / 1000) +
            ' 秒），已终止。请重试添加目录/重新扫描。',
        });
      }
    }, 5000);

    w.on('message', function (msg) {
      lastHeartbeatAt = Date.now();
      if (!msg || !msg.type) return;
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
      if (code !== 0 && !scanWorkerDoneReceived) {
        finish({
          cancelled: false,
          error: '扫描线程异常退出（代码 ' + code + '）',
        });
      }
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
    console.error('[settings] load failed, using defaults:', e && e.message ? e.message : e);
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
    console.error('[settings] reload from disk failed:', e && e.message ? e.message : e);
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
    console.error('[settings] save failed:', e && e.message ? e.message : e);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (e2) {}
  }
}

function clearPendingScanQueue() {
  if (scanQueue.length === 0) return;
  var pending = scanQueue.splice(0, scanQueue.length);
  for (var i = 0; i < pending.length; i++) {
    pending[i].resolve({ success: false, cancelled: true });
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
        }
      : null,
    pendingCount: scanQueue.length,
    pending: scanQueue.map(function (t) {
      return { id: t.id, source: t.source, rootPath: t.rootPath };
    }),
  };
}

function enqueueScanTask(task) {
  return new Promise(function (resolve) {
    scanQueue.push({
      id: scanTaskIdSeq++,
      source: task.source || 'manual',
      rootPath: task.rootPath,
      beforeScan: task.beforeScan || null,
      resolve: resolve,
    });
    processScanQueue();
  });
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
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('scan-start');
      }
      if (typeof task.beforeScan === 'function') {
        task.beforeScan();
      }
      var normalizedPath = task.rootPath.replace(/\//g, '\\');
      var wr = await runFolderScanInWorker(normalizedPath);
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
      task.resolve(resultPayload);
    } catch (err) {
      var errPayload = { success: false, error: err && err.message ? err.message : String(err) };
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('scan-complete', task.rootPath, errPayload);
      }
      task.resolve(errPayload);
    }
    currentScanTask = null;
  }
  isScanQueueProcessing = false;
  if (hasSuccessfulScan) {
    scheduleAutoThumbnailBackfill();
    scheduleAutoDuplicateHashDetection();
  }
}

function getThumbnailBackfillProgress() {
  var d = thumbnailBackfill.done;
  var tot = thumbnailBackfill.total;
  var exportable = thumbnailBackfill.running
    ? thumbnailBackfill.failedPaths.length
    : thumbnailBackfill.failedPathsLastRun.length;
  return {
    running: thumbnailBackfill.running,
    cancelled: thumbnailBackfill.cancelled,
    total: tot,
    done: d,
    success: thumbnailBackfill.success,
    failed: thumbnailBackfill.failed,
    currentFile: thumbnailBackfill.currentFile,
    etaSeconds: estimateEtaSecondsSmoothed('thumbBackfill', thumbnailBackfill.startedAt, d, tot),
    failedPathsExportable: exportable,
  };
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
 * 对一批待补全记录做有限并发处理（共享队列 + N 个 worker 协程）。
 */
async function runRowsWithThumbConcurrency(rows, yieldEvery) {
  var n = rows.length;
  if (n === 0) return;
  var conc = Math.min(getEffectiveThumbBackfillConcurrency(), n);
  var next = 0;

  async function processOne(row) {
    if (thumbnailBackfill.cancelled) return;
    thumbnailBackfill.currentFile = row.file_path || '';
    try {
      var topts = getThumbOptions();
      var thumb;
      if (isVideoPath(row.file_path)) {
        thumb = await extractVideoThumbnailWithFfmpeg(row.file_path, topts);
        if (!thumb) {
          thumb = await buildVideoPlaceholderThumbnail(topts);
        }
      } else {
        thumb = await loadSharp()(row.file_path)
          .rotate()
          .resize(topts.size, topts.size, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: topts.quality })
          .toBuffer();
      }
      db.updatePhotoThumbnail(row.id, thumb);
      thumbnailBackfill.success++;
    } catch (e) {
      thumbnailBackfill.failed++;
      if (thumbnailBackfill.failedPaths.length < THUMB_BACKFILL_FAILED_PATHS_MAX) {
        var fpe = row.file_path || '';
        if (fpe) thumbnailBackfill.failedPaths.push(fpe);
      }
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

async function runThumbnailBackfill(limit) {
  const taskStart = Date.now();
  console.log('[runThumbnailBackfill] task started, limit=', limit);
  if (thumbnailBackfill.running) {
    console.log('[runThumbnailBackfill] already running, exiting');
    return { started: false, reason: 'running' };
  }
  thumbnailBackfill.running = true;
  thumbnailBackfill.cancelled = false;
  thumbnailBackfill.done = 0;
  thumbnailBackfill.success = 0;
  thumbnailBackfill.failed = 0;
  thumbnailBackfill.currentFile = '';
  thumbnailBackfill.failedPaths = [];
  thumbnailBackfill.startedAt = Date.now();
  thumbnailBackfill.total = 0;  // 流式处理，初始不计数，避免长时阻塞
  emitBackgroundTasksChangedThrottled(true);
  console.log('[runThumbnailBackfill] state initialized');

  try {
    // 让出多次事件循环，让 UI 先更新状态再开始，避免启动就卡死
    console.log('[runThumbnailBackfill] yielding for UI update');
    const yieldStart = Date.now();
    await yieldForPreviewPlaybackMs(50);
    await yieldForPreviewPlaybackMs(50);
    console.log('[runThumbnailBackfill] yielded after', Date.now() - yieldStart, 'ms');

    var batchSize = 100;  // 更小批次，保证频繁让出
    var maxToProcess = typeof limit === 'number' && limit > 0 ? limit : null;

    var processedInThisRun = 0;
    var afterId = 0;
    var yieldEvery = 20;
    console.log('[runThumbnailBackfill] starting main loop (streaming mode, no pre-count), batchSize=', batchSize);

    while (true) {
      if (thumbnailBackfill.cancelled) {
        console.log('[runThumbnailBackfill] cancelled, exiting loop');
        break;
      }

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
      var rows = db.getPhotosMissingThumbnailsAfter(afterId, fetchLimit);
      const queryTime = Date.now() - queryStart;
      console.log('[runThumbnailBackfill] fetched', rows.length, 'rows after id', afterId, 'in', queryTime, 'ms');

      // 累积总数，UI 会看到总数逐步增加
      thumbnailBackfill.total += rows.length;

      // 查询完成后立即让出，让 UI 更新总数
      await yieldForPreviewPlaybackMs(10);
      emitBackgroundTasksChangedThrottled(true);
      await yieldForPreviewPlaybackMs(10);

      if (rows.length === 0) {
        console.log('[runThumbnailBackfill] no more rows, exiting loop');
        break;
      }

      if (thumbnailBackfill.cancelled) break;
      const batchStart = Date.now();
      await runRowsWithThumbConcurrency(rows, yieldEvery);
      console.log('[runThumbnailBackfill] processed batch of', rows.length, 'rows in', Date.now() - batchStart, 'ms');
      afterId = rows[rows.length - 1].id;
      processedInThisRun += rows.length;

      // 每批处理完多次让出，保证 UI 持续响应
      emitBackgroundTasksChangedThrottled(false);
      await yieldForPreviewPlaybackMs(20);
      await yieldForPreviewPlaybackMs(20);

      console.log('[runThumbnailBackfill] progress: processed', processedInThisRun, ', total estimated', thumbnailBackfill.total);

      if (maxToProcess != null && processedInThisRun >= maxToProcess) break;
    }

    const totalTime = Date.now() - taskStart;
    console.log('[runThumbnailBackfill] completed in', totalTime, 'ms, processed', processedInThisRun, 'total');
    return { started: true };
  } finally {
    thumbnailBackfill.failedPathsLastRun = thumbnailBackfill.failedPaths.slice(0, THUMB_BACKFILL_FAILED_PATHS_MAX);
    thumbnailBackfill.failedPaths = [];
    thumbnailBackfill.running = false;
    thumbnailBackfill.currentFile = '';
    thumbnailBackfill.startedAt = 0;
    emitBackgroundTasksChangedThrottled(true);
    console.log('[runThumbnailBackfill] task cleanup done');
  }
}

/** 大缓冲减少读系统调用；并发由 runDuplicateHashDetection 控制，避免机械盘一次性开太多流 */
var DUP_HASH_READ_BUFFER = 1024 * 1024;
/** 单文件哈希超时（毫秒），防止异常文件/设备导致任务长时间卡住不前 */
var DUP_HASH_FILE_TIMEOUT_MS = 90000;

function hashFileSha256(filePath, shouldCancel) {
  return new Promise(function (resolve, reject) {
    var crypto = require('crypto');
    var hash = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath, { highWaterMark: DUP_HASH_READ_BUFFER });
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try {
        stream.destroy(new Error('hash timeout'));
      } catch (e0) {
        void e0;
      }
      reject(new Error('hash timeout'));
    }, DUP_HASH_FILE_TIMEOUT_MS);
    function done(err, digest) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(digest);
    }
    stream.on('data', function (chunk) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        try {
          stream.destroy(new Error('hash cancelled'));
        } catch (eStop) {
          void eStop;
        }
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', function (err) {
      done(err);
    });
    stream.on('end', function () {
      done(null, hash.digest('hex'));
    });
  });
}

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

async function runDuplicateHashDetection() {
  if (duplicateHashTask.running) {
    return { started: false, reason: 'running' };
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
  emitBackgroundTasksChangedThrottled(true);
  try {
    /** 先让出主循环；待比对总数与收尾统计走只读 Worker，避免大库 COUNT/GROUP BY 占死主进程 */
    await new Promise(function (resolve) {
      setImmediate(resolve);
    });
    if (db && typeof db.ensureDuplicateHashSchema === 'function') {
      db.ensureDuplicateHashSchema();
    }
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

    var afterId = 0;
    duplicateHashTask.phase = 'hashing';
    duplicateHashBgLog('hashing.start', 'batchSize=2000 subChunk=24', true);
    var batchSize = 2000;
    /** 子批大小：控制「停止比对」后最多再算完多少张；并与并发路数相协调 */
    var subChunkSize = 24;
    var yieldEvery = 20;
    while (true) {
      if (duplicateHashTask.cancelled) break;
      await yieldForPreviewPlaybackMs(80);
      var rows = db.getHashAllPhotosAfter(afterId, batchSize);
      if (!rows || rows.length === 0) break;
      for (var sc = 0; sc < rows.length; sc += subChunkSize) {
        if (duplicateHashTask.cancelled) break;
        await yieldForPreviewPlaybackMs(20);
        var slice = rows.slice(sc, sc + subChunkSize);
        await processDupHashRowsChunk(slice, yieldEvery);
      }
      afterId = rows[rows.length - 1].id;
      duplicateHashBgLog('batch.done', 'afterId=' + String(afterId) + ' rows=' + String(rows.length), false);
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
      duplicateHashTask.duplicateGroups = await runDbReadWorkerOnly(readPathDup, 'getDuplicateGroupCountByHash', {
        minCount: 2,
      });
      duplicateHashTask.duplicatePhotos = await runDbReadWorkerOnly(readPathDup, 'getDuplicatePhotoCountByHash', {
        minCount: 2,
      });
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
          console.log(
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
    return { started: true };
  } catch (eRun) {
    duplicateHashBgLog('error', eRun && eRun.message ? eRun.message : String(eRun), true);
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
  if (isScanQueueProcessing || scanQueue.length > 0 || isFolderScanRunning()) return;
  if (thumbnailBackfill.running) return;
  await runThumbnailBackfill();
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
        console.error('[AUTO-THUMB-BACKFILL] failed:', e && e.message ? e.message : String(e));
      }
    }
  }, 300);
}

function scheduleAutoDuplicateHashDetection() {
  if (autoDuplicateHashScheduled) return;
  autoDuplicateHashScheduled = true;
  startupStageLog('auto-dup-hash.schedule', 'delay=700ms');
  if (autoDuplicateHashRetryTimer) {
    clearTimeout(autoDuplicateHashRetryTimer);
    autoDuplicateHashRetryTimer = null;
  }
  setTimeout(async function () {
    autoDuplicateHashScheduled = false;
    if (!settings.autoHashOnStartup) return;
    // 与扫描互斥，减少机械盘随机读写竞争
    if (isScanQueueProcessing || scanQueue.length > 0 || isFolderScanRunning()) {
      startupStageLog('auto-dup-hash.defer', 'scan busy, retry in 5000ms');
      autoDuplicateHashRetryTimer = setTimeout(function () {
        autoDuplicateHashRetryTimer = null;
        scheduleAutoDuplicateHashDetection();
      }, 5000);
      return;
    }
    if (duplicateHashTask.running) return;
    try {
      startupStageLog('auto-dup-hash.start');
      await runDuplicateHashDetection();
      startupStageLog('auto-dup-hash.done');
    } catch (e) {
      startupStageLog('auto-dup-hash.error', e && e.message ? e.message : String(e));
      if (isDev) {
        console.error('[AUTO-DUP-HASH] failed:', e && e.message ? e.message : String(e));
      }
    }
  }, 700);
}

function scheduleStartupInvalidCleanup() {
  if (startupInvalidCleanupTask.running) return;
  startupInvalidCleanupTask.running = true;
  startupInvalidCleanupTask.afterId = 0;
  startupStageLog('invalid-cleanup.schedule', 'startDelay=4500ms batch=400');
  /** 与 schedulePostWindowDeferredTasks 错开；小批量 + 间隔 + exists 让出，避免主进程假死 */
  var START_DELAY_MS = 4500;
  var STEP_DELAY_MS = 450;
  var RETRY_DELAY_MS = 5000;
  var BATCH_SIZE = 400;

  function finish() {
    startupStageLog('invalid-cleanup.finish', 'afterId=' + String(startupInvalidCleanupTask.afterId || 0));
    startupInvalidCleanupTask.running = false;
    if (startupInvalidCleanupTask.timer) {
      clearTimeout(startupInvalidCleanupTask.timer);
      startupInvalidCleanupTask.timer = null;
    }
  }

  function step() {
    if (!startupInvalidCleanupTask.running || !db) return finish();
    // 避让更重要任务，降低对交互和扫描的影响
    if (
      isFolderScanRunning() ||
      thumbnailBackfill.running ||
      duplicateHashTask.running ||
      previewPlaybackActive
    ) {
      startupStageLog('invalid-cleanup.defer', 'busy, retry in 5000ms');
      startupInvalidCleanupTask.timer = setTimeout(step, RETRY_DELAY_MS);
      return;
    }
    if (typeof db.cleanupMissingFilesYielding !== 'function') {
      finish();
      return;
    }
    db
      .cleanupMissingFilesYielding({
        batchSize: BATCH_SIZE,
        afterId: startupInvalidCleanupTask.afterId,
        existsSyncSlice: 64,
      })
      .then(function (r) {
        if (!startupInvalidCleanupTask.running || !db) return finish();
        startupInvalidCleanupTask.afterId =
          Number(r && r.lastId) > 0 ? Number(r.lastId) : startupInvalidCleanupTask.afterId;
        if (isDev && r && r.checked) {
          console.log(
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
        console.error('[startup] invalid-cleanup failed:', e && e.message ? e.message : String(e));
        finish();
      });
  }

  startupInvalidCleanupTask.timer = setTimeout(step, START_DELAY_MS);
}

/** 首屏 did-finish-load 后再跑：大 PRAGMA、孤儿行、抽样校验、分批无效文件清理 */
var postWindowDeferredTasksDone = false;
function schedulePostWindowDeferredTasks() {
  if (postWindowDeferredTasksDone) return;
  postWindowDeferredTasksDone = true;
  startupStageLog('post-window-deferred.schedule');
  setTimeout(function () {
    try {
      if (db && typeof db.applyDeferredCachePragma === 'function') {
        db.applyDeferredCachePragma();
        startupStageLog('post-window-deferred.cache-pragma.done');
      }
    } catch (eP) {
      console.error('[startup] deferred-cache-pragma failed:', eP && eP.message ? eP.message : String(eP));
    }
  }, 250);
  setTimeout(function () {
    try {
      if (db && typeof db.applyDeferredMmapPragma === 'function') {
        db.applyDeferredMmapPragma();
        startupStageLog('post-window-deferred.mmap-pragma.done');
      }
    } catch (eM) {
      console.error('[startup] deferred-mmap-pragma failed:', eM && eM.message ? eM.message : String(eM));
    }
  }, 2200);
  setTimeout(function () {
    scheduleStartupInvalidCleanup();
  }, 2200);
}

/** 自动扫描 / 补图 / 人脸等：等侧栏目录树首屏渲染完成后再启动，避免与目录 IPC 抢时序；12s 兜底仍可能触发 */
var autoStartupTasksRan = false;
var browseUiReadyStartupTimer = null;
var deferredPhotoIndexesScheduled = false;
var deferredPhotoIndexesTimer = null;
var deferredPhotoIndexesPhase = 0;

function scheduleDeferredPhotoIndexesOnce(reason) {
  if (deferredPhotoIndexesScheduled) return;
  deferredPhotoIndexesScheduled = true;
  var firstDelay = reason === 'browse-ui-ready' ? 8000 : 3000;
  startupStageLog('deferred-index.schedule', 'reason=' + String(reason || '') + ' firstDelay=' + firstDelay);
  function runNextPhase() {
    if (!db) return;
    try {
      if (deferredPhotoIndexesPhase === 0 && typeof db.ensurePhotosRootFolderCompositeIndex === 'function') {
        db.ensurePhotosRootFolderCompositeIndex();
        startupStageLog('deferred-index.phase0.done', 'ensurePhotosRootFolderCompositeIndex');
      } else if (deferredPhotoIndexesPhase === 1 && typeof db.ensurePhotosAggPartialIndexes === 'function') {
        db.ensurePhotosAggPartialIndexes();
        startupStageLog('deferred-index.phase1.done', 'ensurePhotosAggPartialIndexes');
      } else if (deferredPhotoIndexesPhase === 2 && typeof db.ensurePhotosDupHashPendingIndex === 'function') {
        db.ensurePhotosDupHashPendingIndex();
        startupStageLog('deferred-index.phase2.done', 'ensurePhotosDupHashPendingIndex');
      } else {
        return;
      }
      deferredPhotoIndexesPhase++;
      if (deferredPhotoIndexesPhase < 3) {
        deferredPhotoIndexesTimer = setTimeout(runNextPhase, 1200);
      }
    } catch (eIdx) {
      console.error(
        '[startup] deferred-photo-indexes (phase-%d) failed: %s',
        deferredPhotoIndexesPhase,
        eIdx && eIdx.message ? eIdx.message : String(eIdx),
      );
    }
  }
  deferredPhotoIndexesTimer = setTimeout(runNextPhase, firstDelay);
}

function runAutoStartupTasksOnce() {
  if (autoStartupTasksRan) return;
  autoStartupTasksRan = true;
  startupStageLog('auto-startup.run');
  reloadSettingsFromDiskSilently();
  if (settings.autoScanOnStartup) {
    startupStageLog('auto-startup.auto-scan.enabled');
    /** 根目录列表仅走只读 Worker（lite），不在主进程同步查库（仅用模块级 sqliteDbPath，dbPath 不在此作用域） */
    var readPathAuto = sqliteDbPath;
    if (readPathAuto) {
      runDbReadWorkerOnly(readPathAuto, 'getRootFolders', { lite: true })
        .then(function (roots) {
          if (!roots || !roots.length) return;
          startupStageLog('auto-startup.auto-scan.enqueue', 'roots=' + String(roots.length));
          for (var i = 0; i < roots.length; i++) {
            enqueueScanTask({ rootPath: roots[i].path, source: 'auto' }).then(function (result) {
              if (!result.success && !result.cancelled) {
                console.error('Auto scan failed:', result.error || 'unknown error');
              }
            });
          }
        })
        .catch(function (eAuto) {
          console.error(
            '[auto-scan-on-startup] getRootFolders worker failed:',
            eAuto && eAuto.message ? eAuto.message : eAuto,
          );
        });
    } else {
      console.warn('[auto-scan-on-startup] no db path, skipped');
    }
  }
  if (settings.autoHashOnStartup) {
    scheduleAutoDuplicateHashDetection();
  }
  if (settings.autoThumbBackfillOnStartup) {
    scheduleAutoThumbnailBackfill();
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
  if (appIcon && !appIcon.isEmpty()) {
    winOpts.icon = appIcon;
  }
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.webContents.on('render-process-gone', function (event, details) {
    var d = details || {};
    console.error(
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
      buttons: en
        ? ['Run in background', 'Quit', 'Cancel']
        : ['后台运行', '退出程序', '取消'],
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

app
  .whenReady()
  .then(function () {
    startupStageLog('app.whenReady');
    var userDataPath = app.getPath('userData');
    var dbPath = path.join(userDataPath, 'photos.db');
    var catalogCachePath = path.join(userDataPath, 'catalog-cache.db');
    sqliteDbPath = dbPath;
    settingsFilePath = path.join(userDataPath, 'settings.json');
    if (isDev) {
      var dbExists = false;
      var dbSize = 0;
      try {
        var st = fs.statSync(dbPath);
        dbExists = true;
        dbSize = Number(st && st.size) || 0;
      } catch (e0) {}
      console.log('[startup] db path=%s exists=%s size=%d', dbPath, dbExists ? 'yes' : 'no', dbSize);
    }
    db = new Database(dbPath);
    try {
      catalogCache = new CatalogCacheDb(catalogCachePath);
      catalogCache.gcExpired(Date.now());
    } catch (eCat) {
      catalogCache = null;
      console.warn('[startup] catalog cache init failed:', eCat && eCat.message ? eCat.message : String(eCat));
    }
    if (isDev && db && typeof db.getStartupDiagnostics === 'function') {
      try {
        var d = db.getStartupDiagnostics();
        console.log(
          '[startup] db schema root_folders=%s photos=%s roots=%d photos=%d',
          d && d.hasRootFolders ? 'ok' : 'missing',
          d && d.hasPhotos ? 'ok' : 'missing',
          Number(d && d.rootCount) || 0,
          Number(d && d.photoCount) || 0,
        );
      } catch (e1) {
        console.warn('[startup] db diagnostics failed:', e1 && e1.message ? e1.message : String(e1));
      }
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
            db.updatePhotoThumbnail(photoId, vbuf);
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
            var rawJpeg = await loadSharp()(photo.file_path).rotate().jpeg({ quality: 88 }).toBuffer();
            return new Response(rawJpeg, {
              headers: { 'Content-Type': 'image/jpeg' },
            });
          }
          var data = fs.readFileSync(photo.file_path);
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
    protocol.handle('video', async function (request) {
      var url = new URL(request.url);
      var photoId = parseInt(url.hostname, 10);
      var photo = db.getFullPhoto(photoId);
      if (!photo || !photo.file_path) {
        return new Response('Not Found', { status: 404 });
      }
      var fp = photo.file_path;
      if (!fp || !fs.existsSync(fp)) {
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

      // 解析 Range: bytes=start-end
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        var m = range.match(/^bytes=(\d*)-(\d*)$/);
        var start = m && m[1] ? parseInt(m[1], 10) : 0;
        var end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end < 0) end = size - 1;
        if (start > end || start >= size) {
          return new Response(null, {
            status: 416,
            headers: {
              'Content-Range': 'bytes */' + size,
            },
          });
        }
        if (end >= size) end = size - 1;

        var chunkSize = end - start + 1;
        var rs = fs.createReadStream(fp, { start: start, end: end });
        var body = Readable.toWeb(rs);
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
            'Content-Length': String(chunkSize),
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }

      var rs2 = fs.createReadStream(fp);
      var body2 = Readable.toWeb(rs2);
      return new Response(body2, {
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
          getBrowseFolderIncludeSubfolders: function () {
            reloadSettingsFromDiskSilently();
            return settings.browseFolderIncludeSubfolders !== false;
          },
        });
        webServer.setPassword(settings.webPassword || '');
        webServer
          .start()
          .then(function (port) {
            var localIP = webServer.getLocalIP();
            var webUrl = 'http://' + localIP + ':' + port;
            console.log('Web server running at: ' + webUrl);
            startupStageLog('embedded-web-server.ready', webUrl);
            webServerReadyResolve(webUrl);
          })
          .catch(function (err) {
            console.error('Failed to start web server:', err.message);
            webServerReadyResolve('');
          });
      } catch (e) {
        console.error('Failed to create web server:', e && e.message ? e.message : String(e));
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
      scheduleDeferredPhotoIndexesOnce('fallback');
      runAutoStartupTasksOnce();
      startEmbeddedWebServer();
    }, 12000);
    // Tunnel 默认不自动开启：仅在用户手动打开开关时启动
    tunnelTask.enabled = false;

    // === IPC Handlers ===

    ipcMain.on('notify-browse-ui-ready', function () {
      startupStageLog('ipc.notify-browse-ui-ready');
      if (browseUiReadyStartupTimer) {
        clearTimeout(browseUiReadyStartupTimer);
        browseUiReadyStartupTimer = null;
      }
      /** 首屏目录渲染后再延迟启动自动任务，避免与 get-root-folders/get-folder-tree 抢 Worker 与磁盘 IO */
      browseUiReadyStartupTimer = setTimeout(function () {
        browseUiReadyStartupTimer = null;
        startupStageLog('auto-startup.timer.fire', 'after notify-browse-ui-ready');
        runAutoStartupTasksOnce();
      }, 3500);
      scheduleDeferredPhotoIndexesOnce('browse-ui-ready');
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
      console.log('[start-thumbnail-backfill] IPC received, limit=', limit);
      if (isFolderScanRunning()) {
        console.log('[start-thumbnail-backfill] rejected: scan running');
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (thumbnailBackfill.running) {
        console.log('[start-thumbnail-backfill] rejected: already running');
        return { success: false, error: '补全已在进行中' };
      }
      // 立即返回，任务在后台异步运行，不要阻塞 IPC 响应
      setTimeout(() => {
        console.log('[start-thumbnail-backfill] starting background task after IPC return');
        runThumbnailBackfill(limit).catch(err => {
          console.error('[start-thumbnail-backfill] task error:', err);
          thumbnailBackfill.running = false;
        });
      }, 0);
      const elapsed = Date.now() - startTime;
      console.log('[start-thumbnail-backfill] IPC done in', elapsed, 'ms, returning success');
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
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (invalidCleanupTask.running) {
        return { success: false, error: '清理任务已在运行' };
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
        (async function() {
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
            var afterId = 0;
            var chunks = 0;
            var MAX_CHUNKS = 100000;
            while (chunks < MAX_CHUNKS && invalidCleanupTask.running && !invalidCleanupTask.cancelled) {
              var r = await db.cleanupMissingFilesYielding({
                batchSize: 1200,
                afterId: afterId,
                existsSyncSlice: 64,
              });
              chunks++;
              totalChecked += Number(r && r.checked) || 0;
              totalDeleted += Number(r && r.deleted) || 0;
              afterId = Number(r && r.lastId) > 0 ? Number(r.lastId) : afterId;
              invalidCleanupTask.checked = totalChecked;
              invalidCleanupTask.deleted = totalDeleted;
              invalidCleanupTask.currentFile = afterId > 0 ? '已检查到记录 ID ' + afterId : '';
              emitBackgroundTasksChangedThrottled(false);
              if (!r || !r.hasMore || !r.checked) break;
              // 短暂让出避免阻塞
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          } catch (err) {
            console.error('Cleanup missing files error:', err);
          } finally {
            invalidCleanupTask.running = false;
            invalidCleanupTask.currentFile = '';
            invalidCleanupTask.startedAt = 0;
            emitBackgroundTasksChangedThrottled(true);
          }
        })();
      }, 0);

      return { success: true };
    });

    ipcMain.handle('maintenance-rebuild-thumbnail-flags', async function () {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (optimizeTaskRunning) {
        return { success: false, error: '另一项维护任务正在运行，请稍后再试' };
      }
      optimizeTaskRunning = true;
      emitBackgroundTasksChangedThrottled(true);

      // 大库全表更新可能耗时较长，后台异步执行
      setTimeout(() => {
        try {
          var result = db.rebuildThumbnailFlags();
          console.log('Rebuild thumbnail flags done:', result);
        } catch (err) {
          console.error('Rebuild thumbnail flags error:', err);
        } finally {
          optimizeTaskRunning = false;
          emitBackgroundTasksChangedThrottled(true);
        }
      }, 0);

      return { success: true };
    });

    ipcMain.handle('maintenance-optimize-database', function () {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (optimizeTaskRunning) {
        return { success: false, error: '优化已在进行中' };
      }
      optimizeTaskRunning = true;
      emitBackgroundTasksChangedThrottled(true);

      // 大数据库 VACUUM 可能耗时很长，后台异步执行避免卡住界面
      setTimeout(() => {
        try {
          db.optimizeDatabase();
        } catch (err) {
          console.error('Optimize database error:', err);
        } finally {
          optimizeTaskRunning = false;
          emitBackgroundTasksChangedThrottled(true);
        }
      }, 0);

      return { success: true };
    });

    ipcMain.handle('maintenance-start-duplicate-hash-detection', async function () {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (duplicateHashTask.running) {
        return { success: false, error: '重复哈希任务已在运行' };
      }
      /** 勿 await 整段 runDuplicateHashDetection：大库可能跑数小时，invoke 会一直挂起，设置页「开始获取」像无响应 */
      void runDuplicateHashDetection().catch(function (err) {
        console.error('[duplicate-hash]', err);
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
          console.log(
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
        console.log(
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
        console.log(
          '[dup-groups] response groups=%d total=%d totalPages=%d elapsed=%dms',
          Array.isArray(result && result.groups) ? result.groups.length : 0,
          Number(result && result.total) || 0,
          Number(result && result.totalPages) || 0,
          Date.now() - startedAt,
        );
      }
      if (minCount === duplicateHashGroupsCache.minCount && pageSize === duplicateHashGroupsCache.pageSize) {
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
        optimizing: optimizeTaskRunning,
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

    ipcMain.handle('export-root-folders-json', async function () {
      if (!mainWindow) {
        return { success: false, error: '窗口未就绪' };
      }
      try {
        var readPathExport = sqliteDbPath || dbPath;
        if (!readPathExport) {
          return { success: false, error: '数据库路径不可用' };
        }
        var rows = await runDbReadWorkerOnly(readPathExport, 'getRootFolders', { lite: true });
        var list = [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].path) list.push(rows[i].path);
        }
        var payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          roots: list,
        };
        var saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '导出目录列表',
          defaultPath: path.join(app.getPath('documents'), 'AuroraGallery-folders.json'),
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { success: false, cancelled: true };
        }
        fs.writeFileSync(saveResult.filePath, JSON.stringify(payload, null, 2), 'utf8');
        return { success: true, path: saveResult.filePath, count: list.length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('import-root-folders-json', async function () {
      if (isFolderScanRunning()) {
        return { success: false, error: '扫描进行中，请稍后再试' };
      }
      if (!mainWindow) {
        return { success: false, error: '窗口未就绪' };
      }
      try {
        var openResult = await dialog.showOpenDialog(mainWindow, {
          title: '导入目录列表',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (openResult.canceled || !openResult.filePaths || !openResult.filePaths[0]) {
          return { success: false, cancelled: true };
        }
        var raw = fs.readFileSync(openResult.filePaths[0], 'utf8');
        var data = JSON.parse(raw);
        var paths = [];
        if (data && Array.isArray(data.roots)) {
          paths = data.roots;
        } else if (Array.isArray(data)) {
          paths = data;
        }
        var added = 0;
        var skippedMissing = 0;
        for (var j = 0; j < paths.length; j++) {
          var p = String(paths[j] || '').trim();
          if (!p) continue;
          var norm = p.replace(/\//g, '\\');
          if (!fs.existsSync(norm)) {
            skippedMissing++;
            continue;
          }
          db.addRootFolder(norm);
          added++;
          enqueueScanTask({ rootPath: norm, source: 'import' });
        }
        if (added > 0) {
          // 新增根目录会影响根列表缓存；先按全量兜底失效。
          invalidateCatalogCacheForRootSafe(null);
        }
        return {
          success: true,
          added: added,
          skippedMissing: skippedMissing,
          totalInFile: paths.length,
        };
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
        var rootIdOfPhoto = photo && photo.root_id != null ? parseInt(photo.root_id, 10) || null : null;
        var fp = photo.file_path;
        if (fs.existsSync(fp)) {
          await shellTrashItemWithFallback(fp);
        }
        try {
          var fsrv = getFaceService();
          if (fsrv) {
            var vids = db.getVectorIdsForPhoto(id);
            var vi;
            for (vi = 0; vi < vids.length; vi++) {
              fsrv.index.removeByLabel(vids[vi]);
            }
          }
        } catch (eFace) {
          void eFace;
        }
        db.deletePhotoById(id);
        clearDuplicateHashGroupsCache('photo-move-to-trash');
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
        try {
          var fsrv = getFaceService();
          if (fsrv) {
            var vids = db.getVectorIdsForPhoto(id);
            var vi;
            for (vi = 0; vi < vids.length; vi++) {
              fsrv.index.removeByLabel(vids[vi]);
            }
          }
        } catch (eFace) {
          void eFace;
        }
        db.deletePhotoById(id);
        clearDuplicateHashGroupsCache('photo-delete-record');
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
        /** 只读大查询固定 Worker（池 + oneshot），主进程不写 sync 聚合 */
        var readPath = sqliteDbPath || dbPath;
        if (!readPath) {
          throw new Error('get-root-folders: database path unavailable');
        }
        var mediaKey = normalizeMediaKey(options || {});
        if (options.lite !== true && catalogCache && typeof catalogCache.getRootFolders === 'function') {
          var cachedRows = catalogCache.getRootFolders(options);
          if (Array.isArray(cachedRows) && cachedRows.length > 0) {
            if (isDev) {
              console.log(
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
          console.log(
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
          console.error(
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
      return await runDbReadWorkerOnly(readPath, 'getFolderCovers', opts);
    });

    ipcMain.handle('get-immediate-subfolder-covers', function (event, parentPath, childPaths, options) {
      return db.getImmediateSubfolderCovers(parentPath, childPaths, options || {});
    });

    ipcMain.handle('get-photos', function (event, options) {
      return db.getPhotos(options);
    });

    ipcMain.handle('get-folder-photos', function (event, folderPath, options) {
      reloadSettingsFromDiskSilently();
      var opts = Object.assign({}, options || {});
      if (opts.includeSubfolders === undefined) {
        opts.includeSubfolders = settings.browseFolderIncludeSubfolders !== false;
      }
      return db.getFolderPhotos(folderPath, opts);
    });

    ipcMain.handle('get-date-groups', async function (event, options) {
      try {
        return await runDbReadWorkerOnly(sqliteDbPath, 'getDateGroups', options || {});
      } catch (e) {
        console.error('get-date-groups worker failed:', e && e.message ? e.message : e);
        throw new Error('get-date-groups failed: db_read_unavailable');
      }
    });

    ipcMain.handle('get-date-photos', async function (event, dateStr, options) {
      try {
        var op = Object.assign({}, options || {}, { dateStr: dateStr });
        return await runDbReadWorkerOnly(sqliteDbPath, 'getDatePhotos', op);
      } catch (e) {
        console.error('get-date-photos worker failed:', e && e.message ? e.message : e);
        throw new Error('get-date-photos failed: db_read_unavailable');
      }
    });

    ipcMain.handle('get-full-photo', function (event, photoId) {
      return db.getFullPhoto(photoId);
    });

    ipcMain.handle('search-photos', function (event, query, options) {
      return db.searchPhotos(query, options);
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

    // 菜单：添加文件夹
    ipcMain.on('menu-add-folder', async function () {
      var result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择照片文件夹',
      });
      if (!result.canceled && result.filePaths.length > 0) {
        mainWindow.webContents.send('trigger-scan', result.filePaths[0]);
      }
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

    // 扫描完成通知
    ipcMain.on('scan-complete', function () {});
    ipcMain.on('trigger-scan', function () {}); // 避免未注册 warning

    app.on('before-quit', function () {
      isQuitting = true;
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
    console.error('[startup] fatal initialization error:', msg);
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
