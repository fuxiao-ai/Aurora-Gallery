(function (global) {
  function bindTitlebarMenu() {
    var menuItems = document.querySelectorAll('.titlebar-menu-item');
    var openMenu = null;

    menuItems.forEach(function (item) {
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        var dropdown = item.querySelector('.dropdown-menu');
        if (openMenu === dropdown) {
          closeAllMenus();
        } else {
          closeAllMenus();
          dropdown.classList.add('show');
          item.classList.add('open');
          openMenu = dropdown;
        }
      });
    });

    document.addEventListener('click', function () {
      closeAllMenus();
    });

    function closeAllMenus() {
      document.querySelectorAll('.dropdown-menu').forEach(function (d) {
        d.classList.remove('show');
      });
      document.querySelectorAll('.titlebar-menu-item').forEach(function (d) {
        d.classList.remove('open');
      });
      openMenu = null;
    }
  }

  function bindWindowControls(api) {
    var btnMin = document.getElementById('btnMinimize');
    var btnMax = document.getElementById('btnMaximize');
    var btnClose = document.getElementById('btnClose');

    if (btnMin) {
      btnMin.addEventListener('click', function () {
        if (api) api.minimizeWindow();
      });
    }
    if (btnMax) {
      btnMax.addEventListener('click', function () {
        if (api) api.maximizeWindow();
      });
    }
    if (btnClose) {
      btnClose.addEventListener('click', function () {
        if (api) api.closeWindow();
      });
    }

    if (api) {
      if (typeof api.isMaximized === 'function') {
        Promise.resolve(api.isMaximized())
          .then(function (isMaximized) {
            if (!btnMax) return;
            btnMax.textContent = isMaximized ? '❐' : '☐';
            btnMax.title = isMaximized ? '还原' : '最大化';
          })
          .catch(function () {});
      }
      api.onWindowMaximizedChange(function (isMaximized) {
        var maxBtn = document.getElementById('btnMaximize');
        if (!maxBtn) return;
        maxBtn.textContent = isMaximized ? '❐' : '☐';
        maxBtn.title = isMaximized ? '还原' : '最大化';
      });
    }
  }

  function bindMobileSidebar(options) {
    options = options || {};
    var onResize = options.onResize;
    var closeAfterDesktopWidth = options.closeAfterDesktopWidth !== false;

    var mobileMenuBtn = document.getElementById('mobileMenuBtn');
    var mobileBackdrop = document.getElementById('mobileBackdrop');
    var sidebar = document.getElementById('sidebar');
    if (!sidebar || !mobileBackdrop) return;

    function toggleMobileSidebar() {
      sidebar.classList.toggle('mobile-show');
      mobileBackdrop.classList.toggle('show');
    }

    function closeMobileSidebar() {
      sidebar.classList.remove('mobile-show');
      mobileBackdrop.classList.remove('show');
    }

    if (mobileMenuBtn) {
      mobileMenuBtn.addEventListener('click', toggleMobileSidebar);
    }
    mobileBackdrop.addEventListener('click', closeMobileSidebar);

    window.addEventListener('resize', function () {
      if (typeof onResize === 'function') onResize(window.innerWidth);
      if (closeAfterDesktopWidth && window.innerWidth > 600) closeMobileSidebar();
    });
  }

  function bindSettingsDelegates(options) {
    options = options || {};
    var previewBindings = Array.isArray(options.previewBindings) ? options.previewBindings : [];
    var onPersistPreviewDisplay = options.onPersistPreviewDisplay;
    var onPersistInfoPanelFields = options.onPersistInfoPanelFields;
    var onPersistWindowClose = options.onPersistWindowClose;
    var onPersistGeneralSettings = options.onPersistGeneralSettings;
    var onThemePresetExpand = options.onThemePresetExpand;
    var onPersistUiLocale = options.onPersistUiLocale;
    var onToggleTunnelEnabled = options.onToggleTunnelEnabled;
    var onToggleWebServerEnabled = options.onToggleWebServerEnabled;
    var onPersistBrowsePrefs = options.onPersistBrowsePrefs;

    var settingsPage = document.getElementById('settingsPage');
    if (!settingsPage) return;

    settingsPage.addEventListener('change', function (e) {
      var el = e.target;
      var sid = el && el.id;
      if (el && el.tagName === 'INPUT' && el.type === 'checkbox') {
        var hasBinding = false;
        for (var i = 0; i < previewBindings.length; i++) {
          if (previewBindings[i] && previewBindings[i].id === el.id) {
            hasBinding = true;
            break;
          }
        }
        if (hasBinding && typeof onPersistPreviewDisplay === 'function') {
          void onPersistPreviewDisplay();
        }
      }
      // 「图片信息」面板的字段勾选框：既没有 id 也不是上面那张绑定表里的成员，
      // 靠 data-info-field 认领（字段清单由注册表生成，不可能逐个写死 id）。
      if (
        el &&
        el.tagName === 'INPUT' &&
        el.type === 'checkbox' &&
        el.getAttribute('data-info-field') &&
        typeof onPersistInfoPanelFields === 'function'
      ) {
        void onPersistInfoPanelFields();
      }
      if (sid === 'settingWindowClose' && typeof onPersistWindowClose === 'function') {
        void onPersistWindowClose();
      }
      if (sid === 'settingUiLocale' && typeof onPersistUiLocale === 'function') {
        void onPersistUiLocale();
      }
      if (
        (sid === 'settingAutoScan' ||
          sid === 'settingAutoThumbBackfillOnStartup' ||
          sid === 'settingAutoHashOnStartup' ||
          sid === 'settingAutoSemanticIndexOnStartup' ||
          sid === 'settingAutoFaceIndexOnStartup' ||
          sid === 'settingSimilarThreshold' ||
          sid === 'settingLaunchDefaultPage' ||
          sid === 'settingThemeStyle' ||
          sid === 'settingUiAccent' ||
          sid === 'settingUiBackground' ||
          sid === 'settingUiTexture' ||
          sid === 'settingUiOpacity' ||
          sid === 'settingUiWindowBackdrop' ||
          sid === 'settingSubtitleFontFamily' ||
          sid === 'settingSubtitleFontSize' ||
          sid === 'settingSubtitleFontWeight' ||
          sid === 'settingSubtitleColor' ||
          sid === 'settingThumbBackfillConcurrency') &&
        typeof onPersistGeneralSettings === 'function'
      ) {
        // 🔴 选「界面风格」预设时，必须**先把预设展开进强调色 / 背景两个控件**再保存。
        // 否则 getAppearanceControlValue() 会拿两维的「上一套残留值」与预设比对，判不相等后
        // 退回「以控件为准」→ 三元组与保存前逐位相同 → 变更检测当场吞掉整次操作
        // （症状：切换界面风格毫无反应，且两个下拉各自停在不同的值上）。
        if (sid === 'settingThemeStyle' && typeof onThemePresetExpand === 'function') {
          onThemePresetExpand(el && el.value);
          // 「自定义组合」（空串）没有可展开的预设 —— 把光标直接送到强调色控件。
          // 否则这一项就是「选了毫无反应」，用户会以为它坏了。
          if (el && !el.value) {
            var ac = document.getElementById('settingUiAccent');
            if (ac && typeof ac.focus === 'function') ac.focus();
          }
        }
        void onPersistGeneralSettings();
      }
      if (sid === 'settingTunnelEnabled' && typeof onToggleTunnelEnabled === 'function') {
        var on = !!(el && el.checked);
        void onToggleTunnelEnabled(on);
      }
      if (sid === 'settingWebServerEnabled' && typeof onToggleWebServerEnabled === 'function') {
        var on2 = !!(el && el.checked);
        void onToggleWebServerEnabled(on2);
      }
      if (
        (sid === 'settingBrowseSort' ||
          sid === 'settingBrowsePageSize' ||
          sid === 'settingBrowseCardSize' ||
          sid === 'settingBrowseGridStyle' ||
          sid === 'settingBrowseThumbCrop' ||
          sid === 'settingBrowseFolderIncludeSubfolders' ||
          sid === 'settingVideoClickBehavior') &&
        typeof onPersistBrowsePrefs === 'function'
      ) {
        void onPersistBrowsePrefs();
      }
    });

    // input 事件留空会触发 no-unused-vars；如后续需要可在此补充处理逻辑
  }

  /** 原 index.html 内联 onclick，集中到此以降低对 window.* 的依赖 */
  function bindShellInlineActions(options) {
    options = options || {};

    function bindClick(id, handler) {
      var el = document.getElementById(id);
      if (!el || typeof handler !== 'function') return;
      el.addEventListener('click', function (e) {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        handler(e);
      });
    }

    /** 下拉版：选中即提交（底栏右侧那三个控件都是这个形态）。 */
    function bindSelectChange(id, handler) {
      var el = document.getElementById(id);
      if (!el || typeof handler !== 'function') return;
      el.addEventListener('change', function () {
        handler(el.value);
      });
    }

    document.querySelectorAll('.dropdown-item[data-menu-action]').forEach(function (el) {
      el.addEventListener('click', function () {
        var action = el.getAttribute('data-menu-action');
        if (action && typeof options.onMenuAction === 'function') {
          void options.onMenuAction(action);
        }
      });
    });

    bindClick('topbarSettingsBtn', options.onOpenSettingsPage);
    // 「首页」按钮与设置按钮同族（都是「页面」跳转，不是视图切换）：
    // 所以它不带 .nav-tab —— 那样会被 bindNavTabs 当成视图走 onShowTabContent。
    bindClick('topbarHomeBtn', options.onOpenHomePage);
    bindClick('taskPanelToggleBtn', options.onToggleTaskPanelCollapse);
    bindClick('taskScanPause', options.onPauseResumeScan);
    bindClick('taskScanCancel', options.onCancelScan);
    bindClick('taskThumbStop', options.onCancelThumbnailBackfill);
    // 顶栏的「停止重建」——与设置页那个按钮同一个处理器（停止 = 置取消标志，
    // 任务在批次边界自行收尾，见 `cancel-thumbnail-rebuild` 的注释）。
    bindClick('taskThumbRebuildStop', options.onCancelThumbnailRebuild);
    bindClick('taskDupHashStop', options.onCancelDuplicateHashDetection);
    // 底栏右侧那三个控件都是下拉，走 change：选中即提交（与设置页那三份同语义）。
    bindSelectChange('browseGridStyleSelect', options.onBrowseGridStyleChange);
    bindSelectChange('browsePageSizeSelect', options.onBrowsePageSizeChange);
    bindSelectChange('browseCardSizeSelect', options.onBrowseCardSizeChange);
    bindClick('thumbSettingsApplyBtn', options.onApplyThumbSettings);
    bindClick('thumbBackfillStartBtn', options.onStartThumbnailBackfill);
    bindClick('thumbBackfillCancelBtn', options.onCancelThumbnailBackfill);
    bindClick('thumbBackfillExportFailedBtn', options.onExportThumbnailBackfillFailedPaths);
    bindClick('thumbRebuildStartBtn', options.onStartThumbnailRebuild);
    bindClick('thumbRebuildCancelBtn', options.onCancelThumbnailRebuild);
    bindClick('duplicateHashStartBtn', options.onStartDuplicateHashDetection);
    bindClick('duplicateHashCancelBtn', options.onCancelDuplicateHashDetection);
    bindClick('gotoSimilarBtn', options.onGotoSimilar);
    bindClick('maintenanceCleanupBtn', options.onRunMaintenanceCleanup);
    bindClick('maintenanceRebuildThumbFlagsBtn', options.onRunMaintenanceRebuildThumbFlags);
    bindClick('maintenanceOptimizeBtn', options.onRunMaintenanceOptimize);
    bindClick('maintenanceOpenDbFolderBtn', options.onOpenDatabaseFolder);
    bindClick('dataDirMigrateBtn', options.onMigrateDataDir);
    bindClick('dataDirOpenBtn', options.onOpenDatabaseFolder);
    bindClick('maintenanceBackupDbBtn', options.onRunMaintenanceBackup);
    bindClick('saveWebPasswordBtn', options.onSaveWebPassword);
    bindClick('slideshowToggleBtn', options.onToggleSlideshow);
    bindClick('slideshowRandomBtn', options.onToggleSlideshowRandom);
    bindClick('previewFullscreenBtn', options.onTogglePreviewFullscreen);
    bindClick('previewMinimizeBtn', options.onMinimizePreview);
    bindClick('previewMaximizeBtn', options.onPreviewWindowMaximize);
    bindClick('previewRotateBtn', options.onCyclePreviewRotate);
    bindClick('previewFlipBtn', options.onPreviewEditFlip);
    bindClick('previewCropBtn', options.onPreviewEditCrop);
    bindClick('previewEditSaveBtn', options.onPreviewEditSave);
    bindClick('previewEditDiscardBtn', options.onPreviewEditDiscard);
    bindClick('previewFavoriteBtn', options.onPreviewToggleFavorite);
    bindClick('previewLiveBtn', options.onPreviewToggleLive);
    bindClick('previewFindSimilarBtn', options.onPreviewFindSimilar);
    bindClick('previewShowInFolderBtn', options.onPreviewShowInFolder);
    bindClick('previewOpenExternalBtn', options.onPreviewOpenExternal);
    bindClick('previewMoveToTrashBtn', options.onPreviewMoveToTrash);
    bindClick('previewInfoToggle', options.onTogglePreviewInfoPanel);
    bindClick('previewInfoPanelClose', options.onTogglePreviewInfoPanel);
    bindClick('closeChoiceTrayBtn', function () {
      if (typeof options.onSubmitCloseChoice === 'function') options.onSubmitCloseChoice('tray');
    });
    bindClick('closeChoiceQuitBtn', function () {
      if (typeof options.onSubmitCloseChoice === 'function') options.onSubmitCloseChoice('quit');
    });
    bindClick('closeChoiceCancelBtn', function () {
      if (typeof options.onSubmitCloseChoice === 'function') options.onSubmitCloseChoice('cancel');
    });
    // 图片信息面板字段：三个批量动作都直接改勾选框再走同一条持久化路径
    bindClick('settingsInfoFieldsSelectAllBtn', function () {
      if (typeof options.onSetAllInfoPanelFieldsChecked === 'function')
        options.onSetAllInfoPanelFieldsChecked(true);
    });
    bindClick('settingsInfoFieldsClearAllBtn', function () {
      if (typeof options.onSetAllInfoPanelFieldsChecked === 'function')
        options.onSetAllInfoPanelFieldsChecked(false);
    });
    bindClick('settingsInfoFieldsResetBtn', options.onResetInfoPanelFieldsToDefault);
    bindClick('tunnelLogCopyBtn', options.onCopyTunnelLog);

    var settingsBack = document.querySelector('.settings-back');
    if (settingsBack && typeof options.onCloseSettingsPage === 'function') {
      settingsBack.addEventListener('click', function () {
        void options.onCloseSettingsPage();
      });
      settingsBack.addEventListener('keydown', function (e) {
        var k = e && (e.key || e.code);
        if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          e.preventDefault();
          void options.onCloseSettingsPage();
        }
      });
    }

    var settingsPageEsc = document.getElementById('settingsPage');
    if (settingsPageEsc && typeof options.onCloseSettingsPage === 'function') {
      document.addEventListener(
        'keydown',
        function (e) {
          if (!e || e.key !== 'Escape') return;
          if (!settingsPageEsc || settingsPageEsc.style.display === 'none') return;
          var t = e.target;
          var tag = t && t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          e.preventDefault();
          void options.onCloseSettingsPage();
        },
        true,
      );
    }

    /** 顶栏 / 标题栏品牌区（i18n：拂晓图库 / Aurora Gallery）：管理设置打开时点击返回相册 */
    if (typeof options.onCloseSettingsPage === 'function') {
      function isSettingsPageOpenForBrand() {
        var sp = document.getElementById('settingsPage');
        return (
          document.documentElement.classList.contains('settings-page-open') &&
          sp &&
          sp.style.display !== 'none'
        );
      }
      function closeSettingsIfOpenFromBrand(e) {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        if (!isSettingsPageOpenForBrand()) return;
        void options.onCloseSettingsPage();
      }
      var headerTitle = document.querySelector('.topbar .header-title');
      if (headerTitle) {
        headerTitle.setAttribute('role', 'button');
        headerTitle.setAttribute('tabindex', '0');
        headerTitle.setAttribute('title', '返回相册');
        headerTitle.addEventListener('click', closeSettingsIfOpenFromBrand);
        headerTitle.addEventListener('keydown', function (e) {
          if (!isSettingsPageOpenForBrand()) return;
          var k = e && (e.key || e.code);
          if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
            e.preventDefault();
            void options.onCloseSettingsPage();
          }
        });
      }
      var titlebarLogo = document.querySelector('.titlebar-logo');
      if (titlebarLogo) {
        titlebarLogo.setAttribute('role', 'button');
        titlebarLogo.setAttribute('tabindex', '0');
        titlebarLogo.setAttribute('title', '返回相册');
        titlebarLogo.style.setProperty('-webkit-app-region', 'no-drag');
        titlebarLogo.addEventListener('click', closeSettingsIfOpenFromBrand);
        titlebarLogo.addEventListener('keydown', function (e) {
          if (!isSettingsPageOpenForBrand()) return;
          var k = e && (e.key || e.code);
          if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
            e.preventDefault();
            void options.onCloseSettingsPage();
          }
        });
      }
    }

    var webUrlBox = document.getElementById('webUrlBox');
    if (webUrlBox && typeof options.onCopyWebUrl === 'function') {
      webUrlBox.addEventListener('click', function () {
        void options.onCopyWebUrl();
      });
    }
    var tunnelUrlBox = document.getElementById('tunnelUrlBox');
    if (tunnelUrlBox && typeof options.onCopyTunnelUrl === 'function') {
      tunnelUrlBox.addEventListener('click', function () {
        void options.onCopyTunnelUrl();
      });
    }

    var closeChoiceDialog = document.querySelector('.close-choice-dialog');
    if (closeChoiceDialog) {
      closeChoiceDialog.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
    var appDialogCard = document.querySelector('.app-dialog-card');
    if (appDialogCard) {
      appDialogCard.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
  }

  function bindMiscControls(options) {
    options = options || {};
    var onCancelCloseChoice = options.onCancelCloseChoice;
    var onThumbSettingChange = options.onThumbSettingChange;
    var onQuickThemeChange = options.onQuickThemeChange;
    var onThemePresetExpand = options.onThemePresetExpand;
    var onTopbarLocaleChange = options.onTopbarLocaleChange;
    var onWebPasswordFocus = options.onWebPasswordFocus;

    var closeChoiceOverlay = document.getElementById('closeChoiceOverlay');
    if (closeChoiceOverlay) {
      closeChoiceOverlay.addEventListener('click', function (e) {
        if (e.target === closeChoiceOverlay && typeof onCancelCloseChoice === 'function') {
          onCancelCloseChoice();
        }
      });
    }

    var settingThumbSize = document.getElementById('settingThumbSize');
    if (settingThumbSize && typeof onThumbSettingChange === 'function') {
      settingThumbSize.addEventListener('change', onThumbSettingChange);
    }
    var settingThumbQuality = document.getElementById('settingThumbQuality');
    if (settingThumbQuality && typeof onThumbSettingChange === 'function') {
      settingThumbQuality.addEventListener('change', onThumbSettingChange);
    }

    var quickThemeStyle = document.getElementById('quickThemeStyle');
    if (quickThemeStyle && typeof onQuickThemeChange === 'function') {
      quickThemeStyle.addEventListener('change', function () {
        // 同 bindSettingsDelegates：先把预设展开进两维控件，预设才真的会被采纳
        if (typeof onThemePresetExpand === 'function') {
          onThemePresetExpand(quickThemeStyle.value);
        }
        void onQuickThemeChange();
      });
    }

    var topbarUiLocale = document.getElementById('topbarUiLocale');
    if (topbarUiLocale && typeof onTopbarLocaleChange === 'function') {
      topbarUiLocale.addEventListener('change', function () {
        void onTopbarLocaleChange();
      });
    }

    var webPwdInput = document.getElementById('settingWebPassword');
    if (webPwdInput) {
      webPwdInput.addEventListener('focus', function () {
        if (typeof onWebPasswordFocus === 'function') onWebPasswordFocus(webPwdInput);
      });
    }
  }

  function bindNavTabs(options) {
    options = options || {};
    var getState = options.getState;
    var onViewDuplicates = options.onViewDuplicates;
    var onShowTabContent = options.onShowTabContent;
    var onForceSwitchToDuplicates = options.onForceSwitchToDuplicates;
    var onEnsureDuplicateSidebarVisible = options.onEnsureDuplicateSidebarVisible;
    var onRenderDuplicateSidebar = options.onRenderDuplicateSidebar;
    var onSaveBrowseTabMemory = options.onSaveBrowseTabMemory;

    document.querySelectorAll('.nav-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
        if (state.currentTab === 'settings' && typeof options.onCloseSettingsPage === 'function') {
          options.onCloseSettingsPage();
        }
        var nextTab = tab.dataset.tab;
        if (nextTab === 'duplicates') {
          if (typeof onViewDuplicates === 'function') onViewDuplicates();
          requestAnimationFrame(function () {
            var s2 = typeof getState === 'function' ? getState() : null;
            if (!s2 || s2.currentTab !== 'duplicates') return;
            if (typeof onEnsureDuplicateSidebarVisible === 'function')
              onEnsureDuplicateSidebarVisible();
            if (typeof onRenderDuplicateSidebar === 'function') onRenderDuplicateSidebar();
          });
          return;
        }

        var prevTab = state.currentTab;
        // 离开这三个浏览页之前先存浏览记忆。判据必须与 `rememberBrowsePosition`
        // 同步（那边也认这三个）—— 少一个 tab，症状是「从首页/设置页回来位置丢了」，
        // 而看起来完全像浏览记忆本身坏了。
        if (prevTab === 'folders' || prevTab === 'dates' || prevTab === 'tags') {
          if (typeof onSaveBrowseTabMemory === 'function') onSaveBrowseTabMemory(prevTab);
        }

        state.currentTab = nextTab;
        document.querySelectorAll('.nav-tab').forEach(function (t) {
          t.classList.remove('active');
        });
        tab.classList.add('active');
        if (typeof onShowTabContent === 'function')
          onShowTabContent(state.currentTab, { fromTab: prevTab });
      });
    });

    document.addEventListener(
      'click',
      function (e) {
        if (typeof onForceSwitchToDuplicates === 'function') onForceSwitchToDuplicates(e);
      },
      true,
    );
  }

  function bindSearchSortFilters(options) {
    options = options || {};
    var dom = options.dom || {};
    var getState = options.getState;
    var onLoadPhotos = options.onLoadPhotos;
    var onLoadRootFolders = options.onLoadRootFolders;
    // 文件夹树侧栏由「文件 / 搜图 / 人物」共用：筛媒体类型后目录要跟着重建。
    var isFolderSidebarTab = options.isFolderSidebarTab;

    if (dom.sortSelect) {
      dom.sortSelect.addEventListener('change', function () {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
        var parts = String(dom.sortSelect.value || '').split('|');
        state.sortBy = parts[0];
        state.sortOrder = parts[1];
        state.page = 1;
        if (typeof onLoadPhotos === 'function') onLoadPhotos();
      });
    }

    if (dom.mediaFilterSelect) {
      dom.mediaFilterSelect.addEventListener('change', function () {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
        state.mediaFilter = String(dom.mediaFilterSelect.value || 'all');
        state.page = 1;
        var onFolderTab =
          typeof isFolderSidebarTab === 'function'
            ? isFolderSidebarTab(state.currentTab)
            : state.currentTab === 'folders';
        if (onFolderTab && typeof onLoadRootFolders === 'function') {
          void onLoadRootFolders(true);
        }
        if (typeof onLoadPhotos === 'function') onLoadPhotos();
      });
    }

    // 已移除：最小宽/高/MB 筛选与“清空筛选”
  }

  function bindPaginationAndFolderCoverClick(options) {
    options = options || {};
    var dom = options.dom || {};
    var getState = options.getState;
    var onLoadPhotos = options.onLoadPhotos;
    var onViewFolder = options.onViewFolder;
    var onNormalizePath = options.onNormalizePath;
    var onCloseMobileSidebar = options.onCloseMobileSidebar;

    if (dom.prevPage) {
      dom.prevPage.addEventListener('click', function () {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
        if (state.page > 1) {
          state.page--;
          if (typeof onLoadPhotos === 'function') onLoadPhotos();
        }
      });
    }
    if (dom.nextPage) {
      dom.nextPage.addEventListener('click', function () {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
        state.page++;
        if (typeof onLoadPhotos === 'function') onLoadPhotos();
      });
    }
    var onGoToRandomPage = options.onGoToRandomPage;
    if (dom.randomPageBtn && typeof onGoToRandomPage === 'function') {
      dom.randomPageBtn.addEventListener('click', function () {
        onGoToRandomPage();
      });
    }

    if (dom.photoGrid) {
      dom.photoGrid.addEventListener('click', function (e) {
        var fc = e.target && e.target.closest ? e.target.closest('.folder-cover-card') : null;
        if (!fc) return;
        var p = fc.getAttribute('data-folder-path');
        if (!p) return;
        var state = typeof getState === 'function' ? getState() : null;
        var normalized = typeof onNormalizePath === 'function' ? onNormalizePath(p) : p;
        if (typeof onViewFolder === 'function') onViewFolder(normalized);
        if (state && state.isMobile && typeof onCloseMobileSidebar === 'function') {
          setTimeout(onCloseMobileSidebar, 100);
        }
      });
    }
  }

  function bindPhotoGridDelegates(options) {
    options = options || {};
    var dom = options.dom || {};
    var onStartPreview = options.onStartPreview;
    var onToggleFavoriteOnCard = options.onToggleFavoriteOnCard;
    var onGoToPage = options.onGoToPage;

    if (dom.photoGrid) {
      dom.photoGrid.addEventListener('click', function (e) {
        var favBtn =
          e.target && e.target.closest
            ? e.target.closest('.photo-card-fav[data-fav-photo-id]')
            : null;
        if (favBtn) {
          e.preventDefault();
          e.stopPropagation();
          var pid = parseInt(favBtn.getAttribute('data-fav-photo-id') || '', 10);
          if (!isNaN(pid) && typeof onToggleFavoriteOnCard === 'function') {
            onToggleFavoriteOnCard(e, pid);
          }
          return;
        }

        var card =
          e.target && e.target.closest ? e.target.closest('.photo-card[data-preview-index]') : null;
        if (card) {
          e.preventDefault();
          var idx = parseInt(card.getAttribute('data-preview-index') || '', 10);
          if (!isNaN(idx) && typeof onStartPreview === 'function') {
            onStartPreview(idx);
          }
        }
      });
    }

    var pageNumbersEl = document.getElementById('pageNumbers');
    if (pageNumbersEl) {
      pageNumbersEl.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('button[data-go-to-page]') : null;
        if (!btn) return;
        e.preventDefault();
        var p = parseInt(btn.getAttribute('data-go-to-page') || '', 10);
        if (!isNaN(p) && typeof onGoToPage === 'function') onGoToPage(p);
      });
    }
  }

  function bindDuplicatesDelegates(options) {
    options = options || {};
    var onStartDuplicateHashDetection = options.onStartDuplicateHashDetection;
    var onLoadDuplicateGroups = options.onLoadDuplicateGroups;
    var onOpenDuplicatePreview = options.onOpenDuplicatePreview;
    var onShowPhotoInFolderById = options.onShowPhotoInFolderById;
    var onDeleteDuplicatePhoto = options.onDeleteDuplicatePhoto;
    var onSwitchDuplicateMode = options.onSwitchDuplicateMode;

    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-dup-action]') : null;
      if (!el) return;
      var action = el.getAttribute('data-dup-action') || '';

      if (action === 'start-hash' && typeof onStartDuplicateHashDetection === 'function') {
        e.preventDefault();
        onStartDuplicateHashDetection();
        return;
      }
      if (action === 'switch-mode' && typeof onSwitchDuplicateMode === 'function') {
        e.preventDefault();
        var mode = el.getAttribute('data-mode') || 'hash';
        onSwitchDuplicateMode(mode);
        return;
      }
      if (action === 'load-groups' && typeof onLoadDuplicateGroups === 'function') {
        e.preventDefault();
        var p = parseInt(el.getAttribute('data-page') || '', 10);
        if (!isNaN(p)) onLoadDuplicateGroups(p);
        return;
      }
      if (action === 'preview' && typeof onOpenDuplicatePreview === 'function') {
        e.preventDefault();
        var hash = el.getAttribute('data-hash') || '';
        var idx = parseInt(el.getAttribute('data-index') || '', 10);
        if (!hash || isNaN(idx)) return;
        onOpenDuplicatePreview(hash, idx);
        return;
      }
      if (action === 'locate' && typeof onShowPhotoInFolderById === 'function') {
        e.preventDefault();
        var pid = parseInt(el.getAttribute('data-photo-id') || '', 10);
        if (!isNaN(pid)) onShowPhotoInFolderById(pid);
        return;
      }
      if (action === 'delete' && typeof onDeleteDuplicatePhoto === 'function') {
        e.preventDefault();
        var pid2 = parseInt(el.getAttribute('data-photo-id') || '', 10);
        var hash2 = el.getAttribute('data-hash') || '';
        if (!isNaN(pid2) && hash2) onDeleteDuplicatePhoto(pid2, hash2);
        return;
      }
    });
  }

  function bindPreviewBasicControls(options) {
    options = options || {};
    var dom = options.dom || {};
    var onClosePreview = options.onClosePreview;
    var onNavigatePreview = options.onNavigatePreview;
    var onResetZoom = options.onResetZoom;
    var onApplyZoom = options.onApplyZoom;

    if (dom.previewClose) {
      dom.previewClose.addEventListener('click', function () {
        if (typeof onClosePreview === 'function') onClosePreview();
      });
    }
    if (dom.previewPrev) {
      dom.previewPrev.addEventListener('click', function () {
        if (typeof onNavigatePreview === 'function') onNavigatePreview(-1);
      });
    }
    if (dom.previewNext) {
      dom.previewNext.addEventListener('click', function () {
        if (typeof onNavigatePreview === 'function') onNavigatePreview(1);
      });
    }
    if (dom.previewOverlay) {
      dom.previewOverlay.addEventListener('click', function (e) {
        if (e.target === dom.previewOverlay && typeof onClosePreview === 'function')
          onClosePreview();
      });
    }

    if (dom.previewImage) {
      dom.previewImage.addEventListener('dblclick', function (e) {
        e.preventDefault();
        if (typeof onResetZoom === 'function') onResetZoom();
      });
    }

    if (dom.previewOverlay) {
      dom.previewOverlay.addEventListener(
        'wheel',
        function (e) {
          if (!dom.previewOverlay.classList.contains('active')) return;
          var zooming = e.ctrlKey || e.metaKey;
          /**
           * 🔴 浮层内的**可滚动面板**（图片信息 / 字幕设置）必须先吃掉滚轮。
           *
           * 这两个面板是 `overflow-y: auto` 的滚动容器，但它们是 overlay 的**后代** ——
           * 滚轮事件冒泡到这里时如果不分目标，就会「滚面板 = 换了一张图，而面板一动不动」
           * （内容比视口长时尤其像卡死）。这里**不 preventDefault、也不切图**，把滚动交还给面板。
           *
           * 面板滚到上/下边界后仍旧落下去切换图片 —— 与浏览器 scroll-chaining 的直觉一致，
           * 否则用户在面板上想把长列表滚到底时会突然发现自己换了图。
           * Ctrl/⌘ + 滚轮永远走缩放，不受面板影响（带修饰键的意图与滚动无关）。
           */
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
            if (typeof onApplyZoom === 'function') onApplyZoom(delta);
          } else if (typeof onNavigatePreview === 'function') {
            if (e.deltaY > 20) onNavigatePreview(1);
            else if (e.deltaY < -20) onNavigatePreview(-1);
          }
        },
        { passive: false },
      );
    }
  }

  function bindPreviewDragTouchControls(options) {
    options = options || {};
    var dom = options.dom || {};
    var getState = options.getState;
    var onUpdatePreviewTransform = options.onUpdatePreviewTransform;
    var onZoomToActual = options.onZoomToActual;
    var onNavigatePreview = options.onNavigatePreview;

    if (!dom.previewImage) return;

    dom.previewImage.addEventListener('mousedown', function (e) {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state || e.button !== 0) return;
      state.isDragging = true;
      state.hasDragged = false;
      state.dragStartX = e.clientX;
      state.dragStartY = e.clientY;
      state.dragStartPanX = state.panX;
      state.dragStartPanY = state.panY;
      dom.previewImage.classList.add('dragging');
      e.preventDefault();
    });

    dom.previewImage.addEventListener(
      'touchstart',
      function (e) {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
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
      var state = typeof getState === 'function' ? getState() : null;
      if (!state || !state.isDragging) return;
      var dx = e.clientX - state.dragStartX;
      var dy = e.clientY - state.dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.hasDragged = true;
      if (state.hasDragged) {
        state.panX = state.dragStartPanX + dx;
        state.panY = state.dragStartPanY + dy;
        if (typeof onUpdatePreviewTransform === 'function') onUpdatePreviewTransform();
      }
    });

    document.addEventListener(
      'touchmove',
      function (e) {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
        if (state.isDragging && e.touches.length === 1) {
          var t = e.touches[0];
          var dx = t.clientX - state.dragStartX;
          var dy = t.clientY - state.dragStartY;
          var absDx = Math.abs(dx);
          var absDy = Math.abs(dy);

          if (!state.swipeDirection && (absDx > 10 || absDy > 10)) {
            state.swipeDirection = absDx > absDy ? 'horizontal' : 'vertical';
          }

          if (state.swipeDirection === 'horizontal' && state.zoom <= 1.05) {
            state.isSwiping = true;
            state.panX = dx * 0.3;
            if (typeof onUpdatePreviewTransform === 'function') onUpdatePreviewTransform();
            return;
          }

          if (absDx > 5 || absDy > 5) state.hasDragged = true;
          if (state.hasDragged) {
            state.panX = state.dragStartPanX + dx;
            state.panY = state.dragStartPanY + dy;
            if (typeof onUpdatePreviewTransform === 'function') onUpdatePreviewTransform();
          }
        } else if (e.touches.length === 2 && state.touchStartDist > 0) {
          var dx2 = e.touches[0].clientX - e.touches[1].clientX;
          var dy2 = e.touches[0].clientY - e.touches[1].clientY;
          var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
          var scale = dist / state.touchStartDist;
          state.zoom = Math.min(10, Math.max(0.2, state.touchStartZoom * scale));
          if (typeof onUpdatePreviewTransform === 'function') onUpdatePreviewTransform();
        }
      },
      { passive: true },
    );

    document.addEventListener('mouseup', function (e) {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state || !state.isDragging) return;
      state.isDragging = false;
      dom.previewImage.classList.remove('dragging');
      var target = e.target;
      var insidePanel =
        target && typeof target.closest === 'function'
          ? target.closest('.preview-info-panel, .preview-info-toggle')
          : null;
      if (!insidePanel && !state.hasDragged && typeof onZoomToActual === 'function') {
        onZoomToActual();
      }
    });

    document.addEventListener('touchend', function (e) {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state) return;
      var target = e.target;
      var insidePanel =
        target && typeof target.closest === 'function'
          ? target.closest('.preview-info-panel, .preview-info-toggle')
          : null;
      if (state.isDragging) {
        state.isDragging = false;
        if (state.isSwiping) {
          var swipeDx = state.panX;
          if (swipeDx < -60) {
            if (typeof onNavigatePreview === 'function') onNavigatePreview(1);
          } else if (swipeDx > 60) {
            if (typeof onNavigatePreview === 'function') onNavigatePreview(-1);
          } else {
            state.panX = 0;
            if (typeof onUpdatePreviewTransform === 'function') onUpdatePreviewTransform();
          }
          state.isSwiping = false;
        } else if (!insidePanel && !state.hasDragged && typeof onZoomToActual === 'function') {
          onZoomToActual();
        }
      }
      state.touchStartDist = 0;
    });
  }

  function bindKeyboardShortcuts(options) {
    options = options || {};
    var dom = options.dom || {};
    var getState = options.getState;
    var isKeyEventFromTypingField = options.isKeyEventFromTypingField;
    var onClosePreview = options.onClosePreview;
    var onNavigatePreview = options.onNavigatePreview;
    var onPreviewMoveToTrash = options.onPreviewMoveToTrash;
    var onPreviewToggleFavorite = options.onPreviewToggleFavorite;
    var onToggleSlideshow = options.onToggleSlideshow;
    var onResetZoom = options.onResetZoom;
    var onApplyZoom = options.onApplyZoom;
    var onOpenPreview = options.onOpenPreview;
    var onCyclePreviewRotate = options.onCyclePreviewRotate;
    var onPreviewEditSave = options.onPreviewEditSave;
    var onPreviewOpenExternal = options.onPreviewOpenExternal;
    var onPreviewFindSimilar = options.onPreviewFindSimilar;
    var onToggleChromeCollapsed = options.onToggleChromeCollapsed;
    var onHandleAddFolder = options.onHandleAddFolder;
    var onToggleDevTools = options.onToggleDevTools;
    var onOpenHomePage = options.onOpenHomePage;
    // 随机跳页（`nav.randomPage`，默认 Alt+R）。⚠️ 这一行曾经**漏了**：
    // handler 里写着 `typeof onGoToRandomPage === 'function'`，但本函数没声明它 ——
    // JS 里 `typeof 未声明标识符` 合法且恒 `'undefined'`，于是守卫永假、
    // `preventDefault(); return;` 之后什么也不发生（不报错、不打日志）。
    // 现状由 `shortcut-contract-regression.js` §4.1 那条作用域断言钉住。
    var onGoToRandomPage = options.onGoToRandomPage;
    // 组织元数据（标记 / 评分）。两个回调各带一个业务参数 ——
    // 8 个动作共用一个回调，而不是 8 个回调：动作之间的区别只是参数，
    // 拆成 8 份会让「以后加一档 6 星」变成改三处（注册表 + i18n + 这里）。
    var onPreviewSetFlag = options.onPreviewSetFlag;
    var onPreviewSetRating = options.onPreviewSetRating;

    // 键位判定统一交给注册表（`src/renderer/shortcuts.js`）。这里**只保留「动作 → 做什么」**，
    // 不再出现任何 `e.key === '...'` 字面量 —— 否则设置页改了键、这里不生效，
    // 就会出现「设置里写着 Ctrl+Shift+P，按下去没反应」这种最难查的漂移。
    function shortcuts() {
      return global.RendererShortcuts || null;
    }

    function toggleFullscreen() {
      var d = document;
      if (d.fullscreenElement) {
        if (d.exitFullscreen) d.exitFullscreen();
      } else if (d.documentElement && d.documentElement.requestFullscreen) {
        d.documentElement.requestFullscreen();
      }
    }

    function runPreviewAction(action, e, state) {
      switch (action) {
        case 'preview.close':
          if (typeof onClosePreview === 'function') onClosePreview();
          return true;
        case 'preview.prev':
          if (typeof onNavigatePreview === 'function') onNavigatePreview(-1);
          return true;
        case 'preview.next':
          if (typeof onNavigatePreview === 'function') onNavigatePreview(1);
          return true;
        case 'preview.first':
          if (
            state.previewPhotos &&
            state.previewPhotos.length &&
            typeof onOpenPreview === 'function'
          ) {
            e.preventDefault();
            onOpenPreview(0);
          }
          return true;
        case 'preview.last':
          if (
            state.previewPhotos &&
            state.previewPhotos.length &&
            typeof onOpenPreview === 'function'
          ) {
            e.preventDefault();
            onOpenPreview(state.previewPhotos.length - 1);
          }
          return true;
        case 'preview.slideshow':
          if (typeof onToggleSlideshow === 'function') {
            e.preventDefault();
            onToggleSlideshow();
          }
          return true;
        case 'preview.trash':
          if (typeof onPreviewMoveToTrash === 'function') {
            e.preventDefault();
            onPreviewMoveToTrash();
          }
          return true;
        case 'preview.favorite':
          if (typeof onPreviewToggleFavorite === 'function') {
            e.preventDefault();
            onPreviewToggleFavorite();
          }
          return true;
        case 'preview.rotate':
          if (typeof onCyclePreviewRotate === 'function') {
            e.preventDefault();
            onCyclePreviewRotate();
          }
          return true;
        case 'preview.editSave':
          if (typeof onPreviewEditSave === 'function') {
            e.preventDefault();
            onPreviewEditSave();
          }
          return true;
        case 'preview.zoomIn':
          if (typeof onApplyZoom === 'function') onApplyZoom(0.25);
          return true;
        case 'preview.zoomOut':
          if (typeof onApplyZoom === 'function') onApplyZoom(-0.25);
          return true;
        case 'preview.zoomReset':
          if (typeof onResetZoom === 'function') onResetZoom();
          return true;
        case 'preview.findSimilar':
          if (typeof onPreviewFindSimilar === 'function') {
            e.preventDefault();
            onPreviewFindSimilar();
          }
          return true;
        case 'preview.openExternal':
          if (typeof onPreviewOpenExternal === 'function') {
            e.preventDefault();
            onPreviewOpenExternal();
          }
          return true;
        // ── 组织元数据：冲片是**盲操作**，所以这一组键的语义必须能不看屏幕也说得清 ──
        //
        // 🔴 标记是**幂等设值**，不是切换：连按两下 X 的结果与按一下相同
        //    （「标为否」），而不会第二下把第一下清掉。冲片时用户左手一路按着过片，
        //    眼睛盯的是图片不是按钮 —— 一旦做成切换，「以为没按上、又按一次」就会
        //    静默清掉上一张的标记，而他当时已经在看下一张了。
        //    取消标记是**独立动作**（`preview.flagClear`）。
        case 'preview.flagPick':
          if (typeof onPreviewSetFlag === 'function') {
            e.preventDefault();
            onPreviewSetFlag('pick');
          }
          return true;
        case 'preview.flagReject':
          if (typeof onPreviewSetFlag === 'function') {
            e.preventDefault();
            onPreviewSetFlag('reject');
          }
          return true;
        case 'preview.flagClear':
          if (typeof onPreviewSetFlag === 'function') {
            e.preventDefault();
            onPreviewSetFlag('none');
          }
          return true;
        // 评分：数字键就是星数。**再按一次同一颗星 = 取消**（回到 0）——
        // 这是与 `preview.zoomReset` 抢 `0` 的替代方案（那个键位已经归零缩放/旋转）。
        // 判据放在 `org-meta-ui.js#setRating`（那才看得到当前值），这里只报「按了第几颗」。
        case 'preview.rating1':
        case 'preview.rating2':
        case 'preview.rating3':
        case 'preview.rating4':
        case 'preview.rating5':
          if (typeof onPreviewSetRating === 'function') {
            e.preventDefault();
            onPreviewSetRating(Number(action.charAt(action.length - 1)));
          }
          return true;
        default:
          return false;
      }
    }

    document.addEventListener('keydown', function (e) {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state || !dom.previewOverlay) return;
      var sr = shortcuts();
      if (!sr) return;

      if (dom.previewOverlay.classList.contains('active')) {
        runPreviewAction(sr.actionFor(e, 'preview'), e, state);
        return;
      }

      if (typeof isKeyEventFromTypingField === 'function' && isKeyEventFromTypingField(e.target))
        return;
      if (state.isMobile) return;

      // 回首页：与 rail 上那枚 #topbarHomeBtn 调**同一个** openHomePage（见下方 bindClick），
      // 唯一真相源。动作表里没有 handler 字段，所以「动作 → 做什么」只能在这里接一次。
      if (sr.matches('nav.home', e)) {
        e.preventDefault();
        if (typeof onOpenHomePage === 'function') onOpenHomePage();
        return;
      }
      // 随机跳页：与底栏 #randomPageBtn 调同一个 onGoToRandomPage（唯一真相源）；
      // totalPages<=1 / AI 视图等不适用场景由 goToRandomPage 与按钮自身显隐兜底。
      if (sr.matches('nav.randomPage', e)) {
        e.preventDefault();
        if (typeof onGoToRandomPage === 'function') onGoToRandomPage();
        return;
      }
      if (sr.matches('global.compactChrome', e)) {
        e.preventDefault();
        if (typeof onToggleChromeCollapsed === 'function') onToggleChromeCollapsed();
        return;
      }
      if (sr.matches('global.addFolder', e)) {
        e.preventDefault();
        if (typeof onHandleAddFolder === 'function') onHandleAddFolder();
        return;
      }
      if (sr.matches('global.fullscreen', e)) {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      if (sr.matches('global.devtools', e)) {
        e.preventDefault();
        if (typeof onToggleDevTools === 'function') onToggleDevTools();
      }
    });
  }

  function bindSidebarDelegates(options) {
    options = options || {};
    var dom = options.dom || {};
    var getState = options.getState;
    var onViewDuplicates = options.onViewDuplicates;
    var onHandleSettingsRescan = options.onHandleSettingsRescan;
    var onScrollToSettingsSection = options.onScrollToSettingsSection;
    var onViewDatesAll = options.onViewDatesAll;
    var onViewFavorites = options.onViewFavorites;
    var onViewDate = options.onViewDate;
    var onViewFolderOverview = options.onViewFolderOverview;
    var onToggleTreeRoot = options.onToggleTreeRoot;
    var onToggleTreeNode = options.onToggleTreeNode;
    var onNormalizePath = options.onNormalizePath;
    var onViewFolder = options.onViewFolder;
    var onSelectDuplicateGroup = options.onSelectDuplicateGroup;
    var onCloseMobileSidebar = options.onCloseMobileSidebar;
    var onDateGroupsSortChange = options.onDateGroupsSortChange;

    function closeSidebarOnMobile() {
      var state = typeof getState === 'function' ? getState() : null;
      if (state && state.isMobile && typeof onCloseMobileSidebar === 'function') {
        setTimeout(onCloseMobileSidebar, 100);
      }
    }

    if (dom.sidebarContent) {
      dom.sidebarContent.addEventListener('click', function (e) {
        var dateSortBtn =
          e.target && e.target.closest ? e.target.closest('.date-sort-btn[data-date-sort]') : null;
        if (dateSortBtn && typeof onDateGroupsSortChange === 'function') {
          e.preventDefault();
          e.stopPropagation();
          onDateGroupsSortChange(dateSortBtn.getAttribute('data-date-sort') || 'desc');
          return;
        }

        var treeToggle =
          e.target && e.target.closest ? e.target.closest('.tree-toggle[data-tree-toggle]') : null;
        if (treeToggle) {
          var tt = treeToggle.getAttribute('data-tree-toggle') || '';
          if (tt === 'root' && typeof onToggleTreeRoot === 'function') {
            e.preventDefault();
            onToggleTreeRoot(treeToggle, e);
            return;
          }
          if (tt === 'node' && typeof onToggleTreeNode === 'function') {
            e.preventDefault();
            onToggleTreeNode(treeToggle, e);
            return;
          }
        }

        var settingsNavItem = e.target.closest('.folder-item[data-settings-section-id]');
        if (settingsNavItem) {
          var sid = settingsNavItem.getAttribute('data-settings-section-id') || '';
          if (sid && typeof onScrollToSettingsSection === 'function')
            onScrollToSettingsSection(sid);
          closeSidebarOnMobile();
          return;
        }

        var dateViewItem = e.target.closest(
          '.folder-item[data-sidebar-view], .date-group[data-sidebar-view]',
        );
        if (dateViewItem) {
          var viewType = dateViewItem.getAttribute('data-sidebar-view') || '';
          if (viewType === 'dates-all' && typeof onViewDatesAll === 'function') {
            e.preventDefault();
            e.stopPropagation();
            onViewDatesAll();
            closeSidebarOnMobile();
            return;
          }
          if (viewType === 'favorites' && typeof onViewFavorites === 'function') {
            e.preventDefault();
            e.stopPropagation();
            onViewFavorites();
            closeSidebarOnMobile();
            return;
          }
          if (viewType === 'date' && typeof onViewDate === 'function') {
            e.preventDefault();
            e.stopPropagation();
            var dt = dateViewItem.getAttribute('data-date') || '';
            onViewDate(dt);
            closeSidebarOnMobile();
            return;
          }
          if (viewType === 'folder-overview' && typeof onViewFolderOverview === 'function') {
            e.preventDefault();
            e.stopPropagation();
            onViewFolderOverview();
            closeSidebarOnMobile();
            return;
          }
        }

        var dupRootItem = e.target.closest('.folder-item[data-sidebar-duplicates]');
        if (dupRootItem) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof onViewDuplicates === 'function') onViewDuplicates();
          closeSidebarOnMobile();
          return;
        }

        var rescanBtn = e.target.closest('.sidebar-root-rescan');
        if (rescanBtn) {
          e.preventDefault();
          e.stopPropagation();
          var rp = rescanBtn.getAttribute('data-root-path');
          if (rp && typeof onHandleSettingsRescan === 'function') {
            var normalized = typeof onNormalizePath === 'function' ? onNormalizePath(rp) : rp;
            onHandleSettingsRescan(normalized);
          }
          return;
        }

        var item = e.target.closest('.folder-item[data-folder-path]');
        if (item) {
          if (typeof onViewFolder === 'function') {
            var p1 = item.getAttribute('data-folder-path');
            onViewFolder(typeof onNormalizePath === 'function' ? onNormalizePath(p1) : p1);
          }
          closeSidebarOnMobile();
          return;
        }

        var rootItem = e.target.closest('.folder-item[data-root-path]');
        if (rootItem) {
          if (typeof onViewFolder === 'function') {
            var p2 = rootItem.getAttribute('data-root-path');
            onViewFolder(typeof onNormalizePath === 'function' ? onNormalizePath(p2) : p2);
          }
          closeSidebarOnMobile();
          return;
        }

        var dupItem = e.target.closest('.folder-item[data-dup-hash]');
        if (dupItem) {
          var dh = dupItem.getAttribute('data-dup-hash') || '';
          if (typeof onSelectDuplicateGroup === 'function') onSelectDuplicateGroup(dh);
          closeSidebarOnMobile();
        }
      });
    }

    if (dom.sidebarContentDuplicate) {
      dom.sidebarContentDuplicate.addEventListener('click', function (e) {
        var dupRootItem = e.target.closest('.folder-item[data-sidebar-duplicates]');
        if (dupRootItem) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof onViewDuplicates === 'function') onViewDuplicates();
          closeSidebarOnMobile();
          return;
        }

        var dupItem = e.target.closest('.folder-item[data-dup-hash]');
        if (!dupItem) return;
        var dh = dupItem.getAttribute('data-dup-hash') || '';
        if (typeof onSelectDuplicateGroup === 'function') onSelectDuplicateGroup(dh);
        closeSidebarOnMobile();
      });
    }
  }

  function bindPreviewUiMeta(options) {
    options = options || {};
    var dom = options.dom || {};
    var onRestartSlideshowTimer = options.onRestartSlideshowTimer;
    var onSyncFullscreenButton = options.onSyncFullscreenButton;
    var onUpdatePreviewImageLayoutBounds = options.onUpdatePreviewImageLayoutBounds;
    var fsUiHideTimer = null;
    var fsUiArmRaf = 0;
    // 指针当前是否压在浮层控件本体上（按钮 / 切换 / 缩放百分比）。
    // 为真时**不收起** —— 否则控件会在光标底下消失，缩放提示框和
    // 「先移到按钮上再点」这条最自然的操作路径都拿不到。
    var fsUiPointerOverControls = false;

    function setFullscreenUiVisible(visible) {
      if (!dom.previewOverlay || !dom.previewOverlay.classList) return;
      dom.previewOverlay.classList.toggle('fs-ui-visible', !!visible);
    }

    function isPreviewFullscreen() {
      return !!(
        dom.previewOverlay &&
        dom.previewOverlay.classList &&
        dom.previewOverlay.classList.contains('active') &&
        dom.previewOverlay.classList.contains('is-fullscreen')
      );
    }

    function scheduleFullscreenUiHide(delayMs) {
      if (fsUiHideTimer) clearTimeout(fsUiHideTimer);
      fsUiHideTimer = setTimeout(function () {
        fsUiHideTimer = null;
        if (!isPreviewFullscreen()) return;
        if (fsUiPointerOverControls) {
          // 指针还停在控件上，隔一会儿再问一次（不是死循环的「永不收起」：
          // 只要指针移开图像区，下一次 mousemove 就会把标记清掉）。
          scheduleFullscreenUiHide(400);
          return;
        }
        setFullscreenUiVisible(false);
      }, delayMs || 1400);
    }

    function revealFullscreenUiOnMove(target) {
      fsUiPointerOverControls = !!(
        target &&
        target.closest &&
        target.closest(
          '.preview-slideshow-controls, .preview-window-controls, .preview-nav, .preview-zoom-box',
        )
      );
      if (fsUiArmRaf) return;
      fsUiArmRaf = requestAnimationFrame(function () {
        fsUiArmRaf = 0;
        setFullscreenUiVisible(true);
        scheduleFullscreenUiHide(1100);
      });
    }

    if (dom.slideshowIntervalSelect) {
      dom.slideshowIntervalSelect.addEventListener('change', function () {
        var state = options.getState ? options.getState() : null;
        if (!state) return;
        var sec = parseInt(dom.slideshowIntervalSelect.value, 10);
        state.slideshowIntervalSec = isNaN(sec) ? 3 : sec;
        if (state.slideshowPlaying && typeof onRestartSlideshowTimer === 'function') {
          onRestartSlideshowTimer();
        }
      });
    }
    if (dom.slideshowRandomBtn) {
      dom.slideshowRandomBtn.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }

    var slideshowControls = document.querySelector('.preview-slideshow-controls');
    if (slideshowControls) {
      ['click', 'mousedown', 'touchstart', 'wheel'].forEach(function (evt) {
        slideshowControls.addEventListener(
          evt,
          function (e) {
            e.stopPropagation();
          },
          { passive: evt !== 'wheel' },
        );
      });
    }

    var previewChromeTop = document.querySelector('.preview-chrome-top');
    if (previewChromeTop) {
      previewChromeTop.addEventListener(
        'wheel',
        function (e) {
          e.stopPropagation();
        },
        { passive: false },
      );
    }

    if (dom.previewOverlay) {
      // 全屏下四组浮层控件统一由 fs-ui-visible 派生（CSS 见 styles.css「全屏浮层控件显隐」）：
      // 鼠标在**预览层任意位置**移动都唤出（不再只认上下 12% 边缘区 —— 左右切换按钮在
      // 屏幕正中间，边缘判据下平时根本唤不出来，等于点不到），静止约 1.1s 后一起淡出。
      dom.previewOverlay.addEventListener('mousemove', function (e) {
        if (!dom.previewOverlay.classList.contains('is-fullscreen')) return;
        revealFullscreenUiOnMove(e.target);
      });
      dom.previewOverlay.addEventListener('mouseleave', function () {
        if (!dom.previewOverlay.classList.contains('is-fullscreen')) return;
        fsUiPointerOverControls = false;
        scheduleFullscreenUiHide(180);
      });
    }

    document.addEventListener('fullscreenchange', function () {
      var isPreviewFs = !!(
        dom.previewOverlay &&
        document.fullscreenElement &&
        document.fullscreenElement === dom.previewOverlay
      );
      if (dom.previewOverlay && dom.previewOverlay.classList) {
        dom.previewOverlay.classList.toggle('is-fullscreen', isPreviewFs);
        // 进出全屏时指针位置是「上一次交互的残留」（例如刚点完「全屏」按钮，
        // 光标还压在工具条上），必须重置，否则那一次悬停会把工具条永久钉住。
        fsUiPointerOverControls = false;
        if (isPreviewFs) {
          setFullscreenUiVisible(true);
          scheduleFullscreenUiHide(1200);
        } else {
          setFullscreenUiVisible(false);
          if (fsUiHideTimer) {
            clearTimeout(fsUiHideTimer);
            fsUiHideTimer = null;
          }
        }
      }
      if (typeof onSyncFullscreenButton === 'function') onSyncFullscreenButton();
      if (typeof onUpdatePreviewImageLayoutBounds === 'function')
        onUpdatePreviewImageLayoutBounds();
    });

    if (dom.previewBody && typeof ResizeObserver !== 'undefined') {
      var previewBodyRO = new ResizeObserver(function () {
        if (typeof onUpdatePreviewImageLayoutBounds === 'function')
          onUpdatePreviewImageLayoutBounds();
      });
      previewBodyRO.observe(dom.previewBody);
    }
  }

  function bindCardShineTracking() {
    var glowRaf = 0;
    var glowClientX = 0;
    var glowClientY = 0;
    var glowTargetCard = null;
    document.addEventListener('mousemove', function (e) {
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
  }

  global.RendererUIEvents = Object.assign({}, global.RendererUIEvents || {}, {
    bindTitlebarMenu: bindTitlebarMenu,
    bindWindowControls: bindWindowControls,
    bindMobileSidebar: bindMobileSidebar,
    bindSettingsDelegates: bindSettingsDelegates,
    bindShellInlineActions: bindShellInlineActions,
    bindMiscControls: bindMiscControls,
    bindNavTabs: bindNavTabs,
    bindSearchSortFilters: bindSearchSortFilters,
    bindPaginationAndFolderCoverClick: bindPaginationAndFolderCoverClick,
    bindPhotoGridDelegates: bindPhotoGridDelegates,
    bindDuplicatesDelegates: bindDuplicatesDelegates,
    bindPreviewBasicControls: bindPreviewBasicControls,
    bindPreviewDragTouchControls: bindPreviewDragTouchControls,
    bindKeyboardShortcuts: bindKeyboardShortcuts,
    bindSidebarDelegates: bindSidebarDelegates,
    bindPreviewUiMeta: bindPreviewUiMeta,
    bindCardShineTracking: bindCardShineTracking,
  });
})(window);
