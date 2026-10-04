'use strict';
// 时序回归：索引 worker 持有写事务期间，人物页的并发只读查询必须仍然可用。
// 这是「索引进行中实时显示已识别人物」的底层前提——写锁由 writer 连接持有，
// reader 连接此时打开（journal_mode / 建表语句会争锁）+ 查询都不得抛 SQLITE_BUSY。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { FaceStore } = require('../src/ai/face-store');
const { VERSION } = require('../src/ai/face-model');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-face-concurrency-'));
const dbPath = path.join(directory, 'photos.db');
const indexPath = path.join(directory, 'faces.sqlite');
let writer, reader;
try {
  const seed = new Database(dbPath);
  seed.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT,
    file_size INTEGER, date_modified TEXT, thumbnail BLOB);
    INSERT INTO photos VALUES (1, 'a.jpg', 'a.jpg', 1, '', NULL);`);
  seed.close();
  writer = new FaceStore(dbPath, indexPath);
  const person = Number(writer.db.prepare('INSERT INTO people DEFAULT VALUES').run().lastInsertRowid);
  writer.db.prepare('INSERT INTO scans VALUES (?,?,?,?,?)').run(1, 'a.jpg', 1, '', VERSION);
  writer.db
    .prepare('INSERT INTO faces(photo_id, person_id, vector, thumbnail, box) VALUES (?,?,?,?,?)')
    .run(1, person, Buffer.alloc(4), Buffer.from('x'), '[]');
  writer.db.prepare('BEGIN IMMEDIATE').run();
  reader = new FaceStore(dbPath, indexPath);
  assert.equal(reader.peopleCount(), 1, '写事务持锁期间仍可并发读取人物数');
  assert.equal(reader.groups().items.length, 1, '写事务持锁期间仍可并发读取人物分组');
  writer.db.prepare('COMMIT').run();
  console.log('[face-concurrency-regression] PASS');
} finally {
  if (reader) reader.close();
  if (writer) writer.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
