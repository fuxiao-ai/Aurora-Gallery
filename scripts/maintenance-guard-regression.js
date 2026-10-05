'use strict';
// 数据库维护的准入判断：AI 索引忙时不许做维护（否则必然撞 `database is locked`）、
// 启动期三个写库任务（缩略图标记修复 / 延迟索引 / FTS 维护）必须排成一队、
// VACUUM 磁盘不够时提前拦住（12.9 GB 的库跑到一半写满盘比直接拒绝危险得多）。
//
// 规则本身（谁在占着库 / 排队 / 需要多少空间 / 够不够）在 src/main/maintenance-guard.js
// 与 src/main/db-write-queue.js 里，是纯逻辑，这里用假数据直接验行为；
// 「有没有接线到 main.js 与界面文案」用源码契约兜底，因为 main.js 一上来就 require electron，
// 没法在回归里加载执行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../src/main/maintenance-guard');
const { createDbWriteQueue } = require('../src/main/db-write-queue');

const MB = 1024 * 1024;

function testAiIndexBusy() {
  assert.equal(guard.aiIndexBusy([]), false, '没有服务时不算忙');
  assert.equal(guard.aiIndexBusy([null, undefined]), false, '服务未初始化不算忙');
  assert.equal(
    guard.aiIndexBusy([{ status: () => ({ busy: false }) }, { status: () => ({ busy: false }) }]),
    false,
    '两套索引都空闲',
  );
  assert.equal(
    guard.aiIndexBusy([{ status: () => ({ busy: false }) }, { status: () => ({ busy: true }) }]),
    true,
    '任一套索引在跑都算忙',
  );
  // 探活报错不能让维护流程崩掉，也不能掩盖另一套索引真的在跑。
  const errors = [];
  assert.equal(
    guard.aiIndexBusy(
      [
        {
          status: () => {
            throw new Error('probe-boom');
          },
        },
      ],
      (e) => errors.push(e),
    ),
    false,
    '探活失败按「不忙」处理',
  );
  assert.equal(errors.length, 1, '探活失败要报给调用方去记日志');
  assert.match(String(errors[0].message), /probe-boom/);
  assert.equal(
    guard.aiIndexBusy(
      [
        {
          status: () => {
            throw new Error('probe-boom');
          },
        },
        { status: () => ({ busy: true }) },
      ],
      () => {},
    ),
    true,
    '前一个探活失败不能遮住后一个真的在跑',
  );
}

function testVacuumWorkspace() {
  const pageSize = 4096;
  const pageCount = 1000;
  const fileSize = pageSize * pageCount;
  const live = (pageCount - 200) * pageSize;
  assert.equal(
    guard.vacuumWorkspaceBytes({ pageSize, pageCount, freePages: 200, fileSize }),
    Math.round(live * 1.15) + 64 * MB,
    '按「压缩后大小」估，而不是整份文件大小',
  );
  // 碎片多的库：按文件大小估会要求 109 MB，按可回收后的实际大小只要 69 MB 左右。
  const bigCount = 10000;
  const bigFileSize = pageSize * bigCount;
  const fragmented = guard.vacuumWorkspaceBytes({
    pageSize,
    pageCount: bigCount,
    freePages: 9000,
    fileSize: bigFileSize,
  });
  const byFileSize = Math.round(bigFileSize * 1.15) + 64 * MB;
  assert.ok(
    fragmented < byFileSize - 30 * MB,
    '碎片多的库必须按可回收后的大小估，否则会把本来能做的优化挡在门外',
  );
  // 参数不全都返回 0 = 「不拦」，交给 SQLite 自己报错，好过用错数据误判。
  for (const stats of [
    null,
    {},
    { pageSize, pageCount, fileSize: 0 },
    { pageSize: 0, pageCount, fileSize },
  ])
    assert.equal(guard.vacuumWorkspaceBytes(stats), 0, JSON.stringify(stats) + ' 估不出来就不拦');
}

