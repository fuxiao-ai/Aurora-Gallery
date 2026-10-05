#!/usr/bin/env node
'use strict';

/**
 * 「添加目录 → 媒体库列表刷新」契约回归（2026-10-05）。
 *
 * 背景（用户报「添加目录，媒体库列表未刷新」→「要在枚举完所有文件才刷新，是否不太对」）：
 *
 *   ① `src/scanner.js` 的 `db.addRootFolder(rootPath)` 过去写在 `await enumerateFiles(...)`
 *      **之后**。设置页「媒体库」列表的数据源就是 `root_folders` 表 —— 根不落库，列表里
 *      就不可能有这一行。枚举整棵目录树在大库上要跑很久（本机 `K:\COS` 3.1 万文件夹），
 *      于是用户点完「添加目录」得干等枚举跑完才看到新目录。
 *      实测（20000 个空目录的夹具，自带 Electron 无头 + CDP）：
 *        修复前 = 列表 +4969ms 才出现新行（≈ 枚举跑完那一刻）；
 *        修复后 = 新根 +0.3s 落库、列表 +0.9s 出现，而扫描要到 +4.1s 才结束。
 *
 *   ② `src/renderer/app.js#renderSettingsFolderList` 的第一道指纹短路拿
 *      `state.rootFolders`（**可能过时的内存缓存**）当判据，一旦它与上次渲染的指纹相同
 *      就直接 return —— 连「去库里拉一次」都省了。而 `loadRootFolders` 的 lite 分支是
 *      `if (liteList.length > 0)` 才写回 `state.rootFolders`，扫描刚开始读到空表就不写回。
 *      这条预判只允许留给 `skipFetch` 路径（调用方明确要求「用内存数据重画」）。
 *
 * 这两个点都是「改一行位置 / 加一个条件」就能静默退化的类型 —— 界面不报错、日志不吭声，
 * 只能靠真实时序探针看出来。所以在这里钉成静态断言：谁把它挪回去，谁就得红。
 */

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const SCANNER = 'src/scanner.js';
const APP = 'src/renderer/app.js';
const RUNNER = 'scripts/run-regressions.js';

