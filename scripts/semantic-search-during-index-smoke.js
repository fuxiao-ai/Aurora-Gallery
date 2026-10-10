'use strict';
// 「边建索引边搜图」实测：用真实模型 + 真实照片跑一次索引，在索引进行中发起搜索，确认
//   1) 搜索不被 AI_BUSY 挡掉（并发只读，不再等索引跑完）；
//   2) 返回结果只覆盖「已经落库」的那部分向量（indexed 介于 0 和总数之间）；
//   3) 搜索不破坏索引进度（percent / processed / phase 不被冲掉），索引照常跑完。
// 用法：electron scripts/semantic-search-during-index-smoke.js <模型目录> <一张真实照片> [照片数]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { SemanticSearch } = require('../src/main/semantic-search');

async function run() {
  const [models, sample] = process.argv.slice(2);
  const total = Number(process.argv[4]) || 12;
  if (!models || !sample) throw new Error('Provide models directory and at least one sample photo');
  const resolved = path.resolve(sample);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-semantic-live-'));
  const root = path.join(directory, 'ai');
  let db;
  let service;
  try {
    fs.mkdirSync(root);
    fs.symlinkSync(
      path.resolve(models),
      path.join(root, 'models'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    // ready.json 记录模型指纹，服务据此判断「本地模型是否就绪」。
    fs.copyFileSync(
      path.join(path.resolve(models), '..', 'ready.json'),
      path.join(root, 'ready.json'),
    );
    const dbPath = path.join(directory, 'photos.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, file_type TEXT,
      file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    const insert = db.prepare('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const size = fs.statSync(resolved).size;
    for (let i = 1; i <= total; i++)
      insert.run(i, resolved, path.basename(resolved), 'jpg', size, '2026-01-01', null, 1, 1, 0, 0);
    db.close();
    db = null;

    service = new SemanticSearch(dbPath, root, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    assert.equal((await service.refresh()).ready, true, 'models must be installed');

    const running = service.run('index');
    let liveSearch = null;
    let progressBefore = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = service.status();
      if (state.running && state.done > 0 && state.done < total && !liveSearch) {
        progressBefore = { percent: state.percent, done: state.done, phase: state.phase };
        try {
          liveSearch = await service.run('search', 'a photo');
        } catch (error) {
          liveSearch = error.message;
        }
        break;
      }
      if (!state.running && i > 3) break;
    }
    assert.ok(liveSearch, '索引未跑完就必须有机会发起搜索');
    assert.notEqual(typeof liveSearch, 'string', '索引进行中搜索不得被拒绝：' + liveSearch);
    assert.ok(Array.isArray(liveSearch.photos), '搜索返回结果数组');
    assert.ok(
      liveSearch.indexed > 0 && liveSearch.indexed < total,
      '结果只基于已落库的部分（indexed=' + liveSearch.indexed + '/' + total + '）',
    );
    const afterSearch = service.status();
    assert.equal(afterSearch.running, true, '搜索不得把索引任务顶掉');
    assert.equal(afterSearch.done >= progressBefore.done, true, '索引进度不倒退');

    const result = await running;
    assert.equal(result.done, total, '索引仍然完整跑完');
    assert.equal(result.indexed, total, '全部照片最终都被索引');
    assert.equal(
      (await service.run('search', 'a photo')).photos.length > 0,
      true,
      '索引结束后照常可搜',
    );
    console.log(
      '[semantic-search-during-index-smoke] PASS: 索引进行中搜索返回 ' +
        liveSearch.photos.length +
        ' 张（已索引 ' +
        liveSearch.indexed +
        '/' +
        total +
        '），索引照常跑完',
    );
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    // 必须先摘掉指向模型目录的 junction 再递归删临时目录：Windows 上
    // rmSync(recursive) 会顺着 junction 删掉真实模型文件（已踩过）。
    const link = path.join(root, 'models');
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
