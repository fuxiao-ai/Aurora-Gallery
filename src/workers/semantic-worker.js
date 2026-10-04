'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { MODEL_KEY, DIMENSIONS, GENERIC_TEXT, loadEncoder, dot } = require('../ai/embedding');
const { IndexStore } = require('../ai/index-store');
const vocabulary = require('../ai/search-vocabulary');
sharp.concurrency(1);
/**
 * 只需要**文本**编码器的操作。下载模型要验证两种编码器、建索引要编码图片，两者都必须带视觉
 * 那份（约 270 MB 常驻内存）；搜索与预选词打分只用文本，带上就是白花内存。
 * 新增操作时先想清楚它要不要编码图片，别默默继承默认值。
 */
const TEXT_ONLY_OPERATIONS = new Set(['search', 'suggest']);
/**
 * 预选词默认返回几个 / 最多返回几个。
 *
 * 返回的不是「界面要显示的那 5 个」而是**一个池子**：界面从池子里洗牌抽 5 个，
 * 「换一批」就是再洗一次，因此不需要为「换一批」重新跑一遍模型。池子太小则洗牌没有可见变化
 * （18 词池随机抽 5，两批重复率很高），太大则 IPC 负载与前端渲染都白花 —— 24 是实测够用的折中。
 */
const SUGGEST_LIMIT_DEFAULT = 24;
const SUGGEST_LIMIT_MAX = 64;
/** 命中多少张才算「点下去有图」。1 是下限：要挡的是 0 张，命中 1 张点进去照样有照片可看。 */
const DEFAULT_MIN_HITS = 1;
/** 阈值只接受有限数；越界或缺失时交给 IndexStore 用默认值。 */
function matchThreshold(options) {
  const value = Number(options && options.threshold);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
let cancelled = false;
let controller;
let busy = false;
// 索引进行中会顺手服务只读搜索请求（见下面的 relay 分支）：复用这两个已经建好的对象，
// 不新开 ONNX 会话——并发载入**第二份 SigLIP2** 会因内存耗尽把进程搞死（实测：单份索引
// worker 已能把 24GB 机器的可用内存压到个位数 MB）。relay 的价值就是把这一份用起来。
let activeEncoder = null;
let activeStore = null;
// 泛化文本的向量：一次编码，索引与检索共用（relay 也要用，所以挂在模块上）。
let activeBaseline = null;
const root = workerData.aiPath;
const readyFile = path.join(root, 'ready.json');
const indexPath = path.join(root, 'semantic-index.sqlite');
const cacheDir = path.join(root, 'models');
const progress = (state) => parentPort.postMessage({ progress: state });
const check = () => {
  if (cancelled) throw new Error('AI_CANCELLED');
};
const imageTypes = new Set(
  'jpg jpeg png webp gif bmp tif tiff heic heif avif cr2 cr3 nef nrw arw dng orf rw2 raw raf pef srw'.split(
    ' ',
  ),
);

/**
 * 预选词词表向量的磁盘缓存。
 *
 * ## 为什么必须缓存
 *
 * 词表是几百条，编码一条要 **约 40 ms**（本项目实测：单条 `text()` 平均 39.4 ms，309 条 ≈ 12.9 s）。
 * 这个钱花在「进搜图页时的预选词」上完全不可接受 —— 它会变成打开页面后十几秒没反应。
 * 而**词的向量只跟模型有关、与图库无关**，所以在 `install` 时算一次存下来，之后每次 suggest
 * 都只是 base64 解码 + 几百次点积（实测合计约 1.2 s，其中 1.2 s 是扫取样向量）。
 *
 * ## 为什么不能靠「批处理」或「缩短 padding」省这个钱
 *
 * 都实测过，两条路都不通：
 *   - 批量编码**没有**加速：`padding: 'max_length', max_length: 64` 下每条都被补到 64，
 *     批 16 与逐条的总计算量一样（实测批 16 全量 12745 ms vs 逐条 12200 ms）。
 *   - 改成动态 padding（补到批内最长）确实快 15 倍（839 ms），但向量**完全不同**：
 *     同一句话 `max_length=64` 与动态 padding 的最大逐位差 **0.38**，而且它还会随
 *     「同批里有没有长句」而变（把「内衣」和一句长描述放一批，差值 0.44）。同理
 *     `max_length` 从 64 降到 32 就差 0.147、降到 16 差 0.38。
 *     SigLIP2 的 `pooler_output` 对补齐长度就是这么敏感，所以 padding 是个**不能动的刻度** ——
 *     整个检索的阈值标定（0.01）都是在 `max_length: 64` 下做的，改了预选词的向量口径，
 *     「预选词说有图、点下去 0 张」就会重新出现。
 *
 * 缓存按 `MODEL_KEY` + 语言 + **词表原文数组**校验：换模型或改词表都会自动失效重算，
 * 不需要手工清缓存。任何一步出错都静默退回现场计算，绝不会因此让 suggest 失败。
 */
function vocabCacheFile(lang) {
  return path.join(root, 'vocab-vectors-' + (lang === 'en' ? 'en' : 'zh') + '.json');
}
function readVocabCache(lang, labels) {
  try {
    const data = JSON.parse(fs.readFileSync(vocabCacheFile(lang), 'utf8'));
    if (data.model !== MODEL_KEY || !Array.isArray(data.vectors)) return null;
    if (data.labels.length !== labels.length) return null;
    for (let i = 0; i < labels.length; i += 1) if (data.labels[i] !== labels[i]) return null;
    const vectors = data.vectors.map((item) => {
      const values = new Float32Array(DIMENSIONS);
      Buffer.from(item, 'base64').copy(Buffer.from(values.buffer), 0);
      return values;
    });
    return vectors.length === labels.length ? vectors : null;
  } catch (_) {
    return null;
  }
}
function writeVocabCache(lang, labels, vectors) {
  try {
    const encoded = vectors.map((values) =>
      Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64'),
    );
    const payload = JSON.stringify({ model: MODEL_KEY, labels, vectors: encoded });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(vocabCacheFile(lang) + '.tmp', payload);
    fs.renameSync(vocabCacheFile(lang) + '.tmp', vocabCacheFile(lang));
  } catch (_) {
    /* 缓存写不进去只是慢一点，不是错误 */
  }
}
/** 拿到词表向量：优先磁盘缓存，没有就现算并落盘。 */
async function vocabVectors(encoder, lang, labels) {
  const cached = readVocabCache(lang, labels);
  if (cached) return cached;
  const vectors = await encoder.texts(labels);
  check();
  writeVocabCache(lang, labels, vectors);
  return vectors;
}

/**
 * 只读操作的实际执行：检索与预选词打分。`execute`（自己起 worker）与 relay（托给索引 worker）
 * 共用这一段，两条路径的行为因此不可能分叉。
 */
async function readOnly(encoder, store, baselineVector, operation, query, options) {
  if (operation === 'search') {
    const vector = await encoder.text(query);
    check();
    const result = await store.search(
      vector,
      { threshold: matchThreshold(options), baseline: baselineVector },
      () => cancelled,
    );
    return { ...result, indexed: store.count() };
  }
  if (operation === 'suggest') {
    // 预选词打分。两种入参：
    //   - `options.candidates`（老契约）：界面给一组词，回答「这些词有没有内容」；
    //   - 只给 `options.lang`：**词源在服务端**（`src/ai/search-vocabulary.js`），
    //     对整份词表打分后按真实命中数取前 N 个返回。
    // 之所以把词表挪到服务端：词表从 18 个变成几百个，再让界面把整份词表传过来毫无意义，
    // 而且桌面端与网页端各写一份必然漂移（原来两边就是各抄一份 18 词池）。
    const explicit = Array.isArray(options && options.candidates)
      ? options.candidates.map((item) => String(item == null ? '' : item).trim()).filter(Boolean)
      : null;
    // 语言的判定必须与 `search-vocabulary.labelsFor()` 完全同源，否则会出现
    // 「把英文词表存进 zh 缓存文件」这种错配（下次读取时标签对不上、白算一遍）。
    const lang = String((options && options.lang) || '')
      .toLowerCase()
      .startsWith('en')
      ? 'en'
      : 'zh';
    const labels =
      explicit && explicit.length ? explicit : vocabulary.labelsFor(options && options.lang);
    check();
    // 词表那条走磁盘缓存（几百条现码一次要十几秒，理由见 vocabCacheFile 的注释）；
    // 界面自带的那几个词是临时输入，不占缓存。
    const vectors =
      explicit && explicit.length ? await encoder.texts(labels) : await vocabVectors(encoder, lang, labels);
    check();
    const candidates = labels.map((text, index) => ({ text, vector: vectors[index] }));
    const scored = await store.scoreCandidates(
      candidates,
      { threshold: matchThreshold(options), baseline: baselineVector },
      () => cancelled,
    );
    const minHits = Number.isFinite(Number(options && options.minHits))
      ? Math.max(1, Math.trunc(Number(options.minHits)))
      : DEFAULT_MIN_HITS;
    const limit = Number.isFinite(Number(options && options.limit))
      ? Math.min(SUGGEST_LIMIT_MAX, Math.max(1, Math.trunc(Number(options.limit))))
      : SUGGEST_LIMIT_DEFAULT;
    const terms = candidates
      .map((candidate, index) => ({ text: candidate.text, hits: scored.hits[index] }))
      // 命中 0 的词一律不返回：预选词存在的意义就是「点下去有图」，返回 0 命中的词
      // 等于把「已知没结果」的东西摆给用户点（旧实现正是这么干的）。
      .filter((term) => term.hits >= minHits)
      // 命中数相同时按词表原始顺序（`Array.prototype.sort` 自 ES2019 起稳定，
      // 而 `candidates` 就是按词表顺序生成的），因此同一份库重跑结果完全一致。
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit);
    return { sampled: scored.sampled, terms };
  }
  throw new Error('AI_BAD_OPERATION');
}