function testVacuumSpaceShortage() {
  const need = 1000 * MB;
  assert.equal(guard.vacuumSpaceShortage(0, [{ label: 'x', free: 0 }]), '', '需求未知就不拦');
  assert.equal(
    guard.vacuumSpaceShortage(need, [
      { label: '数据库所在分区', free: 2000 * MB },
      { label: '系统临时目录', free: need },
    ]),
    '',
    '两处都够就放行',
  );
  assert.equal(
    guard.vacuumSpaceShortage(need, [
      { label: '数据库所在分区', free: -1 },
      { label: '系统临时目录', free: 2000 * MB },
    ]),
    '',
    '取不到可用空间时按「未知」放行，不能误报空间不足',
  );
  const message = guard.vacuumSpaceShortage(need, [
    { label: '数据库所在分区', free: 400 * MB },
    { label: '系统临时目录', free: 2000 * MB },
  ]);
  assert.match(message, /磁盘空间不足/, '空间不够要明确拒绝');
  assert.match(message, /数据库所在分区可用 400\.0 MB/, '要把差多少、哪里差说清楚');
  assert.match(message, /系统临时目录可用 2\.0 GB/, '两处都要列出来');
}

function testReclaimable() {
  // 真实场景：12 GB 的库只有 426 个空洞页 ≈ 1.7 MB。VACUUM 要重写整库、多占十几 GB，
  // 收益却可以忽略——这个数字必须能报给用户看，否则他会以为「优化」总能腾出很多空间。
  assert.equal(guard.vacuumReclaimableBytes({ pageSize: 4096, freePages: 426 }), 4096 * 426);
  assert.equal(guard.vacuumReclaimableBytes({ pageSize: 4096, freePages: 0 }), 0);
  assert.equal(guard.vacuumReclaimableBytes(null), 0, '参数缺失按 0 处理，不能抛');
  assert.equal(guard.formatBytes(4096 * 426), '1.7 MB', '小数字不能用 GB 显示（会变成 0.0 GB）');
  assert.equal(guard.formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(guard.formatBytes(1536), '1.5 KB');
  assert.equal(guard.formatBytes(10), '10 B');
}

function testFreeDiskBytes() {
  assert.ok(guard.freeDiskBytes(os.tmpdir()) > 0, '真实卷要能拿到可用空间');
  assert.equal(
    guard.freeDiskBytes(path.join(os.tmpdir(), 'aurora-no-such-path-' + Date.now())),
    -1,
    '路径不存在返回 -1（未知），而不是 0（会误判成空间不足）',
  );
  assert.equal(
    guard.freeDiskBytes('x', () => ({ bavail: 10, bsize: 4096 })),
    40960,
  );
  assert.equal(
    guard.freeDiskBytes('x', () => ({ bavail: undefined, bsize: 4096 })),
    -1,
  );
  assert.equal(
    guard.freeDiskBytes('x', () => {
      throw new Error('statfs-boom');
    }),
    -1,
    'statfs 抛错不能把维护流程带崩',
  );
}

async function testDbWriteQueue() {
  const events = [];
  const queue = createDbWriteQueue({
    onStart: (name) => events.push('start:' + name),
    onSettle: (name, error) => events.push('done:' + name + (error ? '!' : '')),
  });
  assert.equal(queue.isBusy(), false, '空队列不算忙');
  assert.equal(queue.busyName(), '', '空队列没有「在等谁」');

  let running = 0;
  let maxRunning = 0;
  const order = [];
  const gate = {};
  const hold = new Promise((resolve) => {
    gate.release = resolve;
  });

  // 第一个任务卡在 gate 上；后两个必须排队等它，而不是并排抢同一把写锁。
  const first = queue.run('thumbnail-fix', async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push('thumbnail-fix');
    await hold;
    running -= 1;
    return 'a';
  });
  // 让第一个任务真正开跑（run 的第一段是微任务）。
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.isBusy(), true, '有任务在跑就是忙');
  assert.equal(queue.busyName(), 'thumbnail-fix', '在跑的任务名就是忙碌原因');

  const second = queue.run('deferred-index', () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push('deferred-index');
    running -= 1;
  });
  const third = queue.run('fts-index', () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push('fts-index');
    running -= 1;
  });
  assert.equal(queue.busyName(), 'thumbnail-fix', '有人排队时优先报正在跑的那个');

  gate.release();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['thumbnail-fix', 'deferred-index', 'fts-index'], '严格按先来后到');
  assert.equal(maxRunning, 1, '同一时刻至多一个任务在写库');
  assert.equal(queue.isBusy(), false, '都跑完了就不再忙');
  assert.deepEqual(events, [
    'start:thumbnail-fix',
    'done:thumbnail-fix',
    'start:deferred-index',
    'done:deferred-index',
    'start:fts-index',
    'done:fts-index',
  ]);

  // 前面那个炸了不能把后面的卡在队里 —— 启动期的任务都必须跑到。
  const failed = queue.run('boom', () => {
    throw new Error('locked');
  });
  const after = queue.run('next', () => 'ok');
  await assert.rejects(failed, /locked/, '失败要向调用方暴露原始错误');
  assert.equal(await after, 'ok', '队尾要吃掉失败，后面的照跑');
  assert.equal(queue.isBusy(), false, '失败之后队列也要回到空闲');

  // 名字可能重复（手动维护按操作名入队），所以内部必须按票据而不是按名字取消。
  const dup = [];
  const a = queue.run('same', async () => {
    await Promise.resolve();
    dup.push('a');
  });
  const b = queue.run('same', () => dup.push('b'));
  await Promise.all([a, b]);
  assert.deepEqual(dup, ['a', 'b'], '同名任务不许互相顶掉');
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/** 项目内多处静态守护沿用的剥注释写法：断言不该被注释里的示例代码带跑。 */
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

