'use strict';
/**
 * 组织元数据（标记 / 评分 / 用户标签）回归 —— 2026-10-09。
 *
 * ## 为什么必须单独立一条守护
 *
 * 这三个维度的失效方式**全部是静默的**，没有任何一条会让现有守护变红：
 *
 *   1. 🔴 `rating = 0`（未评分）与 `flag = 'none'`（未标记）是**合法的筛选值**，
 *      而且是冲片工作流里最常查的两档（「还剩哪些没标」）。判据一旦写成 truthy
 *      （`if (opts.rating)`），那一档会安静地变成「不筛」—— 界面上只是「筛选没生效」。
 *   2. 🔴 六处查询各写一份谓词会漂移：浏览列表 / 目录页 / 日期页 / 搜图页 / 标签页 /
 *      预览作用域。漂移的症状是「列表筛出来的和预览翻页翻到的不是同一批图」，
 *      只在按左右键翻到页边界时才看得出来 —— 本工程 `_pushMediaTypeCondition`
 *      的 `join(' AND ')` 漏在 `getFolderPhotos` 上就是同一个前科（实测 11 行应为 5）。
 *   3. 🔴 渲染端 `data-org-flag` / `data-org-rating` 两个属性名若有两份，
 *      点一次星会把已有的标记角标擦掉（`updateCardBadge` 回读成 null），不报错。
 *   4. 🔴 三条通道（IPC / HTTP / 渲染端 api）任一名字漂开，症状是「点了没反应」或 404。
 *   5. 🔴 归一若在入口各写一份，会出现「网页端能用 7 星、桌面端不能」这种分叉。
 *
 * ## 口径
 *
 * 只钉**契约**：取值域、两条实现的同源、属性名、通道名、写入幂等语义。
 * 不钉实现细节（不钉 SQL 全文、不钉函数体）。宁可漏报不误报。
 *
 * ⚠️ 必须用 Electron 运行时跑（`npm test`，或
 *    `ELECTRON_RUN_AS_NODE=1 electron scripts/org-metadata-regression.js`）——
 *    本脚本 require 了 better-sqlite3 造真库，系统 node 的 ABI 对不上（见
 *    `scripts/photo-tags-regression.js` 顶部同一条说明）。用 node 直接跑会抛一个
 *    **看起来像代码坏了、其实只是运行时装错**的异常。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥 JS 注释 —— 本文件自己的注释里引用了被断言的字面量，不剥会把注释当代码判（元规则③）。 */
const stripJs = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const MAIN = require('../src/main/org-meta-filter');

// ═══════════════════════════════════════════════════════════════════════════
// §1 取值域与归一（真叶子模块）
// ═══════════════════════════════════════════════════════════════════════════

assert.equal(MAIN.RATING_MIN, 0, '评分下限必须是 0（= 未评分），改它会动筛选语义');
assert.equal(MAIN.RATING_MAX, 5, '评分上限 5');
assert.deepEqual(
  Array.from(MAIN.FLAG_VALUES),
  ['none', 'pick', 'reject'],
  '🔴 标记取值域是穷举白名单（含 none），顺序即界面按钮顺序',
);

/* 评分归一：越界**夹取**不抛错（冲片是高频盲操作，为一次越界失败整条操作更糟）；
   非数字一律落 0（= 取消评分），绝不落 NULL / 负数 —— 否则「未评分」档的判据分裂成两支。 */
for (const [input, want] of [
  [undefined, 0],
  [null, 0],
  [NaN, 0],
  ['', 0],
  ['abc', 0],
  [-3, 0],
  [0, 0],
  ['0', 0],
  [1, 1],
  ['4', 4],
  [3.9, 3],
  [5, 5],
  [9, 5],
  ['7', 5],
]) {
  assert.equal(MAIN.normalizeRating(input), want, `normalizeRating(${JSON.stringify(input)})`);
}

/* 标记归一：白名单外一律回落 'none'；顺手做大小写归一 ⇒ 'PICK' 合法。
   外部输入（IPC / HTTP）写进奇怪的值会让所有按 flag 的筛选出现无法解释的结果，
   而那行在界面上根本不显示 —— 排查时看不见。 */
for (const [input, want] of [
  [undefined, 'none'],
  [null, 'none'],
  ['', 'none'],
  ['   ', 'none'],
  ['pick', 'pick'],
  ['PICK', 'pick'],
  [' Pick ', 'pick'],
  ['reject', 'reject'],
  ['REJECT', 'reject'],
  ['none', 'none'],
  ['true', 'none'],
  ['picked', 'none'],
  [1, 'none'],
]) {
  assert.equal(MAIN.normalizeFlag(input), want, `normalizeFlag(${JSON.stringify(input)})`);
}

/* 标签两个归一函数的分工：`normalizeTagName` 做**键**（比较用，小写）、
   `normalizeTagDisplayName` 做**值**（显示用，保留大小写）。只留一个的话，
   要么标签列表里全是小写，要么「客户A」和「客户a」变成两个 chip。 */
assert.equal(MAIN.normalizeTagName('  客户A  '), '客户a', '键：折叠空白 + trim + 小写');
assert.equal(MAIN.normalizeTagName('a   b'), 'a b', '内部连续空白折叠成一个空格');
assert.equal(MAIN.normalizeTagName(null), '', 'null → 空串（调用方按空丢弃）');
assert.equal(MAIN.normalizeTagDisplayName('  客户A  '), '客户A', '显示名保留大小写');
assert.equal(MAIN.normalizeTagDisplayName('a   b'), 'a b');
assert.notEqual(
  MAIN.normalizeTagName('客户A'),
  MAIN.normalizeTagDisplayName('客户A'),
  '两个函数必须真的不同（否则大小写不敏感这条契约已经丢了）',
);

// ═══════════════════════════════════════════════════════════════════════════
// §2 筛选谓词构造 —— `!= null` 判据 / 占位符顺序 / 同源
// ═══════════════════════════════════════════════════════════════════════════

function collect(options) {
  const conditions = [];
  const params = [];
  MAIN.pushOrgMetaConditions(conditions, params, options);
  return { conditions, params, sql: conditions.join(' AND ') };
}

// ── 2.1 🔴 本条守护的核心：0 与 'none' 必须**真的进筛选**，不能被 truthy 判据吃掉 ──
{
  const zero = collect({ rating: 0 });
  assert.equal(zero.conditions.length, 1, '🔴 `rating: 0`（未评分）必须进筛选，不能被当成「不限」');
  assert.equal(zero.sql, 'rating = ?');
  assert.deepEqual(zero.params, [0], '绑定的必须是数字 0，不是 "0" / 空串');

  const none = collect({ flag: 'none' });
  assert.equal(none.conditions.length, 1, '🔴 `flag: "none"`（未标记）必须进筛选');
  assert.equal(none.sql, 'flag = ?');
  assert.deepEqual(none.params, ['none']);
}

// ── 2.2 「不限」= 键不存在 / null / 空串（`<select>` 的未选择档提交空串） ──
for (const options of [
  {},
  undefined,
  null,
  { rating: null },
  { rating: '' },
  { flag: null },
  { flag: '' },
  { tagIds: null },
  { tagIds: [] },
]) {
  const got = collect(options);
  assert.equal(
    got.conditions.length,
    0,
    `「不限」不该产生条件：${JSON.stringify(options)} → ${got.sql}`,
  );
  assert.equal(got.params.length, 0);
}

