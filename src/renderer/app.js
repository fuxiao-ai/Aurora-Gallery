/** 网格卡片档位：与右下角 zoomLabel、设置页下拉一致（basis 写入 browseCardSize） */
var RendererUtils = window.RendererUtils || {};
var api = window.RendererApi || null;
var sidebarUi = window.RendererSidebarUI || {};
var sidebarTree = window.RendererSidebarTree || {};
var sidebarResizer = window.RendererSidebarResizer || {};
var dialogUi = window.RendererDialogUI || {};
var taskPanelUi = window.RendererTaskPanelUI || {};
var webAccessUi = window.RendererWebAccessUI || {};
var closeChoiceUi = window.RendererCloseChoiceUI || {};
var menuActions = window.RendererMenuActions || {};
var appearanceUi = window.RendererAppearanceUI || {};
var bgTasksOrchestrator = window.RendererBackgroundTasksOrchestrator || {};
var tabsUi = window.RendererTabsUI || {};
var tabsFlowUi = window.RendererTabsFlowUI || {};
var settingsFlow = window.RendererSettingsFlow || {};
var settingsSync = window.RendererSettingsSync || {};
var scanFlow = window.RendererScanFlow || {};
var previewFlow = window.RendererPreviewFlow || {};
var previewInteraction = window.RendererPreviewInteraction || {};
var previewSlideshow = window.RendererPreviewSlideshow || {};
var previewFavoriteUi = window.RendererPreviewFavoriteUI || {};
var photoGridUi = window.RendererPhotoGridUI || {};
var folderCoverUi = window.RendererFolderCoverUI || {};
var duplicatesUi = window.RendererDuplicatesUI || {};
var settingsUi = window.RendererSettingsUI || {};
var thumbSettingsUi = window.RendererThumbSettingsUI || {};
var maintenanceUi = window.RendererMaintenanceUI || {};
var duplicatesFlow = window.RendererDuplicatesFlow || {};
var uiEvents = window.RendererUIEvents || {};
// 搜图 / 人物视图到主照片网格的适配层，挂载点在文件末尾（init 前保持 null，
// 早期调用 showTabContent('folders') 时不会碰到它）。
var aiViews = null;
var CARD_SIZE_TIERS = RendererUtils.CARD_SIZE_TIERS || [
  { label: 'S', basis: 100 },
  { label: 'M', basis: 140 },
  { label: 'L', basis: 180 },
  { label: 'XL', basis: 320 },
];
var snapBrowseCardBasis =
  RendererUtils.snapBrowseCardBasis ||
  function (n) {
    var x = parseInt(n, 10);
    if (isNaN(x)) x = 180;
    x = Math.max(80, Math.min(400, x));
    var best = CARD_SIZE_TIERS[2].basis;
    var bestD = Infinity;
    for (var i = 0; i < CARD_SIZE_TIERS.length; i++) {
      var d = Math.abs(x - CARD_SIZE_TIERS[i].basis);
      if (d < bestD) {
        bestD = d;
        best = CARD_SIZE_TIERS[i].basis;
      }
    }
    return best;
  };
var browseCardTierIndexForBasis =
  RendererUtils.browseCardTierIndexForBasis ||
  function (basis) {
    var b = snapBrowseCardBasis(basis);
    for (var j = 0; j < CARD_SIZE_TIERS.length; j++) {
      if (CARD_SIZE_TIERS[j].basis === b) return j;
    }
    return 2;
  };
/** 每页张数档位与收档：底栏「每页数量」控件按它逐档走，与主进程校验同一套值 */
var BROWSE_PAGE_SIZE_TIERS = RendererUtils.BROWSE_PAGE_SIZE_TIERS || [10, 20, 50, 80, 100, 200];
var snapBrowsePageSize =
  RendererUtils.snapBrowsePageSize ||
  function (n) {
    var x = parseInt(n, 10);
    if (!isFinite(x)) return 100;
    var best = BROWSE_PAGE_SIZE_TIERS[0];
    var bestD = Infinity;
    for (var i = 0; i < BROWSE_PAGE_SIZE_TIERS.length; i++) {
      var d = Math.abs(x - BROWSE_PAGE_SIZE_TIERS[i]);
      if (d < bestD) {
        bestD = d;
        best = BROWSE_PAGE_SIZE_TIERS[i];
      }
    }
    return best;
  };
var browsePageSizeTierIndex =
  RendererUtils.browsePageSizeTierIndex ||
  function (size) {
    var b = snapBrowsePageSize(size);
    for (var j = 0; j < BROWSE_PAGE_SIZE_TIERS.length; j++) {
      if (BROWSE_PAGE_SIZE_TIERS[j] === b) return j;
    }
    return BROWSE_PAGE_SIZE_TIERS.indexOf(100);
  };
function normalizeBrowseCardRatio(v) {
  var s = String(v || '').trim();
  if (s === '1 / 1' || s === '3 / 4' || s === '4 / 3' || s === '9 / 16' || s === '16 / 9') return s;
  return '1 / 1';
}
function normalizeBrowseThumbCrop(v) {
  if (v === true || v === 1 || v === '1') return true;
  return false;
}
function normalizeBrowseCardLayout(v) {
  var s = String(v || '')
    .trim()
    .toLowerCase();
  return s === 'uniform' ? 'uniform' : 'masonry';
}
function normalizeLaunchDefaultPage(v) {
  var s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'welcome' || s === 'all_photos' || s === 'all_folders' || s === 'last_position')
    return s;
  return 'all_photos';
}
var STARTUP_POSITION_KEY = 'photoManager.startup.lastPosition.v1';

window.PhotoHlsConfig = {
  onSessionEnd: function (sessionId) {
    if (!api || !api.has || !api.has('hlsStopSession')) return;
    api.call('hlsStopSession', sessionId).catch(function () {});
  },
};

// === State ===
var state = {
  currentTab: 'folders',
  currentView: 'all',
  currentPath: '',
  currentDate: '',
  searchQuery: '',
  /** 搜图视图当前查询词（与文件名检索的 searchQuery 分开，两者是不同视图） */
  aiSearchQuery: '',
  /** 人物视图工具栏面包屑：详情态是「姓名 #id」，分组态是「全部人物」 */
  aiPeopleLabel: '',
  sortBy: 'date_taken',
  sortOrder: 'DESC',
  mediaFilter: 'all', // all | image | video
  page: 1,
  pageSize: 100, // 仅取 BROWSE_PAGE_SIZE_TIERS 中的值，与设置 browsePageSize 同步
  cardSize: 180, // 网格卡片基准（仅取 CARD_SIZE_TIERS 中的值，与 S/M/L/XL 对应）
  cardRatio: '1 / 1',
  thumbCrop: false,
  cardLayoutMode: 'masonry', // uniform | masonry
  /** 与设置 browseFolderIncludeSubfolders 同步：目录视图是否包含子文件夹中的媒体 */
  browseFolderIncludeSubfolders: true,
  /** 与设置 videoClickBehavior 同步：system 系统播放器 | embedded 内嵌预览 */
  videoClickBehavior: 'system',
  /** 与设置 similarThreshold 同步：视觉相似汉明距离阈值（0-64，默认 12） */
  similarThreshold: 12,
  /** loadRootFolders 预取的各 root 下 folder_path 列表（用于主区展示直接子目录） */
  _folderTreeByRootId: null,
  currentPhotos: [],
  photosLoadSeq: 0,
  previewIndex: -1,
  previewPhotos: [],
  previewTotalPhotos: 0,
  previewTotalPages: 0,
  previewLoadingPage: 0, // 0=不加载
  previewPageStart: 1, // previewPhotos 中第一张照片对应的页码
  rootFolders: [],
  /** 当前 rootFolders 是否仅为 lite 列表（统计尚在后端计算） */
  rootFoldersStatsPending: false,
  /** 管理页内是否发生了需整页重载的操作（增删目录、重扫、导入目录等）；为 false 时返回相册可走软恢复 */
  mustReloadBrowseAfterSettings: false,
  webUrl: '',
  isScanning: false,
  isScanPaused: false,
  hasWebPassword: false,
  // 缩放/拖拽状态
  zoom: 1,
  panX: 0,
  panY: 0,
  /** 预览内顺时针旋转（仅显示，不写文件） */
  previewRotateDeg: 0,
  isDragging: false,
  hasDragged: false,
  dragStartX: 0,
  dragStartY: 0,
  dragStartPanX: 0,
  dragStartPanY: 0,
  // 移动端状态
  isMobile: window.innerWidth <= 600,
  // 触摸手势状态
  touchStartX: 0,
  touchStartY: 0,
  touchStartTime: 0,
  touchStartDist: 0,
  touchStartZoom: 1,
  isSwiping: false,
  swipeDirection: null,
  scanLiveRefreshTimer: null,
  scanLiveRefreshRunning: false,
  slideshowPlaying: false,
  slideshowIntervalSec: 3,
  slideshowTimer: null,
  slideshowRandom: false,
  /** 与主库随机序一致，用于全库/当前视图随机幻灯 */
  slideshowRandomSeed: 0,
  /** 随机模式下信息条中的序号（1..previewTotalPhotos），每次换片重新抽取 */
  previewRandomPositionNum: 0,
  slideshowRandomPool: [],
  /** 侧栏日期列表：desc=新→旧，asc=旧→新 */
  dateGroupsSortOrder: 'desc',
  previewSubtitleEnabled: true,
  previewSubtitleMode: 'external_auto',
  previewSubtitlePreferredLang: '',
  previewSubtitlePreferredLabel: '',
  previewEmbeddedSubtitleStreams: [],
  thumbBackfillPolling: null,
  duplicateHashPolling: null,
  bgTaskTimer: null,
  bgTaskPollingStarted: false,
  bgTaskHasActive: false,
  // 管理页目录兜底重试（仅在管理页打开期间短时触发）
  settingsHydrateTimer: null,
  /** 管理页目录列表 2.2s 兜底轮询（仅管理页可见时注册，关闭页时清除） */
  settingsFolderListPollTimer: null,
  /** 管理页目录表上次渲染指纹，避免数据未变时整表重建 */
  _settingsFolderListFp: null,
  stats: {},
  /** 已写入配置的缩略图参数 */
  thumbAppliedSize: null,
  thumbAppliedQuality: null,
  /** 已写入主进程的关闭主窗口行为（与 #settingWindowClose 同步） */
  windowCloseBehaviorApplied: null,
  /** 已保存的浏览偏好快照 */
  browsePrefsApplied: null,
  generalSettingsApplied: null,
  duplicateGroups: [],
  duplicateGroupsPage: 1,
  duplicateGroupsTotalPages: 1,
  duplicateGroupsLoading: false,
  duplicateHasScanned: false,
  duplicateDetectionMode: 'hash', // 'hash' = SHA-256 精确, 'similar' = dHash 视觉相似
  currentDuplicateHash: '',
  duplicateExpanded: {},
  duplicatePhotosByHash: {},
  sidebarViewToken: 0,
  sidebarRequestSeq: 0,
  sidebarLatestRequests: {},
  sidebarLockedMode: '',
  /**
   * 「文件(目录)」与「日期」浏览缓存分栏存储，失效时可只清一侧。
   * folders.tabMemory：目录 Tab 的路径/分页/排序/滚动等
   * dates.tabMemory：日期 Tab 同上
   * dates.dateGroupsList*：日期侧栏 getDateGroups 结果缓存
   */
  browseCaches: {
    folders: { tabMemory: null, sidebarSnapshot: null },
    dates: {
      tabMemory: null,
      dateGroupsList: null,
      dateGroupsListSort: null,
      dateGroupsCacheFavAt: null,
    },
  },
  _pendingBrowseScrollTop: null,
  /** 与 _photoBrowseCacheResult 对应的列表查询指纹（目录/日期返回时优先秒开网格） */
  _photoBrowseCacheFp: null,
  _photoBrowseCacheResult: null,
  /** 重复项列表缓存世代：invalidate 时 +1，与 _dupListLoadedGen 一致时才允许 warm 路径 */
  _dupListGen: 0,
  _dupListLoadedGen: 0,
  /** 重复哈希检测进度轮询：用于检测「运行中→结束」以失效缓存 */
  _dupHashProgressRunning: false,
};

var BG_TASK_POLL_ACTIVE_MS = 600;
var BG_TASK_POLL_IDLE_MS = 2200;
var BG_TASK_POLL_RETRY_MS = 300;

// === DOM ===
var $ = function (sel) {
  return document.querySelector(sel);
};
var $$ = function (sel) {
  return document.querySelectorAll(sel);
};

var dom = {
  sidebarContent: $('#sidebarContent'),
  sidebarContentDuplicate: $('#sidebarContentDuplicate'),
  folderNavBar: $('#folderNavBar'),
  folderNavUp: $('#folderNavUp'),
  statsBar: $('#statsBar'),
  scanProgress: $('#taskPanel'),
  progressText: $('#progressText'),
  progressCount: $('#progressCount'),
  progressFill: $('#progressFill'),
  progressFile: $('#progressFile'),
  toolbar: $('#toolbar'),
  currentPath: $('#currentPath'),
  mediaFilterSelect: $('#mediaFilterSelect'),
  sortSelect: $('#sortSelect'),
  photoGrid: $('#photoGrid'),
  emptyState: $('#emptyState'),
  pagination: $('#pagination'),
  pageInfo: $('#pageInfo'),
  prevPage: $('#prevPage'),
  nextPage: $('#nextPage'),
  randomPageBtn: $('#randomPageBtn'),
  pageSizeControl: $('#pageSizeControl'),
  pageSizeLabel: $('#pageSizeLabel'),
  pageSizeDecBtn: $('#pageSizeDecBtn'),
  pageSizeIncBtn: $('#pageSizeIncBtn'),
  previewOverlay: $('#previewOverlay'),
  previewBody: $('#previewBody'),
  previewImage: $('#previewImage'),
  previewVideo: $('#previewVideo'),
  previewVideoCenterPlay: $('#previewVideoCenterPlay'),
  previewClose: $('#previewClose'),
  previewPrev: $('#previewPrev'),
  previewNext: $('#previewNext'),
  previewZoom: $('#previewZoom'),
  previewToast: $('#previewToast'),
  slideshowToggleBtn: $('#slideshowToggleBtn'),
  slideshowIntervalSelect: $('#slideshowIntervalSelect'),
  slideshowRandomBtn: $('#slideshowRandomBtn'),
  previewFullscreenBtn: $('#previewFullscreenBtn'),
  previewSubtitleTrackSelect: $('#previewSubtitleTrackSelect'),
  settingsPage: $('#settingsPage'),
  contentArea: $('#contentArea'),
  settingsAddBtn: $('#settingsAddBtn'),
  settingsFolderList: $('#settingsFolderList'),
  settingAutoScan: $('#settingAutoScan'),
  settingAutoThumbBackfillOnStartup: $('#settingAutoThumbBackfillOnStartup'),
  settingAutoHashOnStartup: $('#settingAutoHashOnStartup'),
  settingLaunchDefaultPage: $('#settingLaunchDefaultPage'),
  settingTunnelEnabled: $('#settingTunnelEnabled'),
  thumbBackfillStatus: $('#thumbBackfillStatus'),
  thumbBackfillStartBtn: $('#thumbBackfillStartBtn'),
  thumbBackfillCancelBtn: $('#thumbBackfillCancelBtn'),
  thumbBackfillExportFailedBtn: $('#thumbBackfillExportFailedBtn'),
  duplicateHashStartBtn: $('#duplicateHashStartBtn'),
  duplicateHashCancelBtn: $('#duplicateHashCancelBtn'),
  gotoSimilarBtn: $('#gotoSimilarBtn'),
  maintenanceStatus: $('#maintenanceStatus'),
  duplicateHashStatus: $('#duplicateHashStatus'),
  maintenanceCleanupBtn: $('#maintenanceCleanupBtn'),
  maintenanceRebuildThumbFlagsBtn: $('#maintenanceRebuildThumbFlagsBtn'),
  maintenanceOptimizeBtn: $('#maintenanceOptimizeBtn'),
  previewFavoriteBtn: $('#previewFavoriteBtn'),
  previewFindSimilarBtn: $('#previewFindSimilarBtn'),
  previewShowInFolderBtn: $('#previewShowInFolderBtn'),
  previewInfoToggle: $('#previewInfoToggle'),
  previewInfoPanel: $('#previewInfoPanel'),
  previewInfoPanelClose: $('#previewInfoPanelClose'),
  previewInfoPanelContent: $('#previewInfoPanelContent'),
  // 智能视图（搜图 / 人物）：控件与状态都在左侧栏，结果落进 #photoGrid
  aiSearchForm: $('#aiSearchForm'),
  aiSearchInput: $('#aiSearchInput'),
  aiSearchSubmit: $('#aiSearchSubmit'),
  aiViewStatus: $('#aiViewStatus'),
  aiPeopleStatus: $('#aiPeopleStatus'),
  aiSearchHistoryList: $('#aiSearchHistoryList'),
  aiSearchHistoryClear: $('#aiSearchHistoryClear'),
  aiSearchSuggest: $('#aiSearchSuggest'),
  peopleList: $('#peopleList'),
  peopleSearchInput: $('#peopleSearchInput'),
  aiPeopleLive: $('#aiPeopleLive'),
  aiPeopleLiveText: $('#aiPeopleLiveText'),
  aiPeopleLiveStats: $('#aiPeopleLiveStats'),
};

/** 主浏览区（#photoGrid）滚到顶部，分页/下一页后立即对齐网格起点 */
function scrollBrowseGridToTop() {
  if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
}

/**
 * 双 requestAnimationFrame，让滚动与骨架屏等先完成绘制，再执行大批量 innerHTML，减轻“点下一页卡死”感
 */
function yieldToPaint() {
  return new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(resolve);
    });
  });
}

/** 双 rAF 后再执行，让 tab/顶栏/侧栏先完成绘制，再跑目录树与网格，减轻切换卡顿 */
function scheduleBrowseReload(fn) {
  requestAnimationFrame(function () {
    requestAnimationFrame(fn);
  });
}

function _showAppDialog(options) {
  return dialogUi.showAppDialog(options);
}

function appAlert(message, title) {
  return dialogUi.appAlert(message, title);
}

function appConfirm(message, title) {
  return dialogUi.appConfirm(message, title);
}

var _previewToastTimer = null;
function showPreviewToast(message, duration) {
  duration = duration || 1500;
  var el = dom.previewToast;
  if (!el) return;
  el.textContent = message || '';
  el.classList.add('show');
  if (_previewToastTimer) clearTimeout(_previewToastTimer);
  _previewToastTimer = setTimeout(function () {
    el.classList.remove('show');
    _previewToastTimer = null;
  }, duration);
}

function normalizeThemeStyle(id) {
  return appearanceUi.normalizeThemeStyle(id);
}

async function cycleUiThemePreset() {
  if (!(api && api.has('updateSettings'))) return;
  var ap = state.generalSettingsApplied;
  var presets = appearanceUi.getThemePresets ? appearanceUi.getThemePresets() : [];
  var defId = appearanceUi.getDefaultThemeStyleId
    ? appearanceUi.getDefaultThemeStyleId()
    : 'midnight_classic';
  var curId = ap && ap.themeStyle ? normalizeThemeStyle(ap.themeStyle) : defId;
  var startIdx = 0;
  for (var ci = 0; ci < presets.length; ci++) {
    if (presets[ci].id === curId) {
      startIdx = (ci + 1) % presets.length;
      break;
    }
  }
  var next = presets[startIdx] || { id: defId };
  try {
    var r = await api.updateSettings({ themeStyle: next.id });
    syncAppearanceFromSettings(r);
    setGeneralSettingsAppliedFromObject(r);
    var st = document.getElementById('settingThemeStyle');
    if (st) st.value = normalizeThemeStyle(r.themeStyle);
    var qt = document.getElementById('quickThemeStyle');
    if (qt) qt.value = normalizeThemeStyle(r.themeStyle);
    if (dom.settingAutoScan) dom.settingAutoScan.checked = !!r.autoScanOnStartup;
    if (dom.settingAutoThumbBackfillOnStartup)
      dom.settingAutoThumbBackfillOnStartup.checked = !!r.autoThumbBackfillOnStartup;
    if (dom.settingAutoHashOnStartup) dom.settingAutoHashOnStartup.checked = !!r.autoHashOnStartup;
  } catch (e) {
    appAlert('切换界面风格失败：' + (e && e.message ? e.message : String(e)));
  }
}

function normalizeUiAccent(a) {
  return appearanceUi.normalizeUiAccent(a);
}

function normalizeUiBackground(b) {
  return appearanceUi.normalizeUiBackground(b);
}

function normalizeSubtitleFontFamily(v) {
  var s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'serif' || s === 'mono') return s;
  return 'system';
}

function normalizeSubtitleFontSizePx(v, fallbackLegacy) {
  var n = parseInt(v, 10);
  if (isNaN(n)) {
    var legacy = String(fallbackLegacy || '')
      .trim()
      .toLowerCase();
    if (legacy === 'md') n = 18;
    else if (legacy === 'xl') n = 26;
    else n = 22;
  }
  if (n < 12) n = 12;
  if (n > 72) n = 72;
  return n;
}

function normalizeSubtitleFontWeight(v) {
  var s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'normal' || s === 'bold') return s;
  return 'medium';
}

function normalizeSubtitleColor(v) {
  var s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'yellow' || s === 'cyan' || s === 'green' || s === 'orange' || s === 'pink') return s;
  return 'white';
}

function applySubtitleStyleFromSettings(s) {
  if (!s) s = {};
  var fam = normalizeSubtitleFontFamily(s.subtitleFontFamily);
  var sizePx = normalizeSubtitleFontSizePx(s.subtitleFontSizePx, s.subtitleFontSize);
  var weight = normalizeSubtitleFontWeight(s.subtitleFontWeight);
  var color = normalizeSubtitleColor(s.subtitleColor);
  var root = document.documentElement;
  var famMap = {
    system: "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
    serif: "'Noto Serif SC','Songti SC','STSong','Times New Roman',serif",
    mono: "'Cascadia Mono','Consolas','SFMono-Regular','Courier New',monospace",
  };
  var weightMap = { normal: '400', medium: '500', bold: '700' };
  var colorMap = {
    white: '#ffffff',
    yellow: '#fff3a1',
    cyan: '#baf8ff',
    green: '#b8ffb6',
    orange: '#ffd2a6',
    pink: '#ffc4e6',
  };
  root.style.setProperty('--subtitle-font-family', famMap[fam]);
  root.style.setProperty('--subtitle-font-size', String(sizePx) + 'px');
  root.style.setProperty('--subtitle-font-weight', weightMap[weight]);
  root.style.setProperty('--subtitle-color', colorMap[color]);
}

function syncSubtitleStyleControlsFromSettings(s) {
  if (!s) s = {};
  var famEl = document.getElementById('settingSubtitleFontFamily');
  var sizeEl = document.getElementById('settingSubtitleFontSize');
  var weightEl = document.getElementById('settingSubtitleFontWeight');
  var colorEl = document.getElementById('settingSubtitleColor');
  if (famEl) famEl.value = normalizeSubtitleFontFamily(s.subtitleFontFamily);
  if (sizeEl)
    sizeEl.value = String(normalizeSubtitleFontSizePx(s.subtitleFontSizePx, s.subtitleFontSize));
  if (weightEl) weightEl.value = normalizeSubtitleFontWeight(s.subtitleFontWeight);
  if (colorEl) colorEl.value = normalizeSubtitleColor(s.subtitleColor);
}

/** 根据完整设置同步 html 的 data-theme / data-accent / data-bg */
function syncAppearanceFromSettings(s) {
  return appearanceUi.syncAppearanceFromSettings(s);
}

