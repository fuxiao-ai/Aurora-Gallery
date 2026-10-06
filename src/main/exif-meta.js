'use strict';

/**
 * 拍摄参数（EXIF）的**唯一解析入口** —— 不依赖 electron，回归脚本能真跑着比对。
 *
 * 🔴 为什么必须只有一份：这些值最终写进 `photos` 的那几十列，而**两条路**都会产出它们 ——
 *    扫描期（`scanner.js`，`GENERATE_THUMBNAILS_DURING_SCAN` 为真时）与缩略图补全顺带读
 *    （`main.js#processOne`）。两份实现一定会漂移，而漂移的方向是「字段时有时无」：
 *    不报错、也不写日志，只是某些照片能搜到相机型号、另一些不能。
 *
 * 🔴 字段用**声明式注册表**（`EXIF_FIELD_SPECS`）描述，下面这些全部由它派生，不许手抄：
 *      · `EXIF_FIELD_COLUMNS`（key → 列名）
 *      · `EXIF_METADATA_COLUMNS`（内容列清单，`database.js` 的「内容变更 ⇒ 连带置空」也用它）
 *      · `EXIF_COLUMN_TYPES`（列名 → SQLite 类型，迁移语句由它拼）
 *      · `emptyExifFields()`（全 null 空壳）
 *      · `updatePhotoExif()` 的 SET 子句与参数顺序（见 `database.js`）
 *    扩字段 = 改这张表 + 写一个归一化器，别处一行都不用动。
 *
 * 🔴 取值必须按 **IFD 归属**，不能只翻一个 IFD（这是本次修掉的旧 bug）：
 *    `exif-reader` 的返回是 `{ Image, Photo, Thumbnail, GPSInfo, Iop }`，各 IFD 装的东西不同：
 *      · `Image`（IFD0）  → `Make` / `Model` / `Orientation` / `Software` / `DateTime` / `Artist`
 *      · `Photo`（Exif 子 IFD）→ `FNumber` / `ApertureValue` / `ExposureTime` /
 *        `ISOSpeedRatings` / `FocalLength` / `LensModel` / `DateTimeOriginal` / `DateTimeDigitized`
 *      · `GPSInfo`        → `GPSLatitude` / `GPSLatitudeRef` / `GPSLongitude` / `GPSLongitudeRef`
 *    旧代码只做 `exif.Photo || exif.tags || exif` 再取 `tags.Make` ⇒ **品牌/型号/定位永远空**
 *    （`Make` 在 IFD0、GPS 在 `GPSInfo`，压根不在 `Photo` 里）。这里按 IFD 各取所需，
 *    并对少数把标签写错位置的文件保留「先 Photo 再 Image」的回落（见注册表的 tags 数组）。
 *
 * 🔴 值的类型必须**归一化后才落库**：
 *    · 日期：`exif-reader` 把 `DateTimeOriginal` 转成 `Date`（按 UTC 组装）；直接 `String()`
 *      会写进 `Wed Oct 06 2026 11:22:33 GMT+0800 (...)` 这种垃圾。这里统一成 `YYYY-MM-DD HH:MM:SS`。
 *    · GPS：是 `[度, 分, 秒]` 的**数组**（每个元素是 rational 相除后的数）。数组**不能**直接
 *      绑进 SQLite（better-sqlite3 会抛），旧代码正是因此被 `catch` 吞掉、整段 EXIF 一起丢。
 *      这里换算成带符号的十进制度。
 *    · ASCII：非 ASCII 字节会让 `exif-reader` 回吐 `Buffer` 而不是字符串，同样绑不进库。
 *    · `XP*` 是 **UTF-16LE** 编码的 Buffer（按 utf8 解会得到乱码），`ComponentsConfiguration` /
 *      `CFAPattern` 是无符号字节数组 —— 各有专门的归一化器，见 `NORMALIZERS`。
 */

var exifReader = require('exif-reader');

/**
 * 回填口径的**版本号**。每扩一次字段就 +1。
 *
 * 🔴 它是「已检查」标记的**第二半**。只写 `exif_mtime` 是个**二元**标记（看过就再也不看），
 *    所以扩字段时若不动它，**已经跑过的行会永久缺新列** —— 不报错、不写日志，只是那些照片
 *    在面板上永远少几行。候选谓词因此是
 *    `exif_mtime IS NULL OR IFNULL(exif_ver, 0) < EXIF_SCHEMA_VERSION`（见 `database.js#_sqlNeedsExifExpr`）。
 *
 * 版本历史：
 *   1 = 最初的 10 列（品牌/型号/镜头/焦距/光圈/ISO/快门/经纬度/EXIF 拍摄时间）
 *   2 = 2026-10-06 扩到 58 列（+48：拍摄参数细化 / 器材与文件元数据 / 技术标定值）
 */
