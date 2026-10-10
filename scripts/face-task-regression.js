'use strict';
const assert = require('node:assert/strict');
// 🔴 夹具直接用**产品实现**算 `pct`（不在这里重写一遍）：主进程的边界规则一改，
//    夹具抄的那份就会滞后 ⇒ 断言「照着旧规则绿」。见 `docs/contracts/background-tasks.md` §1.1。
const { computePct } = require('../src/main/progress-pct');
const nodes = new Map();
function node(id) {
  if (!nodes.has(id))
    nodes.set(id, {
      style: {},
      textContent: '',
      // 进度条换成 `div + .progress-fill` 之后，判据是 `className`（含不定态类）
      // ⇒ 夹具要显式带上这个字段，否则「读到一个从未设过的类名」与「类名就是空串」分不清。
      className: '',
      removeAttribute(key) {
        delete this[key];
      },
    });
  return nodes.get(id);
}
global.window = {};
global.document = { documentElement: { lang: 'en' }, getElementById: node };
// 🔴 面板文案走 `I18n`（`scan-flow.js#tui` / `#tuiFmt`）⇒ 夹具必须加载它，
//    **而且切语言要切真相源**。`i18n.js` 的 IIFE 以 `window` 为 global
//    （`typeof window !== 'undefined' ? window : this`）⇒ require 之后挂在 `window.I18n`，
//    与 `tui` 读的 `global.I18n` 正是同一个对象。
require('../src/renderer/i18n.js');
require('../src/renderer/scan-flow');

/**
 * 切语言。**两个都要动**：`I18n.setLocale` 是真相源，`document.documentElement.lang`
 * 是它**派生的镜像**（`applyDom()` 里同步回去，供 CSS / 无障碍用）。
 *
 * ⚠️ 2026-10-08 实测：只设镜像不够 —— 「用 `documentElement.lang` 判语言」是**旧写法**
 *    （内联三元）。面板文案统一改走 i18n 之后，只改镜像 ⇒ 取词仍按旧语言，
 *    英文用例会红成「期望 `60 photos`、实际 `60 张/分钟`」。
 *    **那条红是夹具欠账，不是产品回归** —— 产品里 `setLocale` 会顺带把镜像写对，两者不会脱节。
 */
function setLang(lang) {
  global.window.I18n.setLocale(lang, { skipMainSync: true });
  global.document.documentElement.lang = lang;
}
setLang('en');
const panel = node('panel');
/**
 * 给 AI 两节的状态补上主进程会派生的 `pct`（夹具只用「真状态对象」是缺一块的：
 * 产品里这个字段由 `main/semantic-search.js#status()` 灌进来）。已经是显式给了 `pct`
 * 的用例不动它 —— 那正是下面那条「读 `pct` 而不是就地相除」的用例要用的。
 */
function withPct(s) {
  if (!s || typeof s !== 'object' || s.pct != null) return s;
  return { ...s, pct: computePct(s.done, s.total) };
}
function render(face, rest = {}) {
  return global.window.RendererScanFlow.renderBackgroundTaskPanel({
    state: {},
    dom: { scanProgress: panel },
    tasks: { ...rest, face: withPct(face), semantic: withPct(rest.semantic) },
  });
}
assert.equal(
  render({
    running: true,
    phase: 'indexing',
    done: 120,
    failed: 2,
    skipped: 3,
    ratePerMinute: 60,
    currentFile: '<photo>.jpg',
  }),
  true,
);
assert.equal(panel.style.display, 'block');
assert.equal(node('taskFaceSection').style.display, 'block');
assert.match(node('taskFaceCount').textContent, /120.*2.*3/);
assert.equal(node('taskFaceFile').textContent, '<photo>.jpg');
assert.match(node('taskFaceRate').textContent, /60 photos/);
/**
 * 🔴 2026-10-08 翻面：进度条从 `<progress>` 换成 `div + .progress-fill`（契约 §5 的形状收敛），
 *    判据跟着从 `.value` 改成 `style.width` + **不定态类**。
 * ⚠️ 「无确定进度 = 不定态」这条**语义必须保住**：`<progress>` 不带 `value` 时浏览器画的是
 *    动画条纹（「在跑，但进度未知」），而 `div` 的 `0%` 会被读成「进度就是 0」—— 两者含义相反。
 *    换 div 之后这个语义由 `styles.css#.progress-fill--indeterminate` 承担。
 * ⚠️ 这一版顺手修好了一处真实的**不同步**：从前 `else removeAttribute('value')` 把
 *    **索引阶段**（有 done/total）也一并变成了不定态，而同一节的计数行明明在显示
 *    `done / 约 total（pct%）` ⇒ 计数有百分比、进度条却不动。
 *    现在的优先级：下载阶段用下载字节进度 > 有确定分母时用主进程派生的 `pct` > 不定态。
 */
