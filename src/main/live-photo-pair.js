'use strict';

/**
 * Live Photo 配对任务 —— 把「伴生视频」与「它的图片」认出来并双向记账。
 *
 * ## 它解决什么
 *
 * iPhone 的 Live Photo 是一对文件（`IMG_1234.HEIC` + `IMG_1234.MOV`，后者约 3 秒）。
 * 扫描器只按扩展名收文件，于是那个 MOV 变成一个**独立视频**：同一张图片在库里
 * 出现两次（图片列表一次、视频列表一次），视频总数也被灌水。本任务把两者关联起来，
 * 供查询层把伴生视频从列表与统计中排除（见 `database.js#_sqlLiveStillIsMotionExpr`）。
 *
 * ## 为什么不能靠文件名配对（这是本模块存在的全部理由）
 *
 * 最直觉的判据是「同目录 + 同 basename」。本机真库实测（156 万行）：
 * **5677 对**命中，其中体积比 > 300% 的有 **4525 对** —— 那是写真集
 * 「封面图 + 正片」的标准形态（`xxx (1).jpg` ↔ `xxx (1).mp4`，后者 1.3 GB）。
 * 按文件名判伴生并隐藏 = **凭空藏掉用户几千个视频**。
 *
 * ⇒ 判据只能落在 Apple 写进 MOV 的 `com.apple.quicktime.content.identifier` 上
 *   （见 `live-photo.js` 头注释）。文件名配对在本模块中**只用于把候选缩到
 *   「有可能配对」的几百个**，不用于定案 —— 定案一律看 identifier。
 *
 * ## 收敛性与三态
 *
 * `live_still_id`：`NULL` = 还没探查 / `0` = 不作为伴生隐藏 / `> 0` = 已配对，值为图片 id。
 * 🔴 **无论判定结果是什么都必须落一个终态**（0 或 id），否则下一轮又会把它取出来
 *    重读一遍盘 —— 而真库里绝大多数视频**永远也不会**是 Live Photo。
 *    这与 `thumb_fail_mtime` / `exif_mtime` 是同一套「已检查标记」思路。
 *
 * ⚠️ 读文件失败（不存在 / 无权限 / 网络盘掉线）也写 `0`。这是**刻意**的取舍：
 *    读一个 MOV 的文件头远比生成缩略图简单，失败率极低；而为了那极少数情况
 *    再加一个「失败记账列 + 自愈判据」，会让本就不简单的三态变成四态。
 *    代价是「网络盘临时掉线」会把一个真伴生视频误判成普通视频 —— 后果只是它
 *    继续出现在视频列表里（**非破坏性**，而且用户重扫时会因行被 UPDATE 而保留原值，
 *    极端情况下需要手动重扫整盘才纠正）。这条取舍是有意的，不要顺手「优化」成重试。
 *
 * ## 性能
 *
 * 候选查询刻意用 `file_type IN ('mov','MOV')` 而不是项目里惯用的
 * `lower(replace(file_type,'.',''))='mov'`：真库上量过执行计划，后者是
 * `SCAN photos USING COVERING INDEX idx_photos_type`（**扫全部 156 万条索引项**），
 * 前者是 `SEARCH ... (file_type=?)`（只命中 4554 条）。真库里 `file_type` 实测
 * 100% 是小写不带点（`SELECT COUNT(*) FROM photos WHERE file_type <> lower(file_type)`
 * 与 `instr(file_type,'.')>0` 都是 0），所以两个大小写变体足够覆盖。
 */

const logger = require('./logger');
const livePhoto = require('./live-photo');

/** 读盘（async）段与写库（同步）段的切分粒度 */
const PAIR_BATCH = 200;
/** 一次取多少候选（取回后在内存里再按 PAIR_BATCH 切） */
const FETCH_LIMIT = 4000;
/** 连续多少轮取不到候选就收工（防「取到就写终态」万一有一条没写成功时死循环） */
const MAX_EMPTY_ROUNDS = 2;

/** 把 `live-photo.js` 的扩展名集合渲染成 SQL 的 IN 列表（大小写两个变体）。 */
function extInList(extSet) {
  const parts = [];
  for (const ext of extSet) {
    const v = String(ext).replace(/^\./, '');
    parts.push("'" + v + "'", "'" + v.toUpperCase() + "'");
  }
  return parts.join(', ');
}

