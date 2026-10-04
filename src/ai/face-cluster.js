'use strict';
/**
 * 人脸聚类的**纯算法**层 —— 只认「照片 id + 特征向量」，不依赖
 * better-sqlite3 / sharp / onnxruntime。
 *
 * 抽成独立模块是为了让离线探针（`scripts/face-threshold-probe.js`）能**直接引入
 * 这份本体**来复算线上行为，而不是自己再把算法写一遍。复刻的代价是「漂移」：
 * 算法改了、探针没改，标定出来的阈值就不再是线上阈值 —— 而那正是给阈值定档时
 * 最容易骗过自己的一条路。
 *
 * `face-store.js` 从这里引入 `groupScore` / `chineseWhispers` 并原样 re-export，
 * 所以对外的模块接口没有变。
 */
const { REPRESENTATIVE_SAMPLE } = require('./face-settings');

/** 余弦相似度。调用方保证向量已 L2 归一（`face-model.js` 在产出向量时统一做）。 */
function similarity(a, b) {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}

/**
 * 新增人脸与一个已有组的相似度 = 与**组内确定性均匀抽样至多 16 个成员**的平均值。
 *
 * 为什么不取「组内最早那张脸」：锚点质量全凭运气 —— 队首若是侧脸 / 闭眼 / 暗光，
 * 整组就再难接纳同一人的其他照片（旧策略即使把阈值压到下限也只有 11 组 / F1 0.297）。
 * 为什么不用质心 / 单链：本库是「同一人常换假发」的图库，组内本身离散 —— 质心会
 * 「糊」成所有人的平均、单链会传染（实测最大组吞到 403 张、把不同人并进来）。
 *
 * 为什么用固定个数（`Math.floor(k * size / count)`）而不是 `step` 步进：`step` 会让
 * 抽样个数随组大小抖动，导致阈值曲线剧烈跳变（真库上 0.22→0.26 之间 F1 从 0.838
 * 掉到 0.656 再弹回 0.799，用户改 0.01 结果剧变）；固定个数后整段曲线平滑。
 *
 * ⚠️ 这只用于**索引过程中的增量近似**（`put()`）。全局分组由 `chineseWhispers` 决定。
 */
function groupScore(members, vector) {
  const size = members.length;
  if (!size) return -1;
  if (size === 1) return similarity(vector, members[0]);
  const count = Math.min(REPRESENTATIVE_SAMPLE, size);
  const stride = size / count;
  let total = 0;
  for (let k = 0; k < count; k++) total += similarity(vector, members[Math.floor(k * stride)]);
  return total / count;
}

/**
 * Chinese Whispers 的参数（对应 julyx10/lap 的 `t_common.rs` + `t_cluster.rs`）。
 *
 * ⚠️ **K_NEIGHBORS 不能照抄 LAP 的 80** —— 那是给他们那套数据 / 模型调出来的。
 * 本库 3501 张脸、标准答案 = `K:\COS\<编号>`（6 个人），同数据实测多个随机种子的
 * F1 均值：
 *
 *   K=80   → 0.778（种子间 0.666–0.856，且阈值 0.20–0.40 结果逐位不动）← 直接抄 LAP
 *   K=400  → 0.879–0.935（种子间 0.90–0.95）                ← 本库取值
 *   K=800  → 0.30 就塌成 1 组（连边太多，全库拉成一个连通分量）
 *
 * K 太小会让图被剪成一堆只有局部连接的碎块、结果对访问顺序极度敏感；
 * K 太大则失去剪枝的意义。**K 是这张图唯一的「分辨率」旋钮，两头都错。**
 */
const K_NEIGHBORS = 400;
const MAX_ITERATIONS = 20;
/**
 * 固定种子。Chinese Whispers 是**随机顺序**投票，不固定种子的话「同一设置重跑」
 * 会给出不同分组（实测 K=80 时 F1 在 0.666–0.856 之间抖）。固定种子牺牲一点
 * 「跳出局部最优」的能力，换来「同设置重跑必须幂等」这条契约。
 */
const CW_SEED = 20260929;
/**
 * 「索引收尾自动跑一次全局聚类」的规模上限。
 *
 * Chinese Whispers 建图是 O(n²)：本库 3501 张脸约 10 秒，8000 张约 1 分钟。
 * 再多就不该塞在「索引收尾」里了 —— 超过上限只跳过**自动**的那一次，
 * 用户仍可以手动点「按当前设置重新归组」（那时是他自己在等，有预期）。
 */
const AUTO_REGROUP_LIMIT = 8000;

