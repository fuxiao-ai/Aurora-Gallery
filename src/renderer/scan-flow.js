(function (global) {
  /** 预计剩余时间文案：仅天、小时、分（不足 1 分钟按 1 分钟计） */
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
    if (d > 0) parts.push(d + ' 天');
    if (h > 0) parts.push(h + ' 小时');
    if (mi > 0) parts.push(mi + ' 分');
    if (parts.length === 0) parts.push('1 分');
    return '预计剩余约 ' + parts.join(' ');
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
    var cancelBtn = document.getElementById('cancelScanBtn');
    var pauseResumeBtn = document.getElementById('pauseResumeScanBtn');
    if (cancelBtn) {
      cancelBtn.style.display = '';
      cancelBtn.textContent = '⏹ 停止';
      cancelBtn.disabled = false;
    }
    if (pauseResumeBtn) {
      pauseResumeBtn.style.display = '';
      pauseResumeBtn.disabled = false;
      pauseResumeBtn.textContent = '⏸ 暂停';
    }
    if (typeof options.onUpdateProgress === 'function') options.onUpdateProgress(0, 1, '准备中...');

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
          options.onUpdateProgress(1, 1, '扫描完成，已清理失效记录 ' + cleaned + ' 条');
        }
      } else if (!result || !result.cancelled) {
        if (typeof options.onAlert === 'function') {
          options.onAlert('扫描失败: ' + ((result && result.error) || '未知错误'));
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
    var cancelBtn = document.getElementById('cancelScanBtn');
    var pauseResumeBtn = document.getElementById('pauseResumeScanBtn');
    if (cancelBtn) {
      cancelBtn.textContent = '⏳ 停止中...';
      cancelBtn.disabled = true;
    }
    if (pauseResumeBtn) {
      pauseResumeBtn.disabled = true;
      pauseResumeBtn.textContent = '⏳ 停止中...';
    }
  }

  async function handlePauseResumeScan(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api;
    if (!api || !state.isScanning) return;
    var pauseResumeBtn = document.getElementById('pauseResumeScanBtn');
    if (pauseResumeBtn) pauseResumeBtn.disabled = true;
    try {
      if (state.isScanPaused) {
        await api.resumeScan();
        state.isScanPaused = false;
        if (pauseResumeBtn) pauseResumeBtn.textContent = '⏸ 暂停';
      } else {
        await api.pauseScan();
        state.isScanPaused = true;
        if (pauseResumeBtn) pauseResumeBtn.textContent = '▶ 继续';
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
    var pct = total > 0 ? Math.round((current / total) * 100) : 0;
    if (dom.progressFill) dom.progressFill.style.width = pct + '%';
    if (dom.progressCount)
      dom.progressCount.textContent = formatNumber(current) + ' / ' + formatNumber(total);
    if (dom.progressFile) dom.progressFile.textContent = file;
    if (dom.progressText) {
      if (state.isScanPaused) dom.progressText.textContent = '已暂停... ' + pct + '%';
      else dom.progressText.textContent = pct >= 100 ? '扫描完成' : '正在扫描... ' + pct + '%';
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

    if (!dom.scanProgress) return;
    var scan = t.scan || {};
    var prog = scan.progress || {};
    var queue = scan.queue || {};
    var thumbs = t.thumbs || {};
    var invalidCleanup = t.invalidCleanup || {};
    var dupHash = t.duplicateHash || {};
    var scanning = !!scan.active;
    var queueWaiting = (queue.pendingCount || 0) > 0;
    var queueBusy = !!queue.processing;

    state.isScanning = scanning;
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
    var showInvalidCleanup = !!invalidCleanup.running;
    var showOpt = !!t.optimizing;
    var showDupHash = !!dupHash.running;

    var showPanel =
      showScanBlock ||
      showThumb ||
      showInvalidCleanup ||
      showOpt ||
      showDupHash;
    dom.scanProgress.style.display = showPanel ? 'block' : 'none';

    var scanEl = document.getElementById('taskScanSection');
    var thumbEl = document.getElementById('taskThumbSection');
    var invalidCleanupEl = document.getElementById('taskInvalidCleanupSection');
    var optEl = document.getElementById('taskOptimizeSection');
    var dupHashEl = document.getElementById('taskDupHashSection');
    var badge = document.getElementById('taskQueueBadge');

    if (scanEl) scanEl.style.display = showScanBlock ? 'block' : 'none';
    if (thumbEl) thumbEl.style.display = showThumb ? 'block' : 'none';
    if (invalidCleanupEl) invalidCleanupEl.style.display = showInvalidCleanup ? 'block' : 'none';
    if (optEl) optEl.style.display = showOpt ? 'block' : 'none';
    if (dupHashEl) dupHashEl.style.display = showDupHash ? 'block' : 'none';

    if (badge) {
      var n = queue.pendingCount || 0;
      if (n > 0) {
        badge.style.display = '';
        badge.textContent = queueBusy
          ? '扫描队列 · 还有 ' + n + ' 项等待'
          : '扫描队列 · ' + n + ' 项';
      } else {
        badge.style.display = 'none';
        badge.textContent = '';
      }
    }

    if (showScanBlock) {
      var cur = prog.current || 0;
      var tot = prog.total || 0;
      var pct = tot > 0 ? Math.round((cur / tot) * 100) : 0;
      if (dom.progressFill) dom.progressFill.style.width = pct + '%';
      if (dom.progressCount)
        dom.progressCount.textContent = formatNumber(cur) + ' / ' + formatNumber(tot);
      if (dom.progressFile) dom.progressFile.textContent = prog.currentFile || '';
      var scanEtaEl = document.getElementById('scanProgressEta');
      if (scanEtaEl) {
        scanEtaEl.textContent =
          prog.status === 'enumerating' || prog.status === 'error'
            ? ''
            : formatEtaLine(prog.etaSeconds);
      }
      if (dom.progressText) {
        if (prog.status === 'paused') dom.progressText.textContent = '已暂停... ' + pct + '%';
        else if (prog.status === 'enumerating')
          dom.progressText.textContent = '正在枚举文件... 已发现 ' + formatNumber(cur) + ' 个';
        else if (prog.status === 'error')
          dom.progressText.textContent = '扫描失败：' + (prog.error || '未知错误');
        else dom.progressText.textContent = pct >= 100 ? '扫描完成' : '正在扫描... ' + pct + '%';
      }
      var pauseBtn = document.getElementById('pauseResumeScanBtn');
      var cancelBtn = document.getElementById('cancelScanBtn');
      if (pauseBtn) {
        pauseBtn.style.display = scanning ? '' : 'none';
        pauseBtn.textContent = state.isScanPaused ? '▶ 继续' : '⏸ 暂停';
      }
      if (cancelBtn) cancelBtn.style.display = scanning ? '' : 'none';
    }


    if (showThumb) {
      var tpct = thumbs.total > 0 ? Math.round((thumbs.done / thumbs.total) * 100) : 0;
      var tfill = document.getElementById('thumbProgressFill');
      var tcount = document.getElementById('thumbProgressCount');
      var tfile = document.getElementById('thumbProgressFile');
      if (tfill) tfill.style.width = tpct + '%';
      if (tcount)
        tcount.textContent = formatNumber(thumbs.done) + ' / ' + formatNumber(thumbs.total);
      if (tfile) tfile.textContent = thumbs.currentFile || '';
      var tEta = document.getElementById('thumbProgressEta');
      if (tEta) tEta.textContent = formatEtaLine(thumbs.etaSeconds);
    }

    if (showInvalidCleanup) {
      var ipct = invalidCleanup.total > 0
        ? Math.round((invalidCleanup.checked / invalidCleanup.total) * 100)
        : 0;
      var ifill = document.getElementById('invalidCleanupProgressFill');
      var icount = document.getElementById('invalidCleanupProgressCount');
      var ifile = document.getElementById('invalidCleanupProgressFile');
      if (ifill) ifill.style.width = (invalidCleanup.total > 0 ? ipct : 100) + '%';
      if (icount) {
        if (invalidCleanup.total > 0) {
          icount.textContent =
            formatNumber(invalidCleanup.checked || 0) +
            ' / ' +
            formatNumber(invalidCleanup.total || 0);
        } else {
          icount.textContent =
            '已检查 ' +
            formatNumber(invalidCleanup.checked || 0) +
            '，已删除 ' +
            formatNumber(invalidCleanup.deleted || 0);
        }
      }
      if (ifile) {
        ifile.textContent =
          (invalidCleanup.currentFile || '') +
          ((invalidCleanup.deleted || 0) > 0
            ? ' · 已删除 ' + formatNumber(invalidCleanup.deleted || 0) + ' 条'
            : '');
      }
      var iEta = document.getElementById('invalidCleanupProgressEta');
      if (iEta) iEta.textContent = formatEtaLine(invalidCleanup.etaSeconds);
    }

    if (showDupHash) {
      var dpct = dupHash.total > 0 ? Math.round((dupHash.done / dupHash.total) * 100) : 0;
      var dfill = document.getElementById('dupHashProgressFill');
      var dcount = document.getElementById('dupHashProgressCount');
      var dfile = document.getElementById('dupHashProgressFile');
      var dhash = document.getElementById('dupHashProgressHash');
      if (dfill) dfill.style.width = dpct + '%';
      if (dcount)
        dcount.textContent =
          formatNumber(dupHash.done || 0) + ' / ' + formatNumber(dupHash.total || 0);
      if (dfile) dfile.textContent = dupHash.currentFile || '';
      if (dhash) {
        var h = String(dupHash.currentHash || '');
        dhash.textContent = h
          ? '当前编号：' + h.slice(0, 16) + '…'
          : '正在读取当前文件…';
      }
      var dEta = document.getElementById('dupHashProgressEta');
      if (dEta) dEta.textContent = formatEtaLine(dupHash.etaSeconds);
    }

    if (!showScanBlock) {
      var pauseBtn2 = document.getElementById('pauseResumeScanBtn');
      var cancelBtn2 = document.getElementById('cancelScanBtn');
      if (pauseBtn2) pauseBtn2.style.display = 'none';
      if (cancelBtn2) cancelBtn2.style.display = 'none';
    }
    if (!scanning) {
      var cb = document.getElementById('cancelScanBtn');
      var pb = document.getElementById('pauseResumeScanBtn');
      if (cb && cb.disabled) {
        cb.disabled = false;
        cb.textContent = '⏹ 停止';
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
  });
})(window);
