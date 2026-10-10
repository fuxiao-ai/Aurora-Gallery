'use strict';

/**
 * 启动期 GPU（DirectML）能力探测 —— **真正跑一次**的那一半。
 *
 * ## 为什么必须在独立 worker 里跑
 *
 * `onnxruntime-node` 的 `InferenceSession.create` 看起来是 async，实际上：
 *
 *   `dist/backend.js#createInferenceSessionHandler` 把 `new OnnxruntimeSessionHandler(...)`
 *   放在 `setImmediate` 里 —— `setImmediate` 是**本线程的下一个 tick**，不是线程池。
 *   所以 `loadModel`（含 DirectML 设备初始化 + 图编译）是**同步阻塞主线程**的。
 *
 * 实测：本机用 `dml` 建这个 168 字节的小模型要 **约 2.0 秒**（cpu 只要 153 ms），
 * 其中绝大部分是 D3D12 设备与 DML 适配器初始化。放在主进程就是开机多冻 2 秒，
 * 而本工程有 `eventLoop.maxDelayMs` 这条红线盯着主线程阻塞 —— 不能这么干。
 * 因此探测整体挪进 worker：主线程只负责收一条消息。
 *
 * ## 为什么判据是「建会话成功」而不是别的
 *
 * 三条更省事的路都是假的：
 *   · `process.platform === 'win32'` —— 无 DX12 设备 / 驱动太老 / 虚拟机里照样是 win32；
 *   · `onnxruntime-node#listSupportedBackends()` —— 它返回的是**编译进包**的 EP 列表
 *     （来自原生绑定的 `GetAvailableProviders()`），答不了「本机能不能创建设备」：
 *     本机实测它连 `webgpu` 都列出来，而本工程没有任何代码路径用 webgpu、也从未验证它可用；
 *   · `DirectML.dll` 在不在包里 —— 在也不代表能创建设备。
 * 唯一可信的是**让 ORT 真的建一个 dml 会话**：它抛错就是不可用，且抛出的错误原文
 * 正是产品回落时要写进日志的那句。
 *
 * ⚠️ 失败**不需要**等满超时：EP 不存在时 ORT 在 **1 ms 内**就抛
 *    `no available backend found. ERR: [dml] backend not found.`（本机实测）。
 *    所以 60 s 的超时只对付「驱动把设备创建挂死」这一种情形。
 *
 * ## 为什么建完还要 `run()` 一次
 *
 * DML 的图编译发生在**第一次 `run()`**（不是建会话时）。一个坏驱动可以让建会话成功、
 * 一跑就崩。「能建会话」只证明设备在，「能算出正确结果」才证明它真的在算。
 * 这里喂常数输入（全 0.5）+ 全 1 卷积核 ⇒ 输出**每个分量都必须正好是 4.5**，
 * 于是「返回了有限值」这种弱检查被换成了「数值对不对」这种强检查。
 *
 * ⚠️ 本 worker **只建一个 EP 的会话**：计时纪律要求单进程单 EP。横比速度必须另起进程，
 *    同一个进程里先后跑 cpu 与 dml 会互相抢核心、并把首次图编译摊到少量样本上（踩过）。
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const ort = require('onnxruntime-node');

/** 与 `src/main/gpu-probe.js#PROBE_INPUT/EXPECTED` 同源；改一处必改另一处（守护会比对）。 */
const INPUT_VALUE = 0.5;
const EXPECTED = 4.5;
const ELEMENTS = 64;
const DIMS = [1, 1, 8, 8];

function report(payload) {
  parentPort.postMessage(payload);
}

(async () => {
  const modelPath = workerData && workerData.modelPath;
  let createMs = 0;
  try {
    if (!modelPath) throw new Error('GPU_PROBE_MODEL_MISSING');
    // ⚠️ 走 buffer 而不是路径：文件会被打进 asar，而 ORT 的 C++ 层用 std::ifstream 读路径，
    //    看不见 asar 虚拟文件系统（Electron 只给 Node 的 fs 打了补丁）。读成 Buffer 再喂进去，
    //    打包与开发两种形态才都能work。
    const bytes = fs.readFileSync(modelPath);
    const t0 = Date.now();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['dml'],
      interOpNumThreads: 1,
      logSeverityLevel: 3,
    });
    createMs = Date.now() - t0;
    try {
      const data = new Float32Array(ELEMENTS).fill(INPUT_VALUE);
      const t1 = Date.now();
      const outputs = await session.run({ x: new ort.Tensor('float32', data, DIMS) });
      const runMs = Date.now() - t1;
      const output = outputs[Object.keys(outputs)[0]];
      const values = Array.from(output.data);
      let worst = 0;
      for (const value of values) worst = Math.max(worst, Math.abs(value - EXPECTED));
      report({
        ok: true,
        provider: 'dml',
        createMs,
        runMs,
        dims: output.dims,
        // 数值正确 ⇒ 这台机器的 DML 真的在算，而不是「建了个会话然后全部回退 CPU」。
        verified: worst < 1e-4,
        maxDeviation: worst,
      });
    } finally {
      await session.release();
    }
  } catch (error) {
    report({
      ok: false,
      createMs,
      reason: error && error.message ? error.message : String(error),
    });
  }
})();
