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
var facesUi = window.RendererFacesUI || {};
var uiEvents = window.RendererUIEvents || {};
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
  sortBy: 'date_taken',
  sortOrder: 'DESC',
  mediaFilter: 'all', // all | image | video
  page: 1,
  pageSize: 100,
  cardSize: 180, // 网格卡片基准（仅取 CARD_SIZE_TIERS 中的值，与 S/M/L/XL 对应）
  cardRatio: '1 / 1',
  thumbCrop: false,
  cardLayoutMode: 'masonry', // uniform | masonry
  /** 与设置 browseFolderIncludeSubfolders 同步：目录视图是否包含子文件夹中的媒体 */
  browseFolderIncludeSubfolders: true,
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
  /** 预览底部信息条（与设置同步，见 syncPreviewDisplayOptionsFromSettings） */
  previewDisplayOptions: null,
  /** 已写入主进程的预览底部主行开关 */
  previewDisplayApplied: null,
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
  currentDuplicateHash: '',
  duplicateExpanded: {},
  duplicatePhotosByHash: {},
  sidebarViewToken: 0,
  sidebarRequestSeq: 0,
  sidebarLatestRequests: {},
  sidebarLockedMode: '',
  faceClusters: [],
  faceSelectedClusterId: null,
  faceScanPollTimer: null,
  /** all = 所有人脸网格；person = 选中人物后看文件夹或目录文件 */
  faceUiMode: 'all',
  faceSelectedFolderPath: null,
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
  /** 离开人脸 Tab 时保存，返回时恢复 */
  faceTabMemory: null,
  /** 人脸人物列表是否可用内存快照跳过重复 IPC（识别/合并后应强制刷新） */
  faceClustersFetchWarm: false,
  _pendingBrowseScrollTop: null,
  _pendingFaceScrollTop: null,
  /** 与 _photoBrowseCacheResult 对应的列表查询指纹（目录/日期/从重复项或人脸返回时优先秒开网格） */
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
  searchInput: $('#searchInput'),
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
  previewOverlay: $('#previewOverlay'),
  previewBody: $('#previewBody'),
  previewImage: $('#previewImage'),
  previewVideo: $('#previewVideo'),
  previewVideoCenterPlay: $('#previewVideoCenterPlay'),
  previewInfo: $('#previewInfo'),
  previewInfoMain: $('#previewInfoMain'),
  previewClose: $('#previewClose'),
  previewPrev: $('#previewPrev'),
  previewNext: $('#previewNext'),
  previewZoom: $('#previewZoom'),
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
  maintenanceStatus: $('#maintenanceStatus'),
  duplicateHashStatus: $('#duplicateHashStatus'),
  maintenanceCleanupBtn: $('#maintenanceCleanupBtn'),
  maintenanceRebuildThumbFlagsBtn: $('#maintenanceRebuildThumbFlagsBtn'),
  maintenanceOptimizeBtn: $('#maintenanceOptimizeBtn'),
  previewFavoriteBtn: $('#previewFavoriteBtn'),
  previewShowInFolderBtn: $('#previewShowInFolderBtn'),
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
    onAfterBackgroundTasksPoll: maybeRefreshFaceListsDuringScan,
  });
}

/** 管理页上次滚动定位的区块 id（如 settingsSectionMedia） */
var SETTINGS_LAST_SECTION_LS_KEY = 'photoManager.settingsLastSection.v1';
var VALID_SETTINGS_SECTION_IDS = {
  settingsSectionFolders: 1,
  settingsSectionCloseBehavior: 1,
  settingsSectionGeneral: 1,
  settingsSectionBrowse: 1,
  settingsSectionFace: 1,
  settingsSectionMedia: 1,
  settingsSectionNetwork: 1,
};

function getLastSettingsSectionId() {
  try {
    var id = localStorage.getItem(SETTINGS_LAST_SECTION_LS_KEY);
    if (id && VALID_SETTINGS_SECTION_IDS[id] && document.getElementById(id)) return id;
  } catch (e) {}
  return 'settingsSectionFolders';
}

