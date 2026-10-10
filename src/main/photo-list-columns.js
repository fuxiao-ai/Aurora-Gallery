'use strict';

/**
 * 图片**列表行**的列清单：唯一真相源。
 *
 * ## 为什么要有这个模块
 *
 * 「哪些列会被发给界面」这件事过去散在 15 行 SQL 字面量里（`database.js` 12 处、
 * `db-heavy-read.js` 2 处、`main.js` 1 处），每处各抄一份。加一列就得改 15 个地方，
 * 而漏掉任何一处的症状都是**静默的**：字段在 SQL 那一层就被丢掉，JS 侧读出
 * `undefined`，于是消费端只能回落成硬编码值 —— 不报错、不写日志、界面看起来正常。
 *
 * `thumb_size` / `thumb_format` 就是踩过这条路的字段（2026-10-07）：
 *   · 服务端要按行派生 `Content-Type`，于是 `database.js#getThumbnail()` 单独补了这两列
 *     （见 `thumb-format.js` 头部记的那 6 处硬编码 `image/jpeg`）；
 *   · 但**列表行**一直没带 —— 而浏览器缓存键（`?v=`）需要它：缩略图重跑之后
 *     行的规格变了、URL 却没变，客户端就一直拿旧字节，`/thumb/:id` 还是 `max-age=86400`。
 *     混规格库里这会表现成「重建跑完了，卡片还是老的」。
 *
 * 所以这两列进基线，并且**所有列表查询都从本模块取列名**。
 *
 * ## 两个可选子集
 *
 * · `lite`：不带 `file_path`。给「一次几十行、且这些行只在界面上画卡片」的列表用 ——
 *   `file_path` 又长又没人读，真库里把它拉进 100 行就是几十 KB 白流量。
 *   ⚠️ 只在**确认没有消费端**时用 `lite`：`getPhotos` / `getFolderPhotos` / `searchPhotos`
 *   的 `lite` 都是由调用方（网页端）显式给的，别在这里替它们决定。
 * · `liveMotion: false`：不带 `live_motion_id`。给「按 id 批量取行、不画 LIVE 角标」
 *   的维护类查询用（`maintenance-get-photos-by-ids` 那条）。
 *
 * ⚠️ 判据一律走 `photoListColumns()`，**不要再写字面量**：本文件由
 *    `scripts/photo-thumb-url-regression.js` 第 1 组守着（它会在 `src/` 下找
 *    `has_thumbnail, … is_favorite` 形状的字面量，找到一处就红）。
 */

/**
 * 基线列（顺序即过去 15 处里那条最长的顺序，保持稳定以免 diff 噪音）。
 *
 * `thumb_size` / `thumb_format` 刻意排在 `is_favorite` **之前**、紧跟 `has_thumbnail`：
 * 缩略图相关的四列（`has_thumbnail` / `thumb_size` / `thumb_format`，加 BLOB 本身不在这）
 * 必须挨着，读的人一眼能看出「这几列是一个整体」。
 */
var PHOTO_LIST_FIELDS = [
  'id',
  'file_name',
  'file_path',
  'folder_path',
  'file_size',
  'file_type',
  'width',
  'height',
  'date_taken',
  'date_modified',
  'has_thumbnail',
  'thumb_size',
  'thumb_format',
  'is_favorite',
  // 组织元数据两列（2026-10-09 加）。网格要画星级与标记角标、预览工具条要回填当前值，
  // 都从列表行读 ⇒ 必须进基线。
  // 🔴 漏了它们的症状是本文件开头描述的那种**静默失效**：字段在 SQL 那一层就被丢掉，
  //    客户端读到 undefined ⇒ 角标永远不亮、控件永远停在默认值，而界面看起来一切正常。
  //    这正是 thumb_size / thumb_format 2026-10-07 踩过的那条路。
  'rating',
  'flag',
  'live_motion_id',
];

/**
 * 缩略图规格两列 —— 单独导出，给「只想知道规格」的消费者用
 * （服务端派生 `Content-Type`、守护脚本、以及 `SPEC_MISMATCH_PRED` 那一族）。
 */
var THUMB_SPEC_FIELDS = ['thumb_size', 'thumb_format'];

