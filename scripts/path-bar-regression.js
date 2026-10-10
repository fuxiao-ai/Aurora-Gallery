'use strict';
/**
 * 路径栏（面包屑）回归。
 *
 * 背景：桌面端原先只有侧栏里一条「返回上级」按钮（#folderNavBar），到根目录整条隐藏；
 * 内容区顶栏的 #currentPath 只渲染一个末级目录名。于是「自己在路径的第几层」不可见、
 * 跳回任意祖先要连点 N 次。改成路径栏后（左端 ←、中间每段可点、末段开同级下拉），
 * 有四类东西会静默坏掉，且 ESLint 与截图都抓不到：
 *
 *   1. `#currentPath` 上被加回 `data-i18n` —— 静态 i18n 初始化会写 textContent，
 *      把整棵面包屑冲成一句「所有文件」。看着像功能没生效，其实是被覆盖了。
 *   2. 面包屑的分段/折叠算错 —— 画面依然"有面包屑"，只是少一段或多一段。
 *   3. `mount()` 的 deps 漏接一项（例如 queryChildFolders）—— 同级下拉点了没反应，
 *      不报错、不抛异常。
 *   4. `expandTreeToFolder` 的收尾滚动退化成 `scrollIntoView()` —— 会把祖先滚动
 *      容器一起调整（深层子层是 position:relative，链路更长），带着整页跳。
 *
 * 纯函数部分**直接引线上本体**（vm 沙箱加载 sidebar-tree.js + path-crumbs.js），
 * 不复刻分段算法 —— 复刻的断言只能证明"我以为的规则"自洽。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * 剥掉注释，避免注释里的示例文本被当成代码断言（本项目的既定做法）。
 * ⚠️ HTML 注释也要剥：本仓好几处「已移除 XXX」的说明就写在 `<!-- -->` 里，
 * 只剥 JS 注释会把它们当残留证据。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 把浏览器侧模块装进 vm 沙箱，返回它的 window（模块全局都挂在上面） */
function loadModules(files) {
  const win = {};
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
  };
  const sandbox = {
    window: win,
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    Map,
    WeakMap,
    Object,
    Array,
    Math,
    String,
    Number,
    JSON,
  };
  sandbox.globalThis = sandbox;
  win.document = doc;
  win.innerWidth = 1440;
  win.addEventListener = () => {};
  win.removeEventListener = () => {};
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, f), 'utf8'), sandbox, { filename: f });
  }
  return win;
}

/* ---------------------------------------------------------------- 1. 结构 */

function testStructure() {
  const html = read('src/renderer/index.html');
  const sidebarIdx = html.indexOf('id="sidebar"');
  const contentIdx = html.indexOf('id="contentArea"');
  const barIdx = html.indexOf('id="pathBar"');
  const upIdx = html.indexOf('id="pathUp"');
  const pathIdx = html.indexOf('id="currentPath"');
  const toolbarIdx = html.indexOf('id="toolbar"');

  assert.ok(barIdx > 0, 'index.html 里没有 #pathBar');
  assert.ok(upIdx > barIdx, '#pathUp 应在 #pathBar 之内（上级按钮与面包屑同一条）');
  assert.ok(pathIdx > upIdx, '#currentPath 应排在 #pathUp 之后（左 ←、右路径）');
  assert.ok(
    contentIdx < toolbarIdx && toolbarIdx < barIdx,
    '路径栏应嵌在内容区（#contentArea > .toolbar）内部 —— 不再是侧栏里的一条',
  );
  assert.ok(
    sidebarIdx < contentIdx,
    '夹具自证：侧栏本就排在内容区之前（防止把上一条断言写成恒真）',
  );

  // ① #currentPath 不能有 data-i18n：静态 i18n 会写 textContent，把面包屑冲掉
  const crumbTag = html.slice(html.lastIndexOf('<nav', pathIdx), html.indexOf('>', pathIdx) + 1);
  assert.equal(
    /data-i18n=/.test(crumbTag),
    false,
    '#currentPath 上出现了 data-i18n —— 静态 i18n 初始化会写 textContent、把面包屑整棵冲掉',
  );
  assert.ok(/aria-label=/.test(crumbTag), '#currentPath 缺 aria-label（导航区域要有可读名字）');

  // 旧结构必须彻底消失（只删一半会留下一个永远隐藏的死条）
  const rendererFiles = fs
    .readdirSync(RENDERER)
    .filter((f) => /\.(js|html|css)$/.test(f))
    .map((f) => ({ f, src: read(path.join('src', 'renderer', f)) }));
  for (const name of ['folderNavBar', 'folderNavUp', 'folder-nav-bar', 'folder-nav-up']) {
    const hits = rendererFiles
      .filter((x) => stripComments(x.src).indexOf(name) >= 0)
      .map((x) => x.f);
    assert.deepEqual(hits, [], `旧返回条残留 ${name}：${hits.join(', ')}（应已并入 #pathBar）`);
  }

  console.log('[path-bar-regression] 结构 PASS');
}

