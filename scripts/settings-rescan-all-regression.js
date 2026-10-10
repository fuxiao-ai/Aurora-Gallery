'use strict';
/**
 * 设置页「媒体库」面板头部的 **重新扫描全部** —— 回归。
 *
 * 背景：目录行里本来每个根目录各有一枚「重新扫描」，但用户报过「新增目录后看不到」
 * 那类问题（见 `sidebar-tree-regression` §12 / `media-library-refresh-regression`）。
 * 现在面板级补一枚**一次重扫全部根目录**的按钮，本回归钉住它的三条要害：
 *
 *   1. **按钮落在「媒体库」面板头部**，与「添加目录」并排（不是别处，也不是网页端 ——
 *      网页端设置页是桌面端的**只读镜像**，扫描动作一律留在桌面端）。
 *   2. 🔴 **根目录列表由主进程读库决定**，渲染端**不得**把自己那份 `state.rootFolders`
 *      当参数塞进去。那份是可能过时的缓存 —— 扫描刚在库里登记了新根、渲染端这一拍还没
 *      同步到时它是空的，结果就是「点了没反应」。同理按钮**不按目录数置灰**：
 *      空库由主进程回答（`error: 'empty'`），拿缓存当闸门只会造出「明明有目录却是灰的」。
 *   3. **一次点击 = 一整批**：N 个根目录一次性排上、等全部跑完才回；忙碌期间重复点击
 *      不重复入队；结束后必须停掉实时刷新并把列表 / 统计拉一次。
 *
 * `src/renderer/api.js` 与 `src/renderer/scan-flow.js` 都载入**真实源码**，只有最外层的
 * `photoAPI` 是假的 —— 所以 `app.js → api.js → photoAPI` 这条链是真跑的。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// 通用 fake DOM
// ---------------------------------------------------------------------------
function makeEl(extra) {
  const classes = new Set();
  const attrs = Object.create(null);
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
    setAttribute(n, v) {
      attrs[n] = String(v);
    },
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null;
    },
    removeAttribute(n) {
      delete attrs[n];
    },
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
// 1. 按钮位置：必须在「媒体库」面板区间内
// ---------------------------------------------------------------------------
/**
 * 按 `[data-settings-panel]` 把 index.html 切成面板块。
 * 与 `navigation-regression` 同一套解析法（解析而非硬编码期望值，增减面板不会假红）。
 */
function panelBlocks(html) {
  const ids = [];
  const idRe = /id="(settingsSection[A-Za-z]+)"/g;
  let m;
  while ((m = idRe.exec(html))) ids.push({ id: m[1], at: m.index });
  const starts = [];
  const panelRe = /data-settings-panel/g;
  let p;
  while ((p = panelRe.exec(html))) starts.push(p.index);
  const blocks = Object.create(null);
  for (let i = 0; i < ids.length; i++) {
    const from = starts[i] !== undefined ? starts[i] : ids[i].at;
    const to = starts[i + 1] !== undefined ? starts[i + 1] : html.length;
    blocks[ids[i].id] = html.slice(from, to);
  }
  return { ids: ids.map((x) => x.id), blocks };
}

