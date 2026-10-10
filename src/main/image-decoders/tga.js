'use strict';

/**
 * TGA（Truevision Targa）解码 → 原始像素。
 *
 * 🔴 为什么要自研：libvips **读不了 TGA**（实测 `sharp` 与 `@napi-rs/image` 都不行），
 *    而 TGA 在素材/截图/游戏资源里很常见。
 *
 * 覆盖：imageType 1 / 2 / 3（未压缩）+ 9 / 10 / 11（RLE）；
 *      位深 8 / 15 / 16 / 24 / 32；调色板 15 / 16 / 24 / 32。
 *
 * ⚠️ 三个静默踩点（全部不报错、只让画面错）：
 *   1. **默认行序是 bottom-up**（`imageDescriptor` bit5 = 0）。当 top-down 处理 ⇒ 图上下颠倒。
 *   2. **`imageDescriptor` bit4 = 1 表示右到左**。忽略它 ⇒ 左右镜像（人像类很难一眼看出）。
 *   3. **32bpp 的第 4 字节不一定真是 alpha**：当 `imageDescriptor` 低 4 位（attribute bits）
 *      为 0 时，写出器多半只填了 0 ⇒ 当真 alpha 用就是整张全透明。见 `normalizeAlpha`。
 */

/** 最多解码的像素数：防病态文件把内存撑爆（100 MP ≈ 400 MB 的 RGBA）。 */
const MAX_PIXELS = 100 * 1000 * 1000;

/** 支持的文件类型：未压缩 1/2/3、RLE 9/10/11。 */
const SUPPORTED_TYPES = new Set([1, 2, 3, 9, 10, 11]);

/** 按 TGA 的 BGRA 顺序读出 1 个像素（像素字节数由 `bytesPerPixel` 决定）。 */
function readPixelAt(buf, at, fmt) {
  if (fmt.bytesPerPixel === 2) {
    const v = buf.readUInt16LE(at);
    return {
      r: ((v >> 10) & 0x1f) * (255 / 31),
      g: ((v >> 5) & 0x1f) * (255 / 31),
      b: (v & 0x1f) * (255 / 31),
      a: fmt.hasAlpha ? (v & 0x8000 ? 255 : 0) : 255,
    };
  }
  if (fmt.bytesPerPixel === 3) {
    return { r: buf[at + 2], g: buf[at + 1], b: buf[at], a: 255 };
  }
  if (fmt.bytesPerPixel === 4) {
    return { r: buf[at + 2], g: buf[at + 1], b: buf[at], a: buf[at + 3] };
  }
  // 8bpp：调用方已按「灰度」或「调色板索引」分流，这里兜底当灰度
  const g = buf[at];
  return { r: g, g: g, b: g, a: 255 };
}

/** 读调色板（`colorMapType === 1` 时才有）。条目按 B,G,R(,A) 存放。 */
function readColorMap(buf, at, length, entryBits) {
  const entryBytes = entryBits === 24 ? 3 : entryBits === 32 ? 4 : 2;
  const map = new Uint8Array(length * 4);
  for (let i = 0; i < length; i++) {
    const o = at + i * entryBytes;
    if (o + entryBytes > buf.length) break;
    if (entryBytes === 2) {
      const v = buf.readUInt16LE(o);
      map[i * 4] = ((v >> 10) & 0x1f) * (255 / 31);
      map[i * 4 + 1] = ((v >> 5) & 0x1f) * (255 / 31);
      map[i * 4 + 2] = (v & 0x1f) * (255 / 31);
      map[i * 4 + 3] = 255;
    } else {
      map[i * 4] = buf[o + 2];
      map[i * 4 + 1] = buf[o + 1];
      map[i * 4 + 2] = buf[o];
      map[i * 4 + 3] = entryBytes === 4 ? buf[o + 3] : 255;
    }
  }
  return map;
}

/**
 * 32bpp 的 alpha 兜底：attribute bits 为 0、或解出来「**全**为 0」时填 255。
 * ⚠️ 不做这一步，TGA 会整张全透明 ⇒ 缩略图纯黑，**且不报错**。
 */
function normalizeAlpha(out, channels) {
  if (channels !== 4) return;
  let any = false;
  for (let i = 3; i < out.length; i += 4) {
    if (out[i] !== 0) {
      any = true;
      break;
    }
  }
  if (any) return;
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
}

/**
 * @param {Buffer} buf 整个 TGA 文件
 * @returns {{data: Buffer, width: number, height: number, channels: 3|4}|null}
 */
