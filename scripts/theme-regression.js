'use strict';
/**
 * 界面风格（主题）契约回归。
 *
 * 背景：外观 = 三元组 (theme, uiAccent, uiBackground)，`themeStyle` 只是派生的标签。
 * 这套东西散落在 **5 个文件**里（主进程预设表 / 渲染层预设表 + 白名单 / 首帧内联脚本 /
 * 两个 index.html 的 <option> / 网页端 token 表），任何一处不同步都会静默出问题：
 *   - 预设表不一致 → 下拉里的项切换后落到别的三元组
 *   - 白名单不一致 → 首帧闪一下再切、或设置被 normalize 回默认
 *   - 网页端色值与 styles.css 漂移 → 同一个主题名两端观感不同（历史情况：樱雾在桌面是暖米、
 *     在网页是粉白）
 *   - 背景档位不够分 → 两个预设背景逐字节相同（历史 bug：暮紫微光 = 樱雾粉昼，ΔE = 0）
 *
 * 所以本脚本不只比对"名字集合"，还**按 CSS 层叠顺序算出每个预设最终的 --bg / --bg-secondary**，
 * 再断言两两色差下限、以及网页端 token 与 CSS 逐值相等。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function fail(msg) {
  failures += 1;
  console.log('  ✗ ' + msg);
}
function expect(cond, msg) {
  if (cond) ok(msg);
  else fail(msg);
}

// ---------- 解析器 ----------

/** main.js 的 THEME_STYLE_PRESETS（顺序即对象书写顺序） */
function parseMainPresets(src) {
  const m = src.match(/var THEME_STYLE_PRESETS = \{([\s\S]*?)\n\};/);
  if (!m) return null;
  const re =
    /(\w+):\s*\{\s*theme:\s*'(\w+)',\s*uiAccent:\s*'(\w+)',\s*uiBackground:\s*'(\w+)'\s*\}/g;
  const out = [];
  let x;
  while ((x = re.exec(m[1]))) {
    out.push({ id: x[1], theme: x[2], uiAccent: x[3], uiBackground: x[4] });
  }
  return out;
}

/** ui-shell.js 的 UI_THEME_PRESETS */
function parseRendererPresets(src) {
  const m = src.match(/var UI_THEME_PRESETS = \[([\s\S]*?)\n {2}\];/);
  if (!m) return null;
  const re =
    /\{\s*id:\s*'(\w+)',\s*label:\s*'([^']*)',\s*theme:\s*'(\w+)',\s*uiAccent:\s*'(\w+)',\s*uiBackground:\s*'(\w+)',?\s*\}/g;
  const out = [];
  let x;
  while ((x = re.exec(m[1]))) {
    out.push({
      id: x[1],
      label: x[2],
      theme: x[3],
      uiAccent: x[4],
      uiBackground: x[5],
    });
  }
  return out;
}

/** 某个 <select id="..."> 里的 option value 序列（含空串） */
function selectValues(html, id) {
  const m = html.match(new RegExp('<select[^>]*id="' + id + '"[\\s\\S]*?</select>'));
  if (!m) return null;
  const out = [];
  const re = /<option value="([^"]*)"/g;
  let x;
  while ((x = re.exec(m[0]))) out.push(x[1]);
  return out;
}

/** 用 vm 加载网页端 token 模块（UMD 挂到 window） */
function loadWebTheme() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/web/js/web-theme-shared.js'), sandbox);
  return sandbox.WebTheme || (sandbox.window && sandbox.window.WebTheme);
}

/** 剥掉 CSS 注释后，按出现顺序取出所有「选择器 { 声明 }」 */
function parseCssBlocks(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let x;
  while ((x = re.exec(clean))) {
    const sel = x[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    const decls = {};
    x[2].split(';').forEach((d) => {
      const i = d.indexOf(':');
      if (i < 0) return;
      decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    });
    blocks.push({ sel, decls });
  }
  return blocks;
}

/** 逗号分隔的选择器列表 → 去空白的数组（多选择器规则必须逐段比对） */
function splitSel(sel) {
  return String(sel)
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** 单个选择器片段是否命中给定三元组（只需要认实际用到的几种形态） */
function oneSelectorMatches(s, theme, accent, bg) {
  if (s === ':root') return theme === 'dark';
  // gallery-design.css（两端共用的收尾层）用 `html:not([data-bg])` 改写整个 default 档。
  // 它命中「未设 data-bg」的所有组合；浅色随后被 `html[data-theme='light']:not([data-bg])`
  // 以更高特异性覆盖 —— 与浏览器一致（靠下面的特异性排序，不是靠文件顺序）。
  if (/^html(:not\(\[data-bg\]\))+$/.test(s)) return bg === 'default';
  // html[...] 与 [data-theme='...'] 两种写法都要认（浅色基础块用的是后者，没有 html 前缀）
  const m = s.match(/^(?:html)?\[data-theme='(\w+)'\](.*)$/);
  if (!m) return false;
  if (m[1] !== theme) return false;
  const rest = m[2];
  // 只接受「属性选择器 / :not([data-bg])」结尾：后代选择器（如 `[data-theme='light'] .aurora-blob`）
  // 不作用于根元素，必须排除，否则会把无关声明算进来
  if (rest && !/^(?:\[data-(?:accent|bg)='\w+'\]|:not\(\[data-bg\]\))+$/.test(rest)) return false;
  const am = rest.match(/\[data-accent='(\w+)'\]/);
  if (am && am[1] !== accent) return false;
  const bm = rest.match(/\[data-bg='(\w+)'\]/);
  if (bm) {
    if (bm[1] !== bg) return false;
  } else if (/:not\(\[data-bg\]\)/.test(rest)) {
    // default 档不设 data-bg 属性
    if (bg !== 'default') return false;
  }
  return true;
}

/**
 * 选择器特异性 [a,b,c] 的**近似**算法（够本项目用：id / 属性 / 类 / 伪类 / 元素）。
 * ⚠️ 近似点：`:not()` 本身被多计一个 b。但本项目里所有选择器的 b 值相对顺序因此仍然正确
 *   （:root < html:not([data-bg]) < html[data-theme=..]:not([data-bg]) < 带 accent 的覆盖块），
 *   而**相对顺序**才是这里唯一需要的东西。
 */
function specificityOfOne(sel) {
  const s = String(sel).trim();
  if (!s) return [0, 0, 0];
  const c =
    (s.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length +
    (s.match(/::[a-zA-Z-]+/g) || []).length;
  const b =
    (s.match(/\[[^\]]*\]/g) || []).length +
    (s.match(/\.[\w-]+/g) || []).length +
    (s.match(/:(?!:)[a-zA-Z-]+/g) || []).length;
  return [0, b, c];
}

function cmpSpec(x, y) {
  for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] - y[k];
  return 0;
}

/** 逗号分隔的多选择器：取「最具体」的那段（覆盖场景下只要有一段命中就会生效） */
function specificityOf(sel) {
  return String(sel)
    .split(',')
    .map(specificityOfOne)
    .reduce((m, v) => (cmpSpec(v, m) > 0 ? v : m), [0, 0, 0]);
}

/**
 * 按真实层叠规则排序：**先特异性，同特异性再按出现顺序**。
 * ⚠️ 不能只按文件顺序 —— 不同来源的样式表混在一起时（styles.css 的 :root 是 0,1,0，
 *    gallery-design.css 的 `html:not([data-bg])` 是 0,1,1）纯顺序法会算反。
 */
function sortByCascade(blocks) {
  return blocks
    .map((b, i) => ({ b, i, sp: specificityOf(b.sel) }))
    .sort((x, y) => cmpSpec(x.sp, y.sp) || x.i - y.i)
    .map((x) => x.b);
}

function selectorMatches(sel, theme, accent, bg) {
  return sel.split(',').some((s) => oneSelectorMatches(s.trim(), theme, accent, bg));
}

/** 按层叠顺序算出某个三元组最终生效的变量值 */
function resolveVars(blocks, theme, accent, bg, names) {
  const out = {};
  for (const b of blocks) {
    if (!selectorMatches(b.sel, theme, accent, bg)) continue;
    for (const n of names) {
      if (Object.prototype.hasOwnProperty.call(b.decls, n)) out[n] = b.decls[n];
    }
  }
  return out;
}

// ---------- 色差（CIEDE76：Lab 欧氏距离，够表达「两个预设看起来一样吗」） ----------

function hexToLab(hex) {
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const Z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(hexA, hexB) {
  const a = hexToLab(hexA);
  const b = hexToLab(hexB);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());

// ---------- 主流程 ----------

console.log('[theme-regression] 界面风格（主题）契约');

const mainSrc = read('src/main.js');
const shellSrc = read('src/renderer/ui-shell.js');
const rendererHtml = read('src/renderer/index.html');
const webHtml = read('src/web/index.html');
const cssSrc = read('src/renderer/styles.css');
const i18nSrc = read('src/renderer/i18n.js');
// renderer 两个 JS 源在 §4a 起就要用（顶栏前缀分支 / 展开链路），声明放这里避免 TDZ。
const appJsSrc = read('src/renderer/app.js');
const uiEventsSrc = read('src/renderer/ui-events.js');

const mainPresets = parseMainPresets(mainSrc);
const shellPresets = parseRendererPresets(shellSrc);
const webTheme = loadWebTheme();
const webPresets = webTheme && webTheme.WEB_THEME_PRESETS;

ok('夹具自证：四份预设表都解析到了内容');
expect(Array.isArray(mainPresets) && mainPresets.length >= 8, '主进程预设表可解析');
expect(Array.isArray(shellPresets) && shellPresets.length >= 8, '渲染层预设表可解析');
expect(!!webPresets && Object.keys(webPresets).length >= 8, '网页端预设表可解析（vm 加载）');

// 1. 预设 id 顺序与三元组：主进程 vs 渲染层
expect(
  JSON.stringify(mainPresets) ===
    JSON.stringify(
      shellPresets.map((p) => ({
        id: p.id,
        theme: p.theme,
        uiAccent: p.uiAccent,
        uiBackground: p.uiBackground,
      })),
    ),
  '主进程 THEME_STYLE_PRESETS 与渲染层 UI_THEME_PRESETS 逐位一致（id 顺序 + 三元组）',
);

// 2. 网页端三元组一致
const webTriples = Object.keys(webPresets).map((id) => ({
  id,
  theme: webPresets[id].theme,
  uiAccent: webPresets[id].uiAccent,
  uiBackground: webPresets[id].uiBackground,
}));
expect(
  JSON.stringify(webTriples) === JSON.stringify(mainPresets),
  '网页端 WEB_THEME_PRESETS 与主进程逐位一致',
);

// 3. index.html / web index.html 的风格下拉 option 序列
const expectedOptions = mainPresets.map((p) => p.id).concat(['']);
const settingThemeOptions = selectValues(rendererHtml, 'settingThemeStyle');
const quickThemeOptions = selectValues(rendererHtml, 'quickThemeStyle');
const webThemeOptions = selectValues(webHtml, 'webThemeStyle');
const mobileThemeOptions = selectValues(webHtml, 'mobileThemeStyleSelect');
expect(
  JSON.stringify(settingThemeOptions) === JSON.stringify(expectedOptions),
  '设置页 #settingThemeStyle 的 option 与预设表一致（含空串=自定义组合）',
);
// 顶栏 #quickThemeStyle 是三分组（预设 / 强调色 / 背景基调），断言放在白名单解析之后 —— 见 §4b。
expect(
  JSON.stringify(webThemeOptions) === JSON.stringify(expectedOptions),
  '网页顶栏 #webThemeStyle 的 option 与预设表一致',
);
expect(
  JSON.stringify(mobileThemeOptions) === JSON.stringify(expectedOptions),
  '网页移动端 #mobileThemeStyleSelect 的 option 与预设表一致',
);

// 4. 白名单四处一致（主进程 / 渲染层 / 首帧脚本 / 网页端）
const accRe = /var UI_ACCENT_ALLOWED = \[([^\]]*)\]/;
const bgRe = /var UI_BG_ALLOWED = \[([^\]]*)\]/;
const list = (s) =>
  (s || '')
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
const mainAccent = list((mainSrc.match(accRe) || [])[1]);
const mainBg = list((mainSrc.match(bgRe) || [])[1]);
const shellAccent = list((shellSrc.match(accRe) || [])[1]);
const shellBg = list((shellSrc.match(bgRe) || [])[1]);
const firstFrameAcc = list((rendererHtml.match(/var ACC = \{([^}]*)\}/) || [])[1].replace(/:\s*1/g, ''));
const firstFrameBg = list((rendererHtml.match(/var BG = \{([^}]*)\}/) || [])[1].replace(/:\s*1/g, ''));
// 第三维：材质纹理。⚠️ 解析必须放在 §4a **之前** —— §4a 要拿它拼顶栏第四组
// （texture: 组），放后面会 TDZ 报错（Cannot access 'mainTex' before initialization）。
const texRe = /var UI_TEXTURE_ALLOWED = \[([^\]]*)\]/;
const mainTex = list((mainSrc.match(texRe) || [])[1]);
const shellTex = list((shellSrc.match(texRe) || [])[1]);
const firstFrameTex = list(
  (rendererHtml.match(/var TEX = \{([^}]*)\}/) || [])[1].replace(/:\s*1/g, ''),
);
// 第五维：面板透明度。同样必须在 §4a 之前解析（要拿它拼顶栏第五组）。
const opaRe = /var UI_OPACITY_ALLOWED = \[([^\]]*)\]/;
const mainOpa = list((mainSrc.match(opaRe) || [])[1]);
const shellOpa = list((shellSrc.match(opaRe) || [])[1]);
const firstFrameOpa = list(
  (rendererHtml.match(/var OPA = \{([^}]*)\}/) || [])[1].replace(/:\s*1/g, ''),
);
expect(
  mainAccent.length === 10 && mainBg.length === 11,
  '主进程白名单是 10 强调色 / 11 背景基调（8 实色档 + glass / aurora 两个材质档）',
);
// 新增项**只能追加到末尾**：下拉、首帧表、网页端白名单全是按序比对，
// 插队会让所有下游一起错位，而「顺序变了」与「少一项」在界面上表现完全一样。
expect(
  mainAccent.slice(0, 6).join() === 'violet,cyan,teal,rose,amber,mono',
  '前六个强调色仍是原始六色且顺序未变（新增项只追加在末尾）',
);
expect(
  mainBg.slice(0, 7).join() === 'default,ink,warm,cool,amoled,glass,aurora',
  '前七个背景档仍是原始七档且顺序未变（新增项只追加在末尾）',
);
expect(
  mainBg.indexOf('glass') >= 0 && mainBg.indexOf('aurora') >= 0,
  '背景基调白名单含 glass / aurora 两个材质档',
);
expect(
  JSON.stringify(mainAccent) === JSON.stringify(shellAccent),
  '强调色白名单：主进程 == ui-shell.js',
);
expect(JSON.stringify(mainBg) === JSON.stringify(shellBg), '背景白名单：主进程 == ui-shell.js');
expect(
  JSON.stringify(firstFrameAcc) === JSON.stringify(mainAccent),
  '首帧内联脚本 ACC 表 == 主进程白名单（不一致会让首帧闪一下再切）',
);
expect(
  JSON.stringify(firstFrameBg) === JSON.stringify(mainBg.filter((b) => b !== 'default')),
  '首帧内联脚本 BG 表 == 主进程白名单去掉 default（default 在首帧是「移除属性」）',
);
expect(
  JSON.stringify(webTheme.WEB_ACCENT_ALLOWED) === JSON.stringify(mainAccent),
  '网页端强调色白名单 == 主进程',
);
expect(
  JSON.stringify(webTheme.WEB_BG_ALLOWED) === JSON.stringify(mainBg),
  '网页端背景白名单 == 主进程',
);

