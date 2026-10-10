'use strict';

const fs = require('fs');
const path = require('path');
const { DIMENSIONS, dot } = require('./embedding');
const { labelsFor } = require('./search-vocabulary');

/**
 * 图片的「主题标签」——**零样本分类**，不是图片描述。
 *
 * ## 为什么 SigLIP2 能做标签，却做不了描述
 *
 * 本项目原先的结论是「要从图里生词必须再挂一个 caption 模型（BLIP-2 / LLaVA 那类）」
 * （见 `search-vocabulary.js` 的注释）。那句话对**描述**成立：SigLIP2 是双编码器，
 * 文本塔 + 图像塔各自出向量，没有解码器，吐不出任何一个自由的词。
 *
 * 但**零样本分类**是另一回事，而且正是双编码器的原生能力：把候选标签的文本编码成向量，
 * 与图片向量算余弦，取最接近的几个。这条路不需要任何新模型 —— 而且本项目已经把料备齐了：
 *
 *   - 图片向量**已经在索引库里**（建搜图索引时算的）；
 *   - 词表向量**已经有磁盘缓存**（`vocab-vectors-*.json`，与检索预选词共用同一份）；
 *   - 打分就是点积（`embedding.js` 的 `dot`）。
 *
 * 所以给已索引的图片打标签的边际成本≈0：**不解码图片、不载模型、不跑前向**，纯算术。
 * 本机 7374 张 × 308 词 × 768 维 ≈ 17 亿次乘加，秒级。
 *
 * ## 这条路的边界（决定了它该被怎么用）
 *
 * 1. **标签只能来自固定词表**。词表里没有的概念永远出不来 —— 实测一张精灵 cosplay
 *    （精灵耳 + 花环 + 白纱）拿到的是「侧脸 / 化妆 / 人像写真」，因为词表里没有
 *    「精灵」「花环」。**词表的上限就是标签的上限**，这是零样本分类的固有性质，
 *    不是实现缺陷。
 * 2. **只覆盖已索引的图片**。标签是从索引库里的向量算的，没索引就没有向量。
 * 3. **低分区间是噪声**，必须过滤 —— 见下面 TAG_THRESHOLD 的实测依据。
 *
 * ## 标签为什么存「词表下标」而不是字符串
 *
 * 词表是 `[中文, 英文]` 词对（`search-vocabulary.js` 的 `TERMS`），**下标与语言一一对应**：
 * 下标 148 在中文下是「丝袜」、英文下是 `stockings`，是同一个概念。所以库里只存下标数组，
 * 显示时用 `labelsAtIndexes(indexes, locale)` 映射 —— 切界面语言不需要重算标签，
 * 也不会出现「换语言后标签还是中文」这种漂移。
 */

/**
 * 标签的**阈值与条数，唯一定义处**。
 *
 * 阈值口径与检索完全一致：`sim(词, 图) − sim(泛化文本, 图)`（即 `generic_sim` 基线差），
 * 因此这里与 `index-store.js` 的 `MATCH_THRESHOLD_RANGE` 是同一把尺子，不要另立口径。
 *
 * 0.015 的来历 —— 2026-10-05 在本机 cosplay 库上取 10 张跨目录抽样，逐条**读图人工核对**：
 *   - top-1 > 0.02：4/4 可信（丝袜 ✅ / 制服 ✅ / cosplay ✅ / 侧脸 ✅）；
 *   - 0.01–0.02：混合（人像写真 ✅ / 特写脸部 ✗）；
 *   - < 0.01：纯噪声 —— 一张持剑站在破败废墟里的 2B cosplay 拿到的是
 *     「镜面反射 / 水中倒影 / 街拍」全错，且分数比可信样本低一个数量级。
 * 取 0.015 落在「可信」与「噪声」之间。**低于阈值时宁可不显示标签**：
 * 一个错的标签比没有标签更糟（用户会据此相信图片里有那个东西）。
 */
const TAG_THRESHOLD = 0.015;
/** 最多显示几个。实测第 3 位起明显退化，3 是「信息量」与「噪声」的折中。 */
const TAG_MAX = 3;
/**
 * 标签用哪一版词表算。**唯一定义处** —— worker（建索引/补标签时算）与主进程
 * （算词表指纹、判断「还有多少待补」）必须用同一个值。两边各写一份的后果不是报错而是
 * **主进程以为全部待补**，于是一遍遍触发补标签，每遍都白扫一次索引库。
 */
const TAG_LANG = 'zh';
/**
 * 补标签时一批处理多少行。一条向量 3072 字节，500 行约 1.5 MB 常驻 —— 够大以摊薄
 * SQLite 事务开销，又小到不会把内存顶起来。
 */
const TAG_BATCH = 500;

