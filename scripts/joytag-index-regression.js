'use strict';
/**
 * JoyTag 打标 / tag 倒排**建索引侧**的守护。
 *
 * 与 `tag-index-regression.js` 的分工：那一份钉的是**存储与查询口径**
 * （DDL / 量化 / 阈值 / 词表 id）；这一份钉的是**「模型随包 + 搜图索引时同时建」
 * 这条链路上会静默失效的那几处** —— 权重身份、预处理口径、播种落点、进度口径。
 *
 * ## 钉七类错（都属于「全绿但错」）
 *
 *   ① **取图口径漂了**。`semantic-worker.js` 里建 CLIP 索引用的 `prepare()`
 *      与 `joytag-model.js#prepareSource()` 必须是同一条链。漂了的后果：同一张图
 *      在「顺手打标」与「老库补建」两条路上算出**不同的分数**，于是同一个标签
 *      在一部分图上查得到、另一部分查不到 —— 两边都不报错。
 *   ② **tag 进度盖掉 CLIP 进度**。父进程是 `Object.assign(this.state, message.progress)`
 *      一把合并的**共享**扁平字段；tag 趟的分母（待打标）与 CLIP 趟的分母（待索引）
 *      差好几个数量级，混着写就是拿 24 盖掉 484000，面板分子/分母/百分比一起变成
 *      另一件事的数字，且不报错。（这个 bug 真的写出来过，见 ② 的注释。）
 *   ③ **`flush(force)` 只跑一批**。`stats()` 在 `finish()` 之前就被取走了，
 *      没冲完的那些要等 `finish()` 才落库 ⇒ `result.tags` 比库里实况少一个尾巴。
 *      实测：老库补建那趟报 `done:16 / pairs:896`，而库里是 24 张 / 1742 对。
 *   ④ **播种落点与读取落点不一致**。`seedJoytag()` 写的位置必须正是
 *      `joytag.modelPath()` 读的位置。两处各拼一次路径 = 「播种成功、加载说没有模型」，
 *      而界面只会说「下载模型」，用户再点一次还是同一个结果。
 *   ⑤ **归一化常数用错**。必须是 CLIP 那套 mean/std，不是 ImageNet 那套。
 *      用错不报任何错，表现是「标签整体偏保守、召回塌掉」。
 *   ⑥ **`PREP_SPEC` 与链子对不上**。`PREP_SPEC` 是手写的字符串、链子是代码；
 *      改了链子不改它 ⇒ 索引里记的是一句谎话，新旧两批分数会被当成同一口径混用一个库。
 *   ⑦ **索引身份写了字面量**。`min_score` / `prep_spec` / `model` 必须从各自的
 *      唯一真相源取（`STORE_MIN_SCORE` / `joytag.PREP_SPEC` / `TAG_INDEX_MODEL`），
 *      写死数字就是两份口径，改一处另一处静默不动。
 *
 * ## 断言不许读注释（元规则③）
 * 所有源码层判据都走 acorn 的 AST，注释天然看不见。**这一点在本文件里尤其要紧**：
 * 上面第 ①⑦ 条正是靠「注释里写着要做某件事」骗过人的那种（注释与代码各说一份）。
 *
 * ## 牙齿（证明断言不是恒真）
 * 每个「纯函数裁判」都配了反向用例：喂一份**故意做错**的输入，必须被判红。
 * 反向用例自己也不许恒真 —— 见 ⑤ 里那条「ImageNet 那套必须算出不同的值」。
 *
 * ## 覆盖率的诚实说明
 * ⑧「仓库内权重能过校验」在 `models/joytag/model.onnx` 不存在时**只能跳过**
 * （`models/` 不进版本库，新克隆的机器上必然没有）。跳过时**明确打印一行**，
 * 不静默 —— 假绿比没有守护更糟。
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const WORKER_FILE = path.join(ROOT, 'src', 'workers', 'semantic-worker.js');
/** JoyTag 建索引路自己的 worker（2026-10-08 起**与 CLIP 路并行**）——tag 侧代码都在这里。 */
const TAG_WORKER_FILE = path.join(ROOT, 'src', 'workers', 'semantic-tag-worker.js');
const MODEL_FILE = path.join(ROOT, 'src', 'ai', 'joytag-model.js');
const SEARCH_FILE = path.join(ROOT, 'src', 'main', 'semantic-search.js');
const MANIFEST_FILE = path.join(ROOT, 'models', 'manifest.json');

const joytag = require(MODEL_FILE);
const bundled = require(path.join(ROOT, 'src', 'ai', 'bundled-models.js'));
const { STORE_MIN_SCORE, TAG_INDEX_MODEL } = require(path.join(ROOT, 'src', 'ai', 'tag-index-store.js'));

const read = (file) => fs.readFileSync(file, 'utf8');

// ---------------------------------------------------------------- AST 小工具

function parse(src) {
  const parseAs = (sourceType) =>
    acorn.parse(src, {
      ecmaVersion: 'latest',
      sourceType,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  try {
    return parseAs('script');
  } catch (_) {
    return parseAs('module');
  }
}

/** 遍历 AST（跳过位置字段）。`visit` 在每个**有 type 的节点**上调用一次。 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    walk(node[key], visit);
  }
}

/**
 * 找函数体。既认 `function name(){}` 也认 `const name = () => {}` /
 * `const name = function (){}`（`prepare` 是后者、`prepareSource` 是前者）。
 * 找不到返回 `null` —— 调用方一律当「锚点移位」处理，直接断言失败。
 */
function findFn(ast, name) {
  let found = null;
  walk(ast, (node) => {
    if (found) return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) found = node;
    else if (
      node.type === 'VariableDeclarator' &&
      node.id &&
      node.id.name === name &&
      node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')
    )
      found = node.init;
  });
  return found;
}

/** 函数体里那条「返回的表达式」（箭头简写体 = 它自己；块体 = 那条 `return …`）。 */
function returnedExpr(fn) {
  if (!fn || !fn.body) return null;
  if (fn.body.type !== 'BlockStatement') return fn.body;
  const ret = fn.body.body.find((stmt) => stmt.type === 'ReturnStatement' && stmt.argument);
  return ret ? ret.argument : null;
}

/** `src` 里 `name` 函数返回的表达式源码，**去掉全部空白**后返回（用于逐字比对）。 */
function strippedBody(src, name) {
  const expr = returnedExpr(findFn(parse(src), name));
  return expr ? src.slice(expr.start, expr.end).replace(/\s+/g, '') : null;
}

/** 某个函数体里所有 `.resize(...)` 调用的实参节点。 */
function resizeArgs(src, name) {
  const fn = findFn(parse(src), name);
  const out = [];
  walk(fn, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property &&
      node.callee.property.name === 'resize'
    )
      out.push(node.arguments);
  });
  return out;
}

