'use strict';
/* global WebSocket */
/**
 * 「AI 内容标签」端到端探针（手动跑，不是回归）。
 *
 * 为什么必须有它：这条链路横跨**三个进程 / 三个库**——
 *   渲染进程（注册表渲染胶囊、点击）→ 主进程 IPC → `SemanticTags` 只读连接
 *   → **搜图索引库**（`ai-search/semantic-index.sqlite`，不是 `photos` 表里的列）。
 * 静态守护能证明每段代码互相引用着，证明不了「真的读到了真库里的标签、真的渲染成能点的
 * 胶囊、点一下真的带着这个词跳到了搜图页」。而这几段断开的方式全是**静默**的：
 * 少一行、或者摆了不反应的按钮。
 *
 * 用法（同 photo-info-fields-probe）：
 *   1) 把**真实**索引库拷进隔离目录，否则标签必然是空的、探针失去意义：
 *        cp "$LOCALAPPDATA/aurora-gallery/UserData/ai-search/semantic-index.sqlite*" \
 *           C:/temp/info-fields-probe/isolated/aurora-gallery/UserData/ai-search/
 *   2) 起隔离实例：
 *        LOCALAPPDATA='C:/temp/info-fields-probe/isolated' \
 *        env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *          --remote-debugging-port=9222 --disable-gpu --disable-gpu-compositing \
 *          --disable-software-rasterizer --no-sandbox . --dev
 *   3) node scripts/photo-tags-probe.js
 *
 * ⚠️ 隔离实例用的是**空相册**，所以照片对象由探针注入（`state.previewPhotos`）——
 *    这是唯一被构造的一环，**标签本身、IPC、渲染、点击全是真的**。注入的 id 必须是真库里
 *    确有标签的那张（324737 = 「丝袜」），否则探针会「PASS 因为确实没标签」而失去意义，
 *    所以下面专门有一条断言守住「标签非空」。
 * ⚠️ 跑前确认调试端口上恰好 1 个主窗口 target、无残留实例。
 *
 * 退出码：0 全 PASS / 1 有 FAIL / 2 连不上或不满足前置条件。
 */
const fs = require('fs');

const PORT = parseInt(process.env.PROBE_PORT || '9222', 10);
const OUT_DIR = process.env.PROBE_OUT || 'C:/temp/info-fields-probe';
/** 真实索引库里带着「丝袜」标签的一张；换库时改这里。 */
const PHOTO_ID = parseInt(process.env.PROBE_PHOTO_ID || '324737', 10);
const EXPECTED_TAG = process.env.PROBE_TAG || '丝袜';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pageWsUrl() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const pages = list.filter((t) => t.type === 'page' && t.url.includes('src/renderer/index.html'));
  if (pages.length !== 1) {
    throw new Error(`期望恰好 1 个主窗口 target，实际 ${pages.length} 个 —— 先清掉残留实例`);
  }
  return pages[0].webSocketDebuggerUrl;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async screenshot(file, cssWidth, cssHeight) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: cssWidth,
      height: cssHeight,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(260);
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
}

