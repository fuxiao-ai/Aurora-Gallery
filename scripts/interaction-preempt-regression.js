#!/usr/bin/env node
'use strict';

/**
 * 交互抢占契约回归（T4a）。
 *
 * 背景：搜图查询过去**没有任何优先权**。它走只读并发通道（`concurrentReads` + `relayReads`），
 * 不会被拒绝，但也没有任何机制让后台长任务为它让步 —— 用户在百万库上敲一次关键词，
 * 正撞上缩略图回填以 N 路并发 sharp 解码 + 机械盘随机读，首次载文本编码器（约 900 MB）
 * 要等很久，而用户正盯着界面等结果。
 *
 * 现在的契约：**搜图查询进行中，后台长任务在批次边界停下让位**。
 *   - 只在批次边界让位（回填一批 100 张 / 哈希一个子批 24 张）。没有任何任务能在任意
 *     时刻被打断 —— 强行中断会留下半成品，所以「立刻停下」的可行语义就是「做完这批就停」。
 *   - 只对**查询**生效。`install` / `index` 是长跑索引，抢占别的任务只会让整体更慢。
 *
 * 这个文件重点守**防泄漏**：布尔标志一旦泄漏，后台任务会永久停摆，而且**不报任何错**。
 * 所以实现用了三条防线（计数 / 收尾保证 / 自动过期），每条都要能被改坏才算守护。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createInteractionPreempt } = require('../src/main/interaction-preempt');

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
 * 剥注释后再做源码断言。**必须剥**：本文件的锚点词（`withPreempt` / `awaitIdle`）
 * 在实现方的注释里也大量出现，不剥会把「注释里提过」误判成「代码里用了」。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function sliceBetween(code, from, to) {
  const start = code.indexOf(from);
  if (start < 0) throw new Error('起始锚点未找到（实现被改名了？）: ' + from);
  const end = to == null ? code.length : code.indexOf(to, start + from.length);
  if (end < 0) throw new Error('结束锚点未找到（实现被改名了？）: ' + to);
  return code.slice(start, end);
}

/* ------------------------------------------------------------------ 行为面 */

async function testIdleByDefault() {
  const p = createInteractionPreempt();
  assert(p.active() === false, '从未有过交互时不该算活跃');
  assert((await p.awaitIdle()) === true, '空闲时 awaitIdle 应立即放行');
  assert(p.status().holds === 0, '没等待就不该记一次让位（否则「让位次数」这个指标会失真）');
}

async function testConcurrentQueriesDoNotClearEachOther() {
  const p = createInteractionPreempt({ tailMs: 100 });
  p.begin();
  p.begin();
  p.end();
  assert(p.active() === true, '两个查询重叠时，先结束的那个不能清掉另一个的保护（这是布尔做不到的）');
  p.end();
  assert(p.active() === true, '最后一个结束后，尾巴窗口内仍算活跃（界面还要渲染、用户常紧接着搜下一个词）');
  await delay(140);
  assert(p.active() === false, '超过尾巴窗口后应转为空闲');
}

async function testEndNeverGoesNegative() {
  const p = createInteractionPreempt({ tailMs: 0 });
  p.end();
  p.end();
  assert(p.active() === false, '多余的 end 不该让状态变活跃');
  p.begin();
  assert(p.active() === true, '多余的 end 不能把计数打成负数 —— 否则之后的 begin 永远补不回正数，等于永久停摆');
  p.end();
}

async function testWithPreemptReleasesOnFailure() {
  const p = createInteractionPreempt({ tailMs: 0 });

  await p.withPreempt(() => Promise.resolve('ok'));
  assert(p.active() === false, '正常返回后应释放');

  await p
    .withPreempt(() => Promise.reject(new Error('boom')))
    .catch(() => {});
  assert(p.active() === false, 'Promise 失败后也必须释放（防泄漏最关键的一条）');

  try {
    await p.withPreempt(() => {
      throw new Error('sync');
    });
  } catch (error) {
    /* 预期 */
  }
  assert(p.active() === false, '同步抛错后也必须释放');
  assert(p.status().inFlight === 0, '三种失败路径之后在途计数都必须归零');
}

