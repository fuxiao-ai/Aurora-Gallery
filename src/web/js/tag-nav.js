/**
 * 网页端「标签导航页」：侧栏三级树（分类 → 子类 → 标签）+ 主区卡片 / 照片网格。
 *
 * ## 与桌面端的关系
 *
 * 契约同源、实现各一份 —— 与 `ai-views.js` / `people.js` 的做法一致：
 *   · **只有标签叶子走照片网格**。父节点（分类 / 子类）主区是标签卡片，只做下钻。
 *     原因是规模：索引铺满 165 万张时 `WHERE tag_id IN (…) GROUP BY photo_id` 是
 *     全节点行数的聚合（约 9000 万行），会变成几十秒的阻塞，界面上与「点了没反应」
 *     无法区分（详见 `src/renderer/tag-nav-ui.js` 文件头，那份写得更长）。
 *   · **树是懒的**：子类展开才取 `/api/tag-nav-node`，结果缓存；折叠态不进任何持久化。
 *   · **展开态双写**：`.expanded` 类 + 行内 `display`。gallery-design.css 里那条
 *     `.tree-children:not(.expanded) { display:none }`（两端同源）会把只去行内 display
 *     的展开层再藏回去 —— 箭头转了、内容不出来，DOM 里一切正常。
 *   · **缩进口径**：行内 `padding-left` 是唯一来源，`.tree-children` 保持 0。
 *
 * ## 语言
 *
 * `index.html` 硬编码 `lang="zh-CN"`，模块间通行的是 `document.documentElement.lang`
 * 这个约定（`ai-views.js#isEn`）。标签**显示名**由服务端按 `?locale=` 给
 * （`main/tag-nav.js#node`），所以切语言时只要按新 locale 重取即可 —— 本文件照这个
 * 约定实现 `refreshLocale`，不内置一份 81 条的分类名映射（分类 / 子类名用服务端的
 * `label` 兜底，web 端当前只有中文一种 shipped 语言）。
 */
