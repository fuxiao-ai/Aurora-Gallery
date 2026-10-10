'use strict';

/**
 * 自研图片解码器 + RAW 内嵌预览提取的回归。
 *
 * 🔴 为什么这一层必须有逐像素断言：它面对的全是**静默错误** ——
 *    · 行序错了（bottom-up 当 top-down）⇒ 图上下颠倒，但「看起来像张图」；
 *    · 通道顺序错了 ⇒ 红蓝互换，也「看起来像张图」；
 *    · PNM 少跳一个分隔空白 ⇒ 整张错位 1 字节，灰度渐变区照样「看起来像张图」；
 *    · TGA 灰度走错分支 ⇒ 整张纯黑（Buffer 写 undefined 落成 0），**一声不吭**；
 *    · ICO 的 AND 掩码丢了 ⇒ 老式图标整块成黑方块。
 *    以上没有一条会抛异常。只有把每个像素的期望值写死，才抓得住。
 *
 * 样本**全部在本文件里合成**（不依赖 ffmpeg / Python / 磁盘上的真实照片）——
 * 否则这条牙换台机器就会被跳过，等于没写。
 *
 * ⚠️ 尺寸刻意取 4×3：**宽度不是 4 的倍数**，行 stride 对齐类错误一测就露
 *    （BMP/TGA/ICO 的行都按 4 字节对齐，对齐错了不会报错，只会让图斜掉）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dec = require('../src/main/image-decoders');
const bridge = require('../src/main/sharp-input');
const rawPreview = require('../src/main/raw-preview');

const W = 4;
const H = 3;

/** 期望像素：三通道两两不等、且随 x / y 单调变化 ⇒ 通道交换 / 行序 / 列序错误立刻暴露。 */
function expectPixel(x, y) {
  return [10 + x * 20, 40 + y * 30, 90 + x * 10 + y * 5];
}

function assertImage(label, img, channels) {
  assert.ok(img, label + ': 解出来是 null');
  assert.strictEqual(img.width, W, label + ': 宽度');
  assert.strictEqual(img.height, H, label + ': 高度');
  assert.strictEqual(img.channels, channels, label + ': 通道数');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * channels;
      const want = expectPixel(x, y);
      const got = [img.data[o], img.data[o + 1], img.data[o + 2]];
      assert.deepStrictEqual(got, want, `${label}: 像素(${x},${y}) 期望 ${want} 实得 ${got}`);
    }
  }
}

/** 灰度图：三个通道必须相等，且等于 R 分量（合成时把 R 当灰度写进去）。 */
function assertGrayImage(label, img) {
  assert.ok(img, label + ': 解出来是 null');
  assert.strictEqual(img.width, W, label + ': 宽度');
  assert.strictEqual(img.height, H, label + ': 高度');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * img.channels;
      const g = expectPixel(x, y)[0];
      assert.deepStrictEqual(
        [img.data[o], img.data[o + 1], img.data[o + 2]],
        [g, g, g],
        `${label}: 灰度(${x},${y}) 期望 ${g} 实得 ${[img.data[o], img.data[o + 1], img.data[o + 2]]}`,
      );
    }
  }
}

function stride(bytesPerRow) {
  return (((bytesPerRow + 3) >> 2) << 2);
}

// ────────────────────────────── BMP ──────────────────────────────

