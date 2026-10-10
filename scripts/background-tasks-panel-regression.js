'use strict';
// 顶栏「后台任务」面板的**统一性**回归（判据与理由见 `docs/contracts/background-tasks.md`）。
//
// 为什么单独一个守护：面板 9 个任务原先各写一套 ——
//   「在跑」字段名 3 种（`running` / `busy` / `optimizing`）、显隐判据 4 种形状、
//   百分比在渲染端 6 处各算一遍（且 `total = 0` 的边界不一致）、
//   文案一半走 i18n 一半是内联三元、元素 id 7 种前缀。
//   ✅ 2026-10-08 已全部收敛（`running` / `done` / 主进程派生 `pct` / 全走 i18n /
//      id 统一成 `task<Name><Part>`）——下面每条断言都是从「已收敛」往回钉，防它长回去。
// 这个守护钉的是**跨节的一致性**；`face-task-regression.js` 钉 AI 两节的细粒度行为。
//
// 钉五类错（每一类都在本工程真实发生过或差点发生）：
//   ① 新增一条进度列却没进 `showPanel` 的或链 ⇒ 只剩它跑时**整块面板消失**
//      （2026-10 已栽两次：缩略图重建、补 tag 倒排 —— 都被「另一个任务同时在跑」遮掩）；
//   ② 百分比又回到渲染端就地相除 ⇒ 同一个 100% 在不同条子上含义不同；
//   ③ `total = 0` 时拿 100% 表示「完成」⇒ 条子先满、再掉回 0%（无效清理那节的旧形状）；
//   ④ 新增文案不走 i18n、或词条只写一种语言 ⇒ 切语言时露 key 或回落中文；
//   ⑤ 元素 id 脱离 `task<Name><Part>`、或 HTML 与 JS 两侧**各改一半**
//      （后者是静默的：`getElementById` 取到 `null`，那一格永远空白，不报错）。
//      ⚠️ 「前缀也是 id 片段」这个形状本轮真漏过一次，见 ⑤ 里的推导。
//   ⑥ **类还在、动效却被压死**：`@media (prefers-reduced-motion: reduce)` 的全局 `*` 规则会把
//      我们的普通元素动画压成静止 —— 不定态于是退化成「静止的 40%」，那是个**错误的确定值**
//      （读作「进度 40%」，真相是「在跑、进度未知」）。换元素时最容易踩：旧 `<progress>`
//      的条纹画在 UA shadow 伪元素上、`*` 压不到，换成 `div` 就压到了。实测数据见 ③ 里那段。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { computePct } = require('../src/main/progress-pct');

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const nodes = new Map();
function node(id) {
  if (!nodes.has(id))
    nodes.set(id, {
      style: {},
      textContent: '',
      // 2026-10-08 加：进度条换成 `div + .progress-fill` 之后判据是 `className`
      // （含「不定态」类）；停止按钮两态还要读 `disabled`。缺这两个字段的夹具会把
      // 「产品没写」与「夹具读不到」混成同一种红。
      className: '',
      disabled: false,
      removeAttribute(key) {
        delete this[key];
      },
    });
  return nodes.get(id);
}
global.window = {};
global.document = { documentElement: { lang: 'zh-CN' }, getElementById: node };
require('../src/renderer/i18n.js');
require('../src/renderer/scan-flow');
global.window.I18n.setLocale('zh-CN', { skipMainSync: true });

const panel = node('panel');
/** 空档位：把 9 个任务全设成「没在跑」，只留用例要开的那个。 */
function idleTasks() {
  return {
    scan: { active: false, progress: { status: 'idle' }, queue: {} },
    thumbs: { running: false },
    thumbRebuild: { running: false },
    invalidCleanup: { running: false },
    duplicateHash: { running: false },
    // 「优化数据库」也走对象形式。它以前是 `optimizing: false` 一个裸布尔 —— 9 个任务里
    // 唯一没有状态对象的那个，于是显隐判据在渲染端成了唯一的特例分支。
    optimize: { running: false },
    face: { running: false, phase: 'idle' },
    semantic: { running: false, operation: 'idle', phase: 'idle' },
  };
}
function render(tasks) {
  return global.window.RendererScanFlow.renderBackgroundTaskPanel({
    state: {},
    // ⚠️ 扫描节的条子 / 计数 / 文件名走 `options.dom`（不是 `getElementById`），
    //    其余各节走 id。夹具两套都要给，否则那一节的断言会「静默变空」（读 undefined）。
    dom: {
      scanProgress: panel,
      taskScanFill: node('taskScanFill'),
      taskScanCount: node('taskScanCount'),
      taskScanFile: node('taskScanFile'),
      taskScanText: node('taskScanText'),
    },
    tasks,
  });
}

// ---------------------------------------------------------------------------
// ① 或链完整性：每个任务都得有一项，缺了 = 只剩它跑时整块面板消失
// ---------------------------------------------------------------------------

const SECTIONS = [
  ['文件夹扫描', 'showScanBlock', { ...idleTasks(), scan: { active: true, progress: { status: 'scanning' }, queue: {} } }],
  ['缩略图补全', 'showThumb', { ...idleTasks(), thumbs: { running: true, phase: 'ready' } }],
  ['缩略图重建', 'showThumbRebuild', { ...idleTasks(), thumbRebuild: { running: true, phase: 'draining' } }],
  ['无效清理', 'showInvalidCleanup', { ...idleTasks(), invalidCleanup: { running: true, checked: 3, total: 10 } }],
  ['优化数据库', 'showOpt', { ...idleTasks(), optimize: { running: true } }],
  ['查重指纹', 'showDupHash', { ...idleTasks(), duplicateHash: { running: true, done: 1, total: 10 } }],
  ['人脸索引', 'showFace', { ...idleTasks(), face: { running: true, phase: 'indexing', done: 1, total: 2 } }],
  ['搜图索引', 'showSemantic', { ...idleTasks(), semantic: { running: true, operation: 'index', phase: 'indexing', done: 1, total: 2 } }],
];

for (const [label, _showVar, tasks] of SECTIONS) {
  /**
   * ⚠️ 这条必须**一个一个单独跑**：两条进度列同时跑时，坏掉的那条会被另一条撑住面板
   * （`showPanel` 是或链）⇒ 「多任务一起跑」的用例抓不到「新任务没进或链」这个缺陷。
   */
  assert.equal(render(tasks), true, label + ' 单独在跑时面板必须可见（或链缺了它 ⇒ 整块面板消失）');
  assert.equal(panel.style.display, 'block', label + ' 单独在跑时面板标题那层必须 display:block');
}
// 反例：没人跑 ⇒ 整块面板收起（否则它会永远挂在界面上）
assert.equal(render(idleTasks()), false, '没有任何任务在跑时面板必须收起');
assert.equal(panel.style.display, 'none', '没有任何任务在跑时面板标题那层必须 display:none');

// ---------------------------------------------------------------------------
// ② 百分比只读主进程派生的 `pct`（给一个与 done/total **不符**的值才有牙）
// ---------------------------------------------------------------------------

const PCT_CASES = [
  ['扫描', 'taskScanFill', { ...idleTasks(), scan: { active: true, progress: { status: 'scanning', current: 10, total: 100, pct: 42 }, queue: {} } }],
  ['缩略图补全', 'taskThumbFill', { ...idleTasks(), thumbs: { running: true, phase: 'ready', done: 10, total: 100, pct: 42 } }],
  ['缩略图重建', 'taskThumbRebuildFill', { ...idleTasks(), thumbRebuild: { running: true, phase: 'draining', done: 10, total: 100, pct: 42 } }],
  ['无效清理', 'taskInvalidCleanupFill', { ...idleTasks(), invalidCleanup: { running: true, checked: 10, total: 100, pct: 42 } }],
  ['查重指纹', 'taskDupHashFill', { ...idleTasks(), duplicateHash: { running: true, done: 10, total: 100, pct: 42 } }],
];
for (const [label, fillId, tasks] of PCT_CASES) {
  render(tasks);
  assert.equal(
    node(fillId).style.width,
    '42%',
    label + '：条子宽度必须来自主进程的 `pct`（10 / 100 就地相除会算出 10%）',
  );
}
// AI 两节走的是 `<progress>` 之外的计数行，百分比只在文字里 ⇒ 单独验一行
global.document.documentElement.lang = 'zh-CN';
render({
  ...idleTasks(),
  semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 100, pct: 42 },
});
assert.match(node('taskSemanticCount').textContent, /42%/, '搜图计数行的百分比也必须来自 `pct`');

// ---------------------------------------------------------------------------
// ②b tag 倒排（第二路）的计数行：独立字段 + 独立百分比
// ---------------------------------------------------------------------------
/**
 * 2026-10-08 用户报「需要看到 tag 完成计数」。
 *
 * 缺口现场：老库上 CLIP 索引早已建完 ⇒ CLIP 那趟几秒过完，之后**几十小时**全在补打标，
 * 而面板主行停在「完成 0」、进度条不动、文件名与速率全空 —— 看上去完全是死的。
 * 修法 = 主行之外再加一条**并列**的计数行（`#taskSemanticTagCount`），数据源是 worker 的
 * `tag*` 前缀字段（父进程 `Object.assign` 合并的**共享**槽，见 `docs/contracts/joytag-index.md` §10）。
 *
 * ⚠️ 上面 §2 最后那条用例里的 `operation: 'tag'` 是**另一件事**（CLIP 零样本标签的补算，
 *    走 `done/total`）；这里说的是 **JoyTag 倒排**（走 `tag*`）。名字撞车，别混。
 *
 * ⚠️ 喂的 `tagPct` **刻意与 `tagDone / tagTotal` 不符**（12 / 24 就地相除 = 50%）。
 *    百分比必须来自主进程派生的那个值（契约 §1.1）—— 与 §2 给 `pct: 42` 是同一招：
 *    两个算法数值一致时，「读派生值」与「就地相除」的产出相同，那条断言就没有牙。
 */