function testButtonPlacement() {
  const html = read('src/renderer/index.html');
  const { blocks } = panelBlocks(html);
  assert.ok(blocks.settingsSectionFolders, '夹具自证：「媒体库」面板存在');

  const libBlock = blocks.settingsSectionFolders;

  // ⚠️ 「在媒体库面板里」+「全文档只有一处」两条必须**同时**成立。只查前者不够：
  // 面板块是按 `[data-settings-panel]` 位置切的（与 navigation-regression 同一套），
  // 而 `id="settingsSectionXxx"` 写在 `data-settings-panel` **之前** —— 于是两个块之间存在
  // 一段「哪个块都不算」的缝隙，插在那里的副本前一条断言看不见。计数断言堵住这个洞。
  assert.equal(
    html.split('id="settingsRescanAllBtn"').length - 1,
    1,
    '「重新扫描全部」在 index.html 里只能有一处（两个入口 = 两套真相）',
  );
  assert.ok(
    libBlock.includes('id="settingsRescanAllBtn"'),
    '「重新扫描全部」必须落在「媒体库」面板里（和「添加目录」「目录列表」同一屏）',
  );
  assert.ok(
    libBlock.indexOf('id="settingsRescanAllBtn"') < libBlock.indexOf('id="settingsFolderList"'),
    '按钮要在目录列表**之前**（面板头部动作区），不是列表下面',
  );
  assert.ok(
    libBlock.includes('settings-header-actions'),
    '按钮住在头部动作区（与「添加目录」并排）',
  );
  assert.ok(
    libBlock.includes('data-i18n="settings.rescanAll"'),
    '按钮文案走 data-i18n（双语是硬要求）',
  );

  // 网页端设置页是桌面端的只读镜像：扫描一律在桌面端做（面板 desc 里写死了这句）
  const webSettings = read('src/web/js/settings-page.js');
  assert.ok(
    !webSettings.includes('rescanAll') && !webSettings.includes('rescan-all'),
    '网页端设置页是只读镜像，不得长出「重新扫描全部」入口',
  );

  // 双语键齐全：漏一个不会报错，界面直接显示裸键名 settings.rescanAll
  const i18n = read('src/renderer/i18n.js');
  for (const key of [
    'settings.rescanAll',
    'settings.rescanAllTitle',
    'settings.rescanAllBusy',
    'settings.rescanAllPreparing',
    'settings.rescanAllConfirm',
    'settings.rescanAllEmpty',
    'settings.rescanAllFail',
    'settings.rescanAllPartialFail',
  ]) {
    const hits = i18n.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `i18n 里 '${key}' 应中英各一份（实际 ${hits} 处）`);
  }
}

