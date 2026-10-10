'use strict';
// 「主进程发起的提示 / 确认必须由渲染端画（才会跟主题走），并且每个请求都必须结算」的回归。
//
// 为什么用源码契约断言：main.js 一上来就 require electron（app / ipcMain），回归里加载不了，
// 判据留在里面就只能靠读源码文本验 —— 那就把文本断言写在**能跑的地方**，并明确它测的是什么。
// 真正跑起来的那一半（弹窗真的开、回执真的回、亮暗两套主题下颜色真的不同）由人工探针
// `.workbuddy/tmp/app-dialog-theme-probe.js` 验（14 项，本机全绿）—— 它需要 BrowserWindow，
// `ELECTRON_RUN_AS_NODE` 下拿不到，所以不进套件。
//
// 钉三类错（都属于「静默失效」）：
//   ① 又用 `dialog.showMessageBox` 弹应用自己的提示 ⇒ 主题一变就不跟（系统外观）；
//   ② 渲染端漏回执 ⇒ 主进程那条 Promise 悬挂 20 秒，用户看到的是「点了没反应」；
//   ③ 回执只在成功分支里发 ⇒ 用户点「取消」时同样悬挂（这个最像不出来的 bug）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

/* ------------------------------------------------------------------ 取法
 *
 * 🔴 `testNoNativePromptsLeft` 原来是从锚点往后**切固定长度**（`slice(At, At + 1200)` 等四种长度）。
 *    那种取法在两个方向上都假（2026-10-08 全仓库审计，实测见技能「窗口法审计」一节）：
 *      · 太窄 ⇒ 有人往锚点**前面**插几行，目标就滑出窗口 = **假红**（本工程栽过两次）；
 *      · 太宽 ⇒ 隔壁函数里的同名字符串照样满足 = **假绿**。
 *    而这里偏偏有**反向断言**（`doesNotMatch(/dialog\.showMessageBox/)`）——「窗外真出现系统弹窗」
 *    窗口法根本看不见，而那正是这条守护存在的唯一理由。
 *    ⇒ 一律改成 AST 取**整个作用域**：
 *      · 具名处理器 → 取 `callee(第一个参数是字面量, fn)` 的那个回调体；
 *      · 只有字符串锚点（日志文案）→ 取**包含该字符串的最小外层函数体**。
 *
 *    源码先按 AST 剥注释（剥掉的部分补等长空格 ⇒ 偏移不变）：本工程元规则
 *    「结构断言不许读注释」。正则版剥注释会把字符串里的 `//` 截错行，不能拿来喂 `acorn`。
 */

function parse(src, file) {
  try {
    return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (eScript) {
    try {
      return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (eModule) {
      throw new Error('无法解析 ' + file + '：' + eModule.message, { cause: eModule });
    }
  }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walk(node[key], visit);
  }
}

function stripCommentsByAst(src) {
  let ranges = [];
  const collect = (block, text, start, end) => {
    ranges.push([start, end]);
  };
  try {
    ranges = [];
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', onComment: collect });
  } catch (eScript) {
    ranges = [];
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', onComment: collect });
  }
  if (!ranges.length) return src;
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += src.slice(cursor, start) + ' '.repeat(end - start);
    cursor = end;
  }
  return out + src.slice(cursor);
}

/** `mainWindow.webContents` → `a.b` 这种成员路径（只认非计算的标识符属性）。 */
function exprPath(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property &&
    node.property.type === 'Identifier'
  ) {
    const base = exprPath(node.object);
    return base ? base + '.' + node.property.name : '';
  }
  return '';
}

