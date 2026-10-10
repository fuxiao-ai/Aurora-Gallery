'use strict';

/**
 * 数据库维护（VACUUM / 重建缩略图标记）动手前的两道准入判断。
 *
 * 抽成独立模块的原因是 main.js 没法在普通 node 进程里 require（它一上来就要 electron 的
 * app / ipcMain），规则留在里面就只能靠「读源码文本」断言，那种断言测不出行为。这里把
 * 「谁在占着库」和「磁盘够不够」两件纯计算的事剥出来，回归脚本可以拿假数据直接验。
 */

/**
 * 两套 AI 索引（人脸 / 搜图）各跑一个 worker：索引期间它一直持有 photos.db 连接、
 * 在批次事务里反复写入。此时再去做 VACUUM / 重建缩略图标记，写锁必然抢不到——
 * 线上报出来的 `database is locked` 就是这么来的（maintenance worker 等满 8s 仍然失败）。
 *
 * 只读查询（搜图 / 人物列表）走的是不写 state 的并发分支，因此不会被这里算成忙碌。
 *
 * @param {Array<{status: () => object}|null|undefined>} services
 * @param {(error: Error) => void} [onError] 探活失败时的告警出口；探活永远不能让维护流程崩掉
 * @returns {boolean}
 */
function aiIndexBusy(services, onError) {
  for (const service of services || []) {
    if (!service) continue;
    try {
      if (service.status().running) return true;
    } catch (error) {
      if (onError) onError(error);
    }
  }
  return false;
}

/** 卷可用字节。取不到时返回 -1 表示「未知」，调用方据此不拦，而不是误报空间不足。 */
function freeDiskBytes(targetPath, statfs) {
  try {
    const stats = (statfs || require('fs').statfsSync)(targetPath);
    const available = Number(stats && stats.bavail);
    const blockSize = Number(stats && stats.bsize);
    if (!Number.isFinite(available) || !Number.isFinite(blockSize)) return -1;
    return available * blockSize;
  } catch (error) {
    void error;
    return -1;
  }
}

/** 临时库开销的余量：VACUUM 期间还要落 WAL、临时排序文件等。 */
const WORKSPACE_MARGIN = 1.15;
const WORKSPACE_BASE_BYTES = 64 * 1024 * 1024;

/**
 * VACUUM 需要的额外磁盘空间。它会另写一份「压缩后大小」量级的临时库，
 * 峰值占用 ≈ 现有文件（还在原地）+ 临时库，所以这里要的是新增的那份。
 *
 * 压缩后大小按 `page_count - freelist_count` 估，比直接拿文件大小当近似准得多——
 * 碎片多的库两者能差好几倍，用文件大小估会把本来能做的优化挡在门外。
 *
 * 估不出来（缺参数）返回 0，表示「不拦」：交给 SQLite 自己报错，
 * 总好过用错数据误判空间不足。
 *
 * @param {{pageSize?: number, pageCount?: number, freePages?: number, fileSize?: number}} stats
 * @returns {number} 需要的额外字节数
 */
function vacuumWorkspaceBytes(stats) {
  const pageSize = Number(stats && stats.pageSize) || 0;
  const pageCount = Number(stats && stats.pageCount) || 0;
  const freePages = Number(stats && stats.freePages) || 0;
  const fileSize = Number(stats && stats.fileSize) || 0;
  if (pageSize <= 0 || pageCount <= 0 || fileSize <= 0) return 0;
  const liveBytes = Math.max(1, pageCount - freePages) * pageSize;
  return Math.round(Math.min(fileSize, liveBytes) * WORKSPACE_MARGIN) + WORKSPACE_BASE_BYTES;
}

/**
 * VACUUM 真正能还回来的空间 = 库内空洞页。
 * 实测见过 12 GB 的库只有 1.7 MB 空洞——那种情况下 VACUUM 要重写整库、
 * 额外占十几 GB 临时空间，收益却可以忽略，确认弹窗里应该让用户先看到这个数字。
 */
function vacuumReclaimableBytes(stats) {
  const pageSize = Number(stats && stats.pageSize) || 0;
  const freePages = Number(stats && stats.freePages) || 0;
  if (pageSize <= 0 || freePages <= 0) return 0;
  return freePages * pageSize;
}

/** 人读的字节数。用 GB 显示 1.7 MB 会变成「0.0 GB」，等于没说。 */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1) + ' GB';
  if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
  if (value >= 1024) return (value / 1024).toFixed(1) + ' KB';
  return value + ' B';
}

/**
 * 磁盘不够就直说差多少，而不是让它跑到一半 I/O 失败（12.9 GB 的库做 VACUUM，
 * 中途写满盘比直接拒绝危险得多）。
 *
 * 临时库位置由 SQLite 决定（同目录或系统临时目录），所以每个卷都要够。
 *
 * @param {number} need 需要的额外字节数，0 表示未知 → 放行
 * @param {Array<{label: string, free: number}>} places 候选位置与各自可用字节（-1 = 未知）
 * @returns {string} 空串表示放行，否则是给用户看的原因
 */
function vacuumSpaceShortage(need, places) {
  if (!(need > 0)) return '';
  const list = places || [];
  const blocking = list.filter((place) => place.free >= 0 && place.free < need);
  if (!blocking.length) return '';
  const detail = list
    .map((place) => place.label + '可用 ' + (place.free < 0 ? '未知' : formatBytes(place.free)))
    .join('，');
  return (
    '磁盘空间不足：整理数据库需要额外约 ' +
    formatBytes(need) +
    ' 的临时空间，当前 ' +
    detail +
    '。\n\n请先腾出一些空间再试，或把图库数据迁到空间更大的磁盘（设置 → 媒体与存储 → 图库数据位置）。'
  );
}

module.exports = {
  aiIndexBusy,
  freeDiskBytes,
  vacuumWorkspaceBytes,
  vacuumReclaimableBytes,
  vacuumSpaceShortage,
  formatBytes,
};
