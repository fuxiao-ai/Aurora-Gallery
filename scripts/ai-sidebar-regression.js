'use strict';
/**
 * 「搜图 / 人物」侧栏独占改造 —— 行为级回归（QA 独立验收）。
 *
 * 与既有脚本的分工：
 *   - sidebar-tree-regression  : 用 vm 驱动真实 app.js，断言侧栏切换 / gate 语义；
 *   - ai-web-views-regression  : 网页端适配层行为；
 *   - 本脚本补齐此前**无任何控制器测试**的桌面端适配层 src/renderer/ai-views.js，
 *     并额外做几组契约级断言（设置入口与优先级、残留引用、导轨顺序、两端白名单收窄）。
 *
 * 覆盖面（对应验收要点 1–9）：
 *   A. 桌面端适配层：搜索历史（上限 8 / 去重置顶 / 点击复搜 / 清除 / 刷新持久化）、
 *      搜图预选词（进入即随机抽 5 个 / 重绘不跳变 / 点击直搜 / 换一批真的会换）、
 *      人物页默认空态「从左侧选择一个人」且**不发照片请求**、点人看照片 + 高亮切换、
 *      结果复用照片网格（renderPhotoGrid + previewTotalPages===1）。（要点 2/3/5）
 *   B. 桌面端 app.js：isFolderSidebarTab 仅 folders；gate('folders') 不在搜图 / 人物存活；
 *      showTabContent('search'|'people') 不补拉文件夹树、打 page-open 类、收起主区工具栏。（要点 1/6）
 *   C. 网页端 app.js 静态契约：白名单同样收窄、侧栏两态切换存在。（要点 6）
 *   D. 设置入口与优先级：peopleNavSettings 可点进设置；settings-page-open 优先级最高。（要点 4）
 *   E. 残留引用：全仓不应再出现 aiViewBack / peopleNavAll / aiSearchBox / aiBackBtn。（要点 8）
 *   F. 导轨项 data-tab 序列 / 数量。（要点 9）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ===========================================================================
// 通用 fake DOM
// ===========================================================================
function makeEl(tag) {
  const classes = new Set();
  const attributes = {};
  const listeners = {};
  const el = {
    tag: tag || 'div',
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    value: '',
    type: '',
    style: {},
    scrollTop: 0,
    children: [],
    listeners,
    attributes,
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
      toggle: (n, force) => {
        const has = classes.has(n);
        const want = force === undefined ? !has : !!force;
        if (want) classes.add(n);
        else classes.delete(n);
        return want;
      },
    },
    setAttribute(k, v) {
      attributes[k] = String(v);
    },
    getAttribute(k) {
      return k in attributes ? attributes[k] : null;
    },
    removeAttribute(k) {
      delete attributes[k];
    },
    addEventListener(name, fn) {
      listeners[name] = fn;
    },
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...items) {
      items.forEach((i) => this.appendChild(i));
    },
    replaceChildren(...items) {
      this.children = [];
      this.append(...items);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
    select() {},
    remove() {},
  };
  return el;
}

function walk(node, fn) {
  fn(node);
  for (const child of node.children || []) walk(child, fn);
}
function deepText(node) {
  let out = node.textContent || '';
  for (const child of node.children || []) out += deepText(child);
  return out;
}
function collectByAttr(root, attr) {
  const out = [];
  walk(root, (n) => {
    if (n !== root && n.getAttribute && n.getAttribute(attr) != null)
      out.push(n.getAttribute(attr));
  });
  return out;
}
// 假 DOM 里 el(tag, className) 写的是 className 字符串，而 classList 是另一套集合，
// 所以两类都要认：静态类看 className，运行期加的类（如 active / is-renaming）看 classList。
function hasClass(node, cls) {
  if (!node) return false;
  if (node.classList && node.classList.contains(cls)) return true;
  return typeof node.className === 'string' && node.className.split(/\s+/).indexOf(cls) >= 0;
}
function findByClass(root, cls) {
  let found = null;
  walk(root, (n) => {
    if (!found && hasClass(n, cls)) found = n;
  });
  return found;
}
function countByClass(root, cls) {
  let count = 0;
  walk(root, (n) => {
    if (hasClass(n, cls)) count += 1;
  });
  return count;
}
function findByAttr(root, attr, value) {
  let found = null;
  walk(root, (n) => {
    if (!found && n.getAttribute && n.getAttribute(attr) === value) found = n;
  });
  return found;
}
/** 改名的按键事件只需要 key，其余成员给个空实现即可。 */
function keyEvent(key) {
  return { key: key, preventDefault() {}, stopPropagation() {} };
}
function pointerEvent() {
  return { preventDefault() {}, stopPropagation() {} };
}
function renameCalls(apiCalls) {
  return apiCalls.filter((c) => c.op === 'faceAction' && c.a === 'rename');
}
/**
 * 服务端按「本库真实命中数」挑出来的预选词池（替身）。
 *
 * 词表与排序都在服务端（`src/ai/search-vocabulary.js` + worker 的 suggest 分支），
 * 界面收到的**只有排好序的文本**，它做的事仅剩「洗牌抽 5 个」。所以这里给的是一份
 * 已经筛过、已经排好序的列表 —— 界面上出现任何一个不在这份名单里的词，都是界面在
 * 自己造词（那正是要挡掉的旧行为）。
 */
const SUGGEST_TERMS = [
  { text: '人物肖像', hits: 84 },
  { text: '逆光', hits: 40 },
  { text: '棚拍', hits: 33 },
  { text: '双马尾', hits: 21 },
  { text: '粉色', hits: 17 },
  { text: '街拍', hits: 13 },
  { text: '蕾丝', hits: 9 },
  { text: '汉服', hits: 6 },
  { text: '小巷', hits: 4 },
  { text: '镜面反射', hits: 1 },
];

// ===========================================================================
// A. 桌面端适配层 src/renderer/ai-views.js
// ===========================================================================
function makeDom() {
  const ids = [
    'aiSearchHistoryList',
    'aiSearchHistoryClear',
    'aiSearchSuggest',
    'aiSearchInput',
    'aiSearchSubmit',
    'aiSearchForm',
    'aiViewStatus',
    'aiPeopleStatus',
    'aiPeopleLive',
    'aiPeopleLiveText',
    'aiPeopleLiveStats',
    'peopleList',
    'peopleSearchInput',
    'photoGrid',
    'pagination',
    'mediaFilterSelect',
    'sortSelect',
    'randomPageBtn',
  ];
  const dom = {};
  ids.forEach((id) => {
    dom[id] = makeEl(id === 'photoGrid' ? 'div' : 'div');
  });
  return dom;
}

// 稳定挂载的 window / document：ai-views.js 在 require 时就用 (window) 作为 global 捕获，
// 因此这里只创建一次，之后仅替换 localStorage，保证 require 的模块始终指着同一个 window。
const WIN = {
  addEventListener() {},
  requestAnimationFrame: (cb) => {
    cb();
    return 0;
  },
  setInterval: () => 0,
  clearInterval() {},
  localStorage: null,
};
global.window = WIN;
global.document = {
  documentElement: { lang: 'zh-CN' },
  createElement: (tag) => makeEl(tag),
};
require('../src/renderer/ai-views');

