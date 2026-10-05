(function (global) {
  'use strict';

  /**
   * 「快捷键」设置面板。
   *
   * 数据流（单向，避免出现「界面改了但按下去还是旧键」）：
   *   settings.shortcuts  ──applyFromSettings──▶  state.shortcutOverrides
   *                                                 │
   *                          注册表 setOverrides ◀──┘（事件处理立即按新键生效）
   *                                                 │
   *   用户录制新键 ──updateSettings({shortcuts})──▶ 主进程落库
   *                                                 │
   *                                  返回的完整设置 ──applyFromSettings──▶ 重画
   *
   * 冲突检测交给注册表（同一 scope 内两个动作撞同一个绑定才算冲突）：
   * 预览里的 Esc 与别处的 Esc 本就互不干扰，不该在这里报冲突。
   */

  function t(key, zh) {
    if (global.I18n && typeof global.I18n.t === 'function') {
      var v = global.I18n.t(key);
      if (v && v !== key) return v;
    }
    return zh;
  }

  function tFmt(key, map, zhFallback) {
    if (global.I18n && typeof global.I18n.t === 'function') {
      var tpl = global.I18n.t(key);
      if (tpl && tpl !== key) {
        var out = tpl;
        for (var k in map) {
          if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
          out = out.split('{' + k + '}').join(String(map[k]));
        }
        return out;
      }
    }
    return zhFallback;
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function registry() {
    return global.RendererShortcuts || null;
  }

  function actionLabel(action) {
    return t(action.key, action.zh);
  }

  function groupLabel(group) {
    return t(group.key, group.zh);
  }

  /** state 上维护的字段，首次调用时补默认值 */
  function ensureState(state) {
    if (!state) return null;
    if (!state.shortcutOverrides || typeof state.shortcutOverrides !== 'object')
      state.shortcutOverrides = {};
    if (typeof state.shortcutRecording === 'undefined') state.shortcutRecording = '';
    return state;
  }

  /**
   * 设置 → state + 注册表。注册表是按键判定的唯一入口，所以**先喂注册表再画界面**：
   * 否则首帧里界面显示的是新键、实际按下去的仍是旧键。
   */
  function applyFromSettings(options) {
    options = options || {};
    var state = ensureState(options.state);
    var sr = registry();
    if (!state || !sr) return;
    var raw = options.settings && options.settings.shortcuts;
    var next = sr && typeof raw === 'object' && raw ? raw : {};
    sr.setOverrides(next);
    state.shortcutOverrides = sr.getOverrides();
    renderForm({ state: state });
  }

  /** 当前生效的覆盖（state 为真源，注册表已同步） */
  function currentOverrides(state) {
    return (state && state.shortcutOverrides) || {};
  }

  function conflictMapFor(state) {
    var sr = registry();
    if (!sr) return {};
    return sr.findConflicts(currentOverrides(state));
  }

  function renderForm(options) {
    options = options || {};
    var state = ensureState(options.state);
    var host = document.getElementById('settingsShortcutsList');
    if (!host || !state) return;
    var sr = registry();
    if (!sr) {
      host.innerHTML = '';
      return;
    }
    var conflicts = conflictMapFor(state);
    var recording = state.shortcutRecording || '';
    var html = [];

    for (var g = 0; g < sr.GROUPS.length; g++) {
      var group = sr.GROUPS[g];
      html.push(
        '<section class="stg-card">' +
          '<h3 class="shortcut-group-title">' +
          esc(groupLabel(group)) +
          '</h3>' +
          '<div class="shortcut-list">',
      );
      for (var i = 0; i < sr.ACTIONS.length; i++) {
        var action = sr.ACTIONS[i];
        if (action.group !== group.id) continue;
        html.push(rowHtml(sr, state, action, conflicts, recording));
      }
      html.push('</div></section>');
    }
    host.innerHTML = html.join('');
    renderConflictSummary(conflicts);
  }

  function rowHtml(sr, state, action, conflicts, recording) {
    var isRecording = recording === action.id;
    var customized = sr.isCustomized(action.id);
    var bindings = sr.bindingListFor(action.id);
    var label;
    var disabled = !bindings.length;

    if (isRecording) {
      label = t('shortcut.pressKeys', '请按下组合键…');
    } else if (disabled) {
      label = t('shortcut.unbound', '未设置');
    } else {
      label = sr.displayBinding(bindings[0]);
    }

    var partners = [];
    for (var binding in conflicts) {
      if (!Object.prototype.hasOwnProperty.call(conflicts, binding)) continue;
      if (conflicts[binding].indexOf(action.id) === -1) continue;
      for (var p = 0; p < conflicts[binding].length; p++) {
        if (conflicts[binding][p] !== action.id) partners.push(conflicts[binding][p]);
      }
    }
    var partnerNames = [];
    for (var n = 0; n < partners.length; n++) {
      var other = sr.actionById(partners[n]);
      if (other) partnerNames.push(actionLabel(other));
    }
    // 一个动作最多绑两个手势（如 Alt+← 与 Cmd+[），撞键提示把它们都列出来
    if (bindings.length > 1 && !disabled) {
      label += ' / ' + sr.displayBinding(bindings[1]);
    }

    var noteHtml = partnerNames.length
      ? '<span class="shortcut-row-note is-conflict">' +
        esc(
          tFmt(
            'shortcut.conflictOne',
            { names: partnerNames.join('、') },
            '与「' + partnerNames.join('、') + '」使用了相同按键',
          ),
        ) +
        '</span>'
      : '';

    var cls =
      'shortcut-key' +
      (isRecording ? ' is-recording' : '') +
      (customized ? ' is-customized' : '') +
      (disabled ? ' is-disabled' : '');

    return (
      '<div class="shortcut-row' +
      (partnerNames.length ? ' is-conflict' : '') +
      '" data-shortcut-row="' +
      esc(action.id) +
      '">' +
      '<div class="shortcut-row-label">' +
      '<span class="shortcut-row-name">' +
      esc(actionLabel(action)) +
      '</span>' +
      noteHtml +
      '</div>' +
      '<div class="shortcut-row-controls">' +
      '<button type="button" class="' +
      cls +
      '" data-shortcut-key="' +
      esc(action.id) +
      '" aria-label="' +
      esc(tFmt('shortcut.keyAria', { name: actionLabel(action) }, actionLabel(action) + ' 的按键')) +
      '">' +
      esc(label) +
      '</button>' +
      '<button type="button" class="shortcut-reset-btn" data-shortcut-reset="' +
      esc(action.id) +
      '"' +
      (customized ? '' : ' disabled') +
      '>' +
      esc(t('shortcut.resetOne', '恢复默认')) +
      '</button>' +
      '</div></div>'
    );
  }

  function renderConflictSummary(conflicts) {
    var el = document.getElementById('settingsShortcutsConflictHint');
    if (!el) return;
    var count = 0;
    for (var binding in conflicts) {
      if (Object.prototype.hasOwnProperty.call(conflicts, binding)) count++;
    }
    if (!count) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = tFmt(
      'shortcut.conflictSummary',
      { count: count },
      '有 ' +
        count +
        ' 处按键冲突：同一个按键被两个动作占用，会只有其中一个生效，请改成不同的组合键。',
    );
  }

  // ===== 录制 =====

  var recordingHandler = null;

  function stopRecording(options) {
    options = options || {};
    var state = ensureState(options.state);
    if (!state) return;
    var wasRecording = state.shortcutRecording;
    state.shortcutRecording = '';
    if (recordingHandler) {
      global.removeEventListener('keydown', recordingHandler, true);
      recordingHandler = null;
    }
    var body = document.body;
    if (body && body.classList) body.classList.remove('is-recording-shortcut');
    if (wasRecording) renderForm({ state: state });
  }

  /**
   * 进入录制。用 window **捕获**阶段吞掉这次按键：设置页开着时别的监听器
   * （预览、导航历史、通用弹窗）都不该因为用户「正在设置快捷键」而真去执行动作。
   */
  function startRecording(actionId, options) {
    options = options || {};
    var state = ensureState(options.state);
    var sr = registry();
    if (!state || !sr || !sr.actionById(actionId)) return;

    stopRecording({ state: state });
    state.shortcutRecording = actionId;
    renderForm({ state: state });
    var body = document.body;
    if (body && body.classList) body.classList.add('is-recording-shortcut');

    recordingHandler = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        stopRecording({ state: state });
        return;
      }
      // Delete / Backspace = 清掉这个动作的按键（不删除动作本身）
      if (e.key === 'Delete' || e.key === 'Backspace') {
        state.shortcutRecording = '';
        commitOverride(actionId, '', options);
        stopRecording({ state: state });
        renderForm({ state: state });
        return;
      }
      var binding = sr.bindingFromEvent(e);
      if (!binding) return; // 只按住了修饰键本身，继续等
      if (sr.RESERVED_TOKENS[e.key]) return;
      state.shortcutRecording = '';
      commitOverride(actionId, binding, options);
      stopRecording({ state: state });
      renderForm({ state: state });
    };
    global.addEventListener('keydown', recordingHandler, true);
  }

  /** 写进 state + 注册表（立即生效），然后异步落库 */
  function commitOverride(actionId, binding, options) {
    options = options || {};
    var state = ensureState(options.state);
    var sr = registry();
    if (!state || !sr) return;
    var next = sr.getOverrides();
    next[actionId] = binding;
    sr.setOverrides(next);
    state.shortcutOverrides = sr.getOverrides();
    persist(state, options);
  }

  function resetAll(options) {
    options = options || {};
    var state = ensureState(options.state);
    var sr = registry();
    if (!state || !sr) return;
    sr.setOverrides({});
    state.shortcutOverrides = {};
    stopRecording({ state: state });
    renderForm({ state: state });
    persist(state, options);
  }

  async function persist(state, options) {
    var api = options.api || null;
    if (!(api && api.has && api.has('updateSettings'))) return;
    var payload = registry().getOverrides();
    try {
      var applied = await api.updateSettings({ shortcuts: payload });
      if (applied && typeof options.onApplied === 'function') options.onApplied(applied);
    } catch (e) {
      if (typeof options.appAlert === 'function') {
        options.appAlert(
          tFmt(
            'shortcut.saveFailed',
            { error: e && e.message ? e.message : String(e) },
            '保存快捷键失败：' + (e && e.message ? e.message : String(e)),
          ),
        );
      }
      // 落库失败 → 按主进程里的旧值回滚，别让界面停在没真正生效的状态
      if (typeof options.onRevert === 'function') options.onRevert();
    }
  }

  // ===== 事件接线（委托，一次绑定） =====

  function bindPanel(options) {
    options = options || {};
    var host = document.getElementById('settingsShortcutsList');
    if (!host || host.getAttribute('data-shortcut-bound') === '1') return;
    host.setAttribute('data-shortcut-bound', '1');

    host.addEventListener('click', function (e) {
      var resetBtn = e.target.closest ? e.target.closest('[data-shortcut-reset]') : null;
      if (resetBtn) {
        var rid = resetBtn.getAttribute('data-shortcut-reset');
        if (rid) {
          var sr = registry();
          var next = sr.getOverrides();
          delete next[rid];
          sr.setOverrides(next);
          var st = ensureState(options.state);
          st.shortcutOverrides = sr.getOverrides();
          renderForm({ state: st });
          persist(st, options);
        }
        return;
      }
      var keyBtn = e.target.closest ? e.target.closest('[data-shortcut-key]') : null;
      if (keyBtn) {
        var id = keyBtn.getAttribute('data-shortcut-key');
        if (id) startRecording(id, options);
      }
    });

    // 焦点离开键位框 = 放弃这次录制（否则「点了没按」会把界面卡在录制态）
    host.addEventListener(
      'focusout',
      function (e) {
        var st = ensureState(options.state);
        if (!st || !st.shortcutRecording) return;
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-shortcut-key'))
          stopRecording({ state: st });
      },
      true,
    );

    var resetAllBtn = document.getElementById('settingsShortcutsResetAllBtn');
    if (resetAllBtn && resetAllBtn.getAttribute('data-shortcut-bound') !== '1') {
      resetAllBtn.setAttribute('data-shortcut-bound', '1');
      resetAllBtn.addEventListener('click', function () {
        resetAll({ state: options.state, api: options.api, appAlert: options.appAlert });
      });
    }
  }

  global.RendererShortcutSettings = {
    applyFromSettings: applyFromSettings,
    renderForm: renderForm,
    bindPanel: bindPanel,
    startRecording: startRecording,
    stopRecording: stopRecording,
    resetAll: resetAll,
    conflictMapFor: conflictMapFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