assert.equal(node('taskFaceProgress').className, 'progress-fill progress-fill--indeterminate');
assert.equal(node('taskFaceProgress').style.width, '');
render({ running: true, phase: 'downloading', file: 'yunet.onnx', percent: 45 });
assert.equal(node('taskFaceProgress').style.width, '45%');
assert.equal(node('taskFaceProgress').className, 'progress-fill');
// 有确定分母 ⇒ 进度条跟主进程派生的 `pct` 走。**故意让 pct 与 done/total 对不上**
// （10/100 却报 42）以便钉住「读 `pct`，不在这儿就地相除」——与面板守护同一条手法。
render({ running: true, phase: 'indexing', done: 10, total: 100, pct: 42 });
assert.equal(node('taskFaceProgress').style.width, '42%');
assert.equal(node('taskFaceProgress').className, 'progress-fill');
render({ running: true, phase: 'stopping' });
assert.equal(node('taskFaceStop').disabled, true);
assert.equal(render({ running: false, phase: 'complete' }), false);
assert.equal(node('taskFaceSection').style.display, 'none');
assert.equal(render({ running: true, phase: 'groups' }), false, 'browsing is not an index task');
assert.equal(
  render({ running: false }, { thumbs: { running: true } }),
  true,
  'other tasks remain visible',
);
console.log('[face-task-regression] 行为层 ok');
assert.equal(
  render(
    {},
    {
      semantic: {
        running: true,
        operation: 'index',
        phase: 'indexing',
        done: 12,
        ratePerMinute: 30,
      },
    },
  ),
  true,
);
assert.equal(node('taskSemanticSection').style.display, 'block');
assert.match(node('taskSemanticCount').textContent, /12/);
assert.equal(
  render({}, { semantic: { running: true, operation: 'search', phase: 'loading' } }),
  false,
  'query model loading is not index work',
);
render(
  {},
  {
    semantic: {
      running: true,
      operation: 'install',
      phase: 'downloading',
      file: 'model.onnx',
      percent: 32,
    },
  },
);
// 搜图那节同一套（共用 `SemanticSearch.status()` 与同一段渲染代码）——同样翻面到 `style.width`。
assert.equal(node('taskSemanticProgress').style.width, '32%');
assert.equal(node('taskSemanticProgress').className, 'progress-fill');

// ---------------------------------------------------------------------------
// 2026-10-08 扩面：「补 tag 标签」必须可见 + 索引要报总数 / 百分比
// ---------------------------------------------------------------------------

/**
 * 🔴 起因（用户问「搜图和人脸是否同样有后台任务显示及进度数量」时查出来的）：
 * `showSemantic` 原先的取值域是 `['install','index']`，而 `semantic-worker.js#refreshTags`
 * 走的是 `operation === 'tag'`（**启动后 3 秒自动跑**的补 tag 倒排）。
 * ⇒ 它跑的时候那一节**隐藏**；若它是**唯一**在跑的任务，`showPanel` 整体为假
 * ⇒ **连面板标题一起消失**，用户完全看不到一个正在跑的长任务。
 *
 * ⚠️ 与第 27 轮「缩略图重建不显示」是**同一个形状**：新加了一条进度列，却没进取值域。
 *    那时之所以没被发现，是因为补全也在跑、**它撑着面板** —— 这次也一样（缩略图重建撑着）。
 * ⚠️ 判据必须是 `operation` 不是 `phase`：`phase` 里的 `'loading'` 搜索/预选词也会经过
 *    ⇒ 按 phase 放行会把「搜图」显示成后台任务。
 */
