'use strict';
/**
 * 「硬件加速」那一行到底画成什么样 —— **真实 change 探针**（人工跑，不进 run-regressions.js）。
 *
 * 为什么不能只靠静态守护：`scripts/gpu-probe-regression.js` 能钉住「回落必须 warn」「取值域
 * 不许漂」这些**后端**契约，但钉不住「这一行有没有画出来、三种取值区不区分得开」。
 * 而这一行恰恰是本轮唯一**给用户看**的东西 —— 它要回答的是「我这台机器到底用没用上 GPU」，
 * 一旦画错（比如把「还没探完」画成「不可用」），用户得到的结论就是反的。
 *
 * 走**真实链路**：加载真 `src/renderer/index.html`（真 app.js → 真 `SemanticSearchUI.mount`
 * → 真 `openSemanticSettings()`），只桩 `photoAPI.aiSearchStatus` 的返回值。
 * 不给面板另写一套挂载代码 —— 那测的就不是产品里跑的那份了。
 *
 * 断言（四态 × 各自的可区分性）：
 *   A `gpu: null`          ⇒ 说「检测中」（**不能**说「不可用」）
 *   B `stale: true` + 可用  ⇒ 说「可用」且必须带「上次检测」字样（否则会拿旧结论冒充本次实测）
 *   C 本次实测 + 可用       ⇒ 说「可用」且**不许**出现「上次」（B 与 C 必须可区分）
 *   D 本次实测 + 不可用     ⇒ 说「不可用」+ 走 CPU；`title` 必须带上 ORT 的失败原文
 *   E 同一面板里既有的「模型 / 有效索引」状态行**不受影响**（别把新行插成它的替身）
 *
 * 用法（⚠️ 本机 shell 里 `ELECTRON_RUN_AS_NODE=1` 是预设的，必须显式去掉）：
 *
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/gpu-note-probe.js
 *
 * 退出码 0 = ALL PASS，1 = 有 FAIL。
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// 本机沙箱里 GPU 进程会崩（exit_code=-1073741819）并把 loadFile 一起带失败
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 面板轮询是 2500ms，等一轮多一点；改这个数等于改判据，别为了快而调小。 */
const POLL_WAIT = 3000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  [' + detail + ']' : ''));
}

/** 面板里那一行的读数。按文案定位（产品里同一档 class 的说明行不止一条，不能用 class 选中）。 */
const READ_NOTE = `
  (function () {
    var mount = document.getElementById('settingsAiSearchMount');
    if (!mount) return { error: 'mount missing' };
    var rows = Array.prototype.slice.call(mount.querySelectorAll('.ai-tune-note'));
    var hit = rows.filter(function (p) { return p.textContent.indexOf('硬件加速') >= 0; });
    return {
      count: hit.length,
      text: hit.length ? hit[0].textContent : '',
      title: hit.length ? (hit[0].getAttribute('title') || '') : '',
      siblingNotes: rows.length,
      statusText: (function () {
        var s = mount.querySelector('.search-status');
        return s ? s.textContent : '';
      })(),
      dialogHidden: (function () {
        var d = mount.querySelector('.ai-dialog') || mount.querySelector('dialog') || mount.firstElementChild;
        return d ? d.hidden === true : null;
      })(),
    };
  })()
`;

