const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photoAPI', {
  beginBrowseRequest: function (sequence) {
    ipcRenderer.send('begin-browse-request', sequence);
  },
  notifyBrowsePhotosReady: function () {
    ipcRenderer.send('notify-browse-photos-ready');
  },
  /**
   * 启动阶段上报：白名单 = 主进程的 `RENDERER_STARTUP_STAGES`
   * （'init.enter' / 'settings.done' / 'rootFolders.done' / 'landing.done'）。
   * 只写启动指标、无副作用；不在白名单里的名字主进程直接丢弃。
   */
  notifyStartupStage: function (stage) {
    ipcRenderer.send('notify-startup-stage', stage);
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
  // 缩略图「全量重建」（把规格与当前设置不符的缩略图按新档位 / 新编码重跑一遍）
  startThumbnailRebuild: function () {
    return ipcRenderer.invoke('start-thumbnail-rebuild');
  },
  cancelThumbnailRebuild: function () {
    return ipcRenderer.invoke('cancel-thumbnail-rebuild');
  },
  getThumbnailRebuildProgress: function () {
    return ipcRenderer.invoke('get-thumbnail-rebuild-progress');
  },
  getThumbnailRebuildStatus: function () {
    return ipcRenderer.invoke('get-thumbnail-rebuild-status');
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
  /** 设置页「数据库位置」那一行的读数：位置 / 体积 / 目标盘余量。 */
  getDataDirInfo: function () {
    return ipcRenderer.invoke('get-data-dir-info');
  },
  /** 挑一个文件夹当新的数据目录（只挑，不搬）。 */
  selectDataDir: function (options) {
    return ipcRenderer.invoke('select-data-dir', options || null);
  },
  /**
   * 把图库数据整份搬到新目录。耗时按 GB 计，进度走 `onDataDirMigrateProgress`；
   * 成功后主进程会**重启应用**（1.5 秒后），调用方要把这句提示给用户。
   */
  migrateDataDir: function (payload) {
    return ipcRenderer.invoke('migrate-data-dir', payload);
  },
  onDataDirMigrateProgress: function (callback) {
    ipcRenderer.on('data-dir-migrate-progress', function (event, payload) {
      callback(payload);
    });
  },
  backupDatabase: function () {
    return ipcRenderer.invoke('backup-database');
  },
  getBackgroundTasks: function () {
    return ipcRenderer.invoke('get-background-tasks');
  },
  // 诊断数据（上次维护结果 / 交互抢占 / 写库队列快照）—— **不是后台任务**，见
  // `docs/contracts/background-tasks.md` §0。与任务分开一个通道，别混。
  getDiagnostics: function () {
    return ipcRenderer.invoke('get-diagnostics');
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
  /**
   * 组织元数据：评分 / 标记 / 用户标签。三个维度彼此独立，不要合成一个「设置元数据」
   * 的胖接口 —— 冲片时一次只动一个维度（左手按 X 过片、按 1-5 打分），合起来会让
   * 「按了一下」发一整包，网络/序列化成本乘以维度数。
   *
   * 🔴 `photoSetFlag` 与 `photoToggleFavorite` **语义不同**：收藏是 toggle（传 id 就翻转），
   *    标记是**幂等设值**（传什么就是什么）。冲片是盲操作，toggle 会把「以为没按上、
   *    又按一次」变成误清。理由详见 `database.js#setPhotoFlag` 与
   *    `docs/contracts/org-metadata.md`。
   *
   * 四个写通道都返回 `{ success, ... }`，渲染端**必须**看 `success` 再更新本地状态，
   * 并整体替换（而不是增量改）—— 标签是「全量替换」语义，回包才是真正的最终集合。
   */
  /** 设评分。`rating` 0 = 取消，1-5 = 星级；越界由主进程夹取。 */
  photoSetRating: function (photoId, rating) {
    return ipcRenderer.invoke('photo-set-rating', photoId, rating);
  },
  /** 设标记。`flag` ∈ 'none' | 'pick' | 'reject'；非法值回落 'none'。**幂等**。 */
  photoSetFlag: function (photoId, flag) {
    return ipcRenderer.invoke('photo-set-flag', photoId, flag);
  },
  /** 读某张图的用户标签（`[{id, name}]`，按名字不区分大小写排序）。 */
  photoGetTags: function (photoId) {
    return ipcRenderer.invoke('photo-get-tags', photoId);
  },
  /** **全量替换**某张图的标签集合。不存在的标签自动创建；返回最终集合。 */
  photoSetTags: function (photoId, names) {
    return ipcRenderer.invoke('photo-set-tags', photoId, names);
  },
  /** 标签列表 + 使用计数（`[{id, name, photo_count}]`，按使用量降序）。 */
  listTags: function () {
    return ipcRenderer.invoke('list-tags');
  },
  /** 重命名标签；归一后撞名会**合并**（返回的 id 可能是目标标签的 id，以返回值为准）。 */
  renameTag: function (tagId, newName) {
    return ipcRenderer.invoke('rename-tag', tagId, newName);
  },
  /** 删除标签（连同它的全部关联）。 */
  deleteTag: function (tagId) {
    return ipcRenderer.invoke('delete-tag', tagId);
  },
  /**
   * 图片编辑（P0）：旋转 / 翻转，**写回原文件**。
   *
   * `actions` 是**一串**动作（按顺序应用）：预览态编辑把用户连点的动作攒成序列，
   * 保存时合成一条算子 —— 只编码一次，天画质不会因为多点了两次而多掉一代。
   *
   * 返回 `{ success, id, width, height, size }` —— `width`/`height` 是**输出文件**的真实尺寸。
   * 🔴 渲染端不要自己推算新尺寸（90/270 对调 + 翻转 + EXIF 方向归一化，组合有十几种）。
   */
  photoEditTransform: function (photoId, actions) {
    return ipcRenderer.invoke('photo-edit-transform', photoId, actions);
  },
  /** 图片编辑（P1）：裁剪并另存副本（进库）。`rect` 用「用户看到的图」的坐标系。 */
  photoEditCrop: function (photoId, rect) {
    return ipcRenderer.invoke('photo-edit-crop', photoId, rect);
  },
  /**
   * 图片编辑：一次性应用「一串变换 + 一个裁剪」（预览态点「保存」的唯一入口）。
   * `payload` = `{ actions?: string[], crop?: {left,top,width,height}|null }`。
   */
  photoEditApply: function (photoId, payload) {
    return ipcRenderer.invoke('photo-edit-apply', photoId, payload);
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
   * 「主题标签」。独立于 getPhotoInfo 的一条路 —— 标签在搜图索引库里而不是 photos 表，
   * 所以渲染端要把它与 getPhotoInfo / getPhotoDimensions 的两次结果**并进同一个对象**
   * 再重画（见 app.js 的 patchInfo），不能各画各的。
   */
  getPhotoAiTags: function (photoId, locale) {
    return ipcRenderer.invoke('get-photo-ai-tags', photoId, locale);
  },
  /**
   * 「画面标签」（JoyTag）。与 getPhotoAiTags 同构的跨库只读通道 —— 标签在 tag 索引库
   * （tag-index.sqlite）里，同样要并进同一个对象再重画（见 app.js 的 patchInfo）。
   * 中文映射在主进程通道内做，渲染端拿到的已是显示文本。
   */
  getPhotoJoyTags: function (photoId, locale) {
    return ipcRenderer.invoke('get-photo-joy-tags', photoId, locale);
  },
  /**
   * 「标签导航页」—— 分类树 / 节点下的标签 / 搜索 / 某标签下的照片。
   *
   * 四条独立通道而不是一条大接口：树的节点是**懒展开**的（三级树每次只展开一层），
   * 合成一条会让「展开一个子类」也把整棵树重算一遍，而节点命中数是要查倒排的。
   */
  getTagNavStatus: function () {
    return ipcRenderer.invoke('get-tag-nav-status');
  },
  getTagNavTree: function () {
    return ipcRenderer.invoke('get-tag-nav-tree');
  },
  getTagNavNode: function (nodeId, locale) {
    return ipcRenderer.invoke('get-tag-nav-node', nodeId, locale);
  },
  getTagNavSearch: function (keyword, locale) {
    return ipcRenderer.invoke('get-tag-nav-search', keyword, locale);
  },
  getTagNavPhotos: function (tag, options) {
    return ipcRenderer.invoke('get-tag-nav-photos', tag, options);
  },
  /**
   * 主进程**补写** 主题标签（启动期回填）并真的补到了才会推这个通道 —— 没有新标签时不推。
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
  searchFolders: function (query, options) {
    return ipcRenderer.invoke('search-folders', query, options);
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
  rescanAllFolders: function () {
    return ipcRenderer.invoke('rescan-all-folders');
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
  /**
   * 主进程发起的提示 / 确认（主进程没有界面 ⇒ 弹窗一律由渲染端画，才会跟主题走）。
   * 收到后必须调 `respondAppDialog` 回执，否则主进程会等满 20 秒再回落到系统弹窗。
   */
  onAppDialogRequest: function (callback) {
    ipcRenderer.on('app-dialog-request', function (event, payload) {
      callback(payload);
    });
  },
  respondAppDialog: function (payload) {
    ipcRenderer.send('app-dialog-response', payload);
  },
  resolveWindowClose: function (payload) {
    ipcRenderer.send('resolve-window-close', payload);
  },
  getAppVersion: function () {
    return ipcRenderer.invoke('get-app-version');
  },
});