// ---------------------------------------------------------------------------
// 2. IPC 三层闭合（main / preload / renderer api）
// ---------------------------------------------------------------------------
function testIpcThreeLayers() {
  const mainSrc = read('src/main.js');
  const at = mainSrc.indexOf("ipcMain.handle('rescan-all-folders'");
  assert.ok(at > 0, '主进程必须注册 rescan-all-folders');
  let end = mainSrc.indexOf('// 窗口控制', at);
  if (end < 0) end = Math.min(mainSrc.length, at + 6000);
  const handler = mainSrc.slice(at, end);

  // 🔴 处理器**连入参都没有**：渲染端不可能把目录列表塞进来，来源只能是主进程读库。
  //    （改成 function (event, paths) 就会红 —— 那正是「用渲染端可能过时的缓存」的入口。）
  const sig = handler.match(
    /ipcMain\.handle\('rescan-all-folders',\s*async\s+function\s*\(([^)]*)\)/,
  );
  assert.ok(sig, '处理器题名可解析（夹具自证）');
  assert.equal(
    sig[1].trim(),
    '',
    '🔴 处理器不得有入参：根目录列表只能由主进程读库决定，不能从渲染端接',
  );
  assert.ok(
    handler.includes('runDbReadWorkerOnly') && handler.includes("'getRootFolders'"),
    '🔴 根目录列表必须走只读 Worker 读库拿到（渲染端 state.rootFolders 是可能过时的缓存）',
  );
  assert.ok(
    handler.includes("enqueueScanTask({ source: 'rescan'"),
    '每个根目录都按「手动重扫」同档（source: rescan → PRIORITY.USER）入队',
  );
  assert.ok(
    handler.includes('Promise.all'),
    '要把整批一起等完再返回（否则渲染端会在扫描还没结束时就刷新列表）',
  );

  const preload = read('src/preload.js');
  assert.ok(
    /rescanAllFolders:\s*function\s*\(\)\s*\{\s*return ipcRenderer\.invoke\('rescan-all-folders'\)/.test(
      preload,
    ),
    'preload 必须桥出 rescanAllFolders → invoke(rescan-all-folders)',
  );

  const rendererApi = read('src/renderer/api.js');
  assert.ok(
    /rescanAllFolders:\s*function\s*\(\)\s*\{\s*return call\('rescanAllFolders'\);/.test(
      rendererApi,
    ),
    '渲染端 api.js 必须暴露 rescanAllFolders（否则 handleSettingsRescanAll 静默 return）',
  );
}

// ---------------------------------------------------------------------------
// 3. 行为：vm 载入真实 app.js，驱动真实 handleSettingsRescanAll
// ---------------------------------------------------------------------------
function loadRenderer() {
  const els = new Map();
  const elFor = (id) => {
    if (!els.has(id)) els.set(id, makeEl({ id }));
    return els.get(id);
  };

  const win = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1400,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };

  const ctx = {
    window: win,
    document: {
      documentElement: makeEl({ lang: 'zh-CN' }),
      body: makeEl(),
      getElementById: (id) => elFor(id),
      querySelector: (sel) =>
        typeof sel === 'string' && sel.charAt(0) === '#' ? elFor(sel.slice(1)) : null,
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      createElementNS: () => makeEl(),
      addEventListener() {},
      removeEventListener() {},
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

  // --- 真实 api.js（含真实的 call() → photoAPI 转发）---
  vm.runInContext(read('src/renderer/api.js'), ctx, { filename: 'renderer/api.js' });
  // --- 真实 scan-flow.js（updateProgress 的进度文案要真跑）---
  vm.runInContext(read('src/renderer/scan-flow.js'), ctx, { filename: 'renderer/scan-flow.js' });

  // --- photoAPI：最外层唯一假的东西 ---
  const pending = [];
  const photoAPI = {
    rescanAllFolders(...args) {
      photoAPI.calls.push(args);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    getRootFolders() {
      return Promise.resolve([]);
    },
  };
  photoAPI.calls = [];
  win.photoAPI = photoAPI;

  // --- 对话框：确认结果可控、警告记录下来 ---
  let confirmResult = true;
  const alerts = spy();
  win.RendererDialogUI = {
    appConfirm: () => Promise.resolve(confirmResult),
    appAlert: alerts,
  };
  ctx.__setConfirm = (v) => {
    confirmResult = v;
  };
  ctx.__alerts = alerts;
  ctx.__photoAPI = photoAPI;
  ctx.__settle = (payload) => {
    const list = pending.splice(0, pending.length);
    for (const p of list) p.resolve(payload);
    return list.length;
  };

  // --- 目录列表渲染器：只 spy 最内层，让 renderSettingsFolderList 真跑 ---
  const settingsRows = spy();
  win.RendererSettingsUI = {
    renderSettingsFolderListFromRows: (folders, opts) => settingsRows(folders, opts),
  };
  win.RendererBackgroundTasksOrchestrator = {
    scheduleNextBackgroundTaskPoll() {},
    tickBackgroundTasksOnce: () => Promise.resolve(),
  };
  win.RendererSidebarUI = { ensureNormalSidebarVisible() {}, closeMobileSidebar() {} };
  win.RendererTabsUI = {};
  win.RendererTabsFlowUI = {};
  // app.js 末尾有若干**顶层**挂载语句（`window.PhotoCompare.mount(...)` /
  // `RendererAiViews.init(...)` / `PeopleUI.mount(...)`），载入时就会执行 —— 缺一个就崩在
  // 「读 undefined 的 mount」。这几个只跟本次被测链路无关，给最薄的一层壳即可。
  win.PhotoCompare = { mount: () => ({ show() {}, hide() {} }) };
  win.SemanticSearchUI = { mount: () => ({ show() {}, hide() {} }) };
  win.PeopleUI = { mount: () => ({ show() {}, hide() {} }) };
  win.RendererAiViews = {
    init: () => ({
      enter() {},
      leave() {},
      startPolling() {},
      bind() {},
      isShowing() {
        return false;
      },
    }),
  };
  // 标签导航页的界面层。⚠️ 这是**替身**，不是实现：替身表是显式列举的，
  // 产品每新增一个顶层挂载，这里就得补一桩，否则守护崩在「读 undefined 的 mount」上
  // —— 而那是**夹具**崩了，不是产品坏了（症状一样是红，归因完全不同）。
  win.RendererTagNavUI = {
    mount: () => ({
      enter() {},
      renderSidebar() {},
      renderBrowseCards() {},
      refreshLocale() {},
      selectTag() {},
      selectNode() {},
      displayName: (tag) => tag,
    }),
  };

  // --- 真实 app.js ---
  vm.runInContext(stripInit(read('src/renderer/app.js')), ctx, { filename: 'renderer/app.js' });

  // --- 把无关的落库 / 刷新动作换成 spy（只测本次新增的编排）---
  const stats = spy();
  const roots = spy();
  const stale = spy();
  const startLive = spy();
  const stopLive = spy();
  const progressSpy = spy();
  const realProgress = ctx.updateProgress;
  ctx.loadStats = () => {
    stats();
    return Promise.resolve();
  };
  ctx.loadRootFolders = () => {
    roots();
    return Promise.resolve();
  };
  ctx.markBrowseDataStale = (o) => {
    stale(o);
  };
  ctx.startScanLiveRefresh = () => {
    startLive();
  };
  ctx.stopScanLiveRefresh = () => {
    stopLive();
  };
  ctx.updateProgress = (c, t, f) => {
    progressSpy(c, t, f);
    return realProgress(c, t, f);
  };

  const btn = elFor('settingsRescanAllBtn');
  ctx.__btn = btn;
  ctx.__elFor = elFor;
  ctx.__calls = { stats, roots, stale, startLive, stopLive, settingsRows, progressSpy };
  return ctx;
}

/** 让微任务队列排空（handler 里有若干 await） */
const tick = () => new Promise((r) => setImmediate(r));

async function testRendererBehavior() {
  const ctx = loadRenderer();
  const btn = ctx.__btn;
  const state = ctx.state;
  state.rootFolders = [];
  state.rescanAllBusy = false;
  ctx.syncSettingsRescanAllBtn();

  const { stats, roots, stale, startLive, stopLive, settingsRows, progressSpy } = ctx.__calls;

  // --- 夹具自证 ---
  assert.equal(typeof ctx.handleSettingsRescanAll, 'function', '夹具自证：拿到真实处理器');
  assert.equal(
    typeof ctx.__photoAPI.rescanAllFolders,
    'function',
    '夹具自证：photoAPI 上真有 rescanAllFolders',
  );
  assert.equal(state.rescanAllBusy, false, '夹具自证：初始不是忙碌态');

  // --- 0. 🔴 按钮的置灰条件（先跑：这是纯函数契约，别被后面的行为流程挡住）---
  const { syncSettingsRescanAllBtn } = ctx;
  state.rescanAllBusy = false;
  state.rootFolders = [];
  syncSettingsRescanAllBtn();
  assert.equal(
    btn.disabled,
    false,
    '🔴 rootFolders 空不等于「库里没目录」——它是可能过时的缓存，拿它置灰会造出假死按钮',
  );
  state.rootFolders = [{ path: 'K:\\COS' }];
  syncSettingsRescanAllBtn();
  assert.equal(btn.disabled, false, '有目录时同样可点');
  state.rescanAllBusy = true;
  syncSettingsRescanAllBtn();
  assert.equal(btn.disabled, true, '只有忙碌态才置灰');
  assert.equal(btn.textContent, '正在重新扫描…', '忙碌态文案');
  state.rescanAllBusy = false;
  syncSettingsRescanAllBtn();
  assert.equal(btn.textContent, '重新扫描全部', '复位文案');
  assert.equal(btn.getAttribute('aria-busy'), 'false', 'aria-busy 要复位');

  // --- 1. 确认框点「取消」→ 一次都不发起 ---
  ctx.__setConfirm(false);
  await ctx.handleSettingsRescanAll();
  assert.equal(ctx.__photoAPI.calls.length, 0, '确认框取消后不得发起任何扫描');
  assert.equal(startLive.calls.length, 0, '取消后不该启动实时刷新');
  assert.equal(btn.disabled, false, '取消后按钮应保持可点');

  // --- 2. 确认 → 恰好一次，且**不带任何参数** ---
  ctx.__setConfirm(true);
  const run = ctx.handleSettingsRescanAll();
  await tick();
  assert.equal(ctx.__photoAPI.calls.length, 1, '确认后应恰好发起一次「重扫全部」');
  assert.deepEqual(
    ctx.__photoAPI.calls[0],
    [],
    '🔴 渲染端不得把目录列表当选参塞进去（列表只能由主进程读库决定）',
  );

  // --- 3. 忙碌期间：按钮置灰 + 文案变忙碌态，再点不重复入队 ---
  assert.equal(btn.disabled, true, '扫描期间按钮必须置灰');
  assert.equal(btn.getAttribute('aria-busy'), 'true', 'aria-busy 要跟着走（无障碍）');
  assert.equal(btn.textContent, '正在重新扫描…', '忙碌态文案');
  assert.equal(startLive.calls.length, 1, '启动一次实时刷新');

  // ⚠️ 这两下**故意不 await**：正确实现里它们被重入闸门拦在 `appConfirm` 之前、不产生新
  // pending；而一旦闸门没了，它们会发出新调用、返回的 Promise 永远没人结算 ——
  // 那样 `await` 会把本脚本**挂死**，Node 事件循环一空就 exit 0，看起来反而「全绿」。
  // 用 void + 排空微任务，断言调用数即可（含看门狗兜底，见 main()）。
  void ctx.handleSettingsRescanAll();
  void ctx.handleSettingsRescanAll();
  await tick();
  await tick();
  assert.equal(
    ctx.__photoAPI.calls.length,
    1,
    '忙碌期间重复点击不得重复入队（state.rescanAllBusy 是唯一闸门）',
  );
  // --- 4. 主进程返回整批汇总 → 收尾（停刷新 + 拉统计/目录 + 重画列表）---
  assert.equal(ctx.__settle({ success: true, total: 3, cancelled: 0, failed: 0, cleanupDeleted: 0 }), 1);
  await run;
  assert.equal(btn.disabled, false, '跑完必须恢复可点，否则永远卡在灰的');
  assert.equal(btn.getAttribute('aria-busy'), 'false', 'aria-busy 要复位');
  assert.equal(btn.textContent, '重新扫描全部', '跑完文案要回到常态');
  assert.equal(state.rescanAllBusy, false, '忙碌标志要清掉');
  assert.equal(stopLive.calls.length, 1, '跑完必须停掉实时刷新（不停就是每 3s 白跑一辈子）');
  assert.equal(stats.calls.length, 1, '跑完把统计拉一次');
  assert.equal(roots.calls.length, 1, '跑完把根目录拉一次');
  assert.equal(stale.calls.length, 1, '跑完要标浏览数据过期（下次回相册得重拉）');
  assert.equal(settingsRows.calls.length, 1, '跑完把「媒体库」目录列表重画一次');
  assert.equal(ctx.__alerts.calls.length, 0, '全部成功时不该弹窗');
  assert.match(
    String(progressSpy.calls[progressSpy.calls.length - 1][2]),
    /重扫完成，共 3 个目录/,
    '收尾文案要如实报出扫了几个目录',
  );

  // --- 4b. 标记到失效记录时，收尾文案要把条数带上 ---
  ctx.__setConfirm(true);
  const run1b = ctx.handleSettingsRescanAll();
  await tick();
  ctx.__settle({ success: true, total: 2, cancelled: 0, failed: 0, cleanupDeleted: 5 });
  await run1b;
  assert.match(
    String(progressSpy.calls[progressSpy.calls.length - 1][2]),
    /重扫完成（2 个目录），已标记失效记录 5 条/,
    '标记到失效记录时要把条数带上（与单目录「重新扫描」的措辞一致）',
  );

  // --- 5. 被「停止」打断：主进程把剩下的结算成 cancelled → 不报失败，但要说明没扫完 ---
  ctx.__setConfirm(true);
  const run2 = ctx.handleSettingsRescanAll();
  await tick();
  ctx.__settle({ success: true, total: 4, cancelled: 3, failed: 0, cleanupDeleted: 0 });
  await run2;
  assert.equal(ctx.__alerts.calls.length, 0, '用户自己按的停止不是「失败」，不该弹错误框');
  assert.match(
    String(progressSpy.calls[progressSpy.calls.length - 1][2]),
    /已停止：3 个目录未扫描完成/,
    '被停止时要如实报出还剩几个目录没扫完',
  );
  assert.equal(stats.calls.length, 3, '中途停止也要把已经扫过的结果刷新出来');

  // --- 6. 一个目录都没有：由**主进程**回答 empty，不是渲染端拿缓存判 ---
  ctx.__setConfirm(true);
  const run3 = ctx.handleSettingsRescanAll();
  await tick();
  ctx.__settle({ success: false, error: 'empty' });
  await run3;
  assert.equal(ctx.__alerts.calls.length, 1, '空库要有明确提示，不能「点了没反应」');
  assert.match(String(ctx.__alerts.calls[0][0]), /还没有添加任何目录/, '空库文案');
  assert.equal(btn.disabled, false, '空库之后按钮仍要可点（用户刚添完目录就能直接用）');
  assert.equal(state.rescanAllBusy, false, '空库也要清掉忙碌标志');

  // --- 7. 真失败：要弹错误框 ---
  ctx.__setConfirm(true);
  const run4 = ctx.handleSettingsRescanAll();
  await tick();
  ctx.__settle({ success: false, error: 'EACCES: permission denied' });
  await run4;
  assert.equal(ctx.__alerts.calls.length, 2, '真失败必须报出来');
  assert.match(String(ctx.__alerts.calls[1][0]), /EACCES/, '失败原因要带上');
  assert.equal(state.rescanAllBusy, false, '失败也要清掉忙碌标志');

  // --- 8. 部分失败：整批仍然算「跑完」，但要把失败数报出来 ---
  ctx.__setConfirm(true);
  const run5 = ctx.handleSettingsRescanAll();
  await tick();
  ctx.__settle({ success: true, total: 5, cancelled: 0, failed: 2, cleanupDeleted: 0, error: 'EPERM' });
  await run5;
  assert.equal(ctx.__alerts.calls.length, 3, '部分失败要报出来');
  assert.match(String(ctx.__alerts.calls[2][0]), /2\/5 个目录重新扫描失败/, '报出失败比例');
  assert.equal(state.rescanAllBusy, false, '收尾状态一致');

  // --- 9. 事件真的接上了（按钮不是个装饰）---
  const appSrc = read('src/renderer/app.js');
  assert.ok(
    /dom\.settingsRescanAllBtn\.addEventListener\('click',\s*handleSettingsRescanAll\)/.test(appSrc),
    '必须把 click 绑到 handleSettingsRescanAll（只画个按钮不接线 = 点了没反应）',
  );
  assert.ok(
    /settingsRescanAllBtn:\s*\$\('#settingsRescanAllBtn'\)/.test(appSrc),
    'dom 里要缓存这个节点',
  );
  // 🔴 调用点必须**不带参数**。这一条和三处「0 入参」是同一条契约的三个面：
  //   渲染端调用点 / 渲染端 api.js 的签名 / 主进程处理器签名 —— 任何一处长出「列表参数」，
  //   就等于把「根目录由谁决定」这件事交给了渲染端那份可能过时的缓存。
  //   （`api.rescanAllFolders()` 本身会丢掉多余实参，所以只靠行为断言看不出这一处退化。）
  assert.ok(
    /await api\.rescanAllFolders\(\)/.test(appSrc),
    '🔴 调用点必须是不带实参的 `api.rescanAllFolders()`',
  );
}

/** 本项目约定：每个守护都自己断言「已被 run-regressions 收编」，且位置在末项之前。 */
function testRegistered() {
  const runSrc = read('scripts/run-regressions.js');
  assert.ok(
    runSrc.includes("'settings-rescan-all-regression.js'"),
    '本守护已登记进 scripts/run-regressions.js',
  );
  assert.ok(
    runSrc.indexOf("'settings-rescan-all-regression.js'") <
      runSrc.indexOf("'ai-lifecycle-regression.js'"),
    '登记位置在末项 ai-lifecycle-regression 之前（末项约定不能破）',
  );
}

/**
 * 🔴 看门狗：任何**死等**都必须以非 0 退出码收场。
 * 不加它的话，一旦某处 `await` 了一个永远不会 resolve 的 Promise，Node 会在事件循环排空后
 * 静默 exit 0 —— 回归运行器把它当成功，于是「挂死」被记成「全绿」。
 * （真踩过：把 `state.rescanAllBusy` 重入闸门注掉后，本脚本从断言失败变成静默 exit 0。）
 */
function armWatchdog() {
  const timer = setTimeout(() => {
    console.error('[settings-rescan-all-regression] 超时未完成（疑似死等）—— 按失败计');
    process.exit(1);
  }, 15000);
  // ⚠️ 这里**不能** unref：unref 掉的定时器撑不住事件循环，死等时进程会先一步静默 exit 0，
  // 看门狗等于没装。正常收尾靠 clearTimeout 让进程自然退出。
  return timer;
}

async function main() {
  const watchdog = armWatchdog();
  testButtonPlacement();
  testIpcThreeLayers();
  testRegistered();
  await testRendererBehavior();
  clearTimeout(watchdog);
  console.log('[settings-rescan-all-regression] PASS');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
