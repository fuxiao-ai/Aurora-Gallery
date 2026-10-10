'use strict';

/**
 * 自研图片解码器**统一入口** —— 只负责「libvips 读不了、我们自己能读」的那些格式。
 *
 * 🔴 为什么需要这一层：`sharp`（libvips 8.15.3）实测**只能读 9 种输入**
 *    （gif / heif / jpeg / png / raw / svg / tiff / vips / webp）。而扫描白名单里
 *    还写着 bmp / ico / pnm / tga / qoi —— 这些文件**扫得进来、一张也出不了图**
 *    （空承诺）。本目录逐个补上。
 *
 * 分工（2026-10-06 实测决定，不是拍脑袋）：
 *   · **BMP / ICO / PNM / TGA / QOI** → 自研。`@napi-rs/image` 只覆盖前三者中的
 *     BMP/ICO/PNM，**读不了 TGA/QOI**；`bmp-js` 解出来像素是错的（与 ffmpeg 黄金对照
 *     差 55%）。引一个 native 依赖换不到完整覆盖，还要改打包链路 ⇒ 不值。
 *   · **CR2 等 RAW** → 不走这里，走 `src/main/raw-preview.js`（要从文件里抠出内嵌 JPEG，
 *     需要能读文件而不只是拿 Buffer）。
 *
 * ⚠️ 调用姿势：**先让 sharp 试，失败了再来这里**（`decodeFallback`）。不要反过来 ——
 *    sharp 走的是 libvips 原生路径，对我们的常见格式更快、更全（heif/avif/webp 都只有它能读）。
 */

const bmpDecoder = require('./bmp');
const icoDecoder = require('./ico');
const pnmDecoder = require('./pnm');
const qoiDecoder = require('./qoi');
const tgaDecoder = require('./tga');

/**
 * magic → 解码器。**只列「magic 不会撞车」的格式。**
 *
 * 🔴 ICO / CUR 不在这里 —— 它们的 magic 是 `00 00 01 00` / `00 00 02 00`，
 *    而 **TGA 头的前 4 字节恰好是 `idLength, colorMapType, imageType, cmFirst低位`**，
 *    `imageType` 为 1/2（未压缩调色板/真彩）时就**逐字节撞上**。
 *    实测：`t_raw24.tga` 的头部就是 `00 00 02 00` ⇒ 会被误判成 CUR、
 *    接着 `decodeIco` 因 `count = 0` 返回 null ⇒ **整类 TGA 静默读不了**。
 *    ⇒ ICO/CUR 一律**按扩展名分流**（见 `ICO_EXTENSIONS`）。
 */
function detectKind(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'; // 'BM'
  if (buf[0] === 0x50 && buf[1] >= 0x31 && buf[1] <= 0x37) return 'pnm'; // 'P1'~'P7'
  if (buf.toString('latin1', 0, 4) === 'qoif') return 'qoi';
  return null;
}

/** ICO / CUR 的 magic 与 TGA 撞车，只能靠扩展名。 */
const ICO_EXTENSIONS = new Set(['ico', 'cur']);

/** TGA **没有 magic**（规范如此），只能靠扩展名。 */
const TGA_EXTENSIONS = new Set(['tga', 'targa', 'icb', 'vda', 'vst']);

/** 从路径/文件名取小写扩展名（不含点）。 */
function extensionOf(filePathOrName) {
  const s = String(filePathOrName || '');
  const at = s.lastIndexOf('.');
  return at < 0 ? '' : s.slice(at + 1).toLowerCase();
}

/**
 * 判断这个扩展名是不是「sharp 读不了、我们兜底」的格式。
 * ⚠️ 本函数**只表达意图**，真正的判据是「sharp 试过且失败了」—— 别用它替代尝试。
 */
const FALLBACK_EXTENSIONS = new Set([
  'bmp',
  'dib',
  'ico',
  'cur',
  'pbm',
  'pgm',
  'ppm',
  'pnm',
  'pam',
  'qoi',
  ...TGA_EXTENSIONS,
]);

function needsFallbackDecode(filePathOrName) {
  return FALLBACK_EXTENSIONS.has(extensionOf(filePathOrName));
}

/**
 * 兜底解码。**只在 sharp 已经失败之后调用。**
 *
 * 尝试顺序（**扩展名先于 magic**，这不是笔误）：
 *   ① 扩展名明确指向某个「magic 会撞车 / 无 magic」的容器（ico·cur / tga·targa / dib）→ 先试它；
 *   ② 再试 magic 判定的格式（bmp / pnm / qoi）——**magic 在这里是「确认」而不是「猜测」**，
 *      所以「后缀名写错、内容其实是 BMP」这种情况照样救得回来。
 * 任一成功即返回；全部失败返回 null（调用方维持「读不了」，走占位图）。
 *
 * @param {Buffer} buf 整个文件内容
 * @param {string} [filePathOrName] 用于 ico/cur/tga/dib 这类无法靠 magic 分流的格式
 * @returns {{data: Buffer, width: number, height: number, channels: 3|4}
 *          |{embedded: Buffer, format: 'png', width?: number, height?: number}
 *          |null}
 */
function decodeFallback(buf, filePathOrName) {
  if (!buf || !buf.length) return null;
  const ext = extensionOf(filePathOrName);
  const order = [];
  if (ICO_EXTENSIONS.has(ext)) order.push('ico');
  if (TGA_EXTENSIONS.has(ext)) order.push('tga');
  if (ext === 'dib') order.push('dib');
  const kind = detectKind(buf);
  if (kind) order.push(kind);

  for (const k of order) {
    let result = null;
    try {
      if (k === 'bmp') result = bmpDecoder.decodeBmp(buf);
      else if (k === 'dib') result = bmpDecoder.decodeDib(buf);
      else if (k === 'ico') result = icoDecoder.decodeIco(buf);
      else if (k === 'pnm') result = pnmDecoder.decodePnm(buf);
      else if (k === 'qoi') result = qoiDecoder.decodeQoi(buf);
      else if (k === 'tga') result = tgaDecoder.decodeTga(buf);
    } catch (eDecode) {
      // 🔴 自研解码器一律**不抛**到调用方：这里面对的是「本来就要失败」的输入，
      //    一个错字节就崩整条缩略图补全链路是最糟的结果。宁可返回 null 走占位图。
      //    ⚠️ 失败要 `continue` 而不是 `return null` —— 后面可能还有别的候选解码器。
      void eDecode;
      continue;
    }
    if (!result) continue;
    if (result.embedded) {
      return { embedded: result.embedded, format: result.format || 'png' };
    }
    if (!result.data || !result.width || !result.height) continue;
    return {
      data: result.data,
      width: result.width,
      height: result.height,
      channels: result.channels,
    };
  }
  return null;
}

module.exports = {
  decodeFallback,
  needsFallbackDecode,
  detectKind,
  extensionOf,
  FALLBACK_EXTENSIONS,
  ICO_EXTENSIONS,
  TGA_EXTENSIONS,
  bmp: bmpDecoder,
  ico: icoDecoder,
  pnm: pnmDecoder,
  qoi: qoiDecoder,
  tga: tgaDecoder,
};
