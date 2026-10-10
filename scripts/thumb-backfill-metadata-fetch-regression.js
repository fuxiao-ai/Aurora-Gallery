'use strict';

/**
 * 「补全第二趟取批不再把主线程堵两分半」的守护（2026-10-07）。
 *
 * ## 它守的是什么事故
 *
 * `getPhotosMissingThumbnailsBefore()` 是全工程**唯一一条「谓词完全无索引可依 + 倒序 LIMIT」**
 * 的取批 ⇒ 计划恒为 `SEARCH photos USING INTEGER PRIMARY KEY (rowid<?)`，代价 = 游标到第一个
 * 命中行的**距离**，而不是批大小。真库（1,656,580 行）实测：
 *
 * - id 1,181,504 以上共 **80 万行「候选 = 0」**（早补完了），而第二趟每轮都从 `MAX(id)+1` 起手；
 * - ⇒ **每轮白扫 75.7 万行回表 = 159,601 ms**，而且这句跑在**主进程**（`better-sqlite3` 同步）；
 * - ⇒ `startup-performance.json` 打点断档 12,786 → 173,311 ms、`eventLoop.maxDelayMs = 159699`、
 *   界面整整卡死两分半（对照：第一趟走 `idx_photos_hasThumb` = **8 ms**）。
 *
 * 非单调 ⇒ **不会自愈**：候选上界随补全推进逐轮下移，白扫只会越来越长。
 *
 * ## 钉住的五件事
 *
 * ① **口径零变化**：`_sqlBackfillPendingExpr() ⟹ _sqlBackfillPendingCoreExpr()`（逐支逐字），
 *    所以把 CORE 当冗余合取项加进 WHERE 不改变结果集 —— 这一点必须由**活代码**证明，
 *    不能靠注释（改了任一谓词而没同步，那个合取项就从「冗余」变成「改口径」）。
 * ② **只建索引不够**：索引存在、WHERE 不动时计划**仍是**老形状（部分索引要求「查询 WHERE 蕴含
 *    索引 WHERE」，而那个四支 OR + 逐支 residual 的形状规划器证不出来）。
 * ③ **新索引不许把既有查询带偏**：`getPhotosLackingThumbnailBefore()` 的 WHERE 同样蕴含 CORE
 *    ⇒ 规划器可以合法改用它，而两者条目数差三个数量级（真库 ≈0 vs ≈86 万）⇒ 必须钉 `INDEXED BY`；
 *    `countPhotosLackingThumbnail()` 则必须仍走 `idx_photos_hasThumb`。
 * ④ **闸门**：`idx_photos_missing_thumb` 是启动期 worker 建的 ⇒ 它不在时**不许**加 `INDEXED BY`
 *    （指向不存在的索引是 `no query solution` 报错，不是变慢）。
 * ⑤ **`rebuildOnChange` 要真生效**（第 11 组，跑真 worker 的**行为**断言）：这条 DDL 里烤了
 *    `EXIF_SCHEMA_VERSION` ⇒ 升版后 `IF NOT EXISTS` 会留下**旧定义**的索引、蕴含证不出来、第二趟
 *    静默退回全表扫。⚠️ 这里埋着一个陷阱：**SQLite 存 `sqlite_master.sql` 时会剥掉 `IF NOT EXISTS`**
 *    ⇒ worker 侧比较前必须也剥，否则库里那条永远「等于不了」清单 DDL ⇒ **每次启动都白重建几分钟**。
 *    反向断言（定义没变时零打点）就是专门抓这个的，去掉剥除当场变红。
 *
 * 🔴 夹具**不抄 SQL**：取批语句是从活代码 `db.prepare` 上**截获**的（`capturePrepareSql`），
 *    索引 DDL 取自 `PHASE5_INDEXES`，`idx_photos_missing_thumb` 的 DDL 从
 *    `thumbnail-fix-worker.js` 源码里抠出来。抄一份就等于给「两边悄悄漂开」留门。
 *
 * 跑法：`node scripts/run-regressions.js`（或单独
 * `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/thumb-backfill-metadata-fetch-regression.js`）
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const PhotoDatabase = require('../src/database');
const heavy = require('../src/db-heavy-read');
const deferredIndexes = require('../src/main/deferred-indexes');

const ROOT = path.join(__dirname, '..');

/**
 * 真跑一遍 `deferred-index-worker`（它别无入口，只有 worker 形态）。
 *
 * ⚠️ 必须**同时**收 `message`（那才是结果）与 `__progress` 打点：worker 末尾是
 *    `postMessage(results)` + `process.exit(0)`，只等 `exit` 会丢掉结果，只等 `message`
 *    又可能拿不到后续打点 —— 两条都要。
 */
