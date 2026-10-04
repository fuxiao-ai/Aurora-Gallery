'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const timers = new Set();
const workers = [];
let worker;
class Worker extends EventEmitter {
  constructor() {
    super();
    worker = this;
    workers.push(this);
    this.terminated = false;
  }
  postMessage(message) {
    this.message = message;
  }
  terminate() {
    this.terminated = true;
    this.emit('exit');
    return Promise.resolve();
  }
}
const sandbox = {
  module: { exports: {} },
  __dirname: path.join(__dirname, '../src/main'),
  require(name) {
    if (name === 'worker_threads') return { Worker };
    if (name === 'path') return path;
    if (name === './logger') return { warn() {} };
    throw Error(name);
  },
  setTimeout(fn, ms) {
    const timer = { fn, ms, unref() {} };
    timers.add(timer);
    return timer;
  },
  clearTimeout(timer) {
    timers.delete(timer);
  },
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../src/main/semantic-search.js'), 'utf8'),
  sandbox,
);
async function run() {
  const { SemanticSearch } = sandbox.module.exports;
  const service = new SemanticSearch('fixture.db', 'fixture-ai');
  const indexing = service.run('index');
  // Advance every scheduled deadline by two days without sleeping.
  for (const timer of [...timers]) if (timer.ms <= 48 * 3600000) timer.fn();
  assert.equal(worker.terminated, false, 'healthy indexing can run longer than a day');
  service.cancel();
  assert.equal(worker.message.cancel, true, 'long indexing remains explicitly cancellable');
  worker.emit('message', { done: true, error: 'AI_CANCELLED' });
  await assert.rejects(indexing, /AI_CANCELLED/);
  assert.equal(service.status().busy, false);
  const query = service.run('search', 'a cat');
  const timeout = [...timers][0];
  assert.ok(timeout, 'interactive queries still have a deadline');
  timeout.fn();
  await assert.rejects(query, /AI_TIMEOUT/);
  assert.equal(worker.terminated, true);
  // 索引进行中：声明为 concurrentReads 的只读查询必须能并发执行（人物页要靠它实时
  // 显示已识别结果），同时不得顶替主 worker、不得改动任务状态，其余操作继续串行。
  const live = new SemanticSearch('fixture.db', 'fixture-ai', {
    operations: ['status', 'index', 'groups', 'photos'],
    concurrentReads: ['groups'],
    preserveProgress: ['groups'],
  });
  const running = live.run('index');
  const primary = workers[workers.length - 1];
  assert.equal(live.status().busy, true);
  await assert.rejects(live.run('photos', {}), /AI_BUSY/, '非只读操作仍然串行');
  const reading = live.run('groups', {});
  const reader = workers[workers.length - 1];
  assert.notEqual(reader, primary, '只读查询另起 worker，不占用主任务');
  assert.equal(live.status().busy, true, '并发只读不得改动任务状态');
  reader.emit('message', { done: true, result: { items: [] } });
  assert.deepEqual(await reading, { items: [] });
  assert.equal(live.status().busy, true, '只读 worker 结束不得结束主任务');
  assert.equal(primary.terminated, false);
  primary.emit('message', { done: true, result: { indexed: 3, people: 2 } });
  await running;
  assert.equal(live.status().busy, false);
  assert.equal(live.status().people, 2);
  console.log('[ai-lifecycle-regression] PASS');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
