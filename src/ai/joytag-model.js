'use strict';

/**
 * JoyTag 打标编码器 —— **模型身份 / 预处理 / 批量推理的唯一真相源**。
 *
 * ## 它和另外三份文件的分工（别把职责挪来挪去）
 *
 *   · `tag-labels.js`  —— 标签表（5813 行，**顺序即输出下标**）。本模块只读它，不改它。
 *   · `joytag-model.js`（本文件）—— 权重身份 + 图像预处理 + 一次多张的前向。
 *   · `tag-index-store.js` —— 索引 DDL / 入库线 / 查询线 / 打分口径。**阈值只在那里定义**。
 *   · `semantic-worker.js` —— 把上面三样接起来跑（取图、算分、写库、报进度）。
 *
 * 判据的归口是刻意的：本模块**不做任何阈值过滤**（`sigmoid` 之后原样交出去），
 * 因为「哪条线算命中」是索引的口径；在这里再写一遍就会与 `tag-index-store` 分叉，
 * 而分叉的后果是「入库的行查不到 / 查询的行没入库」这类**静默空结果**。
 *
 * ## 为什么必须有这个模块（而不是把这几行写在 worker 里）
 *
 * 打标口径是**三处必须逐字一致**的东西：① 台架验收（`bench/run-tag-index.js` 建的库
 * 要被守护逐值比对）；② 产品建索引；③ 产品补建（老库 CLIP 已建完、tag 为空）。
 * 写在 worker 里就只能靠人抄，而本工程已经有过「两份实现悄悄漂掉」的先例
 * （`src/main/*.js` 那批孤儿文件的下场）。所以合成一份，谁都来引。
 *
 * ## 模型身份靠**内容哈希**，不靠版本号
 *
 * `MODEL.sha256` 是官方 LFS 指针里记的那一个（`fancyfeast/joytag` 的 `model.onnx`，
 * `size 366116154`）。换权重必须换哈希 —— 手写的版本号在「换了忘了抬」时完全失效，
 * 而内容哈希一定抓得到。
 *
 * ⚠️ **标签表不在这里播种、也不在这里找路径**：它是 `src/ai/joytag-labels.txt`，
 * 随 `src/` 进包，唯一入口是 `tag-labels.js`。播种层再复制一份 = 两张同名表可能分叉，
 * 而这张表顺序即下标，分叉的后果是全库 `tag_id` 静默错位。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const labels = require('./tag-labels');

/** 输入边长。JoyTag 的官方预处理就是把图撑到 448×448，改它等于换模型。 */
const INPUT_SIZE = 448;

/**
 * 归一化常数。取的是 **CLIP 那一套**（JoyTag 的官方实现用的就是它），
 * 不是 ImageNet 那套 —— 两套数字差在 std 上（CLIP 约 0.27 vs ImageNet 0.229），
 * 用错的表现是「标签整体偏保守、召回塌掉」，且不会报任何错。
 */
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

/** 打标链路的 human 名（诊断 / 界面用）。 */
const VERSION = 'joytag-fancyfeast-448';

/** 人工可读的模型名。刻意不做 i18n：模型名两个语言下都是同一串。 */
const MODEL_LABEL = 'JoyTag (ViT-B/16, 448px, 5813 tags)';

/**
 * 权重身份。`urls` 首个是**官方发布处**（HuggingFace），其余是同一份文件的镜像。
 *
 * 为什么镜像要写死而不是只留一个：这个文件 366 MB，本工程的用户大量在国内网络下
 * （`hf-mirror.com` 与 ModelScope 是实测能通的），只给一个源会让「下载模型」变成
 * 一件看运气的事。**三份的 sha256 必须一致** —— 校验用的是同一个哈希，所以镜像坏掉
 * 只会下载失败，绝不会把另一版权重标成这一代。
 */
const MODEL = {
  name: 'model.onnx',
  bytes: 366116154,
  sha256: 'f85b7130e6e549b5b0822537007b7482e8c4c8e754c8d9a5bee08e27050e1097',
  urls: [
    'https://huggingface.co/fancyfeast/joytag/resolve/main/model.onnx',
    'https://hf-mirror.com/fancyfeast/joytag/resolve/main/model.onnx',
    'https://www.modelscope.cn/models/fancyfeast/joytag/resolve/master/model.onnx',
  ],
};