function isKeyEventFromTypingField(target) {
  if (!target || !target.tagName) return false;
  var t = target.tagName;
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/** 桌面端：隐藏顶栏、侧栏与全局任务条；管理页打开时不切换 */
function toggleChromeCollapsed() {
  if (state.isMobile) return;
  if (dom.settingsPage && dom.settingsPage.style.display !== 'none') return;
  document.body.classList.toggle('chrome-collapsed');
}

function scheduleNextBackgroundTaskPoll(delayMs) {
  return bgTasksOrchestrator.scheduleNextBackgroundTaskPoll({
    state: state,
    delayMs: delayMs,
    activeMs: BG_TASK_POLL_ACTIVE_MS,
    idleMs: BG_TASK_POLL_IDLE_MS,
    onTick: tickBackgroundTasksOnce,
  });
}

async function tickBackgroundTasksOnce() {
  return bgTasksOrchestrator.tickBackgroundTasksOnce({
    scanFlow: scanFlow,
    state: state,
    dom: dom,
    api: api,
    retryMs: BG_TASK_POLL_RETRY_MS,
    onScheduleNext: scheduleNextBackgroundTaskPoll,
    onRenderBackgroundTaskPanel: function (t) {
      return scanFlow.renderBackgroundTaskPanel({
        state: state,
        dom: dom,
        tasks: t,
        formatNumber: formatNumber,
        onSyncTaskPanelCollapsedUI: syncTaskPanelCollapsedUI,
      });
    },
    onRefreshThumbnailBackfillStatus: refreshThumbnailBackfillStatus,
    onRefreshDuplicateHashStatus: refreshDuplicateHashStatus,
  });
}

/** 管理页上次定位的面板 id（如 settingsSectionStorage） */
var SETTINGS_LAST_SECTION_LS_KEY = 'photoManager.settingsLastSection.v1';
/** 两栏化后的 6 个面板 id，顺序须与 index.html 的 [data-settings-panel] 一致 */
var VALID_SETTINGS_SECTION_IDS = {
  settingsSectionFolders: 1,
  settingsSectionBrowse: 1,
  settingsSectionStorage: 1,
  settingsSectionTasks: 1,
  settingsSectionApp: 1,
  settingsSectionNetwork: 1,
};
/**
 * 历史 id → 当前面板 id。
 * 设置页经历过两次改版（单页 8 区块 → 两栏 6 面板 → 两栏 7 面板），localStorage 里
 * 可能还存着任一代的旧值，直接把老用户丢回默认位置体验很差；这里做一次映射，
 * 写回时也统一存新 id。
 * 注意 `settingsSectionPeople` 在两代里同名，normalize 后仍指向自己，无需别名。
 */
var SETTINGS_SECTION_ID_ALIAS = {
  // 搜图 / 人物这三个名字换过好几代：8 区块时代的「语义 / 人脸」、6 面板时代的
  // 「智能索引」、7~8 面板时代的「搜图 / 人物」两个独立类目。它们现在都并进了
  // 「后台任务」（索引本来就是一类长跑任务），老用户的 localStorage 一律归一到这里。
  settingsSectionSearch: 'settingsSectionTasks',
  settingsSectionPeople: 'settingsSectionTasks',
  settingsSectionSemantic: 'settingsSectionTasks',
  settingsSectionAi: 'settingsSectionTasks',
  settingsSectionCloseBehavior: 'settingsSectionApp',
  settingsSectionGeneral: 'settingsSectionApp',
  settingsSectionMedia: 'settingsSectionStorage',
};

function normalizeSettingsSectionId(sectionId) {
  if (!sectionId) return sectionId;
  return SETTINGS_SECTION_ID_ALIAS[sectionId] || sectionId;
}

function getLastSettingsSectionId() {
  try {
    var id = normalizeSettingsSectionId(localStorage.getItem(SETTINGS_LAST_SECTION_LS_KEY));
    if (id && VALID_SETTINGS_SECTION_IDS[id] && document.getElementById(id)) return id;
  } catch (e) {}
  return 'settingsSectionFolders';
}

function saveLastSettingsSectionId(sectionId) {
  sectionId = normalizeSettingsSectionId(sectionId);
  if (!sectionId || !VALID_SETTINGS_SECTION_IDS[sectionId]) return;
  try {
    localStorage.setItem(SETTINGS_LAST_SECTION_LS_KEY, sectionId);
  } catch (e) {}
}

// 扫描选项 UI 已从管理界面移除（历史草稿键保留删除接口无意义，直接下线）

function restoreSettingsPageSectionScroll() {
  var id = getLastSettingsSectionId();
  var el = document.getElementById(id);
  if (!el) return;
  renderSettingsNav(id);
  requestAnimationFrame(function () {
    settingsUi.showSettingsPanel(id);
  });
}

function syncTaskPanelCollapsedUI() {
  return taskPanelUi.syncTaskPanelCollapsedUI({ dom: dom });
}

function toggleTaskPanelCollapse() {
  return taskPanelUi.toggleTaskPanelCollapse({ dom: dom });
}

function hideCloseChoiceOverlay() {
  return closeChoiceUi.hideCloseChoiceOverlay({
    onCloseChoiceOnEscape: closeChoiceOnEscape,
  });
}

function showCloseChoiceOverlay() {
  return closeChoiceUi.showCloseChoiceOverlay({
    onCloseChoiceOnEscape: closeChoiceOnEscape,
  });
}

async function submitCloseChoice(action) {
  return closeChoiceUi.submitCloseChoice(action, {
    api: api,
    state: state,
    onHideCloseChoiceOverlay: hideCloseChoiceOverlay,
    onSyncLiveSettingsWidgetsFromObject: syncLiveSettingsWidgetsFromObject,
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
  });
}

function closeChoiceOnEscape(e) {
  return closeChoiceUi.closeChoiceOnEscape(e, {
    onSubmitCloseChoice: submitCloseChoice,
  });
}

// === Init ===
async function applyInitialSettingsSnapshot() {
  if (dom.sidebarContentDuplicate) {
    dom.sidebarContentDuplicate.style.display = 'none';
  }
  var s0 = await (api && api.has('getSettings') ? api.getSettings() : Promise.resolve({}));
  syncLiveSettingsWidgetsFromObject(s0);
  applyThumbAppliedStateFromSettings(s0);
  settingsSync.applyBrowsePreferencesFromSettings({
    state: state,
    dom: dom,
    settings: s0,
    snapBrowseCardBasis: snapBrowseCardBasis,
    onApplyCardSize: applyCardSize,
    onSetBrowseAppliedSnapshotFromObject: setBrowseAppliedSnapshotFromObject,
    onApplyPageSize: syncPageSizeControl,
  });
  if (window.I18n && typeof window.I18n.initFromSettings === 'function') {
    window.I18n.initFromSettings(s0);
  }
  if (api && typeof api.getAppVersion === 'function') {
    api
      .getAppVersion()
      .then(function (v) {
        if (window.I18n && typeof window.I18n.setVersion === 'function') {
          window.I18n.setVersion(v);
        }
      })
      .catch(function () {});
  }
  syncTaskPanelCollapsedUI();
}

function registerRuntimeApiListeners() {
  if (!api) return;

  api.onShowCloseChooser(function () {
    showCloseChoiceOverlay();
  });

  api.onBackgroundTasksChanged(function () {
    scheduleNextBackgroundTaskPoll(30);
    tickBackgroundTasksOnce();
  });

  // 监听系统菜单触发的添加文件夹
  api.onTriggerScan(function (folderPath) {
    scanFlow.doScanFolder({
      state: state,
      dom: dom,
      api: api,
      folderPath: folderPath,
      onUpdateProgress: function (c, t, f) {
        updateProgress(c, t, f);
      },
      onLoadStats: loadStats,
      onLoadRootFolders: loadRootFolders,
      onRenderSettingsFolderList: renderSettingsFolderList,
      onRenderDuplicateSidebar: renderDuplicateSidebar,
      onLoadDuplicateGroups: loadDuplicateGroups,
      onLoadPhotos: loadPhotos,
      onAlert: appAlert,
      onTickBackgroundTasksOnce: tickBackgroundTasksOnce,
      onMarkBrowseDataStale: markBrowseDataStale,
    });
  });

  // 监听自动扫描开始的信号
  api.onScanStart(function () {
    state.isScanning = true;
    if (dom.scanProgress) dom.scanProgress.style.display = 'block';
    updateProgress(0, 1, '准备中...');
    startScanLiveRefresh();
    tickBackgroundTasksOnce();
  });

  // 监听自动扫描完成的信号
  api.onScanComplete(async function (folderPath, result) {
    state.isScanning = false;
    stopScanLiveRefresh();
    if (result && result.error) {
      appAlert('自动扫描失败：' + result.error);
    } else {
      markBrowseDataStale({
        settingsPageDirty: state.currentTab === 'settings',
      });
    }
    await loadStats();
    await loadRootFolders(state.rootFolders.length > 0, state.currentTab === 'settings');
    if (state.currentTab === 'settings') {
      await renderSettingsFolderList();
    }
    if (!state.currentView) {
      state.currentView = 'all';
      state.page = 1;
    }
    if (state.currentTab === 'duplicates' || state.currentView === 'duplicates') {
      renderDuplicateSidebar();
      if (state.duplicateHasScanned) {
        await loadDuplicateGroups(state.duplicateGroupsPage || 1, { forceReload: true });
      }
    } else {
      loadPhotos();
    }
    tickBackgroundTasksOnce();
  });
}

function startRuntimePolling() {
  scanFlow.startBackgroundTaskPolling({
    state: state,
    api: api,
    onTickBackgroundTasksOnce: tickBackgroundTasksOnce,
  });
}

function startSettingsFolderListPolling() {
  stopSettingsFolderListPolling();
  state.settingsFolderListPollTimer = setInterval(function () {
    ensureSettingsFolderListHydrated();
  }, 2200);
}

function stopSettingsFolderListPolling() {
  if (state.settingsFolderListPollTimer) {
    clearInterval(state.settingsFolderListPollTimer);
    state.settingsFolderListPollTimer = null;
  }
}

function _showInitialTabAndMaybeLoadPhotos() {
  showTabContent('folders');
}

function persistStartupPositionSnapshot() {
  try {
    if (state.currentTab === 'settings') return;
    var payload = {
      currentTab: state.currentTab === 'dates' ? 'dates' : 'folders',
      currentView: String(state.currentView || 'all'),
      currentPath: String(state.currentPath || ''),
      currentDate: String(state.currentDate || ''),
      searchQuery: String(state.searchQuery || ''),
      page: parseInt(state.page, 10) || 1,
      sortBy: String(state.sortBy || 'date_taken'),
      sortOrder: state.sortOrder === 'ASC' ? 'ASC' : 'DESC',
      mediaFilter:
        state.mediaFilter === 'image' || state.mediaFilter === 'video' ? state.mediaFilter : 'all',
    };
    localStorage.setItem(STARTUP_POSITION_KEY, JSON.stringify(payload));
  } catch (e) {}
}

function restoreStartupPositionSnapshot() {
  try {
    var raw = localStorage.getItem(STARTUP_POSITION_KEY);
    if (!raw) return false;
    var p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return false;
    var v = String(p.currentView || '')
      .trim()
      .toLowerCase();
    var allowedViews = ['all', 'favorites', 'folder_overview', 'folder', 'date', 'search'];
    if (allowedViews.indexOf(v) < 0) return false;
    state.currentView = v;
    state.currentPath = String(p.currentPath || '');
    state.currentDate = String(p.currentDate || '');
    state.searchQuery = String(p.searchQuery || '');
    var pg = parseInt(p.page, 10);
    state.page = pg > 0 ? pg : 1;
    state.sortBy = String(p.sortBy || 'date_taken');
    state.sortOrder = p.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    state.mediaFilter =
      p.mediaFilter === 'image' || p.mediaFilter === 'video' ? p.mediaFilter : 'all';
    state.currentTab = v === 'date' ? 'dates' : p.currentTab === 'dates' ? 'dates' : 'folders';
    return true;
  } catch (e) {
    return false;
  }
}

function applyStartupLandingPage() {
  // ⚠️ 只在用户还没动过界面时才落地。这个函数是启动流程的最后一步，排在
  // `await loadRootFolders(true, true)` 之后（这台 122 万照片 / 3.1 万目录的库上要十几秒），
  // 而 `bindEvents()` 已经先跑过、点击都绑好了——用户在等待期间点进设置 / 搜图 / 人物 /
  // 重复是完全正常的操作。落地若无条件 showTabContent('folders')，就会把用户当场踢回
  // 浏览态；更早的版本还会因此留下 settings-page-open 孤儿 class，表现为
  // 「点搜图，残留设置分栏导航」（见 syncPageOpenClasses 的注释）。
  // 判据 = 当前仍在初始落点（文件 / 全部、无目录、无日期、无检索词）。
  if (
    state.currentTab !== 'folders' ||
    state.currentView !== 'all' ||
    state.currentPath ||
    state.currentDate ||
    state.searchQuery
  )
    return;
  var launchDefaultPage = normalizeLaunchDefaultPage(
    state.generalSettingsApplied && state.generalSettingsApplied.launchDefaultPage,
  );
  if (launchDefaultPage === 'welcome') {
    state.currentTab = 'folders';
    state.currentView = 'all';
    state.currentPath = '';
    state.currentDate = '';
    state.searchQuery = '';
    state.page = 1;
    state.suppressAutoLoadOnce = true;
    showTabContent('folders');
    return;
  }
  if (launchDefaultPage === 'all_folders') {
    state.currentTab = 'folders';
    state.currentView = 'folder_overview';
    state.currentPath = '';
    state.currentDate = '';
    state.searchQuery = '';
    state.page = 1;
    showTabContent('folders');
    return;
  }
  if (launchDefaultPage === 'last_position' && restoreStartupPositionSnapshot()) {
    showTabContent(state.currentTab === 'dates' ? 'dates' : 'folders');
    return;
  }
  state.currentTab = 'folders';
  state.currentView = 'all';
  state.currentPath = '';
  state.currentDate = '';
  state.searchQuery = '';
  state.page = 1;
  showTabContent('folders');
}

async function init() {
  try {
    var dgs = localStorage.getItem('dateGroupsSortOrder');
    if (dgs === 'asc' || dgs === 'desc') state.dateGroupsSortOrder = dgs;
  } catch (eDgs) {}
  await applyInitialSettingsSnapshot();
  // 先根目录 lite + 侧栏补全；全库统计 getStats 延后一帧，避免与首屏网格抢同一段主进程 DB 时间
  await loadRootFolders(true, true);
  bindEvents();
  if (sidebarResizer && typeof sidebarResizer.initSidebarResizer === 'function')
    sidebarResizer.initSidebarResizer();
  await yieldToPaint();
  applyStartupLandingPage();
  registerRuntimeApiListeners();
  requestAnimationFrame(function () {
    void loadStats();
  });
  setTimeout(function () {
    startRuntimePolling();
    void loadWebUrl();
    void refreshWebServerStatus();
  }, 0);
}

function _showSidebarListLoading(message) {
  if (!dom.sidebarContent) return;
  dom.sidebarContent.innerHTML =
    '<div class="sidebar-list-loading">' +
    '<div class="content-loading-spinner" aria-hidden="true"></div>' +
    '<span>' +
    (message || '正在加载…') +
    '</span>' +
    '</div>';
}

function bumpSidebarViewToken() {
  state.sidebarViewToken = (state.sidebarViewToken || 0) + 1;
}

/**
 * 只有「文件」页用文件夹树侧栏；「日期 / 重复 / 设置」各有自己的侧栏形态，
 * 而「搜图 / 人物」在本次改造后是侧栏独占（搜图页侧栏 = 搜索框 + 历史，
 * 人物页侧栏 = 人物列表），因此这三者都不应被放宽到文件夹树侧栏。
 */
function isFolderSidebarTab(tab) {
  return tab === 'folders';
}

/**
 * 把当前 tab 映射到 <html> 上的三个 page-open 类（侧栏让位全走 CSS）。
 *
 * 三者互斥、且只由 tab 决定 —— 这里是全工程唯一的写者，由 syncNavigationRail 调用，
 * 而 syncNavigationRail 又是所有切页路径的必经点（showTabContent / openSettingsPage /
 * leaveAiViewForBrowse）。
 *
 * 为什么必须是「派生」而不是各自 add/remove：settings-page-open 原先只在
 * openSettingsPage 里 add、closeSettingsPage 里 remove，只要有一条路径改了
 * state.currentTab 而没走 closeSettingsPage（后台任务回调、启动落地、AI 视图退出），
 * 这个类就会变成孤儿。而 navigation.css 里
 * `html.settings-page-open #sidebar > #settingsSidebar { display: block !important }`
 * 的优先级高于 `#settingsSidebar[hidden] { display: none !important }`
 * （两条都是 !important，比特异性），于是设置导航会永久盖在搜图 / 人物侧栏上、
 * 且再也摘不掉 —— 用户看到的就是「点搜图，残留设置分栏导航」。
 */
function syncPageOpenClasses(tab) {
  var root = document.documentElement;
  if (!root || !root.classList) return;
  root.classList.toggle('settings-page-open', tab === 'settings');
  root.classList.toggle('search-page-open', tab === 'search');
  root.classList.toggle('people-page-open', tab === 'people');
}

function createSidebarRequestGate(view, key) {
  var token = state.sidebarViewToken || 0;
  state.sidebarRequestSeq = (state.sidebarRequestSeq || 0) + 1;
  var reqId = state.sidebarRequestSeq;
  var reqKey = String(view) + ':' + String(key || 'default');
  if (!state.sidebarLatestRequests || typeof state.sidebarLatestRequests !== 'object') {
    state.sidebarLatestRequests = {};
  }
  state.sidebarLatestRequests[reqKey] = reqId;
  return {
    isAlive: function () {
      if (state.sidebarLockedMode && state.sidebarLockedMode !== view) return false;
      // gate 的 view 语义保持窄：folders 只在「文件」页存活（搜图 / 人物已改为侧栏独占）。
      var tabMatches = state.currentTab === view;
      return (
        tabMatches &&
        state.sidebarViewToken === token &&
        state.sidebarLatestRequests &&
        state.sidebarLatestRequests[reqKey] === reqId
      );
    },
    render: function (html) {
      if (!this.isAlive() || !dom.sidebarContent) return false;
      dom.sidebarContent.innerHTML = html;
      return true;
    },
  };
}

function ensureSettingsFolderListHydrated() {
  if (state.currentTab !== 'settings') return;
  var listEl = document.getElementById('settingsFolderList');
  var settingsEl = document.getElementById('settingsPage');
  if (!listEl || !settingsEl) return;
  if (settingsEl.style.display === 'none') return;
  if (listEl.querySelector('.folder-manage-row')) return;
  // 只要还没有真实目录项，就继续尝试一次渲染
  renderSettingsFolderList();
}

async function loadWebUrl() {
  return webAccessUi.loadWebUrl({ state: state, api: api });
}

function cyclePreviewRotateAction() {
  return previewInteraction.cyclePreviewRotate({
    state: state,
    onUpdatePreviewTransform: function () {
      return previewInteraction.updatePreviewTransform({
        state: state,
        dom: dom,
      });
    },
    onUpdatePreviewImageLayoutBounds: function () {
      return previewInteraction.updatePreviewImageLayoutBounds({
        state: state,
        dom: dom,
      });
    },
  });
}

function bindEvents() {
  uiEvents.bindTitlebarMenu();
  uiEvents.bindWindowControls(api);
  uiEvents.bindMobileSidebar({
    onResize: function (width) {
      state.isMobile = width <= 600;
      previewInteraction.updatePreviewImageLayoutBounds({
        state: state,
        dom: dom,
      });
    },
  });

  dom.settingsAddBtn.addEventListener('click', handleAddFolder);

  uiEvents.bindSettingsDelegates({
    onPersistWindowClose: function () {
      return settingsSync.persistWindowCloseSetting({
        state: state,
        api: api,
        onSaveLastSettingsSectionId: saveLastSettingsSectionId,
        onRenderSettingsNav: renderSettingsNav,
        appAlert: appAlert,
      });
    },
    onPersistGeneralSettings: persistGeneralSettingsFromControls,
    onPersistUiLocale: persistUiLocaleFromControl,
    onToggleWebServerEnabled: toggleWebServerEnabled,
    onToggleTunnelEnabled: toggleTunnelEnabled,
    onPersistBrowsePrefs: persistBrowsePrefsFromForm,
  });

  uiEvents.bindMiscControls({
    onCancelCloseChoice: function () {
      submitCloseChoice('cancel');
    },
    onThumbSettingChange: updateThumbPendingHint,
    onQuickThemeChange: persistGeneralSettingsFromControls,
    onTopbarLocaleChange: function () {
      void persistUiLocaleFromControl('topbar');
    },
    onWebPasswordFocus: function (inputEl) {
      inputEl.dataset.pwdTouched = '1';
    },
  });

  uiEvents.bindShellInlineActions({
    onMenuAction: function (action) {
      void menuAction(action);
    },
    onOpenSettingsPage: function () {
      void openSettingsPage();
    },
    onToggleTaskPanelCollapse: toggleTaskPanelCollapse,
    onPauseResumeScan: handlePauseResumeScan,
    onCancelScan: handleCancelScan,
    onCancelThumbnailBackfill: cancelThumbnailBackfill,
    onCancelFaceScan: cancelFaceScan,
    onCancelDuplicateHashDetection: cancelDuplicateHashDetection,
    onCardSizeDec: function () {
      changeCardSize(-1);
    },
    onCardSizeInc: function () {
      changeCardSize(1);
    },
    onPageSizeDec: function () {
      void changeBrowsePageSize(-1);
    },
    onPageSizeInc: function () {
      void changeBrowsePageSize(1);
    },
    onCloseSettingsPage: closeSettingsPage,
    onApplyThumbSettings: applyThumbSettings,
    onStartThumbnailBackfill: startThumbnailBackfill,
    onStartDuplicateHashDetection: startDuplicateHashDetection,
    onGotoSimilar: gotoSimilarMode,
    onRunMaintenanceCleanup: runMaintenanceCleanup,
    onRunMaintenanceRebuildThumbFlags: runMaintenanceRebuildThumbFlags,
    onRunMaintenanceOptimize: runMaintenanceOptimize,
    onOpenDatabaseFolder: openDatabaseFolder,
    onRunMaintenanceBackup: runMaintenanceBackup,
    onSaveWebPassword: saveWebPassword,
    onCopyWebUrl: copyWebUrl,
    onCopyTunnelUrl: copyTunnelUrl,
    onCopyTunnelLog: copyTunnelLog,
    onToggleSlideshow: toggleSlideshow,
    onToggleSlideshowRandom: toggleSlideshowRandom,
    onTogglePreviewFullscreen: togglePreviewFullscreen,
    onMinimizePreview: function () {
      if (api && api.has && api.has('minimizeWindow')) {
        api.minimizeWindow();
      }
    },
    onPreviewWindowMaximize: togglePreviewWindowMaximize,
    onCyclePreviewRotate: cyclePreviewRotateAction,
    onPreviewToggleFavorite: previewToggleFavorite,
    onPreviewFindSimilar: previewFindSimilar,
    onPreviewShowInFolder: previewShowInFolder,
    onPreviewOpenExternal: previewOpenExternal,
    onPreviewMoveToTrash: previewMoveToTrash,
    onTogglePreviewInfoPanel: togglePreviewInfoPanel,
    onSubmitCloseChoice: submitCloseChoice,
    onExportRootFoldersList: exportRootFoldersList,
    onImportRootFoldersList: importRootFoldersList,
    onExportThumbnailBackfillFailedPaths: exportThumbnailBackfillFailedPaths,
  });
  initPreviewWindowMaxButtonState();

  var hlsApplyBtn = document.getElementById('hlsCacheSettingsApplyBtn');
  if (hlsApplyBtn) {
    hlsApplyBtn.addEventListener('click', function () {
      void applyHlsCacheSettings();
    });
  }

  uiEvents.bindNavTabs({
    getState: function () {
      return state;
    },
    onViewDuplicates: viewDuplicates,
    onCloseSettingsPage: closeSettingsPage,
    onShowTabContent: showTabContent,
    onForceSwitchToDuplicates: forceSwitchToDuplicates,
    onEnsureDuplicateSidebarVisible: function () {
      return sidebarUi.ensureDuplicateSidebarVisible(dom);
    },
    onRenderDuplicateSidebar: renderDuplicateSidebar,
    onSaveBrowseTabMemory: saveBrowseTabMemory,
  });

  uiEvents.bindSearchSortFilters({
    dom: dom,
    getState: function () {
      return state;
    },
    onLoadPhotos: loadPhotos,
    onLoadRootFolders: loadRootFolders,
    isFolderSidebarTab: isFolderSidebarTab,
    normalizePositiveIntFilter: normalizePositiveIntFilter,
    normalizePositiveFloatFilter: normalizePositiveFloatFilter,
  });

  uiEvents.bindPaginationAndFolderCoverClick({
    dom: dom,
    getState: function () {
      return state;
    },
    onLoadPhotos: loadPhotos,
    onGoToRandomPage: goToRandomPage,
    onViewFolder: viewFolder,
    onNormalizePath: sidebarTree.normalizePath,
    onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
  });

  uiEvents.bindPhotoGridDelegates({
    dom: dom,
    onStartPreview: startPreview,
    onToggleFavoriteOnCard: toggleFavoriteOnCard,
    onGoToPage: goToPage,
  });

  uiEvents.bindDuplicatesDelegates({
    onStartDuplicateHashDetection: startDuplicateHashDetection,
    onLoadDuplicateGroups: loadDuplicateGroups,
    onOpenDuplicatePreview: openDuplicatePreview,
    onShowPhotoInFolderById: showPhotoInFolderById,
    onDeleteDuplicatePhoto: deleteDuplicatePhoto,
    onSwitchDuplicateMode: switchDuplicateMode,
  });

  uiEvents.bindPreviewBasicControls({
    dom: dom,
    onClosePreview: closePreview,
    onNavigatePreview: navigatePreview,
    onResetZoom: function () {
      return previewInteraction.resetZoom({
        state: state,
        onUpdatePreviewTransform: function () {
          return previewInteraction.updatePreviewTransform({
            state: state,
            dom: dom,
          });
        },
        onUpdatePreviewImageLayoutBounds: function () {
          return previewInteraction.updatePreviewImageLayoutBounds({
            state: state,
            dom: dom,
          });
        },
      });
    },
    onApplyZoom: function (delta) {
      return previewInteraction.applyZoom({
        state: state,
        delta: delta,
        onUpdatePreviewTransform: function () {
          return previewInteraction.updatePreviewTransform({
            state: state,
            dom: dom,
          });
        },
      });
    },
  });

  uiEvents.bindPreviewDragTouchControls({
    dom: dom,
    getState: function () {
      return state;
    },
    onUpdatePreviewTransform: function () {
      return previewInteraction.updatePreviewTransform({
        state: state,
        dom: dom,
      });
    },
    onZoomToActual: function () {
      return previewInteraction.zoomToActual({
        state: state,
        onUpdatePreviewTransform: function () {
          return previewInteraction.updatePreviewTransform({
            state: state,
            dom: dom,
          });
        },
      });
    },
    onNavigatePreview: navigatePreview,
  });

  uiEvents.bindKeyboardShortcuts({
    dom: dom,
    getState: function () {
      return state;
    },
    isKeyEventFromTypingField: isKeyEventFromTypingField,
    onClosePreview: closePreview,
    onNavigatePreview: navigatePreview,
    onPreviewMoveToTrash: previewMoveToTrash,
    onTogglePreviewInfoPanel: togglePreviewInfoPanel,
    onPreviewToggleFavorite: previewToggleFavorite,
    onPreviewFindSimilar: previewFindSimilar,
    onToggleSlideshow: toggleSlideshow,
    onResetZoom: function () {
      return previewInteraction.resetZoom({
        state: state,
        onUpdatePreviewTransform: function () {
          return previewInteraction.updatePreviewTransform({
            state: state,
            dom: dom,
          });
        },
        onUpdatePreviewImageLayoutBounds: function () {
          return previewInteraction.updatePreviewImageLayoutBounds({
            state: state,
            dom: dom,
          });
        },
      });
    },
    onApplyZoom: function (delta) {
      return previewInteraction.applyZoom({
        state: state,
        delta: delta,
        onUpdatePreviewTransform: function () {
          return previewInteraction.updatePreviewTransform({
            state: state,
            dom: dom,
          });
        },
      });
    },
    onOpenPreview: openPreview,
    onCyclePreviewRotate: cyclePreviewRotateAction,
    onPreviewOpenExternal: previewOpenExternal,
    onToggleChromeCollapsed: toggleChromeCollapsed,
  });

  uiEvents.bindPreviewUiMeta({
    dom: dom,
    getState: function () {
      return state;
    },
    onRestartSlideshowTimer: function () {
      return previewSlideshow.restartSlideshowTimer({
        state: state,
        onGoNextSlide: function () {
          return previewSlideshow.goNextSlide({
            state: state,
            api: api,
            buildPreviewAdjacentRequestOptions: buildPreviewAdjacentRequestOptions,
            onOpenPreview: openPreview,
            onOpenPreviewByPhoto: openPreviewByPhotoRecord,
          });
        },
      });
    },
    onSyncFullscreenButton: syncFullscreenButton,
    onUpdatePreviewImageLayoutBounds: function () {
      return previewInteraction.updatePreviewImageLayoutBounds({
        state: state,
        dom: dom,
      });
    },
  });

  uiEvents.bindSidebarDelegates({
    dom: dom,
    getState: function () {
      return state;
    },
    onDateGroupsSortChange: function (sortOrder) {
      var so = sortOrder === 'asc' ? 'asc' : 'desc';
      if (state.dateGroupsSortOrder === so) return;
      state.dateGroupsSortOrder = so;
      try {
        localStorage.setItem('dateGroupsSortOrder', so);
      } catch (eLs) {}
      if (state.currentTab === 'dates') loadDateGroups();
    },
    onViewDuplicates: viewDuplicates,
    onHandleSettingsRescan: handleSettingsRescan,
    onScrollToSettingsSection: scrollToSettingsSection,
    onViewDatesAll: viewAllPhotos,
    onViewFavorites: viewFavorites,
    onViewDate: viewDate,
    onViewFolderOverview: viewAllFolderCovers,
    onToggleTreeRoot: sidebarTree.toggleTreeRoot,
    onToggleTreeNode: sidebarTree.toggleTreeNode,
    onNormalizePath: sidebarTree.normalizePath,
    onViewFolder: viewFolder,
    onSelectDuplicateGroup: function (hash) {
      return duplicatesFlow.selectDuplicateGroup({
        state: state,
        api: api,
        hash: hash,
        onCreateSidebarRequestGate: createSidebarRequestGate,
        onRenderDuplicateSidebar: renderDuplicateSidebar,
        onRenderDuplicateGroupPhotosHtml: renderDuplicateGroupPhotosHtml,
        onFormatNumber: formatNumber,
        onFormatSize: formatSize,
        onEscapeHtml: escapeHtml,
      });
    },
    onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
  });

  if (dom.folderNavUp) {
    dom.folderNavUp.addEventListener('click', function () {
      var parentPath = dom.folderNavUp.getAttribute('data-parent-path');
      if (parentPath) {
        viewFolder(parentPath);
      } else {
        viewAllFolderCovers();
      }
    });
  }

  uiEvents.bindCardShineTracking();

  window.addEventListener('localechange', function () {
    try {
      updateBrowsePathLabel();
    } catch (ePath) {}
    try {
      syncTaskPanelCollapsedUI();
    } catch (eTask) {}
    try {
      updateThumbCurrentLineDisplay();
      updateThumbPendingHint();
    } catch (eThumb) {}
    try {
      if (isFolderSidebarTab(state.currentTab)) {
        state.browseCaches.folders.sidebarSnapshot = null;
        void loadRootFolders(true, false);
      } else if (state.currentTab === 'dates') {
        state.browseCaches.dates.dateGroupsList = null;
        state.browseCaches.dates.dateGroupsListSort = null;
        state.browseCaches.dates.dateGroupsCacheFavAt = null;
        void loadDateGroups();
      }
    } catch (eSidebarI18n) {}
    try {
      if (
        state._photoBrowseCacheResult &&
        (state.currentTab === 'folders' || state.currentTab === 'dates')
      ) {
        paintBrowsePhotoGridShell(state._photoBrowseCacheResult, {});
      } else {
        void loadStats();
      }
    } catch (eStatsBar) {}
    try {
      if (state.currentTab === 'settings') {
        state._settingsFolderListFp = null;
        void renderSettingsFolderList({ skipFetch: true });
        void refreshWebServerStatus();
        void refreshTunnelStatus();
        var wCopyEl = document.getElementById('webUrlCopy');
        if (wCopyEl) wCopyEl.textContent = tUi('settings.network.copy', '点击复制');
        var tCopyEl = document.getElementById('tunnelUrlCopy');
        if (tCopyEl) tCopyEl.textContent = tUi('settings.network.copy', '点击复制');
        if (api && api.has && api.has('getSettings')) {
          api
            .getSettings()
            .then(function (s) {
              settingsSync.syncWebPasswordUiFromSettings({ state: state, settings: s });
            })
            .catch(function () {});
        }
        void refreshThumbnailBackfillStatus();
        void refreshDuplicateHashStatus();
        var hlsGbEl2 = document.getElementById('settingHlsMaxCacheGb');
        var hlsEnEl2 = document.getElementById('settingHlsMaxCacheEntries');
        var hlsHintEl2 = document.getElementById('hlsCacheSettingsHint');
        if (hlsGbEl2 && hlsEnEl2 && hlsHintEl2) {
          hlsHintEl2.textContent = tUiFmt(
            'settings.task.hlsHintCurrentFmt',
            { gb: hlsGbEl2.value, entries: hlsEnEl2.value },
            '当前生效：' +
              hlsGbEl2.value +
              'GB / ' +
              hlsEnEl2.value +
              ' 目录（磁盘上限 0GB 表示不限）',
          );
        }
      }
    } catch (eSet) {}
    try {
      if (
        typeof syncPreviewWindowMaxButton === 'function' &&
        api &&
        api.has &&
        api.has('isMaximized')
      ) {
        Promise.resolve(api.isMaximized())
          .then(function (v) {
            syncPreviewWindowMaxButton(!!v);
          })
          .catch(function () {});
      }
    } catch (ePrev) {}
  });
}

function syncPreviewWindowMaxButton(isMaximized) {
  var btn = document.getElementById('previewMaximizeBtn');
  if (!btn) return;
  var svg = btn.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    btn.innerHTML = '';
    btn.appendChild(svg);
  }
  var path = svg.querySelector('path');
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(path);
  }
  if (isMaximized) {
    // 还原：重叠双窗
    path.setAttribute('d', 'M9 7h8v8H9zM7 9h8v8H7z');
  } else {
    // 最大化：单窗
    path.setAttribute('d', 'M7 7h10v10H7z');
  }
  var tR =
    typeof tUi === 'function'
      ? tUi
      : function (_k, z) {
          return z;
        };
  btn.title = isMaximized
    ? tR('preview.winRestore', '还原窗口')
    : tR('preview.winMaximize', '最大化窗口');
  btn.setAttribute(
    'aria-label',
    isMaximized ? tR('preview.winRestore', '还原窗口') : tR('preview.winMaximize', '最大化窗口'),
  );
}

