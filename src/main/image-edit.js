'use strict';

/**
 * 图片编辑的**图像层唯一实现源**：桌面端 IPC 与网页端 API 共用这一份。
 *
 * 🔴 为什么必须共用而不是两端各写一份：本模块承载的行为里有一半是**实测出来的**
 *    （sharp 的算子顺序、`extract` 的坐标系、orientation 归一化），任何一份抄错
 *    都不会报错 —— 症状只是「这张图转出来是歪的 / 裁错了地方」。项目里同类教训已有
 *    （见 `sharp-input.js` 头部「两处各写必然漂移」那段）。
 *
 * 本模块**只做三件事**：读 exif 方向 → 算出一次性的 sharp 算子 → 原子写盘。
 * 「重算缩略图 / dHash / 更新库行」属于编排，在 `photo-edit-service.js` 里。
 *
 * ============================ 三条实测红线（勿凭印象改） ============================
 *
 * ① **sharp 的算子顺序是「flip/flop 先、rotate 后」**（实测，见 `.workbuddy/tmp/sharp-op-order-probe.js`）：
 *    `p.rotate(90).flop()` 算的是 `Fh ∘ R90`，**不是**「先转正再水平翻转」。
 *    所以要表达「先按 EXIF 转正、再做用户的翻转」，旋转角必须**取反补偿**
 *    （`Fh ∘ R' = R ∘ Fh` ⇒ `R' = R⁻¹`），见 `planEdit()` 里的推导。
 *    ⚠️ 这条与直觉相反，第一版就是照直觉写的（`rotate(exifAngle).flop()`），
 *       对 orientation=1/3/8 恰好正确、只在 6/8（竖向相机照）+ 翻转时错 —— 静默歪图。
 *
 * ② **`.rotate(angle)` 显式给角度时 sharp 不会去读 EXIF**，而 `.rotate()` 无参才按 EXIF 转。
 *    本模块一律用**显式角度**（自己解 EXIF），因为还要叠加用户要的角度。
 *
 * ③ **`.withMetadata({orientation: 1})` 是必须的、且必须显式设 1**：
 *    · 不调 `withMetadata` ⇒ sharp 默认**剥掉全部元数据**（实测 orientation 读回 `undefined`），
 *      拍摄时间 / GPS / 相机型号 / ICC 全丢 —— 对图库是数据事故；
 *    · 设了 1 之后像素已被物理转正，若还留着原来的 orientation（例如 6），
 *      `thumb-format.js#resizeThumb()` 里的 `.rotate()` 会**再转一次** ⇒ 缩略图转 180°。
 *
 * ④ `extract()` 工作在 **rotate 之后**的坐标系（实测）⇒ 裁剪矩形可以直接用
 *    「用户看到的图」的坐标，不需要自己换算。
 */

const fs = require('fs');
const path = require('path');

const { createSharpInput } = require('./sharp-input');

/** 用户可触发的四个动作。「左/右」是相对**当前显示**（= EXIF 已转正）说的。 */
const TRANSFORM_ACTIONS = ['rotate-left', 'rotate-right', 'flip-h', 'flip-v'];

/**
 * 能重新编码回原格式的 sharp 格式名。**写回的唯一格式判据**。
 *
 * 注意这里**拦不住 RAW**：`createSharpInput()` 对 cr2/crw/cr3 会抠出内嵌 JPEG 预览，
 * 读出来的 `format` 是 `jpeg` —— 若不先按扩展名拒绝，就会把一张预览图**写回 .cr2 文件**，
 * 等于毁掉原片。所以调用方必须先过 `denyReason()`（见下）。
 */
const EDITABLE_FORMATS = ['jpeg', 'png', 'webp', 'tiff', 'avif', 'heif'];

/** 旋转写回的重编码画质。旋转本身必须重编码，用高画质把这次的损失压到最小。 */
const JPEG_EDIT_QUALITY = 95;

/** 临时文件后缀。与目标**同目录**（同分区）⇒ rename 才是原子的。 */
const TMP_SUFFIX = '.aurora-edit-tmp';

/** 裁剪副本的文件名后缀与最大去重序号。 */
const CROP_SUFFIX = '_crop';
const MAX_CROP_VARIANTS = 999;

