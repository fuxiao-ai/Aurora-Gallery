(function (global) {
  'use strict';

  /** 超过此数量时分帧插入 DOM，减轻大图库单页（如 500 张）时的长任务卡顿 */
  var GRID_DOM_CHUNK_THRESHOLD = 72;
  var GRID_DOM_CHUNK_SIZE = 48;

  // ===== photo-grid-ui.js =====
  function generatePageNumbers(current, total) {
    if (total <= 7) {
      var arr = [];
      for (var i = 1; i <= total; i++) arr.push(i);
      return arr;
    }
    var pages = [1];
    if (current > 3) pages.push('...');
    var start = Math.max(2, current - 1);
    var end = Math.min(total - 1, current + 1);
    for (var j = start; j <= end; j++) pages.push(j);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  function renderPhotoGrid(options) {
    options = options || {};
    var dom = options.dom || {};
    var photos = options.photos || [];
    var escapeHtml = options.escapeHtml;
    var escapeAttr = options.escapeAttr;
    var truncate = options.truncate;
    var formatDateTime = options.formatDateTime;
    var formatNumber = options.formatNumber;
    var normalizePath = options.normalizePath;
    var onApplyCardSize = options.onApplyCardSize;
    var mediaFilter = options.mediaFilter;
    var useMediaRatio = options.useMediaRatio !== false;
    var subfolderSummaries = Array.isArray(options.subfolderSummaries) ? options.subfolderSummaries : [];
    if (!dom.photoGrid) return;
    if (
      typeof escapeHtml !== 'function' ||
      typeof truncate !== 'function' ||
      typeof formatDateTime !== 'function'
    )
      return;
    if (typeof onApplyCardSize !== 'function') return;

    var hasSubs =
      subfolderSummaries.length > 0 &&
      typeof normalizePath === 'function' &&
      typeof formatNumber === 'function' &&
      typeof escapeAttr === 'function';
    var n = photos.length;
    var hasPhotos = n > 0;

    if (!hasSubs && !hasPhotos) {
      var emptyTitle = '没有找到照片';
      if (mediaFilter === 'video') emptyTitle = '没有找到视频';
      else if (mediaFilter === 'image') emptyTitle = '没有找到图片';
      dom.photoGrid.innerHTML =
        '<div class="empty-state"><div class="icon">📭</div><div class="title">' +
        emptyTitle +
        '</div></div>';
      onApplyCardSize();
      return;
    }

    dom.photoGrid.dataset.useMediaRatio = useMediaRatio ? '1' : '0';

    function buildSubfolderSectionHtml() {
      var h =
        '<div class="browse-folder-subfolders-wrap">' +
        '<div class="browse-folder-section-label">子目录</div>' +
        '<div class="grid browse-folder-subfolder-grid">';
      for (var si = 0; si < subfolderSummaries.length; si++) {
        var src = subfolderSummaries[si];
        var row = {
          folder_path: src.folder_path,
          folder_photo_count: src.folder_photo_count != null ? src.folder_photo_count : 0,
        };
        if (src.id != null) {
          row.id = src.id;
          row.has_thumbnail = src.has_thumbnail;
          row.file_name = src.file_name != null ? src.file_name : '';
        }
        h += buildFolderCoverCardHtml(row, normalizePath, escapeHtml, escapeAttr, formatNumber);
      }
      h += '</div></div>';
      return h;
    }

    var prefixHtml = hasSubs ? buildSubfolderSectionHtml() : '';
    var photosLabelHtml =
      hasSubs && hasPhotos
        ? '<div class="browse-folder-section-label browse-folder-section-label--photos">此文件夹中的照片与视频</div>'
        : '';

    if (!hasPhotos) {
      dom.photoGrid.innerHTML = prefixHtml;
      bindGridImageProgress(dom.photoGrid);
      onApplyCardSize();
      return;
    }

    if (n <= GRID_DOM_CHUNK_THRESHOLD) {
      var html = prefixHtml + photosLabelHtml + '<div class="grid">';
      for (var i = 0; i < n; i++) {
        html += buildSinglePhotoCardHtml(
          photos[i],
          i,
          useMediaRatio,
          escapeHtml,
          truncate,
          formatDateTime,
        );
      }
      html += '</div>';
      dom.photoGrid.innerHTML = html;
      bindGridImageProgress(dom.photoGrid);
      onApplyCardSize();
      return;
    }

    dom.photoGrid.innerHTML = prefixHtml + photosLabelHtml;
    var grid = document.createElement('div');
    grid.className = 'grid';
    dom.photoGrid.appendChild(grid);

    var start = 0;
    var firstChunk = true;
    function appendNextChunk() {
      var end = Math.min(start + GRID_DOM_CHUNK_SIZE, n);
      var chunkHtml = '';
      for (var j = start; j < end; j++) {
        chunkHtml += buildSinglePhotoCardHtml(
          photos[j],
          j,
          useMediaRatio,
          escapeHtml,
          truncate,
          formatDateTime,
        );
      }
      var temp = document.createElement('div');
      temp.innerHTML = chunkHtml;
      bindGridImageProgress(dom.photoGrid, temp);
      while (temp.firstChild) grid.appendChild(temp.firstChild);
      start = end;
      if (firstChunk) {
        firstChunk = false;
        onApplyCardSize();
      }
      if (start < n) {
        requestAnimationFrame(appendNextChunk);
      } else {
        onApplyCardSize();
      }
    }
    appendNextChunk();
  }

  function isVideoPhoto(photo) {
    var row = photo || {};
    var mt = String(row.media_type || row.mediaType || '').toLowerCase();
    if (mt === 'video') return true;
    var ft = String(row.file_type || '').toLowerCase().replace(/^\./, '');
    return (
      [
        'mp4',
        'mov',
        'm4v',
        'mkv',
        'avi',
        'wmv',
        'flv',
        'webm',
        'mpg',
        'mpeg',
        'm2ts',
        'ts',
        '3gp',
        '3g2',
      ].indexOf(ft) >= 0
    );
  }

  function getMediaAspectRatioValue(photo) {
    var row = photo || {};
    var w = parseFloat(row.width || row.pixel_width || row.file_width || row.media_width || 0);
    var h = parseFloat(row.height || row.pixel_height || row.file_height || row.media_height || 0);
    if (!(w > 0 && h > 0)) return '';
    var r = w / h;
    if (!isFinite(r) || r <= 0) return '';
    if (r < 0.125 || r > 8) return '';
    return String(w) + ' / ' + String(h);
  }

  function buildSinglePhotoCardHtml(photo, i, useMediaRatio, escapeHtml, truncate, formatDateTime) {
    var isVideo = isVideoPhoto(photo);
    var ratio = useMediaRatio ? getMediaAspectRatioValue(photo) : '';
    var thumbUrl = photo.has_thumbnail ? 'thumb://' + photo.id : '';
    var delay = Math.min(i * 30, 600);
    var favChar = photo.is_favorite ? '\u2605' : '\u2606';
    var cardStyle = 'animation-delay:' + delay + 'ms;';
    if (ratio) cardStyle += 'aspect-ratio:' + ratio + ';';
    var html =
      '<div class="photo-card" data-photo-id="' +
      photo.id +
      '" data-preview-index="' +
      i +
      '" style="' +
      cardStyle +
      '">' +
      '<button type="button" class="photo-card-fav" title="收藏（鼠标悬停卡片时显示）" aria-label="收藏" data-fav-photo-id="' +
      photo.id +
      '">' +
      favChar +
      '</button>';
    if (isVideo) {
      html += '<span class="media-type-badge media-type-badge-video">视频</span>';
    }
    if (thumbUrl) {
      html +=
        '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
        '<img src="' +
        thumbUrl +
        '" alt="' +
        escapeHtml(photo.file_name) +
        '" loading="lazy" class="loading grid-thumb" />';
    } else {
      html +=
        '<div class="placeholder"><div class="ext">' +
        (photo.file_type || '?') +
        '</div><div>' +
        escapeHtml(truncate(photo.file_name, 20)) +
        '</div></div>';
    }
    html +=
      '<div class="photo-info"><div class="photo-name">' +
      escapeHtml(photo.file_name) +
      '</div>' +
      '<div class="photo-date">' +
      formatDateTime(photo.date_taken) +
      '</div></div></div>';
    return html;
  }

  function createGridFallbackPlaceholder(card) {
    if (!card) return null;
    var isFolder = card.classList.contains('folder-cover-card');
    var placeholder = document.createElement('div');
    if (isFolder) {
      placeholder.className = 'folder-cover-placeholder folder-cover-placeholder--error';
      placeholder.innerHTML =
        '<svg class="folder-cover-placeholder-icon folder-cover-placeholder-icon--error" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>' +
        '</svg>' +
        '<span class="folder-cover-placeholder-msg">\u7F29\u7565\u56FE\u52A0\u8F7D\u5931\u8D25</span>';
      return placeholder;
    }
    placeholder.className = 'placeholder placeholder-fallback';
    placeholder.innerHTML = '<div class="ext">\u26A0</div><div>\u7F29\u7565\u56FE\u52A0\u8F7D\u5931\u8D25</div>';
    return placeholder;
  }

  function bindGridImageProgress(root, scope) {
    if (!root) return;
    var searchRoot = scope || root;
    var imgs = searchRoot.querySelectorAll('img.grid-thumb');
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        if (!img || img.dataset.gridBound === '1') return;
        img.dataset.gridBound = '1';

        function getCard() {
          return img.closest('.photo-card, .folder-cover-card');
        }

        function markLoaded() {
          img.classList.remove('loading');
          var card = getCard();
          if (card && root && root.dataset && root.dataset.useMediaRatio === '1') {
            var nw = img.naturalWidth || 0;
            var nh = img.naturalHeight || 0;
            if (nw > 0 && nh > 0) {
              card.style.aspectRatio = String(nw) + ' / ' + String(nh);
            }
          }
          if (card) card.classList.add('thumb-loaded');
        }

        function markFailed() {
          var card = getCard();
          img.classList.remove('loading');
          if (!card) return;
          card.classList.add('thumb-failed');
          try {
            img.remove();
          } catch (e) {}
          if (card.querySelector('.placeholder, .folder-cover-placeholder')) return;
          var ph = createGridFallbackPlaceholder(card);
          if (ph) card.insertBefore(ph, card.firstChild);
        }

        img.addEventListener('load', markLoaded, { once: true });
        img.addEventListener('error', markFailed, { once: true });

        if (img.complete) {
          if ((img.naturalWidth || 0) > 0) markLoaded();
          else markFailed();
        }
      })(imgs[i]);
    }
  }

  function showSkeleton(options) {
    options = options || {};
    var dom = options.dom || {};
    var loadingLabel = options.loadingLabel;
    var escapeHtml = options.escapeHtml;
    var onApplyCardSize = options.onApplyCardSize;
    if (!dom.photoGrid) return;
    if (typeof escapeHtml !== 'function' || typeof onApplyCardSize !== 'function') return;

    var label = loadingLabel || '\u6B63\u5728\u52A0\u8F7D\u7167\u7247\u2026';
    var html =
      '<div class="photos-loading-wrap">' +
      '<div class="photos-loading-header">' +
      '<div class="content-loading-spinner content-loading-spinner--sm" aria-hidden="true"></div>' +
      '<span>' +
      escapeHtml(label) +
      '</span></div>' +
      '<div class="grid">';
    for (var i = 0; i < 16; i++) {
      html += '<div class="skeleton"></div>';
    }
    html += '</div></div>';
    dom.photoGrid.innerHTML = html;
    onApplyCardSize();
  }

  function renderPagination(options) {
    options = options || {};
    var dom = options.dom || {};
    var result = options.result || {};
    var formatNumber = options.formatNumber;
    if (!dom.pagination || !dom.pageInfo || !dom.prevPage || !dom.nextPage) return;
    if (typeof formatNumber !== 'function') return;

    var totalPages = result.totalPages;
    if (totalPages <= 1) {
      dom.pagination.style.display = 'none';
      return;
    }
    dom.pagination.style.display = 'flex';
    dom.pageInfo.textContent = formatNumber(result.total) + ' 张';
    dom.prevPage.disabled = result.page <= 1;
    dom.nextPage.disabled = result.page >= totalPages;
    if (dom.randomPageBtn) {
      dom.randomPageBtn.disabled = totalPages <= 1;
    }

    var pages = generatePageNumbers(result.page, totalPages);
    var html = '';
    for (var j = 0; j < pages.length; j++) {
      if (pages[j] === '...') {
        html += '<span class="page-ellipsis">...</span>';
      } else {
        var cls = pages[j] === result.page ? ' active' : '';
        html +=
          '<button type="button" class="' +
          cls +
          '" data-go-to-page="' +
          pages[j] +
          '">' +
          pages[j] +
          '</button>';
      }
    }
    var pageNumbersEl = document.getElementById('pageNumbers');
    if (pageNumbersEl) pageNumbersEl.innerHTML = html;
  }

  global.RendererPhotoGridUI = Object.assign({}, global.RendererPhotoGridUI || {}, {
    renderPhotoGrid: renderPhotoGrid,
    showSkeleton: showSkeleton,
    renderPagination: renderPagination,
    bindGridImageProgress: bindGridImageProgress,
  });

  // ===== folder-cover-ui.js =====
  /** 无封面缩略图时的默认文件夹矢量图标（与样式 .folder-cover-placeholder--default 配套） */
  function folderCoverDefaultPlaceholderHtml() {
    return (
      '<div class="folder-cover-placeholder folder-cover-placeholder--default" aria-hidden="true">' +
      '<svg class="folder-cover-placeholder-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
      '<path class="folder-cover-placeholder-shape" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>' +
      '<path class="folder-cover-placeholder-inner" d="M4 8h16v10a2 2 0 01-2 2H6a2 2 0 01-2-2V8z"/>' +
      '</svg>' +
      '</div>'
    );
  }

  function folderDisplayBasename(folderPath, normalizePath) {
    if (typeof normalizePath !== 'function') return '\u76EE\u5F55';
    var n = normalizePath(folderPath || '').replace(/[\\/]+$/, '');
    var parts = n.split(/[\\/]+/);
    var leaf = parts[parts.length - 1];
    return leaf || n || '\u76EE\u5F55';
  }

  function buildFolderCoverCardHtml(row, normalizePath, escapeHtml, escapeAttr, formatNumber) {
    var fp = normalizePath(row.folder_path || '');
    var coverId = parseInt(row.id, 10);
    var thumbUrl =
      !isNaN(coverId) && coverId > 0 && row.has_thumbnail
        ? 'thumb://' + coverId
        : '';
    var base = folderDisplayBasename(fp, normalizePath);
    var cnt = row.folder_photo_count != null ? row.folder_photo_count : 0;
    var html =
      '<div class="folder-cover-card" data-folder-path="' +
      escapeAttr(fp) +
      '">' +
      '<span class="media-type-badge media-type-badge-folder">\u76EE\u5F55</span>';
    if (thumbUrl) {
      html +=
        '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
        '<img src="' +
        thumbUrl +
        '" alt="' +
        escapeHtml(row.file_name || '') +
        '" loading="lazy" class="loading grid-thumb" />';
    } else {
      html += folderCoverDefaultPlaceholderHtml();
    }
    html +=
      '<div class="folder-cover-meta">' +
      '<div class="folder-cover-name">' +
      escapeHtml(base) +
      '</div>' +
      '<div class="folder-cover-path" title="' +
      escapeAttr(fp) +
      '">' +
      escapeHtml(fp) +
      '</div>' +
      '<div class="folder-cover-count">' +
      formatNumber(cnt) +
      ' \u5F20\u7167\u7247</div>' +
      '</div></div>';
    return html;
  }

  function renderFolderCoverGrid(options) {
    options = options || {};
    var dom = options.dom || {};
    var covers = options.covers;
    var normalizePath = options.normalizePath;
    var escapeHtml = options.escapeHtml;
    var escapeAttr = options.escapeAttr;
    var formatNumber = options.formatNumber;
    var onApplyCardSize = options.onApplyCardSize;
    if (!dom.photoGrid) return;
    if (
      typeof normalizePath !== 'function' ||
      typeof escapeHtml !== 'function' ||
      typeof escapeAttr !== 'function'
    )
      return;
    if (typeof formatNumber !== 'function' || typeof onApplyCardSize !== 'function') return;

    if (!covers || covers.length === 0) {
      dom.photoGrid.innerHTML =
        '<div class="empty-state"><div class="icon">\u{1F5C2}\uFE0F</div>' +
        '<div class="title">\u6682\u65E0\u76EE\u5F55</div>' +
        '<div class="desc">\u6DFB\u52A0\u5E76\u626B\u63CF\u7167\u7247\u6587\u4EF6\u5939\u540E\u5C06\u663E\u793A\u6BCF\u4E2A\u76EE\u5F55\u7684\u5C01\u9762</div></div>';
      return;
    }

    var cn = covers.length;
    if (cn <= GRID_DOM_CHUNK_THRESHOLD) {
      var html = '<div class="grid">';
      for (var ci = 0; ci < cn; ci++) {
        html += buildFolderCoverCardHtml(covers[ci], normalizePath, escapeHtml, escapeAttr, formatNumber);
      }
      html += '</div>';
      dom.photoGrid.innerHTML = html;
      bindGridImageProgress(dom.photoGrid);
      onApplyCardSize();
      return;
    }

    var fgrid = document.createElement('div');
    fgrid.className = 'grid';
    dom.photoGrid.innerHTML = '';
    dom.photoGrid.appendChild(fgrid);

    var fstart = 0;
    var ffirst = true;
    function appendFolderChunk() {
      var fend = Math.min(fstart + GRID_DOM_CHUNK_SIZE, cn);
      var fchunk = '';
      for (var fk = fstart; fk < fend; fk++) {
        fchunk += buildFolderCoverCardHtml(covers[fk], normalizePath, escapeHtml, escapeAttr, formatNumber);
      }
      var ftemp = document.createElement('div');
      ftemp.innerHTML = fchunk;
      bindGridImageProgress(dom.photoGrid, ftemp);
      while (ftemp.firstChild) fgrid.appendChild(ftemp.firstChild);
      fstart = fend;
      if (ffirst) {
        ffirst = false;
        onApplyCardSize();
      }
      if (fstart < cn) {
        requestAnimationFrame(appendFolderChunk);
      } else {
        onApplyCardSize();
      }
    }
    appendFolderChunk();
  }

  global.RendererFolderCoverUI = Object.assign({}, global.RendererFolderCoverUI || {}, {
    renderFolderCoverGrid: renderFolderCoverGrid,
  });
})(window);
