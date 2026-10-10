'use strict';
/**
 * 「切换照片时照片信息不刷新」的**真实 change 探针**（人工跑，不进 run-regressions.js）。
 *
 * 为什么单独留一个探针而不是只写静态守护：这次的 bug 是**接线漏了**（切图路径没有重画面板），
 * 静态守护能钉住接线，但钉不住「接上了到底有没有效果」。本探针加载**真实** `src/renderer/index.html`
 * （真实 app.js / preview-flow.js / ui-preview.js），只桩数据层，把整条链路真的走一遍。
 *
 * 断言：
 *   A  打开面板 → 显示第 1 张
 *   B  走 `navigatePreview(1)`（键盘 ←/→ 与幻灯片切图走的就是它）→ 面板**必须**变成第 2 张
 *      （修复前这里恒为第 1 张，就是用户报的现象）
 *   B2 切图后面板仍开着（别用「顺手把面板关掉」蒙混过去）
 *   B3 连续再切一次 → 第 3 张
 *   C  竞态：第 1 张的 getPhotoInfo 故意慢 400 ms，连切到第 2 张 → 面板最终**必须**仍是第 2 张
 *      （少了代号守卫会「显示第 2 张、读数是第 1 张」）
 *   D  面板关着时切图不产生多余 IPC（守「没开就返回」）
 *
 * 用法（⚠️ 本机 shell 里 `ELECTRON_RUN_AS_NODE=1` 是预设的，必须显式去掉，否则 Electron 会以
 * node 模式启动、`require('electron')` 拿到的是路径字符串而不是模块）：
 *
 *   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/preview-info-refresh-probe.js
 *
 * 退出码 0 = ALL PASS，1 = 有 FAIL。反向验证过：把 app.js 里切图那句
 * `refreshOpenPreviewInfoPanel(state.previewPhotos[index])` 摘掉 ⇒ B/B3 变红；
 * 把 patchInfo 的 `seq !== previewInfoLoadSeq` 摘掉 ⇒ 只有 C 变红。
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// 本机沙箱里 GPU 进程会崩（exit_code=-1073741819）并把 loadFile 一起带失败
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const logs = [];
  win.webContents.on('console-message', (event) => {
    logs.push(String((event && event.message) || ''));
  });
  await win.loadFile(INDEX);
  await sleep(300);

  // 夹具自证：真实页面上这些全局必须都在（否则测的不是这份代码）
  const seeded = await win.webContents.executeJavaScript(`
    (function () {
      window.photoAPI = window.photoAPI || {};
      window.__calls = [];
      window.photoAPI.getPhotoInfo = function (id) {
        var delay = window.__delayFor === id ? 400 : 0;
        window.__calls.push('info:' + id);
        return new Promise(function (res) {
          setTimeout(function () {
            window.__calls.push('info-resolved:' + id);
            res({ id: id, file_name: 'PHOTO-' + id + '.JPG', file_type: 'JPG',
                  folder_path: 'K:/COS/1', file_size: 1024, is_favorite: 0,
                  width: 4000, height: 3000 });
          }, delay);
        });
      };
      window.photoAPI.getPhotoDimensions = function () {
        return Promise.resolve({ width: 4000, height: 3000 });
      };
      window.photoAPI.getPhotoAiTags = function () { return Promise.resolve([]); };

      for (var name of ['state', 'openPreview', 'navigatePreview', 'togglePreviewInfoPanel',
                        'refreshOpenPreviewInfoPanel', 'loadPreviewInfoPanel']) {
        if (name === 'state') {
          if (typeof window.state !== 'object' || !window.state) return { ok: false, why: 'no window.state' };
        } else if (typeof window[name] !== 'function') {
          return { ok: false, why: 'no window.' + name };
        }
      }
      if (!document.getElementById('previewInfoPanel')) return { ok: false, why: 'no #previewInfoPanel' };

      function mk(id) {
        return { id: id, file_name: 'PHOTO-' + id + '.JPG', file_type: 'JPG',
                 folder_path: 'K:/COS/1', file_size: 1024, is_favorite: 0,
                 width: 4000, height: 3000, has_thumbnail: 0 };
      }
      window.state.currentPhotos = [mk(1), mk(2), mk(3)];
      window.state.previewPhotos = [mk(1), mk(2), mk(3)];
      window.state.previewTotalPhotos = 3;
      window.state.page = 1;
      window.state.pageSize = 20;
      window.state.previewPageStart = 1;
      window.state.previewTotalPages = 1;
      return { ok: true };
    })()
  `);
  if (!seeded.ok) {
    console.log('[preview-info-refresh-probe] 夹具自证失败：' + seeded.why);
    app.exit(1);
    return;
  }

  const text = () =>
    win.webContents.executeJavaScript(
      "document.getElementById('previewInfoPanelContent').innerText.replace(/\\s+/g, ' ').trim()",
    );
  const isOpen = () =>
    win.webContents.executeJavaScript(
      "document.getElementById('previewInfoPanel').classList.contains('open')",
    );
  const which = (t) => ((t.match(/PHOTO-\d+\.JPG/g) || [])[0] || '(none)');

  const results = [];
  const run = (js) => win.webContents.executeJavaScript(js);

  // A. 打开面板看第 1 张
  await run('window.state.previewIndex = 0; window.openPreview(0);');
  await run('window.togglePreviewInfoPanel();');
  await sleep(200);
  let t = await text();
  results.push(['A 打开面板显示第 1 张', which(t) === 'PHOTO-1.JPG', which(t)]);

  // B. 键盘 / 幻灯片那条路切到第 2 张 —— 修复前恒为 PHOTO-1.JPG
  await run('window.navigatePreview(1);');
  await sleep(200);
  t = await text();
  results.push(['B navigatePreview(1) 后面板变第 2 张', which(t) === 'PHOTO-2.JPG', which(t)]);

  const stillOpen = await isOpen();
  results.push(['B2 切图后面板仍开着', stillOpen === true, String(stillOpen)]);

  await run('window.navigatePreview(1);');
  await sleep(200);
  t = await text();
  results.push(['B3 再切一次 → 第 3 张', which(t) === 'PHOTO-3.JPG', which(t)]);

  // C. 竞态：第 1 张慢回包，连切到第 2 张
  await run('window.__delayFor = 1; window.__calls.length = 0; window.openPreview(0);');
  await sleep(30);
  await run('window.__delayFor = 0; window.openPreview(1);');
  await sleep(700); // 等那个 400ms 的慢回包也回来
  t = await text();
  results.push(['C 慢回包不许覆盖：仍是第 2 张', which(t) === 'PHOTO-2.JPG', which(t)]);

  // D. 面板关着时切图不拉 IPC
  await run("document.getElementById('previewInfoPanelClose').click();");
  await sleep(50);
  await run('window.__calls.length = 0; window.openPreview(2);');
  await sleep(150);
  const calls = await run('window.__calls.slice()');
  results.push([
    'D 面板关着时切图不拉 IPC',
    calls.filter((c) => c.indexOf('info:') === 0).length === 0,
    JSON.stringify(calls),
  ]);

  console.log('[preview-info-refresh-probe] 结果');
  let fail = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) fail += 1;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '   [' + detail + ']');
  }
  const interesting = logs.filter((m) => !/photoAPI method unavailable|Security Warning|unsafe-eval/.test(m));
  if (interesting.length) console.log('\nconsole: ' + interesting.slice(0, 5).join(' | '));
  console.log(
    '\n[preview-info-refresh-probe] ' + (fail ? 'FAIL（' + fail + ' 项）' : 'ALL PASS'),
  );
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.log('[preview-info-refresh-probe] 异常: ' + (err && err.stack ? err.stack : err));
    app.exit(1);
  }),
);
