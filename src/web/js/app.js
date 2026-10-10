var CARD_SIZE_TIERS = [
  { label: 'S', basis: 100 },
  { label: 'M', basis: 140 },
  { label: 'L', basis: 180 },
  { label: 'XL', basis: 320 },
];

function photoCacheVersion(photo) {
  if (!photo) return '';
  return String(photo.file_size || '') + (photo.date_modified || '').replace(/\D/g, '');
}

/**
 * 缩略图 URL 的缓存键（`/thumb/<id>?v=…`）。
 *
 * 🔴 不能沿用 `photoCacheVersion`：它取自**原图**的 `file_size` + `date_modified`，
 *    而缩略图重建（换档 / 转 WebP）不动原图 —— URL 于是完全没变，而服务端那条路由是
 *    `Cache-Control: public, max-age=86400` ⇒ 重建跑完了、手机/浏览器上还是旧档位的图，
 *    最长要等一天。
 *
 * 键里带**这一行自己的规格**（`thumb_size` / `thumb_format`，由列表接口带出来）。
 * 混规格库里这正是要的行为：重建过的行换 URL、还没轮到的行继续命中旧缓存。
 *
 * ⚠️ 与桌面端 `src/renderer/utils.js#thumbCacheVersion` 是**两份实现**（网页端拿不到渲染端
 *    模块）⇒ 公式必须逐字一致，由 `scripts/photo-thumb-url-regression.js` 第 4 组守着。
 *    残留（有意）：单独调「画质」再重建时这两列不变 ⇒ 键不变，可能继续显示旧画质。
 */
function thumbCacheVersion(photo) {
  if (!photo) return '';
  var size = parseInt(photo.thumb_size, 10);
  if (!isFinite(size) || size < 0) size = 0;
  var format = String(photo.thumb_format || '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
  return photoCacheVersion(photo) + '-' + size + format;
}

/** 外观三元组的持久化键（旧键 webThemeStyle 仍写，兼容别处读取） */
var WEB_APPEARANCE_LS_KEY = 'webAppearance.v3';

/** 读持久化的外观三元组；没有则回落到旧的 webThemeStyle 预设 id */
function readWebAppearance() {
  try {
    var raw = localStorage.getItem(WEB_APPEARANCE_LS_KEY);
    if (raw) {
      var o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        return {
          themeStyle: typeof o.themeStyle === 'string' ? o.themeStyle : '',
          uiAccent: o.uiAccent || '',
          uiBackground: o.uiBackground || '',
          uiTexture: o.uiTexture || '',
          uiOpacity: o.uiOpacity || '',
        };
      }
    }
  } catch (e) {}
  var legacy = '';
  try {
    legacy = localStorage.getItem('webThemeStyle') || '';
  } catch (e2) {}
  return {
    themeStyle: Object.prototype.hasOwnProperty.call(WebTheme.WEB_THEME_PRESETS, legacy)
      ? legacy
      : 'midnight_classic',
    uiAccent: '',
    uiBackground: '',
    uiTexture: '',
    uiOpacity: '',
  };
}

function writeWebAppearance(a) {
  try {
    localStorage.setItem(WEB_APPEARANCE_LS_KEY, JSON.stringify(a));
  } catch (e) {}
  try {
    localStorage.setItem('webThemeStyle', a.themeStyle || 'midnight_classic');
  } catch (e2) {}
}

function syncWebAppearanceSelects(res) {
  var ids = ['webThemeStyle', 'mobileThemeStyleSelect'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) el.value = res.themeStyle;
  }
  /* 强调色 / 背景基调：桌面顶栏与移动端面板各一份，必须一起回显 */
  var accentIds = ['webAccentSelect', 'mobileAccentSelect'];
  for (var a = 0; a < accentIds.length; a++) {
    var accentEl = document.getElementById(accentIds[a]);
    if (accentEl) accentEl.value = res.uiAccent;
  }
  var bgIds = ['webBackgroundSelect', 'mobileBackgroundSelect'];
  for (var b = 0; b < bgIds.length; b++) {
    var bgEl = document.getElementById(bgIds[b]);
    if (bgEl) bgEl.value = res.uiBackground;
  }
  /* 材质纹理（第三维）：同样是顶栏 + 移动端面板两份，必须一起回显 */
  var texIds = ['webTextureSelect', 'mobileTextureSelect'];
  for (var t = 0; t < texIds.length; t++) {
    var texEl = document.getElementById(texIds[t]);
    if (texEl) texEl.value = res.uiTexture;
  }
  /* 面板透明度（第五维）：同样是两份 */
  var opaIds = ['webOpacitySelect', 'mobileOpacitySelect'];
  for (var p = 0; p < opaIds.length; p++) {
    var opaEl = document.getElementById(opaIds[p]);
    if (opaEl) opaEl.value = res.uiOpacity;
  }
}

/**
 * 应用外观：预设 id + 可选的强调色 / 背景基调覆盖。
 * ⚠️ `themeStyle` 是**派生结果**（凑不出预设就为空串 = 自定义组合），不是输入权威 ——
 * 所以只改强调色时不要把旧 id 当成"覆盖掉 accent"的依据。
 */
function applyWebAppearance(appearance) {
  if (!(window.WebTheme && WebTheme.applyWebThemeVariables)) return null;
  var incoming = appearance || {};
  var res = WebTheme.applyWebThemeVariables(
    document.documentElement,
    incoming.themeStyle,
    incoming.uiAccent || undefined,
    incoming.uiBackground || undefined,
    incoming.uiTexture || undefined,
    incoming.uiOpacity || undefined,
  );
  writeWebAppearance({
    themeStyle: res.themeStyle,
    uiAccent: res.uiAccent,
    uiBackground: res.uiBackground,
    uiTexture: res.uiTexture,
    uiOpacity: res.uiOpacity,
  });
  syncWebAppearanceSelects(res);
  return res;
}

/** 套用整套预设（顶栏 / 移动端主题下拉的入口）；选「自定义组合」= 保持当前外观只改标签 */
function applyWebThemeStyle(id) {
  if (!id) {
    var cur = readWebAppearance();
    return applyWebAppearance({
      themeStyle: '',
      uiAccent: cur.uiAccent,
      uiBackground: cur.uiBackground,
      uiTexture: cur.uiTexture,
      uiOpacity: cur.uiOpacity,
    });
  }
  // 🔴 套预设只固定三元组，**纹理与透明度都是正交维度、不属于预设** → 必须原样带过来，
  //    否则「换风格」会把用户选的纹理 / 透明度静默清掉。
  var cur2 = readWebAppearance();
  return applyWebAppearance({
    themeStyle: id,
    uiTexture: cur2.uiTexture,
    uiOpacity: cur2.uiOpacity,
  });
}

/** 只改强调色，明暗与背景基调保持当前 */
function changeWebAccent(accent) {
  var cur = readWebAppearance();
  return applyWebAppearance({
    themeStyle: cur.themeStyle,
    uiAccent: accent,
    uiBackground: cur.uiBackground,
    uiTexture: cur.uiTexture,
    uiOpacity: cur.uiOpacity,
  });
}

/** 只改背景基调，明暗与强调色保持当前 */
function changeWebBackground(bg) {
  var cur = readWebAppearance();
  return applyWebAppearance({
    themeStyle: cur.themeStyle,
    uiAccent: cur.uiAccent,
    uiBackground: bg,
    uiTexture: cur.uiTexture,
    uiOpacity: cur.uiOpacity,
  });
}

/** 只改材质纹理（第三维），明暗 / 强调色 / 背景基调全部保持当前 */
function changeWebTexture(texture) {
  var cur = readWebAppearance();
  return applyWebAppearance({
    themeStyle: cur.themeStyle,
    uiAccent: cur.uiAccent,
    uiBackground: cur.uiBackground,
    uiTexture: texture,
    uiOpacity: cur.uiOpacity,
  });
}

/** 只改面板透明度（第五维），其余维度全部保持当前 */
function changeWebOpacity(opacity) {
  var cur = readWebAppearance();
  return applyWebAppearance({
    themeStyle: cur.themeStyle,
    uiAccent: cur.uiAccent,
    uiBackground: cur.uiBackground,
    uiTexture: cur.uiTexture,
    uiOpacity: opacity,
  });
}

function snapBrowseCardBasis(n) {
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
}

function browseCardTierIndexForBasis(basis) {
  var b = snapBrowseCardBasis(basis);
  for (var j = 0; j < CARD_SIZE_TIERS.length; j++) {
    if (CARD_SIZE_TIERS[j].basis === b) return j;
  }
  return 2;
}

// 🔴 这张表是「卡片比例」的**唯一取值域**，必须与 `index.html` 里
// `#headerCardAspectSelect`（顶栏）和 `#cardAspectSelect`（手机筛选抽屉）的
// `<option value>` 集合逐位一致 —— 设置页的外观面板也是从这两处克隆选项的。
// 少一项的后果不是报错而是**静默丢弃**：`normalizeCardAspectMode` 会把它回落成
// `masonry`，用户点「9:16 固定」当场弹回原比例瀑布流，看着就像控件坏了。
// （2026-10-05 修：抽屉里一直摆着 `uniform_9_16`，取值域却没有它 → 这一档从来没生效过。）
// 除 masonry 外的 5 档与桌面端 `utils.js#BROWSE_CARD_RATIOS` 一一对应。
var CARD_ASPECT_MODES = [
  'masonry',
  'uniform_1_1',
  'uniform_4_3',
  'uniform_3_4',
  'uniform_9_16',
  'uniform_16_9',
];
function normalizeCardAspectMode(raw) {
  var s = String(raw || '');
  if (CARD_ASPECT_MODES.indexOf(s) >= 0) return s;
  return 'masonry';
}
function getUniformAspectCss(mode) {
  if (mode === 'uniform_1_1') return '1 / 1';
  if (mode === 'uniform_4_3') return '4 / 3';
  if (mode === 'uniform_3_4') return '3 / 4';
  if (mode === 'uniform_9_16') return '9 / 16';
  if (mode === 'uniform_16_9') return '16 / 9';
  return '';
}
function applyCardAspectModeUi() {
  var v = normalizeCardAspectMode(state.cardAspectMode);
  var sel = $('#cardAspectSelect');
  if (sel && sel.value !== v) sel.value = v;
  var headerSel = $('#headerCardAspectSelect');
  if (headerSel && headerSel.value !== v) headerSel.value = v;
}
function changeCardAspectMode(val) {
  state.cardAspectMode = normalizeCardAspectMode(val);
  try {
    localStorage.setItem('webCardAspectMode', state.cardAspectMode);
  } catch (eCam) {}
  applyCardAspectModeUi();
  if (state.currentPhotos && state.currentPhotos.length) {
    renderPhotoGrid(state.currentPhotos);
  }
}

// === State ===
var state = {
  currentTab: 'folders',
  currentView: 'all',
  // 标签导航页：选中的标签（叶子）与正在下钻的节点（分类 / 子类）。三者互斥：
  // `currentTag` 有值 ⇒ 主区是照片网格；否则 `currentTagNode` 有值 ⇒ 主区是标签卡片。
  currentTag: '',
  currentTagNode: '',
  currentTagNodeKind: '',
  currentPath: '',
  currentDate: '',
  searchQuery: '',
  sortBy: 'date_taken',
  sortOrder: 'DESC',
  page: 1,
  pageSize: 50,
  mediaFilter: 'all',
  // 组织元数据筛选（评分 / 标记 / 标签）。取值与主进程判据同源：
  // `0`（未评分）与 `none`（未标记）是**合法的具体值**，与「不限」（null）刻意分开。
  orgFilter: { rating: null, flag: null, tagIds: [] },
  tagList: [],
  previewTags: [],
  previewTagsPhotoId: 0,
  previewTagsLoadSeq: 0,
  cardSize: 180,
  cardAspectMode: 'masonry',
  currentPhotos: [],
  previewIndex: -1,
  previewPhotos: [],
  previewTotalPhotos: 0,
  previewTotalPages: 0,
  previewPageStart: 1,
  previewLoadingPage: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
  /**
   * 预览态里**待保存**的编辑动作（按点击顺序）。点「保存」时整串一次性 POST 给后端
   * 合成**一条**算子（`/api/photo-edit-apply`），所以连点三次旋转与直接转到 270°
   * 产出**逐字节相同**的文件。
   *
   * 🔴 只存「动作串」，不存合成后的角度/镜像位：合成规则（CSS 求值顺序与 sharp 算子
   *    顺序同构）唯一实现源是 `image-edit.js#composeAction`，前端再写一份必然漂移。
   */
  previewEditPendingActions: [],
  /** 待保存动作的**原样 CSS 变换尾巴**，按点击逆序拼（`updatePreviewTransform` 接在后面） */
  previewEditCssTail: '',
  /** 待保存动作的旋转角**和**（只用来判「90 的奇数倍」⇒ 布局要不要给转过来的图留空间） */
  previewEditRotateDeg: 0,
  isDragging: false,
  hasDragged: false,
  dragStartX: 0,
  dragStartY: 0,
  dragStartPanX: 0,
  dragStartPanY: 0,
  _rootFolders: [],
  _rootId: undefined,
  // comment cleaned
  isMobile: window.innerWidth <= 600,
  mobileNavTab: 'browse',
  // comment cleaned
  touchStartX: 0,
  touchStartY: 0,
  touchStartTime: 0,
  touchStartDist: 0,
  touchStartZoom: 1,
  isSwiping: false,
  swipeDirection: null,
  slideshowPlaying: false,
  slideshowIntervalSec: 3,
  slideshowTimer: null,
  slideshowRandom: false,
  slideshowRandomSeed: 0,
  slideshowRandomPool: [],
  slideshowRandomBatch: [],
  slideshowRandomBatchPos: 0,
  slideshowRandomBatchRound: 0,
  previewRandomPositionNum: 0,
  slideshowStepLoading: false,
  subtitleEnabled: true,
  subtitleSize: 'md',
  subtitlePosition: 'bottom',
  previewRequestSeq: 0,
  /** Live Photo 的伴生视频是否正在叠加层里播（按钮文案/激活态看它） */
  previewLivePlaying: false,
  /** 预览大图 onload 兜底定时器（同 URL 不触发 onload / 请求挂起时避免一直显示加载中） */
  previewImageLoadSafetyTimer: null,
  previewSwipeHintShown: false,
  previewSwipeHintTimer: null,
  previewOverlaySwiping: false,
  previewOverlaySwipeStartX: 0,
  previewOverlaySwipeStartY: 0,
  previewUiHidden: false,
  previewBodyTouchStartY: 0,
  previewBodyTouchStartX: 0,
  previewBodyTouchDy: 0,
  previewBodyTouchActive: false,
  previewLastTapAt: 0,
  previewNavAutoHideTimer: null,
  mobileLastGridScrollTop: 0,
  mobileFilterTouchStartY: 0,
  mobileFilterTouchDeltaY: 0,
  dateGroupsSortOrder: 'desc',
  // comment cleaned
  pullStartY: 0,
  isPulling: false,
  isRefreshing: false,
  stats: null,
  folderCovers: null,
  photosRequestSeq: 0,
};

var $ = function (sel) {
  return document.querySelector(sel);
};

function setText(sel, value) {
  var el = $(sel);
  if (el) el.textContent = value;
}
function setDisplay(sel, value) {
  var el = $(sel);
  if (el) el.style.display = value;
}
function setProp(sel, prop, value) {
  var el = $(sel);
  if (el) el[prop] = value;
}

var isApplyingHistoryState = false;
var deferredInstallPrompt = null;

function getViewHistoryState() {
  var p = Number(state.page);
  if (!isFinite(p) || p < 1) p = 1;
  return {
    currentView: state.currentView,
    currentPath: state.currentPath || '',
    currentDate: state.currentDate || '',
    searchQuery: state.searchQuery || '',
    rootId: state._rootId,
    page: Math.floor(p),
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    mediaFilter: state.mediaFilter || 'all',
    pageSize: state.pageSize,
    previewOpen: false,
  };
}

function pushViewHistoryState() {
  if (isApplyingHistoryState) return;
  try {
    window.history.pushState(getViewHistoryState(), '', window.location.href);
  } catch (e) {}
}

function replaceViewHistoryState() {
  try {
    window.history.replaceState(getViewHistoryState(), '', window.location.href);
  } catch (e) {}
}

function pushPreviewHistoryState() {
  if (isApplyingHistoryState) return;
  try {
    var hs = getViewHistoryState();
    hs.previewOpen = true;
    window.history.pushState(hs, '', window.location.href);
  } catch (e) {}
}

function applyHistoryStateToView(hs) {
  var payload = hs || {};
  isApplyingHistoryState = true;
  try {
    state.currentView = payload.currentView || 'all';
    state.currentPath = payload.currentPath || '';
    state.currentDate = payload.currentDate || '';
    state.searchQuery = payload.searchQuery || '';
    state._rootId = payload.rootId;
    var hp = payload.page;
    if (typeof hp === 'number' && isFinite(hp) && hp >= 1) {
      state.page = Math.floor(hp);
    } else if (typeof hp === 'string' && /^\d+$/.test(hp)) {
      var pi = parseInt(hp, 10);
      state.page = pi >= 1 ? pi : 1;
    } else {
      state.page = 1;
    }
    state.sortBy = payload.sortBy || state.sortBy || 'date_taken';
    state.sortOrder = payload.sortOrder || state.sortOrder || 'DESC';
    state.mediaFilter = normalizeMediaFilter(payload.mediaFilter || state.mediaFilter || 'all');
    var ps = parseInt(payload.pageSize, 10);
    if ([50, 80, 100, 200].indexOf(ps) >= 0) state.pageSize = ps;
    var sortSel = $('#sortSelect');
    if (sortSel) sortSel.value = state.sortBy + '|' + state.sortOrder;
    var mobileSortSel = $('#mobileSortSelect');
    if (mobileSortSel) mobileSortSel.value = state.sortBy + '|' + state.sortOrder;
    var pageSizeSel = $('#pageSizeSelect');
    if (pageSizeSel) pageSizeSel.value = String(state.pageSize);
    var mobilePageSizeSel = $('#mobilePageSizeSelect');
    if (mobilePageSizeSel) mobilePageSizeSel.value = String(state.pageSize);

    var headerTitle = $('#headerTitle');
    var defaultTitle = '\u62C2\u6653\u56FE\u5E93 \u00B7 Aurora Gallery';
    if (state.currentView === 'folder_overview') {
      if (headerTitle) headerTitle.textContent = defaultTitle;
      updateSidebarActive();
      if (isFolderSidebarTab(state.currentTab)) loadRootFolders();
      loadFolderCovers();
    } else if (state.currentView === 'folder') {
      var name = state.currentPath ? state.currentPath.split(/[\\/]/).pop() : '';
      if (headerTitle) headerTitle.textContent = '\u6587\u4EF6\u5939: ' + (name || '\u76EE\u5F55');
      updateSidebarActive();
      if (isFolderSidebarTab(state.currentTab)) loadRootFolders();
      loadPhotos();
    } else if (state.currentView === 'date') {
      if (headerTitle)
        headerTitle.textContent = '\u65E5\u671F: ' + formatDateLabel(state.currentDate || '');
      updateSidebarActive();
      if (state.currentTab === 'dates') loadDateGroups();
      loadPhotos();
    } else if (state.currentView === 'root') {
      var rootName = '';
      for (var i = 0; i < state._rootFolders.length; i++) {
        if (state._rootFolders[i].id === state._rootId) {
          rootName = state._rootFolders[i].name;
          break;
        }
      }
      if (headerTitle)
        headerTitle.textContent = '\u6839\u76EE\u5F55: ' + (rootName || '\u6839\u76EE\u5F55');
      updateSidebarActive();
      if (isFolderSidebarTab(state.currentTab)) loadRootFolders();
      loadPhotos();
    } else if (state.currentView === 'search' && state.searchQuery) {
      if (headerTitle) headerTitle.textContent = '\u641C\u7D22: ' + state.searchQuery;
      updateSidebarActive();
      loadPhotos();
    } else if (state.currentView === 'ai_search' || state.currentView === 'people') {
      // 历史记录里也能出现智能视图（例如从结果页开预览时压下的那条），整段交给适配层重建。
      enterWebAiView(state.currentView);
    } else {
      state.currentView = 'all';
      state._rootId = undefined;
      state.currentPath = '';
      state.currentDate = '';
      if (headerTitle) headerTitle.textContent = defaultTitle;
      updateSidebarActive();
      loadPhotos();
    }
  } finally {
    isApplyingHistoryState = false;
  }
}

function isWebVideoFileType(fileType) {
  if (
    window.PhotoPlaybackStrategy &&
    typeof window.PhotoPlaybackStrategy.isVideoFileType === 'function'
  ) {
    return window.PhotoPlaybackStrategy.isVideoFileType(fileType);
  }
  var t = fileType != null ? String(fileType).toLowerCase() : '';
  if (!t) return false;
  return (
    [
      'mp4',
      'mov',
      'm4v',
      'mkv',
      'avi',
      'wmv',
      'webm',
      'flv',
      'mpg',
      'mpeg',
      'm2ts',
      'ts',
      '3gp',
      '3g2',
    ].indexOf(t) >= 0
  );
}

/** 幻灯片仅跳过视频，与桌面端一致 */
function isWebSlideshowVideoPhoto(photo) {
  if (!photo) return false;
  if (isWebVideoFileType(photo.file_type)) return true;
  if (String(photo.media_type || '').toLowerCase() === 'video') return true;
  return false;
}

function getMediaAspectRatioDims(photo) {
  var row = photo || {};
  var w = parseFloat(row.width || row.pixel_width || row.file_width || row.media_width || 0);
  var h = parseFloat(row.height || row.pixel_height || row.file_height || row.media_height || 0);
  if (!(w > 0 && h > 0)) return null;
  var r = w / h;
  if (!isFinite(r) || r <= 0) return null;
  if (r < 0.125 || r > 8) return null;
  return { w: Math.round(w), h: Math.round(h), ratio: String(w) + ' / ' + String(h) };
}

function syncSubtitleSettingsUi() {
  var btn = $('#previewSubtitleToggleBtn');
  if (btn) btn.textContent = state.subtitleEnabled ? '\u5B57\u5E55:\u5F00' : '\u5B57\u5E55:\u5173';
}

function setSubtitleToggleVisible(visible) {
  var btn = $('#previewSubtitleToggleBtn');
  if (!btn) return;
  btn.style.display = visible ? '' : 'none';
}

function applySubtitlePresentation(video) {
  if (!video) return;
  video.classList.remove('subtitle-size-sm', 'subtitle-size-md', 'subtitle-size-lg');
  video.classList.remove('subtitle-pos-bottom', 'subtitle-pos-middle', 'subtitle-pos-top');
  video.classList.add('subtitle-size-' + state.subtitleSize);
  video.classList.add('subtitle-pos-' + state.subtitlePosition);
  if (video.textTracks) {
    for (var i = 0; i < video.textTracks.length; i++) {
      try {
        video.textTracks[i].mode = state.subtitleEnabled ? 'showing' : 'hidden';
      } catch (eTrack) {}
    }
  }
}

function setPreviewMobileUiHidden(hidden) {
  state.previewUiHidden = !!hidden;
  var overlay = $('#previewOverlay');
  if (!overlay) return;
  overlay.classList.toggle('mobile-ui-hidden', !!hidden && state.isMobile);
}

function setMobilePreviewNavVisible(visible) {
  var overlay = $('#previewOverlay');
  if (!overlay) return;
  if (state.previewNavAutoHideTimer) {
    clearTimeout(state.previewNavAutoHideTimer);
    state.previewNavAutoHideTimer = null;
  }
  var show = !!visible && state.isMobile;
  overlay.classList.toggle('mobile-nav-visible', show);
  if (show) {
    state.previewNavAutoHideTimer = setTimeout(function () {
      overlay.classList.remove('mobile-nav-visible');
      state.previewNavAutoHideTimer = null;
    }, 2200);
  }
}

// ==== 全屏浮层控件显隐（网页端）====
// 与桌面端 ui-events.js#bindPreviewUiMeta 同一套判据：全屏下四组浮层控件
// （左上放映区 / 右上关闭区 / 左右切换 / 右下缩放百分比）由 `fs-ui-visible` 统一派生。
// 样式在 index.html 的「全屏浮层控件显隐」块里，且只对 ≥601px 生效。
var previewFsUiHideTimer = null;
var previewFsUiArmRaf = 0;
// 指针是否压在控件本体上；为真时不收起（否则缩放提示框会在光标底下消失）。
var previewFsUiPointerOverControls = false;

function isPreviewFullscreenActive() {
  var overlay = $('#previewOverlay');
  return !!(overlay && document.fullscreenElement === overlay);
}

function setPreviewFullscreenUiVisible(visible) {
  var overlay = $('#previewOverlay');
  if (!overlay) return;
  overlay.classList.toggle('fs-ui-visible', !!visible);
}

function schedulePreviewFullscreenUiHide(delayMs) {
  if (previewFsUiHideTimer) clearTimeout(previewFsUiHideTimer);
  previewFsUiHideTimer = setTimeout(function () {
    previewFsUiHideTimer = null;
    if (!isPreviewFullscreenActive()) return;
    if (previewFsUiPointerOverControls) {
      schedulePreviewFullscreenUiHide(400);
      return;
    }
    setPreviewFullscreenUiVisible(false);
  }, delayMs || 1400);
}

function revealPreviewFullscreenUiOnMove(target) {
  previewFsUiPointerOverControls = !!(
    target &&
    target.closest &&
    target.closest(
      '.preview-slideshow-controls, .preview-window-controls, .preview-nav, .preview-zoom-box',
    )
  );
  if (previewFsUiArmRaf) return;
  previewFsUiArmRaf = requestAnimationFrame(function () {
    previewFsUiArmRaf = 0;
    setPreviewFullscreenUiVisible(true);
    schedulePreviewFullscreenUiHide(1100);
  });
}

/** 进出全屏的唯一提交点：`is-fullscreen` / `fs-ui-visible` 只许在这里改。 */
function syncPreviewFullscreenChrome() {
  var overlay = $('#previewOverlay');
  if (!overlay) return;
  var isFs = document.fullscreenElement === overlay;
  overlay.classList.toggle('is-fullscreen', isFs);
  // 进出全屏时指针位置是上一次交互的残留（刚点完「全屏」光标还压在按钮上），
  // 必须重置，否则那一次悬停会把浮层控件永久钉住。
  previewFsUiPointerOverControls = false;
  if (isFs) {
    setPreviewFullscreenUiVisible(true);
    schedulePreviewFullscreenUiHide(1200);
  } else {
    if (previewFsUiHideTimer) {
      clearTimeout(previewFsUiHideTimer);
      previewFsUiHideTimer = null;
    }
    setPreviewFullscreenUiVisible(false);
  }
}

function enforceMobileSubtitleDefault() {
  if (!state.isMobile) return;
  if (state.subtitleEnabled === true) return;
  state.subtitleEnabled = true;
  syncSubtitleSettingsUi();
  applySubtitlePresentation($('#previewVideo'));
}

function persistSubtitleSettings() {
  try {
    localStorage.setItem(
      'webSubtitleSettings',
      JSON.stringify({
        enabled: !!state.subtitleEnabled,
        size: state.subtitleSize,
        position: state.subtitlePosition,
      }),
    );
  } catch (e) {}
}

function loadSubtitleSettings() {
  try {
    var raw = localStorage.getItem('webSubtitleSettings');
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state.subtitleEnabled = parsed.enabled !== false;
      var s = String(parsed.size || 'md');
      state.subtitleSize = s === 'sm' || s === 'lg' ? s : 'md';
      var p = String(parsed.position || 'bottom');
      state.subtitlePosition = p === 'top' || p === 'middle' || p === 'bottom' ? p : 'bottom';
    }
  } catch (e) {}
}

function toggleSubtitleEnabled() {
  state.subtitleEnabled = !state.subtitleEnabled;
  persistSubtitleSettings();
  syncSubtitleSettingsUi();
  applySubtitlePresentation($('#previewVideo'));
}

function _changeSubtitleSize(v) {
  state.subtitleSize = v === 'sm' || v === 'lg' ? v : 'md';
  persistSubtitleSettings();
  syncSubtitleSettingsUi();
  applySubtitlePresentation($('#previewVideo'));
}

function _changeSubtitlePosition(v) {
  state.subtitlePosition = v === 'top' || v === 'middle' ? v : 'bottom';
  persistSubtitleSettings();
  syncSubtitleSettingsUi();
  applySubtitlePresentation($('#previewVideo'));
}

