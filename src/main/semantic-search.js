'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('./logger');

class SemanticSearch {
  constructor(dbPath, aiPath, config = {}) {
    this.config = config;
    this.dbPath = dbPath;
    this.aiPath = aiPath;
    this.worker = null;
    this.state = { busy: false, ready: false, indexed: 0, phase: 'idle' };
    this.replies = new Map(); // relay 票据 → 等待中的只读请求
    this.ticket = 0;
  }

  status() {
    return { ...this.state };
  }
  /**
   * 重活（下载模型 / 建索引）的准入闸门。`canRun` 返回 `false` 等价于 `AI_BUSY`，
   * 也可以返回一个错误码字符串来说明「到底是谁在占着」——界面据此给出准确提示
   * （比如数据库维护期间说「数据库维护进行中」而不是「AI 任务正在运行」）。
   * 返回 `true` / 未安装闸门都视为放行，此时返回空串。
   */
  gateDenialCode() {
    if (typeof this.canRun !== 'function') return '';
    const gate = this.canRun();
    if (gate === true || gate === undefined) return '';
    return typeof gate === 'string' ? gate : 'AI_BUSY';
  }
  /**
   * 查状态前先跑一遍「准备钩子」（可选，由调用方挂 `beforeRefresh`）。
   *
   * 目前唯一的用途是**播种随包内置模型**：安装包里的 `resources/models` 有现成的人脸与搜图
   * 模型，把它复制进用户目录之后状态才会变成「已就绪」。挂在 refresh 上而不是启动时，
   * 是因为两个运行时的入口都从这里进来 —— 桌面端是 `ai-search-status` / `face-action`，
   * 网页端是 `/api/ai-search-status` / `/api/face-status`，它们共用这两个服务实例，
   * 于是「谁先打开 AI 视图谁触发播种」，且只触发一次（钩子自己 memo）。
   *
   * 钩子失败一律吞掉：播种只是省一次下载，不该让「查状态」这个只读动作失败。
   */
  async refresh() {
    if (typeof this.beforeRefresh === 'function') {
      try {
        await this.beforeRefresh();
      } catch (error) {
        logger.warn('[ai] 状态查询前的准备步骤失败: ' + (error && error.message ? error.message : error));
      }
    }
    if (this.state.phase === 'idle') await this.run('status');
    return this.status();
  }

  run(operation, query, options) {
    if (
      !(this.config.operations || ['status', 'install', 'index', 'search', 'suggest', 'tag']).includes(
        operation,
      )
    )
      return Promise.reject(new Error('AI_BAD_OPERATION'));
    // 只读查询（concurrentReads）可以在主任务占用 worker 时并发执行，这样
    // 「搜图」在索引进行中就能拿已落库的向量出结果、「人物」页也能实时显示已识别结果。
    // 并发分支不写任务状态、不顶替主 worker，其余操作仍然串行。
    const concurrent = (this.config.concurrentReads || []).includes(operation);
    const relayed = (this.config.relayReads || []).includes(operation);
    const primary = !this.worker;
    if (!primary && !concurrent) return Promise.reject(new Error('AI_BUSY'));
    // canRun 只拦重活（下载模型 / 建索引）：两个服务同时跑会各占一套模型、抢着读 photos.db。
    // 它**不拦只读搜索**——「另一个索引在跑就拒绝搜图」的那道闸门（canSearch）已经撤除：
    // 那份担忧的根子是内存，而真正会把进程搞死的是**同一份 SigLIP2 被并发载入两遍**
    // （实测：死前可用内存只剩 5 MB）。那条路已被 relay 彻底堵死——只要有 worker 在跑，
    // primary 就为 false、必然走 relay，不会有第二份 SigLIP2；而单独起 worker 的那条路
    // 现在只载文本编码器（textOnly），实测常驻内存约 900 MB 而不是约 1170 MB（省约 270 MB）。
    // 因此另一个索引在跑时，搜图照常可用。
    if (operation === 'install' || operation === 'index') {
      const denial = this.gateDenialCode();
      if (denial) return Promise.reject(new Error(denial));
    }
    if (
      operation === 'search' &&
      (typeof query !== 'string' || !query.trim() || query.length > 500)
    )
      return Promise.reject(new Error('AI_QUERY_INVALID'));
    const preserveProgress = (this.config.preserveProgress || []).includes(operation);
    const previousPhase = this.state.phase;
    if (primary)
      this.state = {
        ...this.state,
        busy: true,
        phase: operation,
        operation,
        ...(preserveProgress
          ? {}
          : {
              error: '',
              file: '',
              currentFile: '',
              ratePerMinute: 0,
              percent: 0,
              processed: 0,
              failed: 0,
              skipped: 0,
              // 人脸索引的收尾「全局聚类」可能被 `AUTO_REGROUP_LIMIT` **跳过**（大库上必然
              // 发生），此时人物划分只是索引期间的增量近似。这个标志是「跳过」唯一的对外通道，
              // 界面靠它解释「为什么分组不是最终结果」。`null` = 未知（本轮还没跑完/没跑过），
              // 与 `false`（跑了、跳过了）区分开 —— 否则上一轮的 `false` 会在新任务开始后
              // 继续挂在状态里，界面一直显示一句过时的提示。
              clustered: null,
            }),
      };
    // 索引 worker 正在跑：把只读请求托给它自己执行——它已经载好编码器与库连接，另起一个
    // worker 会再载一份 **SigLIP2**，同进程里两份并存会因内存耗尽把进程搞死（实测）。
    // 这条路径绕不过去：只要有 worker 在跑，primary 就为 false，必然落到这里。
    if (!primary && relayed) return this.relay(operation, query, options);
    return this.spawn(operation, query, { primary, preserveProgress, previousPhase }, options);
  }

