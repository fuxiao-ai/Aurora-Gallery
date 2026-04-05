(function (global) {
  'use strict';

  // ===== dialog-ui.js =====
  var appDialogQueue = Promise.resolve();
  var activeAppDialogCleanup = null;

  function showAppDialog(options) {
    options = options || {};
    var overlay = document.getElementById('appDialogOverlay');
    var titleEl = document.getElementById('appDialogTitle');
    var msgEl = document.getElementById('appDialogMessage');
    var actionsEl = document.getElementById('appDialogActions');
    var okBtn = document.getElementById('appDialogOkBtn');
    var cancelBtn = document.getElementById('appDialogCancelBtn');
    if (!overlay || !titleEl || !msgEl || !actionsEl || !okBtn || !cancelBtn) {
      return Promise.resolve(options.type === 'confirm' ? false : undefined);
    }
    var mode = options.type === 'confirm' ? 'confirm' : 'alert';
    var title = options.title || (mode === 'confirm' ? '请确认' : '提示');
    var message = options.message == null ? '' : String(options.message);
    var okText = options.okText || '确定';
    var cancelText = options.cancelText || '取消';

    return new Promise(function (resolve) {
      function cleanup() {
        document.removeEventListener('keydown', onKeydown, true);
        overlay.removeEventListener('click', onOverlayClick);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
        activeAppDialogCleanup = null;
      }
      function finish(v) {
        cleanup();
        resolve(v);
      }
      function onOk() {
        finish(mode === 'confirm' ? true : undefined);
      }
      function onCancel() {
        finish(mode === 'confirm' ? false : undefined);
      }
      function onOverlayClick() {
        onCancel();
      }
      function onKeydown(e) {
        if (!overlay.classList.contains('show')) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onOk();
        }
      }

      if (activeAppDialogCleanup) activeAppDialogCleanup();
      activeAppDialogCleanup = cleanup;
      titleEl.textContent = title;
      msgEl.textContent = message;
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;
      cancelBtn.style.display = mode === 'confirm' ? '' : 'none';
      actionsEl.style.justifyContent = mode === 'confirm' ? 'flex-end' : 'center';
      overlay.setAttribute('aria-hidden', 'false');
      overlay.classList.add('show');

      document.addEventListener('keydown', onKeydown, true);
      overlay.addEventListener('click', onOverlayClick);
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      setTimeout(function () {
        (mode === 'confirm' ? cancelBtn : okBtn).focus();
      }, 0);
    });
  }

  function appAlert(message, title) {
    var p = appDialogQueue.then(function () {
      return showAppDialog({
        type: 'alert',
        title: title || '提示',
        message: message,
        okText: '知道了',
      });
    });
    appDialogQueue = p.catch(function () {});
    return p;
  }

  function appConfirm(message, title) {
    var p = appDialogQueue.then(function () {
      return showAppDialog({
        type: 'confirm',
        title: title || '请确认',
        message: message,
        okText: '确定',
        cancelText: '取消',
      });
    });
    appDialogQueue = p.catch(function () {});
    return p;
  }

  global.RendererDialogUI = Object.assign({}, global.RendererDialogUI || {}, {
    showAppDialog: showAppDialog,
    appAlert: appAlert,
    appConfirm: appConfirm,
  });

  // ===== close-choice-ui.js =====
  function closeChoiceOnEscape(e, options) {
    options = options || {};
    var onSubmitCloseChoice = options.onSubmitCloseChoice;
    var el = document.getElementById('closeChoiceOverlay');
    if (!el || !el.classList.contains('show')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typeof onSubmitCloseChoice === 'function') onSubmitCloseChoice('cancel');
    }
  }

  function hideCloseChoiceOverlay(options) {
    options = options || {};
    var onCloseChoiceOnEscape = options.onCloseChoiceOnEscape;
    var el = document.getElementById('closeChoiceOverlay');
    if (!el) return;
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
    if (typeof onCloseChoiceOnEscape === 'function') {
      document.removeEventListener('keydown', onCloseChoiceOnEscape);
    }
  }

  function showCloseChoiceOverlay(options) {
    options = options || {};
    var onCloseChoiceOnEscape = options.onCloseChoiceOnEscape;
    var el = document.getElementById('closeChoiceOverlay');
    if (!el) return;
    var cb = document.getElementById('closeChoiceRemember');
    if (cb) cb.checked = false;
    el.classList.add('show');
    el.setAttribute('aria-hidden', 'false');
    if (typeof onCloseChoiceOnEscape === 'function') {
      document.addEventListener('keydown', onCloseChoiceOnEscape);
    }
  }

  async function submitCloseChoice(action, options) {
    options = options || {};
    var api = options.api || null;
    var state = options.state || {};
    var onHideCloseChoiceOverlay = options.onHideCloseChoiceOverlay;
    var onSyncLiveSettingsWidgetsFromObject = options.onSyncLiveSettingsWidgetsFromObject;
    var onSaveLastSettingsSectionId = options.onSaveLastSettingsSectionId;
    var onRenderSettingsNav = options.onRenderSettingsNav;

    var remember = false;
    var rcb = document.getElementById('closeChoiceRemember');
    if (rcb) remember = !!rcb.checked;
    if (typeof onHideCloseChoiceOverlay === 'function') onHideCloseChoiceOverlay();
    if (action === 'cancel') return;
    if (!(api && api.has && api.has('resolveWindowClose'))) return;
    api.resolveWindowClose({
      action: action,
      saveDefault: remember,
      behavior: action === 'tray' ? 'tray' : 'quit',
    });
    if (remember) {
      try {
        var sMem = await api.getSettings();
        if (typeof onSyncLiveSettingsWidgetsFromObject === 'function')
          onSyncLiveSettingsWidgetsFromObject(sMem);
        if (typeof onSaveLastSettingsSectionId === 'function')
          onSaveLastSettingsSectionId('settingsSectionCloseBehavior');
        if (state.currentTab === 'settings' && typeof onRenderSettingsNav === 'function')
          onRenderSettingsNav('settingsSectionCloseBehavior');
      } catch (e2) {}
    }
  }

  global.RendererCloseChoiceUI = Object.assign({}, global.RendererCloseChoiceUI || {}, {
    closeChoiceOnEscape: closeChoiceOnEscape,
    hideCloseChoiceOverlay: hideCloseChoiceOverlay,
    showCloseChoiceOverlay: showCloseChoiceOverlay,
    submitCloseChoice: submitCloseChoice,
  });
})(window);
