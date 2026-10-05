/**
 * 网页端「设置」页。
 *
 * ## 它是什么
 * 与桌面端设置页**同一套信息架构**（8 面板，同序、同名、同图标），但网页端是 LAN 上的
 * 客户端，权限与桌面端不同，所以每个面板都按「能不能改」分两组：
 *   - **这台设备（可改）**：本来就存在浏览器本地的偏好 —— 主题、强调色、背景、每页数量、
 *     网格比例、卡片尺寸。它们与桌面端本来就解耦（桌面端存 `settings`，网页端存
 *     `localStorage`），这里只是把它们收进一个入口，不再散在顶栏和「筛选与排序」抽屉里。
 *   - **桌面端（只读）**：其余全部设置。写入口只有桌面端一处 —— 与 `/api/info-fields`
 *     同一条契约。所以这里显示的是**取值文本**而不是灰掉的控件：灰下拉框看起来像坏了。
 *
 * ## 为什么不复用桌面端的渲染
 * 桌面端那套是 `settings.js` + `i18n.js` + `data-i18n` 属性 + 直接走 IPC 读写 `settings`，
 * 网页端没有 `photoAPI`、没有 i18n 层、也没有写权限。能共用的只有**取值语义**，所以这里
 * 重新写一份**只读呈现**，而不是把桌面端的面板搬过来让它一半的控件失效。
 *
 * ## 数据来源
 * `/api/settings`（只读快照，白名单在 `main.js#buildWebSettingsSnapshot`）。
 * 🔴 快照里**不含** `webPassword` 本身、隧道凭据、本机绝对路径 —— 只出 `hasWebPassword`
 *    布尔值。新增要展示的项时先确认它已经进了那个白名单，否则这里会读到 undefined。
 *
 * ## 依赖的全局（都由 app.js 挂到 window，本文件必须排在 app.js 之后加载）
 * `changePageSize` / `changeCardSizeTo` / `changeCardAspectMode` /
 * `applyWebThemeStyle` / `changeWebAccent` / `changeWebBackground` /
 * `closeMobileFilterSheet` / `WebTheme`
 */
