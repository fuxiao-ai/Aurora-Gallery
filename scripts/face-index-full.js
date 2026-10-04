'use strict';
/**
 * 全库人脸索引 —— 无界面长跑（释放 scripts/face-live-index-smoke.js 之外的第二个入口）。
 *
 * ## 为什么需要它
 *
 * 应用里**没有**「自动建索引」这条路径：`settings.json` 里的 `faceAutoScanOnStartup`
 * 与 `faceClusterThreshold` 都是死键（`main.js` 里没有一处读它们），建索引只能靠人在
 * 「人物 → 识别设置」里点按钮。而本机的全库是 **1,224,615 张**，按实测 190–230 ms/张
 * 要跑 **60–78 小时** —— 没有人在旁边守三天，也不该让窗口的生死决定索引的生死。
 *
 * ## 它和点按钮有区别吗
 *
 * 没有。走的是完全相同的链路：`FaceService → src/workers/face-worker.js → FaceStore`，
 * 只是不创建窗口，也不装 `canRun` 闸门（闸门是给「两个 AI 任务互斥」用的，这里没有第二个）。
 *
 * ## 可中断、可续跑
 *
 * `scans` 行是**逐张提交**的；worker 的 `batch(after)` 按 `photo_id` 升序取
 * 「还没扫过、或指纹变了」的照片，所以任何时刻杀掉进程，重跑都从断点继续，不会从头再来。
 * 实测：库里已有 6820 张（`photo_id` 324737..331774），重跑的第一批就从 331775 开始。
 *
 * 唯一的破坏性动作是 `purgeStale()`：开始前删掉**非当前 `VERSION`** 的 `scans` 行。
 * 它是一次性的 —— 本次运行时库里已经没有旧版行，是空操作。
 *
 * ## 收尾不自动重聚类
 *
 * worker 收尾时只在 `faces <= AUTO_REGROUP_LIMIT`（8000）时才跑全局聚类。全库预计
 * 约 4.3 万张脸，远超上限，所以 `clustered:false` —— 人物划分就是索引期间增量的结果
 * （这与 LAP「先扫脸、最后整体聚类」的差别已有实测记录，见 docs/people-groups.md）。
 *
 * 用法（推荐 ELECTRON_RUN_AS_NODE：让 Electron 二进制以纯 Node 跑，不起 Browser/GPU 进程）：
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/face-index-full.js
 *
 * 两种启动方式都能跑，差别只在有没有 Browser 进程：
 *   - `ELECTRON_RUN_AS_NODE=1`：**推荐**。原生模块（better-sqlite3 / sharp /
 *     onnxruntime-node）按 Electron 的 ABI 加载，而整条索引链路（FaceService →
 *     face-worker → FaceStore → face-model / logger）**没有任何一处 require('electron')**，
 *     所以用不上 Browser 进程。少一个进程 = 少一份内存，也彻底避开下面这个坑。
 *   - 直接用 `electron script.js`：实测本机会反复报
 *     `GPU process exited unexpectedly`，并偶发
 *     `FATAL: GPU process isn't usable. Goodbye.` 直接带走整个进程（exit 3）。
 *     脚本里已经 `disableHardwareAcceleration()` + `disable-gpu` 两道保险，
 *     但真要跑三天，还是不要那个 GPU 进程更稳。
 *
 *   参数一律追加在后面：
 *     [--minutes N] [--db <photos.db>] [--index <face-index 目录>]
 *     [--log <日志文件>] [--heartbeat <秒>]
 */
const fs = require('node:fs');
const path = require('node:path');
const { FaceService } = require('../src/main/face-service');

// 本脚本从不创建窗口。但这不代表可以不管 Browser 进程：
//   1) 实测本机无窗口启动 Electron 时 GPU 进程会连崩几次，然后
//      `FATAL: GPU process isn't usable. Goodbye.` 直接把整个进程带走（exit 3）——
//      短探针因为退得早看不出来，长跑必须显式关掉硬件加速与 GPU 进程；
//   2) 「最后一个窗口关闭即退出」在从未创建窗口时不会触发，但显式挡一道更稳妥。
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.app) {
    electron.app.disableHardwareAcceleration();
    electron.app.commandLine.appendSwitch('disable-gpu');
    electron.app.commandLine.appendSwitch('disable-gpu-compositing');
    electron.app.on('window-all-closed', () => {});
  }
} catch {
  /* 以 ELECTRON_RUN_AS_NODE 启动时拿不到 app，无所谓 */
}

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const userData = path.join(process.env.LOCALAPPDATA || '', 'aurora-gallery', 'UserData');
const dbPath = arg('db', path.join(userData, 'photos.db'));
const indexPath = arg('index', path.join(userData, 'face-index'));
const logPath = arg('log', path.join(indexPath, 'full-index.log'));
const heartbeatMs = Math.max(5, Number(arg('heartbeat', 30))) * 1000;
const minutes = Number(arg('minutes', 0));

/** 同步写：进程随时可能被杀（或断电），日志必须已经落盘。 */
function log(line) {
  const stamped = '[' + new Date().toISOString() + '] ' + line;
  try {
    fs.appendFileSync(logPath, stamped + '\n');
  } catch {
    /* 日志写不进去也不能让索引停 */
  }
  // stdout 只是给人看的副本，**绝不能让它影响索引**：脱离界面启动时 stdout 可能已经
  // 无效（父进程走了 / 句柄被关），写它就会抛 EPIPE 把整个索引带走。
  try {
    process.stdout.write(stamped + '\n');
  } catch {
    /* ignore */
  }
}

const hours = (ms) => (ms / 3600000).toFixed(1) + 'h';