function runDeferredIndexWorker(dbPath) {
  return new Promise((resolve, reject) => {
    const progress = [];
    const worker = new Worker(path.join(ROOT, 'src', 'workers', 'deferred-index-worker.js'), {
      workerData: { dbPath },
    });
    // 🔴 为什么需要这个标志：**`worker.terminate()` 会把退出码变成 1**（Node 的既定行为），
    //    所以「已经拿到结果、是我们主动掐掉的」这种情况绝不能按非零退出判失败 ——
    //    否则守护会在最后一步假红，看起来像 worker 崩了。
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    worker.on('message', (msg) => {
      if (msg && msg.__progress) {
        progress.push(msg);
        return;
      }
      if (settled) return;
      settled = true;
      worker.terminate().finally(() => resolve({ results: msg, progress }));
    });
    worker.on('error', fail);
    worker.on('exit', (code) => {
      if (settled || code === 0) return;
      // 只可能是真崩（例如 `!dbPath` 那条 `process.exit(1)`）—— 此时根本没拿到结果
      fail(new Error('deferred-index-worker exited: ' + code));
    });
  });
}

function planOf(db, sql, params) {
  return db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(params || [])
    .map((row) => row.detail)
    .join(' | ');
}

/**
 * 截获「某个方法真正 prepare 出去的 SQL」—— 这样断言的是**活代码**，不是回归里手抄的一份。
 *
 * ⚠️ 必须 `delete` 掉临时装的属性而不是赋回原函数：`prepare` 住在 `Database.prototype` 上，
 * 赋回一个 own property 会把原型链上的方法**永久遮住**，同一个连接后续的所有 prepare 都
 * 走我们那份包装（回归里出过一次这种「测试污染」）。
 */
function capturePrepareSql(target, run) {
  const seen = [];
  const original = target.prepare.bind(target);
  target.prepare = (sql) => {
    seen.push(String(sql));
    return original(sql);
  };
  try {
    run();
  } finally {
    delete target.prepare;
  }
  return seen;
}

/**
 * DDL 的「形态无关」比较口径：折叠空白 + 剥掉 `IF NOT EXISTS`。
 *
 * ⚠️ **必须剥**：SQLite 存进 `sqlite_master.sql` 时会删掉 `IF NOT EXISTS` 这半句
 *    （官方规范化规则之一）。拿库里那条跟清单里的 DDL 逐字比，差的就是这一句 ⇒ 断言假红。
 * ⚠️ 但**只剥这一句**：`IFNULL(exif_ver, 0) < 1` 与 `< 2` 这种**实质**差异必须留在比较里，
 *    否则「定义变了要重建」这条断言会被抹平成空过。
 */
