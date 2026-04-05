(function (global) {
  'use strict';

  /** 根目录很多时分帧插入行，减轻管理页长任务 */
  var SETTINGS_FOLDER_ROW_CHUNK = 40;
  var SETTINGS_FOLDER_ROW_RAF_THRESHOLD = 48;

  function tSet(key, zh) {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
    return zh;
  }

  // ===== settings-ui.js =====
  function renderSettingsNav(activeId, options) {
    options = options || {};
    var dom = options.dom || {};
    if (!dom.sidebarContent) return;
    var sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.style && sidebar.style.display === 'none') return;

    function navLabel(key, zh) {
      if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
      return zh;
    }
    var navItems = [
      { id: 'settingsSectionFolders', icon: '\u{1F4C1}', key: 'settings.nav.folders', zh: '相册目录' },
      { id: 'settingsSectionCloseBehavior', icon: '\u2716', key: 'settings.nav.close', zh: '关闭按钮' },
      { id: 'settingsSectionGeneral', icon: '\u2699\uFE0F', key: 'settings.nav.general', zh: '通用设置' },
      { id: 'settingsSectionBrowse', icon: '\u{1F5BC}\uFE0F', key: 'settings.nav.browse', zh: '浏览偏好' },
      { id: 'settingsSectionMedia', icon: '\u{1F5C4}\uFE0F', key: 'settings.nav.media', zh: '后台任务与维护' },
      { id: 'settingsSectionNetwork', icon: '\u{1F310}', key: 'settings.nav.network', zh: '局域网访问' },
    ];
    var html = '';
    for (var i = 0; i < navItems.length; i++) {
      var item = navItems[i];
      var isActive = item.id === activeId;
      html +=
        '<div class="folder-item' +
        (isActive ? ' active' : '') +
        '" data-settings-section-id="' +
        item.id +
        '">' +
        '<span class="icon">' +
        item.icon +
        '</span>' +
        '<span class="name">' +
        navLabel(item.key, item.zh) +
        '</span>' +
        '</div>';
    }
    dom.sidebarContent.innerHTML = html;
  }

  function scrollToSettingsSection(sectionId, options) {
    options = options || {};
    var el = document.getElementById(sectionId);
    if (!el) return;
    if (typeof options.onSaveLastSettingsSectionId === 'function') {
      options.onSaveLastSettingsSectionId(sectionId);
    }
    el.scrollIntoView({ behavior: 'auto', block: 'start' });
    if (typeof options.onRenderSettingsNav === 'function') {
      options.onRenderSettingsNav(sectionId);
    }
  }

  function createFolderManageRow(f, onRescan, onRemove) {
    var row = f || {};
    var rootPath = String(row.path || '');
    var tr = document.createElement('tr');
    tr.className = 'folder-manage-row';

    var tdPath = document.createElement('td');
    tdPath.className = 'fm-cell-path';
    tdPath.textContent = rootPath;
    tdPath.title = rootPath;

    var tdAct = document.createElement('td');
    tdAct.className = 'fm-cell-actions';
    var actions = document.createElement('div');
    actions.className = 'fm-actions';

    var rescanBtn = document.createElement('button');
    rescanBtn.type = 'button';
    rescanBtn.className = 'btn btn-sm fm-btn';
    rescanBtn.textContent = tSet('settings.folderRescan', '重新扫描');
    rescanBtn.title = tSet(
      'settings.folderRescanTitle',
      '子文件夹移动、重命名或大量增删照片后，请重新扫描以同步索引',
    );
    rescanBtn.addEventListener(
      'click',
      (function (p) {
        return function () {
          onRescan(p);
        };
      })(rootPath),
    );

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-sm btn-danger fm-btn';
    removeBtn.textContent = tSet('settings.folderRemove', '移除');
    removeBtn.addEventListener(
      'click',
      (function (p) {
        return function () {
          onRemove(p);
        };
      })(rootPath),
    );

    actions.appendChild(rescanBtn);
    actions.appendChild(removeBtn);
    tdAct.appendChild(actions);

    tr.appendChild(tdPath);
    tr.appendChild(tdAct);
    return tr;
  }

  function renderSettingsFolderListFromRows(folders, options) {
    options = options || {};
    var onRescan = options.onRescan;
    var onRemove = options.onRemove;

    var container = document.getElementById('settingsFolderList');
    if (!container) return;
    if (!folders || folders.length === 0) {
      var emptyTitle = tSet('settings.folderEmptyTitle', '暂无相册目录');
      var emptyDesc = tSet('settings.folderEmptyDesc', '点击上方「添加目录」按钮开始管理照片');
      container.innerHTML =
        '<div class="settings-empty"><div class="icon">📂</div><div class="title">' +
        emptyTitle +
        '</div><div class="desc">' +
        emptyDesc +
        '</div></div>';
      return;
    }

    var table = document.createElement('table');
    table.className = 'folder-manage-table';
    table.setAttribute('aria-label', tSet('settings.folderTableAria', '相册根目录列表'));

    var thead = document.createElement('thead');
    var headTr = document.createElement('tr');
    var headers = [tSet('settings.folderColPath', '路径'), tSet('settings.folderColActions', '操作')];
    for (var hi = 0; hi < headers.length; hi++) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = headers[hi];
      headTr.appendChild(th);
    }
    thead.appendChild(headTr);

    var tbody = document.createElement('tbody');
    var n = folders.length;

    function appendRowsRange(from, to) {
      var frag = document.createDocumentFragment();
      for (var i = from; i < to; i++) {
        frag.appendChild(createFolderManageRow(folders[i], onRescan, onRemove));
      }
      tbody.appendChild(frag);
    }

    if (n <= SETTINGS_FOLDER_ROW_RAF_THRESHOLD) {
      appendRowsRange(0, n);
      table.appendChild(thead);
      table.appendChild(tbody);
      container.innerHTML = '';
      container.appendChild(table);
      return;
    }

    appendRowsRange(0, Math.min(SETTINGS_FOLDER_ROW_CHUNK, n));
    table.appendChild(thead);
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);

    var start = Math.min(SETTINGS_FOLDER_ROW_CHUNK, n);
    function pump() {
      var end = Math.min(start + SETTINGS_FOLDER_ROW_CHUNK, n);
      appendRowsRange(start, end);
      start = end;
      if (start < n) requestAnimationFrame(pump);
    }
    if (start < n) requestAnimationFrame(pump);
  }

  global.RendererSettingsUI = {
    renderSettingsNav: renderSettingsNav,
    scrollToSettingsSection: scrollToSettingsSection,
    renderSettingsFolderListFromRows: renderSettingsFolderListFromRows,
  };

  // ===== thumb-settings-ui.js =====
  function normalizeThumbSizeQuality(sz, q) {
    var size = parseInt(sz, 10) || 256;
    if ([128, 192, 256, 320].indexOf(size) < 0) size = 256;
    var quality = parseInt(q, 10) || 75;
    if ([55, 65, 75, 85, 95].indexOf(quality) < 0) quality = 75;
    return { size: size, quality: quality };
  }

  function formatThumbCurrentLine(size, quality) {
    if (window.I18n && typeof window.I18n.t === 'function') {
      return window.I18n
        .t('settings.thumbCurrentLineFmt')
        .replace('{size}', String(size))
        .replace('{quality}', String(quality));
    }
    return '当前生效：最大边长 ' + size + ' px · JPEG 质量 ' + quality;
  }

  function updateThumbCurrentLineDisplay(options) {
    options = options || {};
    var state = options.state || {};
    var lineFormatter = options.formatThumbCurrentLine || formatThumbCurrentLine;
    var el = document.getElementById('thumbSettingsCurrentLine');
    if (!el || state.thumbAppliedSize == null || state.thumbAppliedQuality == null) return;
    el.textContent = lineFormatter(state.thumbAppliedSize, state.thumbAppliedQuality);
  }

  function applyThumbAppliedStateFromSettings(s, options) {
    options = options || {};
    var state = options.state || {};
    var normalizer = options.normalizeThumbSizeQuality || normalizeThumbSizeQuality;
    var onUpdateThumbCurrentLineDisplay = options.onUpdateThumbCurrentLineDisplay || function () {};
    var n = normalizer(s && s.thumbSize, s && s.thumbQuality);
    state.thumbAppliedSize = n.size;
    state.thumbAppliedQuality = n.quality;
    onUpdateThumbCurrentLineDisplay();
  }

  function updateThumbPendingHint(options) {
    options = options || {};
    var state = options.state || {};
    var normalizer = options.normalizeThumbSizeQuality || normalizeThumbSizeQuality;
    var pending = document.getElementById('thumbSettingsPendingHint');
    var ts = document.getElementById('settingThumbSize');
    var tq = document.getElementById('settingThumbQuality');
    if (!pending || !ts || !tq) return;
    var n = normalizer(ts.value, tq.value);
    var diff =
      state.thumbAppliedSize == null ||
      state.thumbAppliedQuality == null ||
      n.size !== state.thumbAppliedSize ||
      n.quality !== state.thumbAppliedQuality;
    pending.style.display = diff ? 'block' : 'none';
  }

  global.RendererThumbSettingsUI = Object.assign({}, global.RendererThumbSettingsUI || {}, {
    normalizeThumbSizeQuality: normalizeThumbSizeQuality,
    formatThumbCurrentLine: formatThumbCurrentLine,
    applyThumbAppliedStateFromSettings: applyThumbAppliedStateFromSettings,
    updateThumbCurrentLineDisplay: updateThumbCurrentLineDisplay,
    updateThumbPendingHint: updateThumbPendingHint,
  });

  // ===== maintenance-ui.js =====
  var MAINTENANCE_BTN_IDS = [
    'maintenanceCleanupBtn',
    'maintenanceRebuildThumbFlagsBtn',
    'maintenanceOptimizeBtn',
    'maintenanceBackupDbBtn',
  ];

  function setMaintenanceBusy(busy, options) {
    options = options || {};
    var ids = options.maintenanceButtonIds || MAINTENANCE_BTN_IDS;
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.disabled = !!busy;
    }
  }

  function setMaintenanceStatus(text, options) {
    options = options || {};
    var dom = options.dom || {};
    if (dom.maintenanceStatus) dom.maintenanceStatus.textContent = text;
  }

  function stopThumbnailBackfillPolling(options) {
    options = options || {};
    var state = options.state || {};
    if (state.thumbBackfillPolling) {
      clearInterval(state.thumbBackfillPolling);
      state.thumbBackfillPolling = null;
    }
  }

  function stopDuplicateHashPolling(options) {
    options = options || {};
    var state = options.state || {};
    if (state.duplicateHashPolling) {
      clearInterval(state.duplicateHashPolling);
      state.duplicateHashPolling = null;
    }
  }

  global.RendererMaintenanceUI = {
    setMaintenanceBusy: setMaintenanceBusy,
    setMaintenanceStatus: setMaintenanceStatus,
    stopThumbnailBackfillPolling: stopThumbnailBackfillPolling,
    stopDuplicateHashPolling: stopDuplicateHashPolling,
  };
})(typeof window !== 'undefined' ? window : globalThis);
