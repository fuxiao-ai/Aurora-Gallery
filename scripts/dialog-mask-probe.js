'use strict';
/* global WebSocket */ // Node 22 有全局 WebSocket，但 ESLint 的 node 环境不认
/**
 * 「通用弹窗 #appDialogOverlay 是否真的隔离」端到端探针（手动跑，不是回归）。
 *
 * 为什么必须有它：`.app-dialog-overlay` 是 `position:fixed; inset:0; z-index:15100` 的**全屏**
 * 遮罩，所有 alert/confirm（**含「删除到回收站」**）都复用它。遮罩天然挡得住**指针**，但挡不住
 * **键盘**：预览 / 导航历史 / 路径栏 / 关闭选项的 keydown 监听**全都挂在 document（bubble）**，
 * 且没有任何一个模块检查「弹窗是否打开」。2026-10-05 读码找出**两条真泄漏**，本脚本用**真实按键**
 * 把它们钉住（静态检查读不出「事件到底有没有送进去」，只有真派发才能验证）：
 *
 *   1. 弹窗开着按 Delete → 预览的删除处理器再排一个确认框（appDialogQueue），同一张照片删两次，
 *      第二次必然报「照片记录不存在」；
 *   2. 一个 Esc → 弹窗在 capture 阶段 preventDefault，但预览处理器不看 defaultPrevented，
 *      「取消弹窗」与「关掉预览」同时发生。
 *
 * ⚠️ **读码时还怀疑过第三条，实测证伪，别再去「修」它**：曾以为「点弹窗卡片本体（标题/正文）
 * 会冒泡到遮罩 → 被当成点遮罩 → 静默取消删除」。实测不成立 —— `ui-events.js` 早就给
 * `.app-dialog-card` / `.close-choice-dialog` 挂了 `stopPropagation`，卡片里的点击根本到不了遮罩。
 * （证据：把遮罩上的 `e.target === overlay` 判断拆掉后，第 4 项**照样 PASS**。）该项保留为
 * **行为契约**断言，不再对应任何缺陷。
 *
 * 修法：弹窗的 keydown 改挂 **window 捕获阶段 + stopPropagation**（本页最早的一站，一次性盖住
 * 全部既有与将来的 document 级监听）。
 *
 * 🔴 牙齿验证（2026-10-05）：把 window→document、删掉 stopPropagation 之后重跑，1/2 两组里
 *    精确红 3 项、其余全绿；还原后文件 sha256 与还原前**逐字节一致**。改动这块务必重做这个动作。
 *
 * 🔴 另有一条**只在本探针里可见**的契约（第 7 组）：`showAppDialog` 顶掉上一个弹窗时若只
 *    `cleanup()` 而不结算，上一个 promise 永久悬挂 → 同一条 `appDialogQueue` 卡死 → 之后**所有**
 *    alert/confirm 静默不再弹出。app.js 的 `_showAppDialog` 是唯一能绕过队列的入口（当前无人调用）。
 *
 * 用法：
 *   1) 先起一个带调试端口的**隔离**实例（否则会连到本机真实库/设置）：
 *        LOCALAPPDATA='C:/temp/dialog-probe/isolated' \
 *        env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *          --remote-debugging-port=9222 --disable-gpu --disable-gpu-compositing \
 *          --disable-software-rasterizer --no-sandbox . --dev
 *      ⚠️ `--user-data-dir` 对本品无效：`configureWritableAppPaths()` 无条件把 userData 设成
 *      `%LOCALAPPDATA%\<appName>\UserData`，只能注入 LOCALAPPDATA。
 *      ⚠️ 隔离库是空库，实例可能在 ~12s 后自行退出 —— 要在存活窗口内跑完本脚本。
 *   2) node scripts/dialog-mask-probe.js
 *      ⚠️ 渲染进程只在**启动时**加载一次 `ui-overlays.js`：刚改完代码就重跑，跑的还是旧逻辑
 *      （会得出「改了没用」的错误结论）。改过文件就带 `PROBE_RELOAD=1` 让探针先重载页面。
 *
 * ⚠️ 跑前务必确认端口上**恰好 1 个主窗口 target**（pageWsUrl 会断言），残留实例会让读数错乱。
 *
 * 退出码：0 全 PASS / 1 有 FAIL / 2 连不上或不满足前置条件。
 */