function bmpAssemble(bpp, body, opt) {
  opt = opt || {};
  const palette = opt.palette || Buffer.alloc(0);
  const dib = Buffer.alloc(40, 0);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(W, 4);
  dib.writeInt32LE(opt.topDown ? -H : H, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(bpp, 14);
  dib.writeUInt32LE(opt.compression || 0, 16);
  dib.writeUInt32LE(opt.clrUsed || 0, 32);
  const dataOffset = 14 + 40 + palette.length;
  const head = Buffer.alloc(14, 0);
  head.write('BM', 0, 'latin1');
  head.writeUInt32LE(dataOffset + body.length, 2);
  head.writeUInt32LE(dataOffset, 10);
  return Buffer.concat([head, dib, palette, body]);
}

function bmp24Body(topDown) {
  const st = stride(W * 3);
  const rows = [];
  for (let fy = 0; fy < H; fy++) {
    const y = topDown ? fy : H - 1 - fy;
    const row = Buffer.alloc(st, 0);
    for (let x = 0; x < W; x++) {
      const [r, g, b] = expectPixel(x, y);
      row[x * 3] = b;
      row[x * 3 + 1] = g;
      row[x * 3 + 2] = r;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

/** 8bpp 用的 256 色板：把 12 个像素本身塞进去，索引就用 `x*H+y`。 */
function bmpPalette256() {
  const pal = Buffer.alloc(256 * 4, 0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = expectPixel(x, y);
      const i = x * H + y;
      pal[i * 4] = b;
      pal[i * 4 + 1] = g;
      pal[i * 4 + 2] = r;
    }
  }
  return pal;
}
function idxOf(x, y) {
  return x * H + y;
}

function bmp8Body(rle) {
  const st = stride(W);
  const rows = [];
  for (let fy = 0; fy < H; fy++) {
    const y = H - 1 - fy;
    if (!rle) {
      const row = Buffer.alloc(st, 0);
      for (let x = 0; x < W; x++) row[x] = idxOf(x, y);
      rows.push(row);
      continue;
    }
    // RLE8：一行一个绝对模式段（W=4 是偶数 ⇒ 数据偶数长，无需补位），行尾 00 00
    const seg = Buffer.alloc(2 + W + 2);
    seg[0] = 0x00;
    seg[1] = W;
    for (let x = 0; x < W; x++) seg[2 + x] = idxOf(x, y);
    rows.push(seg);
  }
  if (rle) rows.push(Buffer.from([0x00, 0x01]));
  return Buffer.concat(rows);
}

// ────────────────────────────── TGA ──────────────────────────────

/**
 * TGA 合成器。
 * ⚠️ 默认 `topDown = false` —— **TGA 的规范默认是 bottom-up**，
 *    而 ffmpeg 这个写出器偏偏写 top-down（实测 descriptor=0x20）。两个方向都要测。
 */
function makeTga(opt) {
  opt = opt || {};
  const topDown = opt.topDown === true;
  const rightToLeft = opt.rightToLeft === true;
  const gray = opt.gray === true;
  const rle = opt.rle === true;
  const depth = gray ? 8 : 24;
  const px = [];
  for (let fy = 0; fy < H; fy++) {
    const y = topDown ? fy : H - 1 - fy;
    for (let cx = 0; cx < W; cx++) {
      const x = rightToLeft ? W - 1 - cx : cx;
      const [r, g, b] = expectPixel(x, y);
      px.push(gray ? Buffer.from([r]) : Buffer.from([b, g, r]));
    }
  }
  const head = Buffer.alloc(18, 0);
  head[2] = gray ? (rle ? 11 : 3) : rle ? 10 : 2;
  head.writeUInt16LE(W, 12);
  head.writeUInt16LE(H, 14);
  head[16] = depth;
  head[17] = (topDown ? 0x20 : 0) | (rightToLeft ? 0x10 : 0);
  const body = rle ? Buffer.concat([Buffer.from([W * H - 1]), ...px]) : Buffer.concat(px);
  return Buffer.concat([head, body]);
}

// ────────────────────────────── ICO ──────────────────────────────

function icoDibEntry(bpp, alphaFn, andFn) {
  const bytes = bpp / 8;
  const st = stride(W * bytes);
  const xor = [];
  for (let fy = 0; fy < H; fy++) {
    const y = H - 1 - fy;
    const row = Buffer.alloc(st, 0);
    for (let x = 0; x < W; x++) {
      const [r, g, b] = expectPixel(x, y);
      // 🔴 像素起点必须与**位深同基数**：写成 `x * 3` 时，32bpp 的
      //    `row[x*4+3]`（alpha）会被下一个像素的 B 字节踩掉 —— 解出来是垃圾 alpha，
      //    而这条牙一开始就是这么假绿的（合成器错，被误当成解码器错）。
      const o = x * bytes;
      row[o] = b;
      row[o + 1] = g;
      row[o + 2] = r;
      if (bpp === 32) row[o + 3] = alphaFn ? alphaFn(x, y) : 255;
    }
    xor.push(row);
  }
  const andSt = stride((W + 7) >> 3);
  const and = Buffer.alloc(andSt * H, 0);
  for (let fy = 0; fy < H; fy++) {
    const y = H - 1 - fy;
    for (let x = 0; x < W; x++) {
      if ((andFn ? andFn(x, y) : 255) < 128) and[fy * andSt + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const dib = Buffer.alloc(40, 0);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(W, 4);
  // 🔴 ICO 的 DIB 高度是「XOR 段 + AND 掩码段」之和 = 真实高度 × 2
  dib.writeInt32LE(H * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(bpp, 14);
  return Buffer.concat([dib, ...xor, and]);
}

function icoAssemble(entries) {
  const head = Buffer.alloc(6, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dirs = [];
  const payloads = [];
  let off = 6 + 16 * entries.length;
  for (const e of entries) {
    const d = Buffer.alloc(16, 0);
    d[0] = e.w >= 256 ? 0 : e.w;
    d[1] = e.h >= 256 ? 0 : e.h;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(e.bpp, 6);
    d.writeUInt32LE(e.payload.length, 8);
    d.writeUInt32LE(off, 12);
    off += e.payload.length;
    dirs.push(d);
    payloads.push(e.payload);
  }
  return Buffer.concat([head, ...dirs, ...payloads]);
}

/** 最小的合法 PNG（8 字节签名 + IHDR + IEND）—— 只用来验证「原样交给 sharp」这条分支。 */
function tinyPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crc32 = require('zlib').crc32 ? require('zlib').crc32 : null;
  assert.ok(crc32, '需要 zlib.crc32（Node 20+）来造合法 PNG');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
}

// ────────────────────────────── PNM ──────────────────────────────

function p6Body() {
  const b = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, bl] = expectPixel(x, y);
      const o = (y * W + x) * 3;
      b[o] = r;
      b[o + 1] = g;
      b[o + 2] = bl;
    }
  }
  return b;
}

// ────────────────────────────── QOI ──────────────────────────────

function qoiAssemble(bodyOps) {
  const head = Buffer.alloc(14, 0);
  head.write('qoif', 0, 'latin1');
  head.writeUInt32BE(W, 4);
  head.writeUInt32BE(H, 8);
  head[12] = 4;
  return Buffer.concat([head, ...bodyOps, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]);
}

// ─────────────────────────── RAW 内嵌预览 ───────────────────────────

/**
 * 造一段**语法上像 JPEG** 的字节：SOI + SOF0（带尺寸）+ 填充 + EOI。
 * ⚠️ 不需要真能解码：`pickPreviewJpeg` 只解析 SOF 拿尺寸。真解码那一环已由
 *    真实 CR2 实测覆盖（7/7 提取成功 + sharp 出 256px 缩略图）。
 *    填充刻意用 `0x5a`：既不是 `0xFF`（不会造出伪 marker），也不会撞上 `FFD9`。
 */
function fakeJpeg(w, h, totalBytes) {
  const sof = Buffer.alloc(19, 0);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  const used = 2 + sof.length + 2;
  const pad = totalBytes > used ? Buffer.alloc(totalBytes - used, 0x5a) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, pad, Buffer.from([0xff, 0xd9])]);
}

/** 简易 TIFF 容器头（`II*\0` + 首 IFD 偏移 + CR2 magic），后面直接跟 JPEG 段。 */
function tiffContainerHead() {
  return Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52, 0x02, 0x00]);
}

