/**
 * 网页端「搜图 / 人物」视图：侧栏独占——搜索框 + 搜索历史 / 人物列表都在侧栏里，
 * 结果落进主图片网格（#photoGrid），因此卡片渲染、点击进预览、上一张/下一张全部复用
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

  // 关键词档一次取多少（与桌面端同一组数字）：目录是整库分组的产出，取多了白扫索引；
  // 文件走既有 FTS 分页，一页 60 张是「一屏多一点」，不够再点「更多」。
  var KEYWORD_FOLDER_LIMIT = 12;
  var KEYWORD_FILE_PAGE = 60;
  // 没有封面图时的占位（与 app.js 的 folderCoverDefaultPlaceholderHtmlWeb 同形）。
  var FOLDER_PLACEHOLDER =
    '<div class="folder-cover-placeholder folder-cover-placeholder--default" aria-hidden="true">' +
    '<svg class="folder-cover-placeholder-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
    '<path class="folder-cover-placeholder-shape" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1.9-2-2-2h-8l-2-2z"/>' +
    '<path class="folder-cover-placeholder-inner" d="M4 8h16v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z"/>' +
    '</svg></div>';

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
    // 关键词档渲染目录卡片后要按当前卡片尺寸档位重排一次（与目录浏览同一套契约）。
    var applyCardSize = deps.applyCardSize || function () {};
    var escapeHtml =
      deps.escapeHtml ||
      function (s) {
        return s == null ? '' : String(s);
      };
    // 缩略图缓存键：由 `app.js` 注入（本文件先于它加载，见 `web/index.html` 的脚本顺序）。
    // 兜底返回空串 = 「没有键」，等价于改动前的行为 —— 也就是「重建后封面仍是旧的」，
    // 不会让图挂掉。**但注入本身不能少**：`photo-thumb-url-regression` 第 4 组断言
    // `app.js` 确实把 `thumbCacheVersion` 传了进来，所以这里不是为了兜住长期缺失。
    var thumbCacheVersion =
      deps.thumbCacheVersion ||
      function () {
        return '';
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
    var peopleQuery = ''; // 侧栏人物搜索词（只筛列表，不动主区图片）
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
    /**
     * 搜图页当前档位：`'keyword'`（文件名 / 目录名子串）或 `'semantic'`（AI 向量）。
     * 与桌面端同一口径：两套引擎必须显式二选一，不能让后端猜用户输的是哪种。
     */
    var searchMode = 'keyword';
    // 关键词档的结果：目录与文件各一份，各自记「已取到多少 / 总共多少」。
    var kwFolders = [];
    var kwFolderTotal = 0;
    var kwFiles = [];
    var kwFilePage = 0;
    var kwFileTotal = 0;

    /**
     * 上一次搜索的**保留态**：离开搜图页不再丢结果，回来时原样画回。
     * 与桌面端同口径（见 `src/renderer/ai-views.js#retainedSearch`）：
     * 只有**跑完过且有命中**的搜索才写这里。空结果会**作废**它（见下面的理由）——
     * 库被改过之后同一个词会从「有」变「没有」，留着快照就会画出一屏已经不存在的结果。
     */
    var retainedSearch = null;
    /**
     * 「离开过又回来」的一次性标记：`leave()` 置位、`restoreRetainedSearch()` 消费。
     * 不能只凭「有保留态」就还原 —— `loadSearch()` 也会被后台重载（扫描完成等）触发，
     * 那次要的是**重搜**（结果跟着库走），不是把离开前那一屏画回来。
     */
    var pendingRestore = false;
    /** 状态行文案：`setStatus` 只写 DOM、且拿不到节点时静默不写，保留态得另存一份才还原得了。 */
    var statusText = '';

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
    /** 当前是不是「关键词」档（语义档需要模型与索引，关键词档不需要，别互相串）。 */
    function isKeyword() {
      return isSearch() && searchMode === 'keyword';
    }

    // ---------- 搜图档位：关键词 / 语义 ----------

    /** 输入框的两句提示语**不进 i18n 静态表**：同一个框两种语义，值随档位变。 */
    function searchPlaceholder() {
      return searchMode === 'keyword'
        ? t('搜索文件名或文件夹名', 'Search file or folder names')
        : t(
            '描述你想找的画面，例如：夕阳下的海滩',
            'Describe what you are looking for, e.g. a beach at sunset',
          );
    }

    function renderSearchMode() {
      if (!dom.sidebar) return;
      // 自己遍历 `children` 而不是 `querySelectorAll`：回归替身没实现后者。
      var buttons = collectByAttr(dom.sidebar, 'data-ai-search-mode');
      for (var i = 0; i < buttons.length; i += 1) {
        var on = buttons[i].getAttribute('data-ai-search-mode') === searchMode;
        buttons[i].classList.toggle('is-active', on);
        buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (inputEl) {
        inputEl.placeholder = searchPlaceholder();
        inputEl.setAttribute(
          'aria-label',
          searchMode === 'keyword'
            ? t('文件名或文件夹名', 'File or folder name')
            : t('画面描述', 'Scene description'),
        );
      }
      // 预选词是**语义档**的引导（词来自画面词表），关键词档摆着是误导。
      if (suggestEl) suggestEl.hidden = searchMode !== 'semantic';
    }

    /** 换档：带着当前的词**立刻按新档位重搜**（同一个词在两档里含义不同）。 */
    function setMode(mode) {
      var next = mode === 'semantic' ? 'semantic' : 'keyword';
      if (!isSearch() || next === searchMode) return Promise.resolve();
      searchMode = next;
      gen += 1; // 让在途的旧档位响应作废
      // 上一个档位的结果对新档位没有意义：作废保留态，让下面要么按新档位重搜、要么落到空闲态。
      retainedSearch = null;
      pendingRestore = false;
      renderSearchMode();
      var query = String(state.aiSearchQuery || '').trim();
      // ⚠️ `startSearch` 在 `busy` 时会**静默早退**（同类请求不并发）。那时若直接返回，
      //    界面就停在「档位按钮已经是新的、结果还是旧的」—— 比不切档更糟。
      if (query && !busy) return startSearch(query);
      setStatus('');
      if (searchMode === 'keyword') {
        renderKeywordIdle();
        return Promise.resolve();
      }
      renderSearchIdle();
      // 切**进**语义档要把预选词那块重新画 + 取回来（理由同桌面端）。
      renderSuggest();
      refreshSuggestions();
      return Promise.resolve();
    }

    // ---------- 搜图结果的保留态（离开再回来） ----------

    /**
     * 这次进页会不会把上一次的结果**画回来**（而不是重搜）。
     *
     * 判据 = 「刚离开过一次（`pendingRestore`）」+「保留态在」+「当前查询与档位都和它同源」。
     * **这个判据只允许一份**：`enter()`（决定要不要先画引导页）与 `loadSearch()`（决定还原
     * 还是重搜）都要问它，各写一份必然漂移成「enter 画了引导页、loadSearch 又还原了结果」那种闪烁。
     */
    function searchRestorable() {
      if (!pendingRestore || !retainedSearch) return false;
      if (retainedSearch.mode !== searchMode) return false;
      var query = String(state.aiSearchQuery || '').trim();
      return !!query && retainedSearch.query === query;
    }

    /** 搜索跑完且有命中时记下「回来该画什么」。空结果 / 出错都不写（见 `retainedSearch`）。 */
    function markSearchRetained(query) {
      retainedSearch = { mode: searchMode, query: query };
      refreshRetainedSearch();
    }

    /**
     * 把活变量刷进保留态；查询 / 档位对不上就把保留态作废。
     * 在 `leave()` 里调，于是「更多」翻过的页、以及最新那行状态文案都跟着一起带回去。
     */
    function refreshRetainedSearch() {
      if (!retainedSearch) return;
      var query = String(state.aiSearchQuery || '').trim();
      if (!query || retainedSearch.query !== query || retainedSearch.mode !== searchMode) {
        retainedSearch = null;
        return;
      }
      retainedSearch.status = statusText;
      retainedSearch.folders = kwFolders.slice();
      retainedSearch.folderTotal = kwFolderTotal;
      retainedSearch.files = kwFiles.slice();
      retainedSearch.filePage = kwFilePage;
      retainedSearch.fileTotal = kwFileTotal;
      retainedSearch.hits = searchHits.slice();
      retainedSearch.shown = searchShown;
    }

    /**
     * 把保留态画回界面。返回 false = 保留态对不上，调用方应当去重搜。
     * 与桌面端同口径：**不重跑搜索**（重跑会闪骨架、还会把「更多」翻过的页缩回第一页）。
     */
    function restoreRetainedSearch() {
      if (!searchRestorable() || !retainedSearch) return false;
      // 一次性：还原过就别再还原。之后来的重载该走重搜，结果要跟着库走。
      pendingRestore = false;
      var kept = retainedSearch;
      if (inputEl) inputEl.value = kept.query;
      if (kept.mode === 'keyword') {
        kwFolders = kept.folders.slice();
        kwFolderTotal = kept.folderTotal;
        kwFiles = kept.files.slice();
        kwFilePage = kept.filePage;
        kwFileTotal = kept.fileTotal;
        setStatus('');
        renderKeywordResults();
        setStatus(kept.status);
        return true;
      }
      searchHits = kept.hits.slice();
      // `renderSearchPage` 只会「+SEARCH_PAGE」，要还原到上次渲染的张数就得先把基数退回去。
      searchShown = Math.max(0, kept.shown - SEARCH_PAGE);
      setStatus('');
      renderSearchPage(false);
      setStatus(kept.status);
      return true;
    }

    function renderKeywordIdle(message) {
      var grid = dom.photoGrid;
      if (!grid) return;
      grid.innerHTML = emptyHtml(
        SEARCH_ICON,
        t('按文件名或文件夹名搜索', 'Search by file or folder name'),
        message ||
          // 口径必须写出来：两组是两个不同的判据（目录名 vs 文件名），不写的话
          // 用户会以为「文件」组里也该出现那个命中目录下的所有图片。
          t(
            '输入关键词后回车：「文件夹」组按目录名匹配，「文件」组只留文件名里包含关键词的；要按画面内容找请切到「语义」。',
            'Type a keyword and press Enter — “Folders” matches folder names, “Files” keeps only files whose own name contains it. Switch to “Semantic” to search by what is in the picture.',
          ),
      );
      state.currentPhotos = [];
      syncPreviewWindow(0);
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
     * 搜索只筛侧栏这个列表，不碰主区图片。
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
            lastStatus && lastStatus.running
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
      var show = isPeople() && !!(lastStatus && lastStatus.running);
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
      // 档位切换：关键词（文件名 / 目录名）与语义（AI 向量）是两套引擎，显式二选一。
      var modes = h('div', 'ai-web-search-modes');
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', t('搜索方式', 'Search mode'));
      modes.addEventListener('click', function (event) {
        // 真实浏览器里点到的是按钮内部的文字节点，要 `closest` 回到按钮本身；
        // 回归替身没有 `closest`，那就当 `target` 已经是按钮（同一份判据两种环境都走）。
        var btn = event.target;
        if (btn && btn.closest) {
          var hit = btn.closest('[data-ai-search-mode]');
          if (hit) btn = hit;
        }
        if (!btn || !btn.getAttribute) return;
        var mode = btn.getAttribute('data-ai-search-mode');
        if (!mode) return;
        void setMode(mode);
      });
      [
        ['keyword', t('关键词', 'Keyword')],
        ['semantic', t('语义', 'Semantic')],
      ].forEach(function (pair) {
        var btn = h('button', 'ai-web-search-mode', pair[1]);
        btn.type = 'button';
        btn.setAttribute('data-ai-search-mode', pair[0]);
        btn.setAttribute('aria-pressed', 'false');
        modes.appendChild(btn);
      });
      host.appendChild(modes);

      var form = h('form', 'ai-web-sidebar-search');
      var input = h('input');
      input.type = 'search';
      input.maxLength = 500;
      input.autocomplete = 'off';
      input.placeholder = searchPlaceholder();
      input.setAttribute(
        'aria-label',
        searchMode === 'keyword'
          ? t('文件名或文件夹名', 'File or folder name')
          : t('画面描述', 'Scene description'),
      );
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
      // 档位按钮的高亮 / 提示语 / 预选词显隐都在这里收口：必须等 inputEl 与 suggestEl
      // 都建好再画，否则第一次进页面会是「按钮没高亮 + 提示语是语义档那句」。
      renderSearchMode();
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
      statusText = text || '';
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
      if (!status.indexed && !status.running)
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
            '支持中文、英文等语言，例如「雪山下的湖泊」。图片与文字都在本机处理。',
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
        message || t('点击左侧人物即可查看 TA 的图片。', 'Click a person to view their photos.'),
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
      kwFolders = [];
      kwFolderTotal = 0;
      kwFiles = [];
      kwFilePage = 0;
      kwFileTotal = 0;
      rowById = {};
      peopleQuery = '';
      renaming = null;
      state.currentPhotos = [];
      if (view === 'ai_search') {
        // ⚠️ 这里**不再**无条件清 `state.aiSearchQuery`：清了就再也回不到上一次的结果
        //    （见 `retainedSearch`）。真正的清空有两处，各有明确理由：
        //      ① 下面 `!restoring` 的那一支 —— 干净的进入不该留着一个活的查询；
        //      ② `startSearch()` 的空提交 —— 用户主动清空的唯一入口。
        // 每次进入搜索视图重抽一批预选词（「随机」要能被感知，就得换视图换词）。
        // 词池还没取回来时侧栏会走骨架态（见 renderSuggest），等结果回来再换真词。
        suggestBatch = pickSuggestions(SUGGEST_COUNT);
        // 取「本库点下去真有图的词」（一个会话一次、换语言重取一次）；拿回来会重绘本页。
        // 关键词档不取：那些词是画面描述，摆在这里会被当成文件名去搜。
        if (searchMode === 'semantic') refreshSuggestions();
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
        // 有保留态时先别画引导页：`loadSearch()` 紧接着就会把上一次的结果画回来
        // （判据与还原同源，见 `searchRestorable`），提前画只会闪一个空状态。
        var restoring = searchRestorable();
        // 不是「离开过一次又回来」的那一次 ⇒ 这是一次**干净的进入**：把上一次的词一起清掉。
        // 只画引导页、却把查询留在 `state` 里是最坏的组合：界面看着像没有搜索在生效，
        // 而紧接着 `loadPhotos()` 触发的那次 `loadSearch()` 又会拿这个词去重搜一遍 ——
        // 同一页在「引导页 / 结果」之间来回翻；语义档更糟，它会跳过「模型尚未就绪」的说明
        // （那段只在**空查询**分支里给，见 loadSearch）。与桌面端同口径。
        if (!restoring) state.aiSearchQuery = '';
        if (searchMode === 'keyword') {
          if (!restoring) renderKeywordIdle();
        } else if (!restoring) {
          renderSearchIdle();
        }
      } else {
        setStatus('');
        renderPeopleIdle();
      }
      startPolling();
    }

    function leave() {
      // 先把当前结果刷进保留态（含「更多」翻过的页与状态行文案），再照旧把活变量清干净 ——
      // 回来时由 `loadSearch()` 按保留态重新画。
      refreshRetainedSearch();
      pendingRestore = !!retainedSearch;
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
      kwFolders = [];
      kwFolderTotal = 0;
      kwFiles = [];
      kwFilePage = 0;
      kwFileTotal = 0;
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
      renderSearchMode();
      renderHistory();
      if (query) {
        // 有保留态就**原样画回**（离开搜图页的两条路：点结果里的目录跳走、换视图），
        // 不重跑一遍搜索 —— 重跑会闪骨架，还会把「更多」翻过的页缩回第一页。
        if (restoreRetainedSearch()) return Promise.resolve();
        return startSearch(query);
      }
      setStatus('');
      // 关键词档不查 AI 索引状态（跟它无关），也不必等那趟请求。
      if (searchMode === 'keyword') {
        renderKeywordIdle();
        return Promise.resolve();
      }
      renderSearchIdle();
      return fetchStatus().then(function () {
        if (!isSearch()) return;
        if (String(state.aiSearchQuery || '').trim()) return;
        var message = noticeFor(lastStatus);
        // 索引在跑、但已经有可用向量：明确告诉用户「现在就能搜，只是覆盖不全」。
        if (!message && lastStatus && lastStatus.running && lastStatus.indexed)
          message = t(
            '索引仍在建立中（已索引 ' +
              compactCount(lastStatus.indexed) +
              ' 张）：现在就能搜，结果只覆盖已索引的图片。',
            'The index is still building (' +
              compactCount(lastStatus.indexed) +
              ' indexed): you can search now, results cover indexed photos only.',
          );
        renderSearchIdle(message || undefined);
      });
    }

    function fetchStatus() {
      // 关键词档不载模型、不查索引，轮询别白跑请求。
      if (!active() || busy || isKeyword()) return Promise.resolve();
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
    // 结果计数（「找到 N 张图片 / N 人」）不受影响——fetchStatus 只在有提醒时覆盖状态位。
    function startPolling() {
      stopPolling();
      pollTimer = setInterval(function () {
        if (!active() || busy) return;
        var before = lastStatus ? { people: lastStatus.people, running: lastStatus.running } : null;
        void fetchStatus().then(function () {
          if (!isPeople() || !active()) return;
          var people = lastStatus && lastStatus.people != null ? Number(lastStatus.people) : null;
          var grew = (!before || before.people !== people) && people > 0;
          var finished = !!(before && before.running && lastStatus && !lastStatus.running);
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

    /**
     * 状态行末尾那一句：这一趟 **tag 检索层**为什么没参与（参与了就返回空串）。
     *
     * 🔴 为什么非要有它：tag 路会**静默不参与**（词表里有但没有对应标签、索引没建、
     *    用户在桌面端关了开关、查询当场失败），而这四种情况和「这个查询确实没结果」
     *    在界面上长得一模一样 —— 用户唯一能得到的结论是「搜图不准」。
     *
     * ⚠️ `FREE_TEXT`（自由词）**刻意不提示**：随手打一句话只走语义路是**正常形态**，
     *    每句都加提示等于噪声，噪声会把真正该看的那几种情况一起淹掉。
     *
     * ⚠️ 这是**镜面实现**，与桌面端 `src/web/js/semantic-search.js#tagNote` 同构
     *    （那一份桌面端加载，这一份网页端加载，两个文件各自独立）。改一处必须改两处，
     *    `scripts/tag-fusion-regression.js` 会逐案比对两边的 `reason` 映射。
     *    网页端**不做**每张卡片的来源标注：它的网格是 `renderPhotoGrid`（浏览页也用同一个），
     *    往里塞 AI 专属徽标要么泄漏到正常浏览、要么得给网格开一条分叉 —— 都不值。
     */
    function tagNote(tag) {
      if (!tag || typeof tag !== 'object') return '';
      var reason = String(tag.reason || '');
      if (reason === 'UNSUPPORTED') {
        var missing = Array.isArray(tag.missing) ? tag.missing.filter(Boolean) : [];
        var detail = missing.length ? '（' + missing.join('、') + '）' : '';
        return t(
          '这个词的标签不在本地模型里' + detail + '，本次只用语义匹配。',
          'This term’s tags are not in the local model' + detail + '. Semantic matching only.',
        );
      }
      if (reason === 'DISABLED')
        return t(
          '标签检索已关闭，本次只用语义匹配。',
          'Tag matching is off; semantic matching only.',
        );
      if (reason === 'NO_INDEX')
        return t(
          '标签索引尚未建立，本次只用语义匹配。',
          'The tag index is not built yet; semantic matching only.',
        );
      if (reason === 'QUERY_FAILED')
        return t(
          '标签索引本次读取失败，已退回语义匹配。',
          'Reading the tag index failed this time; fell back to semantic matching.',
        );
      return '';
    }

    function startSearch(value) {
      if (!isSearch()) return Promise.resolve();
      var query = String(value || '').trim();
      if (!query) {
        // 空提交 = **清掉这一次搜索**（连保留态一起），回到引导页。
        // 这一步是必需的：有了保留态之后，引导页只认「查询为空」，没有它引导页就再也回不来。
        retainedSearch = null;
        pendingRestore = false;
        state.aiSearchQuery = '';
        if (inputEl) inputEl.value = '';
        kwFolders = [];
        kwFolderTotal = 0;
        kwFiles = [];
        kwFilePage = 0;
        kwFileTotal = 0;
        searchHits = [];
        searchShown = 0;
        photoItems = [];
        state.currentPhotos = [];
        syncPreviewWindow(0);
        setStatus('');
        if (searchMode === 'keyword') renderKeywordIdle();
        else renderSearchIdle();
        return Promise.resolve();
      }
      // ⚠️ `busy` 判据必须放在空提交**之后**：清空是纯本地动作，不该因为后台在跑就点不动。
      if (busy) return Promise.resolve();
      if (searchMode === 'keyword') {
        return run(function () {
          return doKeywordSearch(query);
        });
      }
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
            // 免得用户以为「搜不到」就是「没有这张图片」。
            var indexed = data && data.indexed != null ? Number(data.indexed) : null;
            var partial = lastStatus && lastStatus.running && indexed ? compactCount(indexed) : null;
            // tag 层这一趟有没有参与、为什么没有。**必须在空结果分支之前算出来**：
            // 「0 张」+「标签索引没建」与「0 张」+「确实没有」是两件完全不同的事，
            // 前者要用户去建索引，后者要用户换个说法 —— 而这两句话只能长在状态行上。
            var tagLine = tagNote(data && data.tag);
            hits.forEach(function (hit) {
              if (!hit.date_taken) hit.date_taken = hit.date_modified || '';
            });
            if (!hits.length) {
              // 空结果必须作废保留态（理由与坑见 doKeywordSearch 那一处）。
              retainedSearch = null;
              setStatus(
                t('没有达到匹配阈值的图片', 'No photos above the match threshold') +
                  (tagLine ? ' · ' + tagLine : ''),
              );
              renderEmpty(
                t('没有达到匹配阈值的图片', 'No photos above the match threshold'),
                partial
                  ? t(
                      '索引还在建立中（已索引 ' + partial + ' 张），尚未索引的图片这次搜不到。',
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
            // 与桌面端同一口径：这个数字是「有多少张达到阈值」，不是「找到了多少张相关图片」。
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
                  ) + (tagLine ? ' · ' + tagLine : ''),
            );
            photoCursor = null;
            searchHits = hits;
            renderSearchPage(true);
            markSearchRetained(query);
            if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
          })
          .catch(function (error) {
            if (current !== gen) return;
            setStatus('');
            renderEmpty(explain(error), t('可以稍后重试。', 'Try again shortly.'));
          });
      });
    }

    // ---------- 关键词档：结果 = 文件夹 + 文件 ----------

    /** 目录卡片：与目录浏览同一套 DOM 契约（`.folder-card[data-folder-path]`），
     *  于是 #photoGrid 上那条「点卡片跳进目录」的委托监听自动生效。 */
    function folderCardHtml(row) {
      var folderPath = String(row.folder_path || '');
      var name = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
      var coverId = parseInt(row.id, 10);
      var hasCover = !isNaN(coverId) && coverId > 0 && row.has_thumbnail !== false;
      return (
        '<div class="photo-card folder-card" data-folder-path="' +
        escapeHtml(folderPath) +
        '">' +
        (hasCover
          ? '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
            '<img src="/thumb/' +
            coverId +
            '?v=' +
            thumbCacheVersion(row) +
            '" alt="' +
            escapeHtml(name) +
            '" loading="lazy" class="loading grid-thumb" />'
          : FOLDER_PLACEHOLDER) +
        '<div class="photo-info"><div class="photo-name">\u{1F4C1} ' +
        escapeHtml(name) +
        '</div><div class="photo-date">' +
        escapeHtml(String(row.folder_photo_count != null ? row.folder_photo_count : 0)) +
        '</div></div></div>'
      );
    }

    /**
     * 在子树里按 class 找节点。**自己遍历 `children`，不用 `querySelector`**：
     * 回归替身（`scripts/ai-web-views-regression.js`）只实现了 `children` / `classList`，
     * 用 querySelector 会在测试里当场抛错 —— 而真实浏览器两者都有。
     */
    function findByClass(node, cls) {
      if (!node) return null;
      if (node.classList && node.classList.contains(cls)) return node;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i += 1) {
        var hit = findByClass(kids[i], cls);
        if (hit) return hit;
      }
      return null;
    }

    function collectByAttr(node, attr, out) {
      out = out || [];
      if (!node) return out;
      if (node.getAttribute && node.getAttribute(attr) != null) out.push(node);
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i += 1) collectByAttr(kids[i], attr, out);
      return out;
    }

    /** `kind` 只用来让「更多」按钮在两组里可分辨（绑定时按这个 class 找回来）。 */
    function moreButtonHtml(kind) {
      return (
        '<div class="ai-web-more-row"><button type="button" class="ai-web-more-button ai-web-kw-more-' +
        kind +
        '">' +
        escapeHtml(t('更多', 'More')) +
        '</button></div>'
      );
    }

    /** 按「哪一组」把「更多」按钮绑到对应动作上（找不到就跳过：该组没有更多可加载）。 */
    function bindMoreButton(kind, action) {
      var btn = findByClass(dom.photoGrid, 'ai-web-kw-more-' + kind);
      if (!btn) return;
      btn.addEventListener('click', function () {
        btn.disabled = true;
        void action();
      });
    }

    function sectionShellHtml(title, count, bodyHtml) {
      return (
        '<section class="ai-web-kw-section">' +
        '<div class="ai-web-kw-head">' +
        '<span class="ai-web-kw-title">' +
        escapeHtml(title) +
        '</span>' +
        '<span class="ai-web-kw-count">' +
        escapeHtml(String(count)) +
        '</span>' +
        '</div>' +
        '<div class="ai-web-kw-body">' +
        bodyHtml +
        '</div></section>'
      );
    }

    /**
     * 一次画完两个分组。
     *
     * 🔴 文件卡片**必须**交给既有的 `renderPhotoGrid`：那份 HTML 里带着 Live Photo 角标、
     *    正方形占位、masonry 比例与 `onclick="startPreview(i)"` 的索引 —— 在这里另抄一份
     *    等于给「两边悄悄漂开」留门。代价是它只会整体写 `#photoGrid`（没有「渲染到某个
     *    容器」的入参），所以这里先让它画，把产出的 HTML 取出来再嵌进「文件」分组。
     *
     *    目录卡片则是自己拼：`renderFolderCoverGrid` 同样只会整体写 `#photoGrid`，
     *    而它的字段（封面 / 张数）与 `/api/search-folders` 的返回形状一致，拼起来没有
     *    会漂的东西（`.folder-card[data-folder-path]` 那套委托监听靠 class 命中）。
     */
    function renderKeywordResults() {
      var grid = dom.photoGrid;
      if (!grid) return;
      // ① 先让既有渲染器画文件卡片，取回 HTML。
      photoItems = kwFiles.slice();
      state.currentPhotos = photoItems;
      syncPreviewWindow(photoItems.length);
      var filesBody;
      if (kwFiles.length) {
        renderPhotoGrid(photoItems);
        filesBody = grid.innerHTML;
        if (kwFileTotal > kwFiles.length) filesBody += moreButtonHtml('files');
      } else {
        filesBody =
          '<div class="ai-web-kw-empty">' +
          escapeHtml(t('没有匹配的文件', 'No matching files')) +
          '</div>';
      }
      // ② 目录卡片自己拼。
      var foldersBody;
      if (kwFolders.length) {
        foldersBody = '<div class="grid">';
        for (var i = 0; i < kwFolders.length; i += 1) foldersBody += folderCardHtml(kwFolders[i]);
        foldersBody += '</div>';
        if (kwFolderTotal > kwFolders.length) foldersBody += moreButtonHtml('folders');
      } else {
        foldersBody =
          '<div class="ai-web-kw-empty">' +
          escapeHtml(t('没有匹配的文件夹', 'No matching folders')) +
          '</div>';
      }
      grid.innerHTML =
        sectionShellHtml(t('文件夹', 'Folders'), kwFolderTotal, foldersBody) +
        sectionShellHtml(t('文件', 'Files'), kwFileTotal, filesBody);
      applyCardSize();
      // ③ 「更多」按钮：两组各一个，按各自那个 class 找回来再挂（真实 DOM 与回归替身都能走）。
      bindMoreButton('folders', moreKeywordFolders);
      bindMoreButton('files', moreKeywordFiles);
    }

    function moreKeywordFolders() {
      var query = String(state.aiSearchQuery || '').trim();
      if (!query || !isKeyword()) return Promise.resolve();
      var limit = Math.min(60, kwFolders.length + KEYWORD_FOLDER_LIMIT);
      if (limit <= kwFolders.length) return Promise.resolve();
      return get(
        '/api/search-folders?q=' + encodeURIComponent(query) + '&limit=' + limit,
      )
        .then(function (data) {
          if (!isKeyword()) return;
          var rows = (data && data.folders) || [];
          if (!rows.length) return;
          kwFolders = rows;
          kwFolderTotal = Number(data.total) || kwFolderTotal;
          renderKeywordResults();
        })
        .catch(function () {});
    }

    function moreKeywordFiles() {
      var query = String(state.aiSearchQuery || '').trim();
      if (!query || !isKeyword()) return Promise.resolve();
      var next = kwFilePage + 1;
      return get(
        // `nameOnly=1`：文件名**包含**关键词（不是「文件名或所在目录」）——
        // 目录命中的归「文件夹」组，两组不重叠。
        '/api/search?nameOnly=1&page=' +
          next +
          '&pageSize=' +
          KEYWORD_FILE_PAGE +
          '&q=' +
          encodeURIComponent(query),
      )
        .then(function (data) {
          if (!isKeyword()) return;
          var rows = (data && data.photos) || [];
          if (!rows.length) return;
          kwFilePage = next;
          kwFiles = kwFiles.concat(rows);
          kwFileTotal = Number(data.total) || kwFileTotal;
          renderKeywordResults();
        })
        .catch(function () {});
    }

    /**
     * 关键词搜索：目录与文件**两条请求并行**。
     *
     * 刻意不合到一条接口：两者排序、分页、代价模型都不同（目录是整库分组，文件是 FTS 分页），
     * 合起来等于让用户等较慢的那一条才看得见任何东西。
     */
    function doKeywordSearch(query) {
      var current = gen;
      state.aiSearchQuery = query;
      if (inputEl) inputEl.value = query;
      setStatus(t('正在搜索…', 'Searching…'));
      kwFolders = [];
      kwFolderTotal = 0;
      kwFiles = [];
      kwFilePage = 0;
      kwFileTotal = 0;
      var folderReq = get(
        '/api/search-folders?q=' + encodeURIComponent(query) + '&limit=' + KEYWORD_FOLDER_LIMIT,
      ).catch(function () {
        return { folders: [], total: 0 };
      });
      var fileReq = get(
        // 🔴 `nameOnly=1` —— 「文件」组只留**文件名里包含**关键词的。
        //    不加它就会命中「所在目录名包含关键词」的图片（一个目录里几十上百张全被列出来），
        //    而那正是「文件夹」组负责表达的事，两组会大面积重叠。
        '/api/search?nameOnly=1&page=1&pageSize=' +
          KEYWORD_FILE_PAGE +
          '&q=' +
          encodeURIComponent(query),
      ).catch(function () {
        return { photos: [], total: 0 };
      });
      return Promise.all([folderReq, fileReq])
        .then(function (res) {
          if (current !== gen || !isSearch()) return;
          rememberSearch(query);
          var folderRes = res[0] || {};
          var fileRes = res[1] || {};
          kwFolders = folderRes.folders || [];
          kwFolderTotal = Number(folderRes.total) || kwFolders.length;
          kwFiles = fileRes.photos || [];
          kwFileTotal = Number(fileRes.total) || kwFiles.length;
          kwFilePage = 1;
          if (!kwFolders.length && !kwFiles.length) {
            // 空结果必须**作废**保留态。唯一承重的情形是「同一个词从有变没有」（库被重扫 /
            // 删除之后真的会发生）：查询不同源时 refreshRetainedSearch 自己会作废快照，
            // 同源时只剩这一行 —— 少了它，用户离开再回来看到的是**已经不存在的结果**。
            retainedSearch = null;
            setStatus(t('没有匹配的文件或文件夹', 'No matching files or folders'));
            renderEmpty(
              t('没有匹配的文件或文件夹', 'No matching files or folders'),
              t(
                '换个关键词试试；要按画面内容找，请切到「语义」档。',
                'Try another keyword, or switch to “Semantic” to search by what is in the picture.',
              ),
            );
            return;
          }
          setStatus(
            isEn()
              ? kwFolderTotal + ' folders · ' + kwFileTotal + ' files'
              : '文件夹 ' + kwFolderTotal + ' 个 · 文件 ' + kwFileTotal + ' 个',
          );
          renderKeywordResults();
          // 放在渲染之后：`markSearchRetained` 会把活变量与状态文案一起刷进保留态。
          markSearchRetained(query);
          if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
        })
        .catch(function (error) {
          if (current !== gen) return;
          setStatus('');
          renderEmpty(explain(error), t('可以稍后重试。', 'Try again shortly.'));
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
            if (!groupItems.length || (lastStatus && lastStatus.running)) setStatus('');
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
              renderPeopleIdle(t('这一组已经没有图片了。', 'No current photos in this group.'));
              return;
            }
            setStatus(
              t(
                (item.name ? item.name + ' · ' : '') + photoItems.length + ' 张图片',
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
