const logger = require('./logger');
const fs = require('fs');

/** 外观风格 id → 渲染层 data-theme / data-accent / data-bg（与 renderer UI_THEME_PRESETS 一致） */
const THEME_STYLE_PRESETS = {
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
function reconcileThemeStyleSettings(settings) {
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
    thumbBackfillConcurrency: 1,
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
    /** 开机自动启动应用 */
    startOnBoot: false,
    /** 静默启动 - 启动时不打开主窗口，仅驻留系统托盘 */
    silentStart: false,
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

function ensureSettingsShape(settings) {
  reconcileThemeStyleSettings(settings);
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
  settings.startOnBoot = !!settings.startOnBoot;
  settings.silentStart = !!settings.silentStart;
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
  if (isNaN(tbc) || tbc < 1) tbc = 3;
  if (tbc > 8) tbc = 8;
  settings.thumbBackfillConcurrency = tbc;
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

function getScanOptions(settings) {
  ensureSettingsShape(settings);
  return {
    followSymlinks: !!settings.scanFollowSymlinks,
    maxDepth: settings.scanMaxDepth || 0,
    skipDirNameSet: parseScanSkipDirNamesToSet(settings.scanSkipDirNames),
    includeRaw: settings.scanIncludeRaw !== false,
    diskProfile: settings.scanDiskProfile || 'auto',
    ioThrottleMs: parseInt(settings.scanIoThrottleMs, 10) || 0,
  };
}

function getThumbOptions(settings) {
  ensureSettingsShape(settings);
  return {
    size: parseInt(settings.thumbSize, 10) || 256,
    quality: parseInt(settings.thumbQuality, 10) || 75,
  };
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
      var p = require('path').join(
        hlsRootDir,
        '.hls-write-test-' + Date.now() + '-' + process.pid + '.tmp',
      );
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

/** 供 IPC 返回，避免渲染进程持有主进程对象引用、并保证可结构化克隆 */
function cloneSettingsForIpc(settings) {
  ensureSettingsShape(settings);
  var payload = JSON.parse(JSON.stringify(settings));
  payload.hasWebPassword = !!(settings.webPassword && String(settings.webPassword).trim());
  return payload;
}

function loadSettings(settingsFilePath, settings) {
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
    saveSettings(settingsFilePath, settings);
  }
  ensureSettingsShape(settings);
  return settings;
}

/**
 * 每次 IPC 拉配置前从 settings.json 同步到内存，避免磁盘已更新（或外部修改）而主进程仍持旧对象，导致前端永远看到默认项。
 */
function reloadSettingsFromDiskSilently(settingsFilePath, settings) {
  if (!settingsFilePath) return settings;
  try {
    if (!fs.existsSync(settingsFilePath)) return settings;
    var data = fs.readFileSync(settingsFilePath, 'utf8');
    var parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return settings;
    settings = Object.assign(createDefaultSettings(), parsed);
    ensureSettingsShape(settings);
  } catch (e) {
    logger.error('[settings] reload from disk failed:', e && e.message ? e.message : e);
  }
  return settings;
}

function saveSettings(settingsFilePath, settings) {
  var tmpPath = settingsFilePath + '.tmp';
  try {
    ensureSettingsShape(settings);
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

function serializeScanOptionsForWorker(settings) {
  var so = getScanOptions(settings);
  return {
    followSymlinks: !!so.followSymlinks,
    maxDepth: so.maxDepth || 0,
    includeRaw: so.includeRaw !== false,
    skipDirNames: so.skipDirNameSet ? Array.from(so.skipDirNameSet) : [],
    diskProfile: so.diskProfile || 'auto',
    ioThrottleMs: parseInt(so.ioThrottleMs, 10) || 0,
  };
}

module.exports = {
  THEME_STYLE_PRESETS,
  createDefaultSettings,
  ensureSettingsShape,
  reconcileThemeStyleSettings,
  loadSettings,
  saveSettings,
  reloadSettingsFromDiskSilently,
  cloneSettingsForIpc,
  getScanOptions,
  getThumbOptions,
  validateHlsRuntime,
  parseScanSkipDirNamesToSet,
  serializeScanOptionsForWorker,
};
