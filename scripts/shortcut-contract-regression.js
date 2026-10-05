'use strict';
/**
 * 快捷键契约回归 —— 钉住「键位只有一个真相源」。
 *
 * 背景：改造前每个键位都硬编码在各自的事件处理里（`ui-events.js` 的预览段、
 * `nav-history.js` 的导航段、`main.js` 的全局段），三处各写各的，结果是标题栏菜单里
 * 明明写着 `Ctrl+O` / `F11` / `F12`，**实际没有任何人监听** —— 三个快捷键长期是摆设。
 * 现在动作与默认键只在 `src/renderer/shortcuts.js` 声明一次，设置页从同一份注册表渲染，
 * 事件处理端只问「这一下按键落在哪个动作上」。
 *
 * ⚠️ 但这条契约此前**零机械防线**（只有 nav-history 自己那套 `Alt+←/→` 的守护，
 * 与本注册表无关）。于是它的六条红线只写在记忆文件里 —— 而记忆文件是会漂移的：
 * 例如本轮给首页加 `nav.home` 后，记忆里那句「21 动作」就成了过时数字。
 * 所以这个脚本**不抄任何金标准**：动作表自己就是标准，断言全部从
 * `RendererShortcuts` 导出对象上派生（数量、id、分组、绑定、冲突）。
 * 只有「本轮新增的 `nav.home` 默认键」和源码接线位置是写死的。
 *
 * 钉的东西：
 *   1. 🔴 **注册表自身的结构性硬约束**：id 唯一、分组/作用域合法、默认键在同一 scope 内无冲突。
 *      （冲突会让 `actionFor` 的命中变得取决于遍历顺序 —— 表现是「设了键、按下去却是别的动作」。）
 *   2. 🔴 **归一的边界语义**：`Plus` / `Minus` 上「键盘布局自带的 Shift」必须丢掉
 *      （美式布局上 `+` 本身就要求 Shift），否则用户旧习惯的裸 `=` / `+` 缩放会静默失灵；
 *      但 `Ctrl+Shift+=` **不**能等同于 `Ctrl+=` —— 那是用户真按住的 Shift，丢了就是吃键。
 *   3. 🔴 **`main.js` 不许认识动作 id**：动作表活在渲染进程，主进程硬抄白名单必然漂移。
 *      这里用「把 22 个 id 逐个到 main.js 里找」来机械证明它只校形态。
 *   4. 🔴 **方向一致性**：`ui-events.js` 只回答「动作 → 做什么」，
 *      不得再出现 `e.key === '...'` 字面量 —— 否则设置页改了键、这里不生效。
 *      ⚠️ 这条只对 `ui-events.js` 成立：`app.js:4327`（预览信息面板）与
 *      `shortcut-settings.js`（录制 UI）里的 `e.key` 是**局部交互**，不是注册表动作，
 *      对它们做同样断言会假红。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const SHORTCUTS = 'src/renderer/shortcuts.js';
const SHORTCUT_SETTINGS = 'src/renderer/shortcut-settings.js';
const EVENTS = 'src/renderer/ui-events.js';
const SETTINGS = 'src/renderer/settings.js';
const MAIN = 'src/main.js';
const I18N = 'src/renderer/i18n.js';
const RUN_REGRESSIONS = 'scripts/run-regressions.js';

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

/**
 * 剥掉注释但保持长度与换行 —— 本项目的注释里大量出现 `e.key === '...'` 这类字样，
 * 直接 grep 会把注释当成结构判据（`ui-events.js` 就有一段注释在讲「不再出现 e.key ===」）。
 * 实现与 dead-reference-regression.js / home-page-regression.js 的那份一致。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let st = null;
  while (i < src.length) {
    const c = src[i];
    if (st) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] || '';
        i += 2;
        continue;
      }
      if (c === st) st = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      st = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 取两个标记之间的片段（含首标记）。找不到时返回空串，由「夹具自证」断言兜住 */
