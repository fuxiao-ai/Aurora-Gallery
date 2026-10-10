/**
 * 网页端「设置」页。
 *
 * ## 它是什么：只放**这台设备自己**的浏览偏好
 * 面板只剩两组，判据是「改了会不会影响当前这个浏览器怎么显示图片墙」：
 *   - **浏览与显示**：每页显示、网格与比例、卡片尺寸
 *   - **外观与行为**：界面风格、强调色、背景基调
 * 这些偏好本来就存在**浏览器本地**（桌面端存 `settings`，两端解耦），原先散在顶栏和
 * 「筛选与排序」抽屉里，这里只是给它们一个统一入口。
 *
 * ## 为什么**不再**是桌面端设置页的只读镜像（2026-10-06）
 * 用户要求「只保留浏览界面相关的、只影响网页显示的部分」。原先这里是桌面端 8 面板的逐位
 * 镜像（媒体库 / 浏览与显示 / 快捷键 / 媒体与存储 / 后台任务 / AI 与索引 / 外观与行为 /
 * 网络与远程），其中 6 个面板，加上其余面板里那一批「桌面端」取值行，全是网页端**既改不了、
 * 也不影响自己怎么显示**的内容 —— 占了 3/4 的界面，还让用户反复来问「为什么这里是灰的」。
 * 整块已删除，只留上面两组。
 * 🔴 桌面端只读快照接口 `/api/settings`（`main.js#buildWebSettingsSnapshot`）**刻意保留**：
 *    它是一份脱敏白名单，将来若有别的客户端要读，仍从这里取；网页端只是不再消费它。
 *    ⇒ 本文件不再 fetch 任何接口，`/api/root-folders` 同理。
 *
 * ## 依赖的全局（都由 app.js 挂到 window，本文件必须排在 app.js 之后加载）
 * `changePageSize` / `changeCardSizeTo` / `changeCardAspectMode` /
 * `applyWebThemeStyle` / `changeWebAccent` / `changeWebBackground` /
 * `closeMobileFilterSheet`
 */
(function () {
  'use strict';

  var state = {
    mounted: false,
    open: false,
    activePanel: 'browse',
  };

  // ============================================================ 面板定义
  // 只有两组，id 与名称沿用桌面端 `src/renderer/ui-settings.js` 的 navItems —— 它们是桌面端
  // 8 个面板里的两个（守护 `web-asset-route-regression` 第 ③ 组断言这层**子集 + 顺序**关系）。
  // ⚠️ 想再加面板之前先问一句：它改的是这台设备，还是桌面端？改桌面端的，一律不放这里。
  // ⚠️ 取某个面板的元信息一律走 panelMeta('id')，不要写 PANELS[<数字>]：
  //    2026-10-05 在中间插入「AI 与索引」时，硬索引让后面每个面板都顶上了别人的标题，
  //    而「面板顺序一致」那条对账照样是绿的（它只比名字列表，不看谁在用）。
  var PANELS = [
    {
      id: 'browse',
      icon: '\u{1F39E}\uFE0F',
      title: '浏览与显示',
      desc: '图片墙怎么排、每页放多少张。这些偏好存在这台设备的浏览器里，改完立刻生效，不影响其他设备。',
    },
    {
      id: 'appearance',
      icon: '\u{1F3A8}',
      title: '外观与行为',
      desc: '界面长什么样：一整套风格预设，以及可以单独调的两个维度 —— 强调色与背景基调。同样只影响这台设备。',
    },
  ];

  /** 顶部说明条的常态文案。比「只读」两个字更重要的是说清**这些偏好归谁管**。 */
  var BANNER_TEXT =
    '<b>这里的一切都只存在这台设备的浏览器里。</b>改完立刻生效，也不会同步到手机、平板或桌面端 —— ' +
    '所以你可以给手机设小卡片、给电脑设大卡片。';

  /** 卡片尺寸档位：与 app.js 的 `CARD_SIZE_TIERS` 同一组 basis，只多一层用户文案 */
  var CARD_TIER_LABELS = [
    { basis: 100, label: 'S（小）' },
    { basis: 140, label: 'M（中）' },
    { basis: 180, label: 'L（大）' },
    { basis: 320, label: 'XL（特大）' },
  ];

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
  function renderBrowse() {
    var panel = panelMeta('browse');
    var html = panelHead(panel);

    var rows = '';
    rows += controlRow({
      label: '每页显示',
      desc: '一屏最多放多少张。图片多的大目录调小一点更流畅。',
      control: selectHtml('wsPageSize', optionsFrom('pageSizeSelect', currentPageSize())),
    });
    rows += controlRow({
      label: '网格与比例',
      desc: '「原比例瀑布流」按每张图片自己的长宽比排；固定比例会让整面墙整齐但裁掉一部分。',
      control: selectHtml('wsCardAspect', optionsFrom('cardAspectSelect', currentCardAspect())),
    });
    rows += controlRow({
      label: '卡片尺寸',
      desc: '每张缩略图占多大。手机屏幕建议选小一点。',
      control: selectHtml('wsCardSize', cardSizeOptions(currentCardSize())),
    });
    html += group('', rows);

    html += group(
      '',
      note(
        '三项都是这台设备自己的偏好，互不影响 —— ' +
          '所以你可以给手机设小卡片、给电脑设大卡片，两边不会互相改。',
      ),
    );
    return html;
  }

  function renderAppearance() {
    var panel = panelMeta('appearance');
    var html = panelHead(panel);

    var rows = '';
    rows += controlRow({
      label: '界面风格',
      desc: '一整套配色预设。选「自定义组合」可以只改下面的强调色与背景基调。',
      control: selectHtml('wsThemeStyle', optionsFrom('webThemeStyle', currentThemeStyle())),
    });
    rows += controlRow({
      label: '强调色',
      desc: '按钮、选中态、链接用的主色。',
      control: selectHtml('wsAccent', optionsFrom('webAccentSelect', currentAccent())),
    });
    rows += controlRow({
      label: '背景基调',
      desc: '界面底色的冷暖与明暗，与上面的风格预设互相独立。',
      control: selectHtml('wsBackground', optionsFrom('webBackgroundSelect', currentBackground())),
    });
    html += group('', rows);

    html += group(
      '',
      note(
        '网页端的外观存在浏览器本地，与桌面端各存一份、互不覆盖 —— ' +
          '桌面端换了主题，不会把这个浏览器里选的风格改掉。',
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
    browse: renderBrowse,
    appearance: renderAppearance,
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
      esc('浏览与外观，改了只影响这台设备。') +
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

  // ============================================================ 开关
  function openWebSettingsPage(panelId) {
    var page = byId('webSettingsPage');
    if (!page) return;
    mount();
    closeFilterSheetIfOpen();
    if (panelId) state.activePanel = panelId;
    page.hidden = false;
    state.open = true;
    // 面板内容整块重画：控件取值一律现读 DOM（见「这台设备的当前取值」），
    // 所以没有需要预先 await 的东西 —— 原先前置拉 `/api/settings` 只为那份只读镜像，
    // 镜像已删（见文件头），这里不再有网络往返，打开即完整。
    selectPanel(state.activePanel);
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
