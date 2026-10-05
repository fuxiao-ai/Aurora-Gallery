'use strict';
/**
 * 「搜图 / 人物」侧栏独占改造 —— 回归。
 *
 * 背景：早先「搜图 / 人物」与「文件」共用同一套文件夹树侧栏（isFolderSidebarTab 放宽到
 * search/people，gate('folders') 在这两页存活）。本次改造把两者改成**侧栏独占**：
 *   - 搜图页侧栏 = #searchSidebar（搜索框 + 搜索历史）
 *   - 人物页侧栏 = #peopleSidebar（人物列表：头像 + 名字 + 张数）
 *   - 文件夹树在这两页让位（与「重复」页同构）
 * 因此本回归断言**新契约**：
 *   - isFolderSidebarTab 收窄为「仅 folders」；
 *   - gate('folders') 只在 folders 存活，dates/duplicates/settings 不被误放宽；
 *   - showTabContent('search'|'people') 不再补拉文件夹树，改为切侧栏 + 打 page-open 类；
 *   - HTML / CSS 结构上搜图 / 人物各自独占自己的侧栏容器。
 *
 * 用 vm 加载**真实源码**（去掉末尾 init() 引导）驱动真实函数，而不是只做文本 grep。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 通用 fake DOM
// ---------------------------------------------------------------------------
function makeEl(extra) {
  const classes = new Set();
  const el = {
    style: {},
    dataset: {},
    children: [],
    hidden: false,
    disabled: false,
    value: '',
    innerHTML: '',
    textContent: '',
    parentNode: null,
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      toggle: (n, on) =>
        on === undefined
          ? classes.has(n)
            ? classes.delete(n)
            : classes.add(n)
          : on
            ? classes.add(n)
            : classes.delete(n),
      contains: (n) => classes.has(n),
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    append() {},
    closest: () => null,
    remove() {},
    focus() {},
  };
  return Object.assign(el, extra || {});
}

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

// ---------------------------------------------------------------------------
// 桌面端：加载真实 src/renderer/app.js（去除 init 引导）
// ---------------------------------------------------------------------------
function loadDesktop() {
  const aiViews = {
    enter: spy(),
    leave: spy(),
    startPolling: spy(),
    bind() {},
    isShowing() {
      return false;
    },
  };
  const sidebarUi = {
    ensureNormalSidebarVisible() {},
    closeMobileSidebar() {},
    showSidebarOnDesktop() {},
    ensureDuplicateSidebarVisible() {
      return true;
    },
  };
  const tabsUi = {
    prepareBrowsingShell() {},
    applyCollectionView: spy(),
    applyDuplicatesView() {},
  };
  const tabsFlowUi = { handleTabBranch() {} };
  const win = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    RendererSidebarUI: sidebarUi,
    RendererTabsUI: tabsUi,
    RendererTabsFlowUI: tabsFlowUi,
    RendererAiViews: {
      init: () => aiViews,
    },
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
  const src = stripInit(fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8'));
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'renderer/app.js' });
  return { ctx, tabsUi };
}

function testDesktop() {
  const { ctx, tabsUi } = loadDesktop();
  const state = ctx.state;

  // --- 1. isFolderSidebarTab 收窄：仅 folders ---
  assert.equal(ctx.isFolderSidebarTab('folders'), true, 'folders 属文件夹树侧栏');
  for (const tab of ['search', 'people', 'dates', 'duplicates', 'settings']) {
    assert.equal(
      ctx.isFolderSidebarTab(tab),
      false,
      `${tab} 不应再被放宽为文件夹树侧栏（搜图 / 人物已改为侧栏独占）`,
    );
  }

  // --- 2. gate 判定表：view='folders' 只在 folders 存活 ---
  const folderGateExpected = {
    folders: true,
    search: false,
    people: false,
    dates: false,
    duplicates: false,
    settings: false,
  };
  for (const [tab, expected] of Object.entries(folderGateExpected)) {
    state.currentTab = tab;
    state.sidebarLockedMode = '';
    const gate = ctx.createSidebarRequestGate('folders', 'k-' + tab);
    assert.equal(
      gate.isAlive(),
      expected,
      `gate('folders') 在 currentTab=${tab} 时应为 ${expected}`,
    );
  }

  // --- 3. gate 语义未被误放宽：view='dates' 仅 dates 页签存活 ---
  for (const tab of ['folders', 'search', 'people', 'duplicates', 'settings']) {
    state.currentTab = tab;
    state.sidebarLockedMode = '';
    assert.equal(
      ctx.createSidebarRequestGate('dates', 'd-' + tab).isAlive(),
      false,
      `gate('dates') 在 currentTab=${tab} 时不得存活`,
    );
  }
  state.currentTab = 'dates';
  assert.equal(
    ctx.createSidebarRequestGate('dates', 'd-ok').isAlive(),
    true,
    'gate(dates) 在日期页签必须存活',
  );

  // --- 4. gate.render：仅 folders 页签真实写入侧栏 ---
  state.currentTab = 'folders';
  state.sidebarLockedMode = '';
  ctx.dom.sidebarContent = makeEl();
  const gate = ctx.createSidebarRequestGate('folders', 'render-folders');
  assert.equal(gate.render('<div class="tree-root">目录树</div>'), true);
  assert.ok(String(ctx.dom.sidebarContent.innerHTML).includes('目录树'));
  for (const tab of ['search', 'people']) {
    state.currentTab = tab;
    ctx.dom.sidebarContent = makeEl();
    const g2 = ctx.createSidebarRequestGate('folders', 'render-' + tab);
    assert.equal(
      g2.render('<div class="tree-root">目录树</div>'),
      false,
      `${tab} 下不再渲染文件夹树`,
    );
    assert.equal(
      String(ctx.dom.sidebarContent.innerHTML).includes('目录树'),
      false,
      `${tab} 侧栏是独占容器，文件夹树 HTML 不得落进 #sidebarContent`,
    );
  }

  // --- 5. 计数补丁只在 folders 生效 ---
  const countCases = [
    { tab: 'folders', patches: true },
    { tab: 'search', patches: false },
    { tab: 'people', patches: false },
    { tab: 'dates', patches: false },
    { tab: 'duplicates', patches: false },
  ];
  for (const cc of countCases) {
    state.currentTab = cc.tab;
    state.rootFoldersStatsPending = false;
    state.rootFolders = [];
    let queried = false;
    const el = makeEl({
      querySelector: () => {
        queried = true;
        return null;
      },
    });
    ctx.dom.sidebarContent = el;
    ctx.patchSidebarFolderTreeCountsFromState();
    assert.equal(
      queried,
      cc.patches,
      `${cc.tab} 下计数补丁${cc.patches ? '必须' : '不得'}触碰文件夹树侧栏`,
    );
  }

  // --- 6. updateSidebarActive 高亮路由：folders → 文件夹树；dates → 日期 ---
  const routeCases = [
    { tab: 'folders', folder: true },
    { tab: 'dates', folder: false },
    { tab: 'search', folder: false },
    { tab: 'people', folder: false },
  ];
  for (const rc of routeCases) {
    state.currentTab = rc.tab;
    const syncFolder = spy();
    const syncDate = spy();
    ctx.syncFolderSidebarHighlight = syncFolder;
    ctx.syncDateSidebarHighlight = syncDate;
    ctx.updateSidebarActive();
    if (rc.folder) {
      assert.equal(syncFolder.called(), true, `${rc.tab} 应触发文件夹树高亮`);
      assert.equal(syncDate.called(), false, `${rc.tab} 不得掉进 else 去套用日期高亮`);
    } else {
      assert.equal(syncFolder.called(), false, `${rc.tab} 不得走文件夹树高亮（已侧栏独占）`);
    }
  }

  // --- 7. showTabContent('search'|'people')：侧栏独占，不再补拉文件夹树 ---
  const htmlClass = ctx.document.documentElement.classList;
  for (const tab of ['search', 'people']) {
    state.currentTab = 'dates'; // 从日期切进来
    state.sidebarLockedMode = '';
    htmlClass.remove('search-page-open');
    htmlClass.remove('people-page-open');
    let tabAtEnter = null;
    ctx.aiViews = {
      enter: function (view) {
        tabAtEnter = state.currentTab + ':' + view;
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
    assert.equal(
      tabAtEnter,
      tab + ':' + (tab === 'search' ? 'ai_search' : 'people'),
      `showTabContent('${tab}') 必须进入对应视图壳`,
    );
    assert.equal(lrf.called(), false, `showTabContent('${tab}') 不得再补拉文件夹树`);
    assert.equal(
      htmlClass.contains(tab === 'search' ? 'search-page-open' : 'people-page-open'),
      true,
      `${tab} 页应在 <html> 打上 page-open 类以驱动侧栏让位`,
    );
    assert.equal(
      tabsUi.applyCollectionView.called(),
      true,
      `${tab} 页主区工具栏应整体让位（applyCollectionView）`,
    );
  }

  // --- 8. 切回「文件」时收回 page-open 类 ---
  state.currentTab = 'people';
  htmlClass.add('people-page-open');
  ctx.aiViews = {
    enter: spy(),
    leave: spy(),
    startPolling: spy(),
    load: spy(),
    isShowing: () => true,
  };
  ctx.loadRootFolders = spy();
  ctx.loadPhotos = spy();
  ctx.showTabContent('folders');
  assert.equal(
    htmlClass.contains('people-page-open'),
    false,
    '回「文件」页应清掉 people-page-open',
  );
  assert.equal(htmlClass.contains('search-page-open'), false);

  // --- 9. viewDuplicates 刻意保留的 folders 判定仍在（不得被放宽） ---
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  assert.ok(
    src.includes("if (state.currentTab === 'folders') saveBrowseTabMemory('folders');"),
    'viewDuplicates 里「保存哪个页签浏览记忆」的判定必须保持窄判定',
  );
  assert.ok(
    /function syncPageOpenClasses\(tab\)/.test(src),
    '存在 syncPageOpenClasses 按当前 tab 统一派生 page-open 类',
  );
  assert.ok(
    /classList\.toggle\('settings-page-open', tab === 'settings'\)/.test(src),
    'settings-page-open 也必须由 tab 派生，不允许再手写 add/remove',
  );
  assert.ok(
    !/getElementById\('peopleNavAll'\)/.test(src),
    'peopleNavAll 入口已随侧栏独占改造移除，不应再被脚本引用',
  );

  // --- 10. HTML 结构：搜图 / 人物各自独占侧栏容器 ---
  const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.ok(html.includes('id="searchSidebar"'), '存在搜图侧栏 #searchSidebar');
  assert.ok(html.includes('id="peopleSidebar"'), '存在人物侧栏 #peopleSidebar');
  assert.equal((html.match(/id="aiSearchForm"/g) || []).length, 1, 'aiSearchForm 只应存在一处');
  assert.equal((html.match(/id="aiSearchInput"/g) || []).length, 1, 'aiSearchInput 只应存在一处');
  assert.equal((html.match(/id="aiViewBack"/g) || []).length, 0, '返回键 DOM 已移除');
  assert.equal((html.match(/id="peopleNavAll"/g) || []).length, 0, '「全部人物」入口已移除');
  assert.ok(html.includes('id="peopleNavSettings"'), '保留「识别设置与索引」入口');
  assert.ok(html.includes('id="aiSearchHistoryList"'), '存在搜索历史列表容器');
  assert.ok(html.includes('id="aiPeopleStatus"'), '存在人物侧栏状态位');
  assert.ok(html.includes('id="peopleList"'), '存在人物列表容器');
  const iSearch = html.indexOf('id="searchSidebar"');
  const iForm = html.indexOf('id="aiSearchForm"');
  const iPeople = html.indexOf('id="peopleSidebar"');
  const iToolbar = html.indexOf('id="toolbar"');
  assert.ok(
    iSearch < iForm && iForm < iPeople,
    '搜索框必须落在 #searchSidebar 内（在 #peopleSidebar 之前）',
  );
  assert.ok(
    iForm < iToolbar && html.indexOf('id="aiViewStatus"') < iPeople,
    '搜索框 / 状态位必须搬进侧栏，不再留在主区工具栏',
  );

  // --- 11. CSS：三页口径一致（搜图 / 人物让位、设置优先级保留） ---
  const navCss = fs.readFileSync(path.join(ROOT, 'src/renderer/navigation.css'), 'utf8');
  assert.ok(
    /html\.search-page-open:not\(\.settings-page-open\)[^{]*#sidebar\s*>\s*\*/m.test(navCss),
    '搜图页应让位：隐藏 #sidebar 其余子元素',
  );
  assert.ok(
    /#sidebar\s*>\s*#searchSidebar/m.test(navCss) && /#sidebar\s*>\s*#peopleSidebar/m.test(navCss),
    '搜图 / 人物页应各自显示对应侧栏容器',
  );
  assert.ok(navCss.includes('.settings-page-open'), '设置页让位规则仍在（优先级最高）');
  assert.ok(
    /#searchSidebar\[hidden\]/.test(navCss) && /#peopleSidebar\[hidden\]/.test(navCss),
    '两个侧栏容器的 [hidden] 兜底规则应在',
  );

  console.log('[sidebar-tree-regression] desktop PASS');
}

