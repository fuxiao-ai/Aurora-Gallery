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

  // ── 「随机」的闪动光晕（2026-10-05）──────────────────────────────────────────
  // 这一节钉的是**动效骨架**而不是像素。每一类断言都对应一个「静态全绿、线上失效」的坑：
  //   ① 动画若挂在按钮本体上 → 动画来源层压过普通声明，hover / :active / :disabled
  //      那三条 `box-shadow` 会**静默失效**（computed 值还看着挺合理，review 抓不到）；
  //   ② 伪元素少了 `pointer-events: none` → 一层透明壳盖在按钮上，看着能点、其实点不动；
  //   ③ 少了 `position: relative` → 伪元素挂到别的定位祖先上（桌面端这个按钮**不在** `.pagination`
  //      里，`.pagination button` 那族什么都给不到它）；
  //   ④ `:disabled` 不停掉 → 一个正在闪、却点不动的按钮（假可点击性，与上面那条同一契约）；
  //   ⑤ reduced-motion 块里不豁免 → 本机实测就是 `reduce`，这套光晕**一次都看不见**，等于白做。
  const glowShared = cssRuleBody(
    cssSource,
    '\\.browse-footer-actions \\.pagination-random::before,\\s*\\.browse-footer-actions \\.pagination-random::after',
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
      '两层光晕的共享声明里缺 `' +
        prop +
        '` —— 尤其 pointer-events 一缺就是「看着能点、点不动」',
    );
  }
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
  // 关键帧既要**定义**，也要真的被引用（「定义了没人用」= 静默失效，光晕根本不会动）。
  for (const name of ['randomBtnGlowBreathe', 'randomBtnGlowPing']) {
    for (const [label, source] of [
      ['桌面端', cssSource],
      ['网页端', webHtmlSource],
    ]) {
      assert.match(source, new RegExp('@keyframes ' + name + '\\b'), label + '要有关键帧 ' + name);
      assert.match(
        source,
        new RegExp('animation:\\s*' + name + '\\b'),
        label + '的 ' + name + ' 必须被真的引用（只定义不引用 = 光晕不会动）',
      );
    }
  }
  assert.match(
    cssRuleBody(
      cssSource,
      '\\.browse-footer-actions \\.pagination-random:disabled::before,\\s*\\.browse-footer-actions \\.pagination-random:disabled::after',
    ),
    /display:\s*none/,
    '禁用态要**整个摘掉**光晕（压暗不行：还在闪就仍然是「这里能点」的暗示）',
  );
  // reduced-motion：两端各留一份豁免，且与桌面端逐条对应。
  for (const [label, source, before, after] of [
    [
      '桌面端',
      cssSource,
      '\\.browse-footer-actions \\.pagination-random::before',
      '\\.browse-footer-actions \\.pagination-random::after',
    ],
    ['网页端', webHtmlSource, '#randomPageBtn::before', '#randomPageBtn::after'],
  ]) {
    const block = mediaBlock(source, '@media (prefers-reduced-motion: reduce)');
    assert.match(
      block,
      new RegExp(before),
      label +
        ' 的 reduced-motion 块里要豁免光晕（本机实测 reduce，不豁免这套动效一次都看不见）',
    );
    // 🔴 下面两条必须取**这条豁免规则自己的**声明体，不能拿整个 `@media` 块去 match：
    //    同一个块里还有加载圈那条 `animation-iteration-count: infinite !important`，
    //    拿整块匹配会**永远为真** —— 牙齿测试实测过（把豁免的 iteration-count 删掉照样全绿）。
    const decl = cssRuleBody(block, before + ',\\s*' + after);
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
  const webGlowShared = cssRuleBody(webHtmlSource, '#randomPageBtn::before,\\s*#randomPageBtn::after');
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

  console.log('[browse-grid-style] 全部通过');
}

run().catch((err) => {
  console.error('[browse-grid-style] 回归失败：', err && err.message ? err.message : err);
  process.exit(1);
});