function refreshWebPreviewRandomPositionNum() {
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

/* comment cleaned */
function applyWebPauseVideoAfterSwitch(videoEl, pauseAfterSwitch) {
  if (!videoEl || !pauseAfterSwitch) return;
  function pauseOnce() {
    try {
      videoEl.pause();
    } catch (e0) {}
    try {
      videoEl.currentTime = 0;
    } catch (e1) {}
  }
  pauseOnce();
  var onPlaying = function () {
    pauseOnce();
  };
  videoEl.addEventListener('playing', onPlaying);
  setTimeout(function () {
    videoEl.removeEventListener('playing', onPlaying);
  }, 2000);
  var onReady = function () {
    pauseOnce();
    videoEl.removeEventListener('loadeddata', onReady);
    videoEl.removeEventListener('canplay', onReady);
  };
  videoEl.addEventListener('loadeddata', onReady);
  videoEl.addEventListener('canplay', onReady);
}

function loadWebVideoForPreview(photo, video, index, requestSeq, pauseAfterSwitch) {
  function isCurrentPreviewRequest() {
    return requestSeq === state.previewRequestSeq;
  }
  var loadingEl = $('#previewLoading');
  var centerPlayBtn = $('#previewVideoCenterPlay');

  function syncCenterPlayBtn() {
    if (!centerPlayBtn || !video || video.style.display === 'none') {
      if (centerPlayBtn) centerPlayBtn.style.display = 'none';
      return;
    }
    var paused = !!video.paused || !!video.ended;
    centerPlayBtn.style.display = paused ? '' : 'none';
    centerPlayBtn.innerHTML = paused
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"></path></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 19h2.8V5H8zm5.2 0H16V5h-2.8z"></path></svg>';
    centerPlayBtn.setAttribute('aria-label', paused ? '播放视频' : '暂停视频');
    centerPlayBtn.title = paused ? '播放' : '暂停';
  }

  if (centerPlayBtn && !centerPlayBtn._wired) {
    centerPlayBtn._wired = true;
    centerPlayBtn.addEventListener('click', function () {
      if (video.paused || video.ended) {
        video.play().catch(function () {});
      } else {
        video.pause();
      }
      syncCenterPlayBtn();
    });
  }

  function stopLoadingForVideo() {
    if (!isCurrentPreviewRequest()) return;
    video.style.visibility = '';
    if (loadingEl) loadingEl.classList.remove('show');
    syncCenterPlayBtn();
  }
  video.onloadedmetadata = stopLoadingForVideo;
  video.oncanplay = stopLoadingForVideo;
  video.onerror = stopLoadingForVideo;
  video.addEventListener('play', syncCenterPlayBtn);
  video.addEventListener('pause', syncCenterPlayBtn);
  video.addEventListener('ended', syncCenterPlayBtn);
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  applySubtitlePresentation(video);
  var oldTrack = $('#previewSubtitleTrack');
  if (oldTrack && oldTrack.parentNode) {
    oldTrack.parentNode.removeChild(oldTrack);
  }
  if (window.PhotoHlsAttach) {
    window.PhotoHlsAttach.destroy(video);
  } else {
    try {
      video.pause();
    } catch (e0) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (e1) {}
  }
  // comment cleaned
  var subtitleTrack = document.createElement('track');
  subtitleTrack.id = 'previewSubtitleTrack';
  subtitleTrack.kind = 'subtitles';
  subtitleTrack.label = '\u5B57\u5E55';
  subtitleTrack.srclang = 'zh';
  subtitleTrack.src = '/api/video-subtitle?id=' + encodeURIComponent(photo.id);
  subtitleTrack.default = true;
  subtitleTrack.addEventListener('load', function () {
    if (video.textTracks && video.textTracks.length > 0) {
      try {
        video.textTracks[0].mode = state.subtitleEnabled ? 'showing' : 'hidden';
      } catch (eMode) {}
    }
    applySubtitlePresentation(video);
  });
  subtitleTrack.addEventListener('error', function () {
    // comment cleaned
  });
  video.appendChild(subtitleTrack);
  fetch('/api/video-playback?id=' + photo.id, { credentials: 'same-origin' })
    .then(function (r) {
      if (r.status === 401) throw new Error('auth');
      return r.json();
    })
    .then(function (data) {
      if (!isCurrentPreviewRequest()) return;
      if (data.error === 'not_found') {
        stopLoadingForVideo();
        // comment cleaned
        return;
      }
      if (data.error === 'hls_unavailable' || data.error === 'hls_failed') {
        stopLoadingForVideo();
        // comment cleaned
        return;
      }
      if (!data.ready) {
        stopLoadingForVideo();
        // comment cleaned
        return;
      }
      if (data.mode === 'hls' && data.playlistUrl && window.PhotoHlsAttach) {
        var abs = new URL(data.playlistUrl, window.location.href).href;
        window.PhotoHlsAttach.attach(video, abs);
      } else if (data.url) {
        video.src = data.url;
        try {
          video.load();
        } catch (e3) {}
      }
      if (state.slideshowPlaying) {
        try {
          video.play().catch(function () {});
        } catch (ePlay) {}
      } else {
        applyWebPauseVideoAfterSwitch(video, !!pauseAfterSwitch);
      }
      // comment cleaned
    })
    .catch(function () {
      if (!isCurrentPreviewRequest()) return;
      stopLoadingForVideo();
      // comment cleaned
    });
}

// === Live Photo 预览播放 ===
/**
 * 一条 Live Photo 在库里只占**一个**条目：图片行自己，而伴生 MOV 被配对任务
 * 记在 `photo.live_motion_id` 上、并从所有媒体档位里排掉。所以「看这段动态」
 * **只能发生在预览里** —— 没有本段，等于把用户那条视频藏了却没有入口。
 *
 * 🔴 判据只认 `photo.live_motion_id`（配对任务写进库的事实）。
 *    真库实测：全库 4554 个 `.mov` 里，按「同目录同名」判会命中 1107 个，
 *    而其中真正带 Apple identifier 的只有 1 个 —— 其余 1106 个是写真集的
 *    「封面图 + 正片」（`(1).MOV 154MB ↔ (1).JPG 1MB`）。现场推断必然误伤。
 */
function isWebLivePhotoStill(photo) {
  return !!(photo && Number(photo.live_motion_id) > 0);
}

function webLiveVideoEl() {
  return document.getElementById('previewLiveVideo');
}

/** 收干净：解除 HLS 会话 → 断源 → 隐藏。顺序不能换（destroy 自己会断源）。 */
function stopWebLivePlayback() {
  state.previewLivePlaying = false;
  var video = webLiveVideoEl();
  if (video) {
    if (window.PhotoHlsAttach) window.PhotoHlsAttach.destroy(video);
    try {
      video.pause();
    } catch (e0) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (e1) {}
    video.style.display = 'none';
    video.onended = null;
  }
  syncWebLiveButton();
}

function syncWebLiveButton(isVideo) {
  var btn = document.getElementById('previewLiveBtn');
  if (!btn) return;
  var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
  var show = !isVideo && isWebLivePhotoStill(photo);
  btn.style.display = show ? '' : 'none';
  btn.classList.toggle('active', show && !!state.previewLivePlaying);
  btn.title = show && state.previewLivePlaying ? '停止实况' : '播放实况（含动态的那一段）';
}

/**
 * 每次预览切图都走这里。
 * 🔴 **必须无条件先停** —— 「上一张是 Live、下一张也是 Live」时若只在
 *    「新图片不是 Live」时才停，上一段动态会继续盖在新静止图上播完。
 */
function syncWebLivePreview(photo, isVideo) {
  void photo;
  stopWebLivePlayback();
  syncWebLiveButton(!!isVideo);
}

function playWebLiveVideo(video) {
  try {
    var p = video.play();
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e0) {}
}

function attachWebLiveVideo(motionId) {
  var video = webLiveVideoEl();
  if (!video || motionId <= 0) return;
  var stillId = Number((state.previewPhotos[state.previewIndex] || {}).id);
  var seq = state.previewRequestSeq;

  /** 异步回来时用户可能已翻页/关了预览 —— 不许再灌内容。 */
  function stillIsCurrent() {
    if (seq !== state.previewRequestSeq) return false;
    var cur = state.previewPhotos && state.previewPhotos[state.previewIndex];
    return !!cur && Number(cur.id) === stillId;
  }

  // HLS 档要等清单解析完才有东西可播，两种档都靠这条 canplay 兜住。
  if (video._webLiveTryPlay) video.removeEventListener('canplay', video._webLiveTryPlay);
  video._webLiveTryPlay = function () {
    video.removeEventListener('canplay', video._webLiveTryPlay);
    video._webLiveTryPlay = null;
    if (!stillIsCurrent()) return;
    playWebLiveVideo(video);
  };
  video.addEventListener('canplay', video._webLiveTryPlay);

  fetch('/api/video-playback?id=' + motionId, { credentials: 'same-origin' })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (!stillIsCurrent()) return;
      if (data && data.mode === 'hls' && data.ready && data.playlistUrl && window.PhotoHlsAttach) {
        var abs = new URL(data.playlistUrl, window.location.href).href;
        window.PhotoHlsAttach.attach(video, abs);
      } else if (data && data.url) {
        video.src = data.url;
        try {
          video.load();
        } catch (e2) {}
      } else {
        // 服务端说不能播（未转码完 / 格式不支持）—— 直接收回，别留个空壳
        stopWebLivePlayback();
        return;
      }
      if (stillIsCurrent()) playWebLiveVideo(video);
    })
    .catch(function () {
      if (stillIsCurrent()) stopWebLivePlayback();
    });
}

function toggleWebLivePlayback() {
  var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
  if (!isWebLivePhotoStill(photo)) return;
  if (state.previewLivePlaying) {
    stopWebLivePlayback();
    return;
  }
  var video = webLiveVideoEl();
  var motionId = Number(photo.live_motion_id) || 0;
  if (!video || motionId <= 0) return;
  state.previewLivePlaying = true;
  video.style.display = '';
  video.onended = function () {
    stopWebLivePlayback();
  };
  syncWebLiveButton(false);
  attachWebLiveVideo(motionId);
}

// === API ===
var activePhotoRequest = null;
function beginPhotoRequest() {
  if (activePhotoRequest) activePhotoRequest.controller.abort();
  var controller = new AbortController();
  activePhotoRequest = {
    controller: controller,
    signal: controller.signal,
    seq: ++state.photosRequestSeq,
  };
  return activePhotoRequest;
}

function apiGet(url, signal) {
  return fetch(url, { credentials: 'same-origin', signal: signal }).then(function (r) {
    if (r.status === 401) {
      // Redirect to login when auth expires.
      try {
        window.location.href = '/login';
      } catch (e) {}
      throw new Error('auth');
    }
    if (!r.ok) {
      throw new Error('http_' + r.status);
    }
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('application/json') < 0) {
      // comment cleaned
      throw new Error('non_json');
    }
    return r.json();
  });
}

function hideAppBootLoading() {
  var el = document.getElementById('appBootLoading');
  if (!el) return;
  try {
    el.setAttribute('aria-busy', 'false');
  } catch (eA) {}
  el.classList.add('app-boot-loading--hide');
  setTimeout(function () {
    try {
      el.style.display = 'none';
    } catch (eD) {}
  }, 420);
}

// === Init ===
async function init() {
  // Always enter default home view on each startup.
  state.currentTab = 'folders';
  state.currentView = 'all';
  state.currentPath = '';
  state.currentDate = '';
  state.searchQuery = '';
  state.page = 1;
  try {
    var savedPageSize = parseInt(localStorage.getItem('webPageSize'), 10);
    if ([50, 80, 100, 200].indexOf(savedPageSize) >= 0) state.pageSize = savedPageSize;
  } catch (ePs) {}
  window.PhotoHlsConfig = {
    onSessionEnd: function (sessionId) {
      fetch('/api/hls-stop?sessionId=' + encodeURIComponent(sessionId), {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(function () {});
    },
  };
  applyWebAppearance(readWebAppearance());
  try {
    var wdgs = localStorage.getItem('dateGroupsSortOrder');
    if (wdgs === 'asc' || wdgs === 'desc') state.dateGroupsSortOrder = wdgs;
  } catch (eWgs) {}
  try {
    state.cardAspectMode = normalizeCardAspectMode(localStorage.getItem('webCardAspectMode'));
  } catch (eCam) {
    state.cardAspectMode = 'masonry';
  }
  applyCardAspectModeUi();
  loadSubtitleSettings();
  syncSubtitleSettingsUi();
  detectMobile();
  var mobileSortSel = $('#mobileSortSelect');
  if (mobileSortSel) mobileSortSel.value = state.sortBy + '|' + state.sortOrder;
  var headerMediaFilterSel = $('#headerMediaFilterSelect');
  if (headerMediaFilterSel) headerMediaFilterSel.value = state.mediaFilter;
  var pageSizeSel = $('#pageSizeSelect');
  if (pageSizeSel) pageSizeSel.value = String(state.pageSize);
  var mobilePageSizeSel = $('#mobilePageSizeSelect');
  if (mobilePageSizeSel) mobilePageSizeSel.value = String(state.pageSize);
  try {
    await Promise.all([loadStats(), loadRootFolders()]);
  } catch (e) {
    // comment cleaned
    var sc = $('#sidebarContent');
    if (sc) {
      sc.innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">' +
        '\u76EE\u5F55\u52A0\u8F7D\u5931\u8D25\uFF1A\u8BF7\u786E\u8BA4\u5DF2\u767B\u5F55\uFF0C\u6216 Web \u670D\u52A1\u6B63\u5E38\u8FD0\u884C\u3002' +
        '</div>';
    }
    var pg = $('#photoGrid');
    if (pg) {
      pg.innerHTML =
        '<div class="empty-state"><div class="icon">!</div><div class="title">\u52A0\u8F7D\u5931\u8D25</div></div>';
    }
  }
  bindEvents();
  try {
    await loadPhotos();
  } finally {
    hideAppBootLoading();
  }
  replaceViewHistoryState();
  // comment cleaned
  if (state.isMobile) initPullRefresh();
}

function detectMobile() {
  state.isMobile = window.innerWidth <= 600;
  var bottomNav = $('#mobileBottomNav');
  var header = document.querySelector('.header');
  if (state.isMobile) {
    if (bottomNav) bottomNav.classList.add('show');
    enforceMobileSubtitleDefault();
  } else {
    if (bottomNav) bottomNav.classList.remove('show');
    closeMobileFilterSheet();
    if (header) header.classList.remove('mobile-collapsed');
  }
}

function setMobileHeaderCollapsed(collapsed) {
  var header = document.querySelector('.header');
  if (!header) return;
  if (!state.isMobile) {
    header.classList.remove('mobile-collapsed');
    return;
  }
  header.classList.toggle('mobile-collapsed', !!collapsed);
}

function openMobileFilterSheet() {
  if (!state.isMobile) return;
  var sheet = $('#mobileFilterSheet');
  var backdrop = $('#mobileFilterBackdrop');
  if (!sheet || !backdrop) return;
  var themeSel = $('#webThemeStyle');
  var mobileThemeSel = $('#mobileThemeStyleSelect');
  if (themeSel && mobileThemeSel) mobileThemeSel.value = themeSel.value;
  /* 桌面顶栏的强调色 / 背景基调同步进面板（两处是同一份状态的两张脸） */
  var accentSel = $('#webAccentSelect');
  var mobileAccentSel = $('#mobileAccentSelect');
  if (accentSel && mobileAccentSel) mobileAccentSel.value = accentSel.value;
  var bgSel = $('#webBackgroundSelect');
  var mobileBgSel = $('#mobileBackgroundSelect');
  if (bgSel && mobileBgSel) mobileBgSel.value = bgSel.value;
  var sortSel = $('#sortSelect');
  var mobileSortSel = $('#mobileSortSelect');
  if (sortSel && mobileSortSel) mobileSortSel.value = sortSel.value;
  // 初始化选项按钮状态
  document.querySelectorAll('#cardSizeButtons button').forEach(function (btn) {
    btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === state.cardSize);
  });
  document.querySelectorAll('#mediaFilterButtons button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.filter === state.mediaFilter);
  });
  sheet.style.transform = '';
  sheet.classList.add('show');
  backdrop.classList.add('show');
}

function closeMobileFilterSheet() {
  var sheet = $('#mobileFilterSheet');
  var backdrop = $('#mobileFilterBackdrop');
  if (sheet) sheet.style.transform = '';
  if (sheet) sheet.classList.remove('show');
  if (backdrop) backdrop.classList.remove('show');
}

/* ── 顶栏「外观」面板（2026-10-06）───────────────────────────────────────
   背景：外观五维（主题 / 强调色 / 背景 / 纹理 / 透明度）原先各有一个下拉平铺在
   顶栏，全条 11 个控件、换行位置由控件宽度**偶然**决定 —— 实测 1920 是 1 行、
   1440 是 2 行、1024 与 768 是 3 行（1024 那档第三行只剩一个控件）。缺的是
   信息层级。现在五维收进这个面板，顶栏剩下筛选 / 展示 / 外观 / 设置四组。

   面板与 .header **平级**（不能放进去：外壳层有 `.header > * { position: relative }`，
   会把这里的 fixed 定位改掉），位置只能在这里按按钮矩形算 —— 顶栏高度随断点变
   （72px，折行后更高），纯 CSS 拿不到那个值。 */
function positionAppearancePanel() {
  var panel = $('#headerAppearancePanel');
  var btn = $('#headerAppearanceBtn');
  if (!panel || !btn) return;
  var pw = panel.offsetWidth;
  var ph = panel.offsetHeight;
  if (!pw || !ph) return;
  var br = btn.getBoundingClientRect();
  var header = document.querySelector('.header');
  var hdr = header ? header.getBoundingClientRect() : null;
  var gapPx = 8;
  var edge = 12;
  /* 锚点是**顶栏下沿**，不是按钮下沿：按钮高 32px 而顶栏高 72px（折行档更高），
     按按钮算会让面板盖住顶栏底部一截（实测差 12px）。 */
  var top = (hdr ? hdr.bottom : br.bottom) + gapPx;
  if (top + ph > window.innerHeight - edge) {
    // 面板一律在顶栏**下方**展开；顶栏之上没有空间，放不下就贴视口底
    top = Math.max(edge, window.innerHeight - edge - ph);
  }
  // 右对齐按钮。面板(320)比按钮(68)宽得多，会向左伸 —— 越出左边界时改为贴左边。
  var right = Math.max(edge, window.innerWidth - br.right);
  if (window.innerWidth - right - pw < edge) {
    right = Math.max(edge, window.innerWidth - pw - edge);
  }
  panel.style.top = Math.round(top) + 'px';
  panel.style.right = Math.round(right) + 'px';
}