/**
 * 最小**可解析**的 TIFF/CR2 容器：IFD0 里只放 Make / Model 两个 ASCII 标签。
 * 用来证明「容器的 EXIF 真的被解析出来了」——而不是只返回一个全 null 的字段对象。
 *
 * 布局（与真实 CR2 相同：offset 8 是 4 字节 CR2 magic，IFD0 在 0x10）：
 *   0  `II` + 42 + IFD0@16
 *   8  `43 52 02 00`（CR2 版本 2.0）
 *   16 IFD0：2 条 entry + next IFD = 0
 *   46 "Canon\0" / 52 "Canon EOS 5D Mark III\0"
 */
function tiffWithExif() {
  const make = Buffer.from('Canon\0', 'latin1');
  const model = Buffer.from('Canon EOS 5D Mark III\0', 'latin1');
  const ifdAt = 16;
  const makeAt = ifdAt + 2 + 24 + 4;
  const modelAt = makeAt + make.length;
  const head = Buffer.alloc(ifdAt, 0);
  head.write('II', 0, 'latin1');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdAt, 4);
  head.write('CR', 8, 'latin1');
  head.writeUInt16LE(2, 10);
  const entry = (tag, count, off) => {
    const e = Buffer.alloc(12, 0);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(2, 2); // ASCII
    e.writeUInt32LE(count, 4);
    e.writeUInt32LE(off, 8);
    return e;
  };
  const ifd = Buffer.alloc(2 + 24 + 4, 0);
  ifd.writeUInt16LE(2, 0);
  entry(0x010f, make.length, makeAt).copy(ifd, 2);
  entry(0x0110, model.length, modelAt).copy(ifd, 14);
  return Buffer.concat([head, ifd, make, model]);
}

// ────────────────────────────── 跑 ──────────────────────────────

const tmpFiles = [];
function writeTmp(name, buf) {
  const p = path.join(os.tmpdir(), 'aurora-decoder-reg-' + process.pid + '-' + name);
  fs.writeFileSync(p, buf);
  tmpFiles.push(p);
  return p;
}

let pass = 0;
const fails = [];
const pending = [];
/**
 * 🔴 `fn` 可以是 async —— **必须支持**，否则 async 断言会同时产生两种假象：
 *   · `assert.ok(promise.preview)` ⇒ promise 上没有 `preview` ⇒ **假红**；
 *   · `assert.ok(!promise.preview)` ⇒ `!undefined` 恒真 ⇒ **假绿**（一条都没验）。
 *    本条牙最初就踩了这个：守卫「占比闸门」那条是假绿的。
 */