// 4a. 桌面顶栏 #quickThemeStyle 是五分组：快捷风格 / 强调色 / 背景基调 / 材质纹理 / 面板透明度。
//     ⚠️ 它**不能**再退回「N 个预设 + 一个 value="" 的『自定义』」—— 那个空选项没有
//        对应控件可调，选中后三元组逐位不变 → 变更检测当场吞掉，用户看到的是
//        「选了毫无反应、也拿不到任何可选项」。（这就是修过一次的那个 bug。）
const expectedQuickOptions = mainPresets
  .map((p) => p.id)
  .concat(mainAccent.map((a) => 'accent:' + a))
  .concat(mainBg.map((b) => 'bg:' + b))
  .concat(mainTex.map((t) => 'texture:' + t))
  .concat(mainOpa.map((o) => 'opacity:' + o));
expect(
  JSON.stringify(quickThemeOptions) === JSON.stringify(expectedQuickOptions),
  '顶栏 #quickThemeStyle = 预设 + accent: + bg: + texture: + opacity: 五组逐位一致',
);
expect(
  quickThemeOptions.indexOf('') < 0,
  '顶栏不得再有 value="" 的「自定义」死选项（选中它会被变更检测静默吞掉）',
);
const quickBlock = rendererHtml.match(
  /<select[^>]*id="quickThemeStyle"[\s\S]*?<\/select>/,
)[0];
const optGroups = quickBlock.match(/<optgroup[^>]*label="([^"]*)"/g) || [];
expect(
  optGroups.length === 5,
  '顶栏下拉是 5 个 optgroup（预设 / 强调色 / 背景基调 / 材质纹理 / 面板透明度）',
);
expect(
  (quickBlock.match(/data-i18n-label=/g) || []).length === 5,
  '5 个 optgroup 的标题都走 data-i18n-label（label 是属性，data-i18n 对它无效）',
);
// 顶栏每个 texture: 选项都要能被 expandThemePresetToControls 解析成「只改纹理」的动作。
// 漏了前缀分支的后果：点纹理毫无反应（控件没被写、变更检测判无变化），而所有列表断言照样全绿。
expect(
  /THEME_OPTION_TEXTURE_PREFIX = 'texture:'/.test(appJsSrc) &&
    /'settingUiTexture'/.test(appJsSrc),
  'app.js 认识 texture: 前缀并映射到 #settingUiTexture（否则点顶栏纹理项静默无效）',
);
// 透明度同理：漏了 opacity: 前缀 → 点顶栏「通透」静默无效。
// ⚠️ 两条前缀断言都要**同时**检查常量与目标控件 id —— 只查常量的话，
//    把映射表那一行删掉（常量还在）依然全绿。
expect(
  /THEME_OPTION_OPACITY_PREFIX = 'opacity:'/.test(appJsSrc) &&
    /\[THEME_OPTION_OPACITY_PREFIX, 'settingUiOpacity', normalizeUiOpacity\]/.test(appJsSrc),
  'app.js 认识 opacity: 前缀并映射到 #settingUiOpacity（否则点顶栏透明度项静默无效）',
);

// 4b. 每一处暴露强调色 / 背景基调的界面，选项必须与白名单逐位一致
// ⚠️ 这张清单是「哪些界面能改这两维」的唯一定义。**新增一处控件就要加进来**，
//    否则新界面的选项会静默漂移（少一项 / 顺序不同），用户在那一处就选不到某个配色。
const accentSurfaces = [
  ['桌面设置页 #settingUiAccent', rendererHtml, 'settingUiAccent'],
  ['网页桌面顶栏 #webAccentSelect', webHtml, 'webAccentSelect'],
  ['网页移动面板 #mobileAccentSelect', webHtml, 'mobileAccentSelect'],
];
const bgSurfaces = [
  ['桌面设置页 #settingUiBackground', rendererHtml, 'settingUiBackground'],
  ['网页桌面顶栏 #webBackgroundSelect', webHtml, 'webBackgroundSelect'],
  ['网页移动面板 #mobileBackgroundSelect', webHtml, 'mobileBackgroundSelect'],
];
for (const [label, html, id] of accentSurfaces) {
  const vals = selectValues(html, id) || [];
  expect(vals.length > 0, label + ' 存在（网页桌面端必须与桌面端一样够得到强调色）');
  expect(
    JSON.stringify(vals) === JSON.stringify(mainAccent),
    label + ' 的 option 与强调色白名单一致',
  );
}
for (const [label, html, id] of bgSurfaces) {
  const vals = selectValues(html, id) || [];
  expect(vals.length > 0, label + ' 存在（网页桌面端必须与桌面端一样够得到背景基调）');
  expect(JSON.stringify(vals) === JSON.stringify(mainBg), label + ' 的 option 与背景白名单一致');
}

// 4c. 材质纹理 —— **第三个正交维度**（2026-10-05 新增）。
// ⚠️ 纹理与强调色/背景基调的机制不同，两者别互相套用：
//    · 底色/强调色由 html 属性选中 CSS 变量块 → 每档每深浅一个块；
//    · 纹理是**灰度 / currentColor 一份字符串**，深浅共用 → 只写 8 个块，不是 16 个。
//      （强度用 SVG 的 feColorMatrix alpha 调，不是叠一层半透明遮罩 → 没有 --texture-boost 这种东西）
//    · 桌面端**设** data-texture 属性（属性选块），网页端**不设**（同 data-accent / data-bg），
//      直接把变量写进 root.style。所以网页端没有「属性 ↔ 块」这层，改由 §9c 比对字符串等价。
// （mainTex / shellTex / firstFrameTex 的解析在 §4 开头，因为 §4a 要拿它们拼第四组。）
expect(mainTex.length === 9, '主进程纹理白名单是 9 档（none + 8 种材质）');
expect(
  mainTex[0] === 'none',
  '纹理白名单第一项是 none（关闭态占位；与 data-bg 的 default 同理，渲染层走 removeAttribute）',
);
expect(
  JSON.stringify(mainTex) === JSON.stringify(shellTex),
  '纹理白名单：主进程 == ui-shell.js',
);
expect(
  JSON.stringify(firstFrameTex) === JSON.stringify(mainTex.filter((t) => t !== 'none')),
  '首帧内联脚本 TEX 表 == 主进程白名单去掉 none（不一致会让首帧不铺纹理、稍后才补上）',
);
expect(
  JSON.stringify(webTheme.WEB_TEXTURE_ALLOWED) === JSON.stringify(mainTex),
  '网页端纹理白名单 == 主进程',
);

// 4d. 四处纹理下拉（桌面顶栏那一处并进 §4e 的分组断言里）。新增界面必须加进这张清单。
const texSurfaces = [
  ['桌面设置页 #settingUiTexture', rendererHtml, 'settingUiTexture'],
  ['网页桌面顶栏 #webTextureSelect', webHtml, 'webTextureSelect'],
  ['网页移动面板 #mobileTextureSelect', webHtml, 'mobileTextureSelect'],
];
for (const [label, html, id] of texSurfaces) {
  const vals = selectValues(html, id) || [];
  expect(vals.length > 0, label + ' 存在（网页端必须与桌面端一样够得到纹理）');
  expect(JSON.stringify(vals) === JSON.stringify(mainTex), label + ' 的 option 与纹理白名单一致');
}

