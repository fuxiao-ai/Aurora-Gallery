/**
 * 照片信息面板：可选字段的**唯一真相源**。
 *
 * 背景（2026-10-04）：预览页「照片信息」侧栏原先在桌面端 `renderer/app.js` 与网页端
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
 *     而不是等用户看到一行空数据。没有 DB 来源的字段不写 `column`，目前只有两个：
 *     `position`（只来自预览页运行时状态）、`ai_tags`（来自**搜图索引库**，跨库，
 *     由主进程 `SemanticTags` 那条独立只读通道注入 —— 不走 `getPhotoInfo()`，
 *     那个方法查的是主库连接，跨不了库）。守护对这两个是显式白名单。
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

  // ---------------------------------------------------------------- 字段表
  //
  // 27 个字段。其中 16 个是这一轮之前面板里就有的（文件名 / 路径 / 类型 / 尺寸 / 大小 /
  // 拍摄时间 / 修改时间 / 焦距 / 光圈 / ISO / 快门 / 相机品牌 / 相机型号 / 镜头 / GPS / 位置），
  // 新增 11 个：所在文件夹、所属图库、媒体类型、宽高比、总像素、收藏、照片 ID、
  // 文件哈希、感知哈希、缩略图、AI 标签。
  // 「默认关」的 5 个（`def: false`）都是路径很长或只有排障才看的原始值，
  // 不占用面板首屏 —— 想看的人在设置里勾一下即可。

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
      zh: '照片 ID',
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
      id: 'ai_tags',
      group: 'ai',
      zh: 'AI 标签',
      en: 'AI Tags',
      def: true,
      // 第三类来源：既不是 `photos` 的列，也不是预览页的运行时状态，而是**搜图索引库**
      // （`ai-search/semantic-index.sqlite` 的 `embeddings.tags`）。跨库、且那个库可能根本
      // 不存在（从没建过索引）或正被索引 worker 占写锁 —— 所以这条读数由主进程的
      // `SemanticTags` 只读通道单独注入，读不到就是空数组 → 整行隐藏。
      //
      // 值 = 当前语言的标签文本数组（库里存的是**词表下标**，见 `src/ai/photo-tags.js`）。
      render: 'tags',
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
   * 字段值的 HTML。默认是转义后的纯文本；`render: 'tags'` 的字段（目前只有 AI 标签）
   * 渲染成一组胶囊。
   *
   * `ctx.tagClickable` 决定胶囊是 `<button>`（桌面端：点了跳搜图，认领方读 `data-ai-tag`）
   * 还是 `<span>`（网页端没有搜图页 —— 渲染成不可点的胶囊，而不是摆一排点了没反应的按钮）。
   * 两种形态共用同一个类名，样式只有一处。
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
    var parts = [];
    for (var i = 0; i < labels.length; i++) {
      var text = escapeHtml(String(labels[i]));
      parts.push(
        ctx.tagClickable
          ? '<button type="button" class="preview-info-tag" data-ai-tag="' + text + '">' + text + '</button>'
          : '<span class="preview-info-tag preview-info-tag-static">' + text + '</span>',
      );
    }
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
   *   - tagClickable: true 时 AI 标签渲染成可点胶囊（桌面端点了跳搜图）
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
