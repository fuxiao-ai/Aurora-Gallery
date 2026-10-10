'use strict';

/**
 * RAW 容器的**内嵌 JPEG 预览 + EXIF** 提取 —— 不需要解码 RAW 本身。
 *
 * 🔴 为什么需要它：Canon `.CR2` 是 TIFF 容器，其 RAW 数据以 TIFF `Compression = 6`
 *    （old-style JPEG）存放；libtiff 编译时未启用 `OLD_JPEG` ⇒ 打开就抛
 *    `Old-style JPEG compression support is not configured`，
 *    **sharp / libvips 无论怎么配都读不了**（prebuilt 一律不带这个支持）。
 *    本机 13 个 CR2 因此 **13/13 出不了图**（2026-10-06 实测）。
 *
 * 但这些文件里**本来就写着一张（或多张）JPEG**。实测
 * `G:\T\T029_20180616_688P\02901_02901_IMG (1).CR2`（28,013,333 B）内含三段：
 *
 *   | offset    | 长度       | SOF  | 尺寸      | 用途                    |
 *   | ---       | ---        | ---  | ---       | ---                     |
 *   | 80,324    | 12,041     | SOF0 | 160×120   | IFD1 小缩略图（弃）      |
 *   | 92,368    | 1,888,993  | SOF0 | 5760×3840 | ← **取它**（全尺寸预览） |
 *   | 3,636,076 | 24,377,257 | SOF0 | 5760×3840 | RAW 数据块（弃）         |
 *
 *   ⇒ 把中间那段抠出来交给 sharp 即可，**连 RAW 都不用解**，而且拿到的是
 *     5760×3840 的全尺寸图（比 256 px 缩略图有用得多）。
 *
 * 🔴 两个承重判据（都来自上表实测，别凭直觉改）：
 *   ① **SOF 类型区分不了预览与 RAW 数据块** —— 第三段（RAW）的头部同样写着 `SOF0`。
 *      唯一可靠的区分是**长度**：预览 1.9 MB vs RAW 块 24.4 MB ⇒ 用 16 MB 上限排除。
 *   ② 第一段（12 KB / 160×120）画质太差 ⇒ 用 32 KB 下限排除。
 *
 * 🔴 EXIF 单独走 `exif-reader` 直接解析**容器头部**（CR2 本身就是 TIFF，
 *    exif-reader 按 TIFF 规则读 IFD0 即可）：实测拿到 `Canon EOS 5D Mark III` /
 *    拍摄时间 / ISO 100 / F4 / 21 mm / GPS 全部齐全。
 *    ⚠️ **绝对不能用内嵌预览 JPEG 的 `metadata().exif`** —— 实测那三段 JPEG 的
 *    首段 marker 都是 `FFDB`（DQT），**都不带 APP1**，`exif` 恒为空；而走兜底时
 *    `header` 非 null 会写 `exif_mtime` 标记 ⇒ 会把「没读到 EXIF」
 *    **永久**标记成「看过了、确实没有」。这是本轮刻意避开的坑。
 */

const fs = require('fs');
const { extractExifFields, hasAnyExifField } = require('./exif-meta');

/**
 * ⚠️ 「哪些扩展名要走内嵌预览」这份清单**不在这里**。
 *
 * 唯一真相源 = `src/main/sharp-input.js#OWN_DECODER_RAW_EXTENSIONS`（那里带着**实测依据**）。
 * 本模块只负责「给一个容器，把里面的预览与 EXIF 抠出来」，**不判断该不该抠**。
 *
 * 🔴 原先这里另存过一份 36 项的扩展名表（含 nef/arw/rw2/raf/x3f…）—— 那是**两份清单漂移**的
 *    典型：它列的绝大多数扩展名**根本走不到这里**（真正抢跑的只有 cr2/crw/cr3），
 *    而它在 `src/` 里**零使用者**，只被一条回归牙钉着 ⇒ 那条牙守的是一份没人用的清单（假绿）。
 *    要扩判据，请先实测「sharp 读不了」，再加进 `OWN_DECODER_RAW_EXTENSIONS`。
 */

