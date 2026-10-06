#!/usr/bin/env node
'use strict';

/**
 * 扫描收尾阶段「不许静默超时」回归。
 *
 * ## 线上故障
 *
 * 用户报：「自动扫描失败：扫描线程无响应（超过 123 秒），已终止。请重试添加目录/重新扫描。」
 * 而扫描**没死**，它只是正在读盘。
 *
 * `scan-worker` 是单线程：同步 SQL / `fs` 期间连 300ms 一次的 progress 心跳都发不出去，
 * 而主进程侧 `main.js#runFolderScanInWorker` 有一条「120 秒收不到任何消息 ⇒ 认定卡死 ⇒
 * `terminate()`」的看门狗。于是「某一段同步工作超过 120 秒」= 一个健康扫描被判死。
 *
 * 真库（1,656,580 行 / 13.3 GB）实测 `K:\COS` 这一根（912,222 行）收尾两段：
 *
 * | 代码 | 单段同步（观察不到任何消息） |
 * | --- | ---: |
 * | `cleanupStalePhotosForRoot`：`.all()` 物化整根 + 逐行比对 | 57,367 + 13,703 = **71,070 ms** |
 * | `refreshRootFolderStatsCacheForRoot`：三档聚合（各自回表取 `file_type`） | 61,140 + 60,067 + 64,306 = **185,513 ms** |
 *
 * 两段叠起来远超 120 秒 —— 每次自动扫描都会在收尾被看门狗打死，用户重试多少次都一样。
 *
 * ## 本回归钉住的契约
 *
 * ① **收尾两段必须按批 + `await` 让出**（`SCAN_TAIL_BATCH_ROWS`），且**不许再出现
 *    `.all()` 一次性物化整根**；调用端必须 `await` —— 漏掉 await 的后果是静默的：
 *    「清理失效记录」永不生效、目录统计永远是旧值，不报错也没有日志。
 * ② **单根三档统计必须各自命中覆盖索引 / 部分索引**：photos 把缩略图 BLOB 内联在行中间，
 *    回表读 `file_type` 要穿过溢出页链。计划塌回回表**不会算错任何一个数**，
 *    数值断言抓不住，只能断言执行计划。
 * ③ 看门狗超时的报错必须带上「最后阶段」（`scan-worker` 阶段自报 → `main.js` 文案），
 *    否则下次再出问题，用户手里还是一句无法定位的「线程无响应」。
 *
 * 真实耗时只在真库上量（本文件里不写死任何毫秒断言，脆弱且没有意义）；这里跑的是
 * 「形状 + 让出次数 + 数值不变」。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PhotoDatabase = require('../src/database');
const heavy = require('../src/db-heavy-read');

const VIDEO_LIST =
  "('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2')";
const VIDEO_PRED = `lower(replace(file_type, '.', '')) IN ${VIDEO_LIST}`;
const IMAGE_PRED = `lower(replace(file_type, '.', '')) NOT IN ${VIDEO_LIST}`;

const ROOT_A_ROWS = 20000;
const ROOT_B_ROWS = 1000;
const CLEANUP_BATCH = 2000;

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/** 剥掉注释再断言形状：注释里正当地写着「禁止 .all()」时不该被自己的注释判失败。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 取一个方法/函数的实现体（从签名后的第一个 `{` 到配对的 `}`）。 */
function extractBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const open = src.indexOf('{', at + signature.length - 1);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