function toggleAppearancePanel() {
  var panel = $('#headerAppearancePanel');
  if (!panel) return;
  if (panel.classList.contains('show')) {
    closeAppearancePanel();
    return;
  }
  /* ⚠️ 必须先显示再定位：display: none 时 offsetWidth / offsetHeight 都是 0，
     量不到真实尺寸，定位会算错（面板会贴到视口左边）。 */
  panel.classList.add('show');
  var btn = $('#headerAppearanceBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  positionAppearancePanel();
}

function closeAppearancePanel() {
  var panel = $('#headerAppearancePanel');
  if (!panel || !panel.classList.contains('show')) return;
  panel.classList.remove('show');
  var btn = $('#headerAppearanceBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function isIosSafari() {
  var ua = navigator.userAgent || '';
  var isIOS = /iP(hone|od|ad)/.test(ua);
  var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIOS && isSafari;
}

function isStandaloneMode() {
  return (
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.navigator && window.navigator.standalone === true)
  );
}

function showToast(msg, duration) {
  var el = document.getElementById('webToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (el._toastTimer) clearTimeout(el._toastTimer);
  el._toastTimer = setTimeout(function () {
    el.classList.remove('show');
  }, duration || 2200);
}

function showInstallGuide() {
  if (isStandaloneMode()) {
    showToast('已安装到桌面，可直接在手机桌面打开。');
    return;
  }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(function () {
      deferredInstallPrompt = null;
    });
    return;
  }
  if (isIosSafari()) {
    showToast('请点击 Safari 底部"分享"按钮，然后选择"添加到主屏幕"。');
    return;
  }
  showToast('请点击浏览器右上角菜单，选择"安装应用"或"添加到主屏幕"。');
}

function bindEvents() {
  /* header 滚动效果 */
  var _pgEl = document.getElementById('photoGrid');
  var _headerEl = document.querySelector('.header');
  if (_pgEl && _headerEl) {
    _pgEl.addEventListener(
      'scroll',
      function () {
        _headerEl.classList.toggle('scrolled', _pgEl.scrollTop > 40);
      },
      { passive: true },
    );
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstallPrompt = e;
  });
  var themeSelect = $('#webThemeStyle');
  if (themeSelect) {
    themeSelect.addEventListener('change', function () {
      applyWebThemeStyle(themeSelect.value);
    });
  }
  var mobileFilterSheet = $('#mobileFilterSheet');
  if (mobileFilterSheet) {
    mobileFilterSheet.addEventListener(
      'touchstart',
      function (e) {
        if (!state.isMobile || !mobileFilterSheet.classList.contains('show')) return;
        if (!e.touches || e.touches.length !== 1) return;
        state.mobileFilterTouchStartY = e.touches[0].clientY;
        state.mobileFilterTouchDeltaY = 0;
      },
      { passive: true },
    );
    mobileFilterSheet.addEventListener(
      'touchmove',
      function (e) {
        if (!state.isMobile || !mobileFilterSheet.classList.contains('show')) return;
        if (!e.touches || e.touches.length !== 1) return;
        var dy = e.touches[0].clientY - state.mobileFilterTouchStartY;
        if (dy <= 0) return;
        state.mobileFilterTouchDeltaY = dy;
        mobileFilterSheet.style.transform = 'translateY(' + Math.min(dy, 140) + 'px)';
      },
      { passive: true },
    );
    mobileFilterSheet.addEventListener(
      'touchend',
      function () {
        if (!state.isMobile || !mobileFilterSheet.classList.contains('show')) return;
        if (state.mobileFilterTouchDeltaY > 72) {
          closeMobileFilterSheet();
          return;
        }
        mobileFilterSheet.style.transform = '';
      },
      { passive: true },
    );
    mobileFilterSheet.addEventListener(
      'touchcancel',
      function () {
        if (!state.isMobile || !mobileFilterSheet.classList.contains('show')) return;
        state.mobileFilterTouchDeltaY = 0;
        mobileFilterSheet.style.transform = '';
      },
      { passive: true },
    );
  }
  /* 顶栏外观面板：点面板外 / Esc / 视口变化都收起。
     面板是 fixed 定位、位置由按钮矩形算出来，视口一变就会浮在错位置 —— 必须收起重开。 */
  var appearancePanelEl = $('#headerAppearancePanel');
  if (appearancePanelEl) {
    document.addEventListener(
      'pointerdown',
      function (e) {
        if (!appearancePanelEl.classList.contains('show')) return;
        if (appearancePanelEl.contains(e.target)) return;
        var btn = $('#headerAppearanceBtn');
        if (btn && btn.contains(e.target)) return;
        closeAppearancePanel();
      },
      true,
    );
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !appearancePanelEl.classList.contains('show')) return;
      closeAppearancePanel();
      var btn = $('#headerAppearanceBtn');
      if (btn) btn.focus();
    });
    window.addEventListener('resize', closeAppearancePanel, { passive: true });
    // 组织元数据筛选面板：同一套三路收起（点外 / Esc / 视口变化）。
    // ⚠️ 面板是 fixed、位置按按钮矩形算，视口一变就会浮在错位置 —— 必须收起重开。
    var orgFilterPanelEl = $('#headerOrgFilterPanel');
    if (orgFilterPanelEl) {
      document.addEventListener(
        'pointerdown',
        function (e) {
          if (!orgFilterPanelEl.classList.contains('show')) return;
          if (orgFilterPanelEl.contains(e.target)) return;
          var orgBtn = $('#headerOrgFilterBtn');
          if (orgBtn && orgBtn.contains(e.target)) return;
          closeOrgFilterPanel();
        },
        true,
      );
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || !orgFilterPanelEl.classList.contains('show')) return;
        closeOrgFilterPanel();
        var orgBtn = $('#headerOrgFilterBtn');
        if (orgBtn) orgBtn.focus();
      });
      window.addEventListener('resize', closeOrgFilterPanel, { passive: true });
    }
    // capture 才收得到 .photo-grid 内部的滚动 —— 它才是真正的滚动容器，不冒泡到 window
    window.addEventListener('scroll', closeAppearancePanel, { passive: true, capture: true });
  }
  var searchOverlayInput = $('#searchOverlayInput');
  if (searchOverlayInput) {
    searchOverlayInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeSearchOverlay();
      } else if (e.key === 'Enter') {
        state.searchQuery = searchOverlayInput.value.trim();
        state.currentView = state.searchQuery ? 'search' : 'all';
        state.page = 1;
        loadPhotos();
        pushViewHistoryState();
        closeSearchOverlay();
      }
    });
  }
  var photoGridEl = $('#photoGrid');
  if (photoGridEl) {
    photoGridEl.addEventListener('scroll', function () {
      if (!state.isMobile) return;
      // comment cleaned
      setMobileHeaderCollapsed(false);
    });
  }

  // comment cleaned
  var glowRaf = 0;
  var glowClientX = 0;
  var glowClientY = 0;
  var glowTargetCard = null;
  document.addEventListener('mousemove', function (e) {
    if (state.isMobile) return;
    glowClientX = e.clientX;
    glowClientY = e.clientY;
    glowTargetCard = e.target && e.target.closest ? e.target.closest('.photo-card') : null;
    if (glowRaf) return;
    glowRaf = requestAnimationFrame(function () {
      glowRaf = 0;
      if (!glowTargetCard) return;
      var rect = glowTargetCard.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var x = ((glowClientX - rect.left) / rect.width) * 100;
      var y = ((glowClientY - rect.top) / rect.height) * 100;
      glowTargetCard.style.setProperty('--mouse-x', x + '%');
      glowTargetCard.style.setProperty('--mouse-y', y + '%');
    });
  });

  // comment cleaned
  var img = $('#previewImage');
  if (img) {
    img.addEventListener('dblclick', function (e) {
      e.preventDefault();
      resetZoom();
    });

    img.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      state.isDragging = true;
      state.hasDragged = false;
      state.dragStartX = e.clientX;
      state.dragStartY = e.clientY;
      state.dragStartPanX = state.panX;
      state.dragStartPanY = state.panY;
      img.classList.add('dragging');
      e.preventDefault();
    });

    // comment cleaned
    img.addEventListener(
      'touchstart',
      function (e) {
        if (e.touches.length === 1) {
          var t = e.touches[0];
          state.isDragging = true;
          state.hasDragged = false;
          state.isSwiping = false;
          state.swipeDirection = null;
          state.dragStartX = t.clientX;
          state.dragStartY = t.clientY;
          state.touchStartX = t.clientX;
          state.touchStartY = t.clientY;
          state.touchStartTime = Date.now();
          state.dragStartPanX = state.panX;
          state.dragStartPanY = state.panY;
        } else if (e.touches.length === 2) {
          // comment cleaned
          state.isDragging = false;
          state.hasDragged = false;
          var dx = e.touches[0].clientX - e.touches[1].clientX;
          var dy = e.touches[0].clientY - e.touches[1].clientY;
          state.touchStartDist = Math.sqrt(dx * dx + dy * dy);
          state.touchStartZoom = state.zoom;
        }
      },
      { passive: true },
    );
  }

  document.addEventListener('mousemove', function (e) {
    if (!state.isDragging) return;
    var dx = e.clientX - state.dragStartX;
    var dy = e.clientY - state.dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.hasDragged = true;
    if (state.hasDragged) {
      state.panX = state.dragStartPanX + dx;
      state.panY = state.dragStartPanY + dy;
      updatePreviewTransform();
    }
  });

  document.addEventListener(
    'touchmove',
    function (e) {
      if (state.isDragging && e.touches.length === 1) {
        var t = e.touches[0];
        var dx = t.clientX - state.dragStartX;
        var dy = t.clientY - state.dragStartY;
        var absDx = Math.abs(dx);
        var absDy = Math.abs(dy);

        // comment cleaned
        if (!state.swipeDirection && (absDx > 10 || absDy > 10)) {
          state.swipeDirection = absDx > absDy ? 'horizontal' : 'vertical';
        }

        // comment cleaned
        if (state.swipeDirection === 'horizontal' && state.zoom <= 1.05) {
          state.isSwiping = true;
          // comment cleaned
          state.panX = dx * 0.3;
          updatePreviewTransform();
          return;
        }

        if (absDx > 5 || absDy > 5) state.hasDragged = true;
        if (state.hasDragged) {
          state.panX = state.dragStartPanX + dx;
          state.panY = state.dragStartPanY + dy;
          updatePreviewTransform();
        }
      } else if (e.touches.length === 2 && state.touchStartDist > 0) {
        // comment cleaned
        var pinchDx = e.touches[0].clientX - e.touches[1].clientX;
        var pinchDy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(pinchDx * pinchDx + pinchDy * pinchDy);
        var scale = dist / state.touchStartDist;
        state.zoom = Math.min(10, Math.max(0.2, state.touchStartZoom * scale));
        updatePreviewTransform();
      }
    },
    { passive: true },
  );

  document.addEventListener('mouseup', function () {
    if (state.isDragging) {
      state.isDragging = false;
      if (img) img.classList.remove('dragging');
      if (!state.hasDragged) zoomToActual();
    }
  });

  document.addEventListener('touchend', function () {
    if (state.isDragging) {
      state.isDragging = false;
      if (state.isSwiping) {
        // comment cleaned
        var swipeDx = state.panX;
        if (swipeDx < -60) {
          navigatePreview(1);
        } else if (swipeDx > 60) {
          navigatePreview(-1);
        } else {
          // comment cleaned
          state.panX = 0;
          updatePreviewTransform();
        }
        state.isSwiping = false;
      } else if (!state.hasDragged) {
        // comment cleaned
        if (!state.isMobile) zoomToActual();
      }
    }
    // comment cleaned
    state.touchStartDist = 0;
  });

  var previewOverlayEl = $('#previewOverlay');
  if (previewOverlayEl) {
    previewOverlayEl.addEventListener(
      'wheel',
      function (e) {
        if (!previewOverlayEl.classList.contains('active')) return;
        var zooming = e.ctrlKey || e.metaKey;
        // 🔴 与桌面端 ui-events.js 同口径（两端镜面，改一处必须同改另一处）：
        //    浮层内的可滚动面板（图片信息 / 字幕设置）先吃掉滚轮 —— 不 preventDefault、不切图，
        //    面板滚到边界后仍旧落下去切换图片。
        if (!zooming) {
          var host =
            e.target && e.target.closest
              ? e.target.closest('.preview-info-panel, .preview-subtitle-settings-panel')
              : null;
          if (host) {
            var down = e.deltaY > 0;
            var atTop = host.scrollTop <= 0;
            var atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 1;
            if (down ? !atBottom : !atTop) return;
          }
        }
        e.preventDefault();
        if (zooming) {
          var delta = e.deltaY > 0 ? -0.15 : 0.15;
          applyZoom(delta);
        } else {
          if (e.deltaY > 20) navigatePreview(1);
          else if (e.deltaY < -20) navigatePreview(-1);
        }
      },
      { passive: false },
    );

    previewOverlayEl.addEventListener('click', function (e) {
      if (e.target === previewOverlayEl) guardedClosePreview();
    });

    // 全屏下鼠标一动就唤出全部浮层控件（静止约 1.1s 后统一收起）。
    // 移动端没有鼠标，走 mobile-nav-visible 那条老路，这里直接跳过。
    previewOverlayEl.addEventListener('mousemove', function (e) {
      if (state.isMobile) return;
      if (!previewOverlayEl.classList.contains('is-fullscreen')) return;
      revealPreviewFullscreenUiOnMove(e.target);
    });
    previewOverlayEl.addEventListener('mouseleave', function () {
      if (!previewOverlayEl.classList.contains('is-fullscreen')) return;
      previewFsUiPointerOverControls = false;
      schedulePreviewFullscreenUiHide(180);
    });
  }
  var previewBody = document.querySelector('.preview-body');
  if (previewBody) {
    previewBody.addEventListener('click', function (e) {
      if (!state.isMobile) return;
      if (!$('#previewOverlay').classList.contains('active')) return;
      var t = e.target;
      if (
        t.closest('.preview-nav') ||
        t.closest('.preview-slideshow-controls') ||
        t.closest('.preview-close') ||
        t.closest('.preview-info-panel') ||
        t.closest('.preview-info-toggle') ||
        t.closest('.preview-zoom-box')
      ) {
        return;
      }
      // comment cleaned
      if (t.closest('.preview-img') || t.closest('.preview-loading')) {
        var now = Date.now();
        // comment cleaned
        if (now - state.previewLastTapAt < 280) {
          if (state.zoom > 1.05) resetZoom();
          else zoomToActual();
          state.previewLastTapAt = 0;
          return;
        }
        state.previewLastTapAt = now;
        setMobilePreviewNavVisible(true);
      }
    });
    previewBody.addEventListener(
      'touchstart',
      function (e) {
        if (!state.isMobile) return;
        if (!$('#previewOverlay').classList.contains('active')) return;
        if (!e.touches || e.touches.length !== 1) return;
        var t = e.target;
        if (
          t.closest('.preview-slideshow-controls') ||
          t.closest('.preview-close') ||
          t.closest('.preview-info-panel') ||
          t.closest('.preview-info-toggle') ||
          t.closest('.preview-nav') ||
          t.closest('.preview-zoom-box') ||
          t.closest('.preview-video')
        ) {
          state.previewBodyTouchActive = false;
          return;
        }
        state.previewBodyTouchActive = true;
        state.previewBodyTouchStartX = e.touches[0].clientX;
        state.previewBodyTouchStartY = e.touches[0].clientY;
        state.previewBodyTouchDy = 0;
      },
      { passive: true },
    );
    previewBody.addEventListener(
      'touchmove',
      function (e) {
        if (!state.previewBodyTouchActive) return;
        if (!e.touches || e.touches.length !== 1) return;
        if (state.zoom > 1.05) return;
        var dx = e.touches[0].clientX - state.previewBodyTouchStartX;
        var dy = e.touches[0].clientY - state.previewBodyTouchStartY;
        if (Math.abs(dy) < Math.abs(dx) * 1.8) return;
        if (dy <= 0) return;
        state.previewBodyTouchDy = dy;
        previewBody.style.transform = 'translateY(' + Math.min(dy, 180) + 'px)';
        previewBody.style.opacity = String(Math.max(0.45, 1 - dy / 260));
      },
      { passive: true },
    );
    previewBody.addEventListener(
      'touchend',
      function () {
        if (!state.previewBodyTouchActive) return;
        state.previewBodyTouchActive = false;
        if (state.previewBodyTouchDy > 96 && state.zoom <= 1.05) {
          previewBody.style.transform = '';
          previewBody.style.opacity = '';
          guardedClosePreview();
          return;
        }
        previewBody.style.transform = '';
        previewBody.style.opacity = '';
        state.previewBodyTouchDy = 0;
      },
      { passive: true },
    );
  }
  if (previewOverlayEl) {
    previewOverlayEl.addEventListener(
      'touchstart',
      function (e) {
        if (!state.isMobile) return;
        if (!previewOverlayEl.classList.contains('active')) return;
        if (!e.touches || e.touches.length !== 1) return;
        var target = e.target;
        if (
          target.closest('.preview-slideshow-controls') ||
          target.closest('.preview-close') ||
          target.closest('.preview-info-panel') ||
          target.closest('.preview-info-toggle')
        ) {
          state.previewOverlaySwiping = false;
          return;
        }
        // 允许在图片区域滑动切换，只在缩放时禁止
        state.previewOverlaySwiping = true;
        state.previewOverlaySwipeStartX = e.touches[0].clientX;
        state.previewOverlaySwipeStartY = e.touches[0].clientY;
      },
      { passive: true },
    );
    previewOverlayEl.addEventListener(
      'touchend',
      function (e) {
        if (!state.previewOverlaySwiping) return;
        state.previewOverlaySwiping = false;
        if (!e.changedTouches || e.changedTouches.length === 0) return;
        // 图片放大后，用户可能是在拖动看细节，不触发切换
        if (state.zoom > 1.05) return;
        var dx = e.changedTouches[0].clientX - state.previewOverlaySwipeStartX;
        var dy = e.changedTouches[0].clientY - state.previewOverlaySwipeStartY;
        var absDx = Math.abs(dx);
        var absDy = Math.abs(dy);
        // 降低阈值，放宽判断，让滑动更灵敏
        // 30px 即可触发，允许稍微偏垂直一点的滑动
        if (absDx >= 30 && absDx > absDy * 0.8) {
          navigatePreview(dx < 0 ? 1 : -1);
        }
      },
      { passive: true },
    );
  }

  document.addEventListener('keydown', function (e) {
    var previewOverlayEl2 = $('#previewOverlay');
    if (previewOverlayEl2 && previewOverlayEl2.classList.contains('active')) {
      // Ctrl/Cmd+S = 保存预览态编辑（「预览里改的东西」的唯一写回出口，
      // 与桌面端 `shortcuts.js#preview.editSave` 同一个手势）。必须在 `Escape` 之前
      // 拦下并 preventDefault —— 否则浏览器会弹「保存网页」对话框。
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        savePreviewEdit();
        return;
      }
      if (e.key === 'Escape') guardedClosePreview();
      if (e.key === 'ArrowLeft') navigatePreview(-1);
      if (e.key === 'ArrowRight') navigatePreview(1);
      if (e.key === ' ') {
        e.preventDefault();
        // 幻灯片一旦跑起来就会自动换图 ⇒ 待保存的编辑会被无声丢掉，先问一句
        guardPendingPreviewEdit(function () {
          toggleSlideshow();
        });
      }
      if (e.key === '0') resetZoom();
      if (e.key === '+' || e.key === '=') applyZoom(0.25);
      if (e.key === '-') applyZoom(-0.25);
    }
  });

  var intervalSelect = $('#slideshowIntervalSelect');
  if (intervalSelect) {
    intervalSelect.addEventListener('change', function () {
      var sec = parseInt(intervalSelect.value, 10);
      state.slideshowIntervalSec = isNaN(sec) ? 3 : sec;
      if (state.slideshowPlaying) restartSlideshowTimer();
    });
  }
  var sidebarTabsEl = document.querySelector('.sidebar-tabs');
  if (sidebarTabsEl) {
    sidebarTabsEl.addEventListener('click', function (e) {
      var tabEl = e.target && e.target.closest ? e.target.closest('.sidebar-tab[data-tab]') : null;
      if (!tabEl) return;
      var tab = tabEl.getAttribute('data-tab');
      if (tab) switchTab(tab);
    });
  }
  syncSlideshowRandomButton();
  document.addEventListener('fullscreenchange', function () {
    syncFullscreenButton();
    syncPreviewFullscreenChrome();
  });

  // comment cleaned
  var sidebarContentEl = $('#sidebarContent');
  if (sidebarContentEl) {
    sidebarContentEl.addEventListener('click', function (e) {
      var actionEl = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (actionEl) {
        var action = actionEl.getAttribute('data-action');
        if (action === 'view-all') {
          viewAllPhotos();
          return;
        }
        if (action === 'view-folder-overview') {
          viewFolderOverview();
          return;
        }
        if (action === 'view-root') {
          var rootId = parseInt(actionEl.getAttribute('data-root-id'), 10);
          if (!isNaN(rootId)) viewRootFolder(rootId);
          return;
        }
        if (action === 'toggle-root') {
          var rootId2 = parseInt(actionEl.getAttribute('data-root-id'), 10);
          if (!isNaN(rootId2)) toggleTreeRoot(actionEl, e, rootId2);
          return;
        }
        if (action === 'toggle-node') {
          toggleTreeNode(actionEl, e);
          return;
        }
        if (action === 'date-sort') {
          var dso = actionEl.getAttribute('data-date-sort') || 'desc';
          if (dso !== 'asc' && dso !== 'desc') dso = 'desc';
          if (state.dateGroupsSortOrder === dso) return;
          state.dateGroupsSortOrder = dso;
          try {
            localStorage.setItem('dateGroupsSortOrder', dso);
          } catch (eDs) {}
          if (state.currentTab === 'dates') loadDateGroups();
          return;
        }
      }
      var item = e.target.closest('.folder-item[data-folder-path]');
      if (item) {
        viewFolder(item.getAttribute('data-folder-path'));
        // comment cleaned
        if (state.isMobile) {
          setTimeout(function () {
            var sidebarEl = $('#sidebar');
            var backdropEl = $('#mobileBackdrop');
            if (sidebarEl) sidebarEl.classList.remove('mobile-show');
            if (backdropEl) backdropEl.classList.remove('show');
            document.querySelectorAll('.mobile-nav-item').forEach(function (navItem) {
              navItem.classList.toggle('active', navItem.dataset.tab === 'browse');
            });
            state.mobileNavTab = 'browse';
          }, 100);
        }
      }
      var dateItem = e.target.closest('.date-group[data-date]');
      if (dateItem) {
        var dateStr = dateItem.getAttribute('data-date');
        if (dateStr) viewDate(dateStr);
      }
    });
  }

  // comment cleaned
  var photoGridEl2 = $('#photoGrid');
  if (photoGridEl2) {
    photoGridEl2.addEventListener('click', function (e) {
      var card =
        e.target && e.target.closest ? e.target.closest('.folder-card[data-folder-path]') : null;
      if (card) {
        var p = card.getAttribute('data-folder-path');
        if (p) viewFolder(p);
      }
    });
  }

  // comment cleaned
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      detectMobile();
      if (window.innerWidth > 600) {
        var sidebarEl2 = $('#sidebar');
        var backdropEl2 = $('#mobileBackdrop');
        if (sidebarEl2) sidebarEl2.classList.remove('mobile-show');
        if (backdropEl2) backdropEl2.classList.remove('show');
      }
    }, 150);
  });
  window.addEventListener('popstate', function (e) {
    var overlay = $('#previewOverlay');
    var isPreviewActive = !!(overlay && overlay.classList.contains('active'));
    var nextStateIsPreview = !!(e && e.state && e.state.previewOpen);
    if (isPreviewActive && !nextStateIsPreview) {
      closePreview(true);
    }
    if (e && e.state) {
      applyHistoryStateToView(e.state);
      return;
    }
    applyHistoryStateToView({ currentView: 'all' });
  });

  /* 无限滚动：分页栏进入视口时自动加载下一页 */
  var paginationEl = $('#pagination');
  if (paginationEl && photoGridEl && 'IntersectionObserver' in window) {
    var infiniteLoading = false;
    state._infiniteScrollObserver = new window.IntersectionObserver(
      function (entries) {
        if (
          entries[0].isIntersecting &&
          state.page < state.previewTotalPages &&
          !infiniteLoading &&
          !state.isRefreshing
        ) {
          infiniteLoading = true;
          state.page++;
          loadPhotos().finally(function () {
            infiniteLoading = false;
          });
        }
      },
      { root: photoGridEl, rootMargin: '200px', threshold: 0 },
    );
    state._infiniteScrollObserver.observe(paginationEl);
  }

  // 右键菜单：委托到 photoGrid
  var photoGridEl3 = $('#photoGrid');
  if (photoGridEl3) {
    photoGridEl3.addEventListener('contextmenu', function (e) {
      var card = e.target.closest('.photo-card:not(.folder-card)');
      if (!card) return;
      var cards = Array.from(photoGridEl3.querySelectorAll('.photo-card:not(.folder-card)'));
      var idx = cards.indexOf(card);
      if (idx < 0) return;
      // 换算为 currentPhotos 里的索引（需跳过子目录卡片）
      var allCards = Array.from(photoGridEl2.querySelectorAll('.photo-card'));
      var folderCardCount = photoGridEl2.querySelectorAll('.photo-card.folder-card').length;
      var realIdx = allCards.indexOf(card) - folderCardCount;
      if (realIdx < 0) return;
      showContextMenu(e, realIdx);
    });
  }
  bindContextMenu();
}

// === Mobile ===
function toggleMobileSidebar() {
  var sb = $('#sidebar');
  var bd = $('#mobileBackdrop');
  if (sb) sb.classList.toggle('mobile-show');
  if (bd) bd.classList.toggle('show');
}

// comment cleaned
function mobileNavSwitch(tab) {
  state.mobileNavTab = tab;
  closeMobileFilterSheet();
  setMobileHeaderCollapsed(false);

  // comment cleaned
  document.querySelectorAll('.mobile-nav-item').forEach(function (item) {
    item.classList.toggle('active', item.dataset.tab === tab);
  });

  // comment cleaned
  var sb = $('#sidebar');
  var bd = $('#mobileBackdrop');
  if (sb) sb.classList.remove('mobile-show');
  if (bd) bd.classList.remove('show');

  if (tab === 'browse') {
    viewAllPhotos();
  } else if (tab === 'folders') {
    // comment cleaned
    var wasAiFolders = exitWebAiViewChrome();
    state.currentTab = 'folders';
    document.querySelectorAll('.sidebar-tab').forEach(function (t) {
      t.classList.remove('active');
    });
    var folderTab = document.querySelector('.sidebar-tab[data-tab="folders"]');
    if (folderTab) folderTab.classList.add('active');
    if (wasAiFolders) loadPhotos();
    loadRootFolders();
    sb.classList.add('mobile-show');
    bd.classList.add('show');
  } else if (tab === 'dates') {
    // comment cleaned
    var wasAiDates = exitWebAiViewChrome();
    state.currentTab = 'dates';
    document.querySelectorAll('.sidebar-tab').forEach(function (t) {
      t.classList.remove('active');
    });
    var dateTab = document.querySelector('.sidebar-tab[data-tab="dates"]');
    if (dateTab) dateTab.classList.add('active');
    if (wasAiDates) loadPhotos();
    loadDateGroups();
    sb.classList.add('mobile-show');
    bd.classList.add('show');
  } else if (tab === 'search') {
    openSearchOverlay();
  }
}

function openSearchOverlay() {
  var overlay = $('#searchOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  var input = $('#searchOverlayInput');
  if (input) {
    input.value = state.searchQuery || '';
    setTimeout(function () {
      input.focus();
    }, 50);
  }
  // 激活底部导航搜索图标
  document.querySelectorAll('.mobile-nav-item').forEach(function (item) {
    item.classList.toggle('active', item.dataset.tab === 'search');
  });
}

function closeSearchOverlay() {
  var overlay = $('#searchOverlay');
  if (overlay) overlay.classList.remove('show');
}

// comment cleaned
function initPullRefresh() {
  var grid = $('#photoGrid');
  var indicator = $('#pullRefreshIndicator');
  if (!grid || !indicator) return;

  grid.addEventListener(
    'touchstart',
    function (e) {
      if (state.isRefreshing) return;
      // comment cleaned
      if (grid.scrollTop <= 0) {
        state.pullStartY = e.touches[0].clientY;
        state.isPulling = true;
      }
    },
    { passive: true },
  );

  grid.addEventListener(
    'touchmove',
    function (e) {
      if (!state.isPulling || state.isRefreshing) return;
      var currentY = e.touches[0].clientY;
      var pullDistance = currentY - state.pullStartY;

      // comment cleaned
      if (pullDistance > 60 && grid.scrollTop <= 0) {
        indicator.classList.add('show');
      }
    },
    { passive: true },
  );

  grid.addEventListener(
    'touchmove',
    function (e) {
      if (!state.isPulling || state.isRefreshing) return;
      var currentY = e.touches[0].clientY;
      var pullDistance = currentY - state.pullStartY;

      if (pullDistance > 0 && grid.scrollTop <= 0) {
        var progress = Math.min(pullDistance / 80, 1);
        indicator.style.display = 'block';
        indicator.style.opacity = String(progress);
        indicator.style.transform = 'translateX(-50%) rotate(' + progress * 360 + 'deg)';
        if (pullDistance > 60) {
          indicator.classList.add('show');
        }
      }
    },
    { passive: true },
  );

  grid.addEventListener(
    'touchend',
    function () {
      if (!state.isPulling) return;
      state.isPulling = false;

      if (indicator.classList.contains('show')) {
        state.isRefreshing = true;
        loadPhotos().then(function () {
          state.isRefreshing = false;
          indicator.classList.remove('show');
          indicator.style.display = '';
          indicator.style.opacity = '';
          indicator.style.transform = '';
        });
      } else {
        indicator.style.display = '';
        indicator.style.opacity = '';
        indicator.style.transform = '';
      }
    },
    { passive: true },
  );

  grid.addEventListener(
    'touchcancel',
    function () {
      state.isPulling = false;
      var indicator = $('#pullRefreshIndicator');
      if (indicator) {
        indicator.classList.remove('show');
        indicator.style.display = '';
        indicator.style.opacity = '';
        indicator.style.transform = '';
      }
    },
    { passive: true },
  );
}

// === Stats ===
function compactLibraryStats(stats) {
  var total = Number(stats && stats.totalPhotos) || 0;
  var videos = Number(stats && stats.videoPhotos) || 0;
  var size = Number(stats && stats.totalSize) || 0;
  // 🔴 与桌面端 `stillPhotoCount` 同口径：`totalPhotos` 是 COUNT(*)，**含视频行**，
  //    不减就会出现「图片 1,656,580」比实际图片数多出 26,609 个视频。
  //    桌面端改了这里必须跟着改（两份实现，没有共享模块）。
  var photos = Math.max(0, total - videos);
  var parts = ['图片 ' + formatNumber(photos)];
  if (videos > 0) parts.push('视频 ' + formatNumber(videos));
  if (size > 0) parts.push(formatSize(size));
  return parts.join(' · ');
}

function compactFolderStats(subfolderCount, photoCount, videoCount) {
  var folders = Number(subfolderCount) || 0;
  var photos = Number(photoCount) || 0;
  var videos = Number(videoCount) || 0;
  var parts = [];
  if (folders > 0) parts.push('文件夹 ' + formatNumber(folders));
  // 同 `compactLibraryStats`：`photoCount` 是该作用域 COUNT(*)（含视频），扣掉视频才是图片数。
  parts.push('图片 ' + formatNumber(Math.max(0, photos - videos)));
  if (videos > 0) parts.push('视频 ' + formatNumber(videos));
  return parts.join(' · ');
}

async function loadStats() {
  var stats = await apiGet('/api/stats');
  state.stats = stats || null;
  if (stats.totalPhotos > 0) {
    setText('#headerStats', compactLibraryStats(stats));
  }
}

// === Tab switching ===
/**
 * 智能视图（搜图 / 人物）适配层实例，在文件末尾装配。
 * 侧栏负责入口，结果直接灌进 #photoGrid，因此预览翻页/幻灯片/收藏/选择全部复用浏览链路。
 */
var webAiViews = null;

function isWebAiView() {
  return state.currentView === 'ai_search' || state.currentView === 'people';
}

/**
 * 标签导航页的界面层实例（文件末尾装配）。侧栏三级树 + 主区卡片，
 * 照片网格与预览复用既有浏览链路 —— 与桌面端同一条分工（父节点只做下钻不给网格）。
 */
var webTagNav = null;

function isTagView() {
  return state.currentView === 'tag';
}

/** 标签页的标题栏：选中标签时显示它的**显示名**（与侧栏那一行、信息面板同源）。 */
function updateTagViewHeader() {
  var ht = $('#headerTitle');
  if (!ht) return;
  if (state.currentTag) {
    var label = webTagNav ? webTagNav.displayName(state.currentTag) : state.currentTag;
    ht.textContent = '\uD83C\uDFF7\uFE0F ' + label;
  } else {
    ht.textContent = '\uD83C\uDFF7\uFE0F ' + '\u6807\u7B7E';
  }
}

/** 装配标签导航页界面层（首次进入标签页时）。 */
function webTagNavEnter() {
  webTagNav = window.WebTagNav.init({
    state: state,
    get: apiGet,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    // 选中标签 / 换节点 / 搜索态变化 ⇒ 统一交给 loadPhotos 走既有通路
    // （它自己分流到照片网格或标签卡片）。
    onPhotosChanged: function () {
      void loadPhotos();
    },
    // 标签名按 locale 异步到达之后，标题栏要补一次
    onChromeRefresh: updateTagViewHeader,
  });
}

/**
 * 只有「文件夹」页用文件夹树侧栏；「日期」有自己的侧栏形态，而「搜图 / 人物」
 * 改造后是侧栏独占（侧栏放搜索框 + 历史 / 人物列表），都不应放宽到文件夹树侧栏。
 */
function isFolderSidebarTab(tab) {
  return tab === 'folders';
}

/** 侧栏两态：文件夹 / 日期列表（#sidebarContent）与智能视图独占内容（#aiSidebar）。 */
function showBrowseSidebar() {
  setDisplay('#sidebarContent', '');
  setDisplay('#aiSidebar', 'none');
}
function showAiSidebar() {
  setDisplay('#sidebarContent', 'none');
  setDisplay('#aiSidebar', '');
}

/** 进入搜图 / 人物：同步侧栏页签与视图态，再交给适配层渲染。 */
function enterWebAiView(view) {
  state.currentTab = view;
  state.currentView = view;
  state.currentPath = '';
  state.currentDate = '';
  state.searchQuery = '';
  state.page = 1;
  setMobileHeaderCollapsed(false);
  document.querySelectorAll('.sidebar-tab').forEach(function (t) {
    t.classList.remove('active');
  });
  var tabEl = document.querySelector('.sidebar-tab[data-tab="' + view + '"]');
  if (tabEl) tabEl.classList.add('active');
  document
    .querySelectorAll('#sidebarContent .folder-item.active, #sidebarContent .date-group.active')
    .forEach(function (el) {
      el.classList.remove('active');
    });
  // 侧栏独占：隐藏文件夹 / 日期列表，把侧栏让给搜索框 + 历史 / 人物列表。
  showAiSidebar();
  // 🔴 进 AI 视图前**先 leave()**，与桌面端 `showTabContent` 首行那句 `aiViews.leave()`
  //    同口径。少了这一句，AI 视图之间的切换（搜图 ⇄ 人物）不会给保留态打上
  //    「离开过一次」的标记，于是「从搜图去看了下人物、再回搜图」会**重跑一遍搜索**
  //    （闪骨架、并把结果页缩回第一页），而「点结果里的目录跳进目录再回来」却能保留 ——
  //    同一条诉求在两条路上表现不一致。
  if (webAiViews) webAiViews.leave();
  if (webAiViews) webAiViews.enter(view);
  void loadPhotos();
}

/**
 * 离开「独占侧栏的特殊视图」（搜图 / 人物 / 标签）时收掉各自的侧栏与 chrome。
 * 返回 true 表示确实处于其中之一，调用方可据此补一次浏览列表加载。
 *
 * 🔴 标签页**也在这里收**：它同样独占 #sidebarContent（标签树会盖掉文件夹 / 日期列表）。
 *    不收的话，从标签页点进某个文件夹，侧栏还停在标签树、页签还高亮着「标签」，
 *    而内容已经是目录列表 —— 三处各说各话。
 */
function exitWebAiViewChrome() {
  var wasTag = webTagNav && webTagNav.isShowing();
  var wasAi = webAiViews && webAiViews.isShowing();
  if (!wasTag && !wasAi) return false;
  if (wasTag) {
    webTagNav.leave();
    // 选中态一并清掉：这是「离开标签页」，回来时按新落点画，不保留旧标签
    state.currentTag = '';
    state.currentTagNode = '';
    state.currentTagNodeKind = '';
    state.currentPhotos = [];
    state.currentView = 'all';
  }
  if (wasAi) {
    webAiViews.leave();
    state.currentView = 'all';
    state.currentPhotos = [];
  }
  showBrowseSidebar();
  var ht = $('#headerTitle');
  if (ht) ht.textContent = '\u62C2\u6653\u56FE\u5E93 \u00B7 Aurora Gallery';
  return true;
}

/**
 * 从搜图 / 人物退回浏览：点侧栏的文件夹 / 日期 / 全部图片时走各自入口、不经 switchTab，
 * 这里一并把侧栏页签的高亮收回，免得内容已经换了、页签还停在「搜图」。
 */
function leaveWebAiViewForBrowse(tab) {
  if (!exitWebAiViewChrome()) return;
  state.currentTab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(function (t) {
    t.classList.toggle('active', (t.dataset.tab || '') === tab);
  });
}

function switchTab(tab) {
  if (tab === 'ai_search' || tab === 'people') {
    enterWebAiView(tab);
    // 手机上侧栏是抽屉：选完即收起，把结果网格让出来。
    if (window.innerWidth <= 600) {
      var sbAi = $('#sidebar');
      var bdAi = $('#mobileBackdrop');
      if (sbAi) sbAi.classList.remove('mobile-show');
      if (bdAi) bdAi.classList.remove('show');
      document.querySelectorAll('.mobile-nav-item').forEach(function (item) {
        item.classList.toggle('active', item.dataset.tab === 'browse');
      });
      state.mobileNavTab = 'browse';
    }
    return;
  }
  // 标签导航页：走浏览外壳（#sidebarContent + #photoGrid），但侧栏内容由 webTagNav 画。
  // 与桌面端 `showTabContent` 的 tags 分支同构：选中态有值就还原，否则清掉重来。
  if (tab === 'tags') {
    var wasTagNav = exitWebAiViewChrome();
    state.currentTab = 'tags';
    state.currentView = 'tag';
    setMobileHeaderCollapsed(false);
    showBrowseSidebar();
    document.querySelectorAll('.sidebar-tab').forEach(function (t) {
      t.classList.toggle('active', (t.dataset.tab || '') === 'tags');
    });
    if (!webTagNav) webTagNavEnter();
    if (webTagNav) void webTagNav.enter();
    if (wasTagNav || webAiViews) void loadPhotos();
    if (window.innerWidth <= 600) {
      toggleMobileSidebar();
      document.querySelectorAll('.mobile-nav-item').forEach(function (item) {
        item.classList.toggle('active', item.dataset.tab === 'browse');
      });
      state.mobileNavTab = 'browse';
    }
    return;
  }
  var wasAi = exitWebAiViewChrome();
  state.currentTab = tab;
  setMobileHeaderCollapsed(false);
  showBrowseSidebar();
  document.querySelectorAll('.sidebar-tab').forEach(function (t) {
    t.classList.remove('active');
  });
  var tabEl = document.querySelector('.sidebar-tab[data-tab="' + tab + '"]');
  if (tabEl) tabEl.classList.add('active');

  if (tab === 'folders') loadRootFolders();
  else loadDateGroups();

  if (wasAi) loadPhotos();

  // comment cleaned
  if (window.innerWidth <= 600) {
    toggleMobileSidebar();
    // comment cleaned
    document.querySelectorAll('.mobile-nav-item').forEach(function (item) {
      item.classList.toggle('active', item.dataset.tab === 'browse');
    });
    state.mobileNavTab = 'browse';
  }
}

function showSidebarLoadingPlaceholder(hintText) {
  var sc = $('#sidebarContent');
  if (!sc) return;
  var hint = hintText || '\u6B63\u5728\u52A0\u8F7D\u76EE\u5F55\u2026';
  var html =
    '<div class="sidebar-loading" role="status" aria-live="polite">' +
    '<div class="sidebar-loading-hint">' +
    '<span class="sidebar-loading-spinner" aria-hidden="true"></span>' +
    '<span>' +
    hint +
    '</span>' +
    '</div>';
  for (var r = 0; r < 8; r++) {
    html += '<div class="sidebar-skeleton-row" style="--r:' + r + '"></div>';
  }
  html += '</div>';
  sc.innerHTML = html;
}

// === Sidebar: Folders ===
/** 与桌面端一致：避免连续 hydrate 与重新 loadRootFolders 互相覆盖 */
var webRootFoldersHydrateGen = 0;

/* 目录树缩进口径 —— **必须与 `src/renderer/sidebar-tree.js` 逐字段相同**
   （守护：`sidebar-tree-regression` 的「两端同口径」一节）。样式在两端共用的
   `src/web/css/gallery-design.css`，那里有完整的口径说明。
   父行 `12 + 14d`（自带 18px 箭头槽 + 8px 行 gap），叶子行补满槽宽 + gap
   才能与同级父行的 `.name` 左缘对齐；导线画在父行箭头槽中心。 */
var TREE_INDENT_BASE = 12;
var TREE_INDENT_STEP = 14;
var TREE_TOGGLE_SLOT = 18;
var TREE_ROW_GAP = 8;

/** depth 层「父行」的缩进量 */
function treeRowIndent(depth) {
  return TREE_INDENT_BASE + depth * TREE_INDENT_STEP;
}

/** depth 层「叶子行」的缩进量（补满箭头槽 + 间距，与同级父行的名字对齐） */
function treeLeafIndent(depth) {
  return treeRowIndent(depth) + TREE_TOGGLE_SLOT + TREE_ROW_GAP;
}

/** depth 层节点的子层导线 x：画在该节点箭头槽的中心 */
function treeGuideX(depth) {
  return treeRowIndent(depth) + Math.floor(TREE_TOGGLE_SLOT / 2);
}

/** 展开态动画时长（与 gallery-design.css 的 `.is-opening` 对齐） */
var TREE_OPEN_ANIM_MS = 220;

/** 打开/关闭一个子层容器：类名 + 行内 display 双写，箭头随容器翻转。
    与桌面端 `openTreeChildren()/closeTreeChildren()` 同一契约（去掉懒物化那部分）。 */
function setTreeChildrenOpen(children, toggle, open, animate) {
  if (!children) return;
  children.style.display = open ? 'block' : 'none';
  if (open) children.classList.add('expanded');
  else children.classList.remove('expanded');
  if (toggle) {
    if (open) toggle.classList.add('is-expanded');
    else toggle.classList.remove('is-expanded');
  }
  if (!open || animate === false) {
    children.classList.remove('is-opening');
    return;
  }
  // 重开一次要能重播：先摘掉再强制 reflow，否则连续展开只有第一次有动画
  children.classList.remove('is-opening');
  void children.offsetWidth;
  children.classList.add('is-opening');
  setTimeout(function () {
    children.classList.remove('is-opening');
  }, TREE_OPEN_ANIM_MS);
}

/** 子层容器标记：关闭态 = 没有 `.expanded`（+ 行内 display:none） */
function treeChildrenAttrs(depth) {
  return 'class="tree-children" style="display:none;--tree-guide-x:' + treeGuideX(depth) + 'px;"';
}

function formatRootFolderCount(n) {
  if (n == null || n === '') return '\u2014';
  return formatNumber(n);
}

function renderRootFoldersSidebarHtml() {
  var folders = state._rootFolders || [];
  var html = '';
  if (folders.length === 0) {
    html =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">\u6682\u65E0\u6587\u4EF6\u5939</div>';
  } else {
    var totalPhotos = 0;
    var photosPending = false;
    var tf = 0;
    var foldersPending = false;
    var fi;
    for (fi = 0; fi < folders.length; fi++) {
      var rf = folders[fi];
      var pc = rf && rf.photo_count;
      if (pc == null) photosPending = true;
      else totalPhotos += Number(pc) || 0;
      var fc = rf && rf.folder_count;
      if (fc == null) foldersPending = true;
      else tf += Number(fc) || 0;
    }
    /* 🔴 两个视图入口（所有文件 / 所有目录）包进 .sidebar-view-entries：
       树滚动时 sticky 钉在侧栏顶（与桌面端 sidebar-tree.js 同名契约）。 */
    var viewEntries = '';
    viewEntries +=
      '<div class="folder-item ' +
      (state.currentView === 'all' && !state._rootId ? 'active' : '') +
      '" data-action="view-all">' +
      // 🔴 文案是「所有文件」而不是「所有图片」：这个落点是 view:all，**不筛媒体类型**，
      //     视频也在里面（与桌面端 `path.allFiles` / `sidebar.allFiles` 同口径）。
      //     叫「所有图片」会与媒体筛选里的「图片」读起来像同一件事，也会盖掉视频。
      '<span class="icon">\uD83D\uDDBC\uFE0F</span><span class="name">\u6240\u6709\u6587\u4EF6</span><span class="count">' +
      formatRootFolderCount(photosPending ? null : totalPhotos) +
      '</span></div>';
    viewEntries +=
      '<div class="folder-item ' +
      (state.currentView === 'folder_overview' ? 'active' : '') +
      '" data-action="view-folder-overview">' +
      '<span class="icon">\uD83D\uDDC2\uFE0F</span><span class="name">\u6240\u6709\u76EE\u5F55</span><span class="count">' +
      formatRootFolderCount(foldersPending ? null : tf) +
      '</span></div>';
    html += '<div class="sidebar-view-entries">' + viewEntries + '</div>';
    for (var rootIdx = 0; rootIdx < folders.length; rootIdx++) {
      var f = folders[rootIdx];
      var isRootActive = state.currentView === 'root' && state._rootId === f.id;
      html += '<div class="tree-root">';
      html +=
        '<div class="folder-item tree-parent ' +
        (isRootActive ? 'active' : '') +
        '" data-root-id="' +
        f.id +
        '" data-action="view-root">' +
        // 箭头是空的（CSS chevron）：展开态由 `is-expanded` 决定，见 gallery-design.css
        '<span class="tree-toggle" data-action="toggle-root" data-tree-toggle="root" data-root-id="' +
        f.id +
        '"></span>' +
        '<span class="icon">\uD83D\uDCC1</span><span class="name" title="' +
        escapeHtml(f.path) +
        '">' +
        escapeHtml(f.name) +
        '</span>' +
        '<span class="count">' +
        formatRootFolderCount(f.photo_count) +
        '</span></div>';
      // 关闭态：无 `.expanded` + 行内 display:none；子目录拉回来后由 setTreeChildrenOpen 打开
      html +=
        '<div class="tree-children" style="display:none;--tree-guide-x:' +
        treeGuideX(0) +
        'px;" id="treeChildren-' +
        f.id +
        '"></div>';
      html += '</div>';
    }
  }
  var sc = $('#sidebarContent');
  if (sc) sc.innerHTML = html;
  loadAllFolderTrees();
}

function scheduleWebRootFoldersStatsHydrate(gen) {
  function runHydrate() {
    if (gen !== webRootFoldersHydrateGen) return;
    var url = '/api/root-folders';
    if (state.mediaFilter && state.mediaFilter !== 'all') {
      url += '?mediaType=' + encodeURIComponent(state.mediaFilter);
    }
    apiGet(url)
      .then(function (full) {
        if (gen !== webRootFoldersHydrateGen) return;
        var fullList = full || [];
        var byId = Object.create(null);
        var hi;
        for (hi = 0; hi < fullList.length; hi++) {
          var row = fullList[hi];
          if (row && row.id != null) byId[String(row.id)] = row;
        }
        var cur = state._rootFolders || [];
        var hj;
        for (hj = 0; hj < cur.length; hj++) {
          var c = cur[hj];
          var hit = c && c.id != null ? byId[String(c.id)] : null;
          if (hit) {
            c.photo_count = hit.photo_count;
            c.folder_count = hit.folder_count;
            c.video_count = hit.video_count;
          }
        }
        renderRootFoldersSidebarHtml();
      })
      .catch(function () {});
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(runHydrate, { timeout: 15000 });
  } else {
    setTimeout(runHydrate, 500);
  }
}

async function loadRootFolders(silentRefresh) {
  webRootFoldersHydrateGen++;
  var myGen = webRootFoldersHydrateGen;
  // 与桌面端对齐：已有目录树时走静默路径，避免切视图的重复调用闪「正在加载目录…」。
  var sc0 = $('#sidebarContent');
  var hasTree = !!(sc0 && sc0.querySelector('.folder-item, .tree-root, [data-action="view-all"]'));
  var silent = !!silentRefresh && hasTree;
  if (!silent) showSidebarLoadingPlaceholder('\u6B63\u5728\u52A0\u8F7D\u76EE\u5F55\u2026');
  try {
    var url = '/api/root-folders?lite=1';
    if (state.mediaFilter && state.mediaFilter !== 'all') {
      url += '&mediaType=' + encodeURIComponent(state.mediaFilter);
    }
    var folders = await apiGet(url);
    if (myGen !== webRootFoldersHydrateGen) return;
    state._rootFolders = folders || [];
    renderRootFoldersSidebarHtml();
    if ((state._rootFolders || []).length > 0) {
      scheduleWebRootFoldersStatsHydrate(myGen);
    }
  } catch (e) {
    state._rootFolders = [];
    var sc2 = $('#sidebarContent');
    if (sc2) {
      sc2.innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">目录加载失败，请稍后重试</div>';
    }
  }
}

function loadOneRootFolderTree(root) {
  return new Promise(function (resolve) {
    var treeUrl = '/api/folder-tree?rootId=' + root.id;
    if (state.mediaFilter && state.mediaFilter !== 'all') {
      treeUrl += '&mediaType=' + encodeURIComponent(state.mediaFilter);
    }
    apiGet(treeUrl)
      .then(function (folders) {
        var subFolders = folders.filter(function (f) {
          return f.folder_path !== root.path;
        });
        var tree = buildTree(root.path, subFolders);
        var container = document.getElementById('treeChildren-' + root.id);
        var treeToggle = container ? container.parentElement.querySelector('.tree-toggle') : null;
        if (container && tree.length > 0) {
          container.innerHTML = renderTreeNodes(tree, 1);
          // 首屏把所有库的树一次铺开：不播开合动画（与桌面端 expandTreeToFolder 同一口径）
          setTreeChildrenOpen(container, treeToggle, true, false);
        } else if (container) {
          setTreeChildrenOpen(container, treeToggle, false, false);
          if (treeToggle) treeToggle.style.visibility = 'hidden';
        }
        resolve();
      })
      .catch(function () {
        resolve();
      });
  });
}

async function loadAllFolderTrees() {
  var roots = state._rootFolders || [];
  if (roots.length === 0) return;
  var tasks = [];
  for (var i = 0; i < roots.length; i++) {
    tasks.push(loadOneRootFolderTree(roots[i]));
  }
  await Promise.all(tasks);
}

function buildTree(rootPath, flatFolders) {
  var nodes = [];
  for (var i = 0; i < flatFolders.length; i++) {
    var f = flatFolders[i];
    var relativePath = f.folder_path.replace(rootPath, '').replace(/^[\\/]/, '');
    if (!relativePath) continue;
    var parts = relativePath.split(/[\\/]/);
    insertTreeNode(nodes, parts, 0, rootPath, f.folder_path, f.photo_count);
  }
  sortTree(nodes);
  return nodes;
}

function insertTreeNode(nodes, parts, depth, rootPath, fullPath, photoCount) {
  if (depth >= parts.length) return;
  var name = parts[depth];
  // comment cleaned
  var nodePath = rootPath;
  for (var k = 0; k <= depth; k++) {
    nodePath += '\\' + parts[k];
  }

  var found = null;
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].name === name) {
      found = nodes[i];
      break;
    }
  }
  if (!found) {
    found = { name: name, fullPath: nodePath, photoCount: 0, children: [], isLeaf: false };
    nodes.push(found);
  }
  // 目录统计口径：当前目录 + 所有子目录
  found.photoCount += Number(photoCount) || 0;
  if (depth === parts.length - 1) {
    found.isLeaf = true;
  }
  insertTreeNode(found.children, parts, depth + 1, rootPath, fullPath, photoCount);
}

