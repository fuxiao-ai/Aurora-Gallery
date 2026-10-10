'use strict';

/**
 * 「搜图模型是否就绪」（`ready`）的**判据与求值时机** 的回归。
 *
 * 这条链路的坏法全是静默的：模型文件明明齐全（`ready.json` 与 `MODEL_KEY` 逐字一致、
 * 两份量化 onnx 都在），界面却写着「本地模型尚未就绪 / 请在桌面端完成下载」，
 * 而库里索引跑得好好的、搜图也能出结果。
 *
 * 根因不是文件缺失，是 `ready` 曾经**只是个缓存值**：起手 `false`，只在某个任务
 * （`install` / `status`）跑完时按白名单写回；而 `refresh()` 只在 `phase === 'idle'`
 * 时才去跑一次 `status` 探明它。于是有一条**不需要任何错误就能走通**的失效链：
 *
 *   ① 进程起来：`phase = 'idle'`、`ready = false`（起手值）；
 *   ② 第一个 AI 动作是「建立索引」⇒ `phase` 变成 `'index'`；
 *   ③ 索引跑完 ⇒ `phase = 'complete'`。而 **`index` 的返回值里没有 `ready`**
 *      （只有 `install` / `status` 带），所以它一直是 `false`；
 *   ④ 此后**再没有任何代码会去探它**，直到重启。
 *
 * 修法：把它降格成「一个文件的属性」并在状态快照里**按磁盘实况派生**，
 * 且主进程与 worker 共用同一个判据函数。本回归钉住五件事：
 *
 *   ① `status()` 必须**有且只有一处**从磁盘派生 `ready`（回落到缓存值 / 常量 / 别的路径都算坏）；
 *   ② 行为层：磁盘就绪 ⇒ 即便缓存值仍是 `false`，快照也必须是 `true`，且**全程不许起 worker**
 *      —— 如果它又要靠起 worker 才知道，那 `AI_BUSY`（索引在跑时 `status` 会被拒）那条路就还在；
 *   ③ worker **不许**自带第二份判据（不许自己拼 `ready.json`），必须用共用函数；
 *   ④ 共用判据所在的 `bundled-models.js` 必须**能被主进程 require**：顶层只许碰 `fs`/`path`/`crypto`；
 *   ⑤ `MODEL_KEY` 全仓只有一处定义 —— 两份定义就等于两代模型，`ready.json` 认哪一份都说不清。
 *
 * ⚠️ 结构断言一律走 acorn **剥注释后**再匹配：源码正文里刻意引用了旧的 `ready.json` 写法
 *    来记录原委（`gpu-probe-regression.js` 已有先例）。第 ③ 组尤其如此 —— 那条注释本身
 *    就含 `ready.json` 字样，不剥注释会把注释当结构判据、变成一个「谁也别想写注释」的假门。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const SERVICE = path.join(ROOT, 'src', 'main', 'semantic-search.js');
const WORKER = path.join(ROOT, 'src', 'workers', 'semantic-worker.js');
const BUNDLED = path.join(ROOT, 'src', 'ai', 'bundled-models.js');

const bundled = require('../src/ai/bundled-models');
const { SemanticSearch } = require('../src/main/semantic-search');
const { MODEL_KEY } = require('../src/ai/embedding');

const STALE_KEY = MODEL_KEY + ':stale';
const REL_SERVICE = 'src/main/semantic-search.js';
const REL_WORKER = 'src/workers/semantic-worker.js';
const REL_BUNDLED = 'src/ai/bundled-models.js';
const REL_EMBEDDING = 'src/ai/embedding.js';

// ---------------------------------------------------------------------------
// 通用：解析 / 剥注释 / 遍历
// ---------------------------------------------------------------------------

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowHashBang: true,
  allowReturnOutsideFunction: true,
};

function parse(src) {
  return acorn.parse(src, PARSE_OPTIONS);
}

/** 注释整段替换成空格（保留换行，行号不错位），此后结构匹配才不会被注释里的旧写法带偏。 */
function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ...PARSE_OPTIONS,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const range of ranges) {
    parts.push(src.slice(cur, range[0]));
    parts.push(src.slice(range[0], range[1]).replace(/[^\n]/g, ' '));
    cur = range[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}

function readStripped(file) {
  return stripComments(fs.readFileSync(file, 'utf8'));
}

/** 遍历 AST 里所有节点（只走真节点，跳过 start/end/loc/range 这类元信息）。 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    walk(node[key], visit);
  }
}

function toPosix(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function replaceOnce(src, needle, replacement) {
  const count = src.split(needle).length - 1;
  assert.equal(count, 1, '注入探针自身的执行条件不成立：要替换的片段在源码里出现了 ' + count + ' 次 —— ' + JSON.stringify(needle));
  return src.split(needle).join(replacement);
}

function removeTree(dir) {
  // Windows 上 `rmSync(recursive)` 的 maxRetries 默认是 0：目录里任何一个文件被索引器 /
  // 杀软短暂占用就会抛 ENOTEMPTY，让「断言全绿」的脚本挂在收尾那行（2026-10-05 实际踩到）。
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** 「反向验证」：把被测的那条判据整个破坏掉，裁判必须变红；不变红就说明这道门没有牙。 */
function expectReject(judge, mutated, label) {
  let threw = false;
  try {
    judge(mutated);
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, true, '反向验证没通过：' + label + ' 之后裁判仍然判『合规』 ⇒ 这条断言没有牙');
}

/**
 * 断言「这段源码里有这个形状」，失败时**只打一句人话**。
 *
 * ⚠️ 别写成 `assert.match(<整份源码>, /…/)`：断言一红，node 会把 `actual` 里那份源码
 *    整段倒进日志（实测一条断言 3 万字，把 CI 输出淹掉）。守门的报错必须能一眼看懂，
 *    否则第一个红出现时人看到的是源码墙、而不是「哪条契约破了」。
 */
function assertHas(src, regex, message) {
  if (!regex.test(src)) throw new Error(message);
}

// ---------------------------------------------------------------------------
// ① status() 必须按磁盘派生 ready
// ---------------------------------------------------------------------------

/**
 * 找 `status()` **方法体内部**对 `ready` 的赋值，返回赋值语句原文数组。
 *
 * 🔴 必须限定在方法体内：构造函数起手值 `{ running, ready, indexed, phase }`、
 *    `spawn` 里那份 worker 回写白名单都含 `ready` 字样。用全仓正则匹配，
 *    「把那行派生删掉」之后照样能匹配到它们 ⇒ 断言恒绿。
 */
function readyAssignments(src) {
  const ast = parse(src);
  let body = null;
  walk(ast, (node) => {
    if (body) return;
    const isMethod =
      node.type === 'MethodDefinition' || node.type === 'PropertyDefinition' || node.type === 'Property';
    if (isMethod && node.key && node.key.name === 'status' && node.value && node.value.body) body = node.value.body;
  });
  if (!body) throw new Error(REL_SERVICE + ' 里找不到 status() 方法体 —— 断言自己要先炸，不能恒绿');
  const rows = [];
  walk(body, (node) => {
    if (node.type !== 'AssignmentExpression') return;
    if (!node.left || node.left.type !== 'MemberExpression') return;
    if (!node.left.property || node.left.property.name !== 'ready') return;
    rows.push(src.slice(node.start, node.end));
  });
  return rows;
}

/**
 * 裁判：`status()` 里**有且只有一处**把 `ready` 从磁盘派生出来。
 *
 * 只钉「值从哪来」（`isSearchReady(this.aiPath, MODEL_KEY)`），不钉左边那个局部变量叫什么
 * —— 钉名字属于钉实现细节，将来重命名会变成假红。
 */
function judgeReadyDerived(src) {
  assertHas(
    src,
    /require\(\s*['"][^'"]*ai\/bundled-models['"]\s*\)/,
    REL_SERVICE + '：必须 require ../ai/bundled-models（判据只许有一处实现，自己抄一份必然漂）',
  );
  const rows = readyAssignments(src);
  assert.equal(
    rows.length,
    1,
    REL_SERVICE + '：status() 里必须**有且只有一处**给 ready 赋值，实际 ' + rows.length + ' 处 ' + JSON.stringify(rows),
  );
  assert.match(
    rows[0],
    /^\w+\.ready\s*=\s*isSearchReady\(this\.aiPath\s*,\s*MODEL_KEY\)$/,
    REL_SERVICE + '：ready 必须由 isSearchReady(this.aiPath, MODEL_KEY) 按磁盘实况派生' +
      '（回落到缓存值 / 常量 / 别的目录都算坏），实际是 ' + rows[0],
  );
}

function testStatusDerivesFromDiskStatically() {
  const src = readStripped(SERVICE);
  judgeReadyDerived(src); // 正向：当前源码必须合规

  // 反向 ①：整行删掉（回落到 `{...this.state}` 里的缓存值）⇒ 必须红
  const line = 'out.ready = isSearchReady(this.aiPath, MODEL_KEY);';
  expectReject(() => judgeReadyDerived(replaceOnce(src, line, '')), '删掉 ready 的派生行');
  // 反向 ②：改用缓存值 ⇒ 必须红（这条才是这次修的那个 bug 的形状）
  expectReject(
    () => judgeReadyDerived(replaceOnce(src, line, 'out.ready = this.state.ready;')),
    '把 ready 换回缓存值',
  );
  // 反向 ③：常量 ⇒ 必须红
  expectReject(() => judgeReadyDerived(replaceOnce(src, line, 'out.ready = true;')), '把 ready 写死成常量');
  // 反向 ④：换了目录 ⇒ 必须红（判的就该是模型真正所在的那个目录）
  expectReject(
    () =>
      judgeReadyDerived(
        replaceOnce(src, line, 'out.ready = isSearchReady(path.join(this.aiPath, "x"), MODEL_KEY);'),
      ),
    '把 ready 判到别的目录上',
  );
  // 反向 ⑤：整个 require 拿掉 ⇒ 必须红
  expectReject(
    () => judgeReadyDerived(replaceOnce(src, "require('../ai/bundled-models')", 'require("../ai/nope")')),
    '不再 require 共用判据',
  );
}

// ---------------------------------------------------------------------------
// ② 行为层：磁盘就绪 ⇒ 快照就绪，且一次 worker 都不起
// ---------------------------------------------------------------------------

/**
 * 造一个「只用来问状态」的替身：`state` 停在**那条失效链的终点**（缓存 `ready:false`、
 * `phase:'complete'`），并把 `run` 换成计数器 —— 于是「它到底有没有偷偷起 worker」可观测。
 *
 * 用 `Object.create(prototype)` 而不是 `new`：构造函数只做赋值，而 `run()` 一旦被调到会
 * 真的去 spawn 一个 worker（要 Electron ABI 的 better-sqlite3）。
 */
function fakeService(aiPath) {
  const service = Object.create(SemanticSearch.prototype);
  let runs = 0;
  service.config = { operations: ['status'] };
  service.dbPath = path.join(aiPath, 'photos.db');
  service.aiPath = aiPath;
  service.worker = null;
  service.replies = new Map();
  service.ticket = 0;
  service.state = { running: false, ready: false, indexed: 0, phase: 'complete' };
  service.run = () => {
    runs++;
    return Promise.reject(new Error('AI_BUSY'));
  };
  service.runs = () => runs;
  return service;
}

function testStatusDerivesFromDiskAtRuntime() {
  const aiPath = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-model-ready-'));
  const readyFile = path.join(aiPath, bundled.READY_FILE);
  try {
    const service = fakeService(aiPath);

    // ① 还没有 ready.json ⇒ 未就绪
    assert.equal(service.status().ready, false, '没有 ready.json 时必须是未就绪');
    assert.equal(service.runs(), 0, 'status() 不许为了 ready 起 worker');

    // ② 磁盘就绪，而**缓存值仍停在 false**（正是那条失效链留下的状态）⇒ 快照必须是 true
    bundled.writeSearchReady(aiPath, MODEL_KEY);
    assert.equal(service.state.ready, false, '夹具前提：缓存值停在 false');
    assert.equal(service.state.phase, 'complete', '夹具前提：正是「索引跑完」那个 phase，refresh() 不会再探它');
    const snapshot = service.status();
    assert.equal(
      snapshot.ready,
      true,
      '磁盘就绪时快照必须说就绪 —— 用户 2026-10-08 报的「显示模型未下载」就是这一条',
    );
    assert.notEqual(snapshot, service.state, 'status() 必须返回新对象，不许把派生值写回 state');
    assert.equal(service.state.ready, false, '派生不许污染缓存值（它仍是「上一次任务的结果」）');
    assert.equal(service.runs(), 0, '整个过程一次 worker 都不许起 —— 否则 AI_BUSY 那条路还在');

    // ③ 上一代留下的 ready.json（model 字段对不上）⇒ 未就绪
    bundled.writeSearchReady(aiPath, STALE_KEY);
    assert.equal(service.status().ready, false, 'model 字段对不上当前这一代时必须判未就绪');

    // ④ 坏 JSON ⇒ 未就绪，且**不许抛**（状态查询是只读动作，不该被一个坏文件搞崩）
    fs.writeFileSync(readyFile, '{ not json');
    assert.equal(service.status().ready, false, 'ready.json 坏掉时必须是未就绪');

    // ⑤ 目录整个不存在 ⇒ 未就绪，且不许抛
    removeTree(aiPath);
    assert.equal(service.status().ready, false, '目录不存在时必须是未就绪');
  } finally {
    removeTree(aiPath);
  }
}

// ---------------------------------------------------------------------------
// ③ worker 不许自带第二份判据
// ---------------------------------------------------------------------------

/** worker 里所有「含 ready.json 的字符串字面量」——一个都不该有（路径归 bundled-models）。 */
function readyJsonLiterals(src) {
  const hits = [];
  walk(parse(src), (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes('ready.json')) {
      hits.push(src.slice(node.start, node.end));
    }
  });
  return hits;
}