/** 某个函数体里所有 `store.setMeta(键, 值)` 的两个实参。 */
function setMetaArgs(src, name) {
  const fn = findFn(parse(src), name);
  const out = [];
  walk(fn, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property &&
      node.callee.property.name === 'setMeta' &&
      node.arguments.length === 2
    )
      out.push(node.arguments);
  });
  return out;
}

/** AST 上的属性名字面量集合（**注释天然看不见**）。 */
function propertyKeys(src, filter) {
  const out = [];
  walk(parse(src), (node) => {
    if (node.type !== 'Property') return;
    const key = node.key && (node.key.name || (node.key.type === 'Literal' ? String(node.key.value) : ''));
    if (key && (!filter || filter.test(key))) out.push(key);
  });
  return out;
}

const tmpDirs = [];
function tempRoot(tag) {
  const dir = path.join(os.tmpdir(), 'aurora-joytag-guard-' + process.pid + '-' + tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

// ---------------------------------------------------------------- ① 取图口径逐字同源

/**
 * 两条链的**去空白源码**。
 *
 * 抽成纯函数是为了能喂变异的源码做反向验证 —— 一个恒真的比对器和没有比对器一样糟。
 */
function prepChainPair(workerSrc, modelSrc) {
  return { worker: strippedBody(workerSrc, 'prepare'), model: strippedBody(modelSrc, 'prepareSource') };
}

function prepChainsAgree(workerSrc, modelSrc) {
  const pair = prepChainPair(workerSrc, modelSrc);
  return !!pair.worker && !!pair.model && pair.worker === pair.model;
}

function checkPrepChainSame() {
  const workerSrc = read(WORKER_FILE);
  const modelSrc = read(MODEL_FILE);
  const pair = prepChainPair(workerSrc, modelSrc);
  assert.ok(pair.worker, '① 在 semantic-worker.js 里找不到 `prepare` 的返回表达式 —— 锚点移位了，先核对再改这里');
  assert.ok(pair.model, '① 在 joytag-model.js 里找不到 `prepareSource` 的返回表达式 —— 锚点移位了');
  assert.equal(
    pair.worker,
    pair.model,
    '① 取图口径漂了：CLIP 索引用的 prepare() 与打标用的 prepareSource() 必须逐字同源。\n' +
      '   漂了的后果是「顺手打标」与「老库补建」对同一张图给出不同分数，而两边都不报错。\n' +
      '   worker = ' + pair.worker + '\n' +
      '   model  = ' + pair.model,
  );

  // 反向验证：两处各自改一个数字 / 一处少一环，都必须被判不一致
  assert.equal(
    prepChainsAgree(workerSrc.replace('.resize(512, 512,', '.resize(640, 640,'), modelSrc),
    false,
    '① 反向验证：CLIP 侧把 512 改成 640 必须被判不一致',
  );
  assert.equal(
    prepChainsAgree(workerSrc.replace('.removeAlpha()', ''), modelSrc),
    false,
    '① 反向验证：少一环（removeAlpha）必须被判不一致',
  );
  assert.equal(
    prepChainsAgree(workerSrc.replace('limitInputPixels: 100000000', 'limitInputPixels: 1000'), modelSrc),
    false,
    '① 反向验证：解码上限不同也必须被判不一致（上限不同 = 大图一张能读一张不能）',
  );
  // 阴性对照：完全相同的两份必须判一致（否则上面三条「判不一致」可能只是比对器永远返回 false）
  assert.equal(prepChainsAgree(workerSrc, modelSrc), true, '① 阴性对照：同一份源码必须判一致');
  console.log('[joytag-index-regression] ① 取图口径逐字同源 ✓（牙齿 3 + 阴性对照 1）');
}

// ---------------------------------------------------------------- ② 进度口径不许串

/** announce 允许写的键（tag 专用）。**必须**与 main 侧 state 登记的一一对应。 */
const ANNOUNCE_KEYS = ['tagStage', 'tagDone', 'tagFailed', 'tagTotal', 'tagTotalEstimated', 'tagCountPhase'];

/**
 * 父进程 `Object.assign(this.state, …)` 的**共享**字段。
 * 写这些 = 拿 tag 的分母盖掉 CLIP 的分母（或反过来），不报错、只是界面上的数是错的。
 */
const SHARED_STATE_KEYS = [
  'done',
  'total',
  'failed',
  'skipped',
  'indexed',
  'pct',
  'phase',
  'countPhase',
  'totalEstimated',
  'currentFile',
  'percent',
  'file',
];

/** 纯函数裁判：喂一组键，判它是不是合格的 tag 进度帧。 */
function judgeAnnounceKeys(keys, where) {
  assert.ok(Array.isArray(keys) && keys.length, where + '：没找到 announce 里的 `report({…})`');
  for (const key of keys) {
    assert.ok(
      !SHARED_STATE_KEYS.includes(key),
      where + '：announce 往共享字段 `' + key + '` 里写了 —— 父进程是 Object.assign 合并的，' +
        'tag 的分母（待打标）会盖掉 CLIP 的分母（待索引），分子/分母/百分比一起变成另一件事的数字且不报错',
    );
  }
  assert.deepEqual(
    keys.slice().sort(),
    ANNOUNCE_KEYS.slice().sort(),
    where + '：tag 进度帧的键名必须与上面 ANNOUNCE_KEYS 完全一致（改了要同改 main 侧 state 与那里的注释）',
  );
}

function announceKeysOf(src) {
  const fn = findFn(parse(src), 'announce');
  let keys = null;
  walk(fn, (node) => {
    if (keys) return;
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'report' &&
      node.arguments[0] &&
      node.arguments[0].type === 'ObjectExpression'
    )
      keys = node.arguments[0].properties.map((p) => (p.key && (p.key.name || String(p.key.value))) || '?');
  });
  return keys;
}

function checkProgressNamespaces() {
  // announce 在 tag worker（并行路）里 —— 拆分后键集契约跟着代码走。
  const workerSrc = read(TAG_WORKER_FILE);
  const keys = announceKeysOf(workerSrc);
  judgeAnnounceKeys(keys, '② announce');

  // 反向验证：真写过的那两个形状必须被抓到
  assert.throws(
    () => judgeAnnounceKeys(['phase', 'stage', 'done', 'failed', 'total', 'totalEstimated', 'countPhase'], '② 反向①'),
    /共享字段/,
    '② 反向①：往 done/total/countPhase 里写必须被抓到（这正是 2026-10-08 修掉的那个 bug）',
  );
  assert.throws(
    () => judgeAnnounceKeys(ANNOUNCE_KEYS.concat('stage'), '② 反向②'),
    /键名必须/,
    '② 反向②：多带一个没登记的键也必须被抓到（漏登记 = 界面永远看不到它）',
  );

  /**
   * 跨文件对账：worker 上报的键，main 侧 `state` 里必须**都登记了**。
   * 漏登记不会报错，只是那个数永远到不了渲染端（`state-field-propagation-guard` 那一类）。
   * ⚠️ 走 AST 取 **Property 键**：`semantic-search.js` 里那段注释也写了这六个名字，
   *    正则去匹配会被注释喂饱（元规则③）。
   */
  const mainKeys = new Set(propertyKeys(read(SEARCH_FILE), /^tag[A-Z]/));
  for (const key of ANNOUNCE_KEYS) {
    assert.ok(
      mainKeys.has(key),
      '② main 侧 semantic-search.js 的 state 里没登记 `' + key + '` —— worker 报了、渲染端拿不到（不报错的静默丢弃）',
    );
  }
  for (const key of mainKeys) {
    assert.ok(
      ANNOUNCE_KEYS.includes(key),
      '② main 侧多了 `' + key + '`，worker 不上报它 —— 它会永远停在起手值（看着像「还没开始」）',
    );
  }
  console.log('[joytag-index-regression] ② 进度口径不串 ✓（键 ' + keys.length + ' 个，跨文件对账 ' + mainKeys.size + ' 个）');
}

// ---------------------------------------------------------------- ②b tagPct 也必须主进程派生

/**
 * `status()` 里给 `tagPct` 赋的那个表达式的**去空白源码**（没找到返回 `[]`）。
 *
 * ⚠️ 不用 `findFn`：那是 class **method**（`status() {}`）—— `findFn` 只认
 * `function name(){}` 与 `const name = …`，method 是 `MethodDefinition`，它会返回 null。
 * 所以这里直接找「左值是 `.tagPct` 的赋值」，不管它在哪个函数里（这个文件里只有一处）。
 */
function tagPctAssignments(src) {
  const rows = [];
  walk(parse(src), (node) => {
    if (
      node.type === 'AssignmentExpression' &&
      node.left &&
      node.left.type === 'MemberExpression' &&
      node.left.property &&
      node.left.property.name === 'tagPct'
    )
      rows.push({ expr: src.slice(node.right.start, node.right.end).replace(/\s+/g, '') });
  });
  return rows;
}

/**
 * 纯函数裁判：tag 的百分比必须**用 tag 自己的分子分母**派生。
 *
 * 🔴 为什么这条要单独钉：`status()` 里已经有一句 `out.pct = computePct(out.done, out.total)`
 *    （那属于 CLIP 索引那一路）。给 tag 加百分比时，**最省事的写法就是复用 `out.pct`** ——
 *    而两件事的分母差好几个数量级（待索引几十万 vs 待打标几千），复用等于用索引的分母算
 *    打标的百分比，界面上会显示一个**煞有介事但完全错的**读数，且不报错。
 *    这就是 §10「两套口径不许串」在**派生层**的翻版（那一条管的是 `Object.assign` 上报层）。
 *
 * ⚠️ 判据里**不钉变量名**（只要求 `computePct(<x>.tagDone, <x>.tagTotal)`）：
 *    钉死 `out` 会让一次无害的改名变成假红，而真正要守的性质是「分子分母来自 tag 那套字段」。
 */
function judgeTagPct(rows, where) {
  assert.equal(
    rows.length,
    1,
    where + '：`tagPct` 应当有且只有一处派生（实得 ' + rows.length + ' 处）—— ' +
      '一处都没有 = 渲染端读到一个永远 0 的百分比；两处 = 有一个是死代码，改一边不生效',
  );
  assert.match(
    rows[0].expr,
    /^computePct\(\w+\.tagDone\s*,\s*\w+\.tagTotal\)$/,
    where + '：`tagPct` 必须用 `tagDone` / `tagTotal` 派生（拿 CLIP 的 `done` / `total` 去算 = ' +
      '两套分母串了，界面会显示一个错的百分比且不报错）。实得：' + rows[0].expr,
  );
}

function checkTagPctDerived() {
  judgeTagPct(tagPctAssignments(read(SEARCH_FILE)), '②b');

  /**
   * 反向验证（**必须在裁判之外**，写在裁判里会递归 —— 参考 `judgeAnnounceKeys` 的分工）：
   * 三条喂进去的形状都必须红。
   */
  assert.throws(
    () => judgeTagPct([{ expr: 'computePct(out.done,out.total)' }], '②b 反向①'),
    /tagDone/,
    '②b 反向①：用 CLIP 的分子分母派生 tag 的百分比必须红（这正是「两套口径串了」的形状）',
  );
  assert.throws(
    () => judgeTagPct([], '②b 反向②'),
    /有且只有一处/,
    '②b 反向②：整条派生被删掉必须红（少一句 = 那个百分比恒 0，渲染端分不出「没跑」和「跑完了」）',
  );
  assert.throws(
    () =>
      judgeTagPct(
        [
          { expr: 'computePct(out.tagDone,out.tagTotal)' },
          { expr: 'computePct(out.tagDone,out.tagTotal)' },
        ],
        '②b 反向③',
      ),
    /有且只有一处/,
    '②b 反向③：出现两处派生必须红（改一处不生效 = 典型的假绿）',
  );
  console.log('[joytag-index-regression] ②b tagPct 主进程派生 ✓');
}

// ---------------------------------------------------------------- ③ force 必须清空队列

/**
 * 纯函数裁判：`flush` 里必须有一个循环包着 `batches.splice(...)`，
 * 且循环体内有 `if (!force) break;`。
 *
 * ⚠️ 这条**钉的是机制**，是这一份守护里唯一一处实现锚点。之所以还是钉：
 * 它是「`result.tags` 与库内实况一致」的**唯一**承重结构，而失效形态极隐蔽
 * （读数少一个尾巴，实测 16 vs 24；库里完全正常）。行为层的证明在端到端探针里
 * （`.workbuddy/tmp/tag-e2e.js`，需要 366 MB 权重 + 真图，不进本套件）。
 */
function judgeFlushDrains(shape, where) {
  assert.ok(shape.found, where + '：找不到 `flush` 函数 —— 锚点移位了');
  assert.ok(
    shape.spliceInLoop,
    where + '：`batches.splice(...)` 不在循环里 ⇒ force=true 时只处理一批，队列里剩下的要等 finish() 才落库，' +
      '而 stats() 在那之前就被取走了 —— result.tags 会比库里实况少一个尾巴（实测 16 vs 24）',
  );
  assert.ok(
    shape.forceBreak,
    where + '：循环体里没有 `if (!force) break;` ⇒ force=false 也会把队列冲干净，「没攒够就别跑」的凑批语义没了' +
      '（batch=1 时 GPU 比 CPU 还慢 31%）',
  );
}

function flushShapeOf(src) {
  const fn = findFn(parse(src), 'flush');
  if (!fn) return { found: false, spliceInLoop: false, forceBreak: false };
  let spliceInLoop = false;
  let forceBreak = false;
  walk(fn.body, (node) => {
    if (node.type !== 'ForStatement' && node.type !== 'WhileStatement' && node.type !== 'DoWhileStatement') return;
    walk(node.body, (inner) => {
      if (
        inner.type === 'CallExpression' &&
        inner.callee &&
        inner.callee.type === 'MemberExpression' &&
        inner.callee.object &&
        inner.callee.object.name === 'batches' &&
        inner.callee.property &&
        inner.callee.property.name === 'splice'
      )
        spliceInLoop = true;
      if (
        inner.type === 'IfStatement' &&
        inner.test &&
        inner.test.type === 'UnaryExpression' &&
        inner.test.operator === '!' &&
        inner.test.argument &&
        inner.test.argument.name === 'force' &&
        inner.consequent &&
        inner.consequent.type === 'BreakStatement'
      )
        forceBreak = true;
    });
  });
  return { found: true, spliceInLoop, forceBreak };
}

function checkFlushDrainsQueue() {
  const workerSrc = read(TAG_WORKER_FILE);
  const shape = flushShapeOf(workerSrc);
  judgeFlushDrains(shape, '③ flush');
  // 反向验证：两条都必须有牙，而不是被对方掩护
  assert.throws(
    () => judgeFlushDrains({ found: true, spliceInLoop: false, forceBreak: true }, '③ 反向①'),
    /不在循环里/,
    '③ 反向①：单次 splice 必须被抓到',
  );
  assert.throws(
    () => judgeFlushDrains({ found: true, spliceInLoop: true, forceBreak: false }, '③ 反向②'),
    /if \(!force\) break/,
    '③ 反向②：丢了 `if (!force) break` 必须被抓到（凑批语义）',
  );
  assert.throws(
    () => judgeFlushDrains({ found: false }, '③ 反向③'),
    /锚点移位/,
    '③ 反向③：找不到函数时必须报锚点移位，不许静默通过',
  );
  console.log('[joytag-index-regression] ③ flush(force) 清空队列 ✓（牙齿 3）');
}

// ---------------------------------------------------------------- ④ 播种落点 === 读取落点

/**
 * 加载侧交出去的根目录 = **`models` 那一层**（`semantic-worker.js` 里
 * `const cacheDir = path.join(root, 'models')` 之后 `joytag.load(cacheDir)`）。
 * 而播种侧 `seedJoytag(modelsDir, searchAiPath)` 是**自己往里拼 `models/joytag`** ——
 * 两边对「根」的定义不同（一个给 ai 根、一个给 models 层），所以这里必须把接缝钉住：
 * 一旦有人把任一侧的层级改了，就会出现「播种成功、加载说没有模型」，
 * 而界面只会说「下载模型」，用户再点一次还是同一个结果。
 */
function checkLoaderRootMatchesSeedLayout() {
  // JoyTag 的加载在 tag worker（并行路）里 —— 拆分后接缝跟着代码走。
  const workerSrc = read(TAG_WORKER_FILE);
  const ast = parse(workerSrc);
  /**
   * ⚠️ 查找条件**只按「名字 + init 是个 `path.join(...)` 调用」**，不按里面有没有 `'models'`。
   * 早期版本把「必须含字面量 `models`」写进了查找条件，于是把层级改掉时**先找不到锚点**，
   * 报出来的是「锚点移位」而不是「层级错了」—— 断言还是红的，但诊断指错了方向
   * （注入验证抓到的：④b 那条红了、红的却不是预期那条）。
   * 同名的另一个 `cacheDir`（`createTagIndexTrack` 里的 `options.cacheDir`）init 是
   * MemberExpression，靠这个条件天然区分开。
   */
  const candidates = [];
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || !node.id || node.id.name !== 'cacheDir') return;
    if (node.init && node.init.type === 'CallExpression') candidates.push(node.init);
  });
  assert.equal(
    candidates.length,
    1,
    '④ semantic-tag-worker.js 里应当只有一处「模块级 `cacheDir = path.join(...)`」，实际 ' + candidates.length + ' 处',
  );
  const rootExpr = workerSrc.slice(candidates[0].start, candidates[0].end).replace(/\s+/g, '');
  assert.equal(
    rootExpr,
    "path.join(root,'models')",
    '④ 加载侧给的根必须仍是 `<root>/models`（模型在它下面的 joytag/）。改成别的层级 = 与播种落点错开，' +
      '表现是「播种成功、加载说没有模型」',
  );

  const seedSrc = read(path.join(ROOT, 'src', 'ai', 'bundled-models.js'));
  const seedAst = parse(seedSrc);
  let seedRoot = null;
  walk(findFn(seedAst, 'seedJoytag'), (node) => {
    if (seedRoot) return;
    if (node.type === 'VariableDeclarator' && node.id && node.id.name === 'root' && node.init)
      seedRoot = seedSrc.slice(node.init.start, node.init.end).replace(/\s+/g, '');
  });
  assert.equal(
    seedRoot,
    "path.join(searchAiPath,'models','joytag')",
    '④ 播种侧必须落在 `<ai 根>/models/joytag`（与上面加载侧的 `<root>/models` + `joytag/` 严丝合缝）',
  );
}