function initPreviewWindowMaxButtonState() {
  if (!(api && api.has && api.has('isMaximized') && api.has('onWindowMaximizedChange'))) return;
  Promise.resolve(api.isMaximized())
    .then(function (v) {
      syncPreviewWindowMaxButton(!!v);
    })
    .catch(function () {});
  api.onWindowMaximizedChange(function (isMaximized) {
    syncPreviewWindowMaxButton(!!isMaximized);
  });
}

function togglePreviewWindowMaximize() {
  if (!(api && api.has && api.has('maximizeWindow'))) return;
  api.maximizeWindow();
}

/** 是否仍为首次欢迎页（#emptyState 在网格内且未隐藏） */
function isWelcomeHomeVisible() {
  var es = document.getElementById('emptyState');
  if (!es || !dom.photoGrid || es.parentNode !== dom.photoGrid) return false;
  if (es.style.display === 'none') return false;
  return true;
}

function ensureBrowseCaches() {
  if (!state.browseCaches) {
    state.browseCaches = {
      folders: { tabMemory: null, sidebarSnapshot: null },
      dates: {
        tabMemory: null,
        dateGroupsList: null,
        dateGroupsListSort: null,
        dateGroupsCacheFavAt: null,
      },
    };
  } else if (
    state.browseCaches.folders &&
    state.browseCaches.folders.sidebarSnapshot === undefined
  ) {
    state.browseCaches.folders.sidebarSnapshot = null;
  }
}

function folderSidebarSnapshotFingerprint() {
  var roots = Array.isArray(state.rootFolders) ? state.rootFolders : [];
  return (
    normalizeMediaFilter(state.mediaFilter) +
    '|' +
    roots
      .map(function (r) {
        return String(r && r.id != null ? r.id : '');
      })
      .join(',')
  );
}

/** 从管理页软返回时恢复顶栏分页等（不重新请求目录与图片） */
function saveBrowseTabMemory(tabKey) {
  if (tabKey !== 'folders' && tabKey !== 'dates') return;
  ensureBrowseCaches();
  var st = dom.photoGrid ? dom.photoGrid.scrollTop : 0;
  var pathSnap =
    state.currentPath != null && String(state.currentPath).length
      ? sidebarTree.normalizePath(state.currentPath)
      : '';
  if (tabKey === 'folders' && dom.sidebarContent) {
    var sideHtml = dom.sidebarContent.innerHTML;
    if (
      sideHtml &&
      (sideHtml.indexOf('tree-root') >= 0 || sideHtml.indexOf('data-sidebar-all') >= 0)
    ) {
      state.browseCaches.folders.sidebarSnapshot = {
        html: sideHtml,
        fp: folderSidebarSnapshotFingerprint(),
      };
    }
  }
  state.browseCaches[tabKey].tabMemory = {
    currentView: state.currentView,
    currentPath: pathSnap,
    currentDate: state.currentDate,
    page: state.page,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    searchQuery: state.searchQuery,
    mediaFilter: state.mediaFilter,
    scrollTop: st,
  };
}

function applyBrowseTabMemory(tabKey) {
  if (tabKey !== 'folders' && tabKey !== 'dates') return;
  ensureBrowseCaches();
  var m = state.browseCaches[tabKey].tabMemory;
  if (!m) return;
  state.currentView = m.currentView || 'all';
  state.currentPath =
    m.currentPath != null && String(m.currentPath).length
      ? sidebarTree.normalizePath(m.currentPath)
      : '';
  state.currentDate = m.currentDate != null ? m.currentDate : '';
  state.page = m.page > 0 ? m.page : 1;
  if (m.sortBy) state.sortBy = m.sortBy;
  if (m.sortOrder) state.sortOrder = m.sortOrder;
  state.searchQuery = m.searchQuery != null ? String(m.searchQuery) : '';
  state.mediaFilter = m.mediaFilter || state.mediaFilter;
  if (dom.sortSelect) dom.sortSelect.value = state.sortBy + '|' + state.sortOrder;
  if (dom.mediaFilterSelect) dom.mediaFilterSelect.value = state.mediaFilter;
  state._pendingBrowseScrollTop = typeof m.scrollTop === 'number' ? m.scrollTop : null;
}

/**
 * 按范围失效会话缓存。不传 partial 时清空目录+日期+重复项（全量）。
 * @param {{ folders?: boolean, dates?: boolean, duplicates?: boolean }} [partial]
 */
function invalidateTabSessionCaches(partial) {
  var f;
  var d;
  var dup;
  if (!partial) {
    f = d = dup = true;
  } else {
    f = !!partial.folders;
    d = !!partial.dates;
    dup = !!partial.duplicates;
  }

  ensureBrowseCaches();
  if (f) {
    state.browseCaches.folders.tabMemory = null;
    state.browseCaches.folders.sidebarSnapshot = null;
  }
  if (d) {
    state.browseCaches.dates.tabMemory = null;
    state.browseCaches.dates.dateGroupsList = null;
    state.browseCaches.dates.dateGroupsListSort = null;
    state.browseCaches.dates.dateGroupsCacheFavAt = null;
  }
  if (!partial || f || d) {
    state._photoBrowseCacheFp = null;
    state._photoBrowseCacheResult = null;
  }
  if (!partial || f) {
    state._pendingBrowseScrollTop = null;
    state._folderTreeByRootId = null;
  }
  if (dup) {
    state._dupListGen = (state._dupListGen || 0) + 1;
    try {
      state.duplicatePhotosByHash = {};
    } catch (eDup) {}
  }
}

/**
 * 与 invalidateTabSessionCaches 同时，标记管理页返回相册需整页重载（侧栏 DOM 清空）。
 */
function markBrowseDataStale(options) {
  options = options || {};
  invalidateTabSessionCaches();
  if (options.settingsPageDirty) {
    state.mustReloadBrowseAfterSettings = true;
  }
}

function syncBrowseChromeAfterSoftSettingsReturn() {
  updateBrowsePathLabel();
  if (dom.toolbar) dom.toolbar.style.display = 'flex';
  var tp = state.previewTotalPages || 1;
  var total = state.previewTotalPhotos || 0;
  var pg = state.page || 1;
  if (state.currentView === 'folder_overview') {
    photoGridUi.renderPagination({
      dom: dom,
      result: { page: pg, totalPages: tp, total: total },
      formatNumber: formatNumber,
    });
    if (dom.pageInfo) dom.pageInfo.textContent = formatFolderCountLabel(total);
    if (dom.statsBar) dom.statsBar.textContent = formatFolderCountLabel(total);
  } else {
    photoGridUi.renderPagination({
      dom: dom,
      result: { page: pg, totalPages: tp, total: total },
      formatNumber: formatNumber,
    });
  }
  if (state.currentTab === 'folders') tabsUi.setBrowseGridControlsVisible(true);
}

// === Tab switching ===
function showTabContent(tab, opts) {
  opts = opts || {};
  // syncNavigationRail 内含页面态 class 的派生（settings / search / people-page-open），
  // 别在这里再单独同步一次：三个类必须只由一个地方写。
  syncNavigationRail(tab);
  if (aiViews) aiViews.leave();
  // 搜图 / 人物是侧栏独占视图（与「重复」同构）：文件夹树让位给各自的侧栏，
  // 主区工具栏整体收起，结果落进 #photoGrid。侧栏内容由 aiViews 渲染。
  if ((tab === 'search' || tab === 'people') && aiViews) {
    bumpSidebarViewToken();
    state.prevTab = tab;
    state.currentTab = tab;
    state.currentView = tab === 'search' ? 'ai_search' : 'people';
    state.sidebarLockedMode = '';
    sidebarUi.closeMobileSidebar();
    tabsUi.prepareBrowsingShell({
      dom: dom,
      currentView: state.currentView,
      isWelcomeHomeVisible: isWelcomeHomeVisible(),
    });
    // 主区工具栏 / 分页 / 缩放控件在这两页整体让位（搜索框与人物列表都搬到了侧栏）。
    tabsUi.applyCollectionView({
      dom: dom,
      onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
      onUpdateBrowsePathLabel: updateBrowsePathLabel,
    });
    aiViews.enter(state.currentView);
    aiViews.startPolling();
    void loadPhotos();
    return;
  }
  // 离开智能视图：把视图态收回到浏览态，后面的分支（含 softFromSettings 软返回）才不会
  // 拿着 ai_search / people 去按浏览逻辑算路径标签。
  if (state.currentView === 'ai_search' || state.currentView === 'people') {
    state.currentView = 'all';
    state.currentPhotos = [];
  }
  var fromTab = opts.fromTab;
  if (opts.softFromSettings === true) {
    if (tab === 'folders' || tab === 'dates') {
      state.prevTab = tab;
      sidebarUi.ensureNormalSidebarVisible(dom);
      tabsUi.prepareBrowsingShell({
        dom: dom,
        currentView: state.currentView,
        isWelcomeHomeVisible: isWelcomeHomeVisible(),
      });
      syncBrowseChromeAfterSoftSettingsReturn();
      return;
    }
    if (tab === 'duplicates') {
      state.prevTab = tab;
      state.sidebarLockedMode = 'duplicates';
      state.currentView = 'duplicates';
      sidebarUi.ensureNormalSidebarVisible(dom);
      var sidebarSoftDup = document.getElementById('sidebar');
      if (sidebarUi.showSidebarOnDesktop)
        sidebarUi.showSidebarOnDesktop(sidebarSoftDup, state.isMobile);
      else if (!state.isMobile && sidebarSoftDup) sidebarSoftDup.style.display = '';
      tabsUi.prepareBrowsingShell({
        dom: dom,
        currentView: state.currentView,
        isWelcomeHomeVisible: isWelcomeHomeVisible(),
      });
      tabsUi.applyDuplicatesView({
        dom: dom,
        onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
        onUpdateBrowsePathLabel: updateBrowsePathLabel,
        onEnsureDuplicateSidebarVisible: function () {
          return sidebarUi.ensureDuplicateSidebarVisible(dom);
        },
      });
      var navDup = $$('.nav-tab');
      var ni;
      for (ni = 0; ni < navDup.length; ni++) {
        navDup[ni].classList.toggle('active', navDup[ni].dataset.tab === 'duplicates');
      }
      return;
    }
  }
  bumpSidebarViewToken();
  tabsUi.prepareBrowsingShell({
    dom: dom,
    currentView: state.currentView,
    isWelcomeHomeVisible: isWelcomeHomeVisible(),
  });

  // 离开“重复项”时解除锁定，避免 loadPhotos 把右侧强制拉回 duplicates
  if (tab !== 'duplicates' && state.sidebarLockedMode === 'duplicates') {
    state.sidebarLockedMode = '';
    if (state.currentView === 'duplicates') state.currentView = 'all';
  }

  if (fromTab && (tab === 'folders' || tab === 'dates')) {
    applyBrowseTabMemory(tab);
  }

  // 记录当前 tab
  state.prevTab = tab;

  var sidebar = document.getElementById('sidebar');
  sidebarUi.ensureNormalSidebarVisible(dom);

  tabsFlowUi.handleTabBranch({
    tab: tab,
    state: state,
    sidebar: sidebar,
    sidebarUi: sidebarUi,
    skipDeferFolderSidebar: tab === 'folders' && !!fromTab && fromTab !== 'folders',
    onLoadRootFolders: loadRootFolders,
    onLoadDateGroups: loadDateGroups,
    onApplyDuplicatesView: function () {
      tabsUi.applyDuplicatesView({
        dom: dom,
        onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
        onUpdateBrowsePathLabel: updateBrowsePathLabel,
        onEnsureDuplicateSidebarVisible: function () {
          return sidebarUi.ensureDuplicateSidebarVisible(dom);
        },
      });
    },
    onRenderDuplicatePageShell: renderDuplicatePageShell,
    onRenderDuplicateSidebar: renderDuplicateSidebar,
    onLoadDuplicateGroups: loadDuplicateGroups,
  });

  // 切 tab 时右侧也要跟着刷新：folders 默认显示“所有照片”，dates 默认显示“所有日期”
  // （否则只切了侧栏，右侧仍停留在旧内容，必须再点 sidebar 才会触发 loadPhotos）
  if (tab === 'folders') {
    if (state.suppressAutoLoadOnce) {
      state.suppressAutoLoadOnce = false;
      return;
    }
    if (state.currentView !== 'folder' && state.currentView !== 'folder_overview') {
      state.currentView = 'all';
      state.currentPath = '';
      state.currentDate = '';
      state.page = 1;
    }
    scheduleBrowseReload(function () {
      void loadPhotos();
    });
  } else if (tab === 'dates') {
    if (state.suppressAutoLoadOnce) {
      state.suppressAutoLoadOnce = false;
      return;
    }
    if (state.currentView === 'folder' || state.currentView === 'folder_overview') {
      state.currentView = 'all';
      state.currentPath = '';
      state.currentDate = '';
      state.page = 1;
    }
    scheduleBrowseReload(function () {
      void loadPhotos();
    });
  }
}

// 打开管理页面（从 topbar 按钮触发）
async function openSettingsPage() {
  if (state.currentTab === 'settings') return;
  syncNavigationRail('settings');
  await settingsFlow.openSettingsPage({
    state: state,
    dom: dom,
    sidebarUi: sidebarUi,
    onBumpSidebarViewToken: bumpSidebarViewToken,
    onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
    onLoadRootFolders: loadRootFolders,
    onLoadSettingsUI: loadSettingsUI,
    onStartSettingsHydrateRetryIfNeeded: startSettingsHydrateRetryIfNeeded,
    onRestoreSettingsPageSectionScroll: restoreSettingsPageSectionScroll,
  });
  // 上面这个 await 期间可能有后台回调把页面切走（扫描完成、启动落地、AI 视图退出）：
  // 页面态 class 是派生的，回到这里按 state.currentTab 再对齐一次，
  // 否则设置导航会以「孤儿 class」的形式永久盖在搜图 / 人物侧栏上。
  syncPageOpenClasses(state.currentTab);
  if (state.currentTab !== 'settings') {
    // 被切走了就把设置页也收干净：只摘 class 不收起面板，会留下
    // 「右栏还是设置页、左栏已经是别的侧栏」的半截界面。
    if (dom.settingsPage) dom.settingsPage.style.display = 'none';
    if (dom.contentArea) dom.contentArea.style.display = '';
    return;
  }
  if (window.peopleSettings) window.peopleSettings.show();
  if (window.semanticSettings) window.semanticSettings.show();
  renderSettingsNav(getLastSettingsSectionId());
  startSettingsFolderListPolling();
}

