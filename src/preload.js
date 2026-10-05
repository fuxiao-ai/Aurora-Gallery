const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photoAPI', {
  beginBrowseRequest: function (sequence) {
    ipcRenderer.send('begin-browse-request', sequence);
  },
  notifyBrowsePhotosReady: function () {
    ipcRenderer.send('notify-browse-photos-ready');
  },
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
  maintenanceGetSimilarDhashGroups: function (options) {
    return ipcRenderer.invoke('maintenance-get-similar-dhash-groups', options);
  },
  maintenanceGetPhotosByDhash: function (dhash) {
    return ipcRenderer.invoke('maintenance-get-photos-by-dhash', dhash);
  },
  maintenanceFindSimilarPhotos: function (options) {
    return ipcRenderer.invoke('maintenance-find-similar-photos', options);
  },
  maintenanceGetPhotosByIds: function (ids) {
    return ipcRenderer.invoke('maintenance-get-photos-by-ids', ids);
  },
  openDatabaseFolder: function () {
    return ipcRenderer.invoke('open-database-folder');
  },
  backupDatabase: function () {
    return ipcRenderer.invoke('backup-database');
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
  getPhotoInfo: function (photoId) {
    return ipcRenderer.invoke('get-photo-info', photoId);
  },
  getPhotoDimensions: function (photoId) {
    return ipcRenderer.invoke('get-photo-dimensions', photoId);
  },
  /**
   * 「AI 内容标签」。独立于 getPhotoInfo 的一条路 —— 标签在搜图索引库里而不是 photos 表，
   * 所以渲染端要把它与 getPhotoInfo / getPhotoDimensions 的两次结果**并进同一个对象**
   * 再重画（见 app.js 的 patchInfo），不能各画各的。
   */
  getPhotoAiTags: function (photoId, locale) {
    return ipcRenderer.invoke('get-photo-ai-tags', photoId, locale);
  },
  /**
   * 主进程**补写** AI 标签（启动期回填）并真的补到了才会推这个通道 —— 没有新标签时不推。
   * 标签不在 `photos` 表里、也没有别的推送路径，所以不接这个通知就只能等用户手动切图。
   */
  onAiTagsUpdated: function (callback) {
    ipcRenderer.on('ai-tags-updated', function () {
      callback();
    });
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
  aiSearchStatus: function () {
    return ipcRenderer.invoke('ai-search-status');
  },
  aiSearchInstall: function () {
    return ipcRenderer.invoke('ai-search-install');
  },
  aiSearchIndex: function () {
    return ipcRenderer.invoke('ai-search-index');
  },
  aiSearchCancel: function () {
    return ipcRenderer.invoke('ai-search-cancel');
  },
  aiSearchQuery: function (query) {
    return ipcRenderer.invoke('ai-search-query', query);
  },
  // 预选词：传 `{ lang, limit }` 让主进程从服务端词表里按真实命中数挑；
  // 传数组（老形状）则只给那几个词打分。
  aiSearchSuggest: function (request) {
    return ipcRenderer.invoke('ai-search-suggest', request);
  },
  faceAction: function (operation, args) {
    return ipcRenderer.invoke('face-action', operation, args);
  },
  removeFolder: function (rootPath) {
    return ipcRenderer.invoke('remove-folder', rootPath);
  },
  rescanFolder: function (rootPath) {
    return ipcRenderer.invoke('rescan-folder', rootPath);
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
  onShowCloseChooser: function (callback) {
    ipcRenderer.on('show-close-chooser', function () {
      callback();
    });
  },
  resolveWindowClose: function (payload) {
    ipcRenderer.send('resolve-window-close', payload);
  },
  getAppVersion: function () {
    return ipcRenderer.invoke('get-app-version');
  },
});
