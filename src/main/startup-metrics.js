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
  function mark(name) {
    if (stopped || stages.length >= 100) return;
    const elapsedMs = Math.round(performance.now());
    stages.push({
      name,
      elapsedMs,
      sincePreviousMs: elapsedMs - (stages.length ? stages[stages.length - 1].elapsedMs : 0),
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
  const deadline = setTimeout(() => {
    stop().catch((error) => logger.warn('Startup metrics write failed:', error.message));
  }, 60000);
  deadline.unref();
  return {
    mark,
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