/** 按需裁掉可选列。**只删不加** —— 新增列一律进基线，别做成开关。 */
function photoListColumns(opts) {
  var o = opts || {};
  var drop = [];
  if (o.lite) drop.push('file_path');
  if (o.liveMotion === false) drop.push('live_motion_id');
  if (!drop.length) return PHOTO_LIST_FIELDS.join(', ');
  return PHOTO_LIST_FIELDS.filter(function (c) {
    return drop.indexOf(c) < 0;
  }).join(', ');
}

/** 表格别名版本（`p.id, p.file_name, …`）：给带 JOIN 的列表查询用，避免手写前缀。 */
function photoListColumnsPrefixed(prefix, opts) {
  var p = prefix || 'p';
  return photoListColumns(opts)
    .split(', ')
    .map(function (c) {
      return p + '.' + c;
    })
    .join(', ');
}

/**
 * 只取缩略图规格两列的别名版本（`p.thumb_size, p.thumb_format`）。
 *
 * 给「封面行」那几条查询用：它们的主体是 `ROW_NUMBER() OVER (PARTITION BY folder_path)`
 * 之类的**窗口函数**，会把整棵子树的行物化一遍（真库单根 90 万行、实测数分钟）。
 * 往那个 CTE 里加两列 = 把物化宽度撑大 7%~8%，白等十几秒；而封面只有**每文件夹一行**，
 * 所以正确做法是**在最终 SELECT 上按主键回查一次**（几千次 PK 探针，微秒级）。
 * 结论：封面这条路**不许**用 `photoListColumns()`，只许用本函数 + JOIN。
 */
function thumbSpecColumnsPrefixed(prefix) {
  var p = prefix || 'p';
  return THUMB_SPEC_FIELDS.map(function (c) {
    return p + '.' + c;
  }).join(', ');
}

/**
 * 封面行的列清单。
 *
 * 封面卡片只画「一张图 + 一行目录名 + 张数」，所以它是**窄投影**：不带 `file_path`、
 * 不带日期、不带收藏。但 `thumb_size` / `thumb_format` **必须**在里面 ——
 * 封面 URL 与图片卡片 URL 用的是同一个缓存键公式，少了规格那两列封面就永远命中旧缓存。
 *
 * ⚠️ 与 `photoListColumns()` 分开是**有意的**，不是遗漏：这些查询的形状是
 *    `SELECT … WHERE folder_path = ? ORDER BY <封面序> LIMIT 1`（每个目录一次定点查询），
 *    宽窄无所谓；真正不能混的是三条**窗口函数**封面查询（它们会把整棵子树物化）——
 *    那三条用 `thumbSpecColumnsPrefixed()` 按主键回查，见该函数。
 */
var FOLDER_COVER_FIELDS = ['id', 'file_name', 'has_thumbnail', 'thumb_size', 'thumb_format'];

/** 窄投影的 SQL 片段。 */
function folderCoverColumns() {
  return FOLDER_COVER_FIELDS.join(', ');
}

/**
 * 封面行的**对外形状**（显式白名单）。
 *
 * 🔴 这是「字段传播链」的最后一环：SQL 里取了、这里没写，界面照样拿不到 ——
 *    而且不报错。新增封面字段时必须同时改 `FOLDER_COVER_FIELDS` 与本函数
 *    （`photo-thumb-url-regression` 第 2 组断言两者逐位一致）。
 */
function folderCoverRow(cover) {
  return {
    id: cover ? cover.id : null,
    file_name: cover && cover.file_name != null ? cover.file_name : '',
    has_thumbnail: cover ? !!cover.has_thumbnail : false,
    thumb_size: cover && cover.thumb_size != null ? cover.thumb_size : 0,
    // 未知一律落成空串（与 `thumb-format.js#normalizeThumbFormat` 同口径）：
    // 存量行就是空串，客户端据此拼出的键与「已转 WebP」的键必须不同。
    thumb_format: cover && cover.thumb_format != null ? String(cover.thumb_format) : '',
  };
}

module.exports = {
  PHOTO_LIST_FIELDS,
  THUMB_SPEC_FIELDS,
  FOLDER_COVER_FIELDS,
  photoListColumns,
  photoListColumnsPrefixed,
  thumbSpecColumnsPrefixed,
  folderCoverColumns,
  folderCoverRow,
};