function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) return '';
  if (!to) return src.slice(a);
  const b = src.indexOf(to, a + from.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

/**
 * 用 acorn 把注释替换成**等长空白**（保留换行）。
 *
 * ⚠️ 这里刻意**不用**上面那个 `stripComments`：它不认正则字面量，
 * `src/main.js` 里存在含引号的正则 ⇒ 状态机从那里起错位，之后所有注释都剥不掉。
 * 实测症状：`main.js` 里唯一一处 `setOverrides(` 出现在**注释**里，
 * 却让「主进程不许调 setOverrides」这条断言假红。
 * 同一个坑仓库里已有先例，见 `dead-reference-regression.js:223` 的注释。
 *
 * 解析失败时退回 `stripComments`（宁可宽松也不要整个脚本崩），
 * 但调用方有「夹具自证」断言，一旦发生降级就会显式报出来 —— 不静默。
 */
function blankComments(raw) {
  const ranges = [];
  acorn.parse(raw, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => {
      ranges.push([start, end]);
    },
  });
  if (!ranges.length) return raw;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(raw.slice(cur, r[0]));
    parts.push(raw.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(raw.slice(cur));
  return parts.join('');
}

/** 造一个仅含判定所需字段的键盘事件（`bindingFromEvent` 只读 key 与四个修饰位） */
function ev(key, mods) {
  const m = mods || {};
  return {
    key: key,
    ctrlKey: !!m.ctrl,
    altKey: !!m.alt,
    shiftKey: !!m.shift,
    metaKey: !!m.meta,
  };
}

// ---------------------------------------------------------------------- 载入真注册表

const shortcutsRaw = read(SHORTCUTS);
const sandbox = {};
let SR = null;
let loadError = '';
try {
  vm.createContext(sandbox);
  // 脚本式沙箱：vendor 与渲染端 UMD 模块都挂 `window`/`globalThis`，这里等价于普通 <script>
  vm.runInContext(shortcutsRaw, sandbox);
  SR = sandbox.RendererShortcuts || null;
} catch (e) {
  loadError = String((e && e.message) || e);
}

check(
  '夹具自证：shortcuts.js 能在脚本式沙箱里加载并导出 RendererShortcuts',
  !!SR,
  loadError,
);

if (!SR) {
  process.stdout.write('[shortcut-regression] 快捷键契约\n');
  for (const line of notes) process.stdout.write(line + '\n');
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[shortcut-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}

const ACTIONS = SR.ACTIONS || [];
const GROUPS = SR.GROUPS || [];
const IDS = ACTIONS.map((a) => a.id);

const i18nRaw = read(I18N);
const runSrc = read(RUN_REGRESSIONS);

/** 剥注释（优先 acorn；降级会被下面的夹具自证抓出来） */
function commentFree(rel) {
  const raw = read(rel);
  try {
    return { code: blankComments(raw), viaAcorn: true };
  } catch (e) {
    return { code: stripComments(raw), viaAcorn: false, err: String((e && e.message) || e) };
  }
}

const fxMain = commentFree(MAIN);
const fxEvents = commentFree(EVENTS);
const fxSettings = commentFree(SETTINGS);
const fxPanel = commentFree(SHORTCUT_SETTINGS);
const downgraded = [fxMain, fxEvents, fxSettings, fxPanel].filter((f) => !f.viaAcorn);
check(
  '夹具自证：四个源文件都走 acorn 剥离注释（没降级到会认错正则的那条路）',
  downgraded.length === 0,
  downgraded.map((f) => f.err).join(' | '),
);

const mainCode = fxMain.code;
const eventsCode = fxEvents.code;
const settingsCode = fxSettings.code;
const panelCode = fxPanel.code;

// ══════════════════════════════════════════════ 1. 注册表结构（数据驱动）

check('注册表非空', ACTIONS.length > 0, String(ACTIONS.length));
check(
  '动作 id 唯一（重复 id 会让设置页改一个键却影响另一个动作）',
  new Set(IDS).size === IDS.length,
  IDS.filter((id, i) => IDS.indexOf(id) !== i).join(', '),
);
check(
  '动作 id 形如「分组.动作名」（设置页与落库都按它索引）',
  IDS.every((id) => /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z0-9]*$/.test(id)),
  IDS.filter((id) => !/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z0-9]*$/.test(id)).join(', '),
);