var EXIF_SCHEMA_VERSION = 2;

/**
 * 字段注册表 —— **唯一真相源**。
 *
 * 每项：`{ key, column, type, tags, panel? }`
 *   · `key`     `extractExifFields()` 返回对象里的字段名（camelCase）
 *   · `column`  `photos` 表列名
 *   · `type`    归一化器名（见 `NORMALIZERS`）
 *   · `tags`    `[IFD名, 标签名]` 的**有序**候选，第一个非空胜出
 *   · `panel`   是否注册到信息面板（`photo-info-fields.js`）。
 *               ⚠️ 刻意只标 21 项：其余 27 项是「与已有列重复的派生值 / 纯技术标定值 / 弱价值文本」，
 *               入库是为了**不丢信息**，但显示出来只会变成「同一件事两个读数」（例如
 *               `ShutterSpeedValue` 是 `ExposureTime` 的 APEX 表示，同屏会出现 `1/50` 与 `5.6`）。
 */
var EXIF_FIELD_SPECS = [
  // ================= 原有 10 项（勿改 key / column：面板、回归、线上数据都按它们取值）=================
  { key: 'cameraMake', column: 'camera_make', type: 'text', panel: true, tags: [['Image', 'Make'], ['Photo', 'Make']] },
  { key: 'cameraModel', column: 'camera_model', type: 'text', panel: true, tags: [['Image', 'Model'], ['Photo', 'Model']] },
  { key: 'lensModel', column: 'lens_model', type: 'text', panel: true, tags: [['Photo', 'LensModel'], ['Image', 'LensModel']] },
  { key: 'focalLength', column: 'focal_length', type: 'number', panel: true, tags: [['Photo', 'FocalLength'], ['Image', 'FocalLength']] },
  { key: 'aperture', column: 'aperture', type: 'number', panel: true, tags: [['Photo', 'FNumber'], ['Photo', 'ApertureValue'], ['Image', 'FNumber']] },
  { key: 'isoSpeed', column: 'iso_speed', type: 'int', panel: true, tags: [['Photo', 'ISOSpeedRatings'], ['Image', 'ISOSpeedRatings']] },
  { key: 'shutterSpeed', column: 'shutter_speed', type: 'exposure', panel: true, tags: [['Photo', 'ExposureTime'], ['Image', 'ExposureTime']] },
  { key: 'gpsLatitude', column: 'gps_latitude', type: 'dmsLat', panel: true, tags: [['GPSInfo', 'GPSLatitude']] },
  { key: 'gpsLongitude', column: 'gps_longitude', type: 'dmsLon', panel: true, tags: [['GPSInfo', 'GPSLongitude']] },
  { key: 'dateTaken', column: 'exif_date_taken', type: 'date', panel: true, tags: [['Photo', 'DateTimeOriginal'], ['Image', 'DateTimeOriginal'], ['Photo', 'DateTimeDigitized'], ['Image', 'DateTimeDigitized']] },

  // ================= 新增 · 精选 21 项（入库 + 面板可选）=================
  { key: 'orientation', column: 'orientation', type: 'int', panel: true, tags: [['Image', 'Orientation'], ['Photo', 'Orientation']] },
  { key: 'exposureBias', column: 'exposure_bias', type: 'number', panel: true, tags: [['Photo', 'ExposureBiasValue'], ['Image', 'ExposureBiasValue']] },
  { key: 'exposureProgram', column: 'exposure_program', type: 'int', panel: true, tags: [['Photo', 'ExposureProgram']] },
  { key: 'exposureMode', column: 'exposure_mode', type: 'int', panel: true, tags: [['Photo', 'ExposureMode']] },
  { key: 'meteringMode', column: 'metering_mode', type: 'int', panel: true, tags: [['Photo', 'MeteringMode']] },
  { key: 'lightSource', column: 'light_source', type: 'int', panel: true, tags: [['Photo', 'LightSource']] },
  { key: 'flash', column: 'flash', type: 'int', panel: true, tags: [['Photo', 'Flash']] },
  { key: 'whiteBalance', column: 'white_balance', type: 'int', panel: true, tags: [['Photo', 'WhiteBalance']] },
  { key: 'sceneCaptureType', column: 'scene_capture_type', type: 'int', panel: true, tags: [['Photo', 'SceneCaptureType']] },
  { key: 'maxAperture', column: 'max_aperture', type: 'number', panel: true, tags: [['Photo', 'MaxApertureValue']] },
  { key: 'focalLength35mm', column: 'focal_length_35mm', type: 'int', panel: true, tags: [['Photo', 'FocalLengthIn35mmFilm']] },
  { key: 'lensSpec', column: 'lens_spec', type: 'lensSpec', panel: true, tags: [['Photo', 'LensSpecification']] },
  { key: 'bodySerial', column: 'body_serial', type: 'text', panel: true, tags: [['Photo', 'BodySerialNumber'], ['Image', 'BodySerialNumber']] },
  { key: 'lensSerial', column: 'lens_serial', type: 'text', panel: true, tags: [['Photo', 'LensSerialNumber']] },
  { key: 'gpsAltitude', column: 'gps_altitude', type: 'gpsAltitude', panel: true, tags: [['GPSInfo', 'GPSAltitude']] },
  { key: 'lensMake', column: 'lens_make', type: 'text', panel: true, tags: [['Photo', 'LensMake'], ['Image', 'LensMake']] },
  { key: 'software', column: 'software', type: 'text', panel: true, tags: [['Image', 'Software'], ['Photo', 'Software']] },
  { key: 'imageDatetime', column: 'image_datetime', type: 'date', panel: true, tags: [['Image', 'DateTime'], ['Photo', 'DateTime']] },
  { key: 'colorSpace', column: 'color_space', type: 'int', panel: true, tags: [['Photo', 'ColorSpace']] },
  { key: 'userComment', column: 'user_comment', type: 'userComment', panel: true, tags: [['Photo', 'UserComment'], ['Image', 'UserComment']] },
  { key: 'subSecTime', column: 'sub_sec_time', type: 'text', panel: true, tags: [['Photo', 'SubSecTimeOriginal'], ['Photo', 'SubSecTime'], ['Photo', 'SubSecTimeDigitized']] },

  // ================= 新增 · 仅入库 27 项（刻意不进面板）=================
  // ① 与已有列重复的派生值（采了是为了「不丢信息」，显示出来就是同一件事两个读数）
  { key: 'pixelXDimension', column: 'pixel_x_dimension', type: 'int', tags: [['Photo', 'PixelXDimension']] },
  { key: 'pixelYDimension', column: 'pixel_y_dimension', type: 'int', tags: [['Photo', 'PixelYDimension']] },
  { key: 'shutterSpeedValue', column: 'shutter_speed_value', type: 'number', tags: [['Photo', 'ShutterSpeedValue']] },
  { key: 'apertureValue', column: 'aperture_value', type: 'number', tags: [['Photo', 'ApertureValue']] },
  { key: 'brightnessValue', column: 'brightness_value', type: 'number', tags: [['Photo', 'BrightnessValue']] },
  { key: 'exposureIndex', column: 'exposure_index', type: 'number', tags: [['Photo', 'ExposureIndex']] },
  { key: 'recommendedExposureIndex', column: 'recommended_exposure_index', type: 'number', tags: [['Photo', 'RecommendedExposureIndex']] },
  { key: 'focalPlaneXResolution', column: 'focal_plane_x_resolution', type: 'number', tags: [['Photo', 'FocalPlaneXResolution']] },
  { key: 'focalPlaneYResolution', column: 'focal_plane_y_resolution', type: 'number', tags: [['Photo', 'FocalPlaneYResolution']] },
  { key: 'focalPlaneResolutionUnit', column: 'focal_plane_resolution_unit', type: 'int', tags: [['Photo', 'FocalPlaneResolutionUnit']] },
  { key: 'compressedBitsPerPixel', column: 'compressed_bits_per_pixel', type: 'number', tags: [['Photo', 'CompressedBitsPerPixel']] },

  // ② 纯技术标定值（没有任何面向人的含义，只在解析别人导出的元数据时有参照价值）
  { key: 'exifVersion', column: 'exif_version', type: 'text', tags: [['Photo', 'ExifVersion']] },
  { key: 'flashpixVersion', column: 'flashpix_version', type: 'text', tags: [['Photo', 'FlashpixVersion']] },
  { key: 'componentsConfiguration', column: 'components_configuration', type: 'hex', tags: [['Photo', 'ComponentsConfiguration']] },
  { key: 'cfaPattern', column: 'cfa_pattern', type: 'hex', tags: [['Photo', 'CFAPattern']] },
  { key: 'fileSource', column: 'file_source', type: 'int', tags: [['Photo', 'FileSource']] },
  { key: 'sensingMethod', column: 'sensing_method', type: 'int', tags: [['Photo', 'SensingMethod']] },
  { key: 'ycbcrPositioning', column: 'ycbcr_positioning', type: 'int', tags: [['Image', 'YCbCrPositioning']] },

  // ③ 弱价值文本与图像风格开关
  { key: 'gamma', column: 'gamma', type: 'number', tags: [['Photo', 'Gamma']] },
  { key: 'contrast', column: 'contrast', type: 'int', tags: [['Photo', 'Contrast']] },
  { key: 'saturation', column: 'saturation', type: 'int', tags: [['Photo', 'Saturation']] },
  { key: 'sharpness', column: 'sharpness', type: 'int', tags: [['Photo', 'Sharpness']] },
  { key: 'artist', column: 'artist', type: 'text', tags: [['Image', 'Artist'], ['Photo', 'Artist']] },
  { key: 'copyright', column: 'copyright', type: 'text', tags: [['Image', 'Copyright'], ['Photo', 'Copyright']] },
  { key: 'imageDescription', column: 'image_description', type: 'text', tags: [['Image', 'ImageDescription'], ['Photo', 'ImageDescription']] },
  { key: 'xpKeywords', column: 'xp_keywords', type: 'utf16', tags: [['Image', 'XPKeywords']] },
  { key: 'offsetTime', column: 'offset_time', type: 'text', tags: [['Photo', 'OffsetTimeOriginal'], ['Photo', 'OffsetTime'], ['Photo', 'OffsetTimeDigitized']] },
];