/**
 * 集成面：`ensureBundledModels` **到底有没有真的调 `seedJoytag`、路径传对没**。
 *
 * 上面 ④ 直接调 `seedJoytag` 验的是它自己；这里验的是**接线**。
 * 接线断了的表现很安静：随包目录里躺着 366 MB 权重、`seedJoytag` 一次都没被调用，
 * 一直到用户点「建索引」时才由 `joytag.load` 说一句「模型缺失」——
 * 而那时界面上的话是「下载模型」，跟「随包模型没被播种」完全不是一回事。
 */
function checkEnsureBundledModelsWiresJoytag() {
  const modelsDir = tempRoot('bundle-all');
  const faceAi = tempRoot('bundle-face');
  const searchAi = tempRoot('bundle-search');
  const put = (rel, byte) => {
    const abs = path.join(modelsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(64, byte));
    return abs;
  };
  const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  const searchFile = put('search/onnx-community/x/config.json', 1);
  put('face/yunet.onnx', 2);
  const joinTagFile = put('joytag/' + joytag.MODEL.name, 3);
  fs.writeFileSync(
    path.join(modelsDir, bundled.MANIFEST_FILE),
    JSON.stringify({
      version: bundled.MANIFEST_VERSION,
      // face 那一节 `seedFace` 不看（它只列目录），但报告要有
      face: { version: 'fixture', files: [{ bytes: 64, sha256: sha(path.join(modelsDir, 'face/yunet.onnx')), name: 'yunet.onnx' }] },
      search: {
        model: 'x',
        modelKey: 'fixture-key',
        files: [{ bytes: 64, sha256: sha(searchFile), path: 'onnx-community/x/config.json' }],
      },
      joytag: {
        model: TAG_INDEX_MODEL,
        version: joytag.VERSION,
        files: [{ bytes: 64, sha256: sha(joinTagFile), path: joytag.MODEL.name }],
      },
    }),
  );

  const report = bundled.ensureBundledModels({
    modelsDir,
    faceAiPath: faceAi,
    searchAiPath: searchAi,
    modelKey: 'fixture-key',
  });
  assert.equal(report.face.status, 'seeded', '④c 前提：人脸一侧也要播成功，否则下面的 reportSaysCopied 断言测不到东西');
  assert.equal(report.search.status, 'seeded', '④c 前提：搜图一侧也要播成功');
  assert.ok(report.joytag, '④c `ensureBundledModels` 的报告里必须有 joytag 一节（漏了 = 播了也会被当成「没播」）');
  assert.equal(
    report.joytag.status,
    'seeded',
    '④c `ensureBundledModels` 没有把 JoyTag 播下去（接线断了 / 路径传错）—— 实际 ' + JSON.stringify(report.joytag),
  );
  assert.ok(
    fs.existsSync(joytag.modelPath(path.join(searchAi, 'models'))),
    '④c 集成面：播下去的 JoyTag 权重必须落在 joytag.modelPath() 能找到的位置',
  );
  assert.equal(
    bundled.reportSaysCopied(report),
    true,
    '④c `reportSaysCopied` 必须把 joytag 的 copied 算进来 —— 漏了就是「真播了却不打日志」',
  );

  // 第二趟：三边都已就绪 ⇒ 一个字节都不拷，也不该打日志
  const again = bundled.ensureBundledModels({
    modelsDir,
    faceAiPath: faceAi,
    searchAiPath: searchAi,
    modelKey: 'fixture-key',
  });
  assert.equal(again.joytag.status, 'already-complete', '④c 第二趟 JoyTag 必须报 already-complete');
  assert.equal(again.joytag.copied, 0, '④c 第二趟不许再拷');
  assert.equal(bundled.reportSaysCopied(again), false, '④c 第二趟什么都没拷 ⇒ 不该打日志');
  console.log('[joytag-index-regression] ④c ensureBundledModels 真的播了 JoyTag ✓（含 reportSaysCopied 与幂等）');
}