/* ------------------------------------------------------------ 2. 纯函数 */

function makeDeps(win) {
  const tree = win.RendererSidebarTree || {};
  const ZH = {
    'path.crumbRoot': '所有目录',
    'path.crumbExpand': '展开完整路径',
    'path.crumbSwitch': '切换到同级目录',
    'path.folderOverview': '\u{1F5C2}\uFE0F 所有目录',
  };
  return {
    normalizePath: tree.normalizePath,
    isAncestorOf: tree.isFolderPathAncestor,
    t: (k) => ZH[k] || k,
    escapeHtml: (s) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    escapeAttr: (s) =>
      String(s || '')
        .replace(/\\/g, '/')
        .replace(/'/g, "\\'"),
  };
}

/**
 * 沙箱里的数组与宿主数组原型不同， 会判成不等（本项目既有坑：
 * browse-grid-style-regression 踩过同一个）。统一转成宿主数组再断言。
 */
function host(arr, fn) {
  return Array.from(arr, fn);
}

function testPure() {
  const win = loadModules(['sidebar-tree.js', 'path-crumbs.js']);
  const crumbs = win.RendererPathCrumbs;
  assert.ok(crumbs && typeof crumbs.mount === 'function', 'path-crumbs.js 未导出 mount');
  const deps = makeDeps(win);
  const roots = [
    { id: 1, name: 'COS', path: 'K:\\COS', photo_count: 5586 },
    { id: 2, name: 'T', path: 'G:\\T', photo_count: 11843 },
  ];

  // --- parentPathOf：根目录没有上级，深层逐级回退 ---
  assert.equal(crumbs.parentPathOf('K:\\COS', roots, deps), '', '根目录不该有上级');
  assert.equal(crumbs.parentPathOf('K:\\COS\\a', roots, deps), 'K:\\COS');
  assert.equal(
    crumbs.parentPathOf('K:\\COS\\a\\b', roots, deps),
    'K:\\COS\\a',
    '深层目录的上级应是它的直接父目录',
  );
  assert.equal(crumbs.parentPathOf('', roots, deps), '', '空路径没有上级');

  // --- buildSegments：命中根目录时整根算一段 ---
  const segOfRoot = crumbs.buildSegments('K:\\COS', roots, deps);
  assert.deepEqual(
    host(segOfRoot, (s) => s.name),
    ['所有目录', 'COS'],
    '根目录应显示成「所有目录 › COS」（而不是 K: › COS 两段）',
  );
  assert.equal(segOfRoot[0].path, '', '第一段必须是总览（path 为空串）');
  assert.equal(segOfRoot[0].isOverview, true, '第一段要打 isOverview，渲染时才知道它是回总览的入口');

  const deep = crumbs.buildSegments('K:\\COS\\2024-云南行\\大理', roots, deps);
  assert.deepEqual(
    host(deep, (s) => s.name),
    ['所有目录', 'COS', '2024-云南行', '大理'],
  );
  assert.deepEqual(
    host(deep, (s) => s.path),
    ['', 'K:\\COS', 'K:\\COS\\2024-云南行', 'K:\\COS\\2024-云南行\\大理'],
    '每段要带自己的完整路径（点击直接 viewFolder，不必逐级拼）',
  );

  // 反向斜杠也要能算（escapeAttr 会把 data-crumb-path 里的 \ 换成 /）
  assert.deepEqual(
    host(crumbs.buildSegments('K:/COS/2024-云南行', roots, deps), (s) => s.name),
    ['所有目录', 'COS', '2024-云南行'],
    '正斜杠路径要与反斜杠等价',
  );

  // --- siblingsOf：要的是**兄弟**目录，不是子目录 ---
  // 第一版这里取成了 queryChildFolders(currentPath)，于是叶子目录上点开永远是空的
  // （叶子没有子目录），而且「横向换同级」这件事根本没实现。用「问了哪个路径」把它钉住。
  const asked = [];
  const sibDeps = Object.assign({}, deps, {
    queryChildFolders: function (p) {
      asked.push(p);
      if (p === 'K:\\COS\\2024-云南行') {
        return [
          { name: '大理', fullPath: 'K:\\COS\\2024-云南行\\大理', photoCount: 10 },
          { name: '丽江', fullPath: 'K:\\COS\\2024-云南行\\丽江', photoCount: 20 },
        ];
      }
      if (p === 'K:\\COS\\2024-云南行\\大理') {
        return [{ name: '洱海', fullPath: 'K:\\COS\\2024-云南行\\大理\\洱海', photoCount: 5 }];
      }
      return null;
    },
  });
  const sib = crumbs.siblingsOf('K:\\COS\\2024-云南行\\大理', roots, sibDeps);
  assert.deepEqual(
    asked,
    ['K:\\COS\\2024-云南行'],
    '同级目录应问**父目录**的子目录，而不是当前目录自己的子目录',
  );
  assert.deepEqual(
    host(sib, (n) => n.name),
    ['大理', '丽江'],
    '同级列表要含当前项自己（渲染时标 is-current，让用户看见自己在哪）',
  );
  const rootSib = crumbs.siblingsOf('K:\\COS', roots, sibDeps);
  assert.deepEqual(
    host(rootSib, (n) => n.name),
    ['COS', 'T'],
    '根目录没有父目录，同级应是其他根目录',
  );
  assert.equal(
    rootSib[0].photoCount,
    5586,
    '根目录的计数字段是 photo_count，要归一成 photoCount（否则下拉里的数字恒为 0）',
  );
  assert.equal(rootSib[1].photoCount, 11843, '第二个根目录的计数也要归一');
  assert.equal(crumbs.siblingsOf('', roots, sibDeps), null, '空路径应返回 null');

  // --- visibleSegments：≤4 段全显，>4 折中间 ---
  // 「所有目录」+ COS + a/b/c = 5 段。注意根目录**算一段**（不是 K: / COS 两段），
  // 所以段数 = 目录层数 + 2，别按 1:1 数。
  const seg5 = crumbs.buildSegments('K:\\COS\\a\\b\\c', roots, deps);
  assert.equal(seg5.length, 5, '夹具自证：应算成 5 段');
  const folded = crumbs.visibleSegments(seg5, false);
  assert.equal(folded.length, 4, '折叠后应只剩 4 个位（首段 + … + 末两段）');
  assert.equal(folded[0].seg.name, '所有目录', '折起时必须保住第一段 —— 那是回总览的唯一入口');
  assert.equal(folded[1].ellipsis, true, '第二位应是省略号');
  assert.deepEqual(
    host(folded.slice(2), (x) => x.seg.name),
    ['b', 'c'],
    '折起后末两段要留（末段是当前层，倒数第二段是它的上级）',
  );
  const all = crumbs.visibleSegments(seg5, true);
  assert.equal(all.length, 5, '展开后应显示全部段');
  assert.equal(
    crumbs.visibleSegments(crumbs.buildSegments('K:\\COS\\a', roots, deps), false).length,
    3,
    '≤4 段不该折叠',
  );

  // --- renderHtml：字形 / 末段语义 / 分隔符 / 折叠按钮 ---
  const html = crumbs.renderHtml(deep, false, deps);
  assert.equal(/[▶▼►▾]/.test(html), false, '面包屑不得出现箭头字形（样式统一用 CSS 画）');
  assert.equal(
    (html.match(/data-crumb-path=/g) || []).length,
    3,
    '非末段都应可点跳该层（所有目录 / COS / 2024-云南行 共 3 个）',
  );
  assert.equal(
    (html.match(/data-crumb-current/g) || []).length,
    1,
    '末段应恰好 1 个（它是当前层，点了开同级下拉而不是再跳一次）',
  );
  assert.ok(/aria-haspopup="menu"/.test(html), '末段要有 aria-haspopup（它是下拉触发器）');
  assert.ok(/aria-expanded="false"/.test(html), '末段初始 aria-expanded 应为 false');
  assert.equal(
    (html.match(/class="path-crumb-sep"/g) || []).length,
    3,
    '4 段之间应有 3 个分隔符',
  );

  const foldedHtml = crumbs.renderHtml(seg5, false, deps);
  assert.equal(
    (foldedHtml.match(/data-crumb-expand/g) || []).length,
    1,
    '折起时应有且仅有 1 个展开按钮',
  );
  assert.ok(
    /class="path-crumb is-ellipsis"/.test(foldedHtml),
    '展开按钮要走 .is-ellipsis（省略号由 CSS ::before 画，不写字形）',
  );

  // 总览态（只有一段）交给调用方写纯文本，渲染器返回空串
  assert.equal(crumbs.renderHtml([{ name: '所有目录', path: '' }], false, deps), '');

  console.log('[path-bar-regression] 纯函数 PASS');
}

/* ------------------------------------------------------- 3. 接线 / 退化 */

function testWiring() {
  const app = stripComments(read('src/renderer/app.js'));
  const tree = stripComments(read('src/renderer/sidebar-tree.js'));

  // mount 的每个必需 dep 都要接上：漏一项是「点了没反应」级别，不报错
  const requiredDeps = [
    'normalizePath',
    'isAncestorOf',
    'queryChildFolders',
    'getState',
    'escapeHtml',
    'escapeAttr',
    'formatNumber',
    'onNavigateFolder',
    'onNavigateOverview',
  ];
  const mountIdx = app.indexOf('RendererPathCrumbs.mount');
  assert.ok(mountIdx > 0, 'app.js 里没找到 path-crumbs 的 mount 调用（面包屑根本没接上）');
  const mountSrc = app.slice(mountIdx, app.indexOf('updatePathBar()', mountIdx));
  const missing = requiredDeps.filter((d) => mountSrc.indexOf(d + ':') < 0);
  assert.deepEqual(missing, [], `mount 的 deps 漏接：${missing.join(', ')}（运行期静默失效）`);

  // bind() 必须被调，否则整条路径栏点了都没反应
  assert.ok(
    /pathCrumbs\.bind\(\)/.test(app),
    'app.js 没有调用 pathCrumbs.bind() —— 面包屑与上级按钮都不会响应点击',
  );
  // refresh 与 updateUp 要在路径变化时被刷新到
  assert.ok(/pathCrumbs\.refresh\(\)/.test(app), 'app.js 没有调 pathCrumbs.refresh()');
  assert.ok(
    /pathCrumbs\.updateUp\(\)/.test(app),
    'app.js 没有调 pathCrumbs.updateUp()（上级按钮的可见性会停在初始态）',
  );

  // path-crumbs.js 必须被 index.html 加载，且排在 app.js 之前
  const html = read('src/renderer/index.html');
  const scriptIdx = html.indexOf('src="path-crumbs.js"');
  const appScriptIdx = html.indexOf('src="app.js"');
  assert.ok(scriptIdx > 0, 'index.html 没加载 path-crumbs.js');
  assert.ok(
    appScriptIdx < 0 || scriptIdx < appScriptIdx,
    'path-crumbs.js 必须排在 app.js 之前（否则 mount 时模块还不存在）',
  );

  // 同级下拉的数据源是 sidebar-tree 的内存索引，必须真的导出
  assert.ok(
    /queryChildFolders: queryChildFolders/.test(tree),
    'sidebar-tree.js 没有导出 queryChildFolders（同级下拉会永远打不开）',
  );
  assert.ok(
    /scrollActiveFolderIntoView: scrollActiveFolderIntoView/.test(tree),
    'sidebar-tree.js 没有导出 scrollActiveFolderIntoView',
  );

  // 滚动收尾：必须是「包装 + 手算 scrollTop」，不能退化成 scrollIntoView()
  const expandIdx = tree.indexOf('function expandTreeToFolder(targetPath) {');
  assert.ok(expandIdx > 0, 'sidebar-tree.js 里 expandTreeToFolder 结构变了');
  const expandSrc = tree.slice(expandIdx, tree.indexOf('function expandTreeToFolderInner', expandIdx));
  assert.ok(
    /scrollActiveFolderIntoView\(\)/.test(expandSrc),
    'expandTreeToFolder 没有收尾滚动 —— 深层目录展开后当前行在侧栏视口外，看不见自己在哪',
  );
  const scrollIdx = tree.indexOf('function scrollActiveFolderIntoView()');
  assert.ok(scrollIdx > 0, '未找到 scrollActiveFolderIntoView');
  const scrollSrc = tree.slice(scrollIdx, tree.indexOf('function isDirectChildOf', scrollIdx));
  assert.equal(
    /\.scrollIntoView\(/.test(scrollSrc),
    false,
    'scrollActiveFolderIntoView 里出现了 scrollIntoView() —— 它会连祖先滚动容器一起调整，' +
      '把整页带走；应显式改 #sidebarContent.scrollTop',
  );
  assert.ok(
    /\.scrollTop/.test(scrollSrc),
    'scrollActiveFolderIntoView 没有动 scrollTop（那就没真的滚）',
  );

  console.log('[path-bar-regression] 接线 PASS');
}

function main() {
  testStructure();
  testPure();
  testWiring();
  console.log('[path-bar-regression] PASS');
}

main();
