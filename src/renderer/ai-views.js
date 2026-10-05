/**
 * 智能视图（搜图 / 人物）到主照片网格的适配层。
 *
 * 设计口径：这两个视图是侧栏独占的浏览维度——左侧栏分别放「搜索框 + 预选词 + 搜索历史」
 * 与「人物列表（含按名字过滤 + 双击改名）」，结果直接渲染进 #photoGrid，于是预览翻页、
 * 幻灯片、收藏、选择、卡片尺寸全部复用既有浏览链路（.photo-card[data-preview-index] →
 * startPreview → state.currentPhotos）。设置项与长说明留在左栏「设置」，这里只做使用与展示。
 */
(function (global) {
  'use strict';

  // 引导页示例：**仅在还没有真实预选词时**用。它的作用是「告诉用户可以用一句话描述画面」，
  // 所以宁可写死几句典型描述，也不能是一片空白。
  //
  // 侧栏「预选词」完全不使用这一份 —— 它必须来自 `search-vocabulary` 词表按本库真实命中数
  // 排出来的结果（见 refreshSuggestions）。历史教训：侧栏原来也摆这 18 个通用词，然后用
  // 「这些词在库里有没有内容」筛一遍，筛不出一个就**回退整份静态词库**，于是库里一个都没有的
  // 「夕阳下的海滩」之类照样摆出来给用户点（本机库实测 18 个词里 13 个是 0 张）。
  var SEARCH_EXAMPLES = [
    ['夕阳下的海滩', 'a beach at sunset'],
    ['雪山和湖泊', 'a lake below snowy mountains'],
    ['人物肖像', 'a portrait of a person'],
    ['城市夜景', 'city skyline at night'],
    ['美食特写', 'close-up of food'],
  ];
  var SUGGEST_COUNT = 5; // 侧栏「预选词」每次抽几个
  // 主进程一次返回多少词做池子：界面从池子里洗牌抽 5 个，「换一批」= 再洗一次，
  // 因此不必为「换一批」重新跑一遍模型。太小则两批重复率太高，太大则白花 IPC 与渲染。
  var SUGGEST_POOL_LIMIT = 24;

  // 搜索历史：本机 localStorage，最多留最近 8 条。
  var HISTORY_KEY = 'photoManager.aiSearchHistory';
  var HISTORY_MAX = 8;

  function init(deps) {
    deps = deps || {};
    var dom = deps.dom || {};
    var state = deps.state || {};
    var api = deps.api;
    // 卡片、骨架屏、尺寸档位、转义与格式化工具都从浏览层注入，
    // 这一层不再自己实现一套卡片——否则「复用照片网格」就名不副实了。
    var ui = deps.ui || {};
    var onRerenderChrome = deps.onRerenderChrome || function () {};

    function isEn() {
      return String(document.documentElement.lang || '').startsWith('en');
    }
    function t(zh, en) {
      return isEn() ? en : zh;
    }
    function el(tag, className, text) {
      var item = document.createElement(tag);
      if (className) item.className = className;
      if (text != null) item.textContent = text;
      return item;
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

    var gen = 0; // 请求代次：换视图 / 换查询时让在途响应作废
    var showing = false; // 视图壳是否还挂着（与 state.currentView 解耦）
    var timer = null;
    var busy = false;
    /**
     * 外部带进来的待搜词（见下面导出的 `search()`）。
     *
     * 为什么需要暂存：`enter()` 会刻意清空 `state.aiSearchQuery`（换视图不该延续上一个词），
     * 所以「带词进来」不能在 `enter()` 之前设值 —— 只能先存这里，由 `enter()` 末尾消费。
     */
    var pendingQuery = '';
    var queued = null;
    var lastState = null;
    var indexing = false;
    var person = null; // 非空表示右侧正在展示「某个人」的照片
    var groupItems = []; // 人物列表（侧栏）数据源
    var photoItems = [];
    // 搜图结果：`searchHits` 是本次达标的全部，`searchShown` 是已经渲染进网格的张数。
    // 阈值制下结果可能上万（阈值调 0 时「一张照片」这种泛化查询能命中全库的一大半），
    // 一次全塞进 DOM 会拖垮这一屏，所以先渲染一页、其余交给「更多」。
    var searchHits = [];
    var searchShown = 0;
    var SEARCH_PAGE = 200;
    var photoCursor = null;
    var rowById = {}; // personId -> 侧栏列表项 DOM，用于切换选中态
    var peopleQuery = ''; // 侧栏人物搜索词（只筛列表，不影响主区照片）
    var renaming = null; // 正在改名的那一行，同时只允许一行进入编辑态
    var historyItems = readHistory();
    // 侧栏「预选词」这一批：进入搜索页时抽一次，之后「换一批」或换视图才重抽。
    // 存下来而不是每次渲染都抽，否则同一批词会因为任何一次重绘而跳变。
    var suggestBatch = null;
    // 按本库真实命中数排出来的词池（**只有这一份来源**，空数组 = 这个库挑不出词）。
    // `suggestLang` 记住是哪一种语言的池：切语言要重取，否则中文界面会摆出英文词。
    var suggestPool = [];
    var suggestLang = '';
    var suggestState = 'idle';

    function isSearch() {
      return state.currentView === 'ai_search';
    }
    function isPeople() {
      return state.currentView === 'people';
    }
    function active() {
      return isSearch() || isPeople();
    }

    /** 串行执行：同类请求不允许并发，来不及的排到队尾（人物索引期间状态轮询会连带触发加载）。 */
    function run(task) {
      if (busy) {
        queued = task;
        return Promise.resolve();
      }
      busy = true;
      return Promise.resolve()
        .then(task)
        .catch(function () {})
        .then(function () {
          busy = false;
          var next = queued;
          queued = null;
          if (next && active()) return run(next);
          return undefined;
        });
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
        /* 隐私模式 / 配额满：历史只是锦上添花，静默降级 */
      }
    }

    /** 成功提交后把查询去重提到最前。 */
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
      renderSearchHistory();
    }

    function clearHistory() {
      historyItems = [];
      writeHistory(historyItems);
      renderSearchHistory();
    }

    function renderSearchHistory() {
      var host = dom.aiSearchHistoryList;
      if (!host) return;
      host.replaceChildren();
      if (dom.aiSearchHistoryClear) dom.aiSearchHistoryClear.hidden = !historyItems.length;
      if (!historyItems.length) {
        host.appendChild(
          el('div', 'ai-search-history-empty', t('还没有搜索记录', 'No search history yet')),
        );
        return;
      }
      historyItems.forEach(function (query) {
        var item = el('button', 'ai-search-history-item');
        item.type = 'button';
        item.setAttribute('data-ai-history', query);
        item.appendChild(el('span', 'ai-search-history-icon', '🕘'));
        item.appendChild(el('span', 'ai-search-history-text', query));
        item.addEventListener('click', function () {
          if (dom.aiSearchInput) dom.aiSearchInput.value = query;
          void startSearch(query);
        });
        host.appendChild(item);
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
     * 取「这个库里点下去真有图的词」。一个会话一次（换语言重取一次）。
     *
     * 词表**不在这一层**：主进程拿 `src/ai/search-vocabulary.js` 那份几百词的开放词表，
     * 按检索同一套口径（基线差 + 当前阈值）在本库上跑一遍，按真实命中数排序后返回前
     * `SUGGEST_POOL_LIMIT` 个。所以这里收到的每一个词都是**算出来的**，不是写死的。
     *
     * 拿不到结果（没有索引、模型没就绪、任务忙、一个词都不达标）时**不回退到任何静态词库**：
     * 旧实现正是在这里回退，于是库里一个都没有的「夕阳下的海滩」照样被摆出来给用户点。
     * 宁可把这一块整个收起来 —— 引导页已经在讲「可以用一句话描述画面」，
     * 而摆出已知没结果的词是纯粹的误导。
     */
    function refreshSuggestions() {
      if (!api.has || !api.has('aiSearchSuggest')) return;
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
      renderSearchSuggest();
      api
        .call('aiSearchSuggest', { lang: lang, limit: SUGGEST_POOL_LIMIT })
        .then(function (data) {
          suggestState = 'done';
          var terms = (data && data.terms) || [];
          if (isEn() !== (lang === 'en')) return; // 期间切了语言：等下一次重取
          suggestPool = terms
            .map(function (term) {
              return term && term.text ? String(term.text) : '';
            })
            .filter(Boolean);
          if (!isSearch() || state.aiSearchQuery) return;
          suggestBatch = pickSuggestions(SUGGEST_COUNT);
          renderSearchSuggest();
          // 引导页可能正挂着「示例词」，现在有真的了就换掉。
          if (!state.aiSearchQuery) searchIdleState();
        })
        .catch(function () {
          // 任务忙 / 超时都当作「取不到」，且本次会话不再重试（避免每次进页面都卡一次加载）。
          suggestState = 'done';
          suggestPool = [];
          // ⚠️ 必须重画：上面已经画过骨架了，不重画的话整块会**永远停在「挑选中…」**——
          // 加载态假死比原本的空白更糟（空白至少是诚实的）。这里走到 `done` + 空池 = 整块收起。
          renderSearchSuggest();
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
     * 骨架**不复用 `.ai-search-chip`**：那份样式带 `:hover` 位移 / 边框变色，骨架是非交互
     * 占位（用 `<span>`，不进 Tab 顺序、不响应点击），套上去得一路加权重去压。独立类更干净。
     */
    function renderSearchSuggestSkeleton(host) {
      host.hidden = false;
      host.setAttribute('aria-busy', 'true');
      host.replaceChildren();
      var head = el('div', 'ai-search-suggest-head');
      head.appendChild(el('span', 'ai-search-suggest-title', t('预选词', 'Suggestions')));
      head.appendChild(el('span', 'ai-search-suggest-hint', t('挑选中…', 'Picking…')));
      host.appendChild(head);
      var chips = el('div', 'ai-search-suggest-chips');
      chips.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < SUGGEST_COUNT; i += 1)
        chips.appendChild(el('span', 'ai-suggest-skeleton'));
      host.appendChild(chips);
    }

    /**
     * 搜索框下方的「预选词」：随机抽几个词摆着，点一下直接开搜。
     * 纯起点提示——不进搜索历史、不发任何额外请求。
     *
     * 三种形态：词池就绪 → 真词；正在取 → 骨架；取不到（无索引 / 模型没就绪 / 一个词都不
     * 达标 / 本次会话已失败过）→ **整块隐藏**（连标题和「换一批」一起收起来），
     * 不摆空壳也不摆假词。
     */
    function renderSearchSuggest() {
      var host = dom.aiSearchSuggest;
      if (!host) return;
      if (!suggestPool.length) {
        if (suggestState === 'pending') {
          renderSearchSuggestSkeleton(host);
          return;
        }
        host.replaceChildren();
        host.hidden = true;
        host.removeAttribute('aria-busy');
        return;
      }
      host.hidden = false;
      host.removeAttribute('aria-busy');
      if (!suggestBatch || !suggestBatch.length) suggestBatch = pickSuggestions(SUGGEST_COUNT);
      host.replaceChildren();
      var head = el('div', 'ai-search-suggest-head');
      head.appendChild(el('span', 'ai-search-suggest-title', t('预选词', 'Suggestions')));
      var shuffle = el('button', 'ai-search-suggest-refresh', t('换一批', 'Shuffle'));
      shuffle.type = 'button';
      shuffle.addEventListener('click', function () {
        suggestBatch = pickSuggestions(SUGGEST_COUNT);
        renderSearchSuggest();
      });
      head.appendChild(shuffle);
      host.appendChild(head);
      var chips = el('div', 'ai-search-suggest-chips');
      // 词池里已经是**当前语言的成品文本**（服务端按 lang 给的），这里不再做中英选择 ——
      // 旧写法的 `pair[0]/pair[1]` 是给「[中文, 英文] 词对」用的，换成字符串数组后
      // 那样写会把每个词截成第一个字。
      suggestBatch.forEach(function (label) {
        var chip = el('button', 'ai-search-chip', label);
        chip.type = 'button';
        chip.setAttribute('data-ai-suggest', label);
        chip.addEventListener('click', function () {
          if (dom.aiSearchInput) dom.aiSearchInput.value = label;
          void startSearch(label);
        });
        chips.appendChild(chip);
      });
      host.appendChild(chips);
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
      var host = dom.peopleList;
      if (!host) return;
      host.replaceChildren();
      rowById = {};
      if (!groupItems.length) {
        var stale = Number(lastState && lastState.staleScans) || 0;
        host.appendChild(
          el(
            'div',
            'ai-people-empty',
            indexing
              ? t('正在识别人脸…', 'Detecting faces…')
              : stale > 0
                ? // 「还没有识别到人物」与「索引是上一代识别器建的」在数据上都是 0 条，
                  // 但前者让人以为从没建过、甚至去怀疑自己的照片，后者才指向「重建」。
                  t(
                    '索引是上一代识别器建立的，需要重建后才能显示人物。见左栏「设置 → 识别设置与索引」。',
                    'The index was built by an older recognizer; rebuild it before people can be shown. See Settings → Face recognition and indexing.',
                  )
                : t('还没有识别到人物', 'No people detected yet'),
          ),
        );
        return;
      }
      var list = visiblePeople();
      if (!list.length) {
        host.appendChild(el('div', 'ai-people-empty', t('没有匹配的人物', 'No matching people')));
        return;
      }
      list.forEach(function (item) {
        var row = buildPersonRow(item);
        rowById[String(item.id)] = row;
        host.appendChild(row);
      });
    }

    function buildPersonRow(item) {
      // 用 div + role=button 而不是 button：名字位置要能就地换成输入框，
      // 而 button 的内容模型不允许嵌 input。键盘可达性用 tabindex + Enter/Space 补回。
      var row = el('div', 'ai-people-item');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.setAttribute('data-person-id', String(item.id));
      var avatar = el('span', 'ai-people-avatar');
      if (item.thumbnail) {
        var img = document.createElement('img');
        img.src = item.thumbnail;
        img.alt = personLabel(item);
        img.loading = 'lazy';
        avatar.appendChild(img);
      } else {
        avatar.appendChild(el('span', 'ai-people-avatar-fallback', '👤'));
      }
      row.appendChild(avatar);
      var meta = el('span', 'ai-people-meta');
      var nameEl = el('strong', 'ai-people-name', personLabel(item));
      nameEl.title = t('双击可改名', 'Double-click to rename');
      meta.appendChild(nameEl);
      meta.appendChild(el('span', 'ai-people-count', item.photoCount + t(' 张', ' photos')));
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
      var input = el('input', 'ai-people-rename-input');
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
        // 乐观更新：名字立刻生效，写失败再回滚——避免本地写期间名字先消失再出现。
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
      global.requestAnimationFrame(function () {
        input.focus();
        input.select();
      });
    }

    /** 落库改名：成功后同步选中人的标签与过滤结果；失败回滚到 previous 并提示。 */
    function commitRename(item, row, nameEl, next, previous) {
      function refilter() {
        if (!String(peopleQuery || '').trim()) return;
        renderPeopleList();
        highlightPerson(person ? person.id : null);
      }
      return api
        .call('faceAction', 'rename', { personId: item.id, name: next })
        .then(function () {
          if (person && String(person.id) === String(item.id)) {
            state.aiPeopleLabel = personLabel(item);
            onRerenderChrome();
          }
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

    /** 只切选中态，不重建列表，避免头像重新加载闪一下。 */
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
     * 建三格（幂等，只建一次 DOM）。每格 = 大号数字 + 小号标签，见 ai-views.css 的
     * `.ai-people-live`。用独立的格而不是把整句拼成一个字符串：句子折行会把「检出」
     * 拆成「检 / 出」两半、还会在行首留下孤零零的「·」分隔符，而格与格之间靠布局分隔
     * 就永远不会出现这两种情况。
     *
     * 标签文字**每轮都重写**（不跟着格一起缓存）：切换界面语言时 setLocale 只认
     * `data-i18n` 属性，不会重跑这里，缓存住标签就会一直停在旧语言那两个词上。
     */
    function syncLiveStats(fresh) {
      if (!liveStats && dom.aiPeopleLiveStats) {
        var refs = {};
        LIVE_STAT_SPECS.forEach(function (spec) {
          var cell = el('div', 'ai-people-live-stat');
          var value = el('span', 'ai-people-live-value');
          var label = el('span', 'ai-people-live-label');
          cell.appendChild(value);
          cell.appendChild(label);
          dom.aiPeopleLiveStats.appendChild(cell);
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
    function syncPeopleLive() {
      if (!dom.aiPeopleLive) return;
      var show = isPeople() && indexing;
      dom.aiPeopleLive.hidden = !show;
      if (!show) return;
      var current = lastState || {};
      var people = current.people != null ? current.people : groupItems.length;
      var scanned = current.scanned != null ? current.scanned : current.indexed;
      var faces = current.faces != null ? current.faces : null;
      if (dom.aiPeopleLiveText)
        dom.aiPeopleLiveText.textContent = t('正在识别人脸', 'Detecting faces');
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

    // ---------- 状态 ----------

    function statusEl() {
      return isPeople() ? dom.aiPeopleStatus || dom.aiViewStatus : dom.aiViewStatus;
    }

    function setStatus(text) {
      var node = statusEl();
      if (!node) return;
      node.textContent = text || '';
      node.hidden = !text;
    }

    function applyToolbar() {
      // 两个智能视图都拿不到「媒体筛选 / 排序」的语义（结果集由模型或人物决定），
      // 工具栏在这两页整体让位（与「重复」页同构），卡片尺寸档位仍然可用。
      if (dom.mediaFilterSelect) dom.mediaFilterSelect.style.display = 'none';
      if (dom.sortSelect) dom.sortSelect.style.display = 'none';
      if (dom.randomPageBtn) dom.randomPageBtn.style.display = 'none';
      // 每页数量跟着随机跳页一起收：结果集固定只有一页（`previewTotalPages = 1`），
      // 档位改了不会让结果变多也不会变少，留着只会让人以为点了没反应。
      if (dom.pageSizeControl) dom.pageSizeControl.style.display = 'none';
      // 「网格与比例」同样收掉，但原因不同：`uniform ↔ masonry` 是渲染时写进卡片 DOM 的
      // （grid 上的 `data-use-media-ratio` / `grid--masonry`），这两页没有「按当前结果重画」的入口，
      // 留着就会出现「选了没反应」。卡片尺寸档位只改 CSS 变量，所以它留。
      // 收的是外层 field（连标签一起），见 ui-navigation.js 的 setBrowseGridControlsVisible。
      if (dom.browseGridStyleControl) dom.browseGridStyleControl.style.display = 'none';
      if (dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = false;
    }

    function focusSearch() {
      if (!dom.aiSearchInput) return;
      global.requestAnimationFrame(function () {
        dom.aiSearchInput.focus();
        dom.aiSearchInput.select();
      });
    }

    // ---------- 网格 ----------

    function syncPreviewWindow() {
      var count = photos().length;
      // totalPages=1 时 navigatePreview 会在首尾直接判定边界，不会再去按页码拉浏览列表，
      // 于是预览的上一张 / 下一张就只在结果集里走。
      state.previewTotalPhotos = count;
      state.previewTotalPages = 1;
      state.previewPageStart = 1;
      state.previewLoadingPage = 0;
      state.page = 1;
    }

    function photos() {
      return person ? photoItems : [];
    }

    function emptyState(icon, title, desc) {
      if (!dom.photoGrid) return;
      var wrap = el('div', 'empty-state ai-empty');
      wrap.appendChild(el('div', 'icon', icon));
      wrap.appendChild(el('div', 'title', title));
      if (desc) wrap.appendChild(el('p', 'desc', desc));
      dom.photoGrid.replaceChildren(wrap);
      photoItems = [];
      state.currentPhotos = [];
      if (ui.applyCardSize) ui.applyCardSize();
    }

    function searchIdleState(message) {
      if (!dom.photoGrid) return;
      var wrap = el('div', 'empty-state ai-empty ai-search-hero');
      wrap.appendChild(el('div', 'icon', '🔍'));
      wrap.appendChild(
        el('div', 'title', t('描述你想找的画面', 'Describe what you are looking for')),
      );
      wrap.appendChild(
        el(
          'p',
          'desc',
          message ||
            t(
              '支持中文、英文等语言，例如「雪山下的湖泊」。照片与文字都在本机处理。',
              'Describe in Chinese, English or other languages, e.g. “a lake below snowy mountains”. Photos and queries stay on this machine.',
            ),
        ),
      );
      var chips = el('div', 'ai-search-chips');
      // 有真实词池就用真实的（和侧栏同一批，前 5 个），没有才退回那几句典型描述。
      // 这样「示例」也不会出现「点下去 0 张」的情况。
      var samples = suggestPool.length
        ? suggestPool.map(function (label) {
            return [label, label];
          })
        : SEARCH_EXAMPLES.map(function (pair) {
            return [isEn() ? pair[1] : pair[0]];
          });
      samples.slice(0, SUGGEST_COUNT).forEach(function (pair) {
        var chip = el('button', 'ai-search-chip', pair[0]);
        chip.type = 'button';
        chip.addEventListener('click', function () {
          if (dom.aiSearchInput) dom.aiSearchInput.value = pair[0];
          void startSearch(pair[0]);
        });
        chips.appendChild(chip);
      });
      wrap.appendChild(chips);
      dom.photoGrid.replaceChildren(wrap);
      state.currentPhotos = [];
      if (ui.applyCardSize) ui.applyCardSize();
    }

    /** 人物页首屏：未选人时主区只放一句引导，不拉任何人的照片。 */
    function peopleIdleState(message) {
      if (!dom.photoGrid) return;
      var wrap = el('div', 'empty-state ai-empty');
      wrap.appendChild(el('div', 'icon', '👥'));
      wrap.appendChild(el('div', 'title', t('从左侧选择一个人', 'Pick a person on the left')));
      wrap.appendChild(
        el(
          'p',
          'desc',
          message || t('点击左侧人物即可查看 TA 的照片。', 'Click a person to view their photos.'),
        ),
      );
      dom.photoGrid.replaceChildren(wrap);
      photoItems = [];
      state.currentPhotos = [];
      if (ui.applyCardSize) ui.applyCardSize();
    }

    function moreRow(action) {
      var row = el('div', 'ai-more-row');
      var button = el('button', 'ai-more-button', t('更多', 'More'));
      button.type = 'button';
      button.addEventListener('click', function () {
        button.disabled = true;
        void action();
      });
      row.appendChild(button);
      return row;
    }

    /** 结果照片走既有卡片渲染，预览翻页 / 收藏 / 选择因此自动生效。 */
    function renderPhotoCards(list, more) {
      photoItems = list;
      state.currentPhotos = list;
      syncPreviewWindow();
      ui.renderPhotoGrid({
        dom: dom,
        photos: list,
        useMediaRatio: state.cardLayoutMode === 'masonry',
        mediaFilter: 'all',
        escapeHtml: ui.escapeHtml,
        escapeAttr: ui.escapeAttr,
        truncate: ui.truncate,
        formatDateTime: ui.formatDateTime,
        formatNumber: ui.formatNumber,
        normalizePath: ui.normalizePath,
        subfolderSummaries: [],
        onApplyCardSize: ui.applyCardSize,
      });
      if (more && dom.photoGrid) dom.photoGrid.appendChild(moreRow(more));
    }

    /**
     * 渲染搜图结果的下一页。
     *
     * 只切「渲染多少张」，不重新请求 —— 达标结果已经在内存里。`state.currentPhotos` 始终是**全部**
     * 结果（不是已渲染的那一页），因此预览的上一张 / 下一张与幻灯片能走过完整结果集，
     * 而卡片的 data-preview-index 用的正是它在全部结果里的下标（渲染的始终是前缀）。
     */
    function renderSearchPage(reset) {
      if (reset) searchShown = 0;
      searchShown = Math.min(searchHits.length, searchShown + SEARCH_PAGE);
      renderPhotoCards(
        searchHits.slice(0, searchShown),
        searchShown < searchHits.length ? moreSearchHits : null,
      );
      photoItems = searchHits;
      state.currentPhotos = searchHits;
    }

    function moreSearchHits() {
      renderSearchPage(false);
    }

    // ---------- 数据 ----------

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
      };
      var hit = Object.keys(map).find(function (code) {
        return message.indexOf(code) >= 0;
      });
      return hit ? map[hit] : t('操作失败：', 'Operation failed: ') + message.slice(0, 200);
    }

    function callStatus() {
      return isSearch() ? api.call('aiSearchStatus') : api.call('faceAction', 'status');
    }

    /** 旧识别器的名字，拼成一行给提示用；认不出来就是版本原文（见 `labelForVersion`）。 */
    function staleNames(current) {
      return (current.staleVersions || [])
        .map(function (item) {
          return item.label || item.version;
        })
        .join(' / ');
    }

    /**
     * 只翻成一句人话的状态，不罗列模型 / 索引 / 进度数字。
     *
     * 「索引是上一代识别器建的」这一支必须排在「还没有建立索引」**之前**：两者的
     * `indexed` 都是 0，而这一条正是本轮修的那个坑 —— 界面原先只会说「还没有建立索引」，
     * 于是库里那 16155 条 v1（SFace）记录、3501 张脸看起来像凭空蒸发，用户能得出的
     * 唯一结论是「数据丢了」。判据是 `staleScans`（物理在库、但读路径一律不采纳的旧记录）。
     */
    function noticeFor(current) {
      if (!current.ready)
        return t(
          '本地模型尚未就绪，请到左栏「设置」完成下载。',
          'Models are not ready. Finish the download in Settings.',
        );
      var stale = Number(current.staleScans) || 0;
      if (stale > 0 && !current.indexed && !current.busy)
        return t(
          '索引是上一代识别器（' +
            staleNames(current) +
            '）建立的，与当前识别器不兼容，所以这里没有可显示的人物。请到左栏「设置 → 识别设置与索引」点「建立 / 更新人脸索引」重建。',
          'The index was built by an older recognizer (' +
            staleNames(current) +
            ') and is incompatible with the current one, so there is nothing to show here. Rebuild it in Settings → Face recognition and indexing.',
        );
      if (!current.indexed && !current.busy)
        return t(
          '还没有建立索引，请到左栏「设置」建立。',
          'Nothing is indexed yet. Build the index in Settings.',
        );
      return '';
    }

    function refreshStatus() {
      if (!active() || busy) return Promise.resolve();
      var current = gen;
      return callStatus()
        .then(function (data) {
          if (current !== gen || !active()) return;
          var previous = lastState;
          lastState = data || {};
          indexing = !!lastState.busy;
          syncPeopleLive();
          // 状态条上更重要的信息（结果数 / 人数）由各加载流程写入，
          // 这里只在确实需要提醒时覆盖，避免 3 秒一次的轮询把结果数擦掉。
          var notice = noticeFor(lastState);
          if (notice) setStatus(notice);
          // 索引跑的过程里人物会不断冒出来：人数一变就增量拉一次，别让用户干等。
          var grew = previous && lastState.busy && previous.people !== lastState.people;
          var finished = previous && !lastState.busy && previous.busy;
          if (isPeople() && (grew || finished)) void loadPeopleList();
        })
        .catch(function (error) {
          if (current === gen && active()) setStatus(explain(error));
        });
    }

    function startPolling() {
      stopPolling();
      if (!active()) return;
      timer = global.setInterval(function () {
        void refreshStatus();
      }, 3000);
    }
    function stopPolling() {
      if (timer) global.clearInterval(timer);
      timer = null;
    }

    // ---------- 搜图 ----------

    function startSearch(value) {
      if (busy || !isSearch()) return Promise.resolve();
      var query = String(value || '').trim();
      if (!query) {
        focusSearch();
        return Promise.resolve();
      }
      return run(function () {
        return doSearch(query);
      });
    }

    function doSearch(query) {
      var current = gen;
      state.aiSearchQuery = query;
      if (dom.aiSearchInput) dom.aiSearchInput.value = query;
      if (dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = true;
      setStatus(t('正在本机搜索…', 'Searching locally…'));
      onRerenderChrome();
      if (ui.showSkeleton)
        ui.showSkeleton({
          dom: dom,
          loadingLabel: t('正在本机搜索…', 'Searching locally…'),
          escapeHtml: ui.escapeHtml,
          onApplyCardSize: ui.applyCardSize,
        });
      return api
        .call('aiSearchQuery', query)
        .then(function (data) {
          if (current !== gen || !isSearch()) return;
          rememberSearch(query);
          var hits = (data && data.photos) || [];
          // matched 是**达标总数**，可能大于返回条数（内部为内存起见只保留最相近的一批）。
          var matched = data && data.matched != null ? Number(data.matched) : hits.length;
          // 索引进行中也能搜，用的是已经落库的那部分向量：把覆盖范围如实说出来，
          // 免得用户以为「搜不到」就是「没有这张照片」。
          var indexed = data && data.indexed != null ? Number(data.indexed) : null;
          var partial = indexing && indexed ? compactCount(indexed) : null;
          // 搜索结果只带 date_modified，借用它让卡片信息行不至于空着。
          hits.forEach(function (hit) {
            if (!hit.date_taken) hit.date_taken = hit.date_modified || '';
          });
          if (!hits.length) {
            setStatus(t('没有达到匹配阈值的照片', 'No photos above the match threshold'));
            emptyState(
              '🗒️',
              t('没有达到匹配阈值的照片', 'No photos above the match threshold'),
              partial
                ? t(
                    '索引还在建立中（已索引 ' + partial + ' 张），尚未索引的照片这次搜不到。',
                    'The index is still building (' +
                      partial +
                      ' indexed). Photos not yet indexed cannot be found.',
                  )
                : t(
                    '可以调低「设置 → 后台任务 → 搜图索引 → 匹配设置」里的阈值，或换个说法再试试。',
                    'Lower the threshold under Settings → Background tasks → Search index → Match settings, or try different wording.',
                  ),
            );
            return;
          }
          // 说清这个数字是什么：它**不是**「找到了 N 张相关照片」，而是「有 N 张达到阈值」，
          // 阈值由用户在设置里定。旧文案「找到 60 张照片」正是被读成前者才引起误会。
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
          searchHits = hits;
          renderSearchPage(true);
          if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
        })
        .catch(function (error) {
          if (current !== gen) return;
          setStatus('');
          emptyState('⚠️', explain(error), t('可以稍后重试。', 'Try again shortly.'));
        })
        .then(function () {
          if (current === gen && dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = false;
        });
    }

    // ---------- 人物 ----------

    function load() {
      if (!active()) return Promise.resolve();
      return isSearch() ? loadSearch() : loadPeople();
    }

    function loadSearch() {
      var query = String(state.aiSearchQuery || '').trim();
      renderSearchHistory();
      // 复用进入时抽好的那一批：重绘（状态轮询 / 语言切换）不该让词跳变。
      renderSearchSuggest();
      if (query) return startSearch(query);
      setStatus('');
      searchIdleState();
      return refreshStatus().then(function () {
        if (!isSearch()) return;
        if (String(state.aiSearchQuery || '').trim()) return;
        var current = lastState || {};
        var message = noticeFor(current);
        // 索引在跑、但已经有可用向量：明确告诉用户「现在就能搜，只是覆盖不全」。
        if (!message && current.busy && current.indexed)
          message = t(
            '索引仍在建立中（已索引 ' +
              compactCount(current.indexed) +
              ' 张）：现在就能搜，结果只覆盖已索引的照片。',
            'The index is still building (' +
              compactCount(current.indexed) +
              ' indexed): you can search now, results cover indexed photos only.',
          );
        searchIdleState(message || undefined);
      });
    }

    function loadPeople() {
      // 先取一次状态再拉列表：首屏就能拿到「索引中 · N 人」的实时提示，
      // 而不是等 3 秒后第一轮状态轮询回来才知道后台在跑。
      return refreshStatus().then(function () {
        if (!isPeople()) return undefined;
        return loadPeopleList();
      });
    }

    /** 侧栏要列出「所有人物」，逐页把游标翻到底（带安全上限，避免异常游标死循环）。 */
    function loadPeopleList() {
      if (!isPeople()) return Promise.resolve();
      var current = gen;
      setStatus(t('读取中…', 'Loading…'));
      groupItems = [];
      var pages = 0;
      function fetchPage(after) {
        if (current !== gen || !isPeople() || pages >= 60) return Promise.resolve();
        pages += 1;
        return api.call('faceAction', 'groups', { after: after }).then(function (data) {
          if (current !== gen || !isPeople()) return undefined;
          var items = (data && data.items) || [];
          groupItems = groupItems.concat(items);
          var next = data && data.next != null ? data.next : null;
          if (next != null && items.length) return fetchPage(next);
          return undefined;
        });
      }
      return fetchPage(0)
        .then(function () {
          if (current !== gen || !isPeople()) return;
          renderPeopleList();
          highlightPerson(person ? person.id : null);
          syncPeopleLive();
          var count = lastState && lastState.people != null ? lastState.people : groupItems.length;
          // 空列表时不要无条件清空状态：`noticeFor` 可能刚写好一句「索引是上一代识别器
          // 建立的，需要重建」，清掉就等于把唯一的解释抹了 —— 而那正是这个视图为空的成因。
          if (!groupItems.length) setStatus(noticeFor(lastState || {}));
          else if (indexing) setStatus('');
          else setStatus(t(count + ' 人', count + ' people'));
          if (person) return loadPersonPhotos(person, 0, true);
          return undefined;
        })
        .catch(function (error) {
          if (current !== gen || !isPeople()) return;
          setStatus(explain(error));
          peopleIdleState();
        });
    }

    function selectPerson(item) {
      if (!isPeople()) return Promise.resolve();
      person = item;
      photoItems = [];
      photoCursor = null;
      state.aiPeopleLabel = item.name || t('未命名人物', 'Unnamed person');
      highlightPerson(item.id);
      if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
      onRerenderChrome();
      return loadPersonPhotos(item, 0, true);
    }

    function loadPersonPhotos(item, after, replace) {
      return run(function () {
        return doLoadPersonPhotos(item, after, replace);
      });
    }

    function doLoadPersonPhotos(item, after, replace) {
      var current = gen;
      var cursor = Number(after) || 0;
      setStatus(t('读取中…', 'Loading…'));
      return api
        .call('faceAction', 'photos', { personId: item.id, after: cursor })
        .then(function (data) {
          if (current !== gen || !isPeople()) return;
          var items = (data && data.items) || [];
          photoCursor = data && data.next != null ? data.next : null;
          photoItems = replace ? items : photoItems.concat(items);
          if (!photoItems.length) {
            setStatus('');
            emptyState('👥', t('这一组已经没有照片了。', 'No current photos in this group.'));
            return;
          }
          setStatus(t(photoItems.length + ' 张照片', photoItems.length + ' photos'));
          renderPhotoCards(photoItems, photoCursor ? morePersonPhotos : null);
        })
        .catch(function (error) {
          if (current !== gen) return;
          setStatus('');
          emptyState('⚠️', explain(error), t('可以稍后重试。', 'Try again shortly.'));
        });
    }

    function morePersonPhotos() {
      return loadPersonPhotos(person, photoCursor, false);
    }

    // ---------- 生命周期 ----------

    function enter(view) {
      gen++;
      showing = true;
      stopPolling();
      lastState = null;
      indexing = false;
      person = null;
      groupItems = [];
      photoItems = [];
      photoCursor = null;
      searchHits = [];
      searchShown = 0;
      rowById = {};
      state.currentPhotos = [];
      syncPreviewWindow();
      if (dom.pagination) dom.pagination.style.display = 'none';
      if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
      applyToolbar();
      if (dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = false;
      if (view === 'ai_search') {
        // 换视图时清掉上一次的查询，避免看见旧词却显示新结果。
        state.aiSearchQuery = '';
        state.aiPeopleLabel = '';
        renderSearchHistory();
        // 每次进入搜索页重抽一批预选词（「随机」要能被感知，就必须换视图就换词）。
        // 词池还没取回来时这里会走骨架态（见 renderSearchSuggest），等 refreshSuggestions
        // 回来再换真词。
        suggestBatch = pickSuggestions(SUGGEST_COUNT);
        renderSearchSuggest();
        // 取「本库点下去真有图的词」（一个会话一次、换语言重取一次）；拿回来会重绘本页。
        refreshSuggestions();
        setStatus('');
        searchIdleState();
        focusSearch();
        // 带词进来的（照片信息面板的 AI 标签点了）在这里补搜 —— 必须等上面那几行初始化
        // 跑完，否则会被 `searchIdleState()` 盖成引导页。
        if (pendingQuery) {
          var queued = pendingQuery;
          pendingQuery = '';
          void startSearch(queued);
        }
      } else {
        state.aiPeopleLabel = '';
        peopleQuery = '';
        renaming = null;
        if (dom.peopleSearchInput) dom.peopleSearchInput.value = '';
        renderPeopleList();
        highlightPerson(null);
        syncPeopleLive();
        setStatus('');
        peopleIdleState();
      }
      onRerenderChrome();
    }

    function leave() {
      gen++;
      showing = false;
      stopPolling();
      lastState = null;
      indexing = false;
      person = null;
      rowById = {};
      peopleQuery = '';
      renaming = null;
      searchHits = [];
      searchShown = 0;
      if (dom.peopleSearchInput) dom.peopleSearchInput.value = '';
      if (dom.mediaFilterSelect) dom.mediaFilterSelect.style.display = '';
      if (dom.sortSelect) dom.sortSelect.style.display = '';
      if (dom.randomPageBtn) dom.randomPageBtn.style.display = '';
      if (dom.pageSizeControl) dom.pageSizeControl.style.display = '';
      if (dom.browseGridStyleControl) dom.browseGridStyleControl.style.display = '';
      if (dom.aiViewStatus) dom.aiViewStatus.hidden = true;
      if (dom.aiPeopleStatus) dom.aiPeopleStatus.hidden = true;
      if (dom.aiPeopleLive) dom.aiPeopleLive.hidden = true;
    }

    function bind() {
      if (dom.aiSearchForm)
        dom.aiSearchForm.addEventListener('submit', function (event) {
          event.preventDefault();
          void startSearch(dom.aiSearchInput ? dom.aiSearchInput.value : '');
        });
      if (dom.aiSearchHistoryClear)
        dom.aiSearchHistoryClear.addEventListener('click', function () {
          clearHistory();
        });
      // 人物搜索：输入即过滤（不发请求）；Esc 或点原生 ✕ 清空后恢复完整列表。
      if (dom.peopleSearchInput) {
        var applyPeopleQuery = function () {
          peopleQuery = String(dom.peopleSearchInput.value || '');
          if (!isPeople()) return;
          renderPeopleList();
          highlightPerson(person ? person.id : null);
        };
        dom.peopleSearchInput.addEventListener('input', applyPeopleQuery);
        dom.peopleSearchInput.addEventListener('search', applyPeopleQuery);
        dom.peopleSearchInput.addEventListener('keydown', function (event) {
          if (event.key !== 'Escape' || !dom.peopleSearchInput.value) return;
          dom.peopleSearchInput.value = '';
          applyPeopleQuery();
        });
      }
      // i18n 切换语言时先按 data-i18n 重写静态节点再派发 localechange，
      // 所以这里收到事件后要重画一次，否则侧栏会退回成旧语言。
      global.addEventListener('localechange', function () {
        if (!active()) return;
        applyToolbar();
        renderSearchHistory();
        renderSearchSuggest();
        renderPeopleList();
        highlightPerson(person ? person.id : null);
        syncPeopleLive();
        onRerenderChrome();
        if (isSearch() && !String(state.aiSearchQuery || '').trim()) searchIdleState();
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
      startPolling: startPolling,
      stopPolling: stopPolling,
      refreshStatus: refreshStatus,
      /**
       * 带词搜图（照片信息面板的 AI 标签 → 搜图页）。
       *
       * 两种入口都只调这一次就正确：
       *   - 已在搜图页 → 直接搜；
       *   - 不在搜图页 → 词暂存给下一次 `enter()` 消费（调用方随后 `showTabContent('search')`）。
       * 反过来（先切页再调）会失败：`enter()` 在切页时已经把 `state.aiSearchQuery` 清空了，
       * 但那时 `search()` 还没被调用，没有东西可消费 —— 结果是停在引导页。
       */
      search: function (query) {
        var q = String(query || '').trim();
        if (!q) return Promise.resolve();
        if (!isSearch()) {
          pendingQuery = q;
          return Promise.resolve();
        }
        return startSearch(q);
      },
    };
  }

  global.RendererAiViews = { init: init };
})(window);
