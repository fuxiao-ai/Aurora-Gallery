/**
 * 使用 hls.js（或 Safari 原生 HLS）播放 m3u8
 * hls.min.js 按需加载：首次需要 Hls 时才动态注入脚本，削减首屏 841KB。
 */
(function (global) {
  'use strict';

  var HLS_SCRIPT_URL = '/vendor/hls.min.js';
  var _hlsLoading = false;
  var _hlsCallbacks = [];

  function logHlsError(context, details, data) {
    var msg = '[HLS] ' + context;
    if (details) msg += ': ' + details;
    if (data) {
      if (data.type) msg += ' type=' + data.type;
      if (data.details) msg += ' details=' + data.details;
      if (data.fatal) msg += ' FATAL';
      if (data.response && data.response.code) msg += ' httpCode=' + data.response.code;
      if (data.networkDetails && data.networkDetails.status) msg += ' httpStatus=' + data.networkDetails.status;
    }
    console.error(msg);
    // 如果有调试日志函数，也输出到那里
    if (typeof Logger !== 'undefined' && Logger.error) {
      Logger.error(msg);
    }
  }

  function loadHlsScript() {
    if (typeof Hls !== 'undefined') {
      console.log('[HLS] Hls already available, skipping load');
      return;
    }
    if (_hlsLoading) {
      console.log('[HLS] Script already loading, skipping');
      return;
    }
    _hlsLoading = true;
    console.log('[HLS] Loading hls.min.js from:', HLS_SCRIPT_URL);
    var script = document.createElement('script');
    script.src = HLS_SCRIPT_URL;
    script.onload = function () {
      console.log('[HLS] hls.min.js loaded successfully, Hls:', typeof Hls);
      _hlsLoading = false;
      _hlsCallbacks.forEach(function (cb) {
        try {
          cb();
        } catch (e) {
          console.error('[HLS] Callback error during script load:', e);
        }
      });
      _hlsCallbacks = [];
    };
    script.onerror = function (e) {
      console.error('[HLS] Failed to load hls.min.js from:', HLS_SCRIPT_URL, 'error:', e);
      _hlsLoading = false;
      _hlsCallbacks = [];
    };
    document.head.appendChild(script);
  }

  function whenHlsReady(callback) {
    console.log('[HLS] whenHlsReady called, Hls:', typeof Hls);
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      console.log('[HLS] Hls already available and supported, calling callback');
      try {
        callback();
      } catch (e) {
        console.error('[HLS] Error in callback:', e);
      }
      return;
    }
    if (typeof Hls === 'undefined') {
      console.log('[HLS] Hls not available, queuing callback and loading script');
      _hlsCallbacks.push(callback);
      loadHlsScript();
    } else {
      console.log('[HLS] Hls available but not supported (Safari?)');
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

    whenHlsReady(function () {
      /* hls.js 不支持时（Safari），回退到原生播放 */
      if (typeof Hls === 'undefined' || !Hls.isSupported()) {
        if (video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = playlistAbsoluteUrl;
        }
        return;
      }
      var isFilePage = typeof location !== 'undefined' && location.protocol === 'file:';
      var hls = new Hls({
        enableWorker: !isFilePage,
        lowLatencyMode: false,
        maxBufferLength: 45,
        maxMaxBufferLength: 180,
      });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (!data) return;
        var errorType = data.type || 'unknown';
        var errorDetails = data.details || 'unknown';
        logHlsError('Playback error', errorType + '/' + errorDetails, data);
        if (data.fatal) {
          console.error('[HLS] Fatal error, destroying player');
          try {
            hls.destroy();
          } catch (e) {}
          // 显示用户友好的错误提示
          if (typeof appAlert === 'function') {
            appAlert('视频播放失败: ' + errorDetails);
          }
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        console.log('[HLS] Manifest parsed, starting playback');
      });
      hls.on(Hls.Events.FRAG_LOADED, function (event, data) {
        if (data && data.frag) {
          console.log('[HLS] Fragment loaded:', data.frag.sn);
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
