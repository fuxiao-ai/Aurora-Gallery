'use strict';

/**
 * 写库任务闸门（带优先级的串行队列）。
 *
 * photos.db 上同一时刻只允许一个重活持写锁。启动阶段有三个任务各自起一个 worker：
 * 缩略图标记修复（+5s）、FTS 索引维护（+6s）、延迟索引（+8s）。它们过去是各自 setTimeout
 * 直接点火、谁都不认识谁，于是后到的维护 worker 带着 `busy_timeout = 8000` 等满 8 秒
 * 仍然抢不到写锁，直接抛 `database is locked`（同一时刻 db-read-worker 队列也被拖到 120 秒超时，
 * 首屏迟迟画不出来）。这不是「把 timeout 调大」能解决的——占锁方要跑几十秒。
 *
 * 这里把它们排成一队：同一时刻至多一个在跑，后来的排队而不是抢锁。
 * 队列状态同时暴露给 maintenanceBusy()，所以界面触发的维护也会知道该等，并报出在等谁。
 *
 * ## 🔴 长任务必须按批次反复入队，不能一次 run 到底
 *
 * 缩略图回填与重复哈希都是跑几十万行的长任务。它们过去只在开头做一次
 * `optimizeTaskRunning || isBusy()` 的**快照**检查就长期持锁，而上面那几个启动期任务
 * 是无条件 `run()` 进队的、**看不见** `thumbnailBackfill.running` → 存在真实的同时持锁窗口。
 * 正确写法是把「处理一批」包成一次 `run()`（`main.js` 的 `thumbnail-backfill` / `dup-hash`）：
 * 每批之间队列是空的，别的任务能插进来，天然互斥、天然让位，
 * 不需要抢占也不需要改各自的循环结构。
 * 代价是批次粒度上的等待（回填一批约几秒），以及**队列忙碌不等于「整个任务没在跑」**。
 *
 * ## 优先级：为什么这样就够，不需要「租约 + 让位」
 *
 * 本队列按 `(priority, seq)` 排序 —— 高优先排前面，**同档保持 FIFO**。
 * 配合上面「每批重新入队」，就自动得到「批次边界让位」的效果，而且是免费的：
 *
 *   回填（INDEX）跑完一批 → 重新入队时发现自己排在 USER 任务后面 → 等 USER 跑完再继续。
 *
 * 所以设计文档里设想的 `lease()` / `step()` 两个新 API、以及「让位时把自己插回同档队首
 * 防活锁」都不需要：① 每批都是一次全新入队，不存在「持着租约却占着位置」的状态；
 * ② 活锁只可能来自「反复让位却永远轮不到自己」，而这里的让位对象是**有序队列**，
 * 高优先任务跑完就没了，回填必然被轮到（除非用户持续提交高优先任务 —— 那本来就该优先）。
 *
 * ⚠️ 优先级**不抢占正在执行的批次**。这是刻意的：中断半途的回填批次会留下需重新处理的
 * 中间态，收益却只是省几秒。让位只发生在批次边界。
 *
 * ## 刻意不做的两件事
 *
 * - **不做取消 / 清空**：启动期这几个任务都必须跑完，取消了下次启动还得再来一遍。
 * - **不做并发度参数**：真需要并发读请走 db-read-worker-pool 的只读通道，
 *   那条通道不写库、不会顶掉这里的锁。
 *
 * ⚠️ hooks 按任务名触发，**高频批次任务会每批触发一次** → 调用方（`main.js`）用
 * `DB_WRITE_QUIET_TASKS` 把它们从埋点里剔掉，否则会刷爆启动阶段日志。
 */

/**
 * 四档优先级。**数字小的先跑**，同档 FIFO。
 *
 * - `USER`   用户手动点的：扫描、手动维护、手动建索引 —— 人在等，最该快
 * - `REPAIR` 修**数据正确性**：缩略图标记修复、索引补齐、失效记录清理、开机自动扫描 —— 做晚了结果就是错的
 * - `INDEX`  建**性能索引**：FTS、缩略图回填、重复哈希 —— 晚做只是慢
 * - `IDLE`   纯空闲才做：cache gc、清理批次尾部
 *
 * 🔴 **新增任务必须显式传 `priority`**，别依赖默认档（默认只是为了让外部调用不崩）。
 * `scripts/db-write-priority-regression.js` 会机械比对每个调用点都标了档位。
 */
var PRIORITY = { USER: 0, REPAIR: 1, INDEX: 2, IDLE: 3 };

