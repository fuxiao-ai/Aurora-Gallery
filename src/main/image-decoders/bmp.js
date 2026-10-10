'use strict';

/**
 * BMP / DIB 解码 → 原始像素（3 或 4 通道）。
 *
 * 🔴 为什么必须自研：**libvips 完全读不了 BMP**。2026-10-06 实测三种 BMP 全部失败：
 *    · ffmpeg 生成的 64×64 24bpp（DIB 40）
 *    · 真库里 4160×3120 32bpp（51 MB）
 *    · 真库里 602×900 24bpp
 *    一律 `Input file contains unsupported image format`（sharp 0.33.5 / libvips 8.15.3）。
 *    而 `.bmp` **一直在扫描白名单里**（`scanner.js#IMAGE_EXTENSIONS`）⇒ 这是个空承诺：
 *    文件扫得进来、一张也出不了图。
 *    ⚠️ 别被真库「102 个 bmp 里 100 个 `has_thumbnail = 1`」误导 —— 那是**历史遗留**
 *    （实测连那张"有缩略图"的 4160×3120 现在也读不出来），重跑只会失败。
 *
 * 覆盖范围（刻意取舍）：
 *   · 位深：1 / 4 / 8（调色板）、16 / 24 / 32
 *   · 压缩：`0` BI_RGB、`3` BI_BITFIELDS、`1` BI_RLE8、`2` BI_RLE4
 *   · DIB 头：12（`BITMAPCOREHEADER`）、40 及以上（`BITMAPINFOHEADER` / V4 / V5）
 *   · 行序：bottom-up（`height > 0`）与 top-down（`height < 0`）都支持
 *     ⚠️ **bottom-up 才是默认**。漏了它就是上下颠倒 —— 而颠倒**不会报错**，
 *        只会让人以为「这张图本来就这样」，属于最难发现的那类错。
 *     ⚠️ 但 **RLE 数据永远是 bottom-up**（与头部行序无关），见 `decodeRle`。
 *
 * 输出约定：调色板 / 16 / 24 bpp 输出 **3 通道**（它们没有 alpha）；
 * 32 bpp 输出 **4 通道**，且：
 *   · `BI_RGB`（无 alpha mask）⇒ **A 一律填 255**。绝大多数 32bpp BMP 的第 4 字节
 *     是 0 或"保留"；当成真 alpha 用 = 整张图全透明 ⇒ 缩略图变纯黑，而且不报错。
 *   · `BI_BITFIELDS` 且带 alpha mask ⇒ 才使用文件里的 A。
 */

/** 最多解码的像素数：防病态文件把内存撑爆（100 MP ≈ 400 MB 的 RGBA）。 */
const MAX_PIXELS = 100 * 1000 * 1000;

/** 支持的位深；其余（如 2bpp）直接放弃，交给上层维持「读不了」的现状。 */
const SUPPORTED_BPP = new Set([1, 4, 8, 16, 24, 32]);

const COMPRESSION_RGB = 0;
const COMPRESSION_RLE8 = 1;
const COMPRESSION_RLE4 = 2;
const COMPRESSION_BITFIELDS = 3;

/** 每行按 4 字节对齐后的字节数（BMP 的「stride」）。 */
function rowStride(width, bpp) {
  return Math.floor((bpp * width + 31) / 32) * 4;
}

/**
 * 读 DIB 头（`BITMAPINFOHEADER` 家族）—— **BMP 与 ICO 共用这一份**，所以 `at` 是头起点：
 * BMP 是 14（跳过 `BITMAPFILEHEADER`），**ICO 条目里存的是裸 DIB、起点为 0**。
 * 拆出来不是为「复用好看」：两处各写一份必然漂移，而漂移的症状是「同一种位深
 * 一种容器能读、另一种静默读错」（例如漏掉 bottom-up ⇒ 图上下颠倒且不报错）。
 *
 * 任何不认识的结构都返回 null（上层按「读不了」回落）。
 */