// 🔴 两个 IN 列表都从 live-photo.js 的集合**派生**，不手写：判据换一处就必须两处同换。
const MOTION_TYPE_IN = extInList(livePhoto.LIVE_MOTION_EXTENSIONS);
const STILL_TYPE_IN = extInList(livePhoto.LIVE_STILL_EXTENSIONS);

/**
 * 候选：还没探查过的伴生视频候选。
 * ⚠️ 刻意**不加 ORDER BY** —— 加了就会让规划器放弃 `idx_photos_type` 的 SEARCH
 *    去做临时 B 树排序。顺序无关紧要：每轮处理完的行会落终态并退出候选集，
 *    所以「再取一次 LIMIT」天然就是下一批。
 */
const CANDIDATE_SQL = `
  SELECT id, file_path, folder_path, file_size
  FROM photos
  WHERE file_type IN (${MOTION_TYPE_IN}) AND live_still_id IS NULL
  LIMIT ?
`;

/**
 * 在同一个目录里找配对的静态图。
 *
 * 🔴 stem 的算法必须与 `live-photo.js#stemOf()` **逐字等价**（都是「去掉最后一段
 *    扩展名、转小写」）：一边用 SQL 的 substr 算、另一边用 JS 的 lastIndexOf 算，
 *    在「文件名里含多个点」（`abc.1.jpg`）时就会分叉，症状是「桌面端配上、网页端配不上」。
 *    回归牙里有专门一条拿真实文件名对比两个实现。
 */
const FIND_STILL_SQL = `
  SELECT id FROM photos
  WHERE folder_path = ?
    AND file_type IN (${STILL_TYPE_IN})
    AND lower(substr(file_name, 1, length(file_name) - length(replace(file_type, '.', '')) - 1)) = ?
  LIMIT 1
`;

const MARK_MOTION_SQL = 'UPDATE photos SET live_still_id = ? WHERE id = ?';
const MARK_STILL_SQL = 'UPDATE photos SET live_motion_id = ? WHERE id = ?';

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 跑一轮配对，直到候选集取空。
 *
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db 原生 better-sqlite3 实例
 * @param {{run:function(string,function,object):Promise<any>}} [deps.queue] 写闸门（`dbWriteQueue`）
 * @param {number} [deps.priority] 入队优先级（`PRIORITY.IDLE`）
 * @param {function} [deps.onProgress] 每批回调 `({scanned,matched,probed})`
 * @param {function} [deps.shouldStop] 返回 true 则提前收工（扫描开始时要让路）
 * @returns {Promise<{scanned:number, matched:number, probed:number, bytes:number, stopped:boolean, ms:number}>}
 */
