/**
 * 图片信息面板：可选字段的**唯一真相源**。
 *
 * 背景（2026-10-04）：预览页「图片信息」侧栏原先在桌面端 `renderer/app.js` 与网页端
 * `web/js/app.js` 各写一份，字段只有 8 个且完全硬编码 —— 想加一个字段要改两处，
 * 想让用户自己挑显示哪些字段更无从下手。
 *
 * 现在字段注册表只在本文件写一遍，三处复用：
 *   1. 桌面端 `renderer/index.html` → `../web/js/photo-info-fields.js`
 *   2. 网页端 `web/index.html`      → `/js/photo-info-fields.js`
 *   3. 主进程 `main.js`             → `require('./web/js/photo-info-fields.js')`
 * 第 3 条是关键：设置项白名单直接取 `FIELD_IDS`，于是「设置页能勾的字段」
 * 与「面板能画的字段」在结构上不可能对不上。
 *
 * 约定：
 *   - `FIELDS` 的顺序 = 面板里的出现顺序，也 = 设置页勾选框的顺序；分组由 `group` 决定，
 *     且**同组字段必须连续排**（设置页按「扫描一遍就出一个分组」渲染，跳着排会被拆成两块）。
 *   - `def: true` 表示默认显示；用户的勾选结果存在 `settings.infoPanelFields`。
 *   - `column` 声明这条读数的来源列（`photos` 行里的字段名，可给数组）。
 *     它不只是注释 —— `scripts/photo-info-fields-regression.js` 会拿它逐条比对
 *     `src/database.js` 的 `getPhotoInfo()` SQL，忘加列会在回归里被抓到，
 *     而不是等用户看到一行空数据。没有 DB 来源的字段不写 `column`，目前只有三个：
 *     `position`（只来自预览页运行时状态）、`ai_tags`（来自**搜图索引库**）与
 *     `joy_tags`（来自 **tag 索引库**）—— 后两者都跨库，由主进程各自的独立只读通道
 *     注入（`SemanticTags` / `JoyTagTags`），不走 `getPhotoInfo()`。
 *     守护对这三个是显式白名单。
 *   - `value(info, ctx)` 返回**已格式化好的字符串**；返回空串 / null 表示这一条不显示
 *     （不留空行、不留空分组）。所以「0 字节」「已收藏/未收藏」这类真实读数必须在
 *     `value()` 里显式转成字符串 —— 不能指望调用方拿假值判断。
 *   - 标签文案中英都在这里，两个运行时的界面对同一字段不会出现两种叫法。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PhotoInfoFields = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 分组顺序即面板里的分组顺序 */
  var GROUPS = [
    { id: 'basic', zh: '基本信息', en: 'Basic' },
    { id: 'time', zh: '时间', en: 'Time' },
    { id: 'exif', zh: '拍摄参数', en: 'Exposure' },
    { id: 'device', zh: '设备', en: 'Camera' },
    { id: 'location', zh: '位置', en: 'Location' },
    { id: 'ai', zh: 'AI 内容', en: 'AI Content' },
    { id: 'browse', zh: '浏览', en: 'Browsing' },
  ];

  // ---------------------------------------------------------------- 取值工具

  function language(locale, zh, en) {
    return locale === 'en' ? en : zh;
  }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  function formatDateTime(value) {
    if (!value) return '';
    return String(value).replace('T', ' ').substring(0, 19);
  }

  function gcd(a, b) {
    while (b) {
      var t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  /** 能约成小整数就写成 3 : 2，否则退回落差比 1.50 : 1（避免 1234 : 567 这种读不出来的写法） */
  function aspectRatio(width, height) {
    var w = Number(width);
    var h = Number(height);
    if (!(w > 0) || !(h > 0)) return '';
    var g = gcd(w, h) || 1;
    var rw = Math.round(w / g);
    var rh = Math.round(h / g);
    if (rw <= 64 && rh <= 64) return rw + ' : ' + rh;
    return (w / h).toFixed(2) + ' : 1';
  }

  function megapixels(width, height) {
    var w = Number(width);
    var h = Number(height);
    if (!(w > 0) || !(h > 0)) return '';
    var mp = (w * h) / 1000000;
    return (mp >= 1 ? mp.toFixed(1) : mp.toFixed(2)) + ' MP';
  }

  function dimensions(width, height) {
    var w = Number(width);
    var h = Number(height);
    if (!(w > 0) || !(h > 0)) return '';
    return w + ' × ' + h + ' px';
  }

  function hasGps(info) {
    return info.gps_latitude != null && info.gps_longitude != null;
  }

  // ------------------------------------------------ 拍摄参数（EXIF）取值工具
  //
  // 🔴 这些枚举列在库里存的是**原始数值**（`photos.orientation` = 1…8、`metering_mode` = 0…255），
  //    不是文本。存数值是刻意的：`src/main/exif-meta.js` 的采集侧不掺任何语言/展示逻辑，
  //    文案只在**这里**一份，桌面端与网页端因此不会出现两种叫法。

  /** 枚举原始值 → 本地化文案；未命中就退回原始数字（宁可显示怪值，也不要假装没有）。 */
  function enumText(table, raw, locale) {
    if (raw == null || raw === '') return '';
    var hit = table[Number(raw)];
    if (!hit) return String(raw);
    return language(locale, hit[0], hit[1]);
  }

  /** `orientation` 的 8 个取值（决定了「这张是不是竖着拍的」） */
  var ORIENTATIONS = {
    1: ['正常', 'Normal'],
    2: ['水平翻转', 'Mirrored'],
    3: ['旋转 180°', 'Rotated 180°'],
    4: ['垂直翻转', 'Flipped'],
    5: ['顺时针 90° + 翻转', 'Rotated 90° CW, mirrored'],
    6: ['逆时针 90°', 'Rotated 90° CCW'],
    7: ['顺时针 90° + 翻转', 'Rotated 90° CW, mirrored'],
    8: ['逆时针 90°', 'Rotated 90° CCW'],
  };
  var EXPOSURE_PROGRAMS = {
    0: ['未定义', 'Not defined'],
    1: ['手动', 'Manual'],
    2: ['程序自动', 'Program'],
    3: ['光圈优先', 'Aperture priority'],
    4: ['快门优先', 'Shutter priority'],
    5: ['创意', 'Creative'],
    6: ['动作', 'Action'],
    7: ['人像', 'Portrait'],
    8: ['风景', 'Landscape'],
  };
  var EXPOSURE_MODES = {
    0: ['自动曝光', 'Auto'],
    1: ['手动曝光', 'Manual'],
    2: ['自动包围', 'Auto bracket'],
  };
  var METERING_MODES = {
    0: ['未知', 'Unknown'],
    1: ['平均测光', 'Average'],
    2: ['中央重点测光', 'Center-weighted'],
    3: ['点测光', 'Spot'],
    4: ['多点测光', 'Multi-spot'],
    5: ['评价测光', 'Pattern'],
    6: ['局部测光', 'Partial'],
    255: ['其他', 'Other'],
  };
  var LIGHT_SOURCES = {
    0: ['未知', 'Unknown'],
    1: ['日光', 'Daylight'],
    2: ['荧光灯', 'Fluorescent'],
    3: ['钨丝灯', 'Tungsten'],
    4: ['闪光灯', 'Flash'],
    9: ['晴天', 'Fine weather'],
    10: ['阴天', 'Cloudy'],
    11: ['阴影', 'Shade'],
    17: ['标准光 A', 'Standard light A'],
    18: ['标准光 B', 'Standard light B'],
    19: ['标准光 C', 'Standard light C'],
    20: ['D55', 'D55'],
    21: ['D65', 'D65'],
    22: ['D75', 'D75'],
    23: ['D50', 'D50'],
    24: ['ISO 摄影灯', 'ISO studio tungsten'],
    255: ['其他', 'Other'],
  };
  var WHITE_BALANCES = { 0: ['自动', 'Auto'], 1: ['手动', 'Manual'] };
  var SCENE_CAPTURE_TYPES = {
    0: ['标准', 'Standard'],
    1: ['风景', 'Landscape'],
    2: ['人像', 'Portrait'],
    3: ['夜景', 'Night'],
  };
  var COLOR_SPACES = {
    1: ['sRGB', 'sRGB'],
    2: ['Adobe RGB', 'Adobe RGB'],
    65535: ['未校准', 'Uncalibrated'],
  };

  /**
   * `flash` 是**位掩码**不是枚举：bit0 = 闪过、bit5 = 机身上没有闪光灯、bit2 = 有回光但没回电。
   * 直接当枚举查表会得到「1」这种没法读的东西。
   */
  function flashText(raw, locale) {
    if (raw == null || raw === '') return '';
    var v = Number(raw);
    if (!isFinite(v)) return '';
    if (v & 0x20) return language(locale, '无闪光灯', 'No flash unit');
    if (v & 0x1) {
      if (v & 0x4) return language(locale, '闪光（未回电）', 'Fired (no return)');
      return language(locale, '已闪光', 'Fired');
    }
    return language(locale, '未闪光', 'Did not fire');
  }

  /** 曝光补偿：0 也要显示（`0 EV` 是真实读数，不是「没有」） */
  function evText(raw) {
    if (raw == null || raw === '') return '';
    var n = Number(raw);
    if (!isFinite(n)) return '';
    return (n > 0 ? '+' : '') + Math.round(n * 100) / 100 + ' EV';
  }

  /** GPS 海拔：数值已带符号（海平面以下为负），单位米 */
  function altitudeText(raw) {
    if (raw == null || raw === '') return '';
    var n = Number(raw);
    if (!isFinite(n)) return '';
    return Math.round(n * 10) / 10 + ' m';
  }

  /** 亚秒时间：`SubSecTime` 存的是秒的小数部分（`12` 表示 .12 秒） */
  function subSecText(raw) {
    if (raw == null || raw === '') return '';
    var s = String(raw).trim();
    if (!/^\d+$/.test(s)) return s;
    return '.' + s + ' s';
  }

  /** 带单位的数值：`35 mm` / `f/2.8`；0 与空值都隐藏 */
  function mmText(raw) {
    if (raw == null || raw === '') return '';
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return '';
    return Math.round(n * 100) / 100 + ' mm';
  }

  function fNumberText(raw) {
    if (raw == null || raw === '') return '';
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) return '';
    return 'f/' + Math.round(n * 100) / 100;
  }

  // ---------------------------------------------------------------- 字段表
  //
  // 49 个字段（2026-10-06 起）。上一版是 28 个，本轮扩了 21 个拍摄参数 / 器材 / 文件元数据：
  // 方向、曝光补偿、曝光程序、曝光模式、测光模式、光源、闪光灯、白平衡、场景类型、
  // 最大光圈、等效焦距（35mm）、亚秒时间、镜头规格、镜头厂商、机身序列号、镜头序列号、
  // 处理软件、色彩空间、文件写入时间（EXIF）、用户注释、海拔。
  //
  // 🔴 这 21 项**一律默认关**（`def: false`）：老用户的面板首屏本来就排了十几行，
  //    一次加 21 行会把它变成一张数据表 —— 想看的人在设置页勾一下即可。
  //
  // 🔴 库里其实有 **58** 个拍摄参数列（见 `src/main/exif-meta.js#EXIF_FIELD_SPECS`），
  //    剩下 27 列**刻意不注册到这里**：它们是「与已有列重复的派生值」（`ShutterSpeedValue`
  //    是 `ExposureTime` 的 APEX 表示，同屏会出现 `1/50` 与 `5.6` 两个读数）、
  //    「纯技术标定值」（`ExifVersion` / `CFAPattern` / `ComponentsConfiguration`）与弱价值文本。
  //    入库是为了**不丢信息**，显示出来只会制造「同一件事两个读数」的困惑。
  //    有守护钉住这条边界：仅入库的列不得出现在本注册表，也不得出现在 `getPhotoInfo()` 的 SQL 里。

  var FIELDS = [
    {
      id: 'file_name',
      column: 'file_name',
      group: 'basic',
      zh: '文件名',
      en: 'File name',
      def: true,
      value: function (i) {
        return i.file_name || '';
      },
    },
    {
      id: 'file_path',
      column: 'file_path',
      group: 'basic',
      zh: '路径',
      en: 'Path',
      def: true,
      value: function (i) {
        return i.file_path || '';
      },
    },
    {
      id: 'folder_path',
      column: 'folder_path',
      group: 'basic',
      zh: '所在文件夹',
      en: 'Folder',
      def: true,
      value: function (i) {
        return i.folder_path || '';
      },
    },
    {
      id: 'root_path',
      column: 'root_path',
      group: 'basic',
      zh: '所属图库',
      en: 'Library root',
      def: false,
      value: function (i) {
        return i.root_path || '';
      },
    },
    {
      id: 'file_type',
      column: 'file_type',
      group: 'basic',
      // 文案沿用这一轮之前面板里的「类型」，不做无谓改名
      zh: '类型',
      en: 'Type',
      def: true,
      value: function (i) {
        return i.file_type ? String(i.file_type).toUpperCase() : '';
      },
    },
    {
      id: 'media_kind',
      column: 'media_kind',
      group: 'basic',
      zh: '媒体类型',
      en: 'Media type',
      def: true,
      value: function (i, ctx) {
        if (i.media_kind === 'video') return language(ctx.locale, '视频', 'Video');
        if (i.media_kind === 'image') return language(ctx.locale, '图片', 'Photo');
        return '';
      },
    },
    {
      id: 'dimensions',
      column: ['width', 'height'],
      group: 'basic',
      zh: '尺寸',
      en: 'Dimensions',
      def: true,
      value: function (i) {
        return dimensions(i.width, i.height);
      },
    },
    {
      id: 'aspect_ratio',
      column: ['width', 'height'],
      group: 'basic',
      zh: '宽高比',
      en: 'Aspect ratio',
      def: true,
      value: function (i) {
        return aspectRatio(i.width, i.height);
      },
    },
    {
      id: 'megapixels',
      column: ['width', 'height'],
      group: 'basic',
      zh: '总像素',
      en: 'Megapixels',
      def: true,
      value: function (i) {
        return megapixels(i.width, i.height);
      },
    },
    {
      id: 'file_size',
      column: 'file_size',
      group: 'basic',
      zh: '大小',
      en: 'File size',
      def: true,
      value: function (i) {
        return formatBytes(i.file_size);
      },
    },
    {
      id: 'is_favorite',
      column: 'is_favorite',
      group: 'basic',
      zh: '收藏',
      en: 'Favorite',
      def: true,
      value: function (i, ctx) {
        if (i.is_favorite == null) return '';
        // 未收藏是**有效的读数**，不能当空值跳过 —— 否则这一行会时有时无
        return i.is_favorite
          ? language(ctx.locale, '已收藏', 'Yes')
          : language(ctx.locale, '未收藏', 'No');
      },
    },
    {
      id: 'photo_id',
      column: 'id',
      group: 'basic',
      zh: '图片 ID',
      en: 'Photo ID',
      def: false,
      value: function (i) {
        return i.id == null ? '' : String(i.id);
      },
    },
    {
      id: 'file_hash',
      column: 'file_hash',
      group: 'basic',
      zh: '文件哈希',
      en: 'File hash',
      def: false,
      value: function (i) {
        return i.file_hash || '';
      },
    },
    {
      id: 'dhash',
      column: 'dhash',
      group: 'basic',
      zh: '感知哈希',
      en: 'Perceptual hash',
      def: false,
      value: function (i) {
        return i.dhash || '';
      },
    },
    {
      id: 'thumb_status',
      column: 'has_thumbnail',
      group: 'basic',
      zh: '缩略图',
      en: 'Thumbnail',
      def: false,
      value: function (i, ctx) {
        if (i.has_thumbnail == null) return '';
        return i.has_thumbnail
          ? language(ctx.locale, '已生成', 'Ready')
          : language(ctx.locale, '未生成', 'Missing');
      },
    },
    {
      id: 'user_comment',
      column: 'user_comment',
      group: 'basic',
      zh: '用户注释',
      en: 'User comment',
      def: false,
      value: function (i) {
        return i.user_comment || '';
      },
    },
    {
      id: 'date_taken',
      column: 'date_taken',
      group: 'time',
      zh: '拍摄时间',
      en: 'Taken at',
      def: true,
      value: function (i) {
        return formatDateTime(i.date_taken);
      },
    },
    {
      // 🔴 与上面那条**是两回事，标签必须带括注**：`date_taken` 现在全库等于
      //    `date_modified`（文件落盘时间，扫描期的兜底分支每行都命中），
      //    而这一条才是 EXIF 里的真实拍摄时间 —— 本机实测两者多数差几年。
      //    没有括注就是「两个拍摄时间、一个还差 3000 多天」，用户只会当成 bug。
      id: 'exif_date_taken',
      column: 'exif_date_taken',
      group: 'time',
      zh: '拍摄时间（EXIF）',
      en: 'Taken at (EXIF)',
      // 默认**显示**：没有 EXIF 拍摄时间的图片（~77%）这一行会被「空值整行隐藏」吞掉，
      // 所以打开它不会给多数图片添噪音，只在真有拍摄时间时多给一条读数。
      def: true,
      value: function (i) {
        return formatDateTime(i.exif_date_taken);
      },
    },
    {
      id: 'date_modified',
      column: 'date_modified',
      group: 'time',
      zh: '修改时间',
      en: 'Modified at',
      def: true,
      value: function (i) {
        return formatDateTime(i.date_modified);
      },
    },
    {
      // IFD0 的 `DateTime`：相机或编辑软件写这张图时的墙上时间，
      // 与 `date_modified`（文件落盘时间）不是一回事 —— 但**只有半数图片有**。
      id: 'image_datetime',
      column: 'image_datetime',
      group: 'time',
      zh: '文件写入时间（EXIF）',
      en: 'Written at (EXIF)',
      def: false,
      value: function (i) {
        return formatDateTime(i.image_datetime);
      },
    },
    {
      id: 'focal_length',
      column: 'focal_length',
      group: 'exif',
      zh: '焦距',
      en: 'Focal length',
      def: true,
      value: function (i) {
        return i.focal_length ? i.focal_length + ' mm' : '';
      },
    },
    {
      id: 'aperture',
      column: 'aperture',
      group: 'exif',
      zh: '光圈',
      en: 'Aperture',
      def: true,
      value: function (i) {
        return i.aperture ? 'f/' + i.aperture : '';
      },
    },
    {
      id: 'iso_speed',
      column: 'iso_speed',
      group: 'exif',
      zh: 'ISO',
      en: 'ISO',
      def: true,
      value: function (i) {
        return i.iso_speed ? String(i.iso_speed) : '';
      },
    },
    {
      id: 'shutter_speed',
      column: 'shutter_speed',
      group: 'exif',
      zh: '快门速度',
      en: 'Shutter',
      def: true,
      value: function (i) {
        return i.shutter_speed || '';
      },
    },
    {
      id: 'orientation',
      column: 'orientation',
      group: 'exif',
      zh: '方向',
      en: 'Orientation',
      def: false,
      value: function (i, ctx) {
        return enumText(ORIENTATIONS, i.orientation, ctx && ctx.locale);
      },
    },
    {
      id: 'exposure_bias',
      column: 'exposure_bias',
      group: 'exif',
      zh: '曝光补偿',
      en: 'Exposure bias',
      def: false,
      value: function (i) {
        return evText(i.exposure_bias);
      },
    },
    {
      id: 'exposure_program',
      column: 'exposure_program',
      group: 'exif',
      zh: '曝光程序',
      en: 'Exposure program',
      def: false,
      value: function (i, ctx) {
        return enumText(EXPOSURE_PROGRAMS, i.exposure_program, ctx && ctx.locale);
      },
    },
    {
      id: 'exposure_mode',
      column: 'exposure_mode',
      group: 'exif',
      zh: '曝光模式',
      en: 'Exposure mode',
      def: false,
      value: function (i, ctx) {
        return enumText(EXPOSURE_MODES, i.exposure_mode, ctx && ctx.locale);
      },
    },
    {
      id: 'metering_mode',
      column: 'metering_mode',
      group: 'exif',
      zh: '测光模式',
      en: 'Metering mode',
      def: false,
      value: function (i, ctx) {
        return enumText(METERING_MODES, i.metering_mode, ctx && ctx.locale);
      },
    },
    {
      id: 'light_source',
      column: 'light_source',
      group: 'exif',
      zh: '光源',
      en: 'Light source',
      def: false,
      value: function (i, ctx) {
        return enumText(LIGHT_SOURCES, i.light_source, ctx && ctx.locale);
      },
    },
    {
      id: 'flash',
      column: 'flash',
      group: 'exif',
      zh: '闪光灯',
      en: 'Flash',
      def: false,
      value: function (i, ctx) {
        return flashText(i.flash, ctx && ctx.locale);
      },
    },
    {
      id: 'white_balance',
      column: 'white_balance',
      group: 'exif',
      zh: '白平衡',
      en: 'White balance',
      def: false,
      value: function (i, ctx) {
        return enumText(WHITE_BALANCES, i.white_balance, ctx && ctx.locale);
      },
    },
    {
      id: 'scene_capture_type',
      column: 'scene_capture_type',
      group: 'exif',
      zh: '场景类型',
      en: 'Scene type',
      def: false,
      value: function (i, ctx) {
        return enumText(SCENE_CAPTURE_TYPES, i.scene_capture_type, ctx && ctx.locale);
      },
    },
    {
      id: 'max_aperture',
      column: 'max_aperture',
      group: 'exif',
      zh: '最大光圈',
      en: 'Max aperture',
      def: false,
      value: function (i) {
        return fNumberText(i.max_aperture);
      },
    },
    {
      // 换算成 35mm 等效焦距 —— 不同画幅的「24mm」视野完全不同，这一条才是可比的。
      id: 'focal_length_35mm',
      column: 'focal_length_35mm',
      group: 'exif',
      zh: '等效焦距（35mm）',
      en: 'Focal length (35mm eq.)',
      def: false,
      value: function (i) {
        return mmText(i.focal_length_35mm);
      },
    },
    {
      id: 'sub_sec_time',
      column: 'sub_sec_time',
      group: 'exif',
      zh: '亚秒时间',
      en: 'Sub-second',
      def: false,
      value: function (i) {
        return subSecText(i.sub_sec_time);
      },
    },
    {
      id: 'camera_make',
      column: 'camera_make',
      group: 'device',
      zh: '相机品牌',
      en: 'Camera make',
      def: true,
      value: function (i) {
        return i.camera_make || '';
      },
    },
    {
      id: 'camera_model',
      column: 'camera_model',
      group: 'device',
      zh: '相机型号',
      en: 'Camera model',
      def: true,
      value: function (i) {
        return i.camera_model || '';
      },
    },
    {
      id: 'lens_model',
      column: 'lens_model',
      group: 'device',
      zh: '镜头',
      en: 'Lens',
      def: true,
      value: function (i) {
        return i.lens_model || '';
      },
    },
    {
      // 镜头规格（`LensSpecification` = 焦距范围 + 光圈范围）在人话里比 `lens_model` 更好认：
      // 采集侧已把它格式化成 `24-70mm f/2.8`；没有它的图片这一行会被隐藏。
      id: 'lens_spec',
      column: 'lens_spec',
      group: 'device',
      zh: '镜头规格',
      en: 'Lens spec',
      def: false,
      value: function (i) {
        return i.lens_spec || '';
      },
    },
    {
      id: 'lens_make',
      column: 'lens_make',
      group: 'device',
      zh: '镜头厂商',
      en: 'Lens make',
      def: false,
      value: function (i) {
        return i.lens_make || '';
      },
    },
    {
      // 多机身 / 多镜头的人靠这两条区分「这张是哪台机器拍的」——`camera_model` 同名时才有意义。
      id: 'body_serial',
      column: 'body_serial',
      group: 'device',
      zh: '机身序列号',
      en: 'Body serial',
      def: false,
      value: function (i) {
        return i.body_serial || '';
      },
    },
    {
      id: 'lens_serial',
      column: 'lens_serial',
      group: 'device',
      zh: '镜头序列号',
      en: 'Lens serial',
      def: false,
      value: function (i) {
        return i.lens_serial || '';
      },
    },
    {
      // 处理软件：能看出这张是不是被 Lightroom / 美图 / 微信导出过。
      id: 'software',
      column: 'software',
      group: 'device',
      zh: '处理软件',
      en: 'Software',
      def: false,
      value: function (i) {
        return i.software || '';
      },
    },
    {
      id: 'color_space',
      column: 'color_space',
      group: 'device',
      zh: '色彩空间',
      en: 'Color space',
      def: false,
      value: function (i, ctx) {
        return enumText(COLOR_SPACES, i.color_space, ctx && ctx.locale);
      },
    },
    {
      id: 'gps',
      column: ['gps_latitude', 'gps_longitude'],
      group: 'location',
      zh: 'GPS',
      en: 'GPS',
      def: true,
      value: function (i) {
        if (!hasGps(i)) return '';
        return Number(i.gps_latitude).toFixed(6) + ', ' + Number(i.gps_longitude).toFixed(6);
      },
    },
    {
      // 只有 0.5% 的图片带 GPS，而带上 GPS 的又大多带海拔 —— 单独一条比塞进 GPS 那行更好读。
      id: 'gps_altitude',
      column: 'gps_altitude',
      group: 'location',
      zh: '海拔',
      en: 'Altitude',
      def: false,
      value: function (i) {
        return altitudeText(i.gps_altitude);
      },
    },
    {
      id: 'ai_tags',
      group: 'ai',
      zh: '主题标签',
      en: 'Theme tags',
      def: true,
      // 第三类来源：既不是 `photos` 的列，也不是预览页的运行时状态，而是**搜图索引库**
      // （`ai-search/semantic-index.sqlite` 的 `embeddings.tags`）。跨库、且那个库可能根本
      // 不存在（从没建过索引）或正被索引 worker 占写锁 —— 所以这条读数由主进程的
      // `SemanticTags` 只读通道单独注入，读不到就是空数组 → 整行隐藏。
      //
      // 值 = 当前语言的标签文本数组（库里存的是**词表下标**，见 `src/ai/photo-tags.js`）。
      render: 'tags',
      // 点它去**搜图**：这些词来自 308 条词表短语（`src/ai/search-vocabulary.js`），
      // 标签导航页里**没有对应节点**（那是 JoyTag 的 5813 个标签），只能当查询词用。
      tagTarget: 'search',
      tags: function (i) {
        return Array.isArray(i.ai_tags) ? i.ai_tags.filter(Boolean) : [];
      },
      // 兜底纯文本：不支持胶囊渲染的调用方（或胶囊被关掉时）拿到的是「、」连起来的一行。
      value: function (i) {
        var tags = Array.isArray(i.ai_tags) ? i.ai_tags.filter(Boolean) : [];
        return tags.length ? tags.join('、') : '';
      },
    },
    {
      id: 'joy_tags',
      group: 'ai',
      zh: '画面标签',
      en: 'Visual tags',
      def: true,
      // 第三类来源的第二个成员：JoyTag 打标的结果，在 **tag 索引库**
      // （`ai-search/tag-index.sqlite` 的 `photo_tag` × `tag_vocab`）里 —— 与 ai_tags
      // 一样跨库、库可能不存在或被 worker 占写锁，由主进程 `JoyTagTags` 只读通道单独
      // 注入（`get-photo-joy-tags` / `/api/photo-joy-tags`），读不到就是空数组 → 整行隐藏。
      //
      // 值 = 当前语言的显示文本数组：主进程通道内做了中文映射（`ai/tag-zh.js`），
      // 查不到的标签回落英文原文；`locale: 'en'` 时直接返回英文原文。
      // 通道按分数降序最多给 24 个（`JOYTAG_PANEL_LIMIT`）—— 面板是摘要不是清单。
      //
      // 🔴 条目是**对象** `{tag, name, node, category}`（2026-10-09 起）：`tag` = 英文原名
      // （标签导航页的节点 id），`node`/`category` = 归属 —— 跳过去要靠它展开侧栏树并高亮，
      // 而渲染层没有 `ai/tag-categories` 可以自己反查。显示名是中文，原名一开始丢掉的话，
      // 跳转就只剩「拿中文名去猜节点」这一条死路。
      render: 'tags',
      // 点它去**标签导航页的那个标签** —— 与 `ai_tags` 的「只能搜图」刻意分岔。
      tagTarget: 'tagnav',
      tags: function (i) {
        return Array.isArray(i.joy_tags) ? i.joy_tags.filter(Boolean) : [];
      },
      // 兜底纯文本：不支持胶囊渲染的调用方（或胶囊被关掉时）拿到的是「、」连起来的一行。
      // ⚠️ 条目是对象 ⇒ 必须取显示名，直接 `join` 会得到一串 `[object Object]`。
      value: function (i) {
        return tagTextOf(i.joy_tags);
      },
    },
    {
      id: 'position',
      group: 'browse',
      zh: '位置',
      en: 'Position',
      def: true,
      // 只来自预览页的运行时状态（浏览序号 / 总张数），不在 photo 行里
      value: function (i, ctx) {
        return ctx.position || '';
      },
    },
  ];

  var FIELD_IDS = FIELDS.map(function (f) {
    return f.id;
  });

  var DEFAULT_FIELD_IDS = FIELDS.filter(function (f) {
    return f.def;
  }).map(function (f) {
    return f.id;
  });

  var BY_ID = {};
  for (var fi = 0; fi < FIELDS.length; fi++) {
    BY_ID[FIELDS[fi].id] = FIELDS[fi];
  }

  // ---------------------------------------------------------------- 规范化

  /**
   * 把任意输入（settings.json 里的旧值、勾选框读回的数组）收敛成合法字段 id 数组。
   * 口径：
   *   - 未知 id 直接丢掉（字段被移除后老配置不会留下幽灵勾选）；
   *   - 去重；
   *   - **不排序**，按注册表顺序返回 —— 面板顺序永远由注册表说了算，
   *     用户把设置文件改乱了也不会让面板顺序跟着乱；
   *   - 传入非数组（含 null / 字符串）一律回落到默认集。
   */
  function normalizeFieldIds(raw) {
    if (!Array.isArray(raw)) return DEFAULT_FIELD_IDS.slice();
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var id = raw[i];
      if (typeof id === 'string' && BY_ID[id]) seen[id] = true;
    }
    return FIELD_IDS.filter(function (id) {
      return seen[id];
    });
  }

  function isFieldId(id) {
    return typeof id === 'string' && !!BY_ID[id];
  }

  function labelFor(field, locale) {
    return language(locale, field.zh, field.en);
  }

  /** 设置页用：按分组切好，空分组丢掉 */
  function groupFields(rawIds, locale) {
    var ids = normalizeFieldIds(rawIds);
    var on = {};
    for (var i = 0; i < ids.length; i++) on[ids[i]] = true;
    var out = [];
    for (var g = 0; g < GROUPS.length; g++) {
      var group = GROUPS[g];
      var items = [];
      for (var f = 0; f < FIELDS.length; f++) {
        if (FIELDS[f].group !== group.id) continue;
        items.push({
          id: FIELDS[f].id,
          label: labelFor(FIELDS[f], locale),
          enabled: !!on[FIELDS[f].id],
        });
      }
      if (!items.length) continue;
      out.push({ id: group.id, title: language(locale, group.zh, group.en), fields: items });
    }
    return out;
  }

  // ---------------------------------------------------------------- 渲染

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 胶囊条目归一化 —— 两种形状都收：
   *
   *   · 字符串（`ai_tags` 主题标签：词来自 308 条词表短语）
   *   · 对象 `{tag, name, node, category}`（`joy_tags` 画面标签：带英文原名与归属）
   *
   * 「跳哪儿」由**字段声明**（`tagTarget`）决定，不靠形状猜；形状只决定「跳不跳得动」——
   * 只有拿到英文原名的条目才跳得动（拿中文显示名去当节点 id，跳过去只会是 0 张）。
   */
  function tagEntry(entry) {
    if (entry && typeof entry === 'object') {
      var tag = String(entry.tag == null ? '' : entry.tag);
      var name = String(entry.name == null ? '' : entry.name);
      return {
        text: name || tag,
        tag: tag,
        node: String(entry.node == null ? '' : entry.node),
        category: String(entry.category == null ? '' : entry.category),
      };
    }
    return { text: String(entry == null ? '' : entry), tag: '', node: '', category: '' };
  }

  /** 胶囊的显示文本（`value()` 的兜底用 —— 对象条目直接 `join` 会拼出 `[object Object]`）。 */
  function tagTextOf(list) {
    var tags = Array.isArray(list) ? list : [];
    var out = [];
    for (var i = 0; i < tags.length; i++) {
      var text = tagEntry(tags[i]).text;
      if (text) out.push(text);
    }
    return out.join('、');
  }

  /**
   * 字段值的 HTML。默认是转义后的纯文本；`render: 'tags'` 的字段渲染成一组胶囊。
   *
   * `ctx.tagClickable` 决定胶囊是 `<button>`（桌面端）还是 `<span>`（网页端既没有搜图页、
   * 也没有标签导航页 —— 渲染成不可点的胶囊，而不是摆一排点了没反应的按钮）。
   * 两种形态共用同一个类名，样式只有一处。
   *
   * 桌面端按**字段声明的 `tagTarget`** 分岔（2026-10-09 起）：
   *   · `'tagnav'` 且条目带英文原名 ⇒ `data-joy-tag`（＋`data-tag-node` / `data-tag-category`），
   *     认领方跳**标签导航页的那个标签**；
   *   · 其余 ⇒ `data-ai-tag`，认领方拿去**搜图**。
   * 之所以分岔而不是统一：`ai_tags` 的词在标签导航页里**没有节点**，`joy_tags` 有。
   */
  function valueHtml(field, info, ctx, value) {
    if (field.render !== 'tags') return escapeHtml(String(value));
    var labels;
    try {
      labels = (field.tags ? field.tags(info, ctx) : null) || [];
    } catch (err) {
      labels = [];
    }
    if (!labels.length) return escapeHtml(String(value));
    var toTagNav = field.tagTarget === 'tagnav';
    var parts = [];
    for (var i = 0; i < labels.length; i++) {
      var e = tagEntry(labels[i]);
      if (!e.text) continue;
      var text = escapeHtml(e.text);
      if (!ctx.tagClickable) {
        parts.push('<span class="preview-info-tag preview-info-tag-static">' + text + '</span>');
        continue;
      }
      if (toTagNav && e.tag) {
        parts.push(
          '<button type="button" class="preview-info-tag" data-joy-tag="' +
            escapeHtml(e.tag) +
            '" data-tag-node="' +
            escapeHtml(e.node) +
            '" data-tag-category="' +
            escapeHtml(e.category) +
            '">' +
            text +
            '</button>',
        );
        continue;
      }
      parts.push(
        '<button type="button" class="preview-info-tag" data-ai-tag="' + text + '">' + text + '</button>',
      );
    }
    // 条目全是空文本（`['']` 这种）：与「没有标签」同样处理，交给调用方的空态路径。
    if (!parts.length) return escapeHtml(String(value));
    return parts.join('');
  }

  /**
   * 生成信息面板内容 HTML。
   *
   * options:
   *   - fields: 启用的字段 id 数组（缺省 = 默认集，非法输入会被 normalizeFieldIds 收敛）
   *   - locale: 'zh-CN'（缺省）| 'en'
   *   - position: 预览页「浏览位置」的文案（如 `12 / 3400`），没有就不显示该行
   *   - sectionBody: true 时在标题与行之间包一层 `.preview-info-section-body`
   *     （网页端样式依赖这个容器；桌面端不包，保持既有 DOM 不变）
   *   - tagClickable: true 时 主题标签渲染成可点胶囊（桌面端点了跳搜图）
   *   - emptyHtml: 一条都没命中时的占位 HTML
   */
  function buildSectionsHtml(info, options) {
    info = info || {};
    options = options || {};
    var locale = options.locale === 'en' ? 'en' : 'zh-CN';
    var enabled = normalizeFieldIds(options.fields);
    var on = {};
    for (var e = 0; e < enabled.length; e++) on[enabled[e]] = true;
    var ctx = {
      locale: locale,
      position: options.position || '',
      tagClickable: options.tagClickable === true,
    };

    var html = [];
    for (var g = 0; g < GROUPS.length; g++) {
      var group = GROUPS[g];
      var rows = [];
      for (var f = 0; f < FIELDS.length; f++) {
        var field = FIELDS[f];
        if (field.group !== group.id || !on[field.id]) continue;
        var value;
        try {
          value = field.value(info, ctx);
        } catch (err) {
          // 单个字段取值出错不该整块面板空白
          value = '';
        }
        // 0 也当空：字段都返回字符串，出现数字 0 只可能是「无」的意思
        if (value == null || value === '' || value === 0) continue;
        rows.push(
          '<div class="preview-info-row"><span class="preview-info-label">' +
            escapeHtml(labelFor(field, locale)) +
            '</span><span class="' +
            (field.render === 'tags' ? 'preview-info-value preview-info-value-tags' : 'preview-info-value') +
            '">' +
            valueHtml(field, info, ctx, value) +
            '</span></div>',
        );
      }
      if (!rows.length) continue;
      html.push(
        '<div class="preview-info-section"><div class="preview-info-section-title">' +
          escapeHtml(language(locale, group.zh, group.en)) +
          '</div>' +
          (options.sectionBody === true
            ? '<div class="preview-info-section-body">' + rows.join('') + '</div>'
            : rows.join('')) +
          '</div>',
      );
    }
    if (html.length) return html.join('');
    return options.emptyHtml || '<div class="preview-info-empty">无可用信息</div>';
  }

  return {
    GROUPS: GROUPS,
    FIELDS: FIELDS,
    FIELD_IDS: FIELD_IDS,
    DEFAULT_FIELD_IDS: DEFAULT_FIELD_IDS,
    fieldById: function (id) {
      return BY_ID[id] || null;
    },
    normalizeFieldIds: normalizeFieldIds,
    isFieldId: isFieldId,
    labelFor: labelFor,
    groupFields: groupFields,
    buildSectionsHtml: buildSectionsHtml,
    formatBytes: formatBytes,
    aspectRatio: aspectRatio,
    megapixels: megapixels,
  };
});
