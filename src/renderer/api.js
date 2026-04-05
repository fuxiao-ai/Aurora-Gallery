(function (global) {
  function backend() {
    return global.photoAPI || {};
  }

  function call(name) {
    var b = backend();
    var fn = b[name];
    if (typeof fn !== 'function') {
      return Promise.reject(new Error('photoAPI method unavailable: ' + name));
    }
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      return Promise.resolve(fn.apply(b, args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function has(name) {
    var b = backend();
    return typeof b[name] === 'function';
  }

  function on(name, handler) {
    if (!has(name)) return;
    backend()[name](handler);
  }

  function invoke(name) {
    if (!has(name)) return;
    var args = Array.prototype.slice.call(arguments, 1);
    return backend()[name].apply(backend(), args);
  }

  global.RendererApi = Object.assign({}, global.RendererApi || {}, {
    backend: backend,
    call: call,
    has: has,
    on: on,
    invoke: invoke,
    selectFolder: function () {
      return call('selectFolder');
    },
    scanFolder: function (folderPath) {
      return call('scanFolder', folderPath);
    },
    cancelScan: function () {
      return call('cancelScan');
    },
    pauseScan: function () {
      return call('pauseScan');
    },
    resumeScan: function () {
      return call('resumeScan');
    },
    getRootFolders: function (options) {
      return call('getRootFolders', options);
    },
    getStats: function () {
      return call('getStats');
    },
    updateSettings: function (patch) {
      return call('updateSettings', patch);
    },
    searchPhotos: function (keyword, options) {
      return call('searchPhotos', keyword, options);
    },
    getPhotos: function (options) {
      return call('getPhotos', options);
    },
    getFolderPhotos: function (path, options) {
      return call('getFolderPhotos', path, options);
    },
    getDatePhotos: function (dateStr, options) {
      return call('getDatePhotos', dateStr, options);
    },
    getFolderCovers: function (options) {
      return call('getFolderCovers', options);
    },
    getImmediateSubfolderCovers: function (parentPath, childPaths, options) {
      return call('getImmediateSubfolderCovers', parentPath, childPaths, options || {});
    },
    getFolderTree: function (rootId, options) {
      return call('getFolderTree', rootId, options);
    },
    getDateGroups: function (options) {
      return call('getDateGroups', options);
    },
    rescanFolder: function (rootPath) {
      return call('rescanFolder', rootPath);
    },
    removeFolder: function (rootPath) {
      return call('removeFolder', rootPath);
    },
    getBackgroundTasks: function () {
      return call('getBackgroundTasks');
    },
    resolveWindowClose: function (payload) {
      return call('resolveWindowClose', payload);
    },
    getSettings: function () {
      return call('getSettings');
    },
    getPreviewAdjacentPhoto: function (options) {
      return call('getPreviewAdjacentPhoto', options);
    },
    getRandomPreviewPhotoBatch: function (options) {
      return call('getRandomPreviewPhotoBatch', options);
    },
    getWebUrl: function () {
      return call('getWebUrl');
    },
    getWebLocalBaseUrl: function () {
      return call('getWebLocalBaseUrl');
    },
    hlsStopSession: function (sessionId) {
      return call('hlsStopSession', sessionId);
    },
    minimizeWindow: function () {
      return invoke('minimizeWindow');
    },
    maximizeWindow: function () {
      return invoke('maximizeWindow');
    },
    isMaximized: function () {
      return invoke('isMaximized');
    },
    closeWindow: function () {
      return invoke('closeWindow');
    },
    onWindowMaximizedChange: function (handler) {
      return on('onWindowMaximizedChange', handler);
    },
    onShowCloseChooser: function (handler) {
      return on('onShowCloseChooser', handler);
    },
    onBackgroundTasksChanged: function (handler) {
      return on('onBackgroundTasksChanged', handler);
    },
    onTriggerScan: function (handler) {
      return on('onTriggerScan', handler);
    },
    onScanStart: function (handler) {
      return on('onScanStart', handler);
    },
    onScanComplete: function (handler) {
      return on('onScanComplete', handler);
    },
    getThumbnailBackfillProgress: function () {
      return call('getThumbnailBackfillProgress');
    },
    startThumbnailBackfill: function () {
      return call('startThumbnailBackfill');
    },
    cancelThumbnailBackfill: function () {
      return call('cancelThumbnailBackfill');
    },
    exportThumbnailBackfillFailedPaths: function () {
      return call('exportThumbnailBackfillFailedPaths');
    },
    maintenanceCleanupMissingFiles: function () {
      return call('maintenanceCleanupMissingFiles');
    },
    maintenanceRebuildThumbnailFlags: function () {
      return call('maintenanceRebuildThumbnailFlags');
    },
    maintenanceOptimizeDatabase: function () {
      return call('maintenanceOptimizeDatabase');
    },
    backupDatabase: function () {
      return call('backupDatabase');
    },
    maintenanceGetDuplicateHashProgress: function () {
      return call('maintenanceGetDuplicateHashProgress');
    },
    maintenanceStartDuplicateHashDetection: function () {
      return call('maintenanceStartDuplicateHashDetection');
    },
    maintenanceCancelDuplicateHashDetection: function () {
      return call('maintenanceCancelDuplicateHashDetection');
    },
    exportRootFoldersJson: function () {
      return call('exportRootFoldersJson');
    },
    importRootFoldersJson: function () {
      return call('importRootFoldersJson');
    },
    tunnelGetStatus: function () {
      return call('tunnelGetStatus');
    },
    tunnelSetEnabled: function (enabled) {
      return call('tunnelSetEnabled', enabled);
    },
    webServerGetStatus: function () {
      return call('webServerGetStatus');
    },
    webServerSetEnabled: function (enabled) {
      return call('webServerSetEnabled', enabled);
    },
    maintenanceGetDuplicateHashGroups: function (payload) {
      return call('maintenanceGetDuplicateHashGroups', payload);
    },
    maintenanceGetPhotosByFileHash: function (hash) {
      return call('maintenanceGetPhotosByFileHash', hash);
    },
    photoMoveToTrash: function (photoId) {
      return call('photoMoveToTrash', photoId);
    },
    photoDeleteRecord: function (photoId) {
      return call('photoDeleteRecord', photoId);
    },
    openDatabaseFolder: function () {
      return call('openDatabaseFolder');
    },
    photoToggleFavorite: function (photoId) {
      return call('photoToggleFavorite', photoId);
    },
    showPhotoInFolder: function (photoId) {
      return call('showPhotoInFolder', photoId);
    },
    openPhotoExternal: function (photoId) {
      return call('openPhotoExternal', photoId);
    },
    toggleBackgroundWindow: function () {
      return invoke('toggleBackgroundWindow');
    },
    quitAppCompletely: function () {
      return invoke('quitAppCompletely');
    },
    notifyBrowseUiReady: function () {
      return invoke('notifyBrowseUiReady');
    },
    notifyPreviewPlaybackActive: function (active) {
      return invoke('notifyPreviewPlaybackActive', active === true);
    },
    toggleDevTools: function () {
      return invoke('toggleDevTools');
    },
  });
})(window);