/**
 * 接线契约：模块里的规则要被真正用起来，界面也得认得新错误码。
 * 这些是「读源码」级别的断言，只兜底接线，规则本身由上面的行为断言覆盖。
 */
function testWiringContracts() {
  const mainSource = readSource('src/main.js');
  assert.match(
    mainSource,
    /aiIndexTaskBusy\(\)\s*\|\|/,
    'maintenanceBusy() 必须把「AI 索引在跑」算进忙碌，否则维护仍会撞 database is locked',
  );
  assert.match(
    mainSource,
    /maintenanceGuard\.aiIndexBusy\(\s*\[semanticSearch, faceService\]/,
    'AI 忙碌探活要覆盖两套索引',
  );
  assert.match(
    mainSource,
    /vacuumSpaceShortage\(\)[\s\S]{0,200}?dialog\.showMessageBox/,
    '优化数据库前必须先做磁盘预检，再做确认弹窗',
  );
  // T4b 起「维护期间给 AI_MAINTENANCE」的判据搬进了 `src/main/ai-index-gate.js`（剥出来才能
  // 被行为断言真跑，main.js 一 require 就要 electron）。这里只兜接线，分支语义交给
  // `ai-index-gate-regression.js` —— 特别是「启动期 FTS 不得拦 AI 索引」那条。
  assert.equal(
    (mainSource.match(/aiIndexCanRun\(/g) || []).length,
    2,
    '两套 AI 服务的 canRun 都必须接线到 ai-index-gate 的判据（漏掉一个 = 那套索引没有闸门）',
  );
  // 桌面端的错误文案映射：新错误码要能翻成一句人话，否则用户只会看到裸错误码。
  for (const file of [
    'src/web/js/semantic-search.js',
    'src/web/js/people.js',
    'src/web/js/ai-views.js',
    'src/renderer/ai-views.js',
  ])
    assert.match(readSource(file), /AI_MAINTENANCE/, file + ' 要把 AI_MAINTENANCE 翻成人话');
}

/**
 * 启动期写库任务的接线契约。
 *
 * 这一类的 bug 全是「规则有了但没接上」：闸门写好了却漏登记一个任务，于是它照样抢锁。
 * 断言只兜接线的存在性，行为由 testDbWriteQueue 与 maintenance-regression 覆盖。
 */
function testDbWriteWiringContracts() {
  const mainSource = readSource('src/main.js');
  assert.match(
    mainSource,
    /maintenanceBusy\(\)\s*\{[\s\S]{0,600}?dbWriteQueue\.isBusy\(\)\s*\|\|/,
    'maintenanceBusy() 必须把启动期写库任务算进忙碌，否则维护仍会等满 8s 撞 database is locked',
  );
  for (const name of ['thumbnail-fix', 'deferred-index', 'fts-index']) {
    // ⚠️ `\s*` 是必要的：T3 给这些调用点加了 `{ priority: … }` 第三参后，`.run(` 与任务名
    // 之间会换行。断言守的是「真的排进队」这件事，不该顺带规定写成几行。
    assert.match(
      mainSource,
      new RegExp("\\.run\\(\\s*'" + name + "'"),
      '启动任务 ' + name + ' 必须真的排进队，而不是自己 setTimeout 点火',
    );
  }
  // 反方向：会写库的重活起跑前也要过闸门。但**两个长任务换了一种过法** ——
  // 缩略图回填 / 重复哈希现在按批次反复入队（串行由队列给出，不再靠起跑前的一次快照），
  // 所以它们的准入判据刻意**不再**用 dbWriteQueue.isBusy()：批次化后那个信号
  // 「批间空、批中满」，拿它当「库被长期占用」会抖成「有时能启动、有时被静默跳过」，
  // 而自动路径不重试，跳过就等于永久漏掉。它们改为只挡**另一个长任务**（不并行抢磁盘），
  // 串行由「每一批都重新入队」保证（下面逐条断言）。
  const mainCode = stripComments(mainSource);
  // 扫描（T2）：准入从「同步拒绝」改成「进同一个队列排队」。
  // 旧写法是 `if (optimizeTaskRunning || dbWriteQueue.isBusy()) return { success:false, ... }`
  // —— 拿一个「批间空、批中满」的信号当门槛，用户会不会被拒成了碰运气。
  // 这条守着「不得退回同步拒绝」；扫描确实占住闸门由下面那条正方向断言兜。
  const enqueueScanBody = sliceFunctionBody(mainCode, 'function enqueueScanTask(task) {');
  assert.ok(enqueueScanBody.length > 0, '找不到 enqueueScanTask —— 函数签名变了，请同步本回归');
  assert.equal(
    /dbWriteQueue\.isBusy\(\)/.test(enqueueScanBody),
    false,
    '扫描不得再用 dbWriteQueue.isBusy() 同步拒绝（批次化后它会抖）；应改为排队',
  );
  // 正方向：扫描 worker 是逐批 COMMIT 的**真实写者**，必须占住同一把闸门，
  // 否则启动期的 thumbnail-fix / deferred-index / FTS 会和它同时持写锁 —— 队列的串行对它无效。
  const scanQueueBody = sliceFunctionBody(mainCode, 'async function processScanQueue() {');
  assert.ok(scanQueueBody.length > 0, '找不到 processScanQueue —— 函数签名变了，请同步本回归');
  assert.match(
    scanQueueBody,
    /dbWriteQueue\s*\.run\(\s*'scan'/,
    '扫描必须占住写库闸门（它是逐批 COMMIT 的真实写者），否则队列的「串行」对它无效',
  );
  assert.match(
    scanQueueBody,
    /settleScanTask\(task,/,
    '扫描的每个出口都要走 settleScanTask（先摘去重表再 resolve），否则会留下永久占位的死任务',
  );
  for (const [signature, peer, queueName] of [
    ['async function runThumbnailBackfill(limit) {', 'duplicateHashTask\\.running', 'thumbnail-backfill'],
    ['async function runDuplicateHashDetection() {', 'thumbnailBackfill\\.running', 'dup-hash'],
  ]) {
    const body = sliceFunctionBody(mainCode, signature);
    assert.ok(body.length > 0, '找不到 ' + signature + ' —— 函数签名变了，请同步本回归');
    const gateEnd = body.indexOf("reason: 'maintenance'");
    const gate = gateEnd > 0 ? body.slice(0, gateEnd) : body;
    assert.match(
      gate,
      new RegExp(peer),
      signature + ' 的准入必须挡住另一个长任务（两个长任务不并行抢磁盘）',
    );
    assert.equal(
      /dbWriteQueue\.isBusy\(\)/.test(gate),
      false,
      signature + ' 的准入判据不能用 dbWriteQueue.isBusy() —— 批次化后它会抖，任务会被静默跳过',
    );
    assert.match(
      body,
      // `\s*`：T3 加了 `{ priority: … }` 第三参后 `.run(` 与任务名之间会换行
      new RegExp("\\.run\\(\\s*'" + queueName + "'"),
      '长任务 ' + queueName + ' 必须把每一批都包进写库队列，否则又会整轮持锁',
    );
  }
  assert.match(
    mainSource,
    /function maintenanceBusyMessage\(\)[\s\S]{0,400}?dbWriteBusyLabel\(\)/,
    '被挡时要报出「在等谁」，不能只给笼统的「后台任务进行中」',
  );
  // 手动维护也必须入队：handler 里 maintenanceBusy() 只是快照，中间还有 setTimeout(0) 的缝。
  for (const operation of ['rebuildThumbnailFlags', 'optimizeDatabase'])
    assert.match(
      mainSource,
      new RegExp(
        "dbWriteQueue\\s*\\.run\\(\\s*'[^']+',\\s*\\(\\) =>\\s*performMaintenance\\('" + operation + "'",
      ),
      '手动维护 ' + operation + ' 也要排队，否则仍有抢锁窗口',
    );

  const databaseSource = readSource('src/database.js');
  assert.match(
    databaseSource,
    /worker\.on\('exit'[\s\S]{0,300}?resolve\(/,
    'applyDeferredThumbnailFix 必须在 worker 退出（连接关掉）后才 resolve，否则登记早了等于没登记',
  );
  assert.equal(
    /ensurePhotosThumbnailMissingIndex\s*\(/.test(databaseSource),
    false,
    '主线程那份同步的全表 UPDATE 双胞胎已删除，不许复活（它无人调用却带着几十秒的写锁占用）',
  );

  const workerSource = readSource('src/workers/thumbnail-fix-worker.js');
  assert.match(workerSource, /schema_migrations/, '一次性迁移要有落库标记');
  assert.match(
    workerSource,
    /CREATE TABLE IF NOT EXISTS schema_migrations/,
    '标记表要是它自己建的，不能指望别处先建好',
  );
  assert.match(
    workerSource,
    /if \(appliedAt\) \{[\s\S]{0,200}?already-applied/,
    '已修过的库必须一次主键查询就退出，不扫任何一行',
  );
  assert.match(
    workerSource,
    /id > \? AND id <= \? AND has_thumbnail = 1 AND thumbnail IS NULL/,
    '候选扫描要按 id 区间分批（走的才是 idx_photos_hasThumb 的 (has_thumbnail, rowid) 范围键）',
  );
  assert.equal(
    /'UPDATE photos SET has_thumbnail = 0 WHERE has_thumbnail = 1 AND thumbnail IS NULL'/.test(
      workerSource,
    ),
    false,
    '不许再出现整表一条 UPDATE：76 秒全在一个写事务里，维护 worker 必然撞锁',
  );
  assert.match(workerSource, /setTimeout\(step, 0\)/, '批间要让出事件循环，别的连接才有机会插进来');

  const poolSource = readSource('src/db-read-worker-pool.js');
  assert.match(
    poolSource,
    /'db-read-worker timeout: ' \+ job\.op/,
    '超时要带上是哪个查询，否则队列里挤着几个时分不出是谁被拖死的',
  );
}

/**
 * 「清理失效记录」的接线契约。
 *
 * 这个任务最容易漏：名字听着像只读巡检，其实每批都是一段
 * `BEGIN TRANSACTION … DELETE … COMMIT`（见 database.js 的 cleanupMissingFilesYielding）。
 * 它过去两个调用点都直接调用、不认识写库队列，于是能和启动期迁移同时抢写锁。
 * 真库实测（2026-09-29）里它的批次窗口与队列里第一个任务的窗口完全重叠，
 * 只是那批恰好 deleted=0（没真的写）才没炸 —— 靠运气躲过的锁冲突，必须用契约钉死。
 */
function testInvalidCleanupWiring() {
  const mainSource = readSource('src/main.js');

  // 前提：这个方法确实是写事务。哪天它变成纯只读了，这条契约的「为什么」就过期了，
  // 应该连着一起改，而不是让注释撒谎。
  const dbSource = readSource('src/database.js');
  const yieldingStart = dbSource.indexOf('  cleanupMissingFilesYielding(options = {}) {');
  assert.ok(yieldingStart > 0, 'cleanupMissingFilesYielding 必须还在');
  const yieldingBody = dbSource.slice(yieldingStart, yieldingStart + 12000);
  // 顺序是先 prepare('DELETE …') 再 BEGIN TRANSACTION，所以只断言三件事都在，不假定次序。
  assert.match(
    yieldingBody,
    /DELETE FROM photos WHERE id = \?[\s\S]{0,300}?BEGIN TRANSACTION[\s\S]{0,400}?COMMIT/,
    'cleanupMissingFilesYielding 每批都是 DELETE 写事务（prepare → BEGIN → COMMIT）—— 这正是它必须排进写库队列的理由',
  );

  assert.match(
    mainSource,
    /function runInvalidCleanupBatch\(options\) \{[\s\S]{0,400}?dbWriteQueue\s*\.run\(\s*'invalid-cleanup',\s*function \(\) \{\s*return db\.cleanupMissingFilesYielding\(options\);/,
    '清理批次必须包在写库队列里跑，不能直接调',
  );
  // 有牙齿的一条：全项目只许留一个「真正调用」它的地方（就是上面那个助手）。
  // 谁在别处再写一次 db.cleanupMissingFilesYielding( 就会变成 2 → 失败。
  const directCalls = (mainSource.match(/db\.cleanupMissingFilesYielding\(/g) || []).length;
  assert.equal(
    directCalls,
    1,
    'main.js 里只许有助手内部那一次真实调用；其余地方一律走 runInvalidCleanupBatch（实际 ' +
      directCalls +
      ' 次）',
  );
  assert.equal(
    (mainSource.match(/runInvalidCleanupBatch\(/g) || []).length,
    3,
    '启动期顺带清理 + 用户手动清理两个调用点都要走助手（定义 1 次 + 调用 2 次）',
  );

  // 被挡时要能报出「在等谁」，否则界面上只会看到裸任务名 invalid-cleanup。
  assert.match(
    mainSource,
    /name === 'invalid-cleanup'\) return '[^']+'/,
    'dbWriteBusyLabel() 要认 invalid-cleanup，界面才不会显示英文任务名',
  );
  // 用户手动清理的准入也要查同一个闸门（一次性的，不重试，所以不会饥饿）。
  assert.match(
    mainSource,
    /'maintenance-cleanup-missing-files'[\s\S]{0,600}?if \(maintenanceBusy\(\)\)\s*\{\s*return \{ success: false, error: maintenanceBusyMessage\(\) \}/,
    '手动清理要先查 maintenanceBusy()，否则能在启动期迁移正跑时开枪',
  );
}

testAiIndexBusy();
testVacuumWorkspace();
testVacuumSpaceShortage();
testReclaimable();
testFreeDiskBytes();
testWiringContracts();
testDbWriteWiringContracts();
testInvalidCleanupWiring();

testDbWriteQueue()
  .then(() => console.log('[maintenance-guard-regression] PASS'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