async function testAwaitIdleWaitsForRelease() {
  const p = createInteractionPreempt({ tailMs: 0, maxHoldMs: 2000, pollMs: 10 });
  p.begin();
  setTimeout(() => p.end(), 60);
  const started = Date.now();
  const waited = await p.awaitIdle();
  const elapsed = Date.now() - started;
  assert(waited === true, '查询结束后 awaitIdle 应报告「等到了」');
  assert(elapsed >= 45, '必须真的等到交互结束才放行，不能立刻返回（否则让位是假的）');
}

async function testAwaitIdleGivesUpAtMaxHold() {
  const p = createInteractionPreempt({ tailMs: 0, maxHoldMs: 120, pollMs: 10 });
  p.begin();
  const started = Date.now();
  const waited = await p.awaitIdle();
  const elapsed = Date.now() - started;
  assert(waited === false, '用户持续搜索时后台任务不能被无限期饿死：等满上限必须放行');
  assert(elapsed >= 100, '应确实等满上限，而不是立刻放弃');
  assert(p.status().holds === 1, '超时放行也是一次让位，要计数');
  assert(p.status().heldMs > 0, '让位时长要累计（排查「后台为什么变慢」的线索）');
  p.end();
}

async function testStatusShape() {
  const p = createInteractionPreempt({ tailMs: 50 });
  p.begin();
  const s = p.status();
  assert(s.active === true && s.inFlight === 1, 'status() 要同时给出布尔与在途计数');
  p.end();
  assert(p.status().inFlight === 0, 'inFlight 应随 end 归零');
}

/* ------------------------------------------------------------------ 源码面 */