function syncNavigationRail(tab) {
  document.querySelectorAll('.app-rail button').forEach(function (item) {
    var active = (item.dataset.tab || 'settings') === tab;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  var heading = document.getElementById('navigationHeading');
  if (heading) {
    var key = 'nav.' + tab;
    heading.setAttribute('data-i18n', key);
    heading.textContent = tUi(key, tab);
  }
  var people = document.getElementById('peopleSidebar');
  var search = document.getElementById('searchSidebar');
  var settings = document.getElementById('settingsSidebar');
  if (people) people.hidden = tab !== 'people';
  if (search) search.hidden = tab !== 'search';
  if (settings) settings.hidden = tab !== 'settings';
  // 页面态 class 与上面三个 hidden 标志同源：都只由「当前 tab」决定。
  // 放在这里而不是各调用点，是为了让任何切页路径都自动对齐（见 syncPageOpenClasses 注释）。
  syncPageOpenClasses(tab);
}

// 从管理页面返回照片浏览
function closeSettingsPage() {
  if (window.peopleSettings) window.peopleSettings.hide();
  if (window.semanticSettings) window.semanticSettings.hide();
  stopSettingsFolderListPolling();
  settingsFlow.closeSettingsPage({
    state: state,
    dom: dom,
    sidebarUi: sidebarUi,
    onStopSettingsHydrateRetry: stopSettingsHydrateRetry,
    onStopThumbnailBackfillPolling: stopThumbnailBackfillPolling,
    onShowTabContent: function (t, o) {
      showTabContent(t, o);
    },
  });
  // 派生对齐：正常路径上 onShowTabContent → showTabContent → syncNavigationRail 已经
  // 把页面态类对齐了；这里兜一次「调用方没给 onShowTabContent」的情况，避免留下孤儿 class。
  syncPageOpenClasses(state.currentTab);
}

function startSettingsHydrateRetryIfNeeded() {
  settingsFlow.startSettingsHydrateRetryIfNeeded({
    state: state,
    onStopSettingsHydrateRetry: stopSettingsHydrateRetry,
    onEnsureSettingsFolderListHydrated: ensureSettingsFolderListHydrated,
  });
}

function stopSettingsHydrateRetry() {
  settingsFlow.stopSettingsHydrateRetry({ state: state });
}

// === Add folder ===
async function handleAddFolder() {
  var folderPath = await api.selectFolder();
  if (!folderPath) return;
  scanFlow.doScanFolder({
    state: state,
    dom: dom,
    api: api,
    folderPath: folderPath,
    onUpdateProgress: function (c, t, f) {
      updateProgress(c, t, f);
    },
    onLoadStats: loadStats,
    onLoadRootFolders: loadRootFolders,
    onRenderSettingsFolderList: renderSettingsFolderList,
    onRenderDuplicateSidebar: renderDuplicateSidebar,
    onLoadDuplicateGroups: loadDuplicateGroups,
    onLoadPhotos: loadPhotos,
    onAlert: appAlert,
    onTickBackgroundTasksOnce: tickBackgroundTasksOnce,
    onMarkBrowseDataStale: markBrowseDataStale,
  });
}

function handleCancelScan() {
  scanFlow.handleCancelScan({
    state: state,
    api: api,
  });
}

async function handlePauseResumeScan() {
  return scanFlow.handlePauseResumeScan({
    state: state,
    api: api,
  });
}

function updateProgress(current, total, file) {
  scanFlow.updateProgress({
    state: state,
    dom: dom,
    formatNumber: formatNumber,
    current: current,
    total: total,
    file: file,
  });
}

function stopScanLiveRefresh() {
  if (state.scanLiveRefreshTimer) {
    clearInterval(state.scanLiveRefreshTimer);
    state.scanLiveRefreshTimer = null;
  }
  state.scanLiveRefreshRunning = false;
}

function startScanLiveRefresh() {
  if (state.scanLiveRefreshTimer) return;
  state.scanLiveRefreshTimer = setInterval(async function () {
    if (!state.isScanning) {
      stopScanLiveRefresh();
      return;
    }
    if (state.scanLiveRefreshRunning) return;
    state.scanLiveRefreshRunning = true;
    try {
      await loadStats();
      // 扫描中勿整栏预取子目录树 + renderFolderTree（大库每 3s 一次会严重卡顿），只拉根目录行并补丁侧栏数字
      await loadRootFolders(true, true);
      patchSidebarFolderTreeCountsFromState();
      if (state.currentTab === 'settings') {
        await renderSettingsFolderList();
      }
    } catch (e) {
      // 实时刷新失败不影响扫描主流程
    } finally {
      state.scanLiveRefreshRunning = false;
    }
  }, 3000);
}

var rootFoldersLoadInFlight = null;
var rootFoldersLoadInFlightMediaFilter = 'all';
/** 最近一次成功 getRootFolders 的媒体筛选，用于合并窗口判断 */
var rootFoldersLastSuccessMediaFilter = 'all';
/** 在此时间戳之前、且筛选一致时跳过重复 IPC（启动 init 与 showTabContent 连续两次拉根目录等） */
var rootFoldersSkipNetworkUntil = 0;
var ROOT_FOLDERS_FETCH_COALESCE_MS = 450;

function normalizeRootFolderRows(rows) {
  if (Array.isArray(rows)) return rows;
  if (rows && typeof rows === 'object') return Object.values(rows);
  return [];
}

/**
 * @param {{ force?: boolean }} [options] force 为 true 时始终走网络（例如用户明确刷新）
 */
async function fetchRootFoldersSafe(options) {
  options = options || {};
  var force = options.force === true;
  var mediaFilter = normalizeMediaFilter(state.mediaFilter);
  if (
    !force &&
    !state.rootFoldersStatsPending &&
    Date.now() < rootFoldersSkipNetworkUntil &&
    rootFoldersLastSuccessMediaFilter === mediaFilter &&
    Array.isArray(state.rootFolders)
  ) {
    return Promise.resolve(state.rootFolders);
  }
  if (rootFoldersLoadInFlight && rootFoldersLoadInFlightMediaFilter === mediaFilter) {
    return rootFoldersLoadInFlight;
  }

  rootFoldersLoadInFlightMediaFilter = mediaFilter;
  var rootFoldersPromise = api.getRootFolders(
    mediaFilter !== 'all' ? { mediaType: mediaFilter } : {},
  );
  rootFoldersLoadInFlight = rootFoldersPromise
    .then(function (rows) {
      var normalized = normalizeRootFolderRows(rows);
      state.rootFolders = normalized;
      state.rootFoldersStatsPending = false;
      rootFoldersLastSuccessMediaFilter = mediaFilter;
      rootFoldersSkipNetworkUntil = Date.now() + ROOT_FOLDERS_FETCH_COALESCE_MS;
      return normalized;
    })
    .catch(function () {
      if (!Array.isArray(state.rootFolders)) state.rootFolders = [];
      state.rootFoldersStatsPending = false;
      return state.rootFolders;
    })
    .finally(function () {
      rootFoldersLoadInFlight = null;
    });

  return rootFoldersLoadInFlight;
}

// === Stats ===
async function loadStats() {
  var stats = await api.getStats();
  state.stats = stats || {};
  if (stats.totalPhotos > 0) {
    if (dom.statsBar) dom.statsBar.textContent = formatGlobalStatsBarText(stats, state.mediaFilter);
  } else {
    if (dom.statsBar) dom.statsBar.textContent = '';
  }
  updateFavoriteCountInSidebar();
}

function updateFavoriteCountInSidebar() {
  var n = state.stats && state.stats.favoritePhotos != null ? state.stats.favoritePhotos : 0;
  document.querySelectorAll('[data-sidebar-favorites] .count').forEach(function (el) {
    el.textContent = formatNumber(n);
  });
}

/**
 * 在已跳过 renderFolderTree 时，仅同步侧栏「所有照片 / 所有目录 / 各根目录」上的数量文案，避免扫描中整树重绘。
 */
function patchSidebarFolderTreeCountsFromState() {
  if (!isFolderSidebarTab(state.currentTab)) return;
  if (state.rootFoldersStatsPending) return;
  if (!dom.sidebarContent) return;
  var roots = Array.isArray(state.rootFolders) ? state.rootFolders : [];
  var total = 0;
  var folderOverviewCount = 0;
  var r;
  for (var i = 0; i < roots.length; i++) {
    r = roots[i];
    total += Number(r && r.photo_count != null ? r.photo_count : 0);
    folderOverviewCount += Number(r && r.folder_count != null ? r.folder_count : 0);
  }
  var allEl = dom.sidebarContent.querySelector('[data-sidebar-all="1"] .count');
  if (allEl) allEl.textContent = formatNumber(total);
  var foEl = dom.sidebarContent.querySelector('[data-sidebar-folder-overview="1"] .count');
  if (foEl) foEl.textContent = formatNumber(folderOverviewCount);
  for (var j = 0; j < roots.length; j++) {
    r = roots[j];
    if (!r || r.id == null) continue;
    var cntEl = dom.sidebarContent.querySelector(
      '.folder-item.tree-parent[data-root-id="' + String(r.id) + '"] .count',
    );
    if (cntEl) cntEl.textContent = formatNumber(r.photo_count != null ? r.photo_count : 0);
  }
}

// === Sidebar: Folders ===
/**
 * @param {boolean} silentRefresh 已有根目录时不再整栏替换为「正在加载」，减少闪烁与卡顿
 * @param {boolean} [skipSidebarTree] 为 true 时只拉取根目录数据，不预取子目录树、不渲染侧栏（管理页打开时侧栏隐藏，大库可显著避免卡死）
 */
async function loadRootFolders(silentRefresh, skipSidebarTree) {
  ensureBrowseCaches();
  var gate = createSidebarRequestGate('folders', 'loadRootFolders');
  var footer = document.getElementById('sidebarTreeLoadingFooter');
  if (footer && gate.isAlive()) {
    footer.style.display = 'none';
    footer.innerHTML = '';
  }
  var silent = !!silentRefresh && Array.isArray(state.rootFolders) && state.rootFolders.length > 0;
  var skipTree = !!skipSidebarTree;
  var snap = state.browseCaches.folders.sidebarSnapshot;
  var snapReady =
    snap &&
    snap.html &&
    snap.fp === folderSidebarSnapshotFingerprint() &&
    gate.isAlive() &&
    isFolderSidebarTab(state.currentTab);
  if (snapReady) {
    gate.render(snap.html);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (isFolderSidebarTab(state.currentTab)) {
          syncFolderSidebarHighlight();
          sidebarTree.scheduleExpandActiveFolder({
            state: state,
            onExpandTreeToFolder: function (targetPath) {
              return sidebarTree.expandTreeToFolder(targetPath);
            },
          });
        }
      });
    });
  }
  var sidebarHasContent =
    dom.sidebarContent &&
    dom.sidebarContent.querySelector('.folder-item, .tree-root, [data-sidebar-all]');
  if ((!silent || !sidebarHasContent) && !snapReady && gate.isAlive()) {
    gate.render(
      '<div class="sidebar-list-loading">' +
        '<div class="content-loading-spinner" aria-hidden="true"></div>' +
        '<span>' +
        escapeHtml(tUi('sidebar.loadingFolders', '正在加载目录…')) +
        '</span>' +
        '</div>',
    );
  }
  try {
    if (skipTree) {
      var liteList;
      try {
        liteList = normalizeRootFolderRows(await api.getRootFolders({ lite: true }));
      } catch (eLite) {
        liteList = [];
      }
      if (liteList.length > 0) {
        state.rootFolders = liteList;
        // 管理页目录表已不展示数量/体积，无需再拉 photos 聚合；返回相册后由侧栏 loadRootFolders 补全
        state.rootFoldersStatsPending = state.currentTab === 'settings' ? false : true;
        if (state.currentTab === 'settings') {
          await renderSettingsFolderList({ skipFetch: true });
        }
        if (gate.isAlive() && skipTree) {
          gate.render('');
        }
        if (state.currentTab !== 'settings') {
          fetchRootFoldersSafe({ force: true })
            .then(function () {
              scheduleBrowseReload(function () {
                if (isFolderSidebarTab(state.currentTab)) {
                  patchSidebarFolderTreeCountsFromState();
                }
              });
            })
            .catch(function () {});
        }
        return;
      }
    }
    await fetchRootFoldersSafe();
    if (!gate.isAlive()) return;
    if (skipTree || state.currentTab === 'settings') {
      return;
    }
    var prefetched = await sidebarTree.prefetchFolderTreeMap({
      rootFolders: state.rootFolders,
      getFolderTree: function (rootId) {
        var mediaFilter = normalizeMediaFilter(state.mediaFilter);
        return api.getFolderTree(rootId, mediaFilter !== 'all' ? { mediaType: mediaFilter } : {});
      },
    });
    state._folderTreeByRootId = prefetched && typeof prefetched === 'object' ? prefetched : {};
    if (!gate.isAlive()) return;
    await new Promise(function (resolve) {
      requestAnimationFrame(function () {
        resolve();
      });
    });
    if (
      typeof sidebarTree.folderTreeNeedsProgressiveRender === 'function' &&
      sidebarTree.folderTreeNeedsProgressiveRender(prefetched, state.rootFolders)
    ) {
      await sidebarTree.renderFolderTreeProgressive({
        state: state,
        prefetchedByRootId: prefetched,
        gate: gate,
        sidebarContent: dom.sidebarContent,
        formatNumber: formatNumber,
        escapeAttr: escapeAttr,
        escapeHtml: escapeHtml,
      });
    } else {
      sidebarTree.renderFolderTree({
        state: state,
        prefetchedByRootId: prefetched,
        gate: gate,
        sidebarContent: dom.sidebarContent,
        formatNumber: formatNumber,
        escapeAttr: escapeAttr,
        escapeHtml: escapeHtml,
      });
    }
    sidebarTree.scheduleExpandActiveFolder({
      state: state,
      onExpandTreeToFolder: function (targetPath) {
        return sidebarTree.expandTreeToFolder(targetPath);
      },
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (isFolderSidebarTab(state.currentTab)) syncFolderSidebarHighlight();
      });
    });
  } catch (e) {
    Logger.error(e);
    if (gate.isAlive()) {
      gate.render(
        '<div class="sidebar-list-loading sidebar-list-loading--err">' +
          '<p style="margin:0;font-weight:600;">' +
          escapeHtml(tUi('sidebar.loadFoldersFail', '目录加载失败')) +
          '</p>' +
          '<p style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">' +
          escapeHtml(tUi('sidebar.retryLater', '请稍后重试')) +
          '</p></div>',
      );
    }
  }
}

// === Sidebar: Dates ===
function buildDateGroupsSidebarHtml(groups) {
  if (!Array.isArray(groups)) groups = [];
  var html = '';

  if (groups.length === 0) {
    html =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">' +
      escapeHtml(tUi('sidebar.datesEmpty', '暂无数据')) +
      '</div>';
  } else {
    var total = 0;
    var i;
    for (i = 0; i < groups.length; i++) total += groups[i].count;
    html +=
      '<div class="date-sidebar-sort" role="toolbar" aria-label="' +
      escapeAttr(tUi('sidebar.dateSortToolbarAria', '日期排序')) +
      '">' +
      '<button type="button" class="date-sort-btn' +
      (state.dateGroupsSortOrder === 'desc' ? ' active' : '') +
      '" data-date-sort="desc" title="' +
      escapeAttr(tUi('sidebar.dateSortDescTitle', '最新日期在前')) +
      '">' +
      escapeHtml(tUi('sidebar.dateSortDesc', '新→旧')) +
      '</button>' +
      '<button type="button" class="date-sort-btn' +
      (state.dateGroupsSortOrder === 'asc' ? ' active' : '') +
      '" data-date-sort="asc" title="' +
      escapeAttr(tUi('sidebar.dateSortAscTitle', '最早日期在前')) +
      '">' +
      escapeHtml(tUi('sidebar.dateSortAsc', '旧→新')) +
      '</button>' +
      '</div>';
    html +=
      '<div class="folder-item ' +
      (state.currentView === 'all' ? 'active' : '') +
      '" data-sidebar-dates-all="1" data-sidebar-view="dates-all">' +
      '<span class="icon">\u{1F5BC}\uFE0F</span>' +
      '<span class="name">' +
      escapeHtml(tUi('sidebar.allDates', '所有日期')) +
      '</span>' +
      '<span class="count">' +
      formatNumber(total) +
      '</span></div>';
    var favCountDates =
      state.stats && state.stats.favoritePhotos != null ? state.stats.favoritePhotos : 0;
    html +=
      '<div class="folder-item ' +
      (state.currentView === 'favorites' ? 'active' : '') +
      '" data-sidebar-favorites="1" data-sidebar-view="favorites">' +
      '<span class="icon">\u2B50</span>' +
      '<span class="name">' +
      escapeHtml(tUi('sidebar.favorites', '收藏')) +
      '</span>' +
      '<span class="count">' +
      formatNumber(favCountDates) +
      '</span>' +
      '</div>';

    var lastYear = '';
    var j;
    for (j = 0; j < groups.length; j++) {
      var g = groups[j];
      var year = g.date.substring(0, 4);
      if (year !== lastYear) {
        html +=
          '<div class="date-year">' +
          year +
          escapeHtml(tUi('sidebar.yearSuffix', ' 年')) +
          '</div>';
        lastYear = year;
      }
      var displayDate = formatDateLabel(g.date);
      var weekday = getWeekday(g.date);
      var isActive = state.currentView === 'date' && state.currentDate === g.date;
      html +=
        '<div class="date-group ' +
        (isActive ? 'active' : '') +
        '" data-date="' +
        escapeAttr(g.date) +
        '" data-sidebar-view="date">' +
        '<span class="date-label">' +
        displayDate +
        ' <span style="color:var(--text-muted)">' +
        weekday +
        '</span></span>' +
        '<span class="date-count">' +
        formatNumber(g.count) +
        '</span></div>';
    }
  }

  return html;
}

async function loadDateGroups() {
  var gate = createSidebarRequestGate('dates', 'loadDateGroups');
  ensureBrowseCaches();
  var dc = state.browseCaches.dates;
  var favNow =
    state.stats && state.stats.favoritePhotos != null ? state.stats.favoritePhotos : null;
  if (
    dc.dateGroupsList &&
    dc.dateGroupsListSort === state.dateGroupsSortOrder &&
    Array.isArray(dc.dateGroupsList) &&
    dc.dateGroupsCacheFavAt === favNow
  ) {
    if (gate.isAlive()) gate.render(buildDateGroupsSidebarHtml(dc.dateGroupsList));
    return;
  }
  if (gate.isAlive()) {
    gate.render(
      '<div class="sidebar-list-loading">' +
        '<div class="content-loading-spinner" aria-hidden="true"></div>' +
        '<span>' +
        escapeHtml(tUi('sidebar.loadingDates', '正在加载日期分组…')) +
        '</span>' +
        '</div>',
    );
  }
  var groups;
  try {
    groups = await api.getDateGroups({ sortOrder: state.dateGroupsSortOrder });
  } catch (e) {
    Logger.error(e);
    if (gate.isAlive()) {
      gate.render(
        '<div class="sidebar-list-loading sidebar-list-loading--err">' +
          '<p style="margin:0;font-weight:600;">' +
          escapeHtml(tUi('sidebar.loadDatesFail', '日期列表加载失败')) +
          '</p></div>',
      );
    }
    return;
  }
  if (!gate.isAlive()) return;
  if (!Array.isArray(groups)) groups = [];
  dc.dateGroupsList = groups.slice();
  dc.dateGroupsListSort = state.dateGroupsSortOrder;
  dc.dateGroupsCacheFavAt = favNow;
  if (gate.isAlive()) gate.render(buildDateGroupsSidebarHtml(groups));
}

// === Views ===
/**
 * 从搜图 / 人物退回普通浏览：点侧栏的文件夹 / 日期 / 全部照片时走的是各自入口，
 * 不经过 showTabContent，所以在这里把标签与导轨收回浏览项，并让适配层摘掉 AI 工具栏。
 */
function leaveAiViewForBrowse(tab) {
  if (!aiViews || !aiViews.isShowing()) return;
  state.currentTab = tab;
  // syncNavigationRail 顺带把三个 page-open 类对齐到 tab（含 settings-page-open 的摘除）
  syncNavigationRail(tab);
  aiViews.leave();
}

function viewAllPhotos() {
  leaveAiViewForBrowse('folders');
  state.currentView = 'all';
  state.page = 1;
  updateSidebarActive();
  loadPhotos();
}

function viewFavorites() {
  leaveAiViewForBrowse('folders');
  state.currentView = 'favorites';
  state.page = 1;
  updateSidebarActive();
  if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) {
    state.previewPhotos = [];
    state.previewPageStart = 1;
    state.previewLoadingPage = 0;
  }
  loadPhotos();
}

function viewDuplicates() {
  if (state.currentTab === 'settings') closeSettingsPage();
  // 这里是「离开前保存哪个页签的浏览记忆」的判定，不是文件夹树侧栏渲染判定：
  // 搜图 / 人物有各自的视图态，若把它们存进 folders 记忆，回到相册页会拿到 ai_search 视图。
  if (state.currentTab === 'folders') saveBrowseTabMemory('folders');
  else if (state.currentTab === 'dates') saveBrowseTabMemory('dates');

  state.sidebarLockedMode = 'duplicates';
  state.currentTab = 'duplicates';
  state.currentView = 'duplicates';
  updateBrowsePathLabel();
  sidebarUi.ensureDuplicateSidebarVisible(dom);
  if (dom.sidebarContent) {
    if (state.duplicateHasScanned && state.duplicateGroups && state.duplicateGroups.length) {
      dom.sidebarContent.innerHTML = '';
    } else {
      dom.sidebarContent.innerHTML =
        '<div class="folder-item active" data-sidebar-duplicates="1">' +
        '<span class="icon">\u{1F9E9}</span>' +
        '<span class="name">重复照片</span>' +
        '<span class="count">' +
        formatNumber((state.duplicateGroups || []).length) +
        '</span>' +
        '</div>' +
        '<div class="sidebar-list-loading"><div class="content-loading-spinner content-loading-spinner--sm"></div><div>正在加载重复项...</div></div>';
    }
  }
  var tabs = $$('.nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.tab === 'duplicates');
  }
  // 先把右侧立即切到重复项页面，避免被旧的普通列表回写覆盖
  renderDuplicatePageShell();
  if (dom.toolbar) dom.toolbar.style.display = 'none';
  if (dom.pagination) dom.pagination.style.display = 'none';
  tabsUi.setBrowseGridControlsVisible(false);
  showTabContent('duplicates');
  renderDuplicateSidebar();
  if (state.duplicateHasScanned) {
    loadDuplicateGroups(state.duplicateGroupsPage || 1);
  }
}

function forceSwitchToDuplicates(e) {
  if (!e) return;
  var el =
    e.target && e.target.closest
      ? e.target.closest('[data-tab="duplicates"], .folder-item[data-sidebar-duplicates]')
      : null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  viewDuplicates();
}

function viewAllFolderCovers() {
  leaveAiViewForBrowse('folders');
  state.currentView = 'folder_overview';
  state.page = 1;
  updateSidebarActive();
  loadPhotos();
}

function viewFolder(folderPath) {
  var normalized = sidebarTree.normalizePath(folderPath);
  if (state.currentView === 'folder' && state.currentPath === normalized) {
    return;
  }
  leaveAiViewForBrowse('folders');
  state.currentView = 'folder';
  state.currentPath = normalized;
  state.page = 1;
  state.sortBy = 'file_name';
  state.sortOrder = 'ASC';
  if (dom.sortSelect) dom.sortSelect.value = 'file_name|ASC';
  if (dom.photoGrid) {
    dom.photoGrid.scrollTop = 0;
  }
  updateSidebarActive();
  updateFolderNavBar();
  scheduleBrowseReload(function () {
    if (state.currentTab === 'folders' && state.currentPath) {
      sidebarTree.expandTreeToFolder(state.currentPath);
    }
    void loadPhotos();
  });
}

function viewDate(dateStr) {
  leaveAiViewForBrowse('dates');
  state.currentView = 'date';
  state.currentDate = dateStr;
  state.page = 1;
  updateSidebarActive();
  loadPhotos();
}

function tUi(key, zhFallback) {
  if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
  return zhFallback;
}

function tUiFmt(key, map, zhFallback) {
  var s = tUi(key, zhFallback);
  if (!map) return s;
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) {
      s = s.split('{' + k + '}').join(String(map[k]));
    }
  }
  return s;
}

function formatGlobalStatsBarText(stats, mediaFilter) {
  stats = stats || {};
  if (!stats.totalPhotos || stats.totalPhotos <= 0) return '';
  var mf = mediaFilter === 'image' || mediaFilter === 'video' ? mediaFilter : 'all';
  if (mf === 'image') {
    return tUiFmt(
      'stats.barImageFmt',
      {
        photos: formatNumber(stats.totalPhotos),
        totalSize: formatSize(stats.totalSize),
      },
      formatNumber(stats.totalPhotos) + ' 张图片 | ' + formatSize(stats.totalSize),
    );
  }
  if (mf === 'video') {
    return tUiFmt(
      'stats.barVideoFmt',
      {
        videos: formatNumber(stats.videoPhotos || 0),
        videoSize: formatSize(stats.videoSize || 0),
      },
      formatNumber(stats.videoPhotos || 0) + ' 条视频 | ' + formatSize(stats.videoSize || 0),
    );
  }
  return tUiFmt(
    'stats.barFullFmt',
    {
      photos: formatNumber(stats.totalPhotos),
      totalSize: formatSize(stats.totalSize),
      videos: formatNumber(stats.videoPhotos || 0),
      videoSize: formatSize(stats.videoSize || 0),
    },
    formatNumber(stats.totalPhotos) +
      ' 张照片 | ' +
      formatSize(stats.totalSize) +
      ' | 视频 ' +
      formatNumber(stats.videoPhotos || 0) +
      ' 条 | ' +
      formatSize(stats.videoSize || 0),
  );
}

function formatFolderScopedStatsBarText(scopedTotal, scopedVideoCount, subCount, mediaFilter) {
  var st = Number(scopedTotal) || 0;
  var vc = Number(scopedVideoCount) || 0;
  var sub = Number(subCount) || 0;
  var mf = mediaFilter === 'image' || mediaFilter === 'video' ? mediaFilter : 'all';
  if (st > 0) {
    if (mf === 'image') {
      return tUiFmt(
        'stats.barFolderImageFmt',
        { photos: formatNumber(st) },
        formatNumber(st) + ' 张图片',
      );
    }
    if (mf === 'video') {
      return tUiFmt(
        'stats.barFolderVideoFmt',
        { videos: formatNumber(vc) },
        formatNumber(vc) + ' 条视频',
      );
    }
    return tUiFmt(
      'stats.barFolderFmt',
      { photos: formatNumber(st), videos: formatNumber(vc) },
      formatNumber(st) + ' 张照片 | 视频 ' + formatNumber(vc) + ' 条',
    );
  }
  if (sub > 0) {
    return tUiFmt(
      'stats.folderNoDirectPhotosFmt',
      { n: formatNumber(sub) },
      '此文件夹下暂无直接照片 · ' + formatNumber(sub) + ' 个子目录（点击下方进入）',
    );
  }
  return tUi('stats.zeroPhotos', '0 张照片');
}

function formatFolderCountLabel(n) {
  var num = formatNumber(n);
  return tUiFmt('stats.folderCountFmt', { n: num }, num + ' 个目录');
}