// ---------------------------------------------------------------------------
// 网页端：加载真实 src/web/js/app.js（去除 init 引导）
// ---------------------------------------------------------------------------
function loadWeb() {
  const tabsById = {
    folders: makeEl({ dataset: { tab: 'folders' } }),
    dates: makeEl({ dataset: { tab: 'dates' } }),
    ai_search: makeEl({ dataset: { tab: 'ai_search' } }),
    people: makeEl({ dataset: { tab: 'people' } }),
  };
  const tabList = Object.values(tabsById);
  const sidebarContent = makeEl();
  const aiSidebar = makeEl();
  aiSidebar.style.display = 'none';

  const webAiViews = {
    enter: spy(),
    leave: spy(),
    bind() {},
    isShowing() {
      return false;
    },
  };
  const querySelector = (sel) => {
    sel = String(sel);
    if (sel === '#sidebarContent') return sidebarContent;
    if (sel === '#aiSidebar') return aiSidebar;
    const m = /\.sidebar-tab\[data-tab="([^"]+)"\]/.exec(sel);
    if (m) return tabsById[m[1]] || null;
    return null;
  };
  const querySelectorAll = (sel) => (String(sel) === '.sidebar-tab' ? tabList : []);

  const win = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'http://localhost/', search: '', hash: '', pathname: '/' },
    history: { replaceState() {}, pushState() {} },
    navigator: { userAgent: 'node' },
    WebTheme: { normalizeWebThemeStyle: (x) => x, applyWebThemeVariables() {} },
    WebAiViews: { init: () => webAiViews },
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
      querySelector,
      querySelectorAll,
      createElement: () => makeEl(),
      addEventListener() {},
      removeEventListener() {},
      cookie: '',
    },
    localStorage: win.localStorage,
    sessionStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (cb) => cb(),
    cancelAnimationFrame() {},
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval() {},
    clearTimeout() {},
    location: win.location,
    history: win.history,
    navigator: win.navigator,
    CSS: { escape: (s) => String(s) },
    console,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  const src = stripInit(fs.readFileSync(path.join(ROOT, 'src/web/js/app.js'), 'utf8'));
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'web/js/app.js' });
  return { ctx, tabsById, webAiViews, sidebarContent, aiSidebar };
}