/**
 * 一批多少张。**最多了**，调用方可以少喂。
 *
 * 🔴 **这个数不是随手挑的，它决定 GPU 到底有没有用**。实测定论（受控基准，
 * 16 张 512/webp 缩略图样本，见 `.workbuddy/tmp/joytag-bench.txt`）：
 *
 *   推理 s/张   DML b1 = 0.847 | b2 = 0.300 | b4 = 0.224 | b8 = 0.197 | **b16 = 0.178**
 *               CPU b1 = 0.582 | b16 = 0.598（**CPU 完全不吃 batch**）
 *   端到端 s/张 DML b16 = 0.196 | CPU b16 = 0.616
 *
 * ⇒ **batch=1 时 GPU 比 CPU 慢 31%**（每次前向的固定开销摊不掉）；
 *   **batch≥8 才反超 3.0~3.4×**。所以「一次一张」的实现会得出「GPU 没用」的错误结论。
 * ⇒ 模型**不需要重新导出**：它的 batch 轴本来就是动态的（`[N,3,448,448] → [N,5813]`，
 *   b8 / b16 都实测跑通），要改的只是我们一次喂几张。
 */
const BATCH = 16;

/**
 * CPU 路的 intra-op 线程数。
 *
 * 取 8 而不是 `os.cpus().length`：本机实测 16 线程相比 8 线程**没有任何收益**
 * （前向已经是内存带宽瓶颈），而线程开满会与「索引在跑时还能不能搜图」抢核心。
 * ⚠️ 与 `sharp.concurrency(1)` 配套才行 —— 不设那个会与这里叠加成超额订阅，
 * 实测拖慢 3~4 倍。
 */
const DEFAULT_THREADS = 8;

/**
 * 取图那一趟（512 内接 → JPEG）。
 *
 * 🔴 **与 `semantic-worker.js` 里建 CLIP 索引用的 `prepare()` 必须逐字同源**
 * （`scripts/joytag-index-regression.js` 会剥掉注释后逐字比对两段源码）。
 * 为什么非要同源：同一张图的两种取图口径会让「顺手打标」与「补建」产出**不同的分数**，
 * 于是同一个标签在库里一部分图能查到、一部分查不到 —— 而且两边都不报错。
 */
function prepareSource(input) {
  return sharp(input, { limitInputPixels: 100000000 })
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .jpeg()
    .toBuffer();
}

/**
 * 预处理：`prepareSource` 的产物 → 448×448 白底 contain → raw RGB。
 *
 * 白底 flatten 不是装饰：JoyTag 是在**不透明**图上训的，透明区留着会变成黑边，
 * 而黑边会实打实地推高 `black_background` 一类标签的分数。
 */