function updateBrowsePathLabel() {
  if (!dom.currentPath) return;
  switch (state.currentView) {
    case 'duplicates':
      dom.currentPath.textContent = tUi('path.duplicates', '重复照片（哈希）');
      break;
    case 'favorites':
      dom.currentPath.textContent = state.searchQuery
        ? '\u2B50 收藏 · \u{1F50D} ' + state.searchQuery
        : '\u2B50 收藏';
      break;
    case 'search':
      dom.currentPath.textContent = '\u{1F50D} ' + state.searchQuery;
      break;
    case 'folder_overview':
      dom.currentPath.textContent = tUi('path.folderOverview', '\u{1F5C2}\uFE0F 所有目录');
      break;
    case 'folder': {
      var name = (state.currentPath || '').split(/[\\/]/).pop() || '';
      dom.currentPath.textContent = '\u{1F4C1} ' + name;
      break;
    }
    case 'date':
      dom.currentPath.textContent = '\u{1F4C5} ' + formatDateLabel(state.currentDate);
      break;
    case 'ai_search':
      dom.currentPath.textContent =
        '\u{1F50D} ' + (state.aiSearchQuery || tUi('nav.search', '搜图'));
      break;
    case 'people':
      dom.currentPath.textContent =
        '\u{1F465} ' + (state.aiPeopleLabel || tUi('nav.allPeople', '全部人物'));
      break;
    default:
      dom.currentPath.textContent = tUi('path.allPhotos', '所有照片');
  }
}

function updateSidebarActive() {
  if (state.currentTab === 'settings') renderSettingsNav(getLastSettingsSectionId());
  else if (state.currentTab === 'duplicates') renderDuplicateSidebar();
  else if (isFolderSidebarTab(state.currentTab)) syncFolderSidebarHighlight();
  else syncDateSidebarHighlight();
}

/** 仅更新目录树高亮，不重建侧栏，避免滚动条跳回顶部 */
function syncFolderSidebarHighlight() {
  var sc = dom.sidebarContent;
  if (!sc) return;
  var path = state.currentPath ? sidebarTree.normalizePath(state.currentPath) : '';
  var prevAct = sc.querySelectorAll('.folder-item.active, .tree-parent.active');
  for (var i = 0; i < prevAct.length; i++) {
    prevAct[i].classList.remove('active');
  }
  if (state.currentView === 'favorites') {
    var favEl = sc.querySelector('[data-sidebar-favorites]');
    if (favEl) favEl.classList.add('active');
    return;
  }
  if (state.currentView === 'all') {
    var allEl = sc.querySelector('[data-sidebar-all]');
    if (allEl) allEl.classList.add('active');
    return;
  }
  if (state.currentView === 'folder_overview') {
    var foEl = sc.querySelector('[data-sidebar-folder-overview]');
    if (foEl) foEl.classList.add('active');
    return;
  }
  if (state.currentView !== 'folder' || !path) return;
  var hit =
    typeof sidebarTree.findFolderSidebarItemEl === 'function'
      ? sidebarTree.findFolderSidebarItemEl(path)
      : null;
  if (hit) hit.classList.add('active');
}

function updateFolderNavBar() {
  var bar = dom.folderNavBar;
  var btn = dom.folderNavUp;
  if (!bar || !btn) return;
  if (state.currentView !== 'folder' || !state.currentPath) {
    bar.style.display = 'none';
    return;
  }
  var path = sidebarTree.normalizePath(state.currentPath);
  var lastSep = path.lastIndexOf('\\');
  var parentPath = '';
  if (lastSep > 0) {
    parentPath = path.substring(0, lastSep);
  }
  var isRoot = false;
  if (Array.isArray(state.rootFolders)) {
    for (var i = 0; i < state.rootFolders.length; i++) {
      if (sidebarTree.normalizePath(state.rootFolders[i].path) === path) {
        isRoot = true;
        break;
      }
    }
  }
  if (isRoot || !parentPath) {
    bar.style.display = 'none';
    return;
  }
  var label = btn.querySelector('span');
  var name = parentPath;
  var nameSep = parentPath.lastIndexOf('\\');
  if (nameSep >= 0) name = parentPath.substring(nameSep + 1);
  if (label) label.textContent = name || '返回上级';
  btn.setAttribute('data-parent-path', parentPath);
  bar.style.display = '';
}

function syncDateSidebarHighlight() {
  var sc = dom.sidebarContent;
  if (!sc) return;
  var blocks = sc.querySelectorAll('.date-group, .folder-item[data-sidebar-dates-all]');
  for (var i = 0; i < blocks.length; i++) {
    blocks[i].classList.remove('active');
  }
  if (state.currentView === 'favorites') {
    var favD = sc.querySelector('[data-sidebar-favorites]');
    if (favD) favD.classList.add('active');
    return;
  }
  if (state.currentView === 'all') {
    var top = sc.querySelector('[data-sidebar-dates-all]');
    if (top) top.classList.add('active');
    return;
  }
  if (state.currentView !== 'date' || !state.currentDate) return;
  var groups = sc.querySelectorAll('.date-group[data-date]');
  for (var j = 0; j < groups.length; j++) {
    if (groups[j].getAttribute('data-date') === state.currentDate) {
      groups[j].classList.add('active');
      return;
    }
  }
}

// === Settings sidebar navigation ===
function renderSettingsNav(activeId) {
  if (state.currentTab !== 'settings') return;
  if (!dom.settingsPage || dom.settingsPage.style.display === 'none') return;
  return settingsUi.renderSettingsNav(normalizeSettingsSectionId(activeId), { dom: dom });
}

function scrollToSettingsSection(sectionId) {
  return settingsUi.scrollToSettingsSection(sectionId, {
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
  });
}

// === Settings: Folder management page ===
/** 目录列表内容指纹：数据未变则跳过重绘，减轻 hydrate 轮询与重复 open 时的卡顿 */
function fingerprintSettingsFolderRows(rows) {
  if (!rows || !rows.length) return '';
  var parts = [];
  for (var i = 0; i < rows.length; i++) {
    var f = rows[i] || {};
    parts.push(String(f.path || ''));
  }
  return parts.join('\x1e');
}

async function renderSettingsFolderList(options) {
  options = options || {};
  var skipFetch = options.skipFetch === true;
  var container = document.getElementById('settingsFolderList');
  if (!container) {
    return;
  }
  var hasReal =
    !!container.querySelector('.folder-manage-table') ||
    !!container.querySelector('.settings-empty');
  if (hasReal && state._settingsFolderListFp != null) {
    var fpMem = fingerprintSettingsFolderRows(state.rootFolders);
    if (fpMem === state._settingsFolderListFp) {
      return;
    }
  }
  try {
    var folders;
    if (skipFetch) {
      folders = Array.isArray(state.rootFolders) ? state.rootFolders : [];
    } else {
      folders = normalizeRootFolderRows(await api.getRootFolders({ lite: true }));
      state.rootFolders = folders;
      state.rootFoldersStatsPending = false;
    }
    var fp = fingerprintSettingsFolderRows(folders);
    if (fp === state._settingsFolderListFp && hasReal) {
      return;
    }
    renderSettingsFolderListFromRows(folders);
  } catch (err) {
    // 出错时保留当前内容，避免把已渲染数据清空
    if (!container.querySelector('.folder-manage-row')) {
      renderSettingsFolderListFromRows(Array.isArray(state.rootFolders) ? state.rootFolders : []);
    }
  }
}

function renderSettingsFolderListFromRows(folders) {
  state._settingsFolderListFp = fingerprintSettingsFolderRows(folders);
  return settingsUi.renderSettingsFolderListFromRows(folders, {
    onRescan: handleSettingsRescan,
    onRemove: handleSettingsRemove,
  });
}

async function handleSettingsRescan(rootPath) {
  if (
    !(await appConfirm(
      '将重新遍历该根目录，仅更新有变动的文件。\n未变化记录会保留；本次未扫描到的记录会标记为失效并在界面隐藏（不会立刻删除）。\n\n' +
        '适用于：在资源管理器中调整子文件夹（移动、重命名）、大量增删照片后索引与实际不一致等情况。\n\n' +
        '提示：失效记录保留缩略图和指纹；仅在“清理失效文件记录”时才会物理删除。\n\n' +
        '\u786e\u5b9a\u7ee7\u7eed\uff1f',
    ))
  ) {
    return;
  }
  state.isScanning = true;
  state.isScanPaused = false;
  if (dom.scanProgress) dom.scanProgress.style.display = 'block';
  startScanLiveRefresh();
  var cancelBtn = document.getElementById('cancelScanBtn');
  var pauseResumeBtn = document.getElementById('pauseResumeScanBtn');
  if (cancelBtn) {
    cancelBtn.style.display = '';
    cancelBtn.textContent = '⏹ 停止';
    cancelBtn.disabled = false;
  }
  if (pauseResumeBtn) {
    pauseResumeBtn.style.display = '';
    pauseResumeBtn.disabled = false;
    pauseResumeBtn.textContent = '⏸ 暂停';
  }
  updateProgress(0, 1, '准备中...');

  api.rescanFolder(rootPath).then(async function (result) {
    state.isScanning = false;
    state.isScanPaused = false;
    stopScanLiveRefresh();
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (pauseResumeBtn) pauseResumeBtn.style.display = 'none';
    if (result && result.success) {
      markBrowseDataStale({ settingsPageDirty: true });
      await loadStats();
      await loadRootFolders(state.rootFolders.length > 0, true);
      await renderSettingsFolderList();
      var cleaned = Number(result.cleanupDeleted) || 0;
      if (cleaned > 0) {
        updateProgress(1, 1, '重扫完成，已标记失效记录 ' + cleaned + ' 条');
      }
    } else if (!result || !result.cancelled) {
      appAlert('重新扫描失败: ' + ((result && result.error) || '未知错误'));
    }
    tickBackgroundTasksOnce();
  });
  tickBackgroundTasksOnce();
}

async function handleSettingsRemove(rootPath) {
  if (
    !(await appConfirm(
      '确定要移除此目录吗？\n移除后该目录下的照片索引将被清除，照片文件不会被删除。',
    ))
  )
    return;
  await api.removeFolder(rootPath);
  markBrowseDataStale({ settingsPageDirty: true });
  await loadStats();
  await loadRootFolders(state.rootFolders.length > 0, true);
  await renderSettingsFolderList();
}

function normalizeThumbSizeQuality(sz, q) {
  return thumbSettingsUi.normalizeThumbSizeQuality(sz, q);
}

function formatThumbCurrentLine(size, quality) {
  return thumbSettingsUi.formatThumbCurrentLine(size, quality);
}

/** 根据设置对象写入 state 并刷新「当前生效」行（启动时即可显示，不依赖是否已打开管理页） */
function applyThumbAppliedStateFromSettings(s) {
  return thumbSettingsUi.applyThumbAppliedStateFromSettings(s, {
    state: state,
    normalizeThumbSizeQuality: normalizeThumbSizeQuality,
    onUpdateThumbCurrentLineDisplay: updateThumbCurrentLineDisplay,
  });
}

function updateThumbCurrentLineDisplay() {
  return thumbSettingsUi.updateThumbCurrentLineDisplay({
    state: state,
    formatThumbCurrentLine: formatThumbCurrentLine,
  });
}

function updateThumbPendingHint() {
  return thumbSettingsUi.updateThumbPendingHint({
    state: state,
    normalizeThumbSizeQuality: normalizeThumbSizeQuality,
  });
}

function normalizeHlsCacheSettings(gbValue, entriesValue) {
  var gb = parseFloat(gbValue);
  if (isNaN(gb) || gb < 0) gb = 1;
  if (gb > 20) gb = 20;
  var entries = parseInt(entriesValue, 10);
  if (isNaN(entries) || entries < 1) entries = 48;
  if (entries > 1000) entries = 1000;
  return { gb: gb, entries: entries };
}