/**
 * 一律**拒绝编辑**的扩展名（走扩展名判据，不是 sharp 的 format 判据）。
 *
 * 两类：
 *   · RAW：`createSharpInput()` 会给出一张**内嵌预览**，写回等于拿预览覆盖原片；
 *   · 动图 / 矢量：gif 写回会丢动画（sharp 输出静态帧）、svg 是文本、都不是「编辑」语义。
 *
 * ⚠️ RAW 那一组必须与 `main.js#RAW_EXTENSIONS` 保持同步（那边是浏览层判据），
 *    加上 `sharp-input.js#OWN_DECODER_RAW_EXTENSIONS`（那边是**扩展名**清单，
 *    main.js 的 RAW_EXTENSIONS 里没有 crw / cr3）。守护 `photo-edit-regression`
 *    会逐项比对这三处的并集。
 */
const DENIED_EXTENSIONS = new Set([
  // —— 与 main.js#RAW_EXTENSIONS 对齐 ——
  '.cr2',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2',
  '.raw',
  // —— 与 sharp-input.js#OWN_DECODER_RAW_EXTENSIONS 对齐（main.js 那一份里没有）——
  '.crw',
  '.cr3',
  // —— 非「编辑」语义 ——
  '.gif',
  '.svg',
]);

/**
 * EXIF orientation(1–8) → `{ a, p, q }`，语义是
 *    **正确显示的像素 = R_a ∘ Fh^p ∘ Fv^q**
 * 即「先镜像、后旋转」（与 sharp 的实际执行顺序一致，这样后面可以直接映射到算子）。
 *
 * 不变量：**不允许 p 与 q 同时为 1**（`Fh ∘ Fv = R180`，写成纯旋转更不容易错）。
 * 表里 8 种都能满足这个形式 —— 所以**不需要**任何「先 auto-orient 落字节再处理」的两段式。
 */
const ORIENTATION_DECOMPOSITION = {
  1: { a: 0, p: 0, q: 0 },
  2: { a: 0, p: 1, q: 0 }, // 水平镜像
  3: { a: 180, p: 0, q: 0 },
  4: { a: 0, p: 0, q: 1 }, // 垂直镜像
  // ⚠️ 5 与 7 的旋转角**与直觉相反**，别按「5 在前所以是 90」去改：
  //    按 sharp 的实际语义（`.rotate(90)` = 顺时针 90、`.flop()` = 水平镜像、
  //    `flip()` = 垂直镜像，且算子顺序是「先翻后转」）推出来的是
  //      orientation 5（transpose，沿主对角线）= R270 ∘ Fh
  //      orientation 7（transverse，沿副对角线）= R90 ∘ Fh
  //    第一版按直觉写成 90 / 270，实测 8 种方向里恰好只错这两个
  //    （`.workbuddy/tmp/plan-edit-probe.js` 的 ① 与 ③ 组会红）。
  5: { a: 270, p: 1, q: 0 }, // transpose
  6: { a: 90, p: 0, q: 0 }, // 竖向相机照最常见的一档
  7: { a: 90, p: 1, q: 0 }, // transverse
  8: { a: 270, p: 0, q: 0 },
};

/** 归一化 sharp 报出来的格式名（`jpeg` / `png` / …）。未知返回 `''`。 */
function normalizeSharpFormat(format) {
  var f = format ? String(format).trim().toLowerCase() : '';
  if (f === 'jpg') return 'jpeg';
  if (f === 'tif') return 'tiff';
  return EDITABLE_FORMATS.indexOf(f) >= 0 ? f : '';
}

/** 取扩展名（小写，含点）。 */
function extensionOf(filePath) {
  var ext = path.extname(String(filePath || ''));
  return ext ? ext.toLowerCase() : '';
}

/**
 * 拒绝编辑的原因；可以编辑时返回 `null`。
 *
 * 🔴 判据是**扩展名**不是 sharp 的 format —— 理由见 `EDITABLE_FORMATS` 的注释
 *    （RAW 会被 sharp 读成 jpeg，只按 format 判会放它过去并毁掉原片）。
 */
function denyReason(filePath) {
  var ext = extensionOf(filePath);
  if (!ext) return '无法识别文件类型';
  if (DENIED_EXTENSIONS.has(ext)) {
    if (ext === '.gif' || ext === '.svg') return '该格式不支持编辑';
    return 'RAW 文件不支持编辑（会破坏原始数据）';
  }
  return null;
}

/** 把 EXIF orientation 分解成 `{a,p,q}`（未知 / 缺失按 1 处理）。 */
function decomposeOrientation(orientation) {
  var o = parseInt(orientation, 10);
  var base = ORIENTATION_DECOMPOSITION[o] || ORIENTATION_DECOMPOSITION[1];
  return { a: base.a, p: base.p, q: base.q };
}

