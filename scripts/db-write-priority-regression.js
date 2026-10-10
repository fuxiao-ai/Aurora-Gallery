#!/usr/bin/env node
'use strict';

/**
 * 写库队列**优先级**契约回归（T3）。
 *
 * 背景：队列过去是纯 FIFO。而「谁先谁后」在实际使用里不是无关紧要的 ——
 * 用户点了扫描却在等一个跑了半小时的缩略图回填，与「用户任务插到回填前面」
 * 是完全不同的体验。T1 已经把回填 / 哈希改成**每批重新入队**，于是队列只要按优先级排序，
 * 就自动得到「批次边界让位」——不需要 `lease` / `step`，也不需要额外的让位点。
 *
 * 本文件守两类契约：
 *   ① **行为面**（真跑队列）：高优先插队、同档 FIFO、**不抢占正在执行的批次**（关键！）、
 *      批次边界让位、失败独立结算、snapshot 语义；
 *   ② **接线面**（读源码）：每个 `dbWriteQueue.run(...)` 调用点都**显式**标了档位 ——
 *      漏标会静默落到默认档，那正是最难发现的一类调度错误。
 *
 * ⚠️ 序列化（并发峰值恒 1）由 `db-write-serialization-regression.js` 守，这里不重复。
 */

const fs = require('node:fs');
const path = require('node:path');
const { createDbWriteQueue, PRIORITY, DEFAULT_PRIORITY } = require('../src/main/db-write-queue');

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
 * 🔴 接线断言前必须剥注释。注释里写代码字面量是最自然的解释手段
 * （「过去这里是 `dbWriteQueue.run('scan')`」），而正则分不清注释与代码 ——
 * 不剥就会把注释里的调用点当成真的调用点，报出「没有显式标档位」这种假红。
 * 与 `maintenance-guard-regression.js` 同一套实现。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------- 行为面

/** 档位常量的相对顺序就是排序语义本身，先把它钉死。 */
function testPriorityOrdering() {
  assert(PRIORITY.USER < PRIORITY.REPAIR, 'USER 必须比 REPAIR 先跑（人在等的最优先）');
  assert(PRIORITY.REPAIR < PRIORITY.INDEX, 'REPAIR 必须比 INDEX 先跑（数据正确性 > 性能索引）');
  assert(PRIORITY.INDEX < PRIORITY.IDLE, 'INDEX 必须比 IDLE 先跑（IDLE 只在纯空闲做）');
  assert(
    DEFAULT_PRIORITY === PRIORITY.INDEX,
    '默认档必须是 INDEX —— 既不该偷偷插队，也不该被当成最不重要的',
  );
}

/** 高优先排到已在等的低优先前面，但**排在正在跑的那个后面**。 */
async function testHigherPriorityJumpsAhead() {
  const queue = createDbWriteQueue({});
  const order = [];

  const blocker = queue.run(
    'blocker',
    async () => {
      order.push('blocker');
      await delay(30);
    },
    { priority: PRIORITY.INDEX },
  );
  await delay(3);

  // 入队顺序刻意是「中 → 最低 → 最高」，期望执行顺序完全由档位决定
  const mid = queue.run('idx', () => order.push('idx'), { priority: PRIORITY.INDEX });
  const low = queue.run('idle', () => order.push('idle'), { priority: PRIORITY.IDLE });
  const high = queue.run('user', () => order.push('user'), { priority: PRIORITY.USER });

  await Promise.all([blocker, mid, low, high]);

  assert(
    order.join(',') === 'blocker,user,idx,idle',
    '高优先必须插到已在等的低优先之前，实际顺序：' + order.join(' → '),
  );
}

/** 🔴 优先级**不抢占正在执行的批次** —— 这是刻意的设计（中断半途的批次会留下中间态）。 */
async function testRunningBatchIsNotInterrupted() {
  const queue = createDbWriteQueue({});
  const events = [];

  const running = queue.run(
    'thumbnail-backfill',
    async () => {
      events.push('batch-start');
      await delay(25);
      events.push('batch-end');
    },
    { priority: PRIORITY.INDEX },
  );
  await delay(3);

  // 最高优先级的任务在批次**执行期间**入队
  const urgent = queue.run('vacuum', () => events.push('urgent'), { priority: PRIORITY.USER });
  await Promise.all([running, urgent]);

  assert(
    events.join(',') === 'batch-start,batch-end,urgent',
    '高优先任务不得插进正在执行的批次内部，实际事件：' + events.join(' → '),
  );
}