/**
 * 修之前 worker 里的真实形状（`const readyFile = path.join(root, 'ready.json')` +
 * `JSON.parse(readFileSync(readyFile)).model === MODEL_KEY`）。
 * 反向验证必须**喂这个形状**：喂「字段全空」的话，下游天然什么都不匹配，把门删掉照样绿。
 */
const OLD_READY_SHAPE = [
  "const readyFile = path.join(root, 'ready.json');",
  'const ready = JSON.parse(fs.readFileSync(readyFile, \'utf8\')).model === MODEL_KEY;',
].join('\n');

function judgeWorkerSharesJudge(src) {
  assertHas(
    src,
    /require\(\s*['"][^'"]*ai\/bundled-models['"]\s*\)/,
    REL_WORKER + '：必须 require ../ai/bundled-models（共用那一对判据）',
  );
  assertHas(src, /isSearchReady\(/, REL_WORKER + '：读就绪状态必须走共用的 isSearchReady');
  assertHas(src, /writeSearchReady\(/, REL_WORKER + '：落 ready.json 必须走共用的 writeSearchReady');
  const hits = readyJsonLiterals(src);
  assert.equal(
    hits.length,
    0,
    REL_WORKER + '：不许自己拼 ready.json 路径（第二份判据 = 界面说没就绪、索引却照跑这种不报错的错），实际 ' +
      hits.length + ' 处 ' + JSON.stringify(hits),
  );
}

function testWorkerHasNoSecondJudge() {
  const src = readStripped(WORKER);
  judgeWorkerSharesJudge(src); // 正向

  expectReject(() => judgeWorkerSharesJudge(OLD_READY_SHAPE), '喂回修之前的写法');
  expectReject(
    () => judgeWorkerSharesJudge(src + '\nconst readyFile = path.join(root, \'ready.json\');\n'),
    '重新自己拼 ready.json 路径',
  );
  expectReject(
    () => judgeWorkerSharesJudge(src.split('isSearchReady(').join('localReady(')),
    '不用共用判据、改用本地实现',
  );
  expectReject(() => judgeWorkerSharesJudge(src.split('writeSearchReady(').join('localWrite(')), '不用共用的写标记函数');
  expectReject(
    () => judgeWorkerSharesJudge(src.split("require('../ai/bundled-models')").join("require('../ai/x')")),
    '不再 require 共用判据',
  );
}

// ---------------------------------------------------------------------------
// ④ 共用判据必须能被主进程 require
// ---------------------------------------------------------------------------

/**
 * 主进程禁止在顶层碰的重依赖。
 *
 * `sharp` / `better-sqlite3` 是原生模块、`@huggingface/transformers` + `onnxruntime-node`
 * 会开 ONNX 会话（几百 MB 常驻 + 同步设备初始化），`worker_threads` 意味着这个模块
 * 本来就该待在 worker 里。`bundled-models.js` 的注释里写明了它只该依赖 `fs`/`path`/`crypto`，
 * 主进程的 `status()` 现在 require 它 —— 这条断言就是那次 require 的前提。
 */
const MAIN_PROCESS_FORBIDDEN = [
  'onnxruntime-node',
  '@huggingface/transformers',
  'better-sqlite3',
  'sharp',
  'electron',
  'worker_threads',
];

function requiredSpecifiers(src) {
  const specs = [];
  walk(parse(src), (node) => {
    if (node.type !== 'CallExpression') return;
    if (!node.callee || node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
    const arg = node.arguments && node.arguments[0];
    if (arg && arg.type === 'Literal' && typeof arg.value === 'string') specs.push(arg.value);
  });
  return specs;
}

function judgeMainProcessSafe(src) {
  const specs = requiredSpecifiers(src);
  const bad = specs.filter((spec) => MAIN_PROCESS_FORBIDDEN.includes(spec));
  assert.deepEqual(
    bad,
    [],
    REL_BUNDLED + '：顶层 require 不许出现 ' + JSON.stringify(MAIN_PROCESS_FORBIDDEN) + '，实际有 ' + JSON.stringify(bad),
  );
  for (const need of ['fs', 'path']) assert.ok(specs.includes(need), REL_BUNDLED + '：它必须 require ' + need);
  assertHas(src, /module\.exports\s*=/, REL_BUNDLED + '：必须导出（主进程与 worker 都要用）');
  assertHas(src, /isSearchReady/, REL_BUNDLED + '：它承载 ready 的唯一判据 isSearchReady');
}

function testBundledModelsIsMainProcessSafe() {
  const src = readStripped(BUNDLED);
  judgeMainProcessSafe(src); // 正向

  expectReject(
    () => judgeMainProcessSafe("const fs = require('fs');\nconst path = require('path');\nconst sharp = require('sharp');\nmodule.exports = { isSearchReady };\n"),
    '顶层混进 sharp',
  );
  expectReject(
    () => judgeMainProcessSafe("const fs = require('fs');\nconst path = require('path');\nconst ORT = require('onnxruntime-node');\nmodule.exports = { isSearchReady };\n"),
    '顶层混进 onnxruntime-node',
  );
  expectReject(() => judgeMainProcessSafe(src.split("require('fs')").join("require('node:fs2')")), '连 fs 都不 require 了');

  // 运行时那一半：真正被 require 进来之后，进程里刷出来的模块里不许有重依赖。
  // 这条在 Electron 里尤其要紧：`run-regressions` 是以 `ELECTRON_RUN_AS_NODE=1` 跑本脚本的，
  // 那种环境下 require `better-sqlite3` 是**能成功**的（ABI 对得上），
  // 「跑得起来」不能当「没拖重依赖」的证据 —— 静态判据才是唯一防线，这里只是第二道网。
  const heavy = Object.keys(require.cache).filter((file) =>
    /onnxruntime-node|@huggingface[\\/]transformers|better-sqlite3|[\\/]sharp[\\/]/.test(file),
  );
  assert.deepEqual(
    heavy,
    [],
    '主进程 require 链（semantic-search → bundled-models / embedding）把重依赖拖进来了：' + JSON.stringify(heavy),
  );
  assert.equal(typeof bundled.isSearchReady, 'function', 'isSearchReady 必须是可调用的导出');
  assert.equal(typeof bundled.writeSearchReady, 'function', 'writeSearchReady 必须是可调用的导出');
  assert.equal(bundled.READY_FILE, 'ready.json', 'READY_FILE 是路径的唯一来源');
}

// ---------------------------------------------------------------------------
// ⑤ MODEL_KEY 全仓只有一处定义
// ---------------------------------------------------------------------------

function collectJsFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 扫 `src/` 下所有 `.js`，找出声明了 `MODEL_KEY` 的文件（相对仓根、`/` 分隔）。 */
function modelKeyDefinitions() {
  const hits = [];
  for (const file of collectJsFiles(path.join(ROOT, 'src'))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    walk(parse(src), (node) => {
      if (node.type !== 'VariableDeclarator') return;
      if (node.id && node.id.type === 'Identifier' && node.id.name === 'MODEL_KEY') hits.push(toPosix(file));
    });
  }
  return hits.sort();
}

function judgeSingleModelKey(hits) {
  assert.deepEqual(
    hits,
    [REL_EMBEDDING],
    'MODEL_KEY 只许在 ' + REL_EMBEDDING + ' 定义一次（它由 MODEL + REVISION + 量化档拼出）。' +
      '多一处定义 = 两代模型，ready.json 认哪一份都说不清 —— 实际：' + JSON.stringify(hits),
  );
}

function testModelKeyHasSingleSource() {
  judgeSingleModelKey(modelKeyDefinitions()); // 正向：真实扫描结果

  expectReject(() => judgeSingleModelKey([REL_EMBEDDING, 'src/ai/other.js']), '多出一处 MODEL_KEY 定义');
  expectReject(() => judgeSingleModelKey(['src/ai/other.js']), '定义挪到别的文件去了');
  expectReject(() => judgeSingleModelKey([]), '一处定义都没有');

  // 顺带钉住判据的消费者：`status()` 必须是真实存在的方法（裁判自己要先站得住）。
  assert.equal(typeof SemanticSearch.prototype.status, 'function', 'SemanticSearch#status 必须存在');
}

function run() {
  testStatusDerivesFromDiskStatically();
  testStatusDerivesFromDiskAtRuntime();
  testWorkerHasNoSecondJudge();
  testBundledModelsIsMainProcessSafe();
  testModelKeyHasSingleSource();
  console.log('搜图模型就绪状态（ready 的判据与求值时机）回归 全部通过');
}

run();
