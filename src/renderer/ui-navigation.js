(function (global) {
  'use strict';

  // ===== ui-sidebar.js =====
  function closeMobileSidebar() {
    var sidebar = document.getElementById('sidebar');
    var mobileBackdrop = document.getElementById('mobileBackdrop');
    if (sidebar) sidebar.classList.remove('mobile-show');
    if (mobileBackdrop) mobileBackdrop.classList.remove('show');
  }

  function getSidebarRenderTarget(dom) {
    return dom && dom.sidebarContent ? dom.sidebarContent : null;
  }

  function ensureDuplicateSidebarVisible(dom) {
    if (!dom) return;
    if (dom.sidebarContent) dom.sidebarContent.style.display = '';
    if (dom.sidebarContentDuplicate) dom.sidebarContentDuplicate.style.display = 'none';
  }

  function ensureNormalSidebarVisible(dom) {
    if (!dom) return;
    if (dom.sidebarContent) dom.sidebarContent.style.display = '';
    if (dom.sidebarContentDuplicate) dom.sidebarContentDuplicate.style.display = 'none';
  }

  function showSidebarOnDesktop(sidebarEl, isMobile) {
    if (!sidebarEl) return;
    if (!isMobile) sidebarEl.style.display = '';
  }

  function hideSidebar(sidebarEl) {
    if (!sidebarEl) return;
    sidebarEl.style.display = 'none';
  }

  global.RendererSidebarUI = Object.assign({}, global.RendererSidebarUI || {}, {
    closeMobileSidebar: closeMobileSidebar,
    getSidebarRenderTarget: getSidebarRenderTarget,
    ensureDuplicateSidebarVisible: ensureDuplicateSidebarVisible,
    ensureNormalSidebarVisible: ensureNormalSidebarVisible,
    showSidebarOnDesktop: showSidebarOnDesktop,
    hideSidebar: hideSidebar,
  });

  // ===== ui-tabs.js =====
  /**
   * 底栏右侧那三个控件（网格与比例 `#browseGridStyleControl`、每页数量 `#pageSizeControl`、
   * 卡片尺寸 `#zoomControl`）同生同死：浏览页显示，集合页（重复 / 智能视图）收起。
   *
   * ⚠️ 这里的 id 是**外层 field**（标签 + 下拉那一整块），不是里面的 `<select>`：
   * 控件的可见性必须连标签一起收，否则集合页会留下三个孤零零的「网格 / 每页 / 尺寸」。
   *
   * 收进一个函数是因为它们此前靠四五个地方各自 `getElementById(...).style.display`
   * 维持可见性；新加一个控件时只要漏掉其中一处，就会出现「进了智能视图还留着半截底栏控件」。
   */
  function setBrowseGridControlsVisible(visible) {
    var ids = ['browseGridStyleControl', 'pageSizeControl', 'zoomControl'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.style.display = visible ? '' : 'none';
    }
  }

  function prepareBrowsingShell(options) {
    options = options || {};
    var dom = options.dom || {};
    var currentView = options.currentView;

    // ⚠️ 这里刻意**不**处理「隐藏首页」。首页的显隐挂在一个派生 class
    // （`html.home-page-open`，唯一写者是 app.js 的 syncPageOpenClasses）上，而所有
    // 走到本函数的路径都先经过 syncNavigationRail ⇒ 进到这里时首页早就收掉了。
    // 也**不再**判「欢迎页是否可见」：那套（静态 #emptyState + suppressAutoLoadOnce）
    // 已随首页独立成页整条退役，browsingChrome 现在只由 currentView 决定。
    if (dom.settingsPage) dom.settingsPage.style.display = 'none';
    if (dom.contentArea) dom.contentArea.style.display = '';
    if (dom.photoGrid) dom.photoGrid.style.display = '';

    var browsingChrome = !!currentView;
    if (dom.toolbar) dom.toolbar.style.display = browsingChrome ? 'flex' : 'none';
    if (dom.pagination) dom.pagination.style.display = 'none';

    setBrowseGridControlsVisible(true);

    var settingsBtn = document.getElementById('topbarSettingsBtn');
    if (settingsBtn) settingsBtn.classList.remove('active');
  }

  // 集合页外壳收敛：关掉移动端侧栏、刷新路径标签、隐藏网格工具栏与缩放控件，
  // 只保留页内容本身。
  function applyCollectionView(options) {
    options = options || {};
    var dom = options.dom || {};
    if (typeof options.onCloseMobileSidebar === 'function') options.onCloseMobileSidebar();
    if (typeof options.onUpdateBrowsePathLabel === 'function') options.onUpdateBrowsePathLabel();
    if (typeof options.onEnsureDuplicateSidebarVisible === 'function')
      options.onEnsureDuplicateSidebarVisible();

    if (dom.toolbar) dom.toolbar.style.display = 'none';
    if (dom.pagination) dom.pagination.style.display = 'none';
    setBrowseGridControlsVisible(false);
  }

  function applyDuplicatesView(options) {
    applyCollectionView(options);
  }

  global.RendererTabsUI = Object.assign({}, global.RendererTabsUI || {}, {
    prepareBrowsingShell: prepareBrowsingShell,
    applyCollectionView: applyCollectionView,
    applyDuplicatesView: applyDuplicatesView,
    setBrowseGridControlsVisible: setBrowseGridControlsVisible,
  });

  // ===== ui-tabs-flow.js =====
  function deferBrowseWork(fn) {
    requestAnimationFrame(function () {
      requestAnimationFrame(fn);
    });
  }

  function handleTabBranch(options) {
    options = options || {};
    var tab = options.tab;
    var state = options.state || {};
    var sidebar = options.sidebar;
    var sidebarUi = options.sidebarUi || {};

    var onLoadRootFolders = options.onLoadRootFolders;
    var onLoadDateGroups = options.onLoadDateGroups;
    var onApplyDuplicatesView = options.onApplyDuplicatesView;
    var onRenderDuplicatePageShell = options.onRenderDuplicatePageShell;
    var onRenderDuplicateSidebar = options.onRenderDuplicateSidebar;
    var onLoadDuplicateGroups = options.onLoadDuplicateGroups;
    var skipDeferFolderSidebar = !!options.skipDeferFolderSidebar;

    if (tab === 'folders') {
      state.sidebarLockedMode = '';
      if (typeof onLoadRootFolders === 'function') {
        var silentRf = state.rootFolders && state.rootFolders.length > 0;
        var skipSidebarTree = false; // 相册页需拉子目录树；显式传入避免漏传第二参时误用 skipTree 快路径
        var shouldForceFresh = !!state._forceFreshFolderSidebarOnce;
        state._forceFreshFolderSidebarOnce = false;
        var loadOpts = shouldForceFresh ? { forceFetch: true, immediateHydrate: true } : {};
        if (skipDeferFolderSidebar) {
          void onLoadRootFolders(silentRf, skipSidebarTree, loadOpts);
        } else {
          deferBrowseWork(function () {
            void onLoadRootFolders(silentRf, skipSidebarTree, loadOpts);
          });
        }
      }
      if (sidebarUi.showSidebarOnDesktop) sidebarUi.showSidebarOnDesktop(sidebar, state.isMobile);
      else if (!state.isMobile && sidebar) sidebar.style.display = '';
      return;
    }

    if (tab === 'dates') {
      state.sidebarLockedMode = '';
      if (typeof onLoadDateGroups === 'function') {
        deferBrowseWork(function () {
          void onLoadDateGroups();
        });
      }
      if (sidebarUi.showSidebarOnDesktop) sidebarUi.showSidebarOnDesktop(sidebar, state.isMobile);
      else if (!state.isMobile && sidebar) sidebar.style.display = '';
      return;
    }

    if (tab === 'duplicates') {
      state.sidebarLockedMode = 'duplicates';
      if (sidebarUi.showSidebarOnDesktop) sidebarUi.showSidebarOnDesktop(sidebar, state.isMobile);
      else if (!state.isMobile && sidebar) sidebar.style.display = '';
      state.currentView = 'duplicates';

      if (typeof onApplyDuplicatesView === 'function') onApplyDuplicatesView();
      if (typeof onRenderDuplicatePageShell === 'function') onRenderDuplicatePageShell();
      if (typeof onRenderDuplicateSidebar === 'function') onRenderDuplicateSidebar();
      if (typeof onLoadDuplicateGroups === 'function') {
        onLoadDuplicateGroups(state.duplicateGroupsPage || 1, { forceReload: true });
      }
    }
  }

  global.RendererTabsFlowUI = Object.assign({}, global.RendererTabsFlowUI || {}, {
    handleTabBranch: handleTabBranch,
  });
})(window);
