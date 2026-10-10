'use strict';
/**
 * 统计「照片数」口径一致性回归。
 *
 * 背景（2026-10-07，用户实测）：顶栏显示 **1,656,580 张照片**，首页显示
 * **1,629,971 张照片 + 26,609 个视频** —— 两个数差得恰好是视频数。
 *
 * 根因不是谁算错了，而是**口径没共用一份**：
 *   - `getStats()` 的 `totalPhotos` 是 `COUNT(*) FROM photos`，**含视频行**；
 *   - 首页 `renderHomeStats` 做了 `total - videos`；
 *   - 顶栏 `formatGlobalStatsBarText` 直接把 `totalPhotos` 标成「张照片」。
 * 同一份 `state.stats`，两处各解释一遍，于是界面上出现两个「照片数」。
 *
 * 本脚本守住三层：
 *
 *   1. 🔴 **后端守恒**（真夹具 + 真 SQL）：`totalPhotos === 照片 + 视频` 恒成立，
 *      且 `videoPhotos <= totalPhotos` —— 减法不会减出负数、也不会把视频漏在照片里。
 *   2. 🔴 **桌面端三处必须走同一个函数** `stillPhotoCount`（顶栏全档 / 顶栏仅照片档 /
 *      文件夹作用域 / 首页统计带），并且**不许**再有任何一处把 `totalPhotos`、
 *      `total`、`st` 直接塞进「照片」位。这一条用 acorn 剥 AST 后判（不读注释 ——
 *      注释里写再多"已修复"都不算数，元规则 ③）。
 *   3. 🔴 **网页端要跟着改**：`src/web/js/app.js` 是**另一份实现**（没有共享模块），
 *      `compactLibraryStats` / `compactFolderStats` 必须各自做减法。
 *
 * ⚠️ 必须用 Electron 运行时跑（`npm test`，或 `ELECTRON_RUN_AS_NODE=1 electron scripts/…`）。
 *    本脚本直接 require 了 better-sqlite3 造夹具库，系统 node 的 ABI 对不上。
 *
 * ⚠️ 最后一条自检：本脚本必须出现在 `run-regressions.js` 的清单里 ——
 *    没被跑起来的守护等于没有守护（假绿）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER_APP = 'src/renderer/app.js';
const WEB_APP = 'src/web/js/app.js';
const DB_HEAVY_READ = 'src/db-heavy-read.js';
const RUN_REGRESSIONS = 'scripts/run-regressions.js';
const SELF = 'stats-count-parity-regression.js';

/** 桌面端三处 + 首页，共四处消费点。 */
const SHARED_FN = 'stillPhotoCount';
const DESKTOP_CONSUMERS = [
  { fn: 'renderHomeStats', minCalls: 1 },
  { fn: 'formatGlobalStatsBarText', minCalls: 2 }, // 全档 + 仅照片档
  { fn: 'formatFolderScopedStatsBarText', minCalls: 1 },
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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------- 第 1 层：后端守恒

function makeFixture() {
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-stats-parity-'));
  const file = path.join(dir, 'fixture.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE root_folders (
      id INTEGER PRIMARY KEY,
      path TEXT
    );
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      file_path TEXT UNIQUE NOT NULL,
      file_name TEXT,
      folder_path TEXT,
      file_type TEXT,
      file_size INTEGER,
      is_favorite INTEGER DEFAULT 0,
      date_taken TEXT
    );
  `);
  const ins = db.prepare(
    'INSERT INTO photos (id, file_path, file_name, folder_path, file_type, file_size, is_favorite, date_taken) VALUES (?,?,?,?,?,?,0,?)',
  );
  let id = 0;
  const put = function (name, type) {
    id += 1;
    ins.run(id, 'K:\\COS\\' + name, name, 'K:\\COS', type, 1024, '2026-01-01');
  };
  // 7 张图片 + 1 个未知扩展名 + 1 个 file_type 为 NULL（真实库里两者都存在）
  for (let i = 0; i < 7; i += 1) put('p' + i + '.jpg', '.jpg');
  put('weird.xyz', '.xyz');
  put('unknown.bin', null);
  // 3 个视频（含 Live Photo 伴生 MOV 的形态）
  put('v1.mp4', '.mp4');
  put('v2.mov', '.MOV');
  put('v3.mkv', '.mkv');
  // 1 张 Live Photo 静照：有伴生视频但自己仍是照片行
  put('live.heic', '.heic');
  return { db: db, dir: dir, photos: 7 + 1 + 1 + 1, videos: 3 };
}

function checkBackendParity() {
  let heavy;
  let fixture;
  try {
    heavy = require(path.join(ROOT, DB_HEAVY_READ));
    fixture = makeFixture();
    const stats = heavy.runGetStatsAgg(fixture.db);
    const total = Number(stats.totalPhotos) || 0;
    const videos = Number(stats.videoPhotos) || 0;
    const still = Math.max(0, total - videos);
    check(
      '后端：照片 + 视频 === totalPhotos（守恒，减法不会丢数）',
      still + videos === total,
      '照片=' + still + ' 视频=' + videos + ' total=' + total,
    );
    check(
      '后端：videoPhotos <= totalPhotos（不会减出负数）',
      videos <= total,
      '视频=' + videos + ' total=' + total,
    );
    // 与「按谓词逐行分类」对账：未知扩展名与 file_type 为 NULL 的行归照片，不是视频。
    check(
      '后端：减法结果与逐行分类一致（未知扩展名 / NULL 归照片）',
      total === fixture.photos + fixture.videos && videos === fixture.videos,
      '期望 total=' + (fixture.photos + fixture.videos) + ' 视频=' + fixture.videos,
    );
  } catch (err) {
    check('后端夹具可跑', false, String(err && err.message ? err.message : err));
  } finally {
    if (fixture) {
      try {
        fixture.db.close();
      } catch (_) {
        /* 关不掉不影响判定 */
      }
      try {
        fs.rmSync(fixture.dir, { recursive: true, force: true });
      } catch (_) {
        /* 临时目录清不掉不影响判定 */
      }
    }
  }
}

// ---------------------------------------------------------------- 第 2 层：桌面端结构

function collectFunctions(node, out) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'FunctionDeclaration' && node.id && node.id.name) out[node.id.name] = node;
  if (node.type === 'VariableDeclarator' && node.id && node.id.name && node.init) {
    if (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression') {
      out[node.id.name] = node.init;
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') collectFunctions(child, out);
      }
    } else if (value && typeof value.type === 'string') {
      collectFunctions(value, out);
    }
  }
  return out;
}

function countNodes(node, predicate) {
  let n = 0;
  if (!node || typeof node.type !== 'string') return 0;
  if (predicate(node)) n += 1;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') n += countNodes(child, predicate);
      }
    } else if (value && typeof value.type === 'string') {
      n += countNodes(value, predicate);
    }
  }
  return n;
}

const isCallTo = (name) => (node) =>
  node.type === 'CallExpression' &&
  node.callee &&
  node.callee.type === 'Identifier' &&
  node.callee.name === name;

function findReturns(node, out) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'ReturnStatement') out.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') findReturns(child, out);
      }
    } else if (value && typeof value.type === 'string') {
      findReturns(value, out);
    }
  }
  return out;
}

function collectVarInits(node, out) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'VariableDeclarator' && node.id && node.id.name && node.init) {
    out[node.id.name] = node.init;
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') collectVarInits(child, out);
      }
    } else if (value && typeof value.type === 'string') {
      collectVarInits(value, out);
    }
  }
  return out;
}

/** `setHomeStatValue(dom.homeStatPhotos, <expr>)` —— 首页统计带的「照片」那一格。 */
function findHomePhotosSetter(node, out) {
  if (!node || typeof node.type !== 'string') return out;
  if (
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'setHomeStatValue'
  ) {
    const first = node.arguments && node.arguments[0];
    if (
      first &&
      first.type === 'MemberExpression' &&
      first.property &&
      first.property.name === 'homeStatPhotos'
    ) {
      out.push(node);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') findHomePhotosSetter(child, out);
      }
    } else if (value && typeof value.type === 'string') {
      findHomePhotosSetter(value, out);
    }
  }
  return out;
}

/** `return tUiFmt(key, { photos: <expr>, … }, …)` → `{ key, expr }`（key 是模板名）。 */
function photoPropOfReturn(ret) {
  const call = ret && ret.argument;
  if (!call || call.type !== 'CallExpression' || !call.arguments) return null;
  let obj = null;
  let key = null;
  for (const arg of call.arguments) {
    if (arg && arg.type === 'Literal') key = arg.value;
    if (arg && arg.type === 'ObjectExpression') obj = arg;
  }
  if (!obj) return null;
  for (const prop of obj.properties) {
    if (!prop || !prop.key) continue;
    const name = prop.key.name != null ? prop.key.name : prop.key.value;
    if (name === 'photos') return { key: key, expr: prop.value };
  }
  return null;
}

/**
 * 合法的「不减」例外，逐个写明理由 —— 有理有据才放行，不放宽成一句「image 档都行」。
 *
 * 文件夹作用域 `image` 档：`scopedTotal` 来自 `database.js#getPhotosByFolder`，
 * 那条 SQL 在 `mediaType='image'` 时已经带上了 image 谓词（同函数里 `videoCount`
  * 那条也带同一个 `whereSql`），所以 `st` **本身**就是照片数、`vc` 恒为 0 —— 再减一次
 * 反而是错的。全局顶栏的 `image` 档不适用（它的 `totalPhotos` 是全库 COUNT(*)）。
 */
const RAW_TOTAL_EXCEPTIONS = [
  { fn: 'formatFolderScopedStatsBarText', key: 'stats.barFolderImageFmt' },
];

/**
 * 表达式是否**最终来自**真相源：直接调用算，先存进中间变量再传也算
 * （`var fullCount = stillPhotoCount(...)`），其它一律不算 —— 这就是本次 bug 的形状：
 * 直接把 `stats.totalPhotos` / `total` / `st`（含视频的 COUNT(*)）塞进照片位。
 */
function resolvesToShared(node, inits) {
  if (!node) return false;
  if (node.type === 'CallExpression') {
    if (node.callee && node.callee.type === 'Identifier' && node.callee.name === SHARED_FN) {
      return true;
    }
    // 外面还包了一层 `formatNumber(...)` —— 往下找一层。
    for (const arg of node.arguments || []) {
      if (resolvesToShared(arg, inits)) return true;
    }
    return false;
  }
  if (node.type === 'Identifier' && inits[node.name]) {
    return resolvesToShared(inits[node.name], inits);
  }
  // 三元（`loaded ? … : ''`）也要穿透，否则正确的写法会被判成没走真相源。
  if (node.type === 'ConditionalExpression') {
    return (
      resolvesToShared(node.consequent, inits) || resolvesToShared(node.alternate, inits)
    );
  }
  return false;
}

function checkDesktop() {
  const acorn = require('acorn');
  const src = read(RENDERER_APP);
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (err) {
    check('src/renderer/app.js 可解析', false, String(err && err.message ? err.message : err));
    return;
  }
  const fns = collectFunctions(ast, Object.create(null));

  // 真相源函数本身：必须存在，且是「减」不是恒等返回。
  const shared = fns[SHARED_FN];
  if (!shared) {
    check('真相源 stillPhotoCount 存在', false, 'src/renderer/app.js 里找不到 ' + SHARED_FN);
    return;
  }
  const minusCount = countNodes(
    shared.body,
    (node) => node.type === 'BinaryExpression' && node.operator === '-',
  );
  check('真相源 stillPhotoCount 做的是减法（不是恒等返回）', minusCount >= 1, '- 出现 ' + minusCount + ' 次');

  for (const item of DESKTOP_CONSUMERS) {
    const fn = fns[item.fn];
    if (!fn) {
      check('消费点存在：' + item.fn, false, '解析不到该函数');
      continue;
    }
    const calls = countNodes(fn.body, isCallTo(SHARED_FN));
    check(
      item.fn + ' 走真相源 ' + SHARED_FN + '（≥' + item.minCalls + ' 处）',
      calls >= item.minCalls,
      '实际 ' + calls + ' 处',
    );
    // 每个 `return` 里只要带了 photos，就必须溯源到真相源（中间变量也算）。
    const inits = collectVarInits(fn.body, Object.create(null));
    const rets = findReturns(fn.body, []);
    const bad = [];
    let checked = 0;
    for (const ret of rets) {
      const prop = photoPropOfReturn(ret);
      if (!prop) continue; // 该 return 不涉及照片数（例如「仅视频」档）
      checked += 1;
      const allowed = RAW_TOTAL_EXCEPTIONS.some(
        (rule) => rule.fn === item.fn && rule.key === prop.key,
      );
      if (allowed) continue;
      if (!resolvesToShared(prop.expr, inits)) {
        bad.push(src.slice(prop.expr.start, prop.expr.end));
      }
    }
    if (checked > 0) {
      check(
        item.fn + ' 的「照片」位全部来自真相源（' + checked + ' 处 return）',
        bad.length === 0,
        bad.length ? '未扣视频：' + bad.join(', ') : '',
      );
    } else {
      // 没有 return 形态（例如 renderHomeStats 是直接写 DOM 的）：退一步判
      // 「照片那一格」的实参里必须含真相源调用，避免只数全函数而放过一个没改的格子。
      const setter = findHomePhotosSetter(fn.body, []);
      const expr = setter.length ? setter[0].arguments[1] : null;
      check(
        item.fn + ' 写照片格时用了真相源',
        !!expr && countNodes(expr, isCallTo(SHARED_FN)) >= 1,
        setter.length ? '照片格实参未走 ' + SHARED_FN : '找不到写 homeStatPhotos 的调用',
      );
    }
  }

  // 进入首页要还原顶栏（文件夹作用域会把顶栏改写成局部计数）
  const openHome = fns['openHomePage'];
  if (openHome) {
    const body = src.slice(openHome.body.start, openHome.body.end);
    check(
      'openHomePage 回首页时还原顶栏为全局统计',
      /formatGlobalStatsBarText/.test(body),
      '顶栏会残留文件夹的局部计数',
    );
  } else {
    check('openHomePage 存在', false);
  }
}

// ---------------------------------------------------------------- 第 3 层：网页端

function checkWeb() {
  const acorn = require('acorn');
  const src = read(WEB_APP);
  let ast;
  try {
    ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
  } catch (err) {
    check('src/web/js/app.js 可解析', false, String(err && err.message ? err.message : err));
    return;
  }
  const fns = collectFunctions(ast, Object.create(null));
  const targets = [
    { fn: 'compactLibraryStats', what: '全库统计' },
    { fn: 'compactFolderStats', what: '文件夹统计' },
  ];
  for (const item of targets) {
    const fn = fns[item.fn];
    if (!fn) {
      check('网页端 ' + item.what + ' 函数存在：' + item.fn, false);
      continue;
    }
    const body = src.slice(fn.body.start, fn.body.end);
    const hasSubtract = /Math\.max\(\s*0\s*,\s*[^)]*-\s*(?:videos|videoCount)\s*\)/.test(body);
    check(
      '网页端 ' + item.what + ' 扣掉了视频（' + item.fn + '）',
      hasSubtract,
      '网页端是另一份实现，桌面端改了这里必须跟着改',
    );
  }
}

// ---------------------------------------------------------------- 自检：守护要被跑

function checkRegistered() {
  const list = read(RUN_REGRESSIONS);
  check('本守护已注册进 scripts/run-regressions.js', list.includes("'" + SELF + "'"));
}

checkBackendParity();
checkDesktop();
checkWeb();
checkRegistered();

console.log('stats-count-parity-regression:');
for (const line of notes) console.log(line);
if (errors.length) {
  for (const line of errors) console.error(line);
  console.error('FAIL: ' + errors.length + ' 项');
  process.exit(1);
}
console.log('  OK — 顶栏 / 首页 / 文件夹作用域的照片数同口径');