function check(name, fn) {
  const bad = (e) => fails.push(name + '  →  ' + String(e.message).split('\n')[0]);
  let r;
  try {
    r = fn();
  } catch (e) {
    bad(e);
    return;
  }
  if (r && typeof r.then === 'function') pending.push(r.then(() => pass++, bad));
  else pass++;
}

// ---- BMP ----
check('BMP 24bpp bottom-up（规范默认行序）', () => {
  assertImage('bmp24', dec.decodeFallback(bmpAssemble(24, bmp24Body(false)), 'a.bmp'), 3);
});
check('BMP 24bpp top-down（biHeight 为负）', () => {
  assertImage(
    'bmp24td',
    dec.decodeFallback(bmpAssemble(24, bmp24Body(true), { topDown: true }), 'a.bmp'),
    3,
  );
});
check('BMP 8bpp 调色板', () => {
  assertImage(
    'bmp8',
    dec.decodeFallback(bmpAssemble(8, bmp8Body(false), { palette: bmpPalette256(), clrUsed: 256 }), 'a.bmp'),
    3,
  );
});
check('BMP 8bpp BI_RLE8（绝对模式 + 行尾 00 00）', () => {
  assertImage(
    'bmp8rle',
    dec.decodeFallback(
      bmpAssemble(8, bmp8Body(true), { palette: bmpPalette256(), clrUsed: 256, compression: 1 }),
      'a.bmp',
    ),
    3,
  );
});
check('BMP 32bpp BI_RGB：第 4 字节为 0 时 alpha 必须填 255（不得当透明）', () => {
  const st = stride(W * 4);
  const rows = [];
  for (let fy = 0; fy < H; fy++) {
    const y = H - 1 - fy;
    const row = Buffer.alloc(st, 0);
    for (let x = 0; x < W; x++) {
      const [r, g, b] = expectPixel(x, y);
      row[x * 4] = b;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = r;
      row[x * 4 + 3] = 0;
    }
    rows.push(row);
  }
  const img = dec.decodeFallback(bmpAssemble(32, Buffer.concat(rows)), 'a.bmp');
  assert.strictEqual(img.channels, 4, 'bmp32: 通道数');
  for (let i = 0; i < W * H; i++) {
    assert.strictEqual(img.data[i * 4 + 3], 255, `bmp32: 第 ${i} 个像素的 alpha`);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      assert.deepStrictEqual(
        [img.data[o], img.data[o + 1], img.data[o + 2]],
        expectPixel(x, y),
        `bmp32: 像素(${x},${y})`,
      );
    }
  }
});

// ---- TGA ----
check('TGA 24bpp bottom-up（**规范默认**，不是 top-down）', () => {
  assertImage('tga-bu', dec.decodeFallback(makeTga({ topDown: false }), 'a.tga'), 3);
});
check('TGA 24bpp top-down', () => {
  assertImage('tga-td', dec.decodeFallback(makeTga({ topDown: true }), 'a.tga'), 3);
});
check('TGA 24bpp right-to-left（descriptor bit4）', () => {
  assertImage('tga-r2l', dec.decodeFallback(makeTga({ topDown: true, rightToLeft: true }), 'a.tga'), 3);
});
check('TGA 24bpp bottom-up + right-to-left 同时', () => {
  assertImage('tga-bu-r2l', dec.decodeFallback(makeTga({ rightToLeft: true }), 'a.tga'), 3);
});
check('TGA RLE 压缩（imageType 10）', () => {
  assertImage('tga-rle', dec.decodeFallback(makeTga({ rle: true }), 'a.tga'), 3);
});
check('TGA 8bpp 灰度（imageType 3）不得整张变黑', () => {
  assertGrayImage('tga-gray', dec.decodeFallback(makeTga({ gray: true }), 'a.tga'));
});
check('TGA RLE 灰度（imageType 11）', () => {
  assertGrayImage('tga-gray-rle', dec.decodeFallback(makeTga({ gray: true, rle: true }), 'a.tga'));
});
check('TGA 头 imageType=2（= 00 00 02 00）不得被当成 CUR/ICO', () => {
  // 这是本轮实测踩到的真坑：TGA 头前 4 字节 = idLength,colorMapType,imageType,cmFirst低位，
  // imageType=2 时逐字节等于 CUR 的 magic `00 00 02 00`。
  const buf = makeTga({ topDown: true });
  assert.deepStrictEqual(
    Array.from(buf.subarray(0, 4)),
    [0x00, 0x00, 0x02, 0x00],
    '样本本身必须撞上 CUR magic，否则这条断言没有意义',
  );
  assertImage('tga-vs-cur', dec.decodeFallback(buf, 'a.tga'), 3);
});

