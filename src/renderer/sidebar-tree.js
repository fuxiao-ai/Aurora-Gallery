(function (global) {
  /** 大库下 buildTree 分片，让出主线程避免长时间脚本卡死 */
  var SIDEBAR_TREE_FLAT_CHUNK = 1800;

  function tSide(key, zh) {
    if (window.I18n && typeof window.I18n.t === 'function') return window.I18n.t(key);
    return zh;
  }
  /** 不再省略子目录：目录树全量渲染（仍保留分片与渐进渲染避免长任务） */
  var SIDEBAR_TREE_MAX_RENDER_NODES = Number.MAX_SAFE_INTEGER;
  /** 各根「目录行」合计超过此值走渐进渲染（多根分摊） */
  var SIDEBAR_TREE_PROGRESSIVE_FLAT_SUM_MIN = 4000;
  /** 单根「目录行」超过此值也走渐进（避免仅一个大库仍同步构建巨型 DOM） */
  var SIDEBAR_TREE_PROGRESSIVE_FLAT_ONE_MIN = 2600;

  function normalizePath(p) {
    return String(p || '').replace(/\//g, '\\');
  }

  function insertTreeNode(nodes, parts, depth, rootPath, fullPath, photoCount) {
    if (depth >= parts.length) return;
    var name = parts[depth];
    var nodePath = rootPath + '\\' + parts.slice(0, depth + 1).join('\\');
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

  function buildTree(rootPath, flatFolders) {
    var normRoot = normalizePath(rootPath).replace(/[\\]+$/, '');
    var nodes = [];
    for (var i = 0; i < flatFolders.length; i++) {
      var f = flatFolders[i];
      var normFolder = normalizePath(f.folder_path);
      var relativePath = normFolder;
      if (normRoot && normFolder.indexOf(normRoot) === 0) {
        relativePath = normFolder.substring(normRoot.length);
      }
      relativePath = relativePath.replace(/^[\\/]+/, '');
      if (!relativePath) continue;
      var parts = relativePath.split(/[\\/]+/);
      insertTreeNode(nodes, parts, 0, normRoot, normFolder, f.photo_count);
    }
    sortTree(nodes);
    return nodes;
  }

  /** 分片构建，在巨型 flat 列表上避免单次长任务卡死渲染进程 */
  async function buildTreeAsync(rootPath, flatFolders, chunkSize) {
    chunkSize = chunkSize || SIDEBAR_TREE_FLAT_CHUNK;
    var normRoot = normalizePath(rootPath).replace(/[\\]+$/, '');
    var nodes = [];
    var n = flatFolders.length;
    var i = 0;
    while (i < n) {
      var lim = Math.min(i + chunkSize, n);
      for (; i < lim; i++) {
        var f = flatFolders[i];
        var normFolder = normalizePath(f.folder_path);
        var relativePath = normFolder;
        if (normRoot && normFolder.indexOf(normRoot) === 0) {
          relativePath = normFolder.substring(normRoot.length);
        }
        relativePath = relativePath.replace(/^[\\/]+/, '');
        if (!relativePath) continue;
        var parts = relativePath.split(/[\\/]+/);
        insertTreeNode(nodes, parts, 0, normRoot, normFolder, f.photo_count);
      }
      if (i < n) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 0);
        });
      }
    }
    sortTree(nodes);
    return nodes;
  }

  function renderTreeNodes(nodes, depth, options, budget) {
    options = options || {};
    var state = options.state || {};
    var escapeAttr =
      options.escapeAttr ||
      function (v) {
        return String(v || '');
      };
    var escapeHtml =
      options.escapeHtml ||
      function (v) {
        return String(v || '');
      };
    var formatNumber =
      options.formatNumber ||
      function (v) {
        return String(v || 0);
      };
    var html = '';
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var indent = 12 + depth * 16;
      var isActive =
        state.currentView === 'folder' &&
        normalizePath(state.currentPath) === normalizePath(node.fullPath);
      var hasChildren = node.children.length > 0;
      if (hasChildren) {
        if (budget) budget.remaining -= 1;
        html += '<div class="tree-node">';
        html +=
          '<div class="folder-item tree-parent ' +
          (isActive ? 'active' : '') +
          '" style="padding-left:' +
          indent +
          'px;" data-folder-path="' +
          escapeAttr(node.fullPath) +
          '">' +
          '<span class="tree-toggle" data-tree-toggle="node">▶</span>' +
          '<span class="icon">\u{1F4C1}</span>' +
          '<span class="name" title="' +
          escapeHtml(node.fullPath) +
          '">' +
          escapeHtml(node.name) +
          '</span>' +
          '<span class="count">' +
          formatNumber(node.photoCount) +
          '</span>' +
          '</div>';
        html +=
          '<div class="tree-children" style="display:none;">' +
          renderTreeNodes(node.children, depth + 1, options, budget) +
          '</div>';
        html += '</div>';
      } else {
        if (budget) budget.remaining -= 1;
        html +=
          '<div class="folder-item ' +
          (isActive ? 'active' : '') +
          '" style="padding-left:' +
          (indent + 14) +
          'px;" data-folder-path="' +
          escapeAttr(node.fullPath) +
          '">' +
          '<span class="icon">\u{1F4C2}</span>' +
          '<span class="name" title="' +
          escapeHtml(node.fullPath) +
          '">' +
          escapeHtml(node.name) +
          '</span>' +
          '<span class="count">' +
          formatNumber(node.photoCount) +
          '</span>' +
          '</div>';
      }
    }
    return html;
  }

  function toggleTreeRoot(toggleEl, e) {
    e.stopPropagation();
    var treeRoot = toggleEl.closest('.tree-root');
    var children = treeRoot.querySelector(':scope > .tree-children');
    if (!children) return;
    if (children.style.display === 'none') {
      children.style.display = 'block';
      children.classList.add('expanded');
      toggleEl.textContent = '▼';
    } else {
      children.style.display = 'none';
      children.classList.remove('expanded');
      toggleEl.textContent = '▶';
    }
  }

  function toggleTreeNode(toggleEl, e) {
    e.stopPropagation();
    var treeNode = toggleEl.closest('.tree-node');
    var children = treeNode.querySelector(':scope > .tree-children');
    if (!children) return;
    if (children.style.display === 'none') {
      children.style.display = 'block';
      children.classList.add('expanded');
      toggleEl.textContent = '▼';
    } else {
      children.style.display = 'none';
      children.classList.remove('expanded');
      toggleEl.textContent = '▶';
    }
  }

  function isFolderPathAncestor(ancestor, descendant) {
    var a = normalizePath(ancestor)
      .replace(/[\\]+$/, '')
      .toLowerCase();
    var d = normalizePath(descendant)
      .replace(/[\\]+$/, '')
      .toLowerCase();
    if (!a || !d) return false;
    if (a === d) return true;
    return d.indexOf(a + '\\') === 0;
  }

  /** 在 #sidebarContent 内按路径定位目录行（优先 CSS 精确匹配，避免大目录下全表扫描） */
  function findFolderSidebarItemEl(targetPath) {
    var target = normalizePath(targetPath);
    if (!target) return null;
    var root = document.getElementById('sidebarContent');
    if (!root) return null;
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      try {
        var esc = CSS.escape(target);
        var hit =
          root.querySelector('[data-folder-path="' + esc + '"]') ||
          root.querySelector('[data-root-path="' + esc + '"]');
        if (hit) return hit;
      } catch (eSel) {}
    }
    var folderItems = root.querySelectorAll(
      '.folder-item[data-folder-path], .folder-item[data-root-path]',
    );
    for (var i = 0; i < folderItems.length; i++) {
      var p =
        folderItems[i].getAttribute('data-folder-path') ||
        folderItems[i].getAttribute('data-root-path');
      if (normalizePath(p) === target) return folderItems[i];
    }
    return null;
  }

  function expandTreeToFolder(targetPath) {
    var targetItem = findFolderSidebarItemEl(targetPath);
    if (!targetItem) return;
    var parent = targetItem.parentElement;
    while (parent && parent.id !== 'sidebarContent') {
      if (parent.classList && parent.classList.contains('tree-children')) {
        parent.style.display = 'block';
        parent.classList.add('expanded');
        var prev = parent.previousElementSibling;
        if (prev) {
          var toggle = prev.querySelector('.tree-toggle');
          if (toggle) toggle.textContent = '▼';
        }
      }
      parent = parent.parentElement;
    }
    // 点击到的目录若带子级，展开其下一层（tree-node 内子树或 tree-root 下第一层）
    if (targetItem.classList && targetItem.classList.contains('tree-parent')) {
      var host = targetItem.closest('.tree-node') || targetItem.closest('.tree-root');
      if (host) {
        var childWrap = host.querySelector(':scope > .tree-children');
        if (childWrap && String(childWrap.style.display || '').toLowerCase() !== 'block') {
          childWrap.style.display = 'block';
          childWrap.classList.add('expanded');
          var tgl = targetItem.querySelector('.tree-toggle');
          if (tgl && tgl.style.visibility !== 'hidden') tgl.textContent = '▼';
        }
      }
    }
  }

  function renderFolderTree(options) {
    options = options || {};
    var state = options.state || {};
    var prefetchedByRootId = options.prefetchedByRootId || null;
    var gate = options.gate || null;
    var sidebarContent = options.sidebarContent || null;
    var formatNumber =
      options.formatNumber ||
      function (v) {
        return String(v || 0);
      };
    var escapeAttr =
      options.escapeAttr ||
      function (v) {
        return String(v || '');
      };
    var escapeHtml =
      options.escapeHtml ||
      function (v) {
        return String(v || '');
      };
    if (!gate && state.currentTab !== 'folders') return;

    var html = '';
    if (!Array.isArray(state.rootFolders) || state.rootFolders.length === 0) {
      html =
        '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">' +
        tSide('sidebar.emptyNoFolders', '暂无文件夹<br>请点击「管理设置」添加') +
        '</div>';
    } else {
      var total = 0;
      for (var i = 0; i < state.rootFolders.length; i++) total += state.rootFolders[i].photo_count;
      html +=
        '<div class="folder-item ' +
        (state.currentView === 'all' ? 'active' : '') +
        '" data-sidebar-all="1" data-sidebar-view="dates-all">' +
        '<span class="icon">\u{1F5BC}\uFE0F</span>' +
        '<span class="name">' +
        escapeHtml(tSide('sidebar.allPhotos', '所有照片')) +
        '</span>' +
        '<span class="count">' +
        formatNumber(total) +
        '</span>' +
        '</div>';
      var favCount =
        state.stats && state.stats.favoritePhotos != null ? state.stats.favoritePhotos : 0;
      html +=
        '<div class="folder-item ' +
        (state.currentView === 'favorites' ? 'active' : '') +
        '" data-sidebar-favorites="1" data-sidebar-view="favorites">' +
        '<span class="icon">\u2B50</span>' +
        '<span class="name">' +
        escapeHtml(tSide('sidebar.favorites', '收藏')) +
        '</span>' +
        '<span class="count">' +
        formatNumber(favCount) +
        '</span>' +
        '</div>';
      var folderOverviewCount = 0;
      for (var k = 0; k < state.rootFolders.length; k++) {
        folderOverviewCount += Number(state.rootFolders[k].folder_count || 0);
      }
      html +=
        '<div class="folder-item ' +
        (state.currentView === 'folder_overview' ? 'active' : '') +
        '" data-sidebar-folder-overview="1" data-sidebar-view="folder-overview">' +
        '<span class="icon">\u{1F5C2}\uFE0F</span>' +
        '<span class="name">' +
        escapeHtml(tSide('sidebar.allFolders', '所有目录')) +
        '</span>' +
        '<span class="count">' +
        formatNumber(folderOverviewCount) +
        '</span>' +
        '</div>';

      for (var j = 0; j < state.rootFolders.length; j++) {
        var root = state.rootFolders[j];
        var rawFolders = prefetchedByRootId && prefetchedByRootId[root.id];
        if (!Array.isArray(rawFolders)) rawFolders = [];
        var normRootPath = normalizePath(root.path);
        var subFolders = rawFolders.filter(function (f) {
          return normalizePath(f.folder_path) !== normRootPath;
        });
        var tree = buildTree(root.path, subFolders);
        root._hasSubFolders = tree.length > 0;
        var isActive =
          state.currentView === 'folder' &&
          normalizePath(state.currentPath) === normalizePath(root.path);
        html += '<div class="tree-root">';
        html +=
          '<div class="folder-item tree-parent ' +
          (isActive ? 'active' : '') +
          '" data-root-id="' +
          root.id +
          '" data-root-path="' +
          escapeAttr(root.path) +
          '">' +
          (root._hasSubFolders
            ? '<span class="tree-toggle" data-tree-toggle="root">▼</span>'
            : '<span class="tree-toggle" style="visibility:hidden">▶</span>') +
          '<span class="icon">\u{1F4C1}</span>' +
          '<span class="name" title="' +
          escapeHtml(root.path) +
          '">' +
          escapeHtml(root.name) +
          '</span>' +
          '<button type="button" class="sidebar-root-rescan" data-root-path="' +
          escapeAttr(root.path) +
          '" title="' +
          escapeAttr(tSide('sidebar.rescanRootTitle', '子文件夹有移动、重命名等变更时，点此重新扫描')) +
          '" aria-label="' +
          escapeAttr(tSide('sidebar.rescanRootAria', '重新扫描此照片库')) +
          '">↻</button>' +
          '<span class="count">' +
          formatNumber(root.photo_count) +
          '</span>' +
          '</div>';
        html +=
          '<div class="tree-children' +
          (tree.length > 0 ? ' expanded' : '') +
          '" id="treeChildren-' +
          root.id +
          '" style="display:' +
          (tree.length > 0 ? 'block' : 'none') +
          ';">';
        if (tree.length > 0) {
          html += renderTreeNodes(tree, 1, {
            state: state,
            escapeAttr: escapeAttr,
            escapeHtml: escapeHtml,
            formatNumber: formatNumber,
          });
        }
        html += '</div></div>';
      }
    }

    if (gate) gate.render(html);
    else if (sidebarContent) sidebarContent.innerHTML = html;
  }

  /**
   * 大库：分根分帧写入 innerHTML + 扁平行分片 buildTree，避免单次长任务导致窗口「未响应」。
   */
  async function renderFolderTreeProgressive(options) {
    options = options || {};
    var st = options.state || {};
    var prefetchedByRootId = options.prefetchedByRootId || null;
    var gate = options.gate || null;
    var sidebarContent = options.sidebarContent || null;
    var formatNumber =
      options.formatNumber ||
      function (v) {
        return String(v || 0);
      };
    var escapeAttr =
      options.escapeAttr ||
      function (v) {
        return String(v || '');
      };
    var escapeHtml =
      options.escapeHtml ||
      function (v) {
        return String(v || '');
      };
    if (!gate && st.currentTab !== 'folders') return;

    var html = '';
    if (!Array.isArray(st.rootFolders) || st.rootFolders.length === 0) {
      html =
        '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">' +
        tSide('sidebar.emptyNoFolders', '暂无文件夹<br>请点击「管理设置」添加') +
        '</div>';
      if (gate) gate.render(html);
      else if (sidebarContent) sidebarContent.innerHTML = html;
      return;
    }

    var total = 0;
    for (var i = 0; i < st.rootFolders.length; i++) total += st.rootFolders[i].photo_count;
    html +=
      '<div class="folder-item ' +
      (st.currentView === 'all' ? 'active' : '') +
      '" data-sidebar-all="1" data-sidebar-view="dates-all">' +
      '<span class="icon">\u{1F5BC}\uFE0F</span>' +
      '<span class="name">' +
      escapeHtml(tSide('sidebar.allPhotos', '所有照片')) +
      '</span>' +
      '<span class="count">' +
      formatNumber(total) +
      '</span>' +
      '</div>';
    var favCount = st.stats && st.stats.favoritePhotos != null ? st.stats.favoritePhotos : 0;
    html +=
      '<div class="folder-item ' +
      (st.currentView === 'favorites' ? 'active' : '') +
      '" data-sidebar-favorites="1" data-sidebar-view="favorites">' +
      '<span class="icon">\u2B50</span>' +
      '<span class="name">' +
      escapeHtml(tSide('sidebar.favorites', '收藏')) +
      '</span>' +
      '<span class="count">' +
      formatNumber(favCount) +
      '</span>' +
      '</div>';
    var folderOverviewCount = 0;
    for (var k = 0; k < st.rootFolders.length; k++) {
      folderOverviewCount += Number(st.rootFolders[k].folder_count || 0);
    }
    html +=
      '<div class="folder-item ' +
      (st.currentView === 'folder_overview' ? 'active' : '') +
      '" data-sidebar-folder-overview="1" data-sidebar-view="folder-overview">' +
      '<span class="icon">\u{1F5C2}\uFE0F</span>' +
      '<span class="name">' +
      escapeHtml(tSide('sidebar.allFolders', '所有目录')) +
      '</span>' +
      '<span class="count">' +
      formatNumber(folderOverviewCount) +
      '</span>' +
      '</div>';

    var globalBudget = { remaining: SIDEBAR_TREE_MAX_RENDER_NODES, _hintAppended: false };
    var j;
    for (j = 0; j < st.rootFolders.length; j++) {
      var root = st.rootFolders[j];
      var rawFolders = prefetchedByRootId && prefetchedByRootId[root.id];
      if (!Array.isArray(rawFolders)) rawFolders = [];
      var normRootPath = normalizePath(root.path);
      var subFolders = rawFolders.filter(function (f) {
        return normalizePath(f.folder_path) !== normRootPath;
      });
      var tree;
      if (subFolders.length >= 1000) {
        tree = await buildTreeAsync(root.path, subFolders, SIDEBAR_TREE_FLAT_CHUNK);
      } else {
        tree = buildTree(root.path, subFolders);
      }
      root._hasSubFolders = tree.length > 0;
      var isActive =
        st.currentView === 'folder' &&
        normalizePath(st.currentPath) === normalizePath(root.path);
      html += '<div class="tree-root">';
      html +=
        '<div class="folder-item tree-parent ' +
        (isActive ? 'active' : '') +
        '" data-root-id="' +
        root.id +
        '" data-root-path="' +
        escapeAttr(root.path) +
        '">' +
        (root._hasSubFolders
          ? '<span class="tree-toggle" data-tree-toggle="root">▼</span>'
          : '<span class="tree-toggle" style="visibility:hidden">▶</span>') +
        '<span class="icon">\u{1F4C1}</span>' +
        '<span class="name" title="' +
        escapeHtml(root.path) +
        '">' +
        escapeHtml(root.name) +
        '</span>' +
        '<button type="button" class="sidebar-root-rescan" data-root-path="' +
        escapeAttr(root.path) +
        '" title="' +
        escapeAttr(tSide('sidebar.rescanRootTitle', '子文件夹有移动、重命名等变更时，点此重新扫描')) +
        '" aria-label="' +
        escapeAttr(tSide('sidebar.rescanRootAria', '重新扫描此照片库')) +
        '">↻</button>' +
        '<span class="count">' +
        formatNumber(root.photo_count) +
        '</span>' +
        '</div>';
      html +=
        '<div class="tree-children' +
        (tree.length > 0 ? ' expanded' : '') +
        '" id="treeChildren-' +
        root.id +
        '" style="display:' +
        (tree.length > 0 ? 'block' : 'none') +
        ';">';
      if (tree.length > 0) {
        html += renderTreeNodes(tree, 1, {
          state: st,
          escapeAttr: escapeAttr,
          escapeHtml: escapeHtml,
          formatNumber: formatNumber,
        }, globalBudget);
      }
      html += '</div></div>';

      if (gate) gate.render(html);
      else if (sidebarContent) sidebarContent.innerHTML = html;
      await new Promise(function (resolve) {
        requestAnimationFrame(resolve);
      });
      if (globalBudget.remaining <= 0) {
        break;
      }
    }
  }

  function folderTreeNeedsProgressiveRender(prefetchedByRootId, rootFolders) {
    if (!prefetchedByRootId || !Array.isArray(rootFolders)) return false;
    var maxOne = 0;
    var sum = 0;
    for (var r = 0; r < rootFolders.length; r++) {
      var row = prefetchedByRootId[rootFolders[r].id];
      var len = Array.isArray(row) ? row.length : 0;
      sum += len;
      if (len > maxOne) maxOne = len;
    }
    return sum >= SIDEBAR_TREE_PROGRESSIVE_FLAT_SUM_MIN || maxOne >= SIDEBAR_TREE_PROGRESSIVE_FLAT_ONE_MIN;
  }

  async function prefetchFolderTreeMap(options) {
    options = options || {};
    var rootFolders = Array.isArray(options.rootFolders) ? options.rootFolders : [];
    var getFolderTree = options.getFolderTree;
    var onlyRootIds = Array.isArray(options.onlyRootIds) ? options.onlyRootIds : null;
    if (!rootFolders.length || typeof getFolderTree !== 'function') return null;
    var allowMap = null;
    if (onlyRootIds && onlyRootIds.length > 0) {
      allowMap = Object.create(null);
      for (var ai = 0; ai < onlyRootIds.length; ai++) {
        var k = String(onlyRootIds[ai]);
        if (k) allowMap[k] = true;
      }
    }

    /** 顺序拉取 + 根与根之间双 rAF，避免多根并行 getFolderTree 挤爆主进程/磁盘导致首屏卡顿 */
    var out = {};
    var r;
    for (r = 0; r < rootFolders.length; r++) {
      var root = rootFolders[r];
      if (allowMap && !allowMap[String(root && root.id)]) continue;
      var folders = [];
      try {
        var raw = await getFolderTree(root.id);
        folders = Array.isArray(raw) ? raw : [];
      } catch (ePf) {
        folders = [];
      }
      out[root.id] = folders;
      /** 大 JSON 反序列化后让出主线程，减轻「拉完树数据窗口卡死」 */
      if (folders.length >= 800) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 0);
        });
      }
      if (r + 1 < rootFolders.length) {
        await new Promise(function (resolve) {
          requestAnimationFrame(function () {
            requestAnimationFrame(resolve);
          });
        });
      }
    }
    return out;
  }

  function scheduleExpandActiveFolder(options) {
    options = options || {};
    var state = options.state || {};
    var onExpandTreeToFolder = options.onExpandTreeToFolder;
    if (!(state.currentView === 'folder' && state.currentPath && state.currentTab === 'folders'))
      return;
    if (typeof onExpandTreeToFolder !== 'function') return;
    requestAnimationFrame(function () {
      onExpandTreeToFolder(state.currentPath);
    });
  }

  global.RendererSidebarTree = Object.assign({}, global.RendererSidebarTree || {}, {
    normalizePath: normalizePath,
    buildTree: buildTree,
    insertTreeNode: insertTreeNode,
    sortTree: sortTree,
    renderTreeNodes: renderTreeNodes,
    toggleTreeRoot: toggleTreeRoot,
    toggleTreeNode: toggleTreeNode,
    isFolderPathAncestor: isFolderPathAncestor,
    expandTreeToFolder: expandTreeToFolder,
    findFolderSidebarItemEl: findFolderSidebarItemEl,
    renderFolderTree: renderFolderTree,
    renderFolderTreeProgressive: renderFolderTreeProgressive,
    folderTreeNeedsProgressiveRender: folderTreeNeedsProgressiveRender,
    prefetchFolderTreeMap: prefetchFolderTreeMap,
    scheduleExpandActiveFolder: scheduleExpandActiveFolder,
  });
})(window);
