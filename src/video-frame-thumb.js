/**
 * 视频首帧缩略图（ffmpeg）与无帧时的占位图，供主进程 thumb 协议与 Web /thumb 共用。
 *
 * ⚠️ 命名里刻意不带编码格式：出什么格式由 `main/thumb-format.js#THUMB_ENCODE_FORMAT` 决定，
 *    以前叫 `…Jpeg` 时换 WebP 就变成了半个谎（主进程那两个包装函数从来没带过格式名）。
 */
'use strict';

var spawn = require('child_process').spawn;
var thumbFormat = require('./main/thumb-format');
var resizeThumb = thumbFormat.resizeThumb;
var encodeThumb = thumbFormat.encodeThumb;
var THUMB_DEFAULT_SIZE = thumbFormat.THUMB_DEFAULT_SIZE;
var THUMB_DEFAULT_QUALITY = thumbFormat.THUMB_DEFAULT_QUALITY;

var sharpModule = null;
function loadSharp() {
  if (!sharpModule) sharpModule = require('sharp');
  return sharpModule;
}

/**
 * @param {string} filePath
 * @param {{ ffmpegPath?: string, size?: number, quality?: number }} opts
 * @returns {Promise<Buffer|null>}
 */
function extractVideoFrameThumb(filePath, opts) {
  opts = opts || {};
  var ffmpegPath = opts.ffmpegPath;
  var size = Math.max(64, Math.min(4096, parseInt(opts.size, 10) || THUMB_DEFAULT_SIZE));
  var quality = Math.max(50, Math.min(95, parseInt(opts.quality, 10) || THUMB_DEFAULT_QUALITY));

  return new Promise(function (resolve) {
    if (!ffmpegPath || !filePath) {
      resolve(null);
      return;
    }
    var proc;
    try {
      var args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        '1',
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ];
      proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve(null);
      return;
    }

    var out = [];
    var outLen = 0;
    var maxOut = 8 * 1024 * 1024;
    var resolved = false;
    var killed = false;
    var timeout = setTimeout(function () {
      if (resolved) return;
      killed = true;
      try {
        proc.kill();
      } catch (e) {}
    }, 8000);

    function finish(bufOrNull) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve(bufOrNull);
    }

    if (proc.stdout) {
      proc.stdout.on('data', function (chunk) {
        if (resolved) return;
        if (!chunk) return;
        out.push(chunk);
        outLen += chunk.length || 0;
        if (outLen > maxOut) {
          try {
            proc.kill();
          } catch (e) {}
          finish(null);
        }
      });
    }
    if (proc.stderr) {
      proc.stderr.on('data', function () {});
    }
    proc.on('error', function () {
      finish(null);
    });
    proc.on('exit', function (code) {
      if (resolved) return;
      if (killed) {
        finish(null);
        return;
      }
      if (code !== 0) {
        finish(null);
        return;
      }
      if (outLen <= 0) {
        finish(null);
        return;
      }
      var buf = Buffer.concat(out);
      // 走共用算子：缩放 + 编码（编码格式的唯一来源在 thumb-format.js）
      resizeThumb(loadSharp()(buf), size, quality)
        .then(function (finalBuf) {
          finish(finalBuf);
        })
        .catch(function () {
          finish(null);
        });
    });
  });
}

/**
 * @param {{ size?: number, quality?: number }} opts
 * @returns {Promise<Buffer>}
 */
function buildVideoPlaceholderThumb(opts) {
  opts = opts || {};
  var size = Math.max(64, Math.min(4096, parseInt(opts.size, 10) || THUMB_DEFAULT_SIZE));
  var quality = Math.max(50, Math.min(95, parseInt(opts.quality, 10) || THUMB_DEFAULT_QUALITY));
  var svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 256 256">' +
    '<defs>' +
    '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#1b1c33"/>' +
    '<stop offset="1" stop-color="#0d0e1f"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<rect x="0" y="0" width="256" height="256" rx="28" fill="url(#g)"/>' +
    '<rect x="20" y="52" width="216" height="152" rx="20" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>' +
    '<path d="M112 92 L112 164 L172 128 Z" fill="rgba(255,255,255,0.86)"/>' +
    '<circle cx="128" cy="128" r="56" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="6"/>' +
    '</svg>';
  // 占位图是 SVG 画的方形图，用 `cover` 不用 `inside`（与图片那路不同），
  // 所以这里只借编码这一步，不借 `resizeThumb()` 的缩放形态。
  return encodeThumb(
    loadSharp()(Buffer.from(svg)).resize(size, size, { fit: 'cover' }),
    quality,
  );
}

module.exports = {
  extractVideoFrameThumb: extractVideoFrameThumb,
  buildVideoPlaceholderThumb: buildVideoPlaceholderThumb,
};