/**
 * 在已有分解上**再叠一个**用户动作（纯函数）。
 *
 * 🔴 翻转那一支的「角度取反」就是「sharp 先翻后转」逼出来的补偿（红线 ①），不是笔误：
 *    要把 T 从左边挪到 R 的右边 —— `F ∘ R_a = R_{-a} ∘ F`。
 * 🔴 维持不变量：**不允许 p 与 q 同时为 1**（`Fh ∘ Fv = R180`，归一化成纯旋转）。
 *
 * 之所以把这一步单独拆出来：预览态要**按顺序叠加一整串动作**（用户可能连按三次旋转再翻转），
 * 而叠加的每一步都必须在同一个 `{a,p,q}` 上继续 —— 见 `planEditSequence`。
 * ⚠️ 拆出来**不改变** `planEdit` 的任何取值（守护有 8×4 穷举 + 真调用对账）。
 */
function composeAction(state, action) {
  if (TRANSFORM_ACTIONS.indexOf(action) < 0) {
    throw new Error('未知的编辑动作：' + action);
  }
  var a = state.a;
  var p = state.p;
  var q = state.q;

  if (action === 'rotate-left' || action === 'rotate-right') {
    // T 是旋转 ⇒ 直接与 a 相加（R_t ∘ R_a = R_{t+a}），镜像位不变。
    var t = action === 'rotate-right' ? 90 : 270;
    a = (a + t) % 360;
  } else {
    a = (360 - a) % 360;
    if (action === 'flip-h') p = p ? 0 : 1;
    else q = q ? 0 : 1;
    if (p && q) {
      p = 0;
      q = 0;
      a = (a + 180) % 360;
    }
  }
  return { a: a, p: p, q: q };
}

/**
 * 把「当前 EXIF 方向 + **一个**用户动作」合成一条 sharp 算子。
 *
 * @param {number} orientation EXIF orientation（1–8；未知/缺失按 1 处理）
 * @param {string} action `rotate-left` | `rotate-right` | `flip-h` | `flip-v`
 * @returns {{angle:number, flop:boolean, flip:boolean}} 直接映射到 sharp 的
 *          `.flop()` / `.flip()` / `.rotate(angle)`（顺序无所谓，sharp 内部固定先翻后转）
 */
function planEdit(orientation, action) {
  var st = composeAction(decomposeOrientation(orientation), action);
  return { angle: st.a, flop: !!st.p, flip: !!st.q };
}

/**
 * 归一化成**动作数组**。接受单个动作字符串（兼容旧调用）或数组。
 * 空序列默认抛错；`allowEmpty` 为真时返回 `[]`（保存路径可能「只裁剪、不旋转」）。
 *
 * 🔴 空序列在**默认**下必须抛错，不能静默返回「无操作」：预览态的「保存」就是靠它挡住
 *    「点了保存、文件一个字节没变」这种看起来成功、实际什么都没做的路径。
 */
function normalizeActions(input, allowEmpty) {
  var list;
  if (typeof input === 'string') list = [input];
  else if (Array.isArray(input)) list = input.slice();
  else list = [];
  if (!list.length && !allowEmpty) throw new Error('没有可应用的编辑');
  for (var i = 0; i < list.length; i++) {
    if (TRANSFORM_ACTIONS.indexOf(list[i]) < 0) {
      throw new Error('未知的编辑动作：' + list[i]);
    }
  }
  return list;
}

/**
 * 把「当前 EXIF 方向 + **一串**用户动作」**按数组顺序**依次叠成一条算子。
 *
 * 预览态编辑（点旋转只是转入待保存状态）最终会攒出一串动作，
 * 保存时合成**一条**算子 ⇒ 仍然只有一次编码，画质不会因为「多点了两次」而多掉一代。
 *
 * ⚠️ 顺序不可交换：`rotate-right` 后再 `flip-h` 与反过来得到的是不同变换。
 */
function planEditSequence(orientation, actions) {
  var list = normalizeActions(actions);
  var st = decomposeOrientation(orientation);
  for (var i = 0; i < list.length; i++) st = composeAction(st, list[i]);
  return { angle: st.a, flop: !!st.p, flip: !!st.q };
}

/** 把算好的算子挂到 sharp pipeline 上（调用顺序无关，sharp 内部先翻后转）。 */
function applyPlan(pipeline, plan) {
  var p = pipeline;
  if (plan.flop) p = p.flop();
  if (plan.flip) p = p.flip();
  if (plan.angle) p = p.rotate(plan.angle);
  return p;
}

