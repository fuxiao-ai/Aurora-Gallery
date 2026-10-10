'use strict';
/**
 * 底栏「网格与比例」控件回归（右下角「随机」按钮旁；与设置页 `#settingBrowseGridStyle` 同一取值域）。
 *
 * 为什么单独守：
 *   1. 这是**同一个状态的两个入口**（设置页一份下拉、底栏一份下拉）。两处各持一份读数时，
 *      下一次进设置页 hydrate 就会把旧值填回表单、保存时覆盖掉底栏的选择 —— 静默不一致。
 *      所以选项集合必须逐位相等，且都要等于 `utils.js` 的唯一真源。
 *   2. 它跟「卡片尺寸」不同：布局模式（`uniform` / `masonry`）是**渲染时**写进卡片 DOM 的
 *      （grid 元素上的 `data-use-media-ratio` 与 `grid--masonry`），只改 CSS 变量不够，
 *      改完必须重画当前页；但也**不该重查库**（结果集没变）。
 *   3. 与「每页数量」一样会写设置，写失败必须回滚 state 与读数，否则界面在说谎。
 *   4. 「控件建好了但没人接线」（HTML 有 id、UI 没绑定、AI 视图忘了收）不会报错，只会静默失灵。
 *
 * app.js 一上来就摸真实 DOM / electron，没法整体加载，因此按项目既有做法
 * （见 page-size-control-regression.js）从源码里抽函数、在 vm 里注入替身来跑行为。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 🔴 桩必须接**真 i18n 包**，不能「直接返回第三参兜底串」：
//    `changeBrowseGridStyle` 从 2026-10-08 起把失败提示改走
//    `tUiFmt('settings.gridStyleFailFmt', …)`。返回兜底串的桩会让中文那两条断言继续绿，
//    却把「英文包漏了这条 / 英文模板漏了 `{err}`」两个坏法整个盖住。
//    说明与实现与 `page-size-control-regression.js` 同款（同一次改动一起坏的两个守护）。
global.document = { documentElement: { setAttribute() {} }, querySelectorAll: () => [] };
global.window = global.window || {};
require('../src/renderer/i18n.js');
const I18n = global.window.I18n;

/** 按 locale 取**真词条**；键在两包都不存在时 `I18n.t()` 原样返回键 ⇒ 这里判红。 */
function i18nText(locale, key) {
  const previous = I18n.getLocale();
  I18n.setLocale(locale, { skipMainSync: true });
  const value = I18n.t(key);
  I18n.setLocale(previous, { skipMainSync: true });
  if (value == null || value === key) {
    throw new Error('i18n 键不存在：' + key + '（locale=' + locale + '）');
  }
  return String(value);
}

function extractFunction(source, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, '源码里找不到 ' + name);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 取某个 `@media` 块的**完整**块体。按括号配平扫描 —— 块里还有嵌套规则，
 *  用非贪婪正则会在第一条子规则的 `}` 处截断（那样「豁免写没写」就查不准了）。 */
function mediaBlock(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, '源码里找不到 ' + header);
  const open = source.indexOf('{', start);
  assert.ok(open > start, header + ' 没有块体');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(header + ' 的块体没有闭合');
}

/** 取一条 CSS 规则的声明体。`selectorRe` 要匹配到 `{` 之前的整段选择器列表，
 *  所以 `\.pagination-random` 不会误命中 `...random::before` / `...random:hover`（它们后面不是 `{`）。 */
function cssRuleBody(source, selectorRe) {
  const match = new RegExp(selectorRe + '\\s*\\{([^{}]*)\\}').exec(source);
  assert.ok(match, '源码里找不到规则：' + selectorRe);
  return match[1];
}

/** 用真实的 utils.js 取取值域与编解码，避免回归自己再写一份口径。 */
function loadRendererUtils() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/renderer/utils.js'), sandbox, { filename: 'utils.js' });
  return sandbox.RendererUtils;
}

/**
 * 加载 `ui-grid.js` 里的 `RendererPhotoGridUI` —— `renderPagination` 住在那里。
 * 为什么要在这里加载它：`browse-regression.js` 给 `renderPagination` 塞的是空函数替身
 * （`renderPagination() {}`），凡是内部逻辑它一概验不到；而「单页时随机按钮该不该禁用」
 * 恰恰只住在那一句顺序里。⚠️ 整个文件一起跑：模块级常量与同文件的
 * `generatePageNumbers` 都要在同一个 context 里。
 */
function loadPhotoGridUI() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.document = {
    createElement: () => ({ innerHTML: '', style: {}, appendChild() {}, firstChild: null }),
    // `renderPagination` 的成功路径会自己 `getElementById('pageNumbers')`（不走 options.dom），
    // 返回 null 就走它的既有守卫分支 —— 本回归只关心按钮可用性，不关心页码 DOM。
    getElementById: () => null,
  };
  vm.createContext(sandbox);
  // 🔴 真实页面里 utils.js 在 ui-grid.js **之前**加载（index.html 脚本顺序），
  //    而 ui-grid.js 的 `isLivePhotoStill` 会转发到 `RendererUtils`。
  //    沙箱里不喂 utils.js 就等于跑一份「页面上不可能存在」的环境 ——
  //    本回归目前只碰 `renderPagination`、碰不到那条转发，所以不会红，
  //    但下一个想在这里验角标的人会撞上一句莫名其妙的 TypeError。
  vm.runInContext(read('src/renderer/utils.js'), sandbox, { filename: 'utils.js' });
  vm.runInContext(read('src/renderer/ui-grid.js'), sandbox, { filename: 'ui-grid.js' });
  return sandbox.RendererPhotoGridUI;
}

function makeElement() {
  return { textContent: '', disabled: false, style: { display: '' } };
}
function makeSelect() {
  return { value: '', style: { display: '' } };
}

function makeHarness() {
  const utils = loadRendererUtils();
  const appSource = read('src/renderer/app.js');
  const log = { writes: [], alerts: [], loads: [], repaints: [], applies: 0 };

  const applied = {
    browsePageSize: 100,
    browseCardSize: 180,
    browseCardRatio: '1 / 1',
    browseThumbCrop: false,
    browseCardLayout: 'masonry',
    browseFolderIncludeSubfolders: true,
  };

  const context = {
    console,
    BROWSE_PAGE_SIZE_TIERS: utils.BROWSE_PAGE_SIZE_TIERS,
    snapBrowsePageSize: utils.snapBrowsePageSize,
    browsePageSizeTierIndex: utils.browsePageSizeTierIndex,
    // 归一与编解码直接借真源（app.js 里那两个只是转发，由静态断言单独钉）
    normalizeBrowseCardRatio: utils.normalizeBrowseCardRatio,
    normalizeBrowseCardLayout: utils.normalizeBrowseCardLayout,
    encodeBrowseGridStyleValue: utils.encodeBrowseGridStyleValue,
    parseBrowseGridStyleValue: utils.parseBrowseGridStyleValue,
    snapBrowseCardBasis: (n) => n,
    state: {
      currentTab: 'folders',
      pageSize: 100,
      page: 3,
      cardSize: 180,
      cardRatio: '1 / 1',
      cardLayoutMode: 'masonry',
      thumbCrop: false,
      _photoBrowseCacheResult: { total: 3 },
      browsePrefsApplied: { pageSize: 100 },
    },
    dom: {
      // 可见性挂在外层 field 上（标签要跟着一起收），读数在里面的 select 上。
      browseGridStyleControl: makeElement(),
      browseGridStyleSelect: makeSelect(),
      browsePageSizeSelect: makeSelect(),
      browseCardSizeSelect: makeSelect(),
    },
    api: {
      updateSettings(patch) {
        // 只留键名与原始值，别把 vm 那个 realm 的对象塞进断言（跨 realm 的 deepStrictEqual 必挂）
        log.writes.push({
          browseCardLayout: patch.browseCardLayout,
          browseCardRatio: patch.browseCardRatio,
        });
        if (context.__failNextWrite) {
          const error = context.__failNextWrite;
          context.__failNextWrite = null;
          return Promise.reject(error);
        }
        Object.assign(applied, patch);
        return Promise.resolve(Object.assign({}, applied));
      },
    },
    appAlert: (message) => log.alerts.push(String(message)),
    // 真包取词桩（见文件头）。`__locale` 是用例开关，默认中文；**刻意不用第三参兜底串**。
    __locale: 'zh-CN',
    tUi: (key) => i18nText(context.__locale || 'zh-CN', key),
    tUiFmt: (key, map) => {
      let text = i18nText(context.__locale || 'zh-CN', key);
      for (const name of Object.keys(map || {})) {
        text = text.split('{' + name + '}').join(String(map[name]));
      }
      return text;
    },
    loadPhotos: () => log.loads.push(context.state.page),
    applyCardSize() {
      log.applies += 1;
    },
    syncPageSizeControl() {},
    setBrowseAppliedSnapshotFromObject() {},
    paintBrowsePhotoGridShell() {
      log.repaints.push(context.state.currentTab);
    },
    // 只保留与本控件相关的半段语义：把设置里的布局 / 比例搬进 state，再回调 onApplyCardSize。
    settingsSync: {
      applyBrowsePreferencesFromSettings(options) {
        const s = options.settings;
        options.state.cardRatio = utils.normalizeBrowseCardRatio(s.browseCardRatio);
        options.state.cardLayoutMode = utils.normalizeBrowseCardLayout(s.browseCardLayout);
        if (typeof options.onApplyCardSize === 'function') options.onApplyCardSize();
      },
    },
  };

  vm.createContext(context);
  for (const name of [
    'syncBrowseGridStyleControl',
    'repaintBrowseGridAfterLayoutChange',
    'changeBrowseGridStyle',
  ]) {
    vm.runInContext(extractFunction(appSource, name), context);
  }
  return { context, utils, log, appSource };
}

