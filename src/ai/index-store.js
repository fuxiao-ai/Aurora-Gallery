'use strict';

const Database = require('better-sqlite3');
const { MODEL_KEY, DIMENSIONS, pack, score, dot } = require('./embedding');

/**
 * 匹配阈值的默认值，口径是**基线差**：`sim(查询, 照片) − sim(泛化文本, 照片)`。
 * 起因为什么不能用原始余弦，见 embedding.js 里 GENERIC_TEXT 的注释与 docs/local-ai-search.md。
 * 同一批实测里 0.01 这一档能把「库里真有的概念」与「库里没有的概念 / 乱码」分开：
 * 前者 16–1800 命中，后者一律 0。
 */
const DEFAULT_MATCH_THRESHOLD = 0.01;
/**
 * 单次返回的**内部**上限。它只约束内存，不参与「谁达标」：达标数另由 matched 给出。
 * 之所以必须有：阈值调到 0 时「一张照片」这种泛化查询能命中全库的一大半，百万库里
 * 那就是上百万个行对象同时驻留 —— 那是崩溃而不是功能。
 */
const MAX_RESULTS = 5000;
/**
 * 设置项允许的范围。上限 0.03 已经严到多数查询直接返空（实测「人物肖像」在 0.02 时只剩 1 张），
 * 下限 0 等于不过滤。**默认值只在这里定义**，主进程的设置默认值从本模块取，避免两处漂移。
 */
const MATCH_THRESHOLD_RANGE = { min: 0, max: 0.03, default: DEFAULT_MATCH_THRESHOLD };
/** 基线补算攒够这么多条就落库。 */
const BASELINE_FLUSH = 20000;

class IndexStore {
  constructor(sourcePath, indexPath) {
    this.index = new Database(indexPath);
    this.index.pragma('journal_mode = WAL');
    this.index.pragma('busy_timeout = 3000');
    this.index.exec(`CREATE TABLE IF NOT EXISTS embeddings (
      photo_id INTEGER PRIMARY KEY, model TEXT NOT NULL, file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL, date_modified TEXT NOT NULL, vector BLOB NOT NULL,
      generic_sim REAL
    )`);
    // 老索引没有 generic_sim 列：补上（新增列落在末尾，与上面的建表顺序一致）。
    // 历史行留 NULL，检索时按需补算并写回 —— 不需要重建索引（百万库重建一次是数天）。
    try {
      this.index.exec('ALTER TABLE embeddings ADD COLUMN generic_sim REAL');
    } catch (_) {}
    try {
      this.source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      this.source.pragma('busy_timeout = 3000');
      this.source.prepare('ATTACH DATABASE ? AS semantic').run(indexPath);
    } catch (error) {
      if (this.source) this.source.close();
      this.index.close();
      throw error;
    }
  }

  batch(after) {
    return this.source
      .prepare(
        `SELECT p.id, p.file_path, p.file_name, p.file_type, p.file_size,
      COALESCE(p.date_modified, '') AS date_modified, p.thumbnail
      FROM photos p LEFT JOIN semantic.embeddings e ON e.photo_id = p.id
      WHERE p.id > ? AND (e.photo_id IS NULL OR e.model != ? OR e.file_path != p.file_path
        OR e.file_size != p.file_size OR e.date_modified != COALESCE(p.date_modified, ''))
      ORDER BY p.id LIMIT 16`,
      )
      .all(after, MODEL_KEY);
  }

