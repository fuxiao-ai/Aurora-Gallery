'use strict';
/**
 * 模块可达性守护（T6，2026-10-05）。
 *
 * 背景：`src/main/` 下曾经并存 9 个「只被彼此 require、永远到不了运行时」的孤儿模块
 * （`task-scheduler` / `ipc-handlers` / `thumbnail-backfill` / `settings` / `window-tray` /
 * `duplicate-detection` / `dhash-backfill` / `cloudflare-tunnel` / `utils`，约 3100 行）。
 * 危害不止是冗余：
 *   1. 🔴 **影子副本会漂移，而且漂移的方向可能是「死代码里已修、活代码没修」。**
 *      尺寸回填契约（`photos.width/height`）当初只实现在孤儿 `thumbnail-backfill.js` 里，
 *      而 `database.js#_sqlBackfillPendingExpr()` 把「缺尺寸」算作待补条件 ——
 *      于是线上候选集永不收敛、每轮补全重走全库。请见 `photo-metadata-backfill-regression.js`。
 *   2. 🔴 **钉住死代码的回归是假绿**：断言全过，行为全错。
 *   3. 🔴 **悬空引用**：`main.js` 里删掉的函数，孤儿副本里还留着注入点，谁把它接上线
 *      就是一个 `undefined` 守卫静默跳过（`if (ref) ref()`），**不报任何错**。
 *   4. 🔴 **悬空 IPC 通道**（§5）：`preload` 是渲染进程唯一的桥，它发起的通道若主进程没人
 *      `ipcMain` 注册，调用会 reject；而消费端常带 `.catch(() => {})` —— 于是「功能静默失效」
 *      而不是报错。`get-app-version` 就真踩过：生产端原先在已删除的 `src/main/ipc-handlers.js`
 *      里，关于对话框一直显示字面 `%VERSION%`，静态检查全绿。
 *      这层是**双向**的，两个方向的失效形态不同：
 *        · `preload → 主进程`（注册缺失）：调用 reject → 被 `.catch` 吞 → 功能静默失效；
 *        · `主进程 → preload`（监听缺失）：`webContents.send` **连 reject 都没有**，
 *          对不存在的监听者就是直接丢弃，不警告不报错，控制台干净。`ai-tags-updated`
 *          就真踩过：注释写着「真的补到了才通知」，实际零消费端 → 标签回填成功后界面不重画。
 *      再往下还有一层**接线级**（§5c）：通道两端都通，但 preload 的 `onXxx` 导出在渲染端
 *      无人引用（`onWebServerUrl` 就是），事件到了 preload 里就断掉了。
 *
 * 所以本脚本把「不许再有不可达模块」变成可执行的判据，并顺带钉住 T5/T6 删掉的符号不再回头。
 *
 * 分析口径：只认 `require('<字面量>')`。动态拼接的模块名（`require(someVar)`）**不算可达** ——
 * 宁可漏报也不误报：一旦把动态拼接当可达，任何孤儿都能靠一行 `require(x)` 混过去。
 * worker 例外：`new Worker(path.join(__dirname, ...))` 是合法的运行时加载方式，单独收作种子。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUN_REGRESSIONS = 'scripts/run-regressions.js';

/** 运行时入口。`src/main.js` 是 Electron 主进程，`src/preload.js` 是唯一的桥。 */
const ENTRIES = ['src/main.js', 'src/preload.js'];

/** 断言范围：`src/main/` 的契约就是「主进程模块，靠 require 接进来」 */
const SCOPED_DIR = 'src/main';

/**
 * T6 删除的孤儿链。必须**保持不存在** —— 这些文件的历史价值只有「别再长回来」：
 * 一旦有人按记忆中的路径重建一份，就会立刻重新变成影子副本。
 */
const DELETED_ORPHANS = [
  'src/main/ipc-handlers.js',
  'src/main/task-scheduler.js',
  'src/main/thumbnail-backfill.js',
  'src/main/settings.js',
  'src/main/window-tray.js',
  'src/main/duplicate-detection.js',
  'src/main/dhash-backfill.js',
  'src/main/cloudflare-tunnel.js',
  'src/main/utils.js',
];

