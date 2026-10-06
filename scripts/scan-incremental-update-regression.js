#!/usr/bin/env node
'use strict';

/**
 * 扫描「同一路径的文件变了 ⇒ 必须真的写进库」回归（P0-1）。
 *
 * ## 线上症状：候选集永不收敛
 *
 * `database.js#getInsertStmt()` 是 `INSERT OR IGNORE`，同路径已存在时 `changes === 0`，
 * 本次扫描读到的 `file_size` / `date_modified`（以及将来的缩略图与元数据）**全被丢弃**，
 * 库里那一行永远停在旧值 ⇒ 下一轮扫描**仍然**判定它「已变更」⇒ 每轮都白跑一遍。
 * 全工程过去**没有任何** `UPDATE photos SET file_size / date_modified`。
 *
 * 后果不只是白跑：**就地替换过的照片永远保留旧缩略图与旧指纹**，
 * 查重会报出早已不存在的重复对。（与 CONTRACTS 里 `width = 0` 那起是同一类 bug，
 * 那次是孤儿模块里的 `width` 回填从未被运行时加载，这次是写路径本身缺失。）
 *
 * ## 本回归钉住的契约
 *
 * ① 变更文件走 `database.js#getUpdateFileFactsStmt()`，把本次读到的
 *    `file_size` / `date_modified` / `file_type` 真的写回去；
 * ② **同一条语句里**把 dHash 与查重指纹两组派生列置空 —— 「过期」只在这一个点判定，
 *    后台任务的候选谓词保持简单（见 CONTRACTS §P2-2）；
 * ③ `is_favorite` 绝不被碰：它是用户数据，与文件内容无关；
 * ④ **收敛**：紧接着再扫一遍，该文件必须被判为「未变更」而跳过。
 *    这一条是整份回归的重点 —— 它同时证明「值真的落库了」与「落到了对的列上」。
 *    只断言前三条的话，「把 size 写进 date_modified」这类串列仍然全绿。
 * ⑤ 两条语句的列顺序由 `SCAN_WRITE_COLUMNS` **单一来源**保证：这里用 Statement 的
 *    `.source` 读回真实 SQL 做机械比对，而不是相信注释。
 *
 * 牙齿（必须能变红，改完自己验一遍）：
 * - 删掉 `scanner.js#processFile` 里的 `updateFileFactsStmt` 分支 ⇒ ①③④ 变红；
 * - 把 `SCAN_WRITE_COLUMNS` 里 `file_path` 挪出下标 3 ⇒ ⑤ 变红（`scanner.js` 的
 *   `splice(3, 1)` 会切错列，静默串列）；
 * - 把 UPDATE 的派生列置空删掉 ⇒ ② 变红。
 *
 * ⚠️ 真跑临时库与真文件，不 mock `fs`：本契约的全部难点就在「扫描真的读了磁盘」。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PhotoDatabase = require('../src/database');
const Scanner = require('../src/scanner');

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function readSource(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/** 剥掉注释再断言形状：注释里正当地写着「不要 X」时不该被自己的注释判失败。 */
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

/** 与 `scanner.js#formatMtimeFromDate` 同一套口径（UTC，秒级）—— 库里的 date_modified 就是这个形态。 */
function dbMtimeOf(date) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

function scanOptions() {
  return {
    followSymlinks: false,
    maxDepth: 0,
    skipDirNameSet: new Set(),
    includeRaw: true,
    diskProfile: 'auto',
    ioThrottleMs: 0,
  };
}

function makeScanner(db) {
  const opts = scanOptions();
  return new Scanner(db, {
    getThumbOptions: () => ({ size: 256, quality: 75 }),
    getScanOptions: () => opts,
  });
}

function rowOf(db, filePath) {
  const row = db.db.prepare('SELECT * FROM photos WHERE file_path = ?').get(filePath);
  check(!!row, '库里应当有 ' + filePath + ' 这一行');
  return row;
}

// ---------------------------------------------------------------- 源码面