/**
 * 统一编码出口。**`withMetadata({orientation: 1})` 收在这里**，
 * 保证「任何写回路径都不可能漏掉 direction 归一化」（红线 ③）。
 *
 * 🔴 不要在任何调用点自己写 `.jpeg()` / `.png()` —— 那正是「有的路径归一化了、
 *    有的没有」的起点，而症状只在带 EXIF 方向的图片上以「缩略图转了 180°」出现。
 */
function encodeToFormat(pipeline, format) {
  var p = pipeline.withMetadata({ orientation: 1 });
  switch (format) {
    case 'jpeg':
      return p.jpeg({ quality: JPEG_EDIT_QUALITY, progressive: true, mozjpeg: true });
    case 'png':
      return p.png({ compressionLevel: 9 });
    case 'webp':
      return p.webp({ quality: 95 });
    case 'tiff':
      return p.tiff({ compression: 'lzw' });
    case 'avif':
      return p.avif({ quality: 90 });
    case 'heif':
      return p.heif({ quality: 90 });
    default:
      throw new Error('不支持的图片格式：' + format);
  }
}

/**
 * 与 `scanner.js#formatMtimeFromDate` **逐字一致**的 `date_modified` 格式化。
 *
 * 为什么必须一致：库内 `date_modified` 是扫描器用这个格式写进去的，
 * 而 `thumb_fail_mtime` / `header_fail_mtime` / `exif_mtime` / `dhash_mtime` 四列记账
 * 时间戳都拿它做判据。格式差一个字符（例如带毫秒）⇒ 记账列永远不等于 `date_modified`
 * ⇒ 那几行会被后台任务**无限重试**，且没有任何报错。
 * 守护 `photo-edit-regression` 直接读两个源文件比对这两段实现。
 *
 * ⚠️ 之所以在这里复制一份而不是 require scanner.js：scanner.js 是 **worker 线程入口**，
 *    顶层有副作用，主进程 require 它会把 worker 的初始化跑一遍。
 */