const selectValue = (h) => h.context.dom.browseGridStyleSelect.value;

/** 从某段源码里抽出某个 `<select>` 的 option value 列表（按 DOM 顺序）。 */
function optionValuesOf(source, selectId) {
  const start = source.indexOf('id="' + selectId + '"');
  assert.ok(start > 0, 'index.html 里找不到 #' + selectId);
  const end = source.indexOf('</select>', start);
  assert.ok(end > start, '#' + selectId + ' 没有闭合标签');
  const seg = source.slice(start, end);
  return Array.from(seg.matchAll(/<option value="([^"]+)"/g)).map((m) => m[1]);
}

async function run() {
  const utils = loadRendererUtils();
  const html = read('src/renderer/index.html');
  const appSource = read('src/renderer/app.js');
  const eventsSource = read('src/renderer/ui-events.js');
  const navSource = read('src/renderer/ui-navigation.js');
  const aiSource = read('src/renderer/ai-views.js');
  const settingsSource = read('src/renderer/settings.js');
  const cssSource = read('src/renderer/styles.css');
  const webHtmlSource = read('src/web/index.html');
  const i18nSource = read('src/renderer/i18n.js');

  // ------------------------------------------------- 1. 取值域只有一份（utils.js）
  assert.equal(
    utils.BROWSE_CARD_RATIOS.join('|'),
    '1 / 1|3 / 4|4 / 3|9 / 16|16 / 9',
    '比例取值域只能有一份：utils.js 的 BROWSE_CARD_RATIOS',
  );
  for (const ratio of ['1 / 1', '3 / 4', '4 / 3', '9 / 16', '16 / 9']) {
    const encoded = utils.encodeBrowseGridStyleValue('uniform', ratio);
    assert.equal(encoded, 'uniform|' + ratio, '统一高度要编成 uniform|<比例>');
    const decoded = utils.parseBrowseGridStyleValue(encoded);
    assert.equal(decoded.layout, 'uniform');
    assert.equal(decoded.ratio, ratio, '编解码必须无损往返：' + ratio);
  }
  assert.equal(utils.encodeBrowseGridStyleValue('masonry', '16 / 9'), 'masonry', '瀑布流不带比例');
  const plainDecoded = utils.parseBrowseGridStyleValue('masonry');
  assert.equal(plainDecoded.layout, 'masonry');
  assert.equal(plainDecoded.ratio, null);
  assert.equal(
    utils.encodeBrowseGridStyleValue('weird-mode', '7 / 5'),
    'masonry',
    '认不出的模式退回瀑布流',
  );
  assert.equal(
    utils.parseBrowseGridStyleValue('uniform|7 / 5').ratio,
    '1 / 1',
    '表外比例收进 1:1，不能把脏值透传给设置',
  );

  // ------------------------------------------------- 2. 两处下拉的选项逐位一致，且等于真源
  const settingsOptions = optionValuesOf(html, 'settingBrowseGridStyle');
  const footerOptions = optionValuesOf(html, 'browseGridStyleSelect');
  assert.equal(
    footerOptions.join(' | '),
    settingsOptions.join(' | '),
    '底栏与设置页的选项必须逐位一致，否则同一个 state 会在两处显示不同读数',
  );
  assert.equal(settingsOptions[0], 'masonry', '首项是瀑布流（也是默认值）');
  assert.equal(
    settingsOptions.slice(1).map((v) => v.split('|')[1]).join('|'),
    utils.BROWSE_CARD_RATIOS.join('|'),
    '设置页下拉的比例列表要与 utils.BROWSE_CARD_RATIOS 逐位一致',
  );

  // ------------------------------------------------- 3. 行为：同值不写库
  let h = makeHarness();
  await h.context.changeBrowseGridStyle('masonry');
  assert.equal(h.log.writes.length, 0, '与当前一致就不该写库（否则每次点开就写一次磁盘）');
  assert.equal(h.log.repaints.length, 0, '没变化也不该重画');

  // ------------------------------------------------- 4. 行为：切到统一高度 16:9
  h = makeHarness();
  await h.context.changeBrowseGridStyle('uniform|16 / 9');
  assert.equal(h.log.writes.length, 1, '只写一次');
  assert.equal(h.log.writes[0].browseCardLayout, 'uniform');
  assert.equal(h.log.writes[0].browseCardRatio, '16 / 9');
  assert.equal(h.context.state.cardLayoutMode, 'uniform');
  assert.equal(h.context.state.cardRatio, '16 / 9');
  assert.equal(selectValue(h), 'uniform|16 / 9', '读数要显示当前生效的组合');
  assert.equal(h.log.repaints.length, 1, '布局变了要按当前页重画网格');
  assert.equal(h.log.loads.length, 0, '换布局不改变结果集，不该重查库');

  // ------------------------------------------------- 5. 行为：切回瀑布流要保留比例值
  h = makeHarness();
  h.context.state.cardLayoutMode = 'uniform';
  h.context.state.cardRatio = '16 / 9';
  h.context.dom.browseGridStyleSelect.value = 'uniform|16 / 9';
  await h.context.changeBrowseGridStyle('masonry');
  assert.equal(h.log.writes[0].browseCardLayout, 'masonry');
  assert.equal(
    h.log.writes[0].browseCardRatio,
    '16 / 9',
    '切回瀑布流要保留原比例 —— 再切回「统一高度」还要用它（设置页那份同语义）',
  );
  assert.equal(selectValue(h), 'masonry');

  // ------------------------------------------------- 6. 行为：写库失败要回滚 state 与读数
  h = makeHarness();
  h.context.__failNextWrite = new Error('settings locked');
  await h.context.changeBrowseGridStyle('uniform|4 / 3');
  assert.equal(h.context.state.cardLayoutMode, 'masonry', '失败要把布局退回上一个生效值');
  assert.equal(h.context.state.cardRatio, '1 / 1', '比例也要退回去');
  assert.equal(selectValue(h), 'masonry', '读数一起回滚，否则界面在说谎');
  assert.equal(h.log.alerts.length, 1, '失败必须说出来，不能静默');
  assert.match(h.log.alerts[0], /切换网格与比例失败/, '错误文案要能认人');
  assert.match(h.log.alerts[0], /settings locked/, '原始错误要留在文案里');
  assert.equal(h.log.repaints.length, 0, '没落库就不该重画');
  assert.equal(h.log.loads.length, 0, '没落库也不该重查');

  // ------------------------------------------------- 6b. 同一处失败在**英文界面**下的形态
  // 2026-10-08 起改走 `tUiFmt('settings.gridStyleFailFmt', { err }, '切换网格与比例失败：{err}')`。
  // 中文那两条断言测不出切语言的坏法（英文包漏这条会静默回落中文），所以把 locale 拨到 en 再走一遍。
  // ⚠️ 期望串**从真包派生**，刻意不钉英文措辞（改文案不用改守护）；坏法照样红，见 `page-size` 同段说明。
  h = makeHarness();
  h.context.__locale = 'en';
  h.context.__failNextWrite = new Error('settings locked');
  await h.context.changeBrowseGridStyle('uniform|4 / 3');
  assert.equal(h.log.alerts.length, 1, '英文界面同样要点出失败，不能静默');
  assert.equal(
    h.log.alerts[0],
    i18nText('en', 'settings.gridStyleFailFmt').split('{err}').join('settings locked'),
    '英文界面要弹英文模板（期望从真包派生，实得：' + h.log.alerts[0] + '）',
  );
  assert.match(h.log.alerts[0], /settings locked/, '英文模板里也必须带 {err}，否则说不出原因');
  assert.ok(
    !/[\u3400-\u9fff]/.test(h.log.alerts[0]),
    '英文界面不许露中文（含回落中文包的情形），实际：' + h.log.alerts[0],
  );
  assert.equal(h.context.state.cardLayoutMode, 'masonry', '英文路径同样要回滚布局');
  assert.equal(selectValue(h), 'masonry', '英文路径读数也要一起回滚');

  // ------------------------------------------------- 7. 重画只在浏览视图发生
  for (const tab of ['settings', 'duplicates']) {
    h = makeHarness();
    h.context.state.currentTab = tab;
    await h.context.changeBrowseGridStyle('uniform|1 / 1');
    assert.equal(
      h.log.repaints.length,
      0,
      'currentTab=' + tab + ' 时不能拿浏览页缓存去重画网格（那是另一批照片）',
    );
  }
  // 重复页会复用同名的 dom.photoGrid，而缓存里还是浏览页那一批 —— 这时也不能重画
  h = makeHarness();
  h.context.state.currentTab = 'folders';
  h.context.state.currentView = 'duplicates';
  await h.context.changeBrowseGridStyle('uniform|1 / 1');
  assert.equal(
    h.log.repaints.length,
    0,
    'currentView=duplicates 时不能拿浏览页缓存去重画（会把重复页内容顶掉）',
  );

  // ------------------------------------------------- 8. 静态契约：接线
  assert.match(html, /id="browseGridStyleSelect"/, '底栏要有这个控件');
  assert.match(
    appSource,
    /(?:^|\s)browseGridStyleSelect: \$\('#browseGridStyleSelect'\)/m,
    'dom 映射要有 browseGridStyleSelect',
  );
  assert.match(
    eventsSource,
    /bindSelectChange\('browseGridStyleSelect', options\.onBrowseGridStyleChange\)/,
    'ui-events 要把它接到 change 上（走 bindSelectChange 统一入口）—— 否则下拉永远不触发',
  );
  assert.match(eventsSource, /onBrowseGridStyleChange/, '绑定要用 onBrowseGridStyleChange');
  assert.match(appSource, /onBrowseGridStyleChange:/, 'app.js 要提供该回调');
  assert.match(appSource, /void changeBrowseGridStyle\(/, '回调要真的接到 changeBrowseGridStyle');
  // 三个下拉必须都接上（漏一个只会静默失灵：控件在、点它没反应）。
  for (const [selectId, handler] of [
    ['browseGridStyleSelect', 'onBrowseGridStyleChange'],
    ['browsePageSizeSelect', 'onBrowsePageSizeChange'],
    ['browseCardSizeSelect', 'onBrowseCardSizeChange'],
  ]) {
    assert.match(
      appSource,
      new RegExp('^\\s*' + handler + ':', 'm'),
      'app.js 要提供 ' + handler + ' 回调',
    );
    assert.match(
      eventsSource,
      new RegExp("bindSelectChange\\('" + selectId + "', options\\." + handler + '\\)'),
      selectId + ' 要接到 ' + handler,
    );
  }
  // 下线要干净：两个 −/+ 药丸的 id、读数与处理函数都不该再出现（幽灵按钮会「点不动」）。
  for (const dead of [
    'pageSizeDecBtn',
    'pageSizeIncBtn',
    'cardSizeDecBtn',
    'cardSizeIncBtn',
    'zoomLabel',
    'pageSizeLabel',
    'changeCardSize(',
    'onCardSizeDec',
    'onCardSizeInc',
    'onPageSizeDec',
    'onPageSizeInc',
  ]) {
    assert.ok(
      !appSource.includes(dead) && !eventsSource.includes(dead),
      '底栏换成下拉后不该再有 ' + dead,
    );
  }
  for (const dead of ['zoom-control', 'zoom-label']) {
    assert.ok(
      !cssSource.includes(dead),
      '桌面端 ' + dead + ' 药丸皮肤已下线（网页端那份在 web/index.html 里，另算）',
    );
  }

  // ------------------------------------------------- 9. 静态契约：位置与可见性
  const iRandom = html.indexOf('id="randomPageBtn"');
  const iGridField = html.indexOf('id="browseGridStyleControl"');
  const iGrid = html.indexOf('id="browseGridStyleSelect"');
  const iPage = html.indexOf('id="pageSizeControl"');
  const iZoom = html.indexOf('id="zoomControl"');
  assert.ok(iRandom < iGridField, '要落在「随机」按钮之后（随机旁的右下角）');
  assert.ok(
    iGridField < iGrid && iGrid < iPage && iPage < iZoom,
    '顺序：随机 · 网格与比例 · 每页数量 · 卡片尺寸（标签与下拉要在同一块里）',
  );
  assert.match(
    html.slice(iGridField, iGrid),
    /<label[\s\S]*?for="browseGridStyleSelect"/,
    '下拉前面要有可见标签，且 for 指向它自己',
  );
  // 三个控件「同形」：每个都是「外层 field（可见性挂点）+ 可见 label + select」。
  // 标签是这一版的核心诉求（此前每页数量 / 卡片尺寸只有一枚「100」「L」读数药丸，
  // 不点开不知道是什么），漏掉任何一个就又退回去。
  const FIELDS = [
    ['browseGridStyleControl', 'browseGridStyleSelect'],
    ['pageSizeControl', 'browsePageSizeSelect'],
    ['zoomControl', 'browseCardSizeSelect'],
  ];
  for (const [fieldId, selectId] of FIELDS) {
    const iField = html.indexOf('id="' + fieldId + '"');
    const iSelect = html.indexOf('id="' + selectId + '"');
    assert.ok(iField < iSelect, fieldId + ' 要包住 ' + selectId + '（可见性收的是外层 field）');
    const seg = html.slice(iField, iSelect);
    assert.match(
      seg,
      new RegExp('<label[\\s\\S]*?for="' + selectId + '"'),
      fieldId + ' 里的标签 for 要指向 ' + selectId,
    );
    assert.match(seg, /class="browse-footer-label"/, fieldId + ' 的标签要吃 .browse-footer-label');
    assert.match(
      html.slice(iSelect, iSelect + 400),
      /class="sort-select browse-footer-select/,
      selectId + ' 的皮肤要继承 select.sort-select（不能退回浏览器默认）',
    );
  }
  assert.match(
    navSource,
    /var ids = \[[^\]]*'browseGridStyleControl'[^\]]*\]/,
    '可见性唯一入口 setBrowseGridControlsVisible 要带上新控件（否则进集合页还留着半截底栏）',
  );
  assert.match(
    aiSource,
    /dom\.browseGridStyleControl\.style\.display = 'none'/,
    'AI 视图（搜图 / 人物）要收起它：那两页没有「按当前结果重画」的入口，留着会点了没反应',
  );
  assert.match(
    aiSource,
    /dom\.browseGridStyleControl\.style\.display = ''/,
    '离开 AI 视图要还原，否则回浏览页就再也看不到',
  );

  // ------------------------------------------------- 10. 静态契约：归一只有一份实现
  for (const name of [
    'normalizeBrowseCardRatio',
    'normalizeBrowseCardLayout',
    'encodeBrowseGridStyleValue',
    'parseBrowseGridStyleValue',
  ]) {
    const body = extractFunction(appSource, name);
    assert.match(
      body,
      new RegExp('RendererUtils\\.' + name),
      name + ' 必须转发到 utils.js 的唯一实现',
    );
    assert.ok(
      !/'1 \/ 1'/.test(body) && !/'16 \/ 9'/.test(body),
      name + ' 里不该再出现比例字面量 —— 那等于又开了一份取值域',
    );
  }
  assert.ok(
    !/BROWSE_GRID_STYLE_RATIOS/.test(settingsSource),
    'settings.js 不该再留自己那份比例表（已收敛到 utils.js 的 BROWSE_CARD_RATIOS）',
  );
  assert.match(
    settingsSource,
    /RendererUtils\.BROWSE_CARD_RATIOS/,
    'settings.js 的兜底也要指向真源',
  );

  // ------------------------------------------------- 11. 静态契约：文案复用设置页的词条
  const zhCodes = (i18nSource.match(/'footer\.gridStyleTitle'/g) || []).length;
  const zhAria = (i18nSource.match(/'footer\.gridStyleAria'/g) || []).length;
  assert.equal(zhCodes, 2, 'footer.gridStyleTitle 要中英各一条');
  assert.equal(zhAria, 2, 'footer.gridStyleAria 要中英各一条');
  assert.match(
    html,
    /<option value="uniform\|16 \/ 9" data-i18n="settings\.browse\.grid\.opt\.u169"/,
    '选项文案要复用设置页的 i18n 词条，不另写一份',
  );

  // ------------------------------------------------- 12. 静态契约：底栏下拉的尺寸修饰
  assert.match(cssSource, /\.browse-footer-select\s*\{/, 'CSS 里要有底栏下拉的宽度修饰');
  assert.match(
    html,
    /class="sort-select browse-footer-select"/,
    '皮肤继承 select.sort-select（与设置页同一个类），修饰类只管尺寸',
  );

  // 高度必须跟**同一排的邻居**同源。这一排左右都是 `height: var(--browse-bar-control-h, 36px)`
  // 的按钮（「随机」与分页），三个下拉若沿用设置页那档 30px，并排时就会矮一截、底边不齐
  // —— 实测 36 vs 30，肉眼一眼能看出「这几个控件不是一家的」。
  // 用同一条变量而不是再写一个 36px：窄屏那一档 `--browse-bar-control-h` 会降到 32px，
  // 写死的话窄屏又只剩下拉不跟着缩。
  const footerRuleStart = cssSource.lastIndexOf('.browse-footer select.sort-select');
  assert.ok(footerRuleStart > 0, '找不到 .browse-footer select.sort-select 这条独立规则');
  const footerRuleOpen = cssSource.indexOf('{', footerRuleStart);
  assert.equal(
    cssSource.slice(footerRuleStart, footerRuleOpen).trim(),
    '.browse-footer select.sort-select',
    '夹具自证：要取到那条独立规则，而不是共享选择器列表里的同名一项',
  );
  const footerRule = cssSource.slice(footerRuleOpen + 1, cssSource.indexOf('}', footerRuleOpen));
  assert.ok(
    !/min-height:\s*30px/.test(footerRule),
    '底栏这一条不该再留设置页的 30px（会被下面的 height 顶着，看着像没生效）',
  );
  for (const prop of ['height', 'min-height']) {
    assert.match(
      footerRule,
      new RegExp(prop + ':\\s*var\\(--browse-bar-control-h, 36px\\)'),
      '底栏下拉的 ' + prop + ' 要用 --browse-bar-control-h（与「随机」/ 分页按钮同源）',
    );
  }
  // 「同源」得有据可依：这条变量确实就是邻居按钮的高度。
  assert.match(
    cssSource,
    /\.browse-footer-actions \.pagination-random\s*\{[\s\S]*?height:\s*var\(--browse-bar-control-h, 36px\)/,
    '「随机」按钮的高度就是这条变量 —— 底栏下拉必须跟着它，不能各写一个 36px',
  );
  assert.match(
    cssSource,
    /\.pagination button\s*\{[\s\S]*?height:\s*var\(--browse-bar-control-h, 36px\)/,
    '分页按钮同理（这一排三处都是同一个高度）',
  );
  // 设置页那一栏没有邻居要对齐，保持 30px 紧凑档 —— 别顺手把它也撑高。
  const settingsRuleStart = cssSource.indexOf('.settings-page select.sort-select {');
  assert.ok(settingsRuleStart > 0, '找不到 .settings-page select.sort-select 这条独立规则');
  const settingsRule = cssSource.slice(
    settingsRuleStart,
    cssSource.indexOf('}', settingsRuleStart),
  );
  assert.ok(
    !/--browse-bar-control-h/.test(settingsRule),
    '设置页下拉不该跟着底栏长高（那里是紧凑档 30px，没有邻居要对齐）',
  );
  assert.match(
    cssSource,
    /\.settings-page select\.sort-select,\s*\n\.browse-footer select\.sort-select\s*\{[\s\S]*?min-height:\s*30px[\s\S]*?font-size:\s*12px[\s\S]*?border-radius:\s*9px/,
    '两处仍共用一批皮肤声明（字号 12px / 圆角 9px / 基准 30px），底栏只是把高度覆写掉',
  );

  // ── 底栏「随机」按钮的可用性（2026-10-05）──────────────────────────────────
  // 🔴 `#randomPageBtn` **不在 `.pagination` 里**，它是 `.pagination` 的兄弟节点（在
  //    `.browse-footer-actions` 里）。所以 `renderPagination()` 里那句
  //    `dom.pagination.style.display = 'none'` **收不起它** —— 只要「总页数 ≤ 1 就早退」
  //    写在 `randomPageBtn.disabled` 赋值之前，单页时就会留下一个「看着能点、点了没反应」
  //    的按钮（`goToRandomPage()` 对 `tp <= 1` 是静默 `return`，连提示都没有）。
  //    按钮本身很显眼（实心强调色 + 图标），假可点击性比不突出更糟，所以这里钉住它。
  //    只换 dom 替身、调真实函数 —— 断言的是**行为**，不是源码里两句话的先后顺序。
  const gridUI = loadPhotoGridUI();
  const mkEl = () => ({ textContent: '', disabled: false, style: { display: '' } });
  {
    const btn = mkEl();
    const pagination = mkEl();
    gridUI.renderPagination({
      dom: { pagination, pageInfo: mkEl(), prevPage: mkEl(), nextPage: mkEl(), randomPageBtn: btn },
      result: { totalPages: 1, total: 8, page: 1 },
      formatNumber: (n) => String(n),
    });
    assert.equal(pagination.style.display, 'none', '单页时分页条要收起');
    assert.equal(
      btn.disabled,
      true,
      '单页时「随机」必须禁用（`goToRandomPage()` 对 tp<=1 静默 return，不禁用就是假可点击）',
    );
  }
  {
    const btn = mkEl();
    gridUI.renderPagination({
      dom: {
        pagination: mkEl(),
        pageInfo: mkEl(),
        prevPage: mkEl(),
        nextPage: mkEl(),
        randomPageBtn: btn,
      },
      result: { totalPages: 5, total: 400, page: 2 },
      formatNumber: (n) => String(n),
    });
    assert.equal(btn.disabled, false, '多页时「随机」必须可用 —— 反面：别把禁用写死');
  }

  // ── 「随机」的闪动光晕（2026-10-05；2026-10-06 去掉扩散环）──────────────────
  // 这一节钉的是**动效骨架**而不是像素。每一类断言都对应一个「静态全绿、线上失效」的坑：
  //   ① 动画若挂在按钮本体上 → 动画来源层压过普通声明，hover / :active / :disabled
  //      那三条 `box-shadow` 会**静默失效**（computed 值还看着挺合理，review 抓不到）；
  //   ② 伪元素少了 `pointer-events: none` → 一层透明壳盖在按钮上，看着能点、其实点不动；
  //   ③ 少了 `position: relative` → 伪元素挂到别的定位祖先上（桌面端这个按钮**不在** `.pagination`
  //      里，`.pagination button` 那族什么都给不到它）；
  //   ④ `:disabled` 不停掉 → 一个正在闪、却点不动的按钮（假可点击性，与上面那条同一契约）；
  //   ⑤ reduced-motion 块里不豁免 → 本机实测就是 `reduce`，这套光晕**一次都看不见**，等于白做；
  //   ⑥ 🔴 **扩散环必须不存在**（2026-10-06 新增，钉的是一次真实事故）：
  //      它动的是 `box-shadow`，而 `box-shadow` 的插值**无法被提升为合成动画** ——
  //      实测给它加 `will-change: opacity,transform` 或 `transform: translateZ(0)` 都**零效果**
  //      ⇒ 只能每帧回主线程重算样式 + 重绘。隔离库 / 60 张卡 / 1000ms 稳态实测：
  //      基线 Paint 122 次·27.75ms + StyleRecalc 61 次·11.15ms，**全部来自这一条**
  //      （只停呼吸层则读数一点不变：122 次·26.15ms）；停掉扩散环后两项**双双归零**（6 轮零方差），
  //      而「从首页/设置页进入照片流」动作窗口的 Paint 耗时从 64.15ms 掉到 18.9ms（−71%）。
  //      用户反馈的「点首页返回卡顿」正是它叠在网格恢复那 25ms 上、把一帧顶过预算。
  //      ⇒ 谁把它加回来（桌面端或网页端任一侧），这一节必须红。
  //      ⚠️ 描述删除时**不要把关键帧名原样写进注释**：`cssRuleBody` 不剥注释，
  //         下面「不许存在」的两条断言是直接对原文做正则的，注释会把自己喂饱（假绿）。
  const glowShared = cssRuleBody(
    cssSource,
    '\\.browse-footer-actions \\.pagination-random::before',
  );
  for (const prop of [
    'position:\\s*absolute',
    'inset:\\s*0',
    'border-radius:\\s*inherit',
    'pointer-events:\\s*none',
  ]) {
    assert.match(
      glowShared,
      new RegExp(prop),
      '呼吸光晕的声明里缺 `' +
        prop +
        '` —— 尤其 pointer-events 一缺就是「看着能点、点不动」',
    );
  }
  assert.match(
    glowShared,
    /opacity:\s*0\.\d+/,
    '呼吸层必须留**静态兜底**不透明度：动画被 reduced-motion 压掉后 fill-mode 默认 none 会回落到它，' +
      '不给值就回落成 1 = 最亮峰值（「关掉动画反而比开着更刺眼」，实测过）',
  );
  assert.match(
    glowShared,
    /animation:\s*randomBtnGlowBreathe\b/,
    '呼吸层的动画要写在这一条规则里（拆到别处就等于不生效）',
  );
  const randomBtnRule = cssRuleBody(cssSource, '\\.browse-footer-actions \\.pagination-random');
  assert.match(
    randomBtnRule,
    /position:\s*relative/,
    '「随机」按钮要建立定位上下文，否则两层光晕挂到别人身上（它不在 .pagination 里，继承不到任何东西）',
  );
  assert.ok(
    !/animation\s*:/.test(randomBtnRule),
    '动画绝不能挂在按钮本体上：动画来源层压过普通声明，会静默吃掉 hover / :active / :disabled 三条 box-shadow',
  );
  // 呼吸关键帧既要**定义**，也要真的被引用（「定义了没人用」= 静默失效，光晕根本不会动）；
  // 同时钉死扩散环的**缺席**（⑥）。
  for (const [label, source] of [
    ['桌面端', cssSource],
    ['网页端', webHtmlSource],
  ]) {
    assert.match(
      source,
      /@keyframes randomBtnGlowBreathe\b/,
      label + '要有关键帧 randomBtnGlowBreathe',
    );
    assert.match(
      source,
      /animation:\s*randomBtnGlowBreathe\b/,
      label + '的 randomBtnGlowBreathe 必须被真的引用（只定义不引用 = 光晕不会动）',
    );
    assert.ok(
      !/@keyframes\s+randomBtnGlowPing\b/.test(source),
      label +
        ' 不得定义扩散环关键帧 randomBtnGlowPing：它动 box-shadow，无法被提升为合成动画，' +
        '实测每秒 122 次重绘 / 27.75ms 全部来自它（停掉后归零）。要动效就换可合成属性，别加回来。',
    );
    assert.ok(
      !/animation:\s*randomBtnGlowPing\b/.test(source),
      label + ' 不得引用 randomBtnGlowPing（同一条理由；留着没人用也一样是隐患）',
    );
  }
  assert.match(
    cssRuleBody(
      cssSource,
      '\\.browse-footer-actions \\.pagination-random:disabled::before',
    ),
    /display:\s*none/,
    '禁用态要**整个摘掉**呼吸光晕（压暗不行：还在闪就仍然是「这里能点」的暗示）',
  );
  // reduced-motion：两端各留一份豁免，且与桌面端逐条对应。
  for (const [label, source, sel] of [
    ['桌面端', cssSource, '\\.browse-footer-actions \\.pagination-random::before'],
    ['网页端', webHtmlSource, '#randomPageBtn::before'],
  ]) {
    const block = mediaBlock(source, '@media (prefers-reduced-motion: reduce)');
    assert.match(
      block,
      new RegExp(sel),
      label +
        ' 的 reduced-motion 块里要豁免呼吸光晕（本机实测 reduce，不豁免这套动效一次都看不见）',
    );
    // 🔴 下面两条必须取**这条豁免规则自己的**声明体，不能拿整个 `@media` 块去 match：
    //    同一个块里还有加载圈那条 `animation-iteration-count: infinite !important`，
    //    拿整块匹配会**永远为真** —— 牙齿测试实测过（把豁免的 iteration-count 删掉照样全绿）。
    const decl = cssRuleBody(block, sel);
    assert.match(
      decl,
      /animation-duration:\s*2\.6s\s*!important/,
      label + ' 的豁免要把 duration 放回动画周期（留着 0.01ms 仍然一动不动）',
    );
    assert.match(
      decl,
      /animation-iteration-count:\s*infinite\s*!important/,
      label + ' 的豁免要把 animation-iteration-count 一起放回 infinite（只放 duration 仍只跑一轮）',
    );
  }
  // 网页端特有的两点：按钮是**药丸形**（继承 `.pagination button` 的 `border-radius: 999px`），
  // 圆角只能靠 inherit（写死会在药丸两端露出方角光晕）；且那份基础样式没有 `position`。
  const webGlowShared = cssRuleBody(webHtmlSource, "#randomPageBtn::before");
  assert.match(webGlowShared, /pointer-events:\s*none/, '网页端伪元素同样要 pointer-events: none');
  assert.match(webGlowShared, /border-radius:\s*inherit/, '网页端药丸形按钮的圆角只能靠 inherit');
  const webRandomBtnRule = cssRuleBody(webHtmlSource, '#randomPageBtn');
  assert.match(webRandomBtnRule, /position:\s*relative/, '网页端 `.pagination button` 没有 position，必须自己写');
  assert.ok(
    !/animation\s*:/.test(webRandomBtnRule),
    '网页端动画同样不许挂在按钮本体上（会吃掉 :hover / :active 的 box-shadow）',
  );

  // ── 「随机」的**表面**光晕（2026-10-05 第二轮）───────────────────────────────
  // 上一节是「外圈」（伪元素：呼吸 + 扩散），这一节是**按钮表面自己**的发光：
  //   A 顶部透光 = `background-image` 的径向渐变（光从上方渗进来）
  //   B 四周内圈光 = `box-shadow` 里的 `inset` 段（只照边缘一圈，够不到文字）
  // 它必须待在本体的背景/box-shadow 通道里，于是派生出四条**静默失效**，逐条钉住：
  //   ① A 在 `background-image` 上 ⇒ 同族四处只能写 `background-color`。哪一处退回
  //      `background` 简写，就会按隐含默认值把 A 一起重置（background-image → none）：
  //      hover 时表面辉光凭空消失，不报错、不写日志，静态看还挺正常 —— 这就是本项目的元规则；
  //   ② B 是 `box-shadow` 的一段 ⇒ box-shadow 整体覆盖不继承，hover / :active 各自重写时
  //      必须把它续上；漏了就是「一划过表面光晕跳掉」；
  //   ③ `:disabled` 里那句 `box-shadow: none` **管不到** background-image：
  //      不显式写 `background-image: none`，禁用按钮上还浮着一层发光（假可点击性）；
  //   ④ 两端各有一份独立实现 ⇒ 参数必须逐字对齐，否则同一个按钮两边长得不一样。
  const hoverRule = (source, selectorRe) => cssRuleBody(source, selectorRe);
  const noShorthandBackground = (body) => /(^|[;\s])background\s*:/.test(body);
  const surfaceGlowCases = [
    ['桌面端常态', randomBtnRule, 10, cssSource],
    [
      '桌面端 hover',
      hoverRule(cssSource, '\\.browse-footer-actions \\.pagination-random:hover:not\\(:disabled\\)'),
      14,
      cssSource,
    ],
    [
      '桌面端 :active',
      hoverRule(cssSource, '\\.browse-footer-actions \\.pagination-random:active:not\\(:disabled\\)'),
      10,
      cssSource,
    ],
    ['网页端常态', webRandomBtnRule, 10, webHtmlSource],
    [
      '网页端 hover',
      hoverRule(webHtmlSource, '#randomPageBtn:hover:not\\(:disabled\\)'),
      14,
      webHtmlSource,
    ],
    [
      '网页端 :active',
      hoverRule(webHtmlSource, '#randomPageBtn:active:not\\(:disabled\\)'),
      10,
      webHtmlSource,
    ],
  ];
  for (const [label, body, blur, source] of surfaceGlowCases) {
    assert.ok(
      !noShorthandBackground(body),
      label +
        '：表面光晕 A 挂在 `background-image` 上，这条规则的底色只能写 `background-color` —— ' +
        '退回 `background` 简写会按隐含默认值把它重置掉，表面辉光静默消失',
    );
    // ⚠️ 只有常态与 hover 会重写底色，`:active` 只改 transform / box-shadow ——
    //    对 :active 也要求 `background-color` 是过严（它压根不碰背景那条通道）。
    if (/常态$|hover$/.test(label)) {
      assert.match(
        body,
        /background-color\s*:/,
        label + ' 要有 `background-color`（表面光晕的底）',
      );
    }
    assert.match(
      body,
      new RegExp('inset\\s+0\\s+0\\s+' + blur + 'px'),
      label +
        ' 的 box-shadow 缺表面光晕 B（`inset 0 0 ' +
        blur +
        'px`）—— box-shadow 是整体覆盖，漏一处就「一划过/一按下表面光晕跳掉」',
    );
    // ① 那条「两端逐字对齐」的护栏：渐变几何与强度都必须是同一份。
    if (label.endsWith('常态')) {
      assert.match(
        source,
        /radial-gradient\(\s*130%\s+78%\s+at\s+50%\s+-18%/,
        label +
          ' 的顶部透光几何是刻意选的（辉光中心在盒外 -18%，文字区才只吃到一两成）—— 两端必须同一份',
      );
      assert.match(
        body,
        /background-image\s*:\s*radial-gradient/,
        label + ' 要真的有表面光晕 A（background-image）',
      );
    }
  }
  // ③ `:disabled` 必须把 A 显式摘掉（两端各一条，选择器写法不同但语义相同）。
  for (const [label, source, selectorRe] of [
    ['桌面端', cssSource, '\\.browse-footer-actions \\.pagination-random:disabled'],
    ['网页端', webHtmlSource, '#randomPageBtn:disabled'],
  ]) {
    assert.match(
      cssRuleBody(source, selectorRe),
      /background-image\s*:\s*none/,
      label +
        ' 的禁用态要显式 `background-image: none` —— 那句 `box-shadow: none` 管不到表面光晕 A，' +
        '漏了禁用按钮上还浮着一层发光（假可点击性）',
    );
  }

  // ── 原比例瀑布流里「没有缩略图」时占位必须是正方形（2026-10-05）──────────────
  // 🔴 为什么单独守：瀑布流是 `columns` 布局，卡片**没有** CSS 给死的高度。有缩略图时高度来自
  //    `<img>` 的 width/height 内在尺寸（`markLoaded` 还照 naturalWidth 补写一次 aspect-ratio），
  //    没有缩略图时占位块自身没有基准尺寸（它是 `height: 100%` 的空盒子）⇒ 卡片塌成一条
  //    比文字还矮的横杠、整列跟着错位。
  //    而「统一高度」那档因为 `.grid:not([data-use-media-ratio='1']) .photo-card` 给了死比例，
  //    **完全正常** —— 于是这个缺陷只在瀑布流上现身，很容易被「换个布局看看，没事啊」带过去。
  //    塌陷有两条互相独立的路径，都得钉：
  //      ① 构建期就知道没有缩略图（`has_thumbnail` 为假）→ `buildSinglePhotoCardHtml`；
  //      ② 构建期有、跑起来才 404（缩略图文件被删/损坏）→ 只有真实 error 事件驱动得到。
  //    第一条喂真函数看真 HTML，第二条用 error 事件打真的 `bindGridImageProgress`。
  const SQUARE_PLACEHOLDER_CLASS = 'photo-card--square-placeholder';

  /** 从整段网格 HTML 里取出某张卡片附近的片段（按 data-photo-id 定位，容忍属性顺序变化）。 */
  function cardWindow(html, id) {
    const i = html.indexOf('data-photo-id="' + id + '"');
    assert.ok(i >= 0, '夹具自证：HTML 里应能找到 data-photo-id=' + id + ' 那张卡片');
    return html.slice(Math.max(0, i - 160), i + 160);
  }

  /** 喂真实的 `renderPhotoGrid`，返回渲染出的 HTML 与挂在容器上的读数。 */
  function renderOnePhoto(photo, useMediaRatio) {
    const el = { innerHTML: '', dataset: {}, querySelectorAll: () => [] };
    gridUI.renderPhotoGrid({
      dom: { photoGrid: el },
      photos: [photo],
      useMediaRatio,
      mediaFilter: 'all',
      escapeHtml: (s) => String(s),
      escapeAttr: (s) => String(s),
      truncate: (s) => String(s),
      formatDateTime: () => '',
      formatNumber: (n) => String(n),
      normalizePath: (p) => p,
      subfolderSummaries: [],
      onApplyCardSize() {},
    });
    return el;
  }

  /**
   * 驱动真实的 `bindGridImageProgress` 走它自己那条失败分支 —— 靠 `img.complete` +
   * `naturalWidth` 触发，不手抄 `markFailed` 的语句（抄一遍就测不到它）。
   * `inserted` 接住它 `insertBefore` 进来的兜底占位节点，好让本回归能直接比对这个节点
   * 与网页端同一条路径产出的节点（「统一占位图」的跨端对账就靠它）。
   */
  function driveThumbEvent(opts) {
    const classes = new Set();
    let removed = false;
    let inserted = null;
    const card = {
      classList: {
        add: (c) => classes.add(c),
        contains: (c) => classes.has(c),
      },
      querySelector: () => null,
      insertBefore: (node) => {
        inserted = node;
      },
      firstChild: null,
      style: {},
    };
    const img = {
      dataset: {},
      classList: { add() {}, remove() {} },
      closest: () => card,
      remove() {
        removed = true;
      },
      addEventListener() {},
      complete: true,
      naturalWidth: opts.naturalWidth,
      naturalHeight: opts.naturalHeight,
    };
    gridUI.bindGridImageProgress({
      dataset: { useMediaRatio: opts.masonry ? '1' : '0' },
      querySelectorAll: () => [img],
    });
    return { classes, removed, card, inserted };
  }

  {
    const noThumb = {
      id: 7717,
      file_name: 'no-thumb.NEF',
      file_type: 'NEF',
      has_thumbnail: 0,
      date_taken: '2026-01-01 00:00:00',
    };
    const masonry = renderOnePhoto(noThumb, true);
    assert.equal(masonry.dataset.useMediaRatio, '1', '夹具自证：这一跑确实是原比例瀑布流');
    // 夹具自证要盯着真正的标记，不能盯着类名 —— `photo-card--square-placeholder` 里也含
    // "placeholder" 这个词，用 `/placeholder/` 去验「走的是占位分支」会**因为被断言的东西
    // 本身而恒真**（牙齿测试实测：把兜底类删掉，这条自证反而先红，说明它验的是别的东西）。
    assert.ok(
      !/class="loading grid-thumb"/.test(masonry.innerHTML),
      '夹具自证：这张卡片确实没有 <img class="loading grid-thumb">（走的是占位分支）',
    );
    assert.match(
      masonry.innerHTML,
      /<div class="placeholder[ "]/,
      '夹具自证：占位块本身要真的渲染出来',
    );
    assert.match(
      cardWindow(masonry.innerHTML, 7717),
      new RegExp(SQUARE_PLACEHOLDER_CLASS),
      '瀑布流 + 没有缩略图 → 卡片必须是正方形占位（占位块没有内在尺寸，不给比例就塌成一条）',
    );

    // 反面一：有缩略图时高度来自图片自身，别把这条兜底乱扣上去。
    const withThumb = renderOnePhoto(Object.assign({}, noThumb, { has_thumbnail: 1 }), true);
    assert.ok(
      !new RegExp(SQUARE_PLACEHOLDER_CLASS).test(cardWindow(withThumb.innerHTML, 7717)),
      '有缩略图的卡片不该被扣上正方形占位类（那会把用户的原比例图裁成方的）',
    );
    // 反面二：统一高度那档由 CSS 给死比例，同样不需要这个类。
    const uniform = renderOnePhoto(noThumb, false);
    assert.equal(uniform.dataset.useMediaRatio, '0', '夹具自证：这一跑是统一高度');
    assert.ok(
      !new RegExp(SQUARE_PLACEHOLDER_CLASS).test(cardWindow(uniform.innerHTML, 7717)),
      '统一高度那档由 .grid:not([data-use-media-ratio="1"]) 给死比例，不该再挂这个类',
    );
  }

  {
    // ② 运行期路径：缩略图文件缺失（驱动函数见上面的 `driveThumbEvent`）。
    const failedMasonry = driveThumbEvent({ masonry: true, naturalWidth: 0, naturalHeight: 0 });
    assert.equal(failedMasonry.removed, true, '夹具自证：确实走了「加载失败」那条路（图被摘掉）');
    assert.ok(
      failedMasonry.classes.has(SQUARE_PLACEHOLDER_CLASS),
      '瀑布流里缩略图 404 时卡片必须退回正方形占位 —— 图一摘就没了唯一的定高依据',
    );

    const failedUniform = driveThumbEvent({ masonry: false, naturalWidth: 0, naturalHeight: 0 });
    assert.equal(failedUniform.removed, true, '夹具自证：统一高度这跑同样走了失败路径');
    assert.ok(
      !failedUniform.classes.has(SQUARE_PLACEHOLDER_CLASS),
      '统一高度那档有 CSS 死比例，失败时不需要这个类',
    );

    // 正向对照：图加载成功时高度来自图片本身，正方形兜底与它互斥（两者都不该同时发生）。
    const loaded = driveThumbEvent({ masonry: true, naturalWidth: 1600, naturalHeight: 1200 });
    assert.equal(loaded.removed, false, '夹具自证：这一跑走的是加载成功那条路');
    assert.equal(
      loaded.card.style.aspectRatio,
      '1600 / 1200',
      '加载成功时瀑布流卡片的高度来自图片内在尺寸 —— 正方形兜底正是补这条的缺席',
    );
    assert.ok(
      !loaded.classes.has(SQUARE_PLACEHOLDER_CLASS),
      '加载成功不该被扣上正方形占位类',
    );
  }

  // 这条类只是「换个形状」，形状本身写在 CSS 里，所以两端都要求那条规则真的在。
  for (const [label, source] of [
    ['桌面端 styles.css', cssSource],
    ['网页端 index.html', webHtmlSource],
  ]) {
    assert.match(
      cssRuleBody(source, '\\.grid\\.grid--masonry \\.' + SQUARE_PLACEHOLDER_CLASS),
      /aspect-ratio:\s*1\s*\/\s*1/,
      label + ' 要有 `.grid.grid--masonry .' + SQUARE_PLACEHOLDER_CLASS + '{ aspect-ratio: 1 / 1 }`',
    );
  }
  // 网页端也有两条路：构建期没有缩略图（`has_thumbnail = 0`）现在直接出占位图，不再去请求那个
  // 必然 404 的 `/thumb`；但「构建期有、跑起来文件没了」仍只有 markFailed 抓得到，所以那条
  // 更要钉住：漏了它网页端就只剩塌陷。
  assert.match(
    extractFunction(read('src/web/js/app.js'), 'bindGridImageProgress'),
    new RegExp("classList\\.add\\('" + SQUARE_PLACEHOLDER_CLASS + "'\\)"),
    '网页端 bindGridImageProgress 的失败分支也要挂正方形占位类',
  );
  assert.match(
    extractFunction(read('src/web/js/app.js'), 'bindGridImageProgress'),
    /closest\(['"]\.grid--masonry['"]\)/,
    '网页端的判断必须用 closest —— `.grid--masonry` 是 #photoGrid 的**子节点**，挂在 root 上那层没有这个类',
  );

  // ── 列宽只由容器宽度决定，不许按「卡片张数」改列数（2026-10-09）──────────────────
  // 🔴 用户原话：「当某个文件夹或标签少于一排照片时，不要将图片占据所有宽度，保持和多图时一样宽度」。
  //    成因是两端各有一个 `capMasonryColumns()`：瀑布流档下若「卡片数 < 可容纳列数」，就把
  //    `grid.style.columnCount` 压成**卡片数**，让这几张图摊满整行。实测（桌面 1440 窗、
  //    basis 180 / gap 12）：2 张 = 513px、3 张 = 338px、6 张 = 198px、14 张 = 195px ——
  //    少图时卡片宽了近 2.6 倍。删掉之后 1/2/3/6 张一律 198px，且单张仍落在**第一列**。
  //    ⚠️ 顺带解掉同一处 `ResizeObserver` 自反馈环（回调里改 `columnCount`，
  //    console 反复刷 `ResizeObserver loop completed with undelivered notifications`，
  //    `CONTRACTS.md`「本轮未修」那条）—— 写者没了，观察者也就没有存在理由，一起删了。
  //
  // 判据分两半，缺一条就会变成假绿：
  //   ① 反向：两端的列布局代码里**不许再出现**按张数压列（`capMasonryColumns` / `columnCount`）；
  //   ② 正向：列宽必须仍然由 CSS 给（`columns: calc(var(--grid-card-basis) * 1px)`），
  //      否则「不压列」也可能退化成「根本没有列宽规则」。
  // ① 必须先剥注释（CONTRACTS 元规则③）：两处删除点都留了同名的历史说明注释，
  //    不剥就会拿注释里的字样判红。
  const stripJsComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const [label, rel] of [
    ['桌面端 renderer/app.js', 'src/renderer/app.js'],
    ['网页端 web/js/app.js', 'src/web/js/app.js'],
  ]) {
    const code = stripJsComments(read(rel));
    assert.ok(
      !/capMasonryColumns/.test(code),
      label + ' 里 `capMasonryColumns` 又回来了 —— 它会让「少于一排」的卡片摊满整行，' +
        '与「保持和多图时一样宽度」直接冲突（理由与实测数字见源码里那段说明）',
    );
    assert.ok(
      !/\bcolumnCount\b/.test(code),
      label + ' 里又有代码在写 `columnCount` —— 列数一旦按卡片张数（或任何 JS 值）定，' +
        '它就会和 auto 的列宽互相打架；列宽只由 CSS 的 `columns:` 决定',
    );
  }
  for (const [label, source] of [
    ['桌面端 styles.css', cssSource],
    ['网页端 index.html', webHtmlSource],
  ]) {
    assert.match(
      cssRuleBody(source, '\\.grid\\.grid--masonry'),
      /columns:\s*calc\(var\(--grid-card-basis\)\s*\*\s*1px\)/,
      label + ' 的 `.grid.grid--masonry` 必须自己给出列宽（`columns: calc(var(--grid-card-basis) * 1px)`）' +
        '—— JS 侧已经不兜底了，这条规则就是列宽的唯一来源',
    );
  }
  // 网页端手机档的 `columns: 2` 是**独立且刻意**的（基础层是固定 180px 列宽，约 317px 的
  // 内容区装不下两列 ⇒ 会塌成单列）。它给的是 `column-count`（列宽 auto、由容器均分），
  // 与「按张数压列」不是一回事，**不许**在清理时被连带删掉。
  // ⚠️ 别用 `mediaBlock(webHtmlSource, '@media (max-width: 600px)')` 来取：那个 helper 命中
  //    **第一个**同名媒体查询，而本文件里有 9 处（第 1 处还是注释里的提及）⇒ 取到的是别块、
  //    判据恒红。这里直接定位「6 开头的媒体查询里的第一条 `.grid.grid--masonry { columns: 2 }`」。
  assert.match(
    webHtmlSource,
    /@media \(max-width: 600px\)\s*\{\s*\.grid\.grid--masonry\s*\{[^}]*columns:\s*2\s*;/,
    '网页端 ≤600px 的 `.grid.grid--masonry { columns: 2 }` 兜底不能被删 —— ' +
      '固定 180px 列宽在手机宽度下会塌成单列、卡片几乎铺满整屏',
  );

  // ── 「没有缩略图」的统一占位图（2026-10-05）────────────────────────────────────
  // 🔴 为什么单独守：同一个「没图」在两端各有两条入口（构建期 `has_thumbnail = 0` / 运行期
  //    缩略图 404），合起来是四张脸。以前桌面端构建期是「大号扩展名 + 文件名」纯文本（文件名
  //    还和卡片底部的 `.photo-info` 重复一遍），桌面端 404 是另一个图标 + 报错，网页端 404 是
  //    ⚠️ emoji —— 用户看到的是「同一件事长得不一样」。现在要求：**四条路共用一份图形**
  //    （中性底 + 图片字形 + 一行小字），所以这里的判据就是「两端**真代码**产出的标记逐字
  //    相等」—— 谁偷偷只改一端，这条立刻红。
  const MEDIA_PLACEHOLDER_CLASS = 'placeholder--media';

  /** 从一段卡片 HTML 里抠出占位块本身（块内没有嵌套 div，第一个 `</div>` 就是它的结尾）。 */
  function placeholderBlock(html) {
    const start = html.indexOf('<div class="placeholder ' + MEDIA_PLACEHOLDER_CLASS + '">');
    assert.ok(start >= 0, '夹具自证：这段 HTML 里应能抠到统一占位块');
    return html.slice(start, html.indexOf('</div>', start) + 6);
  }

  /** 网页端卡片不带 `data-photo-id`（它靠 onclick 下标定位），只能按类名找第一张。 */
  function webCardWindow(html) {
    const i = html.indexOf('<div class="photo-card');
    assert.ok(i >= 0, '夹具自证：网页端 HTML 里应有照片卡片');
    return html.slice(i, i + 220);
  }

  /**
   * 把 web app.js 里**占位图那段真代码**（常量 + 生成函数 + 谓词 + 兜底函数）连同真的
   * `renderPhotoGrid` 一起放进 vm 跑。邻居们只替身化 `renderPhotoGrid` 真正用到的那几个，
   * 免得替身本身成了被测对象。
   */
  function loadWebCardBuilder() {
    const src = read('src/web/js/app.js');
    const from = src.indexOf('var MEDIA_PLACEHOLDER_GLYPH');
    const to = src.indexOf('function bindGridImageProgress');
    assert.ok(
      from >= 0 && to > from,
      'src/web/js/app.js 里「占位图那段」的边界变了 —— 它应当从 `var MEDIA_PLACEHOLDER_GLYPH` ' +
        '一直排到 `function bindGridImageProgress`',
    );
    const el = { innerHTML: '' };
    const sandbox = {
      document: { createElement: () => ({ className: '', innerHTML: '' }) },
      state: {
        currentView: 'photos',
        currentSubfolderCovers: [],
        mediaFilter: 'all',
        cardAspectMode: 'masonry',
      },
      $: () => el,
      escapeHtml: (s) => String(s),
      escapeAttr: (s) => String(s),
      formatNumber: (n) => String(n),
      formatDateTime: () => '',
      folderDisplayBasename: (p) => String(p).split(/[\\/]/).pop(),
      isWebVideoFileType: () => false,
      normalizeCardAspectMode: (v) => (v === 'masonry' ? 'masonry' : 'square'),
      getUniformAspectCss: () => '1 / 1',
      getMediaAspectRatioDims: (p) =>
        p && p.width && p.height
          ? { w: p.width, h: p.height, ratio: p.width + ' / ' + p.height }
          : null,
      bindGridImageProgress: () => {},
      applyCardSize: () => {},
    };
    vm.createContext(sandbox);
    // Live Photo 判据按**真代码**抽进来，不给替身：卡片角标就是被 `renderPhotoGrid`
    // 生成的，替身化等于把「角标该不该出现」这条一起替身掉。
    // ⚠️ 它住在 app.js 更靠前的位置（不在 `MEDIA_PLACEHOLDER_GLYPH` 那一段里），所以单独抽。
    //
    // 🔴 缩略图缓存键的两个函数（2026-10-07）同理必须抽**真代码**：
    //    卡片 `<img src>` / 模糊占位现在带 `?v=<规格>` 后缀，键由这两个函数算出来。
    //    给替身的话「有缩略图时 URL 长什么样」就变成在测替身 —— 而这条 URL 正是
    //    「重建跑完了但卡片还是老的字节」那个静默缺陷的唯一防线。
    //    ⚠️ 它们住在 app.js **最开头**（`photoCacheVersion` 之后紧跟 `thumbCacheVersion`，
    //    在 `WEB_APPEARANCE_LS_KEY` 之前），跟 `from`/`to` 那一段不重叠，所以单独抽。
    vm.runInContext(
      extractFunction(src, 'isWebLivePhotoStill') +
        '\n' +
        extractFunction(src, 'photoCacheVersion') +
        '\n' +
        extractFunction(src, 'thumbCacheVersion') +
        '\n' +
        src.slice(from, to) +
        '\n' +
        extractFunction(src, 'renderPhotoGrid'),
      sandbox,
      { filename: 'web-render-photo-grid.js' },
    );
    return { sandbox, el };
  }

  /** 喂真的网页端 `renderPhotoGrid` 渲一张卡片，返回 HTML。 */
  function renderWebCard(photo, aspectMode) {
    const { sandbox, el } = loadWebCardBuilder();
    sandbox.state.cardAspectMode = aspectMode;
    el.innerHTML = '';
    sandbox.renderPhotoGrid([photo]);
    return el.innerHTML;
  }

  {
    const web = loadWebCardBuilder().sandbox;

    // ── ① 跨端对账：同一个「没有缩略图」的占位块，两端真代码必须产出逐字相同的标记 ──
    const noThumb = {
      id: 8811,
      file_name: 'no-thumb.NEF',
      file_type: 'NEF',
      has_thumbnail: 0,
      date_taken: '',
    };
    const desktopBlock = placeholderBlock(renderOnePhoto(noThumb, true).innerHTML);
    assert.equal(
      desktopBlock,
      web.mediaPlaceholderHtml('NEF'),
      '桌面端与网页端「没有缩略图」的占位块必须逐字相同 —— 这就是「统一占位图」的本体：' +
        '一端改了图形或类名而另一端没跟，用户就会在同一套界面里看到两种占位',
    );
    assert.match(desktopBlock, /class="placeholder-icon"/, '占位块里要有图片字形（用户要的「图像形式」）');
    assert.ok(
      !/<img/.test(desktopBlock),
      '占位块不能依赖任何要加载的东西（图像形式指的是矢量字形）—— 加载失败的那张卡片可没有图可加载',
    );

    // ── ② 运行期那条路：两端兜底节点同样逐字相同 ──
    const failed = driveThumbEvent({ masonry: true, naturalWidth: 0, naturalHeight: 0 });
    assert.ok(failed.inserted, '夹具自证：失败分支确实插入了兜底占位节点');
    assert.equal(
      failed.inserted.className,
      'placeholder ' + MEDIA_PLACEHOLDER_CLASS,
      '兜底占位与构建期占位要同类名（`.placeholder-fallback` 已废 —— 别再长出第三种形态）',
    );
    const webFallback = web.createGridFallbackPlaceholder({
      classList: { contains: () => false },
    });
    assert.equal(
      failed.inserted.innerHTML,
      webFallback.innerHTML,
      '「缩略图加载失败」那条兜底路径两端也必须逐字相同',
    );

    // ── ③ 网页端的「有没有缩略图」判据 ──
    assert.equal(web.hasUsableThumbnail({ has_thumbnail: 0 }), false, '明确写着 0 才算「没有缩略图」');
    assert.equal(web.hasUsableThumbnail({ has_thumbnail: '0' }), false, '字符串 "0" 也算');
    assert.equal(web.hasUsableThumbnail({ has_thumbnail: 1 }), true, '有缩略图');
    assert.equal(
      web.hasUsableThumbnail({}),
      true,
      '🔴 字段**缺失**要按「有」处理 —— 个别接口不带 has_thumbnail（人脸页等），' +
        '把它当成「没有」会让有图的卡片整片退化成占位图',
    );

    // ── ④ 网页端卡片构建：四条路都走真 `renderPhotoGrid` 看真 HTML ──
    const webMasonry = renderWebCard(noThumb, 'masonry');
    assert.ok(/class="grid grid--masonry"/.test(webMasonry), '夹具自证：这一跑确实是瀑布流');
    assert.match(
      webCardWindow(webMasonry),
      new RegExp(SQUARE_PLACEHOLDER_CLASS),
      '网页端瀑布流 + 没有缩略图 → 同样按正方形占位（不然卡片塌成一条）',
    );
    assert.match(
      webMasonry,
      /<div class="placeholder placeholder--media">/,
      '网页端也要渲染统一占位图',
    );
    assert.ok(
      !/class="loading grid-thumb"/.test(webMasonry),
      '🔴 明知没有缩略图就别再请求 `/thumb` —— 那是必然 404，白跑一趟还占连接',
    );

    const webUniform = renderWebCard(noThumb, 'square');
    assert.ok(!/grid--masonry/.test(webUniform), '夹具自证：这一跑是统一高度');
    assert.match(webUniform, /placeholder--media/, '统一高度那档没有缩略图同样出占位图');
    assert.ok(
      !new RegExp(SQUARE_PLACEHOLDER_CLASS).test(webCardWindow(webUniform)),
      '统一高度那档由 CSS 给死比例，不该挂正方形占位类',
    );

    const webWithThumb = renderWebCard(
      Object.assign({}, noThumb, {
        has_thumbnail: 1,
        width: 1600,
        height: 1067,
        // 规格两列由列表接口带出来（`photo-list-columns.js`），缓存键就靠它们。
        file_size: 5242880,
        date_modified: '2026-01-01 10:00:00',
        thumb_size: 512,
        thumb_format: 'webp',
      }),
      'masonry',
    );
    assert.match(webWithThumb, /class="loading grid-thumb"/, '有缩略图时必须照旧渲染 <img>');
    assert.ok(!/placeholder--media/.test(webWithThumb), '有缩略图不该再出占位图');
    // 🔴 真渲染出来的 URL 必须带**这一行自己的**规格 —— 这是「全量重建跑完了、
    //    卡片却还在显示上一档 / 上一格式的字节」唯一能挡住的地方：
    //    桌面端一路读 Chromium 内存缓存，网页端 `/thumb/:id` 是 `max-age=86400`，
    //    只要 URL 不变，重建等于白跑（最长一天后才自愈）。
    //    夹具刻意取 512/webp 而不是「默认档」：默认档会让「键里有没有规格」变成
    //    「反正也算得出一个值」，换档场景下这条断言就抓不到东西了。
    assert.match(
      webWithThumb,
      /\/thumb\/8811\?v=524288020260101100000-512webp/,
      '网页端卡片的缩略图 URL 必须把 `thumb_size` + `thumb_format` 拼进缓存键' +
        '（公式：`file_size` + `date_modified` 的数字 + `-` + 档位 + 格式）',
    );

    const webMissing = renderWebCard(
      Object.assign({}, noThumb, { has_thumbnail: undefined }),
      'masonry',
    );
    assert.match(
      webMissing,
      /class="loading grid-thumb"/,
      '🔴 `has_thumbnail` 缺失时仍按「有」处理 —— 不能把老接口的卡片擅自改成占位图',
    );

    // ── Live Photo 角标：驱动**真的**判据 + 真的卡片构建函数 ──
    // 只断言「源码里有 media-type-badge-live 这个类名」抓不住「判据接错字段」：
    // 角标会静默地永不出现。这里直接喂两种行，要求一端出一端不出。
    const webLive = renderWebCard(
      Object.assign({}, noThumb, { has_thumbnail: 1, live_motion_id: 42 }),
      'masonry',
    );
    assert.match(
      webLive,
      /class="media-type-badge media-type-badge-live">LIVE</,
      '🔴 live_motion_id > 0 的照片必须渲染 LIVE 角标',
    );
    const webPlain = renderWebCard(
      Object.assign({}, noThumb, { has_thumbnail: 1, live_motion_id: 0 }),
      'masonry',
    );
    assert.ok(
      !/media-type-badge-live/.test(webPlain),
      'live_motion_id = 0 的照片不许出 LIVE 角标',
    );
    const webNoField = renderWebCard(Object.assign({}, noThumb, { has_thumbnail: 1 }), 'masonry');
    assert.ok(
      !/media-type-badge-live/.test(webNoField),
      '🔴 列表接口没带 live_motion_id 时不许误判成 Live Photo（缺字段按「不是」处理）',
    );
  }

  // ── ⑤ 两端都得有这套样式（形状写在 CSS 里，标记一致还不够）──
  for (const [label, source] of [
    ['桌面端 styles.css', cssSource],
    ['网页端 index.html', webHtmlSource],
  ]) {
    const base = cssRuleBody(source, '\\.photo-card \\.placeholder');
    assert.match(base, /width:\s*100%/, label + ' 的占位块要有基准宽度（不然瀑布流里没有尺寸）');
    assert.match(base, /height:\s*100%/, label + ' 的占位块要有基准高度');
    assert.match(
      cssRuleBody(source, '\\.photo-card \\.placeholder\\.placeholder--media'),
      /radial-gradient/,
      label + ' 的统一占位底（强调色晕影）不能少 —— 两端观感必须一致',
    );
    const icon = cssRuleBody(source, '\\.placeholder-icon');
    assert.match(icon, /width:\s*min\(/, label + ' 的占位字形要跟着卡片缩放');
    assert.match(
      icon,
      /aspect-ratio:\s*1\s*\/\s*1/,
      label + ' 的占位字形要按 1:1 —— 不然窄卡片上会被压扁',
    );
    assert.match(
      cssRuleBody(source, '\\.placeholder-icon rect,\\s*\\.placeholder-icon polyline'),
      /stroke-width:\s*1\.5/,
      label +
        ' 的描边粗细要由 CSS 给（图形内联的原因就是这条：`<use>` 里 symbol 自带的 stroke-width 盖不掉）',
    );
  }

  console.log('[browse-grid-style] 全部通过');
}

run().catch((err) => {
  console.error('[browse-grid-style] 回归失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
