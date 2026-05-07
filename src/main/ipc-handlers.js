const logger = require('./logger');
const { ipcMain, dialog, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  getThumbnailBackfillProgress,
  getThumbnailBackfillFailedPathsForExport,
  cancelCurrentThumbnailBackfill,
  isThumbnailBackfillRunning,
  getDuplicateHashProgress,
  cancelCurrentDuplicateHash,
  isDuplicateHashRunning,
  getInvalidCleanupTaskProgress,
  isInvalidCleanupRunning,
  getScanQueueStatus,
  getWorkerScanProgress,
  terminateScanWorkerSilently,
  enqueueScanTask,
} = require('./task-scheduler');
const {
  cloneSettingsForIpc,
  saveSettings,
  reloadSettingsFromDiskSilently,
  ensureSettingsShape,
  validateHlsRuntime,
} = require('./settings');
const { shellTrashItemWithFallback, formatTrashFailureError } = require('./utils');

let mainWindowRef = null;
let quitCompletelyRef = null;
let showMainWindowRef = null;
let runAutoStartupTasksOnceRef = null;
let scheduleDeferredPhotoIndexesOnceRef = null;
let scheduleAutoThumbnailBackfillRef = null;
let startThumbnailBackfillJobRef = null;
let startDuplicateHashDetectionJobRef = null;
let startInvalidCleanupJobRef = null;
let startupStageLogRef = null;

function init(
  mainWindow,
  quitCompletely,
  showMainWindow,
  runAutoStartupTasksOnce,
  scheduleDeferredPhotoIndexesOnce,
  scheduleAutoThumbnailBackfill,
  startThumbnailBackfillJob,
  startDuplicateHashDetectionJob,
  startInvalidCleanupJob,
  startupStageLog,
) {
  mainWindowRef = mainWindow;
  quitCompletelyRef = quitCompletely;
  showMainWindowRef = showMainWindow;
  runAutoStartupTasksOnceRef = runAutoStartupTasksOnce;
  scheduleDeferredPhotoIndexesOnceRef = scheduleDeferredPhotoIndexesOnce;
  scheduleAutoThumbnailBackfillRef = scheduleAutoThumbnailBackfill;
  startThumbnailBackfillJobRef = startThumbnailBackfillJob;
  startDuplicateHashDetectionJobRef = startDuplicateHashDetectionJob;
  startInvalidCleanupJobRef = startInvalidCleanupJob;
  startupStageLogRef = startupStageLog;

  registerHandlers();
}

