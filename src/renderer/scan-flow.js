(function (global) {
  /**
   * 取词条。优先走 i18n，**取不到才回落到兜底中文**。
   *
   * ⚠️ 必须判 `s !== key`：i18n.js 的 `t()` 在词条缺失时返回 **key 本身**
   * （`if (v == null) return key;`），直接 return 会让界面显示 `task.thumbCount`
   * 这种字符串 —— 比露中文更难排查。
   */
  function tui(key, zhFallback) {
    var I = global.I18n;
    if (I && typeof I.t === 'function') {
      var s = I.t(key);
      if (s != null && s !== key) return s;
    }
    return zhFallback;
  }

  /** 词条 + `{name}` 占位符替换。 */
  function tuiFmt(key, map, zhFallback) {
    var s = tui(key, zhFallback);
    if (!map) return s;
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        s = s.split('{' + k + '}').join(String(map[k]));
      }
    }
    return s;
  }

  /**
   * 停止按钮的两态同步 —— **四个停止按钮共用这一处**（扫描 / 补全 / 重建 / 查重 / 人脸 / 搜图）。
   *
   * 「已请求停止、还没停干净」的判据**分两组**（`docs/contracts/background-tasks.md` §8）：
   *   · 缩略图补全 / 重建 / 查重：`running && cancelled`。`cancelled` 是主进程一个独立布尔
   *     （起手置 `false`、收到停止请求置 `true`），**信号早就在报，只是渲染端一直没人读** ——
   *     于是这三个按钮点完没有任何反馈，用户只能靠「任务啥时候消失」猜有没有生效。
   *   · 人脸 / 搜图：`phase === 'stopping'`。它们的 `phase` 本来就是任务阶段机
   *     （`install` / `index` / `indexing` / `downloading` / `stopping` …），`stopping` 是合法阶段值。
   *
   * 🔴 **不许把这两组并成一个字段名**：缩略图那三组的 `phase` 被**别的语义占着**
   *    （补全 = 分母估算三态 `counting/ready/failed`，重建 = `enqueueing/draining`）
   *    ⇒ 塞 `'stopping'` 进去，同一个字段名就在两处表示两件正交的事。
   *    这与 §3.1.4 论证 `phase` / `countPhase` 不统一的理由**完全同构**：
   *    要统一的是「已请求停止」这个**语义**，两组都已经统一了。
   *
   * ⚠️ 判据必须是**绝对**的（看状态，不看「用户点过没」）：这样整节隐藏期间不需要任何复位逻辑 ——
   *    下次任务起手主进程已把 `cancelled` 重置为 `false`，按钮自然回到原文案。
   *    相对判据（点击时置、靠下一次渲染复位）会碰上「点了之后任务立刻结束 ⇒ 整节隐藏 ⇒
   *    再没人复位」的死角，下次任务起手按钮带着上一轮的禁用态。
   *
   * ⚠️ 临时态用**统一**文案（`task.stopping`），空闲态保留各按钮自己的语义
   *    （「停止补全」比「停止」有信息量）—— 所以空闲文案由调用方给。
   */
  function syncStopButton(el, stopping, idleText) {
    if (!el) return;
    if (stopping) {
      el.disabled = true;
      el.textContent = '⏳ ' + tui('task.stopping', '停止中...');
    } else {
      el.disabled = false;
      if (el.textContent !== idleText) el.textContent = idleText;
    }
  }

  /**
   * 扫描节两个动作按钮的文案（唯一拼法）。
   *
   * 🔴 这一处从前是**写死的中文**（`'⏸ 暂停'` / `'▶ 继续'` / `'⏹ 停止'` / `'⏳ 停止中...'`），
   *    而 `index.html` 的静态骨架在同一个按钮上**本来就有** `data-i18n="task.pause"` /
   *    `data-i18n="task.stop"` —— 骨架一份、JS 覆盖时又写死一份 ⇒ 正是 §6 点名的那个静默形状
   *    （词条改了界面不动，因为每次渲染都被 JS 覆盖回去）。
   * ⚠️ 图标（`⏸` / `▶` / `⏹` / `⏳`）在这里拼、词条里只放文字：英文界面不必依赖词条里混图标，
   *    而中文侧的产出与原来**逐字节相同**（原来写死的串就带图标）。
   */
  function scanPauseLabel(paused) {
    return (
      (paused ? '▶ ' : '⏸ ') + tui(paused ? 'task.resume' : 'task.pause', paused ? '继续' : '暂停')
    );
  }
  function scanStopLabel(stopping) {
    return stopping
      ? '⏳ ' + tui('task.stopping', '停止中...')
      : '⏹ ' + tui('task.stop', '停止');
  }

  /**
   * 预计剩余时间文案：仅天、小时、分（不足 1 分钟按 1 分钟计）。
   *
   * **七个面板共用这一处**（扫描 / 缩略图补全 / 缩略图重建 / 无效清理 / 查重 /
   * 人脸 / 搜图）—— 所以这里的双语化一次就让七条路径都跟上；改它等于改七个面板的观感。
   * ⚠️ 其中**人脸与搜图那两节是 2026-10-08 才接上来的**（用户报「不显示预计完成时间」）：
   *    在那之前它们只有速率行，因为那两个任务**没有分母**；后来加了抽样估计分母
   *    （`totalEstimated`）分母就有了，但面板元素一直没补 ⇒ 这是**欠账**，不是取舍。
   *    那两节的数值由主进程 `semantic-search.js#status()` 派生（同契约 §7），
   *    与其余五节「主进程用 `startedAt` 算」是**两条口径**，别混着改。
   *
   * 参数语义：`null` / 空 / 非正数一律返回**空串**（这一格自己消失），
   * 所以调用方**不需要**再加 `running` / `phase` 之类的闸门。
   */
  function formatEtaLine(sec) {
    if (sec == null || sec === '') return '';
    var n = Number(sec);
    if (!isFinite(n) || n <= 0) return '';
    var totalMin = Math.ceil(n / 60);
    if (totalMin < 1) totalMin = 1;
    var d = Math.floor(totalMin / 1440);
    var rem = totalMin % 1440;
    var h = Math.floor(rem / 60);
    var mi = rem % 60;
    var parts = [];
    if (d > 0) parts.push(tuiFmt('task.etaDays', { n: d }, d + ' 天'));
    if (h > 0) parts.push(tuiFmt('task.etaHours', { n: h }, h + ' 小时'));
    if (mi > 0) parts.push(tuiFmt('task.etaMinutes', { n: mi }, mi + ' 分'));
    if (parts.length === 0) parts.push(tuiFmt('task.etaMinutes', { n: 1 }, '1 分'));
    return tuiFmt('task.etaPrefix', { parts: parts.join(' ') }, '预计剩余约 ' + parts.join(' '));
  }

  function doScanFolder(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api;
    var folderPath = options.folderPath;
    if (!api || !folderPath) return;

    state.isScanning = true;
    state.isScanPaused = false;
    if (dom.scanProgress) dom.scanProgress.style.display = 'block';
    var cancelBtn = document.getElementById('taskScanCancel');
    var pauseResumeBtn = document.getElementById('taskScanPause');
    if (cancelBtn) {
      cancelBtn.style.display = '';
      cancelBtn.textContent = scanStopLabel(false);
      cancelBtn.disabled = false;
    }
    if (pauseResumeBtn) {
      pauseResumeBtn.style.display = '';
      pauseResumeBtn.disabled = false;
      pauseResumeBtn.textContent = scanPauseLabel(false);
    }
    if (typeof options.onUpdateProgress === 'function')
      options.onUpdateProgress(0, 1, tui('task.scanPreparing', '准备中...'));

    api.scanFolder(folderPath).then(async function (result) {
      state.isScanning = false;
      state.isScanPaused = false;
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (pauseResumeBtn) pauseResumeBtn.style.display = 'none';
      if (result && result.success) {
        if (typeof options.onMarkBrowseDataStale === 'function') {
          options.onMarkBrowseDataStale({
            settingsPageDirty: state.currentTab === 'settings',
          });
        } else if (state.currentTab === 'settings') {
          state.mustReloadBrowseAfterSettings = true;
        }
        if (typeof options.onLoadStats === 'function') await options.onLoadStats();
        if (typeof options.onLoadRootFolders === 'function')
          await options.onLoadRootFolders(state.rootFolders && state.rootFolders.length > 0);
        if (
          state.currentTab === 'settings' &&
          typeof options.onRenderSettingsFolderList === 'function'
        ) {
          await options.onRenderSettingsFolderList();
        }
        if (state.currentTab === 'duplicates' || state.currentView === 'duplicates') {
          if (typeof options.onRenderDuplicateSidebar === 'function')
            options.onRenderDuplicateSidebar();
          if (state.duplicateHasScanned && typeof options.onLoadDuplicateGroups === 'function') {
            await options.onLoadDuplicateGroups(state.duplicateGroupsPage || 1);
          }
        } else {
          state.currentView = 'all';
          state.page = 1;
          if (typeof options.onLoadPhotos === 'function') options.onLoadPhotos();
        }
        var cleaned = Number(result.cleanupDeleted) || 0;
        if (cleaned > 0 && typeof options.onUpdateProgress === 'function') {
          // ⚠️ 这一串落在**文件行**（`updateProgress(current, total, file)` 的第三参），
          //    不是状态行 —— 与 `app.js` 那几处收尾消息同一条形状。
          options.onUpdateProgress(
            1,
            1,
            tuiFmt(
              'task.scanDoneCleaned',
              { n: cleaned },
              '扫描完成，已清理失效记录 ' + cleaned + ' 条',
            ),
          );
        }
      } else if (!result || !result.cancelled) {
        if (typeof options.onAlert === 'function') {
          // 弹窗也是扫描流程的一部分：只改面板状态行、留着这条中文 ⇒ 英文界面点一次失败就露中文。
          // ⚠️ 这里原先是**半角冒号**（`'扫描失败: '`），与面板状态行那条全角不一致；
          //    统一用 `task.scanFailed`（全角），属刻意的一字符改动，见 CHANGELOG。
          options.onAlert(
            tuiFmt(
              'task.scanFailed',
              { err: (result && result.error) || tui('task.unknownError', '未知错误') },
              '扫描失败：' + ((result && result.error) || '未知错误'),
            ),
          );
        }
      }
      if (typeof options.onTickBackgroundTasksOnce === 'function')
        options.onTickBackgroundTasksOnce();
    });

    if (typeof options.onTickBackgroundTasksOnce === 'function')
      options.onTickBackgroundTasksOnce();
  }

  function handleCancelScan(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api;
    if (!api) return;
    api.cancelScan();
    state.isScanPaused = false;
    var cancelBtn = document.getElementById('taskScanCancel');
    var pauseResumeBtn = document.getElementById('taskScanPause');
    if (cancelBtn) {
      cancelBtn.textContent = scanStopLabel(true);
      cancelBtn.disabled = true;
    }
    if (pauseResumeBtn) {
      pauseResumeBtn.disabled = true;
      pauseResumeBtn.textContent = scanStopLabel(true);
    }
  }

  async function handlePauseResumeScan(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api;
    if (!api || !state.isScanning) return;
    var pauseResumeBtn = document.getElementById('taskScanPause');
    if (pauseResumeBtn) pauseResumeBtn.disabled = true;
    try {
      if (state.isScanPaused) {
        await api.resumeScan();
        state.isScanPaused = false;
        if (pauseResumeBtn) pauseResumeBtn.textContent = scanPauseLabel(false);
      } else {
        await api.pauseScan();
        state.isScanPaused = true;
        if (pauseResumeBtn) pauseResumeBtn.textContent = scanPauseLabel(true);
      }
    } finally {
      if (pauseResumeBtn) pauseResumeBtn.disabled = false;
    }
  }

  function updateProgress(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var formatNumber =
      options.formatNumber ||
      function (v) {
        return String(v);
      };
    var current = Number(options.current) || 0;
    var total = Number(options.total) || 0;
    var file = options.file || '';
    // 与主进程 `main/progress-pct.js#computePct` 同一条边界规则：`total = 0` ⇒ 0%、上限 100%。
    // 这里入参是两个**裸数字**（不是任务状态对象）⇒ 自己算这一格；但边界行为必须一致，
    // 否则同一个 100% 在不同的条子上含义不同（见 `docs/contracts/background-tasks.md` §1.1）。
    var pct = total > 0 ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
    if (dom.taskScanFill) dom.taskScanFill.style.width = pct + '%';
    if (dom.taskScanCount)
      dom.taskScanCount.textContent = formatNumber(current) + ' / ' + formatNumber(total);
    if (dom.taskScanFile) dom.taskScanFile.textContent = file;
    if (dom.taskScanText) {
      // 与面板重绘那处**同一批词条**（契约 §6.1）：这条快路径也写同一格文字，
      // 只改一处 = 扫描期间显示英文、轮询一拍之后退回中文。
      dom.taskScanText.textContent = state.isScanPaused
        ? tuiFmt('task.scanPaused', { pct: pct }, '已暂停... ' + pct + '%')
        : pct >= 100
          ? tui('task.scanDone', '扫描完成')
          : tuiFmt('task.scanRunning', { pct: pct }, '正在扫描... ' + pct + '%');
    }
  }

  function startBackgroundTaskPolling(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api;
    if (!api || !api.has || state.bgTaskPollingStarted || !api.has('getBackgroundTasks')) return;
    state.bgTaskPollingStarted = true;
    if (typeof options.onTickBackgroundTasksOnce === 'function')
      options.onTickBackgroundTasksOnce();
  }

  async function tickBackgroundTasksOnce(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api;
    var onScheduleNext = options.onScheduleNext;
    if (!api || !api.has || !api.has('getBackgroundTasks') || !dom.scanProgress) return;
    if (state.bgTaskTickBusy) {
      if (typeof onScheduleNext === 'function') onScheduleNext(options.retryMs);
      return;
    }
    state.bgTaskTickBusy = true;
    try {
      var t = await api.getBackgroundTasks();
      if (typeof options.onRenderBackgroundTaskPanel === 'function') {
        state.bgTaskHasActive = !!options.onRenderBackgroundTaskPanel(t);
      }
      if (typeof options.onAfterBackgroundTasksPoll === 'function') {
        await options.onAfterBackgroundTasksPoll(t);
      }
      state._bgTickCount = (state._bgTickCount || 0) + 1;
      if (state._bgTickCount % 5 === 0) {
        if (typeof options.onRefreshThumbnailBackfillStatus === 'function')
          await options.onRefreshThumbnailBackfillStatus();
        if (typeof options.onRefreshDuplicateHashStatus === 'function')
          await options.onRefreshDuplicateHashStatus();
      }
    } catch (e) {
    } finally {
      state.bgTaskTickBusy = false;
      if (typeof onScheduleNext === 'function') onScheduleNext();
    }
  }

  function renderBackgroundTaskPanel(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var t = options.tasks || {};
    var formatNumber =
      options.formatNumber ||
      function (v) {
        return String(v);
      };
    var onSyncTaskPanelCollapsedUI = options.onSyncTaskPanelCollapsedUI;
    /** 规格串（「512 px · WEBP」）的唯一拼法在 `app.js#formatThumbSpec` —— 这里只接，不重写一份。 */
    var formatThumbSpec = options.formatThumbSpec;

    if (!dom.scanProgress) return;
    var scan = t.scan || {};
    var prog = scan.progress || {};
    var queue = scan.queue || {};
    var thumbs = t.thumbs || {};
    /**
     * 缩略图**全量重建**的进度。与 `thumbs`（补全）**分开**取：两者分子分母口径不同，
     * 合成一个字段就会让「补了 3 张」与「重跑了 3 张」在界面上分不清（主进程也是这么报的）。
     * 字段见 `main.js#getThumbnailRebuildProgress()`：running / phase / total / done /
     * failed / scanned / missing / pending / pct / currentFile / targetSize / targetFormat / etaSeconds。
     * `phase`：`'enqueueing'`（还在登记全库）| `'draining'`（正在重跑）。
     */
    var thumbRebuild = t.thumbRebuild || {};
    var invalidCleanup = t.invalidCleanup || {};
    var dupHash = t.duplicateHash || {};
    // 「优化数据库」也走对象形式（`optimize.running`）—— 它以前是 `t.optimizing` 一个裸布尔，
    // 于是 `showOpt` 成了 9 个显隐判据里唯一的特例分支。见 `main.js#get-background-tasks`。
    var optimize = t.optimize || {};
    var scanning = !!scan.active;
    var queueWaiting = (queue.pendingCount || 0) > 0;
    var queueBusy = !!queue.processing;
    // 已被取出、但还在等写库闸门放行：既不是「空闲」也不是「正在扫」，
    // 主进程把它单列出来就是为了让界面别再显示「正在扫描... 0%」这种假进度。
    var waitingGate = !!(queue.current && queue.current.waitingGate);
    var scanQueued = !scanning && (waitingGate || queueWaiting || queueBusy);

    state.isScanning = scanning;
    // 单独一个标志：state.isScanning 的语义必须保持严格的「worker 正在跑」
    // （handlePauseResumeScan 拿它当开关），但「排队等闸门」也要让实时刷新别提前停。
    state.isScanQueued = scanQueued;
    state.isScanPaused = prog.status === 'paused';

    var showScanBlock =
      scanning ||
      queueWaiting ||
      queueBusy ||
      (prog.status &&
        prog.status !== 'idle' &&
        prog.status !== 'done' &&
        prog.status !== 'cancelled' &&
        prog.status !== 'error');
    if (prog.status === 'cancelled' && !scanning && !queueWaiting && !queueBusy) {
      showScanBlock = false;
    }

    var showThumb = !!thumbs.running;
    var showThumbRebuild = !!thumbRebuild.running;
    var showInvalidCleanup = !!invalidCleanup.running;
    var showOpt = !!optimize.running;
    var showDupHash = !!dupHash.running;
    var face = t.face || {};
    var showFace =
      !!face.running &&
      ['install', 'index', 'loading', 'indexing', 'downloading', 'stopping'].includes(face.phase);

    var semantic = t.semantic || {};
    /**
     * 🔴 取值域必须覆盖**所有会跑很久的 operation**，不只是「建索引」。
     * `'tag'` = 补 tag 倒排（`semantic-worker.js#refreshTags`，启动后 3 秒自动跑）——
     * 2026-10-08 之前它不在这里，于是它跑的时候这一节**隐藏**；而若它是**唯一**在跑的任务，
     * `showPanel` 整体为假 ⇒ **连面板标题一起消失**，用户完全看不到一个正在跑的长任务。
     * ⚠️ 判据是 `operation` 不是 `phase`：`phase` 里有 `'loading'`（搜索/预选词也会经过它）
     *    ⇒ 按 phase 放行会把「搜图」显示成后台任务。搜索 / 预选词**刻意不显示**（那不是后台任务）。
     * ⚠️ 这个形状与第 27 轮「缩略图重建不显示」完全同类：**新加了一条进度列，却没进或链/取值域**。
     *    当时之所以没被发现，是因为补全也在跑、**它撑着面板**。
     */
    var showSemantic = !!semantic.running && ['install', 'index', 'tag'].includes(semantic.operation);
    var showPanel =
      showScanBlock ||
      showThumb ||
      showThumbRebuild ||
      showInvalidCleanup ||
      showOpt ||
      showDupHash ||
      showFace ||
      showSemantic;
    dom.scanProgress.style.display = showPanel ? 'block' : 'none';

    var scanEl = document.getElementById('taskScanSection');
    var thumbEl = document.getElementById('taskThumbSection');
    var thumbRebuildEl = document.getElementById('taskThumbRebuildSection');
    var invalidCleanupEl = document.getElementById('taskInvalidCleanupSection');
    var optEl = document.getElementById('taskOptimizeSection');
    var dupHashEl = document.getElementById('taskDupHashSection');
    var badge = document.getElementById('taskQueueBadge');

    if (scanEl) scanEl.style.display = showScanBlock ? 'block' : 'none';
    if (thumbEl) thumbEl.style.display = showThumb ? 'block' : 'none';
    if (thumbRebuildEl) thumbRebuildEl.style.display = showThumbRebuild ? 'block' : 'none';
    if (invalidCleanupEl) invalidCleanupEl.style.display = showInvalidCleanup ? 'block' : 'none';
    if (optEl) optEl.style.display = showOpt ? 'block' : 'none';
    if (dupHashEl) dupHashEl.style.display = showDupHash ? 'block' : 'none';
    /**
     * 🔴 `prefix` 是**元素 id 的构造源**（下面全是 `aiTask.prefix + 'Title'` 这种拼法），
     *    所以它本身也是一个 id 片段 —— 改 id 规范时**盘点成品 id 是查不到它的**
     *    （`index.html` 里只有 `taskFaceTitle`、没有任何地方出现裸的 `taskFace`）。
     *    2026-10-08 统一 id 时就漏过这两处：HTML 换了新 id、这里还在拼旧前缀，
     *    结果 `getElementById('faceTaskCount')` 取到 `null` —— **不报错、那一格永远空白**，
     *    只有行为层断言（`face-task-regression` / `background-tasks-panel-regression`）抓得到。
     *    ⇒ 以后动 id，除了「HTML 定义」和「精确 id 引用」，还要查一遍**前缀 / 拼接**。
     */
    for (var aiTask of [
      {
        state: face,
        visible: showFace,
        section: 'taskFaceSection',
        prefix: 'taskFace',
        titleKey: 'task.faceTitle',
        // 兜底中文（i18n 取不到时用）；正常路径走 titleKey，见 `tui()` 的注释。
        titleZh: '人脸模型 / 索引',
      },
      {
        state: semantic,
        visible: showSemantic,
        section: 'taskSemanticSection',
        prefix: 'taskSemantic',
        titleKey: 'task.semanticTitle',
        titleZh: 'AI 模型 / 索引',
      },
    ]) {
      var faceEl = document.getElementById(aiTask.section);
      if (faceEl) faceEl.style.display = aiTask.visible ? 'block' : 'none';
      if (aiTask.visible) {
        /**
         * 🔴 这两节的文案**一律走 i18n**（`tui` / `tuiFmt`），不许再写内联三元。
         * 原先这里是 `(en ? 'Stopping AI task…' : '正在停止 AI 任务…')` 这类写法：
         * ① 绕过了 i18n（英文界面全靠代码里的英文串撑着，改文案要改两处）；
         * ② 与 `index.html` 静态骨架上的 `data-i18n="task.faceTitle"` **各说一份**，
         *    而骨架那份每次渲染都被代码覆盖 ⇒ 词条改了界面不动，是个静默陷阱。
         * 判据见 `docs/contracts/background-tasks.md` §6。
         */
        var faceTitle = document.getElementById(aiTask.prefix + 'Title');
        if (faceTitle)
          faceTitle.textContent =
            aiTask.state.phase === 'stopping'
              ? tui('task.aiStopping', '正在停止 AI 任务…')
              : tui(aiTask.titleKey, aiTask.titleZh);
        var faceCount = document.getElementById(aiTask.prefix + 'Count');
        if (faceCount) {
          var aiDone = Number(aiTask.state.done) || 0;
          var aiTotal = Number(aiTask.state.total) || 0;
          var aiFailed = Number(aiTask.state.failed) || 0;
          var aiSkipped = Number(aiTask.state.skipped) || 0;
          /**
           * 分母是**起始快照**（任务起手时算/数出来的），而扫描会持续往库里塞新图片
           * ⇒ 分子可能反超。两头夹住，否则会显示「107%」（与 `getThumbnailBackfillProgress`
           * 里 `denom = Math.max(total, processed)` 是同一条规矩）。
           */
          var aiDenom = Math.max(aiTotal, aiDone);
          /**
           * 百分比读**主进程派生**的 `pct`（`docs/contracts/background-tasks.md` §1.1）。
           * ⚠️ 主进程那边已经夹过 `[0,100]`（分子反超分母 ⇒ 100%）⇒ 这里不需要再夹一次；
           *    `aiDenom` 只用来**显示分母**（`total` 可能小于 `done`）。
           */
          var aiPct = Number(aiTask.state.pct) || 0;
          var aiText = tuiFmt('task.aiDone', { n: formatNumber(aiDone) }, '完成 ' + formatNumber(aiDone));
          if (aiTotal > 0) {
            /**
             * 「约」不是装饰，是**两种分母的区别**（`totalEstimated`：抽样估计值 vs 精确 `COUNT`）——
             * 所以它写在**词条里**（`task.aiCountEst` / `task.aiCount`），而不是在这里拼字符串：
             * 拼的写法没法让英文用 `~`、中文用「约」而不写回内联三元。
             * 把估算值当精确值显示，用户会拿它去核对行数、然后得出「进度算错了」。
             * ⚠️ 与缩略图那两节的主行 `done / total（pct%）` 是**同一个形状**（那是刻意对齐的）。
             * ⚠️ 括号跟语言走也在词条里（英文半角 / 中文全角）—— 全角括号混进英文既难看，
             *    又会漏过「英文界面零 CJK」那类判据（`（）` 是 CJK 标点）。
             */
            aiText = tuiFmt(
              aiTask.state.totalEstimated ? 'task.aiCountEst' : 'task.aiCount',
              { done: formatNumber(aiDone), total: formatNumber(aiDenom), pct: aiPct },
              formatNumber(aiDone) +
                ' / ' +
                (aiTask.state.totalEstimated ? '约 ' : '') +
                formatNumber(aiDenom) +
                '（' +
                aiPct +
                '%）',
            );
          } else if (aiTask.state.countPhase === 'counting') {
            /**
             * 分母还没估出来。**这三种情况以前压在同一句话「完成 N」里**，含义却完全不同：
             *   · `'counting'` 正在估（会过去的，等等就有百分比）
             *   · `'failed'`   估失败（**不会**自己好，百分比永远不出现）
             *   · `'ready'` + `total = 0` 分母就是 0（真的没有待处理项，无所可画）
             * 前两种必须说清楚，否则用户只能猜「是不是坏了」。文案形状与缩略图补全一致
             * （`task.thumbCountCounting` / `thumbCountNoTotal`，见 `docs/contracts/background-tasks.md` §3.1.4）。
             * ⚠️ 第三种**刻意不报「估失败」** —— 它恰恰是估成功且结果是 0。补全那边因为只有两态
             *    会把它误标成失败，这里用三态分岔避开了。
             */
            aiText = tuiFmt(
              'task.aiCountCounting',
              { done: formatNumber(aiDone) },
              '已处理 ' + formatNumber(aiDone) + '，正在估计待处理数量…',
            );
          } else if (aiTask.state.countPhase === 'failed') {
            aiText = tuiFmt(
              'task.aiCountNoTotal',
              { done: formatNumber(aiDone) },
              '已处理 ' + formatNumber(aiDone) + '（总数估计失败，暂不显示百分比与速率）',
            );
          }
          /**
           * ⚠️ 失败 / 跳过**只在 > 0 时追加**（与那两节「四样产出」的判据一致）。
           * 原因：索引跑起来之后很长一段这两个都是 0，一直挂着「失败 0 · 跳过 0」既占位置，
           * 又让用户在一个正常运行的界面上读到一个可疑的绝对数。> 0 之后它会一直显示。
           */
          if (aiFailed > 0) {
            aiText += tuiFmt('task.aiFailed', { n: formatNumber(aiFailed) }, ' · 失败 ' + formatNumber(aiFailed));
          }
          if (aiSkipped > 0) {
            aiText += tuiFmt('task.aiSkipped', { n: formatNumber(aiSkipped) }, ' · 跳过 ' + formatNumber(aiSkipped));
          }
          faceCount.textContent = aiText;
        }
        /**
         * 第二路（tag 倒排 / JoyTag）的计数 —— 与上面主行**并列**，不替换主行。
         *
         * ## 它解决的是一个真实的可观测性缺口
         *
         * `index` 这一趟里跑的是**两件事**：CLIP 向量索引 + tag 倒排。两件事的覆盖面刻意不同
         * （tag 有自己的一台「补建」发动机，见 `docs/contracts/joytag-index.md` §1），
         * 于是在**老库**上会出现这种组合：
         *
         *   · CLIP 索引早就建完了 ⇒ `store.batch()` 第一轮就返回空、CLIP 那趟几秒过完；
         *   · 剩下的几十小时全在 `drain()` 里补打标。
         *
         * 那一刻主行停在「完成 0」、进度条不动、文件名与速率都是空的 —— **面板看上去完全是死的**，
         * 用户没有任何办法判断它到底在不在跑（2026-10-08 用户报「需要看到 tag 完成计数」）。
         *
         * ## 判据与口径
         *
         * · 显示门 = `tagStage` 有值（worker 在 `announce()` 里报的那个键）。
         *   **不**看 `operation`：`index` 期间它一开始是 `null`（drain 还没开始）⇒ 这一格不显示；
         *   而人脸节的 state 里根本没有这个键 ⇒ 同一段代码两节共用时天然不显示。
         * · 百分比一律读主进程派生的 `tagPct`（契约 §1.1，与主行同一条规矩）。
         *   🔴 **不许在这里拿 `tagDone / tagDenom` 就地相除** —— 那两个数是两件事的分母
         *   （待打标几千 vs 待索引几十万），自算就等于给自己造了第二套口径。
         * · 分母带「约」：`estimatePending()` 的口径是「`photos` 行数 − `tag_photo` 行数」，
         *   两张表在两个库里 ⇒ 它是**估计值**（worker 上报时 `tagTotalEstimated` 恒为 `true`），
         *   所以这里只用带「约」的那条词条，没有精确版。
         * · 失败片段与主行共用 `task.aiFailed`（`tagDone` 里已经含失败，再单独报一个是刻意的：
         *   只报总数的话，「跑 1000 张失败 900 张」和「全部成功」在界面上长得一模一样）。
         */
        var faceTagCount = document.getElementById(aiTask.prefix + 'TagCount');
        if (faceTagCount) {
          /**
           * ⚠️ 局部名里的 `face*` 是本文件的历史命名（这一段周围全是 `faceCount` / `faceFile`），
           *    别按名字去找 `taskFaceTagCount` —— 那个 id **刻意不存在**（见上面的判据）。
           */
          var tagText = '';
          if (aiTask.state.tagStage) {
            var tagDone = Number(aiTask.state.tagDone) || 0;
            var tagTotal = Number(aiTask.state.tagTotal) || 0;
            var tagFailed = Number(aiTask.state.tagFailed) || 0;
            // 与主行同一条夹法：分母是**起手快照**，而扫描会持续往库里塞新图片 ⇒ 分子可能反超。
            var tagDenom = Math.max(tagTotal, tagDone);
            if (tagTotal > 0) {
              tagText = tuiFmt(
                'task.aiTagCount',
                { done: formatNumber(tagDone), total: formatNumber(tagDenom), pct: Number(aiTask.state.tagPct) || 0 },
                '标签索引 {done} / 约 {total}（{pct}%）',
              );
            } else if (aiTask.state.tagCountPhase === 'counting') {
              tagText = tuiFmt(
                'task.aiTagCountCounting',
                { done: formatNumber(tagDone) },
                '标签索引 已打标 {done} 张，正在估计待打标数量…',
              );
            } else if (aiTask.state.tagCountPhase === 'failed') {
              tagText = tuiFmt(
                'task.aiTagCountNoTotal',
                { done: formatNumber(tagDone) },
                '标签索引 已打标 {done} 张（待打标总数估计失败，暂不显示百分比）',
              );
            }
            if (tagFailed > 0) {
              tagText += tuiFmt(
                'task.aiFailed',
                { n: formatNumber(tagFailed) },
                ' · 失败 ' + formatNumber(tagFailed),
              );
            }
          }
          faceTagCount.textContent = tagText;
        }
        /**
         * 进度条：`<progress>` → `div + .progress-fill`（契约 §5 的形状收敛，2026-10-08）。
         *
         * 🔴 换的时候有一个**隐藏语义不能丢**：`<progress>` 不带 `value` 是**不定态**
         *    （浏览器画动画条纹 = 「在跑，但进度未知」），`div` 的 `0%` 则是「进度就是 0」。
         *    原先这里是 `else removeAttribute('value')` —— 于是**除了模型下载阶段之外，
         *    索引进度也一律落进不定态**，而同一节上方的 `*Count` 明明在显示
         *    `N / 约 M（pct%）`：计数有百分比、进度条却不动，两处不同步（本轮实测确认）。
         *    现在的判据：模型下载阶段用下载字节进度；有确定分母时用主进程派生的 `pct`；
         *    两者都没有才落不定态（用 `progress-fill--indeterminate` 表达，见 `styles.css`）。
         * ⚠️ 用 `className` 而不是 `classList`：这里就一个类名要切，赋值即可，
         *    也省得守护的 mock DOM 去实现 `classList` 的一整套方法。
         */
        var faceProgress = document.getElementById(aiTask.prefix + 'Progress');
        if (faceProgress) {
          var aiBarPct = null;
          if (aiTask.state.phase === 'downloading' && aiTask.state.file) {
            aiBarPct = Number(aiTask.state.percent) || 0;
          } else if (Number(aiTask.state.total) > 0) {
            aiBarPct = Number(aiTask.state.pct) || 0;
          }
          if (aiBarPct === null) {
            faceProgress.className = 'progress-fill progress-fill--indeterminate';
            faceProgress.style.width = '';
          } else {
            faceProgress.className = 'progress-fill';
            faceProgress.style.width = Math.min(100, Math.max(0, aiBarPct)) + '%';
          }
        }
        var faceFile = document.getElementById(aiTask.prefix + 'File');
        if (faceFile)
          faceFile.textContent =
            aiTask.state.phase === 'downloading'
              ? aiTask.state.file || ''
              : aiTask.state.currentFile || '';
        var faceRate = document.getElementById(aiTask.prefix + 'Rate');
        if (faceRate)
          faceRate.textContent =
            aiTask.state.ratePerMinute > 0
              ? tuiFmt(
                  'task.aiRate',
                  { n: formatNumber(aiTask.state.ratePerMinute) },
                  formatNumber(aiTask.state.ratePerMinute) + ' 张/分钟 · 停止后保留已完成结果',
                )
              : tui('task.aiPreparing', '准备中 · 可继续浏览图片');
        /**
         * 「预计剩余」—— 与另外 7 节**同一个助手、同一套词条**（`formatEtaLine` 就是
         * 「四节共用」那个：扫描 / 补全 / 重建 / 无效清理 / 查重，见它的注释）。
         *
         * 🔴 数值由**主进程派生**（`main/semantic-search.js#status()` 的 `out.etaSeconds`，
         *    `docs/contracts/background-tasks.md` §7）—— 渲染端**不自己除**，与上面 `pct`
         *    是同一条规矩。`null`（还估不出来）与 `0`（做完了）都让 `formatEtaLine` 返回空串
         *    ⇒ 这一格自己消失，不需要在这里判。
         *
         * ⚠️ **下载模型阶段（`phase === 'downloading'`）也画**：那一段 `ratePerMinute` 是 0
         *    ⇒ 主进程给的是 `null` ⇒ 自然空着。反过来若把「下载阶段」当成「没有 ETA」而在这里
         *    加一个 `phase` 判断，等哪天真给下载补了 ETA（字节速率是现成的），这个判断就是
         *    新的**静默**闸门（不报错、那一格永远空白）—— 判据只认数值。
         */
        var faceEta = document.getElementById(aiTask.prefix + 'Eta');
        if (faceEta) faceEta.textContent = formatEtaLine(aiTask.state.etaSeconds);
        // 停止按钮两态。这两节的判据是 `phase === 'stopping'`（它们的 `phase` 是任务阶段机，
        // `stopping` 是合法阶段值），与缩略图三任务的 `cancelled` 并列 —— 见 `syncStopButton`。
        // ⚠️ 从前这里只写 `faceStop.disabled = …`，**不改文案** ⇒ 点下去按钮只是变灰，
        //    用户读不到「正在停」这件事（另外三个按钮现在也是同一套反馈了）。
        syncStopButton(
          document.getElementById(aiTask.prefix + 'Stop'),
          aiTask.state.phase === 'stopping',
          tui('task.stop', '停止'),
        );
      }
    }

    if (badge) {
      var n = queue.pendingCount || 0;
      if (n > 0) {
        badge.style.display = '';
        // 文案走 i18n：原先这两串是**纯中文硬编码**（连英文分支都没有）⇒ 英文界面直接显示中文，
        // 且「扫描队列」这个说法在注释里被引用过三处（改文案时记得一起看）。
        badge.textContent = queueBusy
          ? tuiFmt('task.queueWaiting', { n: n }, '扫描队列 · 还有 ' + n + ' 项等待')
          : tuiFmt('task.queuePending', { n: n }, '扫描队列 · ' + n + ' 项');
      } else {
        badge.style.display = 'none';
        badge.textContent = '';
      }
    }

    if (showScanBlock) {
      var cur = prog.current || 0;
      var tot = prog.total || 0;
      // 🔴 百分比读**主进程派生**的那个值（`docs/contracts/background-tasks.md` §1.1）——
      //    渲染端不再自己除。本文件原先有 6 处各除一遍，而且 `total = 0` 的边界行为还不一致
      //    （清理那节画 100%、其余画 0%）。夹 [0,100] 的规矩也在主进程那一处。
      var pct = Number(prog.pct) || 0;
      if (dom.taskScanFill) dom.taskScanFill.style.width = pct + '%';
      if (dom.taskScanCount)
        dom.taskScanCount.textContent = formatNumber(cur) + ' / ' + formatNumber(tot);
      if (dom.taskScanFile) dom.taskScanFile.textContent = prog.currentFile || '';
      var scanEtaEl = document.getElementById('taskScanEta');
      if (scanEtaEl) {
        scanEtaEl.textContent =
          prog.status === 'enumerating' || prog.status === 'error'
            ? ''
            : formatEtaLine(prog.etaSeconds);
      }
      if (dom.taskScanText) {
        /**
         * 🔴 这一格的全部文案走 i18n（契约 §6.1 的最后一块，2026-10-08）。
         * 从前这七条**裸写中文** ⇒ 英文界面直接显示中文。中文兜底串**逐字节等于**原文，
         * 所以中文产出零变化 —— 这条性质本身也进了守护（见 `background-tasks-panel-regression` ④）。
         * ⚠️ `{n}` 传的是**已用 `formatNumber` 格式化好的串**，词条里不写格式说明。
         */
        if (prog.status === 'paused')
          dom.taskScanText.textContent = tuiFmt('task.scanPaused', { pct: pct }, '已暂停... ' + pct + '%');
        else if (prog.status === 'enumerating')
          dom.taskScanText.textContent = tuiFmt(
            'task.scanEnumerating',
            { n: formatNumber(cur) },
            '正在枚举文件... 已发现 ' + formatNumber(cur) + ' 个',
          );
        else if (prog.status === 'error')
          dom.taskScanText.textContent = tuiFmt(
            'task.scanFailed',
            { err: prog.error || tui('task.unknownError', '未知错误') },
            '扫描失败：' + (prog.error || '未知错误'),
          );
        else if (scanQueued)
          // 已排队但还没真正开扫。过去这里会走最后那条分支、显示「正在扫描... 0%」，
          // 是个一眼假的进度；现在按「等闸门 / 等前序任务」分别说清楚。
          dom.taskScanText.textContent = waitingGate
            ? tui('task.scanQueuedGate', '排队中，正在等前面的后台任务结束...')
            : tuiFmt(
                'task.scanQueuedPending',
                { n: formatNumber(queue.pendingCount || 0) },
                '排队中，前面还有 ' + formatNumber(queue.pendingCount || 0) + ' 个任务',
              );
        else
          dom.taskScanText.textContent =
            pct >= 100
              ? tui('task.scanDone', '扫描完成')
              : tuiFmt('task.scanRunning', { pct: pct }, '正在扫描... ' + pct + '%');
      }
      var pauseBtn = document.getElementById('taskScanPause');
      var cancelBtn = document.getElementById('taskScanCancel');
      if (pauseBtn) {
        // 暂停只对真在跑的那个有意义；排队的任务没有「暂停」这个概念
        pauseBtn.style.display = scanning ? '' : 'none';
        pauseBtn.textContent = scanPauseLabel(!!state.isScanPaused);
      }
      // 取消在**排队期间也要给**：T2 起扫描可能长时间等在写库闸门后面，
      // 这时不给入口等于用户只能干等（主进程侧 clear-scan-queue 已能撤掉排队的任务）。
      if (cancelBtn) cancelBtn.style.display = scanning || scanQueued ? '' : 'none';
    }

    if (showThumb) {
      var tfill = document.getElementById('taskThumbFill');
      var tcount = document.getElementById('taskThumbCount');
      var tdetail = document.getElementById('taskThumbDetail');
      var tfile = document.getElementById('taskThumbFile');
      var tEta = document.getElementById('taskThumbEta');
      // 🔴 主口径 = 「已处理行数 / 候选集规模」，**不是**预览图张数。
      //    补全按 id 倒序走（最新入库优先），而缺缩略图的行几乎全压在**低位老图片**上
      //    （本机真实库：id 1,900,000~1,999,999 只有 10 行缺，1,600,000~1,899,999 才是那 33.9 万）
      //    ⇒ 从 MAX(id) 往下走的头 2 万行里，缺预览图的是 **0** 行。
      //    曾经拿预览图当分子 / 分母，于是进度条在 0% 上趴了十几分钟一动不动，
      //    用户看到的是「任务卡住了」。现在分子是「已处理行数」，与任务真正的工作量对齐。
      //    三态：'counting' = 分母还在估（抽样，约 1 秒）；'failed' = 估失败；'ready' = 可画百分比。
      var tDenom = thumbs.total; // 候选集规模的**估计值**（约数）
      var tReady = thumbs.phase === 'ready' && tDenom > 0;
      if (tReady) {
        if (tfill) tfill.style.width = Math.min(100, Math.max(0, thumbs.pct || 0)) + '%';
        if (tcount)
          tcount.textContent = tuiFmt(
            'task.thumbCount',
            {
              done: formatNumber(thumbs.done),
              total: formatNumber(tDenom),
              pct: thumbs.pct || 0,
            },
            formatNumber(thumbs.done) +
              ' / 约 ' +
              formatNumber(tDenom) +
              '（' +
              (thumbs.pct || 0) +
              '%）',
          );
        if (tEta) tEta.textContent = formatEtaLine(thumbs.etaSeconds);
      } else {
        if (tfill) tfill.style.width = '0%';
        if (tcount) {
          tcount.textContent = tuiFmt(
            thumbs.phase === 'counting' ? 'task.thumbCountCounting' : 'task.thumbCountNoTotal',
            { done: formatNumber(thumbs.done) },
            '已处理 ' +
              formatNumber(thumbs.done) +
              ' 张' +
              (thumbs.phase === 'counting'
                ? '，正在估计待补数量…'
                : '（待补总数估计失败，暂不显示百分比与剩余时间）'),
          );
        }
        if (tEta) tEta.textContent = '';
      }
      // 副行：让「不只是在做预览图」看得见 —— 否则用户只会看到一个 0。
      // ⚠️ `thumbTotal` 是**实时剩余**（2026-10-06 改，原来是任务起始快照）⇒ `预览图 N`
      //    与 `还缺 M` 同一时点、`N + M ≈ 起跑线`，单调下降。
      // ⚠️ 判据仍是 `> 0`：0 既可能是「还没统计出来」也可能是「真的都补齐了」，
      //    两种情况都**不写**这一段（比显示「还缺 0」与统计态混淆要好）。
      if (tdetail) {
        var detailParts = [
          tuiFmt(
            'task.thumbDetailThumbs',
            { n: formatNumber(thumbs.thumbs) },
            '预览图 ' + formatNumber(thumbs.thumbs),
          ),
        ];
        if (thumbs.thumbTotal > 0)
          detailParts.push(
            tuiFmt(
              'task.thumbDetailPending',
              { n: formatNumber(thumbs.thumbTotal) },
              '待补 ' + formatNumber(thumbs.thumbTotal),
            ),
          );
        // 原图尺寸：与「拍摄信息」是**同一次**读文件头顺带解出来的（主进程里先写尺寸、再写 EXIF）
        // ⇒ 排在拍摄信息**前面**，顺序与 `runRowsWithThumbConcurrency#processOne` 的写库顺序一致。
        // ⚠️ 判据同样是 `> 0`：0 既可能「这项还没统计出来」也可能「该补的都齐了」，两种都不写。
        if (thumbs.sized > 0)
          detailParts.push(
            tuiFmt(
              'task.thumbDetailSized',
              { n: formatNumber(thumbs.sized) },
              '原图尺寸 +' + formatNumber(thumbs.sized),
            ),
          );
        if (thumbs.exifFilled > 0)
          detailParts.push(
            tuiFmt(
              'task.thumbDetailExif',
              { n: formatNumber(thumbs.exifFilled) },
              '拍摄信息 +' + formatNumber(thumbs.exifFilled),
            ),
          );
        if (thumbs.dhashed > 0)
          detailParts.push(
            tuiFmt(
              'task.thumbDetailDhash',
              { n: formatNumber(thumbs.dhashed) },
              '视觉指纹 +' + formatNumber(thumbs.dhashed),
            ),
          );
        if (thumbs.hashed > 0)
          detailParts.push(
            tuiFmt(
              'task.thumbDetailHash',
              { n: formatNumber(thumbs.hashed) },
              '查重指纹 +' + formatNumber(thumbs.hashed),
            ),
          );
        if (thumbs.failed > 0)
          detailParts.push(
            tuiFmt(
              'task.thumbDetailFailed',
              { n: formatNumber(thumbs.failed) },
              '失败 ' + formatNumber(thumbs.failed),
            ),
          );
        tdetail.textContent = detailParts.join(' · ');
      }
      if (tfile) tfile.textContent = thumbs.currentFile || '';
      // 停止按钮两态（判据 `running && cancelled`，见 `syncStopButton`）。
      // 🔴 从前这里**根本没有**这句：`cancelled` 一直由主进程报着、渲染端零消费 ⇒
      //    点「停止补全」之后按钮毫无变化，用户只能盯着任务什么时候消失来猜（§8 未落地的最后一项）。
      syncStopButton(
        document.getElementById('taskThumbStop'),
        thumbs.running && thumbs.cancelled,
        tui('task.thumbStop', '停止补全'),
      );
    }

    if (showThumbRebuild) {
      var rfill = document.getElementById('taskThumbRebuildFill');
      var rcount = document.getElementById('taskThumbRebuildCount');
      var rdetail = document.getElementById('taskThumbRebuildDetail');
      var rfile = document.getElementById('taskThumbRebuildFile');
      var rEta = document.getElementById('taskThumbRebuildEta');
      var rEnqueueing = thumbRebuild.phase === 'enqueueing';
      var rDone = formatNumber(thumbRebuild.done || 0);
      var rTotal = formatNumber(thumbRebuild.total || 0);
      // 🔴 登记阶段一张图都还没重生成（`done` 恒为 0），这时只报 `done` 会让进度条趴在 0%
      //    一动不动 —— 那段时间唯一的进展读数是「已扫描 N 行」，必须分开说
      //    （与设置页同口径，别在这里另编一套）。
      if (rfill)
        rfill.style.width = rEnqueueing
          ? '0%'
          : Math.min(100, Math.max(0, thumbRebuild.pct || 0)) + '%';
      if (rcount) {
        rcount.textContent = rEnqueueing
          ? tuiFmt(
              'task.thumbRebuildEnqueueing',
              { scanned: formatNumber(thumbRebuild.scanned || 0), enrolled: rTotal },
              '已扫描 ' + formatNumber(thumbRebuild.scanned || 0) + ' 行、已登记 ' + rTotal + ' 张…',
            )
          : tuiFmt(
              'task.thumbRebuildCount',
              { done: rDone, total: rTotal, pct: thumbRebuild.pct || 0 },
              rDone + ' / ' + rTotal + '（' + (thumbRebuild.pct || 0) + '%）',
            );
      }
      if (rdetail) {
        var rParts = [];
        // 目标规格：串的拼法只有一处（`app.js#formatThumbSpec`），这里不重写一份 ——
        // 「512 px · WEBP」的 px / 大写格式写歪过一次，重写一份迟早两边不一样。
        var rSpec =
          typeof formatThumbSpec === 'function'
            ? formatThumbSpec(thumbRebuild.targetSize, thumbRebuild.targetFormat)
            : '';
        if (rSpec) rParts.push(tuiFmt('task.thumbRebuildTarget', { spec: rSpec }, '目标 ' + rSpec));
        // 产出 / 剩余：与补全那节的「预览图 N」「还缺 M」一一对应（两节读起来要是同一套账）。
        // 🔴 口径必须是**本次进程**的：`done` / `failed` / `missing` 都跨重启累计（存在 meta 里），
        //    直接拿去当产出，报的就是**上一个进程**的账 —— 2026-10-08 用户就是这么发现的
        //    （本次进程起了 21 分钟，界面却报「已重出 387,250」，其中 37 万是上一趟做的）。
        //    累计口径的正确去处是**主行** `done / total`（总账），以及空闲态设置页那句
        //    「已全部重建（共 N 张）」。
        // ⇒ 这里只读主进程算好的 `rebuiltThisRun`（= 本次抽干 − 本次失败 − 本次 missing），
        //    **不在这边自己减**：那次减法跨三个数，放两处迟早两处不一样。
        var rRebuilt = thumbRebuild.rebuiltThisRun || 0;
        if (rRebuilt > 0)
          rParts.push(
            tuiFmt(
              'task.thumbRebuildDetailRebuilt',
              { n: formatNumber(rRebuilt) },
              '本次已重出 ' + formatNumber(rRebuilt),
            ),
          );
        // 🔴 「待重跑」只在**抽干阶段**报：登记阶段 `pending = total − done` 天然 > 0（`done` 恒为 0），
        //    照报就是一个**只涨不跌**的数，而同一时刻「已重出」恒为 0 被隐藏 ⇒ 用户看到孤零零一个
        //    上涨的「待重跑」，跟主行「已扫描 N 行、已登记 M 张…」读起来自相矛盾。
        //    登记阶段的唯一进展读数就是主行那个「已扫描 N 行」（与设置页同口径），别在这里再加一个。
        if (!rEnqueueing && (thumbRebuild.pending || 0) > 0)
          rParts.push(
            tuiFmt(
              'task.thumbRebuildDetailPending',
              { n: formatNumber(thumbRebuild.pending) },
              '待重跑 ' + formatNumber(thumbRebuild.pending),
            ),
          );
        // 顺手产出的四项（2026-10-08 起重建那一趟也会算）—— **复用补全那行的四个 i18n 键**：
        // 同一件事在两处显示成两种说法（「拍摄信息」/「拍摄参数」）会让人以为是两项不同的工作。
        //
        // 🔴 判据 = **进了抽干阶段就一律画**（不再是 `> 0`）。那四个 `> 0` 是从**补全**那处抄来的，
        //    而两边的候选集根本不同，抄过来恰好把重建这边最该看的东西藏掉了：
        //      · 补全收「**缺**缩略图」的行 ⇒ 那些行天然也缺四样 ⇒ 有产出才画，没问题；
        //      · 重建收「**有**缩略图、只是规格旧」的行，而这四样是**补全**（同样主键倒序）先补的
        //        ⇒ 两个反序任务在**同一段高位 id 碰头**，重建跑到那里时四样本来就齐
        //        （真库 2026-10-08 实测：队首段每 3000 行只缺 1~14 行）⇒ 四项全是 0 而
        //        **一个都不画**，副行上什么统计都看不到，用户分不清「这段无事可做」与「统计坏了」。
        //        用户原话：「重建缩微图，没有看到其他四项计数」。
        //    ⇒ 现在它画的就是**这一轮任务生成的数量**（`+0` 也照画：0 是「本段没得补」这个**事实**，
        //      不是异常 —— 「0 分不清是没统计还是真的齐」那条理由在补全那边成立，在这里恰好相反）。
        //    ⚠️ 补全那边**保持 `> 0` 不动**：它的候选集让「0」确实只可能是故障，判据不必跟着改。
        // ⚠️ 登记阶段仍不画：那时一张都还没重跑，四项的概念不适用（与下面「登记阶段不给 ETA」同理）。
        if (!rEnqueueing) {
          var rFour = [
            ['task.thumbDetailSized', thumbRebuild.sized, '原图尺寸 +'],
            ['task.thumbDetailExif', thumbRebuild.exifFilled, '拍摄信息 +'],
            ['task.thumbDetailDhash', thumbRebuild.dhashed, '视觉指纹 +'],
            ['task.thumbDetailHash', thumbRebuild.hashed, '查重指纹 +'],
          ];
          for (var rfi = 0; rfi < rFour.length; rfi++) {
            var rfItem = rFour[rfi];
            var rfN = formatNumber(rfItem[1] || 0);
            rParts.push(tuiFmt(rfItem[0], { n: rfN }, rfItem[2] + rfN));
          }
        }
        // ⚠️ 失败仍取**本次**且仍要 `> 0`：`failed` 跨重启累计，和上面四项同口径才读得通；
        //    而「0 个失败」不值得占一个位置（上面四项是**产出**，0 也有信息；失败 0 没有）。
        //    累计失败数不会因此看不见 —— 空闲态设置页那句「失败 M 张」读的是 meta 里的累计值。
        if ((thumbRebuild.failedThisRun || 0) > 0)
          rParts.push(
            tuiFmt(
              'task.thumbDetailFailed',
              { n: formatNumber(thumbRebuild.failedThisRun) },
              '失败 ' + formatNumber(thumbRebuild.failedThisRun),
            ),
          );
        rdetail.textContent = rParts.join(' · ');
      }
      if (rfile) rfile.textContent = thumbRebuild.currentFile || '';
      // ⚠️ 登记阶段**不给 ETA**：那时 `done` 是 0，算出来的剩余时间等于拿 0 当分子，是个假数。
      if (rEta) rEta.textContent = rEnqueueing ? '' : formatEtaLine(thumbRebuild.etaSeconds);
      // 停止按钮两态（判据 `running && cancelled`，见 `syncStopButton`）。
      syncStopButton(
        document.getElementById('taskThumbRebuildStop'),
        thumbRebuild.running && thumbRebuild.cancelled,
        tui('task.thumbRebuildStop', '停止重建'),
      );
    }

    if (showInvalidCleanup) {
      // 🔴 百分比读主进程派生的 `pct`。这里原先有一处**独一份**的写法：`total === 0` 时画 **100%**
      //    （其余五处画 0%）。它不是风格差异 —— 清理起手先把 `total` 置 0、再异步取全库行数，
      //    所以那段会先画满、`total` 到位后掉回 0%，用户看到的是**进度条倒退**。
      //    现在统一成 0%，`total = 0` 时不画百分比、改用「已检查 N，已删除 M」那句说明。
      var ipct = Number(invalidCleanup.pct) || 0;
      var ifill = document.getElementById('taskInvalidCleanupFill');
      var icount = document.getElementById('taskInvalidCleanupCount');
      var idetail = document.getElementById('taskInvalidCleanupDetail');
      var ifile = document.getElementById('taskInvalidCleanupFile');
      if (ifill) ifill.style.width = ipct + '%';
      if (icount) {
        if (invalidCleanup.total > 0) {
          icount.textContent =
            formatNumber(invalidCleanup.checked || 0) +
            ' / ' +
            formatNumber(invalidCleanup.total || 0);
        } else {
          // 只报「已检查 N」——「已删除 M」挪去副行了（见下面那段）。两条都报的话，
          // `total` 还没到位那段时间同一个数会在**计数行与文件行各出现一次**。
          icount.textContent = tuiFmt(
            'task.invalidCleanupChecked',
            { n: formatNumber(invalidCleanup.checked || 0) },
            '已检查 ' + formatNumber(invalidCleanup.checked || 0),
          );
        }
      }
      /**
       * 副行 = 产出明细（与补全 / 重建 / 查重同一个语义）。
       * 🔴 从前这条信息是**拼在文件行尾巴上**的（`currentFile + ' · 已删除 N 条'`）——
       *    于是「文件行」同时承担了两种语义：正在处理哪个 + 一共删了多少。
       *    四节的副行职责本来四种形状，本轮收敛成一种：`Detail` 只说产出、`File` 只说文件。
       * ⚠️ 判据 `> 0`：一条都没删时这是个 0，「已删除 0 条」不占位置（与补全那节同）。
       */
      if (idetail) {
        var iDeleted = invalidCleanup.deleted || 0;
        idetail.textContent =
          iDeleted > 0
            ? tuiFmt(
                'task.invalidCleanupDeleted',
                { n: formatNumber(iDeleted) },
                '已删除 ' + formatNumber(iDeleted) + ' 条',
              )
            : '';
      }
      if (ifile) ifile.textContent = invalidCleanup.currentFile || '';
      var iEta = document.getElementById('taskInvalidCleanupEta');
      if (iEta) iEta.textContent = formatEtaLine(invalidCleanup.etaSeconds);
    }

    if (showDupHash) {
      // 百分比读主进程派生的 `pct`（`docs/contracts/background-tasks.md` §1.1）。
      var dpct = Number(dupHash.pct) || 0;
      var dfill = document.getElementById('taskDupHashFill');
      var dcount = document.getElementById('taskDupHashCount');
      var ddetail = document.getElementById('taskDupHashDetail');
      var dfile = document.getElementById('taskDupHashFile');
      var dhash = document.getElementById('taskDupHashHash');
      if (dfill) dfill.style.width = dpct + '%';
      if (dcount)
        dcount.textContent =
          formatNumber(dupHash.done || 0) + ' / ' + formatNumber(dupHash.total || 0);
      /**
       * 副行 = **产出明细**，与补全 / 重建那两节是同一个语义（`Detail` 说「产出了什么」，
       * `File` 说「正在处理哪个」）。原先这几节里**只有查重没有 Detail** ⇒ 主进程一直在报的
       * `hashed` / `reused` / `failed` 三个数**界面从来没显示过**：分子 `done` 只说「处理了多少行」，
       * 看不出其中多少是真算的、多少是复用现成指纹的（复用走的路径完全不同、耗时也完全不同）。
       *
       * ⚠️ 判据仍是 `> 0`（与补全那节一致，与重建那节相反）：查重的候选集里
       *    「必须现算」与「可复用」两者必居其一 ⇒ 任务没起步时才有 0，
       *    那时不画比画一个「已算指纹 0 · 复用已有 0」更干净。重建那边是**候选集天然齐**
       *    所以必须画 0 —— 判据不同是因为**候选集不同**（`docs/contracts/background-tasks.md` §4.1）。
       */
      if (ddetail) {
        var dParts = [];
        if ((dupHash.hashed || 0) > 0)
          dParts.push(
            tuiFmt(
              'task.dupDetailHashed',
              { n: formatNumber(dupHash.hashed) },
              '已算指纹 ' + formatNumber(dupHash.hashed),
            ),
          );
        if ((dupHash.reused || 0) > 0)
          dParts.push(
            tuiFmt(
              'task.dupDetailReused',
              { n: formatNumber(dupHash.reused) },
              '复用已有 ' + formatNumber(dupHash.reused),
            ),
          );
        if ((dupHash.failed || 0) > 0)
          dParts.push(
            tuiFmt(
              'task.thumbDetailFailed',
              { n: formatNumber(dupHash.failed) },
              '失败 ' + formatNumber(dupHash.failed),
            ),
          );
        ddetail.textContent = dParts.join(' · ');
      }
      if (dfile) dfile.textContent = dupHash.currentFile || '';
      if (dhash) {
        // ⚠️ 这两串原先**写死中文**（英文界面直接显示中文）—— 已搬进 i18n（§6）。
        var h = String(dupHash.currentHash || '');
        dhash.textContent = h
          ? tuiFmt('task.dupHashCurrent', { hash: h.slice(0, 16) + '…' }, '当前编号：' + h.slice(0, 16) + '…')
          : tui('task.dupHashReading', '正在读取当前文件…');
      }
      var dEta = document.getElementById('taskDupHashEta');
      if (dEta) dEta.textContent = formatEtaLine(dupHash.etaSeconds);
      // 停止按钮两态（判据 `running && cancelled`，见 `syncStopButton`）。
      syncStopButton(
        document.getElementById('taskDupHashStop'),
        dupHash.running && dupHash.cancelled,
        tui('task.stop', '停止'),
      );
    }

    if (!showScanBlock) {
      var pauseBtn2 = document.getElementById('taskScanPause');
      var cancelBtn2 = document.getElementById('taskScanCancel');
      if (pauseBtn2) pauseBtn2.style.display = 'none';
      if (cancelBtn2) cancelBtn2.style.display = 'none';
    }
    if (!scanning) {
      var cb = document.getElementById('taskScanCancel');
      var pb = document.getElementById('taskScanPause');
      if (cb && cb.disabled) {
        cb.disabled = false;
        cb.textContent = scanStopLabel(false);
      }
      if (pb && pb.disabled) pb.disabled = false;
    }

    if (typeof onSyncTaskPanelCollapsedUI === 'function') onSyncTaskPanelCollapsedUI();
    return showPanel;
  }

  global.RendererScanFlow = Object.assign({}, global.RendererScanFlow || {}, {
    doScanFolder: doScanFolder,
    handleCancelScan: handleCancelScan,
    handlePauseResumeScan: handlePauseResumeScan,
    updateProgress: updateProgress,
    startBackgroundTaskPolling: startBackgroundTaskPolling,
    tickBackgroundTasksOnce: tickBackgroundTasksOnce,
    renderBackgroundTaskPanel: renderBackgroundTaskPanel,
    formatEtaLine: formatEtaLine,
    // 扫描节两个动作按钮的文案（唯一拼法）—— `app.js#rescanFolder` 那条入口也要用同一份，
    // 否则同一个按钮在两条路径上各有一套文案（原来 app.js 里也写死了一份 `'⏹ 停止'`）。
    scanPauseLabel: scanPauseLabel,
    scanStopLabel: scanStopLabel,
  });
})(window);
