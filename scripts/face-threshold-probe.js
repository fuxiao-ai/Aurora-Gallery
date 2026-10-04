'use strict';
/**
 * 人脸分组阈值探针（只读、离线）。
 *
 * 用途：拿一个 faces.sqlite（用户库副本即可）量化「同一人被拆成多人」的严重程度，
 * 并对若干候选分组策略做同数据对比，给阈值选择提供实测依据，而不是拍脑袋。
 *
 * 用法：
 *   node scripts/face-threshold-probe.js <faces.sqlite 副本>
 *
 * 读法：
 *   1. 单脸组占比高 ⇒ 过度分裂。
 *   2. 组内「非种子 vs 种子」是**被阈值截断过的**数据（< 阈值的根本进不来），
 *      所以它只能证明「成型的组是紧的」，不能证明种子代表没问题。
 *   3. 组间质心相似度：每个组到「最近另一个组」的分数。≥ 当前阈值说明这两个组
 *      本该合并 —— 这是「同一人被拆开」的直接证据。
 *   4. 冒充分布：同一张照片里落在不同组的两张脸，几乎必然是不同的人
 *      （`used` 集合禁止同照片归并，所以同照片必然跨组）。去掉 ≥0.8 的
 *      同人复制尾巴（镜面/翻拍）后，剩下的就是「不同人」的相似度参考分布。
 *   5. 策略扫描：同数据重放，给出人物总数 + 重放后的残留碎片，看哪种收敛。
 */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
// 现役聚类算法的**本体**。它零原生依赖（不 require better-sqlite3 / sharp / onnxruntime），
// 所以这个只读探针可以直接引它，不必自己复刻一遍 —— 复刻会漂移，标出来的就不是线上阈值。
const { chineseWhispers, K_NEIGHBORS } = require('../src/ai/face-cluster');

function normalize(values) {
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  if (!norm) return values;
  return Float32Array.from(values, (v) => v / norm);
}
function unpack(raw) {
  // node:sqlite 把 BLOB 交回来的是 Uint8Array（不是 Buffer），readFloatLE 得先包一层。
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  // 维度从字节数推出来：检查器要能读老库（SFace 128 维 = 512 字节）也要能读新库
  // （w600k_mbf 512 维 = 2048 字节），否则换个模型这个探针就直接算错。
  const dimension = Math.floor(bytes.length / 4);
  const values = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) values[i] = bytes.readFloatLE(i * 4);
  return normalize(values);
}
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
/** 把若干 112×112 的 JPEG 缩略图拼成一张 PNG 联络图；cells 为 null 表示留白。 */
async function montage(sharp, cells, columns, out) {
  const size = 112,
    gap = 6,
    pad = 8;
  const rows = Math.ceil(cells.length / columns);
  const width = pad * 2 + columns * size + (columns - 1) * gap;
  const height = pad * 2 + rows * size + (rows - 1) * gap;
  const composites = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue;
    composites.push({
      input: await sharp(cells[i]).resize(size, size, { fit: 'cover' }).png().toBuffer(),
      left: pad + (i % columns) * (size + gap),
      top: pad + Math.floor(i / columns) * (size + gap),
    });
  }
  await sharp({ create: { width, height, channels: 3, background: '#202020' } })
    .composite(composites)
    .png()
    .toFile(out);
  return out;
}
function centroid(vectors) {
  if (vectors.length === 1) return vectors[0];
  const sum = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  return normalize(sum);
}
/**
 * 组内「到其他成员相似度之和最大」的那张脸。取 ≤16 张均匀抽样，成本固定 O(256)。
 */
function medoidOf(vectors) {
  if (vectors.length <= 2) return vectors[0];
  const sample = [];
  const step = Math.max(1, Math.floor(vectors.length / 16));
  for (let i = 0; i < vectors.length; i += step) sample.push(vectors[i]);
  if (sample[sample.length - 1] !== vectors[vectors.length - 1])
    sample.push(vectors[vectors.length - 1]);
  let best = sample[0],
    bestSum = -Infinity;
  for (const candidate of sample) {
    let sum = 0;
    for (const other of sample) sum += dot(candidate, other);
    if (sum > bestSum) {
      bestSum = sum;
      best = candidate;
    }
  }
  return best;
}
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index),
    upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
}
function line(label, s) {
  if (!s.n) return `  ${label}: (无样本)`;
  return `  ${label}: n=${String(s.n).padStart(5)}  min=${s.min.toFixed(3)}  p10=${s.p10.toFixed(3)}  p50=${s.p50.toFixed(3)}  p90=${s.p90.toFixed(3)}  max=${s.max.toFixed(3)}`;
}
function histogram(values, cuts) {
  return cuts
    .map((cut, i) => {
      const next = cuts[i + 1] ?? Infinity;
      const n = values.filter((v) => v >= cut && v < next).length;
      const bar = '#'.repeat(Math.round((n / Math.max(1, values.length)) * 36));
      const label = `${cut.toFixed(3)}-${next === Infinity ? '  inf' : next.toFixed(3)}`;
      return `    ${label}  ${String(n).padStart(5)}  ${(100 * n / Math.max(1, values.length)).toFixed(1).padStart(5)}% ${bar}`;
    })
    .join('\n');
}

