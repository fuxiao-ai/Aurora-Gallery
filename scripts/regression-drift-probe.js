'use strict';

/**
 * 回归套件的「漂移归因」探针 —— **手工用，不进套件**（它自己就要跑套件，加进去就是自我递归）。
 *
 * ## 它解决什么
 *
 * 本仓的验收元规则是「判全绿前先核：**回归起跑 > 最后一次改码**」。一个人一个会话时，
 * 这条靠眼睛（`ls -l`）就行；但两三个会话 / worktree 并行改同一棵树时，会出现**第三种结果**：
 *
 *   · 套件**红**了，可红的那一项读到的文件正在被另一个会话写 —— **那不是回归，是读到中间态**；
 *   · 套件**绿**了，也可能是**假绿** —— 跑的时候源头正被改写，而那一项**恰好已经跑过了**。
 *
 * 光看套件日志**分不出来**（红绿都不带「谁在跑的时候被改了」这条信息）。于是一样「静态全绿、
 * 线上失效」的老毛病换了个位置：**归因错误会把真回归当成噪声忽略掉，也会把噪声当成真回归去修**。
 * 本探针把归因变成一次 diff：
 *
 *   ① 起跑前对 `src/` + `scripts/` 全部源码打 sha1 清单；
 *   ② 原样跑套件（不改它的行为、不改它的入口）；
 *   ③ 跑完再打一次，diff 出来的就是**运行期间被动过的文件**；
 *   ④ 按「有没有东西被动过」给这一跑的**有效性**定性，并以退出码表达。
 *
 * ## 怎么读结论
 *
 *   | 套件 | 漂移 | 结论 |
 *   |---|---|---|
 *   | 绿 | 无 | ✅ **有效全绿** —— 唯一可以宣布 PASS 的情形 |
 *   | 绿 | 有 | ⚠️ **作废**：被动过的文件可能在被测项跑完之后才变（假绿） |
 *   | 红 | 无 | ❌ **真回归** —— 去查那一项，别再怀疑并行会话 |
 *   | 红 | 有 | ❓ **先归因**：把漂移文件与红的那一项对照；大概率是并行会话，但必须逐项单跑复核 |
 *
 * ## 用法
 *
 *   ./node_modules/electron/dist/electron.exe scripts/regression-drift-probe.js
 *
 * 退出码：`0` = 有效全绿；`1` = 需人工判读（红，或有漂移）。完整套件日志写在 tmp 目录下，
 * 路径会打出来 —— 本探针只把 FAIL 行与统计摘要摆到眼前，不刷屏。
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'run-regressions.js');
/** 只看这两棵树的源码。⚠️ 刻意**不**看 `.workbuddy/`（记忆与台架天天在变，且它们不进版本库）。 */
const WATCH_DIRS = ['src', 'scripts'];
const EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.onnx', '.txt']);

function walk(dir, map) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, map);
      continue;
    }
    if (!EXTS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      map.set(
        path.relative(ROOT, full).replace(/\\/g, '/'),
        crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'),
      );
    } catch (_) {
      /* 单个文件读不到（权限 / 被占用）不该让归因失败，缺它就等于没变化 */
    }
  }
}

function snapshot() {
  const map = new Map();
  for (const dir of WATCH_DIRS) walk(path.join(ROOT, dir), map);
  return map;
}

function diff(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [file, hash] of after) {
    if (!before.has(file)) added.push(file);
    else if (before.get(file) !== hash) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) removed.push(file);
  return { changed, added, removed };
}

/**
 * 漂移文件分三档 —— 因为「谁被改了」决定这一跑还算不算数：
 * 源码改了最坏（被测行为变了）；套件成员改了会改变判定；纯工具改了基本无害（除非套件正在跑它）。
 */
function classify(file, suiteMembers) {
  if (file.startsWith('src/')) return '源码（影响被测行为）';
  if (suiteMembers.has(path.basename(file))) return '回归脚本（套件成员，可能改变判定）';
  return '工具脚本（一般不影响判定）';
}

/**
 * 套件成员名单从入口里读 —— 别在这里再抄一份清单，抄了必然漂。
 *
 * ⚠️ 抓的是**全部** `'xxx.js'` 字面量，不只 `*-regression.js`：入口清单里还有
 * `db-smoke.js` / `check-text-corruption.js` 这类不叫 regression 的成员。
 */
