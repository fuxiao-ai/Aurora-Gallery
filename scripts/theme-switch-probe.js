'use strict';
/* global WebSocket */ // Node 22 有全局 WebSocket，但 ESLint 的 node 环境不认
/**
 * 「切换界面风格」端到端探针（手动跑，不是回归）。
 *
 * 为什么必须有它：`getAppearanceControlValue()` 的取舍规则（预设 vs 两维控件）+ 变更检测短路
 * + 控件残留值，三者**交互**才产生 bug —— 每个文件单独看都自洽，**静态检查永远全绿**。
 * 2026-10-04「切换主题不生效」就是这么漏出去的（两个风格下拉毫无反应，而只改强调色是好的）。
 *
 * 用法：
 *   1) 先起一个带调试端口的实例。**必须隔离**，否则会改到本机真实设置与相册：
 *        LOCALAPPDATA='C:/temp/theme-probe/isolated' \
 *        env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *          --remote-debugging-port=9222 --disable-gpu --disable-gpu-compositing \
 *          --disable-software-rasterizer --no-sandbox . --dev
 *      ⚠️ `--user-data-dir` 对本品无效：`configureWritableAppPaths()` 无条件把 userData
 *      设成 `%LOCALAPPDATA%\<appName>\UserData`，只能注入 LOCALAPPDATA。
 *      ⚠️ 隔离库是空库，实例可能在 ~12s 后自行退出 —— 要在存活窗口内跑完本脚本。
 *   2) PROBE_SETTINGS=<隔离目录>/aurora-gallery/UserData/settings.json \
 *      node scripts/theme-switch-probe.js
 *
 * ⚠️ 跑前务必确认调试端口上**恰好 1 个主窗口 target、且没有残留实例**：两个实例共用同一份
 *    settings.json 会互相覆盖，读数会呈现「看似随机」的错乱（初始值对不上、每个用例的结果
 *    像上一个操作），据此排查会得出完全错误的结论。
 *
 * 退出码：0 全 PASS / 1 有 FAIL / 2 连不上或不满足前置条件。
 */
const fs = require('fs');

const WAIT = parseInt(process.env.PROBE_WAIT_MS || '1100', 10);
const PORT = parseInt(process.env.PROBE_PORT || '9222', 10);
const SETTINGS_PATH =
  process.env.PROBE_SETTINGS ||
  (process.env.LOCALAPPDATA || '') + '\\aurora-gallery\\UserData\\settings.json';

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

