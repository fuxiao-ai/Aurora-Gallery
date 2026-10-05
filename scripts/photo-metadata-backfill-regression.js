'use strict';
/**
 * 照片元数据回填回归：`photos.width` / `photos.height` 的补全链路。
 *
 * 背景（2026-10-04）：本机 1224 万行的库里 `width` / `height` 与 EXIF 各列**全是空的**，
 * 但列本身都在。原因是两阶段导入 —— `scanner.js` 的 `GENERATE_THUMBNAILS_DURING_SCAN = false`
 * 让 `processFile()` 整块跳过元数据提取，而当时的补全任务只写缩略图与 dHash，
 * 明明已经把每个文件用 sharp 打开过，却从不调 `.metadata()`。
 * 于是面板上「尺寸 / 宽高比 / 总像素」三行只能靠预览时的 sharp 实时回补撑着。
 *
 * 这一轮把「缺尺寸」纳入补全任务的候选谓词，让它在生成缩略图 / 补 dHash 的同时，
 * 用**同一个 sharp 实例**顺手读一次文件头（零额外磁盘 I/O）。
 *
 * 🔴 教训（2026-10-05，T6）：实现曾经只落在 `src/main/thumbnail-backfill.js` —— 而那个文件是
 * **未接线的孤儿副本**，运行时根本不会执行。于是**本脚本一路是假绿**：断言全过，线上却
 * 一行尺寸都没写，候选集（含 `width IS NULL OR width = 0`）永不收敛，每轮补全都重走全库。
 * 孤儿链已删除，断言现在钉 `src/main.js` 的 `runRowsWithThumbConcurrency` —— **活的那一份**。
 * 写「某条契约实现了」的守护时，必须先确认被钉的文件在运行时真的会被 `require`。
 *
 * 本脚本钉住这条链路里最容易静默坏掉的几处：
 *   1. 🔴 **谓词必须同源**。「缺什么」这个判断分散在三个查询方法里，各写一份一定会漂；
 *      漂的后果是**静默空转**（进度条分母 1200 万、任务却几乎不动）或**重复白干**。
 *   2. 🔴 **候选行必须带 `dhash` / `width` / `height` 三列**。少了 `dhash`，上层就判断不出
 *      「这次命中只是因为缺尺寸」，会对每一行重算 dHash —— 那是整图解码，比读文件头贵几个数量级。
 *   3. 🔴 **原图尺寸只能来自 `.metadata()`**。`toBuffer()` 返回的 `info.width/height` 是
 *      **输出（缩略图）**的尺寸，用错会把整库分辨率写成 256×256，而且不报任何错。
 *   4. 🔴 **尺寸不降级**：只在拿到正尺寸时才写库，不能把已有的真实值覆盖成 0。
 *
 * 判定口径同其它静态守护：宁可漏报不误报。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DB = 'src/database.js';
/** 补全任务的**活实现**就在 main.js（`runRowsWithThumbConcurrency`），没有独立模块文件 */
const BACKFILL_IMPL = 'src/main.js';
const RUN_REGRESSIONS = 'scripts/run-regressions.js';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

/** 取一段函数 / 方法体的文本，用于「这行必须在这个函数里」类断言 */
function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

const dbSrc = read(DB);
const implSrc = read(BACKFILL_IMPL);
const runSrc = read(RUN_REGRESSIONS);

// ---------------------------------------------------- 1. 候选谓词必须单一来源

const predBody = bodyOf(dbSrc, '_sqlBackfillPendingExpr() {');
check('夹具自证：取到了 _sqlBackfillPendingExpr 的函数体', predBody.length > 0);
check('谓词方法存在且被导出使用点引用', (dbSrc.match(/_sqlBackfillPendingExpr\(\)/g) || []).length >= 4, String((dbSrc.match(/_sqlBackfillPendingExpr\(\)/g) || []).length));
check('🔴 谓词含「缺缩略图」条件', predBody.includes('has_thumbnail = 0'));
check('🔴 谓词含「缺 dhash」条件', predBody.includes('dhash IS NULL') && predBody.includes("TRIM(dhash) = ''"));
check('🔴 谓词含「缺尺寸」的两个条件（库里存的是 0 不是 NULL，只判 IS NULL 一张都命中不了）', predBody.includes('width IS NULL') && predBody.includes('width = 0'));

for (const method of [
  'getMissingThumbnailCount() {',
  'getPhotosMissingThumbnails(limit = 20000) {',
  'getPhotosMissingThumbnailsAfter(afterId, limit) {',
]) {
  const body = bodyOf(dbSrc, method);
  check('夹具自证：取到了 ' + method.split('(')[0] + ' 的函数体', body.length > 0);
  check('🔴 ' + method.split('(')[0] + ' 引用统一谓词（不自己再写一份）', body.includes('_sqlBackfillPendingExpr()'));
  check(
    method.split('(')[0] + ' 没有内联重复的待补条件',
    !body.includes('has_thumbnail = 0') && !body.includes('dhash IS NULL'),
  );
}