async function main() {
  const win = new BrowserWindow({
    // ⚠️ `show: false` 的窗口**不会因为 DOM 变化重新合成**，`capturePage()` 拿到的是加载完
    //    那一帧 —— 本探针会在加载后打开设置页、切四次状态，用 `show: false` 截出来的图
    //    与读数完全不相干（第一版就截到了「人物索引」那块，图看着还挺合理）。
    //    DOM 断言不受影响，但「给人看的截图」必须让窗口真的显示。代价是闪一下，属正常。
    show: true,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const logs = [];
  win.webContents.on('console-message', (event) => {
    logs.push(String((event && event.message) || ''));
  });
  await win.loadFile(INDEX);
  await sleep(400);

  // 夹具自证：真实页面上这些全局必须都在，否则测的不是这份代码
  const globals = await win.webContents.executeJavaScript(`({
    photoAPI: typeof window.photoAPI,
    mount: typeof window.SemanticSearchUI,
    settings: typeof window.semanticSettings,
    open: typeof window.openSemanticSettings,
  })`);
  check(
    '夹具自证：真实页面已加载面板挂载点与真实入口',
    globals.mount === 'object' &&
      globals.settings === 'object' &&
      globals.open === 'function' &&
      globals.photoAPI === 'undefined',
    JSON.stringify(globals),
  );
  if (globals.open !== 'function') {
    console.log('\n[gpu-note] FAIL（夹具没就位，后续断言无意义）');
    app.exit(1);
    return;
  }

  // 桩：只桩 photoAPI 的数据层，面板 / 入口 / 轮询全是产品代码
  const stubbed = await win.webContents.executeJavaScript(`
    (function () {
      window.photoAPI = window.photoAPI || {};
      window.__gpu = null;
      window.__statusCalls = 0;
      window.photoAPI.aiSearchStatus = function () {
        window.__statusCalls += 1;
        return Promise.resolve({
          ready: true, indexed: 1284, running: false, phase: 'complete',
          gpu: window.__gpu,
        });
      };
      window.photoAPI.aiSearchInstall = function () { return Promise.resolve({}); };
      window.photoAPI.aiSearchIndex = function () { return Promise.resolve({}); };
      window.photoAPI.aiSearchCancel = function () { return Promise.resolve({}); };
      window.photoAPI.getSettings = function () { return Promise.resolve({}); };
      window.photoAPI.updateSettings = function () { return Promise.resolve({}); };
      return true;
    })()
  `);
  check('夹具自证：photoAPI 桩已注入', stubbed === true);

  // 走真实入口打开「设置 → AI 与索引 → 搜图索引」
  await win.webContents.executeJavaScript('window.openSemanticSettings()');
  await sleep(1200);

  const setGpu = (value) =>
    win.webContents.executeJavaScript('(window.__gpu = ' + JSON.stringify(value) + ', true)');
  const readNote = () => win.webContents.executeJavaScript(READ_NOTE);

  // ---------- A：还没探完 ----------
  await setGpu(null);
  await sleep(POLL_WAIT);
  let note = await readNote();
  check(
    'A 面板真的渲染出了这一行（有且只有一条）',
    note.count === 1,
    'count=' + note.count + ' text=' + JSON.stringify(note.text),
  );
  check(
    'A `gpu: null`（还没探完）⇒ 说「检测中」，**不许**说「不可用」',
    note.text.includes('检测中') && !note.text.includes('不可用'),
    note.text,
  );
  check(
    'A 既有状态行不受影响（新行不是它的替身）',
    note.statusText.includes('有效索引') || note.statusText.includes('索引'),
    JSON.stringify(note.statusText),
  );

  // ---------- B：上次的结论 + 可用 ----------
  await setGpu({ available: true, provider: 'dml', stale: true, createMs: 1974, runMs: 12 });
  await sleep(POLL_WAIT);
  note = await readNote();
  check(
    'B 上次检测可用 ⇒ 说「可用」且必须标明「上次」（旧结论不许冒充本次实测）',
    note.text.includes('可用') && note.text.includes('上次'),
    note.text,
  );

  // ---------- C：本次实测 + 可用 ----------
  await setGpu({ available: true, provider: 'dml', stale: false, createMs: 1974, runMs: 12 });
  await sleep(POLL_WAIT);
  note = await readNote();
  check(
    'C 本次实测可用 ⇒ 说「可用」且**不许**出现「上次」（B 与 C 必须可区分）',
    note.text.includes('可用') && !note.text.includes('上次') && !note.text.includes('重测'),
    note.text,
  );
  check('C 可用时不带失败原因（title 应为空）', note.title === '', JSON.stringify(note.title));

  // ---------- D：本次实测 + 不可用 ----------
  const reason = 'no available backend found. ERR: [dml] backend not found.';
  await setGpu({ available: false, provider: 'cpu', stale: false, reason: reason });
  await sleep(POLL_WAIT);
  note = await readNote();
  check(
    'D 本次实测不可用 ⇒ 说「不可用」+ 明确「走 CPU」',
    note.text.includes('不可用') && note.text.includes('CPU'),
    note.text,
  );
  check(
    'D 失败原因（ORT 英文原文）必须挂进 title，正文保持中文一句',
    note.title === reason && !note.text.includes('backend not found'),
    'title=' + JSON.stringify(note.title),
  );

  // ---------- 轮询自证 ----------
  const calls = await win.webContents.executeJavaScript('window.__statusCalls');
  check(
    '同一面板实例靠真实轮询连读状态（没有另起渲染路径）',
    Number(calls) >= 4,
    '__statusCalls=' + calls,
  );

  // 顺手出一张整窗图供人工过目。
  //
  // 🔴 这里**刻意不做裁剪**。裁剪坐标的口径（窗口内容区原点 / 标题栏与菜单栏的偏移 /
  //    `devicePixelRatio`）在本机实测对不上：按「`getBoundingClientRect()` × dpr」算出来的
  //    rect 截到的是**下面那个人物索引面板**，而图看着还挺合理（有按钮、有说明文字），
  //    第一版就据此写了一版「取景自证」断言 —— 它**通过了**，结论却是错的。
  //    教训：**当「自证」本身建立在没被独立验证过的换算上时，它是假护栏。**
  //    这里改成整窗一张，让看图的人自己定位；反正这一行在图上就一行字，足够认。
  const shotPath = path.join(ROOT, '.workbuddy', 'bench', 'out', 'gpu-note.png');
  try {
    await win.webContents.executeJavaScript(
      "document.getElementById('settingsAiSearchMount').scrollIntoView({ block: 'start' })",
    );
    await sleep(600);
    const png = await win.capturePage();
    const size = png.getSize();
    check(
      '截图自证：整窗帧非空（`show: false` 会给出加载那一刻的旧帧 —— 图与读数会互相打脸）',
      size.width > 400 && size.height > 300 && size.width * size.height > 100000 && png.toPNG().length > 20000,
      size.width + 'x' + size.height,
    );
    require('node:fs').mkdirSync(path.dirname(shotPath), { recursive: true });
    require('node:fs').writeFileSync(shotPath, png.toPNG());
    console.log('  · 整窗截图: ' + shotPath);
  } catch (error) {
    console.log('  · 截图跳过: ' + (error && error.message ? error.message : error));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    '\n[gpu-note] ' +
      (failed.length ? 'FAIL' : 'PASS') +
      ' (' +
      (results.length - failed.length) +
      ' / ' +
      results.length +
      ')' +
      (logs.length ? '  页面日志 ' + logs.length + ' 条' : ''),
  );
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error('FAIL: ' + (error && error.stack ? error.stack : error));
    app.exit(1);
  }),
);