global.document.documentElement.lang = 'zh-CN';
const tagRow = () => node('taskSemanticTagCount').textContent;
render({
  ...idleTasks(),
  semantic: {
    running: true,
    operation: 'index',
    phase: 'indexing',
    done: 1,
    total: 2,
    pct: 50,
    tagStage: 'tags',
    tagDone: 12,
    tagTotal: 24,
    tagFailed: 0,
    tagPct: 42,
    tagCountPhase: 'ready',
  },
});
assert.match(tagRow(), /12/, '②b tag 计数行必须报出已打标张数');
assert.match(tagRow(), /24/, '②b tag 计数行必须报出待打标分母');
assert.match(tagRow(), /42%/, '②b 🔴 tag 的百分比必须读主进程派生的 `tagPct`（12 / 24 就地相除 = 50%）');
assert.match(tagRow(), /约/, '②b tag 的分母是跨库估计值 ⇒ 必须带「约」（与主行 `totalEstimated` 同一条规矩）');
assert.notEqual(
  node('taskSemanticCount').textContent,
  tagRow(),
  '②b 两行必须是两个不同的数（若打标的数字串进主行，两行会变成同一份文案 = 分母互相盖掉）',
);

/**
 * 反例①：**没有 tag 活动时这一格必须为空**。
 *
 * ⚠️ 这里必须喂「`tagStage` 为 `null` 但 `tag*` 有**残留读数**」——
 *    第一版用例只喂了「字段全是 0」，那样**没有牙**：字段全 0 时各分支自然产出空串，
 *    把 `if (tagStage)` 那道门整条删掉（改成 `if (true)`）守护照样绿（实测）。
 *    而这道门存在的理由恰恰是**残留读数**这个真实形状：
 *    `state` 是主进程逐轮重置的（`semantic-search.js`），但渲染端**不该依赖对方没漏**
 *    —— 一旦那边漏一个字段，上一轮的「12 / 约 24」就会挂在新任务的进度里，不报错。
 */
render({
  ...idleTasks(),
  semantic: {
    running: true,
    operation: 'index',
    phase: 'indexing',
    done: 1,
    total: 2,
    pct: 50,
    tagStage: null,
    tagDone: 12,
    tagTotal: 24,
    tagFailed: 0,
    tagPct: 42,
    tagCountPhase: 'ready',
  },
});
assert.equal(
  tagRow(),
  '',
  '②b 反例①：`tagStage` 为空时这一格必须清空 —— 残留读数（12 / 约 24）不许挂在新任务的进度里',
);

/** 反例②：分母还没估出来时，**已打标张数仍要显示**，但不许出现百分比。 */
render({
  ...idleTasks(),
  semantic: {
    running: true,
    operation: 'index',
    phase: 'indexing',
    done: 0,
    total: 0,
    pct: 0,
    tagStage: 'tags',
    tagDone: 7,
    tagTotal: 0,
    tagFailed: 0,
    tagPct: 0,
    tagCountPhase: 'counting',
  },
});
assert.match(tagRow(), /7/, '②b 反例②：分母还没估出来时也要报出已打标张数（否则那一段一片空白）');
assert.doesNotMatch(tagRow(), /%/, '②b 反例②：没有分母时不许出现百分比（分子就是全部信息量）');

/** 反例③：失败数只在 > 0 时追加 —— 与主行同一条规矩。 */
render({
  ...idleTasks(),
  semantic: {
    running: true,
    operation: 'index',
    phase: 'indexing',
    done: 0,
    total: 0,
    pct: 0,
    tagStage: 'tags',
    tagDone: 12,
    tagTotal: 24,
    tagFailed: 3,
    tagPct: 42,
    tagCountPhase: 'ready',
  },
});
assert.match(tagRow(), /失败 3/, '②b 反例③：失败数必须出现在 tag 行里（只报总数时，「跑 1000 张失败 900 张」与「全部成功」长得一样）');

// ---------------------------------------------------------------------------
// ③ `total = 0`（未知）一律画 0%，**不许拿 100% 当「完成」**
// ---------------------------------------------------------------------------

const ZERO_CASES = [
  ['缩略图补全', 'taskThumbFill', { ...idleTasks(), thumbs: { running: true, phase: 'ready', done: 0, total: 0, pct: computePct(0, 0) } }],
  ['无效清理', 'taskInvalidCleanupFill', { ...idleTasks(), invalidCleanup: { running: true, checked: 0, total: 0, pct: computePct(0, 0) } }],
  ['查重指纹', 'taskDupHashFill', { ...idleTasks(), duplicateHash: { running: true, done: 0, total: 0, pct: computePct(0, 0) } }],
];
for (const [label, fillId, tasks] of ZERO_CASES) {
  render(tasks);
  assert.equal(
    node(fillId).style.width,
    '0%',
    label + '：没有总数时必须画 0%（画 100% 会让「刚开始」和「已结束」长得一样，且 total 到位后会掉回去）',
  );
}

// ---------------------------------------------------------------------------
// ④ 静态面：或链、i18n 键、不许就地相除
// ---------------------------------------------------------------------------

const root = path.join(__dirname, '..');
function readSrc(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
/** 取 `@media` 块体（按括号配平 —— 非贪婪正则会截断在第一条子规则的 `}` 处）。
 *  与 `browse-grid-style-regression.js` 里那份同名同实现，两处都只服务各自的断言。 */
function mediaBlock(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, '源码里找不到 ' + header);
  const open = source.indexOf('{', start);
  assert.ok(open > start, header + ' 没有块体');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(header + ' 的块体没有闭合');
}
/** 取一条规则的声明体；`selectorRe` 要能匹配到 `{` 之前的整段选择器。 */
function cssRuleBody(source, selectorRe) {
  const match = new RegExp(selectorRe + '\\s*\\{([^{}]*)\\}').exec(source);
  assert.ok(match, '源码里找不到规则：' + selectorRe);
  return match[1];
}
/** AST 保偏移剥注释（正则版遇字符串里的 `//` 会截错行）。 */
function stripCommentsByAst(src) {
  const ranges = [];
  const collect = (_b, _t, start, end) => ranges.push([start, end]);
  try {
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', onComment: collect });
  } catch (_) {
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', onComment: collect });
  }
  let s = src;
  for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) {
    s = s.slice(0, a) + ' '.repeat(b - a) + s.slice(b);
  }
  return s;
}
function walkAst(n, fn) {
  if (!n || typeof n.type !== 'string') return;
  fn(n);
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach((x) => walkAst(x, fn));
    else if (v && typeof v === 'object') walkAst(v, fn);
  }
}
/**
 * 三个**顶层常量**放这里（而不是紧挨 ④b 的中文分析段）：④（键对账）要先用 `I18N_KEY_RE`，
 * 而它是 `const` ⇒ 放在后面会撞 **TDZ**（`Cannot access before initialization`）。
 */
/** 含 CJK 的字面量。 */
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
/** i18n 助手**显式名单**（另有一条形态启发式兜别名，见 `i18nHelperOf`）。 */
const I18N_HELPERS = new Set(['tui', 'tuiFmt', 'tUi', 'tUiFmt', 'tShell', 'tPeople', 'tSettings']);
/** i18n 键的形状：`a.b`（至少一个点）。 */
const I18N_KEY_RE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const flowSrc = stripCommentsByAst(readSrc('src/renderer/scan-flow.js'));
const ast = acorn.parse(flowSrc, { ecmaVersion: 'latest', sourceType: 'script' });
let panelBody = '';
let showPanelOperands = null;
walkAst(ast, (n) => {
  if (n.type !== 'FunctionDeclaration' || !n.id || n.id.name !== 'renderBackgroundTaskPanel') return;
  panelBody = flowSrc.slice(n.body.start, n.body.end);
  // 取 `var showPanel = A || B || …;` 的每个操作数（标识符）
  walkAst(n, (m) => {
    if (showPanelOperands) return;
    if (m.type !== 'VariableDeclarator' || !m.id || m.id.name !== 'showPanel') return;
    const names = [];
    let cur = m.init;
    while (cur && cur.type === 'LogicalExpression' && cur.operator === '||') {
      if (cur.right && cur.right.type === 'Identifier') names.push(cur.right.name);
      cur = cur.left;
    }
    if (cur && cur.type === 'Identifier') names.push(cur.name);
    showPanelOperands = names.reverse();
  });
});
assert.ok(panelBody.length > 0, '夹具自证：按 AST 切出了 renderBackgroundTaskPanel（切不出来后面全是空断言）');
assert.ok(Array.isArray(showPanelOperands) && showPanelOperands.length > 0, '夹具自证：解析出 showPanel 的或链');

/**
 * 🔴 **写面板文案的函数有「三个面」，不是一个。**
 *   ① `renderBackgroundTaskPanel`（轮询重绘，每拍一次）；
 *   ② `updateProgress`（**扫描快路径**：worker 每推一次进度就写一次 `taskScanText` /
 *      `taskScanFile`，比轮询快得多）；
 *   ③ `doScanFolder`（扫描入口：起手把「准备中...」写进文件行、收尾把「已清理 N 条」写进去）。
 * 只盯 ① 的后果是**只改一半**：扫描期间显示英文、下一拍轮询又退回中文，或者反过来。
 * 这里把三个函数体都切出来，供 ④（键扫描面）与 ④b（零裸中文）共用。
 */
const SCAN_FLOW_TEXT_FNS = ['renderBackgroundTaskPanel', 'updateProgress', 'doScanFolder'];
const flowTextRanges = [];
walkAst(ast, (n) => {
  if (n.type === 'FunctionDeclaration' && n.id && SCAN_FLOW_TEXT_FNS.includes(n.id.name))
    flowTextRanges.push([n.body.start, n.body.end, n.id.name]);
});
assert.equal(
  flowTextRanges.length,
  SCAN_FLOW_TEXT_FNS.length,
  '夹具自证：扫描节的三个文案面都切到了（切不出来 ⇒ 后面的断言会静默空转）—— 实得 ' +
    flowTextRanges.map((r) => r[2]).join(' / '),
);
const flowTextBody = {};
for (const [lo, hi, name] of flowTextRanges) flowTextBody[name] = flowSrc.slice(lo, hi);

