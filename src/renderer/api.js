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
    searchFolders: function (keyword, options) {
      return call('searchFolders', keyword, options);
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
    // ===== 标签导航页 =====
    // ⚠️ 这里的名字是 **preload 导出的方法名**（`getTagNavStatus`），不是 IPC 频道名
    // （`get-tag-nav-status`）—— `call()` 是 `photoAPI[name]` 直接索引，写成频道名会
    // 拿到 undefined，`has()` 恒 false、映射静默失效（`module-reachability-regression` 会红）。
    // 前四条只碰 tag 索引库，第五条跨库（tag 库给有序 id、主库给照片行，组合在主进程做）。
    getTagNavStatus: function () {
      return call('getTagNavStatus');
    },
    getTagNavTree: function () {
      return call('getTagNavTree');
    },
    getTagNavNode: function (nodeId, locale) {
      return call('getTagNavNode', nodeId, locale);
    },
    getTagNavSearch: function (keyword, locale) {
      return call('getTagNavSearch', keyword, locale);
    },
    getTagNavPhotos: function (tag, options) {
      return call('getTagNavPhotos', tag, options);
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
    rescanAllFolders: function () {
      return call('rescanAllFolders');
    },
    removeFolder: function (rootPath) {
      return call('removeFolder', rootPath);
    },
    getBackgroundTasks: function () {
      return call('getBackgroundTasks');
    },
    // 诊断数据（维护结果 / 交互抢占 / 写库队列快照）—— **不是后台任务**。
    getDiagnostics: function () {
      return call('getDiagnostics');
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
    onScanStart: function (handler) {
      return on('onScanStart', handler);
    },
    onScanComplete: function (handler) {
      return on('onScanComplete', handler);
    },
    onAiTagsUpdated: function (handler) {
      return on('onAiTagsUpdated', handler);
    },
    onDataDirMigrateProgress: function (handler) {
      return on('onDataDirMigrateProgress', handler);
    },
    onAppDialogRequest: function (handler) {
      return on('onAppDialogRequest', handler);
    },
    respondAppDialog: function (payload) {
      return invoke('respondAppDialog', payload);
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
    // 缩略图「全量重建」（规格与当前设置不符的缩略图重跑一遍）
    getThumbnailRebuildProgress: function () {
      return call('getThumbnailRebuildProgress');
    },
    getThumbnailRebuildStatus: function () {
      return call('getThumbnailRebuildStatus');
    },
    startThumbnailRebuild: function () {
      return call('startThumbnailRebuild');
    },
    cancelThumbnailRebuild: function () {
      return call('cancelThumbnailRebuild');
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
    maintenanceGetSimilarDhashGroups: function (payload) {
      return call('maintenanceGetSimilarDhashGroups', payload);
    },
    maintenanceGetPhotosByDhash: function (dhash) {
      return call('maintenanceGetPhotosByDhash', dhash);
    },
    maintenanceFindSimilarPhotos: function (payload) {
      return call('maintenanceFindSimilarPhotos', payload);
    },
    maintenanceGetPhotosByIds: function (ids) {
      return call('maintenanceGetPhotosByIds', ids);
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
    getDataDirInfo: function () {
      return call('getDataDirInfo');
    },
    selectDataDir: function (options) {
      return call('selectDataDir', options);
    },
    migrateDataDir: function (payload) {
      return call('migrateDataDir', payload);
    },
    photoToggleFavorite: function (photoId) {
      return call('photoToggleFavorite', photoId);
    },
    // 组织元数据（评分 / 标记 / 用户标签）。⚠️ `photoSetFlag` 是**幂等设值**，
    // 与上面的 `photoToggleFavorite`（翻转）语义不同 —— 别照抄调用方式。
    photoSetRating: function (photoId, rating) {
      return call('photoSetRating', photoId, rating);
    },
    photoSetFlag: function (photoId, flag) {
      return call('photoSetFlag', photoId, flag);
    },
    photoGetTags: function (photoId) {
      return call('photoGetTags', photoId);
    },
    photoSetTags: function (photoId, names) {
      return call('photoSetTags', photoId, names);
    },
    listTags: function () {
      return call('listTags');
    },
    renameTag: function (tagId, newName) {
      return call('renameTag', tagId, newName);
    },
    deleteTag: function (tagId) {
      return call('deleteTag', tagId);
    },
    photoEditTransform: function (photoId, actions) {
      return call('photoEditTransform', photoId, actions);
    },
    photoEditCrop: function (photoId, rect) {
      return call('photoEditCrop', photoId, rect);
    },
    photoEditApply: function (photoId, payload) {
      return call('photoEditApply', photoId, payload);
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
    /** 启动阶段上报（只记指标）：名字白名单 = 主进程 `RENDERER_STARTUP_STAGES` */
    notifyStartupStage: function (stage) {
      return invoke('notifyStartupStage', stage);
    },
    notifyPreviewPlaybackActive: function (active) {
      return invoke('notifyPreviewPlaybackActive', active === true);
    },
    toggleDevTools: function () {
      return invoke('toggleDevTools');
    },
  });
})(window);