function sortTree(nodes) {
  nodes.sort(function (a, b) {
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].children.length > 0) sortTree(nodes[i].children);
  }
}

/** 目录行 HTML。缩进口径同桌面端：父行 `12+14d`、叶子行 `+26`（补满箭头槽）。
    子层容器只留标记，展开态走 `setTreeChildrenOpen()`。 */
function renderTreeNodes(nodes, depth) {
  var html = '';
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var isActive = state.currentView === 'folder' && state.currentPath === node.fullPath;
    var hasChildren = node.children.length > 0;
    var countHtml =
      node.photoCount > 0 ? '<span class="count">' + formatNumber(node.photoCount) + '</span>' : '';

    html += '<div class="tree-node">';
    if (hasChildren) {
      html +=
        '<div class="folder-item tree-parent ' +
        (isActive ? 'active' : '') +
        '" style="padding-left:' +
        treeRowIndent(depth) +
        'px;" data-folder-path="' +
        escapeAttr(node.fullPath) +
        '">' +
        '<span class="tree-toggle" data-action="toggle-node" data-tree-toggle="node"></span>' +
        '<span class="icon">\uD83D\uDCC1</span>' +
        '<span class="name" title="' +
        escapeHtml(node.fullPath) +
        '">' +
        escapeHtml(node.name) +
        '</span>' +
        countHtml +
        '</div>';
      html +=
        '<div ' +
        treeChildrenAttrs(depth) +
        '>' +
        renderTreeNodes(node.children, depth + 1) +
        '</div>';
    } else {
      // 叶子行没有箭头槽，靠 padding 把名字对齐到同级父行（旧实现放了个隐藏的假箭头）
      html +=
        '<div class="folder-item ' +
        (isActive ? 'active' : '') +
        '" style="padding-left:' +
        treeLeafIndent(depth) +
        'px;" data-folder-path="' +
        escapeAttr(node.fullPath) +
        '">' +
        '<span class="icon">\uD83D\uDCC2</span>' +
        '<span class="name" title="' +
        escapeHtml(node.fullPath) +
        '">' +
        escapeHtml(node.name) +
        '</span>' +
        countHtml +
        '</div>';
    }
    html += '</div>';
  }
  return html;
}

/** 开合一个子层：判据与桌面端一致（看行内 display），箭头由容器状态驱动 */
function toggleTreeChildren(toggle, children) {
  if (!children) return;
  if (children.style.display === 'none') setTreeChildrenOpen(children, toggle, true, true);
  else setTreeChildrenOpen(children, toggle, false);
}

function toggleTreeRoot(toggle, event, _rootId) {
  event.stopPropagation();
  toggleTreeChildren(toggle, toggle.closest('.tree-root').querySelector('.tree-children'));
}

function toggleTreeNode(toggle, event) {
  event.stopPropagation();
  var node = toggle.closest('.tree-node');
  if (!node) return;
  toggleTreeChildren(toggle, node.querySelector(':scope > .tree-children'));
}

function viewRootFolder(rootId) {
  state.currentView = 'root';
  state._rootId = rootId;
  state.currentPath = '';
  state.currentDate = '';
  state.page = 1;
  state.previewTotalPages = 1;
  var rootName = '';
  for (var i = 0; i < state._rootFolders.length; i++) {
    if (state._rootFolders[i].id === rootId) {
      rootName = state._rootFolders[i].name;
      break;
    }
  }
  var ht = $('#headerTitle');
  if (ht) ht.textContent = '\u6839\u76EE\u5F55: ' + rootName;
  updateSidebarActive();
  loadPhotos();
  pushViewHistoryState();
}

function escapeAttr(str) {
  if (!str) return '';
  // comment cleaned
  return str
    .replace(/\\/g, '/')
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// === Sidebar: Dates ===
async function loadDateGroups() {
  showSidebarLoadingPlaceholder('\u6B63\u5728\u52A0\u8F7D\u65E5\u671F\u2026');
  try {
    var groups = await apiGet(
      '/api/date-groups?sortOrder=' + encodeURIComponent(state.dateGroupsSortOrder || 'desc'),
    );
    var html = '';

    if (groups.length === 0) {
      html =
        '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">\u6682\u65E0\u6570\u636E</div>';
    } else {
      var total = 0;
      for (var i = 0; i < groups.length; i++) total += groups[i].count;

      html +=
        '<div class="date-sidebar-sort" role="toolbar" aria-label="\u65E5\u671F\u6392\u5E8F">' +
        '<button type="button" class="date-sort-btn' +
        (state.dateGroupsSortOrder === 'desc' ? ' active' : '') +
        '" data-action="date-sort" data-date-sort="desc" title="\u6700\u65B0\u65E5\u671F\u5728\u524D">\u65B0\u2192\u65E7</button>' +
        '<button type="button" class="date-sort-btn' +
        (state.dateGroupsSortOrder === 'asc' ? ' active' : '') +
        '" data-action="date-sort" data-date-sort="asc" title="\u6700\u65E9\u65E5\u671F\u5728\u524D">\u65E7\u2192\u65B0</button>' +
        '</div>';
      html +=
        '<div class="folder-item ' +
        (state.currentView === 'all' ? 'active' : '') +
        '" data-action="view-all">' +
        '<span class="icon">\uD83D\uDCC5</span><span class="name">\u6240\u6709\u65E5\u671F</span><span class="count">' +
        formatNumber(total) +
        '</span></div>';

      var lastYear = '';
      for (var dateIdx = 0; dateIdx < groups.length; dateIdx++) {
        var g = groups[dateIdx];
        var year = g.date.substring(0, 4);
        if (year !== lastYear) {
          html += '<div class="date-year">' + year + '</div>';
          lastYear = year;
        }
        var isActive = state.currentView === 'date' && state.currentDate === g.date;
        html +=
          '<div class="date-group ' +
          (isActive ? 'active' : '') +
          '" data-date="' +
          escapeAttr(g.date) +
          '">' +
          '<span class="date-label">' +
          formatDateLabel(g.date) +
          '</span><span class="date-count">' +
          formatNumber(g.count) +
          '</span></div>';
      }
    }

    var sc3 = $('#sidebarContent');
    if (sc3) sc3.innerHTML = html;
  } catch (e) {
    var sc4 = $('#sidebarContent');
    if (sc4) {
      sc4.innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">日期加载失败，请稍后重试</div>';
    }
  }
}

// === Views ===
function viewAllPhotos() {
  leaveWebAiViewForBrowse('folders');
  state.currentView = 'all';
  state._rootId = undefined;
  state.currentPath = '';
  state.currentDate = '';
  state.page = 1;
  state.previewTotalPages = 1;
  var ht = $('#headerTitle');
  if (ht) ht.textContent = '\u62C2\u6653\u56FE\u5E93 \u00B7 Aurora Gallery';
  updateSidebarActive();
  loadPhotos();
  pushViewHistoryState();
}

function viewFolderOverview() {
  leaveWebAiViewForBrowse('folders');
  state.currentView = 'folder_overview';
  state._rootId = undefined;
  state.currentPath = '';
  state.currentDate = '';
  state.page = 1;
  state.previewTotalPages = 1;
  var ht = $('#headerTitle');
  if (ht) ht.textContent = '\u62C2\u6653\u56FE\u5E93 \u00B7 Aurora Gallery';
  updateSidebarActive();
  loadFolderCovers();
  pushViewHistoryState();
}

function viewFolder(folderPath) {
  leaveWebAiViewForBrowse('folders');
  state.currentView = 'folder';
  state.currentPath = folderPath;
  state.page = 1;
  state.previewTotalPages = 1;
  state.sortBy = 'file_name';
  state.sortOrder = 'ASC';
  setProp('#sortSelect', 'value', 'file_name|ASC');
  var mobileSortSel = $('#mobileSortSelect');
  if (mobileSortSel) mobileSortSel.value = 'file_name|ASC';
  var name = folderPath.split(/[\\/]/).pop();
  var ht = $('#headerTitle');
  if (ht) ht.textContent = '\u6587\u4EF6\u5939: ' + name;
  var pg = $('#photoGrid');
  if (pg) pg.scrollTop = 0;
  updateSidebarActive();
  loadPhotos();
  pushViewHistoryState();
}

function viewDate(dateStr) {
  leaveWebAiViewForBrowse('dates');
  state.currentView = 'date';
  state.currentDate = dateStr;
  state.page = 1;
  state.previewTotalPages = 1;
  var ht = $('#headerTitle');
  if (ht) ht.textContent = '\u65E5\u671F: ' + formatDateLabel(dateStr);
  updateSidebarActive();
  loadPhotos();
  pushViewHistoryState();
}

function changeSort(val) {
  var parts = val.split('|');
  state.sortBy = parts[0];
  state.sortOrder = parts[1];
  var sortSel = $('#sortSelect');
  if (sortSel && sortSel.value !== val) sortSel.value = val;
  var mobileSortSel = $('#mobileSortSelect');
  if (mobileSortSel && mobileSortSel.value !== val) mobileSortSel.value = val;
  state.page = 1;
  loadPhotos();
}

function changePageSize(val) {
  var size = parseInt(val, 10);
  if ([50, 80, 100, 200].indexOf(size) < 0) return;
  state.pageSize = size;
  try {
    localStorage.setItem('webPageSize', String(size));
  } catch (e) {}
  var pageSizeSel = $('#pageSizeSelect');
  if (pageSizeSel && pageSizeSel.value !== val) pageSizeSel.value = val;
  var mobilePageSizeSel = $('#mobilePageSizeSelect');
  if (mobilePageSizeSel && mobilePageSizeSel.value !== val) mobilePageSizeSel.value = val;
  state.page = 1;
  loadPhotos();
}

function normalizeMediaFilter(v) {
  var s = String(v || 'all').toLowerCase();
  if (s === 'image' || s === 'video') return s;
  return 'all';
}

function changeMediaFilter(val) {
  state.mediaFilter = normalizeMediaFilter(val);
  // 同步头部下拉
  var headerSel = document.getElementById('headerMediaFilterSelect');
  if (headerSel) headerSel.value = state.mediaFilter;
  // 同步移动端选项按钮状态
  document.querySelectorAll('#mediaFilterButtons button').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.filter === state.mediaFilter);
  });
  state.page = 1;
  if (isFolderSidebarTab(state.currentTab)) {
    loadRootFolders();
  }
  loadPhotos();
}

function changeCardSize(direction) {
  var idx = browseCardTierIndexForBasis(state.cardSize);
  if (direction < 0) idx = Math.max(0, idx - 1);
  else if (direction > 0) idx = Math.min(CARD_SIZE_TIERS.length - 1, idx + 1);
  else return;
  state.cardSize = CARD_SIZE_TIERS[idx].basis;
  applyCardSize();
}

function changeCardSizeTo(basis) {
  state.cardSize = snapBrowseCardBasis(basis);
  applyCardSize();
}

/* 🔴 这里曾有一个 `capMasonryColumns()`：瀑布流档下若「卡片数 < 可容纳列数」，
   就把 `grid.style.columnCount` 压成**卡片数**，让这几张图摊满整行。
   2026-10-09 用户要求取消（桌面端 `renderer/app.js` 同名函数一起删）：
   「当某个文件夹或标签少于一排照片时，不要将图片占据所有宽度，保持和多图时一样宽度」。
   列宽本来就该由**容器宽度**决定、与张数无关；现在整条列宽规则只由 CSS 说 ——
   `.grid.grid--masonry { columns: calc(var(--grid-card-basis) * 1px) }`，
   手机档（≤600px）另有 `columns: 2` 兜底（那条**必须留着**，见 `web/index.html` 里的坑位说明）。

   ⚠️ 顺带解决：原实现用 `ResizeObserver` 观察 `.grid--masonry`，回调里又改
   `grid.style.columnCount` ⇒ **自反馈环**，console 反复刷
   `ResizeObserver loop completed with undelivered notifications`
   （`CONTRACTS.md`「本轮未修」那条记的就是它）。写者没了，观察者也就没有存在理由，
   一并不再创建 —— 所以**不要为了别的目的把 RO 加回来观察这个 grid**。 */

function applyCardSize() {
  state.cardSize = snapBrowseCardBasis(state.cardSize);
  var pg = $('#photoGrid');
  if (pg) {
    pg.style.setProperty('--grid-card-basis', String(state.cardSize));
  }
  // 网页端没有「S/M/L/XL」读数药丸（卡片尺寸是 `.card-size-btn` 那排按钮），
  // 曾经这里还写过一句给 `#zoomLabel` 赋读数的代码，但那个 id 只存在于桌面端
  // index.html —— 一句永远命中不了的死代码，已删。
  // 同步卡片大小按钮状态
  document
    .querySelectorAll('#cardSizeButtons button, #cardSizeGroup button')
    .forEach(function (btn) {
      btn.classList.toggle('active', parseInt(btn.dataset.size, 10) === state.cardSize);
    });
}

function updateSidebarActive() {
  // Only update active classes, no full re-render needed to avoid flicker
  if (!isFolderSidebarTab(state.currentTab)) {
    if (state.currentTab === 'dates') loadDateGroups();
    return;
  }
  // Remove all active classes from folder tree
  document.querySelectorAll('#sidebarContent .folder-item').forEach(function (el) {
    el.classList.remove('active');
  });
  // Add active class to current folder if viewing a folder
  if (state.currentView === 'folder' && state.currentPath) {
    var currentEl = document.querySelector(
      '#sidebarContent .folder-item[data-folder-path="' + CSS.escape(state.currentPath) + '"]',
    );
    if (currentEl) {
      currentEl.classList.add('active');
    }
  } else if (state.currentView === 'folder_overview') {
    var overviewEl = document.querySelector('#sidebarContent [data-action="view-folder-overview"]');
    if (overviewEl) overviewEl.classList.add('active');
  } else if (state.currentView === 'all') {
    var allEl = document.querySelector('#sidebarContent [data-action="view-all"]');
    if (allEl) allEl.classList.add('active');
  }
}

function folderDisplayBasename(folderPath) {
  if (!folderPath) return '\u76EE\u5F55';
  var parts = String(folderPath).split(/[\\/]/);
  return parts[parts.length - 1] || String(folderPath);
}

/**
 * 「没有缩略图」的统一占位图（与桌面端 `src/renderer/ui-grid.js` 逐字同源，2026-10-05）。
 *
 * 同一件事有两条入口：① 构建期就知道没有（`has_thumbnail` 为 0）；② 构建期有、缩略图文件
 * 后来丢了（`/thumb` 404 → `markFailed`）。以前网页端两条都落在那句「缩略图加载失败」上，
 * 连「本来就没有缩略图的视频」也被说成加载失败；桌面端构建期又是另一副面孔（大号扩展名）。
 *
 * 现在两条共用同一份图形：中性底 + 一点强调色晕影 + 居中的图片字形 + 一行小字。
 * 图形**内联**：两端要长得一模一样就得各自带全路径（网页端没有 `#icon-image` symbol），
 * 而且内联才让描边粗细归 CSS 管（`<use>` 里 symbol 自带的 `stroke-width` 会盖掉宿主的）。
 */
var MEDIA_PLACEHOLDER_GLYPH =
  '<svg class="placeholder-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5"/>' +
  '<circle cx="8.6" cy="8.6" r="1.5"/>' +
  '<polyline points="21 15 16 10 5 21"/>' +
  '</svg>';

/** 占位图的「内芯」（图形 + 说明）。字符串版与 DOM 版共用，别各写一份。 */
function mediaPlaceholderInnerHtml(caption) {
  return (
    MEDIA_PLACEHOLDER_GLYPH +
    (caption ? '<span class="placeholder-caption">' + caption + '</span>' : '')
  );
}

function mediaPlaceholderHtml(caption) {
  return (
    '<div class="placeholder placeholder--media">' + mediaPlaceholderInnerHtml(caption) + '</div>'
  );
}

/**
 * 有没有可用的缩略图。
 * ⚠️ 字段**缺失**时（个别接口不带 `has_thumbnail`）按「有」处理，维持旧的「先按 <img> 渲染、
 * 失败再兜底」行为；只有明确写着 0 才在构建期就走占位图 —— 免得把有缩略图的卡片误判成没有。
 */
function hasUsableThumbnail(photo) {
  if (!photo) return false;
  var v = photo.has_thumbnail;
  return !(v === 0 || v === '0' || v === false);
}

function createGridFallbackPlaceholder(card) {
  if (!card) return null;
  var isFolder = card.classList.contains('folder-card');
  var ph = document.createElement('div');
  if (isFolder) {
    ph.className = 'folder-cover-placeholder folder-cover-placeholder--error';
    ph.innerHTML =
      '<svg class="folder-cover-placeholder-icon folder-cover-placeholder-icon--error" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>' +
      '</svg>' +
      '<span class="folder-cover-placeholder-msg">\u5C01\u9762\u52A0\u8F7D\u5931\u8D25</span>';
    return ph;
  }
  ph.className = 'placeholder placeholder--media';
  ph.innerHTML = mediaPlaceholderInnerHtml('\u7F29\u7565\u56FE\u52A0\u8F7D\u5931\u8D25');
  return ph;
}

function bindGridImageProgress(root) {
  if (!root) return;
  var imgs = root.querySelectorAll('img.grid-thumb');
  for (var i = 0; i < imgs.length; i++) {
    (function (img) {
      if (!img || img.dataset.gridBound === '1') return;
      img.dataset.gridBound = '1';

      function getCard() {
        return img.closest('.photo-card');
      }

      function markLoaded() {
        img.classList.remove('loading');
        var card = getCard();
        if (card) card.classList.add('thumb-loaded');
      }

      function markFailed() {
        var card = getCard();
        img.classList.remove('loading');
        if (!card) return;
        card.classList.add('thumb-failed');
        // 原比例瀑布流里卡片靠 <img> 的内在尺寸定高，缩略图文件缺失（`/thumb` 404）时图一摘
        // 就没了定高依据，卡片会塌成一条比文字还矮的横杠 —— 退回正方形占位兜底。
        // 判断用 closest 而不是 root：`.grid--masonry` 是 `#photoGrid` 的子节点（由
        // `renderPhotoGrid` 写进去的），挂在 root 上那层并没有这个类。
        if (card.closest && card.closest('.grid--masonry')) {
          card.classList.add('photo-card--square-placeholder');
        }
        try {
          img.remove();
        } catch (e) {}
        if (card.querySelector('.placeholder, .folder-cover-placeholder')) return;
        var ph = createGridFallbackPlaceholder(card);
        if (ph) card.insertBefore(ph, card.firstChild);
      }

      img.addEventListener('load', markLoaded, { once: true });
      img.addEventListener('error', markFailed, { once: true });

      if (img.complete) {
        if ((img.naturalWidth || 0) > 0) markLoaded();
        else markFailed();
      }
    })(imgs[i]);
  }
}