assert.equal(
  render(
    {},
    { semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 7374 } },
  ),
  true,
  '「补 tag 标签」是长任务，必须在顶栏显示（它以前会让整块面板消失）',
);
assert.equal(node('taskSemanticSection').style.display, 'block');

/**
 * 计数行**两种语言都要验**：文案整段来自词条（`task.aiCount` / `task.aiCountEst` / `task.aiDone`），
 * 中英两份**各自成句**（不再是在代码里就地 `en ? … : …`）⇒ 只验一种语言仍然等于只验一半。
 * ⚠️ 括号必须跟着语言走：英文半角 `(42%)`、中文全角 `（42%）`。全角括号混进英文界面
 * 既是排印错误，又会漏过「英文界面零 CJK」那类判据（`（）` 是 CJK 标点）。
 */
function countIn(lang, fn) {
  setLang(lang);
  fn();
  return node('taskSemanticCount').textContent;
}

/** 精确分母（`tag` 阶段 = `pendingTagsCount` 的纯 COUNT）：画「完成 N / 共 M（pct%）」且**不带「约」**。 */
const zhExact = countIn('zh', () =>
  render(
    {},
    { semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 7374 } },
  ),
);
assert.match(
  zhExact,
  /完成 10 \/ 7374（0%）/,
  '有精确分母时要画总数与百分比（与缩略图主行 `done / total（pct%）` 同形状）',
);
assert.ok(!/约/.test(zhExact), '精确 COUNT 的分母不许写「约」—— 写了用户会以为连数都没数准');
const enExact = countIn('en', () =>
  render(
    {},
    { semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 7374 } },
  ),
);
assert.equal(enExact, 'Processed 10 / 7374 (0%)', '英文界面的括号必须是半角，且整串零 CJK');
assert.ok(!/[\u3000-\u303f\uff00-\uffef]/.test(enExact), '英文界面不许出现全角标点（`（）` 是 CJK 标点）');

/** 估算分母（`index` 阶段 = id 轴抽样放大）：必须写「约」/`~`，否则用户拿它核对行数会得出「进度算错了」。 */
const zhEst = countIn('zh', () =>
  render(
    {},
    {
      semantic: {
        running: true,
        operation: 'index',
        phase: 'indexing',
        done: 165000,
        total: 1650000,
        totalEstimated: true,
      },
    },
  ),
);
assert.match(
  zhEst,
  /完成 165000 \/ 约 1650000（10%）/,
  '抽样估算出来的分母必须标「约」（它是估计值，不是数出来的）',
);
const enEst = countIn('en', () =>
  render(
    {},
    {
      semantic: {
        running: true,
        operation: 'index',
        phase: 'indexing',
        done: 165000,
        total: 1650000,
        totalEstimated: true,
      },
    },
  ),
);
assert.match(enEst, /~1650000 \(10%\)/, '英文界面用 `~` 标估算值');
assert.ok(!/约/.test(enEst), '英文界面不许出现「约」');

/**
 * 🔴 估算三态（`countPhase`）—— 分母**还没就绪**时有三种情况，含义完全不同：
 *   · `'counting'` 正在估（**会**自己过去，等等就有百分比）
 *   · `'failed'`   估失败（**永远**不会好，百分比不会来了）
 *   · `'ready'` + `total = 0` 估成功且就是 0（真的没有待处理项）
 *
 * 收敛前这三种全被压成同一句「完成 N」：AI 侧只有一个 `totalEstimated` 布尔，而它在
 * 「估成功」与「估失败」下**取值相同**（都是 `true`）⇒ 界面**没有能力**区分，
 * 于是用户只能猜「是不是坏了」。前两种必须分辨得出，第三种的**不许**说成失败。
 * 词条形状与缩略图补全一致（`task.thumbCountCounting` / `thumbCountNoTotal`）。
 */
