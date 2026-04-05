(function (global) {
  'use strict';

  // ===== settings-flow.js =====
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
      var ok = cur === 'folders' || cur === 'dates' || cur === 'duplicates';
      state.tabBeforeSettings = ok ? cur : 'folders';
    })();
    state.currentTab = 'settings';
    /** 本次进入管理页后若修改了根目录/导入导出等，返回相册需整页重载；仅浏览设置项则保持 false */
    state.mustReloadBrowseAfterSettings = false;
    if (typeof options.onBumpSidebarViewToken === 'function') options.onBumpSidebarViewToken();

    if (dom.contentArea) dom.contentArea.style.display = 'none';
    if (dom.settingsPage) dom.settingsPage.style.display = 'flex';
    document.documentElement.classList.add('settings-page-open');

    var sidebar = document.getElementById('sidebar');
    var sidebarResizer = document.getElementById('sidebarResizer');
    if (sidebarUi.hideSidebar) sidebarUi.hideSidebar(sidebar);
    else if (sidebar) sidebar.style.display = 'none';
    if (sidebarResizer) sidebarResizer.style.display = 'none';
    // 保留侧栏 DOM，返回相册时可软恢复，避免整树与网格重载

    if (typeof options.onCloseMobileSidebar === 'function') options.onCloseMobileSidebar();
    // 目录表由 onLoadRootFolders 负责：先 lite 秒开列表再异步补统计；勿在此处再调 renderSettingsFolderList，否则会与 lite 并发拉全量。
    if (typeof options.onLoadRootFolders === 'function')
      options.onLoadRootFolders(state.rootFolders && state.rootFolders.length > 0, true);

    var done = Promise.resolve();
    if (typeof options.onLoadSettingsUI === 'function')
      done = Promise.resolve(options.onLoadSettingsUI());
    return done.then(function () {
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

    if (dom.contentArea) dom.contentArea.style.display = '';
    if (dom.settingsPage) dom.settingsPage.style.display = 'none';
    document.documentElement.classList.remove('settings-page-open');
    var restoreTab = state.tabBeforeSettings || state.prevTab || 'folders';
    if (
      restoreTab !== 'folders' &&
      restoreTab !== 'dates' &&
      restoreTab !== 'duplicates'
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
      (restoreTab === 'folders' ||
        restoreTab === 'dates' ||
        restoreTab === 'duplicates');
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
          console.error(eShow);
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
  var BROWSE_GRID_STYLE_RATIOS = ['1 / 1', '3 / 4', '4 / 3', '9 / 16', '16 / 9'];

  function encodeBrowseGridStyleValue(layoutMode, cardRatio) {
    var cl = String(layoutMode || '').trim().toLowerCase() === 'uniform' ? 'uniform' : 'masonry';
    var cr = String(cardRatio || '').trim();
    if (BROWSE_GRID_STYLE_RATIOS.indexOf(cr) < 0) cr = '1 / 1';
    if (cl === 'masonry') return 'masonry';
    return 'uniform|' + cr;
  }

  function parseBrowseGridStyleValue(raw) {
    var s = String(raw || '').trim();
    if (s === 'masonry') return { layout: 'masonry', ratio: null };
    var bar = s.indexOf('|');
    if (bar > 0 && s.slice(0, bar) === 'uniform') {
      var cr = s.slice(bar + 1).trim();
      if (BROWSE_GRID_STYLE_RATIOS.indexOf(cr) < 0) cr = '1 / 1';
      return { layout: 'uniform', ratio: cr };
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
    if ([50, 100, 200, 300, 500].indexOf(ps) >= 0) state.pageSize = ps;
    var cs = snapBrowseCardBasis(settings.browseCardSize);
    var cr = String(settings.browseCardRatio || '').trim();
    if (
      cr !== '1 / 1' &&
      cr !== '3 / 4' &&
      cr !== '4 / 3' &&
      cr !== '9 / 16' &&
      cr !== '16 / 9'
    )
      cr = '1 / 1';
    state.cardSize = cs;
    state.cardRatio = cr;
    state.thumbCrop = !!settings.browseThumbCrop;
    state.cardLayoutMode = settings.browseCardLayout === 'uniform' ? 'uniform' : 'masonry';
    state.browseFolderIncludeSubfolders = settings.browseFolderIncludeSubfolders !== false;
    if (dom.sortSelect) dom.sortSelect.value = state.sortBy + '|' + state.sortOrder;
    onApplyCardSize();
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
    if ([50, 100, 200, 300, 500].indexOf(ps) < 0) ps = 100;
    var cs = snapBrowseCardBasis(csEl.value);
    var parsedGs = parseBrowseGridStyleValue(gsEl.value);
    var cl = parsedGs.layout === 'uniform' ? 'uniform' : 'masonry';
    var cr =
      parsedGs.layout === 'uniform' && parsedGs.ratio
        ? parsedGs.ratio
        : String(state.cardRatio || '1 / 1').trim();
    if (BROWSE_GRID_STYLE_RATIOS.indexOf(cr) < 0) cr = '1 / 1';
    var tc = tcEl.value === '1';
    var folderInc = sfEl ? sfEl.value === '1' : state.browseFolderIncludeSubfolders !== false;
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
      folderInc === !!b.browseFolderIncludeSubfolders
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
      });
      onApplyBrowsePreferencesFromSettings(r);
      onSyncBrowsePrefsFormFromRuntimeState();
      onSaveLastSettingsSectionId('settingsSectionBrowse');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionBrowse');
      state.page = 1;
      onLoadPhotos();
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert('保存浏览偏好失败：' + (e && e.message ? e.message : String(e)));
      onSyncBrowsePrefsFormFromRuntimeState();
    }
  }

  // 扫描选项 UI 已从管理界面移除（相关同步逻辑已下线）

  function revertPreviewDisplayCheckboxesToApplied(options) {
    options = options || {};
    var state = options.state || {};
    var onApplyPreviewDisplayCheckboxesFromSlice = options.onApplyPreviewDisplayCheckboxesFromSlice;
    if (typeof onApplyPreviewDisplayCheckboxesFromSlice !== 'function') return;
    var applied = state.previewDisplayApplied;
    if (!applied) return;
    onApplyPreviewDisplayCheckboxesFromSlice(applied);
  }

  async function persistPreviewDisplayFromControls(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var previewDisplayUiBindings = options.previewDisplayUiBindings || [];
    var previewDisplaySettingKeys = options.previewDisplaySettingKeys || [];
    var onPreviewDisplaySliceFromSettings = options.onPreviewDisplaySliceFromSettings;
    var onWritePreviewDisplayLocalStorage = options.onWritePreviewDisplayLocalStorage;
    var onSyncPreviewDisplayOptionsFromSettings = options.onSyncPreviewDisplayOptionsFromSettings;
    var onApplyPreviewDisplayToOpenPreview = options.onApplyPreviewDisplayToOpenPreview;
    var onSaveLastSettingsSectionId = options.onSaveLastSettingsSectionId;
    var onRenderSettingsNav = options.onRenderSettingsNav;
    var onRevertPreviewDisplayCheckboxesToApplied =
      options.onRevertPreviewDisplayCheckboxesToApplied;
    var appAlert = options.appAlert;
    if (!(api && api.has && api.has('updateSettings'))) return;
    if (typeof onPreviewDisplaySliceFromSettings !== 'function') return;
    if (typeof onWritePreviewDisplayLocalStorage !== 'function') return;
    if (
      typeof onSyncPreviewDisplayOptionsFromSettings !== 'function' ||
      typeof onApplyPreviewDisplayToOpenPreview !== 'function'
    )
      return;
    if (
      typeof onSaveLastSettingsSectionId !== 'function' ||
      typeof onRenderSettingsNav !== 'function'
    )
      return;
    if (typeof onRevertPreviewDisplayCheckboxesToApplied !== 'function') return;

    var applied = state.previewDisplayApplied;
    var patch = {};
    for (var i = 0; i < previewDisplayUiBindings.length; i++) {
      var b = previewDisplayUiBindings[i];
      var el = document.getElementById(b.id);
      if (!el) return;
      patch[b.key] = !!el.checked;
    }
    if (applied) {
      var unchanged = true;
      for (var j = 0; j < previewDisplaySettingKeys.length; j++) {
        var pk = previewDisplaySettingKeys[j];
        if (!!patch[pk] !== !!applied[pk]) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return;
    }
    try {
      var r = await api.updateSettings(patch);
      state.previewDisplayApplied = onPreviewDisplaySliceFromSettings(r);
      onWritePreviewDisplayLocalStorage(state.previewDisplayApplied);
      onSyncPreviewDisplayOptionsFromSettings(r);
      onApplyPreviewDisplayToOpenPreview();
      onSaveLastSettingsSectionId('settingsSectionMedia');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionMedia');
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert('保存预览信息显示失败：' + (e && e.message ? e.message : String(e)));
      onRevertPreviewDisplayCheckboxesToApplied();
    }
  }

  async function persistGeneralSettingsFromControls(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api || null;
    var onGetThemeStyleControlValue = options.onGetThemeStyleControlValue;
    var onSyncAppearanceFromSettings = options.onSyncAppearanceFromSettings;
    var onSetGeneralSettingsAppliedFromObject = options.onSetGeneralSettingsAppliedFromObject;
    var onSyncThemeStyleControls = options.onSyncThemeStyleControls;
    var onApplySubtitleStyleFromSettings = options.onApplySubtitleStyleFromSettings;
    var onSyncSubtitleStyleControlsFromSettings = options.onSyncSubtitleStyleControlsFromSettings;
    var onSaveLastSettingsSectionId = options.onSaveLastSettingsSectionId;
    var onRenderSettingsNav = options.onRenderSettingsNav;
    var appAlert = options.appAlert;
    if (!(api && api.has && api.has('updateSettings'))) return;
    if (typeof onGetThemeStyleControlValue !== 'function') return;
    if (typeof onSyncAppearanceFromSettings !== 'function') return;
    if (typeof onSetGeneralSettingsAppliedFromObject !== 'function') return;
    if (typeof onSyncThemeStyleControls !== 'function') return;
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
    var tsV = onGetThemeStyleControlValue();
    var subFamily = String(subFamilyEl.value || '').trim().toLowerCase();
    if (['system', 'serif', 'mono'].indexOf(subFamily) < 0) subFamily = 'system';
    var subSize = parseInt(subSizeEl.value, 10);
    if (isNaN(subSize)) subSize = 22;
    if (subSize < 12) subSize = 12;
    if (subSize > 72) subSize = 72;
    if (subSizeEl.value !== String(subSize)) subSizeEl.value = String(subSize);
    var subWeight = String(subWeightEl.value || '').trim().toLowerCase();
    if (['normal', 'medium', 'bold'].indexOf(subWeight) < 0) subWeight = 'medium';
    var subColor = String(subColorEl.value || '').trim().toLowerCase();
    if (['white', 'yellow', 'cyan', 'green', 'orange', 'pink'].indexOf(subColor) < 0)
      subColor = 'white';
    var launchDefaultPage = String(launchDefaultEl.value || '').trim().toLowerCase();
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
    var ap = state.generalSettingsApplied;
    if (
      ap &&
      !!auto.checked === ap.autoScanOnStartup &&
      !!autoThumb.checked === ap.autoThumbBackfillOnStartup &&
      !!autoHash.checked === ap.autoHashOnStartup &&
      launchDefaultPage === (ap.launchDefaultPage || 'all_photos') &&
      tsV === ap.themeStyle &&
      subFamily === ap.subtitleFontFamily &&
      subSize === ap.subtitleFontSizePx &&
      subWeight === ap.subtitleFontWeight &&
      subColor === ap.subtitleColor &&
      thumbConc === normalizeThumbBackfillConcurrency(ap.thumbBackfillConcurrency)
    ) {
      return;
    }
    try {
      var r = await api.updateSettings({
        autoScanOnStartup: !!auto.checked,
        autoThumbBackfillOnStartup: !!autoThumb.checked,
        autoHashOnStartup: !!autoHash.checked,
        launchDefaultPage: launchDefaultPage,
        themeStyle: tsV,
        subtitleFontFamily: subFamily,
        subtitleFontSizePx: subSize,
        subtitleFontWeight: subWeight,
        subtitleColor: subColor,
        thumbBackfillConcurrency: thumbConc,
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
      onSyncThemeStyleControls(r.themeStyle);
      onSyncSubtitleStyleControlsFromSettings(r);
      onApplySubtitleStyleFromSettings(r);
      if (concEl)
        concEl.value = String(normalizeThumbBackfillConcurrency(r.thumbBackfillConcurrency));
      onSaveLastSettingsSectionId('settingsSectionGeneral');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionGeneral');
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert('保存通用设置失败：' + (e && e.message ? e.message : String(e)));
      if (ap) {
        if (dom.settingAutoScan) dom.settingAutoScan.checked = !!ap.autoScanOnStartup;
        if (dom.settingAutoThumbBackfillOnStartup)
          dom.settingAutoThumbBackfillOnStartup.checked = !!ap.autoThumbBackfillOnStartup;
        if (dom.settingAutoHashOnStartup)
          dom.settingAutoHashOnStartup.checked = !!ap.autoHashOnStartup;
        if (launchDefaultEl) launchDefaultEl.value = ap.launchDefaultPage || 'all_photos';
        if (concEl)
          concEl.value = String(normalizeThumbBackfillConcurrency(ap.thumbBackfillConcurrency));
        onSyncThemeStyleControls(ap.themeStyle);
        onSyncSubtitleStyleControlsFromSettings(ap);
        onApplySubtitleStyleFromSettings(ap);
        onSyncAppearanceFromSettings({
          theme: ap.theme,
          uiAccent: ap.uiAccent,
          uiBackground: ap.uiBackground,
          autoScanOnStartup: ap.autoScanOnStartup,
          autoThumbBackfillOnStartup: ap.autoThumbBackfillOnStartup,
          autoHashOnStartup: ap.autoHashOnStartup,
        });
      }
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
      onSaveLastSettingsSectionId('settingsSectionCloseBehavior');
      if (state.currentTab === 'settings') onRenderSettingsNav('settingsSectionCloseBehavior');
    } catch (e) {
      if (typeof appAlert === 'function')
        appAlert('保存关闭按钮设置失败：' + (e && e.message ? e.message : String(e)));
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
        pwdInput.placeholder = state.hasWebPassword ? '已设置' : '设置访问密码';
      }
    }
    var st = document.getElementById('webPasswordStateText');
    if (st) st.textContent = state.hasWebPassword ? '状态：已设置' : '状态：未设置';
    var badge = document.getElementById('webPasswordStatusBadge');
    if (badge) {
      badge.textContent = state.hasWebPassword ? '已设置' : '未设置';
      badge.classList.remove('online', 'offline');
      badge.classList.add(state.hasWebPassword ? 'online' : 'offline');
    }
  }

  global.RendererSettingsSync = Object.assign({}, global.RendererSettingsSync || {}, {
    applyBrowsePreferencesFromSettings: applyBrowsePreferencesFromSettings,
    syncBrowsePrefsFormFromRuntimeState: syncBrowsePrefsFormFromRuntimeState,
    persistBrowsePrefsFromForm: persistBrowsePrefsFromForm,
    revertPreviewDisplayCheckboxesToApplied: revertPreviewDisplayCheckboxesToApplied,
    persistPreviewDisplayFromControls: persistPreviewDisplayFromControls,
    persistGeneralSettingsFromControls: persistGeneralSettingsFromControls,
    persistWindowCloseSetting: persistWindowCloseSetting,
    syncThemeStyleControls: syncThemeStyleControls,
    syncWebPasswordUiFromSettings: syncWebPasswordUiFromSettings,
  });
})(window);
