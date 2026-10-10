'use strict';

/**
 * 启动期 GPU 能力探测守护（2026-10-07）。
 *
 * 钉住五件事，每一件都对应一种「静态全绿、线上失效」的形态：
 *
 *   1. **回落必须 warn**：探测失败时 `logger.warn` 必须被调用、`logger.log` 不许被调用。
 *      静默回落的下场是「用户以为跑的是 GPU，其实整条链在 CPU 上」，事后无从查起。
 *   2. **取值域不许漂**：`provider` 只认 `'cpu' | 'dml'`。上游改名 / 字段缺失 / 磁盘上留了
 *      脏值，都必须归一到 cpu，**不许透传**（透传 = 下游 `executionProviders: [undefined]`
 *      静默回落，或者脏值被写进索引清单）。
 *   3. **「建了会话但没真算」不算可用**：`verified === false` 或者 `ok === false` 一票否决。
 *      少了这条，一个「全部节点回退 CPU」的会话会被误判成 GPU 可用。
 *   4. **判据不许靠推断**：源码里不许用 `process.platform` / `listSupportedBackends` 决定
 *      「有没有 GPU」，也不许在主进程里 `require('onnxruntime-node')`（那样等于把约 2 秒的
 *      同步 DML 设备初始化放在主线程上）。
 *   5. **点火块不许有早退**：启动路径里那个 `setTimeout` 只许「null 守卫 + `ensure()`」两条语句。
 *      多一条「AI 忙就跳过」= 这一轮没有结论 ⇒ 界面要么永远停在「检测中…」，
 *      要么拿旧值谎称「本次正在重测」。**界面是这功能存在的唯一理由，不能说假话。**
 *
 * ⚠️ 结构断言一律走 acorn 剥注释后再匹配（本工程已有先例：注释里引用的旧写法会被当结构判据）。
 * 第 5 条更进一层：直接看 AST 的**语句条数** —— 正则匹配不到「多了一个 if」。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'src', 'main', 'gpu-probe.js');
const WORKER = path.join(ROOT, 'src', 'workers', 'gpu-probe-worker.js');
const MAIN = path.join(ROOT, 'src', 'main.js');
const MODEL = path.join(ROOT, 'src', 'ai', 'ep-probe.onnx');

const probe = require(MODULE);

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}

const moduleSrc = stripComments(fs.readFileSync(MODULE, 'utf8'));
const workerSrc = stripComments(fs.readFileSync(WORKER, 'utf8'));
const mainSrc = stripComments(fs.readFileSync(MAIN, 'utf8'));

/** 一个假 logger：记录调用，供「回落必须 warn」这类断言用。 */
function fakeLogger() {
  const calls = { log: [], warn: [] };
  return {
    calls,
    log: (...args) => calls.log.push(args.join(' ')),
    warn: (...args) => calls.warn.push(args.join(' ')),
  };
}

function tempAiPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-gpu-probe-'));
}

/**
 * 找出「启动期点火 GPU 探测」那一段 —— `setTimeout(fn, …)` 且 `fn` 里调了 `gpuProbe.ensure()`。
 * 返回它的**函数体语句数组**，供形状断言用（只允许两条：null 守卫 + ensure 调用）。
 *
 * ⚠️ 走 AST 而不是正则：正则回答不了「这个块里有几条语句」，而这一条恰恰是要钉的
 * —— 「AI 忙就跳过」正是以「多一条 if 早退」的形式混进来的，届时正则照样匹配到
 * `gpuProbe.ensure()`，断言全绿而洞已回来。
 */