function testStaticContracts() {
  const dbSrc = stripComments(readSource('src/database.js'));
  const scannerSrc = stripComments(readSource('src/scanner.js'));

  check(
    /getUpdateFileFactsStmt\(\)/.test(dbSrc),
    'database.js 必须提供 getUpdateFileFactsStmt()：只靠 INSERT OR IGNORE 一条写路径 = 候选永不收敛',
  );
  check(
    /INSERT OR IGNORE INTO photos/.test(dbSrc),
    'getInsertStmt 仍必须是 INSERT OR IGNORE（它承担「快速判重」的角色，changes=0 即路径已存在）',
  );
  check(
    /UPDATE photos SET ' \+ setters\.join/.test(dbSrc),
    'getUpdateFileFactsStmt 必须由 setters 列表拼出 UPDATE，不能退回手写列清单（手写的会和 INSERT 漂移）',
  );

  const updateBody = extractBody(dbSrc, 'getUpdateFileFactsStmt()');
  check(updateBody.length > 0, '找不到 getUpdateFileFactsStmt 的实现体 —— 签名变了，请同步本回归');
  check(
    /col === 'file_path'[\s\S]{0,40}continue/.test(updateBody),
    "file_path 必须被排除在 SET 之外（它只作 WHERE）",
  );
  check(
    !/is_favorite/.test(updateBody),
    '🔴 is_favorite 绝不能出现在变更更新里：它是用户数据，与文件内容无关',
  );
  for (const col of ['dhash', 'dhash_mtime', 'dhash_size', 'file_hash', 'hash_mtime', 'hash_size']) {
    check(
      new RegExp("'" + col + " = NULL'").test(dbSrc),
      'SCAN_INVALIDATED_ON_CONTENT_CHANGE 必须清 ' + col + '（文件换了，指纹就是脏数据）',
    );
  }

  const processFileBody = extractBody(scannerSrc, 'Scanner.prototype.processFile = async function');
  check(processFileBody.length > 0, '找不到 processFile 的实现体 —— 签名变了，请同步本回归');
  check(
    /this\.updateFileFactsStmt/.test(processFileBody),
    '🔴 processFile 必须有「已存在 ⇒ UPDATE」的回落分支；少了它，变更文件的新值全被 IGNORE 丢掉',
  );
  check(
    /return 'updated'/.test(processFileBody),
    "变更分支必须返回 'updated'（进度统计要按它区分「新插入」与「已变更」）",
  );
  check(
    /updateArgs\.splice\(3, 1\)/.test(processFileBody),
    'UPDATE 参数必须是 INSERT 参数 splice(3, 1)（去掉 file_path）—— 下标与 SCAN_WRITE_COLUMNS 绑定',
  );
  check(
    /_scanStats\.changed\+\+/.test(scannerSrc),
    'scanStats 必须统计 changed（否则界面上「已变更」永远是 0，用户看不出扫描干了什么）',
  );
  check(
    /this\.updateFileFactsStmt = null/.test(scannerSrc),
    '扫描结束必须释放 updateFileFactsStmt（与 insertStmt 同样处理，避免持有已关闭语句）',
  );
}

// ---------------------------------------------------------------- 行为面

