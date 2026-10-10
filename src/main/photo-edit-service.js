'use strict';

/**
 * 图片编辑的**编排层**：文件写盘之后，把派生数据与库行一起收敛到一致状态。
 *
 * 分工：
 *   · `image-edit.js`   —— 只做「像素 → 新字节」（旋转/翻转写回、裁剪另存）；不碰数据库。
 *   · 本模块            —— 重算缩略图 / dHash，更新库行，清缓存；桌面端与网页端**共用一份**。
 *   · `main.js` / `web-server.js` —— 只负责「接一层协议」（IPC / HTTP）与权限、忙判定。
 *
 * 🔴 为什么「编辑之后要跟着改的东西」必须收在一个地方：
 *    一次编辑会让 **文件字节、文件大小、修改时间、像素尺寸、缩略图、dHash、SHA-256** 同时失效。
 *    任何一项漏掉都是**静默的**：
 *      · 漏 `date_modified` ⇒ 四列记账时间戳（thumb_fail / header_fail / exif / dhash 的 mtime）
 *        永远对不上它，后台补全任务把这行当「从没处理过」，**反复重算**；
 *      · 漏 dHash ⇒ 像素变了而哈希没变，重复/相似检测按旧值分组；
 *      · 漏 SHA-256 ⇒ 同一张图的「精确重复」分组里会混进一张已经改过的图；
 *      · 漏缩略图 ⇒ 界面上还是转之前的图（用户会以为编辑没生效，然后再转一次）。
 *    这也是 `photo-edit-regression` 逐项钉死的清单。
 */

const fs = require('fs');
const path = require('path');

const imageEdit = require('./image-edit');
const { createSharpInput } = require('./sharp-input');
const { computeDhashFromPipeline, getDhashBuckets } = require('./perceptual-hash');
const {
  resizeThumb,
  normalizeThumbSize,
  THUMB_DEFAULT_QUALITY,
  THUMB_ENCODE_FORMAT,
} = require('./thumb-format');

/**
 * 建一个编辑服务。
 *
 * @param {object} deps
 * @param {object} deps.db 数据库实例
 * @param {function} [deps.getThumbOptions] 与扫描/补全**同一份**档位（`main.js#getThumbOptions`）
 * @param {Set<string>} [deps.videoExtensions] 带点的扩展名小写集合（判「视频不可编辑」）
 * @param {function} [deps.invalidateForRoot] 清某个根目录的目录/读池缓存，入参 rootId
 * @param {function} [deps.invalidateDerivedGroups] 清「重复 / 相似」分组缓存
 * @param {function} [deps.logWarn] 关键失败打点（生产 logger 是 warn 级，只打 info 等于没现场）
 */
