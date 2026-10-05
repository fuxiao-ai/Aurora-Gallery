#!/usr/bin/env node
'use strict';

/**
 * AI 索引准入判据回归（T4b）。
 *
 * 背景：`semanticSearch.canRun` / `faceService.canRun` 过去读的是 `optimizeTaskRunning`，
 * 而那个变量**一义二用** —— 它同时表示
 *   ① 启动期的 FTS 索引（`ensureFtsIndex`，属**批量写**，与 AI 索引走同一条写库队列）
 *   ② 真正的独占维护（VACUUM / 重建缩略图标记，要重写整库）
 * 于是每次开机那十几秒（FTS rebuild 期间）用户点「建 AI 索引」都会拿到 `AI_MAINTENANCE`
 * —— 一句「数据库维护进行中」，而其实那时候点下去完全跑得起来。用户只会以为功能坏了。
 *
 * 物理依据：AI 索引（`src/ai/index-store.js`）对 photos.db 是 `readonly` 连接，
 * 向量只写自己的索引库；FTS rebuild 写的是 photos.db。两者**不碰同一个写锁**，
 * 而且都被同一条队列/各自的事务兜着，因此不需要互相拒绝。VACUUM 才需要 ——
 * 它要独占 photos.db，AI 索引那条长命的只读连接会把 VACUUM 顶成 `database is locked`。
 *
 * 本文件守两类契约：
 *   ① **行为面**（真 require 模块）：判据本身的分支与返回值形状。判据刻意剥成
 *      `src/main/ai-index-gate.js` 就是为了能这样测 —— main.js 一 require 就要 electron。
 *   ② **接线面**（读源码）：两个 `canRun` 真的用了这个判据、`exclusiveMaintenanceRunning`
 *      真的只在 VACUUM / 重建标记两处置位、**FTS 那处绝不能**置位、两个标志一起收口。
 *      这类错误全是静默的：漏加标志不会报错，只会让 AI 索引被永久拒之门外。
 */

const fs = require('node:fs');
const path = require('node:path');
const { aiIndexCanRun } = require('../src/main/ai-index-gate');

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/** 剥注释：注释里会提到被断言的名字（本项目已经栽过一次），不剥会假绿。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 取某段代码前后的窗口，用来做「这两个东西必须写在一起」这类局部断言。 */
function windowAround(src, needle, before, after) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  return src.slice(Math.max(0, at - before), at + needle.length + after);
}

// ---------------------------------------------------------------- 行为面

/** 🔴 T4b 的 bug 回归：FTS 在跑（即「非独占维护」）时**必须放行**。 */
function testFtsDoesNotBlockAiIndex() {
  assert(
    aiIndexCanRun({ exclusiveMaintenance: false, peerBusy: false }) === true,
    '启动期 FTS 索引在跑时不得拦 AI 索引 —— 这正是过去被误报 AI_MAINTENANCE 的场景',
  );
}

/** 独占维护（VACUUM / 重建标记）期间必须拒绝，且给的是**错误码**不是布尔。 */
function testExclusiveMaintenanceBlocks() {
  assert(
    aiIndexCanRun({ exclusiveMaintenance: true, peerBusy: false }) === 'AI_MAINTENANCE',
    'VACUUM / 重建缩略图标记期间必须拒绝 AI 索引，否则索引 worker 会把维护顶成 database is locked',
  );
}

/** 另一套 AI 索引在跑时拒绝（模型内存互斥），但**不给错误码** —— 界面说「AI 任务运行中」即可。 */
function testPeerBusyBlocksWithoutErrorCode() {
  const result = aiIndexCanRun({ exclusiveMaintenance: false, peerBusy: true });
  assert(result === false, '另一套 AI 索引在跑时必须拒绝（两套模型同时驻留会打满内存）');
  assert(
    result !== 'AI_MAINTENANCE',
    '对端索引忙碌不该报 AI_MAINTENANCE —— 那是「数据库维护」的码，界面会给出误导的文案',
  );
}

/** 两个条件同时成立时报独占维护：它比「另一套索引在跑」更值得用户等。 */
function testExclusiveWinsOverPeerBusy() {
  assert(
    aiIndexCanRun({ exclusiveMaintenance: true, peerBusy: true }) === 'AI_MAINTENANCE',
    '独占维护与对端索引同时成立时，要报更重的那个原因',
  );
}