function installRendererGlobals(store) {
  WIN.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

function buildAiViews(opts) {
  const historyStore = opts.store;
  const status = opts.status || { ready: true, indexed: 40, busy: false, people: 2 };
  const groups = opts.groups || [];
  const personPhotosById = opts.personPhotosById || {};
  const dom = makeDom();
  const gridCalls = [];
  const apiCalls = [];
  const state = { currentView: opts.view, currentPhotos: [], cardLayoutMode: 'grid' };
  const api = {
    // 「预选词按库筛选」这条通道默认不提供（老用例保持纯静态词库的行为）；
    // 需要的用例用 opts.searchSuggest 打开。
    has(name) {
      return name === 'aiSearchSuggest' && !!opts.searchSuggest;
    },
    call(op, a, b) {
      apiCalls.push({ op, a, b });
      if (op === 'aiSearchStatus' || (op === 'faceAction' && a === 'status'))
        return Promise.resolve({ ...status });
      if (op === 'aiSearchQuery')
        return Promise.resolve({
          photos: (opts.searchHits || []).slice(),
          // 真实服务端会带回**达标总数**，它可能大于返回条数（内部为内存起见只留最相近的一批）。
          matched: opts.searchMatched == null ? (opts.searchHits || []).length : opts.searchMatched,
          // 真实服务端会带回「已索引张数」，索引进行中界面据此说明结果覆盖率。
          ...(opts.searchIndexed == null ? {} : { indexed: opts.searchIndexed }),
        });
      if (op === 'aiSearchSuggest' && opts.searchSuggest) {
        // 任务忙 / 超时 / 没索引：也要走「取不到 → 整块收起」那条路。
        // 加载态必须能**退出**，否则骨架会永久停在「挑选中…」。
        if (opts.searchSuggest.fails) return Promise.reject(new Error('AI_TASK_BUSY'));
        // 新契约：请求是 `{ lang, limit }`，回答是 `{ sampled, terms }`。
        // 界面**不再**把词表带过来 —— 词表在服务端（`src/ai/search-vocabulary.js`），
        // 服务端按真实命中数排好序、把 0 命中的词挡掉，界面只负责洗牌抽 5 个。
        return Promise.resolve({
          sampled: opts.searchSuggest.sampled,
          terms: opts.searchSuggest.terms || [],
        });
      }
      if (op === 'faceAction' && a === 'groups')
        return Promise.resolve({ items: groups.slice(), next: null });
      if (op === 'faceAction' && a === 'photos') {
        const pid = b && b.personId;
        return Promise.resolve({ items: (personPhotosById[pid] || []).slice(), next: null });
      }
      if (op === 'faceAction' && a === 'rename') {
        if (opts.renameFails) return Promise.reject(new Error('FACE_PERSON_MISSING'));
        return Promise.resolve({});
      }
      return Promise.reject(new Error('unexpected ' + op + '/' + a));
    },
  };
  const ui = {
    renderPhotoGrid(payload) {
      gridCalls.push(payload.photos);
    },
    applyCardSize() {},
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    truncate: (s) => String(s),
    formatDateTime: () => '',
    formatNumber: (n) => String(n),
    normalizePath: (p) => p,
    showSkeleton() {},
  };
  const views = global.window.RendererAiViews.init({
    dom,
    state,
    api,
    ui,
    onRerenderChrome() {},
  });
  views.bind();
  return { views, dom, state, apiCalls, gridCalls, historyStore };
}

const HISTORY_KEY = 'photoManager.aiSearchHistory';
function historyFromDom(dom) {
  return collectByAttr(dom.aiSearchHistoryList, 'data-ai-history');
}
function historyFromStore(store) {
  return JSON.parse(store[HISTORY_KEY] || '[]');
}
/** 侧栏「预选词」当前这一批（按渲染顺序）。 */
function suggestFromDom(dom) {
  return collectByAttr(dom.aiSearchSuggest, 'data-ai-suggest');
}

async function testDesktopSearchSuggest() {
  // ---- 预选词：进入即随机抽一批、点一下直接搜 ----
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom, state } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [],
      searchSuggest: { sampled: 3000, terms: SUGGEST_TERMS },
    });
    views.enter('ai_search');
    // 词池是**异步取回来**的（服务端要按真实命中数算一遍），所以这里必须等一轮。
    // 等不到就什么都不摆 —— 旧实现是先摆一批写死的词、再慢慢替换，那正是要改掉的。
    await flush();
    const batch = suggestFromDom(dom);
    assert.equal(batch.length, 5, '进入搜索页即抽 5 个预选词');
    assert.equal(
      new Set(batch).size,
      batch.length,
      '同一批预选词不得重复（洗牌取样要取不重复的词）',
    );
    assert.ok(
      batch.every((w) => typeof w === 'string' && w.trim().length > 0),
      '预选词都是非空文本',
    );
    assert.ok(
      deepText(dom.aiSearchSuggest).includes('预选词'),
      '预选词区域带标题，不会让用户以为是搜索历史',
    );

    // 重绘（状态轮询 / 重新 load）不该让词跳变——否则侧栏会自己闪。
    await views.load();
    await flush();
    assert.deepEqual(suggestFromDom(dom), batch, '重绘复用同一批预选词（不跳变）');

    // 点第 2 个词：回填输入框 + 直接开搜 + 进历史
    const picked = suggestFromDom(dom)[1];
    const chip = findByAttr(dom.aiSearchSuggest, 'data-ai-suggest', picked);
    assert.ok(chip, '预选词渲染成可点击的 chip');
    chip.listeners.click();
    await flush();
    assert.equal(dom.aiSearchInput.value, picked, '点预选词回填搜索框');
    assert.equal(state.aiSearchQuery, picked, '点预选词直接发起搜索');
    assert.equal(historyFromDom(dom)[0], picked, '点预选词搜过的词进搜索历史');

    // 「换一批」：多次点击后必须出现过不同的一批（18 选 5 有序组合远超 1e4，全同概率可忽略）
    const seen = new Set([suggestFromDom(dom).join('|')]);
    for (let i = 0; i < 20 && seen.size < 2; i += 1) {
      const refresh = findByClass(dom.aiSearchSuggest, 'ai-search-suggest-refresh');
      assert.ok(refresh, '预选词区域带「换一批」按钮');
      refresh.listeners.click();
      seen.add(suggestFromDom(dom).join('|'));
    }
    assert.equal(seen.size >= 2, true, '「换一批」能换出不同的词（随机真的在起作用）');
    assert.equal(suggestFromDom(dom).length, 5, '换一批后仍是 5 个');
    views.stopPolling();
  }

  // ---- 同一个会话里两次进入抽到同一批的概率极小：至少结构上每次都重抽 ----
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'people',
      store,
      searchSuggest: { sampled: 3000, terms: SUGGEST_TERMS },
    });
    const batches = new Set();
    for (let i = 0; i < 12; i += 1) {
      views.enter('ai_search');
      await flush();
      batches.add(suggestFromDom(dom).join('|'));
      views.enter('people');
    }
    assert.ok(batches.size >= 2, '重新进入搜索页会重新抽词（12 次里出现过不同批次）');
    views.stopPolling();
  }

  // ---- 预选词只摆「服务端按本库真实命中数挑出来的词」 ----
  // 词表和排序都在服务端（`src/ai/search-vocabulary.js` + worker 的 suggest 分支），
  // 界面收到的只有排好序的文本。这里的替身给的是一份已经筛过的名单，界面只要摆出
  // 名单以外的任何词，就说明它又在自己造词 —— 那正是要挡掉的旧行为。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom, apiCalls } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [],
      searchSuggest: { sampled: 3000, terms: SUGGEST_TERMS },
    });
    views.enter('ai_search');
    await flush();
    const call = apiCalls.find((c) => c.op === 'aiSearchSuggest');
    assert.ok(call, '进搜索页时向主进程要一次预选词');
    assert.ok(call.a && typeof call.a === 'object' && !Array.isArray(call.a), '请求是对象形状');
    assert.equal(call.a.lang, 'zh-CN', '要带上界面语言（词表分中英两版，词不能串语言）');
    assert.ok(call.a.limit >= 5, '一次要多要几个词当池子，供「换一批」本地洗牌');
    const allowed = new Set(SUGGEST_TERMS.map((term) => term.text));
    const shown = suggestFromDom(dom);
    assert.equal(shown.length, 5, '侧栏摆 5 个');
    assert.ok(
      shown.every((word) => allowed.has(word)),
      '侧栏只摆服务端挑出来的词，界面不得自己造词：' + shown.join('/'),
    );
    await views.load();
    await flush();
    assert.deepEqual(suggestFromDom(dom), shown, '重绘复用同一批（不跳变）');
    views.stopPolling();
  }

  // ---- 一个词都不达标 → **整块收起来**，不回退到任何静态词库 ----
  // 旧实现是在这里回退整份静态词库，于是库里一个都没有的「夕阳下的海滩」照样被摆出来
  // 给用户点（本机库实测那种词 18 个里有 13 个是 0 张）。摆出「已知没结果」的词是纯误导，
  // 不如把这一块收起来 —— 主区引导页已经在讲「可以用一句话描述画面」。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [],
      searchSuggest: { sampled: 3000, terms: [] },
    });
    views.enter('ai_search');
    await flush();
    assert.equal(suggestFromDom(dom).length, 0, '一个词都不达标时不摆任何词');
    assert.equal(dom.aiSearchSuggest.hidden, true, '整块收起来');
    assert.equal(
      deepText(dom.aiSearchSuggest).includes('预选词'),
      false,
      '连标题与「换一批」一起收起来，不摆空壳',
    );
    views.stopPolling();
  }

  // ---- 拿不到索引（sampled = 0）时同样收起，且一个会话只问一次 ----
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom, apiCalls } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [],
      searchSuggest: { sampled: 0, terms: [] },
    });
    views.enter('ai_search');
    await flush();
    assert.equal(dom.aiSearchSuggest.hidden, true, '没有可用索引时收起，而不是摆一批可能没结果的词');
    views.enter('people');
    views.enter('ai_search');
    await flush();
    assert.equal(
      apiCalls.filter((c) => c.op === 'aiSearchSuggest').length,
      1,
      '一个会话只问一次：反复请求等于反复等一次模型加载',
    );
    views.stopPolling();
  }

  // ---- 加载态：取词期间摆骨架（不是空白），词到了换成真词 ----
  // 取词不便宜：起只读 worker 载模型 ~2.1s + 打开索引 ~0.7s + 打分 ~1s，
  // 冷启还要现算 308 个词的词表向量（~15s）。旧实现把这段等待留成空白，
  // 用户读到的是「这里没有预选词」而不是「正在挑」。所以骨架必须在**同步**那一下就画好。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [],
      searchSuggest: { sampled: 3000, terms: SUGGEST_TERMS },
    });
    views.enter('ai_search');
    // 不 await：此刻请求刚发出去，DOM 必须已经是加载态
    assert.equal(
      dom.aiSearchSuggest.hidden,
      false,
      '等待期间不整块隐藏，否则用户看到的是「没有」而不是「正在挑」',
    );
    assert.equal(
      countByClass(dom.aiSearchSuggest, 'ai-suggest-skeleton'),
      5,
      '等待期间摆 5 个骨架占位（和真词一样多）',
    );
    assert.equal(suggestFromDom(dom).length, 0, '骨架期间不得混进真词');
    assert.equal(dom.aiSearchSuggest.getAttribute('aria-busy'), 'true', '等待期间对读屏声明忙');
    assert.equal(
      findByClass(dom.aiSearchSuggest, 'ai-search-suggest-refresh'),
      null,
      '骨架期间没有「换一批」——还没有词可换',
    );

    await flush();
    assert.equal(
      countByClass(dom.aiSearchSuggest, 'ai-suggest-skeleton'),
      0,
      '词到了骨架要撤掉，不能留着变成「假词」',
    );
    assert.equal(suggestFromDom(dom).length, 5, '词到了换成真词');
    assert.equal(dom.aiSearchSuggest.getAttribute('aria-busy'), null, '词到了摘掉忙碌标记');
    views.stopPolling();
  }

  // ---- 取词失败（任务忙 / 超时 / 无索引）：骨架必须退场，整块收起 ----
  // ⚠️ 这是加载态最容易做错的地方：失败分支若不重画，整块会**永久停在「挑选中…」**。
  // 加载态假死比原本的空白更糟（空白至少是诚实的）。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [],
      searchSuggest: { fails: true },
    });
    views.enter('ai_search');
    assert.equal(
      countByClass(dom.aiSearchSuggest, 'ai-suggest-skeleton'),
      5,
      '请求在途时同样是加载态（失败要等结果回来才知道）',
    );
    await flush();
    assert.equal(
      dom.aiSearchSuggest.hidden,
      true,
      '取不到就整块收起：骨架不许永久停在加载态',
    );
    assert.equal(
      countByClass(dom.aiSearchSuggest, 'ai-suggest-skeleton'),
      0,
      '收起时骨架一并清掉',
    );
    assert.equal(deepText(dom.aiSearchSuggest), '', '收起时不留残留文本（含标题）');
    views.stopPolling();
  }
}

