'use strict';

/**
 * 「任务准入判据只允许有一份」回归 —— IPC 入口与任务内部必须共用同一个判据函数。
 *
 * ## 为什么需要它（2026-10-06 用户报「补齐缩略图点击之后不开始」）
 *
 * 两个长后台任务（缩略图补全 / 重复比对）各自有「IPC 入口」与「任务内部」两道准入检查。
 * 它们过去是**各写一份**，于是漂移了：
 *
 * - `start-thumbnail-backfill` 只查 `optimizeTaskRunning` / `isFolderScanRunning()` /
 *   `thumbnailBackfill.running`，而 `runThumbnailBackfill()` 内部**多一条**
 *   `duplicateHashTask.running`；
 * - `maintenance-start-duplicate-hash-detection` 只查 `duplicateHashTask.running`，
 *   而 `runDuplicateHashDetection()` 内部**多一条** `thumbnailBackfill.running`。
 *
 * 两个 handler 都是「立即返回、任务在后台异步跑」，返回值只挂了 `.catch` ——
 * 于是内部早退时**IPC 已返回 `{ success: true }`，任务却什么都没做**：
 * 前端不弹任何提示，`refreshXxxStatus()` 拿到 `running: false`，界面显示「未运行」。
 * 用户看到的就是「点下去什么都没发生」；而拒绝日志用的是 `logger.log`（info），
 * 生产档级别是 `warn` ⇒ 连一行现场都没有。**这是静默失效，不是性能问题。**
 *
 * ## 断言方式
 *
 * 1. **行为面（主力）**：把判据函数从源码里抽出来，用 `new Function` 注入五个状态变量**真跑**，
 *    逐个状态组合断言返回的文案。三条判据都是纯函数（只读模块级对象 + 返回字符串），
 *    所以可以脱离 Electron 直接执行。**删掉任何一条判据都会立刻变红。**
 *
 *    为什么是**三条**（2026-10-07 补）：第三个长任务「缩略图全量重跑」落地时，它只挡了
 *    补全与查重，而**查重那边没有对称地挡它** —— 正是本文件开头记的那类漂移，只是换了一对。
 *    三闸两两之间都要「互相看得见」，所以这里对三条判据各跑一遍同样的状态矩阵。
 *
 * 2. **结构面**：三个 IPC handler 必须调用共用判据，且**不许再把判据内联回 handler 里**
 *    （内联就是下一次漂移的起点）。内联检测只看 `if (...)` 条件，
 *    所以 handler 末尾那个 `thumbnailBackfill.running = false`（异常复位）不会误伤。
 *
 * ⚠️ 结构断言一律基于 acorn **剥注释后**的代码（本项目先例 `face-order-regression.js`）：
 * 两个判据函数上方的注释里**逐字写着**这些标识符，不剥注释的话把实现删光也照样「通过」。
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main.js');

const errors = [];
const notes = [];
let checks = 0;

function check(name, ok, detail) {
  checks++;
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}

/** 抽出 `function NAME(...) { ... }` 的完整文本（按大括号配平） */
function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const at = src.indexOf(sig);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

