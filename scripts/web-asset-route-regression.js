'use strict';
/**
 * 网页端静态资源路由对账。
 *
 * 背景（2026-10-05）：`src/web/index.html` 一直在 `<script src="/js/photo-info-fields.js?v=1">`
 * 请求共享字段注册表，但 `web-server.js` 的路由链是**逐个文件白名单**的（`pathname === '/js/app.js'`
 * 这种），末尾的 `else` 直接 404 —— 于是 `window.PhotoInfoFields` 永远是 undefined，网页端
 * 「照片信息」面板固定显示「照片信息模块未加载」。
 *
 * 这类缺陷的可怕之处在于**所有静态守护都是绿的**：
 *   - `css-reference-regression` 管「CSS 类名有没有人用」；
 *   - `dead-reference-regression` 管「JS 全局有没有被赋值后被读」；
 *   - `module-reachability-regression` 管「主进程 require 闭包」；
 *   没有任何一条知道「HTTP 路由表」这件事。而它只会在**真跑起来打开那个面板**时才现形。
 *
 * 所以本脚本把三件事钉在一起：
 *   ① `src/web/*.html` 里出现的每一个站内静态资源 URL，必须在 `web-server.js` 的路由链里
 *      有对应字面量（`===` 或 `startsWith` 都算）；
 *   ② 设置页那条链路的四条契约：脚本加载顺序、面板顺序与桌面端一致、快照函数不含敏感键；
 *   ③ 卡片比例：`<option value>` 集合 ↔ `CARD_ASPECT_MODES` 取值域 ↔ `getUniformAspectCss`
 *      映射 ↔ 桌面端 `BROWSE_CARD_RATIOS` 能力，四者必须对齐。
 *      同类的第二起（2026-10-05）：移动端筛选抽屉里一直摆着「9:16 固定」，但
 *      `CARD_ASPECT_MODES` 里没有这一项，`normalizeCardAspectMode()` 会把它静默回落成
 *      `masonry` —— 用户选中即弹回，不报错、不进日志，只有真点一下才看得出来。
 *   ④ 只读快照白名单（不得含密码 / 凭据 / 本机绝对路径）；
 *   ⑤ 卡片比例：见上；
 *   ⑥ 面板 id ↔ RENDERERS ↔ panelMeta 自洽：见文末那组注释。
 *
 * ⚠️ 判定刻意保守：只认 `/api/`、`/thumb`、`/photo`、`/preview-image`、`/video`、`/hls/`
 *    这些**按动态段匹配**的前缀直接跳过（它们本来就靠 `startsWith` 分支处理），
 *    其余一律要求路由表里能查到同名文件。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB_SERVER = 'src/web-server.js';
const WEB_HTML = 'src/web/index.html';
const WEB_SETTINGS_JS = 'src/web/js/settings-page.js';
const WEB_APP_JS = 'src/web/js/app.js';
const RENDERER_SETTINGS = 'src/renderer/ui-settings.js';
const RENDERER_UTILS = 'src/renderer/utils.js';
const MAIN_JS = 'src/main.js';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name} —— ${detail}` : name);
};

// ---------------------------------------------------------------- ① 路由对账
const webServerSrc = read(WEB_SERVER);

/** 只取「路由链」那一段：从 `// 路由` 到末尾 404 分支之前。 */
function routingRegion(src) {
  const start = src.indexOf('  // 路由');
  if (start < 0) return '';
  const end = src.indexOf('res.writeHead(404)', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}
const routing = routingRegion(webServerSrc);
check(
  'web-server.js 能定位到路由链（`// 路由` → 404 分支）',
  routing.length > 2000,
  `实际取到 ${routing.length} 字符，说明源码结构变了，本脚本的锚点要跟着改`,
);

/** 动态段前缀：这些路径由 `startsWith` 分支处理，不参与逐文件对账。 */
const DYNAMIC_PREFIXES = ['/api/', '/thumb', '/photo', '/preview-image/', '/video', '/hls/'];

function htmlFiles() {
  const dir = path.join(ROOT, 'src', 'web');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => path.posix.join('src/web', e.name));
}

const wanted = new Map(); // url -> [来源文件]
for (const f of htmlFiles()) {
  const html = read(f);
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    const url = raw.split('?')[0].split('#')[0];
    if (!url.startsWith('/')) continue; // 站外 / 相对路径
    if (DYNAMIC_PREFIXES.some((p) => url.startsWith(p))) continue;
    if (url === '/') continue; // 首页由 `pathname === '/'` 处理
    if (!wanted.has(url)) wanted.set(url, []);
    wanted.get(url).push(f);
  }
}