  /**
   * `genericSim` 在建索引时顺手算好（worker 已经拿得到向量），这样新索引一落库就带基线，
   * 不会再触发一次补算。
   */
  put(photo, vector, genericSim) {
    this.index
      .prepare(
        `INSERT OR REPLACE INTO embeddings
       (photo_id, model, file_path, file_size, date_modified, vector, generic_sim)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        photo.id,
        MODEL_KEY,
        photo.file_path,
        photo.file_size,
        photo.date_modified,
        pack(vector),
        Number.isFinite(genericSim) ? genericSim : null,
      );
  }

  count() {
    return this.source
      .prepare(
        `SELECT COUNT(*) AS n FROM semantic.embeddings e JOIN photos p
      ON p.id = e.photo_id AND p.file_path = e.file_path AND p.file_size = e.file_size
      AND COALESCE(p.date_modified, '') = e.date_modified WHERE e.model = ?`,
      )
      .get(MODEL_KEY).n;
  }

  /**
   * 把刚好补齐的基线写回。失败就整批丢掉：下一次检索会重新算一遍，功能不受影响
   * （写不进去的原因通常是另一个索引 worker 正占着这个库的写锁）。
   */
  flushBaseline(pending) {
    if (!pending.length) return;
    const write = this.index.prepare('UPDATE embeddings SET generic_sim = ? WHERE photo_id = ?');
    try {
      this.index.transaction(() => {
        for (const [id, value] of pending) write.run(value, id);
      })();
    } catch (_) {}
    pending.length = 0;
  }

  /**
   * 按匹配阈值检索（不是「取前 N 条」）。
   *
   * 分数用**基线差**：每张照片先减掉它与泛化文本的相似度，剩下的才是这个查询自己带来的信号。
   * 因此返回的 `similarity` 不是原始余弦，而是这个差值 —— 阈值也作用在它上面。
   *
   * @returns {Promise<{ photos: object[], matched: number, threshold: number, truncated: boolean }>}
   *   matched 是达标总数（可能大于 photos.length，见 MAX_RESULTS）。
   */
  async search(query, options, cancelled) {
    const {
      threshold = DEFAULT_MATCH_THRESHOLD,
      baseline = null,
      maxResults = MAX_RESULTS,
    } = options || {};
    let matched = 0;
    const kept = [];
    const pending = [];
    let after = 0;
    const batch = this.source.prepare(`SELECT e.photo_id, e.vector, e.generic_sim, p.file_name,
      p.width, p.height, p.has_thumbnail, p.file_type, p.file_size, p.date_modified, p.is_favorite
      FROM semantic.embeddings e JOIN photos p ON p.id = e.photo_id
      AND p.file_path = e.file_path AND p.file_size = e.file_size
      AND COALESCE(p.date_modified, '') = e.date_modified
      WHERE e.model = ? AND e.photo_id > ? ORDER BY e.photo_id LIMIT 256`);
    while (true) {
      if (cancelled()) throw new Error('AI_CANCELLED');
      const rows = batch.all(MODEL_KEY, after);
      if (!rows.length) break;
      for (const row of rows) {
        after = row.photo_id;
        let base = row.generic_sim;
        if (base == null) {
          if (!baseline) throw new Error('AI_BASELINE_MISSING');
          base = score(baseline, row.vector);
          pending.push([row.photo_id, base]);
          if (pending.length >= BASELINE_FLUSH) this.flushBaseline(pending);
        }
        const adjusted = score(query, row.vector) - base;
        if (adjusted < threshold) continue;
        matched += 1;
        delete row.vector;
        delete row.generic_sim;
        row.id = row.photo_id;
        row.similarity = adjusted;
        kept.push(row);
        // 攒到两倍上限就排一次、留最相近的那一批：内存有界，且留下的始终是正确的 top N。
        if (kept.length >= maxResults * 2) {
          kept.sort((a, b) => b.similarity - a.similarity || a.id - b.id);
          kept.length = maxResults;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.flushBaseline(pending);
    kept.sort((a, b) => b.similarity - a.similarity || a.id - b.id);
    const truncated = kept.length > maxResults;
    if (truncated) kept.length = maxResults;
    return { photos: kept, matched, threshold, truncated };
  }

  /**
   * 给候选词打分：这些词在这个库里有没有内容。
   *
   * ## 为什么是「取样」而不是全库
   *
   * 命中数只需要区分「0 张 / 几十张 / 上千张」三档，取样几千条就够；而候选词现在有几百个，
   * 全量扫在百万库上要跑几百次全表，代价不成比例。
   *
   * ## 取样必须真的覆盖全库（2026-09-29 修）
   *
   * 老写法的窗口起点是 `1 + random * (maxId - windowSize)`，而 `maxId` 是**整个 id 空间的上界**。
   * 但入库的 photo_id 只占其中一小段（本机实测 7374 条向量只落在 `324737..332328`，而
   * `maxId` 就是 332328 附近、`maxId - windowSize` 仍远大于该段下界）—— 于是 6 个窗口里
   * 绝大多数起点都落在该段**之前**，`WHERE photo_id >= start ORDER BY photo_id LIMIT n`
   * 每次都返回**同一批最早的 n 行**，去重后 `sampled` 恒为 500/7374 = 6.8%。
   * 注释里写的「不要从最小的 id 连着读」这个防御因此**完全没有生效**，后果是
   * 本库真实有 84 张的「人物肖像」被判成 0 命中，预选词于是整体退回静态词库。
   *
   * 现在改成：起点在**入库 id 自己的范围** `[lo, hi]` 上等距铺开（不是随机），因此
   *   ① 每个窗口都落在真的有向量的区间里；
   *   ② 取样是确定性的 —— 「同一份设置重跑结果一致」是本项目的硬契约，随机取样会让
   *      预选词每次刷新都换一批，无法复现也无法断言；
   *   ③ 窗口之间不重叠（等距铺开 + 按 photo_id 去重兜底）。
   * 索引规模小于样本量时直接全量扫，不做窗口。
   *
   * ## 打分的循环顺序
   *
   * 外层行、内层候选词，且每行的 BLOB **只解码一次**成 `Float32Array`。反过来写（每个候选词
   * 各自扫一遍全库、各自 `readFloatLE`）在几百个候选词时会退化成几十亿次 Buffer 方法调用。
   */
  async scoreCandidates(candidates, options, cancelled) {
    const {
      threshold = DEFAULT_MATCH_THRESHOLD,
      baseline = null,
      sampleSize = 3000,
    } = options || {};
    if (!candidates.length || !baseline) return { sampled: 0, hits: [] };
    const bounds = this.index
      .prepare(
        'SELECT COALESCE(MIN(photo_id), 0) AS lo, COALESCE(MAX(photo_id), 0) AS hi, COUNT(*) AS n FROM embeddings',
      )
      .get();
    if (!bounds.n || !bounds.hi) return { sampled: 0, hits: [] };
    const range = this.source.prepare(
      `SELECT e.photo_id, e.vector, e.generic_sim FROM semantic.embeddings e JOIN photos p
      ON p.id = e.photo_id AND p.file_path = e.file_path AND p.file_size = e.file_size
      AND COALESCE(p.date_modified, '') = e.date_modified
      WHERE e.model = ? AND e.photo_id >= ? ORDER BY e.photo_id LIMIT ?`,
    );
    // 全量扫：把小库的取样误差直接消掉（几千条向量不值一提），也让回归里的断言可精确复现。
    const windows = [];
    if (bounds.n <= sampleSize) {
      windows.push([0, sampleSize]);
    } else {
      const windowCount = 8;
      const windowSize = Math.max(1, Math.ceil(sampleSize / windowCount));
      const span = Math.max(1, bounds.hi - bounds.lo);
      for (let w = 0; w < windowCount; w += 1)
        windows.push([bounds.lo + Math.floor((span * w) / windowCount), windowSize]);
    }
    const vectors = [];
    const seen = new Set();
    const pending = [];
    for (const [start, size] of windows) {
      for (const row of range.all(MODEL_KEY, start, size)) {
        // 等距铺开的窗口在库很密时仍可能重叠，按 photo_id 去重：同一张照片重复计分
        // 会让 hits 变成「命中次数」而不是「命中张数」。
        if (seen.has(row.photo_id)) continue;
        seen.add(row.photo_id);
        let base = row.generic_sim;
        if (base == null) {
          base = score(baseline, row.vector);
          pending.push([row.photo_id, base]);
        }
        const values = new Float32Array(DIMENSIONS);
        for (let i = 0; i < DIMENSIONS; i += 1) values[i] = row.vector.readFloatLE(i * 4);
        vectors.push({ values, base });
      }
    }
    this.flushBaseline(pending);
    const hits = new Array(candidates.length).fill(0);
    for (const { values, base } of vectors) {
      if (cancelled()) throw new Error('AI_CANCELLED');
      for (let i = 0; i < candidates.length; i += 1) {
        if (dot(candidates[i].vector, values) - base >= threshold) hits[i] += 1;
      }
    }
    return { sampled: vectors.length, hits };
  }

  close() {
    this.source.close();
    this.index.close();
  }
}

module.exports = { IndexStore, DEFAULT_MATCH_THRESHOLD, MAX_RESULTS, MATCH_THRESHOLD_RANGE };