/**
 * 🔴 ④b ①（零裸中文）的作用域 = **扫描节这一块**，刻意**不是**整个 `renderBackgroundTaskPanel`。
 *
 * 那个函数同时渲染 8 节（人脸 / 语义 / 补全 / 重建 / 无效清理 / 查重 / 优化 / 扫描），
 * 拿整个函数体当作用域时，**其余各节的存量裸中文会替本节把断言顶红** —— 本轮实测 6 条：
 *   · 两节标题的**具名兜底属性** `titleZh: '人脸模型 / 索引'` / `'AI 模型 / 索引'`
 *     （配 `titleKey` 使用，形式虽异但语义与 `tuiFmt` 第三参同族 ⇒ 合规）；
 *   · 重建那四项 `['task.thumbDetailSized', n, '原图尺寸 +']`：兜底串**先存进数组、循环里才
 *     喂给 `tuiFmt(rfItem[0], {…}, rfItem[2] + rfN)`** —— 父链从 `Literal` 上去是
 *     `ArrayExpression → VariableDeclarator` 就断了（`TRANSPARENT_NODES` 能穿 `ArrayExpression`，
 *     但穿不过「先赋给变量、稍后才用」这层**跨语句的间接引用**）⇒ 判据够不到。
 *
 * 硬把它们塞进豁免清单两条路都错：放宽判据 = 「间接引用」也可以夹带真硬编码；逐个加白名单
 * = 每节 i18n 化前都要先来打补丁。**判据的正确粒度 = 本次改动的范围** —— 本节只负责扫描节，
 * 其余各节将来 i18n 化时各自往这里加区间。
 *
 * `showScanBlock` 的 `consequent` 在 AST 里就是一个 `BlockStatement`，取它的 `[start,end]`
 * 属**结构性**切块（行号窗口法会一改就假红/假绿，本仓禁）。⚠️ 同函数下游还有个
 * `if (!showScanBlock) {…}`（其余节的互补块），靠 `test.type === 'Identifier'` 排除。
 */
const SCAN_TEXT_SCOPES = flowTextRanges.filter((r) => r[2] !== 'renderBackgroundTaskPanel');
let scanBlockRange = null;
walkAst(ast, (n) => {
  if (scanBlockRange) return;
  if (n.type !== 'IfStatement') return;
  if (!n.test || n.test.type !== 'Identifier' || n.test.name !== 'showScanBlock') return;
  if (!n.consequent || n.consequent.type !== 'BlockStatement') return;
  scanBlockRange = [n.consequent.start, n.consequent.end, 'renderBackgroundTaskPanel:scanBlock'];
});
assert.ok(
  scanBlockRange,
  '夹具自证：`renderBackgroundTaskPanel` 里找不到 `if (showScanBlock) {…}` 的块体' +
    '（改名/重构 ⇒ 这里要跟着改，否则断言静默空转）',
);
SCAN_TEXT_SCOPES.push(scanBlockRange);
assert.equal(
  SCAN_TEXT_SCOPES.length,
  3,
  '夹具自证：④b ① 必须覆盖「扫描快路径 + 扫描入口 + 面板扫描节块」三处 —— 实得 ' +
    SCAN_TEXT_SCOPES.length +
    '（' +
    SCAN_TEXT_SCOPES.map((r) => r[2]).join(' / ') +
    '）',
);
const scanBlockSrc = flowSrc.slice(scanBlockRange[0], scanBlockRange[1]);
assert.ok(
  scanBlockSrc.includes('task.scanRunning'),
  '夹具自证：切出来的扫描节块里应当含 `task.scanRunning`（不含 ⇒ 切错块，断言会静默空转）' +
    '—— 实测块长 ' +
    scanBlockSrc.length +
    ' 字符',
);

/**
 * 🔴 **或链的完整性**必须一条一条对着这张表查：新增一个后台任务时最容易漏的就是它，
 * 而漏了之后「只剩它自己在跑」= 整块面板连标题一起消失，用户完全看不到正在跑的长任务。
 */
for (const [label, showVar] of SECTIONS) {
  assert.ok(
    showPanelOperands.includes(showVar),
    '`showPanel` 的或链里必须有 `' + showVar + '`（' + label + '）—— 漏了 ⇒ 只剩它跑时整块面板消失',
  );
}

/** 面板里不许再出现「就地相除」算百分比：唯一来源是主进程 `main/progress-pct.js`。 */
assert.ok(
  !/Math\.round\s*\(\s*\([^()]*\/[^()]*\)\s*\*\s*100/.test(panelBody),
  '面板里不许出现 `Math.round((a / b) * 100)`：百分比唯一来源在主进程 `progress-pct.js`',
);

/**
 * 🔴 **界面引用到的每一个 i18n 键，都必须中英成对。**
 * 缺一边的后果都不报错：中文包缺 ⇒ 静默回落读中文包；**英文包缺 ⇒ `t()` 回落中文包**
 * ⇒ 英文界面混进中文，而「英文界面零 CJK」那类断言只覆盖**跑到的路径**、覆盖不到全部词条。
 *
 * ⚠️ 扫描面必须覆盖**每一个会写文案的地方**（见上面那段）：`panelBody` +
 * `updateProgress`（快路径）+ `doScanFolder`（扫描入口）+ **整个 `app.js`**
 * （五处 `updateProgress` 的第三参落在文件行、两处 `appAlert` 是扫描失败提示 ——
 * 它们都不在 `panelBody` 里）。
 * 只扫 `panelBody` 时，**在快路径里新加的键不会被这条断言覆盖** ⇒ 英文包漏一条也没人报。
 * `doScanFolder` 同理，且它更隐蔽：`task.scanDoneCleaned` / `task.scanPaused` 这类键
 * **只在这里出现**（`app.js` 里没有），漏掉它 = 那几条新词条的英文包缺失无人报警。
 *
 * 🔴🔴 **采集方式必须两条并集**（2026-10-08 扩 `app.js` 全域文案时补）：
 *   ① **文本面** —— 在这三段的源码文本里找 `'task.*'` / `'settings.task.*'` 字面量。
 *      它**不限位置**，所以能抓到 `titleKey: 'task.faceTitle'` 这种「当属性值存起来、
 *      稍后才消费」的键（`scan-flow.js` 的 AI 两节就是这形状）。
 *   ② **调用面**（AST）—— `app.js` 里**所有** i18n 助手的第一个实参若为点号键字面量，收进集合。
 *      ⚠️ **缺了它就是一整片盲区**：文本面那条正则的前缀限死在 `(?:task|settings\.task)`
 *      ⇒ `sidebar.` / `preview.` / `path.` / `dialog.` / `common.` / `theme.` / 非 task 的
 *      `settings.` 键**全部不在扫描面里**。本批扩全域文案时新加 30+ 个这样的键，
 *      全靠**注入用例 T4 才发现**（删掉 `preview.similarNoneFound` 的英文包，④ 组照样绿）。
 *      为什么文本面不干脆也放开前缀：放开后 `'photo.jpg'` / `'application/json'` / `'image.png'`
 *      这类**非 i18n 的点号串**会大批涌入 ⇒ 假阳性。走调用面就没有这个问题 ——
 *      键出现在 i18n 助手的实参位置上，本身就是「这是词条」的证据。
 */
const appSource = stripCommentsByAst(readSrc('src/renderer/app.js'));
const appAst = acorn.parse(appSource, { ecmaVersion: 'latest', sourceType: 'script' });
const keyScanSrc = panelBody + flowTextBody.updateProgress + flowTextBody.doScanFolder + appSource;
const usedKeys = new Set(
  [...keyScanSrc.matchAll(/'((?:task|settings\.task)\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]),
);
// ② 调用面：不限命名空间
walkAst(appAst, (n) => {
  if (n.type !== 'CallExpression' || !i18nHelperOf(n)) return;
  const a0 = n.arguments && n.arguments[0];
  if (a0 && a0.type === 'Literal' && typeof a0.value === 'string' && I18N_KEY_RE.test(a0.value))
    usedKeys.add(a0.value);
});
assert.ok(usedKeys.size > 0, '夹具自证：从面板与 `app.js` 里提到了 i18n 键（提不到说明正则/助手判定过期了）');
const i18nSrc = stripCommentsByAst(readSrc('src/renderer/i18n.js'));
const missing = [];
for (const key of usedKeys) {
  const n = (i18nSrc.match(new RegExp("'" + key.replace(/\./g, '\\.') + "':", 'g')) || []).length;
  if (n !== 2) missing.push(key + '（' + n + ' 条）');
}
assert.equal(
  missing.length,
  0,
  '面板引用的词条必须中英各一条，缺/多的：' + missing.join('、'),
);

// ---------------------------------------------------------------------------
// ④b 扫描节状态 / 收尾文案：**零裸中文**（英文界面不许露中文）
// ---------------------------------------------------------------------------
/**
 * 🔴 这条钉的是一个**只有切到英文界面才看得见**的失败：裸中文字面量在中文界面下与
 *    走 i18n 的结果**逐字相同** ⇒ 中文用例全绿、代码审查也看不出异常。
 *    （本仓的英文用例只覆盖「跑到的路径」，覆盖不到这七条状态文案 —— 它们要等主进程
 *      真的报出 `paused` / `enumerating` / `error` / 排队态才会渲染。）
 *
 * 判据 = 剥注释后取**真正的字符串字面量**，凡含 CJK 的必须落在 i18n 助手的实参里
 *    （那串就是中文兜底串，合规）。留在外面的 = 硬编码。
 *
 * ⚠️ 四个本轮踩出来的坑，直接决定这条判据对不对：
 *   ① 「是否落在 i18n 调用里」必须**沿父链向上找第一个不可穿越的祖先** ——
 *      `tuiFmt(key, {…}, '完成 ' + n + '（' + pct + '%）')` 里那串中文是**拼接表达式**，
 *      父链是 `BinaryExpression > … > CallExpression`。只看父/祖父节点 ⇒ 合规兜底串集体误判
 *      （本轮实测假阳性 80+ 条，差点照着错读数去改）。
 *   ② 助手名必须**显式列举**：我第一版写 `/^t[A-Z]/`，它匹配不到 `tui`（第二个字母是小写）。
 *   ③ **作用域本身也会造假红**：容器（`renderBackgroundTaskPanel`）里有 8 节，拿整个函数体
 *      当作用域时其余 7 节的存量裸中文替本节把断言顶红 ⇒ 只能被人拔牙。详见 `SCAN_TEXT_SCOPES`。
 *   ④ **光列举助手名还不够，还得认别名**：`app.js` 里 `var tR = typeof tUi === 'function' ? tUi : …`
 *      是局部别名，`tR('preview.winRestore', '还原窗口')` 完全合规 —— 只认名单 ⇒ **假红 4 条**
 *      （本轮扩到全域时立刻撞上）。现在用 `i18nHelperOf` 双轨：名单 + 形态启发式。
 *   📌 另有一条**兼容形状**（不是坑，是既成事实）：具名兜底表与降级实现，见
 *      `i18nFallbackShapeOf`，它们只在 ④c（全域总闸）里需要。
 */
const TRANSPARENT_NODES = new Set([
  'BinaryExpression',
  'LogicalExpression',
  'ConditionalExpression',
  'TemplateLiteral',
  'ParenthesizedExpression',
  'UnaryExpression',
  'ArrayExpression',
  'ObjectExpression',
  'Property',
]);

/**
 * 🔴 判「这个调用是不是 i18n 助手」用**双轨**，缺一不可：
 *   ① 显式名单（上面那个 `Set`）；
 *   ② **形态启发式**：callee 是 `t` 开头的短名 + **第一个实参是含点的字符串键**（`'a.b'`）。
 *
 * 为什么要 ②（2026-10-08 实测，扩到 `app.js` 全域时立刻撞上）：本仓有**局部别名** ——
 * `app.js` 里 `var tR = typeof tUi === 'function' ? tUi : function (_k, z) { return z; };`
 * 于是 `tR('preview.winRestore', '还原窗口')` 是**完全合规**的兜底串，只认名单的判据把它
 * 报成硬编码 = **假红**（4 条）。这与「`/^t[A-Z]/` 匹配不到 `tui`」是同一族坑的升级版：
 * **光列举名单不够，还得认别名 / 包装** —— 否则每加一个别名就要回来打一次补丁。
 * ⚠️ 形态启发式不会假绿：真有硬编码不会长成 `foo('a.b', '中文')` 这个形状（第一实参是点号键、
 *    中文又落在实参里 —— 那本来就是 i18n 的调用形态）。
 */
function i18nHelperOf(call) {
  const c = call && call.callee;
  if (!c) return null;
  const nm = c.type === 'Identifier' ? c.name : c.property && c.property.name;
  if (!nm) return null;
  if (I18N_HELPERS.has(nm)) return nm;
  const a0 = call.arguments && call.arguments[0];
  if (
    /^t[A-Za-z_]*$/.test(nm) &&
    a0 &&
    a0.type === 'Literal' &&
    typeof a0.value === 'string' &&
    I18N_KEY_RE.test(a0.value)
  )
    return nm;
  return null;
}

/**
 * 两条**合规但不走 i18n 调用**的形状（只有 `app.js` 全域那组需要；本仓实测各 1 处）：
 *
 * ① **具名兜底表** —— `'path.crumbRoot': '所有目录'` 这类「i18n 键 → 中文兜底」的对象字面量
 *    （`PATH_CRUMBS_ZH` / `NAV_HISTORY_ZH`；`scan-flow.js` 里同族的还有 `titleZh: '人脸模型 / 索引'`）。
 *    消费者拿到的是「键 + 兜底」，与 `tUiFmt` 第三参**同义** ⇒ 合规。判据 = 属性名是**点号键**。
 * ② **降级实现** —— `var f = RendererUtils.f || function () { … '月' … }`。`||` 右侧那份
 *    **永不执行**（`utils.js` 先于 `app.js` 加载并定义它）⇒ 属**死代码里的硬编码**。
 *    为什么不顺手 i18n 化：日期在英文下要的是 `Oct 8` / `Thu`，**不是词条置换能解决的**
 *    （语序与月份名都得变）⇒ 归「日期本地化」独立主题，见契约 §6.1。
 *
 * ⚠️ **遇到函数边界必须停**：否则 `var T = { 'a.b': function () { return '硬编码'; } }` 这种
 *    形状会被外层那个点号键豁免掉 = 假绿。判据取「`||` 右侧的匿名函数」这个**结构**，
 *    不是行号窗口。
 */
function i18nFallbackShapeOf(stack) {
  for (let i = stack.length - 2; i >= 0; i -= 1) {
    const n = stack[i];
    const par = stack[i - 1];
    if (n.type === 'Property' && n.key) {
      const k = n.key.type === 'Literal' ? n.key.value : n.key.name;
      if (typeof k === 'string' && I18N_KEY_RE.test(k)) return '具名兜底表';
    }
    if (
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'FunctionDeclaration'
    ) {
      if (par && par.type === 'LogicalExpression' && par.operator === '||' && par.right === n)
        return '降级实现';
      return null; // 函数边界：不许跨出去把内层的硬编码豁免掉
    }
  }
  return null;
}

function cjkLiterals(tree) {
  const hits = [];
  const stack = [];
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    stack.push(n);
    if (n.type === 'Literal' && typeof n.value === 'string' && CJK_RE.test(n.value)) {
      let via = null;
      for (let i = stack.length - 2; i >= 0; i -= 1) {
        const t = stack[i].type;
        if (TRANSPARENT_NODES.has(t)) continue;
        if (t === 'CallExpression' || t === 'NewExpression') via = i18nHelperOf(stack[i]);
        break;
      }
      hits.push({
        start: n.start,
        end: n.end,
        value: n.value,
        via: via,
        exempt: via ? null : i18nFallbackShapeOf(stack),
      });
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === 'object') walk(v);
    }
    stack.pop();
  })(tree);
  return hits;
}
/** 裸中文 = 既不在 i18n 调用里、也不落在两条合规形状里。 */
const isBare = (h) => !h.via && !h.exempt;
const bareCjkIn = (hits, ranges) =>
  hits.filter((h) => isBare(h) && ranges.some(([lo, hi]) => h.start >= lo && h.end <= hi));