async function loadFolderCovers(request) {
  request = request || beginPhotoRequest();
  showSkeleton('folders');
  try {
    var url =
      '/api/folder-covers?page=' +
      encodeURIComponent(state.page) +
      '&pageSize=' +
      encodeURIComponent(state.pageSize);
    if (state.mediaFilter && state.mediaFilter !== 'all') {
      url += '&mediaType=' + encodeURIComponent(state.mediaFilter);
    }
    var raw = await apiGet(url, request.signal);
    if (request.signal.aborted || request.seq !== state.photosRequestSeq) return;
    var covers;
    var total;
    var totalPages;
    var page;
    if (raw && Array.isArray(raw.covers)) {
      covers = raw.covers;
      total = raw.total != null ? raw.total : covers.length;
      totalPages = raw.totalPages != null ? raw.totalPages : 1;
      page = raw.page != null ? raw.page : 1;
    } else if (Array.isArray(raw)) {
      covers = raw;
      total = covers.length;
      totalPages = 1;
      page = 1;
    } else {
      covers = [];
      total = 0;
      totalPages = 1;
      page = 1;
    }
    state.folderCovers = covers;
    state.previewTotalPhotos = total;
    state.previewTotalPages = totalPages;
    state.page = page;
    renderFolderCoverGrid(covers);
    renderPagination({
      page: page,
      totalPages: totalPages,
      total: total,
      isFolderOverview: true,
    });
  } catch (e) {
    if (request.signal.aborted || request.seq !== state.photosRequestSeq) return;
    var photoGrid3 = $('#photoGrid');
    if (photoGrid3) {
      photoGrid3.innerHTML =
        '<div class="empty-state"><div class="icon">\u26A0\uFE0F</div><div class="title">\u76EE\u5F55\u52A0\u8F7D\u5931\u8D25</div></div>';
    }
    setDisplay('#pagination', 'none');
  }
}

function folderCoverDefaultPlaceholderHtmlWeb() {
  return (
    '<div class="folder-cover-placeholder folder-cover-placeholder--default" aria-hidden="true">' +
    '<svg class="folder-cover-placeholder-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
    '<path class="folder-cover-placeholder-shape" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>' +
    '<path class="folder-cover-placeholder-inner" d="M4 8h16v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z"/>' +
    '</svg>' +
    '</div>'
  );
}

function renderFolderCoverGrid(covers) {
  if (!covers || covers.length === 0) {
    var photoGrid4 = $('#photoGrid');
    if (photoGrid4) {
      photoGrid4.innerHTML =
        '<div class="empty-state"><div class="icon">D</div><div class="title">\u52A0\u8F7D\u5931\u8D25</div></div>';
    }
    return;
  }
  var useMediaRatio = state.cardAspectMode === 'masonry';
  var html = '<div class="grid" data-use-media-ratio="' + (useMediaRatio ? '1' : '0') + '">';
  for (var i = 0; i < covers.length; i++) {
    var row = covers[i];
    var folderPath = row.folder_path || '';
    var name = folderDisplayBasename(folderPath);
    var coverId = parseInt(row.id, 10);
    var thumbUrl =
      !isNaN(coverId) && coverId > 0 ? '/thumb/' + coverId + '?v=' + thumbCacheVersion(row) : '';
    html +=
      '<div class="photo-card folder-card" data-folder-path="' + escapeAttr(folderPath) + '">';
    if (thumbUrl) {
      html +=
        '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
        '<img src="' +
        thumbUrl +
        '" alt="' +
        escapeHtml(name) +
        '" loading="lazy" class="loading grid-thumb" />';
    } else {
      html += folderCoverDefaultPlaceholderHtmlWeb();
    }
    var cnt = row.folder_photo_count != null ? row.folder_photo_count : 0;
    html +=
      '<div class="photo-info"><div class="photo-name">\uD83D\uDCC1 ' +
      escapeHtml(name) +
      '</div><div class="photo-date">' +
      formatNumber(cnt) +
      ' \u5F20</div></div></div>';
  }
  html += '</div>';
  var gridEl2 = $('#photoGrid');
  if (gridEl2) gridEl2.innerHTML = html;
  bindGridImageProgress($('#photoGrid'));
  applyCardSize();
}

// === Load photos ===
async function loadPhotos(extraParams) {
  // 智能视图（搜图 / 人物）的结果由适配层直接灌进 #photoGrid，不走分页与筛选链路，
  // 所以要在骨架屏之前分流，否则首屏引导会被刷成「正在加载图片」。
  if (isWebAiView()) {
    beginPhotoRequest();
    setDisplay('#pagination', 'none');
    setDisplay('#browseFooter', 'none');
    if (webAiViews) await webAiViews.load();
    return;
  }
  // 标签导航页的「浏览态」（还没选中具体标签）：主区不是照片网格，而是标签卡片。
  // 与桌面端 loadPhotos 的同一条早退 —— 它自己决定 #photoGrid 里的内容。
  // 🔴 三件事不能省（缺了都不报错，只在别处显形）：currentPhotos 不清空会让
  //    预览打开上一页的照片；previewTotal 不重置让预览翻页总数是旧的；
  //    标题不更新让标题栏停在上一页（实测停在「所有日期」）。
  if (isTagView() && !state.currentTag) {
    beginPhotoRequest();
    setDisplay('#pagination', 'none');
    setDisplay('#browseFooter', 'none');
    state.currentPhotos = [];
    state.previewTotalPhotos = 0;
    state.previewTotalPages = 1;
    updateTagViewHeader();
    if (webTagNav) webTagNav.renderBrowseCards();
    return;
  }
  // 从智能视图回到浏览视图：收掉 AI 工具栏（搜索框 / 返回键）并恢复筛选与排序。
  if (webAiViews && webAiViews.isShowing()) webAiViews.leave();
  var request = beginPhotoRequest();
  var requestSeq = request.seq;
  function requestGet(url) {
    return apiGet(url, request.signal);
  }
  showSkeleton();
  try {
    var result;
    var baseParams =
      '&sortBy=' +
      state.sortBy +
      '&sortOrder=' +
      state.sortOrder +
      '&page=' +
      state.page +
      '&pageSize=' +
      state.pageSize +
      (state.mediaFilter && state.mediaFilter !== 'all'
        ? '&mediaType=' + encodeURIComponent(state.mediaFilter)
        : '') +
      orgFilterParams();

    switch (state.currentView) {
      case 'tag':
        // 标签导航页：顺序由索引侧定死为标签置信度降序（「最典型地属于这个标签」在前），
        // 所以 `sortBy` / `sortOrder` 在这条路上不生效 —— 与桌面端 loadPhotos 同一条取舍。
        result = await requestGet(
          '/api/tag-nav-photos?tag=' +
            encodeURIComponent(state.currentTag) +
            baseParams +
            '&locale=' +
            encodeURIComponent(document.documentElement.lang || 'zh-CN'),
        );
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
        updateTagViewHeader();
        break;
      case 'search':
        result = await requestGet(
          '/api/search?q=' + encodeURIComponent(state.searchQuery) + baseParams,
        );
        if (requestSeq !== state.photosRequestSeq) return;
        var ht = $('#headerTitle');
        if (ht) ht.textContent = '\u641C\u7D22: ' + state.searchQuery;
        break;
      case 'folder_overview':
        if (requestSeq !== state.photosRequestSeq) return;
        await loadFolderCovers(request);
        if (requestSeq !== state.photosRequestSeq) return;
        return;
      case 'folder':
        result = await requestGet(
          '/api/folder-photos?path=' + encodeURIComponent(state.currentPath) + baseParams,
        );
        if (requestSeq !== state.photosRequestSeq) return;
        // Load immediate subfolder covers
        state.currentSubfolderCovers = [];
        try {
          var subfolderResp = await requestGet(
            '/api/immediate-subfolder-covers?parentPath=' +
              encodeURIComponent(state.currentPath) +
              (state.mediaFilter && state.mediaFilter !== 'all'
                ? '&mediaType=' + encodeURIComponent(state.mediaFilter)
                : ''),
          );
          if (request.signal.aborted || requestSeq !== state.photosRequestSeq) return;
          state.currentSubfolderCovers = Array.isArray(subfolderResp)
            ? subfolderResp
            : subfolderResp.covers || [];
        } catch (e) {
          if (request.signal.aborted || requestSeq !== state.photosRequestSeq) return;
          console.warn('Failed to load subfolder covers:', e);
          state.currentSubfolderCovers = [];
        }
        break;
      case 'date':
        result = await requestGet(
          '/api/date-photos?date=' + encodeURIComponent(state.currentDate) + baseParams,
        );
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
        break;
      case 'root':
        result = await requestGet('/api/photos?' + baseParams + '&rootId=' + state._rootId);
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
        break;
      default:
        var url = '/api/photos?' + baseParams;
        if (extraParams) url += '&' + extraParams;
        result = await requestGet(url);
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
    }

    if (request.signal.aborted || requestSeq !== state.photosRequestSeq) return;
    state.currentPhotos = result.photos || [];
    state.previewTotalPhotos = result.total || 0;
    state.previewTotalPages = result.totalPages || 1;
    if (state.currentView === 'folder') {
      var scopedTotal = Number(result && result.total) || 0;
      var scopedVideoCount = Number(result && result.videoCount) || 0;
      var subfolderCount = state.currentSubfolderCovers.length;
      setText('#headerStats', compactFolderStats(subfolderCount, scopedTotal, scopedVideoCount));
    } else if (state.stats && state.stats.totalPhotos > 0) {
      setText('#headerStats', compactLibraryStats(state.stats));
      state.currentSubfolderCovers = [];
    }
    renderPhotoGrid(state.currentPhotos);
    renderPagination(result);
    try {
      var hst = window.history.state;
      if (!hst || !hst.previewOpen) {
        replaceViewHistoryState();
      }
    } catch (eHist) {}
  } catch (e) {
    if (requestSeq !== state.photosRequestSeq) return;
    state.currentPhotos = [];
    state.previewTotalPhotos = 0;
    state.previewTotalPages = 1;
    var photoGrid = $('#photoGrid');
    if (photoGrid) {
      photoGrid.innerHTML =
        '<div class="empty-state"><div class="icon">⚠️</div><div class="title">页面加载失败</div></div>';
    }
    setDisplay('#pagination', 'none');
  }
}

// === Render ===
function renderPhotoGrid(photos) {
  var hasSubfolders =
    state.currentView === 'folder' &&
    state.currentSubfolderCovers &&
    state.currentSubfolderCovers.length > 0;
  var hasPhotos = photos && photos.length > 0;

  if (!hasSubfolders && !hasPhotos) {
    // 空态文案**按媒体档位切换**。⚠️ 与桌面端 `ui-grid.js#MEDIA_FILTER_TEXTS` 同口径，
    // 但两端是两份实现（没有共享模块），改一边必须同改另一边。
    var mf =
      state.mediaFilter === 'image' || state.mediaFilter === 'video'
        ? state.mediaFilter
        : 'all';
    var emptyTitle;
    var emptyHint;
    if (state.currentView === 'search' && state.searchQuery) {
      // 🔴 关键词搜索**共用同一个空态**：提示必须指向「换关键词」，
      //    叫用户「换个位置看看」是纯粹的错话（搜索结果与目录无关）。
      emptyTitle = '没有找到匹配的内容';
      emptyHint =
        mf === 'all' ? '换个关键词试试。' : '换个关键词试试，或把媒体筛选切到「全部」。';
    } else if (mf === 'video') {
      emptyTitle = '暂无视频';
      emptyHint = '这里没有视频，可切到「全部」或「仅图片」看看。';
    } else if (mf === 'image') {
      emptyTitle = '暂无图片';
      emptyHint = '这里没有图片，可切到「全部」或「仅视频」看看。';
    } else {
      emptyTitle = '暂无图片与视频';
      emptyHint = '换个位置看看，或到「设置」里点「添加目录」加入文件夹。';
    }
    var emptySvg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' fill='none' stroke='currentColor' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round' style='width:52px;height:52px;opacity:0.55'><rect x='8' y='12' width='48' height='40' rx='8'/><path d='M8 44l12-12 8 8 16-16 12 12'/><circle cx='46' cy='24' r='4'/></svg>";
    var photoGrid5 = $('#photoGrid');
    if (photoGrid5) {
      photoGrid5.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-visual" aria-hidden="true">' +
        emptySvg +
        '</div>' +
        '<div class="title">' +
        emptyTitle +
        '</div>' +
        '<p class="empty-state-hint">' +
        emptyHint +
        '</p>' +
        '</div>';
      return;
    }
  }

  var aspectMode = normalizeCardAspectMode(state.cardAspectMode);
  var useMediaRatio = state.cardAspectMode === 'masonry';
  var isMasonryAspect = aspectMode === 'masonry';
  var uniformAspect = isMasonryAspect ? '' : getUniformAspectCss(aspectMode);
  var html =
    '<div class="grid' +
    (isMasonryAspect ? ' grid--masonry' : '') +
    '" data-use-media-ratio="' +
    (useMediaRatio ? '1' : '0') +
    '">';

  // Render subfolder covers first if there are any
  if (hasSubfolders) {
    for (var s = 0; s < state.currentSubfolderCovers.length; s++) {
      var cover = state.currentSubfolderCovers[s];
      var folderPath = cover.folder_path || '';
      var name = folderDisplayBasename(folderPath);
      var coverId = parseInt(cover.id, 10);
      var subThumbUrl =
        !isNaN(coverId) && coverId > 0 ? '/thumb/' + coverId + '?v=' + thumbCacheVersion(cover) : '';
      var cnt = cover.folder_photo_count != null ? cover.folder_photo_count : 0;
      html +=
        '<div class="photo-card folder-card" data-folder-path="' + escapeAttr(folderPath) + '">';
      if (subThumbUrl) {
        html +=
          '<div class="thumb-blur-placeholder" aria-hidden="true" style="background-image:url(' +
          escapeAttr(subThumbUrl) +
          ');background-size:cover;background-position:center;"></div>' +
          '<img src="' +
          subThumbUrl +
          '" alt="' +
          escapeAttr(name) +
          '" loading="lazy" class="loading grid-thumb" />';
      } else {
        html += folderCoverDefaultPlaceholderHtmlWeb();
      }
      html +=
        '<div class="photo-info"><div class="photo-name">\uD83D\uDCC1 ' +
        escapeHtml(name) +
        '</div><div class="photo-date">' +
        formatNumber(cnt) +
        ' \u5F20</div></div></div>';
    }
  }

  // Then render photos
  for (var i = 0; i < photos.length; i++) {
    var photo = photos[i];
    var isVideo =
      isWebVideoFileType(photo.file_type) ||
      String(photo.media_type || '').toLowerCase() === 'video';
    var ratioObj = isMasonryAspect ? getMediaAspectRatioDims(photo) : null;
    var ratio = ratioObj ? ratioObj.ratio : uniformAspect;
    var delay = Math.min(i * 30, 600);
    var cardStyle = 'animation-delay:' + delay + 'ms;';
    if (ratio && !isMasonryAspect) cardStyle += 'aspect-ratio:' + ratio + ';';
    var noThumb = !hasUsableThumbnail(photo);
    // 组织元数据（标记 / 评分）：角标 HTML 与 data 属性。判据与桌面端
    // `org-meta-ui.js` 同一条（0 = 未评分、none = 未标记都不出角标）。
    var webOrgFlag = photo.flag === 'pick' || photo.flag === 'reject' ? photo.flag : 'none';
    var webOrgRating = Math.max(0, Math.min(5, parseInt(photo.rating, 10) || 0));
    html +=
      '<div class="photo-card' +
      (noThumb && isMasonryAspect ? ' photo-card--square-placeholder' : '') +
      '" data-photo-id="' +
      photo.id +
      '" data-org-flag="' +
      webOrgFlag +
      '" data-org-rating="' +
      webOrgRating +
      '" style="' +
      cardStyle +
      '" onclick="startPreview(' +
      i +
      ')">';
    if (isVideo) {
      html += '<span class="media-type-badge media-type-badge-video">\u89C6\u9891</span>';
    }
    // Live Photo：这张图片带一段可播放的动态。判据是**数据库里的配对结果**
    // （`live_motion_id`，由 Live Photo 配对任务写入），不是「同目录有个同名 .mov」——
    // 真库实测：全库 4554 个 `.mov` 里按文件名判会命中 1107 个，其中真正带 Apple
    // identifier 的只有 1 个（见 src/main/live-photo.js）。
    // ⚠️ 该字段由 database.js 的图片列清单带出，列表接口不带上它就永远是 0 ——
    //    桌面端与网页端共用同一份 SELECT，所以两端同时生效或同时失效。
    // 🔴 判据函数只有一份（`isWebLivePhotoStill`）：角标与预览里的「实况」按钮
    //    必须由同一个事实驱动，各写一份就会出现「有角标但按不出播放」。
    if (isWebLivePhotoStill(photo)) {
      html += '<span class="media-type-badge media-type-badge-live">LIVE</span>';
    }
    // 组织元数据角标：插在缩略图**之前**（缩略图层是绝对定位铺满的，
    // 角标要在同一层叠上下文里才压得住）。位置：标记右下、评分左下。
    if (webOrgFlag === 'pick') {
      html +=
        '<span class="photo-card-flag photo-card-flag--pick"><svg class="icon" aria-hidden="true"><use href="#icon-check" /></svg></span>';
    } else if (webOrgFlag === 'reject') {
      html +=
        '<span class="photo-card-flag photo-card-flag--reject"><svg class="icon" aria-hidden="true"><use href="#icon-close" /></svg></span>';
    }
    if (webOrgRating > 0) {
      html +=
        '<span class="photo-card-rating"><svg class="icon" aria-hidden="true"><use href="#icon-star" /></svg><em>' +
        webOrgRating +
        '</em></span>';
    }
    if (noThumb) {
      // 本来就没有缩略图 —— 别再去请求 /thumb（那是必然 404，白跑一趟还占连接），
      // 直接上统一占位图（与桌面端构建期那条路径同一套标记）。
      html += mediaPlaceholderHtml(escapeHtml(photo.file_type || '?'));
    } else {
      var imgWH = ratioObj ? ' width="' + ratioObj.w + '" height="' + ratioObj.h + '"' : '';
      // 模糊占位与真图**共用同一个键**（只是同一个 URL 用在两处）：两个键不一致的话
      // 重建后会命中两份缓存，占位块换新、真图还是旧的。
      var thumbVer = thumbCacheVersion(photo);
      html +=
        '<div class="thumb-blur-placeholder" aria-hidden="true" style="background-image:url(/thumb/' +
        photo.id +
        '?v=' +
        thumbVer +
        ');background-size:cover;background-position:center;"></div>' +
        '<div class="thumb-vignette" aria-hidden="true"></div>' +
        '<img src="/thumb/' +
        photo.id +
        '?v=' +
        thumbVer +
        '" alt="' +
        escapeHtml(photo.file_name) +
        '"' +
        imgWH +
        ' loading="lazy" class="loading grid-thumb" />';
    }
    html +=
      '<div class="photo-info"><div class="photo-name">' +
      escapeHtml(photo.file_name) +
      '</div>' +
      '<div class="photo-date">' +
      formatDateTime(photo.date_taken) +
      '</div></div></div>';
  }
  html += '</div>';
  var gridEl2 = $('#photoGrid');
  if (gridEl2) gridEl2.innerHTML = html;
  bindGridImageProgress($('#photoGrid'));
  applyCardSize();
}

function showSkeleton(gridHint) {
  // 浏览那条按**当前媒体档位**取文案；`'folders'` 是目录列表，与档位无关。
  // ⚠️ 与桌面端 `ui-grid.js#showSkeleton` 同口径（那边由 `MEDIA_FILTER_TEXTS` 派生）。
  var mf =
    state.mediaFilter === 'image' || state.mediaFilter === 'video' ? state.mediaFilter : 'all';
  var hint =
    gridHint === 'folders'
      ? '\u6B63\u5728\u52A0\u8F7D\u76EE\u5F55\u5217\u8868'
      : mf === 'video'
        ? '正在加载视频…'
        : mf === 'image'
          ? '正在加载图片…'
          : '正在加载图片与视频…';
  var html =
    '<div class="grid-loading" role="status" aria-live="polite">' +
    '<div class="grid-loading-spinner-wrap" aria-hidden="true">' +
    '<span class="grid-loading-spinner"></span>' +
    '<span class="grid-loading-spinner-inner"></span>' +
    '</div>' +
    '<div class="grid-loading-text">' +
    hint +
    '</div>' +
    '</div>';
  var gridEl2 = $('#photoGrid');
  if (gridEl2) gridEl2.innerHTML = html;
}

function renderPagination(result) {
  if (!result || !$('#pagination')) return;
  var totalPages = Number(result.totalPages) || 1;
  if (totalPages <= 1) {
    setDisplay('#pagination', 'none');
    return;
  }
  setDisplay('#pagination', 'flex');
  var total = Number(result.total) || 0;
  setText('#pageInfo', total + (result.isFolderOverview ? ' \u4E2A\u76EE\u5F55' : ' \u5F20'));
  var page = Number(result.page) || 1;
  setProp('#prevPage', 'disabled', page <= 1);
  setProp('#nextPage', 'disabled', page >= totalPages);
  var randBtn = $('#randomPageBtn');
  if (randBtn) randBtn.disabled = totalPages <= 1;

  // comment cleaned
  var pages = generatePageNumbers(page, totalPages);
  var html = '';
  for (var i = 0; i < pages.length; i++) {
    if (pages[i] === '...') {
      html += '<span class="page-ellipsis">...</span>';
    } else {
      var cls = pages[i] === page ? ' active' : '';
      html +=
        '<button class="' +
        cls +
        '" onclick="goToPage(' +
        pages[i] +
        ')">' +
        pages[i] +
        '</button>';
    }
  }
  var pageNumbers = $('#pageNumbers');
  if (pageNumbers) pageNumbers.innerHTML = html;
}

function generatePageNumbers(current, total) {
  var isMobile = typeof window !== 'undefined' && window.innerWidth <= 600;
  if (isMobile) {
    // 移动端：显示首页 + 当前页码，翻页通过 prev/next 按钮
    if (current === 1) return [1];
    return [1, current];
  }
  if (total <= 7) {
    var arr = [];
    for (var pageNum = 1; pageNum <= total; pageNum++) arr.push(pageNum);
    return arr;
  }
  // 桌面端：显示首页、current±1、尾页
  var pages = [1];
  if (current > 3) pages.push('\u2026');
  var start = Math.max(2, current - 1);
  var end = Math.min(total - 1, current + 1);
  for (var midPageNum = start; midPageNum <= end; midPageNum++) pages.push(midPageNum);
  if (current < total - 2) pages.push('\u2026');
  pages.push(total);
  return pages;
}

function goToPage(page) {
  if (page < 1 || page > state.previewTotalPages) return;
  state.page = page;
  loadPhotos();
}