// ---------------------------------------------------- 2. 候选行必须带判断所需的列

const pickBody = bodyOf(dbSrc, 'getPhotosMissingThumbnailsAfter(afterId, limit) {');
for (const col of ['dhash', 'width', 'height']) {
  check(
    '🔴 候选查询 SELECT 带上 ' + col + '（少了它上层无法判断该不该跳过重算）',
    new RegExp('(^|[,\\s])' + col + '(\\s|,|$)', 'm').test(pickBody.split('FROM')[0]),
  );
}
check('候选查询仍按主键递增取（避免对失败记录死循环重试）', pickBody.includes('id > ?') && pickBody.includes('ORDER BY id ASC'));

// ---------------------------------------------------- 3. 读原图尺寸

const sizeFn = bodyOf(implSrc, 'async function readOriginalSize(', '\n}');
check('夹具自证：取到了 readOriginalSize 的函数体', sizeFn.length > 0);
check('readOriginalSize 用 sharp 的 metadata()', sizeFn.includes('.metadata()'));
check('🔴 readOriginalSize 只接受正尺寸（0 视为读不到）', sizeFn.includes('meta.width > 0') && sizeFn.includes('meta.height > 0'));
check('🔴 readOriginalSize 不碰 toBuffer 的 info（那是缩略图尺寸，会写错整库分辨率）', !sizeFn.includes('toBuffer'));
check('🔴 全文件不出现 resolveWithObject（防止有人改用 toBuffer 的 info 当原图尺寸）', !implSrc.includes('resolveWithObject'));
check('readOriginalSize 读失败时静默返回 null，不抛', sizeFn.includes('catch') && sizeFn.includes('return null'));

// ---------------------------------------------------- 4. processOne：同一实例、不做白工

