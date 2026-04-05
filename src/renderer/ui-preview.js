(function (global) {
  'use strict';

  // ===== preview-interaction.js =====
  function resetZoom(options) {
    options = options || {};
    var state = options.state || {};
    var onUpdatePreviewTransform = options.onUpdatePreviewTransform;
    var onUpdatePreviewImageLayoutBounds = options.onUpdatePreviewImageLayoutBounds;
    if (
      typeof onUpdatePreviewTransform !== 'function' ||
      typeof onUpdatePreviewImageLayoutBounds !== 'function'
    )
      return;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.previewRotateDeg = 0;
    onUpdatePreviewTransform();
    onUpdatePreviewImageLayoutBounds();
  }

  function zoomToActual(options) {
    options = options || {};
    var state = options.state || {};
    var onUpdatePreviewTransform = options.onUpdatePreviewTransform;
    if (typeof onUpdatePreviewTransform !== 'function') return;
    if (state.zoom !== 1) {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      onUpdatePreviewTransform();
      return;
    }
    state.zoom = 2.5;
    state.panX = 0;
    state.panY = 0;
    onUpdatePreviewTransform();
  }

  function applyZoom(options) {
    options = options || {};
    var state = options.state || {};
    var delta = options.delta || 0;
    var onUpdatePreviewTransform = options.onUpdatePreviewTransform;
    if (typeof onUpdatePreviewTransform !== 'function') return;
    var oldZoom = state.zoom;
    state.zoom = Math.min(10, Math.max(0.2, state.zoom + delta));
    if (state.zoom === oldZoom) return;
    onUpdatePreviewTransform();
  }

  function updatePreviewImageLayoutBounds(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var img = dom.previewImage;
    var bodyEl = dom.previewBody || document.querySelector('.preview-body');
    if (!img || !bodyEl) return;
    if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) {
      img.style.maxWidth = '';
      img.style.maxHeight = '';
      return;
    }
    var rot = (state.previewRotateDeg || 0) % 360;
    var swap = rot === 90 || rot === 270;
    if (!swap) {
      img.style.maxWidth = '';
      img.style.maxHeight = '';
      return;
    }
    var stageEl = bodyEl.querySelector('.preview-body-stage');
    var r = (stageEl || bodyEl).getBoundingClientRect();
    var bw = Math.max(0, Math.floor(r.width));
    var bh = Math.max(0, Math.floor(r.height));
    img.style.maxWidth = bh + 'px';
    img.style.maxHeight = bw + 'px';
  }

  function updatePreviewTransform(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    if (!dom.previewImage || !dom.previewZoom) return;
    var rot = state.previewRotateDeg || 0;
    dom.previewImage.style.transform =
      'translate(' +
      state.panX +
      'px, ' +
      state.panY +
      'px) scale(' +
      state.zoom +
      ') rotate(' +
      rot +
      'deg)';
    var pct = Math.round(state.zoom * 100);
    dom.previewZoom.textContent = pct + '%';
  }

  function cyclePreviewRotate(options) {
    options = options || {};
    var state = options.state || {};
    var onUpdatePreviewTransform = options.onUpdatePreviewTransform;
    var onUpdatePreviewImageLayoutBounds = options.onUpdatePreviewImageLayoutBounds;
    if (
      typeof onUpdatePreviewTransform !== 'function' ||
      typeof onUpdatePreviewImageLayoutBounds !== 'function'
    )
      return;
    state.previewRotateDeg = ((state.previewRotateDeg || 0) + 90) % 360;
    onUpdatePreviewTransform();
    onUpdatePreviewImageLayoutBounds();
  }

  global.RendererPreviewInteraction = Object.assign({}, global.RendererPreviewInteraction || {}, {
    resetZoom: resetZoom,
    zoomToActual: zoomToActual,
    applyZoom: applyZoom,
    updatePreviewImageLayoutBounds: updatePreviewImageLayoutBounds,
    updatePreviewTransform: updatePreviewTransform,
    cyclePreviewRotate: cyclePreviewRotate,
  });

  // ===== preview-slideshow.js =====
  function normalizePreviewFileExt(fileType) {
    var t = fileType != null ? String(fileType).toLowerCase() : '';
    return t.replace(/^\./, '');
  }

  /** 与库内 media 筛选一致：幻灯片播放/随机仅包含图片，不含视频 */
  function isPreviewVideoPhoto(photo) {
    if (!photo) return false;
    var t = normalizePreviewFileExt(photo.file_type);
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

  function pickNextRandomIndex(state) {
    if (!state || !Array.isArray(state.previewPhotos) || state.previewPhotos.length <= 1) return -1;
    var total = state.previewPhotos.length;
    if (!Array.isArray(state.slideshowRandomPool)) state.slideshowRandomPool = [];
    if (state.slideshowRandomPool.length === 0) {
      for (var i = 0; i < total; i++) {
        if (i === state.previewIndex) continue;
        if (isPreviewVideoPhoto(state.previewPhotos[i])) continue;
        state.slideshowRandomPool.push(i);
      }
      for (var j = state.slideshowRandomPool.length - 1; j > 0; j--) {
        var r = Math.floor(Math.random() * (j + 1));
        var tmp = state.slideshowRandomPool[j];
        state.slideshowRandomPool[j] = state.slideshowRandomPool[r];
        state.slideshowRandomPool[r] = tmp;
      }
    }
    var idx = state.slideshowRandomPool.shift();
    if (typeof idx !== 'number' || idx < 0 || idx >= total) return -1;
    return idx;
  }

  function pickFallbackRandomNonVideoIndex(state) {
    if (!state || !Array.isArray(state.previewPhotos)) return -1;
    var total = state.previewPhotos.length;
    var candidates = [];
    for (var c = 0; c < total; c++) {
      if (c === state.previewIndex) continue;
      if (isPreviewVideoPhoto(state.previewPhotos[c])) continue;
      candidates.push(c);
    }
    if (candidates.length === 0) return -1;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** 随机幻灯依赖主进程查询；加超时避免 IPC 长时间挂起导致换片堆积、界面卡死 */
  var PREVIEW_ADJACENT_TIMEOUT_MS = 15000;

  async function goNextSlide(options) {
    options = options || {};
    var state = options.state || {};
    var onOpenPreview = options.onOpenPreview;
    var onOpenPreviewByPhoto = options.onOpenPreviewByPhoto;
    var buildReq = options.buildPreviewAdjacentRequestOptions;
    var api = options.api;
    if (typeof onOpenPreview !== 'function') return;
    if (!state.previewPhotos || state.previewPhotos.length === 0) return;
    if (state.slideshowStepLoading) return;
    state.slideshowStepLoading = true;
    var total = state.previewPhotos.length;
    var nextIndex;
    try {
    if (state.slideshowRandom && total > 1) {
      var onBatch = options.onSlideshowRandomAdvance;
      if (typeof onBatch === 'function') {
        try {
          var batchHandled = await onBatch();
          if (batchHandled) return;
        } catch (eBatch) {}
      }
      var cur = state.previewPhotos[state.previewIndex];
      var curId = cur && cur.id != null ? Number(cur.id) : 0;
      var pf = state.slideshowPrefetchPhoto;
      if (
        curId > 0 &&
        pf &&
        pf.fromCurrentId === curId &&
        pf.photo &&
        Number(pf.photo.id) !== curId &&
        typeof onOpenPreviewByPhoto === 'function'
      ) {
        state.slideshowPrefetchPhoto = null;
        onOpenPreviewByPhoto(pf.photo);
        return;
      }
      if (pf && pf.fromCurrentId !== curId) {
        state.slideshowPrefetchPhoto = null;
        state.slideshowPrefetchSeq = (state.slideshowPrefetchSeq || 0) + 1;
      }
      if (
        curId > 0 &&
        typeof buildReq === 'function' &&
        typeof onOpenPreviewByPhoto === 'function' &&
        api &&
        api.has &&
        api.has('getPreviewAdjacentPhoto')
      ) {
        var req = buildReq(curId);
        if (req) {
          try {
            var photo = await Promise.race([
              api.getPreviewAdjacentPhoto(req),
              new Promise(function (_, rej) {
                setTimeout(function () {
                  rej(new Error('timeout'));
                }, PREVIEW_ADJACENT_TIMEOUT_MS);
              }),
            ]);
            if (photo && photo.id != null && Number(photo.id) !== curId) {
              onOpenPreviewByPhoto(photo);
              return;
            }
          } catch (e0) {}
        }
      }
      nextIndex = pickNextRandomIndex(state);
      if (nextIndex < 0) {
        nextIndex = pickFallbackRandomNonVideoIndex(state);
      }
    } else {
      nextIndex = -1;
      for (var step = 0; step < total; step++) {
        var cand = (state.previewIndex + 1 + step) % total;
        if (!isPreviewVideoPhoto(state.previewPhotos[cand])) {
          nextIndex = cand;
          break;
        }
      }
    }
    if (nextIndex < 0) return;
    onOpenPreview(nextIndex);
    } finally {
      state.slideshowStepLoading = false;
    }
  }

  function restartSlideshowTimer(options) {
    options = options || {};
    var state = options.state || {};
    var onGoNextSlide = options.onGoNextSlide;
    if (typeof onGoNextSlide !== 'function') return;
    if (state.slideshowTimer) {
      clearTimeout(state.slideshowTimer);
      state.slideshowTimer = null;
    }
    if (!state.slideshowPlaying) return;
    var ms = Math.max(1, state.slideshowIntervalSec) * 1000;
    function scheduleNext() {
      if (!state.slideshowPlaying) return;
      state.slideshowTimer = setTimeout(function () {
        state.slideshowTimer = null;
        if (!state.slideshowPlaying) return;
        var ret = onGoNextSlide();
        function after() {
          if (!state.slideshowPlaying) return;
          scheduleNext();
        }
        if (ret != null && typeof ret.then === 'function') {
          ret.then(after, after);
        } else {
          after();
        }
      }, ms);
    }
    scheduleNext();
  }

  function startSlideshow(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var onRestartSlideshowTimer = options.onRestartSlideshowTimer;
    if (typeof onRestartSlideshowTimer !== 'function') return;
    if (state.slideshowPlaying) return;
    state.slideshowPlaying = true;
    if (dom.slideshowToggleBtn) {
      dom.slideshowToggleBtn.textContent =
        window.I18n && typeof window.I18n.t === 'function'
          ? window.I18n.t('preview.slideshow.pause')
          : '⏸ 暂停';
    }
    onRestartSlideshowTimer();
  }

  function stopSlideshow(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    state.slideshowPlaying = false;
    if (state.slideshowTimer) {
      clearTimeout(state.slideshowTimer);
      state.slideshowTimer = null;
    }
    if (dom.slideshowToggleBtn) {
      dom.slideshowToggleBtn.textContent =
        window.I18n && typeof window.I18n.t === 'function'
          ? window.I18n.t('preview.slideshow.play')
          : '▶ 播放';
    }
  }

  function toggleSlideshow(options) {
    options = options || {};
    var dom = options.dom || {};
    var state = options.state || {};
    var onStartSlideshow = options.onStartSlideshow;
    var onStopSlideshow = options.onStopSlideshow;
    if (typeof onStartSlideshow !== 'function' || typeof onStopSlideshow !== 'function') return;
    if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return;
    if (state.slideshowPlaying) onStopSlideshow();
    else onStartSlideshow();
  }

  function syncRandomButton(options) {
    options = options || {};
    var dom = options.dom || {};
    var state = options.state || {};
    if (!dom.slideshowRandomBtn) return;
    dom.slideshowRandomBtn.classList.toggle('active', !!state.slideshowRandom);
    dom.slideshowRandomBtn.textContent = state.slideshowRandom ? '随机:开' : '随机:关';
  }

  function toggleSlideshowRandom(options) {
    options = options || {};
    var state = options.state || {};
    var onSyncRandomButton = options.onSyncRandomButton;
    if (typeof onSyncRandomButton !== 'function') return;
    state.slideshowRandom = !state.slideshowRandom;
    state.slideshowRandomPool = [];
    if (state.slideshowRandom) {
      state.slideshowRandomSeed = Date.now() % 2147483647;
    }
    onSyncRandomButton();
    if (typeof options.onAfterToggleRandom === 'function') {
      options.onAfterToggleRandom();
    }
  }

  global.RendererPreviewSlideshow = Object.assign({}, global.RendererPreviewSlideshow || {}, {
    goNextSlide: goNextSlide,
    restartSlideshowTimer: restartSlideshowTimer,
    startSlideshow: startSlideshow,
    stopSlideshow: stopSlideshow,
    toggleSlideshow: toggleSlideshow,
    syncRandomButton: syncRandomButton,
    toggleSlideshowRandom: toggleSlideshowRandom,
  });

  // ===== preview-favorite-ui.js =====
  function syncPreviewFavoriteButton(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    if (!dom.previewFavoriteBtn) return;
    var photo = state.previewPhotos[state.previewIndex];
    if (!photo) return;
    var on = !!photo.is_favorite;
    dom.previewFavoriteBtn.textContent = on ? '★ 已收藏' : '☆ 收藏';
    dom.previewFavoriteBtn.classList.toggle('active', on);
  }

  function patchPhotoFavoriteInState(options) {
    options = options || {};
    var state = options.state || {};
    var photoId = options.photoId;
    var isFav = options.isFav;
    var v = isFav ? 1 : 0;
    for (var i = 0; i < state.currentPhotos.length; i++) {
      if (state.currentPhotos[i].id === photoId) state.currentPhotos[i].is_favorite = v;
    }
    for (var j = 0; j < state.previewPhotos.length; j++) {
      if (state.previewPhotos[j].id === photoId) state.previewPhotos[j].is_favorite = v;
    }
  }

  function updateFavoriteStarOnCard(options) {
    options = options || {};
    var photoId = options.photoId;
    var isFav = options.isFav;
    var card = document.querySelector('.photo-card[data-photo-id="' + photoId + '"]');
    if (!card) return;
    var btn = card.querySelector('.photo-card-fav');
    if (btn) btn.textContent = isFav ? '★' : '☆';
  }

  global.RendererPreviewFavoriteUI = Object.assign({}, global.RendererPreviewFavoriteUI || {}, {
    syncPreviewFavoriteButton: syncPreviewFavoriteButton,
    patchPhotoFavoriteInState: patchPhotoFavoriteInState,
    updateFavoriteStarOnCard: updateFavoriteStarOnCard,
  });
})(window);