async function execute(operation, query, options) {
  fs.mkdirSync(root, { recursive: true });
  if (operation === 'status') {
    let ready = false;
    try {
      ready = JSON.parse(fs.readFileSync(readyFile, 'utf8')).model === MODEL_KEY;
    } catch (_) {}
    const store = new IndexStore(workerData.dbPath, indexPath);
    try {
      return { ready, indexed: store.count() };
    } finally {
      store.close();
    }
  }
  if (operation !== 'install') {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    } catch (_) {}
    if (!manifest || manifest.model !== MODEL_KEY) throw new Error('AI_MODEL_MISSING');
  }
  const originalFetch = global.fetch;
  if (operation === 'install') {
    controller = new AbortController();
    global.fetch = (url, options = {}) =>
      originalFetch(url, { ...options, signal: controller.signal });
  }
  let encoder;
  let store;
  try {
    progress({ phase: operation === 'install' ? 'downloading' : 'loading' });
    encoder = await loadEncoder(cacheDir, {
      download: operation === 'install',
      // 纯搜图只要文本编码器：视觉那份实测占约 270 MB 常驻内存，而内存正是「另一套索引
      // 在跑时还能不能搜图」的瓶颈。建索引必须能编码图片，所以那里保持两份都载——
      // 顺带一说，索引 worker 手里的这份文本编码器正是 relay 搜索复用的对象。
      textOnly: TEXT_ONLY_OPERATIONS.has(operation),
      progress: (event) => {
        check();
        if (event.status === 'progress')
          progress({ file: event.file, percent: Math.round(event.progress || 0) });
      },
    });
    check();
    if (operation === 'install') {
      // Validate both encoders before marking the local cache ready.
      await encoder.text(GENERIC_TEXT);
      await encoder.image(
        await sharp({ create: { width: 224, height: 224, channels: 3, background: '#888888' } })
          .png()
          .toBuffer(),
      );
      check();
      fs.writeFileSync(readyFile + '.tmp', JSON.stringify({ model: MODEL_KEY }));
      fs.renameSync(readyFile + '.tmp', readyFile);
      // 顺手把预选词的词表向量算好存下来：这一步正好在跑重活、编码器就在手上，多花的十几秒
      // 混在「下载模型」里没人会注意到；否则第一次进搜图页要为了预选词多等十几秒。
      progress({ phase: 'loading' });
      for (const lang of ['zh', 'en']) {
        const labels = vocabulary.labelsFor(lang);
        if (!readVocabCache(lang, labels)) await vocabVectors(encoder, lang, labels);
      }
      check();
      return { ready: true };
    }
    store = new IndexStore(workerData.dbPath, indexPath);
    // 交给索引循环里的只读搜索（relay）复用：编码器与库连接都已就绪，不必再开一份。
    activeEncoder = encoder;
    activeStore = store;
    // 基线只编码一次：检索时每张照片都要减掉它与泛化文本的相似度（原因见 embedding.js）。
    const baselineVector = await encoder.text(GENERIC_TEXT);
    check();
    activeBaseline = baselineVector;
    // 没有词表缓存就顺手补上（两种语言各约 13 秒）。放在这里而不是等 suggest：
    // 建索引本来就是个长任务，这十几秒混在里面看不见；等到进搜图页才算，
    // 用户看到的就是「打开页面后十几秒预选词一直不出来」。已经有缓存时这里是零成本。
    if (!TEXT_ONLY_OPERATIONS.has(operation)) {
      for (const lang of ['zh', 'en']) {
        const labels = vocabulary.labelsFor(lang);
        if (readVocabCache(lang, labels)) continue;
        progress({ phase: 'loading' });
        await vocabVectors(encoder, lang, labels);
        check();
      }
    }
    if (TEXT_ONLY_OPERATIONS.has(operation)) {
      // 预选词有专属于自己的进度文案（`suggest: 匹配预选词`）——它现在要编码几百个词、
      // 再扫一遍取样向量，耗时不再可以忽略，报成「搜索中」会让用户以为搜图卡住了。
      progress({ phase: operation === 'suggest' ? 'suggest' : 'searching' });
      // ⚠️ **必须是 `return await`，不能只写 `return`**。这不是风格问题：
      // `execute` 外层是 `try { ... } finally { store.close(); await encoder.dispose(); }`，
      // 而 `return <promise>` 会**先求值 promise、立刻执行 finally**，于是 `dispose()` 与
      // 仍在跑的 `readOnly()` 并发 —— 编码器会话被释放、SQLite 连接被关掉，而 `readOnly`
      // 还在用它们。实测症状就是**搜图和预选词全挂**：模型报
      // `An error occurred during model execution: "Error: Session already disposed."`，
      // 主进程只看到 `AI_WORKER_EXIT`/该错误串，且失败点随 dispose 与推理谁先跑完而漂移
      // （有时第一批判死、有时编码完 13 秒才在打分阶段死），所以极容易被当成随机故障。
      // 加 `await` 后 finally 会在 readOnly 真正结束后才执行，两条路径（search / suggest）
      // 一起恢复正常。回归见 scripts/semantic-regression.js 的静态契约。
      return await readOnly(encoder, store, baselineVector, operation, query, options);
    }
    let after = 0;
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let indexed = store.count();
    progress({ phase: 'indexing', processed, failed, skipped, indexed });
    const startedAt = Date.now();
    const report = (photo) =>
      progress({
        processed,
        failed,
        skipped,
        indexed,
        currentFile: photo.file_name,
        ratePerMinute: Math.round(
          ((processed + failed) * 60000) / Math.max(1000, Date.now() - startedAt),
        ),
      });
    while (true) {
      check();
      const rows = store.batch(after);
      if (!rows.length) break;
      for (const photo of rows) {
        check();
        after = photo.id;
        if (!imageTypes.has(path.extname(photo.file_name).slice(1).toLowerCase())) {
          skipped++;
          report(photo);
          await new Promise((resolve) => setImmediate(resolve));
          continue;
        }
        try {
          progress({ currentFile: photo.file_name });
          const prepare = (input) =>
            sharp(input, { limitInputPixels: 100000000 })
              .rotate()
              .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
              .removeAlpha()
              .jpeg()
              .toBuffer();
          let bytes;
          try {
            bytes = await prepare(photo.thumbnail || photo.file_path);
          } catch (error) {
            check();
            if (!photo.thumbnail) throw error;
            bytes = await prepare(photo.file_path);
          }
          const vector = await encoder.image(bytes);
          check();
          // 顺手把基线一起落库：这个向量就在手上，不存下来就要在第一次检索时补算一遍。
          store.put(photo, vector, dot(baselineVector, vector));
          processed++;
          indexed++;
        } catch (error) {
          check();
          failed++;
          progress({ lastFailedId: photo.id, failure: 'AI_IMAGE_UNREADABLE' });
        }
        report(photo);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { indexed: store.count(), processed, failed, skipped };
  } finally {
    global.fetch = originalFetch;
    controller = null;
    activeEncoder = null;
    activeStore = null;
    activeBaseline = null;
    if (store) store.close();
    if (encoder) await encoder.dispose();
  }
}

parentPort.on('message', async (message) => {
  if (message.cancel) {
    cancelled = true;
    if (controller) controller.abort();
    return;
  }
  // 只读请求（检索 / 预选词打分）的 relay 单独走一路回话，任何时候都不当作一次主任务：
  // 否则「索引刚好结束」时它会被当成主任务跑完，父进程可能把搜索结果误当成
  // 索引结果（反过来本次搜索也永远等不到回话）。
  if (message.relay != null) {
    const ticket = message.relay;
    if (
      !TEXT_ONLY_OPERATIONS.has(message.operation) ||
      !activeEncoder ||
      !activeStore ||
      !activeBaseline
    ) {
      parentPort.postMessage({ relay: ticket, error: 'AI_BUSY' });
      return;
    }
    try {
      const result = await readOnly(
        activeEncoder,
        activeStore,
        activeBaseline,
        message.operation,
        message.query,
        message.options,
      );
      parentPort.postMessage({ relay: ticket, result });
    } catch (error) {
      parentPort.postMessage({
        relay: ticket,
        error: cancelled ? 'AI_CANCELLED' : error.message,
      });
    }
    return;
  }
  // 主任务（建索引）正在跑：其余消息一律不处理，等它跑完。
  if (busy) return;
  busy = true;
  cancelled = false;
  try {
    const result = await execute(message.operation, message.query, message.options);
    parentPort.postMessage({ done: true, result });
  } catch (error) {
    parentPort.postMessage({ done: true, error: cancelled ? 'AI_CANCELLED' : error.message });
  } finally {
    busy = false;
  }
});