/** SQLite 列类型：由 `type` 推导（`database.js` 的迁移语句用它拼，不许手抄 48 个 ALTER） */
var SQL_TYPE_BY_FIELD_TYPE = {
  int: 'INTEGER',
  number: 'REAL',
  gpsAltitude: 'REAL',
  dmsLat: 'REAL',
  dmsLon: 'REAL',
  text: 'TEXT',
  utf16: 'TEXT',
  hex: 'TEXT',
  date: 'TEXT',
  exposure: 'TEXT',
  lensSpec: 'TEXT',
  userComment: 'TEXT',
};

/** 字段名（camelCase，`extractExifFields` 的返回形状）→ 列名 */
var EXIF_FIELD_COLUMNS = {};

/**
 * 一次回填要写的**内容列**（不含标记列 `exif_mtime` 与版本列 `exif_ver`）。
 * 🔴 单一来源：`database.js` 的「内容变更 ⇒ 连带置空」清单与 `updatePhotoExif` 的 SET 都从它派生。
 */
var EXIF_METADATA_COLUMNS = [];

/** 列名 → SQLite 类型 */
var EXIF_COLUMN_TYPES = {};

/** 走信息面板的字段 key（回归拿它钉「面板只注册这些」） */
var EXIF_PANEL_KEYS = [];

