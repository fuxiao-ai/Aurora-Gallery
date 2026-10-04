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

  function formatDateLabel(dateStr) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    return parts[1] + '月' + parseInt(parts[2], 10) + '日';
  }

  function getWeekday(dateStr) {
    var days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    var d = new Date(dateStr);
    return days[d.getDay()];
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
    snapBrowseCardBasis: snapBrowseCardBasis,
    snapBrowsePageSize: snapBrowsePageSize,
    browsePageSizeTierIndex: browsePageSizeTierIndex,
    browseCardTierIndexForBasis: browseCardTierIndexForBasis,
    normalizePositiveIntFilter: normalizePositiveIntFilter,
    normalizePositiveFloatFilter: normalizePositiveFloatFilter,
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
