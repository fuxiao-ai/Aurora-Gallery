'use strict';
/**
 * 首页（Home）契约回归：把「Home 是一页纯导航页」这条范围线钉死。
 *
 * 背景（2026-10-05）：启动页此前是 4 张静态特性卡，寄生在 `#photoGrid` 里，靠一次性标志
 * `suppressAutoLoadOnce` 存活 —— 那个标志写一次消费即 false，天生不支持「可反复进入」。
 * 本轮把它改造成独立页面 `#homePage`（照 `#settingsPage` 的模式），并把它**收缩为纯跳转入口**：
 * 不弹目录选择器、不扫描、不建索引、不发 IPC、不读数据库、不在首页渲染二维码。
 *
 * 这个脚本钉三类最容易静默坏掉的东西：
 *
 *   1. 🔴 **显隐的唯一写者**。`home-page-open` 必须只由 `syncPageOpenClasses` 从
 *      `state.currentTab` 派生。一旦有人在某条退出路径上补一句 `classList.remove('home-page-open')`，
 *      或反过来在 `openHomePage` 里 `add`，就会出现「设置页/浏览页被首页盖住」——
 *      表现是「点了没反应」，而所有静态断言都可能仍绿。
 *   2. 🔴 **判据不许用 `state.currentTab` 代替派生状态**。本项目 `currentTab` 以
 *      「不一定与界面对齐」著称（`showTabContent` 的 folders / dates 两支不写它）。
 *      `openHomePage` 的早退若用 `state.currentTab === 'home'`，从首页点「日期」后再点
 *      「首页」就会静默早退 —— 真踩过。
 *   3. 🔴 **卡片不是按钮**。「介绍与入口合体」成立的地基是：卡片本体没有指针样式、没有 hover 抬升，
 *      全页可点的只有原生 `<button>`。卡一旦像按钮，用户就会先白点几下。
 *
 * 另有一节专钉二维码（§5.4）：QR 编码最危险的失败是**静默错误** —— 形状对、结构对，
 * 但字符编码错 / 静区被压小 ⇒ 扫不出来或扫出乱码。所以这里既钉「载荷同源 / 不含密码」，
 * 也钉编码器的**结果级**行为（已知向量 + 模块数判别 UTF-8 + GIF 尺寸判别静区）。
 * 编码正确性的**独立**证据（用 jsQR 解码真实 GIF、与 npm qrcode 交叉比对）在
 * `.workbuddy/memory/CONTRACTS.md` 的「Home 页」一节，本脚本只冻结那次结论。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const APP = 'src/renderer/app.js';
const HTML = 'src/renderer/index.html';
const CSS = 'src/renderer/styles.css';
const SHELL = 'src/renderer/ui-shell.js';
const EVENTS = 'src/renderer/ui-events.js';
const SHORTCUTS = 'src/renderer/shortcuts.js';
const SETTINGS = 'src/renderer/settings.js';
const I18N = 'src/renderer/i18n.js';
const QR_ADAPTER = 'src/renderer/qr-code.js';
const QR_VENDOR = 'src/renderer/vendor/qrcode.js';
const RUN_REGRESSIONS = 'scripts/run-regressions.js';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

/**
 * 剥掉注释，但保持长度与换行 —— 这样「这行代码里有没有某个标识符」的断言不会被
 * 注释里提到的名字骗过去（本项目的注释里大量出现 `home-page-open` 这类字样）。
 *
 * ⚠️ 走 acorn（它自己懂注释与正则字面量的区别），失败才退回下面那个状态机版本。
 * 状态机版本**不认正则字面量**：源码里含引号的正则会让它从那里起错位，
 * 之后所有注释都剥不掉 —— 实测 `src/renderer/settings.js` 会残留 3 处块注释
 * （acorn 版残留 0），于是「注释里提到的名字」会被当成结构判据 ⇒ 假红或假绿。
 * 同一个坑仓库里已有先例，见 `dead-reference-regression.js:223` 的注释。
 * 降级不静默：下面有「夹具自证」断言把它报出来。
 */
function stripComments(src) {
  try {
    return blankCommentsAcorn(src);
  } catch (e) {
    stripCommentsDowngraded.push(String((e && e.message) || e));
    return stripCommentsFallback(src);
  }
}

/** 已发生降级的现场（为空 = 全部走 acorn）。由夹具自证断言兜住 */
const stripCommentsDowngraded = [];

function blankCommentsAcorn(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => {
      ranges.push([start, end]);
    },
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}

/** 状态机兜底版（语义与 dead-reference-regression.js 的那份一致）——只在 acorn 解析失败时用 */
function stripCommentsFallback(src) {
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
}

function countOf(hay, needle) {
  return hay.split(needle).length - 1;
}

