/** 网格卡片档位：与底栏「尺寸」下拉、设置页 `#settingBrowseCardSize` 一致（basis 写入 browseCardSize） */
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
var previewCrop = window.RendererPreviewCrop || {};
var previewInteraction = window.RendererPreviewInteraction || {};
var previewSlideshow = window.RendererPreviewSlideshow || {};
var previewFavoriteUi = window.RendererPreviewFavoriteUI || {};
var previewLiveUi = window.RendererPreviewLive || {};
// 组织元数据（标记 / 评分 / 用户标签）的界面与状态。**不是**空壳兜底：
// 它承载的是筛选参数的拼装与写入结果的内存同步，取不到会让「点了星但角标不变」。
var orgMetaUi = window.RendererOrgMetaUI || {};
var photoGridUi = window.RendererPhotoGridUI || {};
var folderCoverUi = window.RendererFolderCoverUI || {};
var duplicatesUi = window.RendererDuplicatesUI || {};
var settingsUi = window.RendererSettingsUI || {};
var thumbSettingsUi = window.RendererThumbSettingsUI || {};
var maintenanceUi = window.RendererMaintenanceUI || {};
var duplicatesFlow = window.RendererDuplicatesFlow || {};
var uiEvents = window.RendererUIEvents || {};
// 搜图 / 人物视图到主图片网格的适配层，挂载点在文件末尾（init 前保持 null，
// 早期调用 showTabContent('folders') 时不会碰到它）。
var aiViews = null;
// 标签导航页的界面层（侧栏树 + 主区卡片）。同样在 init 前保持 null ——
// `showTabContent('folders')` 会在挂载之前被早期路径调到，那些路径不会碰标签页。
var tagNavUi = null;
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
/** 每页张数档位与收档：底栏「每页」下拉按它取值，与主进程校验同一套值 */
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
// 「档位下标」（`browsePageSizeTierIndex` / `browseCardTierIndexForBasis`）只有 −/+ 药丸需要：
// 要「当前是第几档」才能算 ±1。底栏那两个控件换成下拉后，用户直接选中档位本身，
// 渲染端不再需要下标 —— 真源仍在 utils.js（主进程校验与未来调用方要用）。
// 「网格与比例」的归一与编解码只有一份实现（`utils.js` 的 `BROWSE_CARD_RATIOS` 一族），
// 这里只做转发 —— 与 `snapBrowseCardBasis` 等一样，靠 index.html 里 utils.js 先于本文件加载。
// 设置页下拉、底栏 `#browseGridStyleSelect` 与这两个归一函数此前各持一份字面量，
// 现在三处都收敛到 utils.js；漏掉任一处，两处下拉就会对同一个 state 显示出不同的读数。
function normalizeBrowseCardRatio(v) {
  return RendererUtils.normalizeBrowseCardRatio(v);
}
function normalizeBrowseThumbCrop(v) {
  if (v === true || v === 1 || v === '1') return true;
  return false;
}
function normalizeBrowseCardLayout(v) {
  return RendererUtils.normalizeBrowseCardLayout(v);
}
function encodeBrowseGridStyleValue(layoutMode, cardRatio) {
  return RendererUtils.encodeBrowseGridStyleValue(layoutMode, cardRatio);
}
function parseBrowseGridStyleValue(raw) {
  return RendererUtils.parseBrowseGridStyleValue(raw);
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
  /**
   * 组织元数据筛选（评分 / 标记 / 标签）。`null` = 不限，`0` / `'none'` 是**合法的具体值**
   * （未评分 / 未标记，冲片时最常查的两档）。判据与主进程 `org-meta-filter.js` 同源。
   * 由 `orgMetaUi.applyFilterToOptions()` 并进请求参数，别在别处手拼。
   */
  orgFilter: { rating: null, flag: null, tagIds: [] },
  /** 标签筛选面板的候选列表（`[{id, name, photo_count}]`，按使用量降序） */
  tagList: [],
  /** 当前预览这张图的用户标签（`[{id, name}]`）。写回包与读回包都落在这里。 */
  previewTags: [],
  previewTagsPhotoId: 0,
  /** 标签读取的请求序号：丢掉过期回包，防止 A 的标签画到 C 上 */
  previewTagsLoadSeq: 0,
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
  /**
   * 「图片信息」面板启用的字段 id（设置页勾选结果）。
   * null = 还没从设置里同步过 → 交给注册表的默认集；真实值由
   * settingsSync.applyInfoPanelFieldsFromSettings() 写入，绝不在别处硬编码字段清单。
   */
  infoPanelFields: null,
  previewLoadingPage: 0, // 0=不加载
  previewPageStart: 1, // previewPhotos 中第一张图片对应的页码
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
  /**
   * 预览态里**待保存**的编辑动作（按用户点击顺序）。`rotate-right` / `rotate-left` /
   * `flip-h` / `flip-v` 的任意序列 —— 点「保存」时整串一次性发给后端合成**一条**算子。
   *
   * 🔴 这里刻意只存「动作串」，不存合成后的角度/镜像位：合成规则（CSS 求值顺序与 sharp
   *    算子顺序同构）唯一实现源是 `image-edit.js#composeAction`，前端再写一份必然漂移。
   *    前端要的那一点点信息（布局要不要宽高对调）由 `previewRotateDeg` 单独承载。
   */
  previewEditPendingActions: [],
  /**
   * 待保存动作的**原样 CSS 变换尾巴**，按点击逆序拼（`updatePreviewTransform` 直接接在
   * `translate/scale` 后面）。CSS 右侧先求值 = 「先镜像、后旋转」，与 sharp 完全同构。
   */
  previewEditCssTail: '',
  /** 预览态编辑的旋转角**和**（只用来判「90 的奇数倍」⇒ 元素盒要给转过来的图留空间） */
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
  /** 设置页「数据库位置」那一行的读数（位置 / 体积 / 余量），进入设置页时拉一次 */
  dataDirInfo: null,
  /** 数据目录迁移进行中：期间禁用迁移按钮，并且不再覆盖那行进度文案 */
  dataDirMigrating: false,
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
   * tags.tabMemory：标签导航页选中的标签 / 节点（叶子标签才带分页）
   */
  browseCaches: {
    folders: { tabMemory: null, sidebarSnapshot: null },
    dates: {
      tabMemory: null,
      dateGroupsList: null,
      dateGroupsListSort: null,
      dateGroupsCacheFavAt: null,
    },
    tags: { tabMemory: null },
  },
  /**
   * 标签导航页当前**选中**的东西。两者互斥：
   *   `currentTag` 非空  ⇒ 主区是**照片网格**（走通用浏览通路，预览 / 信息面板全套可用）
   *   `currentTagNode` 非空 ⇒ 主区是**标签卡片**（分类 / 子类下钻）
   *   都为空            ⇒ 主区是**分类总览**卡片
   * 🔴 为什么父节点不给照片网格（见 `tag-nav-ui.js` 文件头）：那要做
   *    `WHERE tag_id IN (…) GROUP BY photo_id`，在满索引（≈9000 万行）上是几十秒的
   *    主线程阻塞，界面上与「点了没反应」无法区分。
   */
  currentTag: '',
  currentTagNode: '',
  currentTagNodeKind: '',
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
  pathBar: $('#pathBar'),
  pathBack: $('#pathBack'),
  pathForward: $('#pathForward'),
  pathUp: $('#pathUp'),
  statsBar: $('#statsBar'),
  scanProgress: $('#taskPanel'),
  taskScanText: $('#taskScanText'),
  taskScanCount: $('#taskScanCount'),
  taskScanFill: $('#taskScanFill'),
  taskScanFile: $('#taskScanFile'),
  toolbar: $('#toolbar'),
  currentPath: $('#currentPath'),
  mediaFilterSelect: $('#mediaFilterSelect'),
  sortSelect: $('#sortSelect'),
  photoGrid: $('#photoGrid'),
  pagination: $('#pagination'),
  pageInfo: $('#pageInfo'),
  prevPage: $('#prevPage'),
  nextPage: $('#nextPage'),
  randomPageBtn: $('#randomPageBtn'),
  // 底栏右侧那三个「标签 + 下拉」：可见性挂在**外层 field** 上（标签要跟着一起收），
  // 读数/提交在里面的 select 上。见 ui-navigation.js 的 setBrowseGridControlsVisible。
  browseGridStyleControl: $('#browseGridStyleControl'),
  pageSizeControl: $('#pageSizeControl'),
  zoomControl: $('#zoomControl'),
  browseGridStyleSelect: $('#browseGridStyleSelect'),
  browsePageSizeSelect: $('#browsePageSizeSelect'),
  browseCardSizeSelect: $('#browseCardSizeSelect'),
  previewOverlay: $('#previewOverlay'),
  previewBody: $('#previewBody'),
  previewImage: $('#previewImage'),
  previewVideo: $('#previewVideo'),
  previewVideoCenterPlay: $('#previewVideoCenterPlay'),
  previewLiveVideo: $('#previewLiveVideo'),
  previewLiveBtn: $('#previewLiveBtn'),
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
  homePage: $('#homePage'),
  // 首页库概览统计带的四个值节点（数据源是 state.stats，见 renderHomeStats）
  homeStatPhotos: $('#homeStatPhotos'),
  homeStatVideos: $('#homeStatVideos'),
  homeStatSize: $('#homeStatSize'),
  homeStatFolders: $('#homeStatFolders'),
  contentArea: $('#contentArea'),
  settingsAddBtn: $('#settingsAddBtn'),
  settingsRescanAllBtn: $('#settingsRescanAllBtn'),
  settingsFolderList: $('#settingsFolderList'),
  settingAutoScan: $('#settingAutoScan'),
  settingAutoThumbBackfillOnStartup: $('#settingAutoThumbBackfillOnStartup'),
  settingAutoHashOnStartup: $('#settingAutoHashOnStartup'),
  settingAutoSemanticIndexOnStartup: $('#settingAutoSemanticIndexOnStartup'),
  settingAutoFaceIndexOnStartup: $('#settingAutoFaceIndexOnStartup'),
  settingLaunchDefaultPage: $('#settingLaunchDefaultPage'),
  settingTunnelEnabled: $('#settingTunnelEnabled'),
  thumbBackfillStatus: $('#thumbBackfillStatus'),
  thumbBackfillStartBtn: $('#thumbBackfillStartBtn'),
  thumbBackfillCancelBtn: $('#thumbBackfillCancelBtn'),
  thumbBackfillExportFailedBtn: $('#thumbBackfillExportFailedBtn'),
  thumbRebuildStatus: $('#thumbRebuildStatus'),
  thumbRebuildStartBtn: $('#thumbRebuildStartBtn'),
  thumbRebuildCancelBtn: $('#thumbRebuildCancelBtn'),
  duplicateHashStartBtn: $('#duplicateHashStartBtn'),
  duplicateHashCancelBtn: $('#duplicateHashCancelBtn'),
  gotoSimilarBtn: $('#gotoSimilarBtn'),
  maintenanceStatus: $('#maintenanceStatus'),
  duplicateHashStatus: $('#duplicateHashStatus'),
  maintenanceCleanupBtn: $('#maintenanceCleanupBtn'),
  maintenanceRebuildThumbFlagsBtn: $('#maintenanceRebuildThumbFlagsBtn'),
  maintenanceOptimizeBtn: $('#maintenanceOptimizeBtn'),
  previewFavoriteBtn: $('#previewFavoriteBtn'),
  // 组织元数据：预览里的「整理」抽屉（标记三连 + 五颗星 + 收藏 + 标签 + 对比）
  // 与它的入口按钮。
  // ⚠️ 星标容器只登记**容器**（`previewRatingStars`）：5 颗星由容器内的
  // `[data-rating]` 遍历得到，登记 5 个 id 等于把「几颗星」写进两处。
  // ⚠️ 入口按钮的 id 是 `previewOrgBtn` 而不是旧的 `previewTagsBtn`：它开的是
  // 整个「整理」抽屉，不再只是标签面板 —— 旧名会让下一个读代码的人以为它只管标签。
  previewFlagPickBtn: $('#previewFlagPickBtn'),
  previewFlagRejectBtn: $('#previewFlagRejectBtn'),
  previewFlagClearBtn: $('#previewFlagClearBtn'),
  previewRatingStars: $('#previewRatingStars'),
  previewOrgBtn: $('#previewOrgBtn'),
  previewOrgPanel: $('#previewOrgPanel'),
  previewOrgPanelClose: $('#previewOrgPanelClose'),
  previewOrgTagsChips: $('#previewOrgTagsChips'),
  previewOrgTagsInput: $('#previewOrgTagsInput'),
  previewOrgTagsAddBtn: $('#previewOrgTagsAddBtn'),
  // 组织元数据：工具条筛选（评分 / 标记 / 标签）
  orgFilterRatingSelect: $('#orgFilterRatingSelect'),
  orgFilterFlagSelect: $('#orgFilterFlagSelect'),
  orgFilterTagsBtn: $('#orgFilterTagsBtn'),
  orgFilterTagsPanel: $('#orgFilterTagsPanel'),
  orgFilterTagsList: $('#orgFilterTagsList'),
  orgFilterTagsClose: $('#orgFilterTagsClose'),
  orgFilterClearBtn: $('#orgFilterClearBtn'),
  // 编辑三连（P0 旋转 / 翻转 · P1 裁剪）。显隐随当前这张走，见 syncPreviewEditButtons()。
  previewRotateBtn: $('#previewRotateBtn'),
  previewFlipBtn: $('#previewFlipBtn'),
  previewCropBtn: $('#previewCropBtn'),
  previewEditSaveBtn: $('#previewEditSaveBtn'),
  previewEditDiscardBtn: $('#previewEditDiscardBtn'),
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
  aiSearchModes: $('#aiSearchModes'),
  aiSearchModeKeyword: $('#aiSearchModeKeyword'),
  aiSearchModeSemantic: $('#aiSearchModeSemantic'),
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
  var next = presets[startIdx];
  if (!next) return;
  try {
    // ⚠️ 必须把预设展开成三元组一起提交：主进程只认三元组，themeStyle 只是派生标签
    var r = await api.updateSettings({
      themeStyle: next.id,
      theme: next.theme,
      uiAccent: next.uiAccent,
      uiBackground: next.uiBackground,
    });
    syncAppearanceFromSettings(r);
    setGeneralSettingsAppliedFromObject(r);
    syncAppearanceControls(r);
    if (dom.settingAutoScan) dom.settingAutoScan.checked = !!r.autoScanOnStartup;
    if (dom.settingAutoThumbBackfillOnStartup)
      dom.settingAutoThumbBackfillOnStartup.checked = !!r.autoThumbBackfillOnStartup;
    if (dom.settingAutoHashOnStartup) dom.settingAutoHashOnStartup.checked = !!r.autoHashOnStartup;
    if (dom.settingAutoSemanticIndexOnStartup)
      dom.settingAutoSemanticIndexOnStartup.checked = !!r.autoSemanticIndexOnStartup;
    if (dom.settingAutoFaceIndexOnStartup)
      dom.settingAutoFaceIndexOnStartup.checked = !!r.autoFaceIndexOnStartup;
  } catch (e) {
    appAlert(
      tUiFmt(
        'theme.switchFailFmt',
        { err: e && e.message ? e.message : String(e) },
        '切换界面风格失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
  }
}

/**
 * 读「界面风格 / 强调色 / 背景基调」控件，得出最终外观三元组。
 *
 * 规则：风格下拉指向具体预设 → 以预设三元组为准（用户刚选了整套预设）；
 * 下拉是空串（自定义组合）→ 以强调色 / 背景两个控件为准。
 * 防御：下拉仍是预设、但两个控件与预设不符（说明联动没跟上，例如脚本直接改了控件值）时
 * 以控件为准 —— **绝不吞掉用户刚改的那一维**。
 */
function getAppearanceControlValue() {
  var accentEl = document.getElementById('settingUiAccent');
  var bgEl = document.getElementById('settingUiBackground');
  var texEl = document.getElementById('settingUiTexture');
  var opaEl = document.getElementById('settingUiOpacity');
  var wbdEl = document.getElementById('settingUiWindowBackdrop');
  var styleId = getThemeStyleControlValue();
  var preset = appearanceUi.resolveThemeTriple ? appearanceUi.resolveThemeTriple(styleId) : null;
  var curTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  // 纹理（第三维）/ 透明度（第五维）/ 窗口背景（窗口级开关）都**不属于任何预设**，
  // 两条分支都必须原样带着它们走，否则「套预设」或「改强调色」会把用户选的纹理 /
  // 透明度 / 窗口背景静默清回 none / opaque / solid。
  var texture = normalizeUiTexture(texEl ? texEl.value : undefined);
  var opacity = normalizeUiOpacity(opaEl ? opaEl.value : undefined);
  var windowBackdrop = normalizeUiWindowBackdrop(wbdEl ? wbdEl.value : undefined);
  if (preset) {
    var cAccent = accentEl ? normalizeUiAccent(accentEl.value) : preset.uiAccent;
    var cBg = bgEl ? normalizeUiBackground(bgEl.value) : preset.uiBackground;
    if (cAccent === preset.uiAccent && cBg === preset.uiBackground) {
      return {
        themeStyle: styleId,
        theme: preset.theme,
        uiAccent: preset.uiAccent,
        uiBackground: preset.uiBackground,
        uiTexture: texture,
        uiOpacity: opacity,
        uiWindowBackdrop: windowBackdrop,
      };
    }
  }
  var accent = normalizeUiAccent(accentEl ? accentEl.value : undefined);
  var bg = normalizeUiBackground(bgEl ? bgEl.value : undefined);
  return {
    themeStyle: appearanceUi.inferThemeStyleFromTriple
      ? appearanceUi.inferThemeStyleFromTriple(curTheme, accent, bg)
      : '',
    theme: curTheme,
    uiAccent: accent,
    uiBackground: bg,
    uiTexture: texture,
    uiOpacity: opacity,
    uiWindowBackdrop: windowBackdrop,
  };
}

/** 回显外观五个控件；风格下拉由三元组反推（凑不出任何预设 → 空串「自定义组合」） */
function syncAppearanceControls(s) {
  if (!s) return;
  var theme = s.theme === 'light' ? 'light' : 'dark';
  var accent = normalizeUiAccent(s.uiAccent);
  var bg = normalizeUiBackground(s.uiBackground);
  var texture = normalizeUiTexture(s.uiTexture);
  var opacity = normalizeUiOpacity(s.uiOpacity);
  var windowBackdrop = normalizeUiWindowBackdrop(s.uiWindowBackdrop);
  var styleId = appearanceUi.inferThemeStyleFromTriple
    ? appearanceUi.inferThemeStyleFromTriple(theme, accent, bg)
    : normalizeThemeStyle(s.themeStyle);
  var stEl = document.getElementById('settingThemeStyle');
  if (stEl) stEl.value = styleId;
  // 顶栏下拉：没有 value="" 的死选项，所以凑不出预设时要落到「强调色」组里当前那一项，
  // 否则 .value 会设成一个不存在的值 → selectedIndex 变 -1、收起状态一片空白。
  var qtEl = document.getElementById('quickThemeStyle');
  if (qtEl) {
    qtEl.value = themeOptionForTriple(theme, accent, bg);
    if (qtEl.selectedIndex < 0) qtEl.selectedIndex = 0;
  }
  var acEl = document.getElementById('settingUiAccent');
  if (acEl) acEl.value = accent;
  var bgEl = document.getElementById('settingUiBackground');
  if (bgEl) bgEl.value = bg;
  var texEl = document.getElementById('settingUiTexture');
  if (texEl) texEl.value = texture;
  var opaEl = document.getElementById('settingUiOpacity');
  if (opaEl) opaEl.value = opacity;
  // 窗口背景只有设置页一处控件（不进顶栏 → 也不参与触发按钮的后缀文案）
  var wbdEl = document.getElementById('settingUiWindowBackdrop');
  if (wbdEl) wbdEl.value = windowBackdrop;
  // 「改了但还没重启」提示：只有拿到主进程给的「已生效值」才敢判断；拿不到（本层自己拼的
  // 对象，例如回滚路径）就**不动**这个提示 —— 否则会误报或误清。
  var wbdHintEl = document.getElementById('settingWindowBackdropRestartHint');
  if (wbdHintEl && s.uiWindowBackdropApplied != null) {
    wbdHintEl.hidden = windowBackdrop === normalizeUiWindowBackdrop(s.uiWindowBackdropApplied);
  }
  // 顶栏触发按钮的文案镜像 select 的选中项 —— 每次回显都跟着刷一遍
  syncQuickThemeTrigger();
}

function normalizeUiAccent(a) {
  return appearanceUi.normalizeUiAccent(a);
}

function normalizeUiBackground(b) {
  return appearanceUi.normalizeUiBackground(b);
}

function normalizeUiTexture(t) {
  return appearanceUi.normalizeUiTexture(t);
}

function normalizeUiOpacity(o) {
  return appearanceUi.normalizeUiOpacity(o);
}

function normalizeUiWindowBackdrop(b) {
  return appearanceUi.normalizeUiWindowBackdrop(b);
}

/**
 * 用户主动选了某个「界面风格」预设 → 把预设展开写进三个控件（两维 + 另一个风格下拉）。
 *
 * 🔴 这一步不是"回显"，是**语义**。`getAppearanceControlValue()` 的规则是：
 *   风格下拉=具体预设 → 拿「强调色 / 背景基调」的**当前控件值**与预设比对，
 *   一致才采纳预设；不一致就退回「以控件为准」（为了保护"只改一维"的场景，不能反转）。
 * 而用户点预设时，这两个控件还停在**上一套的残留值**上 → 判不相等 → 退回控件分支 →
 * 推出的三元组与保存前逐位相同 → `persistGeneralSettingsFromControls` 的变更检测判
 * 「无变化」→ **整次切换被静默吞掉**（症状：切界面风格毫无反应，且两个风格下拉各自停在
 * 不同的值上）。展开后控件与预设一致，预设才真的被采纳。
 *
 * 两个风格下拉也一起对齐：`getThemeStyleControlValue()` 在焦点判定失效时会回落读
 * `#settingThemeStyle`，只写触发的那一个会让它读到**旧预设** → 又退回控件分支 →
 * 明暗维度（theme）会跟着丢。
 *
 * 顶栏下拉把「强调色 / 背景基调」也做成了可选项（值为 `accent:<id>` / `bg:<id>` 前缀），
 * 这里解析前缀 → 只改对应那一维，另一维保持用户当前选择（这就是「自定义」的语义）。
 */
var THEME_OPTION_ACCENT_PREFIX = 'accent:';
var THEME_OPTION_BG_PREFIX = 'bg:';
var THEME_OPTION_TEXTURE_PREFIX = 'texture:';
var THEME_OPTION_OPACITY_PREFIX = 'opacity:';

/**
 * 顶栏下拉里「只改某一维」的选项（值为 `<维>:<id>`）→ 目标控件 + 归一函数。
 * 各前缀共用一份解析，避免在 expandThemePresetToControls / resolveQuickThemeOptionTriple
 * 各写一套 if 链（加第五维时必然漏一处）。
 * @returns {{raw:string, elId:string, norm:Function}|null}
 */
function resolveThemeOptionDimension(raw) {
  var s = String(raw == null ? '' : raw);
  var table = [
    [THEME_OPTION_ACCENT_PREFIX, 'settingUiAccent', normalizeUiAccent],
    [THEME_OPTION_BG_PREFIX, 'settingUiBackground', normalizeUiBackground],
    [THEME_OPTION_TEXTURE_PREFIX, 'settingUiTexture', normalizeUiTexture],
    [THEME_OPTION_OPACITY_PREFIX, 'settingUiOpacity', normalizeUiOpacity],
  ];
  for (var i = 0; i < table.length; i++) {
    if (s.indexOf(table[i][0]) === 0) {
      return { raw: s.slice(table[i][0].length), elId: table[i][1], norm: table[i][2] };
    }
  }
  return null;
}

/** 顶栏下拉的回显值：能凑出预设就用预设 id，否则落到「强调色」组里当前那一项 */
function themeOptionForTriple(theme, accent, bg) {
  var presetId = appearanceUi.inferThemeStyleFromTriple
    ? appearanceUi.inferThemeStyleFromTriple(theme, accent, bg)
    : '';
  if (presetId) return presetId;
  return THEME_OPTION_ACCENT_PREFIX + normalizeUiAccent(accent);
}

function expandThemePresetToControls(id) {
  var raw = String(id == null ? '' : id);
  var dim = resolveThemeOptionDimension(raw);
  if (dim) {
    var target = document.getElementById(dim.elId);
    if (target) target.value = dim.norm(dim.raw);
    // 其余维不动：控件与下拉值不再自洽，save 时走「以控件为准」分支 → 正是想要的结果
    return true;
  }
  var preset = appearanceUi.resolveThemeTriple ? appearanceUi.resolveThemeTriple(raw) : null;
  if (!preset) return false;
  var styleIds = ['settingThemeStyle', 'quickThemeStyle'];
  for (var i = 0; i < styleIds.length; i++) {
    var el = document.getElementById(styleIds[i]);
    if (el) el.value = raw;
  }
  var acEl = document.getElementById('settingUiAccent');
  if (acEl) acEl.value = preset.uiAccent;
  var bgEl = document.getElementById('settingUiBackground');
  if (bgEl) bgEl.value = preset.uiBackground;
  // ⚠️ 预设**不含**纹理 / 透明度这两维 → 这里绝不能碰 #settingUiTexture / #settingUiOpacity，
  // 否则套一次预设就把它们清了
  return true;
}

/* ============================================================================
 * 顶栏「界面风格」自建弹层 —— 鼠标悬浮即预览
 * ============================================================================
 * 为什么必须自建：#quickThemeStyle 是原生 <select>，而 Windows 上它展开的列表由**系统弹出
 * 菜单**渲染，<option> 不是可命中的 DOM 元素 → mouseover / mouseenter 根本派发不到 JS。
 * 「鼠标划过主题名即预览」用原生控件实现不了，这是平台限制而非代码问题。
 *
 * 数据源仍然只有那一个 <select>：弹层**每次打开**从它的 <optgroup>/<option> 动态重建
 * （连文案都直接取，跟着 i18n 走），点选时写回 select.value 并派发 change → 完全复用既有
 * 落库链路（expandThemePresetToControls + persistGeneralSettingsFromControls）。
 * 所以**不存在第二份主题名列表**，也就不会有「预设加了、弹层忘了加」这种漂移。
 *
 * 🔴 三条不可动摇的规则：
 *   1. 预览**绝不落库**：预览路径里不许出现 persistGeneralSettingsFromControls。
 *   2. 预览**绝不写启动快照**：一律 `syncAppearanceFromSettings(triple, { skipSnapshot: true })`。
 *      否则鼠标扫过 18 项就会把启动首帧快照写成最后扫到的那个主题（刷新/崩溃后首帧变样）。
 *   3. 还原回到**会话开始时采集的真实三元组**，不能拿"上一个预览值"当基线 ——
 *      否则连续 hover 会一轮轮叠上去、还原不回去。
 * ========================================================================== */

/** 悬浮多久才真的预览：防「鼠标划过去时闪一串颜色」，同时保持跟手 */
var QUICK_THEME_PREVIEW_DELAY_MS = 90;

var quickThemePreview = {
  active: false, // 是否已经改过 html 属性（决定还原时要不要写回）
  snapshot: null, // 会话开始时的真实三元组（未被预览污染）
  timer: 0, // 悬浮停留计时器
  hoverValue: null, // 最后一次悬浮到的 option 值
};

/** 读 html 上的真实三元组 —— 只在预览会话开始时调用（那一刻一定还没被预览改过） */
function readAppliedAppearanceTriple() {
  var root = document.documentElement;
  return {
    theme: root.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
    uiAccent: normalizeUiAccent(root.getAttribute('data-accent')),
    // ⚠️ bg 不存在时 getAttribute 返回 null，normalizeUiBackground 会落成 'default' —— 正好
    uiBackground: normalizeUiBackground(root.getAttribute('data-bg')),
    // 纹理同理：关闭态不设属性 → null → 'none'。🔴 必须带上这一维，
    // 否则悬浮预览结束时按快照还原会把纹理清掉（快照缺字段 = 还原成 none）。
    uiTexture: normalizeUiTexture(root.getAttribute('data-texture')),
    // 透明度同理：opaque 档不设属性 → null → 'opaque'。
    uiOpacity: normalizeUiOpacity(root.getAttribute('data-opacity')),
    // 🔴 窗口背景**也必须带上**，理由同上（且后果更难看）：solid 档不设属性 → null → 'solid'。
    // 快照缺这个字段 → 鼠标扫一遍顶栏主题再移开，还原时会把数据属性抹掉，
    // 「亚克力」的窗口当场从「透」变回「不透」——而窗口本身还是透明的（两半失配）。
    uiWindowBackdrop: normalizeUiWindowBackdrop(root.getAttribute('data-window-backdrop')),
  };
}

/** option 值 → 完整外观：预设取预设表；accent: / bg: / texture: / opacity: 前缀只换那一维（其余取 base） */
function resolveQuickThemeOptionTriple(value, base) {
  var raw = String(value == null ? '' : value);
  if (!raw) return null;
  var dim = resolveThemeOptionDimension(raw);
  if (dim) {
    var next = {
      theme: base.theme,
      uiAccent: base.uiAccent,
      uiBackground: base.uiBackground,
      uiTexture: base.uiTexture,
      uiOpacity: base.uiOpacity,
      // 窗口背景不在顶栏菜单里，但**预览也要原样带着它** —— 它同样是 syncAppearanceFromSettings
      // 的输入，缺了就在「鼠标划过主题」这一刻被清成 solid。
      uiWindowBackdrop: base.uiWindowBackdrop,
    };
    if (raw.indexOf(THEME_OPTION_ACCENT_PREFIX) === 0) next.uiAccent = dim.norm(dim.raw);
    else if (raw.indexOf(THEME_OPTION_BG_PREFIX) === 0) next.uiBackground = dim.norm(dim.raw);
    else if (raw.indexOf(THEME_OPTION_TEXTURE_PREFIX) === 0) next.uiTexture = dim.norm(dim.raw);
    else next.uiOpacity = dim.norm(dim.raw);
    return next;
  }
  var preset = appearanceUi.resolveThemeTriple ? appearanceUi.resolveThemeTriple(raw) : null;
  if (!preset) return null;
  // 纹理 / 透明度 / 窗口背景都是**正交维度**、不属于预设 → 套预设时原样保留
  // （否则悬浮预览一下就把它们弄丢了）
  return {
    theme: preset.theme,
    uiAccent: preset.uiAccent,
    uiBackground: preset.uiBackground,
    uiTexture: base.uiTexture,
    uiOpacity: base.uiOpacity,
    uiWindowBackdrop: base.uiWindowBackdrop,
  };
}

function cancelQuickThemeHoverTimer() {
  if (quickThemePreview.timer) {
    clearTimeout(quickThemePreview.timer);
    quickThemePreview.timer = 0;
  }
}

/** 悬浮进入某项：延迟一下再预览（快速划过的项不会被预览） */
function scheduleQuickThemePreview(value) {
  var v = String(value == null ? '' : value);
  // 同一项内部移动（进出子元素也会触发 mouseover）不重新计时，否则永远等不到预览
  if (quickThemePreview.hoverValue === v) return;
  cancelQuickThemeHoverTimer();
  quickThemePreview.hoverValue = v;
  quickThemePreview.timer = setTimeout(function () {
    quickThemePreview.timer = 0;
    previewQuickThemeOption(quickThemePreview.hoverValue);
  }, QUICK_THEME_PREVIEW_DELAY_MS);
}

/** 真正做预览：只改 html 属性 —— 不落库、不写快照 */
function previewQuickThemeOption(value) {
  var menu = document.getElementById('quickThemeMenu');
  if (!menu || menu.hidden) return;
  if (!quickThemePreview.snapshot) quickThemePreview.snapshot = readAppliedAppearanceTriple();
  var triple = resolveQuickThemeOptionTriple(value, quickThemePreview.snapshot);
  if (!triple) return;
  quickThemePreview.active = true;
  syncAppearanceFromSettings(triple, { skipSnapshot: true });
  markQuickThemeOptionPreviewing(String(value));
}

/** 结束预览并还原。在"从未预览过"时是安全的 no-op */
function endQuickThemePreview() {
  cancelQuickThemeHoverTimer();
  quickThemePreview.hoverValue = null;
  var snap = quickThemePreview.snapshot;
  var wasActive = quickThemePreview.active;
  quickThemePreview.active = false;
  quickThemePreview.snapshot = null;
  if (wasActive && snap) syncAppearanceFromSettings(snap, { skipSnapshot: true });
  markQuickThemeOptionPreviewing(null);
}

/** 标出「正在预览」的项 —— 让用户分得清"预览"与"已生效" */
function markQuickThemeOptionPreviewing(value) {
  var menu = document.getElementById('quickThemeMenu');
  if (!menu) return;
  var items = menu.querySelectorAll('[data-theme-option]');
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (value != null && it.getAttribute('data-theme-option') === value) it.classList.add('is-previewing');
    else it.classList.remove('is-previewing');
  }
}

/** 标出「当前生效」的项 */
function markQuickThemeOptionSelected(value) {
  var menu = document.getElementById('quickThemeMenu');
  if (!menu) return;
  var want = String(value == null ? '' : value);
  var items = menu.querySelectorAll('[data-theme-option]');
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var on = it.getAttribute('data-theme-option') === want;
    if (on) {
      it.classList.add('is-selected');
      it.setAttribute('aria-selected', 'true');
    } else {
      it.classList.remove('is-selected');
      it.setAttribute('aria-selected', 'false');
    }
  }
}

