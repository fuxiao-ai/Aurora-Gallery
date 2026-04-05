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
    var onPersistWindowClose = options.onPersistWindowClose;
    var onPersistGeneralSettings = options.onPersistGeneralSettings;
    var onPersistUiLocale = options.onPersistUiLocale;
    var onToggleTunnelEnabled = options.onToggleTunnelEnabled;
    var onToggleWebServerEnabled = options.onToggleWebServerEnabled;
    var onPersistBrowsePrefs = options.onPersistBrowsePrefs;
    var onPersistFacePrefs = options.onPersistFacePrefs;
    var onFaceResetScanStatus = options.onFaceResetScanStatus;
    var appAlert = options.appAlert;

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
        if (sid === 'settingFaceAutoScanOnStartup' && typeof onPersistFacePrefs === 'function') {
          void onPersistFacePrefs();
        }
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
          sid === 'settingLaunchDefaultPage' ||
          sid === 'settingThemeStyle' ||
          sid === 'settingSubtitleFontFamily' ||
          sid === 'settingSubtitleFontSize' ||
          sid === 'settingSubtitleFontWeight' ||
          sid === 'settingSubtitleColor' ||
          sid === 'settingThumbBackfillConcurrency') &&
        typeof onPersistGeneralSettings === 'function'
      ) {
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
          sid === 'settingBrowseFolderIncludeSubfolders') &&
        typeof onPersistBrowsePrefs === 'function'
      ) {
        void onPersistBrowsePrefs();
      }
      if (
        sid === 'settingFaceClusterThreshold' &&
        typeof onPersistFacePrefs === 'function'
      ) {
        void onPersistFacePrefs();
      }
    });

    // 绑定重置人脸扫描状态按钮
    var resetBtn = document.getElementById('btnResetFaceScanStatus');
    if (resetBtn && typeof onFaceResetScanStatus === 'function') {
      resetBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!confirm('确定要重置所有人脸扫描状态吗？\n\n这会让所有图片重新进行人脸识别，但是会保留已经合并好的人物分组。')) {
          return;
        }
        onFaceResetScanStatus().then(function (result) {
          if (result && result.success) {
            if (typeof appAlert === 'function') {
              appAlert('已重置 ' + (result.resetCount || 0) + ' 张图片的扫描状态。现在可以重新开始人脸识别。');
            }
            // 更新人脸界面统计数字
            setTimeout(function() {
              if (typeof RendererFacesUI !== 'undefined' &&
                  typeof RendererFacesUI.updateFaceStats === 'function' &&
                  typeof api !== 'undefined' &&
                  typeof formatNumber === 'function') {
                RendererFacesUI.updateFaceStats(api, formatNumber);
              }
            }, 100);
          } else {
            if (typeof appAlert === 'function') {
              appAlert('重置失败');
            }
          }
        }).catch(function (err) {
          if (typeof appAlert === 'function') {
            appAlert('重置失败：' + (err && err.message ? err.message : String(err)));
          }
        });
      });
    }

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
        handler(e);
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
    bindClick('taskPanelToggleBtn', options.onToggleTaskPanelCollapse);
    bindClick('pauseResumeScanBtn', options.onPauseResumeScan);
    bindClick('cancelScanBtn', options.onCancelScan);
    bindClick('taskCancelThumbBtn', options.onCancelThumbnailBackfill);
    bindClick('taskCancelDupHashBtn', options.onCancelDuplicateHashDetection);
    bindClick('cardSizeDecBtn', options.onCardSizeDec);
    bindClick('cardSizeIncBtn', options.onCardSizeInc);
    bindClick('thumbSettingsApplyBtn', options.onApplyThumbSettings);
    bindClick('thumbBackfillStartBtn', options.onStartThumbnailBackfill);
    bindClick('thumbBackfillCancelBtn', options.onCancelThumbnailBackfill);
    bindClick('thumbBackfillExportFailedBtn', options.onExportThumbnailBackfillFailedPaths);
    bindClick('duplicateHashStartBtn', options.onStartDuplicateHashDetection);
    bindClick('duplicateHashCancelBtn', options.onCancelDuplicateHashDetection);
    bindClick('maintenanceCleanupBtn', options.onRunMaintenanceCleanup);
    bindClick('maintenanceRebuildThumbFlagsBtn', options.onRunMaintenanceRebuildThumbFlags);
    bindClick('maintenanceOptimizeBtn', options.onRunMaintenanceOptimize);
    bindClick('maintenanceOpenDbFolderBtn', options.onOpenDatabaseFolder);
    bindClick('maintenanceBackupDbBtn', options.onRunMaintenanceBackup);
    bindClick('saveWebPasswordBtn', options.onSaveWebPassword);
    bindClick('slideshowToggleBtn', options.onToggleSlideshow);
    bindClick('slideshowRandomBtn', options.onToggleSlideshowRandom);
    bindClick('previewFullscreenBtn', options.onTogglePreviewFullscreen);
    bindClick('previewMinimizeBtn', options.onMinimizePreview);
    bindClick('previewMaximizeBtn', options.onPreviewWindowMaximize);
    bindClick('previewRotateBtn', options.onCyclePreviewRotate);
    bindClick('previewFavoriteBtn', options.onPreviewToggleFavorite);
    bindClick('previewShowInFolderBtn', options.onPreviewShowInFolder);
    bindClick('previewOpenExternalBtn', options.onPreviewOpenExternal);
    bindClick('previewMoveToTrashBtn', options.onPreviewMoveToTrash);
    bindClick('closeChoiceTrayBtn', function () {
      if (typeof options.onSubmitCloseChoice === 'function') options.onSubmitCloseChoice('tray');
    });
    bindClick('closeChoiceQuitBtn', function () {
      if (typeof options.onSubmitCloseChoice === 'function') options.onSubmitCloseChoice('quit');
    });
    bindClick('closeChoiceCancelBtn', function () {
      if (typeof options.onSubmitCloseChoice === 'function') options.onSubmitCloseChoice('cancel');
    });
    bindClick('settingsExportFoldersBtn', options.onExportRootFoldersList);
    bindClick('settingsImportFoldersBtn', options.onImportRootFoldersList);
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
    var onViewFaces = options.onViewFaces;
    var onShowTabContent = options.onShowTabContent;
    var onForceSwitchToDuplicates = options.onForceSwitchToDuplicates;
    var onEnsureDuplicateSidebarVisible = options.onEnsureDuplicateSidebarVisible;
    var onRenderDuplicateSidebar = options.onRenderDuplicateSidebar;
    var onRenderFaceSidebar = options.onRenderFaceSidebar;
    var onSaveBrowseTabMemory = options.onSaveBrowseTabMemory;
    var onSaveFaceTabMemory = options.onSaveFaceTabMemory;

    document.querySelectorAll('.nav-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var state = typeof getState === 'function' ? getState() : null;
        if (!state) return;
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

        if (nextTab === 'faces') {
          if (typeof onViewFaces === 'function') onViewFaces();
          requestAnimationFrame(function () {
            var s2 = typeof getState === 'function' ? getState() : null;
            if (!s2 || s2.currentTab !== 'faces') return;
            if (typeof onEnsureDuplicateSidebarVisible === 'function')
              onEnsureDuplicateSidebarVisible();
            if (typeof onRenderFaceSidebar === 'function') onRenderFaceSidebar();
          });
          return;
        }

        var prevTab = state.currentTab;
        if (prevTab === 'folders' || prevTab === 'dates') {
          if (typeof onSaveBrowseTabMemory === 'function') onSaveBrowseTabMemory(prevTab);
        } else if (prevTab === 'faces') {
          if (typeof onSaveFaceTabMemory === 'function') onSaveFaceTabMemory();
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

    var searchTimer;
    if (dom.searchInput) {
      dom.searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          var state = typeof getState === 'function' ? getState() : null;
          if (!state) return;
          if (state.currentTab === 'duplicates') return;
          state.searchQuery = dom.searchInput.value.trim();
          if (state.currentView === 'favorites') {
            state.page = 1;
            if (typeof onLoadPhotos === 'function') onLoadPhotos();
            return;
          }
          if (state.searchQuery) state.currentView = 'search';
          else if (state.currentView !== 'folder_overview') state.currentView = 'all';
          state.page = 1;
          if (typeof onLoadPhotos === 'function') onLoadPhotos();
        }, 300);
      });
    }

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
        if (state.currentTab === 'folders' && typeof onLoadRootFolders === 'function') {
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

    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-dup-action]') : null;
      if (!el) return;
      var action = el.getAttribute('data-dup-action') || '';

      if (action === 'start-hash' && typeof onStartDuplicateHashDetection === 'function') {
        e.preventDefault();
        onStartDuplicateHashDetection();
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
          e.preventDefault();
          if (e.ctrlKey || e.metaKey) {
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

    document.addEventListener('mouseup', function () {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state || !state.isDragging) return;
      state.isDragging = false;
      dom.previewImage.classList.remove('dragging');
      if (!state.hasDragged && typeof onZoomToActual === 'function') {
        onZoomToActual();
      }
    });

    document.addEventListener('touchend', function () {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state) return;
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
        } else if (!state.hasDragged && typeof onZoomToActual === 'function') {
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
    var onPreviewOpenExternal = options.onPreviewOpenExternal;
    var onToggleChromeCollapsed = options.onToggleChromeCollapsed;

    document.addEventListener('keydown', function (e) {
      var state = typeof getState === 'function' ? getState() : null;
      if (!state || !dom.previewOverlay) return;

      if (dom.previewOverlay.classList.contains('active')) {
        if (e.key === 'Escape' && typeof onClosePreview === 'function') onClosePreview();
        if (e.key === 'ArrowLeft' && typeof onNavigatePreview === 'function') onNavigatePreview(-1);
        if (e.key === 'ArrowRight' && typeof onNavigatePreview === 'function') onNavigatePreview(1);
        if (e.key === 'Delete' && typeof onPreviewMoveToTrash === 'function') {
          e.preventDefault();
          onPreviewMoveToTrash();
        }
        if (
          (e.key === 'f' || e.key === 'F') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          typeof onPreviewToggleFavorite === 'function'
        ) {
          e.preventDefault();
          onPreviewToggleFavorite();
        }
        if (e.key === ' ' && typeof onToggleSlideshow === 'function') {
          e.preventDefault();
          onToggleSlideshow();
        }
        if (e.key === '0' && typeof onResetZoom === 'function') onResetZoom();
        if ((e.key === '+' || e.key === '=') && typeof onApplyZoom === 'function')
          onApplyZoom(0.25);
        if ((e.key === '-' || e.key === '_') && typeof onApplyZoom === 'function')
          onApplyZoom(-0.25);
        if (e.key === 'Home') {
          e.preventDefault();
          if (
            state.previewPhotos &&
            state.previewPhotos.length &&
            typeof onOpenPreview === 'function'
          )
            onOpenPreview(0);
        }
        if (e.key === 'End') {
          e.preventDefault();
          if (
            state.previewPhotos &&
            state.previewPhotos.length &&
            typeof onOpenPreview === 'function'
          )
            onOpenPreview(state.previewPhotos.length - 1);
        }
        if (
          (e.key === 'r' || e.key === 'R') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          typeof onCyclePreviewRotate === 'function'
        ) {
          e.preventDefault();
          onCyclePreviewRotate();
        }
        if (
          (e.key === 'o' || e.key === 'O') &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          typeof onPreviewOpenExternal === 'function'
        ) {
          e.preventDefault();
          onPreviewOpenExternal();
        }
        return;
      }

      if (typeof isKeyEventFromTypingField === 'function' && isKeyEventFromTypingField(e.target))
        return;
      if (state.isMobile) return;
      var primaryMod = e.ctrlKey || e.metaKey;
      if (
        (e.key === 'b' || e.key === 'B') &&
        primaryMod &&
        !e.shiftKey &&
        !e.altKey &&
        typeof onToggleChromeCollapsed === 'function'
      ) {
        e.preventDefault();
        onToggleChromeCollapsed();
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
        var dateSortBtn = e.target && e.target.closest ? e.target.closest('.date-sort-btn[data-date-sort]') : null;
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

    function setFullscreenUiVisible(visible) {
      if (!dom.previewOverlay || !dom.previewOverlay.classList) return;
      dom.previewOverlay.classList.toggle('fs-ui-visible', !!visible);
    }

    function scheduleFullscreenUiHide(delayMs) {
      if (fsUiHideTimer) clearTimeout(fsUiHideTimer);
      fsUiHideTimer = setTimeout(function () {
        if (!dom.previewOverlay || !dom.previewOverlay.classList) return;
        if (
          dom.previewOverlay.classList.contains('active') &&
          dom.previewOverlay.classList.contains('is-fullscreen')
        ) {
          setFullscreenUiVisible(false);
        }
      }, delayMs || 1400);
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
      dom.previewOverlay.addEventListener('mousemove', function (e) {
        if (!dom.previewOverlay.classList.contains('is-fullscreen')) return;
        var rect = dom.previewOverlay.getBoundingClientRect();
        var y = e.clientY - rect.top;
        var h = rect.height;
        var edgeZone = Math.max(56, Math.min(120, Math.round(h * 0.12)));
        var shouldShow = y <= edgeZone || y >= h - edgeZone;
        if (shouldShow) {
          setFullscreenUiVisible(true);
          scheduleFullscreenUiHide(1100);
        }
      });
      dom.previewOverlay.addEventListener('mouseleave', function () {
        if (!dom.previewOverlay.classList.contains('is-fullscreen')) return;
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