function readDibHeader(buf, at) {
  if (!buf || at < 0 || at + 12 > buf.length) return null;
  const dibSize = buf.readUInt32LE(at);
  let width;
  let height;
  let bpp;
  let compression;
  let paletteAt;
  let paletteEntrySize;
  let clrUsed = 0;
  if (dibSize === 12) {
    if (at + 12 > buf.length) return null;
    width = buf.readUInt16LE(at + 4);
    height = buf.readUInt16LE(at + 6);
    bpp = buf.readUInt16LE(at + 10);
    compression = COMPRESSION_RGB;
    paletteAt = at + 12;
    paletteEntrySize = 3;
  } else if (dibSize >= 40 && at + dibSize <= buf.length) {
    width = buf.readInt32LE(at + 4);
    height = buf.readInt32LE(at + 8);
    bpp = buf.readUInt16LE(at + 14);
    compression = buf.readUInt32LE(at + 16);
    clrUsed = buf.readUInt32LE(at + 32);
    paletteAt = at + dibSize;
    paletteEntrySize = 4;
  } else {
    return null;
  }
  if (!SUPPORTED_BPP.has(bpp)) return null;
  if (compression > 3) return null;
  const topDown = height < 0;
  height = Math.abs(height);
  if (!width || !height) return null;
  if (width * height > MAX_PIXELS) return null;

  let palette = null;
  if (bpp <= 8) {
    const n = clrUsed > 0 ? Math.min(clrUsed, 1 << bpp) : 1 << bpp;
    palette = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = paletteAt + i * paletteEntrySize;
      if (o + 2 >= buf.length) break;
      // BMP 调色板按 B,G,R 存放
      palette[i * 3] = buf[o + 2];
      palette[i * 3 + 1] = buf[o + 1];
      palette[i * 3 + 2] = buf[o];
    }
  }

  // 16/32bpp 的位域掩码：BI_BITFIELDS 时在 DIB 头之后（12 字节，V4/V5 则内嵌在头里）
  let masks = null;
  if (bpp === 16 || bpp === 32) {
    if (compression === COMPRESSION_BITFIELDS) {
      const maskAt = dibSize >= 52 ? at + 40 : at + dibSize;
      if (maskAt + 12 <= buf.length) {
        masks = {
          r: buf.readUInt32LE(maskAt),
          g: buf.readUInt32LE(maskAt + 4),
          b: buf.readUInt32LE(maskAt + 8),
          a: dibSize >= 56 && maskAt + 16 <= buf.length ? buf.readUInt32LE(maskAt + 12) : 0,
        };
      }
    } else if (dibSize >= 56 && at + 56 <= buf.length) {
      const a = buf.readUInt32LE(at + 52);
      const r = buf.readUInt32LE(at + 40);
      const g = buf.readUInt32LE(at + 44);
      const b = buf.readUInt32LE(at + 48);
      if (r || g || b) masks = { r, g, b, a };
    }
  }
  return {
    width,
    height,
    bpp,
    compression,
    topDown,
    masks,
    palette,
    dibSize,
    paletteAt,
    paletteEntrySize,
    paletteEntryCount: palette ? palette.length / 3 : 0,
  };
}

/**
 * 像素数据相对**头起点**的偏移 = DIB 头 + `BI_BITFIELDS` 的 12 字节掩码 + 色表。
 * ⚠️ 返回值是**相对量**：BMP 要再加 14 才是文件内绝对偏移，ICO 直接用（头在 0）。
 */
function dibPixelOffset(meta) {
  const maskBytes = meta.compression === COMPRESSION_BITFIELDS && meta.dibSize === 40 ? 12 : 0;
  return meta.dibSize + maskBytes + meta.paletteEntryCount * meta.paletteEntrySize;
}

/**
 * 读 BMP 文件头 + DIB 头。`dataOffset` **取文件头里的权威值**（不自己算）：
 * 有些写出器会在色表之后留空隙，自己算会读到垃圾。
 */
function readBmpHeader(buf) {
  if (!buf || buf.length < 26) return null;
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null; // 'BM'
  const dataOffset = buf.readUInt32LE(10);
  if (dataOffset >= buf.length) return null;
  const meta = readDibHeader(buf, 14);
  if (!meta) return null;
  meta.dataOffset = dataOffset;
  return meta;
}

/** 取出掩码对应的位段并归一化到 0~255。 */
function makeFieldReader(mask) {
  if (!mask) return null;
  let shift = 0;
  while (shift < 32 && !((mask >>> shift) & 1)) shift++;
  let bits = 0;
  while (bits < 32 && ((mask >>> (shift + bits)) & 1)) bits++;
  if (!bits) return null;
  const maxVal = Math.pow(2, bits) - 1;
  const scale = 255 / maxVal;
  return function (v) {
    return ((v & mask) >>> shift) * scale;
  };
}

