'use strict';
/**
 * 「缩略图与 dHash 共用一次解码」回归（2026-10-06）。
 *
 * 背景：`main.js#processOne` 同一个文件既要生成缩略图、又要算 dHash。旧写法是
 * `sharp(path)` 出缩略图、再 `computeDhash(path)` —— **同一张图被完整解码两遍**。
 * 真机 40 张实测：53.9ms → 22.5ms，**省 58%**（这部分是纯白干的 CPU + 读盘）。
 * 修法：`perceptual-hash.js#computeDhashFromPipeline(pipeline)`，从已打开的管线 clone 出去。
 *
 * 2026-10-06 扩面 —— **再加一样产物：查重指纹（SHA-256）**。
 * 缩略图补全与「重复文件比对」在准入上**互斥**（`thumbnailBackfillBlockReason` /
 * `duplicateHashBlockReason` 互相拦截）⇒ 两者永远串行。而它们读的是同一个文件的同一份字节：
 * 补全这边 `sharp` 解码一遍，查重那边 `processDupHashRowsChunk` 再逐字节读一遍。
 * 现在 `processOne` 改成「一次 `readFile` 的 Buffer 同时喂 `sharp` 与 `crypto`」——
 * 一次读盘出**三样**（缩略图 / dHash / SHA-256）。CPU 侧几乎不增，省的是整次读盘。
 *
 * 这一扩面又带来两条必须钉住的静默失效（本脚本 [2b] / [2c] 两组）：
 *   - 候选 SELECT 少了 `file_hash` ⇒ 每行都判成「缺指纹」⇒ 对全库候选反复重算 SHA（白烧读盘）；
 *   - 前置的 `ensureDuplicateHashSchema()` 掉了 ⇒ 老库上取批那一刻 `no such column`，回填当场挂。
 *
 * 🔴 为什么这条必须被钉住（两处静默失效都足以毁掉数据）：
 *
 * 1. **dHash 是相似聚类的输入**。它不是「差不多的指纹」，而是阈值比较的**被减数**：
 *    位差会直接把阈值边缘的配对翻面（本机真实库就是 198 万行）。所以「共用解码」这条优化
 *    的**唯一合法性前提是逐位相同**。实测 40/40 相同 —— 本脚本把它变成每次 CI 都验的事实。
 *
 * 2. **顺序是承重墙**。`processOne` 里那个实例接下来要 `.rotate()`（缩略图要跟随 EXIF 方向），
 *    而 dHash 历来**不旋转**（旧路径 `computeDhash(row.file_path)` 就没有 `.rotate()`）。
 *    一旦有人把取 dHash 的语句挪到 `.rotate()` 之后，**带方向信息的照片会全部换一套位** ——
 *    不报错、不写日志，只是相似照片的判定从此不一样了。
 *    ⚠️ 受害面**仅限带 EXIF 方向**的照片：无方向的图 `.rotate()` 是空操作，位不变。
 *    本脚本两组期望值分开验，避免把「空操作」误读成「顺序无所谓」。
 *
 * 判定口径：静态部分走 **acorn 剥注释**（本文件与 `main.js` 的注释里都引用了 `.rotate()` 与
 * `computeDhash(row.file_path)` 这些旧写法，不剥注释就会假绿）；行为部分用**运行时生成的真图**
 * （含一张 EXIF orientation=6 的），不依赖仓库里任何二进制夹具。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main.js');
const DB = path.join(ROOT, 'src', 'database.js');
const HASH = path.join(ROOT, 'src', 'main', 'perceptual-hash.js');
const FILE_HASH = path.join(ROOT, 'src', 'main', 'file-hash.js');

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  \u2713 ' + name);
  } else {
    failed++;
    console.log('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 剥掉注释，但**保持长度与换行** —— 否则「这句代码在不在 `.rotate()` 之前」会被注释骗过去。
 * ⚠️ 走 acorn（它自己懂注释与正则字面量）：状态机版不认含引号的正则，会从那里错位。
 * 本项目已有先例，见 `face-order-regression.js:62`、`home-page-regression.js:67`。
 */