// ---- 主区引导页：有真实词池就用真实的，没有才退回固定的几句典型描述 ----
// 「示例」也是会被用户点的东西，所以它同样不该摆「点下去 0 张」的词。
async function testMainHeroExamples() {
  // 拿不到词池（没索引 / 没通道）：给几句典型描述，作用是教会用户「可以描述画面」。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({ view: 'ai_search', store });
    views.enter('ai_search');
    const hero = deepText(dom.photoGrid);
    ['夕阳下的海滩', '雪山和湖泊', '人物肖像', '城市夜景', '美食特写'].forEach((word) => {
      assert.ok(hero.includes(word), '拿不到词池时引导页给固定示例词：' + word);
    });
    assert.ok(!hero.includes('雨天的倒影'), '固定示例就是这 5 个，不会跟着词表扩张而变多');
    views.stopPolling();
  }
  // 有词池：引导页与侧栏同源，摆的都是本库真实有内容的词。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'ai_search',
      store,
      searchSuggest: { sampled: 3000, terms: SUGGEST_TERMS },
    });
    views.enter('ai_search');
    await flush();
    const hero = deepText(dom.photoGrid);
    const allowed = SUGGEST_TERMS.map((term) => term.text);
    const shown = allowed.filter((word) => hero.includes(word));
    assert.ok(shown.length > 0, '有词池时引导页摆的是真实词：' + hero.slice(0, 120));
    assert.equal(shown.length, 5, '引导页摆 5 个，与侧栏同源');
    assert.ok(
      !hero.includes('夕阳下的海滩'),
      '有真实词池时不再摆固定示例（那些词在这个库里可能一张都没有）',
    );
    views.stopPolling();
  }
}