/** 取 `objectPath.method(<第一个参数是字面量>, fn)` 的回调体（`objectPath` 可以是 `a.b`）。 */
function callbackBodyOfPath(src, objectPath, methodName, firstArgLiteral) {
  const ast = parse(src, objectPath + '.' + methodName);
  let found = null;
  walk(ast, (node) => {
    if (found) return;
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
    if (!callee.property || callee.property.name !== methodName) return;
    if (exprPath(callee.object) !== objectPath) return;
    const first = node.arguments && node.arguments[0];
    if (!first || first.value !== firstArgLiteral) return;
    for (let i = 1; i < node.arguments.length; i++) {
      const arg = node.arguments[i];
      if (arg && (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression')) {
        found = src.slice(arg.body.start, arg.body.end);
        return;
      }
    }
  });
  return found;
}

/**
 * 取**包含 `needle` 的最小外层函数体**。给「只有字符串能当锚点」的场合用
 * （例如失败路径上的一句日志文案）——比「函数名叫什么」稳，也比窗口法准。
 * 只认有块体的函数（箭头表达式体没大括号，取到也没法断言）。
 */
function enclosingFunctionBody(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const ast = parse(src, needle);
  let best = null;
  walk(ast, (node) => {
    if (
      node.type !== 'FunctionDeclaration' &&
      node.type !== 'FunctionExpression' &&
      node.type !== 'ArrowFunctionExpression'
    ) {
      return;
    }
    const body = node.body;
    if (!body || body.type !== 'BlockStatement') return;
    if (body.start > at || body.end < at) return;
    if (!best || body.end - body.start < best.end - best.start) best = body;
  });
  return best ? src.slice(best.start, best.end) : null;
}

function testBridgeWiring() {
  assert.match(mainSrc, /ipcMain\.on\('app-dialog-response'/, '主进程要收弹窗回执');
  assert.match(mainSrc, /function askInAppDialog\(/, '要有「交给渲染端画」的入口');
  assert.match(mainSrc, /function confirmInApp\(/, '确认框要有主题版');
  assert.match(mainSrc, /function alertInApp\(/, '提示框要有主题版');
  assert.match(preloadSrc, /onAppDialogRequest/, 'preload 要暴露弹窗请求订阅');
  assert.match(preloadSrc, /respondAppDialog/, 'preload 要暴露回执');
  assert.match(rendererSrc, /function bindAppDialogRequests\(/, '渲染端要有这条桥');
  assert.match(rendererSrc, /bindAppDialogRequests\(\);/, '这条桥必须被调用（否则请求没人应）');
}

function testEveryPathSettles() {
  // 超时必须结算：`resolveAppDialog(id, ...)` 里清定时器 + resolve 都在同一个函数里，
  // 断言两处都在（只清定时器不 resolve = 调用方永远等下去）。
  assert.match(
    mainSrc,
    /pendingAppDialogs\.delete\(id\);\s*\n\s*clearTimeout\(pending\.timer\);\s*\n\s*pending\.resolve\(result\);/,
    '结算必须「摘表 + 清定时器 + resolve」三件一起做',
  );
  assert.match(mainSrc, /logger\.warn\('\[dialog\] 渲染端未应答/, '超时回落要有 warn（生产档只有 warn 可见）');
  // 渲染端：成功与失败两条分支都要回执 —— 只写成功分支的话，用户点「取消」就会悬挂。
  const replies = rendererSrc.match(/api\.respondAppDialog\(\{ id: req\.id/g) || [];
  assert.ok(replies.length >= 3, '渲染端每条出口（无弹窗能力 / 成功 / 异常）都要回执，实际 ' + replies.length);
}

function testNoNativePromptsLeft() {
  // 这四处曾经是 `dialog.showMessageBox(Sync)`：清理确认、优化确认、维护失败提示、数据目录回退提示。
  // 判据用「调用点必须在**同一作用域**里出现主题版入口」——比全局禁止弹系统窗更精确（启动失败那处
  // 没有窗口可画，必须留系统弹窗；窗口关闭选择器另有主题覆盖层走渲染端）。
  const src = stripCommentsByAst(mainSrc);

  const cleanupBlock = callbackBodyOfPath(
    src,
    'ipcMain',
    'handle',
    'maintenance-cleanup-missing-files',
  );
  assert.ok(cleanupBlock, "找得到清理入口 ipcMain.handle('maintenance-cleanup-missing-files', fn)");
  assert.match(cleanupBlock, /confirmInApp\(/, '清理确认要走主题弹窗');
  assert.doesNotMatch(cleanupBlock, /dialog\.showMessageBoxSync/, '清理确认不该再用系统弹窗');

  const optimizeBlock = callbackBodyOfPath(
    src,
    'ipcMain',
    'handle',
    'maintenance-optimize-database',
  );
  assert.ok(optimizeBlock, "找得到优化入口 ipcMain.handle('maintenance-optimize-database', fn)");
  assert.match(optimizeBlock, /confirmInApp\(/, '优化确认要走主题弹窗');
  assert.doesNotMatch(optimizeBlock, /dialog\.showMessageBox\(/, '优化确认不该再用系统弹窗');

  // 维护失败提示：整条失败路径（`performMaintenance` 的 catch）都要走主题弹窗
  const failBlock = enclosingFunctionBody(src, 'Database maintenance failed:');
  assert.ok(failBlock, '找得到维护失败路径（锚点 `Database maintenance failed:` 所在的外层函数）');
  assert.match(failBlock, /alertInApp\(/, '维护失败提示要走主题弹窗');
  assert.doesNotMatch(failBlock, /dialog\.showMessageBox/, '维护失败提示不该再用系统弹窗');

  // 数据目录回退提示：直接取 `did-finish-load` 的回调体 —— 于是
  // 「必须晚于 did-finish-load」（早于它渲染端还没注册监听，请求会掉在地上等 20 秒超时）
  // 从「首次出现的字符位置先后」升级成**结构事实**：这段提示就在那个回调里。
  const fallbackBlock = callbackBodyOfPath(
    src,
    'mainWindow.webContents',
    'once',
    'did-finish-load',
  );
  assert.ok(fallbackBlock, '找得到 did-finish-load 回调（回退提示挂在它里面）');
  assert.match(fallbackBlock, /if \(dataDirFallbackReason\)/, '回退提示要有触发条件（reason 非空才弹）');
  assert.match(fallbackBlock, /alertInApp\(/, '数据目录回退提示要走主题弹窗');
  assert.doesNotMatch(fallbackBlock, /dialog\.showMessageBox/, '数据目录回退提示不该再用系统弹窗');
}

function testI18nKeysExist() {
  // 主进程递 i18n 键、渲染端渲染。两边的键名写错 = 弹出一个空文案的弹窗，
  // 而且**只有真到那一步才看得见**（盘没插时才触发）⇒ 这里把中文/英文两份词条都钉住。
  const i18nSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'i18n.js'), 'utf8');
  for (const key of [
    'settings.storage.dataDirFallbackTitle',
    'settings.storage.dataDirFallbackDialogFmt',
  ]) {
    assert.match(mainSrc, new RegExp(key), 'main.js 要用 ' + key);
    const hits = i18nSrc.match(new RegExp("'" + key.replace(/\./g, '\\.') + "'", 'g')) || [];
    assert.equal(hits.length, 2, key + ' 必须在中文块与英文块各有一条（实际 ' + hits.length + '）');
  }
}

function main() {
  testBridgeWiring();
  testEveryPathSettles();
  testNoNativePromptsLeft();
  testI18nKeysExist();
  console.log('app-dialog-bridge-regression: PASS');
}

main();
