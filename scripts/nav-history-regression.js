'use strict';
/**
 * 导航历史（后退 / 前进）回归。
 *
 * 背景：面包屑解决了「跳到第 N 层祖先」，但解决不了「刚才在另一个目录」。加了访问历史后，
 * 有五类东西会**静默**坏掉 —— ESLint、截图、点一遍都不一定发现：
 *
 *   1. `applyLocation` 期间没抑制记录 —— 点一次「后退」先把目标位置记成新的一步，
 *      栈原地长出来，按钮态越点越怪（能点但就是回不去）。
 *   2. 位置键漏字段 —— 「所有文件」与「所有日期」都算 `view:'all'`，不带上 date/tab 就撞键，
 *      后退会卡在原地（栈顶被判成"同一位置"）。
 *   3. `keyIntent` 把**无修饰键**的 ←/→ 也吃掉 —— 那是预览翻页的键，会变成一按就跳目录。
 *   4. 恢复位置时给 `showTabContent` 传了 fromTab —— 它会套用 tabMemory，
 *      把刚要恢复的位置覆盖成「上次在这个 tab 的位置」。
 *   5. 某个 view* 入口漏记 —— 那个入口进去之后再点后退，会退回再上一个位置（错一格）。
 *
 * 纯函数与 mount 行为都**直接引线上本体**（vm 沙箱加载 nav-history.js），不复刻栈逻辑。
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

/** 剥注释（HTML 注释也要剥，本仓多处说明写在 `<!-- -->` 里） */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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
    Date,
  };
  sandbox.globalThis = sandbox;
  win.document = doc;
  win.addEventListener = () => {};
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, f), 'utf8'), sandbox, { filename: f });
  }
  return win;
}

function fakeBtn() {
  return {
    disabled: false,
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    addEventListener() {},
  };
}

/* ---------------------------------------------------------------- 1. 结构 */

function testStructure() {
  const html = read('src/renderer/index.html');
  const barIdx = html.indexOf('id="pathBar"');
  const backIdx = html.indexOf('id="pathBack"');
  const fwdIdx = html.indexOf('id="pathForward"');
  const upIdx = html.indexOf('id="pathUp"');
  const pathIdx = html.indexOf('id="currentPath"');

  assert.ok(barIdx > 0, 'index.html 里没有 #pathBar');
  assert.ok(backIdx > barIdx, '#pathBack 应在 #pathBar 之内');
  assert.ok(fwdIdx > backIdx, '#pathForward 应排在 #pathBack 之后（后退在前是通行顺序）');
  assert.ok(upIdx > fwdIdx, '#pathUp 应排在两个历史按钮之后、面包屑之前');
  assert.ok(pathIdx > upIdx, '#currentPath 仍在最右');

  // 三个按钮的图形必须互不相同：退化成「两个左箭头」用户分不清哪个是上一级
  const seg = (a, b) => html.slice(a, b);
  const backTag = seg(backIdx, fwdIdx);
  const fwdTag = seg(fwdIdx, upIdx);
  const upTag = seg(upIdx, pathIdx);
  const CHEVRON_LEFT = '15 18 9 12 15 6';
  const CHEVRON_RIGHT = '9 18 15 12 9 6';
  const CHEVRON_UP = '6 15 12 9 18 15';
  assert.ok(backTag.includes(CHEVRON_LEFT), '#pathBack 应是左箭头');
  assert.ok(fwdTag.includes(CHEVRON_RIGHT), '#pathForward 应是右箭头');
  assert.ok(upTag.includes(CHEVRON_UP), '#pathUp 应改成上箭头');
  assert.equal(
    upTag.includes(CHEVRON_LEFT),
    false,
    '#pathUp 仍是左箭头 —— 加了后退按钮后两个左箭头撞脸，必须区分',
  );

  // 初始都是灰的：此时栈里只有启动落点，点了没反应
  for (const [id, tag] of [
    ['#pathBack', backTag],
    ['#pathForward', fwdTag],
  ]) {
    assert.ok(/\sdisabled/.test(tag), `${id} 初始应 disabled（栈里只有当前位置）`);
    assert.ok(/type="button"/.test(tag), `${id} 缺 type="button"（在表单语境里会变成提交按钮）`);
    assert.ok(/aria-label=/.test(tag), `${id} 缺 aria-label`);
  }

  console.log('[nav-history-regression] 结构 PASS');
}

