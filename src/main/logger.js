/**
 * Minimal structured logger with level control.
 * Default production level = 'warn' (only error/warn).
 * Default dev level = 'log'.
 * Override via LOG_LEVEL env var.
 */

const LEVELS = { error: 0, warn: 1, info: 2, log: 3, debug: 4 };

function resolveLevel() {
  const env = (process.env.LOG_LEVEL || '').toLowerCase();
  if (env && env in LEVELS) return env;
  // In packaged Electron, defaultApp is undefined/false
  return process.defaultApp ? 'log' : 'warn';
}

var _currentLevel = resolveLevel();

function shouldOutput(level) {
  return (LEVELS[level] ?? 3) <= LEVELS[_currentLevel];
}

function log(level, ...args) {
  if (!shouldOutput(level)) return;
  var fn = console[level];
  if (typeof fn === 'function') {
    fn(...args);
  } else {
    console.log(...args);
  }
}

/**
 * Structured task log.
 * Format: [TASK:<name> +<elapsed>ms] <phase> | <detail> | key=value ...
 * @param {string} name - task name, e.g. 'scan', 'thumb-backfill', 'dup-hash'
 * @param {string} phase - stage, e.g. 'start', 'done', 'error'
 * @param {string} [detail] - human readable detail
 * @param {Object} [meta] - extra key-values; startedAt is used to compute elapsed ms
 */
function task(name, phase, detail, meta) {
  if (!shouldOutput('info')) return;
  var elapsed = 0;
  var extras = [];
  if (meta) {
    for (var k in meta) {
      if (!Object.prototype.hasOwnProperty.call(meta, k)) continue;
      if (k === 'startedAt') {
        elapsed = Date.now() - meta[k];
      } else {
        extras.push(k + '=' + String(meta[k]));
      }
    }
  }
  var line = '[TASK:' + name + ' +' + elapsed + 'ms] ' + phase;
  if (detail) line += ' | ' + detail;
  if (extras.length) line += ' | ' + extras.join(' ');
  log('info', line);
}

module.exports = {
  error: function (...args) {
    log('error', ...args);
  },
  warn: function (...args) {
    log('warn', ...args);
  },
  info: function (...args) {
    log('info', ...args);
  },
  log: function (...args) {
    log('log', ...args);
  },
  debug: function (...args) {
    log('debug', ...args);
  },
  setLevel: function (lvl) {
    if (lvl && lvl in LEVELS) _currentLevel = lvl;
  },
  task: task,
};