async function testDesktopAiViews() {
  // ---- 搜索历史：空态 ----
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({ view: 'ai_search', store, searchHits: [] });
    views.enter('ai_search');
    assert.deepEqual(historyFromDom(dom), [], '初始历史为空');
    assert.ok(deepText(dom.aiSearchHistoryList).includes('还没有搜索记录'), '空历史给出中文提示');
    assert.equal(dom.aiSearchHistoryClear.hidden, true, '无历史时「清除」按钮隐藏');
  }

  // ---- 搜索历史：上限 8 + 淘汰最旧 ----
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom, state } = buildAiViews({ view: 'ai_search', store, searchHits: [] });
    views.enter('ai_search');
    for (let i = 1; i <= 9; i += 1) {
      state.aiSearchQuery = 'q' + i;
      await views.load();
      await flush();
    }
    const list = historyFromDom(dom);
    assert.equal(list.length, 8, '历史只保留最近 8 条（第 9 条触发淘汰）');
    assert.deepEqual(
      list,
      ['q9', 'q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2'],
      '最新在前，最旧的 q1 已被淘汰',
    );
    assert.deepEqual(historyFromStore(store), list, 'localStorage 与内存历史一致');
    assert.equal(dom.aiSearchHistoryClear.hidden, false, '有历史时「清除」按钮可见');

    // ---- 去重置顶：同词再搜不新增、只置顶 ----
    state.aiSearchQuery = 'q5';
    await views.load();
    await flush();
    const list2 = historyFromDom(dom);
    assert.equal(list2.length, 8, '同词复搜不产生重复项');
    assert.equal(list2[0], 'q5', '复搜的词被提到最前');
    assert.equal(list2.filter((q) => q === 'q5').length, 1, '历史里 q5 只出现一次');

    // ---- 刷新持久化：新实例从 localStorage 读回同一份历史 ----
    const store2 = { ...store };
    installRendererGlobals(store2);
    const second = buildAiViews({ view: 'ai_search', store: store2, searchHits: [] });
    second.views.enter('ai_search');
    assert.deepEqual(
      historyFromDom(second.dom),
      list2,
      '重建实例后历史仍在（localStorage 持久化）',
    );
    // 恢复第一个实例所用的 localStorage（模块全局只有一份，避免影响后续断言）。
    installRendererGlobals(store);

    // ---- 点击历史项回填输入框并复搜 ----
    const item = dom.aiSearchHistoryList.children.find(
      (c) => c.getAttribute('data-ai-history') === 'q3',
    );
    assert.ok(item, '历史列表里存在 q3 这一项');
    const before = views.isActive();
    assert.equal(before, true);
    item.listeners.click();
    await flush();
    assert.equal(dom.aiSearchInput.value, 'q3', '点击历史项回填输入框');
    assert.equal(historyFromDom(dom)[0], 'q3', '点击历史项触发复搜并置顶');
    const searched = state.aiSearchQuery;
    assert.equal(searched, 'q3', 'state.aiSearchQuery 被更新为点击的词');

    // ---- 清除 ----
    dom.aiSearchHistoryClear.listeners.click();
    assert.deepEqual(historyFromDom(dom), [], '「清除」清空列表');
    assert.deepEqual(historyFromStore(store), [], '「清除」同步写入空数组');
    assert.ok(deepText(dom.aiSearchHistoryList).includes('还没有搜索记录'), '清除后回到空态');
  }

  // ---- 人物页：默认不选人不拉照片 ----
  {
    const store = {};
    installRendererGlobals(store);
    const groups = [
      { id: 1, name: 'Alice', photoCount: 2, thumbnail: '/t1' },
      { id: 2, name: 'Bob', photoCount: 1, thumbnail: '' },
    ];
    const { views, dom, state, apiCalls, gridCalls } = buildAiViews({
      view: 'people',
      store,
      groups,
      personPhotosById: {
        1: [
          { id: 11, file_name: 'a1.jpg' },
          { id: 12, file_name: 'a2.jpg' },
        ],
        2: [{ id: 21, file_name: 'b1.jpg' }],
      },
    });
    views.enter('people');
    assert.ok(
      deepText(dom.photoGrid).includes('从左侧选择一个人'),
      '人物页默认空态是「从左侧选择一个人」',
    );
    assert.equal(state.currentPhotos.length, 0, '未选人时 currentPhotos 为空');

    await views.load();
    await flush();
    assert.equal(
      apiCalls.some((c) => c.op === 'faceAction' && c.a === 'photos'),
      false,
      '未选人时不得发起任何照片请求',
    );
    const rows = dom.peopleList.children;
    assert.equal(rows.length, 2, '侧栏列出两个人物');
    assert.equal(rows[0].getAttribute('data-person-id'), '1');
    assert.ok(deepText(rows[0]).includes('Alice'), '人物行显示名字');
    assert.ok(deepText(rows[0]).includes('2 张'), '人物行显示张数');
    assert.equal(gridCalls.length, 0, '只列人物、不渲染照片网格');

    // ---- 点第一个人 ----
    rows[0].listeners.click();
    await flush();
    assert.equal(
      apiCalls.some((c) => c.op === 'faceAction' && c.a === 'photos' && c.b.personId === 1),
      true,
      '点人物后按 personId 拉取该人照片',
    );
    assert.equal(gridCalls[gridCalls.length - 1].length, 2, '该人的照片进入照片网格');
    assert.equal(state.previewTotalPages, 1, '结果集收成单页，预览翻页只在结果里走');
    assert.equal(state.previewTotalPhotos, 2, 'previewTotalPhotos 与该人照片数一致');
    assert.equal(rows[0].classList.contains('active'), true, '被选中的人物高亮');
    assert.equal(rows[1].classList.contains('active'), false, '未选中的人物不高亮');

    // ---- 切到第二个人 ----
    rows[1].listeners.click();
    await flush();
    assert.equal(rows[1].classList.contains('active'), true, '切换后第二个人高亮');
    assert.equal(rows[0].classList.contains('active'), false, '切换后第一个人取消高亮');
    assert.equal(gridCalls[gridCalls.length - 1].length, 1, '切换后网格换成第二个人的照片');
    assert.equal(state.previewTotalPhotos, 1);
    views.stopPolling();
  }
}

