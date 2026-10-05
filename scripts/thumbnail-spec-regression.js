#!/usr/bin/env node
'use strict';

/**
 * 缩略图规格列（thumb_size / thumb_format）回归。
 *
 * 这两列是「缩略图换档 / 转 WebP」的前提：没有它们就无法回答
 * 「哪些图还是旧档位」「哪些还是 JPEG」，也就没法做增量迁移，只能整表硬跑。
 * 所以这里守三件事：
 *   1. 老库打开时能自动补上这两列，且**不动既有数据**；
 *   2. 写入路径如实记录规格 —— 拿不到规格时必须写回「未知」，不能沿用旧值；
 *   3. 所有 `updatePhotoThumbnail` 调用点都传了 spec（机械比对，防漏改）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const PhotoDatabase = require('../src/database');

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

function run() {
  checkLegacyMigration();
  checkWritePath();
  checkAllCallSitesPassSpec();
  console.log('[thumbnail-spec] PASS (' + checks + ' checks)');
}

run();