// ── 2.3 标签：AND 语义 + 占位符顺序 + `photos.id` 前缀 ──
{
  const and = collect({ tagIds: [3, 7] });
  assert.equal(and.conditions.length, 1, '多标签只产生一条子查询（不是 N 个 EXISTS）');
  assert.match(and.sql, /^photos\.id IN \(SELECT photo_id FROM photo_tags WHERE tag_id IN \(\?, \?\)/);
  assert.ok(
    and.sql.includes('HAVING COUNT(*) = ?'),
    'AND 语义靠 HAVING COUNT(*) 收口；写成 OR（不用 HAVING）会让勾选越多结果越多',
  );
  assert.ok(
    !/COUNT\(\s*DISTINCT/.test(and.sql),
    'photo_tags 是 (photo_id, tag_id) 联合主键 ⇒ COUNT(*) 与 COUNT(DISTINCT tag_id) 恒等，' +
      '后者白建一张临时去重表。改成 DISTINCT 说明那个主键可能已经不在了',
  );
  assert.match(
    and.sql,
    /photos\.id/,
    '🔴 必须是带表名前缀的 `photos.id`：本函数与 `getPhotos`（`FROM photos`）及带 JOIN 的查询共用，裸 `id` 有歧义',
  );
  assert.deepEqual(and.params, [3, 7, 2], '绑定顺序 = 占位符出现顺序，末尾是期望的标签个数');

  // 占位符数量必须与 params 数量相等（顺序契约的机械检查，对每个分支都做一遍）
  for (const options of [
    { rating: 0 },
    { flag: 'none' },
    { tagIds: [1] },
    { tagIds: [1, 2, 3] },
    { rating: 5, flag: 'pick', tagIds: [4, 5] },
  ]) {
    const got = collect(options);
    const marks = got.sql.split('?').length - 1;
    assert.equal(
      marks,
      got.params.length,
      `占位符 ${marks} 个 ≠ 绑定值 ${got.params.length} 个（${JSON.stringify(options)}）`,
    );
  }
}

// ── 2.4 标签 id 的清洗：去重 + 剔除非正整数 ──
{
  const got = collect({ tagIds: [5, 5, '5', 0, -1, NaN, 'abc', 6] });
  assert.deepEqual(got.params, [5, 6, 2], '去重 + 剔除非法 id，且 `HAVING COUNT(*)` 用**清洗后**的个数');
  assert.deepEqual(collect({ tagIds: [0, -1, NaN] }).conditions, [], '全是非法 id ⇒ 不产生条件');

  // 三个维度同时给：条件顺序必须与 params 顺序一一对应
  const all = collect({ rating: 4, flag: 'reject', tagIds: [9] });
  assert.equal(all.sql, 'rating = ? AND flag = ? AND photos.id IN (SELECT photo_id FROM photo_tags WHERE tag_id IN (?) GROUP BY photo_id HAVING COUNT(*) = ?)');
  assert.deepEqual(all.params, [4, 'reject', 9, 1]);
}

// ── 2.5 🔴 `hasOrgMetaFilter` 与 `pushOrgMetaConditions` 必须逐输入同源 ──
//     一个说「有筛选」而另一个没 push（或反过来），会得到一个只在特定参数下出现的错误结果。
{
  const matrix = [
    {},
    undefined,
    null,
    { rating: null },
    { rating: '' },
    { rating: 0 },
    { rating: 5 },
    { rating: '0' },
    { flag: null },
    { flag: '' },
    { flag: 'none' },
    { flag: 'pick' },
    { tagIds: [] },
    { tagIds: null },
    { tagIds: [0] },
    { tagIds: [3] },
    { rating: 0, flag: 'none', tagIds: [0] },
    { rating: 0, flag: 'none', tagIds: [2] },
  ];
  for (const options of matrix) {
    const pushed = collect(options).conditions.length > 0;
    assert.equal(
      MAIN.hasOrgMetaFilter(options),
      pushed,
      `🔴 两条判据不同源：hasOrgMetaFilter(${JSON.stringify(options)}) = ${MAIN.hasOrgMetaFilter(options)}，` +
        `而 pushOrgMetaConditions 实际${pushed ? '有' : '没有'}产生条件。` +
        '（`searchPhotos` 的索引快路径就靠这个判据决定要不要放弃，漂开必然出错结果）',
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §3 真库行为：写入语义 + 六处查询端到端取同一批图
// ═══════════════════════════════════════════════════════════════════════════

const PhotoDatabase = require('../src/database');
const heavy = require('../src/db-heavy-read');
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE photos (
    id INTEGER PRIMARY KEY, root_id INTEGER, file_name TEXT, file_path TEXT,
    folder_path TEXT, file_size INTEGER, file_type TEXT, width INTEGER, height INTEGER,
    date_taken TEXT, date_modified TEXT, has_thumbnail INTEGER, is_favorite INTEGER
  );
  CREATE TABLE root_folders (id INTEGER PRIMARY KEY, path TEXT);
`);
{
  // 🔴 夹具是手工建表、绕过了 `init()`，所以「迁移才会补的列」必须**调用真实迁移函数**补齐
  //    （不是手抄列定义 —— 手抄的话每次加列都要同步改夹具，必然漂移）。
  //    `photoListColumns()` 已把 rating / flag 收进基线 ⇒ 所有列表查询都会 SELECT 它们，
  //    夹具缺列会在 `db.prepare` 上抛 `no such column`，报错栈落在查询实现里，看起来像代码 bug。
  const migrator = Object.create(PhotoDatabase.prototype);
  migrator.db = db;
  migrator.ensurePhotosLivePhotoColumns();
  migrator.ensurePhotosThumbnailMetaColumns();
  migrator.ensurePhotosOrgMetaColumns();
  migrator.ensureOrgTagSchema();
}

const ALBUM = 'C:\\photos\\album';
const SUB = 'C:\\photos\\album\\sub';
db.prepare('INSERT INTO root_folders VALUES (1, ?)').run('C:\\photos');
// 列名逐列写出来，不用位置式 VALUES —— 位置式会在「迁移补了新列」那一刻变成
// `table photos has N columns but M values were supplied`，而报错栈不在业务代码里。
const insert = db.prepare(
  `INSERT INTO photos
     (id, root_id, file_name, file_path, folder_path, file_size, file_type,
      width, height, date_taken, date_modified, has_thumbnail, is_favorite)
   VALUES (?, 1, ?, ?, ?, 1, 'jpg', 1, 1, ?, ?, 1, 0)`,
);
function add(id, folder, date) {
  insert.run(id, `${id}.jpg`, `${folder}\\${id}.jpg`, folder, date, date);
}
add(1, ALBUM, '2026-01-01 10:00:00');
add(2, ALBUM, '2026-01-01 11:00:00');
add(3, ALBUM, '2026-01-01 12:00:00');
add(4, ALBUM, '2026-01-01 13:00:00');
add(5, SUB, '2026-01-02 10:00:00');
add(6, SUB, '2026-01-01 14:00:00');

const inst = Object.create(PhotoDatabase.prototype);
inst.db = db;

// ── 3.1 写评分：夹取 + 「行不存在」返回 null（界面据此丢弃回包） ──
// 🔴 **id=1 是「既没评分也没标记也没标签」的基准行，任何写入测试都不许碰它。**
//    第一版就是拿它做的「越界夹取」测试，于是它变成了 5 星 ⇒ `rating = 0` 那条断言
//    少了一张图而变红 —— 而那看起来像是**产品代码**筛错了。夹具口径要在注释里写死。
//    目标口径见 §3.4 的注释（这里先把每一行的最终态列出来）：
//      1 = 0 星 / none / 无标签   2 = 5 星 / pick / 客户A
//      3 = 3 星 / reject / 客户A+2024      4 = 0 星 / pick / 2024
//      5 = 4 星 / none / 无标签（在 SUB 目录，日期另一天）   6 = 2 星 / reject / 客户a
assert.deepEqual(inst.setPhotoRating(2, 7), { id: 2, rating: 5 }, '越界夹到 5（id=2 本来就该是 5 星）');
assert.deepEqual(inst.setPhotoRating(2, '5'), { id: 2, rating: 5 }, '字符串数字也走同一条归一');
assert.deepEqual(inst.setPhotoRating(3, 3), { id: 3, rating: 3 });
assert.deepEqual(inst.setPhotoRating(5, 4), { id: 5, rating: 4 });
assert.deepEqual(inst.setPhotoRating(6, 2), { id: 6, rating: 2 });
assert.equal(inst.setPhotoRating(999, 3), null, '行不存在 ⇒ null');
assert.equal(inst.setPhotoRating(0, 3), null, 'id 非法 ⇒ null');
assert.equal(inst.setPhotoRating('abc', 3), null);
assert.deepEqual(inst.setPhotoRating(4, -2), { id: 4, rating: 0 }, '负数夹到 0（＝取消评分）');

// ── 3.2 写标记：**幂等设值**，不是 toggle ──
//      toggle 会让「以为没按上、其实按上了」的再按一次把已标好的行清掉，
//      而用户当时正在看下一张 —— 根本不知道上一张的标记没了。
assert.deepEqual(inst.setPhotoFlag(2, 'PICK'), { id: 2, flag: 'pick' }, '大小写归一');
assert.deepEqual(inst.setPhotoFlag(2, 'pick'), { id: 2, flag: 'pick' }, '🔴 重复写同一个值必须仍是同一个值，不许翻转');
assert.deepEqual(inst.setPhotoFlag(3, 'reject'), { id: 3, flag: 'reject' });
assert.deepEqual(inst.setPhotoFlag(4, 'pick'), { id: 4, flag: 'pick' });
assert.deepEqual(inst.setPhotoFlag(6, 'reject'), { id: 6, flag: 'reject' });
// 白名单外的值在 id=5 上试（id=5 本来就该是 'none'，不污染别的断言的夹具口径）
assert.deepEqual(inst.setPhotoFlag(5, 'nonsense'), { id: 5, flag: 'none' }, '白名单外回落 none');
assert.equal(inst.setPhotoFlag(999, 'pick'), null);

// ── 3.3 写标签：全量替换 / 自动建标签 / 按归一键去重保留首次原文 / 空名丢弃 ──
assert.deepEqual(
  inst.setPhotoTags(2, ['客户A', '  客户A  ', '客户a', '', '   ']).tags.map((t) => t.name),
  ['客户A'],
  '🔴 归一后是同一个标签，「客户A」在前 ⇒ 保留第一次出现的原文写法（不是覆盖成最后一个小写）',
);
inst.setPhotoTags(3, ['客户A', '2024']);
inst.setPhotoTags(4, ['2024']);
inst.setPhotoTags(6, ['客户a']);
inst.setPhotoTags(5, []);
assert.deepEqual(inst.setPhotoTags(5, []).tags, [], '全量替换成空 ⇒ 清空');
// 🔴 「行不存在」必须**返回 null**，与 setPhotoRating / setPhotoFlag 一致。
//    两个调用方都写了这一分支（`main.js` 回「图片记录不存在」、`web-server.js` 回 404）——
//    数据层若改成抛外键错，那两个分支会变成永不可达，用户拿到一句英文数据库错误。
//    （`photo_tags.photo_id` 的外键真开着：better-sqlite3 默认 `foreign_keys = 1`，
//      `open()` 里又显式设了一次 ⇒ 不检查就必然抛。）
assert.doesNotThrow(
  () => inst.setPhotoTags(999, ['x']),
  '🔴 往不存在的图片 id 写标签必须返回 null，不能抛外键错',
);
assert.equal(inst.setPhotoTags(999, ['x']), null, '不存在的图片 ⇒ null（不是抛错、也不是空集合）');
assert.equal(
  db.prepare('SELECT COUNT(*) AS c FROM tags WHERE normalized_name = ?').get('x').c,
  0,
  '失败的写入不许留下半截数据（整条替换在一个事务里，外键异常要整体回滚）',
);
assert.equal(inst.setPhotoTags(999, []), null, '空数组也不该绕过行存在性检查');

// 🔴 挂在 id=1 上建一个「只挂过一次、随后被摘掉」的标签：
//    它必须**留在字典里**（0 张），因为用户正要靠这个计数决定删不删它。
//    「顺手清理没人用的标签」会让刚建好、还没挂图的标签凭空消失。
inst.setPhotoTags(1, ['孤标签']);
assert.deepEqual(inst.getPhotoTags(1).map((t) => t.name), ['孤标签']);
inst.setPhotoTags(1, []);
assert.deepEqual(inst.getPhotoTags(1), [], '摘掉后这张图没有标签');
assert.deepEqual(
  inst.setPhotoTags(1, 'not-an-array').tags,
  [],
  '非数组按空集合处理（全量替换语义下等价于清空），不许抛',
);

const tagDict = inst.listTags();
assert.ok(
  tagDict.some((t) => t.name === '客户A'),
  '「客户A」与「客户a」必须是**同一个**标签行（归一键大小写不敏感）',
);
assert.equal(tagDict.filter((t) => String(t.name).toLowerCase() === '客户a').length, 1);
assert.equal(
  Number(tagDict.find((t) => t.name === '孤标签').photo_count),
  0,
  '🔴 0 张照片的标签必须出现在字典里且计数为 0（LEFT JOIN 而不是「取在用的 tag_id 再查」）',
);
assert.deepEqual(inst.getPhotoTags(4).map((t) => t.name), ['2024']);
assert.deepEqual(inst.getPhotoTags(0), [], 'id 非法 ⇒ 空数组，不抛');

// ── 3.4 🔴 端到端：`rating = 0` / `flag = 'none'` 真的能筛出「还没标」的那批 ──
//      夹具的目标口径（§3.2 上方已列一遍）：
//        1 = 0 星 / none / 无标签    2 = 5 星 / pick / 客户A
//        3 = 3 星 / reject / 客户A+2024   4 = 0 星 / pick / 2024
//        5 = 4 星 / none / 无标签（SUB，另一天）   6 = 2 星 / reject / 客户a
const ids = (res) => (res.photos || []).map((p) => p.id).sort((a, b) => a - b);
/** ⚠️ 断言**顺序**时必须用这个（`ids` 会按 id 排序 ⇒ 拿它判顺序是恒真的假绿）。 */
const order = (res) => (res.photos || []).map((p) => p.id);

assert.deepEqual(ids(inst.getPhotos({})), [1, 2, 3, 4, 5, 6], '无筛选 ⇒ 全部');
assert.deepEqual(
  ids(inst.getPhotos({ rating: 0 })),
  [1, 4],
  '🔴 `rating = 0` 筛的是「未评分」那批。若判据写成 truthy，这里会静默返回全部 6 张',
);
assert.deepEqual(ids(inst.getPhotos({ rating: 5 })), [2]);
assert.deepEqual(
  ids(inst.getPhotos({ flag: 'none' })),
  [1, 5],
  '🔴 `flag = "none"` 筛的是「未标记」那批。同上，truthy 判据会让它无声退化成「不筛」',
);
assert.deepEqual(ids(inst.getPhotos({ flag: 'pick' })), [2, 4]);

const custA = tagDict.find((t) => t.name === '客户A').id;
const y2024 = tagDict.find((t) => t.name === '2024').id;
assert.deepEqual(ids(inst.getPhotos({ tagIds: [custA] })), [2, 3, 6], '「客户a」也归一进来了');
assert.deepEqual(
  ids(inst.getPhotos({ tagIds: [custA, y2024] })),
  [3],
  '🔴 AND 语义：选两个标签要的是**交集**（OR 会让勾选越多结果越多，与逐步收窄的直觉相反）',
);
assert.deepEqual(ids(inst.getPhotos({ rating: 5, flag: 'none' })), [], '两个维度同时约束');

// ── 3.5 🔴 排序白名单含 `rating`（否则静默退回 date_taken，用户「按评分看一遍」落空） ──
assert.equal(
  order(inst.getPhotos({ sortBy: 'rating', sortOrder: 'DESC' }))[0],
  2,
  '🔴 `getPhotos` 的 sortBy 白名单必须含 rating；不在白名单时会**静默**退回 date_taken，' +
    '不报错，只是顺序不对（最高分的 id=2 应排在第一）',
);
assert.equal(
  order(inst.getFolderPhotos(ALBUM, { sortBy: 'rating', sortOrder: 'DESC' }))[0],
  2,
  '🔴 `getFolderPhotos` 的白名单也必须含 rating —— 两处漂开就是「浏览页能按评分排、目录页不能」',
);

// ── 3.6 🔴 六处查询必须取同一批图（这是 `_pushOrgMetaConditions` 存在的唯一理由） ──
const scopeIds = (options) => {
  const scope = inst._buildPreviewScopeWhere(options);
  return db
    .prepare(`SELECT id FROM photos ${scope.whereSql}`)
    .all(...scope.params)
    .map((r) => r.id)
    .sort((a, b) => a - b);
};

for (const options of [
  { rating: 0 },
  { rating: 5 },
  { flag: 'none' },
  { flag: 'reject' },
  { tagIds: [custA] },
  { tagIds: [custA, y2024] },
  { rating: 5, flag: 'none' },
]) {
  const list = ids(inst.getPhotos(options));
  const scope = scopeIds(Object.assign({ view: 'all' }, options));
  assert.deepEqual(
    scope,
    list,
    `🔴 浏览列表与预览作用域筛出了不同的集合（${JSON.stringify(options)}）：` +
      `列表 ${JSON.stringify(list)}、预览 ${JSON.stringify(scope)}。` +
      '这不报错，只在按左右键翻到页边界时才看得出来（「列表里没有它、预览却翻到它」）',
  );

  // 目录页两个模式都要对：`getFolderPhotos` 的 `includeSubfolders` **默认 true**，
  // 而预览的 folder 视图默认也是 true —— 只测一个模式会漏掉「进子目录/不进子目录」这条分叉。
  for (const incSub of [true, false]) {
    const folder = ids(
      inst.getFolderPhotos(ALBUM, Object.assign({ includeSubfolders: incSub }, options)),
    );
    const folderScope = scopeIds(
      Object.assign(
        { view: 'folder', path: ALBUM, includeSubfolders: incSub },
        options,
      ),
    );
    assert.deepEqual(
      folderScope,
      folder,
      `🔴 目录页（includeSubfolders=${incSub}）与预览作用域（folder 视图）筛出了不同的集合` +
        `（${JSON.stringify(options)}）`,
    );
  }

  const day = ids(heavy.runGetDatePhotos(db, '2026-01-01', options));
  const dayOnly = scopeIds(Object.assign({ view: 'date', date: '2026-01-01' }, options));
  assert.deepEqual(
    dayOnly,
    day,
    '🔴 日期页（`db-heavy-read.js#runGetDatePhotos`）与预览作用域（date 视图）筛出了不同的集合' +
      `（${JSON.stringify(options)}）—— 这两条是实现里的两份代码，最容易漂开`,
  );
}

// ── 3.7 剩余两处（搜图页 / 标签导航页）走**源码扫描** ──
//     它们分别在 `searchPhotos`（依赖 FTS / 索引快路径）与 `main.js#fetchTagNavPhotoRows`
//     （需要 electron 运行时）里，本脚本不启动它们；但「有没有接上同一个收集器」可以静态判。
{
  const src = stripJs(read('src/database.js'));
  const start = src.indexOf('searchPhotos(query, options = {})');
  assert.ok(start > 0, '找不到 `searchPhotos` —— 函数签名变了就把这条断言一起改');
  const body = src.slice(start, start + 4000);
  assert.match(body, /_pushOrgMetaConditions\(/, '🔴 `searchPhotos` 必须接上共享收集器');
  assert.match(
    body,
    /hasOrgMetaFilter\(/,
    '🔴 `searchPhotos` 的索引快路径必须用 `hasOrgMetaFilter()` 判「有没有额外筛选」，' +
      '不许自己写 `options.rating || options.flag`（那会把 `rating: 0` 判成没有筛选）',
  );

  const mainSrc = stripJs(read('src/main.js'));
  const tagNavStart = mainSrc.indexOf('function fetchTagNavPhotoRows(');
  assert.ok(tagNavStart > 0, '找不到 `fetchTagNavPhotoRows`');
  const tagNavBody = mainSrc.slice(tagNavStart, tagNavStart + 2500);
  assert.match(
    tagNavBody,
    /_pushOrgMetaConditions\(/,
    '🔴 标签导航页必须接上共享收集器（否则「标签页里筛已选」会是唯一不生效的那一页）',
  );

  // 六处调用点都是「把调用方自己的 options 原样传进去」，不许在调用点重建对象 ——
  // 重建就是「漏一个维度」的入口。
  // 🔴 扫描前必须**剥注释**：本文件（以及 `database.js` 自己）的注释里就引用了
  //    `` `db._pushOrgMetaConditions(...)` `` 这种字面量，不剥会把注释当代码判 ——
  //    这一条在 `i18n-pack-regression` 上已经踩过一次（HTML 版），JS 版同理。
  const dbCode = stripJs(read('src/database.js'));
  // 只认**语句**（行尾 `;`）⇒ 定义处（后面跟 `{`）不会被算进来，也不必再按文本过滤 ——
  // 第一版按「是否等于 `(conditions, params, options)`」过滤，结果把 `getPhotos` 那个
  // 参数恰好同名的**真实调用点**一起滤掉了（3 处、误报「少了一处」）。
  const callSites = dbCode.match(/_pushOrgMetaConditions\([^)]*\)\s*;/g) || [];
  assert.ok(
    callSites.length >= 4,
    `database.js 里的共享收集器调用点只有 ${callSites.length} 处（期望 ≥4：getPhotos / _buildPreviewScopeWhere / getFolderPhotos / searchPhotos）`,
  );
  for (const call of callSites) {
    assert.match(
      call,
      /options\s*\)\s*;$/,
      `🔴 调用点必须把**调用方的 options 原样**传进去，不许就地重建：${call}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §4 三条通道（IPC / HTTP / 渲染端 api）名字对得上
// ═══════════════════════════════════════════════════════════════════════════

const IPC_CHANNELS = ['photo-set-rating', 'photo-set-flag', 'photo-get-tags', 'photo-set-tags'];
{
  const preload = read('src/preload.js');
  const mainJs = read('src/main.js');
  for (const channel of IPC_CHANNELS) {
    assert.ok(
      preload.includes(`'${channel}'`),
      `preload 里没有 '${channel}' —— 渲染端调不通（invoke 会 reject）`,
    );
    assert.ok(
      mainJs.includes(`ipcMain.handle('${channel}'`),
      `main.js 里没有 ipcMain.handle('${channel}' —— preload 发了没人接，症状是「点了没反应」`,
    );
  }

  // preload 的 invoke 名单必须全部被 main.js handle 覆盖（整体的名字漂移防护）
  const invoked = new Set(
    [...read('src/preload.js').matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]),
  );
  const handled = new Set(
    [...mainJs.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]),
  );
  const orphans = [...invoked].filter((name) => !handled.has(name));
  assert.deepEqual(
    orphans,
    [],
    `🔴 preload 里这些通道名在 main.js 里没有 handler（改成动态拼名的话请把这条断言改成匹配那套规则）：${orphans.join(', ')}`,
  );

  // 渲染端 api 薄壳必须四个都在，且与 IPC 一一对应
  const api = read('src/renderer/api.js');
  for (const fn of ['photoSetRating', 'photoSetFlag', 'photoGetTags', 'photoSetTags']) {
    assert.ok(api.includes(`call('${fn}'`), `渲染端 api.js 缺 ${fn} 的薄壳`);
  }
}
{
  // HTTP：网页端请求的路径必须是 `web-server.js` 里真的注册过的路由。
  // 漂开的症状是 404 —— 但网页端把非 200 统一走 toast「操作失败」，等于「点了没反应」。
  const server = read('src/web-server.js');
  const routes = new Set(
    [...server.matchAll(/pathname === '(\/api\/[^']+)'/g)].map((m) => m[1]),
  );
  for (const route of ['/api/photo-rating', '/api/photo-flag', '/api/photo-tags', '/api/tags']) {
    assert.ok(routes.has(route), `web-server.js 没有注册 ${route}（路由表里找不到）`);
  }

  const webApp = read('src/web/js/app.js');
  const used = new Set([...webApp.matchAll(/'(\/api\/[a-z-]+)'/g)].map((m) => m[1]));
  const orgUsed = [...used].filter((u) =>
    ['/api/photo-rating', '/api/photo-flag', '/api/photo-tags', '/api/tags'].includes(u),
  );
  assert.ok(
    orgUsed.length >= 4,
    `网页端 app.js 里只找到 ${orgUsed.length} 个 org 相关端点（期望 4 个：rating / flag / tags / tags 字典）`,
  );
  const missing = orgUsed.filter((u) => !routes.has(u));
  assert.deepEqual(missing, [], `🔴 网页端在请求未注册的端点（会 404）：${missing.join(', ')}`);

  // 🔴 `tagIds` 必须走**逗号分隔**：本文件的 query 是 `Object.fromEntries(entries())`，
  //    重复键只留最后一个 ⇒ `?tagIds=1&tagIds=2` 会静默变成「只筛 2」。
  const parseStart = server.indexOf("if (query.tagIds !== undefined && query.tagIds !== '')");
  assert.ok(parseStart > 0, '找不到 tagIds 的解析处');
  assert.match(
    server.slice(parseStart, parseStart + 260),
    /\.split\(','\)/,
    '🔴 `tagIds` 必须按逗号拆（重复查询参数会被 `Object.fromEntries` 静默吃掉前一个）',
  );
  assert.match(
    webApp,
    /f\.tagIds\.join\(','\)/,
    '🔴 网页端拼查询串时也必须用逗号连（与后端的解析方式成对，改一边就是「筛了没生效」）',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// §5 渲染端真模块（vm 加载 `src/renderer/org-meta-ui.js`）
// ═══════════════════════════════════════════════════════════════════════════

class El {
  constructor(tag, className) {
    this.tagName = tag;
    this.className = className || '';
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.inserted = [];
    this.textContent = '';
    const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
    this.classList = {
      toggle: (n, on) => {
        if (on) set.add(n);
        else set.delete(n);
      },
      contains: (n) => set.has(n),
      add: (n) => set.add(n),
      remove: (n) => set.delete(n),
    };
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  removeChild(n) {
    this.children = this.children.filter((c) => c !== n);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  _matches(selector) {
    return selector.split(',').some((raw) => {
      const s = raw.trim();
      return s.startsWith('.') && String(this.className).split(/\s+/).includes(s.slice(1));
    });
  }
  _all(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child._matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this._all(selector)[0] || null;
  }
  querySelectorAll(selector) {
    return this._all(selector);
  }
  /** 真 DOM 里插在兄弟位置；这里只记录「是谁、插到了哪、内容是什么」。 */
  insertAdjacentHTML(position, html) {
    this.parentNode.inserted.push({ position, html });
  }
}

const CARD_ID = 42;
const card = new El('div', 'photo-card');
card.setAttribute('data-photo-id', String(CARD_ID));
const thumb = new El('img', 'photo-thumb');
const flagBadge = new El('span', 'photo-card-flag photo-card-flag--pick');
const ratingBadge = new El('span', 'photo-card-rating');
const info = new El('div', 'photo-info');
card.append(thumb, flagBadge, ratingBadge, info);

const starsBox = new El('div', 'preview-rating-stars');
for (let v = 1; v <= 5; v++) {
  const star = new El('button', 'preview-rating-star');
  star.setAttribute('data-rating', String(v));
  starsBox.append(star);
}
// 「整理」抽屉的入口按钮。id 2026-10-09 从 `previewTagsBtn` 改成 `previewOrgBtn`
// （它开的是整个抽屉，不再只是标签面板）—— 夹具必须跟着改，
// 否则本节会「用旧 id 测新代码」：`syncPreviewControls` 找不到按钮 ⇒ 静默跳过角标断言，
// 而断言的 `assert.equal` 还在下一行跑着（假绿）。
const orgBtn = new El('button', 'preview-org-btn');
const tagsCount = new El('span', 'preview-tags-count');
orgBtn.append(tagsCount);

const win = {};
const sandbox = {
  window: win,
  document: {
    querySelector: (sel) => {
      const m = /data-photo-id="(\d+)"/.exec(sel);
      return m && m[1] === String(CARD_ID) ? card : null;
    },
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(read('src/renderer/org-meta-ui.js'), sandbox, { filename: 'org-meta-ui.js' });
const ORG = win.RendererOrgMetaUI;
assert.ok(ORG, '`org-meta-ui.js` 必须在 `window.RendererOrgMetaUI` 上挂东西');

// ── 5.1 🔴 两端镜像必须逐输入等价（漂移的后果是「桌面端有 5 颗星、网页端 7 颗」这类分叉） ──
assert.equal(ORG.RATING_MIN, MAIN.RATING_MIN);
assert.equal(ORG.RATING_MAX, MAIN.RATING_MAX);
assert.deepEqual(Array.from(ORG.FLAG_VALUES), Array.from(MAIN.FLAG_VALUES));
for (const input of [undefined, null, NaN, '', 'abc', -3, 0, '0', 1, '4', 3.9, 5, 9, '7']) {
  assert.equal(
    ORG.normalizeRating(input),
    MAIN.normalizeRating(input),
    `🔴 渲染端与主进程的 normalizeRating 漂开了（输入 ${JSON.stringify(input)}）`,
  );
}
for (const input of [undefined, null, '', '   ', 'pick', 'PICK', ' Pick ', 'reject', 'none', 'true', 1]) {
  assert.equal(
    ORG.normalizeFlag(input),
    MAIN.normalizeFlag(input),
    `🔴 渲染端与主进程的 normalizeFlag 漂开了（输入 ${JSON.stringify(input)}）`,
  );
}
assert.equal(ORG.normalizeTagDisplayName('  客户A  '), MAIN.normalizeTagDisplayName('  客户A  '));

// ── 5.2 「点同一颗星即取消」的判据只写一份（按钮与快捷键共用） ──
assert.equal(ORG.nextRating(0, 2), 2);
assert.equal(ORG.nextRating(3, 5), 5);
assert.equal(ORG.nextRating(3, 3), 0, '🔴 再点同一颗 = 取消（回 0），不是保持');
assert.equal(ORG.nextRating('3', '3'), 0);
assert.equal(ORG.nextRating(5, 0), 0, '显式传 0 = 取消（给「清除评分」入口留的）');

// ── 5.3 🔴 卡片两个 data 属性的名字：写入与回读必须同源 ──
{
  const attrs = ORG.cardOrgDataAttrs({ id: 1, flag: 'PICK', rating: 7 });
  assert.ok(attrs.includes('data-org-flag="pick"'), `基准属性：${attrs}`);
  assert.ok(attrs.includes('data-org-rating="5"'), `基准属性（越界夹取）：${attrs}`);
  assert.equal(ORG.cardOrgDataAttrs(null), '');

  // 卡上已有标记 pick + 3 星；这次只改评分（→ 取消）。
  // 🔴 若 `updateCardBadge` 回读不到标记（属性名漂了），pick 角标会被一起擦掉 —— 不报错。
  card.setAttribute('data-org-flag', 'pick');
  card.setAttribute('data-org-rating', '3');
  ORG.updateCardBadge(CARD_ID, { rating: 0 });
  const last = card.inserted[card.inserted.length - 1];
  assert.ok(last, 'updateCardBadge 应该往卡上插回角标');
  assert.equal(last.position, 'beforebegin', '角标插在 `.photo-info` 之前（与建卡期同一位置）');
  assert.ok(
    last.html.includes('photo-card-flag--pick'),
    '🔴 只改评分时已有的「已选」标记角标必须还在 —— 回读断掉的话它会静默消失',
  );
  assert.ok(!last.html.includes('photo-card-rating'), '0 星不画评分角标（画满等于没画）');
  assert.equal(card.getAttribute('data-org-flag'), 'pick', 'data-org-flag 必须被保留');
  assert.equal(card.getAttribute('data-org-rating'), '0', 'data-org-rating 要写回新值（供下次回读）');

  // 反向：只改标记时评分角标必须还在
  card.children = [];
  const b1 = new El('span', 'photo-card-flag');
  const b2 = new El('span', 'photo-card-rating');
  const info2 = new El('div', 'photo-info');
  card.append(b1, b2, info2);
  card.setAttribute('data-org-flag', 'pick');
  card.setAttribute('data-org-rating', '4');
  ORG.updateCardBadge(CARD_ID, { flag: 'none' });
  const last2 = card.inserted[card.inserted.length - 1];
  assert.ok(!last2.html.includes('photo-card-flag'), '改成 none 后不画标记角标');
  assert.ok(
    last2.html.includes('photo-card-rating'),
    '🔴 只改标记时已有的评分角标必须还在（回读掉的话它会被静默擦掉）',
  );
  assert.equal(card.getAttribute('data-org-flag'), 'none');
  assert.equal(card.getAttribute('data-org-rating'), '4', '评分维度沿用卡片现值');
}

// ── 5.4 内存态补丁要同时改 `currentPhotos` **和** `previewPhotos` ──
//      只改一个的后果都是静默的（关掉预览后网格还是旧角标 / 预览工具条不动），
//      而两者是**不同对象**（预览会跨页加载），不能指望改一个另一个跟着。
{
  const state = {
    currentPhotos: [{ id: 7, rating: 0, flag: 'none' }],
    previewPhotos: [{ id: 7, rating: 0, flag: 'none' }],
    slideshowRandomPool: [{ id: 7, rating: 0, flag: 'none' }],
  };
  ORG.patchInState(state, '7', { rating: 5 });
  for (const key of ['currentPhotos', 'previewPhotos', 'slideshowRandomPool']) {
    assert.equal(state[key][0].rating, 5, `${key} 没跟着更新`);
  }
  assert.equal(state.currentPhotos[0].flag, 'none', '没在 patch 里的维度不许被动');
  assert.equal(ORG.currentPhotoId({ previewPhotos: [{ id: 9 }], previewIndex: 0 }), 9);
  assert.equal(ORG.currentPhotoId({ previewPhotos: [] }), 0);
  assert.equal(ORG.currentPhotoId(null), 0);
}

// ── 5.5 🔴 筛选态的判据必须与主进程 `hasOrgMetaFilter` 同源 ──
//      两端任一说「有」另说「没有」，会出现「筛选栏亮着、结果没筛」（或反过来）。
{
  const matrix = [
    { rating: null, flag: null, tagIds: [] },
    { rating: 0, flag: null, tagIds: [] },
    { rating: null, flag: 'none', tagIds: [] },
    { rating: null, flag: null, tagIds: [3] },
    { rating: 0, flag: 'none', tagIds: [] },
  ];
  for (const filter of matrix) {
    const state = { orgFilter: Object.assign({}, filter, { tagIds: filter.tagIds.slice() }) };
    const asOptions = MAIN.hasOrgMetaFilter(ORG.applyFilterToOptions({}, state));
    const local = ORG.hasActiveFilter(state);
    assert.equal(
      local,
      asOptions,
      `🔴 渲染端与主进程对「有没有生效中的筛选」判断不同（${JSON.stringify(filter)}）`,
    );
    for (const [dim, key] of [
      ['rating', 'rating'],
      ['flag', 'flag'],
      ['tags', 'tagIds'],
    ]) {
      const single = { orgFilter: { rating: null, flag: null, tagIds: [] } };
      single.orgFilter[key] = dim === 'tags' ? filter.tagIds.slice() : filter[key];
      const oneActive =
        dim === 'tags' ? filter.tagIds.length > 0 : filter[key] != null;
      assert.equal(
        ORG.filterMightChangeFor(single, dim),
        oneActive,
        `filterMightChangeFor(${dim}) 与筛选态不符（${JSON.stringify(filter)}）——` +
          '判错的后果是「改完标记后那张图仍留在本该消失的列表里」',
      );
    }
  }

  // 🔴 不加键表达「不限」。加一个 `rating: null` 虽然会被主进程的 `!= null` 判据当成
  //    「没给」，但那意味着多一个键要维护，且「不限」这件事从「键不存在」变成了
  //    「键存在但值是 null」两种表达 —— 本契约只认前一种。
  const untouched = ORG.applyFilterToOptions({ page: 1 }, { orgFilter: ORG.emptyFilter() });
  assert.deepEqual(Object.keys(untouched), ['page'], '没有筛选时不许往 options 里塞 null 键');
  const withFilter = ORG.applyFilterToOptions(
    {},
    { orgFilter: { rating: 0, flag: 'none', tagIds: [4] } },
  );
  assert.deepEqual(withFilter, { rating: 0, flag: 'none', tagIds: [4] }, '🔴 `rating: 0` 也要真的进参数');
  assert.deepEqual(
    Object.keys(ORG.applyFilterToOptions({}, { orgFilter: { rating: null, flag: null, tagIds: [4] } })),
    ['tagIds'],
    '只有标签这一维有值时，另外两个键不许出现',
  );
}

// ── 5.6 预览工具条：星标激活态 / 标记按钮 / 「清除」不高亮 ──
//      「清除」在本来就是 none 的时候**不高亮** —— 高亮它等于说「这张被清除了」，
//      而它只是「没有标记」。
{
  const dom = {
    previewFlagPickBtn: new El('button'),
    previewFlagRejectBtn: new El('button'),
    previewFlagClearBtn: new El('button'),
    previewRatingStars: starsBox,
    previewOrgBtn: orgBtn,
  };
  const state = { previewPhotos: [{ id: 5, flag: 'pick', rating: 0 }], previewIndex: 0, previewTags: [] };
  ORG.syncPreviewControls({ state, dom });
  assert.equal(dom.previewFlagPickBtn.classList.contains('active'), true, 'pick 态高亮「选」');
  assert.equal(dom.previewFlagRejectBtn.classList.contains('active'), false);
  assert.equal(dom.previewFlagClearBtn.classList.contains('active'), false, '非 none 态也不高亮「清除」');
  const stars = starsBox.querySelectorAll('.preview-rating-star');
  assert.deepEqual(
    stars.map((s) => s.classList.contains('active')),
    [false, false, false, false, false],
    '0 星时一颗都不亮（不能出现「全亮」这种读起来像 5 星的状态）',
  );

  state.previewPhotos[0].rating = 3;
  ORG.syncPreviewControls({ state, dom });
  assert.deepEqual(
    stars.map((s) => s.classList.contains('active')),
    [true, true, true, false, false],
    '3 星 ⇒ 前三颗亮',
  );

  state.previewPhotos[0].flag = 'none';
  ORG.syncPreviewControls({ state, dom });
  assert.equal(dom.previewFlagPickBtn.classList.contains('active'), false, '改态后旧高亮要撤掉');
  assert.equal(
    dom.previewFlagClearBtn.classList.contains('active'),
    false,
    '🔴 flag = none 时「清除」按钮**也不高亮**（它只表达「没有标记」，不是「被清除了」）',
  );

  state.previewTags = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  ORG.syncPreviewControls({ state, dom });
  assert.equal(tagsCount.textContent, '2', '标签计数角标');
  assert.equal(orgBtn.classList.contains('has-tags'), true);

  // 标签 chip 的删除叉带 `data-tag-name` 而不是下标（按下标取时连点两下会删错）
  const chips = ORG.tagsChipsHtml(['客户A', '  ', '2024']);
  assert.equal(chips.split('data-tag-name=').length - 1, 2, '空名不产生 chip');
  assert.ok(chips.includes('data-tag-name="客户A"'), '删除叉按名字定位，不按下标');
  assert.ok(ORG.tagsChipsHtml([]).includes('preview-org-tags-empty'), '空集合要有空态文案');
  assert.ok(
    ORG.tagsChipsHtml(['<img onerror=x>']).includes('&lt;img'),
    '🔴 标签名是用户输入，进 HTML 前必须转义',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// §6 「整理」抽屉：可点性 + 结构 + 「不许有第二个入口」
// ═══════════════════════════════════════════════════════════════════════════
//
// 2026-10-09 用户报「冲片条无法点击」。真因**不是被谁盖住**：`.preview-body` 刻意写着
// `pointer-events: none`（让点击穿透到 `.preview-body-inner` 里的图片，好拖拽 / 缩放），
// 而冲片条是它的**直接子元素**、自己又没声明 —— 指针事件是**继承**的属性 ⇒
// 整条冲片条「看得见、点不动」。
// 实测（`%TEMP%/aurora-orgmeta-shot/hit.js` 命中探针，修复前）：
//   `elementsFromPoint` 在条中心与三个标记按钮中心返回的整摞里**根本没有冲片条**，
//   最顶上是 `img#previewImage`；往「否」按钮发真实鼠标事件后
//   `state.previewPhotos[i].flag` 与按钮 `active` 都没变。
//
// 同一轮用户又提「冲片条遮挡图片不美观」，于是整条换成右侧的「整理」抽屉
// （`#previewOrgPanel`）。本条守护因此管三件事：
//
//   ① **可点性**（一类缺陷，不只那一次）：抽屉必须自己声明 `pointer-events: auto`；
//      而 `.preview-body` 那条 `none` **不许删** —— 删了图片就没法拖拽 / 缩放，
//      属于「用一个 bug 换另一个 bug」。正确修法永远是给子元素补 `auto`。
//   ② **结构**：四个「别人按 id 找」的控件必须仍在抽屉里（标记三连 / 五星 /
//      标签 chips / 对比空槽）。搬 DOM 时把 id 丢了，症状是「按钮不见了」，
//      控制台一行字都没有。
//   ③ **唯一入口**：冲片条那一整块（节点 + 样式 + 脚本引用）与那套「点外部收起」
//      的判据必须**整块消失**。留着就是两套入口，而其中一套永远不会亮。
{
  const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
  const stripHtmlComments = (src) =>
    src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  /** 标记 / 样式类文件：HTML 注释与 CSS 注释都要剥。 */
  const stripMarkup = (src) => stripHtmlComments(stripCssComments(src));

  const rendererCss = stripCssComments(read('src/renderer/styles.css'));
  const rendererHtml = stripMarkup(read('src/renderer/index.html'));
  const webHtml = stripMarkup(read('src/web/index.html'));

  /** 收集**所有**选择器串里含 `selector` 的规则体（同特异性规则可能有多条）。 */
  function ruleBodies(source, selector) {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(source))) {
      const selectors = m[1];
      if (selectors.split(',').some((s) => s.trim() === selector)) out.push(m[2]);
    }
    return out;
  }
  const hasAuto = (bodies) => bodies.some((b) => /pointer-events\s*:\s*auto/.test(b));
  const hasNone = (bodies) => bodies.some((b) => /pointer-events\s*:\s*none/.test(b));
  const countOf = (src, needle) => src.split(needle).length - 1;

  /** 取 `function NAME(` 的函数体（花括号配平）。找不到返回 null —— 调用侧必须显式处理。 */
  function functionBody(src, name) {
    const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
    if (!m) return null;
    const i = src.indexOf('{', m.index);
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    return null;
  }

  /**
   * 切出「整理」抽屉那一段 HTML。
   * 边界 = `#previewOrgPanel` → `#previewZoomBox`（两端都是这个先后顺序）。
   */
  function drawerSlice(html, label) {
    const i = html.indexOf('id="previewOrgPanel"');
    assert.ok(i > 0, `${label}: 找不到 \`#previewOrgPanel\``);
    const j = html.indexOf('id="previewZoomBox"', i);
    assert.ok(
      j > i,
      `${label}: 抽屉不在 \`#previewZoomBox\` 之前了 —— 本切片的边界假设失效，` +
        '必须先改这里再改下面的断言',
    );
    // 夹具自证：切出来的必须是「抽屉那一段」，不能整份文件。
    // ⚠️ 切片从 `id="previewOrgPanel"` **之后**开始，所以自证不能拿
    // `class="preview-org-panel"`（它在 id 之前）—— 那会假红。
    // 也只看**类名**不看 id：网页端的关闭按钮没有 id（靠行内 `onclick` 接）。
    const slice = html.slice(i, j);
    assert.ok(
      slice.includes('preview-org-panel-header') && slice.includes('preview-org-section-title'),
      `${label}: 切出来的不是一个完整的抽屉`,
    );
    assert.ok(
      !slice.includes('id="previewOrgBtn"'),
      `${label}: 切片把工具条上的入口按钮也包进来了 —— 上界（#previewZoomBox）失效，` +
        '「控件在抽屉里」这类断言会退化成恒真',
    );
    return slice;
  }

  // ── 6.1 抽屉自己：两端都必须显式 `pointer-events: auto` ──
  assert.ok(
    hasAuto(ruleBodies(rendererCss, '.preview-org-panel.open')),
    '🔴 桌面端 `.preview-org-panel.open` 必须显式 `pointer-events: auto` —— 它的父元素 ' +
      '`.preview-body` 是 `none`，不写就是整块「看得见、点不动」（用户 2026-10-09 报的那个 bug）',
  );
  assert.ok(
    hasAuto(ruleBodies(webHtml, '.preview-org-panel')),
    '🔴 网页端 `.preview-org-panel` 也要写 `auto`：两端这条规则号称「同构」，' +
      '而桌面端不写就是故障 ⇒ 一起写死，免得节点挪进 `.preview-body` 时重踩',
  );

  // ── 6.2 `.preview-body` 的 `none` 是**刻意**的，不许为了修上面那条而删掉它 ──
  assert.ok(
    hasNone(ruleBodies(rendererCss, '.preview-body')),
    '🔴 `.preview-body { pointer-events: none }` 不许删：底下那张图要继续能拖拽 / 缩放。' +
      '「抽屉点不动」的正确修法是给抽屉自己补 `auto`，不是把这条去掉',
  );

  // ── 6.3 同一父元素下的**其它**交互控件也都有 `auto` —— 这是本工程的既有写法。
  //        列出来当**阳性对照**：它们一旦被删，本断言先红。 ──
  for (const [selector, why] of [
    ['.preview-info-panel.open', '图片信息抽屉（打开态才可点，所以写在 .open 那条）'],
    ['.preview-nav', '上一张 / 下一张'],
  ]) {
    assert.ok(
      hasAuto(ruleBodies(rendererCss, selector)),
      `🔴 \`${selector}\`（${why}）丢了 \`pointer-events: auto\` —— 它与「整理」抽屉同在 ` +
        '`.preview-body` 下，丢了这个前缀就是同一类「看得见、点不动」',
    );
  }

  // ── 6.4 抽屉结构：两端都得切得出抽屉，且四个「别人按 id 找」的控件都在里面 ──
  //        `#previewOrgActions` 是 `photo-compare.js#mount()` 的首选落点；
  //        `#previewRatingStars` 是它的降级落点，也是五颗星的容器。
  const REQUIRED_IN_DRAWER = [
    ['previewFavoriteBtn', '收藏'],
    ['previewFlagPickBtn', '标记「选」'],
    ['previewFlagRejectBtn', '标记「否」'],
    ['previewFlagClearBtn', '标记「清除」'],
    ['previewRatingStars', '五颗星容器'],
    ['previewOrgTagsChips', '标签 chip 容器'],
    ['previewOrgTagsInput', '标签输入框'],
    ['previewOrgActions', '「加入对比」的专用挂点'],
  ];
  for (const [label, html] of [
    ['桌面端', rendererHtml],
    ['网页端', webHtml],
  ]) {
    const slice = drawerSlice(html, label);
    for (const [id, what] of REQUIRED_IN_DRAWER) {
      assert.equal(
        countOf(html, `id="${id}"`),
        1,
        `🔴 ${label}的 \`#${id}\`（${what}）必须**恰好一个**：` +
          '零个 = 控件不见了；两个 = `getElementById` 只认第一个，另一个是永远不亮的死节点',
      );
      assert.ok(
        slice.includes(`id="${id}"`),
        `🔴 ${label}的 \`#${id}\`（${what}）跑到「整理」抽屉外面了 —— ` +
          'org-meta-ui / photo-compare 都是按 id 找它的，挪出去既不报错也不生效',
      );
    }
    // 五个分区（标记 / 评分 / 收藏 / 标签 / 对比）一个都不能少：
    // 分区是靠 HTML 结构撑出来的，删一个不会有任何报错，只是那一组控件没入口了。
    assert.equal(
      countOf(slice, 'preview-org-section-title'),
      5,
      `🔴 ${label}的「整理」抽屉应当有 5 个分区（标记 / 评分 / 收藏 / 标签 / 对比）`,
    );
    // 入口在抽屉之前（工具条里）—— 抽屉自己再放一个入口就成了自指。
    assert.ok(
      html.indexOf('id="previewOrgBtn"') > 0 &&
        html.indexOf('id="previewOrgBtn"') < html.indexOf('id="previewOrgPanel"'),
      `🔴 ${label}的入口按钮 \`#previewOrgBtn\` 必须在抽屉**之外、之前**（工具条上）`,
    );
  }

  // ── 6.5 冲片条必须**整块**消失：节点 + 样式 + 脚本引用 + 旧的标签悬浮面板 ──
  //        `css-reference-regression` 也会抓「定义了没人用的样式」，但抓不到
  //        「脚本还在找那个已经不存在的 id」（那是静态引用，不是样式），所以两处都钉。
  for (const [label, rel, strip] of [
    ['桌面端骨架', 'src/renderer/index.html', stripMarkup],
    ['桌面端样式', 'src/renderer/styles.css', stripCssComments],
    ['网页端骨架与内联样式', 'src/web/index.html', stripMarkup],
    ['网页端对比样式', 'src/web/css/photo-compare.css', stripCssComments],
    ['网页端对比模块', 'src/web/js/photo-compare.js', stripJs],
    ['网页端组织元数据逻辑', 'src/web/js/app.js', stripJs],
    ['桌面端预览逻辑', 'src/renderer/app.js', stripJs],
    ['桌面端组织元数据 UI', 'src/renderer/org-meta-ui.js', stripJs],
  ]) {
    const text = strip(read(rel));
    for (const needle of [
      'previewCullingBar',
      'preview-culling-bar',
      'preview-culling-divider',
      'previewTagsBtn',
      'togglePreviewTagsPanel',
      'toggleWebPreviewTagsPanel',
      'previewOrgTagsPanel',
    ]) {
      assert.equal(
        countOf(text, needle),
        0,
        `🔴 ${label}（${rel}）里还留着 \`${needle}\` —— 冲片条 / 标签悬浮面板必须**整块**消失：` +
          '留着就是第二个入口（或一条永远不会被点到的死规则），而它看起来还「在」',
      );
    }
  }

  // ── 6.6 抽屉**不随切图关闭、不随点外部关闭** ──
  //        这两条是「工作台」语义的核心：冲片时用户会在大图与抽屉之间来回点
  //        （选 / 否 / 星），每翻一张就收起、或点一下图就收起，都是最烦的失败模式。
  //        用**函数体扫描**而不是「整文件里有没有这个词」—— 后者被函数名本身满足，
  //        是典型的假绿（工具元规则：符号在整文件里到处有）。
  for (const [label, rel, fnName, closer, witness] of [
    ['桌面端', 'src/renderer/app.js', 'syncPreviewOrgMeta', 'closePreviewOrgPanel', 'syncPreviewControls'],
    ['网页端', 'src/web/js/app.js', 'syncWebPreviewOrgMeta', 'closeWebPreviewOrgPanel', 'previewFlagPickBtn'],
  ]) {
    const body = functionBody(stripJs(read(rel)), fnName);
    assert.ok(
      body && body.includes(witness),
      `夹具自证：没能从 ${rel} 里取出 \`${fnName}\` 的函数体（取不到的话下面那条断言等于没跑）`,
    );
    assert.ok(
      !body.includes(closer) && !body.includes('togglePreviewOrgPanel') &&
        !body.includes('toggleWebPreviewOrgPanel'),
      `🔴 ${label}的 \`${fnName}\` 不许收起「整理」抽屉：翻着图一路标下去是主用法，` +
        '每翻一张就收起来等于逼用户按 N 次（也不许「顺手重开」，那会让用户刚收起又被弹回来）',
    );
  }

  // 「点外部收起」的判据长这样：`closest('#previewOrgPanel')` 只可能出现在
  // 文档级 click 处理里。它一旦出现，就说明有人给抽屉抄了一套信息面板的收起逻辑。
  for (const rel of ['src/renderer/app.js', 'src/web/js/app.js']) {
    const text = stripJs(read(rel));
    assert.ok(
      !/closest\(\s*['"]#previewOrgPanel['"]\s*\)/.test(text) &&
        !/closest\(\s*['"]#previewOrgBtn['"]\s*\)/.test(text),
      `🔴 ${rel} 里出现了针对 \`#previewOrgPanel\` / \`#previewOrgBtn\` 的 ` +
        '`closest(...)` —— 那是「点外部收起」的写法。抽屉是工作台，刻意不抄那套',
    );
  }

  // ── 6.7 右侧抽屉打开时「下一张」必须让开 ──
  //        两个抽屉都是 `right: 0; width: 360px; z-index: 20`，而 `.preview-nav` 是
  //        `right: 16px; z-index: 6` ⇒ 抽屉一开就把右箭头**整个**盖住：点它没反应、
  //        也不报错。实测（`drawer.js`）：抽屉打开后往右箭头中心发真实鼠标事件，
  //        `state.previewIndex` 一动不动。这是 `.preview-info-panel` 时代就有的既有缺陷，
  //        本轮一并修掉 —— 判据 = `#previewOverlay` 上的 `has-right-drawer` 类
  //        （**不是** `.preview-body`：那是个 `z-index: 2` 的层叠上下文，挂在里面
  //        够不着 `.preview-zoom-box`，而缩放胶囊恰好是最显眼的那个受害者）。
  //        两条断言缺一不可：CSS 有规则但没人挂类 ⇒ 等于没修；
  //        挂了类但 CSS 没规则 ⇒ 同样等于没修（而且都不报错）。
  assert.ok(
    /\.preview-overlay\.has-right-drawer\s+\.preview-next\s*\{[^}]*right:\s*min\(376px,\s*calc\(85vw \+ 16px\)\)/.test(
      rendererCss,
    ),
    '🔴 桌面端缺 `.preview-overlay.has-right-drawer .preview-next` 那条让位规则：' +
      '抽屉一开「下一张」就被整个盖住，点它毫无反应。' +
      '⛔ 数值必须与抽屉自己的 `width: 360px` / `max-width: 85vw` 对应（各 +16px），' +
      '改抽屉宽度时要一起改',
  );
  assert.ok(
    /\.preview-overlay\.has-right-drawer\s+\.preview-next\s*\{[^}]*right:\s*min\(376px,\s*calc\(85vw \+ 16px\)\)/.test(
      webHtml,
    ),
    '🔴 网页端同样要有让位规则（两端这条号称「同构」，只写一端等于另一端照旧点不动）',
  );
  // 「缩放百分比」胶囊也必须让开：它是 `#previewOverlay` 的直接子元素，
  // 抽屉那个 `z-index: 20` 压不住它（`.preview-body` 自成 `z-index: 2` 的层叠上下文）
  // —— 实测浅色截图里它正压着「标签」分区的下缘。这也正是类要挂在 `#previewOverlay`
  // 而不是 `.preview-body` 上的原因，所以这条断言顺带把「类挂错地方」也钉住了。
  for (const [label, src] of [
    ['桌面端', rendererCss],
    ['网页端', webHtml],
  ]) {
    assert.ok(
      /\.preview-overlay\.has-right-drawer\s+\.preview-zoom-box\s*\{[^}]*right:\s*min\(372px,\s*calc\(85vw \+ 12px\)\)/.test(
        src,
      ),
      `🔴 ${label}的让位规则漏了 \`.preview-zoom-box\`（缩放百分比胶囊）：` +
        '它浮在抽屉之上，不让开就会压在抽屉内容上',
    );
    assert.ok(
      !/\.preview-body\.has-right-drawer/.test(src),
      `🔴 ${label}把让位类挂回了 \`.preview-body\` —— 那样够不着 \`.preview-zoom-box\`，` +
        '缩放胶囊会重新浮到抽屉上（而且 `next` 那条也会静默失效）',
    );
  }
  for (const [label, rel, fnNames, syncFn] of [
    [
      '桌面端',
      'src/renderer/app.js',
      ['closePreviewInfoPanel', 'togglePreviewInfoPanel', 'closePreviewOrgPanel', 'togglePreviewOrgPanel'],
      '_syncPreviewRightDrawerClass',
    ],
    [
      '网页端',
      'src/web/js/app.js',
      ['closePreviewInfoPanel', 'togglePreviewInfoPanel', 'closeWebPreviewOrgPanel', 'toggleWebPreviewOrgPanel'],
      '_syncWebPreviewRightDrawerClass',
    ],
  ]) {
    const src = stripJs(read(rel));
    for (const fnName of fnNames) {
      const body = functionBody(src, fnName);
      assert.ok(
        body && body.includes(syncFn),
        `🔴 ${label}的 \`${fnName}\` 没调 \`${syncFn}\` —— 抽屉开合而不同步这个类，` +
          '「下一张」就会在抽屉打开期间一直是块死区（点它没反应、也不报错）',
      );
    }
  }

  // 夹具自证：上面用到的选择器真的被规则提取器找到了（否则 6.3 的循环可能是空转）。
  assert.ok(
    ruleBodies(rendererCss, '.preview-nav').length > 0 &&
      ruleBodies(rendererCss, '.preview-info-panel.open').length > 0,
    '夹具自证：规则提取器没找到那几个选择器，「阳性对照」等于没跑',
  );
}

// ── 5.7 🔴 标签回包必须校验 photoId（在途时用户可能已翻了三张） ──
//      直接写 `state.previewTags` 会把 A 的标签画到 C 上 ——
//      而这在屏幕上看起来完全正常（标签本来就可能长得很像）。
//
// 🔴 这一段**必须真 await**：用「同步等待一个已 settle 的 Promise」那种写法是假 async
//    （微任务要在当前同步块跑完才轮到），断言会在回包落地之前就执行 ⇒ 恒绿。
//    所以整段放进 async 函数，PASS 由它的完成驱动。
/**
 * 🔴 `vm` 沙箱里 `[]` / `{}` 的原型是**那个 realm 的**，与本进程不同 ⇒
 * `assert.deepEqual`（strict 模式 = deepStrictEqual）会因**原型不相等**而失败，
 * 而两边打印出来都是 `[]` —— 看起来像产品代码返回错了，其实是夹具的跨 realm 问题。
 * 断言 vm 返回值之前一律过这个函数换成宿主 realm 的普通值。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

async function checkStaleTagResponse() {
  // 在途期间切图：回包必须丢弃
  const state = {
    previewPhotos: [{ id: 100 }, { id: 200 }],
    previewIndex: 0,
    previewTags: [],
    previewTagsPhotoId: 0,
  };
  let resolveFn = null;
  const pending = ORG.loadTagsForPreview({
    state,
    api: {
      photoGetTags: () =>
        new Promise((resolve) => {
          resolveFn = resolve;
        }),
    },
    dom: {},
  });
  state.previewIndex = 1; // 请求在途时翻到第二张
  // 第二张自己有（占位的）标签 —— 让「被第一张的回包覆盖」这件事真的可检测，
  // 而不是拿一个本来就空的 [] 去比 [] （那种断言恒真）。
  state.previewTags = [{ id: 7, name: '第二张自己的' }];
  state.previewTagsPhotoId = 200;
  resolveFn({ success: true, tags: [{ id: 1, name: '来自第一张' }] });
  await pending;
  assert.deepEqual(
    plain(state.previewTags),
    [{ id: 7, name: '第二张自己的' }],
    '🔴 在途期间切了图 ⇒ 回包必须丢弃，不能把上一张的标签写到当前这张上',
  );
  assert.equal(state.previewTagsPhotoId, 200, '也不能把 `previewTagsPhotoId` 改成第一张的 id');

  // 正常路径：没有切图时回包要落地
  const state2 = { previewPhotos: [{ id: 300 }], previewIndex: 0, previewTags: [] };
  await ORG.loadTagsForPreview({
    state: state2,
    api: { photoGetTags: () => Promise.resolve({ success: true, tags: [{ id: 2, name: 'x' }] }) },
    dom: {},
  });
  assert.deepEqual(plain(state2.previewTags), [{ id: 2, name: 'x' }]);
  assert.equal(state2.previewTagsPhotoId, 300);

  // 失败降级成空集合（面板是只读展示，读不到不许抛）
  const state3 = { previewPhotos: [{ id: 400 }], previewIndex: 0, previewTags: [{ id: 9 }] };
  await ORG.loadTagsForPreview({
    state: state3,
    api: { photoGetTags: () => Promise.reject(new Error('boom')) },
    dom: {},
  });
  assert.deepEqual(plain(state3.previewTags), [], '读不到标签时降级成空数组，绝不抛（不许把预览打挂）');

  // `success: false` 的回包同样降级
  const state4 = { previewPhotos: [{ id: 500 }], previewIndex: 0, previewTags: [{ id: 9 }] };
  await ORG.loadTagsForPreview({
    state: state4,
    api: { photoGetTags: () => Promise.resolve({ success: false }) },
    dom: {},
  });
  assert.deepEqual(plain(state4.previewTags), []);

  // 没有 api 薄壳（老 preload）时静默返回，不抛
  await ORG.loadTagsForPreview({ state: state4, api: {}, dom: {} });
}

checkStaleTagResponse()
  .then(() => {
    console.log(
      '[org-metadata-regression] PASS（取值域 / 归一 / 六处查询同源 / 三条通道 / 渲染端镜像）',
    );
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });

