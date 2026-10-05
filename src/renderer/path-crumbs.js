(function (global) {
  /**
   * 路径栏（面包屑）—— 分段 + 渲染 + 交互。
   *
   * 为什么单独成模块：这块逻辑密度不低（路径分段 / 超长折叠 / 同级目录下拉 /
   * 事件委托 / 关闭时机），而且**必须能脱离 DOM 与 app 的全局 state 单测** ——
   * 分段算法只要给一组 rootFolders 就应该能算出来。所以：
   *   - `buildSegments` / `visibleSegments` / `parentPathOf` / `renderHtml` 是纯函数；
   *   - 唯一调度口是 `mount()`，它返回一个薄的实例 API；
   *   - 模块**不直接读 app 的 state**，一律走 `deps` 回调（getState / t / escapeHtml …），
   *     于是它只依赖「给了什么」，不依赖「app 在哪」。
   *
   * 同级目录的数据源是 `deps.queryChildFolders`（调用方接到 sidebar-tree 的内存树索引）。
   * **拿不到就整块不显示下拉** —— 宁可没有下拉，也不要一个点了没反应的。
   */
  'use strict';

  /** 面包屑最多显示几段（含第一段「所有目录」），超出则折起中间段 */
  var CRUMB_MAX_VISIBLE = 4;

  var tZh = {
    'path.crumbRoot': '所有目录',
    'path.crumbExpand': '展开完整路径',
    'path.crumbSwitch': '切换到同级目录',
    'path.upToFmt': '返回上级：{name}',
    'path.folderOverview': '\u{1F5C2}\uFE0F 所有目录',
  };

  function fallbackT(key) {
    return tZh[key] || '';
  }

  /**
   * 路径的父目录；已是根目录、或拿不到更上层时返回 ''。
   * @param {string} folderPath
   * @param {Array} rootFolders
   * @param {object} deps 需 `normalizePath`
   */
  function parentPathOf(folderPath, rootFolders, deps) {
    var path = deps.normalizePath(folderPath);
    if (!path) return '';
    var roots = Array.isArray(rootFolders) ? rootFolders : [];
    for (var i = 0; i < roots.length; i++) {
      if (deps.normalizePath(roots[i].path) === path) return '';
    }
    var lastSep = path.lastIndexOf('\\');
    if (lastSep <= 0) return '';
    return path.substring(0, lastSep);
  }

  /**
   * 当前路径 → 面包屑分段。第一段固定是「所有目录」（`path: ''` 表示虚拟顶层）。
   * 命中根目录时「整根路径算一段」并显示根目录名（否则 `K:` / `COS` 会各占一段，
   * 而侧栏树里它们本来就是一行）。
   *
   * @returns {Array<{name:string, path:string, isOverview?:boolean}>}
   */
  function buildSegments(folderPath, rootFolders, deps) {
    var path = deps.normalizePath(folderPath);
    if (!path) return [];
    var segs = [{ name: deps.t('path.crumbRoot'), path: '', isOverview: true }];
    var roots = Array.isArray(rootFolders) ? rootFolders : [];
    var hitRoot = null;
    for (var i = 0; i < roots.length; i++) {
      var rp = deps.normalizePath(roots[i].path);
      // isFolderPathAncestor 对「相等」也返回 true，故不必另判
      if (deps.isAncestorOf(rp, path)) {
        hitRoot = { path: rp, name: roots[i].name || rp };
        break;
      }
    }
    var acc = '';
    var rest = path;
    if (hitRoot) {
      segs.push({ name: hitRoot.name, path: hitRoot.path });
      acc = hitRoot.path;
      rest = path.slice(hitRoot.path.length).replace(/^[\\]+/, '');
    }
    var parts = rest ? rest.split(/[\\]+/) : [];
    for (var k = 0; k < parts.length; k++) {
      acc = acc ? acc + '\\' + parts[k] : parts[k];
      segs.push({ name: parts[k], path: acc });
    }
    return segs;
  }

  /**
   * 折起中间段：段数超限时保留第一段与末两段，中间一个省略号。
   * 首段一定要留（那是回总览的唯一入口），末两段一定要留（当前层 + 它的同级上下文）。
   * @returns {Array<{seg:object}|{ellipsis:true}>}
   */
  function visibleSegments(segs, expanded) {
    if (expanded || segs.length <= CRUMB_MAX_VISIBLE) {
      return segs.map(function (s) {
        return { seg: s };
      });
    }
    return [
      { seg: segs[0] },
      { ellipsis: true },
      { seg: segs[segs.length - 2] },
      { seg: segs[segs.length - 1] },
    ];
  }

  /**
   * 与某目录**同级**的目录列表（末段下拉的数据源）。
   *
   * ⚠️ 注意与 `deps.queryChildFolders` 的区别：那个给的是**子**目录，这里要的是
   * **兄弟**目录 —— 下拉的用途是「横向换到同级的另一个目录」，所以取的是**父目录的
   * 子目录列表**。第一版直接拿了子目录，结果在叶子目录上点开永远是空的。
   *
   * 无父（即本身是根目录）时，同级 = 其他根目录（`COS` 的同级是 `T`）。
   *
   * @returns {Array<{name:string, fullPath:string, photoCount:number}>|null} null = 数据不可用
   */
  function siblingsOf(folderPath, rootFolders, deps) {
    var path = deps.normalizePath(folderPath);
    if (!path) return null;
    var parent = parentPathOf(path, rootFolders, deps);
    if (parent) return deps.queryChildFolders(parent);
    var roots = Array.isArray(rootFolders) ? rootFolders : [];
    if (!roots.length) return null;
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      out.push({
        name: roots[i].name || deps.normalizePath(roots[i].path),
        fullPath: deps.normalizePath(roots[i].path),
        // 根目录的计数字段是 snake_case（树节点是 camelCase），这里统一成 photoCount
        photoCount: Number(roots[i].photo_count) || 0,
      });
    }
    return out;
  }

  /** 面包屑的 HTML（纯字符串，便于单测与快照） */
  function renderHtml(segs, expanded, deps) {
    if (!segs || segs.length <= 1) return '';
    var lastPath = segs[segs.length - 1].path;
    var items = visibleSegments(segs, expanded);
    var html = '';
    for (var i = 0; i < items.length; i++) {
      if (i > 0) html += '<span class="path-crumb-sep" aria-hidden="true"></span>';
      if (items[i].ellipsis) {
        var expandLabel = deps.t('path.crumbExpand');
        html +=
          '<button type="button" class="path-crumb is-ellipsis" data-crumb-expand="1"' +
          ' title="' +
          deps.escapeAttr(expandLabel) +
          '" aria-label="' +
          deps.escapeAttr(expandLabel) +
          '"></button>';
        continue;
      }
      var seg = items[i].seg;
      if (seg.path === lastPath) {
        html +=
          '<button type="button" class="path-crumb is-current" data-crumb-current="1"' +
          ' aria-haspopup="menu" aria-expanded="false" title="' +
          deps.escapeAttr(deps.t('path.crumbSwitch')) +
          '">' +
          deps.escapeHtml(seg.name) +
          '</button>';
      } else {
        html +=
          '<button type="button" class="path-crumb' +
          (seg.isOverview ? ' is-overview' : '') +
          '" data-crumb-path="' +
          deps.escapeAttr(seg.path) +
          '" title="' +
          deps.escapeAttr(seg.path || seg.name) +
          '">' +
          deps.escapeHtml(seg.name) +
          '</button>';
      }
    }
    return html;
  }

  /**
   * 挂载路径栏。deps 必需项：
   *   normalizePath / isAncestorOf / queryChildFolders / getState / t / escapeHtml /
   *   escapeAttr / formatNumber / onNavigateFolder / onNavigateOverview
   *
   * @returns {{refresh:Function, updateUp:Function, close:Function, isOpen:Function, bind:Function}}
   */
  function mount(options) {
    options = options || {};
    var bar = options.bar || null;
    var host = options.host || null;
    var up = options.up || null;
    var deps = options.deps || {};

    // 折起态是「这次想看清楚」的临时意图：不持久化，且换目录就重置（见 refresh）
    var expanded = false;
    var expandedForKey = '';
    var menu = null;

    function menuEl() {
      if (menu && menu.parentNode === bar) return menu;
      menu = null;
      return bar ? bar.querySelector('.path-crumb-menu') : null;
    }

    function ensureMenu() {
      var el = menuEl();
      if (el) return el;
      if (!bar) return null;
      menu = document.createElement('div');
      menu.className = 'path-crumb-menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      bar.appendChild(menu);
      return menu;
    }

    function isOpen() {
      var el = menuEl();
      return !!(el && !el.hidden);
    }

    function currentCrumbBtn() {
      return host ? host.querySelector('.path-crumb.is-current') : null;
    }

    function close() {
      var el = menuEl();
      if (!el || el.hidden) return;
      el.hidden = true;
      var btn = currentCrumbBtn();
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function open(anchor) {
      var el = ensureMenu();
      if (!el || !anchor || !deps.queryChildFolders) return;
      var st = deps.getState() || {};
      // 数据拿不到（树还没渲染过）就不开 —— 宁可没有下拉，也不要一个点了没反应的
      var siblings = siblingsOf(st.currentPath, st.rootFolders, deps);
      if (!siblings || !siblings.length) return;
      var current = deps.normalizePath(st.currentPath);
      // 同级里只有自己（没有别的可换）时也不必开：开了只有一行「当前」，
      // 用户点了没任何变化，比没有下拉更差。
      var hasOther = false;
      for (var s = 0; s < siblings.length; s++) {
        if (deps.normalizePath(siblings[s].fullPath) !== current) {
          hasOther = true;
          break;
        }
      }
      if (!hasOther) return;
      var html = '';
      for (var i = 0; i < siblings.length; i++) {
        var node = siblings[i];
        var isSelf = deps.normalizePath(node.fullPath) === current;
        html +=
          '<button type="button" role="menuitem" class="path-crumb-item' +
          (isSelf ? ' is-current' : '') +
          '" data-crumb-sibling="' +
          deps.escapeAttr(node.fullPath) +
          '"' +
          (isSelf ? ' aria-current="true"' : '') +
          '><span class="path-crumb-item-name">' +
          deps.escapeHtml(node.name) +
          '</span><span class="path-crumb-item-count">' +
          deps.formatNumber(node.photoCount || 0) +
          '</span></button>';
      }
      el.innerHTML = html;
      el.hidden = false;
      anchor.setAttribute('aria-expanded', 'true');
      // 先按锚点左缘摆，再按容器宽度纠一次 —— 末段靠右时菜单会溢出路径栏
      var barBox = bar.getBoundingClientRect();
      var btnBox = anchor.getBoundingClientRect();
      el.style.left = Math.round(btnBox.left - barBox.left) + 'px';
      var overflow = el.offsetLeft + el.offsetWidth - bar.clientWidth;
      if (overflow > 0) el.style.left = Math.max(0, el.offsetLeft - overflow) + 'px';
    }

    function refresh() {
      if (!host) return;
      // 面包屑是整体重写（innerHTML），先关掉可能开着的下拉：
      // 否则末段按钮被换掉后，菜单还挂着一个已失效的锚点。
      close();
      var st = deps.getState() || {};
      var segs = buildSegments(st.currentPath, st.rootFolders, deps);
      if (segs.length <= 1) {
        host.textContent = deps.t('path.folderOverview');
        expandedForKey = '';
        expanded = false;
        return;
      }
      var key = deps.normalizePath(st.currentPath);
      if (key !== expandedForKey) {
        expandedForKey = key;
        expanded = false;
      }
      host.innerHTML = renderHtml(segs, expanded, deps);
    }

    function updateUp() {
      if (!up) return;
      var st = deps.getState() || {};
      var parent =
        st.currentView === 'folder' && st.currentPath
          ? parentPathOf(st.currentPath, st.rootFolders, deps)
          : '';
      if (!parent) {
        up.hidden = true;
        up.removeAttribute('data-parent-path');
        return;
      }
      up.hidden = false;
      up.setAttribute('data-parent-path', parent);
      // 父目录名只进 title/aria：面包屑的倒数第二段已经在表达同一件事，
      // 按钮上再写一遍就重复占位了（窄侧栏尤其明显）。
      var name = parent.split('\\').pop() || parent;
      var label = deps.tFmt
        ? deps.tFmt('path.upToFmt', { name: name })
        : String(fallbackT('path.upToFmt')).replace('{name}', name);
      up.setAttribute('title', label);
      up.setAttribute('aria-label', label);
    }

    function onUpClick() {
      if (!up) return;
      var parent = up.getAttribute('data-parent-path');
      if (parent) deps.onNavigateFolder(parent);
    }

    function onClick(e) {
      var t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      var sibling = t.closest('[data-crumb-sibling]');
      if (sibling) {
        e.preventDefault();
        var sibPath = sibling.getAttribute('data-crumb-sibling');
        close();
        var st = deps.getState() || {};
        var current = st.currentPath ? deps.normalizePath(st.currentPath) : '';
        if (sibPath && deps.normalizePath(sibPath) !== current) deps.onNavigateFolder(sibPath);
        return;
      }
      var expand = t.closest('[data-crumb-expand]');
      if (expand) {
        e.preventDefault();
        expanded = true;
        var stEx = deps.getState() || {};
        var segs = buildSegments(stEx.currentPath, stEx.rootFolders, deps);
        if (host) host.innerHTML = renderHtml(segs, true, deps);
        return;
      }
      var currentBtn = t.closest('[data-crumb-current]');
      if (currentBtn) {
        e.preventDefault();
        if (isOpen()) close();
        else open(currentBtn);
        return;
      }
      var crumb = t.closest('[data-crumb-path]');
      if (crumb) {
        e.preventDefault();
        close();
        var path = crumb.getAttribute('data-crumb-path');
        if (path) deps.onNavigateFolder(path);
        else deps.onNavigateOverview(); // data-crumb-path="" 即第一段「所有目录」
      }
    }

    function onDocMouseDown(e) {
      if (!isOpen()) return;
      var t = e.target;
      if (t && typeof t.closest === 'function') {
        if (t.closest('.path-crumb-menu')) return;
        if (t.closest('[data-crumb-current]')) return; // 交给 click 处理器 toggle，别在这里先关
      }
      close();
    }

    function onDocKeyDown(e) {
      if (e.key !== 'Escape' || !isOpen()) return;
      close();
      var btn = currentCrumbBtn();
      if (btn) btn.focus();
    }

    /** 绑事件（每个元素各一次，不随渲染反复绑） */
    function bind() {
      if (host) host.addEventListener('click', onClick);
      if (up) up.addEventListener('click', onUpClick);
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onDocKeyDown);
    }

    return { refresh: refresh, updateUp: updateUp, close: close, isOpen: isOpen, bind: bind };
  }

  global.RendererPathCrumbs = Object.assign({}, global.RendererPathCrumbs || {}, {
    CRUMB_MAX_VISIBLE: CRUMB_MAX_VISIBLE,
    parentPathOf: parentPathOf,
    buildSegments: buildSegments,
    siblingsOf: siblingsOf,
    visibleSegments: visibleSegments,
    renderHtml: renderHtml,
    mount: mount,
  });
})(window);
