(function (global) {
  'use strict';

  /**
   * 「标签导航页」的**界面层**：侧栏三级树 + 主区卡片列表。
   *
   * ## 分工：只有「标签叶子」走照片网格
   *
   *   分类 / 子类（父节点） → 主区显示**标签卡片**（下钻用，点卡片进入该标签的照片）
   *   标签叶子             → 走 app.js 的通用浏览通路（`loadPhotos`），于是预览、
   *                          信息面板、分页、卡片尺寸**全部白拿**，一行都不用重写
   *
   * 🔴 父节点**刻意不**做照片网格。照片是按标签逐个取出来的（单 `tag_id` 走
   *    `idx_tag_score` 区间扫描，代价与该标签的命中行数成正比），而「一个子类下的全部
   *    照片」要做 `WHERE tag_id IN (…) GROUP BY photo_id` —— 那是**全节点行数**的聚合：
   *    现在 `photo_tag` 只有 11 万行（2032 张图），量出来 20 ms 上下；但索引一旦铺满
   *    165 万张（≈9000 万行），`clothing` 这类大节点会变成几十秒的主线程阻塞。
   *    界面上它表现得像「点了没反应」，与「卡死」无法区分 —— 正是工程里反复出现的那类
   *    静默失效。所以父节点只做下钻，不做网格；要按子类看照片，就点它下面的标签。
   *
   * ## 树是**懒**的
   *
   * 全量 5813 个标签里现在有 1752 个已建索引。整棵树一次性渲染 = 1752 个 DOM 节点 +
   * 一次 `get-tag-nav-node` 之外的零查询；但索引铺满就是 5813 个叶子。所以：
   *   · 分类 / 子类的子层**默认收起**，只渲染两行；
   *   · 子类展开时才向主进程要它下面的标签（`getTagNavNode`），结果**缓存**在内存里
   *     （一个子类一次，切走再回来不重新要）。
   * 折叠态**不进浏览记忆**：它是「这一屏看到哪儿了」的临时状态，不是浏览位置；
   * 跨会话记住只会变成噪声。
   *
   * ## 缩进口径必须抄 `sidebar-tree`
   *
   * 标签树是另一套渲染器，但它跟目录树**并排显示在同一个侧栏**里。缩进常量若各写一份，
   * 两边差 2px 用户一眼看出来，而没有任何断言会红 ⇒ 一律走
   * `RendererSidebarTree.treeRowIndent / treeLeafIndent / treeGuideX`。
   * 行内 `padding-left` 是唯一缩进来源，`.tree-children` 保持 0（见 gallery-design.css）。
   */

  /*
   * 🔴 搜索**不是实时**的：敲字不发请求，只有**显式提交**才发（回车 / 点右侧那个按钮）。
   *
   * 以前这里是 `SEARCH_DEBOUNCE_MS = 180` 的防抖 —— 每敲一个字符都排一次
   * `get-tag-nav-search`，主进程每轮要遍历 5813 条标签名。防抖只是把「敲 7 个字母发 7 次」
   * 压成「停顿后发 1 次」，**边打边扫的代价一点没省**（打字过程中必然夹着停顿），
   * 而且「打一半的词也在搜」本身就是错的：用户看到的是 `yel` 的结果，不是他要的 `yellow`。
   * 现在改成提交式，`input` 事件只更新输入框自己的状态（见 `onKeywordInput`）。
   *
   * 提交的两条入口在 `bindSidebarEvents()`（回车 / 提交按钮），都汇到 `submitSearch()`。
   */

  function createTagNavUI(deps) {
    var state = deps.state;
    var dom = deps.dom;
    var api = deps.api;
    var t = deps.tUi;
    var tFmt = deps.tUiFmt;
    var esc = deps.escapeHtml;
    var escAttr = deps.escapeAttr;
    var fmtNumber = deps.formatNumber;
    var onSelectTag = deps.onSelectTag;
    var onRenderCards = deps.onRenderCards;
    /** 侧栏/主区之外还要跟着变的东西（当前只有路径栏的标签名）。 */
    var onChromeRefresh = deps.onChromeRefresh;
    var treeUi = global.RendererSidebarTree || {};

    /** 展开态：节点 id → true。只存在内存（见文件头注释）。 */
    var expanded = Object.create(null);
    /**
     * 标签 → 它的归属 `{node, category}`。
     *
     * 渲染层**拿不到** `src/ai/tag-categories.js`（那是主进程模块），所以这两条路径
     * 只能从服务端返回的字段里记（`get-tag-nav-search` 带 `node`/`category`）、
     * 或在节点取回时按当前节点推出来，或由调用点带进来。
     *
     * 记它的用处，都是「那两个字段渲染层拿不到」的直接后果：
     *   · 语言切换后要重新取该子类（服务端给的 `name` 是按 locale 的，见
     *     `main/tag-nav.js#node`），得知道该重新取哪一个；
     *   · 导航历史 / 启动恢复直接落到某个标签时，把树下展开到它 —— 否则侧栏一片
     *     没高亮，用户看不出自己在哪，而「从主区点卡片进来」时是展开的（两条入口必须一致）。
     */
    var tagPath = Object.create(null);
    /** `get-tag-nav-tree` 的原样结果（分类 → 子类 + 两档计数）。 */
    var treeData = [];
    /** 状态：索引可不可用、索引里有多少标签 / 多少图片。 */
    var statusData = { available: false, tags: 0, photos: 0 };
    /** 子类 → 该子类下的标签（懒加载后缓存）。null = 要过但失败了。 */
    var subTags = Object.create(null);
    /** 正在取的子类 id 集合（防止连点发两次）。 */
    var pending = Object.create(null);
    /** 搜索结果 `{tags, nodes}`；null = 没在搜索。**搜索态的唯一判据就是它**（不是 `keyword`）。 */
    var searchResult = null;
    /** 输入框里现在的文字。**含还没提交的** —— 所以它非空 ≠ 在搜索态（见 `lastQuery`）。 */
    var keyword = '';
    /**
     * **已经提交并生效**的查询词。`''` = 没在搜索。
     *
     * 与 `keyword` 分开是提交式搜索的**核心**，两处都靠它：
     *   · `enter()` / `repaintCounts()` 的重搜（切语言、改展示线）只能重搜**已提交**的那个词 ——
     *     拿 `keyword` 判就会「用户只是敲了几个字、没按回车」也替他搜一次，搜索态自己就开了；
     *   · 网页端 `leave()` 离开标签页要把它清掉。
     */
    var lastQuery = '';
    /** 丢过期回包：主进程返回顺序不保证与请求顺序一致。**按用途各一份代次**。 */
    var searchToken = 0;
    /** 子类 id → 该子类标签请求的代次（见 `ensureSubTags` 的红线注释）。 */
    var subToken = Object.create(null);
    /**
     * 主区卡片的**请求代次**（自增）。主进程回包顺序不保证与请求顺序一致 ——
     * 不用代次丢掉过期回包，快速连点两个分类会看到「先点的那个最后才盖上来」。
     */
    var cardsSeq = 0;
    /**
     * 展示线（设置项 `aiTagDisplayThreshold`）改过、但人还没回到标签页 ⇒ 缓存已清、
     * 展开着的子类缺数据。由 `enter()` 在进页时补齐重取（见 `invalidateCounts`）。
     */
    var countsDirty = false;

    function tNode(kind, id) {
      // 词条缺了就回落到模块里的中文兜底名（**不会**渲染出机器 id）：
      // 新增子类时忘了补词条，界面看起来仍然正常，只是英文环境下是中文。
      var meta = findNodeMeta(kind, id);
      if (!meta) return id;
      return t(kind === 'category' ? 'tagnav.cat.' + id : 'tagnav.sub.' + id, meta.label);
    }

    function findNodeMeta(kind, id) {
      if (kind === 'category') {
        for (var i = 0; i < treeData.length; i++) {
          if (treeData[i].id === id) {
            return { label: treeData[i].label || id, node: treeData[i] };
          }
        }
        return null;
      }
      for (var j = 0; j < treeData.length; j++) {
        var subs = treeData[j].subs || [];
        for (var k = 0; k < subs.length; k++) {
          if (subs[k].id === id) return { label: subs[k].label || id, node: subs[k] };
        }
      }
      return null;
    }

    /** 某个子类属于哪个顶层分类（树里查，不反查主进程模块）。 */
    function categoryOfSub(subId) {
      for (var i = 0; i < treeData.length; i++) {
        var subs = treeData[i].subs || [];
        for (var j = 0; j < subs.length; j++) if (subs[j].id === subId) return treeData[i].id;
      }
      return '';
    }

    /** 记下（或补齐）一个标签的归属。空值不覆盖已有的值 —— 多处来源各有各的缺项。 */
    function rememberPath(tag, node, category) {
      var t0 = String(tag || '');
      if (!t0) return;
      var prev = tagPath[t0] || {};
      tagPath[t0] = {
        node: node || prev.node || '',
        category: category || prev.category || '',
      };
    }

    function rememberPaths(list, fallbackNode) {
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var n = it.node || fallbackNode || '';
        rememberPath(it.tag, n, it.category || (n ? categoryOfSub(n) : ''));
      }
    }

    // ---------------------------------------------------------------- 侧栏
    function sidebarEl() {
      return dom.sidebarContent;
    }

    function renderSidebar() {
      var host = sidebarEl();
      if (!host) return;
      var scroll = 0;
      var list = host.querySelector('.tag-nav-list');
      if (list) scroll = list.scrollTop;

      /**
       * 🔴 搜索框在这次重画里会被整块换掉（下面那句 `host.innerHTML = html`），而
       *    **焦点不会自己回来**：旧 input 连同焦点一起被丢弃，浏览器把焦点还给 `body`。
       *
       *    这在提交式搜索下是**必踩**的：按回车 ⇒ 回包 ⇒ `renderSidebar()` ⇒ 焦点掉了，
       *    于是「想改一下关键词再搜一次」的人第二下敲不进任何字。界面看着一点没坏
       *    （输入框还在、字还在），只是**没反应** —— 典型的静默失效。
       *    实时搜时代也掉焦点，但那时回包由敲字触发，人早停手了，所以不显眼。
       */
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

      var html = '';
      html += '<div class="tag-nav">';
      html +=
        '<div class="tag-nav-search">' +
        // 输入框与内嵌的「清空」叉包一层：叉是绝对定位的，锚点得是这个只包输入框的盒子
        // （提交按钮在它外面、是**独立**的盒子，不能跟叉共用一个锚点，见 tag-nav.css）。
        '<div class="tag-nav-search-field">' +
        '<input type="search" class="tag-nav-input" id="tagNavSearchInput" value="' +
        escAttr(keyword) +
        '" placeholder="' +
        escAttr(t('tagnav.searchPlaceholder', '搜索标签')) +
        '" aria-label="' +
        escAttr(t('tagnav.searchAria', '搜索标签')) +
        '" autocomplete="off" spellcheck="false" />' +
        '<button type="button" class="tag-nav-clear" id="tagNavSearchClear" title="' +
        escAttr(t('tagnav.searchClear', '清除搜索')) +
        '" aria-label="' +
        escAttr(t('tagnav.searchClear', '清除搜索')) +
        '"' +
        (keyword ? '' : ' hidden') +
        '>\u00D7</button>' +
        '</div>' +
        // 🔴 提交按钮是**搜索非实时之后必须有的可见出口**：以前敲字就出结果，现在敲字
        //    什么都不发生，没有这个按钮用户只会认为「搜索坏了」。按回车等价。
        '<button type="button" class="tag-nav-submit" id="tagNavSearchSubmit" title="' +
        escAttr(t('tagnav.searchSubmit', '搜索标签（回车）')) +
        '" aria-label="' +
        escAttr(t('tagnav.searchSubmit', '搜索标签（回车）')) +
        '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/>' +
        '<path d="M15.6 15.6 21 21"/></svg>' +
        '</button>' +
        '</div>';
      html += '<div class="tag-nav-list" id="tagNavList">' + listHtml() + '</div>';
      html += '<div class="tag-nav-foot" id="tagNavFoot">' + footHtml() + '</div>';
      html += '</div>';

      host.innerHTML = html;
      var nextList = host.querySelector('.tag-nav-list');
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

    function footHtml() {
      if (!statusData.available) {
        return (
          '<span class="tag-nav-foot-warn">' +
          esc(t('tagnav.indexEmpty', '标签索引还没建好。')) +
          '</span>'
        );
      }
      return esc(
        tFmt(
          'tagnav.indexNote',
          { tags: fmtNumber(statusData.tags), photos: fmtNumber(statusData.photos) },
          '标签索引：{tags} 个标签 / {photos} 张图片',
        ),
      );
    }

    function listHtml() {
      if (searchResult) return searchListHtml();
      if (!treeData.length) return '<div class="tag-nav-empty">' + esc(t('tagnav.pickHint', '')) + '</div>';
      var html = '';
      // 「全部标签」= 分类总览。它是 depth 0 的**叶子**（没有箭头槽），
      // 所以用 treeLeafIndent(0) —— 这样它的名字与同级分类行的名字对齐。
      html += treeRowHtml({
        kind: 'root',
        id: '',
        label: t('tagnav.allTags', '全部标签'),
        depth: 0,
        leaf: true,
        count: statusData.available ? fmtNumber(statusData.tags) : '',
        active: !state.currentTag && !state.currentTagNode,
      });
      for (var i = 0; i < treeData.length; i++) {
        html += categoryHtml(treeData[i]);
      }
      return html;
    }

    function categoryHtml(cat) {
      var isOpen = !!expanded[cat.id];
      var html = treeRowHtml({
        kind: 'category',
        id: cat.id,
        label: tNode('category', cat.id),
        depth: 0,
        leaf: false,
        open: isOpen,
        count: cat.tagIndexed ? fmtNumber(cat.tagIndexed) : '',
        dim: !cat.tagIndexed,
        active: state.currentTagNode === cat.id,
        title: tFmt(
          'tagnav.catTotal',
          { total: fmtNumber(cat.tagTotal), indexed: fmtNumber(cat.tagIndexed) },
          '共 {total} 个标签，已有 {indexed} 个',
        ),
      });
      html += '<div' + childrenAttrs(cat.id, isOpen, 0) + '>';
      if (isOpen) html += subsHtml(cat);
      html += '</div>';
      return '<div class="tree-node">' + html + '</div>';
    }

    /**
     * 子层容器的属性串。
     *
     * 🔴 `expanded` 类**必须**与行内 `display` 同写。`gallery-design.css` 里有一条
     *    `.tree-children:not(.expanded) { display: none }` —— 只去掉行内 display 而不加类，
     *    展开的层会被那条规则再藏回去：箭头转了、点击有反馈、内容不出来，
     *    而 DOM 里一切正常（这正是「双写」契约存在的原因）。
     * `--tree-guide-x` 让层级导线对齐到父行的箭头槽中心（与目录树同一口径）。
     */
    function childrenAttrs(id, isOpen, depth) {
      return (
        ' class="tree-children tag-nav-children' +
        (isOpen ? ' expanded' : '') +
        '" data-tag-children-for="' +
        escAttr(id) +
        '" style="display:' +
        (isOpen ? 'block' : 'none') +
        ';--tree-guide-x:' +
        guideX(depth) +
        'px"' +
        (isOpen ? '' : ' data-tag-lazy="1"')
      );
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
          label: tNode('sub', sub.id),
          depth: 1,
          leaf: false,
          open: isOpen,
          count: sub.tagIndexed ? fmtNumber(sub.tagIndexed) : '',
          dim: !sub.tagIndexed,
          active: state.currentTagNode === sub.id,
          title: tFmt(
            'tagnav.catTotal',
            { total: fmtNumber(sub.tagTotal), indexed: fmtNumber(sub.tagIndexed) },
            '共 {total} 个标签，已有 {indexed} 个',
          ),
        });
        out += '<div' + childrenAttrs(sub.id, isOpen, 1) + '>';
        // 把父行已有的 `tagIndexed` 传下去当空态判据 —— 别在叶子那层再去问一次主进程。
        if (isOpen) out += tagLeavesHtml(sub.id, 2, sub.tagIndexed);
        out += '</div>';
        out += '</div>';
      }
      return out;
    }

    /**
     * 某个子类下的标签叶子。
     *
     * @param {number} indexed 这个子类里**已出现在索引中**的标签数（父行上那个数字，来自 `tree()`）。
     *   ⚠️ 它**不是** `entry.length`：列表已经被展示线过滤过（服务端唯一源，见
     *   `main/tag-nav.js#node`），所以「有标签但一个都不显示」是正常的。空态必须靠它分岔，
     *   否则会把「线以下的都被滤掉了」说成「这个节点还没建索引」—— 用户会去重建索引，
     *   而真正该做的是把展示线调低。
     */
    function tagLeavesHtml(subId, depth, indexed) {
      var entry = subTags[subId];
      if (entry === undefined) return loadingRowHtml(depth);
      if (entry === null) {
        return '<div class="tag-nav-empty">' + esc(t('tagnav.loadFail', '标签数据读取失败，请稍后重试')) + '</div>';
      }
      if (!entry.length) {
        return (
          '<div class="tag-nav-empty">' +
          esc(
            Number(indexed) > 0
              ? tFmt(
                  'tagnav.belowLine',
                  { count: fmtNumber(indexed) },
                  '{count} 个标签都低于当前展示线',
                )
              : t('tagnav.noTagHit', '这个节点下还没有已建立索引的标签'),
          ) +
          '</div>'
        );
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
          // 服务端已保证 `count > 0`（0 命中的标签根本不在这个列表里），
          // 所以这里不再有「置灰 / 不显示数字」那一档 —— 留着它是死代码，还会掩盖过滤失效。
          count: fmtNumber(tag.count),
          active: state.currentTag === tag.tag,
          title: tag.tag,
        });
      }
      return out;
    }

    function loadingRowHtml(depth) {
      return (
        '<div class="tag-nav-loading" style="padding-left:' +
        leafIndent(depth) +
        'px">' +
        esc(t('tagnav.searching', '正在搜索…')) +
        '</div>'
      );
    }

    /** 一行树节点。**唯一的缩进来源是行内 `padding-left`**（见文件头注释）。 */
    function treeRowHtml(o) {
      var depth = o.depth || 0;
      var indent = o.leaf ? leafIndent(depth) : rowIndent(depth);
      var cls = 'folder-item tag-nav-row';
      if (!o.leaf) cls += ' tree-parent';
      if (o.active) cls += ' active';
      if (o.dim) cls += ' is-dim';
      if (o.open) cls += ' is-open';
      var attrs = ' data-tag-nav-kind="' + escAttr(o.kind) + '" data-tag-nav-id="' + escAttr(o.id) + '"';
      // 只有「搜索结果里的标签行」带归属节点（主进程已经算好）。有它才能在点击时
      // 把树下展开到该标签；树上本来就在节点里的叶子不需要，节点已经展开着。
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
        // 箭头态走 `.tree-toggle.is-expanded`（与目录树同一套 CSS，不叠行内 transform）
        html +=
          '<span class="tree-toggle' +
          (o.open ? ' is-expanded' : '') +
          '" data-tag-toggle="1" role="presentation"></span>';
      } else {
        html += '<span class="tag-nav-dot" aria-hidden="true"></span>';
      }
      html += '<span class="name">' + esc(o.label) + '</span>';
      if (o.count) html += '<span class="count">' + esc(o.count) + '</span>';
      html += '</div>';
      return html;
    }

    function searchListHtml() {
      var res = searchResult;
      var out = '';
      var hasNodes = res.nodes && res.nodes.length;
      var hasTags = res.tags && res.tags.length;
      if (!hasNodes && !hasTags) {
        // 同 `tagLeavesHtml`：`indexed`（过滤前命中数）> 0 说明「匹配到了，但都低于展示线」，
        // 与「一个都没匹配上」是两件事（后者要去改关键词，前者要去改展示线）。
        return (
          '<div class="tag-nav-empty">' +
          esc(
            Number(res.indexed) > 0
              ? tFmt(
                  'tagnav.belowLine',
                  { count: fmtNumber(res.indexed) },
                  '{count} 个标签都低于当前展示线',
                )
              : t('tagnav.noResult', '没有匹配的标签'),
          ) +
          '</div>'
        );
      }
      if (hasNodes) {
        out += '<div class="tag-nav-group">' + esc(t('tagnav.allTags', '全部标签')) + '</div>';
        for (var i = 0; i < res.nodes.length; i++) {
          var n = res.nodes[i];
          out += treeRowHtml({
            kind: n.kind === 'category' ? 'category' : 'sub',
            id: n.id,
            label: tNode(n.kind === 'category' ? 'category' : 'sub', n.id),
            depth: 0,
            leaf: true,
            active: state.currentTagNode === n.id,
          });
        }
      }
      if (hasTags) {
        out += '<div class="tag-nav-group">' + esc(t('tagnav.allTags', '全部标签')) + '</div>';
        for (var j = 0; j < res.tags.length; j++) {
          var tag = res.tags[j];
          out += treeRowHtml({
            kind: 'tag',
            id: tag.tag,
            label: tag.name,
            depth: 0,
            leaf: true,
            count: fmtNumber(tag.count),
            active: state.currentTag === tag.tag,
            title: tag.tag,
            // 归属节点随行带着走：点它时能把树下展开到该标签（见 `onSidebarClick`）。
            // 与主区卡片同一条路 —— 渲染层拿不到主进程的 `ai/tag-categories`，没法反查。
            node: tag.node || '',
            category: tag.category || '',
          });
        }
      }
      return out;
    }

    function rowIndent(depth) {
      return typeof treeUi.treeRowIndent === 'function' ? treeUi.treeRowIndent(depth) : 12 + depth * 14;
    }
    function leafIndent(depth) {
      return typeof treeUi.treeLeafIndent === 'function'
        ? treeUi.treeLeafIndent(depth)
        : 12 + depth * 14 + 26;
    }
    function guideX(depth) {
      return typeof treeUi.treeGuideX === 'function' ? treeUi.treeGuideX(depth) : 12 + depth * 14 + 9;
    }

    // ---------------------------------------------------------- 侧栏交互
    function bindSidebarEvents() {
      var host = sidebarEl();
      if (!host) return;
      var input = host.querySelector('#tagNavSearchInput');
      if (input) {
        // `input` 事件**只**更新输入框自己的状态（`keyword` + 清除叉的显隐），**绝不发请求**。
        // 搜索只由 `submitSearch()` 发起 —— 回车或点提交按钮，两条显式入口。
        input.addEventListener('input', function () {
          onKeywordInput(input.value);
        });
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault(); // 别让回车冒泡去触发别的默认行为（例如外层表单/按钮）
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
      var onToggle = e.target.getAttribute && e.target.getAttribute('data-tag-toggle');
      if (onToggle) {
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
      // 分类 / 子类：点名字 = 选中并在主区列出它的标签；点箭头 = 只展开。
      if (!expanded[id]) {
        // 收起状态下点名字顺手展开，省一次「先点箭头再点名字」
        expanded[id] = true;
        if (kind === 'sub') void ensureSubTags(id, function () { renderSidebar(); });
      }
      selectNode(kind, id);
    }

    function toggleNode(id) {
      var isOpen = !!expanded[id];
      if (isOpen) {
        delete expanded[id];
        renderSidebar();
        return;
      }
      expanded[id] = true;
      if (isSubId(id)) {
        void ensureSubTags(id, function () {
          renderSidebar();
        });
      }
      renderSidebar();
    }

    function isSubId(id) {
      for (var i = 0; i < treeData.length; i++) {
        var subs = treeData[i].subs || [];
        for (var j = 0; j < subs.length; j++) if (subs[j].id === id) return true;
      }
      return false;
    }

    /**
     * 懒取某个子类下的标签（一次，之后走缓存）。
     *
     * 🔴 代次判据必须是 **`!==`**，不能写 `>`。写成 `mySeq > seq` 时这个守卫**永远不成立**
     *    （`seq` 只增不减 ⇒ `mySeq > seq` 恒假），于是过期回包照样往回写，而代码看起来
     *    「已经防了」。这里踩过一次：它不会报错、不会写日志，只在「失败后立刻重试」
     *    这条路径上把成功的结果盖成失败。
     *    代次还必须是**按子类各一份**：共用一个全局计数会让一次搜索作废掉正在飞的子类请求。
     */
    function ensureSubTags(subId, done) {
      if (subTags[subId] !== undefined && subTags[subId] !== null) {
        if (typeof done === 'function') done();
        return Promise.resolve(subTags[subId]);
      }
      if (pending[subId]) return pending[subId];
      var myToken = (subToken[subId] || 0) + 1;
      subToken[subId] = myToken;
      var p = Promise.resolve()
        .then(function () {
          return api.getTagNavNode(subId, locale());
        })
        .then(function (res) {
          if (subToken[subId] !== myToken) return null; // 有更新的请求在飞，以那份为准
          subTags[subId] = res && res.tags ? res.tags : [];
          // 顺带把「标签 → 归属」记全：这里**确定**知道子类 id，比事后反查可靠。
          rememberPaths(subTags[subId], subId);
          if (typeof done === 'function') done();
          return subTags[subId];
        })
        .catch(function () {
          if (subToken[subId] !== myToken) return null;
          // null = 「要过但失败了」。与 `[]`（确实没有已建索引的标签）分开存：
          // 混在一起会把一次读库失败显示成「这个分类是空的」，用户再也不会点第二次。
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
    /**
     * 输入框内容变了。**只更新输入框自己的状态，一次请求都不发。**
     *
     * 分岔只有一条，而且是**清空**：删到空（或按 Esc、点清除叉）是一个显式动作，
     * 语义是「不搜了」，所以立刻退出搜索态、回到树 —— 不该等到用户再按一次提交。
     *
     * 非空则什么都不做：`keyword` 变了但 `lastQuery` / `searchResult` 都不动，
     * 于是界面**停在上一份已提交的结果上**（这正是「非实时」的定义）。等 `submitSearch`。
     */
    function onKeywordInput(value) {
      keyword = String(value == null ? '' : value);
      updateClearButton();
      if (!keyword.trim()) exitSearch();
    }

    /**
     * **显式提交**：回车 / 点搜索按钮。搜索**只有这一条**发起路径（另两处是
     * `enter()` 与 `repaintCounts()` 对**已提交**的词重搜，见 `lastQuery`）。
     */
    function submitSearch() {
      var q = keyword.trim();
      if (!q) {
        // 空提交 = 不搜了。与「清空」同一条路，别在这里另写一份（两份必然漂）。
        exitSearch();
        return;
      }
      void runSearch(q);
    }

    /**
     * 退出搜索态（清空 / Esc / 清除叉 / 空提交）。
     *
     * 🔴 `searchToken++` 是**必须的**：退出时可能有请求还在飞。只清 `searchResult`
     *    而不作废代次的话，那份回包回来时代次仍然相等 ⇒ 把你刚清掉的搜索结果又贴回来，
     *    侧栏从树变回搜索列表、主区跟着跳一下。清空看起来「没生效、自己弹回来了」。
     *
     * 🔴 判据是 `searchResult` 而不是 `keyword`：这里只负责把**搜索态**关掉；
     *    `keyword` 由调用方（`onKeywordInput`）维护，退出时它本来就是空的了。
     */
    function exitSearch() {
      if (!searchResult && !lastQuery) return; // 本来就没在搜：不重画、不刷主区（省掉一次抖动）
      searchToken++;
      lastQuery = '';
      searchResult = null;
      renderSidebar();
      refreshMainForSearch();
    }

    /**
     * 搜索态变了 ⇒ **主区也要跟着变**。
     *
     * 🔴 这条是探针抓出来的真 bug：`runSearch` 原先只 `renderSidebar()`，
     *    于是主区停在「上一次那张卡片列表」，快得看不出来 —— 侧栏已经换成搜索结果了，
     *    用户在右边却找不到刚搜到的标签。静默、不报错。
     *
     * 🔴 判据只能是 `state.currentTag`，不能是 `state.currentView === 'tag'`：
     *    后者只说明「在标签页里」，说明不了主区现在是什么（照片网格还是卡片列表）。
     *    `currentTag` 有值时主区是照片网格，此时把用户从照片上拽回卡片属于「界面乱跳」；
     *    侧栏的搜索结果照常更新，用户点了其中一条才会切过去（`onSelectTag`）。
     */
    function refreshMainForSearch() {
      if (state.currentTag) return;
      if (typeof onRenderCards === 'function') onRenderCards();
    }

    function updateClearButton() {
      var host = sidebarEl();
      if (!host) return;
      var clear = host.querySelector('#tagNavSearchClear');
      if (clear) clear.hidden = !keyword;
    }

    /**
     * 发一次搜索。**只有显式提交与「对已提交的词重搜」会走到这里。**
     *
     * `lastQuery` 在这里落地（唯一赋值点），所以「谁是在途请求对应的那个词」永远只由本函数决定。
     */
    function runSearch(q) {
      var myToken = ++searchToken;
      lastQuery = String(q == null ? '' : q).trim();
      return Promise.resolve()
        .then(function () {
          return api.getTagNavSearch(q, locale());
        })
        .then(function (res) {
          // 🔴 过期回包只看**代次**：`exitSearch()` 会 `searchToken++` 把在途请求一并作废，
          //    所以「清空之后回包又把结果贴回来」也被这一条挡住。
          //
          //    原先这里还有一句 `if (keyword.trim() !== q.trim()) return;` —— 实时搜时代它
          //    是对的（输入框变了就说明这份结果已经没意义）。**提交式搜索下它是错的**：
          //    `keyword` 可以合法地不等于最后一次提交的词（用户按了回车、又在回包前敲了几个字），
          //    那时这份结果**才是该显示的**，却被丢掉 ⇒ 侧栏没有 `searchResult`、停在树上，
          //    主区停在上一次的卡片列表，看起来就是「按了回车没反应」。必须删掉。
          if (searchToken !== myToken) return;
          searchResult = res && (res.tags || res.nodes) ? res : { tags: [], nodes: [], indexed: 0 };
          // 搜索结果自带 `node` / `category`（主进程算好的）⇒ 把归属记全。
          // 这样从搜索结果点标签、或者之后切语言要重取名字，都不必再问一次主进程。
          rememberPaths(searchResult.tags, '');
          renderSidebar();
          refreshMainForSearch();
        })
        .catch(function () {
          if (searchToken !== myToken) return;
          // 形状必须与成功路径一致（含 `indexed`）：空态判据读的就是它。
          searchResult = { tags: [], nodes: [], indexed: 0 };
          renderSidebar();
          refreshMainForSearch();
        });
    }

    // ------------------------------------------------------------ 选中动作
    /**
     * 选中一个标签 ⇒ 主区换成照片网格。
     *
     * `node` / `category` 是调用点带来的归属（搜索结果的行与卡片上有）。**带着它一起走**
     * 是刻意的：只知道标签名的话，前面那些「展开树到它 / 切语言重取名字」都得再问一次
     * 主进程，而渲染层没有 `ai/tag-categories` 可以自己反查。
     */
    function selectTag(tag, node, category) {
      var id = String(tag || '');
      rememberPath(id, node, category);
      state.currentTag = id;
      state.currentTagNode = '';
      state.page = 1;
      // 沿路把树展开到它。**必须在这里做**，不能只在点击处做：
      // 导航历史 / 启动恢复是直接 `selectTag(tag)` 进来的，没有点击点；
      // 不做的话侧栏一片没高亮，用户看不出自己在哪儿。
      var p = tagPath[id];
      if (p) {
        if (p.category) expanded[p.category] = true;
        if (p.node) {
          expanded[p.node] = true;
          void ensureSubTags(p.node, function () {
            renderSidebar();
            if (typeof onChromeRefresh === 'function') onChromeRefresh();
          });
        }
      }
      renderSidebar();
      if (typeof onSelectTag === 'function') onSelectTag(id);
    }

    function selectNode(kind, id) {
      state.currentTag = '';
      state.currentTagNode = kind && kind !== 'root' ? id : '';
      state.currentTagNodeKind = kind === 'category' || kind === 'sub' ? kind : '';
      state.page = 1;
      renderSidebar();
      if (typeof onRenderCards === 'function') onRenderCards();
    }

    // ---------------------------------------------------------------- 主区
    /**
     * 主区卡片列表（分类总览 / 节点下的标签）。
     *
     * 由 `app.js#loadPhotos` 在「标签页且没选中具体标签」时调用 —— 走 `loadPhotos` 而不是
     * 由本模块各调用点直接调，是为了让**所有**刷新路径（媒体过滤档、库变更失效、
     * 语言切换、启动落地）都自动重画卡片，不用逐个去补（补漏一处就是一个静默空主区）。
     *
     * 卡片项的形状统一为 `{kind, id, name, count}`：
     *   · `kind: 'category' | 'sub'` ⇒ 点击下钻（选中该节点、继续列标签卡片）
     *   · `kind: 'tag'`             ⇒ 点击进入该标签的照片网格
     */
    function renderBrowseCards() {
      var grid = dom.photoGrid;
      if (!grid) return;
      var myToken = ++cardsSeq;
      if (dom.pagination) dom.pagination.style.display = 'none';

      // ① 搜索态：主区与侧栏共用同一份搜索结果（侧栏那份只列名字，这里带命中数）
      if (searchResult) {
        renderCardList(grid, searchCards(), myToken, emptyTextFor(searchResult.indexed, 'search'));
        return;
      }
      // ② 没选中任何节点 ⇒ 分类总览
      if (!state.currentTagNode) {
        renderCardList(grid, categoryCards(), myToken, emptyTextFor(0, 'node'));
        return;
      }
      // ③ 选中了分类 / 子类 ⇒ 列它下面的标签（要等一次回包）
      var nodeId = state.currentTagNode;
      grid.innerHTML =
        '<div class="empty-state"><div class="title">' +
        esc(t('tagnav.searching', '正在搜索…')) +
        '</div></div>';
      void loadNodeCards(nodeId, myToken);
    }

    function categoryCards() {
      var out = [];
      for (var i = 0; i < treeData.length; i++) {
        var cat = treeData[i];
        out.push({
          kind: 'category',
          id: cat.id,
          name: tNode('category', cat.id),
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
        out.push({
          kind: nodes[i].kind === 'category' ? 'category' : 'sub',
          id: nodes[i].id,
          name: tNode(nodes[i].kind === 'category' ? 'category' : 'sub', nodes[i].id),
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
          // 归属节点随卡片带着走 —— 渲染层拿不到主进程的 `ai/tag-categories`，
          // 没法自己由标签名反查子类；搜索结果里主进程已经算好了，别丢。
          node: tags[j].node || '',
          category: tags[j].category || '',
        });
      }
      return out;
    }

    function loadNodeCards(nodeId, myToken) {
      return Promise.resolve()
        .then(function () {
          return api.getTagNavNode(nodeId, locale());
        })
        .then(function (res) {
          // 代次 + 现场状态**两道**判据：代次挡住「同一次进入里的旧回包」，
          // 现场状态挡住「已经切走之后才回来的那份」（那时代次可能又对上了）。
          if (myToken !== cardsSeq) return;
          if (state.currentView !== 'tag' || state.currentTag) return;
          if (state.currentTagNode !== nodeId) return;
          var grid = dom.photoGrid;
          if (!grid) return;
          var tags = (res && res.tags) || [];
          // 这一趟**确定**知道自己在哪个节点上 ⇒ 把归属记全，值比搜索结果更可靠。
          // 节点若是顶层分类，`fallbackNode` 填的就是分类 id：拿它当子类去展开会展开
          // 一个「合起来的子类」，界面不会错（`ensureSubTags` 会真的回标签列表），
          // 只是树上那一层本来就没有对应的子行 —— 这是既有取舍，不在这里造特例。
          rememberPaths(tags, nodeId);
          renderCardList(
            grid,
            tags.map(function (tag) {
              // 服务端已按展示线过滤（`main/tag-nav.js#node`）：这里不会出现 0 张的标签。
              return { kind: 'tag', id: tag.tag, name: tag.name, count: tag.count };
            }),
            myToken,
            emptyTextFor(res && res.indexed, 'node'),
          );
        })
        .catch(function () {
          if (myToken !== cardsSeq) return;
          var grid = dom.photoGrid;
          if (!grid) return;
          grid.innerHTML =
            '<div class="empty-state"><div class="title">' +
            esc(t('tagnav.loadFail', '标签数据读取失败，请稍后重试')) +
            '</div></div>';
        });
    }

    /**
     * 「列表空了」该说哪句话。
     *
     * 🔴 两种空**必须分开**：`indexed === 0` 是「这儿还没有已建立索引的标签」（索引没铺到），
     *    `indexed > 0` 是「有标签、但都低于当前展示线」（调低展示线就有图）。
     *    混成一句的代价是双向的：前一种情况用户会去翻设置白忙，后一种情况会去重建索引白等。
     *
     * @param {number} indexed 过滤**前**的候选数（`node()` 的 `indexed` / `search()` 的 `indexed`，
     *   两者同一口径：候选里已出现在索引中的个数）。
     * @param {'search'|'node'} mode 决定「一个都没有」时说的是搜不到还是这儿本来没有。
     */
    function emptyTextFor(indexed, mode) {
      var n = Number(indexed) || 0;
      if (n > 0) {
        return tFmt(
          'tagnav.belowLineHint',
          { count: fmtNumber(n) },
          '{count} 个标签都低于当前展示线，暂时没有可显示的图片。可在设置里调低「标签展示线」。',
        );
      }
      return mode === 'search'
        ? t('tagnav.noResult', '没有匹配的标签')
        : t('tagnav.noTagHit', '这个节点下还没有已建立索引的标签');
    }

    function renderCardList(grid, items, myToken, emptyText) {
      if (myToken !== cardsSeq) return;
      if (!items.length) {
        grid.innerHTML =
          '<div class="empty-state"><div class="title">' +
          esc(emptyText || t('tagnav.noTagHit', '这个节点下还没有已建立索引的标签')) +
          '</div></div>';
        return;
      }
      var html = '<div class="tag-nav-cards">';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var countLabel;
        if (it.kind === 'tag') {
          // 标签卡片一定有数（服务端过滤过），`|| 0` 只是兜住形状异常时别渲染出 undefined。
          countLabel = tFmt('tagnav.tagCount', { count: fmtNumber(it.count || 0) }, '{count} 张');
        } else {
          countLabel = it.count
            ? tFmt('tagnav.nodeTags', { count: fmtNumber(it.count) }, '{count} 个标签')
            : '';
        }
        html +=
          '<button type="button" class="tag-nav-card' +
          (it.dim ? ' is-dim' : '') +
          '" data-tag-card-kind="' +
          escAttr(it.kind) +
          '" data-tag-card-id="' +
          escAttr(it.id) +
          '" data-tag-card-node="' +
          escAttr(it.node || '') +
          '" data-tag-card-cat="' +
          escAttr(it.category || '') +
          '" title="' +
          escAttr(it.id) +
          '">' +
          '<span class="tag-nav-card-name">' +
          esc(it.name) +
          '</span>' +
          (countLabel
            ? '<span class="tag-nav-card-count">' + esc(countLabel) + '</span>'
            : '') +
          '</button>';
      }
      html += '</div>';
      grid.innerHTML = html;
      var host = grid.querySelector('.tag-nav-cards');
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
        if (isSubId(id)) void ensureSubTags(id, function () { renderSidebar(); });
      }
      selectNode(kind, id);
    }

    /**
     * 某个标签的**显示名**（当前语言）。只从已加载的数据里找 —— 找不到就回原文。
     *
     * 不给它单开一条「按名字查」的 IPC：那样每换一个标签都要多一次往返，而结果
     * 与侧栏里那行文字永远一致（都来自 `get-tag-nav-node` / `get-tag-nav-search` 的 `name`）。
     * 找不到的场景只有「还没展开过这个标签所在的子类」（例如启动时从导航历史直接进入
     * 某标签），那时回原文是**可见地不理想**，但不会错。
     */
    function displayName(tag) {
      var t0 = String(tag || '');
      if (!t0) return '';
      for (var sub in subTags) {
        if (!Object.prototype.hasOwnProperty.call(subTags, sub)) continue;
        var list = subTags[sub];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) {
          if (list[i].tag === t0) return list[i].name || t0;
        }
      }
      if (searchResult && searchResult.tags) {
        for (var j = 0; j < searchResult.tags.length; j++) {
          if (searchResult.tags[j].tag === t0) return searchResult.tags[j].name || t0;
        }
      }
      return t0;
    }

    function locale() {
      try {
        if (global.I18n && typeof global.I18n.getLocale === 'function') return global.I18n.getLocale();
      } catch (e) {}
      return 'zh-CN';
    }

    // ---------------------------------------------------------------- 入口
    /** 进入「标签」页：拉状态与树，然后画侧栏。**幂等**，重复进不会叠加监听。 */
    function enter() {
      renderSidebar(); // 先给骨架（转圈/空态），不要让侧栏停在上一页的内容上
      return Promise.resolve()
        .then(function () {
          return Promise.all([api.getTagNavStatus(), api.getTagNavTree()]);
        })
        .then(function (pair) {
          statusData = pair[0] || { available: false, tags: 0, photos: 0 };
          treeData = Array.isArray(pair[1]) ? pair[1] : [];
          /**
           * 🔴 展示线改过（`invalidateCounts` 只清了缓存、没重取）⇒ **必须走 `repaintCounts()`**：
           *    `renderSidebar()` 自己不发请求，已展开的子类在没有缓存时会被画成
           *    「正在搜索…」并**永远停在那里**（请求是点击时才发的，没人再点它）。
           *    这里 `return` 是刻意的：`repaintCounts()` 末尾已经按同一个条件
           *    （`!state.currentTag`）画过主区卡片，再往下走一遍就是连取两次。
           */
          if (countsDirty) {
            repaintCounts();
            return;
          }
          renderSidebar();
          // 🔴 主区的分类总览卡片也依赖 treeData。`loadPhotos` 可能在**这之前**就跑完了
          //    （进页时它先于本请求的回包），那时 `categoryCards()` 还是空的 ⇒ 主区白屏。
          //    别赌两个请求谁快 —— 数据落地后补一次（只在卡片态补，别把看照片的人拽回来）。
          if (!state.currentTag && typeof onRenderCards === 'function') onRenderCards();
        })
        .catch(function () {
          statusData = { available: false, tags: 0, photos: 0 };
          treeData = [];
          renderSidebar();
        });
    }

    /**
     * 语言切换：树与卡片都是渲染时生成的文案，必须整体重画。
     *
     * 🔴 **只重画不够**，缓存也得失效。`get-tag-nav-node(nodeId, locale)` 是按 locale
     *    给 `name` 的（见 `main/tag-nav.js#node`），所以 `subTags` 里存的是**上一种语言**
     *    的名字。原先这里只调 `renderSidebar()`，后果是：中文进页 → 展开 `hair` → 切英文
     *    ⇒ 侧栏其它部分换了语言，**已经展开的子树仍然写着「黑发 / 长发」**。
     *    静默、不报错，只在切语言时看得见（探针抓到的第三处）。
     */
    function refreshLocale() {
      if (state.currentView !== 'tag' && state.currentTab !== 'tags') return;
      subTags = Object.create(null);
      pending = Object.create(null);
      // ⚠️ 两条路径（展开着的子类、当前选中的标签）可能指向**同一个**子类，而
      //    `ensureSubTags` 对同一子类的并发请求会按 `pending` 合并 —— 后进来的那个
      //    callback 根本不会被调用。所以「回包之后干什么」必须写成**一个共用函数**，
      //    挂在每一次调用上：谁真的发出了请求，就由谁触发。
      //    第一版把 `onChromeRefresh` 只挂在第二个 callback 上，结果路径栏永远停在
      //    旧语言的名字（叶子已经换成中文了，路径栏还写着 `black_hair`）。
      function afterSubLoad() {
        renderSidebar();
        if (typeof onChromeRefresh === 'function') onChromeRefresh();
      }
      // 展开着的子类要按新语言重新取一遍 —— 否则那些行会停在旧语言。
      Object.keys(expanded).forEach(function (id) {
        if (!isSubId(id)) return;
        void ensureSubTags(id, afterSubLoad);
      });
      // 当前选中的标签：它的归属知道 ⇒ 顺手把名字也换过来（路径栏要用）。
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
      // 🔴 判据是 `lastQuery`（**已提交**的那个词），不是 `keyword`：
      //    切语言时用户可能刚在输入框里敲了半截话还没提交，拿 `keyword` 判就会
      //    替他把搜索开起来 —— 侧栏从树变成搜索结果、主区跟着跳。
      //    在搜的话，服务端给的 `name` 是按 locale 的，必须按新语言重取一遍。
      if (lastQuery) void runSearch(lastQuery);
      renderSidebar();
      if (typeof onRenderCards === 'function' && !state.currentTag) onRenderCards();
    }

    /** 标签页是不是当前视图。判据与 `refreshLocale` 第一行**逐字相同**（两条入口必须一致）。 */
    function onTagPage() {
      return state.currentView === 'tag' || state.currentTab === 'tags';
    }

    /**
     * **展示线改了**：让「按旧分数线算出来的数字」全部作废。
     *
     * ## 为什么非要这一手
     *
     * 标签展示线（设置项 `aiTagDisplayThreshold`）是**读侧**分数线，主进程下一次查询就用新值
     * （两个读侧服务每调用现取）。但渲染层这边有**进程级缓存**：`subTags` 按子类存住整个
     * 「标签 → 张数」列表（`ensureSubTags` 里 `if (subTags[subId] !== undefined)` 直接返回），
     * `searchResult` 存住搜索结果的张数。不失效它们，改完设置回到标签页看到的还是旧数字，
     * 而**没有任何地方会报错** —— 用户唯一的结论是「这个设置没用」。
     *
     * ## 为什么与 `refreshLocale` 分开写（明明做的事很像）
     *
     * 三处不同，合并会同时踩：
     *   ① **触发时人在哪儿**：切语言一定发生在应用内（人在标签页或就在设置页），
     *      而改展示线时人**在设置页** —— `refreshLocale` 第一行会直接 return，
     *      于是「缓存都没清」。这里必须**先清缓存、再判断要不要重画**（顺序反了 = 静默空操作）；
     *   ② **`countsDirty` 标记**：清完缓存人还没回标签页时，展开着的子类那几行会停在
     *      「正在搜索…」（`renderSidebar` 自己不发请求，请求是点击时才发的）——
     *      所以记一个脏标记，由 `enter()` 在进页时补齐重取；
     *   ③ 语言那边还要连**名字**一起换（`afterSubLoad` 里的 `onChromeRefresh`），这边不用。
     */
    function invalidateCounts() {
      subTags = Object.create(null);
      pending = Object.create(null);
      searchResult = null;
      countsDirty = true;
      // 人此刻就在标签页（例如设置页以后改成浮层、或同一台机器上另一处触发）⇒ 立刻按新线重画。
      if (onTagPage()) repaintCounts();
    }

    /**
     * 按当前（新）分数线重取一遍并重画。
     *
     * ⚠️ `renderSidebar()` **自己不会发请求** —— 已展开但没有缓存的行只会画成
     *    「正在搜索…」。所以必须在这里主动 `ensureSubTags`，否则那几行永远停在转圈。
     */
    function repaintCounts() {
      countsDirty = false;
      function afterSubLoad() {
        renderSidebar();
      }
      Object.keys(expanded).forEach(function (id) {
        if (!isSubId(id)) return;
        void ensureSubTags(id, afterSubLoad);
      });
      // 同 `refreshLocale`：判据是 `lastQuery`。展示线是**读侧**分数线，服务端下次查询就用新值，
      // 所以已在搜的词必须重搜一遍，否则搜索结果里的数字还是按旧线算的。
      if (lastQuery) void runSearch(lastQuery);
      renderSidebar();
      if (typeof onRenderCards === 'function' && !state.currentTag) onRenderCards();
    }

    return {
      enter: enter,
      renderSidebar: renderSidebar,
      renderBrowseCards: renderBrowseCards,
      refreshLocale: refreshLocale,
      /** 展示线（设置项）改完由 `app.js#tagLayer.write` 调用，见 `invalidateCounts`。 */
      invalidateCounts: invalidateCounts,
      selectTag: selectTag,
      selectNode: selectNode,
      displayName: displayName,
      /** 供守护与其它模块做定点断言用（不参与界面逻辑）。 */
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
        /** 展示线改过但还没回标签页重取 ⇒ true（守护用它断言「离线改设置也会重取」）。 */
        countsDirty: function () {
          return countsDirty;
        },
      },
    };
  }

  global.RendererTagNavUI = { mount: createTagNavUI };
})(window);