async function applyHlsCacheSettings() {
  var gbEl = document.getElementById('settingHlsMaxCacheGb');
  var enEl = document.getElementById('settingHlsMaxCacheEntries');
  var hintEl = document.getElementById('hlsCacheSettingsHint');
  var btn = document.getElementById('hlsCacheSettingsApplyBtn');
  if (!gbEl || !enEl || !api.has('updateSettings')) return;
  var n = normalizeHlsCacheSettings(gbEl.value, enEl.value);
  if (btn) btn.disabled = true;
  try {
    var bytes = Math.round(n.gb * 1024 * 1024 * 1024);
    var r = await api.updateSettings({
      hlsMaxCacheBytes: bytes,
      hlsMaxCacheEntries: n.entries,
    });
    var savedGb = (parseInt(r.hlsMaxCacheBytes, 10) || 0) / (1024 * 1024 * 1024);
    var savedEntries = parseInt(r.hlsMaxCacheEntries, 10) || 48;
    gbEl.value = String(savedGb >= 0 ? Math.round(savedGb * 10) / 10 : n.gb);
    enEl.value = String(savedEntries >= 1 ? savedEntries : n.entries);
    if (hintEl) {
      hintEl.textContent =
        '已保存：' + gbEl.value + 'GB / ' + enEl.value + ' 目录（新会话按新阈值生效）';
    }
    saveLastSettingsSectionId('settingsSectionStorage');
    if (state.currentTab === 'settings') renderSettingsNav('settingsSectionStorage');
  } catch (e) {
    appAlert('保存 HLS 缓存设置失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function applyThumbSettings() {
  var ts = document.getElementById('settingThumbSize');
  var tq = document.getElementById('settingThumbQuality');
  var btn = document.getElementById('thumbSettingsApplyBtn');
  if (!ts || !tq || !api.has('updateSettings')) return;
  var n = normalizeThumbSizeQuality(ts.value, tq.value);
  ts.value = String(n.size);
  tq.value = String(n.quality);
  if (btn) btn.disabled = true;
  try {
    var r = await api.updateSettings({ thumbSize: n.size, thumbQuality: n.quality });
    applyThumbAppliedStateFromSettings(r);
    updateThumbPendingHint();
    saveLastSettingsSectionId('settingsSectionStorage');
    if (state.currentTab === 'settings') renderSettingsNav('settingsSectionStorage');
  } catch (e) {
    appAlert('应用缩略图设置失败：' + (e && e.message ? e.message : String(e)));
    if (state.thumbAppliedSize != null && state.thumbAppliedQuality != null) {
      ts.value = String(state.thumbAppliedSize);
      tq.value = String(state.thumbAppliedQuality);
    }
    updateThumbPendingHint();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// === 浏览偏好（排序 / 每页 / 卡片宽度）===
function setBrowseAppliedSnapshotFromObject(s) {
  if (!s) return;
  // 此前这里是另一套字面量（含 300 / 500，主进程根本不产这两个值），与设置页下拉、
  // 底栏控件各自维护一份；现在统一收到 BROWSE_PAGE_SIZE_TIERS 上。
  var ps = snapBrowsePageSize(s.browsePageSize);
  var cs = snapBrowseCardBasis(s.browseCardSize);
  var cr = normalizeBrowseCardRatio(s.browseCardRatio);
  var tc = normalizeBrowseThumbCrop(s.browseThumbCrop);
  var cl = normalizeBrowseCardLayout(s.browseCardLayout);
  var sb = s.browseSortBy || 'date_taken';
  var so = s.browseSortOrder === 'ASC' || s.browseSortOrder === 'DESC' ? s.browseSortOrder : 'DESC';
  state.videoClickBehavior = s.videoClickBehavior === 'embedded' ? 'embedded' : 'system';
  state.similarThreshold = Math.max(0, Math.min(64, parseInt(s.similarThreshold, 10) || 12));
  state.browsePrefsApplied = {
    sortBy: sb,
    sortOrder: so,
    pageSize: ps,
    cardSize: cs,
    cardRatio: cr,
    thumbCrop: tc,
    cardLayoutMode: cl,
    browseFolderIncludeSubfolders: s.browseFolderIncludeSubfolders !== false,
    videoClickBehavior: state.videoClickBehavior,
  };
}

function normalizeThumbBackfillConcurrency(v) {
  var c = parseInt(v, 10);
  if (isNaN(c) || c < 1) c = 3;
  if (c > 8) c = 8;
  return c;
}

function normalizeUiLocale(s) {
  return s === 'en' ? 'en' : 'zh-CN';
}

function setGeneralSettingsAppliedFromObject(s) {
  if (!s) return;
  state.generalSettingsApplied = {
    autoScanOnStartup: !!s.autoScanOnStartup,
    autoThumbBackfillOnStartup: !!s.autoThumbBackfillOnStartup,
    autoHashOnStartup: !!s.autoHashOnStartup,
    launchDefaultPage: normalizeLaunchDefaultPage(s.launchDefaultPage),
    themeStyle: normalizeThemeStyle(s.themeStyle),
    theme: s.theme === 'light' ? 'light' : 'dark',
    uiAccent: normalizeUiAccent(s.uiAccent),
    uiBackground: normalizeUiBackground(s.uiBackground),
    subtitleFontFamily: normalizeSubtitleFontFamily(s.subtitleFontFamily),
    subtitleFontSizePx: normalizeSubtitleFontSizePx(s.subtitleFontSizePx, s.subtitleFontSize),
    subtitleFontWeight: normalizeSubtitleFontWeight(s.subtitleFontWeight),
    subtitleColor: normalizeSubtitleColor(s.subtitleColor),
    thumbBackfillConcurrency: normalizeThumbBackfillConcurrency(s.thumbBackfillConcurrency),
    similarThreshold: Math.max(0, Math.min(64, parseInt(s.similarThreshold, 10) || 12)),
    uiLocale: normalizeUiLocale(s.uiLocale),
  };
}

function getThemeStyleControlValue() {
  var active = document.activeElement;
  if (active && active.id === 'settingThemeStyle' && active.value)
    return normalizeThemeStyle(active.value);
  if (active && active.id === 'quickThemeStyle' && active.value)
    return normalizeThemeStyle(active.value);
  var settingsEl = document.getElementById('settingThemeStyle');
  if (settingsEl && settingsEl.value) return normalizeThemeStyle(settingsEl.value);
  var quickEl = document.getElementById('quickThemeStyle');
  if (quickEl && quickEl.value) return normalizeThemeStyle(quickEl.value);
  return appearanceUi.getDefaultThemeStyleId
    ? appearanceUi.getDefaultThemeStyleId()
    : 'midnight_classic';
}

async function persistGeneralSettingsFromControls() {
  return settingsSync.persistGeneralSettingsFromControls({
    state: state,
    dom: dom,
    api: api,
    onGetThemeStyleControlValue: getThemeStyleControlValue,
    onSyncAppearanceFromSettings: syncAppearanceFromSettings,
    onSetGeneralSettingsAppliedFromObject: setGeneralSettingsAppliedFromObject,
    onSyncThemeStyleControls: function (themeStyleId) {
      return settingsSync.syncThemeStyleControls({
        themeStyleId: themeStyleId,
        onNormalizeThemeStyle: normalizeThemeStyle,
      });
    },
    onApplySubtitleStyleFromSettings: applySubtitleStyleFromSettings,
    onSyncSubtitleStyleControlsFromSettings: syncSubtitleStyleControlsFromSettings,
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
    appAlert: appAlert,
  });
}

async function persistUiLocaleFromControl(source) {
  return settingsSync.persistUiLocaleFromControl({
    state: state,
    api: api,
    onSetGeneralSettingsAppliedFromObject: setGeneralSettingsAppliedFromObject,
    onRenderSettingsNav: renderSettingsNav,
    getLastSectionId: getLastSettingsSectionId,
    appAlert: appAlert,
    source: source,
    onAfterLocaleChange: function () {
      updateBrowsePathLabel();
      syncTaskPanelCollapsedUI();
    },
  });
}

async function persistBrowsePrefsFromForm() {
  return settingsSync.persistBrowsePrefsFromForm({
    state: state,
    api: api,
    snapBrowseCardBasis: snapBrowseCardBasis,
    appAlert: appAlert,
    onApplyBrowsePreferencesFromSettings: function (s) {
      return settingsSync.applyBrowsePreferencesFromSettings({
        state: state,
        dom: dom,
        settings: s,
        snapBrowseCardBasis: snapBrowseCardBasis,
        onApplyCardSize: applyCardSize,
        onSetBrowseAppliedSnapshotFromObject: setBrowseAppliedSnapshotFromObject,
        onApplyPageSize: syncPageSizeControl,
      });
    },
    onSyncBrowsePrefsFormFromRuntimeState: function () {
      return settingsSync.syncBrowsePrefsFormFromRuntimeState({
        state: state,
      });
    },
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
    onLoadPhotos: loadPhotos,
  });
}

// === 扫描选项（已下线） ===

/** 在全库/当前视图总数中的 1-based 序号（与分页一致，非仅当前缓冲区内下标） */
function previewGlobalPositionOne(index) {
  var ps = state.pageSize > 0 ? state.pageSize : 20;
  var start = state.previewPageStart > 0 ? state.previewPageStart : 1;
  var i = typeof index === 'number' && index >= 0 ? index : 0;
  return (start - 1) * ps + i + 1;
}

/** 随机模式：在 [1, previewTotalPhotos] 内均匀随机（优先 crypto.getRandomValues） */
function refreshPreviewRandomPositionNum() {
  if (!state.slideshowRandom) {
    state.previewRandomPositionNum = 0;
    return;
  }
  var t = Number(state.previewTotalPhotos) || 0;
  if (t <= 0) {
    state.previewRandomPositionNum = 0;
    return;
  }
  var cr = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (cr && cr.getRandomValues) {
    var buf = new Uint32Array(1);
    cr.getRandomValues(buf);
    state.previewRandomPositionNum = (buf[0] % t) + 1;
  } else {
    state.previewRandomPositionNum = Math.floor(Math.random() * t) + 1;
  }
}

function togglePreviewInfoPanel() {
  var panel = dom.previewInfoPanel;
  if (!panel) return;
  var isOpen = panel.classList.contains('open');
  if (isOpen) {
    panel.classList.remove('open');
    _removePreviewInfoPanelListeners();
  } else {
    panel.classList.add('open');
    var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
    if (photo) loadPreviewInfoPanel(photo);
    setTimeout(_addPreviewInfoPanelListeners, 0);
  }
}

function _closePreviewInfoPanelOnOutside(e) {
  var panel = dom.previewInfoPanel;
  var toggle = dom.previewInfoToggle;
  if (!panel || !toggle) return;
  if (panel.contains(e.target) || toggle.contains(e.target)) return;
  panel.classList.remove('open');
  _removePreviewInfoPanelListeners();
}

function _closePreviewInfoPanelOnEsc(e) {
  if (e.key === 'Escape') {
    var panel = dom.previewInfoPanel;
    if (panel && panel.classList.contains('open')) {
      panel.classList.remove('open');
      _removePreviewInfoPanelListeners();
    }
  }
}

function _addPreviewInfoPanelListeners() {
  document.addEventListener('click', _closePreviewInfoPanelOnOutside);
  document.addEventListener('keydown', _closePreviewInfoPanelOnEsc);
}

function _removePreviewInfoPanelListeners() {
  document.removeEventListener('click', _closePreviewInfoPanelOnOutside);
  document.removeEventListener('keydown', _closePreviewInfoPanelOnEsc);
}

function escapeHtmlRenderer(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSizeRenderer(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB'];
  var i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return bytes.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
}

function loadPreviewInfoPanel(photo) {
  var contentEl = dom.previewInfoPanelContent;
  if (!contentEl) return;
  function renderSections(info) {
    var sections = [];
    function startSection(title) {
      sections.push(
        '<div class="preview-info-section"><div class="preview-info-section-title">' +
          escapeHtmlRenderer(title) +
          '</div>',
      );
    }
    function endSection() {
      sections.push('</div>');
    }
    function addToSection(label, value) {
      if (value == null || value === '' || value === 0) return;
      sections.push(
        '<div class="preview-info-row"><span class="preview-info-label">' +
          escapeHtmlRenderer(label) +
          '</span><span class="preview-info-value">' +
          escapeHtmlRenderer(String(value)) +
          '</span></div>',
      );
    }
    var hasBasic =
      info.file_name ||
      info.file_path ||
      info.file_type ||
      (info.width && info.height) ||
      info.file_size;
    if (hasBasic) {
      startSection('基本信息');
      addToSection('文件名', info.file_name);
      addToSection('路径', info.file_path);
      addToSection('类型', info.file_type);
      if (info.width != null && info.height != null && info.width > 0 && info.height > 0)
        addToSection('尺寸', info.width + ' × ' + info.height + ' px');
      if (info.file_size) addToSection('大小', formatSizeRenderer(info.file_size));
      endSection();
    }
    var hasTime = info.date_taken || info.date_modified;
    if (hasTime) {
      startSection('时间');
      addToSection(
        '拍摄时间',
        info.date_taken ? info.date_taken.replace('T', ' ').substring(0, 19) : '',
      );
      addToSection(
        '修改时间',
        info.date_modified ? info.date_modified.replace('T', ' ').substring(0, 19) : '',
      );
      endSection();
    }
    var hasParam = info.focal_length || info.aperture || info.iso_speed || info.shutter_speed;
    if (hasParam) {
      startSection('拍摄参数');
      addToSection('焦距', info.focal_length ? info.focal_length + ' mm' : '');
      addToSection('光圈', info.aperture ? 'f/' + info.aperture : '');
      addToSection('ISO', info.iso_speed);
      addToSection('快门速度', info.shutter_speed);
      endSection();
    }
    var hasDevice = info.camera_make || info.camera_model || info.lens_model;
    if (hasDevice) {
      startSection('设备');
      addToSection('相机品牌', info.camera_make);
      addToSection('相机型号', info.camera_model);
      addToSection('镜头', info.lens_model);
      endSection();
    }
    if (info.gps_latitude != null && info.gps_longitude != null) {
      startSection('位置');
      addToSection(
        'GPS',
        Number(info.gps_latitude).toFixed(6) + ', ' + Number(info.gps_longitude).toFixed(6),
      );
      endSection();
    }
    if (state.previewTotalPhotos > 0) {
      var posNum = state.slideshowRandom
        ? state.previewRandomPositionNum > 0
          ? state.previewRandomPositionNum
          : previewGlobalPositionOne(state.previewIndex)
        : previewGlobalPositionOne(state.previewIndex);
      startSection('浏览');
      addToSection('位置', posNum + ' / ' + state.previewTotalPhotos);
      endSection();
    }
    contentEl.innerHTML = sections.length
      ? sections.join('')
      : '<div class="preview-info-empty">无可用信息</div>';
  }
  function pickPhotoDim(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v != null && v > 0) return v;
    }
    return null;
  }
  var baseInfo = {
    file_name: photo.file_name || '',
    file_path: photo.file_path || '',
    file_type: photo.file_type || '',
    width: pickPhotoDim(photo, ['width', 'pixel_width', 'file_width', 'media_width']),
    height: pickPhotoDim(photo, ['height', 'pixel_height', 'file_height', 'media_height']),
    file_size: photo.file_size || 0,
    date_taken: photo.date_taken || '',
    date_modified: photo.date_modified || '',
  };
  renderSections(baseInfo);
  if (window.photoAPI && window.photoAPI.getPhotoInfo) {
    window.photoAPI
      .getPhotoInfo(photo.id)
      .then(function (apiInfo) {
        if (apiInfo) {
          var merged = {};
          for (var k in baseInfo) merged[k] = baseInfo[k];
          for (var k2 in apiInfo) merged[k2] = apiInfo[k2];
          renderSections(merged);
        }
      })
      .catch(function () {});
  }
  // 数据库无尺寸时，用 sharp 实时读取并回补
  if (
    window.photoAPI &&
    window.photoAPI.getPhotoDimensions &&
    (baseInfo.width == null || baseInfo.height == null)
  ) {
    window.photoAPI
      .getPhotoDimensions(photo.id)
      .then(function (dims) {
        if (dims && dims.width > 0 && dims.height > 0) {
          baseInfo.width = dims.width;
          baseInfo.height = dims.height;
          // 同步更新内存中的 photo 对象，避免重复读取
          photo.width = dims.width;
          photo.height = dims.height;
          renderSections(baseInfo);
        }
      })
      .catch(function () {});
  }
}

/** 主题 / 自动扫描 / 关闭按钮：与主进程一致（须在 loadSettingsUI 末尾再拉一次，避免 hydrate 期间用户已保存却被旧快照覆盖） */
function syncLiveSettingsWidgetsFromObject(s) {
  if (!s) return;
  syncAppearanceFromSettings(s);
  var autoEl = document.getElementById('settingAutoScan');
  if (autoEl) autoEl.checked = !!s.autoScanOnStartup;
  var autoThumbEl = document.getElementById('settingAutoThumbBackfillOnStartup');
  if (autoThumbEl) autoThumbEl.checked = !!s.autoThumbBackfillOnStartup;
  var autoHashEl = document.getElementById('settingAutoHashOnStartup');
  if (autoHashEl) autoHashEl.checked = !!s.autoHashOnStartup;
  var stEl = document.getElementById('settingSimilarThreshold');
  if (stEl) stEl.value = String(Math.max(0, Math.min(64, parseInt(s.similarThreshold, 10) || 12)));
  var launchDefaultEl = document.getElementById('settingLaunchDefaultPage');
  if (launchDefaultEl) launchDefaultEl.value = normalizeLaunchDefaultPage(s.launchDefaultPage);
  settingsSync.syncThemeStyleControls({
    themeStyleId: s.themeStyle,
    onNormalizeThemeStyle: normalizeThemeStyle,
  });
  syncSubtitleStyleControlsFromSettings(s);
  applySubtitleStyleFromSettings(s);
  settingsSync.syncWebPasswordUiFromSettings({
    state: state,
    settings: s,
  });
  var swc = document.getElementById('settingWindowClose');
  if (swc) {
    var wv = s.windowCloseBehavior ? s.windowCloseBehavior : 'ask';
    if (['ask', 'tray', 'quit'].indexOf(wv) < 0) wv = 'ask';
    swc.value = wv;
    state.windowCloseBehaviorApplied = wv;
  }
  var tbcEl = document.getElementById('settingThumbBackfillConcurrency');
  if (tbcEl) tbcEl.value = String(normalizeThumbBackfillConcurrency(s.thumbBackfillConcurrency));
  if (settingsSync && typeof settingsSync.setLocaleSelectValuePair === 'function') {
    settingsSync.setLocaleSelectValuePair(normalizeUiLocale(s.uiLocale));
  } else {
    var localeEl = document.getElementById('settingUiLocale');
    if (localeEl) {
      localeEl.value = normalizeUiLocale(s.uiLocale) === 'en' ? 'en' : 'zh-CN';
    }
  }

  setGeneralSettingsAppliedFromObject(s);
}

async function loadSettingsUI() {
  var s = await api.getSettings();
  // hydrate 内有 await：再读一次主进程，避免与 updateSettings 交错得到旧快照
  try {
    s = await api.getSettings();
  } catch (e) {}

  syncLiveSettingsWidgetsFromObject(s);
  applyThumbAppliedStateFromSettings(s);
  var ts = document.getElementById('settingThumbSize');
  var tq = document.getElementById('settingThumbQuality');
  var hlsGbEl = document.getElementById('settingHlsMaxCacheGb');
  var hlsEnEl = document.getElementById('settingHlsMaxCacheEntries');
  var hlsHintEl = document.getElementById('hlsCacheSettingsHint');
  if (ts && tq) {
    ts.value = String(state.thumbAppliedSize);
    tq.value = String(state.thumbAppliedQuality);
    updateThumbPendingHint();
  }
  if (hlsGbEl && hlsEnEl) {
    var gb = (parseInt(s.hlsMaxCacheBytes, 10) || 1024 * 1024 * 1024) / (1024 * 1024 * 1024);
    var en = parseInt(s.hlsMaxCacheEntries, 10) || 48;
    hlsGbEl.value = String(gb >= 0 ? Math.round(gb * 10) / 10 : 1);
    hlsEnEl.value = String(en >= 1 ? en : 48);
    if (hlsHintEl) {
      hlsHintEl.textContent = tUiFmt(
        'settings.task.hlsHintCurrentFmt',
        { gb: hlsGbEl.value, entries: hlsEnEl.value },
        '当前生效：' + hlsGbEl.value + 'GB / ' + hlsEnEl.value + ' 目录（磁盘上限 0GB 表示不限）',
      );
    }
  }

  settingsSync.syncWebPasswordUiFromSettings({
    state: state,
    settings: s,
  });

  settingsSync.applyBrowsePreferencesFromSettings({
    state: state,
    dom: dom,
    settings: s,
    snapBrowseCardBasis: snapBrowseCardBasis,
    onApplyCardSize: applyCardSize,
    onSetBrowseAppliedSnapshotFromObject: setBrowseAppliedSnapshotFromObject,
    onApplyPageSize: syncPageSizeControl,
  });
  settingsSync.syncBrowsePrefsFormFromRuntimeState({
    state: state,
  });

  // 局域网 / 隧道 / 补全与哈希状态：延后到首帧绘制后，避免拖慢管理页首屏
  requestAnimationFrame(function () {
    setTimeout(function () {
      void refreshWebServerStatus();
      void refreshTunnelStatus();
      void refreshThumbnailBackfillStatus();
      void refreshDuplicateHashStatus();
    }, 0);
  });
}

function stopThumbnailBackfillPolling() {
  return maintenanceUi.stopThumbnailBackfillPolling({ state: state });
}

async function refreshThumbnailBackfillStatus() {
  if (!(api && api.has('getThumbnailBackfillProgress')) || !dom.thumbBackfillStatus) return;
  try {
    var p = await api.getThumbnailBackfillProgress();
    var canExport = (p.failedPathsExportable | 0) > 0;
    if (dom.thumbBackfillExportFailedBtn) dom.thumbBackfillExportFailedBtn.disabled = !canExport;
    if (p.running) {
      var pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      var eta = '';
      var es = p.etaSeconds;
      if (es != null && isFinite(es) && es > 0 && typeof scanFlow.formatEtaLine === 'function') {
        var line = scanFlow.formatEtaLine(es);
        if (line) eta = tUi('settings.task.thumbEtaPrefix', '，') + line;
      }
      if (dom.thumbBackfillStatus)
        dom.thumbBackfillStatus.textContent = tUiFmt(
          'settings.task.thumbProgressRunning',
          {
            done: p.done,
            total: p.total,
            pct: pct,
            success: p.success,
            failed: p.failed,
            eta: eta,
          },
          '补全中 ' +
            p.done +
            '/' +
            p.total +
            '（' +
            pct +
            '%），成功 ' +
            p.success +
            '，失败 ' +
            p.failed +
            eta,
        );
      if (dom.thumbBackfillStartBtn) dom.thumbBackfillStartBtn.disabled = true;
      if (dom.thumbBackfillCancelBtn) dom.thumbBackfillCancelBtn.style.display = '';
      if (!state.thumbBackfillPolling) {
        state.thumbBackfillPolling = setInterval(refreshThumbnailBackfillStatus, 800);
      }
    } else {
      if (p.total > 0 || p.done > 0 || p.success > 0 || p.failed > 0) {
        var doneText = p.cancelled
          ? tUi('settings.task.thumbStopped', '已停止')
          : tUi('settings.task.thumbCompleted', '已完成');
        if (dom.thumbBackfillStatus)
          dom.thumbBackfillStatus.textContent = tUiFmt(
            'settings.task.thumbProgressDone',
            {
              doneLabel: doneText,
              total: p.total,
              success: p.success,
              failed: p.failed,
            },
            doneText + '：共 ' + p.total + '，成功 ' + p.success + '，失败 ' + p.failed,
          );
      } else {
        if (dom.thumbBackfillStatus)
          dom.thumbBackfillStatus.textContent = tUi(
            'settings.task.thumbBackfillDesc',
            '为尚无缩略图的照片后台补齐预览图',
          );
      }
      if (dom.thumbBackfillStartBtn) dom.thumbBackfillStartBtn.disabled = false;
      if (dom.thumbBackfillCancelBtn) dom.thumbBackfillCancelBtn.style.display = 'none';
      stopThumbnailBackfillPolling();
    }
  } catch (e) {
    if (dom.thumbBackfillStatus)
      dom.thumbBackfillStatus.textContent = tUi('settings.task.thumbReadError', '补全状态读取失败');
    if (dom.thumbBackfillExportFailedBtn) dom.thumbBackfillExportFailedBtn.disabled = true;
    stopThumbnailBackfillPolling();
  }
}

async function exportThumbnailBackfillFailedPaths() {
  if (!(api && api.has('exportThumbnailBackfillFailedPaths'))) return;
  var r = await api.exportThumbnailBackfillFailedPaths();
  if (!r || r.cancelled) return;
  if (!r.success) {
    if (r.empty) {
      appAlert(tUi('settings.task.thumbExportEmpty', '暂无失败记录可导出'));
      return;
    }
    appAlert(
      tUiFmt(
        'settings.task.thumbExportFail',
        { error: (r && r.error) || tUi('settings.common.unknownError', '未知错误') },
        '导出失败：' + ((r && r.error) || '未知错误'),
      ),
    );
    return;
  }
  appAlert(
    tUiFmt(
      'settings.task.thumbExportOk',
      { count: r.count || 0, path: r.path },
      '已导出 ' + (r.count || 0) + ' 条路径到：\n' + r.path,
    ),
  );
}

async function startThumbnailBackfill() {
  if (!(api && api.has('startThumbnailBackfill'))) return;
  if (dom.thumbBackfillStartBtn) dom.thumbBackfillStartBtn.disabled = true;
  try {
    var result = await api.startThumbnailBackfill();
    if (!result || !result.success) {
      appAlert(
        tUiFmt(
          'settings.task.thumbStartFail',
          { error: (result && result.error) || tUi('settings.common.unknownError', '未知错误') },
          '启动补全失败: ' + ((result && result.error) || '未知错误'),
        ),
      );
    }
  } finally {
    refreshThumbnailBackfillStatus();
  }
}

async function cancelThumbnailBackfill() {
  if (!(api && api.has('cancelThumbnailBackfill'))) return;
  await api.cancelThumbnailBackfill();
  refreshThumbnailBackfillStatus();
}

function setMaintenanceBusy(busy) {
  return maintenanceUi.setMaintenanceBusy(busy, {});
}

function setMaintenanceStatus(text) {
  return maintenanceUi.setMaintenanceStatus(text, { dom: dom });
}

async function runMaintenanceCleanup() {
  if (!(api && api.has('maintenanceCleanupMissingFiles'))) return;
  if (
    !(await appConfirm(
      tUi(
        'settings.task.maintConfirmCleanup',
        '将检查并删除数据库中指向不存在文件的记录，是否继续？',
      ),
    ))
  )
    return;
  setMaintenanceBusy(true);
  setMaintenanceStatus(tUi('settings.task.maintCleaning', '正在清理失效文件记录...'));
  try {
    var r = await api.maintenanceCleanupMissingFiles();
    if (!r || !r.success) {
      setMaintenanceStatus(
        tUiFmt(
          'settings.task.maintCleanupFail',
          { error: (r && r.error) || tUi('settings.common.unknownError', '未知错误') },
          '清理失败：' + ((r && r.error) || '未知错误'),
        ),
      );
      return;
    }
    var result = r.result || {};
    var totalDel = result.totalDeleted || result.deleted || 0;
    setMaintenanceStatus(
      tUiFmt(
        'settings.task.maintCleanupDone',
        {
          checked: result.checked || 0,
          deleted: result.deleted || 0,
          removedRoots: result.removedRoots || 0,
          deletedByMissingRoots: result.deletedByMissingRoots || 0,
          totalDeleted: totalDel,
        },
        '清理完成：检查 ' +
          (result.checked || 0) +
          ' 条，删除失效文件 ' +
          (result.deleted || 0) +
          ' 条；移除失效根目录 ' +
          (result.removedRoots || 0) +
          ' 个（级联删除 ' +
          (result.deletedByMissingRoots || 0) +
          ' 条），合计删除 ' +
          totalDel +
          ' 条',
      ),
    );
    markBrowseDataStale({ settingsPageDirty: true });
    await loadStats();
    await loadRootFolders(state.rootFolders.length > 0, state.currentTab === 'settings');
    if (state.currentTab === 'settings') await renderSettingsFolderList();
  } finally {
    setMaintenanceBusy(false);
  }
}

async function runMaintenanceRebuildThumbFlags() {
  if (!(api && api.has('maintenanceRebuildThumbnailFlags'))) return;
  setMaintenanceBusy(true);
  setMaintenanceStatus(tUi('settings.task.maintRebuildRunning', '正在重建缩略图标记...'));
  try {
    var r = await api.maintenanceRebuildThumbnailFlags();
    if (!r || !r.success) {
      setMaintenanceStatus(
        tUiFmt(
          'settings.task.maintRebuildFail',
          { error: (r && r.error) || tUi('settings.common.unknownError', '未知错误') },
          '重建失败：' + ((r && r.error) || '未知错误'),
        ),
      );
      return;
    }
    var result = r.result || {};
    setMaintenanceStatus(
      tUiFmt(
        'settings.task.maintRebuildDone',
        { missing: result.missing || 0 },
        '重建完成：仍缺失缩略图 ' + (result.missing || 0) + ' 条',
      ),
    );
  } finally {
    setMaintenanceBusy(false);
  }
}

async function runMaintenanceOptimize() {
  if (!(api && api.has('maintenanceOptimizeDatabase'))) return;
  if (
    !(await appConfirm(
      tUi('settings.task.maintOptimizeConfirm', '将执行数据库优化（可能耗时数秒），是否继续？'),
    ))
  )
    return;
  setMaintenanceBusy(true);
  setMaintenanceStatus(tUi('settings.task.maintOptimizing', '正在优化数据库...'));
  try {
    var r = await api.maintenanceOptimizeDatabase();
    if (!r || !r.success) {
      setMaintenanceStatus(
        tUiFmt(
          'settings.task.maintOptimizeFail',
          { error: (r && r.error) || tUi('settings.common.unknownError', '未知错误') },
          '优化失败：' + ((r && r.error) || '未知错误'),
        ),
      );
      return;
    }
    setMaintenanceStatus(tUi('settings.task.maintOptimizeDone', '数据库优化完成'));
  } finally {
    setMaintenanceBusy(false);
    tickBackgroundTasksOnce();
  }
}

async function runMaintenanceBackup() {
  if (!(api && api.has('backupDatabase'))) return;
  setMaintenanceBusy(true);
  setMaintenanceStatus(tUi('settings.task.maintBackupPreparing', '准备备份…'));
  try {
    var r = await api.backupDatabase();
    if (!r || r.cancelled) {
      setMaintenanceStatus(
        r && r.cancelled
          ? tUi('settings.task.maintBackupCancelled', '已取消备份')
          : tUi('settings.task.maintBackupCancelledAlt', '备份已取消'),
      );
      return;
    }
    if (!r.success) {
      setMaintenanceStatus(
        tUiFmt(
          'settings.task.maintBackupFail',
          { error: (r && r.error) || tUi('settings.common.unknownError', '未知错误') },
          '备份失败：' + ((r && r.error) || '未知错误'),
        ),
      );
      return;
    }
    setMaintenanceStatus(
      tUiFmt('settings.task.maintBackupDone', { path: r.path }, '已备份到：' + r.path),
    );
  } finally {
    setMaintenanceBusy(false);
  }
}

function stopDuplicateHashPolling() {
  return maintenanceUi.stopDuplicateHashPolling({ state: state });
}

async function refreshDuplicateHashStatus() {
  if (!(api && api.has('maintenanceGetDuplicateHashProgress')) || !dom.duplicateHashStatus) return;
  try {
    var p = await api.maintenanceGetDuplicateHashProgress();
    var running = !!(p && p.running);
    if (state._dupHashProgressRunning && !running) {
      invalidateTabSessionCaches({ duplicates: true });
    }
    state._dupHashProgressRunning = running;
    if (p.running) {
      var pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      if (dom.duplicateHashStatus)
        dom.duplicateHashStatus.textContent = tUiFmt(
          'settings.task.dupProgressRunning',
          {
            done: p.done,
            total: p.total,
            pct: pct,
            hashed: p.hashed,
            reused: p.reused,
            failed: p.failed,
          },
          '检测中 ' +
            p.done +
            '/' +
            p.total +
            '（' +
            pct +
            '%），新算哈希 ' +
            p.hashed +
            '，复用缓存 ' +
            p.reused +
            '，失败 ' +
            p.failed,
        );
      if (dom.duplicateHashStartBtn) dom.duplicateHashStartBtn.disabled = true;
      if (dom.duplicateHashCancelBtn) dom.duplicateHashCancelBtn.style.display = '';
      if (!state.duplicateHashPolling) {
        state.duplicateHashPolling = setInterval(refreshDuplicateHashStatus, 900);
      }
    } else {
      if (p.done > 0 || p.duplicateGroups > 0) {
        var dupDoneLabel = p.cancelled
          ? tUi('settings.task.thumbStopped', '已停止')
          : tUi('settings.task.thumbCompleted', '已完成');
        if (dom.duplicateHashStatus)
          dom.duplicateHashStatus.textContent = tUiFmt(
            'settings.task.dupProgressDone',
            {
              doneLabel: dupDoneLabel,
              total: p.total,
              hashed: p.hashed,
              reused: p.reused,
              failed: p.failed,
              groups: p.duplicateGroups || 0,
              photos: p.duplicatePhotos || 0,
            },
            dupDoneLabel +
              '：全量 ' +
              p.total +
              '，新算哈希 ' +
              p.hashed +
              '，复用缓存 ' +
              p.reused +
              '，失败 ' +
              p.failed +
              '；重复组 ' +
              (p.duplicateGroups || 0) +
              '，重复照片 ' +
              (p.duplicatePhotos || 0),
          );
      } else {
        if (dom.duplicateHashStatus)
          dom.duplicateHashStatus.textContent = tUi(
            'settings.task.dupIdle',
            '将按入库顺序对全部图片计算 SHA-256（未变化文件会复用已有指纹）',
          );
      }
      if (dom.duplicateHashStartBtn) dom.duplicateHashStartBtn.disabled = false;
      if (dom.duplicateHashCancelBtn) dom.duplicateHashCancelBtn.style.display = 'none';
      stopDuplicateHashPolling();
    }
  } catch (e) {
    if (dom.duplicateHashStatus)
      dom.duplicateHashStatus.textContent = tUi(
        'settings.task.dupReadError',
        '重复检测状态读取失败',
      );
    stopDuplicateHashPolling();
  }
}

async function startDuplicateHashDetection() {
  // 相似模式下 dHash 已在缩略图生成时同步计算，直接刷新列表即可
  if (state.duplicateDetectionMode === 'similar') {
    state.duplicateHasScanned = true;
    invalidateTabSessionCaches({ duplicates: true });
    if (state.currentTab === 'duplicates' || state.currentView === 'duplicates') {
      await loadDuplicateGroups(1, { forceReload: true });
    }
    return;
  }
  if (!(api && api.has('maintenanceStartDuplicateHashDetection'))) return;
  if (dom.duplicateHashStartBtn) dom.duplicateHashStartBtn.disabled = true;
  if (dom.duplicateHashStatus) {
    dom.duplicateHashStatus.textContent = tUi(
      'settings.task.dupStarting',
      '正在启动重复检测任务...',
    );
  }
  try {
    var r = await api.maintenanceStartDuplicateHashDetection();
    if (!r || !r.success) {
      if (dom.duplicateHashStatus) {
        dom.duplicateHashStatus.textContent = tUiFmt(
          'settings.task.dupStartFail',
          { error: (r && r.error) || tUi('settings.common.unknownError', '未知错误') },
          '启动失败：' + ((r && r.error) || '未知错误'),
        );
      }
    } else {
      state.duplicateHasScanned = true;
      invalidateTabSessionCaches({ duplicates: true });
      if (state.currentTab === 'duplicates' || state.currentView === 'duplicates') {
        await loadDuplicateGroups(1, { forceReload: true });
      }
    }
  } finally {
    refreshDuplicateHashStatus();
  }
}

async function cancelDuplicateHashDetection() {
  if (!(api && api.has('maintenanceCancelDuplicateHashDetection'))) return;
  await api.maintenanceCancelDuplicateHashDetection();
  refreshDuplicateHashStatus();
}

async function cancelFaceScan() {
  if (!(api && api.has('faceCancelScan'))) return;
  await api.faceCancelScan();
  tickBackgroundTasksOnce();
}

async function exportRootFoldersList() {
  if (!(api && api.has('exportRootFoldersJson'))) return;
  var r = await api.exportRootFoldersJson();
  if (!r || r.cancelled) return;
  if (!r.success) {
    appAlert('导出失败：' + ((r && r.error) || '未知错误'));
    return;
  }
  appAlert('已导出 ' + (r.count || 0) + ' 个目录到：\n' + r.path);
}

async function importRootFoldersList() {
  if (!(api && api.has('importRootFoldersJson'))) return;
  if (
    !(await appConfirm(
      '从 JSON 导入目录：将添加已存在路径的根目录并加入扫描队列；不存在的路径会跳过。\n是否继续？',
    ))
  )
    return;
  var r = await api.importRootFoldersJson();
  if (!r || r.cancelled) return;
  if (!r.success) {
    appAlert('导入失败：' + ((r && r.error) || '未知错误'));
    return;
  }
  markBrowseDataStale({ settingsPageDirty: true });
  await loadRootFolders(state.rootFolders.length > 0, state.currentTab === 'settings');
  if (state.currentTab === 'settings') await renderSettingsFolderList();
  await loadStats();
  updateFavoriteCountInSidebar();
  loadPhotos();
  appAlert(
    '完成：新增 ' + (r.added || 0) + ' 个目录，跳过不存在路径 ' + (r.skippedMissing || 0) + ' 项。',
  );
}

function copyWebUrl() {
  return webAccessUi.copyWebUrl({ state: state });
}

async function refreshTunnelStatus() {
  return webAccessUi.refreshTunnelStatus({ state: state, api: api });
}

async function refreshWebServerStatus() {
  return webAccessUi.refreshWebServerStatus({ state: state, api: api });
}

async function toggleWebServerEnabled(enabled) {
  return webAccessUi.toggleWebServerEnabled({
    api: api,
    enabled: enabled,
    appAlert: appAlert,
    onRefreshWebServerStatus: refreshWebServerStatus,
  });
}

async function toggleTunnelEnabled(enabled) {
  return webAccessUi.toggleTunnelEnabled({
    state: state,
    api: api,
    enabled: enabled,
    appAlert: appAlert,
    onRefreshTunnelStatus: refreshTunnelStatus,
  });
}

function copyTunnelUrl() {
  return webAccessUi.copyTunnelUrl();
}

function copyTunnelLog() {
  return webAccessUi.copyTunnelLog();
}

async function saveWebPassword() {
  return webAccessUi.saveWebPassword({
    state: state,
    api: api,
    settingsSync: settingsSync,
    saveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
    appAlert: appAlert,
    onRefreshTunnelStatus: refreshTunnelStatus,
    getCurrentTab: function () {
      return state.currentTab;
    },
  });
}

// === Load photos ===
function normalizeFolderCoversResult(raw) {
  if (!raw) {
    return { covers: [], total: 0, page: 1, pageSize: state.pageSize, totalPages: 1 };
  }
  if (Array.isArray(raw)) {
    return {
      covers: raw,
      total: raw.length,
      page: 1,
      pageSize: raw.length,
      totalPages: 1,
    };
  }
  var covers = raw.covers || [];
  return {
    covers: covers,
    total: raw.total != null ? Number(raw.total) : covers.length,
    page: raw.page != null ? Number(raw.page) : 1,
    pageSize: raw.pageSize != null ? Number(raw.pageSize) : state.pageSize,
    totalPages: raw.totalPages != null ? Number(raw.totalPages) : 1,
  };
}

async function fetchPhotosPage(pageNum, requestSequence) {
  var options = {
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    page: pageNum != null ? pageNum : state.page,
    pageSize: state.pageSize,
    browseRequestId: requestSequence,
  };
  // 已移除：最小宽/高/MB 筛选
  if (state.mediaFilter && state.mediaFilter !== 'all') {
    // 如果后端支持，可按此参数直接过滤；不支持则由前端兜底过滤展示
    options.mediaType = state.mediaFilter;
  }

  if (state.currentView === 'folder_overview') {
    return { photos: [], total: 0, page: 1, pageSize: state.pageSize, totalPages: 0 };
  }

  if (state.currentView === 'favorites') {
    if (state.searchQuery) {
      return await api.searchPhotos(
        state.searchQuery,
        Object.assign({}, options, { favoritesOnly: true }),
      );
    }
    return await api.getPhotos(Object.assign({}, options, { favoritesOnly: true }));
  }

  switch (state.currentView) {
    case 'search':
      return await api.searchPhotos(state.searchQuery, options);
    case 'folder':
      return await api.getFolderPhotos(
        state.currentPath,
        Object.assign({}, options, {
          includeSubfolders: state.browseFolderIncludeSubfolders !== false,
        }),
      );
    case 'date':
      return await api.getDatePhotos(state.currentDate, options);
    default:
      return await api.getPhotos(options);
  }
}

function normalizeMediaFilter(v) {
  var s = String(v || '').toLowerCase();
  if (s === 'image' || s === 'video' || s === 'all') return s;
  return 'all';
}

/** 当前浏览路径所属根目录 id（用于关联 _folderTreeByRootId） */
function rootIdForBrowseFolderPath(folderPath) {
  var norm = sidebarTree.normalizePath(folderPath || '');
  if (!norm) return null;
  var roots = state.rootFolders || [];
  var bestId = null;
  var bestLen = -1;
  for (var i = 0; i < roots.length; i++) {
    var rp = sidebarTree.normalizePath((roots[i] && roots[i].path) || '');
    if (!rp) continue;
    var nLow = norm.toLowerCase();
    var rLow = rp.toLowerCase();
    if (nLow === rLow || nLow.indexOf(rLow + '\\') === 0) {
      if (rp.length > bestLen) {
        bestLen = rp.length;
        bestId = roots[i].id;
      }
    }
  }
  return bestId != null ? bestId : null;
}

/** 从扁平 folder_path 列表聚合「直接子文件夹」及下属照片数（与侧栏树一致的数据源） */
function aggregateImmediateSubfolderSummaries(parentPath, flatRows) {
  var p = sidebarTree.normalizePath(parentPath || '').replace(/[\\/]+$/, '');
  if (!p || !Array.isArray(flatRows) || flatRows.length === 0) return [];
  var pLow = p.toLowerCase();
  var pLen = p.length;
  var byChild = {};
  for (var i = 0; i < flatRows.length; i++) {
    var fp = sidebarTree.normalizePath((flatRows[i] && flatRows[i].folder_path) || '');
    if (!fp) continue;
    var fl = fp.toLowerCase();
    if (fl === pLow) continue;
    if (fl.indexOf(pLow + '\\') !== 0) continue;
    var rel = fp.slice(pLen + 1);
    if (!rel) continue;
    var slash = rel.indexOf('\\');
    var firstSeg = slash < 0 ? rel : rel.slice(0, slash);
    if (!firstSeg) continue;
    var childFull = p + '\\' + firstSeg;
    var key = childFull.toLowerCase();
    if (!byChild[key]) {
      byChild[key] = { folder_path: childFull, folder_photo_count: 0 };
    }
    byChild[key].folder_photo_count += Number(flatRows[i].photo_count) || 0;
  }
  var out = [];
  for (var k in byChild) {
    if (Object.prototype.hasOwnProperty.call(byChild, k)) out.push(byChild[k]);
  }
  out.sort(function (a, b) {
    return String(a.folder_path).localeCompare(String(b.folder_path), 'zh-CN');
  });
  return out;
}

function getBrowseFolderChildSummaries() {
  if (state.currentView !== 'folder') return [];
  var cur = sidebarTree.normalizePath(state.currentPath || '');
  if (!cur) return [];
  var rid = rootIdForBrowseFolderPath(cur);
  if (rid == null) return [];
  var map = state._folderTreeByRootId;
  if (!map || typeof map !== 'object') return [];
  var rows = map[rid];
  if (!Array.isArray(rows)) return [];
  return aggregateImmediateSubfolderSummaries(cur, rows);
}

function mergeSubfolderSummariesWithCovers(summaries, coverRows) {
  var byPath = {};
  for (var i = 0; i < coverRows.length; i++) {
    var r = coverRows[i];
    if (!r || !r.folder_path) continue;
    var key = sidebarTree.normalizePath(String(r.folder_path)).toLowerCase();
    byPath[key] = r;
  }
  var out = [];
  for (var j = 0; j < summaries.length; j++) {
    var s = summaries[j];
    var k = sidebarTree.normalizePath(String(s.folder_path || '')).toLowerCase();
    var c = byPath[k];
    var row = {
      folder_path: s.folder_path,
      folder_photo_count: s.folder_photo_count,
    };
    if (c) {
      row.folder_photo_count =
        c.folder_photo_count != null ? Number(c.folder_photo_count) || 0 : s.folder_photo_count;
      if (c.id != null) {
        row.id = c.id;
        row.has_thumbnail = c.has_thumbnail ? 1 : 0;
        row.file_name = c.file_name || '';
      }
    }
    out.push(row);
  }
  return out;
}

async function enrichBrowseSubfolderCovers(loadSeq) {
  if (state.currentView !== 'folder') return null;
  var summaries = getBrowseFolderChildSummaries();
  if (!summaries.length) return [];
  if (!api.getImmediateSubfolderCovers || typeof api.getImmediateSubfolderCovers !== 'function') {
    return summaries;
  }
  var rid = rootIdForBrowseFolderPath(state.currentPath);
  if (rid == null) return summaries;
  var parentPath = sidebarTree.normalizePath(state.currentPath || '');
  var childPaths = summaries.map(function (s) {
    return s.folder_path;
  });
  try {
    var rows = await api.getImmediateSubfolderCovers(parentPath, childPaths, {
      rootId: rid,
      mediaType: normalizeMediaFilter(state.mediaFilter),
    });
    if (loadSeq !== state.photosLoadSeq) return null;
    return mergeSubfolderSummariesWithCovers(summaries, rows || []);
  } catch (e) {
    Logger.error(e);
    if (loadSeq !== state.photosLoadSeq) return null;
    return summaries;
  }
}

function photoBrowseCacheFingerprint() {
  return [
    state.currentTab,
    state.currentView,
    state.currentPath,
    state.currentDate,
    state.page,
    state.sortBy,
    state.sortOrder,
    String(state.searchQuery || ''),
    normalizeMediaFilter(state.mediaFilter),
    state.browseFolderIncludeSubfolders !== false ? 'sub1' : 'sub0',
  ].join('\x1e');
}

/** 用当前 state.currentPhotos 与接口 result 元数据绘制浏览网格（缓存秒开与请求完成后复用） */
function paintBrowsePhotoGridShell(result, paintOptions) {
  paintOptions = paintOptions || {};
  var browseChildSummaries = [];
  if (state.currentView === 'folder') {
    if (paintOptions.subfolderSummaries != null) {
      browseChildSummaries = paintOptions.subfolderSummaries;
    } else {
      browseChildSummaries = getBrowseFolderChildSummaries();
    }
  }
  if (state.currentView === 'folder') {
    var scopedTotal = Number(result && result.total) || 0;
    var scopedVideoCount = Number(result && result.videoCount) || 0;
    var subCount = browseChildSummaries.length;
    if (dom.statsBar)
      dom.statsBar.textContent = formatFolderScopedStatsBarText(
        scopedTotal,
        scopedVideoCount,
        subCount,
        state.mediaFilter,
      );
  } else if (state.stats && Number(state.stats.totalPhotos) > 0) {
    if (dom.statsBar)
      dom.statsBar.textContent = formatGlobalStatsBarText(state.stats, state.mediaFilter);
  } else {
    if (dom.statsBar) dom.statsBar.textContent = '';
  }
  updateBrowsePathLabel();
  previewFlow.initPreviewState({
    state: state,
    result: result,
  });
  photoGridUi.renderPhotoGrid({
    dom: dom,
    photos: state.currentPhotos,
    useMediaRatio: state.cardLayoutMode === 'masonry',
    mediaFilter: normalizeMediaFilter(state.mediaFilter),
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    truncate: truncate,
    formatDateTime: formatDateTime,
    formatNumber: formatNumber,
    normalizePath: sidebarTree.normalizePath,
    subfolderSummaries: browseChildSummaries,
    onApplyCardSize: applyCardSize,
  });
  photoGridUi.renderPagination({
    dom: dom,
    result: result,
    formatNumber: formatNumber,
  });
}

var normalizePositiveIntFilter =
  RendererUtils.normalizePositiveIntFilter ||
  function (v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  };

var normalizePositiveFloatFilter =
  RendererUtils.normalizePositiveFloatFilter ||
  function (v) {
    var n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 10) / 10;
  };

var firstBrowsePaintReported = false;
function reportFirstBrowsePaint() {
  if (firstBrowsePaintReported) return;
  firstBrowsePaintReported = true;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      api.invoke('notifyBrowsePhotosReady');
    });
  });
}