/** 只读文件前 8 MB 找预览与 EXIF。实测预览在 92 KB、EXIF 的 IFD0 在 0x10。 */
const PROBE_BYTES = 8 * 1024 * 1024;
/** 超过这个体积的容器直接放弃（避免把内存撑爆；正常 RAW 最大几百 MB）。 */
const MAX_CONTAINER_BYTES = 512 * 1024 * 1024;
/** 预览下限：低于此值的是 IFD1 的 160×120 小缩略图，画质不可用。 */
const MIN_PREVIEW_BYTES = 32 * 1024;
/** 预览上限：高于此值的是 RAW 数据块（实测 24.4 MB），**这是唯一可靠的区分判据**。 */
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
/**
 * 预览占文件体积的上限。**这条闸门是防「探针截断」漏洞的**：
 * 只用 `MAX_PREVIEW_BYTES` 时，若某个 RAW 数据块恰好 < 16 MB **且** 它的 EOI 落在探针窗口内，
 * 它就会被当成候选 —— 而它的尺寸与真预览**完全相同**（都是 RAW 尺寸），
 * 按「面积相同取更长」的规则反而会选中它（更长的那个）。
 * 实测样本里真预览 = 1.89 MB / 文件 28.0 MB（6.7%），RAW 块 = 24.4 MB（87%）⇒
 * 「预览绝不可能占文件一半以上」是本质判据，两条件叠加才稳。
 */
const MAX_PREVIEW_FILE_RATIO = 0.5;
/** 扫描段数上限：防止畸形文件里大量伪 `FFD8FF` 把 CPU 拖死。 */
const MAX_SCAN_SEGMENTS = 4096;
/** 找 SOF 时只看前 64 KB（SOF 一定在熵编码之前，实测紧跟 DQT）。 */
const SOF_SCAN_BYTES = 64 * 1024;

const SOI_BYTES = Buffer.from([0xff, 0xd8, 0xff]);
const EOI_BYTES = Buffer.from([0xff, 0xd9]);
/**
 * 接受的 SOF：`C0` baseline / `C1` extended-sequential / `C2` progressive。
 * ⚠️ 刻意不收 `C3`/`C7`/`CB`/`CF`（lossless）与 `C9`~`CB`（算术编码）——
 *    lossless 正是 RAW 数据块用的编码，libvips 也解不了算术编码。
 */
const SOF_ACCEPTED = new Set([0xc0, 0xc1, 0xc2]);
const SOF_ALL = new Map([
  [0xc0, 'SOF0'],
  [0xc1, 'SOF1'],
  [0xc2, 'SOF2'],
  [0xc3, 'SOF3'],
  [0xc5, 'SOF5'],
  [0xc6, 'SOF6'],
  [0xc7, 'SOF7'],
  [0xc9, 'SOF9'],
  [0xca, 'SOF10'],
  [0xcb, 'SOF11'],
  [0xcd, 'SOF13'],
  [0xce, 'SOF14'],
  [0xcf, 'SOF15'],
]);

/**
 * 扫出所有 `FFD8FF … FFD9` 段（JPEG 的 SOI…EOI）。
 * ⚠️ 熵编码数据里的 `FF` 后必然跟 `00` 或 `D0`~`D7` ⇒ 第一个 `FFD9` 一定是真正的 EOI。
 */
function scanJpegSegments(buf) {
  const out = [];
  let pos = 0;
  while (out.length < MAX_SCAN_SEGMENTS) {
    const s = buf.indexOf(SOI_BYTES, pos);
    if (s < 0) break;
    const e = buf.indexOf(EOI_BYTES, s + 3);
    if (e < 0) break;
    out.push({ offset: s, length: e + 2 - s });
    pos = e + 2;
  }
  return out;
}

/** 读 JPEG 的 SOF，拿尺寸与编码类型；拿不到返回 null。 */
function readSof(blob) {
  let i = 2;
  const end = Math.min(blob.length, SOF_SCAN_BYTES);
  while (i + 9 < end) {
    if (blob[i] !== 0xff) {
      i++;
      continue;
    }
    const m = blob[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xda) return null; // 已进熵编码，SOF 不可能在后面了
    const len = blob.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (SOF_ALL.has(m)) {
      return {
        marker: m,
        sof: SOF_ALL.get(m),
        height: blob.readUInt16BE(i + 5),
        width: blob.readUInt16BE(i + 7),
      };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * 从容器字节里挑出**最合适的预览 JPEG**。
 *
 * 排序：面积降序 → 长度降序。面积相同取更长的（同样尺寸下码率更高）。
 * ⇒ 实测数据上：段 2（1.89 MB / 5760×3840）胜出，段 3（24.4 MB）被上限排除，
 *   段 1（12 KB / 160×120）被下限排除。
 *
 * @returns {{ blob: Buffer, offset: number, length: number, width: number, height: number, sof: string }|null}
 */
function pickPreviewJpeg(buf, fileSize) {
  const relMax = fileSize > 0 ? Math.floor(fileSize * MAX_PREVIEW_FILE_RATIO) : Infinity;
  let best = null;
  for (const seg of scanJpegSegments(buf)) {
    if (seg.length < MIN_PREVIEW_BYTES || seg.length > MAX_PREVIEW_BYTES) continue;
    if (seg.length > relMax) continue;
    const head = buf.subarray(seg.offset, Math.min(seg.offset + SOF_SCAN_BYTES, seg.offset + seg.length));
    const sof = readSof(head);
    if (!sof || !SOF_ACCEPTED.has(sof.marker)) continue;
    if (!sof.width || !sof.height) continue;
    const area = sof.width * sof.height;
    if (!best || area > best.area || (area === best.area && seg.length > best.length)) {
      best = {
        offset: seg.offset,
        length: seg.length,
        width: sof.width,
        height: sof.height,
        sof: sof.sof,
        area,
      };
    }
  }
  if (!best) return null;
  // ⚠️ 必须**复制**（`subarray` 是视图，会一直持有整个 8 MB 探针 buffer）。
  best.blob = Buffer.from(buf.subarray(best.offset, best.offset + best.length));
  return best;
}

/** 只读文件前 `PROBE_BYTES`（文件更小就整个读）。返回 `{ buf, size }`，`size` 是文件真实大小。 */
async function readProbe(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size <= 0) return null;
    if (stat.size > MAX_CONTAINER_BYTES) return null;
    const want = Math.min(stat.size, PROBE_BYTES);
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = await fd.read(buf, got, want - got, got);
      if (!n || n.bytesRead <= 0) break;
      got += n.bytesRead;
    }
    return { buf: got === want ? buf : buf.subarray(0, got), size: stat.size };
  } finally {
    await fd.close();
  }
}

