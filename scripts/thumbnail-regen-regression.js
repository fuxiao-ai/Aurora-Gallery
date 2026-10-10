#!/usr/bin/env node
'use strict';

/**
 * 缩略图**全量重建**回归（2026-10-07）。
 *
 * 守的是「把已入库的缩略图按新档位 / 新编码整体重跑一遍」这条链路 —— 它由三块拼起来：
 *   ① **队列表** `thumb_regen_queue` + 单行 meta（`src/main/thumb-regen-queue.js` 是 SQL 的唯一真相源）；
 *   ② 登记 / 抽干两趟循环（`src/main.js`）；
 *   ③ 设置页那一行状态 + 两个按钮。
 *
 * 为什么值得一条独立守护（每一条都是「不报错、只是结果错」的失效）：
 *   · **取批里混回规格谓词** ⇒ 代价从 ∝ 批大小变成 ∝ 白扫距离。补全那边真库实测单批 159.6 s
 *     主进程阻塞，就是这条谓词干的（见 `docs/contracts/thumbnail-backfill.md`）。
 *   · **登记谓词与计数谓词漂开** ⇒ 设置页说「还有 N 张」、任务实际处理 M 张，两个数谁也不等于谁。
 *   · **档位清单三份副本漂开** ⇒ 下拉里选得到 512、落库被 clamp 回 256，界面「选了个寂寞」。
 *   · **准入判据写两份** ⇒ IPC 返回 `success:true`、任务静默不跑，用户看到「点了没反应」。
 *   · **空闲态读数去数队列** ⇒ 设置页每打开一次就整表扫一遍（百万行）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const acorn = require('acorn');

const PhotoDatabase = require('../src/database');
const thumbFormat = require('../src/main/thumb-format');
const thumbRegenQueue = require('../src/main/thumb-regen-queue');

const ROOT = path.join(__dirname, '..');

let checks = 0;
function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error('FAIL: ' + message);
}

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** acorn 解析（先 script 再 module —— 别让一条 import 把守护打瞎，与 `thumbnail-spec-regression` 同实现）。 */
function parse(src, file) {
  try {
    return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (eScript) {
    try {
      return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (eModule) {
      throw new Error('无法解析 ' + file + '：' + eModule.message, { cause: eModule });
    }
  }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walk(node[key], visit);
  }
}

/**
 * 🔴 负向断言（「这里不许出现 X」）必须在**剥掉注释**之后做：注释里写代码字面量
 *    是最自然的解释手段（本项目就有一处 `// 上面刚刚 \`.jpeg()\` 出这个 Buffer`），
 *    不剥就会把注释当成代码、报出「出现了裸的 .jpeg()」这种假红。
 *    与 `db-write-priority-regression.js` / `maintenance-guard-regression.js` 同一套实现。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 用 acorn 的**注释区间**精确剥注释（剥掉的部分补等长空格，偏移不变）。
 *
 * 🔴 **别把上面那个正则版的结果拿去 `parse()`**（2026-10-08 实测）：它按 `//` 截到行尾，
 *    遇到字符串 / 正则字面量里的 `//` 会把后面的内容一起吃掉 —— 在 `src/main.js` 上
 *    直接解析成 `Unterminated regular expression`。本工程元规则本来就写着
 *    「结构断言不许读注释（用 `acorn` 剥）」，这个才是那条规则的兑现。
 *    正则版仍保留给**纯文本**的负向断言用（`indexOf` / `test`，不解析）。
 */
function stripCommentsByAst(src) {
  let ranges = [];
  const collect = (block, text, start, end) => {
    ranges.push([start, end]);
  };
  try {
    ranges = [];
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', onComment: collect });
  } catch (eScript) {
    ranges = [];
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', onComment: collect });
  }
  if (!ranges.length) return src;
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += src.slice(cursor, start) + ' '.repeat(end - start);
    cursor = end;
  }
  return out + src.slice(cursor);
}

/**
 * 取源码里**具名函数体**的原文。两种形态都认：
 *   · 函数声明 / 具名函数表达式 —— `async function processOne(row) { … }`（含嵌套声明）
 *   · 赋值给属性的函数表达式 —— `WebServer.prototype.handleThumb = function (res, idStr) { … }`
 *
 * 🔴 必须走 AST 而不是「找 `function xxx(` 再配大括号」：数组/对象/模板串里的大括号
 *    会让手工配对当场失效，而失效的表现是**取到一段截断的代码**（断言照样跑，只是看的是残片）。
 */
function functionBodyByName(src, name) {
  const ast = parse(src, name);
  let found = null;
  walk(ast, (node) => {
    if (found) return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
      found = src.slice(node.body.start, node.body.end);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const right = node.right;
      if (!right) return;
      if (right.type !== 'FunctionExpression' && right.type !== 'ArrowFunctionExpression') return;
      const left = node.left;
      if (!left || left.type !== 'MemberExpression' || left.computed) return;
      if (left.property && left.property.name === name) {
        found = src.slice(right.body.start, right.body.end);
      }
    }
  });
  return found;
}

/** 取 `member.method(<第一个参数是字面量>)` 回调体：用来精确锚到某个 IPC / 协议处理器。 */
function callbackBodyOf(src, objectName, methodName, firstArgLiteral) {
  const ast = parse(src, objectName + '.' + methodName);
  let found = null;
  walk(ast, (node) => {
    if (found) return;
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
    if (!callee.property || callee.property.name !== methodName) return;
    if (!callee.object || callee.object.name !== objectName) return;
    const first = node.arguments && node.arguments[0];
    if (!first || first.value !== firstArgLiteral) return;
    for (let i = 1; i < node.arguments.length; i++) {
      const arg = node.arguments[i];
      if (arg && (arg.type === 'FunctionExpression' || arg.type === 'ArrowFunctionExpression')) {
        found = src.slice(arg.body.start, arg.body.end);
        return;
      }
    }
  });
  return found;
}

function tempPath(tag) {
  return path.join(os.tmpdir(), `aurora-thumb-regen-${tag}-${Date.now()}-${Math.random()}.db`);
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
    } catch (e) {}
  }
}

function makePhoto(rootId, fileName, thumbnail, thumbSize, thumbFormatValue) {
  const folder = 'C:\\regen\\root\\f';
  return {
    rootId,
    folderPath: folder,
    fileName,
    filePath: path.join(folder, fileName),
    fileSize: 10,
    fileType: 'jpg',
    width: 100,
    height: 100,
    dateTaken: '2026-01-01T00:00:00',
    dateModified: '2026-01-01T00:00:00',
    thumbnail,
    hasThumbnail: thumbnail ? 1 : 0,
    thumbSize,
    thumbFormat: thumbFormatValue,
  };
}

// ---------------------------------------------------------------- 1. 取批形态

/**
 * 🔴 本组是全套里最重要的一条：取批 SQL 里**不许再出现规格谓词**。
 *
 * 队列本身就是「筛选结果」。再筛一遍不仅白付一次代价，还会把「距离」这个不可控量
 * 重新引回来 —— 尾巴上（全库只剩几张待重跑）每批都要从高位扫到底。
 * 而它的症状是**慢在界面上**（主进程被 SQL 占着），日志里什么都不会有。
 */
