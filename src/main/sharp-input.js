'use strict';

/**
 * 「libvips 读不了的输入」→ 一个能喂给 sharp 的东西。**主进程与网页端共用这一份**。
 *
 * 🔴 为什么必须共用而不是各写一份：判据是「哪些扩展名要抢跑」+「抠出来的东西怎么包成 sharp
 *    实例」，两处各写必然漂移；而漂移的症状是 **桌面端出得了图、网页端破图**（或反过来）——
 *    两端都"看起来正常"，只是少了一部分图片，没有任何报错。项目里同类教训已经有过
 *    （见 `thumbnailBackfillBlockReason` 那条红线）。
 *
 * 分工与理由见 `image-decoders/index.js` / `raw-preview.js` 的头部注释。这里只做接线。
 */

const fs = require('fs');

/** 延迟加载 sharp（libvips），缩短冷启动到可显示窗口的时间。 */
var sharpModule = null;
function loadSharp() {
  if (!sharpModule) {
    sharpModule = require('sharp');
  }
  return sharpModule;
}

/** 延迟加载自研解码器与 RAW 内嵌预览提取 —— 两者纯 JS、体积小，但只有真遇到才需要。 */
var ownDecoderModule = null;
function loadOwnDecoders() {
  if (!ownDecoderModule) {
    ownDecoderModule = require('./image-decoders');
  }
  return ownDecoderModule;
}
var rawPreviewModule = null;
function loadRawPreview() {
  if (!rawPreviewModule) {
    rawPreviewModule = require('./raw-preview');
  }
  return rawPreviewModule;
}

/**
 * **只有这些扩展名才抢先自己解码**。
 *
 * 🔴 判据是「**libvips 打不开**」，不是「是不是 RAW」。这条判据**只能来自实测**：
 *   · `cr2` / `crw`（老式 Canon RAW）：TIFF 容器 + `Compression = 6`（old-style JPEG），
 *     libtiff 编译时没带 `OLD_JPEG` ⇒ 必然抛
 *     `Old-style JPEG compression support is not configured`（与 sharp 版本无关）。
 *   · `cr3`（ISO-BMFF）：**2026-10-06 实测 libvips 8.15.3 同样读不了**
 *     —— `Input file contains unsupported image format`。
 *     ⚠️ 这条**推翻了**早先「cr3 能直接读」的判断。那个印象来自真库
 *     `has_thumbnail = 1` 的比例（306/306），而那批缩略图与 `bmp` 的 100/102 一样是
 *     **历史遗留**：同一行的 `thumb_size = 0` / `width = 0` / `height = 0` 就是证据
 *     —— 真成功生成过不可能三列全 0。
 *     实测它的内嵌 JPEG 有三段（160×120 / 1620×1080 / **8192×5464**），抠全尺寸那段完全够用。
 *   · `nef` / `arw` / `dng` / `rw2` / `raf` 等**仍然刻意不进表** —— 它们多是普通 TIFF 容器，
 *     libvips 有很大机会直接读，抢跑只会把「真解码」降级成「读它内嵌的预览」。
 *     ⚠️ 想往表里加，**必须先实测 sharp 读不了**，再把实测结论写在这里；
 *       别拿 `has_thumbnail` 的比例当「能读」的证据。
 */
const OWN_DECODER_RAW_EXTENSIONS = new Set(['.cr2', '.crw', '.cr3']);

/**
 * libvips 读不了的格式：由我们自己解出**原始像素**（或抠出内嵌预览），再交给 sharp。
 *
 * 两类：
 *   ① **老式 / 不支持的 RAW**（`cr2` / `crw` / `cr3`）：从容器里抠出相机内嵌的全尺寸 JPEG 预览
 *      （`src/main/raw-preview.js`）。实测 `02901_02901_IMG (1).CR2` 能抠出
 *      5760×3840 / 1.89 MB 的完整 JPEG；CR3 能抠出 8192×5464 / 2.63 MB。
 *   ② **libvips 不支持格式**（`bmp` / `dib` / `ico` / `cur` / `pbm~pam` / `qoi` / `tga`）：
 *      自研解码器出原始像素（`src/main/image-decoders/`）。
 *      ⚠️ 这些扩展名**一直在扫描白名单里**却是「空承诺」——文件扫得进来、一张也出不了图。
 *
 * 🔴 **故意返回「像素」而不是自己生成缩略图**：这样尺寸 / dHash / 缩略图三条链路
 *    一行都不用改（它们本来就只认一个 sharp 实例），也就没有「两条路算出不同结果」的风险。
 *
 * @returns {{raw:{data:Buffer,width:number,height:number,channels:number}}
 *          |{input:Buffer, exif?:object, width?:number, height?:number}|null}
 *   `raw`   → 调用方用 `sharp(data, { raw: {...} })` 包一个实例
 *   `input` → 直接把这段字节交给 sharp（RAW 的内嵌 JPEG / ICO 里内嵌的 PNG）
 */