/**
 * T5 从 `main.js` 删除的符号（启动期统一提交点替代了它们）。
 * 只列**真正消失**的：`applyDeferredCachePragma` / `applyDeferredMmapPragma` 仍在
 * `database.js` 里，是合并入口 `applyDeferredIoPragmas` 的被调方，属正常保留。
 *
 * 中间五条是 2026-10-05 审计清掉的「悬空链路」符号，同样不许回头：
 * `onTriggerScan` 是被删的渲染端桥（含 `api.js` 映射），它背后是原生菜单添加文件夹这条
 * 死链路 —— 真正在用的添加文件夹走 `app.js#handleAddFolder`（HTML 标题栏菜单 / 设置页按钮），
 * 与它调的是同一个 `scanFlow.doScanFolder`，只差一个 folderPath 来源。
 *
 * 末尾两条是同一轮清掉的「主进程 → 渲染端」死链：`web-server-url` 通道 + `onWebServerUrl`
 * 导出。网页服务本身还活着（`src/web-server.js`），但地址早改成**拉取式**
 * （`invoke('get-web-url')` → `ui-shell.js`），这条推送通道两头都没人了。
 */
const REMOVED_SYMBOLS = [
  'scheduleDeferredPhotoIndexesOnce',
  'deferredPhotoIndexesScheduled',
  'prepareSearchIndex',
  'menu-add-folder',
  'trigger-scan',
  'onTriggerScan',
  'cancelFaceScan',
  'faceCancelScan',
  'web-server-url',
  'onWebServerUrl',
];

/** 分析不空转的自证锚点：这几个无论如何都该在可达集里 */
const ANCHORS = [
  'src/main.js',
  'src/preload.js',
  'src/database.js',
  'src/main/db-write-queue.js',
  'src/main/maintenance-guard.js',
  'src/main/ai-index-gate.js',
  'src/main/interaction-preempt.js',
];

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const abs = (r) => path.join(ROOT, r);
const exists = (r) => fs.existsSync(abs(r));

/** HTML 注释也要剥：本项目的静态守护踩过「注释里的字样被当成代码」的坑 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function readSource(file) {
  return fs.readFileSync(file, 'utf8');
}

/** 把 `require('./x')` 这样的相对说明符解析成真实文件；裸模块（electron / sharp）返回 null */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 静态 require 出边 */
function requiresOf(file) {
  const src = stripComments(readSource(file));
  const out = [];
  const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[2]);
  return out;
}

/**
 * 动态加载种子：`new Worker(path.join(__dirname, 'workers', 'x.js'))`
 * 只取 `path.join` 参数里的字符串字面量；含表达式的部分跳过（宁漏不误）。
 */