async function testWeb() {
  const { ctx, tabsById, webAiViews, sidebarContent, aiSidebar } = loadWeb();
  const state = ctx.state;

  // --- 1. 白名单收窄：仅 folders ---
  assert.equal(ctx.isFolderSidebarTab('folders'), true);
  for (const tab of ['ai_search', 'people', 'dates']) {
    assert.equal(ctx.isFolderSidebarTab(tab), false, `网页端 ${tab} 不应再被放宽为文件夹树侧栏`);
  }

  // --- 2. enterWebAiView：侧栏独占，#sidebarContent 让位给 #aiSidebar ---
  for (const tab of ['ai_search', 'people']) {
    state.currentTab = 'dates';
    state.currentView = 'date';
    const lrf = spy();
    ctx.loadRootFolders = lrf;
    ctx.loadPhotos = spy();
    webAiViews.enter.calls = [];
    sidebarContent.style.display = '';
    aiSidebar.style.display = 'none';
    ctx.enterWebAiView(tab);
    assert.equal(lrf.called(), false, `enterWebAiView('${tab}') 不得再补拉文件夹树`);
    assert.equal(webAiViews.enter.called(), true, `应交给适配层渲染 ${tab} 侧栏`);
    assert.equal(String(sidebarContent.style.display), 'none', `${tab} 页应隐藏文件夹 / 日期列表`);
    assert.equal(String(aiSidebar.style.display), '', `${tab} 页应显示独占侧栏 #aiSidebar`);
    assert.equal(state.currentTab, tab, '页签高亮应指向智能视图');
    assert.equal(tabsById[tab].classList.contains('active'), true);
  }

  // --- 3. 反向路径：离开智能视图恢复 #sidebarContent ---
  state.currentTab = 'ai_search';
  state.currentView = 'ai_search';
  webAiViews.isShowing = () => true;
  webAiViews.leave = spy();
  sidebarContent.style.display = 'none';
  ctx.leaveWebAiViewForBrowse('folders');
  assert.equal(state.currentTab, 'folders', '反向路径应把页签收回 folders');
  assert.equal(state.currentView, 'all', '离开智能视图应把视图态收回浏览态');
  assert.equal(webAiViews.leave.called(), true, '应收回 AI 视图壳');
  assert.equal(String(sidebarContent.style.display), '', '恢复文件夹 / 日期列表');
  assert.equal(String(aiSidebar.style.display), 'none', '隐藏独占侧栏');
  assert.equal(tabsById.folders.classList.contains('active'), true);
  assert.equal(tabsById.ai_search.classList.contains('active'), false);

  // --- 4. switchTab('folders') 也恢复两态 ---
  ctx.loadRootFolders = spy();
  ctx.loadPhotos = spy();
  aiSidebar.style.display = '';
  ctx.switchTab('folders');
  assert.equal(String(sidebarContent.style.display), '', '切到文件夹页应显示 #sidebarContent');
  assert.equal(String(aiSidebar.style.display), 'none', '切到文件夹页应隐藏 #aiSidebar');

  // --- 5. 网页端 HTML：独占侧栏存在，顶栏大搜索框 / 返回键已移除 ---
  const html = fs.readFileSync(path.join(ROOT, 'src/web/index.html'), 'utf8');
  assert.ok(html.includes('id="aiSidebar"'), '网页端存在 #aiSidebar 独占容器');
  assert.equal((html.match(/id="aiSearchBox"/g) || []).length, 0, '顶栏 AI 搜索框已移除');
  assert.equal((html.match(/id="aiBackBtn"/g) || []).length, 0, '顶栏返回键已移除');
  assert.ok(
    html.indexOf('id="aiSidebar"') > html.indexOf('id="sidebarContent"'),
    '#aiSidebar 紧随 #sidebarContent 之后',
  );

  console.log('[sidebar-tree-regression] web PASS');
}

