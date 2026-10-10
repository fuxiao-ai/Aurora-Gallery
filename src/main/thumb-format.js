'use strict';

/**
 * 缩略图编码格式的**唯一真相源**：允许哪些值、每个值对应哪个 MIME。
 *
 * 为什么要单独一个模块：`thumb_format` 这一列有三个互不相干的消费者 ——
 *   ① 写库端（扫描 / 补全 / 网页端按需生成）如实记录「这次用的是哪种编码」；
 *   ② 迁移端（`countThumbnailsNeedingRegen`、将来按格式增量重生成）拿它当判据；
 *   ③ **服务端**（桌面 `thumb://` 协议、网页端 `/thumb/:id`、安卓端走的是同一条）按它决定
 *      `Content-Type`。
 *
 * ③ 曾经不存在：`database.js#getThumbnail()` 只 `SELECT thumbnail, has_thumbnail`，
 * 把格式在**取数处**就丢了（字段传播链上少带一个字段），于是两个服务层只能把
 * `image/jpeg` **硬编码**在 6 个地方。那种写法的症状是**静默的** —— 字节是 WebP、
 * 头写着 JPEG，浏览器不报错、只是不解码，页面上什么都没有。
 * 现在改成：格式从库里带出来 → `thumbMimeType()` 派生响应头。
 *
 * ⚠️ 迁移判据是 `thumb_format <> 'webp'`。写进去一个 `'webP'` 会让那一行
 *    **永远被认为需要重生成**，所以写入端一律过 `normalizeThumbFormat()`：
 *    不在白名单里的一律落成 `''`（未知），而不是原样落库。
 *
 * 🔴 换编码格式 / 加档位时要改的地方（2026-10-07 收敛后已经很少）：
 *    · 换格式：只改下面的 `THUMB_ENCODE_FORMAT` —— 所有生成点都走 `resizeThumb()` / `encodeThumb()`，
 *      记录进库的 `thumb_format` 与响应头都取同一个值。
 *    · 加档位：改本文件的 `THUMB_SIZE_CHOICES`（主进程 clamp 与写入端归一化都从它取）
 *      ＋ `index.html#settingThumbSize` 的 `<option>` ＋ `ui-settings.js` 那份渲染端 clamp
 *      —— 后两处拿不到主进程模块，只能各留一份。
 *    守护：`scripts/thumbnail-spec-regression.js` 第 4 / 5 组。
 */

/**
 * 允许落库的编码格式。
 *
 * 🔴 `jpeg` 之外的项是**为存量兼容**留的：老库里的行全是 `jpeg`，重跑之前一直混着。
 *    「白名单收了」不等于「有人会写它」—— 生成端用哪个格式看 `THUMB_ENCODE_FORMAT`。
 */
var THUMB_FORMAT_WHITELIST = ['jpeg', 'webp'];

/** 格式 → 响应头 MIME。每加一个白名单项，这里必须同时有对应项。 */
var THUMB_FORMAT_MIME = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * 未知 / 空 / 非法格式的回落 MIME。
 *
 * `thumb_format` 的 `''` 语义是**未知**（本列引入之前的存量行都是这样；真库实测那批全是 JPEG），
 * 所以回落必须是 `image/jpeg` —— 回落到别的东西等于把存量行**全部标错**，而且同样是静默的。
 */
var THUMB_MIME_FALLBACK = 'image/jpeg';

/**
 * 档位白名单（长边像素）。**域的唯一真相源**：主进程落库 clamp 从这里取；
 * 渲染端那份（`ui-settings.js#normalizeThumbSizeQuality`）与 `index.html` 的 `<option>`
 * 拿不到主进程模块，只能各留一份 —— `thumbnail-spec-regression` 断言三处集合逐位一致。
 *
 * ⚠️ 512 是 2026-10-07 新加的默认档：4 倍像素换来约 1.85 倍体积（WebP 编码下）。
 *    1024 **刻意不提供**：实测全库会涨约 60 GiB，而 C 盘只剩二十几 GB。
 */
var THUMB_SIZE_CHOICES = [128, 192, 256, 320, 512];

/** 默认档位（长边像素）。设置默认值、各处 `|| ` 兜底都从它取。 */
var THUMB_DEFAULT_SIZE = 512;