(function (global) {
  'use strict';

  /*
   * 🔴 搜索**不是实时**的：敲字不发请求，只有**显式提交**才发（回车 / 点右侧那个按钮）。
   * 以前是 `SEARCH_DEBOUNCE_MS = 180` 的防抖，每敲一个字符都打一次 `/api/tag-nav-search`，
   * 主进程要遍历 5813 条标签名 —— 防抖只是把「敲 7 个字母发 7 次」压成「停顿后发 1 次」，
   * 边打边扫的代价一点没省，而且「打一半的词也在搜」本身就是错的。契约与桌面端逐条一致，
   * 见 src/renderer/tag-nav-ui.js 顶部同一段注释。
   */

  function init(deps) {
    deps = deps || {};
    var state = deps.state || {};
    var get =
      deps.get ||
      function () {
        return Promise.reject(new Error('no transport'));
      };
    var escapeHtml =
      deps.escapeHtml ||
      function (s) {
        return s == null ? '' : String(s);
      };
    var escapeAttr = deps.escapeAttr || escapeHtml;
    /** 数字压缩（侧栏窄）：与 ai-views.js 同一条规则，但那边没导出，这里各写一份。 */
    var compactCount =
      deps.compactCount ||
      function (value) {
        var n = Number(value) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + '万';
        if (n >= 10000) return (n / 10000).toFixed(n >= 100000000 ? 0 : 1) + '万';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
      };
    /** 选中标签 / 换卡片后要刷新主区 —— 由 app.js 注入（它自己走 loadPhotos 通路）。 */
    var onPhotosChanged = deps.onPhotosChanged || function () {};
    /** 卡片之外还要跟着变的 chrome（网页端只有标题栏那一行）。 */
    var onChromeRefresh = deps.onChromeRefresh || function () {};

    var expanded = Object.create(null);
    var tagPath = Object.create(null);
    var treeData = [];
    var statusData = { available: false, tags: 0, photos: 0 };
    var subTags = Object.create(null);
    var pending = Object.create(null);
    /** 搜索结果 `{tags, nodes}`；null = 没在搜索。**搜索态的唯一判据就是它**（不是 `keyword`）。 */
    var searchResult = null;
    /** 输入框里现在的文字。**含还没提交的** ⇒ 非空 ≠ 在搜索态（见 `lastQuery`）。 */
    var keyword = '';
    /** **已经提交并生效**的查询词。`''` = 没在搜索。只在 `runSearch` 里赋值、`exitSearch`/`leave` 里清。 */
    var lastQuery = '';
    var searchToken = 0;
    var subToken = Object.create(null);
    var cardsSeq = 0;
    /** enter() 的代次：快速切页时旧的那次回包不许再写侧栏。 */
    var enterToken = 0;

    function isEn() {
      return String(document.documentElement.lang || '').startsWith('en');
    }
    function t(zh, en) {
      return isEn() ? en : zh;
    }
    function locale() {
      return isEn() ? 'en' : 'zh-CN';
    }
    function esc(s) {
      return escapeHtml(s);
    }
    function escAttr(s) {
      return escapeAttr(s);
    }

    function findNodeMeta(kind, id) {
      for (var i = 0; i < treeData.length; i++) {
        if (kind === 'category') {
          if (treeData[i].id === id) return treeData[i];
        } else {
          var subs = treeData[i].subs || [];
          for (var j = 0; j < subs.length; j++) if (subs[j].id === id) return subs[j];
        }
      }
      return null;
    }

    /** 分类 / 子类的显示名：i18n 没有词表，用服务端 `label` 兜底（见文件头「语言」）。 */
    function nodeName(kind, id) {
      var meta = findNodeMeta(kind, id);
      return (meta && (meta.label || meta.id)) || id;
    }

    function categoryOfSub(subId) {
      for (var i = 0; i < treeData.length; i++) {
        var subs = treeData[i].subs || [];
        for (var j = 0; j < subs.length; j++) if (subs[j].id === subId) return treeData[i].id;
      }
      return '';
    }

    function rememberPath(tag, node, category) {
      var t0 = String(tag || '');
      if (!t0) return;
      var prev = tagPath[t0] || {};
      tagPath[t0] = { node: node || prev.node || '', category: category || prev.category || '' };
    }

    function rememberPaths(list, fallbackNode) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var n = it.node || fallbackNode || '';
        rememberPath(it.tag, n, it.category || (n ? categoryOfSub(n) : ''));
      }
    }

    function isSubId(id) {
      for (var i = 0; i < treeData.length; i++) {
        var subs = treeData[i].subs || [];
        for (var j = 0; j < subs.length; j++) if (subs[j].id === id) return true;
      }
      return false;
    }

    // ---------------------------------------------------------------- 侧栏
    function sidebarEl() {
      return document.getElementById('sidebarContent');
    }

    function rowIndent(depth) {
      return 12 + depth * 14;
    }
    function leafIndent(depth) {
      return 12 + depth * 14 + 26;
    }
    function guideX(depth) {
      return 12 + depth * 14 + 9;
    }

    function treeRowHtml(o) {
      var depth = o.depth || 0;
      var indent = o.leaf ? leafIndent(depth) : rowIndent(depth);
      var cls = 'folder-item web-tag-nav-row';
      if (!o.leaf) cls += ' tree-parent';
      if (o.active) cls += ' active';
      if (o.dim) cls += ' is-dim';
      var attrs =
        ' data-tag-nav-kind="' + escAttr(o.kind) + '" data-tag-nav-id="' + escAttr(o.id || '') + '"';
      if (o.node || o.category) {
        attrs +=
          ' data-tag-nav-node="' +
          escAttr(o.node || '') +
          '" data-tag-nav-cat="' +
          escAttr(o.category || '') +
          '"';
      }
      var html = '<div class="' + cls + '"' + attrs + ' style="padding-left:' + indent + 'px"';
      if (o.title) html += ' title="' + escAttr(o.title) + '"';
      html += '>';
      if (!o.leaf) {
        html += '<span class="tree-toggle' + (o.open ? ' is-expanded' : '') + '" data-tag-toggle="1" role="presentation"></span>';
      } else {
        html += '<span class="web-tag-nav-dot" aria-hidden="true"></span>';
      }
      html += '<span class="name">' + esc(o.label) + '</span>';
      if (o.count) html += '<span class="count">' + esc(o.count) + '</span>';
      html += '</div>';
      return html;
    }

    function childrenAttrs(id, isOpen, depth) {
      return (
        ' class="tree-children web-tag-nav-children' + (isOpen ? ' expanded' : '') +
        '" data-tag-children-for="' + escAttr(id) +
        '" style="display:' + (isOpen ? 'block' : 'none') +
        ';--tree-guide-x:' + guideX(depth) + 'px"' +
        (isOpen ? '' : ' data-tag-lazy="1"')
      );
    }

    /**
     * 某个子类下的标签叶子。
     *
     * @param {number} indexed 这个子类里**已出现在索引中**的标签数（父行上那个数字，来自 tree）。
     *   ⚠️ 列表已被展示线过滤（服务端唯一源），所以「有条目数为 0」是正常的：
     *   `indexed > 0` 而列表为空 = 都低于展示线，与「这儿还没索引」是两种空。
     */
    function tagLeavesHtml(subId, depth, indexed) {
      var entry = subTags[subId];
      if (entry === undefined) {
        return '<div class="web-tag-nav-loading" style="padding-left:' + leafIndent(depth) + 'px">' + esc(t('正在搜索…', 'Searching…')) + '</div>';
      }
      if (entry === null) {
        return '<div class="web-tag-nav-empty">' + esc(t('标签数据读取失败，请稍后重试', 'Failed to load tags, try again later')) + '</div>';
      }
      if (!entry.length) {
        return '<div class="web-tag-nav-empty">' + esc(
          Number(indexed) > 0
            ? t('{count} 个标签都低于当前展示线', 'All {count} tags are below the current display threshold').replace('{count}', compactCount(indexed))
            : t('这个节点下还没有已建立索引的标签', 'No indexed tags under this node yet'),
        ) + '</div>';
      }
      var out = '';
      for (var i = 0; i < entry.length; i++) {
        var tag = entry[i];
        out += treeRowHtml({
          kind: 'tag',
          id: tag.tag,
          label: tag.name,
          depth: depth,
          leaf: true,
          // 服务端已保证 count > 0（0 命中的标签不在这个列表里），不再有「置灰 / 不显示数字」那一档。
          count: compactCount(tag.count),
          active: state.currentTag === tag.tag,
          title: tag.tag,
        });
      }
      return out;
    }

    function subsHtml(cat) {
      var out = '';
      for (var i = 0; i < cat.subs.length; i++) {
        var sub = cat.subs[i];
        var isOpen = !!expanded[sub.id];
        out += '<div class="tree-node">';
        out += treeRowHtml({
          kind: 'sub',
          id: sub.id,
          label: nodeName('sub', sub.id),
          depth: 1,
          leaf: false,
          open: isOpen,
          count: sub.tagIndexed ? compactCount(sub.tagIndexed) : '',
          dim: !sub.tagIndexed,
          active: state.currentTagNode === sub.id,
          title: t('共 {t} 个标签，已有 {i} 个', '{t} tags total, {i} indexed')
            .replace('{t}', sub.tagTotal)
            .replace('{i}', sub.tagIndexed),
        });
        out += '<div' + childrenAttrs(sub.id, isOpen, 1) + '>';
        // 父行已有的 tagIndexed 传下去当空态判据 —— 叶子那层不必再问一次服务端。
        if (isOpen) out += tagLeavesHtml(sub.id, 2, sub.tagIndexed);
        out += '</div>';
        out += '</div>';
      }
      return out;
    }

    function listHtml() {
      if (searchResult) return searchListHtml();
      if (!treeData.length) return '<div class="web-tag-nav-empty">' + esc(t('标签索引还没建好。', 'The tag index is not built yet.')) + '</div>';
      var html = '';
      html += treeRowHtml({
        kind: 'root',
        id: '',
        label: t('全部标签', 'All tags'),
        depth: 0,
        leaf: true,
        count: statusData.available ? compactCount(statusData.tags) : '',
        active: !state.currentTag && !state.currentTagNode,
      });
      for (var i = 0; i < treeData.length; i++) {
        var cat = treeData[i];
        var isOpen = !!expanded[cat.id];
        html += treeRowHtml({
          kind: 'category',
          id: cat.id,
          label: nodeName('category', cat.id),
          depth: 0,
          leaf: false,
          open: isOpen,
          count: cat.tagIndexed ? compactCount(cat.tagIndexed) : '',
          dim: !cat.tagIndexed,
          active: state.currentTagNode === cat.id,
          title: t('共 {t} 个标签，已有 {i} 个', '{t} tags total, {i} indexed')
            .replace('{t}', cat.tagTotal)
            .replace('{i}', cat.tagIndexed),
        });
        html += '<div' + childrenAttrs(cat.id, isOpen, 0) + '>';
        if (isOpen) html += subsHtml(cat);
        html += '</div>';
      }
      return html;
    }

    function searchListHtml() {
      var res = searchResult;
      var out = '';
      var hasNodes = res.nodes && res.nodes.length;
      var hasTags = res.tags && res.tags.length;
      if (!hasNodes && !hasTags) {
        // 同 tagLeavesHtml：indexed（过滤前命中数）> 0 = 匹配到了但都低于展示线，
        // 与「一个都没匹配上」是两种空（前者去调展示线，后者去改关键词）。
        return '<div class="web-tag-nav-empty">' + esc(
          Number(res.indexed) > 0
            ? t('{count} 个标签都低于当前展示线', 'All {count} tags are below the current display threshold').replace('{count}', compactCount(res.indexed))
            : t('没有匹配的标签', 'No matching tags'),
        ) + '</div>';
      }
      if (hasNodes) {
        out += '<div class="web-tag-nav-group">' + esc(t('分类与子类', 'Categories')) + '</div>';
        for (var i = 0; i < res.nodes.length; i++) {
          var n = res.nodes[i];
          var isCat = n.kind === 'category';
          out += treeRowHtml({
            kind: isCat ? 'category' : 'sub',
            id: n.id,
            label: nodeName(isCat ? 'category' : 'sub', n.id),
            depth: 0,
            leaf: true,
            active: state.currentTagNode === n.id,
          });
        }
      }
      if (hasTags) {
        out += '<div class="web-tag-nav-group">' + esc(t('标签', 'Tags')) + '</div>';
        for (var j = 0; j < res.tags.length; j++) {
          var tag = res.tags[j];
          out += treeRowHtml({
            kind: 'tag',
            id: tag.tag,
            label: tag.name,
            depth: 0,
            leaf: true,
            count: compactCount(tag.count),
            active: state.currentTag === tag.tag,
            title: tag.tag,
            node: tag.node || '',
            category: tag.category || '',
          });
        }
      }
      return out;
    }

    function footHtml() {
      if (!statusData.available) {
        return '<span class="web-tag-nav-foot-warn">' + esc(t('标签索引还没建好。', 'The tag index is not built yet.')) + '</span>';
      }
      return esc(
        t('标签索引：{tags} 个标签 / {photos} 张图片', 'Tag index: {tags} tags / {photos} photos')
          .replace('{tags}', compactCount(statusData.tags))
          .replace('{photos}', compactCount(statusData.photos)),
      );
    }

    function renderSidebar() {
      var host = sidebarEl();
      if (!host) return;
      var scroll = 0;
      var list = host.querySelector('.web-tag-nav-list');
      if (list) scroll = list.scrollTop;

      // 🔴 搜索框会被下面那句 `host.innerHTML = html` 整块换掉，**焦点不会自己回来**
      //    （旧 input 连同焦点一起丢，浏览器把焦点还给 body）。提交式搜索下这是必踩的：
      //    按回车 ⇒ 回包 ⇒ 重画 ⇒ 焦点掉了，于是「想改一下关键词再搜一次」的人第二下
      //    敲不进任何字 —— 界面看着没坏，只是没反应。契约与桌面端逐条一致。
      var prevInput = host.querySelector('#tagNavSearchInput');
      var keepFocus = !!prevInput && document.activeElement === prevInput;
      var caret = 0;
      if (keepFocus) {
        try {
          caret = prevInput.selectionStart || 0;
        } catch (e) {
          caret = 0; // 极少数 input 类型读这个会抛；抛出来会把整次重画带崩
        }
      }

      var html = '<div class="web-tag-nav">';
      html +=
        '<div class="web-tag-nav-search">' +
        // 输入框与内嵌的「清空」叉包一层：叉是绝对定位的，锚点得是这个只包输入框的盒子。
        '<div class="web-tag-nav-search-field">' +
        '<input type="search" class="web-tag-nav-input" id="tagNavSearchInput" value="' +
        escAttr(keyword) +
        '" placeholder="' + escAttr(t('搜索标签', 'Search tags')) + '"' +
        ' aria-label="' + escAttr(t('搜索标签', 'Search tags')) + '"' +
        ' autocomplete="off" spellcheck="false" />' +
        '<button type="button" class="web-tag-nav-clear" id="tagNavSearchClear" title="' +
        escAttr(t('清除搜索', 'Clear search')) + '" aria-label="' + escAttr(t('清除搜索', 'Clear search')) + '"' +
        (keyword ? '' : ' hidden') + '>\u00D7</button>' +
        '</div>' +
        // 🔴 提交按钮：搜索非实时之后必须有的**可见出口**（以前敲字就出结果）。按回车等价。
        '<button type="button" class="web-tag-nav-submit" id="tagNavSearchSubmit" title="' +
        escAttr(t('搜索标签（回车）', 'Search tags (Enter)')) +
        '" aria-label="' + escAttr(t('搜索标签（回车）', 'Search tags (Enter)')) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/>' +
        '<path d="M15.6 15.6 21 21"/></svg>' +
        '</button>' +
        '</div>';
      html += '<div class="web-tag-nav-list" id="tagNavList">' + listHtml() + '</div>';
      html += '<div class="web-tag-nav-foot" id="tagNavFoot">' + footHtml() + '</div>';
      html += '</div>';
      host.innerHTML = html;
      var nextList = host.querySelector('.web-tag-nav-list');
      if (nextList && scroll) nextList.scrollTop = scroll;
      if (keepFocus) {
        var nextInput = host.querySelector('#tagNavSearchInput');
        if (nextInput) {
          nextInput.focus();
          try {
            nextInput.setSelectionRange(caret, caret);
          } catch (e) {
            /* 焦点已经回来了，光标位置是次要的 */
          }
        }
      }
      bindSidebarEvents();
    }

    function bindSidebarEvents() {
      var host = sidebarEl();
      if (!host) return;
      var input = host.querySelector('#tagNavSearchInput');
      if (input) {
        // `input` 事件**只**更新输入框自己的状态（`keyword` + 清除叉的显隐），**绝不发请求**。
        input.addEventListener('input', function () {
          onKeywordInput(input.value);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault(); // 别让回车冒泡去触发别的默认行为
            submitSearch();
            return;
          }
          if (e.key === 'Escape') {
            input.value = '';
            onKeywordInput('');
          }
        });
      }
      var submit = host.querySelector('#tagNavSearchSubmit');
      if (submit) {
        submit.addEventListener('click', function () {
          submitSearch();
          if (input) input.focus();
        });
      }
      var clear = host.querySelector('#tagNavSearchClear');
      if (clear) {
        clear.addEventListener('click', function () {
          if (input) input.value = '';
          onKeywordInput('');
          if (input) input.focus();
        });
      }
      // 事件委托：树每次重渲染都会换掉子节点，逐行挂监听会漏（也贵）
      host.addEventListener('click', onSidebarClick);
    }

    function onSidebarClick(e) {
      var row = e.target && e.target.closest ? e.target.closest('[data-tag-nav-kind]') : null;
      if (!row) return;
      var kind = row.getAttribute('data-tag-nav-kind');
      var id = row.getAttribute('data-tag-nav-id') || '';
      if (e.target.getAttribute && e.target.getAttribute('data-tag-toggle')) {
        if (kind === 'category' || kind === 'sub') {
          toggleNode(id);
          return;
        }
      }
      if (kind === 'tag') {
        selectTag(id, row.getAttribute('data-tag-nav-node'), row.getAttribute('data-tag-nav-cat'));
        return;
      }
      if (kind === 'root') {
        selectNode('', '');
        return;
      }
      if (!expanded[id]) {
        expanded[id] = true;
        if (kind === 'sub') void ensureSubTags(id, renderSidebar);
      }
      selectNode(kind, id);
    }

    function toggleNode(id) {
      if (expanded[id]) {
        delete expanded[id];
        renderSidebar();
        return;
      }
      expanded[id] = true;
      if (isSubId(id)) void ensureSubTags(id, renderSidebar);
      renderSidebar();
    }

    /**
     * 懒取某个子类下的标签（一次，之后走缓存）。
     * 代次判据必须是 `!==`（`>` 恒假 —— seq 只增不减），且按子类各一份。
     */
    function ensureSubTags(subId, done) {
      if (subTags[subId] !== undefined && subTags[subId] !== null) {
        if (typeof done === 'function') done();
        return Promise.resolve(subTags[subId]);
      }
      if (pending[subId]) return pending[subId];
      var myToken = (subToken[subId] || 0) + 1;
      subToken[subId] = myToken;
      var p = get('/api/tag-nav-node?node=' + encodeURIComponent(subId) + '&locale=' + encodeURIComponent(locale()))
        .then(function (res) {
          if (subToken[subId] !== myToken) return null;
          subTags[subId] = (res && res.tags) || [];
          // 这里**确定**知道子类 id ⇒ 把「标签 → 归属」记全
          rememberPaths(subTags[subId], subId);
          if (typeof done === 'function') done();
          return subTags[subId];
        })
        .catch(function () {
          if (subToken[subId] !== myToken) return null;
          // null = 「要过但失败了」，与 `[]`（确实没有）分开存：
          // 混在一起会把一次读库失败显示成「这个分类是空的」，用户不会再点第二次。
          subTags[subId] = null;
          if (typeof done === 'function') done();
          return null;
        })
        .then(function (v) {
          delete pending[subId];
          return v;
        });
      pending[subId] = p;
      return p;
    }

    // ---------------------------------------------------------------- 搜索
    /** 输入框内容变了。**只更新输入框自己的状态，一次请求都不发**（契约同桌面端）。 */
    function onKeywordInput(value) {
      keyword = String(value == null ? '' : value);
      updateClearButton();
      // 清空（删到空 / Esc / 清除叉）是显式动作 ⇒ 立刻退出搜索态回树，不等提交。
      if (!keyword.trim()) exitSearch();
    }

    /** 显式提交：回车 / 点搜索按钮。搜索只有这一条发起路径。 */
    function submitSearch() {
      var q = keyword.trim();
      if (!q) {
        exitSearch();
        return;
      }
      void runSearch(q);
    }

    /**
     * 退出搜索态（清空 / Esc / 清除叉 / 空提交）。
     * 🔴 `searchToken++` 必须：退出时可能有请求在飞，不作废代次的话那份回包回来会把你
     *    刚清掉的搜索结果又贴回来。
     */
    function exitSearch() {
      if (!searchResult && !lastQuery) return; // 本来就没在搜：不重画、不刷主区
      searchToken++;
      lastQuery = '';
      searchResult = null;
      renderSidebar();
      refreshMainForSearch();
    }

    function updateClearButton() {
      var host = sidebarEl();
      if (!host) return;
      var clear = host.querySelector('#tagNavSearchClear');
      if (clear) clear.hidden = !keyword;
    }

    /** 搜索态变了 ⇒ 主区也要跟着变；正在看照片（currentTag 有值）时**刻意不**拽走用户。 */
    function refreshMainForSearch() {
      if (state.currentTag) return;
      onPhotosChanged();
    }

    /** 发一次搜索。`lastQuery` 的唯一赋值点 ⇒「在途请求对应哪个词」只由本函数决定。 */
    function runSearch(q) {
      var myToken = ++searchToken;
      lastQuery = String(q == null ? '' : q).trim();
      return get('/api/tag-nav-search?q=' + encodeURIComponent(q) + '&locale=' + encodeURIComponent(locale()))
        .then(function (res) {
          // 过期回包只看**代次**（`exitSearch` 也会 `++`）。原先这里还有
          // `if (keyword.trim() !== q.trim()) return;` —— 提交式搜索下它是错的：
          // `keyword` 可以合法地不等于最后一次提交的词（回车后又敲了几个字），
          // 那份回包**才是该显示的**，丢掉就成了「按了回车没反应」。见桌面端同处注释。
          if (searchToken !== myToken) return;
          searchResult = res && (res.tags || res.nodes) ? res : { tags: [], nodes: [], indexed: 0 };
          rememberPaths(searchResult.tags, '');
          renderSidebar();
          refreshMainForSearch();
        })
        .catch(function () {
          if (searchToken !== myToken) return;
          // 形状必须与成功路径一致（含 indexed）：空态判据读的就是它。
          searchResult = { tags: [], nodes: [], indexed: 0 };
          renderSidebar();
          refreshMainForSearch();
        });
    }

    // ------------------------------------------------------------ 选中动作
    function selectTag(tag, node, category) {
      var id = String(tag || '');
      rememberPath(id, node, category);
      state.currentTag = id;
      state.currentTagNode = '';
      state.page = 1;
      // 沿路把树展开到它（导航历史 / 直接落进某标签时没有点击点，必须在这里做）
      var p = tagPath[id];
      if (p) {
        if (p.category) expanded[p.category] = true;
        if (p.node) {
          expanded[p.node] = true;
          void ensureSubTags(p.node, function () {
            renderSidebar();
            onChromeRefresh();
          });
        }
      }
      renderSidebar();
      onPhotosChanged();
    }

    function selectNode(kind, id) {
      state.currentTag = '';
      state.currentTagNode = kind && kind !== 'root' ? id : '';
      state.currentTagNodeKind = kind === 'category' || kind === 'sub' ? kind : '';
      state.page = 1;
      renderSidebar();
      onPhotosChanged();
    }

    // ---------------------------------------------------------------- 主区
    /** 主区卡片列表（分类总览 / 节点下的标签 / 搜索结果）。由 app.js#loadPhotos 的卡片分支调。 */
    function renderBrowseCards() {
      var grid = document.getElementById('photoGrid');
      if (!grid) return;
      var myToken = ++cardsSeq;

      if (searchResult) {
        renderCardList(grid, searchCards(), myToken, emptyTextFor(searchResult.indexed, 'search'));
        return;
      }
      if (!state.currentTagNode) {
        renderCardList(grid, categoryCards(), myToken, emptyTextFor(0, 'node'));
        return;
      }
      var nodeId = state.currentTagNode;
      grid.innerHTML =
        '<div class="empty-state"><div class="title">' + esc(t('正在搜索…', 'Searching…')) + '</div></div>';
      void loadNodeCards(nodeId, myToken);
    }

    function categoryCards() {
      var out = [];
      for (var i = 0; i < treeData.length; i++) {
        var cat = treeData[i];
        out.push({
          kind: 'category',
          id: cat.id,
          name: nodeName('category', cat.id),
          count: cat.tagIndexed,
          dim: !cat.tagIndexed,
        });
      }
      return out;
    }

    function searchCards() {
      var out = [];
      var nodes = (searchResult && searchResult.nodes) || [];
      for (var i = 0; i < nodes.length; i++) {
        var isCat = nodes[i].kind === 'category';
        out.push({
          kind: isCat ? 'category' : 'sub',
          id: nodes[i].id,
          name: nodeName(isCat ? 'category' : 'sub', nodes[i].id),
          count: null,
        });
      }
      var tags = (searchResult && searchResult.tags) || [];
      for (var j = 0; j < tags.length; j++) {
        out.push({
          kind: 'tag',
          id: tags[j].tag,
          name: tags[j].name,
          count: tags[j].count,
          node: tags[j].node || '',
          category: tags[j].category || '',
        });
      }
      return out;
    }

    function loadNodeCards(nodeId, myToken) {
      return get('/api/tag-nav-node?node=' + encodeURIComponent(nodeId) + '&locale=' + encodeURIComponent(locale()))
        .then(function (res) {
          // 代次 + 现场状态两道判据：代次挡旧回包，现场状态挡「已经切走之后才回来的那份」
          if (myToken !== cardsSeq) return;
          if (state.currentView !== 'tag' || state.currentTag) return;
          if (state.currentTagNode !== nodeId) return;
          var grid = document.getElementById('photoGrid');
          if (!grid) return;
          var tags = (res && res.tags) || [];
          rememberPaths(tags, nodeId);
          renderCardList(
            grid,
            tags.map(function (tag) {
              // 服务端已按展示线过滤：这里不会出现 0 张的标签。
              return { kind: 'tag', id: tag.tag, name: tag.name, count: tag.count };
            }),
            myToken,
            emptyTextFor(res && res.indexed, 'node'),
          );
        })
        .catch(function () {
          if (myToken !== cardsSeq) return;
          var grid = document.getElementById('photoGrid');
          if (!grid) return;
          grid.innerHTML =
            '<div class="empty-state"><div class="title">' +
            esc(t('标签数据读取失败，请稍后重试', 'Failed to load tags, try again later')) +
            '</div></div>';
        });
    }

    /**
     * 「列表空了」该说哪句话。
     *
     * 🔴 两种空必须分开：`indexed === 0` 是「这儿还没有已建立索引的标签」，`indexed > 0` 是
     *    「有标签但都低于当前展示线」（调低展示线才有图）。混成一句会让用户朝错误的方向使劲。
     *    判据与桌面端同源同形 —— 口径都是「过滤前的候选数」。
     */
    function emptyTextFor(indexed, mode) {
      var n = Number(indexed) || 0;
      if (n > 0) {
        return t(
          '{count} 个标签都低于当前展示线，暂时没有可显示的图片。可在设置里调低「标签展示线」。',
          'All {count} tags are below the current display threshold, so there is nothing to show. Lower the "Tag display threshold" in Settings.',
        ).replace('{count}', compactCount(n));
      }
      return mode === 'search'
        ? t('没有匹配的标签', 'No matching tags')
        : t('这个节点下还没有已建立索引的标签', 'No indexed tags under this node yet');
    }

    function renderCardList(grid, items, myToken, emptyText) {
      if (myToken !== cardsSeq) return;
      if (!items.length) {
        grid.innerHTML =
          '<div class="empty-state"><div class="title">' +
          esc(emptyText || t('这个节点下还没有已建立索引的标签', 'No indexed tags under this node yet')) +
          '</div></div>';
        return;
      }
      var html = '<div class="web-tag-nav-cards">';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var countLabel =
          it.kind === 'tag'
            ? t('{count} 张', '{count} photos').replace('{count}', compactCount(it.count || 0))
            : it.count
              ? t('{count} 个标签', '{count} tags').replace('{count}', compactCount(it.count))
              : '';
        html +=
          '<button type="button" class="web-tag-nav-card' + (it.dim ? ' is-dim' : '') + '"' +
          ' data-tag-card-kind="' + escAttr(it.kind) + '"' +
          ' data-tag-card-id="' + escAttr(it.id) + '"' +
          ' data-tag-card-node="' + escAttr(it.node || '') + '"' +
          ' data-tag-card-cat="' + escAttr(it.category || '') + '"' +
          ' title="' + escAttr(it.id) + '">' +
          '<span class="web-tag-nav-card-name">' + esc(it.name) + '</span>' +
          (countLabel ? '<span class="web-tag-nav-card-count">' + esc(countLabel) + '</span>' : '') +
          '</button>';
      }
      html += '</div>';
      grid.innerHTML = html;
      var host = grid.querySelector('.web-tag-nav-cards');
      if (host) host.addEventListener('click', onCardClick);
    }

    function onCardClick(e) {
      var card = e.target && e.target.closest ? e.target.closest('[data-tag-card-kind]') : null;
      if (!card) return;
      var kind = card.getAttribute('data-tag-card-kind');
      var id = card.getAttribute('data-tag-card-id') || '';
      if (!id) return;
      if (kind === 'tag') {
        selectTag(id, card.getAttribute('data-tag-card-node'), card.getAttribute('data-tag-card-cat'));
        return;
      }
      if (!expanded[id]) {
        expanded[id] = true;
        if (isSubId(id)) void ensureSubTags(id, renderSidebar);
      }
      selectNode(kind, id);
    }

    /** 某个标签的显示名：只从已加载的数据里找（与桌面端同一条取舍，不单开 IPC/请求）。 */
    function displayName(tag) {
      var t0 = String(tag || '');
      if (!t0) return '';
      for (var sub in subTags) {
        if (!Object.prototype.hasOwnProperty.call(subTags, sub)) continue;
        var list = subTags[sub];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) if (list[i].tag === t0) return list[i].name || t0;
      }
      if (searchResult && searchResult.tags) {
        for (var j = 0; j < searchResult.tags.length; j++) {
          if (searchResult.tags[j].tag === t0) return searchResult.tags[j].name || t0;
        }
      }
      return t0;
    }

    // ---------------------------------------------------------------- 入口
    /** 进入标签页：拉状态与树，然后画侧栏。幂等；带代次，旧的那次进页回包会被丢弃。 */
    function enter() {
      var myToken = ++enterToken;
      renderSidebar(); // 先给骨架，不让侧栏停在上一页的内容上
      return Promise.all([get('/api/tag-nav-status'), get('/api/tag-nav-tree')])
        .then(function (pair) {
          if (myToken !== enterToken) return;
          statusData = pair[0] || { available: false, tags: 0, photos: 0 };
          treeData = Array.isArray(pair[1]) ? pair[1] : [];
          renderSidebar();
          // 🔴 主区的分类总览卡片也依赖 treeData。`loadPhotos` 可能在**这之前**就跑完了
          //    （进页时它先于本请求的回包），那时 `categoryCards()` 还是空的 ⇒ 主区白屏。
          //    别赌两个请求谁快 —— 数据落地后补一次（只在卡片态补，别把看照片的人拽回来）。
          if (!state.currentTag) onPhotosChanged();
        })
        .catch(function () {
          if (myToken !== enterToken) return;
          statusData = { available: false, tags: 0, photos: 0 };
          treeData = [];
          renderSidebar();
        });
    }

    /** 离开标签页：把搜索态与「正在飞」的请求一并清掉（树结构保留，回来不用重拉）。 */
    function leave() {
      // 🔴 `lastQuery` 必须一起清：不清的话下次进页（或任何按 `lastQuery` 判的重搜点）
      //    会拿着上一轮的词自己搜起来。`keyword` 清了、`lastQuery` 没清 = 两者失同步。
      keyword = '';
      lastQuery = '';
      searchResult = null;
      searchToken++; // 在途的搜索回包不许再写侧栏
      enterToken++;
      cardsSeq++;
    }

    function isShowing() {
      return state.currentView === 'tag';
    }

    /**
     * 语言切换（或 locale 变化）：缓存里的 `name` 是按 locale 给的，必须失效重取。
     * 两条路径可能指向同一个子类，`ensureSubTags` 会合并并发请求 ⇒ 回调必须共用一份。
     */
    function refreshLocale() {
      if (!isShowing() && state.currentTab !== 'tags') return;
      subTags = Object.create(null);
      pending = Object.create(null);
      function afterSubLoad() {
        renderSidebar();
        onChromeRefresh();
      }
      Object.keys(expanded).forEach(function (id) {
        if (!isSubId(id)) return;
        void ensureSubTags(id, afterSubLoad);
      });
      var cur = state.currentTag;
      if (cur) {
        var p = tagPath[cur];
        if (p) {
          if (p.category) expanded[p.category] = true;
          if (p.node) {
            expanded[p.node] = true;
            void ensureSubTags(p.node, afterSubLoad);
          }
        }
      }
      // 🔴 判据是 `lastQuery`（**已提交**的词），不是 `keyword`：切语言时用户可能刚敲了
      //    半截话还没提交，拿 `keyword` 判就替他把搜索开起来了。在搜的话，服务端给的
      //    `name` 是按 locale 的，必须按新语言重取。
      if (lastQuery) void runSearch(lastQuery);
      renderSidebar();
      if (!state.currentTag) onPhotosChanged();
    }

    return {
      enter: enter,
      leave: leave,
      isShowing: isShowing,
      renderSidebar: renderSidebar,
      renderBrowseCards: renderBrowseCards,
      refreshLocale: refreshLocale,
      selectTag: selectTag,
      selectNode: selectNode,
      displayName: displayName,
      _debug: {
        expanded: function () {
          return Object.keys(expanded);
        },
        subTags: function () {
          return subTags;
        },
        tree: function () {
          return treeData;
        },
        status: function () {
          return statusData;
        },
      },
    };
  }

  global.WebTagNav = { init: init };
})(window);
