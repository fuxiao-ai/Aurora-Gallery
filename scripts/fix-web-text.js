'use strict';
/* 以 "index - 副本.html"（结构完整但中文已腐蚀为 ?) 为输入，
   参照 src/renderer/index.html 的文案，生成正确的 src/web/index.html */
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');

var backup = path.join(root, 'src', 'web', 'index - \u526F\u672C.html');
var outFile = path.join(root, 'src', 'web', 'index.html');

var html = fs.readFileSync(backup, 'utf8');

function ra(src, from, to) {
  return src.split(from).join(to);
}

// ── <title> ──────────────────────────────────────────────────────────────────
html = ra(html, '<title>????</title>', '<title>\u62C2\u6653\u56FE\u5E93</title>');

// ── 顶部 header ──────────────────────────────────────────────────────────────
// 移动端菜单按钮
html = ra(
  html,
  'onclick="toggleMobileSidebar()" aria-label="????">\u003F</button>',
  'onclick="toggleMobileSidebar()" aria-label="\u6253\u5F00\u83DC\u5355">\u2630</button>',
);

// 标题
html = ra(
  html,
  '<div class="header-title">????</div>',
  '<div class="header-title">\u62C2\u6653\u56FE\u5E93</div>',
);

// 搜索框图标
html = ra(html, '"search-icon">S</span>', '"search-icon">\uD83D\uDD0D</span>');

// 搜索框 placeholder / aria-label
html = ra(
  html,
  'placeholder="????..." aria-label="????"',
  'placeholder="\u641C\u7D22\u7167\u7247..." aria-label="\u641C\u7D22\u7167\u7247"',
);

// 主题选择器 aria-label / title（两处：header-theme-select 与 mobileThemeStyleSelect）
html = ra(
  html,
  'id="webThemeStyle"\n        class="header-theme-select"\n        aria-label="????"\n        title="????"',
  'id="webThemeStyle"\n        class="header-theme-select"\n        aria-label="\u4E3B\u9898\u98CE\u683C"\n        title="\u4E3B\u9898\u98CE\u683C"',
);

// ── 主题选项（header + mobile sheet 各出现一次，共两次，用 ra 全替换）────────
html = ra(
  html,
  '<option value="midnight_classic">????</option>',
  '<option value="midnight_classic">\u591C\u5E55\u7ECF\u5178</option>',
);
html = ra(
  html,
  '<option value="ice_deep">????</option>',
  '<option value="ice_deep">\u6DF1\u7A7A\u51B0\u84DD</option>',
);
html = ra(
  html,
  '<option value="amber_dawn">????</option>',
  '<option value="amber_dawn">\u6668\u5149\u7425\u73C0</option>',
);
html = ra(
  html,
  '<option value="sky_light">????</option>',
  '<option value="sky_light">\u6674\u7A7A\u6D45\u84DD</option>',
);
html = ra(
  html,
  '<option value="cherry_blossom">????</option>',
  '<option value="cherry_blossom">\u6A31\u96FE\u7C89\u663C</option>',
);
html = ra(
  html,
  '<option value="arctic_mint">????</option>',
  '<option value="arctic_mint">\u8584\u8377\u6781\u5149</option>',
);

// ── 侧边栏 tabs ──────────────────────────────────────────────────────────────
html = ra(
  html,
  'class="sidebar-tab active" data-tab="folders" onclick="switchTab(\'folders\')">\n            ???',
  'class="sidebar-tab active" data-tab="folders" onclick="switchTab(\'folders\')">\n            \u6587\u4EF6\u5939',
);
html = ra(
  html,
  'class="sidebar-tab" data-tab="dates" onclick="switchTab(\'dates\')">??</div>',
  'class="sidebar-tab" data-tab="dates" onclick="switchTab(\'dates\')">\u65E5\u671F</div>',
);

// ── 工具栏 ───────────────────────────────────────────────────────────────────
html = ra(html, 'id="toolbarPath">????</div>', 'id="toolbarPath">\u6240\u6709\u7167\u7247</div>');

// 筛选按钮（移动端）
html = ra(
  html,
  'id="mobileFilterBtn" onclick="openMobileFilterSheet()">\n            ??',
  'id="mobileFilterBtn" onclick="openMobileFilterSheet()">\n            \u7B5B\u9009',
);