function randomPage() {
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

function prevPage() {
  if (state.page > 1) {
    state.page--;
    loadPhotos();
  }
}
function nextPage() {
  state.page++;
  loadPhotos();
}

/** 随机幻灯依赖 /api/preview-next；超时与桌面端 IPC 一致，避免请求挂起导致换片堆积 */
var PREVIEW_ADJACENT_TIMEOUT_MS = 15000;

// === Preview ===
function startPreview(index) {
  state.previewPhotos = state.currentPhotos.slice();
  state.previewPageStart = state.page;
  state.previewLoadingPage = 0;
  state.slideshowRandomPool = [];
  state.slideshowRandomBatch = [];
  state.slideshowRandomBatchPos = 0;
  state.slideshowRandomBatchRound = 0;
  if (!state.slideshowRandomSeed) {
    state.slideshowRandomSeed = Date.now() % 2147483647;
  }
  openPreview(index);
}

function openPreview(index) {
  var photo = state.previewPhotos[index];
  if (!photo) return;
  // 裁剪是模态的：任何「换图」路径（方向键 / 幻灯片 / 翻页按钮）都要先把选区收掉，
  // 否则选框会留在屏上、却已经对应了另一张图（坐标全错且不报错）。
  if (webPreviewCrop && webPreviewCrop.isActive && webPreviewCrop.isActive()) webPreviewCrop.exit();
  // 换图 = 待保存的编辑作废。这里是**唯一**的清空点：所有切图路径都汇到本函数。
  // ⚠️ 用户主动切图/关预览时的**确认**在 `guardPendingPreviewEdit()`，不在这里 ——
  //    `openPreview` 也被保存流程调用，在那里弹框会卡住自己。
  resetPreviewPendingEdit();
  var requestSeq = ++state.previewRequestSeq;
  function isCurrentPreviewRequest() {
    return requestSeq === state.previewRequestSeq;
  }

  var overlay = $('#previewOverlay');
  var wasOverlayActive = !!(overlay && overlay.classList.contains('active'));

  state.previewIndex = index;
  refreshWebPreviewRandomPositionNum();
  var intervalSelect = $('#slideshowIntervalSelect');
  if (intervalSelect) {
    var sec = parseInt(intervalSelect.value, 10);
    state.slideshowIntervalSec = isNaN(sec) ? 3 : sec;
  }
  resetZoom();

  var img = $('#previewImage');
  var video = $('#previewVideo');
  if (!img) return;
  var isVideo = isWebVideoFileType(photo.file_type);
  setSubtitleToggleVisible(isVideo);
  // Live Photo：**每次**切图都在这里先把动态收干净，再决定「实况」按钮的显隐。
  // 必须落在图片/视频两条分支**之前** —— 写进任一条都只覆盖一半路径。
  syncWebLivePreview(photo, isVideo);

  if (state.isMobile && !state.previewSwipeHintShown) {
    showPreviewSwipeHint();
  }

  function showPreviewLoading() {
    var el = $('#previewLoading');
    if (el) el.classList.add('show');
  }

  function hidePreviewLoading() {
    var el = $('#previewLoading');
    if (el) {
      el.classList.remove('show');
      el.classList.remove('video-loading');
    }
  }

  function showImageInPreview() {
    if (state.previewImageLoadSafetyTimer) {
      try {
        clearTimeout(state.previewImageLoadSafetyTimer);
      } catch (eClr) {}
      state.previewImageLoadSafetyTimer = null;
    }
    if (video) {
      try {
        video.pause();
      } catch (eV) {}
      video.removeAttribute('src');
      try {
        video.load();
      } catch (eV2) {}
      video.style.display = 'none';
    }
    img.style.display = '';
    img.style.visibility = 'hidden';
    showPreviewLoading();

    function finishPreviewImage() {
      if (!isCurrentPreviewRequest()) return;
      img.style.visibility = '';
      img.classList.remove('switching');
      hidePreviewLoading();
      if (state.previewImageLoadSafetyTimer) {
        try {
          clearTimeout(state.previewImageLoadSafetyTimer);
        } catch (eF) {}
        state.previewImageLoadSafetyTimer = null;
      }
    }

    function assignImageAndLoad() {
      try {
        img.setAttribute('fetchpriority', 'high');
      } catch (eFp) {}
      try {
        img.decoding = 'async';
      } catch (eDec) {}

      var v = photoCacheVersion(photo);
      var previewUrl = '/preview-image/' + photo.id + '?v=' + v;
      var fallbackUrl = '/photo/' + photo.id + '?v=' + v;

      function startSafetyTimer() {
        state.previewImageLoadSafetyTimer = setTimeout(function () {
          state.previewImageLoadSafetyTimer = null;
          if (!isCurrentPreviewRequest()) return;
          finishPreviewImage();
        }, 45000);
      }

      function applySrcToImg(url) {
        img.onload = function () {
          finishPreviewImage();
        };
        img.onerror = function () {
          finishPreviewImage();
        };
        img.src = url;
        if (img.complete && img.naturalWidth > 0) {
          requestAnimationFrame(function () {
            if (isCurrentPreviewRequest() && img.complete && img.naturalWidth > 0) {
              finishPreviewImage();
            }
          });
        }
      }

      // 如果有原图尺寸信息，提前设置宽高比占位避免布局跳动
      if (photo.width && photo.height) {
        img.style.aspectRatio = photo.width + ' / ' + photo.height;
      } else {
        img.style.aspectRatio = 'auto';
      }
      // 移除固定像素尺寸，让CSS自动缩放填满容器
      img.removeAttribute('width');
      img.removeAttribute('height');

      // 并行加载：立即开始加载大图，同时显示缩略图占位，减少等待时间
      startSafetyTimer();
      var fullImg = new Image();
      try {
        fullImg.fetchPriority = 'high';
      } catch (ePri) {}

      if (photo.has_thumbnail) {
        // 先显示缩略图占位
        img.onload = function () {
          if (!isCurrentPreviewRequest()) return;
          hidePreviewLoading();
          img.style.visibility = 'visible';
          img.classList.remove('switching');
        };
        img.onerror = function () {
          if (!isCurrentPreviewRequest()) return;
          img.style.visibility = 'hidden';
          showPreviewLoading();
        };
        img.removeAttribute('src');
        img.src = '/thumb/' + photo.id + '?v=' + thumbCacheVersion(photo);
        // 如果缩略图已缓存，onload不会触发，手动处理
        if (img.complete && img.naturalWidth > 0) {
          if (isCurrentPreviewRequest()) {
            hidePreviewLoading();
            img.style.visibility = 'visible';
            img.classList.remove('switching');
          }
        }
        // 大图加载完成后立即替换
        fullImg.onload = function () {
          if (!isCurrentPreviewRequest()) return;
          applySrcToImg(previewUrl);
        };
        fullImg.onerror = function () {
          if (!isCurrentPreviewRequest()) return;
          var fb = new Image();
          fb.onload = function () {
            if (!isCurrentPreviewRequest()) return;
            applySrcToImg(fallbackUrl);
          };
          fb.onerror = function () {
            finishPreviewImage();
          };
          fb.src = fallbackUrl;
        };
        fullImg.src = previewUrl;
      } else {
        img.style.visibility = 'hidden';
        showPreviewLoading();
        // 没有缩略图，直接加载大图
        fullImg.onload = function () {
          if (!isCurrentPreviewRequest()) return;
          applySrcToImg(previewUrl);
        };
        fullImg.onerror = function () {
          if (!isCurrentPreviewRequest()) return;
          var fb = new Image();
          fb.onload = function () {
            if (!isCurrentPreviewRequest()) return;
            applySrcToImg(fallbackUrl);
          };
          fb.onerror = function () {
            finishPreviewImage();
          };
          fb.src = fallbackUrl;
        };
        fullImg.src = previewUrl;
      }
    }

    if (overlay.classList.contains('active')) {
      img.classList.add('switching');
      requestAnimationFrame(function () {
        if (!isCurrentPreviewRequest()) return;
        assignImageAndLoad();
      });
    } else {
      overlay.classList.remove('closing');
      overlay.classList.add('active');
      assignImageAndLoad();
    }
  }

  function showVideoInPreview() {
    if (window.PhotoHlsAttach) window.PhotoHlsAttach.destroy(video);
    try {
      video.pause();
    } catch (ePv) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (ePl) {}
    video.style.visibility = 'hidden';
    var loadingEl = $('#previewLoading');
    if (loadingEl) loadingEl.classList.add('video-loading');
    showPreviewLoading();

    if (overlay && overlay.classList.contains('active')) {
      img.classList.add('switching');
      requestAnimationFrame(function () {
        if (!isCurrentPreviewRequest()) return;
        img.style.display = 'none';
        img.removeAttribute('src');
        img.classList.remove('switching');
        video.style.display = '';
      });
    } else {
      if (overlay) overlay.classList.remove('closing');
      if (overlay) overlay.classList.add('active');
      img.style.display = 'none';
      img.removeAttribute('src');
      video.style.display = '';
    }

    loadWebVideoForPreview(photo, video, index, requestSeq, wasOverlayActive);
  }

  if (isVideo) showVideoInPreview();
  else showImageInPreview();
  if (!wasOverlayActive) {
    setPreviewMobileUiHidden(false);
    setMobilePreviewNavVisible(false);
  }
  if (!wasOverlayActive) {
    pushPreviewHistoryState();
  }

  syncFullscreenButton();

  // 更新预览面板收藏按钮
  var favBtn2 = $('#previewFavoriteBtn');
  if (favBtn2) {
    var isFav2 = !!(photo && photo.is_favorite);
    favBtn2.classList.toggle('active', isFav2);
    favBtn2.title = isFav2 ? '取消收藏' : '收藏';
  }

  // 编辑三连的显隐随当前这张走（视频不亮；裁剪进行中只留裁剪按钮）
  syncPreviewEditButtons(photo);

  // 组织元数据（标记 / 评分 / 标签）：工具条按钮的亮灭与标签面板随当前这张走。
  // 🔴 这里是唯一的切图出口（与桌面端 openPreview 里那一步同一条纪律）。
  syncWebPreviewOrgMeta(photo);

  // 若信息面板已打开，自动刷新信息
  var infoPanel2 = $('#previewInfoPanel');
  if (infoPanel2 && infoPanel2.classList.contains('open')) {
    loadPreviewInfoPanel(photo);
  }

  preloadAdjacentPages(index);
}

/**
 * 用户**主动关预览**（遮罩点击 / 下拉关闭 / Esc / 关闭按钮）的统一入口。
 * 🔴 必须走守卫：待保存的编辑只活在内存里，不问一句就关 = 无声丢掉。
 * ⚠️ 历史回退那条 `closePreview(true)` **刻意不走这里** —— 那是浏览器后退触发的，
 *    在 popstate 里弹框会把返回键变成「卡住」。
 */
function guardedClosePreview() {
  guardPendingPreviewEdit(function () {
    closePreview();
  });
}

function closePreview(fromHistory) {
  // 裁剪选区是挂在 body 上的独立层，不随预览层一起消失 —— 关预览前必须显式收掉，
  // 否则会留下一个没有图片垫底的选框在屏上（切回列表页也还在）。
  if (webPreviewCrop && webPreviewCrop.isActive && webPreviewCrop.isActive()) webPreviewCrop.exit();
  // 关预览 = 待保存的编辑作废（用户主动关的那条路径已经由 `guardedClosePreview()`
  // 问过了；这里是兜底，防止别的调用点漏清）。
  resetPreviewPendingEdit();
  if (!fromHistory) {
    try {
      var hs = window.history.state;
      if (hs && hs.previewOpen) {
        // 用 replaceState 去掉 preview 标记，避免 history.back 异步触发 popstate
        // 导致整页 applyHistoryStateToView + loadPhotos（骨架屏、体感卡住）且易与页码不同步
        window.history.replaceState(getViewHistoryState(), '', window.location.href);
      }
    } catch (eHs) {}
  }
  state.previewRequestSeq++;
  state.previewRandomPositionNum = 0;
  state.slideshowRandomBatch = [];
  state.slideshowRandomBatchPos = 0;
  state.slideshowRandomBatchRound = 0;
  // 组织元数据：「整理」抽屉跟着预览层一起收（它是浮层里的滑出抽屉，
  // 不是模态 —— 留着会在下次打开预览时先浮在没有图片垫底的屏上）。
  closeWebPreviewOrgPanel();
  var swipeHint = $('#previewSwipeHint');
  if (swipeHint) swipeHint.classList.remove('show');
  if (state.previewSwipeHintTimer) {
    clearTimeout(state.previewSwipeHintTimer);
    state.previewSwipeHintTimer = null;
  }
  if (state.previewImageLoadSafetyTimer) {
    try {
      clearTimeout(state.previewImageLoadSafetyTimer);
    } catch (eImgT) {}
    state.previewImageLoadSafetyTimer = null;
  }
  stopSlideshow();
  exitPreviewFullscreen();
  closePreviewInfoPanel();
  setPreviewMobileUiHidden(false);
  setMobilePreviewNavVisible(false);
  // 关预览时兜底清一次全屏浮层态：exitFullscreen 的 fullscreenchange 是异步的，
  // 若这次退出全屏没有触发事件，残留的 is-fullscreen 会让下次窗口化预览的浮层控件消失。
  syncPreviewFullscreenChrome();
  var overlay = $('#previewOverlay');
  var previewBody = document.querySelector('.preview-body');
  if (previewBody) {
    previewBody.style.transform = '';
    previewBody.style.opacity = '';
  }
  var video = $('#previewVideo');
  if (video) {
    if (window.PhotoHlsAttach) window.PhotoHlsAttach.destroy(video);
    try {
      video.pause();
    } catch (e) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (e2) {}
    video.style.display = 'none';
  }
  // Live Photo 的叠加层必须和主播放器一起收干净，否则关掉预览后动态还在后台播。
  stopWebLivePlayback();
  var imgEl = $('#previewImage');
  if (imgEl) {
    imgEl.style.display = '';
    imgEl.style.visibility = '';
  }
  var loader = $('#previewLoading');
  if (loader) loader.classList.remove('show');
  if (overlay) {
    overlay.classList.add('closing');
    setTimeout(function () {
      overlay.classList.remove('active', 'closing');
      var closingImg = $('#previewImage');
      if (closingImg) closingImg.src = '';
      resetZoom();
    }, 280);
  }
}

function buildPreviewNextApiParams(currentId, direction, mode) {
  var slideshowRandom = mode === 'random';
  if (slideshowRandom) {
    var paramsRand =
      'currentId=' +
      encodeURIComponent(currentId) +
      '&view=all' +
      '&sortBy=' +
      encodeURIComponent(state.sortBy || 'date_taken') +
      '&sortOrder=' +
      encodeURIComponent(state.sortOrder || 'DESC') +
      '&mediaType=image' +
      '&direction=' +
      encodeURIComponent(direction || 'next') +
      '&mode=random';
    if (state.slideshowRandomSeed) {
      paramsRand += '&seed=' + encodeURIComponent(state.slideshowRandomSeed);
    }
    return paramsRand;
  }
  var media = state.mediaFilter && state.mediaFilter !== 'all' ? state.mediaFilter : 'all';
  var params =
    'currentId=' +
    encodeURIComponent(currentId) +
    '&view=' +
    encodeURIComponent(state.currentView || 'all') +
    '&sortBy=' +
    encodeURIComponent(state.sortBy || 'date_taken') +
    '&sortOrder=' +
    encodeURIComponent(state.sortOrder || 'DESC') +
    '&mediaType=' +
    encodeURIComponent(media) +
    '&direction=' +
    encodeURIComponent(direction || 'next') +
    '&mode=' +
    encodeURIComponent(mode || 'sequential');
  if (state.currentView === 'root' && state._rootId) {
    params += '&rootId=' + encodeURIComponent(state._rootId);
  } else if (state.currentView === 'folder' && state.currentPath) {
    params += '&path=' + encodeURIComponent(state.currentPath);
  } else if (state.currentView === 'date' && state.currentDate) {
    params += '&date=' + encodeURIComponent(state.currentDate);
  } else if (state.currentView === 'search' && state.searchQuery) {
    params += '&q=' + encodeURIComponent(state.searchQuery);
  }
  return params;
}

/** 与网页端随机 preview-next 一致：全库图片 view=all */
function buildPreviewRandomBatchQuery(excludeIds) {
  var params =
    'view=all&mediaType=image&limit=100' +
    '&sortBy=' +
    encodeURIComponent(state.sortBy || 'date_taken') +
    '&sortOrder=' +
    encodeURIComponent(state.sortOrder || 'DESC');
  var ex = Array.isArray(excludeIds)
    ? excludeIds.filter(function (id) {
        return id > 0;
      })
    : [];
  if (ex.length) params += '&excludeIds=' + encodeURIComponent(ex.join(','));
  return params;
}

function mulberry32Web(seed) {
  var a = seed >>> 0;
  return function () {
    var t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWebSlideshowBatch(arr, seed) {
  if (!arr || arr.length < 2) return;
  var rng = mulberry32Web(seed >>> 0);
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

async function advanceWebSlideshowRandomBatch() {
  if (!state.slideshowRandom) return false;
  try {
    if (state.slideshowRandomBatchPos >= state.slideshowRandomBatch.length) {
      var cur = state.previewPhotos[state.previewIndex];
      var ex = [];
      if (cur && cur.id) ex.push(Number(cur.id));
      var q = buildPreviewRandomBatchQuery(ex);
      var r = await Promise.race([
        apiGet('/api/preview-random-batch?' + q),
        new Promise(function (_, rej) {
          setTimeout(function () {
            rej(new Error('timeout'));
          }, PREVIEW_ADJACENT_TIMEOUT_MS);
        }),
      ]);
      var rows = r && r.photos ? r.photos : [];
      if (!rows.length) {
        state.slideshowRandomBatch = [];
        state.slideshowRandomBatchPos = 0;
        return false;
      }
      state.slideshowRandomBatch = rows.slice();
      shuffleWebSlideshowBatch(
        state.slideshowRandomBatch,
        (state.slideshowRandomSeed + state.slideshowRandomBatchRound++) >>> 0,
      );
      state.slideshowRandomBatchPos = 0;
    }
    if (state.slideshowRandomBatchPos >= state.slideshowRandomBatch.length) return false;
    var photo = state.slideshowRandomBatch[state.slideshowRandomBatchPos++];
    if (!photo || !photo.id) return false;
    openPreviewByPhotoRecord(photo);
    return true;
  } catch (eBatch) {
    return false;
  }
}

function openPreviewByPhotoRecord(photo) {
  if (!photo || !photo.id) return;
  var idx = -1;
  for (var i = 0; i < state.previewPhotos.length; i++) {
    if (Number(state.previewPhotos[i] && state.previewPhotos[i].id) === Number(photo.id)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    state.previewPhotos.push(photo);
    idx = state.previewPhotos.length - 1;
  } else {
    state.previewPhotos[idx] = photo;
  }
  openPreview(idx);
}

// === 图片编辑：预览态编辑（先预览、点「保存」才写回）===
//
// 与桌面端 `src/renderer/app.js` 是**两份实现**（网页端拿不到渲染端模块），行为必须一致。
// 差别只在通道：桌面端走 preload 的 IPC，网页端 POST `/api/photo-edit-apply`。
//
// 语义（两端同一套）：
//   · 点旋转 / 翻转 / 裁剪**只改预览**，攒进 `state.previewEditPendingActions` /
//     `webPreviewCrop` 的已确认选区；工具条随即亮出「保存 / 放弃」。
//   · 点「保存」= 一次请求把「动作串 + 裁剪 rect」发给后端（`photo-edit-service#applyEdit`）。
//
// 🔴 保存成功后必须更新 `photo.file_size` / `photo.date_modified` 两个字段：
//    预览与原图的 URL 缓存键就是 `photoCacheVersion(photo)` 取这两个字段（见文件头）。
//    不更新 ⇒ 新旧 URL 一模一样 ⇒ 浏览器命中旧缓存、**界面上还是编辑前的图** ——
//    用户会以为没生效、再点一次，于是又转了 90°。这是这一层唯一的静默陷阱。
//
// 🔴 尺寸取**后端返回的真实值**（`r.width` / `r.height`），不要拿 `naturalWidth` 去推：
//    90/270 档宽高对调、翻转不改尺寸、EXIF 方向还要先归一化，组合有十几种情形。

/** POST 一个 JSON 并解析 JSON 回包；401 跳登录，非 JSON 当协议错。 */
function webPostJson(url, body) {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (r) {
    if (r.status === 401) {
      try {
        window.location.href = '/login';
      } catch (e) {}
      throw new Error('auth');
    }
    return r
      .json()
      .catch(function () {
        // 服务端崩了/被代理换了页面：给出带状态码的错误，别让 UI 静默什么都不做
        throw new Error('http_' + r.status);
      })
      .then(function (j) {
        return j;
      });
  });
}

/**
 * 四个编辑动作 → **原样的 CSS 变换函数**。
 *
 * 🔴 刻意不做「角度 + 镜像位」的合成：CSS 的求值顺序（最右先作用 ⇒ 先镜像、后旋转）
 *    与 sharp 的算子顺序**同构**，所以把用户点的动作按**逆序**原样拼进 transform 就与
 *    后端 `image-edit.js#planEditSequence` 逐像素等价。前端再写一份代数 = 多一份会悄悄漂移的实现。
 *    （与桌面端 `src/renderer/app.js` 的同名对象逐字相同，回归脚本会逐字对账。）
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
 * 只用来回答「布局要不要给转过来的图留空间」（90 的奇数倍才要）。
 * 镜像会把角度取反，但 `-a ≡ a (mod 180)` ⇒ 镜像动作**不改变**这一位，所以求和就够。
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
  return !!(webPreviewCrop && webPreviewCrop.isPending && webPreviewCrop.isPending());
}

/** 丢掉所有待保存的编辑（含已确认的裁剪选区）。**不碰磁盘**。 */
function clearPreviewPendingEdit() {
  state.previewEditPendingActions = [];
  state.previewEditCssTail = '';
  state.previewEditRotateDeg = 0;
  if (webPreviewCrop && webPreviewCrop.isActive && webPreviewCrop.isActive()) webPreviewCrop.exit();
}

/** 把待保存状态重画到界面上（图片变换 + 工具条）。 */
function repaintPreviewEdit() {
  state.previewEditCssTail = previewEditCssTail(state.previewEditPendingActions);
  state.previewEditRotateDeg = previewEditAngleHint(state.previewEditPendingActions);
  updatePreviewTransform();
  syncPreviewEditButtons(state.previewPhotos && state.previewPhotos[state.previewIndex]);
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
 *    不问就切图 = 用户按了三下旋转、按了下方向键，那三下**无声消失**。
 */
function guardPendingPreviewEdit(next) {
  if (!hasPendingPreviewEdit()) {
    next();
    return;
  }
  // 网页端没有自己的确认弹窗组件（`people.js` 等处同样用原生 confirm），
  // 这里也不为了一个「要不要放弃」去引入一套新的模态层。
  if (!window.confirm('离开会丢弃当前未保存的旋转 / 翻转 / 裁剪，确定要放弃吗？')) return;
  resetPreviewPendingEdit();
  next();
}

/**
 * 编辑按钮只在静止图片上亮；视频不做编辑（后端也会拒）。
 * 「保存 / 放弃」只在**有东西可保存**时亮（空着点一下等于点了没反应）。
 */
function syncPreviewEditButtons(photo) {
  var isVideo = !!(photo && isWebVideoFileType(photo.file_type));
  var ids = ['previewRotateBtn', 'previewFlipBtn', 'previewCropBtn', 'previewEditSaveBtn', 'previewEditDiscardBtn'];
  // 裁剪进行中不允许再点别的编辑（否则选区会被半路换掉）
  var cropping = webPreviewCrop.isActive();
  var pendingCrop = webPreviewCrop.isPending();
  var pending = hasPendingPreviewEdit();
  for (var i = 0; i < ids.length; i++) {
    var btn = $('#' + ids[i]);
    if (!btn) continue;
    var hide = isVideo;
    if (!hide && cropping && ids[i] !== 'previewCropBtn') hide = true;
    // 已确认的裁剪选区在场时连裁剪键也收掉：再进一次裁剪只会把选区重来一遍
    if (!hide && pendingCrop && ids[i] === 'previewCropBtn') hide = true;
    if (!hide && (ids[i] === 'previewEditSaveBtn' || ids[i] === 'previewEditDiscardBtn') && !pending) {
      hide = true;
    }
    if (hide) btn.setAttribute('hidden', 'hidden');
    else btn.removeAttribute('hidden');
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
  if (isWebVideoFileType(photo.file_type)) {
    showToast('视频不支持编辑');
    return;
  }
  // 已选好裁剪区域时先挡住：裁剪 rect 用的是「变换后那张图」的坐标系，
  // 再转一下 rect 就指向别的地方了（而后端照样会照做，不会报错）。
  if (webPreviewCrop.isPending()) {
    showToast('请先保存或放弃已选好的裁剪区域');
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
function previewRotateAction(e) {
  return applyPreviewEdit(e && e.shiftKey ? 'rotate-left' : 'rotate-right');
}

/** 翻转（预览）；Shift = 垂直翻转。 */
function previewFlipAction(e) {
  return applyPreviewEdit(e && e.shiftKey ? 'flip-v' : 'flip-h');
}

/** 放弃所有待保存的编辑（不碰磁盘）。 */
function discardPreviewEditAction() {
  if (!hasPendingPreviewEdit()) return;
  resetPreviewPendingEdit();
  showToast('已放弃未保存的编辑');
}

/** 裁剪（预览）：进入选区模式，确认后**只记录**选区。 */
function previewCropAction() {
  var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
  if (!photo || !photo.id) return false;
  if (isWebVideoFileType(photo.file_type)) {
    showToast('视频不支持编辑');
    return false;
  }
  if (webPreviewCrop.isPending()) {
    showToast('请先保存或放弃已选好的裁剪区域');
    return false;
  }
  // 🔴 进裁剪前先把 zoom/pan 归位：选区换算只做一次「视口 → 图片像素」的线性映射，
  //    带着缩放进来选框会远远超出图片在屏上的那块（`.preview-body` 是 overflow: hidden，
  //    而选框层挂在 body 上、不受它裁剪）—— 看起来就是「框跑到画面外」。
  resetZoom();
  return webPreviewCrop.enter({
    photo: photo,
    getPreviewAngle: function () {
      return state.previewEditRotateDeg || 0;
    },
    onStateChange: function () {
      syncPreviewEditButtons(photo);
    },
    onCommit: function () {
      // 🔴 只记录，不落盘、不入库。写回统一在 `savePreviewEdit()`。
      syncPreviewEditButtons(photo);
      showToast('已选好裁剪区域，点「保存」写回');
    },
  });
}

/**
 * 保存：把「待保存的动作串 + 已确认的裁剪选区」**一次请求**发给后端。
 *
 * 🔴 必须是一次请求而不是两次（先 transform 再 crop）：裁剪 rect 用的是**变换之后**
 *    那张图的坐标系，两次请求之间会从服务队列里让出，另一端（桌面端）可能插进来再改一次
 *    文件 ⇒ 裁错地方。顺序与坐标系契约收在 `photo-edit-service.js#applyEdit` 里。
 */
async function savePreviewEdit() {
  var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
  if (!photo || !photo.id) return;
  if (!hasPendingPreviewEdit()) return;

  var actions = (state.previewEditPendingActions || []).slice();
  var cropRect = webPreviewCrop.isPending() ? webPreviewCrop.pendingRect() : null;

  var r;
  try {
    r = await webPostJson('/api/photo-edit-apply', {
      id: photo.id,
      actions: actions,
      crop: cropRect,
    });
  } catch (eCall) {
    showToast(String((eCall && eCall.message) || eCall));
    return;
  }
  if (!r || !r.success) {
    showToast((r && r.error) || '编辑失败');
    return;
  }

  resetPreviewPendingEdit();

  if (r.crop && r.crop.id) {
    // 裁剪产出的是**另一条照片行**（新 id）⇒ 必须重新拉列表拿到新行再切过去，
    // 否则用户看不到自己刚裁出来的图。新行**从列表里取**，不要自己拼（列清单会漂移）。
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
      showToast('裁剪副本已保存');
    }
  } else {
    if (typeof r.size === 'number') photo.file_size = r.size;
    if (r.dateModified) photo.date_modified = r.dateModified;
    if (typeof r.width === 'number') photo.width = r.width;
    if (typeof r.height === 'number') photo.height = r.height;
    // 重开当前张：缓存键已变 ⇒ 会真的重新取图
    openPreview(state.previewIndex);
  }
  showToast('已保存');
}

// 🔴 这三个只被 `src/web/index.html` 里的内联 `onclick` 调用（与 `toggleSlideshow()` /
//    `closePreview()` 同一套风格）。顶层 `function` 声明本来就在全局上，但**显式挂一次**
//    更清楚：既说明「这是给 HTML 用的入口」，也让 lint 看得见调用点，不再报 unused。
window.previewRotateAction = previewRotateAction;
window.previewFlipAction = previewFlipAction;
window.previewCropAction = previewCropAction;
window.previewEditSaveAction = savePreviewEdit;
window.previewEditDiscardAction = discardPreviewEditAction;
window.guardedWebClosePreview = guardedClosePreview;

/**
 * 预览里的**裁剪选区**（网页端 UI 部分）。
 *
 * 本模块只负责「让用户画出一个矩形」并把**图片像素坐标**交出去；
 * 真正落盘 + 入库在 `photo-edit-service.js#applyEdit`（经 `savePreviewEdit` 调用）。
 *
 * 🔴 与桌面端 `src/renderer/preview-crop.js` 是**两份实现**（两端各存一份），
 *    行为必须一致：初始选区居中 80%、最小边长 24、四角改边、窗口 resize 即退出
 *    （已确认的选区改为跟着重排）、Esc 取消 / 回车确认、
 *    交出去的 rect 是**用户看到的图**的像素坐标（EXIF 已转正 + 已叠上待保存的旋转/翻转）。
 *
 * 几条刻意的取舍：
 *   · 遮罩用 `.preview-crop-box` 的 `box-shadow: 0 0 0 9999px` 画，而不是铺四块暗区：
 *     选区一改，暗区自动跟着变，没有「四个 div 的尺寸要同时更新」这种会漂移的状态。
 *   · 层用 `position: fixed` + 视口坐标：`.preview-body` 这条链上有 transform / overflow，
 *     用 absolute 会因定位上下文不同而算错（而算错的表现是「框和图片错位」）。
 *   · 进入裁剪时**强制把 zoom/pan 归位**：坐标换算只做一次 `client → 像素` 的线性映射，
 *     带着缩放平移再换算，等于每个拖动事件都要重解一次逆变换。
 *   · 裁剪期间是**模态键盘态**：吞掉所有 keydown 的传播（预览自己的 Esc/方向键/空格
 *     处理器在 `document` 上、冒泡阶段）。不吞的话按一下 → 图换了、选框还留在原地。
 *
 * 🔴 **不能拿 `img.getBoundingClientRect()` 当「图片的显示盒」**：`.preview-img` 是
 *    `object-fit: contain` 之类的撑满容器布局，元素盒 ≠ 图片占据的那块。实测（桌面端
 *    `.workbuddy/tmp/preview-geom-probe.js`）：1178×719 的元素盒里放一张 400×300 的图，
 *    图实际只占 958×719。直接量元素盒 ⇒ 选框盖住整块舞台、缩放算小 19%。
 *    见 `webPreviewCrop._viewRect()`。
 */
var webPreviewCrop = (function () {
  'use strict';

  var MIN_SIZE = 24; // 选区最小边长（视口像素）

  var session = null;

  function isActive() {
    return !!session;
  }

  /** 选区已确认、正等用户点「保存」/「放弃」。 */
  function isPending() {
    return !!session && !!session.committed;
  }

  /** 已确认的选区（**图片像素**坐标）；没确认过返回 `null`。 */
  function pendingRect() {
    if (!isPending()) return null;
    var r = session.rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function isQuarterTurn(angle) {
    var a = (((angle | 0) % 360) + 360) % 360;
    return a === 90 || a === 270;
  }

  /**
   * 量出「图片真正占据的视觉矩形」（视口坐标，含 contain 留白、旋转与当前 zoom）。
   * `scaleX/scaleY` 把「视觉 px」换成「变换后图片 px」。与桌面端 `viewRect()` 同算法。
   */
  function viewRect(el, angle) {
    if (!el) return null;
    var nw = el.naturalWidth;
    var nh = el.naturalHeight;
    var bw = el.offsetWidth;
    var bh = el.offsetHeight;
    if (!nw || !nh || !bw || !bh) return null;

    var s = Math.min(bw / nw, bh / nh);
    var cw = nw * s;
    var ch = nh * s;

    var rot = isQuarterTurn(angle);
    var vw = rot ? ch : cw;
    var vh = rot ? cw : ch;

    var r = el.getBoundingClientRect();
    var zx = bw ? r.width / (rot ? bh : bw) : 1;
    var zy = bh ? r.height / (rot ? bw : bh) : 1;
    if (!(zx > 0)) zx = 1;
    if (!(zy > 0)) zy = 1;
    vw *= zx;
    vh *= zy;

    var postW = rot ? nh : nw;
    var postH = rot ? nw : nh;

    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    return {
      left: cx - vw / 2,
      top: cy - vh / 2,
      width: vw,
      height: vh,
      scaleX: postW / vw,
      scaleY: postH / vh,
    };
  }

  function previewAngle() {
    var fn = session && session.options.getPreviewAngle;
    return typeof fn === 'function' ? fn() | 0 : 0;
  }

  function measure() {
    var s = session;
    if (!s) return false;
    var v = viewRect(s.img, previewAngle());
    if (!v || !(v.width > 0) || !(v.height > 0)) return false;
    s.view = v;
    s.layer.style.left = v.left + 'px';
    s.layer.style.top = v.top + 'px';
    s.layer.style.width = v.width + 'px';
    s.layer.style.height = v.height + 'px';
    return true;
  }

  function paint() {
    if (!session || !session.view) return;
    var s = session.sel;
    session.box.style.left = s.left + 'px';
    session.box.style.top = s.top + 'px';
    session.box.style.width = s.width + 'px';
    session.box.style.height = s.height + 'px';

    // 提示里显示的是**图片像素**尺寸（用户关心的是裁出来多大，不是屏幕上多大）
    var view = session.view;
    var pw = Math.round(s.width * view.scaleX);
    var ph = Math.round(s.height * view.scaleY);
    var hint = session.committed ? '已选好裁剪区域 · 回车保存 / Esc 取消' : '回车确认 / Esc 取消';
    session.hint.textContent = pw + ' × ' + ph + '  ·  ' + hint;
  }

  /** 由**图片像素**的 rect 反推视觉坐标的 sel（已确认态在窗口尺寸变化后重排用）。 */
  function selFromRect(rect, view) {
    return {
      left: Math.round(rect.left / view.scaleX),
      top: Math.round(rect.top / view.scaleY),
      width: Math.round(rect.width / view.scaleX),
      height: Math.round(rect.height / view.scaleY),
    };
  }

  function unbind() {
    var s = session;
    if (!s) return;
    if (s.onMove) document.removeEventListener('mousemove', s.onMove);
    if (s.onUp) document.removeEventListener('mouseup', s.onUp);
    if (s.onKey) window.removeEventListener('keydown', s.onKey, true);
    if (s.onResize) window.removeEventListener('resize', s.onResize);
  }

  /** 退出并清理（不提交）。 */
  function exit() {
    var s = session;
    if (!s) return;
    session = null;
    unbind();
    if (s.layer && s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
    if (typeof s.options.onStateChange === 'function') s.options.onStateChange(false);
  }

  /** 把当前选区换算成**图片像素**坐标并交给调用方。 */
  function currentRect() {
    if (!session || !session.view) return null;
    var s = session;
    var view = s.view;
    return {
      left: Math.round(s.sel.left * view.scaleX),
      top: Math.round(s.sel.top * view.scaleY),
      width: Math.round(s.sel.width * view.scaleX),
      height: Math.round(s.sel.height * view.scaleY),
    };
  }

  /**
   * 选区确认 —— 🔴 **不落盘、不入库、不调后端**。
   *
   * 只把 rect 记下来、把这一层转成「非模态的预览态」：
   *   · `is-pending` 让它 `pointer-events: none` ⇒ 工具条上的「保存 / 放弃」点得到；
   *   · 键盘只剩 Esc（退回可调整），其余放行 ⇒ 预览自己的按键重新生效；
   *   · 遮罩与三分线保留 ⇒ 用户看到的仍然是「将要裁出来的那一块」。
   */
  function commit() {
    var s = session;
    if (!s || s.committed) return;
    var rect = currentRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
    s.rect = rect;
    s.committed = true;
    s.layer.classList.add('is-pending');
    paint();
    if (typeof s.options.onCommit === 'function') s.options.onCommit(rect);
  }

  /** 从「已确认」退回「可调整」（Esc 的第一下）。 */
  function resume() {
    var s = session;
    if (!s || !s.committed) return;
    s.committed = false;
    s.rect = null;
    s.layer.classList.remove('is-pending');
    paint();
    if (typeof s.options.onStateChange === 'function') s.options.onStateChange(true);
  }

  function bindKeys() {
    var s = session;
    if (!s || s.onKey) return;
    s.onKey = function (e) {
      if (!session || session !== s) return;
      /**
       * 🔴 通用弹窗打开时必须让路：它同样把 keydown 挂在 window **捕获**阶段，
       * 而本监听注册得更早 ⇒ 不让路的话弹窗的 Esc / 回车会被这里先吃掉，
       * 表现是「弹窗弹出来了、按什么都没反应」。
       * 触发场景真实存在：待保存编辑在场时按方向键切图会弹出「放弃未保存的编辑？」。
       */
      var dialog = document.getElementById('appDialogOverlay');
      if (dialog && dialog.classList.contains('show')) return;
      if (s.committed) {
        // 已确认态**刻意不是模态**：只接管 Esc（退回可调整），其余键一律放行 ——
        // 工具条上的「保存 / 放弃」、Ctrl+S、方向键切图都要能用。
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          resume();
        }
        return;
      }
      // 模态：不让预览自己的键盘处理器（document / 冒泡阶段）看到任何一个键。
      // 只 stopPropagation 不改默认行为 ⇒ 浏览器快捷键（F5 / Ctrl+R）照常。
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    };
    // 捕获阶段：抢在预览自己的键盘处理（切图 / 关闭）之前
    window.addEventListener('keydown', s.onKey, true);
  }

  function bind() {
    var s = session;
    if (!s) return;

    s.layer.addEventListener('mousedown', function (e) {
      if (s.committed) return;
      var corner = e.target && e.target.getAttribute ? e.target.getAttribute('data-corner') : null;
      var isBox = e.target === s.box;
      if (!corner && !isBox) return;
      e.preventDefault();
      e.stopPropagation();
      s.drag = {
        mode: corner || 'move',
        startX: e.clientX,
        startY: e.clientY,
        from: {
          left: s.sel.left,
          top: s.sel.top,
          width: s.sel.width,
          height: s.sel.height,
        },
      };
      document.addEventListener('mousemove', s.onMove);
      document.addEventListener('mouseup', s.onUp);
    });

    s.onMove = function (e) {
      if (!s.drag) return;
      var d = s.drag;
      var dx = e.clientX - d.startX;
      var dy = e.clientY - d.startY;
      var f = s.view;
      var l = d.from.left;
      var t = d.from.top;
      var w = d.from.width;
      var h = d.from.height;

      if (d.mode === 'move') {
        l = clamp(d.from.left + dx, 0, Math.max(0, f.width - w));
        t = clamp(d.from.top + dy, 0, Math.max(0, f.height - h));
      } else {
        // 四角：改两条边。用「哪条边」而不是「算新中心」，边界条件才写得清。
        var right = d.from.left + d.from.width;
        var bottom = d.from.top + d.from.height;
        if (d.mode.indexOf('w') >= 0) l = clamp(d.from.left + dx, 0, right - MIN_SIZE);
        if (d.mode.indexOf('e') >= 0)
          right = clamp(d.from.left + d.from.width + dx, l + MIN_SIZE, f.width);
        if (d.mode.indexOf('n') >= 0) t = clamp(d.from.top + dy, 0, bottom - MIN_SIZE);
        if (d.mode.indexOf('s') >= 0)
          bottom = clamp(d.from.top + d.from.height + dy, t + MIN_SIZE, f.height);
        w = right - l;
        h = bottom - t;
      }
      s.sel = {
        left: Math.round(l),
        top: Math.round(t),
        width: Math.round(w),
        height: Math.round(h),
      };
      paint();
    };

    s.onUp = function () {
      s.drag = null;
      document.removeEventListener('mousemove', s.onMove);
      document.removeEventListener('mouseup', s.onUp);
    };

    s.onKey = null;

    s.onResize = function () {
      if (!session || session !== s) return;
      // 已确认的选区跟着重排（用户已经决定好的东西，丢掉太贵）；还在拖的选区直接退出。
      if (s.committed) {
        // 🔴 重排必须**连 sel 一起按新的换算比例重算**：`sel` 是视觉坐标，
        //    窗口一变 visual↔像素的比例就变了。只重画 layer 不动 sel ⇒ 框与裁剪区域对不上。
        if (measure()) {
          s.sel = selFromRect(s.rect, s.view);
          paint();
        }
        return;
      }
      exit();
    };
    window.addEventListener('resize', s.onResize);

    bindKeys();
  }

  /**
   * 进入裁剪模式。
   *
   * @param {object} options
   * @param {function} options.getPreviewAngle 返回当前预览态里叠加的旋转角（0/90/180/270）
   * @param {function} options.onCommit 选区确认（**不落盘**）：入参是像素坐标
   * @param {function} [options.onStateChange] 进入/退出时回调（用来置灰别的编辑按钮）
   * @returns {boolean} 是否成功进入
   */
  function enter(options) {
    options = options || {};
    if (session) return true;
    var img = $('#previewImage');
    if (!img) return false;

    // 带着 zoom/pan 时 rect 虽然也能换算，但拖动过程中每一帧都要重解逆变换；
    // 归位一次，后面只做线性映射。必须在测量之前调用（它会改布局）。
    resetZoom();

    var layer = document.createElement('div');
    layer.className = 'preview-crop-layer';

    var box = document.createElement('div');
    box.className = 'preview-crop-box';
    var corners = ['nw', 'ne', 'se', 'sw'];
    for (var i = 0; i < corners.length; i++) {
      var h = document.createElement('span');
      h.className = 'preview-crop-handle';
      h.setAttribute('data-corner', corners[i]);
      box.appendChild(h);
    }
    layer.appendChild(box);

    var hint = document.createElement('div');
    hint.className = 'preview-crop-hint';
    layer.appendChild(hint);

    document.body.appendChild(layer);

    session = {
      layer: layer,
      box: box,
      hint: hint,
      img: img,
      options: options,
      view: null,
      sel: { left: 0, top: 0, width: 0, height: 0 },
      rect: null,
      committed: false,
      drag: null,
      onMove: null,
      onUp: null,
      onKey: null,
      onResize: null,
    };

    if (!measure()) {
      // 图还没解码完 / 量不出尺寸 —— 别留一个空的模态层在屏上
      exit();
      return false;
    }

    // 初始选区：居中、占 80%
    var v = session.view;
    var initW = Math.max(MIN_SIZE, Math.round(v.width * 0.8));
    var initH = Math.max(MIN_SIZE, Math.round(v.height * 0.8));
    session.sel = {
      left: Math.round((v.width - initW) / 2),
      top: Math.round((v.height - initH) / 2),
      width: initW,
      height: initH,
    };

    paint();
    bind();

    if (typeof options.onStateChange === 'function') options.onStateChange(true);
    return true;
  }

  return {
    enter: enter,
    exit: exit,
    isActive: isActive,
    isPending: isPending,
    pendingRect: pendingRect,
    currentRect: currentRect,
    viewRect: viewRect,
  };
})();

function pickWebNextRandomSlideshowIndex() {
  if (!state.previewPhotos || state.previewPhotos.length <= 1) return -1;
  var total = state.previewPhotos.length;
  if (!Array.isArray(state.slideshowRandomPool)) state.slideshowRandomPool = [];
  if (state.slideshowRandomPool.length === 0) {
    for (var i = 0; i < total; i++) {
      if (i === state.previewIndex) continue;
      if (isWebSlideshowVideoPhoto(state.previewPhotos[i])) continue;
      state.slideshowRandomPool.push(i);
    }
    for (var j = state.slideshowRandomPool.length - 1; j > 0; j--) {
      var r = Math.floor(Math.random() * (j + 1));
      var tmp = state.slideshowRandomPool[j];
      state.slideshowRandomPool[j] = state.slideshowRandomPool[r];
      state.slideshowRandomPool[r] = tmp;
    }
  }
  var idx = state.slideshowRandomPool.shift();
  if (typeof idx !== 'number' || idx < 0 || idx >= total) return -1;
  return idx;
}

function pickWebFallbackRandomNonVideoIndex() {
  var total = state.previewPhotos.length;
  var candidates = [];
  for (var c = 0; c < total; c++) {
    if (c === state.previewIndex) continue;
    if (isWebSlideshowVideoPhoto(state.previewPhotos[c])) continue;
    candidates.push(c);
  }
  if (candidates.length === 0) return -1;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function goNextSlide() {
  if (!state.previewPhotos || state.previewPhotos.length === 0) return;
  var total = state.previewPhotos.length;
  if (state.slideshowRandom && total > 1) {
    if (state.slideshowStepLoading) return;
    state.slideshowStepLoading = true;
    try {
      var fromBatch = await advanceWebSlideshowRandomBatch();
      if (fromBatch) return;
      var current = state.previewPhotos[state.previewIndex];
      var currentId = Number(current && current.id);
      if (currentId) {
        try {
          var params = buildPreviewNextApiParams(currentId, 'next', 'random');
          var r = await Promise.race([
            apiGet('/api/preview-next?' + params),
            new Promise(function (_, rej) {
              setTimeout(function () {
                rej(new Error('timeout'));
              }, PREVIEW_ADJACENT_TIMEOUT_MS);
            }),
          ]);
          if (r && r.photo && r.photo.id && Number(r.photo.id) !== currentId) {
            openPreviewByPhotoRecord(r.photo);
            return;
          }
        } catch (eGn) {
          // ignore
        }
      }
      var nextIndex = pickWebNextRandomSlideshowIndex();
      if (nextIndex < 0) {
        nextIndex = pickWebFallbackRandomNonVideoIndex();
      }
      if (nextIndex < 0) return;
      openPreview(nextIndex);
    } finally {
      state.slideshowStepLoading = false;
    }
    return;
  }
  var nextIndex2 = -1;
  for (var step = 0; step < total; step++) {
    var cand = (state.previewIndex + 1 + step) % total;
    if (!isWebSlideshowVideoPhoto(state.previewPhotos[cand])) {
      nextIndex2 = cand;
      break;
    }
  }
  if (nextIndex2 < 0) return;
  openPreview(nextIndex2);
}

function restartSlideshowTimer() {
  if (state.slideshowTimer) {
    clearTimeout(state.slideshowTimer);
    state.slideshowTimer = null;
  }
  if (!state.slideshowPlaying) return;
  var ms = Math.max(1, state.slideshowIntervalSec) * 1000;
  function scheduleNext() {
    if (!state.slideshowPlaying) return;
    state.slideshowTimer = setTimeout(function () {
      state.slideshowTimer = null;
      if (!state.slideshowPlaying) return;
      var ret = goNextSlide();
      function after() {
        if (!state.slideshowPlaying) return;
        scheduleNext();
      }
      if (ret != null && typeof ret.then === 'function') {
        ret.then(after, after);
      } else {
        after();
      }
    }, ms);
  }
  scheduleNext();
}

function startSlideshow() {
  if (state.slideshowPlaying) return;
  state.slideshowPlaying = true;
  var btn = $('#slideshowToggleBtn');
  if (btn) btn.textContent = '\u23F8 \u6682\u505C';
  restartSlideshowTimer();
}

function stopSlideshow() {
  state.slideshowPlaying = false;
  if (state.slideshowTimer) {
    clearTimeout(state.slideshowTimer);
    state.slideshowTimer = null;
  }
  var btn = $('#slideshowToggleBtn');
  if (btn) btn.textContent = '\u25B6 \u64AD\u653E';
}

function toggleSlideshow() {
  var overlay = $('#previewOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  if (state.slideshowPlaying) stopSlideshow();
  else startSlideshow();
}

function showPreviewSwipeHint() {
  var hint = $('#previewSwipeHint');
  if (!hint) return;
  if (state.previewSwipeHintTimer) {
    clearTimeout(state.previewSwipeHintTimer);
    state.previewSwipeHintTimer = null;
  }
  hint.classList.add('show');
  state.previewSwipeHintShown = true;
  state.previewSwipeHintTimer = setTimeout(function () {
    hint.classList.remove('show');
    state.previewSwipeHintTimer = null;
  }, 1600);
}

function syncSlideshowRandomButton() {
  var btn = $('#slideshowRandomBtn');
  if (!btn) return;
  btn.classList.toggle('active', !!state.slideshowRandom);
  btn.textContent = state.slideshowRandom ? '\u968F\u673A:\u5F00' : '\u968F\u673A:\u5173';
}

function toggleSlideshowRandom() {
  var overlay = $('#previewOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  state.slideshowRandom = !state.slideshowRandom;
  state.slideshowRandomPool = [];
  state.slideshowRandomBatch = [];
  state.slideshowRandomBatchPos = 0;
  state.slideshowRandomBatchRound = 0;
  if (state.slideshowRandom) {
    state.slideshowRandomSeed = Date.now() % 2147483647;
  }
  refreshWebPreviewRandomPositionNum();
  syncSlideshowRandomButton();
  // comment cleaned
}

function syncFullscreenButton() {
  var btn = $('#previewFullscreenBtn');
  if (!btn) return;
  btn.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
}

async function togglePreviewFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      var target = $('#previewOverlay') || document.documentElement;
      if (target.requestFullscreen) await target.requestFullscreen();
    }
  } catch (e) {
    // ignore
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

function navigatePreview(dir, evt) {
  if (evt) {
    try {
      evt.preventDefault();
      evt.stopPropagation();
    } catch (eEvt) {}
  }
  // 🔴 待保存的编辑只活在内存里 ⇒ 切图前先问一句，别无声丢掉。
  //    守卫放在这里（而不是 `openPreview` 里）：`openPreview` 也被保存流程调用，
  //    在里面弹框会把调用方自己卡住。
  if (hasPendingPreviewEdit()) {
    guardPendingPreviewEdit(function () {
      navigatePreview(dir, null);
    });
    return;
  }
  // comment cleaned
  state.previewLastTapAt = 0;
  var len = state.previewPhotos.length;
  var newIndex = state.previewIndex + dir;
  if (newIndex >= 0 && newIndex < len) {
    openPreview(newIndex);
  } else if (newIndex < 0 && state.previewPageStart > 1) {
    loadPreviewAdjacentPage(-1, dir);
  } else if (newIndex >= len) {
    var tailPage = state.previewPageStart + Math.ceil(len / state.pageSize) - 1;
    if (tailPage < state.previewTotalPages) {
      loadPreviewAdjacentPage(1, dir);
    }
  }
}

async function loadPreviewAdjacentPage(pageDir, dir) {
  if (state.previewLoadingPage) return;
  var targetIndex = state.previewIndex + dir;

  var nextPage;
  if (pageDir > 0) {
    nextPage = state.previewPageStart + Math.ceil(state.previewPhotos.length / state.pageSize);
  } else {
    nextPage = state.previewPageStart - 1;
  }
  if (nextPage < 1 || nextPage > state.previewTotalPages) return;

  state.previewLoadingPage = nextPage;
  try {
    var params =
      'sortBy=' +
      state.sortBy +
      '&sortOrder=' +
      state.sortOrder +
      '&page=' +
      nextPage +
      '&pageSize=' +
      state.pageSize +
      (state.mediaFilter && state.mediaFilter !== 'all'
        ? '&mediaType=' + encodeURIComponent(state.mediaFilter)
        : '');
    var result;

    switch (state.currentView) {
      case 'tag':
        // 预览翻到标签照片的页边界：与 loadPhotos 的 tag 分支同一条 URL（顺序由索引侧定）
        result = await apiGet(
          '/api/tag-nav-photos?tag=' + encodeURIComponent(state.currentTag) + '&' + params,
        );
        break;
      case 'search':
        result = await apiGet(
          '/api/search?q=' + encodeURIComponent(state.searchQuery) + '&' + params,
        );
        break;
      case 'folder':
        result = await apiGet(
          '/api/folder-photos?path=' + encodeURIComponent(state.currentPath) + '&' + params,
        );
        break;
      case 'date':
        result = await apiGet(
          '/api/date-photos?date=' + encodeURIComponent(state.currentDate) + '&' + params,
        );
        break;
      case 'root':
        result = await apiGet('/api/photos?' + params + '&rootId=' + state._rootId);
        break;
      default:
        result = await apiGet('/api/photos?' + params);
    }

    var newPhotos = result.photos || [];
    if (newPhotos.length === 0) return;

    if (pageDir > 0) {
      state.previewPhotos = state.previewPhotos.concat(newPhotos);
    } else {
      state.previewPhotos = newPhotos.concat(state.previewPhotos);
      state.previewIndex += newPhotos.length;
      state.previewPageStart = nextPage;
      targetIndex += newPhotos.length;
    }

    // comment cleaned
    if (dir === 0) return;
    if (targetIndex < 0) targetIndex = 0;
    if (targetIndex >= state.previewPhotos.length) targetIndex = state.previewPhotos.length - 1;
    openPreview(targetIndex);
  } finally {
    state.previewLoadingPage = 0;
  }
}

function preloadAdjacentPages(index) {
  var margin = 5;
  if (index >= state.previewPhotos.length - margin) {
    var tailPage =
      state.previewPageStart + Math.ceil(state.previewPhotos.length / state.pageSize) - 1;
    if (tailPage < state.previewTotalPages) {
      loadPreviewAdjacentPage(1, 0);
    }
  }
}

// === Zoom & Pan ===
function resetZoom() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updatePreviewTransform();
}

function zoomToActual() {
  if (state.zoom !== 1) {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
  } else {
    state.zoom = 2.5;
    state.panX = 0;
    state.panY = 0;
  }
  updatePreviewTransform();
}

function applyZoom(delta) {
  state.zoom = Math.min(10, Math.max(0.2, state.zoom + delta));
  updatePreviewTransform();
}

/**
 * 把平移 / 缩放 / **预览态编辑**叠成一条 transform。
 *
 * 🔴 编辑那一段是 `state.previewEditCssTail` —— 一串**原样的 CSS 变换函数**，按用户点击的
 *    逆序拼好（见 `previewEditCssTail`）。刻意不在这里做「角度 + 镜像位」的代数合成：
 *    CSS 的求值顺序（最右先作用 = 先镜像后旋转）与 sharp 的算子顺序**同构**，
 *    原样拼进去就与后端逐像素一致；自己再写一份代数 = 多一份会悄悄漂移的实现。
 */
function updatePreviewTransform() {
  var img = $('#previewImage');
  if (!img) return;
  var tail = state.previewEditCssTail || '';
  img.style.transform =
    'translate(' +
    state.panX +
    'px, ' +
    state.panY +
    'px) scale(' +
    state.zoom +
    ')' +
    (tail ? ' ' + tail : '');
  setText('#previewZoom', Math.round(state.zoom * 100) + '%');
}

// === Utils ===
function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatSize(bytes) {
  var n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  var i = Math.floor(Math.log(n) / Math.log(1024));
  if (!isFinite(i) || i < 0) i = 0;
  if (i >= units.length) i = units.length - 1;
  var v = n / Math.pow(1024, i);
  var digits = i === 0 || v >= 100 ? 0 : 1;
  return v.toFixed(digits) + ' ' + units[i];
}

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace('T', ' ').substring(0, 16);
}

function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  var parts = dateStr.split('-');
  return parts[1] + '\u6708' + parseInt(parts[2], 10) + '\u65E5';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// === Toast 通知 ===
function showWebToast(msg, durationMs) {
  var toast = $('#webToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showWebToast._timer);
  showWebToast._timer = setTimeout(function () {
    toast.classList.remove('show');
  }, durationMs || 2000);
}

// === 图片信息面板 ===
/**
 * 🔴 右侧抽屉（图片信息 / 整理）开合时把「下一张」让开。
 *
 * 两个抽屉都是 `right: 0; width: 360px; z-index: 20`，而 `.preview-nav` 是
 * `right: 16px; z-index: 6` ⇒ 抽屉一开就把右箭头**整个**盖住：点它没反应，也不报错。
 * 与桌面端 `app.js#_syncPreviewRightDrawerClass` 逐条同源；CSS 在 `index.html` 里
 * `.preview-overlay.has-right-drawer .preview-next` 那条。本函数是**唯一**的写点。
 */
function _syncWebPreviewRightDrawerClass() {
  // 🔴 类挂在 `#previewOverlay`（不是 `.preview-body`）：要让位的两个东西里，
  //    `.preview-next` 在里面、`.preview-zoom-box` 在外面。
  var overlay = $('#previewOverlay');
  if (!overlay) return;
  var info = $('#previewInfoPanel');
  var org = $('#previewOrgPanel');
  overlay.classList.toggle(
    'has-right-drawer',
    !!((info && info.classList.contains('open')) || (org && org.classList.contains('open'))),
  );
}

/** 收起图片信息抽屉。**唯一的收起点**：开关按钮、点外部、Esc、以及「打开整理抽屉」都走这里。 */
function closePreviewInfoPanel() {
  var panel = $('#previewInfoPanel');
  if (!panel || !panel.classList.contains('open')) return;
  panel.classList.remove('open');
  _removePreviewInfoPanelListeners();
  _syncWebPreviewRightDrawerClass();
}

function togglePreviewInfoPanel() {
  var panel = $('#previewInfoPanel');
  if (!panel) return;
  var isOpen = panel.classList.contains('open');
  if (isOpen) {
    closePreviewInfoPanel();
  } else {
    // 🔴 与「整理」抽屉互斥：两者都是贴右侧的滑出抽屉，同时打开会叠在一起。
    closeWebPreviewOrgPanel();
    panel.classList.add('open');
    _syncWebPreviewRightDrawerClass();
    var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
    if (photo) loadPreviewInfoPanel(photo);
    // delay to avoid closing immediately from the same click event
    setTimeout(_addPreviewInfoPanelListeners, 0);
  }
}

function _closePreviewInfoPanelOnOutside(e) {
  var panel = $('#previewInfoPanel');
  var toggle = $('#previewInfoToggle');
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

/**
 * 「图片信息」面板显示哪些字段。
 *
 * 字段清单本身在共享注册表 `window.PhotoInfoFields`（`/js/photo-info-fields.js`）里，
 * 桌面端与网页端同一份；**勾选结果**同样以桌面端为唯一入口，这里通过 `/api/info-fields`
 * 只读过来。拿不到就留 null → 注册表用默认集，于是网页端不会因为接口异常变空面板。
 * 缓存按「每次打开面板刷新」失效，桌面端刚改完再打开面板就能看到。
 */
var previewInfoFieldsCache = null;

async function refreshPreviewInfoFields() {
  try {
    var r = await apiGet('/api/info-fields');
    if (r && Array.isArray(r.fields)) previewInfoFieldsCache = r.fields;
  } catch (e) {
    // 保持 null / 上次的值，不回退成空数组 —— 那会让面板整块空白
  }
  return previewInfoFieldsCache;
}

/**
 * 面板加载代号：切图比接口回包快时，上一张的回包必须被丢掉。
 *
 * 这个函数是 async 且内有多次 await（/api/photo-info、/api/photo-ai-tags），
 * 两次调用会交错 —— 没有代号时「最后一次 render」不一定是「最后一张图片」的读数，
 * 表现是面板显示 B 的图片配 A 的读数，不报错。
 */
var previewInfoLoadSeq = 0;

async function loadPreviewInfoPanel(photo) {
  var contentEl = $('#previewInfoPanelContent');
  if (!contentEl) return;
  var seq = ++previewInfoLoadSeq;
  var fieldsApi = window.PhotoInfoFields;
  if (!fieldsApi) {
    contentEl.innerHTML = '<div class="preview-info-empty">图片信息模块未加载</div>';
    return;
  }

  // 最近一次上屏的数据：/api/info-fields 回来晚于首屏时用它重画，避免闪一下再消失
  var lastInfo = null;

  function render(info) {
    // 🔴 已经切到别的图片了 ⇒ 这张的回包直接丢（否则面板会「显示 B、读数是 A」）
    if (seq !== previewInfoLoadSeq) return;
    lastInfo = info;
    contentEl.innerHTML = fieldsApi.buildSectionsHtml(info, {
      fields: previewInfoFieldsCache,
      // 网页端预览没有「第几张 / 共几张」读数 → 不给 position，注册表会跳过「浏览」分组
      position: '',
      // 网页端样式依赖这个容器（桌面端没有）
      sectionBody: true,
    });
  }

  // 先用 photo 对象中已有的基础信息立即渲染，避免空白
  var baseInfo = {
    id: photo.id,
    file_name: photo.file_name || '',
    file_path: photo.file_path || '',
    folder_path: photo.folder_path || '',
    file_type: photo.file_type || '',
    width: photo.width || photo.pixel_width || photo.file_width || 0,
    height: photo.height || photo.pixel_height || photo.file_height || 0,
    file_size: photo.file_size || 0,
    date_taken: photo.date_taken || '',
    date_modified: photo.date_modified || '',
    is_favorite: photo.is_favorite,
  };
  render(baseInfo);

  try {
    var apiInfo = await apiGet('/api/photo-info?id=' + photo.id);
    if (apiInfo && !apiInfo.error) {
      // API 返回的数据合并到基础信息中，覆盖已有字段
      var merged = {};
      for (var k in baseInfo) merged[k] = baseInfo[k];
      for (var k2 in apiInfo) merged[k2] = apiInfo[k2];
      render(merged);
    }
  } catch (e) {
    // 保留已渲染的基础信息，不再显示错误提示
  }

  // 主题标签在**搜图索引库**里（跨库），单独一条只读接口；拿不到就不加这个键 ——
  // 注册表把「没有 ai_tags」与「空数组」一视同仁地整行隐藏（网页端没有语言切换，
  // 用默认的 zh-CN，与它渲染其它字段的口径一致）。
  try {
    var tagRes = await apiGet('/api/photo-ai-tags?id=' + photo.id);
    if (tagRes && Array.isArray(tagRes.tags) && tagRes.tags.length && lastInfo) {
      lastInfo.ai_tags = tagRes.tags;
      render(lastInfo);
    }
  } catch (e) {
    // 索引库不存在 / 此刻读不到都走这里，面板少一行而已
  }

  // 画面标签（JoyTag）在 **tag 索引库**里（跨库），同样单独一条只读接口 ——
  // 并进同一份 lastInfo 重画（不另起渲染路径）；空数组不写键 = 整行隐藏。
  // 中文映射在服务端通道内做，这里拿到的已是显示文本。
  try {
    var joyRes = await apiGet('/api/photo-joy-tags?id=' + photo.id);
    if (joyRes && Array.isArray(joyRes.tags) && joyRes.tags.length && lastInfo) {
      lastInfo.joy_tags = joyRes.tags;
      render(lastInfo);
    }
  } catch (e) {
    // tag 库不存在 / 此刻读不到都走这里，面板少一行而已
  }

  // 字段集可能刚被桌面端改过：拉到新值后用同一份数据重画一次
  var ids = await refreshPreviewInfoFields();
  if (ids && lastInfo) render(lastInfo);
}

// === 收藏 ===
async function toggleFavoriteForPhoto(photoId) {
  try {
    var result = await fetch('/api/toggle-favorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id: photoId }),
    }).then(function (r) {
      return r.json();
    });
    if (result && result.error) throw new Error(result.error);
    var isFav = !!(result && result.is_favorite);
    // 更新 state 里的图片
    if (state.previewPhotos) {
      for (var i = 0; i < state.previewPhotos.length; i++) {
        if (Number(state.previewPhotos[i].id) === Number(photoId)) {
          state.previewPhotos[i].is_favorite = isFav ? 1 : 0;
        }
      }
    }
    if (state.currentPhotos) {
      for (var j = 0; j < state.currentPhotos.length; j++) {
        if (Number(state.currentPhotos[j].id) === Number(photoId)) {
          state.currentPhotos[j].is_favorite = isFav ? 1 : 0;
        }
      }
    }
    // 更新预览覆盖层按钮状态
    var favBtn = $('#previewFavoriteBtn');
    if (favBtn) {
      favBtn.classList.toggle('active', isFav);
      favBtn.title = isFav ? '取消收藏' : '收藏';
    }
    showWebToast(isFav ? '已添加收藏' : '已取消收藏');
    return isFav;
  } catch (e) {
    showWebToast('操作失败');
    return null;
  }
}

// === 组织元数据（标记 / 评分 / 标签） ===
// 与桌面端 `src/renderer/org-meta-ui.js` / `src/main/org-meta-filter.js` 同一条判据：
// 0 = 未评分、none = 未标记都是**合法的具体值**，与「不限」（null / 空串）刻意分开。
// 写入是**幂等设值**不是翻转 —— 冲片是盲操作，翻转会让「以为没按上、又按一次」
// 静默清掉上一张的标记。

/** 拼进照片列表请求的筛选参数。没有激活任何筛选时返回空串（不加 &）。 */
function orgFilterParams() {
  var f = state.orgFilter || {};
  var s = '';
  if (f.rating != null && f.rating !== '') s += '&rating=' + encodeURIComponent(f.rating);
  if (f.flag != null && f.flag !== '') s += '&flag=' + encodeURIComponent(f.flag);
  if (Array.isArray(f.tagIds) && f.tagIds.length)
    s += '&tagIds=' + encodeURIComponent(f.tagIds.join(','));
  return s;
}

function orgFilterHasActive() {
  var f = state.orgFilter || {};
  return (
    (f.rating != null && f.rating !== '') ||
    (f.flag != null && f.flag !== '') ||
    (Array.isArray(f.tagIds) && f.tagIds.length > 0)
  );
}

/** 某个维度的筛选激活时，写入后那张图可能不再匹配 ⇒ 列表必须重拉。 */
function reloadIfOrgFilterAffects(dimension) {
  var f = state.orgFilter || {};
  var active =
    dimension === 'rating'
      ? f.rating != null && f.rating !== ''
      : dimension === 'flag'
        ? f.flag != null && f.flag !== ''
        : Array.isArray(f.tagIds) && f.tagIds.length > 0;
  if (active) loadPhotos();
}

/** 把筛选态画回控件（两个下拉 + 清除按钮的显隐）。 */
function syncOrgFilterControls() {
  var f = state.orgFilter || {};
  var ratingSel = $('#orgFilterRatingSelect');
  if (ratingSel) ratingSel.value = f.rating == null ? '' : String(f.rating);
  var flagSel = $('#orgFilterFlagSelect');
  if (flagSel) flagSel.value = f.flag == null ? '' : String(f.flag);
  var clearBtn = $('#orgFilterClearBtn');
  if (clearBtn) clearBtn.style.display = orgFilterHasActive() ? '' : 'none';
}

/** 标签筛选面板内容（复选行 + 使用计数）。列表按需拉（聚合查询，别在启动期跑）。 */
async function refreshWebTagList() {
  var r = await apiGet('/api/tags').catch(function () {
    return null;
  });
  var list = r && r.success && Array.isArray(r.tags) ? r.tags : [];
  state.tagList = list;
  // 已选中但已不存在的标签要从筛选里摘掉：否则筛选一直生效却在面板里看不见它。
  var f = state.orgFilter;
  if (f && Array.isArray(f.tagIds) && f.tagIds.length) {
    var alive = list.map(function (t) {
      return Number(t.id);
    });
    f.tagIds = f.tagIds.filter(function (id) {
      return alive.indexOf(Number(id)) >= 0;
    });
  }
  renderOrgFilterTagsPanel();
  syncOrgFilterControls();
}

function renderOrgFilterTagsPanel() {
  var box = $('#orgFilterTagsList');
  if (!box) return;
  var f = state.orgFilter || { tagIds: [] };
  var list = Array.isArray(state.tagList) ? state.tagList : [];
  if (!list.length) {
    box.innerHTML = '<div class="org-filter-tags-empty">还没有任何标签</div>';
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
      ' onchange="changeOrgFilterTag(' +
      id +
      ', this.checked)" />' +
      '<span class="org-filter-tag-name">' +
      escapeHtml(String(t.name == null ? '' : t.name)) +
      '</span>' +
      // 🔴 括号必须包住整个 `||`：`+` 优先级更高，不写括号闭标签永远拼不进 HTML
      //    （桌面端视觉验证抓出过同一个 bug，见 app.js 桌面侧同名处注释）。
      '<span class="org-filter-tag-count">' +
      (Number(t.photo_count) || 0) +
      '</span>' +
      '</label>';
  }
  box.innerHTML = html;
}

/* 面板与 .header 平级（外壳层 `.header > * { position: relative }` 会把 fixed 改掉），
   位置按按钮矩形算 —— 与 positionAppearancePanel 同一条推导，锚点是顶栏下沿。 */
function positionOrgFilterPanel() {
  var panel = $('#headerOrgFilterPanel');
  var btn = $('#headerOrgFilterBtn');
  if (!panel || !btn) return;
  var pw = panel.offsetWidth;
  var ph = panel.offsetHeight;
  if (!pw || !ph) return;
  var br = btn.getBoundingClientRect();
  var header = document.querySelector('.header');
  var hdr = header ? header.getBoundingClientRect() : null;
  var gapPx = 8;
  var edge = 12;
  var top = (hdr ? hdr.bottom : br.bottom) + gapPx;
  if (top + ph > window.innerHeight - edge) {
    top = Math.max(edge, window.innerHeight - edge - ph);
  }
  var right = Math.max(edge, window.innerWidth - br.right);
  if (window.innerWidth - right - pw < edge) {
    right = Math.max(edge, window.innerWidth - pw - edge);
  }
  panel.style.top = Math.round(top) + 'px';
  panel.style.right = Math.round(right) + 'px';
}

function toggleOrgFilterPanel() {
  var panel = $('#headerOrgFilterPanel');
  if (!panel) return;
  if (panel.classList.contains('show')) {
    closeOrgFilterPanel();
    return;
  }
  // ⚠️ 先显示再定位：display:none 时 offsetWidth/Height 都是 0，定位会算错。
  panel.classList.add('show');
  var btn = $('#headerOrgFilterBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  positionOrgFilterPanel();
  refreshWebTagList();
}

function closeOrgFilterPanel() {
  var panel = $('#headerOrgFilterPanel');
  if (!panel || !panel.classList.contains('show')) return;
  panel.classList.remove('show');
  var btn = $('#headerOrgFilterBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/** 评分 / 标记下拉变更。任何筛选变化都回第 1 页 —— 与媒体档筛选同一条纪律。 */
function changeOrgFilter() {
  var f = state.orgFilter;
  if (!f) return;
  var ratingSel = $('#orgFilterRatingSelect');
  var flagSel = $('#orgFilterFlagSelect');
  f.rating = ratingSel && ratingSel.value !== '' ? ratingSel.value : null;
  f.flag = flagSel && flagSel.value !== '' ? flagSel.value : null;
  state.page = 1;
  syncOrgFilterControls();
  loadPhotos();
}

function changeOrgFilterTag(tagId, checked) {
  var f = state.orgFilter;
  if (!f) return;
  var id = Number(tagId);
  var idx = f.tagIds.indexOf(id);
  if (checked && idx < 0) f.tagIds.push(id);
  else if (!checked && idx >= 0) f.tagIds.splice(idx, 1);
  state.page = 1;
  syncOrgFilterControls();
  loadPhotos();
}

function clearOrgFilter() {
  state.orgFilter = { rating: null, flag: null, tagIds: [] };
  state.page = 1;
  syncOrgFilterControls();
  renderOrgFilterTagsPanel();
  loadPhotos();
}

/** 找到网格里同一张的卡片，就地重画两个角标（不重拉列表 —— 那会闪骨架屏）。 */
function updateWebCardOrgBadge(photo) {
  if (!photo || !photo.id || !document.querySelector) return;
  var card = document.querySelector(
    '#photoGrid .photo-card[data-photo-id="' + Number(photo.id) + '"]',
  );
  if (!card) return;
  var flag = photo.flag === 'pick' || photo.flag === 'reject' ? photo.flag : 'none';
  var rating = Math.max(0, Math.min(5, parseInt(photo.rating, 10) || 0));
  card.setAttribute('data-org-flag', flag);
  card.setAttribute('data-org-rating', String(rating));
  var oldFlag = card.querySelector('.photo-card-flag');
  if (oldFlag && oldFlag.parentNode) oldFlag.parentNode.removeChild(oldFlag);
  if (flag !== 'none') {
    var tmp = document.createElement('span');
    tmp.innerHTML =
      '<span class="photo-card-flag photo-card-flag--' +
      flag +
      '"><svg class="icon" aria-hidden="true"><use href="#icon-' +
      (flag === 'pick' ? 'check' : 'close') +
      '" /></svg></span>';
    if (tmp.firstChild && card.insertBefore) card.insertBefore(tmp.firstChild, card.firstChild);
  }
  var oldRating = card.querySelector('.photo-card-rating');
  if (oldRating && oldRating.parentNode) oldRating.parentNode.removeChild(oldRating);
  if (rating > 0) {
    var tmp2 = document.createElement('span');
    tmp2.innerHTML =
      '<span class="photo-card-rating"><svg class="icon" aria-hidden="true"><use href="#icon-star" /></svg><em>' +
      rating +
      '</em></span>';
    if (tmp2.firstChild && card.insertBefore) card.insertBefore(tmp2.firstChild, card.firstChild);
  }
}

function currentWebPreviewPhoto() {
  return state.previewPhotos && state.previewPhotos[state.previewIndex];
}

/** 预览里设标记。幂等设值；回包为准（数据层归一过）。 */
async function setWebPreviewFlag(flag) {
  var p = currentWebPreviewPhoto();
  if (!p || !p.id) return;
  try {
    var result = await fetch('/api/photo-flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, flag: flag }),
    }).then(function (r) {
      return r.json();
    });
    if (!result || result.error) throw new Error(result && result.error);
    p.flag = result.flag || flag;
    syncWebPreviewOrgMeta(p);
    updateWebCardOrgBadge(p);
    reloadIfOrgFilterAffects('flag');
  } catch (e) {
    showWebToast('操作失败');
  }
}

/** 预览里设评分。**再点同一颗 = 取消**（回 0）—— 与按钮 title 里写的行为一致。 */
async function setWebPreviewRating(rating) {
  var p = currentWebPreviewPhoto();
  if (!p || !p.id) return;
  var next = Number(p.rating) === Number(rating) ? 0 : rating;
  try {
    var result = await fetch('/api/photo-rating', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, rating: next }),
    }).then(function (r) {
      return r.json();
    });
    if (!result || result.error) throw new Error(result && result.error);
    p.rating = result.rating != null ? result.rating : next;
    syncWebPreviewOrgMeta(p);
    updateWebCardOrgBadge(p);
    reloadIfOrgFilterAffects('rating');
  } catch (e) {
    showWebToast('操作失败');
  }
}

/** 预览工具条 + 标签面板随当前这张走。openPreview 是唯一切图出口。 */
function syncWebPreviewOrgMeta(photo) {
  var flag = photo && (photo.flag === 'pick' || photo.flag === 'reject') ? photo.flag : 'none';
  var rating = Math.max(0, Math.min(5, parseInt(photo && photo.rating, 10) || 0));
  var pickBtn = $('#previewFlagPickBtn');
  if (pickBtn) pickBtn.classList.toggle('active', flag === 'pick');
  var rejectBtn = $('#previewFlagRejectBtn');
  if (rejectBtn) rejectBtn.classList.toggle('active', flag === 'reject');
  var stars = document.querySelectorAll('#previewRatingStars .preview-rating-star');
  for (var i = 0; i < stars.length; i++) {
    stars[i].classList.toggle('active', Number(stars[i].getAttribute('data-rating')) <= rating);
  }
  loadWebPreviewTags(photo ? photo.id : 0);
}

/** 拉当前这张的标签。带序号守卫：快速切图时旧回包不许覆盖新图的面板。 */
async function loadWebPreviewTags(photoId) {
  var seq = ++state.previewTagsLoadSeq;
  state.previewTagsPhotoId = photoId;
  if (!photoId) {
    state.previewTags = [];
    renderWebPreviewTagsChips();
    return;
  }
  try {
    var r = await apiGet('/api/photo-tags?id=' + Number(photoId));
    if (seq !== state.previewTagsLoadSeq) return;
    state.previewTags = r && r.success && Array.isArray(r.tags) ? r.tags : [];
  } catch (e) {
    if (seq !== state.previewTagsLoadSeq) return;
    state.previewTags = [];
  }
  renderWebPreviewTagsChips();
}

function renderWebPreviewTagsChips() {
  var box = $('#previewOrgTagsChips');
  if (!box) return;
  var tags = Array.isArray(state.previewTags) ? state.previewTags : [];
  var html = '';
  for (var i = 0; i < tags.length; i++) {
    var name = tags[i] && tags[i].name ? String(tags[i].name) : '';
    if (!name) continue;
    html +=
      '<span class="preview-org-tag">' +
      escapeHtml(name) +
      // data-tag-name 而不是下标：快速连点两下 × 时下标会漂，名字不会。
      '<button type="button" class="preview-org-tag-remove" data-tag-name="' +
      escapeHtml(name) +
      '" aria-label="删除标签" onclick="webPreviewRemoveTag(this.getAttribute(\'data-tag-name\'))">×</button>' +
      '</span>';
  }
  box.innerHTML = html;
  // 角标只数**标签**（不是「整理」抽屉里那四组东西的总数）：标签是唯一
  // 「有 / 没有」在图上不可见的一维。与桌面端 `org-meta-ui.js` 同一条口径。
  var count = $('#previewOrgCount');
  if (count) count.textContent = tags.length ? String(tags.length) : '';
}

/**
 * 「整理」抽屉（收藏 / 标记 / 评分 / 标签 / 对比）的开关。
 *
 * 🔴 与 `#previewInfoPanel` **互斥**（两者都是贴右侧的滑出抽屉）。
 * 🔴 刻意**没有**「点外部收起」和「Esc 收起」（信息面板有的是）：这是「工作台」
 *    不是「提示」，冲片时用户会在大图与抽屉之间来回点（选 / 否 / 星），
 *    点一下图就把抽屉收起来是最烦的失败模式。同理它**不随切图关闭**。
 * 🔴 打开时**不抢输入框焦点**：用户点「整理」多半是想标个记或打个星。
 *    （旧的小悬浮面板会 focus()，那是因为它只服务标签输入 —— 现在不是了。）
 * 与桌面端 `app.js#togglePreviewOrgPanel` 逐条同源。
 */
function toggleWebPreviewOrgPanel(force) {
  var panel = $('#previewOrgPanel');
  if (!panel) return;
  var open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
  if (open === panel.classList.contains('open')) return;
  panel.classList.toggle('open', open);
  _syncWebPreviewRightDrawerClass();
  if (open) {
    closePreviewInfoPanel();
    // 重画一次 chip：抽屉可能在「别处删过标签」之后才被打开，chips 得跟上。
    renderWebPreviewTagsChips();
  }
}

/** 收起「整理」抽屉。与 `closePreviewInfoPanel` 对称的**唯一收起点**。 */
function closeWebPreviewOrgPanel() {
  var panel = $('#previewOrgPanel');
  if (panel && panel.classList.contains('open')) {
    panel.classList.remove('open');
    _syncWebPreviewRightDrawerClass();
  }
}

/** 输入框提交（回车 / 点「添加」共用）。先清空再发：失败时用户能看出「没加上」。 */
async function webPreviewSubmitTagInput() {
  var input = $('#previewOrgTagsInput');
  if (!input) return;
  var raw = input.value;
  if (!raw || !raw.trim()) return;
  input.value = '';
  await webPreviewReplaceTags(raw);
}

async function webPreviewRemoveTag(name) {
  var p = currentWebPreviewPhoto();
  if (!p || !p.id) return;
  var names = (Array.isArray(state.previewTags) ? state.previewTags : [])
    .map(function (t) {
      return t && t.name ? String(t.name) : '';
    })
    .filter(function (n) {
      // 全量替换语义：删的就是「现在看到的这个名」，不按 id（面板里的行可能来自旧回包）。
      return n && n !== String(name);
    });
  await webPreviewReplaceTags(names);
}

/** 全量替换当前这张的标签集合。**回包的 tags 是最终集合**，必须用回包重画。 */
async function webPreviewReplaceTags(namesPayload) {
  var p = currentWebPreviewPhoto();
  if (!p || !p.id) return;
  var names = Array.isArray(namesPayload) ? namesPayload : [String(namesPayload)];
  try {
    var result = await fetch('/api/photo-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, names: names }),
    }).then(function (r) {
      return r.json();
    });
    if (!result || result.error) throw new Error(result && result.error);
    state.previewTags = Array.isArray(result.tags) ? result.tags : [];
    renderWebPreviewTagsChips();
    if (typeof refreshWebTagList === 'function') refreshWebTagList();
  } catch (e) {
    showWebToast('操作失败');
  }
}

// === 下载 ===
function downloadPhoto(photoId) {
  var a = document.createElement('a');
  a.href = '/api/download?id=' + photoId;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    document.body.removeChild(a);
  }, 100);
}

// === 多选功能 ===
var _selectionSet = {};

function enterSelectionMode() {
  _selectionSet = {};
  updateSelectionToolbar();
  var toolbar = $('#selectionToolbar');
  if (toolbar) {
    toolbar.classList.add('show');
    toolbar.setAttribute('aria-hidden', 'false');
  }
  var grid = $('#photoGrid');
  if (grid) grid.classList.add('in-selection');
}

function exitSelectionMode() {
  _selectionSet = {};
  document.querySelectorAll('.photo-card.selected').forEach(function (c) {
    c.classList.remove('selected');
  });
  var toolbar = $('#selectionToolbar');
  if (toolbar) {
    toolbar.classList.remove('show');
    toolbar.setAttribute('aria-hidden', 'true');
  }
  var grid = $('#photoGrid');
  if (grid) grid.classList.remove('in-selection');
}

function toggleSelectPhoto(index) {
  var photo = state.currentPhotos && state.currentPhotos[index];
  if (!photo) return;
  var id = photo.id;
  if (_selectionSet[id]) {
    delete _selectionSet[id];
  } else {
    _selectionSet[id] = photo;
  }
  updateSelectionToolbar();
  // 更新卡片样式
  var cards = document.querySelectorAll('#photoGrid .photo-card');
  if (cards[index]) cards[index].classList.toggle('selected', !!_selectionSet[id]);
}

function updateSelectionToolbar() {
  var count = Object.keys(_selectionSet).length;
  setText('#selectionCount', '已选 ' + count + ' 张');
}

function selectAllPhotos() {
  _selectionSet = {};
  var photos = state.currentPhotos || [];
  for (var i = 0; i < photos.length; i++) {
    _selectionSet[photos[i].id] = photos[i];
  }
  document.querySelectorAll('#photoGrid .photo-card').forEach(function (c) {
    c.classList.add('selected');
  });
  updateSelectionToolbar();
}

function deselectAllPhotos() {
  exitSelectionMode();
}

function downloadSelected() {
  var ids = Object.keys(_selectionSet);
  if (!ids.length) {
    showWebToast('请先选择图片');
    return;
  }
  ids.forEach(function (id, i) {
    setTimeout(function () {
      downloadPhoto(id);
    }, i * 300);
  });
  showWebToast('开始下载 ' + ids.length + ' 张图片');
}

async function favoriteSelected() {
  var ids = Object.keys(_selectionSet);
  if (!ids.length) {
    showWebToast('请先选择图片');
    return;
  }
  var ok = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await fetch('/api/toggle-favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id: parseInt(ids[i], 10) }),
      });
      ok++;
    } catch (e) {}
  }
  showWebToast('已处理 ' + ok + ' 张图片');
  exitSelectionMode();
}

// === 上下文菜单 ===
var _contextMenuPhotoIndex = -1;

function showContextMenu(e, photoIndex) {
  e.preventDefault();
  _contextMenuPhotoIndex = photoIndex;
  var menu = $('#contextMenu');
  if (!menu) return;
  menu.classList.add('show');
  menu.setAttribute('aria-hidden', 'false');
  var x = e.clientX,
    y = e.clientY;
  var mw = menu.offsetWidth || 160,
    mh = menu.offsetHeight || 180;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideContextMenu() {
  var menu = $('#contextMenu');
  if (menu) {
    menu.classList.remove('show');
    menu.setAttribute('aria-hidden', 'true');
  }
  _contextMenuPhotoIndex = -1;
}

function bindContextMenu() {
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#contextMenu')) hideContextMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideContextMenu();
  });
  var menu = $('#contextMenu');
  if (!menu) return;
  menu.addEventListener('click', function (e) {
    var item = e.target.closest('[data-action]');
    if (!item) return;
    var action = item.getAttribute('data-action');
    var idx = _contextMenuPhotoIndex;
    hideContextMenu();
    if (idx < 0) return;
    var photo = state.currentPhotos && state.currentPhotos[idx];
    if (!photo) return;
    if (action === 'preview') {
      startPreview(idx);
    } else if (action === 'favorite') {
      toggleFavoriteForPhoto(photo.id);
    } else if (action === 'download') {
      downloadPhoto(photo.id);
    } else if (action === 'info') {
      startPreview(idx);
      setTimeout(function () {
        var panel = $('#previewInfoPanel');
        if (panel && !panel.classList.contains('open')) togglePreviewInfoPanel();
      }, 300);
    } else if (action === 'select') {
      var toolbarEl = $('#selectionToolbar');
      if (!toolbarEl || !toolbarEl.classList.contains('show')) enterSelectionMode();
      toggleSelectPhoto(idx);
    }
  });
}

// === 回到顶部 ===
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// === Dev Error Overlay ===
function shouldShowDevErrorOverlay() {
  var h = (window.location && window.location.hostname) || '';
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return /(?:^|[?&])devErrors=1(?:&|$)/.test(window.location.search || '');
}

function installDevErrorOverlay() {
  if (!shouldShowDevErrorOverlay()) return;

  var box = document.createElement('div');
  box.id = 'devErrorOverlay';
  box.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:99999;max-width:min(560px,92vw);max-height:44vh;overflow:auto;padding:10px 12px;border:1px solid rgba(255,80,80,.45);background:rgba(20,0,0,.88);color:#ffd7d7;border-radius:10px;font:12px/1.5 Consolas,Menlo,monospace;box-shadow:0 8px 28px rgba(0,0,0,.45);display:none;';
  box.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">' +
    '<strong style="color:#ff9a9a;">Web \u9519\u8BEF\uFF08\u5F00\u53D1\uFF09</strong>' +
    '<button type="button" id="devErrorOverlayClear" style="border:1px solid rgba(255,140,140,.5);background:transparent;color:#ffd7d7;padding:2px 8px;border-radius:6px;cursor:pointer;">\u6E05\u7A7A</button>' +
    '</div>' +
    '<div id="devErrorOverlayBody"></div>';
  document.body.appendChild(box);

  var body = document.getElementById('devErrorOverlayBody');
  var clearBtn = document.getElementById('devErrorOverlayClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      if (body) body.innerHTML = '';
      box.style.display = 'none';
    });
  }

  function addErrorLine(title, detail) {
    box.style.display = 'block';
    var line = document.createElement('div');
    line.style.marginBottom = '8px';
    line.innerHTML =
      '<div style="color:#ffb3b3;">[' +
      new Date().toLocaleTimeString() +
      '] ' +
      escapeHtml(title) +
      '</div><div style="white-space:pre-wrap;opacity:.95;">' +
      escapeHtml(detail || '') +
      '</div>';
    if (body) body.prepend(line);
  }

  window.addEventListener('error', function (ev) {
    var msg = ev && ev.message ? String(ev.message) : 'Unknown error';
    var src = ev && ev.filename ? String(ev.filename) : '';
    var pos = ev && (ev.lineno || ev.colno) ? ' @ ' + (ev.lineno || 0) + ':' + (ev.colno || 0) : '';
    var st = ev && ev.error && ev.error.stack ? String(ev.error.stack) : '';
    addErrorLine(msg, (src ? src + pos + '\n' : '') + st);
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev && ev.reason ? ev.reason : 'Unhandled rejection';
    var detail =
      reason && reason.stack
        ? String(reason.stack)
        : typeof reason === 'string'
          ? reason
          : JSON.stringify(reason);
    addErrorLine('Unhandled Promise Rejection', detail || '');
  });
}

