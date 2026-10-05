'use strict';
/* global WebSocket */ // Node 22 有全局 WebSocket，但 ESLint 的 node 环境不认
/**
 * 「照片信息面板显示哪些字段」端到端探针（手动跑，不是回归）。
 *
 * 为什么必须有它：这条链路的每一段单看都自洽 —— 注册表给字段、设置页画勾选框、
 * `updateSettings` 落库、面板按启用集渲染 —— 但**「勾选框 → 落库 → 面板」是跨进程的**：
 * 勾选框的 change 走 `ui-events.js` 的委托、保存走 IPC、回显走 `applyInfoPanelFieldsFromSettings`。
 * 静态检查能证明代码互相引用着，**证明不了点一下真的落库、真的少一行**。
 * 另外两条只有跑起来才暴露的语义也在覆盖范围内：
 *   - 「全不选」必须真的存成空数组（不是回落默认集）；
 *   - 未收藏（`is_favorite = 0`）是有效读数，不能被当成空值吞掉。
 *
 * 用法：
 *   1) 先起一个带调试端口的实例。**必须隔离**，否则会改到本机真实设置与相册：
 *        LOCALAPPDATA='C:/temp/info-fields-probe/isolated' \
 *        env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
 *          --remote-debugging-port=9222 --disable-gpu --disable-gpu-compositing \
 *          --disable-software-rasterizer --no-sandbox . --dev
 *      ⚠️ `--user-data-dir` 对本品无效：`configureWritableAppPaths()` 无条件把 userData
 *      设成 `%LOCALAPPDATA%\<appName>\UserData`，只能注入 LOCALAPPDATA。
 *      ⚠️ 隔离库是空库，实例可能在 ~12s 后自行退出 —— 要在存活窗口内跑完本脚本。
 *   2) PROBE_SETTINGS=<隔离目录>/aurora-gallery/UserData/settings.json \
 *      node scripts/photo-info-fields-probe.js
 *
 * ⚠️ 跑前务必确认调试端口上**恰好 1 个主窗口 target、且没有残留实例**：两个实例共用同一份
 *    settings.json 会互相覆盖，读数会呈现「看似随机」的错乱，据此排查会得出完全错误的结论。
 *
 * 退出码：0 全 PASS / 1 有 FAIL / 2 连不上或不满足前置条件。
 */
const fs = require('fs');

const WAIT = parseInt(process.env.PROBE_WAIT_MS || '700', 10);
const PORT = parseInt(process.env.PROBE_PORT || '9222', 10);
const SETTINGS_PATH =
  process.env.PROBE_SETTINGS ||
  (process.env.LOCALAPPDATA || '') + '\\aurora-gallery\\UserData\\settings.json';

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

  /**
   * 覆盖视口后整窗截图。
   * ⚠️ 本机全局 2x 缩放 → 真实窗口拿不到目标 CSS 视口（求 1440×900 实得 ~713×419），
   *    所以一律用 `Emulation.setDeviceMetricsOverride` 指定 CSS 宽高（deviceScaleFactor
   *    单独给 2，出图翻倍但布局按 CSS 宽算）。
   * ⚠️ **截完不要 clear** —— clear 会还原真实窗口宽，后续截图变成宽屏布局。
   */
  async screenshot(file, cssWidth, cssHeight) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: cssWidth,
      height: cssHeight,
      deviceScaleFactor: 2,
      mobile: false,
    });
    // 等一帧，让布局与 masonry/ResizeObserver 落定
    await new Promise((r) => setTimeout(r, 260));
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }
}

const READ_FORM = `(() => {
  const host = document.getElementById('settingsInfoFields');
  if (!host) return { missing: true };
  const boxes = Array.from(host.querySelectorAll('input[data-info-field]'));
  const ids = window.PhotoInfoFields ? window.PhotoInfoFields.FIELD_IDS : [];
  return {
    total: boxes.length,
    expected: ids.length,
    groups: host.querySelectorAll('.settings-info-field-group').length,
    checked: boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-info-field')),
    onCount: boxes.filter((b) => b.checked).length,
    // 勾选框的可见尺寸：与 theme-polish 的 .settings-page input 同源（不在 styles.css 二次声明）
    boxSize: (() => { const b = boxes[0]; if (!b) return null; const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })(),
    labelSample: Array.from(host.querySelectorAll('.settings-info-field-group-title')).slice(0, 3).map((e) => e.textContent.trim()),
  };
})()`;

