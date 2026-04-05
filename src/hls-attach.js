/**
 * 使用 hls.js（或 Safari 原生 HLS）播放 m3u8
 */
(function (global) {
  'use strict';

  function sessionIdFromPlaylistUrl(u) {
    var m = String(u || '').match(/\/hls\/([a-f0-9]{24})\//);
    return m ? m[1] : '';
  }

  function destroy(video) {
    if (!video) return;
    var sid = video.dataset && video.dataset.photoHlsSessionId;
    if (sid) {
      var cfg = global.PhotoHlsConfig;
      if (cfg && typeof cfg.onSessionEnd === 'function') {
        try {
          cfg.onSessionEnd(sid);
        } catch (e0) {}
      }
      try {
        delete video.dataset.photoHlsSessionId;
      } catch (e1) {}
    }
    if (video._photoHls) {
      try {
        video._photoHls.destroy();
      } catch (e) {}
      video._photoHls = null;
    }
    try {
      video.pause();
    } catch (e2) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (e3) {}
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {string} playlistAbsoluteUrl 完整 URL
   */
  function attach(video, playlistAbsoluteUrl) {
    if (!video || !playlistAbsoluteUrl) return;
    destroy(video);

    var sid = sessionIdFromPlaylistUrl(playlistAbsoluteUrl);
    if (sid && video.dataset) {
      video.dataset.photoHlsSessionId = sid;
    }

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      var isFilePage = typeof location !== 'undefined' && location.protocol === 'file:';
      var hls = new Hls({
        enableWorker: !isFilePage,
        lowLatencyMode: false,
        maxBufferLength: 45,
        maxMaxBufferLength: 180,
      });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (data && data.fatal) {
          try {
            hls.destroy();
          } catch (e) {}
        }
      });
      hls.loadSource(playlistAbsoluteUrl);
      hls.attachMedia(video);
      video._photoHls = hls;
      return;
    }

    if (video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlistAbsoluteUrl;
      return;
    }

    video.src = playlistAbsoluteUrl;
  }

  var api = { attach: attach, destroy: destroy };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.PhotoHlsAttach = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