function checkFetchShape() {
  const fetchSql = thumbRegenQueue.FETCH_SQL;
  const whereAt = fetchSql.indexOf(' WHERE ');
  assert(whereAt > 0, 'FETCH_SQL 应当有 WHERE（只有游标那一项）');
  const tail = fetchSql.slice(whereAt);
  for (const forbidden of ['thumb_size', 'thumb_format', 'has_thumbnail', 'thumbnail IS']) {
    assert(
      tail.indexOf(forbidden) < 0,
      'FETCH_SQL 的 WHERE 里出现了 ' + forbidden + ' —— 取批必须是「按队列游标直取」，' +
        '加了规格谓词就退化成「游标到第一个命中行的距离」（补全那边真库实测单批 159.6 s）',
    );
  }
  assert(
    fetchSql.indexOf('ORDER BY q.id DESC') > 0,
    'FETCH_SQL 必须按主键**倒序**取批（与「后台任务方向统一 = 主键倒序」这条契约一致）',
  );
  assert(
    fetchSql.indexOf('LEFT JOIN photos') > 0,
    'FETCH_SQL 必须用 LEFT JOIN：photos 里已消失的行也要取出来，否则它会永久卡在队首、队列永不抽干',
  );

  /**
   * 🔴 删除的判据必须是**这一批的 id 列表**，不能是「`id <= 本批最小 id`」。
   *    队列是稀疏的，游标下界会连带删掉「比本批最小 id 更小、但还没取过」的行：
   *    `done` 照样加满、那批行却再也不会被重跑 —— 静默少做，进度条还显示已完成。
   *    （这条正是本守护在夹具上抓出来的，初版写的 `WHERE id <= ?`。）
   */
  assert(
    thumbRegenQueue.DELETE_BATCH_SQL.indexOf('json_each') > 0,
    'DELETE_BATCH_SQL 必须按**本批 id 列表**删（`json_each` 单参数），实得：' +
      thumbRegenQueue.DELETE_BATCH_SQL,
  );
  assert(
    thumbRegenQueue.DELETE_BATCH_SQL.indexOf('id <=') < 0,
    'DELETE_BATCH_SQL 出现了游标下界（`id <= ?`）—— 会连带删掉还没取过的行',
  );
  assert(
    thumbRegenQueue.DELETE_BATCH_SQL.indexOf('?,?,') < 0,
    'DELETE_BATCH_SQL 不许把 id 展开成 `?,?,…`（项目红线：改用 json_each）',
  );

  // 登记那侧反过来：谓词必须**逐字**来自唯一真相源（否则「登记按新口径、计数按旧口径」）
  assert(
    thumbRegenQueue.ENQUEUE_SQL.indexOf(thumbRegenQueue.SPEC_MISMATCH_PRED) > 0,
    'ENQUEUE_SQL 必须内嵌 SPEC_MISMATCH_PRED（唯一真相源），不许自己再写一遍谓词',
  );
  assert(
    thumbRegenQueue.SPEC_MISMATCH_PRED.indexOf('thumb_size <> ?') === 0 &&
      thumbRegenQueue.SPEC_MISMATCH_PRED.indexOf('thumb_format <> ?') > 0,
    'SPEC_MISMATCH_PRED 必须两列都比（只判一列会出现「换了档位、格式没换」的半吊子状态）',
  );

  // 身份串只认「档位 + 格式」：把画质算进去会让「改画质」把整条队列判废、白扫一遍全库
  assert(
    thumbRegenQueue.targetSignature(512, 'webp') === '512|webp',
    'targetSignature 形态变了：' + thumbRegenQueue.targetSignature(512, 'webp'),
  );
  assert(
    thumbRegenQueue.targetSignature(256, 'jpeg') === thumbRegenQueue.targetSignature(256, 'jpeg'),
    'targetSignature 必须稳定',
  );
  assert(
    thumbRegenQueue.isQueueReusable({ signature: '512|webp', phase: 'draining' }, '512|webp') ===
      true,
    '身份串相同、阶段合法 ⇒ 队列可以接着用',
  );
  assert(
    thumbRegenQueue.isQueueReusable({ signature: '256|jpeg', phase: 'draining' }, '512|webp') ===
      false,
    '身份串不同 ⇒ 队列必须判废（否则会沿着旧队列跑完、规格还是旧的）',
  );
  assert(
    thumbRegenQueue.isQueueReusable({ signature: '512|webp', phase: 'nonsense' }, '512|webp') ===
      false,
    '阶段不在白名单里 ⇒ 判废（脏状态不许被当成「可以接着用」）',
  );
  console.log('[thumb-regen] fetch shape ok');
}

// ---------------------------------------------------------------- 2. 登记 / 抽干（真跑库）

/**
 * 夹具建库入口。
 *
 * 🔴 **必须跟着补 `ensure*`**：`new PhotoDatabase()` 只建「建库期的骨架列」，
 *    `dhash` / `file_hash` / `hash_size` / `hash_mtime` 都是**迁移**加上去的。
 *    2026-10-08 把取批的列清单扩了之后，夹具缺 `dhash` 当场 `no such column: p.dhash`，
 *    报错栈落在 `thumbRegenFetchBatch` 里、看起来像 SQL 写错了 —— 同一个坑本工程
 *    2026-10-07 已经在 `query-regression` / `keyword-search-regression` 上踩过一次
 *    （见 CHANGELOG 那条「列清单一旦收口，所有列表查询都开始多取几列」）。
 *    ⇒ 规矩是：**夹具只建骨架列，其余一律交给真实迁移函数**，不要手工 `ALTER TABLE`。
 */
function openFixtureDb(dbPath) {
  const db = new PhotoDatabase(dbPath);
  db.ensureDhashSchema();
  db.ensureDuplicateHashSchema();
  return db;
}

function checkQueueRoundTrip() {
  const dbPath = tempPath('roundtrip');
  let db = null;
  try {
    db = openFixtureDb(dbPath);
    const rootId = db.addRootFolder('C:\\regen\\root');
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    // 目标 = 512 / webp
    db.insertPhoto(makePhoto(rootId, 'old256.jpg', buf, 256, 'jpeg')); // ① 档位+格式都不符 ⇒ 入队
    db.insertPhoto(makePhoto(rootId, 'new512.jpg', buf, 512, 'webp')); // ② 符合 ⇒ 不入队
    db.insertPhoto(makePhoto(rootId, 'noThumb.jpg', null, 0, '')); // ③ 没有缩略图 ⇒ 补全的活，不入队
    db.insertPhoto(makePhoto(rootId, 'fmtOnly.jpg', buf, 512, 'jpeg')); // ④ 只格式不符 ⇒ 入队
    db.insertPhoto(makePhoto(rootId, 'legacy.jpg', buf, 0, '')); // ⑤ 本列之前的存量 ⇒ 入队

    const maxId = db.getMaxPhotoId();
    assert(maxId === 5, '夹具应有 5 行，实得 ' + maxId);

    // ---- 登记 ----
    const chunk = db.thumbRegenEnqueueChunk(0, maxId, 512, 'webp', '512|webp', 0);
    assert(chunk.inserted === 3, '应登记 3 行（①④⑤），实得 ' + chunk.inserted);
    assert(chunk.total === 3, '累计张数应是 3，实得 ' + chunk.total);
    assert(
      chunk.phase === 'draining',
      '扫到 idFrom <= 0 时必须**同一个事务**里把阶段推到 draining（分成两次写，崩在中间就白扫一遍全库）',
    );
    assert(db.thumbRegenCount() === 3, '队列表应有 3 行，实得 ' + db.thumbRegenCount());

    // 🔴 登记谓词与计数谓词必须给出**同一个集合**（两处漂开 = 设置页的数字与实际处理量对不上）
    assert(
      db.countThumbnailsNeedingRegen(512, 'webp') === 3,
      'countThumbnailsNeedingRegen 与登记集合必须一致，实得 ' +
        db.countThumbnailsNeedingRegen(512, 'webp'),
    );

    // 幂等：同一区间再登记一次不该翻倍（`INSERT OR IGNORE`）
    const again = db.thumbRegenEnqueueChunk(0, maxId, 512, 'webp', '', chunk.total);
    assert(again.inserted === 0, '重复登记同一区间不应新增行，实得 ' + again.inserted);
    assert(again.total === 3, '重复登记不得把累计张数算两遍，实得 ' + again.total);

    // ---- 取批 + 倒序游标 ----
    const first = db.thumbRegenFetchBatch(maxId, 2);
    assert(first.length === 2, '取批应返回 2 行，实得 ' + first.length);
    assert(first[0].id > first[1].id, '取批必须倒序（第一条 id 更大）');
    assert(
      first[0].file_path && first[0].file_path.indexOf('legacy') >= 0,
      '倒序第一批应当是 id 最大的那行（legacy.jpg），实得 ' + first[0].file_path,
    );

    const cursor = first[first.length - 1].id;
    const fin1 = db.thumbRegenFinishBatch(
      first.map((r) => r.id),
      { failed: 1, missing: 0 },
    );
    assert(fin1.deleted === 2, '应删掉 2 行，实得 ' + fin1.deleted);
    assert(fin1.done === 2, 'done 必须按**实际删除行数**累加，实得 ' + fin1.done);
    assert(fin1.failed === 1, '失败数应累加到 meta，实得 ' + fin1.failed);
    assert(
      fin1.remaining === 1 && fin1.phase !== 'done',
      '还剩 1 行时阶段不能是 done，实得 ' + fin1.phase,
    );
    // 🔴 稀疏队列的关键性质：比本批更小、还没取过的行必须**留在队列里**
    assert(
      db.thumbRegenCount() === 1,
      '本批只该删掉取出来的那 2 行，队列应剩 1 行，实得 ' + db.thumbRegenCount(),
    );

    // ---- 抽干最后一批 ----
    const second = db.thumbRegenFetchBatch(cursor, 10);
    assert(second.length === 1, '第二批应剩 1 行，实得 ' + second.length);
    const fin2 = db.thumbRegenFinishBatch(
      second.map((r) => r.id),
      { failed: 0, missing: 0 },
    );
    assert(fin2.done === 3 && fin2.remaining === 0, '抽干后 done=3 / remaining=0，实得 ' + JSON.stringify(fin2));
    assert(fin2.phase === 'done', '抽干后阶段必须是 done，实得 ' + fin2.phase);
    assert(db.thumbRegenFetchBatch(maxId, 10).length === 0, '队列抽干后取批必须为空');

    // ---- 重置（目标规格变了）----
    // 目标改成 256/jpeg 之后：① 256/jpeg 反而**符合**了（不入队），②④⑤ 不符 ⇒ 3 行
    const reset = db.thumbRegenEnqueueChunk(0, maxId, 256, 'jpeg', '256|jpeg', 123456);
    assert(
      reset.total === 3,
      '重置后累计张数必须从 0 起算（清掉旧队列的累计），实得 ' + reset.total,
    );
    const afterReset = db.thumbRegenMeta();
    assert(afterReset.signature === '256|jpeg', '重置必须写入新的身份串，实得 ' + afterReset.signature);
    assert(afterReset.done === 0, '重置必须把 done 归零（不归零 = 新队列背着旧队列的进度）');
    assert(afterReset.failed === 0, '重置必须把 failed 归零');
    assert(afterReset.targetSize === 256 && afterReset.targetFormat === 'jpeg', '重置必须写入目标规格');

    // ---- LEFT JOIN 的空行：photos 里已经没有的 id ----
    db.db.prepare('INSERT OR IGNORE INTO ' + thumbRegenQueue.QUEUE_TABLE + ' (id) VALUES (?)').run(999999);
    const ghost = db.thumbRegenFetchBatch(999999, 1);
    assert(ghost.length === 1 && ghost[0].id === 999999, '已消失的行必须仍被取出来（否则卡在队首）');
    assert(ghost[0].file_path == null, '已消失的行 file_path 应为空（LEFT JOIN 的空行）');
    const ghostFin = db.thumbRegenFinishBatch([999999], { failed: 0, missing: 1 });
    assert(ghostFin.deleted >= 1, '已消失的行也必须被移出队列，实得 deleted=' + ghostFin.deleted);
    assert(ghostFin.missing === 1, 'missing 必须单独记账（它不是「重生成失败」）');
    assert(ghostFin.failed === 0, 'missing 不许混进 failed（混进去用户会去找一批并不存在的坏文件）');

    // ---- 收口对齐：任何历史漂移都要被抹平 ----
    db.thumbRegenWriteMeta({ done: 0 });
    const drained = db.thumbRegenMarkDrained();
    assert(
      drained.done === drained.total,
      'MarkDrained 必须把 done 对齐 total（否则界面永远停在「还有 N 张」）',
    );
    assert(db.thumbRegenMeta().phase === 'done', 'MarkDrained 后阶段必须是 done');

    console.log('[thumb-regen] queue round trip ok');
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    cleanup(dbPath);
  }
}