/**
 * 批次边界让位：长任务每批重新入队，用户任务就能插在**批与批之间**。
 * 这正是「优先级队列 + 每批重新入队」等价于让位机制的证明。
 */
async function testYieldAtBatchBoundary() {
  const queue = createDbWriteQueue({});
  const order = [];

  const backfill = (async () => {
    for (let batch = 0; batch < 3; batch += 1) {
      await queue.run(
        'thumbnail-backfill',
        async () => {
          order.push('b' + batch);
          await delay(12);
        },
        { priority: PRIORITY.INDEX },
      );
    }
  })();

  const urgent = (async () => {
    await delay(4); // 落在第 1 批执行期间
    await queue.run('vacuum', () => order.push('urgent'), { priority: PRIORITY.USER });
  })();

  await Promise.all([backfill, urgent]);

  assert(order[0] === 'b0', '回填首批应当先跑，实际：' + order.join(' → '));
  const at = order.indexOf('urgent');
  assert(at > 0, '用户任务必须被执行到，实际：' + order.join(' → '));
  assert(
    at < order.length - 1,
    '用户任务必须插在批次之间（批间让位），实际：' + order.join(' → '),
  );
}

/** 同档必须 FIFO。少了 seq 比较项，同档会退化成 LIFO（后入队先跑）。 */
async function testSamePriorityIsFifo() {
  const queue = createDbWriteQueue({});
  const order = [];

  const head = queue.run(
    'head',
    async () => {
      order.push('head');
      await delay(25);
    },
    { priority: PRIORITY.REPAIR },
  );
  await delay(3);
  const second = queue.run('second', () => order.push('second'), { priority: PRIORITY.REPAIR });
  const third = queue.run('third', () => order.push('third'), { priority: PRIORITY.REPAIR });
  await Promise.all([head, second, third]);

  assert(
    order.join(',') === 'head,second,third',
    '同档必须保持 FIFO，实际顺序：' + order.join(' → '),
  );
}

/** 非法 / 缺失的档位落到默认档，而不是排到最前或最后。 */
async function testInvalidPriorityFallsBackToDefault() {
  const queue = createDbWriteQueue({});
  const order = [];

  const head = queue.run('head', () => delay(25), { priority: PRIORITY.INDEX });
  await delay(3);
  const bogus = queue.run('bogus', () => order.push('bogus'), { priority: 'not-a-number' });
  const repair = queue.run('repair', () => order.push('repair'), { priority: PRIORITY.REPAIR });
  const idle = queue.run('idle', () => order.push('idle'), { priority: PRIORITY.IDLE });
  await Promise.all([head, bogus, repair, idle]);

  assert(
    order.join(',') === 'repair,bogus,idle',
    '非法档位应落到默认档（INDEX）：既被 REPAIR 插队、又排在 IDLE 前面，实际：' + order.join(' → '),
  );
}

/** 档位越界要夹到最近的合法档，不能让排序乱掉。 */
async function testOutOfRangePriorityIsClamped() {
  const queue = createDbWriteQueue({});
  const order = [];

  const head = queue.run('head', () => delay(25), { priority: PRIORITY.INDEX });
  await delay(3);
  /**
   * 断言的要害是**同档 FIFO**：夹取成功后越界值与显式档位同档，顺序由入队先后决定。
   * 所以两侧都先入队显式档位、后入队越界值 —— 不夹取时越界值会因数值更极端而插到前面/后面，
   * 顺序差就暴露出来了。（只入队一个越界值是不够的：夹与不夹排出来一样。）
   */
  const explicitUser = queue.run('explicitUser', () => order.push('explicitUser'), {
    priority: PRIORITY.USER,
  });
  const clampedHigh = queue.run('clampedHigh', () => order.push('clampedHigh'), { priority: -99 });
  const idx = queue.run('idx', () => order.push('idx'), { priority: PRIORITY.INDEX });
  const clampedLow = queue.run('clampedLow', () => order.push('clampedLow'), { priority: 999 });
  const explicitIdle = queue.run('explicitIdle', () => order.push('explicitIdle'), {
    priority: PRIORITY.IDLE,
  });
  await Promise.all([head, explicitUser, clampedHigh, idx, clampedLow, explicitIdle]);

  assert(
    order.join(',') === 'explicitUser,clampedHigh,idx,clampedLow,explicitIdle',
    '-99 应夹到 USER（与显式 USER 同档，按入队序）、999 应夹到 IDLE（与显式 IDLE 同档），实际：' +
      order.join(' → '),
  );
}