// ===========================================================================
// A2. 人物侧栏：搜索过滤 + 双击改名
// ===========================================================================
async function testPeopleSearchAndRename() {
  // ---- 搜索只筛侧栏列表 ----
  {
    const store = {};
    installRendererGlobals(store);
    const groups = [
      { id: 1, name: 'Alice', photoCount: 3, thumbnail: '/a' },
      { id: 2, name: 'Bob', photoCount: 2, thumbnail: '/b' },
      { id: 3, name: '', photoCount: 1, thumbnail: '' },
    ];
    const { views, dom, apiCalls } = buildAiViews({ view: 'people', store, groups });
    views.enter('people');
    await views.load();
    await flush();
    assert.equal(dom.peopleList.children.length, 3, '默认列出全部人物');

    const type = (value) => {
      dom.peopleSearchInput.value = value;
      dom.peopleSearchInput.listeners.input();
    };
    const photoCalls = () => apiCalls.filter((c) => c.op === 'faceAction' && c.a === 'photos');

    type('alice');
    assert.equal(dom.peopleList.children.length, 1, '按名字过滤（大小写不敏感）');
    assert.ok(deepText(dom.peopleList.children[0]).includes('Alice'), '留下的正是匹配的那一个');
    assert.equal(photoCalls().length, 0, '过滤只筛列表，不得发起任何照片请求');

    type('未命名');
    assert.equal(dom.peopleList.children.length, 1, '搜「未命名」能捞到还没起名的人');
    assert.equal(dom.peopleList.children[0].getAttribute('data-person-id'), '3');
    assert.ok(deepText(dom.peopleList).includes('未命名人物'));

    type('zzz');
    assert.equal(dom.peopleList.children.length, 1, '无匹配时列表只留一条提示');
    assert.ok(deepText(dom.peopleList).includes('没有匹配的人物'), '无匹配给出明确提示');

    type('');
    assert.equal(dom.peopleList.children.length, 3, '清空搜索词恢复完整列表');

    // Esc 清空（原生 type=search 的 ✕ 也走同一条路）
    type('alice');
    dom.peopleSearchInput.listeners.keydown(keyEvent('Escape'));
    assert.equal(dom.peopleSearchInput.value, '', 'Esc 清空输入框');
    assert.equal(dom.peopleList.children.length, 3, 'Esc 后恢复完整列表');

    // 重新进入人物页要清空搜索词，否则会看见「莫名其妙的空列表」
    type('alice');
    views.enter('people');
    assert.equal(dom.peopleSearchInput.value, '', '重新进入人物页清空搜索词');
    assert.equal(
      deepText(dom.peopleList).includes('没有匹配的人物'),
      false,
      '重新进入后不该还停在「无匹配」',
    );
    views.stopPolling();
  }

  // ---- 双击改名：保存 / 不改动 / 取消 / 未命名的人 ----
  {
    const store = {};
    installRendererGlobals(store);
    const groups = [
      { id: 1, name: 'Alice', photoCount: 3, thumbnail: '/a' },
      { id: 2, name: '', photoCount: 1, thumbnail: '' },
    ];
    const { views, dom, state, apiCalls } = buildAiViews({ view: 'people', store, groups });
    views.enter('people');
    await views.load();
    await flush();

    const rowOf = (id) => findByAttr(dom.peopleList, 'data-person-id', String(id));
    const nameOf = (id) => findByClass(rowOf(id), 'ai-people-name');
    const openEditor = (id) => {
      nameOf(id).listeners.dblclick(pointerEvent());
      return findByClass(rowOf(id), 'ai-people-rename-input');
    };

    assert.equal(nameOf(1).textContent, 'Alice');
    assert.ok(
      String(nameOf(1).title || '').includes('双击'),
      '名字上带「双击可改名」提示（行内编辑要能被发现）',
    );

    // 双击 → 就地输入框，行不重建
    const row1 = rowOf(1);
    const editor = openEditor(1);
    assert.ok(editor, '双击后名字位置换成输入框');
    assert.equal(editor.value, 'Alice', '输入框预填当前名字');
    assert.equal(rowOf(1), row1, '改名期间不重建列表（头像不会闪一下）');
    assert.equal(row1.classList.contains('is-renaming'), true, '行标记为改名中');

    // 名字没改 → 不落库
    editor.listeners.keydown(keyEvent('Enter'));
    await flush();
    assert.equal(renameCalls(apiCalls).length, 0, '名字没改动就不该调接口');
    assert.equal(findByClass(row1, 'ai-people-rename-input'), null, '回车后输入框退场');
    assert.equal(nameOf(1).textContent, 'Alice');

    // Esc 取消 → 不落库且还原
    const esc = openEditor(1);
    esc.value = 'Carol';
    esc.listeners.keydown(keyEvent('Escape'));
    await flush();
    assert.equal(renameCalls(apiCalls).length, 0, 'Esc 取消不落库');
    assert.equal(nameOf(1).textContent, 'Alice', 'Esc 取消把名字还原');

    // 回车保存（前后空格要被 trim）
    const save = openEditor(1);
    save.value = '  Carol  ';
    save.listeners.keydown(keyEvent('Enter'));
    await flush();
    const calls = renameCalls(apiCalls);
    assert.equal(calls.length, 1, '回车触发一次改名');
    assert.deepEqual(
      calls[0].b,
      { personId: 1, name: 'Carol' },
      'payload 只带 personId + trim 后的名字',
    );
    assert.equal(nameOf(1).textContent, 'Carol', '行内文本立刻更新（乐观更新）');
    assert.equal(row1.classList.contains('is-renaming'), false, '改名结束清掉行标记');
    assert.equal(groups[0].name, 'Carol', '数据源同步更新，重画列表不会退回旧名');

    // 没名字的人也能起名
    assert.ok(deepText(rowOf(2)).includes('未命名人物'), '没名字的人显示「未命名人物」');
    const editor2 = openEditor(2);
    assert.equal(editor2.value, '', '未命名的人输入框是空的');
    editor2.value = '小明';
    editor2.listeners.keydown(keyEvent('Enter'));
    await flush();
    assert.equal(nameOf(2).textContent, '小明', '未命名的人改名后显示新名字');
    assert.deepEqual(renameCalls(apiCalls)[1].b, { personId: 2, name: '小明' });

    // 正在查看这个人时改名 → 顶部标签跟着走
    rowOf(1).listeners.click();
    await flush();
    const editor3 = openEditor(1);
    editor3.value = 'Zoe';
    editor3.listeners.keydown(keyEvent('Enter'));
    await flush();
    assert.equal(state.aiPeopleLabel, 'Zoe', '正在查看的人改名后，主区标签同步');

    // 改名后不再命中过滤词 → 该行应当从列表消失
    dom.peopleSearchInput.value = 'Zoe';
    dom.peopleSearchInput.listeners.input();
    assert.equal(dom.peopleList.children.length, 1, '过滤命中被改过名的那一行');
    const editor4 = openEditor(1);
    editor4.value = 'Nobody';
    editor4.listeners.keydown(keyEvent('Enter'));
    await flush();
    assert.ok(
      deepText(dom.peopleList).includes('没有匹配的人物'),
      '改名后不再命中过滤词，行从列表消失',
    );
    dom.peopleSearchInput.value = '';
    dom.peopleSearchInput.listeners.input();
    assert.equal(dom.peopleList.children.length, 2, '清空过滤词后两行都回来');
    views.stopPolling();
  }

  // ---- 写失败 → 回滚 + 提示，不能留一个「看起来改了其实没改」的名字 ----
  {
    const store = {};
    installRendererGlobals(store);
    const groups = [{ id: 1, name: 'Alice', photoCount: 3, thumbnail: '/a' }];
    const { views, dom, apiCalls } = buildAiViews({
      view: 'people',
      store,
      groups,
      renameFails: true,
    });
    views.enter('people');
    await views.load();
    await flush();
    const nameEl = findByClass(dom.peopleList, 'ai-people-name');
    nameEl.listeners.dblclick(pointerEvent());
    const editor = findByClass(dom.peopleList, 'ai-people-rename-input');
    editor.value = 'Carol';
    editor.listeners.keydown(keyEvent('Enter'));
    await flush();
    assert.equal(renameCalls(apiCalls).length, 1, '仍然尝试了一次改名');
    assert.equal(
      findByClass(dom.peopleList, 'ai-people-name').textContent,
      'Alice',
      '落库失败必须回滚到原名字',
    );
    assert.equal(groups[0].name, 'Alice', '数据源也回滚');
    assert.ok(
      String(dom.aiPeopleStatus.textContent || '').includes('FACE_PERSON_MISSING'),
      '侧栏给出失败提示',
    );
    views.stopPolling();
  }

  // ---- 索引进行中：实时条要同时给出「已扫描 / 检出人脸 / 人数」 ----
  // 只报「N 人」时，用户没法区分「在跑但没检出脸」和「在跑、正在冒出人物」。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'people',
      store,
      groups: [{ id: 1, name: 'Alice', photoCount: 2, thumbnail: '/t1' }],
      status: {
        ready: true,
        indexed: 3702,
        scanned: 12420,
        faces: 36,
        people: 1,
        busy: true,
        phase: 'indexing',
      },
    });
    views.enter('people');
    await views.load();
    await flush();
    assert.equal(dom.aiPeopleLive.hidden, false, '索引进行中实时读数可见');
    assert.equal(
      dom.aiPeopleLiveText.textContent,
      '正在识别人脸',
      '标题只留状态，数字不再拼进同一句',
    );
    // 断言拆到「格」这一级：以前整句一个 textContent，折行会把「检出」拆成「检 / 出」两半、
    // 还在行首留下孤零零的「·」；只对整句做子串匹配是抓不住这类坏形态的。
    const statCells = dom.aiPeopleLiveStats.children;
    assert.equal(statCells.length, 3, '三个指标各占一格（已扫描 / 检出人脸 / 人物）');
    const readStat = (i) => ({
      value: statCells[i].children[0].textContent,
      label: statCells[i].children[1].textContent,
      hidden: !!statCells[i].hidden,
    });
    assert.deepEqual(
      readStat(0),
      { value: '1.2万', label: '已扫描', hidden: false },
      '已扫描张数：大数压成万，数字在标签上方',
    );
    assert.deepEqual(
      readStat(1),
      { value: '36', label: '检出人脸', hidden: false },
      '已检出人脸数自成一格',
    );
    assert.deepEqual(
      readStat(2),
      { value: '1', label: '人物', hidden: false },
      '已识别人物数自成一格',
    );

    // 切界面语言后标签必须跟着变。setLocale 只认 data-i18n 属性、不会重跑这里，
    // 所以标签文字不能跟格子一起缓存 —— 缓存了就会一直停在旧语言那两个词上。
    global.document.documentElement.lang = 'en';
    await views.load();
    await flush();
    assert.equal(readStat(0).label, 'Scanned', '切英文后标签跟着变，不留在旧语言');
    assert.equal(readStat(1).label, 'Faces', '第二格同样跟着变');
    assert.equal(readStat(2).label, 'People', '第三格同样跟着变');
    assert.equal(readStat(0).value, '12k', '大数压法也按月语言切（1.2万 → 12k）');
    global.document.documentElement.lang = 'zh-CN';
    views.stopPolling();
  }

  // ---- 索引进行中但本轮不上报人脸数（老 worker）：那一格整格藏起来，不留占位符 ----
  // 显示「检出人脸 —」比不显示更容易让人以为出了错；三格是 grid-auto-flow，
  // 藏一格后剩下两格自动摊平，不会在右边空一块。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'people',
      store,
      groups: [{ id: 1, name: 'Alice', photoCount: 2, thumbnail: '/t1' }],
      status: { ready: true, indexed: 3702, scanned: 12420, busy: true, phase: 'indexing' },
    });
    views.enter('people');
    await views.load();
    await flush();
    const statCells = dom.aiPeopleLiveStats.children;
    assert.equal(statCells.length, 3, '格子本身仍然是三个');
    assert.equal(statCells[0].hidden, false, '已扫描仍然显示');
    assert.equal(statCells[1].hidden, true, '人脸数拿不到就整格藏起来，不显示「—」');
    assert.equal(dom.aiPeopleLiveText.textContent, '正在识别人脸', '标题不受影响');
    views.stopPolling();
  }

  // ---- 索引是上一代识别器建的：必须说出来，不能装成「还没建过」 ----
  // 换识别器后 VERSION 一变，库里那一代记录被 `s.version = ?` 全部挡掉，于是
  // faces / people / indexed 一起归零 —— 与「从没建过索引」在数字上**完全一样**。
  // 界面原先只会说「还没有建立索引」，用户看到的就是「人物索引全空了」；
  // 而库里的记录其实一条没少（本机实测 16155 条记录 / 3501 张脸仍在 faces.sqlite 里）。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'people',
      store,
      groups: [],
      status: {
        ready: true,
        busy: false,
        phase: 'complete',
        indexed: 0,
        faces: 0,
        people: 0,
        library: 1224615,
        recognizer: 'YuNet + InsightFace w600k_mbf (512-d) + Chinese Whispers',
        version: 'yunet2023-insightface-w600kmbf-align112-refine-v3',
        staleScans: 16155,
        staleVersions: [
          {
            version: 'yunet2023-sface2021-align112-v1',
            label: 'OpenCV SFace (128-d)',
            scans: 16155,
          },
        ],
      },
    });
    views.enter('people');
    await views.load();
    await flush();
    const notice = String(dom.aiPeopleStatus.textContent || '');
    assert.ok(notice.includes('OpenCV SFace'), '状态行要指明是上一代识别器建的（而不是只说 0 个人物）');
    assert.ok(notice.includes('重建'), '并给出唯一下一步：重建索引');
    assert.ok(
      notice.includes('不兼容'),
      '要把成因说出来 —— 只报「需要重建」用户不知道为什么要重建',
    );
    assert.equal(
      notice.includes('还没有建立索引'),
      false,
      '不得与「从没建过索引」混为一谈（那会让人以为是自己没点过）',
    );
    const empty = deepText(dom.peopleList);
    assert.ok(empty.includes('上一代识别器'), '人物列表的空态也要说清成因');
    assert.equal(empty.includes('还没有识别到人物'), false, '不得退回含糊的「还没有识别到人物」');
    views.stopPolling();
  }

  // ---- 索引进行中搜图：允许搜，但必须如实说明只覆盖已索引那部分 ----
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom, state } = buildAiViews({
      view: 'ai_search',
      store,
      status: { ready: true, indexed: 12000, busy: true, phase: 'indexing', people: 0 },
      searchHits: [{ id: 1, file_name: 'a.jpg' }],
      searchIndexed: 12000,
    });
    views.enter('ai_search');
    await views.load();
    await flush();
    const hero = deepText(dom.photoGrid);
    assert.ok(hero.includes('现在就能搜'), '索引进行中不拦搜图，引导页说明这点');
    dom.aiSearchInput.value = '猫';
    dom.aiSearchForm.listeners.submit({ preventDefault() {} });
    await flush();
    const status = String(dom.aiViewStatus.textContent || '');
    assert.ok(status.includes('1 张达到匹配阈值'), '索引进行中照样出结果');
    assert.ok(
      status.includes('仅基于已索引 1.2万 张'),
      '结果覆盖率如实说明，避免把「搜不到」误读成「没这张照片」',
    );
    assert.equal(state.aiSearchQuery, '猫');
    views.stopPolling();
  }

  // ---- 状态行的数字是「达标总数」，不是「返回条数」 ----
  // 阈值制下这两个数会分叉（内部为内存起见只保留最相近的一批，见 MAX_RESULTS）。
  // 文案必须跟着服务端给的 matched 走，否则用户看到的数字比卡片还少，像是丢图了。
  {
    const store = {};
    installRendererGlobals(store);
    const { views, dom } = buildAiViews({
      view: 'ai_search',
      store,
      searchHits: [{ id: 1, file_name: 'a.jpg' }],
      searchMatched: 1800,
    });
    views.enter('ai_search');
    await views.load();
    await flush();
    dom.aiSearchInput.value = '猫';
    dom.aiSearchForm.listeners.submit({ preventDefault() {} });
    await flush();
    const text = String(dom.aiViewStatus.textContent || '');
    assert.ok(text.includes('1800 张达到匹配阈值'), '状态行报的是达标总数（matched），不是卡片数');
    assert.equal(dom.photoGrid.children.length, 1, '卡片仍然只有服务端真返回的那一张');
    views.stopPolling();
  }
}

