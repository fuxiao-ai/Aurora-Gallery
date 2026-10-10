'use strict';
/**
 * 底栏「每页」下拉回归（右下角「随机」按钮旁，与设置页 `#settingBrowsePageSize` 同一取值域）。
 *
 * 为什么单独守：
 *   1. 档位表外的值在 `<select>` 里**匹配不到任何 option**，直接赋 value 会让下拉显示成
 *      **空白**（不是回落到某一档）—— 比原来 ± 药丸「按不动」更难看懂。所以进 `state`
 *      与进 DOM 的每一处都必须先收档。
 *   2. 每页张数要重新查库，是少数会写设置的底栏控件；写失败必须回滚 state 与读数，
 *      否则界面里写着一个并没生效的张数。
 *   3. 「新控件建好了但没人接线」（HTML 有 id、UI 没有绑定、设置应用后不同步）
 *      不会报错，只会静默失灵，所以配套静态契约。
 *
 * app.js 一上来就摸真实 DOM / electron，没法整体加载，因此按项目既有做法
 * （见 browse-regression.js）从源码里抽函数、在 vm 里注入替身来跑行为。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 🔴 桩必须接**真 i18n 包**，不能「直接返回第三参兜底串」：
//    `changeBrowsePageSize` 从 2026-10-08 起把失败提示改走
//    `tUiFmt('settings.pageSizeFailFmt', …)`（见 `app.js` 的 catch）。返回兜底串的桩
//    虽然能让下面那两条中文断言继续绿，却把两个真坏法**整个盖住**：
//      ① 键写错 / 英文包漏了这条 ⇒ `I18n.t()` 静默回落中文 ⇒ 英文界面弹中文；
//      ② 英文模板漏了 `{err}` ⇒ 文案说得出「失败」却说不出「为什么」。
//    ⚠️ 这正是本守护最初报 `ReferenceError: tUiFmt is not defined` 的根因 ——
//       沙箱里根本没提供这个助手（同族：`browse-grid-style-regression.js` 也一并补）。
global.document = { documentElement: { setAttribute() {} }, querySelectorAll: () => [] };
global.window = global.window || {};
require('../src/renderer/i18n.js');
const I18n = global.window.I18n;

/**
 * 按 locale 取**真词条**。
 * 键在两包都不存在时 `I18n.t()` 会**原样返回键** ⇒ 这里直接判红，
 * 而不是退回兜底串把「键写错」伪装成「看起来正常」。
 */
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

/** 用真实的 utils.js 取档位表与收档函数，避免测试自己再写一份口径。 */
function loadRendererUtils() {
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/renderer/utils.js'), sandbox, { filename: 'utils.js' });
  return sandbox.RendererUtils;
}

function makeField() {
  return { style: { display: '' } };
}
function makeSelect() {
  return { value: '', style: { display: '' } };
}

