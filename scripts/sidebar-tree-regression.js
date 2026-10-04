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

async function main() {
  testDesktop();
  await testWeb();
  console.log('[sidebar-tree-regression] PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