/** 快照与忙碌原因：排查「某任务为什么迟迟不开始」全靠它。 */
async function testSnapshotReportsQueue() {
  const queue = createDbWriteQueue({});

  const empty = queue.snapshot();
  assert(empty.active === null, '空闲时 snapshot.active 必须是 null');
  assert(empty.waiting.length === 0, '空闲时 snapshot.waiting 必须为空');
  assert(queue.nextPriority() === null, '空闲时没有「下一个档位」');

  const head = queue.run('head', () => delay(25), { priority: PRIORITY.INDEX });
  await delay(3);
  const low = queue.run('low', () => {}, { priority: PRIORITY.IDLE });
  const high = queue.run('high', () => {}, { priority: PRIORITY.USER });

  const snap = queue.snapshot();
  assert(snap.active && snap.active.name === 'head', 'snapshot 必须报出正在跑的任务名');
  assert(snap.active.priority === PRIORITY.INDEX, 'snapshot 必须报出正在跑的档位');
  assert(snap.waiting.length === 2, 'snapshot 必须报出全部排队者');
  assert(snap.waiting[0].name === 'high', '排队列表必须按优先级有序（高的在前）');
  assert(snap.waiting[1].name === 'low', '排队列表必须按优先级有序（低的在后）');
  assert(typeof snap.waiting[0].waitMs === 'number', '排队者要带已等待时长');
  assert(queue.nextPriority() === PRIORITY.USER, 'nextPriority 应当是队首的档位');
  assert(queue.busyName() === 'head', '有任务在跑时 busyName 报正在跑的，不是队首');

  await Promise.all([head, low, high]);
  assert(queue.isBusy() === false, '全部结束后队列必须回到空闲');
  assert(queue.busyName() === '', '空闲时不该报出忙碌原因');
  assert(queue.snapshot().active === null, '空闲后快照也要复位');
}

/** 档位不能改变「一个任务抛错不影响后续」这条既有契约。 */
async function testFailureStaysIndependentPerTicket() {
  const queue = createDbWriteQueue({});
  const done = [];

  const failing = queue.run(
    'boom',
    async () => {
      throw new Error('boom');
    },
    { priority: PRIORITY.USER },
  );
  const after = queue.run('after', () => done.push('after'), { priority: PRIORITY.IDLE });

  let rejected = false;
  try {
    await failing;
  } catch (error) {
    rejected = true;
  }
  await after;

  assert(rejected, '失败的任务仍要把错误抛给调用方');
  assert(done.length === 1, '失败之后后面的任务必须照跑');
  assert(queue.isBusy() === false, '失败之后队列要回到空闲');
}

/** 🔴 `run()` 必须把任务返回值透传给调用方 —— 忘了透传不会报错，只会让判断静默失真。 */
async function testRunPassesThroughReturnValue() {
  const queue = createDbWriteQueue({});
  const value = await queue.run('work', () => 'result', { priority: PRIORITY.USER });
  assert(value === 'result', 'await run() 必须拿到任务返回值（T3 重写队列时踩过：resolve() 漏传参）');

  const queue2 = createDbWriteQueue({});
  const asyncValue = await queue2.run('work', async () => ({ ok: true }), { priority: PRIORITY.INDEX });
  assert(
    asyncValue && asyncValue.ok === true,
    '异步任务的返回值同样要透传，不能被吞成 undefined',
  );

  const queue3 = createDbWriteQueue({});
  let sawError = null;
  try {
    await queue3.run(
      'boom',
      () => {
        throw new Error('locked');
      },
      { priority: PRIORITY.INDEX },
    );
  } catch (error) {
    sawError = error;
  }
  assert(
    sawError && sawError.message === 'locked',
    '失败时调用方要拿到**原始**错误对象（不是包装过的），实际：' + (sawError && sawError.message),
  );
}

// ---------------------------------------------------------------- 接线面

/** 让 task 名出现位置之后最近的 PRIORITY.X —— 「显式标注」的机械判据。 */
function nearestPriorityAfter(source, atIndex, windowSize) {
  const segment = source.slice(atIndex, atIndex + (windowSize || 1600));
  const match = segment.match(/PRIORITY\.(USER|REPAIR|INDEX|IDLE)/);
  return match ? match[1] : null;
}

