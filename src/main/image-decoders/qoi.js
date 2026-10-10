'use strict';

/**
 * QOI（Quite OK Image）解码 → 原始像素。
 *
 * 🔴 为什么要自研：libvips **读不了 QOI**，`@napi-rs/image` 也读不了（Rust `image` crate
 *    的 qoi feature 被裁掉了，报 `The image format Qoi is not enabled`）。规范只有一页，
 *    实现 ~100 行，是「自研比引依赖划算」的典型。
 *
 * 规范要点（`qoif`）：
 *   · 头 14 字节：magic(4) width(4 BE) height(4 BE) channels(1, 3|4) colorspace(1)
 *   · 尾部 8 字节结束标记 `00 00 00 00 00 00 00 01` —— **必须校验**，
 *     截断文件靠它才能被发现（否则会静默解出一张半成品图）。
 *   · 6 种操作码，按字节高位区分：
 *       `0xfe` RGB（3 字节跟随）／`0xff` RGBA（4 字节跟随）
 *       `0b00xxxxxx` INDEX（查 64 色哈希表）
 *       `0b01xxxxxx` DIFF（dr/dg/db ∈ -2~1）
 *       `0b10xxxxxx` LUMA（dg ∈ -32~31，dr-dg/db-dg ∈ -8~7）
 *       `0b11xxxxxx` RUN（连续重复上一像素，1~62 次）
 *   · 每个像素跑完都要更新索引：`(r*3 + g*5 + b*7 + a*11) % 64`。
 *
 * ⚠️ **RUN 与 INDEX 是错一字节就全盘崩的**（后续字节全部错位），所以
 *    「每个操作码越界都要当场判失败」，不能靠 `buf[i]` 的 undefined 静默续跑。
 */

/** 结束标记，位于数据末尾 8 字节。 */
const END_MARKER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);

/** 最多解码的像素数（100 MP）。 */
const MAX_PIXELS = 100 * 1000 * 1000;

/**
 * @param {Buffer} buf 整个 QOI 文件
 * @returns {{data: Buffer, width: number, height: number, channels: 3|4}|null}
 */
function decodeQoi(buf) {
  if (!buf || buf.length < 14 + 8) return null;
  if (buf.toString('latin1', 0, 4) !== 'qoif') return null;
  const width = buf.readUInt32BE(4);
  const height = buf.readUInt32BE(8);
  const declaredChannels = buf[12];
  if (!width || !height) return null;
  if (width * height > MAX_PIXELS) return null;
  if (declaredChannels !== 3 && declaredChannels !== 4) return null;
  if (!END_MARKER.equals(buf.subarray(buf.length - 8))) return null;

  // 输出一律 4 通道（QOI 的 alpha 只在 0xff 里出现，3 通道文件 alpha 恒 255）
  const channels = 4;
  let out;
  try {
    out = Buffer.allocUnsafe(width * height * channels);
  } catch (eAlloc) {
    void eAlloc;
    return null;
  }

  const index = new Uint8Array(64 * 4);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 255;
  let p = 14;
  const total = width * height;
  const end = buf.length - 8;

  for (let px = 0; px < total; px++) {
    if (p >= end) return null; // 数据提前耗尽 ⇒ 文件坏了
    const op = buf[p++];
    if (op === 0xfe) {
      if (p + 3 > end) return null;
      r = buf[p];
      g = buf[p + 1];
      b = buf[p + 2];
      p += 3;
    } else if (op === 0xff) {
      if (p + 4 > end) return null;
      r = buf[p];
      g = buf[p + 1];
      b = buf[p + 2];
      a = buf[p + 3];
      p += 4;
    } else {
      const tag = op >> 6;
      if (tag === 0) {
        const i = (op & 0x3f) * 4;
        r = index[i];
        g = index[i + 1];
        b = index[i + 2];
        a = index[i + 3];
      } else if (tag === 1) {
        // DIFF：每通道 2 bit 有符号，-2~1
        r = (r + (((op >> 4) & 0x03) - 2)) & 0xff;
        g = (g + (((op >> 2) & 0x03) - 2)) & 0xff;
        b = (b + ((op & 0x03) - 2)) & 0xff;
      } else if (tag === 2) {
        // LUMA：dg 6 bit（-32~31），dr/db 各 4 bit 存增量（-8~7）
        const dg = (op & 0x3f) - 32;
        if (p >= end) return null;
        const b2 = buf[p++];
        r = (r + dg + ((b2 >> 4) & 0x0f) - 8) & 0xff;
        g = (g + dg) & 0xff;
        b = (b + dg + (b2 & 0x0f) - 8) & 0xff;
      } else {
        // RUN：重复上一像素 1~62 次（op & 0x3f 已经 -1 处理）
        const run = (op & 0x3f) + 1;
        const last = Math.min(px + run, total);
        for (let k = px; k < last; k++) {
          const di = k * 4;
          out[di] = r;
          out[di + 1] = g;
          out[di + 2] = b;
          out[di + 3] = a;
        }
        px = last - 1;
        // RUN **不更新索引表**（规范如此），且循环变量已推进
        continue;
      }
    }
    const di = px * 4;
    out[di] = r;
    out[di + 1] = g;
    out[di + 2] = b;
    out[di + 3] = a;
    const hi = (r * 3 + g * 5 + b * 7 + a * 11) & 0x3f;
    index[hi * 4] = r;
    index[hi * 4 + 1] = g;
    index[hi * 4 + 2] = b;
    index[hi * 4 + 3] = a;
  }
  return { data: out, width, height, channels };
}

module.exports = {
  decodeQoi,
  MAX_PIXELS,
  END_MARKER,
};
