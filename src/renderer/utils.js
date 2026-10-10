(function (global) {
  var CARD_SIZE_TIERS = [
    { label: 'S', basis: 100 },
    { label: 'M', basis: 140 },
    { label: 'L', basis: 180 },
    { label: 'XL', basis: 320 },
  ];

  /**
   * 每页张数档位。这是渲染端唯一一份：底栏「每页数量」控件、设置页下拉的校验都从它取。
   * 主进程另有两份等价字面量（`src/main.js` 与 `src/main/settings.js` 的 ensureSettingsShape，
   * 均为 `[10, 20, 50, 80, 100, 200]`），它们无法 require 本文件，改这里时记得同步。
   */
  var BROWSE_PAGE_SIZE_TIERS = [10, 20, 50, 80, 100, 200];
  /** 与主进程 createDefaultSettings().browsePageSize 一致 */
  var DEFAULT_BROWSE_PAGE_SIZE = 100;

  /**
   * 「网格与比例」的取值域。它是渲染端唯一一份：设置页下拉（`#settingBrowseGridStyle`）
   * 与底栏控件（`#browseGridStyleSelect`）的 `<option>` 都从这里取/被它校验，
   * `settings.js` 的解析、`app.js` 的 `state.cardRatio` 归一也都走下面两个函数。
   *
   * `masonry` = 原比例瀑布流（每张用图片自己的宽高比）；`uniform|<ratio>` = 统一高度。
   * 主进程另有两份等价字面量（`src/main.js` 与 `src/main/settings.js` 的 ensureSettingsShape
   * 各自校验 `1 / 1 | 3 / 4 | 4 / 3 | 9 / 16 | 16 / 9`），它们无法 require 本文件，改这里时记得同步。
   */
  var BROWSE_CARD_RATIOS = ['1 / 1', '3 / 4', '4 / 3', '9 / 16', '16 / 9'];

  function normalizeBrowseCardRatio(v) {
    var s = String(v || '').trim();
    return BROWSE_CARD_RATIOS.indexOf(s) >= 0 ? s : '1 / 1';
  }

  function normalizeBrowseCardLayout(v) {
    var s = String(v || '')
      .trim()
      .toLowerCase();
    return s === 'uniform' ? 'uniform' : 'masonry';
  }

  /** 把 `state` 的 (layout, ratio) 编成两处下拉共用的 value。 */
  function encodeBrowseGridStyleValue(layoutMode, cardRatio) {
    var cl = normalizeBrowseCardLayout(layoutMode);
    if (cl === 'masonry') return 'masonry';
    return 'uniform|' + normalizeBrowseCardRatio(cardRatio);
  }

  /** `encodeBrowseGridStyleValue` 的逆运算；认不出的 value 一律退回瀑布流。 */
  function parseBrowseGridStyleValue(raw) {
    var s = String(raw || '').trim();
    var bar = s.indexOf('|');
    if (bar > 0 && s.slice(0, bar) === 'uniform') {
      return { layout: 'uniform', ratio: normalizeBrowseCardRatio(s.slice(bar + 1)) };
    }
    return { layout: 'masonry', ratio: null };
  }

  function snapBrowseCardBasis(n) {
    var x = parseInt(n, 10);
    if (isNaN(x)) x = 180;
    x = Math.max(80, Math.min(400, x));
    var best = CARD_SIZE_TIERS[2].basis;
    var bestD = Infinity;
    for (var i = 0; i < CARD_SIZE_TIERS.length; i++) {
      var d = Math.abs(x - CARD_SIZE_TIERS[i].basis);
      if (d < bestD) {
        bestD = d;
        best = CARD_SIZE_TIERS[i].basis;
      }
    }
    return best;
  }

  /**
   * 把任意输入收进档位表。**取最近档位而不是直接判非法**：底栏控件是「上一档 / 下一档」，
   * 若允许表外值流进来，档位下标就会算不出来（`indexOf` = -1），± 键直接失效。
   * 非数字（含 null / 空串）回落到默认 100。
   */
  function snapBrowsePageSize(n) {
    var x = parseInt(n, 10);
    if (!isFinite(x)) return DEFAULT_BROWSE_PAGE_SIZE;
    var best = BROWSE_PAGE_SIZE_TIERS[0];
    var bestD = Infinity;
    for (var i = 0; i < BROWSE_PAGE_SIZE_TIERS.length; i++) {
      var d = Math.abs(x - BROWSE_PAGE_SIZE_TIERS[i]);
      if (d < bestD) {
        bestD = d;
        best = BROWSE_PAGE_SIZE_TIERS[i];
      }
    }
    return best;
  }

  function browsePageSizeTierIndex(size) {
    var b = snapBrowsePageSize(size);
    for (var i = 0; i < BROWSE_PAGE_SIZE_TIERS.length; i++) {
      if (BROWSE_PAGE_SIZE_TIERS[i] === b) return i;
    }
    return BROWSE_PAGE_SIZE_TIERS.indexOf(DEFAULT_BROWSE_PAGE_SIZE);
  }

  function browseCardTierIndexForBasis(basis) {
    var b = snapBrowseCardBasis(basis);
    for (var j = 0; j < CARD_SIZE_TIERS.length; j++) {
      if (CARD_SIZE_TIERS[j].basis === b) return j;
    }
    return 2;
  }

  function normalizePositiveIntFilter(v) {
    var n = parseInt(v, 10);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  }

  function normalizePositiveFloatFilter(v) {
    var n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 10) / 10;
  }

  /**
   * 这条记录是不是「Live Photo 的静止图」（即它有可播放的伴生视频）。
   *
   * 🔴 这是渲染端**唯一一份**判据，网格角标（`ui-grid.js`）与预览播放按钮
   *    （`ui-preview.js`）都必须转发到这里 —— 两边的显隐由同一个事实决定，
   *    各写一份 `Number(x.live_motion_id) > 0` 就会出现「有角标但按不出播放」。
   *
   * 只看 `live_motion_id`（配对任务写进库的事实）。**不许**退回成
   * 「同目录有没有同名 .mov」：真库实测那条判据在 `.mov` 上头 500 个就命中 61 个，
   * 其中带 Apple identifier 的是 0（写真集的「封面图 + 正片」形态）。
   */
  function isLivePhotoStill(photo) {
    return !!(photo && Number(photo.live_motion_id) > 0);
  }

  /**
   * 原图 / 预览大图的缓存键（`photo://<id>?v=…`、`/photo/<id>?v=…`）。
   *
   * 键的材料是**原图**的 `file_size` + `date_modified` —— 原图变了，这两个必然变。
   * 只留数字：`date_modified` 是 ISO 串，冒号/横线/字母在 URL 里是噪音。
   */
  function photoCacheVersion(photo) {
    if (!photo) return '';
    var v = (photo.file_size || '') + '|' + (photo.date_modified || '');
    return v.replace(/[^0-9]/g, '');
  }

  /**
   * 缩略图 URL 的缓存键（`thumb://<id>?v=…`、`/thumb/<id>?v=…`）。
   *
   * 🔴 为什么**不能**沿用 `photoCacheVersion`：那两个字段描述的是**原图**，而缩略图重跑
   *    （换档 / 转 WebP）只改 `thumb_size` / `thumb_format`，**原图一个字节都没动** ——
   *    于是 URL 一模一样、缓存全部命中，重跑跑完了界面还在显示旧档位的图。
   *    网页端 `/thumb/:id` 是 `Cache-Control: public, max-age=86400`；桌面端 `thumb://`
   *    进的是 Chromium 内存缓存。两条路都要靠 URL 变化才能失效。
   *
   * 所以键里必须带**这一行自己的规格**（`thumb_size` / `thumb_format`）。列表查询把它们
   * 一起带出来（唯一真相源 `src/main/photo-list-columns.js`）。混规格库里这正是要的行为：
   * 被重建过的行换一个新 URL，还没轮到的行继续命中旧缓存 —— 「支持不同大小格式的缩略图」
   * 就是这么落到浏览层的。
   *
   * ⚠️ 残留（**有意**，写在这里免得下次当 bug 查）：单独调「画质」（档位与格式都不变）
   *    再重跑时，这两列不变 ⇒ 键不变 ⇒ 客户端可能继续显示旧画质，直到缓存自然过期
   *    （网页端 ≤24h、桌面端到下次重载）。把「当前设置里的画质」也并进键能修掉它，
   *    代价是给浏览层加一条设置依赖（首帧还没拿到设置时 URL 会先无后有一套，白拉一遍），
   *    判定为不划算。详见 `docs/contracts/thumbnail-backfill.md`。
   */
  function thumbCacheVersion(photo) {
    if (!photo) return '';
    var size = parseInt(photo.thumb_size, 10);
    if (!isFinite(size) || size < 0) size = 0;
    // 只留字母并转小写：`thumb_format` 归一化后是 'jpeg' / 'webp' / ''（未知）。
    // 未知**也要进键**（落成 0 与空串）：存量行全是未知，它们与「已转 WebP」必须是两个键。
    var format = String(photo.thumb_format || '')
      .replace(/[^a-z]/gi, '')
      .toLowerCase();
    return photoCacheVersion(photo) + '-' + size + format;
  }

  function formatNumber(n) {
    var num = Number(n || 0);
    return num.toLocaleString('zh-CN');
  }

  function formatSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    if (!isFinite(i) || i < 0) i = 0;
    if (i >= units.length) i = units.length - 1;
    var v = n / Math.pow(1024, i);
    var digits = i === 0 || v >= 100 ? 0 : 1;
    return v.toFixed(digits) + ' ' + units[i];
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '';
    return dateStr.replace('T', ' ').substring(0, 16);
  }

  /**
   * 日期标签：`2026-10-08` → 中文 `10月8日` / 英文 `Oct 8`。
   *
   * 🔴 **本地化走 `I18n`，但真相源仍在本文件**（`app.js` 只是 `RendererUtils.X || 兜底`）：
   *    所以这里**先问 `global.I18n`**，取不到再走下面那份中文实现。取不到的真实场景有两类：
   *      · `vm` 夹具（`loadRendererUtils()` 只给 `sandbox.window = sandbox`，没有 `I18n`）；
   *      · 万一 `i18n.js` 没加载（`index.html` 里它排在 `utils.js` **之前**，正常不会发生）。
   *    ⚠️ **每次调用时查**（不在 IIFE 顶层捕获）：`i18n.js` 的加载顺序一变，
   *       顶层捕获就会**静默锁死**在中文实现上 —— 而症状只是「英文界面显示中文」。
   *    ⚠️ 这里不要 `import`/依赖 `I18n`：它必须能在没有 i18n 的环境里独立跑（那正是兜底的意义）。
   */
  function formatDateLabel(dateStr) {
    if (!dateStr) return '';
    var api = global.I18n;
    if (api && typeof api.formatDate === 'function') return api.formatDate(dateStr);
    // 兜底：中文口径，且与 `I18n` 那条路**逐字节对齐**（守护把两条路的输出串钉在一起）。
    //   · 单位数月**不补零**：旧实现是 `parts[1]` 直接拼接 ⇒ 给出 `01月5日`，而 `Intl` 的
    //     中文月名是 `1月`。两条路给出不同串 = 一个**只在「`i18n.js` 没加载」时**才现形的差
    //     （生产路径永远走 `I18n`）⇒ 这里用 `parseInt` 显式对齐，别让它成为埋伏。
    //   · 形状不对的串**原样返回**（旧实现会拼出 `undefined月NaN日`）。
    //   ⚠️ 刻意**只对齐这两点**：`I18n#formatDate` 还多一道**回读校验**（`2026-02-30` 那种
    //      不存在的日期要原样返回），兜底不重复实现它 —— 兜底只为「`i18n.js` 整体没加载」
    //      这一种场景存在，为它再抄一份日期校验不划算。**别以为两者是全等镜像。**
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr));
    if (!m) return String(dateStr);
    return parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日';
  }

  /**
   * 星期：`2026-10-08` → 中文 `周四` / 英文 `Thu`。同上：先问 `I18n`，再走中文实现。
   *
   * 🔴 **兜底也必须走 UTC**：`new Date('2026-10-08')` 是**UTC 午夜**，在负时区会被算成前一天
   *    （实测 `TZ=America/New_York` 时 `周四` 变 `周三`）。旧实现就是这个形状 ——
   *    也就是说「日期显示成周四、星期显示成周三」这对矛盾只在负时区出现，中文用户永远看不到。
   *    ⇒ 用 `Date.UTC(y, m-1, d)` 造「那一天」，再取 `getUTCDay()`。
   *    解不出的输入返回**空串**（旧实现返回 `undefined`，界面上会显示成字样 "undefined"）。
   */
  function getWeekday(dateStr) {
    var api = global.I18n;
    if (api && typeof api.formatWeekday === 'function') return api.formatWeekday(dateStr);
    var days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr == null ? '' : dateStr));
    if (!m) return '';
    return days[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/\\/g, '/').replace(/'/g, "\\'");
  }

  function truncate(str, len) {
    if (!str || str.length <= len) return str;
    return str.substring(0, len - 3) + '...';
  }

  global.RendererUtils = Object.assign({}, global.RendererUtils || {}, {
    CARD_SIZE_TIERS: CARD_SIZE_TIERS,
    BROWSE_PAGE_SIZE_TIERS: BROWSE_PAGE_SIZE_TIERS,
    DEFAULT_BROWSE_PAGE_SIZE: DEFAULT_BROWSE_PAGE_SIZE,
    BROWSE_CARD_RATIOS: BROWSE_CARD_RATIOS,
    normalizeBrowseCardRatio: normalizeBrowseCardRatio,
    normalizeBrowseCardLayout: normalizeBrowseCardLayout,
    encodeBrowseGridStyleValue: encodeBrowseGridStyleValue,
    parseBrowseGridStyleValue: parseBrowseGridStyleValue,
    snapBrowseCardBasis: snapBrowseCardBasis,
    snapBrowsePageSize: snapBrowsePageSize,
    browsePageSizeTierIndex: browsePageSizeTierIndex,
    browseCardTierIndexForBasis: browseCardTierIndexForBasis,
    normalizePositiveIntFilter: normalizePositiveIntFilter,
    normalizePositiveFloatFilter: normalizePositiveFloatFilter,
    isLivePhotoStill: isLivePhotoStill,
    photoCacheVersion: photoCacheVersion,
    thumbCacheVersion: thumbCacheVersion,
    formatNumber: formatNumber,
    formatSize: formatSize,
    formatDateTime: formatDateTime,
    formatDateLabel: formatDateLabel,
    getWeekday: getWeekday,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    truncate: truncate,
  });
})(window);