/** 每个 run 调用点都必须显式标档 —— 漏标会静默落默认档，最难发现。 */
function testEveryCallSiteDeclaresPriority() {
  const source = stripComments(readSource('src/main.js'));
  const re = /dbWriteQueue\s*(?:\n\s*)?\.run\(\s*(?:\n\s*)?'([a-z-]+)'/g;
  const seen = [];
  /**
   * ⚠️ 必须从**调用点**取名字，不能 `indexOf("'name'")` —— 任务名在
   * `DB_WRITE_QUIET_TASKS` 等地方也出现，那样会量到错误的位置（这里踩过）。
   */
  const found = {};
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1];
    const priority = nearestPriorityAfter(source, match.index, 1600);
    seen.push(name);
    if (!found[name]) found[name] = [];
    found[name].push(priority);
    assert(
      priority !== null,
      'dbWriteQueue.run(\'' + name + '\') 没有显式标档位 —— 会静默落到默认档，必须补 { priority: … }',
    );
  }
  assert(
    seen.length === 14,
    '应当有 14 个写库任务调用点，实际找到 ' + seen.length + ' 个：' + seen.join(', '),
  );

  const expected = {
    'thumbnail-backfill': 'INDEX',
    'dup-hash': 'INDEX',
    'fts-index': 'INDEX',
    'invalid-cleanup': 'REPAIR',
    'thumbnail-fix': 'REPAIR',
    'deferred-index': 'REPAIR',
    'maintenance-rebuild-thumbnail-flags': 'USER',
    'maintenance-optimize-database': 'USER',
    /**
     * 缩略图**全量重建**（2026-10-07 加）。
     *
     * 档位定在 `IDLE`：它是「用户可选的画质迁移」—— 做晚了只是糊，做早了会把用户
     * 正在浏览读的那块盘（本机图库在外接机械盘上）抢走。而同为整文件读的缩略图补全
     * 定在 `INDEX`，是因为补全出的是「**没有**图」的行 —— 那是缺失，不是画质。
     * ⚠️ 两个名字分开登记：登记阶段与抽干阶段的批次粒度差三个数量级
     * （4 万行 / 50 张），合用一个名字后就分不出「卡在登记」还是「卡在抽干」。
     */
    'thumb-regen': 'IDLE',
    'thumb-regen-enqueue': 'IDLE',
  };
  Object.keys(expected).forEach(function (name) {
    const hits = found[name];
    assert(hits && hits.length, '源码里找不到 ' + name + ' 的入队调用点');
    hits.forEach(function (priority) {
      assert(
        priority === expected[name],
        name + ' 的档位应当是 ' + expected[name] + '，实际是 ' + priority,
      );
    });
  });
}

/** 扫描按来源分档：开机自动扫描是 REPAIR，用户手动点是 USER。 */
function testScanPriorityDependsOnSource() {
  const source = stripComments(readSource('src/main.js'));
  // 同样必须锚到调用点：`DB_WRITE_QUIET_TASKS` / `dbWriteBusyLabel` 里都有 'scan' 字面量
  const match = /dbWriteQueue\s*(?:\n\s*)?\.run\(\s*(?:\n\s*)?'scan'/.exec(source);
  assert(match !== null, '找不到扫描的入队点');
  const segment = source.slice(match.index, match.index + 1400);
  assert(
    /task\.source === 'auto'/.test(segment),
    '扫描的档位必须按 task.source 区分：开机自动扫描与用户手动点的重要性不同',
  );
  assert(/PRIORITY\.REPAIR/.test(segment), '开机自动扫描应当是 REPAIR（扫描产出的正是待修复的行）');
  assert(/PRIORITY\.USER/.test(segment), '用户手动点的扫描应当是 USER（人在等）');
}

/** 队列自己不导出档位之外的「让位 / 租约」API —— 那套被证明是多余的。 */
function testQueueSurfaceStaysMinimal() {
  const queue = createDbWriteQueue({});
  const keys = Object.keys(queue).sort();
  assert(
    keys.join(',') === 'busyName,isBusy,nextPriority,run,snapshot',
    '队列对外接口应当是固定的这 5 个（多了说明悄悄长出了没被验证的能力），实际：' + keys.join(', '),
  );
  assert(typeof queue.lease === 'undefined', '不需要 lease()：每批重新入队已经等价于批次边界让位');
  assert(typeof queue.step === 'undefined', '不需要 step()：同上');
}

async function main() {
  testPriorityOrdering();
  await testHigherPriorityJumpsAhead();
  await testRunningBatchIsNotInterrupted();
  await testYieldAtBatchBoundary();
  await testSamePriorityIsFifo();
  await testInvalidPriorityFallsBackToDefault();
  await testOutOfRangePriorityIsClamped();
  await testSnapshotReportsQueue();
  await testFailureStaysIndependentPerTicket();
  await testRunPassesThroughReturnValue();
  testEveryCallSiteDeclaresPriority();
  testScanPriorityDependsOnSource();
  testQueueSurfaceStaysMinimal();
  console.log('[db-write-priority] PASS (' + checks + ' checks)');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