/** 取不到状态时**放行**：宁可让后续的队列/超时去兜，也不能用缺失的参数误拦。 */
function testMissingStateAllows() {
  for (const state of [undefined, null, {}, { peerBusy: undefined }]) {
    assert(
      aiIndexCanRun(state) === true,
      '状态缺失时必须放行（' + JSON.stringify(state) + '）',
    );
  }
}

/**
 * 返回值形状只有三种，且**绝不能返回 `undefined`**：
 * `undefined` 在 `SemanticSearch.run()` 里是「没有闸门 = 放行」的意思
 * （见 `semantic-regression.js` 里 `allowed.canRun = () => undefined` 那一组断言），
 * 万一这里返回了 undefined，拒绝会被静默当成允许。
 */
function testReturnShapeIsClosed() {
  const samples = [
    { exclusiveMaintenance: true, peerBusy: true },
    { exclusiveMaintenance: true, peerBusy: false },
    { exclusiveMaintenance: false, peerBusy: true },
    { exclusiveMaintenance: false, peerBusy: false },
    {},
  ];
  for (const state of samples) {
    const result = aiIndexCanRun(state);
    assert(
      result === true || result === false || result === 'AI_MAINTENANCE',
      '判据只允许返回 true / false / "AI_MAINTENANCE"，实际是 ' + JSON.stringify(result),
    );
    assert(result !== undefined, '判据绝不能返回 undefined：在 run() 眼里它等于「没有闸门」');
  }
}

/**
 * 错误码要能被界面翻译：从**行为**里取真值，去比对四个界面文件里的映射，
 * 这样「改了码却忘了改文案」会当场红，而不是等用户看到裸错误码。
 */
function testErrorCodeIsLocalizedEverywhere() {
  const code = aiIndexCanRun({ exclusiveMaintenance: true, peerBusy: false });
  for (const file of [
    'src/web/js/semantic-search.js',
    'src/web/js/people.js',
    'src/web/js/ai-views.js',
    'src/renderer/ai-views.js',
  ]) {
    assert(
      readSource(file).includes(code),
      file + ' 必须把 ' + code + ' 翻成人话（判据返回什么码，就要求界面认什么码）',
    );
  }
}

// ---------------------------------------------------------------- 接线面

/** 两个 canRun 都必须走判据，且**都不得**再读 `optimizeTaskRunning`。 */
function testCanRunWiring() {
  const src = stripComments(readSource('src/main.js'));
  for (const [signature, peer] of [
    ['semanticSearch.canRun = function', 'faceService.status()'],
    ['faceService.canRun = function', 'semanticSearch.status()'],
  ]) {
    const body = windowAround(src, signature, 0, 400);
    assert(body !== null, '找不到 ' + signature + ' —— 接线方式变了，请同步本回归');
    assert(
      body.includes('aiIndexCanRun('),
      signature + ' 必须走 ai-index-gate 的判据（判据在模块里才能被行为断言覆盖）',
    );
    assert(
      body.includes('exclusiveMaintenance:'), 
      signature + ' 必须把「独占维护」状态传给判据，否则维护期的拦截会失效',
    );
    assert(
      body.includes(peer),
      signature + ' 必须把对端 AI 索引的忙碌状态算进去（模型内存互斥）',
    );
    // 🔴 这条是本次修复的核心：读 optimizeTaskRunning 就是那个误报。
    assert(
      !body.includes('optimizeTaskRunning'),
      signature + ' 不得再读 optimizeTaskRunning —— 它含启动期的 FTS，会把正常点击误报成 AI_MAINTENANCE',
    );
    assert(
      body.includes('exclusiveMaintenanceRunning'),
      signature + ' 要读的是 exclusiveMaintenanceRunning（只有它才是 AI 索引该让路的那种维护）',
    );
  }
}