// 4f. 面板透明度 —— **第五个正交维度**（2026-10-05 新增）。
// ⚠️ 与纹理的机制差别：纹理是「一份图案字符串」（深浅共用 → 两端要比字符串等价），
//    透明度是「一个档名 → 一个 html 属性 + 一个 alpha 乘子」，规则本体在**两端共用**的
//    gallery-design.css → 所以这里没有 token 表要比，只比白名单与下拉。
expect(mainOpa.length === 4, '主进程透明度白名单是 4 档（opaque + slight / medium / clear）');
expect(
  mainOpa[0] === 'opaque',
  '透明度白名单第一项是 opaque（关闭态占位；渲染层走 removeAttribute → 默认外观逐字节不变）',
);
expect(JSON.stringify(mainOpa) === JSON.stringify(shellOpa), '透明度白名单：主进程 == ui-shell.js');
expect(
  JSON.stringify(firstFrameOpa) === JSON.stringify(mainOpa.filter((o) => o !== 'opaque')),
  '首帧内联脚本 OPA 表 == 主进程白名单去掉 opaque（不一致会让首屏先按不透明渲染、再跳一下）',
);
expect(
  JSON.stringify(webTheme.WEB_OPACITY_ALLOWED) === JSON.stringify(mainOpa),
  '网页端透明度白名单 == 主进程',
);

// 4g. 三处透明度下拉（桌面顶栏那一处并进 §4a 的分组断言里）。新增界面必须加进这张清单。
const opaSurfaces = [
  ['桌面设置页 #settingUiOpacity', rendererHtml, 'settingUiOpacity'],
  ['网页桌面顶栏 #webOpacitySelect', webHtml, 'webOpacitySelect'],
  ['网页移动面板 #mobileOpacitySelect', webHtml, 'mobileOpacitySelect'],
];
for (const [label, html, id] of opaSurfaces) {
  const vals = selectValues(html, id) || [];
  expect(vals.length > 0, label + ' 存在（网页端必须与桌面端一样够得到透明度）');
  expect(
    JSON.stringify(vals) === JSON.stringify(mainOpa),
    label + ' 的 option 与透明度白名单一致',
  );
}

// 4h. 窗口背景 —— 外观家族的**第五个正交维度，但它不是配色维度，而是窗口级开关**
//     （2026-10-05 新增）。有三条与前面几维**刻意不同**，改它之前先读：
//     ① 它有一半在**主进程**：transparent / backgroundColor / backgroundMaterial 全是
//        BrowserWindow 的**创建参数、运行期改不了** → 改这一档必须重启才生效；
//     ② 渲染层的 `data-window-backdrop` **只跟主进程传的「已生效值」走**
//        （`uiWindowBackdropApplied`），不跟设置值走 —— 否则「窗口还是实色、body 已经透明」
//        会把界面洗白（见 §9i 的第 6 组断言）；
//     ③ 它**不进顶栏** `#quickThemeStyle`：那一栏的核心交互是「鼠标划过即预览」，
//        而这一维在重启前**不可能**预览 → 放进去等于给用户一个假承诺。
//        ⚠️ 所以顶栏仍然只有 5 个 optgroup，§4a 那条断言不变红是**预期**的。
const wbdRe = /var UI_WINDOW_BACKDROP_ALLOWED = \[([^\]]*)\]/;
const mainWbd = list((mainSrc.match(wbdRe) || [])[1]);
const shellWbd = list((shellSrc.match(wbdRe) || [])[1]);
// ⚠️ `|| ''` 不能省：表被整体删掉时，`[1]` 是 undefined，直接 .replace 会**抛异常把整个
// 套件崩掉**（exit 非 0 也算红，但看不出是哪一条坏了，且后面的断言全跑不到）。
const firstFrameWbd = list(
  ((rendererHtml.match(/var WBD = \{([^}]*)\}/) || [])[1] || '').replace(/:\s*1/g, ''),
);
expect(
  mainWbd.length === 4,
  '主进程窗口背景白名单是 4 档（solid + 三档亚克力程度）—— 实际 ' + mainWbd.length + ' 档',
);
expect(
  mainWbd[0] === 'solid',
  '窗口背景白名单第一项是 solid（关闭态占位；渲染层走 removeAttribute → 默认外观逐字节不变）',
);
// 🔴 `acrylic` 必须**留在中间且行为不变**：它是扩档前唯一的值，用户设置里存的就是它 ——
//    删掉或改名都等于把老用户的窗口背景静默回落成实色（reconcile 会兜到首项）。
expect(
  mainWbd.indexOf('acrylic') === 2,
  '窗口背景白名单里 acrylic 仍在原位（扩档前唯一的值，用户设置里存的就是它）',
);
expect(JSON.stringify(mainWbd) === JSON.stringify(shellWbd), '窗口背景白名单：主进程 == ui-shell.js');
expect(
  JSON.stringify(firstFrameWbd) === JSON.stringify(mainWbd.filter((b) => b !== 'solid')),
  '首帧内联脚本 WBD 表 == 主进程白名单去掉 solid（漏了 = 亚克力档先画一整帧实色底再变透）',
);
// 🔴 「窗口背景」那一列**必须单起一行**，不得并回上面那个多列 .settings-general-row：
//    实测（2026-10-05，同一个隔离实例里对同一行做「有 / 无本列」两次测量）并成第 4 列会把
//    每列从 297px 压到 216px，「界面风格」那 5 个下拉随之从 3 行堆到 5 行、整行高
//    235 → 335px —— 为这一维挤高旁边三列是净回退（用户偏好紧凑版式）。
//    判据：从**离本 select 最近的那个** .settings-general-row 到本 select 之间，
//    `.settings-general-col` 只应出现 1 次；并回多列行时它会等于前面那几列的数量（≥2）。
//    ⚠️ 先剥 HTML 注释再数：本节的解释文字里就写着这两个类名。
const rendererHtmlNoComments = rendererHtml.replace(/<!--[\s\S]*?-->/g, '');
const wbdIdx = rendererHtmlNoComments.indexOf('id="settingUiWindowBackdrop"');
const wbdRowStart = rendererHtmlNoComments.lastIndexOf('settings-general-row', wbdIdx);
const wbdColsInRow = (
  rendererHtmlNoComments.slice(wbdRowStart, wbdIdx).match(/settings-general-col/g) || []
).length;
expect(
  wbdIdx > 0 && wbdRowStart > 0 && wbdColsInRow === 1,
  '设置页「窗口背景」单起一行、该行只有它一列' +
    '（并回多列行 = 该行每列被压到 216px、界面风格下拉从 3 行堆到 5 行、行高 235→335px）',
);
// 🔴 2026-10-05：语言 / 启动页已从「界面外观」子节拆到独立的「语言与启动」子节
//    （原来它们和「界面风格」同挤一行三列：291px 下主题那 5 个下拉被压成 2 列 3 行，
//     且两项其实不是配色维度 —— 网页端设置页早就把它们归在「桌面端」子节里）。
//    ⚠️ 拆完之后，上面那条「窗口背景所在行只有它一列」的判据**区分力下降**：
//    外观子节现在每行都只有 1 列，并回去也还是 1 列。所以这里补一条结构性判据顶上。
//    锚点用「语言与启动」子节的 i18n 键 —— 它必须在外观子节**之后**，混回来就红。
const appearanceStart = rendererHtmlNoComments.indexOf('id="settingsSectionAppearance"');
const langStartupAnchor = rendererHtmlNoComments.indexOf(
  'data-i18n="settings.languageStartupTitle"',
);
const appearanceRows = (
  rendererHtmlNoComments.slice(appearanceStart, langStartupAnchor).match(/settings-general-row/g) || []
).length;
expect(
  appearanceStart > 0 && langStartupAnchor > appearanceStart && appearanceRows === 2,
  '「界面外观」子节恰好两行（界面风格一行、窗口背景一行），语言/启动页落在后面的' +
    '「语言与启动」子节里（混回外观行 = 主题那 5 个下拉又被挤成 2 列 3 行）',
);
// 🔴 顺带锁住验证这一维时抓到的既有竞态（不是本维引入的，但正是它让探针的截图时对时错）：
//    `restoreSettingsPageSectionScroll` 同步画导航、把切面板推进 rAF → 两者相隔一帧。
//    若 rAF 里沿用闭包捕获的旧 id，这一帧内发生的任何落点变更都会被覆盖：
//    表现为「导航高亮在 A、内容却是 B」；只重画导航不重取落点就会留下这个半截状态。
const restoreBlock = appJsSrc.match(/function restoreSettingsPageSectionScroll\(\)[\s\S]*?\n\}/);
expect(
  !!restoreBlock &&
    /requestAnimationFrame\(function \(\) \{[\s\S]*getLastSettingsSectionId\(\)/.test(restoreBlock[0]),
  'restoreSettingsPageSectionScroll 在 rAF 内重新取落点' +
    '（沿用闭包旧 id = 内容被弹回上一板块、导航却停在新板块）',
);

// 只有设置页一处入口：网页端没有窗口，够不到这一维。
const wbdSurfaces = [
  ['桌面设置页 #settingUiWindowBackdrop', rendererHtml, 'settingUiWindowBackdrop'],
];
for (const [label, html, id] of wbdSurfaces) {
  const vals = selectValues(html, id) || [];
  expect(vals.length > 0, label + ' 存在（窗口背景只有设置页这一处入口）');
  expect(
    JSON.stringify(vals) === JSON.stringify(mainWbd),
    label + ' 的 option 与窗口背景白名单一致',
  );
}
expect(
  quickThemeOptions.every((v) => v.indexOf('windowbackdrop:') < 0) &&
    !/THEME_OPTION_WINDOW_BACKDROP_PREFIX/.test(appJsSrc),
  '顶栏不得出现 windowbackdrop: 项（那一栏是「划过即预览」，这一维重启前不可能预览）',
);
const trigBlock = appJsSrc.match(/function syncQuickThemeTrigger\(\)[\s\S]*?\n\}/);
expect(
  !!trigBlock && trigBlock[0].indexOf('settingUiWindowBackdrop') < 0,
  '顶栏触发按钮的后缀文案不含窗口背景（它不是主题维度，不进那一栏）',
);
/** 源码文本断言前先剥注释，否则「注释里提一句字段名」就会误报 */
const stripComments = (s) =>
  String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const webThemeCode = stripComments(read('src/web/js/web-theme-shared.js'));
expect(
  !/uiWindowBackdrop/.test(webThemeCode) && !/uiWindowBackdrop/.test(stripComments(webHtml)),
  '网页端源码里不出现窗口背景字段（浏览器里没有窗口可透；在注释里解释可以）',
);

// 🔴 第九条：这两维的**用户可见名字必须互相区分**（2026-10-05 加）。
//    用户就是被名字误导的：他看到「界面透明度」，以为选了它整个窗口会透出桌面，
//    实际只有面板变淡 —— 「透明度的效果和我想象中不一致」正是这么来的。
//    定名原则：**把作用域写进名字**。
//      第五维 = 面板透明度（只管界面框架那几张面）→ 中文含「面板」、英文含 Panel
//      第六维 = 窗口背景  （只管窗口本身透不透）  → 中文含「窗口」、英文含 Window/backdrop
//    ⚠️ 判据故意用「关键词在不在」而不是死字符串：既抓得住「有人改回界面透明度」这种回退，
//       也不至于换个近义词就红。而「第五维名里不得出现『界面』」不是洁癖 ——
//       「界面面板透明度」照样会被读成「整个界面（含窗口）」，等于换个词踩同一个坑。
//    ⚠️ 取值靠正则抓 i18n.js 里的 `'key': '值'`（这几个键都是单行字面量，中英各一条）。
function wbdI18nValues(key) {
  const re = new RegExp(
    "'" + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\s*:\\s*'([^']*)'",
    'g',
  );
  return [...i18nSrc.matchAll(re)].map((m) => m[1]);
}
const wbdFifthName = wbdI18nValues('theme.groupOpacity');
const wbdFifthAria = wbdI18nValues('settings.opacityAria');
const wbdSixthName = wbdI18nValues('settings.windowBackdrop');
expect(
  wbdFifthName.length === 2 && wbdFifthAria.length === 2 && wbdSixthName.length === 2,
  '两维的界面名在 i18n 里中英各一条（theme.groupOpacity / settings.opacityAria / settings.windowBackdrop）',
);
expect(
  wbdFifthName[0].indexOf('面板') >= 0 &&
    wbdFifthName[0].indexOf('界面') < 0 &&
    /panel/i.test(wbdFifthName[1]) &&
    !/interface/i.test(wbdFifthName[1]),
  '第五维名把作用域写进名字：中文含「面板」且不含「界面」、英文含 Panel 且不含 Interface' +
    '（改回「界面透明度」= 又让用户以为「选它整个窗口会透出桌面」）',
);
expect(
  wbdFifthAria[0].indexOf('面板') >= 0 &&
    wbdFifthAria[0].indexOf('界面') < 0 &&
    /panel/i.test(wbdFifthAria[1]),
  '设置页 #settingUiOpacity 的 aria 名与顶栏分组同口径（含「面板」、不含「界面」）',
);
expect(
  wbdSixthName[0].indexOf('窗口') >= 0 && /window|backdrop/i.test(wbdSixthName[1]),
  '第六维名指向窗口本身（中文含「窗口」、英文含 Window/backdrop）',
);
expect(
  wbdFifthName[0] !== wbdSixthName[0] && wbdFifthAria[0] !== wbdSixthName[0],
  '两维名字互不相同（撞名 = 用户分不清「哪个才是让整个窗口透出桌面」）',
);
expect(
  wbdFifthName[0] === wbdFifthAria[0] && wbdFifthName[1] === wbdFifthAria[1],
  '第五维在顶栏分组与设置页 aria 上同名（同一个维、两处入口，名字不该漂）',
);
// 设置页那一处下拉的 aria-label 写在 HTML 里作首帧兜底（i18n 随后覆盖），必须同步。
const wbdOpaSelect = (rendererHtml.match(
  /<select[^>]*id="settingUiOpacity"[\s\S]*?<\/select>/,
) || [''])[0];
expect(
  wbdOpaSelect.indexOf('aria-label="面板透明度"') >= 0,
  '设置页 #settingUiOpacity 的 HTML aria-label 同步为「面板透明度」（与顶栏分组名一致）',
);
// 网页端（手机版设置面板）同一维的可见标签。
expect(
  webHtml.indexOf('<label for="mobileOpacitySelect">面板透明度</label>') >= 0 &&
    webHtml.indexOf('aria-label="面板透明度"') >= 0,
  '网页端「面板透明度」标签同步（label 与 aria-label 两处）',
);