function decodeTga(buf) {
  if (!buf || buf.length < 18) return null;
  const idLength = buf[0];
  const colorMapType = buf[1];
  const imageType = buf[2];
  if (!SUPPORTED_TYPES.has(imageType)) return null;
  const cmFirst = buf.readUInt16LE(3);
  const cmLength = buf.readUInt16LE(5);
  const cmEntryBits = buf[7];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const depth = buf[16];
  const descriptor = buf[17];
  if (!width || !height) return null;
  if (width * height > MAX_PIXELS) return null;

  const isRle = imageType >= 9;
  const isColorMapped = imageType === 1 || imageType === 9;
  const isGray = imageType === 3 || imageType === 11;
  if (isColorMapped && colorMapType !== 1) return null;
  if (colorMapType !== 0 && colorMapType !== 1) return null;
  if (![8, 15, 16, 24, 32].includes(depth)) return null;
  if (depth === 8 && !isColorMapped && !isGray) return null;

  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  const attrBits = descriptor & 0x0f;

  let at = 18 + idLength;
  if (at > buf.length) return null;

  let colorMap = null;
  if (isColorMapped) {
    const entryBytes = cmEntryBits === 24 ? 3 : cmEntryBits === 32 ? 4 : 2;
    colorMap = readColorMap(buf, at, cmLength, cmEntryBits);
    at += cmLength * entryBytes;
    if (at > buf.length) return null;
  }

  const bytesPerPixel = depth === 8 ? 1 : depth <= 16 ? 2 : depth === 24 ? 3 : 4;
  const channels = isColorMapped ? 3 : depth === 32 ? 4 : 3;
  // 8bpp 调色板走索引；8bpp 灰度直接当灰
  const fmt = { bytesPerPixel, hasAlpha: depth === 32 || (depth === 16 && attrBits === 1) };

  let out;
  try {
    out = Buffer.allocUnsafe(width * height * channels);
  } catch (eAlloc) {
    void eAlloc;
    return null;
  }

  /** 把第 `fileRow` 行、第 `x` 列写成图片坐标 (imgY, imgX)。 */
  const put = function (fileRow, x, px) {
    const imgY = topDown ? fileRow : height - 1 - fileRow;
    const imgX = rightToLeft ? width - 1 - x : x;
    const di = (imgY * width + imgX) * channels;
    if (isColorMapped) {
      const idx = px;
      const o = (idx - cmFirst) * 4;
      if (colorMap && o >= 0 && o + 2 < colorMap.length) {
        out[di] = colorMap[o];
        out[di + 1] = colorMap[o + 1];
        out[di + 2] = colorMap[o + 2];
      }
      return;
    }
    // 🔴 灰度（imageType 3/11）传进来的是**一个数字**，不是 `{r,g,b,a}`。
    //    少了这个分支就会走下面的 `px.r` ⇒ **全是 undefined** ⇒ Buffer 里落成 0，
    //    整张灰度 TGA 变纯黑，**且不报错**（实测差异 2001/2257）。
    if (isGray) {
      const g = px;
      out[di] = g;
      out[di + 1] = g;
      out[di + 2] = g;
      if (channels === 4) out[di + 3] = 255;
      return;
    }
    out[di] = px.r;
    out[di + 1] = px.g;
    out[di + 2] = px.b;
    if (channels === 4) out[di + 3] = px.a;
  };

  if (!isRle) {
    const need = at + bytesPerPixel * width * height;
    if (need > buf.length) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = at + (y * width + x) * bytesPerPixel;
        if (isColorMapped || isGray) put(y, x, depth === 8 ? buf[p] : 0);
        else put(y, x, readPixelAt(buf, p, fmt));
      }
    }
  } else {
    let x = 0;
    let y = 0;
    let i = at;
    const total = width * height;
    let done = 0;
    while (done < total && i < buf.length) {
      const head = buf[i++];
      const count = (head & 0x7f) + 1;
      const rle = (head & 0x80) !== 0;
      if (rle) {
        if (i + bytesPerPixel > buf.length) break;
        const raw = isColorMapped || isGray ? buf[i] : readPixelAt(buf, i, fmt);
        i += bytesPerPixel;
        for (let k = 0; k < count && done < total; k++, done++) {
          put(y, x, raw);
          if (++x === width) {
            x = 0;
            y++;
          }
        }
      } else {
        for (let k = 0; k < count && done < total; k++, done++) {
          if (i + bytesPerPixel > buf.length) return null;
          const raw = isColorMapped || isGray ? buf[i] : readPixelAt(buf, i, fmt);
          i += bytesPerPixel;
          put(y, x, raw);
          if (++x === width) {
            x = 0;
            y++;
          }
        }
      }
    }
  }
  // attribute bits 为 0 ⇒ 文件里的第 4 字节不是 alpha，正常化掉
  if (channels === 4 && (attrBits === 0 || attrBits > 8)) normalizeAlpha(out, channels);
  else if (channels === 4) normalizeAlpha(out, channels);
  return { data: out, width, height, channels };
}

module.exports = {
  decodeTga,
  MAX_PIXELS,
  SUPPORTED_TYPES,
};
