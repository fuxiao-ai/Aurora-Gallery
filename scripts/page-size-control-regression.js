'use strict';
/**
 * 底栏「每页数量」控件回归（在右下角「随机」按钮旁，外形同卡片尺寸档位）。
 *
 * 为什么单独守：
 *   1. 这是个「一档一档走」的控件，**档位表外的值会让 ± 直接失效**
 *      （`indexOf` 返回 -1，加一步取到 undefined）。设置里存的却可能是任意历史值。
 *   2. 每页张数要重新查库，是少数会写设置的底栏控件；写失败必须回滚显示，
 *      否则界面上写着一个并没生效的张数。
 *   3. 「新控件建好了但没人接线」（HTML 有 id、UI 没有绑定、settings 应用后不同步）
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

function makeElement() {
  return { textContent: '', disabled: false, style: { display: '' } };
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
    browsePageSizeTierIndex: utils.browsePageSizeTierIndex,
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
      pageSizeControl: makeElement(),
      pageSizeLabel: makeElement(),
      pageSizeDecBtn: makeElement(),
      pageSizeIncBtn: makeElement(),
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

const label = (h) => h.context.dom.pageSizeLabel.textContent;

async function run() {
  const utils = loadRendererUtils();

  // ---------- 档位表本身 ----------
  assert.deepEqual(
    Array.from(utils.BROWSE_PAGE_SIZE_TIERS),
    [10, 20, 50, 80, 100, 200],
    '档位表就是设置页下拉里那几档',
  );
  assert.equal(utils.DEFAULT_BROWSE_PAGE_SIZE, 100, '默认档与主进程 createDefaultSettings 一致');
  // 收档必须「取最近」而不是判非法丢弃：底栏是逐档走，表外值一旦流进来，± 就再也动不了。
  assert.equal(utils.snapBrowsePageSize(30), 20, '30 收进最近档 20');
  assert.equal(utils.snapBrowsePageSize(75), 80, '75 收进最近档 80');
  assert.equal(utils.snapBrowsePageSize('abc'), 100, '非数字回落到默认档');
  assert.equal(utils.snapBrowsePageSize(null), 100, 'null 回落到默认档');
  assert.equal(utils.browsePageSizeTierIndex(30), 1, '表外值也能算出档位下标（否则 ± 失效）');

  // ---------- 读数 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();
    assert.equal(label(h), '100', '读数显示当前生效的档位值');
    assert.equal(h.context.dom.pageSizeDecBtn.disabled, false, '中间档两个方向都能走');
    assert.equal(h.context.dom.pageSizeIncBtn.disabled, false, '中间档两个方向都能走');
  }

  // ---------- 逐档走 + 落库 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();

    await h.context.changeBrowsePageSize(1);
    assert.deepEqual(h.log.writes, [{ browsePageSize: 200 }], '往上一档写 200，且只写这一个键');
    assert.equal(h.context.state.pageSize, 200);
    assert.equal(label(h), '200', '读数跟着生效值走');
    assert.equal(h.context.dom.pageSizeIncBtn.disabled, true, '到顶后加号禁用');
    assert.deepEqual(h.log.loads, [1], '换档要重查第一页（旧页码在新档位下可能不存在）');
    assert.equal(h.context.state.page, 1, '换档后回到第 1 页');

    await h.context.changeBrowsePageSize(1);
    assert.equal(h.log.writes.length, 1, '已经到顶，再点不写库');

    for (const expected of [100, 80, 50, 20, 10]) {
      await h.context.changeBrowsePageSize(-1);
      assert.equal(h.context.state.pageSize, expected, '减一档得到 ' + expected);
      assert.equal(label(h), String(expected), '读数与生效值同步');
    }
    assert.equal(h.context.dom.pageSizeDecBtn.disabled, true, '到底后减号禁用');
    await h.context.changeBrowsePageSize(-1);
    assert.equal(h.log.writes.length, 6, '已经到底，再点不写库（100→200 那次 + 五次减档）');
    assert.equal(label(h), '10', '到底后读数不动');
  }

  // ---------- 表外值不会让 ± 卡死（回归点：曾经 app.js 认 300 / 500，主进程根本不产） ----------
  {
    const h = makeHarness();
    h.context.state.pageSize = 30;
    h.context.syncPageSizeControl();
    assert.equal(label(h), '20', '表外值先被收进档位表');
    await h.context.changeBrowsePageSize(1);
    assert.equal(h.context.state.pageSize, 50, '收档之后 ± 仍然可用');
  }

  // ---------- 写库失败回滚 ----------
  {
    const h = makeHarness();
    h.context.syncPageSizeControl();
    h.context.__failNextWrite = new Error('settings locked');
    await h.context.changeBrowsePageSize(1);
    assert.equal(h.context.state.pageSize, 100, '失败要把档位退回上一个生效值');
    assert.equal(label(h), '100', '读数也一起回滚，否则界面在说谎');
    assert.equal(h.log.loads.length, 0, '没落库就不该重查（否则白跑一次全库查询）');
    assert.equal(h.log.alerts.length, 1, '失败必须说出来，不能静默');
    assert.match(h.log.alerts[0], /切换每页显示张数失败/, '错误文案要能认人');
    assert.match(h.log.alerts[0], /settings locked/, '原始错误要留在文案里');

    await h.context.changeBrowsePageSize(1);
    assert.equal(h.context.state.pageSize, 200, '回滚后还能再试');
  }

  // ---------- 设置页改了每页张数：底栏读数跟着走 ----------
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
    assert.equal(label(h), '50', '设置页/启动应用设置后，底栏读数必须同步');
    assert.equal(h.context.dom.pageSizeIncBtn.disabled, false, '档位下标的禁用态也要重算');
  }

  // ---------- 静态契约：接线不许断 ----------
  const html = read('src/renderer/index.html');
  const appSource = read('src/renderer/app.js');
  const eventsSource = read('src/renderer/ui-events.js');
  const settingsSource = read('src/renderer/settings.js');
  const navSource = read('src/renderer/ui-navigation.js');
  const aiSource = read('src/renderer/ai-views.js');
  const i18nSource = read('src/renderer/i18n.js');
  const cssSource = read('src/renderer/styles.css');

  for (const id of ['pageSizeControl', 'pageSizeLabel', 'pageSizeDecBtn', 'pageSizeIncBtn']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'index.html 要有 #' + id);
    assert.match(
      appSource,
      new RegExp('(?:^|\\s)' + id + ": \\$\\('#" + id + "'\\)", 'm'),
      'dom 映射要有 ' + id,
    );
  }
  const pageSizeHtml = html.slice(
    html.indexOf('class="zoom-control zoom-control--page"'),
    html.indexOf('id="pageSizeIncBtn"'),
  );
  assert.match(
    pageSizeHtml,
    /id="pageSizeControl"/,
    '每页数量要与卡片尺寸共用 .zoom-control 药丸（外形一致），差别只挂在 --page 修饰上',
  );
  assert.ok(!/\bid="zoomControl"/.test(pageSizeHtml), '切出来的这一段只属于每页数量控件');
  assert.match(pageSizeHtml, /id="pageSizeLabel"/, '药丸中间要有读数');
  assert.match(pageSizeHtml, /id="pageSizeDecBtn"/, '药丸左边要有减号');
  assert.equal(pageSizeHtml.split('<button').length - 1, 2, '左右各一个按钮，别无其它交互件');
  assert.ok(
    html.indexOf('id="pageSizeControl"') > html.indexOf('id="randomPageBtn"'),
    '控件要落在「随机」按钮之后（随机按钮旁的右下角）',
  );
  assert.ok(
    html.indexOf('id="pageSizeControl"') < html.indexOf('id="zoomControl"'),
    '顺序：随机 · 每页数量 · 卡片尺寸',
  );
  assert.match(cssSource, /\.zoom-control--page\s*\{/, 'CSS 里要有 --page 修饰规则');

  assert.match(
    eventsSource,
    /bindClick\('pageSizeDecBtn', options\.onPageSizeDec\)/,
    '减号要绑事件',
  );
  assert.match(
    eventsSource,
    /bindClick\('pageSizeIncBtn', options\.onPageSizeInc\)/,
    '加号要绑事件',
  );
  assert.match(
    appSource,
    /onPageSizeDec:[\s\S]{0,80}changeBrowsePageSize\(-1\)/,
    '± 回调要指向同一函数',
  );
  assert.match(
    appSource,
    /onPageSizeInc:[\s\S]{0,80}changeBrowsePageSize\(1\)/,
    '± 回调要指向同一函数',
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

  // 底栏两个档位控件同生同死：一条 helper 管两个 id，别再各写各的。
  assert.match(
    navSource,
    /var ids = \['zoomControl', 'pageSizeControl'\]/,
    '可见性 helper 要同时管卡片尺寸与每页数量',
  );
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

  for (const key of [
    'footer.pageSizeTitle',
    'footer.pageSizeAria',
    'footer.pageSizeDec',
    'footer.pageSizeInc',
  ]) {
    const hits = i18nSource.split("'" + key + "'").length - 1;
    assert.equal(hits, 2, key + ' 中英两套文案都要有');
  }

  // 档位表四处同源：utils.js（渲染端唯一真源）+ 主进程两份校验 + 设置页下拉。
  const tiersLiteral = '[10, 20, 50, 80, 100, 200]';
  assert.match(
    read('src/renderer/utils.js'),
    /BROWSE_PAGE_SIZE_TIERS = \[10, 20, 50, 80, 100, 200\]/,
  );
  for (const file of ['src/main.js', 'src/main/settings.js']) {
    assert.match(
      read(file),
      new RegExp(tiersLiteral.replace(/[[\]]/g, '\\$&') + '\\.indexOf\\(bps\\)'),
      file + ' 的每页张数校验要与渲染端档位表一致',
    );
  }
  const selectHtml = html.slice(
    html.indexOf('id="settingBrowsePageSize"'),
    html.indexOf('</select>', html.indexOf('id="settingBrowsePageSize"')),
  );
  assert.deepEqual(
    (selectHtml.match(/value="(\d+)"/g) || []).map((s) => Number(s.slice(7, -1))),
    Array.from(utils.BROWSE_PAGE_SIZE_TIERS),
    '设置页下拉的每一档都要能被底栏走到（否则底栏显示的值在设置页里选不中）',
  );

  console.log('[page-size-control-regression] PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