// 5. 每个预设都要有双语名字
const missingName = mainPresets.filter((p) => {
  const re = new RegExp("'theme\\." + p.id + "':", 'g');
  return (i18nSrc.match(re) || []).length < 2;
});
expect(
  missingName.length === 0,
  '每个预设都有 theme.<id> 的中英双语名字' +
    (missingName.length ? '（缺：' + missingName.map((p) => p.id).join(', ') + '）' : ''),
);

// 5b. 强调色 / 背景档 / 材质纹理也都要有双语名字。
// ⚠️ 这条是 2026-10-04 补齐选项时踩出来的：<option data-i18n="accent.coral"> 加了、
//    i18n.js 忘了加键 → 界面上直接显示裸键名「accent.coral」。不白屏、不报错，只有肉眼
//    扫到才发现，所以必须有断言。它和第 5 条（只管 theme.* 预设名）是两件事。
const colorKeys = mainAccent
  .map((a) => 'accent.' + a)
  .concat(mainBg.map((b) => 'bg.' + b))
  .concat(mainTex.map((t) => 'texture.' + t))
  .concat(mainWbd.map((b) => 'windowBackdrop.' + b));
const missingColorName = colorKeys.filter((k) => {
  const re = new RegExp("'" + k.replace('.', '\\.') + "':", 'g');
  return (i18nSrc.match(re) || []).length < 2;
});
expect(
  missingColorName.length === 0,
  '每个强调色 / 背景档 / 材质纹理 / 窗口背景都有中英双语名字' +
    (missingColorName.length ? '（缺：' + missingColorName.join(', ') + '）' : ''),
);

// 6. 预设两两不同
const seen = new Set();
let dup = null;
for (const p of mainPresets) {
  const key = p.theme + '|' + p.uiAccent + '|' + p.uiBackground;
  if (seen.has(key)) dup = key;
  seen.add(key);
}
expect(!dup, '没有两个预设共用同一个三元组' + (dup ? '（重复：' + dup + '）' : ''));

// 7. 按 CSS 层叠算出每个预设最终的背景值，断言色差下限
// ⚠️ 必须把 gallery-design.css 也算进来：它被**桌面端与网页端共同加载**、且在 styles.css
//    之后，其中 `html:not([data-bg])` 会整体改写 default 档的背景九件套。
//    只读 styles.css 会得出「夜幕经典 = #0a0a18」的结论，而真实渲染是 #121618 —— 靠这个
//    盲区，它与「石墨夜色」实际只差 ΔE76 3.5，且与网页端 token 悄悄漂移。
const galleryCss = read('src/web/css/gallery-design.css');
const blocks = sortByCascade(parseCssBlocks(cssSrc).concat(parseCssBlocks(galleryCss)));
ok('夹具自证：styles.css + gallery-design.css 共解析到 ' + blocks.length + ' 个声明块');
expect(blocks.length > 200, '夹具自证：解析到的块数像是真的样式表（>200）');
expect(
  parseCssBlocks(galleryCss).some((b) => /^html:not\(\[data-bg\]\)$/.test(b.sel.trim())),
  '夹具自证：gallery-design.css 的 default 档覆盖确实被解析到了（否则护栏空转）',
);

const names = ['--bg', '--bg-secondary', '--bg-card', '--glass'];
const resolved = mainPresets.map((p) => ({
  id: p.id,
  theme: p.theme,
  vars: resolveVars(blocks, p.theme, p.uiAccent, p.uiBackground, names),
}));

/* 🔴 材质档（uiBackground = glass / aurora）**不参与**下面那节「背景基色 ΔE」比较。
   理由：它们的视觉差异由**面板透明度**承载（--glass / --bg-card 是半透明 rgba，透出 body
   里那层 .aurora-bg 极光），而 --bg / --bg-secondary 只是基色 —— 与实色档数值接近是设计
   使然（玻璃白昼的 --bg-secondary 与素纸浅灰只差 ΔE 5.3），但两者上屏观感天差地别。
   换句话说：拿色差判它们会得出「两套一样」的错误结论。
   替代覆盖是紧随其后的 §7b：材质档必须**真的半透明**。 */
const MATERIAL_BGS = ['glass', 'aurora'];
const isMaterialPreset = (id) => {
  const p = mainPresets.find((x) => x.id === id);
  return !!p && MATERIAL_BGS.indexOf(p.uiBackground) >= 0;
};
const missingBg = resolved.filter((r) => !isHex(r.vars['--bg']) || !isHex(r.vars['--bg-secondary']));
expect(
  missingBg.length === 0,
  '每个预设的 --bg / --bg-secondary 都能解析出十六进制值' +
    (missingBg.length ? '（缺：' + missingBg.map((r) => r.id).join(', ') + '）' : ''),
);

// ⚠️ 深色门槛是 4 不是 3：深色背景的 ΔE76 天然偏小，3.0 这个量级在屏幕上已经分不出来
//    （「夜幕经典 #121618 vs 石墨夜色 #14141a」就是 ΔE 3.5 的一对，肉眼几乎同色）。
//    当前 22 套（含材质档内）的最小深色对是 4.3（森影暮霭 vs 石墨夜色）。
const THRESHOLD = { light: 8, dark: 4 };
const tooClose = [];
for (let i = 0; i < resolved.length; i++) {
  for (let j = i + 1; j < resolved.length; j++) {
    const a = resolved[i];
    const b = resolved[j];
    if (isMaterialPreset(a.id) || isMaterialPreset(b.id)) continue; // 材质档见 §7b
    const dbg = deltaE(a.vars['--bg'], b.vars['--bg']);
    const dsec = deltaE(a.vars['--bg-secondary'], b.vars['--bg-secondary']);
    if (a.theme === b.theme && (dbg < THRESHOLD[a.theme] || dsec < THRESHOLD[a.theme])) {
      tooClose.push(
        a.id + ' vs ' + b.id + ' (ΔE ' + dbg.toFixed(1) + '/' + dsec.toFixed(1) + ')',
      );
    }
  }
}
expect(
  tooClose.length === 0,
  '同深浅的预设背景两两有明显差异（浅色 ΔE≥' +
    THRESHOLD.light +
    '、深色 ΔE≥' +
    THRESHOLD.dark +
    '）' +
    (tooClose.length ? '（过近：' + tooClose.join('; ') + '）' : ''),
);

/* 7b. 材质档必须**真的半透明** —— 这是它们与实色档唯一的视觉区别。
   只加了档位名、忘了把面板变量改成 rgba 的话，这一档上屏与实色档一模一样，
   而上面那节的 ΔE 又因为排除材质档而不会报错 → 典型的「配置看着对、效果没发生」。
   判据：--glass 与 --bg-card 都得是 alpha ≤ 0.75 的 rgba。 */
const materialBad = [];
const alphaOf = (v) => {
  const m = String(v || '').match(/rgba?\([^)]*,\s*([\d.]+)\s*\)$/);
  return m ? parseFloat(m[1]) : null;
};
for (const r of resolved) {
  if (!isMaterialPreset(r.id)) continue;
  const ag = alphaOf(r.vars['--glass']);
  const ac = alphaOf(r.vars['--bg-card']);
  if (ag == null || ac == null || ag > 0.75 || ac > 0.75) {
    materialBad.push(
      r.id + '(--glass=' + r.vars['--glass'] + ', --bg-card=' + r.vars['--bg-card'] + ')',
    );
  }
}
expect(
  materialBad.length === 0,
  '材质档（glass / aurora）的面板 --glass / --bg-card 是半透明 rgba 且 alpha ≤ 0.75' +
    (materialBad.length ? '（不合格：' + materialBad.join('; ') + '）' : ''),
);

// 8. 网页端 token 必须与 styles.css 逐值相等（防两端配色漂移）
const webDrift = [];
for (const r of resolved) {
  const p = mainPresets.find((x) => x.id === r.id);
  const t = webTheme.webThemeTokens(p.theme, p.uiAccent, p.uiBackground);
  const pairs = [
    ['--bg', t.bg],
    ['--bg-secondary', t.bgSidebar],
    ['--bg-card', t.bgCard],
  ];
  for (const [cssName, webValue] of pairs) {
    if (r.vars[cssName] !== webValue) {
      webDrift.push(r.id + ' ' + cssName + '：css=' + r.vars[cssName] + ' web=' + webValue);
    }
  }
}
expect(
  webDrift.length === 0,
  '网页端 token 与 styles.css 逐值相等（两端配色不漂移）' +
    (webDrift.length ? '（' + webDrift.length + ' 处不一致：' + webDrift.slice(0, 4).join('; ') + '…）' : ''),
);

