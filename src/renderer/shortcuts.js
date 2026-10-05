(function (global) {
  'use strict';

  /**
   * 快捷键注册表 —— 键位的**唯一真相源**。
   *
   * 为什么要单独一个文件：改造前每个键位都硬编码在各自的事件处理里
   * （`ui-events.js` 的预览段、`nav-history.js` 的导航段、`main.js` 的全局段），
   * 三处各写各的，结果是标题栏菜单里明明写着 `Ctrl+O` / `F11` / `F12`，
   * 实际**没有任何人监听** —— 三个快捷键长期是摆设（`Ctrl+Q` 靠主进程 globalShortcut 才真的能用）。
   *
   * 现在：动作与默认键只在本文件声明一次；设置页从同一份注册表渲染；
   * 事件处理端只问「这一下按键落在哪个动作上」，于是改键天然全局生效，
   * 也不会再出现「菜单写了但没人实现」这类漂移。
   *
   * 绑定串格式：`Ctrl+Alt+Shift+Meta+主键`
   *   · 修饰键顺序固定（Ctrl → Alt → Shift → Meta），缺省即表示不按；
   *   · 主键 token 规范化：字母统一大写（`f` → `F`）、空格 → `Space`、
   *     `+`/`=` → `Plus`、`-`/`_` → `Minus`，其余沿用 `KeyboardEvent.key`
   *     （`ArrowLeft`、`Escape`、`Delete`、`Home`、`F11`…）。
   * 这样**修饰键之间的顺序无关**（`Ctrl+Shift+B` 与 `Shift+Ctrl+B` 归一到同一个串），
   * 不会因为书写顺序不同而漏判。
   *
   * 🔴 但**主键必须写在最后一段**：`normalizeBinding` 把 `split('+')` 的**末段**当主键，
   * 所以 `Ctrl+B+Shift` 会被判成「主键 = Shift」→ 撞上 `PURE_MODIFIERS` → 返回空串，
   * 于是这条覆盖在 `setOverrides` 里被**静默丢弃**（动作回落到默认键，用户以为改成功了）。
   * 程序自己产出的串（`bindingFromEvent`）永远是规范顺序，这条只对**手写 settings.json** 生效。
   * 若哪天要支持「主键在任意位置」，改这里：把「取末段」换成「扫出唯一一个非修饰段」。
   */

  /** 修饰键本身：按住不放时不产生绑定 */
  var PURE_MODIFIERS = { Control: 1, Alt: 1, Shift: 1, Meta: 1, AltGraph: 1 };

  /** `KeyboardEvent.key` → 规范 token（只在需要改写时列出） */
  var TOKEN_ALIASES = {
    ' ': 'Space',
    Spacebar: 'Space',
    '+': 'Plus',
    '=': 'Plus',
    '-': 'Minus',
    _: 'Minus',
    Esc: 'Escape',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Del: 'Delete',
  };

  /** 设置页里「按下按键」后不允许被占用、或按不出合理手势的 token */
  var RESERVED_TOKENS = { Tab: 1, Control: 1, Alt: 1, Shift: 1, Meta: 1, AltGraph: 1, CapsLock: 1 };

  /**
   * 动作注册表。
   *
   * id       —— 稳定标识，同时是 `settings.shortcuts` 的键；**改名等于丢掉用户已改的键位**
   * group    —— 设置页分组（global / navigation / preview）
   * scope    —— 冲突判定域：只有**同一 scope 内**重复才算冲突
   *            （预览里的 `Esc` 与弹窗里的 `Esc` 本就各自独立）
   * def      —— 默认绑定（数组：同一动作可以有多个等价手势，如 `Alt+←` 与 `Cmd+[`）
   * key      —— i18n key；`zh` 是 i18n 未就绪时的兜底文案
   */
  var ACTIONS = [
    // ===== 全局（主界面，输入框聚焦时不触发）=====
    {
      id: 'global.addFolder',
      group: 'global',
      scope: 'global',
      def: ['Ctrl+O'],
      key: 'shortcut.action.addFolder',
      zh: '添加文件夹',
    },
    {
      id: 'global.hideToTray',
      group: 'global',
      scope: 'global',
      def: ['Ctrl+Q'],
      key: 'shortcut.action.hideToTray',
      zh: '隐藏到托盘后台 / 再次按下恢复',
    },
    {
      id: 'global.compactChrome',
      group: 'global',
      scope: 'global',
      def: ['Ctrl+B'],
      key: 'shortcut.action.compactChrome',
      zh: '切换简洁界面',
    },
    {
      id: 'global.fullscreen',
      group: 'global',
      scope: 'global',
      def: ['F11'],
      key: 'shortcut.action.fullscreen',
      zh: '全屏',
    },
    {
      id: 'global.devtools',
      group: 'global',
      scope: 'global',
      def: ['F12'],
      key: 'shortcut.action.devtools',
      zh: '开发者工具',
    },
    // ===== 导航历史 =====
    {
      // 首页（Home）是一条独立页面，与设置页同族 —— 入口是这枚动作 + rail 上的按钮，
      // 刻意**不进** BROWSABLE_VIEWS（它不进前进 / 后退栈）。
      id: 'nav.home',
      group: 'navigation',
      scope: 'global',
      def: ['Alt+Home'],
      key: 'shortcut.action.navHome',
      zh: '回到首页',
    },
    {
      id: 'nav.back',
      group: 'navigation',
      scope: 'global',
      def: ['Alt+ArrowLeft', 'Meta+['],
      key: 'shortcut.action.navBack',
      zh: '后退',
    },
    {
      id: 'nav.forward',
      group: 'navigation',
      scope: 'global',
      def: ['Alt+ArrowRight', 'Meta+]'],
      key: 'shortcut.action.navForward',
      zh: '前进',
    },
    // ===== 预览 =====
    {
      id: 'preview.close',
      group: 'preview',
      scope: 'preview',
      def: ['Escape'],
      key: 'shortcut.action.previewClose',
      zh: '关闭预览',
    },
    {
      id: 'preview.prev',
      group: 'preview',
      scope: 'preview',
      def: ['ArrowLeft'],
      key: 'shortcut.action.previewPrev',
      zh: '上一张',
    },
    {
      id: 'preview.next',
      group: 'preview',
      scope: 'preview',
      def: ['ArrowRight'],
      key: 'shortcut.action.previewNext',
      zh: '下一张',
    },
    {
      id: 'preview.first',
      group: 'preview',
      scope: 'preview',
      def: ['Home'],
      key: 'shortcut.action.previewFirst',
      zh: '跳到第一张',
    },
    {
      id: 'preview.last',
      group: 'preview',
      scope: 'preview',
      def: ['End'],
      key: 'shortcut.action.previewLast',
      zh: '跳到最后一张',
    },
    {
      id: 'preview.slideshow',
      group: 'preview',
      scope: 'preview',
      def: ['Space'],
      key: 'shortcut.action.previewSlideshow',
      zh: '播放 / 暂停幻灯片',
    },
    {
      id: 'preview.favorite',
      group: 'preview',
      scope: 'preview',
      def: ['F'],
      key: 'shortcut.action.previewFavorite',
      zh: '收藏 / 取消收藏',
    },
    {
      id: 'preview.trash',
      group: 'preview',
      scope: 'preview',
      def: ['Delete'],
      key: 'shortcut.action.previewTrash',
      zh: '删除到回收站',
    },
    {
      id: 'preview.rotate',
      group: 'preview',
      scope: 'preview',
      def: ['R'],
      key: 'shortcut.action.previewRotate',
      zh: '顺时针旋转 90°',
    },
    {
      id: 'preview.zoomIn',
      group: 'preview',
      scope: 'preview',
      def: ['Plus'],
      key: 'shortcut.action.previewZoomIn',
      zh: '放大',
    },
    {
      id: 'preview.zoomOut',
      group: 'preview',
      scope: 'preview',
      def: ['Minus'],
      key: 'shortcut.action.previewZoomOut',
      zh: '缩小',
    },
    {
      id: 'preview.zoomReset',
      group: 'preview',
      scope: 'preview',
      def: ['0'],
      key: 'shortcut.action.previewZoomReset',
      zh: '重置缩放与旋转',
    },
    {
      id: 'preview.findSimilar',
      group: 'preview',
      scope: 'preview',
      def: ['S'],
      key: 'shortcut.action.previewFindSimilar',
      zh: '查找相似照片',
    },
    {
      id: 'preview.openExternal',
      group: 'preview',
      scope: 'preview',
      def: ['O'],
      key: 'shortcut.action.previewOpenExternal',
      zh: '用系统默认程序打开',
    },
  ];

  /** 分组顺序与标题，设置页按它渲染 */
  var GROUPS = [
    { id: 'global', key: 'shortcut.group.global', zh: '全局' },
    { id: 'navigation', key: 'shortcut.group.navigation', zh: '导航' },
    { id: 'preview', key: 'shortcut.group.preview', zh: '预览大图' },
  ];

  var ACTION_BY_ID = {};
  for (var ai = 0; ai < ACTIONS.length; ai++) ACTION_BY_ID[ACTIONS[ai].id] = ACTIONS[ai];

  /** 用户覆盖：`{ actionId: 'Ctrl+Shift+P' }`，空串表示「已禁用」 */
  var overrides = {};

  // ===== 规范化 =====

  function normalizeToken(raw) {
    var k = String(raw == null ? '' : raw);
    if (TOKEN_ALIASES[k]) return TOKEN_ALIASES[k];
    if (k.length === 1 && /[a-zA-Z]/.test(k)) return k.toUpperCase();
    return k;
  }

  /** 修饰键前缀：顺序**固定**为 Ctrl → Alt → Shift → Meta，与用户书写顺序无关。
   *  （唯一出处就是这里；`Ctrl+Shift+B` 与 `Ctrl+B+Shift` 因此得到同一个绑定串。） */
  function modsToPrefix(ctrl, alt, shift, meta) {
    var out = [];
    if (ctrl) out.push('Ctrl');
    if (alt) out.push('Alt');
    if (shift) out.push('Shift');
    if (meta) out.push('Meta');
    return out;
  }

  /**
   * `Plus` / `Minus` 的 Shift 是**键盘布局的副产品**而非用户意图：
   * 美式布局上 `+` 本身就要求 Shift，`Shift+=` 报的是 `'='`、`Shift+-` 报的是 `'_'`。
   * 若不做归一，用户旧习惯里的 `Ctrl+=`（放大）会突然失灵 —— 注册表里绑的是 `Plus`，
   * 而事件来的是 `Shift+Plus`。同理由 `_` 归一到 `Minus`。
   */
  function dropLayoutShift(token, ctrl, alt, shift, meta) {
    if (!shift || ctrl || alt || meta) return shift;
    return !(token === 'Plus' || token === 'Minus');
  }

  /** 把任意书写的绑定串收敛成 `Ctrl+Alt+Shift+Meta+KEY`；无法解析时返回 '' */
  function normalizeBinding(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    var parts = s.split('+');
    var token = normalizeToken(parts.pop());
    if (!token || PURE_MODIFIERS[token] || RESERVED_TOKENS[token]) return '';
    var ctrl = false;
    var alt = false;
    var shift = false;
    var meta = false;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim().toLowerCase();
      if (!p) continue;
      if (p === 'ctrl' || p === 'control' || p === 'cmdorctrl' || p === 'commandorcontrol') ctrl = true;
      else if (p === 'alt' || p === 'option') alt = true;
      else if (p === 'shift') shift = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') meta = true;
    }
    shift = dropLayoutShift(token, ctrl, alt, shift, meta);
    return modsToPrefix(ctrl, alt, shift, meta).concat([token]).join('+');
  }

  /** 从键盘事件取绑定串；按住纯修饰键或无法识别时返回 '' */
  function bindingFromEvent(e) {
    if (!e) return '';
    var token = normalizeToken(e.key);
    if (!token || PURE_MODIFIERS[token] || RESERVED_TOKENS[token]) return '';
    var shift = dropLayoutShift(token, !!e.ctrlKey, !!e.altKey, !!e.shiftKey, !!e.metaKey);
    return modsToPrefix(!!e.ctrlKey, !!e.altKey, shift, !!e.metaKey).concat([token]).join('+');
  }

  // ===== 读写 =====

  function setOverrides(map) {
    overrides = {};
    if (!map || typeof map !== 'object') return;
    for (var id in map) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
      if (!ACTION_BY_ID[id]) continue; // 注册表里已删掉的动作，静默丢弃
      var raw = map[id];
      if (raw === '' || raw == null) overrides[id] = ''; // 显式禁用
      else {
        var n = normalizeBinding(raw);
        if (n) overrides[id] = n;
      }
    }
  }

  function getOverrides() {
    var out = {};
    for (var id in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, id)) out[id] = overrides[id];
    }
    return out;
  }

  /**
   * 某动作当前生效的绑定列表。
   * 返回空数组 = 该动作已被用户禁用（或被清空），调用方据此直接放行。
   */
  function bindingListFor(id) {
    var action = ACTION_BY_ID[id];
    if (!action) return [];
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      var one = overrides[id];
      return one ? [one] : [];
    }
    var out = [];
    for (var i = 0; i < action.def.length; i++) {
      var n = normalizeBinding(action.def[i]);
      if (n) out.push(n);
    }
    return out;
  }

  /** 单值形式，给设置页显示用；多手势时给出第一个 */
  function bindingFor(id) {
    var list = bindingListFor(id);
    return list.length ? list[0] : '';
  }

  function isCustomized(id) {
    return Object.prototype.hasOwnProperty.call(overrides, id);
  }

  function matches(id, e) {
    var list = bindingListFor(id);
    if (!list.length) return false;
    var b = bindingFromEvent(e);
    if (!b) return false;
    return list.indexOf(b) !== -1;
  }

  /** 该事件命中的动作 id（限定 scope）；没命中返回 '' */
  function actionFor(e, scope) {
    var b = bindingFromEvent(e);
    if (!b) return '';
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      if (scope && a.scope !== scope) continue;
      if (bindingListFor(a.id).indexOf(b) !== -1) return a.id;
    }
    return '';
  }

  // ===== 设置页需要的派生数据 =====

  function defaults() {
    var out = {};
    for (var i = 0; i < ACTIONS.length; i++) out[ACTIONS[i].id] = bindingForDefault(ACTIONS[i].id);
    return out;
  }

  function bindingForDefault(id) {
    var a = ACTION_BY_ID[id];
    if (!a || !a.def.length) return '';
    return normalizeBinding(a.def[0]);
  }

  /**
   * 冲突检测：同一 scope 内两个及以上动作落在同一个绑定上。
   *
   * `draft` 可选，形如 `{id: binding}`，用于设置页在**尚未落库**时实时预览冲突；
   * 不传则按当前生效的绑定算。返回 `{ binding: [actionId, ...] }`。
   */
  function findConflicts(draft) {
    var useDraft = draft && typeof draft === 'object';
    var seen = {};
    for (var i = 0; i < ACTIONS.length; i++) {
      var a = ACTIONS[i];
      var list;
      if (useDraft && Object.prototype.hasOwnProperty.call(draft, a.id)) {
        var raw = draft[a.id];
        list = raw === '' || raw == null ? [] : [normalizeBinding(raw)].filter(Boolean);
      } else if (!useDraft && Object.prototype.hasOwnProperty.call(overrides, a.id)) {
        list = bindingListFor(a.id);
      } else {
        list = bindingListFor(a.id);
      }
      for (var j = 0; j < list.length; j++) {
        var k = a.scope + '\u0000' + list[j];
        if (!seen[k]) seen[k] = { binding: list[j], scope: a.scope, ids: [] };
        if (seen[k].ids.indexOf(a.id) === -1) seen[k].ids.push(a.id);
      }
    }
    var out = {};
    for (var key in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, key)) continue;
      if (seen[key].ids.length > 1) out[seen[key].binding] = seen[key].ids;
    }
    return out;
  }

  /** 某个动作是否与别人撞键（设置页用来标红） */
  function conflictPartners(id, draft) {
    var conflicts = findConflicts(draft);
    var out = [];
    for (var binding in conflicts) {
      if (!Object.prototype.hasOwnProperty.call(conflicts, binding)) continue;
      if (conflicts[binding].indexOf(id) === -1) continue;
      for (var i = 0; i < conflicts[binding].length; i++) {
        if (conflicts[binding][i] !== id && out.indexOf(conflicts[binding][i]) === -1)
          out.push(conflicts[binding][i]);
      }
    }
    return out;
  }

  // ===== 显示 =====

  var TOKEN_LABELS = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'Space',
    Plus: '+',
    Minus: '−',
    Escape: 'Esc',
    Delete: 'Del',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Home: 'Home',
    End: 'End',
    PageUp: 'PgUp',
    PageDown: 'PgDn',
  };

  function isMac() {
    try {
      return !!(global.navigator && /Mac|iPhone|iPad/.test(global.navigator.platform || ''));
    } catch (_) {
      return false;
    }
  }

  /**
   * 绑定串 → 界面显示。`Space` / `Plus` 这类 token 直接展示会很别扭，
   * mac 上还把 Ctrl 显示成 ⌘（`Cmd+[` 那套手势就是这么写的）。
   */
  function displayBinding(binding, useMac) {
    var s = normalizeBinding(binding);
    if (!s) return '';
    var parts = s.split('+');
    var token = parts.pop();
    var mac = useMac == null ? isMac() : !!useMac;
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (mac && parts[i] === 'Meta') out.push('⌘');
      else if (mac && parts[i] === 'Ctrl') out.push('⌃');
      else if (parts[i] === 'Meta') out.push('Win');
      else out.push(parts[i]);
    }
    var label = TOKEN_LABELS[token] || token;
    out.push(label);
    return mac ? out.join('') : out.join(' + ');
  }

  global.RendererShortcuts = {
    ACTIONS: ACTIONS,
    GROUPS: GROUPS,
    RESERVED_TOKENS: RESERVED_TOKENS,
    actionById: function (id) {
      return ACTION_BY_ID[id] || null;
    },
    normalizeBinding: normalizeBinding,
    bindingFromEvent: bindingFromEvent,
    setOverrides: setOverrides,
    getOverrides: getOverrides,
    bindingListFor: bindingListFor,
    bindingFor: bindingFor,
    bindingForDefault: bindingForDefault,
    isCustomized: isCustomized,
    matches: matches,
    actionFor: actionFor,
    defaults: defaults,
    findConflicts: findConflicts,
    conflictPartners: conflictPartners,
    displayBinding: displayBinding,
  };
})(typeof window !== 'undefined' ? window : globalThis);
