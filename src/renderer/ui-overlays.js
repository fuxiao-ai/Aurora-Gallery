(function (global) {
  'use strict';

  // ===== dialog-ui.js =====
  var appDialogQueue = Promise.resolve();
  /** 当前在显示的弹窗的「取消」—— 被下一个弹窗顶掉时必须**结算**它，不能只做清理 */
  var activeAppDialogCancel = null;

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
        window.removeEventListener('keydown', onKeydown, true);
        overlay.removeEventListener('click', onOverlayClick);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
        activeAppDialogCancel = null;
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
      function onOverlayClick(e) {
        // 只认「点在遮罩自己身上」。
        // ⚠️ 这一条是**冗余的第二道**，不是修 bug：卡片那一层早就由 ui-events.js 给
        //    `.app-dialog-card` 挂了 `stopPropagation`，所以点标题/正文**本来就不会**被当成
        //    点遮罩（2026-10-05 探针实测确认，close-choice-dialog 同样处理）。保留它的理由是
        //    不依赖另一个模块的监听，且与 close-choice-overlay 判断写法一致
        //    （ui-events.js 的 `e.target === closeChoiceOverlay`）。
        if (e.target !== overlay) return;
        onCancel();
      }
      function onKeydown(e) {
        if (!overlay.classList.contains('show')) return;
        // 🔴 挂 window + 捕获阶段，并吞掉后续传播。遮罩只挡得住**指针**：预览 / 导航 / 路径栏 /
        // 关闭选项的键盘监听**全都挂在 document（bubble）**上，且没有任何一个模块检查「弹窗是否
        // 打开」。不吞的话弹窗形同虚设：预览里按 Delete 会经 appDialogQueue 再排一个删除确认
        // （读的是同一张照片，确认后必然报「照片记录不存在」）、一个 Esc 会**同时**取消弹窗并
        // 关掉预览。window 捕获是本页最早的一站，挂这里可一次性盖住全部既有与将来的 document 级
        // 监听；同时**不许**有别的模块也往 window 捕获阶段挂 keydown（会排在本监听之前）。
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          // 回车跟随焦点：confirm 的焦点默认落在「取消」（见下方 setTimeout），
          // 此时按回车若仍走「确定」，对删除这类不可逆操作就是个陷阱 —— 焦点环明明在取消上。
          e.preventDefault();
          if (document.activeElement === cancelBtn) onCancel();
          else onOk();
        }
      }

      // 顶掉上一个弹窗：必须让它**结算**（confirm → false）而不是只 cleanup。只清理不结算的话
      // 上一个 promise 永久悬挂，而 `appAlert`/`appConfirm` 都挂在同一条 appDialogQueue 上 ——
      // 队列会就此卡死，之后**所有** alert/confirm 静默不再弹出（app.js 的 _showAppDialog 是
      // 唯一能绕过队列直接开弹窗的入口，目前无人调用，但这条路径一旦被启用就是这个后果）。
      if (activeAppDialogCancel) activeAppDialogCancel();
      activeAppDialogCancel = onCancel;
      titleEl.textContent = title;
      msgEl.textContent = message;
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;
      cancelBtn.style.display = mode === 'confirm' ? '' : 'none';
      actionsEl.style.justifyContent = mode === 'confirm' ? 'flex-end' : 'center';
      overlay.setAttribute('aria-hidden', 'false');
      overlay.classList.add('show');

      window.addEventListener('keydown', onKeydown, true);
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
          onSaveLastSettingsSectionId('settingsSectionAppearance');
        if (state.currentTab === 'settings' && typeof onRenderSettingsNav === 'function')
          onRenderSettingsNav('settingsSectionAppearance');
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