function checkSeedLandsWhereModelIsRead() {
  const modelsDir = tempRoot('models');
  const aiPath = tempRoot('ai');
  /**
   * 用一份**假权重**（4 KB），但 manifest 里**如实**记它的字节数与 sha256 ——
   * 这样 `seedJoytag` 的三条分支（复制 / 复制后逐文件校验 / 已就绪快路径）都能走到，
   * 而不必在回归里搬 366 MB。
   */
  const fake = Buffer.alloc(4096, 7);
  fs.mkdirSync(path.join(modelsDir, 'joytag'), { recursive: true });
  fs.writeFileSync(path.join(modelsDir, 'joytag', joytag.MODEL.name), fake);
  fs.writeFileSync(
    path.join(modelsDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      joytag: {
        model: TAG_INDEX_MODEL,
        version: joytag.VERSION,
        files: [
          {
            bytes: fake.length,
            sha256: crypto.createHash('sha256').update(fake).digest('hex'),
            path: joytag.MODEL.name,
          },
        ],
      },
    }),
  );

  const first = bundled.seedJoytag(modelsDir, aiPath);
  assert.equal(first.status, 'seeded', '④ 第一次播种必须是 seeded，实际 ' + JSON.stringify(first));
  assert.equal(first.copied, 1);
  /**
   * 🔴 **这条才是重点**：播种写下去的文件，必须能被加载侧那条路径函数**找到**。
   * 注意两侧对「根」的约定不同（见 `checkLoaderRootMatchesSeedLayout`）：
   * 播种收的是 **ai 根**，`modelPath()` 收的是 **models 层**。
   */
  const loadRoot = path.join(aiPath, 'models');
  assert.ok(
    fs.existsSync(joytag.modelPath(loadRoot)),
    '④ 播种落点必须正是 joytag.modelPath(<ai 根>/models) 指的位置（写到别处 = 「模型随包」形同虚设）',
  );
  assert.deepEqual(fs.readFileSync(joytag.modelPath(loadRoot)), fake, '④ 播种必须逐字节复制');

  const second = bundled.seedJoytag(modelsDir, aiPath);
  assert.equal(second.status, 'already-complete', '④ 第二次必须走快路径，实际 ' + JSON.stringify(second));
  assert.equal(second.copied, 0, '④ 第二次不许再拷（真权重是 366 MB，每次启动白拷一遍）');

  // hash-mismatch：manifest 声明与源文件不符时必须**如实报**，不许当成功
  fs.writeFileSync(path.join(modelsDir, 'joytag', joytag.MODEL.name), Buffer.alloc(4096, 8));
  const bad = bundled.seedJoytag(modelsDir, tempRoot('ai-bad'));
  assert.equal(bad.status, 'hash-mismatch', '④ 源文件与 manifest 不符必须报 hash-mismatch，实际 ' + bad.status);

  // 旧 manifest（没有 joytag 一节）→ no-bundle，且**不许凭空造目录**
  const bare = tempRoot('bare');
  fs.writeFileSync(path.join(bare, 'manifest.json'), JSON.stringify({ version: 1 }));
  const bareAi = tempRoot('bare-ai');
  assert.equal(bundled.seedJoytag(bare, bareAi).status, 'no-bundle', '④ 没有 joytag 一节必须报 no-bundle');
  assert.equal(
    fs.existsSync(path.join(bareAi, 'models', 'joytag')),
    false,
    '④ 没东西可播时不许凭空造出 joytag 目录（与「可写句柄凭空造库」同一条纪律：把「没有」伪装成「空的」）',
  );
  console.log('[joytag-index-regression] ④ 播种落点 === 读取落点 ✓（含 no-bundle 不造目录）');
}