function countWithCountPhase(lang, countPhase, extra = {}) {
  setLang(lang);
  render(
    {},
    {
      semantic: {
        running: true,
        operation: 'index',
        phase: 'indexing',
        done: 7,
        total: 0,
        totalEstimated: true,
        countPhase,
        ...extra,
      },
    },
  );
  return node('taskSemanticCount').textContent;
}
const zhCounting = countWithCountPhase('zh', 'counting');
const zhEstFailed = countWithCountPhase('zh', 'failed');
assert.match(
  zhCounting,
  /正在估计待处理数量/,
  '「正在估」必须说出来 —— 否则那段（2000 次跨库点查）在界面上只是一句「完成 7」',
);
assert.ok(!/失败/.test(zhCounting), '「正在估」不许说成「估失败」—— 前者会过去、后者不会，说反了用户会去查故障');
assert.match(
  zhEstFailed,
  /总数估计失败/,
  '「估失败」必须明说 —— 这一态不会自己好，用户要知道百分比永远不来了',
);
/**
 * ⚠️ 这里**刻意不写** `assert.notEqual(zhCounting, zhEstFailed)`。看起来是「可区分性」的直接判据，
 *    其实是**死断言**：上面两条已经要求前者**不含**「失败」、后者**含**「总数估计失败」，
 *    而「失败」是「总数估计失败」的子串 ⇒ 两者**逻辑上不可能相等**，这条永远不会红。
 *    真正在守「可区分」的是上面那两条 `match` / `!match` —— 它们钉住的是**各自不同的内容**，
 *    比不等式强（不等式只排除「完全相同」，允许「同一句话换个词」那种退化）。
 *    「加一条永远绿的断言」= 给守护增重而不增牙，本工程把它当缺陷看。
 */

const zhReadyZero = countWithCountPhase('zh', 'ready');
assert.ok(
  !/失败/.test(zhReadyZero) && !/正在估计/.test(zhReadyZero),
  '🔴 `ready` + `total = 0` 是「估出来就是 0」，**不是**估失败 —— 补全那边只有两态、会把它误标成失败，' +
    '这里靠三态分岔避开；这一态也不许再挂「正在估计…」',
);

assert.match(countWithCountPhase('en', 'counting'), /estimating/, '英文界面也要说清「正在估」');
assert.match(countWithCountPhase('en', 'failed'), /could not estimate the total/, '英文界面也要说清「估失败」');
for (const [lang, text] of [
  ['en', countWithCountPhase('en', 'counting')],
  ['en', countWithCountPhase('en', 'failed')],
]) {
  assert.ok(
    !/[\u3000-\u303f\uff00-\uffef]/.test(text),
    lang + ' 界面的估算三态文案不许出现全角标点（`（）` 是 CJK 标点）：' + text,
  );
  assert.ok(
    !/[\u4e00-\u9fff]/.test(text),
    lang + ' 界面的估算三态文案不许出现汉字：' + text,
  );
}

/**
 * 🔴 分母是**起始快照**、扫描会持续入库 ⇒ 分子可能反超。
 * 修法是把**分母抬到分子**（`denom = Math.max(total, done)`，与
 * `getThumbnailBackfillProgress` 同一条规矩），不是把分子压下来 —— 分子是「真的做了多少」，
 * 压它等于对用户少报工作量。两侧都夹住 ⇒ 百分比恒在 [0,100]、剩余时间不为负。
 */
const zhClamp = countIn('zh', () =>
  render({}, { semantic: { running: true, operation: 'index', phase: 'indexing', done: 2000, total: 1000 } }),
);
assert.match(
  zhClamp,
  /完成 2000 \/ 2000（100%）/,
  '分子反超分母时把分母抬到分子（显示 /2000 而不是 /1000），百分比夹到 100%',
);
assert.ok(!/200%/.test(zhClamp) && !/-\d/.test(zhClamp), '不许出现 >100% 或负数');

/** 失败 / 跳过只在 `> 0` 时追加：一直挂着「失败 0 · 跳过 0」会在正常运行的界面上报一个可疑的绝对数。 */
const zhQuiet = countIn('zh', () =>
  render({}, { semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 100 } }),
);
assert.ok(
  !/失败/.test(zhQuiet) && !/跳过/.test(zhQuiet),
  '失败 / 跳过为 0 时不画（判据与那两节的「四样产出」一致）',
);
const zhFailed = countIn('zh', () =>
  render(
    {},
    { semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 100, failed: 2 } },
  ),
);
assert.match(zhFailed, /失败 2/, '一旦有失败就必须显示，且此后不再消失');
assert.ok(!/跳过/.test(zhFailed), '这一项仍是 0 ⇒ 不画');
/** 没有人脸状态时人脸那节不受影响（两节共用同一段渲染代码 ⇒ 别互相串）。 */
assert.equal(node('taskFaceSection').style.display, 'none', '只跑搜图时人脸那节不该被点亮');
setLang('en');

