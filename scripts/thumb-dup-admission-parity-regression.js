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
 * 1. **行为面（主力）**：把判据函数从源码里抽出来，用 `new Function` 注入四个状态变量**真跑**，
 *    逐个状态组合断言返回的文案。两条判据都是纯函数（只读模块级对象 + 返回字符串），
 *    所以可以脱离 Electron 直接执行。**删掉任何一条判据都会立刻变红。**
 * 2. **结构面**：两个 IPC handler 必须调用共用判据，且**不许再把判据内联回 handler 里**
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
 * 把判据函数包成可直接调用的探针：四个状态变量按参数注入，**返回判据的结果字符串**。
 *
 * ⚠️ 结尾必须写 `NAME()` 而不是 `NAME`（返回函数本身）：否则断言里
 * `/重复/.test(...)` 会去匹配**函数源码**，而源码里正好写着那句文案 ⇒ **假绿**。
 * 这一点是被「放行 ⇒ 空串」那两条断言抓出来的，别改回去。
 */
function makeProbe(fnSrc, name) {
  return new Function(
    'optimizeTaskRunning',
    'isFolderScanRunning',
    'duplicateHashTask',
    'thumbnailBackfill',
    fnSrc + '\nreturn ' + name + '();',
  );
}

const R = (running) => ({ running: !!running });
const IDLE_SCAN = () => false;
const BUSY_SCAN = () => true;

function main() {
  const raw = fs.readFileSync(MAIN, 'utf8');
  const code = stripComments(raw);

  console.log('[thumb-dup-admission-parity] 检查两个长任务的准入判据是否只有一份');

  // ---------- 1. 行为面：判据函数真跑 ----------
  const thumbFn = extractFunction(code, 'thumbnailBackfillBlockReason');
  const dupFn = extractFunction(code, 'duplicateHashBlockReason');

  check('两个判据函数都已定义（thumbnailBackfillBlockReason / duplicateHashBlockReason）', !!thumbFn && !!dupFn);

  if (thumbFn && dupFn) {
    const thumb = makeProbe(thumbFn, 'thumbnailBackfillBlockReason');
    const dup = makeProbe(dupFn, 'duplicateHashBlockReason');

    // --- 缩略图补全 ---
    check(
      '补全 · 全部空闲 ⇒ 放行（空串）',
      thumb(false, IDLE_SCAN, R(0), R(0)) === '',
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(0), R(0))),
    );
    check(
      '🔴 补全 · 重复比对在跑 ⇒ 必须挡住（用户那次「点了不开始」的真实原因）',
      /重复/.test(thumb(false, IDLE_SCAN, R(1), R(0)) || ''),
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(1), R(0))),
    );
    check(
      '补全 · 扫描在跑 ⇒ 挡住',
      /扫描/.test(thumb(false, BUSY_SCAN, R(0), R(0)) || ''),
      'got=' + JSON.stringify(thumb(false, BUSY_SCAN, R(0), R(0))),
    );
    check(
      '补全 · 数据库维护中 ⇒ 挡住',
      /维护/.test(thumb(true, IDLE_SCAN, R(0), R(0)) || ''),
      'got=' + JSON.stringify(thumb(true, IDLE_SCAN, R(0), R(0))),
    );
    check(
      '补全 · 补全自己已在跑 ⇒ 挡住',
      /补全/.test(thumb(false, IDLE_SCAN, R(0), R(1)) || ''),
      'got=' + JSON.stringify(thumb(false, IDLE_SCAN, R(0), R(1))),
    );

    // --- 重复比对（对称的那一半）---
    check(
      '查重 · 全部空闲 ⇒ 放行（空串）',
      dup(false, IDLE_SCAN, R(0), R(0)) === '',
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(0), R(0))),
    );
    check(
      '🔴 查重 · 缩略图补全在跑 ⇒ 必须挡住（与上面完全对称的漏判）',
      /补全/.test(dup(false, IDLE_SCAN, R(0), R(1)) || ''),
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(0), R(1))),
    );
    check(
      '查重 · 扫描在跑 ⇒ 挡住',
      /扫描/.test(dup(false, BUSY_SCAN, R(0), R(0)) || ''),
      'got=' + JSON.stringify(dup(false, BUSY_SCAN, R(0), R(0))),
    );
    check(
      '查重 · 数据库维护中 ⇒ 挡住',
      /维护/.test(dup(true, IDLE_SCAN, R(0), R(0)) || ''),
      'got=' + JSON.stringify(dup(true, IDLE_SCAN, R(0), R(0))),
    );
    check(
      '查重 · 查重自己已在跑 ⇒ 挡住',
      /重复|已在运行/.test(dup(false, IDLE_SCAN, R(1), R(0)) || ''),
      'got=' + JSON.stringify(dup(false, IDLE_SCAN, R(1), R(0))),
    );
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
    'runThumbnailBackfill() 内部走共用判据',
    /thumbnailBackfillBlockReason\(\)/.test(extractFunction(code, 'runThumbnailBackfill') || ''),
  );
  check(
    'runDuplicateHashDetection() 内部走共用判据',
    /duplicateHashBlockReason\(\)/.test(extractFunction(code, 'runDuplicateHashDetection') || ''),
  );

  // ---------- 3. 结构面：IPC handler 不许把判据内联回去 ----------
  /** handler 的 `if (...)` 条件里出现这些标识符 = 判据被内联（漂移重新开始的信号） */
  const INLINE_RE = /\bif\s*\(\s*(optimizeTaskRunning|isFolderScanRunning\(|duplicateHashTask\.running|thumbnailBackfill\.running)\b/;

  const thumbHandler = extractHandler(code, 'start-thumbnail-backfill');
  const dupHandler = extractHandler(code, 'maintenance-start-duplicate-hash-detection');

  check('两个 IPC handler 都能在源码中定位到', !!thumbHandler && !!dupHandler);

  if (thumbHandler && dupHandler) {
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