// ---------------------------------------------------------------- ⑤ 归一化常数

function checkNormalizeUsesClipConstants() {
  const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
  const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
  assert.deepEqual(joytag.MEAN, CLIP_MEAN, '⑤ MEAN 必须是 CLIP 那一套（JoyTag 官方实现用的就是它）');
  assert.deepEqual(joytag.STD, CLIP_STD, '⑤ STD 必须是 CLIP 那一套，不是 ImageNet 的 0.229/0.224/0.225');

  /**
   * 三个像素：黑 / 白 / 只有红通道。宽度 3 ⇒ n=3，CHW 下通道 c 从 `out[c*3]` 起。
   * 第三个像素（通道值互异）是**故意加的**：只用黑、白两个均匀像素的话，
   * 把 CHW 写成 HWC 也能全过 —— 那是个不会报错、只是分数整体偏掉的错。
   */
  const out = joytag.normalize({
    data: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 0, 0]),
    info: { width: 3, height: 1 },
  });
  assert.equal(out.length, 9, '⑤ 输出必须是 CHW 的 3×3');
  const expect = (c, v) => (v / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
  for (let c = 0; c < 3; c += 1) {
    assert.ok(Math.abs(out[c * 3] - expect(c, 0)) < 1e-6, '⑤ 通道 ' + c + ' 的黑点归一化值不对');
    assert.ok(Math.abs(out[c * 3 + 1] - expect(c, 255)) < 1e-6, '⑤ 通道 ' + c + ' 的白点归一化值不对');
    assert.ok(
      Math.abs(out[c * 3 + 2] - expect(c, c === 0 ? 255 : 0)) < 1e-6,
      '⑤ 通道 ' + c + ' 在「只有红通道」那个像素上不对 —— 归一化必须按 CHW 排（写成 HWC 不报错、只是整体偏）',
    );
  }
  // 反向验证：上面那几条必须**有区分力**（换成 ImageNet 的 std 要算出明显不同的值）
  const imagenetStd = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c += 1) {
    const delta = Math.abs((1 - CLIP_MEAN[c]) / imagenetStd[c] - (1 - CLIP_MEAN[c]) / CLIP_STD[c]);
    assert.ok(delta > 0.1, '⑤ 反向验证：通道 ' + c + ' 用 ImageNet 的 std 必须算出明显不同的值，实际差 ' + delta);
  }
  console.log('[joytag-index-regression] ⑤ 归一化用 CLIP 常数 + CHW 排列 ✓（牙齿 3 条：ImageNet 差 > 0.1）');
}