(function () {
  'use strict';

  var API_SETTINGS = '/api/settings';
  var API_ROOT_FOLDERS = '/api/root-folders?lite=1';

  var state = {
    mounted: false,
    open: false,
    activePanel: 'browse',
    snapshot: null,
    error: '',
    roots: null,
    rootsError: '',
  };

  // ============================================================ 面板定义
  // 顺序与桌面端 `src/renderer/ui-settings.js` 的 navItems **逐位一致**：
  // 媒体库 → 浏览与显示 → 快捷键 → 媒体与存储 → 后台任务 → AI 与索引 → 外观与行为 → 网络与远程。
  // 改这里请同步改那边，两端的面板顺序不该出现第三种答案。
  // ⚠️ 取某个面板的元信息一律走 panelMeta('id')，不要写 PANELS[<数字>]：
  //    2026-10-05 在中间插入「AI 与索引」时，硬索引让后面每个面板都顶上了别人的标题，
  //    而「两端面板顺序一致」那条对账照样是绿的（它只比名字列表，不看谁在用）。
  var PANELS = [
    {
      id: 'library',
      icon: '\u{1F4C1}',
      title: '媒体库',
      desc: '这里列出桌面端已添加的相册目录。网页端只读：添加与移除目录、扫描、去重都在桌面端完成。',
    },
    {
      id: 'browse',
      icon: '\u{1F39E}\uFE0F',
      title: '浏览与显示',
      desc: '照片墙怎么排、每页放多少张。这些偏好存在这台设备的浏览器里，改完立刻生效，不影响其他设备。',
    },
    {
      id: 'shortcuts',
      icon: '\u2328\uFE0F',
      title: '快捷键',
      desc: '浏览时可以直接用键盘操作。下面是网页端当前支持的键位。',
    },
    {
      id: 'storage',
      icon: '\u{1F5C4}\uFE0F',
      title: '媒体与存储',
      desc: '缩略图与视频播放的取舍：越大越清晰，也越占空间。这些决定缩略图怎么生成，只有桌面端能改。',
    },
    {
      id: 'tasks',
      icon: '\u{1F6E0}\uFE0F',
      title: '后台任务',
      desc: '桌面端启动时会自动做的整理工作，以及「相似照片」的判定松紧。',
    },
    {
      id: 'ai',
      icon: '\u{1F9E0}',
      title: 'AI 与索引',
      desc: '搜图与人物识别都在桌面端本机运行，照片不会上传。模型与索引的开关、识别参数都在桌面端改，这里只显示搜索相关的只读值。',
    },
    {
      id: 'appearance',
      icon: '\u{1F3A8}',
      title: '外观与行为',
      desc: '界面长什么样，以及桌面端启动落在哪一页、关窗口时怎么办。',
    },
    {
      id: 'network',
      icon: '\u{1F310}',
      title: '网络与远程',
      desc: '网页端自身的访问方式。改这些会影响所有设备能不能连上，只开放给桌面端。',
    },
  ];

  // ============================================================ 取值文案
  // 只读值一律翻成用户语言：把 `uniform` / `tray` / `last_position` 这种内部取值直接
  // 显示出来，等于把设置页变成了配置文件的只读副本。
  var LAYOUT_LABELS = { masonry: '瀑布流（保留原比例）', uniform: '统一比例' };
  var RATIO_LABELS = {
    '1 / 1': '1:1 正方形',
    '4 / 3': '4:3 横向',
    '3 / 4': '3:4 竖向',
    '16 / 9': '16:9 宽幅',
    '9 / 16': '9:16 竖屏',
  };
  var LAUNCH_LABELS = {
    welcome: '欢迎页',
    all_folders: '全部照片',
    last_position: '上次看到的位置',
  };
  var CLOSE_LABELS = { ask: '每次问我', tray: '收进托盘后台运行', quit: '直接退出程序' };
  var VIDEO_CLICK_LABELS = { system: '用系统播放器打开', embedded: '在网页里播放' };
  var LOCALE_LABELS = { 'zh-CN': '简体中文', en: 'English' };
  var SUBTITLE_FAMILY_LABELS = { system: '跟随系统', serif: '衬线体', mono: '等宽体' };
  var SORT_BY_LABELS = {
    date_taken: '拍摄时间',
    date_modified: '修改时间',
    file_name: '文件名',
    file_size: '文件体积',
  };
  var SORT_ORDER_LABELS = { DESC: '从新到旧', ASC: '从旧到新' };

  /** 网页端自己支持的键位。⚠️ 这一套是**硬编码**的，不跟随桌面端的自定义快捷键。 */
  var WEB_KEYS = [
    { caps: ['Esc'], desc: '关闭大图预览 / 搜索框 / 右键菜单' },
    { caps: ['\u2190', '\u2192'], desc: '大图预览里看上一张 / 下一张' },
    { caps: ['Space'], desc: '大图预览里暂停或继续幻灯片' },
    { caps: ['+', '-'], desc: '放大 / 缩小' },
    { caps: ['0'], desc: '缩放还原' },
    { caps: ['Enter'], desc: '在搜索框里回车开始搜图' },
  ];

  /** 卡片尺寸档位：与 app.js 的 `CARD_SIZE_TIERS` 同一组 basis，只多一层用户文案 */
  var CARD_TIER_LABELS = [
    { basis: 100, label: 'S（小）' },
    { basis: 140, label: 'M（中）' },
    { basis: 180, label: 'L（大）' },
    { basis: 320, label: 'XL（特大）' },
  ];

  /** 顶部说明条的常态文案。比「只读」两个字更重要的是说清**哪些能改**，
   *  否则用户会以为整页都是摆设而直接关掉。 */
  var BANNER_TEXT =
    '<b>网页端是只读镜像。</b>带「桌面端」标签的项目要在装图库的那台电脑上修改；' +
    '浏览方式、外观等存在这台设备浏览器里的偏好，则可以在这里直接改。';

  // ============================================================ 小工具
  function byId(id) {
    return document.getElementById(id);
  }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function pick(map, value, fallbackText) {
    if (value === undefined || value === null || value === '') return fallbackText || '未设置';
    return Object.prototype.hasOwnProperty.call(map, value)
      ? map[value]
      : String(value) + '（未识别）';
  }

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
  }

  function onOff(v) {
    return v ? '已开启' : '已关闭';
  }

  function formatBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '未设置';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v = v / 1024;
      i++;
    }
    return (i === 0 ? v : Math.round(v * 10) / 10) + ' ' + units[i];
  }

  function basename(p) {
    return String(p || '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || String(p || '');
  }

  // ============================================================ HTML 片段
  function panelHead(panel) {
    return (
      '<div class="web-settings-panel-head">' +
      '<div class="web-settings-panel-title">' +
      esc(panel.title) +
      '</div>' +
      '<div class="web-settings-panel-desc">' +
      esc(panel.desc) +
      '</div>' +
      '</div>'
    );
  }

  function group(title, inner) {
    return (
      '<section class="web-settings-group">' +
      (title ? '<div class="web-settings-group-title">' + esc(title) + '</div>' : '') +
      inner +
      '</section>'
    );
  }

  function readonlyRow(cfg) {
    var tone = cfg.tone ? ' ' + cfg.tone : '';
    return (
      '<div class="web-settings-row">' +
      '<div class="web-settings-row-main">' +
      '<div class="web-settings-row-label">' +
      esc(cfg.label) +
      '<span class="web-settings-readonly-tag">桌面端</span>' +
      '</div>' +
      (cfg.desc ? '<div class="web-settings-row-desc">' + esc(cfg.desc) + '</div>' : '') +
      '</div>' +
      '<div class="web-settings-row-control">' +
      '<span class="web-settings-value' +
      tone +
      '">' +
      esc(cfg.value) +
      '</span>' +
      '</div>' +
      '</div>'
    );
  }

  function controlRow(cfg) {
    return (
      '<div class="web-settings-row">' +
      '<div class="web-settings-row-main">' +
      '<div class="web-settings-row-label">' +
      esc(cfg.label) +
      '</div>' +
      (cfg.desc ? '<div class="web-settings-row-desc">' + esc(cfg.desc) + '</div>' : '') +
      '</div>' +
      '<div class="web-settings-row-control">' +
      cfg.control +
      '</div>' +
      '</div>'
    );
  }

  function note(markup) {
    return '<div class="web-settings-note">' + markup + '</div>';
  }

  function empty(text) {
    return '<div class="web-settings-empty">' + esc(text) + '</div>';
  }

  function selectHtml(id, optionsHtml) {
    return '<select id="' + id + '" class="web-settings-select">' + optionsHtml + '</select>';
  }

  /**
   * 从既有下拉框克隆选项，避免把预设表在网页端再抄一份。
   * 🔴 主题 22 套 / 强调色 10 色 / 背景 11 档这些清单的真相源在 `web-theme-shared.js` 与
   *    `src/web/index.html` 的顶栏 `<select>` 里；在这里另写一张表就等于开了第二个来源，
   *    下次加预设必然漏一处（本项目已经因为同一模式踩过「改阈值要改两处」的坑）。
   */
  function optionsFrom(sourceId, currentValue) {
    var src = byId(sourceId);
    if (!src) return '';
    var out = '';
    for (var i = 0; i < src.options.length; i++) {
      var o = src.options[i];
      out +=
        '<option value="' +
        esc(o.value) +
        '"' +
        (String(o.value) === String(currentValue) ? ' selected' : '') +
        '>' +
        esc(o.textContent) +
        '</option>';
    }
    return out;
  }

  function cardSizeOptions(current) {
    var out = '';
    for (var i = 0; i < CARD_TIER_LABELS.length; i++) {
      out +=
        '<option value="' +
        CARD_TIER_LABELS[i].basis +
        '"' +
        (Number(current) === CARD_TIER_LABELS[i].basis ? ' selected' : '') +
        '>' +
        esc(CARD_TIER_LABELS[i].label) +
        '</option>';
    }
    return out;
  }

  // ==================================================== 这台设备的当前取值
  // 一律从 DOM 读，不去碰 app.js 的 `state` —— 那几个下拉框是 app.js 每次改动都会回显的，
  // 是最可靠的「当前生效值」，也是唯一不需要跨模块耦合的读法。
  function currentPageSize() {
    var el = byId('pageSizeSelect') || byId('mobilePageSizeSelect');
    return el ? el.value : '';
  }

  function currentCardAspect() {
    var el = byId('headerCardAspectSelect') || byId('cardAspectSelect');
    return el ? el.value : 'masonry';
  }

  function currentCardSize() {
    var btn = document.querySelector('#cardSizeGroup button.active, #cardSizeButtons button.active');
    return btn ? btn.dataset.size : '180';
  }

  function currentThemeStyle() {
    var el = byId('webThemeStyle') || byId('mobileThemeStyleSelect');
    return el ? el.value : '';
  }

  function currentAccent() {
    var el = byId('webAccentSelect') || byId('mobileAccentSelect');
    return el ? el.value : 'violet';
  }

  function currentBackground() {
    var el = byId('webBackgroundSelect') || byId('mobileBackgroundSelect');
    return el ? el.value : 'default';
  }

  // ============================================================ 各面板渲染
  function renderLibrary() {
    var panel = panelMeta('library');
    var html = panelHead(panel);
    var cards;

    if (state.roots === null) {
      cards = state.rootsError ? empty(state.rootsError) : empty('正在读取目录…');
    } else if (!state.roots.length) {
      cards = empty('桌面端还没有添加任何相册目录。请在桌面端「设置 → 媒体库」里添加。');
    } else {
      var rows = '';
      for (var i = 0; i < state.roots.length; i++) {
        var f = state.roots[i] || {};
        var p = f.folder_path || f.path || '';
        var count =
          f.photo_count === null || f.photo_count === undefined
            ? ''
            : String(f.photo_count) + ' 张';
        rows += readonlyRow({
          label: basename(p) || p,
          desc: p,
          value: count || '（数量待统计）',
        });
      }
      cards = rows;
    }

    html += group('相册目录' + (state.roots && state.roots.length ? '（' + state.roots.length + '）' : ''), cards);
    html += group(
      '',
      note(
        '网页端把照片按目录、日期、人物分好组给你看，但 <b>不会</b> 动磁盘上的文件。' +
          '添加目录、重新扫描、清理重复文件都在桌面端完成。',
      ),
    );
    return html;
  }

  function renderBrowse() {
    var panel = panelMeta('browse');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    var local = '';
    local += controlRow({
      label: '每页显示',
      desc: '一屏最多放多少张。图片多的大目录调小一点更流畅。',
      control: selectHtml('wsPageSize', optionsFrom('pageSizeSelect', currentPageSize())),
    });
    local += controlRow({
      label: '网格与比例',
      desc: '「原比例瀑布流」按每张照片自己的长宽比排；固定比例会让整面墙整齐但裁掉一部分。',
      control: selectHtml('wsCardAspect', optionsFrom('cardAspectSelect', currentCardAspect())),
    });
    local += controlRow({
      label: '卡片尺寸',
      desc: '每张缩略图占多大。手机屏幕建议选小一点。',
      control: selectHtml('wsCardSize', cardSizeOptions(currentCardSize())),
    });
    html += group('这台设备', local);

    var remote = '';
    remote += readonlyRow({
      label: '默认排序',
      desc: '新装设备第一次打开时的排序方式。',
      value:
        pick(SORT_BY_LABELS, s.browseSortBy, '拍摄时间') +
        ' · ' +
        pick(SORT_ORDER_LABELS, s.browseSortOrder, '从新到旧'),
    });
    remote += readonlyRow({
      label: '网格样式',
      desc: '桌面端照片墙用的布局与比例。',
      value:
        pick(LAYOUT_LABELS, s.browseCardLayout, '瀑布流') +
        ' · ' +
        pick(RATIO_LABELS, s.browseCardRatio, '1:1 正方形'),
    });
    remote += readonlyRow({
      label: '缩略图裁剪',
      desc: '开启后缩略图会按统一比例裁切，而不是保留整张照片。',
      value: onOff(s.browseThumbCrop),
      tone: s.browseThumbCrop ? 'is-on' : 'is-off',
    });
    remote += readonlyRow({
      label: '文件夹包含子目录',
      desc: '点开一个文件夹时，是否把它下面所有子目录的照片一起列出来。',
      value: onOff(s.browseFolderIncludeSubfolders),
      tone: s.browseFolderIncludeSubfolders ? 'is-on' : 'is-off',
    });
    remote += readonlyRow({
      label: '点击视频',
      desc: '在照片墙里点一个视频时怎么播放。',
      value: pick(VIDEO_CLICK_LABELS, s.videoClickBehavior, '在网页里播放'),
    });
    html += group('桌面端的浏览默认值', remote);

    html += group(
      '',
      note(
        '「这台设备」的改动只影响当前这个浏览器，不会同步到手机或桌面端 —— ' +
          '所以你可以给手机设小卡片、给电脑设大卡片。',
      ),
    );
    return html;
  }

  function renderShortcuts() {
    var panel = panelMeta('shortcuts');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    var keys = '<div class="web-settings-keys">';
    for (var i = 0; i < WEB_KEYS.length; i++) {
      var k = WEB_KEYS[i];
      var caps = '';
      for (var c = 0; c < k.caps.length; c++) {
        caps += '<span class="web-settings-key-cap">' + esc(k.caps[c]) + '</span>';
      }
      keys +=
        '<div class="web-settings-key-row">' +
        '<span class="web-settings-key-desc">' +
        esc(k.desc) +
        '</span>' +
        caps +
        '</div>';
    }
    keys += '</div>';
    html += group('网页端可用键位', keys);

    var overrides = s.shortcuts && typeof s.shortcuts === 'object' ? Object.keys(s.shortcuts).length : 0;
    var desktop = '';
    desktop += readonlyRow({
      label: '桌面端自定义',
      desc: '桌面端可以给「添加文件夹、全屏、大图预览翻页、缩放」等动作逐个换键。',
      value: overrides > 0 ? overrides + ' 个动作已改键' : '全部使用默认键位',
      tone: overrides > 0 ? 'is-on' : '',
    });
    html += group('桌面端', desktop);

    html += group(
      '',
      note(
        '网页端的键位是固定的，不跟随桌面端的自定义设置 —— ' +
          '浏览器里有一部分按键（如 Ctrl+W、F11）会被浏览器自己抢走，改了也不会生效。',
      ),
    );
    return html;
  }

  function renderStorage() {
    var panel = panelMeta('storage');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    var thumb = '';
    thumb += readonlyRow({
      label: '缩略图长边',
      desc: '生成缩略图时的最长边像素。调大更清晰，但占用更多磁盘、滚动也更吃内存。',
      value: has(s, 'thumbSize') ? String(s.thumbSize) + ' px' : '未设置',
    });
    thumb += readonlyRow({
      label: '缩略图质量',
      desc: 'JPEG 压缩质量。画质与体积的取舍，通常 75 左右看不出差别。',
      value: has(s, 'thumbQuality') ? String(s.thumbQuality) + ' %' : '未设置',
    });
    html += group('缩略图', thumb);

    var video = '';
    video += readonlyRow({
      label: '视频播放缓存上限',
      desc: '网页端播放视频时会边转码边缓存，超过上限就淘汰最早的片段。',
      value: formatBytes(s.hlsMaxCacheBytes),
    });
    video += readonlyRow({
      label: '缓存片段数上限',
      desc: '除容量之外再限制片段的个数，防止大量小文件把目录塞满。',
      value: has(s, 'hlsMaxCacheEntries') ? String(s.hlsMaxCacheEntries) + ' 个' : '未设置',
    });
    html += group('视频播放', video);

    var sub = '';
    sub += readonlyRow({
      label: '字幕字体',
      value: pick(SUBTITLE_FAMILY_LABELS, s.subtitleFontFamily, '跟随系统'),
    });
    sub += readonlyRow({
      label: '字幕字号',
      value: has(s, 'subtitleFontSizePx') ? String(s.subtitleFontSizePx) + ' px' : '未设置',
    });
    sub += readonlyRow({
      label: '字幕字重',
      value: has(s, 'subtitleFontWeight') ? String(s.subtitleFontWeight) : '未设置',
    });
    sub += readonlyRow({
      label: '字幕颜色',
      desc: '用来在外挂字幕上盖一层描边，保证浅色画面里也看得清。',
      value: s.subtitleColor || '未设置',
    });
    html += group('视频字幕', sub);
    return html;
  }

  function renderTasks() {
    var panel = panelMeta('tasks');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    function flagRow(label, desc, v) {
      return readonlyRow({ label: label, desc: desc, value: onOff(v), tone: v ? 'is-on' : 'is-off' });
    }

    var startup = '';
    startup += flagRow('启动时扫描新文件', '打开桌面端时自动找一遍目录里的新照片。', s.autoScanOnStartup);
    startup += flagRow(
      '启动时补缩略图',
      '给还没有缩略图的照片补上，这样滚动时不会出现占位图。',
      s.autoThumbBackfillOnStartup,
    );
    startup += flagRow(
      '启动时计算重复检测数据',
      '为「查找重复照片」预先算好指纹，代价是启动后台会忙一阵。',
      s.autoHashOnStartup,
    );
    startup += readonlyRow({
      label: '缩略图生成并发',
      desc: '同时处理多少张。调高更快，但会把磁盘和 CPU 占满。',
      value: has(s, 'thumbBackfillConcurrency') ? String(s.thumbBackfillConcurrency) + ' 路' : '未设置',
    });
    html += group('桌面端启动时', startup);

    var thresholds = '';
    thresholds += readonlyRow({
      label: '相似照片判定',
      desc: '两张照片的指纹差异小于这个值就算相似。范围 0–64，越小越严格、找到的越少。',
      value: has(s, 'similarThreshold') ? String(s.similarThreshold) : '未设置',
    });
    html += group('判定松紧', thresholds);

    html += group(
      '',
      note(
        '这些任务都在桌面端后台排队执行，网页端只是如实显示当前设置。' +
          '如果网页端突然变得很慢，多半是桌面端正在扫描或补齐缩略图。',
      ),
    );
    return html;
  }

  function renderAppearance() {
    var panel = panelMeta('appearance');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    var local = '';
    local += controlRow({
      label: '界面风格',
      desc: '一整套配色预设。选「自定义组合」可以只改下面的强调色与背景基调。',
      control: selectHtml('wsThemeStyle', optionsFrom('webThemeStyle', currentThemeStyle())),
    });
    local += controlRow({
      label: '强调色',
      desc: '按钮、选中态、链接用的主色。',
      control: selectHtml('wsAccent', optionsFrom('webAccentSelect', currentAccent())),
    });
    local += controlRow({
      label: '背景基调',
      desc: '界面底色的冷暖与明暗，与上面的风格预设互相独立。',
      control: selectHtml('wsBackground', optionsFrom('webBackgroundSelect', currentBackground())),
    });
    html += group('这台设备的外观', local);

    var remote = '';
    remote += readonlyRow({
      label: '界面语言',
      desc: '桌面端与网页端的文案语言。',
      value: pick(LOCALE_LABELS, s.uiLocale, '简体中文'),
    });
    remote += readonlyRow({
      label: '启动后停在',
      desc: '桌面端打开时先给你看哪一页。',
      value: pick(LAUNCH_LABELS, s.launchDefaultPage, '欢迎页'),
    });
    remote += readonlyRow({
      label: '关闭窗口时',
      desc: '点桌面端右上角的 × 之后做什么。',
      value: pick(CLOSE_LABELS, s.windowCloseBehavior, '每次问我'),
    });
    var fieldCount = Array.isArray(s.infoPanelFields) ? s.infoPanelFields.length : null;
    remote += readonlyRow({
      label: '照片信息显示的字段',
      desc: '大图预览右侧「照片信息」里显示哪些项。',
      value:
        fieldCount === null
          ? '跟随默认'
          : fieldCount === 0
            ? '全部隐藏'
            : fieldCount + ' 项',
    });
    html += group('桌面端', remote);

    html += group(
      '',
      note(
        '主题、语言这类改动只在桌面端保存一次、两端各自生效 —— ' +
          '桌面端的外观存的是「六元组」，网页端存的是浏览器本地的一份，互不覆盖。',
      ),
    );
    return html;
  }

  function renderAi() {
    var panel = panelMeta('ai');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    var search = '';
    search += readonlyRow({
      label: '以图搜图匹配',
      desc: '搜索时的相似度门槛，数值越小越严格、返回的照片越少。',
      value: has(s, 'aiSearchMatchThreshold') ? String(s.aiSearchMatchThreshold) : '未设置',
    });
    html += group('搜图索引', search);

    html += group(
      '人物索引',
      note(
        '人脸模型的下载与索引建立，以及识别参数（归组方式、分组相似度阈值、文件夹层级、域分组、原图读取失败时改用缩略图）都只在桌面端的「设置 → AI 与索引」里改，网页端不做展示。',
      ),
    );

    html += group(
      '',
      note('这些计算都在桌面端本机完成，照片不会上传到任何服务器。'),
    );
    return html;
  }

  function renderNetwork() {
    var panel = panelMeta('network');
    var s = state.snapshot || {};
    var html = panelHead(panel);

    var rows = '';
    rows += readonlyRow({
      label: '局域网访问',
      desc: '允许同一 Wi-Fi 下的手机、平板通过地址访问这个图库。',
      value: onOff(s.webLanEnabled),
      tone: s.webLanEnabled ? 'is-on' : 'is-off',
    });
    rows += readonlyRow({
      label: '公网隧道自启动',
      desc: '桌面端启动时自动开一条公网隧道，出门也能访问。',
      value: onOff(s.cloudflareTunnelAutoStart),
      tone: s.cloudflareTunnelAutoStart ? 'is-on' : 'is-off',
    });
    rows += readonlyRow({
      label: '访问密码',
      desc: '进这个网页需要密码。出于安全考虑，这里只显示有没有设置，不会显示密码本身。',
      value: s.hasWebPassword ? '已设置' : '未设置（局域网内任何人可访问）',
      tone: s.hasWebPassword ? 'is-on' : 'is-off',
    });
    html += group('网页端', rows);

    html += group(
      '',
      note(
        '改这些会影响所有设备能否连上图库，所以只开放给桌面端。' +
          '如果你现在正是从别的设备连过来的，请回到装图库的那台电脑上修改。',
      ),
    );
    return html;
  }

  /**
   * 按 id 取面板元数据。
   * ⚠️ 不要用 `PANELS[n]` 硬索引：往中间插一个面板，后面所有面板的标题 / 图标 /
   * 描述就会整体错位（2026-10-05 加「AI 与索引」时踩到 —— 索引一位移，
   * 「外观与行为」会顶着「网络与远程」的标题）。
   */
  function panelMeta(id) {
    for (var i = 0; i < PANELS.length; i++) {
      if (PANELS[i].id === id) return PANELS[i];
    }
    return PANELS[0];
  }

  var RENDERERS = {
    library: renderLibrary,
    browse: renderBrowse,
    shortcuts: renderShortcuts,
    storage: renderStorage,
    tasks: renderTasks,
    ai: renderAi,
    appearance: renderAppearance,
    network: renderNetwork,
  };

  // ============================================================ 骨架与挂载
  function shellHtml() {
    var nav = '';
    for (var i = 0; i < PANELS.length; i++) {
      nav +=
        '<button type="button" class="web-settings-nav-item" data-ws-panel="' +
        PANELS[i].id +
        '">' +
        '<span class="web-settings-nav-icon" aria-hidden="true">' +
        PANELS[i].icon +
        '</span>' +
        '<span class="web-settings-nav-label">' +
        esc(PANELS[i].title) +
        '</span>' +
        '</button>';
    }
    var panels = '';
    for (var p = 0; p < PANELS.length; p++) {
      panels +=
        '<div class="web-settings-panel" data-ws-panel-body="' + PANELS[p].id + '"></div>';
    }
    return (
      '<div class="web-settings-shell">' +
      '<div class="web-settings-bar">' +
      '<div class="web-settings-bar-main">' +
      '<h2 class="web-settings-title">设置</h2>' +
      '<p class="web-settings-subtitle">' +
      esc('外观与浏览方式可以在这里改；其余设置以桌面端为准，这里只做展示。') +
      '</p>' +
      '</div>' +
      '<button type="button" class="web-settings-close" aria-label="关闭设置" title="关闭">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
      '</button>' +
      '</div>' +
      '<div class="web-settings-banner">' +
      '<span class="web-settings-banner-icon" aria-hidden="true">\u2139\uFE0F</span>' +
      '<span class="web-settings-banner-text">' +
      BANNER_TEXT +
      '</span>' +
      '</div>' +
      '<div class="web-settings-body">' +
      '<nav class="web-settings-nav">' +
      nav +
      '</nav>' +
      '<div class="web-settings-panels">' +
      panels +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function mount() {
    if (state.mounted) return;
    var page = byId('webSettingsPage');
    if (!page) return;
    page.innerHTML = shellHtml();
    state.mounted = true;

    page.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var navItem = t.closest('.web-settings-nav-item');
      if (navItem) {
        selectPanel(navItem.getAttribute('data-ws-panel'), { focus: true });
        return;
      }
      if (t.closest('.web-settings-close')) closeWebSettingsPage();
    });

    // 表单控件用事件委托：面板每次重画都会换掉 DOM，逐个 addEventListener 会漏
    page.addEventListener('change', onControlChange);

    // Esc 关设置页。挂 document 冒泡即可 —— 这里没有「上层弹窗」，不需要 capture，
    // 也不 stopPropagation：让 app.js 那边的关预览 / 关搜索各管各的，互不影响。
    document.addEventListener('keydown', function (e) {
      if (!state.open) return;
      if (e.key === 'Escape') closeWebSettingsPage();
    });
  }

  function onControlChange(e) {
    var el = e.target;
    if (!el || !el.id) return;
    var v = el.value;
    if (el.id === 'wsPageSize' && window.changePageSize) window.changePageSize(v);
    else if (el.id === 'wsCardSize' && window.changeCardSizeTo) window.changeCardSizeTo(parseInt(v, 10));
    else if (el.id === 'wsCardAspect' && window.changeCardAspectMode) window.changeCardAspectMode(v);
    else if (el.id === 'wsThemeStyle' && window.applyWebThemeStyle) window.applyWebThemeStyle(v);
    else if (el.id === 'wsAccent' && window.changeWebAccent) window.changeWebAccent(v);
    else if (el.id === 'wsBackground' && window.changeWebBackground) window.changeWebBackground(v);
    else return;

    // 外观三项互相联动：套预设会改掉强调色与背景，只改强调色会把风格变成「自定义组合」。
    // 所以它们任意一个变了都要重画外观面板 —— 否则旁边那两个下拉还停在旧值上，
    // 用户会以为改动没生效。
    if (el.id === 'wsThemeStyle' || el.id === 'wsAccent' || el.id === 'wsBackground') {
      selectPanel(state.activePanel);
      var again = byId(el.id);
      if (again) again.focus();
    }
  }

  function selectPanel(id, opts) {
    var target = null;
    for (var i = 0; i < PANELS.length; i++) {
      if (PANELS[i].id === id) target = PANELS[i];
    }
    if (!target) target = panelMeta('browse');
    state.activePanel = target.id;

    var page = byId('webSettingsPage');
    if (!page) return;
    var items = page.querySelectorAll('.web-settings-nav-item');
    for (var n = 0; n < items.length; n++) {
      var on = items[n].getAttribute('data-ws-panel') === target.id;
      items[n].classList.toggle('active', on);
      if (on && opts && opts.focus) items[n].focus();
    }
    var bodies = page.querySelectorAll('.web-settings-panel');
    for (var b = 0; b < bodies.length; b++) {
      var isOn = bodies[b].getAttribute('data-ws-panel-body') === target.id;
      bodies[b].classList.toggle('active', isOn);
      if (isOn) bodies[b].innerHTML = RENDERERS[target.id]();
    }
  }

  function renderAll() {
    var page = byId('webSettingsPage');
    if (!page) return;
    var bodies = page.querySelectorAll('.web-settings-panel');
    for (var b = 0; b < bodies.length; b++) {
      var id = bodies[b].getAttribute('data-ws-panel-body');
      if (id === state.activePanel) bodies[b].innerHTML = RENDERERS[id]();
    }
    // 说明条每次都整块重写：只在「有错」时写会留下一条过期的报错，
    // 之后读取恢复正常了它还挂在那儿。
    rewriteBanner(page);
  }

  function rewriteBanner(page) {
    var hint = page.querySelector('.web-settings-banner-text');
    if (!hint) return;
    hint.innerHTML = state.error
      ? '<b>读取桌面端设置失败：</b>' +
        esc(state.error) +
        '　下面「这台设备」的项目照常可改，其余项暂时显示不出来。'
      : BANNER_TEXT;
  }

  // ============================================================ 数据加载
  function loadSnapshot() {
    return fetch(API_SETTINGS, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.settings) throw new Error('响应里没有 settings');
        state.snapshot = data.settings;
        state.error = '';
      })
      .catch(function (e) {
        state.snapshot = state.snapshot || {};
        state.error = (e && e.message) || '未知错误';
      });
  }

  function loadRoots() {
    // 刻意**不清空** state.roots：重进设置页时先拿旧列表顶着，取回来再换，
    // 否则每次开设置页「相册目录」都会闪一下「正在读取」。
    return fetch(API_ROOT_FOLDERS, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (list) {
        state.roots = Array.isArray(list) ? list : [];
        state.rootsError = '';
      })
      .catch(function (e) {
        if (state.roots === null) state.roots = [];
        state.rootsError = '目录读取失败：' + ((e && e.message) || '未知错误');
      });
  }

  // ============================================================ 开关
  function openWebSettingsPage(panelId) {
    var page = byId('webSettingsPage');
    if (!page) return;
    mount();
    closeFilterSheetIfOpen();
    if (panelId) state.activePanel = panelId;
    page.hidden = false;
    state.open = true;
    // 骨架先上屏再取数：网络慢时至少能看到结构，不会是一片空白
    selectPanel(state.activePanel);
    renderAll();
    Promise.all([loadSnapshot(), loadRoots()]).then(function () {
      if (!state.open) return;
      renderAll();
      selectPanel(state.activePanel);
    });
  }

  function closeWebSettingsPage() {
    var page = byId('webSettingsPage');
    if (!page) return;
    page.hidden = true;
    state.open = false;
  }

  function closeFilterSheetIfOpen() {
    // 手机上「筛选与排序」抽屉可能与设置页同时开着，先收掉，避免两层叠在一起
    if (window.closeMobileFilterSheet) {
      try {
        window.closeMobileFilterSheet();
      } catch (e) {
        void e;
      }
    }
  }

  // 只导出真正有调用方的两个：HTML 内联 onclick 是本文件唯一的入口
  // （顶栏 `.header-settings-btn` 与抽屉里的 `.sheet-settings-link`）。
  // ⚠️ 别再顺手挂 `toggle` / `isOpen` 这类「以后可能有用」的全局 ——
  //    本项目对没调用方的导出是当死代码看的，而它又会悄悄和真实状态漂移。
  window.openWebSettingsPage = openWebSettingsPage;
  window.closeWebSettingsPage = closeWebSettingsPage;
})();