  /**
   * 主 worker 的消息分发：relay 回话单独走一路，其余仍是进度 / 完成信号。
   * 抽成方法是为了能直接断言「回话如何落到等待中的请求上」，不必起真 worker。
   */
  handleWorkerMessage(message, { primary, worker, onDone }) {
    if (message.relay != null) {
      const pending = this.replies.get(message.relay);
      if (!pending) return; // 超时后迟到的回话：丢掉即可
      this.replies.delete(message.relay);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.progress && primary) Object.assign(this.state, message.progress);
    if (message.done) {
      onDone(message);
      void worker.terminate();
    }
  }

  /**
   * 把只读请求投递给正在跑主任务的 worker，等它用 { relay: ticket } 回话。
   */
  relay(operation, query, options) {
    const worker = this.worker;
    // 只有建索引时 worker 手里才有「编码器 + 库连接」可以复用；下载模型阶段没有索引可查。
    if (!worker || this.state.operation !== 'index') return Promise.reject(new Error('AI_BUSY'));
    const ticket = ++this.ticket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(ticket);
        reject(new Error('AI_TIMEOUT'));
      }, 120000);
      timer.unref();
      this.replies.set(ticket, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({
        operation,
        relay: ticket,
        query: typeof query === 'string' ? query.trim() : '',
        options: options || null,
      });
    });
  }
  spawn(operation, query, { primary, preserveProgress, previousPhase }, options) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(
          path.join(__dirname, '../workers', this.config.workerFile || 'semantic-worker.js'),
          {
            workerData: { dbPath: this.dbPath, aiPath: this.aiPath },
          },
        );
      } catch (error) {
        if (primary) {
          this.state.busy = false;
          this.state.phase = 'failed';
          this.state.error = error.message;
        }
        reject(error);
        return;
      }
      if (primary) this.worker = worker;
      let outcome;
      // Large local libraries can take days. Indexing has explicit cancellation,
      // so a fixed wall-clock deadline would abort healthy long-running work.
      const timeout =
        operation === 'index'
          ? null
          : setTimeout(
              () => {
                outcome = { error: 'AI_TIMEOUT' };
                void worker.terminate();
              },
              operation === 'install' ? 30 * 60 * 1000 : 120000,
            );
      if (timeout) timeout.unref();
      worker.on('message', (message) =>
        this.handleWorkerMessage(message, {
          primary,
          worker,
          onDone: (done) => {
            outcome = done;
          },
        }),
      );
      worker.on('error', (error) => {
        outcome = { error: error.message };
      });
      worker.on('exit', () => {
        clearTimeout(timeout);
        // worker 走了：还在等回话的 relay 请求必须立刻失败，否则调用方会一直挂到超时。
        // 用 AI_BUSY 而不是 AI_WORKER_EXIT：这几乎总是「索引刚好跑完」，重搜一次即可，
        // 界面据此给出一句能读懂的提示，而不是一个裸错误码。
        for (const pending of this.replies.values()) pending.reject(new Error('AI_BUSY'));
        this.replies.clear();
        const error = outcome && outcome.error;
        if (!primary) {
          // 并发只读：只回结果，绝不触碰 this.state / this.worker。
          if (!outcome || error) reject(new Error(error || 'AI_WORKER_EXIT'));
          else resolve(outcome.result);
          return;
        }
        this.worker = null;
        this.state.busy = false;
        if (!outcome || error) {
          this.state.phase = error === 'AI_CANCELLED' ? 'cancelled' : 'failed';
          this.state.error = error || 'AI_WORKER_EXIT';
          if (error !== 'AI_CANCELLED')
            logger.warn((this.config.label || 'Semantic search') + ' failed:', this.state.error);
          reject(new Error(this.state.error));
        } else {
          const result = outcome.result;
          // ⚠️ 这份白名单决定了 worker 的返回值里**哪些字段能进入 `status()`**。漏一个
          //    就等于「后端做了、界面永远看不到」——`clustered` 曾经就是这样被丢掉的：
          //    `face-worker` 在超过 `AUTO_REGROUP_LIMIT` 时明确返回 `clustered:false`，
          //    但白名单里没有它，于是「本次索引没做全局聚类」这件事对界面完全不可见。
          //    新增可上报字段时，**先确认它在这里**。
          for (const key of [
            'ready',
            'indexed',
            'processed',
            'failed',
            'skipped',
            'faces',
            'people',
            'clustered',
          ])
            if (result[key] !== undefined) this.state[key] = result[key];
          this.state.phase = preserveProgress ? previousPhase : 'complete';
          resolve(result);
        }
      });
      worker.postMessage({
        operation,
        query: this.config.objectPayload
          ? query || {}
          : typeof query === 'string'
            ? query.trim()
            : '',
        options: options || null,
      });
    });
  }

  start(operation) {
    if (!['install', 'index'].includes(operation)) throw new Error('AI_BAD_OPERATION');
    if (this.worker) throw new Error('AI_BUSY');
    const denial = this.gateDenialCode();
    if (denial) throw new Error(denial);
    void this.run(operation).catch(() => {}); // Failure is exposed in status and logged by run.
    return this.status();
  }

  cancel() {
    if (this.worker) {
      this.state.phase = 'stopping';
      this.worker.postMessage({ cancel: true });
    }
    return this.status();
  }
  dispose() {
    if (this.worker) {
      this.worker.postMessage({ cancel: true });
      void this.worker.terminate();
    }
  }
}
module.exports = { SemanticSearch };
