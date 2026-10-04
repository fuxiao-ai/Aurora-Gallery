/**
 * CSS 引用回归：拦截「样式表里定义了、但全项目没有任何元素/脚本使用的类名或 id」。
 *
 * 背景：卡片尺寸、工具栏筛选、预览信息栏、Toast、搜索历史等一批 UI 被重构或移除后，
 * 对应样式规则长期滞留在 CSS 里。这类死规则不会报错，只会随迭代越积越多。
 * 2026-09 一次性清理了 82 个死分支（renderer 43 + web 内联 39），本脚本用于防止再次累积。
 *
 * 判定口径（刻意保守，宁可漏报不误报）：
 *   - 引用来源 = src 下所有 html 的 class/id 属性 + 所有 js 的字符串字面量 + '前缀-' + x 拼接。
 *     js 采用「字符串字面量」而非精确的 classList/querySelector 采集，是为了覆盖
 *     `node('button', text, 'ai-button')`、`element('div', 'compare-stage')` 这类 helper 传参写法，
 *     避免把动态生成的类名误判为死规则。
 *   - 通用状态类（disabled/show/active/selected 等）一律视为活，不参与判定。
 *   - 已删除的孤儿样式表 src/web/css/style.css（内容重复内联进 web/index.html、无任何页面加载）
 *     曾通过 IGNORE_FILES 排除，文件本身已于 2026-09-27 移除。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const SKIP_DIRS = new Set(['node_modules', '.git', 'release', 'out', 'dist', '.workbuddy', 'docs']);

// 未被任何页面加载的孤儿样式表（不计入守护范围）。
// 2026-09-27 曾在此排除 src/web/css/style.css，该文件已确认无任何页面加载后整体删除，故此处现为空。
const IGNORE_FILES = new Set();

// 通用状态类：由 JS 在运行时切来切去，不做静态引用统计
const STATE_CLASSES = new Set([
  'active',
  'hidden',
  'visible',
  'open',
  'show',
  'selected',
  'current',
  'disabled',
  'dragging',
  'loading',
  'is-mobile',
  'expanded',
  'collapsed',
  'minimized',
  'done',
  'error',
]);

const HEX = /^[0-9a-fA-F]{3,8}$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const jsFiles = files.filter((f) => f.endsWith('.js'));
const cssFiles = files.filter((f) => f.endsWith('.css'));

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');

// ---------- 采集引用 ----------
const refs = new Set();
const prefixes = new Set();
const addTokens = (raw) =>
  String(raw)
    .split(/\s+/)
    .forEach((t) => t && refs.add(t));

for (const f of htmlFiles) {
  const s = fs.readFileSync(f, 'utf8');
  let m;
  const rc = /\bclass\s*=\s*"([^"]*)"/g;
  while ((m = rc.exec(s))) addTokens(m[1]);
  const ri = /\bid\s*=\s*"([^"]+)"/g;
  while ((m = ri.exec(s))) addTokens(m[1]);
}

for (const f of jsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  let m;

  // 从字符串里再抠出 class="..." 片段（拼接生成 DOM 时类名常被 token 边界切断）
  const harvestClass = (lit) => {
    addTokens(lit);
    const clsRe = /class\s*=\s*["']([^"']*)/g;
    let c;
    while ((c = clsRe.exec(lit))) addTokens(c[1]);
  };

  // 单/双引号字符串字面量：覆盖 helper 传参、模板拼接、classList、querySelector 等写法
  const rstr = /'([^'\\\n]*)'|"([^"\\\n]*)"/g;
  while ((m = rstr.exec(s))) harvestClass(m[1] !== undefined ? m[1] : m[2]);

  // 模板字符串
  const rtpl = /`([^`]*)`/g;
  while ((m = rtpl.exec(s))) harvestClass(m[1]);

  // 'prefix-' + x 与 `prefix-${x}` 拼接
  const rp1 = /(['"`])([A-Za-z][\w-]*-)\1\s*\+/g;
  while ((m = rp1.exec(s))) prefixes.add(m[2]);
  const rp2 = /`([A-Za-z][\w-]*-)\$\{/g;
  while ((m = rp2.exec(s))) prefixes.add(m[1]);
  const rp3 = /\+\s*(['"`])([A-Za-z][\w-]*-)\1/g;
  while ((m = rp3.exec(s))) prefixes.add(m[2]);
}

const referenced = (name) =>
  refs.has(name) || STATE_CLASSES.has(name) || [...prefixes].some((p) => name.startsWith(p));

// ---------- 解析 CSS 规则块 ----------
const mask = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function splitTop(s) {
  const out = [];
  let depth = 0;
  let inStr = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === inStr && s[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** 返回 [{ selector, line }]，含 @media 内的规则 */
function collectSelectors(css, baseLine = 1) {
  const text = mask(css);
  const lineOf = (i) => baseLine + text.slice(0, i).split('\n').length - 1;
  const out = [];
  let i = 0;
  let selStart = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const selector = text.slice(selStart, i);
      let j = i + 1;
      let depth = 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const trimmed = selector.trim();
      if (/^@(media|supports|layer)/.test(trimmed)) {
        out.push(...collectSelectors(text.slice(i + 1, j - 1), lineOf(i)));
      } else if (!/^@/.test(trimmed)) {
        out.push({ selector: trimmed, line: lineOf(selStart) });
      }
      selStart = j;
      i = j;
    } else if (ch === ';') {
      selStart = i + 1;
      i++;
    } else i++;
  }
  return out;
}

// ---------- 扫描 ----------
const violations = [];

function scan(target, cssText, startLine) {
  for (const { selector, line } of collectSelectors(cssText, startLine)) {
    for (const part of splitTop(selector)) {
      const names = new Set();
      let m;
      const rc = /\.(-?[A-Za-z_][\w-]*)/g;
      while ((m = rc.exec(part))) names.add(m[1]);
      const ri = /#([A-Za-z_][\w-]*)/g;
      while ((m = ri.exec(part))) names.add(m[1]);

      const dead = [...names].filter((n) => !referenced(n) && !HEX.test(n));
      if (dead.length) {
        violations.push(
          `${target}:${line}  [${dead.map((d) => '.' + d).join(' ')}]  ${part.replace(/\s+/g, ' ').trim().slice(0, 90)}`,
        );
      }
    }
  }
}

for (const f of cssFiles) {
  if (IGNORE_FILES.has(rel(f))) continue;
  scan(rel(f), fs.readFileSync(f, 'utf8'), 1);
}

for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cssStart = m.index + m[0].indexOf(m[1]);
    const startLine = html.slice(0, cssStart).split('\n').length;
    scan(rel(f) + ' <style>', m[1], startLine);
  }
}

if (violations.length) {
  console.error('[css-reference-regression] FAIL：发现 CSS 死规则（定义了但无任何元素/脚本引用）');
  console.error('  若确认是动态生成的类名，请检查 JS 里是否以字符串字面量形式出现；');
  console.error('  通用状态类请加入 STATE_CLASSES，孤儿样式表请加入 IGNORE_FILES。\n');
  violations.forEach((v) => console.error('  ' + v));
  process.exitCode = 1;
} else {
  console.log('[css-reference-regression] PASS');
}
