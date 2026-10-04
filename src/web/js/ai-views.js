/**
 * 网页端「搜图 / 人物」视图：侧栏独占——搜索框 + 搜索历史 / 人物列表都在侧栏里，
 * 结果落进主照片网格（#photoGrid），因此卡片渲染、点击进预览、上一张/下一张全部复用
 * 网页端既有的 renderPhotoGrid + startPreview 链路。
 *
 * 与桌面端一样，这里只做使用与展示：模型下载 / 建索引留在桌面端「设置」里，
 * 网页端只把状态翻成一句人话。
 */
(function (global) {
  'use strict';

  // 搜索历史：本机 localStorage，最多留最近 8 条（与桌面端同一 key，但两者不同源，互不影响）。
  var HISTORY_KEY = 'photoManager.aiSearchHistory';
  var HISTORY_MAX = 8;

  // 引导页示例：**仅在还没有真实预选词时**用。作用是「告诉用户可以用一句话描述画面」，
  // 所以宁可写死几句典型描述，也不能是一片空白。
  //
  // 侧栏「预选词」完全不使用这一份 —— 它必须来自服务端词表（`src/ai/search-vocabulary.js`）
  // 按本库真实命中数排出来的结果（见 refreshSuggestions）。历史教训：侧栏原来也摆这 18 个
  // 通用词、再用「库里有没有内容」筛一遍，筛不出一个就**回退整份静态词库**，于是库里
  // 一个都没有的「夕阳下的海滩」之类照样摆出来给用户点。桌面端同名文件必须与此一致。
  var EXAMPLES = [
    ['夕阳下的海滩', 'a beach at sunset'],
    ['雪山和湖泊', 'a lake below snowy mountains'],
    ['人物肖像', 'a portrait of a person'],
    ['城市夜景', 'city skyline at night'],
    ['美食特写', 'close-up of food'],
  ];
  var SUGGEST_COUNT = 5; // 侧栏「预选词」每次抽几个
  // 服务端一次返回多少词做池子：界面从池子里洗牌抽 5 个，「换一批」= 再洗一次，
  // 因此不必为「换一批」重新跑一遍模型。太小则两批重复率太高，太大则白花请求与渲染。
  var SUGGEST_POOL_LIMIT = 24;

  function init(deps) {
    deps = deps || {};
    var state = deps.state || {};
    var dom = deps.dom || {};
    var get =
      deps.get ||
      function () {
        return Promise.reject(new Error('no transport'));
      };
    var post =
      deps.post ||
      function () {
        return Promise.reject(new Error('no transport'));
      };
    var renderPhotoGrid = deps.renderPhotoGrid;
    var escapeHtml =
      deps.escapeHtml ||
      function (s) {
        return s == null ? '' : String(s);
      };
    var setDisplay = deps.setDisplay || function () {};

    function isEn() {
      return String(document.documentElement.lang || '').startsWith('en');
    }
    function t(zh, en) {
      return isEn() ? en : zh;
    }
    function h(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    /** 侧栏窄、计数可能上百万：压成 1.2万 / 3.4k 这种一眼能读的形态。 */
    function compactCount(value) {
      var n = Number(value) || 0;
      if (isEn()) {
        if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
        return String(n);
      }
      if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
      if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
      return String(n);
    }

    var gen = 0;
    var busy = false;
    // showing 与 state.currentView 解耦：浏览视图装载时要靠它判断「刚才还在智能视图」，
    // 从而收掉智能视图的侧栏并恢复文件名搜索与筛选/排序。
    var showing = false;
    var pollTimer = null;
    var lastStatus = null;
    var person = null;
    var groupItems = [];
    var photoItems = [];
    var photoCursor = null;
    // 搜图结果：`searchHits` 是本次达标的全部，`searchShown` 是已渲染张数（见 renderSearchPage）。
    var searchHits = [];
    var searchShown = 0;
    var SEARCH_PAGE = 200;
    var rowById = {}; // personId -> 侧栏列表项 DOM
    var peopleQuery = ''; // 侧栏人物搜索词（只筛列表，不动主区照片）
    var renaming = null; // 正在改名的那一行，同时只允许一行进入编辑态
    var historyItems = readHistory();
    // 侧栏「预选词」这一批：进入搜索视图时抽一次，之后「换一批」才重抽。
    // 存下来而不是每次渲染都抽，否则任何一次重绘都会让词跳变。
    var suggestBatch = null;
    // 按本库真实命中数排出来的词池（**只有这一份来源**，空数组 = 这个库挑不出词）。
    // `suggestLang` 记住是哪一种语言的池：切语言要重取，否则中文界面会摆出英文词。
    var suggestPool = [];
    var suggestLang = '';
    var suggestState = 'idle';

    // 侧栏 DOM 引用（每次重建后刷新）
    var statusEl = null;
    var listEl = null;
    var inputEl = null;
    var clearEl = null;
    var suggestEl = null;
    var liveEl = null;
    var liveTextEl = null;
    var liveStatsEl = null;
    var peopleInputEl = null;

    function isSearch() {
      return state.currentView === 'ai_search';
    }
    function isPeople() {
      return state.currentView === 'people';
    }
    function active() {
      return isSearch() || isPeople();
    }

    // ---------- 搜索历史 ----------

    function readHistory() {
      try {
        if (!global.localStorage) return [];
        var raw = global.localStorage.getItem(HISTORY_KEY);
        var parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter(function (item) {
            return typeof item === 'string' && item.trim();
          })
          .slice(0, HISTORY_MAX);
      } catch (error) {
        return [];
      }
    }

    function writeHistory(list) {
      try {
        if (global.localStorage) global.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      } catch (error) {
        /* 隐私模式 / 配额满：静默降级 */
      }
    }

    function rememberSearch(query) {
      var value = String(query || '').trim();
      if (!value) return;
      historyItems = [value]
        .concat(
          historyItems.filter(function (item) {
            return item !== value;
          }),
        )
        .slice(0, HISTORY_MAX);
      writeHistory(historyItems);
      renderHistory();
    }

    function clearHistory() {
      historyItems = [];
      writeHistory(historyItems);
      renderHistory();
    }

    function renderHistory() {
      if (!listEl) return;
      listEl.replaceChildren();
      if (clearEl) clearEl.hidden = !historyItems.length;
      if (!historyItems.length) {
        listEl.appendChild(
          h('div', 'ai-web-sidebar-empty', t('还没有搜索记录', 'No search history yet')),
        );
        return;
      }
      historyItems.forEach(function (query) {
        var item = h('button', 'ai-web-history-item');
        item.type = 'button';
        item.appendChild(h('span', 'ai-web-history-icon', '🕘'));
        item.appendChild(h('span', 'ai-web-history-text', query));
        item.addEventListener('click', function () {
          if (inputEl) inputEl.value = query;
          void startSearch(query);
        });
        listEl.appendChild(item);
      });
    }

    // ---------- 侧栏：搜图预选词 ----------

    /**
     * 从词池里洗牌取前 n 个。词池**只有一个来源**（本库真实命中数排出来的那批），
     * 空了就返回空数组 —— 见 refreshSuggestions 里关于「不回退静态词库」的说明。
     */
    function pickSuggestions(count) {
      var pool = suggestPool.slice();
      for (var i = pool.length - 1; i > 0; i -= 1) {
        var j = Math.floor(Math.random() * (i + 1));
        var swap = pool[i];
        pool[i] = pool[j];
        pool[j] = swap;
      }
      return pool.slice(0, count);
    }

    /**
     * 取「这个图库里点下去真有图的词」。一个会话一次（换语言重取一次）。
     *
     * 词表**不在这一层**：服务端拿 `src/ai/search-vocabulary.js` 那份几百词的开放词表，
     * 按检索同一套口径（基线差 + 当前阈值）在本库上跑一遍，按真实命中数排序后返回前
     * `SUGGEST_POOL_LIMIT` 个。所以收到的每一个词都是**算出来的**，不是写死的，
     * 且与桌面端同一份词表、同一套排序。
     *
     * 拿不到结果（没有索引、模型没就绪、任务忙、一个词都不达标）时**不回退到任何静态词库**：
     * 旧实现正是在这里回退，于是库里一个都没有的「夕阳下的海滩」照样被摆出来给用户点。
     * 宁可把这一块整个收起来 —— 引导页已经在讲「可以用一句话描述画面」。
     */
    function refreshSuggestions() {
      var lang = isEn() ? 'en' : 'zh-CN';
      if (suggestState === 'pending' || (suggestState === 'done' && suggestLang === lang)) return;
      // 换语言重取时先丢掉旧池：那一池是**另一种语言**的成品词（服务端按 lang 给的是
      // 成品文本，不是词对），留着会在加载期间摆出「中文界面配英文词」的错位。
      if (suggestLang && suggestLang !== lang) {
        suggestPool = [];
        suggestBatch = null;
      }
      suggestState = 'pending';
      suggestLang = lang;
      // 立刻切到加载态，不能等 `.then()` 才画：取词要起一个只读 worker（载模型 ~2.1s）
      // + 打开索引（~0.7s）+ 打分（~1s），冷启还要现算 308 个词的词表向量（~15s）。
      // 旧实现把这段等待留成空白，用户读到的是「这里没有东西」，而不是「正在挑」。
      renderSuggest();
      post('/api/ai-search-suggest', { lang: lang, limit: SUGGEST_POOL_LIMIT })
        .then(function (data) {
          suggestState = 'done';
          if (isEn() !== (lang === 'en')) return; // 期间切了语言：等下一次重取
          suggestPool = (((data && data.terms) || []).map(function (term) {
            return term && term.text ? String(term.text) : '';
          })).filter(Boolean);
          if (!isSearch() || state.aiSearchQuery) return;
          suggestBatch = pickSuggestions(SUGGEST_COUNT);
          renderSuggest();
        })
        .catch(function () {
          // 任务忙 / 超时都当作「取不到」，且本次会话不再重试（避免每次进页面都卡一次加载）。
          suggestState = 'done';
          suggestPool = [];
          // ⚠️ 必须重画：上面已经画过骨架了，不重画的话侧栏会**永远停在「挑选中…」**——
          // 加载态假死比原本的空白更糟（空白至少是诚实的）。这里走到 `done` + 空池 = 整块收起。
          renderSuggest();
        });
    }

    /**
     * 词池还没取回来时的占位：标题 + 几条骨架 pill。
     *
     * 为什么要专门做：`refreshSuggestions` 那趟活儿不便宜 —— 起只读 worker 载模型 ~2.1s、
     * 打开索引 ~0.7s、打分 ~1s，冷启还要现算 308 个词的词表向量（~15s）。旧实现在这整段
     * 时间里把这一块 `hidden`，于是用户看到的是「没有预选词」而不是「正在挑」；以前摆的是
     * 18 个硬编码词、渲染是瞬时的，所以这个空窗是换词源之后新引入的观感回退。
     *
     * 与桌面端同构（同一套三态：真词 / 骨架 / 整块隐藏）。
     */
    function renderSuggestSkeleton() {
      suggestEl.hidden = false;
      suggestEl.setAttribute('aria-busy', 'true');
      suggestEl.replaceChildren();
      var head = h('div', 'ai-web-sidebar-section-head');
      head.appendChild(h('span', 'ai-web-sidebar-section-title', t('预选词', 'Suggestions')));
      head.appendChild(h('span', 'ai-web-suggest-hint', t('挑选中…', 'Picking…')));
      suggestEl.appendChild(head);
      var chips = h('div', 'ai-web-suggest-chips');
      chips.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < SUGGEST_COUNT; i += 1)
        chips.appendChild(h('span', 'ai-web-suggest-skeleton'));
      suggestEl.appendChild(chips);
    }

    /**
     * 搜索框下方的「预选词」：随机抽几个词摆着，点一下直接开搜。
     * 纯起点提示——不进搜索历史、不发任何额外请求。
     *
     * 三种形态：词池就绪 → 真词；正在取 → 骨架；取不到（无索引 / 模型没就绪 / 一个词都不
     * 达标 / 本次会话已失败过）→ **整块隐藏**（连标题和「换一批」一起收起来），
     * 不摆空壳也不摆假词。
     */
    function renderSuggest() {
      if (!suggestEl) return;
      if (!suggestPool.length) {
        if (suggestState === 'pending') {
          renderSuggestSkeleton();
          return;
        }
        suggestEl.replaceChildren();
        suggestEl.hidden = true;
        suggestEl.removeAttribute('aria-busy');
        return;
      }
      suggestEl.hidden = false;
      suggestEl.removeAttribute('aria-busy');
      if (!suggestBatch || !suggestBatch.length) suggestBatch = pickSuggestions(SUGGEST_COUNT);
      suggestEl.replaceChildren();
      var head = h('div', 'ai-web-sidebar-section-head');
      head.appendChild(h('span', 'ai-web-sidebar-section-title', t('预选词', 'Suggestions')));
      var shuffle = h('button', 'ai-web-sidebar-clear', t('换一批', 'Shuffle'));
      shuffle.type = 'button';
      shuffle.addEventListener('click', function () {
        suggestBatch = pickSuggestions(SUGGEST_COUNT);
        renderSuggest();
      });
      head.appendChild(shuffle);
      suggestEl.appendChild(head);
      var chips = h('div', 'ai-web-suggest-chips');
      suggestBatch.forEach(function (label) {
        var chip = h('button', 'ai-web-chip', label);
        chip.type = 'button';
        chip.setAttribute('data-ai-suggest', label);
        chip.addEventListener('click', function () {
          if (inputEl) inputEl.value = label;
          void startSearch(label);
        });
        chips.appendChild(chip);
      });
      suggestEl.appendChild(chips);
    }

    // ---------- 侧栏：人物列表（搜索过滤 + 行内改名） ----------

    /** 人物名字的展示文本：还没起名的人统一叫「未命名人物」。 */
    function personLabel(item) {
      var name = String((item && item.name) || '').trim();
      return name || t('未命名人物', 'Unnamed person');
    }

    /**
     * 搜索只筛侧栏这个列表，不碰主区照片。
     * 没名字的人拿「未命名人物」参与匹配，于是搜「未命名」能把还没起名的人一次捞出来。
     */
    function visiblePeople() {
      var query = String(peopleQuery || '')
        .trim()
        .toLowerCase();
      if (!query) return groupItems;
      return groupItems.filter(function (item) {
        return personLabel(item).toLowerCase().indexOf(query) >= 0;
      });
    }

    function renderPeopleList() {
      if (!listEl) return;
      listEl.replaceChildren();
      rowById = {};
      if (!groupItems.length) {
        listEl.appendChild(
          h(
            'div',
            'ai-web-sidebar-empty',
            lastStatus && lastStatus.busy
              ? t('正在识别人脸…', 'Detecting faces…')
              : t('还没有识别到人物', 'No people detected yet'),
          ),
        );
        return;
      }
      var list = visiblePeople();
      if (!list.length) {
        listEl.appendChild(
          h('div', 'ai-web-sidebar-empty', t('没有匹配的人物', 'No matching people')),
        );
        return;
      }
      list.forEach(function (item) {
        var row = buildPersonRow(item);
        rowById[String(item.id)] = row;
        listEl.appendChild(row);
      });
    }

    function buildPersonRow(item) {
      // 用 div + role=button 而不是 button：名字位置要能就地换成输入框，
      // 而 button 的内容模型不允许嵌 input。键盘可达性用 tabindex + Enter/Space 补回。
      var row = h('div', 'ai-web-people-item');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('data-person-id', String(item.id));
      var avatar = h('span', 'ai-web-people-avatar');
      if (item.thumbnail) {
        var img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = personLabel(item);
        img.loading = 'lazy';
        avatar.appendChild(img);
      } else {
        avatar.appendChild(h('span', 'ai-web-people-avatar-fallback', '👤'));
      }
      row.appendChild(avatar);
      var meta = h('span', 'ai-web-people-meta');
      var nameEl = h('strong', 'ai-web-people-name', personLabel(item));
      nameEl.title = t('双击可改名', 'Double-click to rename');
      meta.appendChild(nameEl);
      meta.appendChild(h('span', 'ai-web-people-count', item.photoCount + t(' 张', ' photos')));
      row.appendChild(meta);
      row.addEventListener('click', function () {
        void selectPerson(item);
      });
      row.addEventListener('keydown', function (event) {
        if (renaming) return; // 改名输入框里的键不归这一行管
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void selectPerson(item);
      });
      nameEl.addEventListener('dblclick', function (event) {
        event.stopPropagation();
        event.preventDefault();
        beginRename(item, row, nameEl);
      });
      return row;
    }

    /** 把一行的名字文本重写成当前值（改名输入框退场、失败回滚都走这里）。 */
    function repaintName(nameEl, item) {
      if (nameEl) {
        nameEl.replaceChildren();
        nameEl.textContent = personLabel(item);
      }
    }

    /** 双击名字 → 就地输入框：回车保存、Esc 取消、失焦保存。列表不重建，头像不闪。 */
    function beginRename(item, row, nameEl) {
      if (renaming || !row || !nameEl) return;
      var original = String(item.name || '').trim();
      var input = h('input', 'ai-web-people-rename');
      input.type = 'text';
      input.maxLength = 40;
      input.value = original;
      input.setAttribute('aria-label', t('人物名字', 'Person name'));
      var done = false;
      function finish(save) {
        if (done) return;
        done = true;
        renaming = null;
        var next = String(input.value || '').trim();
        if (row.classList) row.classList.remove('is-renaming');
        repaintName(nameEl, item);
        if (!save || next === original) return;
        // 乐观更新：名字立刻生效，写失败再回滚——避免请求期间名字先消失再出现。
        item.name = next;
        repaintName(nameEl, item);
        commitRename(item, row, nameEl, next, original);
      }
      // 输入框就嵌在整行的可点区域里：点它 / 双击它都不该触发「选中这个人」。
      ['click', 'dblclick', 'mousedown', 'mouseup'].forEach(function (type) {
        input.addEventListener(type, function (event) {
          event.stopPropagation();
        });
      });
      input.addEventListener('keydown', function (event) {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', function () {
        finish(true);
      });
      renaming = { id: item.id };
      if (row.classList) row.classList.add('is-renaming');
      nameEl.replaceChildren(input);
      if (input.focus) input.focus();
      if (input.select) input.select();
    }

    /** 落库改名：成功后同步当前过滤结果；失败回滚到 previous 并提示。 */
    function commitRename(item, row, nameEl, next, previous) {
      function refilter() {
        if (!String(peopleQuery || '').trim()) return;
        renderPeopleList();
        highlightPerson(person ? person.id : null);
      }
      return post('/api/person-rename', { personId: item.id, name: next })
        .then(function () {
          refilter();
        })
        .catch(function (error) {
          item.name = previous;
          repaintName(nameEl, item);
          if (row && row.classList) row.classList.remove('is-renaming');
          setStatus(explain(error));
          refilter();
        });
    }

    function highlightPerson(id) {
      Object.keys(rowById).forEach(function (key) {
        var row = rowById[key];
        if (!row || !row.classList) return;
        row.classList.toggle('active', id != null && String(id) === key);
      });
    }

    /**
     * 实时读数三格的引用（格只建一次，之后每轮只改数字）。
     * 顺序即显示顺序：已扫描 / 检出人脸 / 人物。
     */
    var liveStats = null;

    /** 三个指标的定义：key / 中文标签 / 英文标签。顺序即显示顺序。 */
    var LIVE_STAT_SPECS = [
      ['scanned', '已扫描', 'Scanned'],
      ['faces', '检出人脸', 'Faces'],
      ['people', '人物', 'People'],
    ];

    /**
     * 建三格（幂等，只建一次 DOM）。每格 = 大号数字 + 小号标签，见 ai-web-views.css 的
     * `.ai-web-live-bar`。用独立的格而不是把整句拼成一个字符串：句子折行会把「检出」
     * 拆成「检 / 出」两半、还会在行首留下孤零零的「·」分隔符，而格与格之间靠布局分隔
     * 就永远不会出现这两种情况。
     *
     * 标签文字**每轮都重写**（不跟着格一起缓存）：切换界面语言时不会重跑这里，
     * 缓存住标签就会一直停在旧语言那两个词上。
     */
    function syncLiveStats(fresh) {
      if (!liveStats && liveStatsEl) {
        var refs = {};
        LIVE_STAT_SPECS.forEach(function (spec) {
          var cell = h('div', 'ai-web-live-stat');
          var value = h('span', 'ai-web-live-value');
          var label = h('span', 'ai-web-live-label');
          cell.appendChild(value);
          cell.appendChild(label);
          liveStatsEl.appendChild(cell);
          refs[spec[0]] = { cell: cell, value: value, label: label };
        });
        liveStats = refs;
      }
      if (!liveStats) return;
      LIVE_STAT_SPECS.forEach(function (spec) {
        var ref = liveStats[spec[0]];
        ref.label.textContent = t(spec[1], spec[2]);
        setLiveStat(ref, fresh[spec[0]]);
      });
    }

    /**
     * 侧栏底部的实时读数：索引在跑时把「已扫描 / 已检出人脸 / 已识别人物」三个数字一起显示，
     * 用户一眼就能区分「在跑但没检出脸」和「在跑、正在冒出人物」。
     * 某个指标拿不到（老 worker 不上报 faces）就整格藏起来，不显示占位的「—」。
     */
    function syncLive() {
      if (!liveEl) return;
      var show = isPeople() && !!(lastStatus && lastStatus.busy);
      liveEl.hidden = !show;
      if (!show) return;
      var status = lastStatus || {};
      var people = status.people != null ? Number(status.people) : groupItems.length;
      var scanned = status.scanned != null ? status.scanned : status.indexed;
      var faces = status.faces != null ? status.faces : null;
      if (liveTextEl) liveTextEl.textContent = t('正在识别人脸', 'Detecting faces');
      syncLiveStats({
        scanned: scanned == null ? null : compactCount(scanned),
        faces: faces == null ? null : compactCount(faces),
        people: compactCount(people),
      });
    }

    /** 写一格；值为 null 表示这个指标本轮拿不到，整格藏掉。 */
    function setLiveStat(ref, text) {
      if (!ref) return;
      if (text == null) {
        ref.cell.hidden = true;
        return;
      }
      ref.cell.hidden = false;
      ref.value.textContent = text;
    }

    // ---------- 侧栏：整体 ----------

    function renderSidebar() {
      var host = dom.sidebar;
      if (!host) return;
      host.replaceChildren();
      statusEl = null;
      listEl = null;
      inputEl = null;
      clearEl = null;
      suggestEl = null;
      liveEl = null;
      liveTextEl = null;
      liveStatsEl = null;
      liveStats = null;
      peopleInputEl = null;
      if (isSearch()) buildSearchSidebar(host);
      else buildPeopleSidebar(host);
    }

    function buildSearchSidebar(host) {
      var form = h('form', 'ai-web-sidebar-search');
      var input = h('input');
      input.type = 'search';
      input.maxLength = 500;
      input.autocomplete = 'off';
      input.placeholder = t(
        '描述你想找的画面，例如：夕阳下的海滩',
        'Describe what you are looking for, e.g. a beach at sunset',
      );
      input.setAttribute('aria-label', t('画面描述', 'Scene description'));
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        submitSearch();
      });
      form.appendChild(input);
      var submit = h('button', 'ai-web-sidebar-submit', t('搜索', 'Search'));
      submit.type = 'submit';
      form.appendChild(submit);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitSearch();
      });
      host.appendChild(form);

      statusEl = h('div', 'ai-web-sidebar-status');
      statusEl.hidden = true;
      host.appendChild(statusEl);

      // 预选词：搜索框下方摆几个随机词，点一下直接搜。
      suggestEl = h('div', 'ai-web-sidebar-suggest');
      host.appendChild(suggestEl);
      renderSuggest();

      var head = h('div', 'ai-web-sidebar-section-head');
      head.appendChild(h('span', 'ai-web-sidebar-section-title', t('搜索历史', 'Search history')));
      clearEl = h('button', 'ai-web-sidebar-clear', t('清除', 'Clear'));
      clearEl.type = 'button';
      clearEl.addEventListener('click', clearHistory);
      head.appendChild(clearEl);
      host.appendChild(head);

      listEl = h('div', 'ai-web-sidebar-list');
      host.appendChild(listEl);
      inputEl = input;
      renderHistory();
    }

    function buildPeopleSidebar(host) {
      statusEl = h('div', 'ai-web-sidebar-status');
      statusEl.hidden = true;
      host.appendChild(statusEl);

      // 实时读数：标题一行 + 三个数字一栏（各格由 syncLive 填）
      liveEl = h('div', 'ai-web-live-bar');
      liveEl.hidden = true;
      var liveHead = h('div', 'ai-web-live-head');
      liveHead.appendChild(h('span', 'ai-web-live-dot'));
      liveTextEl = h('span', 'ai-web-live-text');
      liveHead.appendChild(liveTextEl);
      liveEl.appendChild(liveHead);
      liveStatsEl = h('div', 'ai-web-live-stats');
      liveEl.appendChild(liveStatsEl);
      liveStats = null;
      host.appendChild(liveEl);

      // 人物搜索：输入即过滤，不发请求；未命名的人搜「未命名」也能命中。
      var search = h('div', 'ai-web-people-search');
      var field = h('span', 'ai-web-people-search-field');
      var peopleInput = h('input');
      peopleInput.type = 'search';
      peopleInput.maxLength = 80;
      peopleInput.autocomplete = 'off';
      peopleInput.value = peopleQuery;
      peopleInput.placeholder = t('搜索人物名字', 'Search people by name');
      peopleInput.setAttribute('aria-label', t('搜索人物', 'Search people'));
      var applyQuery = function () {
        peopleQuery = String(peopleInput.value || '');
        if (!isPeople()) return;
        renderPeopleList();
        highlightPerson(person ? person.id : null);
      };
      peopleInput.addEventListener('input', applyQuery);
      peopleInput.addEventListener('search', applyQuery);
      peopleInput.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !peopleInput.value) return;
        peopleInput.value = '';
        applyQuery();
      });
      field.appendChild(peopleInput);
      search.appendChild(field);
      host.appendChild(search);
      peopleInputEl = peopleInput;

      listEl = h('div', 'ai-web-sidebar-list');
      host.appendChild(listEl);
      renderPeopleList();
    }

    function submitSearch() {
      void startSearch(inputEl ? inputEl.value : '');
    }

    // ---------- 状态 ----------

    function setStatus(text) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.hidden = !text;
    }

    function applyToolbar() {
      var search = isSearch();
      if (dom.headerTitle)
        dom.headerTitle.textContent = search ? t('搜图', 'Search') : t('人物', 'People');
      // 智能视图用侧栏承载搜索框 / 人物列表，顶栏的媒体筛选与排序一并让位。
      setDisplay('#headerMediaFilterSelect', 'none');
      setDisplay('#sortSelect', 'none');
    }

    function noticeFor(status) {
      if (!status) return '';
      if (!status.ready)
        return t(
          '本地模型尚未就绪，请在桌面端「设置」完成下载。',
          'Models are not ready. Finish the download in the desktop app.',
        );
      if (!status.indexed && !status.busy)
        return t(
          '还没有建立索引，请在桌面端「设置」建立。',
          'Nothing is indexed yet. Build the index in the desktop app.',
        );
      return '';
    }

    // ---------- 网格 ----------

    function syncPreviewWindow(count) {
      state.previewTotalPhotos = count;
      state.previewTotalPages = 1;
      state.previewPageStart = 1;
      state.previewLoadingPage = 0;
      state.page = 1;
      setDisplay('#pagination', 'none');
      // 分页条里还挂着卡片大小/每页数量/随机跳页，智能视图下没有意义，整条页脚一起收掉。
      setDisplay('#browseFooter', 'none');
    }

    function emptyHtml(icon, title, hint, extra) {
      return (
        '<div class="empty-state ai-web-empty">' +
        '<div class="empty-state-visual" aria-hidden="true">' +
        icon +
        '</div>' +
        '<div class="title">' +
        escapeHtml(title) +
        '</div>' +
        (hint ? '<p class="empty-state-hint">' + escapeHtml(hint) + '</p>' : '') +
        (extra || '') +
        '</div>'
      );
    }

    var SEARCH_ICON =
      '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:52px;height:52px;opacity:0.55"><circle cx="27" cy="27" r="17"/><path d="M40 40l14 14"/></svg>';
    var PEOPLE_ICON =
      '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:52px;height:52px;opacity:0.55"><circle cx="25" cy="24" r="9"/><path d="M8 54c0-9 8-15 17-15s17 6 17 15"/><path d="M42 18a8 8 0 0 1 0 15M46 40c6 2 10 7 10 14"/></svg>';

    function renderSearchIdle(message) {
      // 有真实词池就用真实的（和侧栏同一批，前 5 个），没有才退回那几句典型描述。
      // 这样「示例」也不会出现「点下去 0 张」的情况。
      var samples = suggestPool.length
        ? suggestPool.slice(0, SUGGEST_COUNT)
        : EXAMPLES.map(function (pair) {
            return isEn() ? pair[1] : pair[0];
          });
      var chips = samples
        .map(function (label) {
          return (
            '<button type="button" class="ai-web-chip" data-ai-query="' +
            escapeHtml(label) +
            '">' +
            escapeHtml(label) +
            '</button>'
          );
        })
        .join('');
      var grid = dom.photoGrid;
      if (!grid) return;
      grid.innerHTML = emptyHtml(
        SEARCH_ICON,
        t('描述你想找的画面', 'Describe what you are looking for'),
        message ||
          t(
            '支持中文、英文等语言，例如「雪山下的湖泊」。照片与文字都在本机处理。',
            'Describe in Chinese, English or other languages, e.g. “a lake below snowy mountains”. Photos and queries stay on this machine.',
          ),
        '<div class="ai-web-chips">' + chips + '</div>',
      );
      state.currentPhotos = [];
      syncPreviewWindow(0);
    }

    function renderPeopleIdle(message) {
      var grid = dom.photoGrid;
      if (!grid) return;
      grid.innerHTML = emptyHtml(
        PEOPLE_ICON,
        t('从左侧选择一个人', 'Pick a person on the left'),
        message || t('点击左侧人物即可查看 TA 的照片。', 'Click a person to view their photos.'),
      );
      state.currentPhotos = [];
      syncPreviewWindow(0);
    }

    function renderEmpty(title, hint) {
      if (!dom.photoGrid) return;
      dom.photoGrid.innerHTML = emptyHtml(PEOPLE_ICON, title, hint);
      state.currentPhotos = [];
      syncPreviewWindow(0);
    }

    function renderCards(list) {
      photoItems = list;
      state.currentPhotos = list;
      syncPreviewWindow(list.length);
      renderPhotoGrid(list);
      if (photoCursor) appendMore(morePersonPhotos);
    }

    /**
     * 搜图结果分页渲染。阈值制下结果可能上万（阈值调 0 时泛化查询能命中全库的一大半），
     * 一次全塞进 DOM 会拖垮这一屏，先渲染一页、其余交给「更多」。
     * `state.currentPhotos` 始终是**全部**结果，预览翻页与幻灯片因此能走完整结果集。
     */
    function renderSearchPage(reset) {
      if (reset) searchShown = 0;
      searchShown = Math.min(searchHits.length, searchShown + SEARCH_PAGE);
      photoItems = searchHits;
      state.currentPhotos = searchHits;
      syncPreviewWindow(searchHits.length);
      renderPhotoGrid(searchHits.slice(0, searchShown));
      if (searchShown < searchHits.length) appendMore(moreSearchHits);
    }

    function moreSearchHits() {
      renderSearchPage(false);
    }

    function appendMore(action) {
      var grid = dom.photoGrid;
      if (!grid) return;
      var row = document.createElement('div');
      row.className = 'ai-web-more-row';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-web-more-button';
      button.textContent = t('更多', 'More');
      button.addEventListener('click', function () {
        button.disabled = true;
        void action();
      });
      row.appendChild(button);
      grid.appendChild(row);
    }

    function morePersonPhotos() {
      return loadPersonPhotos(person, photoCursor, false);
    }

    function explain(error) {
      var message = String((error && error.message) || error);
      var map = {
        AI_BUSY: t(
          '后台任务正在运行，请稍后再试。',
          'A background task is running. Try again shortly.',
        ),
        AI_MAINTENANCE: t(
          '数据库维护进行中，请稍后再试。',
          'Database maintenance is running. Try again shortly.',
        ),
        AI_MODEL_MISSING: t('本地模型尚未就绪。', 'Local models are not ready.'),
        AI_CANCELLED: t(
          '任务已停止，已完成的结果保留。',
          'Stopped. Completed results are retained.',
        ),
        AI_QUERY_INVALID: t('请输入 1–500 个字符。', 'Enter 1–500 characters.'),
        AI_TIMEOUT: t('任务超时，请稍后重试。', 'Task timed out. Try again.'),
        AI_UNAVAILABLE: t('此设备未启用本地 AI。', 'Local AI is not enabled on this device.'),
        FACE_UNAVAILABLE: t('人脸功能未启用。', 'Face features are not enabled.'),
      };
      var hit = Object.keys(map).find(function (code) {
        return message.indexOf(code) >= 0;
      });
      return hit ? map[hit] : t('操作失败：', 'Operation failed: ') + message.slice(0, 200);
    }

    function run(task) {
      if (busy) return Promise.resolve();
      busy = true;
      return Promise.resolve()
        .then(task)
        .catch(function () {})
        .then(function () {
          busy = false;
        });
    }

    // ---------- 流程 ----------

    function enter(view) {
      gen++;
      showing = true;
      lastStatus = null;
      person = null;
      groupItems = [];
      photoItems = [];
      photoCursor = null;
      searchHits = [];
      searchShown = 0;
      rowById = {};
      peopleQuery = '';
      renaming = null;
      state.currentPhotos = [];
      if (view === 'ai_search') {
        state.aiSearchQuery = '';
        // 每次进入搜索视图重抽一批预选词（「随机」要能被感知，就得换视图换词）。
        // 词池还没取回来时侧栏会走骨架态（见 renderSuggest），等结果回来再换真词。
        suggestBatch = pickSuggestions(SUGGEST_COUNT);
        // 取「本库点下去真有图的词」（一个会话一次、换语言重取一次）；拿回来会重绘本页。
        refreshSuggestions();
      }
      state.page = 1;
      setDisplay('#pagination', 'none');
      setDisplay('#browseFooter', 'none');
      renderSidebar();
      var grid = dom.photoGrid;
      if (grid) grid.scrollTop = 0;
      applyToolbar();
      if (isSearch()) {
        setStatus('');
        renderSearchIdle();
      } else {
        setStatus('');
        renderPeopleIdle();
      }
      startPolling();
    }

    function leave() {
      gen++;
      showing = false;
      stopPolling();
      lastStatus = null;
      person = null;
      rowById = {};
      peopleQuery = '';
      renaming = null;
      searchHits = [];
      searchShown = 0;
      if (dom.sidebar) dom.sidebar.replaceChildren();
      statusEl = null;
      listEl = null;
      inputEl = null;
      clearEl = null;
      suggestEl = null;
      liveEl = null;
      liveTextEl = null;
      liveStatsEl = null;
      liveStats = null;
      peopleInputEl = null;
      setDisplay('#headerMediaFilterSelect', '');
      setDisplay('#sortSelect', '');
      setDisplay('#browseFooter', '');
    }

    function load() {
      if (!active()) return Promise.resolve();
      return isSearch() ? loadSearch() : loadPeople();
    }

    function loadSearch() {
      var query = String(state.aiSearchQuery || '').trim();
      renderHistory();
      if (query) return startSearch(query);
      setStatus('');
      renderSearchIdle();
      return fetchStatus().then(function () {
        if (!isSearch()) return;
        if (String(state.aiSearchQuery || '').trim()) return;
        var message = noticeFor(lastStatus);
        // 索引在跑、但已经有可用向量：明确告诉用户「现在就能搜，只是覆盖不全」。
        if (!message && lastStatus && lastStatus.busy && lastStatus.indexed)
          message = t(
            '索引仍在建立中（已索引 ' +
              compactCount(lastStatus.indexed) +
              ' 张）：现在就能搜，结果只覆盖已索引的照片。',
            'The index is still building (' +
              compactCount(lastStatus.indexed) +
              ' indexed): you can search now, results cover indexed photos only.',
          );
        renderSearchIdle(message || undefined);
      });
    }

    function fetchStatus() {
      if (!active() || busy) return Promise.resolve();
      var url = isSearch() ? '/api/ai-search-status' : '/api/face-status';
      return get(url)
        .then(function (data) {
          if (!active()) return;
          lastStatus = data || null;
          syncLive();
          var notice = noticeFor(lastStatus);
          if (notice) setStatus(notice);
        })
        .catch(function () {});
    }

    // 轮询只做两件事：翻状态成一句人话；人物索引进行中人数变了就增量补列表。
    // 结果计数（「找到 N 张照片 / N 人」）不受影响——fetchStatus 只在有提醒时覆盖状态位。
    function startPolling() {
      stopPolling();
      pollTimer = setInterval(function () {
        if (!active() || busy) return;
        var before = lastStatus ? { people: lastStatus.people, busy: lastStatus.busy } : null;
        void fetchStatus().then(function () {
          if (!isPeople() || !active()) return;
          var people = lastStatus && lastStatus.people != null ? Number(lastStatus.people) : null;
          var grew = (!before || before.people !== people) && people > 0;
          var finished = !!(before && before.busy && lastStatus && !lastStatus.busy);
          if (grew || finished) void loadGroups(0, true);
        });
      }, 3000);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function startSearch(value) {
      if (busy || !isSearch()) return Promise.resolve();
      var query = String(value || '').trim();
      if (!query) return Promise.resolve();
      return run(function () {
        var current = gen;
        state.aiSearchQuery = query;
        if (inputEl) inputEl.value = query;
        setStatus(t('正在本机搜索…', 'Searching locally…'));
        return get('/api/ai-search?q=' + encodeURIComponent(query))
          .then(function (data) {
            if (current !== gen || !isSearch()) return;
            rememberSearch(query);
            var hits = (data && data.photos) || [];
            // matched 是**达标总数**，可能大于返回条数（内部为内存起见只保留最相近的一批）。
            var matched = data && data.matched != null ? Number(data.matched) : hits.length;
            // 索引进行中也能搜，用的是已经落库的那部分向量：把覆盖范围如实说出来，
            // 免得用户以为「搜不到」就是「没有这张照片」。
            var indexed = data && data.indexed != null ? Number(data.indexed) : null;
            var partial = lastStatus && lastStatus.busy && indexed ? compactCount(indexed) : null;
            hits.forEach(function (hit) {
              if (!hit.date_taken) hit.date_taken = hit.date_modified || '';
            });
            if (!hits.length) {
              setStatus(t('没有达到匹配阈值的照片', 'No photos above the match threshold'));
              renderEmpty(
                t('没有达到匹配阈值的照片', 'No photos above the match threshold'),
                partial
                  ? t(
                      '索引还在建立中（已索引 ' + partial + ' 张），尚未索引的照片这次搜不到。',
                      'The index is still building (' +
                        partial +
                        ' indexed). Photos not yet indexed cannot be found.',
                    )
                  : t(
                      '匹配阈值在桌面端设置里调；也可以换个说法再试试。',
                      'The match threshold is set in the desktop app. You can also try different wording.',
                    ),
              );
              return;
            }
            // 与桌面端同一口径：这个数字是「有多少张达到阈值」，不是「找到了多少张相关照片」。
            setStatus(
              partial
                ? t(
                    matched +
                      ' 张达到匹配阈值 · 按相似度排序 · 索引进行中，仅基于已索引 ' +
                      partial +
                      ' 张',
                    matched +
                      ' above the match threshold · sorted by similarity · index building, searched ' +
                      partial +
                      ' indexed so far',
                  )
                : t(
                    matched + ' 张达到匹配阈值 · 按相似度排序',
                    matched + ' above the match threshold · sorted by similarity',
                  ),
            );
            photoCursor = null;
            searchHits = hits;
            renderSearchPage(true);
            if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
          })
          .catch(function (error) {
            if (current !== gen) return;
            setStatus('');
            renderEmpty(explain(error), t('可以稍后重试。', 'Try again shortly.'));
          });
      });
    }

    function loadPeople() {
      return fetchStatus().then(function () {
        if (!isPeople()) return;
        return loadGroups(0, true);
      });
    }

    /** 侧栏要列出「所有人物」，逐页把游标翻到底（带安全上限，避免异常游标死循环）。 */
    function loadGroups(after, replace) {
      return run(function () {
        var current = gen;
        setStatus(t('读取中…', 'Loading…'));
        if (replace) groupItems = [];
        var pages = 0;
        function fetchPage(cursor) {
          if (current !== gen || !isPeople() || pages >= 60) return Promise.resolve();
          pages += 1;
          return get('/api/people?after=' + cursor).then(function (data) {
            if (current !== gen || !isPeople()) return undefined;
            var items = (data && data.items) || [];
            groupItems = groupItems.concat(items);
            var next = data && data.next != null ? data.next : null;
            if (next != null && items.length) return fetchPage(next);
            return undefined;
          });
        }
        return fetchPage(Number(after) || 0)
          .then(function () {
            if (current !== gen || !isPeople()) return;
            renderPeopleList();
            highlightPerson(person ? person.id : null);
            syncLive();
            var count =
              lastStatus && lastStatus.people != null ? lastStatus.people : groupItems.length;
            if (!groupItems.length || (lastStatus && lastStatus.busy)) setStatus('');
            else setStatus(t(count + ' 人', count + ' people'));
            if (person) return loadPersonPhotos(person, 0, true);
            return undefined;
          })
          .catch(function (error) {
            if (current !== gen || !isPeople()) return;
            setStatus(explain(error));
            renderPeopleIdle();
          });
      });
    }

    function selectPerson(item) {
      if (!isPeople()) return Promise.resolve();
      person = item;
      photoItems = [];
      photoCursor = null;
      highlightPerson(item.id);
      if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
      return loadPersonPhotos(item, 0, true);
    }

    function loadPersonPhotos(item, after, replace) {
      return run(function () {
        var current = gen;
        var cursor = Number(after) || 0;
        setStatus(t('读取中…', 'Loading…'));
        return get(
          '/api/person-photos?personId=' + encodeURIComponent(item.id) + '&after=' + cursor,
        )
          .then(function (data) {
            if (current !== gen || !isPeople()) return;
            var items = (data && data.items) || [];
            photoCursor = data && data.next != null ? data.next : null;
            photoItems = replace ? items : photoItems.concat(items);
            if (!photoItems.length) {
              setStatus('');
              renderPeopleIdle(t('这一组已经没有照片了。', 'No current photos in this group.'));
              return;
            }
            setStatus(
              t(
                (item.name ? item.name + ' · ' : '') + photoItems.length + ' 张照片',
                (item.name ? item.name + ' · ' : '') + photoItems.length + ' photos',
              ),
            );
            renderCards(photoItems);
          })
          .catch(function (error) {
            if (current !== gen) return;
            setStatus('');
            renderPeopleIdle(explain(error));
          });
      });
    }

    function bind() {
      if (dom.photoGrid)
        dom.photoGrid.addEventListener('click', function (event) {
          var chip =
            event.target && event.target.closest ? event.target.closest('[data-ai-query]') : null;
          if (!chip) return;
          event.preventDefault();
          void startSearch(chip.getAttribute('data-ai-query'));
        });
      global.addEventListener('localechange', function () {
        if (!active()) return;
        // 换语言时重建侧栏（表单 / 历史 / 人物名的文案都要跟着变），并保住已输入的草稿。
        var draft = inputEl ? inputEl.value : '';
        var peopleDraft = peopleInputEl ? peopleInputEl.value : '';
        renderSidebar();
        if (inputEl && draft) inputEl.value = draft;
        if (peopleInputEl && peopleDraft) peopleInputEl.value = peopleDraft;
        applyToolbar();
        if (isSearch() && !String(state.aiSearchQuery || '').trim()) renderSearchIdle();
        else if (isPeople() && !person) renderPeopleIdle();
      });
    }

    return {
      bind: bind,
      enter: enter,
      leave: leave,
      load: load,
      isActive: active,
      isShowing: function () {
        return showing;
      },
      refreshStatus: fetchStatus,
    };
  }

  global.WebAiViews = { init: init };
})(window);