async function loadPhotos() {
  var seq = ++state.photosLoadSeq;
  api.invoke('beginBrowseRequest', seq);
  // 不在智能视图、却还挂着 AI 工具栏时兜底摘掉（点侧栏文件夹会直接走到这里），
  // 否则搜索框会留在浏览工具栏上、状态轮询也停不下来。
  if (
    aiViews &&
    typeof aiViews.isShowing === 'function' &&
    aiViews.isShowing() &&
    state.currentView !== 'ai_search' &&
    state.currentView !== 'people'
  ) {
    aiViews.leave();
  }
  persistStartupPositionSnapshot();
  if (state._pendingBrowseScrollTop == null) scrollBrowseGridToTop();
  // 重复项模式硬锁：防止旧的普通列表请求把右侧内容顶回“全部图片”
  if (state.sidebarLockedMode === 'duplicates' && state.currentView !== 'duplicates') {
    state.currentView = 'duplicates';
  }
  if (state.currentView === 'duplicates') {
    sidebarUi.ensureDuplicateSidebarVisible(dom);
    if (dom.toolbar) dom.toolbar.style.display = 'none';
    if (dom.pagination) dom.pagination.style.display = 'none';
    renderDuplicatePageShell();
    renderDuplicateSidebar();
    if (state.duplicateHasScanned) {
      await loadDuplicateGroups(state.duplicateGroupsPage || 1);
    }
    return;
  }
  // 搜图 / 人物：同样的 #photoGrid，换一套数据源；工具栏整体让位（控件都在侧栏）。
  if (state.currentView === 'ai_search' || state.currentView === 'people') {
    if (dom.toolbar) dom.toolbar.style.display = 'none';
    if (dom.emptyState) dom.emptyState.style.display = 'none';
    if (dom.pagination) dom.pagination.style.display = 'none';
    if (aiViews) await aiViews.load();
    return;
  }
  if (dom.toolbar) dom.toolbar.style.display = 'flex';
  if (dom.emptyState) dom.emptyState.style.display = 'none';
  if (dom.sortSelect) dom.sortSelect.disabled = state.currentView === 'folder_overview';

  if (state.currentView === 'folder_overview') {
    photoGridUi.showSkeleton({
      dom: dom,
      loadingLabel: '正在加载各目录封面…',
      escapeHtml: escapeHtml,
      onApplyCardSize: applyCardSize,
    });
    await yieldToPaint();
    try {
      var getFolderCoversFn = api.getFolderCovers;
      if (!getFolderCoversFn) {
        throw new Error('getFolderCovers unavailable');
      }
      var mediaFilter = normalizeMediaFilter(state.mediaFilter);
      var fcOpts = { page: state.page, pageSize: state.pageSize, browseRequestId: seq };
      if (mediaFilter !== 'all') fcOpts.mediaType = mediaFilter;
      var fcResult = normalizeFolderCoversResult(await api.getFolderCovers(fcOpts));
      if (seq !== state.photosLoadSeq) return;
      await yieldToPaint();
      var covers = fcResult.covers;
      if (seq !== state.photosLoadSeq) return;
      state.currentPhotos = [];
      updateBrowsePathLabel();
      previewFlow.initPreviewState({
        state: state,
        result: { total: fcResult.total, totalPages: fcResult.totalPages },
      });
      folderCoverUi.renderFolderCoverGrid({
        dom: dom,
        covers: covers,
        normalizePath: sidebarTree.normalizePath,
        escapeHtml: escapeHtml,
        escapeAttr: escapeAttr,
        formatNumber: formatNumber,
        onApplyCardSize: applyCardSize,
      });
      photoGridUi.renderPagination({
        dom: dom,
        result: {
          page: fcResult.page,
          totalPages: fcResult.totalPages,
          total: fcResult.total,
        },
        formatNumber: formatNumber,
      });
      if (dom.pageInfo) dom.pageInfo.textContent = formatFolderCountLabel(fcResult.total);
      reportFirstBrowsePaint();
      if (dom.statsBar) dom.statsBar.textContent = formatFolderCountLabel(fcResult.total);
      if (state._pendingBrowseScrollTop != null && dom.photoGrid) {
        dom.photoGrid.scrollTop = state._pendingBrowseScrollTop;
        state._pendingBrowseScrollTop = null;
      }
    } catch (e) {
      if (seq !== state.photosLoadSeq) return;
      Logger.error(e);
      if (dom.photoGrid) {
        dom.photoGrid.innerHTML =
          '<div class="empty-state"><div class="icon">\u26A0\uFE0F</div>' +
          '<div class="title">目录封面加载失败</div>' +
          '<div class="desc">请稍后重试</div></div>';
      }
      state.currentPhotos = [];
      if (dom.pagination) dom.pagination.style.display = 'none';
    }
    return;
  }

  var enrichSubfolderPromise =
    state.currentView === 'folder' ? enrichBrowseSubfolderCovers(seq) : null;

  var browseFp = photoBrowseCacheFingerprint();
  var cr = state._photoBrowseCacheResult;
  var cachedList = cr && Array.isArray(cr.photos) ? cr.photos : null;
  var cachedTotal = cr ? Number(cr.total) || 0 : -1;
  var warmGrid =
    (state.currentTab === 'folders' || state.currentTab === 'dates') &&
    !isWelcomeHomeVisible() &&
    state._photoBrowseCacheFp === browseFp &&
    cr &&
    cachedList &&
    (cachedList.length > 0 || cachedTotal === 0);

  if (warmGrid) {
    state.currentPhotos = cachedList;
    var warmSubfolders = enrichSubfolderPromise ? await enrichSubfolderPromise : null;
    if (seq !== state.photosLoadSeq) return;
    paintBrowsePhotoGridShell(cr, { subfolderSummaries: warmSubfolders });
    reportFirstBrowsePaint();
    if (state._pendingBrowseScrollTop != null && dom.photoGrid) {
      dom.photoGrid.scrollTop = state._pendingBrowseScrollTop;
      state._pendingBrowseScrollTop = null;
    }
  } else {
    photoGridUi.showSkeleton({
      dom: dom,
      escapeHtml: escapeHtml,
      onApplyCardSize: applyCardSize,
    });
    await yieldToPaint();
  }

  try {
    if (seq !== state.photosLoadSeq) return;
    var result = await fetchPhotosPage(state.page, seq);
    if (seq !== state.photosLoadSeq) return;
    await yieldToPaint();
    if (seq !== state.photosLoadSeq) return;
    state.currentPhotos = result.photos || [];
    var fetchedSubfolders = enrichSubfolderPromise ? await enrichSubfolderPromise : null;
    if (seq !== state.photosLoadSeq) return;
    paintBrowsePhotoGridShell(result, { subfolderSummaries: fetchedSubfolders });
    reportFirstBrowsePaint();
    state._photoBrowseCacheFp = photoBrowseCacheFingerprint();
    state._photoBrowseCacheResult = result;
    if (state._pendingBrowseScrollTop != null && dom.photoGrid) {
      dom.photoGrid.scrollTop = state._pendingBrowseScrollTop;
      state._pendingBrowseScrollTop = null;
    }
  } catch (e) {
    if (seq !== state.photosLoadSeq) return;
    Logger.error(e);
    if (dom.photoGrid) {
      dom.photoGrid.innerHTML =
        '<div class="empty-state"><div class="icon">\u26A0\uFE0F</div>' +
        '<div class="title">照片加载失败</div>' +
        '<div class="desc">请稍后重试或切换左侧视图</div></div>';
    }
    if (dom.pagination) dom.pagination.style.display = 'none';
    state.currentPhotos = [];
  }
}

function duplicateSidebarUiDeps() {
  return {
    state: state,
    dom: dom,
    formatNumber: formatNumber,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    onEnsureDuplicateSidebarVisible: function () {
      sidebarUi.ensureDuplicateSidebarVisible(dom);
    },
    onGetSidebarRenderTarget: function () {
      return sidebarUi.getSidebarRenderTarget(dom) || dom.sidebarContent;
    },
  };
}

function renderDuplicatePageShell() {
  return duplicatesUi.renderDuplicatePageShell({
    state: state,
    dom: dom,
  });
}

async function loadDuplicateGroups(page, loadOpts) {
  scrollBrowseGridToTop();
  return duplicatesFlow.loadDuplicateGroups({
    state: state,
    api: api,
    page: page,
    forceReload: !!(loadOpts && loadOpts.forceReload),
    onCreateSidebarRequestGate: createSidebarRequestGate,
    onRenderDuplicateSidebarLoading: renderDuplicateSidebarLoading,
    onRenderDuplicateSidebar: renderDuplicateSidebar,
    onRenderDuplicateNoGroupContent: renderDuplicateNoGroupContent,
    onSelectDuplicateGroup: function (hash) {
      return duplicatesFlow.selectDuplicateGroup({
        state: state,
        api: api,
        hash: hash,
        onCreateSidebarRequestGate: createSidebarRequestGate,
        onRenderDuplicateSidebar: renderDuplicateSidebar,
        onRenderDuplicateGroupPhotosHtml: renderDuplicateGroupPhotosHtml,
        onFormatNumber: formatNumber,
        onFormatSize: formatSize,
        onEscapeHtml: escapeHtml,
      });
    },
  });
}

function _backToHomeFromDuplicates() {
  state.currentTab = 'folders';
  state.currentView = 'all';
  state.page = 1;
  var tabs = $$('.nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.tab === 'folders');
  }
  showTabContent('folders');
  loadPhotos();
}

function renderDuplicateSidebarLoading(text, gate) {
  return duplicatesUi.renderDuplicateSidebarLoading(text, gate, duplicateSidebarUiDeps());
}

function renderDuplicateSidebar(gate) {
  return duplicatesUi.renderDuplicateSidebar(gate, duplicateSidebarUiDeps());
}

function renderDuplicateGroupPhotosHtml(hash) {
  return duplicatesUi.renderDuplicateGroupPhotosHtml(hash, {
    state: state,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    formatSize: formatSize,
    formatDateTime: formatDateTime,
  });
}

function renderDuplicateNoGroupContent(options) {
  return duplicatesUi.renderDuplicateNoGroupContent(options);
}

function openDuplicatePreview(hash, index) {
  return duplicatesFlow.openDuplicatePreview({
    state: state,
    hash: hash,
    index: index,
    onOpenPreview: openPreview,
  });
}

// === Card size control ===
function changeCardSize(direction) {
  var idx = browseCardTierIndexForBasis(state.cardSize);
  if (direction < 0) idx = Math.max(0, idx - 1);
  else if (direction > 0) idx = Math.min(CARD_SIZE_TIERS.length - 1, idx + 1);
  else return;
  state.cardSize = CARD_SIZE_TIERS[idx].basis;
  applyCardSize();
}

var _masonryResizeObserver = null;

function capMasonryColumns(host) {
  var grid = host.querySelector('.grid--masonry');
  if (!grid) return;
  var cards = grid.querySelectorAll('.photo-card').length;
  if (cards <= 0) return;
  var basis = state.cardSize || 220;
  var gap = 12;
  var w = grid.clientWidth || host.clientWidth || window.innerWidth;
  if (w <= 0) {
    requestAnimationFrame(function () {
      capMasonryColumns(host);
    });
    return;
  }
  var maxCols = Math.max(1, Math.floor((w + gap) / (basis + gap)));
  if (cards < maxCols) {
    grid.style.columnCount = String(cards);
  } else {
    grid.style.columnCount = '';
  }
  if (!_masonryResizeObserver) {
    _masonryResizeObserver = new ResizeObserver(function () {
      capMasonryColumns(dom.photoGrid);
    });
  }
  _masonryResizeObserver.disconnect();
  _masonryResizeObserver.observe(grid);
}

function applyCardSize() {
  state.cardSize = snapBrowseCardBasis(state.cardSize);
  state.cardRatio = normalizeBrowseCardRatio(state.cardRatio);
  state.thumbCrop = normalizeBrowseThumbCrop(state.thumbCrop);
  state.cardLayoutMode = normalizeBrowseCardLayout(state.cardLayoutMode);
  var gridVars = function (el) {
    if (!el || !el.style) return;
    el.style.setProperty('--grid-card-basis', String(state.cardSize));
    el.style.setProperty('--photo-card-ratio', state.cardRatio);
    el.style.setProperty('--photo-card-fit', state.thumbCrop ? 'cover' : 'contain');
    el.style.setProperty(
      '--photo-card-use-media-ratio',
      state.cardLayoutMode === 'masonry' ? '1' : '0',
    );
  };
  if (dom.photoGrid) {
    gridVars(dom.photoGrid);
    capMasonryColumns(dom.photoGrid);
  }
  var label = CARD_SIZE_TIERS[browseCardTierIndexForBasis(state.cardSize)].label;
  var zoomLabel = document.getElementById('zoomLabel');
  if (zoomLabel) zoomLabel.textContent = label;
}

/** 底栏「每页数量」读数：始终显示**当前生效**的档位值，而不是用户刚点的那一下。 */
function syncPageSizeControl() {
  state.pageSize = snapBrowsePageSize(state.pageSize);
  if (dom.pageSizeLabel) dom.pageSizeLabel.textContent = String(state.pageSize);
  var idx = browsePageSizeTierIndex(state.pageSize);
  if (dom.pageSizeDecBtn) dom.pageSizeDecBtn.disabled = idx <= 0;
  if (dom.pageSizeIncBtn) dom.pageSizeIncBtn.disabled = idx >= BROWSE_PAGE_SIZE_TIERS.length - 1;
}

/**
 * 底栏「每页数量」± 一档。
 *
 * 与卡片尺寸**不同**：卡片尺寸只改 CSS 变量、当场重排；每页张数要重新查库，
 * 所以这里走设置持久化那条路（`updateSettings` → 用返回的设置整体重放一遍），
 * 保证底栏、设置页下拉、`state.browsePrefsApplied` 三处不会各说各话。
 * 写库失败则退回原档位——否则界面会显示一个并没生效的张数。
 */
async function changeBrowsePageSize(direction) {
  var idx = browsePageSizeTierIndex(state.pageSize);
  var next = direction < 0 ? idx - 1 : idx + 1;
  if (next < 0 || next >= BROWSE_PAGE_SIZE_TIERS.length) return;
  var size = BROWSE_PAGE_SIZE_TIERS[next];
  var previous = snapBrowsePageSize(state.pageSize);
  if (size === previous) return;
  state.pageSize = size;
  syncPageSizeControl();
  try {
    var applied = await api.updateSettings({ browsePageSize: size });
    if (applied) {
      settingsSync.applyBrowsePreferencesFromSettings({
        state: state,
        dom: dom,
        settings: applied,
        snapBrowseCardBasis: snapBrowseCardBasis,
        onApplyCardSize: applyCardSize,
        onSetBrowseAppliedSnapshotFromObject: setBrowseAppliedSnapshotFromObject,
        onApplyPageSize: syncPageSizeControl,
      });
    }
    syncPageSizeControl();
    // 换了每页张数，原来的页码已经没有意义（第 7 页在新档位下可能根本不存在）。
    state.page = 1;
    void loadPhotos();
  } catch (e) {
    state.pageSize = previous;
    syncPageSizeControl();
    appAlert('切换每页显示张数失败：' + (e && e.message ? e.message : String(e)));
  }
}