function prep448(bytes) {
  return sharp(bytes, { limitInputPixels: 100000000 })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/** `prep448` 的产物 → 归一化 float32（CHW；模型吃的是 NCHW）。 */
function normalize(pixels) {
  const n = pixels.info.width * pixels.info.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1)
    for (let c = 0; c < 3; c += 1) out[c * n + i] = (pixels.data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  return out;
}

/** 一次预处理：原始字节 → 归一化张量。 */
async function encodeInput(bytes) {
  const pixels = await prep448(bytes);
  return { data: normalize(pixels), width: pixels.info.width, height: pixels.info.height };
}

/**
 * 这条预处理链的**名字**。写进 `tag_meta.prep_spec`。
 *
 * 它存在的唯一理由是「改了链子必须能被发现」：链子一改，同一张图的分数就变了，
 * 而**分数会照常写进库里、照常被查到** —— 只有把链子本身的名字记在索引里，
 * 「这份索引是哪条口径建的」才有判据。改 `prepareSource` 或 `prep448` 必须同改这里。
 */
const PREP_SPEC = '512inside-jpeg->448contain-raw';

/**
 * 模型目录。**只此一处拼这个路径**，别处照抄就会漂。
 *
 * `cacheDir` 的语义与 `semantic-worker.js` / `embedding.js` 完全一致：它是**装模型的
 * 那一层**，即运行时的 `<aiPath>/models`、仓库里的 `<root>/models`。
 * SigLIP2 在它下面的 `onnx-community/…`，JoyTag 在它下面的 `joytag/` ——
 * 两者共用同一个播种目录，所以 `seedJoytag` 写进去的位置就是这里读出来的位置。
 */
function modelDir(cacheDir) {
  return path.join(cacheDir, 'joytag');
}

function modelPath(cacheDir) {
  return path.join(modelDir(cacheDir), MODEL.name);
}

/** 分块 sha256。366 MB 整份读进内存会在「可用内存只剩 1.28 GB」的机器上直接顶爆。 */
function sha256File(file, chunkBytes = 4 * 1024 * 1024) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunkBytes, null)) > 0)
      hash.update(read === chunkBytes ? chunk : chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 权重在不在、是不是这一代。**不看标签表**（那是 `tag-labels.js` 的事）。 */
function verify(cacheDir) {
  try {
    const file = modelPath(cacheDir);
    if (fs.statSync(file).size !== MODEL.bytes) return false;
    return sha256File(file) === MODEL.sha256;
  } catch (_) {
    return false;
  }
}

/**
 * 从某个地址拉权重。
 *
 * `bytes` 是精确字节数，**超了就当场断掉**：366 MB 的流式下载在没有上限时，
 * 遇到「一直吐数据」的错误端点会把磁盘写满，而错误信息只会是「校验失败」。
 */
async function downloadFrom(url, signal, onProgress) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error('JOYTAG_DOWNLOAD_FAILED: ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    if (signal && signal.aborted) throw new Error('AI_CANCELLED');
    size += chunk.length;
    if (size > MODEL.bytes) throw new Error('JOYTAG_MODEL_SIZE');
    chunks.push(chunk);
    if (onProgress) onProgress(Math.round((size / MODEL.bytes) * 100));
  }
  return Buffer.concat(chunks);
}

/**
 * 把权重装到 `<cacheDir>/models/joytag/`。已就绪时一次 `statSync` + 一次哈希就返回。
 *
 * 失败**必须抛**（与 `bundled-models.js` 的「只报不抛」刻意相反）：播种层失败只是白花
 * 一次下载、用户还能点重试；而这里失败意味着「下载模型」这个动作没成功，
 * 静默返回会让界面落 `ready.json` 却带着一份坏权重 —— 那才是要命的。
 */
async function install(cacheDir, signal, progress) {
  const dir = modelDir(cacheDir);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, MODEL.name);
  try {
    if (fs.statSync(destination).size === MODEL.bytes && verify(cacheDir)) return destination;
  } catch (_) {
    /* 不存在 / 尺寸不对 / 哈希不对 —— 三种都重下 */
  }
  let lastError = null;
  for (const url of MODEL.urls) {
    try {
      if (progress) progress({ file: MODEL.name, percent: 0, url });
      const bytes = await downloadFrom(url, signal, (percent) => {
        if (progress) progress({ file: MODEL.name, percent, url });
      });
      if (
        bytes.length !== MODEL.bytes ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== MODEL.sha256
      )
        throw new Error('JOYTAG_MODEL_CHECKSUM');
      const partial = destination + '.part';
      fs.writeFileSync(partial, bytes);
      fs.renameSync(partial, destination);
      return destination;
    } catch (error) {
      lastError = error;
      // 用户主动取消就不再试下一个源；其余错误（网络 / 校验）换镜像重试。
      if (signal && signal.aborted) throw error;
    }
  }
  throw lastError || new Error('JOYTAG_DOWNLOAD_FAILED');
}

/**
 * 建会话。
 *
 * 🔴 **返回的 `engine` 记的是「真的用上了什么」，不是「要了什么」**。`dml` 建会话失败时
 * 静默回落 CPU，会让「换了显卡怎么没变快」永远查不出来，所以回落返回的是 `cpu*`。
 * 调用方把它写进 `tag_photo.engine`（每张图都带凭证），并**由调用方再 warn 一次**。
 */
