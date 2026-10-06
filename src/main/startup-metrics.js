'use strict';

const fs = require('fs');
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const logger = require('./logger');

function createStartupMetrics() {
  const stages = [];
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let output;
  let timer;
  let stopped = false;
  let writes = Promise.resolve();
  const startedAt = new Date(Date.now() - performance.now()).toISOString();
  function snapshot() {
    return {
      startedAt,
      stages: stages.slice(),
      // 长任务进度单独一段（见 `markLong`）。⚠️ 它**不受 120 s 采集截止影响**，
      // 所以它可能晚于 `stages` 仍在增长 —— 本文件的最后一次写入时间，不代表启动阶段已结束。
      longTasks: longTasks.slice(),
      eventLoop: {
        maxDelayMs: Math.max(0, Math.round(delay.max / 1e6 - 20)),
        p95DelayMs: Math.max(0, Math.round(delay.percentile(95) / 1e6 - 20)),
      },
    };
  }
  function flush() {
    if (!output) return Promise.resolve();
    const payload = JSON.stringify(snapshot(), null, 2) + '\n';
    writes = writes
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(path.dirname(output), { recursive: true });
        await fs.promises.writeFile(output + '.tmp', payload, 'utf8');
        await fs.promises.rename(output + '.tmp', output);
      });
    return writes;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      flush().catch((error) => logger.warn('Startup metrics write failed:', error.message));
    }, 250);
    timer.unref();
  }
  /**
   * stage 条数上限。
   *
   * 🔴 这不是「随手定的防爆值」，它直接决定**故障现场还在不在**：上限一到，
   * 后续所有 `mark()` 被静默丢弃 —— 记录停在半截，看起来像「写到一半断了」，
   * 实际是额度用光。真库上有一条每 5 秒自我重试两次的排程（自动查重等扫描），
   * 旧的 100 条额度在两分钟内就被它吃光，正好把 `renderer.first-grid-paint`、
   * 扫描结束、看门狗超时这些**真正要看的**全挤掉（那条排程的重复打点已同步收敛，
   * 见 `main.js#autoDuplicateHashDeferCount`）。
   *
   * 400 条 × 每条约百字节 ≈ 40 KB，代价可以忽略；宁可多留现场，不要丢。
   */
  const MAX_STAGES = 400;
  function mark(name) {
    if (stopped || stages.length >= MAX_STAGES) return;
    const elapsedMs = Math.round(performance.now());
    stages.push({
      name,
      elapsedMs,
      sincePreviousMs: elapsedMs - (stages.length ? stages[stages.length - 1].elapsedMs : 0),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
    if (output) schedule();
  }
  /**
   * 长任务进度（**不受 120 s 采集窗口限制**）。
   *
   * 🔴 为什么必须与 `stages` 分开（2026-10-06 加）：
   *    `stages` 的采集在启动 120 s 后被 `deadline` 停掉，之后 `mark()` **静默丢弃**。
   *    这对「首帧」这类分析是对的，但对**十几分钟级的长任务**（`deferred-index` 在真库上
   *    建 7 条索引，实测独占写库闸门 6 分钟以上）等于整段落在窗口外 ⇒ 加了打点也**没有现场**，
   *    而且丢得无声无息（不报错、不写日志），正是「明明加了埋点却查不出问题」的形态。
   *    真库实测过：写闸门从 +12.7s 被占，此前 6 分钟里一条打点都没有，只能靠库体积有没有涨
   *    来猜它是在跑还是死了。
   *
   * ⚠️ 只进**独立数组**，不混进 `stages`：混进去会同时污染两件事 —— 首帧阶段耗时统计、
   *    以及 `MAX_STAGES` 的额度（长任务一条一句会把它吃光，反而挤掉真正要看的首帧打点）。
   * ⚠️ 不设 `stopped` 门：这正是它存在的意义。`output` 设上之后仍会调度落盘。
   * ⚠️ 只给**低频**打点用（每条索引一两次、每个阶段一次）；按批任务别用，会撑爆文件。
   */
  const MAX_LONG_TASKS = 200;
  const longTasks = [];
  function markLong(name, detail) {
    if (longTasks.length >= MAX_LONG_TASKS) return;
    longTasks.push({
      name,
      detail: detail != null ? String(detail) : '',
      elapsedMs: Math.round(performance.now()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
    if (output) schedule();
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    delay.disable();
    return flush();
  }
  /**
   * 采集截止。**必须比「首屏真正画出来」更晚**，否则最该看的那几条正好被切掉：
   * 本机 122 万张库实测 `renderer.first-grid-paint` 在 +59.0s，原来的 60s 只差一点就丢；
   * 补了 `renderer.landing.done` 之后，慢库上下两次启动都可能越过 60s。
   * 120s 是余量：timer 已 `unref()`，不会拖住进程退出。
   */
  const deadline = setTimeout(() => {
    stop().catch((error) => logger.warn('Startup metrics write failed:', error.message));
  }, 120000);
  deadline.unref();
  return {
    mark,
    markLong,
    snapshot,
    flush,
    stop,
    setOutput(filename) {
      output = filename;
      schedule();
    },
  };
}

module.exports = { createStartupMetrics };
