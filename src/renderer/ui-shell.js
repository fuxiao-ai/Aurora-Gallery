(function (global) {
  'use strict';

  function tShell(key, zh) {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
    return zh;
  }

  // ===== sidebar-resizer.js =====
  /**
   * 侧栏宽度拖拽。契约（改动前先读）：
   *
   * 1. **move/up 必须挂在 window（或已捕获指针的元素）上，绝不能在 resizer 自己身上收尾。**
   *    旧实现在 resizer 上听 `mouseleave` 当拖拽结束 —— 热区只有十几像素宽，光标横向一动就
   *    离开，于是「拖了 5px 就断」。现在 pointerdown 时同时挂 window 兜底监听 + 尝试
   *    `setPointerCapture`（捕获失败也不影响，两条链路都收得到事件；moveDrag 幂等）。
   *    无 PointerEvent 的环境退回 window 上的 mouse 监听。
   *
   * 2. **pointermove 直接落样式，不要再包一层 requestAnimationFrame。** 浏览器本来就把
   *    move 合并成「每帧一条」，而 rAF 在窗口被遮挡/后台时会被降频 —— 那样会出现
   *    「拖的时候纹丝不动、松手才跳一下」。夹取后没有变化就跳过去，避免无意义的重算。
   *
   * 3. **拖动结果（意图值）必须夹回上限再持久化。** 否则拉到上限还继续往右拖时，多出来的
   *    位移会成为「死行程」：松手后往左拖几十像素侧栏一动不动。
   *
   * 4. **上限随视口收敛**：保证浏览区至少 `SIDEBAR_CONTENT_MIN` 宽。CSS 侧
   *    `.sidebar { max-width: var(--sidebar-max-width, 720px) }` 与这里的计算必须同源，
   *    否则「变量写了 700、元素被 CSS 卡在 480」。
   */
  var SIDEBAR_WIDTH_STORAGE_KEY = 'pm_sidebar_width_px';
  var SIDEBAR_WIDTH_DEFAULT = 260;
  var SIDEBAR_WIDTH_MIN = 200;
  var SIDEBAR_WIDTH_MAX = 720;
  /**
   * 浏览区保底宽度：拖拽上限据此收敛。
   * 注意要**减掉左侧图标栏**（`.main-layout > .app-rail`，约 66–76px，窄屏变 60px），
   * 否则「视口 900 − 上限 480 = 420」看着达标，实际浏览区只剩 344。
   */
  var SIDEBAR_CONTENT_MIN = 420;
  var APP_RAIL_FALLBACK = 76;
  var SIDEBAR_KEY_STEP = 16;
  var SIDEBAR_KEY_STEP_LARGE = 64;

  /** 当前视口下允许的最大侧栏宽度 */
  function sidebarWidthMax() {
    var vw = window.innerWidth || 0;
    if (!vw) return SIDEBAR_WIDTH_MAX;
    var rail = document.querySelector ? document.querySelector('.main-layout > .app-rail') : null;
    var railWidth = APP_RAIL_FALLBACK;
    if (rail && typeof rail.getBoundingClientRect === 'function') {
      var rw = Math.round(rail.getBoundingClientRect().width);
      if (rw > 0) railWidth = rw;
    }
    var room = vw - railWidth - SIDEBAR_CONTENT_MIN;
    // 下限取侧栏自己的 min-width：比它还小的上限没有意义（元素会停在 200）
    return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, room));
  }

  function clampSidebarWidth(px) {
    var w = Math.round(Number(px));
    if (!isFinite(w)) w = SIDEBAR_WIDTH_DEFAULT;
    return Math.max(SIDEBAR_WIDTH_MIN, Math.min(sidebarWidthMax(), w));
  }

  /** 侧栏当前渲染宽度（拿不到时回落到 CSS 变量） */
  function readSidebarWidth() {
    var side = document.getElementById('sidebar');
    if (side) {
      var w = Math.round(side.getBoundingClientRect().width);
      if (w > 0) return w;
    }
    var raw = parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'),
    );
    return isFinite(raw) && raw > 0 ? Math.round(raw) : SIDEBAR_WIDTH_DEFAULT;
  }

  function applySidebarWidth(px) {
    var root = document.documentElement;
    var max = sidebarWidthMax();
    var w = clampSidebarWidth(px);
    root.style.setProperty('--sidebar-max-width', max + 'px');
    root.style.setProperty('--sidebar-width', w + 'px');
    return w;
  }

  function initSidebarResizer() {
    var resizer = document.getElementById('sidebarResizer');
    if (!resizer) return;
    var docEl = document.documentElement;

    /** 已持久化的宽度（意图值，始终落在 [MIN, 当前上限] 内） */
    var preferredWidth = SIDEBAR_WIDTH_DEFAULT;
    try {
      var saved = parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY), 10);
      if (isFinite(saved) && saved > 0) preferredWidth = saved;
    } catch (e) {}

    var dragging = false;
    var activePointerId = null;
    var startX = 0;
    var startWidth = 0;
    var pendingX = 0;
    /** 上次真正写进 CSS 变量的宽度，用来跳过去重（避免没变化也触发样式重算） */
    var lastApplied = -1;

    lastApplied = applySidebarWidth(preferredWidth);

    function canResize() {
      // ≤600px 侧栏变成抽屉（CSS 里 display:none / mobile-show），拖拽无意义
      if (window.innerWidth <= 600) return false;
      var side = document.getElementById('sidebar');
      return !!side && window.getComputedStyle(side).display !== 'none';
    }

    function syncResizerAria() {
      if (typeof resizer.setAttribute !== 'function') return;
      resizer.setAttribute('aria-valuenow', String(readSidebarWidth()));
      resizer.setAttribute('aria-valuemin', String(SIDEBAR_WIDTH_MIN));
      resizer.setAttribute('aria-valuemax', String(sidebarWidthMax()));
    }

    function beginDrag(clientX) {
      if (!canResize()) return false;
      dragging = true;
      startX = clientX;
      pendingX = clientX;
      startWidth = readSidebarWidth();
      lastApplied = startWidth;
      docEl.classList.add('sidebar-resizing');
      resizer.classList.add('is-dragging');
      return true;
    }

    function moveDrag(clientX) {
      if (!dragging) return;
      pendingX = clientX;
      var next = clampSidebarWidth(startWidth + (pendingX - startX));
      // 逐条 move 直接落样式：浏览器本来就把 pointermove 合并到「每帧一条」，
      // 再包一层 requestAnimationFrame 只会在窗口被遮挡（rAF 被降频）时变成
      // 「拖的时候纹丝不动、松手才跳一下」。夹取后没变化就跳过，省一次样式重算。
      if (next !== lastApplied) {
        lastApplied = next;
        applySidebarWidth(next);
      }
    }

    function persistSidebarWidth(px) {
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(px));
      } catch (e) {}
    }

    /** 双击 / 键盘的统一出口：夹取 → 落样式 → 持久化 → 同步 a11y 数值 */
    function commitWidth(px) {
      preferredWidth = clampSidebarWidth(px);
      lastApplied = applySidebarWidth(preferredWidth);
      persistSidebarWidth(preferredWidth);
      syncResizerAria();
      return preferredWidth;
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      // 用「起点 + 总位移」重算一次：不依赖中途是否丢过 move
      var want = startWidth + (pendingX - startX);
      docEl.classList.remove('sidebar-resizing');
      resizer.classList.remove('is-dragging');
      // 关键：把意图值也夹回上限。否则拉到上限还继续往右拖时，多出来的位移会变成
      // 「死行程」—— 松手后往左拖几十像素，侧栏一动不动。
      commitWidth(want);
      // 窗口没 resize，但浏览区宽度变了：通知只监听 window.resize 的组件
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (e3) {}
    }

    if (typeof window.PointerEvent === 'function') {
      /**
       * 拖拽期间在 window 上挂一份兜底监听，并在结束时摘掉。
       * 只靠 `setPointerCapture` 是不够的：它可能直接抛错（指针不再 active / 合成事件 /
       * 某些 webview），此时 move 事件不会再落到 resizer 上 —— 症状是「按下后宽度纹丝不动，
       * 松开也没反应」，而不是报错。捕获成功时这两条链路会同时收到事件，moveDrag 幂等，
       * 多收一次无害。
       */
      var winMove = function (e) {
        if (!dragging) return;
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        moveDrag(e.clientX);
      };
      var winUp = function (e) {
        if (!dragging) return;
        if (activePointerId != null && e.pointerId !== activePointerId) return;
        activePointerId = null;
        detachDragWindowListeners();
        endDrag();
      };
      var detachDragWindowListeners = function () {
        window.removeEventListener('pointermove', winMove, true);
        window.removeEventListener('pointerup', winUp, true);
        window.removeEventListener('pointercancel', winUp, true);
      };
      var attachDragWindowListeners = function () {
        window.addEventListener('pointermove', winMove, true);
        window.addEventListener('pointerup', winUp, true);
        window.addEventListener('pointercancel', winUp, true);
      };

      resizer.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 && e.pointerType !== 'touch') return;
        if (!beginDrag(e.clientX)) return;
        e.preventDefault();
        attachDragWindowListeners();
        activePointerId = e.pointerId;
        try {
          resizer.setPointerCapture(e.pointerId);
        } catch (eCap) {
          // 捕获失败不影响拖拽：window 兜底监听已经在收事件了
          activePointerId = e.pointerId;
        }
      });
      resizer.addEventListener('lostpointercapture', function () {
        if (!dragging) return;
        detachDragWindowListeners();
        endDrag();
      });
    } else {
      var winMouseMove = function (e) {
        moveDrag(e.clientX);
      };
      var winMouseUp = function () {
        window.removeEventListener('mousemove', winMouseMove, true);
        window.removeEventListener('mouseup', winMouseUp, true);
        endDrag();
      };
      resizer.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        if (!beginDrag(e.clientX)) return;
        e.preventDefault();
        // move/up **必须挂 window**：热区只有 14px 宽，挂在 resizer 上光标一动就丢事件
        window.addEventListener('mousemove', winMouseMove, true);
        window.addEventListener('mouseup', winMouseUp, true);
      });
    }

    // 双击复位（配合键盘，给「拉歪了」一个一键回退）
    resizer.addEventListener('dblclick', function () {
      commitWidth(SIDEBAR_WIDTH_DEFAULT);
    });

    // 键盘：←/→ 微调（Shift 大步）、Home/End 到两端、Enter/Space 复位
    resizer.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? SIDEBAR_KEY_STEP_LARGE : SIDEBAR_KEY_STEP;
      var next = null;
      if (e.key === 'ArrowLeft') next = readSidebarWidth() - step;
      else if (e.key === 'ArrowRight') next = readSidebarWidth() + step;
      else if (e.key === 'Home') next = SIDEBAR_WIDTH_MIN;
      else if (e.key === 'End') next = sidebarWidthMax();
      else if (e.key === 'Enter' || e.key === ' ') next = SIDEBAR_WIDTH_DEFAULT;
      if (next == null) return;
      e.preventDefault();
      commitWidth(next);
    });

    // 视口变化：上限变了要重新夹取（但用户意图值保留）
    window.addEventListener('resize', function () {
      applySidebarWidth(preferredWidth);
      syncResizerAria();
    });

    syncResizerAria();
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
      if (window.I18n && typeof window.I18n.t === 'function') {
        btn.textContent = collapsed ? window.I18n.t('task.expand') : window.I18n.t('task.collapse');
      } else {
        btn.textContent = collapsed
          ? tShell('task.expand', '展开')
          : tShell('task.collapse', '收起');
      }
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
  function tNet(key, zh) {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
    return zh;
  }
  function tNetFmt(key, map, zhFallback) {
    var s = tNet(key, zhFallback);
    if (!map) return s;
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        s = s.split('{' + k + '}').join(String(map[k]));
      }
    }
    return s;
  }

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

  /**
   * 设置页「网络与远程」面板里的手机扫码二维码。
   *
   * 🔴 载荷的唯一来源 = `state.webUrl` —— 与「点击复制」（`copyWebUrl`）读的是**同一个字段**。
   *    两处各算一遍地址必然漂移，症状是「扫码装不上、复制却能用」，且不报错、不告警。
   * 🔴 只在「已开启 + 正在运行 + 地址非空」时画码，其余一律清空并整块 `hidden`：
   *    一个指向已关闭服务的旧码比没有码更糟（用户扫了打不开，只会以为软件坏了）。
   * 🔴 载荷里绝不拼访问密码（本面板任何位置都不显示密码）。
   */
  function renderWebQr(url) {
    var box = document.getElementById('webQrBox');
    var img = document.getElementById('webQrImg');
    if (!box || !img) return false;
    var payload = String(url == null ? '' : url).trim();
    var qrCode = global.RendererQrCode;
    var dataUrl = payload && qrCode
      ? qrCode.createDataUrl(payload, { cellSize: 4 })
      : '';
    if (!dataUrl) {
      img.removeAttribute('src');
      box.hidden = true;
      return false;
    }
    img.src = dataUrl;
    box.hidden = false;
    return true;
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
      // 拿不到服务状态 ⇒ 无从判断这个地址是否还活着 ⇒ 不画码（宁缺勿错）。
      renderWebQr('');
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
        stEl.textContent = enabled
          ? running
            ? tNet('settings.network.statusOn', '运行')
            : tNet('settings.network.statusNotReady', '未就绪')
          : tNet('settings.network.urlWhenOff', '未开启');
        stEl.classList.remove('online', 'offline');
        stEl.classList.add(enabled && running ? 'online' : 'offline');
      }
      if (enabled && url) {
        state.webUrl = url;
        if (urlEl) urlEl.textContent = url;
      } else if (urlEl) {
        urlEl.textContent = tNet('settings.network.urlWhenOff', '未开启');
      }
      // 二维码跟着同一个判据走：地址「可用」才画，否则清掉（含 enabled 开着但未就绪）。
      renderWebQr(enabled && running ? url : '');
    } catch (e) {
      if (stEl) {
        stEl.textContent = tNet('settings.network.readError', '读取失败');
        stEl.classList.remove('online');
        stEl.classList.add('offline');
      }
      renderWebQr('');
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
        appAlert(
          tNetFmt(
            'settings.network.webToggleFail',
            { error: (r && r.error) || tNet('settings.common.unknownError', '未知错误') },
            '局域网访问开关操作失败：' + ((r && r.error) || '未知错误'),
          ),
        );
        if (sw) sw.checked = !enabled;
      }
    } catch (e) {
      appAlert(
        tNetFmt(
          'settings.network.webToggleFail',
          { error: e && e.message ? e.message : String(e) },
          '局域网访问开关操作失败：' + (e && e.message ? e.message : String(e)),
        ),
      );
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
          copyEl.textContent = tNet('settings.network.copied', '已复制！');
          setTimeout(function () {
            copyEl.textContent = tNet('settings.network.copy', '点击复制');
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
        copyEl.textContent = tNet('settings.network.copied', '已复制！');
        setTimeout(function () {
          copyEl.textContent = tNet('settings.network.copy', '点击复制');
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
      var statusLabel = tNet('settings.network.tunnelOff', '未开启');
      if (!isEnabled) {
        statusLabel = tNet('settings.network.tunnelOff', '未开启');
      } else if (statusRaw === 'running') {
        statusLabel = tNet('settings.network.tunnelRunning', '运行中');
      } else if (statusRaw === 'starting') {
        statusLabel = tNet('settings.network.tunnelStarting', '启动中');
      } else if (statusRaw === 'error') {
        statusLabel = tNet('settings.network.tunnelError', '异常');
      } else {
        statusLabel = tNet('settings.network.tunnelPending', '待就绪');
      }
      if (stEl) {
        stEl.textContent = statusLabel;
        stEl.classList.remove('online', 'offline');
        stEl.classList.add(isEnabled && statusRaw === 'running' ? 'online' : 'offline');
      }
      if (urlEl) urlEl.textContent = s.url || tNet('settings.network.tunnelUrlPending', '未获取');
      if (binEl) {
        if (s && s.binaryPath) {
          var src = String(s.binaryPath || '');
          binEl.textContent = tNetFmt(
            'settings.network.tunnelBinaryFmt',
            { path: src },
            'cloudflared：' + src,
          );
        } else {
          binEl.textContent = tNet('settings.network.tunnelBinaryNotFound', 'cloudflared：未找到');
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
        stEl.textContent = tNet('settings.network.readError', '读取失败');
        stEl.classList.remove('online');
        stEl.classList.add('offline');
      }
      if (binEl)
        binEl.textContent = tNet('settings.network.tunnelBinaryReadError', 'cloudflared：读取失败');
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
      appAlert(tNet('settings.network.tunnelPwdFirst', '请先设置网页访问密码，再开启 Tunnel。'));
      if (sw) sw.checked = false;
      return;
    }
    if (enabled && !state.hasWebPassword && hasPwdTyped) {
      appAlert(
        tNet(
          'settings.network.tunnelApplyPwdFirst',
          '请先点击「确认应用」保存访问密码，再开启 Tunnel。',
        ),
      );
      if (sw) sw.checked = false;
      return;
    }
    if (sw) sw.dataset.syncing = '1';
    var r = await api.tunnelSetEnabled(!!enabled);
    if (!r || !r.success) {
      appAlert(
        tNetFmt(
          'settings.network.tunnelToggleFail',
          { error: (r && r.error) || tNet('settings.common.unknownError', '未知错误') },
          'Tunnel 操作失败：' + ((r && r.error) || '未知错误'),
        ),
      );
      if (sw) sw.checked = !enabled;
    }
    if (sw) delete sw.dataset.syncing;
    onRefreshTunnelStatus();
  }

  function copyTunnelUrl() {
    var textEl = document.getElementById('tunnelUrlText');
    var copyEl = document.getElementById('tunnelUrlCopy');
    var u = textEl ? String(textEl.textContent || '') : '';
    var pending = tNet('settings.network.tunnelUrlPending', '未获取');
    if (!u || u === pending) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(u).then(function () {
        if (copyEl) {
          copyEl.textContent = tNet('settings.network.copied', '已复制！');
          setTimeout(function () {
            copyEl.textContent = tNet('settings.network.copy', '点击复制');
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
          btn.textContent = tNet('settings.network.logCopied', '已复制');
          setTimeout(function () {
            btn.textContent = old || tNet('settings.network.tunnelCopyLog', '复制日志');
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
      saveLastSettingsSectionId('settingsSectionAppearance');
      if (typeof getCurrentTab === 'function' ? getCurrentTab() === 'settings' : false)
        onRenderSettingsNav('settingsSectionAppearance');
      appAlert(
        newPwd
          ? tNet('settings.network.passwordSaved', '访问密码已设置')
          : tNet('settings.network.passwordCleared', '访问密码已清除'),
      );
      onRefreshTunnelStatus();
    } catch (e) {
      appAlert(
        tNetFmt(
          'settings.network.passwordSaveFail',
          { error: e && e.message ? e.message : String(e) },
          '保存访问密码失败：' + (e && e.message ? e.message : String(e)),
        ),
      );
    }
  }

  global.RendererWebAccessUI = Object.assign({}, global.RendererWebAccessUI || {}, {
    loadWebUrl: loadWebUrl,
    copyWebUrl: copyWebUrl,
    renderWebQr: renderWebQr,
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

  function tMenu(key, zhFallback) {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
    return zhFallback;
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
          tMenu('help.aboutBody', '拂晓图库\n\n一款轻量级的本地相册应用（本地优先，索引与媒体保存在本机）\n支持百万级图片浏览与检索\n\n作者：拂晓AI\nhttps://foredawn.vip/'),
          tMenu('help.aboutTitle', '关于'),
        );
        break;
      case 'shortcuts':
        await appAlert(
          tMenu(
            'help.shortcutsBody',
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
          ),
          tMenu('help.shortcutsTitle', '快捷键'),
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
  // ⚠️ 与 src/main.js 的 UI_ACCENT_ALLOWED / UI_BG_ALLOWED 逐位一致（theme-regression 断言）。
  var UI_ACCENT_ALLOWED = [
    'violet',
    'cyan',
    'teal',
    'rose',
    'amber',
    'mono',
    'coral',
    'indigo',
    'green',
    'red',
  ];
  var UI_BG_ALLOWED = [
    'default',
    'ink',
    'warm',
    'cool',
    'amoled',
    'glass',
    'aurora',
    'paper',
    'mist',
    'forest',
    'clay',
  ];
  // 第三维：材质纹理。`none` 不设属性（同 data-bg 的 default），见 styles.css 的 body::after 段。
  var UI_TEXTURE_ALLOWED = ['none', 'grain', 'paper', 'linen', 'frost', 'grid', 'dots', 'stripe', 'wood'];
  /** 面板透明度（第五维）。⚠️ 与主进程 `UI_OPACITY_ALLOWED` 逐项一致（theme-regression 断言） */
  var UI_OPACITY_ALLOWED = ['opaque', 'slight', 'medium', 'clear'];
  /**
   * 窗口背景（窗口级开关）。⚠️ 与主进程 `UI_WINDOW_BACKDROP_ALLOWED` 逐项一致。
   *
   * 语义：'solid' = 不设属性（窗口不透明，默认外观逐字节不变）；另外三档都设
   * `data-window-backdrop="<档位名>"`，让 body 与界面框架带上 alpha，透出被系统模糊的桌面。
   * 三档是**同一材质、不同透过度**（`acrylic-light` < `acrylic` < `acrylic-strong`，程度递增），
   * 差别**只在 styles.css 里 body 那层的 alpha**（面板那一侧三档完全一致）。
   * 🔴 `acrylic` 必须留着且行为一字不改：它是扩档前唯一的值，用户设置里存的就是它。
   *
   * 🔴 这里**只负责渲染层那一半**：窗口本身是否 `transparent` 由主进程建窗时决定，
   *    且**运行期改不了** → 改这一档必须重启。两半必须同时成立，缺一半就是「全黑」或
   *    「界面自己透不出来」的怪相。
   * 🔴 它与其余五维一样**不被任何预设使用**，但**不进顶栏 `#quickThemeStyle`** ——
   *    那一栏是「划过即预览」，而这一维重启前不可能预览，放进去就是假承诺。
   *    所以它没有 `windowbackdrop:` 前缀、没有 optgroup、也不出现在触发按钮的后缀里。
   */
  var UI_WINDOW_BACKDROP_ALLOWED = ['solid', 'acrylic-light', 'acrylic', 'acrylic-strong'];

  /**
   * 界面风格预设（id 与主进程 THEME_STYLE_PRESETS、`#settingThemeStyle` 一致）。
   * ⚠️ 每条的三元组必须与 `src/main.js` 的 THEME_STYLE_PRESETS **逐位相同**（`theme-regression` 比对两边源码）。
   * 预设只是「快捷组合」：强调色与背景基调现在可以各自独立选，此时三元组凑不出任何预设，
   * themeStyle 就是空串（下拉显示「自定义组合」），见 normalizeThemeStyle / inferThemeStyleFromTriple。
   */
  var UI_THEME_PRESETS = [
    {
      id: 'midnight_classic',
      label: '夜幕经典',
      theme: 'dark',
      uiAccent: 'violet',
      uiBackground: 'default',
    },
    {
      id: 'ice_deep',
      label: '深空冰蓝',
      theme: 'dark',
      uiAccent: 'cyan',
      uiBackground: 'amoled',
    },
    {
      id: 'amber_dawn',
      label: '晨光琥珀',
      theme: 'dark',
      uiAccent: 'amber',
      uiBackground: 'warm',
    },
    {
      id: 'forest_shadow',
      label: '森影暮霭',
      theme: 'dark',
      uiAccent: 'teal',
      uiBackground: 'cool',
    },
    {
      id: 'ember_night',
      label: '暗夜余烬',
      theme: 'dark',
      uiAccent: 'rose',
      uiBackground: 'ink',
    },
    {
      id: 'graphite_night',
      label: '石墨夜色',
      theme: 'dark',
      uiAccent: 'mono',
      uiBackground: 'default',
    },
    {
      id: 'nebula_violet',
      label: '星云紫夜',
      theme: 'dark',
      uiAccent: 'violet',
      uiBackground: 'ink',
    },
    {
      id: 'pine_abyss',
      label: '松渊墨绿',
      theme: 'dark',
      uiAccent: 'teal',
      uiBackground: 'default',
    },
    {
      id: 'mocha_night',
      label: '摩卡夜色',
      theme: 'dark',
      uiAccent: 'amber',
      uiBackground: 'ink',
    },
    {
      id: 'glass_night',
      label: '玻璃夜色',
      theme: 'dark',
      uiAccent: 'violet',
      uiBackground: 'glass',
    },
    {
      id: 'aurora_night',
      label: '渐变夜幕',
      theme: 'dark',
      uiAccent: 'teal',
      uiBackground: 'aurora',
    },
    {
      id: 'sky_light',
      label: '晴空浅蓝',
      theme: 'light',
      uiAccent: 'cyan',
      uiBackground: 'ink',
    },
    {
      id: 'cherry_blossom',
      label: '樱雾粉昼',
      theme: 'light',
      uiAccent: 'rose',
      uiBackground: 'warm',
    },
    {
      id: 'lavender_dusk',
      label: '暮紫微光',
      theme: 'light',
      uiAccent: 'violet',
      uiBackground: 'warm',
    },
    {
      id: 'arctic_mint',
      label: '薄荷极光',
      theme: 'light',
      uiAccent: 'teal',
      uiBackground: 'cool',
    },
    {
      id: 'desert_sand',
      label: '暖沙晨曦',
      theme: 'light',
      uiAccent: 'amber',
      uiBackground: 'default',
    },
    {
      id: 'paper_gray',
      label: '素纸浅灰',
      theme: 'light',
      uiAccent: 'mono',
      uiBackground: 'amoled',
    },
    {
      id: 'sage_morning',
      label: '鼠尾草晨雾',
      theme: 'light',
      uiAccent: 'teal',
      uiBackground: 'default',
    },
    {
      id: 'apricot_haze',
      label: '杏色薄雾',
      theme: 'light',
      uiAccent: 'amber',
      uiBackground: 'ink',
    },
    {
      id: 'frost_cyan',
      label: '霜青微光',
      theme: 'light',
      uiAccent: 'cyan',
      uiBackground: 'cool',
    },
    {
      id: 'glass_day',
      label: '玻璃白昼',
      theme: 'light',
      uiAccent: 'cyan',
      uiBackground: 'glass',
    },
    {
      id: 'aurora_dawn',
      label: '渐变晨曦',
      theme: 'light',
      uiAccent: 'violet',
      uiBackground: 'aurora',
    },
  ];

  function getDefaultThemeStyleId() {
    return UI_THEME_PRESETS[0] && UI_THEME_PRESETS[0].id
      ? UI_THEME_PRESETS[0].id
      : 'midnight_classic';
  }

  function getThemePresets() {
    return UI_THEME_PRESETS.slice();
  }

  /**
   * 预设 id 原样返回；**空串 = 自定义组合**（三元组凑不出任何预设，下拉显示「自定义组合」）；
   * 其余非法值（含 undefined / null）回落默认预设。
   */
  function normalizeThemeStyle(id) {
    if (id === '') return '';
    if (id && typeof id === 'string') {
      for (var ni = 0; ni < UI_THEME_PRESETS.length; ni++) {
        if (UI_THEME_PRESETS[ni].id === id) return id;
      }
    }
    return getDefaultThemeStyleId();
  }

  /** 预设 id → 三元组；未知 id（含空串）返回 null —— 自定义组合没有对应预设 */
  function resolveThemeTriple(id) {
    for (var ri = 0; ri < UI_THEME_PRESETS.length; ri++) {
      var p = UI_THEME_PRESETS[ri];
      if (p.id === id) {
        return { theme: p.theme, uiAccent: p.uiAccent, uiBackground: p.uiBackground };
      }
    }
    return null;
  }

  /** 三元组 → 预设 id；凑不出返回空串。与主进程 inferThemeStyleFromTriple 同语义 */
  function inferThemeStyleFromTriple(theme, accent, bg) {
    var t = theme === 'light' ? 'light' : 'dark';
    for (var ii = 0; ii < UI_THEME_PRESETS.length; ii++) {
      var q = UI_THEME_PRESETS[ii];
      if (q.theme === t && q.uiAccent === accent && q.uiBackground === bg) return q.id;
    }
    return '';
  }

  function normalizeUiAccent(a) {
    return UI_ACCENT_ALLOWED.indexOf(a) >= 0 ? a : 'violet';
  }

  function normalizeUiBackground(b) {
    return UI_BG_ALLOWED.indexOf(b) >= 0 ? b : 'default';
  }

  function normalizeUiTexture(t) {
    return UI_TEXTURE_ALLOWED.indexOf(t) >= 0 ? t : 'none';
  }

  function normalizeUiOpacity(o) {
    return UI_OPACITY_ALLOWED.indexOf(o) >= 0 ? o : 'opaque';
  }

  function normalizeUiWindowBackdrop(b) {
    return UI_WINDOW_BACKDROP_ALLOWED.indexOf(b) >= 0 ? b : 'solid';
  }

  /** 与 index.html 内联脚本共用，用于启动首帧即匹配上次外观，避免先默认主题再闪切 */
  var APPEARANCE_SNAPSHOT_LS_KEY = 'photoManager.appearanceSnapshot.v1';

  /**
   * 根据完整设置同步 html 的 data-theme / data-accent / data-bg / data-texture / data-opacity。
   *
   * 🔴 `options.skipSnapshot` —— 顶栏「鼠标悬浮预览主题」专用。默认会把当前三元组写进
   * localStorage 快照（`APPEARANCE_SNAPSHOT_LS_KEY`，index.html 首帧内联脚本读它来避免
   * 「先默认主题再闪切」）。但预览是**临时**状态：用户只是把鼠标扫过弹层里的主题项，
   * 并没有真的选择。若走默认分支，扫过 18 项就会把快照写成最后扫到的那个主题 ——
   * 此刻刷新或崩溃，启动首帧就停在一个用户从未选定的主题上。
   * 所以预览必须传 `{ skipSnapshot: true }`：照样设属性（视觉完全一致），只是不落快照。
   * ⚠️ 别为预览另写一份属性写入逻辑 —— 那才是真正会漂移的地方（属性协议只此一处）。
   */
  function syncAppearanceFromSettings(s, options) {
    if (!s) s = {};
    var theme = s.theme === 'light' ? 'light' : 'dark';
    var accent = normalizeUiAccent(s.uiAccent);
    var bg = normalizeUiBackground(s.uiBackground);
    var texture = normalizeUiTexture(s.uiTexture);
    var opacity = normalizeUiOpacity(s.uiOpacity);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-accent', accent);
    if (bg === 'default') document.documentElement.removeAttribute('data-bg');
    else document.documentElement.setAttribute('data-bg', bg);
    // 纹理与背景基调同一惯例：关闭态**移除属性**而不是写 'none'，
    // 因为 styles.css 的关闭态判据是 :not([data-texture])（[data-texture='none'] 永不匹配）。
    if (texture === 'none') document.documentElement.removeAttribute('data-texture');
    else document.documentElement.setAttribute('data-texture', texture);
    // 透明度同理：`opaque` 档移除属性（CSS 侧一律带 `html[data-opacity]` 闸门，
    // 所以「不设属性」= 默认外观逐字节不变，这一点是回归护栏的判据）。
    if (opacity === 'opaque') document.documentElement.removeAttribute('data-opacity');
    else document.documentElement.setAttribute('data-opacity', opacity);
    /* 🔴 窗口背景（窗口级开关）的落法与前五维**不一样**，别照抄：
     *   前五维：属性 = 设置里的值，改完当帧就变。
     *   这一维：**属性只能跟「已生效值」走**。窗口是否透明是**建窗参数**、运行期改不了；
     *    若拿用户刚选的值去设属性，就会出现「窗口还是实色、body 却已经带上 alpha」→
     *    底色透到窗口自己的底板上，整个界面被洗白 —— 比「改了没生效」难看得多。
     *   所以判据是主进程直传的 `uiWindowBackdropApplied`（建这个窗口时真正用的那个值）。
     *   🔴 缺这个字段时**一个属性都不动**（不是回落成设置值）：悬浮预览的三元组、保存失败
     *    时的回滚对象都是本层自己拼的、都没有这个字段，一旦回落就会在那两条路径上把
     *    「亚克力」的窗口洗白。顺带这条也自动解决了「悬浮预览会把这一维弄丢」。
     */
    if (s.uiWindowBackdropApplied != null) {
      var appliedBackdrop = normalizeUiWindowBackdrop(s.uiWindowBackdropApplied);
      if (appliedBackdrop === 'solid') document.documentElement.removeAttribute('data-window-backdrop');
      else document.documentElement.setAttribute('data-window-backdrop', appliedBackdrop);
    }
    // 写进启动快照的是**用户选的值**（不是已生效值）：快照只服务「下一次启动的首帧」，
    // 而下一次启动会按用户选的值建窗 → 用已生效值会慢一帧（先按实色画一帧再变透）。
    var windowBackdrop = normalizeUiWindowBackdrop(s.uiWindowBackdrop);
    if (options && options.skipSnapshot) return;
    try {
      localStorage.setItem(
        APPEARANCE_SNAPSHOT_LS_KEY,
        JSON.stringify({
          theme: theme,
          uiAccent: accent,
          uiBackground: bg,
          uiTexture: texture,
          uiOpacity: opacity,
          uiWindowBackdrop: windowBackdrop,
        }),
      );
    } catch (e) {}
  }

  global.RendererAppearanceUI = Object.assign({}, global.RendererAppearanceUI || {}, {
    getDefaultThemeStyleId: getDefaultThemeStyleId,
    getThemePresets: getThemePresets,
    resolveThemeTriple: resolveThemeTriple,
    inferThemeStyleFromTriple: inferThemeStyleFromTriple,
    normalizeThemeStyle: normalizeThemeStyle,
    normalizeUiAccent: normalizeUiAccent,
    normalizeUiBackground: normalizeUiBackground,
    normalizeUiTexture: normalizeUiTexture,
    normalizeUiOpacity: normalizeUiOpacity,
    normalizeUiWindowBackdrop: normalizeUiWindowBackdrop,
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