/** 词表向量缓存的文件名。与检索预选词共用同一份（`semantic-worker.js` 也在读写它）。 */
function cacheFileName(lang) {
  return 'vocab-vectors-' + (lang === 'en' ? 'en' : 'zh') + '.json';
}

/**
 * 词表指纹。标签是「用某一版词表算出来的」，换了词表（增删词）旧标签就该重算 ——
 * 而 `IndexStore.batch()` 只比对 model / file_path / file_size / date_modified，
 * 词表变化它看不见，所以必须单独记一个指纹。
 */
function vocabKey(model, labels) {
  const source = String(model || '') + '\u0001' + (labels || []).join('\u0001');
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  return 't1:' + hash.toString(16);
}

/** 把库里存的 BLOB 还原成 Float32Array（`embedding.pack` 的逆操作）。 */
function unpackVector(buffer) {
  if (buffer instanceof Float32Array) return buffer;
  if (!buffer) return null;
  if (buffer.length !== DIMENSIONS * 4) return null;
  const values = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i += 1) values[i] = buffer.readFloatLE(i * 4);
  return values;
}

/**
 * 只读词表向量缓存。**失败一律返回 null**（缓存不存在、模型不符、词表长度变了）——
 * 调用方据此决定要不要现场编码，绝不在这里抛。
 */
function readCachedWordVectors(aiPath, lang, model) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(aiPath, cacheFileName(lang)), 'utf8'));
    if (model && data.model !== model) return null;
    const labels = labelsFor(lang);
    if (!Array.isArray(data.labels) || data.labels.length !== labels.length) return null;
    if (!Array.isArray(data.vectors) || data.vectors.length !== labels.length) return null;
    for (let i = 0; i < labels.length; i += 1) if (data.labels[i] !== labels[i]) return null;
    const vectors = data.vectors.map((item) => unpackVector(Buffer.from(item, 'base64')));
    if (vectors.some((v) => !v)) return null;
    return { labels: labels.slice(), vectors, model: data.model, key: vocabKey(data.model, labels) };
  } catch (_) {
    return null;
  }
}

/**
 * 给一个**已归一化**的图片向量挑标签。
 *
 * @param {Float32Array|Buffer} vector 图片向量（库里读出来的 BLOB 也可，会先解包）
 * @param {Float32Array[]} wordVectors 词表向量（每个都归一化过）
 * @param {number} baseline 该图的 `generic_sim`；缺失按 0 处理（相当于退回原始余弦）
 * @returns {{index:number, score:number}[]} 按下标升序为稳定次序，按分数降序
 */
function computeTags(vector, wordVectors, baseline, options) {
  const values = unpackVector(vector);
  if (!values || !Array.isArray(wordVectors) || !wordVectors.length) return [];
  const threshold = Number.isFinite(options && options.threshold) ? options.threshold : TAG_THRESHOLD;
  const max = Number.isFinite(options && options.max) ? options.max : TAG_MAX;
  const base = Number.isFinite(baseline) ? baseline : 0;
  const hits = [];
  for (let i = 0; i < wordVectors.length; i += 1) {
    const score = dot(values, wordVectors[i]) - base;
    if (score >= threshold) hits.push({ index: i, score });
  }
  // 同分时按下标升序：结果是**确定性**的（本项目硬契约：同一份输入必须给出同一份输出，
  // 否则回归断言无法复现）。排序键里带 index 就是为了这个。
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return hits.slice(0, max);
}

/** 只取下标（入库格式）。 */
function indexesOf(hits) {
  return (hits || []).map((hit) => hit.index);
}

/** 下标数组 → 该语言的标签文本（丢掉了词表里已不存在的下标）。 */
function labelsAtIndexes(indexes, lang) {
  const labels = labelsFor(lang);
  const out = [];
  for (const index of indexes || []) {
    const label = labels[index];
    if (typeof label === 'string' && label) out.push(label);
  }
  return out;
}

/** 存进库的格式：JSON 下标数组。空标签存 `'[]'`（而不是 NULL），便于区分「算过但没有」与「没算过」。 */
function serializeTags(indexes) {
  return JSON.stringify(
    (indexes || []).filter((n) => Number.isInteger(n) && n >= 0),
  );
}

/** 从库里存的文本还原下标数组。任何脏值一律降级成空数组（不让一行坏数据打挂面板）。 */
function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => Number.isInteger(n) && n >= 0);
  } catch (_) {
    return [];
  }
}

module.exports = {
  TAG_THRESHOLD,
  TAG_MAX,
  TAG_LANG,
  TAG_BATCH,
  cacheFileName,
  vocabKey,
  unpackVector,
  readCachedWordVectors,
  computeTags,
  indexesOf,
  labelsAtIndexes,
  serializeTags,
  parseTags,
};