/** 取批的**执行计划**必须是「队列驱动」，而不是「扫 photos 再去队列里查」。 */
function checkFetchPlan() {
  const dbPath = tempPath('plan');
  let db = null;
  try {
    db = openFixtureDb(dbPath);
    const rootId = db.addRootFolder('C:\\regen\\plan');
    const buf = Buffer.from([0xff, 0xd8, 0xff]);
    for (let i = 0; i < 40; i++) {
      db.insertPhoto(makePhoto(rootId, 'p' + i + '.jpg', buf, 256, 'jpeg'));
    }
    db.thumbRegenEnqueueChunk(0, db.getMaxPhotoId(), 512, 'webp', '512|webp', 0);
    const plan = db.db
      .prepare('EXPLAIN QUERY PLAN ' + thumbRegenQueue.FETCH_SQL)
      .all(db.getMaxPhotoId(), 10)
      .map((r) => String(r.detail))
      .join(' | ');
    assert(
      /SEARCH q USING INTEGER PRIMARY KEY/.test(plan),
      '取批计划必须由**队列表**（别名 q）主键倒序驱动 —— 代价才会 ∝ 批大小。实际计划：' + plan,
    );
    assert(
      !/SCAN /.test(plan),
      '取批计划里出现了 SCAN（全表扫）—— 代价就从 ∝ 批大小退化成了不可控量。实际计划：' + plan,
    );
    console.log('[thumb-regen] fetch plan ok: ' + plan);
  } finally {
    if (db) {
      try {
        db.close();
      } catch (e) {}
    }
    cleanup(dbPath);
  }
}

// ---------------------------------------------------------------- 3. 域一致性（三份档位清单）

function checkSizeDomainTriplication() {
  const fromModule = thumbFormat.THUMB_SIZE_CHOICES;
  assert(
    Array.isArray(fromModule) && fromModule.length > 0,
    'thumb-format 必须导出 THUMB_SIZE_CHOICES',
  );
  assert(
    fromModule.indexOf(thumbFormat.THUMB_DEFAULT_SIZE) >= 0,
    '默认档必须落在档位白名单里，实得 ' + thumbFormat.THUMB_DEFAULT_SIZE,
  );

  // ② index.html 的 <option value="…">
  const html = readSource('src/renderer/index.html');
  const selectMatch = /<select[^>]*id="settingThumbSize"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert(selectMatch, '在 index.html 里找不到 #settingThumbSize（档位下拉的宿主）');
  const htmlSizes = [];
  const optRe = /<option[^>]*value="(\d+)"[^>]*>/g;
  let om;
  while ((om = optRe.exec(selectMatch[1])) !== null) htmlSizes.push(parseInt(om[1], 10));

  // ③ ui-settings.js 的渲染端副本
  const uiSrc = readSource('src/renderer/ui-settings.js');
  const uiMatch = /var\s+THUMB_SIZE_CHOICES\s*=\s*\[([^\]]*)\]/.exec(uiSrc);
  assert(uiMatch, '在 ui-settings.js 里找不到 THUMB_SIZE_CHOICES（渲染端的那份副本）');
  const uiSizes = uiMatch[1]
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
  const uiDefaultMatch = /var\s+THUMB_DEFAULT_SIZE\s*=\s*(\d+)/.exec(uiSrc);

  assert(
    htmlSizes.join(',') === fromModule.join(','),
    'index.html 的档位下拉与 thumb-format#THUMB_SIZE_CHOICES 必须逐位一致（差一项就会出现「选得到、落库被 clamp 回默认」）：' +
      'HTML=[' +
      htmlSizes.join(',') +
      '] vs 模块=[' +
      fromModule.join(',') +
      ']',
  );
  assert(
    uiSizes.join(',') === fromModule.join(','),
    'ui-settings.js 的档位副本与模块必须逐位一致：[' +
      uiSizes.join(',') +
      '] vs [' +
      fromModule.join(',') +
      ']',
  );
  assert(
    uiDefaultMatch && parseInt(uiDefaultMatch[1], 10) === thumbFormat.THUMB_DEFAULT_SIZE,
    'ui-settings.js 的默认档必须与模块一致（不一致时非法值会回落到两个不同的档位）',
  );
  assert(
    thumbFormat.THUMB_FORMAT_WHITELIST.indexOf(thumbFormat.THUMB_ENCODE_FORMAT) >= 0,
    '生成端编码格式 ' +
      thumbFormat.THUMB_ENCODE_FORMAT +
      ' 必须在白名单内（不在的话服务端会把响应头回落成 JPEG）',
  );
  console.log('[thumb-regen] size domain ok (' + fromModule.join('/') + ')');
}

// ---------------------------------------------------------------- 4. 生成点收敛到共用算子

