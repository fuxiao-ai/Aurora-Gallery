'use strict';
/**
 * 失联引用回归：拦截「脚本引用了并不存在的东西」。
 *
 * 背景：本项目渲染端由十几个全局模块拼装而成（`global.RendererXxx = Object.assign(...)`），
 * 模块之间靠裸全局名互相调用；DOM 则由 index.html 静态提供 + JS 动态创建。
 * 一旦某次重构只删了「定义」没删「引用」（或反过来），就会出现三类静默失效：
 *
 *   1. 读取从未被赋值的模块全局 —— 例如 `var ui = window.RendererFacesUI || {}`，
 *      取到空对象，后续调用静默失效或整块功能消失；
 *   2. 调用模块没有导出的方法 —— 例如 `uiNavigation.applyFacesView(...)`，
 *      方法不在导出对象里，运行时直接 TypeError；
 *   3. 引用不存在的 DOM id —— 例如 `$('#previewSubtitleSizeSelect')`，
 *      selector 永远返回 null，配合 `if (el)` 守卫就变成一片死代码。
 *
 * 三类都不会报错、ESLint 也发现不了，只会让功能悄悄失效，所以需要静态守护。
 * 本脚本用 acorn 解析出真实 AST（而不是正则猜结构），因此能拿到准确的模块导出键表。
 *
 * 判定口径（刻意保守，宁可漏报不误报）：
 *   - 只扫浏览器侧脚本（renderer / web / hls-attach / playback-strategy），不碰主进程。
 *   - 模块全局的「读取」只统计 `window.` / `global.` 前缀。UMD 包装里的 `root.` 不作读取来源，
 *     因为 `root` 在 `(function (root, factory) {...})` 里常被复用作普通参数名，误报率极高；
 *     但 `root.X = ...` 仍计入「已定义」，避免漏掉 web 端 UMD 模块。
 *   - 方法表只对「导出对象可静态枚举」的模块生效：右值是对象字面量或 `Object.assign(...)`
 *     且各参数里没有展开符 / 计算属性 / 无法识别的对象。其余（`= api;`、`= factory()`、
 *     `= X.mount({...})`）一律跳过——它们是把返回值挂到全局，可用方法无法静态判定。
 *   - 调用点若所在文件把同名标识符声明成了局部名（局部遮蔽全局），跳过该文件。
 *   - 浏览器内置 API / 宿主注入对象列入 BROWSER_GLOBALS 白名单。
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const SKIP_DIRS = new Set(['node_modules', '.git', 'release', 'out', 'dist', '.workbuddy']);

/** 作为全局模块容器的对象名 */
const GLOBAL_OBJS = new Set(['window', 'global', 'root', 'self']);
/** 只有这两个前缀参与「读取检查」，见文件头说明 */
const READ_OBJS = new Set(['window', 'global']);

/** 浏览器内置全局 / 宿主注入对象：它们不由本项目脚本赋值 */
const BROWSER_GLOBALS = new Set([
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'alert',
  'confirm',
  'prompt',
  'formatNumber', // web-theme-shared.js 注入，见 eslint.config.js 的 globals
  'getComputedStyle',
  'history',
  'innerHeight',
  'innerWidth',
  'location',
  'matchMedia',
  'navigator',
  'photoAPI', // preload 注入的桥接对象
  'querySelector',
  'querySelectorAll',
  'scrollTo',
  'scrollBy',
  'scrollX',
  'scrollY',
  'pageXOffset',
  'pageYOffset',
  'devicePixelRatio',
  'screen',
  'document',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  'atob',
  'btoa',
  'fetch',
  'caches',
  'crypto',
  'performance',
  'open',
  'close',
  'print',
  'origin',
  'name',
  'top',
  'parent',
  'length',
  'closed',
  'isSecureContext',
  'IntersectionObserver',
  'ResizeObserver',
  'MutationObserver',
  'CSS',
  'Image',
  'Event',
  'CustomEvent',
  'HTMLElement',
  'Blob',
  'File',
  'FileReader',
  'Hls',
  'URL',
  'URLSearchParams',
  'electronAPI', // preload 暴露的 IPC 桥
  'logRendererError', // app.js 早期错误钩子
  'appAlert',
  'appConfirm',
]);

const ID_LITERAL = /^#[A-Za-z_][\w-]*$/;
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name === 'vendor') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

/** 去掉注释，保留字符串字面量（HTML 片段里的 id="..." 需要保留） */
function stripComments(src) {
  let out = '';
  let i = 0;
  let st = null;
  while (i < src.length) {
    const c = src[i];
    if (st) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] || '';
        i += 2;
        continue;
      }
      if (c === st) st = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      st = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'range' || k === 'parent') continue;
    const v = node[k];
    if (v && typeof v === 'object') walkAst(v, visit);
  }
}

const allFiles = walk(SRC);
const isBrowserScript = (f) =>
  /[\\/]renderer[\\/]/.test(f) ||
  /[\\/]web[\\/]/.test(f) ||
  /hls-attach\.js$/.test(f) ||
  /playback-strategy\.js$/.test(f);