/** 与用户手点等价：先改 checked 再冒泡 change（设置页是委托监听） */
function toggle(id, on) {
  return `(() => {
    const el = document.querySelector('#settingsInfoFields input[data-info-field=' + ${JSON.stringify(JSON.stringify(id))} + ']');
    if (!el) return 'NO_EL';
    const before = el.checked;
    el.checked = ${on ? 'true' : 'false'};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return before + ' -> ' + el.checked;
  })()`;
}

function clickBtn(id) {
  return `(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return 'NO_EL'; el.click(); return 'clicked'; })()`;
}

/** 真正走一遍渲染路径：调的是面板自己的渲染函数，不是注册表的裸调用 */
const RENDER_PANEL = (json) => `(() => {
  // 「位置」只来自预览页运行时状态，且本探针第六节会把它设成 3400 —— 这里每次显式清零，
  // 否则同一实例里第二次跑探针时行数会莫名多 1（期望值就不再可复现）。
  state.previewTotalPhotos = 0;
  state.slideshowRandom = false;
  renderPreviewInfoPanel(${JSON.stringify(json)});
  const host = document.getElementById('previewInfoPanelContent');
  const labels = Array.from(host.querySelectorAll('.preview-info-label')).map((e) => e.textContent);
  const values = Array.from(host.querySelectorAll('.preview-info-value')).map((e) => e.textContent);
  const titles = Array.from(host.querySelectorAll('.preview-info-section-title')).map((e) => e.textContent);
  return {
    labels, values, titles, rows: labels.length, html: host.innerHTML.length,
    // 「位置」勾上了也必然缺席（总数已清零）→ 期望行数 = 启用数 - 1
    expectRows: (window.PhotoInfoFields.normalizeFieldIds(state.infoPanelFields).includes('position') ? 1 : 0),
  };
})()`;

/** 面板开着的状态（真面板 + 真浮层 + 真样式表）—— 用 is_favorite = 0 的伪数据顺带验「未收藏」 */
const OPEN_REAL_PANEL = `(() => {
  const ov = document.getElementById('previewOverlay');
  const panel = document.getElementById('previewInfoPanel');
  // 空库开不了预览 → 手动把浮层置为可见。走的仍是 #previewOverlay.active /
  // .preview-info-panel.open 这两条真实规则，量到的宽度与换行都是真样式表的产物
  ov.classList.add('active');
  panel.classList.add('open');
  // 「浏览」那一行只来自预览页运行时状态：给个假总数，好让 6 个分组都能出现（否则恒 5 组）
  state.previewTotalPhotos = 3400;
  state.previewIndex = 0;
  state.slideshowRandom = false;
  renderPreviewInfoPanel({
    id: 1234, file_name: 'DSC0001.JPG', file_path: 'K:/COS/1/DSC0001.JPG',
    folder_path: 'K:/COS/1', root_path: 'K:/COS', file_type: 'JPG', media_kind: 'image',
    width: 4000, height: 3000, file_size: 5242880,
    date_taken: '2024-01-02T03:04:05', date_modified: '2024-01-03T04:05:06',
    is_favorite: 0, has_thumbnail: 1, file_hash: 'a'.repeat(64), dhash: '0123456789abcdef',
    camera_make: 'SONY', camera_model: 'ILCE-7M3', lens_model: 'FE 24-70mm F2.8 GM',
    focal_length: 35, aperture: 2.8, iso_speed: 400, shutter_speed: '1/250',
    gps_latitude: 31.230416, gps_longitude: 121.473701,
  });
  const pr = panel.getBoundingClientRect();
  const rows = Array.from(panel.querySelectorAll('.preview-info-row'));
  return {
    open: ov.classList.contains('active') && panel.classList.contains('open'),
    panelW: Math.round(pr.width),
    panelH: Math.round(pr.height),
    rows: rows.length,
    // 长哈希 / 长路径必须换行而不是把面板撑出横向滚动
    overflowingRows: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
    horizontalScroll: panel.scrollWidth > panel.clientWidth + 1,
    titles: Array.from(panel.querySelectorAll('.preview-info-section-title')).map((e) => e.textContent),
  };
})()`;

const CLOSE_REAL_PANEL = `(() => {
  document.getElementById('previewOverlay').classList.remove('active');
  document.getElementById('previewInfoPanel').classList.remove('open');
  return true;
})()`;