(function buildFromSpecs() {
  for (var i = 0; i < EXIF_FIELD_SPECS.length; i++) {
    var spec = EXIF_FIELD_SPECS[i];
    EXIF_FIELD_COLUMNS[spec.key] = spec.column;
    EXIF_METADATA_COLUMNS.push(spec.column);
    EXIF_COLUMN_TYPES[spec.column] = SQL_TYPE_BY_FIELD_TYPE[spec.type] || 'TEXT';
    if (spec.panel) EXIF_PANEL_KEYS.push(spec.key);
  }
})();

/** 字段名的有序清单（`hasAnyExifField` 用；顺序无关，只要稳定） */
var EXIF_FIELD_KEYS = Object.keys(EXIF_FIELD_COLUMNS);

/** 全 null 的字段对象：**没有 EXIF 是常态**（截图 / 网图 / PNG），调用方拿到它就是「该写标记了」 */
function emptyExifFields() {
  var out = {};
  for (var i = 0; i < EXIF_FIELD_SPECS.length; i++) out[EXIF_FIELD_SPECS[i].key] = null;
  return out;
}

/** ASCII 标签 → 干净字符串。非 ASCII 时 `exif-reader` 给 Buffer，照样能读出来。 */
function asText(value) {
  if (value === undefined || value === null) return null;
  var s;
  if (Buffer.isBuffer(value)) {
    s = value.toString('utf8').replace(/\0+$/, '');
  } else {
    s = String(value);
  }
  s = s.trim();
  return s.length ? s : null;
}