/** 读「此刻」的三属性 / 生效色值 / 五个控件的值（不要读启动快照） */
const READ_STATE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
  return {
    theme: root.getAttribute('data-theme'),
    accent: root.getAttribute('data-accent'),
    bg: root.getAttribute('data-bg'),
    bgVar: cs.getPropertyValue('--bg').trim(),
    accentVar: cs.getPropertyValue('--accent').trim(),
    quick: v('quickThemeStyle'),
    // -1 = .value 被设成了不存在的 option（收起状态会一片空白）—— 顶栏去掉空串死选项后
    // 最容易踩的就是这个：凑不出预设时必须回落到「强调色」组，不能硬写空串。
    quickIdx: (() => { const el = document.getElementById('quickThemeStyle'); return el ? el.selectedIndex : null; })(),
    setting: v('settingThemeStyle'),
    accentCtl: v('settingUiAccent'),
    bgCtl: v('settingUiBackground'),
  };
})()`;

/** 与用户手选等价：改值 + 冒泡 change（设置页走委托、顶栏走单绑） */
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

function diskAppearance() {
  try {
    const o = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      themeStyle: o.themeStyle,
      theme: o.theme,
      accent: o.uiAccent,
      bg: o.uiBackground,
      texture: o.uiTexture,
    };
  } catch (e) {
    return { error: String(e && e.message) };
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

/** ⚠️ 「default 背景基调」在 DOM 上的表示是**移除 data-bg 属性**（读出 null），
 *  而磁盘 settings.json 里存的是字符串 'default' —— 两者是同一状态，直接比对会假 FAIL。 */
const normBg = (v) => (v == null || v === '' ? 'default' : v);

/** 用例：预设下拉与两维控件各一条（预设走"先展开"路径，两维走"以控件为准"路径） */
const CASES = [
  {
    title: '顶栏 #quickThemeStyle → paper_gray（浅 + 中性 + 纯黑）',
    id: 'quickThemeStyle',
    value: 'paper_gray',
    expect: { theme: 'light', accent: 'mono', bg: 'amoled' },
  },
  {
    title: '设置页 #settingThemeStyle → ember_night（深 + 玫红 + 墨色）',
    id: 'settingThemeStyle',
    value: 'ember_night',
    expect: { theme: 'dark', accent: 'rose', bg: 'ink' },
  },
  {
    title: '只改强调色 #settingUiAccent → amber（凑不出预设 = 自定义组合）',
    id: 'settingUiAccent',
    value: 'amber',
    expect: { theme: 'dark', accent: 'amber', bg: 'ink' },
  },
  {
    title: '只改背景基调 #settingUiBackground → cool',
    id: 'settingUiBackground',
    value: 'cool',
    expect: { theme: 'dark', accent: 'amber', bg: 'cool' },
  },
  // 顶栏下拉把两维做成了可选项（值为 accent: / bg: 前缀）——「自定义」不再是死选项
  {
    title: '顶栏 → accent:violet（只改强调色，背景基调保持 cool）',
    id: 'quickThemeStyle',
    value: 'accent:violet',
    expect: { theme: 'dark', accent: 'violet', bg: 'cool' },
  },
  {
    title: '顶栏 → bg:default（只改背景基调，强调色保持 violet）',
    id: 'quickThemeStyle',
    value: 'bg:default',
    expect: { theme: 'dark', accent: 'violet', bg: 'default' },
  },
];

/** 22 套预设逐一点选：每套都要真的落到 DOM 与磁盘（数量一多最容易漏掉某一套） */
const PRESET_IDS = process.env.PROBE_SKIP_PRESETS
  ? []
  : [
      'midnight_classic',
      'ice_deep',
      'amber_dawn',
      'forest_shadow',
      'ember_night',
      'graphite_night',
      'nebula_violet',
      'pine_abyss',
      'mocha_night',
      'glass_night',
      'aurora_night',
      'sky_light',
      'cherry_blossom',
      'lavender_dusk',
      'arctic_mint',
      'desert_sand',
      'paper_gray',
      'sage_morning',
      'apricot_haze',
      'frost_cyan',
      'glass_day',
      'aurora_dawn',
    ];

(async () => {
  const ws = new WebSocket(await pageWsUrl());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new Cdp(ws);

  /* 🔴 让页面被视为「已聚焦」——否则 Chromium 会对**未聚焦窗口**做 timer 节流
     （后台 tab/窗口的 setTimeout 最短间隔被抬到 1000ms 量级）。本探针要验证的是
     「悬浮停留 90ms 后才预览」这条防误触逻辑，节流会让它**看起来完全没生效**
     （症状：mouseover 确实触发了，但 DOM 与标记纹丝不动，只有等得更久的用例才偶然通过），
     从而得出"功能坏了"的错误结论。setFocusEmulationEnabled 专治这个，且不会抢真实窗口焦点。 */
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const s0 = await cdp.eval(READ_STATE);
  const d0 = diskAppearance();
  console.log('初始状态');
  console.log('  DOM   ', JSON.stringify(s0));
  console.log('  磁盘  ', JSON.stringify(d0));
  check(
    '初始 DOM 三属性与落库一致（不一致 = 连到了别的实例或落库没跟上）',
    { theme: s0.theme, accent: s0.accent, bg: normBg(s0.bg) },
    { theme: d0.theme, accent: d0.accent, bg: d0.bg },
  );

  for (const c of CASES) {
    if (process.env.PROBE_SKIP_CASES) break;
    console.log('\n' + c.title);
    console.log('  set:', await cdp.eval(setAndChange(c.id, c.value)));
    await sleep(WAIT);
    const s = await cdp.eval(READ_STATE);
    check(
      'DOM 三属性',
      { theme: s.theme, accent: s.accent, bg: normBg(s.bg) },
      c.expect,
    );
    const d = diskAppearance();
    check('落库', { theme: d.theme, accent: d.accent, bg: d.bg }, c.expect);
    check('顶栏选中项有效（不是 -1 空白）', { quickIdx: s.quickIdx >= 0 }, { quickIdx: true });
    console.log(
      `        bg=${s.bgVar} accent=${s.accentVar} quick=${s.quick}(idx ${s.quickIdx}) setting=${s.setting} 两维=${s.accentCtl}/${s.bgCtl}`,
    );
  }

  if (PRESET_IDS.length) {
    console.log('\n' + PRESET_IDS.length + ' 套预设逐一体检（每套都要真的落到 DOM 与磁盘）');
    const FAST = Math.min(WAIT, 420);
    for (const id of PRESET_IDS) {
      await cdp.eval(setAndChange('quickThemeStyle', id));
      await sleep(FAST);
      const s = await cdp.eval(READ_STATE);
      const d = diskAppearance();
      const bgMatches = s.bg === (d.bg === 'default' ? null : d.bg);
      const ok =
        s.quick === id && d.themeStyle === id && s.theme === d.theme && s.accent === d.accent && bgMatches;
      if (ok) {
        pass++;
        console.log(`  PASS  ${id}  ${d.theme}/${d.accent}/${d.bg}  --bg=${s.bgVar}`);
      } else {
        fail++;
        console.log(
          `  FAIL  ${id}  quick=${s.quick} disk=${d.themeStyle} DOM=${s.theme}/${s.accent}/${s.bg} 磁盘=${d.theme}/${d.accent}/${d.bg}`,
        );
      }
    }
  }

  /* ── 悬浮预览验收（本功能核心）──────────────────────────────────────────────
     ⚠️ 必须用**真实鼠标事件**（CDP Input 域）而不是直接调 app.js 里的预览函数 ——
        直接调等于「用实现验证实现」。真鼠标还能顺带证明：触发按钮真的开得起来、
        弹层定位确实算对了（坐标错位时命中测试当场失败）、mouseover 真的接上了、
        以及「落库」与「启动快照」两条链路真的没被碰。
     流程：真鼠标点开弹层 → 悬停某项（DOM 变 / 磁盘与快照不变）→ 移开 → 精确还原。 */
  if (!process.env.PROBE_SKIP_HOVER) {
    console.log('\n悬浮预览验收（真实鼠标事件）');

    const rawSettings = () => {
      try {
        return fs.readFileSync(SETTINGS_PATH, 'utf8');
      } catch (e) {
        return 'ERR:' + (e && e.message);
      }
    };
    const lsSnapshot = () =>
      cdp.eval(
        `(() => { try { return localStorage.getItem('photoManager.appearanceSnapshot.v1'); } catch (e) { return 'ERR'; } })()`,
      );

    /** 弹层里某项的中心点（CSS 像素 —— 与 Input.dispatchMouseEvent 同一坐标系） */
    const itemPoint = (value) =>
      cdp.eval(`(() => {
        const el = document.querySelector('#quickThemeMenu [data-theme-option=' + JSON.stringify(${JSON.stringify(value)}) + ']');
        if (!el) return null;
        // 🔴 弹层 29 项 + max-height 会滚动：滚出可视区的项，getBoundingClientRect() 给的是
        //    **容器外**的坐标，真鼠标移到那里命中的是别的元素（症状：悬停毫无反应，
        //    而"磁盘没变"这类断言照样 PASS，极具迷惑性）。先滚进可视区再取坐标。
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);

    /** 命中测试：该坐标下真正拿到的是哪个主题项 —— 弹层定位错了这里立刻现形 */
    const hitTest = (p) =>
      cdp.eval(
        `(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); if (!e) return null; const it = e.closest ? e.closest('[data-theme-option]') : null; return it ? it.getAttribute('data-theme-option') : null; })()`,
      );

    const menuState = () =>
      cdp.eval(`(() => {
        const m = document.getElementById('quickThemeMenu');
        const b = document.getElementById('quickThemeStyleButton');
        return {
          open: !!m && !m.hidden,
          expanded: b ? b.getAttribute('aria-expanded') : null,
          items: m ? m.querySelectorAll('[data-theme-option]').length : 0,
          groups: m ? m.querySelectorAll('.theme-menu-group').length : 0,
          btnLabel: (document.getElementById('quickThemeStyleLabel') || {}).textContent || '',
          previewing: m
            ? Array.prototype.map.call(m.querySelectorAll('.is-previewing'), (e) => e.getAttribute('data-theme-option'))
            : [],
        };
      })()`);

    const mouse = (type, p, extra) =>
      cdp.send(
        'Input.dispatchMouseEvent',
        Object.assign({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 }, extra || {}),
      );
    const hover = (p) => mouse('mouseMoved', p, { button: 'none', buttons: 0 });
    const realClick = async (p) => {
      await mouse('mouseMoved', p, { button: 'none', buttons: 0 });
      await mouse('mousePressed', p, { buttons: 1 });
      await mouse('mouseReleased', p, { buttons: 0 });
    };

    const stateBefore = await cdp.eval(READ_STATE);
    const diskBefore = diskAppearance();
    const rawBefore = rawSettings();
    const lsBefore = await lsSnapshot();
    const HOVER_WAIT = 800; // > QUICK_THEME_PREVIEW_DELAY_MS(90)，且留足 timer 余量
    /** 移出弹层：往上挪到弹层外（负坐标会被 CDP 拒绝，夹一下） */
    const awayPoint = (from) => ({ x: Math.max(4, from.x - 120), y: Math.max(4, from.y - 40) });

    const btnPoint = await cdp.eval(`(() => {
      const b = document.getElementById('quickThemeStyleButton');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    check('顶栏存在可见的触发按钮 #quickThemeStyleButton（不再是原生 select 直接交互）', {
      ok: !!btnPoint,
    }, { ok: true });

    if (btnPoint) {
      // 1) 真鼠标点开触发按钮
      await realClick(btnPoint);
      await sleep(160);
      const m1 = await menuState();
      check(
        '真鼠标点击按钮 → 弹层打开且 aria-expanded 同步',
        { open: m1.open, expanded: m1.expanded },
        { open: true, expanded: 'true' },
      );
      check(
        '弹层条目 = 22 预设 + 10 强调色 + 11 背景基调 + 9 材质纹理 + 4 面板透明度 / 5 个分组',
        { items: m1.items, groups: m1.groups },
        { items: 56, groups: 5 },
      );
      check('触发按钮文案非空（镜像 select 选中项，不是写死的）', {
        hasLabel: String(m1.btnLabel).length > 0,
      }, { hasLabel: true });

      // —— 诊断（仅排查用：capture 监听 + MutationObserver，完全不改产品逻辑）——
      const armDiag = () =>
        cdp.eval(`(() => {
          window.__probeMouse = ['--armed--'];
          window.__probeTrace = ['--armed--'];
          const m = document.getElementById('quickThemeMenu');
          const root = document.documentElement;
          ['mouseover', 'mouseout', 'mouseenter', 'mouseleave'].forEach((t) => {
            m.addEventListener(t, (e) => {
              const it = e.target && e.target.closest ? e.target.closest('[data-theme-option]') : null;
              window.__probeMouse.push(t + ':' + (it ? it.getAttribute('data-theme-option') : 'other'));
            }, true);
          });
          new MutationObserver((muts) => {
            muts.forEach((mu) => {
              if (mu.type === 'attributes' && mu.attributeName === 'class') {
                const v = mu.target.getAttribute('data-theme-option') || 'menu';
                window.__probeTrace.push('cls:' + v + '=' + mu.target.className);
              }
            });
          }).observe(m, { attributes: true, attributeFilter: ['class'], subtree: true });
          new MutationObserver((muts) => {
            muts.forEach((mu) => {
              window.__probeTrace.push('attr:' + mu.attributeName + '=' + root.getAttribute(mu.attributeName));
            });
          }).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'data-bg'] });
          return 'ok';
        })()`);
      await armDiag();

      // 2) 悬停预设项 → 只预览：DOM 变，磁盘与启动快照都不许变
      const target = 'paper_gray';
      const p = await itemPoint(target);
      const hit = p ? await hitTest(p) : null;
      check('命中测试：该坐标下就是被悬停的那一项（弹层定位若错位这里立刻失败）', { hit }, { hit: target });

      if (p) {
        await hover(p);
        await sleep(HOVER_WAIT);
        const s = await cdp.eval(READ_STATE);
        const m = await menuState();
        const diag = await cdp.eval(`(() => {
          const mm = document.getElementById('quickThemeMenu');
          const root = document.documentElement;
          const pv = mm ? mm.querySelector('.is-previewing') : null;
          const fo = mm ? mm.querySelector('.is-focused') : null;
          return {
            menuHidden: mm ? mm.hidden : 'NO_MENU',
            previewing: pv ? pv.getAttribute('data-theme-option') : null,
            focused: fo ? fo.getAttribute('data-theme-option') : null,
            active: document.activeElement
              ? document.activeElement.getAttribute('data-theme-option') ||
                document.activeElement.id ||
                document.activeElement.tagName
              : null,
            theme: root.getAttribute('data-theme'),
            accent: root.getAttribute('data-accent'),
            bg: root.getAttribute('data-bg'),
          };
        })()`);
        console.log('  [诊断] ' + JSON.stringify(diag));
        const tl = await cdp.eval(
          `({ mouse: window.__probeMouse ? window.__probeMouse.slice(-16) : null, trace: window.__probeTrace ? window.__probeTrace.slice(-16) : null })`,
        );
        console.log('  [鼠标] ' + JSON.stringify(tl.mouse));
        console.log('  [变化] ' + JSON.stringify(tl.trace));
        check(
          '悬停 → DOM 三属性立刻变成该项三元组（预览生效）',
          { theme: s.theme, accent: s.accent, bg: normBg(s.bg) },
          { theme: 'light', accent: 'mono', bg: 'amoled' },
        );
        check('悬停 → 该项被标记为「预览中」', { previewing: m.previewing.join(',') }, { previewing: target });
        check('悬停 → 磁盘外观字段纹丝不动（预览不落库）', diskAppearance(), diskBefore);
        check('悬停 → 磁盘 settings.json 原文逐字节未变', { same: rawSettings() === rawBefore }, { same: true });
        check(
          '悬停 → localStorage 启动快照未变（否则刷新后首帧会停在预览主题上）',
          { same: (await lsSnapshot()) === lsBefore },
          { same: true },
        );

        // 3) 移开 → 精确还原
        await hover(awayPoint(p));
        await sleep(300);
        const s2 = await cdp.eval(READ_STATE);
        check(
          '移开弹层 → 精确还原到预览前的三元组',
          { theme: s2.theme, accent: s2.accent, bg: normBg(s2.bg) },
          { theme: stateBefore.theme, accent: stateBefore.accent, bg: normBg(stateBefore.bg) },
        );
        const m2 = await menuState();
        check('移开 → 「预览中」标记已清除', { count: m2.previewing.length }, { count: 0 });

        // 4) 悬停 accent: 前缀项 → 只换那一维（另一维保持当前值）
        const ap = await itemPoint('accent:teal');
        if (ap) {
          const apHit = await hitTest(ap);
          check(
            '命中测试：accent:teal 项坐标可用（弹层滚动后仍要命中正确）',
            { hit: apHit },
            { hit: 'accent:teal' },
          );
          await hover(ap);
          await sleep(HOVER_WAIT);
          const s3 = await cdp.eval(READ_STATE);
          check(
            '悬停 accent:teal → 只换强调色，背景基调保持当前值',
            { accent: s3.accent, bg: normBg(s3.bg) },
            { accent: 'teal', bg: normBg(stateBefore.bg) },
          );
          check('悬停 accent: 前缀项 → 磁盘仍纹丝不动', diskAppearance(), diskBefore);
          await hover(awayPoint(ap));
          await sleep(300);
          const s4 = await cdp.eval(READ_STATE);
          check(
            '移开 → 再次精确还原（连续预览不叠加、不残留）',
            { theme: s4.theme, accent: s4.accent, bg: normBg(s4.bg) },
            { theme: stateBefore.theme, accent: stateBefore.accent, bg: normBg(stateBefore.bg) },
          );
        }

        // 5) 真鼠标点选 → 这一次必须落库
        //    ⚠️ 刻意换一个**与当前生效不同**的预设：若点的恰是当前项，走的是
        //    「点当前项 → 只还原、不落库」分支，快照本就不该更新 → 断言会假 FAIL。
        const commitTarget = 'ice_deep';
        const cp = await itemPoint(commitTarget);
        if (cp) {
          await realClick(cp);
          await sleep(WAIT);
          const s5 = await cdp.eval(READ_STATE);
          const d5 = diskAppearance();
          const m5 = await menuState();
          check(
            '真鼠标点选 → DOM 与磁盘都落到该项（点选才是唯一落库入口）',
            { theme: s5.theme, accent: s5.accent, bg: normBg(s5.bg), disk: d5.themeStyle },
            { theme: 'dark', accent: 'cyan', bg: 'amoled', disk: commitTarget },
          );
          check(
            '点选后弹层自动关闭',
            { open: m5.open, expanded: m5.expanded },
            { open: false, expanded: 'false' },
          );
          check(
            '点选后启动快照已更新（这次是真实意图，应当写）',
            { changed: (await lsSnapshot()) !== lsBefore },
            { changed: true },
          );

          // 边界：先 hover 别的项制造预览残留，再点「当前生效项」——
          // 值没变 → 不该落库；但预览残留**必须**被还原掉（否则界面停在预览态）。
          await realClick(btnPoint); // 步骤 5 点选后弹层已关闭，先重开才取得到坐标
          await sleep(220);
          const rp = await itemPoint('ember_night');
          if (rp) {
            await hover(rp);
            await sleep(HOVER_WAIT);
            const sp = await cdp.eval(READ_STATE);
            check('（前置）hover ember_night 已进入预览态', { accent: sp.accent }, { accent: 'rose' });
            await realClick(await itemPoint(commitTarget));
            await sleep(WAIT);
            const s6 = await cdp.eval(READ_STATE);
            check(
              '点选「当前生效项」→ 只还原预览、不落库（DOM 回到该项，磁盘未变）',
              {
                theme: s6.theme,
                accent: s6.accent,
                bg: normBg(s6.bg),
                disk: diskAppearance().themeStyle,
              },
              { theme: 'dark', accent: 'cyan', bg: 'amoled', disk: commitTarget },
            );
          }

          // 复原到探针开跑前的设置，不给后续用例留脏数据
          if (stateBefore.quick) {
            await cdp.eval(setAndChange('quickThemeStyle', stateBefore.quick));
            await sleep(WAIT);
          }
        }
      }
    }
  }

  /* 材质档（玻璃 / 渐变）实测：**半透明必须真的生效**，不能只是写在 CSS 里。
     护栏 §7b 查的是源码文本，这里查 getComputedStyle 的真实结果 —— 中间还隔着
     「选择器特异性 / 后加载样式表覆盖」这些盲区（gallery-design.css 就偷改过 default 档）。 */
  if (!process.env.PROBE_SKIP_MATERIAL) {
    console.log('\n材质档实测（面板半透明的真实计算值）');
    const MFAST = Math.min(WAIT, 420);
    for (const id of ['glass_night', 'aurora_night', 'glass_day', 'aurora_dawn']) {
      await cdp.eval(setAndChange('quickThemeStyle', id));
      await sleep(MFAST);
      const v = await cdp.eval(`(() => {
        const cs = getComputedStyle(document.documentElement);
        const alpha = (s) => {
          const m = String(s).match(/rgba?\\([^)]*,\\s*([\\d.]+)\\s*\\)$/);
          return m ? parseFloat(m[1]) : null;
        };
        const g = cs.getPropertyValue('--glass').trim();
        const c = cs.getPropertyValue('--bg-card').trim();
        return { glass: g, card: c, aGlass: alpha(g), aCard: alpha(c) };
      })()`);
      const ok =
        v.aGlass != null && v.aCard != null && v.aGlass <= 0.75 && v.aCard <= 0.75;
      if (ok) {
        pass++;
        console.log(`  PASS  ${id}  --glass=${v.glass}  --bg-card=${v.card}`);
      } else {
        fail++;
        console.log(`  FAIL  ${id}  --glass=${v.glass}  --bg-card=${v.card}（应当半透明）`);
      }
    }
  }

  /* 后补的两维选项实测：新增 4 强调色 + 4 背景档逐一点选，三条都要成立 ——
     ① DOM 属性变了 ② 磁盘落了 ③ **计算值真的与基线不同**。
     第 ③ 条是这段的独特价值：静态护栏（含 §9 / §9b）证明的是「名字进了白名单与样式表」
     以及源码层叠推算，这里是 getComputedStyle 的**运行期真实结果** —— 能抓「档块被后加载
     样式表压掉」「选择器特异性不够」这类只在真实渲染里暴露的失效：那时属性会照改、磁盘会
     照落，唯独画面上没变化。 */
  if (!process.env.PROBE_SKIP_EXTRA) {
    console.log('\n后补两维实测（新增 4 强调色 + 4 背景档逐一点选）');
    const XFAST = Math.min(WAIT, 420);
    const readVars = () =>
      cdp.eval(`(() => {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        return {
          theme: root.getAttribute('data-theme'),
          accent: root.getAttribute('data-accent'),
          bg: root.getAttribute('data-bg'),
          accentVar: cs.getPropertyValue('--accent').trim(),
          bgVar: cs.getPropertyValue('--bg').trim(),
        };
      })()`);
    // 先回到确定的起手态（default 背景 + violet 强调），量一组基线供「计算值必须不同」比对
    await cdp.eval(setAndChange('quickThemeStyle', 'bg:default'));
    await sleep(XFAST);
    await cdp.eval(setAndChange('quickThemeStyle', 'accent:violet'));
    await sleep(XFAST);
    const base = await readVars();
    console.log(
      `  基线：${base.theme} / violet / default  --accent=${base.accentVar}  --bg=${base.bgVar}`,
    );

    const extraCases = [
      ['accent:coral', 'accent', 'coral'],
      ['accent:indigo', 'accent', 'indigo'],
      ['accent:green', 'accent', 'green'],
      ['accent:red', 'accent', 'red'],
      ['bg:paper', 'bg', 'paper'],
      ['bg:mist', 'bg', 'mist'],
      ['bg:forest', 'bg', 'forest'],
      ['bg:clay', 'bg', 'clay'],
    ];
    for (const [value, dim, want] of extraCases) {
      await cdp.eval(setAndChange('quickThemeStyle', value));
      await sleep(XFAST);
      const v = await readVars();
      const d = diskAppearance();
      const domOk = dim === 'accent' ? v.accent === want : v.bg === want;
      const diskOk = dim === 'accent' ? d.accent === want : normBg(d.bg) === want;
      const varOk = dim === 'accent' ? v.accentVar !== base.accentVar : v.bgVar !== base.bgVar;
      const gotVar = dim === 'accent' ? v.accentVar : v.bgVar;
      const line = `${value}  DOM=${v.accent}/${v.bg}  磁盘=${d.accent}/${d.bg}  --${dim}=${gotVar}`;
      if (domOk && diskOk && varOk) {
        pass++;
        console.log(`  PASS  ${line}`);
      } else {
        fail++;
        console.log(
          `  FAIL  ${line}` +
            (!domOk ? ' [DOM 属性未变]' : '') +
            (!diskOk ? ' [磁盘未落]' : '') +
            (!varOk ? ' [计算值未变 = CSS 块漏写或被覆盖]' : ''),
        );
      }
    }
  }

  /* 材质纹理（第三维）实测：**明暗两档各 8 种**逐一点选，四条同时成立 ——
     ① html[data-texture] 变了 ② 磁盘 settings.json.uiTexture 落了 ③ **用户真实能看到的
     每一个面**的计算 backgroundImage 都变成了同一张非 none 的图 ④ 各档两两不同
     ⑤ 关回 none 后逐面**回到主题基线**（不是「全部变成 none」—— 深色墨色底时 body 本来
     就有主题自己的极光渐变，那是正常画法，不该被判成残留）。

     🔴 「覆盖率」的口径必须钉死在「等于那张多数面共用的纹理图」，不能写成「非 none 就算铺到」：
     深色 + 墨色底时 `html[data-theme='dark'][data-bg='ink'] body { background: <5 层极光渐变> }`
     给 body 铺的是**别的图**，粗口径会把 body 记成已覆盖 → 覆盖率虚报（85% 而非真值 78%），
     「body 上根本不是纹理」被掩盖。现在挂别图的面会单列成「挂了别的图（不是纹理）的面」。

     🔴 为什么是「可见面」而不是「装饰层」。原设计把纹理画在 `body::after` 全屏层上
     （fixed + z-index:0），指望铺在内容之下透视出来 —— 2026-10-05 实测**彻底不可见**：
     把该层染成纯红，在每一种背景基调下露出面积都是 0.01%（一个红像素都没有），
     而把同一层抬到 z-index:99999 立刻满屏变红 → 是被盖住，不是没生成。根因是收尾层
     gallery-design.css 把面板全拍成了不透明实色。所以纹理现在是**面自己的一层背景**。

     🔴 为什么必须**分两档跑**。改完之后第一次跑探针只测了浅色档，结果是 84/84 全绿 ——
     但那是**假的绿**：当时纹理在 `.titlebar/.topbar/body/.browse-footer` 上是对的，
     而 `.content-area`（占屏 56%）/`.toolbar`/`.sidebar` 三个面一条纹理都没有（覆盖率 25%）。
     根因是 `html[data-theme='light'] .content-area|.toolbar|.sidebar { background: color-mix(...) }`
     用**简写 + 更高特异性 (0,2,1)** 把 `background-image` 重置成了 none，而**深色档没有这几条**。
     也就是说：**只测一个明暗档的探针，恰好只能测到没坏的那一半**。现在两档都跑。

     🔴 这条断言**只能用命中测试**（`elementFromPoint` 网格采样）来写：
     「attr 变了 / 磁盘落了 / 某个元素的计算 backgroundImage 非 none」三条在出这个 bug
     时**全部为真**，而屏幕上三块大面板什么都没有。只有问「用户在这个像素上看到的是哪个面、
     那个面的背景图层是不是纹理」才咬得住。静态护栏 §9d 只能守「规则在、!important 在」。
     ⚠️ grep 源码同样抓不到：要判定谁赢必须跨 8 张样式表算层叠特异性，只有运行期算得准。 */
  if (!process.env.PROBE_SKIP_TEXTURE) {
    console.log('\n材质纹理实测（第三维：明暗两档 × 8 种逐一点选 + 关闭态）');
    const TWAIT = Math.min(WAIT, 420);
    // 覆盖率下限。隔离库是**空库**（探针的前置要求），实测 100%：7 个面全挂上。
    // 有照片时会被照片卡片自己盖住而下降，所以留足余量，只抓「整块面板没铺到」
    // 这一类（浅色档 bug 时是 25%）。
    const MIN_COVERAGE = 0.85;
    const readTexture = () =>
      cdp.eval(`(() => {
        const SURF = ['body', '.content-area', '.topbar', '.titlebar', '.browse-footer', '.toolbar', '.sidebar'];
        const read = (el) => {
          const cs = getComputedStyle(el);
          return { image: cs.backgroundImage, size: cs.backgroundSize };
        };
        // ① 命中测试：把人真实看到的像素归到「管辖它的那个可见面」上
        const ownerOf = (node) => {
          for (let n = node; n; n = n.parentElement) {
            if (n.tagName === 'BODY') return 'body';
            for (const s of SURF) { if (s !== 'body' && n.matches(s)) return s; }
          }
          return '(none)';
        };
        const hits = {}, owner = {};
        let total = 0;
        for (let y = 6; y < window.innerHeight; y += 22) {
          for (let x = 6; x < window.innerWidth; x += 22) {
            const el = document.elementFromPoint(x, y);
            if (!el) continue;
            total++;
            const k = ownerOf(el);
            hits[k] = (hits[k] || 0) + 1;
            if (!owner[k]) owner[k] = el.tagName === 'BODY' ? document.body : (el.closest(SURF.slice(1).join(',')) || document.body);
          }
        }
        const bySurface = {};
        for (const k of Object.keys(hits)) bySurface[k] = { points: hits[k], ...read(owner[k]) };
        // ② 顺带把 7 个面各自的计算值直接读一份（关态断言用；不依赖命中测试）
        const direct = {};
        for (const s of SURF) { const e = document.querySelector(s); direct[s] = e ? read(e) : null; }
        return {
          attr: document.documentElement.getAttribute('data-texture'),
          theme: document.documentElement.getAttribute('data-theme'),
          total, bySurface, direct,
        };
      })()`);

    /** 命中测试覆盖到的面里，有几成挂着**同一张**纹理图。
     *  ⚠️ 口径必须钉死在「等于那张多数面共用的图」，不能写成「非 none 就算铺到」：
     *  深色档 + 墨色底时 `html[data-theme='dark'][data-bg='ink'] body` 会给 body 铺
     *  **5 层极光渐变** —— 粗口径会把 body 当成「已覆盖」，覆盖率被虚报（实测 85% 而非真值），
     *  于是「body 上根本不是纹理」这件事被掩盖。所以这里取**众数图**作参照，只认与它相同的面。 */
    const coverageOf = (v) => {
      const painted = Object.entries(v.bySurface).filter(([, s]) => s.image && s.image !== 'none');
      const points = new Map();
      for (const [, s] of painted) points.set(s.image, (points.get(s.image) || 0) + s.points);
      let ref = 'none';
      let refPts = 0;
      for (const [img, p] of points) if (p > refPts) { refPts = p; ref = img; }
      const on = painted.filter(([, s]) => s.image === ref);
      const off = painted.filter(([, s]) => s.image !== ref);
      return {
        ratio: v.total ? refPts / v.total : 0,
        surfaces: on.map(([k]) => k),
        // 挂了**别的**图（比如墨色底的极光渐变）= 这一样是「纹理没铺到」，必须单独点出来
        foreign: off.map(([k, s]) => k + '(' + ((s.points / (v.total || 1)) * 100).toFixed(0) + '%)'),
        // 没挂任何图的可见面
        bare: Object.entries(v.bySurface)
          .filter(([, s]) => !s.image || s.image === 'none')
          .map(([k, s]) => k + '(' + ((s.points / (v.total || 1)) * 100).toFixed(0) + '%)'),
        uniform: off.length === 0,
        image: ref,
        size: on.length ? on[0][1].size : 'none',
      };
    };

    const textures = [
      ['texture:grain', 'grain'],
      ['texture:paper', 'paper'],
      ['texture:linen', 'linen'],
      ['texture:frost', 'frost'],
      ['texture:grid', 'grid'],
      ['texture:dots', 'dots'],
      ['texture:stripe', 'stripe'],
      ['texture:wood', 'wood'],
    ];
    // 明暗各档用一个**确定**的预设打底（不靠实例碰巧停在哪个主题上）。
    // ⚠️ 预设只固定三元组，不碰纹理（第三维不被任何预设使用）—— 下面每条都先套预设再点纹理，
    //    顺带把「套预设不会清掉纹理」这条不变量也测了。
    const PHASES = [
      { label: '浅色档', preset: 'frost_cyan', theme: 'light' },
      { label: '深色档', preset: 'ember_night', theme: 'dark' },
    ];
    // 每种纹理每档各量一次 → 16 条；关态两档各 1 条 + 两档各 1 条「回到基线」
    const SURF_ORDER = ['.content-area', '.topbar', '.titlebar', '.browse-footer', '.toolbar', '.sidebar', 'body'];
    const sigOf = (direct) =>
      SURF_ORDER.map((s) => s + '=' + (direct[s] ? direct[s].image : 'MISSING')).join(' | ');
    for (const phase of PHASES) {
      await cdp.eval(setAndChange('quickThemeStyle', phase.preset));
      await sleep(TWAIT);
      await cdp.eval(setAndChange('quickThemeStyle', 'texture:none'));
      await sleep(TWAIT);
      const tBase = await readTexture();
      // 基线 = **主题自己**的画法。⚠️ 不可能是「7 个面全 none」：深色 + 墨色底时
      // `html[data-theme='dark'][data-bg='ink'] body { background: <5 层极光渐变> }` 本来就给
      // body 铺了图 —— 那是主题的一部分，关掉纹理后它必须**原样回来**。
      // 所以关态的判据是「逐面 == 这里的基线」，不是「逐面 == none」。
      const baseSig = sigOf(tBase.direct);
      check(
        `${phase.label} 起手态：theme=${tBase.theme}、不设 data-texture 属性（纹理没漏进来）`,
        { theme: tBase.theme, attr: tBase.attr },
        { theme: phase.theme, attr: null },
      );

      // seenImages 每档重置：几档纹理用 `currentColor` 染色（linen/grid/dots/stripe），
      // 而 currentColor 在 computed 值里**已经解析成具体色**了 → 同一档纹理在明暗两档
      // 算出来的字符串本来就不同。跨档共用一张表会把「明暗各一份」误判成重复。
      const seenImages = new Map();
      const textureImages = new Set();
      for (const [value, want] of textures) {
        await cdp.eval(setAndChange('quickThemeStyle', value));
        await sleep(TWAIT);
        const v = await readTexture();
        const d = diskAppearance();
        const c = coverageOf(v);
        const domOk = v.attr === want;
        const diskOk = d.texture === want;
        const themeOk = v.theme === phase.theme;
        const spreadOk = c.ratio >= MIN_COVERAGE && c.uniform && c.image !== 'none';
        const uniqOk = !seenImages.has(c.image);
        const dupOf = seenImages.get(c.image);
        // dots 是唯一需要显式平铺尺寸的档：少了会被拉成一整屏一个大点
        const first = String(c.size).split(',')[0].trim();
        const sizeOk = want === 'dots' ? first === '15px 15px' : first === 'auto';
        if (spreadOk && uniqOk && themeOk) {
          seenImages.set(c.image, want);
          textureImages.add(c.image);
        }
        const ok = domOk && diskOk && themeOk && spreadOk && uniqOk && sizeOk;
        const line =
          `[${phase.label}] ${value}  theme=${v.theme}  DOM=${v.attr}  磁盘=${d.texture}  size=${first}` +
          `  覆盖=${(c.ratio * 100).toFixed(0)}%  面=[${c.surfaces.join(',')}]  image=${String(c.image).slice(0, 34)}…`;
        if (ok) {
          pass++;
          console.log(`  PASS  ${line}`);
        } else {
          fail++;
          console.log(
            `  FAIL  ${line}` +
              (!themeOk ? ` [不在预期明暗档：期望 ${phase.theme}]` : '') +
              (!domOk ? ' [DOM 属性未变]' : '') +
              (!diskOk ? ' [磁盘未落]' : '') +
              (!spreadOk
                ? ` [纹理没落到可见面上：覆盖 ${(c.ratio * 100).toFixed(0)}%（下限 ${MIN_COVERAGE * 100}%）` +
                  `${c.image === 'none' ? '、连一张非 none 的都没有' : ''}` +
                  `${c.bare.length ? '；完全没背景图的面：' + c.bare.join(' ') : ''}` +
                  `${c.foreign.length ? '；挂了别的图（不是纹理）的面：' + c.foreign.join(' ') : ''}]`
                : '') +
              (!sizeOk ? ` [平铺尺寸不对：${first}]` : '') +
              (!uniqOk ? ` [与 ${dupOf} 同图 = 两档实际是同一个纹理]` : ''),
          );
        }
      }

      // 每档收尾：关回 none，断言「逐面回到开纹理之前的基线」，并且没有任何一面
      // 还挂着刚才那 8 张纹理图之一（后者是「纹理没撤干净/被别的规则粘住」的兜底）。
      await cdp.eval(setAndChange('quickThemeStyle', 'texture:none'));
      await sleep(TWAIT);
      const tEnd = await readTexture();
      const stuck = SURF_ORDER.filter((s) => tEnd.direct[s] && textureImages.has(tEnd.direct[s].image));
      check(
        `${phase.label} 收尾：纹理关回 none 后逐面回到主题基线（无一面残留纹理）`,
        { attr: tEnd.attr, stuck: stuck.join(',') || '(无)', sameAsBase: sigOf(tEnd.direct) === baseSig ? '是' : '否' },
        { attr: null, stuck: '(无)', sameAsBase: '是' },
      );
      if (sigOf(tEnd.direct) !== baseSig) {
        for (const s of SURF_ORDER) {
          const a = tBase.direct[s] ? tBase.direct[s].image : 'MISSING';
          const b = tEnd.direct[s] ? tEnd.direct[s].image : 'MISSING';
          if (a !== b) {
            console.log(`        ${s}\n          基线 ${String(a).slice(0, 100)}\n          收尾 ${String(b).slice(0, 100)}`);
          }
        }
      }
    }
  }

  /* 面板透明度（第五维）实测：**明暗两档 × 3 档**逐一点选，四条同时成立 ——
     ① html[data-opacity] 属性 ② 磁盘 settings.json.uiOpacity 落了
     ③ 用户真实能看到的界面面（顶栏 / 侧栏 / 内容区）计算 background-color **确实变了**
     ④ 极光同步提亮（blob 的计算 opacity 高于关闭态）
     ⑤ 关回 opaque 后**属性被移除**（不是写成 'opaque'）且底色回到基线。

     🔴 为什么不能只查属性：属性照改、磁盘照落，而 CSS 档块漏写 / 被后加载样式表压掉时，
     **画面一点都不会变** —— 静态检查全绿（theme-regression 只能守「块在、!important 在」）。
     2026-10-05 实测：只降面板 alpha 时面板色差 ΔE 只有 4~6，因为 `--glass` 与 body 底
     `--bg-primary` 本就近乎同色；真正承载「通透感」的是极光层 → 所以 ④ 是硬条件。

     🔴 两档都要跑：浅色档的 `.aurora-blob` 走 `mix-blend-mode: screen`、默认 opacity 0.14，
     沿用深色那组值会「开了没反应」（与纹理那个「只测浅色档恰好测到没坏的一半」同源）。 */
  if (!process.env.PROBE_SKIP_OPACITY) {
    console.log('\n面板透明度实测（第五维：明暗两档 × 3 档逐一点选 + 关闭态）');
    const OWAIT = Math.min(WAIT, 420);
    const readOpacity = () =>
      cdp.eval(`(() => {
        const root = document.documentElement;
        const bgOf = (sel) => {
          const el = document.querySelector(sel);
          return el ? getComputedStyle(el).backgroundColor : 'MISSING';
        };
        const blob = document.querySelector('.aurora-blob');
        return {
          theme: root.getAttribute('data-theme'),
          attr: root.getAttribute('data-opacity'),
          alpha: getComputedStyle(root).getPropertyValue('--ui-alpha').trim(),
          topbar: bgOf('.topbar'),
          sidebar: bgOf('.sidebar'),
          content: bgOf('.content-area'),
          blob: blob ? getComputedStyle(blob).opacity : 'MISSING',
        };
      })()`);
    const OPA_EXPECT = { slight: '82%', medium: '64%', clear: '46%' };
    const OPA_PHASES = [
      { label: '浅色档', preset: 'frost_cyan', theme: 'light' },
      { label: '深色档', preset: 'ember_night', theme: 'dark' },
    ];
    for (const phase of OPA_PHASES) {
      await cdp.eval(setAndChange('quickThemeStyle', phase.preset));
      await sleep(OWAIT);
      await cdp.eval(setAndChange('quickThemeStyle', 'opacity:opaque'));
      await sleep(OWAIT);
      const base = await readOpacity();
      check(
        `${phase.label} 起手态：theme=${phase.theme}、不设 data-opacity 属性、--ui-alpha 兜底 100%`,
        { theme: base.theme, attr: base.attr, alpha: base.alpha },
        { theme: phase.theme, attr: null, alpha: '100%' },
      );
      for (const name of ['slight', 'medium', 'clear']) {
        await cdp.eval(setAndChange('quickThemeStyle', 'opacity:' + name));
        await sleep(OWAIT);
        const r = await readOpacity();
        let disk = null;
        try {
          // ⚠️ 不要复用悬浮预览块里的 rawSettings()（它是那个 if 块内的私有函数，
          // 这里拿不到）；直接读同一份 SETTINGS_PATH 即可。
          disk = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')).uiOpacity;
        } catch (e) {}
        check(
          `${phase.label} · ${name}：DOM 属性 + 磁盘 uiOpacity + --ui-alpha 计算值三处一致`,
          { attr: r.attr, disk: disk, alpha: r.alpha },
          { attr: name, disk: name, alpha: OPA_EXPECT[name] },
        );
        check(
          `${phase.label} · ${name}：面板底色真的变了（属性对了但 CSS 没生效 = 静默失效）`,
          { topbar: r.topbar !== base.topbar, sidebar: r.sidebar !== base.sidebar },
          { topbar: true, sidebar: true },
        );
        check(
          `${phase.label} · ${name}：极光同步提亮（只降面板 alpha 肉眼看不出）`,
          { brighter: parseFloat(r.blob) > parseFloat(base.blob) },
          { brighter: true },
        );
      }
      await cdp.eval(setAndChange('quickThemeStyle', 'opacity:opaque'));
      await sleep(OWAIT);
      const back = await readOpacity();
      check(
        `${phase.label} 关回 opaque：属性被移除（不是写 'opaque'）且面板底色逐值回到基线`,
        {
          attr: back.attr,
          topbar: back.topbar === base.topbar,
          sidebar: back.sidebar === base.sidebar,
          content: back.content === base.content,
        },
        { attr: null, topbar: true, sidebar: true, content: true },
      );
    }
  }

  console.log(`\n===== 合计 PASS ${pass} / FAIL ${fail} =====`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('PROBE ERROR ' + (e && e.message ? e.message : e));
  process.exit(2);
});