// ---------------------------------------------------------------- ⑥ PREP_SPEC 与链子对账

/** `resize` 第一实参若是数字字面量则返回它，否则 null（`INPUT_SIZE` 这类标识符走另一支）。 */
const literalNumber = (node) => (node && node.type === 'Literal' && typeof node.value === 'number' ? node.value : null);
const objectProp = (node, name) =>
  node && node.type === 'ObjectExpression'
    ? (node.properties.find((p) => p.key && (p.key.name || p.key.value) === name) || null)
    : null;

function checkPrepSpecMatchesChain() {
  assert.equal(joytag.INPUT_SIZE, 448, '⑥ 输入边长必须是 448（改它等于换模型）');
  const modelSrc = read(MODEL_FILE);

  const srcResize = resizeArgs(modelSrc, 'prepareSource');
  assert.equal(srcResize.length, 1, '⑥ prepareSource 里必须恰好一条 resize');
  assert.equal(literalNumber(srcResize[0][0]), 512, '⑥ prepareSource 的 resize 边长必须是 512');
  assert.equal(literalNumber(srcResize[0][1]), 512, '⑥ prepareSource 的 resize 必须是正方形（512, 512）');
  const srcFit = objectProp(srcResize[0][2], 'fit');
  assert.ok(srcFit, '⑥ prepareSource 的 resize 必须带 fit 选项');
  assert.equal(srcFit.value.value, 'inside', '⑥ prepareSource 的 fit 必须是 inside（不是 cover/fill —— 那会裁剪或变形）');
  const noEnlarge = objectProp(srcResize[0][2], 'withoutEnlargement');
  assert.ok(noEnlarge && noEnlarge.value.value === true, '⑥ prepareSource 必须 withoutEnlargement（小图不许放大）');

  const inResize = resizeArgs(modelSrc, 'prep448');
  assert.equal(inResize.length, 1, '⑥ prep448 里必须恰好一条 resize');
  assert.equal(inResize[0][0].name, 'INPUT_SIZE', '⑥ prep448 的 resize 必须用 INPUT_SIZE，不许再写一个字面量');
  assert.equal(inResize[0][1].name, 'INPUT_SIZE', '⑥ prep448 的 resize 必须用 INPUT_SIZE');
  const inFit = objectProp(inResize[0][2], 'fit');
  assert.ok(inFit, '⑥ prep448 的 resize 必须带 fit 选项');
  assert.equal(inFit.value.value, 'contain', '⑥ prep448 的 fit 必须是 contain（448 撑满、白底补边）');

  /**
   * 🔴 **对账**：`PREP_SPEC` 是从链子里的数字**推出来**的，不是另写一句。
   * 手写一句的写法在「改了 512 → 640」时完全失效：索引里记着旧口径，
   * 而新旧两批分数会被当成同一口径混在一个库里查。
   */
  const expected = '512' + 'inside-jpeg->' + String(joytag.INPUT_SIZE) + 'contain-raw';
  assert.equal(
    joytag.PREP_SPEC,
    expected,
    '⑥ PREP_SPEC（' + joytag.PREP_SPEC + '）与链子里的数字对不上（应为 ' + expected + '）—— ' +
      'tag_meta 会把口径记成一句谎话，而换个链子重建之后旧分数不会被认出来',
  );
  // 反向验证：那条对账句子必须真的会随数字变
  assert.notEqual('512' + 'inside-jpeg->' + '640' + 'contain-raw', joytag.PREP_SPEC, '⑥ 反向验证：640 的链子必须与 448 的 PREP_SPEC 不同');
  console.log('[joytag-index-regression] ⑥ PREP_SPEC 与链子数字对账 ✓');
}

