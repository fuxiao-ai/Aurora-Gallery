'use strict';

/**
 * PNM / PAM 解码（PBM PGM PPM + PAM）→ 原始像素。
 *
 * 🔴 为什么要自研：libvips **读不了 PNM**（实测），`@napi-rs/image` 只覆盖 PBM/PGM/PPM，
 *    且读不了 PAM。而 PNM 是图像处理/科学计算/相机输出里最常见的裸格式之一。
 *
 * 支持：P1(ASCII 位图) / P2(ASCII 灰度) / P3(ASCII RGB) /
 *      P4(二进制位图) / P5(二进制灰度) / P6(二进制 RGB) / P7(PAM)
 *
 * ⚠️ 四个踩点：
 *   1. **PBM 里 1 = 黑、0 = 白**（与其他格式的直觉相反）。
 *   2. **maxval > 255 时每个样本占 2 字节、big-endian**（P5/P6/P7）。
 *   3. **P4 的行按字节对齐**（`ceil(width/8)` 字节），不是按像素。
 *   4. 头部字段之间**可以有任意空白与 `#` 注释**，而注释能跨多行；
 *      二进制数据的起点必须靠**精确的 token 扫描**得到，不能用正则切一刀。
 */

/** 最多解码的像素数（100 MP）。 */
const MAX_PIXELS = 100 * 1000 * 1000;

/** 从 `pos` 起跳过空白与 `#` 注释，返回下一个 token 的起点。 */
function skipSpaceAndComments(buf, pos) {
  let i = pos;
  while (i < buf.length) {
    const c = buf[i];
    if (c === 0x23) {
      // '#'
      while (i < buf.length && buf[i] !== 0x0a) i++;
    } else if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * 二进制变体（P4/P5/P6）：头之后**恰好一个**空白字符，像素数据紧随其后。
 *
 * 🔴 **不能省这一步**：`readInt()` 返回的位置指向「数字之后那个空白字符本身」，
 *    不前进就是让数据起点偏移 1 字节 ⇒ 整张图错位。
 *    而错位的症状极具欺骗性 —— 图**还是能看**（灰度渐变区相邻值只差 1，落在容忍阈值内），
 *    只在色块边界处整片对不上。实测：`p6.ppm` 有 **56%** 的字节对不上，
 *    而 `p1/p2/p3`（ASCII 变体）却是好的，正因为 ASCII 靠 `readInt` 自己跳了空白。
 * ⚠️ 这里**无条件前进 1**（规范保证存在这个空白），不要写成「若是空白才跳」——
 *    灰度数据首字节完全可能是 `0x0a`（值 10）或 `0x20`（值 32），那种写法会漏跳。
 */
function skipOneWhitespace(buf, pos) {
  if (pos >= buf.length) return pos;
  if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) return pos + 2;
  return pos + 1;
}

/** 读一个十进制整数 token，返回 [值, 下一个位置]。 */
function readInt(buf, pos) {
  let i = skipSpaceAndComments(buf, pos);
  let v = 0;
  let any = false;
  while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x39) {
    v = v * 10 + (buf[i] - 0x30);
    any = true;
    i++;
    if (v > 1e9) return null; // 病态输入
  }
  return any ? [v, i] : null;
}

/** 值域归一化到 0~255（源值域 0~maxval）。 */
function scale(v, maxVal) {
  return maxVal === 255 ? v : Math.round((v / maxVal) * 255);
}

/**
 * @param {Buffer} buf 整个 PNM/PAM 文件
 * @returns {{data: Buffer, width: number, height: number, channels: 3|4}|null}
 */