// 9. 背景档位覆盖：**白名单里的每一档 × 深浅两侧**都要在样式表里有对应的档块。
// ⚠️ 旧版只查「被预设用到的档」→ 后补的档不被任何预设使用，正好落在这个盲区里：
//    下拉能选、白名单放行、但没有 CSS 块 ⇒ 选中后沿用默认背景，表现就是「选了没反应」。
// ⚠️ 判据**不能**是「resolveVars 能解析出 --bg」—— :root 永远兜底，漏写整档也照样有值
//    （实测：注入 `data-bg='paper'` → `'paper_TYPO'` 后该断言仍 PASS）。必须直接查选择器。
const undefBg = [];
for (const bg of mainBg) {
  // default 档是特例：它刻意不设 data-bg 属性（靠 :not([data-bg])），没有对应的档块。
  if (bg === 'default') continue;
  for (const theme of ['dark', 'light']) {
    const sel = "html[data-theme='" + theme + "'][data-bg='" + bg + "']";
    if (!blocks.some((b) => b.sel.trim() === sel)) undefBg.push(theme + ':' + bg);
  }
}
expect(
  undefBg.length === 0,
  '每个「明暗 × 背景基调」都有样式表档块（白名单全量 × 深浅两侧）' +
    (undefBg.length ? '（缺：' + undefBg.join(', ') + '）' : ''),
);

// 9b. 强调色覆盖：每个 (深浅 × 强调色) 都要解析出 --accent，且同深浅下两两不同。
// ⚠️ 漏洞场景与 §9 同源：白名单与四处下拉都加了新色，唯独 styles.css 忘写
//    html[data-accent='x'] 块 → 该色**静默回落到 violet**。名字断言全绿（选项都在），
//    界面上就是「两个选项一模一样」，所以用「两两不同」兜住。
const accentMissing = [];
for (const theme of ['dark', 'light']) {
  const seenAccent = new Map();
  for (const a of mainAccent) {
    const v = resolveVars(blocks, theme, a, 'default', ['--accent'])['--accent'];
    if (!v) accentMissing.push(theme + ':' + a + '（无定义）');
    else if (seenAccent.has(v))
      accentMissing.push(theme + ':' + a + '（与 ' + seenAccent.get(v) + ' 同值）');
    else seenAccent.set(v, a);
  }
}
expect(
  accentMissing.length === 0,
  '每个强调色在深浅两侧都有独立 --accent（同值 = CSS 块漏写、回落默认 violet）' +
    (accentMissing.length ? '（' + accentMissing.slice(0, 4).join('; ') + '）' : ''),
);

// 9c. 材质纹理覆盖：每个纹理都要在 styles.css 里有 `html[data-texture='x']` 块，
//     且值不能是 none；同时必须与网页端 TEXTURE_TOKENS 等价。
//
// ⚠️ 判据同样**不能**用 resolveVars —— 理由与 §9 完全一致：gallery-design.css 的
//    `:root { --bg-texture: none }` 永远兜底，所以「整块漏写」也能解析出一个值（none），
//    断言会空转。必须直接查选择器块。
// ⚠️ 漏写的表现：下拉能选、白名单放行、settings.json 照落，唯独画面上没有纹理 ——
//    而 §4c/§4d 那批「名字都对得上」的断言**全部照绿**。这条是唯一能抓到的。
// ⚠️ 两端机制不同（桌面端 = 属性选块，网页端 = 直接写变量），所以这里做的是
//    「styles.css 的块 ↔ TEXTURE_TOKENS 的字符串」等价比对，而不是查网页端的属性块。
const stripWs = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
const texProblems = [];
const webTextureTokens = webTheme.TEXTURE_TOKENS || {};
for (const t of mainTex) {
  if (t === 'none') {
    // none 是关闭态的语义占位，不该有块（有反而是 bug：会导致「选了无还有纹理」）
    if (blocks.some((b) => b.sel.trim() === "html[data-texture='none']"))
      texProblems.push('none：不该有 html[data-texture="none"] 块（关闭态必须靠 :root 的 --bg-texture 兜底）');
    continue;
  }
  const block = blocks.find((b) => b.sel.trim() === "html[data-texture='" + t + "']");
  if (!block) {
    texProblems.push(t + '：styles.css 缺 html[data-texture=\'' + t + '\'] 块');
    continue;
  }
  const v = block.decls['--bg-texture'];
  if (!v || v === 'none') {
    texProblems.push(t + '：块里的 --bg-texture 为空或是 none');
    continue;
  }
  const tok = webTextureTokens[t];
  if (!tok || !tok.image || tok.image === 'none') {
    texProblems.push(t + '：web-theme-shared.js 的 TEXTURE_TOKENS 缺该项或值为空');
    continue;
  }
  if (stripWs(v) !== stripWs(tok.image))
    texProblems.push(t + '：styles.css 与 TEXTURE_TOKENS 的值不等价（两端纹理不一致）');
  // dots 是唯一需要显式平铺尺寸的档：少了 background-size 会被拉满整屏
  const cssSize = block.decls['--texture-size'];
  const tokSize = tok.size || 'auto';
  if (stripWs(cssSize || 'auto') !== stripWs(tokSize))
    texProblems.push(t + '：--texture-size 两端不一致（css=' + (cssSize || 'auto') + ' / web=' + tokSize + '）');
}
expect(
  texProblems.length === 0,
  '每种纹理都有 styles.css 块且与网页端 TEXTURE_TOKENS 等价' +
    (texProblems.length ? '（' + texProblems.slice(0, 4).join('; ') + '）' : ''),
);
expect(
  stripWs(blocks.find((b) => b.sel.trim() === "html[data-texture='dots']")?.decls['--texture-size']) ===
    '15px15px',
  '点阵档显式给了 --texture-size（不给我会被拉成一整屏一个大点）',
);

// 9d. 纹理**贴在可见面上**（纹理渲染架构契约）。
//
// 🔴 这一节守的是一条实测出来的架构约束，不是风格偏好。原设计是「全屏装饰层」：
//    body::after { position:fixed; z-index:0; background-image: var(--bg-texture) }，
//    指望它铺在内容之下、透视出来。2026-10-05 实测**完全不可见**：把那一层染成纯红，
//    在**每一种**背景基调下露出面积都是 0.01%（一个红像素都没有）；把同一层抬到
//    z-index:99999 立刻满屏变红 → 是「被盖住」而不是「没生成」。
//    根因：gallery-design.css 这个收尾层把面板全拍成了不透明实色
//    （`html .sidebar` / `html .toolbar` 都带 backdrop-filter:none + 实色 var(--bg)）。
//    结论：**凡打在面板背后的东西在这套设计里都不可见** → 纹理必须是「面自己的一层背景」。
//
// 可见面集合 = 视口网格命中测试实测（按覆盖面积）：.content-area 56% ｜ .topbar 8%
// ｜ .titlebar 4% ｜ .browse-footer 4% ｜ .toolbar 4% ｜ 其余约 20% 由 body 画布兜底。
// 漏挂某个面 → 那一块「没有纹理」而其余有，非常显眼，所以下面逐个断言。
//
// 🔴 另一半（!important）也是反向验证逼出来的：面板的底色规则里有一批用了 `background`
//    **简写**（简写会把 background-image 一起重置成 none），而且**明暗两档都会坏**：
//    浅色档丢 `.content-area`/`.sidebar`/`.toolbar`（覆盖率 100% → 25%），
//    深色档丢 `.sidebar`、以及墨色底下的 `body`（body 还拿到别人的 5 层极光渐变）。
//    grep 源码是查不出来的（要跨 8 张样式表算层叠特异性），只有运行期命中测试能抓。
//    所以静态这层只负责守住 !important 在不在，**真正的可见性判据在
//    theme-switch-probe 的「材质纹理实测」段**（覆盖率下限 + 挂别图的面对照）。
//
// ⚠️ 判据同样**不能**用 resolveVars：gallery-design.css 的 `:root { --bg-texture: none }`
//    会永远兜底，整条规则漏写也照样解析出 none，断言会空转。必须直接查选择器与声明。
const galleryBlocks = parseCssBlocks(galleryCss);
const webHtmlSrc = webHtml; // webHtml 已在文件顶部读过，这里只取个别名，避免重复读盘
const SURFACE_SEL = [
  'body',
  'html .sidebar',
  'html .toolbar',
  'html .topbar',
  '.titlebar',
  '.browse-footer',
  '.content-area',
];
// 认「把面拍成实色」的写法：简写 background（含 background: var(--bg)）或 background-color。
// ⚠️ 不能只认 background-color —— 本文件的实色是简写写的，只认长写会漏掉全部命中。
const setsSurfacePaint = (b) => splitSel(b.sel).some((s) => SURFACE_SEL.includes(s)) &&
  (b.decls['background'] != null || b.decls['background-color'] != null);

const texRule = galleryBlocks.find(
  (b) =>
    splitSel(b.sel).every((s) => SURFACE_SEL.includes(s)) &&
    b.decls['background-image'] != null,
);
expect(
  !!texRule,
  'gallery-design.css 里有一条「可见面 → background-image: var(--bg-texture)」规则' +
    '（全屏装饰层方案已实测不可见，纹理必须成为面自己的一层背景）',
);
if (texRule) {
  const hit = splitSel(texRule.sel);
  const missing = SURFACE_SEL.filter((s) => !hit.includes(s));
  expect(
    missing.length === 0,
    '纹理覆盖全部 7 个实测可见面（漏挂的面会「没有纹理」而其余有，很显眼）' +
      (missing.length ? '（缺：' + missing.join(', ') + '）' : ''),
  );
  expect(
    stripWs(texRule.decls['background-image']) === 'var(--bg-texture,none)!important',
    '那一面走 --bg-texture 变量（写死具体纹理 = 选了别的档不生效）',
  );
  // 🔴 细节：纹理层不许碰 background 简写 / background-color。
  //    写成简写会把 var(--bg) 之类的底色一起冲掉 —— 各面原有的底色/边框/阴影必须全保留，
  //    纹理只是**叠在它们之上的额外一层**。
  expect(
    texRule.decls['background'] == null && texRule.decls['background-color'] == null,
    '纹理规则只加 background-image，不碰 background 简写 / background-color（碰了会冲掉面板底色）',
  );
  expect(
    stripWs(texRule.decls['background-repeat']) === 'repeat!important',
    '纹理规则带 background-repeat: repeat（不给我会被拉伸成一张大图）',
  );
  expect(
    stripWs(texRule.decls['background-size']) === 'var(--texture-size,auto)!important',
    '纹理规则带 background-size: var(--texture-size, auto)（点阵档靠它平铺，不给会被拉成一整屏一个大点）',
  );
  // 🔴 三个声明**必须** !important。这是反向验证逼出来的（2026-10-05：把 !important
  //    去掉后重跑探针，**明暗两档都红**，只是坏的面不同）：
  //      ① 浅色档 `.content-area`(55%)/.sidebar(15%)/.toolbar(5%)
  //         ← `html[data-theme='light'] .xxx { background: color-mix(...) }` (0,2,1) 简写
  //      ② 深色档 `.sidebar`(15%)
  //         ← theme-polish.css 的 `html .sidebar { background: var(--surface-soft) }`
  //           （**同是 (0,1,1)**，但 theme-polish.css 加载在本文件之后 → 同特异性下后者胜）
  //      ③ 深色档+墨色底 `body`
  //         ← `html[data-theme='dark'][data-bg='ink'] body { background: <5 层极光渐变> }` (0,3,1)
  //           这条最阴：body 拿到的是**别人的图**，粗口径「非 none 就算铺到」会把覆盖率
  //           虚报成 85%（真值 78%），把「body 上根本不是纹理」掩盖掉。
  //    这三条都**不是 grep 源码能查出来的**（要跨 8 张样式表算层叠），而属性/磁盘/单元素
  //    计算值三条断言出 bug 时**全部照绿**。所以静态这层只守「!important 在不在」，
  //    真正的可见性判据在 theme-switch-probe 的命中测试（覆盖率下限 + 挂别图的面单列）。
  //    想靠「写更具体的选择器」赢是死路：两端必须共用同一个选择器（网页端不设 data-texture
  //    属性，属性型选择器在网页端恒不匹配），所以任何不依赖顺序的写法都只能到 (0,2,1)。
  //    ⚠️ 谁想删掉 !important，先去看 gallery-design.css 那一节的实测记录。
  for (const prop of ['background-image', 'background-repeat', 'background-size']) {
    expect(
      /!important\s*$/.test(texRule.decls[prop] || ''),
      '纹理规则的 ' + prop + ' 带 !important（去掉 = 浅色档丢 .content-area/.sidebar/.toolbar、深色档丢 .sidebar/body）',
    );
  }
  // 夹具自证：确实存在更高特异性的 background 简写规则压在这些面上。
  // 如果哪天那些规则被清理掉了，这条会红 —— 那时才说明 !important 成了摆设、可以去掉。
  const texSpec = splitSel(texRule.sel).reduce(
    (m, s) => (cmpSpec(specificityOfOne(s), m) > 0 ? specificityOfOne(s) : m),
    [0, 0, 0],
  );
  const paintSpec = blocks
    .filter(setsSurfacePaint)
    .reduce((m, b) => (cmpSpec(specificityOf(b.sel), m) > 0 ? specificityOf(b.sel) : m), [0, 0, 0]);
  expect(
    cmpSpec(paintSpec, texSpec) > 0,
    '夹具自证：确实有更高特异性的 background 简写规则压在这些面上' +
      `（面板最高 ${paintSpec.join(',')} vs 纹理 ${texSpec.join(',')}）—— 否则 !important 就是摆设`,
  );
}

