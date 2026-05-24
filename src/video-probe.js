'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var playbackStrategy = require('./playback-strategy');

var DEFAULT_TIMEOUT_MS = 7000;
var MAX_CACHE_ENTRIES = 512;

function VideoProbe(opts) {
  opts = opts || {};
  this.ffmpegPath = opts.ffmpegPath || null;
  this.timeoutMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  this.cache = new Map();
}

VideoProbe.prototype._cacheKey = function (filePath, stat) {
  return [filePath, stat ? stat.mtimeMs : 0, stat ? stat.size : 0].join('\0');
};

VideoProbe.prototype._remember = function (key, value) {
  if (!key) return value;
  if (this.cache.has(key)) this.cache.delete(key);
  this.cache.set(key, value);
  while (this.cache.size > MAX_CACHE_ENTRIES) {
    var first = this.cache.keys().next().value;
    if (!first) break;
    this.cache.delete(first);
  }
  return value;
};

VideoProbe.prototype.probe = function (filePath, cb) {
  if (!this.ffmpegPath || !filePath) {
    cb(new Error('ffmpeg_unavailable'));
    return;
  }

  var stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    cb(e);
    return;
  }
  var key = this._cacheKey(filePath, stat);
  if (this.cache.has(key)) {
    cb(null, this.cache.get(key));
    return;
  }

  var ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  var child;
  var stderr = '';
  var done = false;
  var self = this;
  var timer = null;

  function finish(err, result) {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (child) {
      try {
        child.kill();
      } catch (eKill) {}
    }
    if (err) {
      cb(err);
      return;
    }
    cb(null, self._remember(key, result));
  }

  try {
    child = childProcess.spawn(
      this.ffmpegPath,
      ['-hide_banner', '-i', filePath],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (e2) {
    cb(e2);
    return;
  }

  timer = setTimeout(function () {
    console.error('[VideoProbe] Probe timeout for:', filePath, 'after', Math.max(1000, self.timeoutMs || DEFAULT_TIMEOUT_MS), 'ms');
    finish(new Error('probe_timeout'));
  }, Math.max(1000, this.timeoutMs || DEFAULT_TIMEOUT_MS));

  child.stderr.on('data', function (buf) {
    stderr += String(buf || '');
    if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024);
  });
  child.on('error', function (err) {
    console.error('[VideoProbe] FFmpeg process error for:', filePath, ':', err.message);
    finish(err);
  });
  child.on('close', function (code, signal) {
    if (code !== 0 && code !== null) {
      console.error('[VideoProbe] FFmpeg exited with code', code, 'signal', signal, 'for:', filePath);
      // 只记录 stderr 的最后 2KB 用于调试
      var lastStderr = stderr.slice(-2048);
      if (lastStderr) console.error('[VideoProbe] FFmpeg stderr (last 2KB):\n', lastStderr);
    }
    var info = parseFfmpegProbe(stderr);
    info.fileType = ext;
    finish(null, info);
  });
};

function parseFfmpegProbe(text) {
  var s = String(text || '');
  var inputLine = s.match(/Input #0,\s*([^,\n]+(?:,[^,\n]+)*)/);
  var videoLine = s.match(/Stream #.*Video:\s*([^,\n]+)([^\n]*)/);
  var audioLine = s.match(/Stream #.*Audio:\s*([^,\n]+)([^\n]*)/);
  var durationLine = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  var container = inputLine ? inputLine[1].trim().toLowerCase() : '';
  var videoCodec = videoLine ? normalizeCodec(videoLine[1]) : '';
  var audioCodec = audioLine ? normalizeCodec(audioLine[1]) : '';
  var durationSec = 0;
  var videoWidth = 0;
  var videoHeight = 0;

  // 提取分辨率，如 "2160x3840" 或 "1920x1080"
  if (videoLine && videoLine[2]) {
    var resMatch = videoLine[2].match(/(\d{3,4})x(\d{3,4})/);
    if (resMatch) {
      videoWidth = parseInt(resMatch[1], 10) || 0;
      videoHeight = parseInt(resMatch[2], 10) || 0;
    }
  }

  if (durationLine) {
    durationSec =
      (parseInt(durationLine[1], 10) || 0) * 3600 +
      (parseInt(durationLine[2], 10) || 0) * 60 +
      (parseFloat(durationLine[3]) || 0);
  }

  return {
    container: container,
    videoCodec: videoCodec,
    audioCodec: audioCodec,
    durationSec: durationSec,
    videoWidth: videoWidth,
    videoHeight: videoHeight,
    canDirectPlay: playbackStrategy.canDirectPlayCodecs(videoCodec, audioCodec),
    canRemuxForBrowser: playbackStrategy.canRemuxForBrowser(videoCodec, audioCodec),
  };
}

function normalizeCodec(codec) {
  var c = String(codec || '').trim().toLowerCase();
  if (!c) return '';
  if (c.indexOf('h264') >= 0 || c.indexOf('avc') >= 0) return 'h264';
  if (c.indexOf('hevc') >= 0 || c.indexOf('h265') >= 0) return 'hevc';
  if (c.indexOf('vp9') >= 0) return 'vp9';
  if (c.indexOf('vp8') >= 0) return 'vp8';
  if (c.indexOf('aac') >= 0) return 'aac';
  if (c.indexOf('mp3') >= 0) return 'mp3';
  if (c.indexOf('opus') >= 0) return 'opus';
  if (c.indexOf('vorbis') >= 0) return 'vorbis';
  if (c.indexOf('ac3') >= 0 || c.indexOf('eac3') >= 0) return 'ac3';
  return c.split(/\s+/)[0];
}

module.exports = VideoProbe;
