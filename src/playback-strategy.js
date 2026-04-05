/**
 * 视频播放策略（对齐 Emby 思路：Direct Stream / Transcode / External）
 * - Electron：custom protocol 直出 ≈ Direct Stream；TS/AVI 等走本机 HTTP + HLS 边转边播
 * - Web：可直链容器 ≈ Direct Stream；否则 HLS 转码串流（不等整文件）
 */
'use strict';

var VIDEO_FILE_TYPES = [
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'avi',
  'wmv',
  'webm',
  'flv',
  'mpg',
  'mpeg',
  'm2ts',
  'ts',
  '3gp',
  '3g2',
];

/** 网页端优先直链（常见 H.264/AAC 场景），其余走转码更稳妥 */
var WEB_DIRECT_STREAM_TYPES = {
  mp4: true,
  mov: true,
  m4v: true,
  webm: true,
};

function normalizeFileType(fileType) {
  if (fileType == null) return '';
  return String(fileType).toLowerCase().replace(/^\./, '');
}

function isVideoFileType(fileType) {
  var t = normalizeFileType(fileType);
  if (!t) return false;
  return VIDEO_FILE_TYPES.indexOf(t) >= 0;
}

/**
 * @returns {{ tier: 'none' } | { tier: 'direct_stream' } | { tier: 'hls_transcode' }}
 */
function resolveElectronVideoPlayback(fileType) {
  var t = normalizeFileType(fileType);
  if (!t || !isVideoFileType(t)) return { tier: 'none' };
  if (t === 'ts' || t === 'm2ts' || t === 'avi') {
    return { tier: 'hls_transcode' };
  }
  return { tier: 'direct_stream' };
}

/**
 * @returns {{ tier: 'none' } | { tier: 'direct_stream' } | { tier: 'transcode' }}
 */
function resolveWebVideoPlayback(fileType) {
  var t = normalizeFileType(fileType);
  if (!t || !isVideoFileType(t)) return { tier: 'none' };
  if (WEB_DIRECT_STREAM_TYPES[t]) return { tier: 'direct_stream' };
  return { tier: 'transcode' };
}

function electronVideoUrl(photoId) {
  return 'video://' + photoId;
}

function webDirectStreamUrl(photoId) {
  return '/video/' + photoId;
}

function hlsPlaylistPath(sessionId) {
  return '/hls/' + sessionId + '/stream.m3u8';
}

var api = {
  VIDEO_FILE_TYPES: VIDEO_FILE_TYPES,
  isVideoFileType: isVideoFileType,
  resolveElectronVideoPlayback: resolveElectronVideoPlayback,
  resolveWebVideoPlayback: resolveWebVideoPlayback,
  electronVideoUrl: electronVideoUrl,
  webDirectStreamUrl: webDirectStreamUrl,
  hlsPlaylistPath: hlsPlaylistPath,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.PhotoPlaybackStrategy = api;
}
