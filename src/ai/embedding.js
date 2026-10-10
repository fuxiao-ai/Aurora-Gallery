'use strict';

const MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';
const REVISION = 'ba1f3b0';
const MODEL_KEY = MODEL + '@' + REVISION + ':q8:thumbnail-v1';
const DIMENSIONS = 768;
/**
 * 泛化文本：给每张图片算一个「基线」相似度用。
 *
 * 任何照片对「一张照片」这种泛化描述都会有不低的相似度——那一份是它与「什么内容都沾点边」的
 * 公共成分，与查询无关。检索时把它从分数里减掉，剩下的才是查询自己带来的信号。
 *
 * 🔴 这是**数据**不是界面文案：`GENERIC_TEXT` 参与每条向量的基线差计算，改它 = 全库
 *    已建索引的分数口径作废（「统一 照片/图片 用词」那类全局替换必须把它排除）。
 *
 * 为什么必须减：在真实库（122 万图片、绝大多数是同一种题材）上实测过四种阈值口径——
 * 原始余弦、相对全库均值的 z 值、衰减率、以及这个基线差。前三者完全分不开「库里真有这个概念」
 * 与「库里没有」：固定余弦 0.08 时乱码查询还能剩 3027 张，而 z 值反而把库里没有的「汽车」排到
 * 最高（5.73，高于真有的「女孩坐在室内」2.31）。只有基线差能分开：库里真有的概念稳定有结果，
 * 库里没有的概念与乱码一律落到 0 命中。
 *
 * 这个字符串与 install 阶段验证编码器用的是同一个（见 semantic-worker.js），因此它一定编码得出来。
 */
const GENERIC_TEXT = '一张照片 a photo';
/**
 * `texts()` 一次前向送多少条文本。16 是实测的折中：再大对耗时没有可见收益，
 * 而它同时是一块 [N, 64] 的 int64 输入张量，放大只会白占内存。
 */
const TEXT_BATCH_SIZE = 16;
/**
 * 默认推理设备（EP）。**必须保持 `cpu`**。
 *
 * DirectML 的收益只出现在「连续编码很多张图」这条长跑路上（建索引），而搜图这条路上文本
 * 编码器每次查询只前向一次，换 EP 省不下可感知的时间，却要多担一份 DirectML 不可用的风险。
 * ⇒ 只有「这段代码会连续编码图片」的调用方才该显式传 `device: 'dml'`，且**必须自带 CPU 回退**。
 *
 * ⚠️ transformers.js 在 win32 上无条件把 `dml` 列进 `supportedDevices`（见
 * `dist/transformers.node.cjs#deviceToExecutionProviders`），所以 `device: 'dml'` 能通过
 * 参数校验**不代表这台机器真的能跑** —— 建会话成功才是唯一可信的判据。
 */
const DEFAULT_DEVICE = 'cpu';
/**
 * 默认 ONNX 会话的 intra-op 线程数。**必须保持 2**。
 *
 * 这个数字是为「搜图与建索引共用一份编码器」定的：索引在跑时还要 relay 服务搜索请求，
 * 线程数开满会把前台读池挤掉。⇒ 只有**确认此刻没有前台负载**的长跑任务才该显式放大它
 * （实测：CLIP 视觉编码从 2 线程提到 8 线程有可观收益，见 `docs/contracts/semantic-search.md`
 * 「EP 与计时纪律」）。改这里的默认值等于改搜索时的核心占用，不属于「顺手调参」。
 */
const DEFAULT_THREADS = 2;

function normalize(values) {
  if (!values || values.length !== DIMENSIONS) throw new Error('AI_VECTOR_DIMENSION');
  let sum = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('AI_VECTOR_INVALID');
    sum += value * value;
  }
  if (sum <= 0) throw new Error('AI_VECTOR_INVALID');
  const norm = Math.sqrt(sum);
  return Float32Array.from(values, (value) => value / norm);
}