async function removeTemporaryPath(target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// ---------------------------------------------------------------- 源码面

function testStaticContracts() {
  const dbSrc = stripComments(readSource('src/database.js'));

  const cleanupBody = extractBody(dbSrc, 'async cleanupStalePhotosForRoot(');
  check(cleanupBody.length > 0, 'cleanupStalePhotosForRoot 必须是 async —— 签名变了，请同步本回归');
  check(
    !/\.all\(\s*(rid|rootId)\s*\)/.test(cleanupBody),
    'cleanupStalePhotosForRoot 不许再 `.all(rootId)` 一次性物化整根（真库 91 万行单段同步 71 秒 = 被看门狗当死线程终止）',
  );
  check(
    /'SELECT id, file_path FROM photos WHERE root_id = \? AND id > \? ORDER BY id LIMIT \?'/.test(
      cleanupBody,
    ),
    '分批取数必须是 `… WHERE root_id = ? AND id > ? ORDER BY id LIMIT ?` 这一句（游标靠最后一行推进）',
  );
  check(
    /SCAN_TAIL_BATCH_ROWS/.test(cleanupBody),
    'cleanupStalePhotosForRoot 必须用 SCAN_TAIL_BATCH_ROWS 分批，不能自己写一个魔数',
  );
  check(
    /ORDER BY id LIMIT/.test(cleanupBody),
    '分批取数必须带 ORDER BY id + LIMIT：少了它计划会退化成整表扫 + 临时排序',
  );
  check(
    /await yieldFn\(\)/.test(cleanupBody),
    '批间必须 `await` 让出（宏任务），否则 worker 的 progress 心跳发不出去',
  );

  const refreshBody = extractBody(dbSrc, 'async refreshRootFolderStatsCacheForRoot(');
  check(
    refreshBody.length > 0,
    'refreshRootFolderStatsCacheForRoot 必须是 async —— 签名变了，请同步本回归',
  );
  check(
    /await yieldFn\(\)|await yieldToEventLoop\(\)/.test(refreshBody),
    '三档聚合之间必须让出：真库上三档分别是 2595 / 383 / 54 ms，串成一段不让出同样是看门狗风险',
  );
  check(
    /SCAN_TAIL_BATCH_ROWS = \d+/.test(dbSrc),
    'SCAN_TAIL_BATCH_ROWS 的批大小常量不见了',
  );

  // ---- 单根三档统计的 SQL 形状 ----
  // 为什么这里要静态守「必须显式 INDEXED BY」：真库上规划器**会**给
  // `COUNT(*) … WHERE root_id = ? AND <视频谓词>` 选 `idx_photos_root`（回表读 file_type = 61 秒），
  // 而小夹具（2 万行）上它自己就会选部分索引 —— 也就是说，把提示删掉在本回归的夹具上
  // **照样全绿**（已实测）。计划断言只能证明「有提示时确实走部分索引」，
  // 「提示还在不在」必须靠形状断言守。
  const heavySrc = stripComments(readSource('src/db-heavy-read.js'));
  const aggBody = extractBody(heavySrc, 'function runAggregateStatsForSingleRoot(');
  check(aggBody.length > 0, '找不到 runAggregateStatsForSingleRoot —— 签名变了，请同步本回归');
  check(
    !/COALESCE\(SUM\(CASE WHEN/.test(aggBody),
    '单根统计不许再出现 `SUM(CASE WHEN <视频> THEN 1 END)` 那种一条句回表聚合（真库 912,222 行 61,140 ms）',
  );
  check(
    /countViaIndex\(db, AGG_VIDEO_INDEX/.test(aggBody) && /countViaIndex\(db, AGG_IMAGE_INDEX/.test(aggBody),
    '图片档与视频档的计数必须各自走对应的部分索引',
  );
  // ⚠️ 断言必须**落到函数体内**：`' INDEXED BY ' + indexName` 在两个辅助函数里各出现一次，
  // 用整份源码去测，只删其中一个照样绿（第一版就是这么写的，负例没抓住）。
  const countViaIndexBody = extractBody(heavySrc, 'function countViaIndex(');
  const countFoldersBody = extractBody(heavySrc, 'function countDistinctFolders(');
  check(countViaIndexBody.length > 0, '找不到 countViaIndex —— 函数签名变了，请同步本回归');
  check(countFoldersBody.length > 0, '找不到 countDistinctFolders —— 函数签名变了，请同步本回归');
  check(
    /' INDEXED BY ' \+ indexName/.test(countViaIndexBody),
    '计数必须显式 INDEXED BY 部分索引：靠规划器自己选，在真库上会退回 idx_photos_root 回表（61 秒）',
  );
  check(
    /' INDEXED BY ' \+ indexName/.test(countFoldersBody),
    '目录数同样要显式 INDEXED BY 部分索引（走不走部分索引直接决定回不回表）',
  );
  check(
    /AGG_VIDEO_INDEX = 'idx_photos_agg_root_folder_video'/.test(heavySrc) &&
      /AGG_IMAGE_INDEX = 'idx_photos_agg_root_folder_image'/.test(heavySrc),
    '部分索引名必须与 deferred-index-worker 建的那两个逐字一致',
  );

  const scannerSrc = stripComments(readSource('src/scanner.js'));
  check(
    /await this\.db\.cleanupStalePhotosForRoot\(/.test(scannerSrc),
    'scanner 必须 await cleanupStalePhotosForRoot —— 漏了 await 的后果是静默的：清理永不生效，不报错也没日志',
  );
  check(
    /await this\.db\.refreshRootFolderStatsCacheForRoot\(/.test(scannerSrc),
    'scanner 必须 await refreshRootFolderStatsCacheForRoot（同上）',
  );
  check(
    /_reportPhase\('cleanup-stale'\)/.test(scannerSrc) &&
      /_reportPhase\('refresh-stats'\)/.test(scannerSrc),
    '收尾两段必须各自自报阶段，超时文案才能说出卡在哪一步',
  );

  const workerSrc = stripComments(readSource('src/scan-worker.js'));
  check(
    /type: 'phase'/.test(workerSrc),
    "scan-worker 必须把 scanner 的阶段自报转成 { type: 'phase' } 消息",
  );
  check(/onPhase: function/.test(workerSrc), 'scan-worker 必须把 onPhase 传给 Scanner');

  const mainSrc = stripComments(readSource('src/main.js'));
  check(
    /msg\.type === 'phase'/.test(mainSrc) && /workerScanLastPhase = String\(msg\.name\)/.test(mainSrc),
    'main.js 必须消费 phase 消息并记下最后阶段，否则超时报错依旧无法定位',
  );
  check(
    /' 秒，最后阶段：'/.test(mainSrc),
    '看门狗超时文案必须带上最后阶段（否则用户手里只有一句「线程无响应」）',
  );
}

// ---------------------------------------------------------------- 行为面

function buildFixture(db) {
  const rootA = db.addRootFolder('K:\\fix\\rootA');
  const rootB = db.addRootFolder('K:\\fix\\rootB');
  const insert = db.getInsertStmt();
  db.beginTransaction();
  for (let i = 1; i <= ROOT_A_ROWS; i += 1) {
    const fileType = i % 7 === 0 ? 'mp4' : 'jpg';
    const folder = 'K:\\fix\\rootA\\f' + (i % 50);
    const name = 'a' + i + '.' + fileType;
    insert.run(
      rootA,
      folder,
      name,
      folder + '\\' + name,
      1000 + i,
      fileType,
      0,
      0,
      '2026-01-01 10:00:00',
      '2026-01-01 10:00:00',
      null,
      0,
      0,
      '',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  }
  for (let i = 1; i <= ROOT_B_ROWS; i += 1) {
    const folder = 'K:\\fix\\rootB\\g' + (i % 10);
    const name = 'b' + i + '.jpg';
    insert.run(
      rootB,
      folder,
      name,
      folder + '\\' + name,
      500,
      'jpg',
      0,
      0,
      '2026-01-02 10:00:00',
      '2026-01-02 10:00:00',
      null,
      0,
      0,
      '',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  }
  db.commit();
  return { rootA, rootB };
}

/** 参照实现：改写前的 SQL（各档 photo_count / video_count 一条句、folder_count 一条句）。 */
function legacyAggregate(db, rootId, media) {
  const mediaWhere =
    media === 'image'
      ? `p.root_id = ? AND lower(replace(p.file_type, '.', '')) NOT IN ${VIDEO_LIST}`
      : media === 'video'
        ? `p.root_id = ? AND lower(replace(p.file_type, '.', '')) IN ${VIDEO_LIST}`
        : 'p.root_id = ?';
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS photo_count,
              COALESCE(SUM(CASE WHEN lower(replace(p.file_type, '.', '')) IN ${VIDEO_LIST} THEN 1 ELSE 0 END), 0) AS video_count
       FROM photos p WHERE ${mediaWhere}`,
    )
    .get(rootId);
  const folderRow = db
    .prepare(
      `SELECT COUNT(*) AS folder_count FROM (SELECT DISTINCT p.folder_path FROM photos p WHERE ${mediaWhere})`,
    )
    .get(rootId);
  return {
    photo_count: Number(countRow.photo_count) || 0,
    folder_count: Number(folderRow.folder_count) || 0,
    video_count: Number(countRow.video_count) || 0,
  };
}

function planOf(db, sql, params) {
  return db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(...(params || []))
    .map((row) => row.detail)
    .join(' | ');
}

async function main() {
  testStaticContracts();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-scan-tail-'));
  const dbPath = path.join(tmpDir, 'photos.db');
  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    const { rootA, rootB } = buildFixture(db);

    // ---- ① 单根三档统计：改写后的值与改写前逐字段一致 ----
    // 刻意**先在没有部分索引的库上**对答案 —— 那是「首启 / 索引还没建好」的兜底路径，
    // 它必须同样正确（只是慢），不能在快路径上对、兜底路径上错。
    for (const media of ['all', 'image', 'video']) {
      const got = heavy.runAggregateStatsForSingleRoot(
        db.db,
        rootA,
        media === 'all' ? {} : { mediaType: media },
      );
      const ref = legacyAggregate(db.db, rootA, media);
      assert.deepEqual(
        got,
        ref,
        `${media} 档在「还没有部分索引」的兜底路径上必须与改写前逐字段一致`,
      );
    }

    // 参照值单独算一遍，避免「两边一起错」：照片行全在 rootA，视频行 = 7 的倍数
    const expectVideos = Math.floor(ROOT_A_ROWS / 7);
    const allRef = legacyAggregate(db.db, rootA, 'all');
    check(allRef.photo_count === ROOT_A_ROWS, '夹具自身：rootA 照片数应为 ' + ROOT_A_ROWS);
    check(allRef.video_count === expectVideos, '夹具自身：rootA 视频数应为 ' + expectVideos);
    check(
      legacyAggregate(db.db, rootA, 'image').photo_count === ROOT_A_ROWS - expectVideos,
      '夹具自身：image 档 = 全档 - 视频档（file_type 无 NULL）',
    );
    check(
      legacyAggregate(db.db, rootA, 'video').photo_count === expectVideos,
      'video 档 photo_count 与 video_count 同值',
    );

    // ---- ② 计划：三档统计各自命中覆盖索引 / 部分索引，不许回表 ----
    // 部分索引由 `src/workers/deferred-index-worker.js` 建（全工程唯一真相源，本脚本不引它，
    // 只按同一份 SQL 造出来 —— 这里守的是 `db-heavy-read` 的**用**法）。
    db.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_image ON photos(root_id, folder_path) WHERE ' +
        IMAGE_PRED,
    );
    db.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_photos_agg_root_folder_video ON photos(root_id, folder_path) WHERE ' +
        VIDEO_PRED,
    );
    db.db.exec('ANALYZE');

    const videoCountPlan = planOf(
      db.db,
      `SELECT COUNT(*) AS n FROM photos INDEXED BY idx_photos_agg_root_folder_video WHERE root_id = ? AND ${VIDEO_PRED}`,
      [rootA],
    );
    check(
      videoCountPlan.includes('idx_photos_agg_root_folder_video') && !/SCAN photos/.test(videoCountPlan),
      '视频档计数必须走部分索引（回表读 file_type 要穿过缩略图溢出页链）；实际计划：' + videoCountPlan,
    );
    const imageCountPlan = planOf(
      db.db,
      `SELECT COUNT(*) AS n FROM photos INDEXED BY idx_photos_agg_root_folder_image WHERE root_id = ? AND ${IMAGE_PRED}`,
      [rootA],
    );
    check(
      imageCountPlan.includes('idx_photos_agg_root_folder_image') && !/SCAN photos/.test(imageCountPlan),
      '图片档计数必须走部分索引；实际计划：' + imageCountPlan,
    );
    const allFolderPlan = planOf(
      db.db,
      'SELECT COUNT(*) AS n FROM (SELECT DISTINCT folder_path FROM photos WHERE root_id = ?)',
      [rootA],
    );
    check(
      allFolderPlan.includes('COVERING INDEX idx_photos_root_folder'),
      '全档目录数必须走 (root_id, folder_path) 覆盖索引；实际计划：' + allFolderPlan,
    );
    const videoFolderPlan = planOf(
      db.db,
      `SELECT COUNT(*) AS n FROM (SELECT DISTINCT folder_path FROM photos INDEXED BY idx_photos_agg_root_folder_video WHERE root_id = ? AND ${VIDEO_PRED})`,
      [rootA],
    );
    check(
      /idx_photos_agg_root_folder_video/.test(videoFolderPlan) && !/SCAN photos/.test(videoFolderPlan),
      '视频档目录数必须走部分索引；实际计划：' + videoFolderPlan,
    );

    // 有了索引之后数值必须一动不动
    for (const media of ['all', 'image', 'video']) {
      assert.deepEqual(
        heavy.runAggregateStatsForSingleRoot(
          db.db,
          rootA,
          media === 'all' ? {} : { mediaType: media },
        ),
        legacyAggregate(db.db, rootA, media),
        `${media} 档走索引后的值必须与改写前逐字段一致（快路径不能顺手改语义）`,
      );
    }

    // ---- ③ 分批取数的计划：必须顺着 idx_photos_root 走并靠 LIMIT 早停 ----
    // ⚠️ 这里**不钉具体走哪个索引**：小夹具（2 万行、id 连续）上规划器会合理地选
    // `INTEGER PRIMARY KEY (rowid>?)`，真库（165 万行、多根交错）上选的是
    // `idx_photos_root (root_id=? AND rowid>?)` —— 两者都是「按 id 有序推进 + LIMIT 早停」，
    // 都满足契约。真正不能出现的是整表扫（每批要读十几 GB）与临时排序（先把整根排出来）。
    const pagePlan = planOf(
      db.db,
      'SELECT id, file_path FROM photos WHERE root_id = ? AND id > ? ORDER BY id LIMIT ?',
      [rootA, 0, CLEANUP_BATCH],
    );
    check(
      !/SCAN photos/.test(pagePlan),
      '收尾分批取数每批都必须能靠索引定位 + LIMIT 早停，不许整表扫；实际计划：' + pagePlan,
    );
    check(
      !/TEMP B-TREE/.test(pagePlan),
      '收尾分批取数不许先物化整根再排序（那就等于回到 71 秒的单段同步）；实际计划：' + pagePlan,
    );
    check(
      /idx_photos_root|INTEGER PRIMARY KEY/.test(pagePlan),
      '收尾分批取数必须走主键/根索引的有序推进；实际计划：' + pagePlan,
    );

    // ---- ④ refreshRootFolderStatsCacheForRoot：写进缓存的三档值 + 让出次数 ----
    let refreshYields = 0;
    const statsPromise = db.refreshRootFolderStatsCacheForRoot(rootA, {
      yieldFn: async () => {
        refreshYields += 1;
      },
    });
    check(
      statsPromise && typeof statsPromise.then === 'function',
      'refreshRootFolderStatsCacheForRoot 必须返回 Promise（否则调用端无法 await，漏 await 是静默失效）',
    );
    await statsPromise;
    check(refreshYields === 2, '三档之间必须让出恰好 2 次（实测 ' + refreshYields + ' 次）');
    const cached = db.db
      .prepare('SELECT media_key, photo_count, folder_count, video_count FROM root_folder_stats_cache WHERE root_id = ? ORDER BY media_key')
      .all(rootA);
    check(cached.length === 3, '收尾必须写入 all/image/video 三行，实际 ' + cached.length + ' 行');
    for (const row of cached) {
      const ref = legacyAggregate(db.db, rootA, row.media_key);
      assert.deepEqual(
        { photo_count: row.photo_count, folder_count: row.folder_count, video_count: row.video_count },
        ref,
        row.media_key + ' 档写入缓存的三个数必须与改写前一致（改错不会抛错，只会让界面数字错）',
      );
    }

    // ---- ⑤ cleanupStalePhotosForRoot：分批 + 让出 + 只删该删的 ----
    const scanned = new Set();
    for (let i = 1; i <= ROOT_A_ROWS; i += 2) {
      const fileType = i % 7 === 0 ? 'mp4' : 'jpg';
      const folder = 'K:\\fix\\rootA\\f' + (i % 50);
      scanned.add(folder + '\\' + 'a' + i + '.' + fileType);
    }
    let cleanupYields = 0;
    const cleanupPromise = db.cleanupStalePhotosForRoot(rootA, scanned, {
      batchSize: CLEANUP_BATCH,
      yieldFn: async () => {
        cleanupYields += 1;
      },
    });
    check(
      cleanupPromise && typeof cleanupPromise.then === 'function',
      'cleanupStalePhotosForRoot 必须返回 Promise（漏 await = 清理永不生效且完全静默）',
    );
    const cleanup = await cleanupPromise;
    check(cleanup.checked === ROOT_A_ROWS, '必须逐行看过整根，checked=' + cleanup.checked);
    check(
      cleanup.deleted === ROOT_A_ROWS / 2,
      '只删「不在本次枚举集合里」的行，期望删 ' + ROOT_A_ROWS / 2 + ' 行，实际 ' + cleanup.deleted,
    );
    check(cleanup.markedMissing === cleanup.deleted, 'markedMissing 与 deleted 同值（旧契约）');
    // 每批之后都让出一次；行数正好是批大小整数倍时，最后一批「满批」之后还会多让出一次
    // （要再查一次空页才知道到底了），所以这里是 10 而不是 9 —— 这是实现形状的一部分，
    // 不是误差；断言写死才能挡住「改成只在某些批让出」这类退化。
    check(
      cleanupYields === Math.ceil(ROOT_A_ROWS / CLEANUP_BATCH),
      '批间必须让出 ' +
        Math.ceil(ROOT_A_ROWS / CLEANUP_BATCH) +
        ' 次（每批 ' +
        CLEANUP_BATCH +
        ' 行），实际 ' +
        cleanupYields +
        ' 次',
    );
    const leftA = db.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE root_id = ?').get(rootA).n;
    check(leftA === ROOT_A_ROWS / 2, 'rootA 应只剩 ' + ROOT_A_ROWS / 2 + ' 行，实际 ' + leftA);
    const leftB = db.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE root_id = ?').get(rootB).n;
    check(leftB === ROOT_B_ROWS, '清理必须只作用于传入的根，rootB 被误删了 ' + (ROOT_B_ROWS - leftB) + ' 行');

    // ---- ⑥ 空集合兜底路径：退回逐行 fs.existsSync，且真的按「文件还在不在」判 ----
    const rootC = db.addRootFolder('K:\\fix\\rootC');
    const liveDir = path.join(tmpDir, 'live');
    fs.mkdirSync(liveDir, { recursive: true });
    const liveFiles = ['keep1.jpg', 'keep2.jpg', 'keep3.jpg'];
    for (const name of liveFiles) fs.writeFileSync(path.join(liveDir, name), 'x');
    for (const name of liveFiles.concat(['gone1.jpg', 'gone2.jpg'])) {
      db.insertPhoto({
        rootId: rootC,
        folderPath: liveDir,
        fileName: name,
        filePath: path.join(liveDir, name),
        fileSize: 1,
        fileType: 'jpg',
        width: 0,
        height: 0,
        dateTaken: '2026-01-03 10:00:00',
        dateModified: '2026-01-03 10:00:00',
        thumbnail: null,
        hasThumbnail: 0,
      });
    }
    const fallback = await db.cleanupStalePhotosForRoot(rootC, new Set());
    check(
      fallback.checked === 5 && fallback.deleted === 2,
      '空集合必须退回 fs.existsSync 逐行判定：5 行里只该删 2 个已不存在的文件，实际 ' +
        JSON.stringify(fallback),
    );
    check(
      db.db.prepare('SELECT COUNT(*) AS n FROM photos WHERE root_id = ?').get(rootC).n === 3,
      '磁盘上还在的 3 个文件必须留下',
    );

    console.log('[scan-tail-watchdog] PASS (' + checks + ' checks)');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    await removeTemporaryPath(tmpDir);
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
