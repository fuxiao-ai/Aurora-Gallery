/**
 * 智能视图（搜图 / 人物）到主图片网格的适配层。
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

  // 关键词档一次取多少。两组的代价模型完全不同，所以分开定：
  //   · 目录：整库 LIKE + 分组（`database.js#searchFolders`），取多了白扫一遍索引；
  //   · 文件：既有 FTS 分页，一页 60 张是「一屏多一点」，不够再点「更多」。
  var KEYWORD_FOLDER_LIMIT = 12;
  var KEYWORD_FILE_PAGE = 60;

  // 搜索历史：本机 localStorage，最多留最近 8 条。
  var HISTORY_KEY = 'photoManager.aiSearchHistory';
  var HISTORY_MAX = 8;

  function init(deps) {
    deps = deps || {};
    var dom = deps.dom || {};
    var state = deps.state || {};
    var api = deps.api;
    // 卡片、骨架屏、尺寸档位、转义与格式化工具都从浏览层注入，
    // 这一层不再自己实现一套卡片——否则「复用图片网格」就名不副实了。
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
     * 为什么需要暂存：`enter()` 里没有「设词」这一手（2026-10-07 起它也不再清
     * `state.aiSearchQuery`，因为搜图页要保留上一次的结果），所以「带词进来」只能先存这里，
     * 由 `enter()` 末尾消费 —— 在那之前设值会被 `enter()` 末尾的初始化盖掉。
     */
    var pendingQuery = '';
    var queued = null;
    var lastState = null;
    var indexing = false;
    var person = null; // 非空表示右侧正在展示「某个人」的图片
    var groupItems = []; // 人物列表（侧栏）数据源
    var photoItems = [];
    // 搜图结果：`searchHits` 是本次达标的全部，`searchShown` 是已经渲染进网格的张数。
    // 阈值制下结果可能上万（阈值调 0 时「一张图片」这种泛化查询能命中全库的一大半），
    // 一次全塞进 DOM 会拖垮这一屏，所以先渲染一页、其余交给「更多」。
    var searchHits = [];
    var searchShown = 0;
    var SEARCH_PAGE = 200;
    /**
     * 搜图页当前档位：`'keyword'`（文件名 / 目录名子串）或 `'semantic'`（AI 向量）。
     *
     * 这是**两套引擎**，不是一个框的两种排序 —— 关键词走 FTS / LIKE，语义走向量索引
     * （还要模型与索引都就绪）。混着由后端猜会出现「输了个文件名却被当成画面描述」，
     * 所以必须显式二选一，并且把档位写在界面上。
     */
    var searchMode = 'keyword';
    // 关键词档的结果：目录与文件**各是一份**，各自记「已取到多少 / 总共多少」。
    var kwFolders = [];
    var kwFolderTotal = 0;
    var kwFiles = [];
    var kwFilePage = 0;
    var kwFileTotal = 0;
    var kwFolderBodyEl = null;
    var kwFileBodyEl = null;
    var kwFileCountEl = null;
    /**
     * 上一次搜索的**保留态**：离开搜图页不再丢结果，回来时原样画回。
     *
     * 起因（2026-10-07 用户报）：关键词结果的「文件夹」组点下去是**跳进那个目录**
     * （复用 `.folder-cover-card` 的委托，见 `renderKeywordFolders`），跳走再回搜图页结果就
     * 全没了 —— 而用户多半正要接着点第二个目录，等于每次都得重打一遍关键词。
     *
     * 只有**跑完过且有命中**的搜索才写这里（成功返回时写；出错、空结果都不写）：
     * 它本身就是「回来有东西可看」的判据 —— 写进 `leave()` 会把「上一次的报错页 / 空结果页」
     * 也当成结果保留下来。数据在 `leave()` 时从活变量刷新（「更多」翻过的页要一起带上）。
     */
    var retainedSearch = null;
    /**
     * 「用户**离开过又回来**」的一次性标记：由 `leave()` 置位、`restoreRetainedSearch()` 消费。
     *
     * 为什么不能只凭「有保留态」就还：`loadSearch()` 也会被**后台重载**触发（扫描完成 /
     * 设置变更 → `scheduleBrowseReload` → `loadPhotos` → 这套）。那种情况下要的是**重搜**
     * （结果得跟着库走），而不是把离开前那一屏画回来 —— 否则刚扫进来的图片永远不出现在
     * 搜索结果里，正是本项目最恨的静默陈旧。
     */
    var pendingRestore = false;
    /**
     * 状态行的当前文案。`setStatus` 只写 DOM，而且**拿不到节点时会静默不写**，
     * 所以文案要另存一份 —— 保留态得把那一行也原样还原回去。
     */
    var statusText = '';
    var photoCursor = null;
    var rowById = {}; // personId -> 侧栏列表项 DOM，用于切换选中态
    var peopleQuery = ''; // 侧栏人物搜索词（只筛列表，不影响主区图片）
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
    /** 当前是不是「关键词」档（语义档不需要索引，关键词档不需要模型，别互相串）。 */
    function isKeyword() {
      return isSearch() && searchMode === 'keyword';
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

    // ---------- 搜图档位：关键词 / 语义 ----------

    /**
     * 档位切换的两个按钮。**只认 `data-ai-search-mode`**，不认 id：
     * 加第三个档位时不用回到这里改判据。
     */
    function modeButtons() {
      return [
        { mode: 'keyword', el: dom.aiSearchModeKeyword },
        { mode: 'semantic', el: dom.aiSearchModeSemantic },
      ];
    }

    /**
     * 把档位画到界面上：按钮高亮 + `aria-pressed` + 输入框的提示语。
     *
     * ⚠️ 输入框的两句提示语**不挂 `data-i18n-placeholder`**：那个属性归 i18n 的静态改写
     * 所有，而这里的值随档位变（同一个框两种语义），挂上去会在切语言时被改回语义档那句。
     * 改由 `localechange` 里重调本函数来同步语言。
     */
    function renderSearchMode() {
      var buttons = modeButtons();
      for (var i = 0; i < buttons.length; i += 1) {
        var btn = buttons[i].el;
        if (!btn) continue;
        var on = searchMode === buttons[i].mode;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      var input = dom.aiSearchInput;
      if (input) {
        if (searchMode === 'keyword') {
          input.placeholder = t('搜索文件名或文件夹名', 'Search file or folder names');
          input.setAttribute('aria-label', t('文件名或文件夹名', 'File or folder name'));
        } else {
          input.placeholder = t(
            '描述你想找的画面，例如：夕阳下的海滩',
            'Describe the scene, e.g. a beach at sunset',
          );
          input.setAttribute('aria-label', t('画面描述', 'Scene description'));
        }
      }
      // 预选词是**语义档**的引导（词来自画面词表、按本库命中数排），关键词档摆着是误导。
      // ⚠️ 必须显式 `hidden` 之外还要 CSS 兜底：`.ai-search-suggest` 是 `display:flex`，
      //    会压过 UA 的 `[hidden]{display:none}`（那条样式已经写在 ai-views.css 里）。
      if (dom.aiSearchSuggest) dom.aiSearchSuggest.hidden = searchMode !== 'semantic';
    }

    /**
     * 换档。带着当前的词**立刻按新档位重搜**（同一个词在两档里含义不同，
     * 留着旧结果不重搜 = 显示的和搜的不是一回事）。
     */
    function setMode(mode) {
      var next = mode === 'semantic' ? 'semantic' : 'keyword';
      if (!isSearch() || next === searchMode) return Promise.resolve();
      searchMode = next;
      gen += 1; // 让在途的旧档位响应作废
      // 上一个档位的结果对新档位没有意义：作废保留态，让下面要么按新档位重搜、要么落到空闲态。
      retainedSearch = null;
      renderSearchMode();
      var query = String(state.aiSearchQuery || '').trim();
      // ⚠️ `startSearch` 在 `busy` 时会**静默早退**（同类请求不并发）。那时若直接返回，
      //    界面就停在「档位按钮已经是新的、结果还是旧的」—— 比不切档更糟。
      //    所以先看 busy：在途的那一趟会因为 `gen` 变了被作废，这里落到新档位的空闲态。
      if (query && !busy) return startSearch(query);
      setStatus('');
      // 空闲态两档也刻意不同：语义是「描述画面」，关键词是「搜名字」。
      if (searchMode === 'keyword') {
        keywordIdleState();
        return Promise.resolve();
      }
      searchIdleState();
      // 切**进**语义档要把预选词那块重新画 + 取回来：`enter()` 只在「进入时就是语义档」
      // 那条路上做这两件事，从关键词档切过来时没人做 ⇒ 预选词永远空着。
      // ⚠️ `renderSearchSuggest()` 不能省：词池可能早就取好了（`refreshSuggestions` 会
      // 直接早退），那时只有重画才能把已有的词摆出来。
      renderSearchSuggest();
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
     *
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
     *
     * 刻意**不重跑一次搜索**：重跑会闪一次骨架屏，而且「更多」翻过的页会缩回第一页 ——
     * 那都不是「保留之前的结果」。代价是结果集可能比库里的实况旧一点（期间删/加过图片），
     * 属于刻意取舍：结果只是入口，点进去看的是实况。
     */
    function restoreRetainedSearch() {
      if (!searchRestorable() || !retainedSearch) return false;
      // 一次性：还原过就别再还原。之后来的重载（后台扫描完成等）该走重搜，结果要跟着库走。
      pendingRestore = false;
      var kept = retainedSearch;
      if (dom.aiSearchInput) dom.aiSearchInput.value = kept.query;
      if (dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = false;
      if (kept.mode === 'keyword') {
        kwFolders = kept.folders.slice();
        kwFolderTotal = kept.folderTotal;
        kwFiles = kept.files.slice();
        kwFilePage = kept.filePage;
        kwFileTotal = kept.fileTotal;
        setStatus('');
        renderKeywordShell();
        renderKeywordFolders();
        renderKeywordFiles();
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

    /** 关键词档的空闲态：一句「能搜什么」，不摆示例词（示例词是画面描述，属于语义档）。 */
    function keywordIdleState(message) {
      emptyState(
        '\u{1F50D}',
        t('按文件名或文件夹名搜索', 'Search by file or folder name'),
        // 口径必须写出来：两组是**两个不同的判据**（目录名 vs 文件名），
        // 不写的话用户会以为「文件」组里也该出现那个命中目录下的所有图片。
        message ||
          t(
            '输入关键词后回车：「文件夹」组按目录名匹配，「文件」组只留文件名里包含关键词的；要按画面内容找请切到「语义」。',
            'Type a keyword and press Enter — “Folders” matches folder names, “Files” keeps only files whose own name contains it. Switch to “Semantic” to search by what is in the picture.',
          ),
      );
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
                  // 但前者让人以为从没建过、甚至去怀疑自己的图片，后者才指向「重建」。
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
      statusText = text || '';
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
              '支持中文、英文等语言，例如「雪山下的湖泊」。图片与文字都在本机处理。',
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

    /** 人物页首屏：未选人时主区只放一句引导，不拉任何人的图片。 */
    function peopleIdleState(message) {
      if (!dom.photoGrid) return;
      var wrap = el('div', 'empty-state ai-empty');
      wrap.appendChild(el('div', 'icon', '👥'));
      wrap.appendChild(el('div', 'title', t('从左侧选择一个人', 'Pick a person on the left')));
      wrap.appendChild(
        el(
          'p',
          'desc',
          message || t('点击左侧人物即可查看 TA 的图片。', 'Click a person to view their photos.'),
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

    /** 结果图片走既有卡片渲染，预览翻页 / 收藏 / 选择因此自动生效。 */
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
      if (stale > 0 && !current.indexed && !current.running)
        return t(
          '索引是上一代识别器（' +
            staleNames(current) +
            '）建立的，与当前识别器不兼容，所以这里没有可显示的人物。请到左栏「设置 → 识别设置与索引」点「建立 / 更新人脸索引」重建。',
          'The index was built by an older recognizer (' +
            staleNames(current) +
            ') and is incompatible with the current one, so there is nothing to show here. Rebuild it in Settings → Face recognition and indexing.',
        );
      if (!current.indexed && !current.running)
        return t(
          '还没有建立索引，请到左栏「设置」建立。',
          'Nothing is indexed yet. Build the index in Settings.',
        );
      return '';
    }

    function refreshStatus() {
      // 关键词档不需要 AI 索引状态（不载模型、不查索引），轮询就别白跑 IPC。
      if (!active() || busy || isKeyword()) return Promise.resolve();
      var current = gen;
      return callStatus()
        .then(function (data) {
          if (current !== gen || !active()) return;
          var previous = lastState;
          lastState = data || {};
          indexing = !!lastState.running;
          syncPeopleLive();
          // 状态条上更重要的信息（结果数 / 人数）由各加载流程写入，
          // 这里只在确实需要提醒时覆盖，避免 3 秒一次的轮询把结果数擦掉。
          var notice = noticeFor(lastState);
          if (notice) setStatus(notice);
          // 索引跑的过程里人物会不断冒出来：人数一变就增量拉一次，别让用户干等。
          var grew = previous && lastState.running && previous.people !== lastState.people;
          var finished = previous && !lastState.running && previous.running;
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
      if (!isSearch()) return Promise.resolve();
      var query = String(value || '').trim();
      if (!query) {
        // 空提交 = **清掉这一次搜索**（连保留态一起），回到引导页。
        // 这一步是必需的：有了保留态之后，引导页只认「查询为空」，没有它引导页就再也回不来。
        retainedSearch = null;
        pendingRestore = false;
        state.aiSearchQuery = '';
        if (dom.aiSearchInput) dom.aiSearchInput.value = '';
        kwFolders = [];
        kwFolderTotal = 0;
        kwFiles = [];
        kwFilePage = 0;
        kwFileTotal = 0;
        searchHits = [];
        searchShown = 0;
        photoItems = [];
        state.currentPhotos = [];
        syncPreviewWindow();
        setStatus('');
        if (searchMode === 'keyword') keywordIdleState();
        else searchIdleState();
        focusSearch();
        return Promise.resolve();
      }
      // ⚠️ `busy` 判据必须放在空提交**之后**：清空是个纯本地动作，不该因为后台在跑就点不动。
      if (busy) return Promise.resolve();
      return run(function () {
        return searchMode === 'keyword' ? doKeywordSearch(query) : doSearch(query);
      });
    }

    /**
     * 状态行末尾那一句：这一趟 **tag 检索层**为什么没参与（参与了就返回空串）。
     *
     * 🔴 为什么非要有它：tag 路会**静默不参与**（词表里有但没有对应标签、索引没建、
     *    用户关了开关、查询当场失败），而这四种情况和「这个查询确实没结果」在界面上
     *    长得一模一样 —— 用户唯一能得到的结论是「搜图不准」。
     *
     * ⚠️ `FREE_TEXT`（自由词）**刻意不提示**：随手打一句话只走语义路是**正常形态**，
     *    每句都加提示等于噪声，噪声会把真正该看的那几种情况一起淹掉。
     *
     * ⚠️ 这是**第三份镜面**（另两份：`src/web/js/semantic-search.js` 桌面端搜图整页、
     *    `src/web/js/ai-views.js` 网页端）。三份代码各自独立、谁也 require 不到谁，
     *    所以「同一个 reason 的文案」会重复三遍 —— 这是本仓既有的镜面模式，不是新问题。
     *    唯一的防线是 `scripts/tag-fusion-regression.js`：它把**三份文件的 reason 集合**
     *    逐一对齐，只改一处会当场 FAIL（否则漏掉的那一端会静默少一句话）。
     *    ⚠️ 卡片级的来源标注这里**不做**：网格是 `renderPhotoCards`（浏览页共用），
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
          // 免得用户以为「搜不到」就是「没有这张图片」。
          var indexed = data && data.indexed != null ? Number(data.indexed) : null;
          var partial = indexing && indexed ? compactCount(indexed) : null;
          // tag 层这一趟有没有参与、为什么没有。**必须在空结果分支之前算出来**：
          // 「0 张」+「标签索引没建」与「0 张」+「确实没有」是两件完全不同的事。
          var tagLine = tagNote(data && data.tag);
          // 搜索结果只带 date_modified，借用它让卡片信息行不至于空着。
          hits.forEach(function (hit) {
            if (!hit.date_taken) hit.date_taken = hit.date_modified || '';
          });
          if (!hits.length) {
            // 同关键词档：空结果必须作废保留态（理由与坑见 doKeywordSearch 那一处）。
            retainedSearch = null;
            setStatus(
              t('没有达到匹配阈值的图片', 'No photos above the match threshold') +
                (tagLine ? ' · ' + tagLine : ''),
            );
            emptyState(
              '🗒️',
              t('没有达到匹配阈值的图片', 'No photos above the match threshold'),
              partial
                ? t(
                    '索引还在建立中（已索引 ' + partial + ' 张），尚未索引的图片这次搜不到。',
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
          // 说清这个数字是什么：它**不是**「找到了 N 张相关图片」，而是「有 N 张达到阈值」，
          // 阈值由用户在设置里定。旧文案「找到 60 张图片」正是被读成前者才引起误会。
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
          searchHits = hits;
          renderSearchPage(true);
          markSearchRetained(query);
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

    // ---------- 关键词档：结果 = 文件夹 + 文件 ----------

    /**
     * 关键词页的骨架：两个分组各自一个「标题 + 数量」的头，body 由专门的渲染函数填。
     *
     * 为什么不用 `renderPhotoGrid` 的 `subfolderSummaries`（它本来就会在图片网格前面拼一段
     * 目录卡片）：那段是给「目录浏览」用的，标题写死「子目录 / 此文件夹中的图片与视频」，
     * 不参与 i18n，也带不出「命中多少个目录」这个数。这里是搜索结果，两组要各自的计数。
     */
    function renderKeywordShell() {
      if (!dom.photoGrid) return;
      var wrap = el('div', 'ai-kw-results');

      var folderSection = el('section', 'ai-kw-section');
      var folderHead = el('div', 'ai-kw-head');
      folderHead.appendChild(el('span', 'ai-kw-title', t('文件夹', 'Folders')));
      folderHead.appendChild(el('span', 'ai-kw-count', String(kwFolderTotal)));
      var folderBody = el('div', 'ai-kw-body');
      folderSection.appendChild(folderHead);
      folderSection.appendChild(folderBody);
      wrap.appendChild(folderSection);

      var fileSection = el('section', 'ai-kw-section');
      var fileHead = el('div', 'ai-kw-head');
      fileHead.appendChild(el('span', 'ai-kw-title', t('文件', 'Files')));
      var fileCount = el('span', 'ai-kw-count', String(kwFileTotal));
      fileHead.appendChild(fileCount);
      var fileBody = el('div', 'ai-kw-body');
      fileSection.appendChild(fileHead);
      fileSection.appendChild(fileBody);
      wrap.appendChild(fileSection);

      dom.photoGrid.replaceChildren(wrap);
      kwFolderBodyEl = folderBody;
      kwFileBodyEl = fileBody;
      kwFileCountEl = fileCount;
    }

    function renderKeywordFolders() {
      var host = kwFolderBodyEl;
      if (!host) return;
      host.replaceChildren();
      if (!kwFolders.length) {
        host.appendChild(
          el('div', 'ai-kw-empty', t('没有匹配的文件夹', 'No matching folders')),
        );
        return;
      }
      if (typeof ui.renderFolderCoverGrid === 'function') {
        // 复用目录浏览那套封面卡片：`.folder-cover-card[data-folder-path]`，
        // 于是「点卡片跳进这个目录」的委托监听（ui-events.js 挂在 #photoGrid 上）自动生效。
        ui.renderFolderCoverGrid({
          dom: { photoGrid: host },
          covers: kwFolders,
          normalizePath: ui.normalizePath,
          escapeHtml: ui.escapeHtml,
          escapeAttr: ui.escapeAttr,
          formatNumber: ui.formatNumber,
          onApplyCardSize: ui.applyCardSize,
        });
      } else {
        // 渲染器缺了也不能白屏：退化成纯文本清单（不可点，但至少看得见命中什么）。
        kwFolders.forEach(function (row) {
          var line = el('div', 'ai-kw-empty');
          line.textContent = String(row.folder_path || '') + ' · ' + row.folder_photo_count;
          host.appendChild(line);
        });
      }
      if (kwFolderTotal > kwFolders.length) host.appendChild(moreRow(moreKeywordFolders));
    }

    function renderKeywordFiles() {
      var host = kwFileBodyEl;
      if (!host) return;
      if (kwFileCountEl) kwFileCountEl.textContent = String(kwFileTotal);
      if (!kwFiles.length) {
        host.replaceChildren(el('div', 'ai-kw-empty', t('没有匹配的文件', 'No matching files')));
        photoItems = [];
        state.currentPhotos = [];
        syncPreviewWindow();
        return;
      }
      // 进预览窗口的只有文件那一组 —— 目录不是可预览项，混进去会让「上一张 / 下一张」
      // 停在两张根本没图的卡片上。
      photoItems = kwFiles.slice();
      state.currentPhotos = photoItems;
      syncPreviewWindow();
      ui.renderPhotoGrid({
        dom: { photoGrid: host },
        photos: photoItems,
        useMediaRatio: state.cardLayoutMode === 'masonry',
        mediaFilter: 'all',
        escapeHtml: ui.escapeHtml,
        escapeAttr: ui.escapeAttr,
        truncate: ui.truncate,
        formatDateTime: ui.formatDateTime,
        formatNumber: ui.formatNumber,
        normalizePath: ui.normalizePath,
        onApplyCardSize: ui.applyCardSize,
      });
      if (kwFileTotal > kwFiles.length) host.appendChild(moreRow(moreKeywordFiles));
    }

    function moreKeywordFolders() {
      var query = String(state.aiSearchQuery || '').trim();
      if (!query || !isKeyword()) return Promise.resolve();
      var limit = Math.min(60, kwFolders.length + KEYWORD_FOLDER_LIMIT);
      if (limit <= kwFolders.length) return Promise.resolve();
      return api
        .call('searchFolders', query, { limit: limit })
        .then(function (data) {
          if (!isKeyword()) return;
          var rows = (data && data.folders) || [];
          if (!rows.length) return;
          kwFolders = rows;
          kwFolderTotal = Number(data.total) || kwFolderTotal;
          renderKeywordFolders();
        })
        .catch(function () {});
    }

    function moreKeywordFiles() {
      var query = String(state.aiSearchQuery || '').trim();
      if (!query || !isKeyword()) return Promise.resolve();
      var next = kwFilePage + 1;
      return api
        // `nameOnly`：文件名**包含**关键词（不是「文件名或所在目录」）——
        // 目录命中的归上方的「文件夹」组，两组不重叠。
        .call('searchPhotos', query, {
          page: next,
          pageSize: KEYWORD_FILE_PAGE,
          nameOnly: true,
        })
        .then(function (data) {
          if (!isKeyword()) return;
          var rows = (data && data.photos) || [];
          if (!rows.length) return;
          kwFilePage = next;
          kwFiles = kwFiles.concat(rows);
          kwFileTotal = Number(data.total) || kwFileTotal;
          renderKeywordFiles();
        })
        .catch(function () {});
    }

    /**
     * 关键词搜索：目录与文件**两条请求并行**，谁先回来都不影响另一条。
     *
     * 刻意不合到一条 IPC：两者的排序、分页、代价模型都不同（目录是整库分组，文件是 FTS
     * 分页），合起来等于让用户等较慢的那一条才看得见任何东西。
     */
    function doKeywordSearch(query) {
      var current = gen;
      state.aiSearchQuery = query;
      if (dom.aiSearchInput) dom.aiSearchInput.value = query;
      if (dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = true;
      setStatus(t('正在搜索…', 'Searching…'));
      onRerenderChrome();
      if (ui.showSkeleton)
        ui.showSkeleton({
          dom: dom,
          loadingLabel: t('正在搜索…', 'Searching…'),
          escapeHtml: ui.escapeHtml,
          onApplyCardSize: ui.applyCardSize,
        });
      kwFolders = [];
      kwFolderTotal = 0;
      kwFiles = [];
      kwFilePage = 0;
      kwFileTotal = 0;
      var folderReq = api
        .call('searchFolders', query, { limit: KEYWORD_FOLDER_LIMIT })
        .catch(function () {
          return { folders: [], total: 0 };
        });
      var fileReq = api
        // 🔴 `nameOnly: true` —— 「文件」组只留**文件名里包含**关键词的。
        //    不加它就会命中「所在目录名包含关键词」的文件（一个目录里几十上百张全被列出来），
        //    而那正是上面「文件夹」组负责表达的事，两组会大面积重叠。
        .call('searchPhotos', query, {
          page: 1,
          pageSize: KEYWORD_FILE_PAGE,
          nameOnly: true,
        })
        .catch(function () {
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
            // 删除之后真的会发生）：查询不同源时 `refreshRetainedSearch` 自己会作废快照，
            // 同源时只剩这一行 —— 少了它，用户离开再回来看到的是**已经不存在的结果**。
            retainedSearch = null;
            setStatus(t('没有匹配的文件或文件夹', 'No matching files or folders'));
            emptyState(
              '\u{1F50D}',
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
          renderKeywordShell();
          renderKeywordFolders();
          renderKeywordFiles();
          // 放在渲染之后：`markSearchRetained` 会把活变量与状态文案一起刷进保留态。
          markSearchRetained(query);
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
      renderSearchMode();
      renderSearchHistory();
      // 复用进入时抽好的那一批：重绘（状态轮询 / 语言切换）不该让词跳变。
      renderSearchSuggest();
      if (query) {
        // 有保留态就**原样画回**（离开搜图页的两条路：点结果里的目录跳走、换视图），
        // 不重跑一遍搜索 —— 重跑会闪骨架屏，还会把「更多」翻过的页缩回第一页。
        if (restoreRetainedSearch()) return Promise.resolve();
        return startSearch(query);
      }
      setStatus('');
      // 关键词档不查 AI 索引状态（跟它无关），也不必等那趟 IPC。
      if (searchMode === 'keyword') {
        keywordIdleState();
        return Promise.resolve();
      }
      searchIdleState();
      return refreshStatus().then(function () {
        if (!isSearch()) return;
        if (String(state.aiSearchQuery || '').trim()) return;
        var current = lastState || {};
        var message = noticeFor(current);
        // 索引在跑、但已经有可用向量：明确告诉用户「现在就能搜，只是覆盖不全」。
        if (!message && current.running && current.indexed)
          message = t(
            '索引仍在建立中（已索引 ' +
              compactCount(current.indexed) +
              ' 张）：现在就能搜，结果只覆盖已索引的图片。',
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
            emptyState('👥', t('这一组已经没有图片了。', 'No current photos in this group.'));
            return;
          }
          setStatus(t(photoItems.length + ' 张图片', photoItems.length + ' photos'));
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
      kwFolders = [];
      kwFolderTotal = 0;
      kwFiles = [];
      kwFilePage = 0;
      kwFileTotal = 0;
      kwFolderBodyEl = null;
      kwFileBodyEl = null;
      kwFileCountEl = null;
      rowById = {};
      state.currentPhotos = [];
      syncPreviewWindow();
      if (dom.pagination) dom.pagination.style.display = 'none';
      if (dom.photoGrid) dom.photoGrid.scrollTop = 0;
      applyToolbar();
      if (dom.aiSearchSubmit) dom.aiSearchSubmit.disabled = false;
      if (view === 'ai_search') {
        // ⚠️ 这里**不再**清 `state.aiSearchQuery`：清了就再也回不到上一次的结果（见 `retainedSearch`）。
        //    唯一的清空入口是「空提交」（`startSearch('')`）。
        state.aiPeopleLabel = '';
        // 档位按钮必须先画：它决定预选词显不显示、输入框提示语是哪一句。
        renderSearchMode();
        renderSearchHistory();
        // 每次进入搜索页重抽一批预选词（「随机」要能被感知，就必须换视图就换词）。
        // 词池还没取回来时这里会走骨架态（见 renderSearchSuggest），等 refreshSuggestions
        // 回来再换真词。
        suggestBatch = pickSuggestions(SUGGEST_COUNT);
        renderSearchSuggest();
        setStatus('');
        // 有保留态时**先别画引导页**：`loadSearch()` 紧接着（经 `loadPhotos()` 那一跳）就会
        // 把上一次的结果画回来，提前画一遍只会闪一个空状态。判据与还原同源（`searchRestorable`）。
        var restoring = searchRestorable();
        // 不是「离开过一次又回来」的那一次 ⇒ 这是一次**干净的进入**：把上一次的词一起清掉。
        // 只画引导页、却把查询留在 `state` 里是最坏的组合：界面看着像没有搜索在生效，
        // 而紧接着 `loadPhotos()` 触发的那次 `loadSearch()` 又会拿这个词去重搜一遍 ——
        // 同一页在「引导页 / 结果」之间来回翻；语义档更糟，它会跳过「模型尚未就绪」的说明
        // （那段只在**空查询**分支里给，见 loadSearch）。
        // 有了保留态之后，「查着词又没在还原」只可能是上面这一种情况，所以这里清空是安全的。
        if (!restoring) state.aiSearchQuery = '';
        if (searchMode === 'keyword') {
          if (!restoring) keywordIdleState();
        } else {
          if (!restoring) searchIdleState();
          // 取「本库点下去真有图的词」（一个会话一次、换语言重取一次）；拿回来会重绘本页。
          refreshSuggestions();
        }
        focusSearch();
        // 带词进来的（图片信息面板的 主题标签点了）在这里补搜 —— 必须等上面那几行初始化
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
      // 先把当前结果刷进保留态（含「更多」翻过的页与状态行文案），再照旧把活变量清干净 ——
      // 活变量带着 DOM 引用，回来时由 `loadSearch()` 按保留态重新画。
      refreshRetainedSearch();
      pendingRestore = !!retainedSearch;
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
      kwFolders = [];
      kwFolderTotal = 0;
      kwFiles = [];
      kwFilePage = 0;
      kwFileTotal = 0;
      kwFolderBodyEl = null;
      kwFileBodyEl = null;
      kwFileCountEl = null;
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
      // 档位切换：只认 `data-ai-search-mode`，不认按钮 id（加档位不用回来改判据）。
      if (dom.aiSearchModes)
        dom.aiSearchModes.addEventListener('click', function (event) {
          // 浏览器里点到的是按钮内部的文本节点，要 `closest` 回到按钮本身；
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
        // 输入框的提示语是**按档位**写进 placeholder 的（不挂 data-i18n-*），
        // 所以切语言必须重画档位，否则提示语留在旧语言。
        renderSearchMode();
        renderSearchHistory();
        renderSearchSuggest();
        renderPeopleList();
        highlightPerson(person ? person.id : null);
        syncPeopleLive();
        onRerenderChrome();
        if (isSearch() && !String(state.aiSearchQuery || '').trim()) {
          if (searchMode === 'keyword') keywordIdleState();
          else searchIdleState();
        }
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
       * 带词搜图（图片信息面板的 主题标签 → 搜图页）。
       *
       * 两种入口都只调这一次就正确：
       *   - 已在搜图页 → 直接搜；
       *   - 不在搜图页 → 词暂存给下一次 `enter()` 消费（调用方随后 `showTabContent('search')`）。
       * 这个顺序仍然是推荐写法，但 2026-10-07 起不再是**硬**要求：`enter()` 已不清
       * `state.aiSearchQuery`（搜图页要保留上一次的结果）。先切页再调照样能搜到，只是要多跟
       * `loadSearch()` 的保留态还原抢一次先后。
       *
       * 🔴 这个入口**强制切到语义档**：词来自语义模型的 主题标签（「海」「雪」这种画面词），
       *    拿它去比文件名等于搜了个寂寞。不切档的话「点标签」会静默走错引擎。
       */
      search: function (query) {
        var q = String(query || '').trim();
        if (!q) return Promise.resolve();
        if (searchMode !== 'semantic') {
          searchMode = 'semantic';
          // 上一个档位（关键词）的保留结果对新档位没有意义，先作废；下面这次搜索会写新的。
          retainedSearch = null;
          renderSearchMode();
        }
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