function ignitionBlock(src) {
  const ast = acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  });
  let found = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found) return;
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'setTimeout'
    ) {
      const fn = node.arguments[0];
      if (fn && src.slice(fn.start, fn.end).includes('gpuProbe.ensure')) {
        found = fn;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'start' || key === 'end' || key === 'type' || key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  if (!found) return null;
  const body = found.body;
  return {
    text: src.slice(found.start, found.end),
    statements: body && Array.isArray(body.body) ? body.body : null,
  };
}

function sliceStatement(src, statement) {
  return statement ? src.slice(statement.start, statement.end) : '';
}

(async () => {
  // ------------------------------------------------ 0. 夹具自证
  check(
    '夹具自证：acorn 确实剥掉了注释（否则注释里的旧写法会被当成结构判据）',
    !moduleSrc.includes('listSupportedBackends') && !workerSrc.includes('setImmediate 是'),
  );

  // ------------------------------------------------ 1. normalize：取值域与一票否决
  const dflt = probe.normalize(undefined);
  check(
    'normalize(undefined) ⇒ 回落 cpu',
    dflt.available === false && dflt.provider === 'cpu',
    JSON.stringify(dflt),
  );

  const dirty = probe.normalize({ provider: 'cuda', ok: true, verified: true });
  check(
    'provider 脏值（cuda）⇒ 归一到 cpu，不许透传',
    dirty.available === false && dirty.provider === 'cpu',
    JSON.stringify(dirty),
  );

  const missing = probe.normalize({ ok: true });
  check('provider 缺失 ⇒ cpu', missing.available === false && missing.provider === 'cpu');

  const unverified = probe.normalize({ ok: true, provider: 'dml', verified: false });
  check(
    'ok=true 但 verified=false（建了会话没真算）⇒ 不算可用',
    unverified.available === false && unverified.provider === 'cpu',
  );

  const failed = probe.normalize({ ok: false, provider: 'dml', reason: 'boom' });
  check(
    'ok=false 一票否决（即使 provider 写着 dml），且 reason 保留',
    failed.available === false && failed.provider === 'cpu' && failed.reason === 'boom',
  );

  const good = probe.normalize({ ok: true, provider: 'dml', verified: true, createMs: 1974, runMs: 12 });
  check(
    'ok=true + provider=dml + verified ⇒ 可用',
    good.available === true && good.provider === 'dml' && good.createMs === 1974,
  );

  check(
    '两个合法取值就是 cpu / dml（白名单常量）',
    probe.PROVIDER_CPU === 'cpu' && probe.PROVIDER_DML === 'dml',
  );

  // ------------------------------------------------ 2. 回落必须 warn（行为断言）
  const warnDir = tempAiPath();
  const warnLog = fakeLogger();
  let warnSpawnCalls = 0;
  const failing = probe.createGpuProbe({
    aiPath: warnDir,
    logger: warnLog,
    spawn: async () => {
      warnSpawnCalls += 1;
      return { ok: false, reason: 'Failed to create DirectML device' };
    },
  });
  const failVerdict = await failing.ensure();
  check(
    '探测失败 ⇒ available=false / provider=cpu',
    failVerdict.available === false && failVerdict.provider === 'cpu',
    JSON.stringify(failVerdict),
  );
  check(
    '🔴 探测失败必须走 logger.warn（且不许用 log 冒充）',
    warnLog.calls.warn.length === 1 && warnLog.calls.log.length === 0,
    JSON.stringify(warnLog.calls),
  );
  check(
    '回落日志必须带上失败原因原文（否则没法判断是驱动还是没显卡）',
    warnLog.calls.warn[0].includes('Failed to create DirectML device'),
    warnLog.calls.warn[0],
  );
  check(
    '失败路径也只探一次（失败后重试 = 白再起一个 worker + 再初始化一遍 D3D12）',
    warnSpawnCalls === 1,
    'calls=' + warnSpawnCalls,
  );

  const okDir = tempAiPath();
  const okLog = fakeLogger();
  const healthy = probe.createGpuProbe({
    aiPath: okDir,
    logger: okLog,
    spawn: async () => ({ ok: true, provider: 'dml', verified: true, createMs: 1974, runMs: 12 }),
  });
  const okVerdict = await healthy.ensure();
  check(
    '探测成功 ⇒ available=true / provider=dml，且**不许**打 warn',
    okVerdict.available === true && okVerdict.provider === 'dml' && okLog.calls.warn.length === 0,
    JSON.stringify(okLog.calls),
  );

  // spawn 自己 reject（不是返回 ok:false）也要收口成「回落 + warn」，绝不外泄成未处理拒绝
  const throwDir = tempAiPath();
  const throwLog = fakeLogger();
  const throwing = probe.createGpuProbe({
    aiPath: throwDir,
    logger: throwLog,
    spawn: async () => {
      throw new Error('probe worker exploded');
    },
  });
  let threwThrough = false;
  let throwVerdict = null;
  try {
    throwVerdict = await throwing.ensure();
  } catch (_) {
    threwThrough = true;
  }
  check(
    '🔴 spawn 抛错也必须收口（`ensure()` 不许 reject —— 调用端是 `void ensure()`，reject 只会换来一条没人看的 unhandledRejection）',
    threwThrough === false && !!throwVerdict && throwVerdict.available === false,
    threwThrough ? 'rejected' : JSON.stringify(throwVerdict),
  );
  check(
    'spawn 抛错时同样必须 warn，并带上错误原文',
    throwLog.calls.warn.length === 1 && throwLog.calls.warn[0].includes('probe worker exploded'),
    JSON.stringify(throwLog.calls.warn),
  );

  // ------------------------------------------------ 3. 只探一次 + 落盘 + 读回
  const memoDir = tempAiPath();
  const memoLog = fakeLogger();
  let memoCalls = 0;
  const memoProbe = probe.createGpuProbe({
    aiPath: memoDir,
    logger: memoLog,
    spawn: async () => {
      memoCalls += 1;
      return { ok: true, provider: 'dml', verified: true };
    },
  });
  await memoProbe.ensure();
  await memoProbe.ensure();
  check('同一个进程里只探一次（重复探测 = 白起一个 worker + 再初始化一遍 D3D12）', memoCalls === 1, 'calls=' + memoCalls);

  const persisted = JSON.parse(fs.readFileSync(path.join(memoDir, probe.FILE_NAME), 'utf8'));
  check(
    '结论落盘到 <aiPath>/gpu.json（跨进程读得到的唯一一份）',
    persisted.available === true && persisted.provider === 'dml',
    JSON.stringify(persisted),
  );

  const reread = probe.readVerdict(memoDir);
  check(
    'readVerdict 读回时打上 stale=true（「上次的值」不许冒充「本次实测」）',
    !!reread && reread.available === true && reread.stale === true,
  );

  const brokenDir = tempAiPath();
  fs.writeFileSync(path.join(brokenDir, probe.FILE_NAME), '{ 坏 json');
  check('坏文件 ⇒ readVerdict 返回 null（不抛）', probe.readVerdict(brokenDir) === null);

  const emptyDir = tempAiPath();
  check('没有文件 ⇒ readVerdict 返回 null', probe.readVerdict(emptyDir) === null);

  // 未探测完时 current() 只能给「上次的值」或 null；探完后给本次结果
  const preDir = tempAiPath();
  const preProbe = probe.createGpuProbe({ aiPath: preDir, logger: fakeLogger(), spawn: async () => ({ ok: true, provider: 'dml', verified: true }) });
  check('还没探完、也没有落盘值 ⇒ current() 返回 null（界面才能区分「未知」与「不可用」）', preProbe.current() === null);
  await preProbe.ensure();
  check('探完后 current() 给本次结果且 stale=false', preProbe.current().available === true && preProbe.current().stale === false);

  // ------------------------------------------------ 4. 结构断言（剥注释）
  check(
    '🔴 不许用 process.platform 推断有没有 GPU',
    !moduleSrc.includes('process.platform') && !workerSrc.includes('process.platform'),
  );
  check(
    '🔴 不许用 listSupportedBackends 当判据（它返回的是编译进包的 EP 列表，答不了本机可用性）',
    !moduleSrc.includes('listSupportedBackends') && !workerSrc.includes('listSupportedBackends'),
  );
  check(
    '🔴 主进程模块不许 require onnxruntime-node（loadModel 是 setImmediate 里同步跑的，约 2 秒）',
    !/require\(\s*['"]onnxruntime-node['"]\s*\)/.test(moduleSrc),
  );
  check(
    '探测 worker 必须真的用 dml 建会话',
    /executionProviders:\s*\[\s*'dml'\s*\]/.test(workerSrc),
  );
  check(
    '探测 worker 必须 run() 一次（DML 的图编译发生在首次 run，只建会话证明不了设备真在算）',
    /\.run\(/.test(workerSrc),
  );
  check(
    '探测模型走 buffer 读入而不是路径（打进 asar 后 ORT 的 C++ 层看不见虚拟路径）',
    /readFileSync\(modelPath\)/.test(workerSrc),
  );
  check(
    '探测模型已随包存在（src/**/* 会进 asar）',
    fs.existsSync(MODEL) && fs.statSync(MODEL).size > 0,
    MODEL,
  );
  // 🔴 模型不许是「一个碰巧在包里的二进制」：与生成器逐字节比对，改一处忘另一处当场红。
  //    这条同时挡住「有人手工替换了 .onnx」——那种改动没有任何其它守护抓得到。
  const generator = require('./ep-probe-model.js');
  const expectedBytes = generator.buildModel();
  let actualBytes = null;
  try {
    actualBytes = fs.readFileSync(MODEL);
  } catch (_) {}
  check(
    '🔴 探测模型与生成器 `scripts/ep-probe-model.js` 逐字节一致（手改 / 漏跑生成器都算红）',
    !!actualBytes && actualBytes.equals(expectedBytes),
    actualBytes ? actualBytes.length + ' B vs ' + expectedBytes.length + ' B' : 'missing',
  );

  // 「期望数值」两处同源：只有一边改会让数值校验永远通过
  const workerInput = workerSrc.match(/const INPUT_VALUE = ([\d.]+)/);
  const workerExpected = workerSrc.match(/const EXPECTED = ([\d.]+)/);
  check(
    '期望数值两处同源（worker 常量 === 主进程出口常量）',
    !!workerInput &&
      !!workerExpected &&
      Number(workerInput[1]) === probe.PROBE_INPUT_VALUE &&
      Number(workerExpected[1]) === probe.PROBE_EXPECTED,
    (workerInput && workerInput[1]) + ' / ' + (workerExpected && workerExpected[1]),
  );

  // ------------------------------------------------ 5. 接线断言
  check(
    'main.js 必须 require 探测器（否则模块不可达 = 探测永远不跑）',
    /require\(\s*'\.\/main\/gpu-probe'\s*\)/.test(mainSrc),
  );
  const ignition = ignitionBlock(mainSrc);
  check(
    'main.js 必须在启动路径里点火探测（+6s 那个 setTimeout 里调用 ensure()）',
    !!ignition && ignition.text.includes('gpuProbe.ensure'),
  );
  /**
   * 🔴 点火块**只许**两条语句：`if (!gpuProbe) return;` + `gpuProbe.ensure()`。
   *
   * 这条是「界面不许说谎」的结构化表达。本版最初写的是「AI 任务在跑就整轮跳过」
   * —— 跳过意味着这一轮**没有结论**：首次启动的那一行会永远停在「检测中…」，
   * 非首次启动则拿着上次的落盘值补一句「本次正在重测」（而本次根本没探）。
   * 任何以「再多一个早退」形式加回来的跳过，都会在这里当场红。
   */
  const ignitionStatements = ignition ? ignition.statements : null;
  check(
    '🔴 点火块只许有「null 守卫 + ensure()」两条语句（多一条早退 = 界面要么永远「检测中…」、要么谎称「本次正在重测」）',
    Array.isArray(ignitionStatements) &&
      ignitionStatements.length === 2 &&
      ignitionStatements[0].type === 'IfStatement' &&
      ignitionStatements[1].type === 'ExpressionStatement' &&
      sliceStatement(mainSrc, ignitionStatements[1]).includes('gpuProbe.ensure'),
    Array.isArray(ignitionStatements)
      ? 'statements=' + ignitionStatements.map((s) => s.type).join(',')
      : 'ignition block not found',
  );
  check(
    '落盘文件名只有一处定义（worker 侧不许再写一份）',
    !workerSrc.includes('gpu.json'),
  );

  // ------------------------------------------------ 6. 结论的传播（真的到 status() 里）
  /**
   * 🔴 判据在模块里、落盘也在，但**结论到不了界面**照样是零 —— 这是本工程
   * 「后端算了、界面永远看不到」那一类静默失效（判定结果要穿过 `status()`
   * → IPC / 内嵌 API → 渲染层，中间任何一层漏掉这个字段就被静默丢掉，不报错、不写日志）。
   *
   * 这里用**真类**（`require` 得动：它只依赖 `worker_threads` / `path` / `./logger`），
   * 拿 `Object.create(prototype)` 造一个不碰数据库、不碰 worker 的替身，
   * 只验三件事：钩子给了要带出来、钩子炸了要吞掉、没钩子不许凭空造字段。
   */
  const { SemanticSearch } = require(path.join(ROOT, 'src', 'main', 'semantic-search.js'));
  const stub = Object.create(SemanticSearch.prototype);
  stub.state = { running: false, ready: true, indexed: 7, phase: 'idle' };
  check(
    '还没挂钩子时 status() 里不许出现 gpu 字段（否则界面会把「没有结论」当成结论）',
    !('gpu' in stub.status()),
  );
  stub.gpuInfo = () => ({ available: false, provider: 'cpu', stale: true });
  const withGpu = stub.status();
  check(
    '🔴 挂了 gpuInfo ⇒ status() 必须把结论带出来（少了这条，「后端算了界面看不到」会一路绿灯）',
    !!withGpu.gpu && withGpu.gpu.provider === 'cpu' && withGpu.gpu.stale === true,
    JSON.stringify(withGpu.gpu),
  );
  stub.gpuInfo = () => {
    throw new Error('gpu hook exploded');
  };
  check(
    'gpuInfo 自己抛错 ⇒ 吞掉并给 null（能力探测是装饰信息，不许让「查状态」这个只读动作失败）',
    stub.status().gpu === null,
  );
  check(
    '🔴 main.js 不许给不读 gpuInfo 的服务也挂一份（人脸那条 status() 没有这个字段，挂了就是无人消费的死接线）',
    !/faceService\.gpuInfo\s*=/.test(mainSrc),
  );

  if (errors.length) {
    console.log(errors.join('\n'));
    console.log('\n[gpu-probe] FAIL (' + errors.length + ' / ' + (errors.length + notes.length) + ')');
    process.exit(1);
  }
  console.log('[gpu-probe] PASS (' + notes.length + ' checks)');
})();
