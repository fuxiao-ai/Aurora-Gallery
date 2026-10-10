'use strict';
/**
 * 预览浮层滚轮行为契约（2026-10-09）。
 *
 * 背景：`wheel` 监听挂在 `#previewOverlay` 上，但**图片信息面板与字幕设置面板是它的后代**，
 * 且这两个面板自己是 `overflow-y: auto` 的滚动容器。原来的处理器**从不看 `e.target`** ⇒
 * 面板内滚动冒泡上来后被 `preventDefault()` + 直接切图，表现是「面板一动不动，图片却被翻过去了」。
 * 修复后的契约（两端必须一致）：
 *
 *   1. 无修饰键的滚轮落在可滚面板内、**且该方向还能滚** ⇒ 既不 preventDefault 也不切图（交还给面板）；
 *   2. 面板滚到上/下边界后**仍旧落下去切换图片**（scroll-chaining 直觉）；
 *   3. `Ctrl/⌘ + 滚轮` 永远走缩放，不受面板影响；
 *   4. 指针不在面板内时，切图判据保持原样（`|deltaY| > 20`）—— 这一条是**反向**钉的，
 *      防止有人把守卫写成「命中面板就 return」或者干脆把切图改没了。
 *
 * 为什么本脚本分成两半：
 *   - **行为半**（桌面端）：用假 DOM 真调 `RendererUIEvents.bindPreviewBasicControls`，
 *     拿注册上去的真实监听器跑九个场景。这条能抓「守卫写反 / 只判一半 / 恒 return」。
 *   - **镜像半**（两端）：网页端 `web/js/app.js` 是整页应用、require 不起来，只能读源码做
 *     结构断言。⚠️ **必须先剥注释** —— 修复处的注释里正好写着「不 preventDefault」，
 *     不剥的话「closest 出现在 preventDefault 之前」这条顺序断言会被注释里的字面量污染成假绿。
 *
 * ⚠️ 真 `WheelEvent` 的行为探针（`scripts/../%TEMP%/wheel-probe.js` 那类）**不能进本套件**：
 * `run-regressions.js` 用 `ELECTRON_RUN_AS_NODE=1` 拉起所有脚本，拿不到 `BrowserWindow`。
 * 那一层留作人工探针，本脚本负责**防回退**。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
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

const RENDERER_EVENTS = 'src/renderer/ui-events.js';
const WEB_APP = 'src/web/js/app.js';

// 两端共用的候选选择器 —— 逐字比对，允许两个面板扩展，但不许各写一份。
const PANEL_SELECTOR = '.preview-info-panel, .preview-subtitle-settings-panel';

// ---------------------------------------------------------------- 剥注释

/** 剥掉 `//` 与块注释（保留换行，行数不变），字符串/模板串里的内容原样保留。 */
function stripJsComments(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        i += 1;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') state = c;
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        i += 1;
        continue;
      }
      if (c === '\n') out += c;
      continue;
    }
    // 字符串 / 模板串
    out += c;
    if (c === '\\') {
      if (d !== undefined) out += d;
      i += 1;
      continue;
    }
    if (c === state) state = 'code';
  }
  return out;
}

// ------------------------------------------------------- 1. 假 DOM 行为层

class El {
  constructor() {
    const set = new Set();
    this.classList = {
      add: (n) => set.add(n),
      remove: (n) => set.delete(n),
      contains: (n) => set.has(n),
    };
    this.listeners = {};
    this.style = {};
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
  }
  addEventListener(name, cb) {
    this.listeners[name] = cb;
  }
}