function testQueryEntryPointsAreWrapped() {
  const mainCode = stripComments(readSource('src/main.js'));
  const webCode = stripComments(readSource('src/web-server.js'));

  const queryHandler = sliceBetween(
    mainCode,
    "ipcMain.handle('ai-search-query'",
    "ipcMain.handle('ai-search-suggest'",
  );
  assert(
    queryHandler.includes('interactionPreempt.withPreempt('),
    'ai-search-query 必须包 withPreempt —— 否则搜图拿不到任何优先权',
  );

  const suggestHandler = sliceBetween(
    mainCode,
    "ipcMain.handle('ai-search-suggest'",
    "ipcMain.handle('face-action'",
  );
  assert(
    suggestHandler.includes('interactionPreempt.withPreempt('),
    'ai-search-suggest 同样要载文本编码器，也要算作交互活跃',
  );

  assert(
    /interactionPreempt\s*\n?\s*\.withPreempt\(\(\) => this\.semanticSearch\.run\('search'/.test(webCode),
    '网页端 /api/ai-search 查询也要让位（两端搜的是同一个库、抢的是同一份 CPU 与磁盘）',
  );
  assert(
    /withPreempt\(\(\) => self\.semanticSearch\.run\('suggest'/.test(webCode),
    '网页端 /api/ai-search-suggest 也要让位',
  );
}

function testHeavyAiOpsAreNotWrapped() {
  const mainCode = stripComments(readSource('src/main.js'));
  const heavy = sliceBetween(
    mainCode,
    "ipcMain.handle('ai-search-install'",
    "ipcMain.handle('ai-search-cancel'",
  );
  assert(
    !heavy.includes('withPreempt'),
    'install / index 是长跑索引，不该被包成交互抢占 —— 抢占别的任务只会让整体更慢',
  );
}

function testBackoffPointsExist() {
  const mainCode = stripComments(readSource('src/main.js'));

  const backfill = sliceBetween(
    mainCode,
    'async function runThumbnailBackfill(',
    'async function runDuplicateHashDetection(',
  );
  assert(
    backfill.includes('interactionPreempt.awaitIdle()'),
    '缩略图回填必须在批次边界让位（它是搜图首次载模型时最大的磁盘与 CPU 竞争者）',
  );
  // 契约是「**同一次迭代内**先让位、再入队」。不能拿「函数里第一处入队」比 ——
  // 回填在进批次循环之前还有一次前置入队（准备步骤，只跑一次），它本来就在让位点之前。
  const idleAt = backfill.indexOf('interactionPreempt.awaitIdle()');
  // `\s*`：T3 加上 `{ priority: … }` 后 `.run(` 与任务名之间会换行；这里只关心先后位置
  const enqueueAfterIdle =
    idleAt >= 0 && /dbWriteQueue\s*\.run\(\s*'thumbnail-backfill'/.test(backfill.slice(idleAt));
  assert(
    idleAt >= 0 && enqueueAfterIdle,
    '让位必须发生在**入队之前** —— 进了写库队列再等，等于占着闸门干等，会把其他任务一起堵住',
  );

  const awaitIdleCalls = (mainCode.match(/interactionPreempt\.awaitIdle\(\)/g) || []).length;
  assert(
    awaitIdleCalls >= 3,
    '回填 1 处 + 哈希外层 1 处 + 哈希子批 1 处，共 3 个让位点（检出 ' + awaitIdleCalls + ' 处）',
  );

  // 🔴 2026-10-06：这条原本拿 `duplicateHashTask.running` 当「避让条件开头」的锚点，而那个条件
  // 已被**刻意移除**（避让发生在入队之前 ⇒ `PRIORITY.REPAIR` 被架空，见 CONTRACTS「没有做让位的」）。
  // 断言名说的是**语义**（要让位给搜图），实现却顺带钉死了**文本** —— 于是它替一个已被移除的
  // 条件「作证」。现在改成：① 限定在函数体内找（整份源码跑正则，一旦别处出现同形的避让条件
  // 就会变成「测了另一个函数」的假绿）；② 起点用 `isFolderScanRunning()`，它是这个避让条件的
  // 第一条、且语义稳定（扫描期间让路是一条不动的契约）。
  const cleanupStep = sliceBetween(
    mainCode,
    'function scheduleStartupInvalidCleanup() {',
    '\nfunction schedulePostWindowDeferredTasks',
  );
  assert(
    /isFolderScanRunning\(\)\s*\|\|[\s\S]{0,300}?interactionPreempt\.active\(\)\s*\|\|[\s\S]{0,120}?previewPlaybackActive/.test(
      cleanupStep,
    ),
    '启动期失效清理的避让条件要含「扫描 + 交互抢占 + 预览降载」三条（2026-10-06 起刻意不再含补全/查重）',
  );

  /**
   * 🔴 2026-10-08 **翻面**：抢占状态从 `get-background-tasks` 挪到了 `get-diagnostics`。
   *
   * 原判据是 `/interaction:\s*interactionPreempt\.status\(\)/.test(mainCode)` —— 它只在
   * 「整个 main.js 里出现过这个形状」，**不管出现在哪个 handler 里**，所以挪走之后照样绿；
   * 而它想守的是「抢占状态要能被读到」（消息里写的就是 `getBackgroundTasks`）。
   *
   * 现在拆成两条：**新位置必须有**、**旧位置必须没有**（后者才是防回退的那一条 ——
   * 否则「有人顺手把诊断字段又塞回任务返回」没人管，而那正好是
   * `docs/contracts/background-tasks.md` §0 要划清的边界）。
   */
  const bgTasksHandler = sliceBetween(
    mainCode,
    "ipcMain.handle('get-background-tasks'",
    "ipcMain.handle('get-diagnostics'",
  );
  const diagHandler = sliceBetween(
    mainCode,
    "ipcMain.handle('get-diagnostics'",
    "ipcMain.handle('open-database-folder'",
  );
  assert(
    /interaction:\s*interactionPreempt\.status\(\)/.test(diagHandler),
    '交互抢占状态要走 `get-diagnostics`（它是诊断数据、不是后台任务），否则「后台为什么变慢了」没有线索',
  );
  assert(
    !/interaction:\s*interactionPreempt\.status\(\)/.test(bgTasksHandler),
    '`get-background-tasks` 不许再报抢占状态：诊断数据混进任务返回，会让人以为它是一项任务（见契约 §0）',
  );
}

async function main() {
  await testIdleByDefault();
  await testConcurrentQueriesDoNotClearEachOther();
  await testEndNeverGoesNegative();
  await testWithPreemptReleasesOnFailure();
  await testAwaitIdleWaitsForRelease();
  await testAwaitIdleGivesUpAtMaxHold();
  await testStatusShape();
  testQueryEntryPointsAreWrapped();
  testHeavyAiOpsAreNotWrapped();
  testBackoffPointsExist();
  console.log('[interaction-preempt] PASS (' + checks + ' checks)');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