const groupIds = GROUPS.map((g) => g.id);
check('GROUPS 非空', groupIds.length > 0);
check(
  '每个动作的 group 都命中 GROUPS（否则该动作在设置页里无处可画 → 静默消失）',
  ACTIONS.every((a) => groupIds.indexOf(a.group) !== -1),
  ACTIONS.filter((a) => groupIds.indexOf(a.group) === -1)
    .map((a) => a.id)
    .join(', '),
);
check(
  '不存在空分组（分组有定义却没有任何动作 → 设置页出现一个空标题）',
  groupIds.every((g) => ACTIONS.some((a) => a.group === g)),
  groupIds.filter((g) => !ACTIONS.some((a) => a.group === g)).join(', '),
);
check(
  '每个分组的 key / zh 齐备（i18n 未就绪时靠 zh 兜底）',
  GROUPS.every((g) => g.key && g.zh),
  GROUPS.filter((g) => !g.key || !g.zh)
    .map((g) => g.id)
    .join(', '),
);

const SCOPES = ['global', 'preview'];
check(
  '动作 scope 只允许 global / preview（scope 是冲突判定域，多一个值就多一套语义）',
  ACTIONS.every((a) => SCOPES.indexOf(a.scope) !== -1),
  ACTIONS.filter((a) => SCOPES.indexOf(a.scope) === -1)
    .map((a) => a.id + ':' + a.scope)
    .join(', '),
);
check(
  '两个 scope 都有动作（少一个说明有段事件分发被整体摘掉了）',
  SCOPES.every((s) => ACTIONS.some((a) => a.scope === s)),
);
check(
  '每个动作都有 i18n key 与 zh 兜底文案',
  ACTIONS.every((a) => typeof a.key === 'string' && a.key && typeof a.zh === 'string' && a.zh),
  ACTIONS.filter((a) => !a.key || !a.zh)
    .map((a) => a.id)
    .join(', '),
);
check(
  '每个动作的 def 是非空字符串数组（空数组 = 动作永远不可能触发，却仍占着设置页一行）',
  ACTIONS.every((a) => Array.isArray(a.def) && a.def.length > 0 && a.def.every((d) => typeof d === 'string' && d)),
  ACTIONS.filter((a) => !Array.isArray(a.def) || !a.def.length)
    .map((a) => a.id)
    .join(', '),
);
check(
  '默认绑定串归一幂等（`normalizeBinding(normalizeBinding(x)) === normalizeBinding(x)`）',
  ACTIONS.every((a) => a.def.every((d) => {
    const once = SR.normalizeBinding(d);
    return !!once && SR.normalizeBinding(once) === once;
  })),
  ACTIONS.filter((a) => a.def.some((d) => SR.normalizeBinding(SR.normalizeBinding(d)) !== SR.normalizeBinding(d)))
    .map((a) => a.id)
    .join(', '),
);

// 🔴 默认键在同一 scope 内不得冲突。冲突的后果不是报错，而是 actionFor 的命中取决于
// 注册表遍历顺序 —— 表现成「设了键、按下去执行的是另一个动作」。
{
  const conflicts = SR.findConflicts(SR.defaults()) || {};
  check(
    '🔴 默认绑定在同一 scope 内零冲突',
    Object.keys(conflicts).length === 0,
    JSON.stringify(conflicts).slice(0, 240),
  );
}

// 本轮新增的这条（首页）写死默认键：它是「顶栏按钮与键盘同一入口」的证据
{
  const home = SR.actionById('nav.home');
  check('存在导航组动作 nav.home', !!home, '');
  check(
    '🔴 nav.home 默认绑定是 Alt+Home（浏览器共识手势，不能用别的功能键顶掉）',
    !!home && SR.normalizeBinding(home.def[0]) === 'Alt+Home',
    home ? JSON.stringify(home.def) : '',
  );
  check(
    'nav.home 落在 navigation 组、global scope（首页在浏览态即可达）',
    !!home && home.group === 'navigation' && home.scope === 'global',
    home ? home.group + '/' + home.scope : '',
  );
}