/**
 * 二进制值归一化成 Buffer：`exif-reader` **有时给 Buffer、有时给字节数组**
 * （同一份实现里两种都见过 —— 手工 TIFF 夹具实测 `XPKeywords` 回来的是 `[71,80,31,103]`）。
 * 🔴 这个区别是要命的：`String([71,80,31,103])` 得到 `"71,80,31,103"`，非空、能绑进 SQLite、
 *    不报错 —— 于是「假期」两个字被静默写成了一串数字。凡是吃二进制的归一化器都必须先过这里。
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) {
      var n = Number(value[i]);
      if (!isFinite(n) || n < 0 || n > 255) return null;
    }
    return Buffer.from(value);
  }
  return null;
}

/**
 * `XP*` 系列是 **UTF-16LE** 编码（Windows 相册关键词就是这么写的）。
 * 🔴 走 `asText` 会按 utf8 解出乱码 —— 而且乱码能绑进 SQLite、也不会报错，**静默入库**。
 */
function asUtf16Text(value) {
  if (value === undefined || value === null) return null;
  var buf = toBuffer(value);
  if (!buf) return asText(value);
  var s = buf.toString('utf16le');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM
  return asText(s);
}

/**
 * 无符号字节数组 → 十六进制串（`ComponentsConfiguration` / `CFAPattern`）。
 * ⚠️ 这两个都是**数组**，直接绑进 SQLite 会抛（旧代码就是这样整段 EXIF 一起丢的）。
 */
function asHex(value) {
  if (value === undefined || value === null) return null;
  var arr = Buffer.isBuffer(value) ? Array.prototype.slice.call(value) : value;
  if (!Array.isArray(arr) || !arr.length) return null;
  var out = '';
  for (var i = 0; i < arr.length; i++) {
    var n = Number(arr[i]);
    if (!isFinite(n) || n < 0 || n > 255) return null; // 不是字节数组就别硬编
    out += (n < 16 ? '0' : '') + n.toString(16);
  }
  return out.toUpperCase();
}

/**
 * `UserComment`：EXIF 规定前 8 字节是编码标识（`ASCII\0\0\0` / `UNICODE\0` / 全 0）。
 * 直接把整段当文本会带出一串 NUL；UNICODE 段还得按 UTF-16 解。
 */
function asUserComment(value) {
  if (value === undefined || value === null) return null;
  var buf = toBuffer(value);
  if (!buf) return asText(value);
  var head = buf.slice(0, 8).toString('latin1');
  var isUnicode = /^UNICODE/i.test(head);
  var hasHead = /^(ASCII|UNICODE|JIS|undefined)/i.test(head) || /^\0{8}$/.test(head);
  var body = hasHead ? buf.slice(8) : buf;
  var text = isUnicode ? body.toString('utf16le') : body.toString('utf8');
  return asText(text);
}

