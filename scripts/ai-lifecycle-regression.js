'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
// 沙箱里给的是**真模块**（不是再抄一份算法）：`status()` 的 `pct` 要按产品算法算，
// 抄一份就又变成一个「夹具跟产品漂开还照绿」的点。
const progressPct = require('../src/main/progress-pct');
// `status()` 里的就绪判定也走真模块（`isSearchReady` 是「模型是否已就绪」的唯一判据；
// 在夹具里重写一份 `JSON.parse(readFileSync(...)).model === …` 就又造出一个漂移点）。
// ⚠️ 这两个模块顶层都不 require 原生/重依赖（`embedding.js` 只在 `loadEncoder` 内部
//    require `onnxruntime-node`），所以主进程夹具可以安全地 require 它们。
const bundledModels = require('../src/ai/bundled-models');
const embedding = require('../src/ai/embedding');
// `status()` 的 ETA 派生（2026-10-08 新增）也走真模块 —— `estimateEtaSecondsFromRate` 是
// 「由速率反推剩余时间」的唯一实现，抄一份就会让「口径改了夹具还绿」。它顶层零依赖。
const eta = require('../src/main/eta');
const timers = new Set();
const workers = [];
class Worker extends EventEmitter {
  constructor() {
    super();
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
    // ⚠️ 这张表是**显式列举**的：`semantic-search.js` 每多一个 `require`，这里就得补一条。
    //    好在失效方向是**响的**（`throw Error(name)` ⇒ 加载期崩，不是安静跳过）；
    //    补的必须是**真模块**，否则就是「夹具跟产品漂开照样绿」。
    if (name === './progress-pct') return progressPct;
    if (name === './eta') return eta;
    if (name === '../ai/bundled-models') return bundledModels;
    if (name === '../ai/embedding') return embedding;
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
  // 🔴 index 是双 worker（2026-10-08 起）：CLIP 路先创建、JoyTag 路紧随其后 ——
  // 这个创建顺序本身就是 spawn 的契约。夹具必须给两路都发收场信封，
  // 否则 `await running` 永不落定 ⇒ 事件循环排空、进程 **exit 0 零输出**（假绿，
  // 比红更糟：2026-10-08 深夜实测，双 worker 落地后本守护就这样安静了）。
  const clipOfIndex = workers[0];
  const joyOfIndex = workers[1];
  assert.equal(joyOfIndex instanceof Worker, true, '前提：index 起了第二个 worker（JoyTag 路）');
  // Advance every scheduled deadline by two days without sleeping.
  for (const timer of [...timers]) if (timer.ms <= 48 * 3600000) timer.fn();
  assert.equal(clipOfIndex.terminated, false, 'healthy indexing can run longer than a day');
  service.cancel();
  assert.equal(clipOfIndex.message.cancel, true, 'long indexing remains explicitly cancellable');
  assert.equal(
    joyOfIndex.message.cancel,
    true,
    '取消必须同时作用于 JoyTag 路（只停 CLIP = tag 路继续跑几天而面板停在 stopping）',
  );
  clipOfIndex.emit('message', { done: true, error: 'AI_CANCELLED' });
  joyOfIndex.emit('message', { done: true, error: 'AI_CANCELLED' });
  await assert.rejects(indexing, /AI_CANCELLED/);
  assert.equal(service.status().running, false);
  const query = service.run('search', 'a cat');
  const timeout = [...timers][0];
  assert.ok(timeout, 'interactive queries still have a deadline');
  timeout.fn();
  await assert.rejects(query, /AI_TIMEOUT/);
  assert.equal(workers[2].terminated, true);
  // 索引进行中：声明为 concurrentReads 的只读查询必须能并发执行（人物页要靠它实时
  // 显示已识别结果），同时不得顶替主 worker、不得改动任务状态，其余操作继续串行。
  const live = new SemanticSearch('fixture.db', 'fixture-ai', {
    operations: ['status', 'index', 'groups', 'photos'],
    concurrentReads: ['groups'],
    preserveProgress: ['groups'],
  });
  const running = live.run('index');
  const primary = workers[workers.length - 2]; // 双 worker：CLIP 路在前、tag 路在后
  const joyRoute = workers[workers.length - 1];
  assert.equal(live.status().running, true);
  await assert.rejects(live.run('photos', {}), /AI_BUSY/, '非只读操作仍然串行');
  const reading = live.run('groups', {});
  const reader = workers[workers.length - 1];
  assert.notEqual(reader, primary, '只读查询另起 worker，不占用主任务');
  assert.notEqual(reader, joyRoute, '只读查询也不得撞上 JoyTag 路');
  assert.equal(live.status().running, true, '并发只读不得改动任务状态');
  reader.emit('message', { done: true, result: { items: [] } });
  assert.deepEqual(await reading, { items: [] });
  assert.equal(live.status().running, true, '只读 worker 结束不得结束主任务');
  // 🔴 并发只读的 worker 跑完**不许占着 `this.worker` 这个槽**。
  //    这个槽的语义是「谁在顶着任务状态」（`primary = !this.worker`、`start()` 判能不能建索引、
  //    relay 找谁手里有编码器），而并发只读的收场走的是「不写状态、不碰槽」那一条 ——
  //    若 spawn 无条件把它写进槽，槽就永远指着一具尸体，下场是**此后再也起不来索引**。
  assert.equal(
    live.worker,
    primary,
    '并发只读不得占用 this.worker 槽（占了就再也起不来索引，直到重启）',
  );
  assert.equal(primary.terminated, false);
  primary.emit('message', { done: true, result: { indexed: 3, people: 2 } });
  assert.equal(
    live.status().running,
    true,
    'CLIP 路收场而 tag 路没收场 ⇒ 任务不许结束（临界路径在 JoyTag 那边）',
  );
  joyRoute.emit('message', { done: true, result: { tags: { done: 1 } } });
  await running;
  assert.equal(live.status().running, false);
  assert.equal(live.status().people, 2);
  // 槽被清干净之后建索引必须还能起来 —— 这就是上面那条「只读不许占槽」断言要防的下场
  // （`start()` 只看 `this.worker` / `this.tagWorker`：槽里留着尸体 ⇒ 这里会当场 throw）。
  live.start('index');
  assert.equal(live.status().running, true, '索引跑完之后仍能再起一次索引');
  console.log('[ai-lifecycle-regression] PASS');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