// ---------------------------------------------------------------------------
// 根行「两条渲染路径必须逐字符一致」（1980 行那个 bug 的守护）
//
// 背景（2026-10-04）：`sidebar-tree.js` 有两个产根行的函数 —— `renderFolderTree`（同步，
// 小库）与 `renderFolderTreeProgressive`（分根分帧，大库）。本轮改箭头时只改了前者，
// 于是**大库上真正生效的那条**留下两个毛病：
//   ① toggle 里还写着 `▼` 字形 → 与新的 CSS chevron 叠成「左侧两个图标」；
//   ② toggle 没有 `is-expanded` → 箭头方向与子层展开态相反。
// 教训：**同一个渲染结果有两条路径时，改一条必须改另一条**；只在砂盒里跑其中一条会漏。
// 所以这里直接对拍两条路径的产物，而不是只 grep 一句源码。
// ---------------------------------------------------------------------------
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function loadTreeModule() {
  const doc = {
    documentElement: makeEl(),
    body: makeEl(),
    getElementById: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    addEventListener() {},
  };
  const win = {
    document: doc,
    innerWidth: 1400,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => cb(),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const ctx = {
    window: win,
    document: doc,
    requestAnimationFrame: (cb) => cb(),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src/renderer/sidebar-tree.js'), 'utf8'),
    ctx,
    { filename: 'renderer/sidebar-tree.js' },
  );
  return win.RendererSidebarTree;
}

/** 用 gate 捕获渲染产物，返回**最后一个** chunk（渐进渲染是逐根累加的） */
function renderVia(api, fnName, options) {
  const chunks = [];
  const gate = {
    render(h) {
      chunks.push(h);
      return true;
    },
  };
  return Promise.resolve(api[fnName](Object.assign({}, options, { gate }))).then(
    () => chunks[chunks.length - 1] || '',
  );
}

// 注意锚 `data-root-id`：子层父行的 class 同样是 `folder-item tree-parent`，只按类匹配会把
// 子层父行一起算进来（实测 3 个根被数成 4 行）。根行独有 `data-root-id`。
const TREE_ROOT_ROW_RE = /<div class="folder-item tree-parent[^"]*" data-root-id="[\s\S]*?<\/div>/g;
// 根层的子容器独有 `id="treeChildren-<rootId>"`；子层的 `.tree-children` 由 renderTreeNodes 产出
// （两条路径共用同一个函数，天然一致），所以这里只对拍根层。
const TREE_CHILDREN_RE = /<div class="tree-children[^"]*" id="treeChildren-\d+"[^>]*>/g;

