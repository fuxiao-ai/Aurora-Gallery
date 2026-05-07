var CARD_SIZE_TIERS = [
  { label: 'S', basis: 100 },
  { label: 'M', basis: 140 },
  { label: 'L', basis: 180 },
  { label: 'XL', basis: 320 },
];
function applyWebThemeStyle(id) {
  var themeId = WebTheme.normalizeWebThemeStyle(id);
  WebTheme.applyWebThemeVariables(document.documentElement, themeId);
  try {
    localStorage.setItem('webThemeStyle', themeId);
  } catch (e) {}
  var sel = document.getElementById('webThemeStyle');
  if (sel) sel.value = themeId;
  var mobileSel = document.getElementById('mobileThemeStyleSelect');
  if (mobileSel) mobileSel.value = themeId;
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

var CARD_ASPECT_MODES = ['masonry', 'uniform_1_1', 'uniform_4_3', 'uniform_3_4', 'uniform_16_9'];
function normalizeCardAspectMode(raw) {
  var s = String(raw || '');
  if (CARD_ASPECT_MODES.indexOf(s) >= 0) return s;
  return 'masonry';
}
function getUniformAspectCss(mode) {
  if (mode === 'uniform_1_1') return '1 / 1';
  if (mode === 'uniform_4_3') return '4 / 3';
  if (mode === 'uniform_3_4') return '3 / 4';
  if (mode === 'uniform_16_9') return '16 / 9';
  return '';
}
function applyCardAspectModeUi() {
  var sel = $('#cardAspectSelect');
  if (!sel) return;
  var v = normalizeCardAspectMode(state.cardAspectMode);
  if (sel.value !== v) sel.value = v;
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
  currentPath: '',
  currentDate: '',
  searchQuery: '',
  sortBy: 'date_taken',
  sortOrder: 'DESC',
  page: 1,
  pageSize: 72,
  mediaFilter: 'all',
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
    var searchInput = $('#searchInput');
    if (searchInput) searchInput.value = state.searchQuery;
    var sortSel = $('#sortSelect');
    if (sortSel) sortSel.value = state.sortBy + '|' + state.sortOrder;
    var mobileSortSel = $('#mobileSortSelect');
    if (mobileSortSel) mobileSortSel.value = state.sortBy + '|' + state.sortOrder;
    var mediaSel = $('#mediaFilterSelect');
    if (mediaSel) mediaSel.value = state.mediaFilter;
    var mobileMediaSel = $('#mobileMediaFilterSelect');
    if (mobileMediaSel) mobileMediaSel.value = state.mediaFilter;

    if (state.currentView === 'folder_overview') {
      $('#toolbarPath').textContent = '\u6240\u6709\u7167\u7247';
      updateSidebarActive();
      if (state.currentTab === 'folders') loadRootFolders();
      loadFolderCovers();
    } else if (state.currentView === 'folder') {
      var name = state.currentPath ? state.currentPath.split(/[\\/]/).pop() : '';
      $('#toolbarPath').textContent = '\u6587\u4EF6\u5939: ' + (name || '\u76EE\u5F55');
      updateSidebarActive();
      if (state.currentTab === 'folders') loadRootFolders();
      loadPhotos();
    } else if (state.currentView === 'date') {
      $('#toolbarPath').textContent = '\u65E5\u671F: ' + formatDateLabel(state.currentDate || '');
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
      $('#toolbarPath').textContent = '\u6839\u76EE\u5F55: ' + (rootName || '\u6839\u76EE\u5F55');
      updateSidebarActive();
      if (state.currentTab === 'folders') loadRootFolders();
      loadPhotos();
    } else if (state.currentView === 'search' && state.searchQuery) {
      $('#toolbarPath').textContent = '\u641C\u7D22: ' + state.searchQuery;
      updateSidebarActive();
      loadPhotos();
    } else {
      state.currentView = 'all';
      state._rootId = undefined;
      state.currentPath = '';
      state.currentDate = '';
      $('#toolbarPath').textContent = '\u6240\u6709\u7167\u7247';
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
  var sizeSel = $('#previewSubtitleSizeSelect');
  if (sizeSel) sizeSel.value = state.subtitleSize;
  var posSel = $('#previewSubtitlePosSelect');
  if (posSel) posSel.value = state.subtitlePosition;
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

function previewGlobalPositionOne(index) {
  var ps = state.pageSize > 0 ? state.pageSize : 72;
  var start = state.previewPageStart > 0 ? state.previewPageStart : 1;
  var i = typeof index === 'number' && index >= 0 ? index : 0;
  return (start - 1) * ps + i + 1;
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

function buildPreviewInfoText(photo, index) {
  var num =
    state.slideshowRandom && state.previewRandomPositionNum > 0
      ? state.previewRandomPositionNum
      : previewGlobalPositionOne(index);
  var posInfo =
    state.previewTotalPhotos > 0 ? ' [' + num + '/' + state.previewTotalPhotos + ']' : '';
  return (
    photo.file_name +
    ' | ' +
    formatDateTime(photo.date_taken) +
    ' | ' +
    formatSize(photo.file_size) +
    (photo.width ? ' | ' + photo.width + 'x' + photo.height : '') +
    posInfo
  );
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
  function stopLoadingForVideo() {
    if (!isCurrentPreviewRequest()) return;
    video.style.visibility = '';
    if (loadingEl) loadingEl.classList.remove('show');
  }
  video.onloadedmetadata = stopLoadingForVideo;
  video.oncanplay = stopLoadingForVideo;
  video.onerror = stopLoadingForVideo;
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
  $('#previewInfo').textContent =
    buildPreviewInfoText(photo, index) + ' \u00B7 \u51C6\u5907\u64AD\u653E...';
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
        $('#previewInfo').textContent =
          buildPreviewInfoText(photo, index) + ' \u00B7 \u5A92\u4F53\u4E0D\u5B58\u5728';
        return;
      }
      if (data.error === 'hls_unavailable' || data.error === 'hls_failed') {
        stopLoadingForVideo();
        $('#previewInfo').textContent =
          buildPreviewInfoText(photo, index) + ' · ' + (data.message || data.error);
        return;
      }
      if (!data.ready) {
        stopLoadingForVideo();
        $('#previewInfo').textContent =
          buildPreviewInfoText(photo, index) + ' \u00B7 \u65E0\u6CD5\u64AD\u653E';
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
      applyWebPauseVideoAfterSwitch(video, !!pauseAfterSwitch);
      $('#previewInfo').textContent = buildPreviewInfoText(photo, index);
    })
    .catch(function () {
      if (!isCurrentPreviewRequest()) return;
      stopLoadingForVideo();
      $('#previewInfo').textContent =
        buildPreviewInfoText(photo, index) + ' \u00B7 \u65E0\u6CD5\u64AD\u653E';
    });
}

// === API ===
function apiGet(url) {
  return fetch(url, { credentials: 'same-origin' }).then(function (r) {
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
  var searchInput = $('#searchInput');
  if (searchInput) searchInput.value = '';
  window.PhotoHlsConfig = {
    onSessionEnd: function (sessionId) {
      fetch('/api/hls-stop?sessionId=' + encodeURIComponent(sessionId), {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(function () {});
    },
  };
  var savedTheme = 'midnight_classic';
  try {
    savedTheme = WebTheme.normalizeWebThemeStyle(localStorage.getItem('webThemeStyle'));
  } catch (e) {}
  applyWebThemeStyle(savedTheme);
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
  var mobileMediaSel = $('#mobileMediaFilterSelect');
  if (mobileMediaSel) mobileMediaSel.value = state.mediaFilter;
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
    bottomNav.classList.add('show');
    enforceMobileSubtitleDefault();
  } else {
    bottomNav.classList.remove('show');
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
  var sortSel = $('#sortSelect');
  var mobileSortSel = $('#mobileSortSelect');
  if (sortSel && mobileSortSel) mobileSortSel.value = sortSel.value;
  var mediaSel = $('#mediaFilterSelect');
  var mobileMediaSel = $('#mobileMediaFilterSelect');
  if (mediaSel && mobileMediaSel) mobileMediaSel.value = mediaSel.value;
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
  var searchTimer;
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
  $('#searchInput').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.searchQuery = $('#searchInput').value.trim();
      state.currentView = state.searchQuery ? 'search' : 'all';
      state.page = 1;
      loadPhotos();
      pushViewHistoryState();
    }, 300);
  });
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
      img.classList.remove('dragging');
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

  $('#previewOverlay').addEventListener(
    'wheel',
    function (e) {
      if (!$('#previewOverlay').classList.contains('active')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        var delta = e.deltaY > 0 ? -0.15 : 0.15;
        applyZoom(delta);
      } else {
        if (e.deltaY > 20) navigatePreview(1);
        else if (e.deltaY < -20) navigatePreview(-1);
      }
    },
    { passive: false },
  );

  $('#previewOverlay').addEventListener('click', function (e) {
    if (e.target === $('#previewOverlay')) closePreview();
  });
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
        t.closest('.preview-info-bar') ||
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
          t.closest('.preview-info-bar') ||
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
          closePreview();
          return;
        }
        previewBody.style.transform = '';
        previewBody.style.opacity = '';
        state.previewBodyTouchDy = 0;
      },
      { passive: true },
    );
  }
  $('#previewOverlay').addEventListener(
    'touchstart',
    function (e) {
      if (!state.isMobile) return;
      if (!$('#previewOverlay').classList.contains('active')) return;
      if (!e.touches || e.touches.length !== 1) return;
      var target = e.target;
      if (
        target.closest('.preview-slideshow-controls') ||
        target.closest('.preview-close') ||
        target.closest('.preview-info-bar')
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
  $('#previewOverlay').addEventListener(
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

  document.addEventListener('keydown', function (e) {
    if ($('#previewOverlay').classList.contains('active')) {
      if (e.key === 'Escape') closePreview();
      if (e.key === 'ArrowLeft') navigatePreview(-1);
      if (e.key === 'ArrowRight') navigatePreview(1);
      if (e.key === ' ') {
        e.preventDefault();
        toggleSlideshow();
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
  document.addEventListener('fullscreenchange', syncFullscreenButton);

  // comment cleaned
  $('#sidebarContent').addEventListener('click', function (e) {
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
          $('#sidebar').classList.remove('mobile-show');
          $('#mobileBackdrop').classList.remove('show');
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

  // comment cleaned
  $('#photoGrid').addEventListener('click', function (e) {
    var card =
      e.target && e.target.closest ? e.target.closest('.folder-card[data-folder-path]') : null;
    if (card) {
      var p = card.getAttribute('data-folder-path');
      if (p) viewFolder(p);
    }
  });

  // comment cleaned
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      detectMobile();
      if (window.innerWidth > 600) {
        $('#sidebar').classList.remove('mobile-show');
        $('#mobileBackdrop').classList.remove('show');
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
}

// === Mobile ===
function toggleMobileSidebar() {
  var sb = $('#sidebar');
  var bd = $('#mobileBackdrop');
  sb.classList.toggle('mobile-show');
  bd.classList.toggle('show');
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
  sb.classList.remove('mobile-show');
  bd.classList.remove('show');

  if (tab === 'browse') {
    viewAllPhotos();
  } else if (tab === 'folders') {
    // comment cleaned
    state.currentTab = 'folders';
    document.querySelectorAll('.sidebar-tab').forEach(function (t) {
      t.classList.remove('active');
    });
    var folderTab = document.querySelector('.sidebar-tab[data-tab="folders"]');
    if (folderTab) folderTab.classList.add('active');
    loadRootFolders();
    sb.classList.add('mobile-show');
    bd.classList.add('show');
  } else if (tab === 'dates') {
    // comment cleaned
    state.currentTab = 'dates';
    document.querySelectorAll('.sidebar-tab').forEach(function (t) {
      t.classList.remove('active');
    });
    var dateTab = document.querySelector('.sidebar-tab[data-tab="dates"]');
    if (dateTab) dateTab.classList.add('active');
    loadDateGroups();
    sb.classList.add('mobile-show');
    bd.classList.add('show');
  } else if (tab === 'search') {
    // comment cleaned
    var searchInput = $('#searchInput');
    if (searchInput) {
      searchInput.focus();
      searchInput.click();
    }
  }
}

// comment cleaned
function initPullRefresh() {
  var grid = $('#photoGrid');
  if (!grid) return;

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
        $('#pullRefreshIndicator').classList.add('show');
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
        var indicator = $('#pullRefreshIndicator');
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

      var indicator = $('#pullRefreshIndicator');
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
async function loadStats() {
  var stats = await apiGet('/api/stats');
  state.stats = stats || null;
  if (stats.totalPhotos > 0) {
    $('#headerStats').textContent =
      formatNumber(stats.totalPhotos) +
      ' \u5F20\u7167\u7247 | ' +
      formatSize(stats.totalSize) +
      ' | \u89C6\u9891 ' +
      formatNumber(stats.videoPhotos || 0) +
      ' \u6761 | ' +
      formatSize(stats.videoSize || 0);
  }
}

// === Tab switching ===
function switchTab(tab) {
  state.currentTab = tab;
  setMobileHeaderCollapsed(false);
  document.querySelectorAll('.sidebar-tab').forEach(function (t) {
    t.classList.remove('active');
  });
  var tabEl = document.querySelector('.sidebar-tab[data-tab="' + tab + '"]');
  if (tabEl) tabEl.classList.add('active');

  if (tab === 'folders') loadRootFolders();
  else loadDateGroups();

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
    html +=
      '<div class="folder-item ' +
      (state.currentView === 'all' && !state._rootId ? 'active' : '') +
      '" data-action="view-all">' +
      '<span class="icon">\uD83D\uDDBC\uFE0F</span><span class="name">\u6240\u6709\u7167\u7247</span><span class="count">' +
      formatRootFolderCount(photosPending ? null : totalPhotos) +
      '</span></div>';
    html +=
      '<div class="folder-item ' +
      (state.currentView === 'folder_overview' ? 'active' : '') +
      '" data-action="view-folder-overview">' +
      '<span class="icon">\uD83D\uDDC2\uFE0F</span><span class="name">\u6240\u6709\u76EE\u5F55</span><span class="count">' +
      formatRootFolderCount(foldersPending ? null : tf) +
      '</span></div>';
    for (var rootIdx = 0; rootIdx < folders.length; rootIdx++) {
      var f = folders[rootIdx];
      var isRootActive = state.currentView === 'root' && state._rootId === f.id;
      html += '<div class="tree-root">';
      html +=
        '<div class="folder-item tree-header ' +
        (isRootActive ? 'active' : '') +
        '" data-root-id="' +
        f.id +
        '" data-action="view-root">' +
        '<span class="tree-toggle" data-action="toggle-root" data-root-id="' +
        f.id +
        '">\u25B6</span>' +
        '<span class="icon">\uD83D\uDCC1</span><span class="name" title="' +
        escapeHtml(f.path) +
        '">' +
        escapeHtml(f.name) +
        '</span>' +
        '<span class="count">' +
        formatRootFolderCount(f.photo_count) +
        '</span></div>';
      html += '<div class="tree-children collapsed" id="treeChildren-' + f.id + '"></div>';
      html += '</div>';
    }
  }
  $('#sidebarContent').innerHTML = html;
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

async function loadRootFolders() {
  webRootFoldersHydrateGen++;
  var myGen = webRootFoldersHydrateGen;
  showSidebarLoadingPlaceholder('\u6B63\u5728\u52A0\u8F7D\u76EE\u5F55\u2026');
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
    $('#sidebarContent').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">目录加载失败，请稍后重试</div>';
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
        if (container && tree.length > 0) {
          container.innerHTML = renderTreeNodes(tree, 1);
          container.classList.remove('collapsed');
          var treeToggle = container.parentElement.querySelector('.tree-toggle');
          if (treeToggle) treeToggle.textContent = '\u25BC';
        } else if (container) {
          container.classList.add('collapsed');
          var treeToggleHidden = container.parentElement.querySelector('.tree-toggle');
          if (treeToggleHidden) treeToggleHidden.style.visibility = 'hidden';
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

function renderTreeNodes(nodes, depth) {
  var html = '';
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var indent = 16 + depth * 16;
    var isActive = state.currentView === 'folder' && state.currentPath === node.fullPath;
    var hasChildren = node.children.length > 0;
    var toggleHtml = hasChildren
      ? '<span class="tree-toggle" data-action="toggle-node">▶</span>'
      : '<span class="tree-toggle" style="visibility:hidden">▶</span>';

    html += '<div class="tree-node">';
    html +=
      '<div class="folder-item ' +
      (isActive ? 'active' : '') +
      '" style="padding-left:' +
      indent +
      'px;" data-folder-path="' +
      escapeAttr(node.fullPath) +
      '">' +
      toggleHtml +
      '<span class="icon">' +
      (hasChildren ? '\uD83D\uDCC1' : '\uD83D\uDCC2') +
      '</span>' +
      '<span class="name" title="' +
      escapeHtml(node.fullPath) +
      '">' +
      escapeHtml(node.name) +
      '</span>';
    if (node.photoCount > 0) {
      html += '<span class="count">' + formatNumber(node.photoCount) + '</span>';
    }
    html += '</div>';

    if (hasChildren) {
      html +=
        '<div class="tree-children collapsed">' +
        renderTreeNodes(node.children, depth + 1) +
        '</div>';
    }
    html += '</div>';
  }
  return html;
}

function toggleTreeRoot(toggle, event, _rootId) {
  event.stopPropagation();
  var children = toggle.closest('.tree-root').querySelector('.tree-children');
  if (!children) return;
  var isCollapsed = children.classList.contains('collapsed');
  if (isCollapsed) {
    children.classList.remove('collapsed');
    toggle.textContent = '\u25BC';
  } else {
    children.classList.add('collapsed');
    toggle.textContent = '\u25B6';
  }
}

function toggleTreeNode(toggle, event) {
  event.stopPropagation();
  var node = toggle.closest('.tree-node');
  if (!node) return;
  var children = node.querySelector(':scope > .tree-children');
  if (!children) return;
  var isCollapsed = children.classList.contains('collapsed');
  if (isCollapsed) {
    children.classList.remove('collapsed');
    toggle.textContent = '\u25BC';
  } else {
    children.classList.add('collapsed');
    toggle.textContent = '\u25B6';
  }
}

function viewRootFolder(rootId) {
  state.currentView = 'root';
  state._rootId = rootId;
  state.currentPath = '';
  state.currentDate = '';
  state.page = 1;
  var rootName = '';
  for (var i = 0; i < state._rootFolders.length; i++) {
    if (state._rootFolders[i].id === rootId) {
      rootName = state._rootFolders[i].name;
      break;
    }
  }
  $('#toolbarPath').textContent = '\u6839\u76EE\u5F55: ' + rootName;
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

    $('#sidebarContent').innerHTML = html;
  } catch (e) {
    $('#sidebarContent').innerHTML =
      '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">日期加载失败，请稍后重试</div>';
  }
}

// === Views ===
function viewAllPhotos() {
  state.currentView = 'all';
  state._rootId = undefined;
  state.currentPath = '';
  state.currentDate = '';
  state.page = 1;
  $('#toolbarPath').textContent = '\u6240\u6709\u7167\u7247';
  updateSidebarActive();
  loadPhotos();
  pushViewHistoryState();
}

function viewFolderOverview() {
  state.currentView = 'folder_overview';
  state._rootId = undefined;
  state.currentPath = '';
  state.currentDate = '';
  state.page = 1;
  $('#toolbarPath').textContent = '\u6240\u6709\u76EE\u5F55';
  updateSidebarActive();
  loadFolderCovers();
  pushViewHistoryState();
}

function viewFolder(folderPath) {
  state.currentView = 'folder';
  state.currentPath = folderPath;
  state.page = 1;
  state.sortBy = 'file_name';
  state.sortOrder = 'ASC';
  $('#sortSelect').value = 'file_name|ASC';
  var mobileSortSel = $('#mobileSortSelect');
  if (mobileSortSel) mobileSortSel.value = 'file_name|ASC';
  var name = folderPath.split(/[\\/]/).pop();
  $('#toolbarPath').textContent = '\u6587\u4EF6\u5939: ' + name;
  var pg = $('#photoGrid');
  if (pg) pg.scrollTop = 0;
  updateSidebarActive();
  loadPhotos();
  pushViewHistoryState();
}

function viewDate(dateStr) {
  state.currentView = 'date';
  state.currentDate = dateStr;
  state.page = 1;
  $('#toolbarPath').textContent = '\u65E5\u671F: ' + formatDateLabel(dateStr);
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

function normalizeMediaFilter(v) {
  var s = String(v || 'all').toLowerCase();
  if (s === 'image' || s === 'video') return s;
  return 'all';
}

function changeMediaFilter(val) {
  state.mediaFilter = normalizeMediaFilter(val);
  var mediaSel = $('#mediaFilterSelect');
  if (mediaSel && mediaSel.value !== state.mediaFilter) mediaSel.value = state.mediaFilter;
  var mobileMediaSel = $('#mobileMediaFilterSelect');
  if (mobileMediaSel && mobileMediaSel.value !== state.mediaFilter) {
    mobileMediaSel.value = state.mediaFilter;
  }
  state.page = 1;
  if (state.currentTab === 'folders') {
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

function applyCardSize() {
  state.cardSize = snapBrowseCardBasis(state.cardSize);
  var pg = $('#photoGrid');
  if (pg) {
    pg.style.setProperty('--grid-card-basis', String(state.cardSize));
  }
  var zl = $('#zoomLabel');
  if (zl) {
    zl.textContent = CARD_SIZE_TIERS[browseCardTierIndexForBasis(state.cardSize)].label;
  }
}

function updateSidebarActive() {
  // Only update active classes, no full re-render needed to avoid flicker
  if (state.currentTab !== 'folders') {
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
  ph.className = 'placeholder placeholder-fallback';
  ph.innerHTML =
    '<div class="ext">\u26A0\uFE0F</div><div>\u7F29\u7565\u56FE\u52A0\u8F7D\u5931\u8D25</div>';
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

async function loadFolderCovers() {
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
    var raw = await apiGet(url);
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
    $('#photoGrid').innerHTML =
      '<div class="empty-state"><div class="icon">\u26A0\uFE0F</div><div class="title">\u76EE\u5F55\u52A0\u8F7D\u5931\u8D25</div></div>';
    $('#pagination').style.display = 'none';
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
    $('#photoGrid').innerHTML =
      '<div class="empty-state"><div class="icon">D</div><div class="title">\u52A0\u8F7D\u5931\u8D25</div></div>';
    return;
  }
  var useMediaRatio = state.cardAspectMode === 'masonry';
  var html = '<div class="grid" data-use-media-ratio="' + (useMediaRatio ? '1' : '0') + '">';
  for (var i = 0; i < covers.length; i++) {
    var row = covers[i];
    var folderPath = row.folder_path || '';
    var name = folderDisplayBasename(folderPath);
    var coverId = parseInt(row.id, 10);
    var thumbUrl = !isNaN(coverId) && coverId > 0 ? '/thumb/' + coverId : '';
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
  $('#photoGrid').innerHTML = html;
  bindGridImageProgress($('#photoGrid'));
  applyCardSize();
}

// === Load photos ===
async function loadPhotos(extraParams) {
  var requestSeq = ++state.photosRequestSeq;
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
        : '');

    switch (state.currentView) {
      case 'search':
        result = await apiGet(
          '/api/search?q=' + encodeURIComponent(state.searchQuery) + baseParams,
        );
        if (requestSeq !== state.photosRequestSeq) return;
        $('#toolbarPath').textContent = '\u641C\u7D22: ' + state.searchQuery;
        break;
      case 'folder_overview':
        if (requestSeq !== state.photosRequestSeq) return;
        await loadFolderCovers();
        if (requestSeq !== state.photosRequestSeq) return;
        return;
      case 'folder':
        result = await apiGet(
          '/api/folder-photos?path=' + encodeURIComponent(state.currentPath) + baseParams,
        );
        if (requestSeq !== state.photosRequestSeq) return;
        // Load immediate subfolder covers
        state.currentSubfolderCovers = [];
        try {
          var subfolderResp = await apiGet(
            '/api/immediate-subfolder-covers?parentPath=' +
              encodeURIComponent(state.currentPath) +
              (state.mediaFilter && state.mediaFilter !== 'all'
                ? '&mediaType=' + encodeURIComponent(state.mediaFilter)
                : ''),
          );
          state.currentSubfolderCovers = Array.isArray(subfolderResp)
            ? subfolderResp
            : subfolderResp.covers || [];
        } catch (e) {
          console.warn('Failed to load subfolder covers:', e);
          state.currentSubfolderCovers = [];
        }
        break;
      case 'date':
        result = await apiGet(
          '/api/date-photos?date=' + encodeURIComponent(state.currentDate) + baseParams,
        );
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
        break;
      case 'root':
        result = await apiGet('/api/photos?' + baseParams + '&rootId=' + state._rootId);
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
        break;
      default:
        var url = '/api/photos?' + baseParams;
        if (extraParams) url += '&' + extraParams;
        result = await apiGet(url);
        if (requestSeq !== state.photosRequestSeq) return;
        state.currentSubfolderCovers = [];
    }

    state.currentPhotos = result.photos || [];
    state.previewTotalPhotos = result.total || 0;
    state.previewTotalPages = result.totalPages || 1;
    if (state.currentView === 'folder') {
      var scopedTotal = Number(result && result.total) || 0;
      var scopedVideoCount = Number(result && result.videoCount) || 0;
      var subfolderCount = state.currentSubfolderCovers.length;
      var statsText = '';
      if (subfolderCount > 0 && scopedTotal > 0) {
        statsText =
          formatNumber(subfolderCount) +
          ' 个子文件夹 | ' +
          formatNumber(scopedTotal) +
          ' 张照片 | 视频 ' +
          formatNumber(scopedVideoCount) +
          ' 条';
      } else if (subfolderCount > 0) {
        statsText = formatNumber(subfolderCount) + ' 个子文件夹 | 0 张照片';
      } else {
        statsText =
          scopedTotal > 0
            ? formatNumber(scopedTotal) + ' 张照片 | 视频 ' + formatNumber(scopedVideoCount) + ' 条'
            : '0 张照片';
      }
      $('#headerStats').textContent = statsText;
    } else if (state.stats && state.stats.totalPhotos > 0) {
      $('#headerStats').textContent =
        formatNumber(state.stats.totalPhotos) +
        ' 张照片 | ' +
        formatSize(state.stats.totalSize) +
        ' | 视频 ' +
        formatNumber(state.stats.videoPhotos || 0) +
        ' 条 | ' +
        formatSize(state.stats.videoSize || 0);
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
    $('#photoGrid').innerHTML =
      '<div class="empty-state"><div class="icon">⚠️</div><div class="title">页面加载失败</div></div>';
    $('#pagination').style.display = 'none';
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
    var emptyTitle = '\u6CA1\u6709\u627E\u5230\u7167\u7247';
    if (state.mediaFilter === 'video') emptyTitle = '\u6CA1\u6709\u627E\u5230\u89C6\u9891';
    else if (state.mediaFilter === 'image') emptyTitle = '\u6CA1\u6709\u627E\u5230\u56FE\u7247';
    $('#photoGrid').innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-state-visual" aria-hidden="true"><span class="empty-state-icon">\uD83D\uDDBC\uFE0F</span></div>' +
      '<div class="title">' +
      emptyTitle +
      '</div>' +
      '<p class="empty-state-hint">\u8BD5\u8BD5\u8C03\u6574\u4E0A\u65B9\u7B5B\u9009\u6216\u6392\u5E8F\u6761\u4EF6\u3002</p>' +
      '</div>';
    return;
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
      var subThumbUrl = !isNaN(coverId) && coverId > 0 ? '/thumb/' + coverId : '';
      var cnt = cover.folder_photo_count != null ? cover.folder_photo_count : 0;
      html +=
        '<div class="photo-card folder-card" data-folder-path="' + escapeAttr(folderPath) + '">';
      if (subThumbUrl) {
        html +=
          '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
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
    var thumbUrl = photo.has_thumbnail ? '/thumb/' + photo.id : '';
    // comment cleaned
    var delay = Math.min(i * 30, 600);
    var cardStyle = 'animation-delay:' + delay + 'ms;';
    if (ratio && !isMasonryAspect) cardStyle += 'aspect-ratio:' + ratio + ';';
    html += '<div class="photo-card" style="' + cardStyle + '" onclick="startPreview(' + i + ')">';
    if (isVideo) {
      html += '<span class="media-type-badge media-type-badge-video">\u89C6\u9891</span>';
    }
    if (thumbUrl) {
      var imgWH = ratioObj ? ' width="' + ratioObj.w + '" height="' + ratioObj.h + '"' : '';
      html +=
        '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
        '<div class="thumb-vignette" aria-hidden="true"></div>' +
        '<img src="' +
        thumbUrl +
        '" alt="' +
        escapeHtml(photo.file_name) +
        '"' +
        imgWH +
        ' loading="lazy" class="loading grid-thumb" />';
    } else {
      var phStyle =
        'width:100%;display:flex;align-items:center;justify-content:center;background:var(--bg-hover);color:var(--text-muted);font-size:16px;font-weight:600;';
      phStyle += isMasonryAspect ? 'min-height:160px;' : 'height:100%;';
      html +=
        '<div class="placeholder" style="' + phStyle + '">' + (photo.file_type || '?') + '</div>';
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
  $('#photoGrid').innerHTML = html;
  bindGridImageProgress($('#photoGrid'));
  applyCardSize();
}

function showSkeleton(gridHint) {
  var hint =
    gridHint === 'folders'
      ? '\u6B63\u5728\u52A0\u8F7D\u76EE\u5F55\u5217\u8868'
      : '\u6B63\u5728\u52A0\u8F7D\u56FE\u7247';
  var html =
    '<div class="grid-loading" role="status" aria-live="polite">' +
    '<div class="grid-loading-hint">' +
    '<span class="grid-loading-spinner" aria-hidden="true"></span>' +
    '<span class="grid-loading-text">' +
    hint +
    '</span>' +
    '<span class="grid-loading-dots" aria-hidden="true">' +
    '<span></span><span></span><span></span>' +
    '</span>' +
    '</div>' +
    '<div class="grid">';
  for (var i = 0; i < 12; i++) {
    html += '<div class="skeleton" style="--sk:' + i + '"></div>';
  }
  html += '</div></div>';
  $('#photoGrid').innerHTML = html;
  applyCardSize();
}

function renderPagination(result) {
  if (result.totalPages <= 1) {
    $('#pagination').style.display = 'none';
    return;
  }
  $('#pagination').style.display = 'flex';
  $('#pageInfo').textContent =
    result.total + (result.isFolderOverview ? ' \u4E2A\u76EE\u5F55' : ' \u5F20');
  $('#prevPage').disabled = result.page <= 1;
  $('#nextPage').disabled = result.page >= result.totalPages;
  var randBtn = $('#randomPageBtn');
  if (randBtn) randBtn.disabled = result.totalPages <= 1;

  // comment cleaned
  var pages = generatePageNumbers(result.page, result.totalPages);
  var html = '';
  for (var i = 0; i < pages.length; i++) {
    if (pages[i] === '...') {
      html += '<span class="page-ellipsis">...</span>';
    } else {
      var cls = pages[i] === result.page ? ' active' : '';
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
  $('#pageNumbers').innerHTML = html;
}

function generatePageNumbers(current, total) {
  if (total <= 7) {
    var arr = [];
    for (var pageNum = 1; pageNum <= total; pageNum++) arr.push(pageNum);
    return arr;
  }
  var pages = [1];
  if (current > 3) pages.push('...');
  var start = Math.max(2, current - 1);
  var end = Math.min(total - 1, current + 1);
  for (var midPageNum = start; midPageNum <= end; midPageNum++) pages.push(midPageNum);
  if (current < total - 2) pages.push('...');
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
  var isVideo = isWebVideoFileType(photo.file_type);
  setSubtitleToggleVisible(isVideo);

  if (state.isMobile && !state.previewSwipeHintShown) {
    showPreviewSwipeHint();
  }

  function showPreviewLoading() {
    var el = $('#previewLoading');
    if (el) el.classList.add('show');
  }

  function hidePreviewLoading() {
    var el = $('#previewLoading');
    if (el) el.classList.remove('show');
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

      var previewUrl = '/preview-image/' + photo.id + '?_=' + requestSeq;
      var fallbackUrl = '/photo/' + photo.id + '?_=' + requestSeq;

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
        img.removeAttribute('src');
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
        img.src = '/thumb/' + photo.id;
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
    showPreviewLoading();

    if (overlay.classList.contains('active')) {
      img.classList.add('switching');
      requestAnimationFrame(function () {
        if (!isCurrentPreviewRequest()) return;
        img.style.display = 'none';
        img.removeAttribute('src');
        img.classList.remove('switching');
        video.style.display = '';
      });
    } else {
      overlay.classList.remove('closing');
      overlay.classList.add('active');
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

  if (!isVideo) {
    $('#previewInfo').textContent = buildPreviewInfoText(photo, index);
  }
  syncFullscreenButton();

  preloadAdjacentPages(index);
}

function closePreview(fromHistory) {
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
  setPreviewMobileUiHidden(false);
  setMobilePreviewNavVisible(false);
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
  var imgEl = $('#previewImage');
  if (imgEl) {
    imgEl.style.display = '';
    imgEl.style.visibility = '';
  }
  var loader = $('#previewLoading');
  if (loader) loader.classList.remove('show');
  overlay.classList.add('closing');
  setTimeout(function () {
    overlay.classList.remove('active', 'closing');
    $('#previewImage').src = '';
    resetZoom();
  }, 280);
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
  if (!$('#previewOverlay').classList.contains('active')) return;
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
  if (!$('#previewOverlay').classList.contains('active')) return;
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
  var p = state.previewPhotos[state.previewIndex];
  var infoEl = $('#previewInfo');
  if (p && infoEl && !isWebVideoFileType(p.file_type)) {
    infoEl.textContent = buildPreviewInfoText(p, state.previewIndex);
  }
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

function updatePreviewTransform() {
  var img = $('#previewImage');
  img.style.transform =
    'translate(' + state.panX + 'px, ' + state.panY + 'px) scale(' + state.zoom + ')';
  $('#previewZoom').textContent = Math.round(state.zoom * 100) + '%';
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
window.applyWebThemeStyle = applyWebThemeStyle;
window.showInstallGuide = showInstallGuide;
window.changeMediaFilter = changeMediaFilter;
window.changeSort = changeSort;
window.changeCardSize = changeCardSize;
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
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
init();