async function createSession(file, provider, threads) {
  const base = { interOpNumThreads: 1 };
  if (provider === 'dml') {
    try {
      const session = await ort.InferenceSession.create(file, {
        ...base,
        executionProviders: ['dml'],
      });
      return { session, engine: 'dml', fallback: '' };
    } catch (error) {
      const fallback = error && error.message ? error.message : String(error);
      const session = await ort.InferenceSession.create(file, {
        ...base,
        intraOpNumThreads: threads,
      });
      return { session, engine: 'cpu' + threads, fallback };
    }
  }
  const session = await ort.InferenceSession.create(file, {
    ...base,
    intraOpNumThreads: threads,
  });
  return { session, engine: 'cpu' + threads, fallback: '' };
}

/**
 * 载入编码器。
 *
 * @param {string} cacheDir `<aiPath>`；权重在它下面的 `models/joytag/`。
 * @param {{provider?: 'cpu'|'dml', threads?: number, batch?: number, check?: Function}} [options]
 * @returns {Promise<{tag: Function, labels: string[], batch: number, engine: string,
 *   fallback: string, dispose: Function}>}
 *   `tag(bytesList)` 一次处理 ≤ `batch` 张，返回**未过滤**的 `[[标签, 概率], …]`
 *   （每张一个元素）。`bytesList` 的每一项是一条 `prepareSource()` 的产物。
 *   阈值过滤归 `tag-index-store.put()`，别在这里做。
 */
async function load(cacheDir, options) {
  const opts = options || {};
  const threads = Number.isFinite(opts.threads)
    ? Math.max(1, Math.trunc(opts.threads))
    : DEFAULT_THREADS;
  const batch = Number.isFinite(opts.batch) ? Math.max(1, Math.trunc(opts.batch)) : BATCH;
  const check = opts.check || (() => {});
  if (!verify(cacheDir)) throw new Error('AI_MODEL_MISSING');
  const opened = await createSession(modelPath(cacheDir), opts.provider === 'dml' ? 'dml' : 'cpu', threads);
  const session = opened.session;
  const names = labels.labels();
  const expected = labels.EXPECTED_LINES;
  const inputName = (session.inputNames && session.inputNames[0]) || 'input';
  const outputName = (session.outputNames && session.outputNames[0]) || 'output';

  /**
   * 一批（≤ batch 张）→ 每张一份 `[[标签, 概率], …]`。
   *
   * ⚠️ 探测到输出维度与标签表行数不等就**当场抛**。不等 = 权重换了 / 标签表换了，
   * 硬跑下去会把标签整体错位，而错位之后的搜索**照样有结果**，只是结果不对 ——
   * 这是本工程最贵的一类故障（没有报错、没有日志、只有错的答案）。
   */
  async function tag(bytesList) {
    const list = (bytesList || []).filter(Boolean);
    if (!list.length) return [];
    const inputs = [];
    for (const bytes of list) inputs.push(await encodeInput(bytes));
    check();
    const { width, height } = inputs[0];
    const plane = width * height * 3;
    const flat = new Float32Array(plane * inputs.length);
    inputs.forEach((input, index) => flat.set(input.data, index * plane));
    const tensor = new ort.Tensor('float32', flat, [inputs.length, 3, height, width]);
    const outputs = await session.run({ [inputName]: tensor });
    const logits = outputs[outputName];
    const dim = logits.dims[logits.dims.length - 1];
    if (dim !== expected) throw new Error('JOYTAG_OUTPUT_DIM: ' + dim + ' vs 标签表 ' + expected);
    const data = logits.data;
    const out = [];
    for (let row = 0; row < inputs.length; row += 1) {
      const base = row * dim;
      const scores = [];
      for (let i = 0; i < dim; i += 1) scores.push([names[i], 1 / (1 + Math.exp(-data[base + i]))]);
      out.push(scores);
    }
    return out;
  }

  return {
    tag,
    labels: names,
    outputDim: expected,
    batch,
    engine: 'joytag-' + opened.engine,
    fallback: opened.fallback,
    async dispose() {
      try {
        await session.release();
      } catch (_) {
        /* 释放失败不值得把调用方打挂（进程退出时会一并回收） */
      }
    },
  };
}

module.exports = {
  INPUT_SIZE,
  MEAN,
  STD,
  VERSION,
  MODEL,
  MODEL_LABEL,
  BATCH,
  DEFAULT_THREADS,
  PREP_SPEC,
  modelDir,
  modelPath,
  sha256File,
  verify,
  install,
  prepareSource,
  prep448,
  normalize,
  encodeInput,
  load,
};