global.document = {
  documentElement: new El(),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
global.window = {};
global.requestAnimationFrame = (cb) => cb();
require('../src/renderer/ui-events');
const UI_EVENTS = global.window.RendererUIEvents;

/** 造一套面板/浮层夹具并挂上真监听，返回 `{ fire, nav, zooms, panel, overlay }`。 */
function setup(openPanel) {
  const overlay = new El();
  if (openPanel !== false) overlay.classList.add('active');
  const panel = new El();
  panel.scrollHeight = 1000;
  panel.clientHeight = 400; // 可滚区间 = 0..600
  panel.scrollTop = 0;
  const nav = [];
  const zooms = [];
  UI_EVENTS.bindPreviewBasicControls({
    dom: { previewOverlay: overlay },
    onClosePreview() {},
    onNavigatePreview: (d) => nav.push(d),
    onResetZoom() {},
    onApplyZoom: (d) => zooms.push(d),
  });
  const handler = overlay.listeners.wheel;
  const targetInPanel = {
    closest: (sel) => (String(sel).indexOf('preview-info-panel') >= 0 ? panel : null),
  };
  const targetOnImage = { closest: () => null };
  function fire(opts) {
    const e = Object.assign(
      {
        target: targetOnImage,
        deltaY: 0,
        ctrlKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      },
      opts,
    );
    handler(e);
    return e;
  }
  return { fire, nav, zooms, panel, overlay, targetInPanel, targetOnImage };
}

check(
  '夹具自证：bindPreviewBasicControls 真的挂上了 wheel 监听',
  typeof setup().overlay.listeners.wheel === 'function',
);

// 1) 面板可滚（在顶部）向下滚 ⇒ 交还给面板：不 preventDefault、不切图
{
  const s = setup();
  s.panel.scrollTop = 0;
  const e = s.fire({ target: s.targetInPanel, deltaY: 100 });
  check(
    '🔴 指针在可滚面板内向下滚：不 preventDefault、不切图（交还给面板自己滚）',
    e.defaultPrevented === false && s.nav.length === 0,
    'prevented=' + e.defaultPrevented + ' nav=' + JSON.stringify(s.nav),
  );
}
// 2) 面板在中间 ⇒ 上下两个方向都不切图
{
  const s = setup();
  s.panel.scrollTop = 200;
  const down = s.fire({ target: s.targetInPanel, deltaY: 100 });
  const up = s.fire({ target: s.targetInPanel, deltaY: -100 });
  check(
    '指针在面板中部：向上/向下滚都不切图（可滚区间内一律交还面板）',
    down.defaultPrevented === false &&
      up.defaultPrevented === false &&
      s.nav.length === 0,
    'nav=' + JSON.stringify(s.nav),
  );
}
// 3) 面板已到底，继续向下 ⇒ 切下一张
{
  const s = setup();
  s.panel.scrollTop = s.panel.scrollHeight - s.panel.clientHeight; // 600
  const e = s.fire({ target: s.targetInPanel, deltaY: 100 });
  check(
    '面板已到底继续向下滚：落下去切下一张（scroll-chaining）',
    e.defaultPrevented === true && s.nav.length === 1 && s.nav[0] === 1,
    'prevented=' + e.defaultPrevented + ' nav=' + JSON.stringify(s.nav),
  );
}
// 4) 面板已到顶，继续向上 ⇒ 切上一张
{
  const s = setup();
  s.panel.scrollTop = 0;
  const e = s.fire({ target: s.targetInPanel, deltaY: -100 });
  check(
    '面板已到顶继续向上滚：落下去切上一张',
    e.defaultPrevented === true && s.nav.length === 1 && s.nav[0] === -1,
    'prevented=' + e.defaultPrevented + ' nav=' + JSON.stringify(s.nav),
  );
}
// 5) 反向：指针不在面板内 ⇒ 原行为不变（切图）
{
  const s = setup();
  const e = s.fire({ target: s.targetOnImage, deltaY: 100 });
  check(
    '🔴 反向：指针在图片区滚动仍然切图（守卫不许把切图整体吃掉）',
    e.defaultPrevented === true && s.nav.length === 1 && s.nav[0] === 1,
    'prevented=' + e.defaultPrevented + ' nav=' + JSON.stringify(s.nav),
  );
}
// 6) 面板内 + Ctrl ⇒ 只缩放，不切图
{
  const s = setup();
  s.panel.scrollTop = 0;
  const e = s.fire({ target: s.targetInPanel, deltaY: 100, ctrlKey: true });
  check(
    '🔴 面板内 Ctrl+滚轮：只缩放、不切图（缩放意图与面板滚动无关）',
    e.defaultPrevented === true &&
      s.nav.length === 0 &&
      s.zooms.length === 1 &&
      s.zooms[0] === -0.15,
    'nav=' + JSON.stringify(s.nav) + ' zoom=' + JSON.stringify(s.zooms),
  );
}
// 7) 浮层未打开 ⇒ 完全不响应
{
  const s = setup(false);
  const e = s.fire({ target: s.targetInPanel, deltaY: 100 });
  check(
    '浮层未 active：滚轮完全不响应（不 preventDefault、不切图）',
    e.defaultPrevented === false && s.nav.length === 0,
    'prevented=' + e.defaultPrevented,
  );
}
// 8) 小 delta 不在面板内 ⇒ 维持原判据（吞掉但不切图）
{
  const s = setup();
  const e = s.fire({ target: s.targetOnImage, deltaY: 10 });
  check(
    '原切图判据保持：|deltaY| ≤ 20 时不切图（小 delta 不误触发）',
    s.nav.length === 0 && e.defaultPrevented === true,
    'nav=' + JSON.stringify(s.nav) + ' prevented=' + e.defaultPrevented,
  );
}
// 9) 面板内容不够长（不可滚）⇒ 不吞滚轮，直接切图
{
  const s = setup();
  s.panel.scrollHeight = 300;
  s.panel.clientHeight = 400; // 不可滚
  const e = s.fire({ target: s.targetInPanel, deltaY: 100 });
  check(
    '面板内容不可滚时：不吃滚轮，直接按原判据切图',
    e.defaultPrevented === true && s.nav.length === 1 && s.nav[0] === 1,
    'prevented=' + e.defaultPrevented + ' nav=' + JSON.stringify(s.nav),
  );
}

// ---------------------------------------------------- 2. 两端静态镜像层

/** 取 wheel 处理器切片（`'wheel',` 这个特征只在 previewOverlay 那处出现）。 */
function wheelSlice(code) {
  const i = code.indexOf("'wheel',");
  if (i < 0) return '';
  const end = code.indexOf('passive: false', i);
  return code.slice(i, end > i ? end + 40 : i + 2000);
}

const desktopCode = stripJsComments(read(RENDERER_EVENTS));
const webCode = stripJsComments(read(WEB_APP));
const desktopSlice = wheelSlice(desktopCode);
const webSlice = wheelSlice(webCode);

check(
  '桌面端 wheel 处理器切片取到了（特征 `\'wheel\',` 还在）',
  desktopSlice.length > 0,
  'len=' + desktopSlice.length,
);
check('网页端 wheel 处理器切片取到了', webSlice.length > 0, 'len=' + webSlice.length);

for (const [label, slice] of [
  ['桌面端', desktopSlice],
  ['网页端', webSlice],
]) {
  const iClosest = slice.indexOf('closest(');
  const iPrevent = slice.indexOf('preventDefault()');
  check(
    label + '：滚轮处理器先判 `closest(面板)`、后 `preventDefault()`（顺序颠倒 = 面板照样被吞）',
    iClosest >= 0 && iPrevent >= 0 && iClosest < iPrevent,
    'closest@' + iClosest + ' preventDefault@' + iPrevent,
  );
  check(
    label + '：守卫真的在判滚动边界（scrollTop / clientHeight / scrollHeight 三者齐）',
    slice.indexOf('scrollTop') >= 0 &&
      slice.indexOf('clientHeight') >= 0 &&
      slice.indexOf('scrollHeight') >= 0,
    'scrollTop=' +
      (slice.indexOf('scrollTop') >= 0) +
      ' clientHeight=' +
      (slice.indexOf('clientHeight') >= 0) +
      ' scrollHeight=' +
      (slice.indexOf('scrollHeight') >= 0),
  );
  check(
    label + '：有修饰键时走缩放分支（ctrlKey / metaKey 都在）',
    slice.indexOf('ctrlKey') >= 0 && slice.indexOf('metaKey') >= 0,
  );
}

check(
  '🔴 两端候选选择器逐字相同（镜面漂移：改一端忘另一端 = 那一端的面板照样被吞）',
  desktopSlice.indexOf(PANEL_SELECTOR) >= 0 && webSlice.indexOf(PANEL_SELECTOR) >= 0,
  'desktop=' + (desktopSlice.indexOf(PANEL_SELECTOR) >= 0) + ' web=' + (webSlice.indexOf(PANEL_SELECTOR) >= 0),
);
check(
  '两端都把两个面板都列进了候选（图片信息 + 字幕设置）',
  desktopSlice.indexOf('.preview-info-panel') >= 0 &&
    desktopSlice.indexOf('.preview-subtitle-settings-panel') >= 0 &&
    webSlice.indexOf('.preview-info-panel') >= 0 &&
    webSlice.indexOf('.preview-subtitle-settings-panel') >= 0,
);
check(
  '两端在守卫里都有 `return`（只判不 return = 等于没写）',
  /if\s*\([^)]*\)\s*return\s*;/.test(desktopSlice) && /if\s*\([^)]*\)\s*return\s*;/.test(webSlice),
);
check(
  '🔴 剥注释确实生效（修复处的注释里写着「不 preventDefault」，不剥会污染顺序断言）',
  read(RENDERER_EVENTS).indexOf('不 preventDefault') >= 0 &&
    desktopCode.indexOf('不 preventDefault') < 0,
  'raw=' +
    (read(RENDERER_EVENTS).indexOf('不 preventDefault') >= 0) +
    ' stripped=' +
    (desktopCode.indexOf('不 preventDefault') >= 0),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[preview-wheel-regression] 预览浮层滚轮行为契约\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[preview-wheel-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[preview-wheel-regression] PASS（' + notes.length + ' 项）\n');