/** 解析容器头部拿 EXIF；失败返回 null（CR3 / X3F 这类非 TIFF 容器会失败）。 */
function readContainerExif(buf) {
  try {
    // 🔴 入参形态：`extractExifFields` 收的是 **sharp 的 metadata 对象**（`{ exif: <Buffer> }`），
    //    它内部才去 `exifReader(metadata.exif)`。**不是**「已经解析好的 exif 对象」。
    //    传错形态**不报错**：它走 `if (!metadata.exif) return out;` 返回一个**全 null 的字段对象**，
    //    于是「有字段」这类判空又被骗过 —— 最终表现是「CR2 的拍摄参数永远为空」，全程静默。
    //    CR2 本身就是 TIFF ⇒ 直接把容器字节当作 EXIF 段交给它即可。
    const fields = extractExifFields({ exif: buf });
    // 🔴 判据必须是「**有没有任何字段真的取到值**」，不能用 `Object.keys(fields).length`：
    //    后者对全 null 对象同样为真（字段注册表里的键恒存在）⇒ 那是假判据。
    return hasAnyExifField(fields) ? fields : null;
  } catch (eExif) {
    void eExif;
    return null;
  }
}

/**
 * 一次读盘同时拿到：预览 JPEG、容器 EXIF、以及**预览的真实像素尺寸**。
 *
 * @returns {Promise<{preview: Buffer|null, previewSize: {width:number,height:number}|null,
 *                    exif: object|null, diagnostics: object}|null>}
 */
async function inspectRawContainer(filePath) {
  // ⚠️ 刻意不给初值：读盘失败时直接 `return null`，不会走到下面的判空。
  let probe;
  try {
    probe = await readProbe(filePath);
  } catch (eRead) {
    void eRead;
    return null;
  }
  if (!probe || !probe.buf || !probe.buf.length) return null;
  const buf = probe.buf;
  const segs = scanJpegSegments(buf);
  const picked = pickPreviewJpeg(buf, probe.size);
  const exif = readContainerExif(buf);
  // 🔴 权威尺寸优先取 EXIF 的 `PixelXDimension` / `PixelYDimension`（RAW 的**真实**像素尺寸），
  //    预览图尺寸只在 EXIF 缺失时兜底。实测样本两者一致（5760×3840），
  //    但少数机型的预览是缩小版 —— 那时用预览尺寸会把 `width`/`height` 写小，
  //    而这两个列是排序/网格布局的输入。
  const exifW = exif && Number(exif.pixelXDimension) > 0 ? Number(exif.pixelXDimension) : 0;
  const exifH = exif && Number(exif.pixelYDimension) > 0 ? Number(exif.pixelYDimension) : 0;
  const previewSize = picked ? { width: picked.width, height: picked.height } : null;
  return {
    preview: picked ? picked.blob : null,
    previewSize,
    width: exifW || (previewSize ? previewSize.width : 0),
    height: exifH || (previewSize ? previewSize.height : 0),
    exif,
    diagnostics: {
      fileBytes: probe.size,
      probeBytes: buf.length,
      segments: segs.length,
      pickedOffset: picked ? picked.offset : null,
      pickedLength: picked ? picked.length : null,
      pickedSof: picked ? picked.sof : null,
    },
  };
}

module.exports = {
  PROBE_BYTES,
  MIN_PREVIEW_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_FILE_RATIO,
  scanJpegSegments,
  readSof,
  pickPreviewJpeg,
  inspectRawContainer,
};