// 9e. 纹理的**颜色空间**契约：SVG 那 4 档的常量色必须是中灰（sRGB 口径）。
//
// 🔴 这一条守的是一个极难发现的坑：`feColorMatrix` 等 SVG 滤镜默认在 **linearRGB** 里算
//    （`color-interpolation-filters` 的初始值就是 linearRGB）。所以 `values=` 里写 0.5，
//    屏幕上出来的是 **sRGB ≈ 0.73（≈186/255）** —— 一层接近白的纱。
//    后果按面板底色分成两半：浅色面板（实测亮度 231）Δ≈7「像没生效」，深色面板（亮度 9）
//    Δ≈29「挺明显」。也就是**深色档看着没问题、浅色档等于没有**，而所有属性/磁盘/覆盖率
//    断言全部照绿（覆盖率是「有没有画上」而不是「看不看得见」）。
//    定标反推：把内容区底色强制成白/黑/#808080，解出等价覆盖色亮度 = 186、alpha = 0.165，
//    三组预测全部命中 → 确认就是线性空间换算问题。改成线性的 0.214（≈ sRGB 0.5）后
//    两侧对比对称：浅色 Δ≈17、深色 Δ≈20。
//    ⚠️ 所以判据是「换算成 sRGB 之后必须落在中灰区间」，而不是「字面等于 0.214」——
//    允许换色调，但不允许换回一个在浅色底上隐形的值。
const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toneProblems = [];
for (const t of mainTex) {
  const block = blocks.find((b) => b.sel.trim() === "html[data-texture='" + t + "']");
  const raw = block && block.decls['--bg-texture'];
  if (!raw) continue;
  const m = raw.match(/values='([^']+)'/);
  if (!m) continue; // 走 CSS 渐变的 4 档（linen/grid/dots/stripe）不适用：CSS 渐变本身就是 sRGB
  const nums = m[1].trim().split(/\s+/).map(Number);
  // feColorMatrix 是 4×5 行主序，每行的第 5 个数是该通道的常量偏移
  const offsets = [nums[4], nums[9], nums[14]];
  const srgb = offsets.map(srgbEncode);
  const bad = srgb.filter((v) => !(v >= 0.3 && v <= 0.7));
  if (bad.length) {
    toneProblems.push(
      t +
        '：常量色换算到 sRGB 是 ' +
        srgb.map((v) => v.toFixed(2)).join('/') +
        '（要求 0.30–0.70 中灰区间）',
    );
  }
}
expect(
  toneProblems.length === 0,
  'SVG 档的纹理常量色换算成 sRGB 后落在中灰区间' +
    '（⚠️ 滤镜默认 linearRGB，直接写 sRGB 数值 → 变成近乎白的纱，浅色档看不见）' +
    (toneProblems.length ? '（' + toneProblems.slice(0, 3).join('; ') + '）' : ''),
);
// 夹具自证：确实有档位走了 SVG 滤镜这条路，否则上面那条在空转
expect(
  mainTex.filter((t) => {
    const b = blocks.find((x) => x.sel.trim() === "html[data-texture='" + t + "']");
    return b && /feColorMatrix/.test(b.decls['--bg-texture'] || '');
  }).length === 4,
  '夹具自证：确实有 4 档走 SVG 滤镜（grain/paper/frost/wood），上面那条不是空转',
);
// 关闭态的兜底值。⚠️ 不能靠 :not([data-texture]) 属性闸门 —— 网页端根本不设这个属性
// （它由 web-theme-shared.js 直接写 root.style 变量），属性闸门会把网页端彻底关死。
const galleryRoot = galleryBlocks.find((b) => b.sel.trim() === ':root' && b.decls['--bg-texture'] != null);
expect(
  galleryRoot && stripWs(galleryRoot.decls['--bg-texture']) === 'none',
  '关闭态靠 :root 的 --bg-texture 兜底值 none（不是靠 :not([data-texture]) 属性闸门）',
);
expect(
  galleryRoot && stripWs(galleryRoot.decls['--texture-size']) === 'auto',
  ':root 同时兜底 --texture-size: auto（否则关态残留上一档的平铺尺寸）',
);
// ⚠️ 判据要跑在**剥掉注释**的源码上：本节注释里就写着「不是靠 :not([data-texture])」，
//    直接对原文正则会在注释上命中（自己把自己判红）。
const galleryClean = galleryCss.replace(/\/\*[\s\S]*?\*\//g, '');
expect(
  !/:not\(\[data-texture\]\)/.test(galleryClean),
  'gallery-design.css 里不得出现 :not([data-texture]) 闸门 —— 网页端不设该属性，加了会把纹理关死',
);
// 旧架构的墓碑：这两条不是「顺便清清垃圾」，而是防止有人把已经证明无效的方案改回来。
expect(
  !blocks.some((b) => splitSel(b.sel).some((s) => /body::after$/.test(s))),
  'styles.css 不得再有 body::after 装饰层（实测在 11 种背景基调下露出面积都是 0.01%）',
);
expect(
  !/body::after\s*\{/.test(webHtmlSrc),
  '网页端 index.html 不得再内联自建纹理层 —— 两端统一走 gallery-design.css 那一处',
);
expect(
  /gallery-design\.css/.test(webHtmlSrc) || !/--bg-texture/.test(webHtmlSrc),
  '网页端要提纹理就只能提 gallery-design.css（别在 index.html 里另起一套）',
);

// 9g. 面板透明度（第五维）的 CSS 契约 —— **白名单三处一致 ≠ 画面真的会变**。
// ⚠️ 这一维的规则全在 gallery-design.css（两端共用）。漏档块 / 漏 !important / 写成
//    background 简写 / 忘了提亮极光，**全都不报错、上面那些列表断言也全绿**
//    （2026-10-05 实测：只降面板 alpha 的话，面板色与 body 底色本身就同色系，
//     面板采样点色差 ΔE 只有 4~6，肉眼基本无感 → 真正承载「通透感」的是极光层）。
const gdClean = galleryCss.replace(/\/\*[\s\S]*?\*\//g, '');

// ① 每个非 opaque 档都要有 --ui-alpha 档块。
//    漏了的后果：下拉能选、属性照设、白名单放行，**唯独颜色算不出来 →
//    与「不透明」档外观逐像素相同**（症状就是「选了没反应」）。
const opaMissing = mainOpa.filter(
  (o) =>
    o !== 'opaque' &&
    !new RegExp("html\\[data-opacity='" + o + "'\\]\\s*\\{[^}]*--ui-alpha").test(gdClean),
);
expect(
  opaMissing.length === 0,
  '每个非 opaque 档都有 html[data-opacity=x] { --ui-alpha } 档块（漏了 = 选了跟不透明一样）' +
    (opaMissing.length ? '（缺：' + opaMissing.join(', ') + '）' : ''),
);

// ② `:root` 兜底 --ui-alpha。⚠️ 缺了**不是「走默认值」而是整条声明作废**：
//    `color-mix(in srgb, var(--glass) var(--ui-alpha), transparent)` 里的 var() 解析失败
//    → 该 background-color 声明整体 invalid at computed-value time。
expect(
  /:root\s*\{[^}]*--ui-alpha:\s*100%/.test(gdClean),
  ':root 兜底 --ui-alpha: 100%（缺了会让整条 background-color 声明作废，不是回落默认值）',
);

// ③ 所有用 --ui-alpha 算背景色的规则都必须带闸门。
//    ⚠️ 不能图省事写成「无条件生效 + --ui-alpha 默认 100%」：那会让**默认档也走一遍
//    color-mix**，舍入误差会把「默认外观逐字节不变」变成一条只能靠放宽容差掩盖的抖动断言。
//    ⚠️ 判据必须**逐段拆选择器**再查：规则是分组写的（一条规则里挂 4 个面），
//       只看整条 sel 串的话，删掉其中一段的闸门照样含 'data-opacity' → 断言空转
//       （2026-10-05 反向验证实测：拆掉 `.content-area` 的闸门，粗判据没抓到）。
//    ⚠️ 2026-10-05 加窗口背景那一档后，闸门有**两种**（data-opacity / data-window-backdrop）：
//       亚克力档自己挂了一组面板规则，因为「亚克力 + 面板透明度=不透明」时压根没有
//       data-opacity 属性。判据写成「两个里必须命中一个」，而不是只看前一个。
const OPA_GATES = ['data-opacity', 'data-window-backdrop'];
const unGatedOpa = parseCssBlocks(galleryCss).filter(
  (b) =>
    b.decls['background-color'] &&
    String(b.decls['background-color']).includes('--ui-alpha') &&
    splitSel(b.sel).some((s) => !OPA_GATES.some((g) => s.includes(g))),
);
expect(
  unGatedOpa.length === 0,
  '所有用 --ui-alpha 算背景色的规则都带闸门（data-opacity 或 data-window-backdrop；' +
    '无条件生效会让默认档也走一遍 color-mix）' +
    (unGatedOpa.length ? '（漏：' + unGatedOpa.map((b) => b.sel).join(' / ') + '）' : ''),
);

const opaPanelRules = parseCssBlocks(galleryCss).filter(
  (b) => b.sel.includes('html[data-opacity]') && b.decls['background-color'],
);
expect(opaPanelRules.length > 0, '透明度面板规则存在（把界面框架的底色按 --ui-alpha 掺进 transparent）');
// ④ 只碰 background-color —— 用 background 简写会把刚铺好的 --bg-texture（background-image）
//    连 background-repeat / size 一起重置成初始值（症状：一开透明度，纹理就没了）。
expect(
  opaPanelRules.every((b) => !b.decls.background),
  '透明度面板规则不得用 background 简写（简写会重置纹理的 background-image）',
);
// ⑤ `!important` 不能省：浅色档的 `html[data-theme='light'] .x { background: color-mix(...) }`
//    与 theme-polish.css 的简写规则会把它压掉，而靠文件顺序赢不了。
expect(
  opaPanelRules.every((b) => String(b.decls['background-color']).includes('!important')),
  '透明度面板规则的 background-color 带 !important（否则浅色档 / theme-polish 的简写会赢）',
);

// ⑥ 覆盖面：8 个界面框架面一个都不能漏（漏挂的面 = 「一块板不透、其余都透」，很显眼）。
const OPA_FACES = [
  '.titlebar',
  '.topbar',
  '.toolbar',
  '.sidebar',
  '.content-area',
  '.browse-footer',
  '.settings-page',
  '.app-rail',
  // 2026-10-05 补入：`.home-page` 与 `.settings-page` 同族（都是「一页」而不是内容区里的分支）。
  // 上一轮漏了它 ⇒ 在首页上只有它一块大面不透（此时 #contentArea / #sidebar 都 display:none，
  // 页面上看得见的面只剩 .app-rail / .titlebar / .topbar / .home-page，前三个都会变透），
  // 正是本节注释里警告的「一块板不透、其余都透」。网页端没有这个节点，规则留着无害（同 .app-rail）。
  '.home-page',
];
const opaSelParts = opaPanelRules.flatMap((b) => splitSel(b.sel));
const opaFaceMissing = OPA_FACES.filter((f) => !opaSelParts.some((s) => s.endsWith(' ' + f)));
expect(
  opaFaceMissing.length === 0,
  '透明度覆盖全部 9 个界面框架面（titlebar / topbar / toolbar / sidebar / content-area / ' +
    'browse-footer / settings-page / app-rail / home-page）' +
    (opaFaceMissing.length ? '（缺：' + opaFaceMissing.join(', ') + '）' : ''),
);

// ⑦ 每一档都要**同步提亮 `--ui-alpha` 对应档的 .aurora-blob**，且明暗各一条。
//    ⚠️ 这条是「效果可见」的必要条件，不是装饰：只降面板 alpha 实测面板色差 ΔE 只有 4~6，
//    因为面板色 --glass 与 body 底 --bg-primary 本来就近乎同色；透出的那层极光
//    默认 opacity 0.3，是**按「面板不透明、极光只做边角点缀」定的**（glass / aurora
//    两个材质档早就走过同一手：把它们提到 0.62 / 0.8）。
const blobMissing = mainOpa.filter((o) => {
  if (o === 'opaque') return false;
  const dark = new RegExp("html\\[data-opacity='" + o + "'\\]\\s+\\.aurora-blob").test(cssSrc);
  const light = new RegExp(
    "html\\[data-theme='light'\\]\\[data-opacity='" + o + "'\\]\\s+\\.aurora-blob",
  ).test(cssSrc);
  return !(dark && light);
});
expect(
  blobMissing.length === 0,
  '每一档都同步提亮 .aurora-blob 且明暗各一条（浅色档 blob 走 mix-blend-mode: screen，' +
    '沿用深色那组值会「开了没反应」）' +
    (blobMissing.length ? '（缺：' + blobMissing.join(', ') + '）' : ''),
);

// 9h. 面板透明度的**链路**断言 —— 「照抄一维时最容易漏的那几处」。
// ⚠️ 这些点漏了的症状全都是**静默的**：控件能选、属性好看，但「改了不保存」「保存了不生效」
//    「首屏闪一下」「鼠标扫过主题就把这一维清了」。上面那些「白名单逐位一致」的列表断言
//    一条都抓不到，只有真跑一次 change 才看得见 —— 而这几个正则正是那次 running 的前置。
const settingsJsSrc = read('src/renderer/settings.js');
expect(
  /sid === 'settingUiOpacity'/.test(uiEventsSrc),
  '设置页 change 委托包含 settingUiOpacity（漏了 = 设置页改了这维不会被保存）',
);
expect(
  /uiOpacity:\s*appearance\.uiOpacity/.test(settingsJsSrc),
  'settings.js 的 updateSettings 载荷带 uiOpacity（漏了 = 控件动了但请求里没这个字段）',
);
expect(
  /appearance\.uiOpacity === \(ap\.uiOpacity \|\| 'opaque'\)/.test(settingsJsSrc),
  'settings.js 的「无变化就短路」比较含 uiOpacity（漏了 = 该维变化被判成无变化，整次保存被吞）',
);
expect(
  /if \(opacity === 'opaque'\) document\.documentElement\.removeAttribute\('data-opacity'\)/.test(
    shellSrc,
  ),
  'ui-shell 在 opaque 档**移除** data-opacity（写成 setAttribute(…, "opaque") 会让默认档也走 color-mix）',
);
expect(
  /html\.(set|remove)Attribute\(\s*'data-opacity'/.test(rendererHtml),
  '首帧内联脚本会设 / 移除 data-opacity（漏了 = 首屏先按不透明渲染、再跳一下）',
);
// 顶部「悬浮预览」必须能原样还原：快照与「只改一维」的解析都要带上这两维，
// 否则鼠标扫过主题项再移开，就把用户选的纹理 / 透明度还原成默认值了。
expect(
  /uiOpacity: normalizeUiOpacity\(root\.getAttribute\('data-opacity'\)\)/.test(appJsSrc),
  'app.js 的 readAppliedAppearanceTriple 带 uiOpacity（漏了 = 悬浮预览结束后透明度被还原成 opaque）',
);
expect(
  /uiOpacity: base\.uiOpacity,/.test(appJsSrc),
  'app.js 的 resolveQuickThemeOptionTriple 两条分支都带 uiOpacity（漏了 = 套预设会清掉透明度）',
);
// 🔴 这条是 2026-10-05 由端到端探针抓出来的真 bug（静态检查当时全绿）：
//    setGeneralSettingsAppliedFromObject 是**逐个列举字段**的，漏一维 → 变更检测里
//    `appearance.uiOpacity === (ap.uiOpacity || 'opaque')` 的右式恒为默认值 →
//    用户把这一维**切回默认值**时判「无变化」→ 整次保存被短路吞掉。
//    症状 = 「选了通透再想关回不透明，关不掉」，而开档 / 换档全都正常。
expect(
  /uiOpacity: normalizeUiOpacity\(s\.uiOpacity\)/.test(appJsSrc),
  'app.js 的 setGeneralSettingsAppliedFromObject 收录 uiOpacity' +
    '（漏了 = 切回「不透明」被判成无变化、保存被短路吞掉）',
);

// 9i. 窗口背景（窗口级开关）的 CSS + 链路契约 —— 这一维**最容易「处处都对、就是没效果」**：
//     白名单 / 下拉 / 属性全对，但窗口没建成透明的、或 body 还是实色、或面板被 `--ui-alpha`
//     的 100% 兜回不透明 —— 三种结果都是「亚克力 = 今天的样子」，
//     而上面所有列表类断言**一条都不会红**。
//
// ① 亚克力档必须给 `--ui-alpha` 装一个**真的小于 100% 的上限**。
//    ⚠️ 这条是本维最关键的牙齿：不装的话「亚克力 + 面板透明度=不透明」落成
//    `:root` 的 100% → 面板全实色 → 整个窗口被盖满 → 效果归零。
//    判据要**取值再比大小**，不能只查「有没有 --ui-alpha 这一行」（100% 也是有一行）。
const wbdAlphaBlock = parseCssBlocks(galleryCss).find(
  (b) => /^html\[data-window-backdrop\]$/.test(b.sel.trim()) && b.decls['--ui-alpha'],
);
const wbdAlphaPct = wbdAlphaBlock
  ? parseFloat(String(wbdAlphaBlock.decls['--ui-alpha']).replace('%', ''))
  : NaN;
expect(
  Number.isFinite(wbdAlphaPct) && wbdAlphaPct < 100,
  '透明档给 --ui-alpha 装了 < 100% 的上限（否则「亚克力+不透明」= 面板实色 = 效果归零）',
);
expect(
  /html\[data-window-backdrop\]\[data-opacity='clear'\]\s*\{[^}]*--ui-alpha/.test(gdClean),
  '「透明档 + 通透」要单独把更透的档值保下来（上面那条上限会把 clear 的 46% 拍回去）',
);
// 🔴 闸门必须是「属性存在」而**不是某个具体档位值**：三档要命中同一条上限规则，写死
//    `='acrylic'` 时后扩的档会**悄悄漏掉这条上限** —— 症状是新档面板全实色、效果为零，
//    而上面那几条断言（查块存在 / 取值 < 100%）全都还是绿的。
expect(
  !/data-window-backdrop='acrylic'\]\s*\{/.test(gdClean),
  '透明档的 --ui-alpha 上限闸门用 `[data-window-backdrop]` 泛化，不写死某个档位值',
);

// ② 透明档必须自己再挂一遍面板半透明（闸门 = 属性存在；solid 档不设属性 → 天然不命中）。
const wbdPanelRules = parseCssBlocks(galleryCss).filter(
  (b) => /html\[data-window-backdrop\]/.test(b.sel) && b.decls['background-color'],
);
expect(
  wbdPanelRules.length > 0,
  '透明档另有一组面板半透明规则（闸门 data-window-backdrop；否则「亚克力+不透明」时看不到任何效果）',
);
// ③ 与透明度那组同样的两条硬约束：不得用 background 简写（会重置纹理的 background-image）、
//    必须 !important（浅色档与 theme-polish 的简写规则会压掉它）。
expect(
  wbdPanelRules.every((b) => !b.decls.background),
  '亚克力面板规则不得用 background 简写（简写会重置纹理的 background-image）',
);
expect(
  wbdPanelRules.every((b) => String(b.decls['background-color']).includes('!important')),
  '亚克力面板规则的 background-color 带 !important（否则浅色档 / theme-polish 的简写会赢）',
);
// ④ 覆盖面同上：漏一个面就是「一块板不透、其余都透」。
const wbdSelParts = wbdPanelRules.flatMap((b) => splitSel(b.sel));
const wbdFaceMissing = OPA_FACES.filter((f) => !wbdSelParts.some((s) => s.endsWith(' ' + f)));
expect(
  wbdFaceMissing.length === 0,
  '亚克力档同样覆盖全部 8 个界面框架面' +
    (wbdFaceMissing.length ? '（缺：' + wbdFaceMissing.join(', ') + '）' : ''),
);

// ⑤ body：窗口本身透明之后，body 若还画不透明底，桌面就被挡死在最底层。
//    ⚠️ 必须 `!important`：`html[data-theme='dark'][data-bg='ink'] body`（(0,3,1)）会压掉它；
//    且**墨色档必须另有一条专属规则**，否则墨色 + 亚克力的底色对不上。
const bodyAcrylic = parseCssBlocks(cssSrc).filter(
  (b) =>
    b.sel.includes('data-window-backdrop') &&
    b.sel.trim().endsWith(' body') &&
    b.decls.background,
);
expect(
  bodyAcrylic.length >= 9,
  'styles.css 有 9 条 body 透明档规则（3 档 × 默认 / 浅色 / 墨色）—— 实际 ' +
    bodyAcrylic.length +
    ' 条',
);
// 🔴 每档 3 条 + 三档**程度必须真的不同**。只加白名单与下拉、忘写 CSS，或给三档写了同一组
//    数字，症状都是「四个档位长得一模一样」—— 而上面按总条数算的断言在「9 条全挂在同一个
//    档上」时仍然是绿的。
const wbdTiers = mainWbd.filter((b) => b !== 'solid');
const wbdTierStats = wbdTiers.map((tier) => {
  const rules = bodyAcrylic.filter((b) => b.sel.includes("'" + tier + "'"));
  const base = rules.find((b) =>
    new RegExp("^html\\[data-window-backdrop='" + tier + "'\\] body$").test(b.sel.trim()),
  );
  const m = base && /var\(--bg\)\s+(\d+(?:\.\d+)?)%/.exec(String(base.decls.background));
  return { tier: tier, count: rules.length, alpha: m ? parseFloat(m[1]) : NaN };
});
expect(
  wbdTierStats.every((t) => t.count === 3),
  '每个透明档都有 3 条 body 规则（默认 / 浅色 / 墨色）—— 实际 ' +
    wbdTierStats.map((t) => t.tier + ':' + t.count).join(', '),
);
expect(
  wbdTierStats.every((t) => Number.isFinite(t.alpha)) &&
    wbdTierStats[0].alpha > wbdTierStats[1].alpha &&
    wbdTierStats[1].alpha > wbdTierStats[2].alpha,
  '三档的 body 底色 alpha 严格递减（alpha 是**不透明度**，越大越实 → light > 中 > strong）—— 实际 ' +
    wbdTierStats.map((t) => t.tier + '=' + t.alpha).join(', '),
);
// 🔴 中档 `acrylic` 是**扩档前唯一的值**，用户 `settings.json` 里存的可能就是它 ——
//    它的数值必须**钉死成 38%**（改它 = 已选亚克力的用户外观被静默改动，且没有任何界面提示）。
//    判据取**值相等**而不是「小于某数」：范围断言挡不住「改成 30% 也还在范围内」。
expect(
  wbdTierStats[1] && wbdTierStats[1].alpha === 38,
  '中档 acrylic 的 body 底色仍是扩档前的 38%（兼容老设置，不许随视觉微调一起改）—— 实际 ' +
    (wbdTierStats[1] ? wbdTierStats[1].alpha : 'N/A'),
);
// 🔴 相邻两档的差距要够大：三档「严格递减」但写成 40/38/36 时断言照样全绿，
//    而界面上就是「四个档位长得一模一样」（与配色那组 ΔE 护栏同一个思路）。
expect(
  wbdTierStats.length === 3 &&
    wbdTierStats[0].alpha - wbdTierStats[1].alpha >= 10 &&
    wbdTierStats[1].alpha - wbdTierStats[2].alpha >= 10,
  '相邻两档的 body alpha 差距 ≥ 10 个百分点（太接近 = 四个档位肉眼分不出）—— 实际 ' +
    wbdTierStats.map((t) => t.alpha).join(' / '),
);
expect(
  bodyAcrylic.every(
    (b) =>
      String(b.decls.background).includes('color-mix') &&
      String(b.decls.background).includes('!important'),
  ),
  'body 亚克力规则的底色走 color-mix 且带 !important（写死实色 = 透不出去；不带 !important 会被墨色档压掉）',
);

// ⑥ 主进程：建窗参数必须**成套**出现。
expect(
  /uiWindowBackdrop:\s*'solid'/.test(mainSrc),
  'createDefaultSettings 有 uiWindowBackdrop: solid（缺了老配置拿不到默认值）',
);
expect(
  /UI_WINDOW_BACKDROP_ALLOWED\.indexOf\(settings\.uiWindowBackdrop\)/.test(mainSrc),
  'main.js 的 reconcileThemeStyleSettings 校验 uiWindowBackdrop（漏了 = 坏值直接进建窗逻辑）',
);
expect(
  /winOpts\.transparent\s*=\s*true/.test(mainSrc) &&
    /winOpts\.backgroundColor\s*=\s*'#00000000'/.test(mainSrc) &&
    /winOpts\.backgroundMaterial\s*=\s*'acrylic'/.test(mainSrc),
  'createWindow 在亚克力档成套设置 transparent + backgroundColor(#00000000) + backgroundMaterial' +
    '（少一个 = 洗白 / 首帧闪纯色 / 没有模糊）',
);
// 🔴 建窗判据必须是「非 solid」而**不是写死某个透明档**：写死 `=== 'acrylic'` 时，后扩的档
//    会被判成 solid → 建成**不透明窗口** → body 再透明也只能透到窗口自己的底色上，
//    新档「完全没效果」，而上面那条成套参数断言依然全绿（参数都还在，只是走不到）。
expect(
  !/backdrop\s*===\s*'acrylic'/.test(mainSrc),
  'createWindow 的透明判据按白名单取（非 solid），不写死某个档位值' +
    '（写死 = 后扩的档被建成不透明窗口、完全没效果）',
);
// 🔴 **主界面（窗口本身）刻意不做圆角** —— 2026-10-05 三条路全部实测走死后回退，
//    理由见 `src/main.js` 里那段长注释。这里钉住的是**别再试一遍**：
//    只有「窗口区域裁剪」能把圆角真的画出来，但那样四角露的是**纯亚克力底**
//    （DWM 的模糊铺满整个窗口矩形、不跟随窗口区域），用户看到的就是「圆角还有底色」。
expect(
  !/\.setShape\s*\(/.test(mainSrc) && !/RoundedWindowShape/.test(mainSrc),
  '主进程不得再引入 `setShape` 窗口圆角裁剪' +
    '（四角会是亚克力底而不是桌面，等于给窗口加一圈脏边；想要圆角只能改渲染层内容卡片）',
);
expect(
  !/roundedCorners\s*:/.test(mainSrc),
  'createWindow 不得显式写 `roundedCorners`（win32 上 frameless 窗口本就没有系统圆角，' +
    '写了只会让人误以为圆角是我们实现的）',
);
// 🔴 这条是本维的**第二条牙齿**：渲染层必须拿到「已生效值」而不是设置值。
expect(
  /payload\.uiWindowBackdropApplied\s*=\s*windowBackdropAppliedAtLaunch/.test(mainSrc),
  '主进程随设置一起传「已生效的窗口背景」（漏了 = 用户一改档，body 立刻透明而窗口还是实色 → 界面洗白）',
);
expect(
  /windowBackdropAppliedAtLaunch\s*=\s*backdrop/.test(mainSrc),
  'createWindow 记录本次建窗真正用的档（否则「已生效值」永远等于初值 solid）',
);

// ⑦ 渲染层链路：与透明度那一组同源的「最容易漏的四处」。
expect(
  /uiWindowBackdrop:\s*normalizeUiWindowBackdrop\(s\.uiWindowBackdrop\)/.test(appJsSrc),
  'app.js 的 setGeneralSettingsAppliedFromObject 收录 uiWindowBackdrop' +
    '（漏了 = 「亚克力切回实色」被判成无变化、保存被短路吞掉）',
);
expect(
  /uiWindowBackdrop:\s*appearance\.uiWindowBackdrop/.test(settingsJsSrc),
  'settings.js 的 updateSettings 载荷带 uiWindowBackdrop（漏了 = 控件动了但请求里没这个字段）',
);
expect(
  /appearance\.uiWindowBackdrop === \(ap\.uiWindowBackdrop \|\| 'solid'\)/.test(settingsJsSrc),
  'settings.js 的「无变化就短路」比较含 uiWindowBackdrop（漏了 = 切回实色被吞）',
);
expect(
  /sid === 'settingUiWindowBackdrop'/.test(uiEventsSrc),
  '设置页 change 委托包含 settingUiWindowBackdrop（漏了 = 设置页改了这档不会被保存）',
);
expect(
  /if \(s\.uiWindowBackdropApplied != null\)/.test(shellSrc) &&
    /(set|remove)Attribute\(\s*'data-window-backdrop'/.test(shellSrc),
  'ui-shell 只在拿到「已生效值」时才动 data-window-backdrop' +
    '（回落成设置值 = 悬浮预览 / 保存失败回滚这两条路径都会把界面洗白）',
);
expect(
  /html\.(set|remove)Attribute\(\s*'data-window-backdrop'/.test(rendererHtml),
  '首帧内联脚本会设 / 移除 data-window-backdrop（漏了 = 透明窗口上先画一整帧实色底）',
);
// 悬浮预览的三元组必须带齐（虽然属性由「已生效值」兜住了，但快照 / 还原仍靠它保持完整）
expect(
  /uiWindowBackdrop: normalizeUiWindowBackdrop\(root\.getAttribute\('data-window-backdrop'\)\)/.test(
    appJsSrc,
  ),
  'app.js 的 readAppliedAppearanceTriple 带 uiWindowBackdrop（否则还原三元组缺这一维）',
);
expect(
  (appJsSrc.match(/uiWindowBackdrop: base\.uiWindowBackdrop,/g) || []).length === 2,
  'app.js 的 resolveQuickThemeOptionTriple 两条分支都带 uiWindowBackdrop（漏了 = 套预设会丢这一维）',
);
expect(
  (appJsSrc.match(/uiWindowBackdrop: windowBackdrop,/g) || []).length === 2,
  'getAppearanceControlValue 两条返回分支都带 uiWindowBackdrop（漏了 = 保存时这一维被写回默认值）',
);
expect(
  /uiWindowBackdrop:\s*windowBackdrop,/.test(shellSrc),
  'ui-shell 的启动快照带 uiWindowBackdrop（漏了 = 下次启动首帧先画实色底再变透）',
);

// 10. 切「界面风格」预设的下拉：change 链路必须**先把预设展开进两维控件**再保存。
//
// 根因（历史 bug「切换主题不生效」）：getAppearanceControlValue() 在「下拉=具体预设」时会拿
// 强调色/背景两维控件的**当前值**与预设比对，不一致就退回「以控件为准」（这是为了保护
// "只改一维"的场景，不能反转）。而用户点预设时，两维控件还停在上一套的**残留值**上 →
// 判不相等 → 退回控件分支 → 推出的三元组与保存前逐位相同 → persistGeneralSettingsFromControls
// 的变更检测判「无变化」→ 整次切换被静默吞掉。症状：顶栏与设置页的风格下拉都毫无反应，
// 且两个下拉各自停在不同的值上（而只改强调色/背景是好的 —— 那两维本来就变）。
// 注：appJsSrc / uiEventsSrc 已在文件顶部读取（§4a 就要用），这里不再重复声明。

expect(
  (uiEventsSrc.match(/options\.onThemePresetExpand/g) || []).length === 2,
  'ui-events 的两条 change 路径（设置页委托 + 顶栏）都取到了 onThemePresetExpand',
);
expect(
  /sid === 'settingThemeStyle'[\s\S]{0,240}onThemePresetExpand\(/.test(uiEventsSrc),
  '设置页「界面风格」change 在保存之前先展开预设',
);
expect(
  /quickThemeStyle\.addEventListener\('change'[\s\S]{0,300}onThemePresetExpand\(/.test(uiEventsSrc),
  '顶栏「界面风格」change 同样先展开（两条路径不能只修一条）',
);
expect(
  /function expandThemePresetToControls\(id\)[\s\S]{0,1000}resolveThemeTriple[\s\S]{0,700}settingUiAccent[\s\S]{0,500}settingUiBackground/.test(
    appJsSrc,
  ),
  'app.js 的 expandThemePresetToControls 用预设表展开并写进设置页的两个控件',
);
expect(
  (appJsSrc.match(/onThemePresetExpand: expandThemePresetToControls/g) || []).length === 2,
  'app.js 两处绑定都把 expandThemePresetToControls 传下去',
);
// 前提锚点：只要这个"控件与预设不符就退回控件"的分支还在，上面这层展开就是必需的。
// 若哪天有人反转了它，务必连带删掉本组断言并重新评估 —— 否则改回"以预设为准"后，
// 「只改一维」会被风格下拉静默拍回去（另一个历史 bug）。
expect(
  /if \(cAccent === preset\.uiAccent && cBg === preset\.uiBackground\)/.test(appJsSrc),
  'getAppearanceControlValue 仍保留「两维与预设一致才采纳预设」的判等（展开逻辑的前提）',
);

if (failures) {
  console.log('[theme-regression] FAIL（' + failures + ' 项）');
  process.exit(1);
}
console.log('[theme-regression] PASS');