/**
 * 把「正交维度」当前生效的名字缀到触发按钮文案后面（「夜幕经典 · 木纹 · 通透」）。
 *
 * 纹理（第三维）与透明度（第五维）都**不属于预设** → 顶栏 select 的选中值只能落在
 * 「风格 / 强调色」那一支上，于是用户刚点完「木纹」，按钮文案会立刻跳回风格名，
 * **看起来像没生效**。后缀上去之后，生效与否一眼可见。
 *
 * @param {string} text 基础文案
 * @param {Array<[string, Function, string]>} dims `[控件 id, 归一函数, 关闭态值]`
 */
function appendOrthogonalDimensionLabels(text, dims) {
  for (var i = 0; i < dims.length; i++) {
    var el = document.getElementById(dims[i][0]);
    if (!el) continue;
    var val = dims[i][1](el.value);
    if (val === dims[i][2]) continue; // 关闭态（none / opaque）不缀
    var opt = el.options[el.selectedIndex];
    var name = opt ? String(opt.textContent || '').trim() : val;
    if (name && text.indexOf(name) < 0) text = text ? text + ' · ' + name : name;
  }
  return text;
}

/** 触发按钮文案 = 当前 select 选中项的文字（自动跟随 i18n，绝不在这里写死主题名） */
function syncQuickThemeTrigger() {
  var sel = document.getElementById('quickThemeStyle');
  var label = document.getElementById('quickThemeStyleLabel');
  if (sel && label) {
    var opt = sel.options[sel.selectedIndex];
    var text = opt ? String(opt.textContent || '').trim() : '';
    text = appendOrthogonalDimensionLabels(text, [
      ['settingUiTexture', normalizeUiTexture, 'none'],
      ['settingUiOpacity', normalizeUiOpacity, 'opaque'],
    ]);
    label.textContent = text;
  }
  var menu = document.getElementById('quickThemeMenu');
  if (menu && !menu.hidden) markQuickThemeOptionSelected(sel ? sel.value : '');
}

/**
 * 从 <select> 重建弹层内容 —— **每次打开都重建**。
 * 这样项文案永远跟随当前语言（i18n 改了 option 的 textContent，我们不缓存它），
 * 且新增预设只需改 index.html 那一处，弹层自动跟上。
 */
function buildQuickThemeMenu() {
  var sel = document.getElementById('quickThemeStyle');
  var menu = document.getElementById('quickThemeMenu');
  if (!sel || !menu) return;
  var current = String(sel.value || '');
  var frag = document.createDocumentFragment();
  var groups = sel.querySelectorAll('optgroup');
  for (var g = 0; g < groups.length; g++) {
    var grp = groups[g];
    var head = document.createElement('div');
    head.className = 'theme-menu-group';
    head.setAttribute('role', 'presentation');
    head.textContent = String(grp.getAttribute('label') || '');
    frag.appendChild(head);
    var opts = grp.querySelectorAll('option');
    for (var o = 0; o < opts.length; o++) {
      frag.appendChild(buildQuickThemeMenuItem(opts[o], current));
    }
  }
  menu.replaceChildren(frag);
}

function buildQuickThemeMenuItem(optEl, current) {
  var value = String(optEl.value || '');
  var item = document.createElement('div');
  item.className = 'theme-menu-item';
  item.setAttribute('role', 'option');
  item.setAttribute('data-theme-option', value);
  item.setAttribute('tabindex', '-1');
  var isSel = value === current;
  item.setAttribute('aria-selected', isSel ? 'true' : 'false');
  if (isSel) item.classList.add('is-selected');
  var text = document.createElement('span');
  text.className = 'theme-menu-item-label';
  text.textContent = String(optEl.textContent || '').trim();
  item.appendChild(text);
  return item;
}

/**
 * 弹层定位：贴着按钮，且**翻不出视口**。
 * 弹层是 position:fixed 且挂在 body 下（不在 .topbar 里）—— .topbar 带 backdrop-filter，
 * 会给 position:fixed 的后代创建**新的包含块**，放里面会以 56px 高的顶栏为参考系而整体错位。
 */
function positionQuickThemeMenu() {
  var menu = document.getElementById('quickThemeMenu');
  var btn = document.getElementById('quickThemeStyleButton');
  if (!menu || !btn || menu.hidden) return;
  var r = btn.getBoundingClientRect();
  var mw = menu.offsetWidth;
  var mh = menu.offsetHeight;
  var vw = document.documentElement.clientWidth;
  var vh = document.documentElement.clientHeight;
  var gap = 6;
  var left = r.right - mw; // 右对齐按钮：顶栏右侧没有别的元素会被盖住
  if (left > vw - mw - 8) left = vw - mw - 8;
  if (left < 8) left = 8;
  var top = r.bottom + gap;
  if (top + mh > vh - 8) {
    var above = r.top - gap - mh; // 下面放不下就翻到按钮上方
    top = above >= 8 ? above : Math.max(8, vh - 8 - mh);
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

function openQuickThemeMenu() {
  var menu = document.getElementById('quickThemeMenu');
  var btn = document.getElementById('quickThemeStyleButton');
  if (!menu || !btn || !menu.hidden) return;
  buildQuickThemeMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  positionQuickThemeMenu();
  // 焦点落到当前生效项：方向键才有起点，也避免"打开后焦点还在按钮上"的双焦点
  var sel = document.getElementById('quickThemeStyle');
  focusQuickThemeOption(sel ? String(sel.value || '') : '');
}

function closeQuickThemeMenu() {
  var menu = document.getElementById('quickThemeMenu');
  var btn = document.getElementById('quickThemeStyleButton');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function quickThemeMenuItems() {
  var menu = document.getElementById('quickThemeMenu');
  return menu ? Array.prototype.slice.call(menu.querySelectorAll('[data-theme-option]')) : [];
}

function focusQuickThemeOption(value) {
  var items = quickThemeMenuItems();
  if (!items.length) return;
  var want = String(value == null ? '' : value);
  var idx = 0;
  for (var i = 0; i < items.length; i++) {
    if (items[i].getAttribute('data-theme-option') === want) {
      idx = i;
      break;
    }
  }
  setQuickThemeFocus(items, idx);
}

/**
 * 键盘移动：只挪 roving 焦点 + 预览，**绝不动 select.value**（动它就是落库了）。
 * 键盘是明确意图，所以这里**立即**预览，不走那 90ms 的防误触延迟。
 */
function setQuickThemeFocus(items, idx) {
  if (!items.length) return;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  for (var i = 0; i < items.length; i++) {
    var on = i === idx;
    items[i].classList.toggle('is-focused', on);
    items[i].setAttribute('tabindex', on ? '0' : '-1');
  }
  var el = items[idx];
  if (!el) return;
  if (typeof el.focus === 'function') el.focus();
  quickThemePreview.hoverValue = el.getAttribute('data-theme-option');
  previewQuickThemeOption(quickThemePreview.hoverValue);
}

/** 点选某项：这是**唯一**会产生落库的入口 */
function commitQuickThemeOption(value) {
  var sel = document.getElementById('quickThemeStyle');
  if (!sel) return;
  cancelQuickThemeHoverTimer();
  closeQuickThemeMenu();
  var next = String(value == null ? '' : value);
  if (sel.value === next) {
    // 点的是当前生效项：不会有落库发生，但界面可能正停在别的预览值上 → 必须还原，
    // 否则会停在预览态、与"当前生效"不符。
    endQuickThemePreview();
    syncQuickThemeTrigger();
    return;
  }
  // 丢弃预览会话状态但**不还原** —— 紧接着的 change 链路会把 html 写成新值，
  // 此刻先还原反而会闪一下旧主题。顺序很重要。
  quickThemePreview.active = false;
  quickThemePreview.snapshot = null;
  quickThemePreview.hoverValue = null;
  sel.value = next;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 绑定触发按钮与弹层的一切交互；由 bindEvents 调用一次 */
function initQuickThemeMenu() {
  var btn = document.getElementById('quickThemeStyleButton');
  var menu = document.getElementById('quickThemeMenu');
  if (!btn || !menu) return;

  syncQuickThemeTrigger();

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (menu.hidden) {
      openQuickThemeMenu();
    } else {
      closeQuickThemeMenu();
      endQuickThemePreview();
    }
  });
  btn.addEventListener('keydown', function (e) {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) {
      e.preventDefault();
      openQuickThemeMenu();
    } else if (e.key === 'Escape' && !menu.hidden) {
      closeQuickThemeMenu();
      endQuickThemePreview();
    }
  });

  menu.addEventListener('mouseover', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('[data-theme-option]') : null;
    if (!item) return;
    scheduleQuickThemePreview(item.getAttribute('data-theme-option'));
  });
  // 移出弹层即还原：预览是临时的，鼠标一离开就该回到当前生效主题
  menu.addEventListener('mouseleave', function () {
    endQuickThemePreview();
  });
  menu.addEventListener('click', function (e) {
    var item = e.target && e.target.closest ? e.target.closest('[data-theme-option]') : null;
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    commitQuickThemeOption(item.getAttribute('data-theme-option'));
  });
  menu.addEventListener('keydown', function (e) {
    var items = quickThemeMenuItems();
    if (!items.length) return;
    var cur = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setQuickThemeFocus(items, cur + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setQuickThemeFocus(items, cur - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setQuickThemeFocus(items, 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setQuickThemeFocus(items, items.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cur >= 0) commitQuickThemeOption(items[cur].getAttribute('data-theme-option'));
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      closeQuickThemeMenu();
      endQuickThemePreview();
      if (e.key === 'Escape' && typeof btn.focus === 'function') btn.focus();
    }
  });

  // 点外部关闭：走 capture 阶段，避免被别处的 stopPropagation 挡掉
  document.addEventListener(
    'mousedown',
    function (e) {
      if (menu.hidden) return;
      var t = e.target;
      if ((t && menu.contains(t)) || (t && btn.contains(t))) return;
      closeQuickThemeMenu();
      endQuickThemePreview();
    },
    true,
  );

  // 窗口尺寸变化：弹层是 fixed 定位，必须跟着按钮挪，否则会飘在原地
  window.addEventListener('resize', function () {
    if (!menu.hidden) positionQuickThemeMenu();
  });

  // 语言切换：i18n 的 applyDom() 末尾会派发 localechange，用它刷新按钮文案与项选中态
  window.addEventListener('localechange', syncQuickThemeTrigger);
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
function syncAppearanceFromSettings(s, options) {
  return appearanceUi.syncAppearanceFromSettings(s, options);
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
        formatThumbSpec: formatThumbSpec,
        onSyncTaskPanelCollapsedUI: syncTaskPanelCollapsedUI,
      });
    },
    onRefreshThumbnailBackfillStatus: refreshThumbnailBackfillStatus,
    onRefreshDuplicateHashStatus: refreshDuplicateHashStatus,
  });
}

/** 管理页上次定位的面板 id（如 settingsSectionStorage） */
var SETTINGS_LAST_SECTION_LS_KEY = 'photoManager.settingsLastSection.v1';
/** 两栏化后的 8 个面板 id，顺序须与 index.html 的 [data-settings-panel] 一致 */
var VALID_SETTINGS_SECTION_IDS = {
  settingsSectionFolders: 1,
  settingsSectionBrowse: 1,
  settingsSectionShortcuts: 1,
  settingsSectionStorage: 1,
  settingsSectionTasks: 1,
  settingsSectionAiIndex: 1,
  settingsSectionAppearance: 1,
  settingsSectionNetwork: 1,
};
/**
 * 历史 id → 当前面板 id。
 * 设置页经历过三次改版（单页 8 区块 → 两栏 6 面板 → 两栏 7 面板），localStorage 里
 * 可能还存着任一代的旧值，直接把老用户丢回默认位置体验很差；这里做一次映射，
 * 写回时也统一存新 id。
 * 注意 `settingsSectionPeople` 在两代里同名，normalize 后仍指向自己，无需别名。
 */
var SETTINGS_SECTION_ID_ALIAS = {
  // 搜图 / 人物这几个名字换过好几代：8 区块时代的「语义 / 人脸」、6 面板时代的
  // 「智能索引」、7 面板时代并进「后台任务」。2026-10-05 第四次改版又把索引从
  // 「后台任务」拆出来、独立成「AI 与索引」—— 这几个老名字一律归一到新面板，
  // 老用户点开就能看到搬过去的「搜图索引 / 人物索引」两节。
  settingsSectionSearch: 'settingsSectionAiIndex',
  settingsSectionPeople: 'settingsSectionAiIndex',
  settingsSectionSemantic: 'settingsSectionAiIndex',
  settingsSectionAi: 'settingsSectionAiIndex',
  // 2026-10-05 第三次改版：「应用」拆成「外观与行为」，另新增独立的「快捷键」面板。
  settingsSectionApp: 'settingsSectionAppearance',
  settingsSectionCloseBehavior: 'settingsSectionAppearance',
  settingsSectionGeneral: 'settingsSectionAppearance',
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
    // 🔴 必须在这一刻**重新取一次落点**，不能沿用闭包里那份 id：
    //    rAF 是延后执行的，画导航（上面那行，同步）与切面板之间隔了一帧。
    //    这一帧里任何别的路径都可能把落点改掉 —— 用户点导航（点击路径会同步
    //    落库 + 切面板）、或自动化脚本直接调 scrollToSettingsSection。
    //    沿用旧 id 就会把**内容**弹回上一个板块，而**导航**已经是新板块 →
    //    「高亮在 A、内容是 B」。重取一次，任何来源的改动都不会被这一帧覆盖。
    //    （实测复现：2026-10-05 截设置页时导航在「应用」、内容却是「媒体库」。）
    var now = getLastSettingsSectionId();
    if (document.getElementById(now)) id = now;
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
  var r = closeChoiceUi.showCloseChoiceOverlay({
    onCloseChoiceOnEscape: closeChoiceOnEscape,
  });
  // 打开弹窗的同时查一次后台任务：有在跑的就把警告行亮出来（异步，不阻塞弹窗出现）。
  refreshCloseChoiceTasksWarning();
  return r;
}

/* ── 退出前的后台任务守门（2026-10-09）────────────────────────────────────
 * 判据与全局任务面板（scan-flow.js）**同源**：scan 块含排队/闸门等待，
 * face 按 phase 取值域、semantic 按 operation 取值域 —— 两处各自抄一份是刻意的：
 * 面板那份管「显隐」，这份管「能不能退」，语义不同；但取值域必须同改
 * （新增长任务时这里不加，退出就会不打招呼地杀掉它 —— 契约 §0 的判据）。
 * 停止通道只挑有 cancel 入口的四个（scan / 补全 / 重建 / 查重指纹）；
 * 「整理数据库」按契约 §11 没有停止入口，只能等它自己收尾（轮询兜底）。 */
var CLOSE_CHOICE_TASK_KEYS = {
  scan: 'task.scanNoun',
  thumbs: 'task.thumbTitle',
  thumbRebuild: 'task.thumbRebuildTitle',
  invalidCleanup: 'task.invalidCleanup',
  optimize: 'settings.task.optimizeDb',
  dupHash: 'task.dupTitle',
  face: 'task.faceTitle',
  semantic: 'task.semanticTitle',
};

async function getActiveBackgroundTaskKeys() {
  if (!(api && api.has && api.has('getBackgroundTasks'))) return [];
  var t;
  try {
    t = await api.getBackgroundTasks();
  } catch (e) {
    return [];
  }
  if (!t) return [];
  var out = [];
  var scan = t.scan || {};
  var prog = scan.progress || {};
  var queue = scan.queue || {};
  var progBusy =
    !!prog.status &&
    prog.status !== 'idle' &&
    prog.status !== 'done' &&
    prog.status !== 'cancelled' &&
    prog.status !== 'error';
  if (
    !!scan.active ||
    progBusy ||
    (queue.pendingCount || 0) > 0 ||
    !!queue.processing ||
    !!(queue.current && queue.current.waitingGate)
  ) {
    out.push('scan');
  }
  if ((t.thumbs || {}).running) out.push('thumbs');
  if ((t.thumbRebuild || {}).running) out.push('thumbRebuild');
  if ((t.invalidCleanup || {}).running) out.push('invalidCleanup');
  if ((t.optimize || {}).running) out.push('optimize');
  if ((t.duplicateHash || {}).running) out.push('dupHash');
  var face = t.face || {};
  if (
    !!face.running &&
    ['install', 'index', 'loading', 'indexing', 'downloading', 'stopping'].indexOf(face.phase) >= 0
  ) {
    out.push('face');
  }
  var semantic = t.semantic || {};
  if (!!semantic.running && ['install', 'index', 'tag'].indexOf(semantic.operation) >= 0) {
    out.push('semantic');
  }
  return out;
}