// ===========================================================================
// A3. 人物搜索 / 改名的静态契约
// ===========================================================================
function testPeopleSearchStaticContract() {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const iSide = html.indexOf('id="peopleSidebar"');
  const iSearch = html.indexOf('id="peopleSearchInput"');
  const iList = html.indexOf('id="peopleList"');
  assert.ok(iSide >= 0 && iSearch >= 0 && iList >= 0, '人物侧栏 / 搜索框 / 列表都存在');
  assert.ok(iSide < iSearch && iSearch < iList, '搜索框在人物侧栏之内、列表之前');
  assert.ok(
    /data-i18n-placeholder="ai\.peopleSearchPlaceholder"/.test(html),
    '搜索框占位文案走 i18n（切换语言要跟着变）',
  );

  const i18n = fs.readFileSync(path.join(ROOT, 'src/renderer/i18n.js'), 'utf8');
  assert.equal(
    (i18n.match(/'ai\.peopleSearchPlaceholder'/g) || []).length,
    2,
    '中英双语都补了搜索占位文案',
  );
  assert.equal((i18n.match(/'ai\.peopleSearchAria'/g) || []).length, 2, '中英双语都补了无障碍标签');

  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  assert.ok(app.includes("peopleSearchInput: $('#peopleSearchInput')"), 'dom 映射已接入人物搜索框');

  const ai = fs.readFileSync(path.join(ROOT, 'src/renderer/ai-views.js'), 'utf8');
  assert.ok(
    /row\.setAttribute\('role', 'button'\)/.test(ai) &&
      /row\.setAttribute\('tabindex', '0'\)/.test(ai),
    '人物行改成 div + role=button（button 里不允许嵌 input），键盘可达性用 tabindex 补回',
  );
  assert.ok(
    /nameEl\.addEventListener\('dblclick'/.test(ai),
    '改名入口是双击名字（不是悬停按钮 / 右键菜单）',
  );

  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/ai-views.css'), 'utf8');
  assert.ok(css.includes('.ai-people-rename-input'), '改名输入框有样式');
  assert.ok(
    /\.ai-people-item\s*\{[^}]*box-sizing:\s*border-box/.test(css),
    '人物行变成 div 后要显式 border-box，否则 padding 会把行撑出侧栏',
  );
}

// ===========================================================================
// A3b. 索引实时读数的静态契约
// ===========================================================================
// 坏形态是「胶囊 + 一整句」：侧栏一窄就折行，胶囊成了两头极圆的两行块，
// 折行处还会把「检出」拆成「检 / 出」两半（overflow-wrap: anywhere）。
// 这几条钉住「标题一行 + 数字各自成格」，别退回去。
function testPeopleLiveStatsStaticContract() {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const iLive = html.indexOf('id="aiPeopleLive"');
  const iText = html.indexOf('id="aiPeopleLiveText"');
  const iStats = html.indexOf('id="aiPeopleLiveStats"');
  assert.ok(iLive >= 0 && iText >= 0 && iStats >= 0, '实时读数容器 / 标题 / 数字栏都存在');
  assert.ok(iLive < iText && iText < iStats, '数字栏在标题之后（标题一行 + 下面一栏数字）');

  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  assert.ok(
    app.includes("aiPeopleLiveStats: $('#aiPeopleLiveStats')"),
    'dom 映射已接入实时读数数字栏',
  );

  const ai = fs.readFileSync(path.join(ROOT, 'src/renderer/ai-views.js'), 'utf8');
  assert.ok(/function syncLiveStats\(/.test(ai), '三格与数字都由 syncLiveStats 统一刷新');
  assert.ok(/function setLiveStat\(/.test(ai), '每轮只改数字（setLiveStat）');
  assert.ok(
    !/parts\.join\(' · '\)/.test(ai),
    '数字不许再拼成「· 」分隔的一整句 —— 折行会在行首留下孤零零的分隔符',
  );
  assert.ok(
    /el\('span', 'ai-people-live-label'\)/.test(ai),
    '标签格建的时候不带文字 —— 带了就等于把当时的语言冻在 DOM 里',
  );
  assert.ok(
    /ref\.label\.textContent\s*=\s*t\(/.test(ai),
    '标签文字每轮重写：切语言时 setLocale 不会重跑这里，缓存住就永远不跟着变',
  );

  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/ai-views.css'), 'utf8');
  const pill = /\.ai-people-live\s*\{[^}]*\}/.exec(css);
  assert.ok(pill, '有 .ai-people-live 样式');
  assert.ok(!/border-radius:\s*999px/.test(pill[0]), '.ai-people-live 不许退回胶囊（折行会变成两头极圆的块）');
  assert.ok(
    !/flex-wrap:\s*wrap/.test(pill[0]),
    '.ai-people-live 不许靠换行容纳长内容 —— 长的是数字栏，不是这一行',
  );
  const text = /\.ai-people-live-text\s*\{[^}]*\}/.exec(css);
  assert.ok(
    text && /text-overflow:\s*ellipsis/.test(text[0]),
    '标题行窄了要省略号收尾，不许折行',
  );
  assert.ok(
    !/\.ai-people-live-text\s*\{[^}]*overflow-wrap:\s*anywhere/.test(css),
    '标题行不许 overflow-wrap: anywhere —— 那正是把「检出」拆成「检 / 出」的原因',
  );
  const stats = /\.ai-people-live-stats\s*\{[^}]*\}/.exec(css);
  assert.ok(stats, '有数字栏样式');
  assert.ok(
    /grid-auto-flow:\s*column/.test(stats[0]) &&
      /grid-auto-columns:\s*minmax\(0,\s*1fr\)/.test(stats[0]),
    '数字栏用 grid-auto-flow: column —— 指标缺一格时剩下两格自动摊平，右边不空一块',
  );
  assert.ok(
    /\.ai-people-live-label\s*\{[^}]*white-space:\s*nowrap/.test(css),
    '标签不许折行（折了会把数字挤下去）',
  );
  assert.ok(
    /\.ai-people-live-stat\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    '指标缺数据时整格藏起来 —— 显示「—」比不显示更容易让人以为出了错',
  );
}

// ===========================================================================
// A4. 搜图预选词的静态契约
// ===========================================================================
function testSearchSuggestStaticContract() {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const iForm = html.indexOf('id="aiSearchForm"');
  const iSuggest = html.indexOf('id="aiSearchSuggest"');
  const iHistory = html.indexOf('id="aiSearchHistoryList"');
  assert.ok(iSuggest >= 0, '侧栏存在预选词容器 #aiSearchSuggest');
  assert.ok(
    iForm >= 0 && iForm < iSuggest && iSuggest < iHistory,
    '预选词必须夹在搜索框与搜索历史之间（「搜索框下方」）',
  );

  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  assert.ok(app.includes("aiSearchSuggest: $('#aiSearchSuggest')"), 'dom 映射已接入预选词容器');

  const ai = fs.readFileSync(path.join(ROOT, 'src/renderer/ai-views.js'), 'utf8');
  assert.ok(/function pickSuggestions\(/.test(ai), '抽词走 pickSuggestions（洗牌取样）');
  assert.ok(
    /suggestBatch = pickSuggestions\(SUGGEST_COUNT\)/.test(ai),
    '每次进入搜索页重抽一批（不是固定那 5 个）',
  );
  assert.ok(/data-ai-suggest/.test(ai), '预选词带 data-ai-suggest 标记，便于回归与命中统计');

  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/ai-views.css'), 'utf8');
  ['.ai-search-suggest', '.ai-search-suggest-head', '.ai-search-suggest-chips'].forEach((sel) => {
    assert.ok(css.includes(sel), '预选词样式缺失：' + sel);
  });
  assert.ok(
    /\.ai-search-suggest-chips \.ai-search-chip\s*\{[^}]*max-width:\s*100%/.test(css),
    '侧栏内预选词要限宽（否则长词会把侧栏撑破）',
  );
  // 加载态：取词要起 worker 载模型 + 打开索引 + 打分（冷启还要现算词表向量），
  // 这段等待必须有骨架，且骨架的底色不能挑错。
  assert.ok(
    /\.ai-search-suggest-chips \.ai-suggest-skeleton\s*\{[^}]*background:\s*var\(--bg-hover\)/.test(
      css,
    ),
    '骨架用 --bg-hover 打底：--bg-card 在浅色下是纯白（贴浅色玻璃侧栏看不见），' +
      '--text-muted 混色在深色下几乎与背景同色',
  );
  assert.ok(
    /\.ai-search-suggest-chips \.ai-suggest-skeleton::after/.test(css),
    '骨架要有扫光，否则静止灰块看不出「在加载」',
  );
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,300}ai-suggest-skeleton/.test(css),
    '系统开了「减少动态效果」时要停掉骨架动画（静态灰块同样能表达加载）',
  );
  assert.ok(
    /suggestState === 'pending'[\s\S]{0,200}renderSearchSuggestSkeleton\(host\)/.test(ai),
    '词池未就绪且正在取词时要走骨架态，而不是整块隐藏',
  );
}