/** 抽出 `ipcMain.handle('NAME', ...)` 整个调用（按大括号配平，从签名处开始） */
function extractHandler(src, channel) {
  const at = src.indexOf("ipcMain.handle('" + channel + "'");
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

/**
 * 把判据函数包成可直接调用的探针：五个状态变量按参数注入，**返回判据的结果字符串**。
 *
 * ⚠️ 结尾必须写 `NAME()` 而不是 `NAME`（返回函数本身）：否则断言里
 * `/重复/.test(...)` 会去匹配**函数源码**，而源码里正好写着那句文案 ⇒ **假绿**。
 * 这一点是被「放行 ⇒ 空串」那两条断言抓出来的，别改回去。
 *
 * 🔴 `thumbnailRebuild` 是 2026-10-07 加的第五个：判据函数里引用了一个没注入的标识符时，
 *    这里抛的是 `ReferenceError`（**整条守护崩掉**，不是「有一条断言红」）——
 *    所以每新增一个被判据读取的模块级状态，必须同步加进这个参数表。
 */
function makeProbe(fnSrc, name) {
  return new Function(
    'optimizeTaskRunning',
    'isFolderScanRunning',
    'duplicateHashTask',
    'thumbnailBackfill',
    'thumbnailRebuild',
    fnSrc + '\nreturn ' + name + '();',
  );
}

const R = (running) => ({ running: !!running });
const IDLE_SCAN = () => false;
const BUSY_SCAN = () => true;

function main() {
  const raw = fs.readFileSync(MAIN, 'utf8');
  const code = stripComments(raw);

  console.log('[thumb-dup-admission-parity] 检查长任务的准入判据是否只有一份、且互相看得见');

  // ---------- 1. 行为面：判据函数真跑 ----------
  const thumbFn = extractFunction(code, 'thumbnailBackfillBlockReason');
  const dupFn = extractFunction(code, 'duplicateHashBlockReason');
  const rebuildFn = extractFunction(code, 'thumbnailRebuildBlockReason');

  check(
    '三个判据函数都已定义（thumbnailBackfillBlockReason / duplicateHashBlockReason / thumbnailRebuildBlockReason）',
    !!thumbFn && !!dupFn && !!rebuildFn,
  );

  if (thumbFn && dupFn && rebuildFn) {
    const thumb = makeProbe(thumbFn, 'thumbnailBackfillBlockReason');
    const dup = makeProbe(dupFn, 'duplicateHashBlockReason');
    const rebuild = makeProbe(rebuildFn, 'thumbnailRebuildBlockReason');

    // --- 缩略图补全 ---
    check(
      '补全 · 全部空闲 ⇒ 放行（空串）',
      thumb(false, IDLE_SCAN, R(0), R(0), R(0)) === '',
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(0), R(0), R(0))),
    );
    check(
      '🔴 补全 · 重复比对在跑 ⇒ 必须挡住（用户那次「点了不开始」的真实原因）',
      /重复/.test(thumb(false, IDLE_SCAN, R(1), R(0), R(0)) || ''),
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(1), R(0), R(0))),
    );
    check(
      '补全 · 扫描在跑 ⇒ 挡住',
      /扫描/.test(thumb(false, BUSY_SCAN, R(0), R(0), R(0)) || ''),
      'got=' + JSON.stringify(thumb(false, BUSY_SCAN, R(0), R(0), R(0))),
    );
    check(
      '补全 · 数据库维护中 ⇒ 挡住',
      /维护/.test(thumb(true, IDLE_SCAN, R(0), R(0), R(0)) || ''),
      'got=' + JSON.stringify(thumb(true, IDLE_SCAN, R(0), R(0), R(0))),
    );
    check(
      '补全 · 补全自己已在跑 ⇒ 挡住',
      /补全/.test(thumb(false, IDLE_SCAN, R(0), R(1), R(0)) || ''),
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(0), R(1), R(0))),
    );
    check(
      '🔴 补全 · 全量重建在跑 ⇒ 必须挡住（重跑要逐文件整读，与补全抢同一块盘）',
      /重建/.test(thumb(false, IDLE_SCAN, R(0), R(0), R(1)) || ''),
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(0), R(0), R(1))),
    );

    // --- 重复比对（对称的那一半）---
    check(
      '查重 · 全部空闲 ⇒ 放行（空串）',
      dup(false, IDLE_SCAN, R(0), R(0), R(0)) === '',
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(0), R(0), R(0))),
    );
    check(
      '🔴 查重 · 缩略图补全在跑 ⇒ 必须挡住（与上面完全对称的漏判）',
      /补全/.test(dup(false, IDLE_SCAN, R(0), R(1), R(0)) || ''),
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(0), R(1), R(0))),
    );
    check(
      '查重 · 扫描在跑 ⇒ 挡住',
      /扫描/.test(dup(false, BUSY_SCAN, R(0), R(0), R(0)) || ''),
      'got=' + JSON.stringify(dup(false, BUSY_SCAN, R(0), R(0), R(0))),
    );
    check(
      '查重 · 数据库维护中 ⇒ 挡住',
      /维护/.test(dup(true, IDLE_SCAN, R(0), R(0), R(0)) || ''),
      'got=' + JSON.stringify(dup(true, IDLE_SCAN, R(0), R(0), R(0))),
    );
    check(
      '查重 · 查重自己已在跑 ⇒ 挡住',
      /重复|已在运行/.test(dup(false, IDLE_SCAN, R(1), R(0), R(0)) || ''),
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(1), R(0), R(0))),
    );
    check(
      '🔴 查重 · 全量重建在跑 ⇒ 必须挡住（2026-10-07 真的漏过这一条：只挡了补全没挡重建）',
      /重建/.test(dup(false, IDLE_SCAN, R(0), R(0), R(1)) || ''),
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(0), R(0), R(1))),
    );

    // --- 全量重建（第三个长任务，与上面两个都互斥）---
    check(
      '重建 · 全部空闲 ⇒ 放行（空串）',
      rebuild(false, IDLE_SCAN, R(0), R(0), R(0)) === '',
      'got=' + JSON.stringify(rebuild(false, IDLE_SCAN, R(0), R(0), R(0))),
    );
    check(
      '🔴 重建 · 缩略图补全在跑 ⇒ 必须挡住（与「补全挡重建」是一对，单向挡会留下窗口）',
      /补全/.test(rebuild(false, IDLE_SCAN, R(0), R(1), R(0)) || ''),
      'got=' + JSON.stringify(rebuild(false, IDLE_SCAN, R(0), R(1), R(0))),
    );
    check(
      '🔴 重建 · 重复比对在跑 ⇒ 必须挡住（同上，对称）',
      /重复/.test(rebuild(false, IDLE_SCAN, R(1), R(0), R(0)) || ''),
      'got=' + JSON.stringify(rebuild(false, IDLE_SCAN, R(1), R(0), R(0))),
    );
    check(
      '重建 · 扫描在跑 ⇒ 挡住',
      /扫描/.test(rebuild(false, BUSY_SCAN, R(0), R(0), R(0)) || ''),
      'got=' + JSON.stringify(rebuild(false, BUSY_SCAN, R(0), R(0), R(0))),
    );
    check(
      '重建 · 数据库维护中 ⇒ 挡住',
      /维护/.test(rebuild(true, IDLE_SCAN, R(0), R(0), R(0)) || ''),
      'got=' + JSON.stringify(rebuild(true, IDLE_SCAN, R(0), R(0), R(0))),
    );
    check(
      '重建 · 重建自己已在跑 ⇒ 挡住',
      /重建/.test(rebuild(false, IDLE_SCAN, R(0), R(0), R(1)) || ''),
      'got=' + JSON.stringify(rebuild(false, IDLE_SCAN, R(0), R(0), R(1))),
    );

    // 三闸两两互斥的**矩阵式**自证：任何「只有单向挡」的组合都会在这里露出来。
    // 用状态向量遍历而不是逐条写死，是为了让「将来再加一个长任务」时漏掉的对称边
    // 自己浮出来（第 4 个闸只需要进这个矩阵，不用再抄一遍断言）。
    // ⚠️ 断言用**文案正则**而不是任务名：库里管它叫「重复文件比对」（不认识「查重」这个词），
    //    按名字匹配会在一半的格子上假红 —— 而下面这组断言正是用来抓假绿的，它自己不能再假红。
    // 探针入参顺序 = (optimizeTaskRunning, isFolderScanRunning, duplicateHashTask,
    //                thumbnailBackfill, thumbnailRebuild)
    // ⇒ 下标必须与上面 `makeProbe` 的参数表逐位对齐。写反了会「断言照过但测的是别的闸」，
    //    所以下面每一格都验了返回文案里点名的是**对方**（`b.why`）。
    const GATES = [
      { name: '补全', probe: thumb, idx: 3, why: /补全/ },
      { name: '查重', probe: dup, idx: 2, why: /重复|查重/ },
      { name: '重建', probe: rebuild, idx: 4, why: /重建/ },
    ];
    for (const a of GATES) {
      for (const b of GATES) {
        if (a === b) continue;
        const args = [false, IDLE_SCAN, R(0), R(0), R(0)];
        args[b.idx] = R(1);
        const got = a.probe(...args) || '';
        check(
          '矩阵 · ' + a.name + ' 必须挡 ' + b.name + '（' + b.name + '在跑时不许放行）',
          b.why.test(got),
          'got=' + JSON.stringify(got),
        );
      }
    }
  }

  // ---------- 2. 结构面：判据必须被真实调用（防「钉住死代码」）----------
  const callCount = (name) => (code.match(new RegExp(name + '\\(\\)', 'g')) || []).length;
  check(
    'thumbnailBackfillBlockReason() 至少被调用 2 处（IPC + 任务内部）—— 不是死代码',
    callCount('thumbnailBackfillBlockReason') >= 2,
    'calls=' + callCount('thumbnailBackfillBlockReason'),
  );
  check(
    'duplicateHashBlockReason() 至少被调用 2 处（IPC + 任务内部）—— 不是死代码',
    callCount('duplicateHashBlockReason') >= 2,
    'calls=' + callCount('duplicateHashBlockReason'),
  );
  check(
    'thumbnailRebuildBlockReason() 至少被调用 2 处（IPC + 任务内部）—— 不是死代码',
    callCount('thumbnailRebuildBlockReason') >= 2,
    'calls=' + callCount('thumbnailRebuildBlockReason'),
  );

  check(
    'runThumbnailBackfill() 内部走共用判据',
    /thumbnailBackfillBlockReason\(\)/.test(extractFunction(code, 'runThumbnailBackfill') || ''),
  );
  check(
    'runDuplicateHashDetection() 内部走共用判据',
    /duplicateHashBlockReason\(\)/.test(extractFunction(code, 'runDuplicateHashDetection') || ''),
  );
  check(
    'runThumbnailRebuild() 内部走共用判据（IPC 过了闸不等于任务会跑）',
    /thumbnailRebuildBlockReason\(\)/.test(extractFunction(code, 'runThumbnailRebuild') || ''),
  );

  // ---------- 3. 结构面：IPC handler 不许把判据内联回去 ----------
  /** handler 的 `if (...)` 条件里出现这些标识符 = 判据被内联（漂移重新开始的信号） */
  const INLINE_RE =
    /\bif\s*\(\s*(optimizeTaskRunning|isFolderScanRunning\(|duplicateHashTask\.running|thumbnailBackfill\.running|thumbnailRebuild\.running)\b/;

  const thumbHandler = extractHandler(code, 'start-thumbnail-backfill');
  const dupHandler = extractHandler(code, 'maintenance-start-duplicate-hash-detection');
  const rebuildHandler = extractHandler(code, 'start-thumbnail-rebuild');

  check(
    '三个 IPC handler 都能在源码中定位到',
    !!thumbHandler && !!dupHandler && !!rebuildHandler,
  );

  if (thumbHandler && dupHandler && rebuildHandler) {
    check(
      'start-thumbnail-backfill 调用共用判据 thumbnailBackfillBlockReason()',
      /thumbnailBackfillBlockReason\(\)/.test(thumbHandler),
    );
    check(
      '🔴 start-thumbnail-backfill 不再内联准入判据（内联 = 下一次漂移的起点）',
      !INLINE_RE.test(thumbHandler),
      (thumbHandler.match(INLINE_RE) || [''])[0],
    );
    check(
      'maintenance-start-duplicate-hash-detection 调用共用判据 duplicateHashBlockReason()',
      /duplicateHashBlockReason\(\)/.test(dupHandler),
    );
    check(
      '🔴 maintenance-start-duplicate-hash-detection 不再内联准入判据',
      !INLINE_RE.test(dupHandler),
      (dupHandler.match(INLINE_RE) || [''])[0],
    );
    check(
      'start-thumbnail-rebuild 调用共用判据 thumbnailRebuildBlockReason()',
      /thumbnailRebuildBlockReason\(\)/.test(rebuildHandler),
    );
    check(
      '🔴 start-thumbnail-rebuild 不再内联准入判据',
      !INLINE_RE.test(rebuildHandler),
      (rebuildHandler.match(INLINE_RE) || [''])[0],
    );
  }

  // ---------- 输出 ----------
  if (errors.length) {
    console.error('\n' + errors.join('\n'));
    console.error('\n[thumb-dup-admission-parity] FAILED (' + errors.length + ' / ' + checks + ')');
    process.exitCode = 1;
    return;
  }
  if (process.env.VERBOSE) console.log(notes.join('\n'));
  console.log('[thumb-dup-admission-parity] PASS (' + checks + ' checks)');
}

main();