/** 数值归一化：多值取第一个；非数字/NaN 一律 null（宁可空着，也不写垃圾） */
function asNumber(value) {
  var v = Array.isArray(value) ? value[0] : value;
  var n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

/** 整数值：EXIF 的枚举类标签（Orientation / MeteringMode / …）都是整数 */
function asInt(value) {
  var n = asNumber(value);
  return n === null ? null : Math.round(n);
}

/** 人数值 → 短字符串（24 → `24`；2.8 → `2.8`；不留 `24.000000001` 这种尾巴） */
function formatNumberShort(n) {
  var r = Math.round(n * 100) / 100;
  return String(r);
}

/**
 * `LensSpecification` → 人话：`[24,70,2.8,2.8]` → `24-70mm f/2.8`。
 * 🔴 它是**四个 rational 的数组**，直接落库会抛；不格式化就只能存成一串数字，等于没采。
 */
function formatLensSpec(value) {
  var arr = Array.isArray(value) ? value : null;
  if (!arr || arr.length < 4) return null;
  var minF = asNumber(arr[0]);
  var maxF = asNumber(arr[1]);
  var minA = asNumber(arr[2]);
  var maxA = asNumber(arr[3]);
  if (minF === null || minF <= 0) return null;
  var out;
  if (maxF !== null && maxF > 0 && Math.abs(maxF - minF) > 0.01) {
    out = formatNumberShort(minF) + '-' + formatNumberShort(maxF) + 'mm';
  } else {
    out = formatNumberShort(minF) + 'mm';
  }
  var a = maxA !== null && maxA > 0 ? maxA : minA !== null && minA > 0 ? minA : null;
  if (a !== null) out += ' f/' + formatNumberShort(a);
  return out;
}

/** `[度, 分, 秒]` + 方位 → 带符号十进制度；拿不到就 null */
function toDecimalDegrees(dms, ref) {
  if (dms === undefined || dms === null) return null;
  var arr = Array.isArray(dms) ? dms : [dms];
  var deg = asNumber(arr[0]);
  if (deg === null) return null;
  var min = asNumber(arr[1]);
  var sec = asNumber(arr[2]);
  var v = Math.abs(deg) + (min === null ? 0 : min / 60) + (sec === null ? 0 : sec / 3600);
  if (!isFinite(v)) return null;
  var r = asText(ref);
  if (r && (r.toUpperCase() === 'S' || r.toUpperCase() === 'W')) v = -v;
  return v;
}

/**
 * 海拔：`GPSAltitudeRef` 为 1 表示**海平面以下** ⇒ 取负。
 * 拿不到 Ref 时按正值处理（绝大多数照片如此，宁可差个符号也不要丢掉整条读数）。
 */
function toSignedAltitude(alt, ref) {
  var v = asNumber(alt);
  if (v === null) return null;
  var r = asNumber(ref);
  if (r === null) {
    var rs = asText(ref);
    r = rs === null ? null : Number(rs);
  }
  if (r === 1) v = -v;
  return v;
}

/**
 * EXIF 时间 → `YYYY-MM-DD HH:MM:SS`。
 * `exif-reader` 已经把它拼成按 UTC 装的 `Date`（文件里的墙上时间原样搬过去），
 * 所以读回也必须用 UTC，否则会整体平移一个时区。
 *
 * 🔴 它落的是 **`exif_date_taken`**，与时间线用的 `date_taken` **是两列，绝不可合并**。
 *
 * 真实库（166 万行）实测过为什么不能合并：
 *  · `date_taken` 现在全库 == `date_modified`。扫描期唯一给它赋值的那行住在
 *    `GENERATE_THUMBNAILS_DURING_SCAN`（= false，刻意）分支里，所以下面那句
 *    「取不到就拿文件时间兜底」**每行都命中** ⇒ 它装的是**文件落盘时间**，不是拍摄时间。
 *  · 沿 id 轴均匀抽 220 张实读 EXIF：能拿到拍摄时间的 50 张里 **46 张与库内值差 1 天以上**、
 *    多数差**几年**（`魅影_20110303\IMG_8434.JPG` 库内 2020-07-18 vs EXIF 2011-03-03，差 3425 天）。
 *  · 而 `date_taken` 是**排序默认列**（`ORDER BY date_taken DESC`）+ 日期分组
 *    （`GROUP BY date(date_taken)`）+ 索引 `idx_photos_date` 的唯一输入。
 *  · 🔴 致命的一条：那 220 张里**只有 50 张（23%）**拿得到拍摄时间（49 张无 EXIF、
 *    121 张有 EXIF 但没有拍摄时间）。一旦覆盖 `date_taken`，时间线就变成
 *    「23% 真实拍摄时间 + 77% 原样」的**混合口径** —— 同一天拍的两张会分落相隔几千天的两处，
 *    **比「全库一致地不准」更难用**。
 *
 * 所以这里只把真实拍摄时间记进独立一列，由信息面板展示，**不参与排序**。
 * （也因此上一轮设想的「只在当前值 == `date_modified` 时替换」的安全口径不成立：
 *   全库都等于它，那个条件等于「全库替换」。）
 */
function formatExifDate(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }
  var s = String(value).trim();
  var m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];
  return null;
}

/** 曝光时间 → `1/250` 或 `2s`；与旧实现同口径 */
function formatExposure(value) {
  var exp = asNumber(value);
  if (exp === null || exp <= 0) return null;
  if (exp >= 1) return String(exp) + 's';
  return '1/' + Math.round(1 / exp);
}