const describeCjk = (rows) =>
  rows.length + ' 条：' + rows.map((h) => '「' + h.value.slice(0, 24) + '」').join('、');

// ① scan-flow.js：扫描节三处文案面（扫描快路径 / 扫描入口 / 面板 `if (showScanBlock)` 块体）
//    ⚠️ 作用域取 `SCAN_TEXT_SCOPES` 而**不是** `flowTextRanges`（后者含整个
//    `renderBackgroundTaskPanel`，其余 7 节的存量裸中文会把这条顶红）—— 理由见上面那段。
const flowBare = bareCjkIn(cjkLiterals(ast), SCAN_TEXT_SCOPES);
assert.equal(
  flowBare.length,
  0,
  '🔴 扫描节的状态行 / 文件行文案必须全部走 i18n（中文兜底串），实测仍有裸中文字面量 —— ' +
    describeCjk(flowBare) +
    '。她们会在**英文界面显示中文**，而中文界面逐字相同 ⇒ 只有英文用例能发现。',
);

/**
 * ② app.js：只覆盖**扫描相关的 4 个函数**里的 `updateProgress(...)` / `appAlert(...)` 实参区间。
 *    范围**刻意不扩到整个 app.js**：面板之外的应用界面文案（侧栏 / 路径栏 / 其它弹窗，
 *    实测 68 条）属另一个主题，见契约 §6.1。
 *    ⚠️ 判据取「调用实参」而不是「含 `task.*` 键的调用」—— 后者在**回退**时就失效了
 *    （回退成裸中文 ⇒ 没有 `task.*` 键 ⇒ 该处不被扫描 ⇒ 断言照样绿）。
 */
const APP_SCAN_FNS = [
  'registerRuntimeApiListeners',
  'handleAddFolder',
  'handleSettingsRescan',
  'handleSettingsRescanAll',
];
const APP_MSG_CALLS = new Set(['updateProgress', 'appAlert']);
const appFnRanges = [];
walkAst(appAst, (n) => {
  if (n.type === 'FunctionDeclaration' && n.id && APP_SCAN_FNS.includes(n.id.name))
    appFnRanges.push([n.body.start, n.body.end, n.id.name]);
});
assert.equal(
  appFnRanges.length,
  APP_SCAN_FNS.length,
  '夹具自证：app.js 里扫描相关的函数体要**全部**切到（改名/搬家就要一起改这里，' +
    '否则断言会静默缩小覆盖面）—— 期望 ' +
    APP_SCAN_FNS.join(' / ') +
    '，实得 ' +
    appFnRanges.map((r) => r[2]).join(' / '),
);
const appMsgRanges = [];
walkAst(appAst, (n) => {
  if (n.type !== 'CallExpression' || !n.arguments || n.arguments.length === 0) return;
  const c = n.callee;
  const nm = c && (c.type === 'Identifier' ? c.name : c.property && c.property.name);
  if (!nm || !APP_MSG_CALLS.has(nm)) return;
  if (!appFnRanges.some(([lo, hi]) => n.start >= lo && n.end <= hi)) return;
  appMsgRanges.push([n.arguments[0].start, n.arguments[n.arguments.length - 1].end, nm]);
});
assert.ok(
  appMsgRanges.length >= 12,
  '夹具自证：取到扫描收尾消息的调用实参（基线 13 个 —— 明显变少说明调用形状变了，' +
    '断言会静默缩小覆盖面）—— 实得 ' +
    appMsgRanges.length,
);
const appBare = bareCjkIn(cjkLiterals(appAst), appMsgRanges);
assert.equal(
  appBare.length,
  0,
  '🔴 扫描相关的 `updateProgress(...)` / `appAlert(...)` 实参必须全部走 i18n —— 实测仍有裸中文：' +
    describeCjk(appBare) +
    '。`updateProgress` 的第三参落在**文件行**，`appAlert` 是扫描失败提示，两者英文界面都会露中文。',
);