/** 打开设置页并滚到信息面板分组，返回该分组的几何信息（供截图与尺寸断言） */
const OPEN_SETTINGS_GROUP = `(async () => {
  // 必须走应用自己的入口：设置页侧栏那些 [data-settings-section-id] 按钮是**设置页打开后**
  // 才渲染出来的，在浏览态点它们等于什么都没点（踩过：量到的全是 0×0）。
  await openSettingsPage();
  await new Promise((r) => setTimeout(r, 420));
  const nav = document.querySelector('[data-settings-section-id="settingsSectionBrowse"]');
  if (nav) nav.click();
  await new Promise((r) => setTimeout(r, 120));
  const group = document.getElementById('settingsBrowseGroupInfoPanelHeading');
  if (!group) return { missing: true };
  group.scrollIntoView({ block: 'start' });
  const section = group.closest('.settings-browse-group');
  const boxes = Array.from(document.querySelectorAll('#settingsInfoFields input[data-info-field]'));
  const r = boxes[0] ? boxes[0].getBoundingClientRect() : null;
  const gr = section ? section.getBoundingClientRect() : null;
  return {
    boxSize: r ? Math.round(r.width) + 'x' + Math.round(r.height) : null,
    // 勾选框不能与文字重叠：文字左边界必须落在方框右边界之后
    labelGap: (() => {
      const sp = boxes[0] && boxes[0].nextElementSibling;
      if (!r || !sp) return null;
      return Math.round(sp.getBoundingClientRect().left - r.right);
    })(),
    gridCols: (() => {
      const grid = document.querySelector('#settingsInfoFields .settings-info-field-grid');
      if (!grid) return null;
      return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    })(),
    groupRect: gr ? { x: Math.round(gr.x), y: Math.round(gr.y), w: Math.round(gr.width), h: Math.round(gr.height) } : null,
  };
})()`;



function diskFields() {
  try {
    const o = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { fields: o.infoPanelFields };
  } catch (e) {
    return { error: String(e && e.message) };
  }
}

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  PASS  ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}

