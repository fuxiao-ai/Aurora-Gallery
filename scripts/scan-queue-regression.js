#!/usr/bin/env node
'use strict';

/**
 * 扫描队列调度契约回归（T2）。
 *
 * 背景：扫描过去在 `enqueueScanTask` 里做**同步拒绝** ——
 * `if (optimizeTaskRunning || dbWriteQueue.isBusy()) return { success: false, error: '…请等它跑完再试' }`。
 * 两个问题叠在一起：
 *   ① `scan-worker` 是逐批 COMMIT 的真实写者，却**不认识**写库队列，于是启动期的
 *      thumbnail-fix / deferred-index / FTS 会和它同时持写锁（队列的「串行」对扫描无效）；
 *   ② 唯一的自保手段是让用户去挑时机重试，而那个门槛信号在 T1 把长任务改成按批入队之后
 *      变成「批间空、批中满」，被不被拒全看运气。
 *
 * 现在的契约：
 *   - 扫描**排队**，不再拒绝；同 rootPath **合并**（重复点击不再扫两遍）。
 *   - 一次扫描 = 一次 `run('scan')`：整段独占闸门。拿不到 worker 内部的批次边界，
 *     租约粒度就只能取「一次扫描」——**这是刻意的取舍，不是遗漏**。
 *
 * 接线断言在 `maintenance-guard-regression.js#testDbWriteWiringContracts`（源码面），
 * 这里补它没有覆盖的部分：去重键的**真行为**、以及「整段独占」的行为面。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createDbWriteQueue } = require('../src/main/db-write-queue');

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

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 取一个顶层函数的函数体（到下一个顶层函数定义之前）。 */
function sliceFunctionBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const rest = src.slice(at + signature.length);
  const next = rest.search(/\n(?:async )?function [A-Za-z_$]/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 抠出一个函数的完整定义文本，供 `new Function` 真跑 —— 纯函数的断言不该靠正则猜。 */
function extractFunctionText(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const open = src.indexOf('{', at + signature.length - 1);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

// ---------------------------------------------------------------- 源码面

function testStaticWiring() {
  const raw = readSource('src/main.js');
  const code = stripComments(raw);

  const enqueueBody = sliceFunctionBody(code, 'function enqueueScanTask(task) {');
  assert(enqueueBody.length > 0, '找不到 enqueueScanTask —— 函数签名变了，请同步本回归');
  assert(
    /scanTasksByRoot\.get\(/.test(enqueueBody),
    'enqueueScanTask 必须按去重键查表，否则重复点击会真的扫两遍同一个目录',
  );
  assert(
    /return existing\.promise/.test(enqueueBody),
    '同目录已在排队/在跑时必须返回**同一个 Promise**（合并），而不是再排一个',
  );
  assert(
    !/success: false,\s*error: maintenanceBusyMessage/.test(enqueueBody),
    '扫描不得再同步拒绝（把「库正忙」甩给用户重试）——应改为排队',
  );
  assert(
    /scanQueue\.push\(entry\)/.test(enqueueBody),
    '扫描任务要真的入队，不能只是建了个对象',
  );

  // 去重表必须在**任务结束时**摘掉，且摘在 resolve 之前：先 resolve 的话，
  // 被唤醒的调用方立刻再点一次会合并到一个永不 settle 的死任务上（界面永久「准备中…」）。
  const settleBody = extractFunctionText(code, 'function settleScanTask(task, payload) {');
  assert(settleBody.length > 0, '找不到 settleScanTask —— 函数签名变了，请同步本回归');
  const deleteAt = settleBody.indexOf('scanTasksByRoot.delete');
  const resolveAt = settleBody.indexOf('task.resolve(');
  assert(deleteAt >= 0, 'settleScanTask 必须把任务从去重表摘掉');
  assert(resolveAt >= 0, 'settleScanTask 必须 resolve 调用方');
  assert(
    deleteAt < resolveAt,
    'settleScanTask 必须先摘去重表再 resolve —— 顺序反了会把新请求挂在死 Promise 上',
  );

  const scanBody = sliceFunctionBody(code, 'async function processScanQueue() {');
  assert(scanBody.length > 0, '找不到 processScanQueue —— 函数签名变了，请同步本回归');
  // ⚠️ `\s*` 是必要的：T3 加上 `{ priority: … }` 第三参后，`.run(` 与任务名之间会换行。
  // 这里守的是「占住闸门」与「callback 里先查 cancelled」，不该顺带规定写成几行。
  const runCall = /dbWriteQueue\s*\.run\(\s*'scan'/.exec(scanBody);
  assert(runCall !== null, '扫描必须占住写库闸门');
  const callbackSlice = scanBody.slice(runCall.index, runCall.index + 1000);
  assert(
    /if \(task\.cancelled\) return/.test(callbackSlice),
    '占闸门后的第一件事必须检查 cancelled —— 任务已出队但未开跑时没有 worker 可打断',
  );
  assert(
    /task\.started = true/.test(callbackSlice),
    '起 worker 前要置 started，否则界面会把「排队等闸门」误判成「正在扫描」',
  );
  assert(
    callbackSlice.indexOf('runFolderScanInWorker') > callbackSlice.indexOf('if (task.cancelled)'),
    '取消检查必须在起 worker 之前',
  );

  const clearBody = sliceFunctionBody(code, 'function clearPendingScanQueue() {');
  assert(clearBody.length > 0, '找不到 clearPendingScanQueue —— 函数签名变了，请同步本回归');
  assert(
    /!currentScanTask\.started[\s\S]{0,80}?currentScanTask\.cancelled = true/.test(clearBody),
    '已出队、还在等闸门的任务也要能被打断（那时没有 worker 可 postMessage）',
  );
  assert(
    /pending\[i\]\.cancelled = true/.test(clearBody),
    '排队的任务要标记 cancelled，不能只 resolve',
  );
  assert(
    /settleScanTask\(pending\[i\]/.test(clearBody),
    '撤队列也要走 settleScanTask，否则去重表里留着永远占位的条目',
  );

  const statusBody = sliceFunctionBody(code, 'function getScanQueueStatus() {');
  assert(statusBody.length > 0, '找不到 getScanQueueStatus —— 函数签名变了，请同步本回归');
  assert(
    /waitingGate: !currentScanTask\.started/.test(statusBody),
    '状态里要能区分「已出队但还在等闸门」与「正在扫描」，否则界面只能显示假进度',
  );

  const quietAt = code.indexOf('const DB_WRITE_QUIET_TASKS');
  assert(quietAt > 0, 'DB_WRITE_QUIET_TASKS 不见了');
  assert(
    /scan:\s*true/.test(code.slice(quietAt, quietAt + 400)),
    "DB_WRITE_QUIET_TASKS 必须含 scan：一次扫描可能几十分钟，一条 db-write.start/done 会污染启动埋点",
  );
  const labelBody = sliceFunctionBody(code, 'function dbWriteBusyLabel() {');
  assert(/=== 'scan'/.test(labelBody), "dbWriteBusyLabel 要认识 'scan'，否则界面只会显示英文任务名");

  // ---- 渲染端：排队态不能显示成「正在扫描... 0%」
  const flow = stripComments(readSource('src/renderer/scan-flow.js'));
  assert(
    /waitingGate = !!\(queue\.current && queue\.current\.waitingGate\)/.test(flow),
    '渲染端要读 getScanQueueStatus 的 waitingGate',
  );
  assert(/scanQueued/.test(flow), '渲染端要有一个「已排队但未开扫」的合成状态');
  assert(
    /排队中，正在等前面的后台任务结束/.test(flow),
    '等闸门时要说清在等谁，而不是显示假进度',
  );
  assert(/排队中，前面还有/.test(flow), '等前序任务时要报出前面还有几个');
  assert(
    /cancelBtn\.style\.display = scanning \|\| scanQueued/.test(flow),
    '排队期间也要给取消入口，否则用户只能干等',
  );

  const app = stripComments(readSource('src/renderer/app.js'));
  assert(
    /!state\.isScanning && !state\.isScanQueued/.test(app),
    '实时刷新不能在「排队等闸门」期间自停，否则扫描真正开始时侧栏数字不再更新',
  );
}

// ---------------------------------------------------------------- 行为面

function testRootKeyDedup() {
  // ⚠️ 这里刻意用**未剥注释**的源码：项目里的 stripComments 是正则式实现，
  // 会把 `/\//g` 这类含 `\/` 的正则字面量误判成行注释，剥完就成了半个正则。
  // scanRootKey 的函数体本身没有注释，直接从原文抠即可。
  const code = readSource('src/main.js');
  const fnText = extractFunctionText(code, 'function scanRootKey(rootPath) {');
  assert(fnText.length > 0, '找不到 scanRootKey —— 函数签名变了，请同步本回归');
  const scanRootKey = new Function(fnText + '\nreturn scanRootKey;')();

  assert(
    scanRootKey('K:/COS') === scanRootKey('K:\\COS\\'),
    '斜杠写法与尾部反斜杠的差异必须归一（否则同目录会排两次）',
  );
  assert(
    scanRootKey('K:\\COS') === scanRootKey('k:\\cos'),
    'Windows 路径大小写不敏感，大小写差异必须归一',
  );
  assert(scanRootKey('K:\\COS') !== scanRootKey('K:\\COS2'), '不同目录不能被误合并');
  const empty = scanRootKey(undefined);
  assert(empty === '' && typeof empty === 'string', '空/undefined 也要给出稳定的字符串键，不能抛');
}

/**
 * 一次扫描 = 一次 run：整段独占。
 *
 * 这是与「批次化长任务」刻意相反的行为（见 db-write-serialization-regression）：
 * 回填/哈希按批入队、批间**故意**让位；扫描拿不到 worker 内部的批次边界，
 * 只能整段占住。谁把它改成「按批次入队」，这条会红。
 */
async function testScanHoldsGateForWholeRun() {
  const queue = createDbWriteQueue({});
  const order = [];
  let active = 0;
  let maxActive = 0;

  async function job(name, phases) {
    return queue.run(name, async () => {
      active += 1;
      if (active > maxActive) maxActive = active;
      for (const phase of phases) {
        order.push(phase);
        await delay(6);
      }
      active -= 1;
    });
  }

  const scanning = job('scan', ['scan:start', 'scan:mid', 'scan:end']);
  const peer = (async () => {
    await delay(3); // 在扫描进行到 1/3 时入队
    await job('thumbnail-backfill', ['backfill']);
  })();

  await Promise.all([scanning, peer]);

  assert(maxActive === 1, '同一时刻只能有一个任务持写锁，实测并发峰值 ' + maxActive);
  assert(
    order.join(',') === 'scan:start,scan:mid,scan:end,backfill',
    '扫描是一次 run、整段独占：其他任务只能在它结束后跑，不能夹进扫描中间。实际：' +
      order.join(' → '),
  );
  assert(queue.isBusy() === false, '扫描结束后队列必须回到空闲');
}

/** 排队期间被取消的任务：占闸门后必须立刻放行，不能真去起一个 worker。 */
async function testCancelledScanDoesNotStartWorker() {
  const queue = createDbWriteQueue({});
  const started = [];
  let workerLaunched = false;

  const blocker = queue.run('thumbnail-backfill', () => delay(20));
  const ticket = { cancelled: false };
  const scan = queue.run('scan', () => {
    if (ticket.cancelled) {
      started.push('aborted');
      return Promise.resolve({ cancelled: true });
    }
    workerLaunched = true;
    started.push('launched');
  });
  await delay(2);
  ticket.cancelled = true; // 模拟 cancel-scan 打断「已出队、等闸门」的任务
  await Promise.all([blocker, scan]);

  assert(
    started.join(',') === 'aborted',
    '排队期间被取消的扫描不得起 worker，实际：' + started.join(' → '),
  );
  assert(workerLaunched === false, '取消后不该真的启动扫描');
  assert(queue.isBusy() === false, '被打断的扫描也要把闸门放掉，否则整条队列永久卡住');
}

async function main() {
  testStaticWiring();
  testRootKeyDedup();
  await testScanHoldsGateForWholeRun();
  await testCancelledScanDoesNotStartWorker();
  console.log('[scan-queue] PASS (' + checks + ' checks)');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