// Start
installDevErrorOverlay();
// Ensure inline HTML handlers always resolve to callable functions.
window.switchTab = switchTab;
window.toggleMobileSidebar = toggleMobileSidebar;
window.openMobileFilterSheet = openMobileFilterSheet;
window.closeMobileFilterSheet = closeMobileFilterSheet;
window.toggleAppearancePanel = toggleAppearancePanel;
window.closeAppearancePanel = closeAppearancePanel;
window.applyWebThemeStyle = applyWebThemeStyle;
window.applyWebAppearance = applyWebAppearance;
window.changeWebAccent = changeWebAccent;
window.changeWebBackground = changeWebBackground;
window.showInstallGuide = showInstallGuide;
window.changeMediaFilter = changeMediaFilter;
window.changeSort = changeSort;
window.changePageSize = changePageSize;
window.changeCardSize = changeCardSize;
window.changeCardSizeTo = changeCardSizeTo;
window.changeCardAspectMode = changeCardAspectMode;
window.prevPage = prevPage;
window.nextPage = nextPage;
window.goToPage = goToPage;
window.randomPage = randomPage;
window.mobileNavSwitch = mobileNavSwitch;
window.startPreview = startPreview;
window.closePreview = closePreview;
window.navigatePreview = navigatePreview;
window.toggleSlideshow = toggleSlideshow;
window.toggleSlideshowRandom = toggleSlideshowRandom;
window.toggleSubtitleEnabled = toggleSubtitleEnabled;
window.togglePreviewFullscreen = togglePreviewFullscreen;
window.viewAllPhotos = viewAllPhotos;
window.viewFolderOverview = viewFolderOverview;
window.viewRootFolder = viewRootFolder;
window.viewFolder = viewFolder;
window.viewDate = viewDate;
window.togglePreviewInfoPanel = togglePreviewInfoPanel;
window.openSearchOverlay = openSearchOverlay;
window.closeSearchOverlay = closeSearchOverlay;
window.toggleFavoriteForPhoto = toggleFavoriteForPhoto;
// 组织元数据（标记 / 评分 / 标签）：inline onclick 引用的入口都要挂到 window。
window.toggleOrgFilterPanel = toggleOrgFilterPanel;
window.changeOrgFilter = changeOrgFilter;
window.changeOrgFilterTag = changeOrgFilterTag;
window.clearOrgFilter = clearOrgFilter;
window.setWebPreviewFlag = setWebPreviewFlag;
window.setWebPreviewRating = setWebPreviewRating;
window.toggleWebPreviewOrgPanel = toggleWebPreviewOrgPanel;
window.webPreviewSubmitTagInput = webPreviewSubmitTagInput;
window.webPreviewRemoveTag = webPreviewRemoveTag;
// Live Photo 的「实况」按钮走内联 onclick，必须挂到这里 —— 这个块就是本文件
// 「暴露给内联处理器」的唯一清单，漏了它 eslint 会报 no-unused-vars（基线是 2 条）。
window.toggleWebLivePlayback = toggleWebLivePlayback;
window.downloadPhoto = downloadPhoto;
window.downloadSelected = downloadSelected;
window.favoriteSelected = favoriteSelected;
window.selectAllPhotos = selectAllPhotos;
window.deselectAllPhotos = deselectAllPhotos;
window.scrollToTop = scrollToTop;
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
window.PhotoCompare.mount({
  currentPhoto: function () {
    return state.previewPhotos[state.previewIndex];
  },
  imageUrl: function (photo) {
    return '/preview-image/' + photo.id;
  },
  beforeOpen: closePreview,
});
// 网页端「搜图 / 人物」：入口在文件栏（侧栏页签），结果落进主图片网格，
// 因此卡片渲染、点击进预览、上一张/下一张、幻灯片、收藏与选择全部复用浏览链路。
var webAiGet = function (url) {
  return fetch(url, { credentials: 'same-origin' }).then(function (response) {
    if (response.status === 401) {
      // 与 apiGet 一致：登录过期直接回登录页，而不是把 401 当成「模型未就绪」。
      try {
        window.location.href = '/login';
      } catch (e) {}
      throw new Error('需要登录');
    }
    return response.json().then(function (result) {
      if (!response.ok) throw new Error((result && result.error) || 'AI_UNAVAILABLE');
      return result;
    });
  });
};
var webAiPost = function (url, payload) {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  }).then(function (response) {
    if (response.status === 401) {
      try {
        window.location.href = '/login';
      } catch (e) {}
      throw new Error('需要登录');
    }
    return response.json().then(function (result) {
      if (!response.ok) throw new Error((result && result.error) || 'FACE_NAME_INVALID');
      return result;
    });
  });
};
webAiViews = window.WebAiViews.init({
  state: state,
  dom: {
    photoGrid: $('#photoGrid'),
    headerTitle: $('#headerTitle'),
    sidebar: $('#aiSidebar'),
  },
  get: webAiGet,
  post: webAiPost,
  renderPhotoGrid: renderPhotoGrid,
  applyCardSize: applyCardSize,
  escapeHtml: escapeHtml,
  // 缩略图缓存键：ai-views.js 先于本文件加载（见 web/index.html），拿不到这里的函数，
  // 所以走同一条 deps 注入 —— 目录封面卡片与目录浏览卡片共用同一个键公式。
  thumbCacheVersion: thumbCacheVersion,
  setText: setText,
  setDisplay: setDisplay,
});
webAiViews.bind();
init();