// ---------------------------------------------------------------- ⑦ 索引身份不许写字面量

function checkIdentityComesFromSingleSource() {
  // writeIdentity 在 tag worker（并行路）里 —— 拆分后身份契约跟着代码走。
  const workerSrc = read(TAG_WORKER_FILE);
  const pairs = setMetaArgs(workerSrc, 'writeIdentity');
  const byKey = new Map(pairs.map((args) => [String(args[0].value), args[1]]));
  for (const key of ['model', 'prep_spec', 'min_score']) {
    assert.ok(byKey.has(key), '⑦ writeIdentity 必须写 `' + key + '`（索引身份少一项就判不出「这份索引是哪一版建的」）');
  }
  assert.equal(byKey.get('model').name, 'TAG_INDEX_MODEL', '⑦ model 必须取 TAG_INDEX_MODEL（不是 joytag.VERSION —— 后者是权重名）');
  assert.equal(
    byKey.get('prep_spec').type === 'MemberExpression' && byKey.get('prep_spec').property.name,
    'PREP_SPEC',
    '⑦ prep_spec 必须取 joytag.PREP_SPEC',
  );
  const minScore = byKey.get('min_score');
  assert.equal(minScore.type, 'CallExpression', '⑦ min_score 必须 `String(STORE_MIN_SCORE)`；直接写数字就是第二份口径');
  assert.equal(minScore.callee.name, 'String');
  assert.equal(minScore.arguments[0].name, 'STORE_MIN_SCORE', '⑦ min_score 必须取 STORE_MIN_SCORE（入库线唯一源）');
  assert.equal(typeof STORE_MIN_SCORE, 'number', '⑦ 前提：STORE_MIN_SCORE 是数字（否则 String() 的用法要重看）');
  console.log('[joytag-index-regression] ⑦ 索引身份取自唯一真相源 ✓（min_score = ' + STORE_MIN_SCORE + '）');
}

// ---------------------------------------------------------------- ⑧⑨ 权重身份

function checkManifestMatchesCode() {
  const manifest = JSON.parse(read(MANIFEST_FILE));
  const section = manifest && manifest.joytag;
  assert.ok(section, '⑧ models/manifest.json 必须有 joytag 一节（没有它，播种层拿到的是 no-bundle ⇒ 随包形同虚设）');
  assert.equal(section.model, TAG_INDEX_MODEL, '⑧ manifest 的 model 必须与 tag_meta.model 同族');
  assert.equal(section.version, joytag.VERSION, '⑧ manifest 的 version 必须与代码里的 VERSION 一致');
  assert.equal(section.files.length, 1, '⑧ JoyTag 随包的就是一份权重');
  assert.equal(section.files[0].path, joytag.MODEL.name, '⑧ 权重文件名必须与 MODEL.name 一致');
  assert.equal(section.files[0].bytes, joytag.MODEL.bytes, '⑧ manifest 的字节数必须与代码里的 MODEL.bytes 一致');
  assert.equal(section.files[0].sha256, joytag.MODEL.sha256, '⑧ manifest 的 sha256 必须与代码里的一致（两份各写一份就会漂）');
  console.log('[joytag-index-regression] ⑧ manifest 与代码身份一致 ✓');
}

function checkVerifyHasTeeth() {
  const empty = tempRoot('verify-empty');
  assert.equal(joytag.verify(empty), false, '⑨ 目录里什么都没有时必须返回 false（且不抛）');

  const dir = tempRoot('verify');
  fs.mkdirSync(path.join(dir, 'joytag'), { recursive: true });
  const file = path.join(dir, 'joytag', joytag.MODEL.name);
  fs.writeFileSync(file, Buffer.alloc(1024));
  assert.equal(joytag.verify(dir), false, '⑨ 尺寸不对必须 false');

  /**
   * 尺寸**对**、内容不对 —— 用稀疏文件（`truncate` 到 366 MB）造，别真写 366 MB 的零。
   * 这条是证明「它真的算哈希」的唯一方式：只看尺寸的实现会在这里返回 true。
   */
  fs.writeFileSync(file, '');
  fs.truncateSync(file, joytag.MODEL.bytes);
  assert.equal(fs.statSync(file).size, joytag.MODEL.bytes, '⑨ 前提：稀疏文件尺寸已对齐');
  assert.equal(joytag.verify(dir), false, '⑨ 尺寸对、内容不对必须 false —— 这条一红就说明 verify 退化成了「只看尺寸」');
  console.log('[joytag-index-regression] ⑨ verify() 有牙 ✓（缺失 / 尺寸错 / 哈希错 三支都判 false）');
}

function checkRepoBundleIfPresent() {
  const modelsDir = path.join(ROOT, 'models');
  const file = joytag.modelPath(modelsDir);
  if (!fs.existsSync(file)) {
    // 明确打印而不是静默跳过：`models/` 不进版本库，新克隆的机器上必然没有这一条。
    console.log(
      '[joytag-index-regression] ⑩ 跳过：仓库内没有 models/joytag/' +
        joytag.MODEL.name +
        '（models/ 不进版本库；打包前由 scripts/bundle-models.js --joytag 写入）',
    );
    return;
  }
  assert.equal(
    joytag.verify(modelsDir),
    true,
    '⑩ 仓库里的 models/joytag/' + joytag.MODEL.name + ' 校验不过 —— 「模型随包」的物理前提没了（截断 / 换版 / 被误删）',
  );
  console.log('[joytag-index-regression] ⑩ 仓库内权重校验通过 ✓（' + joytag.MODEL.bytes + ' B）');
}

// ---------------------------------------------------------------- ⑪ 双 worker 并行（2026-10-08 拆分）