/** 默认画质。⚠️ WebP 与 JPEG 的 quality **不是同一量纲**：同数值下 WebP 体积约 JPEG 的 64%。 */
var THUMB_DEFAULT_QUALITY = 75;

/**
 * 生成端实际使用的编码格式：`'webp'` | `'jpeg'`。
 *
 * 🔴 换格式时要**同时**改的只有本值与各生成点的编码调用 —— 而所有生成点都已经收敛到
 *    下面的 `resizeThumb()` / `encodeThumb()`，所以实际上只需要改本值一处：
 *      ① `src/main.js`（后台补全）、`src/scanner.js`（扫描）—— 走 `resizeThumb()`
 *      ② `src/web-server.js`（网页端按需 3 处）—— 走 `resizeThumb()`
 *      ③ `src/video-frame-thumb.js`（ffmpeg 抽帧 + 占位图）—— 走 `resizeThumb()` / `encodeThumb()`
 *    记录进库的 `thumb_format` 与响应头都取同一个值，不会再出现「字节是 A、头写着 B」。
 */
var THUMB_ENCODE_FORMAT = 'webp';

/** 归一化：不在白名单里的一律返回 `''`（未知），而不是原样落库。 */
function normalizeThumbFormat(value) {
  var format = value ? String(value).trim().toLowerCase() : '';
  return THUMB_FORMAT_WHITELIST.indexOf(format) >= 0 ? format : '';
}

/**
 * 取响应头 MIME。入参可以是任何脏值（`''` / `'webP'` / `null` / 非字符串）。
 *
 * 本函数**不抛**、也不返回空串：调用点全是 `res.writeHead` / `new Response` 里的字段值，
 * 返回空串等于把一个「没有 Content-Type 的响应」发给浏览器 —— 那比标错还难查。
 */
function thumbMimeType(value) {
  return THUMB_FORMAT_MIME[normalizeThumbFormat(value)] || THUMB_MIME_FALLBACK;
}

/** 档位归一化：非法值回落默认档（写入端与 clamp 共用一份）。 */
function normalizeThumbSize(value) {
  var px = parseInt(value, 10);
  return THUMB_SIZE_CHOICES.indexOf(px) >= 0 ? px : THUMB_DEFAULT_SIZE;
}

/**
 * 缩略图编码的**唯一出口**：给一条已经缩放好的 sharp pipeline 加上编码并出 Buffer。
 *
 * ⚠️ 不要在调用点写 `.jpeg()` / `.webp()`：那正是「记录进库的格式」与「实际字节」
 *    分家的起点（`thumbnail-spec-regression` 第 4 组守着响应头那一侧，
 *    这一侧由「所有生成点都走本函数」保证）。
 */
function encodeThumb(pipeline, quality) {
  var q = parseInt(quality, 10);
  if (!(q >= 30 && q <= 100)) q = THUMB_DEFAULT_QUALITY;
  if (THUMB_ENCODE_FORMAT === 'webp') return pipeline.webp({ quality: q }).toBuffer();
  if (THUMB_ENCODE_FORMAT === 'jpeg') return pipeline.jpeg({ quality: q }).toBuffer();
  throw new Error('未知的缩略图编码格式：' + THUMB_ENCODE_FORMAT);
}

/**
 * 图片缩略图的完整算子：`rotate → resize（长边 ≤ size、不放大）→ 编码`。
 *
 * 🔴 `rotate()` 收在这里、而不是交给调用方：dHash 必须取在旋转**之前**，
 *    两种算子共用同一个 sharp 实例时顺序极容易搞反（项目里已经吃过这条）。
 */
function resizeThumb(instance, size, quality) {
  var px = normalizeThumbSize(size);
  return encodeThumb(
    instance.rotate().resize(px, px, { fit: 'inside', withoutEnlargement: true }),
    quality,
  );
}

module.exports = {
  THUMB_FORMAT_WHITELIST,
  THUMB_FORMAT_MIME,
  THUMB_MIME_FALLBACK,
  THUMB_SIZE_CHOICES,
  THUMB_DEFAULT_SIZE,
  THUMB_DEFAULT_QUALITY,
  THUMB_ENCODE_FORMAT,
  normalizeThumbFormat,
  normalizeThumbSize,
  thumbMimeType,
  encodeThumb,
  resizeThumb,
};
