const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photoAPI', {
  selectFolder: function () {
    return ipcRenderer.invoke('select-folder');
  },
  scanFolder: function (folderPath) {
    return ipcRenderer.invoke('scan-folder', folderPath);
  },
  getScanProgress: function () {
    return ipcRenderer.invoke('get-scan-progress');
  },
  cancelScan: function () {
    return ipcRenderer.invoke('cancel-scan');
  },
  pauseScan: function () {
    return ipcRenderer.invoke('pause-scan');
  },
  resumeScan: function () {
    return ipcRenderer.invoke('resume-scan');
  },
  getScanQueueStatus: function () {
    return ipcRenderer.invoke('get-scan-queue-status');
  },
  clearScanQueue: function () {
    return ipcRenderer.invoke('clear-scan-queue');
  },
  getStats: function () {
    return ipcRenderer.invoke('get-stats');
  },
  startThumbnailBackfill: function (limit) {
    return ipcRenderer.invoke('start-thumbnail-backfill', limit);
  },
  getThumbnailBackfillProgress: function () {
    return ipcRenderer.invoke('get-thumbnail-backfill-progress');
  },
  cancelThumbnailBackfill: function () {
    return ipcRenderer.invoke('cancel-thumbnail-backfill');
  },
  exportThumbnailBackfillFailedPaths: function () {
    return ipcRenderer.invoke('export-thumbnail-backfill-failed-paths');
  },
  maintenanceCleanupMissingFiles: function () {
    return ipcRenderer.invoke('maintenance-cleanup-missing-files');
  },
  maintenanceRebuildThumbnailFlags: function () {
    return ipcRenderer.invoke('maintenance-rebuild-thumbnail-flags');
  },
  maintenanceOptimizeDatabase: function () {
    return ipcRenderer.invoke('maintenance-optimize-database');
  },
  maintenanceStartDuplicateHashDetection: function () {
    return ipcRenderer.invoke('maintenance-start-duplicate-hash-detection');
  },
  maintenanceGetDuplicateHashProgress: function () {
    return ipcRenderer.invoke('maintenance-get-duplicate-hash-progress');
  },
  maintenanceCancelDuplicateHashDetection: function () {
    return ipcRenderer.invoke('maintenance-cancel-duplicate-hash-detection');
  },
  maintenanceGetDuplicateHashGroups: function (options) {
    return ipcRenderer.invoke('maintenance-get-duplicate-hash-groups', options);
  },
  maintenanceGetPhotosByFileHash: function (fileHash) {
    return ipcRenderer.invoke('maintenance-get-photos-by-file-hash', fileHash);
  },
  openDatabaseFolder: function () {
    return ipcRenderer.invoke('open-database-folder');
  },
  backupDatabase: function () {
    return ipcRenderer.invoke('backup-database');
  },
  exportRootFoldersJson: function () {
    return ipcRenderer.invoke('export-root-folders-json');
  },
  importRootFoldersJson: function () {
    return ipcRenderer.invoke('import-root-folders-json');
  },
  getBackgroundTasks: function () {
    return ipcRenderer.invoke('get-background-tasks');
  },
  onBackgroundTasksChanged: function (callback) {
    ipcRenderer.on('background-tasks-changed', function () {
      callback();
    });
  },
  photoMoveToTrash: function (photoId) {
    return ipcRenderer.invoke('photo-move-to-trash', photoId);
  },
  photoDeleteRecord: function (photoId) {
    return ipcRenderer.invoke('photo-delete-record', photoId);
  },
  photoToggleFavorite: function (photoId) {
    return ipcRenderer.invoke('photo-toggle-favorite', photoId);
  },
  showPhotoInFolder: function (photoId) {
    return ipcRenderer.invoke('show-photo-in-folder', photoId);
  },
  openPhotoExternal: function (photoId) {
    return ipcRenderer.invoke('open-photo-external', photoId);
  },
  getRootFolders: function (options) {
    return ipcRenderer.invoke('get-root-folders', options);
  },
  getFolderTree: function (rootId, options) {
    return ipcRenderer.invoke('get-folder-tree', rootId, options);
  },
  getFolderCovers: function (options) {
    return ipcRenderer.invoke('get-folder-covers', options);
  },
  getImmediateSubfolderCovers: function (parentPath, childPaths, options) {
    return ipcRenderer.invoke(
      'get-immediate-subfolder-covers',
      parentPath,
      childPaths,
      options || {},
    );
  },
  getPhotos: function (options) {
    return ipcRenderer.invoke('get-photos', options);
  },
  getFolderPhotos: function (folderPath, options) {
    return ipcRenderer.invoke('get-folder-photos', folderPath, options);
  },
  getDateGroups: function (options) {
    return ipcRenderer.invoke('get-date-groups', options);
  },
  getDatePhotos: function (dateStr, options) {
    return ipcRenderer.invoke('get-date-photos', dateStr, options);
  },
  getFullPhoto: function (photoId) {
    return ipcRenderer.invoke('get-full-photo', photoId);
  },
  searchPhotos: function (query, options) {
    return ipcRenderer.invoke('search-photos', query, options);
  },
  removeFolder: function (rootPath) {
    return ipcRenderer.invoke('remove-folder', rootPath);
  },
  rescanFolder: function (rootPath) {
    return ipcRenderer.invoke('rescan-folder', rootPath);
  },
  onTriggerScan: function (callback) {
    ipcRenderer.on('trigger-scan', function (event, folderPath) {
      callback(folderPath);
    });
  },
  onScanStart: function (callback) {
    ipcRenderer.on('scan-start', function () {
      callback();
    });
  },
  onScanComplete: function (callback) {
    ipcRenderer.on('scan-complete', function (event, folderPath, result) {
      callback(folderPath, result);
    });
  },
  // 设置
  getSettings: function () {
    return ipcRenderer.invoke('get-settings');
  },
  getPreviewAdjacentPhoto: function (options) {
    return ipcRenderer.invoke('get-preview-adjacent-photo', options);
  },
  getRandomPreviewPhotoBatch: function (options) {
    return ipcRenderer.invoke('get-random-preview-batch', options);
  },
  updateSettings: function (newSettings) {
    return ipcRenderer.invoke('update-settings', newSettings);
  },
  syncUiLocale: function () {
    return ipcRenderer.invoke('sync-ui-locale');
  },
  // Web 服务器
  getWebUrl: function () {
    return ipcRenderer.invoke('get-web-url');
  },
  webServerGetStatus: function () {
    return ipcRenderer.invoke('web-server-get-status');
  },
  webServerSetEnabled: function (enabled) {
    return ipcRenderer.invoke('web-server-set-enabled', enabled);
  },
  getWebLocalBaseUrl: function () {
    return ipcRenderer.invoke('get-web-local-base-url');
  },
  hlsStopSession: function (sessionId) {
    return ipcRenderer.invoke('hls-stop-session', sessionId);
  },
  tunnelGetStatus: function () {
    return ipcRenderer.invoke('tunnel-get-status');
  },
  tunnelSetEnabled: function (enabled) {
    return ipcRenderer.invoke('tunnel-set-enabled', enabled);
  },
  // 窗口控制
  minimizeWindow: function () {
    ipcRenderer.send('window-minimize');
  },
  maximizeWindow: function () {
    ipcRenderer.send('window-maximize');
  },
  /** 隐藏到系统托盘（主进程拦截关闭，窗口仍在运行） */
  closeWindow: function () {
    ipcRenderer.send('window-close');
  },
  toggleBackgroundWindow: function () {
    ipcRenderer.send('toggle-background-window');
  },
  quitAppCompletely: function () {
    ipcRenderer.send('quit-app-completely');
  },
  /** 侧栏目录树首屏渲染完成后再跑开机自动扫描等任务（主进程 runAutoStartupTasksOnce） */
  notifyBrowseUiReady: function () {
    ipcRenderer.send('notify-browse-ui-ready');
  },
  notifyPreviewPlaybackActive: function (active) {
    ipcRenderer.send('preview-playback-active', active === true);
  },
  isMaximized: function () {
    return ipcRenderer.invoke('window-is-maximized');
  },
  onWindowMaximizedChange: function (callback) {
    ipcRenderer.on('window-maximized-change', function (event, val) {
      callback(val);
    });
  },
  toggleDevTools: function () {
    ipcRenderer.send('toggle-devtools');
  },
  onWebServerUrl: function (callback) {
    ipcRenderer.on('web-server-url', function (event, url) {
      callback(url);
    });
  },
  onShowCloseChooser: function (callback) {
    ipcRenderer.on('show-close-chooser', function () {
      callback();
    });
  },
  resolveWindowClose: function (payload) {
    ipcRenderer.send('resolve-window-close', payload);
  },
});