/**
 * 🔴 「渲染端不许自己除百分比」的**正面证明**：给一个与 `done / total` **不符**的 `pct`
 *    （10 / 100，但 `pct` = 42），界面必须显示 42%。
 *    ⚠️ 只验「42% 显示得出来」是不够的 —— 那种用例两边都绿；必须让「就地相除」算出一个
 *    **不同的**数（10%），这条断言才有牙。见 `docs/contracts/background-tasks.md` §1.1。
 */
const spoofPct = countIn('zh', () =>
  render(
    {},
    { semantic: { running: true, operation: 'tag', phase: 'tagging', done: 10, total: 100, pct: 42 } },
  ),
);
assert.match(
  spoofPct,
  /42%/,
  '百分比必须读主进程派生的 `pct`：渲染端就地相除（10 / 100）会显示 10%，而契约要求主进程说了算',
);
assert.ok(
  !/10%/.test(spoofPct),
  '不许出现渲染端就地相除算出来的 10% —— 那意味着存在第二个真相源',
);

// ---------------------------------------------------------------------------
// 静态面：分母与候选集必须**逐字同源**，且新字段不许在起手残留
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

/**
 * 用 AST 把注释**按原偏移**抹成空格。
 *
 * 🔴 必须走 AST，不能用正则剥：`//` 会出现在字符串与 URL 里，正则剥会把代码一起吃掉，
 *    而吃掉一段的后果是**断言静默变松**（看的是残片）。也不能干脆不剥 ——
 *    这几条断言查的都是「某个名字出现在函数体里」，而注释里正好写着这些名字
 *    ⇒ 注释会替真代码顶包（本工程记过的假绿形状）。
 */
function stripCommentsByAst(src) {
  let ranges = [];
  const collect = (_block, _text, start, end) => ranges.push([start, end]);
  try {
    ranges = [];
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', onComment: collect });
  } catch (_eScript) {
    ranges = [];
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', onComment: collect });
  }
  if (!ranges.length) return src;
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += src.slice(cursor, start) + ' '.repeat(end - start);
    cursor = end;
  }
  return out + src.slice(cursor);
}