let checks = 0;
const failures = [];
function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log('  ✓ ' + label);
  } else {
    console.log('  ✗ ' + label + (detail ? ' —— ' + detail : ''));
    failures.push(label);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function parse(src, rel) {
  try {
    return acorn.parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    throw new Error('解析失败 ' + rel + '：' + e.message, { cause: e });
  }
}

/**
 * 极简 AST 遍历（本仓库没装 acorn-walk，别再引新依赖）。
 * ⚠️ 剥注释必须走 acorn：`scanner.js` 里有 `/^found\.\d+$/` 这类正则字面量，
 * 状态机版剥注释会在那里错位（见 `dead-reference-regression.js:223` 的先例），
 * 于是「注释里提到的名字」会被当成结构判据 ⇒ 假红/假绿。本脚本不剥注释、
 * 直接按 AST 节点偏移切片，天然免疫这个坑。
 */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

function collect(ast, predicate) {
  const found = [];
  walk(ast, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function memberCallName(node) {
  if (!node || node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression' || !callee.property) return null;
  return callee.property.name || null;
}

// ══════════════════════════════════════════════ 1. scanner.js：根登记必须在枚举之前

console.log('[media-library-refresh-regression] 添加目录 → 媒体库列表刷新契约');
console.log('  · 目标：' + SCANNER + ' / ' + APP);

const scannerSrc = read(SCANNER);
const scannerAst = parse(scannerSrc, SCANNER);

const addRootCalls = collect(scannerAst, (n) => memberCallName(n) === 'addRootFolder');
const enumerateCalls = collect(scannerAst, (n) => memberCallName(n) === 'enumerateFiles');

check('scanner.js 里存在 db.addRootFolder 调用', addRootCalls.length > 0);
check('scanner.js 里存在 enumerateFiles 调用', enumerateCalls.length > 0);

if (addRootCalls.length && enumerateCalls.length) {
  // 真正的失败面就是「登记晚于枚举」：取最靠前的登记调用与最靠前的枚举调用比位置
  const addAt = Math.min(...addRootCalls.map((n) => n.start));
  const enumAt = Math.min(...enumerateCalls.map((n) => n.start));
  const lineOf = (offset) => scannerSrc.slice(0, offset).split('\n').length;

  check(
    '🔴 根目录登记（addRootFolder）在文件枚举（enumerateFiles）之前（登记晚一步 ⇒ 大库上用户要等整棵树枚举完才看到新目录）',
    addAt < enumAt,
    'addRootFolder 在 L' + lineOf(addAt) + '、enumerateFiles 在 L' + lineOf(enumAt),
  );

  // 回滚：包住 enumerateFiles 的那个 try，catch 里必须撤回刚登记的空根
  const enumCall = enumerateCalls.reduce((a, b) => (a.start <= b.start ? a : b));
  const guards = collect(scannerAst, (n) => {
    if (n.type !== 'TryStatement' || !n.handler) return false;
    return n.block.start <= enumCall.start && n.block.end >= enumCall.end;
  });
  const guard = guards.sort((a, b) => a.block.end - a.block.start - (b.block.end - b.block.start))[0];

  check('enumerateFiles 被 try 包住（枚举抛错时才有机会撤回登记）', !!guard);
  if (guard) {
    const removes = collect(guard.handler, (n) => memberCallName(n) === 'removeRootFolder');
    check(
      '枚举失败的 catch 分支里调用 removeRootFolder（否则媒体库列表会留一个 0 张的空壳根）',
      removes.length > 0,
    );
    // 只包枚举这一句：插入阶段失败不撤根（那会儿可能已写入部分照片，撤根会把它们一起删掉）
    const siblingAdds = collect(guard.block, (n) => memberCallName(n) === 'addRootFolder');
    check('addRootFolder 仍在 try 之外（插入阶段的失败不能触发撤根）', siblingAdds.length === 0);
  }
}

// ══════════════════════════════════════════════ 2. app.js：指纹预判只许给 skipFetch

const appSrc = read(APP);
const appAst = parse(appSrc, APP);

const renderFns = collect(
  appAst,
  (n) => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'renderSettingsFolderList',
);
check('app.js 里有 renderSettingsFolderList 函数声明', renderFns.length === 1);

if (renderFns.length === 1) {
  const fn = renderFns[0];
  const ifs = collect(fn, (n) => n.type === 'IfStatement');
  const fpIfs = ifs
    .filter((n) => appSrc.slice(n.test.start, n.test.end).indexOf('_settingsFolderListFp') >= 0)
    .sort((a, b) => a.start - b.start);

  check('renderSettingsFolderList 里有基于 _settingsFolderListFp 的短路判断', fpIfs.length >= 1);

  if (fpIfs.length) {
    const firstTest = appSrc.slice(fpIfs[0].test.start, fpIfs[0].test.end);
    const lineOf = (offset) => appSrc.slice(0, offset).split('\n').length;
    check(
      '🔴 第一道指纹短路只在 skipFetch 路径生效（拿可能过时的 state.rootFolders 给「去库里拉一次」的默认路径做闸门 ⇒ 库里已有新根、界面不更新）',
      firstTest.indexOf('skipFetch') >= 0,
      'L' + lineOf(fpIfs[0].test.start) + ' 的条件是：' + firstTest.replace(/\s+/g, ' ').slice(0, 90),
    );
    check(
      '默认路径（无 skipFetch）仍会在 fetch 之后比较指纹（保留「数据没变就不重画」的优化）',
      fpIfs.length >= 2,
    );
  }
}

// ══════════════════════════════════════════════ 3. 夹具自证 + 登记

const runSrc = read(RUNNER);
check('本守护已登记进 scripts/run-regressions.js', runSrc.includes("'media-library-refresh-regression.js'"));
check(
  '登记位置在末项 ai-lifecycle-regression 之前（末项约定不能破）',
  runSrc.indexOf("'media-library-refresh-regression.js'") > 0 &&
    runSrc.indexOf("'media-library-refresh-regression.js'") < runSrc.indexOf("'ai-lifecycle-regression.js'"),
);

// 探针/计数器自证：位置断言真的拿到了两处调用，而不是「都没找到所以没报错」
check(
  '夹具自证：位置断言实际比对了两个调用（不是空过）',
  addRootCalls.length > 0 && enumerateCalls.length > 0,
);

if (failures.length) {
  console.error('[media-library-refresh-regression] FAIL（' + failures.length + '/' + checks + ' 项）');
  process.exit(1);
}
console.log('[media-library-refresh-regression] PASS（' + checks + ' 项）');