/**
 * 「CLIP(cpu) ∥ JoyTag(dml)」并行落地后的结构契约。实测 1.41×（588 → 416 ms/张，
 * 重叠率 100%），前提与代价见 `docs/contracts/semantic-search.md`「两条路并行」一节。
 * 这里钉四件事：
 *   a. **拆分是真的**：CLIP worker 里不许残留 tag 建索引的代码（`offer()` 已退役、
 *      track 已搬走）—— 残留 = 两套取批口径共存，哪边后写哪边赢。
 *   b. **tag worker 不碰共享进度字段**：不发 `phase:` 帧 —— `phase` 是父进程 state 的
 *      共享字段，两个 worker 并行时谁后到谁赢，且不报错。
 *   c. **tag worker 不许载 CLIP 那一份 ORT**：不许 require `../ai/embedding`
 *      （同进程多 ONNX 会话只有 `cpu + dml` 能跑；载 transformers 还会把
 *      `onnxruntime.dll` 的次序问题带回这个进程）。
 *   d. **主进程的编排与结算**：index 必须 spawn 两个 worker、`run()`/`start()`/`cancel()`
 *      必须把 tag worker 当占用人看；两路收场必须走 `mergeIndexOutcomes`（纯函数，
 *      结算规则在这里直接喂用例 —— 8 例含 1 阴性）。
 */
function checkParallelSplit() {
  const clipSrc = read(WORKER_FILE);
  const tagSrc = read(TAG_WORKER_FILE);
  const mainSrc = read(SEARCH_FILE);

  for (const token of ['createTagIndexTrack', 'tagTrack', 'TAG_SCAN_WINDOW'])
    assert.ok(
      !clipSrc.includes(token),
      '⑪ CLIP worker 里不该再有「' + token + '」—— tag 建索引已搬去 semantic-tag-worker.js，残留 = 两套取批口径共存',
    );
  assert.ok(
    !/progress\(\s*\{\s*phase/.test(tagSrc),
    '⑪ tag worker 不许发 phase 帧 —— phase 是父进程 state 的共享字段，两个 worker 并行时谁后到谁赢',
  );
  assert.ok(
    // 只认 require 调用本身：头注释里「不 require …」那句说明不是代码（元规则③的注释豁免面）。
    !/require\(\s*['"]\.\.\/ai\/embedding['"]\s*\)/.test(tagSrc),
    '⑪ tag worker 不许 require ../ai/embedding —— 本进程只许有 joytag 一份 ORT（载 transformers 会带回 DLL 次序问题）',
  );
  assert.ok(
    mainSrc.includes("'semantic-tag-worker.js'"),
    '⑪ 主进程的 spawn 必须起 semantic-tag-worker.js（丢了 = index 只有 CLIP 一路在跑，tag 索引永远不建且全绿）',
  );
  assert.match(
    mainSrc,
    /if \(this\.tagWorker\) return Promise\.reject\(new Error\('AI_BUSY'\)\);/,
    '⑪ run() 必须挡住 tag worker 占用期间的第二个 index/install（漏了 = 两套 CLIP + 一套 JoyTag 同进程并存）',
  );
  assert.match(
    mainSrc,
    /this\.worker \|\| this\.tagWorker\) throw new Error\('AI_BUSY'\)/,
    '⑪ start() 必须同时看两路 worker（只看 CLIP 路 = tag 收尾期再点一次建索引直接放行）',
  );
  assert.match(
    mainSrc,
    /if \(this\.tagWorker\) this\.tagWorker\.postMessage\(\{ cancel: true \}\);/,
    '⑪ cancel() 必须两路都停（只停 CLIP = JoyTag 继续跑几天而面板停在 stopping）',
  );

  // 结算规则（纯函数）：取消/错误/结果合并，8 例。
  const { mergeIndexOutcomes } = require(SEARCH_FILE);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const case_ = (name, clip, tag, expect) =>
    assert.ok(
      same(mergeIndexOutcomes(clip, tag), expect),
      '⑪ 结算规则「' + name + '」漂了：期望 ' + JSON.stringify(expect) + '，实际 ' + JSON.stringify(mergeIndexOutcomes(clip, tag)),
    );
  case_('双成合并 tags', { done: true, result: { indexed: 5, done: 5, failed: 0 } }, { done: true, result: { tags: { done: 7 } } }, { result: { indexed: 5, done: 5, failed: 0, tags: { done: 7 } } });
  case_('双取消', { error: 'AI_CANCELLED' }, { error: 'AI_CANCELLED' }, { error: 'AI_CANCELLED' });
  case_('CLIP 真崩 + tag 被取消 ⇒ 报真错', { error: 'boom' }, { error: 'AI_CANCELLED' }, { error: 'boom' });
  case_('CLIP 被取消 + tag 真崩 ⇒ 报真错', { error: 'AI_CANCELLED' }, { error: 'boom' }, { error: 'boom' });
  case_('tag 没发信封（硬崩）⇒ 不许静默少一半', { done: true, result: { indexed: 5 } }, null, { error: 'AI_WORKER_EXIT' });
  case_('CLIP 没发信封（硬崩）', null, { done: true, result: { tags: {} } }, { error: 'AI_WORKER_EXIT' });
  case_('tag 结果没有 tags 键 ⇒ 不许造', { done: true, result: { indexed: 5 } }, { done: true, result: {} }, { result: { indexed: 5 } });
  case_('阴性对照：规则 ③ 的 tags 必须来自 tag 路', { done: true, result: { tags: { done: 999 } } }, { done: true, result: { tags: { done: 1 } } }, { result: { tags: { done: 1 } } });
  console.log('[joytag-index-regression] ⑪ 双 worker 并行 ✓（拆分 / 进度隔离 / ORT 独占 / 编排 + 结算 8 例）');
}

// ---------------------------------------------------------------- 主流程

try {
  checkPrepChainSame();
  checkProgressNamespaces();
  checkTagPctDerived();
  checkFlushDrainsQueue();
  checkLoaderRootMatchesSeedLayout();
  checkSeedLandsWhereModelIsRead();
  checkEnsureBundledModelsWiresJoytag();
  checkNormalizeUsesClipConstants();
  checkPrepSpecMatchesChain();
  checkIdentityComesFromSingleSource();
  checkManifestMatchesCode();
  checkVerifyHasTeeth();
  checkRepoBundleIfPresent();
  checkParallelSplit();
  console.log('[joytag-index-regression] PASS');
} finally {
  cleanup();
}