function readSrc(rel) {
  return stripCommentsByAst(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
}

/**
 * 「进度分母」与「真实候选集」必须是**同一个谓词**。
 *
 * 🔴 分母与候选集漂开 ⇒ 百分比与真实工作量脱钩，而且**不会报错**：界面上只是那个百分比
 *    慢慢变得没有意义。缩略图补全那边是靠复用 `_sqlBackfillPendingExpr()` 本身解决的，
 *    这里用共享常量达到同一效果。
 * ⇒ 所以判据不是「有没有常量」，而是**谓词的字面量在文件里只许出现一次**：
 *    有人把谓词重新内联进 `batch()` 时，这条立刻红。`batch` 用常量、估算法不用（或反过来）
 *    也同样红 —— 那种漂法更隐蔽，因为两边都还在跑、都能出数。
 */
const predicateInventory = [
  {
    file: 'src/ai/index-store.js',
    marker: 'e.photo_id IS NULL OR e.model != ?',
    batchUse: /WHERE p\.id < \? AND \$\{CANDIDATE_PRED\}/,
    estUse: /SELECT \$\{CANDIDATE_PRED\} AS hit/,
    join: 'semantic.embeddings',
  },
  {
    file: 'src/ai/face-store.js',
    marker: 's.photo_id IS NULL OR s.version != ?',
    batchUse: /WHERE p\.id < \? AND \$\{CANDIDATE_PRED\}/,
    estUse: /SELECT \$\{CANDIDATE_PRED\} AS hit/,
    join: 'faceindex.scans',
  },
];
for (const spec of predicateInventory) {
  const src = readSrc(spec.file);
  const hits = src.split(spec.marker).length - 1;
  assert.equal(
    hits,
    1,
    spec.file + '：候选谓词只许有一份（现在 ' + hits + ' 份）—— `batch()` 与 `estimatePendingCount()` 必须共用常量',
  );
  assert.ok(spec.batchUse.test(src), spec.file + '：`batch()` 必须用共享常量取批');
  assert.ok(
    spec.estUse.test(src),
    spec.file + '：`estimatePendingCount()` 必须用共享常量 —— 手抄一份抽样 SQL 是最容易漂的地方',
  );
  assert.ok(
    src.includes(spec.join),
    spec.file + '：抽样估算必须与取批 join 同一张表（' + spec.join + '）',
  );
  /** 🔴 id 空洞不计入样本：算进去会系统性拉低命中率（`photos.id` 有删除留下的洞）。 */
  assert.ok(
    /if\s*\(!row\)\s*continue/.test(src),
    spec.file + '：抽样必须跳过 id 空洞（`if (!row) continue;`）—— 否则命中率被系统性低估',
  );
  assert.ok(
    /Math\.max\(50,\s*Math\.min\(20000,/.test(src),
    spec.file + '：样本数要夹在 [50, 20000]（与 `estimatePendingCandidateCount` 同一套夹法）',
  );
}
/**
 * 两个 store 的估算法都要夹 `Math.max(50, Math.min(20000, …))`，且都要真的被 worker 调用。
 *
 * 🔴 「估算失败要降级」这条**必须判门、不能判「出现过 `estimatedTotal = 0`」**：
 *    `let estimatedTotal = 0;` 这个**初始化**就满足后者，于是「catch 里改成 `throw`」
 *    照样绿 —— 那正是本工程记过无数次的假绿形状。判据改成看**调用点到 `progress(` 之间**
 *    那一小段：必须包 `catch`、catch 里必须**赋值 0**、且**不许 `throw`**。
 */
for (const [file, call] of [
  ['src/workers/semantic-worker.js', /store\.estimatePendingCount\(\)/],
  ['src/workers/face-worker.js', /store\.estimatePendingCount\(\)/],
]) {
  const src = readSrc(file);
  assert.ok(call.test(src), file + '：索引起手要把估算出来的分母上报给界面');
  assert.ok(
    /totalEstimated:\s*true/.test(src),
    file + '：估算出来的分母要标 `totalEstimated`，界面据此写「约」',
  );
  const at = src.indexOf('estimatePendingCount()');
  const end = at >= 0 ? src.indexOf('progress({', at) : -1;
  const span = at >= 0 && end > at ? src.slice(at, end) : '';
  assert.ok(span, file + '：没找到估值到上报之间那段代码（夹具失效，别当成通过）');
  assert.ok(
    /catch\s*\(/.test(span),
    file + '：估算必须包 try/catch —— 估不出分母只该让百分比消失，不该让整个索引失败',
  );
  assert.ok(
    /estimatedTotal\s*=\s*0\s*;/.test(span),
    file + '：估算失败必须**降级成 0**（= 没有分母），界面按 `total > 0` 的门就不画百分比',
  );
  assert.ok(
    !/throw/.test(span),
    file + '：估算失败**不许抛** —— 一个只给用户看的进度分母不该弄死几十小时的索引任务',
  );
}
/** `tag` 阶段的分母是精确 COUNT ⇒ 必须显式标 `totalEstimated: false`（否则会继承上一轮的 true）。 */
assert.ok(
  /totalEstimated:\s*false/.test(readSrc('src/workers/semantic-worker.js')),
  '`tag` 阶段分母是精确 COUNT，必须显式标 totalEstimated: false',
);
/**
 * 🔴 任务起手的重置块是**逐字段列**的、不是「清空后重建」⇒ 漏掉新字段，上一轮的 `total`
 *    会跨任务活下来（`index` 播下一个百万级分母，接着跑 `tag`/`search` 时界面照用那个假分母，
 *    而且不报错，只是百分比永远接近 0%）。
 */
const searchSrc = readSrc('src/main/semantic-search.js');
assert.ok(
  /\btotal:\s*0\b/.test(searchSrc) && /\btotalEstimated:\s*false\b/.test(searchSrc),
  '任务起手必须把 `total` / `totalEstimated` 归零（那块是逐字段列的，漏了会跨任务残留）',
);
/**
 * 🔴 `countPhase` 是估算三态的**第三角**，必须跟上面两个一起重置。
 *    只重置 `total` / `totalEstimated` 的话，上一轮 `index` 留下的 `'failed'` 会挂到下一轮
 *    `tag` 上 —— 界面于是对着一个刚刚精确数出来的 `COUNT` 说「总数估计失败」，而且不报错。
 *    （同 §2「新字段必须同时进三个地方」；`null` 这个重置值也**必须显式写**，
 *    `preserveProgress` 分支只跳过那一段，不写等于继承。）
 */
assert.ok(
  /\bcountPhase:\s*null\b/.test(searchSrc),
  '🔴 任务起手必须把 `countPhase` 归 null —— 漏了会让上一轮 `index` 的 `\'failed\'` 跨任务残留',
);

/**
 * 🔴 估算三态在 **worker 侧**的两条牙齿（形状 / 顺序），与上面那条行为层断言配对：
 *    行为层证明「渲染端画得对」，这里证明「worker 真的按那个形状发」——只有前者的话，
 *    worker 一旦发成 `'ready'` 就直接少一个态，而渲染端依然「画得对」。
 *
 * 为什么**必须有顺序**这条：`estimatePendingCount()` 是 2000 次跨库点查，不是瞬时的。
 * 先估后报 ⇒ 估算那段时间界面读到 `done = 0 / total = 0`，还是画成「完成 0」，
 * 与「估失败」不可区分 —— 三态加了也等于没加。缩略图补全就是这么修的
 * （`main.js` 起手先置 `phase = 'counting'` 再去做阻塞统计）。
 *
 * ⚠️ 用**全文件 indexOf 比位置**（不是窗口法）：这里要断言的恰恰就是「A 在 B 前面」，
 *    位置比较正是它的判据；两个锚点在全文件里各只出现一次。
 */
for (const file of ['src/workers/semantic-worker.js', 'src/workers/face-worker.js']) {
  const src = readSrc(file);
  const atEst = src.indexOf('store.estimatePendingCount()');
  const atCounting = src.indexOf("countPhase = 'counting'");
  const atReady = src.indexOf("countPhase = 'ready'");
  const atFailed = src.indexOf("countPhase = 'failed'");
  assert.ok(
    atEst >= 0 && atCounting >= 0 && atReady >= 0 && atFailed >= 0,
    file + '：估算三态 `counting` / `ready` / `failed` 必须都上报 —— 缺一个 = 那个态在界面上不存在',
  );
  assert.ok(
    atCounting < atEst,
    file +
      '：必须先报 `counting` **再**去估 —— 顺序反了，估算那段时间界面只能画「完成 0」，' +
      '与「估失败」不可区分（三态白加）',
  );
  assert.ok(
    atReady > atEst && atFailed > atEst,
    file + '：`ready` / `failed` 两个**结果态**必须在估算点之后（写在前面 = 无条件执行，等于没有结果态）',
  );
  /** 取值域只许这三个：多一个字面量 ⇒ 渲染端那条 `else if` 链会**静默**漏掉它。 */
  const seen = Array.from(src.matchAll(/countPhase\s*=\s*'([a-zA-Z]+)'/g)).map((m) => m[1]);
  assert.deepEqual(
    Array.from(new Set(seen)).sort(),
    ['counting', 'failed', 'ready'],
    file + '：`countPhase` 的取值域只许是 counting / ready / failed（现在 ' + JSON.stringify(seen) + '）',
  );
}

// ---------------------------------------------------------------------------
// 文案必须来自 i18n 词条（2026-10-08 统一，防长回去）
// ---------------------------------------------------------------------------

/** 取函数体。**必须走 AST**，禁「从函数头往后切 N 个字符」—— 窗口法是假红/假绿双向源。 */
function walkAst(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((x) => walkAst(x, fn));
    else if (v && typeof v === 'object') walkAst(v, fn);
  }
}
function functionBodyByName(src, name) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  let found = '';
  walkAst(ast, (n) => {
    if (found) return;
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) {
      found = src.slice(n.body.start, n.body.end);
    }
  });
  return found;
}

/**
 * 🔴 AI 两节的文案原先在面板里**就地拼**（`(en ? 'Processed ' : '完成 ')`），而且标题除了这份
 * 内联文案之外，`index.html` 骨架上还有一条 `data-i18n="task.faceTitle"` —— 两条并存、
 * 骨架那条每次渲染都被代码覆盖 ⇒ **改词条界面不动**（典型的静默陷阱）。
 * 现在统一到词条；这两条断言是防它长回去的。
 */
const flowSrc = stripCommentsByAst(readSrc('src/renderer/scan-flow.js'));
const aiPanel = functionBodyByName(flowSrc, 'renderBackgroundTaskPanel');
assert.ok(
  aiPanel.length > 0,
  '夹具自证：按 AST 切出了 renderBackgroundTaskPanel 的函数体（切不出来后面全是空断言）',
);
assert.ok(
  !/\ben\s*\?/.test(aiPanel),
  'AI 两节的文案不许再写内联三元（`(en ? … : …)`）—— 改词条，见 docs/contracts/background-tasks.md §6',
);
assert.ok(
  !/titleEn/.test(aiPanel),
  '标题不许走 `titleEn` 硬编码 —— 走 `titleKey` + `tui`，否则 i18n 词条会被代码覆盖',
);

const AI_KEYS = [
  'task.faceTitle',
  'task.semanticTitle',
  'task.aiStopping',
  'task.aiDone',
  'task.aiCount',
  'task.aiCountEst',
  // 估算三态里「分母还没就绪」的两条（第三种 `ready` + `total = 0` 刻意不画文案，见行为层断言）。
  'task.aiCountCounting',
  'task.aiCountNoTotal',
  'task.aiFailed',
  'task.aiSkipped',
  'task.aiRate',
  'task.aiPreparing',
  'task.queueWaiting',
  'task.queuePending',
];
for (const key of AI_KEYS) {
  assert.ok(aiPanel.includes("'" + key + "'"), '面板要引用词条 ' + key);
}
/**
 * 🔴 词条必须**中英成对**。缺一边的后果分两种，都不报错：中文包缺 ⇒ 回落读中文包（英文界面
 * 显示中文）；英文包缺 ⇒ `t()` 也回落中文包 ⇒ 英文界面混入中文，而「英文界面零 CJK」
 * 那类判据只覆盖跑到的用例、覆盖不到全部词条。
 */
const i18nSrc = stripCommentsByAst(readSrc('src/renderer/i18n.js'));
for (const key of AI_KEYS) {
  const n = (i18nSrc.match(new RegExp("'" + key.replace(/\./g, '\\.') + "':", 'g')) || []).length;
  assert.equal(n, 2, key + ' 必须中英各一条（现在 ' + n + ' 条）—— 缺一边会在切语言时露 key 或回落中文');
}

/**
 * 🔴 百分比**唯一来源**：面板不许再自己除（`docs/contracts/background-tasks.md` §1.1）。
 * 本文件原先有 6 个「就地相除」的计算点，而且 `total = 0` 的边界行为还不一致
 * （无效清理那节画 100%、其余画 0% —— 那会让条子先满再掉回 0%，看着像倒退）。
 *
 * 判据必须是**两条**：只判「读了 `pct`」的话，把读取删掉、留着就地相除照样过（正是回退的形状）。
 */
for (const expr of ['prog.pct', 'invalidCleanup.pct', 'dupHash.pct', 'aiTask.state.pct']) {
  assert.ok(aiPanel.includes(expr), '面板要读主进程派生的百分比 ' + expr);
}
assert.ok(
  !/Math\.round\s*\(\s*\([^()]*\/[^()]*\)\s*\*\s*100/.test(aiPanel),
  '面板里不许再出现「就地相除」算百分比（`Math.round((a / b) * 100)`）——唯一来源在主进程 `progress-pct.js`',
);

// ⚠️ 只有**这一句**才是「整个守护跑完」的标记：前面那两句（行为层 / 扩面）是中途打点。
//    套件本身判的是 **exit code**（`run-regressions.js` 里 `result.status !== 0`），
//    所以中途打点不会造成假绿 —— 但人看输出找 `PASS` 会被骗，所以中途那两句不写 PASS。
console.log('[face-task-regression] PASS');
