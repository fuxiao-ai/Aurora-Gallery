/**
 * Renderer-side minimal logger with level control.
 * Default production level = 'warn' (only error/warn).
 * Default dev level = 'log'.
 * Override via localStorage: localStorage.setItem('photoManager.logLevel', 'debug')
 */
(function (global) {
  var LEVELS = { error: 0, warn: 1, info: 2, log: 3, debug: 4 };

  function resolveLevel() {
    try {
      var env = (localStorage.getItem('photoManager.logLevel') || '').toLowerCase();
      if (env && env in LEVELS) return env;
    } catch (_e) {}
    var isDev =
      (typeof process !== 'undefined' && process.argv && process.argv.indexOf('--dev') >= 0) ||
      (typeof window !== 'undefined' && String(window.location.search || '').indexOf('--dev') >= 0);
    return isDev ? 'log' : 'warn';
  }

  var _currentLevel = resolveLevel();

  function shouldOutput(level) {
    return (LEVELS[level] ?? 3) <= LEVELS[_currentLevel];
  }

  function makeFn(level) {
    return function () {
      if (!shouldOutput(level)) return;
      var fn = console[level];
      if (typeof fn === 'function') {
        fn.apply(console, arguments);
      } else {
        console.log.apply(console, arguments);
      }
    };
  }

  global.Logger = {
    error: makeFn('error'),
    warn: makeFn('warn'),
    info: makeFn('info'),
    log: makeFn('log'),
    debug: makeFn('debug'),
    setLevel: function (lvl) {
      if (lvl && lvl in LEVELS) _currentLevel = lvl;
    },
  };
})(window);
