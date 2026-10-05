'use strict';
/* global WebSocket */ // Node 22 有全局 WebSocket，但 ESLint 的 node 环境不认
/**
 * 「窗口背景（实色 / 亚克力）」端到端探针（手动跑，不是回归）。
 *
 * 为什么必须有它：这一维有三条**静态检查永远抓不到**的契约，因为它们只在真实窗口里成立 ——
 *
 *   ① **两半必须同时生效**：主进程的 `transparent`（建窗参数）+ 渲染层的 `data-window-backdrop`
 *      （让 body 与面板带上 alpha）。缺一半就是「洗白」或「透不出去」，
 *      而白名单 / 下拉 / 属性全对时，theme-regression 那 30 多条断言**一条都不会红**。
 *   ② **改档当场不能洗白**：窗口还没重建，`body` 就抢先透明 → 底色透到窗口自己的白色底板上。
 *      所以渲染层只认主进程传的「已生效值」（`uiWindowBackdropApplied`）。
 *   ③ **改档必须重启才生效**：`transparent` / `backgroundColor` / `backgroundMaterial`
 *      都是创建参数，`setBackgroundMaterial` 也只能换材质、不能把不透明窗口变透明。
 *
 * 本脚本**自己拉起 Electron**（两轮），所以不需要先手动起实例：
 *   node scripts/window-backdrop-probe.js
 *
 * ⚠️ 必须隔离：`LOCALAPPDATA` 注入到临时目录，**绝不碰本机真实设置与相册**。
 *   ⚠️ `--user-data-dir` 对本品无效（`configureWritableAppPaths()` 无条件把 userData 设成
 *   `%LOCALAPPDATA%\<appName>\UserData`），只能注入 LOCALAPPDATA。
 * ⚠️ 🔴 起窗口**必须带 `--no-sandbox`**：缺了它 GPU 进程必崩 `0xC0000005`，
 *   症状伪装成 `loadFile ERR_FAILED (-2)`。**不要加 `--disable-gpu`**（要看真实渲染）。
 *
 * 退出码：0 全 PASS / 1 有 FAIL / 2 起不来。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ELECTRON = require('electron');
const PORT = parseInt(process.env.PROBE_PORT || '9333', 10);
const BOOT_MS = parseInt(process.env.PROBE_BOOT_MS || '9000', 10);
const ACT_MS = parseInt(process.env.PROBE_ACT_MS || '1300', 10);
const ISOLATED = process.env.PROBE_LOCALAPPDATA || path.join(os.tmpdir(), 'aurora-wbd-probe');
const USER_DATA = path.join(ISOLATED, 'aurora-gallery', 'UserData');
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');
/** 可选：把两轮截到的 PNG 落到这个目录，供人眼确认（脚本本身不做主观判定） */
const PNG_DIR = process.env.PROBE_PNG_DIR || '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let child = null;

function startApp() {
  const env = Object.assign({}, process.env, { LOCALAPPDATA: ISOLATED });
  // 🔴 必须清掉：留着它 electron.exe 会以「Node 模式」启动，根本不建窗口
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(
    ELECTRON,
    ['--remote-debugging-port=' + PORT, '--no-sandbox', path.join(__dirname, '..')],
    { env: env, stdio: 'ignore' },
  );
}

async function killApp() {
  if (!child) return;
  const net = require('net');
  /** 端口上还有人在听吗。🔴 必须用 `net.connect` 而不是 `fetch` —— 本机代理是 fake-ip 模式，
   *  fetch 走代理时会假成功 / 假失败，读数不可信（本项目既有红线）。 */
  const portAlive = () =>
    new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: PORT }, () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.setTimeout(700, () => {
        s.destroy();
        resolve(false);
      });
    });
  const dead = new Promise((r) => child.once('exit', r));
  try {
    child.kill();
  } catch (e) {}
  await Promise.race([dead, sleep(5000)]);
  child = null;
  // 等调试端口真的让出来，否则下一轮会连到上一轮的僵尸 target
  // ⚠️ 2026-10-05 实测踩到：加第四轮后它连到了**上一轮**的窗口 → 读到的是上一轮的设置，
  //    于是「新档」那三条断言假 FAIL。现象是「磁盘上明明是 acrylic-strong，
  //    页面上却是 solid」—— 记住这个症状，别去改应用。
  for (let i = 0; i < 60; i++) {
    if (!(await portAlive())) return;
    await sleep(250);
  }
}