/** BI_RGB / BI_BITFIELDS：按行直读。 */
function decodeRaw(buf, meta, out, channels) {
  const { width, height, bpp, dataOffset, palette, topDown, masks } = meta;
  const stride = rowStride(width, bpp);
  const readR = masks ? makeFieldReader(masks.r) : null;
  const readG = masks ? makeFieldReader(masks.g) : null;
  const readB = masks ? makeFieldReader(masks.b) : null;
  const readA = masks && masks.a ? makeFieldReader(masks.a) : null;
  for (let y = 0; y < height; y++) {
    // bottom-up：文件第一行是图片的**最后**一行
    const srcRow = topDown ? y : height - 1 - y;
    const rowAt = dataOffset + srcRow * stride;
    let di = y * width * channels;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (bpp === 1 || bpp === 4 || bpp === 8) {
        let idx;
        if (bpp === 8) {
          idx = buf[rowAt + x];
        } else if (bpp === 4) {
          const byte = buf[rowAt + (x >> 1)];
          idx = x & 1 ? byte & 0x0f : byte >> 4;
        } else {
          const byte = buf[rowAt + (x >> 3)];
          idx = (byte >> (7 - (x & 7))) & 1;
        }
        if (palette && idx * 3 + 2 < palette.length) {
          r = palette[idx * 3];
          g = palette[idx * 3 + 1];
          b = palette[idx * 3 + 2];
        }
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(rowAt + x * 2);
        if (readR) {
          r = readR(v);
          g = readG(v);
          b = readB(v);
          if (readA) a = readA(v);
        } else {
          // 默认 5-5-5（最高位未用）
          r = ((v >> 10) & 0x1f) * (255 / 31);
          g = ((v >> 5) & 0x1f) * (255 / 31);
          b = (v & 0x1f) * (255 / 31);
        }
      } else if (bpp === 24) {
        const o = rowAt + x * 3;
        b = buf[o];
        g = buf[o + 1];
        r = buf[o + 2];
      } else {
        const o = rowAt + x * 4;
        if (readR) {
          const v = buf.readUInt32LE(o);
          r = readR(v);
          g = readG(v);
          b = readB(v);
          if (readA) a = readA(v);
        } else {
          b = buf[o];
          g = buf[o + 1];
          r = buf[o + 2];
          // 🔴 BI_RGB 的 32bpp **不当 alpha 用**：第 4 字节普遍是 0/保留，
          //    当真 alpha 会让整张图全透明（缩略图变纯黑且不报错）。
          //    ⚠️ **ICO 里的 32bpp DIB 恰好相反** —— 第 4 字节是**真 alpha**。
          //       两处直觉不能混用，所以由 `meta.useNativeAlpha` 显式开关。
          if (meta.useNativeAlpha) a = buf[o + 3];
        }
      }
      out[di] = r;
      out[di + 1] = g;
      out[di + 2] = b;
      if (channels === 4) out[di + 3] = a;
      di += channels;
    }
  }
}