(async () => {
  const ws = new WebSocket(await pageWsUrl());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new Cdp(ws);

  // ---------------------------------------------------------- 0. 归零
  // 探针必须可重复跑：先把字段集恢复成默认（上一次跑可能停在任何状态，包括中途被
  // `| head` 掐断留下的半套勾选），否则后面每条「默认集 = 21」的断言都会随历史漂移。
  console.log('零、归零：先点「恢复默认」');
  console.log('  ' + (await cdp.eval(clickBtn('settingsInfoFieldsResetBtn'))));
  await sleep(WAIT);
  const dPre = diskFields();
  check('起步就是默认集 21 个', Array.isArray(dPre.fields) && dPre.fields.length === 21,
    JSON.stringify(dPre.fields && dPre.fields.length));

  // ---------------------------------------------------------- 1. 设置页勾选框
  console.log('一、设置页勾选框（形状完全由注册表生成）');
  const f0 = await cdp.eval(READ_FORM);
  console.log('  ' + JSON.stringify(f0));
  check('注册表已加载且勾选框数量 = 字段数', f0.total === f0.expected, `${f0.total} vs ${f0.expected}`);
  check('6 个分组都画出来了', f0.groups === 6, String(f0.groups));
  check('默认勾选数与注册表默认集一致（21）', f0.onCount === 21, String(f0.onCount));
  check('分组小标题是中文', f0.labelSample[0] === '基本信息', JSON.stringify(f0.labelSample));

  // 面板没打开时 getBoundingClientRect 恒为 0 —— 必须先把设置页打开再量尺寸
  console.log('\n一之二、设置页真实几何（打开设置页后才量得到）');
  const shotFile = process.env.PROBE_SHOT || 'C:/temp/info-fields-probe/settings-info-fields.png';
  await cdp.screenshot(shotFile, 1440, 1000);
  const viewport = await cdp.eval('({ w: window.innerWidth, h: window.innerHeight })');
  const geo = await cdp.eval(OPEN_SETTINGS_GROUP);
  console.log('  innerWidth=' + viewport.w + '  ' + JSON.stringify(geo));
  check('视口覆盖生效（CSS 宽 = 1440，不是被 2x 缩放后的 ~713）', viewport.w === 1440, String(viewport.w));
  check('勾选框尺寸与 settings-page 同源（16px）', geo.boxSize === '16x16', String(geo.boxSize));
  check('勾选框与标签不重叠（gap > 0）', geo.labelGap > 0, String(geo.labelGap));
  check('分组有实际高度', geo.groupRect && geo.groupRect.h > 200, JSON.stringify(geo.groupRect));
  check('勾选框排成多列网格（auto-fill 生效）', geo.gridCols >= 2, String(geo.gridCols));
  console.log('  截图: ' + shotFile);

  // ---------------------------------------------------------- 2. 面板按启用集渲染
  console.log('\n二、面板真的按启用集裁剪（走 renderPreviewInfoPanel）');
  const SAMPLE = {
    id: 1234,
    file_name: 'DSC0001.JPG',
    file_path: 'K:/COS/1/DSC0001.JPG',
    folder_path: 'K:/COS/1',
    root_path: 'K:/COS',
    file_type: 'JPG',
    media_kind: 'image',
    width: 4000,
    height: 3000,
    file_size: 5 * 1024 * 1024,
    date_taken: '2024-01-02T03:04:05',
    date_modified: '2024-01-03T04:05:06',
    is_favorite: 0,
    has_thumbnail: 1,
    file_hash: 'a'.repeat(64),
    dhash: '0123456789abcdef',
    camera_make: 'SONY',
    camera_model: 'ILCE-7M3',
    lens_model: 'FE 24-70mm F2.8 GM',
    focal_length: 35,
    aperture: 2.8,
    iso_speed: 400,
    shutter_speed: '1/250',
    gps_latitude: 31.230416,
    gps_longitude: 121.473701,
  };
  const r0 = await cdp.eval(RENDER_PANEL(SAMPLE));
  console.log('  分组: ' + JSON.stringify(r0.titles));
  console.log('  字段: ' + JSON.stringify(r0.labels));
  // 默认集 21 个字段里，「位置」只来自预览页运行时状态；空库里 previewTotalPhotos = 0
  // → 该行必然缺席，所以期望是 21 - 1 = 20（expectRows 就是这条口径）。
  check('默认集除「位置」外全部上屏', r0.rows === 21 - r0.expectRows, String(r0.rows));
  check('「未收藏」是有效读数（is_favorite = 0 不被吞掉）', r0.values.includes('未收藏'));
  check('新增字段都在：文件夹 / 媒体类型 / 宽高比 / 总像素', 
    r0.labels.includes('所在文件夹') && r0.labels.includes('媒体类型') &&
    r0.labels.includes('宽高比') && r0.labels.includes('总像素'),
    JSON.stringify(r0.labels));
  check('「浏览」分组没有 position 时整组不出现', !r0.titles.includes('浏览'), JSON.stringify(r0.titles));
  check('默认关掉的原始值字段不出现（哈希 / ID / 缩略图 / 所属图库）',
    !r0.labels.includes('文件哈希') && !r0.labels.includes('感知哈希') &&
    !r0.labels.includes('照片 ID') && !r0.labels.includes('缩略图') && !r0.labels.includes('所属图库'),
    JSON.stringify(r0.labels));

  // ---------------------------------------------------------- 3. 取消勾选 → 落库 → 面板少一行
  console.log('\n三、取消「宽高比」→ 落库 → 面板立刻少一行');
  console.log('  ' + (await cdp.eval(toggle('aspect_ratio', false))));
  await sleep(WAIT);
  const d1 = diskFields();
  check('落库的 infoPanelFields 不含 aspect_ratio',
    Array.isArray(d1.fields) && !d1.fields.includes('aspect_ratio'),
    JSON.stringify(d1.fields));
  check('落库条数 20', Array.isArray(d1.fields) && d1.fields.length === 20, JSON.stringify(d1.fields && d1.fields.length));
  const r1 = await cdp.eval(RENDER_PANEL(SAMPLE));
  check(
    '面板少一行且不再有「宽高比」',
    r1.rows === 20 - r1.expectRows && !r1.labels.includes('宽高比'),
    String(r1.rows),
  );
  const f1 = await cdp.eval(READ_FORM);
  check('勾选框回显同步（20）', f1.onCount === 20, String(f1.onCount));

  // ---------------------------------------------------------- 4. 勾上原始值字段
  console.log('\n四、勾上「感知哈希 / 照片 ID」→ 面板出现原始值行');
  console.log('  ' + (await cdp.eval(toggle('dhash', true))));
  await sleep(WAIT);
  console.log('  ' + (await cdp.eval(toggle('photo_id', true))));
  await sleep(WAIT);
  const r2 = await cdp.eval(RENDER_PANEL(SAMPLE));
  check('感知哈希上屏', r2.labels.includes('感知哈希') && r2.values.includes('0123456789abcdef'));
  check('照片 ID 上屏', r2.labels.includes('照片 ID') && r2.values.includes('1234'));
  check('行数 = 20 + 取消的宽高比复原不算、新增 2 条', r2.rows === 22 - r2.expectRows, String(r2.rows));

  // ---------------------------------------------------------- 5. 全选 / 全不选 / 恢复默认
  console.log('\n五、全选 / 全不选 / 恢复默认');
  console.log('  ' + (await cdp.eval(clickBtn('settingsInfoFieldsSelectAllBtn'))));
  await sleep(WAIT);
  const d2 = diskFields();
  check('全选 → 落库 26 个字段', Array.isArray(d2.fields) && d2.fields.length === 26, JSON.stringify(d2.fields && d2.fields.length));
  const rAll = await cdp.eval(RENDER_PANEL({ ...SAMPLE, gps_latitude: 31.23, gps_longitude: 121.47 }));
  check(
    '全选 → 面板 26 行（含所属图库 / 哈希 / 缩略图）',
    rAll.rows === 26 - rAll.expectRows,
    String(rAll.rows),
  );

  console.log('  ' + (await cdp.eval(clickBtn('settingsInfoFieldsClearAllBtn'))));
  await sleep(WAIT);
  const d3 = diskFields();
  check('🔴 全不选 → 落库的是空数组（不是回落默认集）',
    Array.isArray(d3.fields) && d3.fields.length === 0, JSON.stringify(d3.fields));
  const rNone = await cdp.eval(RENDER_PANEL(SAMPLE));
  check('全不选 → 面板走占位文案、零行',
    rNone.rows === 0 && rNone.html > 0, String(rNone.rows));
  const fNone = await cdp.eval(READ_FORM);
  check('全不选 → 勾选框全部取消', fNone.onCount === 0, String(fNone.onCount));

  console.log('  ' + (await cdp.eval(clickBtn('settingsInfoFieldsResetBtn'))));
  await sleep(WAIT);
  const d4 = diskFields();
  check('恢复默认 → 落库回默认集 21 个',
    Array.isArray(d4.fields) && d4.fields.length === 21, JSON.stringify(d4.fields && d4.fields.length));
  check('恢复默认 → 顺序与注册表一致（不是按点击顺序）',
    Array.isArray(d4.fields) &&
      JSON.stringify(d4.fields) ===
        JSON.stringify([
          'file_name', 'file_path', 'folder_path', 'file_type', 'media_kind', 'dimensions',
          'aspect_ratio', 'megapixels', 'file_size', 'is_favorite', 'date_taken', 'date_modified',
          'focal_length', 'aperture', 'iso_speed', 'shutter_speed', 'camera_make', 'camera_model',
          'lens_model', 'gps', 'position',
        ]),
    JSON.stringify(d4.fields));

  // ---------------------------------------------------------- 6. 真实面板几何（全选 = 最坏情况）
  console.log('\n六、真实面板几何：全选 26 字段（最坏情况，长哈希必须换行而不是撑破面板）');
  console.log('  ' + (await cdp.eval(clickBtn('settingsInfoFieldsSelectAllBtn'))));
  await sleep(WAIT);
  const real = await cdp.eval(OPEN_REAL_PANEL);
  console.log('  ' + JSON.stringify(real));
  check('面板真的打开且拿到实际宽度（360px 档）', real.open && real.panelW === 360, String(real.panelW));
  check('6 个分组齐备（含只来自运行时状态的「浏览」）', real.titles.length === 6, JSON.stringify(real.titles));
  check('全选 26 个字段时 26 行都在（position 给了假总数）', real.rows === 26, String(real.rows));
  check('长值不撑破行（零条横向溢出）', real.overflowingRows === 0, String(real.overflowingRows));
  check('面板本身无横向滚动条', real.horizontalScroll === false);
  const panelShot = 'C:/temp/info-fields-probe/info-panel-all-fields.png';
  await cdp.screenshot(panelShot, 1440, 1000);
  console.log('  截图: ' + panelShot);
  await cdp.eval(CLOSE_REAL_PANEL);

  // ---------------------------------------------------------- 7. 磁盘与界面同源
  console.log('\n七、磁盘与界面同源');
  console.log('  ' + (await cdp.eval(clickBtn('settingsInfoFieldsResetBtn'))));
  await sleep(WAIT);
  const d5 = diskFields();
  const fLast = await cdp.eval(READ_FORM);
  check(
    '界面勾选数与落库条数一致',
    fLast.onCount === (d5.fields || []).length,
    `${fLast.onCount} vs ${(d5.fields || []).length}`,
  );
  check('收尾回到默认集 21（探针跑完不留脏设置）',
    Array.isArray(d5.fields) && d5.fields.length === 21, JSON.stringify(d5.fields && d5.fields.length));

  console.log(`\n===== 合计 PASS ${pass} / FAIL ${fail} =====`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('PROBE ERROR ' + (e && e.message ? e.message : e));
  process.exit(2);
});