async function pageWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const pages = list.filter(
        (t) => t.type === 'page' && t.url.includes('src/renderer/index.html'),
      );
      if (pages.length === 1) return pages[0].webSocketDebuggerUrl;
      if (pages.length > 1) throw new Error(`期望恰好 1 个主窗口 target，实际 ${pages.length} 个`);
    } catch (e) {
      if (/期望恰好/.test(String(e && e.message))) throw e;
    }
    await sleep(500);
  }
  throw new Error('等不到主窗口 target（应用没起来 / 端口被占）');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

/**
 * 读「此刻」的窗口背景状态。
 * ⚠️ `--ui-alpha` 要从 html 的计算样式上读：它是继承变量，读 body 上的同值（都行，这里读 html）。
 * ⚠️ body 的计算 backgroundColor 是**合成后的** rgba —— 亚克力档它必须带 alpha < 1，
 *    否则说明 body 还是实色底，桌面被挡死在最底层（「窗口透明了但看不出透」）。
 */
const READ_STATE = `(() => {
  const root = document.documentElement;
  const bodyCs = getComputedStyle(document.body);
  const rootCs = getComputedStyle(root);
  const sel = document.getElementById('settingUiWindowBackdrop');
  const hint = document.getElementById('settingWindowBackdropRestartHint');
  const panelCs = getComputedStyle(document.querySelector('.content-area') || document.body);
  /**
   * ⚠️ 🔴 body 的底色**不能读 backgroundColor**：它的背景是 \`background\` 简写里的两层渐变，
   * 简写会把 background-color 一并重置成 initial（transparent）—— 两个档读出来**都是
   * rgba(0,0,0,0)**，断言看着过、其实恒真（空转）。必须去 background-image 里数**每个色标的
   * alpha**。这就是「亚克力档的底是不是真的带 alpha」唯一能自动判定的读法。
   */
  /* ⚠️ alpha 的读法要兼容两种计算值语法：Chromium 现在把 color-mix 的结果输出成
     \`color(srgb 0.039 0.039 0.094 / 0.62)\`，而不是 \`rgba(10,10,24,0.62)\`。
     只认 rgba() 的话会**一个色标都数不到**，断言静默空转（本次就是踩了这个）。
     ⚠️ 也不能用「取字符串里最后一个数字」这种土办法：rgb(10, 10, 24) 会数出 24。 */
  const alphaOf = (c) => {
    const slash = c.indexOf('/');
    if (slash >= 0) return parseFloat(c.slice(slash + 1));
    const p = c.replace(/^[a-z]+\\(|\\)$/g, '').split(',');
    return p.length === 4 ? parseFloat(p[3]) : 1;
  };
  const stops = (bodyCs.backgroundImage.match(/(?:rgba?|color)\\([^)]*\\)/g) || []).map(alphaOf);
  const faint = stops.filter((a) => a > 0 && a < 1);
  return {
    attr: root.getAttribute('data-window-backdrop'),
    uiAlpha: rootCs.getPropertyValue('--ui-alpha').trim(),
    bodyStops: stops.join('/'),
    /* 渐变里「半透明色标」的个数。实色档只会有 1 个（顶部那圈径向高光，两档都在），
       亚克力档除此之外还有底部线性渐变的两个色标 → 个数就是判据。 */
    bodyFaint: faint.length,
    panelBg: panelCs.backgroundColor,
    panelAlpha: alphaOf(panelCs.backgroundColor),
    selectValue: sel ? sel.value : null,
    hintHidden: hint ? !!hint.hidden : null,
  };
})()`;