async function refreshCloseChoiceTasksWarning() {
  var el = document.getElementById('closeChoiceTasksWarning');
  if (!el) return;
  var active = await getActiveBackgroundTaskKeys();
  if (!active.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  var names = [];
  for (var i = 0; i < active.length; i++) {
    names.push(tUi(CLOSE_CHOICE_TASK_KEYS[active[i]] || '', active[i]));
  }
  /* 顿号走 `common.listSep`（中英两包都有：中文「、」/ 英文「, 」），
     与 6674/6910 那几处列表拼接同一份来源 —— 本文件全域禁止裸中文字面量
     （英文界面会直接漏出中文），守护 `background-tasks-panel-regression` 会抓。 */
  var listSep = tUi('common.listSep', '、');
  el.hidden = false;
  el.textContent = tUiFmt(
    'closeOverlay.tasksRunning',
    { n: active.length, list: names.join(listSep) },
    '有 ' +
      active.length +
      ' 项后台任务正在运行（' +
      names.join(listSep) +
      '）。点「退出程序」会先停止它们，停干净后自动退出。',
  );
}

async function stopBackgroundTasksBeforeQuit() {
  var active = await getActiveBackgroundTaskKeys();
  if (!active.length) return true;
  var stops = [];
  if (active.indexOf('scan') >= 0 && api.has && api.has('cancelScan')) {
    stops.push(api.cancelScan());
  }
  if (active.indexOf('thumbs') >= 0 && api.has && api.has('cancelThumbnailBackfill')) {
    stops.push(api.cancelThumbnailBackfill());
  }
  if (active.indexOf('thumbRebuild') >= 0 && api.has && api.has('cancelThumbnailRebuild')) {
    stops.push(api.cancelThumbnailRebuild());
  }
  if (
    active.indexOf('dupHash') >= 0 &&
    api.has &&
    api.has('maintenanceCancelDuplicateHashDetection')
  ) {
    stops.push(api.maintenanceCancelDuplicateHashDetection());
  }
  // 停止请求本身失败不拦退出 —— 后面的轮询才是判停真相源
  await Promise.all(
    stops.map(function (p) {
      return Promise.resolve(p).catch(function () {
        return null;
      });
    }),
  );
  // §8 判停：轮询到全部退出「在跑」为止；20 秒停不干净就放弃本次退出（宁可留着，不硬杀）
  var deadline = Date.now() + 20000;
  for (;;) {
    var still = await getActiveBackgroundTaskKeys();
    if (!still.length) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(function (r) {
      setTimeout(r, 500);
    });
  }
}

async function submitCloseChoice(action) {
  if (action === 'quit') {
    var btn = document.getElementById('closeChoiceQuitBtn');
    var stopped = await stopBackgroundTasksBeforeQuit();
    if (!stopped) {
      if (btn) btn.disabled = false;
      appAlert(
        tUi(
          'closeOverlay.stopTimeout',
          '后台任务未能在限时内停止，已取消本次退出。可在任务面板手动停止后再退出。',
        ),
      );
      return;
    }
  }
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

  // 数据目录迁移的进度推送（只在迁移期间有）；注册一次即可，与是否在设置页无关。
  bindDataDirProgressListener();

  // 主进程发起的提示 / 确认：由这里画成主题弹窗并回执（见 bindAppDialogRequests）。
  bindAppDialogRequests();

  // 监听自动扫描开始的信号
  api.onScanStart(function () {
    state.isScanning = true;
    if (dom.scanProgress) dom.scanProgress.style.display = 'block';
    updateProgress(0, 1, tUi('task.scanPreparing', '准备中...'));
    startScanLiveRefresh();
    // 待扫描的根目录在扫描一开始就已登记进 root_folders（见 scanner.js 的 addRootFolder 位置），
    // 设置页此刻拉着刷一次，新目录不必干等 scanLiveRefresh 那一拍 3 秒。即便这一拍还没读到
    // （worker 刚起、登记尚未落库），后面有 3 秒轮询兜底，不会白刷。
    if (state.currentTab === 'settings') {
      void loadRootFolders(true, true);
    }
    tickBackgroundTasksOnce();
  });

  // 监听自动扫描完成的信号
  api.onScanComplete(async function (folderPath, result) {
    state.isScanning = false;
    stopScanLiveRefresh();
    if (result && result.error) {
      appAlert(
        tUiFmt('task.autoScanFailed', { err: result.error }, '自动扫描失败：' + result.error),
      );
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

  // 启动期把 主题标签补写进索引库后（只在真的补到标签时才推）重画信息面板。
  // 标签存在搜图索引库里、不是 photos 的列，所以没有任何别的路径能让它自己变新：
  // 不接这个通知，用户就得切走再切回才看得到。面板没开时也照调 ——
  // refreshOpenPreviewInfoPanel() 自带「没开就返回」的守卫，不会白拉一次磁盘。
  api.onAiTagsUpdated(function () {
    refreshOpenPreviewInfoPanel();
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
    // 🔴 标签导航页**故意**不参与启动定位，所以也不能往快照里写。
    //
    // 它的 currentView 是 `'tag'`，而 `restoreStartupPositionSnapshot()` 的白名单里
    // 没有它（那张表只认照片网格那几种形态）⇒ 下次启动一律回落默认页。若让本函数照写，
    // 就会用一个**必然被拒**的记录覆盖掉上一个**可恢复**的位置（「文件」停在某个目录），
    // 用户下次启动落到默认页 —— 症状看着像「启动定位坏了」，实际是被这里顶掉的。
    // 想让它参与启动定位，就得把 `tag` 塞进那张白名单并一并还原 `currentTag`，
    // 那是另一件事（本次刻意不做，宁可少记也不要记一条读不回来的）。
    if (state.currentTab === 'tags') return;
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
  // `await loadRootFolders(true, true)` 之后（这台 122 万图片 / 3.1 万目录的库上要十几秒），
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
    // 「欢迎页」现在是独立的首页（Home）：纯静态导航页，零查询、零 IPC。
    // 旧实现靠 `state.suppressAutoLoadOnce` 跳过首次 loadPhotos，好让欢迎卡留在
    // #photoGrid 里；那是一次性标志，天生不支持「可再次进入」。那个标志与它的两处
    // 消费已整条删除，首页改走 openHomePage()（与设置页同族的页面路径，不碰网格）。
    // 这里同样不再预设 currentView / currentPath 等浏览状态：首页不读它们。
    void openHomePage();
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

/**
 * 启动阶段上报 —— 只喂 `startup-performance.json`（主进程白名单见 `RENDERER_STARTUP_STAGES`）。
 * 这段链路在补它之前**一个标记都没有**：主进程侧只有 `window.did-finish-load`，
 * 渲染层只有末端的 `first-grid-paint`，中间 52 秒是黑盒（本机 122 万张库实测
 * 7.3s → 59.0s），「首屏到底在等谁」无法从数据回答。见 CONTRACTS §启动首帧。
 * 🔴 刻意吞掉异常：指标链路无论如何不该影响启动。
 */
function reportStartupStage(stage) {
  try {
    if (api && typeof api.invoke === 'function') api.invoke('notifyStartupStage', stage);
  } catch (eStage) {
    void eStage;
  }
}

async function init() {
  try {
    var dgs = localStorage.getItem('dateGroupsSortOrder');
    if (dgs === 'asc' || dgs === 'desc') state.dateGroupsSortOrder = dgs;
  } catch (eDgs) {}
  reportStartupStage('init.enter');
  await applyInitialSettingsSnapshot();
  reportStartupStage('settings.done');
  // 侧栏宽度必须在首屏前落位。它只依赖静态 DOM（#sidebarResizer / #sidebar /
  // .main-layout > .app-rail）与 localStorage，与 loadRootFolders 的产物无关，故提前到这里：
  // 排在 loadRootFolders 之后会让「已保存宽度生效」和「可拖动」一起变晚，
  // 期间侧栏停在 CSS 默认 260px，而用户去拖那根分隔条毫无反应。
  if (sidebarResizer && typeof sidebarResizer.initSidebarResizer === 'function')
    sidebarResizer.initSidebarResizer();
  // 🔴 bindEvents() 必须排在 `await loadRootFolders` **之前**。
  //    它绑的全是静态 DOM（顶栏 / 窗口控件 / rail / 设置页委托 / 事件委托），
  //    与 root_folders 的产物无关，前移本身是安全的；而排在后面有一个实际后果：
  //    那段时间（本机实测 load 完是 +7.3s，之后还要等一批只能靠 worker 的只读查询）
  //    界面**完全点不动** —— 可 applyStartupLandingPage 的早退判据明确假设
  //    「用户在等待期间点进设置 / 搜图 / 人物 / 重复是完全正常的操作」（见它上面的注释）。
  //    容错逻辑只有在事件先绑好的前提下才有意义，绑晚了它就是空的。
  bindEvents();
  // 先根目录 lite + 侧栏补全；全库统计 getStats 延后一帧，避免与首屏网格抢同一段主进程 DB 时间
  await loadRootFolders(true, true);
  reportStartupStage('rootFolders.done');
  await yieldToPaint();
  applyStartupLandingPage();
  reportStartupStage('landing.done');
  // 启动过程中的中间态（落点判定、位置快照恢复）不该进历史 —— 落地完成后以当前位置
  // 重建栈，用户第一次点「后退」才有明确去处，而不是退回「启动时的默认落点」。
  // 之后 scheduleBrowseReload 的异步链还会再记一次同一位置，被 pushEntry 去重挡掉。
  if (navHistory) navHistory.reset(captureBrowseLocation());
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
    (message || tUi('sidebar.loading', '正在加载…')) +
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
 * 把当前 tab 映射到 <html> 上的四个 page-open 类（侧栏让位与页面显隐全走 CSS）。
 *
 * 四者互斥、且只由 tab 决定 —— 这里是全工程唯一的写者，由 syncNavigationRail 调用，
 * 而 syncNavigationRail 又是所有切页路径的必经点（showTabContent / openSettingsPage /
 * leaveAiViewForBrowse）。
 *
 * 🔴 `home-page-open` 同时负责首页的**显隐**（.home-page 默认 display:none，
 *    `html.home-page-open` 时 display:block），以及 #contentArea / #sidebar 的让位。
 *    把显隐也挂在这个派生类上（而不是在 openHomePage / 各退出路径里写 style.display）
 *    是刻意的：任何把 state.currentTab 切走的路径本来就会重建这个类，于是「退出首页」
 *    自动成立，不存在「某条路径忘了收起首页、看起来点了没反应」这种漏网。
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
  root.classList.toggle('home-page-open', tab === 'home');
  // 标签导航页借用浏览外壳（侧栏 + 主区都在用），所以这个 class 只用来让
  // 「首页 / 设置页」这类独立页面让位，样式上没有别的含义。
  root.classList.toggle('tags-page-open', tab === 'tags');
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

/**
 * 四个编辑动作 → **原样的 CSS 变换函数**。
 *
 * 🔴 这里刻意不做「角度 + 镜像位」的合成：CSS 的求值顺序（最右先作用 ⇒ 先镜像、后旋转）
 *    与 sharp 的算子顺序**同构**，所以把用户点的动作按**逆序**原样拼进 transform 就与
 *    后端 `image-edit.js#planEditSequence` 逐像素等价。前端再写一份代数 = 多一份会悄悄漂移的实现。
 */
var PREVIEW_EDIT_ACTION_CSS = {
  'rotate-right': 'rotate(90deg)',
  'rotate-left': 'rotate(-90deg)',
  'flip-h': 'scaleX(-1)',
  'flip-v': 'scaleY(-1)',
};

/** 每个动作的**逆**（再点一次相反动作即抵消）。`Fh`/`Fv` 自反，两个旋转互为逆。 */
var PREVIEW_EDIT_ACTION_INVERSE = {
  'rotate-right': 'rotate-left',
  'rotate-left': 'rotate-right',
  'flip-h': 'flip-h',
  'flip-v': 'flip-v',
};

/** 待保存动作 → CSS 变换尾巴（**逆序**：最后点的动作写最前面才等于「后作用于显示」）。 */
function previewEditCssTail(actions) {
  var list = actions || [];
  var out = [];
  for (var i = list.length - 1; i >= 0; i--) {
    var css = PREVIEW_EDIT_ACTION_CSS[list[i]];
    if (css) out.push(css);
  }
  return out.join(' ');
}

/**
 * 待保存动作 → 旋转角之和（归一化到 [0,360)）。
 *
 * 只用来回答「布局要不要给转过来的图留空间」（90 的奇数倍才要）。
 * 镜像会把角度取反，但 `-a ≡ a (mod 180)` ⇒ 镜像动作**不改变**这一位，所以求和就够，
 * 不需要真做代数（真实变换在 CSS 尾巴里）。
 */
function previewEditAngleHint(actions) {
  var list = actions || [];
  var deg = 0;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === 'rotate-right') deg += 90;
    else if (list[i] === 'rotate-left') deg -= 90;
  }
  return ((deg % 360) + 360) % 360;
}

/** 有没有「待保存」的东西（旋转/翻转动作，或已确认的裁剪选区）。 */
function hasPendingPreviewEdit() {
  if (state.previewEditPendingActions && state.previewEditPendingActions.length) return true;
  return !!(previewCrop.isPending && previewCrop.isPending());
}

/** 丢掉所有待保存的编辑（含已确认的裁剪选区）。**不碰磁盘**。 */
function clearPreviewPendingEdit() {
  state.previewEditPendingActions = [];
  state.previewEditCssTail = '';
  state.previewRotateDeg = 0;
  if (previewCrop.isActive && previewCrop.isActive()) previewCrop.exit();
}

/** 把待保存状态重画到界面上（图片变换 + 布局留白 + 工具条）。 */
function repaintPreviewEdit() {
  state.previewEditCssTail = previewEditCssTail(state.previewEditPendingActions);
  state.previewRotateDeg = previewEditAngleHint(state.previewEditPendingActions);
  if (typeof previewInteraction.updatePreviewTransform === 'function') {
    previewInteraction.updatePreviewTransform({ state: state, dom: dom });
  }
  if (typeof previewInteraction.updatePreviewImageLayoutBounds === 'function') {
    previewInteraction.updatePreviewImageLayoutBounds({ state: state, dom: dom });
  }
  syncPreviewEditButtons();
}

/** 丢掉所有待保存的编辑并重画（不碰磁盘）。 */
function resetPreviewPendingEdit() {
  clearPreviewPendingEdit();
  repaintPreviewEdit();
}

/**
 * 离开当前图 / 关预览前，若有待保存的编辑先问一句。
 *
 * 🔴 为什么要问：待保存的编辑**只存在于内存里**（这正是「点保存才写回」的代价）。
 *    不问就切图 = 用户按了三下旋转、按了下方向键，那三下**无声消失** ——
 *    而屏幕上（新图）看起来一切正常。这是这一层唯一会「静默丢东西」的口子。
 */
function guardPendingPreviewEdit(next) {
  if (!hasPendingPreviewEdit()) {
    next();
    return;
  }
  appConfirm(
    tUi('edit.pendingMessage', '离开会丢弃当前未保存的旋转 / 翻转 / 裁剪，确定要放弃吗？'),
    tUi('edit.pendingTitle', '有未保存的编辑'),
  ).then(function (ok) {
    if (!ok) return;
    resetPreviewPendingEdit();
    next();
  });
}

/**
 * 编辑按钮只在静止图片上亮；视频不做编辑（后端 `photo-edit-service` 也会拒，
 * 但一直亮着等于把错误留给用户去点出来）。裁剪进行中只留裁剪按钮 ——
 * 半路换掉选区再点旋转，用户看到的图与选框会对不上。
 *
 * 由 `previewFlow.openPreview` 在**每次**切图时回调（与 LIVE 按钮同一条路径）：
 * 只写在「打开预览」那条路径里会覆盖不到「左右切换」。
 *
 * 🔴 **显隐只能用行内 `style.display`，不能只加 `hidden` 属性**：这三个按钮带
 *    `.btn.btn-sm`，而 `.preview-controls-group > .btn.btn-sm { display: inline-flex }`
 *    （`styles.css`，特异性 0,3,0）是作者样式，按层叠规则永远压过 UA 的
 *    `[hidden] { display: none }` ⇒ 光设属性**藏不住**（同组 LIVE 按钮也是因此走行内值，
 *    见 `ui-preview.js#syncLiveButton`）。补任何 `.xxx[hidden]` 兜底也没用：0,2,0 仍低于
 *   那条子选择器。网页端能安心用 `hidden`，是因为它那条兜底的选择器特异性够。
 */
function syncPreviewEditButtons(photo, isVideo) {
  // `isVideoFile()` 吃的是**整条照片行**（它会先看 `media_type`），不是 file_type 字符串
  var video = typeof isVideo === 'boolean' ? isVideo : isVideoFile(photo);
  var cropping = !!(previewCrop.isActive && previewCrop.isActive());
  var pendingCrop = !!(previewCrop.isPending && previewCrop.isPending());
  var pending = hasPendingPreviewEdit();
  var btns = [
    { el: dom.previewRotateBtn, keepWhileCropping: false },
    { el: dom.previewFlipBtn, keepWhileCropping: false },
    // 已确认的裁剪选区在场时连裁剪键也收掉：再进一次裁剪只会把选区重来一遍，
    // 而用户此刻该做的是「保存」或「放弃」。
    { el: dom.previewCropBtn, keepWhileCropping: true, hideWhilePendingCrop: true },
    { el: dom.previewEditSaveBtn, onlyWhilePending: true },
    { el: dom.previewEditDiscardBtn, onlyWhilePending: true },
  ];
  for (var i = 0; i < btns.length; i++) {
    var el = btns[i].el;
    if (!el) continue;
    var hide = video;
    if (!hide && cropping && !btns[i].keepWhileCropping) hide = true;
    if (!hide && btns[i].hideWhilePendingCrop && pendingCrop) hide = true;
    if (!hide && btns[i].onlyWhilePending && !pending) hide = true;
    el.style.display = hide ? 'none' : '';
  }
}

/**
 * 预览里的编辑（旋转 / 翻转）：**只改预览，不碰磁盘**。
 *
 * 用户要求「旋转需要确认才写入变化」⇒ 点按钮只是把动作**追加到待保存串**上，
 * 工具条随即亮出「保存 / 放弃」。真正的写回在 `savePreviewEdit()`。
 *
 * 🔴 再点一次**相反**的动作即抵消（`rotate-right` 后点 `rotate-left` = 什么都没做）：
 *    不然用户点错一下就只能「放弃全部重来」，而「放弃全部」会把别的编辑一起丢掉。
 */
function applyPreviewEdit(action) {
  var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
  if (!photo || !photo.id) return;
  if (isVideoFile(photo)) {
    showPreviewToast(tUi('edit.unsupported', '当前环境不支持编辑'));
    return;
  }
  // 已选好裁剪区域时先挡住：裁剪 rect 用的是「变换后那张图」的坐标系，
  // 再转一下 rect 就指向别的地方了（而后端照样会照做，不会报错）。
  if (previewCrop.isPending && previewCrop.isPending()) {
    showPreviewToast(tUi('edit.saveOrDiscardCrop', '请先保存或放弃已选好的裁剪区域'));
    return;
  }
  var list = state.previewEditPendingActions || [];
  if (list.length && list[list.length - 1] === PREVIEW_EDIT_ACTION_INVERSE[action]) {
    list = list.slice(0, -1);
  } else {
    list = list.concat([action]);
  }
  state.previewEditPendingActions = list;
  repaintPreviewEdit();
}

/** 旋转（预览）；Shift = 逆时针。 */
function cyclePreviewRotateAction(e) {
  return applyPreviewEdit(e && e.shiftKey ? 'rotate-left' : 'rotate-right');
}

/** 翻转（预览）；Shift = 垂直翻转。 */
function previewEditFlipAction(e) {
  return applyPreviewEdit(e && e.shiftKey ? 'flip-v' : 'flip-h');
}

/** 放弃所有待保存的编辑（不碰磁盘）。 */
function discardPreviewEditAction() {
  if (!hasPendingPreviewEdit()) return;
  resetPreviewPendingEdit();
  showPreviewToast(tUi('edit.discarded', '已放弃未保存的编辑'));
}

/**
 * 裁剪：进入选区模式。
 *
 * 🔴 进裁剪前**先把 zoom/pan 归位**：选区换算只做一次「视口 → 图片像素」的线性映射，
 *    带着缩放进来虽然也能算对，但选框会远远超出图片在屏上的那块（`.preview-body-inner`
 *    是 `overflow: hidden`，而选框层挂在 body 上、不受它裁剪）—— 看起来就是「框跑到画面外」。
 */
function previewEditCropAction() {
  if (previewCrop.isPending && previewCrop.isPending()) {
    showPreviewToast(tUi('edit.saveOrDiscardCrop', '请先保存或放弃已选好的裁剪区域'));
    return;
  }
  previewInteraction.resetZoom({
    state: state,
    onUpdatePreviewTransform: function () {
      return previewInteraction.updatePreviewTransform({ state: state, dom: dom });
    },
    onUpdatePreviewImageLayoutBounds: function () {
      return previewInteraction.updatePreviewImageLayoutBounds({ state: state, dom: dom });
    },
  });
  return previewCrop.enter({
    dom: dom,
    /**
     * 让裁剪层知道「现在预览里叠了多少旋转」——决定图片视觉盒要不要宽高对调
     * （`preview-crop.js#viewRect` 靠它；算错的表现是选框与图片错位，不报错）。
     */
    getPreviewAngle: function () {
      return state.previewRotateDeg || 0;
    },
    tUi: tUi,
    onStateChange: function () {
      syncPreviewEditButtons();
    },
    onCommit: function () {
      // 🔴 只记录，不落盘、不入库。写回统一在 `savePreviewEdit()`。
      syncPreviewEditButtons();
      showPreviewToast(tUi('edit.cropStaged', '已选好裁剪区域，点「保存」写回'));
    },
  });
}

/**
 * 保存：把「待保存的动作串 + 已确认的裁剪选区」**一次请求**发给后端。
 *
 * 🔴 必须是一次请求而不是两次（先 transform 再 crop）：裁剪 rect 用的是**变换之后**
 *    那张图的坐标系，两次请求之间会从服务队列里让出，另一端（网页端）可能插进来再改一次
 *    文件 ⇒ 裁错地方。顺序与坐标系契约收在 `photo-edit-service.js#applyEdit` 里。
 *
 * 🔴 **必须改掉 `state.previewPhotos` 里那个对象的 `file_size` / `date_modified`**：
 *    预览原图与缩略图的 URL 缓存键就是这两个字段（`utils.js#photoCacheVersion`）。
 *    不更新它们 ⇒ 新旧 URL 一模一样 ⇒ 浏览器直接命中旧缓存，**界面上还是编辑前的图** ——
 *    用户会以为没生效、再点一次，于是又转 90°。这是这一层唯一的静默陷阱。
 *
 * 🔴 尺寸取**后端返回的真实值**（`r.width` / `r.height`），不要拿 `naturalWidth` 去推：
 *    90/270 档宽高对调、翻转不改尺寸、EXIF 方向还要先归一化，组合有十几种情形。
 */
async function savePreviewEdit() {
  var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
  if (!photo || !photo.id) return;
  if (!hasPendingPreviewEdit()) return;
  if (!(api && api.has && api.has('photoEditApply'))) {
    showPreviewToast(tUi('edit.unsupported', '当前环境不支持编辑'));
    return;
  }

  var actions = (state.previewEditPendingActions || []).slice();
  var cropRect = previewCrop.isPending && previewCrop.isPending() ? previewCrop.pendingRect() : null;

  var r;
  try {
    r = await api.photoEditApply(photo.id, { actions: actions, crop: cropRect });
  } catch (eCall) {
    showPreviewToast(String(eCall && eCall.message ? eCall.message : eCall));
    return;
  }
  if (!r || !r.success) {
    showPreviewToast((r && r.error) || tUi('edit.failed', '编辑失败'));
    return;
  }

  resetPreviewPendingEdit();

  if (r.crop && r.crop.id) {
    /**
     * 裁剪产出的是**另一条照片行**（新 id）⇒ 必须重新拉列表拿到新行再切过去，
     * 否则用户看不到自己刚裁出来的图（原地改缓存键那套对它不成立）。
     * 🔴 新行对象**从列表里取**，不要自己拼：列表行有一份固定的列清单
     *    （`photo-list-columns.js`），少一个字段就可能让预览渲染出错，而且不报错。
     */
    await loadPhotos();
    loadStats();
    var found = null;
    var list = state.currentPhotos || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(r.crop.id)) {
        found = list[i];
        break;
      }
    }
    if (found) {
      openPreviewByPhotoRecord(found);
    } else {
      // 副本落在当前视图之外（例如当前只看某个文件夹）——提示用户而不是静默
      showPreviewToast(tUi('edit.cropSaved', '裁剪副本已保存'));
    }
  } else {
    if (typeof r.size === 'number') photo.file_size = r.size;
    if (r.dateModified) photo.date_modified = r.dateModified;
    if (typeof r.width === 'number') photo.width = r.width;
    if (typeof r.height === 'number') photo.height = r.height;
    // 重开当前张：缓存键已变 ⇒ 会真的重新取图，同时按新尺寸重排布局
    openPreview(state.previewIndex);
  }
  refreshOpenPreviewInfoPanel(photo);
  showPreviewToast(tUi('edit.saved', '已保存'));
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
  if (dom.settingsRescanAllBtn) {
    dom.settingsRescanAllBtn.addEventListener('click', handleSettingsRescanAll);
  }

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
    onThemePresetExpand: expandThemePresetToControls,
    onPersistUiLocale: persistUiLocaleFromControl,
    onToggleWebServerEnabled: toggleWebServerEnabled,
    onToggleTunnelEnabled: toggleTunnelEnabled,
    onPersistBrowsePrefs: persistBrowsePrefsFromForm,
    onPersistInfoPanelFields: persistInfoPanelFieldsFromForm,
  });

  uiEvents.bindMiscControls({
    onCancelCloseChoice: function () {
      submitCloseChoice('cancel');
    },
    onThumbSettingChange: updateThumbPendingHint,
    onQuickThemeChange: persistGeneralSettingsFromControls,
    onThemePresetExpand: expandThemePresetToControls,
    onTopbarLocaleChange: function () {
      void persistUiLocaleFromControl('topbar');
    },
    onWebPasswordFocus: function (inputEl) {
      inputEl.dataset.pwdTouched = '1';
    },
  });

  // 顶栏主题弹层（悬浮预览 / 点选落库）。刻意内聚在 app.js 里而不是拆进 ui-events：
  // 它依赖 app.js 内部的预览会话状态与外观同步函数，拆开只会让回调列表膨胀。
  // ⚠️ #quickThemeStyle 自身的 change 绑定仍留在 ui-events（落库链路不动）。
  initQuickThemeMenu();

  uiEvents.bindShellInlineActions({
    onMenuAction: function (action) {
      void menuAction(action);
    },
    onOpenSettingsPage: function () {
      void openSettingsPage();
    },
    onOpenHomePage: function () {
      void openHomePage();
    },
    onToggleTaskPanelCollapse: toggleTaskPanelCollapse,
    onPauseResumeScan: handlePauseResumeScan,
    onCancelScan: handleCancelScan,
    onCancelThumbnailBackfill: cancelThumbnailBackfill,
    onCancelDuplicateHashDetection: cancelDuplicateHashDetection,
    // 底栏右侧那三个控件都是下拉：选中即提交（与设置页那三份同语义）。
    onBrowseCardSizeChange: function (value) {
      void changeBrowseCardSize(value);
    },
    onBrowsePageSizeChange: function (value) {
      void changeBrowsePageSize(value);
    },
    onBrowseGridStyleChange: function (value) {
      void changeBrowseGridStyle(value);
    },
    onCloseSettingsPage: closeSettingsPage,
    onApplyThumbSettings: applyThumbSettings,
    onStartThumbnailBackfill: startThumbnailBackfill,
    onStartThumbnailRebuild: startThumbnailRebuild,
    onCancelThumbnailRebuild: cancelThumbnailRebuild,
    onStartDuplicateHashDetection: startDuplicateHashDetection,
    onGotoSimilar: gotoSimilarMode,
    onRunMaintenanceCleanup: runMaintenanceCleanup,
    onRunMaintenanceRebuildThumbFlags: runMaintenanceRebuildThumbFlags,
    onRunMaintenanceOptimize: runMaintenanceOptimize,
    onOpenDatabaseFolder: openDatabaseFolder,
    onMigrateDataDir: migrateDataDir,
    onRunMaintenanceBackup: runMaintenanceBackup,
    onSaveWebPassword: saveWebPassword,
    onCopyWebUrl: copyWebUrl,
    onCopyTunnelUrl: copyTunnelUrl,
    onCopyTunnelLog: copyTunnelLog,
    onToggleSlideshow: guardedToggleSlideshow,
    onToggleSlideshowRandom: toggleSlideshowRandom,
    onTogglePreviewFullscreen: togglePreviewFullscreen,
    onMinimizePreview: function () {
      if (api && api.has && api.has('minimizeWindow')) {
        api.minimizeWindow();
      }
    },
    onPreviewWindowMaximize: togglePreviewWindowMaximize,
    onCyclePreviewRotate: cyclePreviewRotateAction,
    onPreviewEditFlip: previewEditFlipAction,
    onPreviewEditCrop: previewEditCropAction,
    onPreviewEditSave: savePreviewEdit,
    onPreviewEditDiscard: discardPreviewEditAction,
    onPreviewToggleFavorite: previewToggleFavorite,
    onPreviewToggleLive: previewToggleLive,
    onPreviewFindSimilar: previewFindSimilar,
    onPreviewShowInFolder: previewShowInFolder,
    onPreviewOpenExternal: previewOpenExternal,
    onPreviewMoveToTrash: previewMoveToTrash,
    onTogglePreviewInfoPanel: togglePreviewInfoPanel,
    onSubmitCloseChoice: submitCloseChoice,
    onSetAllInfoPanelFieldsChecked: setAllInfoPanelFieldsChecked,
    onResetInfoPanelFieldsToDefault: resetInfoPanelFieldsToDefault,
    onExportThumbnailBackfillFailedPaths: exportThumbnailBackfillFailedPaths,
  });
  bindHomePageActions();
  initPreviewWindowMaxButtonState();

  var hlsApplyBtn = document.getElementById('hlsCacheSettingsApplyBtn');
  if (hlsApplyBtn) {
    hlsApplyBtn.addEventListener('click', function () {
      void applyHlsCacheSettings();
    });
  }

  // 组织元数据（标记 / 评分 / 标签）的鼠标入口 + 筛选控件初值。
  // 不在这里预拉标签列表：用户可能整场都不打标签，那是一次白跑的聚合查询
  // （面板首次打开时才拉，见 `bindOrgMetaControls` 里那个按钮的处理器）。
  bindOrgMetaControls();
  syncOrgFilterControls();

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
    onClosePreview: guardedClosePreview,
    onNavigatePreview: guardedNavigatePreview,
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
    onClosePreview: guardedClosePreview,
    onNavigatePreview: guardedNavigatePreview,
    onPreviewMoveToTrash: previewMoveToTrash,
    onTogglePreviewInfoPanel: togglePreviewInfoPanel,
    onPreviewToggleFavorite: previewToggleFavorite,
    onPreviewFindSimilar: previewFindSimilar,
    onToggleSlideshow: guardedToggleSlideshow,
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
    onOpenPreview: guardedOpenPreviewAt,
    onCyclePreviewRotate: cyclePreviewRotateAction,
    onPreviewEditFlip: previewEditFlipAction,
    onPreviewEditCrop: previewEditCropAction,
    onPreviewEditSave: savePreviewEdit,
    onPreviewEditDiscard: discardPreviewEditAction,
    onPreviewOpenExternal: previewOpenExternal,
    // 组织元数据：8 个动作共用 2 个回调（参数由 ui-events 从动作 id 尾字符上取，
    // 动作 id 与星数的对应关系写在 `shortcuts.js#ACTIONS` 里）。
    onPreviewSetFlag: previewSetFlag,
    onPreviewSetRating: previewSetRating,
    onToggleChromeCollapsed: toggleChromeCollapsed,
    onOpenHomePage: function () {
      void openHomePage();
    },
    // ⚠️ 这三个键曾经**漏喂**（局部变量声明在 ui-events 侧是齐的，但这里没给值）⇒
    //    `typeof onX === 'function'` 恒假、按键被吃掉而什么也不发生，且不报错。
    //    `nav.randomPage`(Alt+R) 是本轮新接的；`global.addFolder`(Ctrl+O) 与
    //    `global.devtools`(F12) 在 HEAD 上就已断（本文件头注释早写过「Ctrl+O / F11 / F12
    //    实际没有任何人监听」）。现状由 `shortcut-contract-regression.js` §4.1 钉住。
    onGoToRandomPage: goToRandomPage,
    onHandleAddFolder: handleAddFolder,
    onToggleDevTools: function () {
      // 与 `ui-shell.js` 的处理逐字同源（唯一真相源 = preload 的 toggle-devtools 通道）。
      if (api && api.has && api.has('toggleDevTools')) api.toggleDevTools();
    },
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

  // 路径栏（上级按钮 + 面包屑）的事件：统一由 path-crumbs.js 的实例绑，
  // 包括那条「无上级时按钮直接隐藏、不再退化成回总览」的规则 —— 见那里。
  // 同一个动作不放两个地方：回总览的入口就是面包屑第一段。
  if (pathCrumbs) pathCrumbs.bind();

  // 导航历史（后退 / 前进）：两个按钮 + Alt+←/→（mac 另收 Cmd+[ / ]）+ 鼠标侧键 X1/X2。
  // 侧键的 mousedown/mouseup/auxclick 连发在模块内按方向去抖，这里不重复处理。
  if (navHistory) navHistory.bind();

  uiEvents.bindCardShineTracking();

  window.addEventListener('localechange', function () {
    // 信息面板的分组标题 / 字段名同样是渲染时生成的 → 开着的面板要按新语言重画
    try {
      refreshOpenPreviewInfoPanel();
    } catch (eInfoI18n) {}
    // 标签导航页：侧栏树、分类/子类名、卡片上的计数文案全是渲染时拼出来的
    // （动态内容走不了 data-i18n）⇒ 换语言必须整体重画，否则中英混排。
    try {
      if (tagNavUi) tagNavUi.refreshLocale();
    } catch (eTagI18n) {}
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
        void refreshThumbnailRebuildStatus();
        void refreshDuplicateHashStatus();
        // 这行是 JS 拼出来的（没走 data-i18n）→ 换语言必须重画
        void refreshDataDirInfo();
        // 字段勾选框的文案是渲染时拼出来的（没走 data-i18n）→ 换语言必须重画
        settingsSync.renderInfoPanelFieldsForm({ state: state });
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
      tags: { tabMemory: null },
    };
  } else if (
    state.browseCaches.folders &&
    state.browseCaches.folders.sidebarSnapshot === undefined
  ) {
    state.browseCaches.folders.sidebarSnapshot = null;
  }
  // 老会话（或从旧版本升上来的 state）没有 tags 槽位 ⇒ 补一个，
  // 否则 `saveBrowseTabMemory('tags')` 会在 `state.browseCaches.tags.tabMemory = …` 上抛。
  if (state.browseCaches.folders && !state.browseCaches.tags) {
    state.browseCaches.tags = { tabMemory: null };
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

/**
 * 离开「文件 / 日期 / 标签」页**之前**存一次浏览记忆（判据收在这一处，出口只管调）。
 *
 * 🔴 每一条离开这三个页的出口都要调它。出口一共六条：导轨的搜图 / 人物 / 日期 / 重复、
 *    **首页**、**设置页**。少一条，记忆就停在**更早**的位置 —— 症状是「重进文件页跳到用户
 *    早就离开的目录」，而且看起来完全像浏览记忆本身坏了。
 *    2026-10-07 用户报的正是这个：他从搜图结果点进目录 X，之后在文件页换到别处，
 *    再从**首页**进来却被带回 X —— 因为首页这条出口没存过。
 *    ⚠️「标签」页同样落在这六条出口上：漏掉它，症状是「从设置页返回后标签页停在总览」。
 */
function rememberBrowsePosition() {
  if (state.currentTab === 'folders' || state.currentTab === 'dates' || state.currentTab === 'tags')
    saveBrowseTabMemory(state.currentTab);
}

/** 从管理页软返回时恢复顶栏分页等（不重新请求目录与图片） */
function saveBrowseTabMemory(tabKey) {
  if (tabKey !== 'folders' && tabKey !== 'dates' && tabKey !== 'tags') return;
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
    // 标签页专有：选了哪个标签 / 哪个节点。少了这两项，从设置页回来会退回「分类总览」，
    // 而 `currentView==='tag'` 会让它看起来「进入了标签页」—— 用户以为记忆坏了。
    currentTag: state.currentTag || '',
    currentTagNode: state.currentTagNode || '',
    currentTagNodeKind: state.currentTagNodeKind || '',
  };
}

/**
 * 把记忆套回 state。**返回值 = 有没有真的命中**（`tabMemory` 可能被
 * `invalidateTabSessionCaches` 清空，也可能这次是头一回进这个 tab）。
 *
 * 🔴 返回值是承重的，不是装饰：`showTabContent` 后面还有一支「切到 folders/dates
 *    先把右侧归位到默认视图」的重置块，它会无条件把 `page` 写回 1（folders 那支
 *    连 `currentView` 一起改写）。调用方必须拿这个返回值挡住它 —— 见那里的长注释。
 */
function applyBrowseTabMemory(tabKey) {
  if (tabKey !== 'folders' && tabKey !== 'dates' && tabKey !== 'tags') return false;
  ensureBrowseCaches();
  var m = state.browseCaches[tabKey].tabMemory;
  if (!m) return false;
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
  // 标签页专有：连同「选中的是标签还是节点」一起还原（见 saveBrowseTabMemory 的注释）。
  state.currentTag = m.currentTag != null ? String(m.currentTag) : '';
  state.currentTagNode = m.currentTagNode != null ? String(m.currentTagNode) : '';
  state.currentTagNodeKind = m.currentTagNodeKind != null ? String(m.currentTagNodeKind) : '';
  if (dom.sortSelect) dom.sortSelect.value = state.sortBy + '|' + state.sortOrder;
  if (dom.mediaFilterSelect) dom.mediaFilterSelect.value = state.mediaFilter;
  state._pendingBrowseScrollTop = typeof m.scrollTop === 'number' ? m.scrollTop : null;
  return true;
}

/**
 * 按范围失效会话缓存。不传 partial 时清空目录+日期+重复项（全量）。
 * @param {{ folders?: boolean, dates?: boolean, duplicates?: boolean, tags?: boolean }} [partial]
 */
function invalidateTabSessionCaches(partial) {
  var f;
  var d;
  var dup;
  var g;
  if (!partial) {
    f = d = dup = g = true;
  } else {
    f = !!partial.folders;
    d = !!partial.dates;
    dup = !!partial.duplicates;
    // 「标签」页刻意**跟随 folders** 而不是自成一份：它的照片网格与 folders 共用
    // `_photoBrowseCacheFp` / `_photoBrowseCacheResult` 那一对会话缓存，
    // 库一变两边都得失效。单给 tags 开一档会让「库变了但标签页还挂着旧列表」。
    g = !!partial.tags || f;
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
  if (g) {
    state.browseCaches.tags.tabMemory = null;
    state.currentTag = '';
    state.currentTagNode = '';
    state.currentTagNodeKind = '';
  }
  if (!partial || f || d || g) {
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
/**
 * 带词跳到搜图页并立即搜索（图片信息面板的「主题标签」胶囊点下去走这里）。
 *
 * ⚠️ 顺序仍是「先 `aiViews.search()`、后 `showTabContent('search')`」。
 * 2026-10-07 起 `enter()` **不再**清 `state.aiSearchQuery`（搜图页要保留上一次的结果，见
 * `ai-views.js#retainedSearch`），所以两种顺序都不会丢词 —— 但先切页再设值就得和
 * `loadSearch()` 的保留态还原抢一次先后，没必要冒这个险：`search()` 在「当前不在搜图页」时
 * 会把词暂存给下一次 `enter()` 消费，于是两种入口（已在搜图页 / 不在搜图页）都只调一次就正确。
 *
 * ⚠️ 必须先关预览：标签长在预览的信息面板里，而预览是 1000 层级的上层遮罩，
 * 不关掉的话搜图结果会渲染在它背后，用户看到的是「点了没反应」。
 *
 * 🔴 **判据是 `state.currentView`，绝不是 `state.currentTab`。**
 *    实测（2026-10-05）：`state.currentTab` 只在侧栏点击处理器（`ui-events.js`）与
 *    `showTabContent` 的 search/people 分支里被写 —— 走上「搜图页 → 文件夹」这条路时
 *    **它不会被复位**（直接调 `showTabContent('folders')` 后仍是 `'search'`）。
 *    拿它当判据 ⇒ 从搜图页切走后点胶囊会跳过切页 ⇒ **静默无反应**（标签点了跟没点一样，
 *    没有任何报错）。`state.currentView` 进出 AI 视图时双向都写（`'ai_search'` ↔ `'all'`），
 *    而且它正是 `aiViews.isSearch()` 用的那一份 —— 判据与执行方同源才不会互相打脸。
 */
function openSemanticSearch(query) {
  var q = String(query || '').trim();
  if (!q) return;
  if (dom.previewOverlay && dom.previewOverlay.classList.contains('active')) closePreview();
  if (aiViews) void aiViews.search(q);
  if (state.currentView !== 'ai_search') showTabContent('search');
}

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
  // 标签导航页：与 folders / dates 同族的**浏览页**（侧栏 + 主区），而不是独立页面。
  // 走主分支（浏览记忆、工具栏、`loadPhotos` 的网格通路）才能白拿预览 / 信息面板 / 分页；
  // 自建一套外壳就等于把那些契约再实现一遍，必然漂移。
  //
  // ⚠️ 这一支刻意排在 `opts.softFromSettings` 之前 ⇒ 从设置页回来也走一次**完整**加载，
  //    不享受「软返回」（不重新请求）。理由：软返回要手工复原工具栏 / 分页 / 侧栏树三样，
  //    而这三样在标签页都取决于「选中的是标签还是节点」—— 漏复原一样就是半截界面。
  //    代价只是多一次查询（单标签走索引区间扫描，几毫秒），换来一条不会漏的路径。
  if (tab === 'tags') {
    state.currentView = 'tag';
    // 选中项只在「带记忆回来的那一次」还原；没有记忆（头一回来 / 缓存刚被清）时
    // 退回分类总览，而不是拿着上一次的标签硬撑。
    if (!(fromTab && applyBrowseTabMemory('tags') === true)) {
      state.currentTag = '';
      state.currentTagNode = '';
      state.currentTagNodeKind = '';
      state.page = 1;
    }
    state.prevTab = tab;
    var sidebarTags = document.getElementById('sidebar');
    sidebarUi.ensureNormalSidebarVisible(dom);
    if (sidebarUi.showSidebarOnDesktop) sidebarUi.showSidebarOnDesktop(sidebarTags, state.isMobile);
    tabsUi.prepareBrowsingShell({ dom: dom, currentView: state.currentView });
    // 侧栏树由 tagNavUi 渲染（它同时负责主区的卡片列表）。
    // `enter()` 是幂等的：重复进这一页不会叠加监听。
    if (tagNavUi) void tagNavUi.enter();
    scheduleBrowseReload(function () {
      void loadPhotos();
    });
    return;
  }
  if (opts.softFromSettings === true) {
    if (tab === 'folders' || tab === 'dates') {
      state.prevTab = tab;
      sidebarUi.ensureNormalSidebarVisible(dom);
      tabsUi.prepareBrowsingShell({
        dom: dom,
        currentView: state.currentView,
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
  });

  // 离开“重复项”时解除锁定，避免 loadPhotos 把右侧强制拉回 duplicates
  if (tab !== 'duplicates' && state.sidebarLockedMode === 'duplicates') {
    state.sidebarLockedMode = '';
    if (state.currentView === 'duplicates') state.currentView = 'all';
  }

  // 🔴 这个返回值是承重的：下面两支「切到 folders / dates 先把右侧归位到默认视图」
  //    的重置块，会在记忆**刚套上之后**再抹一次。而 folders 那支的判据是
  //    `currentView !== 'folder' && !== 'folder_overview'` ——「所有文件」的视图
  //    正是 `'all'` ⇒ 只有「所有文件 / 收藏」会被打回第 1 页，目录视图毫发无伤。
  //    所以用户 2026-10-07 报的症状点名了「所有文件」：记忆里的 page 存进去了、
  //    也被还原了，紧接着又被这一块清成 1（不报错、不写日志）。
  //    ⇒ 归位只在记忆**没命中**时才做（头一次进这个 tab，或记忆已被失效清空）。
  //    ⚠️ 判据用「记忆命中」而不是「fromTab 有值」：fromTab 有值但记忆是空的
  //    （设置页改完库再回来）时，仍然必须归位到默认视图，不能拿旧位置硬撑。
  var memoryApplied = false;
  if (fromTab && (tab === 'folders' || tab === 'dates')) {
    memoryApplied = applyBrowseTabMemory(tab) === true;
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

  // 切 tab 时右侧也要跟着刷新：folders 默认显示“所有文件”，dates 默认显示“所有日期”
  // （否则只切了侧栏，右侧仍停留在旧内容，必须再点 sidebar 才会触发 loadPhotos）
  //
  // ⚠️ `!memoryApplied` 不能去掉：没有它，这里会把上一段刚还原出来的浏览位置（尤其是
  //    **页码**，folders 那支还连视图一起）改写回「所有文件第 1 页」。
  //    它的存在意义是「右侧不许停在**上一个 tab** 留下的内容」，不是「每次进 folders
  //    都从第 1 页开始」—— 后者已经被浏览记忆接管了。
  if (tab === 'folders') {
    if (
      !memoryApplied &&
      state.currentView !== 'folder' &&
      state.currentView !== 'folder_overview'
    ) {
      state.currentView = 'all';
      state.currentPath = '';
      state.currentDate = '';
      state.page = 1;
    }
    scheduleBrowseReload(function () {
      void loadPhotos();
    });
  } else if (tab === 'dates') {
    if (
      !memoryApplied &&
      (state.currentView === 'folder' || state.currentView === 'folder_overview')
    ) {
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

// ===== 首页（Home）=====
/**
 * 浏览类 tab 白名单 —— 「进入某个页面之前，先记住从哪个浏览位置来的」这件事，
 * 首页（state.tabBeforeHome）与设置页（state.tabBeforeSettings）各有一份状态，
 * 但**判据是同一套**。settingsFlow 里那份是它自己文件内的副本（该 IIFE 不能反向引用
 * app.js 的函数），两处必须同时改。
 */
function normalizeBrowseTab(tab) {
  return tab === 'folders' ||
    tab === 'dates' ||
    tab === 'duplicates' ||
    tab === 'people' ||
    tab === 'search' ||
    tab === 'tags'
    ? tab
    : 'folders';
}

/**
 * 打开首页。与 openSettingsPage 同族：首页是一条「页面」，不是浏览位置，
 * 因此它不进 BROWSABLE_VIEWS、不进导航历史栈。
 *
 * 🔴 这里**不碰任何 DOM 显隐**：首页的显示、以及 #contentArea / #sidebar 的让位，
 * 全由 `html.home-page-open` 一个 class 决定（styles.css），而该 class 的唯一写者
 * 是 syncNavigationRail → syncPageOpenClasses 这条派生链。所以本函数只做两件事：
 * 记住来处、把 tab 切到 'home'，其余交给派生。
 */
function openHomePage() {
  // 早退判据用的是**派生状态**（首页是不是真的在显示），不是 state.currentTab ——
  // 后者在本项目里以「不一定跟界面对齐」著称（`showTabContent` 的 folders / dates
  // 两支就不写它，详见 openSemanticSearch 上面的注释）。拿它判会出现
  // 「界面早已不在首页、点按钮却静默无反应」。
  if (document.documentElement.classList.contains('home-page-open')) return;
  // 从设置页过来：先走**完整的**设置页退出流程（停快捷键录制 / 停 hydrate 轮询 /
  // 摘 settingsBtn 的 active / 恢复侧栏），再切首页 —— 与 rail 上点「文件」是同一条
  // 退出路径，不另造一条。若只切 tab 不管设置页，会留下「右栏还是设置页」的半截界面。
  if (state.currentTab === 'settings') closeSettingsPage();
  // 首页是六条出口之一：不存这一次，「文件」页的记忆就停在上一次存过的位置（见
  // `rememberBrowsePosition` 的注释）。下面两行一改顺序就会漏存，别把这一行挪到 currentTab 之后。
  rememberBrowsePosition();
  state.tabBeforeHome = normalizeBrowseTab(state.currentTab);
  state.currentTab = 'home';
  syncNavigationRail('home');
  // 从别页回到首页时 state.stats 通常已经有值，这里补写一次 ⇒ 界面立刻是数字，
  // 不会先闪一帧占位符。首次启动直接落首页时它拿到的是空对象，于是写占位符骨架 ——
  // 两条路径都安全（renderHomeStats 幂等，且不改结构、不动尺寸）。
  renderHomeStats();
  // 顶栏在文件夹视图会被 `paintBrowsePhotoGridShell` 改写成**该文件夹**的局部计数，
  // 而首页是全局视角 —— 不还原就会出现「首页 1,629,971、顶栏却挂着某个文件夹的几百」
  // 这种比口径不一致更离谱的错位。这里与浏览网格共用同一个格式化函数，口径天然一致。
  if (dom.statsBar && state.stats && Number(state.stats.totalPhotos) > 0) {
    dom.statsBar.textContent = formatGlobalStatsBarText(state.stats, state.mediaFilter);
  }
}

/** 统计带的占位符（数据未到时显示）。单独抽成常量是为了让它成为唯一来源 ——
 *  占位符一改，骨架态与填充态的宽度就可能不再一致（守护钉住它的出现次数）。 */
var HOME_STAT_PLACEHOLDER = '—';

/**
 * 首页库概览统计带：把 `state.stats` 的数字写进那 4 个格子。
 *
 * 🔴 这是 Home 代码段里**唯一**碰库内数据的地方，但它的读取路径是「白拿」——
 *    `state.stats` 由启动路径上本来就会跑的 `loadStats()` 写入（首次落点之后一帧）。
 *    所以首页**没有新增任何数据依赖**：不自己发请求、不加查询、不读数据库。
 *    正因如此，本段的「纯导航 / 零副作用」范围线（不弹对话框、不扫描、不建索引、
 *    不发 IPC）**没有被放宽** —— 一条例外都不需要开。
 *
 * 🔴 幂等 + 恒形：拿不到数据（统计还没回来）就写占位符，绝不清空 / 隐藏 / 改结构。
 *    骨架态与填充态必须同宽同高，这是 plan §4.6 对「数据晚到跳字」的判据
 *    （补写前后对同一容器量 getBoundingClientRect()，宽高必须一致）。
 *
 * ⚠️ 口径必须互斥：`getStats()` 的 `totalPhotos` 是 `COUNT(*) FROM photos`，**含视频行**
 *    （顶栏 `formatGlobalStatsBarText` 把它直接读作「张图片」）。首页把图片与视频并排显示，
 *    不做减法就会出现「图片 + 视频 > 全部文件」这种一眼就假的数字。
 *    减法后 `图片 + 视频 === totalPhotos` 恒成立。
 */
/**
 * 🔴 「图片数」的唯一真相源 —— 顶栏、首页、文件夹作用域**三处**都必须走它。
 *
 * 背景：`getStats()` 的 `totalPhotos` 是 `COUNT(*) FROM photos`，**含视频行**；
 * 视频行单独由 `videoPhotos` 给出。凡是把「图片」和「视频」并排显示的界面，
 * 都必须先把视频扣掉，否则就是「图片 + 视频 > 全部文件」这种一眼假的数字。
 *
 * 曾经的 bug 正是「三处各算各的」：首页做了减法，顶栏直接把 `totalPhotos`
 * 标成「张图片」，于是同一个库顶栏 1,656,580、首页 1,629,971 + 26,609 视频
 * （差值恰好 = 视频数）。数字谁都没算错，错在口径没共用一份。
 *
 * ⚠️ 减法而不是新增一条 SQL：`totalPhotos` 与 `videoPhotos` 出自同一条聚合语句
 * （`db-heavy-read#statsAggSql`），判定谓词逐字相同，所以「全 − 视频」就是图片集合，
 * 不存在边界漂移；另起一条 `NOT IN (...)` 反而会因为 `file_type` 为 NULL 的行
 * 而少算（见 `runAggregateStatsForSingleRoot` 里的同款注释）。
 */
function stillPhotoCount(total, videoCount) {
  return Math.max(0, (Number(total) || 0) - (Number(videoCount) || 0));
}

/** 同上，只是换成体积：`totalSize` 也含视频体积。 */
function stillPhotoSize(totalSize, videoSize) {
  return Math.max(0, (Number(totalSize) || 0) - (Number(videoSize) || 0));
}

function renderHomeStats() {
  var s = state.stats || {};
  // 「统计到了没有」的判据是 `!= null`，不是 `> 0`：state.stats 的初值是 `{}`，
  // 而 loadStats 写入的一定是完整对象。拿 `> 0` 代替会让**空库**永远停在占位符上，
  // 与「还在加载」不可区分（空库应当显示 0）。
  var loaded = s.totalPhotos != null;
  var total = loaded ? Number(s.totalPhotos) || 0 : 0;
  var videos = loaded ? Number(s.videoPhotos) || 0 : 0;
  setHomeStatValue(dom.homeStatPhotos, loaded ? formatNumber(stillPhotoCount(total, videos)) : '');
  setHomeStatValue(dom.homeStatVideos, loaded ? formatNumber(videos) : '');
  setHomeStatValue(dom.homeStatSize, loaded ? formatSize(s.totalSize) : '');
  setHomeStatValue(dom.homeStatFolders, loaded ? formatNumber(s.totalFolders) : '');
}

/** 只在文本真的变了才写 —— 免得每次 loadStats 都触发一轮无谓的布局。 */
function setHomeStatValue(el, text) {
  if (!el) return;
  var next = text || HOME_STAT_PLACEHOLDER;
  if (el.textContent !== next) el.textContent = next;
}

/**
 * 首页唯一的入口分发。所有可点节点都是原生 `<button data-home-goto="…">`，
 * 鼠标 click 与键盘 Enter/Space 走**同一个**函数（不存在两套跳转逻辑）。
 *
 * 值域（四种前缀）：
 *   `view:<视图>[:video]` —— 切浏览视图；带 `:video` 时同时把底栏筛选切到「仅视频」
 *   `tab:<标签页>`        —— showTabContent（dates / search / people）
 *   `panel:<面板id>`      —— 先 openSettingsPage()，**再** scrollToSettingsSection()
 *
 * 🔴 全部分支都只做导航：不发 IPC、不弹系统对话框（不调 handleAddFolder）、不扫描、
 * 不建索引、不读写数据库。这是「首页是纯导航页」这条范围线的落地判据（守护按此断言）。
 */
function handleHomeGoto(spec) {
  var parts = String(spec || '').split(':');
  var kind = parts[0];
  var arg = parts[1] || '';
  if (kind === 'view') {
    // 「只看图片 / 只看视频」必须真的带上筛选：项目里**没有**「图片」「视频」视图 ——
    // 它们是底栏 #mediaFilterSelect 上的筛选值（`all | image | video`，与那个 <select>
    // 的取值域逐字相同）。不带筛选的话它就和卡 1 的「所有文件」是同一个落点，
    // 两个不同文案指向同一处，用户会以为是两回事（§4.2 的落点唯一性）。
    // ⚠️ 取值域只有这三个，写第四个（或把 'all' 也塞进来）会让底栏下拉**没有对应 option**
    //    ⇒ `select.value = X` 静默失败、界面还停在上一个筛选，而落点看起来「换了」。
    var mediaFilter = parts[2];
    if (mediaFilter === 'image' || mediaFilter === 'video') {
      state.mediaFilter = mediaFilter;
      if (dom.mediaFilterSelect) dom.mediaFilterSelect.value = mediaFilter;
    }
    if (arg === 'folder_overview') viewAllFolderCovers();
    else viewAllPhotos();
    return;
  }
  if (kind === 'tab') {
    if (!arg) return;
    // ⚠️ 与 rail 点击处理器（ui-events.js 的 bindNavTabs）同形：**先**把 tab 落到
    // state.currentTab，**再**调 showTabContent。
    // 原因是 showTabContent 只在 search / people 两支里自己写 state.currentTab，
    // folders / dates 那两支不写（既有约定，见 openSemanticSearch 上面的长注释）。
    // 漏了这一步，从首页点「日期」就会留下「界面已经是日期页、state.currentTab 还是
    // 'home'」的分裂 —— 而顶栏「首页」按钮正是拿这个字段判「是否已经在首页」，
    // 于是下一次点它会静默早退（症状：点了没反应）。
    state.currentTab = arg;
    showTabContent(arg);
    return;
  }
  if (kind === 'panel') {
    if (!arg) return;
    // 顺序不可反：scrollToSettingsSection 只在设置页已经显示（且面板已展开）后才有落点。
    void openSettingsPage().then(function () {
      if (state.currentTab !== 'settings') return;
      scrollToSettingsSection(arg);
    });
  }
}

/**
 * 首页的入口交互：**一个**委托 listener 挂在 #homePage 上，同时吃 click 与 keydown。
 *
 * 节点是原生 <button> ⇒ Enter/Space 本来就会被浏览器合成 click，所以 click 分支已经
 * 覆盖键盘；这里再显式写一条 keydown 分支，是为了把「两个通道调同一个函数」这条契约
 * 摆在代码里（也防将来有人把按钮换成 div —— 那时 click 分支就再也接不到键盘了）。
 * 两条分支都先 preventDefault：Enter 的默认动作正是合成 click，不拦会跳两次。
 */
function bindHomePageActions() {
  var root = dom.homePage;
  if (!root) return;
  function activate(target) {
    var el = target && target.closest ? target.closest('[data-home-goto]') : null;
    if (!el) return false;
    handleHomeGoto(el.getAttribute('data-home-goto'));
    return true;
  }
  root.addEventListener('click', function (e) {
    if (activate(e.target)) e.preventDefault();
  });
  root.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (activate(e.target)) e.preventDefault();
  });
}

// 打开管理页面（从 topbar 按钮触发）
async function openSettingsPage() {
  if (state.currentTab === 'settings') return;
  // 设置页是六条出口之一（同上：这一行必须在 `settingsFlow.openSettingsPage` 之前，
  // 那个 await 里 state 可能已经被后台回调改过）。
  rememberBrowsePosition();
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

// 从管理页面返回图片浏览
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
      // 「返回」回到的是**来处**：从首页进的设置页，返程就是首页。
      // ⚠️ 不能把 'home' 丢给 showTabContent（那里没有 home 分支，会切出一页空白）；
      // 也不能在这里叫 openHomePage() —— settingsFlow 刚把 state.currentTab 设回 'home'，
      // openHomePage 见到 tab 已是 home 会直接早退，派生类反而没人重建。
      // 这里只需要把派生重建一次，剩下的交给 `html.home-page-open` 那条链。
      if (t === 'home') {
        syncNavigationRail('home');
        return;
      }
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
    // isScanQueued：T2 起扫描可能长时间等在写库闸门后面，那段时间 worker 还没起、
    // isScanning 为 false，但刷新不能就此停掉 —— 否则扫描真正开始时侧栏数字不再更新。
    if (!state.isScanning && !state.isScanQueued) {
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
  // 🔴 合流点：首页统计带与顶栏**同源**（都读刚刚写入的 state.stats）。
  //    这一步不能省 —— 首页自己不发请求，少了它首页会永远停在占位符上，
  //    而顶栏一切正常（最典型的静默失效）。反过来，它在首页不在场时也只是
  //    写几个 textContent，无副作用。
  renderHomeStats();
}

function updateFavoriteCountInSidebar() {
  var n = state.stats && state.stats.favoritePhotos != null ? state.stats.favoritePhotos : 0;
  document.querySelectorAll('[data-sidebar-favorites] .count').forEach(function (el) {
    el.textContent = formatNumber(n);
  });
}

/**
 * 在已跳过 renderFolderTree 时，仅同步侧栏「所有文件 / 所有目录 / 各根目录」上的数量文案，避免扫描中整树重绘。
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
        var onSettingsPage = state.currentTab === 'settings';
        // 🔴 这里**绝对不许**清空侧栏。原先这里有一句 `if (gate.isAlive() && skipTree) gate.render('')`，
        //    想表达的是「设置页侧栏隐藏，顺手把侧栏内容清掉」，但两处判断都反了：
        //      ① gate.isAlive() 本身已经蕴含 state.currentTab === 'folders'（见 createSidebarRequestGate），
        //         所以这句能真正执行时，侧栏必然是**正在显示**的那一个；在设置页恒为 no-op。
        //      ② 设置页用的是另一个节点（#settingsSidebar），本来也没有要清的东西。
        //    后果：扫描期 loadRootFolders(true, true) 每 3s 被 startScanLiveRefresh 调一次，
        //    而本分支 return 之前不会重绘 —— 于是「点重新扫描 / 添加目录开始扫描后切到『文件』页」
        //    整棵树被抹成空白，一直空到扫描结束（2026-10-05 用户报「扫描中文件夹树消失」）。
        // lite 行的 photo_count / folder_count / video_count 恒为 null，只够喂「设置页目录表」；
        // 侧栏树要的是带统计的聚合行（下面 fetchRootFoldersSafe 的 force 拉取就是干这个的），
        // 拿 lite 覆盖进去只会让树上的数字在聚合返回前短暂变 0，所以非设置页不写回。
        if (onSettingsPage || !Array.isArray(state.rootFolders) || state.rootFolders.length === 0) {
          // 管理页目录表已不展示数量/体积，无需再拉 photos 聚合；返回相册后由侧栏 loadRootFolders 补全
          state.rootFolders = liteList;
        }
        state.rootFoldersStatsPending = !onSettingsPage;
        if (onSettingsPage) {
          await renderSettingsFolderList({ skipFetch: true });
          return;
        }
        fetchRootFoldersSafe({ force: true })
          .then(function () {
            scheduleBrowseReload(function () {
              if (isFolderSidebarTab(state.currentTab)) {
                patchSidebarFolderTreeCountsFromState();
              }
            });
          })
          .catch(function () {});
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
 * 从搜图 / 人物退回普通浏览：点侧栏的文件夹 / 日期 / 全部图片时走的是各自入口，
 * 不经过 showTabContent，所以在这里把标签与导轨收回浏览项，并让适配层摘掉 AI 工具栏。
 */
function leaveAiViewForBrowse(tab) {
  // ⚠️ 这个函数不只是「退出 AI 视图」：它同时是 viewAllPhotos / viewFavorites /
  // viewAllFolderCovers / viewFolder 四个视图入口**唯一的公共前缀**，而这四个入口
  // 都不经过 showTabContent。首页卡内的「所有文件 / 所有目录 / 只看图片 / 只看视频」正好也走这里。
  //
  // 原判据 `!aiViews.isShowing()` 就早退，在首页独立成页后会漏掉一件事：
  // 从首页点「所有文件」时 AI 视图并没有在显示 ⇒ 早退 ⇒ state.currentTab 仍是 'home'
  // ⇒ `home-page-open` 摘不掉 ⇒ 首页正好盖在刚加载好的图片流上面（表现为「点了没反应」）。
  // 所以判据扩成「AI 视图在显示 **或** 当前停在首页」—— 两条都要经过 syncNavigationRail。
  if (state.currentTab !== 'home' && (!aiViews || !aiViews.isShowing())) return;
  state.currentTab = tab;
  // syncNavigationRail 顺带把四个 page-open 类对齐到 tab（含 settings / home 的摘除）
  syncNavigationRail(tab);
  if (aiViews) aiViews.leave();
}

function viewAllPhotos() {
  leaveAiViewForBrowse('folders');
  state.currentView = 'all';
  state.page = 1;
  updateSidebarActive();
  recordBrowseLocation();
  updatePathBar();
  loadPhotos();
}

function viewFavorites() {
  leaveAiViewForBrowse('folders');
  state.currentView = 'favorites';
  state.page = 1;
  updateSidebarActive();
  recordBrowseLocation();
  updatePathBar();
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
  recordBrowseLocation();
  sidebarUi.ensureDuplicateSidebarVisible(dom);
  if (dom.sidebarContent) {
    if (state.duplicateHasScanned && state.duplicateGroups && state.duplicateGroups.length) {
      dom.sidebarContent.innerHTML = '';
    } else {
      dom.sidebarContent.innerHTML =
        '<div class="folder-item active" data-sidebar-duplicates="1">' +
        '<span class="icon">\u{1F9E9}</span>' +
        '<span class="name">' +
        escapeHtml(tUi('sidebar.duplicates', '重复图片')) +
        '</span>' +
        '<span class="count">' +
        formatNumber((state.duplicateGroups || []).length) +
        '</span>' +
        '</div>' +
        '<div class="sidebar-list-loading"><div class="content-loading-spinner content-loading-spinner--sm"></div><div>' +
        escapeHtml(tUi('sidebar.loadingDuplicates', '正在加载重复项...')) +
        '</div></div>';
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
  recordBrowseLocation();
  updatePathBar();
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
  updatePathBar();
  recordBrowseLocation();
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
  recordBrowseLocation();
  updatePathBar();
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
    // 「仅图片」档：件数与体积都要扣掉视频，否则这一档显示的是**全库**的数字。
    var imageCount = stillPhotoCount(stats.totalPhotos, stats.videoPhotos);
    var imageSize = stillPhotoSize(stats.totalSize, stats.videoSize);
    return tUiFmt(
      'stats.barImageFmt',
      {
        photos: formatNumber(imageCount),
        totalSize: formatSize(imageSize),
      },
      formatNumber(imageCount) + ' 张图片 | ' + formatSize(imageSize),
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
  // 全档：件数同样走唯一真相源（扣掉视频），与首页 `#homeStatPhotos` 逐位一致；
  // 体积保留 `totalSize`（全库占用）而不是图片体积 —— 这里模板的语义是「库占了多少」。
  var fullCount = stillPhotoCount(stats.totalPhotos, stats.videoPhotos);
  return tUiFmt(
    'stats.barFullFmt',
    {
      photos: formatNumber(fullCount),
      totalSize: formatSize(stats.totalSize),
      videos: formatNumber(stats.videoPhotos || 0),
      videoSize: formatSize(stats.videoSize || 0),
    },
    formatNumber(fullCount) +
      ' 张图片 | ' +
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
    // 与全局顶栏同口径：`st` 是该作用域 `COUNT(*)`（含视频），必须扣掉 `vc`。
    // 二者出自同一条 `whereSql`（`database.js#getPhotosByFolder`），减法自洽。
    var scopedPhotos = stillPhotoCount(st, vc);
    return tUiFmt(
      'stats.barFolderFmt',
      { photos: formatNumber(scopedPhotos), videos: formatNumber(vc) },
      formatNumber(scopedPhotos) + ' 张图片 | 视频 ' + formatNumber(vc) + ' 条',
    );
  }
  if (sub > 0) {
    return tUiFmt(
      'stats.folderNoDirectPhotosFmt',
      { n: formatNumber(sub) },
      '此文件夹下暂无直接图片 · ' + formatNumber(sub) + ' 个子目录（点击下方进入）',
    );
  }
  return tUi('stats.zeroPhotos', '0 张图片');
}

function formatFolderCountLabel(n) {
  var num = formatNumber(n);
  return tUiFmt('stats.folderCountFmt', { n: num }, num + ' 个目录');
}

function updateBrowsePathLabel() {
  if (!dom.currentPath) return;
  // 兜底记录导航历史：切 tab / 从设置软返回等会**隐式**改位置的路径不经过 view* 入口，
  // 靠这里补齐。栈内按位置键去重，所以 view* 里那次显式记录加这次仍是一步。
  recordBrowseLocation();
  // 面包屑会被整体重写（innerHTML），所以先关掉可能开着的同级下拉：
  // 否则末段按钮被换掉后，菜单还挂着一个已失效的锚点。
  if (pathCrumbs) pathCrumbs.close();
  switch (state.currentView) {
    case 'duplicates':
      dom.currentPath.textContent = tUi('path.duplicates', '重复图片（哈希）');
      break;
    case 'favorites':
      dom.currentPath.textContent = state.searchQuery
        ? tUiFmt(
            'path.favoritesSearchFmt',
            { q: state.searchQuery },
            '\u2B50 收藏 · \u{1F50D} ' + state.searchQuery,
          )
        : tUi('path.favorites', '\u2B50 收藏');
      break;
    case 'search':
      dom.currentPath.textContent = '\u{1F50D} ' + state.searchQuery;
      break;
    case 'folder_overview':
      dom.currentPath.textContent = tUi('path.folderOverview', '\u{1F5C2}\uFE0F 所有目录');
      break;
    case 'folder': {
      // 完整路径分段（每段可点跳该层 + 末段可切同级目录），不再只渲染末级目录名
      if (pathCrumbs) pathCrumbs.refresh();
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
    case 'tag': {
      // 选中标签时显示标签名（用**显示名**而不是英文原文：这张图上的标签本来就是中文的，
      // 这里再写 `black_hair` 会和信息面板里那一行对不上）。
      // 没选中（分类总览 / 节点卡片）时只显示「标签」。
      var tagLabel = '';
      if (state.currentTag) {
        tagLabel = tagNavUi && tagNavUi.displayName ? tagNavUi.displayName(state.currentTag) : state.currentTag;
      }
      dom.currentPath.textContent = tagLabel
        ? '\u{1F3F7}\uFE0F ' + tagLabel
        : '\u{1F3F7}\uFE0F ' + tUi('nav.tags', '标签');
      break;
    }
    default:
      dom.currentPath.textContent = tUi('path.allFiles', '所有文件');
  }
}

function updateSidebarActive() {
  // 首页：rail 上没有任何按钮对应它，侧栏也整体让位（见 styles.css 的 home-page-open 段）。
  // 这里显式停住 —— 否则会落到最后的 else 去同步「日期」高亮，在停在首页时白改一次侧栏。
  if (state.currentTab === 'home') return;
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

/* ---------------------------------------------------------------------------
 * 路径栏（面包屑）接线
 *
 * 实现全在 `path-crumbs.js`（纯函数 + mount 实例），这里只负责把 app 的能力喂进去：
 * 那个模块**不读** app 的 state，一切都走下面这些回调，所以它能在沙箱里单测。
 *
 * 历史：桌面端原先只有侧栏里一条「返回上级」按钮（#folderNavBar），到根目录就整条
 * 隐藏；内容区顶栏那个 #currentPath 只渲染一个末级目录名。于是「自己在路径的第几层」
 * 完全不可见，跳回任意一层祖先要连点 N 次。现在合成一条路径栏：
 * 左端 ← 回上级，中间每段可点跳该层，末段点开列同级目录（横向换目录不必先退再进）。
 * ------------------------------------------------------------------------- */

/** i18n 键 → 中文兜底（英文由 i18n.js 提供） */
var PATH_CRUMBS_ZH = {
  'path.crumbRoot': '所有目录',
  'path.crumbExpand': '展开完整路径',
  'path.crumbSwitch': '切换到同级目录',
  'path.folderOverview': '\u{1F5C2}\uFE0F 所有目录',
};

var pathCrumbs = window.RendererPathCrumbs
  ? window.RendererPathCrumbs.mount({
      bar: dom.pathBar,
      host: dom.currentPath,
      up: dom.pathUp,
      deps: {
        normalizePath: function (p) {
          return sidebarTree.normalizePath(p);
        },
        isAncestorOf: function (ancestor, descendant) {
          return sidebarTree.isFolderPathAncestor(ancestor, descendant);
        },
        queryChildFolders: function (p) {
          return sidebarTree.queryChildFolders(p);
        },
        getState: function () {
          return state;
        },
        t: function (key) {
          return tUi(key, PATH_CRUMBS_ZH[key] || key);
        },
        tFmt: function (key, map) {
          return tUiFmt(key, map, '返回上级：' + (map && map.name ? map.name : ''));
        },
        // 下面这三个在 app.js 尾部才赋值（`var escapeHtml = ...`），所以包一层延迟取 ——
        // 直接把当时的 undefined 交给模块，运行期会静默炸在渲染里。
        escapeHtml: function (v) {
          return escapeHtml(v);
        },
        escapeAttr: function (v) {
          return escapeAttr(v);
        },
        formatNumber: function (n) {
          return formatNumber(n);
        },
        onNavigateFolder: function (p) {
          viewFolder(p);
        },
        onNavigateOverview: function () {
          viewAllFolderCovers();
        },
      },
    })
  : null;

/** 整条路径栏一次刷完（上级按钮 + 面包屑）。viewFolder 里同步调，别等 loadPhotos 链路。 */
function updatePathBar() {
  if (!pathCrumbs) return;
  pathCrumbs.updateUp();
  updateBrowsePathLabel();
}

/* ---------------------------------------------------------------------------
 * 导航历史（后退 / 前进）接线
 *
 * 栈本身在 `nav-history.js`，这里只回答「位置是什么」和「怎么回到某个位置」。
 *
 * 为什么要它：面包屑解决了「跳到第 N 层祖先」，但解决不了「刚才在另一个目录」——
 * 用户在两个目录之间来回对比时，仍要顺着树爬回去。后退 / 前进把这件事变成一次点击，
 * 并且和快捷键（Alt+←/→、mac 的 Cmd+[ / ]、鼠标侧键 X1/X2）共用同一条栈。
 *
 * 记录口刻意做成两级：**view* 入口同步记一次**（不依赖异步链路），
 * `updateBrowsePathLabel()` 里再兜底记一次（覆盖切 tab / 软返回等隐式改位置的路径）。
 * 栈内按位置键去重，所以重复记不会长栈 —— 见 nav-history.js 的 pushEntry。
 * ------------------------------------------------------------------------- */

/** i18n 键 → 中文兜底 */
var NAV_HISTORY_ZH = {
  'path.back': '后退',
  'path.forward': '前进',
  'path.backFmt': '后退：{name}',
  'path.forwardFmt': '前进：{name}',
  'path.favorites': '\u2B50 收藏',
};

/**
 * 能进历史的位置类型。搜图 / 人物 / 设置各有独立视图态与恢复入口，不进这条栈。
 * `tag` 在列：标签页是浏览页（有「选中了哪个标签」这个可回退的位置），
 * 而且 `applyBrowseLocation` 的 switch 里有对应的 case。
 */
var BROWSABLE_VIEWS = [
  'all',
  'folder_overview',
  'folder',
  'date',
  'favorites',
  'duplicates',
  'tag',
];

/** 当前浏览位置快照；null = 不该进历史 */
function captureBrowseLocation() {
  // 首页不是浏览位置：它不进导航历史栈（与设置页同族的理由 —— 它是「到站口」，
  // 不是某一站）。挡在这里而不是挡在调用点，是因为调用点有五六个（recordBrowseLocation
  // 的几条入口 + init() 的启动重建），漏一个就会往栈里塞一个假位置。
  if (state.currentTab === 'home') return null;
  var view = state.currentView || 'all';
  if (BROWSABLE_VIEWS.indexOf(view) < 0) return null;
  var tab = state.currentTab || '';
  if (view === 'folder') {
    var p = state.currentPath ? sidebarTree.normalizePath(state.currentPath) : '';
    return p ? { view: 'folder', path: p, tab: tab } : null;
  }
  if (view === 'date') {
    return state.currentDate ? { view: 'date', date: String(state.currentDate), tab: tab } : null;
  }
  if (view === 'tag') {
    // 选中了具体标签才算一个「位置」。停在分类总览 / 节点卡片时 `currentTag` 为空 ⇒
    // 不记：否则「标签页」会以同一个键反复入栈，后退按钮看起来卡住不动。
    if (!state.currentTag) return null;
    return { view: 'tag', tag: String(state.currentTag), tab: tab };
  }
  // all / favorites / folder_overview / duplicates 只认 view：
  // ⚠️ `viewAllPhotos()` 不会清空 state.currentPath，若把 path 也塞进键，
  // 同一个「所有文件」会因为上一个目录不同而算出两个位置。
  return { view: view, tab: tab };
}

/** 位置的可读名（后退 / 前进按钮的 title） */
function describeBrowseLocation(loc) {
  if (!loc) return '';
  if (loc.view === 'folder' && loc.path) {
    var parts = String(loc.path).split('\\');
    return parts[parts.length - 1] || String(loc.path);
  }
  if (loc.view === 'date' && loc.date) return formatDateLabel(loc.date);
  if (loc.view === 'folder_overview')
    return tUi('path.folderOverview', '\u{1F5C2}\uFE0F 所有目录');
  if (loc.view === 'favorites') return tUi('path.favorites', NAV_HISTORY_ZH['path.favorites']);
  if (loc.view === 'duplicates') return tUi('path.duplicates', '重复图片（哈希）');
  if (loc.view === 'tag') {
    var tagName = loc.tag || '';
    return tUiFmt('path.tag', { name: tagName }, '标签：{name}');
  }
  return tUi('path.allFiles', '所有文件');
}

/** 把某个历史位置应用回去。期间 nav-history 会抑制记录（否则后退会自己长出新的一步）。 */
function applyBrowseLocation(loc) {
  if (!loc) return;
  // 位置挂在别的 tab 下（文件夹 ↔ 日期 ↔ 重复）时，先把 tab 骨架切过去。
  // 刻意不传 fromTab：`showTabContent` 只在 fromTab 有值时才套用 tabMemory，
  // 否则它会用「上次在这个 tab 的浏览位置」把我们要恢复的位置覆盖掉。
  var tab = loc.tab;
  if (
    tab &&
    tab !== state.currentTab &&
    (tab === 'folders' || tab === 'dates' || tab === 'duplicates' || tab === 'tags')
  ) {
    showTabContent(tab);
  }
  switch (loc.view) {
    case 'folder':
      if (loc.path) viewFolder(loc.path);
      break;
    case 'folder_overview':
      viewAllFolderCovers();
      break;
    case 'date':
      if (loc.date) viewDate(loc.date);
      break;
    case 'favorites':
      viewFavorites();
      break;
    case 'duplicates':
      viewDuplicates();
      break;
    case 'tag':
      // 直接改 state 再交 `loadPhotos`，与侧栏点标签是同一条路（不另造一条）。
      // `showTabContent('tags')` 那条分支已经会把 currentView 设成 'tag'。
      if (loc.tag) {
        state.currentView = 'tag';
        state.currentTag = String(loc.tag);
        state.currentTagNode = '';
        state.page = 1;
        if (tagNavUi) tagNavUi.selectTag(String(loc.tag));
        else void loadPhotos();
      }
      break;
    default:
      viewAllPhotos();
  }
}

var navHistory = window.RendererNavHistory
  ? window.RendererNavHistory.mount({
      back: dom.pathBack,
      forward: dom.pathForward,
      deps: {
        applyLocation: function (loc) {
          applyBrowseLocation(loc);
        },
        describeLocation: function (loc) {
          return describeBrowseLocation(loc);
        },
        t: function (key) {
          return tUi(key, NAV_HISTORY_ZH[key] || key);
        },
        tFmt: function (key, map) {
          var zh = NAV_HISTORY_ZH[key] || key;
          if (!map) return tUi(key, zh);
          for (var k in map) {
            if (Object.prototype.hasOwnProperty.call(map, k)) {
              zh = zh.split('{' + k + '}').join(String(map[k]));
            }
          }
          return tUi(key, zh);
        },
        // 设置页是真模态（左侧分栏被占），让历史导航让位；搜图 / 人物页**不挡** ——
        // 那两页没有自己的返回入口，挡住等于把用户关在里面。
        canNavigate: function () {
          return !document.documentElement.classList.contains('settings-page-open');
        },
      },
    })
  : null;

/** 记录当前浏览位置（各导航入口调用；同位置幂等） */
function recordBrowseLocation() {
  if (!navHistory) return;
  navHistory.record(captureBrowseLocation());
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
  // 🔴 只有 skipFetch（调用方明确要求「用内存里的 state.rootFolders 重画一遍」）才可以拿
  // `state.rootFolders` 做短路判据。绝不能拿它给「去数据库拉一次」的默认路径做前置闸门：
  // `state.rootFolders` 是一份**可能过时的缓存**，它没被谁更新过就等于「数据没变」——
  // 而真正的事实是 root_folders 表已经变了（最典型：扫描登记了新根，而
  // loadRootFolders 的 lite 分支当时读到的还是空表、没写回 state.rootFolders）。
  // 那时这里会一直判等 → 直接 return → 连 2.2 秒的设置页轮询也叫不动它 →
  // 列表**永久**停在旧内容（实测扫描早已结束、库里已有根，界面 160 秒不刷新）。
  // 默认路径一律先拉再比（下面 fetch 之后的指纹比较才是正确用法）。
  if (skipFetch && hasReal && state._settingsFolderListFp != null) {
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
  // 顺带校正「重新扫描全部」的忙碌态文案与置灰（切语言后 [data-i18n] 会被统一重画，
  // 这里把忙碌态再盖回去；本函数在扫描期间每 3s 都会被实时刷新调到）。
  syncSettingsRescanAllBtn();
  return settingsUi.renderSettingsFolderListFromRows(folders, {
    onRescan: handleSettingsRescan,
    onRemove: handleSettingsRemove,
  });
}

async function handleSettingsRescan(rootPath) {
  if (
    !(await appConfirm(
      tUi(
        'settings.folderRescanConfirm',
        '将重新遍历该根目录，仅更新有变动的文件。\n' +
          '未变化记录会保留；本次未扫描到的记录会标记为失效并在界面隐藏（不会立刻删除）。\n\n' +
          '适用于：在资源管理器中调整子文件夹（移动、重命名）、大量增删图片后索引与实际不一致等情况。\n\n' +
          '提示：失效记录保留缩略图和指纹；仅在“清理失效文件记录”时才会物理删除。\n\n' +
          '确定继续？',
      ),
    ))
  ) {
    return;
  }
  state.isScanning = true;
  state.isScanPaused = false;
  if (dom.scanProgress) dom.scanProgress.style.display = 'block';
  startScanLiveRefresh();
  var cancelBtn = document.getElementById('taskScanCancel');
  var pauseResumeBtn = document.getElementById('taskScanPause');
  if (cancelBtn) {
    cancelBtn.style.display = '';
    cancelBtn.textContent = scanFlow.scanStopLabel(false);
    cancelBtn.disabled = false;
  }
  if (pauseResumeBtn) {
    pauseResumeBtn.style.display = '';
    pauseResumeBtn.disabled = false;
    pauseResumeBtn.textContent = scanFlow.scanPauseLabel(false);
  }
  updateProgress(0, 1, tUi('task.scanPreparing', '准备中...'));

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
        updateProgress(
          1,
          1,
          tUiFmt(
            'task.rescanDoneMarked',
            { n: cleaned },
            '重扫完成，已标记失效记录 ' + cleaned + ' 条',
          ),
        );
      }
    } else if (!result || !result.cancelled) {
      appAlert(
        tUiFmt(
          'task.rescanFailed',
          { err: (result && result.error) || tUi('task.unknownError', '未知错误') },
          '重新扫描失败：' + ((result && result.error) || '未知错误'),
        ),
      );
    }
    tickBackgroundTasksOnce();
  });
  tickBackgroundTasksOnce();
}

/**
 * 「重新扫描全部」按钮的忙碌态。
 *
 * 🔴 只按 `state.rescanAllBusy` 置灰，**不按目录数置灰**：判断「有没有目录」的事实只在库里，
 * 渲染端手里只有 `state.rootFolders` 这份可能过时的缓存。拿它当闸门就会造出
 * 「明明有目录、按钮却是灰的」这类假死（扫描刚登记了新根、这一拍还没同步到时它正是空的）。
 * 空库交给主进程回答（点下去回来 `error: 'empty'`），按钮因此永远可点。
 */
function syncSettingsRescanAllBtn() {
  var btn = dom.settingsRescanAllBtn;
  if (!btn) return;
  var busy = state.rescanAllBusy === true;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  // 忙碌态文案与常态不同。i18n 只在切语言时统一重画 [data-i18n]，这里在开始/结束各设一次；
  // 万一扫描中途切了语言，结束那一次会把文案校正回来。
  btn.textContent = busy
    ? tUi('settings.rescanAllBusy', '正在重新扫描…')
    : tUi('settings.rescanAll', '重新扫描全部');
}

/**
 * 设置页「重新扫描全部」：一条命令重扫**所有**根目录。
 *
 * 与 `handleSettingsRescan` 同一套语义（只更新有变动的文件；本次未扫到的记录标记为失效并在
 * 界面隐藏，不物理删除），区别只在「谁来枚举根目录」—— 这里交给主进程读库，
 * 不传渲染端的 `state.rootFolders`（同上：可能过时的缓存）。
 *
 * 主进程把 N 个任务一次性排上，队列内部仍是**串行**（一次只扫一个目录、整段独占写库闸门），
 * 用户能在全局任务条上看到「扫描队列 · 还有 N 项等待」。点「停止」走 cancelScan，
 * 主进程的 `clearPendingScanQueue()` 会把还没开始的目录一并结算成 cancelled ⇒ 整批一起停。
 */
async function handleSettingsRescanAll() {
  if (state.rescanAllBusy) return;
  if (!(api && api.has('rescanAllFolders'))) return;
  if (
    !(await appConfirm(
      tUi(
        'settings.rescanAllConfirm',
        '将依次重新遍历全部根目录，仅更新有变动的文件。\n' +
          '未变化记录会保留；本次未扫描到的记录会标记为失效并在界面隐藏（不会立刻删除）。\n\n' +
          '逐个目录串行执行，点「停止」会连同还没开始的目录一起取消。\n\n' +
          '确定继续？',
      ),
      tUi('settings.rescanAll', '重新扫描全部'),
    ))
  ) {
    return;
  }

  state.rescanAllBusy = true;
  state.isScanning = true;
  state.isScanPaused = false;
  syncSettingsRescanAllBtn();
  if (dom.scanProgress) dom.scanProgress.style.display = 'block';
  startScanLiveRefresh();
  var cancelBtn = document.getElementById('taskScanCancel');
  var pauseResumeBtn = document.getElementById('taskScanPause');
  if (cancelBtn) {
    cancelBtn.style.display = '';
    cancelBtn.textContent = scanFlow.scanStopLabel(false);
    cancelBtn.disabled = false;
  }
  if (pauseResumeBtn) {
    pauseResumeBtn.style.display = '';
    pauseResumeBtn.disabled = false;
    pauseResumeBtn.textContent = scanFlow.scanPauseLabel(false);
  }
  updateProgress(0, 1, tUi('settings.rescanAllPreparing', '正在准备重新扫描全部目录...'));
  tickBackgroundTasksOnce();

  var result;
  try {
    result = await api.rescanAllFolders();
  } catch (err) {
    result = { success: false, error: (err && err.message) || String(err) };
  }

  state.rescanAllBusy = false;
  state.isScanning = false;
  state.isScanPaused = false;
  stopScanLiveRefresh();
  syncSettingsRescanAllBtn();
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (pauseResumeBtn) pauseResumeBtn.style.display = 'none';

  if (result && result.success) {
    // 整批跑完了（或中途被停）：无论如何都要把列表与统计拉一次，已扫过的目录不能白扫。
    markBrowseDataStale({ settingsPageDirty: true });
    await loadStats();
    await loadRootFolders(state.rootFolders.length > 0, true);
    await renderSettingsFolderList();
    var total = Number(result.total) || 0;
    var stopped = Number(result.cancelled) || 0;
    var failed = Number(result.failed) || 0;
    var cleaned = Number(result.cleanupDeleted) || 0;
    if (stopped > 0) {
      updateProgress(
        1,
        1,
        tUiFmt('task.scanStopped', { n: stopped }, '已停止：' + stopped + ' 个目录未扫描完成'),
      );
    } else if (cleaned > 0) {
      updateProgress(
        1,
        1,
        tUiFmt(
          'task.rescanDoneFoldersMarked',
          { n: total, m: cleaned },
          '重扫完成（' + total + ' 个目录），已标记失效记录 ' + cleaned + ' 条',
        ),
      );
    } else {
      updateProgress(
        1,
        1,
        tUiFmt('task.rescanDoneFolders', { n: total }, '重扫完成，共 ' + total + ' 个目录'),
      );
    }
    if (failed > 0) {
      appAlert(
        tUiFmt(
          'settings.rescanAllPartialFail',
          {
            failed: failed,
            total: total,
            error: result.error || tUi('settings.common.unknownError', '未知错误'),
          },
          failed + '/' + total + ' 个目录重新扫描失败：' + (result.error || '未知错误'),
        ),
      );
    }
  } else {
    var code = result && result.error;
    if (code === 'empty') {
      appAlert(tUi('settings.rescanAllEmpty', '还没有添加任何目录，先在「添加目录」里选一个吧。'));
    } else {
      appAlert(
        tUiFmt(
          'settings.rescanAllFail',
          { error: code || tUi('settings.common.unknownError', '未知错误') },
          '重新扫描失败: ' + (code || '未知错误'),
        ),
      );
    }
  }
  tickBackgroundTasksOnce();
}

async function handleSettingsRemove(rootPath) {
  if (
    !(await appConfirm(
      tUi(
        'settings.folderRemoveConfirm',
        '确定要移除此目录吗？\n移除后该目录下的图片索引将被清除，图片文件不会被删除。',
      ),
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
      hintEl.textContent = tUiFmt(
        'settings.hlsCacheSavedFmt',
        { gb: gbEl.value, en: enEl.value },
        '已保存：' + gbEl.value + 'GB / ' + enEl.value + ' 目录（新会话按新阈值生效）',
      );
    }
    saveLastSettingsSectionId('settingsSectionStorage');
    if (state.currentTab === 'settings') renderSettingsNav('settingsSectionStorage');
  } catch (e) {
    appAlert(
      tUiFmt(
        'settings.hlsCacheSaveFailFmt',
        { err: e && e.message ? e.message : String(e) },
        '保存 HLS 缓存设置失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
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
    // 🔴 改完档位必须立刻重画「重建」那一行：目标规格变了 ⇒ 已有队列作废，
    //    状态行的文案要从「还有 N 张待重建」换成「需按新规格重新登记」。
    //    漏了这一步，用户会拿着一个**已经作废的待办数**去点重建（那个数和接下来实际
    //    要跑的量不是一回事，而且它不会自己变）。
    void refreshThumbnailRebuildStatus();
  } catch (e) {
    appAlert(
      tUiFmt(
        'settings.thumbApplyFailFmt',
        { err: e && e.message ? e.message : String(e) },
        '应用缩略图设置失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
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

/**
 * 缩略图补全并发度的**渲染层**归一化。
 *
 * ⚠️ 这里的兜底值（4）与上界（8）必须与主进程**同值**：
 * `src/main.js#THUMB_BACKFILL_CONCURRENCY_DEFAULT / _MAX`。
 * 渲染层是独立进程、拿不到那边的常量，所以这一份只能手写 —— 改主进程那两个常量时
 * **必须一起改这里**，否则「配置文件坏掉 / 字段缺失」时两边会给出不同的默认值，
 * 症状是设置页显示的数与实际生效的数不一致，且不报错。
 *
 * 🔴 为什么默认从 3 提到 4：见 `src/main.js#createDefaultSettings()` 里那张两轮实测表
 * （冷读拐 4、热读拐 8、12/16 无增益）。
 */
function normalizeThumbBackfillConcurrency(v) {
  var c = parseInt(v, 10);
  if (isNaN(c) || c < 1) c = 4;
  if (c > 8) c = 8;
  return c;
}

function normalizeUiLocale(s) {
  return s === 'en' ? 'en' : 'zh-CN';
}

/**
 * 缓存「已应用的一般设置」——用于 settings.js 的变更检测（逐字段比，全等就短路不保存）。
 *
 * 🔴 这里是**逐个列举字段**的，不是展开整对象。所以**每新增一维外观都必须加一行**，
 * 漏了的后果极其隐蔽（2026-10-05 实测）：`settings.js` 比的是
 * `appearance.uiOpacity === (ap.uiOpacity || 'opaque')`，而 ap 里没有这个键时
 * 右式恒为 **默认值** → 用户把这一维**切回默认值**（不透明 / 无纹理）时判「无变化」→
 * 整次保存被短路吞掉。症状 = 「选了通透再想关掉，关不掉」，而开/切其他档全都正常。
 * 这一条静态护栏（theme-regression §9h）单独守。
 *
 * ⚠️ 2026-10-05 再加一维「窗口背景」时**又一次**踩在同一个位置：`uiWindowBackdrop`
 * 只有「加进来」这一条路，漏了就是「亚克力切不回实色、保存被吞」——因为窗口重启才重建，
 * 表现比透明度那次更隐蔽（本来就「要重启才生效」，很容易被当成「重启没生效」）。
 */
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
    uiTexture: normalizeUiTexture(s.uiTexture),
    uiOpacity: normalizeUiOpacity(s.uiOpacity),
    uiWindowBackdrop: normalizeUiWindowBackdrop(s.uiWindowBackdrop),
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
  var activeEl =
    active && (active.id === 'settingThemeStyle' || active.id === 'quickThemeStyle') ? active : null;
  var el =
    activeEl || document.getElementById('settingThemeStyle') || document.getElementById('quickThemeStyle');
  if (!el) {
    return appearanceUi.getDefaultThemeStyleId
      ? appearanceUi.getDefaultThemeStyleId()
      : 'midnight_classic';
  }
  // ⚠️ 空串是合法值（自定义组合），不能用 truthy 判断 —— 否则自定义状态会被读成默认预设
  return normalizeThemeStyle(el.value);
}

async function persistGeneralSettingsFromControls() {
  return settingsSync.persistGeneralSettingsFromControls({
    state: state,
    dom: dom,
    api: api,
    onGetAppearanceControlValue: getAppearanceControlValue,
    onSyncAppearanceFromSettings: syncAppearanceFromSettings,
    onSetGeneralSettingsAppliedFromObject: setGeneralSettingsAppliedFromObject,
    onSyncAppearanceControls: syncAppearanceControls,
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

// === 图片信息面板：显示哪些字段 ===

async function persistInfoPanelFieldsFromForm() {
  return settingsSync.persistInfoPanelFieldsFromForm({
    state: state,
    api: api,
    appAlert: appAlert,
    onApplyInfoPanelFieldsFromSettings: function (s) {
      return settingsSync.applyInfoPanelFieldsFromSettings({
        state: state,
        settings: s,
        onRerender: refreshOpenPreviewInfoPanel,
      });
    },
    onSaveLastSettingsSectionId: saveLastSettingsSectionId,
    onRenderSettingsNav: renderSettingsNav,
  });
}

/** 把勾选框全部置成同一个值再提交（「全选」/「全不选」共用这条） */
function setAllInfoPanelFieldsChecked(enabled) {
  var host = document.getElementById('settingsInfoFields');
  if (!host) return;
  var checks = host.querySelectorAll('input[data-info-field]');
  for (var i = 0; i < checks.length; i++) checks[i].checked = !!enabled;
  void persistInfoPanelFieldsFromForm();
}

/** 恢复注册表的默认集（不是「全选」——原始值字段默认是关的） */
function resetInfoPanelFieldsToDefault() {
  var fields = window.PhotoInfoFields;
  var host = document.getElementById('settingsInfoFields');
  if (!fields || !host) return;
  var def = {};
  for (var d = 0; d < fields.DEFAULT_FIELD_IDS.length; d++) def[fields.DEFAULT_FIELD_IDS[d]] = true;
  var checks = host.querySelectorAll('input[data-info-field]');
  for (var i = 0; i < checks.length; i++) {
    checks[i].checked = !!def[checks[i].getAttribute('data-info-field')];
  }
  void persistInfoPanelFieldsFromForm();
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

/**
 * 🔴 右侧抽屉（图片信息 / 整理）开合时，把「下一张」按钮让开。
 *
 * 两个抽屉都是 `right: 0; width: 360px; z-index: 20`，而 `.preview-nav` 是
 * `right: 16px; z-index: 6` ⇒ 抽屉一开就把右箭头**整个**盖住：点它没反应，
 * 也不报错（实测见 `styles.css` 里 `.preview-overlay.has-right-drawer` 那条的注释）。
 * CSS 那一侧靠这个类做判据；本函数是**唯一**的写点。
 */
function _syncPreviewRightDrawerClass() {
  // 🔴 类挂在 `#previewOverlay` 上，**不是** `.preview-body`：要让位的两个东西里，
  //    `.preview-next` 在里面、`.preview-zoom-box` 在外面（它是 overlay 的直接子元素）。
  //    挂在 `.preview-body` 上就够不着缩放胶囊 —— 而那个恰好在截图里最显眼。
  var overlay = dom.previewOverlay;
  if (!overlay) return;
  var infoOpen = !!(dom.previewInfoPanel && dom.previewInfoPanel.classList.contains('open'));
  var orgOpen = !!(dom.previewOrgPanel && dom.previewOrgPanel.classList.contains('open'));
  overlay.classList.toggle('has-right-drawer', infoOpen || orgOpen);
}

/**
 * 收起图片信息抽屉。**唯一的收起点** —— 开关按钮、点外部、Esc、以及
 * 「打开整理抽屉」都走这里，免得四条路径各写一遍 `classList.remove('open')`
 * 却只有三条顺带把监听摘掉（漏的那条会让下一次点外部莫名其妙地收起）。
 */
function closePreviewInfoPanel() {
  var panel = dom.previewInfoPanel;
  if (!panel || !panel.classList.contains('open')) return;
  panel.classList.remove('open');
  _removePreviewInfoPanelListeners();
  _syncPreviewRightDrawerClass();
}

function togglePreviewInfoPanel() {
  var panel = dom.previewInfoPanel;
  if (!panel) return;
  var isOpen = panel.classList.contains('open');
  if (isOpen) {
    closePreviewInfoPanel();
  } else {
    // 🔴 与「整理」抽屉互斥：两者都是贴右侧的 360px 滑出抽屉，同时打开会叠在一起。
    closePreviewOrgPanel();
    panel.classList.add('open');
    _syncPreviewRightDrawerClass();
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
  closePreviewInfoPanel();
}

function _closePreviewInfoPanelOnEsc(e) {
  if (e.key === 'Escape') closePreviewInfoPanel();
}

function _addPreviewInfoPanelListeners() {
  document.addEventListener('click', _closePreviewInfoPanelOnOutside);
  document.addEventListener('keydown', _closePreviewInfoPanelOnEsc);
}

function _removePreviewInfoPanelListeners() {
  document.removeEventListener('click', _closePreviewInfoPanelOnOutside);
  document.removeEventListener('keydown', _closePreviewInfoPanelOnEsc);
}

/** 列表行里尺寸列名在不同查询下不一致，按优先级取第一个有效值 */
function pickPhotoDim(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (v != null && v > 0) return v;
  }
  return null;
}

/** 信息面板「浏览」分组的读数：`序号 / 总数`（随机模式的序号与底栏那颗「随机」同源） */
function previewInfoPositionText() {
  if (!(state.previewTotalPhotos > 0)) return '';
  var posNum = state.slideshowRandom
    ? state.previewRandomPositionNum > 0
      ? state.previewRandomPositionNum
      : previewGlobalPositionOne(state.previewIndex)
    : previewGlobalPositionOne(state.previewIndex);
  return posNum + ' / ' + state.previewTotalPhotos;
}

/** 当前启用的字段集（收敛未知 id / 去重 / 按注册表排序都由注册表负责） */
function infoPanelFieldIds() {
  var fields = window.PhotoInfoFields;
  return fields ? fields.normalizeFieldIds(state.infoPanelFields) : [];
}

function infoPanelLocale() {
  return window.I18n && typeof window.I18n.getLocale === 'function'
    ? window.I18n.getLocale()
    : 'zh-CN';
}

/**
 * 面板加载代号。每次 `loadPreviewInfoPanel()` 自增，异步回包比对代号后才允许上屏。
 *
 * 🔴 为什么必须有：面板的三条读数（完整行 / sharp 尺寸 / 主题标签）都是**异步**的，
 *    而切图是同步的。按住 ←/→ 连切时「上一张的回包」会晚于「这一张的首屏」到达，
 *    于是面板显示的是 B 的图片配 A 的读数 —— 而且它看起来完全正常，不报错。
 *    代号挡在 `patchInfo()` 里 = 三条来源一起挡（它们只有这一个写入口）。
 */
var previewInfoLoadSeq = 0;

/**
 * 渲染「图片信息」面板。
 *
 * 字段、顺序、标签**全部**来自 `src/web/js/photo-info-fields.js` 的注册表 —— 这里不硬编码
 * 任何一行，于是「设置页能勾的」与「面板能画的」在结构上不可能漂开（这一轮之前两处各写
 * 一份硬编码清单，网页端那份连尺寸单位都少了个 px）。
 */
function renderPreviewInfoPanel(info) {
  var contentEl = dom.previewInfoPanelContent;
  if (!contentEl) return;
  var fields = window.PhotoInfoFields;
  if (!fields) {
    // 注册表没加载上时必须显式说出来 —— 静默留白会被当成「这张图片没有任何信息」
    contentEl.innerHTML =
      '<div class="preview-info-empty">' +
      escapeHtml(tUi('preview.infoModuleMissing', '图片信息模块未加载')) +
      '</div>';
    return;
  }
  contentEl.innerHTML = fields.buildSectionsHtml(info, {
    fields: infoPanelFieldIds(),
    locale: infoPanelLocale(),
    position: previewInfoPositionText(),
    // 桌面端有搜图页 → 主题标签渲染成可点胶囊（点了带词跳过去搜）。
    // 网页端没有搜图页，那边不传这个开关，胶囊会渲染成不可点的 <span>。
    tagClickable: true,
  });
  bindPreviewInfoTagClicks(contentEl);
}

/**
 * 画面标签胶囊 → 标签导航页的对应标签。
 *
 * 与 `openSemanticSearch` 同构（先关预览、再切页），两者只差「落到哪儿」：
 * 主题标签只能搜图（它的词在导航页里没有节点），画面标签能落到它自己的节点上。
 *
 * 🔴 **顺序不能反**：`showTabContent('tags')` 内部会按 `tabMemory` 还原或**清空**
 *    `state.currentTag`（那条 `applyBrowseTabMemory('tags') === true` 的判断），先设 state
 *    再切页会被它抹掉 —— 现象是「切到了标签页，却停在分类总览」。这里与
 *    `applyBrowseLocation` 的 `case 'tag'` 是同一套顺序（照抄它，不另造一条路）。
 */
function openTagNavTag(tag, node, category) {
  var id = String(tag || '').trim();
  if (!id) return;
  if (dom.previewOverlay && dom.previewOverlay.classList.contains('active')) closePreview();
  if (state.currentTab !== 'tags') showTabContent('tags');
  state.currentView = 'tag';
  state.currentTag = id;
  state.currentTagNode = '';
  state.page = 1;
  // `node` / `category` 由主进程随标签一起给（渲染层没有 `ai/tag-categories`，反查不了）。
  // 带上它 `selectTag` 才能**沿路把侧栏树展开并高亮**；不带的后果是主区有图、侧栏一片
  // 没高亮，用户看不出自己在哪儿（见 `tag-nav-ui.js#selectTag` 的注释）。
  if (tagNavUi) tagNavUi.selectTag(id, String(node || ''), String(category || ''));
  else void loadPhotos();
}

/**
 * 信息面板里的标签胶囊 → 各自的目的地。
 *
 * 两条路**刻意分开**（2026-10-09）：
 *   · 画面标签（`data-joy-tag`）⇒ 标签导航页的那个标签。条目带了英文原名与归属，所以落得准。
 *     这也正是分岔的理由：在面板上看到「盘腿坐」想看看还有哪些张，跳不过去就只能拿中文名
 *     去搜图 —— 搜图走的是查询线 0.55 的语义检索，跟导航页走展示线 0.35 的标签列表
 *     **本来就不是同一批图**。
 *   · 主题标签（`data-ai-tag`）⇒ 搜图。它的词是 308 条词表短语，导航页里没有对应节点。
 *
 * 每次重画都要重挂：`innerHTML` 会把旧节点连同监听器一起丢掉，所以绑定必须写在渲染函数里，
 * 不能放到初始化阶段（那样只有第一次打开预览能点）。
 */
function bindPreviewInfoTagClicks(contentEl) {
  var joyTags = contentEl.querySelectorAll('.preview-info-tag[data-joy-tag]');
  for (var i = 0; i < joyTags.length; i++) {
    (function (el) {
      el.addEventListener('click', function (event) {
        // 面板挂在预览遮罩层里：不拦住冒泡，点击会被预览的「点空白处关闭」等处理器接走。
        event.preventDefault();
        event.stopPropagation();
        openTagNavTag(
          el.getAttribute('data-joy-tag'),
          el.getAttribute('data-tag-node'),
          el.getAttribute('data-tag-category'),
        );
      });
    })(joyTags[i]);
  }
  var tags = contentEl.querySelectorAll('.preview-info-tag[data-ai-tag]');
  for (var j = 0; j < tags.length; j++) {
    (function (el) {
      el.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        openSemanticSearch(el.getAttribute('data-ai-tag'));
      });
    })(tags[j]);
  }
}

function loadPreviewInfoPanel(photo) {
  if (!photo) return;
  var seq = ++previewInfoLoadSeq;
  // 先用列表里已有的基础信息立即上屏（省掉一次 IPC 往返的空白），再用完整行与实时尺寸补齐。
  // 🔴 两条异步来源必须并进**同一个** merged 对象后再重画。曾各自持有自己的对象分别渲染
  //    （完整行渲染 merged、尺寸回补渲染 baseInfo）→「谁后到谁赢」：尺寸后到就吞掉
  //    「媒体类型 / 所属图库」，完整行后到就吞掉「尺寸 / 宽高比 / 总像素」。必现而非偶发。
  var merged = {
    id: photo.id,
    file_name: photo.file_name || '',
    file_path: photo.file_path || '',
    folder_path: photo.folder_path || '',
    file_type: photo.file_type || '',
    width: pickPhotoDim(photo, ['width', 'pixel_width', 'file_width', 'media_width']),
    height: pickPhotoDim(photo, ['height', 'pixel_height', 'file_height', 'media_height']),
    file_size: photo.file_size || 0,
    date_taken: photo.date_taken || '',
    date_modified: photo.date_modified || '',
    is_favorite: photo.is_favorite,
  };
  renderPreviewInfoPanel(merged);

  /**
   * 把一批读数并进 merged 再重画（唯一写入口）。
   * 🔴 尺寸「不降级」：库里存的是 0 时不许覆盖 sharp 实时读到的真实值 —— 本机库
   *    99.99% 的图片尺寸为 0，压掉之后「尺寸 / 宽高比 / 总像素」三行会一起消失。
   */
  function patchInfo(next) {
    if (!next) return;
    // 🔴 已经切到别的图片了 ⇒ 这张的回包直接丢。少了这一句，连切时面板会「显示 B、读数是 A」。
    if (seq !== previewInfoLoadSeq) return;
    for (var k in next) {
      var v = next[k];
      if (v == null) continue;
      if ((k === 'width' || k === 'height') && !(v > 0)) continue;
      merged[k] = v;
    }
    renderPreviewInfoPanel(merged);
  }

  if (window.photoAPI && window.photoAPI.getPhotoInfo) {
    window.photoAPI
      .getPhotoInfo(photo.id)
      .then(patchInfo)
      .catch(function () {});
  }
  // 数据库无尺寸时，用 sharp 实时读取并回补（否则「尺寸 / 宽高比 / 总像素」三行会同时缺失）
  if (
    window.photoAPI &&
    window.photoAPI.getPhotoDimensions &&
    !(merged.width > 0 && merged.height > 0)
  ) {
    window.photoAPI
      .getPhotoDimensions(photo.id)
      .then(function (dims) {
        if (dims && dims.width > 0 && dims.height > 0) {
          // 同步更新内存中的 photo 对象，避免重复读取
          photo.width = dims.width;
          photo.height = dims.height;
          patchInfo(dims);
        }
      })
      .catch(function () {});
  }
  // 主题标签：存在**搜图索引库**（`ai-search/semantic-index.sqlite`）里，不是 `photos`
  // 的列，所以只能走这条独立通道 —— `getPhotoInfo()` 查的是主库连接，跨不了库。
  // 同样必须并进 merged 再重画；空数组不 patch（= 这条不显示，与「空值整行隐藏」一致），
  // 至于「没索引 / 索引了但没标签 / 索引库此刻读不到」三者在这层不区分。
  if (window.photoAPI && window.photoAPI.getPhotoAiTags) {
    window.photoAPI
      .getPhotoAiTags(photo.id, infoPanelLocale())
      .then(function (tags) {
        if (tags && tags.length) patchInfo({ ai_tags: tags });
      })
      .catch(function () {});
  }
  // 画面标签（JoyTag）：在 **tag 索引库**（`ai-search/tag-index.sqlite`）里，同样是
  // `getPhotoInfo()` 跨不了的库 → 第四条独立异步来源，必须并进 merged 再重画。
  // 空数组不 patch（整行隐藏）；中文映射在主进程通道内做，这里拿到的已是显示文本。
  if (window.photoAPI && window.photoAPI.getPhotoJoyTags) {
    window.photoAPI
      .getPhotoJoyTags(photo.id, infoPanelLocale())
      .then(function (tags) {
        if (tags && tags.length) patchInfo({ joy_tags: tags });
      })
      .catch(function () {});
  }
}

/**
 * 重画**开着的**面板；面板没开则什么都做（「没开就返回」的守卫在这里，调用方不用自己判）。
 *
 * 调用点：① 设置页改了字段勾选；② 切语言（分组标题/字段名是渲染时生成的）；
 * ③ 启动期补写 主题标签完成（标签在搜图索引库里，没有别的路径能让它自己变新）；
 * ④ **预览切图** —— 见 openPreview()，漏了它面板就永远停在打开面板那一刻的那张。
 *
 * `photoOverride` 供切图路径显式传入当前张，不依赖 state.previewIndex 的赋值时序。
 */
function refreshOpenPreviewInfoPanel(photoOverride) {
  var panel = dom.previewInfoPanel;
  if (!panel || !panel.classList.contains('open')) return;
  // 只认「像一张图片」的覆盖值：本函数有两处是**裸函数引用**传出去的
  // （`onRerender: refreshOpenPreviewInfoPanel`），将来若有人给它塞事件对象之类，
  // 不能让它把当前张顶掉。
  var photo =
    photoOverride && photoOverride.id != null
      ? photoOverride
      : state.previewPhotos && state.previewPhotos[state.previewIndex];
  if (photo) loadPreviewInfoPanel(photo);
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
  var autoSemanticEl = document.getElementById('settingAutoSemanticIndexOnStartup');
  if (autoSemanticEl) autoSemanticEl.checked = !!s.autoSemanticIndexOnStartup;
  var autoFaceEl = document.getElementById('settingAutoFaceIndexOnStartup');
  if (autoFaceEl) autoFaceEl.checked = !!s.autoFaceIndexOnStartup;
  var stEl = document.getElementById('settingSimilarThreshold');
  if (stEl) stEl.value = String(Math.max(0, Math.min(64, parseInt(s.similarThreshold, 10) || 12)));
  var launchDefaultEl = document.getElementById('settingLaunchDefaultPage');
  if (launchDefaultEl) launchDefaultEl.value = normalizeLaunchDefaultPage(s.launchDefaultPage);
  syncAppearanceControls(s);
  syncSubtitleStyleControlsFromSettings(s);
  applySubtitleStyleFromSettings(s);
  // 信息面板字段勾选：state 是唯一运行期真源，面板与设置页都读它
  settingsSync.applyInfoPanelFieldsFromSettings({
    state: state,
    settings: s,
    onRerender: refreshOpenPreviewInfoPanel,
  });
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

  // 快捷键：**先喂注册表再画界面** —— 注册表是按键判定的唯一入口，
  // 顺序反了就会出现「界面显示新键、按下去还是旧键」的首帧窗口。
  if (window.RendererShortcutSettings) {
    window.RendererShortcutSettings.bindPanel({
      state: state,
      api: api,
      appAlert: appAlert,
    });
    window.RendererShortcutSettings.applyFromSettings({
      state: state,
      settings: s,
    });
  }
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
      void refreshThumbnailRebuildStatus();
      void refreshDuplicateHashStatus();
      void refreshDataDirInfo();
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
      // 🔴 三态：分母「还没估出来」与「估计失败」**都不许**画百分比 ——
      //    `p.total` 为 null 时算成 0% 就是把「不知道」说成「没进展」。
      //    分母语义 = **候选集规模**（候选谓词命中的行数）的**抽样估计值**，所以文案带「约」。
      //    ⚠️ 它**不是**「还缺几张缩略图」。补全按 id 倒序走，而缺缩略图的行几乎全在低位老图片上
      //    ⇒ 拿缺缩略图当分母，任务头几万行里分子恒 0，界面会一直显示 0%（用户就是这么报上来的）。
      //    预览图只作副项出现在文案里。
      var eta = '';
      var es = p.etaSeconds;
      if (
        p.phase === 'ready' &&
        es != null &&
        isFinite(es) &&
        es > 0 &&
        typeof scanFlow.formatEtaLine === 'function'
      ) {
        var line = scanFlow.formatEtaLine(es);
        if (line) eta = tUi('settings.task.thumbEtaPrefix', '，') + line;
      }
      var thumbMsg;
      if (p.phase === 'ready' && p.total > 0) {
        thumbMsg = tUiFmt(
          'settings.task.thumbProgressRunning',
          {
            done: p.done,
            total: p.total,
            pct: p.pct || 0,
            thumbs: p.thumbs || 0,
            exifFilled: p.exifFilled || 0,
            failed: p.failed,
            eta: eta,
          },
          '补全中：已处理 ' +
            p.done +
            ' / 约 ' +
            p.total +
            '（' +
            (p.pct || 0) +
            '%），预览图 ' +
            (p.thumbs || 0) +
            ' 张，拍摄信息 ' +
            (p.exifFilled || 0) +
            ' 张，失败 ' +
            p.failed +
            eta,
        );
      } else if (p.phase === 'counting') {
        thumbMsg = tUiFmt(
          'settings.task.thumbProgressCounting',
          { done: p.done },
          '补全中：已处理 ' + p.done + ' 张，正在估计待补数量…',
        );
      } else {
        thumbMsg = tUiFmt(
          'settings.task.thumbProgressNoTotal',
          { done: p.done },
          '补全中：已处理 ' +
            p.done +
            ' 张（待补总数估计失败，暂不显示百分比与剩余时间）',
        );
      }
      if (dom.thumbBackfillStatus) dom.thumbBackfillStatus.textContent = thumbMsg;
      if (dom.thumbBackfillStartBtn) dom.thumbBackfillStartBtn.disabled = true;
      if (dom.thumbBackfillCancelBtn) dom.thumbBackfillCancelBtn.style.display = '';
      if (!state.thumbBackfillPolling) {
        state.thumbBackfillPolling = setInterval(refreshThumbnailBackfillStatus, 800);
      }
    } else {
      if (p.total > 0 || p.done > 0 || p.failed > 0) {
        var doneText = p.cancelled
          ? tUi('settings.task.thumbStopped', '已停止')
          : tUi('settings.task.thumbCompleted', '已完成');
        // 完成态同样是**缩略图口径**。分母可能拿不到（统计失败 / 任务只跑了很短一段就被取消）
        // ⇒ 那时只说「补了多少张」，绝不编一个分母出来（`共 null` 这种文案就是静默的假数据）。
        if (dom.thumbBackfillStatus)
          dom.thumbBackfillStatus.textContent =
            p.total > 0
              ? tUiFmt(
                  'settings.task.thumbProgressDone',
                  {
                    doneLabel: doneText,
                    total: p.total,
                    done: p.done,
                    thumbs: p.thumbs || 0,
                    failed: p.failed,
                  },
                  doneText +
                    '：已处理 ' +
                    p.done +
                    ' 张（共约 ' +
                    p.total +
                    '），预览图 ' +
                    (p.thumbs || 0) +
                    ' 张，失败 ' +
                    p.failed,
                )
              : tUiFmt(
                  'settings.task.thumbProgressDoneNoTotal',
                  {
                    doneLabel: doneText,
                    done: p.done,
                    thumbs: p.thumbs || 0,
                    failed: p.failed,
                  },
                  doneText +
                    '：已处理 ' +
                    p.done +
                    ' 张，预览图 ' +
                    (p.thumbs || 0) +
                    ' 张，失败 ' +
                    p.failed,
                );
      } else {
        if (dom.thumbBackfillStatus)
          dom.thumbBackfillStatus.textContent = tUi(
            'settings.task.thumbBackfillDesc',
            '为尚无缩略图的图片后台补齐预览图',
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

function stopThumbnailRebuildPolling() {
  return maintenanceUi.stopThumbnailRebuildPolling({ state: state });
}

/** 「512 px · WEBP」这种规格串：两处文案共用，别各拼一份（大小写不一致就是这么来的）。 */
function formatThumbSpec(size, format) {
  var f = String(format || '').trim().toUpperCase();
  return String(parseInt(size, 10) || 0) + ' px' + (f ? ' · ' + f : '');
}

/**
 * 缩略图**全量重建**的状态行（设置页「缩略图尺寸与质量」下面那一行）。
 *
 * 三种空闲态必须给三种文案（合成一种就是编数据）：
 *   ① `stale`：队列是按**旧**目标登记的 ⇒ 只能说「需重新登记」。
 *      这时**不给任何数字** —— 真实待办数要扫完全库才知道，拿旧队列里的残留数当待办
 *      就是把一个已经作废的数画成当前事实。
 *   ② 有队列且目标一致 ⇒ 报「还有 N 张待重建」。
 *   ③ 从未登记 / 登记完且队列已空 ⇒ 说「规格记录」+ 无待办。
 * 运行期两态（登记 / 抽干）也一样分开：登记阶段一张图都还没重生成，
 * 只报 `done` 的话界面会一动不动，用户合理地以为卡住了。
 */
async function refreshThumbnailRebuildStatus() {
  if (!(api && api.has('getThumbnailRebuildStatus')) || !dom.thumbRebuildStatus) return;
  try {
    var s = (await api.getThumbnailRebuildStatus()) || {};
    var p = s.progress || {};
    var spec = formatThumbSpec(s.targetSize, s.targetFormat);
    var msg;
    if (p.running) {
      if (p.phase === 'enqueueing') {
        msg = tUiFmt(
          'settings.thumbRebuildEnqueueing',
          { spec: spec, scanned: p.scanned || 0, enqueued: p.total || 0 },
          '重建中：正在登记待重建清单（目标 ' +
            spec +
            '），已扫描 ' +
            (p.scanned || 0) +
            ' 行，已登记 ' +
            (p.total || 0) +
            ' 张…',
        );
      } else {
        var eta = '';
        var es = p.etaSeconds;
        if (
          es != null &&
          isFinite(es) &&
          es > 0 &&
          typeof scanFlow.formatEtaLine === 'function'
        ) {
          var line = scanFlow.formatEtaLine(es);
          if (line) eta = tUi('settings.task.thumbEtaPrefix', '，') + line;
        }
        msg = tUiFmt(
          'settings.thumbRebuildRunning',
          {
            spec: spec,
            done: p.done || 0,
            total: p.total || 0,
            pct: p.pct || 0,
            failed: p.failed || 0,
            eta: eta,
          },
          '重建中（目标 ' +
            spec +
            '）：已处理 ' +
            (p.done || 0) +
            ' / ' +
            (p.total || 0) +
            '（' +
            (p.pct || 0) +
            '%），失败 ' +
            (p.failed || 0) +
            ' 张' +
            eta,
        );
      }
      if (dom.thumbRebuildStartBtn) dom.thumbRebuildStartBtn.disabled = true;
      if (dom.thumbRebuildCancelBtn) dom.thumbRebuildCancelBtn.style.display = '';
      // 状态行自己的轮询：与 `background-tasks-changed` 事件互补（事件有节流，可能漏掉收尾那一下）
      if (!state.thumbRebuildPolling) {
        state.thumbRebuildPolling = setInterval(refreshThumbnailRebuildStatus, 800);
      }
    } else {
      var failedPart = '';
      if ((s.failed || 0) > 0) {
        failedPart = tUiFmt(
          'settings.thumbRebuildFailedPart',
          { failed: s.failed },
          '，失败 ' + s.failed + ' 张（保留原缩略图）',
        );
      }
      if (s.stale) {
        msg = tUiFmt(
          'settings.thumbRebuildStale',
          { spec: spec },
          '目标规格：' +
            spec +
            ' · 待重建清单需按新规格重新登记（点下方按钮开始，会先扫描全库）',
        );
      } else if (!s.total) {
        msg = tUiFmt(
          'settings.thumbRebuildIdleEmpty',
          { spec: spec },
          '目标规格：' + spec + ' · 尚未重建过，点下方按钮把已入库的缩略图重跑一遍',
        );
      } else if ((s.pending || 0) > 0) {
        msg = tUiFmt(
          'settings.thumbRebuildIdlePending',
          { spec: spec, pending: s.pending, total: s.total, failedPart: failedPart },
          '目标规格：' +
            spec +
            ' · 还有 ' +
            s.pending +
            ' 张待重建（共 ' +
            s.total +
            ' 张）' +
            failedPart,
        );
      } else {
        msg = tUiFmt(
          'settings.thumbRebuildIdleDone',
          { spec: spec, total: s.total, failedPart: failedPart },
          '目标规格：' + spec + ' · 已全部重建（共 ' + s.total + ' 张）' + failedPart,
        );
      }
      if (dom.thumbRebuildStartBtn) dom.thumbRebuildStartBtn.disabled = false;
      if (dom.thumbRebuildCancelBtn) dom.thumbRebuildCancelBtn.style.display = 'none';
      stopThumbnailRebuildPolling();
    }
    dom.thumbRebuildStatus.textContent = msg;
  } catch (e) {
    if (dom.thumbRebuildStatus)
      dom.thumbRebuildStatus.textContent = tUi(
        'settings.thumbRebuildReadError',
        '缩略图重建状态读取失败',
      );
    stopThumbnailRebuildPolling();
  }
}

async function startThumbnailRebuild() {
  if (!(api && api.has('startThumbnailRebuild'))) return;
  var s = null;
  try {
    s = await api.getThumbnailRebuildStatus();
  } catch (e) {
    void e;
  }
  // 🔴 一律先确认：这是一遍**全库重编码**（机械盘上以小时计、抢的是用户正在浏览的那块盘），
  //    文案按当前状态分三种，别用一句笼统的「是否继续？」把「扫全库登记」这件事藏起来。
  var detail;
  if (s && s.stale) {
    detail = tUi(
      'settings.thumbRebuildConfirmReset',
      '目标规格已改变，将先扫描全库重新登记待重建清单，再逐张重跑缩略图。过程可能持续数小时并占用磁盘，期间可以随时停止、下次继续。',
    );
  } else if (s && s.pending > 0) {
    detail = tUiFmt(
      'settings.thumbRebuildConfirmResume',
      { pending: s.pending },
      '还有 ' + s.pending + ' 张待重建，将接着上次的进度继续。期间可以随时停止、下次继续。',
    );
  } else {
    detail = tUi(
      'settings.thumbRebuildConfirmStart',
      '将扫描全库，把缩略图都按当前档位重新生成一遍。过程可能持续数小时并占用磁盘，期间可以随时停止、下次继续。',
    );
  }
  if (!(await appConfirm(detail))) return;
  if (dom.thumbRebuildStartBtn) dom.thumbRebuildStartBtn.disabled = true;
  try {
    var result = await api.startThumbnailRebuild();
    if (!result || !result.success) {
      appAlert(
        tUiFmt(
          'settings.thumbRebuildStartFail',
          {
            error: (result && result.error) || tUi('settings.common.unknownError', '未知错误'),
          },
          '启动重建失败：' + ((result && result.error) || '未知错误'),
        ),
      );
    }
  } finally {
    refreshThumbnailRebuildStatus();
  }
}

async function cancelThumbnailRebuild() {
  if (!(api && api.has('cancelThumbnailRebuild'))) return;
  await api.cancelThumbnailRebuild();
  refreshThumbnailRebuildStatus();
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

/* ============ 主进程发起的提示 / 确认（主题弹窗 + 回执） ============ */

/**
 * 主进程没有界面，它自己弹的 `dialog.showMessageBox` 是**系统**外观 —— 亮色主题下灰底、
 * 暗色主题下白底，跟应用里其它弹窗（`#appDialogOverlay`）是两套。所以提示统一由主进程
 * 发一个请求、这里用同一个主题弹窗画出来，再把结果回执过去。
 *
 * 🔴 **必须回执**（成功失败都要）：主进程那边是一条等着的 Promise，漏回执等于
 *    「点了按钮永远没反应」，要等满 20 秒超时才回落系统弹窗。
 * 🔴 文案优先走 `i18n` 键，由渲染端按当前语言渲染 —— 主进程拼界面文案在换语言时不会变。
 */
function bindAppDialogRequests() {
  if (!(api && api.has('onAppDialogRequest'))) return;
  api.onAppDialogRequest(function (req) {
    if (!req || !req.id) return;
    var spec = req.i18n || {};
    var isConfirm = req.type === 'confirm';
    var title = spec.titleKey
      ? tUi(spec.titleKey, req.title || '')
      : req.title ||
        (isConfirm ? tUi('dialog.confirmTitle', '请确认') : tUi('dialog.title', '提示'));
    var message = spec.messageKey
      ? tUiFmt(spec.messageKey, spec.params || {}, req.message || '')
      : req.message || '';
    var okText = spec.okTextKey
      ? tUi(spec.okTextKey, req.okText || '')
      : req.okText || (isConfirm ? tUi('dialog.ok', '确定') : tUi('dialog.gotIt', '知道了'));
    var cancelText = spec.cancelTextKey
      ? tUi(spec.cancelTextKey, req.cancelText || '')
      : req.cancelText || tUi('dialog.cancel', '取消');

    var show =
      window.RendererDialogUI && typeof window.RendererDialogUI.showAppDialog === 'function'
        ? window.RendererDialogUI.showAppDialog
        : null;
    if (!show) {
      api.respondAppDialog({ id: req.id, confirmed: false });
      return;
    }
    Promise.resolve(
      show({ type: req.type, title: title, message: message, okText: okText, cancelText: cancelText }),
    )
      .then(function (result) {
        api.respondAppDialog({ id: req.id, confirmed: result === true });
      })
      .catch(function () {
        api.respondAppDialog({ id: req.id, confirmed: false });
      });
  });
}

/* ==================== 数据库位置（设置页「媒体与存储」最后一行） ==================== */

function fmtBytes(n) {
  if (window.RendererUtils && typeof window.RendererUtils.formatSize === 'function') {
    return window.RendererUtils.formatSize(n);
  }
  var v = Number(n) || 0;
  return v >= 1073741824
    ? (v / 1073741824).toFixed(1) + ' GB'
    : v >= 1048576
      ? (v / 1048576).toFixed(0) + ' MB'
      : v + ' B';
}

function setDataDirLine(text) {
  var lineEl = document.getElementById('dataDirCurrentLine');
  if (lineEl) lineEl.textContent = text;
}

function setDataDirButtonsDisabled(disabled) {
  var migrateBtn = document.getElementById('dataDirMigrateBtn');
  var openBtn = document.getElementById('dataDirOpenBtn');
  if (migrateBtn) migrateBtn.disabled = !!disabled;
  if (openBtn) openBtn.disabled = !!disabled;
}

function describeDataDirInfo(info) {
  var parts = [
    tUiFmt(
      'settings.storage.dataDirCurrentFmt',
      { path: info.dataDir, size: fmtBytes(info.totalBytes) },
      '当前位置：' + info.dataDir + '（占用 ' + fmtBytes(info.totalBytes) + '）',
    ),
  ];
  if (info.freeBytes >= 0) {
    parts.push(
      tUiFmt(
        'settings.storage.dataDirFreeFmt',
        { free: fmtBytes(info.freeBytes) },
        '该盘剩余 ' + fmtBytes(info.freeBytes),
      ),
    );
  }
  // 回退时（比如盘没插）「已改为自定义位置」是假话 —— 这时生效的就是默认位置，
  // 下面那条 fallback 提示会说明原因，两句并排会让用户以为两个位置都在用。
  if (info.isCustom && info.defaultDataDir && !info.fallbackReason) {
    parts.push(
      tUiFmt(
        'settings.storage.dataDirCustomHint',
        { path: info.defaultDataDir },
        '已改为自定义位置（默认位置：' + info.defaultDataDir + '）',
      ),
    );
  }
  // 「配了新位置却没用上」必须常驻显示：那时候库多半是空的，用户第一反应是数据丢了。
  if (info.fallbackReason) {
    parts.push(
      tUiFmt(
        'settings.storage.dataDirFallbackFmt',
        { reason: info.fallbackReason },
        '⚠️ 你指定的位置这次打不开，本次启动临时改用了默认位置（' + info.fallbackReason + '）',
      ),
    );
  }
  return parts.join(tUi('common.partSep', '　·　'));
}

async function refreshDataDirInfo() {
  if (!(api && api.has('getDataDirInfo'))) return;
  var lineEl = document.getElementById('dataDirCurrentLine');
  if (!lineEl) return;
  try {
    var info = await api.getDataDirInfo();
    if (!info || !info.success) {
      setDataDirLine(
        tUiFmt(
          'settings.storage.dataDirReadFailFmt',
          { error: (info && info.error) || tUi('settings.common.unknownError', '未知错误') },
          '读取位置信息失败：' + ((info && info.error) || '未知错误'),
        ),
      );
      return;
    }
    state.dataDirInfo = info;
    setDataDirLine(describeDataDirInfo(info));
    // 技术细节（原始报错）不进正文，挂 title 里 —— 正文说人话，想排查的人悬停就能看到。
    lineEl.title = info.fallbackDetail || '';
    setDataDirButtonsDisabled(!!info.migrating);
  } catch (e) {
    setDataDirLine(
      tUiFmt(
        'settings.storage.dataDirReadFailFmt',
        { error: e && e.message ? e.message : String(e) },
        '读取位置信息失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
  }
}

/** 迁移进度：主进程推过来的累计字节，直接落在这行状态上（迁移中不再覆盖成「读取中」）。 */
function bindDataDirProgressListener() {
  if (!(api && api.has('onDataDirMigrateProgress'))) return;
  api.onDataDirMigrateProgress(function (p) {
    if (!p) return;
    if (!p.running && p.phase !== 'done') return;
    var label = '';
    if (p.phase === 'prepare') label = tUi('settings.storage.dataDirPhasePrepare', '正在准备…');
    else if (p.phase === 'release')
      label = tUi('settings.storage.dataDirPhaseRelease', '正在暂停图库读写…');
    else if (p.phase === 'verify') {
      // 把「已经等了多久」和「为什么可能要几分钟」一起说清楚：这一步是整份副本读完，
      // 真库实测 5 分 19 秒 —— 只说「正在检查…」就等于让用户以为它死了。
      var verifyMs = Number(p.verifyMs) || 0;
      label = verifyMs
        ? tUiFmt(
            'settings.storage.dataDirPhaseVerifyFmt',
            { elapsed: fmtElapsedMs(verifyMs) },
            '正在检查新位置的数据…（' +
              fmtElapsedMs(verifyMs) +
              '）\n大图库这一步要几分钟，请不要关闭窗口。',
          )
        : tUi(
            'settings.storage.dataDirPhaseVerify',
            '正在检查新位置的数据…\n大图库这一步要几分钟，请不要关闭窗口。',
          );
    }
    else if (p.phase === 'cleanup') label = tUi('settings.storage.dataDirPhaseCleanup', '正在清理原位置…');
    else if (p.phase === 'copy') {
      label = tUiFmt(
        'settings.storage.dataDirMigratingFmt',
        { percent: p.percent, current: p.current || '' },
        '正在迁移…' + p.percent + '%（' + (p.current || '') + '）',
      );
    }
    if (label) setDataDirLine(label);
    if (p.running) setDataDirButtonsDisabled(true);
  });
}

/** 被写库闸门挡住时的自动重试节奏：30 × 3 s ≈ 90 s，之后如实说「等它跑完再点一次」。 */
var BUSY_RETRY_MAX = 30;
var BUSY_RETRY_INTERVAL_MS = 3000;

function sleepMs(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * 「已等多久」的本地化写法（迁移校验阶段用）。
 *
 * 🔴 这一步**必须给秒数**：校验要把新位置那份副本完整读一遍，真库实测 18 GB 要
 *    **5 分 19 秒**。只写「正在检查新位置的数据…」放五分钟，用户唯一能得出的结论就是
 *    「它卡死了」（他报的原话就是这个）—— 而秒数在走就等于「它一直在读盘」。
 */
function fmtElapsedMs(ms) {
  // ⚠️ `Math.max(0, NaN)` 还是 `NaN` —— 少了这个判断，一个读不到的 ms 会被写成
  //    「已等 NaN 分 NaN 秒」，而它跟卡死在用户眼里是同一件事。没有读数 / 时钟回拨一律按 0。
  var total = Math.round(Number(ms) / 1000);
  if (!(total > 0)) total = 0;
  var minutes = Math.floor(total / 60);
  var seconds = total % 60;
  if (minutes <= 0)
    return tUiFmt('settings.storage.dataDirVerifySecFmt', { seconds: seconds }, '已等 ' + seconds + ' 秒');
  return tUiFmt(
    'settings.storage.dataDirVerifyMinFmt',
    { minutes: minutes, seconds: seconds },
    '已等 ' + minutes + ' 分 ' + seconds + ' 秒',
  );
}

/**
 * 把「这一次尝试报回来的暂停」并进累积表（纯函数，按 label+scope 去重）。
 *
 * 🔴 **为什么必须累积而不能只看最后一次的返回值**：暂停是发生在**某一次尝试**里的 ——
 *    真实 change 探针（`.workbuddy/tmp/data-dir-paused-cleanup-probe.js`）实测到的形状是
 *    第一次返回 `code:'BUSY'` 且带着 `pausedTasks:[{清理失效记录, startup}]`（它已经把清理
 *    摘下来了，但在途那一批还握着写锁），**第二次就成功了、`pausedTasks` 是空的** ⇒
 *    暂停真的发生了、界面一个字都没说，用户下次启动看到清理「从零开始」也无处可对。
 *
 * @param {Array<{label: string, scope: string}>} seen 已累积的（不改动它）
 * @param {{pausedTasks?: Array<{label: string, scope: string}>}|null|undefined} res 这一次的返回
 * @returns {Array<{label: string, scope: string}>} 新的累积表（没有新增时按原样返回）
 */
function mergePausedTasks(seen, res) {
  var list = Array.isArray(seen) ? seen.slice() : [];
  var incoming = (res && res.pausedTasks) || [];
  for (var i = 0; i < incoming.length; i++) {
    var t = incoming[i] || {};
    var label = String(t.label || '');
    if (!label) continue; // 没有名字的条目说不清是什么，宁可不说
    var scope = String(t.scope || '');
    var dup = false;
    for (var j = 0; j < list.length; j++)
      if (list[j].label === label && list[j].scope === scope) dup = true;
    if (!dup) list.push({ label: label, scope: scope });
  }
  return list;
}

/**
 * 迁移开跑前会把「清理失效记录」让开（它要扫完整个库，在百万行库上是几十分钟到几小时，
 * 等它跑完等于「今天别迁了」，见 `main.js#pauseInvalidCleanupForMigration`）。
 *
 * 🔴 **这件事必须如实说出来**：用户看不到自己的后台任务被悄悄改期。而且要按 `scope` 分开说 ——
 *    自动那一趟是开机自检，**每次启动都会重新排一次**，所以「下次启动会接着做」是真话；
 *    手动那一趟是用户自己点的，没人会替他再点，只能让他知道「再点一次就继续」。
 *    两种口径混成一句就会对一半错一半（只停了手动那次时说「下次启动会自动继续」是假的）。
 *
 * @param {Array<{label: string, scope: string}>|undefined} pausedTasks
 * @returns {string} 待拼到结果文案后面的说明（没有暂停过就是空串）
 */
function dataDirPausedNote(pausedTasks) {
  var list = Array.isArray(pausedTasks) ? pausedTasks : [];
  var names = [];
  var startup = false;
  var manual = false;
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    var label = String(t.label || '');
    if (!label) continue;
    if (names.indexOf(label) === -1) names.push(label);
    if (t.scope === 'startup') startup = true;
    if (t.scope === 'manual') manual = true;
  }
  if (!names.length) return '';
  var labelText = names.join(tUi('common.listSep', '、'));
  var text;
  if (manual && startup) {
    text = tUiFmt(
      'settings.storage.dataDirPausedBothFmt',
      { names: labelText },
      '已为这次迁移暂停「' +
        labelText +
        '」。自动的那一次会在下次启动图库时接着做，手动的那一次需要你再点一次。',
    );
  } else if (manual) {
    text = tUiFmt(
      'settings.storage.dataDirPausedManualFmt',
      { names: labelText },
      '已为这次迁移暂停「' + labelText + '」，需要时再点一次就会接着做。',
    );
  } else if (startup) {
    text = tUiFmt(
      'settings.storage.dataDirPausedFmt',
      { names: labelText },
      '已为这次迁移暂停「' + labelText + '」，下次启动图库时会接着做。',
    );
  } else {
    // 🔴 认不出的 scope **不许拿上面任何一句去猜**：上面两句都在断言「会怎么自动恢复」，
    //    猜错就是一句假话（用户下次启动发现它没恢复，再也不会信这个提示）。
    //    这句只承诺「你可以自己重新开始」—— 无论将来加了哪一类任务，它都是真的。
    text = tUiFmt(
      'settings.storage.dataDirPausedOtherFmt',
      { names: labelText },
      '已为这次迁移暂停「' + labelText + '」，你可以随时重新开始。',
    );
  }
  return '\n' + text;
}

async function migrateDataDir() {
  if (!(api && api.has('migrateDataDir'))) return;
  if (state.dataDirMigrating) {
    void appAlert(tUi('settings.storage.dataDirBusy', '正在迁移图库数据，请稍候'));
    return;
  }
  var info = state.dataDirInfo;
  if (!info) {
    await refreshDataDirInfo();
    info = state.dataDirInfo;
  }
  if (!info || !info.success) return;

  var picked;
  try {
    // 标题由渲染端给：文件夹选择框是**系统**对话框，主进程那边拿不到 i18n 表，
    // 不传过去的话英文界面会弹一个中文标题的框。
    picked = await api.selectDataDir({
      title: tUi('settings.storage.dataDirPickTitle', '选择图库数据的新位置'),
    });
  } catch (e) {
    void appAlert(
      tUiFmt(
        'settings.storage.dataDirPickFailFmt',
        { error: e && e.message ? e.message : String(e) },
        '打开文件夹选择窗口失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
    return;
  }
  if (!picked || !picked.success) return; // 用户取消
  if (!picked.valid) {
    // 主进程的校验结果只有中文原文 ⇒ 先按 code 取本地化文案，取不到才用它带回来的原文。
    var invalidKey =
      {
        EMPTY: 'settings.storage.dataDirErrEmpty',
        SAME: 'settings.storage.dataDirErrSame',
        INSIDE: 'settings.storage.dataDirErrInside',
        OCCUPIED: 'settings.storage.dataDirErrOccupied',
      }[picked.code] || '';
    void appAlert(
      (invalidKey ? tUi(invalidKey, '') : '') ||
        picked.error ||
        tUi('settings.storage.dataDirErrSame', '这就是当前的位置，请另选一个文件夹'),
    );
    return;
  }

  // 余量读不到时不能把它写成「未知」塞进「还剩 …」那句话里 —— 直接换一条不含这句的文案。
  var freeKnown = !!(picked.plan && picked.plan.freeBytes >= 0);
  var freeText = freeKnown ? fmtBytes(picked.plan.freeBytes) : '';
  if (picked.plan && picked.plan.shortageBytes > 0) {
    void appAlert(
      tUiFmt(
        'settings.storage.dataDirSpaceFmt',
        {
          need: fmtBytes(picked.plan.needBytes),
          free: freeText,
          shortage: fmtBytes(picked.plan.shortageBytes),
        },
        '目标磁盘空间不够：需要 ' +
          fmtBytes(picked.plan.needBytes) +
          '，现在只有 ' +
          freeText +
          '，还差 ' +
          fmtBytes(picked.plan.shortageBytes) +
          '。',
      ),
    );
    return;
  }

  // 主进程会在所选位置下新建一个以产品命名的文件夹（选中磁盘根目录时尤其重要：
  // 否则 19 GB 会摊在盘根）。这件事必须在确认框里说出来 —— 用户点中的目录与数据
  // 真正落地的目录不是同一个，不说明就是一次「怎么多了一层」的意外。
  // 文件夹名直接取最终路径的最后一段（和主进程同源，不另抄一份常量）。
  var subdirName = picked.subfolder
    ? String(picked.path || '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() || ''
    : '';
  var subdirNote =
    picked.subfolder && subdirName
      ? tUiFmt(
          'settings.storage.dataDirConfirmSubdirFmt',
          { name: subdirName, picked: picked.pickedPath || '' },
          '会在所选位置 ' +
            (picked.pickedPath || '') +
            ' 下新建文件夹 ' +
            subdirName +
            '，数据放进那里。\n\n',
        )
      : '';

  var ok = await appConfirm(
    subdirNote +
      tUiFmt(
        freeKnown ? 'settings.storage.dataDirConfirmFmt' : 'settings.storage.dataDirConfirmNoFreeFmt',
        {
          size: fmtBytes(info.totalBytes),
          from: info.dataDir,
          to: picked.path,
          free: freeText,
        },
        '将把图库数据（共 ' +
          fmtBytes(info.totalBytes) +
          '）从\n' +
          info.dataDir +
          '\n迁移到\n' +
          picked.path +
          '\n\n' +
          (freeKnown ? '目标磁盘还剩 ' + freeText + '。' : '') +
          '迁移期间请不要使用图库，完成后应用会自动重启。',
      ),
    tUi('settings.storage.dataDirConfirmTitle', '确认迁移图库数据'),
  );
  if (!ok) return;

  state.dataDirMigrating = true;
  setDataDirButtonsDisabled(true);
  setDataDirLine(tUi('settings.storage.dataDirPhasePrepare', '正在准备…'));
  var r;
  try {
    /**
     * 🔴 **被写库闸门挡住不是失败**：那只是「现在有别的任务占着库」，等它结束就行
     *    （启动后十几秒里几乎必然撞上一次 —— 启动期的失效记录清理、索引补齐都在这段）。
     *    所以这里按 `code === 'BUSY'` **自动重试**，而不是把用户打发回去从头再点一遍：
     *    他要重新选目录、再确认一次，而这几秒里被挡的原因可能早就没了。
     *
     *    判据用 code 不用文案 —— 文案改过一次就静默失效过（见 CHANGELOG 里那一条）。
     *    重试有上限（≈{BUSY_RETRY_MAX} × {BUSY_RETRY_INTERVAL_MS} ms）：扫描目录那种
     *    几小时的任务不该让界面无限转下去，超了就说实话「等它跑完再点一次」。
     */
    /**
     * 🔴 **暂停是发生在某一次尝试里的，界面却只看得到最后那次的返回值** —— 这个形状是
     *    真实 change 探针抓出来的（`.workbuddy/tmp/data-dir-paused-cleanup-probe.js`）：
     *    第一次返回 `code:'BUSY'` 并带着 `pausedTasks:[{label:'清理失效记录',scope:'startup'}]`
     *    （它已经把清理摘下来了，但在途那一批还握着写锁），**第二次就成功了、`pausedTasks` 是空的**
     *    ⇒ 「暂停」真的发生了、界面一个字都没说，用户下次启动看到清理「从零开始」也无处可对。
     *    所以每次都过一遍 `mergePausedTasks`（纯函数：合并 + 按 label+scope 去重）。
     */
    var pausedSeen = [];

    var waitedMs = 0;
    for (var attempt = 0; ; attempt++) {
      r = await api.migrateDataDir({ targetDir: picked.path, removeSource: true });
      pausedSeen = mergePausedTasks(pausedSeen, r);
      if (!r || r.code !== 'BUSY' || attempt >= BUSY_RETRY_MAX) break;
      waitedMs += BUSY_RETRY_INTERVAL_MS;
      setDataDirLine(
        tUiFmt(
          'settings.storage.dataDirBusyWaitFmt',
          { reason: r.error || '', seconds: Math.round(waitedMs / 1000) },
          (r.error || '') + '\n（迁移要等它结束，正在自动重试…已等 ' + Math.round(waitedMs / 1000) + ' 秒）',
        ),
      );
      await sleepMs(BUSY_RETRY_INTERVAL_MS);
    }
    if (!r || !r.success) {
      // 迁移还没动手就已经把「清理失效记录」让开了 ⇒ 这次拒绝也要把这件副作用说出来
      // 用**累积**的那份：暂停可能发生在更早的一次重试里（见上面 `mergePausedTasks` 的注释）
      var pausedNote = dataDirPausedNote(pausedSeen);
      // 等了上限还在忙：这时**什么都没动过**（关库、复制都还没开始），该说清怎么继续。
      if (r && r.code === 'BUSY') {
        setDataDirLine(
          tUiFmt(
            'settings.storage.dataDirBusyGiveUpFmt',
            { error: r.error || '' },
            '迁移还没能开始：' +
              (r.error || '') +
              '\n\n迁移要等这些后台任务结束才能动手。等它跑完后再点一次「迁移到…」就行 —— 图库数据没有变动。',
          ) + pausedNote,
        );
        return;
      }
      var errText = (r && r.error) || tUi('settings.common.unknownError', '未知错误');
      setDataDirLine(
        (r && r.restartRequired
          ? tUiFmt(
              'settings.storage.dataDirFailRestart',
              { error: errText },
              '迁移没有完成。\n\n' + errText + '\n\n应用即将重启，重启后继续使用原位置 —— 图库数据没有变动。',
            )
          : tUiFmt(
              'settings.storage.dataDirFailFmt',
              { error: errText },
              '迁移没有完成。\n\n' + errText + '\n\n图库数据没有变动，仍在原位置。',
            )) + pausedNote,
      );
      return;
    }
    var doneLine = tUiFmt(
      'settings.storage.dataDirDoneFmt',
      {
        size: fmtBytes(r.copiedBytes),
        count: r.photoCount != null ? r.photoCount : 0,
      },
      '迁移完成，正在重启应用…（已搬 ' + fmtBytes(r.copiedBytes) + '）',
    );
    // 清理结果必须说出来：18 GB 的主库进不了回收站是常态，「删了 / 没删成」不能靠猜。
    var trashed = (r.removed || []).join(tUi('common.listSep', '、'));
    var purged = (r.removedPermanently || []).join(tUi('common.listSep', '、'));
    var stuck = (r.removeFailed || []).map(function (f) {
      return f.name;
    });
    if (trashed) {
      doneLine +=
        '\n' +
        tUiFmt(
          'settings.storage.dataDirTrashedFmt',
          { names: trashed },
          '原位置的 ' + trashed + ' 已放入回收站，需要时可以从回收站恢复。',
        );
    }
    if (purged) {
      doneLine +=
        '\n' +
        tUiFmt(
          'settings.storage.dataDirPurgedFmt',
          { names: purged },
          '原位置的 ' + purged + ' 已直接删除 —— 文件太大放不进回收站。新位置的数据是完整的，但这些旧文件无法找回。',
        );
    }
    if (stuck.length) {
      doneLine +=
        '\n' +
        tUiFmt(
          'settings.storage.dataDirCleanupFailedFmt',
          { names: stuck.join(tUi('common.listSep', '、')) },
          '新位置已经可以正常使用，但原位置的 ' +
            stuck.join(tUi('common.listSep', '、')) +
            ' 没能删掉。它们只是白占空间，你可以自己删除。',
        );
    }
    // 最后说后台任务：它不影响数据，但用户下次启动会看到「清理从零开始」，得有处可对
    doneLine += dataDirPausedNote(pausedSeen);
    setDataDirLine(doneLine);
    // 成功后主进程 1.5 秒内重启 ⇒ 按钮保持禁用，避免用户点了别的又触发一轮写库。
    return;
  } catch (e) {
    var catchText = e && e.message ? e.message : String(e);
    setDataDirLine(
      tUiFmt(
        'settings.storage.dataDirFailFmt',
        { error: catchText },
        '迁移没有完成。\n\n' + catchText + '\n\n图库数据没有变动，仍在原位置。',
      ) + dataDirPausedNote(pausedSeen),
    );
  } finally {
    // 只有「不需要重启」的失败才把按钮放回来；要重启的情况界面马上就没了。
    if (!(r && r.restartRequired)) {
      state.dataDirMigrating = false;
      setDataDirButtonsDisabled(false);
    }
  }
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
              '，重复图片 ' +
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
  // 组织元数据筛选（评分 / 标记 / 标签）。
  // 🔴 在**这一处**并进 options 是刻意的：下面所有视图（总览 / 目录 / 日期 / 搜索 /
  //    标签导航 / 收藏）都从这里取 options，所以筛选是**全局一致**的。
  //    改成分头加 ⇒ 必然漏掉一两个视图，而症状是「某一页不筛」—— 不报错的那种。
  //    主进程侧凡认 mediaType 的查询都已经接上同一套判据，契约见
  //    `docs/contracts/org-metadata.md`「筛选作用域」。
  orgMetaUi.applyFilterToOptions(options, state);

  if (state.currentView === 'folder_overview') {
    return { photos: [], total: 0, page: 1, pageSize: state.pageSize, totalPages: 0 };
  }

  // 标签导航页的照片：只有**选中了具体标签**才走这一支。
  // 父节点（分类 / 子类）不给照片网格，主区改由 `tagNavUi.renderBrowseCards()` 画卡片
  // —— 原因见 `tag-nav-ui.js` 文件头（那是一个几十秒主线程阻塞的取舍）。
  //
  // ⚠️ `sortBy` / `sortOrder` 在这条路上**不生效**：顺序由索引侧定死为标签置信度降序
  //    （「最典型地属于这个标签」的图先出来），这是这个页面的语义本身。
  //    排序控件在这一页被置灰（见 loadPhotos），所以用户不会以为它坏了。
  if (state.currentView === 'tag') {
    if (!state.currentTag) {
      return { photos: [], total: 0, page: 1, pageSize: state.pageSize, totalPages: 0 };
    }
    return await api.getTagNavPhotos(state.currentTag, options);
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

/** 从扁平 folder_path 列表聚合「直接子文件夹」及下属图片数（与侧栏树一致的数据源） */
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
    if (dom.pagination) dom.pagination.style.display = 'none';
    if (aiViews) await aiViews.load();
    return;
  }
  // 标签导航页的「浏览态」（还没选中具体标签）：主区不是照片网格，而是标签卡片。
  // 与 `folder_overview` 同构的一支早退 —— 它自己决定 #photoGrid 里的内容。
  // 放在 `loadPhotos` 里而不是各调用点，是为了让**所有**刷新路径（媒体过滤档、
  // 库变更失效、语言切换、从设置页回来）都自动重画卡片，不用逐个去补。
  if (state.currentView === 'tag' && !state.currentTag) {
    if (dom.toolbar) dom.toolbar.style.display = 'none';
    if (dom.pagination) dom.pagination.style.display = 'none';
    // 🔴 这一支**不能只画卡片就 return**，另外三件事与 `folder_overview` 那支逐条对齐 ——
    //    它们的缺失都不会报错，只在别处显形：
    //    · `state.currentPhotos` 不清空 ⇒ 它还是**上一页**（上一个文件夹 / 上一次搜图）那一批。
    //      `startPreview()` 只读这个数组，于是在标签卡片上按空格 / 方向键会打开一批
    //      与当前屏幕毫不相干的照片 —— 这是「预览了别的目录的图」这类报障的来源。
    //    · `previewFlow.initPreviewState()` 不重置 ⇒ `previewTotalPhotos` 同样是旧值。
    //    · `updateBrowsePathLabel()` 不调 ⇒ 路径栏停在上一页的文字（实测停在「所有文件」），
    //      而 `case 'tag'` 分支明明写好了。
    state.currentPhotos = [];
    updateBrowsePathLabel();
    previewFlow.initPreviewState({ state: state, result: { total: 0, totalPages: 0 } });
    if (tagNavUi) tagNavUi.renderBrowseCards();
    return;
  }
  if (dom.toolbar) dom.toolbar.style.display = 'flex';
  // 标签页的排序固定为「标签相关度」（顺序由索引侧给），控件置灰避免「改了没反应」；
  // `folder_overview` 同理（它是封面网格，没有可排序的列）。
  if (dom.sortSelect)
    dom.sortSelect.disabled = state.currentView === 'folder_overview' || state.currentView === 'tag';

  if (state.currentView === 'folder_overview') {
    photoGridUi.showSkeleton({
      dom: dom,
      loadingLabel: tUi('sidebar.loadingCovers', '正在加载各目录封面…'),
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
          '<div class="title">' +
          escapeHtml(tUi('sidebar.loadCoversFail', '目录封面加载失败')) +
          '</div>' +
          '<div class="desc">' +
          escapeHtml(tUi('sidebar.retryLater', '请稍后重试')) +
          '</div></div>';
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
      // 不传 loadingLabel ⇒ 由 ui-grid 按当前媒体档位取「正在加载图片与视频…/图片…/视频…」
      mediaFilter: normalizeMediaFilter(state.mediaFilter),
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
        '<div class="title">' +
        escapeHtml(tUi('sidebar.loadPhotosFail', '图片加载失败')) +
        '</div>' +
        '<div class="desc">' +
        escapeHtml(tUi('sidebar.retryOrSwitchView', '请稍后重试或切换左侧视图')) +
        '</div></div>';
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
/**
 * 底栏「尺寸」改档（下拉）。
 *
 * 与「每页数量」「网格与比例」同构：走 `updateSettings` 把这一档写进设置，再用返回的
 * 设置整体重放一遍 —— 底栏下拉、设置页 `#settingBrowseCardSize`、`state` 三处必须同一个值。
 * 写库失败回滚，否则界面会显示一个并没生效的档位。
 *
 * 与另两个的不同：换卡片尺寸不改变结果集，所以**不重查库**，只改 CSS 变量当场重排。
 * （这以前是靠 −/+ 药丸走的，只改 `state` 不落库；改成与设置页等价的下拉后必须落库，
 *   否则「设置页那份会存、底栏这份不会存」——同一状态的两个入口语义不同，正是本文件
 *   一直在挡的那类静默不一致。）
 */
async function changeBrowseCardSize(rawValue) {
  var size = snapBrowseCardBasis(rawValue);
  var previous = snapBrowseCardBasis(state.cardSize);
  if (size === previous) {
    syncCardSizeControl();
    return;
  }
  state.cardSize = size;
  syncCardSizeControl();
  try {
    var applied = await api.updateSettings({ browseCardSize: size });
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
    syncCardSizeControl();
  } catch (e) {
    state.cardSize = previous;
    syncCardSizeControl();
    appAlert(
      tUiFmt(
        'settings.cardSizeFailFmt',
        { err: e && e.message ? e.message : String(e) },
        '切换缩略图尺寸失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
  }
}

/* 🔴 这里曾有一个 `capMasonryColumns()`：瀑布流档下若「卡片数 < 可容纳列数」，
   就把 `grid.style.columnCount` 压成**卡片数**，让这几张图摊满整行。
   2026-10-09 用户要求取消：「当某个文件夹或标签少于一排照片时，不要将图片占据所有宽度，
   保持和多图时一样宽度」。实测（桌面 1440 窗、瀑布流档、basis 180 / gap 12）：
   2 张 = 513px、3 张 = 338px、6 张 = 198px、14 张 = 195px —— 少图时卡片宽了近 2.6 倍，
   与「多图时」完全不是一个观感。列宽本来就该由**容器宽度**决定、与张数无关。
   现在列数/列宽全部交给 CSS（`.grid--masonry` 的 `columns: <basis>px`，
   手机档另有 `columns: 2` 兜底，见 `web/index.html`），本文件不再写 `columnCount`。

   ⚠️ 顺带解决：原实现用 `ResizeObserver` 观察 `.grid--masonry`，回调里又改
   `grid.style.columnCount` ⇒ **自反馈环**，console 反复刷
   `ResizeObserver loop completed with undelivered notifications`
   （`CONTRACTS.md`「本轮未修」那条记的就是它）。写者没了，观察者也就没有存在理由，
   一并不再创建 —— 所以**不要为了别的目的把 RO 加回来观察这个 grid**。 */

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
  }
  // 底栏「尺寸」与「网格与比例」的读数与卡片尺寸同源（都从 state 取），所以挂在这里一起刷新：
  // 设置页保存、启动应用设置、底栏改档三条路最终都会经过 applyCardSize。
  // （此前这里还要把档位字母写进右下角那枚药丸读数；换成下拉后读数就是 select 自己。）
  syncCardSizeControl();
  syncBrowseGridStyleControl();
}

/** 底栏「尺寸」下拉的读数：始终显示**当前生效**的档位（写库失败回滚后必须跟着回滚）。 */
function syncCardSizeControl() {
  if (!dom.browseCardSizeSelect) return;
  // 先收档再写：表外值（历史设置 / 手改 settings.json）在 `<select>` 里匹配不到任何 option，
  // 直接赋 value 会让下拉显示成**空白**，看着像坏了。
  state.cardSize = snapBrowseCardBasis(state.cardSize);
  var want = String(state.cardSize);
  if (dom.browseCardSizeSelect.value !== want) dom.browseCardSizeSelect.value = want;
}

/** 底栏「每页」下拉的读数：始终显示**当前生效**的档位（写库失败回滚后必须跟着回滚）。 */
function syncPageSizeControl() {
  state.pageSize = snapBrowsePageSize(state.pageSize);
  if (!dom.browsePageSizeSelect) return;
  var want = String(state.pageSize);
  if (dom.browsePageSizeSelect.value !== want) dom.browsePageSizeSelect.value = want;
}

/**
 * 底栏「每页」改档（下拉）。
 *
 * 与卡片尺寸不同：每页张数要重新查库，所以这里走设置持久化那条路
 * （`updateSettings` → 用返回的设置整体重放一遍），保证底栏下拉、设置页 `#settingBrowsePageSize`、
 * `state.browsePrefsApplied` 三处不会各说各话。写库失败则退回原档位——否则界面会显示一个
 * 并没生效的张数。
 */
async function changeBrowsePageSize(rawValue) {
  var size = snapBrowsePageSize(rawValue);
  var previous = snapBrowsePageSize(state.pageSize);
  if (size === previous) {
    // 选中项与生效值一致（例如从别的档位选回当前档）：把下拉拨回生效值。
    syncPageSizeControl();
    return;
  }
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
    appAlert(
      tUiFmt(
        'settings.pageSizeFailFmt',
        { err: e && e.message ? e.message : String(e) },
        '切换每页显示张数失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
  }
}

/**
 * 底栏「网格与比例」读数：始终显示**当前生效**的组合（`state` 是唯一真相源，
 * 与设置页 `#settingBrowseGridStyle` 那份同源），而不是刚点的那一下——
 * 写库失败回滚后，界面必须跟着回滚，否则它在说谎。
 */
function syncBrowseGridStyleControl() {
  if (!dom.browseGridStyleSelect) return;
  var want = encodeBrowseGridStyleValue(state.cardLayoutMode, state.cardRatio);
  if (dom.browseGridStyleSelect.value !== want) dom.browseGridStyleSelect.value = want;
}

/**
 * 布局模式切换后按当前页结果重画网格（不重查库）。
 *
 * `uniform ↔ masonry` 决定卡片用「统一比例」还是「图片自己的比例」，这个开关是
 * **渲染时**写进 DOM 的（grid 元素的 `data-use-media-ratio` 与 `grid--masonry`），
 * 不是一条改 CSS 变量就能翻转的规则 —— 所以只靠 `applyCardSize()` 不够。
 * 复用「缓存秒开」那条路径的当前页结果重画即可。
 */
function repaintBrowseGridAfterLayoutChange() {
  // 只在浏览视图重画：搜图 / 人物视图用的是另一批图片，拿浏览页的缓存去重画会把它们覆盖掉。
  // （那两页也因此不放出这个控件，见 ai-views.js 的 applyToolbar。）
  if (state.currentTab !== 'folders' && state.currentTab !== 'dates') return;
  // 重复页同理：它复用了同名的 dom.photoGrid，但 `_photoBrowseCacheResult` 还是浏览页那一批。
  if (state.currentView === 'duplicates') return;
  if (!state._photoBrowseCacheResult) return;
  paintBrowsePhotoGridShell(state._photoBrowseCacheResult, {});
}

/**
 * 底栏「网格与比例」改档。
 *
 * 与卡片尺寸档位（`changeBrowseCardSize`）的两处不同：这里必须写库 ——
 * 设置页有一份等价的 `#settingBrowseGridStyle`，两处若各持一份状态，
 * 下次进设置页 hydrate 就会把旧值填回表单、再保存时覆盖掉底栏的选择。
 * 所以与「每页张数」同构：`updateSettings` → 用返回的设置整体重放 → 失败回滚读数。
 *
 * 另一处不同：换网格布局不改变结果集，所以**不重查库**，只重画当前这一页。
 */
async function changeBrowseGridStyle(rawValue) {
  var parsed = parseBrowseGridStyleValue(rawValue);
  var layout = parsed.layout;
  // 瀑布流不带比例：切到瀑布流时**保留**原比例值，切回「统一高度」还要用它。
  var ratio = layout === 'uniform' && parsed.ratio ? parsed.ratio : state.cardRatio;
  if (layout === state.cardLayoutMode && ratio === state.cardRatio) return;
  var prevLayout = state.cardLayoutMode;
  var prevRatio = state.cardRatio;
  state.cardLayoutMode = layout;
  state.cardRatio = ratio;
  syncBrowseGridStyleControl();
  try {
    var applied = await api.updateSettings({ browseCardLayout: layout, browseCardRatio: ratio });
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
    syncBrowseGridStyleControl();
    repaintBrowseGridAfterLayoutChange();
  } catch (e) {
    state.cardLayoutMode = prevLayout;
    state.cardRatio = prevRatio;
    syncBrowseGridStyleControl();
    appAlert(
      tUiFmt(
        'settings.gridStyleFailFmt',
        { err: e && e.message ? e.message : String(e) },
        '切换网格与比例失败：' + (e && e.message ? e.message : String(e)),
      ),
    );
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

// 从网格点击进入预览，初始化图片列表
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
  // 裁剪是模态的：任何「换图」路径（方向键 / 幻灯片 / 翻页按钮 / 裁剪后重开）都要先把
  // 选区收掉，否则选框会留在屏上、却已经对应了另一张图（坐标全错且不报错）。
  if (previewCrop.isActive && previewCrop.isActive()) previewCrop.exit();
  // 换图 = 待保存的编辑作废。这里是**唯一**的清空点：所有切图路径都汇到本函数，
  // 散在各个调用点清必然漏一处，而漏掉的表现是「新图上还叠着上一张的旋转」。
  // ⚠️ 用户主动切图/关预览时的**确认**在 `guardPendingPreviewEdit()`（ui-events 那几处），
  //    不在这里 —— `openPreview` 也被保存流程调用，在那里弹框会卡住自己。
  resetPreviewPendingEdit();
  var opened = previewFlow.openPreview({
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
    onSyncPreviewLiveButton: function (photo, isVideo) {
      void photo;
      return previewLiveUi.syncPreviewLiveUi({
        state: state,
        dom: dom,
        isVideo: isVideo,
      });
    },
    onSyncPreviewEditButtons: syncPreviewEditButtons,
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
  /**
   * 🔴 切图必须重画开着的「图片信息」面板 —— 这里是**唯一**的切图出口。
   *
   * 面板内容原先只在「打开面板 / 改字段 / 切语言 / 主题标签补写完成」四处刷新，切图不在其中，
   * 于是切到下一张后标题换了、面板还是上一张的读数。鼠标点两侧箭头看不出这个问题，只是因为
   * 那一下会命中 `_closePreviewInfoPanelOnOutside` 把面板顺手关掉；键盘 ←/→ 与幻灯片切图
   * 面板一直开着 ⇒ 必现。
   *
   * 网页端 (`src/web/js/app.js` 的切图函数) 一直有这一步，桌面端漏了 —— 两端同口径。
   * 传 `state.previewPhotos[index]` 而不是让它自己读 `state.previewIndex`：
   * 不依赖 `previewFlow.openPreview()` 内部赋值的时序。
   */
  refreshOpenPreviewInfoPanel(state.previewPhotos[index]);
  // 组织元数据（标记 / 评分 / 标签）同一条理由：**这里**是唯一的切图出口。
  // 工具条上的星标与标记按钮必须跟着当前这张走，标签面板同理。
  syncPreviewOrgMeta();
  return opened;
}

function closePreview() {
  // 裁剪选区挂在 body 上，不随预览层一起消失 —— 关预览前必须显式收掉，
  // 否则会留下一个没有图片垫底的选框在屏上。
  if (previewCrop.isActive && previewCrop.isActive()) previewCrop.exit();
  // 关预览 = 待保存的编辑作废（用户主动关的那条路径已经由
  // `guardPendingPreviewEdit()` 问过了；这里是兜底，防止别的调用点漏清）。
  resetPreviewPendingEdit();
  state.previewRandomPositionNum = 0;
  previewSlideshow.stopSlideshow({
    state: state,
    dom: dom,
  });
  exitPreviewFullscreen();
  closePreviewInfoPanel();
  var overlay = dom.previewOverlay;
  overlay.classList.add('closing');
  setTimeout(function () {
    overlay.classList.remove('active', 'closing', 'minimized', 'ui-collapsed');
    // 全屏浮层控件的两个类必须一起清掉：只留 is-fullscreen 会让下一次打开预览时
    // 浮层控件在不该收起的窗口化模式下也保持 opacity:0（见 styles.css「全屏浮层控件显隐」）。
    overlay.classList.remove('is-fullscreen', 'fs-ui-visible');
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
    // Live Photo 的叠加层必须和主播放器一起收干净，否则关掉预览后那段动态还在后台播。
    // 走模块自己的 `stopLivePlayback`（它负责解除 HLS 会话 + 断源 + 复位按钮），
    // 不在这里另抄一遍拆解步骤 —— 两处会漂移。
    if (typeof previewLiveUi.stopLivePlayback === 'function') {
      previewLiveUi.stopLivePlayback({ state: state, dom: dom });
    }
    if (dom.previewSubtitleTrackSelect) dom.previewSubtitleTrackSelect.style.display = 'none';
    var subtitleStylePanel = document.getElementById('previewSubtitleSettingsPanel');
    if (subtitleStylePanel) subtitleStylePanel.style.display = 'none';
    // 「整理」抽屉同理：关预览时收起，否则下次打开会浮在没有图片垫底的屏上。
    // 抽屉那份状态（开 / 关）刻意**不持久化**：每次进预览都是从「关闭」开始。
    closePreviewOrgPanel();
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
    appAlert(
      tUiFmt(
        'settings.openFolderFailFmt',
        { err: (r && r.error) || tUi('task.unknownError', '未知错误') },
        '无法打开目录：' + ((r && r.error) || '未知错误'),
      ),
    );
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

/**
 * 预览里的「实况」按钮：播 / 停当前图片的伴生视频。
 * 判据与显隐都在 `RendererPreviewLive` 里（`photo.live_motion_id`），这里只做转发。
 */
function previewToggleLive() {
  return previewLiveUi.toggleLivePlayback({
    state: state,
    dom: dom,
    api: api,
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

// ─────────────────────────────────────────────────────────────────────────────
// 组织元数据（标记 / 评分 / 用户标签）—— 2026-10-09
//
// 这里只做「串起来」：真正的归一、内存同步、角标重画、面板重画都在
// `org-meta-ui.js` 里。本文件负责三件事：
//   ① 把请求参数拼好（筛选）/ 把回调接上（工具条与快捷键）；
//   ② 写完之后决定「要不要重新拉列表」（判据在 `orgMetaUi.filterMightChangeFor`）；
//   ③ 把「标签候选列表」拉下来喂给筛选面板。
//
// 🔴 为什么不在这里也写一套归一 / 状态同步：这三个维度在**预览工具条**与
//    **网格角标**两处都要显示，而两处的数据来源不同（前者读 `previewPhotos`、
//    后者读 DOM 上的 data 属性）。各写一份必然漂移，症状是「点了星，工具条变了、角标没变」。
// ─────────────────────────────────────────────────────────────────────────────

/** 三个写入口共用的回调包（省得每处都拼一遍，也保证三处的行为一致）。 */
function orgMetaWriteOptions() {
  return {
    state: state,
    dom: dom,
    api: api,
    appAlert: appAlert,
    onLoadPhotos: loadPhotos,
    onSyncTagsPanel: syncPreviewTagsPanel,
    onTagsChanged: refreshTagList,
  };
}

/** 预览里的标记（`'pick'` / `'reject'` / `'none'`）。**幂等设值**，不是切换。 */
async function previewSetFlag(flag) {
  await orgMetaUi.setFlag(Object.assign(orgMetaWriteOptions(), { flag: flag }));
}

/** 预览里的评分：点第 N 颗星；点当前已经是的那一颗 = 取消（判据在 nextRating）。 */
async function previewSetRating(rating) {
  await orgMetaUi.setRating(Object.assign(orgMetaWriteOptions(), { rating: rating }));
}

/** 抽出「当前标签集合 + 新加一个」，交给 `setTags`（全量替换语义）。 */
async function previewAddTag(name) {
  var current = (state.previewTags || []).map(function (t) {
    return t && t.name ? t.name : '';
  });
  current.push(name);
  await orgMetaUi.setTags(Object.assign(orgMetaWriteOptions(), { names: current }));
}

/** 移除一个标签。按**名字**移除，不按下标 —— 连点两下按下标会删掉错的另一个。 */
async function previewRemoveTag(name) {
  var target = orgMetaUi.normalizeTagDisplayName ? orgMetaUi.normalizeTagDisplayName(name) : name;
  var current = (state.previewTags || [])
    .map(function (t) {
      return t && t.name ? t.name : '';
    })
    .filter(function (n) {
      return orgMetaUi.normalizeTagDisplayName(n) !== target;
    });
  await orgMetaUi.setTags(Object.assign(orgMetaWriteOptions(), { names: current }));
}

/** 把 `state.previewTags` 画成 chip 列表。由切图 / 读回包 / 写回包三处调。 */
function syncPreviewTagsPanel() {
  if (dom.previewOrgTagsChips) {
    var names = (state.previewTags || []).map(function (t) {
      return t && t.name ? t.name : '';
    });
    dom.previewOrgTagsChips.innerHTML = orgMetaUi.tagsChipsHtml(names);
  }
  orgMetaUi.syncPreviewControls({ state: state, dom: dom });
}

/** 输入框内容提交（回车 / 点「添加」共用一个入口）。 */
async function previewSubmitTagInput() {
  var input = dom.previewOrgTagsInput;
  if (!input) return;
  var raw = input.value;
  if (!raw || !raw.trim()) return;
  // 先清空再发请求：写失败时输入框已经空了，用户能看出「没加上」；
  // 留着不清反而会让失败看起来像成功（同一段文字还在框里）。
  input.value = '';
  await previewAddTag(raw);
}

/**
 * 收起「整理」抽屉。与 `closePreviewInfoPanel` 对称的**唯一收起点**：
 * 抽屉自己的关闭按钮、以及 `closePreview`（关预览）都走这里。
 */
function closePreviewOrgPanel() {
  var panel = dom.previewOrgPanel;
  if (panel && panel.classList.contains('open')) {
    panel.classList.remove('open');
    _syncPreviewRightDrawerClass();
  }
}

/**
 * 「整理」抽屉（收藏 / 标记 / 评分 / 标签 / 对比）的开关。
 *
 * 🔴 它与 `#previewInfoPanel`（图片信息）**互斥**：两者都是贴右侧的 360px 滑出抽屉，
 *    同时打开就是叠在一起，用户会以为其中一个坏了。
 * 🔴 刻意**没有**「点外部收起」和「Esc 收起」（`#previewInfoPanel` 有的是）：
 *    这是「工作台」不是「提示」。冲片时用户会在大图与抽屉之间来回点
 *    （选 / 否 / 星），点一下图就把抽屉收起来是最烦的失败模式。
 *    同理它**不随切图关闭**（见 `syncPreviewOrgMeta`）。
 * 🔴 打开时**不抢输入框焦点**：用户点「整理」多半是想标个记或打个星，
 *    把焦点抢到标签输入框里会让他一按空格/字母就往框里灌字。
 *    （旧的小悬浮面板会 `focus()`，那是因为它**只**服务标签输入 —— 现在不是了。）
 */
function togglePreviewOrgPanel(force) {
  var panel = dom.previewOrgPanel;
  if (!panel) return;
  var open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
  if (open === panel.classList.contains('open')) return;
  panel.classList.toggle('open', open);
  _syncPreviewRightDrawerClass();
  if (open) {
    closePreviewInfoPanel();
    // 重画一次 chip：抽屉可能在「别处删过标签」之后才被打开，chips 得跟上。
    syncPreviewTagsPanel();
  }
}

/**
 * 拉一次标签候选列表（筛选面板用）。**按需拉**，不在启动期拉：
 * 用户可能整场都不打标签，而这是一条要过 `tags` + `photo_tags` 的聚合查询
 * （`LEFT JOIN` + `COUNT`，见 `database.js#listTags`）。
 */
async function refreshTagList() {
  if (!(api && api.has && api.has('listTags'))) return;
  try {
    var r = await api.listTags();
    state.tagList = r && r.success && Array.isArray(r.tags) ? r.tags : [];
  } catch (e) {
    state.tagList = [];
  }
  // 已经选中、但现在已经不存在的标签要从筛选里摘掉：否则筛选会一直生效却
  // 在面板里**看不见它**（因为列表里没有这一行），用户找不到关掉它的入口。
  var f = orgMetaUi.ensureFilter(state);
  if (f.tagIds.length) {
    var alive = state.tagList.map(function (t) {
      return Number(t.id);
    });
    f.tagIds = f.tagIds.filter(function (id) {
      return alive.indexOf(Number(id)) >= 0;
    });
  }
  renderOrgFilterTagsPanel();
  syncOrgFilterControls();
}

/** 标签筛选面板内容（复选行 + 使用计数）。 */
function renderOrgFilterTagsPanel() {
  if (!dom.orgFilterTagsList) return;
  var f = orgMetaUi.ensureFilter(state);
  var list = Array.isArray(state.tagList) ? state.tagList : [];
  if (!list.length) {
    dom.orgFilterTagsList.innerHTML =
      '<div class="org-filter-tags-empty">' +
      tUi('org.filterTagsEmpty', '还没有任何标签') +
      '</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    var id = Number(t.id);
    var checked = f.tagIds.indexOf(id) >= 0 ? ' checked' : '';
    html +=
      '<label class="org-filter-tag-row">' +
      '<input type="checkbox" data-tag-filter-id="' +
      id +
      '"' +
      checked +
      ' />' +
      '<span class="org-filter-tag-name">' +
      RendererUtils.escapeHtml(String(t.name == null ? '' : t.name)) +
      '</span>' +
      '<span class="org-filter-tag-count">' +
      // 🔴 括号必须包住整个 `||` 表达式：`+` 优先级高于 `||`，不写括号会变成
      //    `('<span>' + N) || ('</span>' + …)` —— 左边恒为真值，闭标签永远拼不进
      //    HTML，计数 span 嵌进名称 span（视觉验证抓出来的，回归断言也补了这条）。
      (Number(t.photo_count) || 0) +
      '</span>' +
      '</label>';
  }
  dom.orgFilterTagsList.innerHTML = html;
}

/**
 * 把筛选态画回工具栏控件。
 *
 * 🔴 「清除筛选」按钮的显隐必须由**筛选态**算，不能由「用户点过什么」算：
 *    标签筛选可能因为标签被删而自动失效（见 `refreshTagList`），
 *    那时按钮若还亮着，用户会以为筛选没生效。
 */
function syncOrgFilterControls() {
  var f = orgMetaUi.ensureFilter(state);
  if (dom.orgFilterRatingSelect) {
    dom.orgFilterRatingSelect.value = f.rating == null ? '' : String(f.rating);
  }
  if (dom.orgFilterFlagSelect) {
    dom.orgFilterFlagSelect.value = f.flag == null ? '' : String(f.flag);
  }
  var btn = dom.orgFilterTagsBtn;
  if (btn) {
    var count = f.tagIds.length;
    var badge = btn.querySelector('.org-filter-tags-count');
    if (badge) badge.textContent = count ? String(count) : '';
    btn.classList.toggle('has-selection', count > 0);
  }
  if (dom.orgFilterClearBtn) {
    dom.orgFilterClearBtn.style.display = orgMetaUi.hasActiveFilter(state) ? '' : 'none';
  }
}

/**
 * 改筛选并重新拉列表。
 *
 * ⚠️ 一律回第 1 页：筛选一变，原来那个页码大概率已经越界（比如从「全部」切到
 *    「仅 2 张」，第 7 页是空的），而空网格看起来像「筛选把东西筛没了」。
 *    重置 `page = 1` 是本项目其它筛选（媒体档 / 每页数量）的既有约定。
 */
async function applyOrgFilter(patch) {
  var f = orgMetaUi.ensureFilter(state);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'rating')) f.rating = patch.rating;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'flag')) f.flag = patch.flag;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'tagIds')) f.tagIds = patch.tagIds.slice();
  state.page = 1;
  syncOrgFilterControls();
  renderOrgFilterTagsPanel();
  await loadPhotos();
}

async function clearOrgFilter() {
  state.orgFilter = orgMetaUi.emptyFilter();
  state.page = 1;
  syncOrgFilterControls();
  renderOrgFilterTagsPanel();
  await loadPhotos();
}

/**
 * 切图时重画预览里的组织元数据（「整理」抽屉里的标记 / 星标 / 标签），
 * 并**异步**拉这张图的标签。
 *
 * 由 `openPreview` 在每次切图时调 —— 与 `refreshOpenPreviewInfoPanel` 同一位置、
 * 同一理由（见那边的注释：只写在「打开预览」那条路上会覆盖不到「左右切换」）。
 */
function syncPreviewOrgMeta() {
  orgMetaUi.syncPreviewControls({ state: state, dom: dom });
  // 先把面板清空再拉：留着上一张的 chip 会让人以为「换图了标签还在」。
  // 清空是即刻的，读回包随后填上（`loadTagsForPreview` 带 photoId 校验）。
  state.previewTags = [];
  state.previewTagsPhotoId = 0;
  if (dom.previewOrgTagsChips) {
    dom.previewOrgTagsChips.innerHTML = orgMetaUi.tagsChipsHtml([]);
  }
  // 🔴 **刻意不关「整理」抽屉**。它是「工作台」：翻着图一路标下去是主用法，
  //    每切一张就把抽屉收掉等于逼用户按 N 次。
  //    也不要「顺手把抽屉重开一次」—— 那会让「用户自己收起后翻页」又弹回来。
  //    抽屉的开合只由 `#previewOrgBtn` / `#previewOrgPanelClose` / `closePreview` 三处决定。
  orgMetaUi.loadTagsForPreview({
    state: state,
    dom: dom,
    api: api,
    onSyncTagsPanel: syncPreviewTagsPanel,
  });
}

/**
 * 绑定组织元数据那一组控件的鼠标入口。
 *
 * 🔴 **刻意不走 `ui-events.js`**（而键盘走它）：这一组里五颗星是同一个动作的五个参数
 *    （`data-rating`），而 `ui-events` 的 `bindClick` 是「一个 id 一个处理器」的形态 ——
 *    硬塞进去要么写五个近乎相同的绑定、要么在那边引入一个只服务这一处的委托。
 *    判据相反：**键盘必须在 `ui-events`（有守护钉着不许出现 `e.key` 字面量），
 *    鼠标可以留在本文件**（附近的 `hlsCacheSettingsApplyBtn` 也是就地绑的）。
 */
function bindOrgMetaControls() {
  var d = dom;

  // ── 预览：标记三连 ──
  if (d.previewFlagPickBtn) {
    d.previewFlagPickBtn.addEventListener('click', function () {
      void previewSetFlag('pick');
    });
  }
  if (d.previewFlagRejectBtn) {
    d.previewFlagRejectBtn.addEventListener('click', function () {
      void previewSetFlag('reject');
    });
  }
  if (d.previewFlagClearBtn) {
    d.previewFlagClearBtn.addEventListener('click', function () {
      void previewSetFlag('none');
    });
  }

  // ── 预览：五颗星（事件委托，星星数量由 DOM 决定）──
  if (d.previewRatingStars) {
    d.previewRatingStars.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.preview-rating-star') : null;
      if (!btn) return;
      var v = Number(btn.getAttribute('data-rating'));
      if (!v) return;
      void previewSetRating(v);
    });
  }

  // ── 预览：「整理」抽屉入口 + 关闭 ──
  // `stopPropagation` 必须留：本文件的文档级 click 监听（见下面「点别处收起」那段）
  // 只管筛选浮层，但预览浮层上还有别的“点空白收界面”的全局监听 —— 不拦一下，
  // 「打开抽屉」这一下点击会顺带被它们当成「点了空白」。
  if (d.previewOrgBtn) {
    d.previewOrgBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      togglePreviewOrgPanel();
    });
  }
  if (d.previewOrgPanelClose) {
    d.previewOrgPanelClose.addEventListener('click', function (ev) {
      ev.stopPropagation();
      togglePreviewOrgPanel(false);
    });
  }
  if (d.previewOrgTagsAddBtn) {
    d.previewOrgTagsAddBtn.addEventListener('click', function () {
      void previewSubmitTagInput();
    });
  }
  if (d.previewOrgTagsInput) {
    d.previewOrgTagsInput.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      // 回车要吃掉：不吃的话会冒泡到预览的全局快捷键分发 ——
      // 那条路只认注册表里的动作，今天没有动作绑在 Enter 上，
      // 但哪天有人给 Enter 绑了动作（比如「确认裁剪」），打标签就会顺手触发它。
      ev.preventDefault();
      ev.stopPropagation();
      void previewSubmitTagInput();
    });
  }
  if (d.previewOrgTagsChips) {
    d.previewOrgTagsChips.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.preview-org-tag-remove') : null;
      if (!btn) return;
      ev.preventDefault();
      void previewRemoveTag(btn.getAttribute('data-tag-name'));
    });
  }

  // ── 工具条：筛选 ──
  if (d.orgFilterRatingSelect) {
    d.orgFilterRatingSelect.addEventListener('change', function () {
      var v = d.orgFilterRatingSelect.value;
      // 空串 = 「不限」⇒ null。**不是 0**：0 是「未评分」这个具体的筛选值，
      // 混起来会让「全部评分」档变成「只看未评分」。
      void applyOrgFilter({ rating: v === '' ? null : Number(v) });
    });
  }
  if (d.orgFilterFlagSelect) {
    d.orgFilterFlagSelect.addEventListener('change', function () {
      var v = d.orgFilterFlagSelect.value;
      void applyOrgFilter({ flag: v === '' ? null : v });
    });
  }
  if (d.orgFilterTagsBtn) {
    d.orgFilterTagsBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var panel = d.orgFilterTagsPanel;
      if (!panel) return;
      var open = panel.style.display === 'none';
      panel.style.display = open ? '' : 'none';
      if (open) void refreshTagList();
    });
  }
  if (d.orgFilterTagsClose) {
    d.orgFilterTagsClose.addEventListener('click', function () {
      if (d.orgFilterTagsPanel) d.orgFilterTagsPanel.style.display = 'none';
    });
  }
  if (d.orgFilterTagsList) {
    d.orgFilterTagsList.addEventListener('change', function (ev) {
      var box = ev.target;
      if (!box || !box.getAttribute) return;
      var raw = box.getAttribute('data-tag-filter-id');
      if (raw == null) return;
      var id = Number(raw);
      if (!id) return;
      var f = orgMetaUi.ensureFilter(state);
      var next = f.tagIds.slice();
      var idx = next.indexOf(id);
      if (box.checked && idx < 0) next.push(id);
      else if (!box.checked && idx >= 0) next.splice(idx, 1);
      else return;
      // 多选**逐次提交**（每勾一下立刻重拉）：标签候选是几十条，
      // 等用户勾完再点「确定」会多一次往返，也多一个「忘了点确定」的失败模式。
      void applyOrgFilter({ tagIds: next });
    });
  }
  if (d.orgFilterClearBtn) {
    d.orgFilterClearBtn.addEventListener('click', function () {
      void clearOrgFilter();
    });
  }

  // 点别处收起**筛选**浮层。用 `click`（不是 `mousedown`）：`mousedown` 会在
  // 复选框自身的 `change` 之前触发，收起面板就等于勾不上任何一项。
  // 🔴 「整理」抽屉**刻意不在这里**：它是工作台（见 `togglePreviewOrgPanel` 的注释），
  //    点大图、点上一张/下一张都不该把它收起来。
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var filterPanel = d.orgFilterTagsPanel;
    if (
      filterPanel &&
      filterPanel.style.display !== 'none' &&
      !t.closest('#orgFilterTagsPanel') &&
      !t.closest('#orgFilterTagsBtn')
    ) {
      filterPanel.style.display = 'none';
    }
  });
}

async function previewFindSimilar() {
  var photo = state.previewPhotos[state.previewIndex];
  if (!photo || !photo.id) {
    appAlert(tUi('preview.similarNoPhotoInfo', '无法获取当前图片信息'));
    return;
  }
  if (!(api && api.has && api.has('maintenanceFindSimilarPhotos'))) {
    appAlert(tUi('preview.similarUnavailable', '查找相似图片功能暂不可用'));
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
      appAlert(tUi('preview.similarNoneFound', '未找到与此图片视觉相似的图片'));
      return;
    }
    var rows = [];
    if (api && api.has && api.has('maintenanceGetPhotosByIds')) {
      rows = await api.maintenanceGetPhotosByIds(similarIds);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      appAlert(tUi('preview.similarNoDetails', '未找到相似图片的详细信息'));
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
    var msg = tUiFmt(
      'preview.similarFoundFmt',
      { n: rows.length, name: photo.file_name || '' },
      '⭐ 查找相似图片 · 找到 ' +
        rows.length +
        ' 张与「' +
        (photo.file_name || '') +
        '」相似的图片',
    );
    // 这条消息会**整体覆盖**面包屑（写 textContent 会清掉里面的分段按钮），
    // 要等下一次 updateBrowsePathLabel 才恢复 —— 与改动前行为一致，刻意保留。
    if (pathCrumbs) pathCrumbs.close();
    if (dom.currentPath) dom.currentPath.textContent = msg;
  } catch (e) {
    Logger.error('[previewFindSimilar]', e);
    appAlert(
      tUiFmt(
        'preview.similarFailFmt',
        { err: e && e.message ? e.message : tUi('task.unknownError', '未知错误') },
        '查找相似图片失败：' + (e && e.message ? e.message : '未知错误'),
      ),
    );
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
  if (fsLabel)
    fsLabel.textContent = inFs
      ? tUi('preview.exitFullscreen', '退出全屏')
      : tUi('preview.enterFullscreen', '全屏');
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

/**
 * 用户**主动离开当前图**的四条入口（关预览 / 切图 / 首尾张 / 开幻灯片）。
 *
 * 🔴 这四条必须统一走 `guardPendingPreviewEdit()`：待保存的编辑只活在内存里，
 *    不问一句就离开等于把它们**无声丢掉**。拦截刻意放在这几个「意图点」而不是
 *    `openPreview` / `closePreview` 内部 —— 那两个也被保存流程与「查找相似」调用，
 *    在里面弹框会把调用方自己卡住（那几处紧接着就要换 currentPhotos）。
 */
function guardedClosePreview() {
  return guardPendingPreviewEdit(function () {
    return closePreview();
  });
}

function guardedNavigatePreview(dir) {
  return guardPendingPreviewEdit(function () {
    return navigatePreview(dir);
  });
}

function guardedOpenPreviewAt(index) {
  return guardPendingPreviewEdit(function () {
    return openPreview(index);
  });
}

function guardedToggleSlideshow() {
  return guardPendingPreviewEdit(function () {
    return toggleSlideshow();
  });
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
        showPreviewToast(tUi('preview.atFirst', '已是第一张'));
      } else if (boundary === 'last') {
        showPreviewToast(tUi('preview.atLast', '已是最后一张'));
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
// 搜图 / 人物：结果落进主图片网格，卡片、预览翻页、幻灯片、收藏、卡片尺寸全部复用浏览链路。
aiViews = window.RendererAiViews.init({
  dom: dom,
  state: state,
  api: api,
  ui: {
    renderPhotoGrid: photoGridUi.renderPhotoGrid,
    // 关键词档的「文件夹」分组复用目录浏览那套封面卡片（同一个 DOM 契约
    // `.folder-cover-card[data-folder-path]` ⇒ 点一下跳目录的委托监听自动生效）。
    renderFolderCoverGrid: folderCoverUi.renderFolderCoverGrid,
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
// 标签导航页：侧栏三级树与主区卡片列表。照片网格不走这里 —— 它走上面那套通用浏览链路
// （`loadPhotos` → `fetchPhotosPage`），所以预览、信息面板、分页、卡片尺寸都是白拿的。
tagNavUi = window.RendererTagNavUI.mount({
  state: state,
  dom: dom,
  api: api,
  tUi: tUi,
  tUiFmt: tUiFmt,
  escapeHtml: escapeHtml,
  escapeAttr: escapeAttr,
  formatNumber: formatNumber,
  // 选中一个标签 ⇒ 主区换成照片网格；选中一个节点 ⇒ 主区换成卡片列表。
  // 两条都**只**改 state，然后交给 loadPhotos 走既有通路（不自己画网格）。
  onSelectTag: function () {
    if (state.currentTab !== 'tags') return;
    void loadPhotos();
  },
  onRenderCards: function () {
    if (state.currentTab !== 'tags') return;
    void loadPhotos();
  },
  // 标签树/卡片之外还要跟着重画的东西：路径栏上那个标签名。`displayName()` 要等
  // `getTagNavNode` 回来才知道当前语言的名字（切语言后缓存被清掉），回包之后得补一次。
  onChromeRefresh: updateBrowsePathLabel,
});
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
  /**
   * tag 检索层（M4）的开关与查询线、以及**标签展示线**。与 `matchThreshold` 分开注入有三个理由：
   *   ① `write` 的形状不同 —— 这里是**部分更新**（只写被改的那一个键），
   *      因为几个控件各自落库、一起写会把「用户没动过的那一项」按界面上的旧值覆盖回去；
   *   ② `matchThreshold` 只有桌面端有，而 tag 层在网页端是**照用桌面设置**
   *      （见 `main.js#getAiSearchTagOptions`）—— 两者不是同一件事；
   *   ③ 展示线改完要让**已经画出来的数字**失效（见 `write` 里的 `invalidateCounts`），
   *      这是渲染端才知道的事，不该让面板去猜。
   */
  tagLayer: {
    read: function () {
      return api.call('getSettings').then(function (all) {
        return all
          ? {
              tagEnabled: all.aiSearchTagEnabled,
              tagThreshold: all.aiSearchTagThreshold,
              tagDisplayThreshold: all.aiTagDisplayThreshold,
            }
          : null;
      });
    },
    /**
     * 落库（部分更新）。**成功之后**再决定要不要刷新界面。
     *
     * 🔴 为什么非要在这里刷新：展示线是**读侧**分数线，主进程下一次查询就会用新值
     *    （两个服务每次现取 getter），但标签页的「N 张」是**渲染层缓存过的** ——
     *    `src/renderer/tag-nav-ui.js` 的 `subTags` 按子类缓存，展开过就不再重取。
     *    不失效缓存的话，改完设置回到标签页，看到的还是按旧线算的数字，
     *    而**没有任何地方会报错** —— 用户唯一的结论是「这个设置没用」。
     *
     * 为什么等 `updateSettings` 成功才刷：失败时面板会回滚输入框并提示错误，
     * 此时缓存**不该**被清（清了会重取一遍、拿到与旧值相同的结果，白费一次查询，
     * 还让「失败」看起来像「生效了一半」）。
     *
     * ⚠️ 判据是 **patch 里有没有这个键**，不是「值变了没有」：`commitTagDisplay` 在
     *    值没变时根本不会调用写（它提前 return），所以能走到这里的就是真改过。
     */
    write: function (patch) {
      return api.call('updateSettings', patch).then(function (applied) {
        if (patch && patch.tagDisplayThreshold !== undefined) {
          // 展开过的子类计数、主区卡片都按旧线算过 ⇒ 整体失效。
          // 不在标签页时它只清缓存（本次不重取），下次进页自然用新线取。
          if (tagNavUi && typeof tagNavUi.invalidateCounts === 'function') {
            tagNavUi.invalidateCounts();
          }
          // 照片信息面板：开着一张照片时改线，那张面板也要按新线重画（否则停在旧标签上）。
          if (typeof refreshOpenPreviewInfoPanel === 'function') refreshOpenPreviewInfoPanel();
        }
        return applied;
      });
    },
  },
});
/**
 * 打开设置页并定位到「搜图索引」那一节。
 * 搜图 / 人物各有自己的调用点（左栏视图的设置入口、主界面任务面板的「设置」按钮），
 * 但两者的面板已并进「AI 与索引」，所以这里只切到该面板、再把目标子节滚进视野——
 * 保留「把用户带到目标」的语义，而不是简单粗暴地停在面板顶部。
 */
async function openSemanticSettings() {
  await openSettingsPage();
  if (state.currentTab !== 'settings') return;
  window.semanticSettings.show();
  scrollToSettingsSection('settingsSectionAiIndex');
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
  scrollToSettingsSection('settingsSectionAiIndex');
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
document.getElementById('taskFaceSettings').addEventListener('click', function () {
  void openPeopleSettings();
});
document.getElementById('taskSemanticSettings').addEventListener('click', function () {
  void openSemanticSettings();
});
document.getElementById('taskSemanticStop').addEventListener('click', async function () {
  var button = document.getElementById('taskSemanticStop');
  var errorLine = document.getElementById('taskSemanticError');
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
document.getElementById('taskFaceStop').addEventListener('click', async function () {
  var button = document.getElementById('taskFaceStop');
  var errorLine = document.getElementById('taskFaceError');
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
