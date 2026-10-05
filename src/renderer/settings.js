(function (global) {
  'use strict';

  function tSt(key, zh) {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
    return zh;
  }
  function tStFmt(key, map, zhFallback) {
    var s = tSt(key, zhFallback);
    if (!map) return s;
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        s = s.split('{' + k + '}').join(String(map[k]));
      }
    }
    return s;
  }

  // ===== settings-flow.js =====
  /**
   * 每页张数档位：与底栏「每页数量」控件、主进程校验共用一份（`utils.js` 的
   * `BROWSE_PAGE_SIZE_TIERS`）。这里保留同值字面量兜底，与 app.js 取 `CARD_SIZE_TIERS`
   * 的写法一致——本文件可能被单独加载，不能假设 utils.js 一定先跑。
   */
  function browsePageSizeTiers() {
    var list = window.RendererUtils && window.RendererUtils.BROWSE_PAGE_SIZE_TIERS;
    return list && list.length ? list : [10, 20, 50, 80, 100, 200];
  }

  function openSettingsPage(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var sidebarUi = options.sidebarUi || {};

    // 保存进入管理页前的浏览标签；仅允许真实浏览 tab，避免异常值导致返回时 showTabContent 抛错闪退
    (function () {
      var cur =
        state.currentTab && state.currentTab !== 'settings'
          ? state.currentTab
          : state.prevTab || 'folders';
      // ⚠️ `home` 在名单里：从首页点进设置页（卡 4 的三个深链）时，「返回」应当回到首页。
      // app.js 的 closeSettingsPage 会把回程的 'home' 分流到派生重建（showTabContent
      // 没有 home 分支，直接传进去会切出一页空白）。
      var ok =
        cur === 'folders' ||
        cur === 'dates' ||
        cur === 'duplicates' ||
        cur === 'people' ||
        cur === 'search' ||
        cur === 'home';
      state.tabBeforeSettings = ok ? cur : 'folders';
    })();
    state.currentTab = 'settings';
    /** 本次进入管理页后若修改了根目录/导入导出等，返回相册需整页重载；仅浏览设置项则保持 false */
    state.mustReloadBrowseAfterSettings = false;
    if (typeof options.onBumpSidebarViewToken === 'function') options.onBumpSidebarViewToken();

    if (dom.contentArea) dom.contentArea.style.display = 'none';
    if (dom.settingsPage) dom.settingsPage.style.display = 'flex';
    // 「settings-page-open」不在这里加：三个页面态 class（settings / search / people）
    // 一律由 app.js 的 syncPageOpenClasses 从 state.currentTab 派生，
    // 调用方 openSettingsPage 已经先 syncNavigationRail('settings') 对齐过一次。

    var sidebar = document.getElementById('sidebar');
    var sidebarResizer = document.getElementById('sidebarResizer');
    if (sidebarUi.showSidebarOnDesktop) sidebarUi.showSidebarOnDesktop(sidebar, state.isMobile);
    else if (sidebar) sidebar.style.display = '';
    if (sidebarResizer) sidebarResizer.style.display = state.isMobile ? 'none' : '';
    // 保留侧栏 DOM，返回相册时可软恢复，避免整树与网格重载

    if (typeof options.onCloseMobileSidebar === 'function') options.onCloseMobileSidebar();
    // 目录表由 onLoadRootFolders 负责：先 lite 秒开列表再异步补统计；勿在此处再调 renderSettingsFolderList，否则会与 lite 并发拉全量。
    if (typeof options.onLoadRootFolders === 'function')
      options.onLoadRootFolders(state.rootFolders && state.rootFolders.length > 0, true);

    var done = Promise.resolve();
    if (typeof options.onLoadSettingsUI === 'function')
      done = Promise.resolve(options.onLoadSettingsUI());
    return done.then(function () {
      if (state.currentTab !== 'settings') return;
      if (typeof options.onStartSettingsHydrateRetryIfNeeded === 'function')
        options.onStartSettingsHydrateRetryIfNeeded();
      if (typeof options.onRestoreSettingsPageSectionScroll === 'function')
        options.onRestoreSettingsPageSectionScroll();
      var settingsBtn = document.getElementById('topbarSettingsBtn');
      if (settingsBtn) settingsBtn.classList.add('active');
    });
  }

  function closeSettingsPage(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var sidebarUi = options.sidebarUi || {};

    // 离开设置页必须先退出「录制快捷键」：它的 keydown 挂在 window 捕获阶段，
    // 不收掉的话离开设置页后按任何键都还在被它吞（界面已关、用户却按不动别处）。
    if (window.RendererShortcutSettings && state.shortcutRecording) {
      window.RendererShortcutSettings.stopRecording({ state: state });
    }

    if (dom.contentArea) dom.contentArea.style.display = '';
    if (dom.settingsPage) dom.settingsPage.style.display = 'none';
    // 同上：页面态 class 由 syncPageOpenClasses 派生，末尾 onShowTabContent → showTabContent
    // → syncNavigationRail 会把它摘掉；app.js 的 closeSettingsPage 之后还会再兜一次对齐。
    var restoreTab = state.tabBeforeSettings || state.prevTab || 'folders';
    if (
      restoreTab !== 'folders' &&
      restoreTab !== 'dates' &&
      restoreTab !== 'duplicates' &&
      restoreTab !== 'people' &&
      restoreTab !== 'search' &&
      restoreTab !== 'home'
    ) {
      restoreTab = 'folders';
    }
    state.currentTab = restoreTab;

    var settingsBtn = document.getElementById('topbarSettingsBtn');
    if (settingsBtn) settingsBtn.classList.remove('active');

    var sidebar = document.getElementById('sidebar');
    var sidebarResizer = document.getElementById('sidebarResizer');
    var softReturn =
      !state.mustReloadBrowseAfterSettings &&
      (restoreTab === 'folders' || restoreTab === 'dates' || restoreTab === 'duplicates');
    if (state.mustReloadBrowseAfterSettings) {
      if (dom.sidebarContent) dom.sidebarContent.innerHTML = '';
      if (dom.sidebarContentDuplicate) dom.sidebarContentDuplicate.innerHTML = '';
    }
    try {
      sessionStorage.setItem(
        'photoManager.lastSettingsReturn',
        JSON.stringify({
          soft: !!softReturn,
          tab: restoreTab,
          mustReload: !!state.mustReloadBrowseAfterSettings,
          at: Date.now(),
        }),
      );
    } catch (eSs) {}
    if (sidebarUi.showSidebarOnDesktop) sidebarUi.showSidebarOnDesktop(sidebar, state.isMobile);
    else if (!state.isMobile && sidebar) sidebar.style.display = '';
    if (sidebarResizer) sidebarResizer.style.display = state.isMobile ? 'none' : '';

    if (typeof options.onStopSettingsHydrateRetry === 'function')
      options.onStopSettingsHydrateRetry();
    if (typeof options.onStopThumbnailBackfillPolling === 'function')
      options.onStopThumbnailBackfillPolling();
    if (typeof options.onShowTabContent === 'function') {
      try {
        options.onShowTabContent(state.currentTab, { softFromSettings: softReturn });
      } catch (eShow) {
        try {
          Logger.error(eShow);
        } catch (eLog) {}
      }
    }
  }

  function startSettingsHydrateRetryIfNeeded(options) {
    options = options || {};
    var state = options.state || {};
    var attempts = 0;
    var maxAttempts = 6;
    if (typeof options.onStopSettingsHydrateRetry === 'function')
      options.onStopSettingsHydrateRetry();
    if (typeof options.onEnsureSettingsFolderListHydrated === 'function')
      options.onEnsureSettingsFolderListHydrated();

    state.settingsHydrateTimer = setInterval(function () {
      attempts++;
      if (typeof options.onEnsureSettingsFolderListHydrated === 'function')
        options.onEnsureSettingsFolderListHydrated();
      var listEl = document.getElementById('settingsFolderList');
      var hasItems = !!(listEl && listEl.querySelector('.folder-manage-row'));
      if (hasItems || attempts >= maxAttempts) {
        if (typeof options.onStopSettingsHydrateRetry === 'function')
          options.onStopSettingsHydrateRetry();
      }
    }, 800);
  }

  function stopSettingsHydrateRetry(options) {
    options = options || {};
    var state = options.state || {};
    if (state.settingsHydrateTimer) {
      clearInterval(state.settingsHydrateTimer);
      state.settingsHydrateTimer = null;
    }
  }

  global.RendererSettingsFlow = Object.assign({}, global.RendererSettingsFlow || {}, {
    openSettingsPage: openSettingsPage,
    closeSettingsPage: closeSettingsPage,
    startSettingsHydrateRetryIfNeeded: startSettingsHydrateRetryIfNeeded,
    stopSettingsHydrateRetry: stopSettingsHydrateRetry,
  });

  // ===== settings-sync.js =====
  /**
   * 「网格与比例」的取值域与编解码：与底栏 `#browseGridStyleSelect`、`app.js` 的
   * `state.cardRatio` 共用一份（`utils.js` 的 `BROWSE_CARD_RATIOS` 与那两个 encode/parse）。
   * 与 `browsePageSizeTiers()` 同理保留同值兜底——本文件可能被单独加载，
   * 不能假设 utils.js 一定先跑。
   */
  function gridStyleRatios() {
    var list = window.RendererUtils && window.RendererUtils.BROWSE_CARD_RATIOS;
    return list && list.length ? list : ['1 / 1', '3 / 4', '4 / 3', '9 / 16', '16 / 9'];
  }

  function normalizeBrowseCardRatio(v) {
    var u = window.RendererUtils;
    if (u && typeof u.normalizeBrowseCardRatio === 'function')
      return u.normalizeBrowseCardRatio(v);
    var s = String(v || '').trim();
    return gridStyleRatios().indexOf(s) >= 0 ? s : '1 / 1';
  }

  function normalizeBrowseCardLayout(v) {
    var u = window.RendererUtils;
    if (u && typeof u.normalizeBrowseCardLayout === 'function')
      return u.normalizeBrowseCardLayout(v);
    return String(v || '')
      .trim()
      .toLowerCase() === 'uniform'
      ? 'uniform'
      : 'masonry';
  }

  function encodeBrowseGridStyleValue(layoutMode, cardRatio) {
    var u = window.RendererUtils;
    if (u && typeof u.encodeBrowseGridStyleValue === 'function')
      return u.encodeBrowseGridStyleValue(layoutMode, cardRatio);
    if (normalizeBrowseCardLayout(layoutMode) === 'masonry') return 'masonry';
    return 'uniform|' + normalizeBrowseCardRatio(cardRatio);
  }

  function parseBrowseGridStyleValue(raw) {
    var u = window.RendererUtils;
    if (u && typeof u.parseBrowseGridStyleValue === 'function')
      return u.parseBrowseGridStyleValue(raw);
    var s = String(raw || '').trim();
    var bar = s.indexOf('|');
    if (bar > 0 && s.slice(0, bar) === 'uniform') {
      return { layout: 'uniform', ratio: normalizeBrowseCardRatio(s.slice(bar + 1)) };
    }
    return { layout: 'masonry', ratio: null };
  }

  function applyBrowsePreferencesFromSettings(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var settings = options.settings;
    var snapBrowseCardBasis = options.snapBrowseCardBasis;
    var onApplyCardSize = options.onApplyCardSize;
    var onSetBrowseAppliedSnapshotFromObject = options.onSetBrowseAppliedSnapshotFromObject;
    if (!settings) return;
    if (typeof snapBrowseCardBasis !== 'function') return;
    if (
      typeof onApplyCardSize !== 'function' ||
      typeof onSetBrowseAppliedSnapshotFromObject !== 'function'
    )
      return;

    var allowed = ['date_taken', 'date_modified', 'file_name', 'file_size', 'folder_path'];
    var sb = settings.browseSortBy;
    var so = settings.browseSortOrder;
    if (sb && allowed.indexOf(sb) >= 0) state.sortBy = sb;
    if (so === 'ASC' || so === 'DESC') state.sortOrder = so;
    var ps = parseInt(settings.browsePageSize, 10);
    if (browsePageSizeTiers().indexOf(ps) >= 0) state.pageSize = ps;
    var cs = snapBrowseCardBasis(settings.browseCardSize);
    var cr = normalizeBrowseCardRatio(settings.browseCardRatio);
    state.cardSize = cs;
    state.cardRatio = cr;
    state.thumbCrop = !!settings.browseThumbCrop;
    state.cardLayoutMode = normalizeBrowseCardLayout(settings.browseCardLayout);
    state.browseFolderIncludeSubfolders = settings.browseFolderIncludeSubfolders !== false;
    if (dom.sortSelect) dom.sortSelect.value = state.sortBy + '|' + state.sortOrder;
    onApplyCardSize();
    // 底栏「每页数量」读数与 state.pageSize 同源，跟着这次应用一起刷新（可选回调，旧调用方不受影响）
    if (typeof options.onApplyPageSize === 'function') options.onApplyPageSize();
    onSetBrowseAppliedSnapshotFromObject(settings);
  }

  function syncBrowsePrefsFormFromRuntimeState(options) {
    options = options || {};
    var state = options.state || {};
    var sortEl = document.getElementById('settingBrowseSort');
    if (sortEl) sortEl.value = state.sortBy + '|' + state.sortOrder;
    var psEl = document.getElementById('settingBrowsePageSize');
    if (psEl) psEl.value = String(state.pageSize);
    var csEl = document.getElementById('settingBrowseCardSize');
    if (csEl) csEl.value = String(state.cardSize);
    var gsEl = document.getElementById('settingBrowseGridStyle');
    if (gsEl) gsEl.value = encodeBrowseGridStyleValue(state.cardLayoutMode, state.cardRatio);
    var tcEl = document.getElementById('settingBrowseThumbCrop');
    if (tcEl) tcEl.value = state.thumbCrop ? '1' : '0';
    var sfEl = document.getElementById('settingBrowseFolderIncludeSubfolders');
    if (sfEl) sfEl.value = state.browseFolderIncludeSubfolders !== false ? '1' : '0';
    var vcbEl = document.getElementById('settingVideoClickBehavior');
    if (vcbEl) vcbEl.value = state.videoClickBehavior === 'embedded' ? 'embedded' : 'system';
  }

  async function persistBrowsePrefsFromForm(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var snapBrowseCardBasis = options.snapBrowseCardBasis;
    var appAlert = options.appAlert;
    var onApplyBrowsePreferencesFromSettings = options.onApplyBrowsePreferencesFromSettings;
    var onSyncBrowsePrefsFormFromRuntimeState = options.onSyncBrowsePrefsFormFromRuntimeState;
    var onSaveLastSettingsSectionId = options.onSaveLastSettingsSectionId;
    var onRenderSettingsNav = options.onRenderSettingsNav;
    var onLoadPhotos = options.onLoadPhotos;
    if (!(api && api.has && api.has('updateSettings'))) return;
    if (typeof snapBrowseCardBasis !== 'function') return;
    if (typeof onApplyBrowsePreferencesFromSettings !== 'function') return;
    if (typeof onSyncBrowsePrefsFormFromRuntimeState !== 'function') return;
    if (
      typeof onSaveLastSettingsSectionId !== 'function' ||
      typeof onRenderSettingsNav !== 'function'
    )
      return;
    if (typeof onLoadPhotos !== 'function') return;

    var sortEl = document.getElementById('settingBrowseSort');
    var psEl = document.getElementById('settingBrowsePageSize');
    var csEl = document.getElementById('settingBrowseCardSize');
    var gsEl = document.getElementById('settingBrowseGridStyle');
    var tcEl = document.getElementById('settingBrowseThumbCrop');
    var sfEl = document.getElementById('settingBrowseFolderIncludeSubfolders');
    if (!sortEl || !psEl || !csEl || !gsEl || !tcEl) return;

    var pv = sortEl.value.split('|');
    var sb = pv[0];
    var so = pv[1];
    var allowed = ['date_taken', 'date_modified', 'file_name', 'file_size', 'folder_path'];
    if (allowed.indexOf(sb) < 0) return;
    if (so !== 'ASC' && so !== 'DESC') so = 'DESC';
    var ps = parseInt(psEl.value, 10);
    if (browsePageSizeTiers().indexOf(ps) < 0) ps = 20;
    var cs = snapBrowseCardBasis(csEl.value);
    var parsedGs = parseBrowseGridStyleValue(gsEl.value);
    var cl = normalizeBrowseCardLayout(parsedGs.layout);
    var cr =
      parsedGs.layout === 'uniform' && parsedGs.ratio
        ? parsedGs.ratio
        : normalizeBrowseCardRatio(state.cardRatio);
    var tc = tcEl.value === '1';
    var folderInc = sfEl ? sfEl.value === '1' : state.browseFolderIncludeSubfolders !== false;
    var vcbEl = document.getElementById('settingVideoClickBehavior');
    var videoClickBehavior = vcbEl && vcbEl.value === 'embedded' ? 'embedded' : 'system';
    var b = state.browsePrefsApplied;
    if (
      b &&
      sb === b.sortBy &&
      so === b.sortOrder &&
      ps === b.pageSize &&
      cs === b.cardSize &&
      cr === b.cardRatio &&
      tc === !!b.thumbCrop &&
      cl === (b.cardLayoutMode || 'masonry') &&
      folderInc === !!b.browseFolderIncludeSubfolders &&
      videoClickBehavior === (b.videoClickBehavior || 'system')
    )
      return;

    try {
      var r = await api.updateSettings({
        browseSortBy: sb,
        browseSortOrder: so,
        browsePageSize: ps,
        browseCardSize: cs,
        browseCardRatio: cr,
        browseThumbCrop: tc,
        browseCardLayout: cl,
        browseFolderIncludeSubfolders: folderInc,
        videoClickBehavior: videoClickBehavior,
      });
      onApplyBrowsePreferencesFromSettings(r);
      onSyncBrowsePrefsFormFromRuntimeState();
      onSaveLastSettingsSectionId('settingsSectionBrowse');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionBrowse');
      state.page = 1;
      onLoadPhotos();
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert(
          tStFmt(
            'settings.save.browsePrefsFail',
            { error: e && e.message ? e.message : String(e) },
            '保存浏览偏好失败：' + (e && e.message ? e.message : String(e)),
          ),
        );
      onSyncBrowsePrefsFormFromRuntimeState();
    }
  }

  // 扫描选项 UI 已从管理界面移除（相关同步逻辑已下线）

  async function persistGeneralSettingsFromControls(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api || null;
    var onGetAppearanceControlValue = options.onGetAppearanceControlValue;
    var onSyncAppearanceFromSettings = options.onSyncAppearanceFromSettings;
    var onSetGeneralSettingsAppliedFromObject = options.onSetGeneralSettingsAppliedFromObject;
    var onSyncAppearanceControls = options.onSyncAppearanceControls;
    var onApplySubtitleStyleFromSettings = options.onApplySubtitleStyleFromSettings;
    var onSyncSubtitleStyleControlsFromSettings = options.onSyncSubtitleStyleControlsFromSettings;
    var onSaveLastSettingsSectionId = options.onSaveLastSettingsSectionId;
    var onRenderSettingsNav = options.onRenderSettingsNav;
    var appAlert = options.appAlert;
    if (!(api && api.has && api.has('updateSettings'))) return;
    if (typeof onGetAppearanceControlValue !== 'function') return;
    if (typeof onSyncAppearanceFromSettings !== 'function') return;
    if (typeof onSetGeneralSettingsAppliedFromObject !== 'function') return;
    if (typeof onSyncAppearanceControls !== 'function') return;
    if (typeof onApplySubtitleStyleFromSettings !== 'function') return;
    if (typeof onSyncSubtitleStyleControlsFromSettings !== 'function') return;
    if (
      typeof onSaveLastSettingsSectionId !== 'function' ||
      typeof onRenderSettingsNav !== 'function'
    )
      return;

    function normalizeThumbBackfillConcurrency(v) {
      var c = parseInt(v, 10);
      if (isNaN(c) || c < 1) c = 3;
      if (c > 8) c = 8;
      return c;
    }
    var auto = document.getElementById('settingAutoScan');
    var autoThumb = document.getElementById('settingAutoThumbBackfillOnStartup');
    var autoHash = document.getElementById('settingAutoHashOnStartup');
    var launchDefaultEl = document.getElementById('settingLaunchDefaultPage');
    var subFamilyEl = document.getElementById('settingSubtitleFontFamily');
    var subSizeEl = document.getElementById('settingSubtitleFontSize');
    var subWeightEl = document.getElementById('settingSubtitleFontWeight');
    var subColorEl = document.getElementById('settingSubtitleColor');
    var concEl = document.getElementById('settingThumbBackfillConcurrency');
    var similarThresholdEl = document.getElementById('settingSimilarThreshold');
    if (
      !auto ||
      !autoThumb ||
      !autoHash ||
      !launchDefaultEl ||
      !subFamilyEl ||
      !subSizeEl ||
      !subWeightEl ||
      !subColorEl ||
      !concEl
    )
      return;
    // 外观三件套（明暗 / 强调色 / 背景基调）由控件 + 预设共同决定，themeStyle 只是派生标签
    var appearance = onGetAppearanceControlValue();
    var subFamily = String(subFamilyEl.value || '')
      .trim()
      .toLowerCase();
    if (['system', 'serif', 'mono'].indexOf(subFamily) < 0) subFamily = 'system';
    var subSize = parseInt(subSizeEl.value, 10);
    if (isNaN(subSize)) subSize = 22;
    if (subSize < 12) subSize = 12;
    if (subSize > 72) subSize = 72;
    if (subSizeEl.value !== String(subSize)) subSizeEl.value = String(subSize);
    var subWeight = String(subWeightEl.value || '')
      .trim()
      .toLowerCase();
    if (['normal', 'medium', 'bold'].indexOf(subWeight) < 0) subWeight = 'medium';
    var subColor = String(subColorEl.value || '')
      .trim()
      .toLowerCase();
    if (['white', 'yellow', 'cyan', 'green', 'orange', 'pink'].indexOf(subColor) < 0)
      subColor = 'white';
    var launchDefaultPage = String(launchDefaultEl.value || '')
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
    var thumbConc = normalizeThumbBackfillConcurrency(concEl.value);
    if (concEl.value !== String(thumbConc)) concEl.value = String(thumbConc);
    var similarThreshold = parseInt(similarThresholdEl && similarThresholdEl.value, 10);
    if (isNaN(similarThreshold) || similarThreshold < 0) similarThreshold = 12;
    if (similarThreshold > 64) similarThreshold = 64;
    var ap = state.generalSettingsApplied;
    if (
      ap &&
      !!auto.checked === ap.autoScanOnStartup &&
      !!autoThumb.checked === ap.autoThumbBackfillOnStartup &&
      !!autoHash.checked === ap.autoHashOnStartup &&
      launchDefaultPage === (ap.launchDefaultPage || 'all_photos') &&
      appearance.theme === (ap.theme === 'light' ? 'light' : 'dark') &&
      appearance.uiAccent === (ap.uiAccent || 'violet') &&
      appearance.uiBackground === (ap.uiBackground || 'default') &&
      appearance.uiTexture === (ap.uiTexture || 'none') &&
      appearance.uiOpacity === (ap.uiOpacity || 'opaque') &&
      // ⚠️ 与透明度同一处坑：这里是**逐个字段比**，漏掉哪一维，那一维「切回默认值」就会被
      // 判成「无变化」→ 整次保存被短路吞掉（窗口背景的症状 = 「亚克力切不回实色」，
      // 而且因为它本来就要重启才生效，很容易被误当成「重启了也没生效」）。
      appearance.uiWindowBackdrop === (ap.uiWindowBackdrop || 'solid') &&
      subFamily === ap.subtitleFontFamily &&
      subSize === ap.subtitleFontSizePx &&
      subWeight === ap.subtitleFontWeight &&
      subColor === ap.subtitleColor &&
      thumbConc === normalizeThumbBackfillConcurrency(ap.thumbBackfillConcurrency) &&
      similarThreshold === Math.max(0, Math.min(64, parseInt(ap.similarThreshold, 10) || 12))
    ) {
      return;
    }
    try {
      var r = await api.updateSettings({
        autoScanOnStartup: !!auto.checked,
        autoThumbBackfillOnStartup: !!autoThumb.checked,
        autoHashOnStartup: !!autoHash.checked,
        launchDefaultPage: launchDefaultPage,
        theme: appearance.theme,
        uiAccent: appearance.uiAccent,
        uiBackground: appearance.uiBackground,
        uiTexture: appearance.uiTexture,
        uiOpacity: appearance.uiOpacity,
        uiWindowBackdrop: appearance.uiWindowBackdrop,
        subtitleFontFamily: subFamily,
        subtitleFontSizePx: subSize,
        subtitleFontWeight: subWeight,
        subtitleColor: subColor,
        thumbBackfillConcurrency: thumbConc,
        similarThreshold: similarThreshold,
      });
      onSyncAppearanceFromSettings(r);
      onSetGeneralSettingsAppliedFromObject(r);
      if (dom.settingAutoScan) dom.settingAutoScan.checked = !!r.autoScanOnStartup;
      if (dom.settingAutoThumbBackfillOnStartup)
        dom.settingAutoThumbBackfillOnStartup.checked = !!r.autoThumbBackfillOnStartup;
      if (dom.settingAutoHashOnStartup)
        dom.settingAutoHashOnStartup.checked = !!r.autoHashOnStartup;
      if (launchDefaultEl) {
        var lp = String(r && r.launchDefaultPage ? r.launchDefaultPage : launchDefaultPage).trim();
        launchDefaultEl.value =
          lp === 'welcome' || lp === 'all_photos' || lp === 'all_folders' || lp === 'last_position'
            ? lp
            : 'all_photos';
      }
      onSyncAppearanceControls(r);
      onSyncSubtitleStyleControlsFromSettings(r);
      onApplySubtitleStyleFromSettings(r);
      if (concEl)
        concEl.value = String(normalizeThumbBackfillConcurrency(r.thumbBackfillConcurrency));
      if (similarThresholdEl)
        similarThresholdEl.value = String(
          Math.max(0, Math.min(64, parseInt(r.similarThreshold, 10) || 12)),
        );
      onSaveLastSettingsSectionId('settingsSectionAppearance');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionAppearance');
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert(
          tStFmt(
            'settings.save.generalFail',
            { error: e && e.message ? e.message : String(e) },
            '保存通用设置失败：' + (e && e.message ? e.message : String(e)),
          ),
        );
      if (ap) {
        if (dom.settingAutoScan) dom.settingAutoScan.checked = !!ap.autoScanOnStartup;
        if (dom.settingAutoThumbBackfillOnStartup)
          dom.settingAutoThumbBackfillOnStartup.checked = !!ap.autoThumbBackfillOnStartup;
        if (dom.settingAutoHashOnStartup)
          dom.settingAutoHashOnStartup.checked = !!ap.autoHashOnStartup;
        if (launchDefaultEl) launchDefaultEl.value = ap.launchDefaultPage || 'all_photos';
        if (concEl)
          concEl.value = String(normalizeThumbBackfillConcurrency(ap.thumbBackfillConcurrency));
        if (similarThresholdEl)
          similarThresholdEl.value = String(
            Math.max(0, Math.min(64, parseInt(ap.similarThreshold, 10) || 12)),
          );
        onSyncAppearanceControls(ap);
        onSyncSubtitleStyleControlsFromSettings(ap);
        onApplySubtitleStyleFromSettings(ap);
        // ⚠️ 回滚对象必须带齐**全部正交维度**：这里原先只传了三元组，保存失败时会把
        // 用户选的纹理 / 透明度一起回滚成 none / opaque（用户没改它们，却被清掉了）。
        // 窗口背景同理带上（它没有 `uiWindowBackdropApplied` → 属性不会被本层重置）。
        onSyncAppearanceFromSettings({
          theme: ap.theme,
          uiAccent: ap.uiAccent,
          uiBackground: ap.uiBackground,
          uiTexture: ap.uiTexture,
          uiOpacity: ap.uiOpacity,
          uiWindowBackdrop: ap.uiWindowBackdrop,
          autoScanOnStartup: ap.autoScanOnStartup,
          autoThumbBackfillOnStartup: ap.autoThumbBackfillOnStartup,
          autoHashOnStartup: ap.autoHashOnStartup,
        });
      }
    }
  }

  function setLocaleSelectValuePair(uiLocale) {
    var v = uiLocale === 'en' ? 'en' : 'zh-CN';
    var el = document.getElementById('settingUiLocale');
    var topEl = document.getElementById('topbarUiLocale');
    if (el) el.value = v;
    if (topEl) topEl.value = v;
  }

  async function persistUiLocaleFromControl(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var onSetGeneralSettingsAppliedFromObject = options.onSetGeneralSettingsAppliedFromObject;
    var onRenderSettingsNav = options.onRenderSettingsNav;
    var getLastSectionId = options.getLastSectionId;
    var appAlert = options.appAlert;
    if (!(api && api.has && api.has('updateSettings'))) return;
    if (typeof onSetGeneralSettingsAppliedFromObject !== 'function') return;
    var el = document.getElementById('settingUiLocale');
    var topEl = document.getElementById('topbarUiLocale');
    if (!el && !topEl) return;
    var v;
    if (options.source === 'topbar' && topEl) {
      v = topEl.value === 'en' ? 'en' : 'zh-CN';
      if (el) el.value = v;
    } else if (el) {
      v = el.value === 'en' ? 'en' : 'zh-CN';
      if (topEl) topEl.value = v;
    } else {
      v = topEl.value === 'en' ? 'en' : 'zh-CN';
    }
    var ap = state.generalSettingsApplied;
    if (ap && ap.uiLocale === v) return;
    try {
      var r = await api.updateSettings({ uiLocale: v });
      onSetGeneralSettingsAppliedFromObject(r);
      if (window.I18n && typeof window.I18n.setLocale === 'function') {
        window.I18n.setLocale(v);
      }
      setLocaleSelectValuePair(v);
      var sid = typeof getLastSectionId === 'function' ? getLastSectionId() : 'settingsSectionAppearance';
      if (typeof onRenderSettingsNav === 'function' && state.currentTab === 'settings')
        onRenderSettingsNav(sid);
      if (typeof options.onAfterLocaleChange === 'function') options.onAfterLocaleChange();
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert(
          tStFmt(
            'settings.save.localeFail',
            { error: e && e.message ? e.message : String(e) },
            '保存语言设置失败：' + (e && e.message ? e.message : String(e)),
          ),
        );
      if (ap) setLocaleSelectValuePair(ap.uiLocale);
    }
  }

  async function persistWindowCloseSetting(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var onSaveLastSettingsSectionId = options.onSaveLastSettingsSectionId;
    var onRenderSettingsNav = options.onRenderSettingsNav;
    var appAlert = options.appAlert;
    if (!(api && api.has && api.has('updateSettings'))) return;
    if (
      typeof onSaveLastSettingsSectionId !== 'function' ||
      typeof onRenderSettingsNav !== 'function'
    )
      return;

    var sel = document.getElementById('settingWindowClose');
    if (!sel) return;
    var v = sel.value;
    if (['ask', 'tray', 'quit'].indexOf(v) < 0) v = 'ask';
    var applied = state.windowCloseBehaviorApplied;
    if (applied != null && v === applied) return;
    try {
      var r = await api.updateSettings({ windowCloseBehavior: v });
      var wv = r && r.windowCloseBehavior ? r.windowCloseBehavior : v;
      if (['ask', 'tray', 'quit'].indexOf(wv) < 0) wv = v;
      state.windowCloseBehaviorApplied = wv;
      sel.value = wv;
      onSaveLastSettingsSectionId('settingsSectionAppearance');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionAppearance');
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert(
          tStFmt(
            'settings.save.windowCloseFail',
            { error: e && e.message ? e.message : String(e) },
            '保存关闭按钮设置失败：' + (e && e.message ? e.message : String(e)),
          ),
        );
      if (applied != null) sel.value = applied;
    }
  }

  function syncThemeStyleControls(options) {
    options = options || {};
    var themeStyleId = options.themeStyleId;
    var onNormalizeThemeStyle = options.onNormalizeThemeStyle;
    if (typeof onNormalizeThemeStyle !== 'function') return;
    var v = onNormalizeThemeStyle(themeStyleId);
    var settingsEl = document.getElementById('settingThemeStyle');
    if (settingsEl) settingsEl.value = v;
    var quickEl = document.getElementById('quickThemeStyle');
    if (quickEl) quickEl.value = v;
  }

  function hasWebPasswordFromSettings(s) {
    if (!s || typeof s !== 'object') return false;
    if (typeof s.hasWebPassword === 'boolean') return s.hasWebPassword;
    return !!(s.webPassword && String(s.webPassword).trim());
  }

  function syncWebPasswordUiFromSettings(options) {
    options = options || {};
    var state = options.state || {};
    var settings = options.settings;
    state.hasWebPassword = hasWebPasswordFromSettings(settings);
    var pwdInput = document.getElementById('settingWebPassword');
    if (pwdInput) {
      var active = document.activeElement;
      var editing = active === pwdInput || pwdInput.dataset.pwdTouched === '1';
      if (!editing) {
        delete pwdInput.dataset.pwdTouched;
        if (window.I18n && typeof window.I18n.t === 'function') {
          pwdInput.placeholder = state.hasWebPassword
            ? window.I18n.t('web.passwordSet')
            : window.I18n.t('web.passwordUnset');
        } else {
          pwdInput.placeholder = state.hasWebPassword ? '已设置' : '设置访问密码';
        }
      }
    }
    var st = document.getElementById('webPasswordStateText');
    if (st) {
      if (window.I18n && typeof window.I18n.t === 'function') {
        st.textContent = state.hasWebPassword
          ? window.I18n.t('web.statusTextOn')
          : window.I18n.t('web.statusTextOff');
      } else {
        st.textContent = state.hasWebPassword ? '状态：已设置' : '状态：未设置';
      }
    }
    var badge = document.getElementById('webPasswordStatusBadge');
    if (badge) {
      if (window.I18n && typeof window.I18n.t === 'function') {
        badge.textContent = state.hasWebPassword
          ? window.I18n.t('web.badgeOn')
          : window.I18n.t('web.badgeOff');
      } else {
        badge.textContent = state.hasWebPassword ? '已设置' : '未设置';
      }
      badge.classList.remove('online', 'offline');
      badge.classList.add(state.hasWebPassword ? 'online' : 'offline');
    }
  }

  // ===== 照片信息面板：显示字段勾选 =====
  //
  // 勾选框的**结构、顺序、文案**全部由 `src/web/js/photo-info-fields.js` 的注册表给出，
  // 本文件不写死任何一个字段名 —— 注册表加一个字段，这里自动多一行。
  // 🔴 标签是渲染时生成的字符串，**不经过 data-i18n** → 切语言必须重画（app.js 的
  //    localechange 分支里调 renderInfoPanelFieldsForm()）。

  function escHtmlInfo(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function infoPanelLocale() {
    return window.I18n && typeof window.I18n.getLocale === 'function'
      ? window.I18n.getLocale()
      : 'zh-CN';
  }

  /** 把 state 里的启用集画成勾选框；注册表缺失时清空而不是留半截旧 DOM */
  function renderInfoPanelFieldsForm(options) {
    options = options || {};
    var state = options.state || {};
    var host = document.getElementById('settingsInfoFields');
    if (!host) return;
    var fields = window.PhotoInfoFields;
    if (!fields) {
      host.innerHTML = '';
      return;
    }
    var groups = fields.groupFields(state.infoPanelFields, infoPanelLocale());
    var html = [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      html.push(
        '<div class="settings-info-field-group">' +
          '<span class="settings-info-field-group-title">' +
          escHtmlInfo(group.title) +
          '</span>' +
          '<div class="settings-info-field-grid">',
      );
      for (var f = 0; f < group.fields.length; f++) {
        var item = group.fields[f];
        html.push(
          '<label class="settings-info-field">' +
            '<input type="checkbox" data-info-field="' +
            escHtmlInfo(item.id) +
            '"' +
            (item.enabled ? ' checked' : '') +
            ' />' +
            '<span class="settings-info-field-name">' +
            escHtmlInfo(item.label) +
            '</span>' +
            '</label>',
        );
      }
      html.push('</div></div>');
    }
    host.innerHTML = html.join('');
  }

  /**
   * 设置里的启用集 → state（唯一运行期真源）+ 重画勾选框，必要时顺带重画开着的面板。
   * 只在**真的变了**的时候重画面板，否则每次拉设置都会把面板里的滚动位置顶掉。
   */
  function applyInfoPanelFieldsFromSettings(options) {
    options = options || {};
    var state = options.state || {};
    var settings = options.settings;
    var fields = window.PhotoInfoFields;
    if (!settings || !fields) return;
    var next = fields.normalizeFieldIds(settings.infoPanelFields);
    var prev = state.infoPanelFields;
    var changed = !prev || prev.length !== next.length || prev.join(',') !== next.join(',');
    state.infoPanelFields = next;
    renderInfoPanelFieldsForm({ state: state });
    if (changed && typeof options.onRerender === 'function') options.onRerender();
  }

  /** 读回勾选框 → 规范化 → 无常变则不发请求 */
  function readInfoPanelFieldsFromForm() {
    var host = document.getElementById('settingsInfoFields');
    var fields = window.PhotoInfoFields;
    if (!host || !fields) return null;
    var checks = host.querySelectorAll('input[data-info-field]');
    var picked = [];
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].checked) picked.push(checks[i].getAttribute('data-info-field'));
    }
    return fields.normalizeFieldIds(picked);
  }

  async function persistInfoPanelFieldsFromForm(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var appAlert = options.appAlert;
    if (!(api && api.has && api.has('updateSettings'))) return;
    var next = readInfoPanelFieldsFromForm();
    if (next == null) return;
    var prev = window.PhotoInfoFields.normalizeFieldIds(state.infoPanelFields);
    // ⚠️ 空数组是合法值（字段可以全关），所以不能用 `if (!next.length) return`
    if (prev.join(',') === next.join(',')) return;
    try {
      var r = await api.updateSettings({ infoPanelFields: next });
      if (typeof options.onApplyInfoPanelFieldsFromSettings === 'function') {
        options.onApplyInfoPanelFieldsFromSettings(r);
      }
      if (typeof options.onSaveLastSettingsSectionId === 'function')
        options.onSaveLastSettingsSectionId('settingsSectionBrowse');
      if (typeof options.onRenderSettingsNav === 'function')
        options.onRenderSettingsNav('settingsSectionBrowse');
    } catch (e) {
      if (typeof appAlert === 'function') {
        appAlert(
          tStFmt(
            'settings.save.infoFieldsFail',
            { error: e && e.message ? e.message : String(e) },
            '保存照片信息字段失败：' + (e && e.message ? e.message : String(e)),
          ),
        );
      }
      // 失败回滚：按 state 里的旧值把勾选框画回去，别让界面停在没落库的状态
      renderInfoPanelFieldsForm({ state: state });
    }
  }

  global.RendererSettingsSync = Object.assign({}, global.RendererSettingsSync || {}, {
    applyBrowsePreferencesFromSettings: applyBrowsePreferencesFromSettings,
    syncBrowsePrefsFormFromRuntimeState: syncBrowsePrefsFormFromRuntimeState,
    persistBrowsePrefsFromForm: persistBrowsePrefsFromForm,
    persistGeneralSettingsFromControls: persistGeneralSettingsFromControls,
    persistUiLocaleFromControl: persistUiLocaleFromControl,
    setLocaleSelectValuePair: setLocaleSelectValuePair,
    persistWindowCloseSetting: persistWindowCloseSetting,
    syncThemeStyleControls: syncThemeStyleControls,
    syncWebPasswordUiFromSettings: syncWebPasswordUiFromSettings,
    renderInfoPanelFieldsForm: renderInfoPanelFieldsForm,
    applyInfoPanelFieldsFromSettings: applyInfoPanelFieldsFromSettings,
    persistInfoPanelFieldsFromForm: persistInfoPanelFieldsFromForm,
  });
})(window);