function canonicalIndexSql(sql) {
  return String(sql || '')
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function removeTemporaryDirectory(directory) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** `idx_photos_missing_thumb` 的 DDL：从它真正的建索引处抠出来（不许手抄）。 */
function missingThumbIndexSql() {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'workers', 'thumbnail-fix-worker.js'),
    'utf8',
  );
  const m = src.match(/'(CREATE INDEX IF NOT EXISTS idx_photos_missing_thumb [^']*)'/);
  assert.ok(
    m,
    '哨兵：没在 `thumbnail-fix-worker.js` 里找到 `idx_photos_missing_thumb` 的 DDL —— ' +
      '它搬走或被改写就必须同步本文件，否则下面所有「钉住」断言都是空跑',
  );
  return m[1];
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mb-fetch-'));
  const dbPath = path.join(dir, 'fixture.db');
  let db = null;
  try {
    // ── 0. 跨文件同源（不跑库就能抓的漂移） ────────────────────────────────────
    const pendingEntry = deferredIndexes.PHASE5_INDEXES.find(
      (i) => i.name === heavy.BACKFILL_PENDING_INDEX,
    );
    assert.ok(
      pendingEntry,
      '哨兵：Phase 5 必须含补全候选索引 ' + heavy.BACKFILL_PENDING_INDEX,
    );
    assert.equal(pendingEntry.name, 'idx_photos_backfill_pending', '索引名必须逐字一致');
    assert.ok(
      pendingEntry.sql.includes(' WHERE ' + heavy.BACKFILL_PENDING_CORE_PRED),
      '索引 DDL 的 WHERE 必须逐字来自 `db-heavy-read#BACKFILL_PENDING_CORE_PRED`：' +
        pendingEntry.sql,
    );
    assert.equal(
      pendingEntry.rebuildOnChange,
      true,
      '🔴 这条 DDL 里烤了 `EXIF_SCHEMA_VERSION` ⇒ 必须带 rebuildOnChange，否则升版后留下的旧定义 ' +
        '会让蕴含证不出来、第二趟**静默**退回全表扫',
    );
    assert.ok(
      pendingEntry.sql.includes('IFNULL(exif_ver, 0) < ' + heavy.EXIF_SCHEMA_VERSION),
      '哨兵：索引 WHERE 里的版本号必须与 EXIF_SCHEMA_VERSION 同源（两边各抄一份 = 升版即静默失效）',
    );
    assert.ok(
      fs
        .readFileSync(path.join(ROOT, 'src', 'workers', 'deferred-index-worker.js'), 'utf8')
        .includes('entry5.rebuildOnChange === true'),
      '哨兵：worker 必须真的把 rebuildOnChange 传下去（只写在清单里不会生效）',
    );

    db = new PhotoDatabase(dbPath);
    // `dhash` 是延迟迁移列（`_sqlBackfillPendingExpr()` 引用它）⇒ 夹具必须先 ensure，
    // 与生产路径同构（补全任务开跑前也这么干）。
    db.ensureDhashSchema();
    db.ensureDuplicateHashSchema();

    // ── 1. CORE 与完整谓词的同源：**逐支逐字** ────────────────────────────────
    const pred = db._sqlBackfillPendingExpr();
    const core = db._sqlBackfillPendingCoreExpr();
    assert.equal(
      core,
      heavy.BACKFILL_PENDING_CORE_PRED,
      '`database.js` 必须直接返回共享常量，不许自己拼一份',
    );
    // 完整谓词的四支「核心」必须**逐字**出现在 CORE 里 —— 这是「加进 WHERE 只是冗余项」
    // 的**唯一**依据。任何一支改了而 CORE 没跟上，加进去就变成改口径（结果集不再相等）。
    for (const piece of [
      'has_thumbnail = 0',
      "dhash IS NULL OR TRIM(dhash) = ''",
      'width IS NULL OR width = 0',
      db._sqlNeedsExifExpr(),
      db._sqlFileTypeIsImageExpr(),
    ]) {
      assert.ok(
        core.includes(piece),
        `🔴 CORE 里必须**逐字**含完整谓词的这一支：${piece}\n   实际 CORE = ${core}`,
      );
      assert.ok(pred.includes(piece), `完整谓词里也必须含它（哨兵，夹具自证）：${piece}`);
    }
    assert.ok(
      core.includes(' OR (') && core.indexOf(db._sqlFileTypeIsImageExpr()) > core.indexOf('have'),
      '哨兵：CORE 的后三支必须被 is_image 门住（否则真库 26,609 个视频永久留在索引里，' +
        '倒序扫到它们就逐个回白表）',
    );

    // ── 2. 夹具：高位已补完（含视频）、低位才是候选（复刻真库那份分布） ────────────
    const rootId = db.addRootFolder('C:\\mb\\root');
    const folderPath = 'C:\\mb\\root\\f';
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const FILLED = 800;
    const TOTAL = 1200;
    const base = {
      rootId,
      folderPath,
      fileSize: 11,
      dateTaken: '2026-01-01T00:00:00',
      dateModified: '2026-01-01T00:00:00',
    };
    for (let i = 1; i <= TOTAL; i++) {
      const isVideo = i > TOTAL - FILLED && i % 100 === 0; // 高位掺视频（dhash 恒 NULL）
      const filled = i > TOTAL - FILLED;
      const name = (isVideo ? 'clip' : 'p') + i + (isVideo ? '.mp4' : '.jpg');
      db.insertPhoto(
        Object.assign({}, base, {
          fileName: name,
          filePath: folderPath + '\\' + name,
          fileType: isVideo ? 'mp4' : 'jpg',
          width: filled ? 4032 : 0,
          height: filled ? 3024 : 0,
          thumbnail: thumb,
          hasThumbnail: 1,
          thumbSize: 256,
          thumbFormat: 'jpeg',
        }),
      );
      if (filled && !isVideo) {
        // 「已补完」= dHash / 尺寸 / 拍摄参数三样都齐
        db.db
          .prepare(
            'UPDATE photos SET dhash = ?, exif_mtime = ?, exif_ver = ? WHERE file_path = ?',
          )
          .run('000000000000000f', '2026-01-01T00:00:00', heavy.EXIF_SCHEMA_VERSION, folderPath + '\\' + name);
      }
    }
    const cursor = db.getMaxPhotoId() + 1;
    assert.ok(cursor > TOTAL, '哨兵：游标起手必须比 MAX(id) 大一格');

    // ── 3. 截获活代码真正 prepare 的两条取批 SQL ──────────────────────────────
    const metaSqls = capturePrepareSql(db.db, () => db.getPhotosMissingThumbnailsBefore(cursor, 100));
    assert.equal(metaSqls.length, 1, '哨兵：第二趟取批应当只 prepare 一次：' + metaSqls.length);
    const metaSql = metaSqls[0];
    assert.ok(
      metaSql.includes(core) && metaSql.includes(pred),
      '🔴 第二趟取批的 WHERE 必须同时带 CORE（冗余合取项）与完整谓词：' + metaSql,
    );
    assert.ok(metaSql.startsWith('SELECT'), '哨兵：截获到的应当是 SELECT');
    // 「旧写法」= 把那个冗余合取项去掉 —— 用来证明「只建索引、不动谓词」不够
    const legacySql = metaSql.replace(core + ' AND ', '');
    assert.notEqual(legacySql, metaSql, '哨兵：没能从截获到的 SQL 里剥掉 CORE 合取项');
    assert.ok(
      !legacySql.includes(core),
      '哨兵：剥完之后不该还留着 CORE：' + legacySql,
    );

    // ⚠️ 第一趟那条会多 prepare 一次 `sqlite_master`（`heavy.hasIndex()` 的存在性探测）
    //    ⇒ 按 `FROM photos` 过滤，别用 `length === 1`。
    const firstSqls = capturePrepareSql(db.db, () => db.getPhotosLackingThumbnailBefore(cursor, 100));
    const firstSql = firstSqls.find((s) => /FROM photos/.test(s));
    assert.ok(
      firstSql,
      '哨兵：没截获到第一趟取批的 SQL。截到的分别是：' + JSON.stringify(firstSqls),
    );

    // ── 4. 建索引之前：两条取批都必须是「逐行回表」的老形状 ─────────────────────
    const metaBefore = planOf(db.db, metaSql, [cursor, 100]);
    assert.match(
      metaBefore,
      /SEARCH photos USING INTEGER PRIMARY KEY \(rowid<\?\)/,
      '哨兵：索引未就绪时第二趟必须还是那条全表回表扫（否则后面的「翻转」无法证伪）：' + metaBefore,
    );
    const firstBefore = planOf(db.db, firstSql, [cursor, 100]);
    assert.match(
      firstBefore,
      /idx_photos_hasThumb|idx_photos_missing_thumb/,
      '哨兵：索引未就绪时第一趟应当走缩略图那条索引：' + firstBefore,
    );

    // ── 5. 只建索引、谓词不动 ⇒ 计划**不许**翻转（「只建索引不够」的证据） ───────
    db.db.exec(pendingEntry.sql);
    assert.ok(
      db.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?")
        .get(pendingEntry.name),
      '哨兵：索引必须真的建出来，否则下面全是空跑',
    );
    const legacyWithIndex = planOf(db.db, legacySql, [cursor, 100]);
    assert.match(
      legacyWithIndex,
      /SEARCH photos USING INTEGER PRIMARY KEY \(rowid<\?\)/,
      '🔴 「只建索引、不改谓词」时计划必须**仍是**老形状 —— 这条是这次修复的核心证据：' +
        '部分索引要求「查询的 WHERE 蕴含索引的 WHERE」，而四支 OR + 逐支 residual 那个形状规划器证不出来：' +
        legacyWithIndex,
    );

    // ── 6. 索引 + CORE 合取项 ⇒ 走部分索引倒序扫（收敛区零条目 ⇒ 零回表） ────────
    const metaAfter = planOf(db.db, metaSql, [cursor, 100]);
    assert.match(
      metaAfter,
      /SEARCH photos USING INDEX idx_photos_backfill_pending \(id<\?\)/,
      '第二趟取批必须走补全候选部分索引（否则真库每轮白扫 75.7 万行回表 = 159.6 s 主线程阻塞）：' +
        metaAfter,
    );
    assert.ok(
      !/USING INTEGER PRIMARY KEY/.test(metaAfter),
      '不许还是逐行回表扫：' + metaAfter,
    );

    // ── 7. 口径零变化：新写法与旧写法必须**逐行相同** ──────────────────────────
    const idsVia = (sql, beforeId) =>
      db.db
        .prepare(sql)
        .all(beforeId, 100)
        .map((r) => r.id);
    let compared = 0;
    for (const beforeId of [cursor, TOTAL - FILLED + 1, TOTAL - FILLED, 500, 2, 1, 0, -1]) {
      assert.deepEqual(
        idsVia(metaSql, beforeId),
        idsVia(legacySql, beforeId),
        `🔴 beforeId=${beforeId}：加了 CORE 合取项之后结果集变了 —— 那就不是冗余项，是改口径`,
      );
      compared++;
    }
    assert.ok(compared >= 6, '哨兵：对照的边界数太少');
    // 非空证明：不拿一组全空的结果自证
    assert.ok(
      idsVia(metaSql, cursor).length > 0,
      '哨兵：夹具必须真的被取出候选行，否则「逐行相同」是拿两个空集在自证',
    );

    // ── 8. 反向对照：新索引不许把既有查询带偏 ────────────────────────────────
    db.db.exec(missingThumbIndexSql()); // 启动期 worker 建的那条（DDL 从源码抠）
    heavy.clearIndexCache(db.db); // 上面的 prepare 可能已经把「不存在」缓存进去了
    const firstAfter = capturePrepareSql(db.db, () => db.getPhotosLackingThumbnailBefore(cursor, 100)).find(
      (s) => /FROM photos/.test(s),
    );
    assert.ok(firstAfter, '哨兵：没截获到第一趟取批的 SQL');
    assert.match(
      firstAfter,
      /INDEXED BY idx_photos_missing_thumb/,
      '🔴 第一趟取批必须钉住 `idx_photos_missing_thumb`：它的 WHERE 同样蕴含 CORE，' +
        '不钉就会被条目数多三个数量级的新索引带偏（真库 8 ms → 外推 ~200 s）',
    );
    const firstPlan = planOf(db.db, firstAfter, [cursor, 100]);
    assert.match(
      firstPlan,
      /USING INDEX idx_photos_missing_thumb/,
      '第一趟取批必须真的走那条索引：' + firstPlan,
    );
    assert.ok(
      !/idx_photos_backfill_pending/.test(firstPlan),
      '🔴 第一趟取批绝不许走补全候选索引（真库该索引条目 ≈86 万 vs ≈0）：' + firstPlan,
    );

    const lackPlan = planOf(db.db, 'SELECT COUNT(*) AS count FROM photos WHERE has_thumbnail = 0', []);
    assert.match(
      lackPlan,
      /idx_photos_hasThumb/,
      '🔴 `countPhotosLackingThumbnail()` 必须仍走 `idx_photos_hasThumb`（覆盖、零回表）：' +
        '若被新索引抢走，就要为 165 万行里的每一行回表确认 has_thumbnail：' +
        lackPlan,
    );

    // ── 9. 闸门：索引不在时不许加 `INDEXED BY`（指向不存在的索引是报错，不是变慢） ──
    db.db.exec('DROP INDEX IF EXISTS idx_photos_missing_thumb');
    heavy.clearIndexCache(db.db);
    const gatedSql = capturePrepareSql(db.db, () => db.getPhotosLackingThumbnailBefore(cursor, 100)).find(
      (s) => /FROM photos/.test(s),
    );
    assert.ok(gatedSql, '哨兵：没截获到第一趟取批的 SQL');
    assert.ok(
      !/INDEXED BY/.test(gatedSql),
      '🔴 索引不存在时绝不许加 `INDEXED BY`（会直接 `no query solution`）：' + gatedSql,
    );
    assert.doesNotThrow(
      () => db.getPhotosLackingThumbnailBefore(cursor, 100),
      '索引缺席时取批必须照常可用（退回规划器自选）',
    );

    // ── 10. 源码哨兵：别有人「顺手清理」掉那个看起来冗余的合取项 ────────────────
    const dbSrc = fs.readFileSync(path.join(ROOT, 'src', 'database.js'), 'utf8');
    const from = dbSrc.indexOf('getPhotosMissingThumbnailsBefore(beforeId, limit) {');
    assert.ok(from > 0, '哨兵：没找到第二趟取批的函数体');
    const body = dbSrc.slice(from, dbSrc.indexOf('\n  }\n', from));
    assert.ok(
      body.includes('_sqlBackfillPendingCoreExpr()'),
      '🔴 第二趟取批里那个「冗余」合取项不是装饰：去掉它计划就退回逐行回表扫（159.6 s 主线程阻塞）',
    );
    assert.ok(body.includes('_sqlBackfillPendingExpr()'), '完整谓词当然还要在');
    const firstFrom = dbSrc.indexOf('getPhotosLackingThumbnailBefore(beforeId, limit) {');
    assert.ok(firstFrom > 0, '哨兵：没找到第一趟取批的函数体');
    const firstBody = dbSrc.slice(firstFrom, dbSrc.indexOf('\n  }\n', firstFrom));
    assert.ok(
      firstBody.includes('heavy.MISSING_THUMB_INDEX'),
      '🔴 第一趟取批的 `INDEXED BY` 不许被删（不带它就会被新索引带偏到 86 万条目上）',
    );

    // ── 11. `rebuildOnChange` 的**行为**（不是源码正则）：定义变了必须真重建 ────────
    // 这条守的是一个纯静默的失败：`IF NOT EXISTS` 只认名字、不认定义 ⇒ 升 `EXIF_SCHEMA_VERSION`
    // 之后库里留下的是**旧定义**的索引，而查询要的是新定义 ⇒ 蕴含证不出来 ⇒ 第二趟又退回
    // 全表扫（界面再卡两分半），而 `sqlite_master` 里那条索引看起来一切正常。
    const staleSql = pendingEntry.sql.replace(
      'IFNULL(exif_ver, 0) < ' + heavy.EXIF_SCHEMA_VERSION,
      'IFNULL(exif_ver, 0) < ' + (heavy.EXIF_SCHEMA_VERSION - 1),
    );
    assert.notEqual(staleSql, pendingEntry.sql, '哨兵：没能造出「旧定义」的 DDL');
    db.db.exec('DROP INDEX IF EXISTS ' + pendingEntry.name);
    db.db.exec(staleSql);
    // 索引名唯一 ⇒ 库里那条必然是刚建的；`null` 说明连建都没建出来（比一条 diff 更直白）
    const storedOf = () => {
      const row = db.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?")
        .get(pendingEntry.name);
      return row ? canonicalIndexSql(row.sql) : null;
    };
    assert.equal(
      storedOf(),
      canonicalIndexSql(staleSql),
      '哨兵：旧定义的索引要真的建出来（比较用 canonicalIndexSql：SQLite 会剥掉 IF NOT EXISTS）',
    );
    // 光比全文不够 —— 上面的归一化若被放宽（比如顺手也剥掉比较运算符），这条重建断言会静默变成空过。
    // 这里再钉一次**那个真正会变的字面量**：旧定义必须是 `< EXIF_SCHEMA_VERSION - 1`。
    assert.ok(
      storedOf().includes('IFNULL(exif_ver, 0) < ' + (heavy.EXIF_SCHEMA_VERSION - 1)),
      '哨兵：造出来的旧定义里必须真的是上一个 EXIF_SCHEMA_VERSION',
    );

    const firstRun = await runDeferredIndexWorker(dbPath);
    assert.equal(
      storedOf(),
      canonicalIndexSql(pendingEntry.sql),
      '🔴 定义变了必须 DROP + CREATE（否则升版后留下旧定义 ⇒ 蕴含证不出来 ⇒ 第二趟静默退回全表扫）',
    );
    assert.ok(
      storedOf().includes('IFNULL(exif_ver, 0) < ' + heavy.EXIF_SCHEMA_VERSION),
      '🔴 重建之后库里必须是**新版**定义（`< ' + heavy.EXIF_SCHEMA_VERSION + '`）',
    );
    assert.equal(
      firstRun.results.phase5[pendingEntry.name],
      'ok',
      'worker 必须报告这条建成功：' + JSON.stringify(firstRun.results.phase5),
    );
    assert.ok(
      firstRun.progress.some((p) => p.kind === 'done' && p.name === pendingEntry.name),
      '真重建时应当有 start/done 打点（否则「重建了」在 startup-performance.json 里查不到）',
    );

    // 反向：定义已经正确时**不许**重建（否则每次启动都白花几分钟建整条索引）
    const secondRun = await runDeferredIndexWorker(dbPath);
    assert.equal(storedOf(), canonicalIndexSql(pendingEntry.sql), '第二次之后定义仍应正确');
    assert.deepEqual(
      secondRun.progress.filter((p) => p.name === pendingEntry.name),
      [],
      '🔴 定义没变时不许再动这条索引（`IF NOT EXISTS` 秒过、零打点）；真重建一次要几分钟',
    );

    console.log('[thumb-backfill-metadata-fetch-regression] PASS');
  } finally {
    if (db) db.close();
    await removeTemporaryDirectory(dir);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