/** 归一化器表：`spec.type` → 函数。加字段时只加这里的一行。 */
var NORMALIZERS = {
  int: asInt,
  number: asNumber,
  text: asText,
  date: formatExifDate,
  exposure: formatExposure,
  lensSpec: formatLensSpec,
  utf16: asUtf16Text,
  hex: asHex,
  userComment: asUserComment,
};

/**
 * 从 `sharp().metadata()` 的返回里解析出拍摄参数。
 *
 * 🔴 **绝不抛**：没有 EXIF / 解析失败 / 字节损坏，一律返回全 null 的字段对象。
 *    「这张照片本来就没有 EXIF」必须能和「解析炸了」区分开的是**调用方**（靠 `metadata()`
 *    本身有没有成功），而不是这里 —— 这里一律给一个可写的空壳，调用方才敢写「已检查」标记，
 *    否则候选集永远收敛不了。
 *
 * @param {{exif?: Buffer}|null} metadata sharp 的 metadata() 结果
 * @returns {ReturnType<typeof emptyExifFields>}
 */
function extractExifFields(metadata) {
  var out = emptyExifFields();
  if (!metadata || !metadata.exif) return out;

  var exif;
  try {
    exif = exifReader(metadata.exif);
  } catch (e) {
    return out;
  }
  if (!exif || typeof exif !== 'object') return out;

  var bags = {
    Image: exif.Image || {},
    Photo: exif.Photo || {},
    GPSInfo: exif.GPSInfo || {},
  };

  for (var i = 0; i < EXIF_FIELD_SPECS.length; i++) {
    var spec = EXIF_FIELD_SPECS[i];
    try {
      out[spec.key] = readField(spec, bags);
    } catch (e) {
      // 单个字段炸掉不该拖垮整张照片：这一项留 null，其余照常。
      // （旧实现是整段 try，一个坏字段会让后面所有字段一起丢 —— 症状是「有的照片只有品牌没有光圈」。）
      out[spec.key] = null;
    }
  }
  return out;
}

/** 按注册表的 tags 顺序取值 + 归一化 */
function readField(spec, bags) {
  var raw = null;
  for (var i = 0; i < spec.tags.length; i++) {
    var bag = bags[spec.tags[i][0]];
    var v = bag ? bag[spec.tags[i][1]] : undefined;
    if (v !== undefined && v !== null) {
      raw = v;
      break;
    }
  }
  if (raw === null) return null;

  // 两个带「配套标签」的字段：GPS 的方位/海拔基准住在另一个标签里
  if (spec.type === 'dmsLat' || spec.type === 'dmsLon') {
    var isLat = spec.type === 'dmsLat';
    var refTag = isLat ? 'GPSLatitudeRef' : 'GPSLongitudeRef';
    return toDecimalDegrees(raw, bags.GPSInfo ? bags.GPSInfo[refTag] : null);
  }
  if (spec.type === 'gpsAltitude') {
    return toSignedAltitude(raw, bags.GPSInfo ? bags.GPSInfo.GPSAltitudeRef : null);
  }
  var fn = NORMALIZERS[spec.type];
  return fn ? fn(raw) : asText(raw);
}

/** 这组字段里有没有**任何一个**真值（用来区分「补齐了」与「本来就没有」） */
function hasAnyExifField(fields) {
  if (!fields) return false;
  for (var i = 0; i < EXIF_FIELD_KEYS.length; i++) {
    var v = fields[EXIF_FIELD_KEYS[i]];
    if (v !== undefined && v !== null && v !== '') return true;
  }
  return false;
}

module.exports = {
  EXIF_SCHEMA_VERSION: EXIF_SCHEMA_VERSION,
  EXIF_FIELD_SPECS: EXIF_FIELD_SPECS,
  EXIF_FIELD_COLUMNS: EXIF_FIELD_COLUMNS,
  EXIF_METADATA_COLUMNS: EXIF_METADATA_COLUMNS,
  EXIF_COLUMN_TYPES: EXIF_COLUMN_TYPES,
  EXIF_PANEL_KEYS: EXIF_PANEL_KEYS,
  extractExifFields: extractExifFields,
  hasAnyExifField: hasAnyExifField,
  emptyExifFields: emptyExifFields,
  toDecimalDegrees: toDecimalDegrees,
  toSignedAltitude: toSignedAltitude,
  formatExifDate: formatExifDate,
  formatLensSpec: formatLensSpec,
  asUtf16Text: asUtf16Text,
  asHex: asHex,
  asUserComment: asUserComment,
};