/* ------------------------------------------------------------ 2. 纯函数 */

function testPure() {
  const win = loadModules(['shortcuts.js', 'nav-history.js']);
  const nav = win.RendererNavHistory;
  assert.ok(nav && typeof nav.mount === 'function', 'nav-history.js 未导出 mount');

  // --- keyOf：四个字段全参与 ---
  const A = { view: 'folder', path: 'K:\\COS\\a', tab: 'folders' };
  assert.equal(nav.keyOf(A), nav.keyOf({ view: 'folder', path: 'K:\\COS\\a', tab: 'folders' }));
  assert.notEqual(nav.keyOf(A), nav.keyOf({ view: 'folder', path: 'K:\\COS\\b', tab: 'folders' }));
  assert.notEqual(
    nav.keyOf({ view: 'all', tab: 'folders' }),
    nav.keyOf({ view: 'all', tab: 'dates' }),
    '同一个「所有文件」挂在两个 tab 下不是同一个位置',
  );
  assert.notEqual(
    nav.keyOf({ view: 'all', date: '2024-01-01' }),
    nav.keyOf({ view: 'all', date: '' }),
    '「所有文件」与「所有日期」view 都是 all，必须靠 date 区分开 —— 否则后退卡在原地',
  );
  assert.equal(nav.keyOf(null), '');

  // --- pushEntry：幂等 / 截断 / 上限 ---
  const one = nav.pushEntry([], -1, A, 60);
  assert.equal(one.index, 0);
  assert.equal(one.changed, true);
  const again = nav.pushEntry(one.entries, one.index, A, 60);
  assert.equal(again.changed, false, '同一位置连点不该长栈');
  assert.equal(again.entries.length, 1);
  assert.equal(again.index, 0);

  const two = nav.pushEntry(one.entries, one.index, { view: 'all', tab: 'folders' }, 60);
  assert.equal(two.entries.length, 2);
  assert.equal(two.index, 1);
  assert.equal(nav.canGoBack(two.index), true);
  assert.equal(nav.canGoForward(two.entries, two.index), false);

  // 后退过再记新位置 → 前进分支被截断（浏览器标准行为）
  const truncated = nav.pushEntry(two.entries, 0, { view: 'favorites', tab: 'folders' }, 60);
  assert.equal(truncated.entries.length, 2, '前进分支应被截断');
  assert.equal(truncated.index, 1);
  assert.equal(nav.canGoForward(truncated.entries, truncated.index), false);

  // 超上限丢最旧
  let entries = [];
  let idx = -1;
  for (let i = 0; i < 5; i++) {
    const r = nav.pushEntry(entries, idx, { view: 'folder', path: 'p' + i, tab: 'folders' }, 3);
    entries = r.entries;
    idx = r.index;
  }
  assert.equal(entries.length, 3, '应被裁到上限 3');
  assert.equal(idx, 2);
  assert.equal(entries[0].path, 'p2', '裁掉的应是最旧的 p0 / p1');

  // null 位置不记（搜图 / 人物 / 设置不进历史）
  const noop = nav.pushEntry(two.entries, two.index, null, 60);
  assert.equal(noop.changed, false);
  assert.equal(noop.entries.length, 2);

  assert.equal(nav.canGoBack(0), false);
  assert.equal(nav.canGoBack(-1), false);
  assert.equal(nav.canGoForward([], -1), false);

  // --- keyIntent：Alt+←/→，mac 另收 Cmd+[ / ]；**无修饰键的 ←/→ 必须放行** ---
  const k = (o) => nav.keyIntent(Object.assign({ key: '', altKey: false, ctrlKey: false, metaKey: false }, o));
  assert.equal(k({ key: 'ArrowLeft', altKey: true }), 'back');
  assert.equal(k({ key: 'ArrowRight', altKey: true }), 'forward');
  assert.equal(
    k({ key: 'ArrowLeft' }),
    '',
    '无修饰键的 ← 被判成后退 —— 那是预览翻页的键，会变成一按就跳目录',
  );
  assert.equal(k({ key: 'ArrowRight' }), '');
  assert.equal(k({ key: 'ArrowLeft', ctrlKey: true }), '', 'Ctrl+← 不是导航（mac 上是切桌面）');
  assert.equal(k({ key: 'ArrowLeft', altKey: true, ctrlKey: true }), '', 'Alt+Ctrl+← 应排除');
  assert.equal(k({ key: '[', metaKey: true }), 'back');
  assert.equal(k({ key: ']', metaKey: true }), 'forward');
  assert.equal(k({ key: '[', altKey: true }), '', 'Alt+[ 不是导航（mac 上 Alt 是文本编辑）');
  assert.equal(k({ key: '[', metaKey: true, altKey: true }), '');
  assert.equal(k({ key: 'a', metaKey: true }), '');
  assert.equal(nav.keyIntent({ key: 'ArrowLeft', altKey: true, defaultPrevented: true }), '');
  assert.equal(nav.keyIntent(null), '');

  // --- sideIntent：X1 = 3 后退、X2 = 4 前进 ---
  assert.equal(nav.sideIntent({ button: 3 }), 'back');
  assert.equal(nav.sideIntent({ button: 4 }), 'forward');
  for (const b of [0, 1, 2, 5]) {
    assert.equal(nav.sideIntent({ button: b }), '', `button ${b} 不该触发历史导航`);
  }
  assert.equal(nav.sideIntent(null), '');

  console.log('[nav-history-regression] 纯函数 PASS');
}