// ===========================================================================
// B. 桌面端 app.js（vm 驱动真实源码）
// ===========================================================================
function stripInit(src) {
  return src.replace(/\n\s*init\(\);\s*$/, '\n');
}
function spy() {
  const fn = function (...args) {
    fn.calls.push(args);
  };
  fn.calls = [];
  fn.called = () => fn.calls.length > 0;
  return fn;
}
function loadDesktopApp() {
  const aiViews = {
    enter: spy(),
    leave: spy(),
    startPolling: spy(),
    bind() {},
    isShowing: () => false,
  };
  const tabsUi = {
    prepareBrowsingShell() {},
    applyCollectionView: spy(),
    applyDuplicatesView() {},
  };
  const win = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    RendererSidebarUI: {
      ensureNormalSidebarVisible() {},
      closeMobileSidebar() {},
      showSidebarOnDesktop() {},
      ensureDuplicateSidebarVisible: () => true,
    },
    RendererTabsUI: tabsUi,
    RendererTabsFlowUI: { handleTabBranch() {} },
    RendererAiViews: { init: () => aiViews },
    PhotoCompare: { mount: () => ({ show() {}, hide() {} }) },
    SemanticSearchUI: { mount: () => ({ show() {}, hide() {} }) },
    PeopleUI: { mount: () => ({ show() {}, hide() {} }) },
  };
  const ctx = {
    window: win,
    document: {
      documentElement: makeEl(),
      body: makeEl(),
      getElementById: () => makeEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      addEventListener() {},
    },
    localStorage: win.localStorage,
    requestAnimationFrame: (cb) => cb(),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval() {},
    clearTimeout() {},
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(stripInit(fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8')), ctx, {
    filename: 'renderer/app.js',
  });
  return { ctx, tabsUi, aiViews };
}