// 媒体类型筛选（出现两次：toolbar + mobile sheet）
html = ra(
  html,
  '<option value="all" selected>??</option>',
  '<option value="all" selected>\u5168\u90E8</option>',
);
html = ra(
  html,
  '<option value="image">???</option>',
  '<option value="image">\u4EC5\u56FE\u7247</option>',
);
html = ra(
  html,
  '<option value="video">???</option>',
  '<option value="video">\u4EC5\u89C6\u9891</option>',
);

// 排序（出现两次：toolbar + mobile sheet）
html = ra(
  html,
  '<option value="date_taken|DESC">????</option>',
  '<option value="date_taken|DESC">\u6700\u65B0\u62CD\u6444</option>',
);
html = ra(
  html,
  '<option value="date_taken|ASC">????</option>',
  '<option value="date_taken|ASC">\u6700\u65E9\u62CD\u6444</option>',
);
html = ra(
  html,
  '<option value="file_name|ASC">??? A-Z</option>',
  '<option value="file_name|ASC">\u6587\u4EF6\u540D A-Z</option>',
);
html = ra(
  html,
  '<option value="file_name|DESC">??? Z-A</option>',
  '<option value="file_name|DESC">\u6587\u4EF6\u540D Z-A</option>',
);
html = ra(
  html,
  '<option value="file_size|DESC">??????</option>',
  '<option value="file_size|DESC">\u4F53\u79EF\u4ECE\u5927\u5230\u5C0F</option>',
);
html = ra(
  html,
  '<option value="file_size|ASC">??????</option>',
  '<option value="file_size|ASC">\u4F53\u79EF\u4ECE\u5C0F\u5230\u5927</option>',
);

// ── 缩放控件 ─────────────────────────────────────────────────────────────────
html = ra(
  html,
  'onclick="changeCardSize(-1)" aria-label="????"',
  'onclick="changeCardSize(-1)" aria-label="\u7F29\u5C0F\u5361\u7247"',
);
html = ra(
  html,
  'aria-label="Zoom in">+</button>',
  'aria-label="\u653E\u5927\u5361\u7247">+</button>',
);

// ── 分页 ─────────────────────────────────────────────────────────────────────
html = ra(
  html,
  'id="prevPage" onclick="prevPage()">\u003F</button>',
  'id="prevPage" onclick="prevPage()">\u2039</button>',
);

// ── 移动端底部导航 ────────────────────────────────────────────────────────────
html = ra(html, '"nav-icon">B</span>', '"nav-icon">\uD83D\uDDBC\uFE0F</span>');
html = ra(html, '"nav-icon">F</span>', '"nav-icon">\uD83D\uDCC1</span>');
html = ra(html, '"nav-icon">D</span>', '"nav-icon">\uD83D\uDCC5</span>');
html = ra(html, '"nav-icon">S</span>', '"nav-icon">\uD83D\uDD0D</span>');

// nav-label（借助唯一相邻标签区分）
html = ra(
  html,
  '"nav-label">??</span>\n      </div>\n      <div class="mobile-nav-item" data-tab="folders"',
  '"nav-label">\u6D4F\u89C8</span>\n      </div>\n      <div class="mobile-nav-item" data-tab="folders"',
);
html = ra(html, '"nav-label">???</span>', '"nav-label">\u6587\u4EF6\u5939</span>');
html = ra(
  html,
  '"nav-label">??</span>\n      </div>\n      <div class="mobile-nav-item" data-tab="search"',
  '"nav-label">\u65E5\u671F</span>\n      </div>\n      <div class="mobile-nav-item" data-tab="search"',
);
html = ra(
  html,
  '"nav-label">??</span>\n      </div>\n    </div>\n    <div class="mobile-filter-backdrop"',
  '"nav-label">\u641C\u7D22</span>\n      </div>\n    </div>\n    <div class="mobile-filter-backdrop"',
);

// ── 移动端筛选抽屉 ────────────────────────────────────────────────────────────
html = ra(html, '"sheet-title">?????</div>', '"sheet-title">\u7B5B\u9009\u4E0E\u6392\u5E8F</div>');
html = ra(
  html,
  '<label for="mobileThemeStyleSelect">??</label>',
  '<label for="mobileThemeStyleSelect">\u4E3B\u9898</label>',
);
html = ra(
  html,
  '<label for="mobileMediaFilterSelect">????</label>',
  '<label for="mobileMediaFilterSelect">\u5A92\u4F53\u7C7B\u578B</label>',
);
html = ra(
  html,
  '<label for="mobileSortSelect">????</label>',
  '<label for="mobileSortSelect">\u6392\u5E8F\u65B9\u5F0F</label>',
);
// 安装 & 关闭按钮
html = ra(
  html,
  'onclick="showInstallGuide()">?????</button>',
  'onclick="showInstallGuide()">\u5B89\u88C5\u5230\u684C\u9762</button>',
);
html = ra(
  html,
  'onclick="closeMobileFilterSheet()">??</button>',
  'onclick="closeMobileFilterSheet()">\u5173\u95ED</button>',
);

