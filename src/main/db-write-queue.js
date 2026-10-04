'use strict';

/**
 * 启动期「写库任务」的串行闸门。
 *
 * photos.db 上同一时刻只允许一个重活持写锁。启动阶段有三个任务各自起一个 worker：
 * 缩略图标记修复（+5s）、FTS 索引维护（+6s）、延迟索引（+8s）。它们过去是各自 setTimeout
 * 直接点火、谁都不认识谁，于是后到的维护 worker 带着 `busy_timeout = 8000` 等满 8 秒
 * 仍然抢不到写锁，直接抛 `database is locked`（同一时刻 db-read-worker 队列也被拖到 120 秒超时，
 * 首屏迟迟画不出来）。这不是「把 timeout 调大」能解决的——占锁方要跑几十秒。
 *
 * 这里用一条 Promise 链把它们排成一队：同一时刻至多一个在跑，后来的排队而不是抢锁。
 * 队列状态同时暴露给 maintenanceBusy()，所以界面触发的维护也会知道该等，并报出在等谁。
 *
 * 刻意不做取消 / 清空：启动期这几个任务都必须跑完，取消了下次启动还得再来一遍。
 * 也刻意不做并发度参数：真需要并发读请走 db-read-worker-pool 的只读通道，
 * 那条通道不写库、不会顶掉这里的锁。
 *
 * @param {{onStart?: (name: string) => void, onSettle?: (name: string, error: Error|null) => void}} [hooks]
 */
function createDbWriteQueue(hooks) {
  const onStart = (hooks && hooks.onStart) || function () {};
  const onSettle = (hooks && hooks.onSettle) || function () {};
  let tail = Promise.resolve();
  let active = '';
  const waiting = [];

  function isBusy() {
    return active !== '' || waiting.length > 0;
  }

  /** 正在跑的任务名；没有在跑就返回队首（即将开始）的名字，便于报出「在等谁」。 */
  function busyName() {
    return active || (waiting.length ? waiting[0].name : '');
  }

  /**
   * 排队执行。返回的 Promise 在**本任务**结束时 settle（失败会 reject 原错误），
   * 但队尾永远吃掉失败——前一个任务炸了不能把后面的卡在队里。
   *
   * @param {string} name 任务名，会出现在日志与忙碌原因里
   * @param {() => any} task
   */
  function run(name, task) {
    const ticket = { name };
    waiting.push(ticket);
    const started = tail.then(() => {
      const index = waiting.indexOf(ticket);
      if (index >= 0) waiting.splice(index, 1);
      active = name;
      onStart(name);
      return task();
    });
    tail = started.then(
      () => settle(name, null),
      (error) => settle(name, error),
    );
    return started;
  }

  function settle(name, error) {
    if (active === name) active = '';
    onSettle(name, error);
  }

  return { run, isBusy, busyName };
}

module.exports = { createDbWriteQueue };