function formatDbMtime(date) {
  if (!date || typeof date.toISOString !== 'function') return '';
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

/** 原子替换：先写同目录临时文件，再 rename 覆盖。失败时清掉临时文件。 */
async function writeAtomic(targetPath, buffer) {
  var tmpPath = targetPath + TMP_SUFFIX;
  await fs.promises.writeFile(tmpPath, buffer);
  try {
    await fs.promises.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch (eClean) {
      void eClean;
    }
    throw err;
  }
}

/**
 * 旋转 / 翻转**写回原文件**（P0）。
 *
 * 流程：自己解 EXIF 方向 → 与用户动作合成一条算子 → 一次编码（orientation 归一化为 1）
 * → 同目录临时文件 + rename 原子替换。
 *
 * 🔴 **只有一次编码**：任何「先 auto-orient 落一遍字节、再处理一遍」的写法对有损格式
 *    等于白掉一代画质，而且没有必要 —— 8 种 orientation 全都能用一条算子表达。
 *    预览态攒出的**一串**动作也走同一条路（`planEditSequence`），所以「连点三次旋转再保存」
 *    与「一次转到 270°」产出**逐字节相同**的文件。
 *
 * @param {string|string[]} actions 一个动作，或**按顺序**应用的动作数组
 * @returns {Promise<{filePath:string, format:string, width:number, height:number,
 *                    size:number, dateModified:string}>}
 *          `width` / `height` 是**输出文件**的真实尺寸（从编码结果里读，不靠推算）。
 */
async function applyTransform(filePath, actions) {
  var denied = denyReason(filePath);
  if (denied) throw new Error(denied);

  var si = await createSharpInput(filePath);
  var meta = await si.instance.metadata();
  var format = normalizeSharpFormat(meta.format);
  if (!format) throw new Error('不支持的图片格式：' + (meta.format || '未知'));

  var plan = planEditSequence(meta.orientation, actions);
  var out = await encodeToFormat(applyPlan(si.instance, plan), format).toBuffer({
    resolveWithObject: true,
  });

  await writeAtomic(filePath, out.data);
  var st = await fs.promises.stat(filePath);
  return {
    filePath: filePath,
    format: format,
    width: out.info.width,
    height: out.info.height,
    size: st.size,
    dateModified: formatDbMtime(st.mtime),
  };
}

/** 裁剪矩形归一化：夹到图内、拒绝空区域。 */
function normalizeCropRect(rect, maxWidth, maxHeight) {
  var r = rect || {};
  var left = Math.max(0, Math.round(Number(r.left) || 0));
  var top = Math.max(0, Math.round(Number(r.top) || 0));
  var width = Math.round(Number(r.width) || 0);
  var height = Math.round(Number(r.height) || 0);
  if (!(width > 0) || !(height > 0)) throw new Error('裁剪区域无效');
  if (left >= maxWidth || top >= maxHeight) throw new Error('裁剪区域超出图片范围');
  if (left + width > maxWidth) width = maxWidth - left;
  if (top + height > maxHeight) height = maxHeight - top;
  if (!(width > 0) || !(height > 0)) throw new Error('裁剪区域超出图片范围');
  return { left: left, top: top, width: width, height: height };
}

/** 找一个不覆盖已有文件的副本路径：`原名_crop.jpg` / `原名_crop2.jpg` / … */
function uniqueCropPath(filePath) {
  var dir = path.dirname(filePath);
  var ext = path.extname(filePath);
  var stem = path.basename(filePath, ext);
  var candidate = path.join(dir, stem + CROP_SUFFIX + ext);
  var n = 2;
  while (fs.existsSync(candidate)) {
    if (n > MAX_CROP_VARIANTS) throw new Error('同名裁剪副本过多');
    candidate = path.join(dir, stem + CROP_SUFFIX + n + ext);
    n += 1;
  }
  return candidate;
}

/**
 * 裁剪并**另存副本**（P1）。永不覆盖任何已有文件。
 *
 * 🔴 入参 `rect` 用**用户看到的图**的坐标系（即 EXIF 已转正的坐标系）：
 *    实测 `.extract()` 作用于 rotate 之后（红线 ④），所以先 `.rotate()` 再 `.extract()` 即可，
 *    不需要自己按 orientation 换算矩形。
 *
 * 🔴 `withMetadata` 同样必须保留（不走 `encodeToFormat` 就会丢 EXIF / ICC）。
 *
 * @returns {Promise<{filePath:string, format:string, width:number, height:number,
 *                    size:number, dateModified:string}>}
 */
async function cropToCopy(filePath, rect) {
  var denied = denyReason(filePath);
  if (denied) throw new Error(denied);

  var si = await createSharpInput(filePath);
  var meta = await si.instance.metadata();
  var format = normalizeSharpFormat(meta.format);
  if (!format) throw new Error('不支持的图片格式：' + (meta.format || '未知'));

  // 用户看到的尺寸 = auto-orient 之后的尺寸；90/270 档要交换
  var o = parseInt(meta.orientation, 10) || 1;
  var swap = o === 5 || o === 6 || o === 7 || o === 8;
  var viewW = swap ? meta.height : meta.width;
  var viewH = swap ? meta.width : meta.height;

  var box = normalizeCropRect(rect, viewW, viewH);
  var outPath = uniqueCropPath(filePath);

  var out = await encodeToFormat(
    si.instance.rotate().extract({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    }),
    format,
  ).toBuffer({ resolveWithObject: true });

  await fs.promises.writeFile(outPath, out.data);
  var st = await fs.promises.stat(outPath);
  return {
    filePath: outPath,
    format: format,
    width: out.info.width,
    height: out.info.height,
    size: st.size,
    dateModified: formatDbMtime(st.mtime),
  };
}

module.exports = {
  TRANSFORM_ACTIONS: TRANSFORM_ACTIONS,
  EDITABLE_FORMATS: EDITABLE_FORMATS,
  DENIED_EXTENSIONS: DENIED_EXTENSIONS,
  TMP_SUFFIX: TMP_SUFFIX,
  CROP_SUFFIX: CROP_SUFFIX,
  ORIENTATION_DECOMPOSITION: ORIENTATION_DECOMPOSITION,
  JPEG_EDIT_QUALITY: JPEG_EDIT_QUALITY,
  normalizeSharpFormat: normalizeSharpFormat,
  extensionOf: extensionOf,
  denyReason: denyReason,
  decomposeOrientation: decomposeOrientation,
  composeAction: composeAction,
  planEdit: planEdit,
  normalizeActions: normalizeActions,
  planEditSequence: planEditSequence,
  applyPlan: applyPlan,
  encodeToFormat: encodeToFormat,
  formatDbMtime: formatDbMtime,
  writeAtomic: writeAtomic,
  applyTransform: applyTransform,
  normalizeCropRect: normalizeCropRect,
  uniqueCropPath: uniqueCropPath,
  cropToCopy: cropToCopy,
};