/** 抽样个数上限，必须与 `src/ai/face-settings.js` 的 `REPRESENTATIVE_SAMPLE` 一致。 */
const REPRESENTATIVE_SAMPLE = 16;
/**
 * 与 `face-store.js` 的 `groupScore` **同一套定义**：组内确定性均匀抽样至多 16 个成员的
 * 平均相似度。这是线上现役算法，探针复刻它才有意义 —— 改实现时这里必须同步改，
 * 否则下面 `--calibrate` 出的表就不是线上行为。
 *
 * 要点是**固定个数**（`floor(k * len / count)`）而不是 `step` 步进：后者抽样个数随组大小
 * 抖动，会让阈值曲线剧烈跳变（0.22→0.26 之间 F1 从 0.838 掉到 0.656 再弹回 0.799）。
 */
function sampleAverage(vector, members) {
  const size = members.length;
  if (!size) return -1;
  if (size === 1) return dot(vector, members[0]);
  const count = Math.min(REPRESENTATIVE_SAMPLE, size);
  const stride = size / count;
  let total = 0;
  for (let k = 0; k < count; k++) total += dot(vector, members[Math.floor(k * stride)]);
  return total / count;
}
/**
 * 复刻 face-store.put() 的在线贪心分组，用于「同数据、不同策略」对比。
 * 顺序 = faces.id 升序（AUTOINCREMENT 即插入顺序）；同一张照片内的多个检测不互相归并。
 *
 * `average` 是线上现役策略，其余（seed / centroid / any / medoid）是历史对照 ——
 * `seed` 就是「每组最早那张脸」，本版被淘汰的原因见 docs/people-groups.md 第 3 节。
 * @param {{mode:'seed'|'centroid'|'any'|'medoid'|'average', threshold:number, margin:number|null}} options
 */
function replay(faces, options) {
  const { mode, threshold, margin } = options;
  const people = new Map();
  const perPhoto = new Map();
  let nextId = 1;
  const splits = [];
  for (const face of faces) {
    let siblings = perPhoto.get(face.photoId);
    if (!siblings) perPhoto.set(face.photoId, (siblings = new Set()));
    const scores = [];
    for (const [personId, person] of people) {
      if (siblings.has(personId)) continue;
      let score;
      if (mode === 'seed') score = dot(face.vector, person.members[0]);
      else if (mode === 'centroid') score = dot(face.vector, person.centroid);
      else if (mode === 'medoid') score = dot(face.vector, person.medoid);
      else if (mode === 'average') score = sampleAverage(face.vector, person.members);
      else score = Math.max(...person.members.map((m) => dot(face.vector, m)));
      scores.push([score, personId]);
    }
    scores.sort((a, b) => b[0] - a[0]);
    const best = scores.length ? scores[0][0] : -1;
    const second = scores.length > 1 ? scores[1][0] : -1;
    const ambiguous = margin !== null && scores.length > 1 && best - second < margin;
    if (best < threshold || ambiguous) {
      const id = nextId++;
      people.set(id, {
        id,
        members: [face.vector],
        faceIds: [face.id],
        centroid: face.vector,
        medoid: face.vector,
      });
      siblings.add(id);
      splits.push({ score: best, second, ambiguous, faceId: face.id });
    } else {
      const person = people.get(scores[0][1]);
      person.members.push(face.vector);
      person.faceIds.push(face.id);
      person.centroid = centroid(person.members);
      // medoid = 组内「到其他成员相似度之和最大」的那张脸：比「第一个进来的脸」稳定得多。
      // 只在成员抽样上算，避免 O(k³) 拖死探针（线上同理，见 face-store 注释）。
      person.medoid = medoidOf(person.members);
      siblings.add(person.id);
    }
  }
  return { people, splits };
}

