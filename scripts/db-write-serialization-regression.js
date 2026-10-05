#!/usr/bin/env node
'use strict';

/**
 * 写库队列串行性回归 —— 长任务「按批次反复入队」这个契约的**行为面**。
 *
 * 背景：缩略图回填与重复哈希都是跑几十万行的长任务。它们过去只在开头做一次
 * `optimizeTaskRunning || dbWriteQueue.isBusy()` 的**快照**检查，通过后就整轮持写锁；
 * 而启动期的 thumbnail-fix / deferred-index / FTS 是无条件 `run()` 进队的、
 * 看不见 `thumbnailBackfill.running` → 存在真实的同时持锁窗口（`database is locked` 的来源）。
 *
 * 现在的契约是：长任务**每一批都重新入队**。于是
 *   ① 任何其他任务都不可能和它同时持锁（队列本身就是互斥）；
 *   ② 批间队列是空的，别的任务按 FIFO 插进来 —— 既不需要抢占，也不用改各自的循环结构。
 *
 * 接线断言（源码级）在 `maintenance-guard-regression.js` 的 testDbWriteWiringContracts，
 * 这里只验行为，两条互补。
 */

const { createDbWriteQueue } = require('../src/main/db-write-queue');

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 复刻「长任务按批入队」：并发峰值必须恒为 1，且短任务要能插进批次之间。 */
async function testBatchedLongTaskSerializes() {
  const queue = createDbWriteQueue({});
  let active = 0;
  let maxActive = 0;
  const started = [];

  function job(name, ms) {
    return queue.run(name, async () => {
      active += 1;
      if (active > maxActive) maxActive = active;
      started.push(name);
      await delay(ms);
      active -= 1;
    });
  }

  const longTask = (async () => {
    for (let batch = 0; batch < 3; batch += 1) {
      await job('thumbnail-backfill', 12);
    }
  })();

  // 在长任务第 1 批**执行期间**入队：应当插进批次之间，而不是被排到最后
  const shortTask = (async () => {
    await delay(2);
    await job('thumbnail-fix', 4);
  })();

  await Promise.all([longTask, shortTask]);

  assert(maxActive === 1, '同一时刻只能有一个任务持写锁，实测并发峰值 ' + maxActive);
  assert(started.length === 4, '3 个长任务批次 + 1 个短任务都应执行，实际 ' + started.length);
  assert(started[0] === 'thumbnail-backfill', '第一个应当是长任务的首批');
  const shortAt = started.indexOf('thumbnail-fix');
  assert(shortAt > 0, '短任务必须被执行到，实际顺序：' + started.join(' → '));
  assert(
    shortAt < started.length - 1,
    '短任务必须插在长任务的批次之间（批间让位），实际顺序：' + started.join(' → '),
  );
  assert(queue.isBusy() === false, '全部结束后队列必须回到空闲');
  assert(queue.busyName() === '', '空闲时不该报出忙碌原因');
}

/** 批间必须真的放开：否则别的任务永远等不到窗口，「按批入队」等于白做。 */
async function testGapOpensBetweenBatches() {
  const alone = createDbWriteQueue({});
  let sawIdleGap = false;
  for (let batch = 0; batch < 3; batch += 1) {
    if (batch > 0 && alone.isBusy() === false) sawIdleGap = true;
    await alone.run('thumbnail-backfill', () => delay(5));
  }
  assert(sawIdleGap, '批次之间队列必须回到空闲，否则其他任务永远插不进来');

  // 有排队者时，让位而不是抢：排队者必须夹在批次之间
  const queue = createDbWriteQueue({});
  const order = [];
  const longTask = (async () => {
    for (let batch = 0; batch < 2; batch += 1) {
      await queue.run('thumbnail-backfill', async () => {
        order.push('backfill');
        await delay(8);
      });
    }
  })();
  const peer = (async () => {
    await delay(1);
    await queue.run('thumbnail-fix', async () => {
      order.push('fix');
      await delay(4);
    });
  })();
  await Promise.all([longTask, peer]);
  assert(
    order.join(',') === 'backfill,fix,backfill',
    '排队者必须在批次之间被让到前面，实际顺序：' + order.join(' → '),
  );
}

/** 一个任务抛错不能把后面的卡在队里（队尾必须吃掉失败）。 */
async function testFailureDoesNotBlockQueue() {
  const queue = createDbWriteQueue({});
  const done = [];
  const failing = queue.run('thumbnail-backfill', async () => {
    throw new Error('boom');
  });
  const after = queue.run('thumbnail-fix', async () => {
    done.push('thumbnail-fix');
  });
  let rejected = false;
  try {
    await failing;
  } catch (error) {
    rejected = true;
  }
  await after;
  assert(rejected, '失败的那个任务应当把错误抛给调用方，不能被静默吞掉');
  assert(done.length === 1, '失败之后后面的任务仍要跑，不能被卡在队里');
  assert(queue.isBusy() === false, '失败之后队列也要回到空闲');
}

async function main() {
  await testBatchedLongTaskSerializes();
  await testGapOpensBetweenBatches();
  await testFailureDoesNotBlockQueue();
  console.log('[db-write-serialization] PASS (' + checks + ' checks)');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