function decodePnm(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] !== 0x50) return null; // 'P'
  const kind = buf[1];
  if (kind < 0x31 || kind > 0x37) return null; // P1~P7

  let width;
  let height;
  let maxVal = 255;
  let depth = 3;
  let pos;

  if (kind === 0x37) {
    // P7 / PAM：键值行形式的头，以 ENDHDR 结束
    // ⚠️ 刻意**不**在这里重置 `maxVal`：头里可能没有 `MAXVAL` 键，
    //    那时就该用上面那个默认值 255（写成重置 = 把默认值变成死代码）。
    let i = 2;
    let tupleType = '';
    for (;;) {
      const lineEnd = buf.indexOf(0x0a, i);
      if (lineEnd < 0) return null;
      const line = buf.toString('latin1', i, lineEnd).trim();
      i = lineEnd + 1;
      if (!line || line[0] === '#') continue;
      const sp = line.search(/[\s]/);
      const key = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const val = sp < 0 ? '' : line.slice(sp + 1).trim();
      if (key === 'ENDHDR') break;
      if (key === 'WIDTH') width = parseInt(val, 10);
      else if (key === 'HEIGHT') height = parseInt(val, 10);
      else if (key === 'MAXVAL') maxVal = parseInt(val, 10);
      else if (key === 'DEPTH') depth = parseInt(val, 10);
      else if (key === 'TUPLTYPE') tupleType = val.toUpperCase();
      if (i > 8192) return null; // 头不该这么长
    }
    if (!width || !height) return null;
    // 单通道的 PAM 也要按灰度处理（DEPTH=1）
    if (depth !== 1 && depth !== 2 && depth !== 3 && depth !== 4) return null;
    if (/GRAYSCALE|BLACKANDWHITE/.test(tupleType) && depth >= 3) depth = 1;
    pos = i;
  } else {
    const a = readInt(buf, 2);
    if (!a) return null;
    width = a[0];
    const b = readInt(buf, a[1]);
    if (!b) return null;
    height = b[0];
    if (!width || !height) return null;
    if (kind === 0x31 || kind === 0x34) {
      maxVal = 1;
      pos = b[1];
    } else {
      const c = readInt(buf, b[1]);
      if (!c) return null;
      maxVal = c[0];
      pos = c[1];
    }
    if (maxVal < 1 || maxVal > 65535) return null;
    depth = kind === 0x33 || kind === 0x36 ? 3 : 1;
  }
  if (width * height > MAX_PIXELS) return null;
  if (Math.abs(width) > 1000000 || Math.abs(height) > 1000000) return null;

  const isAscii = kind === 0x31 || kind === 0x32 || kind === 0x33;
  const isBitmap = kind === 0x31 || kind === 0x34;
  const channels = isBitmap ? 3 : depth >= 3 ? (depth === 4 ? 4 : 3) : 3;
  // P7（PAM）的 `ENDHDR` 换行已在读头时跳过；P4/P5/P6 还要跳掉 maxval 后那一个空白。
  const dataAt = kind === 0x37 ? pos : skipOneWhitespace(buf, pos);
  let out;
  try {
    out = Buffer.allocUnsafe(width * height * channels);
  } catch (eAlloc) {
    void eAlloc;
    return null;
  }

  const putGray = function (i, g) {
    out[i] = g;
    out[i + 1] = g;
    out[i + 2] = g;
    if (channels === 4) out[i + 3] = 255;
  };

  if (isAscii) {
    // 纯文本样本，用同一个 token 扫描器读（注释可以出现在任何位置）
    let p = pos;
    const n = width * height;
    for (let k = 0; k < n; k++) {
      const di = k * channels;
      if (isBitmap) {
        const t = readInt(buf, p);
        if (!t) return null;
        p = t[1];
        // 🔴 PBM：1 = 黑
        const v = t[0] ? 0 : 255;
        putGray(di, v);
        continue;
      }
      if (depth === 1) {
        const t = readInt(buf, p);
        if (!t) return null;
        p = t[1];
        putGray(di, scale(t[0], maxVal));
        continue;
      }
      for (let c = 0; c < depth; c++) {
        const t = readInt(buf, p);
        if (!t) return null;
        p = t[1];
        out[di + c] = scale(t[0], maxVal);
      }
      if (channels === 4) out[di + 3] = 255;
    }
    return { data: out, width, height, channels };
  }

  // 二进制路径
  if (isBitmap) {
    // P4：每行 ceil(width/8) 字节，**1 = 黑**
    const stride = (width + 7) >> 3;
    if (dataAt + stride * height > buf.length) return null;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = buf[dataAt + y * stride + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        putGray((y * width + x) * channels, bit ? 0 : 255);
      }
    }
    return { data: out, width, height, channels };
  }
  // P5/P6/P7：maxval > 255 ⇒ 每样本 2 字节 big-endian
  const sampleBytes = maxVal > 255 ? 2 : 1;
  if (dataAt + sampleBytes * width * height * depth > buf.length) return null;
  let p = dataAt;
  const n = width * height;
  for (let k = 0; k < n; k++) {
    const di = k * channels;
    if (depth === 1) {
      const v = sampleBytes === 2 ? buf.readUInt16BE(p) : buf[p];
      p += sampleBytes;
      putGray(di, scale(v, maxVal));
      continue;
    }
    for (let c = 0; c < depth; c++) {
      const v = sampleBytes === 2 ? buf.readUInt16BE(p) : buf[p];
      p += sampleBytes;
      out[di + c] = scale(v, maxVal);
    }
    if (channels === 4) out[di + 3] = 255;
  }
  return { data: out, width, height, channels };
}

module.exports = {
  decodePnm,
  MAX_PIXELS,
  skipSpaceAndComments,
  skipOneWhitespace,
  readInt,
};