function checkEncoderSinglePath() {
  const mainSrc = readSource('src/main.js');
  const cases = [
    { src: mainSrc, name: 'processOne' },
    { src: mainSrc, name: 'regenerateRowsWithConcurrency' },
  ];
  for (const c of cases) {
    const raw = functionBodyByName(c.src, c.name);
    assert(
      raw && raw.length > 200,
      '夹具自证：没取到 src/main.js#' + c.name + ' 的函数体（取不到 = 下面两条断言恒真）',
    );
    const body = stripComments(raw);
    assert(
      body.indexOf('resizeThumb(') >= 0,
      'src/main.js#' + c.name + ' 的缩略图生成必须走 resizeThumb()（缩放+编码的唯一出口）',
    );
    assert(
      body.indexOf('.jpeg(') < 0 && body.indexOf('.webp(') < 0,
      'src/main.js#' +
        c.name +
        ' 里出现了裸的 .jpeg()/.webp() —— 那正是「记录进库的格式」与「实际字节」分家的起点',
    );
  }

  // 网页端按需生成同样只许走共用算子（三处生成点全在 handleThumb 里）
  const webSrc = readSource('src/web-server.js');
  const rawThumb = functionBodyByName(webSrc, 'handleThumb');
  assert(
    rawThumb && rawThumb.length > 200,
    '夹具自证：没取到 web-server.js#handleThumb（它是赋值给 prototype 的函数表达式）',
  );
  const handleThumb = stripComments(rawThumb);
  assert(
    handleThumb.indexOf('resizeThumb(') >= 0,
    'web-server.js#handleThumb 的三种按需生成都必须走 resizeThumb()',
  );
  assert(
    handleThumb.indexOf('.jpeg(') < 0 && handleThumb.indexOf('.webp(') < 0,
    'web-server.js#handleThumb 里出现了裸的 .jpeg()/.webp()',
  );

  // 视频抽帧 / 占位图也不能各写一份编码（改格式时只改 THUMB_ENCODE_FORMAT 一处）
  const videoSrc = stripComments(readSource('src/video-frame-thumb.js'));
  assert(
    videoSrc.indexOf('resizeThumb(') >= 0 && videoSrc.indexOf('encodeThumb(') >= 0,
    'video-frame-thumb.js 必须走 resizeThumb()/encodeThumb()',
  );
  assert(
    videoSrc.indexOf('.jpeg(') < 0 && videoSrc.indexOf('.webp(') < 0,
    'video-frame-thumb.js 里出现了裸的 .jpeg()/.webp()',
  );
  console.log('[thumb-regen] encoder single path ok');
}

// ---------------------------------------------------------------- 5. 准入判据唯一 + 双向互斥

function checkAdmissionParity() {
  const mainSrc = readSource('src/main.js');
  const rebuildGate = functionBodyByName(mainSrc, 'thumbnailRebuildBlockReason');
  const backfillGate = functionBodyByName(mainSrc, 'thumbnailBackfillBlockReason');
  assert(rebuildGate && rebuildGate.length > 100, '夹具自证：没取到 thumbnailRebuildBlockReason');
  assert(backfillGate && backfillGate.length > 100, '夹具自证：没取到 thumbnailBackfillBlockReason');
  assert(
    rebuildGate.indexOf('thumbnailBackfill.running') >= 0,
    '重跑的准入必须挡补全（两者都要读完整文件、抢同一块盘）',
  );
  assert(
    backfillGate.indexOf('thumbnailRebuild.running') >= 0,
    '补全的准入也必须挡重跑 —— 单向挡会留下「先起重跑、再起补全」的窗口',
  );

  const handler = callbackBodyOf(mainSrc, 'ipcMain', 'handle', 'start-thumbnail-rebuild');
  assert(handler && handler.length > 100, '夹具自证：没取到 start-thumbnail-rebuild 的 IPC 处理器');
  assert(
    handler.indexOf('thumbnailRebuildBlockReason()') >= 0,
    'IPC 入口必须调用共用的 thumbnailRebuildBlockReason()（各写一份 ⇒ 返回 success 但任务静默不跑）',
  );
  for (const inline of ['optimizeTaskRunning', 'duplicateHashTask.running', 'thumbnailBackfill.running']) {
    assert(
      handler.indexOf(inline) < 0,
      'IPC 处理器里又写了一遍准入条件（' +
        inline +
        '）—— 判据只允许有一份，否则迟早与任务内部漂开',
    );
  }
  const taskBody = functionBodyByName(mainSrc, 'runThumbnailRebuild');
  assert(
    taskBody && taskBody.indexOf('thumbnailRebuildBlockReason()') >= 0,
    '任务内部必须调用同一份判据（IPC 过了闸不等于任务会跑）',
  );
  assert(
    taskBody.indexOf('setTimeout') < 0,
    '任务内部不该自己排定时器（IPC 已经 setTimeout 后立即返回了）',
  );
  console.log('[thumb-regen] admission parity ok');
}

// ---------------------------------------------------------------- 6. 空闲态读数不许数队列

function checkIdleStatusStaysCheap() {
  const mainSrc = readSource('src/main.js');
  const statusBody = functionBodyByName(mainSrc, 'getThumbnailRebuildStatus');
  assert(statusBody && statusBody.length > 100, '夹具自证：没取到 getThumbnailRebuildStatus');
  assert(
    statusBody.indexOf('thumbRegenCount') < 0,
    '设置页的空闲态读数**不许**去 COUNT 队列表（百万行 = 整条索引扫描，而它每开一次设置页就读一次）；' +
      '待办数一律由 meta 的 total - done 派生',
  );
  assert(
    statusBody.indexOf('thumbRegenMeta()') >= 0,
    '空闲态读数必须来自 meta 单行（O(1)）',
  );

  const progressBody = functionBodyByName(mainSrc, 'getThumbnailRebuildProgress');
  assert(progressBody && progressBody.length > 100, '夹具自证：没取到 getThumbnailRebuildProgress');
  assert(
    /Math\.max\(0,\s*total\s*-\s*done\)/.test(progressBody),
    'pending 必须夹在 >= 0：总数与已完成是两个持久化字段，重置那一瞬间可能读到一新一旧',
  );

  // 高频批次任务名单：漏登记会把启动埋点刷爆（几万条 db-write.start/done）
  const quiet = /const DB_WRITE_QUIET_TASKS = \{([\s\S]*?)\n\};/.exec(mainSrc);
  assert(quiet, '找不到 DB_WRITE_QUIET_TASKS');
  assert(
    /'thumb-regen': true/.test(quiet[1]) && /'thumb-regen-enqueue': true/.test(quiet[1]),
    '重跑的两个票据名都必须在 DB_WRITE_QUIET_TASKS 里（它们每批都入队）',
  );
  console.log('[thumb-regen] idle status cheap ok');
}

/**
 * 顶栏「后台任务」面板必须画得出**重建**这一块。
 *
 * 🔴 这条是补出来的（2026-10-08 用户实测：「重建在跑了，顶栏什么都不显示」）：
 *    主进程早就把它**单列**成 `thumbRebuild` 字段报出去了，但渲染端的
 *    `scan-flow.js#renderBackgroundTaskPanel` 从前只画了补全（`thumbs`），
 *    `showPanel` 里也没有它 ⇒ 只剩重建在跑时**整块面板被 `display:none`**，
 *    顶栏看着像「什么都没在干」。失效方式是彻底静默的：不报错、不写日志；
 *    唯一能看到进度的地方是**设置页**那一行，用户一离开设置页就什么都看不见。
 *
 * 为什么必须两个字段分开（而不是并进 `thumbs`）：分子分母口径不同 ——
 * 补全的分子是「已处理行数 / 候选集规模」，重建的是「已重生成 / 全库登记数」，
 * 合成一个就会让「补了 3 张」和「重跑了 3 张」在界面上分不清。
 */
