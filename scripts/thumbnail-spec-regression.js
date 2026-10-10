#!/usr/bin/env node
'use strict';

/**
 * 缩略图规格列（thumb_size / thumb_format）回归。
 *
 * 这两列是「缩略图换档 / 转 WebP」的前提：没有它们就无法回答
 * 「哪些图还是旧档位」「哪些还是 JPEG」，也就没法做增量迁移，只能整表硬跑。
 * 所以这里守四件事：
 *   1. 老库打开时能自动补上这两列，且**不动既有数据**；
 *   2. 写入路径如实记录规格 —— 拿不到规格时必须写回「未知」，不能沿用旧值；
 *   3. 所有 `updatePhotoThumbnail` 调用点都传了 spec（机械比对，防漏改）；
 *   4. 服务端的 `Content-Type` 由 `thumb_format` **派生**，不许硬编码 `image/jpeg`
 *      （第 4 组；2026-10-07 补 —— 之前那 6 处是写死的，库里出现 WebP 行就等于
 *      把「字节 WebP / 头 JPEG」发出去，浏览器不报错、只是不解码）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');
const Database = require('better-sqlite3');

const PhotoDatabase = require('../src/database');
const thumbFormat = require('../src/main/thumb-format');

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function tempPath(tag) {
  return path.join(os.tmpdir(), `aurora-thumb-spec-${tag}-${Date.now()}-${Math.random()}.db`);
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    } catch (e) {}
  }
}

/** 造一个「本列引入之前」的库：photos 表刻意不带 thumb_size / thumb_format。 */
function createLegacyDb(dbPath) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE root_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_id INTEGER NOT NULL,
      folder_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT UNIQUE NOT NULL,
      file_size INTEGER DEFAULT 0,
      file_type TEXT DEFAULT '',
      width INTEGER DEFAULT 0,
      height INTEGER DEFAULT 0,
      date_taken TEXT,
      date_modified TEXT,
      thumbnail BLOB,
      has_thumbnail INTEGER DEFAULT 0
    );
  `);
  raw.prepare('INSERT INTO root_folders (id, path, name) VALUES (1, ?, ?)').run(
    'C:\\legacy\\root',
    'root',
  );
  raw
    .prepare(
      `INSERT INTO photos (id, root_id, folder_path, file_name, file_path, file_size,
        file_type, width, height, date_taken, date_modified, thumbnail, has_thumbnail)
       VALUES (1, 1, ?, ?, ?, 123, 'jpg', 0, 0, ?, ?, ?, 1)`,
    )
    .run(
      'C:\\legacy\\root\\a',
      'a.jpg',
      'C:\\legacy\\root\\a\\a.jpg',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00',
      Buffer.from([0xff, 0xd8, 0xff]),
    );
  raw.close();
}

function specOf(db, photoId) {
  return db.db
    .prepare('SELECT thumb_size AS size, thumb_format AS format FROM photos WHERE id = ?')
    .get(photoId);
}

function makePhoto(rootId, fileName, thumbnail, thumbSize, thumbFormat) {
  const folder = 'C:\\spec\\root\\f';
  return {
    rootId,
    folderPath: folder,
    fileName,
    filePath: path.join(folder, fileName),
    fileSize: 10,
    fileType: 'jpg',
    width: 100,
    height: 100,
    dateTaken: '2026-01-01T00:00:00',
    dateModified: '2026-01-01T00:00:00',
    thumbnail,
    hasThumbnail: thumbnail ? 1 : 0,
    thumbSize,
    thumbFormat,
  };
}

// ---- 1. 老库自动补列，且不动既有数据 -------------------------------------
function checkLegacyMigration() {
  const dbPath = tempPath('legacy');
  createLegacyDb(dbPath);
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);

    assert(db.hasPhotosColumn('thumb_size'), '老库打开后应补上 thumb_size');
    assert(db.hasPhotosColumn('thumb_format'), '老库打开后应补上 thumb_format');

    const legacy = specOf(db, 1);
    assert(legacy && legacy.size === 0, '老行规格应为 0（未知），不得被回填成任何档位');
    assert(legacy && legacy.format === '', '老行格式应为空串（未知）');

    const keep = db.db.prepare('SELECT file_name, has_thumbnail FROM photos WHERE id = 1').get();
    assert(keep && keep.file_name === 'a.jpg', '迁移不得动既有行');
    assert(keep && keep.has_thumbnail === 1, '迁移不得改动 has_thumbnail');

    // 幂等：再开一次不应报错、也不应重复加列
    db.close();
    db = new PhotoDatabase(dbPath);
    assert(db.hasPhotosColumn('thumb_size'), '重复打开应保持幂等');

    console.log('[thumbnail-spec] legacy migration ok');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    cleanup(dbPath);
  }
}

// ---- 2. 写入路径如实记录规格 ---------------------------------------------
function checkWritePath() {
  const dbPath = tempPath('write');
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    const rootId = db.addRootFolder('C:\\spec\\root');
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

    db.insertPhoto(makePhoto(rootId, 'a.jpg', buf, 1024, 'jpeg'));
    const inserted = specOf(db, 1);
    assert(inserted.size === 1024 && inserted.format === 'jpeg', 'insertPhoto 应记录传入规格');

    // 没生成缩略图时，传进来的档位不该被记录
    db.insertPhoto(makePhoto(rootId, 'b.jpg', null, 1024, 'jpeg'));
    const noThumb = specOf(db, 2);
    assert(noThumb.size === 0 && noThumb.format === '', '无缩略图的行规格必须是未知');

    db.insertPhoto(makePhoto(rootId, 'c.jpg', buf, 256, 'jpeg'));

    // updatePhotoThumbnail：正常写入
    db.updatePhotoThumbnail(1, buf, { size: 512, format: 'jpeg' });
    const updated = specOf(db, 1);
    assert(updated.size === 512 && updated.format === 'jpeg', 'updatePhotoThumbnail 应记录规格');

    // 🔴 关键：不传 spec 时必须清成未知，绝不能沿用上一次的 512
    db.updatePhotoThumbnail(1, buf);
    const cleared = specOf(db, 1);
    assert(cleared.size === 0, '不传 spec 时必须写回 0，不得沿用旧档位');
    assert(cleared.format === '', '不传 spec 时必须写回空串，不得沿用旧格式');

    // 白名单：大小写要归一化，非缩略图编码格式要拒成未知
    db.updatePhotoThumbnail(1, buf, { size: 1024, format: 'webP' });
    assert(specOf(db, 1).format === 'webp', '大小写混写的格式应被归一化为小写');
    db.updatePhotoThumbnail(1, buf, { size: 1024, format: 'png' });
    assert(specOf(db, 1).format === '', '非缩略图编码格式应被拒绝，防止迁移判据失效');
    // WebP 是白名单内的合法值（为后续迁移预留）
    db.updatePhotoThumbnail(1, buf, { size: 1024, format: 'webp' });
    assert(specOf(db, 1).format === 'webp', 'webp 应被接受（后续迁移要用）');

    // 统计与待迁移计数
    db.updatePhotoThumbnail(1, buf, { size: 1024, format: 'webp' });
    db.updatePhotoThumbnail(2, buf, { size: 256, format: 'jpeg' });
    db.updatePhotoThumbnail(3, buf, { size: 256, format: 'jpeg' });
    const stats = db.getThumbnailSpecStats();
    const map = new Map(stats.map((s) => [`${s.size}/${s.format || '(空)'}`, s.n]));
    assert(map.get('1024/webp') === 1, '统计应能分辨 1024/webp');
    assert(map.get('256/jpeg') === 2, '统计应能分辨 256/jpeg');

    const needWebp = db.countThumbnailsNeedingRegen(1024, 'webp');
    assert(needWebp === 2, '待转 WebP 计数应为 2（两张 256/jpeg），实得 ' + needWebp);
    const need1024Jpeg = db.countThumbnailsNeedingRegen(1024, 'jpeg');
    assert(need1024Jpeg === 3, '待转 1024/jpeg 计数应为 3，实得 ' + need1024Jpeg);

    console.log('[thumbnail-spec] write path ok');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    cleanup(dbPath);
  }
}

// ---- 3. 机械比对：所有写入点都得传 spec -----------------------------------
function checkAllCallSitesPassSpec() {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(root);

  const callRe = /\.updatePhotoThumbnail\(([\s\S]{0,240}?)\)\s*;/g;
  let total = 0;
  const missing = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = callRe.exec(text)) !== null) {
      total += 1;
      if (!/format\s*:/.test(m[1])) {
        const line = text.slice(0, m.index).split('\n').length;
        missing.push(path.relative(path.join(__dirname, '..'), file) + ':' + line);
      }
    }
  }
  // 下限而不是等值：新增调用点时必须重新看一遍这条断言（它就是在提醒你补 `format:`）。
  // 6 → 5（2026-10-05，T6）：原第 6 处是孤儿副本 `src/main/thumbnail-backfill.js` 里的，
  // 那个文件从不被 require，已于 T6 删除。现行活调用点 = main.js 两处 + web-server.js 三处。
  assert(total >= 5, '应至少找到 5 个 updatePhotoThumbnail 调用点，实得 ' + total);
  assert(
    missing.length === 0,
    '这些调用点没有传缩略图规格（会导致规格被清成未知）: ' + missing.join(', '),
  );

  // 标记修复：把 has_thumbnail 置 0 时必须一并清规格
  const fixWorker = fs.readFileSync(
    path.join(root, 'workers', 'thumbnail-fix-worker.js'),
    'utf8',
  );
  assert(
    /thumb_size\s*=\s*0/.test(fixWorker) && /SET has_thumbnail = 0/.test(fixWorker),
    '标记修复必须同时清掉 thumb_size（没有 BLOB 的行不该留着档位）',
  );

  console.log('[thumbnail-spec] call sites ok (' + total + ' 处)');
}

// ---- 4. 服务端 Content-Type 必须按 thumb_format 派生（禁硬编码 image/jpeg） ----
//
// 为什么值得一条独立守护：这是**只有真出一张异格式图才会暴露**的那类失效。
// 字节换成 WebP 而响应头写着 `image/jpeg` 时，浏览器不抛错、不进 console，
// 只是不解码 —— 表现是「格子空白 / 预览一片白」，排查方向会被带偏到文件损坏上。
function checkServingMimeDerived() {
  // 4a. 格式表本身的自洽：白名单里每一项都必须有**显式** MIME
  //     （漏一项的后果不是报错，而是那一项静默回落成 image/jpeg）
  for (const format of thumbFormat.THUMB_FORMAT_WHITELIST) {
    assert(
      !!thumbFormat.THUMB_FORMAT_MIME[format],
      '白名单项 ' + format + ' 缺 MIME 映射（会静默回落成 ' + thumbFormat.THUMB_MIME_FALLBACK + '）',
    );
  }
  assert(
    thumbFormat.thumbMimeType('webp') === 'image/webp',
    'webp 必须映射到 image/webp，实得 ' + thumbFormat.thumbMimeType('webp'),
  );
  assert(
    thumbFormat.thumbMimeType('webP') === 'image/webp',
    '大小写混写的格式也要能取到 MIME（写入端归一化，读端同样不许挑食）',
  );
  // 未知 / 非法一律回落 JPEG：'' 的语义是「本列引入之前的存量行」，真库实测全是 JPEG。
  // 回落到别的东西 = 把存量行全部标错。
  for (const dirty of ['', null, undefined, 'png', 0, 'jpeg; charset=utf-8']) {
    assert(
      thumbFormat.thumbMimeType(dirty) === 'image/jpeg',
      '未知/非法格式 ' + JSON.stringify(dirty) + ' 必须回落 image/jpeg',
    );
  }
  console.log('[thumbnail-spec] mime table ok');

  // 4b. 两条取数路径都必须把格式**带出来**
  //     （字段在传播链上被 SELECT 列清单丢掉，是这类失效最原始的形态）
  const dbPath = tempPath('serve');
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    const rootId = db.addRootFolder('C:\\spec\\serve');
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    db.insertPhoto(makePhoto(rootId, 'a.jpg', buf, 256, 'jpeg'));
    db.insertPhoto(makePhoto(rootId, 'b.jpg', buf, 256, 'webp'));

    const asJpeg = db.getThumbnail(1);
    assert(asJpeg && asJpeg.thumbnail, 'getThumbnail 应能取出 BLOB');
    assert(asJpeg.format === 'jpeg', 'getThumbnail 必须带出 jpeg 行的格式，实得 ' + asJpeg.format);
    const asWebp = db.getThumbnail(2);
    assert(
      asWebp && asWebp.format === 'webp',
      'getThumbnail 必须带出 webp 行的格式（服务端唯一的格式来源），实得 ' +
        (asWebp && asWebp.format),
    );
    assert(
      thumbFormat.thumbMimeType(asWebp.format) === 'image/webp',
      'webp 行经 thumbMimeType 必须得到 image/webp',
    );
    console.log('[thumbnail-spec] getThumbnail carries format');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    cleanup(dbPath);
  }

  // 4c. 两个 thumb 处理器的响应头必须是**表达式**，不许出现 image/jpeg 字面量。
  //     走 acorn 取真实节点（见 face-order-regression 的先例）：正则按行扫会读到注释里
  //     引用的旧写法，那正是本项目踩过的坑。
  const mainSrc = path.join(__dirname, '..', 'src', 'main.js');
  const webSrc = path.join(__dirname, '..', 'src', 'web-server.js');

  /** 主进程：`protocol.handle('thumb', async function (request) { … })` 的回调体。 */
  function mainThumbHandlerBody() {
    const src = fs.readFileSync(mainSrc, 'utf8');
    const ast = parse(src, mainSrc);
    let found = null;
    walk(ast, (node) => {
      if (found) return;
      if (node.type !== 'CallExpression') return;
      const callee = node.callee;
      if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
      if (!callee.property || callee.property.name !== 'handle') return;
      if (!callee.object || callee.object.name !== 'protocol') return;
      const first = node.arguments && node.arguments[0];
      if (!first || first.value !== 'thumb') return;
      const handler = node.arguments[1];
      if (handler && handler.type === 'FunctionExpression') {
        found = src.slice(handler.start, handler.end);
      }
    });
    return found;
  }

  /** 网页端：`WebServer.prototype.handleThumb = function (res, idStr) { … }` 的函数体。 */
  function webThumbHandlerBody() {
    const src = fs.readFileSync(webSrc, 'utf8');
    const ast = parse(src, webSrc);
    let found = null;
    walk(ast, (node) => {
      if (found) return;
      if (node.type !== 'AssignmentExpression') return;
      const left = node.left;
      if (!left || left.type !== 'MemberExpression' || left.computed) return;
      if (!left.property || left.property.name !== 'handleThumb') return;
      if (node.right && node.right.type === 'FunctionExpression') {
        found = src.slice(node.right.start, node.right.end);
      }
    });
    return found;
  }

  const handlers = [
    { label: 'src/main.js protocol.handle(thumb)', body: mainThumbHandlerBody() },
    { label: 'src/web-server.js handleThumb', body: webThumbHandlerBody() },
  ];
  for (const h of handlers) {
    // 夹具自证：取到的是**处理器本体**而不是空串（不然下面两条断言恒真 = 假绿）
    assert(h.body && h.body.length > 200, '夹具自证：没取到 ' + h.label + ' 的函数体');
    assert(
      h.body.indexOf('Content-Type') >= 0,
      '夹具自证：' + h.label + ' 体内应含响应头写入，实际取到的可能不是处理器',
    );
    assert(
      h.body.indexOf("'image/jpeg'") < 0 && h.body.indexOf('"image/jpeg"') < 0,
      h.label + ' 里出现了硬编码的 image/jpeg —— 响应头必须由 thumbMimeType() 派生',
    );
    assert(
      h.body.indexOf('thumbMimeType(') >= 0,
      h.label + ' 的响应头没有走 thumbMimeType()（唯一真相源入口）',
    );
  }
  console.log('[thumbnail-spec] serving mime derived ok');

  console.log('[thumbnail-spec] serve path ok');
}

/** acorn 解析（先按 script，失败再按 module —— main.js 是 CJS，但别让一条 import 把守护打瞎）。 */
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

/** 通用 AST 遍历：只认 `type` 字段的节点，够用且不引依赖。 */
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

function run() {
  checkLegacyMigration();
  checkWritePath();
  checkAllCallSitesPassSpec();
  checkServingMimeDerived();
  console.log('[thumbnail-spec] PASS (' + checks + ' checks)');
}

run();
