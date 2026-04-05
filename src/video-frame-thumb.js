/**
 * 视频首帧缩略图（ffmpeg）与无帧时的占位 JPEG，供主进程 thumb 协议与 Web /thumb 共用。
 */
'use strict';

var spawn = require('child_process').spawn;

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
function extractVideoFrameJpeg(filePath, opts) {
  opts = opts || {};
  var ffmpegPath = opts.ffmpegPath;
  var size = Math.max(64, Math.min(1024, parseInt(opts.size, 10) || 256));
  var quality = Math.max(50, Math.min(95, parseInt(opts.quality, 10) || 75));

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
      loadSharp()(buf)
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: quality })
        .toBuffer()
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
function buildVideoPlaceholderJpeg(opts) {
  opts = opts || {};
  var size = Math.max(64, Math.min(1024, parseInt(opts.size, 10) || 256));
  var quality = Math.max(50, Math.min(95, parseInt(opts.quality, 10) || 75));
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
  return loadSharp()(Buffer.from(svg))
    .resize(size, size, { fit: 'cover' })
    .jpeg({ quality: quality })
    .toBuffer();
}

module.exports = {
  extractVideoFrameJpeg: extractVideoFrameJpeg,
  buildVideoPlaceholderJpeg: buildVideoPlaceholderJpeg,
};