function registerHandlers() {
  let previewPlaybackActive = false;
  let browseUiReadyStartupTimer = null;

  ipcMain.on('notify-browse-ui-ready', function () {
    if (startupStageLogRef) startupStageLogRef('ipc.notify-browse-ui-ready');
    if (browseUiReadyStartupTimer) {
      clearTimeout(browseUiReadyStartupTimer);
      browseUiReadyStartupTimer = null;
    }
    /** 首屏目录渲染后再延迟启动自动任务，避免与 get-root-folders/get-folder-tree 抢 Worker 与磁盘 IO */
    browseUiReadyStartupTimer = setTimeout(function () {
      browseUiReadyStartupTimer = null;
      if (startupStageLogRef)
        startupStageLogRef('auto-startup.timer.fire', 'after notify-browse-ui-ready');
      if (runAutoStartupTasksOnceRef) runAutoStartupTasksOnceRef();
    }, 3500);
    if (scheduleDeferredPhotoIndexesOnceRef) scheduleDeferredPhotoIndexesOnceRef('browse-ui-ready');
  });

  ipcMain.on('preview-playback-active', function (event, active) {
    previewPlaybackActive = active === true;
  });

  ipcMain.on('toggle-devtools', function () {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
    if (mainWindowRef.webContents.isDevToolsOpened()) {
      mainWindowRef.webContents.closeDevTools();
    } else {
      mainWindowRef.webContents.openDevTools({ mode: 'detach' });
    }
  });

  ipcMain.on('toggle-background-window', function () {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
    if (mainWindowRef.isVisible()) mainWindowRef.hide();
    else if (showMainWindowRef) showMainWindowRef();
  });

  ipcMain.on('quit-app-completely', function () {
    if (quitCompletelyRef) quitCompletelyRef();
  });

  ipcMain.on('resolve-window-close', function (event, payload) {
    payload = payload || {};
    const main = require('../main');
    if (payload.saveDefault && (payload.behavior === 'tray' || payload.behavior === 'quit')) {
      main.settings.windowCloseBehavior = payload.behavior;
      ensureSettingsShape(main.settings);
      saveSettings(main.settingsFilePath, main.settings);
    }
    if (payload.doQuit) {
      if (quitCompletelyRef) quitCompletelyRef();
    } else {
      if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.hide();
    }
  });

  ipcMain.handle('get-settings', function () {
    const main = require('../main');
    reloadSettingsFromDiskSilently(main.settingsFilePath, main.settings);
    return cloneSettingsForIpc(main.settings);
  });

  ipcMain.handle('save-settings', function (event, newSettings) {
    const main = require('../main');
    if (!newSettings || typeof newSettings !== 'object') return { ok: false };
    main.settings = Object.assign(main.settings, newSettings);
    ensureSettingsShape(main.settings);
    saveSettings(main.settingsFilePath, main.settings);
    // 更新开机自启设置
    if (
      typeof newSettings.startOnBoot === 'boolean' ||
      typeof newSettings.silentStart === 'boolean'
    ) {
      app.setLoginItemSettings({
        openAtLogin: main.settings.startOnBoot,
        openAsHidden: main.settings.silentStart,
        args: [],
      });
    }
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('settings-changed', cloneSettingsForIpc(main.settings));
    }
    return { ok: true };
  });

  ipcMain.handle('select-root-folder', async function () {
    const result = await dialog.showOpenDialog(mainWindowRef, {
      properties: ['openDirectory'],
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('select-file-ffmpeg', async function () {
    const result = await dialog.showOpenDialog(mainWindowRef, {
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe', ''] }],
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('validate-ffmpeg-hls-setting', function (event, ffmpegPath, hlsRootDir) {
    return validateHlsRuntime(ffmpegPath, hlsRootDir);
  });

  ipcMain.handle('get-app-version', function () {
    return require('../package.json').version;
  });

  ipcMain.handle('get-scan-status', function () {
    return {
      queue: getScanQueueStatus(),
      progress: getWorkerScanProgress(),
    };
  });

  ipcMain.on('cancel-current-scan', function () {
    terminateScanWorkerSilently();
  });

  ipcMain.handle('enqueue-scan-task', function (event, task) {
    return enqueueScanTask(task);
  });

  ipcMain.handle('get-backfill-progress', function () {
    return getThumbnailBackfillProgress();
  });

  ipcMain.handle('get-backfill-failed-paths', function () {
    return getThumbnailBackfillFailedPathsForExport();
  });

  ipcMain.on('cancel-backfill', function () {
    cancelCurrentThumbnailBackfill();
  });

  ipcMain.handle('start-backfill', function () {
    if (isThumbnailBackfillRunning()) return { ok: false, error: 'already running' };
    if (startThumbnailBackfillJobRef) {
      startThumbnailBackfillJobRef();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('get-duplicate-hash-progress', function () {
    return getDuplicateHashProgress();
  });

  ipcMain.on('cancel-duplicate-hash', function () {
    cancelCurrentDuplicateHash();
  });

  ipcMain.handle('start-duplicate-hash', function () {
    if (isDuplicateHashRunning()) return { ok: false, error: 'already running' };
    if (startDuplicateHashDetectionJobRef) {
      startDuplicateHashDetectionJobRef();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('get-invalid-cleanup-progress', function () {
    return getInvalidCleanupTaskProgress();
  });

  ipcMain.on('cancel-invalid-cleanup', function () {
    // handled in main loop via the cancelled flag
  });

  ipcMain.handle('start-invalid-cleanup', function () {
    if (isInvalidCleanupRunning()) return { ok: false, error: 'already running' };
    if (startInvalidCleanupJobRef) {
      startInvalidCleanupJobRef();
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('start-auto-backfill-if-allowed', function () {
    if (isThumbnailBackfillRunning()) return { running: true };
    if (getScanQueueStatus().processing) return { pendingQueue: true };
    if (scheduleAutoThumbnailBackfillRef) scheduleAutoThumbnailBackfillRef();
    return { started: true };
  });

  ipcMain.handle('move-files-to-trash', async function (event, absPathsArr) {
    const main = require('../main');
    if (!Array.isArray(absPathsArr) || !absPathsArr.length) {
      return { ok: true, failed: [] };
    }
    const failed = [];
    for (var i = 0; i < absPathsArr.length; i++) {
      const p = absPathsArr[i];
      try {
        await shellTrashItemWithFallback(p);
      } catch (e) {
        failed.push({ path: p, error: formatTrashFailureError(e) });
      }
    }
    if (main.db && failed.length === absPathsArr.length) {
      // all failed, no need to invalidate cache
    } else {
      //新增根目录会影响根列表缓存；先按全量兜底失效。
      if (main.invalidateCatalogCachesSafe) main.invalidateCatalogCachesSafe();
    }
    return { ok: true, failed: failed };
  });

  ipcMain.handle('export-db-backup', async function (event, destPath) {
    const main = require('../main');
    if (!main.db) return { ok: false, error: 'db not ready' };
    try {
      main.db.backupToPath(destPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('run-db-vacuum', async function () {
    const main = require('../main');
    if (!main.db) return { ok: false, error: 'db not ready' };
    try {
      main.db.vacuum();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('get-file-contents-local', async function (event, absPath) {
    if (!absPath || typeof absPath !== 'string') return { ok: false };
    try {
      if (!fs.existsSync(absPath)) return { ok: false };
      const content = fs.readFileSync(absPath, 'utf8');
      return { ok: true, content: content };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('write-file-contents-local', async function (event, absPath, content) {
    if (!absPath || typeof absPath !== 'string') return { ok: false };
    try {
      fs.writeFileSync(absPath, content, 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('open-path-in-file-manager', async function (event, absPath) {
    if (!absPath || typeof absPath !== 'string') return;
    try {
      shell.showItemInFolder(absPath);
    } catch (e) {
      logger.error('[open-path-in-file-manager] failed:', e);
    }
  });

  ipcMain.handle('open-external-url', async function (event, url) {
    if (!url || typeof url !== 'string') return;
    try {
      shell.openExternal(url);
    } catch (e) {
      logger.error('[open-external-url] failed:', e);
    }
  });

  // 菜单：添加文件夹
  ipcMain.on('menu-add-folder', function () {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (!mainWindowRef.isVisible()) mainWindowRef.show();
      mainWindowRef.focus();
      mainWindowRef.webContents.send('trigger-menu-add-folder');
    }
  });

  // 窗口控制
  ipcMain.on('menu-show-main-window', function () {
    if (showMainWindowRef) showMainWindowRef();
  });

  // Web 服务器地址（渲染进程主动查询）
  ipcMain.handle('get-web-server-listen-info', function () {
    const main = require('../main');
    if (!main.webServer) {
      return { running: false };
    }
    const info = main.webServer.getListenInfo();
    const urls = [];
    if (info && info.addresses) {
      info.addresses.forEach(function (a) {
        urls.push((info.useHttps ? 'https://' : 'http://') + a.address + ':' + info.port);
      });
    }
    return {
      running: true,
      urls: urls,
      port: info.port,
    };
  });

  // 设置相关
  ipcMain.on('settings-web-password-updated', function (event, newPassword) {
    const main = require('../main');
    // 同步 web 密码
    if (!main.webServer) return;
    main.settings.webPassword = newPassword ? String(newPassword).trim() : '';
    main.webServer.updatePassword(main.settings.webPassword);
  });

  ipcMain.on('update-boot-startup-setting', function (event, enabled) {
    const { app } = require('electron');
    enabled = !!enabled;
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  });

  // 扫描完成通知
  ipcMain.on('trigger-scan', function () {}); // 避免未注册 warning
}

module.exports = {
  init,
};