function workerSeedsOf(file) {
  const src = stripComments(readSource(file));
  const seeds = [];
  const re = /path\.join\(\s*__dirname\s*,([\s\S]{0,200}?)\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const literals = [];
    const litRe = /(['"])([^'"]+)\1/g;
    let lm;
    while ((lm = litRe.exec(m[1])) !== null) literals.push(lm[2]);
    if (!literals.length) continue;
    if (!literals.some((s) => s.endsWith('.js'))) continue;
    const resolved = path.resolve(path.dirname(file), ...literals);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) seeds.push(resolved);
  }
  return seeds;
}

// ------------------------------------------------------------------ 可达性闭包

const seen = new Set();
const queue = [];
for (const entry of ENTRIES) {
  if (exists(entry)) {
    seen.add(path.resolve(abs(entry)));
    queue.push(path.resolve(abs(entry)));
  }
}
const seeds = new Set();
while (queue.length) {
  const file = queue.shift();
  for (const spec of requiresOf(file)) {
    const target = resolveSpec(file, spec);
    if (target && !seen.has(target)) {
      seen.add(target);
      queue.push(target);
    }
  }
  for (const seed of workerSeedsOf(file)) {
    seeds.add(rel(seed));
    if (!seen.has(seed)) {
      seen.add(seed);
      queue.push(seed);
    }
  }
}

// ------------------------------------------------------------------ 1. 分析不空转

for (const anchor of ANCHORS) {
  check('夹具自证：可达集含 ' + anchor, seen.has(path.resolve(abs(anchor))));
}
check(
  '夹具自证：运行时入口都在可达集里',
  ENTRIES.every((e) => seen.has(path.resolve(abs(e)))),
);
check('夹具自证：worker 动态种子抽取有效', seeds.size > 0, [...seeds].join(', '));

// ------------------------------------------------------------------ 2. src/main 不得再有不可达模块

const scopedFiles = fs
  .readdirSync(abs(SCOPED_DIR))
  .filter((f) => f.endsWith('.js'))
  .map((f) => SCOPED_DIR + '/' + f);
const unreachable = scopedFiles.filter((f) => !seen.has(path.resolve(abs(f))));
check(
  '🔴 ' + SCOPED_DIR + '/ 下没有入口不可达的模块（新增模块必须在同一次改动里接上线）',
  unreachable.length === 0,
  unreachable.join(', '),
);
check('夹具自证：扫描到了 ' + SCOPED_DIR + ' 下的模块', scopedFiles.length >= 5, String(scopedFiles.length));

// ------------------------------------------------------------------ 3. 孤儿链不得长回来

for (const orphan of DELETED_ORPHANS) {
  check('🔴 已删除的孤儿副本不再存在：' + orphan, !exists(orphan));
}

// ------------------------------------------------------------------ 4. T5 删除的符号不得回头

/** 只看代码，不看注释：注释里提到「过去这里有 prepareSearchIndex」是合法的 */
function codeOf(relPath) {
  return stripComments(readSource(abs(relPath)));
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const allSrcJs = walkJs(abs('src'));
for (const symbol of REMOVED_SYMBOLS) {
  const hit = allSrcJs.filter((f) => codeOf(rel(f)).includes(symbol));
  check(
    '🔴 已删除符号无残留引用：' + symbol,
    hit.length === 0,
    hit.map(rel).join(', '),
  );
}

// --------------------------- 5. IPC 通道双向闭合（preload ↔ 主进程，含接线级）

/**
 * 抽取 `obj.kind('chan' …)` 里的字面量通道名。
 * `once` 必须排在 `on` 前面：`ipcMain.once(` 的前缀也是 `ipcMain.on`，
 * 靠回溯虽然也能补上，但显式排序可读性更好、也不依赖回溯细节。
 */
function channelsOf(src, obj, kinds) {
  const out = new Set();
  const re = new RegExp(obj + '\\.(?:' + kinds.join('|') + ')\\(\\s*([\'"])([^\'"]+)\\1', 'g');
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[2]);
  return out;
}

const preloadOutbound = new Set([
  ...channelsOf(stripComments(readSource(abs(ENTRIES[1]))), 'ipcRenderer', ['invoke']),
  ...channelsOf(stripComments(readSource(abs(ENTRIES[1]))), 'ipcRenderer', ['send']),
]);

/** 注册侧扫全 `src/`：主进程内可能不止 `main.js` 一处注册（web 服务、worker 都在同进程） */
const registeredChannels = new Set();
for (const f of walkJs(abs('src'))) {
  for (const ch of channelsOf(codeOf(rel(f)), 'ipcMain', ['handle', 'once', 'on'])) {
    registeredChannels.add(ch);
  }
}

const unregistered = [...preloadOutbound].filter((c) => !registeredChannels.has(c)).sort();
check(
  '🔴 preload 发起的每个通道都有主进程注册（漏了 = 调用 reject，被 .catch 吞掉 → 功能静默失效）',
  unregistered.length === 0,
  unregistered.join(', '),
);

const neverSent = [...registeredChannels].filter((c) => !preloadOutbound.has(c)).sort();
check(
  '🔴 主进程注册的每个通道都真有人发（空注册 = 死代码；或 preload 侧漏了发起）',
  neverSent.length === 0,
  neverSent.join(', '),
);

check(
  '夹具自证：preload 出站通道抽取有效',
  preloadOutbound.size >= 60,
  String(preloadOutbound.size),
);
check(
  '夹具自证：主进程注册通道抽取有效',
  registeredChannels.size >= 60,
  String(registeredChannels.size),
);

// ------------------------------------------------- 5b. 主进程 → preload 方向

/**
 * 主进程侧发送：**任意接收者** `.send('<字面量>')`，只排除 `ipcRenderer`（那是上文的出站方向）。
 *
 * 🔴 **绝不能只匹配 `webContents.send(`**：`show-close-chooser`（关窗口询问）走的是局部变量
 * `wc.send(`（`main.js` 的 `close` 处理器），只认 `webContents.send(` 就会把它误判成
 * 「preload 在听、主进程没发」—— 接下来最顺手的动作就是把它加进例外名单，而
 * **白名单正是真悬空最好的藏身处**。同 §5 里「`once` 必须排在 `on` 前面」是一类坑：
 * 匹配式少覆盖一种形态，结论就是反的。
 */
function sendsOf(src) {
  const out = new Set();
  const re = /([A-Za-z_$][\w$.]*)\.send\(\s*(['"])([^'"]+)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (/(^|\.)ipcRenderer$/.test(m[1])) continue;
    out.add(m[3]);
  }
  return out;
}

/**
 * 发送侧只扫「主进程侧」：`src/renderer/**` 与 `src/web/**` 里的 `.send` 是 HTTP 响应 /
 * WebSocket / 浏览器侧产物（`src/web/vendor/hls.min.js` 里就有一堆 `i.send(`），不是 IPC。
 * 实测排除这两个目录后，剩余 `.send(` 的接收者只有 `mainWindow.webContents` 与 `wc`。
 */
const mainSideFiles = allSrcJs.filter((f) => {
  const r = rel(f);
  return !r.startsWith('src/renderer/') && !r.startsWith('src/web/');
});
const mainSideSends = new Set();
for (const f of mainSideFiles) {
  for (const ch of sendsOf(codeOf(rel(f)))) mainSideSends.add(ch);
}

/** 监听侧：`preload.js` 里的 `ipcRenderer.on|once('<字面量>')`（`once` 仍须排 `on` 前） */
const preloadListens = channelsOf(
  stripComments(readSource(abs(ENTRIES[1]))),
  'ipcRenderer',
  ['once', 'on'],
);

const listenedButNeverSent = [...preloadListens].filter((c) => !mainSideSends.has(c)).sort();
check(
  '🔴 渲染端监听的每个通道主进程都真发（悬空监听 = 死代码，或发送端漏了发）',
  listenedButNeverSent.length === 0,
  listenedButNeverSent.join(', '),
);

const sentButNeverListened = [...mainSideSends].filter((c) => !preloadListens.has(c)).sort();
check(
  '🔴 主进程发出的每个通道渲染端都真听（悬空发送 = 静默丢弃，不报错、不警告、控制台干净）',
  sentButNeverListened.length === 0,
  sentButNeverListened.join(', '),
);

check('夹具自证：主进程发送通道抽取有效', mainSideSends.size >= 5, String(mainSideSends.size));
check('夹具自证：preload 监听通道抽取有效', preloadListens.size >= 5, String(preloadListens.size));

// ------------------------------------------------- 5c. preload 的 onXxx 导出必须真接线

/**
 * 通道闭合只保到「preload 这一层」。再往下一层是：preload 有监听、有 `onXxx` 导出，
 * 但**渲染端从来没人引用它** —— 事件到了 preload 里就停住了。
 * `onWebServerUrl` 就是这样：`api.js` 没包装、`app.js` 没人调（主进程也早就不发了，两头都断）。
 * 判据取「导出名在 `src/renderer/**` 里至少出现一次」：`api.js` 的
 * `on('onShowCloseChooser', handler)` 这种字符串映射即算接线。
 */
const preloadOnExports = (() => {
  const out = new Set();
  const re = /^\s*(on[A-Z]\w*):\s*function/gm;
  let m;
  while ((m = re.exec(stripComments(readSource(abs(ENTRIES[1]))))) !== null) out.add(m[1]);
  return out;
})();

const rendererCode = walkJs(abs('src/renderer'))
  .map((f) => codeOf(rel(f)))
  .join('\n');

const unwiredExports = [...preloadOnExports]
  .filter((n) => !rendererCode.includes(n))
  .sort();
check(
  '🔴 preload 的每个 onXxx 导出都被渲染端真引用（只导出不接线 = 事件永远没人处理）',
  unwiredExports.length === 0,
  unwiredExports.join(', '),
);

check(
  '夹具自证：preload onXxx 导出抽取有效',
  preloadOnExports.size >= 5,
  String(preloadOnExports.size),
);

/**
 * 同层的另一半：`api.js` 里的 `on('X') / call('X') / invoke('X')`，`X` 必须是 `preload` 的真导出名。
 *
 * 拼错的方法名**不会报错**：`api.js` 里 `on()` / `call()` / `invoke()` 的开头都是
 * `if (!has(name)) return;`（`has` = `typeof backend()[name] === 'function'`）——
 * 名字对不上就静默不接线。`cancelFaceScan` 是同一形态的另一半：那次是 `preload` 里
 * **根本没有** `faceCancelScan` 这个方法，`api.has('faceCancelScan')` 恒 false。
 */
const preloadExports = (() => {
  const out = new Set();
  const re = /^\s*([a-zA-Z_$]\w*):\s*(?:function|\(|async)/gm;
  let m;
  while ((m = re.exec(stripComments(readSource(abs(ENTRIES[1]))))) !== null) out.add(m[1]);
  return out;
})();

const apiJsCode = codeOf('src/renderer/api.js');
const apiMethodRefs = new Set();
for (const kind of ['on', 'call', 'invoke']) {
  const re = new RegExp('(?<![\\w$.])' + kind + '\\(\\s*([\'"])([^\'"]+)\\1', 'g');
  let m;
  while ((m = re.exec(apiJsCode)) !== null) apiMethodRefs.add(m[2]);
}

const danglingApiRefs = [...apiMethodRefs].filter((n) => !preloadExports.has(n)).sort();
check(
  "🔴 api.js 的 on/call/invoke('X') 里 X 都是 preload 真导出（拼错 = has() 恒 false → 映射静默失效）",
  danglingApiRefs.length === 0,
  danglingApiRefs.join(', '),
);

check('夹具自证：api.js 方法名引用抽取有效', apiMethodRefs.size >= 40, String(apiMethodRefs.size));
check('夹具自证：preload 导出方法抽取有效', preloadExports.size >= 40, String(preloadExports.size));

// ------------------------------------------------------------------ 6. 登记进全量回归

check(
  '本守护已登记进 scripts/run-regressions.js',
  readSource(abs(RUN_REGRESSIONS)).includes("'module-reachability-regression.js'"),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[module-reachability-regression] 模块可达性契约（不许再有孤儿模块）\n');
process.stdout.write(
  '  · 可达模块 ' + [...seen].map(rel).filter((f) => f.startsWith('src/')).length + ' 个，' +
    'worker 动态种子 ' + seeds.size + ' 个，' +
    'IPC 通道：preload 出站 ' + preloadOutbound.size + ' → 主进程注册 ' + registeredChannels.size + '，' +
    '主进程发送 ' + mainSideSends.size + ' → preload 监听 ' + preloadListens.size + '，' +
    'onXxx 导出 ' + preloadOnExports.size + '\n',
);
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[module-reachability-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[module-reachability-regression] PASS（' + notes.length + ' 项）\n');