check('从 src/web 的 HTML 里采集到了静态资源引用', wanted.size > 0, `只采到 ${wanted.size} 个`);

const missing = [];
for (const [url, sources] of wanted) {
  // `=== '/x'` 或 `startsWith('/x')` 都要算 —— 路由写法有这两种
  const hit = routing.includes(`'${url}'`) || routing.includes(`"${url}"`);
  if (!hit) missing.push(`${url}  （被 ${[...new Set(sources)].join(', ')} 引用）`);
}
check(
  'src/web 的 HTML 引用的每一个站内静态资源都有路由',
  missing.length === 0,
  missing.length
    ? '以下资源会直接 404：\n      ' + missing.join('\n      ')
    : '',
);

// 反向自证：故意漏掉一条时必须抓得到（防「正则写歪了永远绿」）
check(
  '夹具自证：对一个不存在的资源，路由查询必须为假',
  !routing.includes(`'/js/__definitely-not-a-real-asset.js'`),
);

// ------------------------------------------------- ② 设置页脚本加载顺序
const webHtml = read(WEB_HTML);
const iApp = webHtml.indexOf('/js/app.js');
const iSettings = webHtml.indexOf('/js/settings-page.js');
check('index.html 同时引用了 app.js 与 settings-page.js', iApp >= 0 && iSettings >= 0);
check(
  'settings-page.js 排在 app.js 之后加载',
  iApp >= 0 && iSettings > iApp,
  '它要调用 app.js 挂到 window 上的 changePageSize / applyWebThemeStyle 等入口，顺序反了就全静默失效',
);
check(
  'index.html 里有设置页的挂载点 #webSettingsPage',
  /id="webSettingsPage"/.test(webHtml),
);
check(
  '设置页样式表已挂到页面上',
  webHtml.includes('/settings-page.css'),
  '只写文件不 link，页面上会完全没样式但控制台零报错',
);