async function main() {
  log('===== 全库人脸索引：无界面长跑 =====');
  log('db        = ' + dbPath);
  log('index     = ' + indexPath);
  log('log       = ' + logPath);
  log('heartbeat = ' + heartbeatMs / 1000 + 's   auto-stop = ' + (minutes ? minutes + 'min' : '关闭'));

  const service = new FaceService(dbPath, indexPath);
  // 注意：这里**不能**用 `service.refresh()`。`refresh()` 返回的是 `this.status()`，
  // 也就是 `spawn()` 退出时只挑进 state 的那几个键
  // （ready / indexed / processed / failed / skipped / faces / people）——
  // `library` / `recognizer` / `staleScans` 是 `summary()` 里新增的字段，
  // **不在这个白名单里**，用 refresh() 读会全部拿到 undefined（library 变成 0，
  // 于是脚本会误判「全库已索引、无待处理照片」而立刻退出，实测踩过）。
  // `run('status')` 直接 resolve worker 的原样返回，才是完整的 summary。
  const before = await service.run('status');
  const library = Number(before.library) || 0;
  const initialScanned = Number(before.indexed) || 0;
  const target = Math.max(0, library - initialScanned);
  log(
    'before    : ready=' +
      before.ready +
      ' recognizer=' +
      before.recognizer +
      ' library=' +
      library +
      ' indexed=' +
      initialScanned +
      ' faces=' +
      before.faces +
      ' people=' +
      before.people +
      ' staleScans=' +
      before.staleScans +
      ' version=' +
      before.version,
  );
  if (!before.ready) {
    log('ABORT: 模型未就绪（' + path.join(indexPath, 'models') + '）—— 先在应用里下载模型');
    service.dispose();
    return 1;
  }
  if (target === 0) {
    log('DONE: 全库已经是当前识别器的索引，无待处理照片');
    service.dispose();
    return 0;
  }
  log('target    : 本轮需要处理 ' + target + ' 张（library ' + library + ' - 已索引 ' + initialScanned + '）');

  const startedAt = Date.now();
  let lastDone = 0;
  let stalledTicks = 0;
  const timer = setInterval(() => {
    const state = service.status();
    const processed = Number(state.processed) || 0;
    const failed = Number(state.failed) || 0;
    const skipped = Number(state.skipped) || 0;
    const done = processed + failed + skipped;
    const elapsed = Date.now() - startedAt;
    // ETA 只按**真正做了人脸检测**的张数算，把 skipped 当免费：它们只是扩展名不认识的文件，
    // 一次 setImmediate 就过去了。用 done（含 skipped）算会明显偏乐观 —— 本次实测前 400 张里
    // 有 218 张是 skip，按 done 算出来的 ETA 只有按 processed 算的一半。
    // 所以这个数是**上限**：它假定剩下的每一张都是图片。
    const work = processed + failed;
    const perMs = elapsed > 0 ? work / elapsed : 0;
    const remaining = Math.max(0, target - done);
    const etaMs = perMs > 0 ? remaining / perMs : 0;
    const perMinute = elapsed > 0 ? Math.round(work / (elapsed / 60000)) : 0;
    log(
      'progress  done=' +
        done +
        '/' +
        target +
        ' (' +
        ((done / target) * 100).toFixed(2) +
        '%)  processed=' +
        processed +
        ' failed=' +
        failed +
        ' skipped=' +
        skipped +
        '  scanned=' +
        (state.scanned || 0) +
        ' faces=' +
        (state.faces || 0) +
        ' people=' +
        (state.people || 0) +
        '  rate=' +
        perMinute +
        '/min  elapsed=' +
        hours(elapsed) +
        ' eta<=' +
        hours(etaMs) +
        '  file=' +
        (state.currentFile || ''),
    );
    // 卡死检测：连续 10 个心跳没有任何推进就报警（不自动退出 —— 可能只是单张巨图/RAW 慢）。
    if (done === lastDone) {
      stalledTicks++;
      if (stalledTicks === 10)
        log('WARN: 连续 ' + stalledTicks + ' 个心跳没有推进，索引可能卡住（file=' + state.currentFile + '）');
    } else {
      stalledTicks = 0;
      lastDone = done;
    }
  }, heartbeatMs);
  timer.unref();

  if (minutes > 0) {
    const stopper = setTimeout(() => {
      log('auto-stop: 到点（' + minutes + 'min），请求取消（已完成的 scans 行保留，重跑接着来）');
      service.cancel();
    }, minutes * 60000);
    stopper.unref();
  }
  const onSignal = () => {
    log('signal: 收到中断，请求取消');
    service.cancel();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let code = 0;
  try {
    const result = await service.run('index');
    log(
      'DONE      : ' +
        JSON.stringify({
          scanned: result.scanned,
          faces: result.faces,
          people: result.people,
          processed: result.processed,
          failed: result.failed,
          skipped: result.skipped,
          clustered: result.clustered,
        }),
    );
    if (result.clustered === false)
      log(
        'NOTE      : faces 超过 AUTO_REGROUP_LIMIT(8000)，收尾的全局聚类被跳过 —— 人物划分是索引期间增量分组的结果',
      );
  } catch (error) {
    const cancelled = error && error.message === 'AI_CANCELLED';
    log((cancelled ? 'CANCELLED : ' : 'FAILED    : ') + (error && error.message));
    code = cancelled ? 0 : 1;
  } finally {
    clearInterval(timer);
    service.dispose();
    const after = service.status();
    log('final     : phase=' + after.phase + ' scanned=' + (after.scanned || 0) + ' faces=' + (after.faces || 0));
  }
  return code;
}

main().then(
  (code) => {
    log('exit ' + code);
    process.exit(code);
  },
  (error) => {
    log('FATAL     : ' + (error && error.stack ? error.stack : error));
    process.exit(1);
  },
);
