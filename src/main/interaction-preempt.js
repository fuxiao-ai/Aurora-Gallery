'use strict';

/**
 * 用户交互抢占信号：**搜图查询进行中时，后台长任务在批次边界停下让位**。
 *
 * ## 为什么不是一个布尔标志
 *
 * 布尔标志一旦泄漏，后台任务会**永久停摆**，而且这种故障**没有任何报错** —— 用户只会觉得
 * 「图库莫名其妙不干活了」，排查时看不到任何线索。所以这里布三条防线：
 *
 * 1. **计数而非布尔** —— 用户连续敲回车会有多个查询重叠，布尔会被先结束的那个清掉，
 *    后来的查询就失去了保护。
 * 2. **`withPreempt()` 用 `try/finally` 等价物收尾** —— 查询抛异常、超时、worker 崩掉
 *    都会释放，不依赖调用方记得手动收尾。
 * 3. **自动过期尾巴** —— `active()` 在最后一次活动后 `tailMs` 内仍算活跃。尾巴本身是必需的
 *    （查询返回后界面还要渲染，用户通常紧接着搜下一个词）；它同时把「计数万一漏归零」的
 *    后果限制在 `tailMs` 之内，而不是永久。
 *
 * 另外 `awaitIdle()` 有 `maxHoldMs` 上限：用户狂搜时后台任务不能被无限期饿死，等满就放行。
 * 最坏退化成「干一会儿、等一会儿」的交替推进，而不是彻底停摆。
 *
 * ## 为什么只能在「批次边界」让位
 *
 * 没有任何后台任务能在任意时刻被打断：回填正解码一张图、扫描 worker 正写一批库，
 * 强行中断都会留下半成品。所以「立刻停下」的可行语义是**做完当前批次就停** ——
 * 回填一批 100 张、哈希一个子批 24 张，量级是秒，对搜图已经够用。
 *
 * ## 与 `previewPlaybackActive` 的区别（不要合并）
 *
 * - `previewPlaybackActive`：**降载**。视频预览播放期间把回填 / 哈希的并发降到 1，任务照跑。
 *   预览是长时段、低强度的背景活动，完全停下会让用户看幻灯片时后台整个停摆。
 * - `interactionPreempt`（本模块）：**抢占**。搜图查询是短时段、用户正等着结果的动作，
 *   值得让后台任务停手几秒。
 *
 * 两者强度与时长特征都不同，合并会同时弄坏两边的语义。
 *
 * ## 为什么独立成模块，而不是塞进 main.js
 *
 * 一是两个运行时（桌面 IPC 与内嵌网页 API）跑在同一进程里，天然共享这一份单例，不需要
 * 接线传参；二是规则能被回归脚本直接 `require` 断言，不必起 Electron —— 项目里
 * 「规则藏在 main.js 就只能靠源码正则守护」的教训已经吃过一次。
 */

/**
 * @param {{tailMs?: number, maxHoldMs?: number, pollMs?: number,
 *          now?: () => number, sleep?: (ms: number) => Promise<void>}} [options]
 *   `now` / `sleep` 可注入是为了让回归能瞬间推进时间，不必真等 30 秒。
 */
function createInteractionPreempt(options) {
  var opts = options || {};
  var tailMs = Number.isFinite(opts.tailMs) ? Math.max(0, opts.tailMs) : 1500;
  var maxHoldMs = Number.isFinite(opts.maxHoldMs) ? Math.max(0, opts.maxHoldMs) : 30000;
  var pollMs = Number.isFinite(opts.pollMs) ? Math.max(1, opts.pollMs) : 120;
  var now = typeof opts.now === 'function' ? opts.now : Date.now;
  var sleep =
    typeof opts.sleep === 'function'
      ? opts.sleep
      : function (ms) {
          return new Promise(function (resolve) {
            setTimeout(resolve, ms);
          });
        };

  var inFlight = 0;
  // 0 表示「从未有过交互」：`now() - 0` 是个极大的数，`active()` 自然为 false。
  var lastAt = 0;
  /** 后台任务真的停下让位的次数与累计时长，给「为什么后台变慢了」提供线索 */
  var holds = 0;
  var heldMs = 0;

  function begin() {
    inFlight += 1;
    lastAt = now();
  }

  function end() {
    // 钳到 0：宁可多算一次「已结束」，也不要因为多减一次而让计数变负、
    // 之后所有的 begin 都补不回正数（那才是真正的永久停摆）。
    inFlight = Math.max(0, inFlight - 1);
    lastAt = now();
  }

  function active() {
    if (inFlight > 0) return true;
    return now() - lastAt < tailMs;
  }

  /**
   * 批次边界的让位点。**必须在进入写库队列之前调用** —— 进队之后才等，等于占着闸门干等，
   * 会把别的任务一起堵住。
   *
   * @returns {Promise<boolean>} `true` = 等到了空闲；`false` = 等满 `maxHoldMs` 放行
   */
  async function awaitIdle() {
    if (!active()) return true;
    var startedAt = now();
    while (active()) {
      if (now() - startedAt >= maxHoldMs) {
        holds += 1;
        heldMs += now() - startedAt;
        return false;
      }
      await sleep(pollMs);
    }
    holds += 1;
    heldMs += now() - startedAt;
    return true;
  }

  /**
   * 把一次用户交互（当前只有搜图查询）标记为活跃，结束后释放。
   * 同步抛错与 Promise 失败都会走到释放，调用方不需要自己收尾。
   */
  function withPreempt(fn) {
    begin();
    var settled;
    try {
      settled = Promise.resolve(fn());
    } catch (error) {
      end();
      return Promise.reject(error);
    }
    return settled.then(
      function (value) {
        end();
        return value;
      },
      function (error) {
        end();
        throw error;
      },
    );
  }

  function status() {
    return { active: active(), inFlight: inFlight, holds: holds, heldMs: heldMs };
  }

  function reset() {
    inFlight = 0;
    lastAt = 0;
    holds = 0;
    heldMs = 0;
  }

  return {
    begin: begin,
    end: end,
    active: active,
    awaitIdle: awaitIdle,
    withPreempt: withPreempt,
    status: status,
    reset: reset,
  };
}

/** 主进程与内嵌网页共用这一份（同进程，Node 模块缓存保证单例） */
var interactionPreempt = createInteractionPreempt();

module.exports = { createInteractionPreempt: createInteractionPreempt, interactionPreempt: interactionPreempt };