// ---- ICO ----
check('ICO 24bpp + AND 掩码：1 = 透明', () => {
  const andFn = (x, y) => (x > y ? 0 : 255);
  const ico = icoAssemble([{ w: W, h: H, bpp: 24, payload: icoDibEntry(24, null, andFn) }]);
  const img = dec.decodeFallback(ico, 'a.ico');
  assert.strictEqual(img.channels, 4, 'ico24: 通道数（图标必须带 alpha）');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      assert.deepStrictEqual(
        [img.data[o], img.data[o + 1], img.data[o + 2]],
        expectPixel(x, y),
        `ico24: 像素(${x},${y})`,
      );
      assert.strictEqual(img.data[o + 3], andFn(x, y) < 128 ? 0 : 255, `ico24: alpha(${x},${y})`);
    }
  }
});
check('ICO 32bpp + DIB alpha 有效时按 DIB alpha 走', () => {
  const alphaFn = (x, y) => (x > y ? 255 : 0);
  const ico = icoAssemble([{ w: W, h: H, bpp: 32, payload: icoDibEntry(32, alphaFn, alphaFn) }]);
  const img = dec.decodeFallback(ico, 'a.ico');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      assert.strictEqual(img.data[(y * W + x) * 4 + 3], alphaFn(x, y), `ico32: alpha(${x},${y})`);
    }
  }
});
check('ICO 32bpp 但 DIB alpha 全是 0 ⇒ 回退用 AND 掩码（否则整张全透明）', () => {
  // 老写出器不写 alpha ⇒ 第 4 字节全 0。此时**必须**靠 AND 掩码判透明，
  // 否则整张图标 alpha=0，缩略图变纯黑且不报错。
  const andFn = (x, y) => (x > y ? 0 : 255);
  const ico = icoAssemble([
    { w: W, h: H, bpp: 32, payload: icoDibEntry(32, () => 0, andFn) },
  ]);
  const img = dec.decodeFallback(ico, 'a.ico');
  let opaque = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = img.data[(y * W + x) * 4 + 3];
      assert.strictEqual(a, andFn(x, y) < 128 ? 0 : 255, `ico a0: alpha(${x},${y})`);
      if (a === 255) opaque++;
    }
  }
  assert.ok(opaque > 0, 'ico a0: 必须有像素回退成不透明');
});
check('ICO 条目内嵌 PNG ⇒ 原样返回 embedded（交给 sharp）', () => {
  const ico = icoAssemble([{ w: W, h: H, bpp: 32, payload: tinyPng() }]);
  const r = dec.decodeFallback(ico, 'a.ico');
  assert.ok(r && r.embedded, 'ico-png: 应返回 embedded');
  assert.strictEqual(r.format, 'png', 'ico-png: format');
});
check('ICO 多条目取最大尺寸（不能随机拿到 16×16）', () => {
  const small = icoDibEntry(24, null, null);
  const bigPng = tinyPng();
  const ico = icoAssemble([
    { w: 2, h: 2, bpp: 24, payload: small },
    { w: 256, h: 256, bpp: 32, payload: bigPng },
  ]);
  const r = dec.decodeFallback(ico, 'a.ico');
  assert.ok(r && r.embedded, 'ico-multi: 应选中最大那条（PNG）');
});

// ---- PNM ----
check('PNM P6：maxval 之后那**一个分隔空白**必须跳过（错 1 字节 = 整张错位）', () => {
  assertImage('p6', dec.decodeFallback(Buffer.concat([Buffer.from('P6\n4 3\n255\n', 'latin1'), p6Body()]), 'a.ppm'), 3);
});
check('PNM P6：CRLF 版头（分隔符 \r\n 也要正好跳掉）', () => {
  assertImage(
    'p6-crlf',
    dec.decodeFallback(Buffer.concat([Buffer.from('P6\r\n4 3\r\n255\r\n', 'latin1'), p6Body()]), 'a.ppm'),
    3,
  );
});
check('PNM P6：头里插注释（含跨行）', () => {
  const head = Buffer.from('P6\n# created by test\n4 # width\n3\n255\n', 'latin1');
  assertImage('p6-cmt', dec.decodeFallback(Buffer.concat([head, p6Body()]), 'a.ppm'), 3);
});
check('PNM P5 二进制灰度', () => {
  const body = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) body[y * W + x] = expectPixel(x, y)[0];
  const buf = Buffer.concat([Buffer.from('P5\n4 3\n255\n', 'latin1'), body]);
  assertGrayImage('p5', dec.decodeFallback(buf, 'a.pgm'));
});
check('PNM P5 maxval=65535（每样本 2 字节 big-endian）', () => {
  const body = Buffer.alloc(W * H * 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      body.writeUInt16BE(expectPixel(x, y)[0] * 257, (y * W + x) * 2);
    }
  }
  const buf = Buffer.concat([Buffer.from('P5\n4 3\n65535\n', 'latin1'), body]);
  assertGrayImage('p5-16', dec.decodeFallback(buf, 'a.pgm'));
});
check('PNM P4 位图：1 = 黑（与直觉相反）', () => {
  const st = (W + 7) >> 3;
  const body = Buffer.alloc(st * H, 0);
  const blackAt = (x, y) => (x + y) % 2 === 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (blackAt(x, y)) body[y * st + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const buf = Buffer.concat([Buffer.from('P4\n4 3\n', 'latin1'), body]);
  const img = dec.decodeFallback(buf, 'a.pbm');
  assert.ok(img, 'p4: 解出来是 null');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * img.channels;
      const want = blackAt(x, y) ? 0 : 255;
      assert.strictEqual(img.data[o], want, `p4: 像素(${x},${y}) 期望 ${want}`);
    }
  }
});