/** 不传 priority 时落到的档位：既不插队也不被插队，等价于「没有优先级概念」 */
var DEFAULT_PRIORITY = PRIORITY.INDEX;

function normalizePriority(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PRIORITY;
  // 夹到最接近的合法档，避免传 0.5 这种值把排序搞乱
  if (value <= PRIORITY.USER) return PRIORITY.USER;
  if (value >= PRIORITY.IDLE) return PRIORITY.IDLE;
  return Math.round(value);
}

/**
 * @param {{onStart?: (name: string) => void, onSettle?: (name: string, error: Error|null) => void}} [hooks]
 */
function createDbWriteQueue(hooks) {
  const onStart = (hooks && hooks.onStart) || function () {};
  const onSettle = (hooks && hooks.onSettle) || function () {};
  /** 待执行票据，始终按 (priority, seq) 有序：队首就是下一个要跑的 */
  const waiting = [];
  let active = '';
  let activePriority = null;
  let activeStartedAt = 0;
  let seq = 0;
  let pumping = false;

  function isBusy() {
    return active !== '' || waiting.length > 0;
  }

  /** 正在跑的任务名；没有在跑就返回队首（即将开始）的名字，便于报出「在等谁」。 */
  function busyName() {
    return active || (waiting.length ? waiting[0].name : '');
  }

  /** 下一个要跑的档位（队列空则 null）。给界面判断「在等谁 / 为什么慢」。 */
  function nextPriority() {
    return waiting.length ? waiting[0].priority : null;
  }

  function snapshot() {
    const at = Date.now();
    return {
      active: active
        ? { name: active, priority: activePriority, runningMs: at - activeStartedAt }
        : null,
      waiting: waiting.map(function (t) {
        return { name: t.name, priority: t.priority, waitMs: at - t.enqueuedAt };
      }),
    };
  }

  /**
   * 排队执行。返回的 Promise 在**本任务**结束时 settle（失败会 reject 原错误），
   * 每个票据独立结算 —— 前一个任务炸了不能把后面的卡在队里。
   *
   * @param {string} name 任务名，会出现在日志与忙碌原因里
   * @param {() => any} task
   * @param {{priority?: number}} [options]
   */
  function run(name, task, options) {
    const priority = normalizePriority(options && options.priority);
    const ticket = {
      name: name,
      priority: priority,
      seq: seq++,
      enqueuedAt: Date.now(),
      task: task,
    };
    const result = new Promise(function (resolve, reject) {
      ticket.resolve = resolve;
      ticket.reject = reject;
    });
    insert(ticket);
    pump();
    return result;
  }

  /**
   * 有序插入。同档必须保持 FIFO（`seq` 升序）—— 这是队列公平性的全部来源，
   * 少了 `seq` 比较项，同档任务会变成「谁后入队谁先跑」。
   */
  function insert(ticket) {
    let lo = 0;
    let hi = waiting.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = waiting[mid];
      if (other.priority < ticket.priority || (other.priority === ticket.priority && other.seq < ticket.seq)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    waiting.splice(lo, 0, ticket);
  }

  /**
   * 单飞推进器：同一时刻只有一个 pump 在跑，所以「串行」由 `pumping` 这一个布尔保证，
   * 不需要 Promise 链。票据在入队时就排好序，pump 只负责按序取出执行。
   */
  function pump() {
    if (pumping) return;
    pumping = true;
    void (async function drain() {
      try {
        while (waiting.length) {
          const ticket = waiting.shift();
          active = ticket.name;
          activePriority = ticket.priority;
          activeStartedAt = Date.now();
          onStart(ticket.name);
          let error = null;
          let value;
          try {
            value = await ticket.task();
          } catch (e) {
            error = e;
          }
          // 先复位状态、再结算调用方：`await run()` 醒来时 isBusy() 必须已经反映真实队列
          active = '';
          activePriority = null;
          activeStartedAt = 0;
          onSettle(ticket.name, error);
          // 🔴 必须把任务返回值透传出去：`await dbWriteQueue.run(...)` 的调用方拿它做判断
          // （`maintenance-guard-regression` 里 `assert.equal(await after, 'ok')` 就是这条）。
          if (error) ticket.reject(error);
          else ticket.resolve(value);
        }
      } finally {
        pumping = false;
      }
    })();
  }

  return {
    run: run,
    isBusy: isBusy,
    busyName: busyName,
    nextPriority: nextPriority,
    snapshot: snapshot,
  };
}

module.exports = { createDbWriteQueue: createDbWriteQueue, PRIORITY: PRIORITY, DEFAULT_PRIORITY: DEFAULT_PRIORITY };