/** 取两个标记之间的片段（含首标记）。找不到时返回空串，由「夹具自证」断言兜住 */
function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) return '';
  if (!to) return src.slice(a);
  const b = src.indexOf(to, a + from.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

const htmlRaw = read(HTML);
const cssRaw = read(CSS);
const appRaw = read(APP);
const shellRaw = read(SHELL);
const eventsRaw = read(EVENTS);
const shortcutsRaw = read(SHORTCUTS);
const settingsRaw = read(SETTINGS);
const i18nRaw = read(I18N);
const runSrc = read(RUN_REGRESSIONS);

const appCode = stripComments(appRaw);
// ⚠️ CSS 不能走 acorn（它不是 JS，`Unexpected token (1:0)`）：CSS 里只有 `/* */`
// 一种注释、也没有正则字面量，所以这里明确用状态机版，且不参与「有没有降级」的判定。
const cssCode = stripCommentsFallback(cssRaw);
const eventsCode = stripComments(eventsRaw);

// ── 夹具自证：剥注释这条路本身必须是可信的。这两条是「判据的判据」，别删。
check(
  '夹具自证：剥注释没降级到状态机兜底版（它不认正则字面量 ⇒ 之后所有注释都剥不掉）',
  stripCommentsDowngraded.length === 0,
  stripCommentsDowngraded.join(' | '),
);
check(
  '夹具自证：`settings.js` 剥完块注释后零 `*/` 残留（实测兜底版会残留 3 处，acorn 版残留 0）',
  (stripComments(settingsRaw).match(/\*\//g) || []).length === 0,
  String((stripComments(settingsRaw).match(/\*\//g) || []).length),
);

const htmlNoComments = htmlRaw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
const htmlCode = htmlNoComments;

// ══════════════════════════════════════════════ 1. 结构：#homePage 是独立页面

check('夹具自证：index.html 里取到 #homePage 的容器', /class="home-page"\s+id="homePage"/.test(htmlCode));

/**
 * 用「只跟踪 div/main/section 的标签栈」求某个 id 元素的祖先链。
 * 返回描述符数组（同时带 id 与 class）——⚠️ 只认 id 会漏掉 `.main-layout` 这类
 * **只有 class 没有 id** 的容器，于是「Home 住在 .main-layout 下」这条断言会
 * 因为祖先链被 filter 成空数组而恒为假（或反过来恒为真）。
 */
function ancestorsOfId(src, id) {
  const tagRe = /<(\/?)(div|main|section)\b([^>]*)>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const closing = m[1] === '/';
    const attrs = m[3] || '';
    if (closing) {
      stack.pop();
      continue;
    }
    const idM = /\bid="([^"]+)"/.exec(attrs);
    const clsM = /\bclass="([^"]+)"/.exec(attrs);
    if (idM && idM[1] === id) return stack;
    // self-closing 只看属性串末尾的 `/`。⚠️ 不能写成 `/\s*$/` ——
    // 那样「属性后带一个空格的普通开标签」（如 <div class="x" >）会被误判成自闭合，
    // 于是整棵祖先栈全被弹空，断言变成「祖先链是空数组」的假绿。
    if (!/\/\s*$/.test(attrs)) {
      stack.push({ id: idM ? idM[1] : '', cls: clsM ? clsM[1] : '' });
    }
  }
  return null;
}

const chainHas = (chain, token) =>
  Array.isArray(chain) && chain.some((a) => a.id === token || (a.cls || '').split(/\s+/).includes(token));
const chainKey = (chain) => (Array.isArray(chain) ? chain.map((a) => a.id + '|' + a.cls).join(' > ') : String(chain));

const homeAncestors = ancestorsOfId(htmlCode, 'homePage');
const gridAncestors = ancestorsOfId(htmlCode, 'photoGrid');
const settingsAncestors = ancestorsOfId(htmlCode, 'settingsPage');

check('夹具自证：解析出 #homePage 的祖先链', Array.isArray(homeAncestors) && homeAncestors.length > 0, chainKey(homeAncestors));
check('夹具自证：解析出 #photoGrid / #settingsPage 的祖先链', Array.isArray(gridAncestors) && Array.isArray(settingsAncestors), chainKey(gridAncestors) + ' / ' + chainKey(settingsAncestors));
check(
  '🔴 #homePage 不在 #photoGrid 内（Home 不寄生在网格里）',
  !chainHas(homeAncestors, 'photoGrid'),
  chainKey(homeAncestors),
);
check(
  '🔴 #homePage 不在 #contentArea 内（它住在 .main-layout 下、内容区之外）',
  !chainHas(homeAncestors, 'contentArea') && chainHas(homeAncestors, 'main-layout'),
  chainKey(homeAncestors),
);
check(
  '#homePage 与 #settingsPage 同族（祖先链逐位一致）—— 保证它是「一页」而不是「内容区里的一个分支」',
  chainKey(homeAncestors) === chainKey(settingsAncestors),
  chainKey(homeAncestors) + ' vs ' + chainKey(settingsAncestors),
);
check(
  '夹具自证：#photoGrid 的祖先链确实含 contentArea（证明上面的「不在内」不是解析失败导致的假绿）',
  chainHas(gridAncestors, 'contentArea'),
  chainKey(gridAncestors),
);

// 显隐：默认隐藏 + 派生 class 显示 + 让位
check('.home-page 默认 display:none（不靠 JS 写 inline style）', /\.home-page\s*\{[^}]*display:\s*none/.test(cssCode));
check('html.home-page-open .home-page 显示', /html\.home-page-open\s+\.home-page\s*\{[^}]*display:\s*block/.test(cssCode));
for (const sel of ['#contentArea', '#sidebar', '#sidebarResizer']) {
  check(
    '🔴 html.home-page-open 让位规则含 ' + sel + ' 且用 !important（胜过 JS 写的 inline style，退出时无需逐条改回）',
    (() => {
      // 选择器是多行逗号列表，不能要求 `{` 紧跟在这个选择器后面
      const re = /html\.home-page-open[^{}]*\{[^}]*\}/g;
      let m;
      while ((m = re.exec(cssCode)) !== null) {
        const rule = m[0];
        const head = rule.slice(0, rule.indexOf('{'));
        if (!new RegExp('html\\.home-page-open\\s+' + sel + '\\s*(,|$)').test(head.trim())) continue;
        if (/display:\s*none\s*!important/.test(rule)) return true;
      }
      return false;
    })(),
  );
}

// ══════════════════════════════════════════════ 2. 稳态化：一次性标志与旧欢迎页彻底退役

const srcFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      walk(p);
    } else if (/\.(js|html)$/.test(entry.name)) {
      srcFiles.push(p);
    }
  }
})(path.join(ROOT, 'src', 'renderer'));

/**
 * 在**剥掉注释**的源码里找标识符。
 * 必须剥注释：本轮把删除原因写进了注释（注释里会出现 `suppressAutoLoadOnce` 等字样），
 * 用原文搜会把「解释为什么删掉它」误判成「它又回来了」。
 * html 的注释同样要剥，而且要保持长度（只跟踪源码位置的断言依赖偏移量）。
 */
function strippedOf(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) return raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  return stripComments(raw);
}

const strippedByRel = new Map();
function grepAll(token) {
  const hits = [];
  for (const f of srcFiles) {
    if (!strippedByRel.has(f)) strippedByRel.set(f, strippedOf(f));
    if (strippedByRel.get(f).includes(token)) hits.push(path.relative(ROOT, f));
  }
  return hits;
}

