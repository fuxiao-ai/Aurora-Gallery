'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function run() {
  const instances = [];
  const timers = new Set();
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      instances.push(this);
    }
    postMessage(message) {
      // 复位指令是**没有 options** 的（它压根不是一次查询），所以这一支必须排在
      // `message.options.uncloneable` 之前 —— 否则这里会先撞一个 TypeError。
      if (message && message.op === '__cache_reset') {
        this.resets = (this.resets || 0) + 1;
        this.resetMessage = message;
        return;
      }
      if (message.options.uncloneable) throw new Error('clone failed');
      this.message = message;
    }
    terminate() {
      return Promise.resolve(0);
    }
    complete(result) {
      this.emit('message', { id: this.message.id, ok: true, result });
    }
  }
  const filename = path.join(__dirname, '..', 'src', 'db-read-worker-pool.js');
  const context = {
    module: { exports: {} },
    __dirname: path.dirname(filename),
    require: (name) => (name === 'worker_threads' ? { Worker: FakeWorker } : require(name)),
    setTimeout: (callback) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback) => timers.delete(callback),
    setImmediate,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const pool = context.module.exports;
  const request = (options) =>
    pool.run('test.db', 'getPhotos', options).then(
      (value) => ({ value }),
      (error) => ({ error: error.message }),
    );
  const a = request();
  const b = request();
  instances[0].emit('error', new Error('crashed'));
  instances[1].complete('healthy');
  assert.equal((await a).error, 'crashed');
  assert.equal((await b).value, 'healthy', 'other slots survive a crash');
  // 读池只读缓存复位（见 src/photos-total-cache.js）：只发给**还有连接**的槽 ——
  // 刚崩掉/正在退役的槽 `slot.worker` 已经是 null，进程都没了、也就没有缓存可清。
  pool.invalidateReadCaches();
  assert.equal(instances[1].resets, 1, '活着的槽必须收到复位指令');
  assert.equal(instances[0].resets || 0, 0, '已经退役的槽不该收到复位指令（它没有连接）');
  // 复位指令**不许带 id**：它走的是「没有回执」的那条路，带上 id 就会被当成某次查询的应答，
  // 把 `slot.job` 的配对打乱（那正是这个池最不能出错的地方）。
  assert.equal(instances[1].resetMessage.id, undefined, '复位指令不许带 id');
  const c = request();
  instances[2].complete('replacement');
  assert.equal((await c).value, 'replacement');
  const exited = request();
  instances[2].emit('exit', 0);
  assert.match((await exited).error, /exited/);
  const clone = request({ uncloneable: true });
  assert.equal((await clone).error, 'clone failed');
  const timeout = request();
  for (const callback of [...timers]) callback();
  assert.match((await timeout).error, /timeout/);
  const jobs = Array.from({ length: 104 }, () => request());
  assert.match((await jobs[103]).error, /queue full/);
  pool.terminate();
  const results = await Promise.all(jobs);
  assert.ok(results.every((result) => result.error));
  assert.equal(timers.size, 0, 'termination clears all deadlines');
  const active = new AbortController();
  const cancelled = pool.run('test.db', 'getPhotos', {}, { signal: active.signal }).then(
    () => null,
    (error) => error.message,
  );
  active.abort();
  assert.match(await cancelled, /cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  const holds = [request({ hold: 1 }), request({ hold: 2 }), request({ hold: 3 })];
  const queuedController = new AbortController();
  const queued = pool
    .run('test.db', 'getPhotos', { queuedProbe: true }, { signal: queuedController.signal })
    .then(
      () => null,
      (error) => error.message,
    );
  queuedController.abort();
  assert.match(await queued, /cancelled/);
  assert.ok(!instances.some((worker) => worker.message && worker.message.options.queuedProbe));
  pool.terminate();
  await Promise.all(holds);
  assert.equal(timers.size, 0);
  console.log('[worker-pool-regression] PASS');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