// ---------------------------------------------------------------------------
// ④c 静态面：整个 `app.js` **零裸中文**（总闸）
// ---------------------------------------------------------------------------
/**
 * ④b 只守「扫描相关 4 个函数里的调用实参」—— 那是**精确锚**（将来 `app.js` 被拆成多文件时，
 * 它按函数名定位、仍守得住）。这里再加一道**总闸**：整个文件不许有裸中文字面量。
 *
 * 2026-10-08 实测：把 50 条用户可见文案（弹窗按钮 / 确认正文 / 加载与失败态 / 相似图查找 /
 * 设置项保存失败 / 全屏与预览提示 / 分隔符）全部 i18n 化后，全域只剩 **18 条**，且
 * **全部**落在那两条合规形状里（具名兜底表 9 + 降级实现 9）⇒ 本断言为 0。
 *
 * ⚠️ 唯一性/完整性靠什么保证：`app.js` 是**单文件**兜底 —— 它的用途是「以后有人新加一条
 * 硬编码中文，无论加在哪个函数里都会被抓住」。新加的文件要靠各自的守护（本仓的
 * `web-asset-route-regression` 那类还会管「新文件有没有登记」）。
 */
const appAllHits = cjkLiterals(appAst);
const appAllBare = appAllHits.filter(isBare);
assert.equal(
  appAllBare.length,
  0,
  '🔴 `app.js` 全域不许再有裸中文字面量（英文界面会显示中文）—— 实测 ' +
    describeCjk(appAllBare) +
    '。合规的只有两条形状：「具名兜底表（属性名是点号键）」与「`||` 右侧的降级实现」，' +
    '其余一律走 `tUi` / `tUiFmt`（并同步 `i18n.js` 中英两包）。',
);
/**
 * 夹具自证：两条豁免形状必须**真的命中**东西 —— 一条都不命中说明豁免规则写错了
 * （写错 = 规则永不生效，将来真硬编码会被静默放过）。实测两条各 9 条 / 1 处。
 */
const appExemptKinds = new Set(appAllHits.filter((h) => h.exempt).map((h) => h.exempt));
assert.ok(
  appExemptKinds.has('具名兜底表') && appExemptKinds.has('降级实现'),
  '夹具自证：两条合规形状都要命中（具名兜底表 / 降级实现）—— 实得 ' +
    (appExemptKinds.size ? [...appExemptKinds].join('、') : '（一条都没有）'),
);

// ---------------------------------------------------------------------------
// ⑤ 元素 id 规范：`task<Name><Part>` + 两个方向的对账（HTML ↔ JS）
// ---------------------------------------------------------------------------

/**
 * 面板的元素 id 原先有 **7 种前缀**（`thumbProgress*` / `thumbRebuildTask*` /
 * `invalidCleanupProgress*` / `dupHashProgress*` / `optimizeTask*` / `faceTask*` / `semanticTask*`），
 * **外加扫描节 7 个裸 id**（`progressText` / `progressCount` / `progressFill` / `progressFile` /
 * `scanProgressEta` / `pauseResumeScanBtn` / `cancelScanBtn`）。
 *
 * ⚠️ 后者是**技术债的典型藏身处**：它们不在任何 `task*` 前缀清单里，
 *    所以**靠前缀 grep 盘点是整块漏掉的**。权威清单只能从面板区逐行取 id 得到。
 */
const htmlSrc = readSrc('src/renderer/index.html');
const htmlLines = htmlSrc.split('\n');
const panelLo = htmlLines.findIndex((l) => /id="taskPanel"/.test(l));
const panelHi = htmlLines.findIndex((l, i) => i > panelLo && /id="mobileBackdrop"/.test(l));
assert.ok(panelLo >= 0, '夹具自证：定位到 `#taskPanel` 容器');
assert.ok(panelHi > panelLo + 40, '夹具自证：定位到面板区下界（`#mobileBackdrop` 之前）');
const panelIds = [];
for (let i = panelLo; i < panelHi; i++)
  for (const m of htmlLines[i].matchAll(/id="([A-Za-z0-9_-]+)"/g))
    panelIds.push({ line: i + 1, id: m[1] });
assert.ok(
  panelIds.length >= 60,
  '夹具自证：面板区取到了 id（现在 ' + panelIds.length + ' 个，取不到说明上界锚点漂了）',
);
const panelIdSet = new Set(panelIds.map((r) => r.id));

/**
 * 🔴 判据是**白名单式的整体形状**，不是「不含那 7 个旧前缀」。
 *    黑名单对**第 8 种新前缀**照样绿 —— 而「又造一个名字」正是本工程反复发生的形状。
 *    词表 `Part` 见契约 §5（`Text` / `Pause` / `Cancel` / `Hash` / `Progress` / `Rate`
 *    是在落地时补进去的：扫描节需要暂停 / 取消，AI 两节用 `<progress>`，查重多一个指纹格）。
 */
const CONTAINER_RE = /^task(Panel|PanelToggleBtn|PanelToggleBar|PanelBody|QueueBadge)$/;
const SECTION_RE = /^task[A-Z][A-Za-z]*Section$/;
const PART = '(Title|Fill|Count|Detail|Eta|File|Stop|Settings|Error|Text|Pause|Cancel|Hash|Progress|Rate)';
const ELEMENT_RE = new RegExp('^task[A-Z][A-Za-z]*' + PART + '$');
const offenders = panelIds.filter(
  (r) => !CONTAINER_RE.test(r.id) && !SECTION_RE.test(r.id) && !ELEMENT_RE.test(r.id),
);
assert.equal(
  offenders.length,
  0,
  '面板区每个 id 都必须是 `task<Name><Part>`（或容器 / `task<Name>Section`）。不合规的：' +
    offenders.map((r) => r.line + ':' + r.id).join('、'),
);

/**
 * 方向 ①：**JS 引用的字面量 id 必须在 HTML 里存在**。
 *
 * 这是「HTML 改了、JS 没改」的唯一静态检出通道。`getElementById('拼错的 id')` 是**静默**的 ——
 * 取到 `null`、那一格永远空着，不报错也不写日志。
 * ⚠️ 只扫 `task*` 开头的（面板区以外的 id 归 `dead-reference-regression` 管，别在这里重复收口）；
 * ⚠️ 要认 `#` 前缀（`app.js` 里是 `$('#taskScanFill')`）。
 */
