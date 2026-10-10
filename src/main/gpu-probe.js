'use strict';

/**
 * 「这台机器有没有可用的 GPU 加速」——**这一个判断**，以及它的唯一记录处。
 *
 * ## 为什么值得单独一个模块
 *
 * 判据本身不复杂，复杂的是**围绕它的四种错误做法**，每一种都在别处踩过：
 *
 *  1. 🔴 **靠推断而不是实测**：`process.platform === 'win32'`、包里有没有 `DirectML.dll`、
 *     `onnxruntime-node#listSupportedBackends()` —— 三条都答不了「这台机器能不能用」。
 *     前两条显然；第三条的坑在于它返回的是**编译进包的 EP 列表**（直接来自原生绑定的
 *     `GetAvailableProviders()`），与「本机能不能创建设备」是两件事 ——
 *     本机实测它连 `webgpu` 都列出来（本工程从未验证过 webgpu 可用，也没有任何代码路径用它）。
 *     本模块只认一条：`InferenceSession.create(..., {executionProviders:['dml']})` 真的成功，
 *     且跑出正确数值（详见 `src/workers/gpu-probe-worker.js`）。
 *  2. 🔴 **静默回落**：「dml 不可用」与「dml 可用但这条任务只快 0.95×」是**两种完全不同的
 *     结果**。前者是环境问题、后者是取舍问题，日志里混成一句「已回退 CPU」，下一个人就会
 *     以为这台机器没显卡。所以回落**必须** `logger.warn`，且带上失败原因原文。
 *  3. 🔴 **在主进程里探测**：ORT 的 `InferenceSession.create` 看似 async，实则把
 *     `loadModel` 放在 `setImmediate`（本线程下一个 tick）里同步执行 —— 实测本机用 dml 建
 *     一个小模型要 **约 2.0 秒**。放主进程就是开机白冻 2 秒。所以这里只负责**派 worker**。
 *  4. 🔴 **让取值域漂**：`provider` 只有 `'cpu' | 'dml'` 两个合法取值，任何别的东西
 *     （包括 `undefined` / 上游改名）都必须**归一到 cpu**，不许透传 —— 透传的下场是
 *     下游 `executionProviders: [undefined]` 静默回落，或者更糟：写进索引清单里变成脏值。
 *
 * ## 结果落在哪
 *
 * `<aiPath>/gpu.json`：**跨进程**读得到的唯一一份。worker 拿不到主进程的内存，
 * 需要知道「能不能用 dml」时只能读这个文件（或由主进程经 `workerData` 传进去），
 * 不许各自推断一遍 —— 两份推断必然漂。
 *
 * 每次启动都重新探测（不拿旧文件当结论）：驱动更新、换卡、笔记本的独显直连开关
 * 都会改变答案，而这些东西一年变好几次。旧文件只用于「本次探测还没跑完时界面先显示
 * 上一次的值」，并且会被打上 `stale: true` —— 让「还没测」和「测过不可用」在界面上可区分。
 */

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

/** 唯一合法的两个取值。别处若出现第三个值，就是漂了。 */
const PROVIDER_CPU = 'cpu';
const PROVIDER_DML = 'dml';

/** 探测结果的落盘文件名（相对 `aiPath`）。worker 侧靠它对齐，改名必两处同改。 */
const FILE_NAME = 'gpu.json';

/**
 * 探测模型的期望数值。**与 `src/workers/gpu-probe-worker.js` 里的常量同源**，
 * 守护脚本会逐字比对两边 —— 只有一边改会让「数值校验」变成永远通过的假检查。
 */
const PROBE_INPUT_VALUE = 0.5;
const PROBE_EXPECTED = 4.5;

/** 探测超时。dml 建会话正常约 2 秒；坏驱动可能挂死，所以必须有上限。 */
const PROBE_TIMEOUT_MS = 60000;

function verdictPath(aiPath) {
  return path.join(aiPath, FILE_NAME);
}

/**
 * 把任意输入归一到合法判据。**这是防「脏值透传」的唯一闸门**：
 * 调用方（磁盘上的旧文件、IPC 传回来的对象、上游改名后的字段）给什么都不能直接信。
 *
 * `available` 的判据是**两个条件的合取**：provider 必须是 dml，且必须真的算出了正确数值。
 * 少了后者，「建了会话但全部节点回退 CPU」会被误判成可用。
 */
function normalize(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const provider = raw.provider === PROVIDER_DML ? PROVIDER_DML : PROVIDER_CPU;
  const verified = raw.verified !== false; // 缺失视为通过（旧文件没有这一位），显式 false 才否决
  const available = provider === PROVIDER_DML && verified && raw.ok !== false;
  return {
    available,
    provider: available ? PROVIDER_DML : PROVIDER_CPU,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    createMs: Number.isFinite(raw.createMs) ? raw.createMs : 0,
    runMs: Number.isFinite(raw.runMs) ? raw.runMs : 0,
    verified,
    checkedAt: Number.isFinite(raw.checkedAt) ? raw.checkedAt : Date.now(),
    stale: raw.stale === true,
  };
}

/** 读上一次的落盘结果。取不到 / 坏了都返回 `null`（不抛：探测失败不该打挂调用方）。 */
function readVerdict(aiPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(verdictPath(aiPath), 'utf8'));
    return normalize({ ...parsed, stale: true });
  } catch (_) {
    return null;
  }
}