function testDesktopAppContract() {
  const { ctx, tabsUi } = loadDesktopApp();
  const state = ctx.state;

  // isFolderSidebarTab 仅 folders
  assert.equal(ctx.isFolderSidebarTab('folders'), true);
  for (const tab of ['search', 'people', 'dates', 'duplicates', 'settings']) {
    assert.equal(ctx.isFolderSidebarTab(tab), false, `${tab} 不应放宽为文件夹树侧栏`);
  }

  // gate('folders') 仅在 folders 存活
  for (const tab of ['search', 'people', 'dates', 'duplicates', 'settings']) {
    state.currentTab = tab;
    state.sidebarLockedMode = '';
    assert.equal(
      ctx.createSidebarRequestGate('folders', 'k-' + tab).isAlive(),
      false,
      `gate('folders') 在 ${tab} 页不得存活`,
    );
  }
  state.currentTab = 'folders';
  state.sidebarLockedMode = '';
  assert.equal(ctx.createSidebarRequestGate('folders', 'k-f').isAlive(), true);

  // showTabContent('search'|'people')：侧栏独占，不补拉文件夹树
  const htmlClass = ctx.document.documentElement.classList;
  for (const tab of ['search', 'people']) {
    state.currentTab = 'dates';
    state.sidebarLockedMode = '';
    htmlClass.remove('search-page-open');
    htmlClass.remove('people-page-open');
    let entered = null;
    ctx.aiViews = {
      enter: (view) => {
        entered = state.currentTab + ':' + view;
      },
      leave: spy(),
      startPolling: spy(),
      load: spy(),
      isShowing: () => false,
    };
    const lrf = spy();
    ctx.loadRootFolders = lrf;
    ctx.loadPhotos = spy();
    ctx.updateBrowsePathLabel = spy();
    tabsUi.applyCollectionView.calls = [];
    ctx.showTabContent(tab);
    assert.equal(entered, tab + ':' + (tab === 'search' ? 'ai_search' : 'people'));
    assert.equal(lrf.called(), false, `showTabContent('${tab}') 不得补拉文件夹树`);
    assert.equal(
      htmlClass.contains(tab === 'search' ? 'search-page-open' : 'people-page-open'),
      true,
      `${tab} 页应在 <html> 打上 page-open 类`,
    );
    assert.equal(tabsUi.applyCollectionView.called(), true, `${tab} 页主区工具栏应让位`);
  }

  // 「重复」页参照样板不受影响：仍走 handleTabBranch 的 duplicates 分支
  state.currentTab = 'folders';
  htmlClass.remove('people-page-open');
  htmlClass.remove('search-page-open');
  ctx.showTabContent('folders');
  assert.equal(
    htmlClass.contains('people-page-open') || htmlClass.contains('search-page-open'),
    false,
    '回「文件」页应清掉 page-open 类',
  );
}

// ===========================================================================
// C. 网页端静态契约
// ===========================================================================
function testWebContract() {
  const webApp = fs.readFileSync(path.join(ROOT, 'src/web/js/app.js'), 'utf8');
  assert.match(
    webApp,
    /function isFolderSidebarTab\(tab\)\s*\{\s*return tab === 'folders';/,
    '网页端 isFolderSidebarTab 同样收窄为仅 folders',
  );
  assert.match(webApp, /function showBrowseSidebar\(\)/);
  assert.match(webApp, /function showAiSidebar\(\)/);
  assert.ok(
    webApp.includes("setDisplay('#sidebarContent', 'none')") &&
      webApp.includes("setDisplay('#aiSidebar', '')"),
    '进入智能视图把侧栏让给 #aiSidebar',
  );
  const html = fs.readFileSync(path.join(ROOT, 'src/web/index.html'), 'utf8');
  assert.ok(html.includes('id="aiSidebar"'), '网页端存在 #aiSidebar');
}

// ===========================================================================
// D. 设置入口与优先级
// ===========================================================================
function testSettingsEntry() {
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  assert.ok(
    /getElementById\('peopleNavSettings'\)\.addEventListener\('click'/.test(app),
    '人物侧栏「识别设置与索引」入口已绑定点击',
  );
  assert.match(app, /async function openPeopleSettings\(\)[\s\S]*openSettingsPage\(\)/);
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.equal((html.match(/id="peopleNavSettings"/g) || []).length, 1);
  const iPeople = html.indexOf('id="peopleSidebar"');
  const iSettingsBtn = html.indexOf('id="peopleNavSettings"');
  const iList = html.indexOf('id="peopleList"');
  assert.ok(iPeople < iSettingsBtn && iSettingsBtn < iList, '设置入口在人物侧栏之内、列表之前');

  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/navigation.css'), 'utf8');
  // 设置页接管侧栏，同时排除搜图 / 人物页：三个 page-open 类本应互斥
  // （唯一写者 syncPageOpenClasses 按当前 tab 派生），这两个 :not 是兜底——
  // 历史上 settings-page-open 变成孤儿 class 时，会把设置导航永久压在
  // 搜图 / 人物侧栏上（「点搜图，残留设置分栏导航」）。选择器被 prettier
  // 折成多行，所以用宽松匹配而不是整串字面量。
  assert.ok(
    /html\.settings-page-open:not\(\.search-page-open\):not\(\.people-page-open\)[\s\S]{0,80}#settingsSidebar/.test(
      css,
    ),
    '设置页接管侧栏（且不与搜图 / 人物页抢，避免孤儿 class 永久压制）',
  );
  assert.ok(
    /html\.search-page-open:not\(\.settings-page-open\)/.test(css) &&
      /html\.people-page-open:not\(\.settings-page-open\)/.test(css),
    '搜图 / 人物让位规则均带 :not(.settings-page-open) 守卫，设置页优先级不被压掉',
  );
}

// ===========================================================================
// E. 残留引用清理
// ===========================================================================
function testNoDeadRefs() {
  const tokens = ['aiViewBack', 'peopleNavAll', 'aiSearchBox', 'aiBackBtn'];
  const dirs = ['src'];
  const hits = [];
  function scan(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        ['node_modules', '.git', 'release', 'out', 'dist', 'vendor', '.workbuddy'].includes(e.name)
      )
        continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (/\.(js|html|css)$/.test(e.name)) {
        const s = fs.readFileSync(p, 'utf8');
        for (const t of tokens) if (s.includes(t)) hits.push(`${t} @ ${path.relative(ROOT, p)}`);
      }
    }
  }
  dirs.forEach((d) => scan(path.join(ROOT, d)));
  assert.deepEqual(hits, [], '全仓（html/js/css）不应再引用 ' + tokens.join(' / '));
}

// ===========================================================================
// F. 导轨项 data-tab 序列 / 数量
// ===========================================================================
function testRailOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const start = html.indexOf('<nav class="app-rail');
  const rail = html.slice(start, html.indexOf('</nav>', start));
  const tabs = [];
  const re = /data-tab="([^"]+)"/g;
  let m;
  while ((m = re.exec(rail))) tabs.push(m[1]);
  assert.deepEqual(
    tabs,
    ['folders', 'dates', 'search', 'people', 'duplicates'],
    '导轨项 data-tab 序列 / 数量必须精确匹配（顺序被改错也要能抓到）',
  );
  assert.equal((rail.match(/class="rail-item/g) || []).length, 6, '导轨共 6 个 rail-item');
}

// ===========================================================================
async function main() {
  await testDesktopAiViews();
  await testDesktopSearchSuggest();
  await testMainHeroExamples();
  await testPeopleSearchAndRename();
  testPeopleSearchStaticContract();
  testPeopleLiveStatsStaticContract();
  testSearchSuggestStaticContract();
  testDesktopAppContract();
  testWebContract();
  testSettingsEntry();
  testNoDeadRefs();
  testRailOrder();
  console.log('[ai-sidebar-regression] PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
