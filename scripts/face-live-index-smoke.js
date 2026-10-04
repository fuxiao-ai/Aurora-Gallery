'use strict';
// 索引进行中的实时性验证：用真实模型与人脸样例跑一次索引，确认
//   1) 索引中途会持续上报「已扫描 / 已检出人脸 / 已识别人物」（人物页据人数增量刷新，
//      并把「检出 N 张脸」显示在实时条上）；
//   2) 索引运行期间并发执行只读查询（groups）不被 AI_BUSY 拒绝，且能拿到已识别结果。
// 这两点是「人物页在索引未结束时就能显示结果」的前提，需要真实 Worker + 真实模型。
// 用法：electron scripts/face-live-index-smoke.js <模型目录> <人脸照片A> [人脸照片B] [照片数]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { FaceService } = require('../src/main/face-service');

async function run() {
  const [models, sampleA, sampleB = sampleA] = process.argv.slice(2);
  const total = Number(process.argv[5]) || 24;
  if (!models || !sampleA)
    throw new Error('Provide models directory and at least one sample photo');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-face-live-index-'));
  const root = path.join(directory, 'index');
  let db, service;
  try {
    fs.mkdirSync(root);
    fs.symlinkSync(
      path.resolve(models),
      path.join(root, 'models'),
      process.platform === 'win32' ? 'junction' : 'dir',
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
    service = new FaceService(dbPath, root);
    assert.equal((await service.refresh()).ready, true, 'models must be installed');

    const running = service.run('index');
    const samples = [];
    let liveRead;
    let attempts = 0;
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const state = service.status();
      samples.push({
        busy: state.busy,
        people: state.people || 0,
        faces: state.faces || 0,
        scanned: state.scanned || 0,
        processed: state.processed || 0,
      });
      if (state.busy && state.processed > 0 && state.processed < total && attempts < 3) {
        attempts++;
        try {
          const data = await service.run('groups');
          liveRead = Math.max(liveRead || 0, data.items.length);
        } catch (error) {
          liveRead = error.message;
        }
      }
      if (!state.busy && samples.length > 3) break;
    }
    const result = await running;
    assert.equal(result.processed, total, 'index processes every photo');
    assert.equal(result.people, 2, 'two distinct people are grouped');
    const midRun = samples.filter((s) => s.busy && s.people > 0 && s.processed < total);
    assert.ok(midRun.length > 0, '人物数必须在索引结束前就在进度中上报');
    // 人物页实时条还要显示「已扫描 / 检出人脸」：两者都得在索引结束前就上报。
    const midFaces = samples.filter((s) => s.busy && s.faces > 0 && s.processed < total);
    assert.ok(midFaces.length > 0, '检出人脸数必须在索引结束前就上报（实时条要显示它）');
    const midScanned = samples.filter((s) => s.busy && s.scanned > 0 && s.processed < total);
    assert.ok(midScanned.length > 0, '已扫描张数必须在索引结束前就上报');
    assert.equal(typeof liveRead, 'number', 'indexing must not reject concurrent read-only groups');
    assert.ok(liveRead > 0, 'concurrent read returns already-detected people');
    assert.equal((await service.run('groups')).items.length, result.people, 'final groups match');
    console.log(
      '[face-live-index-smoke] PASS: 索引中已上报人物 ' +
        midRun.length +
        ' 次 / 检出人脸 ' +
        midFaces.length +
        ' 次 / 已扫描 ' +
        midScanned.length +
        ' 次，并发只读返回 ' +
        liveRead +
        ' 组',
    );
  } finally {
    if (service) service.dispose();
    if (db) db.close();
    // 必须先摘掉指向模型目录的 junction 再递归删除临时目录：Windows 上
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
