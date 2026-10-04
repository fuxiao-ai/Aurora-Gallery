'use strict';
/**
 * 侧栏目录树「深层懒渲染」回归。
 *
 * 背景：大库单根可达 3 万+ 目录，此前整棵树一次性写进 innerHTML（实测 11MB / 3.6 万个
 * DOM 节点），首屏与后续每次「读侧栏 HTML、查询侧栏节点」都要付这份代价。
 * 现在：只有「已展开层」进 DOM，深层子树留 `data-lazy-path` 空容器，首次展开时才物化。
 * 契约（本回归守护）：
 *   1. renderTreeNodes 对「有子级」的节点只输出空的懒容器，不递归渲染子层；
 *   2. 叶子节点仍直接输出可点击行；
 *   3. materializeLazyChildren 能按路径把子层物化，且重复调用不重复渲染；
 *   4. 无数据时不抛错（不静默把整棵树铺开）。
 *
 * 用 vm 加载真实源码驱动真实函数，而非文本 grep。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadSidebarTree() {
  const win = { I18n: { t: (key) => key } };
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const ctx = {
    window: win,
    document: doc,
    requestAnimationFrame: (cb) => cb(),
    setTimeout: () => 0,
    clearTimeout() {},
    CSS: { escape: (s) => String(s) },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer/sidebar-tree.js'), 'utf8'), ctx, {
    filename: 'renderer/sidebar-tree.js',
  });
  const api = win.RendererSidebarTree;
  assert.ok(api, 'sidebar-tree.js 应挂载 window.RendererSidebarTree');
  return api;
}

/** 与 escapeAttr（utils.js）一致：反斜杠换成正斜杠，单引号转义 */
function escapeAttrLike(str) {
  return String(str || '')
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'");
}

function makeOptions() {
  return {
    state: { currentView: 'all', currentPath: '' },
    escapeAttr: escapeAttrLike,
    escapeHtml: (v) => String(v == null ? '' : v),
    formatNumber: (v) => String(v || 0),
    rootId: 7,
  };
}

/** 简易可读写属性的容器，够 materializeLazyChildren 用 */
function makeContainer(attrs) {
  const store = Object.assign({}, attrs || {});
  return {
    innerHTML: '',
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setAttribute(k, v) {
      store[k] = String(v);
    },
    _attrs: store,
  };
}

function node(name, fullPath, photoCount, children) {
  const kids = children || [];
  return {
    name,
    fullPath,
    photoCount: photoCount || 0,
    children: kids,
    isLeaf: kids.length === 0,
  };
}

function buildSampleTree() {
  // root = K:\R
  //   L1: a（有子级）→ L2: b（有子级）→ L3: c（叶子）
  //   L1: d（叶子）
  const c = node('c', 'K:\\R\\a\\b\\c', 3);
  const b = node('b', 'K:\\R\\a\\b', 3, [c]);
  const a = node('a', 'K:\\R\\a', 3, [b]);
  const d = node('d', 'K:\\R\\d', 5);
  return [a, d];
}