async function runLivePhotoPairing(deps) {
  deps = deps || {};
  const raw = deps.db;
  const queue = deps.queue;
  const priority = deps.priority;
  const onProgress = typeof deps.onProgress === 'function' ? deps.onProgress : null;
  const shouldStop = typeof deps.shouldStop === 'function' ? deps.shouldStop : null;

  const stats = { scanned: 0, matched: 0, probed: 0, bytes: 0, stopped: false, ms: 0 };
  if (!raw || typeof raw.prepare !== 'function') return stats;
  const t0 = Date.now();

  const candStmt = raw.prepare(CANDIDATE_SQL);
  const stillStmt = raw.prepare(FIND_STILL_SQL);
  const markMotionStmt = raw.prepare(MARK_MOTION_SQL);
  const markStillStmt = raw.prepare(MARK_STILL_SQL);

  let emptyRounds = 0;
  while (emptyRounds < MAX_EMPTY_ROUNDS) {
    if (shouldStop && shouldStop()) {
      stats.stopped = true;
      break;
    }

    let candidates;
    try {
      candidates = candStmt.all(FETCH_LIMIT);
    } catch (eQuery) {
      logger.warn('[live-photo] 取候选失败：' + (eQuery && eQuery.message ? eQuery.message : eQuery));
      break;
    }
    if (!candidates || !candidates.length) {
      emptyRounds++;
      continue;
    }
    emptyRounds = 0;

    for (let i = 0; i < candidates.length; i += PAIR_BATCH) {
      const batch = candidates.slice(i, i + PAIR_BATCH);
      // ---- 第一段：读盘（async，**不占写锁**）----
      const decisions = [];
      for (const row of batch) {
        if (shouldStop && shouldStop()) {
          stats.stopped = true;
          break;
        }
        stats.scanned++;
        // 🔴 **先做廉价的一步**：同目录有没有同名图片。
        //    没有 ⇒ 不可能是 Live Photo 的伴生视频（伴生视频必然有配套图片），
        //    直接落终态，连盘都不用读。真库 4554 个 MOV 里大多数没有同名图片，
        //    这一步省掉的 I/O 是数量级的（单个 MOV 探针 3~23 ms，且其中不乏 GB 级）。
        //    ⚠️ 判据没变 —— 定案仍然只看 identifier（`isLivePhoto`），
        //    文件名配对在这里只是**廉价预筛**，不是判据本身。
        let stillId = 0;
        let info = null;
        try {
          const hit = stillStmt.get(row.folder_path, livePhoto.stemOf(row.file_path));
          if (hit) {
            info = await livePhoto.inspectLiveMotion(row.file_path, row.file_size);
            stats.probed++;
            stats.bytes += (info && info.probeBytes) || 0;
            if (info && info.isLivePhoto) {
              stillId = Number(hit.id) || 0;
            }
          }
        } catch (eProbe) {
          // 读盘失败 / 查询失败都落「不作为伴生隐藏」——理由见文件头「收敛性与三态」。
          void eProbe;
          stillId = 0;
        }
        if (stillId > 0) {
          stats.matched++;
        } else if (info && info.isLivePhoto) {
          // 是伴生视频，但配对图片的 id 取不到（极度罕见：查询命中却拿到空 id）。
          logger.log('[live-photo] 伴生视频找不到配对图片，按普通视频处理：' + row.file_path);
        }
        decisions.push({ id: row.id, stillId: stillId });
      }

      // ---- 第二段：写库（同步、按批入闸门）----
      const applyBatch = () => {
        for (const d of decisions) {
          markMotionStmt.run(d.stillId, d.id);
          if (d.stillId > 0) markStillStmt.run(d.id, d.stillId);
        }
      };
      if (queue && typeof queue.run === 'function') {
        // 🔴 显式传 priority：写闸门不传时默认落 `INDEX` 档，那是「与建索引同档」——
        //    本任务读的是成千上万个文件头，必须让用户操作与有终点的修复类先走。
        await queue.run('live-photo-pair', applyBatch, { priority: priority });
      } else {
        raw.transaction(applyBatch)();
      }

      if (onProgress) {
        try {
          onProgress({
            scanned: stats.scanned,
            matched: stats.matched,
            probed: stats.probed,
          });
        } catch (eCb) {
          void eCb;
        }
      }
      if (stats.stopped) break;
      await yieldToEventLoop();
    }

    if (stats.stopped) break;
  }

  stats.ms = Date.now() - t0;
  if (stats.scanned > 0) {
    logger.log(
      '[live-photo] 配对完成：探查 ' +
        stats.scanned +
        ' 个候选，识别出 ' +
        stats.matched +
        ' 对 Live Photo，读盘 ' +
        Math.round(stats.bytes / 1024) +
        ' KB，耗时 ' +
        stats.ms +
        ' ms' +
        (stats.stopped ? '（让路中断）' : ''),
    );
  }
  return stats;
}

/** 还有多少行没探查过（排查「任务跑没跑」的唯一读数）。 */
function countPendingPairing(raw) {
  try {
    const row = raw
      .prepare(
        'SELECT COUNT(*) AS n FROM photos WHERE file_type IN (' +
          MOTION_TYPE_IN +
          ') AND live_still_id IS NULL',
      )
      .get();
    return row ? Number(row.n) || 0 : 0;
  } catch (eCount) {
    void eCount;
    return -1;
  }
}

module.exports = {
  PAIR_BATCH,
  FETCH_LIMIT,
  MOTION_TYPE_IN,
  STILL_TYPE_IN,
  CANDIDATE_SQL,
  FIND_STILL_SQL,
  extInList,
  runLivePhotoPairing,
  countPendingPairing,
};