/** BI_RLE8 / BI_RLE4 —— 行程编码，**永远是 bottom-up**（与头部行序无关）。 */
function decodeRle(buf, meta, out, channels) {
  const { width, height, bpp, dataOffset, palette } = meta;
  const twoPixelsPerByte = bpp === 4;
  let x = 0;
  let y = height - 1; // bottom-up：从图片左下角开始
  let i = dataOffset;
  const putPixel = function (idx, runOffset) {
    const px = x + runOffset;
    if (px < 0 || px >= width || y < 0 || y >= height) return;
    let r = 0;
    let g = 0;
    let b = 0;
    if (palette && idx * 3 + 2 < palette.length) {
      r = palette[idx * 3];
      g = palette[idx * 3 + 1];
      b = palette[idx * 3 + 2];
    }
    const di = (y * width + px) * channels;
    out[di] = r;
    out[di + 1] = g;
    out[di + 2] = b;
    if (channels === 4) out[di + 3] = 255;
  };
  // 未被 RLE 覆盖的像素保持 0 —— 先把整张填成不透明黑，避免 `allocUnsafe` 的脏数据
  if (channels === 4) {
    for (let p = 3; p < out.length; p += 4) out[p] = 255;
  }
  while (i + 1 < buf.length) {
    const count = buf[i];
    const value = buf[i + 1];
    i += 2;
    if (count > 0) {
      for (let k = 0; k < count; k++) {
        putPixel(twoPixelsPerByte ? (k & 1 ? value & 0x0f : value >> 4) : value, k);
      }
      x += count;
      continue;
    }
    if (value === 0) {
      x = 0;
      y--;
      continue;
    }
    if (value === 1) break;
    if (value === 2) {
      if (i + 1 >= buf.length) break;
      x += buf[i];
      y -= buf[i + 1];
      i += 2;
      continue;
    }
    // 绝对模式：接下来 value 个像素（RLE4 时打包成 ceil(value/2) 字节）
    const nPix = value;
    const nBytes = twoPixelsPerByte ? Math.ceil(nPix / 2) : nPix;
    for (let k = 0; k < nPix; k++) {
      const byte = buf[i + (twoPixelsPerByte ? k >> 1 : k)];
      if (byte === undefined) return true;
      putPixel(twoPixelsPerByte ? (k & 1 ? byte & 0x0f : byte >> 4) : byte, k);
    }
    i += nBytes;
    // 绝对模式的数据按 16 位（2 字节）边界对齐
    if (nBytes & 1) i++;
    x += nPix;
  }
  return true;
}

/**
 * @param {Buffer} buf 整个 BMP 文件
 * @returns {{data: Buffer, width: number, height: number, channels: 3|4}|null}
 */
function decodeBmp(buf) {
  const meta = readBmpHeader(buf);
  if (!meta) return null;
  const { width, height, bpp, compression } = meta;
  const channels = bpp === 32 ? 4 : 3;
  let out;
  try {
    out = Buffer.allocUnsafe(width * height * channels);
  } catch (eAlloc) {
    void eAlloc;
    return null;
  }
  if (compression === COMPRESSION_RLE8 || compression === COMPRESSION_RLE4) {
    if (!decodeRle(buf, meta, out, channels)) return null;
  } else {
    // 🔴 直读路径必须**先确认数据行完整**：截断文件会让 `readUInt16LE` 抛
    //    `ERR_OUT_OF_RANGE`（而调色板索引那种 `buf[i]` 越界只是 undefined，静默出黑边）。
    //    显式挡在门口，让调用方按"读不了"处理，而不是抛到上层。
    const need = meta.dataOffset + rowStride(width, bpp) * height;
    if (need > buf.length) return null;
    decodeRaw(buf, meta, out, channels);
  }
  return { data: out, width, height, channels };
}

/**
 * 裸 DIB（只有 `BITMAPINFOHEADER` 起头、**没有 `BITMAPFILEHEADER`**，即 `.dib` 文件）。
 * 🔴 `.dib` 也一直在扫描白名单里，但 `decodeBmp()` 要求开头是 `'BM'` ⇒ 它读不了。
 */
function decodeDib(buf) {
  const meta = readDibHeader(buf, 0);
  if (!meta) return null;
  meta.dataOffset = dibPixelOffset(meta);
  const { width, height, bpp, compression } = meta;
  const channels = bpp === 32 ? 4 : 3;
  let out;
  try {
    out = Buffer.allocUnsafe(width * height * channels);
  } catch (eAlloc) {
    void eAlloc;
    return null;
  }
  if (compression === COMPRESSION_RLE8 || compression === COMPRESSION_RLE4) {
    if (!decodeRle(buf, meta, out, channels)) return null;
  } else {
    const need = meta.dataOffset + rowStride(width, bpp) * height;
    if (need > buf.length) return null;
    decodeRaw(buf, meta, out, channels);
  }
  return { data: out, width, height, channels };
}

module.exports = {
  decodeBmp,
  decodeDib,
  readBmpHeader,
  readDibHeader,
  dibPixelOffset,
  rowStride,
  decodeRaw,
  decodeRle,
  MAX_PIXELS,
  SUPPORTED_BPP,
  COMPRESSION_RGB,
  COMPRESSION_BITFIELDS,
};