/**
 * 有界最小堆：只保留权重最大的 `size` 条边。
 *
 * 直接往每张脸的候选表里推再排序会让内存涨到「配对总数 × 2」个条目（本库 1200 万条，
 * 约 700 MB）。这里边扫边剪：堆没满就插入，满了只在「比当前最小的大」时替换，
 * 绝大多数配对走 O(1) 的提前拒绝。
 */
function topKPush(heap, node, weight) {
  const { size, nodes, weights } = heap;
  if (heap.length < size) {
    let i = heap.length++;
    nodes[i] = node;
    weights[i] = weight;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (weights[parent] <= weights[i]) break;
      const n = nodes[parent];
      nodes[parent] = nodes[i];
      nodes[i] = n;
      const w = weights[parent];
      weights[parent] = weights[i];
      weights[i] = w;
      i = parent;
    }
    return;
  }
  if (weight <= weights[0]) return;
  nodes[0] = node;
  weights[0] = weight;
  let i = 0;
  for (;;) {
    const left = i * 2 + 1;
    const right = left + 1;
    let smallest = i;
    if (left < size && weights[left] < weights[smallest]) smallest = left;
    if (right < size && weights[right] < weights[smallest]) smallest = right;
    if (smallest === i) break;
    const n = nodes[smallest];
    nodes[smallest] = nodes[i];
    nodes[i] = n;
    const w = weights[smallest];
    weights[smallest] = weights[i];
    weights[i] = w;
    i = smallest;
  }
}

/**
 * Chinese Whispers 聚类（julyx10/lap 的 `cluster_faces` 同构）。
 *
 * 三步：
 *   1. 建 **K-NN 图** —— 相似度 ≥ 阈值的才连边，权 = 相似度²（平方以惩罚弱连接），
 *      每张脸只保留最像的 `K_NEIGHBORS` 条。**同一张照片的两张脸绝不连边**，
 *      否则合照里的两个人会被并成一个人。
 *   2. **加权投票**：随机顺序逐点扫，把标签改成「邻居标签加权和」最大的那个，
 *      最多 `MAX_ITERATIONS` 轮，没有点改标签就提前收敛。
 *   3. 同标签的合成一簇。
 *
 * `anchors` 是「下标 → person_id」的表，对应**锚点**（用户手工命名过的组）：它们的标签
 * 固定为 `-(person_id + 1)`，既不参与投票也不会被改，但对邻居照常投票 —— 于是它们像磁铁
 * 一样把附近的脸吸过来，用户的命名与手工整理不会被重算冲掉。
 *
 * 返回 `labels[i]`：负数 = 落进锚点组（`-label - 1` 就是 person_id），非负 = 本轮新建的簇号。
 */
function chineseWhispers(photoIds, vectors, threshold, anchors) {
  const n = vectors.length;
  const heaps = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = vectors[i];
    for (let j = i + 1; j < n; j++) {
      if (photoIds[i] === photoIds[j]) continue;
      const score = similarity(a, vectors[j]);
      if (score < threshold) continue;
      const weight = score * score;
      if (!heaps[i])
        heaps[i] = {
          size: K_NEIGHBORS,
          nodes: new Int32Array(K_NEIGHBORS),
          weights: new Float32Array(K_NEIGHBORS),
          length: 0,
        };
      if (!heaps[j])
        heaps[j] = {
          size: K_NEIGHBORS,
          nodes: new Int32Array(K_NEIGHBORS),
          weights: new Float32Array(K_NEIGHBORS),
          length: 0,
        };
      topKPush(heaps[i], j, weight);
      topKPush(heaps[j], i, weight);
    }
  }
  const labels = new Array(n);
  const isLocked = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (anchors.has(i)) {
      labels[i] = -(anchors.get(i) + 1);
      isLocked[i] = 1;
    } else labels[i] = i;
  }
  let state = CW_SEED >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const swap = order[i];
      order[i] = order[j];
      order[j] = swap;
    }
    let changed = false;
    for (const node of order) {
      const heap = heaps[node];
      if (isLocked[node] || !heap || !heap.length) continue;
      const votes = new Map();
      for (let k = 0; k < heap.length; k++) {
        const label = labels[heap.nodes[k]];
        votes.set(label, (votes.get(label) || 0) + heap.weights[k]);
      }
      let bestLabel = labels[node];
      let bestWeight = -1;
      for (const [label, weight] of votes)
        if (weight > bestWeight) {
          bestWeight = weight;
          bestLabel = label;
        }
      if (labels[node] !== bestLabel) {
        labels[node] = bestLabel;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
}

module.exports = {
  similarity,
  groupScore,
  chineseWhispers,
  K_NEIGHBORS,
  MAX_ITERATIONS,
  CW_SEED,
  AUTO_REGROUP_LIMIT,
};
