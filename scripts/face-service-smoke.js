'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { FaceService } = require('../src/main/face-service');
async function run() {
  if (!process.argv[2] || !process.argv[3])
    throw new Error('Provide models directory and public test image');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-face-service-'));
  let db, service;
  try {
    const root = path.join(directory, 'index');
    fs.mkdirSync(root);
    fs.symlinkSync(
      path.resolve(process.argv[2]),
      path.join(root, 'models'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const dbPath = path.join(directory, 'photos.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, file_type TEXT,
      file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    for (let i = 1; i <= 2; i++) {
      const target = path.join(directory, i + '.jpg');
      await sharp(path.resolve(process.argv[3]))
        .resize(i === 1 ? 512 : 400)
        .jpeg()
        .toFile(target);
      db.prepare('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, NULL, 512, 512, 0, 0)').run(
        i,
        target,
        i + '.jpg',
        'jpg',
        fs.statSync(target).size,
        '2026-09-27',
      );
    }
    service = new FaceService(dbPath, root);
    assert.equal((await service.refresh()).ready, true);
    await service.run('saveSettings', { grouping: 'strict', thumbnailFallback: false });
    const indexed = await service.run('index');
    assert.equal(indexed.faces, 2);
    assert.equal(indexed.people, 1);
    await service.run('settings');
    assert.equal(service.status().processed, 2, 'opening settings preserves index progress');
    assert.equal((await service.run('index')).processed, 0);
    const group = (await service.run('groups')).items[0];
    await service.run('rename', { personId: group.id, name: '测试人物' });
    assert.equal((await service.run('groups')).items[0].name, '测试人物');
    const photos = (await service.run('photos', { personId: group.id })).items;
    const moved = await service.run('move', { faceId: photos[0].faceId });
    assert.equal((await service.run('groups')).items.length, 2);
    await service.run('merge', { from: moved.personId, to: group.id });
    assert.equal((await service.run('photos', { personId: group.id })).items.length, 2);
    db.prepare('DELETE FROM photos WHERE id = 1').run();
    assert.equal((await service.run('photos', { personId: group.id })).items.length, 1);
    console.log(
      '[face-service-smoke] PASS: offline detection/grouping/incremental/naming/split/merge/deletion',
    );
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    const link = path.join(directory, 'index', 'models');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