const oneBody = bodyOf(implSrc, 'async function processOne(row) {');
check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);
check('processOne 会读取原图尺寸', oneBody.includes('readOriginalSize('));
check(
  '🔴 拿尺寸与生成缩略图共用同一个 sharp 实例（文件只打开一次）',
  /var instance = loadSharp\(\)\(row\.file_path/.test(oneBody) &&
    oneBody.includes('readOriginalSize(instance)') &&
    oneBody.includes('thumb = await instance'),
);
{
  const iInst = oneBody.indexOf('var instance = loadSharp()(');
  const iMeta = oneBody.indexOf('readOriginalSize(instance)');
  const iPipe = oneBody.indexOf('thumb = await instance');
  check('🔴 metadata 取在 resize 之前（同一实例），顺序不能颠倒', iInst >= 0 && iMeta > iInst && iPipe > iMeta);
}
check(
  '🔴 缺尺寸判定同时判 width 与 height（库里存 0，两个都要判）',
  /var needSize = [^;]*row\.width > 0[^;]*row\.height > 0/.test(oneBody),
);
check('视频不参与尺寸回填（sharp 读不了视频）', /var needSize = [^;]*!isVideo/.test(oneBody));
check(
  '🔴 dHash 已存在时跳过 computeDhash（否则扩谓词后会白全解码一整库）',
  oneBody.includes('row.dhash && String(row.dhash).trim()'),
);
check('isVideo 只算一次，不再散落重复调用', (oneBody.match(/isVideoPath\(/g) || []).length === 1);

// ---------------------------------------------------- 5. 写入：尺寸不降级

// 判据不是「某段文本里出现过守卫」，而是**逐处检查**：只要有一处 `updatePhotoDimensions`
// 不在「正尺寸」守卫之下，一次运行就足以把整库分辨率写成 0，而且不报任何错。
// 所以扫全文所有调用点，逐个回看它前面最近的那个守卫。
{
  const dimSites = [];
  {
    const re = /db\.updatePhotoDimensions\(/g;
    let m;
    while ((m = re.exec(implSrc)) !== null) dimSites.push(m.index);
  }
  check('夹具自证：main.js 里找得到 updatePhotoDimensions 调用点', dimSites.length > 0);
  const unguarded = dimSites.filter((i) => {
    const before = implSrc.slice(Math.max(0, i - 240), i);
    // 守卫的左花括号与被检查的调用之间不许再有别的语句（`[^{}]*$`）
    return !/if\s*\([^)]*width\s*>\s*0[^)]*height\s*>\s*0[^)]*\)\s*\{[^{}]*$/.test(before);
  });
  check(
    '🔴 每一处 updatePhotoDimensions 都在「正尺寸」守卫之下（不把已有真实值覆盖成 0）',
    unguarded.length === 0,
    unguarded.length ? '未受守卫的调用点偏移 ' + unguarded.join(',') : '',
  );
}

// ---------------------------------------------------- 6. 数据库侧的写入方法

check('database.js 提供 updatePhotoDimensions', dbSrc.includes('updatePhotoDimensions(photoId, width, height)'));
check(
  'updatePhotoDimensions 写的就是 photos 的 width / height 两列',
  dbSrc.includes('UPDATE photos SET width = ?, height = ? WHERE id = ?'),
);

// ---------------------------------------------------- 6b. 行为面：候选集必须真的会收敛

// 上面全是「读源码文本」的断言，而这次事故的教训正是**静态断言证明不了行为**：
// 契约曾经完整地写在孤儿文件里，文本断言 37 项全过，线上却一行尺寸都没写。
// 所以这里用真库把最致命的那条性质跑一遍：**补上尺寸之后，候选集必须缩小**。
// 这条性质一旦坏掉，症状是「进度条分母百万级、任务永远跑不完」，且没有任何报错。
{
  const os = require('node:os');
  const PhotoDatabase = require(path.join(ROOT, 'src', 'database.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-backfill-'));
  const dbPath = path.join(dir, 'photos.db');
  const dropDb = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
      } catch (e) {
        void e;
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch (e) {
      void e;
    }
  };

  let db = null;
  try {
    db = new PhotoDatabase(dbPath);
    const rootId = db.addRootFolder('C:\\meta\\root');
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

    // 三行**只缺尺寸**：有缩略图 + 有 dhash，正是原 bug 里永远出不了候选集的那一类
    for (let i = 1; i <= 3; i++) {
      const filePath = 'C:\\meta\\root\\f\\p' + i + '.jpg';
      db.insertPhoto({
        rootId,
        folderPath: 'C:\\meta\\root\\f',
        fileName: 'p' + i + '.jpg',
        filePath,
        fileSize: 10,
        fileType: 'jpg',
        width: 0,
        height: 0,
        dateTaken: '2026-01-01T00:00:00',
        dateModified: '2026-01-01T00:00:00',
        thumbnail: thumb,
        hasThumbnail: 1,
        thumbSize: 256,
        thumbFormat: 'jpeg',
      });
      db.updatePhotoDhash(i, '0000000000000000', [0], '2026-01-01T00:00:00', 10);
    }

    const before = db.getMissingThumbnailCount();
    check(
      '夹具自证：只有「缺尺寸」的行也计为待补（分母非零；否则下面那条断言没有意义）',
      before === 3,
      '实得 ' + before,
    );

    // 活代码 processOne 的写入端：拿到正尺寸才写
    for (let i = 1; i <= 3; i++) db.updatePhotoDimensions(i, 4000, 3000);

    const after = db.getMissingThumbnailCount();
    check(
      '🔴 行为面：补上尺寸后候选集收敛到 0（原 bug 的卡点就在这里 —— 不写尺寸则永不收敛）',
      after === 0,
      '实得 ' + after,
    );

    // 反向：写 0 的行必须**回到**候选集。否则「不降级」就退化成「假装补过就再也不过问」。
    db.updatePhotoDimensions(1, 0, 0);
    const afterZero = db.getMissingThumbnailCount();
    check(
      '行为面：尺寸被写成 0 的行重新回到候选集（0 视为缺失，不是「已补」）',
      afterZero === 1,
      '实得 ' + afterZero,
    );

    // 谓词口径：has_thumbnail / dhash 都在时，唯一决定因素就是尺寸
    const picked = db.getPhotosMissingThumbnailsAfter(0, 10);
    check(
      '夹具自证：候选查询返回的行确实带着 width / height / dhash 三列（上层靠它们判断该不该跳过重算）',
      picked.length === 1 &&
        'width' in picked[0] &&
        'height' in picked[0] &&
        'dhash' in picked[0],
      JSON.stringify(picked[0] || null),
    );
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // 不要把「跑不起来」伪装成通过：静默跳过的行为断言正是假绿的温床。
    check(
      '行为面：候选集收敛实验未抛错（若报 NODE_MODULE_VERSION，用 electron 跑本脚本，别用纯 node）',
      false,
      msg,
    );
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {
        void e;
      }
    }
    dropDb();
  }
}

// ---------------------------------------------------- 7. 登记进全量回归

check(
  '本守护已登记进 scripts/run-regressions.js',
  runSrc.includes("'photo-metadata-backfill-regression.js'"),
);

// ---------------------------------------------------------------------- 输出

process.stdout.write('[photo-metadata-backfill-regression] 照片元数据回填链路契约\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[photo-metadata-backfill-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write('\n[photo-metadata-backfill-regression] PASS（' + notes.length + ' 项）\n');