/** 与用户手选等价：改值 + 冒泡 change（设置页走 change 委托） */
function setAndChange(id, value) {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return 'NO_EL';
    const before = el.value;
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return before + ' -> ' + el.value;
  })()`;
}

/** 截一帧，统计 alpha<255 的像素占比 —— 这是「窗口真的透明」唯一的客观证据 */
async function alphaStats(cdp, keepAs) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const sharp = require('sharp');
  if (keepAs) fs.writeFileSync(keepAs, Buffer.from(r.data, 'base64'));
  const meta = await sharp(Buffer.from(r.data, 'base64')).metadata();
  const { data } = await sharp(Buffer.from(r.data, 'base64'))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let translucent = 0;
  let min = 255;
  const total = meta.width * meta.height;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) translucent++;
    if (data[i] < min) min = data[i];
  }
  return { total: total, ratio: translucent / total, minAlpha: min };
}

function diskBackdrop() {
  try {
    const o = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return o.uiWindowBackdrop;
  } catch (e) {
    return 'READ_ERR:' + String(e && e.message);
  }
}

/** 预置 settings.json（第一轮：亚克力；之后的轮次沿用脚本自己写下去的值） */
function seedSettings(backdrop) {
  fs.mkdirSync(USER_DATA, { recursive: true });
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {}
  cur.uiWindowBackdrop = backdrop;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cur, null, 2), 'utf8');
}

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const bad = Object.keys(expected).filter((k) => actual[k] !== expected[k]);
  if (bad.length === 0) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label);
    bad.forEach((k) => console.log(`        ${k}: 期望 ${expected[k]} / 实际 ${actual[k]}`));
  }
}

/**
 * 轮询等一个表达式达到期望值。
 * ⚠️ 不能死等固定毫秒：`loadFile` 完成后，渲染层还要等主进程推过来的设置才动属性
 *   （首帧只按 localStorage 快照画，可能是上一轮的档），这一拍在慢机器上会超过 1s。
 *   前三轮读的都是「同一个恒定值」，看不出这个时序；加了第四轮读**新档**才暴露 ——
 *   当时现象是「磁盘上明明是 acrylic-strong、页面上却读成 solid」，看着像应用有 bug。
 */
async function waitFor(cdp, expr, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.eval(expr);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

/** 删隔离目录。⚠️ 不能删完立刻走人：刚被杀掉的实例还有子进程（GPU / 网络）可能仍握着
 *  `SessionData/Dictionaries/*.bdic`，`rmSync` 会抛 `EBUSY` 把整个探针带崩（2026-10-05 实测）。
 *  重试几次即可 —— 这里不是断言点，删不掉也不影响结论。 */
async function rmIsolated() {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(ISOLATED, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return Promise.resolve();
    } catch (e) {
      if (i === 9) {
        console.log('  （隔离目录残留，忽略：' + (e && e.message) + '）');
        return Promise.resolve();
      }
      await sleep(300);
    }
  }
  return Promise.resolve();
}

