(function (global) {
  /**
   * 导航历史（后退 / 前进）—— 只管「栈 + 按钮态 + 快捷键」，不回答「位置是什么」。
   *
   * 为什么位置语义在外侧：这个 app 的「位置」不是 URL，而是 state 里的一组字段
   * （currentView / currentPath / currentDate / currentTab）。那套口径只有 app.js 知道，
   * 塞进这里就成了第二份真相源。所以模块只要求两个回调：
   *   - `deps.captureLocation()` → `{view, path, date, tab}` 或 null（不记）
   *   - `deps.applyLocation(loc)` → 走 app 自己的导航入口
   * 于是栈操作（push / 截断前进分支 / 越界判定 / 按键意图 / 侧键意图）全是纯函数，
   * 能在沙箱里逐条断言，不用起 Electron。
   *
   * 两条容易踩的线：
   *   1. **applyLocation 期间必须抑制记录**（`paused`）—— 否则点一次「后退」会先把
   *      目标位置记成新的一步，栈原地长出来，越点越乱。
   *   2. **鼠标侧键在一次点击里可能连发 mousedown / mouseup / auxclick** ——
   *      mousedown 只 `preventDefault`（Chromium 默认把侧键当历史导航），
   *      真正触发统一放 mouseup/auxclick，并按方向做时间窗去抖。
   */
  'use strict';

  /** 栈上限：再多也没人会去翻，每条还持有路径字符串 */
  var HISTORY_LIMIT = 60;

  /** 同一个方向在该窗口内的重复事件视为同一次点击 */
  var SIDE_BUTTON_DEBOUNCE_MS = 250;

  var tZh = {
    'path.back': '后退',
    'path.forward': '前进',
    'path.backFmt': '后退：{name}',
    'path.forwardFmt': '前进：{name}',
  };

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  /**
   * 位置对象的比较键。四个字段**全参与**：同一个目录挂在两个 tab 下不是同一个位置，
   * 「所有照片」与「所有日期」也不能撞键（两者 view 都是 all，靠 date/tab 区分）。
   */
  function keyOf(loc) {
    if (!loc) return '';
    return [loc.view || '', loc.path || '', loc.date || '', loc.tab || ''].join('\u0001');
  }

  /**
   * 往栈里记一个位置。返回新栈，不就地改（便于单测）。
   *
   * - 与栈顶同键 → 只刷新栈顶对象，`changed:false`（同位置连点不该长栈）
   * - 当前不在栈尾（后退过）→ **截断前进分支**再 push（浏览器的标准行为）
   * - 超上限 → 从栈头丢最旧的
   *
   * @returns {{entries:Array, index:number, changed:boolean}}
   */
  function pushEntry(entries, index, loc, limit) {
    var list = Array.isArray(entries) ? entries.slice() : [];
    var max = limit > 0 ? limit : HISTORY_LIMIT;
    if (!loc) return { entries: list, index: index, changed: false };
    if (index >= 0 && index < list.length && keyOf(list[index]) === keyOf(loc)) {
      list[index] = loc;
      return { entries: list, index: index, changed: false };
    }
    list.length = index + 1;
    list.push(loc);
    var next = list.length - 1;
    if (list.length > max) {
      list.splice(0, list.length - max);
      next = list.length - 1;
    }
    return { entries: list, index: next, changed: true };
  }

  function canGoBack(index) {
    return index > 0;
  }

  function canGoForward(entries, index) {
    return index >= 0 && index < (entries ? entries.length : 0) - 1;
  }

  /**
   * 键盘意图。`Alt+←/→` 两端都收（浏览器 / 编辑器 / 大多数 Electron 相册的通行手感），
   * macOS 另收 `Cmd+[` / `Cmd+]`（那边 Alt 更多用于文本编辑习惯）。
   * 刻意**不看焦点**：Chrome 在输入框里同样按 Alt+← 导航，保持一致比聪明更好用。
   *
   * @returns {'back'|'forward'|''}
   */
  function keyIntent(e) {
    if (!e || e.defaultPrevented) return '';
    // 键位改由快捷键注册表判定（`src/renderer/shortcuts.js`）；
    // 默认值与原实现逐位一致：`Alt+←/→` 两端都收，macOS 另收 `Cmd+[` / `Cmd+]`。
    // ⚠️ 无修饰键的 `←`/`→` 必须继续「落不到这里」（注册表里 nav.back/forward
    // 只绑了带修饰键的手势），否则会把预览翻页的裸方向键吞掉。
    var sr = global.RendererShortcuts;
    if (sr && typeof sr.matches === 'function') {
      if (sr.matches('nav.back', e)) return 'back';
      if (sr.matches('nav.forward', e)) return 'forward';
      return '';
    }
    return '';
  }

  /** 鼠标侧键：X1 = 后退（button 3）、X2 = 前进（button 4）。主键/中键/右键一律 '' */
  function sideIntent(e) {
    if (!e) return '';
    if (e.button === 3) return 'back';
    if (e.button === 4) return 'forward';
    return '';
  }

  /**
   * 挂载导航历史。options：
   *   back / forward — 两个按钮（可缺）
   *   deps           — captureLocation / applyLocation / describeLocation / t / tFmt / canNavigate
   *
   * @returns {{record:Function, reset:Function, back:Function, forward:Function,
   *            canBack:Function, canForward:Function, size:Function, index:Function,
   *            sync:Function, bind:Function}}
   */
  function mount(options) {
    options = options || {};
    var backEl = options.back || null;
    var forwardEl = options.forward || null;
    var deps = options.deps || {};

    var entries = [];
    var index = -1;
    // applyLocation 期间的记录闸门（见文件头注释第 1 条）
    var paused = false;
    var lastSideDir = '';
    var lastSideAt = 0;

    function t(key) {
      if (typeof deps.t === 'function') return deps.t(key);
      return tZh[key] || key;
    }

    function tFmt(key, map) {
      if (typeof deps.tFmt === 'function') return deps.tFmt(key, map);
      var s = tZh[key] || t(key);
      if (map) {
        for (var k in map) {
          if (hasOwn(map, k)) s = s.split('{' + k + '}').join(String(map[k]));
        }
      }
      return s;
    }

    /** 按钮文案：够到目标时写「后退：<目标名>」，够不到就只写动作名（点了没反应，别误导） */
    function labelInto(el, target, plainKey, fmtKey) {
      if (!el) return;
      var label = t(plainKey);
      if (target && typeof deps.describeLocation === 'function') {
        var name = deps.describeLocation(target);
        if (name) label = tFmt(fmtKey, { name: name });
      }
      el.setAttribute('title', label);
      el.setAttribute('aria-label', label);
    }

    function sync() {
      var b = canGoBack(index);
      var f = canGoForward(entries, index);
      if (backEl) {
        backEl.disabled = !b;
        labelInto(backEl, b ? entries[index - 1] : null, 'path.back', 'path.backFmt');
      }
      if (forwardEl) {
        forwardEl.disabled = !f;
        labelInto(
          forwardEl,
          f ? entries[index + 1] : null,
          'path.forward',
          'path.forwardFmt',
        );
      }
    }

    function applyCurrent() {
      var loc = entries[index];
      // 先刷按钮态再应用：用户点下去立刻看到箭头变灰，而不是等目录加载完
      sync();
      if (!loc || typeof deps.applyLocation !== 'function') return false;
      paused = true;
      try {
        deps.applyLocation(loc);
      } finally {
        paused = false;
      }
      sync();
      return true;
    }

    function goBack() {
      if (!canGoBack(index)) return false;
      index -= 1;
      return applyCurrent();
    }

    function goForward() {
      if (!canGoForward(entries, index)) return false;
      index += 1;
      return applyCurrent();
    }

    /** 记录当前位置（由 app 的导航入口调用；同位置幂等） */
    function record(loc) {
      if (paused || !loc) return false;
      var r = pushEntry(entries, index, loc, HISTORY_LIMIT);
      entries = r.entries;
      index = r.index;
      sync();
      return r.changed;
    }

    /** 以某位置重建栈（启动落地完成后调一次，丢掉启动过程中的中间态） */
    function reset(loc) {
      entries = loc ? [loc] : [];
      index = entries.length - 1;
      sync();
      return entries.length;
    }

    function allowed() {
      return typeof deps.canNavigate !== 'function' || deps.canNavigate();
    }

    function onClickBack() {
      goBack();
    }

    function onClickForward() {
      goForward();
    }

    function onKeyDown(e) {
      var dir = keyIntent(e);
      if (!dir) return;
      if (!allowed()) return;
      e.preventDefault();
      if (dir === 'back') goBack();
      else goForward();
    }

    /** 侧键按下：只压掉默认行为，不在这里触发（同一击还会来 mouseup / auxclick） */
    function onSideDown(e) {
      if (!sideIntent(e)) return;
      e.preventDefault();
    }

    function onSideTrigger(e) {
      var dir = sideIntent(e);
      if (!dir) return;
      e.preventDefault();
      var now = Date.now();
      if (dir === lastSideDir && now - lastSideAt < SIDE_BUTTON_DEBOUNCE_MS) return;
      lastSideDir = dir;
      lastSideAt = now;
      if (!allowed()) return;
      if (dir === 'back') goBack();
      else goForward();
    }

    function bind() {
      if (backEl) backEl.addEventListener('click', onClickBack);
      if (forwardEl) forwardEl.addEventListener('click', onClickForward);
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('mousedown', onSideDown);
      document.addEventListener('mouseup', onSideTrigger);
      document.addEventListener('auxclick', onSideTrigger);
    }

    return {
      record: record,
      reset: reset,
      back: goBack,
      forward: goForward,
      canBack: function () {
        return canGoBack(index);
      },
      canForward: function () {
        return canGoForward(entries, index);
      },
      size: function () {
        return entries.length;
      },
      index: function () {
        return index;
      },
      entryAt: function (i) {
        return entries[i] || null;
      },
      sync: sync,
      bind: bind,
    };
  }

  global.RendererNavHistory = Object.assign({}, global.RendererNavHistory || {}, {
    HISTORY_LIMIT: HISTORY_LIMIT,
    SIDE_BUTTON_DEBOUNCE_MS: SIDE_BUTTON_DEBOUNCE_MS,
    keyOf: keyOf,
    pushEntry: pushEntry,
    canGoBack: canGoBack,
    canGoForward: canGoForward,
    keyIntent: keyIntent,
    sideIntent: sideIntent,
    mount: mount,
  });
})(window);
