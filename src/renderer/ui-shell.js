(function (global) {
  'use strict';

  // ===== sidebar-resizer.js =====
  var SIDEBAR_WIDTH_STORAGE_KEY = 'pm_sidebar_width_px';
  var SIDEBAR_DRAG_MIN = 200;
  var SIDEBAR_DRAG_MAX = 480;

  function initSidebarResizer() {
    var resizer = document.getElementById('sidebarResizer');
    if (!resizer) return;
    try {
      var saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), 10);
      if (!isNaN(saved) && saved >= SIDEBAR_DRAG_MIN && saved <= SIDEBAR_DRAG_MAX) {
        document.documentElement.style.setProperty('--sidebar-width', saved + 'px');
      }
    } catch (e) {}

    var dragging = false;
    var startX = 0;
    var startW = 0;

    function readSidebarWidth() {
      var side = document.getElementById('sidebar');
      if (!side) return 260;
      return side.getBoundingClientRect().width;
    }

    resizer.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (window.innerWidth <= 600) return;
      var side = document.getElementById('sidebar');
      if (!side || window.getComputedStyle(side).display === 'none') return;
      dragging = true;
      resizer.classList.add('is-dragging');
      startX = e.clientX;
      startW = readSidebarWidth();
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener(
      'mousemove',
      function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX;
        var next = Math.round(startW + dx);
        next = Math.max(SIDEBAR_DRAG_MIN, Math.min(SIDEBAR_DRAG_MAX, next));
        document.documentElement.style.setProperty('--sidebar-width', next + 'px');
      },
      true,
    );

    window.addEventListener(
      'mouseup',
      function () {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('is-dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try {
          var side = document.getElementById('sidebar');
          if (side && window.getComputedStyle(side).display !== 'none') {
            var w = Math.round(side.getBoundingClientRect().width);
            w = Math.max(SIDEBAR_DRAG_MIN, Math.min(SIDEBAR_DRAG_MAX, w));
            localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(w));
          }
        } catch (e2) {}
      },
      true,
    );
  }

  global.RendererSidebarResizer = Object.assign({}, global.RendererSidebarResizer || {}, {
    initSidebarResizer: initSidebarResizer,
  });

  // ===== task-panel-ui.js =====
  var TASK_PANEL_COLLAPSED_KEY = 'taskPanelCollapsed';

  function isTaskPanelCollapsedPref() {
    try {
      return localStorage.getItem(TASK_PANEL_COLLAPSED_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setTaskPanelCollapsedPref(collapsed) {
    try {
      if (collapsed) localStorage.setItem(TASK_PANEL_COLLAPSED_KEY, '1');
      else localStorage.removeItem(TASK_PANEL_COLLAPSED_KEY);
    } catch (e) {}
  }

  function syncTaskPanelCollapsedUI(options) {
    options = options || {};
    var dom = options.dom || {};
    if (!dom.scanProgress) return;
    var collapsed = isTaskPanelCollapsedPref();
    dom.scanProgress.classList.toggle('task-panel-collapsed', collapsed);
    var btn = document.getElementById('taskPanelToggleBtn');
    if (btn) {
      btn.textContent = collapsed ? '展开' : '收起';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }

  function toggleTaskPanelCollapse(options) {
    options = options || {};
    setTaskPanelCollapsedPref(!isTaskPanelCollapsedPref());
    syncTaskPanelCollapsedUI(options);
  }

  global.RendererTaskPanelUI = Object.assign({}, global.RendererTaskPanelUI || {}, {
    isTaskPanelCollapsedPref: isTaskPanelCollapsedPref,
    setTaskPanelCollapsedPref: setTaskPanelCollapsedPref,
    syncTaskPanelCollapsedUI: syncTaskPanelCollapsedUI,
    toggleTaskPanelCollapse: toggleTaskPanelCollapse,
  });

  // ===== web-access-ui.js =====
  async function loadWebUrl(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    try {
      var webUrl = await (api && api.has && api.has('getWebUrl')
        ? api.getWebUrl()
        : Promise.resolve(''));
      if (webUrl) {
        state.webUrl = webUrl;
        var urlText = document.getElementById('webUrlText');
        if (urlText) {
          urlText.textContent = webUrl;
        }
      }
    } catch (e) {
      // 忽略
    }
  }

  async function refreshWebServerStatus(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var stEl = document.getElementById('webServerStatus');
    var urlEl = document.getElementById('webUrlText');
    var sw = document.getElementById('settingWebServerEnabled');
    if (!(api && api.has && api.has('webServerGetStatus'))) {
      if (urlEl && state.webUrl) urlEl.textContent = state.webUrl;
      return;
    }
    try {
      var s = await api.webServerGetStatus();
      var enabled = !!(s && s.enabled);
      var running = !!(s && s.running);
      var url = s && s.url ? String(s.url) : '';
      if (sw && sw.dataset.syncing !== '1') {
        sw.checked = enabled;
        sw.disabled = false;
      }
      if (stEl) {
        stEl.textContent = enabled ? (running ? '运行' : '未就绪') : '未开启';
        stEl.classList.remove('online', 'offline');
        stEl.classList.add(enabled && running ? 'online' : 'offline');
      }
      if (enabled && url) {
        state.webUrl = url;
        if (urlEl) urlEl.textContent = url;
      } else if (urlEl) {
        urlEl.textContent = '未开启';
      }
    } catch (e) {
      if (stEl) {
        stEl.textContent = '读取失败';
        stEl.classList.remove('online');
        stEl.classList.add('offline');
      }
    }
  }

  async function toggleWebServerEnabled(options) {
    options = options || {};
    var api = options.api || null;
    var enabled = !!options.enabled;
    var appAlert = options.appAlert || function () {};
    var onRefreshWebServerStatus = options.onRefreshWebServerStatus || function () {};
    if (!(api && api.has && api.has('webServerSetEnabled'))) return;
    var sw = document.getElementById('settingWebServerEnabled');
    if (sw) sw.dataset.syncing = '1';
    try {
      var r = await api.webServerSetEnabled(!!enabled);
      if (!r || !r.success) {
        appAlert('局域网访问开关操作失败：' + ((r && r.error) || '未知错误'));
        if (sw) sw.checked = !enabled;
      }
    } catch (e) {
      appAlert('局域网访问开关操作失败：' + (e && e.message ? e.message : String(e)));
      if (sw) sw.checked = !enabled;
    } finally {
      if (sw) delete sw.dataset.syncing;
      onRefreshWebServerStatus();
    }
  }

  function copyWebUrl(options) {
    options = options || {};
    var state = options.state || {};
    if (!state.webUrl) return;
    var copyEl = document.getElementById('webUrlCopy');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(state.webUrl).then(function () {
        if (copyEl) {
          copyEl.textContent = '已复制！';
          setTimeout(function () {
            copyEl.textContent = '点击复制';
          }, 1500);
        }
      });
    } else {
      // fallback
      var textarea = document.createElement('textarea');
      textarea.value = state.webUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      if (copyEl) {
        copyEl.textContent = '已复制！';
        setTimeout(function () {
          copyEl.textContent = '点击复制';
        }, 1500);
      }
    }
  }

  async function refreshTunnelStatus(options) {
    options = options || {};
    var api = options.api || null;
    if (!(api && api.has && api.has('tunnelGetStatus'))) return;
    var stEl = document.getElementById('tunnelStatusBadge');
    var urlEl = document.getElementById('tunnelUrlText');
    var binEl = document.getElementById('tunnelBinaryPathText');
    var logHintEl = document.getElementById('tunnelLogHint');
    var logRowEl = document.getElementById('tunnelLogRow');
    var logPreEl = document.getElementById('tunnelLogPre');
    var sw = document.getElementById('settingTunnelEnabled');
    try {
      var s = await api.tunnelGetStatus();
      var statusRaw = (s && s.status ? String(s.status) : 'idle').toLowerCase();
      var isEnabled = !!(s && s.enabled);
      var statusLabel = '未开启';
      if (!isEnabled) {
        statusLabel = '未开启';
      } else if (statusRaw === 'running') {
        statusLabel = '运行中';
      } else if (statusRaw === 'starting') {
        statusLabel = '启动中';
      } else if (statusRaw === 'error') {
        statusLabel = '异常';
      } else {
        statusLabel = '待就绪';
      }
      if (stEl) {
        stEl.textContent = statusLabel;
        stEl.classList.remove('online', 'offline');
        stEl.classList.add(isEnabled && statusRaw === 'running' ? 'online' : 'offline');
      }
      if (urlEl) urlEl.textContent = s.url || '未获取';
      if (binEl) {
        if (s && s.binaryPath) {
          var src = String(s.binaryPath || '');
          binEl.textContent = 'cloudflared：' + src;
        } else {
          binEl.textContent = 'cloudflared：未找到';
        }
      }

      var logTail = s && s.logTail ? String(s.logTail) : '';
      var showLog = !!(s && s.status === 'error' && logTail);
      if (logHintEl) logHintEl.style.display = showLog ? '' : 'none';
      if (logRowEl) logRowEl.style.display = showLog ? 'flex' : 'none';
      if (logPreEl) logPreEl.textContent = showLog ? logTail : '';
      if (sw && sw.dataset.syncing !== '1') {
        sw.checked = !!s.enabled;
        // 允许用户在任何状态下手动关闭，避免 starting/error 场景关不掉。
        sw.disabled = false;
      }

      // Tunnel 地址通常会在启动后几秒才出现；如果启用中但还没拿到 URL，做轻量轮询刷新 UI。
      if (global.__pmTunnelPollTimer) {
        clearTimeout(global.__pmTunnelPollTimer);
        global.__pmTunnelPollTimer = null;
      }
      var needPoll =
        !!s &&
        !!s.enabled &&
        (s.status === 'starting' || (s.running && !s.url)) &&
        !s.error &&
        !(s.ready === false);
      if (needPoll) {
        global.__pmTunnelPollTimer = setTimeout(function () {
          try {
            void refreshTunnelStatus(options);
          } catch (e2) {}
        }, 1000);
      }
    } catch (e) {
      if (stEl) {
        stEl.textContent = '读取失败';
        stEl.classList.remove('online');
        stEl.classList.add('offline');
      }
      if (binEl) binEl.textContent = 'cloudflared：读取失败';
    }
  }

  async function toggleTunnelEnabled(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var enabled = !!options.enabled;
    var appAlert = options.appAlert || function () {};
    var onRefreshTunnelStatus = options.onRefreshTunnelStatus || function () {};
    if (!(api && api.has && api.has('tunnelSetEnabled'))) return;
    var sw = document.getElementById('settingTunnelEnabled');
    var pwdInput = document.getElementById('settingWebPassword');
    var hasPwdTyped = pwdInput && pwdInput.value && pwdInput.value.trim().length > 0;
    if (enabled && !state.hasWebPassword && !hasPwdTyped) {
      appAlert('请先设置网页访问密码，再开启 Tunnel。');
      if (sw) sw.checked = false;
      return;
    }
    if (enabled && !state.hasWebPassword && hasPwdTyped) {
      appAlert('请先点击「确认应用」保存访问密码，再开启 Tunnel。');
      if (sw) sw.checked = false;
      return;
    }
    if (sw) sw.dataset.syncing = '1';
    var r = await api.tunnelSetEnabled(!!enabled);
    if (!r || !r.success) {
      appAlert('Tunnel 操作失败：' + ((r && r.error) || '未知错误'));
      if (sw) sw.checked = !enabled;
    }
    if (sw) delete sw.dataset.syncing;
    onRefreshTunnelStatus();
  }

  function copyTunnelUrl() {
    var textEl = document.getElementById('tunnelUrlText');
    var copyEl = document.getElementById('tunnelUrlCopy');
    var u = textEl ? String(textEl.textContent || '') : '';
    if (!u || u === '未获取') return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(u).then(function () {
        if (copyEl) {
          copyEl.textContent = '已复制！';
          setTimeout(function () {
            copyEl.textContent = '点击复制';
          }, 1500);
        }
      });
    }
  }

  function copyTunnelLog() {
    var pre = document.getElementById('tunnelLogPre');
    var btn = document.getElementById('tunnelLogCopyBtn');
    var text = pre ? String(pre.textContent || '') : '';
    if (!text) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        if (btn) {
          var old = btn.textContent;
          btn.textContent = '已复制';
          setTimeout(function () {
            btn.textContent = old || '复制日志';
          }, 1500);
        }
      });
    }
  }

  async function saveWebPassword(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var settingsSync = options.settingsSync || {};
    var saveLastSettingsSectionId = options.saveLastSettingsSectionId || function () {};
    var onRenderSettingsNav = options.onRenderSettingsNav || function () {};
    var appAlert = options.appAlert || function () {};
    var onRefreshTunnelStatus = options.onRefreshTunnelStatus || function () {};
    var getCurrentTab = options.getCurrentTab;

    var pwdInput = document.getElementById('settingWebPassword');
    var canUpdateSettings = !!(api && api.has && api.has('updateSettings'));
    if (!pwdInput || !canUpdateSettings) return;
    var newPwd = pwdInput.value.trim();
    try {
      var saved = await api.updateSettings({ webPassword: newPwd });
      if (settingsSync && typeof settingsSync.syncWebPasswordUiFromSettings === 'function') {
        settingsSync.syncWebPasswordUiFromSettings({
          state: state,
          settings: saved || {},
        });
      }
      pwdInput.value = '';
      delete pwdInput.dataset.pwdTouched;
      saveLastSettingsSectionId('settingsSectionNetwork');
      if (typeof getCurrentTab === 'function' ? getCurrentTab() === 'settings' : false)
        onRenderSettingsNav('settingsSectionNetwork');
      appAlert(newPwd ? '访问密码已设置' : '访问密码已清除');
      onRefreshTunnelStatus();
    } catch (e) {
      appAlert('保存访问密码失败：' + (e && e.message ? e.message : String(e)));
    }
  }

  global.RendererWebAccessUI = Object.assign({}, global.RendererWebAccessUI || {}, {
    loadWebUrl: loadWebUrl,
    copyWebUrl: copyWebUrl,
    refreshWebServerStatus: refreshWebServerStatus,
    toggleWebServerEnabled: toggleWebServerEnabled,
    refreshTunnelStatus: refreshTunnelStatus,
    toggleTunnelEnabled: toggleTunnelEnabled,
    copyTunnelUrl: copyTunnelUrl,
    copyTunnelLog: copyTunnelLog,
    saveWebPassword: saveWebPassword,
  });

  // ===== menu-actions.js =====
  function closeAllMenus() {
    document.querySelectorAll('.dropdown-menu').forEach(function (d) {
      d.classList.remove('show');
    });
    document.querySelectorAll('.titlebar-menu-item').forEach(function (d) {
      d.classList.remove('open');
    });
  }

  async function menuAction(action, options) {
    options = options || {};
    var api = options.api || null;
    var onHandleAddFolder = options.onHandleAddFolder;
    var onCycleUiThemePreset = options.onCycleUiThemePreset;
    var onToggleChromeCollapsed = options.onToggleChromeCollapsed;
    var appAlert = options.appAlert || function () {};

    closeAllMenus();

    switch (action) {
      case 'addFolder':
        if (typeof onHandleAddFolder === 'function') onHandleAddFolder();
        break;
      case 'hideToTray':
        if (api && api.has && api.has('toggleBackgroundWindow')) api.toggleBackgroundWindow();
        else if (api) api.closeWindow();
        break;
      case 'quitApp':
        if (api && api.has && api.has('quitAppCompletely')) api.quitAppCompletely();
        break;
      case 'close':
        if (api) api.closeWindow();
        break;
      case 'fullscreen':
        document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        break;
      case 'devtools':
        if (api && api.has && api.has('toggleDevTools')) api.toggleDevTools();
        break;
      case 'cycleUiThemePreset':
        if (typeof onCycleUiThemePreset === 'function') await onCycleUiThemePreset();
        break;
      case 'about':
        await appAlert(
          '拂晓图库 v1.0.1\n\n一款轻量级的本地照片管理工具\n支持百万级照片浏览与检索\n\n作者：拂晓AI\nhttps://foredawn.vip/',
          '关于',
        );
        break;
      case 'shortcuts':
        await appAlert(
          '浏览（主界面）\n\n' +
            'Ctrl + Q — 隐藏窗口到系统托盘后台 / 再次按下恢复显示（全局快捷键；使用 Control 键，macOS 上不会占用 Cmd+Q 退出）\n' +
            '标题栏 ✕ / Alt+F4：由「管理设置 → 关闭按钮」决定：可每次询问（主题化弹窗）、直接托盘或直接退出。\n' +
            '询问弹窗内可勾选「设为默认」。文件菜单「隐藏到托盘」「退出拂晓图库」不受此项影响。\n' +
            'Ctrl + B — 简洁界面：收起或展开侧栏、顶栏与任务条（桌面端）\n' +
            '网格中收藏按钮在鼠标悬停到缩略图上时显示；触控屏上始终显示。\n\n' +
            '预览快捷键\n\n' +
            'Esc — 关闭预览\n' +
            '← / → — 上一张 / 下一张\n' +
            '空格 — 播放 / 暂停幻灯片\n' +
            'Delete — 删除到回收站\n' +
            'F — 收藏 / 取消收藏\n' +
            '0 — 重置缩放与旋转\n' +
            '+ / − — 放大 / 缩小\n' +
            'R — 顺时针旋转 90°（仅显示，不写文件）\n' +
            'Home / End — 当前列表首张 / 末张\n' +
            'O — 用系统默认程序打开当前图\n' +
            'Ctrl + 滚轮 — 缩放图片\n\n' +
            '菜单「查看」可切换到下一套界面风格。',
          '快捷键',
        );
        break;
      case 'toggleChromeCollapsed':
        if (typeof onToggleChromeCollapsed === 'function') onToggleChromeCollapsed();
        break;
    }
  }

  global.RendererMenuActions = Object.assign({}, global.RendererMenuActions || {}, {
    menuAction: menuAction,
  });

  // ===== appearance-ui.js =====
  var UI_ACCENT_ALLOWED = ['violet', 'cyan', 'teal', 'rose', 'amber', 'mono'];
  var UI_BG_ALLOWED = ['default', 'ink', 'warm', 'cool', 'amoled'];

  /** 界面风格（id 与主进程 THEME_STYLE_PRESETS、#settingThemeStyle 一致） */
  var UI_THEME_PRESETS = [
    { id: 'midnight_classic', label: '夜幕经典' },
    { id: 'ice_deep', label: '深空冰蓝' },
    { id: 'amber_dawn', label: '晨光琥珀' },
    { id: 'sky_light', label: '晴空浅蓝' },
    { id: 'cherry_blossom', label: '樱雾粉昼' },
    { id: 'arctic_mint', label: '薄荷极光' },
  ];

  function getDefaultThemeStyleId() {
    return UI_THEME_PRESETS[0] && UI_THEME_PRESETS[0].id
      ? UI_THEME_PRESETS[0].id
      : 'midnight_classic';
  }

  function getThemePresets() {
    return UI_THEME_PRESETS.slice();
  }

  function normalizeThemeStyle(id) {
    if (id && typeof id === 'string') {
      for (var ni = 0; ni < UI_THEME_PRESETS.length; ni++) {
        if (UI_THEME_PRESETS[ni].id === id) return id;
      }
    }
    return getDefaultThemeStyleId();
  }

  function normalizeUiAccent(a) {
    return UI_ACCENT_ALLOWED.indexOf(a) >= 0 ? a : 'violet';
  }

  function normalizeUiBackground(b) {
    return UI_BG_ALLOWED.indexOf(b) >= 0 ? b : 'default';
  }

  /** 与 index.html 内联脚本共用，用于启动首帧即匹配上次外观，避免先默认主题再闪切 */
  var APPEARANCE_SNAPSHOT_LS_KEY = 'photoManager.appearanceSnapshot.v1';

  /** 根据完整设置同步 html 的 data-theme / data-accent / data-bg */
  function syncAppearanceFromSettings(s) {
    if (!s) s = {};
    var theme = s.theme === 'light' ? 'light' : 'dark';
    var accent = normalizeUiAccent(s.uiAccent);
    var bg = normalizeUiBackground(s.uiBackground);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-accent', accent);
    if (bg === 'default') document.documentElement.removeAttribute('data-bg');
    else document.documentElement.setAttribute('data-bg', bg);
    try {
      localStorage.setItem(
        APPEARANCE_SNAPSHOT_LS_KEY,
        JSON.stringify({ theme: theme, uiAccent: accent, uiBackground: bg }),
      );
    } catch (e) {}
  }

  global.RendererAppearanceUI = Object.assign({}, global.RendererAppearanceUI || {}, {
    getDefaultThemeStyleId: getDefaultThemeStyleId,
    getThemePresets: getThemePresets,
    normalizeThemeStyle: normalizeThemeStyle,
    normalizeUiAccent: normalizeUiAccent,
    normalizeUiBackground: normalizeUiBackground,
    syncAppearanceFromSettings: syncAppearanceFromSettings,
    APPEARANCE_SNAPSHOT_LS_KEY: APPEARANCE_SNAPSHOT_LS_KEY,
  });

  // ===== background-tasks-orchestrator.js =====
  function scheduleNextBackgroundTaskPoll(options) {
    options = options || {};
    var state = options.state || {};
    var delayMs = options.delayMs;
    var activeMs = options.activeMs;
    var idleMs = options.idleMs;
    var onTick = options.onTick;

    if (!state.bgTaskPollingStarted) return;
    var nextDelay =
      typeof delayMs === 'number' ? delayMs : state.bgTaskHasActive ? activeMs : idleMs;
    if (state.bgTaskTimer) {
      clearTimeout(state.bgTaskTimer);
      state.bgTaskTimer = null;
    }
    state.bgTaskTimer = setTimeout(function () {
      state.bgTaskTimer = null;
      if (typeof onTick === 'function') onTick();
    }, nextDelay);
  }

  async function tickBackgroundTasksOnce(options) {
    options = options || {};
    var scanFlow = options.scanFlow || {};
    if (typeof scanFlow.tickBackgroundTasksOnce !== 'function') return;
    return scanFlow.tickBackgroundTasksOnce(options);
  }

  global.RendererBackgroundTasksOrchestrator = Object.assign(
    {},
    global.RendererBackgroundTasksOrchestrator || {},
    {
      scheduleNextBackgroundTaskPoll: scheduleNextBackgroundTaskPoll,
      tickBackgroundTasksOnce: tickBackgroundTasksOnce,
    },
  );
})(window);