/** 原子落盘（tmp + rename）：写一半被强杀不会留下坏 JSON。失败静默 —— 探测结果不值得抛。 */
function writeVerdict(aiPath, verdict) {
  try {
    fs.mkdirSync(aiPath, { recursive: true });
    const file = verdictPath(aiPath);
    const payload = JSON.stringify(normalize(verdict), null, 2);
    fs.writeFileSync(file + '.tmp', payload);
    fs.renameSync(file + '.tmp', file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 真正派一次探测：起 worker → 等一条消息 → 收 worker。
 *
 * ⚠️ `worker.unref()` 是必须的：探测挂死时不能把应用钉在退出流程里。
 * 超时走 `terminate()`，返回的 reason 是 `GPU_PROBE_TIMEOUT`（区别于 ORT 抛的原文）。
 */
function spawnProbeWorker({ workerFile, modelPath, timeoutMs = PROBE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    let worker;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) {
        worker.removeAllListeners();
        void worker.terminate().catch(() => {});
      }
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'GPU_PROBE_TIMEOUT' }), timeoutMs);
    try {
      worker = new Worker(workerFile, { workerData: { modelPath } });
      worker.unref();
    } catch (error) {
      finish({ ok: false, reason: error && error.message ? error.message : String(error) });
      return;
    }
    worker.on('message', (message) => finish(message || { ok: false, reason: 'GPU_PROBE_NO_MESSAGE' }));
    worker.on('error', (error) =>
      finish({ ok: false, reason: error && error.message ? error.message : String(error) }),
    );
    worker.on('exit', (code) => finish({ ok: false, reason: 'GPU_PROBE_EXIT_' + code }));
  });
}

/**
 * 建一个「每次启动只探一次」的探测器。
 *
 * `spawn` 可注入 —— 回归脚本靠它喂「建会话失败」这类分支，不必真的去折腾显卡
 * （判据在模块里才可能被行为断言覆盖，这条是本工程 `ai-index-gate.js` 立下的规矩）。
 *
 * @param {object} options
 * @param {string} options.aiPath       结果落盘目录
 * @param {object} [options.logger]     `{log, warn}`；回落必须走 warn
 * @param {Function} [options.spawn]    () => Promise<{ok, provider?, reason?, createMs?, runMs?}>
 * @param {number} [options.timeoutMs]
 */
function createGpuProbe({ aiPath, logger, spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const log = logger || { log() {}, warn() {} };
  let pending = null;
  let verdict = null;

  function spawnDefault() {
    return spawnProbeWorker({
      workerFile: path.join(__dirname, '..', 'workers', 'gpu-probe-worker.js'),
      modelPath: path.join(__dirname, '..', 'ai', 'ep-probe.onnx'),
      timeoutMs,
    });
  }

  /**
   * 探一次并把结论记下来。**同一个进程里只探一次**（memo）：
   * 重复探测的代价是又起一个 worker、又初始化一遍 D3D12 设备，而答案在一次启动内不会变。
   */
  function ensure() {
    if (pending) return pending;
    pending = (async () => {
      // ⚠️ 整段包起来：探测失败**绝不能**变成未处理的 Promise 拒绝（调用端是 `void ensure()`，
      //    一个 reject 只会换来一条没人看的 unhandledRejection，而结论却是「没有结论」）。
      //    任何一步炸掉都归到「不可用 + 原因」，与「建会话失败」走同一条回落路径。
      try {
        const raw = await (spawn || spawnDefault)();
        verdict = normalize({ ...(raw || {}), checkedAt: Date.now(), stale: false });
      } catch (error) {
        verdict = normalize({
          ok: false,
          reason: error && error.message ? error.message : String(error),
          checkedAt: Date.now(),
        });
      }
      if (verdict.available) {
        log.log(
          '[gpu] 硬件加速可用：DirectML（建会话 ' +
            verdict.createMs +
            ' ms、首次推理 ' +
            verdict.runMs +
            ' ms）',
        );
      } else {
        // 🔴 这条 warn 不是可选项。静默回落会让人以为跑的是 GPU，而实际上整条链路都在 CPU 上，
        //    于是「换了显卡怎么没变快」这类问题永远查不出原因。
        log.warn(
          '[gpu] 硬件加速不可用，已回落 CPU：' +
            (verdict.reason || '未给出原因') +
            '（本次启动的 AI 任务全部走 CPU）',
        );
      }
      writeVerdict(aiPath, verdict);
      return verdict;
    })();
    return pending;
  }

  /**
   * 当前结论。还没探完时给「上一次的落盘值 + stale」，都没有则给 `null` ——
   * 界面据此区分「还没测」（未知）与「测过、不可用」（CPU），别把两者显示成同一句话。
   */
  function current() {
    if (verdict) return { ...verdict };
    const last = aiPath ? readVerdict(aiPath) : null;
    return last;
  }

  return { ensure, current };
}

module.exports = {
  PROVIDER_CPU,
  PROVIDER_DML,
  FILE_NAME,
  PROBE_INPUT_VALUE,
  PROBE_EXPECTED,
  PROBE_TIMEOUT_MS,
  verdictPath,
  normalize,
  readVerdict,
  writeVerdict,
  spawnProbeWorker,
  createGpuProbe,
};