// ---- QOI ----
check('QOI：QOI_OP_RGB 逐像素', () => {
  const ops = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = expectPixel(x, y);
      ops.push(Buffer.from([0xfe, r, g, b]));
    }
  }
  assertImage('qoi-rgb', dec.decodeFallback(qoiAssemble(ops), 'a.qoi'), 4);
});
check('QOI：QOI_OP_RUN 连续重复', () => {
  const [r, g, b] = expectPixel(0, 0);
  const ops = [Buffer.from([0xfe, r, g, b]), Buffer.from([0xc0 | (W * H - 2)])];
  const img = dec.decodeFallback(qoiAssemble(ops), 'a.qoi');
  assert.ok(img, 'qoi-run: 解出来是 null');
  for (let i = 0; i < W * H; i++) {
    assert.deepStrictEqual([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]], [r, g, b], `qoi-run: 第 ${i} 个像素`);
  }
});
check('QOI：结束标记缺失 / 被改坏必须判失败（不得解出半张图）', () => {
  const ops = [Buffer.from([0xfe, 1, 2, 3])];
  const good = qoiAssemble(ops);
  const bad = Buffer.from(good);
  bad[bad.length - 1] = 0x02;
  assert.strictEqual(dec.decodeFallback(bad, 'a.qoi'), null, '坏 QOI 必须返回 null');
});

// ---- 分流与扩展名 ----
check('分流：magic 判定的格式不依赖扩展名（改名的 BMP 照样读）', () => {
  assertImage('renamed-bmp', dec.decodeFallback(bmpAssemble(24, bmp24Body(false)), 'noext'), 3);
});
check('分流：.dib（无 BM 头）走裸 DIB 解码', () => {
  const dib = Buffer.concat([bmpAssemble(24, bmp24Body(false)).subarray(14)]);
  assertImage('dib', dec.decodeFallback(dib, 'a.dib'), 3);
});
check('分流：needsFallbackDecode 覆盖新格式且不误报常见格式', () => {
  for (const n of ['a.bmp', 'a.dib', 'a.ico', 'a.cur', 'a.tga', 'a.qoi', 'a.pbm', 'a.pgm', 'a.ppm', 'a.pam']) {
    assert.strictEqual(dec.needsFallbackDecode(n), true, n + ' 应走兜底');
  }
  for (const n of ['a.jpg', 'a.png', 'a.heic', 'a.cr2', 'a.mp4', 'a.webp']) {
    assert.strictEqual(dec.needsFallbackDecode(n), false, n + ' 不该抢跑');
  }
});
check('分流：我们读不了的输入返回 null 且不抛', () => {
  assert.strictEqual(dec.decodeFallback(Buffer.alloc(64, 0x7f), 'a.tga'), null, '垃圾输入应返回 null');
  assert.strictEqual(dec.decodeFallback(Buffer.alloc(0), 'a.bmp'), null, '空输入应返回 null');
});

// ---- 接入层：桌面端与网页端必须走**同一个**入口 ----
//
// 🔴 这一层守的是「**一端出图、另一端破图**」：接线两边各写一份必然漂移，
//    而两端都"看起来正常"，只是少了一部分照片、没有任何报错。

const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const webSrc = fs.readFileSync(path.join(ROOT, 'src', 'web-server.js'), 'utf8');

