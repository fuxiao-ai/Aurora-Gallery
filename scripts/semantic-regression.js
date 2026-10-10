'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DIMENSIONS, normalize, pack, score, dot } = require('../src/ai/embedding');
const { IndexStore, MATCH_THRESHOLD_RANGE } = require('../src/ai/index-store');
const { SemanticSearch, readRoute, RELAY_READY_ATTEMPTS } = require('../src/main/semantic-search');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-semantic-'));
  let source;
  let store;
  let service;
  try {
    const failedIndex = path.join(directory, 'failed-index.sqlite');
    assert.throws(() => new IndexStore(path.join(directory, 'missing.db'), failedIndex));
    fs.unlinkSync(failedIndex); // On Windows this also verifies that the failed open released its handle.
    const sourcePath = path.join(directory, 'photos.db');
    source = new Database(sourcePath);
    source.pragma('journal_mode = WAL');
    source.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT,
      file_type TEXT, file_size INTEGER, date_modified TEXT, thumbnail BLOB,
      width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    const photo = (id) => ({
      id,
      file_path: '/photos/' + id + '.jpg',
      file_name: id + '.jpg',
      file_size: 100,
      date_modified: '2026-09-25',
    });
    for (let id = 1; id <= 4; id++)
      source
        .prepare('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, NULL, 100, 100, 0, 0)')
        .run(id, photo(id).file_path, photo(id).file_name, 'jpg', 100, '2026-09-25');
    const unit = (axis) => {
      const values = new Float32Array(DIMENSIONS);
      values[axis] = 1;
      return normalize(values);
    };
    const cat = unit(0);
    const lake = unit(1);
    assert.throws(() => normalize([1]), /DIMENSION/);
    assert.throws(() => normalize(new Float32Array(DIMENSIONS)), /INVALID/);
    const invalid = new Float32Array(DIMENSIONS);
    invalid[0] = NaN;
    assert.throws(() => normalize(invalid), /INVALID/);
    assert.equal(score(cat, pack(cat)), 1);
    assert.equal(score(cat, pack(lake)), 0);
    store = new IndexStore(sourcePath, path.join(directory, 'index.sqlite'));
    // 🔴 候选顺序是**主键倒序**（最新入库优先，2026-10-05 起）。游标是**排他上界**，
    //    起点必须写成 `maxPhotoId() + 1`；写成 0 就等价于 `id < 0` —— 恒空，
    //    索引任务会「秒完成」却一张不建，而且不报任何错（本仓最怕的静默失效）。
    assert.equal(
      store.batch(0).length,
      0,
      '倒序游标下 batch(0) 必须为空（这根弦就是「写 0 = 静默零索引」）',
    );
    assert.deepEqual(
      store.batch(store.maxPhotoId() + 1).map((p) => p.id),
      [4, 3, 2, 1],
      '候选按 id 倒序返回（新导入的先编码）',
    );
    assert.equal(store.batch(store.maxPhotoId() + 1).length, 4);
    store.put(photo(1), cat);
    store.put(photo(2), lake);
    store.put(photo(3), cat);
    store.put(photo(4), cat);
    assert.equal(store.count(), 4);
    assert.equal(
      store.batch(store.maxPhotoId() + 1).length,
      0,
      'unchanged photos are not re-encoded',
    );
    source.prepare('UPDATE photos SET file_size = 200 WHERE id = 3').run();
    source.prepare('DELETE FROM photos WHERE id = 4').run();
    assert.equal(store.count(), 2, 'stale and deleted photos excluded');
    assert.deepEqual(
      store.batch(store.maxPhotoId() + 1).map((p) => p.id),
      [3],
    );
    // ---- 检索改为阈值制：不再是「取相似度最高的 60 条」，而是「取所有达到阈值的」----
    // 分数口径是**基线差**（减去与泛化文本的相似度）。这里先用零向量当基线，
    // 「差值」退化成原始余弦，于是可以用正交单位向量写确定性断言；基线本身的作用在后面单独验。
    const zeroBaseline = new Float32Array(DIMENSIONS);
    await assert.rejects(
      store.search(cat, { threshold: 0 }, () => false),
      /BASELINE_MISSING/,
      '旧索引行还没有基线时必须报错，而不是静默按原始余弦筛',
    );
    const results = await store.search(cat, { threshold: 0, baseline: zeroBaseline }, () => false);
    assert.deepEqual(
      results.photos.map((p) => p.id),
      [1, 2],
      '阈值 0 等于不过滤：cat 的 1.0 与 lake 的 0.0 都算达标',
    );
    assert.equal(results.matched, 2, 'matched 是达标总数');
    assert.equal(results.truncated, false, '没超过上限就不算截断');
    assert.ok(!('vector' in results.photos[0]), 'never send embeddings to renderer');
    assert.equal(
      store.index.prepare('SELECT generic_sim FROM embeddings WHERE photo_id = 1').get()
        .generic_sim,
      0,
      '检索时顺手把缺失的基线补算并落库（旧索引因此不用重建）',
    );
    assert.deepEqual(
      (await store.search(cat, { threshold: 0 }, () => false)).photos.map((p) => p.id),
      [1, 2],
      '基线补齐之后，不带 baseline 的检索也能跑',
    );
    await assert.rejects(
      store.search(cat, { threshold: 0, baseline: zeroBaseline }, () => true),
      /CANCELLED/,
    );
    assert.deepEqual(
      (await store.search(cat, { threshold: 0.5, baseline: zeroBaseline }, () => false)).photos.map(
        (p) => p.id,
      ),
      [1],
      '阈值 0.5 只留真正相近的那张',
    );
    assert.equal(
      (await store.search(lake, { threshold: 0.5, baseline: zeroBaseline }, () => false)).photos[0]
        .id,
      2,
    );

    // ---- 基线确实参与取舍 ----
    // 追加两张：5 号是「什么都像一点」的混合图（原始余弦 0.8，但它与泛化文本也像到 0.6），
    // 6 号是纯 cat（基线 0）。只看原始余弦，5 号会混进来；扣掉基线它就不达标了。
    const insertPhoto = (id) =>
      source
        .prepare('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, NULL, 100, 100, 0, 0)')
        .run(id, photo(id).file_path, photo(id).file_name, 'jpg', 100, '2026-09-25');
    insertPhoto(5);
    insertPhoto(6);
    const generic = unit(2);
    const mixed = normalize(
      Float32Array.from({ length: DIMENSIONS }, (_, i) => [0.8, 0, 0.6][i] || 0),
    );
    store.put(photo(5), mixed, dot(generic, mixed));
    store.put(photo(6), cat, dot(generic, cat));
    const baselineCut = await store.search(cat, { threshold: 0.5, baseline: generic }, () => false);
    assert.deepEqual(
      baselineCut.photos.map((p) => p.id),
      [1, 6],
      '扣掉基线后只留下真正相近的',
    );
    assert.equal(baselineCut.photos[0].similarity, 1, 'similarity 是差值本身，不是原始余弦');
    // 入库时算好的基线**优先于**调用方传进来的 baseline（后者只用于给老索引行补算），
    // 否则同一批数据会因为「这次有没有传 baseline」给出不同结果。所以要先抹掉入库值，
    // 才看得到完全不减基线时的样子。
    store.index.prepare('UPDATE embeddings SET generic_sim = NULL').run();
    assert.deepEqual(
      (await store.search(cat, { threshold: 0.5, baseline: zeroBaseline }, () => false)).photos.map(
        (p) => p.id,
      ),
      [1, 6, 5],
      '不减基线时，「什么都像一点」的那张会混进结果',
    );

    // ---- 返回上限只约束内存，不改变「谁达标」 ----
    const capped = await store.search(
      cat,
      { threshold: 0.5, baseline: zeroBaseline, maxResults: 2 },
      () => false,
    );
    assert.equal(capped.matched, 3, 'matched 报的是达标总数，不受返回上限影响');
    assert.equal(capped.photos.length, 2, '返回条数受上限约束');
    assert.equal(capped.truncated, true, '截断了要如实标记，界面据此说明');

    // ---- 预选词打分：这些词在这个库里有没有内容 ----
    // 同上，抹掉入库基线，让打分走调用方给的那条（生产里就是泛化文本的向量）。
    store.index.prepare('UPDATE embeddings SET generic_sim = NULL').run();
    const scored = await store.scoreCandidates(
      [{ vector: cat }, { vector: lake }],
      { threshold: 0.5, baseline: generic },
      () => false,
    );
    assert.equal(scored.sampled, 4, '抽样拿到的都是仍然有效的行（3 号已失效被排除），且按 id 去重');
    assert.deepEqual(scored.hits, [2, 1], 'cat 命中 1 号与 6 号，lake 命中它自己那一张');
    store.close();
    store = null;
    service = new SemanticSearch(sourcePath, path.join(directory, 'ai'));
    const initial = service.refresh();
    await assert.rejects(service.run('search', '猫'), /BUSY/);
    assert.equal((await initial).ready, false);
    await assert.rejects(service.run('search', ''), /QUERY_INVALID/);
    await assert.rejects(service.run('search', '猫'), /MODEL_MISSING/);
    assert.equal((await service.refresh()).phase, 'failed', 'polling must retain task errors');
    assert.throws(() => service.start('arbitrary-operation'), /BAD_OPERATION/);

    // ---- 并发闸门：只读搜索必须在「主任务占着 worker」时照常执行 ----
    // spawn / worker 用替身顶掉，把「谁在跑」变成确定性的差分断言（不依赖时序）。
    const aiPath = path.join(directory, 'ai');
    const blocked = new SemanticSearch(sourcePath, aiPath);
    let reachedWorker = false;
    blocked.worker = { postMessage() {}, terminate() {} };
    blocked.spawn = () => {
      reachedWorker = true;
      return Promise.resolve({});
    };
    await assert.rejects(blocked.run('search', '猫'), /AI_BUSY/, '未登记并发读的操作仍必须串行');
    assert.equal(reachedWorker, false, '被拒的请求不该落到 worker');

    const allowed = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      preserveProgress: ['search'],
    });
    allowed.worker = { postMessage() {}, terminate() {} };
    const spawns = [];
    allowed.spawn = (operation, query, options) => {
      spawns.push({ operation, query, primary: options.primary });
      return Promise.resolve({ photos: [], indexed: 7 });
    };
    assert.deepEqual(await allowed.run('search', '猫'), { photos: [], indexed: 7 });
    assert.deepEqual(
      spawns,
      [{ operation: 'search', query: '猫', primary: false }],
      '索引进行中搜图必须走并发只读分支（同一时间只有一个主任务占用 worker）',
    );
    assert.equal(allowed.status().running, false, '并发只读不得写任务状态');
    assert.equal(allowed.status().phase, 'idle', '并发只读不得改 phase');

    // canRun 只拦重活：另一个索引服务在跑时，搜图照常，建索引 / 下载模型仍然互斥。
    allowed.canRun = () => false;
    assert.deepEqual(await allowed.run('search', '猫'), { photos: [], indexed: 7 });
    assert.equal(spawns.length, 2, '另一个索引在跑不挡住只读搜索');
    allowed.worker = null;
    await assert.rejects(allowed.run('index'), /AI_BUSY/, '两个索引之间仍互斥');
    await assert.rejects(allowed.run('install'), /AI_BUSY/, '下载模型同样互斥');
    // canRun 也可以返回**错误码**，用来说明「到底是谁在占着」——比如数据库维护期间
    // 界面要说「数据库维护进行中」，而不是笼统的「AI 任务正在运行」。
    // 只读搜索不受任何闸门影响。
    allowed.canRun = () => 'AI_MAINTENANCE';
    assert.deepEqual(await allowed.run('search', '猫'), { photos: [], indexed: 7 });
    assert.equal(spawns.length, 3, '维护期间搜图照常（只读，不写库）');
    await assert.rejects(allowed.run('index'), /AI_MAINTENANCE/, '维护期间建索引要给准确原因');
    await assert.rejects(allowed.run('install'), /AI_MAINTENANCE/, '维护期间下载模型同理');
    assert.throws(() => allowed.start('index'), /AI_MAINTENANCE/, 'start() 也要带出准确原因');
    // 闸门返回 true / undefined 都算放行（未装闸门时不拦）。
    allowed.canRun = () => true;
    assert.deepEqual(await allowed.run('index'), { photos: [], indexed: 7 });
    allowed.canRun = () => undefined;
    assert.deepEqual(await allowed.run('index'), { photos: [], indexed: 7 });
    allowed.canRun = null;

    // ---- relay：索引 worker 正在跑时，只读搜索托给它执行，绝不另起 worker ----
    // 「再起一个 worker」会在这个进程里并发载入第二份模型，实测会让进程直接崩掉，
    // 所以这条路径必须是「投递给同一个 worker」，不能用「另起一个」实现。
    const relayed = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    const posted = [];
    relayed.worker = { postMessage: (m) => posted.push(m), terminate() {} };
    relayed.spawn = () => {
      throw new Error('不该另起 worker：第二份模型会让进程崩');
    };
    // worker 不在建索引时（例如正在下载模型）没有可复用的编码器，只能拒绝。
    relayed.state.operation = 'install';
    await assert.rejects(relayed.run('search', '猫'), /AI_BUSY/);
    relayed.state.operation = 'index';
    const pending = relayed.run('search', ' 猫 ', { threshold: 0.02 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      posted,
      [{ operation: 'search', relay: 1, query: '猫', options: { threshold: 0.02 } }],
      '投递给索引 worker 的是一条 relay 请求（trim 掉两端空白，匹配阈值也跟着过去）',
    );
    const fakeWorker = { terminate() {} };
    relayed.handleWorkerMessage(
      { relay: 1, result: { photos: [{ id: 1 }], indexed: 5 } },
      { primary: false, worker: fakeWorker, onDone() {} },
    );
    assert.deepEqual(await pending, { photos: [{ id: 1 }], indexed: 5 }, '回话落到等待中的请求上');

    const failing = relayed.run('search', '猫');
    relayed.handleWorkerMessage(
      { relay: 2, error: 'AI_CANCELLED' },
      { primary: false, worker: fakeWorker, onDone() {} },
    );
    await assert.rejects(failing, /AI_CANCELLED/, 'worker 报错要原样冒给调用方');
    assert.equal(relayed.status().running, false, 'relay 期间不得改任务状态');
    assert.equal(relayed.status().operation, 'index', 'relay 期间索引任务的身份不变');

    // ---- 只读请求的路由表（2026-10-09：用户报「语义搜索时提示后台任务正在运行，请稍后再试」）----
    // 🔴 症状：进搜图页会自动取预选词（suggest）、启动后 3 秒会自动补 tag 倒排（tag）、
    //    会话第一次查状态要起 worker（status）—— 这三个窗口里搜图从前一律 `AI_BUSY`，
    //    而它们**要么本身就是只读、要么连编码器都没载**，凭什么挡搜图？
    // 判据全在纯函数 `readRoute` 里，所以先钉表格本身，再钉接线与退避重试。
    assert.deepEqual(
      [
        readRoute('index', false),
        readRoute('search', false),
        readRoute('suggest', false),
        readRoute('status', false),
        readRoute('tag', false),
        readRoute('install', false),
        readRoute('index', true),
      ],
      ['relay', 'relay', 'relay', 'spawn', 'spawn', 'busy', 'spawn'],
      '路由表：手里有编码器的托给它；status/tag（没载编码器）与已退出的 worker 自起只读 worker；' +
        '只有「模型正在下载」才真的拒绝',
    );
    // `relay()` 自己也要有这道门（防御性，别只信调用方）：对端已退出时**不许投出去** ——
    // 投出去既不报错也不回话，调用方会挂满 120 s 超时（见 `workerExited` 的推导）。
    const guarded = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    guarded.worker = {
      postMessage: () => assert.fail('已退出的 worker 不许再收到 relay 请求'),
      terminate() {},
    };
    guarded.workerExited = true;
    guarded.state.operation = 'index';
    await assert.rejects(guarded.relay('search', '猫'), /AI_BUSY/, 'relay 必须拒绝已退出的对端');

    // `status` / `tag` 对端 + 已退出的 worker：**不许再拒**，要自己起一个只读 worker
    // （`primary: false` —— 它不得占主任务槽、不得改任务状态）。
    const routed = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    const routedSpawns = [];
    routed.spawn = (operation, query, options) => {
      routedSpawns.push({ operation, query, primary: options.primary });
      return Promise.resolve({ photos: [{ id: 3 }], indexed: 1 });
    };
    for (const occupying of ['status', 'tag']) {
      routed.worker = { postMessage() {}, terminate() {} };
      routed.state.operation = occupying;
      assert.deepEqual(
        await routed.run('search', '猫'),
        { photos: [{ id: 3 }], indexed: 1 },
        occupying + ' 占着 worker 时搜图必须照常（它手里没有可复用的编码器 ⇒ 自己起一个）',
      );
    }
    // 🔴 双 worker 的尾巴：CLIP 路收场后 JoyTag 路还在跑（大库上几小时），槽里留着那具尸体。
    //    往尸体上 postMessage 不报错也不回话 ⇒ 从前这里每次搜索都挂满 120 s 超时。
    routed.workerExited = true;
    routed.state.operation = 'index';
    assert.deepEqual(
      await routed.run('search', '猫'),
      { photos: [{ id: 3 }], indexed: 1 },
      '对端已退出时不许把请求投给尸体（那只会在 120 s 后超时），必须自起 worker',
    );
    assert.deepEqual(
      routedSpawns,
      [
        { operation: 'search', query: '猫', primary: false },
        { operation: 'search', query: '猫', primary: false },
        { operation: 'search', query: '猫', primary: false },
      ],
      '这三趟都是并发只读：primary 必须为 false（不得顶替主任务、不得写任务状态）',
    );
    assert.equal(routed.status().running, false, '并发只读不得写任务状态（三轮都要保持）');
    assert.equal(routed.status().operation, 'index', '并发只读也不许改索引任务的身份');

    // ---- 索引起手那几秒：对端回 AI_BUSY 是「等我一下」，不是「别搜」----
    // 索引刚起手时编码器还在载（loadEncoder 实测 ≈2.1 s），此时 relay 会被回 `AI_BUSY`。
    // 直接把这句话给用户 = 一句「后台任务正在运行，请稍后再试」，而明明再过一两秒就能搜。
    const scripted = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    scripted.spawn = () => {
      throw new Error('这一趟不该另起 worker：对端一直在，重试就够了');
    };
    scripted.state.operation = 'index';
    const busyThenAnswer = { posted: [], turn: 0, terminate() {} };
    busyThenAnswer.postMessage = function (message) {
      this.posted.push(message);
      if (message.relay == null) return;
      this.turn += 1;
      const answer =
        this.turn === 1 ? { error: 'AI_BUSY' } : { result: { photos: [{ id: 7 }], indexed: 4 } };
      scripted.handleWorkerMessage(
        { relay: message.relay, ...answer },
        { primary: false, worker: this, onDone() {} },
      );
    };
    scripted.worker = busyThenAnswer;
    assert.deepEqual(
      await scripted.run('search', '猫'),
      { photos: [{ id: 7 }], indexed: 4 },
      '「还没就位」要退避重试成一次成功，而不是把 AI_BUSY 扔给用户',
    );
    assert.equal(busyThenAnswer.posted.length, 2, '重试就是再投一次（票据要换新的）');

    // 🔴 但重试**每一轮都要重看路由**：对端可能在等待期间收场，那时再投就是往尸体上投。
    //    这一支必须立刻停下、落到「自己起 worker」，而不是把预算烧完再拒。
    const halfway = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    const halfwaySpawns = [];
    halfway.spawn = (operation, query, options) => {
      halfwaySpawns.push({ operation, primary: options.primary });
      return Promise.resolve({ photos: [{ id: 8 }], indexed: 2 });
    };
    halfway.state.operation = 'index';
    const dying = { posted: [], terminate() {} };
    dying.postMessage = function (message) {
      this.posted.push(message);
      if (message.relay == null) return;
      halfway.workerExited = true; // 第一条回话之后对端就没了（索引整趟收场 / CLIP 路退出）
      halfway.handleWorkerMessage(
        { relay: message.relay, error: 'AI_BUSY' },
        { primary: false, worker: this, onDone() {} },
      );
    };
    halfway.worker = dying;
    assert.deepEqual(
      await halfway.run('search', '猫'),
      { photos: [{ id: 8 }], indexed: 2 },
      '重试当中对端收场 ⇒ 立刻改走「自起 worker」，不许继续投尸体',
    );
    assert.equal(dying.posted.length, 1, '对端已退出时只投过一次（不再重投）');
    assert.deepEqual(
      halfwaySpawns,
      [{ operation: 'search', primary: false }],
      '落到自起 worker 时仍是并发只读（primary: false）',
    );

    // 预算用尽仍是 relay（真出事了）：才允许把 AI_BUSY 交出去 —— 而且要**有界**（不许无限重试）。
    const stuck = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    stuck.spawn = () => {
      throw new Error('对端还在（只是没就位），这一趟不该另起 worker');
    };
    stuck.state.operation = 'index';
    const never = { posted: [], terminate() {} };
    never.postMessage = function (message) {
      this.posted.push(message);
      if (message.relay == null) return;
      stuck.handleWorkerMessage(
        { relay: message.relay, error: 'AI_BUSY' },
        { primary: false, worker: this, onDone() {} },
      );
    };
    stuck.worker = never;
    const stuckStartedAt = Date.now();
    await assert.rejects(
      stuck.run('search', '猫'),
      /AI_BUSY/,
      '预算用尽且对端仍是 relay，才交 AI_BUSY',
    );
    assert.equal(
      never.posted.length,
      RELAY_READY_ATTEMPTS + 1,
      '重试次数就是预算（多一次首投）—— 这条闸门防的是「无界重试把搜图挂死」',
    );
    assert.ok(Date.now() - stuckStartedAt < 60000, '预算必须有界（不许无限等）');

    // ---- 「另一个索引在跑就拒绝搜图」那道闸门（canSearch）已撤除 ----
    // 根子是内存，而真正致命的是**同一份 SigLIP2 被并发载入两遍**；那条路已被 relay 堵死
    // （对端手里有编码器时一律走 relay），没编码器的那几种则自起 worker（只载文本编码器）。
    const alone = new SemanticSearch(sourcePath, aiPath, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    assert.equal(alone.canSearch, undefined, '语义服务里不再有 canSearch 闸门');
    alone.canRun = () => false; // 另一套索引（如人脸索引）在跑
    const aloneSpawns = [];
    alone.spawn = (operation, query, options) => {
      aloneSpawns.push({ operation, query, primary: options.primary });
      return Promise.resolve({ photos: [{ id: 9 }], indexed: 3 });
    };
    assert.deepEqual(await alone.run('search', '猫'), { photos: [{ id: 9 }], indexed: 3 });
    assert.deepEqual(
      aloneSpawns,
      [{ operation: 'search', query: '猫', primary: true }],
      '另一套索引在跑时搜图自己起 worker（primary），不再被拒绝',
    );
    // 静态契约：闸门不该被悄悄加回来（加回来就等于又允许它拒掉搜图）。
    // 匹配「点操作符 + canSearch」，注释里提到这个词不算。
    const gateUsage = /\.canSearch/;
    assert.ok(
      !gateUsage.test(
        fs.readFileSync(path.join(__dirname, '../src/main/semantic-search.js'), 'utf8'),
      ),
      'semantic-search.js 不再读 canSearch 闸门',
    );
    assert.ok(
      !gateUsage.test(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')),
      'main.js 不再安装 canSearch 闸门',
    );
    // ---- 静态契约：阈值从设置一路传到 worker，且默认值只有一个来源 ----
    const workerSrc = fs.readFileSync(
      path.join(__dirname, '../src/workers/semantic-worker.js'),
      'utf8',
    );
    const indexStoreSrc = fs.readFileSync(path.join(__dirname, '../src/ai/index-store.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/web-server.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
    const panelSrc = fs.readFileSync(
      path.join(__dirname, '../src/web/js/semantic-search.js'),
      'utf8',
    );

    // 只需要文本编码器的操作必须显式登记：省下的约 270 MB 常驻内存全靠这一处，
    // 而建索引 / 下载模型必须带视觉编码器（否则索引直接失败）。
    assert.match(
      workerSrc,
      /const TEXT_ONLY_OPERATIONS = new Set\(\['search', 'suggest'\]\)/,
      'search 与 suggest 必须登记在 TEXT_ONLY_OPERATIONS 里',
    );
    assert.match(
      workerSrc,
      /textOnly: TEXT_ONLY_OPERATIONS\.has\(operation\)/,
      'textOnly 必须由那张表决定：没登记的操作一律当「要视觉」（建索引走这条路）',
    );
    for (const [name, src] of [
      ['worker', workerSrc],
      ['index-store', indexStoreSrc],
    ])
      assert.ok(!/search\([^)]*,\s*60\b/.test(src), name + ' 里不许再出现写死的「60 条」上限');
    // 至少两个回归断言要能抓住「又改回取前 N 条」
    assert.match(indexStoreSrc, /candidates\s*\+= 1/, '达标要计数（不再是取前 N 条）');
    assert.match(indexStoreSrc, /adjusted\s*<\s*threshold/, '不达标就跳过');
    // 自适应阈值：公式与 α 是本方案的核心契约，删掉就等于悄悄退回固定阈值
    // （固定阈值的两难：定高了整条杀掉排序正确的概念，定低了灌噪声 —— 见 DEFAULT_MATCH_THRESHOLD 注释）。
    assert.match(indexStoreSrc, /const ADAPTIVE_ALPHA = 0\.3;/, '自适应阈值的 α 定义没了');
    assert.match(
      indexStoreSrc,
      /Math\.max\(threshold,\s*ADAPTIVE_ALPHA\s*\*\s*top1\)/,
      '自适应阈值公式必须仍是 max(用户阈值, α×top1) —— 用户设的阈值永远优先，' +
        '写成 α×top1 单独一项就等于把用户的手动收紧吞掉',
    );
    // 阈值默认值只能有一处定义。渲染层拿不到主进程模块，面板里的范围靠这条断言对齐。
    const panelRange =
      /var MATCH_RANGE = \{ min: ([\d.]+), max: ([\d.]+), step: ([\d.]+), default: ([\d.]+) \}/.exec(
        panelSrc,
      );
    assert.ok(panelRange, '设置面板必须声明 MATCH_RANGE');
    assert.deepEqual(
      [Number(panelRange[1]), Number(panelRange[2]), Number(panelRange[4])],
      [MATCH_THRESHOLD_RANGE.min, MATCH_THRESHOLD_RANGE.max, MATCH_THRESHOLD_RANGE.default],
      '面板里的阈值范围必须与 src/ai/index-store.js 的 MATCH_THRESHOLD_RANGE 一致',
    );
    // 阈值用输入框而不是滑杆：滑杆在 [0, 0.03] 这么窄的区间上拖不准，也没法表达「清空 = 默认」。
    // 行为（夹取 / 空框回落 / 失败回滚）由 scripts/match-threshold-regression.js 覆盖，这里只钉形态。
    assert.match(panelSrc, /thresholdInput\.type = 'number'/, '阈值用数字输入框');
    assert.ok(!/type = 'range'/.test(panelSrc), '阈值滑杆必须已经拆掉');
    assert.match(
      panelSrc,
      /thresholdInput\.value = formatThreshold\(MATCH_RANGE\.default\)/,
      '打开面板就要带默认值，读到真值之前框里也不是空的',
    );
    assert.match(
      mainSrc,
      /aiSearchMatchThreshold: MATCH_THRESHOLD_RANGE\.default/,
      '设置默认值取自唯一定义处，不许再写一个数字',
    );
    assert.match(
      mainSrc,
      /settings\.aiSearchMatchThreshold = Math\.max\(\s*MATCH_THRESHOLD_RANGE\.min/,
      '越界的阈值要被夹回范围内',
    );
    assert.match(
      mainSrc,
      /semanticSearch\.run\('search', query, searchMatchOptions\(\)\)/,
      '桌面端检索要把阈值传下去',
    );
    assert.match(mainSrc, /ipcMain\.handle\('ai-search-suggest'/, '预选词打分要有 IPC 入口');
    assert.match(
      mainSrc,
      /concurrentReads: \['search', 'suggest'\]/,
      '打分与检索同为只读，走同一条并发 / relay 通道',
    );
    // 网页端检索：M4 之前这里是内联的 `{ threshold }` 字面量，加了 tag 检索层之后改成
    // 先拼一个 `options`（阈值 + tag 层的开关 / 查询线）再传下去。
    // ⚠️ 断言跟着形状改，但**要钉的是「阈值仍然传下去了」这件事**，不是那个字面量 ——
    //    只钉字面量会让「为了加一个键而重写成 options」被误判成回归。
    //    融合本身的判据（RRF、route、去重、matched 口径）在 `tag-fusion-regression.js` 里，
    //    这里只管「接线还通着」。
    assert.match(serverSrc, /run\('search', query\.q, options\)/, '网页端检索要带 options 下去');
    assert.match(
      serverSrc,
      /options\.threshold = Number\(this\.getAiSearchMatchThreshold\(\)\)/,
      '网页端检索必须仍然把阈值传下去',
    );
    assert.match(
      serverSrc,
      /options\.tagEnabled = tagOptions\.tagEnabled !== false/,
      '网页端检索要带上 tag 层的开关（否则网页端永远走默认而不是用户设置）',
    );
    assert.match(serverSrc, /handleAiSearchSuggest/, '网页端要有预选词打分路由');
    assert.match(preloadSrc, /aiSearchSuggest:/, 'preload 要暴露 aiSearchSuggest');

    // ---- 预选词：词源在服务端，界面不得自己造词 ----
    const vocabulary = require('../src/ai/search-vocabulary');
    const desktopViews = fs.readFileSync(path.join(__dirname, '../src/renderer/ai-views.js'), 'utf8');
    const webViews = fs.readFileSync(path.join(__dirname, '../src/web/js/ai-views.js'), 'utf8');
    const embeddingSrc = fs.readFileSync(path.join(__dirname, '../src/ai/embedding.js'), 'utf8');
    assert.ok(
      vocabulary.TERMS.length >= 200,
      '词表要够宽（任何一类的图库都能被命中几个），当前只有 ' + vocabulary.TERMS.length + ' 个词',
    );
    const zh = new Set();
    const en = new Set();
    for (const pair of vocabulary.TERMS) {
      assert.ok(
        Array.isArray(pair) && pair.length === 2 && pair.every((s) => typeof s === 'string' && s.trim()),
        '词表的每一项都要是 [中文, 英文] 两个非空字符串：' + JSON.stringify(pair),
      );
      assert.ok(!zh.has(pair[0]), '中文词重复：' + pair[0]);
      assert.ok(!en.has(pair[1]), '英文词重复：' + pair[1]);
      zh.add(pair[0]);
      en.add(pair[1]);
    }
    assert.equal(vocabulary.labelsFor('en').length, vocabulary.TERMS.length);
    assert.equal(vocabulary.labelsFor('zh-CN')[0], vocabulary.TERMS[0][0], '非 en 一律给中文版');
    assert.equal(vocabulary.labelsFor('en')[0], vocabulary.TERMS[0][1], 'en 给英文版');
    // 词表只能有一份：worker 从模块引入，界面不许再抄一份。
    assert.match(workerSrc, /require\('\.\.\/ai\/search-vocabulary'\)/, 'worker 要从模块引入词表');
    for (const [name, src] of [
      ['桌面端 ai-views', desktopViews],
      ['网页端 ai-views', webViews],
    ]) {
      assert.ok(
        !/var SEARCH_POOL\s*=/.test(src),
        name + ' 里不许再有本地词池 —— 词表在 src/ai/search-vocabulary.js，抄一份必然漂移',
      );
      // 这是本次要修掉的病根：一个词都不达标就回退整份静态词库，于是「已知 0 张」的词
      // 照样被摆出来给用户点。断言三条一起钉：**洗牌函数只能读服务端给的那一份池子**
      // （不许出现任何本地词表的影子）、必须真的把那一块收起来、必须带 lang 问服务端。
      // 只查「有没有那句老代码原文」是不够的 —— 换个变量名、把词表搬到别的文件里都能绕过。
      const pickBody = /function pickSuggestions\([\s\S]*?\n {4}\}/.exec(src);
      assert.ok(pickBody, name + ' 要能定位到 pickSuggestions');
      assert.match(pickBody[0], /suggestPool\.slice\(\)/, name + ' 洗牌只能从服务端给的池子里取');
      assert.ok(
        !/EXAMPLES|SEARCH_POOL/.test(pickBody[0]),
        name + ' 洗牌函数里不许出现任何本地词表（那就是「写死的词」回来的路）',
      );
      assert.match(
        src,
        /hidden = true/,
        name + ' 挑不出词时要把预选词那一块整体收起来（不是摆空壳）',
      );
      assert.match(
        src,
        /\{\s*lang:\s*lang,\s*limit:/,
        name + ' 要按 `{ lang, limit }` 问服务端（词表与排序都在服务端）',
      );
      assert.match(
        src,
        /(?:\.call\('aiSearchSuggest'|post\('\/api\/ai-search-suggest')/,
        name + ' 要问对预选词接口',
      );
    }
    // 预选词的词表向量靠缓存（几百条现码一次要十几秒），缓存键必须带上模型与词表原文。
    assert.match(workerSrc, /vocab-vectors-/, 'worker 要有词表向量缓存');
    assert.match(workerSrc, /data\.model !== MODEL_KEY/, '缓存要按模型失效');
    assert.match(
      workerSrc,
      /if \(data\.labels\[i\] !== labels\[i\]\) return null/,
      '缓存要按词表原文失效（改词表自动重算）',
    );
    // `readOnly` 必须 `return await`，不能只写 `return`。`execute` 的外层是
    // `try { ... } finally { store.close(); await encoder.dispose(); }`，而
    // `return <promise>` 会**先求值、立刻执行 finally**，于是 `dispose()` 与仍在跑的
    // 只读请求并发：编码器会话被释放、SQLite 连接被关掉，而 readOnly 还在用它们。
    // 实测症状是**搜图与预选词全挂**（`An error occurred during model execution:
    // "Error: Session already disposed."`），且失败点会随 dispose 与推理谁先跑完而漂移
    // ——有时第一批就死、有时编码完 13 秒才在打分阶段死，因此极易被误判成随机故障。
    // 这条断言只有两个方向都可验才算数：改回 `return readOnly(` 必须 FAIL。
    assert.match(
      workerSrc,
      /return await readOnly\(/,
      'readOnly 必须 `return await`：否则 finally 会在它跑完之前就关掉库连接与编码器',
    );
    assert.ok(
      !/\breturn readOnly\(/.test(workerSrc),
      '不许写成 `return readOnly(...)`（会把 dispose/close 与只读请求并发，搜图与预选词一起挂）',
    );
    // 取样窗口的起点必须落在**入库 id 自己的范围**里。老写法从 [1, maxId] 取，
    // 而入库 id 只占整个 id 空间的一小段，于是绝大多数窗口反复读同一批最早的行
    // （本机实测 sampled 恒为 500/7374，把真有的 84 张「人物肖像」判成 0）。
    // 断言两条：起点锚在 `bounds.lo`（入库 id 下界），且这一段里**不许出现随机数** ——
    // 只查「有没有那句老代码原文」是不够的，随手换个变量名就能绕过（负例验过）。
    assert.match(indexStoreSrc, /MIN\(photo_id\)/, '取样前要看入库 id 的下界');
    const scoreCandidatesBody = /async scoreCandidates\([\s\S]*?\n {2}\}/.exec(indexStoreSrc);
    assert.ok(scoreCandidatesBody, '要能定位到 scoreCandidates 的实现');
    assert.match(
      scoreCandidatesBody[0],
      /bounds\.lo\s*\+/,
      '窗口起点必须从入库 id 的下界起算，否则又会反复读同一批最早的行',
    );
    assert.ok(
      !/Math\.random/.test(scoreCandidatesBody[0]),
      '取样必须确定性（同一份库重跑结果一致是硬契约），不许用随机起点',
    );
    // padding 长度是不能动的刻度：改成动态 padding 快 15 倍，但向量差 0.38，
    // 而整个阈值标定（默认 0.02）是在 max_length=64 下做的。
    assert.match(embeddingSrc, /padding: 'max_length'/, "text() 必须用 'max_length' 补齐");
    assert.ok(
      !/padding:\s*true/.test(embeddingSrc),
      "不许改成动态 padding：向量会变，等于把阈值标定作废",
    );
    assert.match(embeddingSrc, /max_length: 64/, 'max_length 必须是 64（阈值标定的刻度）');
    console.log('[semantic-regression] PASS');
  } finally {
    if (service) service.dispose();
    if (store) store.close();
    if (source) source.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
