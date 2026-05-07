(function (global) {
  'use strict';

  function normalizeDuplicateGroups(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (g) {
      return Number(g && g.duplicate_count) >= 2 && String((g && g.file_hash) || '').length > 0;
    });
  }

  // ===== duplicates-ui.js =====
  function renderDuplicatePageShell(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    if (!dom.photoGrid) return;

    var scanned = !!state.duplicateHasScanned;
    var defaultBody =
      '<div class="dup-empty">' +
      (scanned ? '请在左侧选一个分组查看。' : '还没有数据。点击下方开始查找内容相同的照片。') +
      '<div style="margin-top:10px;">' +
      '<button type="button" class="btn btn-sm btn-primary" data-dup-action="start-hash">查找重复照片</button>' +
      '</div>' +
      '</div>';
    var html =
      '<div class="dup-page-head">' +
      '<div>' +
      '<div class="dup-page-title">重复照片</div>' +
      '<div class="dup-page-desc">内容相同的照片会归为一组，界面会随主题自动切换</div>' +
      '</div>' +
      '<div class="dup-toolbar">' +
      '<button type="button" class="btn btn-sm" data-dup-action="start-hash">' +
      (scanned ? '重新查找' : '查找重复照片') +
      '</button>' +
      '<button type="button" class="btn btn-sm" data-dup-action="load-groups" data-page="1" ' +
      (scanned ? '' : 'disabled') +
      '>刷新列表</button>' +
      '</div>' +
      '</div>' +
      '<div id="dupListWrap" class="dup-group-list">' +
      defaultBody +
      '</div>';
    dom.photoGrid.innerHTML = html;
  }

  function renderDuplicateSidebarLoading(text, gate, options) {
    options = options || {};
    var state = options.state || {};
    var formatNumber = options.formatNumber;
    var escapeHtml = options.escapeHtml;
    var onEnsureDuplicateSidebarVisible = options.onEnsureDuplicateSidebarVisible;
    var onGetSidebarRenderTarget = options.onGetSidebarRenderTarget;
    if (typeof formatNumber !== 'function' || typeof escapeHtml !== 'function') return;
    if (
      typeof onEnsureDuplicateSidebarVisible !== 'function' ||
      typeof onGetSidebarRenderTarget !== 'function'
    )
      return;

    if (!gate && state.sidebarLockedMode !== 'duplicates' && state.currentView !== 'duplicates')
      return;
    onEnsureDuplicateSidebarVisible();
    var groups = normalizeDuplicateGroups(state.duplicateGroups);
    var rootItemHtml =
      '<div class="folder-item active" data-sidebar-duplicates="1">' +
      '<span class="icon">\u{1F9E9}</span>' +
      '<span class="name">重复照片</span>' +
      '<span class="count">' +
      formatNumber(groups.length) +
      '</span>' +
      '</div>';
    var html =
      rootItemHtml +
      '<div class="sidebar-list-loading"><div class="content-loading-spinner content-loading-spinner--sm"></div><div>' +
      escapeHtml(text || '加载中...') +
      '</div></div>';
    var target = onGetSidebarRenderTarget();
    if (!target) return;
    if (gate) {
      if (gate.isAlive()) target.innerHTML = html;
    } else {
      target.innerHTML = html;
    }
  }

  function renderDuplicateSidebar(gate, options) {
    options = options || {};
    var state = options.state || {};
    var formatNumber = options.formatNumber;
    var escapeHtml = options.escapeHtml;
    var escapeAttr = options.escapeAttr;
    var onEnsureDuplicateSidebarVisible = options.onEnsureDuplicateSidebarVisible;
    var onGetSidebarRenderTarget = options.onGetSidebarRenderTarget;
    if (
      typeof formatNumber !== 'function' ||
      typeof escapeHtml !== 'function' ||
      typeof escapeAttr !== 'function'
    )
      return;
    if (
      typeof onEnsureDuplicateSidebarVisible !== 'function' ||
      typeof onGetSidebarRenderTarget !== 'function'
    )
      return;

    if (!gate && state.sidebarLockedMode !== 'duplicates' && state.currentView !== 'duplicates')
      return;
    onEnsureDuplicateSidebarVisible();
    var target = onGetSidebarRenderTarget();
    if (!target) return;
    var scanned = !!state.duplicateHasScanned;
    var groups = normalizeDuplicateGroups(state.duplicateGroups);
    var rootItemHtml =
      '<div class="folder-item active" data-sidebar-duplicates="1">' +
      '<span class="icon">\u{1F9E9}</span>' +
      '<span class="name">重复照片</span>' +
      '<span class="count">' +
      formatNumber(groups.length) +
      '</span>' +
      '</div>';
    if (!scanned) {
      var html0 =
        rootItemHtml +
        '<div class="sidebar-list-loading">' +
        '<div>还没有重复分组</div>' +
        '<button type="button" class="btn btn-sm btn-primary" data-dup-action="start-hash">查找重复照片</button>' +
        '</div>';
      if (gate) {
        if (gate.isAlive()) target.innerHTML = html0;
      } else target.innerHTML = html0;
      return;
    }
    if (!groups.length) {
      var html1 = rootItemHtml + '<div class="sidebar-list-loading">未检测到重复组</div>';
      if (gate) {
        if (gate.isAlive()) target.innerHTML = html1;
      } else target.innerHTML = html1;
      return;
    }
    var html = '';
    html += rootItemHtml;
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var hash = String(g.file_hash || '');
      var active = hash === state.currentDuplicateHash;
      html +=
        '<div class="folder-item ' +
        (active ? 'active' : '') +
        '" data-dup-hash="' +
        escapeAttr(hash) +
        '">' +
        '<span class="icon">🧩</span>' +
        '<span class="name" title="' +
        escapeAttr(hash) +
        '">' +
        escapeHtml(hash.slice(0, 12) + '...') +
        '</span>' +
        '<span class="count">' +
        formatNumber(g.duplicate_count || 0) +
        '</span>' +
        '</div>';
    }
    html +=
      '<div style="display:flex;justify-content:center;gap:8px;padding:10px 8px 14px;">' +
      '<button type="button" class="btn btn-sm" ' +
      (state.duplicateGroupsPage <= 1 ? 'disabled' : '') +
      ' data-dup-action="load-groups" data-page="' +
      (state.duplicateGroupsPage - 1) +
      '">上一页</button>' +
      '<button type="button" class="btn btn-sm" ' +
      (state.duplicateGroupsPage >= state.duplicateGroupsTotalPages ? 'disabled' : '') +
      ' data-dup-action="load-groups" data-page="' +
      (state.duplicateGroupsPage + 1) +
      '">下一页</button>' +
      '</div>';
    if (gate) {
      if (gate.isAlive()) target.innerHTML = html;
    } else target.innerHTML = html;
  }

  function renderDuplicateGroupPhotosHtml(hash, options) {
    options = options || {};
    var state = options.state || {};
    var escapeHtml = options.escapeHtml;
    var escapeAttr = options.escapeAttr;
    var formatSize = options.formatSize;
    var formatDateTime = options.formatDateTime;
    if (typeof escapeHtml !== 'function' || typeof escapeAttr !== 'function') return '';
    if (typeof formatSize !== 'function' || typeof formatDateTime !== 'function') return '';

    var photos = state.duplicatePhotosByHash[hash];
    if (!photos) {
      return '<div class="dup-empty">正在加载组内照片...</div>';
    }
    if (!photos.length) {
      return '<div class="dup-empty">该组暂无可展示照片</div>';
    }
    var html = '';
    for (var i = 0; i < photos.length; i++) {
      var p = photos[i];
      var thumb = p.has_thumbnail ? 'thumb://' + p.id : '';
      html +=
        '<div class="dup-photo-row">' +
        (thumb
          ? '<img class="dup-photo-thumb" src="' +
            thumb +
            '" alt="' +
            escapeHtml(p.file_name || '') +
            '" />'
          : '<div class="dup-photo-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);">无缩略图</div>') +
        '<div>' +
        '<div class="dup-photo-name" title="' +
        escapeAttr(p.file_name || '') +
        '">' +
        escapeHtml(p.file_name || '') +
        '</div>' +
        '<div class="dup-photo-sub" title="' +
        escapeAttr(p.folder_path || '') +
        '">' +
        escapeHtml(p.folder_path || '') +
        '</div>' +
        '<div class="dup-photo-sub">大小 ' +
        formatSize(p.file_size || 0) +
        ' · 修改 ' +
        escapeHtml(formatDateTime(p.date_modified || '')) +
        '</div>' +
        '</div>' +
        '<div class="dup-photo-actions">' +
        '<button type="button" class="btn btn-sm" data-dup-action="preview" data-hash="' +
        escapeAttr(hash) +
        '" data-index="' +
        i +
        '">预览</button>' +
        '<button type="button" class="btn btn-sm" data-dup-action="locate" data-photo-id="' +
        p.id +
        '">定位</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-dup-action="delete" data-photo-id="' +
        p.id +
        '" data-hash="' +
        escapeAttr(hash) +
        '">删除</button>' +
        '</div>' +
        '</div>';
    }
    return html;
  }

  function renderDuplicateNoGroupContent() {
    var wrap = document.getElementById('dupListWrap');
    if (!wrap) return;
    wrap.innerHTML =
      '<div class="dup-empty">目前没有重复分组。可到设置里重新比对，或稍后再试。</div>';
  }

  global.RendererDuplicatesUI = Object.assign({}, global.RendererDuplicatesUI || {}, {
    renderDuplicatePageShell: renderDuplicatePageShell,
    renderDuplicateSidebarLoading: renderDuplicateSidebarLoading,
    renderDuplicateSidebar: renderDuplicateSidebar,
    renderDuplicateGroupPhotosHtml: renderDuplicateGroupPhotosHtml,
    renderDuplicateNoGroupContent: renderDuplicateNoGroupContent,
  });

  // ===== duplicates-flow.js =====
  async function loadDuplicateGroups(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var page = options.page;
    var onCreateSidebarRequestGate = options.onCreateSidebarRequestGate;
    var onRenderDuplicateSidebarLoading = options.onRenderDuplicateSidebarLoading;
    var onRenderDuplicateSidebar = options.onRenderDuplicateSidebar;
    var onRenderDuplicateNoGroupContent = options.onRenderDuplicateNoGroupContent;
    var onSelectDuplicateGroup = options.onSelectDuplicateGroup;
    if (!(api && api.has && api.has('maintenanceGetDuplicateHashGroups'))) return;
    if (typeof onCreateSidebarRequestGate !== 'function') return;
    if (typeof onRenderDuplicateSidebarLoading !== 'function') return;
    if (typeof onRenderDuplicateSidebar !== 'function') return;
    if (typeof onRenderDuplicateNoGroupContent !== 'function') return;
    if (typeof onSelectDuplicateGroup !== 'function') return;
    if (state.duplicateGroupsLoading) return;

    var reqPage = Math.max(1, parseInt(page, 10) || 1);
    if (
      !options.forceReload &&
      state._dupListGen === state._dupListLoadedGen &&
      state.duplicateHasScanned &&
      Array.isArray(state.duplicateGroups) &&
      state.duplicateGroups.length > 0 &&
      reqPage === state.duplicateGroupsPage
    ) {
      var gateWarm = onCreateSidebarRequestGate('duplicates', 'loadDuplicateGroups');
      if (!gateWarm.isAlive()) return;
      state.duplicateGroupsLoading = true;
      try {
        onRenderDuplicateSidebar(gateWarm);
        var hashWarm = state.currentDuplicateHash;
        if (
          !hashWarm ||
          !state.duplicateGroups.some(function (g) {
            return String(g.file_hash || '') === hashWarm;
          })
        ) {
          hashWarm = String(state.duplicateGroups[0].file_hash || '');
          state.currentDuplicateHash = hashWarm;
        }
        await onSelectDuplicateGroup(state.currentDuplicateHash);
      } finally {
        state.duplicateGroupsLoading = false;
      }
      return;
    }

    var gate = onCreateSidebarRequestGate('duplicates', 'loadDuplicateGroups');
    state.duplicateGroupsLoading = true;
    state.duplicateGroupsPage = reqPage;
    onRenderDuplicateSidebarLoading('正在加载重复组...', gate);
    try {
      if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
        Logger.log(
          '[dup-ui] load groups start page=%d force=%s',
          reqPage,
          options.forceReload ? 'yes' : 'no',
        );
      }
      var r = await api.maintenanceGetDuplicateHashGroups({
        page: state.duplicateGroupsPage,
        pageSize: 40,
        minCount: 2,
      });
      if (!gate.isAlive()) return;
      var groups = normalizeDuplicateGroups((r && r.groups) || []);
      state.duplicateGroups = groups;
      state.duplicateHasScanned = true;
      state.duplicateGroupsTotalPages = (r && r.totalPages) || 1;
      if (typeof console !== 'undefined' && console && typeof console.log === 'function') {
        Logger.log(
          '[dup-ui] load groups done groups=%d total=%d totalPages=%d',
          groups.length,
          Number(r && r.total) || 0,
          Number(r && r.totalPages) || 0,
        );
      }
      if (!groups.length) {
        var shouldRetry = false;
        if (api && api.has && api.has('maintenanceGetDuplicateHashProgress')) {
          try {
            var p = await api.maintenanceGetDuplicateHashProgress();
            var running = !!(p && p.running);
            var phase = p && p.phase ? String(p.phase) : '';
            var maybeSummarizing = phase === 'summarizing';
            var done = Number(p && p.done) || 0;
            var total = Number(p && p.total) || 0;
            var hashed = Number(p && p.hashed) || 0;
            shouldRetry =
              running ||
              maybeSummarizing ||
              (hashed > 0 && done >= total && Number(p && p.duplicateGroups) === 0);
          } catch (eProg) {
            shouldRetry = false;
          }
        }
        if (shouldRetry) {
          onRenderDuplicateSidebarLoading('正在汇总重复组，请稍候…', gate);
          setTimeout(function () {
            if (state.currentTab !== 'duplicates' && state.currentView !== 'duplicates') return;
            if (state.duplicateGroupsLoading) return;
            void loadDuplicateGroups(
              Object.assign({}, options, {
                forceReload: true,
                page: reqPage,
              }),
            );
          }, 1200);
        } else {
          state.currentDuplicateHash = '';
          onRenderDuplicateSidebar(gate);
          onRenderDuplicateNoGroupContent();
        }
      } else {
        if (
          !state.currentDuplicateHash ||
          !groups.some(function (g) {
            return String(g.file_hash || '') === state.currentDuplicateHash;
          })
        ) {
          state.currentDuplicateHash = String(groups[0].file_hash || '');
        }
        onRenderDuplicateSidebar(gate);
        await onSelectDuplicateGroup(state.currentDuplicateHash);
      }
      state._dupListLoadedGen = state._dupListGen;
    } catch (e) {
      if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
        Logger.warn('[dup-ui] load groups failed:', e && e.message ? e.message : e);
      }
      onRenderDuplicateSidebarLoading('加载失败，请稍后重试', gate);
    } finally {
      state.duplicateGroupsLoading = false;
    }
  }

  async function selectDuplicateGroup(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var hash = String(options.hash || '');
    var onCreateSidebarRequestGate = options.onCreateSidebarRequestGate;
    var onRenderDuplicateSidebar = options.onRenderDuplicateSidebar;
    var onRenderDuplicateGroupPhotosHtml = options.onRenderDuplicateGroupPhotosHtml;
    var onFormatNumber = options.onFormatNumber;
    var onFormatSize = options.onFormatSize;
    var onEscapeHtml = options.onEscapeHtml;
    if (!hash) return;
    if (typeof onCreateSidebarRequestGate !== 'function') return;
    if (typeof onRenderDuplicateSidebar !== 'function') return;
    if (typeof onRenderDuplicateGroupPhotosHtml !== 'function') return;
    if (typeof onFormatNumber !== 'function' || typeof onFormatSize !== 'function') return;
    if (typeof onEscapeHtml !== 'function') return;

    var gate = onCreateSidebarRequestGate('duplicates', 'selectDuplicateGroup');
    state.currentDuplicateHash = hash;
    onRenderDuplicateSidebar(gate);
    var wrap = document.getElementById('dupListWrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="dup-empty">正在加载组内照片...</div>';

    if (!state.duplicatePhotosByHash[hash]) {
      try {
        var rows = await api.maintenanceGetPhotosByFileHash(hash);
        state.duplicatePhotosByHash[hash] = Array.isArray(rows) ? rows : [];
      } catch (e) {
        state.duplicatePhotosByHash[hash] = [];
      }
    }
    if (!gate.isAlive()) return;

    var rowsNow = Array.isArray(state.duplicatePhotosByHash[hash])
      ? state.duplicatePhotosByHash[hash]
      : [];
    if (rowsNow.length < 2) {
      state.duplicateGroups = (state.duplicateGroups || []).filter(function (g) {
        return String((g && g.file_hash) || '') !== hash;
      });
      var groupsLeft = normalizeDuplicateGroups(state.duplicateGroups);
      if (!groupsLeft.length) {
        state.currentDuplicateHash = '';
        onRenderDuplicateSidebar(gate);
        var wrapEmpty = document.getElementById('dupListWrap');
        if (wrapEmpty) {
          wrapEmpty.innerHTML =
            '<div class="dup-empty">目前没有重复分组。可到设置里重新比对，或稍后再试。</div>';
        }
        return;
      }
      state.currentDuplicateHash = String((groupsLeft[0] && groupsLeft[0].file_hash) || '');
      onRenderDuplicateSidebar(gate);
      await selectDuplicateGroup(
        Object.assign({}, options, {
          hash: state.currentDuplicateHash,
        }),
      );
      return;
    }

    var group = (state.duplicateGroups || []).find(function (g) {
      return String(g.file_hash || '') === hash;
    });
    var header =
      '<div class="dup-group-card"><div class="dup-group-top"><div class="dup-group-meta">' +
      '<span class="dup-pill">重复 ' +
      onFormatNumber((group && group.duplicate_count) || 0) +
      ' 张</span>' +
      '<span class="dup-pill">总大小 ' +
      onFormatSize((group && group.total_size) || 0) +
      '</span>' +
      '<span>组编号：' +
      onEscapeHtml(hash.slice(0, 12)) +
      '…</span>' +
      '</div><div><button type="button" class="btn btn-sm" data-dup-action="preview" data-hash="' +
      onEscapeHtml(hash) +
      '" data-index="0">从第一张预览</button></div></div></div>';
    wrap.innerHTML =
      header +
      '<div class="dup-group-body" style="display:block;">' +
      onRenderDuplicateGroupPhotosHtml(hash) +
      '</div>';
  }

  async function showPhotoInFolderById(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var photoId = options.photoId;
    var onSetDuplicateHashStatus = options.onSetDuplicateHashStatus;
    var appAlert = options.appAlert;
    var appConfirm = options.appConfirm;
    var onLoadDuplicateGroups = options.onLoadDuplicateGroups;
    var onSelectDuplicateGroup = options.onSelectDuplicateGroup;
    var onRenderDuplicateNoGroupContent = options.onRenderDuplicateNoGroupContent;
    if (!photoId || !(api && api.has && api.has('showPhotoInFolder'))) return;
    var r = await api.showPhotoInFolder(photoId);
    if (!r || !r.success) {
      var msg = '定位失败：' + ((r && r.error) || '未知错误');
      if (typeof onSetDuplicateHashStatus === 'function') {
        onSetDuplicateHashStatus(msg);
      }
      if (typeof appAlert === 'function') {
        appAlert(msg);
      }
      var errText = String((r && r.error) || '');
      var missingLike = errText.indexOf('文件不存在') >= 0 || errText.indexOf('不存在') >= 0;
      if (
        missingLike &&
        api &&
        api.has &&
        api.has('photoDeleteRecord') &&
        typeof appConfirm === 'function' &&
        typeof onLoadDuplicateGroups === 'function' &&
        typeof onSelectDuplicateGroup === 'function' &&
        typeof onRenderDuplicateNoGroupContent === 'function'
      ) {
        var ok = await appConfirm('文件已移动或删除。是否清除这条失效记录？');
        if (!ok) return;
        var dr = await api.photoDeleteRecord(photoId);
        if (!dr || !dr.success) {
          if (typeof appAlert === 'function') {
            appAlert('清除记录失败：' + ((dr && dr.error) || '未知错误'));
          }
          return;
        }
        var curHash = String(state.currentDuplicateHash || '');
        if (
          curHash &&
          state.duplicatePhotosByHash &&
          Array.isArray(state.duplicatePhotosByHash[curHash])
        ) {
          state.duplicatePhotosByHash[curHash] = state.duplicatePhotosByHash[curHash].filter(
            function (p) {
              return Number(p && p.id) !== Number(photoId);
            },
          );
          if (state.duplicatePhotosByHash[curHash].length < 2) {
            delete state.duplicatePhotosByHash[curHash];
          }
        }
        await onLoadDuplicateGroups(state.duplicateGroupsPage || 1, { forceReload: true });
        var groups = Array.isArray(state.duplicateGroups) ? state.duplicateGroups : [];
        if (!groups.length) {
          state.currentDuplicateHash = '';
          onRenderDuplicateNoGroupContent();
          return;
        }
        var keep = groups.some(function (g) {
          return String((g && g.file_hash) || '') === curHash;
        });
        state.currentDuplicateHash = keep
          ? curHash
          : String((groups[0] && groups[0].file_hash) || '');
        await onSelectDuplicateGroup(state.currentDuplicateHash);
      }
    }
  }

  async function deleteDuplicatePhoto(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var photoId = options.photoId;
    var hash = options.hash;
    var appConfirm = options.appConfirm;
    var appAlert = options.appAlert;
    var onLoadStats = options.onLoadStats;
    var onLoadDuplicateGroups = options.onLoadDuplicateGroups;
    var onRenderDuplicateNoGroupContent = options.onRenderDuplicateNoGroupContent;
    var onSelectDuplicateGroup = options.onSelectDuplicateGroup;
    if (!photoId || !(api && api.has && api.has('photoMoveToTrash'))) return;
    if (typeof appConfirm !== 'function' || typeof appAlert !== 'function') return;
    if (typeof onLoadStats !== 'function' || typeof onLoadDuplicateGroups !== 'function') return;
    if (
      typeof onRenderDuplicateNoGroupContent !== 'function' ||
      typeof onSelectDuplicateGroup !== 'function'
    )
      return;

    var h = String(hash || '');
    var rows = state.duplicatePhotosByHash[h] || [];
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].id === photoId) {
        row = rows[i];
        break;
      }
    }
    var name = row && row.file_name ? row.file_name : 'ID ' + photoId;
    var ok = await appConfirm(
      '将「' + name + '」移到回收站并从相册索引中移除？\n可在系统回收站中还原文件。',
    );
    if (!ok) return;
    var r = await api.photoMoveToTrash(photoId);
    if (!r || !r.success) {
      appAlert('删除失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    var prevHash = String(state.currentDuplicateHash || '');
    var groupsNow = Array.isArray(state.duplicateGroups) ? state.duplicateGroups : [];
    var idxGroup = -1;
    var gi0;
    for (gi0 = 0; gi0 < groupsNow.length; gi0++) {
      if (String((groupsNow[gi0] && groupsNow[gi0].file_hash) || '') === h) {
        idxGroup = gi0;
        break;
      }
    }
    var cachedRows = Array.isArray(state.duplicatePhotosByHash[h])
      ? state.duplicatePhotosByHash[h]
      : [];
    var nextRows = cachedRows.filter(function (p) {
      return Number(p && p.id) !== Number(photoId);
    });
    if (state.duplicatePhotosByHash && typeof state.duplicatePhotosByHash === 'object') {
      if (nextRows.length >= 2) {
        state.duplicatePhotosByHash[h] = nextRows;
      } else {
        delete state.duplicatePhotosByHash[h];
      }
    }
    if (idxGroup >= 0) {
      if (nextRows.length >= 2) {
        groupsNow[idxGroup].duplicate_count = nextRows.length;
      } else {
        groupsNow.splice(idxGroup, 1);
      }
      state.duplicateGroups = groupsNow;
    }
    var groups = normalizeDuplicateGroups(state.duplicateGroups);
    if (!groups.length) {
      state.currentDuplicateHash = '';
      onRenderDuplicateNoGroupContent();
      // 后台异步校准一次，避免与服务端边界状态偏差
      void onLoadStats().catch(function () {});
      void onLoadDuplicateGroups(1, { forceReload: true }).catch(function () {});
      return;
    }
    var nextHash = '';
    var gi;
    for (gi = 0; gi < groups.length; gi++) {
      var gh = String((groups[gi] && groups[gi].file_hash) || '');
      if (gh && gh === prevHash) {
        nextHash = gh;
        break;
      }
    }
    if (!nextHash) {
      nextHash = String((groups[0] && groups[0].file_hash) || '');
    }
    state.currentDuplicateHash = nextHash;
    await onSelectDuplicateGroup(state.currentDuplicateHash);
    // 不阻塞 UI：后台异步刷新统计与分组计数
    void onLoadStats().catch(function () {});
    void onLoadDuplicateGroups(state.duplicateGroupsPage || 1, { forceReload: true }).catch(
      function () {},
    );
  }

  async function openDuplicatePreview(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var hash = options.hash;
    var index = options.index;
    var onOpenPreview = options.onOpenPreview;
    var onSetDuplicateHashStatus = options.onSetDuplicateHashStatus;
    if (typeof onOpenPreview !== 'function') return;
    var h = String(hash || '');
    if (!h) return;
    var photos = state.duplicatePhotosByHash[h];
    if (
      (!photos || !photos.length) &&
      api &&
      api.has &&
      api.has('maintenanceGetPhotosByFileHash')
    ) {
      try {
        var rows = await api.maintenanceGetPhotosByFileHash(h);
        state.duplicatePhotosByHash[h] = Array.isArray(rows) ? rows : [];
        photos = state.duplicatePhotosByHash[h];
      } catch (eLoad) {
        if (typeof onSetDuplicateHashStatus === 'function') {
          onSetDuplicateHashStatus(
            '预览加载失败：' + (eLoad && eLoad.message ? eLoad.message : '未知错误'),
          );
        }
        return;
      }
    }
    if (!photos || !photos.length) return;
    state.previewPhotos = photos.slice();
    state.previewPageStart = 1;
    state.previewLoadingPage = 0;
    onOpenPreview(index);
  }

  global.RendererDuplicatesFlow = Object.assign({}, global.RendererDuplicatesFlow || {}, {
    loadDuplicateGroups: loadDuplicateGroups,
    selectDuplicateGroup: selectDuplicateGroup,
    showPhotoInFolderById: showPhotoInFolderById,
    deleteDuplicatePhoto: deleteDuplicatePhoto,
    openDuplicatePreview: openDuplicatePreview,
  });
})(window);