function saveLastSettingsSectionId(sectionId) {
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
    el.scrollIntoView({ behavior: 'auto', block: 'start' });
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
  s0 = await hydratePreviewDisplaySettings(s0);
  state.previewDisplayApplied = previewDisplaySliceFromSettings(s0);
  syncLiveSettingsWidgetsFromObject(s0);
  applyThumbAppliedStateFromSettings(s0);
  settingsSync.applyBrowsePreferencesFromSettings({
    state: state,
    dom: dom,
    settings: s0,
    snapBrowseCardBasis: snapBrowseCardBasis,
    onApplyCardSize: applyCardSize,
    onSetBrowseAppliedSnapshotFromObject: setBrowseAppliedSnapshotFromObject,
  });
  if (window.I18n && typeof window.I18n.initFromSettings === 'function') {
    window.I18n.initFromSettings(s0);
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
    } else if (state.currentTab === 'faces' || state.currentView === 'faces') {
      await loadFaceClusters({ forceRefresh: true });
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
      return (
        state.currentTab === view &&
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
    previewBindings: PREVIEW_DISPLAY_UI_BINDINGS,
    onPersistPreviewDisplay: persistPreviewDisplayFromControls,
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
    onPersistFacePrefs: persistFacePrefsFromForm,
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
    onCloseSettingsPage: closeSettingsPage,
    onApplyThumbSettings: applyThumbSettings,
    onStartThumbnailBackfill: startThumbnailBackfill,
    onStartDuplicateHashDetection: startDuplicateHashDetection,
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
    onPreviewShowInFolder: previewShowInFolder,
    onPreviewOpenExternal: previewOpenExternal,
    onPreviewMoveToTrash: previewMoveToTrash,
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
    onViewFaces: viewFaces,
    onShowTabContent: showTabContent,
    onForceSwitchToDuplicates: forceSwitchToDuplicates,
    onEnsureDuplicateSidebarVisible: function () {
      return sidebarUi.ensureDuplicateSidebarVisible(dom);
    },
    onRenderDuplicateSidebar: renderDuplicateSidebar,
    onSaveBrowseTabMemory: saveBrowseTabMemory,
    onSaveFaceTabMemory: saveFaceTabMemory,
  });

  function handleFaceMainNavFromElement(t) {
    if (!t || !t.closest) return false;
    if (t.closest('.face-person-name-input')) return false;

    var allEl = t.closest('[data-face-sidebar="all"]');
    if (allEl) {
      state.faceUiMode = 'all';
      state.faceSelectedClusterId = null;
      state.faceSelectedFolderPath = null;
      renderFaceSidebar();
      void refreshFaceMainContent();
      return true;
    }

    var card = t.closest('.face-all-card');
    if (card) {
      var cid = parseInt(card.getAttribute('data-face-cluster-id') || '', 10);
      if (!cid) return true;
      state.faceUiMode = 'person';
      state.faceSelectedClusterId = cid;
      state.faceSelectedFolderPath = null;
      renderFaceSidebar();
      void loadFacePersonFoldersView(cid);
      return true;
    }

    var row = t.closest('.face-person-row');
    if (row) {
      var pid = parseInt(row.getAttribute('data-face-cluster-id') || '', 10);
      if (!pid) return true;
      state.faceUiMode = 'person';
      state.faceSelectedClusterId = pid;
      state.faceSelectedFolderPath = null;
      renderFaceSidebar();
      void loadFacePersonFoldersView(pid);
      return true;
    }

    var fdir = t.closest('[data-face-folder-path]');
    if (fdir) {
      var fp = fdir.getAttribute('data-face-folder-path') || '';
      if (!fp) return true;
      state.faceSelectedFolderPath = fp;
      void loadFaceFolderFilesView(fp);
      return true;
    }

    return false;
  }

  document.addEventListener(
    'click',
    function (e) {
      if (state.currentTab !== 'faces') return;
      var t = e.target;
      if (!handleFaceMainNavFromElement(t)) return;
      e.preventDefault();
    },
    true,
  );

  document.addEventListener(
    'keydown',
    function (e) {
      if (state.currentTab !== 'faces') return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!handleFaceMainNavFromElement(t)) return;
      e.preventDefault();
    },
    true,
  );

  document.addEventListener(
    'focusout',
    function (e) {
      var inp = e.target;
      if (!inp || !inp.classList || !inp.classList.contains('face-person-name-input')) return;
      if (state.currentTab !== 'faces') return;
      if (!(api && api.has && api.has('faceUpdateClusterLabel'))) return;
      var cid = parseInt(inp.getAttribute('data-face-rename-id') || '', 10);
      if (!cid) return;
      var val = String(inp.value || '').trim();
      void api.faceUpdateClusterLabel(cid, val).then(function (r) {
        if (r && r.success) {
          var i;
          for (i = 0; i < state.faceClusters.length; i++) {
            if (state.faceClusters[i].id === cid) {
              state.faceClusters[i].label = val || null;
              break;
            }
          }
          renderFaceSidebar();
          void refreshFaceMainContent();
        }
      });
    },
    true,
  );

  document.addEventListener(
    'click',
    function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-face-action]') : null;
      if (!btn || state.currentTab !== 'faces') return;
      var act = btn.getAttribute('data-face-action');
      if (!act) return;
      e.preventDefault();
      if (act === 'scan') void startFaceScan();
      else if (act === 'cluster') void runFaceCluster();
      else if (act === 'search-image') void faceSearchByImage();
      else if (act === 'refresh') void loadFaceClusters({ forceRefresh: true });
      else if (act === 'back-folders') {
        state.faceSelectedFolderPath = null;
        if (state.faceSelectedClusterId)
          void loadFacePersonFoldersView(state.faceSelectedClusterId);
      }
    },
    true,
  );
  uiEvents.bindSearchSortFilters({
    dom: dom,
    getState: function () {
      return state;
    },
    onLoadPhotos: loadPhotos,
    onLoadRootFolders: loadRootFolders,
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
    onPreviewToggleFavorite: previewToggleFavorite,
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
      if (state.currentTab === 'folders') {
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
  if (dom.searchInput) dom.searchInput.value = state.searchQuery;
  if (dom.mediaFilterSelect) dom.mediaFilterSelect.value = state.mediaFilter;
  state._pendingBrowseScrollTop = typeof m.scrollTop === 'number' ? m.scrollTop : null;
}

function saveFaceTabMemory() {
  state.faceTabMemory = {
    faceUiMode: state.faceUiMode,
    faceSelectedClusterId: state.faceSelectedClusterId,
    faceSelectedFolderPath: state.faceSelectedFolderPath,
    page: state.page,
    scrollTop: dom.photoGrid ? dom.photoGrid.scrollTop : 0,
  };
}

function applyFaceTabMemory() {
  var fm = state.faceTabMemory;
  if (!fm) return false;
  state.faceUiMode = fm.faceUiMode || 'all';
  state.faceSelectedClusterId = fm.faceSelectedClusterId != null ? fm.faceSelectedClusterId : null;
  state.faceSelectedFolderPath = fm.faceSelectedFolderPath || null;
  state.page = fm.page > 0 ? fm.page : 1;
  state._pendingFaceScrollTop = typeof fm.scrollTop === 'number' ? fm.scrollTop : null;
  return true;
}

function applyPendingFaceScroll() {
  var y = state._pendingFaceScrollTop;
  if (y == null) return;
  state._pendingFaceScrollTop = null;
  var inner = document.getElementById('faceMainInner');
  if (inner) inner.scrollTop = y;
}

/**
 * 按范围失效会话缓存。不传 partial 时清空目录+日期+人脸+重复项（全量）。
 * @param {{ folders?: boolean, dates?: boolean, face?: boolean, duplicates?: boolean }} [partial]
 */
function invalidateTabSessionCaches(partial) {
  var f;
  var d;
  var face;
  var dup;
  if (!partial) {
    f = d = face = dup = true;
  } else {
    f = !!partial.folders;
    d = !!partial.dates;
    face = !!partial.face;
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
  if (face) {
    state.faceTabMemory = null;
    state.faceClustersFetchWarm = false;
    state._pendingFaceScrollTop = null;
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
  var zc = document.getElementById('zoomControl');
  if (zc && state.currentTab === 'folders') zc.style.display = '';
}

// === Tab switching ===
function showTabContent(tab, opts) {
  opts = opts || {};
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
    if (tab === 'faces') {
      state.prevTab = tab;
      state.sidebarLockedMode = 'faces';
      state.currentView = 'faces';
      sidebarUi.ensureNormalSidebarVisible(dom);
      var sidebarSoftFace = document.getElementById('sidebar');
      if (sidebarUi.showSidebarOnDesktop)
        sidebarUi.showSidebarOnDesktop(sidebarSoftFace, state.isMobile);
      else if (!state.isMobile && sidebarSoftFace) sidebarSoftFace.style.display = '';
      tabsUi.prepareBrowsingShell({
        dom: dom,
        currentView: state.currentView,
        isWelcomeHomeVisible: isWelcomeHomeVisible(),
      });
      tabsUi.applyFacesView({
        dom: dom,
        onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
        onUpdateBrowsePathLabel: updateBrowsePathLabel,
        onEnsureDuplicateSidebarVisible: function () {
          return sidebarUi.ensureDuplicateSidebarVisible(dom);
        },
      });
      var navFace = $$('.nav-tab');
      var nf;
      for (nf = 0; nf < navFace.length; nf++) {
        navFace[nf].classList.toggle('active', navFace[nf].dataset.tab === 'faces');
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

  if (tab !== 'faces' && state.sidebarLockedMode === 'faces') {
    state.sidebarLockedMode = '';
    if (state.currentView === 'faces') state.currentView = 'all';
    stopFaceScanPolling();
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
  startSettingsFolderListPolling();
}

// 从管理页面返回照片浏览
function closeSettingsPage() {
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
    dom.statsBar.textContent = formatGlobalStatsBarText(stats);
  } else {
    dom.statsBar.textContent = '';
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
  if (state.currentTab !== 'folders') return;
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
    state.currentTab === 'folders';
  if (snapReady) {
    gate.render(snap.html);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (state.currentTab === 'folders') {
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
                if (state.currentTab === 'folders') {
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
        if (state.currentTab === 'folders') syncFolderSidebarHighlight();
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
function viewAllPhotos() {
  state.currentView = 'all';
  state.page = 1;
  updateSidebarActive();
  loadPhotos();
}

function viewFavorites() {
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
  if (state.currentTab === 'folders') saveBrowseTabMemory('folders');
  else if (state.currentTab === 'dates') saveBrowseTabMemory('dates');
  else if (state.currentTab === 'faces') saveFaceTabMemory();

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
  dom.toolbar.style.display = 'none';
  dom.pagination.style.display = 'none';
  var zc = document.getElementById('zoomControl');
  if (zc) zc.style.display = 'none';
  showTabContent('duplicates');
  renderDuplicateSidebar();
  if (state.duplicateHasScanned) {
    loadDuplicateGroups(state.duplicateGroupsPage || 1);
  }
}

function stopFaceScanPolling() {
  if (state.faceScanPollTimer) {
    clearInterval(state.faceScanPollTimer);
    state.faceScanPollTimer = null;
  }
}

function startFaceScanPolling() {
  stopFaceScanPolling();
  if (!(api && api.has && api.has('faceGetStatus'))) return;
  state.faceScanPollTimer = setInterval(function () {
    if (state.currentTab !== 'faces') return;
    api.faceGetStatus().then(function (st) {
      var sc = (st && st.scan) || {};
      if (sc.status === 'running') {
        facesUi.setFaceStatusLine(
          '已处理 ' +
            (sc.current || 0) +
            '/' +
            (sc.total || 0) +
            ' ' +
            String(sc.currentFile || '').slice(-48),
        );
      } else if (sc.status === 'done' || sc.status === 'cancelled' || sc.status === 'idle') {
        stopFaceScanPolling();
        facesUi.setFaceStatusLine(
          sc.status === 'done' ? '识别完成。' : sc.status === 'cancelled' ? '已停止。' : '',
        );
        loadFaceClusters({ forceRefresh: true });
      }
    });
  }, 650);
}

function getFacePersonTitle(clusterId) {
  var cid = parseInt(clusterId, 10);
  if (!isFinite(cid) || cid <= 0) return '人物';
  var i;
  for (i = 0; i < state.faceClusters.length; i++) {
    if (state.faceClusters[i].id === cid) {
      var idx = i + 1;
      var c = state.faceClusters[i];
      if (c.label && String(c.label).trim()) return String(c.label).trim();
      return '人物 ' + idx;
    }
  }
  return '人物 #' + cid;
}

async function maybeRefreshFaceListsDuringScan(tasks) {
  if (!tasks || !tasks.faceScan || !tasks.faceScan.running) return;
  if (state.currentTab !== 'faces') return;
  var now = Date.now();
  if (now - (state._faceScanSidebarRefreshAt || 0) < 2800) return;
  state._faceScanSidebarRefreshAt = now;
  await loadFaceClusters({ sidebarOnly: true, forceRefresh: true });
}

async function loadFaceClusters(options) {
  options = options || {};
  if (!(api && api.has && api.has('faceGetClusters'))) return;
  if (options.forceRefresh) {
    state.faceClustersFetchWarm = false;
  }
  if (!options.forceRefresh && state.faceClustersFetchWarm && Array.isArray(state.faceClusters)) {
    renderFaceSidebar();
    if (options.sidebarOnly) {
      if (state.faceUiMode === 'all' || !state.faceSelectedClusterId) {
        await refreshFaceMainContent();
      }
      return;
    }
    await refreshFaceMainContent();
    return;
  }
  try {
    var rows = await api.faceGetClusters();
    state.faceClusters = rows || [];
    state.faceClustersFetchWarm = true;
    renderFaceSidebar();
    if (options.sidebarOnly) {
      if (state.faceUiMode === 'all' || !state.faceSelectedClusterId) {
        await refreshFaceMainContent();
      }
      return;
    }
    await refreshFaceMainContent();
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    facesUi.setFaceStatusLine('人物列表加载失败：' + msg);
  }
}

async function refreshFaceMainContent() {
  if (state.faceUiMode === 'all' || !state.faceSelectedClusterId) {
    facesUi.setFaceBreadcrumb([], escapeHtml);
    await loadFaceAllPersonsView();
    applyPendingFaceScroll();
    return;
  }
  if (state.faceSelectedFolderPath) {
    await loadFaceFolderFilesView(state.faceSelectedFolderPath);
    applyPendingFaceScroll();
    return;
  }
  await loadFacePersonFoldersView(state.faceSelectedClusterId);
  applyPendingFaceScroll();
}

async function loadFaceAllPersonsView() {
  await yieldToPaint();
  var clusters = Array.isArray(state.faceClusters) ? state.faceClusters : [];
  var total = clusters.length;
  var ps = state.pageSize > 0 ? state.pageSize : 100;
  var totalPages = total > 0 ? Math.max(1, Math.ceil(total / ps)) : 1;
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  var start = (state.page - 1) * ps;
  var pageClusters = clusters.slice(start, start + ps);

  previewFlow.initPreviewState({
    state: state,
    result: { total: total, totalPages: totalPages },
  });
  state.currentPhotos = [];

  var zc = document.getElementById('zoomControl');
  if (total > 0) {
    facesUi.renderFaceAllPersonsGrid({
      clusters: pageClusters,
      indexOffset: start,
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr,
      formatNumber: formatNumber,
    });
    photoGridUi.renderPagination({
      dom: dom,
      result: {
        page: state.page,
        totalPages: totalPages,
        total: total,
      },
      formatNumber: formatNumber,
    });
    if (dom.pageInfo) dom.pageInfo.textContent = formatNumber(total) + ' 人';
    if (zc) zc.style.display = '';
    applyCardSize();
  } else {
    facesUi.renderFaceAllPersonsGrid({
      clusters: [],
      indexOffset: 0,
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr,
      formatNumber: formatNumber,
    });
    if (dom.pagination) dom.pagination.style.display = 'none';
    if (zc) zc.style.display = 'none';
  }
}

async function loadFacePersonFoldersView(clusterId) {
  if (!(api && api.has && api.has('faceGetClusterFolders'))) return;
  if (dom.pagination) dom.pagination.style.display = 'none';
  var zc0 = document.getElementById('zoomControl');
  if (zc0) zc0.style.display = 'none';
  try {
    var folders = await api.faceGetClusterFolders(clusterId);
    var title = getFacePersonTitle(clusterId);
    facesUi.setFaceBreadcrumb([title], escapeHtml);
    facesUi.renderFaceFolderList({
      folders: folders || [],
      personTitle: title,
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr,
    });
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    facesUi.setFaceStatusLine('文件夹列表打不开：' + msg);
    var inner = document.getElementById('faceMainInner');
    if (inner) {
      inner.innerHTML = '<div class="dup-empty">文件夹列表打不开，请稍后再试。</div>';
    }
  }
}

async function loadFaceFolderFilesView(folderPath) {
  if (!(api && api.has && api.has('getFolderPhotos'))) return;
  if (dom.pagination) dom.pagination.style.display = 'none';
  var zc1 = document.getElementById('zoomControl');
  if (zc1) zc1.style.display = 'none';
  var cid = state.faceSelectedClusterId;
  var title = cid ? getFacePersonTitle(cid) : '';
  facesUi.setFaceBreadcrumb([title, folderPath], escapeHtml);
  try {
    var fPs = state.pageSize > 0 ? state.pageSize : 100;
    var result = await api.getFolderPhotos(folderPath, {
      page: 1,
      pageSize: fPs,
      sortBy: 'date_taken',
      sortOrder: 'DESC',
      mediaType: 'all',
      includeSubfolders: state.browseFolderIncludeSubfolders !== false,
    });
    state.currentPhotos = result.photos || [];
    previewFlow.initPreviewState({
      state: state,
      result: result,
    });
    var hostId = 'facePhotoGridHost';
    var inner = document.getElementById('faceMainInner');
    if (!inner) return;
    inner.innerHTML =
      '<div class="face-folder-toolbar">' +
      '<button type="button" class="btn btn-sm" data-face-action="back-folders">\u2190 返回文件夹列表</button>' +
      '</div>' +
      '<div id="' +
      hostId +
      '" class="photo-grid face-photo-grid-host"></div>';
    var host = document.getElementById(hostId);
    if (!host || !photoGridUi.renderPhotoGrid) return;
    photoGridUi.renderPhotoGrid({
      dom: Object.assign({}, dom, { photoGrid: host }),
      photos: state.currentPhotos,
      useMediaRatio: state.cardLayoutMode === 'masonry',
      mediaFilter: normalizeMediaFilter(state.mediaFilter),
      escapeHtml: escapeHtml,
      truncate: truncate,
      formatDateTime: formatDateTime,
      onApplyCardSize: applyCardSize,
    });
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    facesUi.setFaceStatusLine('照片列表打不开：' + msg);
    var mainInnerErr = document.getElementById('faceMainInner');
    if (mainInnerErr) {
      mainInnerErr.innerHTML =
        '<div class="dup-empty">这个文件夹里的照片读不出来。</div>' +
        '<div class="face-folder-toolbar" style="margin-top:8px;">' +
        '<button type="button" class="btn btn-sm" data-face-action="back-folders">\u2190 返回文件夹列表</button>' +
        '</div>';
    }
  }
}

function renderFacePageShell() {
  facesUi.renderFacePageShell({ state: state, dom: dom });
}

function renderFaceSidebar() {
  facesUi.renderFaceSidebar({
    state: state,
    formatNumber: formatNumber,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    onEnsureDuplicateSidebarVisible: function () {
      sidebarUi.ensureDuplicateSidebarVisible(dom);
    },
    onGetSidebarRenderTarget: function () {
      return sidebarUi.getSidebarRenderTarget(dom) || dom.sidebarContent;
    },
  });
}

async function startFaceScan() {
  if (!(api && api.has && api.has('faceStartScan'))) return;
  facesUi.setFaceStatusLine('正在启动…');
  try {
    var r = await api.faceStartScan();
    if (!r || !r.success) {
      facesUi.setFaceStatusLine('启动失败：' + ((r && r.error) || ''));
      return;
    }
    invalidateTabSessionCaches({ face: true });
    facesUi.setFaceStatusLine('已在后台识别人脸…');
    tickBackgroundTasksOnce();
    startFaceScanPolling();
  } catch (e) {
    facesUi.setFaceStatusLine('启动失败：' + (e && e.message ? e.message : String(e)));
  }
}

async function runFaceCluster() {
  if (!(api && api.has && api.has('faceRunCluster'))) return;
  facesUi.setFaceStatusLine('正在合并人物…');
  tickBackgroundTasksOnce();
  try {
    var fTh = 0.35;
    var fGp = state.generalSettingsApplied;
    if (fGp && typeof fGp.faceClusterThreshold === 'number') fTh = fGp.faceClusterThreshold;
    var r = await api.faceRunCluster({ threshold: fTh });
    if (r && r.success) {
      facesUi.setFaceStatusLine('合并完成，共 ' + (r.clusters || 0) + ' 个人物');
      invalidateTabSessionCaches({ face: true });
      await loadFaceClusters({ forceRefresh: true });
    } else {
      facesUi.setFaceStatusLine('合并失败：' + ((r && r.error) || ''));
    }
  } catch (e) {
    facesUi.setFaceStatusLine('合并失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    tickBackgroundTasksOnce();
  }
}

async function faceSearchByImage() {
  if (!(api && api.has && api.has('faceSelectQueryImage')) || !api.has('faceSearchByImage')) return;
  try {
    var p = await api.faceSelectQueryImage();
    if (!p) return;
    facesUi.setFaceStatusLine('正在找人…');
    tickBackgroundTasksOnce();
    var r = await api.faceSearchByImage(p);
    if (!r || !r.success) {
      facesUi.setFaceStatusLine((r && r.error) || '没找到');
      return;
    }
    var results = r.results || [];
    state.currentPhotos = results;
    previewFlow.initPreviewState({
      state: state,
      result: { total: results.length, totalPages: 1 },
    });
    if (dom.pagination) dom.pagination.style.display = 'none';
    var zcSearch = document.getElementById('zoomControl');
    if (zcSearch) zcSearch.style.display = 'none';
    facesUi.renderFaceSearchResults({
      photos: results,
      escapeHtml: escapeHtml,
      escapeAttr: escapeAttr,
      truncate: truncate,
      formatDateTime: formatDateTime,
    });
    facesUi.setFaceStatusLine('找到 ' + results.length + ' 张相似照片');
  } catch (e) {
    facesUi.setFaceStatusLine('查找失败：' + (e && e.message ? e.message : String(e)));
  } finally {
    tickBackgroundTasksOnce();
  }
}

function viewFaces() {
  if (state.currentTab === 'folders') saveBrowseTabMemory('folders');
  else if (state.currentTab === 'dates') saveBrowseTabMemory('dates');

  state.sidebarLockedMode = 'faces';
  state.currentTab = 'faces';
  state.currentView = 'faces';
  if (!applyFaceTabMemory()) {
    state.faceUiMode = 'all';
    state.faceSelectedClusterId = null;
    state.faceSelectedFolderPath = null;
    state.page = 1;
    state._pendingFaceScrollTop = null;
  }
  updateBrowsePathLabel();
  sidebarUi.ensureDuplicateSidebarVisible(dom);
  var tabs = $$('.nav-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].dataset.tab === 'faces');
  }
  tabsUi.applyFacesView({
    dom: dom,
    onCloseMobileSidebar: sidebarUi.closeMobileSidebar,
    onUpdateBrowsePathLabel: updateBrowsePathLabel,
    onEnsureDuplicateSidebarVisible: function () {
      return sidebarUi.ensureDuplicateSidebarVisible(dom);
    },
  });
  dom.toolbar.style.display = 'none';
  dom.pagination.style.display = 'none';
  var zc = document.getElementById('zoomControl');
  if (zc) zc.style.display = 'none';
  showTabContent('faces');
  renderFacePageShell();
  loadFaceClusters();
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
  state.currentView = 'folder';
  state.currentPath = normalized;
  state.page = 1;
  state.sortBy = 'file_name';
  state.sortOrder = 'ASC';
  dom.sortSelect.value = 'file_name|ASC';
  if (dom.photoGrid) {
    dom.photoGrid.scrollTop = 0;
  }
  updateSidebarActive();
  scheduleBrowseReload(function () {
    if (state.currentTab === 'folders' && state.currentPath) {
      sidebarTree.expandTreeToFolder(state.currentPath);
    }
    void loadPhotos();
  });
}

function viewDate(dateStr) {
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

function formatGlobalStatsBarText(stats) {
  stats = stats || {};
  if (!stats.totalPhotos || stats.totalPhotos <= 0) return '';
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

function formatFolderScopedStatsBarText(scopedTotal, scopedVideoCount, subCount) {
  var st = Number(scopedTotal) || 0;
  var vc = Number(scopedVideoCount) || 0;
  var sub = Number(subCount) || 0;
  if (st > 0) {
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
  switch (state.currentView) {
    case 'duplicates':
      dom.currentPath.textContent = tUi('path.duplicates', '重复照片（哈希）');
      break;
    case 'faces':
      dom.currentPath.textContent = tUi('path.faces', '人脸 · 按人物浏览');
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
    default:
      dom.currentPath.textContent = tUi('path.allPhotos', '所有照片');
  }
}

function updateSidebarActive() {
  if (state.currentTab === 'settings') renderSettingsNav(getLastSettingsSectionId());
  else if (state.currentTab === 'duplicates') renderDuplicateSidebar();
  else if (state.currentTab === 'faces') renderFaceSidebar();
  else if (state.currentTab === 'folders') syncFolderSidebarHighlight();
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
  return settingsUi.renderSettingsNav(activeId, { dom: dom });
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
  dom.scanProgress.style.display = 'block';
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
    saveLastSettingsSectionId('settingsSectionMedia');
    if (state.currentTab === 'settings') renderSettingsNav('settingsSectionMedia');
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
    saveLastSettingsSectionId('settingsSectionMedia');
    if (state.currentTab === 'settings') renderSettingsNav('settingsSectionMedia');
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
  var ps = parseInt(s.browsePageSize, 10);
  if ([50, 100, 200, 300, 500].indexOf(ps) < 0) ps = 100;
  var cs = snapBrowseCardBasis(s.browseCardSize);
  var cr = normalizeBrowseCardRatio(s.browseCardRatio);
  var tc = normalizeBrowseThumbCrop(s.browseThumbCrop);
  var cl = normalizeBrowseCardLayout(s.browseCardLayout);
  var sb = s.browseSortBy || 'date_taken';
  var so = s.browseSortOrder === 'ASC' || s.browseSortOrder === 'DESC' ? s.browseSortOrder : 'DESC';
  state.browsePrefsApplied = {
    sortBy: sb,
    sortOrder: so,
    pageSize: ps,
    cardSize: cs,
    cardRatio: cr,
    thumbCrop: tc,
    cardLayoutMode: cl,
    browseFolderIncludeSubfolders: s.browseFolderIncludeSubfolders !== false,
  };
}

function normalizeThumbBackfillConcurrency(v) {
  var c = parseInt(v, 10);
  if (isNaN(c) || c < 1) c = 3;
  if (c > 8) c = 8;
  return c;
}

function normalizeFaceClusterThreshold(v) {
  var n = parseFloat(v);
  if (!isFinite(n)) return 0.35;
  var allowed = [0.25, 0.3, 0.35, 0.4, 0.45];
  var best = 0.35;
  var bd = Infinity;
  var i;
  for (i = 0; i < allowed.length; i++) {
    var d = Math.abs(n - allowed[i]);
    if (d < bd) {
      bd = d;
      best = allowed[i];
    }
  }
  return best;
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
    faceClusterThreshold: normalizeFaceClusterThreshold(s.faceClusterThreshold),
    faceAutoScanOnStartup: !!s.faceAutoScanOnStartup,
    thumbBackfillConcurrency: normalizeThumbBackfillConcurrency(s.thumbBackfillConcurrency),
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

async function persistFacePrefsFromForm() {
  return settingsSync.persistFacePrefsFromForm({
    state: state,
    api: api,
    appAlert: appAlert,
    onNormalizeFaceClusterThreshold: normalizeFaceClusterThreshold,
    onSetGeneralSettingsAppliedFromObject: setGeneralSettingsAppliedFromObject,
    onSyncFacePrefsFormFromRuntimeState: function () {
      var ap = state.generalSettingsApplied;
      if (!ap) return;
      settingsSync.syncFacePrefsFormFromRuntimeState({
        applied: ap,
        onNormalizeFaceClusterThreshold: normalizeFaceClusterThreshold,
      });
    },
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
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

function revertPreviewDisplayCheckboxesToApplied() {
  return settingsSync.revertPreviewDisplayCheckboxesToApplied({
    state: state,
    onApplyPreviewDisplayCheckboxesFromSlice: applyPreviewDisplayCheckboxesFromSlice,
  });
}

async function persistPreviewDisplayFromControls() {
  return settingsSync.persistPreviewDisplayFromControls({
    state: state,
    api: api,
    previewDisplayUiBindings: PREVIEW_DISPLAY_UI_BINDINGS,
    previewDisplaySettingKeys: PREVIEW_DISPLAY_SETTING_KEYS,
    onPreviewDisplaySliceFromSettings: previewDisplaySliceFromSettings,
    onWritePreviewDisplayLocalStorage: writePreviewDisplayLocalStorage,
    onSyncPreviewDisplayOptionsFromSettings: syncPreviewDisplayOptionsFromSettings,
    onApplyPreviewDisplayToOpenPreview: applyPreviewDisplayToOpenPreview,
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
    onRevertPreviewDisplayCheckboxesToApplied: revertPreviewDisplayCheckboxesToApplied,
    appAlert: appAlert,
  });
}

/** 与主进程 settings 键名一致，用于本地缓存与合并 */
var PREVIEW_DISPLAY_SETTING_KEYS = [
  'previewShowFileName',
  'previewShowDateTaken',
  'previewShowFileSize',
  'previewShowDimensions',
  'previewShowPosition',
];
/** 设置页复选框 id：setting + 首字母大写的 settings 键名 */
var PREVIEW_DISPLAY_UI_BINDINGS = (function () {
  var out = [];
  for (var i = 0; i < PREVIEW_DISPLAY_SETTING_KEYS.length; i++) {
    var key = PREVIEW_DISPLAY_SETTING_KEYS[i];
    out.push({ id: 'setting' + key.charAt(0).toUpperCase() + key.slice(1), key: key });
  }
  return out;
})();
var PREVIEW_DISPLAY_LS_KEY = 'photoManager.previewDisplay.v1';

function applyPreviewDisplayCheckboxesFromSlice(slice) {
  if (!slice) return;
  for (var i = 0; i < PREVIEW_DISPLAY_UI_BINDINGS.length; i++) {
    var b = PREVIEW_DISPLAY_UI_BINDINGS[i];
    var el = document.getElementById(b.id);
    if (!el) continue;
    var on = !!slice[b.key];
    el.checked = on;
    if (on) el.setAttribute('checked', 'checked');
    else el.removeAttribute('checked');
  }
}

function readPreviewDisplayLocalStorage() {
  try {
    var raw = localStorage.getItem(PREVIEW_DISPLAY_LS_KEY);
    if (!raw) return null;
    var o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

function writePreviewDisplayLocalStorage(mergedSix) {
  try {
    localStorage.setItem(PREVIEW_DISPLAY_LS_KEY, JSON.stringify(mergedSix));
  } catch (e) {}
}

function previewDisplaySliceFromSettings(s) {
  if (!s) s = {};
  var out = {};
  for (var i = 0; i < PREVIEW_DISPLAY_SETTING_KEYS.length; i++) {
    var k = PREVIEW_DISPLAY_SETTING_KEYS[i];
    out[k] = typeof s[k] === 'boolean' ? s[k] : true;
  }
  return out;
}

/**
 * 合并策略：**磁盘（主进程 getSettings）优先**，避免旧版 localStorage 覆盖用户已写入的 false。
 * 仅当磁盘上该键不是布尔（极旧配置）时，才用 localStorage，最后用默认 true。
 */
function mergePreviewDisplayDiskFirst(diskS, localO) {
  var out = {};
  for (var i = 0; i < PREVIEW_DISPLAY_SETTING_KEYS.length; i++) {
    var k = PREVIEW_DISPLAY_SETTING_KEYS[i];
    var d = diskS[k];
    if (typeof d === 'boolean') out[k] = d;
    else if (localO && typeof localO[k] === 'boolean') out[k] = localO[k];
    else out[k] = true;
  }
  return out;
}

function previewDisplayPatchIfDiskDiffers(diskS, mergedSix) {
  var patch = {};
  for (var i = 0; i < PREVIEW_DISPLAY_SETTING_KEYS.length; i++) {
    var k = PREVIEW_DISPLAY_SETTING_KEYS[i];
    if ((diskS[k] !== false) !== mergedSix[k]) patch[k] = mergedSix[k];
  }
  return patch;
}

function applyPreviewSixOntoSettings(s, mergedSix) {
  for (var i = 0; i < PREVIEW_DISPLAY_SETTING_KEYS.length; i++) {
    var k = PREVIEW_DISPLAY_SETTING_KEYS[i];
    s[k] = mergedSix[k];
  }
}

/** 启动或打开管理页时：磁盘优先合并本地缓存，必要时 updateSettings，并刷新预览选项 */
async function hydratePreviewDisplaySettings(diskS) {
  if (!diskS) diskS = {};
  var local = readPreviewDisplayLocalStorage();
  var merged = mergePreviewDisplayDiskFirst(diskS, local);
  var patch = previewDisplayPatchIfDiskDiffers(diskS, merged);
  var out = diskS;
  if (Object.keys(patch).length && api.has('updateSettings')) {
    try {
      out = await api.updateSettings(patch);
      // 与用户在 await 期间再次勾选/取消的 IPC 交错时，必须用主进程返回的最新值，不能用 await 前的 merged 覆盖 out
      merged = previewDisplaySliceFromSettings(out);
    } catch (e) {}
  }
  applyPreviewSixOntoSettings(out, merged);
  writePreviewDisplayLocalStorage(merged);
  syncPreviewDisplayOptionsFromSettings(out);
  return out;
}

function syncPreviewDisplayOptionsFromSettings(s) {
  if (!s) s = {};
  var slice = previewDisplaySliceFromSettings(s);
  state.previewDisplayOptions = {
    fileName: slice.previewShowFileName,
    dateTaken: slice.previewShowDateTaken,
    fileSize: slice.previewShowFileSize,
    dimensions: slice.previewShowDimensions,
    position: slice.previewShowPosition,
  };
}

/** 在全库/当前视图总数中的 1-based 序号（与分页一致，非仅当前缓冲区内下标） */
function previewGlobalPositionOne(index) {
  var ps = state.pageSize > 0 ? state.pageSize : 100;
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

function buildPreviewMainLine(photo, index) {
  var o = state.previewDisplayOptions;
  if (!o) {
    o = {
      fileName: true,
      dateTaken: true,
      fileSize: true,
      dimensions: true,
      position: true,
    };
  }
  var parts = [];
  if (o.fileName && photo.file_name) parts.push(photo.file_name);
  if (o.dateTaken) {
    var d = formatDateTime(photo.date_taken);
    if (d) parts.push(d);
  }
  if (o.fileSize) parts.push(formatSize(photo.file_size));
  if (o.dimensions && photo.width) parts.push(photo.width + 'x' + (photo.height || 0));
  var line = parts.join(' | ');
  if (o.position && state.previewTotalPhotos > 0) {
    var num = state.slideshowRandom
      ? state.previewRandomPositionNum > 0
        ? state.previewRandomPositionNum
        : previewGlobalPositionOne(index)
      : previewGlobalPositionOne(index);
    var pos = '[' + num + '/' + state.previewTotalPhotos + ']';
    line = line ? line + ' ' + pos : pos;
  }
  return line;
}

/** 设置项变更时，若预览已打开则立即刷新信息条（无需切换照片） */
function applyPreviewDisplayToOpenPreview() {
  if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return;
  var photo = state.previewPhotos[state.previewIndex];
  if (!photo) return;
  var mainLine = buildPreviewMainLine(photo, state.previewIndex);
  if (dom.previewInfoMain) dom.previewInfoMain.textContent = mainLine;
  else if (dom.previewInfo) dom.previewInfo.textContent = mainLine;
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
  var fctEl = document.getElementById('settingFaceClusterThreshold');
  if (fctEl) fctEl.value = String(normalizeFaceClusterThreshold(s.faceClusterThreshold));
  var fasEl = document.getElementById('settingFaceAutoScanOnStartup');
  if (fasEl) fasEl.checked = !!s.faceAutoScanOnStartup;
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
  s = await hydratePreviewDisplaySettings(s);
  // hydrate 内有 await：再读一次主进程，避免与 updateSettings 交错得到旧快照
  try {
    s = await api.getSettings();
  } catch (e) {}

  syncPreviewDisplayOptionsFromSettings(s);
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
  });
  settingsSync.syncBrowsePrefsFormFromRuntimeState({
    state: state,
  });

  var previewSlice = previewDisplaySliceFromSettings(s);
  applyPreviewDisplayCheckboxesFromSlice(previewSlice);
  state.previewDisplayApplied = previewSlice;
  syncPreviewDisplayOptionsFromSettings(s);

  requestAnimationFrame(function () {
    applyPreviewDisplayCheckboxesFromSlice(previewSlice);
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
    dom.duplicateHashStatus.textContent = tUi('settings.task.dupReadError', '重复检测状态读取失败');
    stopDuplicateHashPolling();
  }
}

async function startDuplicateHashDetection() {
  if (!(api && api.has('maintenanceStartDuplicateHashDetection'))) return;
  if (dom.duplicateHashStartBtn) dom.duplicateHashStartBtn.disabled = true;
  if (dom.duplicateHashStatus)
    dom.duplicateHashStatus.textContent = tUi(
      'settings.task.dupStarting',
      '正在启动重复检测任务...',
    );
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

async function fetchPhotosPage(pageNum) {
  var options = {
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    page: pageNum != null ? pageNum : state.page,
    pageSize: state.pageSize,
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
    dom.statsBar.textContent = formatFolderScopedStatsBarText(
      scopedTotal,
      scopedVideoCount,
      subCount,
    );
  } else if (state.stats && Number(state.stats.totalPhotos) > 0) {
    dom.statsBar.textContent = formatGlobalStatsBarText(state.stats);
  } else {
    dom.statsBar.textContent = '';
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

async function loadPhotos() {
  var seq = ++state.photosLoadSeq;
  persistStartupPositionSnapshot();
  if (state._pendingBrowseScrollTop == null) scrollBrowseGridToTop();
  // 重复项模式硬锁：防止旧的普通列表请求把右侧内容顶回“全部图片”
  if (state.sidebarLockedMode === 'duplicates' && state.currentView !== 'duplicates') {
    state.currentView = 'duplicates';
  }
  if (state.currentView === 'duplicates') {
    sidebarUi.ensureDuplicateSidebarVisible(dom);
    dom.toolbar.style.display = 'none';
    dom.pagination.style.display = 'none';
    renderDuplicatePageShell();
    renderDuplicateSidebar();
    if (state.duplicateHasScanned) {
      await loadDuplicateGroups(state.duplicateGroupsPage || 1);
    }
    return;
  }
  if (state.sidebarLockedMode === 'faces' && state.currentView !== 'faces') {
    state.currentView = 'faces';
  }
  if (state.currentView === 'faces') {
    sidebarUi.ensureDuplicateSidebarVisible(dom);
    dom.toolbar.style.display = 'none';
    if (!document.getElementById('faceMainArea')) {
      renderFacePageShell();
    }
    renderFaceSidebar();
    await refreshFaceMainContent();
    return;
  }
  dom.toolbar.style.display = 'flex';
  dom.emptyState.style.display = 'none';
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
      var fcOpts = { page: state.page, pageSize: state.pageSize };
      if (mediaFilter !== 'all') fcOpts.mediaType = mediaFilter;
      var fcResult = normalizeFolderCoversResult(await api.getFolderCovers(fcOpts));
      if (seq !== state.photosLoadSeq) return;
      await yieldToPaint();
      var covers = fcResult.covers;
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
      if (dom.statsBar) dom.statsBar.textContent = formatFolderCountLabel(fcResult.total);
      if (state._pendingBrowseScrollTop != null && dom.photoGrid) {
        dom.photoGrid.scrollTop = state._pendingBrowseScrollTop;
        state._pendingBrowseScrollTop = null;
      }
    } catch (e) {
      Logger.error(e);
      dom.photoGrid.innerHTML =
        '<div class="empty-state"><div class="icon">\u26A0\uFE0F</div>' +
        '<div class="title">目录封面加载失败</div>' +
        '<div class="desc">请稍后重试</div></div>';
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
    var result = await fetchPhotosPage(state.page);
    if (seq !== state.photosLoadSeq) return;
    await yieldToPaint();
    state.currentPhotos = result.photos || [];
    var fetchedSubfolders = enrichSubfolderPromise ? await enrichSubfolderPromise : null;
    if (seq !== state.photosLoadSeq) return;
    paintBrowsePhotoGridShell(result, { subfolderSummaries: fetchedSubfolders });
    state._photoBrowseCacheFp = photoBrowseCacheFingerprint();
    state._photoBrowseCacheResult = result;
    if (state._pendingBrowseScrollTop != null && dom.photoGrid) {
      dom.photoGrid.scrollTop = state._pendingBrowseScrollTop;
      state._pendingBrowseScrollTop = null;
    }
  } catch (e) {
    if (seq !== state.photosLoadSeq) return;
    Logger.error(e);
    dom.photoGrid.innerHTML =
      '<div class="empty-state"><div class="icon">\u26A0\uFE0F</div>' +
      '<div class="title">照片加载失败</div>' +
      '<div class="desc">请稍后重试或切换左侧视图</div></div>';
    dom.pagination.style.display = 'none';
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

function renderDuplicateNoGroupContent() {
  return duplicatesUi.renderDuplicateNoGroupContent();
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
  if (dom.photoGrid) gridVars(dom.photoGrid);
  var faceAllHost = document.getElementById('faceAllPersonsGrid');
  if (faceAllHost) gridVars(faceAllHost);
  var label = CARD_SIZE_TIERS[browseCardTierIndexForBasis(state.cardSize)].label;
  var zoomLabel = document.getElementById('zoomLabel');
  if (zoomLabel) zoomLabel.textContent = label;
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

// 从网格点击进入预览，初始化照片列表
function startPreview(index) {
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
    onSyncPreviewDisplayOptionsFromSettings: syncPreviewDisplayOptionsFromSettings,
    onPreviewDisplaySliceFromSettings: previewDisplaySliceFromSettings,
    onBuildPreviewMainLine: buildPreviewMainLine,
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
  var overlay = dom.previewOverlay;
  overlay.classList.add('closing');
  setTimeout(function () {
    overlay.classList.remove('active', 'closing', 'minimized', 'ui-collapsed');
    dom.previewImage.src = '';
    dom.previewImage.classList.remove('switching');
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
    if (dom.previewInfoMain) dom.previewInfoMain.textContent = '';
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
      applyPreviewDisplayToOpenPreview();
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
  dom.previewFullscreenBtn.textContent = inFs ? '🡼 退出全屏' : '⛶ 全屏';
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

init();
