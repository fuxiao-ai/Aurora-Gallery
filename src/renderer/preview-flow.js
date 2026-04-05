(function (global) {
  'use strict';

  function isVideoFileType(fileType) {
    var t = fileType != null ? String(fileType).toLowerCase() : '';
    if (!t) return false;
    return (
      [
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
      ].indexOf(t) >= 0
    );
  }

  function isInlinePlayableVideoType(fileType) {
    var t = fileType != null ? String(fileType).toLowerCase() : '';
    if (!t) return false;
    if (t === 'ts' || t === 'm2ts') return false;
    if (t === 'avi') return false;
    return true;
  }

  /** 左右切换进入视频时默认不自动播放（pauseAfterLoad） */
  function applyPauseVideoAfterSwitch(video, pauseAfterLoad) {
    if (!video || !pauseAfterLoad) return;
    function pauseOnce() {
      try {
        video.pause();
      } catch (e0) {}
      try {
        video.currentTime = 0;
      } catch (e1) {}
    }
    pauseOnce();
    var onReady = function () {
      pauseOnce();
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('playing', onPlaying);
    };
    var onPlaying = function () {
      pauseOnce();
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('playing', onPlaying);
    setTimeout(function () {
      video.removeEventListener('playing', onPlaying);
    }, 2000);
  }

  /** 桌面端：Direct Stream 用 video://；需转码时用本机 HTTP + HLS 边转边播 */
  function attachElectronVideo(photo, video, api, electronTier, state, dom, attachOpts) {
    attachOpts = attachOpts || {};
    var pauseAfterLoad = !!attachOpts.pauseAfterLoad;
    if (!video) return;
    if (global.PhotoHlsAttach) {
      global.PhotoHlsAttach.destroy(video);
    } else {
      try {
        video.pause();
      } catch (e0) {}
      video.removeAttribute('src');
      try {
        video.load();
      } catch (e1) {}
    }

    var useHls = electronTier && electronTier.tier === 'hls_transcode';
    if (!useHls) {
      video.src = 'video://' + photo.id;
      try {
        video.load();
      } catch (e2) {}
      applyPauseVideoAfterSwitch(video, pauseAfterLoad);
      return;
    }

    if (!(api && api.has && api.has('getWebLocalBaseUrl'))) {
      video.src = 'video://' + photo.id;
      try {
        video.load();
      } catch (e4) {}
      applyPauseVideoAfterSwitch(video, pauseAfterLoad);
      return;
    }

    var openedId = photo.id;
    api.call('getWebLocalBaseUrl').then(function (base) {
      if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return;
      var cur = state.previewPhotos[state.previewIndex];
      if (!cur || cur.id !== openedId) return;
      if (!base) {
        video.src = 'video://' + photo.id;
        try {
          video.load();
        } catch (e6) {}
        applyPauseVideoAfterSwitch(video, pauseAfterLoad);
        return;
      }
      var root = String(base).replace(/\/$/, '');
      fetch(root + '/api/video-playback?id=' + photo.id)
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return;
          var cur2 = state.previewPhotos[state.previewIndex];
          if (!cur2 || cur2.id !== openedId) return;
          if (data.playlistUrl && global.PhotoHlsAttach) {
            global.PhotoHlsAttach.attach(video, root + data.playlistUrl);
          } else {
            video.src = 'video://' + photo.id;
            try {
              video.load();
            } catch (e9) {}
          }
          applyPauseVideoAfterSwitch(video, pauseAfterLoad);
        })
        .catch(function () {
          if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return;
          var cur3 = state.previewPhotos[state.previewIndex];
          if (!cur3 || cur3.id !== openedId) return;
          video.src = 'video://' + photo.id;
          try {
            video.load();
          } catch (e11) {}
          applyPauseVideoAfterSwitch(video, pauseAfterLoad);
        });
    });
  }

  function initPreviewState(options) {
    options = options || {};
    var state = options.state || {};
    var result = options.result || {};
    var total = Number(result.total);
    if (!isFinite(total) || total < 0) total = 0;
    var totalPages = Number(result.totalPages);
    if (!isFinite(totalPages) || totalPages < 0) totalPages = 0;
    state.previewTotalPhotos = total;
    // 空列表时 API 常返回 totalPages=0；不能用 || 1，否则预加载会误判「还有第 1 页」反复 IPC
    if (total === 0) {
      state.previewTotalPages = 0;
    } else if (totalPages > 0) {
      state.previewTotalPages = totalPages;
    } else {
      var ps = parseInt(state.pageSize, 10);
      if (!isFinite(ps) || ps <= 0) ps = 100;
      state.previewTotalPages = Math.max(1, Math.ceil(total / ps));
    }
  }

  function wireVideoCenterPlay(dom, video) {
    var btn = dom && dom.previewVideoCenterPlay;
    if (!btn || !video) return;
    if (btn._wiredVideoCenterPlay) return;
    btn._wiredVideoCenterPlay = true;

    var sync = function () {
      if (!video || video.style.display === 'none') {
        btn.style.display = 'none';
        return;
      }
      var paused = !!video.paused || !!video.ended;
      btn.style.display = paused ? '' : 'none';
      btn.innerHTML = paused
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v10l8-5z"></path></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7h2.8v10H9zm4.2 0H16v10h-2.8z"></path></svg>';
      btn.setAttribute('aria-label', paused ? '播放视频' : '暂停视频');
      btn.title = paused ? '播放' : '暂停';
    };

    btn.addEventListener('click', function () {
      if (video.paused || video.ended) {
        video.play().catch(function () {});
      } else {
        video.pause();
      }
      sync();
    });
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    video.addEventListener('ended', sync);
    video.addEventListener('loadeddata', sync);
    video.addEventListener('waiting', sync);
    video.addEventListener('canplay', sync);
    video.addEventListener('click', function () {
      // 点击视频区域也联动中间按钮显隐
      setTimeout(sync, 0);
    });

    btn._syncVideoCenterPlay = sync;
    video._syncVideoCenterPlay = sync;
  }

  function clearManagedSubtitleTrack(video) {
    if (!video) return;
    var tracks = video.querySelectorAll('track[data-managed-subtitle="1"]');
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i] && tracks[i].parentNode) tracks[i].parentNode.removeChild(tracks[i]);
    }
    if (video._managedSubtitleBlobUrl) {
      try {
        URL.revokeObjectURL(video._managedSubtitleBlobUrl);
      } catch (e0) {}
      video._managedSubtitleBlobUrl = '';
    }
  }

  function syncSubtitleToolbar(options) {
    options = options || {};
    var dom = options.dom || {};
    var state = options.state || {};
    var isVideo = !!options.isVideo;
    var hasExternal = !!options.hasExternal;
    var video = options.video || null;
    var sel = dom.previewSubtitleTrackSelect;
    var styleBtn = document.getElementById('previewSubtitleSettingsBtn');
    var stylePanel = document.getElementById('previewSubtitleSettingsPanel');
    if (!sel) return;
    if (!isVideo) {
      sel.style.display = 'none';
      if (styleBtn) styleBtn.style.display = 'none';
      if (stylePanel) stylePanel.style.display = 'none';
      return;
    }
    var embedded = Array.isArray(state.previewEmbeddedSubtitleStreams)
      ? state.previewEmbeddedSubtitleStreams
      : [];
    if (!hasExternal && String(state.previewExternalSubtitleSourceName || '').trim()) hasExternal = true;
    var hasEmbedded = embedded.length > 0;
    if (video && !video._subtitleUiReady && !hasExternal && !hasEmbedded) {
      sel.style.display = 'none';
      if (styleBtn) styleBtn.style.display = 'none';
      if (stylePanel) stylePanel.style.display = 'none';
      return;
    }
    if (video && (hasExternal || hasEmbedded)) video._subtitleUiReady = true;
    sel.style.display = '';
    if (styleBtn) styleBtn.style.display = '';
    refreshSubtitleTrackOptions(dom, state, video, hasExternal);
    var targetMode = state.previewSubtitleEnabled ? state.previewSubtitleMode || 'external_auto' : 'off';
    if (!sel.querySelector('option[value="' + targetMode + '"]')) targetMode = 'off';
    sel.value = targetMode;
    var autoOpt = sel.querySelector('option[value="external_auto"]');
    if (autoOpt) {
      if (!hasExternal) {
        autoOpt.textContent = '字幕: 外挂(无)';
      } else {
        var src = String(state.previewExternalSubtitleSourceName || '').trim();
        if (src.length > 26) src = src.slice(0, 23) + '...';
        autoOpt.textContent = src ? '字幕: 外挂(' + src + ')' : '字幕: 外挂(自动)';
      }
    }
  }

  function wireSubtitleStyleQuickPanel(state, api) {
    var btn = document.getElementById('previewSubtitleSettingsBtn');
    var panel = document.getElementById('previewSubtitleSettingsPanel');
    var sizeInput = document.getElementById('previewSubtitleSizeInput');
    var weightSel = document.getElementById('previewSubtitleWeightSelect');
    var colorSel = document.getElementById('previewSubtitleColorSelect');
    var applyBtn = document.getElementById('previewSubtitleSettingsApplyBtn');
    var closeBtn = document.getElementById('previewSubtitleSettingsCloseBtn');
    if (!btn || !panel || !sizeInput || !weightSel || !colorSel || !applyBtn || !closeBtn) return;
    if (panel._wiredSubtitleStyleQuickPanel) return;
    panel._wiredSubtitleStyleQuickPanel = true;

    function normalizeSize(v) {
      var n = parseInt(v, 10);
      if (isNaN(n)) n = 22;
      if (n < 12) n = 12;
      if (n > 72) n = 72;
      return n;
    }
    function normalizeWeight(v) {
      var s = String(v || '').trim().toLowerCase();
      if (s === 'normal' || s === 'bold') return s;
      return 'medium';
    }
    function normalizeColor(v) {
      var s = String(v || '').trim().toLowerCase();
      if (['yellow', 'cyan', 'green', 'orange', 'pink'].indexOf(s) >= 0) return s;
      return 'white';
    }
    function applyCss(sizePx, weight, color) {
      var root = document.documentElement;
      var weightMap = { normal: '400', medium: '500', bold: '700' };
      var colorMap = {
        white: '#ffffff',
        yellow: '#fff3a1',
        cyan: '#baf8ff',
        green: '#b8ffb6',
        orange: '#ffd2a6',
        pink: '#ffc4e6',
      };
      root.style.setProperty('--subtitle-font-size', String(sizePx) + 'px');
      root.style.setProperty('--subtitle-font-weight', weightMap[weight] || '500');
      root.style.setProperty('--subtitle-color', colorMap[color] || '#ffffff');
    }
    function syncFromState() {
      var ap = state.generalSettingsApplied || {};
      sizeInput.value = String(normalizeSize(ap.subtitleFontSizePx));
      weightSel.value = normalizeWeight(ap.subtitleFontWeight);
      colorSel.value = normalizeColor(ap.subtitleColor);
    }
    function persistFromUi() {
      var sizePx = normalizeSize(sizeInput.value);
      var weight = normalizeWeight(weightSel.value);
      var color = normalizeColor(colorSel.value);
      sizeInput.value = String(sizePx);
      weightSel.value = weight;
      colorSel.value = color;
      applyCss(sizePx, weight, color);
      if (!(api && api.has && api.has('updateSettings'))) return;
      api
        .updateSettings({
          subtitleFontSizePx: sizePx,
          subtitleFontWeight: weight,
          subtitleColor: color,
        })
        .then(function (r) {
          if (!state.generalSettingsApplied) state.generalSettingsApplied = {};
          state.generalSettingsApplied.subtitleFontSizePx = normalizeSize(r.subtitleFontSizePx);
          state.generalSettingsApplied.subtitleFontWeight = normalizeWeight(r.subtitleFontWeight);
          state.generalSettingsApplied.subtitleColor = normalizeColor(r.subtitleColor);
        })
        .catch(function () {});
    }

    btn.addEventListener('click', function (e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      syncFromState();
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });
    applyBtn.addEventListener('click', function (e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      persistFromUi();
      panel.style.display = 'none';
    });
    closeBtn.addEventListener('click', function (e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      panel.style.display = 'none';
    });
    panel.addEventListener('click', function (e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    });
    document.addEventListener('click', function () {
      if (panel.style.display !== 'none') panel.style.display = 'none';
    });
    document.addEventListener('keydown', function (e) {
      if (e && e.key === 'Escape' && panel.style.display !== 'none') panel.style.display = 'none';
    });
    syncFromState();
  }

  function _getEmbeddedSubtitleTracks(video) {
    var arr = [];
    if (!video || !video.textTracks) return arr;
    try {
      for (var i = 0; i < video.textTracks.length; i++) {
        var t = video.textTracks[i];
        if (!t) continue;
        var kind = String(t.kind || '').toLowerCase();
        if (kind !== 'subtitles' && kind !== 'captions') continue;
        arr.push({
          index: i,
          label: String(t.label || '').trim() || '内嵌字幕 ' + (arr.length + 1),
          lang: String(t.language || '').trim(),
        });
      }
    } catch (e0) {}
    return arr;
  }

  function _pickPreferredEmbeddedTrack(state, embeddedTracks) {
    if (!embeddedTracks || !embeddedTracks.length) return null;
    var prefLang = String((state && state.previewSubtitlePreferredLang) || '')
      .trim()
      .toLowerCase();
    var prefLabel = String((state && state.previewSubtitlePreferredLabel) || '')
      .trim()
      .toLowerCase();
    var i;
    if (prefLang) {
      for (i = 0; i < embeddedTracks.length; i++) {
        var lang = String(embeddedTracks[i].lang || '')
          .trim()
          .toLowerCase();
        if (lang && lang === prefLang) return embeddedTracks[i];
      }
    }
    if (prefLabel) {
      for (i = 0; i < embeddedTracks.length; i++) {
        var label = String(embeddedTracks[i].label || '')
          .trim()
          .toLowerCase();
        if (label && label === prefLabel) return embeddedTracks[i];
      }
    }
    // 默认优先中文字幕轨
    for (i = 0; i < embeddedTracks.length; i++) {
      var t = embeddedTracks[i] || {};
      var lang2 = String(t.lang || t.language || '')
        .trim()
        .toLowerCase();
      var langName = String(t.langName || '')
        .trim()
        .toLowerCase();
      var label2 = String(t.label || '')
        .trim()
        .toLowerCase();
      var isZhLang =
        lang2 === 'zh' ||
        lang2 === 'zho' ||
        lang2 === 'chi' ||
        lang2 === 'cmn' ||
        lang2.indexOf('zh-') === 0;
      var isZhText =
        langName.indexOf('中') >= 0 ||
        label2.indexOf('中文') >= 0 ||
        label2.indexOf('中字') >= 0 ||
        label2.indexOf('简体') >= 0 ||
        label2.indexOf('繁体') >= 0 ||
        label2.indexOf('chs') >= 0 ||
        label2.indexOf('cht') >= 0;
      if (isZhLang || isZhText) return embeddedTracks[i];
    }
    return null;
  }

  function refreshSubtitleTrackOptions(dom, state, video, hasExternal) {
    var sel = dom && dom.previewSubtitleTrackSelect;
    if (!sel) return;
    var current = state.previewSubtitleMode || 'external_auto';
    while (sel.options.length > 2) sel.remove(2);
    var embedded = Array.isArray(state.previewEmbeddedSubtitleStreams)
      ? state.previewEmbeddedSubtitleStreams
      : [];
    if (!hasExternal && String(state.previewExternalSubtitleSourceName || '').trim()) hasExternal = true;
    function displayLang(stream) {
      if (!stream) return '';
      var n = String(stream.langName || '').trim();
      if (n) return n;
      var c = String(stream.lang || '').trim();
      if (!c) return '';
      var m = {
        zh: '中文',
        zho: '中文',
        chi: '中文',
        'zh-cn': '简体中文',
        'zh-hans': '简体中文',
        'zh-tw': '繁体中文',
        'zh-hant': '繁体中文',
        en: 'English',
        eng: 'English',
        ja: '日本語',
        jpn: '日本語',
        ko: '한국어',
        kor: '한국어',
      };
      var lc = c.toLowerCase();
      return m[lc] || m[lc.split('-')[0]] || c;
    }
    for (var i = 0; i < embedded.length; i++) {
      var opt = document.createElement('option');
      var idx = embedded[i].streamIndex;
      if (idx === undefined || idx === null) idx = embedded[i].index;
      var ffIdx = embedded[i].ffIndex;
      if (ffIdx !== undefined && ffIdx !== null && !isNaN(parseInt(ffIdx, 10))) {
        opt.value = 'embedded_ffstream_' + parseInt(ffIdx, 10);
      } else {
        opt.value = 'embedded_stream_' + idx;
      }
      var langText = displayLang(embedded[i]);
      var labelText = embedded[i].label || embedded[i].codec || 'Subtitle';
      opt.textContent =
        '字幕: 内嵌 #' +
        (Number(idx) + 1) +
        ' ' +
        labelText +
        (langText ? ' [' + langText + ']' : embedded[i].lang ? ' [' + embedded[i].lang + ']' : '');
      sel.appendChild(opt);
    }
    var autoOpt = sel.querySelector('option[value="external_auto"]');
    if (autoOpt) {
      if (!hasExternal) {
        autoOpt.textContent = '字幕: 外挂(无)';
      } else {
        var src = String(state.previewExternalSubtitleSourceName || '').trim();
        if (src.length > 26) src = src.slice(0, 23) + '...';
        autoOpt.textContent = src ? '字幕: 外挂(' + src + ')' : '字幕: 外挂(自动)';
      }
    }
    if (
      !sel.querySelector('option[value="' + current + '"]') &&
      (/^embedded_stream_/.test(current) || /^embedded_ffstream_/.test(current))
    ) {
      state.previewSubtitleMode = 'external_auto';
    }
  }

  function setTextTracksMode(video, mode, showTrackIndex) {
    if (!video || !video.textTracks) return;
    try {
      for (var i = 0; i < video.textTracks.length; i++) {
        var t = video.textTracks[i];
        if (!t) continue;
        if (mode === 'embedded' && i === showTrackIndex) t.mode = 'showing';
        else t.mode = 'disabled';
      }
    } catch (e0) {}
  }

  function loadExternalSubtitle(options) {
    options = options || {};
    var photo = options.photo;
    var video = options.video;
    var api = options.api;
    var dom = options.dom || {};
    var state = options.state || {};
    var streamIndex = parseInt(options.streamIndex, 10);
    if (isNaN(streamIndex) || streamIndex < 0) streamIndex = -1;
    var ffStreamIndex = parseInt(options.ffStreamIndex, 10);
    if (isNaN(ffStreamIndex) || ffStreamIndex < 0) ffStreamIndex = -1;
    var trackLabel = String(options.trackLabel || '').trim();
    var trackLang = String(options.trackLang || '').trim();
    var forceExternalCheck = options.forceExternalCheck === true;
    var onDone = typeof options.onDone === 'function' ? options.onDone : function () {};
    if (!photo || !video) {
      state.previewExternalSubtitleSourceName = '';
      onDone(false);
      return;
    }
    // 已知无外挂字幕时，外挂机制直接跳过，避免 /api/video-subtitle 404 噪音。
    if (
      !forceExternalCheck &&
      streamIndex < 0 &&
      ffStreamIndex < 0 &&
      state.previewHasExternalSubtitle === false
    ) {
      try {
        var isDev =
          (typeof window !== 'undefined' &&
            window &&
            window.location &&
            String(window.location.search || '').indexOf('--dev') >= 0) ||
          false;
        if (isDev && typeof console !== 'undefined' && console && typeof console.log === 'function') {
          console.log(
            '[subtitle] skip external request: no external subtitle candidate for photo id=%s',
            photo && photo.id != null ? String(photo.id) : '',
          );
        }
      } catch (eLog) {}
      state.previewExternalSubtitleSourceName = '';
      clearManagedSubtitleTrack(video);
      onDone(false);
      return;
    }
    if (!state.previewSubtitleEnabled || state.previewSubtitleMode === 'off') {
      state.previewExternalSubtitleSourceName = '';
      clearManagedSubtitleTrack(video);
      onDone(false);
      return;
    }
    if (!(api && api.has && api.has('getWebLocalBaseUrl'))) {
      state.previewExternalSubtitleSourceName = '';
      clearManagedSubtitleTrack(video);
      onDone(false);
      return;
    }
    var openedId = photo.id;
    api
      .call('getWebLocalBaseUrl')
      .then(function (base) {
        if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) {
          onDone(false);
          return;
        }
        var cur = state.previewPhotos[state.previewIndex];
        if (!cur || cur.id !== openedId) {
          onDone(false);
          return;
        }
        if (!base) {
          state.previewExternalSubtitleSourceName = '';
          clearManagedSubtitleTrack(video);
          onDone(false);
          return;
        }
        var root = String(base).replace(/\/$/, '');
        var url = root + '/api/video-subtitle?id=' + encodeURIComponent(photo.id);
        if (ffStreamIndex >= 0) url += '&ffStream=' + encodeURIComponent(String(ffStreamIndex));
        if (streamIndex >= 0) url += '&stream=' + encodeURIComponent(String(streamIndex));
        return fetch(url)
          .then(function (res) {
            if (!res.ok) {
              return res
                .json()
                .then(function (_detail) {
                  throw new Error('subtitle_not_found');
                })
                .catch(function () {
                  throw new Error('subtitle_not_found');
                });
            }
            var sourceName = String(res.headers.get('X-Photo-Subtitle-Source') || '').trim();
            if (sourceName) {
              try {
                sourceName = decodeURIComponent(sourceName);
              } catch (eDecode) {}
            }
            return res.text().then(function (text) {
              return { text: text, sourceName: sourceName };
            });
          })
          .then(function (payload) {
            if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) {
              onDone(false);
              return;
            }
            var cur2 = state.previewPhotos[state.previewIndex];
            if (!cur2 || cur2.id !== openedId) {
              onDone(false);
              return;
            }
            state.previewExternalSubtitleSourceName = payload && payload.sourceName ? payload.sourceName : '';
            clearManagedSubtitleTrack(video);
            var blob = new Blob([String((payload && payload.text) || '')], {
              type: 'text/vtt;charset=utf-8',
            });
            var blobUrl = URL.createObjectURL(blob);
            video._managedSubtitleBlobUrl = blobUrl;
            var track = document.createElement('track');
            track.setAttribute('data-managed-subtitle', '1');
            track.kind = 'subtitles';
            track.label = trackLabel || (streamIndex >= 0 ? '内嵌字幕 #' + (streamIndex + 1) : '外挂字幕');
            track.srclang = trackLang || 'zh';
            track.src = blobUrl;
            track.default = true;
            video.appendChild(track);
            var finished = false;
            function finish(ok) {
              if (finished) return;
              finished = true;
              onDone(!!ok);
            }
            function forceActivateTrack() {
              try {
                if (video.textTracks && video.textTracks.length) {
                  for (var i = 0; i < video.textTracks.length; i++) {
                    video.textTracks[i].mode = 'disabled';
                  }
                }
                if (track.track) {
                  // 先 hidden 再 showing，可减少部分内核切换不刷新的情况
                  track.track.mode = 'hidden';
                  track.track.mode = 'showing';
                }
                // 触发字幕层重绘，避免“切换后要等一会儿才显示”
                var ct = Number(video.currentTime || 0);
                if (!isNaN(ct) && ct >= 0) {
                  video.currentTime = ct;
                }
              } catch (e1) {}
            }
            // 立即尝试 + 短重试，提升“立刻生效”体感
            forceActivateTrack();
            setTimeout(forceActivateTrack, 80);
            setTimeout(forceActivateTrack, 220);
            track.addEventListener('load', function () {
              forceActivateTrack();
              try {
                var cues = track.track && track.track.cues ? track.track.cues.length : 0;
                if (!cues) {
                  // 兜底重试一次，处理个别内核初次解析无 cue 的情况
                  setTimeout(forceActivateTrack, 180);
                }
              } catch (eCue) {}
              finish(true);
            });
            track.addEventListener('error', function () {
              finish(false);
            });
            setTimeout(function () {
              // 某些环境不会触发 load 事件，兜底认为成功并继续
              forceActivateTrack();
              finish(true);
            }, 380);
          })
          .catch(function () {
            state.previewExternalSubtitleSourceName = '';
            clearManagedSubtitleTrack(video);
            onDone(false);
          });
      })
      .catch(function () {
        state.previewExternalSubtitleSourceName = '';
        clearManagedSubtitleTrack(video);
        onDone(false);
      });
  }

  function loadEmbeddedSubtitleStreams(options) {
    options = options || {};
    var photo = options.photo;
    var api = options.api;
    var dom = options.dom || {};
    var state = options.state || {};
    var video = options.video;
    if (!photo || !(api && api.has && api.has('getWebLocalBaseUrl'))) {
      state.previewEmbeddedSubtitleStreams = [];
      refreshSubtitleTrackOptions(dom, state, video, false);
      return Promise.resolve([]);
    }
    return api
      .call('getWebLocalBaseUrl')
      .then(function (base) {
        if (!base) return [];
        var root = String(base).replace(/\/$/, '');
        return fetch(root + '/api/video-subtitle-streams?id=' + encodeURIComponent(photo.id))
          .then(function (r) {
            if (!r.ok) return [];
            return r.json();
          })
          .then(function (data) {
            var tracks = data && Array.isArray(data.tracks) ? data.tracks : [];
            state.previewHasExternalSubtitle = !!(data && data.hasExternal);
            state.previewEmbeddedSubtitleStreams = tracks;
            return tracks;
          })
          .catch(function () {
            state.previewHasExternalSubtitle = null;
            state.previewEmbeddedSubtitleStreams = [];
            return [];
          });
      })
      .then(function (tracks) {
        refreshSubtitleTrackOptions(dom, state, video, false);
        return tracks;
      });
  }

  function wireSubtitleToolbar(dom, state, api, video) {
    var sel = dom && dom.previewSubtitleTrackSelect;
    if (!sel || !video) return;
    if (sel._wiredSubtitleToolbar) return;
    sel._wiredSubtitleToolbar = true;
    video._subtitleUiReady = false;
    wireSubtitleStyleQuickPanel(state, api);

    var applyMode = function (photo) {
      if (!photo) return;
      var mode = state.previewSubtitleMode || 'external_auto';
      if (!state.previewSubtitleEnabled || mode === 'off') {
        clearManagedSubtitleTrack(video);
        setTextTracksMode(video, 'disabled');
        syncSubtitleToolbar({ dom: dom, state: state, isVideo: true, hasExternal: false, video: video });
        return;
      }
      if (/^embedded_stream_\d+$/.test(mode) || /^embedded_ffstream_\d+$/.test(mode)) {
        clearManagedSubtitleTrack(video);
        var idx = -1;
        var ffIdx = -1;
        if (/^embedded_ffstream_\d+$/.test(mode)) {
          ffIdx = parseInt(mode.slice('embedded_ffstream_'.length), 10);
        } else {
          idx = parseInt(mode.slice('embedded_stream_'.length), 10);
        }
        var embeddedNow = Array.isArray(state.previewEmbeddedSubtitleStreams)
          ? state.previewEmbeddedSubtitleStreams
          : [];
        for (var ei = 0; ei < embeddedNow.length; ei++) {
          var streamIdx = embeddedNow[ei].streamIndex;
          var streamFfIdx = embeddedNow[ei].ffIndex;
          if (streamIdx === undefined || streamIdx === null) streamIdx = embeddedNow[ei].index;
          if (
            (!isNaN(ffIdx) && ffIdx >= 0 && parseInt(streamFfIdx, 10) === ffIdx) ||
            (!isNaN(idx) && idx >= 0 && streamIdx === idx)
          ) {
            state.previewSubtitlePreferredLang = embeddedNow[ei].lang || '';
            state.previewSubtitlePreferredLabel =
              embeddedNow[ei].label || embeddedNow[ei].codec || 'Subtitle';
            if (isNaN(idx) || idx < 0) idx = streamIdx;
            if (isNaN(ffIdx) || ffIdx < 0)
              ffIdx =
                streamFfIdx !== undefined && streamFfIdx !== null ? parseInt(streamFfIdx, 10) : -1;
            if (!isNaN(ffIdx) && ffIdx >= 0) state.previewSubtitleMode = 'embedded_ffstream_' + ffIdx;
            else if (!isNaN(idx) && idx >= 0) state.previewSubtitleMode = 'embedded_stream_' + idx;
            break;
          }
        }
        loadExternalSubtitle({
          photo: photo,
          video: video,
          api: api,
          dom: dom,
          state: state,
          ffStreamIndex: ffIdx,
          streamIndex: idx,
          trackLabel: '内嵌字幕 #' + (idx + 1),
          trackLang: state.previewSubtitlePreferredLang || '',
          onDone: function (okEmbedded) {
            syncSubtitleToolbar({
              dom: dom,
              state: state,
              isVideo: true,
              hasExternal: okEmbedded,
              video: video,
            });
          },
        });
        return;
      }
      loadExternalSubtitle({
        photo: photo,
        video: video,
        api: api,
        dom: dom,
        state: state,
        onDone: function (ok) {
          if (!ok) setTextTracksMode(video, 'disabled');
          syncSubtitleToolbar({ dom: dom, state: state, isVideo: true, hasExternal: ok, video: video });
        },
      });
    };

    sel.addEventListener('change', function () {
      var mode = sel.value || 'external_auto';
      state.previewSubtitleMode = mode;
      state.previewSubtitleEnabled = mode !== 'off';
      var cur = state.previewPhotos[state.previewIndex];
      if (!cur) return;
      applyMode(cur);
    });

    video.addEventListener('loadedmetadata', function () {
      var cur = state.previewPhotos[state.previewIndex];
      if (!cur) return;
      loadEmbeddedSubtitleStreams({ photo: cur, api: api, dom: dom, state: state, video: video }).then(function (
        embedded,
      ) {
        var hasEmbedded = Array.isArray(embedded) && embedded.length > 0;
        if (state.previewSubtitleEnabled && (!state.previewSubtitleMode || state.previewSubtitleMode === 'off')) {
          state.previewSubtitleMode = 'external_auto';
        } else if (
          /^embedded_stream_/.test(String(state.previewSubtitleMode || '')) ||
          /^embedded_ffstream_/.test(String(state.previewSubtitleMode || ''))
        ) {
          // 内嵌模式仅在本视频确实有内嵌轨道时保留，否则回到外挂自动
          if (!hasEmbedded) state.previewSubtitleMode = 'external_auto';
        }
        refreshSubtitleTrackOptions(dom, state, video, false);
        syncSubtitleToolbar({ dom: dom, state: state, isVideo: true, hasExternal: false, video: video });
      });
    });
    video.addEventListener('loadeddata', function () {
      refreshSubtitleTrackOptions(dom, state, video, false);
    });
    video.addEventListener('play', function () {
      video._subtitleUiReady = true;
      syncSubtitleToolbar({ dom: dom, state: state, isVideo: true, hasExternal: false, video: video });
    });
  }

  function openPreview(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api || null;
    var index = options.index;
    var onSyncPreviewDisplayOptionsFromSettings = options.onSyncPreviewDisplayOptionsFromSettings;
    var onPreviewDisplaySliceFromSettings = options.onPreviewDisplaySliceFromSettings;
    var onBuildPreviewMainLine = options.onBuildPreviewMainLine;
    var onSyncRandomButton = options.onSyncRandomButton;
    var onResetZoom = options.onResetZoom;
    var onPreviewImageDecoded = options.onPreviewImageDecoded;
    var onSchedulePreviewImageLayoutBounds = options.onSchedulePreviewImageLayoutBounds;
    var onSyncFullscreenButton = options.onSyncFullscreenButton;
    var onSyncPreviewFavoriteButton = options.onSyncPreviewFavoriteButton;
    var onPreloadAdjacentPages = options.onPreloadAdjacentPages;
    if (typeof onSyncPreviewDisplayOptionsFromSettings !== 'function') return;
    if (typeof onPreviewDisplaySliceFromSettings !== 'function') return;
    if (typeof onBuildPreviewMainLine !== 'function') return;
    if (typeof onSyncRandomButton !== 'function' || typeof onResetZoom !== 'function') return;
    if (
      typeof onPreviewImageDecoded !== 'function' ||
      typeof onSchedulePreviewImageLayoutBounds !== 'function'
    )
      return;
    if (
      typeof onSyncFullscreenButton !== 'function' ||
      typeof onSyncPreviewFavoriteButton !== 'function'
    )
      return;
    if (typeof onPreloadAdjacentPages !== 'function') return;

    var photo = state.previewPhotos[index];
    if (!photo) return;

    /** 在更新 previewIndex 之前判断：已在预览中则为左右切换，切到视频时默认不自动播放 */
    var switchingPreview = !!(dom.previewOverlay && dom.previewOverlay.classList.contains('active'));

    var isVideo = isVideoFileType(photo.file_type);
    var electronTier =
      global.PhotoPlaybackStrategy &&
      typeof global.PhotoPlaybackStrategy.resolveElectronVideoPlayback === 'function'
        ? global.PhotoPlaybackStrategy.resolveElectronVideoPlayback(photo.file_type)
        : {
            tier: isVideo
              ? isInlinePlayableVideoType(photo.file_type)
                ? 'direct_stream'
                : 'hls_transcode'
              : 'none',
          };

    if (state.previewDisplayApplied) {
      onSyncPreviewDisplayOptionsFromSettings(state.previewDisplayApplied);
    } else {
      onSyncPreviewDisplayOptionsFromSettings({});
      if (api && api.has && api.has('getSettings')) {
        var openedPhotoId = photo.id;
        api
          .getSettings()
          .then(function (s) {
            if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return;
            var cur = state.previewPhotos[state.previewIndex];
            if (!cur || cur.id !== openedPhotoId) return;
            state.previewDisplayApplied = onPreviewDisplaySliceFromSettings(s);
            onSyncPreviewDisplayOptionsFromSettings(s);
            var p = state.previewPhotos[state.previewIndex];
            if (p && dom.previewInfoMain)
              dom.previewInfoMain.textContent = onBuildPreviewMainLine(p, state.previewIndex);
            else if (p && dom.previewInfo)
              dom.previewInfo.textContent = onBuildPreviewMainLine(p, state.previewIndex);
          })
          .catch(function () {});
      }
    }

    state.previewIndex = index;
    if (dom.slideshowIntervalSelect) {
      var sec = parseInt(dom.slideshowIntervalSelect.value, 10);
      state.slideshowIntervalSec = isNaN(sec) ? 3 : sec;
    }
    onSyncRandomButton();
    // 视频不走缩放/旋转交互（只需播放），图片继续用原逻辑
    if (!isVideo) onResetZoom();

    var overlay = dom.previewOverlay;
    var img = dom.previewImage;
    var video = dom.previewVideo;
    var videoCenterPlayBtn = dom.previewVideoCenterPlay;
    if (videoCenterPlayBtn && videoCenterPlayBtn._syncVideoCenterPlay) {
      videoCenterPlayBtn._syncVideoCenterPlay();
    }
    /** 已在预览中切到下一张图：须与 img.src 同步更新信息条，否则会先显示新标题、仍显示上一张图 */
    var deferPreviewChrome = overlay.classList.contains('active') && !isVideo && !!img;
    var activeSwitchDelayMs = overlay.classList.contains('active') && isVideo ? 150 : 0;

    if (overlay.classList.contains('active')) {
      if (!isVideo && img) img.classList.add('switching');
      setTimeout(function () {
        if (isVideo) {
          state.previewSubtitleEnabled = true;
          state.previewSubtitleMode = 'external_auto';
          if (img) {
            img.onload = null;
            img.src = '';
            if (img.classList) img.classList.remove('switching');
            img.style.display = 'none';
          }
          if (video) {
            video.style.display = '';
            video._subtitleUiReady = false;
            state.previewHasExternalSubtitle = null;
            attachElectronVideo(photo, video, api, electronTier, state, dom, {
              pauseAfterLoad: switchingPreview,
            });
            wireVideoCenterPlay(dom, video);
            wireSubtitleToolbar(dom, state, api, video);
            loadExternalSubtitle({
              photo: photo,
              video: video,
              api: api,
              dom: dom,
              state: state,
              onDone: function (ok) {
                syncSubtitleToolbar({ dom: dom, state: state, isVideo: true, hasExternal: ok, video: video });
              },
            });
            if (video._syncVideoCenterPlay) video._syncVideoCenterPlay();
          }
        } else {
          if (video) {
            try {
              video.pause();
            } catch (e3) {}
            video.removeAttribute('src');
            try {
              video.load();
            } catch (e4) {}
            video.style.display = 'none';
            if (videoCenterPlayBtn) videoCenterPlayBtn.style.display = 'none';
            clearManagedSubtitleTrack(video);
            syncSubtitleToolbar({ dom: dom, state: state, isVideo: false, hasExternal: false });
          }
          if (img) {
            img.style.display = '';
            img.src = 'photo://' + photo.id;
            img.onload = function () {
              onPreviewImageDecoded();
              if (deferPreviewChrome) {
                if (typeof options.onPreviewMainLinePrepare === 'function') {
                  options.onPreviewMainLinePrepare(photo, index);
                }
                var ml = onBuildPreviewMainLine(photo, index);
                if (dom.previewInfoMain) dom.previewInfoMain.textContent = ml;
                else if (dom.previewInfo) dom.previewInfo.textContent = ml;
                onSyncFullscreenButton();
                onSyncPreviewFavoriteButton();
                onPreloadAdjacentPages(index);
              }
            };
            img.onerror = function () {
              if (img.classList) img.classList.remove('switching');
              if (deferPreviewChrome) {
                if (typeof options.onPreviewMainLinePrepare === 'function') {
                  options.onPreviewMainLinePrepare(photo, index);
                }
                var ml2 = onBuildPreviewMainLine(photo, index);
                if (dom.previewInfoMain) dom.previewInfoMain.textContent = ml2;
                else if (dom.previewInfo) dom.previewInfo.textContent = ml2;
                onSyncFullscreenButton();
                onSyncPreviewFavoriteButton();
                onPreloadAdjacentPages(index);
              }
            };
          }
        }
      }, activeSwitchDelayMs);
    } else {
      overlay.classList.remove('closing');
      overlay.classList.add('active');
      if (isVideo) {
        state.previewSubtitleEnabled = true;
        state.previewSubtitleMode = 'external_auto';
        if (img) {
          img.onload = null;
          img.src = '';
          if (img.classList) img.classList.remove('switching');
          img.style.display = 'none';
        }
        if (video) {
          video.style.display = '';
          video._subtitleUiReady = false;
          state.previewHasExternalSubtitle = null;
          attachElectronVideo(photo, video, api, electronTier, state, dom, { pauseAfterLoad: false });
          wireVideoCenterPlay(dom, video);
          wireSubtitleToolbar(dom, state, api, video);
          loadExternalSubtitle({
            photo: photo,
            video: video,
            api: api,
            dom: dom,
            state: state,
            onDone: function (ok) {
              syncSubtitleToolbar({ dom: dom, state: state, isVideo: true, hasExternal: ok, video: video });
            },
          });
          if (video._syncVideoCenterPlay) video._syncVideoCenterPlay();
        }
      } else {
        if (video) {
          try {
            video.pause();
          } catch (e7) {}
          video.removeAttribute('src');
          try {
            video.load();
          } catch (e8) {}
          video.style.display = 'none';
          if (videoCenterPlayBtn) videoCenterPlayBtn.style.display = 'none';
          clearManagedSubtitleTrack(video);
          syncSubtitleToolbar({ dom: dom, state: state, isVideo: false, hasExternal: false });
        }
        if (img) {
          img.style.display = '';
          img.onload = onPreviewImageDecoded;
          img.src = 'photo://' + photo.id;
        }
      }
    }
    onSchedulePreviewImageLayoutBounds();

    if (!deferPreviewChrome) {
      if (typeof options.onPreviewMainLinePrepare === 'function') {
        options.onPreviewMainLinePrepare(photo, index);
      }
      var mainLine = onBuildPreviewMainLine(photo, index);
      if (dom.previewInfoMain) dom.previewInfoMain.textContent = mainLine;
      else if (dom.previewInfo) dom.previewInfo.textContent = mainLine;
      onSyncFullscreenButton();
      onSyncPreviewFavoriteButton();
      onPreloadAdjacentPages(index);
    }
  }

  async function previewMoveToTrash(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var appConfirm = options.appConfirm;
    var appAlert = options.appAlert;
    var onLoadStats = options.onLoadStats;
    var onLoadPhotos = options.onLoadPhotos;
    var onClosePreview = options.onClosePreview;
    var onOpenPreview = options.onOpenPreview;
    if (!(api && api.has && api.has('photoMoveToTrash'))) return;
    if (typeof appConfirm !== 'function' || typeof appAlert !== 'function') return;
    if (typeof onLoadStats !== 'function' || typeof onLoadPhotos !== 'function') return;
    if (typeof onClosePreview !== 'function' || typeof onOpenPreview !== 'function') return;

    var photo = state.previewPhotos[state.previewIndex];
    if (!photo) return;
    var ok = await appConfirm(
      '将「' + photo.file_name + '」移到回收站并从相册索引中移除？\n可在系统回收站中还原文件。',
    );
    if (!ok) return;
    var idx = state.previewIndex;
    var r = await api.photoMoveToTrash(photo.id);
    if (!r || !r.success) {
      appAlert('操作失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    state.previewPhotos.splice(idx, 1);
    await onLoadStats();
    var prevPage = state.page;
    await onLoadPhotos();
    if (state.currentPhotos.length === 0 && prevPage > 1) {
      state.page = prevPage - 1;
      await onLoadPhotos();
    }
    if (state.previewPhotos.length === 0) {
      onClosePreview();
      return;
    }
    var newIndex = Math.min(idx, state.previewPhotos.length - 1);
    onOpenPreview(newIndex);
  }

  async function applyPhotoFavoriteToggle(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api || null;
    var photoId = options.photoId;
    var appAlert = options.appAlert;
    var onPatchPhotoFavoriteInState = options.onPatchPhotoFavoriteInState;
    var onLoadStats = options.onLoadStats;
    var onUpdateFavoriteCountInSidebar = options.onUpdateFavoriteCountInSidebar;
    var onSyncPreviewFavoriteButton = options.onSyncPreviewFavoriteButton;
    var onUpdateFavoriteStarOnCard = options.onUpdateFavoriteStarOnCard;
    var onLoadPhotos = options.onLoadPhotos;
    var onClosePreview = options.onClosePreview;
    if (!(api && api.has && api.has('photoToggleFavorite'))) return;
    if (typeof appAlert !== 'function') return;
    if (typeof onPatchPhotoFavoriteInState !== 'function') return;
    if (typeof onLoadStats !== 'function' || typeof onUpdateFavoriteCountInSidebar !== 'function')
      return;
    if (
      typeof onSyncPreviewFavoriteButton !== 'function' ||
      typeof onUpdateFavoriteStarOnCard !== 'function'
    )
      return;
    if (typeof onLoadPhotos !== 'function' || typeof onClosePreview !== 'function') return;

    var r = await api.photoToggleFavorite(photoId);
    if (!r || !r.success) {
      appAlert('操作失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    var v = !!r.is_favorite;
    onPatchPhotoFavoriteInState(photoId, v);
    await onLoadStats();
    onUpdateFavoriteCountInSidebar();
    onSyncPreviewFavoriteButton();
    onUpdateFavoriteStarOnCard(photoId, v);
    if (state.currentView === 'favorites') {
      var previewWasOpen = !!(
        dom.previewOverlay &&
        dom.previewOverlay.classList &&
        dom.previewOverlay.classList.contains('active')
      );
      await onLoadPhotos();
      if (previewWasOpen) onClosePreview();
    }
  }

  async function previewToggleFavorite(options) {
    options = options || {};
    var state = options.state || {};
    var onApplyPhotoFavoriteToggle = options.onApplyPhotoFavoriteToggle;
    if (typeof onApplyPhotoFavoriteToggle !== 'function') return;
    var photo = state.previewPhotos[state.previewIndex];
    if (!photo) return;
    await onApplyPhotoFavoriteToggle(photo.id);
  }

  async function previewShowInFolder(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var appAlert = options.appAlert;
    var photo = state.previewPhotos[state.previewIndex];
    if (!photo || !(api && api.has && api.has('showPhotoInFolder'))) return;
    var r = await api.showPhotoInFolder(photo.id);
    if (!r || !r.success) {
      if (typeof appAlert === 'function') appAlert('无法打开：' + ((r && r.error) || '未知错误'));
    }
  }

  async function previewOpenExternal(options) {
    options = options || {};
    var state = options.state || {};
    var api = options.api || null;
    var appAlert = options.appAlert;
    var photo = state.previewPhotos[state.previewIndex];
    if (!photo || !(api && api.has && api.has('openPhotoExternal'))) return;
    var r = await api.openPhotoExternal(photo.id);
    if (!r || !r.success) {
      if (typeof appAlert === 'function')
        appAlert('无法用系统程序打开：' + ((r && r.error) || '未知错误'));
    }
  }

  async function loadPreviewAdjacentPage(options) {
    options = options || {};
    var state = options.state || {};
    var pageDir = options.pageDir;
    var dir = options.dir || 0;
    var fetchPhotosPage = options.fetchPhotosPage;
    var onOpenPreview = options.onOpenPreview;
    if (typeof fetchPhotosPage !== 'function' || typeof onOpenPreview !== 'function') return;
    if (state.previewLoadingPage) return;

    var nextPage;
    if (pageDir > 0) {
      nextPage = state.previewPageStart + Math.ceil(state.previewPhotos.length / state.pageSize);
    } else {
      nextPage = state.previewPageStart - 1;
    }

    if (nextPage < 1 || nextPage > state.previewTotalPages) return;

    state.previewLoadingPage = nextPage;
    var result = await fetchPhotosPage(nextPage);
    var newPhotos = (result && result.photos) || [];
    state.previewLoadingPage = 0;
    if (newPhotos.length === 0) return;

    if (pageDir > 0) {
      state.previewPhotos = state.previewPhotos.concat(newPhotos);
    } else {
      state.previewPhotos = newPhotos.concat(state.previewPhotos);
      state.previewIndex += newPhotos.length;
      state.previewPageStart = nextPage;
    }

    onOpenPreview(state.previewIndex + dir);
  }

  function navigatePreview(options) {
    options = options || {};
    var state = options.state || {};
    var dir = options.dir || 0;
    var onOpenPreview = options.onOpenPreview;
    var onLoadPreviewAdjacentPage = options.onLoadPreviewAdjacentPage;
    if (typeof onOpenPreview !== 'function' || typeof onLoadPreviewAdjacentPage !== 'function')
      return;

    var len = state.previewPhotos ? state.previewPhotos.length : 0;
    var newIndex = state.previewIndex + dir;
    if (newIndex >= 0 && newIndex < len) {
      onOpenPreview(newIndex);
    } else if (newIndex < 0 && state.previewPageStart > 1) {
      onLoadPreviewAdjacentPage(-1, dir);
    } else if (newIndex >= len) {
      var tailPage =
        state.previewPageStart + Math.ceil(len / state.pageSize) - 1;
      if (tailPage < state.previewTotalPages) {
        onLoadPreviewAdjacentPage(1, dir);
      }
    }
  }

  function preloadAdjacentPages(options) {
    options = options || {};
    var state = options.state || {};
    var index = options.index || 0;
    var onLoadPreviewAdjacentPage = options.onLoadPreviewAdjacentPage;
    if (typeof onLoadPreviewAdjacentPage !== 'function') return;
    // 随机幻灯在全库跳转，不需要按页追加；避免 concat + 超大 previewPhotos 导致卡死
    if (state.slideshowRandom) return;

    var margin = 5;
    if (index >= state.previewPhotos.length - margin) {
      var tailPage =
        state.previewPageStart + Math.ceil(state.previewPhotos.length / state.pageSize) - 1;
      if (tailPage < state.previewTotalPages) {
        onLoadPreviewAdjacentPage(1, 0);
      }
    }
  }

  global.RendererPreviewFlow = Object.assign({}, global.RendererPreviewFlow || {}, {
    openPreview: openPreview,
    initPreviewState: initPreviewState,
    navigatePreview: navigatePreview,
    loadPreviewAdjacentPage: loadPreviewAdjacentPage,
    preloadAdjacentPages: preloadAdjacentPages,
    previewMoveToTrash: previewMoveToTrash,
    applyPhotoFavoriteToggle: applyPhotoFavoriteToggle,
    previewToggleFavorite: previewToggleFavorite,
    previewShowInFolder: previewShowInFolder,
    previewOpenExternal: previewOpenExternal,
  });
})(window);