// --------------------------------- ③ 两端面板顺序 / 名称必须一致
function panelTitlesFromWebSettings() {
  const src = read(WEB_SETTINGS_JS);
  const start = src.indexOf('var PANELS = [');
  const end = src.indexOf('\n  ];', start);
  const body = start < 0 || end < 0 ? '' : src.slice(start, end);
  return [...body.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
}
function panelTitlesFromDesktop() {
  const src = read(RENDERER_SETTINGS);
  const start = src.indexOf('var navItems = [');
  const end = src.indexOf('\n    ];', start);
  const body = start < 0 || end < 0 ? '' : src.slice(start, end);
  // navItems 里只有 zh 是没有 i18n 前缀的展示名，正是拿来比对的字段
  return [...body.matchAll(/zh:\s*'([^']+)'/g)].map((m) => m[1]);
}
const webTitles = panelTitlesFromWebSettings();
const desktopTitles = panelTitlesFromDesktop();
check('解析到桌面端 8 个面板名', desktopTitles.length === 8, `实际 ${desktopTitles.length} 个`);
check('解析到网页端 8 个面板名', webTitles.length === 8, `实际 ${webTitles.length} 个`);
check(
  '网页端设置页的面板顺序与名称和桌面端逐位一致',
  webTitles.length === desktopTitles.length &&
    webTitles.every((t, i) => t === desktopTitles[i]),
  `网页端 [${webTitles.join(' / ')}] vs 桌面端 [${desktopTitles.join(' / ')}]`,
);

// -------------------------------------- ④ 只读快照不得含敏感键
const mainSrc = read(MAIN_JS);
const snapStart = mainSrc.indexOf('function buildWebSettingsSnapshot()');
const snapEnd = snapStart < 0 ? -1 : mainSrc.indexOf('\n}', snapStart);
const snapBody = snapStart < 0 || snapEnd < 0 ? '' : mainSrc.slice(snapStart, snapEnd);
check('main.js 能定位到 buildWebSettingsSnapshot()', snapBody.length > 200);
check(
  '只读快照里没有 webPassword 本身（只允许 hasWebPassword 布尔）',
  !/webPassword\s*:/.test(snapBody),
  '把密码发给局域网等于公开它；只能发「有没有设」',
);
check(
  '只读快照里带上了 hasWebPassword 布尔',
  /hasWebPassword\s*:/.test(snapBody),
);
check(
  '只读快照里没有 token / secret / password 类字段',
  !/(token|secret|credential)\s*:/i.test(snapBody),
  '快照必须是白名单：新增敏感字段时不应该自动流出去',
);
check(
  '只读快照里没有本机绝对路径（盘符或 folder_path 字段）',
  !/[A-Za-z]:\\\\/.test(snapBody) && !/folder_path\s*:/.test(snapBody),
);

// ------------------------- ⑤ 卡片比例：下拉选项 ↔ 取值域 ↔ 桌面端能力对齐
const webAppJs = read(WEB_APP_JS);
const rendererUtils = read(RENDERER_UTILS);

/** 取某个 `<select>` 的 `<option value>` 序列（保持 HTML 里的出现顺序）。 */
function optionsOf(selectId) {
  const at = webHtml.indexOf(`id="${selectId}"`);
  if (at < 0) return null;
  const rest = webHtml.slice(at);
  const end = rest.indexOf('</select>');
  if (end < 0) return null;
  return [...rest.slice(0, end).matchAll(/<option\s+value="([^"]*)"/g)].map((m) => m[1]);
}

const headerAspects = optionsOf('headerCardAspectSelect');
const drawerAspects = optionsOf('cardAspectSelect');
const shot = (list) => (Array.isArray(list) ? list.join(' ') : '（未解析到）');
check(
  'index.html 能定位到顶栏 #headerCardAspectSelect 的选项',
  Array.isArray(headerAspects) && headerAspects.length > 1,
);
check(
  'index.html 能定位到抽屉 #cardAspectSelect 的选项',
  Array.isArray(drawerAspects) && drawerAspects.length > 1,
);

const modesMatch = webAppJs.match(/var CARD_ASPECT_MODES = \[([\s\S]*?)\];/);
check('app.js 能定位到 CARD_ASPECT_MODES', !!modesMatch);
const aspectModes = modesMatch
  ? [...modesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];

const aspectFn = webAppJs.match(/function getUniformAspectCss\(mode\) \{([\s\S]*?)\n\}/);
check('app.js 能定位到 getUniformAspectCss()', !!aspectFn);
const aspectFnBody = aspectFn ? aspectFn[1] : '';
const uniformCss = {};
for (const m of aspectFnBody.matchAll(/mode === '([^']+)'\) return '([^']+)'/g)) {
  uniformCss[m[1]] = m[2];
}

check(
  '顶栏与抽屉的卡片比例选项逐位一致',
  JSON.stringify(headerAspects) === JSON.stringify(drawerAspects),
  `顶栏「${shot(headerAspects)}」/ 抽屉「${shot(drawerAspects)}」——同一个人在两处看到不同清单`,
);
check(
  '卡片比例的取值域与下拉选项逐位一致',
  JSON.stringify(aspectModes) === JSON.stringify(headerAspects),
  `下拉「${shot(headerAspects)}」/ 取值域「${shot(aspectModes)}」——`
    + '多出来的选项会被 normalizeCardAspectMode() 静默回落成 masonry，选了等于没选',
);

const unmapped = aspectModes.filter(
  (m) => m !== 'masonry' && !Object.prototype.hasOwnProperty.call(uniformCss, m),
);
check(
  '取值域里每一档固定比例在 getUniformAspectCss() 里都有映射',
  unmapped.length === 0,
  `缺映射：${unmapped.join(' ')} —— 拿不到 aspect-ratio 串，卡片会退化成原始尺寸`,
);

const ratiosMatch = rendererUtils.match(/var BROWSE_CARD_RATIOS = \[([^\]]*)\]/);
check('utils.js 能定位到桌面端 BROWSE_CARD_RATIOS', !!ratiosMatch);
const desktopRatios = ratiosMatch
  ? [...ratiosMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  : [];
const webRatios = aspectModes
  .filter((m) => m !== 'masonry')
  .map((m) => uniformCss[m])
  .filter(Boolean);
check(
  '网页端固定比例档与桌面端 BROWSE_CARD_RATIOS 集合一致（两端能力不得参差）',
  JSON.stringify([...webRatios].sort()) === JSON.stringify([...desktopRatios].sort()),
  `网页端「${webRatios.join(' ')}」/ 桌面端「${desktopRatios.join(' ')}」——`
    + '网页端少一档 = 手机上少一个比例可选',
);

// ------------------- ⑥ 面板 id ↔ 渲染器 ↔ panelMeta 三者必须自洽
// 背景（2026-10-05 加第 8 个面板「AI 与索引」时踩到并修掉）：网页端原先用 `PANELS[5]`
// 这类**硬索引**取面板元信息，在中间插入一项就会让后面每个面板都顶上别人的标题
// （实测「外观与行为」顶着「网络与远程」的标题），而上面第 ③ 组照样是绿的 ——
// 它只比「两端的名字列表是否逐位相同」，不看这些名字被谁取用。
// 现在改成 panelMeta('id') 按 id 取，本组守住：不退回硬索引、id 不被抄错、映射不多不少。
const webSettingsSrc = read(WEB_SETTINGS_JS);
const panelsAt = webSettingsSrc.indexOf('var PANELS = [');
const panelsEnd = panelsAt < 0 ? -1 : webSettingsSrc.indexOf('\n  ];', panelsAt);
const panelsBody = panelsAt < 0 || panelsEnd < 0 ? '' : webSettingsSrc.slice(panelsAt, panelsEnd);
const webPanelIds = [...panelsBody.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
check('能解析到网页端 8 个面板 id', webPanelIds.length === 8, `实际 ${webPanelIds.length} 个`);

// 判据只针对「取元信息」，不含遍历用的 `PANELS[i]`：
// panelMeta 内部自己有一个 `PANELS[0]` 兜底（id 对不上时给第一项），那是允许的，
// 所以先把 panelMeta 的函数体挖掉，再看剩下的源码里还有没有数字下标。
const metaAt = webSettingsSrc.indexOf('function panelMeta(');
const metaEnd = metaAt < 0 ? -1 : webSettingsSrc.indexOf('\n  }', metaAt);
const metaBody = metaAt < 0 || metaEnd < 0 ? '' : webSettingsSrc.slice(metaAt, metaEnd);
check(
  '网页端能定位到按 id 取元信息的 panelMeta()',
  /PANELS\[i\]\.id === id/.test(metaBody),
  '它是本轮把硬索引换掉的那个入口；换成按 id 之后，插面板不会再让后面整体错位',
);
const outsideMeta = metaAt < 0 || metaEnd < 0
  ? webSettingsSrc
  : webSettingsSrc.slice(0, metaAt) + webSettingsSrc.slice(metaEnd);
check(
  'panelMeta() 之外不得出现 PANELS[<数字>] 硬索引',
  !/PANELS\[\s*\d+\s*\]/.test(outsideMeta),
  '中间插一项会让后面全部错位，而「两端顺序一致」那条对照样绿',
);

const renderersMatch = webSettingsSrc.match(/var RENDERERS = \{([\s\S]*?)\n {2}\};/);
check('网页端能定位到 RENDERERS 映射', !!renderersMatch);
const rendererMap = {};
if (renderersMatch) {
  for (const m of renderersMatch[1].matchAll(/(\w+):\s*(render\w+)/g)) rendererMap[m[1]] = m[2];
}
check(
  '每个面板都有对应渲染器、且没有多余项',
  JSON.stringify(Object.keys(rendererMap).sort()) === JSON.stringify([...webPanelIds].sort()),
  `PANELS [${webPanelIds.join(' ')}] / RENDERERS [${Object.keys(rendererMap).join(' ')}]`
    + ' —— 缺渲染器 = 该面板点开是空白，多余项 = 有渲染器永远不会被调用',
);

const metaMismatch = [];
for (const id of webPanelIds) {
  const fnName = rendererMap[id];
  if (!fnName) continue;
  const at = webSettingsSrc.indexOf(`function ${fnName}(`);
  const end = at < 0 ? -1 : webSettingsSrc.indexOf('\n  }', at);
  const fnBody = at < 0 || end < 0 ? '' : webSettingsSrc.slice(at, end);
  const used = fnBody.match(/panelMeta\('([^']+)'\)/);
  if (!used) metaMismatch.push(`${fnName}() 没调用 panelMeta()`);
  else if (used[1] !== id) metaMismatch.push(`${fnName}() 取的是 panelMeta('${used[1]}')`);
}
check(
  '每个渲染器取的面板元信息就是它自己那一项',
  metaMismatch.length === 0,
  metaMismatch.join('；') + ' —— 复制粘贴渲染器时最容易把 id 留下不改',
);

// ------------------------------------------------------------------ 输出
if (failures.length) {
  console.error('[web-asset-route-regression] FAIL：网页端静态资源 / 设置页契约不成立');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log(
    `[web-asset-route-regression] PASS（对账 ${wanted.size} 个站内静态资源、`
      + `${webTitles.length} 个设置面板、快照白名单 4 条、`
      + `卡片比例 ${webRatios.length} 档、面板↔渲染器 ${Object.keys(rendererMap).length} 项）`,
  );
}