async function main() {
  testStaticContracts();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-scan-inc-'));
  const rootDir = path.join(tmpDir, 'lib');
  const subDir = path.join(rootDir, 'sub');
  fs.mkdirSync(subDir, { recursive: true });
  const fileA = path.join(rootDir, 'a.jpg');
  const fileB = path.join(subDir, 'b.jpg');

  let db = null;
  try {
    db = new PhotoDatabase(path.join(tmpDir, 'photos.db'));
    // dHash / 查重指纹列是延迟迁移出来的：本回归要往这两组列里造旧值，先确保它们存在
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();

    // ---- ⑤ 两条语句的列顺序：用真实 SQL 机械比对，而不是相信注释 ----
    const insertStmt = db.getInsertStmt();
    const updateStmt = db.getUpdateFileFactsStmt();
    const insertCols = insertStmt.source
      .replace(/[\s\S]*?\(/, '')
      .replace(/\)[\s\S]*/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const setPart = updateStmt.source.replace(/^UPDATE photos SET /, '').replace(/ WHERE [\s\S]*$/, '');
    const setCols = setPart
      .split(',')
      .map((s) => s.trim().split(' = ')[0])
      .filter(Boolean);
    const expectedSetCols = insertCols.filter((c) => c !== 'file_path');
    assert.deepEqual(
      setCols.slice(0, expectedSetCols.length),
      expectedSetCols,
      'UPDATE 的 SET 列顺序必须与 INSERT 去掉 file_path 后逐位一致 —— 否则 scanner 的 splice(3,1) 会静默串列',
    );
    check(
      insertCols.indexOf('file_path') === 3,
      "SCAN_WRITE_COLUMNS 里 file_path 必须在第 4 位（下标 3），scanner 的 splice(3, 1) 依赖它；实际下标 " +
        insertCols.indexOf('file_path'),
    );
    check(
      setCols.length > expectedSetCols.length,
      'UPDATE 的 SET 里除了写入列，还必须有派生列置空（dhash* / file_hash / hash_*）',
    );
    const placeholders = (insertStmt.source.match(/\?/g) || []).length;
    check(
      placeholders === insertCols.length,
      'INSERT 的占位符数（' + placeholders + '）必须等于列数（' + insertCols.length + '）',
    );

    // ---- addRootFolder：不许依赖连接级的 lastInsertRowid ----
    // 症状：同一个连接里**先插过照片**、再重复登记同一个根目录 ⇒ 返回的是**上一批 photos 的
    // rowid**（`last_insert_rowid` 是连接级的，`INSERT OR IGNORE` 被忽略时不会归零）⇒
    // 之后每一行写入都撞 `FOREIGN KEY constraint failed`，扫描把**全部文件**静默跳过，
    // 只打一行 `SKIP (FK)`，用户看到「扫描完成，0 张」。
    const dupRoot = path.join(tmpDir, 'dup-root');
    fs.mkdirSync(dupRoot, { recursive: true });
    const rootIdFirst = db.addRootFolder(dupRoot);
    check(!!rootIdFirst, '首次登记根目录必须返回 id');
    // ⚠️ 必须插**多于一行**：photo 与 root_folder 各自从 1 开始计 rowid，
    // 只插一行时连接级 `last_insert_rowid()` 恰好等于 `rootIdFirst`，
    // 旧的错误实现会**碰巧通过**（第一版断言就是这么漏掉的）。
    // 插 3 行，photos 的 rowid 就与 root_folders 的 id 错开，错误实现无处可藏。
    const dupInsert = db.getInsertStmt();
    for (const dupName of ['x1.jpg', 'x2.jpg', 'x3.jpg']) {
      dupInsert.run(
        rootIdFirst,
        dupRoot,
        dupName,
        path.join(dupRoot, dupName),
        1,
        'jpg',
        0,
        0,
        't',
        't',
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
    const rootIdAgain = db.addRootFolder(dupRoot);
    check(
      rootIdAgain === rootIdFirst,
      '重复登记同一路径必须返回同一个 id：实际 ' +
        rootIdAgain +
        '，期望 ' +
        rootIdFirst +
        ' —— 不同就说明还在用连接级 lastInsertRowid（那可能是 photos 的 rowid）',
    );
    check(
      !!db.db.prepare('SELECT 1 AS x FROM root_folders WHERE id = ?').get(rootIdAgain),
      'addRootFolder 返回的 id 必须真的存在于 root_folders，否则后续写入全部 FK 失败、扫描静默跳过',
    );

    // ---- 第 1 遍：两个文件全新入库 ----
    const t1 = new Date(Date.now() - 300000);
    fs.writeFileSync(fileA, 'AAAA');
    fs.writeFileSync(fileB, 'BBBBBB');
    fs.utimesSync(fileA, t1, t1);
    fs.utimesSync(fileB, t1, t1);

    const scanner = makeScanner(db);
    await scanner.scanFolder(rootDir);
    let stats = scanner.getProgress().scanStats;
    check(!!stats, 'scanFolder 之后必须能拿到 scanStats');
    check(stats.inserted === 2, '第 1 遍应插入 2 行，实际 inserted=' + stats.inserted);
    check(stats.changed === 0, '第 1 遍不该有「已变更」行，实际 changed=' + stats.changed);

    const before = rowOf(db, fileA);
    check(Number(before.file_size) === 4, '夹具自身：a.jpg 首次入库应为 4 字节，实际 ' + before.file_size);

    // 给 a.jpg 造出「已经被后台任务补过」的旧派生值 + 一个用户标记
    db.db
      .prepare(
        `UPDATE photos SET has_thumbnail = 1, thumbnail = ?, thumb_size = 256, thumb_format = 'jpeg',
                dhash = 'deadbeefdeadbeef', dhash_mtime = '2020-01-01 00:00:00', dhash_size = 4,
                file_hash = 'sha1-of-old-content', hash_mtime = '2020-01-01 00:00:00', hash_size = 4,
                width = 640, height = 480, is_favorite = 1
         WHERE file_path = ?`,
      )
      .run(Buffer.from('old-thumbnail-bytes'), fileA);

    // ---- 第 2 遍：就地替换 a.jpg（内容与 mtime 都变）----
    const t2 = new Date(Date.now() - 60000);
    fs.writeFileSync(fileA, 'AAAAAAAAAA'); // 10 字节 ≠ 4 字节
    fs.utimesSync(fileA, t2, t2);
    check(dbMtimeOf(t2) !== dbMtimeOf(t1), '夹具自身：两次 mtime 必须落在不同的秒上（库内精度是秒）');

    await scanner.scanFolder(rootDir);
    stats = scanner.getProgress().scanStats;
    check(stats.inserted === 0, '第 2 遍不该有新插入，实际 inserted=' + stats.inserted);
    check(stats.changed === 1, '第 2 遍应恰好 1 行判为「已变更」，实际 changed=' + stats.changed);
    check(
      stats.skippedUnchanged === 1,
      '第 2 遍应跳过未变的 b.jpg（跳过 1 个），实际 skippedUnchanged=' + stats.skippedUnchanged,
    );

    const after = rowOf(db, fileA);
    // ① 本次读到的文件事实必须真的落库
    check(
      Number(after.file_size) === 10,
      '① 变更文件的 file_size 必须更新为 10，实际 ' + after.file_size + '（＝旧值 ⇒ 候选永不收敛）',
    );
    check(
      String(after.date_modified) === dbMtimeOf(t2),
      '① 变更文件的 date_modified 必须更新为新的 mtime，实际 ' +
        after.date_modified +
        '，期望 ' +
        dbMtimeOf(t2),
    );
    check(
      String(after.file_type) === 'jpg',
      '① file_type 应保持 jpg，实际 ' + after.file_type,
    );

    // ② 派生列必须被清空（「过期」只有这一个判定点）
    check(
      Number(after.has_thumbnail) === 0 && after.thumbnail === null,
      '② 内容变了旧缩略图必须失效：has_thumbnail=' + after.has_thumbnail + ' thumbnail=' + after.thumbnail,
    );
    check(
      Number(after.thumb_size) === 0 && String(after.thumb_format) === '',
      '② 缩略图规格必须归零（0 / 空串 = 未知），实际 ' +
        after.thumb_size +
        ' / ' +
        after.thumb_format,
    );
    check(after.dhash === null, '② dhash 必须被清空，实际 ' + after.dhash);
    check(after.dhash_mtime === null, '② dhash_mtime 必须被清空');
    check(after.dhash_size === null, '② dhash_size 必须被清空');
    check(after.file_hash === null, '② file_hash 必须被清空，实际 ' + after.file_hash);
    check(after.hash_mtime === null, '② hash_mtime 必须被清空');
    check(after.hash_size === null, '② hash_size 必须被清空');
    check(
      Number(after.width) === 0 && Number(after.height) === 0,
      '② 尺寸也是「与文件内容绑定」的事实，必须归零等待回填（0 = 未知，不是 640×480 的旧值）',
    );

    // ③ 用户数据不许被扫掉
    check(
      Number(after.is_favorite) === 1,
      '③ is_favorite 必须原样保留（它是用户数据，与文件内容无关），实际 ' + after.is_favorite,
    );

    // ④ 收敛：再扫一遍，a.jpg 必须被判为「未变更」
    await scanner.scanFolder(rootDir);
    stats = scanner.getProgress().scanStats;
    check(
      stats.skippedUnchanged === 2,
      '④ 收敛断言：第 3 遍必须两个文件都跳过（未变更），实际 skippedUnchanged=' +
        stats.skippedUnchanged +
        ' —— 少了就说明库里的值没写对，下一轮还会再判它变了，候选集永不收敛',
    );
    check(
      stats.changed === 0,
      '④ 第 3 遍不该再有任何「已变更」行，实际 changed=' + stats.changed,
    );
    check(stats.inserted === 0, '④ 第 3 遍不该有新插入，实际 inserted=' + stats.inserted);

    const finalRow = rowOf(db, fileA);
    check(
      Number(finalRow.file_size) === 10 && String(finalRow.date_modified) === dbMtimeOf(t2),
      '④ 第 3 遍之后 a.jpg 仍应是变更后的值（收敛 = 稳定，不是被反复改写）',
    );

    // 未变的那个文件不许被顺手改写
    const rowB = rowOf(db, fileB);
    check(Number(rowB.file_size) === 6, '未变更文件的 file_size 不该被碰，实际 ' + rowB.file_size);

    console.log('[scan-incremental-update] PASS (' + checks + ' checks)');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