function pack(vector) {
  const buffer = Buffer.alloc(DIMENSIONS * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function score(query, buffer) {
  if (buffer.length !== DIMENSIONS * 4) throw new Error('AI_INDEX_INVALID');
  let result = 0;
  for (let i = 0; i < DIMENSIONS; i++) result += query[i] * buffer.readFloatLE(i * 4);
  if (!Number.isFinite(result)) throw new Error('AI_INDEX_INVALID');
  return result;
}

/**
 * 载入 SigLIP2 编码器。
 *
 * `textOnly` 只载 tokenizer + 文本编码器：搜图是纯文本召回，视觉那一份用不上——模型文件虽只
 * 94.5 MB，ONNX 会话的常驻开销却是它的三倍左右，实测省下约 270 MB（1170 MB → 900 MB）。
 * 省下来的内存直接决定「另一套 AI 索引在跑时还敢不敢再起一个搜图 worker」，
 * 见 docs/local-ai-search.md。建索引必须能编码图片，因此那里不能开。
 *
 * `device` 默认 CPU、`threads` 默认 2，只有「会连续编码很多张图、且此刻没有前台负载」的
 * 调用方才该换（理由见 `DEFAULT_DEVICE` / `DEFAULT_THREADS`）。
 */
async function loadEncoder(
  cacheDir,
  {
    download = false,
    progress = () => {},
    textOnly = false,
    device = DEFAULT_DEVICE,
    threads = DEFAULT_THREADS,
  } = {},
) {
  /**
   * 🔴 **这一行不是多余的，删掉会让进程硬崩。**
   *
   * 工程里存在**两份** `onnxruntime-node`：
   *   · 顶层 `node_modules/onnxruntime-node` —— 版本新（1.24.3），带 `DirectML.dll`，
   *     人脸（`face-model.js`）、GPU 探测器、JoyTag（`joytag-model.js`）都用它；
   *   · `@huggingface/transformers` **自带的那一份**（1.21.0）—— 本函数下面这一句
   *     `import('@huggingface/transformers')` 会把它拉进来。
   *
   * 两者的原生绑定各自 `LoadLibrary("onnxruntime.dll")`，而 **Windows 按**基名**解析 DLL**：
   * 第二次加载会直接复用已在进程里的那个句柄。于是「已载入的那一份」决定了实际调的是哪个 DLL：
   *
   *   顶层 1.24.3 先载 → 嵌套那 1.21.0 的绑定调 1.24.3 的 DLL ⇒ **旧 API 调新 DLL，能用** ✅
   *   嵌套 1.21.0 先载 → 顶层 1.24.3 的绑定调 1.21.0 的 DLL ⇒ 新 API 调旧 DLL ⇒
   *     `The requested API version [24] is not available, only API versions [1, 21] are
   *      supported in this build` ⇒ **原生 abort，整个进程死**（不是 JS 异常，catch 不到）💥
   *
   * 实测四种次序（`.workbuddy/tmp/ort-order-probe.js`）：只有「顶层先」的两种活下来。
   * 症状之所以难查：**崩在建会话那一刻**，栈里全是 ONNX Runtime 的原生帧，看着像模型坏了；
   * 而它取决于「谁先被 require」这种看起来跟推理毫无关系的事。
   *
   * 所以在这里抢先把顶层那份载进来。选这个位置有两个理由：
   *   ① 它**恰好是所有会拉进 transformers.js 的唯一入口**，所以次序在结构上不可能再错；
   *   ② 不能放在 `semantic-worker.js` 顶部无条件 require —— 那条路每个搜图 worker 都要走，
   *      而搜图只需要文本编码器，白载一份顶层 ORT 是每个 worker 一次无谓的原生加载
   *      （实测 RSS +6 MB、一次性 dlopen）。放在这里则是「正要载 SigLIP2 时才载」，
   *      与「谁会造成冲突」严格对齐。
   *
   * 守护：`scripts/joytag-index-regression.js` 静态断言本行必须出现在下面那句
   * `import('@huggingface/transformers')` **之前**。
   */
  require('onnxruntime-node');
  const hf = await import('@huggingface/transformers');
  hf.env.cacheDir = cacheDir;
  hf.env.allowRemoteModels = download;
  hf.env.allowLocalModels = true;
  const options = {
    revision: REVISION,
    local_files_only: !download,
    dtype: 'q8',
    device,
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
    progress_callback: progress,
  };
  let text;
  let vision = null;
  try {
    // 载入顺序与原来保持一致（tokenizer → 处理器 → 文本 → 视觉），下载进度因此不变；
    // textOnly 只是把「只为视觉服务」的处理器与视觉模型两处跳过去。
    const tokenizer = await hf.AutoTokenizer.from_pretrained(MODEL, options);
    let processor = null;
    if (!textOnly) processor = await hf.AutoProcessor.from_pretrained(MODEL, options);
    text = await hf.SiglipTextModel.from_pretrained(MODEL, options);
    if (!textOnly) vision = await hf.SiglipVisionModel.from_pretrained(MODEL, options);
    return {
      textOnly,
      async text(query) {
        const inputs = tokenizer(query, {
          padding: 'max_length',
          truncation: true,
          max_length: 64,
        });
        const output = await text(inputs);
        return normalize(output.pooler_output.data);
      },
      /**
       * 一次编码一批文本。预选词要对**几百个候选词**打分，逐个调用 `text()` 就是几百次
       * 模型前向（每次约 40 ms → 十几秒），批起来能省掉调用开销。
       *
       * ⚠️ **批处理不会让总计算量变小**：这里用 `padding: 'max_length', max_length: 64`，
       * 每条都被补到 64，批 16 的总计算量与逐条一样（实测 309 条：批 16 = 12745 ms，
       * 逐条 = 12200 ms）。想省钱只能**缓存结果**，不能改这里 —— 见下面那条警告。
       *
       * ⚠️ **padding 长度是不能动的刻度**：改成动态 padding（补到批内最长）确实快 15 倍，
       * 但向量完全不同 —— 同一句话 `max_length=64` 与动态 padding 的最大逐位差 **0.38**，
       * 且它还会随「同批里有没有长句」而变化；`max_length` 降到 32 差 0.147、降到 16 差 0.38。
       * SigLIP2 的 `pooler_output` 对补齐长度就是这么敏感，而整个检索的阈值标定（0.01）
       * 都是在 `max_length: 64` 下做的。改这里会让「预选词说有图、点下去 0 张」重新出现。
       *
       * 批量与逐条的结果也不完全逐位相同（实测最大逐位差约 0.008，来自 q8 量化在
       * 不同 batch 形状下的数值差异）；预选词每次都用批量、口径自洽，因此不受影响。
       */
      async texts(queries) {
        const list = queries.map((query) => String(query));
        const vectors = [];
        for (let start = 0; start < list.length; start += TEXT_BATCH_SIZE) {
          const chunk = list.slice(start, start + TEXT_BATCH_SIZE);
          const inputs = tokenizer(chunk, {
            padding: 'max_length',
            truncation: true,
            max_length: 64,
          });
          const output = await text(inputs);
          const data = output.pooler_output.data;
          for (let row = 0; row < chunk.length; row += 1)
            vectors.push(normalize(data.subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS)));
        }
        return vectors;
      },
      async image(bytes) {
        // textOnly 编码器没有视觉会话；这里必须显式报错，而不是静默返回一个错的向量。
        if (!vision) throw new Error('AI_VISION_UNAVAILABLE');
        const image = await hf.RawImage.fromBlob(new Blob([bytes]));
        const inputs = await processor(image);
        const output = await vision(inputs);
        return normalize(output.pooler_output.data);
      },
      async dispose() {
        const sessions = vision ? [text, vision] : [text];
        await Promise.all(sessions.map((session) => session.dispose()));
      },
    };
  } catch (error) {
    if (text) await text.dispose();
    if (vision) await vision.dispose();
    throw error;
  } finally {
    hf.env.allowRemoteModels = false;
  }
}

/**
 * 两个**已归一化**向量的点积（即余弦）。`score` 读的是入库的 BLOB，这里是给内存里的
 * Float32Array 用的（算基线、算候选词命中数），两者都是 768 维归一化向量。
 */
function dot(a, b) {
  let result = 0;
  for (let i = 0; i < DIMENSIONS; i++) result += a[i] * b[i];
  if (!Number.isFinite(result)) throw new Error('AI_VECTOR_INVALID');
  return result;
}

module.exports = {
  MODEL,
  MODEL_KEY,
  DIMENSIONS,
  GENERIC_TEXT,
  DEFAULT_DEVICE,
  DEFAULT_THREADS,
  normalize,
  pack,
  score,
  dot,
  loadEncoder,
};