check('接入层：主进程与网页端都引用同一个 bridge', () => {
  assert.ok(/require\('\.\/main\/sharp-input'\)/.test(mainSrc), 'main.js 应引 bridge');
  assert.ok(/require\('\.\/main\/sharp-input'\)/.test(webSrc), 'web-server.js 应引 bridge');
});
check('接入层：网页端不得自己加载 sharp（会绕过兜底解码 ⇒ bmp/cr2 全变占位图）', () => {
  // 负例：`loadSharp()` 这个本地帮助函数已删除（sharp 的唯一加载点收进 bridge）。
  // 注意 `loadSharpInput()` 不匹配该正则（后面跟的是 `Input`）。
  assert.ok(!/loadSharp\(\)/.test(webSrc), 'web-server.js 不得再现本地 loadSharp()');
  assert.ok(!/require\('sharp'\)/.test(webSrc), 'web-server.js 不得直接 require sharp');
});
check('接入层：网页端四条路都走 createSharpInput（缩略图/普通图/预览/RAW）', () => {
  const n = (webSrc.match(/createSharpInput\(/g) || []).length;
  assert.ok(n >= 3, 'createSharpInput 调用点不足（实得 ' + n + '，至少 3）');
});
check('接入层：needsOwnRender 扣掉浏览器原生能显示的格式', () => {
  // bmp / ico / cur：libvips 读不了但**浏览器能显示** ⇒ 发原文件更快更清晰；
  // 其余（tga/qoi/pnm/dib）浏览器也不认 ⇒ 必须由我们转 JPEG，否则是破图。
  for (const n of ['a.bmp', 'a.ico', 'a.cur', 'a.jpg', 'a.png']) {
    assert.strictEqual(bridge.needsOwnRender(n), false, n + ' 不该走强制转码');
  }
  for (const n of ['a.tga', 'a.qoi', 'a.pbm', 'a.pgm', 'a.ppm', 'a.pam', 'a.dib']) {
    assert.strictEqual(bridge.needsOwnRender(n), true, n + ' 必须走强制转码');
  }
});

check('接入层：网页端 RAW_EXTENSIONS 必须含全部老式容器（漏项 = 直发原文件 = 破图）', () => {
  // 🔴 漏项的症状与「空承诺」相反：文件**能被送出去**，只是被标成 `image/jpeg`，
  //    浏览器解不出来 ⇒ 破图，且**不报错、不写日志**。
  //    实测踩到过：`.cr3` / `.crw` 原先不在网页端那张表里。
  // ⚠️ 两个清单语义不同（这份是「按 RAW 对待：队列/缓存/大尺寸预览」，
  //    `OWN_DECODER_RAW_EXTENSIONS` 是「libvips 读不了、要自己抠」）⇒ 不能合并，但必须同步。
  const m = webSrc.match(/var RAW_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, '应能取出网页端 RAW_EXTENSIONS');
  for (const e of ['.cr2', '.crw', '.cr3']) {
    assert.ok(m[1].includes("'" + e + "'"), e + ' 必须在网页端 RAW_EXTENSIONS 里');
  }
});

// ---- RAW 内嵌预览 ----
check('RAW 预览：挑「面积最大且长度在门槛内」的那一段', async () => {
  const small = fakeJpeg(160, 120, 1024); // 低于 MIN_PREVIEW_BYTES ⇒ 该被下限排除
  // ⚠️ medium 与 big **等长、不同面积**：这是唯一能戳穿「排序判据」的构造。
  //    只放一段合格候选时，把 `area > best.area` 改成 `area < best.area` 也照样通过 —— 那条牙就是假的。
  const medium = fakeJpeg(320, 240, 40 * 1024);
  const big = fakeJpeg(640, 480, 40 * 1024);
  // ⚠️ 尾部填充不是装饰：`MAX_PREVIEW_FILE_RATIO = 0.5` 是**承重判据**（防 RAW 数据块
  //    伪装成预览），样本若让 big 占文件九成，它自己就会被闸门挡掉 —— 那是样本错，不是解码错。
  //    12 + 1024 + 40960 + 40960 + 49152 = 142108 ⇒ 每段占比 28.8% < 50%。
  const p = writeTmp(
    'cr2',
    Buffer.concat([tiffContainerHead(), small, medium, big, Buffer.alloc(48 * 1024, 0x11)]),
  );
  const info = await rawPreview.inspectRawContainer(p);
  assert.ok(info && info.preview, '应抠出预览');
  assert.strictEqual(info.diagnostics.segments, 3, '样本必须有 3 段（1 段被下限排除、2 段合格）');
  assert.strictEqual(info.diagnostics.pickedLength, big.length, '应选中面积最大的那段');
  assert.strictEqual(
    info.diagnostics.pickedOffset,
    tiffContainerHead().length + small.length + medium.length,
    '起点应为 big 段',
  );
  assert.deepStrictEqual(
    [info.previewSize.width, info.previewSize.height],
    [640, 480],
    '尺寸应从 SOF 读出',
  );
  // 🔴 抠出来的必须是**副本**：`subarray` 是视图，会一直钉住整个 8 MB 探针 buffer。
  assert.strictEqual(
    info.preview.buffer.byteLength,
    big.length,
    '预览必须是独立副本（不得持有整个探针 buffer）',
  );
});
check('RAW 预览：超过文件体积一半的段必须排除（防 RAW 数据块伪装成预览）', async () => {
  // 只放一段 60 KB，文件约 60 KB + 头 ⇒ 该段占比 > 50% ⇒ 必须被闸门挡掉
  const huge = fakeJpeg(5760, 3840, 60 * 1024);
  const p = writeTmp('cr2-ratio', Buffer.concat([tiffContainerHead(), huge]));
  const info = await rawPreview.inspectRawContainer(p);
  // ⚠️ 先证明「段本身是合格候选」——否则这条牙可能只是因为别的原因没抠出来而假绿。
  assert.ok(
    huge.length > rawPreview.MIN_PREVIEW_BYTES && huge.length < rawPreview.MAX_PREVIEW_BYTES,
    '样本必须落在长度门槛之内，否则测的不是占比闸门',
  );
  assert.strictEqual(info.diagnostics.segments, 1, '样本必须恰好含 1 段 JPEG');
  assert.ok(!info.preview, '占比过半的段不得被当成预览');
});
check('RAW 预览：进表判据 = 已实测「libvips 读不了」的那些（唯一真相源）', () => {
  // ⚠️ 这张表**只能靠实测**往里加：加错方向的代价是把「真解码」降级成「读内嵌预览」。
  //    这里刻意只钉「表的内容 + 依据」，**不钉任何本地副本** ——
  //    `raw-preview.js` 原先另存过一份 36 项清单（含 nef/arw/rw2…），与真正的判据不一致
  //    且在 `src/` 里零使用者，本轮已删（那条守「没人用的清单」的牙是假绿）。
  const set = bridge.OWN_DECODER_RAW_EXTENSIONS;
  for (const e of ['.cr2', '.crw', '.cr3']) {
    assert.ok(set.has(e), e + ' 实测 libvips 读不了 ⇒ 必须在表里');
  }
  for (const e of ['.dng', '.nef', '.arw', '.rw2', '.raf', '.jpg', '.png', '.bmp']) {
    assert.ok(!set.has(e), e + ' 未实测到读不了 ⇒ 不该抢跑（抢跑会把真解码降级成读预览）');
  }
});
check('兜底入口：读不到就返回 null 且**不抛**（不许把异常带给调用方）', async () => {
  // 🔴 这条路径面对的是「本来就要失败」的文件，抛出去会把整行的尺寸 / dHash / 指纹一起带走。
  const nowhere = path.join(os.tmpdir(), 'aurora-decoder-reg-missing');
  assert.strictEqual(await bridge.decodeWithOwnDecoder(nowhere + '.cr2', null), null, '.cr2');
  assert.strictEqual(await bridge.decodeWithOwnDecoder(nowhere + '.bmp', null), null, '.bmp');
  assert.strictEqual(
    await bridge.decodeWithOwnDecoder(nowhere + '.jpg', null),
    null,
    '.jpg（不读盘）',
  );
});
check('RAW 预览：容器 EXIF 必须**真的解析出值**（入参形态传错 = 永远静默为空）', async () => {
  // 🔴 这条牙守的是一个**完全静默**的错：`extractExifFields` 收的是 sharp 的 metadata
  //    （`{ exif: <Buffer> }`），**不是**已经解析好的 exif 对象。传错形态不报错 ——
  //    它走 `if (!metadata.exif) return out;` 返回一个**全 null 的字段对象**，
  //    再用 `Object.keys(fields).length` 判空就恒为真 ⇒ 判空被骗过 ⇒
  //    「CR2 的拍摄参数永远是空的」，而且尺寸回退也一并错（`pixelXDimension` 拿不到）。
  //    本轮实测踩到：真库 3 个 CR2 的 exif 全是 null。
  const p = writeTmp('cr2-exif', Buffer.concat([tiffWithExif(), Buffer.alloc(2048, 0x11)]));
  const info = await rawPreview.inspectRawContainer(p);
  assert.ok(info && info.exif, '应解析出容器 EXIF（返回全 null 对象不算）');
  assert.strictEqual(info.exif.cameraMake, 'Canon', 'cameraMake');
  assert.strictEqual(info.exif.cameraModel, 'Canon EOS 5D Mark III', 'cameraModel');
});

// 🔴 报告与清理都必须在**全部 async 断言落定之后**：否则 `unlink` 会抢在
//    `inspectRawContainer` 的读盘之前删掉样本文件（表现为「应抠出预览」失败，
//    而真因是文件没了）。
Promise.all(pending).then(() => {
  for (const f of tmpFiles) {
    try {
      fs.unlinkSync(f);
    } catch (e) {
      void e;
    }
  }
  const total = pass + fails.length;
  console.log(
    '[image-decoders-regression] ' + (fails.length ? 'FAIL' : 'PASS') + ' ' + pass + '/' + total,
  );
  for (const f of fails) console.log('  FAIL: ' + f);
  process.exitCode = fails.length ? 1 : 0;
});