const suppressHits = grepAll('suppressAutoLoadOnce');
check('🔴 `suppressAutoLoadOnce` 在渲染端零出现（一次性标志天生不支持可反复进入）', suppressHits.length === 0, suppressHits.join(', '));
const welcomeVisibleHits = grepAll('isWelcomeHomeVisible');
check('🔴 `isWelcomeHomeVisible()` 已退役、零出现', welcomeVisibleHits.length === 0, welcomeVisibleHits.join(', '));
check('静态欢迎页 #emptyState 已删除', !/id="emptyState"/.test(htmlCode));
check('旧欢迎页样式族（.feature-card）已删除', !/\.feature-card/.test(cssCode));
check('旧欢迎页词条（welcome.*）无孤儿', !/'welcome\./.test(i18nRaw), String(countOf(i18nRaw, "'welcome.")) + ' 条残留');

// ══════════════════════════════════════════════ 3. 派生 class 的唯一写者

const syncBody = sliceBetween(appCode, 'function syncPageOpenClasses(tab) {', '\n}');
check('夹具自证：取到了 syncPageOpenClasses 的函数体', syncBody.length > 0);
for (const cls of ['settings-page-open', 'search-page-open', 'people-page-open', 'home-page-open']) {
  check('syncPageOpenClasses 派生 ' + cls, syncBody.includes("'" + cls + "'"));
}
check("syncPageOpenClasses 按 tab 派生 home-page-open", /toggle\(\s*'home-page-open'\s*,\s*tab\s*===\s*'home'\s*\)/.test(syncBody));

{
  // `home-page-open` 在渲染端 JS 里**只应有两处**：syncPageOpenClasses 里的那一次派生写，
  // 以及 openHomePage 的早退读（classList.contains）。多出任何一处就意味着出现了第二个写者
  // —— 那正是「首页永久盖住侧栏 / 点了没反应」的根源。
  const sites = [];
  for (const rel of [APP, 'src/renderer/settings.js', 'src/renderer/ui-navigation.js', 'src/renderer/ui-shell.js', 'src/renderer/ui-events.js', 'src/renderer/ui-grid.js', 'src/renderer/qr-code.js']) {
    const code = stripComments(read(rel));
    const re = /home-page-open/g;
    let m;
    while ((m = re.exec(code)) !== null) sites.push({ rel, index: m.index, ctx: code.slice(Math.max(0, m.index - 60), m.index + 40) });
  }
  check(
    '🔴 `home-page-open` 在渲染端 JS 里只出现 2 处（派生写 + 早退读），没有第二个写者',
    sites.length === 2 && sites.every((s) => s.rel === APP),
    sites.map((s) => s.rel + '@' + s.index).join(', '),
  );
  check(
    '🔴 一处是 syncPageOpenClasses 的派生写',
    sites.some((s) => /classList\.toggle\('home-page-open'/.test(s.ctx)),
    sites.map((s) => s.ctx.replace(/\s+/g, ' ')).join(' || '),
  );
  check(
    '🔴 另一处是 openHomePage 的早退读（classList.contains）',
    sites.some((s) => /classList\.contains\('home-page-open'\)/.test(s.ctx)),
    sites.map((s) => s.ctx.replace(/\s+/g, ' ')).join(' || '),
  );
  const allJs = [APP, 'src/renderer/settings.js', 'src/renderer/ui-navigation.js', 'src/renderer/ui-shell.js', 'src/renderer/ui-events.js']
    .map((rel) => stripComments(read(rel)))
    .join('\n');
  check(
    '🔴 全渲染端没有任何 classList.add/remove(\'home-page-open\')（退出路径不许各自摘 class）',
    !/classList\.(add|remove)\(\s*'home-page-open'/.test(allJs),
  );
  const homeOpenBody = sliceBetween(appCode, 'function openHomePage() {', '\n}');
  check('🔴 openHomePage 里没有 classList.add/remove/toggle（显隐全交给派生）', !/classList\.(add|remove|toggle)/.test(homeOpenBody));
  check('🔴 openHomePage 不写任何 style.*（不碰 DOM 显隐）', !/\.style\./.test(homeOpenBody));
}

// ══════════════════════════════════════════════ 4. 导航与判据

const homeOpen = sliceBetween(appCode, 'function openHomePage() {', '\n}');
check('夹具自证：取到了 openHomePage 的函数体', homeOpen.length > 0);
check(
  '🔴 openHomePage 的早退判据用派生状态（html.home-page-open），不用 state.currentTab',
  homeOpen.includes("document.documentElement.classList.contains('home-page-open')") &&
    !/if\s*\(\s*state\.currentTab\s*===\s*'home'\s*\)\s*return/.test(homeOpen),
);
check('openHomePage 会先走完整设置页退出流程（从设置页过来不留半截界面）', homeOpen.includes("if (state.currentTab === 'settings') closeSettingsPage()"));
check('openHomePage 记住来处（state.tabBeforeHome）', /state\.tabBeforeHome\s*=\s*normalizeBrowseTab\(state\.currentTab\)/.test(homeOpen));
check('openHomePage 最终走 syncNavigationRail(\'home\')', homeOpen.includes("syncNavigationRail('home')"));
check('state.tabBeforeHome 的赋值带浏览 tab 白名单（normalizeBrowseTab）', /function normalizeBrowseTab\(tab\) \{/.test(appCode));
for (const t of ['folders', 'dates', 'duplicates', 'people', 'search']) {
  check("normalizeBrowseTab 白名单含 '" + t + "'", sliceBetween(appCode, 'function normalizeBrowseTab(tab) {', '\n}').includes("'" + t + "'"));
}
check(
  "🔴 normalizeBrowseTab 对白名单外的值回落 'folders'（不用它当索引直接回灌）",
  /return\s+tab\s*===\s*'folders'\s*\|\|[\s\S]{0,260}?:\s*'folders';/.test(sliceBetween(appCode, 'function normalizeBrowseTab(tab) {', '\n}')),
);

check('顶栏首页按钮存在', /id="topbarHomeBtn"/.test(htmlCode));
{
  const tag = (/<button[^>]*id="topbarHomeBtn"[^>]*>/.exec(htmlCode) || [''])[0];
  check('夹具自证：取到了 #topbarHomeBtn 的标签', tag.length > 0);
  check("🔴 #topbarHomeBtn 带 data-tab=\"home\"（否则 syncNavigationRail 的默认值会让它在设置页也点亮）", /\bdata-tab="home"/.test(tag));
  check('🔴 #topbarHomeBtn 不带 .nav-tab（它不是视图，不进 bindNavTabs）', !/\bnav-tab\b/.test(tag));
}
check('顶栏按钮经 bindShellInlineActions 接线', /bindClick\('topbarHomeBtn',\s*options\.onOpenHomePage\)/.test(eventsCode));
check(
  '🔴 键盘通道 nav.home 与按钮调同一个 onOpenHomePage',
  /sr\.matches\('nav\.home',\s*e\)[\s\S]{0,200}?onOpenHomePage/.test(eventsCode),
);
check('快捷键注册表新增 nav.home 动作', /id:\s*'nav\.home'/.test(shortcutsRaw));
check("nav.home 默认键为 Alt+Home", /id:\s*'nav\.home'[\s\S]{0,200}?def:\s*\[[^\]]*'Alt\+Home'/.test(shortcutsRaw));
check("nav.home 有中英文案键", /id:\s*'nav\.home'[\s\S]{0,260}?key:\s*'shortcut\.action\.navHome'/.test(shortcutsRaw));
check('app.js 把 openHomePage 接进内联动作', /onOpenHomePage:\s*function\s*\(\)\s*\{\s*void openHomePage\(\)/.test(appCode));
check(
  '🔴 顶栏按钮与快捷键两条通道都接到同一个 openHomePage（找不到第二份跳转逻辑）',
  countOf(appCode, 'onOpenHomePage: function ()') === 2 && countOf(appCode, 'void openHomePage()') === 3,
  'onOpenHomePage=' + countOf(appCode, 'onOpenHomePage: function ()') + ', void openHomePage()=' + countOf(appCode, 'void openHomePage()'),
);
check('启动落地 welcome 档改走 openHomePage（不再预设 currentView / currentPath）', (() => {
  const i = appCode.indexOf('function applyStartupLandingPage');
  if (i < 0) return false;
  const body = appCode.slice(i, i + 1600);
  return /launchDefaultPage\s*===\s*'welcome'[\s\S]{0,400}?void openHomePage\(\)/.test(body);
})());
check('启动落地不再写 suppressAutoLoadOnce（唯一写入点已随 Home 落地删除）', !appCode.includes('suppressAutoLoadOnce'));

check("🔴 从首页点「日期」这类分支里必须显式写 state.currentTab（showTabContent 的 folders/dates 两支不写它）", (() => {
  const g = sliceBetween(appCode, 'function handleHomeGoto(spec) {', '\nfunction bindHomePageActions');
  return /state\.currentTab\s*=\s*arg\s*;[\s\S]{0,200}?showTabContent\(arg\)/.test(g);
})());
check(
  "🔴 leaveAiViewForBrowse 的判据在 Home 在场时必须放行（否则首页遮住刚加载的照片流）",
  /function leaveAiViewForBrowse[\s\S]{0,600}?state\.currentTab\s*!==\s*'home'/.test(appCode),
);
check("updateSidebarActive 在 home 档早退（首页无侧栏，别去点亮侧栏行）", (() => {
  const b = sliceBetween(appCode, 'function updateSidebarActive(', '\n}');
  return /state\.currentTab\s*===\s*'home'[\s\S]{0,80}?return/.test(b);
})());
check(
  "captureBrowseLocation 在 home 档返回 null（首页不是浏览位置，不进导航历史）",
  (() => {
    const b = sliceBetween(appCode, 'function captureBrowseLocation(', '\n}');
    return /state\.currentTab\s*===\s*'home'[\s\S]{0,80}?return null/.test(b);
  })(),
);
check(
  "设置页返回路径认得 home（从首页进设置页，返回应回首页）",
  /cur\s*===\s*'home'/.test(settingsRaw) && /restoreTab\s*!==\s*'home'/.test(settingsRaw),
);
check(
  'closeSettingsPage 的 onShowTabContent 分流含 home 分支',
  /t\s*===\s*'home'[\s\S]{0,120}?syncNavigationRail\('home'\)/.test(appCode),
);

// ══════════════════════════════════════════════ 5. 入口接线（10 个节点 → 10 个落点）

const gotoRe = /data-home-goto="([^"]+)"/g;
const gotoList = [];
{
  let m;
  while ((m = gotoRe.exec(htmlCode)) !== null) gotoList.push(m[1]);
}
check('夹具自证：找得到 data-home-goto 节点', gotoList.length > 0, String(gotoList.length));
check('🔴 可点节点共 10 个（视图 2 + 带筛选的视图 1 + 标签页 3 + 设置面板 4）', gotoList.length === 10, JSON.stringify(gotoList));
check(
  '🔴 10 个落点两两不同（防「两个文案指向同一处」）',
  new Set(gotoList).size === gotoList.length,
  JSON.stringify(gotoList),
);
check(
  '🔴 「只看视频」带 mediaFilter（不带就和「所有照片」同落点）',
  gotoList.includes('view:all:video') && (() => {
    const g = sliceBetween(appCode, 'function handleHomeGoto(spec) {', '\nfunction bindHomePageActions');
    return /parts\[2\]\s*===\s*'video'/.test(g) && /state\.mediaFilter\s*=\s*'video'/.test(g) && /dom\.mediaFilterSelect\.value\s*=\s*'video'/.test(g);
  })(),
);

// 每个 data-home-goto 节点必须是原生 <button>，且 handler 支持它的前缀
for (const prefix of ['view', 'tab', 'panel']) {
  check(
    "handleHomeGoto 支持 '" + prefix + "' 前缀",
    sliceBetween(appCode, 'function handleHomeGoto(spec) {', '\nfunction bindHomePageActions').includes("kind === '" + prefix + "'"),
  );
}
{
  // 逐个节点回看它的开标签：必须是 <button type="button">
  const badButtons = [];
  for (const spec of gotoList) {
    const i = htmlCode.indexOf('data-home-goto="' + spec + '"');
    const before = htmlCode.slice(Math.max(0, i - 400), i);
    const openTag = before.lastIndexOf('<button');
    const lastLt = before.lastIndexOf('<');
    if (openTag < 0 || openTag !== lastLt) badButtons.push(spec);
    else {
      const tag = before.slice(openTag) + '>';
      if (!/type="button"/.test(tag)) badButtons.push(spec + '(无 type=button)');
      if (/<div/.test(tag)) badButtons.push(spec + '(被 div 包住)');
    }
  }
  check('🔴 每个可点节点都是原生 <button type="button">（键鼠天然双可达）', badButtons.length === 0, badButtons.join(', '));
}
check('🔴 入口的 click 与 keydown 分支调同一个 activate()（键鼠同一路径）', (() => {
  const b = sliceBetween(appCode, 'function bindHomePageActions() {', '\n}');
  return (
    countOf(b, 'activate(') >= 3 &&
    /addEventListener\('click'[\s\S]{0,200}?activate\(/.test(b) &&
    /addEventListener\('keydown'[\s\S]{0,300}?activate\(/.test(b)
  );
})());
check(
  "🔴 keydown 分支放行 Enter / 空格（键盘可达），且两条通道都 preventDefault（Enter 默认动作会合成 click，不拦会跳两次）",
  (() => {
    const b = sliceBetween(appCode, 'function bindHomePageActions() {', '\n}');
    return /e\.key\s*!==\s*'Enter'/.test(b) && countOf(b, 'preventDefault()') >= 2;
  })(),
);
check('入口节点在 #homePage 内部（绑定走容器委托，不给每个 chip 单独挂 listener）', htmlCode.indexOf('data-home-goto="view:all"') > htmlCode.indexOf('id="homePage"'));
check('bindHomePageActions 被 bindEvents 调用一次', countOf(appCode, 'bindHomePageActions()') === 2, String(countOf(appCode, 'bindHomePageActions()')));

// ══════════════════════════════════════════════ 6. 卡片是介绍，不是按钮

function homeCards() {
  const start = htmlCode.indexOf('<div class="home-feature-row"');
  const end = htmlCode.indexOf('settings-page', start);
  const region = htmlCode.slice(start, end > start ? end : undefined);
  const parts = region.split('<div class="home-feature">').slice(1);
  return parts.map((p) => {
    const close = p.indexOf('<div class="home-feature-row"');
    return close >= 0 ? p.slice(0, close) : p;
  });
}
const cards = homeCards();
check('夹具自证：切出了 4 段能力卡', cards.length === 4, String(cards.length));
check('🔴 卡片数 = 4', cards.length === 4, String(cards.length));
check('🔴 「维护与清理」不再出现（本轮明确删除）', !/维护与清理/.test(htmlRaw) && !/'home\.grp\.maint/.test(i18nRaw));

const cardGroups = cards.map((c) => {
  const m = /data-i18n="home\.grp\.([a-z]+)\.title"/.exec(c);
  return m ? m[1] : null;
});
check('夹具自证：每张卡都能取到 home.grp.<id>.title 的 id', cardGroups.every(Boolean), JSON.stringify(cardGroups));
check('四张卡的 id 依次为 browse / search / large / personal', JSON.stringify(cardGroups) === JSON.stringify(['browse', 'search', 'large', 'personal']), JSON.stringify(cardGroups));

const cardGotos = cards.map((c) => {
  const out = [];
  const re = /data-home-goto="([^"]+)"/g;
  let m;
  while ((m = re.exec(c)) !== null) out.push(m[1]);
  return out;
});
check('🔴 每张卡都有 1 个以上卡内入口（「介绍与入口合体」）', cardGotos.every((g) => g.length > 0), JSON.stringify(cardGotos));
check('卡内入口合计 9 个（主按钮占掉第 10 个节点）', cardGotos.reduce((a, g) => a + g.length, 0) === 9, JSON.stringify(cardGotos));
check('卡内没有嵌套 <button>（chip 是卡的直接后代，不出现按钮里套按钮）', cards.every((c) => countOf(c, '<button') === countOf(c, '</button>') && countOf(c, '<button') > 0));

/** 卡片是介绍容器：样式里不得有指针样式与 hover 抬升 */
{
  // ⚠️ 段落标记本身在 CSS 注释里，而 cssCode 是剥注释的 —— 必须在**原文**里定位，
  // 再按同样的偏移量去剥注释文本里取。两者长度一致（stripComments 保持长度），所以偏移可复用。
  const markIdx = cssRaw.indexOf('首页（Home）—— 独立导航页');
  check('夹具自证：在 styles.css 原文里找到了 Home 段落标记', markIdx >= 0, String(markIdx));
  const region = cssCode.slice(cssCode.indexOf('.home-page', markIdx));
  check('夹具自证：切出了 Home 的样式段', region.length > 0 && region.includes('.home-chip'), String(region.length));
  const cursorSites = (region.match(/cursor:\s*pointer/g) || []).length;
  check(
    '🔴 Home 样式段里 cursor:pointer 只出现 1 次（仅 .home-chip；卡片本身不得有）',
    cursorSites === 1,
    '实得 ' + cursorSites,
  );
  check(
    '🔴 那唯一一处 cursor:pointer 在 .home-chip 规则里',
    /\.home-chip\s*\{[^}]*cursor:\s*pointer/.test(region),
  );
  const hoverSites = (region.match(/:hover/g) || []).length;
  check('🔴 Home 样式段里 :hover 只出现 1 次（仅 .home-chip:hover，卡片不得有 hover 抬升）', hoverSites === 1, '实得 ' + hoverSites);
  check('🔴 那唯一一处 :hover 是 .home-chip:hover', /\.home-chip:hover\s*\{/.test(region));
  check('🔴 .home-feature 没有 cursor / transform 之类的「可点」暗示', (() => {
    const b = (/\.home-feature\s*\{[^}]*\}/.exec(region) || [''])[0];
    return b.length > 0 && !/cursor/.test(b) && !/transform/.test(b);
  })());
  check('🔴 卡片本体不绑 click（事件委托只认 [data-home-goto]）', /closest\('\[data-home-goto\]'\)/.test(sliceBetween(appCode, 'function bindHomePageActions() {', '\n}')));
}

/** 装饰件（2026-10-05「美化启动页」）同样必须守「不是入口」这条线。
 *  首页里的品牌徽标是纯装饰：一旦有人给它挂 data-home-goto 就变成第 11 个入口
 *  （可点节点数恒为 10 是 §5 的硬口径）；挂了 data-i18n 则会让 §9 的 home.* 词条
 *  在两种语言里各多一条，而 HTML 里没人用 ⇒ 直接踩「无孤儿」断言。 */
{
  const i = htmlCode.indexOf('<span class="home-brand"');
  check('夹具自证：index.html 里找得到 .home-brand 装饰件', i >= 0, String(i));
  const j = i >= 0 ? htmlCode.indexOf('</span>', i) : -1;
  const seg = i >= 0 && j > i ? htmlCode.slice(i, j) : '';
  check(
    '🔴 .home-brand 是纯装饰：aria-hidden + 无 data-i18n + 无 data-home-goto',
    seg.includes('aria-hidden="true"') &&
      !seg.includes('data-i18n') &&
      !seg.includes('data-home-goto'),
    seg.slice(0, 90),
  );
  check(
    '🔴 .home-brand 住在 .home-head 里（不许漂成一个游离的装饰层）',
    i > htmlCode.indexOf('<div class="home-head"') && i < htmlCode.indexOf('<div class="home-cta"'),
  );
}

// ══════════════════════════════════════════════ 7. 零副作用：Home 是纯导航页

const HOME_MARK = '// ===== 首页（Home）=====';
const homeRegionRaw = sliceBetween(appRaw, HOME_MARK, '// 打开管理页面（从 topbar 按钮触发）');
const homeRegion = stripComments(homeRegionRaw);
check('夹具自证：切出了 app.js 的 Home 代码段', homeRegion.length > 0, String(homeRegion.length));

for (const banned of [
  'handleAddFolder',
  'photoAPI.',
  'api.',
  'rescanFolder',
  'webServerGetStatus',
  'getWebUrl',
  'tunnelGetStatus',
  'restoreStartupPositionSnapshot',
  'aiViews.',
  'startScan',
  'ipcRenderer',
]) {
  check('🔴 Home 代码段零副作用：不出现 `' + banned + '`', !homeRegion.includes(banned), banned);
}
check('🔴 Home 代码段不发 IPC、不读数据库（无 invoke/send）', !/\.(invoke|send|sendSync)\(/.test(homeRegion));
check('夹具自证：零副作用断言不是靠空片段蒙混（片段里确实含入口分发）', homeRegion.includes('handleHomeGoto'));

// ══════════════════════════════════════════════ 8. 设置页深链：只能经 scrollToSettingsSection

{
  const gotoBody = sliceBetween(appCode, 'function handleHomeGoto(spec) {', '\nfunction bindHomePageActions');
  check('夹具自证：取到了 handleHomeGoto 的函数体', gotoBody.length > 0);
  check('🔴 深链一律经 scrollToSettingsSection', gotoBody.includes('scrollToSettingsSection('));
  check('🔴 深链不使用 scrollIntoView（那条路没有面板展开前置，落点会漂）', !gotoBody.includes('scrollIntoView'));
  check('🔴 深链顺序：先 openSettingsPage() 再 scrollToSettingsSection（反了就没落点）', (() => {
    const iOpen = gotoBody.indexOf('openSettingsPage()');
    const iScroll = gotoBody.indexOf('scrollToSettingsSection(');
    return iOpen >= 0 && iScroll > iOpen;
  })());
  const panelIds = [];
  const re = /data-home-goto="panel:([^"]+)"/g;
  let m;
  while ((m = re.exec(htmlCode)) !== null) panelIds.push(m[1]);
  check('夹具自证：找得到 4 个面板深链', panelIds.length === 4, JSON.stringify(panelIds));
  for (const id of panelIds) {
    check('深链目标面板 ' + id + ' 在 index.html 里真实存在', new RegExp('id="' + id + '"').test(htmlCode));
  }
  check('深链涉及外观 / 快捷键 / 网络 / 目录四个面板', panelIds.join(',') === 'settingsSectionFolders,settingsSectionNetwork,settingsSectionAppearance,settingsSectionShortcuts', panelIds.join(','));
}

// ══════════════════════════════════════════════ 9. 文案规范（§4.1.1）

const HOME_KEYS = [
  'home.subtitle',
  'home.addFolder',
  'home.addFolderHint',
  'home.whatCanDo',
  'home.sectionNote',
  'home.grp.browse.title',
  'home.grp.browse.desc',
  'home.grp.search.title',
  'home.grp.search.desc',
  'home.grp.large.title',
  'home.grp.large.desc',
  'home.grp.personal.title',
  'home.grp.personal.desc',
  'home.chip.videos',
];

/** 从 i18n.js 里取某个 key 的值（取第一次出现的那条） */
function i18nValues(key) {
  const out = [];
  const re = new RegExp("'" + key.replace(/\./g, '\\.') + "'\\s*:\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)*)'", 'g');
  let m;
  while ((m = re.exec(i18nRaw)) !== null) out.push(m[1].replace(/\\'/g, "'"));
  return out;
}

for (const key of HOME_KEYS) {
  const vals = i18nValues(key);
  check('词条 ' + key + ' 中英各一份', vals.length === 2, '实得 ' + vals.length);
}
check('夹具自证：词条取值解析不是空手而归（home.subtitle 应取到 2 条）', i18nValues('home.subtitle').length === 2);

{
  const zh = [];
  for (const key of HOME_KEYS) {
    const v = i18nValues(key);
    if (v.length) zh.push(v[0]);
  }
  const TECH = ['索引', '转码', '数据库', '阈值', 'SQLite', '建索引', '哈希', 'OCR', '向量'];
  const offenders = [];
  for (const word of TECH) {
    for (const key of HOME_KEYS) {
      const v = i18nValues(key);
      if (v[0] && v[0].includes(word)) offenders.push(key + '→' + word);
    }
  }
  check('🔴 文案不含技术词（' + TECH.join('/') + '）', offenders.length === 0, offenders.join(', '));

  const descKeys = ['home.grp.browse.desc', 'home.grp.search.desc', 'home.grp.large.desc', 'home.grp.personal.desc'];
  for (const key of descKeys) {
    const v = i18nValues(key)[0] || '';
    check(
      '🔴 ' + key + ' 中文说明 ≤30 字（超一行会把同行卡片一起撑高）',
      [...v].length <= 30,
      '实得 ' + [...v].length + '：' + v,
    );
  }
  for (const key of descKeys) {
    const v = i18nValues(key)[1] || '';
    check(key + ' 英文说明 ≤80 字符（英文没有字数上限口径，取宽松托底）', v.length <= 80, '实得 ' + v.length + '：' + v);
  }

  // 提示信号（R9）：段头必须明说「卡片是介绍，点里面的按钮」
  check('🔴 段头保留「卡片是介绍、点里面按钮」提示（R9：否则用户在卡上白点）', (i18nValues('home.sectionNote')[0] || '').includes('卡片'));
  check('主按钮旁预告去向（R5：不弹目录选择器，必须提前说清去哪）', /home\.addFolderHint/.test(htmlCode) && (i18nValues('home.addFolderHint')[0] || '').includes('设置'));
}

// 说明里提到的能力必须在同卡 chip 的文案/落点里够得着
{
  const CARD_SPEC = [
    { id: 'browse', words: ['文件夹', '日期'], gotos: ['view:all', 'view:folder_overview', 'tab:dates'] },
    { id: 'search', words: ['搜', '人物'], gotos: ['tab:search', 'tab:people'] },
    { id: 'large', words: ['视频'], gotos: ['view:all:video'] },
    { id: 'personal', words: ['主题', '快捷键', '扫'], gotos: ['panel:settingsSectionAppearance', 'panel:settingsSectionShortcuts', 'panel:settingsSectionNetwork'] },
  ];
  CARD_SPEC.forEach((spec, i) => {
    const desc = i18nValues('home.grp.' + spec.id + '.desc')[0] || '';
    for (const w of spec.words) {
      check('🔴 卡 ' + (i + 1) + '（' + spec.id + '）说明提到的「' + w + '」在同卡有对应入口', desc.includes(w), desc);
    }
    for (const g of spec.gotos) {
      check('🔴 卡 ' + (i + 1) + '（' + spec.id + '）的 chip 落点含 ' + g, cardGotos[i].includes(g), JSON.stringify(cardGotos[i]));
    }
  });
}

// DOM 引用的 home.* / settings.network.qr* 词条都得存在
{
  const used = new Set();
  const re = /data-i18n(?:-aria-label|-label|-placeholder|-title|-html)?="(home\.[^"]+|settings\.network\.qr[A-Za-z]+)"/g;
  let m;
  while ((m = re.exec(htmlCode)) !== null) used.add(m[1]);
  check('夹具自证：从 HTML 里取到了 home.* / qr* 的词条引用', used.size >= HOME_KEYS.length - 1, String(used.size));
  const missing = [...used].filter((k) => !new RegExp("'" + k.replace(/\./g, '\\.') + "'").test(i18nRaw));
  check('🔴 HTML 引用的 home.* / qr* 词条在 i18n.js 里都存在', missing.length === 0, missing.join(', '));
  const orphan = HOME_KEYS.filter((k) => !used.has(k));
  check('🔴 没有孤儿 home.* 词条（定义了却没人用）', orphan.length === 0, orphan.join(', '));
}

// ══════════════════════════════════════════════ 10. 二维码（§5.4）

// --- 10a. 载荷同源 + 不含密码（静态） ---
const copyBody = sliceBetween(shellRaw, 'function copyWebUrl(options) {', '\n  }');
check('夹具自证：取到了 copyWebUrl 的函数体', copyBody.length > 0);
check('「点击复制」复制的就是 state.webUrl', copyBody.includes('state.webUrl'));
const qrFn = sliceBetween(shellRaw, 'function renderWebQr(url) {', '\n  }');
check('夹具自证：取到了 renderWebQr 的函数体', qrFn.length > 0);
check('🔴 二维码载荷不含密码（函数体内零 password 字样）', !/password/i.test(qrFn), 'renderWebQr');
check('🔴 二维码载荷不含密码（HTML 的扫码块内零 password 字样）', (() => {
  const box = sliceBetween(htmlCode, '<div class="web-qr"', '</div>\n            </div>');
  return box.length > 0 && !/password/i.test(box);
})());
check('qrHint / qrAria 两条词条中英各一份', i18nValues('settings.network.qrHint').length === 2 && i18nValues('settings.network.qrAria').length === 2);
check('扫码块在设置页网络面板内（不在首页）', (() => {
  const iQr = htmlCode.indexOf('id="webQrBox"');
  const iHome = htmlCode.indexOf('id="homePage"');
  return iQr > iHome && !homeRegion.includes('webQr');
})());
check('二维码只在状态「已开启 + 正在运行」时画（否则清空）', /renderWebQr\(enabled\s*&&\s*running\s*\?\s*url\s*:\s*''\)/.test(shellRaw));
check(
  '状态不当时不画码（宁缺勿错）：拿不到 API / 读失败两条路径都各自清空一次',
  countOf(shellRaw, "renderWebQr('')") >= 2,
  String(countOf(shellRaw, "renderWebQr('')")),
);
check('状态不当会把 img 的 src 摘掉并整块 hidden（不留旧码）', qrFn.includes('img.removeAttribute(') && qrFn.includes('box.hidden = true'));
check(
  '🔴 载荷来源是 refreshWebServerStatus 里那个 url 字段，与 copyWebUrl 同字段',
  /state\.webUrl\s*=\s*url/.test(shellRaw) && /enabled\s*&&\s*running\s*\?\s*url/.test(shellRaw),
);
check(
  '🔴 二维码调用点一律不拼密码（实参只能是 url / 空串 / 「已开启且运行 ? url : 空串」三种形态）',
  (() => {
    // 排除函数声明本身（`function renderWebQr(url)` 也会被 renderWebQr\([^)]*\) 匹配到）
    const sites = (shellRaw.match(/(?<!function )renderWebQr\([^)]*\)/g) || []).filter(Boolean);
    const ALLOWED = ["renderWebQr('')", 'renderWebQr(url)', "renderWebQr(enabled && running ? url : '')"];
    return sites.length === 3 && sites.every((s) => ALLOWED.includes(s));
  })(),
  (shellRaw.match(/(?<!function )renderWebQr\([^)]*\)/g) || []).join(' | '),
);

// --- 10b. 静区 + 隐藏（CSS） ---
check(
  '🔴 `.web-qr[hidden]{display:none}` 必须存在 —— `.web-qr{display:flex}` 是作者样式，' +
    '会无条件压过 UA 的 `[hidden]{display:none}`，少了这条 `box.hidden = true` 就是哑弹（二维码永不隐藏）',
  /\.web-qr\[hidden\]\s*\{[^}]*display:\s*none/.test(cssCode),
);
check('.web-qr 用 display:flex 布局（正是上面那条 [hidden] 规则存在的原因）', /\.web-qr\s*\{[^}]*display:\s*flex/.test(cssCode));
check('二维码图给白底（深色主题下码的边界不能被吃掉）', /\.web-qr-img\s*\{[^}]*background:\s*#fff/.test(cssCode));

// --- 10c. 编码器行为（结果级，不依赖任何第三方库） ---
check('vendor 编码器已落位', fs.existsSync(path.join(ROOT, QR_VENDOR)));
check(
  'vendor 文件是真正的 QR 编码器（含 GIF 写出路径）',
  fs.readFileSync(path.join(ROOT, QR_VENDOR), 'utf8').includes('GIF87a'),
);
check('适配层已落位', fs.existsSync(path.join(ROOT, QR_ADAPTER)));
check('index.html 先引 vendor 再引适配层', (() => {
  const a = htmlCode.indexOf('vendor/qrcode.js');
  const b = htmlCode.indexOf('qr-code.js');
  return a >= 0 && b > a;
})());

/**
 * 在一个「脚本式」沙箱里加载真实的 vendor + 真实的适配层。
 * 用 vm 而不是 require：适配层取的是 `window`（`typeof window !== 'undefined' ? window : this`），
 * require 进来时那个 global 参数会变成 module.exports，encoder() 就找不到编码器了 ——
 * 那样测的就不是线上跑的那份代码。
 */
function makeSandbox(withVendor) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  if (withVendor) vm.runInContext(fs.readFileSync(path.join(ROOT, QR_VENDOR), 'utf8'), sandbox, { filename: QR_VENDOR });
  vm.runInContext(fs.readFileSync(path.join(ROOT, QR_ADAPTER), 'utf8'), sandbox, { filename: QR_ADAPTER });
  return sandbox;
}

const box = makeSandbox(true);
check('夹具自证：适配层在沙箱里挂上了 RendererQrCode', !!(box.RendererQrCode && typeof box.RendererQrCode.createDataUrl === 'function'));
check('夹具自证：vendor 在沙箱里挂上了 qrcode', typeof box.qrcode === 'function');

const dataUrlOf = (text, opts) => box.RendererQrCode.createDataUrl(text, opts);

// 已知向量：'HELLO' / EC M / version 1 → 21×21。
// 来源：离线验证台（临时目录）里用 jsQR 解码本编码器产出的真实 GIF 得到 'HELLO'，
// 并与 npm qrcode 交叉比对确认「差异仅在模式/掩码选择，码字本身正确」（见 CONTRACTS）。
const VECTOR_HELLO = [
  '111111100001001111111',
  '100000100010101000001',
  '101110101100001011101',
  '101110101010101011101',
  '101110101100101011101',
  '100000101111001000001',
  '111111101010101111111',
  '000000001100000000000',
  '101111100011001111100',
  '011011010111111001100',
  '001111101000101101110',
  '011010000111111001100',
  '010111111000100100101',
  '000000001010100101000',
  '111111100111010010110',
  '100000101010000111110',
  '101110101101010010110',
  '101110101101111101000',
  '101110101100101100100',
  '100000100111111011100',
  '111111101100100010110',
];
{
  const q = box.qrcode(0, 'M');
  q.addData('HELLO');
  q.make();
  const n = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    let s = '';
    for (let c = 0; c < n; c++) s += q.isDark(r, c) ? '1' : '0';
    rows.push(s);
  }
  check('夹具自证：HELLO 编码为 21×21（version 1）', n === 21, String(n));
  const diff = rows.filter((s, i) => s !== VECTOR_HELLO[i]).length;
  check(
    '🔴 二维码已知向量：HELLO 的模块矩阵与参考值逐位相同（抓掩码/纠错/字符编码的静默回归）',
    rows.length === VECTOR_HELLO.length && diff === 0,
    diff + ' 行不同',
  );
}
// GIF 尺寸能反推静区：width = moduleCount * cellSize + margin * 2，而 margin 必须是 cellSize * 4
{
  const gifSize = (text, cellSize) => {
    const du = dataUrlOf(text, { cellSize: cellSize });
    const b = Buffer.from(du.slice('data:image/gif;base64,'.length), 'base64');
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  };
  const s4 = gifSize('HELLO', 4);
  check(
    '🔴 静区 = 4 个模块（GIF 边长 = 21*4 + 16*2 = 116；压小静区会让低端摄像头找不到码的边界）',
    s4.w === 116 && s4.h === 116,
    s4.w + 'x' + s4.h,
  );
  const s8 = gifSize('HELLO', 8);
  check('静区随 cellSize 缩放（cellSize=8 ⇒ 21*8 + 32*2 = 232）', s8.w === 232, String(s8.w));
  check('默认 cellSize = 4（调用方不传也得到同一张码）', gifSize('HELLO').w === s4.w);
}

// UTF-8：同一串中文，UTF-8 与「charCode & 0xff」选出的版本不同 ⇒ 模块数可判别
{
  const CN = '相册访问地址扫描二维码相册访问地址扫描'; // 19 汉字 = 57 字节
  // 🔴 用**全新沙箱**，且先只调一次适配层再量。
  // 不能复用上面的 box：那样会变成「因为前面某次调用顺带触发过 ensureUtf8 才通过」——
  // 一条依赖调用顺序才成立的断言，重排代码就会假红，且根本测不到「首次使用是否真的换了编码器」。
  const sb = makeSandbox(true);
  const first = sb.RendererQrCode.createDataUrl('HELLO');
  check('夹具自证：全新沙箱里第一次调用就拿到 data URI', /^data:image\/gif;base64,/.test(first));
  const q = sb.qrcode(0, 'M');
  q.addData(CN);
  q.make();
  const n = q.getModuleCount();
  check('夹具自证：19 个汉字在 UTF-8 下应是 version 4（33×33）', n === 33, String(n));
  check(
    '🔴 编码器走 UTF-8（19 汉字 ⇒ 57 字节 ⇒ 33×33；若退回 `charCode & 0xff` 会变成 25×25，扫出乱码）',
    n === 33 && n !== 25,
    String(n),
  );
  check(
    '🔴 适配层把 vendor 的 stringToBytes 换成了它自带的 UTF-8 实现',
    sb.qrcode.stringToBytes === sb.qrcode.stringToBytesFuncs['UTF-8'],
  );
}

// 空载荷 / 编码器缺失：一律返回空串，由调用方据此不画码
check('空载荷不画码（返回空串）', dataUrlOf('') === '' && dataUrlOf(null) === '');
check('编码器缺失时不画码（返回空串，不抛）', (() => {
  const bare = makeSandbox(false);
  return bare.RendererQrCode.createDataUrl('HELLO') === '';
})());
check('载荷是可扫码的 data URI（base64 GIF）', /^data:image\/gif;base64,[A-Za-z0-9+/=]+$/.test(dataUrlOf('http://192.168.1.23:8420/')));

// --- 10d. 端到端接线：真正的解码验证是离线跑的，这里确认它的结论被记录下来 ---
{
  const contractsPath = path.join(ROOT, '.workbuddy', 'memory', 'CONTRACTS.md');
  const contracts = fs.existsSync(contractsPath) ? fs.readFileSync(contractsPath, 'utf8') : '';
  check(
    '二维码的独立解码验证结论已记入 CONTRACTS.md（jsQR 解码真实 GIF + 与 npm qrcode 交叉比对）',
    contracts.includes('jsQR') && contracts.includes('二维码'),
  );
}

// ══════════════════════════════════════════════ 11. vendor 不进打包盲区 + 网页端本次未动

check('网页端仍无二维码实现（本轮范围只到桌面端）', (() => {
  const webDir = path.join(ROOT, 'src', 'web');
  let hit = false;
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'vendor') continue;
        scan(p);
      } else if (/\.(js|css|html)$/.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8');
        if (/RendererQrCode|webQrBox|createDataURL/.test(t)) hit = true;
      }
    }
  };
  scan(webDir);
  return !hit;
})());
check('src/renderer/vendor/ 下的文件不被静态守护误判为死代码（沿用既有约定）', (() => {
  const dead = read('scripts/dead-reference-regression.js');
  return /vendor/.test(dead);
})());
check('新增两个 js 文件里没有乱码（U+FFFD）', (() => {
  const bad = [QR_ADAPTER, QR_VENDOR].filter((rel) => read(rel).includes('\uFFFD'));
  return bad.length === 0;
})(), '');

// ══════════════════════════════════════════════ 12. 登记进全量回归

check('本守护已登记进 scripts/run-regressions.js', runSrc.includes("'home-page-regression.js'"));
check('登记位置在末项 ai-lifecycle-regression 之前（末项约定不能破）', (() => {
  const i = runSrc.indexOf("'home-page-regression.js'");
  const j = runSrc.indexOf("'ai-lifecycle-regression.js'");
  return i >= 0 && j >= 0 && i < j;
})());

// ---------------------------------------------------------------------- 输出

process.stdout.write('[home-page-regression] 首页（Home）契约\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[home-page-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[home-page-regression] PASS（' + notes.length + ' 项）\n');
