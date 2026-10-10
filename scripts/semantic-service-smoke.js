'use strict';
// Run in Electron's Node mode; requires the opt-in model smoke cache and public image fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { SemanticSearch } = require('../src/main/semantic-search');

async function run() {
  const cache = path.resolve(process.argv[2]);
  const fixtures = path.resolve(process.argv[3]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-ai-service-'));
  let db;
  let service;
  try {
    const dbPath = path.join(directory, 'photos.db');
    const aiPath = path.join(directory, 'ai');
    fs.mkdirSync(aiPath);
    fs.symlinkSync(
      cache,
      path.join(aiPath, 'models'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT,
      file_type TEXT, file_size INTEGER, date_modified TEXT, thumbnail BLOB,
      width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    let id = 0;
    for (const name of ['cat.jpg', 'football.jpg']) {
      const photoPath = path.join(fixtures, name);
      const thumb = await sharp(photoPath).resize(256, 256, { fit: 'inside' }).jpeg().toBuffer();
      db.prepare('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, 256, 256, 1, 0)').run(
        ++id,
        photoPath,
        name,
        'jpg',
        fs.statSync(photoPath).size,
        '2026-09-25',
        name === 'cat.jpg' ? Buffer.from('corrupt-thumbnail') : thumb,
      );
    }
    service = new SemanticSearch(dbPath, aiPath);
    await service.run('install');
    assert.equal(service.status().ready, true);
    assert.equal((await service.run('index')).indexed, 2);
    assert.equal((await service.run('index')).done, 0);
    for (const [query, expected] of [
      ['一只猫', 1],
      ['a football match', 2],
    ]) {
      const result = await service.run('search', query);
      assert.equal(result.photos[0].id, expected);
    }
    db.prepare('DELETE FROM photos WHERE id = 1').run();
    assert.deepEqual(
      (await service.run('search', 'a cat')).photos.map((p) => p.id),
      [2],
    );
    console.log(
      '[semantic-service-smoke] PASS: Electron Worker install/index/incremental/search/deletion',
    );
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    // Remove the junction explicitly before removing the isolated fixture directory.
    const link = path.join(directory, 'ai', 'models');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
