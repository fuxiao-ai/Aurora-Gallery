#!/usr/bin/env node
'use strict';

/**
 * 启动期写库任务**顺序**契约回归（T5）。
 *
 * 背景：开机后有四件要写 photos.db 的事 —— 自动扫描 / 缩略图标记修复 / 索引补齐 / FTS。
 * 它们过去各自 `setTimeout(+5s / +6s / +8s)` 点火（FTS 还要先 5s 轮询一次 `maintenanceBusy()`），
 * 实际执行顺序是「触发时刻 + 排队时间」的偶然组合 —— 结果只建**性能索引**的 FTS
 * 常常排在修**数据正确性**的修复类前面，而自动扫描（产出的正是待修复的行）反而被挤到后面。
 *
 * T5 把它们收进 `submitStartupWriteTasks()` 这一个提交点：同一时刻入队，
 * 先后由 `db-write-queue` 的 `(priority, seq)` 表达。
 *
 * 本文件守两类契约：
 *   ① **行为面**（真跑队列）：提交顺序 → 执行顺序；档位差压过 seq；同档 FIFO；
 *      以及「为什么必须等扫描进入闸门」的对照实验 —— 不等，顺序真的会反。
 *   ② **接线面**（读源码）：三个任务确实在同一个函数里入队、无残留的 setTimeout 点火、
 *      扫描 gate 在 `run()` **之后** resolve、`optimizeTaskRunning` 在任务体内置位。
 *
 * ⚠️ 队列本身的优先级语义由 `db-write-priority-regression.js` 守，这里不重复。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createDbWriteQueue, PRIORITY } = require('../src/main/db-write-queue');

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/**
 * 🔴 接线断言前必须剥注释：注释里写代码字面量是最自然的解释手段
 * （「过去这里是 `setTimeout(+5s)` 点火」），而正则分不清注释与代码。
 * 与 `maintenance-guard-regression.js` 同一套实现。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 取一个顶层函数的函数体（到下一个顶层函数定义之前），只看这一个函数的接线。 */
function sliceFunctionBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const rest = src.slice(at + signature.length);
  const next = rest.search(/\n(?:async )?function [A-Za-z_$]/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 任务名 → 该调用点之后最近的 PRIORITY.X（「显式标注」的机械判据）。 */
function priorityAt(source, name, windowSize) {
  const re = new RegExp("dbWriteQueue\\s*(?:\\n\\s*)?\\.run\\(\\s*(?:\\n\\s*)?'" + name + "'");
  const match = re.exec(source);
  if (!match) return null;
  const segment = source.slice(match.index, match.index + (windowSize || 1200));
  const priority = segment.match(/PRIORITY\.(USER|REPAIR|INDEX|IDLE)/);
  return priority ? priority[1] : null;
}

// ---------------------------------------------------------------- 行为面

/**
 * 提交点里四个任务的相对顺序：扫描 → 修复类 → 建索引类。
 * 与 `submitStartupRepairAndIndexTasks` 的实际调用顺序保持一致。
 */
async function testSubmissionOrder() {
  const queue = createDbWriteQueue({});
  const order = [];
  const submit = (name, priority) =>
    queue.run(
      name,
      function () {
        order.push(name);
      },
      { priority: priority },
    );

  submit('scan', PRIORITY.REPAIR);
  submit('thumbnail-fix', PRIORITY.REPAIR);
  submit('deferred-index', PRIORITY.REPAIR);
  submit('fts-index', PRIORITY.INDEX);
  // IDLE 哨兵：它最后跑，等它 settle 时前面四个都已执行完
  await queue.run('sentinel', function () {}, { priority: PRIORITY.IDLE });

  assert(
    order.join(',') === 'scan,thumbnail-fix,deferred-index,fts-index',
    '提交顺序应当原样变成执行顺序，实际：' + order.join(','),
  );
}

/**
 * 档位差压过 `seq`：哪怕 FTS **第二个**入队，它也排在两个 REPAIR 之后。
 * 这条保证「以后有人调整 submitStartupRepairAndIndexTasks 里的调用顺序」时，
 * 「修复类先于建索引类」这个契约仍然成立。
 */
async function testPriorityBeatsSeq() {
  const queue = createDbWriteQueue({});
  const order = [];
  const submit = (name, priority) =>
    queue.run(
      name,
      function () {
        order.push(name);
      },
      { priority: priority },
    );

  submit('thumbnail-fix', PRIORITY.REPAIR);
  submit('fts-index', PRIORITY.INDEX);
  submit('deferred-index', PRIORITY.REPAIR);
  await queue.run('sentinel', function () {}, { priority: PRIORITY.IDLE });

  assert(
    order.join(',') === 'thumbnail-fix,deferred-index,fts-index',
    'INDEX 档的 FTS 必须落在两个 REPAIR 之后，实际：' + order.join(','),
  );
}

/** 同档内保持 FIFO —— 扫描与缩略图标记修复都是 REPAIR，扫描必须在前。 */
async function testSamePriorityKeepsSubmittedOrder() {
  const queue = createDbWriteQueue({});
  const order = [];
  const submit = (name) =>
    queue.run(
      name,
      function () {
        order.push(name);
      },
      { priority: PRIORITY.REPAIR },
    );

  submit('scan');
  submit('thumbnail-fix');
  await queue.run('sentinel', function () {}, { priority: PRIORITY.IDLE });

  assert(order.join(',') === 'scan,thumbnail-fix', '同档必须 FIFO，实际：' + order.join(','));
}

/** 队列忙碌时提交顺序仍然由优先级决定，而不是「先提交的先跑」。 */
async function testOrderHoldsWhileQueueBusy() {
  const queue = createDbWriteQueue({});
  const order = [];
  const submit = (name, priority) =>
    queue.run(
      name,
      function () {
        order.push(name);
      },
      { priority: priority },
    );

  // 先占住队列，让后面四个真的「同时在等」
  const blocker = queue.run('blocker', () => delay(20), { priority: PRIORITY.USER });
  submit('fts-index', PRIORITY.INDEX);
  submit('deferred-index', PRIORITY.REPAIR);
  submit('thumbnail-fix', PRIORITY.REPAIR);
  submit('scan', PRIORITY.REPAIR);
  await blocker;
  await queue.run('sentinel', function () {}, { priority: PRIORITY.IDLE });

  assert(
    order.join(',') === 'deferred-index,thumbnail-fix,scan,fts-index',
    '同时排队时：同档按提交序、低档最后，实际：' + order.join(','),
  );
}

/**
 * 「等扫描进入闸门」不是仪式 —— 不等，顺序真的会反。
 *
 * 对照组复刻 T5 之前的形态：`enqueueScanTask` 到 `dbWriteQueue.run('scan')` 之间隔着
 * `processScanQueue` 循环开头那次让路，提交器若在同一 tick 里接着提交修复类，
 * 那个 `seq` 更小，同档 FIFO 把扫描顶到后面。
 * 这条断言把「gate 的存在理由」钉成可执行证据，而不是一句注释。
 */
async function testScanGateIsLoadBearing() {
  // 对照组：不等 gate —— 修复类抢在扫描前面（bug 形态）
  {
    const queue = createDbWriteQueue({});
    const order = [];
    const submit = (name, priority) =>
      queue.run(
        name,
        function () {
          order.push(name);
        },
        { priority: priority },
      );

    const scanEnqueue = (async function () {
      await delay(30); // 模拟 processScanQueue 的让路
      submit('scan', PRIORITY.REPAIR);
    })();
    submit('thumbnail-fix', PRIORITY.REPAIR); // 提交器没等
    await scanEnqueue;
    await queue.run('sentinel', function () {}, { priority: PRIORITY.IDLE });

    assert(
      order.join(',') === 'thumbnail-fix,scan',
      '对照组：不等闸门时修复类会跑在扫描前面 —— 这正是 T5 之前的形态，实际：' + order.join(','),
    );
  }
  // 实验组：等 gate —— 扫描必然在前
  {
    const queue = createDbWriteQueue({});
    const order = [];
    const submit = (name, priority) =>
      queue.run(
        name,
        function () {
          order.push(name);
        },
        { priority: priority },
      );

    let releaseGate = null;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const scanEnqueue = (async function () {
      await delay(30);
      submit('scan', PRIORITY.REPAIR);
      releaseGate(); // 对应 processScanQueue 里 `run()` 之后的那次 resolve
    })();
    await gate; // ← 提交器等它，这就是 submitStartupAutoScan 里 `await Promise.all(gates)`
    submit('thumbnail-fix', PRIORITY.REPAIR);
    await scanEnqueue;
    await queue.run('sentinel', function () {}, { priority: PRIORITY.IDLE });

    assert(
      order.join(',') === 'scan,thumbnail-fix',
      '等闸门后扫描必然在修复类之前，实际：' + order.join(','),
    );
  }
}

// ---------------------------------------------------------------- 接线面

/** 三个任务必须在**同一个函数**里入队 —— 那是「同一时刻」的机械判据。 */
function testSingleSubmissionPoint() {
  const source = stripComments(readSource('src/main.js'));
  const body = sliceFunctionBody(source, 'function submitStartupRepairAndIndexTasks() {');
  assert(body.length > 0, '找不到 submitStartupRepairAndIndexTasks —— 函数签名变了，请同步本回归');

  ['thumbnail-fix', 'deferred-index', 'fts-index'].forEach((name) => {
    assert(
      new RegExp("dbWriteQueue\\s*(?:\\n\\s*)?\\.run\\(\\s*(?:\\n\\s*)?'" + name + "'").test(body),
      name + ' 必须在 submitStartupRepairAndIndexTasks 里入队（同一提交点 = 同一时刻）',
    );
  });

  assert(
    priorityAt(body, 'thumbnail-fix') === 'REPAIR',
    'thumbnail-fix 应当是 REPAIR（修的是数据正确性），实际：' + priorityAt(body, 'thumbnail-fix'),
  );
  assert(
    priorityAt(body, 'deferred-index') === 'REPAIR',
    'deferred-index 应当是 REPAIR（缺索引的行检索不到），实际：' + priorityAt(body, 'deferred-index'),
  );
  assert(
    priorityAt(body, 'fts-index') === 'INDEX',
    'fts-index 应当是 INDEX（建的是性能索引，推迟只影响搜索速度），实际：' +
      priorityAt(body, 'fts-index'),
  );
}

/** 提交顺序不得再回到「各自 setTimeout 点火」，也不得再有轮询式准入。 */
function testNoStrayTimersOrPolling() {
  const source = stripComments(readSource('src/main.js'));
  const body = sliceFunctionBody(source, 'function schedulePostWindowDeferredTasks() {');
  assert(body.length > 0, '找不到 schedulePostWindowDeferredTasks —— 函数签名变了，请同步本回归');

  ['thumbnail-fix', 'deferred-index', 'fts-index'].forEach((name) => {
    assert(
      body.indexOf("'" + name + "'") < 0,
      'schedulePostWindowDeferredTasks 里不该再出现 ' + name + ' —— 它已搬到统一提交点',
    );
  });

  // FTS 的 5s 自递归轮询：入队本身就是等待，不需要轮询
  assert(
    !/prepareSearchIndex/.test(source),
    'prepareSearchIndex 的 5s 自递归必须删掉：入队本身就是等待',
  );
  // 延迟索引的 3000 / 8000 双魔数
  assert(
    !/scheduleDeferredPhotoIndexesOnce/.test(source),
    'scheduleDeferredPhotoIndexesOnce 必须删掉（3000/8000 双魔数调度已并入统一提交点）',
  );
  assert(
    !/deferredPhotoIndexesScheduled/.test(source),
    'deferredPhotoIndexesScheduled 是旧调度的幂等标志，应随函数一起删除',
  );
}

/** 连接级 PRAGMA 只影响本连接、不写库文件 —— 不进队列，且不再分散在两处。 */
function testDeferredPragmasAreMergedAndUnqueued() {
  const source = stripComments(readSource('src/main.js'));
  assert(
    /applyDeferredIoPragmas\(\)/.test(source),
    'cache_size + mmap_size 应当合并成一次 applyDeferredIoPragmas()（过去分散在 +250ms / +2200ms）',
  );
  assert(!/applyDeferredCachePragma\(\)/.test(source), '不要再单独调 applyDeferredCachePragma()');
  assert(!/applyDeferredMmapPragma\(\)/.test(source), '不要再单独调 applyDeferredMmapPragma()');
}

/** 扫描闸门必须存在、必须被 resolve、且 resolve 位置在 `run()` **之后**。 */
function testScanGateWiring() {
  const source = stripComments(readSource('src/main.js'));

  const runMatch = /dbWriteQueue\s*(?:\n\s*)?\.run\(\s*(?:\n\s*)?'scan'/.exec(source);
  assert(runMatch !== null, '找不到扫描的入队点');

  const gateCall = /task\.gateResolve\(\)/.exec(source);
  assert(gateCall !== null, '扫描 entry 的 gate 必须被 resolve —— 否则提交器会永远等下去');
  assert(
    gateCall.index > runMatch.index,
    '🔴 gate 必须在 `run()` **之后** resolve：放在之前会让提交器抢先把修复类塞进队首（同档 FIFO），' +
      '顺序又回到「谁先醒谁先跑」',
  );

  assert(/entry\.gate\s*=\s*new Promise/.test(source), 'enqueueScanTask 必须给 entry 挂一个 gate Promise');

  const autoScanBody = sliceFunctionBody(source, 'async function submitStartupAutoScan() {');
  assert(autoScanBody.length > 0, '找不到 submitStartupAutoScan —— 函数签名变了，请同步本回归');
  assert(
    /await Promise\.all\(gates\)/.test(autoScanBody),
    'submitStartupAutoScan 必须等 gate 落地再返回，否则提交器会抢在扫描前面',
  );
  assert(
    /settings\.autoScanOnStartup/.test(autoScanBody),
    '自动扫描的开关判断必须在提交器里（提交顺序依赖它）',
  );
}

/** FTS 的「优化中」标志只在任务体内置位；且不得算作「独占维护」。 */
function testOptimizeFlagIsSetInsideTask() {
  const source = stripComments(readSource('src/main.js'));
  const runMatch = /dbWriteQueue\s*(?:\n\s*)?\.run\(\s*(?:\n\s*)?'fts-index'/.exec(source);
  assert(runMatch !== null, '找不到 fts 的入队点');

  const before = source.slice(Math.max(0, runMatch.index - 400), runMatch.index);
  assert(
    !/optimizeTaskRunning\s*=\s*true/.test(before),
    '🔴 optimizeTaskRunning 不能在入队**前**置位：排队 ≠ 在跑，提前置会让界面谎报维护中，' +
      '还会把用户的手动维护拒之门外',
  );

  const after = source.slice(runMatch.index, runMatch.index + 900);
  assert(/optimizeTaskRunning\s*=\s*true/.test(after), 'fts 任务体内必须置 optimizeTaskRunning');
  assert(
    !/exclusiveMaintenanceRunning\s*=\s*true/.test(after),
    'FTS 不得算作「独占维护」：它只是批量写，占了这标志就是启动期误报 AI_MAINTENANCE 的根源',
  );
}

/** 提交点是唯一入口：定义 1 处 + 调用 2 处（browse-ui-ready / 12s 兜底）。 */
function testSingleSubmissionEntry() {
  const source = stripComments(readSource('src/main.js'));
  const calls = source.match(/submitStartupWriteTasks\(/g) || [];
  assert(
    calls.length === 3,
    'submitStartupWriteTasks 应当只有「1 处定义 + 2 处调用」，实际 ' + calls.length + ' 处',
  );
  assert(
    /submitStartupWriteTasks\('browse-ui-ready'\)/.test(source),
    '首屏目录树就绪时必须提交（browse-ui-ready）',
  );
  assert(/submitStartupWriteTasks\('fallback'\)/.test(source), '12s 兜底路径也必须提交');
}

async function main() {
  await testSubmissionOrder();
  await testPriorityBeatsSeq();
  await testSamePriorityKeepsSubmittedOrder();
  await testOrderHoldsWhileQueueBusy();
  await testScanGateIsLoadBearing();
  testSingleSubmissionPoint();
  testNoStrayTimersOrPolling();
  testDeferredPragmasAreMergedAndUnqueued();
  testScanGateWiring();
  testOptimizeFlagIsSetInsideTask();
  testSingleSubmissionEntry();
  console.log('[startup-write-order] PASS (' + checks + ' checks)');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