(async function main() {
  // 每轮都从零开始：残留的 settings.json 会让「第一轮就是第二轮」的结果
  await rmIsolated();
  seedSettings('acrylic');
  console.log('隔离目录 ' + ISOLATED);

  // ===== 第一轮：磁盘上就是 acrylic，窗口应当**建成透明的** =====
  if (PNG_DIR) fs.mkdirSync(PNG_DIR, { recursive: true });
  startApp();
  let ws = new WebSocket(await pageWsUrl());
  let cdp = new Cdp(ws);
  await sleep(BOOT_MS);
  // 同样先等属性到位：首帧那个 localStorage 快照可能是**上一轮**留下的（本探针是直接改
  // settings.json 再重启，没走 UI 保存路径），真正设上属性要等主进程推设置那一拍。
  await waitFor(
    cdp,
    "document.documentElement.getAttribute('data-window-backdrop')",
    (v) => v === 'acrylic',
  );
  const s1 = await cdp.eval(READ_STATE);
  const px1 = await alphaStats(cdp, PNG_DIR ? path.join(PNG_DIR, 'acrylic.png') : '');

  console.log('\n--- 第一轮（建窗即为亚克力）---');
  check('数据属性 = acrylic', { attr: s1.attr }, { attr: 'acrylic' });
  check('设置页下拉回显 = acrylic', { selectValue: s1.selectValue }, { selectValue: 'acrylic' });
  check('「需重启」提示隐藏（已生效 = 所选项）', { hintHidden: s1.hintHidden }, { hintHidden: true });
  check('--ui-alpha 落在亚克力上限 62%', { uiAlpha: s1.uiAlpha }, { uiAlpha: '62%' });
  check(
    'body 渐变有 ≥2 个半透明色标（否则桌面被挡死在最底层，窗口再透明也看不见）',
    { bodyFaint: s1.bodyFaint >= 2 },
    { bodyFaint: true },
  );
  check(
    '截图存在 alpha<255 的像素（窗口真的透明；实色档这里必然为 0）',
    { hasTranslucent: px1.ratio > 0.2, minAlpha: px1.minAlpha < 255 },
    { hasTranslucent: true, minAlpha: true },
  );
  console.log('        body 渐变 alpha 档: ' + s1.bodyStops + '，面板底色 ' + s1.panelBg);
  console.log(
    `        （截图 ${px1.total} px，alpha<255 占比 ${(px1.ratio * 100).toFixed(1)}%，最小 alpha ${px1.minAlpha}）`,
  );

  // ===== 第二轮（同一进程）：切成 solid —— 必须**只落库、不洗白** =====
  console.log('\n--- 第二轮（同一进程内改档 → 只落库、当场不动窗口）---');
  const before = await cdp.eval(READ_STATE);
  const act = await cdp.eval(setAndChange('settingUiWindowBackdrop', 'solid'));
  await sleep(ACT_MS);
  const s2 = await cdp.eval(READ_STATE);
  console.log('        ' + act);
  check('已写入磁盘 settings.json', { disk: diskBackdrop() }, { disk: 'solid' });
  check(
    '🔴 属性**仍是** acrylic（拿了设置值去设属性 = 界面当场洗白）',
    { attr: s2.attr },
    { attr: before.attr },
  );
  check(
    '🔴 body 渐变**仍未变**（窗口还是透明的，只有属性跟着变才是灾难）',
    { same: s2.bodyStops === before.bodyStops },
    { same: true },
  );
  check('「需重启」提示出现', { hintHidden: s2.hintHidden }, { hintHidden: false });
  check('下拉停在新选择 solid（不像「切了又跳回去」）', { selectValue: s2.selectValue }, { selectValue: 'solid' });

  await killApp();
  ws.close();

  // ===== 第三轮：重启 → 这下才轮到 solid 生效 =====
  startApp();
  ws = new WebSocket(await pageWsUrl());
  cdp = new Cdp(ws);
  await sleep(BOOT_MS);
  const s3 = await cdp.eval(READ_STATE);
  const px3 = await alphaStats(cdp, PNG_DIR ? path.join(PNG_DIR, 'solid.png') : '');

  console.log('\n--- 第三轮（重启后）---');
  check('数据属性已移除（solid 档 = 不设属性）', { attr: s3.attr }, { attr: null });
  check('--ui-alpha 回到 :root 兜底的 100%', { uiAlpha: s3.uiAlpha }, { uiAlpha: '100%' });
  /* ⚠️ 这里**只能跟第一轮比**，不能写死个数：默认背景档（`data-bg` 不设）的 body 背景
     由 gallery-design.css 的 `html:not([data-bg])` 那条改写过，形态未必是渐变
     （实测第三轮 backgroundImage 里一个色标都解析不到 = 压根不是渐变）。
     写死「1 个」会假 FAIL；写死「0 个」又会在别的背景档上假 FAIL。 */
  check(
    'body 底比第一轮更实（第一轮那两个 0.38 的半透明色标已撤回）',
    { backToSolid: s3.bodyFaint < s1.bodyFaint },
    { backToSolid: true },
  );
  // 与**第一轮**（同一台机器、同一套主题）交叉比对：面板必须真的变实了。
  // ⚠️ 不能只断言「== 1」：`.content-area` 的底色也可能来自简写里的 background-image，
  //    那样 backgroundColor 恒为 rgba(0,0,0,0)，断言会静默变成空转。
  check(
    '面板底色比第一轮更实（甲：亚克力档真的被撤掉，不是「属性变了但观感没变」）',
    { moreOpaque: (s3.panelAlpha || 0) > (s1.panelAlpha || 0) || s3.panelBg !== s1.panelBg },
    { moreOpaque: true },
  );
  check('「需重启」提示隐藏（已生效 = 所选项）', { hintHidden: s3.hintHidden }, { hintHidden: true });
  check('截图里没有透明像素（窗口确实回到实色）', { ratio: px3.ratio }, { ratio: 0 });
  console.log('        body 渐变 alpha 档: ' + s3.bodyStops + '，面板底色 ' + s3.panelBg);

  // ===== 第四轮：重启到「亚克力 · 强」—— 新档必须**同样建成透明窗口** =====
  // 🔴 这是「扩档」最容易漏的一处：createWindow 里若把判据写成 `=== 'acrylic'`，新档会被判成
  //    solid → 建成**不透明窗口** → body 再透明也只能透到窗口自己的底色上，新档「完全没效果」。
  //    而所有静态断言（建窗参数成套 / 白名单 / 下拉选项）那时**还是全绿的**。
  // 🔴 换轮必须**先杀干净再启**（2026-10-05 实测踩到）：漏了这句 `killApp()`，第三轮那个实例
  //    还在 PORT 上听着，第四轮新起的实例连不上调试端口、CDP 于是连回**上一轮的窗口**，
  //    读到的全是上一轮的状态（attr=null / --ui-alpha=100% / 无透明像素）——
  //    症状看着像「新档完全没生效」，其实应用是好的。记住这个症状，**别去改应用**。
  await killApp();
  ws.close();
  seedSettings('acrylic-strong');
  startApp();
  ws = new WebSocket(await pageWsUrl());
  cdp = new Cdp(ws);
  await sleep(BOOT_MS);
  // ⚠️ 先等到属性真的变成新档再读：首帧只按 localStorage 快照画，而探针是**直接改
  //    settings.json** 再重启的（没走 UI 保存路径）→ 快照里还是上一轮的档，
  //    真正设上属性要等主进程推设置的那一拍。
  await waitFor(
    cdp,
    "document.documentElement.getAttribute('data-window-backdrop')",
    (v) => v === 'acrylic-strong',
  );
  const s4 = await cdp.eval(READ_STATE);
  const px4 = await alphaStats(cdp, PNG_DIR ? path.join(PNG_DIR, 'acrylic-strong.png') : '');
  /** 渐变里**最实的那个半透明色标** = body 底那层的 linear alpha
   *  （顶部那圈径向三档一律 0.74，取 min 正好把它排除掉） */
  const minFaint = (stops) => {
    const xs = String(stops)
      .split('/')
      .map(Number)
      .filter((a) => a > 0 && a < 1);
    return xs.length ? Math.min.apply(null, xs) : NaN;
  };

  console.log('\n--- 第四轮（重启到「亚克力 · 强」）---');
  check('数据属性 = acrylic-strong', { attr: s4.attr }, { attr: 'acrylic-strong' });
  check(
    '窗口**真的建成透明**（新档也走到 transparent；判据写死 acrylic 时这里必然 FAIL）',
    { hasTranslucent: px4.ratio > 0.2, minAlpha: px4.minAlpha < 255 },
    { hasTranslucent: true, minAlpha: true },
  );
  check('--ui-alpha 上限对三档一样生效（62%）', { uiAlpha: s4.uiAlpha }, { uiAlpha: '62%' });
  check(
    '强档的 body 底比标准档更透（否则「三档」只是三个长得一样的名字）',
    { moreTransparent: minFaint(s4.bodyStops) < minFaint(s1.bodyStops) },
    { moreTransparent: true },
  );
  check('「需重启」提示隐藏（已生效 = 所选项）', { hintHidden: s4.hintHidden }, { hintHidden: true });

  // 页内遍历三档（只切属性 → 纯 CSS），把「程度确实递增」钉成一条单调判据；
  // 顺带每档存一张图，供 compose 出四档对照。
  const tierAlpha = {};
  for (const tier of ['acrylic-light', 'acrylic', 'acrylic-strong']) {
    await cdp.eval(
      'document.documentElement.setAttribute("data-window-backdrop", ' + JSON.stringify(tier) + ')',
    );
    await sleep(150);
    tierAlpha[tier] = minFaint((await cdp.eval(READ_STATE)).bodyStops);
    await alphaStats(cdp, PNG_DIR ? path.join(PNG_DIR, 'tier-' + tier + '.png') : '');
  }
  check(
    '三档 body 底线性的 alpha 严格递减（light > 中 > strong；alpha 是**不透明度**）',
    {
      monotonic:
        tierAlpha['acrylic-light'] > tierAlpha['acrylic'] &&
        tierAlpha['acrylic'] > tierAlpha['acrylic-strong'],
    },
    { monotonic: true },
  );
  console.log(
    '        三档 body alpha: ' +
      Object.keys(tierAlpha)
        .map((t) => t + '=' + tierAlpha[t])
        .join(', '),
  );
  console.log('        body 渐变 alpha 档: ' + s4.bodyStops);

  await killApp();
  ws.close();
  await rmIsolated();

  console.log(`\n===== 合计 PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  await killApp();
  console.error('PROBE ERROR ' + (e && e.message ? e.message : e));
  process.exit(2);
});