function makeHarness() {
  const utils = loadRendererUtils();
  const appSource = read('src/renderer/app.js');
  const log = { writes: [], alerts: [], loads: [], applies: [] };

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
    state: {
      pageSize: 100,
      page: 3,
      cardSize: 180,
      cardRatio: '1 / 1',
      thumbCrop: false,
      cardLayoutMode: 'masonry',
      browsePrefsApplied: { pageSize: 100 },
    },
    dom: {
      // 可见性挂在外层 field 上，读数在里面的 select 上。
      pageSizeControl: makeField(),
      browsePageSizeSelect: makeSelect(),
    },
    api: {
      updateSettings(patch) {
        // 只留键名，别把 vm 那个 realm 的对象塞进断言（跨 realm 的 deepStrictEqual 必挂）
        log.writes.push({ browsePageSize: patch.browsePageSize });
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
    // 真包取词桩（见文件头）。`__locale` 是用例开关，默认中文。
    // ⚠️ **刻意不用第三参兜底串**：键缺失要判红，不能被兜底串兜过去。
    // ⚠️ 插值逻辑与 `app.js#tUiFmt` 同构 —— 拿**该语言的模板**去填 `{err}`，
    //    所以英文用例顺手就把「英文模板也必须带 `{err}`」钉住了。
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
    applyCardSize() {},
    snapBrowseCardBasis: (n) => n,
    setBrowseAppliedSnapshotFromObject(settings) {
      context.state.browsePrefsApplied = {
        pageSize: utils.snapBrowsePageSize(settings.browsePageSize),
      };
    },
    // 只保留「把设置里的每页张数搬进 state，再回调 onApplyPageSize」这半段语义——
    // 完整实现还要管排序 / 卡片比例，与本控件无关。
    settingsSync: {
      applyBrowsePreferencesFromSettings(options) {
        log.applies.push(options);
        const ps = utils.snapBrowsePageSize(options.settings.browsePageSize);
        options.state.pageSize = ps;
        if (typeof options.onApplyCardSize === 'function') options.onApplyCardSize();
        if (typeof options.onApplyPageSize === 'function') options.onApplyPageSize();
        if (typeof options.onSetBrowseAppliedSnapshotFromObject === 'function')
          options.onSetBrowseAppliedSnapshotFromObject(options.settings);
      },
    },
  };

  vm.createContext(context);
  for (const name of ['syncPageSizeControl', 'changeBrowsePageSize']) {
    vm.runInContext(extractFunction(appSource, name), context);
  }
  return { context, utils, log };
}

/** 下拉当前显示的档位（`<select>.value` 是字符串，比较前统一成数字）。 */
const shown = (h) => Number(h.context.dom.browsePageSizeSelect.value);

async function run() {
  const utils = loadRendererUtils();

  // ---------- 档位表本身 ----------
  assert.deepEqual(
    Array.from(utils.BROWSE_PAGE_SIZE_TIERS),
    [10, 20, 50, 80, 100, 200],
    '档位表就是设置页下拉里那几档',
  );
  assert.equal(utils.DEFAULT_BROWSE_PAGE_SIZE, 100, '默认档与主进程 createDefaultSettings 一致');
  // 收档必须「取最近」而不是判非法丢弃：改成下拉后，表外值一旦流进来，
  // 赋给 `<select>` 会让它显示成**空白**（匹配不到 option），所以每一处都要先收档。
  assert.equal(utils.snapBrowsePageSize(30), 20, '30 收进最近档 20');
  assert.equal(utils.snapBrowsePageSize(75), 80, '75 收进最近档 80');
  assert.equal(utils.snapBrowsePageSize('abc'), 100, '非数字回落到默认档');
  assert.equal(utils.snapBrowsePageSize(null), 100, 'null 回落到默认档');
  assert.equal(utils.browsePageSizeTierIndex(30), 1, '表外值也能算出档位下标');

  // ---------- 读数：下拉显示的是**生效值**，且一定落在档位表里 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();
    assert.equal(shown(h), 100, '下拉显示当前生效的档位值');
    assert.equal(h.context.state.pageSize, 100);
  }
  {
    // 表外值（手改 settings.json / 上一代档位表）不能把下拉留成空白
    const h = makeHarness();
    h.context.state.pageSize = 30;
    h.context.syncPageSizeControl();
    assert.equal(shown(h), 20, '表外值先被收进档位表再写进下拉');
    assert.equal(h.context.state.pageSize, 20, 'state 也要一起收档，否则下次比较用的还是脏值');
  }
  {
    const h = makeHarness();
    h.context.state.pageSize = 'abc';
    h.context.syncPageSizeControl();
    assert.equal(shown(h), 100, '脏值回落到默认档，不能出现空下拉');
  }

  // ---------- 换档：落库 + 回第 1 页重查 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();

    await h.context.changeBrowsePageSize('200');
    assert.deepEqual(h.log.writes, [{ browsePageSize: 200 }], '写 200，且只写这一个键');
    assert.equal(h.context.state.pageSize, 200);
    assert.equal(shown(h), 200, '下拉跟着生效值走');
    assert.deepEqual(h.log.loads, [1], '换档要重查第一页（旧页码在新档位下可能不存在）');
    assert.equal(h.context.state.page, 1, '换档后回到第 1 页');

    await h.context.changeBrowsePageSize('100');
    assert.equal(h.log.writes.length, 2, '再换一档就再写一次');
    assert.equal(shown(h), 100);
  }

  // ---------- 选中当前档：不写库、不重查 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();
    await h.context.changeBrowsePageSize('100');
    assert.equal(h.log.writes.length, 0, '与当前一致就不该写库（下拉每次 focus 都可能触发 change）');
    assert.equal(h.log.loads.length, 0, '没变就不用重查');
    assert.equal(shown(h), 100, '下拉保持生效值');
  }

  // ---------- 表外值收进当前档 = 视为「没变」，并把下拉拨回去 ----------
  {
    const h = makeHarness();
    h.context.dom.browsePageSizeSelect.value = '110'; // 有人手改 DOM / 上一代档位残留
    await h.context.changeBrowsePageSize('110');
    assert.equal(h.log.writes.length, 0, '110 收档后就是 100，与生效值相同，不该写库');
    assert.equal(
      shown(h),
      100,
      '下拉要拨回生效值：否则界面停在一个不存在的档位上（旁边还写着「每页」）',
    );
  }

  // ---------- 写库失败回滚 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();
    h.context.__failNextWrite = new Error('settings locked');
    await h.context.changeBrowsePageSize('200');
    assert.equal(h.context.state.pageSize, 100, '失败要把档位退回上一个生效值');
    assert.equal(shown(h), 100, '下拉也一起回滚，否则界面在说谎');
    assert.equal(h.log.loads.length, 0, '没落库就不该重查（否则白跑一次全库查询）');
    assert.equal(h.log.alerts.length, 1, '失败必须说出来，不能静默');
    assert.match(h.log.alerts[0], /切换每页显示张数失败/, '错误文案要能认人');
    assert.match(h.log.alerts[0], /settings locked/, '原始错误要留在文案里');

    await h.context.changeBrowsePageSize('200');
    assert.equal(h.context.state.pageSize, 200, '回滚后还能再试');
  }

  // ---------- 同一处失败在**英文界面**下的形态 ----------
  // 2026-10-08 起这条提示走 `tUiFmt('settings.pageSizeFailFmt', { err }, '切换每页显示张数失败：{err}')`。
  // 中文那两条断言（上面）测不出切语言的坏法，所以这里把 locale 拨到 en 再走一遍同一个 catch：
  //   · 键没进英文包 ⇒ `I18n.t()` 静默回落中文 ⇒ 中文断言照样绿，用户却看到中文；
  //   · 英文模板漏 `{err}` ⇒ 文案说得出「失败」却说不出「为什么」（中文那两条同样测不到）。
  // ⚠️ **刻意不钉英文措辞**：期望串从**真包**派生 ⇒ 以后改英文文案不用改这个守护。
  //    但三种坏法照样红：用错键（字面量不等）、英文缺这条（回落中文 ⇒ 中文断言红）、
  //    模板没 `{err}`（`/settings locked/` 红）。
  {
    const h = makeHarness();
    h.context.__locale = 'en';
    h.context.syncPageSizeControl();
    h.context.__failNextWrite = new Error('settings locked');
    await h.context.changeBrowsePageSize('200');
    assert.equal(h.log.alerts.length, 1, '英文界面同样要点出失败，不能静默');
    const expected = i18nText('en', 'settings.pageSizeFailFmt')
      .split('{err}')
      .join('settings locked');
    assert.equal(
      h.log.alerts[0],
      expected,
      '英文界面要弹英文模板（期望从真包派生，实得：' + h.log.alerts[0] + '）',
    );
    assert.match(h.log.alerts[0], /settings locked/, '英文模板里也必须带 {err}，否则说不出原因');
    assert.ok(
      !/[\u3400-\u9fff]/.test(h.log.alerts[0]),
      '英文界面不许露中文（含回落中文包的情形），实际：' + h.log.alerts[0],
    );
    assert.equal(h.context.state.pageSize, 100, '英文路径同样要回滚');
    assert.equal(shown(h), 100, '英文路径下拉也要一起回滚');
  }

  // ---------- 设置页改了每页张数：底栏下拉跟着走 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();
    h.context.settingsSync.applyBrowsePreferencesFromSettings({
      state: h.context.state,
      dom: h.context.dom,
      settings: { browsePageSize: 50 },
      onApplyCardSize: h.context.applyCardSize,
      onApplyPageSize: h.context.syncPageSizeControl,
      onSetBrowseAppliedSnapshotFromObject: h.context.setBrowseAppliedSnapshotFromObject,
    });
    assert.equal(shown(h), 50, '设置页/启动应用设置后，底栏下拉必须同步');
  }

  // ---------- 静态契约：接线不许断 ----------
  const html = read('src/renderer/index.html');
  const appSource = read('src/renderer/app.js');
  const eventsSource = read('src/renderer/ui-events.js');
  const settingsSource = read('src/renderer/settings.js');
  const navSource = read('src/renderer/ui-navigation.js');
  const aiSource = read('src/renderer/ai-views.js');
  const i18nSource = read('src/renderer/i18n.js');

  for (const id of ['pageSizeControl', 'browsePageSizeSelect']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'index.html 要有 #' + id);
    assert.match(
      appSource,
      new RegExp('(?:^|\\s)' + id + ": \\$\\('#" + id + "'\\)", 'm'),
      'dom 映射要有 ' + id,
    );
  }

  const pageSizeHtml = html.slice(
    html.indexOf('id="pageSizeControl"'),
    html.indexOf('id="zoomControl"'),
  );
  assert.ok(!/\bid="zoomControl"/.test(pageSizeHtml), '切出来的这一段只属于每页数量控件');
  assert.match(
    pageSizeHtml,
    /<label[\s\S]*?class="browse-footer-label"[\s\S]*?for="browsePageSizeSelect"/,
    '每页数量要有可见标签（只写「100」没人知道是什么）',
  );
  assert.match(pageSizeHtml, /id="browsePageSizeSelect"/, '标签指向的 select 要在同一块里');
  assert.equal(
    pageSizeHtml.split('<button').length - 1,
    0,
    '± 药丸已下线：这一块里不该再有按钮（档位由下拉直接选）',
  );
  assert.ok(
    html.indexOf('id="pageSizeControl"') > html.indexOf('id="randomPageBtn"'),
    '控件要落在「随机」按钮之后（随机按钮旁的右下角）',
  );
  assert.ok(
    html.indexOf('id="pageSizeControl"') < html.indexOf('id="zoomControl"'),
    '顺序：随机 · 网格与比例 · 每页数量 · 卡片尺寸',
  );

  assert.match(
    eventsSource,
    /bindSelectChange\('browsePageSizeSelect', options\.onBrowsePageSizeChange\)/,
    '下拉要绑 change（选中即提交）',
  );
  assert.match(
    appSource,
    /onBrowsePageSizeChange:[\s\S]{0,90}changeBrowsePageSize\(value\)/,
    '回调要指向同一个函数',
  );

  // 每个「应用浏览设置」的调用点都必须带上 onApplyPageSize，否则底栏读数会在
  // 设置页改完 / 启动加载后停在旧值上。
  const applySites = (
    appSource.match(/settingsSync\.applyBrowsePreferencesFromSettings\(\{/g) || []
  ).length;
  const pageSizeCallbacks = (appSource.match(/onApplyPageSize: syncPageSizeControl/g) || []).length;
  assert.equal(
    pageSizeCallbacks,
    applySites,
    'applyBrowsePreferencesFromSettings 的每个调用点都要传 onApplyPageSize',
  );
  assert.ok(applySites >= 3, '启动加载 + 设置页返回 + 底栏自己都要走这条路');
  assert.match(
    settingsSource,
    /options\.onApplyPageSize\(\)/,
    'settings.js 要真的回调 onApplyPageSize（可选回调，旧调用方不受影响）',
  );

  // 底栏那排控件同生同死：一条 helper 管住所有 id，别再各写各的。
  // 断言「必须包含」而不是逐字相等 —— 这里的 id 是外层 field（标签 + 下拉一整块），
  // 加控件时不该为了迁就这条正则去改顺序，而漏登记才是不允许的。
  const visIdsMatch = navSource.match(/var ids = \[([^\]]*)\]/);
  assert.ok(visIdsMatch, '可见性 helper 里要有一份 id 清单');
  const visIds = visIdsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/'/g, ''))
    .filter(Boolean);
  for (const id of ['zoomControl', 'pageSizeControl']) {
    assert.ok(visIds.includes(id), '可见性 helper 要同时管卡片尺寸与每页数量（缺 #' + id + '）');
  }
  assert.match(navSource, /setBrowseGridControlsVisible\(true\)/, '浏览页要显示');
  assert.match(navSource, /setBrowseGridControlsVisible\(false\)/, '集合页要收起');
  assert.match(
    navSource,
    /setBrowseGridControlsVisible: setBrowseGridControlsVisible/,
    'helper 要导出，app.js 的重复页才调得到',
  );
  assert.match(
    aiSource,
    /if \(dom\.pageSizeControl\) dom\.pageSizeControl\.style\.display = 'none'/,
    '智能视图结果只有一页，每页数量跟着随机跳页一起收',
  );
  assert.match(
    aiSource,
    /if \(dom\.pageSizeControl\) dom\.pageSizeControl\.style\.display = ''/,
    '离开智能视图要还回来',
  );

  for (const key of ['footer.pageSizeLabel', 'footer.pageSizeTitle', 'footer.pageSizeAria']) {
    const hits = i18nSource.split("'" + key + "'").length - 1;
    assert.equal(hits, 2, key + ' 中英两套文案都要有');
  }

  // 档位表三处同源：utils.js（渲染端唯一真源）+ 主进程校验 + 设置页下拉。
  // ⚠️ 曾经这里还检查 `src/main/settings.js` —— 那是个**未接线的孤儿副本**（T6 已删），
  //    钉它等于给死代码加断言，删掉不损失任何活代码上的保证。
  const tiersLiteral = '[10, 20, 50, 80, 100, 200]';
  assert.match(
    read('src/renderer/utils.js'),
    /BROWSE_PAGE_SIZE_TIERS = \[10, 20, 50, 80, 100, 200\]/,
  );
  for (const file of ['src/main.js']) {
    assert.match(
      read(file),
      new RegExp(tiersLiteral.replace(/[[\]]/g, '\\$&') + '\\.indexOf\\(bps\\)'),
      file + ' 的每页张数校验要与渲染端档位表一致',
    );
  }
  /** 从某段源码里抽 `<select>` 的 option value 列表（按 DOM 顺序）。 */
  const optionValuesOf = (source, selectId) => {
    const start = source.indexOf('id="' + selectId + '"');
    assert.ok(start > 0, 'index.html 里找不到 #' + selectId);
    const end = source.indexOf('</select>', start);
    return Array.from(source.slice(start, end).matchAll(/<option value="([^"]+)"/g)).map(
      (m) => m[1],
    );
  };
  const tierValues = Array.from(utils.BROWSE_PAGE_SIZE_TIERS).map(String);
  assert.deepEqual(
    optionValuesOf(html, 'browsePageSizeSelect'),
    tierValues,
    '底栏下拉的每一档都要与档位表逐位一致',
  );
  assert.deepEqual(
    optionValuesOf(html, 'settingBrowsePageSize'),
    tierValues,
    '设置页下拉的每一档都要能被底栏走到（否则底栏显示的值在设置页里选不中）',
  );

  // ---------- 药丸的下线要干净：id / 选择器 / dom 映射都不许留 ----------
  // 逐个 id 查四种写法（HTML 属性、JS 字符串、选择器、dom 映射键）而不是裸子串：
  // `footer.pageSizeLabel` 这条 i18n 词条里就含 `pageSizeLabel`，裸子串会误报。
  const rendererFiles = fs
    .readdirSync(path.join(ROOT, 'src/renderer'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(js|html|css)$/.test(e.name))
    .map((e) => 'src/renderer/' + e.name);
  const idish = (id) =>
    new RegExp('id="' + id + '"|#' + id + "\\b|'" + id + "'|\"" + id + '"');
  for (const dead of [
    'pageSizeLabel',
    'pageSizeDecBtn',
    'pageSizeIncBtn',
    'cardSizeDecBtn',
    'cardSizeIncBtn',
    'zoomLabel',
  ]) {
    for (const file of rendererFiles) {
      assert.ok(
        !idish(dead).test(read(file)),
        file + ' 还在引用已下线的 #' + dead + ' —— 药丸改成下拉后这些 id 不该再出现',
      );
    }
  }

  console.log('[page-size-control-regression] PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