// ══════════════════════════════════════════════ 2. 归一语义（结果级）

{
  const eq = (a, b) => a === b && a !== '';
  // `+` 与 `=` 必须收敛到同一个 token：美式布局上 `+` 本身就要按住 Shift
  const tPlus = SR.bindingFromEvent(ev('+', {}));
  const tEq = SR.bindingFromEvent(ev('=', {}));
  const tShiftEq = SR.bindingFromEvent(ev('=', { shift: true }));
  const tShiftPlus = SR.bindingFromEvent(ev('+', { shift: true }));
  check(
    '🔴 `+` / `=` / `Shift+=` 三种按键都归一到同一个绑定（否则旧习惯的裸 `=` 缩放会静默失灵）',
    eq(tPlus, tEq) && eq(tEq, tShiftEq) && eq(tEq, tShiftPlus),
    [tPlus, tEq, tShiftEq, tShiftPlus].join(' | '),
  );
  check(
    '🔴 归一后的缩放键真的命中了 preview.zoomIn',
    ['+', '=', '='].every((k, i) =>
      SR.matches('preview.zoomIn', ev(k, i === 2 ? { shift: true } : {})),
    ),
  );
  check(
    '🔴 明细条：无修饰的 Plus/Minus 丢掉「键盘布局自带的 Shift」',
    SR.bindingFromEvent(ev('=', { shift: true })) === 'Plus' &&
      SR.bindingFromEvent(ev('_', { shift: true })) === 'Minus',
    SR.bindingFromEvent(ev('_', { shift: true })),
  );
  check(
    '🔴 反向：`Ctrl+Shift+=` **不**等于 `Ctrl+=`（那是用户真按住的 Shift，丢了就是吃键）',
    SR.bindingFromEvent(ev('=', { ctrl: true, shift: true })) === 'Ctrl+Shift+Plus' &&
      SR.bindingFromEvent(ev('=', { ctrl: true })) === 'Ctrl+Plus' &&
      SR.bindingFromEvent(ev('=', { ctrl: true, shift: true })) !== SR.bindingFromEvent(ev('=', { ctrl: true })),
    SR.bindingFromEvent(ev('=', { ctrl: true, shift: true })),
  );
  check(
    '空格归一到 Space（否则「播放/暂停」绑不上）',
    SR.normalizeBinding('Space') === 'Space' && SR.bindingFromEvent(ev(' ')) === 'Space',
    SR.normalizeBinding('Space') + ' / ' + SR.bindingFromEvent(ev(' ')),
  );
  check(
    '字母主键大小写无关（`f` 与 `F` 是同一个手势）',
    SR.normalizeBinding('F') === SR.normalizeBinding('f') && SR.normalizeBinding('f') === 'F',
  );
  check(
    '🔴 修饰键**之间**顺序无关（`Ctrl+Shift+B` 与 `Shift+Ctrl+B` 归一到同一个串）',
    eq(SR.normalizeBinding('Ctrl+Shift+B'), SR.normalizeBinding('Shift+Ctrl+B')),
    SR.normalizeBinding('Shift+Ctrl+B'),
  );
  check(
    '归一输出一律是固定顺序 `Ctrl+Alt+Shift+Meta+主键`（乱序输入也要收敛到它）',
    SR.normalizeBinding('Meta+Alt+Shift+Ctrl+K') === 'Ctrl+Alt+Shift+Meta+K',
    SR.normalizeBinding('Meta+Alt+Shift+Ctrl+K'),
  );
  check(
    '🔴 `bindingFromEvent` 产出的串与规范化结果一致（否则「按下去的」与「存下来的」对不上）',
    ACTIONS.every((a) =>
      a.def.every((d) => {
        const norm = SR.normalizeBinding(d);
        // 反解：把规范串拆回事件，再问一次事件产出什么
        const bits = norm.split('+');
        const key = bits[bits.length - 1];
        const mods = {
          ctrl: bits.indexOf('Ctrl') >= 0,
          alt: bits.indexOf('Alt') >= 0,
          shift: bits.indexOf('Shift') >= 0,
          meta: bits.indexOf('Meta') >= 0,
        };
        if (key === 'Plus') return SR.bindingFromEvent(ev('+', mods)) === norm;
        if (key === 'Minus') return SR.bindingFromEvent(ev('-', mods)) === norm;
        if (key === 'Space') return SR.bindingFromEvent(ev(' ', mods)) === norm;
        return SR.bindingFromEvent(ev(key, mods)) === norm;
      }),
    ),
    '',
  );
  check(
    '修饰键别名收敛（control / cmd / option 都认）',
    SR.normalizeBinding('control+k') === 'Ctrl+K' &&
      SR.normalizeBinding('cmd+k') === 'Meta+K' &&
      SR.normalizeBinding('option+k') === 'Alt+K',
    [SR.normalizeBinding('control+k'), SR.normalizeBinding('cmd+k'), SR.normalizeBinding('option+k')].join(' / '),
  );
}