// ── 预览面板 ─────────────────────────────────────────────────────────────────
// 幻灯片播放按钮
html = ra(
  html,
  'id="slideshowToggleBtn" onclick="toggleSlideshow()">??</button>',
  'id="slideshowToggleBtn" onclick="toggleSlideshow()">\u64AD\u653E</button>',
);
// 秒单位
html = ra(html, '<option value="2">2 \u003F</option>', '<option value="2">2 \u79D2</option>');
html = ra(
  html,
  '<option value="3" selected>3 \u003F</option>',
  '<option value="3" selected>3 \u79D2</option>',
);
html = ra(html, '<option value="5">5 \u003F</option>', '<option value="5">5 \u79D2</option>');
html = ra(html, '<option value="10">10 \u003F</option>', '<option value="10">10 \u79D2</option>');
// 随机 / 字幕 / 全屏
html = ra(
  html,
  'id="slideshowRandomBtn" onclick="toggleSlideshowRandom()">??</button>',
  'id="slideshowRandomBtn" onclick="toggleSlideshowRandom()">\u968F\u673A</button>',
);
html = ra(
  html,
  'id="previewSubtitleToggleBtn" onclick="toggleSubtitleEnabled()">??:\u003F</button>',
  'id="previewSubtitleToggleBtn" onclick="toggleSubtitleEnabled()">\u5B57\u5E55:\u5F00</button>',
);
html = ra(
  html,
  'id="previewFullscreenBtn" onclick="togglePreviewFullscreen()">??</button>',
  'id="previewFullscreenBtn" onclick="togglePreviewFullscreen()">\u5168\u5C4F</button>',
);
// 关闭预览按钮
html = ra(
  html,
  'class="preview-close" onclick="closePreview()" aria-label="????">\u003F\u003F</button>',
  'class="preview-close" onclick="closePreview()" aria-label="\u5173\u95ED\u9884\u89C8">\u5173\u95ED</button>',
);
// 滑动提示
html = ra(
  html,
  'id="previewSwipeHint">??????</div>',
  'id="previewSwipeHint">\u5DE6\u53F3\u6ED1\u52A8\u5207\u6362</div>',
);
// 上一张
html = ra(
  html,
  'class="preview-nav preview-prev" onclick="navigatePreview(-1, event)" aria-label="???"',
  'class="preview-nav preview-prev" onclick="navigatePreview(-1, event)" aria-label="\u4E0A\u4E00\u5F20"',
);
// 加载中
html = ra(html, '<span>\u003F\u003F\u003F...</span>', '<span>\u52A0\u8F7D\u4E2D...</span>');
// 图片 alt
html = ra(html, 'src="" alt="????"', 'src="" alt="\u9884\u89C8\u56FE\u7247"');
// 下一张
html = ra(
  html,
  'class="preview-nav preview-next" onclick="navigatePreview(1, event)" aria-label="???"',
  'class="preview-nav preview-next" onclick="navigatePreview(1, event)" aria-label="\u4E0B\u4E00\u5F20"',
);

// 缩放提示文字（tooltip）— · 字符已腐蚀为 U+FFFD
html = ra(
  html,
  'Ctrl\u003FMac\u003F\u003F\u003F+ \u003F\u003F\u003F\u003F<br />\u003F\u003F + / - \u003F\u003F \uFFFD \u003F\u003F\u003F\u003F\u003F\u003F\u003F\u003F\u003F',
  'Ctrl\uFF08Mac\uFF1A\u2318\uFF09+ \u6EDA\u8F6E\u7F29\u653E<br />\u952E\u76D8 + / \u2212 \u7F29\u653E \u00B7 \u89E6\u6478\u5C4F\u53CC\u6307\u636E\u5408\u7F29\u653E',
);

// ── 写出 ─────────────────────────────────────────────────────────────────────
fs.writeFileSync(outFile, html, 'utf8');
console.log('写出:', outFile);

// 快速验证
var out = fs.readFileSync(outFile, 'utf8');
var matches = out.match(/>\s*\?+\s*</g) || [];
console.log('Remaining UI-context ?-sequences:', matches.length);
if (matches.length > 0) {
  console.log(matches.slice(0, 10));
}