/* ------------------------------------------- 3. mount 行为（抑制闸门） */

function testMount() {
  const win = loadModules(['shortcuts.js', 'nav-history.js']);
  const nav = win.RendererNavHistory;

  const backBtn = fakeBtn();
  const fwdBtn = fakeBtn();
  const applied = [];
  let sizeAtApply = -1;
  let described = 0;
  let h = null;

  h = nav.mount({
    back: backBtn,
    forward: fwdBtn,
    deps: {
      applyLocation: (loc) => {
        applied.push(loc.view + '|' + (loc.path || ''));
        // 模拟真实链路：applyLocation 会同步走到 view* 入口与 updateBrowsePathLabel，
        // 那两处都会调 record —— 必须被闸门挡住。
        sizeAtApply = h.size();
        h.record({ view: 'folder', path: 'K:\\COS\\不该进栈', tab: 'folders' });
      },
      describeLocation: (loc) => {
        described++;
        return loc.path || loc.view;
      },
      t: (key) => key,
    },
  });

  // 初始：栈里只有启动落点，两个按钮都灰
  h.reset({ view: 'all', tab: 'folders' });
  assert.equal(h.size(), 1);
  assert.equal(h.canBack(), false);
  assert.equal(h.canForward(), false);
  assert.equal(backBtn.disabled, true);
  assert.equal(fwdBtn.disabled, true);
  assert.equal(
    backBtn.attrs.title,
    'path.back',
    '够不到目标时按钮只写动作名 —— 写「后退：XXX」会误导（点了没反应）',
  );

  h.record({ view: 'folder', path: 'K:\\COS\\A', tab: 'folders' });
  h.record({ view: 'folder', path: 'K:\\COS\\B', tab: 'folders' });
  assert.equal(h.size(), 3);
  assert.equal(h.canBack(), true);
  assert.equal(backBtn.disabled, false);
  assert.equal(fwdBtn.disabled, true);
  assert.equal(
    backBtn.attrs.title,
    '后退：K:\\COS\\A',
    '后退按钮应写出目标名（tFmt 走模块自带的 zh 兜底把 {name} 换掉）',
  );

  const beforeApply = described;
  const sizeBeforeBack = h.size();

  // --- 后退：位置回退 + 期间记录被抑制 ---
  // 注意 size() 是**条目总数**，后退只挪 index（不删条目，否则前进就没得走），
  // 所以判据是「调用前后总数不变、index 减一」，不是「总数变小」。
  assert.equal(h.back(), true);
  assert.deepEqual(applied, ['folder|K:\\COS\\A']);
  assert.equal(sizeAtApply, sizeBeforeBack, 'applyLocation 期间栈长就被改了');
  assert.equal(
    h.size(),
    sizeBeforeBack,
    'applyLocation 里那次 record 漏过闸门 —— 后退会自己长出新的一步，越点越乱',
  );
  assert.equal(h.index(), 1, '后退应只把游标挪一格');
  assert.equal(h.canForward(), true);
  assert.equal(fwdBtn.disabled, false);
  assert.ok(described > beforeApply, '前进按钮够到目标时也应写目标名');

  assert.equal(h.forward(), true);
  assert.deepEqual(applied, ['folder|K:\\COS\\A', 'folder|K:\\COS\\B']);
  assert.equal(h.size(), sizeBeforeBack);
  assert.equal(h.index(), 2);
  assert.equal(h.canForward(), false);

  // --- 端点：到栈底再后退应返回 false 且不动栈 ---
  assert.equal(h.back(), true);
  assert.equal(h.back(), true);
  assert.equal(h.canBack(), false);
  assert.equal(h.size(), 3);
  assert.equal(h.back(), false, '已在栈底，后退应返回 false');
  assert.equal(applied.length, 4, '越界调用不该触发 applyLocation');

  // --- 前进分支截断：后退后记新位置 ---
  h.record({ view: 'favorites', tab: 'folders' });
  assert.equal(h.size(), 2, '从栈底记新位置应截断掉前进分支');
  assert.equal(h.canForward(), false);
  assert.equal(h.entryAt(1).view, 'favorites');

  // --- reset 清掉启动中间态 ---
  h.reset({ view: 'folder_overview', tab: 'folders' });
  assert.equal(h.size(), 1);
  assert.equal(h.canBack(), false);
  assert.equal(h.canForward(), false);
  assert.equal(backBtn.disabled, true);

  // --- null 位置不记（搜图 / 人物页） ---
  const sizeBefore = h.size();
  assert.equal(h.record(null), false);
  assert.equal(h.size(), sizeBefore);

  console.log('[nav-history-regression] mount 行为 PASS');
}