/** 只有 VACUUM / 重建缩略图标记两处置位独占维护，一个不多一个不少。 */
function testExclusiveFlagOnlyAtExclusiveOps() {
  const src = stripComments(readSource('src/main.js'));
  const hits = src.match(/exclusiveMaintenanceRunning\s*=\s*true/g) || [];
  assert(
    hits.length === 2,
    '置位 exclusiveMaintenanceRunning 的调用点必须恰好 2 个（VACUUM + 重建缩略图标记），实际 ' +
      hits.length +
      ' 个 —— 漏了会让 AI 索引带着维护一起抢锁，多了会把正常点击拦掉',
  );
  for (const operation of ['rebuildThumbnailFlags', 'optimizeDatabase']) {
    const window = windowAround(src, "performMaintenance('" + operation + "')", 700, 200);
    assert(window !== null, '找不到 performMaintenance(\'' + operation + '\') 的调用点');
    assert(
      window.includes('exclusiveMaintenanceRunning = true'),
      '手动维护 ' + operation + ' 起跑前必须置位独占维护标志（否则排队期间用户还能点建索引）',
    );
    assert(
      window.includes('optimizeTaskRunning = true'),
      '手动维护 ' + operation + ' 仍要置位 optimizeTaskRunning（界面「优化中」与长任务避让靠它）',
    );
  }
}

/** 🔴 反向断言：FTS **绝不能**置位独占维护 —— 置了就等于把误报原样搬回来。 */
function testFtsIsNotExclusive() {
  const src = stripComments(readSource('src/main.js'));
  const window = windowAround(src, "performMaintenance('ensureFtsIndex')", 700, 200);
  assert(window !== null, "找不到 performMaintenance('ensureFtsIndex') 的调用点");
  assert(
    !window.includes('exclusiveMaintenanceRunning'),
    'FTS 索引期间不得置位独占维护：它写的是 photos.db、与 AI 索引不碰同一把锁，' +
      '置了就等于把「开机十几秒内点建索引报 AI_MAINTENANCE」的误报搬回来',
  );
  assert(
    window.includes('optimizeTaskRunning = true'),
    'FTS 仍要置位 optimizeTaskRunning（maintenanceBusy / 界面「优化中」/ 禁止退出都读它）',
  );
  // 三个置位点的总数锁死：多一处就是有人又在别处复用了这个语义。
  const hits = src.match(/optimizeTaskRunning\s*=\s*true/g) || [];
  assert(
    hits.length === 3,
    '置位 optimizeTaskRunning 的调用点必须是 3 个（FTS + VACUUM + 重建标记），实际 ' + hits.length + ' 个',
  );
}

/** 两个标志必须在同一个 finally 里收口：漏清一个 = AI 索引被永久拒之门外（且无任何报错）。 */
function testBothFlagsAreClearedTogether() {
  const src = stripComments(readSource('src/main.js'));
  const window = windowAround(src, 'optimizeTaskRunning = false', 200, 300);
  assert(window !== null, '找不到清 optimizeTaskRunning 的地方');
  assert(
    window.includes('exclusiveMaintenanceRunning = false'),
    '两个标志必须在同一处收口（performMaintenance 的 finally）—— 漏清独占标志会让 AI 索引再也起不来',
  );
  // 只该有这一处清零点，多出来的多半是"顺手"加漏的。
  // 正则锚行首是为了排掉变量声明 `var exclusiveMaintenanceRunning = false;`。
  const hits = src.match(/^[ \t]*exclusiveMaintenanceRunning = false;/gm) || [];
  assert(hits.length === 1, '清独占维护标志只能有一处（finally），实际 ' + hits.length + ' 处');
}

/** 判据只此一份：main.js 里不该再出现裸的错误码字面量（否则又有了第二个真相源）。 */
function testSingleSourceOfTruth() {
  const src = stripComments(readSource('src/main.js'));
  assert(
    (src.match(/'AI_MAINTENANCE'/g) || []).length === 0,
    "main.js 不得再出现裸的 'AI_MAINTENANCE' 字面量 —— 判据与错误码都在 ai-index-gate.js",
  );
  const gate = stripComments(readSource('src/main/ai-index-gate.js'));
  assert(
    (gate.match(/'AI_MAINTENANCE'/g) || []).length === 1,
    "ai-index-gate.js 里 'AI_MAINTENANCE' 应当只出现一次（唯一定义处）",
  );
}

function main() {
  testFtsDoesNotBlockAiIndex();
  testExclusiveMaintenanceBlocks();
  testPeerBusyBlocksWithoutErrorCode();
  testExclusiveWinsOverPeerBusy();
  testMissingStateAllows();
  testReturnShapeIsClosed();
  testErrorCodeIsLocalizedEverywhere();
  testCanRunWiring();
  testExclusiveFlagOnlyAtExclusiveOps();
  testFtsIsNotExclusive();
  testBothFlagsAreClearedTogether();
  testSingleSourceOfTruth();
  console.log('[ai-index-gate] PASS (' + checks + ' checks)');
}

main();