// ══════════════════════════════════════════════ 3. actionFor / overrides 行为

{
  SR.setOverrides({});
  check('按住纯修饰键不产生绑定（否则 Shift 一按就触发动作）', SR.bindingFromEvent(ev('Shift', { shift: true })) === '', '');
  check('空事件 / null 事件不炸也不命中', SR.bindingFromEvent(null) === '');
  check('Tab 是保留 token（录制时按不出合理手势）', SR.normalizeBinding('Tab') === '');
  check('无法解析的绑定串归一为空串（不是原样存进去）', SR.normalizeBinding('Ctrl+Shift') === '');

  // 未绑定手势：数据驱动挑一个默认没被占用的
  const allDefaults = new Set();
  for (const a of ACTIONS) for (const d of a.def) allDefaults.add(SR.normalizeBinding(d));
  let probe = null;
  for (let n = 13; n <= 24; n++) {
    const b = SR.normalizeBinding('Ctrl+Alt+F' + n);
    if (b && !allDefaults.has(b)) {
      probe = { binding: b, key: 'F' + n };
      break;
    }
  }
  check('夹具自证：挑得到一个没被任何默认键占用的探针手势', !!probe, '');
  if (probe) {
    check(
      '未绑定手势在 global scope 下不命中任何动作',
      SR.actionFor(ev(probe.key, { ctrl: true, alt: true }), 'global') === '',
      SR.actionFor(ev(probe.key, { ctrl: true, alt: true }), 'global'),
    );
  }

  // scope 隔离：两个 scope 的默认绑定集不得相交（相交就会出现「预览里按键被全局动作抢走」）
  const byScope = { global: new Set(), preview: new Set() };
  for (const a of ACTIONS) {
    for (const d of a.def) {
      const n = SR.normalizeBinding(d);
      if (n && byScope[a.scope]) byScope[a.scope].add(n);
    }
  }
  const cross = [...byScope.global].filter((b) => byScope.preview.has(b));
  check(
    '🔴 两个 scope 的默认绑定集不相交（相交 = 预览按键会被全局动作抢走，且取决于遍历顺序）',
    cross.length === 0,
    cross.join(', '),
  );
  const previewOnly = SR.normalizeBinding('Escape');
  const globalOnly = SR.normalizeBinding('Ctrl+O');
  check(
    '🔴 scope 过滤：preview 专属键在 global scope 下取不到、global 专属键在 preview scope 下取不到',
    byScope.preview.has(previewOnly) &&
      byScope.global.has(globalOnly) &&
      SR.actionFor(ev('Escape', {}), 'global') === '' &&
      SR.actionFor(ev('O', { ctrl: true }), 'preview') === '',
    [SR.actionFor(ev('Escape', {}), 'global'), SR.actionFor(ev('O', { ctrl: true }), 'preview')].join(' / '),
  );

  // 自定义绑定立即生效 + 未知 id 丢弃
  if (probe) {
    SR.setOverrides({ 'global.devtools': probe.binding });
    check(
      '🔴 自定义绑定立即生效（改键后同一个手势命中新动作）',
      SR.actionFor(ev(probe.key, { ctrl: true, alt: true }), 'global') === 'global.devtools',
      SR.actionFor(ev(probe.key, { ctrl: true, alt: true }), 'global'),
    );
    check(
      '覆盖生效后该动作的默认键自然失效（不会两套键同时活着）',
      SR.actionFor(ev('F12', {}), 'global') === '',
      SR.actionFor(ev('F12', {}), 'global'),
    );
  }
  SR.setOverrides({ 'global.noSuchAction': 'Ctrl+Alt+F13' });
  check(
    '🔴 setOverrides 丢弃注册表里不存在的动作 id（否则删掉的动作会永远留在 settings.json 里）',
    Object.keys(SR.getOverrides()).length === 0,
    JSON.stringify(SR.getOverrides()),
  );
  SR.setOverrides({ 'global.devtools': '' });
  check(
    '🔴 空串是「显式禁用」这个合法值，不能被当成「没设置」而回落到默认键',
    JSON.stringify(SR.getOverrides()) === JSON.stringify({ 'global.devtools': '' }) &&
      SR.bindingListFor('global.devtools').length === 0 &&
      SR.actionFor(ev('F12', {}), 'global') === '',
    JSON.stringify(SR.getOverrides()) + ' / ' + SR.actionFor(ev('F12', {}), 'global'),
  );
  SR.setOverrides({});
  check('清空覆盖后回到默认键', SR.actionFor(ev('F12', {}), 'global') === 'global.devtools');
}