/** 任意分组的「碎片度」：单脸组占比 + 组间最近邻分数分布。 */
function fragmentation(people) {
  const list = [...people.values()];
  const singletons = list.filter((p) => p.members.length === 1).length;
  const nearest = [];
  for (const a of list) {
    let best = -1;
    for (const b of list) if (a !== b) best = Math.max(best, dot(a.centroid, b.centroid));
    nearest.push(best);
  }
  return { people: list.length, singletons, nearest };
}

/**
 * 合并收敛：反复把质心相似度 ≥ threshold 的组两两合并（每轮合并后重算质心）直到稳定。
 * 这一步专门修「在线贪心看走眼」——某张脸到达时最近的组质心还不够像，于是新建了组，
 * 之后两个组各自长大、质心越走越近。在线算法无法回头，离线收敛可以。
 */
/**
 * 合并收敛。两种策略：
 *  - 'chain'  ：每轮把所有质心相似度 ≥ threshold 的组做并查集合并（会链式传染，实测在
 *               cosplay 肖像库上把 1135/1268 张脸并成一组，不可用，仅作反面参照）。
 *  - 'mutual' ：只合并「互为最近邻且分数 ≥ threshold」的组对，天然阻断链式传染。
 */
function consolidate(people, threshold, strategy = 'mutual') {
  let list = [...people.values()].map((p) => ({ ...p }));
  let merges = 0;
  for (let round = 0; round < 20; round++) {
    const merged = new Set();
    let changed = false;
    if (strategy === 'chain') {
      const parent = list.map((_, i) => i);
      const find = (i) => {
        while (parent[i] !== i) i = parent[i] = parent[parent[i]];
        return i;
      };
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          if (dot(list[i].centroid, list[j].centroid) >= threshold) {
            const a = find(i),
              b = find(j);
            if (a !== b) parent[b] = a;
          }
      const buckets = new Map();
      for (let i = 0; i < list.length; i++) {
        const root = find(i);
        if (!buckets.has(root)) buckets.set(root, []);
        buckets.get(root).push(list[i]);
      }
      if (buckets.size === list.length) break;
      merges += list.length - buckets.size;
      list = [...buckets.values()].map((group) => {
        const members = group.flatMap((p) => p.members);
        return {
          id: group[0].id,
          members,
          faceIds: group.flatMap((p) => p.faceIds || []),
          centroid: centroid(members),
        };
      });
      continue;
    }
    // mutual：先各自找最近邻，再只合并互相认定的对。
    const nearest = list.map((person) => {
      let best = -1,
        index = -1;
      for (let j = 0; j < list.length; j++) {
        if (list[j] === person) continue;
        const score = dot(person.centroid, list[j].centroid);
        if (score > best) {
          best = score;
          index = j;
        }
      }
      return { score: best, index };
    });
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (merged.has(i)) continue;
      const partner = nearest[i].index;
      if (
        partner >= 0 &&
        !merged.has(partner) &&
        nearest[i].score >= threshold &&
        nearest[partner].index === i &&
        nearest[partner].score >= threshold
      ) {
        const members = [...list[i].members, ...list[partner].members];
        out.push({
          id: list[i].id,
          members,
          faceIds: [...(list[i].faceIds || []), ...(list[partner].faceIds || [])],
          centroid: centroid(members),
        });
        merged.add(i);
        merged.add(partner);
        merges++;
        changed = true;
      } else {
        out.push(list[i]);
      }
    }
    list = out;
    if (!changed) break;
  }
  return { people: new Map(list.map((p, i) => [p.id ?? -(i + 1), p])), merges };
}

/**
 * 标准答案：把照片路径截到「根目录下第 `depth` 层子目录」。
 *
 * 前缀固定取 2 段（`K:\COS` / `G:\T` 这类「盘符 + 根名」）—— **本机两个根都是两段**，
 * 换别的根布局要同步改这个数字。语义与产品里 `face-store.js` 的 `folderGroupKey` 一致，
 * 只是那边按 `root_folders` 表算，这边为了不依赖 better-sqlite3 而写死。
 */