// === Pagination (smart page numbers, aligned with web) ===
function goToPage(page) {
  if (page < 1 || page > state.previewTotalPages) return;
  state.page = page;
  void loadPhotos();
}

function goToRandomPage() {
  var tp = state.previewTotalPages || 0;
  if (tp <= 1) return;
  var cur = state.page;
  var target = cur;
  var i = 0;
  while (target === cur && i++ < 64) {
    target = Math.floor(Math.random() * tp) + 1;
  }
  goToPage(target);
}

// === Preview (uses photo:// protocol) ===
/** 随机幻灯：始终在全库图片范围内切换（与 getPreviewAdjacentPhoto 的 view=all + mediaType=image 一致） */
function buildPreviewAdjacentRequestOptions(currentId) {
  var seed = parseInt(state.slideshowRandomSeed, 10);
  if (!isFinite(seed) || seed <= 0) seed = Date.now() % 2147483647;
  return {
    currentId: currentId,
    sortBy: state.sortBy || 'date_taken',
    sortOrder: state.sortOrder || 'DESC',
    mediaType: 'image',
    mode: 'random',
    direction: 'next',
    seed: seed,
    view: 'all',
  };
}

/** 随机幻灯从全库拉取时曾无限 push，配合 preload 会内存暴涨、主线程长时间遍历卡死 */
var PREVIEW_PHOTOS_MAX_BUFFER = 240;

function openPreviewByPhotoRecord(photo) {
  if (!photo || photo.id == null) return;
  var id = Number(photo.id);
  if (!isFinite(id) || id <= 0) return;
  var idx = -1;
  for (var i = 0; i < state.previewPhotos.length; i++) {
    if (Number(state.previewPhotos[i].id) === id) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    state.previewPhotos.push(photo);
    idx = state.previewPhotos.length - 1;
    if (state.previewPhotos.length > PREVIEW_PHOTOS_MAX_BUFFER) {
      var cut = state.previewPhotos.length - PREVIEW_PHOTOS_MAX_BUFFER;
      state.previewPhotos.splice(0, cut);
      idx = state.previewPhotos.length - 1;
      state.slideshowRandomPool = [];
    }
  } else {
    state.previewPhotos[idx] = photo;
  }
  openPreview(idx);
}

function isVideoFile(photo) {
  if (!photo) return false;
  var mt = String(photo.media_type || photo.mediaType || '').toLowerCase();
  if (mt === 'video') return true;
  var ft = String(photo.file_type || '')
    .toLowerCase()
    .replace(/^\./, '');
  return (
    [
      'mp4',
      'mov',
      'm4v',
      'mkv',
      'avi',
      'wmv',
      'flv',
      'webm',
      'mpg',
      'mpeg',
      'm2ts',
      'ts',
      '3gp',
      '3g2',
    ].indexOf(ft) >= 0
  );
}

// 从网格点击进入预览，初始化照片列表
function startPreview(index) {
  var photo = state.currentPhotos[index];
  if (
    photo &&
    isVideoFile(photo) &&
    state.videoClickBehavior !== 'embedded' &&
    api &&
    api.has &&
    api.has('openPhotoExternal')
  ) {
    api.openPhotoExternal(photo.id).catch(function () {});
    return;
  }
  state.previewPhotos = state.currentPhotos.slice();
  // previewPageStart 追踪 previewPhotos 中第一张对应的页码
  state.previewPageStart = state.page;
  state.previewLoadingPage = 0;
  state.slideshowRandomPool = [];
  if (!state.slideshowRandomSeed) {
    state.slideshowRandomSeed = Date.now() % 2147483647;
  }
  openPreview(index);
}

function schedulePreviewImageLayoutBounds() {
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      return previewInteraction.updatePreviewImageLayoutBounds({
        state: state,
        dom: dom,
      });
    });
  });
}

function onPreviewImageDecoded() {
  if (dom.previewImage) dom.previewImage.classList.remove('switching');
  schedulePreviewImageLayoutBounds();
}

function openPreview(index) {
  return previewFlow.openPreview({
    state: state,
    dom: dom,
    api: api,
    index: index,
    onPreviewMainLinePrepare: function () {
      refreshPreviewRandomPositionNum();
    },
    onSyncRandomButton: function () {
      return previewSlideshow.syncRandomButton({
        state: state,
        dom: dom,
      });
    },
    onResetZoom: function () {
      return previewInteraction.resetZoom({
        state: state,
        onUpdatePreviewTransform: function () {
          return previewInteraction.updatePreviewTransform({
            state: state,
            dom: dom,
          });
        },
        onUpdatePreviewImageLayoutBounds: function () {
          return previewInteraction.updatePreviewImageLayoutBounds({
            state: state,
            dom: dom,
          });
        },
      });
    },
    onPreviewImageDecoded: onPreviewImageDecoded,
    onSchedulePreviewImageLayoutBounds: schedulePreviewImageLayoutBounds,
    onSyncFullscreenButton: syncFullscreenButton,
    onSyncPreviewFavoriteButton: function () {
      return previewFavoriteUi.syncPreviewFavoriteButton({
        state: state,
        dom: dom,
      });
    },
    onPreloadAdjacentPages: function (index) {
      return previewFlow.preloadAdjacentPages({
        state: state,
        index: index,
        onLoadPreviewAdjacentPage: function (pageDir, dir) {
          return previewFlow.loadPreviewAdjacentPage({
            state: state,
            pageDir: pageDir,
            dir: dir,
            fetchPhotosPage: fetchPhotosPage,
            onOpenPreview: openPreview,
          });
        },
      });
    },
  });
}

function closePreview() {
  state.previewRandomPositionNum = 0;
  previewSlideshow.stopSlideshow({
    state: state,
    dom: dom,
  });
  exitPreviewFullscreen();
  if (dom.previewInfoPanel) {
    dom.previewInfoPanel.classList.remove('open');
    _removePreviewInfoPanelListeners();
  }
  var overlay = dom.previewOverlay;
  overlay.classList.add('closing');
  setTimeout(function () {
    overlay.classList.remove('active', 'closing', 'minimized', 'ui-collapsed');
    if (dom.previewImage) {
      dom.previewImage.src = '';
      dom.previewImage.classList.remove('switching');
    }
    if (dom.previewVideo) {
      if (window.PhotoHlsAttach) window.PhotoHlsAttach.destroy(dom.previewVideo);
      try {
        dom.previewVideo.pause();
      } catch (e) {}
      dom.previewVideo.querySelectorAll('track[data-managed-subtitle="1"]').forEach(function (el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      if (dom.previewVideo._managedSubtitleBlobUrl) {
        try {
          URL.revokeObjectURL(dom.previewVideo._managedSubtitleBlobUrl);
        } catch (eBlob) {}
        dom.previewVideo._managedSubtitleBlobUrl = '';
      }
      dom.previewVideo.removeAttribute('src');
      try {
        dom.previewVideo.load();
      } catch (e2) {}
      dom.previewVideo.style.display = 'none';
    }
    if (dom.previewVideoCenterPlay) dom.previewVideoCenterPlay.style.display = 'none';
    if (dom.previewSubtitleTrackSelect) dom.previewSubtitleTrackSelect.style.display = 'none';
    var subtitleStylePanel = document.getElementById('previewSubtitleSettingsPanel');
    if (subtitleStylePanel) subtitleStylePanel.style.display = 'none';
    previewInteraction.resetZoom({
      state: state,
      onUpdatePreviewTransform: function () {
        return previewInteraction.updatePreviewTransform({
          state: state,
          dom: dom,
        });
      },
      onUpdatePreviewImageLayoutBounds: function () {
        return previewInteraction.updatePreviewImageLayoutBounds({
          state: state,
          dom: dom,
        });
      },
    });
  }, 280);
}

async function previewMoveToTrash() {
  return previewFlow.previewMoveToTrash({
    state: state,
    api: api,
    appConfirm: appConfirm,
    appAlert: appAlert,
    onLoadStats: loadStats,
    onLoadPhotos: loadPhotos,
    onClosePreview: closePreview,
    onOpenPreview: openPreview,
    photoGridUi: photoGridUi,
    dom: dom,
  });
}

async function openDatabaseFolder() {
  if (!(api && api.has('openDatabaseFolder'))) return;
  var r = await api.openDatabaseFolder();
  if (!r || !r.success) {
    appAlert('无法打开目录：' + ((r && r.error) || '未知错误'));
  }
}

async function toggleFavoriteOnCard(ev, photoId) {
  if (ev) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  await previewFlow.applyPhotoFavoriteToggle({
    state: state,
    dom: dom,
    api: api,
    photoId: photoId,
    appAlert: appAlert,
    onPatchPhotoFavoriteInState: function (id, isFav) {
      return previewFavoriteUi.patchPhotoFavoriteInState({
        state: state,
        photoId: id,
        isFav: isFav,
      });
    },
    onLoadStats: loadStats,
    onUpdateFavoriteCountInSidebar: updateFavoriteCountInSidebar,
    onSyncPreviewFavoriteButton: function () {
      return previewFavoriteUi.syncPreviewFavoriteButton({
        state: state,
        dom: dom,
      });
    },
    onUpdateFavoriteStarOnCard: function (id, isFav) {
      return previewFavoriteUi.updateFavoriteStarOnCard({
        photoId: id,
        isFav: isFav,
      });
    },
    onLoadPhotos: loadPhotos,
    onClosePreview: closePreview,
  });
}

async function previewToggleFavorite() {
  return previewFlow.previewToggleFavorite({
    state: state,
    onApplyPhotoFavoriteToggle: function (photoId) {
      return previewFlow.applyPhotoFavoriteToggle({
        state: state,
        dom: dom,
        api: api,
        photoId: photoId,
        appAlert: appAlert,
        onPatchPhotoFavoriteInState: function (id, isFav) {
          return previewFavoriteUi.patchPhotoFavoriteInState({
            state: state,
            photoId: id,
            isFav: isFav,
          });
        },
        onLoadStats: loadStats,
        onUpdateFavoriteCountInSidebar: updateFavoriteCountInSidebar,
        onSyncPreviewFavoriteButton: function () {
          return previewFavoriteUi.syncPreviewFavoriteButton({
            state: state,
            dom: dom,
          });
        },
        onUpdateFavoriteStarOnCard: function (id, isFav) {
          return previewFavoriteUi.updateFavoriteStarOnCard({
            photoId: id,
            isFav: isFav,
          });
        },
        onLoadPhotos: loadPhotos,
        onClosePreview: closePreview,
      });
    },
  });
}

async function previewFindSimilar() {
  var photo = state.previewPhotos[state.previewIndex];
  if (!photo || !photo.id) {
    appAlert('无法获取当前照片信息');
    return;
  }
  if (!(api && api.has && api.has('maintenanceFindSimilarPhotos'))) {
    appAlert('查找相似照片功能暂不可用');
    return;
  }
  if (dom.previewFindSimilarBtn) dom.previewFindSimilarBtn.disabled = true;
  try {
    var photoId = Number(photo.id);
    var threshold = state.similarThreshold || 12;
    var similarIds = await api.maintenanceFindSimilarPhotos({
      photoId: photoId,
      threshold: threshold,
    });
    if (!Array.isArray(similarIds) || similarIds.length === 0) {
      appAlert('未找到与此照片视觉相似的图片');
      return;
    }
    var rows = [];
    if (api && api.has && api.has('maintenanceGetPhotosByIds')) {
      rows = await api.maintenanceGetPhotosByIds(similarIds);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      appAlert('未找到相似照片的详细信息');
      return;
    }
    closePreview();
    state.currentView = 'all';
    state.currentPhotos = rows;
    state.previewTotalPhotos = rows.length;
    state.previewTotalPages = 1;
    state.page = 1;
    state.previewPageStart = 1;
    state.previewLoadingPage = 0;
    if (dom.toolbar) dom.toolbar.style.display = 'flex';
    if (dom.pagination) dom.pagination.style.display = 'none';
    if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
    updateBrowsePathLabel();
    photoGridUi.renderPhotoGrid({
      dom: dom,
      photos: state.currentPhotos,
      useMediaRatio: state.cardLayoutMode === 'masonry',
      mediaFilter: normalizeMediaFilter(state.mediaFilter),
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr,
      truncate: truncate,
      formatDateTime: formatDateTime,
      formatNumber: formatNumber,
      normalizePath: sidebarTree.normalizePath,
      subfolderSummaries: [],
      onApplyCardSize: applyCardSize,
    });
    var msg =
      '⭐ 查找相似照片 · 找到 ' +
      rows.length +
      ' 张与「' +
      (photo.file_name || '') +
      '」相似的照片';
    if (dom.currentPath) dom.currentPath.textContent = msg;
  } catch (e) {
    Logger.error('[previewFindSimilar]', e);
    appAlert('查找相似照片失败：' + (e && e.message ? e.message : '未知错误'));
  } finally {
    if (dom.previewFindSimilarBtn) dom.previewFindSimilarBtn.disabled = false;
  }
}

function gotoSimilarMode() {
  closeSettingsPage();
  switchDuplicateMode('similar');
  var dupTab = document.querySelector('.nav-tab[data-tab="duplicates"]');
  if (dupTab) dupTab.click();
}

async function previewShowInFolder() {
  return previewFlow.previewShowInFolder({
    state: state,
    api: api,
    appAlert: appAlert,
  });
}

async function showPhotoInFolderById(photoId) {
  return duplicatesFlow.showPhotoInFolderById({
    api: api,
    photoId: photoId,
    onSetDuplicateHashStatus: function (msg) {
      if (dom.duplicateHashStatus) dom.duplicateHashStatus.textContent = msg;
    },
  });
}

function switchDuplicateMode(mode) {
  mode = mode === 'similar' ? 'similar' : 'hash';
  if (state.duplicateDetectionMode === mode) return;
  state.duplicateDetectionMode = mode;
  state.duplicateGroups = [];
  state.duplicateGroupsPage = 1;
  state.duplicatePhotosByHash = {};
  state.currentDuplicateHash = '';
  state._dupListGen = (state._dupListGen || 0) + 1;
  if (state.currentTab === 'duplicates' || state.currentView === 'duplicates') {
    renderDuplicatePageShell();
    renderDuplicateSidebar();
    loadDuplicateGroups(1, { forceReload: true });
  }
}

async function deleteDuplicatePhoto(photoId, hash) {
  return duplicatesFlow.deleteDuplicatePhoto({
    state: state,
    api: api,
    photoId: photoId,
    hash: hash,
    appConfirm: appConfirm,
    appAlert: appAlert,
    onLoadStats: loadStats,
    onLoadDuplicateGroups: loadDuplicateGroups,
    onRenderDuplicateNoGroupContent: renderDuplicateNoGroupContent,
    onSelectDuplicateGroup: function (nextHash) {
      return duplicatesFlow.selectDuplicateGroup({
        state: state,
        api: api,
        hash: nextHash,
        onCreateSidebarRequestGate: createSidebarRequestGate,
        onRenderDuplicateSidebar: renderDuplicateSidebar,
        onRenderDuplicateGroupPhotosHtml: renderDuplicateGroupPhotosHtml,
        onFormatNumber: formatNumber,
        onFormatSize: formatSize,
        onEscapeHtml: escapeHtml,
      });
    },
  });
}

async function previewOpenExternal() {
  return previewFlow.previewOpenExternal({
    state: state,
    api: api,
    appAlert: appAlert,
  });
}

function toggleSlideshow() {
  return previewSlideshow.toggleSlideshow({
    state: state,
    dom: dom,
    onStartSlideshow: function () {
      return previewSlideshow.startSlideshow({
        state: state,
        dom: dom,
        onRestartSlideshowTimer: function () {
          return previewSlideshow.restartSlideshowTimer({
            state: state,
            onGoNextSlide: function () {
              return previewSlideshow.goNextSlide({
                state: state,
                api: api,
                buildPreviewAdjacentRequestOptions: buildPreviewAdjacentRequestOptions,
                onOpenPreview: openPreview,
                onOpenPreviewByPhoto: openPreviewByPhotoRecord,
              });
            },
          });
        },
      });
    },
    onStopSlideshow: function () {
      return previewSlideshow.stopSlideshow({
        state: state,
        dom: dom,
      });
    },
  });
}

function toggleSlideshowRandom() {
  return previewSlideshow.toggleSlideshowRandom({
    state: state,
    onSyncRandomButton: function () {
      return previewSlideshow.syncRandomButton({
        state: state,
        dom: dom,
      });
    },
    onAfterToggleRandom: function () {
      refreshPreviewRandomPositionNum();
    },
  });
}

async function syncFullscreenButton() {
  if (!dom.previewFullscreenBtn) return;
  if (dom.previewOverlay && dom.previewOverlay.classList && !document.fullscreenElement) {
    dom.previewOverlay.classList.remove('is-fullscreen');
    dom.previewOverlay.classList.remove('fs-ui-visible');
  }
  var inFs = !!document.fullscreenElement;
  var fsLabel = dom.previewFullscreenBtn.querySelector('.btn-label');
  if (fsLabel) fsLabel.textContent = inFs ? '退出全屏' : '全屏';
}

async function togglePreviewFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      var target = dom.previewOverlay || document.documentElement;
      if (target.requestFullscreen) await target.requestFullscreen();
    }
  } catch (e) {
    // 忽略
  } finally {
    syncFullscreenButton();
  }
}

async function exitPreviewFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch (e) {}
  syncFullscreenButton();
}

function navigatePreview(dir) {
  return previewFlow.navigatePreview({
    state: state,
    dir: dir,
    onOpenPreview: openPreview,
    onLoadPreviewAdjacentPage: function (pageDir, nextDir) {
      return previewFlow.loadPreviewAdjacentPage({
        state: state,
        pageDir: pageDir,
        dir: nextDir,
        fetchPhotosPage: fetchPhotosPage,
        onOpenPreview: openPreview,
      });
    },
    onBoundary: function (boundary) {
      if (boundary === 'first') {
        showPreviewToast('已是第一张');
      } else if (boundary === 'last') {
        showPreviewToast('已是最后一张');
      }
    },
  });
}

// === Utils ===
var formatNumber =
  RendererUtils.formatNumber ||
  function (n) {
    var num = Number(n || 0);
    return num.toLocaleString('zh-CN');
  };

var formatSize =
  RendererUtils.formatSize ||
  function (bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  };

var formatDateTime =
  RendererUtils.formatDateTime ||
  function (dateStr) {
    if (!dateStr) return '';
    return dateStr.replace('T', ' ').substring(0, 16);
  };

var formatDateLabel =
  RendererUtils.formatDateLabel ||
  function (dateStr) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    return parts[1] + '\u6708' + parseInt(parts[2], 10) + '\u65E5';
  };

var getWeekday =
  RendererUtils.getWeekday ||
  function (dateStr) {
    var days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var d = new Date(dateStr);
    return days[d.getDay()];
  };

var escapeHtml =
  RendererUtils.escapeHtml ||
  function (str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

var escapeAttr =
  RendererUtils.escapeAttr ||
  function (str) {
    if (!str) return '';
    return str.replace(/\\/g, '/').replace(/'/g, "\\'");
  };

var truncate =
  RendererUtils.truncate ||
  function (str, len) {
    if (!str || str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
  };

// === Menu actions ===
async function menuAction(action) {
  return menuActions.menuAction(action, {
    api: api,
    onHandleAddFolder: handleAddFolder,
    onCycleUiThemePreset: cycleUiThemePreset,
    onToggleChromeCollapsed: toggleChromeCollapsed,
    appAlert: appAlert,
  });
}

window.__applyWebPasswordI18n = function () {
  if (!(api && api.has('getSettings'))) return;
  var R = window.RendererSettingsSync;
  if (!R || !R.syncWebPasswordUiFromSettings) return;
  api.getSettings().then(function (s) {
    R.syncWebPasswordUiFromSettings({ state: state, settings: s });
  });
};

window.PhotoCompare.mount({
  currentPhoto: function () {
    return state.previewPhotos[state.previewIndex];
  },
  imageUrl: function (photo) {
    return 'photo://' + photo.id;
  },
  beforeOpen: closePreview,
});
// 搜图 / 人物：结果落进主照片网格，卡片、预览翻页、幻灯片、收藏、卡片尺寸全部复用浏览链路。
aiViews = window.RendererAiViews.init({
  dom: dom,
  state: state,
  api: api,
  ui: {
    renderPhotoGrid: photoGridUi.renderPhotoGrid,
    showSkeleton: photoGridUi.showSkeleton,
    applyCardSize: applyCardSize,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    truncate: truncate,
    formatDateTime: formatDateTime,
    formatNumber: formatNumber,
    normalizePath: sidebarTree.normalizePath,
  },
  onRerenderChrome: updateBrowsePathLabel,
});
aiViews.bind();
window.semanticSettings = window.SemanticSearchUI.mount({
  manage: true,
  settingsOnly: true,
  container: document.getElementById('settingsAiSearchMount'),
  isActive: function () {
    return state.currentTab === 'settings';
  },
  call: function (operation) {
    var methods = {
      status: 'aiSearchStatus',
      install: 'aiSearchInstall',
      index: 'aiSearchIndex',
      cancel: 'aiSearchCancel',
    };
    return api.call(methods[operation]);
  },
  /**
   * 匹配阈值的读写。设置项由主进程持有（settings.json），所以走既有的 getSettings /
   * updateSettings；网页端没有设置入口，不传这两个钩子，面板会提示「在桌面端调整」。
   */
  matchThreshold: {
    read: function () {
      return api.call('getSettings').then(function (all) {
        return all && all.aiSearchMatchThreshold;
      });
    },
    write: function (value) {
      return api.call('updateSettings', { aiSearchMatchThreshold: value });
    },
  },
});
/**
 * 打开设置页并定位到「搜图索引」那一行。
 * 搜图 / 人物各有自己的调用点（左栏视图的设置入口、主界面任务面板的「设置」按钮），
 * 但两者的面板已并进「后台任务」，所以这里只切到该面板、再把目标行滚进视野——
 * 保留「把用户带到目标」的语义，而不是简单粗暴地停在面板顶部。
 */
async function openSemanticSettings() {
  await openSettingsPage();
  if (state.currentTab !== 'settings') return;
  window.semanticSettings.show();
  scrollToSettingsSection('settingsSectionTasks');
  var mount = document.getElementById('settingsAiSearchMount');
  if (mount) mount.scrollIntoView({ block: 'nearest' });
}
window.peopleSettings = window.PeopleUI.mount({
  manage: true,
  settingsOnly: true,
  container: document.getElementById('settingsAiPeopleMount'),
  isActive: function () {
    return state.currentTab === 'settings';
  },
  navigate: goToPeoplePage,
  call: function (operation, args) {
    return api.call('faceAction', operation, args);
  },
});
async function openPeopleSettings() {
  await openSettingsPage();
  if (state.currentTab !== 'settings') return;
  window.peopleSettings.show();
  scrollToSettingsSection('settingsSectionTasks');
  var mount = document.getElementById('settingsAiPeopleMount');
  if (mount) mount.scrollIntoView({ block: 'nearest' });
}
/**
 * 「设置 → 人物」面板里的「前往人物页」入口。
 * 命名人物发生在「人物」视图，而设置面板只有模型 / 索引类操作；早先靠一句
 * 「第 3 步：查看并命名人物」引导，用户在本页找不到任何命名入口。
 * 这里先把返回目标改成 people，再交给 closeSettingsPage 统一复原外壳——
 * 这样「设置返回」的落点与跳转目标一致，也避免自己拼一遍侧栏 / 布尔的复原逻辑。
 */
function goToPeoplePage() {
  if (state.currentTab === 'settings') {
    state.tabBeforeSettings = 'people';
    closeSettingsPage();
    return;
  }
  showTabContent('people');
}
document.getElementById('peopleNavSettings').addEventListener('click', function () {
  void openPeopleSettings();
  sidebarUi.closeMobileSidebar();
});
document.getElementById('settingsSidebar').addEventListener('click', function (event) {
  var item = event.target.closest('[data-settings-section-id]');
  if (!item) return;
  scrollToSettingsSection(item.getAttribute('data-settings-section-id'));
  sidebarUi.closeMobileSidebar();
});
document.getElementById('faceTaskSettings').addEventListener('click', function () {
  void openPeopleSettings();
});
document.getElementById('semanticTaskSettings').addEventListener('click', function () {
  void openSemanticSettings();
});
document.getElementById('semanticTaskStop').addEventListener('click', async function () {
  var button = document.getElementById('semanticTaskStop');
  var errorLine = document.getElementById('semanticTaskError');
  button.disabled = true;
  errorLine.textContent = '';
  try {
    await api.call('aiSearchCancel');
  } catch (error) {
    errorLine.textContent = String(error.message || error);
    button.disabled = false;
  }
  void tickBackgroundTasksOnce();
});
document.getElementById('faceTaskStop').addEventListener('click', async function () {
  var button = document.getElementById('faceTaskStop');
  var errorLine = document.getElementById('faceTaskError');
  button.disabled = true;
  errorLine.textContent = '';
  try {
    await api.call('faceAction', 'cancel');
  } catch (error) {
    errorLine.textContent = String(error.message || error);
    button.disabled = false;
  }
  void tickBackgroundTasksOnce();
});
init();
