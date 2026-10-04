'use strict';

// 校验桌面端主界面三栏布局的 DOM 结构。
// 背景：导航栏重构（侧栏 tab 迁到左侧图标栏）时曾残留一个多余的 </div>，
// 导致 #sidebar 提前闭合、目录树被甩到 .main-layout 变成第四栏。
// 该问题不会被现有回归覆盖（其余脚本使用 mock DOM，不解析 index.html），故单独守护。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// HTML 允许省略结束标签的元素，遇到这些标签的关闭标签时允许跳过匹配。
const OPTIONAL_END_TAGS = new Set(['li', 'option', 'p', 'td', 'th', 'tr']);

function parseHtml(source) {
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  const errors = [];
  const tagRe = /<(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

  let match;
  while ((match = tagRe.exec(cleaned)) !== null) {
    const isClosing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const rawAttrs = match[3] || '';
    const selfClosing = match[4] === '/';
    const line = cleaned.slice(0, match.index).split('\n').length;

    if (VOID_TAGS.has(tag) || selfClosing) continue;

    if (!isClosing) {
      const node = {
        tag,
        attrs: parseAttrs(rawAttrs),
        children: [],
        parent: stack[stack.length - 1],
        line,
        closeLine: 0,
      };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }

    // 关闭标签：优先匹配栈顶。
    if (stack[stack.length - 1].tag === tag) {
      stack[stack.length - 1].closeLine = line;
      stack.pop();
      continue;
    }
    if (OPTIONAL_END_TAGS.has(tag)) {
      const idx = stack.map((n) => n.tag).lastIndexOf(tag);
      if (idx > 0) {
        stack.length = idx;
        continue;
      }
    }
    errors.push(
      `第 ${line} 行 </${tag}> 与栈顶 <${stack[stack.length - 1].tag}> 不匹配` +
        `（可能是标签嵌套错位或多余的关闭标签）`,
    );
    // 容错：仍然弹出栈顶，避免级联噪声。
    stack.pop();
  }

  if (stack.length > 1) {
    errors.push(
      '以下标签未闭合：' +
        stack
          .slice(1)
          .map((n) => `<${n.tag}>`)
          .join(', '),
    );
  }

  return { root, errors };
}

function parseAttrs(raw) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = attrRe.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    attrs[name] =
      m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
  }
  return attrs;
}

function hasClass(node, cls) {
  return (node.attrs.class || '').split(/\s+/).includes(cls);
}

function findById(node, id) {
  if (node.attrs.id === id) return node;
  for (const child of node.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function contains(node, target) {
  for (const child of node.children) {
    if (child === target) return true;
    if (contains(child, target)) return true;
  }
  return false;
}

function findByClass(node, cls) {
  if (hasClass(node, cls)) return node;
  for (const child of node.children) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return null;
}

function directChild(node, predicate) {
  return node.children.find(predicate) || null;
}

function main() {
  const file = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  const source = fs.readFileSync(file, 'utf8');
  const { root, errors } = parseHtml(source);

  const mainLayout = findByClass(root, 'main-layout');
  assert.ok(mainLayout, '未找到 .main-layout 主布局容器');

  // 先做归属诊断：侧栏提前闭合时，后续节点会被挤到 .main-layout 同级形成第四栏，
  // 这比"某元素缺失"的级联报错更能定位根因，所以放在骨架断言之前。
  const sidebar = findById(root, 'sidebar');
  assert.ok(sidebar, '未找到中间侧栏 #sidebar');

  const sidebarOwned = [
    'navigationHeading',
    'settingsSidebar',
    'peopleSidebar',
    'folderNavBar',
    'sidebarContent',
    'sidebarContentDuplicate',
    'sidebarTreeLoadingFooter',
  ];
  const expelled = [];
  for (const id of sidebarOwned) {
    const node = findById(root, id);
    assert.ok(node, `缺少侧栏节点 #${id}`);
    if (!contains(sidebar, node)) {
      expelled.push(
        `#${id}（第 ${node.line} 行）` +
          (sidebar.closeLine ? ` 落在 #sidebar 第 ${sidebar.closeLine} 行的闭合之后` : ''),
      );
    }
  }
  assert.deepEqual(
    expelled,
    [],
    '#sidebar 被提前闭合，以下节点被挤出侧栏、会破坏三栏布局：\n  ' + expelled.join('\n  '),
  );

  // 三栏布局骨架：图标栏 / 侧栏 / 内容区（设置页与内容区互斥）
  const rail = directChild(mainLayout, (n) => hasClass(n, 'app-rail'));
  const resizer = directChild(mainLayout, (n) => n.attrs.id === 'sidebarResizer');
  const content = directChild(mainLayout, (n) => n.attrs.id === 'contentArea');
  const settings = directChild(mainLayout, (n) => n.attrs.id === 'settingsPage');

  assert.ok(rail, '主布局缺少左侧图标栏 .app-rail');
  assert.ok(resizer, '主布局缺少侧栏拖拽条 #sidebarResizer');
  assert.ok(content, '主布局缺少右侧内容区 #contentArea');
  assert.ok(settings, '主布局缺少设置页 #settingsPage');
  assert.ok(
    directChild(mainLayout, (n) => n.attrs.id === 'sidebar') === sidebar,
    '#sidebar 不是 .main-layout 的直接子元素',
  );

  const order = mainLayout.children.map((n) => n.attrs.id || n.attrs.class);
  assert.ok(
    order.indexOf('app-rail') < order.indexOf('sidebar'),
    '图标栏应位于侧栏之前，当前顺序：' + order.join(' > '),
  );
  assert.ok(
    order.indexOf('sidebar') < order.indexOf('sidebarResizer') &&
      order.indexOf('sidebarResizer') < order.indexOf('contentArea'),
    '侧栏 → 拖拽条 → 内容区 顺序异常，当前顺序：' + order.join(' > '),
  );

  // 侧栏内不应残留旧版横向导航标签（.nav-tab 一律属于图标栏，包括搜图 / 人物）。
  const staleTabs = [];
  (function walk(node) {
    if (hasClass(node, 'nav-tab')) staleTabs.push(`<${node.tag}> @第 ${node.line} 行`);
    node.children.forEach(walk);
  })(sidebar);
  assert.deepEqual(
    staleTabs,
    [],
    '#sidebar 内仍残留旧版导航标签（.nav-tab），会与左侧图标栏重复显示',
  );
  const railTabs = rail.children.filter((n) => n.attrs['data-tab']);
  assert.deepEqual(
    railTabs.map((n) => n.attrs['data-tab']),
    ['folders', 'dates', 'search', 'people', 'duplicates'],
    '左侧图标栏的导航入口与预期不一致（搜图 / 人物 与重复同级）',
  );

  // 结构断言通过后再校验整体标签闭合，避免级联噪声掩盖上面的精确定位
  assert.deepEqual(errors, [], 'index.html 存在未闭合或多余的标签：\n  ' + errors.join('\n  '));

  console.log('[layout-regression] PASS');
  console.log(
    '[layout-regression] 主布局顺序: ' +
      mainLayout.children.map((n) => n.attrs.id || '.' + n.attrs.class.split(' ')[0]).join(' > '),
  );
}

main();
