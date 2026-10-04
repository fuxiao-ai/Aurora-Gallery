'use strict';
// 「人脸索引在跑时，搜图不再被拒」的端到端实测（撤除 canSearch 闸门之后的验证）：
//   1) 先用真实模型把搜图索引建好（模拟用户之前已经建过索引）；
//   2) 起人脸索引，在它明确还在跑的时候发起一次搜图；
//   3) 断言搜图不被 AI_BUSY 拒、能拿到已索引的照片，而且人脸索引照常完整跑完。
// 接线方式与 src/main.js 保持一致：两个索引之间靠 canRun 互斥，但**没有** canSearch。
// 用法：electron scripts/semantic-search-during-face-index-smoke.js \
//         <人脸模型目录> <搜图模型目录> <人脸照片> [第二张照片] [照片数]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { SemanticSearch } = require('../src/main/semantic-search');
const { FaceService } = require('../src/main/face-service');

async function run() {
  const [faceModels, searchModels, sampleA, sampleB = sampleA] = process.argv.slice(2);
  const total = Number(process.argv[6]) || 48;
  if (!faceModels || !searchModels || !sampleA)
    throw new Error('Provide the face models, the search models and at least one sample photo');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-face-sem-'));
  const faceRoot = path.join(directory, 'face-index');
  const searchRoot = path.join(directory, 'ai-search');
  let db, face, search, sampler;
  try {
    // 模型用**真拷贝**而不是 junction：Windows 上 rmSync(recursive) 会顺着 junction 把目标里的
    // 真实文件删掉（本项目已经因此丢过一次模型缓存）。多花几秒磁盘 IO，换收尾绝对安全。
    fs.mkdirSync(faceRoot, { recursive: true });
    fs.cpSync(path.resolve(faceModels), path.join(faceRoot, 'models'), { recursive: true });
    fs.mkdirSync(searchRoot, { recursive: true });
    fs.cpSync(path.resolve(searchModels), path.join(searchRoot, 'models'), { recursive: true });
    // ready.json 记录模型指纹，搜图服务据此判断「本地模型是否就绪」。
    fs.copyFileSync(
      path.join(path.resolve(searchModels), '..', 'ready.json'),
      path.join(searchRoot, 'ready.json'),
    );
    const dbPath = path.join(directory, 'photos.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, file_type TEXT,
      file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    const insert = db.prepare('INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (let i = 1; i <= total; i++) {
      const source = path.resolve(i % 2 ? sampleA : sampleB);
      insert.run(
        i,
        source,
        path.basename(source),
        'jpg',
        fs.statSync(source).size,
        '2026-01-01',
        null,
        1,
        1,
        0,
        0,
      );
    }
    db.close();
    db = null;

    // 与 src/main.js 同一套接线：两个索引互斥（canRun），但不再有 canSearch。
    search = new SemanticSearch(dbPath, searchRoot, {
      concurrentReads: ['search'],
      relayReads: ['search'],
      preserveProgress: ['search'],
    });
    face = new FaceService(dbPath, faceRoot);
    search.canRun = () => !face.status().busy;
    face.canRun = () => !search.status().busy;
    assert.equal(search.canSearch, undefined, '「人脸索引在跑就拒绝搜图」的闸门必须已撤除');

    assert.equal((await search.refresh()).ready, true, '搜图模型必须已就绪');
    assert.equal((await face.refresh()).ready, true, '人脸模型必须已就绪');

    // 1) 先把搜图索引建好——搜索要能在已索引的向量上出结果。
    const built = await search.run('index');
    assert.equal(built.indexed, total, '搜图索引要覆盖全部照片');

    // 2) 起人脸索引，在它跑到一半时发起搜图。
    // 全程采样进程峰值 RSS：搜图那几秒是阻塞等待的，轮询采样不到它，
    // 而「两套模型同时常驻要多少内存」正是这条路径是否安全的关键。
    let peakRss = process.memoryUsage().rss;
    sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 200);
    const indexing = face.run('index');
    let issuedWhileBusy = false;
    let stillIndexingAtReply = false;
    let issuedAt = 0;
    let live = null;
    for (let i = 0; i < 900; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = face.status();
      if (state.busy && state.processed > 0 && state.processed < total) {
        issuedWhileBusy = true;
        issuedAt = state.processed;
        try {
          live = await search.run('search', 'a photo');
        } catch (error) {
          live = error.message;
        }
        stillIndexingAtReply = face.status().busy;
        break;
      }
      if (!state.busy && i > 3) break;
    }
    assert.ok(issuedWhileBusy, '人脸索引必须有机会跑到「一半」时发起搜图');
    assert.notEqual(typeof live, 'string', '人脸索引进行中搜图不得被拒绝：' + live);
    assert.ok(Array.isArray(live.photos) && live.photos.length > 0, '搜图要返回已索引的照片');
    assert.equal(live.indexed, total, '搜图结果基于已建好的索引');
    assert.equal(face.status().busy, true, '搜图不得把人脸索引顶掉');

    // 3) 人脸索引照常跑完。
    const result = await indexing;
    assert.equal(result.processed, total, '人脸索引仍然完整跑完');
    assert.equal(face.status().busy, false, '人脸索引结束后状态归位');
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    console.log(
      '[semantic-search-during-face-index-smoke] PASS: 人脸索引跑到 ' +
        issuedAt +
        '/' +
        total +
        ' 时搜图返回 ' +
        live.photos.length +
        ' 张（回话那一刻人脸索引仍在跑=' +
        stillIndexingAtReply +
        '，全程峰值 RSS ' +
        Math.round(peakRss / (1024 * 1024)) +
        ' MB），人脸索引照常跑完 ' +
        result.processed +
        '/' +
        total,
    );
  } finally {
    // 采样器必须在 finally 里停掉：断言失败时它会把进程一直挂着，跑回归的人会以为卡死。
    if (sampler) clearInterval(sampler);
    if (search) search.dispose();
    if (face) face.dispose();
    if (db) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
