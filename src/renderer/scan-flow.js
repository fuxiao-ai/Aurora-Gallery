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
   * 预计剩余时间文案：仅天、小时、分（不足 1 分钟按 1 分钟计）。
   *
   * 四个面板（扫描 / 缩略图补全 / 无效清理 / 查重）共用这一处 —— 所以这里的
   * 双语化一次就让四条路径都跟上；改它等于改四个面板的观感。
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
    var showInvalidCleanup = !!invalidCleanup.running;
    var showOpt = !!t.optimizing;
    var showDupHash = !!dupHash.running;
    var face = t.face || {};
    var showFace =
      !!face.busy &&
      ['install', 'index', 'loading', 'indexing', 'downloading', 'stopping'].includes(face.phase);

    var semantic = t.semantic || {};
    var showSemantic = !!semantic.busy && ['install', 'index'].includes(semantic.operation);
    var showPanel =
      showScanBlock ||
      showThumb ||
      showInvalidCleanup ||
      showOpt ||
      showDupHash ||
      showFace ||
      showSemantic;
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
    for (var aiTask of [
      {
        state: face,
        visible: showFace,
        section: 'taskFaceSection',
        prefix: 'faceTask',
        titleEn: 'Face models / indexing',
        titleZh: '人脸模型 / 索引',
      },
      {
        state: semantic,
        visible: showSemantic,
        section: 'taskSemanticSection',
        prefix: 'semanticTask',
        titleEn: 'AI models / indexing',
        titleZh: 'AI 模型 / 索引',
      },
    ]) {
      var faceEl = document.getElementById(aiTask.section);
      if (faceEl) faceEl.style.display = aiTask.visible ? 'block' : 'none';
      if (aiTask.visible) {
        var en = document.documentElement.lang.startsWith('en');
        var faceTitle = document.getElementById(aiTask.prefix + 'Title');
        if (faceTitle)
          faceTitle.textContent =
            aiTask.state.phase === 'stopping'
              ? en
                ? 'Stopping AI task…'
                : '正在停止 AI 任务…'
              : en
                ? aiTask.titleEn
                : aiTask.titleZh;
        var faceCount = document.getElementById(aiTask.prefix + 'Count');
        if (faceCount)
          faceCount.textContent =
            (en ? 'Processed ' : '完成 ') +
            formatNumber(aiTask.state.processed || 0) +
            (en ? ' · Failed ' : ' · 失败 ') +
            formatNumber(aiTask.state.failed || 0) +
            (en ? ' · Skipped ' : ' · 跳过 ') +
            formatNumber(aiTask.state.skipped || 0);
        var faceProgress = document.getElementById(aiTask.prefix + 'Progress');
        if (faceProgress) {
          if (aiTask.state.phase === 'downloading' && aiTask.state.file)
            faceProgress.value = aiTask.state.percent || 0;
          else faceProgress.removeAttribute('value');
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
              ? formatNumber(aiTask.state.ratePerMinute) +
                (en
                  ? ' photos/min · Completed entries are retained when stopped'
                  : ' 张/分钟 · 停止后保留已完成结果')
              : en
                ? 'Preparing · You can continue browsing'
                : '准备中 · 可继续浏览照片';
        var faceStop = document.getElementById(aiTask.prefix + 'Stop');
        if (faceStop) faceStop.disabled = aiTask.state.phase === 'stopping';
      }
    }

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
        else if (scanQueued)
          // 已排队但还没真正开扫。过去这里会走最后那条分支、显示「正在扫描... 0%」，
          // 是个一眼假的进度；现在按「等闸门 / 等前序任务」分别说清楚。
          dom.progressText.textContent = waitingGate
            ? '排队中，正在等前面的后台任务结束...'
            : '排队中，前面还有 ' + formatNumber(queue.pendingCount || 0) + ' 个任务';
        else dom.progressText.textContent = pct >= 100 ? '扫描完成' : '正在扫描... ' + pct + '%';
      }
      var pauseBtn = document.getElementById('pauseResumeScanBtn');
      var cancelBtn = document.getElementById('cancelScanBtn');
      if (pauseBtn) {
        // 暂停只对真在跑的那个有意义；排队的任务没有「暂停」这个概念
        pauseBtn.style.display = scanning ? '' : 'none';
        pauseBtn.textContent = state.isScanPaused ? '▶ 继续' : '⏸ 暂停';
      }
      // 取消在**排队期间也要给**：T2 起扫描可能长时间等在写库闸门后面，
      // 这时不给入口等于用户只能干等（主进程侧 clear-scan-queue 已能撤掉排队的任务）。
      if (cancelBtn) cancelBtn.style.display = scanning || scanQueued ? '' : 'none';
    }

    if (showThumb) {
      var tfill = document.getElementById('thumbProgressFill');
      var tcount = document.getElementById('thumbProgressCount');
      var tdetail = document.getElementById('thumbProgressDetail');
      var tfile = document.getElementById('thumbProgressFile');
      var tEta = document.getElementById('thumbProgressEta');
      // 🔴 主口径 = 「已处理行数 / 候选集规模」，**不是**预览图张数。
      //    补全按 id 倒序走（最新入库优先），而缺缩略图的行几乎全压在**低位老照片**上
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
    }

    if (showInvalidCleanup) {
      var ipct =
        invalidCleanup.total > 0
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
        dhash.textContent = h ? '当前编号：' + h.slice(0, 16) + '…' : '正在读取当前文件…';
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