/* ------------------------------------------------------- 4. 接线 / 退化 */

function testWiring() {
  const app = stripComments(read('src/renderer/app.js'));
  const html = read('src/renderer/index.html');
  const css = stripComments(read('src/renderer/styles.css'));
  const i18n = read('src/renderer/i18n.js');

  // mount 的必需 dep：漏一项就是「按钮点了没反应 / 文案是 key 名」
  const mountIdx = app.indexOf('RendererNavHistory.mount');
  assert.ok(mountIdx > 0, 'app.js 里没找到 nav-history 的 mount 调用（历史栈根本没接上）');
  const mountSrc = app.slice(mountIdx, app.indexOf('function recordBrowseLocation', mountIdx));
  for (const dep of ['applyLocation', 'describeLocation', 't', 'tFmt', 'canNavigate']) {
    assert.ok(mountSrc.includes(dep + ':'), `mount 的 deps 漏接 ${dep}（运行期静默失效）`);
  }
  assert.ok(/navHistory\.bind\(\)/.test(app), '没有调用 navHistory.bind() —— 按钮和快捷键全不响应');

  // 六个导航入口都要记：漏一个，从该入口进去再点后退会退回再上一个位置（错一格）
  const views = [
    'viewAllPhotos',
    'viewFavorites',
    'viewDuplicates',
    'viewAllFolderCovers',
    'viewFolder',
    'viewDate',
  ];
  for (const fn of views) {
    const i = app.indexOf('function ' + fn + '(');
    assert.ok(i > 0, `app.js 里找不到 ${fn}（夹具漂了）`);
    const end = app.indexOf('\nfunction ', i + 1);
    const body = app.slice(i, end > i ? end : app.length);
    assert.ok(body.includes('recordBrowseLocation()'), `${fn} 没记导航历史`);
  }

  // 兜底记录口：切 tab / 软返回等隐式改位置的路径
  const ubpIdx = app.indexOf('function updateBrowsePathLabel()');
  assert.ok(ubpIdx > 0, '找不到 updateBrowsePathLabel（夹具漂了）');
  const ubpSrc = app.slice(ubpIdx, app.indexOf('\nfunction ', ubpIdx + 1));
  assert.ok(
    ubpSrc.includes('recordBrowseLocation()'),
    'updateBrowsePathLabel 没有兜底记录 —— 切 tab / 从设置软返回改的位置不会进历史',
  );

  // 启动落地后要重建栈，否则第一次后退退到「启动时的默认落点」
  const landingIdx = app.indexOf('applyStartupLandingPage();');
  const resetIdx = app.indexOf('navHistory.reset(');
  assert.ok(resetIdx > 0, 'app.js 没有调 navHistory.reset()');
  assert.ok(
    resetIdx > landingIdx,
    'navHistory.reset() 必须在 applyStartupLandingPage() 之后 —— 顺序反了会把落点判定过程记进栈',
  );

  // 恢复位置的三个硬约束
  const capIdx = app.indexOf('function captureBrowseLocation()');
  assert.ok(capIdx > 0, '找不到 captureBrowseLocation');
  const capSrc = app.slice(capIdx, app.indexOf('\nfunction ', capIdx + 1));
  assert.ok(
    capSrc.includes('BROWSABLE_VIEWS'),
    'captureBrowseLocation 应走白名单（搜图 / 人物 / 设置各有独立视图态，不该进这条栈）',
  );
  // 路径只能进 folder 分支：`viewAllPhotos()` 不清 currentPath（下面有夹具自证），
  // 把 path 塞进 all/favorites 的键，会让同一个「所有文件」因上一个目录不同而算出两个位置。
  const dateBranchIdx = capSrc.indexOf("view === 'date'");
  assert.ok(dateBranchIdx > 0, 'captureBrowseLocation 结构变了（找不到 date 分支）');
  assert.equal(
    capSrc.slice(dateBranchIdx).includes('state.currentPath'),
    false,
    'all / favorites / folder_overview / duplicates 分支里出现了 currentPath —— ' +
      '这些视图不依赖它，塞进位置键会算假位置',
  );
  // 夹具自证：上面那条约束之所以成立，是因为 viewAllPhotos 不清 path。
  const vapIdx = app.indexOf('function viewAllPhotos(');
  const vapSrc = app.slice(vapIdx, app.indexOf('\nfunction ', vapIdx + 1));
  assert.equal(
    /state\.currentPath\s*=/.test(vapSrc),
    false,
    'viewAllPhotos 现在会清 currentPath 了 —— 可以放宽上面那条约束（本条是夹具自证，不是契约）',
  );

  const applyIdx = app.indexOf('function applyBrowseLocation(');
  assert.ok(applyIdx > 0, '找不到 applyBrowseLocation');
  const applySrc = app.slice(applyIdx, app.indexOf('\nvar navHistory', applyIdx));
  assert.ok(
    /showTabContent\(tab\)/.test(applySrc),
    'applyBrowseLocation 没有把 tab 切过去 —— 从日期 tab 后退回文件夹时会留下状态不一致',
  );
  assert.equal(
    /showTabContent\(tab\s*,/.test(applySrc),
    false,
    'applyBrowseLocation 给 showTabContent 传了第二参 —— fromTab 会触发 applyBrowseTabMemory，' +
      '用「上次在这个 tab 的位置」把要恢复的位置覆盖掉',
  );

  // 脚本加载顺序
  const scriptIdx = html.indexOf('src="nav-history.js"');
  const appScriptIdx = html.indexOf('src="app.js"');
  assert.ok(scriptIdx > 0, 'index.html 没加载 nav-history.js');
  assert.ok(
    appScriptIdx < 0 || scriptIdx < appScriptIdx,
    'nav-history.js 必须排在 app.js 之前（否则 mount 时模块还不存在）',
  );

  // 动画/禁用态样式
  assert.ok(/\.path-nav\b/.test(css), 'styles.css 缺少 .path-nav 规则（新按钮没有形状）');
  assert.ok(/\.path-nav:disabled/.test(css), 'styles.css 缺少 .path-nav:disabled（栈底看不出不能点）');

  // i18n：zh / en 两份都要有，否则英文界面会露出 key 名
  for (const key of ['path.back', 'path.forward', 'path.backFmt', 'path.forwardFmt', 'path.favorites']) {
    const n = (i18n.match(new RegExp("'" + key.replace('.', '\\.') + "'", 'g')) || []).length;
    assert.equal(n, 2, `i18n.js 里 '${key}' 应中英各一份，实际 ${n} 份`);
  }

  console.log('[nav-history-regression] 接线 PASS');
}

function main() {
  testStructure();
  testPure();
  testMount();
  testWiring();
  console.log('[nav-history-regression] PASS');
}

main();
