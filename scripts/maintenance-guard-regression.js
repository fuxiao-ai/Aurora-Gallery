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
    guard.aiIndexBusy([{ status: () => ({ running: false }) }, { status: () => ({ running: false }) }]),
    false,
    '两套索引都空闲',
  );
  assert.equal(
    guard.aiIndexBusy([{ status: () => ({ running: false }) }, { status: () => ({ running: true }) }]),
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
        { status: () => ({ running: true }) },
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
  // 顺序契约：先算磁盘再问用户。弹窗从「系统弹窗」换成了主题弹窗（`confirmInApp`，见
  // `app-dialog-bridge-regression.js`），但**判据本身不变** —— 这里钉的始终是先后顺序，
  // 不是那个具体的弹窗 API。
  assert.match(
    mainSource,
    /vacuumSpaceShortage\(\)[\s\S]{0,400}?confirmInApp\(/,
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
  // 🔴 两个长任务（缩略图补全 / 重复比对）的准入判据**必须住在一个共用函数里**，
  //    IPC 入口与任务内部都调它，不许各写一份。
  //    理由（2026-10-06 用户报「补齐缩略图点击之后不开始」）：两边各写一份就会漂移 ——
  //    `start-thumbnail-backfill` 漏了 `duplicateHashTask.running`、而任务内部有这一条，
  //    于是「重复比对正跑着」时点开始补全：IPC 三道闸全过 ⇒ 返回 `{ success: true }`、
  //    前端不弹任何提示，任务却立刻 `return { started: false }`（返回值被丢弃）⇒
  //    界面刷新后显示「未运行」。**用户看到的就是「点下去什么都没发生」。**
  //    所以这里钉两件事：①任务内部走共用判据 ②判据本体挡住了另一个长任务。
  for (const [signature, judgeSignature, peer, queueName] of [
    [
      'async function runThumbnailBackfill(limit) {',
      'function thumbnailBackfillBlockReason() {',
      'duplicateHashTask\\.running',
      'thumbnail-backfill',
    ],
    [
      'async function runDuplicateHashDetection() {',
      'function duplicateHashBlockReason() {',
      'thumbnailBackfill\\.running',
      'dup-hash',
    ],
  ]) {
    const body = sliceFunctionBody(mainCode, signature);
    assert.ok(body.length > 0, '找不到 ' + signature + ' —— 函数签名变了，请同步本回归');

    const judgeName = judgeSignature.slice('function '.length, judgeSignature.indexOf('('));
    assert.match(
      body,
      new RegExp(judgeName + '\\(\\)'),
      signature + ' 的准入必须走共用判据 ' + judgeName + '()（内联回任务体 = 下次漂移的起点）',
    );

    const judgeBody = sliceFunctionBody(mainCode, judgeSignature);
    assert.ok(judgeBody.length > 0, '找不到判据函数 ' + judgeSignature + ' —— 签名变了，请同步本回归');
    assert.match(
      judgeBody,
      new RegExp(peer),
      judgeSignature + ' 必须挡住另一个长任务（两个长任务不并行抢磁盘）',
    );
    assert.equal(
      /dbWriteQueue\.isBusy\(\)/.test(judgeBody),
      false,
      judgeSignature + ' 不能用 dbWriteQueue.isBusy() —— 批次化后它会抖，任务会被静默跳过',
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

  // 🔴 方向契约（2026-10-05）：清理的候选**统一倒序**（新记录优先），游标是排他上界 `beforeId`。
  //    旧代码只有「无游标」那一支是 DESC、带游标那一支却是 `id > ? ORDER BY id ASC` ——
  //    同一个任务两种方向混用，第二批还会与第一批重叠几百行。
  //    下面钉的是**真实 SQL 行**，不是注释里的字面量（改动说明里就引用了旧写法，用整文件正则必然误判）。
  const descPick =
    /prepare\('SELECT id, file_path FROM photos WHERE id < \? ORDER BY id DESC LIMIT \?'\)/g;
  assert.equal(
    (dbSource.match(descPick) || []).length,
    2,
    'cleanupMissingFiles / cleanupMissingFilesYielding 的游标批次都必须倒序（排他上界 id < ?）',
  );
  assert.match(
    mainSource,
    /beforeId: startupInvalidCleanupTask\.beforeId/,
    '启动期清理必须把倒序游标传下去（beforeId），不能再有升序 afterId',
  );
  assert.match(mainSource, /beforeId: beforeId,/, '用户手动清理同样走倒序游标');

  // ---- 打点收敛 + 避让范围（2026-10-06）-------------------------------------
  // 背景：缩略图补全在跑时，本任务的让路分支**每 5 秒**走到一次。过去每次都打一条 stage，
  // 而 `startup-metrics` 的 stage 数组有上限（400 条）—— 同族的 `auto-dup-hash.defer`
  // 正是为此才加的 `autoDuplicateHashDeferCount`（见 `startup-metrics.js` 的 MAX_STAGES 注释）。
  // 下面钉的是「同一个病不许犯第二次」，以及避让范围本身。
  const cleanupBody = stripComments(
    sliceFunctionBody(mainSource, 'function scheduleStartupInvalidCleanup() {'),
  );
  // 🔴 前置哨兵：函数体取空会让下面所有「不许含 X」的断言**静默假绿**。
  assert.ok(
    cleanupBody.length > 500 && cleanupBody.includes('function step()'),
    '守护自身前置：scheduleStartupInvalidCleanup 的函数体必须取到（取空 ⇒ 下面的反向断言全是假绿）',
  );
  assert.match(
    cleanupBody,
    /invalidCleanupDeferCount \+= 1;[\s\S]{0,240}?if \(invalidCleanupDeferCount === 1\) \{[\s\S]{0,160}?startupStageLog\('invalid-cleanup\.defer'/,
    '让路分支必须计数、且**只打第一条** —— 每 5 秒一条会吃光 startup-metrics 的 stage 额度',
  );
  assert.equal(
    (cleanupBody.match(/startupStageLog\('invalid-cleanup\.defer'/g) || []).length,
    1,
    'invalid-cleanup.defer 只许有这一处打点：再加一处就等于把刚收敛好的口子又重新打开',
  );
  [
    'isFolderScanRunning()',
    'interactionPreempt.active()',
    'previewPlaybackActive',
  ].forEach((k) => {
    assert.ok(
      cleanupBody.includes(k),
      '让路条件必须保留「交互 / 扫描」这一类避让（这正是本函数最初的避让理由）：' + k,
    );
  });
  ['thumbnailBackfill.running', 'duplicateHashTask.running'].forEach((k) => {
    assert.equal(
      cleanupBody.includes(k),
      false,
      '**不许**再避让 ' +
        k +
        '：避让发生在入队之前 ⇒ PRIORITY.REPAIR(=1) 对它们永远用不上（自相矛盾）；' +
        '而本任务只做 existsSync，与补全抢的不是同一类 I/O（实测每批 400 行仅 40~385 ms）',
    );
  });
  assert.match(
    cleanupBody,
    /if \(invalidCleanupDeferCount > 0 && !invalidCleanupStartLogged\) \{/,
    '「真正开始」那条打点必须有闸门：否则每批都打一次，等于换个地方刷屏',
  );
  assert.match(
    cleanupBody,
    /'invalid-cleanup\.finish',[\s\S]{0,260}?deferredTimes=/,
    'finish 必须带上被推迟次数，否则「等了多久才真正跑起来」事后无从回答',
  );
}

/**
 * 查重指纹的候选顺序契约（2026-10-05，与缩略图补全同一条策略）：**主键倒序、新导入的先算指纹**。
 *
 * 这条和缩略图补全一样容易「只改一半」：查询改成 `id < ?` 而调用端还从 0 起手，等价于
 * `id < 0` —— 恒空，任务「秒完成」却一张都没算，且不报任何错。
 */
function testHashScanDirection() {
  const dbSource = readSource('src/database.js');
  const mainSource = readSource('src/main.js');
  const start = dbSource.indexOf('  getHashAllPhotosBefore(beforeId, batchSize) {');
  assert.ok(start > 0, 'getHashAllPhotosBefore 必须还在（旧名 getHashAllPhotosAfter 已随倒序改造废弃）');
  const body = dbSource.slice(start, start + 1500);
  assert.match(body, /WHERE id < \?/, '查重候选必须是 id < ?（倒序游标的排他上界）');
  assert.match(body, /ORDER BY id DESC/, '查重候选必须 ORDER BY id DESC（最新入库优先）');
  assert.match(
    mainSource,
    /db\.getHashAllPhotosBefore\(beforeId, batchSize\)/,
    'runDuplicateHashDetection 必须用倒序游标（只改查询不改调用端 = 静默零哈希）',
  );
  // 🔴 缩略图补全在 2026-10-06 改成了**两趟**（先补缺缩略图的、再补只缺元数据的），
  //    于是它从「一条 `beforeId`」变成「`thumbCursor` + `metaCursor` **两条**」。
  //    两趟**各自**从 MAX(id)+1 起手、各自递减是承重的：共用一条的话，第一趟起手就把游标
  //    拉到「最大的那个缺图 id」（索引倒序扫的第一个命中），第二趟于是再也取不到它以上的行
  //    —— 那批的元数据永远补不上，且不报错、不写日志。所以这里数的是 **3**：
  //    查重 1 条 + 补全两趟各 1 条。
  assert.equal(
    (mainSource.match(/var (?:beforeId|thumbCursor|metaCursor) = db\.getMaxPhotoId\(\) \+ 1;/g) || [])
      .length,
    3,
    '查重 1 条 + 补全两趟各 1 条 = 3 条游标都必须从 MAX(id) + 1 起手（少一处就会静默零补/静默跳过）',
  );
  // ⚠️ 下面四条断言的对象**刻意不是整个 `main.js`**（21 万字符）：`assert.match` 一失败
  //    就会把整个被测字符串打进 diff，实测刷出 20 万字符、根本看不到是哪一处坏了
  //    （2026-10-06 验牙时真撞过）。这里只截 `runThumbnailBackfill` 函数的头部 9000 字符 ——
  //    两条游标声明（+3717/+3763）、两趟查询（+5043/+5113）、游标推进（+7188/+7251）全在里面。
  const backfillStart = mainSource.indexOf('async function runThumbnailBackfill(');
  assert.ok(backfillStart > 0, 'runThumbnailBackfill 必须还在（补全任务的唯一入口）');
  const backfillHead = mainSource.slice(backfillStart, backfillStart + 9000);
  assert.match(
    backfillHead,
    /var thumbCursor = db\.getMaxPhotoId\(\) \+ 1;/,
    '补全**第一趟**（只补缺缩略图的）游标必须存在',
  );
  assert.match(
    backfillHead,
    /var metaCursor = db\.getMaxPhotoId\(\) \+ 1;/,
    '补全**第二趟**（补元数据）的游标必须与第一趟分开 —— 共用一条会静默跳过中间所有行',
  );
  assert.match(
    backfillHead,
    /db\.getPhotosLackingThumbnailBefore\(thumbCursor, fetchLimit\)/,
    '第一趟必须走专门取「缺缩略图」的查询（否则还是会被只缺 EXIF 的行堵住，预览图恒 0）',
  );
  assert.match(
    backfillHead,
    /db\.getPhotosMissingThumbnailsBefore\(metaCursor, fetchLimit\)/,
    '第二趟必须走原来的候选查询 + 自己的游标（写成 thumbCursor = 静默跳过第一趟扫过的所有行）',
  );
}

testAiIndexBusy();
testVacuumWorkspace();
testVacuumSpaceShortage();
testReclaimable();
testFreeDiskBytes();
testHashScanDirection();
testWiringContracts();
testDbWriteWiringContracts();
testInvalidCleanupWiring();

testDbWriteQueue()
  .then(() => console.log('[maintenance-guard-regression] PASS'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