const JS_FILES = ['scan-flow.js', 'app.js', 'ui-events.js'];
const jsSources = JS_FILES.map((f) => stripCommentsByAst(readSrc('src/renderer/' + f)));
const litRefs = new Set();
for (const s of jsSources)
  for (const m of s.matchAll(/(?:getElementById|\$|bindClick)\(\s*'#?(task[A-Za-z0-9_-]*)'/g))
    litRefs.add(m[1]);
assert.ok(litRefs.size >= 20, '夹具自证：从渲染端提到了 `task*` 字面量 id（现在 ' + litRefs.size + ' 个）');
const dangling = [...litRefs].filter((id) => !panelIdSet.has(id));
assert.equal(
  dangling.length,
  0,
  '渲染端引用的每个 `task*` id 都必须在 index.html 里定义（取到 null 是静默的、不会报错）：' +
    dangling.join('、'),
);

/**
 * 方向 ②：**前缀本身也是 id 片段** —— 这是本轮真正漏掉过的那个形状。
 *
 * 人脸 / 搜图两节的元素不是按字面量取的，而是 `document.getElementById(aiTask.prefix + 'Title')`
 * 拼出来的。⇒ 统一 id 时，HTML 换成了 `taskFaceTitle`，而 `prefix` 还留着 `'faceTask'`，
 * 于是拼出 `faceTaskTitle`、取到 `null`：**方向 ① 查不到**（它只看字面量），
 * `dead-reference-regression` 也查不到（它解析不了拼接）——最后是**行为层**断言抓到的
 * （`faceTaskCount.textContent` 读到空串）。
 * ⇒ 这里补上静态通道：前缀必须合规范，且必须真的能拼出 HTML 里存在的 id。
 */
const prefixes = [...panelBody.matchAll(/prefix:\s*'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]);
assert.ok(prefixes.length >= 2, '夹具自证：面板里取到了 id 前缀（现在 ' + prefixes.length + ' 个）');
for (const p of prefixes) {
  assert.match(
    p,
    /^task[A-Z][A-Za-z]*$/,
    '前缀本身也是 id 片段，必须符合 `task<Name>`（旧写法 `faceTask` / `semanticTask` 会拼出旧 id）：' + p,
  );
  assert.ok(
    panelIdSet.has(p + 'Title'),
    '前缀 ' + p + ' 拼出来的 id 必须在 index.html 里存在（' + p + 'Title 缺失 ⇒ 取到 null、那一格永远空白）',
  );
}

/**
 * 方向 ③：**拼接出来的 id 也要双向对账**（HTML 定义 ↔ JS 取值）。
 *
 * 🔴 这一条是 2026-10-08 加 tag 计数行时补的，理由是上面方向 ① 有个先天盲区：
 *    `taskSemanticTagCount` 是 `aiTask.prefix + 'TagCount'` 拼出来的，
 *    **那个字面量在渲染端一次都不出现** ⇒ 方向 ① 的字面量对账看不见它。
 *    缺任何一半都是**静默空白**（HTML 少一个 div / JS 少一行取值，都不报错）。
 *    取不到节点时 `if (faceTagCount)` 会安静跳过，所以连行为层都抓不到「元素不存在」。
 *
 * ⚠️ 人脸节**刻意没有**这一格（tag 倒排是搜图那一路的第二条索引）⇒ 断言必须点名 Semantic，
 *    不能对两个前缀一视同仁地要求 `TagCount` 存在。
 */
assert.ok(
  panelIdSet.has('taskSemanticTagCount'),
  '搜图节的 tag 计数格必须在 index.html 里定义（拼接取 id ⇒ 字面量对账查不到，缺了就是静默空白）',
);
assert.ok(
  !panelIdSet.has('taskFaceTagCount'),
  '人脸节刻意**没有** tag 计数格 —— 补上它只会多一个永远空着的行（`tagStage` 只属于搜图那一路）',
);
assert.ok(
  /getElementById\(aiTask\.prefix \+ ['"]TagCount['"]\)/.test(panelBody),
  '渲染端必须真的去取 `prefix + \'TagCount\'`（HTML 有元素、JS 不取 = 那一格永远空白，正是本组要防的形状）',
);

/**
 * ⑤d **「预计剩余」行：每一个有进度条的分节都必须有**（2026-10-08 补的欠账）。
 *
 * 🔴 病因不是「忘了写」，是**判据从「有没有分母」变成了「能不能算」而没人回头看界面**：
 *    脸 / 搜图两节长期**没有分母**（连待办总数都不存在）⇒ 契约 §7 规定它们只报速率，
 *    于是这两节也就没建 `Eta` 格。后来加了**抽样估计分母**（`totalEstimated`）⇒ 分母有了、
 *    ETA 能算了，**面板元素却一直没补** —— 9 个任务里只有这两节没有「预计剩余」行。
 *    用户 2026-10-08 报的「不显示预计完成时间」就是这个欠账。
 *
 * ✅ 判据刻意写成**通用规则**而不是点名两个 id：凡是有进度条的分节，就必须有 `task<Name>Eta`。
 *    这样将来**新加一节**时，规则自动把它盖住；点名清单只会盖住「已知缺的那两个」。
 *    ⚠️ 「有进度条」要认**两种口径**：缩略图那三节与扫描 / 清理 / 查重是
 *       `div.progress-fill#task<Name>Fill`，而 AI 两节是**上古遗留的** `#task<Name>Progress`
 *       （它们当年用的是 `<progress>` 元素，§③ 把它换成了 `div`、**id 没跟着改**）。
 *       只认 `Fill` 会把这节判成「没有进度条」⇒ 规则**静默漏掉它**，正好漏在最该管的两节上。
 *    ⚠️ 唯一的例外**自动被规则排除**：`taskOptimizeSection` 两样都没有（它只有一行文字，
 *       契约 §11 记的已知例外）。所以这里不需要写例外清单 —— 写例外清单正是漂移的开始。
 */
const sectionNames = panelIds
  .map((r) => (r.id.match(/^task([A-Z][A-Za-z]*)Section$/) || [])[1])
  .filter(Boolean);
assert.ok(sectionNames.length >= 8, '夹具自证：面板区取到了分节（现在 ' + sectionNames.length + ' 个）');
const hasBar = (n) => panelIdSet.has('task' + n + 'Fill') || panelIdSet.has('task' + n + 'Progress');
const sectionsWithBar = sectionNames.filter(hasBar);
assert.ok(sectionsWithBar.length >= 7, '夹具自证：有进度条的分节（现在 ' + sectionsWithBar.length + ' 个）');
for (const n of ['Face', 'Semantic']) {
  assert.ok(
    sectionsWithBar.includes(n),
    '夹具自证：' + n + ' 节必须被认成「有进度条」（否则下面那条通用规则静默漏掉它）',
  );
}
const missingEta = sectionsWithBar.filter((n) => !panelIdSet.has('task' + n + 'Eta'));
assert.equal(
  missingEta.length,
  0,
  '有进度条的分节必须也有「预计剩余」格 `task<Name>Eta`（缺的那节在界面上少一项、不报错）：' +
    missingEta.map((n) => 'task' + n + 'Eta').join('、'),
);
// class 也要与其余各节一致（样式靠它：`styles.css` 的 `.task-panel .progress-eta`）
for (const n of ['Face', 'Semantic']) {
  const line = htmlLines.find((l) => l.includes('id="task' + n + 'Eta"')) || '';
  assert.match(
    line,
    /class="[^"]*\bprogress-eta\b/,
    'task' + n + 'Eta 的 class 里必须有 `progress-eta`（那是 `.task-panel .progress-eta` 的唯一钩子，掉了就与别节不同色）',
  );
}
// 渲染端必须真的去取并画（HTML 有元素、JS 不取 = 那一格永远空白，同前面两组要防的形状）
assert.ok(
  /getElementById\(aiTask\.prefix \+ ['"]Eta['"]\)/.test(panelBody),
  '渲染端必须真的去取 `prefix + \'Eta\'`',
);
assert.ok(
  /formatEtaLine\(aiTask\.state\.etaSeconds\)/.test(panelBody),
  'AI 两节的 ETA 必须走**共用助手** `formatEtaLine`（另写一套 = 七节的观感 / 双语化各走一套）',
);

/**
 * ⑤e ETA **值**由主进程派生 —— 渲染端不自己除（与 ② 的 `pct` 同一条规矩）。
 *
 * 钉两件事：① 派生点在 `main/semantic-search.js#status()`（桌面 IPC 与网页 API **共用**那个
 * 返回值 ⇒ 算两处必然漂）；② 用的是 `estimateEtaSecondsFromRate`（分子分母与 `ratePerMinute`
 * 同口径的那支），不是 `estimateEtaSecondsSmoothed`（那支要 `startedAt`，而这两个任务的
 * `startedAt` 在 worker 里、够不着；硬喂主进程的时刻 = 把 worker 起手 / 载模型的耗时算进速率）。
 */
const semanticSvcSrc = stripCommentsByAst(readSrc('src/main/semantic-search.js'));
assert.ok(
  /etaSeconds\s*=\s*estimateEtaSecondsFromRate\(/.test(semanticSvcSrc),
  'status() 必须用 `estimateEtaSecondsFromRate` 派生 `etaSeconds`（它是唯一的口径正确的那支）',
);
assert.ok(
  !/etaSeconds\s*=.*\b(done|total|ratePerMinute)\s*\/\s*\d/.test(semanticSvcSrc),
  '不许在 status() 里就地做除法（数值口径归 `main/eta.js`，与 `pct` 归 `progress-pct.js` 同一个规矩）',
);
assert.ok(
  !/Math\.round\s*\(\s*\([^()]*\/[^()]*\)\s*\*\s*100/.test(semanticSvcSrc),
  'status() 里不许出现就地百分比（这条是 ② 在主进程侧的镜像）',
);
/** 唯一真相源：那套算法只许住在 `main/eta.js`，`main.js` 里不许再长一份 */
const mainSrcForEta = readSrc('src/main.js');
assert.ok(
  /require\('\.\/main\/eta'\)/.test(mainSrcForEta),
  "main.js 必须从 `./main/eta` 取 ETA（在别处又写一份 = 两份判据必然漂）",
);
assert.ok(
  !/function estimateEtaSeconds(Smoothed)?\s*\(/.test(mainSrcForEta),
  'main.js 里不许再定义 ETA 求值函数（已搬进 `main/eta.js`，长回来就是两份判据）',
);

// ---------------------------------------------------------------------------
// ⑤f ETA 三个入口的**行为**（纯函数，直接 require `main/eta.js`）
// ---------------------------------------------------------------------------
const eta = require('../src/main/eta');
assert.equal(typeof eta.estimateEtaSecondsFromRate, 'function', 'main/eta.js 必须导出 `estimateEtaSecondsFromRate`');
// 边界：没分母 / 没速率 / 样本太少 ⇒ null（「还估不出来」，与下面的 0 刻意区分）
assert.equal(eta.estimateEtaSecondsFromRate(50, 0, 0, 60), null, '没分母（total=0）⇒ null');
assert.equal(eta.estimateEtaSecondsFromRate(50, 0, 1000, 0), null, '没速率 ⇒ null');
assert.equal(eta.estimateEtaSecondsFromRate(2, 0, 1000, 60), null, '只过了 2 件 ⇒ null（前段抖动大，不估）');
// 追平 ⇒ 0（「剩余的确实为 0」，与 null 不同）
assert.equal(eta.estimateEtaSecondsFromRate(1000, 0, 1000, 60), 0, '已追平 ⇒ 0');
// 正常：990 件待过，60 件/分 ⇒ 990 秒
assert.equal(
  eta.estimateEtaSecondsFromRate(10, 0, 1000, 60),
  990,
  '(1000 − 10) 件 ÷ 60 件/分 × 60 秒 = 990 秒',
);
/**
 * 🔴 **口径断言**（这条才是这个函数存在的理由）：
 *    速率的分子是 `done + failed` ⇒ 「还剩多少件要过一遍」也必须是 `total − (done + failed)`。
 *    若按 `total − done` 算，下面这组会得 990 而不是 900 —— **ETA 系统性偏大 10%**，
 *    而这两组数在界面上都不报错、只是「估得久了点」，没有这条断言根本发现不了。
 */
assert.equal(
  eta.estimateEtaSecondsFromRate(10, 90, 1000, 60),
  900,
  '失败的那些已经过了一遍（耗掉了时间）⇒ 剩余按 total − (done + failed) 算（按 total − done 会得 990）',
);
// 另两支搬过来之后仍要有牙（搬函数最怕「搬完其实换了个语义」）
assert.equal(eta.estimateEtaSeconds(0, 1, 10), null, 'estimateEtaSeconds：没 startedAt ⇒ null');
assert.equal(eta.estimateEtaSeconds(Date.now(), 1, 10), null, 'estimateEtaSeconds：刚开始（<800ms）⇒ null');
assert.equal(eta.estimateEtaSeconds(Date.now() - 10000, 10, 0), null, 'estimateEtaSeconds：没分母 ⇒ null');
assert.equal(eta.estimateEtaSeconds(Date.now() - 100000, 100, 50), 0, 'estimateEtaSeconds：done 反超 ⇒ 0');
assert.equal(
  eta.estimateEtaSecondsSmoothed('', Date.now(), 0, 10),
  null,
  'estimateEtaSecondsSmoothed：空 key 走无平滑分支（`done < 3` ⇒ null）',
);

/**
 * ⑤g **行为层**：把 `etaSeconds` 喂进去，两节各画一行；喂 `null` 必须**擦掉**上一轮的值。
 *
 * 🔴 第二条（擦掉）是关键：把 `el.textContent = formatEtaLine(v)` 改成
 *    `if (v) el.textContent = …` 之后，一个长期空闲 / 刚起手的任务会**停在上一轮那句话上**
 *    （「预计剩余约 2 天」挂在已经做完的任务上），而任何静态断言都看不出来。
 */
const ETA_CASES = [
  // [标签, 任务键, 分节前缀, 真实状态, 该画出来的整句]
  ['人脸', 'face', 'Face', { running: true, phase: 'indexing', done: 300, failed: 0, total: 1000, ratePerMinute: 60, etaSeconds: 700 }],
  ['搜图', 'semantic', 'Semantic', { running: true, operation: 'index', phase: 'indexing', done: 300, failed: 0, total: 2000, ratePerMinute: 30, etaSeconds: 3400 }],
];
// ⑥ 组的「副指标」会在同一轮渲染里写别的格子，所以这里逐个单独渲染、只读 ETA 那一格。
for (const [label, key, prefix, state] of ETA_CASES) {
  assert.match(String(state.etaSeconds), /^\d+$/, '夹具自证：' + label + ' 用例给了明确的 etaSeconds');
  global.window.I18n.setLocale('zh-CN', { skipMainSync: true });
  render({ ...idleTasks(), [key]: state });
  const txt = node('task' + prefix + 'Eta').textContent;
  assert.ok(txt !== '', label + '：有 `etaSeconds` 时「预计剩余」行必须有字（HTML 有格、渲染端不画 = 静默空白）');
  assert.match(txt, /^预计剩余约 /, label + '：走的是共用词条 `task.etaPrefix`（当前：' + JSON.stringify(txt) + '）');
  assert.ok(!/undefined|NaN/.test(txt), label + '：文案里不许漏出 undefined / NaN（' + JSON.stringify(txt) + '）');
  // 同一个任务**换成 null** ⇒ 上一轮那句话必须消失
  const cleared = { ...state, etaSeconds: null };
  render({ ...idleTasks(), [key]: cleared });
  assert.equal(
    node('task' + prefix + 'Eta').textContent,
    '',
    label + '：`etaSeconds` 变 null（还没估出来 / 刚起手）时必须**擦掉**上一轮的值（别写成 `if (v) …`）',
  );
  // 英文界面：这一行也得跟着切语言（它是共用助手，不该有裸中文）
  global.window.I18n.setLocale('en-US', { skipMainSync: true });
  render({ ...idleTasks(), [key]: state });
  const enTxt = node('task' + prefix + 'Eta').textContent;
  assert.match(enTxt, /^About .* left$/, label + '：英文界面必须走英文词条（当前：' + JSON.stringify(enTxt) + '）');
  assert.ok(!/[\u4e00-\u9fff]/.test(enTxt), label + '：英文界面零 CJK（当前：' + JSON.stringify(enTxt) + '）');
  global.window.I18n.setLocale('zh-CN', { skipMainSync: true });
}


// ---------------------------------------------------------------------------
// ⑥ 副指标「0」的判据：**两个任务刻意不同**（行为层，2026-10-08）
// ---------------------------------------------------------------------------
/**
 * 2026-10-08 用户报「重建缩微图，没有看到其他四项计数」。
 *
 * 定性：**不是 bug，是同一个判据被两件事共用了**。四项（原图尺寸 / 拍摄信息 / 视觉指纹 /
 * 查重指纹）的显示判据在「补全」那节是 `(thumbs.X || 0) > 0`，重建那节**照抄**了同一个 ——
 * 但两边的**候选集不同**：
 *   · 补全收「**缺**缩略图」的行 ⇒ 候选行天然也缺四样 ⇒ `> 0` 才画没问题（0 只可能是故障）；
 *   · 重建收「**有**缩略图、只是规格旧」的行，而这四样是**补全**（同样走主键倒序）**先**补的
 *     ⇒ 两个反序任务在**同一段高位 id 碰头** ⇒ 重建跑到那里时四样本来就齐。
 *     真库实测：队首段（id 1.30M–1.50M）每 3000 行只缺 1~14 行；**id ≈ 1.2M 是分界线**。
 * ⇒ 老判据在重建这边让四项**恒不显示**，用户分不清「这段无事可做」与「统计坏了」。
 *
 * ⚠️ 这一组**必须**是行为层：静态断言只能证明「代码里写了 `if (!rEnqueueing)`」，
 *    证明不了「四项全 0 时界面上真的多出那四个词」—— 而那正是用户报的东西。
 *    （本项目铁律：结构断言 ≠ 行为断言。）
 */
{
  /** 重建进行中、**四项全是 0**（= 真库高位段的真实形态）的夹具。 */
  const rebuildFour = (extra) =>
    Object.assign({}, idleTasks(), {
      thumbRebuild: Object.assign(
        {
          running: true,
          phase: 'draining',
          total: 200,
          done: 100,
          pct: 50,
          rebuiltThisRun: 5,
          pending: 100,
          sized: 0,
          exifFilled: 0,
          dhashed: 0,
          hashed: 0,
        },
        extra || {},
      ),
    });

  const FOUR = [
    ['原图尺寸 +0', 'sized'],
    ['拍摄信息 +0', 'exifFilled'],
    ['视觉指纹 +0', 'dhashed'],
    ['查重指纹 +0', 'hashed'],
  ];

  // 正面：抽干阶段 + 四项全 0 ⇒ 四个词**都必须出现**
  render(rebuildFour());
  const detailText = node('taskThumbRebuildDetail').textContent || '';
  assert.match(
    detailText,
    /本次已重出/,
    '夹具自证：重建那节的副行真的画出来了（否则下面全是「空串里不包含」的假绿）：' +
      JSON.stringify(detailText),
  );
  for (const [word, key] of FOUR) {
    assert.ok(
      detailText.indexOf(word) >= 0,
      '🔴 重建那节的副行在 `' +
        key +
        ' = 0` 时**也必须画出**「' +
        word +
        '」—— 这一段的四样本来就齐是**常态**（两个反序任务在同一段 id 碰头），' +
        '藏起来用户就分不清「无事可做」与「统计坏了」（2026-10-08 用户报「没有看到其他四项计数」）',
    );
  }

  // 反面：登记阶段**不许**画 —— 那时一张都还没重跑，四项的概念不适用
  render(rebuildFour({ phase: 'enqueueing', rebuiltThisRun: 0 }));
  const enqueueText = node('taskThumbRebuildDetail').textContent || '';
  for (const [word] of FOUR) {
    assert.ok(
      enqueueText.indexOf(word) < 0,
      '登记阶段（`phase = \'enqueueing\'`）不许画「' +
        word +
        '」—— 那时一张都还没重跑，报出来的是假数（与「登记阶段不给 ETA」同理）',
    );
  }

  // 反面：**补全那节不动** —— `thumbs.sized = 0` 时仍然不画（它的候选集让 0 只可能是故障）
  render(
    Object.assign({}, idleTasks(), {
      thumbs: {
        running: true,
        phase: 'ready',
        done: 10,
        total: 100,
        pct: 10,
        sized: 0,
        exifFilled: 0,
        dhashed: 0,
        hashed: 0,
      },
    }),
  );
  const thumbText = node('taskThumbDetail').textContent || '';
  assert.ok(
    thumbText.indexOf('原图尺寸') < 0,
    '补全那节**保持 `> 0` 判据**：`sized = 0` 时不许画「原图尺寸」' +
      '（它的候选集天然缺四样 ⇒ 0 只可能是故障，不该把 0 当正常值报）。' +
      '别为了「统一」把这两处改成一样 —— 它们刻意不同。',
  );
}

// ---------------------------------------------------------------------------
// ⑦ 形状收敛（2026-10-08）：停止按钮反馈 / 副行职责 / 进度条实现
// ---------------------------------------------------------------------------
/**
 * 2026-10-08「排查其他后台任务，列出每种任务的显示项」查出来的三处**跨节不一致**
 * （都是本守护的职责范围 —— 单看某一节都说得通，摆在一起才看出四种写法）：
 *
 *   ① **停止按钮**：扫描节（`handleCancelScan`）与人脸/搜图有「停止中」反馈，
 *      而补全 / 重建 / 查重那三个按钮**点完毫无变化**。根因不是缺数据 ——
 *      `cancelled` 一直是主进程在报（起手置 `false`、收到停止请求置 `true`），
 *      **渲染端零消费**，于是用户只能靠「任务什么时候消失」猜有没有生效（契约 §8 的最后一项）。
 *   ② **副行（`Detail`）**：补全 / 重建是「产出摘要」，查重拿指纹行当第二行、
 *      无效清理把摘要（`· 已删除 N 条`）**拼在文件行尾巴上**，AI 两节没有 —— 四节四种形状。
 *   ③ **进度条实现**：`div + .progress-fill` 五节 vs `<progress>` 两节。
 *
 * ⚠️ ①② 必须是**行为层**（真读 DOM 结果）：静态面只能证明「代码里写了 `syncStopButton(...)`」，
 *    证明不了「按钮真的被禁用、真的多出那行字」—— 而那正是用户要的。
 *    ③ 是形状约束，静态读 HTML 即可（且**反面**断言「不许再有 `<progress>`」）。
 */

// ① 三个缩略图类任务的停止按钮：判据 `running && cancelled`
{
  const CASES = [
    ['taskThumbStop', 'thumbs', { running: true, cancelled: true, phase: 'ready' }, '停止补全'],
    [
      'taskThumbRebuildStop',
      'thumbRebuild',
      { running: true, cancelled: true, phase: 'draining' },
      '停止重建',
    ],
    ['taskDupHashStop', 'duplicateHash', { running: true, cancelled: true, done: 1, total: 2 }, '停止'],
  ];
  for (const [id, key, state, idleLabel] of CASES) {
    // 正面：已请求停止 ⇒ 禁用 + 「停止中」
    render({ ...idleTasks(), [key]: state });
    assert.equal(
      node(id).disabled,
      true,
      id + '：`running && cancelled` 时必须禁用（防重复点，契约 §8）',
    );
    assert.match(
      node(id).textContent,
      /停止中/,
      id +
        '：必须给出「停止中」反馈。🔴 从前这三个按钮点完**毫无变化** —— `cancelled` 主进程一直在报、' +
        '渲染端没人读，用户只能靠「任务什么时候消失」猜停止有没有生效',
    );
    // 反面：没被取消 ⇒ 复原可点，且文案是它**自己的**语义（不是通用「停止」）
    render({ ...idleTasks(), [key]: { ...state, cancelled: false } });
    assert.equal(node(id).disabled, false, id + '：`cancelled = false` 时必须复原可点');
    assert.equal(
      node(id).textContent,
      idleLabel,
      id + '：复原后的文案要保留各按钮自己的语义（「停止补全」比「停止」有信息量）',
    );
  }
  // ⚠️ 判据必须**同时**看 `running`：`cancelled` 只在主进程起手时置回 `false`，
  //    单看它会让「上一轮被取消过」的任务一露头就顶着「停止中」+ 禁用。
  render({ ...idleTasks(), thumbs: { running: true, cancelled: false, phase: 'ready' } });
  assert.equal(
    node('taskThumbStop').disabled,
    false,
    '在跑但**没被取消**时不许禁用 —— 判据是 `running && cancelled`，不是只看 `cancelled`',
  );
  // 人脸 / 搜图那组走 `phase === 'stopping'`（它们的 `phase` 是任务阶段机，`stopping` 是合法值）
  render({ ...idleTasks(), face: { running: true, phase: 'stopping' } });
  assert.equal(node('taskFaceStop').disabled, true, 'AI 两节：`phase = \'stopping\'` 时按钮必须禁用');
  assert.match(node('taskFaceStop').textContent, /停止中/, 'AI 两节也要给「停止中」文案（从前只变灰、不改字）');
}

// ② 副行（`Detail`）职责收敛：它只说**产出**，文件行只说**文件**
{
  render({
    ...idleTasks(),
    duplicateHash: {
      running: true,
      done: 10,
      total: 100,
      pct: 10,
      hashed: 7,
      reused: 3,
      failed: 1,
      currentFile: 'a.jpg',
      currentHash: 'abcdef0123456789ff',
    },
  });
  const dupDetail = node('taskDupHashDetail').textContent || '';
  assert.match(
    dupDetail,
    /已算指纹/,
    '查重那节必须把 `hashed` 画出来 —— 主进程一直在报，界面**从来没有显示过**' +
      '（分子 `done` 只说「处理了多少行」，看不出其中多少是真算的、多少是复用现成指纹的）',
  );
  assert.match(dupDetail, /复用已有/, '查重那节必须把 `reused` 画出来');
  assert.ok(dupDetail.indexOf('失败') >= 0, '查重那节 `failed > 0` 时要画失败数');
  assert.match(node('taskDupHashHash').textContent, /当前编号/, '指纹行（明文编号）仍要在');
  // 反面：三个产出数全 0 ⇒ 不画（判据 `> 0`，与补全那节同族）
  render({
    ...idleTasks(),
    duplicateHash: { running: true, done: 0, total: 100, pct: 0, hashed: 0, reused: 0, failed: 0 },
  });
  assert.equal(
    node('taskDupHashDetail').textContent,
    '',
    '查重那节三个产出数全 0 时不画副行（判据 `> 0`：`done` 与它同族，起步那阵子 0 只表示「还没轮到」）',
  );

  render({
    ...idleTasks(),
    invalidCleanup: { running: true, checked: 5, total: 20, pct: 25, deleted: 3, currentFile: 'b.jpg' },
  });
  assert.match(
    node('taskInvalidCleanupDetail').textContent,
    /已删除 3 条/,
    '无效清理的「已删除 N 条」要落在**副行**上（`Detail` 说产出）',
  );
  assert.equal(node('taskInvalidCleanupFile').textContent, 'b.jpg', '文件行只说文件');
  // 🔴 反向：不许再拼回文件行 —— 文件行同时承担「正在处理哪个」与「一共删了多少」正是本轮收敛掉的形状。
  //    （用剥注释后的源码查：注释里会引用旧写法。）
  assert.ok(
    stripCommentsByAst(readSrc('src/renderer/scan-flow.js')).indexOf("' · 已删除 '") < 0,
    '🔴 「· 已删除 N 条」不许再拼回文件行（`taskInvalidCleanupFile`）—— ' +
      '那会让同一行背着两种语义；它现在归副行 `taskInvalidCleanupDetail`',
  );
  // `total` 还没到位时，计数行**只报「已检查 N」**：两条都报的话同一个数会在计数行与文件行各出现一次
  render({ ...idleTasks(), invalidCleanup: { running: true, checked: 5, total: 0, deleted: 3 } });
  const countNoTotal = node('taskInvalidCleanupCount').textContent || '';
  assert.match(countNoTotal, /已检查 5/, '`total = 0` 时计数行要报「已检查 N」');
  assert.ok(
    countNoTotal.indexOf('已删除') < 0,
    '`total = 0` 时计数行**不许**再报「已删除」—— 那个数归副行，两处都报就是同一个数出现两遍',
  );
}

// ③ 进度条：面板区一律 `div + .progress-fill`，不许再有 `<progress>`
{
  const html = readSrc('src/renderer/index.html');
  const lo = html.indexOf('id="taskPanel"');
  const hi = html.indexOf('id="mobileBackdrop"');
  assert.ok(lo >= 0 && hi > lo, '夹具自证：定位到面板区上下界');
  const panelHtml = html.slice(lo, hi);
  assert.ok(
    panelHtml.indexOf('<progress') < 0,
    '🔴 面板区不许再出现 `<progress>`：契约 §5 取 `div + .progress-fill`' +
      '（`<progress>` 在不同平台上长得不一样，圆角与主题变量都控不住）',
  );
  const fillCount = (panelHtml.match(/class="progress-fill"/g) || []).length;
  assert.equal(
    fillCount,
    7,
    '面板区应有 7 条 `.progress-fill`（扫描 / 补全 / 重建 / 无效清理 / 查重 / 人脸 / 搜图；' +
      '「优化数据库」没有进度条，是契约 §11 记的已知例外）—— 实得 ' +
      fillCount,
  );
  const css = readSrc('src/renderer/styles.css');
  /**
   * 🔴 判据必须要求**完整类名**：`indexOf('.progress-fill--indeterminate')` 对
   *    `.progress-fill--indeterminate-x { … }` **照样绿**（前者是后者的子串）——
   *    这是本项目的老形状（同 §10 的「`/thumbs\.sized/` 对 `if (thumbs.sizd > 0)` 照样绿」）。
   *    2026-10-08 的注入式牙齿验证（T5）实测抓到了这条假绿：把类名改成 `-x` 之后守护仍然 PASS。
   *    ⇒ 用正则要求「类名后不能再跟 `-` 或单词字符」。
   */
  assert.match(
    css,
    /\.progress-fill--indeterminate(?![-\w])/,
    '🔴 换掉 `<progress>` 之后，「在跑、但进度未知」这个语义必须由 `.progress-fill--indeterminate`' +
      '承担 —— `<progress>` 不带 `value` 时画的是动画条纹，而 `div` 的 `0%` 会被读成「进度就是 0」，' +
      '两者含义相反。别把不定态一起丢了。',
  );
  // ⚠️ 还要钉「渲染端用的是**同一个**类名」：CSS 定义了一份、JS 拼了另一个名字 = 静默不生效
  //    （样式规则永远不命中，界面只是一条不动的空槽，不报错）。
  assert.ok(
    flowSrc.indexOf("'progress-fill progress-fill--indeterminate'") >= 0,
    '渲染端要用**完整**的类名 `progress-fill progress-fill--indeterminate`（与 CSS 那份逐字一致）—— ' +
      '两处各拼一个名字的话样式静默不命中',
  );
  /**
   * 🔴 ⑥ 类还在 ≠ 它还在动：`@media (prefers-reduced-motion: reduce)` 里的全局 `*` 规则
   *    （`animation-duration: 0.01ms !important` + `animation-iteration-count: 1 !important`）
   *    会把它压成「跑 0.01ms 一次、`fill-mode` 又默认 `none` ⇒ 回落到基值」= **完全静止**。
   *
   *    为什么以前没暴露：旧元素是裸 `<progress>` 不带 value，它的条纹画在 **UA shadow tree 的
   *    伪元素**上，`*` 选择器**命中不到** ⇒ 全局压制对它无效。换成 `div` 之后动画落在普通元素上，
   *    正好落进压制范围。本机（Windows）实测 `prefers-reduced-motion` 恒为 `reduce`。
   *
   *    实测数据（同一页面、同一时刻，像素逐帧变化占比，ReduceLab 夹具）：
   *      reduce=true      · 旧 `<progress>` 7.29% · 新 `div` **0.00%**
   *      no-preference    · 旧 `<progress>` 7.29% · 新 `div` 3.82%
   *    两个「必须不动」的对照（`<progress value="40">`、静态 40% 条）两趟都是 0% ⇒ 采样可信。
   *    ⇒ 没有这条豁免，本机看到的是**静止的 40%** = 「进度 40%」这个**错误信息**，
   *      而真相是「在跑、进度未知」。
   *
   *    ⚠️ 断言必须取**这条豁免规则自己的声明体**，不能拿整个 `@media` 块去 match：
   *       块里还有加载圈那条 `animation-iteration-count: infinite !important`，
   *       拿整块匹配会**永远为真**（同 `browse-grid-style-regression` 的牙齿测试教训）。
   */
  const reduceBlock = mediaBlock(css, '@media (prefers-reduced-motion: reduce)');
  assert.match(
    reduceBlock,
    /\.progress-fill--indeterminate(?![-\w])/,
    '🔴 不定态必须穿过 reduced-motion 的全局压制：本机实测 `reduce = true`，不豁免就只有' +
      '一条静止的 40% 填充 —— 那读起来是「进度 40%」，是个**错误的确定值**。' +
      '旧 `<progress>` 因为画在 UA shadow 伪元素上而逃过了 `*`，换 `div` 之后就逃不掉了。',
  );
  const indetDecl = cssRuleBody(reduceBlock, '\\.progress-fill--indeterminate');
  assert.match(
    indetDecl,
    /animation-duration:\s*2\.4s\s*!important/,
    '豁免要把 duration 放回动画周期（留着 0.01ms 仍然一动不动）—— 取 2.4s（常态 1.4s）刻意放慢',
  );
  assert.match(
    indetDecl,
    /animation-iteration-count:\s*infinite\s*!important/,
    '豁免要 `infinite`：`iteration-count: 1` 跑完就回落到基值（`fill-mode` 默认 none）',
  );
  assert.match(
    indetDecl,
    /animation-name:\s*progressIndeterminate\s*!important/,
    '只放行**位移那一条**：`animation-name` 收窄成 `progressIndeterminate`，' +
      '把 `progressShimmer` 留在被压制态（少一层运动，语义不丢）',
  );
}

console.log('[background-tasks-panel-regression] PASS');