// ══════════════════════════════════════════════ 4. 源码红线（剥注释后判定）

check(
  '🔴 ui-events.js 里没有任何 `e.key ===` 字面量（键位判定只许走 actionFor）',
  !/\.key\s*===/.test(eventsCode),
  (eventsCode.match(/[^\n]*\.key\s*===[^\n]*/g) || []).join(' | ').slice(0, 200),
);
check('ui-events.js 确实通过 actionFor 问注册表', /actionFor\(/.test(eventsCode));
check(
  'ui-events.js 仍按 scope 问（global / preview 各一处）',
  eventsCode.includes("actionFor(e, 'preview')"),
  '',
);

check(
  '🔴 main.js 不认识任何动作 id（22 个逐个找）—— 主进程只校验形态，白名单硬抄必然漂移',
  IDS.every((id) => !mainCode.includes(id)),
  IDS.filter((id) => mainCode.includes(id)).join(', '),
);
check('main.js 里保留 normalizeShortcutsSetting 形态兜底', /function normalizeShortcutsSetting/.test(mainCode));
check(
  '主进程不调 setOverrides（注册表活在渲染进程，主进程碰它就是把真相源搬两次）',
  !/setOverrides\(/.test(mainCode),
);

check(
  '🔴 设置页从注册表渲染（引用 ACTIONS 与 GROUPS，不另抄一份动作表）',
  /sr\.ACTIONS/.test(panelCode) && /sr\.GROUPS/.test(panelCode),
  '',
);
check(
  '🔴 shortcut-settings.js 里没有硬编码动作 id（22 个逐个找）',
  IDS.every((id) => !panelCode.includes(id)),
  IDS.filter((id) => panelCode.includes(id)).join(', '),
);

{
  const body = sliceBetween(panelCode, 'function applyFromSettings(', '\n  }');
  check('夹具自证：切出了 applyFromSettings 函数体', body.length > 0, String(body.length));
  const iSet = body.indexOf('setOverrides(');
  const iRender = body.indexOf('renderForm(');
  check(
    '🔴 applyFromSettings 先喂注册表再画界面（顺序反了 ⇒ 首帧「界面显示新键、按下去还是旧键」）',
    iSet >= 0 && iRender >= 0 && iSet < iRender,
    'setOverrides@' + iSet + ' renderForm@' + iRender,
  );
}

{
  const start = sliceBetween(panelCode, 'function startRecording(', '\n  }');
  const stop = sliceBetween(panelCode, 'function stopRecording(', '\n  }');
  check('夹具自证：切出了 startRecording / stopRecording 函数体', start.length > 0 && stop.length > 0);
  check(
    "🔴 录制挂 window **捕获**阶段（addEventListener(..., true)）——设置页开着时别的监听器不许真去执行动作",
    /addEventListener\('keydown',\s*recordingHandler,\s*true\)/.test(start),
    '',
  );
  check(
    '🔴 stopRecording 必须真的摘掉那个捕获监听（否则界面已关、用户却按不动别处）',
    /removeEventListener\('keydown',\s*recordingHandler,\s*true\)/.test(stop),
    '',
  );
}

check(
  '🔴 closeSettingsPage 里调了 stopRecording（离开设置页必须退出录制）',
  /stopRecording\(/.test(settingsCode) && /function closeSettingsPage/.test(settingsCode),
  '',
);

// ══════════════════════════════════════════════ 5. i18n 中英各一份

{
  // `var M = { 'zh-CN': {…}, en: {…} }` —— 用 en 块的起点把两份切开
  const enAt = i18nRaw.indexOf('\n    en: {');
  check('夹具自证：i18n.js 里找得到 en 块起点', enAt > 0, String(enAt));
  const zhPart = enAt > 0 ? i18nRaw.slice(0, enAt) : '';
  const enPart = enAt > 0 ? i18nRaw.slice(enAt) : '';
  const q = (key) => "'" + key + "'";

  const actionKeys = ACTIONS.map((a) => a.key);
  const groupKeys = GROUPS.map((g) => g.key);
  const allKeys = actionKeys.concat(groupKeys);

  const missingZh = allKeys.filter((k) => zhPart.split(q(k)).length - 1 !== 1);
  const missingEn = allKeys.filter((k) => enPart.split(q(k)).length - 1 !== 1);
  check(
    '🔴 每个动作 / 每个分组的 i18n key 在**中文块**里恰好 1 条',
    missingZh.length === 0,
    missingZh.join(', '),
  );
  check(
    '🔴 每个动作 / 每个分组的 i18n key 在**英文块**里恰好 1 条',
    missingEn.length === 0,
    missingEn.join(', '),
  );

  // 反向：i18n 里不许留下「注册表已经不认识的」动作词条（改 id 后旧词条会永远躺在那）
  const orphan = [];
  const re = /'(shortcut\.(?:action|group)\.[A-Za-z0-9]+)'\s*:/g;
  let m;
  while ((m = re.exec(zhPart)) !== null) {
    if (allKeys.indexOf(m[1]) === -1) orphan.push(m[1]);
  }
  check(
    '🔴 i18n 里的 shortcut.action.* / shortcut.group.* 词条没有孤儿（改了动作 id 必须同步删词条）',
    orphan.length === 0,
    orphan.join(', '),
  );
}

// ══════════════════════════════════════════════ 6. 登记进全量回归

check('本守护已登记进 scripts/run-regressions.js', runSrc.includes("'shortcut-contract-regression.js'"));
check(
  '登记位置在末项 ai-lifecycle-regression 之前（末项约定不能破）',
  (() => {
    const i = runSrc.indexOf("'shortcut-contract-regression.js'");
    const j = runSrc.indexOf("'ai-lifecycle-regression.js'");
    return i >= 0 && j >= 0 && i < j;
  })(),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[shortcut-regression] 快捷键契约（唯一真相源 = src/renderer/shortcuts.js）\n');
process.stdout.write(
  '  · 注册表规模：' + ACTIONS.length + ' 动作 / ' + GROUPS.length + ' 组 / ' + SCOPES.length + ' scope\n',
);
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[shortcut-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[shortcut-regression] PASS（' + notes.length + ' 项）\n');
