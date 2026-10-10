'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
class Element {
  constructor(tab) {
    this.dataset = { tab };
    this.style = {};
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
}
// 夹具里的导航项。`tags`（标签导航页）在列：它是**浏览视图**，走的是通用 nav-tab 处理器
// ⇒ 必须和 folders / dates 一样，能从设置页返回、并且点一下就退出设置页。
const tabs = ['folders', 'dates', 'search', 'people', 'tags', 'duplicates'].map(
  (tab) => new Element(tab),
);
const elements = Object.fromEntries(
  ['sidebar', 'sidebarResizer', 'topbarSettingsBtn'].map((id) => [id, new Element()]),
);
global.document = {
  documentElement: new Element(),
  getElementById: (id) => elements[id],
  querySelectorAll: () => tabs,
  addEventListener() {},
};
global.window = {};
global.sessionStorage = { setItem() {} };
global.requestAnimationFrame = (callback) => callback();
require('../src/renderer/ui-events');
require('../src/renderer/settings');
async function run() {
  const state = { currentTab: 'people', rootFolders: [], isMobile: false };
  const dom = { contentArea: new Element(), settingsPage: new Element() };
  const sidebarUi = {
    showSidebarOnDesktop: (sidebar) => {
      sidebar.style.display = '';
    },
  };
  await global.window.RendererSettingsFlow.openSettingsPage({ state, dom, sidebarUi });
  assert.equal(state.tabBeforeSettings, 'people');
  assert.equal(elements.sidebar.style.display, '', 'settings keeps the context sidebar');
  assert.equal(dom.contentArea.style.display, 'none');
  let shown;
  const close = () =>
    global.window.RendererSettingsFlow.closeSettingsPage({
      state,
      dom,
      sidebarUi,
      onShowTabContent: (tab) => {
        shown = tab;
      },
    });
  close();
  assert.equal(shown, 'people', 'settings returns to the previous people page');
  // 左侧导航「搜图」是独立页面，也应能作为管理页的返回目标
  state.currentTab = 'search';
  await global.window.RendererSettingsFlow.openSettingsPage({ state, dom, sidebarUi });
  assert.equal(state.tabBeforeSettings, 'search', 'search page is a valid settings return target');
  close();
  assert.equal(shown, 'search', 'settings returns to the search page');
  global.window.RendererUIEvents.bindNavTabs({
    getState: () => state,
    onCloseSettingsPage: close,
    onShowTabContent: (tab) => {
      shown = tab;
    },
    onViewDuplicates: () => {
      state.currentTab = 'duplicates';
      shown = 'duplicates';
    },
  });
  for (const tab of tabs) {
    await global.window.RendererSettingsFlow.openSettingsPage({ state, dom, sidebarUi });
    tab.listeners.click();
    assert.equal(shown, tab.dataset.tab);
    assert.equal(dom.settingsPage.style.display, 'none', 'rail navigation exits settings');
    assert.equal(dom.contentArea.style.display, '');
  }
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const rail = html.slice(
    html.indexOf('<nav class="app-rail'),
    html.indexOf('</nav>', html.indexOf('<nav class="app-rail')),
  );
  // 搜图 / 人物与「重复」同级挂在图标导航栏上（2026-09-28 从文件夹侧栏迁回）。
  // 数「按钮 / 图标」用不依赖 HTML 换行的匹配（prettier 会把长标签折成多行，
  // 早先的 `/<button /`（带尾空格）在折行后恒为 0，属脆断言）。
  //
  // ⚠️ 结构断言**必须先剥掉 HTML 注释**：2026-10-05 加「首页」按钮时，解释「为什么它要带
  // `data-tab="home"`」的那段注释本身就把这个字面量写进了 rail 片段，`data-tab` 序列于是
  // 多出一项、数量断言全歪。注释里写类名/属性名是常态，这类计数不能拿原文当结构判据。
  const railCode = rail.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  // 2026-10-05：导轨多了第 7 项「首页」（`#topbarHomeBtn`，`.rail-home`）—— 它是一次
  // **页面跳转**，不是浏览视图，所以**不带 `.nav-tab`**（那是 `bindNavTabs` 批量挂 click 的标记）。
  // 2026-10-09：导轨多了第 8 项「标签」（`data-tab="tags"`）。它是**浏览视图**（左侧是标签树、
  // 右侧是照片网格，`currentView === 'tag'` 在 `BROWSABLE_VIEWS` 里），所以带 `.nav-tab`，
  // 并且落在「换内容看的维度」那一组（`people` 之后、第二条分隔线之前）。
  // ⚠️ 别把「与设置同属『页面』」顺手读成「位置也该挨着设置」：位置由下面那条序列断言管。
  assert.equal((railCode.match(/class="rail-item/g) || []).length, 8);
  assert.equal((railCode.match(/<svg/g) || []).length, 8);
  // 只数数量抓不到「顺序被改错」：再解析出每个 rail 项的 data-tab 序列逐位比对。
  // 「设置」项没有 data-tab（`syncNavigationRail` 里 `item.dataset.tab || 'settings'` 兜底），
  // 而「首页」**必须**带 `data-tab="home"` —— 否则它会落进那个 `|| 'settings'` 兜底，
  // 在设置页时被一起点亮（两个按钮同时高亮）。
  const railTabs = [];
  const tabRe = /data-tab="([^"]+)"/g;
  let tabMatch;
  while ((tabMatch = tabRe.exec(railCode))) railTabs.push(tabMatch[1]);
  assert.deepEqual(
    railTabs,
    ['home', 'folders', 'dates', 'search', 'people', 'tags', 'duplicates'],
    '导轨项 data-tab 序列 / 数量必须精确匹配',
  );
  // 🔴 「视图」与「页面跳转」的分界：只有那些浏览视图能带 `.nav-tab`
  // （`bindNavTabs` 按它批量挂 click），首页与设置都不行 —— 否则它们会被当成视图处理。
  const navTabTabs = (railCode.match(/class="rail-item nav-tab[^"]*"\s*\n?\s*data-tab="([^"]+)"/g) || []).length;
  assert.equal(navTabTabs, 6, '.nav-tab 只应挂在那 6 个浏览视图上');
  assert.ok(
    !/rail-home[^>]*nav-tab|nav-tab[^>]*rail-home/.test(railCode),
    '首页不是视图，不得带 .nav-tab',
  );
  assert.ok(railCode.includes('data-tab="search"'), '搜图在图标导航栏上');
  assert.ok(railCode.includes('data-tab="people"'), '人物在图标导航栏上');
  // 🔴 设置图标不得再退回「手写多边形」。旧 path 的 16 个顶点半径在 4.12~9.49 之间乱跳、
  // 按中心 180° 对位的顶点半径差最大 3.14（对称齿轮应为 0）⇒ 看着像一圈歪的尖刺。
  // 现用 lucide-static v0.544.0 的 `settings`（6 齿圆角齿轮 + 中心圆，ISC）。
  // 判据钉特征串而不是「像不像齿轮」—— 后者没法机械判定。
  assert.ok(
    /M9\.671 4\.136a2\.34 2\.34 0 0 1 4\.659 0/.test(railCode),
    '设置图标应为 lucide-static 的 settings（6 齿圆角齿轮）',
  );
  assert.ok(!/m9 3-1 3-3 1-2 3/.test(railCode), '那段手写走样的齿轮 path 不得再现');
  // 🔴 「首页」必须在 rail **最上**（2026-10-05 定案）。理由是布局机制而非审美：
  // `.rail-settings` 的 `margin-top: auto` 会独吞 rail 的剩余空间 ⇒ 设置永远贴底；
  // 而 flex column 的 auto top margin 只吸收**自己上方**的空间，所以放在「设置」前面
  // 并不会挨着设置 —— 实测首页 top=388 / 设置 top=721，中间 272px 空档，两头不靠。
  // 用「元素序列」一次钉住三段分组与两条分组线的位置（数量断言抓不到位置错）。
  const railSeq = [];
  const elRe = /<(button|div)\b([^>]*)>/g;
  let elMatch;
  while ((elMatch = elRe.exec(railCode)) !== null) {
    const attrs = elMatch[2];
    const cls = (/\bclass="([^"]+)"/.exec(attrs) || ['', ''])[1];
    const tab = (/\bdata-tab="([^"]+)"/.exec(attrs) || ['', ''])[1];
    if (/\brail-divider\b/.test(cls)) railSeq.push('divider');
    else if (/\brail-home\b/.test(cls)) railSeq.push('home');
    else if (/\brail-settings\b/.test(cls)) railSeq.push('settings');
    else if (tab) railSeq.push('view:' + tab);
  }
  assert.deepEqual(
    railSeq,
    [
      'home',
      'divider',
      'view:folders',
      'view:dates',
      'view:search',
      'view:people',
      'view:tags',
      'divider',
      'view:duplicates',
      'settings',
    ],
    'rail 三段结构必须精确：首页 ｜ 分组线 ｜ 视图 5 项 ｜ 分组线 ｜ 重复 + 设置',
  );
  // 同一类错位在设置页也存在过：导航项顺序（ui-settings.js 的 navItems）
  // 与区块的 DOM 顺序不一致，而设置页当时是「单页长滚动 + scrollIntoView」，
  // 结果是点靠前的导航项会跳过大半个页面、高亮项与滚动位置对不上。
  // 2026-09-28 起改成「两栏面板」：左栏导航按下即切换面板，同一时刻只有
  // 一个 [data-settings-panel] 是 is-active，长滚动随之消失；顺序错位的后果
  // 变成「高亮项与显示的面板对不上」。
  // 这里把两边都解析出来做逐位比对（解析而非硬编码期望值，增减面板不会假红）。
  const sectionIds = [];
  const sectionRe = /id="(settingsSection[A-Za-z]+)"/g;
  let sectionMatch;
  while ((sectionMatch = sectionRe.exec(html))) sectionIds.push(sectionMatch[1]);
  const settingsUiSrc = fs.readFileSync(
    path.join(__dirname, '../src/renderer/ui-settings.js'),
    'utf8',
  );
  const navIds = [];
  const navRe = /id: '(settingsSection[A-Za-z]+)'/g;
  let navMatch;
  while ((navMatch = navRe.exec(settingsUiSrc))) navIds.push(navMatch[1]);
  assert.equal(sectionIds.length, 8, '设置页应为 8 个面板');
  assert.equal(
    (html.match(/data-settings-panel/g) || []).length,
    sectionIds.length,
    '每个设置面板都要带 data-settings-panel（面板显隐靠它切换）',
  );
  assert.deepEqual(navIds, sectionIds, '设置页导航顺序必须与面板的 DOM 顺序逐位一致');
  // 索引配置的归属换过两次：先是「搜图 / 人物」两个独立类目，后来并入「后台任务」
  // （理由是索引与补图 / 查重同属一类长跑任务）。2026-10-05 第四次改版又拆了出来 ——
  // 「后台任务」只留纯任务，模型与识别参数独立成「AI 与索引」（配置不是任务）。
  // 这里守住「拆」这件事本身：两个挂载点必须真的落在该面板的 DOM 区间里，
  // 且不能在旧位置留残影。光靠上面的 sectionIds 数量断言守不住 —— 把挂载点挪回一个
  // 独立面板、同时把导航项也改回去，两边一起漂移就都不会假红；「面板区间」这种位置断言能抓住。
  const panelStarts = [];
  {
    const re = /data-settings-panel/g;
    let m;
    while ((m = re.exec(html))) panelStarts.push(m.index);
  }
  const blockOf = (name) => {
    const at = sectionIds.indexOf(name);
    if (at < 0) return '';
    return html.slice(
      panelStarts[at],
      at + 1 < panelStarts.length ? panelStarts[at + 1] : html.length,
    );
  };
  assert.ok(sectionIds.indexOf('settingsSectionAiIndex') >= 0, '「AI 与索引」面板应存在');
  const aiBlock = blockOf('settingsSectionAiIndex');
  assert.equal(
    (aiBlock.match(/id="settingsAiSearchMount"/g) || []).length,
    1,
    '搜图索引行必须挂在「AI 与索引」面板里',
  );
  assert.equal(
    (aiBlock.match(/id="settingsAiPeopleMount"/g) || []).length,
    1,
    '人物索引行必须挂在「AI 与索引」面板里',
  );
  const tasksAt = sectionIds.indexOf('settingsSectionTasks');
  assert.ok(tasksAt >= 0, '后台任务面板应存在');
  assert.equal(
    (blockOf('settingsSectionTasks').match(/id="settingsAi(?:Search|People)Mount"/g) || []).length,
    0,
    '「后台任务」面板里不应再残留索引挂载点（拆干净）',
  );
  assert.equal((html.match(/id="settingsSectionSearch"/g) || []).length, 0, '搜图不再是独立面板');
  assert.equal((html.match(/id="settingsSectionPeople"/g) || []).length, 0, '人物不再是独立面板');
  assert.ok(
    !/id: 'settingsSection(Search|People)'/.test(settingsUiSrc),
    '设置页导航不应再有搜图 / 人物两项',
  );
  assert.equal((html.match(/id="smartNav"/g) || []).length, 0, '文件夹侧栏不再挂视图入口');
  assert.equal((html.match(/id="topbarSettingsBtn"/g) || []).length, 1);
  assert.ok(
    html.indexOf('</nav>', html.indexOf('<nav class="app-rail')) < html.indexOf('id="sidebar"'),
  );
  // 智能视图与浏览视图共用同一个 #photoGrid，不再各建一套页面容器。
  assert.equal((html.match(/id="photoGrid"/g) || []).length, 1);
  assert.equal((html.match(/id="searchPage"/g) || []).length, 0);
  assert.equal((html.match(/id="peoplePage"/g) || []).length, 0);
  // 点侧栏的文件夹 / 日期也走各自入口、不经过 showTabContent：
  // 必须显式收回 AI 工具栏与导轨高亮，否则会留在搜图 / 人物视图的壳里。
  const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.match(appSrc, /function leaveAiViewForBrowse\(tab\)/);
  assert.ok(
    appSrc.includes("leaveAiViewForBrowse('folders')"),
    'viewFolder / viewAllPhotos 等入口要收回搜图 / 人物视图',
  );
  assert.ok(appSrc.includes("leaveAiViewForBrowse('dates')"));
  assert.match(appSrc, /aiViews\.isShowing\(\)/, 'loadPhotos 里要有兜底摘除');
  // 「点搜图，残留设置分栏导航」的根因守护：
  // settings-page-open 曾经只在 openSettingsPage 里 add、closeSettingsPage 里 remove，
  // 只要有一条路径改了 state.currentTab 而没走 closeSettingsPage（后台任务回调、
  // 启动落地、AI 视图退出），class 就成了孤儿；而 navigation.css 里
  // `html.settings-page-open #settingsSidebar { display: block !important }`
  // 优先级高于 `#settingsSidebar[hidden] { display: none !important }`，
  // 于是设置导航永久盖住搜图 / 人物侧栏。现在三个 page-open 类一律由
  // syncPageOpenClasses 从当前 tab 派生，且只在 syncNavigationRail 里调用一次。
  assert.match(appSrc, /function syncPageOpenClasses\(tab\)/, '页面态 class 要有单一派生函数');
  assert.ok(
    /function syncNavigationRail\(tab\)[\s\S]*?syncPageOpenClasses\(tab\);/.test(appSrc),
    'syncNavigationRail（所有切页路径的必经点）必须负责页面态 class 的对齐',
  );
  assert.ok(
    /classList\.toggle\('settings-page-open', tab === 'settings'\)/.test(appSrc),
    'settings-page-open 必须由 tab 派生',
  );
  assert.ok(
    /syncPageOpenClasses\(state\.currentTab\);[\s\S]{0,400}?dom\.settingsPage\.style\.display = 'none'/.test(
      appSrc,
    ),
    'openSettingsPage 等回来若页面已被切走，必须把设置页也收起来（只摘 class 会留半截界面）',
  );
  assert.equal(
    (appSrc.match(/classList\.(add|remove)\('settings-page-open'\)/g) || []).length,
    0,
    '不得再手写 settings-page-open 的增删（孤儿 class 会永久压制搜图 / 人物侧栏）',
  );
  const settingsSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.js'), 'utf8');
  assert.equal(
    (settingsSrc.match(/classList\.\w+\('settings-page-open'/g) || []).length,
    0,
    'settings.js 不得自己增删 settings-page-open（页面态 class 一律由 syncPageOpenClasses 派生）',
  );
  // prepareBrowsingShell 只隐藏 #settingsPage，历史上一度是「隐藏了页面却留下 class」的帮凶；
  // 它不该也不能自己维护页面态 class。
  //
  // ⚠️ 这里必须**剥掉注释**再数：这些断言问的是「有没有代码去增删页面态 class」，而注释里
  // 正常地会引用这些类名（2026-10-05 就因为在 ui-navigation.js 里写了句解释
  // 「首页显隐由 `html.home-page-open` 决定」而把条数从 0 数成 1，把守护打红）。
  // 拿原文当结构判据 = 注释写什么就红什么，属于假红/噪声。
  const stripJsComments = (src) => {
    let out = '';
    let i = 0;
    let st = null;
    while (i < src.length) {
      const c = src[i];
      if (st) {
        out += c;
        if (c === '\\') {
          out += src[i + 1] || '';
          i += 2;
          continue;
        }
        if (c === st) st = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        st = c;
        out += c;
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') {
          out += ' ';
          i++;
        }
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          out += src[i] === '\n' ? '\n' : ' ';
          i++;
        }
        out += '  ';
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };
  const uiNavSrc = fs.readFileSync(
    path.join(__dirname, '../src/renderer/ui-navigation.js'),
    'utf8',
  );
  const uiNavCode = stripJsComments(uiNavSrc);
  assert.equal(
    (uiNavCode.match(/page-open/g) || []).length,
    0,
    'prepareBrowsingShell 不得维护 page-open 类（页面可见性与页面态 class 不能各说各话）',
  );
  // 「启动落地把用户踢回浏览态」是上一轮那个 bug 的真正触发源：
  // applyStartupLandingPage 排在 init 的 `await loadRootFolders(true, true)` 之后（这台
  // 122 万照片 / 3.1 万目录的库上要十几秒），而 bindEvents() 已经先跑过、点击都绑好了。
  // 用户在这段等待里点进设置 / 搜图 / 人物 / 重复，落地若无条件 showTabContent('folders')
  // 就会当场覆盖掉用户的导航（旧实现还会因此留下 settings-page-open 孤儿 class）。
  // 所以落地必须先确认用户还没离开初始落点，再决定要不要 showTabContent。
  const landingSrc = appSrc.slice(
    appSrc.indexOf('function applyStartupLandingPage()'),
    appSrc.indexOf('function applyStartupLandingPage()') + 2400,
  );
  assert.match(
    landingSrc,
    /function applyStartupLandingPage\(\)[\s\S]{0,1600}?state\.currentTab !== 'folders'[\s\S]{0,400}?return;[\s\S]{0,900}?showTabContent\('folders'\)/,
    '启动落地要先判断用户是否已经导航过，否则会把用户从设置页 / 搜图踢回浏览态',
  );
  // CSS 兜底：即便 class 再次变成孤儿，也必须由搜图 / 人物侧栏赢。
  const navCss = fs.readFileSync(path.join(__dirname, '../src/renderer/navigation.css'), 'utf8');
  assert.ok(
    /html\.settings-page-open:not\(\.search-page-open\):not\(\.people-page-open\)/.test(navCss),
    '设置页接管侧栏的规则必须排除搜图 / 人物页，防止孤儿 class 永久压制',
  );
  console.log('[navigation-regression] PASS');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
