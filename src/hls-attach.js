/**
 * 使用 hls.js（或 Safari 原生 HLS）播放 m3u8
 * hls.min.js 按需加载：首次需要 Hls 时才动态注入脚本，削减首屏 841KB。
 */
(function (global) {
  'use strict';

  var HLS_SCRIPT_URL = '../web/vendor/hls.min.js';
  var _hlsLoading = false;
  var _hlsCallbacks = [];

  function loadHlsScript() {
    if (typeof Hls !== 'undefined') return;
    if (_hlsLoading) return;
    _hlsLoading = true;
    var script = document.createElement('script');
    script.src = HLS_SCRIPT_URL;
    script.onload = function () {
      _hlsLoading = false;
      _hlsCallbacks.forEach(function (cb) {
        try {
          cb();
        } catch (_e) {}
      });
      _hlsCallbacks = [];
    };
    script.onerror = function () {
      _hlsLoading = false;
      _hlsCallbacks = [];
    };
    document.head.appendChild(script);
  }

  function whenHlsReady(callback) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      try {
        callback();
      } catch (_e) {}
      return;
    }
    if (typeof Hls === 'undefined') {
      _hlsCallbacks.push(callback);
      loadHlsScript();
    }
  }

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

    /* Safari 原生支持 HLS（hls.js 在 Safari 上 isSupported 返回 false） */
    if (video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = playlistAbsoluteUrl;
      return;
    }

    whenHlsReady(function () {
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
    });
  }

  var api = { attach: attach, destroy: destroy };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.PhotoHlsAttach = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