const PORT = parseInt(process.env.PROBE_PORT || '9222', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pageWsUrl() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const pages = list.filter((t) => t.type === 'page' && t.url.includes('src/renderer/index.html'));
  if (pages.length !== 1) {
    throw new Error(`期望恰好 1 个主窗口 target，实际 ${pages.length} 个 —— 先清掉残留实例`);
  }
  return pages[0].webSocketDebuggerUrl;
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

const KEYCODE = { Tab: 9, Enter: 13, Escape: 27, Delete: 46 };
/** 真实按键（不是页面内合成事件）—— 要验的正是「事件有没有穿过 window 捕获这一站」 */
async function press(cdp, key) {
  const virtualKeyCode = KEYCODE[key];
  const base = { windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, key, code: key };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

const pointOf = (sel) =>
  `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;

async function realClick(cdp, p) {
  const mouse = (type, extra) =>
    cdp.send(
      'Input.dispatchMouseEvent',
      Object.assign({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, extra || {}),
    );
  await mouse('mouseMoved', { button: 'none', buttons: 0 });
  await mouse('mousePressed', { buttons: 1 });
  await mouse('mouseReleased', { buttons: 0 });
}

/** 在 document（bubble）上装一个间谍，冒充预览/导航那批监听：弹窗开着时它必须**一个键都收不到** */
const ARM = `(() => {
  const p = (window.__probe = window.__probe || {});
  if (p.spy) document.removeEventListener('keydown', p.spy);
  p.keys = [];
  p.tag = 'PENDING';
  p.spy = (e) => p.keys.push(e.key);
  document.addEventListener('keydown', p.spy);
  return 'armed';
})()`;

const DISARM = `(() => {
  const p = (window.__probe = window.__probe || {});
  if (p.spy) document.removeEventListener('keydown', p.spy);
  p.spy = null;
  return 'disarmed';
})()`;

const STATE = `(() => {
  const o = document.getElementById('appDialogOverlay');
  const p = window.__probe || {};
  const a = document.activeElement;
  return {
    show: !!o && o.classList.contains('show'),
    aria: o ? o.getAttribute('aria-hidden') : null,
    keys: (p.keys || []).slice(),
    tag: p.tag,
    focus: a ? a.id || a.tagName : null,
  };
})()`;

const openConfirm = `(() => {
  const p = (window.__probe = window.__probe || {});
  p.tag = 'PENDING';
  RendererDialogUI.appConfirm('probe-confirm').then((v) => { p.tag = String(v); });
  return 'opened';
})()`;

const openAlert = `(() => {
  const p = (window.__probe = window.__probe || {});
  p.tag = 'PENDING';
  RendererDialogUI.appAlert('probe-alert').then((v) => { p.tag = String(v); });
  return 'opened';
})()`;

(async () => {
  let ws;
  try {
    ws = new WebSocket(await pageWsUrl());
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
  } catch (e) {
    console.error('连不上或前置条件不满足：', e.message);
    process.exit(2);
  }
  const cdp = new Cdp(ws);
  /* 🔴 未聚焦的窗口会被 Chromium 做 timer 节流（setTimeout 最短间隔抬到 1000ms 量级）：
     弹窗显示后那个 `cancelBtn.focus()` 就跑在 setTimeout 里，节流会让「焦点在取消上」
     这条断言**看似失败**。setFocusEmulationEnabled 专治这个，且不抢真实窗口焦点。 */
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  // 改过 renderer 文件就必须重载，否则跑的是进程启动时那一份
  if (process.env.PROBE_RELOAD) {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(parseInt(process.env.PROBE_RELOAD_WAIT_MS || '2600', 10));
    const ready = await cdp.eval(
      `!!(window.RendererDialogUI && document.getElementById('appDialogOverlay'))`,
    );
    check('重载后 renderer 已就绪（弹窗节点与 RendererDialogUI 都在）', { ready }, { ready: true });
  }

  // ---- 0) 遮罩与监听基线：弹窗关闭时 document 必须收得到键 ----
  console.log('\n0) 基线：弹窗关闭时 document 级监听正常工作');
  await cdp.eval(ARM);
  await press(cdp, 'Delete');
  await sleep(120);
  let st = await cdp.eval(STATE);
  check('遮罩未显示', { show: st.show }, { show: false });
  check('关闭态下 Delete 能到达 document（间谍收到）', { keys: st.keys.join(',') }, { keys: 'Delete' });

  // ---- 1) 弹窗开着：Delete 必须被吞掉，且不得排出第二个确认框 ----
  console.log('\n1) 弹窗开着按 Delete（原来会再排一个删除确认）');
  await cdp.eval(ARM);
  await cdp.eval(openConfirm);
  await sleep(260);
  st = await cdp.eval(STATE);
  check('confirm 弹窗已显示', { show: st.show, aria: st.aria }, { show: true, aria: 'false' });
  check('confirm 的焦点落在「取消」（不是确定）', { focus: st.focus }, { focus: 'appDialogCancelBtn' });
  await press(cdp, 'Delete');
  await sleep(200);
  st = await cdp.eval(STATE);
  check('Delete 被 window 捕获阶段吞掉，document 收不到', { keys: st.keys.join(',') }, { keys: '' });
  check('弹窗仍开着、promise 未结算（没有第二个确认框被排队）', {
    show: st.show,
    tag: st.tag,
  }, { show: true, tag: 'PENDING' });

  // ---- 2) Escape：跟着焦点走 = 取消；且不得同时关掉预览 ----
  console.log('\n2) Escape（原来会「取消弹窗 + 关掉预览」同时发生）');
  await press(cdp, 'Escape');
  await sleep(200);
  st = await cdp.eval(STATE);
  check('Escape 被吞掉，document 收不到', { keys: st.keys.join(',') }, { keys: '' });
  check('confirm 结算为 false（= 取消，没有误执行删除）', { tag: st.tag }, { tag: 'false' });
  check('遮罩收起 + aria-hidden 复位', { show: st.show, aria: st.aria }, { show: false, aria: 'true' });

  // ---- 3) 收起后必须无残留监听 ----
  console.log('\n3) 弹窗收起后监听已解绑（不留残余）');
  await cdp.eval(ARM);
  await press(cdp, 'Delete');
  await sleep(120);
  st = await cdp.eval(STATE);
  check('收起后 Delete 重新到达 document', { keys: st.keys.join(',') }, { keys: 'Delete' });

  // ---- 4) 点卡片本体（标题/正文）不得取消（契约：守卫在 ui-events.js 的卡片 stopPropagation） ----
  console.log('\n4) 点弹窗正文：不得取消（行为契约，非缺陷回归）');
  await cdp.eval(ARM);
  await cdp.eval(openConfirm);
  await sleep(260);
  const msgPoint = await cdp.eval(pointOf('.app-dialog-message'));
  if (!msgPoint) {
    fail++;
    console.log('  FAIL  取不到 .app-dialog-message 的坐标');
  } else {
    await realClick(cdp, msgPoint);
    await sleep(200);
    st = await cdp.eval(STATE);
    check('点正文不取消：弹窗仍显示、promise 仍未结算', { show: st.show, tag: st.tag }, {
      show: true,
      tag: 'PENDING',
    });
  }

  // ---- 5) 点遮罩空白（卡片外）仍应取消 ----
  const blankPoint = await cdp.eval(`(() => {
    const o = document.getElementById('appDialogOverlay');
    const card = o.querySelector('.app-dialog-card');
    const r = card ? card.getBoundingClientRect() : null;
    // 卡片左边、垂直居中：一定落在遮罩自己的 padding 里
    const x = r ? Math.max(2, Math.round(r.left) - 30) : 4;
    return { x, y: Math.round(window.innerHeight / 2) };
  })()`);
  await realClick(cdp, blankPoint);
  await sleep(220);
  st = await cdp.eval(STATE);
  const hit = await cdp.eval(
    `(() => { const o = document.getElementById('appDialogOverlay'); return o && o.classList.contains('show') ? 'still-show' : 'closed'; })()`,
  );
  check('点遮罩空白（卡片外）仍能取消', { tag: st.tag, hit }, { tag: 'false', hit: 'closed' });

  // ---- 6) alert 态：焦点在「确定」，Enter 即确认 ----
  console.log('\n6) alert 态：Enter 跟随焦点 = 关闭');
  await cdp.eval(ARM);
  await cdp.eval(openAlert);
  await sleep(260);
  st = await cdp.eval(STATE);
  check('alert 只有「确定」一个按钮且拿到焦点', { focus: st.focus }, { focus: 'appDialogOkBtn' });
  const cancelHidden = await cdp.eval(
    `document.getElementById('appDialogCancelBtn').style.display === 'none'`,
  );
  check('alert 态隐藏「取消」', { hidden: cancelHidden }, { hidden: true });
  await press(cdp, 'Enter');
  await sleep(200);
  st = await cdp.eval(STATE);
  check('Enter 被吞掉且 alert 结算为 undefined', { keys: st.keys.join(','), tag: st.tag }, {
    keys: '',
    tag: 'undefined',
  });

  // ---- 7) 直接连开两个弹窗：旧的被结算，遮罩保持「新的在显示」 ----
  console.log('\n7) 直接连开两个弹窗（验证 cleanup 顺序不会把新弹窗一起收起）');
  const stacked = await cdp.eval(`(() => {
    const p = (window.__probe = window.__probe || {});
    p.tagA = 'PENDING';
    p.tagB = 'PENDING';
    RendererDialogUI.showAppDialog({ type: 'confirm', message: 'A' }).then((v) => { p.tagA = String(v); });
    RendererDialogUI.showAppDialog({ type: 'confirm', message: 'B' }).then((v) => { p.tagB = String(v); });
    const o = document.getElementById('appDialogOverlay');
    return { show: o.classList.contains('show'), text: document.getElementById('appDialogMessage').textContent };
  })()`);
  await sleep(260);
  const stackedAfter = await cdp.eval(`(() => {
    const p = window.__probe;
    const o = document.getElementById('appDialogOverlay');
    return {
      tagA: p.tagA,
      tagB: p.tagB,
      show: o.classList.contains('show'),
      text: document.getElementById('appDialogMessage').textContent,
    };
  })()`);
  check('旧弹窗被结算为 false（不留悬挂 promise）', { tagA: stackedAfter.tagA }, { tagA: 'false' });
  check('新弹窗在显示（A 的 cleanup 没有把遮罩一起收起）', {
    show: stackedAfter.show,
    text: stackedAfter.text,
  }, { show: true, text: 'B' });
  check('B 的文案确实写进了同一个节点', { text: stacked.text }, { text: 'B' });
  await press(cdp, 'Escape');
  await sleep(200);

  await cdp.eval(DISARM);
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