function testLazyContract(api) {
  const tree = buildSampleTree();
  const opts = makeOptions();
  const out = api.renderTreeNodes(tree, 1, opts, null);

  // --- 1. 第一层照常输出可点击行 ---
  assert.ok(
    out.includes(`data-folder-path="${escapeAttrLike('K:\\R\\a')}"`),
    '第一层目录 a 应输出 data-folder-path 行',
  );
  assert.ok(
    out.includes(`data-folder-path="${escapeAttrLike('K:\\R\\d')}"`),
    '第一层叶子 d 应输出 data-folder-path 行',
  );

  // --- 2. 有子级的节点：只留空懒容器，路径写在 data-lazy-path 上 ---
  assert.ok(
    out.includes(`data-lazy-path="${escapeAttrLike('K:\\R\\a')}"`),
    '有子级的 a 应输出带 data-lazy-path 的懒容器',
  );
  assert.ok(
    out.includes(`data-lazy-root="7"`),
    '懒容器应带 data-lazy-root，供物化时定位所属根',
  );

  // --- 3. 未展开的深层绝对不能出现在本次渲染结果里（性能契约）---
  assert.equal(
    out.includes('data-folder-path="K:/R/a/b"'),
    false,
    '第二层 b 不得在本轮渲染中出现（深层必须懒渲染）',
  );
  assert.equal(
    out.includes('data-folder-path="K:/R/a/b/c"'),
    false,
    '第三层 c 不得在本轮渲染中出现（深层必须懒渲染）',
  );

  // --- 4. 叶子节点不应带懒容器 ---
  const leafChunk = out.slice(out.indexOf('data-folder-path="K:/R/d"'));
  assert.equal(
    /data-lazy-path/.test(leafChunk.slice(0, 400)),
    false,
    '叶子目录 d 之后不应紧跟懒容器',
  );

  // --- 5. 无子级的节点不会产出懒容器 ---
  const onlyLeaf = api.renderTreeNodes([node('x', 'K:\\R\\x', 1)], 1, opts, null);
  assert.equal(onlyLeaf.includes('data-lazy-path'), false, '纯叶子层不应产出懒容器');
  assert.ok(onlyLeaf.includes('data-folder-path="K:/R/x"'), '纯叶子层应输出目录行');

  // --- 6. 输出规模与「层数」无关：3 层只渲染 1 层 ---
  const paths = (out.match(/data-folder-path="/g) || []).length;
  assert.equal(paths, 2, `3 层树只应渲染第一层 2 个目录行，实际 ${paths}`);

  console.log('[sidebar-lazy-render-regression] 懒渲染契约 PASS');
}

function testMaterialize(api) {
  // 走一遍真实渲染流程：buildTree -> indexTree -> 写入侧栏，同时建立 lazyRenderOptions
  const sidebar = { innerHTML: '' };
  api.renderFolderTree({
    state: {
      currentTab: 'folders',
      currentView: 'all',
      currentPath: '',
      rootFolders: [{ id: 7, path: 'K:\\R', name: 'R', photo_count: 8, folder_count: 4 }],
      stats: {},
    },
    prefetchedByRootId: {
      7: [
        { folder_path: 'K:\\R\\a', photo_count: 3 },
        { folder_path: 'K:\\R\\a\\b', photo_count: 3 },
        { folder_path: 'K:\\R\\a\\b\\c', photo_count: 3 },
        { folder_path: 'K:\\R\\d', photo_count: 5 },
      ],
    },
    gate: null,
    sidebarContent: sidebar,
    formatNumber: (v) => String(v || 0),
    escapeAttr: escapeAttrLike,
    escapeHtml: (v) => String(v == null ? '' : v),
  });

  assert.ok(
    sidebar.innerHTML.includes(`data-lazy-path="${escapeAttrLike('K:\\R\\a')}"`),
    '整树渲染后，有子级的 a 应留懒容器',
  );
  assert.equal(
    sidebar.innerHTML.includes('data-folder-path="K:/R/a/b"'),
    false,
    '整树渲染阶段不得铺开第二层',
  );

  // 模拟 DOM：a 下的懒容器
  const container = makeContainer({
    'data-lazy-root': '7',
    'data-lazy-path': escapeAttrLike('K:\\R\\a'),
    'data-lazy-depth': '2',
  });

  const ok = api.materializeLazyChildren(container);
  assert.equal(ok, true, '物化应返回 true');
  assert.equal(container.getAttribute('data-lazy-ready'), '1', '物化后应标记 data-lazy-ready');
  assert.ok(
    container.innerHTML.includes(`data-folder-path="${escapeAttrLike('K:\\R\\a\\b')}"`),
    '物化后应出现子层目录 b 的行',
  );
  assert.ok(
    container.innerHTML.includes(`data-lazy-path="${escapeAttrLike('K:\\R\\a\\b')}"`),
    '子层里有子级的 b 自身也应保持懒容器（只展开一层）',
  );
  assert.equal(
    container.innerHTML.includes('data-folder-path="K:/R/a/b/c"'),
    false,
    '物化只应铺开一层，孙层仍需保持懒渲染',
  );

  // 重复调用不重复渲染
  const first = container.innerHTML;
  api.materializeLazyChildren(container);
  assert.equal(container.innerHTML, first, '重复物化不得改变已就绪的容器内容');

  // 空/未知路径不抛错，也不误渲染
  const unknown = makeContainer({
    'data-lazy-root': '7',
    'data-lazy-path': 'K:/R/does-not-exist',
    'data-lazy-depth': '2',
  });
  assert.equal(api.materializeLazyChildren(unknown), true, '未知路径应安全返回');
  assert.equal(unknown.innerHTML, '', '未知路径不应渲染出内容');

  // 没有懒标记的容器（例如根层已渲染）不该被处理
  const plain = makeContainer({});
  assert.equal(api.materializeLazyChildren(plain), false, '无 data-lazy-path 的容器不应被物化');

  console.log('[sidebar-lazy-render-regression] 按需物化 PASS');
}

function testSourceGuard() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/sidebar-tree.js'), 'utf8');
  assert.equal(
    /renderTreeNodes\(\s*node\.children,\s*depth \+ 1/.test(src),
    false,
    'renderTreeNodes 不得再递归渲染子层（会退回全量 DOM）',
  );
  assert.ok(
    /data-lazy-path/.test(src) && /function materializeLazyChildren/.test(src),
    '懒渲染机制应存在',
  );
  assert.ok(
    /function indexTree/.test(src),
    '存在 indexTree（按路径取子级的数据索引）',
  );
  console.log('[sidebar-lazy-render-regression] 源文本守护 PASS');
}

function main() {
  const api = loadSidebarTree();
  testLazyContract(api);
  testMaterialize(api);
  testSourceGuard();
  console.log('[sidebar-lazy-render-regression] PASS');
}

main();