async function main() {
  const ws = new WebSocket(await pageWsUrl());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 实例可能是「改动之前」起的 → 它加载的是旧的 renderer 代码，探针会拿到假 FAIL。
  // 与 dialog-mask-probe 同约定：要测新代码就显式 PROBE_RELOAD=1 重载。
  if (process.env.PROBE_RELOAD === '1') {
    await cdp.send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 60; i += 1) {
      await sleep(400);
      const ok = await cdp
        .eval(`!!(window.state && window.PhotoInfoFields && typeof window.loadPreviewInfoPanel === 'function')`)
        .catch(() => false);
      if (ok) break;
    }
    await sleep(600);
  }

  // 让窗口有确定的 CSS 视口（本机全局 2x 缩放）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(300);

  // ---------- 零、归零：探针必须可重复跑 ----
  // 上次跑完停在搜图页，不归零的话下文「点击前不在搜图页」这条**前置断言**会失败，
  // 而它失败并不代表产品坏了 —— 不可重复的前置断言等于只在第一次有效。
  await cdp.eval(`(() => {
    try {
      if (typeof window.showTabContent === 'function' && window.state && window.state.currentTab !== 'folders') {
        window.showTabContent('folders');
      }
    } catch (e) {}
    return true;
  })()`);
  await sleep(700);

  // ---------- 一、注册表在渲染进程里加载了，且认这个字段 ----
  const reg = await cdp.eval(`(() => {
    const A = window.PhotoInfoFields;
    if (!A) return { missing: true };
    const f = A.fieldById('ai_tags');
    return { count: A.FIELD_IDS.length, hasField: !!f, render: f && f.render, group: f && f.group };
  })()`);
  check('渲染进程加载了字段注册表', !reg.missing, JSON.stringify(reg));
  check('注册表里有 ai_tags 且 render = tags', !!reg.hasField && reg.render === 'tags', JSON.stringify(reg));

  // ---------- 二、IPC 真的读到了真库里的标签 ----
  const raw = await cdp.eval(`(async () => {
    if (!window.photoAPI || !window.photoAPI.getPhotoAiTags) return { missing: true };
    const zh = await window.photoAPI.getPhotoAiTags(${PHOTO_ID}, 'zh-CN');
    const en = await window.photoAPI.getPhotoAiTags(${PHOTO_ID}, 'en');
    const absent = await window.photoAPI.getPhotoAiTags(999999999, 'zh-CN');
    return { zh: zh, en: en, absent: absent };
  })()`);
  check(
    'IPC getPhotoAiTags 拿到真库里的标签（隔离目录必须已拷入真实索引库）',
    Array.isArray(raw.zh) && raw.zh.length > 0,
    JSON.stringify(raw),
  );
  check(
    '🔴 标签非空 —— 否则后面「渲染成功」是假的（空标签本来就不渲染那一行）',
    Array.isArray(raw.zh) && raw.zh.indexOf(EXPECTED_TAG) >= 0,
    JSON.stringify(raw.zh),
  );
  check('同一个 id 在英文下给英文词（存下标而非字符串）', raw.en.length === raw.zh.length && raw.en[0] !== raw.zh[0], JSON.stringify(raw.en));
  check('库外的 id 返回空数组而不抛', Array.isArray(raw.absent) && raw.absent.length === 0);

  // ---------- 三、打开预览 → 面板真的画出胶囊 ----
  const opened = await cdp.eval(`(async () => {
    // app.js 是普通 <script>：顶层 var state / function loadPreviewInfoPanel 都是全局，可直接取
    const st = window.state;
    const load = window.loadPreviewInfoPanel;
    const el = document.getElementById('previewInfoPanel');
    const content = document.getElementById('previewInfoPanelContent');
    const overlay = document.getElementById('previewOverlay');
    if (!el || !content || !st || typeof load !== 'function') {
      return { missing: true, hasState: !!st, hasLoad: typeof load };
    }
    // 空相册：注入一个真实 id 的 photo 对象（标签由真库提供，不注入）
    const photo = { id: ${PHOTO_ID}, file_name: 'probe.jpg', file_type: 'JPG', file_size: 1024 };
    st.previewPhotos = [photo];
    st.previewIndex = 0;
    st.previewTotalPhotos = 1;
    st.slideshowRandom = false;
    // 只勾「文件名 + AI 标签」，让断言聚焦
    st.infoPanelFields = ['file_name', 'ai_tags'];
    el.classList.add('open');
    // 同时把预览遮罩置为 active —— 否则「跳转前会关预览」那条断言是空跑的
    // （openSemanticSearch 只在遮罩 active 时才调 closePreview）。
    if (overlay) overlay.classList.add('active');
    load(photo);
    await new Promise((r) => setTimeout(r, 1200));
    const chips = Array.from(content.querySelectorAll('.preview-info-tag'));
    return {
      isOpen: el.classList.contains('open'),
      overlayActive: overlay ? overlay.classList.contains('active') : null,
      chipCount: chips.length,
      chips: chips.map((c) => ({
        text: c.textContent.trim(),
        tag: c.getAttribute('data-ai-tag'),
        tagName: c.tagName,
      })),
      rowLabels: Array.from(content.querySelectorAll('.preview-info-label')).map((e) => e.textContent.trim()),
      sectionTitles: Array.from(content.querySelectorAll('.preview-info-section-title')).map((e) => e.textContent.trim()),
      hasTagsContainer: !!content.querySelector('.preview-info-value-tags'),
      empty: !!content.querySelector('.preview-info-empty'),
    };
  })()`);
  check(
    '夹具自证：拿到了全局 state 与渲染函数',
    !opened.missing,
    JSON.stringify({ hasState: opened.hasState, hasLoad: opened.hasLoad }),
  );
  check('面板已展开', opened.isOpen === true);
  check(
    '夹具自证：预览遮罩确实处于 active（否则「跳转前关预览」那条断言是空跑的）',
    opened.overlayActive === true,
    JSON.stringify(opened.overlayActive),
  );
  check(
    '🔴 面板里出现了 AI 标签胶囊（IPC → 注册表 → DOM 全通）',
    opened.chipCount > 0 && !opened.empty,
    JSON.stringify(opened),
  );
  check('胶囊是可点的 <button>（桌面端，不是网页端的不可点 span）', (opened.chips || []).every((c) => c.tagName === 'BUTTON'), JSON.stringify(opened.chips));
  check(
    '🔴 data-ai-tag 与胶囊文本一致（点了搜的词就是看到的词）',
    (opened.chips || []).length > 0 && (opened.chips || []).every((c) => c.tag === c.text),
    JSON.stringify(opened.chips),
  );
  check('标签行的值区带 preview-info-value-tags 容器', opened.hasTagsContainer === true);
  check(
    '标签落在「AI 内容」分组里',
    (opened.sectionTitles || []).indexOf('AI 内容') >= 0,
    JSON.stringify(opened.sectionTitles),
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const panelShot = OUT_DIR + '/preview-info-ai-tags.png';
  await cdp.screenshot(panelShot, 1440, 900);
  check('已截图：' + panelShot, fs.existsSync(panelShot));

  // ---------- 四、真点一下 → 跳到搜图页并带上该词 ----
  // ⚠️ 前置状态一律读 `state.currentView`，**不要读 `state.currentTab`** —— 后者只在侧栏
  //    点击处理器与 showTabContent 的 search/people 分支里被写，上面那句
  //    `showTabContent('folders')` 不会把它复位（实测切走后仍是 'search'）。
  //    拿过时的 currentTab 当前置条件，探针会在第二次运行时假 FAIL。
  const before = await cdp.eval(`(() => ({ view: window.state.currentView, overl: document.getElementById('previewOverlay').classList.contains('active') }))()`);
  const box = await cdp.eval(`(() => {
    const c = document.querySelector('#previewInfoPanelContent .preview-info-tag');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return { hidden: true, r: { x: r.x, y: r.y, w: r.width, h: r.height } };
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: c.getAttribute('data-ai-tag') };
  })()`);
  check('夹具自证：拿到胶囊的屏幕坐标', box && !box.hidden && box.x > 0, JSON.stringify(box));

  if (box && !box.hidden) {
    // 真实鼠标事件（不是 el.click()）—— 命中测试、冒泡、preventDefault 全走真路径
    const mouse = (type) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(box.x),
        y: Math.round(box.y),
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    await mouse('mouseMoved');
    await mouse('mousePressed');
    await mouse('mouseReleased');
    await sleep(1500);

    const after = await cdp.eval(`(() => {
      const input = document.getElementById('aiSearchInput');
      const root = document.documentElement;
      return {
        tab: window.state.currentTab,
        view: window.state.currentView,
        query: input ? input.value : null,
        searchPageOpen: root.classList.contains('search-page-open'),
        overlayActive: document.getElementById('previewOverlay').classList.contains('active'),
      };
    })()`);
    check(
      '点击前不在搜图页（否则这条断言证明不了跳转）',
      before.view !== 'ai_search',
      JSON.stringify(before),
    );
    check(
      '🔴 点胶囊跳到了搜图页（search-page-open 已挂上）',
      after.tab === 'search' && after.searchPageOpen === true,
      JSON.stringify(after),
    );
    check(
      '🔴 搜图框里就是胶囊上的那个词',
      after.query === box.tag,
      JSON.stringify(after.query) + ' vs ' + JSON.stringify(box.tag),
    );
    check(
      '🔴 跳转前预览被关掉（预览是上层遮罩，不关 = 搜图结果渲染在它背后，看着像没反应）',
      after.overlayActive === false,
      JSON.stringify(after),
    );

    const searchShot = OUT_DIR + '/search-page-from-tag.png';
    await cdp.screenshot(searchShot, 1440, 900);
    check('已截图：' + searchShot, fs.existsSync(searchShot));

    // ---------- 四之二、已在搜图页时再点一次（另一条分支） ----
    // `aiViews.search()` 有两条路：不在搜图页 → 词暂存给 enter() 消费；已在搜图页 → 直接搜。
    // 上面走的是前者，这条走后者 —— 分支最容易只修一条。
    const second = await cdp.eval(`(async () => {
      const st = window.state;
      const load = window.loadPreviewInfoPanel;
      const el = document.getElementById('previewInfoPanel');
      const overlay = document.getElementById('previewOverlay');
      const input = document.getElementById('aiSearchInput');
      if (input) input.value = '';           // 清掉，才能看出「又填回来了」
      st.previewPhotos = [{ id: ${PHOTO_ID}, file_name: 'probe.jpg' }];
      st.previewIndex = 0;
      st.previewTotalPhotos = 1;
      el.classList.add('open');
      if (overlay) overlay.classList.add('active');
      load(st.previewPhotos[0]);
      await new Promise((r) => setTimeout(r, 1200));
      const chip = document.querySelector('#previewInfoPanelContent .preview-info-tag');
      if (!chip) return { noChip: true };
      const r = chip.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: chip.getAttribute('data-ai-tag'), viewBefore: st.currentView };
    })()`);
    check(
      '夹具自证：已在搜图页且拿到了第二次点击的坐标',
      !second.noChip && second.viewBefore === 'ai_search',
      JSON.stringify(second),
    );
    if (!second.noChip) {
      const mouse2 = (type) =>
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x: Math.round(second.x),
          y: Math.round(second.y),
          button: 'left',
          buttons: type === 'mousePressed' ? 1 : 0,
          clickCount: 1,
        });
      await mouse2('mouseMoved');
      await mouse2('mousePressed');
      await mouse2('mouseReleased');
      await sleep(1500);
      const again = await cdp.eval(
        `(() => ({ tab: window.state.currentTab, query: document.getElementById('aiSearchInput').value }))()`,
      );
      check(
        '🔴 已在搜图页时点标签同样能把词填回去（另一条分支：直接搜，不经 enter()）',
        again.tab === 'search' && again.query === second.tag,
        JSON.stringify(again) + ' vs ' + JSON.stringify(second.tag),
      );
    }
  }

  // ---------- 五、设置页里这个字段可勾 ----
  const settings = await cdp.eval(`(() => {
    const host = document.getElementById('settingsInfoFields');
    if (!host) return { missing: true };
    const all = Array.from(host.querySelectorAll('input[data-info-field]')).map((b) => b.getAttribute('data-info-field'));
    return { total: all.length, hasAiTags: all.indexOf('ai_tags') >= 0 };
  })()`);
  check('设置页勾选框清单里包含 ai_tags（注册表驱动，自动出现）', settings.hasAiTags === true, JSON.stringify(settings));

  try {
    ws.close();
  } catch (_) {}

  // ------------------------------------------------------------------ 输出
  const failed = results.filter((r) => !r.ok);
  process.stdout.write('[photo-tags-probe] AI 内容标签端到端\n');
  for (const r of results) {
    process.stdout.write('  ' + (r.ok ? '\u2713' : '\u2717') + ' ' + r.name + (r.detail ? '  [' + r.detail + ']' : '') + '\n');
  }
  process.stdout.write('\n');
  if (failed.length) {
    process.stdout.write('[photo-tags-probe] FAIL（' + failed.length + ' / ' + results.length + ' 项）\n');
    process.exit(1);
  }
  process.stdout.write('[photo-tags-probe] PASS（' + results.length + ' 项）\n');
}

main().catch((error) => {
  process.stdout.write('[photo-tags-probe] PROBE ERROR: ' + (error && error.message) + '\n');
  process.exit(2);
});
