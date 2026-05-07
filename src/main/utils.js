const { spawnSync } = require('child_process');
const fs = require('fs');
const { shell } = require('electron');

/** 懒加载：避免冷启动即解析 ffmpeg-static 路径（磁盘/解压成本） */
let cachedFfmpegStaticPath;
function getFfmpegStaticPath() {
  if (cachedFfmpegStaticPath !== undefined) {
    return cachedFfmpegStaticPath || null;
  }
  try {
    cachedFfmpegStaticPath = require('ffmpeg-static') || '';
  } catch (e) {
    cachedFfmpegStaticPath = '';
  }
  return cachedFfmpegStaticPath || null;
}

let videoFrameThumbModule = null;
function getVideoFrameThumb() {
  if (!videoFrameThumbModule) {
    videoFrameThumbModule = require('../video-frame-thumb');
  }
  return videoFrameThumbModule;
}

/** 延迟加载 sharp（libvips），缩短主进程冷启动到可显示窗口的时间 */
let sharpModule = null;
function loadSharp() {
  if (!sharpModule) {
    sharpModule = require('sharp');
  }
  return sharpModule;
}

function isTrashAbortLikeError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  return /abort/i.test(String(err.message || err));
}

function escapePsSingleQuotedPath(filePath) {
  return String(filePath || '').replace(/'/g, "''");
}

/** Windows：Electron shell.trashItem 失败时的备用路径（VB FileSystem 送回收站） */
function moveFileToRecycleBinWindowsFallback(filePath) {
  var ps =
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('" +
    escapePsSingleQuotedPath(filePath) +
    "', 'OnlyErrorDialog', 'SendToRecycleBin')";
  var r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
  if (r.error) throw r.error;
  if (r.status !== 0) {
    var detail = String((r.stderr || r.stdout || '').trim() || '退出码 ' + r.status);
    throw new Error(detail);
  }
}

/**
 * Windows 上 shell.trashItem 易报 AbortError / Operation was aborted；短延迟重试 + PowerShell 兜底。
 */
async function shellTrashItemWithFallback(absPath) {
  var lastErr;
  var attempts = 3;
  var i;
  for (i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 200 * i);
      });
    }
    try {
      await shell.trashItem(absPath);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (process.platform === 'win32' && fs.existsSync(absPath)) {
    try {
      moveFileToRecycleBinWindowsFallback(absPath);
      if (!fs.existsSync(absPath)) return;
      lastErr = new Error('回收站操作未完成，文件仍在原位置');
    } catch (ePs) {
      lastErr = ePs;
    }
  }
  throw lastErr || new Error('移入回收站失败');
}

function formatTrashFailureError(err) {
  var raw = err && err.message ? String(err.message) : String(err || '');
  if (isTrashAbortLikeError(err)) {
    return '移入回收站失败（操作被系统中断）。请关闭可能占用该文件的程序后重试；网络路径或只读介质可能不支持回收站。';
  }
  return raw || '移入回收站失败';
}

/** 各任务 ETA 平滑状态（新任务 startedAt 变化时重置） */
const etaSmoothByKey = Object.create(null);

/**
 * 根据已开始耗时与完成量估算剩余秒数；不足数据时返回 null。
 * 平均速度 = done / elapsed（件/毫秒），剩余毫秒 = remaining / rate，须除以 1000 才是秒（此前误把毫秒当秒）。
 */
function estimateEtaSeconds(startedAt, done, total) {
  if (!startedAt || total <= 0) return null;
  var remaining = total - done;
  if (remaining <= 0) return 0;
  if (done < 1) return null;
  var elapsed = Date.now() - startedAt;
  if (elapsed < 800) return null;
  // 前段波动大：至少完成 3 件，或已运行 5s 再估（二者满足其一）
  if (done < 3 && elapsed < 5000) return null;
  var rate = done / elapsed;
  if (rate <= 0) return null;
  var etaMs = remaining / rate;
  var sec = Math.ceil(etaMs / 1000);
  return Math.max(1, sec);
}

/**
 * 对 ETA 做指数平滑，减少 UI 轮询时的抖动；taskKey 区分目录扫描/缩略图等。
 */
function estimateEtaSecondsSmoothed(taskKey, startedAt, done, total) {
  if (!taskKey) return estimateEtaSeconds(startedAt, done, total);
  if (!startedAt) {
    delete etaSmoothByKey[taskKey];
    return null;
  }
  var raw = estimateEtaSeconds(startedAt, done, total);
  if (raw == null) {
    delete etaSmoothByKey[taskKey];
    return null;
  }
  if (raw === 0) {
    delete etaSmoothByKey[taskKey];
    return 0;
  }
  var st = etaSmoothByKey[taskKey];
  if (!st || st.startedAt !== startedAt) {
    etaSmoothByKey[taskKey] = { startedAt: startedAt, eta: raw };
    return raw;
  }
  var blended = Math.round(0.38 * raw + 0.62 * st.eta);
  if (blended < 1) blended = 1;
  etaSmoothByKey[taskKey].eta = blended;
  return blended;
}

module.exports = {
  getFfmpegStaticPath,
  getVideoFrameThumb,
  loadSharp,
  isTrashAbortLikeError,
  escapePsSingleQuotedPath,
  moveFileToRecycleBinWindowsFallback,
  shellTrashItemWithFallback,
  formatTrashFailureError,
  estimateEtaSeconds,
  estimateEtaSecondsSmoothed,
};