function truthKey(filePath, depth) {
  const parts = String(filePath)
    .replace(/\//g, '\\')
    .split('\\')
    .filter(Boolean);
  parts.pop(); // 去掉文件名
  return parts.slice(0, 2 + depth).join('\\');
}
/**
 * 配对级 P/R/F1：把「同一个人」定义成「同一个组」，比较预测分组与标准答案。
 * 数配对（n·(n-1)/2）而不是整组，这样某个人的脸被切成多组时也能拿到部分分数。
 * 这也是唯一能给出可信数值的判据 —— 「肉眼分档」只会得到循环论证（见 docs）。
 */
function scoreClustering(labels, truth) {
  const groups = new Map(),
    truths = new Map(),
    cells = new Map();
  for (let i = 0; i < labels.length; i++) {
    groups.set(labels[i], (groups.get(labels[i]) || 0) + 1);
    truths.set(truth[i], (truths.get(truth[i]) || 0) + 1);
    const key = labels[i] + '\u0000' + truth[i];
    cells.set(key, (cells.get(key) || 0) + 1);
  }
  const pairs = (n) => (n * (n - 1)) / 2;
  let predicted = 0,
    actual = 0,
    hit = 0;
  for (const n of groups.values()) predicted += pairs(n);
  for (const n of truths.values()) actual += pairs(n);
  for (const n of cells.values()) hit += pairs(n);
  const precision = predicted ? hit / predicted : 0;
  const recall = actual ? hit / actual : 0;
  return {
    groups: groups.size,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/face-threshold-probe.js <faces.sqlite>');
  const db = new DatabaseSync(path.resolve(file), { readOnly: true });
  const faces = db
    .prepare('SELECT id, photo_id, person_id, vector, thumbnail FROM faces ORDER BY id')
    .all()
    .map((row) => ({
      id: row.id,
      photoId: row.photo_id,
      personId: row.person_id,
      vector: unpack(row.vector),
      thumbnail: Buffer.isBuffer(row.thumbnail)
        ? row.thumbnail
        : Buffer.from(row.thumbnail.buffer, row.thumbnail.byteOffset, row.thumbnail.byteLength),
    }));
  const peopleRows = db.prepare('SELECT id, name FROM people ORDER BY id').all();
  const named = peopleRows.filter((row) => row.name && row.name.trim()).length;

  // --calibrate [阈值列表,逗号分隔] [层级]：用「有脸照片所在的目录 = 一个人」当标准答案扫阈值。
  // 这是给阈值定档的**唯一**正确方式；不要再用「肉眼把相似度分档」——那是循环论证，
  // 只会得出「越像的越像」而已（上一版就是这么把 0.55 定错的，见 docs/people-groups.md）。
  const calibrateArg = process.argv.indexOf('--calibrate');
  if (calibrateArg >= 0) {
    const levels = (process.argv[calibrateArg + 1] || '0.18,0.19,0.20,0.21,0.22,0.25,0.30')
      .split(',')
      .map(Number);
    const depth = Number(process.argv[calibrateArg + 2] ?? 1);
    const scans = db.prepare('SELECT photo_id, file_path FROM scans').all();
    const dirOf = new Map(scans.map((row) => [row.photo_id, truthKey(row.file_path, depth)]));
    const truth = faces.map((face) => dirOf.get(face.photoId) || '(未知)');
    const truths = new Set(truth);
    console.log('===== 标定：标准答案 = 有脸照片所在的目录 =====');
    console.log(
      `层级 ${depth} → ${truths.size} 个目录 = ${truths.size} 个人，共 ${faces.length} 张脸`,
    );
    // ⚠️ 阈值不能跨识别器照搬：SFace（128 维）的余弦整体偏高，用现役的 0.20 去跑
    // 会把所有人并成一团（实测 3501 张脸 → 1 组 / P 0.254）。这里硬编码 512 而不是
    // require face-model：探针刻意不引入任何原生依赖（见 `../src/ai/face-cluster` 的注释）。
    const dim = faces.length ? faces[0].vector.length : 0;
    if (dim !== 512)
      console.log(
        `⚠️ 这份库的向量是 ${dim} 维（现役 w600k_mbf 是 512 维）。旧识别器的相似度分布\n` +
          '   整体偏高，下面的 cw 阈值不可照搬 —— 只能用来对比同一份向量下的策略优劣。',
      );
    if (truths.size < 2) {
      console.log('（标准答案少于 2 组，评不了分；检查第 2 个参数（层级））');
      db.close();
      return;
    }
    const indexOf = new Map(faces.map((face, index) => [face.id, index]));
    const row = (name, threshold, s) =>
      console.log(
        name.padEnd(11) +
          threshold.toFixed(2).padEnd(8) +
          String(s.groups).padStart(4) +
          '   ' +
          s.precision.toFixed(3).padStart(8) +
          '  ' +
          s.recall.toFixed(3).padStart(7) +
          '  ' +
          s.f1.toFixed(3).padStart(6),
      );
    console.log('');
    console.log('策略        阈值    组数   precision  recall    F1');
    // 现役策略（v3）：Chinese Whispers 全局聚类，**直接引线上本体**。
    const photoIds = faces.map((face) => face.photoId);
    const vectors = faces.map((face) => face.vector);
    const noAnchors = new Map();
    for (const threshold of levels)
      row(
        `cw K=${K_NEIGHBORS}`,
        threshold,
        scoreClustering(chineseWhispers(photoIds, vectors, threshold, noAnchors), truth),
      );
    // 历史对照一（v2）：`put()` 的增量近似贪心 —— 顺序相关，只是索引过程中的过渡态。
    for (const mode of ['average', 'seed']) {
      for (const threshold of levels) {
        const { people } = replay(faces, { mode, threshold, margin: null });
        const labels = new Array(faces.length);
        for (const person of people.values())
          for (const faceId of person.faceIds) labels[indexOf.get(faceId)] = person.id;
        row(mode, threshold, scoreClustering(labels, truth));
      }
    }
    console.log('');
    console.log(
      '注：cw = 现役策略（Chinese Whispers 全局聚类，索引收尾与「按当前设置重新归组」跑的就是它）；\n' +
        '    average = v2 的增量近似（put() 的代表集打分，顺序相关）；seed = 更早的「每组最早那张脸」。',
    );
    db.close();
    return;
  }

  const byPerson = new Map();
  for (const face of faces) {
    if (!byPerson.has(face.personId)) byPerson.set(face.personId, []);
    byPerson.get(face.personId).push(face);
  }

  console.log('===== 0. 规模 =====');
  console.log('faces            :', faces.length);
  console.log('people 表行数     :', peopleRows.length);
  console.log('有脸的 people     :', byPerson.size);
  console.log('用户已命名       :', named);
  console.log('平均脸/人        :', (faces.length / byPerson.size).toFixed(2));

  console.log('\n===== 1. 每人脸数分布（过度分裂的直接指纹）=====');
  const sizeHist = new Map();
  for (const list of byPerson.values()) sizeHist.set(list.length, (sizeHist.get(list.length) || 0) + 1);
  [...sizeHist.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([size, n]) =>
      console.log(`  ${String(size).padStart(2)} 张脸 : ${String(n).padStart(4)} 人  ${(100 * n / byPerson.size).toFixed(1)}%`),
    );
  console.log(`  → 单脸组 ${sizeHist.get(1) || 0} 占比 ${(100 * (sizeHist.get(1) || 0) / byPerson.size).toFixed(1)}%`);

  console.log('\n===== 2. 组内一致性（注意：被阈值截断，只见"成型后是紧的"）=====');
  const seedScores = [];
  const memberScores = [];
  for (const list of byPerson.values()) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i++) seedScores.push(dot(list[0].vector, list[i].vector));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) memberScores.push(dot(list[i].vector, list[j].vector));
  }
  console.log(line('非种子 vs 种子', stats(seedScores)));
  console.log(line('组内任意两脸  ', stats(memberScores)));

  console.log('\n===== 3. 组间最近邻（质心）："本该合并"的分数分布 =====');
  const online = new Map(
    [...byPerson.entries()].map(([personId, list]) => [
      personId,
      { id: personId, members: list.map((f) => f.vector), centroid: centroid(list.map((f) => f.vector)) },
    ]),
  );
  const onlineFrag = fragmentation(online);
  console.log(line('每组到最近另一组', stats(onlineFrag.nearest)));
  console.log(histogram(onlineFrag.nearest, [0, 0.3, 0.363, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 1.01]));
  for (const cut of [0.45, 0.5, 0.55, 0.6, 0.7, 0.8]) {
    const n = onlineFrag.nearest.filter((v) => v >= cut).length;
    console.log(`  最近邻 ≥ ${cut.toFixed(2)} 的组: ${String(n).padStart(4)} / ${onlineFrag.people}  (${(100 * n / onlineFrag.people).toFixed(1)}%)`);
  }

  console.log('\n===== 3b. 按组大小拆分最近邻（区分"真碎片"与"假脸"）=====');
  const onlineList = [...online.values()];
  for (const [label, filter] of [
    ['单脸组  ', (p) => p.members.length === 1],
    ['2 脸组  ', (p) => p.members.length === 2],
    ['3+ 脸组 ', (p) => p.members.length >= 3],
  ]) {
    const subset = onlineList.filter(filter);
    const nearest = subset.map((a) => {
      let best = -1;
      for (const b of onlineList) if (a !== b) best = Math.max(best, dot(a.centroid, b.centroid));
      return best;
    });
    console.log(`  ${label} ${line('', stats(nearest)).trim()}`);
    console.log(
      `           其中 ≥0.6 的: ${nearest.filter((v) => v >= 0.6).length} / ${subset.length}` +
        `  (${(100 * nearest.filter((v) => v >= 0.6).length / Math.max(1, subset.length)).toFixed(1)}%)`,
    );
  }

  console.log('\n===== 4. 冒充分布：同照片跨组的两张脸（≈不同人）=====');
  const photoGroups = new Map();
  for (const face of faces) {
    if (!photoGroups.has(face.photoId)) photoGroups.set(face.photoId, []);
    photoGroups.get(face.photoId).push(face);
  }
  const impostor = [];
  let multiFacePhotos = 0;
  for (const list of photoGroups.values()) {
    if (list.length < 2) continue;
    multiFacePhotos++;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) impostor.push(dot(list[i].vector, list[j].vector));
  }
  const impostorClean = impostor.filter((v) => v < 0.8);
  console.log(`  多人照片 ${multiFacePhotos} 张，同照片跨组对 ${impostor.length} 对`);
  console.log(line('全部同照片跨组对', stats(impostor)));
  console.log(line('去掉 ≥0.8（同人复制）后的冒充样本', stats(impostorClean)));
  console.log(histogram(impostorClean, [0, 0.2, 0.3, 0.363, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8]));
  for (const cut of [0.363, 0.4, 0.45, 0.5, 0.55, 0.6]) {
    const n = impostorClean.filter((v) => v >= cut).length;
    console.log(
      `  冒充样本 ≥ ${cut.toFixed(3)}: ${String(n).padStart(5)} (${(100 * n / Math.max(1, impostorClean.length)).toFixed(2)}%)` +
        `   ← 阈值取 ${cut.toFixed(3)} 时，这类"不同人"有被误并的风险`,
    );
  }

  const onlineReplay = replay(faces.map((f) => ({ ...f })), {
    mode: 'seed',
    threshold: 0.6,
    margin: 0.05,
  });
  const consistent = onlineReplay.people.size === byPerson.size;
  console.log(
    `\n  重放校验（seed/0.6/margin0.05）得 ${onlineReplay.people.size} 组，库里 ${byPerson.size} 组 ${consistent ? '一致 ✔ 重放可信' : '不一致'}`,
  );
  if (!consistent) {
    console.log(
      '  不一致不一定是探针错：库里这份分组可能不是旧规则（seed/0.6/margin）产的——\n' +
        '  例如刚做过「按当前阈值重新归组」、或索引正在跑。要拿它当基线，请用一份未改过的索引库副本。',
    );
  }

  // 5 / 6 两节是「标定阈值」时用的扫描：几十次全量重放，在 3000 张脸 / 2600 个组上要跑好几分钟。
  // 它们是标定工具而不是体检工具，因此默认关掉，需要时显式加 --sweep。
  if (!process.argv.includes('--sweep')) {
    console.log(
      '\n  提示：跳过第 5 / 6 节（策略扫描与合并收敛）。要跑它们请加 --sweep —— 在数千张脸、数千个组上需要几分钟。',
    );
  } else {
    console.log('\n===== 5. 策略扫描：同数据重放 =====');
    console.log('  mode      thr    margin  people  单脸组  单脸%  残留碎片(最近邻≥thr)');
    console.log('  ------------------------------------------------------------------');
    const candidates = [];
    for (const threshold of [0.363, 0.4, 0.45, 0.5, 0.55, 0.6]) {
      for (const mode of ['seed', 'medoid', 'centroid', 'any']) {
        for (const margin of [0.05, null]) {
          const { people } = replay(
            faces.map((f) => ({ ...f })),
            { mode, threshold, margin },
          );
          const frag = fragmentation(people);
          const residual = frag.nearest.filter((v) => v >= threshold).length;
          candidates.push({ mode, threshold, margin, ...frag, residual });
          console.log(
            `  ${mode.padEnd(8)} ${threshold.toFixed(3)}  ${String(margin === null ? '-' : margin).padEnd(6)} ${String(frag.people).padStart(6)}  ${String(frag.singletons).padStart(6)}  ${((100 * frag.singletons) / frag.people).toFixed(1).padStart(5)}%  ${String(residual).padStart(4)}`,
          );
        }
      }
    }

    console.log('\n===== 6. 在线分组 + 离线合并收敛（修"看走眼"的顺序效应）=====');
    console.log(
      '  在线策略                thr   收敛thr  策略    在线组  收敛后  合并  单脸组  单脸%  最大组',
    );
    console.log(
      '  --------------------------------------------------------------------------------------',
    );
    for (const threshold of [0.55, 0.6]) {
      for (const mode of ['seed', 'centroid']) {
        for (const margin of [0.05, null]) {
          const { people } = replay(faces.map((f) => ({ ...f })), { mode, threshold, margin });
          const before = fragmentation(people).people;
          for (const converge of [0.6]) {
            for (const strategy of ['chain', 'mutual']) {
              const { people: after, merges } = consolidate(people, converge, strategy);
              const frag = fragmentation(after);
              const biggest = Math.max(...[...after.values()].map((p) => p.members.length));
              console.log(
                `  ${(margin === null ? mode + '/无margin' : mode + '/margin' + margin).padEnd(22)} ${threshold.toFixed(2)}   ${converge.toFixed(2)}     ${strategy.padEnd(6)}  ${String(before).padStart(5)}  ${String(frag.people).padStart(6)}  ${String(merges).padStart(5)}  ${String(frag.singletons).padStart(6)}  ${((100 * frag.singletons) / frag.people).toFixed(1).padStart(5)}%  ${String(biggest).padStart(5)}`,
              );
            }
          }
        }
      }
    }
  }

  const dumpIndex = process.argv.indexOf('--dump');
  const resultArg = process.argv.indexOf('--result');
  if (resultArg >= 0 && dumpIndex >= 0) {
    const mode = ['seed', 'centroid', 'any', 'medoid'].includes(process.argv[resultArg + 1])
      ? process.argv[resultArg + 1]
      : 'centroid';
    const online = Number(process.argv[resultArg + 2] ?? 0.6);
    const converge = Number(process.argv[resultArg + 3] ?? 0);
    const outDir = path.resolve(process.argv[dumpIndex + 1] || '.');
    const fs = require('node:fs');
    const sharp = require('sharp');
    fs.mkdirSync(outDir, { recursive: true });
    const thumbOf = new Map(faces.map((f) => [f.id, f.thumbnail]));
    const { people: grouped } = replay(faces.map((f) => ({ ...f })), {
      mode,
      threshold: online,
      margin: null,
    });
    const { people: merged, merges } = converge
      ? consolidate(grouped, converge, 'mutual')
      : { people: grouped, merges: 0 };
    const list = [...merged.values()];
    const frag = fragmentation(merged);
    const sizes = list.map((p) => p.members.length).sort((a, b) => b - a);
    console.log(`\n===== 7. 候选算法结果  mode=${mode} online=${online} converge=${converge || '无'} =====`);
    console.log(
      `  ${grouped.size} 组${converge ? ` → 收敛 ${merges} 次 → ${list.length} 组` : ''}；单脸组 ${frag.singletons}（${((100 * frag.singletons) / list.length).toFixed(1)}%）`,
    );
    console.log(`  组大小: ${sizes.slice(0, 25).join(' ')} ...`);
    // 残留：仍有 ≥0.5 的近邻组对，就是「同一人仍被拆开」的残余。
    const residual = [];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        residual.push({ score: dot(list[i].centroid, list[j].centroid), a: list[i], b: list[j] });
    residual.sort((x, y) => y.score - x.score);
    for (const cut of [0.5, 0.55, 0.6])
      console.log(
        `  残留组对 ≥ ${cut.toFixed(2)}: ${residual.filter((r) => r.score >= cut).length} 对`,
      );
    // 最大的 12 个组各出一行，用来判断有没有把不同人并进来（过并）。
    const biggest = [...list].sort((a, b) => b.members.length - a.members.length).slice(0, 12);
    const bigCells = [];
    const bigLabels = [];
    for (const person of biggest) {
      const ordered = person.members
        .map((vector, i) => ({ vector, id: person.faceIds[i] }))
        .sort((m, n) => dot(n.vector, person.centroid) - dot(m.vector, person.centroid));
      const step = Math.max(1, Math.floor(ordered.length / 12));
      const picked = ordered.filter((_, i) => i % step === 0).slice(0, 12);
      bigLabels.push(`  (${person.members.length}脸) → ${picked.map((f) => f.id).join(',')}`);
      bigCells.push(...picked.map((f) => thumbOf.get(f.id)));
    }
    await montage(sharp, bigCells, 12, path.join(outDir, `biggest-${mode}-${online}.png`));
    console.log(`  [dump] biggest-${mode}-${online}.png —— 最大 12 组各一行：`);
    bigLabels.forEach((l) => console.log(l));
    console.log(`  输出目录: ${outDir}`);
  }

  if (dumpIndex >= 0) {
    const outDir = path.resolve(process.argv[dumpIndex + 1] || '.');
    const fs = require('node:fs');
    const sharp = require('sharp');
    fs.mkdirSync(outDir, { recursive: true });
    const thumbOf = new Map(faces.map((f) => [f.id, f.thumbnail]));

    // A. 可疑对：把「两个组」的最近邻按分数分档 dump，用来肉眼判定不同档位到底是不是同一个人。
    //    档位边界就是候选阈值：若 0.45-0.6 档看着都是同一个人，说明 0.6 拒绝合并是错的。
    const bandArg = process.argv.indexOf('--band');
    const bands =
      bandArg >= 0
        ? [[Number(process.argv[bandArg + 1]), Number(process.argv[bandArg + 2])]]
        : [
            [0.85, 1.01],
            [0.7, 0.85],
            [0.6, 0.7],
            [0.5, 0.6],
            [0.363, 0.5],
          ];
    const allPairs = new Map();
    for (const a of onlineList) {
      let best = -1,
        bestPerson = null;
      for (const b of onlineList) {
        if (a === b) continue;
        const score = dot(a.centroid, b.centroid);
        if (score > best) {
          best = score;
          bestPerson = b;
        }
      }
      if (a.id < bestPerson.id) allPairs.set(a.id, { score: best, a, b: bestPerson });
    }
    const pickFace = (person) => {
      const members = [...byPerson.get(person.id)].sort(
        (m, n) => dot(n.vector, person.centroid) - dot(m.vector, person.centroid),
      );
      return members[0].id;
    };
    for (const [lo, hi] of bands) {
      const band = [...allPairs.values()]
        .filter((p) => p.score >= lo && p.score < hi)
        .sort((x, y) => y.score - x.score);
      if (!band.length) continue;
      console.log(
        `\n  [dump] 档位 ${lo.toFixed(3)}-${hi.toFixed(3)}：${band.length} 对，取前 ${Math.min(band.length, 12)} 对出图`,
      );
      const shown = band.slice(0, 12);
      const cells = [];
      for (const row of shown)
        cells.push(thumbOf.get(pickFace(row.a)), thumbOf.get(pickFace(row.b)));
      await montage(
        sharp,
        cells,
        12,
        path.join(outDir, `band-${lo.toFixed(3)}-${hi.toFixed(3)}.png`),
      );
      shown.forEach((row, i) =>
        console.log(
          `    第${Math.floor(i / 6) + 1}行-${(i % 6) + 1}: #${row.a.id}(${row.a.members.length}脸) ↔ #${row.b.id}(${row.b.members.length}脸)  sim=${row.score.toFixed(3)}`,
        ),
      );
    }


    // B. 单脸组抽样：看这些"只有一张脸的人"到底是真人碎片还是检测出的假脸。
    const singletons = onlineList.filter((p) => p.members.length === 1);
    const stride = Math.max(1, Math.floor(singletons.length / 40));
    const sample = singletons.filter((_, i) => i % stride === 0).slice(0, 40);
    await montage(
      sharp,
      sample.map((p) => thumbOf.get(byPerson.get(p.id)[0].id)),
      10,
      path.join(outDir, 'singletons.png'),
    );
    console.log(`\n  [dump] singletons.png —— 单脸组抽样 ${sample.length}/${singletons.length}（每 ${stride} 取 1），10 列：`);
    console.log(`    ${sample.map((p) => '#' + p.id).join(' ')}`);

    // C. 已成型的大组：确认"真人物"样本长什么样。
    const big = [...onlineList].sort((a, b) => b.members.length - a.members.length).slice(0, 6);
    const bigCells = [];
    const bigLabels = [];
    for (const person of big) {
      const members = [...byPerson.get(person.id)].sort(
        (m, n) => dot(n.vector, person.centroid) - dot(m.vector, person.centroid),
      );
      const step = Math.max(1, Math.floor(members.length / 10));
      const picked = members.filter((_, i) => i % step === 0).slice(0, 10);
      bigLabels.push(`#${person.id}(${members.length}脸) → ${picked.map((f) => f.id).join(',')}`);
      bigCells.push(...picked.map((f) => f.thumbnail));
    }
    await montage(sharp, bigCells, 10, path.join(outDir, 'big-groups.png'));
    console.log(`\n  [dump] big-groups.png —— 每组一行 10 张：`);
    bigLabels.forEach((l) => console.log(`    ${l}`));
    console.log(`\n  输出目录: ${outDir}`);
  }
  db.close();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
