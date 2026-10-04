'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const POOL_SIZE = 3;
const MAX_QUEUE = 100;
const JOB_TIMEOUT_MS = 120000;
let workers = [];
let dbPathCached = '';
let nextId = 1;
const jobQueue = [];

function settle(job, error, result) {
  clearTimeout(job.timer);
  if (job.signal) job.signal.removeEventListener('abort', job.abort);
  if (error) job.reject(error);
  else job.resolve(result);
}

function retire(slot, error) {
  if (!slot.worker) return;
  const worker = slot.worker;
  slot.worker = null;
  slot.retiring = true;
  if (slot.job) {
    settle(slot.job, error);
    slot.job = null;
  }
  // Keep the error listener installed while termination is in flight.
  worker
    .terminate()
    .catch(() => {})
    .finally(() => {
      slot.retiring = false;
      dispatch();
    });
}

function createSlot(slot) {
  const worker = new Worker(path.join(__dirname, 'workers', 'db-read-worker.js'), {
    workerData: { dbPath: dbPathCached },
  });
  slot.worker = worker;
  worker.on('message', (message) => {
    if (slot.worker !== worker || !slot.job || message.id !== slot.job.id) return;
    const job = slot.job;
    slot.job = null;
    settle(
      job,
      message.ok ? null : new Error(message.error || 'db-read-worker error'),
      message.result,
    );
    dispatch();
  });
  function fail(error) {
    if (slot.worker !== worker) return;
    retire(slot, error);
    // Recreate lazily for the next queued request; no idle crash/restart loop.
    dispatch();
  }
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error('db-read-worker exited: ' + code)));
}

function dispatch() {
  for (const slot of workers) {
    if (!jobQueue.length) break;
    if (slot.job || slot.retiring) continue;
    const job = jobQueue.shift();
    try {
      if (!slot.worker) createSlot(slot);
      slot.job = job;
      slot.worker.postMessage({ id: job.id, op: job.op, options: job.options });
    } catch (error) {
      if (slot.job) retire(slot, error);
      else settle(job, error);
    }
  }
  // Constructor/clone errors must not strand the remaining queue.
  if (jobQueue.length && workers.some((slot) => !slot.job && !slot.retiring))
    setImmediate(dispatch);
}

function terminate() {
  const old = workers;
  workers = [];
  dbPathCached = '';
  const error = new Error('db worker terminated');
  while (jobQueue.length) settle(jobQueue.shift(), error);
  for (const slot of old) retire(slot, error);
}

function run(dbPath, op, options, control = {}) {
  return new Promise((resolve, reject) => {
    if (control.signal && control.signal.aborted) {
      reject(new Error('db-read cancelled'));
      return;
    }
    if (!dbPath || typeof dbPath !== 'string') {
      reject(new Error('db-read-worker-pool: invalid dbPath'));
      return;
    }
    if (dbPathCached !== dbPath) {
      terminate();
      dbPathCached = dbPath;
      workers = Array.from({ length: POOL_SIZE }, () => ({ worker: null, job: null }));
    }
    if (jobQueue.length >= MAX_QUEUE) {
      reject(new Error('db-read-worker queue full'));
      return;
    }
    const job = { id: nextId++, op, options: options || {}, resolve, reject, timer: null };
    function cancel(error) {
      const index = jobQueue.indexOf(job);
      if (index >= 0) {
        jobQueue.splice(index, 1);
        settle(job, error);
      } else {
        const slot = workers.find((item) => item.job === job);
        if (slot) retire(slot, error);
      }
      dispatch();
    }
    job.signal = control.signal;
    job.abort = () => cancel(new Error('db-read cancelled'));
    // Deadline includes queue time so every accepted request eventually settles.
    // 带上 op 名：同时挤在队列里时，光看「timeout」分不出是哪个查询被拖死的。
    job.timer = setTimeout(() => {
      cancel(new Error('db-read-worker timeout: ' + job.op));
    }, JOB_TIMEOUT_MS);
    jobQueue.push(job);
    if (job.signal) job.signal.addEventListener('abort', job.abort, { once: true });
    dispatch();
  });
}

module.exports = { run, terminate };
