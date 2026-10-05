'use strict';

/**
 * 「现在能不能启动 AI 索引 / 下载模型」这一个判断。
 *
 * 为什么值得单独一个模块：判据里的两类「不能跑」在物理上是**完全不同的两件事**，
 * 混在一起写过一次，就出过一次误报。
 *
 * 1. `exclusiveMaintenance`：**独占整库**的维护（VACUUM / 重建缩略图标记）。它们要重写整库，
 *    此时 AI 索引 worker 只要写一个批次事务就会撞 `database is locked` —— 必须拒绝。
 * 2. `peerBusy`：**另一套** AI 索引在跑（人脸 ↔ 搜图）。两套模型同时驻留会抢内存，
 *    历史上还出现过同一份 SigLIP2 被并发载入两遍直接把内存打满。
 *
 * ⚠️ **启动期的 FTS 索引（`ensureFtsIndex`）不属于上面任何一类**。它和 AI 索引一样排在
 * 同一条写库队列（`dbWriteQueue`）里，谁先谁后由队列定，互相之间不需要拒绝。
 * 但历史上它和 VACUUM 共用同一个 `optimizeTaskRunning` 开关，于是开机那十几秒里
 * 用户点「建 AI 索引」会拿到 `AI_MAINTENANCE`（"数据库维护进行中"），而实际上
 * 那时候点下去完全跑得起来 —— 用户只会以为功能坏了。
 *
 * 判据剥出来还有个工程上的理由：main.js 一 require 就要 electron 的 app / ipcMain，
 * 普通 node 进程里根本进不去，内联表达式的分支**没法被行为断言覆盖**，只能读源码文本。
 * 这里返回的三种取值也一并定死，避免"到底该返回 false 还是错误码"再漂一次。
 *
 * @param {{exclusiveMaintenance?: boolean, peerBusy?: boolean}} state
 * @returns {true | 'AI_MAINTENANCE' | false}
 *   `true` = 可以跑；`'AI_MAINTENANCE'` = 独占维护占着库（带错误码，界面才能说清是谁）；
 *   `false` = 另一套 AI 索引正在跑。取不到参数时**放行**（不误拦）。
 */
function aiIndexCanRun(state) {
  const s = state || {};
  // 独占维护优先报出来：它是"库里正有事"，比"另一套索引在跑"更值得用户等。
  if (s.exclusiveMaintenance) return 'AI_MAINTENANCE';
  return !s.peerBusy;
}

module.exports = { aiIndexCanRun };