async function testRootRowParity() {
  const api = loadTreeModule();

  // --- 0. 静态：箭头只能来自 styles.css 的 ::before chevron，源码里不得再有字形 ---
  const treeSrc = stripComments(
    fs.readFileSync(path.join(ROOT, 'src/renderer/sidebar-tree.js'), 'utf8'),
  );
  const glyphs = treeSrc.match(/[▶▼►▸▾]/g) || [];
  assert.equal(
    glyphs.length,
    0,
    `sidebar-tree.js 不得再输出箭头字形（发现 ${JSON.stringify(glyphs)}）——` +
      ' 箭头由 styles.css 的 .tree-toggle::before 画，写字形会与它叠成「两个图标」',
  );

  const state = {
    currentTab: 'folders',
    currentView: 'all',
    currentPath: '',
    currentDate: '',
    searchQuery: '',
    rootFolders: [
      { id: 1, name: 'COS', path: 'K:\\COS', photo_count: 912252 },
      { id: 2, name: 'T', path: 'G:\\T', photo_count: 312362 },
      { id: 3, name: '空盘', path: 'X:\\Empty', photo_count: 0 },
    ],
  };
  const prefetchedByRootId = {
    1: [
      { folder_path: 'K:\\COS\\2024-云南行', photo_count: 300 },
      { folder_path: 'K:\\COS\\2024-云南行\\大理', photo_count: 120 },
      { folder_path: 'K:\\COS\\2024-云南行\\大理\\洱海', photo_count: 60 },
      { folder_path: 'K:\\COS\\视频素材', photo_count: 10 },
    ],
    2: [{ folder_path: 'G:\\T\\扫描件', photo_count: 5 }],
    3: [],
  };

  const options = { state, prefetchedByRootId };
  const syncHtml = await renderVia(api, 'renderFolderTree', options);
  const progHtml = await renderVia(api, 'renderFolderTreeProgressive', options);

  // --- 1. 夹具自证：确实渲染出了 3 个根行（2 有子目录 + 1 空根） ---
  const syncRows = syncHtml.match(TREE_ROOT_ROW_RE) || [];
  const progRows = progHtml.match(TREE_ROOT_ROW_RE) || [];
  assert.equal(syncRows.length, 3, '夹具自证：renderFolderTree 应产出 3 个根行');
  assert.equal(progRows.length, 3, '夹具自证：renderFolderTreeProgressive 应产出 3 个根行');

  // --- 2. 两条路径的根行必须逐字符相同 ---
  for (let i = 0; i < syncRows.length; i++) {
    assert.equal(
      progRows[i],
      syncRows[i],
      `第 ${i + 1} 个根行的标记两条路径必须逐字符相同 ——` +
        ' 不一致就是「只改了一条路径」（本轮我就是在渐进路径上漏了 is-expanded 与字形）',
    );
  }
  assert.deepEqual(
    progHtml.match(TREE_CHILDREN_RE) || [],
    syncHtml.match(TREE_CHILDREN_RE) || [],
    '根层 .tree-children 的类与内联 style 两条路径必须一致',
  );

  // --- 3. 每个根行只应有一个 toggle 槽 + 一个目录图标，且 toggle 里没有文本 ---
  const childrenTags = syncHtml.match(TREE_CHILDREN_RE) || [];
  for (let i = 0; i < syncRows.length; i++) {
    const row = syncRows[i];
    assert.equal(
      (row.match(/class="tree-toggle/g) || []).length,
      1,
      `第 ${i + 1} 个根行只应有一个 toggle 槽`,
    );
    assert.equal(
      (row.match(/<span class="icon">/g) || []).length,
      1,
      `第 ${i + 1} 个根行只应有一个目录图标（用户报的就是「左侧两个图标」）`,
    );
    // 用户报的症状：toggle 里既有字形又有 CSS chevron
    assert.equal(
      /tree-toggle[^>]*>[^<]/.test(row),
      false,
      `第 ${i + 1} 个根行的 toggle 里不得有文本内容（会与 CSS chevron 叠成两个箭头）`,
    );
  }

  // --- 4. toggle 的 is-expanded 必须与子层 expanded 一致（方向不能反） ---
  for (let i = 0; i < syncRows.length; i++) {
    const toggleExpanded = syncRows[i].includes('tree-toggle is-expanded');
    const childrenExpanded = /class="tree-children expanded"/.test(childrenTags[i] || '');
    assert.equal(
      toggleExpanded,
      childrenExpanded,
      `第 ${i + 1} 个根：toggle 的 is-expanded 必须与 .tree-children 的 expanded 一致`,
    );
  }

  // --- 5. 有子目录 → 展开箭头；无子目录 → 隐藏的空槽 ---
  assert.equal(syncRows[0].includes('is-expanded'), true, 'COS 有子目录，应为展开态');
  assert.equal(syncRows[1].includes('is-expanded'), true, 'T 有子目录，应为展开态');
  assert.equal(syncRows[2].includes('is-expanded'), false, '空盘无子目录，不应有 is-expanded');
  assert.ok(
    syncRows[2].includes('visibility:hidden') && syncRows[2].includes('aria-hidden="true"'),
    '无子目录的根：toggle 用隐藏空槽占位（保持 .name 对齐）',
  );

  console.log('[sidebar-tree-regression] 根行双路径一致 PASS');
}

// ---------------------------------------------------------------------------
// 「两端同口径」（2026-10-04）
//
// 背景：网页端原本是一套**完全独立**的目录树 —— 缩进 `16 + 16d`、箭头是 `▶/▼` 字形、
// 展开态靠 `.collapsed` 类；桌面端是 `12 + 14d`、CSS chevron、`expanded` + 行内 display。
// 两边看起来都在「画目录树」，但口径、类名、状态语义三处都不一样。
// 现在统一为：样式唯一来源 `src/web/css/gallery-design.css`（两端都加载），
// 状态契约也是同一套（关闭 = 无 `.expanded`；开关时类名 + 行内 display 双写）。
//
// 这个守护钉住四件事：
//   ① 树样式只有一个来源（styles.css / web/index.html 里不得再有树规则）；
//   ② 两端的缩进常量逐字段相等；
//   ③ 网页端不再出现箭头字形与 `.collapsed`；
//   ④ 网页端**真实渲染产物**的缩进 = 桌面端公式算出来的数（父行 / 叶子 / 导线），
//      且开关 toggle 真的会翻转容器与箭头状态。
// ---------------------------------------------------------------------------
function readIndentConsts(src, label) {
  const pick = (name) => {
    const m = new RegExp(name + '\\s*=\\s*(\\d+)').exec(src);
    assert.ok(m, `${label} 里找不到 ${name}`);
    return Number(m[1]);
  };
  return {
    base: pick('TREE_INDENT_BASE'),
    step: pick('TREE_INDENT_STEP'),
    slot: pick('TREE_TOGGLE_SLOT'),
    gap: pick('TREE_ROW_GAP'),
  };
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (n) => set.has(n),
    toggle: (n, on) => (on ? set.add(n) : set.delete(n)),
  };
}

// 行内缩进与路径（父行与叶子行的属性顺序相同，可直接按文档序抓）
const TREE_NODE_ROW_RE =
  /<div class="folder-item[^"]*" style="padding-left:(\d+)px;" data-folder-path="([^"]+)"/g;

function testWebParity() {
  const sharedCss = fs.readFileSync(path.join(ROOT, 'src/web/css/gallery-design.css'), 'utf8');
  const desktopCss = stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8'));
  const webHtml = stripComments(fs.readFileSync(path.join(ROOT, 'src/web/index.html'), 'utf8'));

  // --- 1. 样式唯一来源 ---
  for (const rule of [
    '.tree-toggle::before',
    '.tree-toggle.is-expanded::before',
    '.tree-children::before',
    '.tree-children:not(.expanded)',
    '.tree-root > .folder-item.tree-parent > .name',
  ]) {
    assert.ok(
      sharedCss.includes(rule),
      `共用的 gallery-design.css 里缺少树规则 ${rule} —— 树外观的唯一来源就是它`,
    );
  }
  // 只查「声明块」，别误伤 `.tree-root > .tree-parent:hover .sidebar-root-rescan`
  // 这类桌面端独有件的选择器（`.tree-root` 后面跟的是 ` >` 而不是 `,` / `{`）。
  const declRe = /\.tree-(toggle|children|root)\s*[,{]/;
  assert.equal(
    declRe.test(desktopCss),
    false,
    'styles.css 不得再声明树规则（唯一来源已迁到 gallery-design.css）',
  );
  assert.equal(
    declRe.test(webHtml),
    false,
    'web/index.html 不得再声明树规则（唯一来源已迁到 gallery-design.css）',
  );

  // --- 2. 两端缩进常量逐字段相等 ---
  const desktopConsts = readIndentConsts(
    fs.readFileSync(path.join(ROOT, 'src/renderer/sidebar-tree.js'), 'utf8'),
    'sidebar-tree.js',
  );
  const webSrc = fs.readFileSync(path.join(ROOT, 'src/web/js/app.js'), 'utf8');
  const webConsts = readIndentConsts(webSrc, 'web/js/app.js');
  assert.deepEqual(
    webConsts,
    desktopConsts,
    '网页端与桌面端的缩进常量必须逐字段相同（改一处必须同步另一处）',
  );

  // --- 3. 网页端不得再有箭头字形与 collapsed 态 ---
  const webGlyphs = stripComments(webSrc).match(/[▶▼►▸▾]/g) || [];
  assert.equal(
    webGlyphs.length,
    0,
    `web/js/app.js 不得再输出箭头字形（发现 ${JSON.stringify(webGlyphs)}）—— 箭头由共用样式表的 ::before 画`,
  );
  assert.equal(
    /tree-children collapsed/.test(webSrc),
    false,
    '网页端子层容器不得再用 `.collapsed` 类（统一为「无 `.expanded` 即关闭」）',
  );
  assert.equal(
    /['"]collapsed['"]/.test(stripComments(webSrc)),
    false,
    '网页端不得再读写 `.collapsed`（含 classList.contains/add/remove）',
  );

  // --- 4. 真实渲染产物：缩进 / 导线 / toggle 槽 ---
  const web = loadWeb();
  web.ctx.apiGet = () => Promise.resolve([]); // 别让 renderRootFoldersSidebarHtml 的去尾 loadAllFolderTrees 碰网络
  const ctx = web.ctx;
  const nodes = [
    {
      name: '2024-云南行',
      fullPath: 'K:\\COS\\2024-云南行',
      photoCount: 300,
      children: [
        {
          name: '大理',
          fullPath: 'K:\\COS\\2024-云南行\\大理',
          photoCount: 120,
          children: [
            { name: '洱海', fullPath: 'K:\\COS\\2024-云南行\\大理\\洱海', photoCount: 60, children: [] },
          ],
        },
        { name: '古城', fullPath: 'K:\\COS\\2024-云南行\\古城', photoCount: 0, children: [] },
      ],
    },
    { name: '视频素材', fullPath: 'K:\\COS\\视频素材', photoCount: 10, children: [] },
  ];
  const html = ctx.renderTreeNodes(nodes, 1);

  const rowRe = new RegExp(TREE_NODE_ROW_RE.source, 'g');
  // ⚠️ escapeAttr 会把 `\` 换成 `/`（网页端 URL/属性统一用正斜杠），所以 HTML 里的路径
  // 与夹具里的 Windows 路径不同形 —— 比较前统一归一化。
  const normKey = (p) => String(p).replace(/\\/g, '/');
  const padByPath = {};
  const rowByPath = {};
  let m;
  while ((m = rowRe.exec(html))) {
    padByPath[normKey(m[2])] = Number(m[1]);
    const rowStart = m.index;
    rowByPath[normKey(m[2])] = html.slice(rowStart, html.indexOf('</div>', rowStart));
  }
  assert.equal(
    Object.keys(padByPath).length,
    5,
    `夹具自证：应渲染出 5 个目录行，实际 ${Object.keys(padByPath).length}`,
  );

  const expectPad = (depth, isLeaf) =>
    isLeaf
      ? webConsts.base + depth * webConsts.step + webConsts.slot + webConsts.gap
      : webConsts.base + depth * webConsts.step;
  const cases = [
    ['K:\\COS\\2024-云南行', 1, false],
    ['K:\\COS\\2024-云南行\\大理', 2, false],
    ['K:\\COS\\2024-云南行\\大理\\洱海', 3, true],
    ['K:\\COS\\2024-云南行\\古城', 2, true],
    ['K:\\COS\\视频素材', 1, true],
  ];
  for (const [p, depth, isLeaf] of cases) {
    const want = expectPad(depth, isLeaf);
    assert.equal(
      padByPath[normKey(p)],
      want,
      `${p}（${isLeaf ? '叶子' : '父行'} depth=${depth}）缩进应为 ${want}px，实际 ${padByPath[normKey(p)]}px`,
    );
  }
  // 同级父子名字必须对齐：父行缩进 + 箭头槽 + 行 gap === 叶子缩进
  assert.equal(
    padByPath[normKey('K:\\COS\\视频素材')],
    padByPath[normKey('K:\\COS\\2024-云南行')] + webConsts.slot + webConsts.gap,
    '同级的叶子行与父行 `.name` 左缘必须对齐（叶子补满箭头槽 + 行 gap）',
  );

  // 导线画在父行箭头槽中心
  assert.ok(
    html.includes('--tree-guide-x:' + (webConsts.base + webConsts.step + 9) + 'px;'),
    '第一层子层的导线 x 应为 12 + 14 + 9 = 35px',
  );
  assert.ok(
    html.includes('--tree-guide-x:' + (webConsts.base + 2 * webConsts.step + 9) + 'px;'),
    '第二层子层的导线 x 应为 12 + 28 + 9 = 49px',
  );

  // toggle：父行恰好 1 个空槽，叶子行完全没有（靠缩进对齐，不再放隐藏的假箭头）
  // ⚠️ 数 `class="tree-toggle`，不能数 `tree-toggle` —— `data-tree-toggle="node"` 也含这个子串
  const parentRow = rowByPath[normKey('K:\\COS\\2024-云南行')];
  const leafRow = rowByPath[normKey('K:\\COS\\视频素材')];
  assert.equal(
    (parentRow.match(/class="tree-toggle/g) || []).length,
    1,
    '父行应恰好 1 个 toggle 槽',
  );
  assert.equal(
    /<span class="tree-toggle"[^>]*><\/span>/.test(parentRow),
    true,
    'toggle 必须是空元素（写字形会与 CSS chevron 叠成两个箭头）',
  );
  assert.equal(
    (leafRow.match(/class="tree-toggle/g) || []).length,
    0,
    '叶子行不应有 toggle 槽',
  );

  // --- 5. 根行（renderRootFoldersSidebarHtml）与桌面端同标记 ---
  ctx.state._rootFolders = [{ id: 1, name: 'COS', path: 'K:\\COS', photo_count: 912252 }];
  ctx.state.currentView = 'all';
  ctx.renderRootFoldersSidebarHtml();
  const sidebarHtml = String(web.sidebarContent.innerHTML || '');
  const rootRows = sidebarHtml.match(/<div class="folder-item tree-parent[^"]*" data-root-id="\d+"/g) || [];
  assert.equal(rootRows.length, 1, '夹具自证：应产出 1 个根行');
  assert.ok(
    /<span class="tree-toggle"[^>]*data-tree-toggle="root"[^>]*><\/span>/.test(sidebarHtml),
    '根行 toggle 必须是空槽（与桌面端一致）',
  );
  assert.equal(
    (sidebarHtml.match(/[▶▼►▸▾]/g) || []).length,
    0,
    '根行不得带箭头字形',
  );
  assert.ok(
    /<div class="tree-children" style="display:none;--tree-guide-x:21px;" id="treeChildren-1"><\/div>/.test(
      sidebarHtml,
    ),
    '根子容器初始必须是关闭态（无 expanded + display:none + 导线 21px）',
  );

  // --- 6. 开关契约：类名 + 行内 display 双写，箭头跟随 ---
  const children = { style: {}, classList: makeClassList(), offsetWidth: 0 };
  const toggle = { classList: makeClassList(), style: {} };
  ctx.setTreeChildrenOpen(children, toggle, true, false);
  assert.equal(children.style.display, 'block', '展开：容器 display 应变 block');
  assert.equal(children.classList.contains('expanded'), true, '展开：容器应带 expanded');
  assert.equal(toggle.classList.contains('is-expanded'), true, '展开：箭头应翻成展开态');
  ctx.setTreeChildrenOpen(children, toggle, false, false);
  assert.equal(children.style.display, 'none', '收起：容器 display 应变 none');
  assert.equal(children.classList.contains('expanded'), false, '收起：容器应摘掉 expanded');
  assert.equal(toggle.classList.contains('is-expanded'), false, '收起：箭头应回到收起态');

  // toggleTreeNode 必须按行内 display 判断（与桌面端同一判据）
  const fakeNode = { querySelector: (sel) => (String(sel).includes('tree-children') ? children : null) };
  const fakeToggle = { classList: makeClassList(), closest: () => fakeNode, style: {} };
  ctx.toggleTreeNode(fakeToggle, { stopPropagation() {} });
  assert.equal(children.style.display, 'block', '收起态点 toggle 应展开');
  assert.equal(fakeToggle.classList.contains('is-expanded'), true, '展开后箭头应为展开态');
  ctx.toggleTreeNode(fakeToggle, { stopPropagation() {} });
  assert.equal(children.style.display, 'none', '再点应收起');
  assert.equal(fakeToggle.classList.contains('is-expanded'), false, '收起后箭头应回收起态');

  console.log('[sidebar-tree-regression] 两端同口径 PASS');
}

async function main() {
  testDesktop();
  await testRootRowParity();
  testWebParity();
  await testWeb();
  console.log('[sidebar-tree-regression] PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