function suiteScripts() {
  const source = fs.readFileSync(ENTRY, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/['"]([\w.-]+\.js)['"]/g)) names.add(match[1]);
  return names;
}

/** 跑在 Electron 下就用 `process.execPath`（它就是 electron.exe）；否则向 electron 包问路径。 */
function electronBinary() {
  if (/^electron(\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string') return resolved;
  } catch (_) {
    /* 落到兜底 */
  }
  return process.execPath;
}

function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error('[drift] 找不到套件入口：' + ENTRY);
    process.exit(1);
  }
  const members = suiteScripts();
  const before = snapshot();
  const startedAt = new Date();

  /**
   * 🔴 必须以 **node 模式**跑套件（`ELECTRON_RUN_AS_NODE=1`），**不能**让它当真正的
   * Electron 主进程 —— 这一条是实测出来的，且失败得极其难查：
   *
   *   `run-regressions.js` 第 5 行是 `const electron = require('electron')`，然后拿它当
   *   `spawnSync` 的第一个参数。而 `require('electron')` 的返回值**随模式变**：
   *     · node 模式（`ELECTRON_RUN_AS_NODE=1`）⇒ **字符串**（electron 可执行文件路径）✓
   *     · 真 Electron 主进程          ⇒ **API 对象** ✗ ⇒ `spawnSync(<对象>)` 直接抛，
   *       而没有 console 的 GUI 进程把这条异常吞了：**零输出、退出码 `0x80000003`
   *       (STATUS_BREAKPOINT)、约 15 秒**——看起来像「套件跑起来又神秘死掉」。
   *
   * 所以我最初那版「为了躲开 bare node 的 ABI 问题而摘掉这个变量」是**反的**：
   * ABI 一致靠的是「用 electron.exe 这个可执行文件」（Electron ABI），而不是「当 GUI 进程」。
   *
   * ⚠️ 另有一条独立的坑：`stdio[0]` **不能是管道**。本机实测 `spawnSync` 只要 stdin 是管道
   * 就必 `EBUSY`（`status === null`，看着像「子进程起不来」）；`execSync` 同样中招。
   * 要捕获子进程输出只能 `stdio: ['ignore', 'pipe', 'pipe']`（或 `'inherit'` ——
   * `run-regressions.js` 用的就是它，所以它一直没踩到）。两条都已实测。
   */
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

  /**
   * ⚠️ 「起跑」这行必须在 `spawnSync` **之前**打。
   *
   * 探针的其余输出都排在 spawn 之后（要看子进程的退出码与日志），于是**只要进程死在
   * `spawnSync` 这一步，它就是零输出**——本机实测复现过：连跑两次都是「退出码 1、日志只剩
   * 一条 crashpad 噪声」，而因为没有任何提示，看起来像「探针不存在 / 命令没执行」，
   * 会一路怀疑到 shell、环境变量、文件权限上去。**一个在死亡点之前不留痕迹的工具，
   * 它的失败和「没运行」无法区分。**
   */
  console.log(
    '[drift] 起跑 ' + startedAt.toTimeString().slice(0, 8) + '，正在跑套件（' + members.size + ' 个脚本）…',
  );

  const result = spawnSync(electronBinary(), [ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const after = snapshot();
  const drifted = diff(before, after);

  const logFile = path.join(os.tmpdir(), 'aurora-regression-drift-' + startedAt.getTime() + '.log');
  try {
    fs.writeFileSync(logFile, output);
  } catch (_) {
    /* 日志写不出来不影响归因 */
  }

  /**
   * 🔴 套件**没跑起来**与套件**红了**是两件事，绝不能混：前者压根没有被测对象，
   * 判成「真回归」会把人送去查一个不存在的 bug（本探针第一版就犯过这个错，
   * 因为 `status === null` 与 `status === 1` 都被 `!== 0` 吃掉了）。
   */
  if (result.error) {
    console.log('[drift] ❌ **套件没跑起来**：' + result.error.message);
    console.log('[drift] 这不是回归结论，先修执行环境（见文件头那条 stdin 管道的坑）。');
    process.exit(2);
  }

  /**
   * ⚠️ 这里数的是**行**，不是「项」—— 套件日志里的 PASS 有四种写法
   * （`[名] PASS`、`名: PASS`、`[名] 子项 PASS`、`[名] PASS (N checks)`），
   * 任何「项数」正则都会悄悄少数（我第一版就把它印成「N 项」，
   * 明明漏了 `keyword-search-regression: PASS` 与全部子项行，却报得像个确切数字）。
   * **权威信号永远是 `exit` 与「零 FAIL 行」**，行数只是个近似体量。
   *
   * 🔴 判定失败不能只搜 `FAIL` 这个词：`QUERY_FAILED` / `TAG_INDEX_SCHEMA_MISSING` 这类
   *    **出错码会出现在断言的名称里**，而断言通过时那一行照样带着 `✓`。
   *    实测（M4 那一轮）三条 `✓ 查询抛异常 ⇒ QUERY_FAILED` 被算成了 3 条 FAIL 行，
   *    于是探针报「FAIL 行 4」而真实只有 1 —— 多出来的噪声正好是「把噪声当真回归」的原料。
   *    ⇒ 只认**行首的判定标记**（`✗` / `FAIL`）与套件自己的 `[名] FAIL` 头。
   */
  const lines = output.split(/\r?\n/);
  const isFail = (line) => /^\s*✗/.test(line) || /^\s*\[[\w-]+\]\s*FAIL/.test(line);
  const failLines = lines.filter(isFail);
  // PASS 侧四种写法都认（`✓` 少项行、`[名] PASS`、`名: PASS`、`[名] PASS (N checks)`），
  // FAIL 侧只认行首标记 —— **两侧刻意不对称**：漏数一条 PASS 只是体量不准，
  // 多数一条「FAIL」却会把人送去查一个不存在的 bug。
  const passLines = lines.filter(
    (line) =>
      /^\s*✓/.test(line) ||
      /^\s*\[[\w-]+\]\s*PASS/.test(line) ||
      /^\s*[\w-]+:\s*PASS/.test(line),
  );

  console.log(
    '[drift] 套件 exit=' +
      result.status +
      '（' +
      startedAt.toTimeString().slice(0, 8) +
      ' → ' +
      new Date().toTimeString().slice(0, 8) +
      '），PASS 行 ' +
      passLines.length +
      ' / FAIL 行 ' +
      failLines.length +
      '（清单 ' +
      members.size +
      ' 个脚本）',
  );
  console.log('[drift] 完整日志：' + logFile);
  for (const line of failLines.slice(0, 40)) console.log('    ' + line.trim());

  const driftList = [
    ...drifted.added.map((f) => ['新增', f]),
    ...drifted.changed.map((f) => ['修改', f]),
    ...drifted.removed.map((f) => ['删除', f]),
  ];
  if (!driftList.length) {
    console.log('[drift] 运行期间被动过的文件：**无**');
  } else {
    console.log('[drift] 运行期间被动过的文件（归因）：');
    for (const [kind, file] of driftList) {
      console.log('    ' + kind + ' ' + file + '   —— ' + classify(file, members));
    }
  }

  const green = result.status === 0 && failLines.length === 0;
  const sourceTouched = driftList.some(([, file]) => file.startsWith('src/'));
  if (green && !driftList.length) {
    console.log('[drift] ✅ **有效全绿**：起跑后没有任何源码/脚本发生变化。');
    process.exit(0);
  }
  if (green) {
    console.log(
      '[drift] ⚠️ **这一跑作废**（绿但源头动过）：' +
        (sourceTouched ? '有源码被改' : '有文件被改') +
        ' —— 被动过的文件可能在被测项跑完之后才变，属假绿。等对方停手后重跑。',
    );
    process.exit(1);
  }
  /**
   * 🔴 **「没跑起来」≠「真回归」**：套件非零退出却**一条 FAIL 行都没有**时，红不是断言给的，
   * 是某个脚本**根本没启动**或**在退出时崩了**。实测过一次：`face-regression.js` 三次里
   * 有一次**零输出**、退出码 1（Electron 在 node 模式下没能初始化就死了），
   * 另一次打印了 `[face-regression] PASS` 之后以 `0x80000003`(STATUS_BREAKPOINT) 退出。
   * 这两种都不是代码错，而按「exit≠0 ⇒ 真回归」报出去，**等于把人送去查一个不存在的 bug**。
   * ⇒ 单独成一支，并把「哪些脚本没产出结论」直接列出来。
   */
  const ranScripts = new Set();
  for (const line of lines) {
    const m = line.match(/^\s*\[([\w-]+)\]\s*(?:PASS|FAIL)/) || line.match(/^\s*([\w-]+):\s*(?:PASS|FAIL)/);
    if (m) ranScripts.add(m[1].replace(/-regression$/, ''));
  }
  const failedSpawns = lines.filter((line) => /^Regression failed:/.test(line.trim()));
  if (failLines.length === 0) {
    console.log('[drift] 🚫 **这一跑没有结论**：套件非零退出，但日志里**没有一条 FAIL 行** ⇒');
    console.log('[drift]    不是断言红，而是某个脚本没启动 / 在退出时崩了（Electron node 模式的已知偶发）。');
    if (failedSpawns.length) {
      for (const line of failedSpawns.slice(0, 10)) console.log('    ' + line.trim());
      console.log('[drift]    ⚠️ `2147483651`(0x80000003) / `null` 这类退出码要当作「没跑起来」处理；');
      console.log('[drift]       数字 `1` 且**零输出**同理。**逐项单跑**那个脚本复核，别直接改代码。');
    }
    console.log('[drift]    产出结论的脚本数：' + ranScripts.size + '（清单 ' + members.size + '）');
    process.exit(2);
  }
  if (!driftList.length) {
    console.log('[drift] ❌ **真回归**：源头没动过，红就是红 —— 去查上面那一项，别再怀疑并行会话。');
    process.exit(1);
  }
  console.log(
    '[drift] ❓ **先归因**：红了且源头动过。把漂移文件与上面红的项对照；' +
      '大概率是并行会话读到中间态，但**必须逐项单跑复核**才能下结论。',
  );
  process.exit(1);
}

main();