const browserJs = allFiles.filter((f) => f.endsWith('.js') && isBrowserScript(f));
const htmlFiles = allFiles.filter((f) => f.endsWith('.html'));

const violations = [];
const add = (kind, file, line, message) =>
  violations.push({ kind, where: `${file}:${line}`, message });

const parsed = []; // { file, ast, stripped }
const parseWarnings = [];

for (const f of browserJs) {
  const raw = fs.readFileSync(f, 'utf8');
  const stripped = stripComments(raw);
  try {
    // 必须解析**原始**源码：acorn 自己懂注释，而 stripComments 会把正则字面量里的
    // // 或 /* 误当注释切开（例如 /https?:\/\//），导致「Unterminated regular expression」。
    const ast = acorn.parse(raw, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
    parsed.push({ file: rel(f), ast, stripped });
  } catch (err) {
    parseWarnings.push(`${rel(f)}: ${err.message}`);
  }
}

const lineOf = (node) => (node.loc ? node.loc.start.line : 0);
const isGlobalRef = (node) =>
  node &&
  node.type === 'MemberExpression' &&
  !node.computed &&
  node.object &&
  node.object.type === 'Identifier';

/** 从 `X` 或 `window.X` 这两种写法里取出模块名 X */
function ownerName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (
    isGlobalRef(node) &&
    GLOBAL_OBJS.has(node.object.name) &&
    node.property.type === 'Identifier'
  ) {
    return node.property.name;
  }
  return null;
}

/** 形如 `a.b`（属性非计算）的成员访问，用于识别 `X.foo(...)` 与 `window.X.foo(...)` */
const isMemberAccess = (node) => node && node.type === 'MemberExpression' && !node.computed;

// ============================================================
// 一、模块全局：定义集合 + 读取检查
// ============================================================

const definedGlobals = new Set();
const defs = []; // { name, rhs }

for (const { ast, file, stripped } of parsed) {
  walkAst(ast, (n) => {
    if (
      n.type === 'AssignmentExpression' &&
      n.operator === '=' &&
      isGlobalRef(n.left) &&
      GLOBAL_OBJS.has(n.left.object.name) &&
      n.left.property.type === 'Identifier'
    ) {
      definedGlobals.add(n.left.property.name);
      defs.push({ name: n.left.property.name, rhs: n.right, file, stripped });
    }
  });
}

for (const { ast, file, stripped } of parsed) {
  walkAst(ast, (n) => {
    if (!isGlobalRef(n) || !READ_OBJS.has(n.object.name)) return;
    const name = n.property.type === 'Identifier' ? n.property.name : null;
    if (!name) return;
    if (definedGlobals.has(name) || BROWSER_GLOBALS.has(name)) return;
    // 赋值左侧属于定义，不是读取
    const line = lineOf(n);
    const srcLine = stripped.split('\n')[line - 1] || '';
    if (new RegExp(`(?:window|global)\\s*\\.\\s*${name}\\s*=(?!=)`).test(srcLine)) return;
    add('global', file, line, `读取了从未被赋值的模块全局 window.${name} / global.${name}`);
  });
}

// ============================================================
// 二、模块方法调用检查
// ============================================================

/** 从右值表达式提取可静态枚举的方法键；无法判定返回 null */
function moduleKeys(rhs) {
  const isObjectAssign =
    rhs.type === 'CallExpression' &&
    rhs.callee.type === 'MemberExpression' &&
    !rhs.callee.computed &&
    rhs.callee.object.name === 'Object' &&
    rhs.callee.property.name === 'assign';

  if (!isObjectAssign && rhs.type !== 'ObjectExpression') return null; // `= api;` / `= factory()` / `= X.mount({...})`

  const args = isObjectAssign ? rhs.arguments : [rhs];
  const keys = new Set();
  for (const a of args) {
    if (!a) return null;
    if (a.type === 'ObjectExpression') {
      for (const p of a.properties) {
        if (p.type === 'SpreadElement' || p.computed) return null;
        if (p.key.type === 'Identifier') keys.add(p.key.name);
        else if (p.key.type === 'Literal' && typeof p.key.value === 'string') keys.add(p.key.value);
        else return null;
      }
      continue;
    }
    // Object.assign 的其余实参：只放行「自引用扩展」写法（`global.X || {}`、`base`），
    // 碰到别的对象字面量来源就说明导出表取不全，放弃判定。
    const selfRef =
      a.type === 'Identifier' ||
      a.type === 'MemberExpression' ||
      ((a.type === 'LogicalExpression' || a.type === 'BinaryExpression') &&
        a.left.type !== 'ObjectExpression' &&
        (a.right.type === 'ObjectExpression' ||
          a.right.type === 'Identifier' ||
          a.right.type === 'MemberExpression'));
    if (!selfRef) return null;
  }
  return keys;
}

/** 模块名 -> Set(键) | null（null 表示无法静态判定，跳过） */
const moduleMethods = new Map();
for (const { name, rhs } of defs) {
  const keys = moduleKeys(rhs);
  if (keys === null) {
    if (!moduleMethods.has(name)) moduleMethods.set(name, null);
    continue;
  }
  const cur = moduleMethods.get(name);
  if (cur === null) continue;
  const next = cur || new Set();
  keys.forEach((k) => next.add(k));
  moduleMethods.set(name, next);
}

