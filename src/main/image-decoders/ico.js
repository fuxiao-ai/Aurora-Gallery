'use strict';

/**
 * ICO / CUR 解码 → 原始像素（4 通道，带 alpha）。
 *
 * 🔴 为什么要自研：libvips **读不了 ICO**（实测 `sharp` 与 `@napi-rs/image` 都不行），
 *    而 `.ico` 一直在扫描白名单里（`scanner.js#IMAGE_EXTENSIONS`）⇒ 又是一个空承诺。
 *
 * 结构：`ICONDIR`(6) + N × `ICONDIRENTRY`(16)，每个条目指向一张**独立的小图**，两种编码：
 *   · **PNG**（Vista 之后的 256×256 一律是它）—— 直接原样交给 sharp，不必自己解；
 *   · **裸 DIB**（无 `BITMAPFILEHEADER`，就是 BMP 的 `BITMAPINFOHEADER` 起头）
 *     + 紧跟其后的 **AND 掩码**（1bpp，**1 = 透明**）。
 *
 * ⚠️ 四个静默踩点：
 *   1. **DIB 的高度是真实高度的 2 倍**（XOR 像素段 + AND 掩码段）。不减半 ⇒ 宽高比翻倍、
 *      下半张读到掩码区（画面撕裂，且不报错）。
 *   2. **width/height 字段为 0 表示 256**（一个字节放不下 256）。
 *   3. **32bpp 的第 4 字节是真 alpha**（与 BMP 的 BI_RGB 相反）。但老写出器会全填 0 ⇒
 *      这种情况必须**回退到 AND 掩码**判定透明，否则整张图全透明。
 *   4. **多尺寸条目要挑**：ICO 里同一图标有 16/32/48/256 好几份，随机取一份会拿到 16×16。
 */

const bmp = require('./bmp');

/** 与 BMP 共用同一个像素数上限。 */
const MAX_PIXELS = bmp.MAX_PIXELS;

/** 条目数上限：正常 ICO 最多十几份，防病态文件。 */
const MAX_ICONS = 64;

/** PNG magic —— 条目里内嵌 PNG 时用它分流。 */
function isPng(buf, off) {
  return (
    off + 8 <= buf.length &&
    buf[off] === 0x89 &&
    buf[off + 1] === 0x50 &&
    buf[off + 2] === 0x4e &&
    buf[off + 3] === 0x47
  );
}

/** 读 `ICONDIR` + 全部 `ICONDIRENTRY`；不合法返回 null。 */
function readIconDir(buf) {
  if (!buf || buf.length < 6) return null;
  if (buf.readUInt16LE(0) !== 0) return null; // reserved 必须为 0
  const type = buf.readUInt16LE(2);
  if (type !== 1 && type !== 2) return null; // 1 = ICO，2 = CUR
  const count = buf.readUInt16LE(4);
  if (!count || count > MAX_ICONS) return null;
  if (6 + count * 16 > buf.length) return null;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    entries.push({
      // 🔴 0 表示 256
      width: buf[at] === 0 ? 256 : buf[at],
      height: buf[at + 1] === 0 ? 256 : buf[at + 1],
      bpp: buf.readUInt16LE(at + 6),
      bytes: buf.readUInt32LE(at + 8),
      offset: buf.readUInt32LE(at + 12),
    });
  }
  return { type, entries };
}

/** 挑最大的条目（ICO 里尺寸是离散的几档，取面积最大那档）。 */
function pickEntry(entries, buf) {
  let best = null;
  for (const e of entries) {
    if (e.offset <= 0 || e.offset >= buf.length) continue;
    if (!best || e.width * e.height > best.width * best.height) best = e;
  }
  return best;
}

/** 解一个「裸 DIB + AND 掩码」条目。 */
function decodeDibEntry(buf, off) {
  const meta = bmp.readDibHeader(buf, off);
  if (!meta) return null;
  // 🔴 高度减半：DIB 里的高度 = XOR 段 + AND 掩码段
  if (meta.height % 2 === 0 && meta.height / 2 >= 1) meta.height = meta.height / 2;
  meta.topDown = false; // ICO 的 XOR 数据恒为 bottom-up
  meta.useNativeAlpha = true; // ICO 的 32bpp 第 4 字节是真 alpha
  meta.dataOffset = off + bmp.dibPixelOffset(meta);

  const width = meta.width;
  const height = meta.height;
  if (!width || !height) return null;
  if (width * height > MAX_PIXELS) return null;
  // 🔴 图标**必须输出 4 通道**：透明区是图标的主体，丢 alpha 就是一块黑框。
  const channels = 4;
  let out;
  try {
    out = Buffer.allocUnsafe(width * height * channels);
  } catch (eAlloc) {
    void eAlloc;
    return null;
  }
  const xorBytes = bmp.rowStride(width, meta.bpp) * height;
  if (meta.dataOffset + xorBytes > buf.length) return null;
  bmp.decodeRaw(buf, meta, out, channels);

  // 32bpp 但 alpha 全是 0（老写出器不写 alpha）⇒ 交回 AND 掩码决定
  let anyAlpha = false;
  for (let i = 3; i < out.length; i += 4) {
    if (out[i] !== 0) {
      anyAlpha = true;
      break;
    }
  }
  const andAt = meta.dataOffset + xorBytes;
  const andStride = Math.floor((width + 31) / 32) * 4;
  for (let y = 0; y < height; y++) {
    const rowAt = andAt + y * andStride;
    const imgY = height - 1 - y; // AND 掩码同样是 bottom-up
    for (let x = 0; x < width; x++) {
      const byte = buf[rowAt + (x >> 3)];
      if (byte === undefined) continue; // 掩码缺省 ⇒ 保持 DIB 的 alpha
      // 🔴 AND 掩码里 **1 = 透明**
      const transparent = (byte >> (7 - (x & 7))) & 1;
      const ai = (imgY * width + x) * 4 + 3;
      if (transparent) out[ai] = 0;
      else if (!anyAlpha) out[ai] = 255;
    }
  }
  return { data: out, width, height, channels };
}

/**
 * @param {Buffer} buf 整个 ICO / CUR 文件
 * @returns {{data: Buffer, width: number, height: number, channels: 4}
 *          |{embedded: Buffer, format: 'png', width: number, height: number, channels: 4}
 *          |null}
 *   `embedded` 分支表示条目里是 PNG —— **原样交给 sharp**，不必自己解（libvips 能读 PNG）。
 */
function decodeIco(buf) {
  const dir = readIconDir(buf);
  if (!dir) return null;
  const entry = pickEntry(dir.entries, buf);
  if (!entry) return null;
  const off = entry.offset;
  if (isPng(buf, off)) {
    const end = entry.bytes > 0 ? Math.min(buf.length, off + entry.bytes) : buf.length;
    return {
      embedded: buf.subarray(off, end),
      format: 'png',
      width: entry.width,
      height: entry.height,
      channels: 4,
    };
  }
  return decodeDibEntry(buf, off);
}

module.exports = {
  decodeIco,
  readIconDir,
  pickEntry,
  decodeDibEntry,
  MAX_ICONS,
  MAX_PIXELS,
};
