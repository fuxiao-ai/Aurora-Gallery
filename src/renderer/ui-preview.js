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
    // 🔴 这里**不再**把 `state.previewRotateDeg` 归零：它现在是「预览态待保存编辑」的一部分
    //    （由 `app.js#resetPreviewPendingEdit` 负责清）。写在这里会有两个后果：
    //    ① 用户点「重置缩放」会把待保存的旋转从布局上抹掉、但 CSS 变换还在 ⇒ 图与留白对不上；
    //    ② 打开新图 / 关预览时看起来「清干净了」，实际还没清 —— 真正的清理由那两个出口显式做。
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

  /**
   * 旋转 90/270 时，元素盒要给「转过来的图」留出空间 —— 把 max-width/max-height 对调。
   *
   * 🔴 `rot` 只用来判「是不是 90 的奇数倍」，所以取 `previewRotateDeg`（旋转动作的**角度和**）
   *    就够了：镜像会把角度取反，但 `-a ≡ a (mod 180)`，镜像动作**不改变**这一位。
   *    真实的变换在 `updatePreviewTransform` 的 CSS 尾巴里，这里不做任何代数。
   */
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

  /**
   * 把平移 / 缩放 / **预览态编辑**叠成一条 transform。
   *
   * 🔴 编辑那一段是 `state.previewEditCssTail` —— 一串**原样的 CSS 变换函数**，
   *    按「用户点击的逆序」拼好（见 `app.js#previewEditCssTail`）。刻意不在这里做
   *    「角度 + 镜像位」的代数合成：CSS 的求值顺序（最右先作用 = 先镜像后旋转）与 sharp
   *    的算子顺序**同构**，所以把动作原样拼进去就与后端逐像素一致，
   *    而自己再写一份代数 = 多一份会与 `image-edit.js` 悄悄漂移的实现。
   */
  function updatePreviewTransform(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    if (!dom.previewImage || !dom.previewZoom) return;
    var tail = state.previewEditCssTail || '';
    dom.previewImage.style.transform =
      'translate(' +
      state.panX +
      'px, ' +
      state.panY +
      'px) scale(' +
      state.zoom +
      ')' +
      (tail ? ' ' + tail : '');
    var pct = Math.round(state.zoom * 100);
    dom.previewZoom.textContent = pct + '%';
  }

  global.RendererPreviewInteraction = Object.assign({}, global.RendererPreviewInteraction || {}, {
    resetZoom: resetZoom,
    zoomToActual: zoomToActual,
    applyZoom: applyZoom,
    updatePreviewImageLayoutBounds: updatePreviewImageLayoutBounds,
    updatePreviewTransform: updatePreviewTransform,
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

  /**
   * 幻灯片开关按钮的文案落点。
   *
   * 🔴 **必须写进 `.btn-label`，不能直接写按钮的 `textContent`** —— 直接写会把按钮里的
   * `<span class="btn-label">` 整个替换成一个文本节点（和 `i18n.js#applyDom()` 同一个
   * 失效机制，见 `index.html` 里 previewOverlay 上方那条规矩注释）。
   * 这个按钮**刻意没有 `<svg class="btn-icon">`**：它的图标就是状态本身（▶ / ⏸），
   * 而雪碧图里没有 `#icon-pause` ⇒ 用图标表达不了「正在播放」那一态，只能由文案承载。
   * 找不到 span 时退回按钮本身（老结构 / 守护里的替身），保证行为不退化。
   */
  function setSlideshowToggleLabel(btn, text) {
    if (!btn) return;
    var label = btn.querySelector ? btn.querySelector('.btn-label') : null;
    (label || btn).textContent = text;
  }

  function startSlideshow(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var onRestartSlideshowTimer = options.onRestartSlideshowTimer;
    if (typeof onRestartSlideshowTimer !== 'function') return;
    if (state.slideshowPlaying) return;
    state.slideshowPlaying = true;
    setSlideshowToggleLabel(
      dom.slideshowToggleBtn,
      window.I18n && typeof window.I18n.t === 'function'
        ? window.I18n.t('preview.slideshow.pause')
        : '⏸ 暂停',
    );
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
      setSlideshowToggleLabel(
        dom.slideshowToggleBtn,
        window.I18n && typeof window.I18n.t === 'function'
          ? window.I18n.t('preview.slideshow.play')
          : '▶ 播放',
      );
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
    var favLabel = dom.previewFavoriteBtn.querySelector('.btn-label');
    if (favLabel) favLabel.textContent = on ? '已收藏' : '收藏';
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

  // ===== preview-live-photo.js =====
  /**
   * Live Photo 的**预览内播放**。
   *
   * 一条 Live Photo 在库里只占**一个**条目：图片行自己，伴生 MOV 的存在被记录在
   * `photo.live_motion_id` 上，并且它的那一行会被媒体类型筛选排掉
   * （`live_still_id > 0` ⇒ 不出现在任何档位）。所以「看这段动态」这件事
   * **只能发生在预览里** —— 这就是本段存在的全部理由。没有它，我们等于把用户的
   * 伴生视频藏起来了却没有任何入口。
   *
   * 🔴 判据只认 `photo.live_motion_id`（配对任务写进库的事实）。
   *    不许在这里用「同目录有没有同名 .mov」现场推断：真库实测那条判据在 `.mov` 上
   *    头 500 个就命中 61 个，而其中带 Apple identifier 的是 0 ——
   *    按文件名判「伴生」会把写真集的「封面图 + 正片」整批当成 Live Photo。
   *    （伴生视频必然是 QuickTime 容器：主进程 `LIVE_MOTION_EXTENSIONS` 只认 `.mov`。）
   */

  /** 转发到 `utils.js` 的唯一实现 —— 网格角标与这里的播放按钮必须是同一个判据。 */
  function isLivePhotoStill(photo) {
    return global.RendererUtils.isLivePhotoStill(photo);
  }

  function liveVideoEl(dom) {
    return (dom && dom.previewLiveVideo) || null;
  }

  /**
   * 把叠加层彻底收回：**解除 HLS 会话 + 断源 + 隐藏**。
   * 顺序不能换 —— `PhotoHlsAttach.destroy()` 自己会 `removeAttribute('src')`，
   * 先断源再 destroy 会让 hls.js 在已卸载的媒体上收尾。
   */
  function detachLiveVideo(video) {
    if (!video) return;
    if (video._liveTryPlay) {
      video.removeEventListener('canplay', video._liveTryPlay);
      video._liveTryPlay = null;
    }
    if (global.PhotoHlsAttach) global.PhotoHlsAttach.destroy(video);
    try {
      video.pause();
    } catch (e0) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (e1) {}
    video.style.display = 'none';
    video.onended = null;
  }

  /** LIVE 按钮的显隐 + 文案 + 激活态。三样都必须由这里单独算，调用方不许自己拼。 */
  function syncLiveButton(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var btn = dom.previewLiveBtn;
    if (!btn) return;
    var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
    var show = !options.isVideo && isLivePhotoStill(photo);
    var playing = show && !!state.previewLivePlaying;
    btn.style.display = show ? '' : 'none';
    btn.classList.toggle('active', playing);
    var label = btn.querySelector('.btn-label');
    if (label) label.textContent = playing ? '停止' : '实况';
  }

  function stopLivePlayback(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    state.previewLivePlaying = false;
    detachLiveVideo(liveVideoEl(dom));
    syncLiveButton({ state: state, dom: dom });
  }

  /**
   * 每次预览切图都走这里（`openPreview` 里唯一的串扰点）：
   * 先无条件停掉上一段动态，再按新图片决定按钮显不显示。
   *
   * 🔴 **必须无条件停**，不能写成「只有新图片不是 Live Photo 才停」：
   *    「上一张是 Live、下一张也是 Live」时那样写会让上一段动态继续盖在新静止图上播完。
   */
  function syncPreviewLiveUi(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    detachLiveVideo(liveVideoEl(dom));
    state.previewLivePlaying = false;
    syncLiveButton({ state: state, dom: dom, isVideo: !!options.isVideo });
  }

  /**
   * 与 `attachElectronVideo` 同源：先要 HTTP base，再查 `/api/video-playback?id=`
   * 决定直链还是 HLS。**这一步不能省** —— iPhone 的伴生视频自 iPhone 8 起是 HEVC，
   * Chromium 解不了，直接写 `/video/{id}` 会静默黑屏；那条接口就是干这个的。
   *
   * 不复用 `attachElectronVideo` 的唯一原因：它的守卫是
   * `state.previewPhotos[i].id !== openedId`。这里要打开的 id 是**伴生视频的 id**，
   * 而守卫手里比的是**图片的 id** ⇒ 直接复用会被永远拦下。
   */
  function attachLiveMotionVideo(options) {
    var photo = options.photo;
    var video = options.video;
    var motionId = options.motionId;
    var api = options.api;
    var state = options.state;
    var dom = options.dom;
    var stillId = Number(photo.id);
    var v = '?v=' + motionId;

    /** 异步链路回来时，用户可能已经翻页/关了预览 —— 不许再往叠加层里灌内容。 */
    function stillIsCurrent() {
      if (!dom.previewOverlay || !dom.previewOverlay.classList.contains('active')) return false;
      var cur = state.previewPhotos && state.previewPhotos[state.previewIndex];
      if (!cur || Number(cur.id) !== stillId) return false;
      return Number(cur.live_motion_id) === motionId;
    }

    function tryPlay() {
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }

    // HLS 档要等清单解析完才有东西可播 —— 直链档 canplay 也来得更晚。
    // 两种都靠这条监听兜住；立刻先试一次是为了直链档少一次等待。
    if (video._liveTryPlay) video.removeEventListener('canplay', video._liveTryPlay);
    video._liveTryPlay = function () {
      video.removeEventListener('canplay', video._liveTryPlay);
      video._liveTryPlay = null;
      if (!stillIsCurrent()) return;
      tryPlay();
    };
    video.addEventListener('canplay', video._liveTryPlay);

    function applySrc(httpBase) {
      var root = String(httpBase).replace(/\/$/, '');
      video.src = root + '/video/' + motionId + v;
      try {
        video.load();
      } catch (e0) {}
      tryPlay();
    }

    if (!(api && api.has && api.has('getWebLocalBaseUrl'))) {
      video.src = 'video://' + motionId + v;
      try {
        video.load();
      } catch (e1) {}
      tryPlay();
      return;
    }

    api.call('getWebLocalBaseUrl').then(function (base) {
      if (!stillIsCurrent()) return;
      if (!base) {
        video.src = 'video://' + motionId + v;
        try {
          video.load();
        } catch (e2) {}
        tryPlay();
        return;
      }
      var root = String(base).replace(/\/$/, '');
      fetch(root + '/api/video-playback?id=' + motionId)
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!stillIsCurrent()) return;
          if (data && data.mode === 'hls' && data.ready && data.playlistUrl && global.PhotoHlsAttach) {
            global.PhotoHlsAttach.attach(video, root + data.playlistUrl);
            tryPlay();
          } else {
            applySrc(base);
          }
        })
        .catch(function () {
          if (!stillIsCurrent()) return;
          applySrc(base);
        });
    });
  }

  function toggleLivePlayback(options) {
    options = options || {};
    var state = options.state || {};
    var dom = options.dom || {};
    var api = options.api || null;
    var photo = state.previewPhotos && state.previewPhotos[state.previewIndex];
    if (!isLivePhotoStill(photo)) return;
    if (state.previewLivePlaying) {
      stopLivePlayback({ state: state, dom: dom });
      return;
    }
    var video = liveVideoEl(dom);
    var motionId = Number(photo.live_motion_id) || 0;
    if (!video || motionId <= 0) return;
    state.previewLivePlaying = true;
    video.style.display = '';
    // 跟随当前缩放/旋转，否则动态会跳回未缩放的原始取景
    video.style.transform = dom.previewImage ? dom.previewImage.style.transform : '';
    video.onended = function () {
      stopLivePlayback({ state: state, dom: dom });
    };
    syncLiveButton({ state: state, dom: dom });
    attachLiveMotionVideo({
      photo: photo,
      video: video,
      motionId: motionId,
      api: api,
      state: state,
      dom: dom,
    });
  }

  global.RendererPreviewLive = Object.assign({}, global.RendererPreviewLive || {}, {
    syncLiveButton: syncLiveButton,
    syncPreviewLiveUi: syncPreviewLiveUi,
    stopLivePlayback: stopLivePlayback,
    toggleLivePlayback: toggleLivePlayback,
  });
})(window);