// 动态挂载：X.foo = fn / window.X.foo = fn / X['foo'] = fn
for (const { ast } of parsed) {
  walkAst(ast, (n) => {
    if (n.type !== 'AssignmentExpression' || !n.left || n.left.type !== 'MemberExpression') return;
    const name = ownerName(n.left.object);
    if (!name || !moduleMethods.has(name)) return;
    const methods = moduleMethods.get(name);
    if (!methods) return;
    if (n.left.property.type === 'Identifier') methods.add(n.left.property.name);
    else if (
      n.left.computed &&
      n.left.property.type === 'Literal' &&
      typeof n.left.property.value === 'string'
    ) {
      methods.add(n.left.property.value);
    }
  });
}

/** 文件内被声明为局部名的标识符集合（局部会遮蔽全局模块） */
function localNames(ast) {
  const names = new Set();
  const addPattern = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern')
      p.properties.forEach((x) => addPattern(x.value || x.argument));
    else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  walkAst(ast, (n) => {
    if (n.type === 'VariableDeclarator') addPattern(n.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') addPattern(n.id);
    else if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression'
    ) {
      n.params.forEach(addPattern);
    } else if (n.type === 'CatchClause') addPattern(n.param);
  });
  return names;
}

let checkedModules = 0;
for (const { ast, file } of parsed) {
  const locals = localNames(ast);
  walkAst(ast, (n) => {
    if (n.type !== 'CallExpression' || !isMemberAccess(n.callee)) return;
    const name = ownerName(n.callee.object);
    if (!name) return;
    const methods = moduleMethods.get(name);
    if (!methods) return; // 不存在或无法静态判定
    if (locals.has(name)) return; // 被局部同名变量遮蔽
    if (n.callee.property.type === 'Identifier') {
      const method = n.callee.property.name;
      if (methods.has(method)) return;
      add('method', file, lineOf(n), `调用了 ${name}.${method}()，但该模块未导出 ${method}`);
    }
  });
}
for (const m of moduleMethods.values()) if (m) checkedModules += 1;

// ============================================================
// 三、DOM id 引用检查
// ============================================================

const ids = new Set();

for (const f of htmlFiles) {
  const s = fs.readFileSync(f, 'utf8');
  let m;
  const r = /\bid\s*=\s*["']([^"']+)["']/g;
  while ((m = r.exec(s))) ids.add(m[1]);
}

for (const { stripped } of parsed) {
  let m;
  // 拼接/模板生成的 DOM：从字符串里抠 id="..."
  const r1 = /\bid\s*=\s*["']([^"']+)["']/g;
  while ((m = r1.exec(stripped))) ids.add(m[1]);
  // el.id = '...'（含三元表达式，取该行所有字符串字面量）
  const r2 = /\.id\s*=\s*([^;\n]+)/g;
  while ((m = r2.exec(stripped))) {
    const lits = m[1].match(/['"`]([A-Za-z_][\w-]*)['"`]/g) || [];
    lits.forEach((x) => ids.add(x.slice(1, -1)));
  }
  // setAttribute('id', '...')
  const r3 = /setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]/g;
  while ((m = r3.exec(stripped))) ids.add(m[1]);
}

for (const { ast, file } of parsed) {
  walkAst(ast, (n) => {
    if (n.type !== 'Literal' || typeof n.value !== 'string') return;
    if (!ID_LITERAL.test(n.value) || HEX_COLOR.test(n.value)) return;
    if (ids.has(n.value.slice(1))) return;
    add('id', file, lineOf(n), `引用了不存在的 DOM id ${n.value}`);
  });
}

// ============================================================
// 输出
// ============================================================

if (parseWarnings.length) {
  console.warn('[dead-reference-regression] 以下文件解析失败，本次未纳入检查：');
  parseWarnings.forEach((w) => console.warn('  ' + w));
  console.warn('');
}

if (violations.length) {
  const byKind = {
    global: '【模块全局】读取了从未被赋值的全局模块',
    method: '【模块方法】调用了模块没有导出的方法',
    id: '【DOM id】引用了不存在的元素 id',
  };
  console.error('[dead-reference-regression] FAIL：发现失联引用\n');
  for (const kind of ['global', 'method', 'id']) {
    const list = violations.filter((v) => v.kind === kind);
    if (!list.length) continue;
    console.error(`${byKind[kind]}（${list.length} 处）`);
    list.forEach((v) => console.error(`  ${v.where}  ${v.message}`));
    console.error('');
  }
  console.error('  若是浏览器内置 API 或宿主注入对象，请加入 BROWSER_GLOBALS；');
  console.error('  若是动态生成的 id，请确认 JS 里以 id="..." / .id = 字面量 形式出现。');
  process.exitCode = 1;
} else {
  console.log(
    `[dead-reference-regression] PASS（已定义模块全局 ${definedGlobals.size} 个、可静态判定方法表 ${checkedModules} 个、DOM id ${ids.size} 个）`,
  );
}
