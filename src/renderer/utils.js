(function (global) {
  var CARD_SIZE_TIERS = [
    { label: 'S', basis: 100 },
    { label: 'M', basis: 140 },
    { label: 'L', basis: 180 },
    { label: 'XL', basis: 320 },
  ];

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
    snapBrowseCardBasis: snapBrowseCardBasis,
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