function stripComments(src) {
  const ranges = [];
  acorn.parse(src, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onComment: (block, text, start, end) => ranges.push([start, end]),
  });
  if (!ranges.length) return src;
  const parts = [];
  let cur = 0;
  for (const r of ranges) {
    parts.push(src.slice(cur, r[0]));
    parts.push(src.slice(r[0], r[1]).replace(/[^\n]/g, ' '));
    cur = r[1];
  }
  parts.push(src.slice(cur));
  return parts.join('');
}
function bodyOf(src, signature, tail) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const end = src.indexOf(tail || '\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}
/**
 * 取「从某个签名到另一个签名」之间的整段。
 *
 * ⚠️ `bodyOf` 对 `runThumbnailBackfill` **不能用**：那个函数体里 `try {` … `} finally {`
 * 的闭合括号本身就长在 2 列上，`'\n  }'` 会匹配到 `} finally` 那行，把 finally 整段切掉
 * —— 而「写了指纹就失效重复分组缓存」恰恰住在 finally 里，切掉了就变成假绿。
 */
function sliceBetween(src, fromSig, toSig) {
  const a = src.indexOf(fromSig);
  if (a < 0) return '';
  const b = src.indexOf(toSig, a + fromSig.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

// ============================================================ 1. 哈希核心必须同源

console.log('\n[1] 哈希核心只有一份');
{
  const hashSrc = stripComments(read(HASH));
  check(
    '夹具自证：acorn 确实剥掉了注释',
    !hashSrc.includes('一条硬约束') && !hashSrc.includes('逐位相同'),
  );
  check('hashFromRaw 存在（把 9×8 原始像素转 hex 的唯一入口）', /function hashFromRaw\s*\(/.test(hashSrc));

  const byPath = bodyOf(hashSrc, 'async function computeDhash(input) {', '\n}');
  const byPipeline = bodyOf(hashSrc, 'async function computeDhashFromPipeline(pipeline) {', '\n}');
  check('夹具自证：取到了两个函数的函数体', byPath.length > 0 && byPipeline.length > 0);
  check('🔴 两条路都调 hashFromRaw（否则位算法会各自漂）', 
    byPath.includes('hashFromRaw(raw)') && byPipeline.includes('hashFromRaw(raw)'),
  );
  check(
    '🔴 两条路用同一组算子（greyscale → resize(9,8,fill) → raw）',
    /greyscale\(\)[\s\S]*resize\(9, 8, \{ fit: 'fill' \}\)[\s\S]*\.raw\(\)/.test(byPath) &&
      /clone\(\)[\s\S]*greyscale\(\)[\s\S]*resize\(9, 8, \{ fit: 'fill' \}\)[\s\S]*\.raw\(\)/.test(byPipeline),
  );
  check(
    '🔴 computeDhashFromPipeline 内部 clone（不消费调用方那条管线）',
    byPipeline.includes('clone()'),
  );
  check(
    '🔴 两条路都**不许**出现 rotate（dHash 是不旋转的）',
    !byPath.includes('rotate') && !byPipeline.includes('rotate'),
  );
}

// ============================================================ 2. processOne 的取用姿势

console.log('\n[2] processOne 取 dHash 的位置');
{
  const mainSrc = stripComments(read(MAIN));
  check('夹具自证：main.js 剥注释后不再含那句提示性说明', !mainSrc.includes('否则带 EXIF 方向的照片'));

  const oneBody = bodyOf(mainSrc, 'async function processOne(row) {');
  check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);
  check(
    '🔴 缩略图分支里用 computeDhashFromPipeline(instance) 白用那次解码',
    oneBody.includes('computeDhashFromPipeline(instance)'),
  );
  check(
    '🔴 仍然保留按路径的回落（已有缩略图、只缺 dHash 的那一大批走它）',
    oneBody.includes('computeDhash(row.file_path)'),
  );
  check(
    '🔴 用「试过了」的标志位而非结果本身判（结果 null = 解码失败，也是试过了）',
    oneBody.includes('dhashDecodeUsed'),
  );

  // 顺序：取 dHash 必须早于 `.rotate()`
  // ⚠️ 锚点只钉到 `loadSharp()(` 为止，**不要**把入参也写进锚点：2026-10-06 起这里可能传入
  //    `sharedBuf || row.file_path`（共用一次读盘），写死入参会让这条断言在**没有任何真实回归**的
  //    情况下变红 —— 假红和假绿一样坏。位置关系（dHash 早于 .rotate()）才是它要守的东西。
  const iInst = oneBody.indexOf('var instance = loadSharp()(');
  const iDhash = oneBody.indexOf('computeDhashFromPipeline(instance)');
  const iRotate = oneBody.indexOf('.rotate()');
  check(
    '夹具自证：三个锚点都找得到（否则下面的顺序断言会假绿）',
    iInst >= 0 && iDhash >= 0 && iRotate >= 0,
    `inst=${iInst} dhash=${iDhash} rotate=${iRotate}`,
  );
  check(
    '🔴 dHash 取在 .rotate() 之前（dHash 不旋转；挪到后面会让带 EXIF 方向的照片全换一套位）',
    iInst >= 0 && iDhash > iInst && iRotate > iDhash,
    `inst=${iInst} dhash=${iDhash} rotate=${iRotate}`,
  );
  check(
    '🔴 needDhash 只算一次（不许在缩略图分支里重算一遍谓词）',
    (oneBody.match(/var needDhash =/g) || []).length === 1,
  );
}

// ============================================== 2b. 一次读盘出三样（缩略图 + dHash + SHA-256）

console.log('\n[2b] 缩略图补全顺带算查重指纹');
{
  const mainSrc = stripComments(read(MAIN));
  const oneBody = bodyOf(mainSrc, 'async function processOne(row) {');
  check('夹具自证：取到了 processOne 的函数体', oneBody.length > 0);

  check(
    '🔴 needHash 的判据读 row.file_hash（拿不到 ⇒ 对全库候选反复重算 SHA，白烧读盘）',
    /var needHash = [^\n]*row\.file_hash/.test(oneBody),
  );
  check(
    '🔴 共享读取有单文件上限（超大文件退回「各读各的」，内存是常数）',
    oneBody.includes('THUMB_SHARED_READ_MAX_BYTES') &&
      /var THUMB_SHARED_READ_MAX_BYTES = \d+ \* 1024 \* 1024;/.test(mainSrc),
  );
  check(
    '🔴 尺寸读取与缩略图解码都把**同一份 Buffer** 交给 sharp（`sharedBuf || row.file_path` ×2）',
    (oneBody.match(/loadSharp\(\)\(sharedBuf \|\| row\.file_path/g) || []).length === 2,
  );
  check(
    '🔴 有 sharedBuf 就对内存算 SHA，没有才回流式（两条路都必须留着）',
    oneBody.includes('hashBufferSha256(sharedBuf)') &&
      oneBody.includes('await hashFileSha256(row.file_path'),
  );
  check(
    '🔴 摘要写回 file_hash 那一列，参数与查重任务逐位一致',
    oneBody.includes('db.updatePhotoHash(row.id, digest, row.date_modified, row.file_size)'),
  );
  check(
    '🔴 顺序：读盘必须**紧挨在** sharp 打开文件之前（放后面 = sharp 已按路径读过一遍，共享读取白做）',
    /sharedBuf = await tryReadShared\(row\.file_path\);\s*\n\s*var instance = loadSharp\(\)\(sharedBuf \|\| row\.file_path/.test(
      oneBody,
    ),
  );

  const helper = bodyOf(mainSrc, 'async function tryReadShared(filePath) {');
  check('夹具自证：取到了 tryReadShared 的函数体', helper.length > 0);
  check(
    '🔴 读不到时返回 null 而**不抛**（抛出去 = 把「文件已不在磁盘」记成一次缩略图失败）',
    helper.includes('catch') && helper.includes('return null'),
  );
}

// ============================================== 2c. 数据库侧的接线不变量

console.log('\n[2c] 候选查询与延迟迁移列同生共死');
{
  const dbSrc = stripComments(read(DB));
  const mainSrc = stripComments(read(MAIN));

  const pickBody = bodyOf(dbSrc, 'getPhotosMissingThumbnailsBefore(beforeId, limit) {');
  check('夹具自证：取到了候选查询的函数体', pickBody.length > 0);
  check(
    '🔴 候选 SELECT 必须带 file_hash（processOne 靠它判 needHash）',
    /SELECT[\s\S]*\bfile_hash\b/.test(pickBody),
  );

  // `runThumbnailBackfill` 的 bodyOf 会被 `} finally {` 截断（见 sliceBetween 的注释）
  const preflight = sliceBetween(
    mainSrc,
    'async function runThumbnailBackfill(limit) {',
    '/** 并行算摘要：慢盘场景更保守',
  );
  check('夹具自证：取到了 runThumbnailBackfill 的整段（含 finally）', preflight.includes('finally'));
  check(
    '🔴 前置同批里同时 ensure dhash 与 duplicate-hash 两套列',
    preflight.includes('ensureDhashSchema') && preflight.includes('ensureDuplicateHashSchema'),
  );
  check(
    '🔴 列迁移必须早于第一次取批（`file_hash` / `dhash` 都是延迟迁移列，老库上少了就是 `no such column`）',
    preflight.indexOf('ensureDuplicateHashSchema') <
      preflight.indexOf('getPhotosMissingThumbnailsBefore'),
  );
  check(
    '🔴 顺带写了指纹就必须失效重复分组缓存（否则重复项页面显示旧结果 = 静默错数据）',
    preflight.includes('thumbnailBackfill.hashed') &&
      preflight.includes('clearDuplicateHashGroupsCache(') &&
      /if \(thumbnailBackfill\.hashed > 0\)/.test(preflight),
  );
}

// ============================================================ 3. 行为面：逐位相同

/** 造一张明显不对称的图（对称图旋转后可能恰好同值，会让「旋转会改变位」的断言失去意义） */
async function makeFixtures(dir) {
  const w = 240;
  const h = 180;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      // 横向渐变 + 几个不对称暗块（保证旋转后 9×8 的差值模式必然改变）
      let v = Math.round((x / (w - 1)) * 200) + 20;
      if (x > 20 && x < 60 && y > 110 && y < 160) v = 10;
      if (x > 150 && x < 200 && y > 15 && y < 45) v = 240;
      raw[i] = v;
      raw[i + 1] = Math.min(255, Math.round(v * 0.6) + 10);
      raw[i + 2] = Math.max(0, 240 - v);
    }
  }
  const base = path.join(dir, 'plain.jpg');
  const exif = path.join(dir, 'exif6.jpg');
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(base);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(exif);
  return { base, exif };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-phash-'));
  try {
    const { computeDhash, computeDhashFromPipeline } = require(HASH);
    check(
      '夹具自证：两个入口都导出了',
      typeof computeDhash === 'function' && typeof computeDhashFromPipeline === 'function',
    );

    const fx = await makeFixtures(tmp);

    console.log('\n[3] 共用解码的 dHash 必须逐位相同');
    // ⚠️ 「先 .rotate() 会换一套位」只在**带 EXIF 方向**的文件上成立 —— 无方向的图 `.rotate()`
    //    是空操作，位必然相同。这不是夹具缺陷，而正是风险的边界：受害面 = 全部带方向信息的照片。
    //    两组期望值刻意分开写，免得把「空操作」误当成「顺序无所谓」。
    for (const [label, file, rotateShouldChange] of [
      ['无 EXIF 方向', fx.base, false],
      ['EXIF orientation=6', fx.exif, true],
    ]) {
      const byPath = await computeDhash(file);
      const byPipeline = await computeDhashFromPipeline(sharp(file, { failOnError: false }));
      check(
        `🔴 ${label}：computeDhashFromPipeline 与 computeDhash 逐位相同`,
        !!byPath && byPath === byPipeline,
        `path=${byPath} pipeline=${byPipeline}`,
      );
      check(`${label}：dHash 是 16 位 hex`, /^[0-9a-f]{16}$/.test(byPath || ''), String(byPath));

      // 🔴 顺序的牙齿。
      const rotated = await computeDhashFromPipeline(sharp(file, { failOnError: false }).rotate());
      check(
        rotateShouldChange
          ? `🔴 ${label}：先 .rotate() 再算会得到不同的位（顺序是承重墙）`
          : `${label}：无方向信息时 .rotate() 是空操作，位不变（这是风险的边界）`,
        rotateShouldChange ? rotated && rotated !== byPipeline : rotated === byPipeline,
        `pipeline=${byPipeline} rotated=${rotated}`,
      );
    }

    check(
      'computeDhashFromPipeline 拿到 null 管线时返回 null，不抛',
      (await computeDhashFromPipeline(null)) === null,
    );
    check(
      'computeDhashFromPipeline 拿到坏路径时返回 null（不把异常抛给回填循环）',
      (await computeDhashFromPipeline(sharp(path.join(tmp, 'nope.jpg'), { failOnError: false }))) ===
        null,
    );

    // ---------------------------------------------------------------- 3b. 共用读取
    // 🔴 这条是「一次读盘出三样」的**唯一合法性前提**：把同一份 Buffer 交给 sharp，
    //    产物必须与「按路径打开」逐位/逐字节相同。差一个字节，缩略图会变、dHash 会翻面。
    console.log('\n[3b] 共用读取：Buffer 路径的产物必须与按路径逐位相同');
    const fileHash = require(FILE_HASH);
    check(
      '夹具自证：摘要模块两个入口都导出（且不依赖 electron，所以能在这里真跑）',
      typeof fileHash.hashFileSha256 === 'function' &&
        typeof fileHash.hashBufferSha256 === 'function',
    );

    const THUMB = { size: 256, quality: 80 };
    // 与 processOne 里那条缩略图管线**同一组算子**（精度比它低一档不影响的都照抄）
    const thumbOps = (input) =>
      sharp(input, { failOnError: false })
        .rotate()
        .resize(THUMB.size, THUMB.size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: THUMB.quality })
        .toBuffer();

    for (const [label, file] of [
      ['无 EXIF 方向', fx.base],
      ['EXIF orientation=6', fx.exif],
    ]) {
      const buf = fs.readFileSync(file);

      const thumbByPath = await thumbOps(file);
      const thumbByBuf = await thumbOps(buf);
      check(
        `🔴 ${label}：从 Buffer 解码的缩略图与按路径**逐字节相同**`,
        thumbByPath.equals(thumbByBuf),
        `path=${thumbByPath.length}B buf=${thumbByBuf.length}B`,
      );

      const metaByPath = await sharp(file, { failOnError: false }).metadata();
      const metaByBuf = await sharp(buf, { failOnError: false }).metadata();
      check(
        `🔴 ${label}：原图尺寸两条路一致（${metaByPath.width}×${metaByPath.height}）`,
        metaByPath.width === metaByBuf.width && metaByPath.height === metaByBuf.height,
        `path=${metaByPath.width}×${metaByPath.height} buf=${metaByBuf.width}×${metaByBuf.height}`,
      );

      const dhashByBuf = await computeDhashFromPipeline(sharp(buf, { failOnError: false }));
      check(
        `🔴 ${label}：Buffer 路径的 dHash 与按路径逐位相同`,
        !!dhashByBuf && dhashByBuf === (await computeDhash(file)),
        `path=${await computeDhash(file)} buf=${dhashByBuf}`,
      );

      const hByFile = await fileHash.hashFileSha256(file);
      const hByBuf = fileHash.hashBufferSha256(buf);
      check(
        `🔴 ${label}：流式读与内存 Buffer 两条路的 SHA-256 逐字符相同`,
        hByFile === hByBuf && /^[0-9a-f]{64}$/.test(hByFile),
        `file=${hByFile} buf=${hByBuf}`,
      );
    }

    // 负例：内容变了摘要必须变 —— 否则上面那句「相同」可能只是恒真断言（两边都返回空串也会过）
    check(
      '🔴 负例：内容多一个字节摘要必须变（证明上一条不是恒真）',
      fileHash.hashBufferSha256(Buffer.concat([fs.readFileSync(fx.base), Buffer.from([0])])) !==
        fileHash.hashBufferSha256(fs.readFileSync(fx.base)),
    );
    check(
      '负例：不存在的文件，流式那条必须 reject（不能被静默当成空文件）',
      await fileHash
        .hashFileSha256(path.join(tmp, 'definitely-missing.jpg'))
        .then(() => false)
        .catch(() => true),
    );
  } catch (e) {
    failed++;
    console.log('  \u2717 运行时异常: ' + (e && e.stack ? e.stack : String(e)));
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      void e;
    }
  }

  console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
