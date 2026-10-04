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

  /**
   * 深层子树懒渲染索引：rootId -> Map(规范化 fullPath -> 节点)。
   *
   * 背景：大库单根可达 3 万+ 目录，此前把整棵树一次性写进 innerHTML（实测 11MB / 3.6 万
   * 个 DOM 节点），首屏与后续每次「读侧栏 HTML / 查询侧栏节点」都要付这份代价。
   * 而视觉上只有已展开层可见（未展开层本就是 display:none），所以把「隐藏层」的 DOM
   * 推迟到首次展开时再按需创建 —— 观感完全一致，DOM 规模降一个数量级。
   */
  var lazyTreeByRoot = Object.create(null);
  /** 最近一次整树渲染的选项（懒物化子层时需要 escape/format/state） */
  var lazyRenderOptions = null;

  /** 给某根的树建索引：规范化路径 -> 节点（供懒物化时按路径取子级） */
  function indexTree(rootId, tree) {
    var map = new Map();
    (function walk(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        map.set(normalizePath(n.fullPath), n);
        if (n.children && n.children.length) walk(n.children);
      }
    })(tree || []);
    lazyTreeByRoot[String(rootId)] = map;
    return map;
  }

  /** 把懒容器的子层按需物化成真实 DOM（已物化则直接返回） */
  function materializeLazyChildren(containerEl) {
    if (!containerEl || typeof containerEl.getAttribute !== 'function') return false;
    var lazyPath = containerEl.getAttribute('data-lazy-path');
    if (lazyPath == null) return false;
    if (containerEl.getAttribute('data-lazy-ready') === '1') return true;
    var rootId = containerEl.getAttribute('data-lazy-root');
    var map = lazyTreeByRoot[String(rootId)];
    var node = map ? map.get(normalizePath(lazyPath)) : null;
    var kids = (node && node.children) || [];
    var opts = lazyRenderOptions || {};
    containerEl.innerHTML = renderTreeNodes(
      kids,
      Number(containerEl.getAttribute('data-lazy-depth')) || 2,
      {
        state: opts.state,
        escapeAttr: opts.escapeAttr,
        escapeHtml: opts.escapeHtml,
        formatNumber: opts.formatNumber,
        rootId: rootId,
      },
      null,
    );
    containerEl.setAttribute('data-lazy-ready', '1');
    return true;
  }

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
        // 子层懒渲染：只留一个带路径标记的空容器，首次展开时才物化 DOM
        html +=
          '<div class="tree-children" style="display:none;" data-lazy-root="' +
          escapeAttr(options.rootId != null ? String(options.rootId) : '') +
          '" data-lazy-path="' +
          escapeAttr(node.fullPath) +
          '" data-lazy-depth="' +
          (depth + 1) +
          '"></div>';
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
      materializeLazyChildren(children);
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
      materializeLazyChildren(children);
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

  /** 在给定容器内按路径精确定位目录行（优先 CSS 精确匹配，避免大目录下全表扫描） */
  function queryFolderRow(scope, pathValue, attrName) {
    if (!scope) return null;
    var attr = attrName || 'data-folder-path';
    var raw = String(pathValue || '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      // 渲染时 escapeAttr 会把反斜杠换成正斜杠，两种写法都试一次精确匹配
      var candidates = [raw, raw.replace(/\\/g, '/')];
      for (var c = 0; c < candidates.length; c++) {
        try {
          var hit = scope.querySelector('[' + attr + '="' + CSS.escape(candidates[c]) + '"]');
          if (hit) return hit;
        } catch (eSel) {}
      }
    }
    var rows = scope.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < rows.length; i++) {
      if (normalizePath(rows[i].getAttribute(attr)) === normalizePath(raw)) return rows[i];
    }
    return null;
  }

  /**
   * 展开到指定目录。深层子层是懒渲染的，DOM 里可能还不存在，
   * 因此这里改为「按数据链逐级物化 + 展开」，而不是依赖已在 DOM 中的祖先链。
   */
  function expandTreeToFolder(targetPath) {
    var target = normalizePath(targetPath);
    if (!target) return;
    var root = document.getElementById('sidebarContent');
    if (!root) return;

    // 1. 定位承载该路径的根目录行
    var rootRows = root.querySelectorAll('.tree-root > .folder-item.tree-parent[data-root-path]');
    var hostRow = null;
    for (var i = 0; i < rootRows.length; i++) {
      if (isFolderPathAncestor(rootRows[i].getAttribute('data-root-path'), target)) {
        hostRow = rootRows[i];
        break;
      }
    }
    if (!hostRow) return;
    var hostRoot = hostRow.closest('.tree-root');
    if (!hostRoot) return;
    var container = hostRoot.querySelector(':scope > .tree-children');
    if (!container) return;

    // 2. 展开根层（目标就是根目录本身时到此为止）
    if (String(container.style.display || '').toLowerCase() !== 'block') {
      materializeLazyChildren(container);
      container.style.display = 'block';
      container.classList.add('expanded');
      var rootToggle = hostRow.querySelector('.tree-toggle');
      if (rootToggle && rootToggle.style.visibility !== 'hidden') rootToggle.textContent = '▼';
    }
    if (normalizePath(hostRow.getAttribute('data-root-path')) === target) return;

    // 3. 按路径前缀逐级物化并展开，直到目标行（含目标自身的下一层，与旧行为一致）。
    //    只用路径前缀推进，不依赖节点之间的引用关系，数据与 DOM 不同步时也不会断链。
    var rootPath = normalizePath(hostRow.getAttribute('data-root-path')).replace(/[\\]+$/, '');
    var rel = target.slice(rootPath.length).replace(/^[\\]+/, '');
    if (!rel) return;
    var parts = rel.split(/[\\]+/);
    var acc = rootPath;
    for (var k = 0; k < parts.length; k++) {
      acc = acc + '\\' + parts[k];
      materializeLazyChildren(container);
      var row = queryFolderRow(container, acc, 'data-folder-path');
      if (!row) return;
      var wrap = row.closest('.tree-node');
      if (!wrap) return; // 叶子目录：没有可展开的子层
      var next = wrap.querySelector(':scope > .tree-children');
      if (!next) return;
      materializeLazyChildren(next);
      next.style.display = 'block';
      next.classList.add('expanded');
      var tg = row.querySelector('.tree-toggle');
      if (tg && tg.style.visibility !== 'hidden') tg.textContent = '▼';
      container = next;
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

    lazyRenderOptions = {
      state: state,
      escapeAttr: escapeAttr,
      escapeHtml: escapeHtml,
      formatNumber: formatNumber,
    };

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
        indexTree(root.id, tree);
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
          escapeAttr(
            tSide('sidebar.rescanRootTitle', '子文件夹有移动、重命名等变更时，点此重新扫描'),
          ) +
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
            rootId: root.id,
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

    lazyRenderOptions = {
      state: st,
      escapeAttr: escapeAttr,
      escapeHtml: escapeHtml,
      formatNumber: formatNumber,
    };

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
      indexTree(root.id, tree);
      root._hasSubFolders = tree.length > 0;
      var isActive =
        st.currentView === 'folder' && normalizePath(st.currentPath) === normalizePath(root.path);
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
        escapeAttr(
          tSide('sidebar.rescanRootTitle', '子文件夹有移动、重命名等变更时，点此重新扫描'),
        ) +
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
        html += renderTreeNodes(
          tree,
          1,
          {
            state: st,
            escapeAttr: escapeAttr,
            escapeHtml: escapeHtml,
            formatNumber: formatNumber,
            rootId: root.id,
          },
          globalBudget,
        );
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
    return (
      sum >= SIDEBAR_TREE_PROGRESSIVE_FLAT_SUM_MIN ||
      maxOne >= SIDEBAR_TREE_PROGRESSIVE_FLAT_ONE_MIN
    );
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

    /** 先过滤出需要拉取的根目录 */
    var filteredRoots = [];
    for (var f = 0; f < rootFolders.length; f++) {
      var root = rootFolders[f];
      if (allowMap && !allowMap[String(root && root.id)]) continue;
      filteredRoots.push(root);
    }

    /** 并行拉取（每批最多3个，匹配 worker pool 大小）+ 批次间双 rAF，避免同步阻塞首屏 */
    var out = {};
    var batchSize = 3;
    for (var i = 0; i < filteredRoots.length; i += batchSize) {
      var batch = filteredRoots.slice(i, i + batchSize);
      var results = await Promise.all(
        batch.map(function (root) {
          return getFolderTree(root.id)
            .then(function (raw) {
              return Array.isArray(raw) ? raw : [];
            })
            .catch(function () {
              return [];
            });
        }),
      );
      for (var b = 0; b < batch.length; b++) {
        out[batch[b].id] = results[b];
      }
      /** 大 JSON 反序列化后让出主线程，减轻「拉完树数据窗口卡死」 */
      var hasLarge = results.some(function (r) {
        return r.length >= 800;
      });
      if (hasLarge) {
        await new Promise(function (resolve) {
          setTimeout(resolve, 0);
        });
      }
      /** 批次间让出，避免同步阻塞首屏 */
      if (i + batchSize < filteredRoots.length) {
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
    indexTree: indexTree,
    materializeLazyChildren: materializeLazyChildren,
    queryFolderRow: queryFolderRow,
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