function checkBackgroundPanelWiring() {
  // ① 主进程继续单列这个字段
  const mainSrc = stripComments(readSource('src/main.js'));
  const handlerAt = mainSrc.indexOf("ipcMain.handle('get-background-tasks'");
  assert(handlerAt > 0, '找不到 get-background-tasks 处理器');
  const handlerBody = mainSrc.slice(handlerAt, handlerAt + 3000);
  assert(
    /thumbRebuild:\s*getThumbnailRebuildProgress\(\)/.test(handlerBody),
    'get-background-tasks 必须单列 thumbRebuild（与 thumbs 口径不同，合成一个字段界面上分不清）',
  );

  // ② 面板消费它：取字段 → 开关 → 进 showPanel → 切换那一节 → 填数
  // ⚠️ 必须 **AST 剥注释 + AST 取整个函数体**，不许再写「从函数头往后切 N 个字符」：
  //    2026-10-08 实测，本函数里的重建那节在函数头 **+15,296**，而这里原来写死 12,000 ——
  //    它这次之所以红，是因为同一天给 AI 那两节**补计数行**（多了约 3.3 KB 注释与代码）
  //    把重建那 4 个 id 挤出了窗口。窗口法**两种翻车方向都有**：
  //      · 太窄 ⇒ 新代码插在前面就假红（本次）；
  //      · 太宽 ⇒ 前面被搬到别处的代码仍然被算进这个函数 ⇒ 假绿（删了赋值照样过）。
  //    所以窗口法无论宽窄都不能用。⑦ 那条（下面按 AST 取同一个函数）早就修过了，
  //    这里漏了 —— 同一份文件里两种取法并存本身就是复发源。
  const panelBody = stripCommentsByAst(readSource('src/renderer/scan-flow.js'));
  const fn = functionBodyByName(panelBody, 'renderBackgroundTaskPanel') || '';
  assert(
    fn.length > 0,
    '夹具自证：按 AST 切出了 renderBackgroundTaskPanel 的函数体（切不出来后面全是空断言）',
  );
  assert(/t\.thumbRebuild/.test(fn), '面板要读 t.thumbRebuild');
  const showAt = fn.indexOf('var showThumbRebuild');
  assert(showAt > 0, '要有 showThumbRebuild 开关');
  assert(
    /showThumbRebuild\s*=\s*!!\s*thumbRebuild\.running/.test(fn),
    'showThumbRebuild 要看 thumbRebuild.running（不看 running 会让「已取消/已结束」的一节挂在面板里）',
  );
  const panelAt = fn.indexOf('var showPanel');
  assert(
    panelAt > 0 && fn.slice(panelAt, panelAt + 400).indexOf('showThumbRebuild') >= 0,
    'showPanel 必须含 showThumbRebuild —— 否则只剩重建在跑时整块面板被 display:none 掉，' +
      '顶栏看起来「什么都没在干」（这就是 2026-10-08 那个报障）',
  );
  assert(
    /getElementById\('taskThumbRebuildSection'\)/.test(fn),
    '要拿到 taskThumbRebuildSection 才能切显隐',
  );
  for (const id of ['taskThumbRebuildFill', 'taskThumbRebuildCount', 'taskThumbRebuildDetail', 'taskThumbRebuildEta']) {
    assert(fn.indexOf(id) >= 0, '面板要填 ' + id + '（进度条 / 计数 / 副行 / 剩余时间）');
  }
  assert(
    /taskThumbRebuildStop|onCancelThumbnailRebuild/.test(fn) ||
      readSource('src/renderer/ui-events.js').indexOf('taskThumbRebuildStop') >= 0,
    '顶栏那一节要能停（按钮绑到 onCancelThumbnailRebuild）',
  );

  // ③ 骨架：那一节确实存在，且按钮 id 与绑定一致
  const html = readSource('src/renderer/index.html');
  assert(html.indexOf('id="taskThumbRebuildSection"') >= 0, 'index.html 要有 taskThumbRebuildSection');
  assert(
    html.indexOf('id="taskThumbRebuildStop"') >= 0,
    'index.html 要有 taskThumbRebuildStop',
  );
  assert(
    /bindClick\('taskThumbRebuildStop',\s*options\.onCancelThumbnailRebuild\)/.test(
      readSource('src/renderer/ui-events.js'),
    ),
    'ui-events 要把 taskThumbRebuildStop 绑到 onCancelThumbnailRebuild',
  );

  // ⑥ 面板按名字取的那几个 id，`index.html` 里必须**真有**。
  //    `getElementById('拼错的 id')` 是**静默**的：取到 `null`、那一格永远空着，不报错也不写日志。
  //    上面 ② 那几条只证明「这个字符串在函数里出现过」—— 而 `indexOf('taskThumbRebuildEta')`
  //    对 `thumbRebuildTaskEtaX` 这种多打一个字母**照样通过**。这里补的正是「名字两边一致」。
  //    ⚠️ 别把它交给 `dead-reference-regression`：那条守护的 `ID_LITERAL` 是 `/^#[A-Za-z_][\w-]*$/`，
  //       只认 querySelector 的 `'#id'` 写法，**看不见 `getElementById('id')`**。
  const htmlIdSet = new Set([...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  const grabbed = new Set([...fn.matchAll(/getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)].map((m) => m[1]));
  assert(grabbed.size >= 5, '夹具自证：面板至少该按名字取到 5 个元素，实际 ' + grabbed.size);
  const ghost = [...grabbed].filter((id) => !htmlIdSet.has(id));
  assert(
    ghost.length === 0,
    '面板 getElementById 取的 id 必须存在于 index.html（现在找不到：' + ghost.join(', ') + '）',
  );

  // ④ 规格串与设置页同源（两处各拼一份 ⇒ 「512 px · WEBP」迟早写歪一边）
  assert(
    /formatThumbSpec:\s*formatThumbSpec/.test(readSource('src/renderer/app.js')),
    'app.js 要把 formatThumbSpec 传给面板（别在 scan-flow 里另拼一份规格串）',
  );

  // ⑤ 文案：五个键在**中英两块**里各一条（只加中文 ⇒ 英文界面回落成中文兜底串）
  const i18nSrc = readSource('src/renderer/i18n.js');
  for (const key of [
    'task.thumbRebuildTitle',
    'task.thumbRebuildStop',
    'task.thumbRebuildCount',
    'task.thumbRebuildEnqueueing',
    'task.thumbRebuildTarget',
  ]) {
    const hits = i18nSrc.split("'" + key + "'").length - 1;
    assert(hits === 2, key + ' 要在中英两块里各有一条（实际 ' + hits + ' 条）');
  }
  console.log('[thumb-regen] background panel wiring ok');
}

/**
 * 「一趟解码出五样」的接线（2026-10-08 并入）。
 *
 * 并入的动机是**省钱**：重跑本来就要把原图完整读一遍 + 解一次码，而补全那四样
 * （原图尺寸 / 拍摄参数 / dHash / 查重指纹）吃的就是同一次读盘与同一次解码。
 * 不并的代价是同一批字节读两遍 —— 真库实测补全第二支还欠 857,372 行，
 * 而原图在 K:/G: 外接机械盘上，读盘是这里的主导成本。
 *
 * 守的三类失效（都不报错）：
 *   · **漏取判据列** ⇒ 每行都白重算一遍（`row.dhash` 永远是 undefined ⇒ 门恒开）；
 *   · **判据另写一份**（手写 `row.exif_mtime` 而不是走 `db.photoNeedsExif`）⇒ 与候选谓词漂开，
 *     变成「每轮取出来、每轮判不需要」，静默死路；
 *   · **顺序反**（先 `resizeThumb()` 再算 dHash）⇒ `.rotate()` 已经把画布转过了，
 *     dHash 位全变 —— 而 dHash 是相似聚类的输入，位差会翻面，且**没有任何报错**。
 */
function checkMetadataMergeWiring() {
  // ① 取批的列清单：四个门要读的列一列都不能少
  const fetchSql = thumbRegenQueue.FETCH_SQL;
  for (const col of ['dhash', 'width', 'height', 'file_hash', 'exif_mtime', 'exif_ver']) {
    assert(
      fetchSql.indexOf('p.' + col + ' AS ' + col) >= 0,
      'FETCH_SQL 必须取 p.' +
        col +
        ' —— 少取这一列，那一项的「还缺吗」门就恒开（`row.' +
        col +
        '` 恒 undefined），每行白重算一遍',
    );
  }

  // ⚠️ 要解析源码取函数体，所以必须用 **AST 版**剥注释（正则版会让 `src/main.js` 解析失败）。
  const mainSrc = stripCommentsByAst(readSource('src/main.js'));
  const body = functionBodyByName(mainSrc, 'regenerateRowsWithConcurrency');
  assert(body && body.length > 500, '夹具自证：没取到 regenerateRowsWithConcurrency 的函数体');

  // ② 判据必须复用唯一真相源，不许手写
  assert(
    /db\.photoNeedsExif\s*\(\s*row\s*\)/.test(body),
    'EXIF 的判据必须走 `db.photoNeedsExif(row)`（唯一真相源）。手写 `!(row.exif_mtime && …)` ' +
      '只判一个标记列，而候选谓词判的是两个 ⇒ 老口径跑过的行每轮被取出来、每轮被判「不需要读」',
  );
  assert(
    !/row\.exif_mtime\s*&&/.test(body),
    '出现了手写的 `row.exif_mtime && …` —— 那就是上面那条漂开的起点',
  );

  // ②b 🔴 四道门都必须**先挡视频**（2026-10-08 加）。
  //     视频行本来就不读拍摄参数 / 尺寸 / dHash / 查重指纹，而它们的 `exif_mtime` 恒为 NULL
  //     ⇒ `db.photoNeedsExif(row)` 对视频**恒真**。少了 `!isVideoRow` 这一截，队列里的视频行
  //     会让「拍摄信息」涨的全是**不存在的活** —— 计数只多不少、不报错，看着像「补得很成功」。
  //     ⚠️ 反向的坑同样是静默的，而且更像故障：真库 2026-10-08 实测重建游标上方那段
  //       `needExif` 的 37 行**全是视频**、图片 0 行 ⇒ 界面「拍摄信息 +0」是**正确读数**，
  //       用户却以为计数坏了（见 docs/contracts/thumbnail-backfill.md 那一节）。
  //       这两件事是同一个 `!isVideoRow` 的两面 ⇒ 一条断言同时守两边。
  for (const gate of ['needSize', 'needDhash', 'needExif', 'needHash']) {
    assert(
      new RegExp('var\\s+' + gate + '\\s*=\\s*!isVideoRow\\s*&&').test(body),
      gate +
        ' 必须写成 `var ' +
        gate +
        ' = !isVideoRow && …`：视频行不该进这四项（`exif_mtime` 恒 NULL ⇒ `photoNeedsExif()` ' +
        '对视频恒真，「拍摄信息」会涨成假的）',
    );
  }

  // ③ 四样写入口都在
  const writes = [
    'db.updatePhotoDimensions(',
    'db.updatePhotoExif(',
    'db.updatePhotoDhash(',
    'db.updatePhotoHash(',
  ];
  for (const w of writes) {
    assert(body.indexOf(w) >= 0, '重跑那一趟要顺手写 ' + w + '（否则这一趟只出缩略图一样）');
  }

  // ④ 查重指纹：优先吃共享 Buffer，超大文件才退回流式；内存闸门必须来自同一个常量
  assert(
    /hashBufferSha256\s*\(\s*sharedBuf\s*\)/.test(body),
    '有 sharedBuf 时查重指纹必须**对内存算**（`hashBufferSha256(sharedBuf)`）—— 那一行不再碰盘',
  );
  assert(
    body.indexOf('hashFileSha256(') >= 0 && body.indexOf('THUMB_SHARED_READ_MAX_BYTES') >= 0,
    '超大 / 大小未知的文件必须退回流式 `hashFileSha256`，且闸门用 `THUMB_SHARED_READ_MAX_BYTES` 这一个常量',
  );

  // ⑤ 🔴 顺序：读文件头 → 算 dHash → **最后**缩放置换（`resizeThumb` 内部会 `.rotate()`）
  const atHeader = body.indexOf('readHeaderMeta(');
  const atDhash = body.indexOf('computeDhashFromPipeline(');
  const atResize = body.indexOf('resizeThumb(');
  assert(atHeader >= 0, '要读一次文件头（尺寸与拍摄参数共用这一次）');
  assert(atDhash >= 0, '要复用解码算 dHash（`computeDhashFromPipeline`）');
  assert(atResize >= 0, '要缩放置换');
  assert(
    atHeader < atDhash && atDhash < atResize,
    '顺序必须是 读文件头(' +
      atHeader +
      ') < 算 dHash(' +
      atDhash +
      ') < 缩放置换(' +
      atResize +
      ')。dHash 取在 `.rotate()` 之后 = 位全变，而 dHash 是相似聚类的输入，' +
      '位差会翻面 —— 不报错、只是聚类结果不一样',
  );

  // ⑥ 五个计数必须同时出现在**状态对象**与**进度白名单**里
  const stateAt = mainSrc.indexOf('var thumbnailRebuild = {');
  const stateBody = mainSrc.slice(stateAt, stateAt + 2600);
  const progBody = functionBodyByName(mainSrc, 'getThumbnailRebuildProgress');
  for (const key of ['sized', 'exifChecked', 'exifFilled', 'dhashed', 'hashed']) {
    assert(stateBody.indexOf(key + ':') >= 0, '状态对象缺计数 ' + key);
    assert(
      progBody && new RegExp('\\b' + key + '\\s*[:=]').test(progBody),
      '进度白名单漏了 ' + key + ' —— 界面收得到事件却永远画不出那一项，看起来跟「没在补」一样',
    );
  }

  // ⑦ 顶栏那一节要把这四项画出来，且**复用补全那行的键**（同一件事两种说法会让人以为是两项）
  // ⚠️ 用 AST 版剥注释 + **按 AST 取整个函数体**，不许再写「从函数头往后切 N 个字符」：
  //    那个窗口本来就在临界上（本项目实测：重建那节在函数头 +16,658，而窗口是 14,000）——
  //    它之前之所以绿，只是因为正则版剥注释**把注释长度也删掉了**、偏移整体前移。
  //    换成保偏移的 AST 版之后同一段代码立刻越界 ⇒ 窗口法本身就是假绿源（还随插入注释漂移）。
  const panelSrc = stripCommentsByAst(readSource('src/renderer/scan-flow.js'));
  const panelFn = functionBodyByName(panelSrc, 'renderBackgroundTaskPanel') || '';
  assert(
    panelFn.length > 0,
    '夹具自证：按 AST 切出了 renderBackgroundTaskPanel 的函数体（切不出来后面全是空断言）',
  );
  // 🔴 判**门**，不是判「这个名字出现过」：`if ((thumbRebuild.sized || 0) > 0)` 里把 `sized`
  //    写成 `sizd` 只废掉那道门，而 push 体里仍留着 `formatNumber(thumbRebuild.sized)`
  //    ⇒ 只判「出现过」照样绿 —— 2026-10-08 牙齿验证实测到的假绿，就是这一条。
  //    判据必须要求「门 + 同一个名字」同时在场。
  //
  // 🔴 2026-10-08 二次修订：那道门**换了形态**（原来钉的是 `(thumbRebuild.X || 0) > 0`）。
  //    同一个判据在两边**不是**同一件事，因为候选集不同：
  //      · 补全收「**缺**缩略图」的行 ⇒ 那些行天然也缺四样 ⇒ `> 0` 才画，没问题；
  //      · 重建收「**有**缩略图、只是规格旧」的行，而这四样是**补全**（同样主键倒序）先补的
  //        ⇒ 两个反序任务在**同一段高位 id 碰头**，重建跑到那里时四样本来就齐
  //        （真库 2026-10-08 实测：队首段每 3000 行只缺 1~14 行；id ≈ 1.2M 是分界线）
  //        ⇒ 四项恒 0、一个都不画 ⇒ 用户看到副行上什么统计都没有，
  //        原话：「重建缩微图，没有看到其他四项计数」。
  //    ⇒ 新判据 = **进了抽干阶段就一律画**（`if (!rEnqueueing)`，`+0` 也画 —— 它是
  //      「本段没得补」这个**事实**）。改动要**两个方向都守**：新门在场 + 旧门不许回退。
  assert(
    /if\s*\(\s*!\s*rEnqueueing\s*\)/.test(panelFn),
    '重建那一节的四项要闸在「已进抽干阶段」上（`if (!rEnqueueing)`）—— ' +
      '进了抽干阶段就一律画，`+0` 也是「本段没得补」这个事实，不该被藏起来',
  );
  assert(
    !/thumbRebuild\.(sized|exifFilled|dhashed|hashed)\s*\|\|\s*0\s*\)\s*>\s*0/.test(panelFn),
    '🔴 重建那一节的四项**不许**退回 `(thumbRebuild.X || 0) > 0`：那会在「四样本来就齐」的' +
      'id 段上把四项一起藏起来（2026-10-08 用户报过「没有看到其他四项计数」）。' +
      '补全那一节保持 `> 0` 不动 —— 它的候选集让 0 只可能是故障',
  );
  // 来源字段拼错（`sized` → `sizd`）在这一版**更难发现**：判据是无条件画，拼错只让那一项
  // 永远显示 `+0`，而 `+0` 在这版里是**合法值** ⇒ 肉眼与「本段没得补」无从区分。
  // 所以四个名字必须逐个在场（它们现在住在一张表里，不再有各自的 `if` 门）。
  for (const key of ['sized', 'exifFilled', 'dhashed', 'hashed']) {
    assert(
      panelFn.indexOf('thumbRebuild.' + key) >= 0,
      '重建那一节的四项表里要绑定 `thumbRebuild.' + key + '`（拼错 = 那项永远画 +0，看不出是坏的）',
    );
  }
  // 表定义出来了却没人遍历 = 静默空白（本项目的老症状：结构在、环节断）
  assert(
    /var\s+rFour\s*=\s*\[/.test(panelFn) && /rFour\.length/.test(panelFn),
    '四项要收在一张表里（`var rFour = [...]`）**并真的被遍历**（`rFour.length`）—— ' +
      '只定义不遍历，副行上不会多出任何一项',
  );
  for (const key of [
    'task.thumbDetailSized',
    'task.thumbDetailExif',
    'task.thumbDetailDhash',
    'task.thumbDetailHash',
  ]) {
    assert(
      panelFn.indexOf(key) >= 0,
      '重建那一节要用**补全同款**的文案键 ' + key + '（另写一套说法 = 同一件事两个名字）',
    );
  }
  // 补全那一节也要有「原图尺寸」：它是四样之一，主进程早就在数（`thumbs.sized`）却没画，
  // 结果「并进来的四样」用户只看得见三样。同样判**门**（`thumbs.sized > 0`）而不是判「出现过」。
  assert(
    /thumbs\.sized\s*>\s*0/.test(panelFn) && panelFn.indexOf('task.thumbDetailSized') >= 0,
    '补全那一节要有 `thumbs.sized > 0` 这道门 + 「原图尺寸」词条（不画 = 并进来的四样只看得见三样）',
  );

  // ⑦b 产出 / 剩余两项 —— 让重建那节与补全那节是**同一套账**（「预览图 N · 还缺 M」的对应物）
  assert(
    panelFn.indexOf('task.thumbRebuildDetailRebuilt') >= 0 &&
      panelFn.indexOf('task.thumbRebuildDetailPending') >= 0,
    '重建那一节要报「已重出 N」「待重跑 M」（对应补全那节的「预览图 N」「还缺 M」）',
  );
  // 🔴 2026-10-08 用户纠正「**已完成的不是这一次跑的**」⇒ 面板这一项**必须**读主进程算好的
  //    `rebuiltThisRun`（本次进程口径 = sessionDone − sessionFailed − sessionMissing），
  //    **不许**在渲染端拿 `thumbRebuild.done / failed / missing` 自己减 —— 那三个是
  //    `thumb_regen_meta` 里的**跨重启累计**值（`database.js#thumbRegenFinishBatch` 按本批
  //    真正删掉的行数累加），拿它们当产出，报的就是**上一个进程**的账。
  //    现场：本次进程起了 21 分钟，界面却报「已重出 387,250」，其中 37 万是上一趟做的。
  //    而且 `done` 的**定义**是「已抽干的队列行数」，本身还含失败与「行已不在库里」两类。
  //    ⚠️ 这条断言**故意**是反向的：旧版本判「这片里要出现 done/failed/missing」，那正是被
  //    用户否掉的形状 —— 判据必须跟着口径一起翻，否则守护会替错误的旧实现站队。
  const rebuiltAt = panelFn.indexOf('var rRebuilt');
  assert(rebuiltAt >= 0, '面板要用 `var rRebuilt` 读「本次已重出」（别在渲染端自己减）');
  const rebuiltExpr = rebuiltAt >= 0 ? panelFn.slice(rebuiltAt, rebuiltAt + 400) : '';
  assert(
    /var\s+rRebuilt\s*=\s*thumbRebuild\.rebuiltThisRun\s*\|\|\s*0/.test(rebuiltExpr),
    '「本次已重出」必须直接读主进程的 `thumbRebuild.rebuiltThisRun`（本次进程口径）',
  );
  assert(
    !/thumbRebuild\.\s*(done|failed|missing)\b/.test(rebuiltExpr),
    '渲染端**禁止**拿 `thumbRebuild.done/failed/missing` 当产出：那三个是跨重启累计值，' +
      '拿它当产出报的就是上一个进程的账（用户原话：「已完成的不是这一次跑的」）',
  );
  // 「待重跑」必须走主进程算好的 `pending`（= total − done），不许在面板里再写一次减法 ——
  // 那边已经夹过 `>= 0` 了，两处各写一份就是两个口径。
  assert(
    /thumbRebuild\.pending/.test(rebuiltExpr + panelFn.slice(rebuiltAt, rebuiltAt + 900)),
    '「待重跑」要用主进程的 `thumbRebuild.pending`（别在面板里另写一遍 total − done）',
  );
  // 🔴 但必须**闸在非登记阶段**：登记时 `done` 恒为 0 ⇒ `pending` 天然 > 0，照报就是一个
  //    只涨不跌的孤立数字（同一刻「已重出」被隐藏），与主行「已扫描 N 行、已登记 M 张…」打架。
  assert(
    /!\s*rEnqueueing/.test(panelFn.slice(rebuiltAt, rebuiltAt + 1400)),
    '「待重跑」要闸在 !rEnqueueing —— 登记阶段只报「已扫描 N 行」那一个数',
  );
  // ⑦c 「已重出」减法里的 `missing` 必须在**接着上一条队列跑**时从 meta 恢复。
  //    内存里的 `missing` 在起手时被归零（那条归零本身是对的：它描述「这一轮」），
  //    但续跑分支若不从 meta 取回来，重启后这个减法就少减了一部分 —— 界面上的产出**偏大**，
  //    而且它不参与百分比与 ETA，没人会当场发现。这类「只错一个派生读数」的洞最难自己浮出来。
  const resumeBody = functionBodyByName(mainSrc, 'runThumbnailRebuild') || '';
  assert(
    /thumbnailRebuild\.missing\s*=\s*Number\(meta\.missing\)\s*\|\|\s*0/.test(resumeBody),
    '续跑分支（`isQueueReusable`）必须把 `missing` 从 meta 恢复 —— 它是「已重出」的减数',
  );
  assert(
    /thumbnailRebuild\.missing\s*=\s*0/.test(resumeBody),
    '起手必须把 `missing` 归零（与五个顺手产出的计数同款：它们描述「这一轮」）',
  );

  console.log('[thumb-regen] metadata merge wiring ok');
}

// ---------------------------------------------- ⑨ 「累计 / 本次」两套口径不许串
/**
 * 2026-10-08 用户连报两条，根因是**同一个**：`thumb_regen_meta` 里的 `done` / `failed` / `missing`
 * 是**跨重启累计**的，而 `thumbnailRebuild.startedAt` 与五项顺手产出计数是**本次进程**的。
 *
 *  ① 「预计时间不对」：`rate = done / (now − startedAt)` ⇒ 把上一趟做的量算进本次的时间里。
 *     真库实测（重启续跑 21 分钟）：速率被放大成 **305 张/秒**（实测 17）
 *     ⇒ 界面「预计剩余约 1 小时 9 分」，真实约 **20.7 小时**。
 *  ② 「已完成的不是这一次跑的」：把累计 `done` 当本次产出报 ⇒ 本次起了 21 分钟，
 *     界面却报「已重出 387,250」（其中 37 万是上一个进程做的）。
 *
 * 两件事的修法是同一个形状：起手对三个累计量各取一份快照，之后**只报差值**。
 * 结构上三条缺一不可：
 *   ① 快照要在**恢复完之后**取（取早了恒为 0）；
 *   ② 快照不许做成持久化（`doneAtStart === done` ⇒ 差值恒为 0 ⇒ ETA 永远为 null）；
 *   ③ 面板要读主进程算好的**本次口径字段**，不许自己拿累计量相减（两处减 = 两个口径）。
 */
function checkSessionScopeAndEta() {
  const mainSrc = stripCommentsByAst(readSource('src/main.js'));
  const stateAt = mainSrc.indexOf('var thumbnailRebuild = {');
  const stateBody = stateAt >= 0 ? mainSrc.slice(stateAt, stateAt + 3600) : '';
  const runBody = functionBodyByName(mainSrc, 'runThumbnailRebuild') || '';
  const progBody = functionBodyByName(mainSrc, 'getThumbnailRebuildProgress') || '';
  const atResume = runBody.indexOf('isQueueReusable');

  // ① 三个累计量各要一份起手快照，且都要在恢复之后取
  for (const key of ['done', 'failed', 'missing']) {
    assert(
      new RegExp('\\b' + key + 'AtStart:').test(stateBody),
      '状态对象要有 `' + key + 'AtStart`（本次进程起手时 `' + key + '` 的快照）',
    );
    const re = new RegExp(
      'thumbnailRebuild\\.' +
        key +
        'AtStart\\s*=\\s*Number\\(thumbnailRebuild\\.' +
        key +
        '\\)\\s*\\|\\|\\s*0',
    );
    assert(
      re.test(runBody),
      '起手要把 `' + key + 'AtStart` 设成**恢复后**的 `' + key + '`',
    );
    assert(
      atResume >= 0 && runBody.search(re) > atResume,
      '`' +
        key +
        'AtStart` 必须在 `isQueueReusable` 那次恢复**之后**取 —— 取在前面 = 恒为 0，差值全是 0',
    );
  }
  // 🔴 也不许把快照做成持久化：差值恒为 0 ⇒ `done < 1` 让 ETA **永远不显示**，
  //    而「本次已重出」恒为 0 ⇒ 那一项永远画不出来。两种都比算错更难发现（界面上只是少一行字）。
  assert(
    !/AtStart\s*=\s*Number\(meta\./.test(runBody),
    '快照必须是**本次进程**的值，不许从 meta 恢复（那就恒等于累计量、差值永远是 0）',
  );

  // ② 本次口径三件套：差值算出来、并出现在**进度白名单**里
  for (const key of ['sessionDone', 'sessionFailed', 'sessionMissing']) {
    assert(
      new RegExp('var\\s+' + key + '\\s*=\\s*Math\\.max\\(\\s*0\\s*,').test(progBody),
      '进度里要算出 `' + key + '`（差值并夹 `>= 0`：三个数分别持久化，重置队列那一瞬会读到一新一旧）',
    );
  }
  assert(
    /var\s+rebuiltThisRun\s*=\s*Math\.max\(\s*0\s*,\s*sessionDone\s*-\s*sessionFailed\s*-\s*sessionMissing\s*\)/.test(
      progBody,
    ),
    '「本次已重出」= sessionDone − sessionFailed − sessionMissing（`done` 含失败与「行已不在库里」两类）',
  );
  for (const key of ['doneThisRun', 'failedThisRun', 'rebuiltThisRun']) {
    assert(
      new RegExp('\\b' + key + '\\s*:').test(progBody),
      '进度白名单漏了 `' + key + '` —— 界面收得到事件却永远画不出那一项，看起来跟「没在补」一样',
    );
  }

  // ③ ETA 的分子必须是差值（判据落在**调用实参**上，不是「这段代码里出现过 sessionDone」）
  const callAt = progBody.indexOf('estimateEtaSecondsSmoothed(');
  const callArg = callAt >= 0 ? progBody.slice(callAt, callAt + 300) : '';
  assert(
    /'thumbRebuild'/.test(callArg) && /sessionDone/.test(callArg),
    '送给估算器的分子必须是 `sessionDone`',
  );
  assert(
    !/estimateEtaSecondsSmoothed\(\s*'thumbRebuild'\s*,\s*thumbnailRebuild\.startedAt\s*,\s*done\s*,/.test(
      progBody,
    ),
    '不许把**原始 `done`** 直接喂进 ETA（分子跨重启累计、分母是本次时间 = 用户报的「预计时间不对」）',
  );
  console.log('[thumb-regen] session scope + eta ok');
}

/**
 * 🔴 「抽干一批 = 原子批」契约（2026-10-08 落地，用户报「重建完了但有些图还是糊的」之后加的）。
 *
 * 翻车形状：worker 每取一行先 `if (thumbnailRebuild.cancelled) return;`，而调用方是
 * 「先把这一批做完、再按**本批取到的全部 id** 删队列」⇒ 取消时没被取到的行**照删**：
 *   · `done` 加满（`thumbRegenFinishBatch` 按实际删除行数累加）；
 *   · 那些行的规格**没换**；
 *   · 它们已经不在队列里 ⇒ **永远不会被重跑**。
 * 真库实测（2026-10-08，目标 512|webp）：`done = 614,600` 而真正换过规格的只有 614,558，
 * 差 **42 行**，落成 3 段连续 id（5 / 10 / 27 行）= 三次取消各吃掉一批的尾巴，
 * 且全部落在**已抽干区**（`id > 队列上界`）—— 队列与 `done` 自洽，界面上完全看不出来。
 *
 * ⚠️ 为什么必须静态钉：这个 bug 的唯一症状是「库里多出几百行仍是旧规格」，
 *    夹具抓不到（夹具不会「取消」，取消是人在几十小时的任务中途按的）。
 *
 * 判据全部走 `acorn`（剥注释后再看结构），三条互相独立：
 *   ① worker 的循环体里没有「test 提到 `cancelled` ⇒ return / continue / break」的形状；
 *   ② 调用方仍按 `batchIdList`（**本批取到的全部 id**）删 —— ① 只在这个前提下才成立；
 *   ③ 取消改由**批次边界**承担（`runThumbRegenDrainPass` 的 while 条件里要有 `cancelled`）。
 *   ① 与 ③ 必须**同时**成立：只拆掉 ① = 停止按钮失灵；只拆掉 ③ = 停止要等整条队列跑完。
 */
function checkDrainBatchAtomicity() {
  const mainSrc = readSource('src/main.js');
  const body = functionBodyByName(mainSrc, 'regenerateRowsWithConcurrency');
  assert(body && body.length > 500, '夹具自证：没取到 regenerateRowsWithConcurrency 的函数体');
  // ⚠️ `functionBodyByName` 给的是**函数体**（含花括号），不是可解析的顶层程序：直接喂给
  //    `stripCommentsByAst` / `parse` 都会在第一条 `return` 上炸（`'return' outside of function`）。
  //    包一层 async 外壳 —— 体内有 `await Promise.all(...)`，所以外壳必须是 async。
  //    剥注释与解析都在这份**包好的**源码上做，偏移因此直接可用
  //    （`stripCommentsByAst` 补等长空格，不移动位置）。
  const wrapped = 'async function __f() ' + body;
  const stripped = stripCommentsByAst(wrapped);
  const ast = parse(stripped, 'regenerateRowsWithConcurrency');

  // 锚点：worker 里那个 `while (true)`。取不到就红 —— 宁可红，也不要留一条永远为真的断言。
  let loop = null;
  walk(ast, (node) => {
    if (loop) return;
    if (node.type !== 'WhileStatement') return;
    if (!node.test || node.test.type !== 'Literal' || node.test.value !== true) return;
    loop = node;
  });
  assert(
    loop,
    '锚点失效：regenerateRowsWithConcurrency 里的 `while (true)` 取不到了 —— 形状变了就把断言一起改，别留着假装还在守',
  );

  // ① 批内不许按取消提前退出
  let offender = '';
  walk(loop.body, (node) => {
    if (offender) return;
    if (node.type !== 'IfStatement') return;
    const testSrc = stripped.slice(node.test.start, node.test.end);
    if (!/cancelled/.test(testSrc)) return;
    const stmts =
      node.consequent.type === 'BlockStatement' ? node.consequent.body : [node.consequent];
    for (const st of stmts) {
      if (
        st.type === 'ReturnStatement' ||
        st.type === 'ContinueStatement' ||
        st.type === 'BreakStatement'
      ) {
        offender = st.type + ' / `' + testSrc.trim() + '`';
      }
    }
  });
  assert(
    !offender,
    '🔴 抽干批内不许按取消提前退出（' +
      offender +
      '）：调用方按**本批取到的全部 id** 删队列，半途退出会让没轮到的行连坐被删 —— ' +
      '`done` 加满、规格没换、且永不重跑（真库实测漏 42 行，不报错、界面照报完成）',
  );

  // ② 调用方仍按「本批取到的全部 id」删 —— ① 的前提
  const drainBody = functionBodyByName(mainSrc, 'runThumbRegenDrainPass');
  assert(drainBody && drainBody.length > 500, '夹具自证：没取到 runThumbRegenDrainPass 的函数体');
  // 同样要包壳：`stripCommentsByAst` 内部会 `acorn.parse`，裸函数体会在
  // `if (thumbnailRebuild.cancelled) return;` 那一行炸。下面只用文本正则，所以偏移无所谓。
  const drain = stripCommentsByAst('async function __d() ' + drainBody);
  assert(
    /thumbRegenFinishBatch\(\s*batchIdList\s*,/.test(drain),
    '删除必须按**本批取到的全部 id**（`batchIdList`）—— 批原子契约的前提',
  );
  assert(
    /batchIds\.push\(rows\[/.test(drain),
    '锚点失效：`batchIds` 不再逐行收全（`batchIds.push(rows[mi].id)`）—— 它必须覆盖 rows 的每一行，否则「整批删」的前提就没了',
  );
  assert(
    /for\s*\([^;]*;[^;]*<\s*rows\.length/.test(drain),
    '`batchIds` 的收集循环必须以 `rows.length` 为界（按 index 收全，不许只收一部分）',
  );

  // ③ 取消只在批次边界生效
  assert(
    /while\s*\(\s*!\s*thumbnailRebuild\.cancelled\s*\)/.test(drain),
    '取消必须在**批次边界**生效：runThumbRegenDrainPass 的 while 条件里要有 `!thumbnailRebuild.cancelled`',
  );
  console.log('[thumb-regen] drain batch atomicity ok');
}

function run() {
  checkFetchShape();
  checkQueueRoundTrip();
  checkFetchPlan();
  checkSizeDomainTriplication();
  checkEncoderSinglePath();
  checkAdmissionParity();
  checkIdleStatusStaysCheap();
  checkBackgroundPanelWiring();
  checkMetadataMergeWiring();
  checkSessionScopeAndEta();
  checkDrainBatchAtomicity();
  console.log('[thumb-regen] PASS (' + checks + ' checks)');
}

run();