function createPhotoEditService(deps) {
  var d = deps || {};
  var db = d.db;
  if (!db) throw new Error('photo-edit-service: 缺少 db');

  var getThumbOptions = typeof d.getThumbOptions === 'function' ? d.getThumbOptions : null;
  var videoExtensions = d.videoExtensions instanceof Set ? d.videoExtensions : new Set();
  var invalidateForRoot = typeof d.invalidateForRoot === 'function' ? d.invalidateForRoot : null;
  var invalidateDerivedGroups =
    typeof d.invalidateDerivedGroups === 'function' ? d.invalidateDerivedGroups : null;
  var logWarn = typeof d.logWarn === 'function' ? d.logWarn : null;

  /**
   * 编辑一律**全局串行**。
   *
   * 理由不是性能而是正确性：同一条链路上「写盘 → 读回算派生 → 更新库行」不是原子的，
   * 两次并发编辑同一张图会互相覆盖（后一次算派生时读到的可能是前一次刚写的字节，
   * 结果缩略图与库行对不上）。编辑本来就是低频的用户操作，串行没有任何代价。
   */
  var queue = Promise.resolve();

  function enqueue(fn) {
    var run = queue.catch(function () {}).then(fn);
    queue = run.catch(function () {});
    return run;
  }

  /** 取出一条**可编辑**的照片行；不可编辑的原因直接抛出（中文，可直接给用户看）。 */
  function loadEditableRow(photoId) {
    var id = parseInt(photoId, 10);
    if (!isFinite(id) || id <= 0) throw new Error('无效的图片 ID');
    // 🔴 用 `getPhotoForEdit` 而不是 `getFullPhoto`：后者不带 id / root_id / date_taken，
    //    那三列缺一个都会让后续的写回**静默影响 0 行**（见 database.js 里那条注释）。
    var row = db.getPhotoForEdit(id);
    if (!row || !row.file_path) throw new Error('图片记录不存在');
    var ext = path.extname(String(row.file_path)).toLowerCase();
    if (videoExtensions.has(ext)) throw new Error('视频不支持编辑');
    var denied = imageEdit.denyReason(row.file_path);
    if (denied) throw new Error(denied);
    if (!fs.existsSync(row.file_path)) throw new Error('文件不存在');
    return row;
  }

  /**
   * 重算一条**已落盘文件**的派生数据（缩略图 + dHash）。
   *
   * 🔴 `computeDhashFromPipeline` 必须取在 `resizeThumb` **之前**：后者会把实例消费掉。
   * 🔴 编辑后的文件 `orientation` 已被归一化成 1，所以这里「dHash 不旋转」与
   *    「缩略图 `.rotate()`」两套口径**天然一致** —— 这正是 P0 必须先归一化方向的原因。
   */
  async function computeDerived(filePath) {
    var si = await createSharpInput(filePath);
    var topts = (getThumbOptions && getThumbOptions()) || {};
    var size = normalizeThumbSize(topts.size);
    var quality = topts.quality != null ? topts.quality : THUMB_DEFAULT_QUALITY;
    var dhash = await computeDhashFromPipeline(si.instance);
    var thumb = await resizeThumb(si.instance, size, quality);
    return { dhash: dhash, thumb: thumb, size: size, quality: quality };
  }

  /** 把派生结果写进某一行（缩略图 / dHash / 尺寸 / 文件级元数据）。 */
  function writeDerivedToRow(photoId, derived, applied) {
    db.updatePhotoThumbnail(photoId, derived.thumb, {
      size: derived.size,
      format: THUMB_ENCODE_FORMAT,
    });
    db.updatePhotoDhash(
      photoId,
      derived.dhash,
      getDhashBuckets(derived.dhash),
      applied.dateModified,
      applied.size,
    );
    db.updatePhotoDimensions(photoId, applied.width, applied.height);
    db.updatePhotoFileMeta(photoId, {
      fileSize: applied.size,
      dateModified: applied.dateModified,
    });
  }

  /** 缓存失效：目录/读池 + 重复/相似分组。两件事分开注入，缺一个都不会报错只会「看着没变」。 */
  function invalidate(rootId) {
    if (invalidateForRoot && rootId) {
      try {
        invalidateForRoot(rootId);
      } catch (e) {
        if (logWarn) logWarn('[photo-edit] invalidateForRoot failed: ' + (e && e.message));
      }
    }
    if (invalidateDerivedGroups) {
      try {
        invalidateDerivedGroups();
      } catch (e2) {
        if (logWarn) logWarn('[photo-edit] invalidateDerivedGroups failed: ' + (e2 && e2.message));
      }
    }
  }

  /**
   * P0：旋转 / 翻转，**写回原文件**。
   *
   * 🔴 参数是**一串**动作（按顺序应用），不是一个：预览态编辑把用户连点的
   *    「转一下、翻一下、再转一下」攒成一个序列，保存时一次合成**一条**算子 ——
   *    所以「连点三次旋转再保存」与「直接转到 270°」产出**逐字节相同**的文件，
   *    画质不会因为多点了两次而多掉一代。传单个字符串仍然接受（兼容旧调用）。
   *    空序列抛「没有可应用的编辑」—— 挡的是「点了保存、文件一个字节没变」。
   *
   * @param {number} photoId
   * @param {string|string[]} actions `rotate-left` | `rotate-right` | `flip-h` | `flip-v`（或它们的数组）
   * @returns {Promise<{id:number, width:number, height:number, size:number, invalidated:boolean}>}
   */
  function transform(photoId, actions) {
    return enqueue(async function () {
      var row = loadEditableRow(photoId);
      var applied = await imageEdit.applyTransform(row.file_path, actions);
      var derived = await computeDerived(applied.filePath);

      writeDerivedToRow(row.id, derived, applied);

      // 🔴 文件内容变了 ⇒ SHA-256 指纹失效。不清就会让「精确重复」按旧指纹分组，
      //    把一张已经改过的图和它的原件判成同一个。清空后重复检测任务会重新捡起这一行。
      db.updatePhotoHash(row.id, null);

      invalidate(row.root_id);
      return {
        id: row.id,
        width: applied.width,
        height: applied.height,
        size: applied.size,
        // 🔴 `dateModified` 必须回给调用端：界面的预览/缩略图 URL 缓存键是
        //    `file_size + date_modified` 两个字段拼的（`utils.js#photoCacheVersion`）。
        //    只给 size 的话，一次**翻转对称图 / 180° 旋转**完全可能产出同样大小的文件
        //    ⇒ 缓存键不变 ⇒ 浏览器命中旧图 ⇒ 用户以为没生效，再点一次。
        dateModified: applied.dateModified,
        invalidated: true,
      };
    });
  }

  /**
   * 裁剪另存 + 入库共用的一段（`crop()` 与 `applyEdit()` 都走这里）。
   *
   * 🔴 抽出来不是为了少写几行，而是因为这段里有三条**只在真跑一遍才看得见**的约束：
   *    `insertPhoto` 要凑齐 `root_id` / `date_taken`（缺一个就被 `INSERT OR IGNORE` 静默吞掉）、
   *    新 id 只能走 `getPhotoIdByFilePath`（`lastInsertRowid` 在 IGNORE 时是别的表的 rowid）、
   *    `date_taken` 必须**跟随原图**（否则每次裁剪都在「今天」多一张）。
   *    两份实现 = 这三条一定会有一份漂移。
   */
  async function createCropCopy(row, rect) {
    var applied = await imageEdit.cropToCopy(row.file_path, rect);
    var derived = await computeDerived(applied.filePath);

    var outExt = path.extname(applied.filePath);
    db.insertPhoto({
      rootId: row.root_id,
      folderPath: path.dirname(applied.filePath),
      fileName: path.basename(applied.filePath),
      filePath: applied.filePath,
      fileSize: applied.size,
      fileType: outExt.replace('.', '').toLowerCase(),
      width: applied.width,
      height: applied.height,
      dateTaken: row.date_taken || applied.dateModified,
      dateModified: applied.dateModified,
      thumbnail: derived.thumb,
      hasThumbnail: true,
      thumbSize: derived.size,
      thumbFormat: THUMB_ENCODE_FORMAT,
    });

    // 🔴 禁 `lastInsertRowid`：`insertPhoto` 是 `INSERT OR IGNORE`，被忽略时
    //    那个值是**连接级上一次插入**的 rowid（可能是别的表），会指向一条无关的行。
    var newId = db.getPhotoIdByFilePath(applied.filePath);
    if (!newId) throw new Error('裁剪副本入库失败');
    if (newId === row.id) throw new Error('裁剪副本与原件指向同一行');

    writeDerivedToRow(newId, derived, applied);
    db.markPhotoDerived(newId, row.id);

    return {
      id: newId,
      filePath: applied.filePath,
      width: applied.width,
      height: applied.height,
      size: applied.size,
      sourceId: row.id,
    };
  }

  /**
   * 一次性应用「一串变换 + 一个裁剪」（预览态编辑点「保存」时的**唯一**入口）。
   *
   * 🔴 为什么必须合成**一个**队列槽、而不是让调用端分两次调 `transform` 再 `crop`：
   *    1. `rect` 用的是**变换之后**那张图的像素坐标（用户在预览里看到的坐标系）。
   *       两次调用之间队列会让出，另一端（网页端）可能插进来再改一次文件 ⇒
   *       第二次调用拿到的图已经不是 `rect` 对应的那张 ⇒ 裁错地方且不报错。
   *    2. 顺序（先写回变换、再裁剪副本）是一条**契约**，两端各写一遍必然有一端写反。
   *
   * 顺序与理由：先 `applyTransform`（原地写回、方向归一化成 1）⇒ 之后 `cropToCopy`
   * 读到的就是「用户看到的那张图」，`.extract()` 直接吃 rect（红线 ④）。
   * 若只有裁剪（`actions` 为空），`cropToCopy` 自己会先 `.rotate()` 转正，坐标系同样自洽。
   *
   * @param {number} photoId
   * @param {{actions?: string[], crop?: {left:number,top:number,width:number,height:number}|null}} options
   * @returns {Promise<{id:number, width:number, height:number, size:number,
   *                    dateModified:string|null, crop:object|null}>}
   */
  function applyEdit(photoId, options) {
    return enqueue(async function () {
      var opts = options || {};
      var actions = imageEdit.normalizeActions(opts.actions, true);
      var hasCrop = !!(opts.crop && Number(opts.crop.width) > 0 && Number(opts.crop.height) > 0);
      // 🔴 空请求必须抛错：静默返回成功等于让用户以为「保存了」而磁盘一个字节没变。
      if (!actions.length && !hasCrop) throw new Error('没有可应用的编辑');

      var row = loadEditableRow(photoId);
      var out = {
        id: row.id,
        width: null,
        height: null,
        size: null,
        // 没做变换时 `dateModified` 保持 null：调用端据此判断「缓存键要不要翻新」，
        // 而不是拿一个没变过的旧时间戳去覆盖。
        dateModified: null,
        crop: null,
      };

      if (actions.length) {
        var applied = await imageEdit.applyTransform(row.file_path, actions);
        var derived = await computeDerived(applied.filePath);
        writeDerivedToRow(row.id, derived, applied);
        db.updatePhotoHash(row.id, null);
        out.width = applied.width;
        out.height = applied.height;
        out.size = applied.size;
        out.dateModified = applied.dateModified;
      }

      if (hasCrop) {
        out.crop = await createCropCopy(row, opts.crop);
      }

      invalidate(row.root_id);
      return out;
    });
  }

  /**
   * P1：裁剪并**另存副本**，副本作为一条**正常行**进库（用户要能在图库里看到它）。
   *
   * 🔴 `rect` 用**用户看到的图**的坐标系（EXIF 已转正）—— 换算在 `image-edit` 里做。
   * 具体落库那一段在 `createCropCopy()`（与 `applyEdit` 共用，理由见那边的注释）。
   *
   * @returns {Promise<{id:number, filePath:string, width:number, height:number, size:number, sourceId:number}>}
   */
  function crop(photoId, rect) {
    return enqueue(async function () {
      var row = loadEditableRow(photoId);
      var result = await createCropCopy(row, rect);
      invalidate(row.root_id);
      return result;
    });
  }

  return { transform: transform, crop: crop, applyEdit: applyEdit };
}

module.exports = { createPhotoEditService: createPhotoEditService };