async function decodeWithOwnDecoder(filePath, buf) {
  var ext = '.' + String(filePath || '').split('.').pop().toLowerCase();
  try {
    if (OWN_DECODER_RAW_EXTENSIONS.has(ext)) {
      var info = await loadRawPreview().inspectRawContainer(filePath);
      if (!info || !info.preview) return null;
      // 🔴 `exif` 只能从**容器的 IFD** 读：Canon 的内嵌预览段本身**不带 APP1/EXIF**
      //    （实测三段全无），指望 sharp 从预览里读出拍摄参数是拿不到的。
      //    raw-preview 走的是 `src/main/exif-meta.js` 同一套字段规范。
      return {
        input: info.preview,
        exif: info.exif,
        width: info.width,
        height: info.height,
        via: 'raw-preview',
      };
    }
    if (!loadOwnDecoders().needsFallbackDecode(filePath)) return null;
    var data = buf && buf.length ? buf : await fs.promises.readFile(filePath);
    var r = loadOwnDecoders().decodeFallback(data, filePath);
    if (!r) return null;
    // ICO 条目里可能内嵌一张 PNG —— 原样交给 sharp 就行，没必要自己再解一遍
    if (r.embedded) return { input: r.embedded, via: 'ico-png' };
    return { raw: r, via: 'image-decoders' };
  } catch (eOwn) {
    // 🔴 这条路径**不许把异常抛给调用方**：它面对的是「本来就要失败」的文件，
    //    抛出去会把整行的尺寸 / dHash / 指纹一起带走 —— 那正是主进程里
    //    「缩略图生成单独一层 try」那条注释记的教训。
    void eOwn;
    return null;
  }
}

/**
 * 用 sharp 包一个「能读这个文件」的实例。
 * 正常格式走原路径（`sharp(buf || path)`）；libvips 读不了的格式先自己解成像素再包进去。
 *
 * 抽出来是因为**多处**都要用（缩略图分支、只补尺寸/EXIF 的分支、网页端三种预览）。
 * 各写一份必然漂移 —— 而漂移的症状是「同一张图，走哪条分支决定读不读得到」。
 *
 * @returns {Promise<{instance:*, own:(object|null)}>}
 */
async function createSharpInput(filePath, buf) {
  var own = await decodeWithOwnDecoder(filePath, buf);
  if (own && own.raw) {
    return {
      own: own,
      instance: loadSharp()(own.raw.data, {
        raw: {
          width: own.raw.width,
          height: own.raw.height,
          channels: own.raw.channels,
        },
        failOnError: false,
      }),
    };
  }
  if (own) return { own: own, instance: loadSharp()(own.input, { failOnError: false }) };
  return { own: null, instance: loadSharp()(buf || filePath, { failOnError: false }) };
}

/**
 * 网页端「**必须由我们转成 JPEG 才能显示**」的扩展名。
 *
 * 🔴 不能直接拿 `FALLBACK_EXTENSIONS`：那份清单的判据是「**libvips** 读不了」，
 *    而这里是「**浏览器**读不了」——两者不等价：
 *    · `bmp` / `ico` / `cur`：libvips 读不了，但浏览器原生能显示 ⇒ 发原文件更快更清晰；
 *    · 其余（dib / tga / qoi / pbm~pam）：浏览器也不认 ⇒ 直接发出去就是**破图**
 *      （而且会被标成 `image/jpeg`，浏览器解不出来，一声不吭）。
 *    所以这里显式扣掉前者，清单仍从 `FALLBACK_EXTENSIONS` 派生 —— 加新格式时自动跟上。
 */
const BROWSER_NATIVE_EXTENSIONS = new Set(['bmp', 'ico', 'cur']);

function needsOwnRender(filePathOrName) {
  var ext = loadOwnDecoders().extensionOf(filePathOrName);
  if (!ext) return false;
  if (BROWSER_NATIVE_EXTENSIONS.has(ext)) return false;
  return loadOwnDecoders().FALLBACK_EXTENSIONS.has(ext);
}

module.exports = {
  OWN_DECODER_RAW_EXTENSIONS,
  BROWSER_NATIVE_EXTENSIONS,
  decodeWithOwnDecoder,
  createSharpInput,
  needsOwnRender,
};
