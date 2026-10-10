'use strict';
/**
 * 任务**预计剩余时间（ETA）**的唯一来源。
 *
 * 🔴 为什么收成一处（2026-10-08）：原先这套算法整段住在 `main.js` 里（`estimateEtaSeconds` +
 *    平滑版），只有「主进程手上有 `startedAt`」的任务用得上；而人脸 / 搜图那两个任务
 *    **`startedAt` 在 worker 里**（主进程拿不到），于是它们改报 `ratePerMinute`，
 *    界面上就成了 5 个任务报 ETA、2 个任务报速率 —— 同一个面板里两种读法（见
 *    `docs/contracts/background-tasks.md` §7）。搬出来之后「由速率反推」和「由耗时反推」
 *    并排放，两条口径的差别一眼能看见，不会各写一份。
 *
 * ⚠️ 两个入口的**适用面是互补的**，别混着调：
 *   · `estimateEtaSecondsFromRate` —— 速率**已经算好**（worker 自报的 `ratePerMinute`），
 *     只要剩下多少件。**人脸 / 搜图**走这条。
 *   · `estimateEtaSecondsSmoothed` —— 主进程自己**持有 `startedAt`** 的任务（扫描 / 补全 /
 *     重建 / 无效清理 / 查重）走这条，它按 `taskKey` 做指数平滑压抖。
 *   ⚠️ **不许**为了「统一」把主进程那五个也改成速率版：那五个的 `done` 里有**跨重启累计**
 *      的部分（缩略图重建尤甚），主进程的 `startedAt` 是**本次**口径 ⇒ 分子分母一串口径，
 *      速率被放大 18 倍（真实故障，见契约 §7 那条 ⚠️）。它们必须继续用 `startedAt` 版。
 */

/** 各任务 ETA 平滑状态（新任务 startedAt 变化时重置） */
var etaSmoothByKey = Object.create(null);

/**
 * 根据**已开始耗时**与完成量估算剩余秒数；不足数据时返回 null。
 * 平均速度 = done / elapsed（件/毫秒），剩余毫秒 = remaining / rate，须除以 1000 才是秒
 * （此前误把毫秒当秒）。
 *
 * ⚠️ 调用方必须保证 `done` 与 `startedAt` **同口径**（都是「本次」或都是「累计」）。
 */
function estimateEtaSeconds(startedAt, done, total) {
  if (!startedAt || total <= 0) return null;
  var remaining = total - done;
  if (remaining <= 0) return 0;
  if (done < 1) return null;
  var elapsed = Date.now() - startedAt;
  if (elapsed < 800) return null;
  // 前段波动大：至少完成 3 件，或已运行 5s 再估（二者满足其一）
  if (done < 3 && elapsed < 5000) return null;
  var rate = done / elapsed;
  if (rate <= 0) return null;
  var etaMs = remaining / rate;
  var sec = Math.ceil(etaMs / 1000);
  return Math.max(1, sec);
}

/**
 * 对 ETA 做指数平滑，减少 UI 轮询时的抖动；taskKey 区分目录扫描/缩略图等。
 *
 * ⚠️ 平滑状态是**模块级单例**，`taskKey` 必须**唯一且稳定**：同一个任务换 key = 平滑状态重置，
 *    用户会看到 ETA 突然跳一下（契约 §7）。现有 key 见那边列的五项。
 */
function estimateEtaSecondsSmoothed(taskKey, startedAt, done, total) {
  if (!taskKey) return estimateEtaSeconds(startedAt, done, total);
  if (!startedAt) {
    delete etaSmoothByKey[taskKey];
    return null;
  }
  var raw = estimateEtaSeconds(startedAt, done, total);
  if (raw == null) {
    delete etaSmoothByKey[taskKey];
    return null;
  }
  if (raw === 0) {
    delete etaSmoothByKey[taskKey];
    return 0;
  }
  var st = etaSmoothByKey[taskKey];
  if (!st || st.startedAt !== startedAt) {
    etaSmoothByKey[taskKey] = { startedAt: startedAt, eta: raw };
    return raw;
  }
  var blended = Math.round(0.38 * raw + 0.62 * st.eta);
  if (blended < 1) blended = 1;
  etaSmoothByKey[taskKey].eta = blended;
  return blended;
}

/**
 * 由**已经算好的速率**反推剩余秒数 —— 给「`startedAt` 在 worker 里、实时速率由 worker 自报」
 * 的两个任务用（人脸 / 搜图索引）。
 *
 * 返回 `null` = 「这时候不该显示 ETA」（渲染端 `formatEtaLine` 收到 null 会画空行），
 * 返回 `0` = 「已经做完」（同样画空行）。**两者刻意不同**：`0` 是「剩余的确实为 0」，
 * `null` 是「还没到能估的时候」—— 合成一个值就没法区分「刚起手」和「刚刚好追平」。
 *
 * 🔴 **分子分母必须与 `ratePerMinute` 逐字同口径**（契约 §7 那条 ⚠️）。worker 报的速率是
 *    `(done + failed) / elapsed`（见 `workers/semantic-worker.js` / `workers/face-worker.js`
 *    的 `report()`）⇒ 这里剩下的件数也必须是 `total − (done + failed)`，**不是** `total − done`：
 *    失败的那些已经**过了一遍**（耗掉了时间），把它们算成「还没做」会让 ETA 系统性偏大。
 *    ⚠️ 这与面板主行显示的分子（`done`，即「建成多少张」）**不是同一个量**，是**刻意的**：
 *       主行回答「建成了多少」，ETA 回答「还剩多少件要过一遍」。
 *
 * ⚠️ **刻意不做指数平滑**（所以没有 taskKey 参数）：喂进来的 `ratePerMinute` 本身就是
 *    **自起手以来的累计均值**（worker 每次上报都重算，同一个任务里是单调平滑的），
 *    比瞬时速率稳得多；再平滑一层只会让它对「真的变快了/变慢了」反应更迟钝。
 *
 * ⚠️ `total` 是**抽样估计值**（`totalEstimated: true`）⇒ 这里算出来的 ETA 只是个量级。
 *    界面必须带上「约」（`renderer/scan-flow.js#formatEtaLine` 的 `task.etaPrefix`
 *    本身就是「预计剩余约 …」），别把它当承诺。
 */
function estimateEtaSecondsFromRate(done, failed, total, ratePerMinute) {
  var d = Number(done) || 0;
  var f = Number(failed) || 0;
  var t = Number(total) || 0;
  var r = Number(ratePerMinute) || 0;
  if (!(t > 0) || !(r > 0)) return null;
  var processed = d + f;
  var remaining = t - processed;
  if (remaining <= 0) return 0;
  // 与 `estimateEtaSeconds` 同一条「前段样本太少不估」的规矩：刚跑两三张时
  // `ratePerMinute` 还是从一个很短的时间窗里除出来的，抖动可以差好几倍。
  if (processed < 3) return null;
  var sec = Math.ceil((remaining / r) * 60);
  if (!isFinite(sec) || sec < 0) return null;
  return Math.max(1, sec);
}

module.exports = {
  estimateEtaSeconds: estimateEtaSeconds,
  estimateEtaSecondsSmoothed: estimateEtaSecondsSmoothed,
  estimateEtaSecondsFromRate: estimateEtaSecondsFromRate,
};
