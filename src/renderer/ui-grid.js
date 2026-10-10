(function (global) {
  'use strict';

  /** 超过此数量时分帧插入 DOM，减轻大图库单页（如 500 张）时的长任务卡顿 */
  var GRID_DOM_CHUNK_THRESHOLD = 72;
  var GRID_DOM_CHUNK_SIZE = 48;

  /**
   * 「没有缩略图」的统一占位图（2026-10-05）。
   *
   * 同一件事有两条入口：① 构建期就知道没有（`has_thumbnail` 为假）；② 构建期有、缩略图
   * 文件后来丢了（`markFailed` 里的 404）。以前两条各画各的 —— 前者是「大号扩展名 + 文件
   * 名」的纯文本（文件名还和卡片底部的 `.photo-info` 重复一遍），后者是另一个图标加一句
   * 报错；网页端更早还有第三副面孔（⚠️ emoji）。
   *
   * 现在两条共用**同一份图形**：中性底 + 一点强调色晕影 + 居中的图片字形 + 一行小字
   * （没有缩略图时是扩展名，加载失败时是错误文案）。
   *
   * 图形**内联**而不是 `<use href="#icon-image">`：网页端没有那个 symbol，两端要长得一模
   * 一样就得各自带全路径；而且内联才让描边粗细归 CSS 管 —— `<use>` 的 shadow tree 里
   * symbol 自带的 `stroke-width` 会盖掉宿主继承下来的值，放大到 56px 会粗得发憨。
   */
  var MEDIA_PLACEHOLDER_GLYPH =
    '<svg class="placeholder-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5"/>' +
    '<circle cx="8.6" cy="8.6" r="1.5"/>' +
    '<polyline points="21 15 16 10 5 21"/>' +
    '</svg>';

  /** 占位图的「内芯」（图形 + 说明）。字符串版与 DOM 版共用，别各写一份。 */
  /**
   * 网格空态 / 骨架屏的**媒体档位三档文案**（全部 / 仅图片 / 仅视频）。
   *
   * 唯一真相源在这里。三档的「词」必须与底栏 `#mediaFilterSelect` 的选项一致：
   * `all` 档**含视频**，所以说「图片与视频」；`image` / `video` 各说各的。
   *
   * ⚠️ 网页端是**另一份实现**（`web/js/app.js#renderPhotoGrid` / `#showSkeleton`），
   *    改这里必须同改那边 —— 两端没有共享模块。
   * ⚠️ 这里不复用 `stats.bar*Fmt` 那三条：那是**顶栏统计**的句式
   *    （`{photos} 张图片 | 视频 {videos} 条`），和「空态 / 加载中」不是一句话。
   * ⚠️ `suffix` 同时是 i18n 键的尾巴（`grid.emptyTitle` + `All` …），改名要同步词条表。
   */
  var MEDIA_FILTER_TEXTS = {
    all: {
      suffix: 'All',
      title: '暂无图片与视频',
      hint: '换个位置看看，或到「设置」里点「添加目录」加入文件夹。',
      loading: '正在加载图片与视频…',
    },
    image: {
      suffix: 'Image',
      title: '暂无图片',
      hint: '这里没有图片，可切到「全部」或「仅视频」看看。',
      loading: '正在加载图片…',
    },
    video: {
      suffix: 'Video',
      title: '暂无视频',
      hint: '这里没有视频，可切到「全部」或「仅图片」看看。',
      loading: '正在加载视频…',
    },
  };

  /** 把任意输入收敛成三档之一（与 `app.js#normalizeMediaFilter` 同口径） */
  function mediaFilterTexts(mediaFilter) {
    return MEDIA_FILTER_TEXTS[mediaFilter === 'image' || mediaFilter === 'video' ? mediaFilter : 'all'];
  }

  /**
   * 词条 + 中文兜底。
   *
   * ⚠️ `I18n.t()` 取不到键时**返回键本身**而不是空串 ⇒ 必须显式判等，
   *    否则界面上会直接出现 `grid.emptyTitleAll` 这种原始键。
   *    没有 `window.I18n` 时（vm 回归夹具）走中文兜底。
   */
  function tGrid(key, zhFallback) {
    var t = global.I18n && global.I18n.t;
    if (typeof t === 'function') {
      var s = t(key);
      if (s && s !== key) return s;
    }
    return zhFallback;
  }

  function mediaPlaceholderInnerHtml(caption) {
    return (
      MEDIA_PLACEHOLDER_GLYPH +
      (caption ? '<span class="placeholder-caption">' + caption + '</span>' : '')
    );
  }

  function mediaPlaceholderHtml(caption) {
    return (
      '<div class="placeholder placeholder--media">' + mediaPlaceholderInnerHtml(caption) + '</div>'
    );
  }

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
    var subfolderSummaries = Array.isArray(options.subfolderSummaries)
      ? options.subfolderSummaries
      : [];
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
      // 文案按媒体档位切换（三档的标题 / 副提示都在 MEDIA_FILTER_TEXTS 里）。
      // 🔴 副提示必须给**可执行下一步**：`image` / `video` 档空多半是「筛掉了」，
      //    引导去另一档比笼统的「换个条件看看」有用得多。
      var emptyTexts = mediaFilterTexts(mediaFilter);
      dom.photoGrid.innerHTML =
        '<div class="empty-state"><div class="icon">📭</div><div class="title">' +
        escapeHtml(tGrid('grid.emptyTitle' + emptyTexts.suffix, emptyTexts.title)) +
        '</div><div class="desc">' +
        escapeHtml(tGrid('grid.emptyHint' + emptyTexts.suffix, emptyTexts.hint)) +
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
        ? '<div class="browse-folder-section-label browse-folder-section-label--photos">此文件夹中的图片与视频</div>'
        : '';

    if (!hasPhotos) {
      dom.photoGrid.innerHTML = prefixHtml;
      bindGridImageProgress(dom.photoGrid);
      onApplyCardSize();
      return;
    }

    var gridClass = 'grid' + (useMediaRatio ? ' grid--masonry' : '');
    var gridAttr = ' data-use-media-ratio="' + (useMediaRatio ? '1' : '0') + '"';
    if (n <= GRID_DOM_CHUNK_THRESHOLD) {
      var html = prefixHtml + photosLabelHtml + '<div class="' + gridClass + '"' + gridAttr + '>';
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
    grid.className = gridClass;
    grid.dataset.useMediaRatio = useMediaRatio ? '1' : '0';
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

  /**
   * 这张图片有没有伴生视频（= 是不是 Live Photo 的静帧）。
   *
   * 一律转发到 `utils.js` 的唯一实现（预览里的播放按钮用的是同一个判据 ——
   * 各写一份就会出现「卡片有 LIVE 角标、点开却按不出播放」）。
   */
  function isLivePhotoStill(photo) {
    return global.RendererUtils.isLivePhotoStill(photo);
  }

  /**
   * 缩略图 URL 的缓存键 —— 转发到唯一真相源（`utils.js#thumbCacheVersion`）。
   *
   * 🔴 这里以前**根本没有键**：卡片直接写 `thumb://<id>`。缩略图全量重建（换档 / 转 WebP）
   *    之后每一行的字节都变了，而 URL 一个都没变 ⇒ 桌面端一路读 Chromium 内存缓存、
   *    网页端还有 `max-age=86400`，「重建跑完了，卡片还是老的」。
   *    键里带的是**这一行自己的规格**，所以混规格库（重建进行到一半）也不会串：
   *    已重建的行换新 URL、未重建的行继续命中旧缓存。
   */
  function thumbCacheVersion(photo) {
    return global.RendererUtils.thumbCacheVersion(photo);
  }

  function isVideoPhoto(photo) {
    var row = photo || {};
    var mt = String(row.media_type || row.mediaType || '').toLowerCase();
    if (mt === 'video') return true;
    var ft = String(row.file_type || '')
      .toLowerCase()
      .replace(/^\./, '');
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

  function getMediaAspectRatioDims(photo) {
    var row = photo || {};
    var w = parseFloat(row.width || row.pixel_width || row.file_width || row.media_width || 0);
    var h = parseFloat(row.height || row.pixel_height || row.file_height || row.media_height || 0);
    if (!(w > 0 && h > 0)) return null;
    var r = w / h;
    if (!isFinite(r) || r <= 0) return null;
    if (r < 0.125 || r > 8) return null;
    return { w: Math.round(w), h: Math.round(h), ratio: String(w) + ' / ' + String(h) };
  }

  function buildSinglePhotoCardHtml(photo, i, useMediaRatio, escapeHtml, truncate, formatDateTime) {
    var isVideo = isVideoPhoto(photo);
    var ratioObj = useMediaRatio ? getMediaAspectRatioDims(photo) : null;
    var ratio = ratioObj ? ratioObj.ratio : '';
    var thumbUrl = photo.has_thumbnail ? 'thumb://' + photo.id + '?v=' + thumbCacheVersion(photo) : '';
    var delay = Math.min(i * 30, 600);
    var favIcon = photo.is_favorite ? '<svg class="fav-icon" aria-hidden="true"><use href="#icon-star-filled"/></svg>' : '<svg class="fav-icon" aria-hidden="true"><use href="#icon-star"/></svg>';
    var cardStyle = 'animation-delay:' + delay + 'ms;';
    if (ratio && !useMediaRatio) cardStyle += 'aspect-ratio:' + ratio + ';';
    // 原比例瀑布流里卡片是「按内容定高」的：有缩略图时靠 <img> 的内在尺寸撑开，
    // 没有缩略图时占位块是纯文本、自身没有任何内在尺寸 —— 卡片会塌成一条比文字还矮的
    // 横杠（列高再被 `columns` 继承，整列看着像空了）。所以这种卡片按正方形占位。
    // 「统一高度」那档不用管：那边由 `.grid:not([data-use-media-ratio='1']) .photo-card`
    // 统一给死 --photo-card-ratio，占位块 height:100% 自然铺满。
    var cardClass = 'photo-card';
    if (!thumbUrl && useMediaRatio) cardClass += ' photo-card--square-placeholder';
    // 组织元数据（标记 / 评分）：角标 HTML 与 data 属性都由 `org-meta-ui.js` 产出。
    // ⚠️ 走模块而不是在这里手拼：增量更新那张卡时（用户点了星）走的是同一个函数，
    //    两处各拼一份必然漂移，症状是「刚点过的卡片角标跑到别的位置 / 消失」。
    var orgUi = window.RendererOrgMetaUI || {};
    var orgAttrs = typeof orgUi.cardOrgDataAttrs === 'function' ? orgUi.cardOrgDataAttrs(photo) : '';
    var orgBadges = typeof orgUi.cardBadgeHtml === 'function' ? orgUi.cardBadgeHtml(photo) : '';
    var html =
      '<div class="' +
      cardClass +
      '" data-photo-id="' +
      photo.id +
      '" data-preview-index="' +
      i +
      '"' +
      orgAttrs +
      ' style="' +
      cardStyle +
      '">' +
      '<button type="button" class="photo-card-fav" title="收藏（鼠标悬停卡片时显示）" aria-label="收藏" data-fav-photo-id="' +
      photo.id +
      '">' +
      favIcon +
      '</button>';
    if (isVideo) {
      html += '<span class="media-type-badge media-type-badge-video"><svg class="badge-icon" aria-hidden="true"><use href="#icon-video"/></svg></span>';
    }
    // Live Photo：图片本体 + 一段可播放的动态。与视频徽标**互斥**（本列只写在图片行上），
    // 所以两者共用左上角不会撞位。用文字而不是图标是刻意的 —— iOS 本来的角标就是
    // 「LIVE」字样，且不必为此往 SVG sprite 里加 symbol（改 sprite 要动 index.html + 升 SW）。
    if (isLivePhotoStill(photo)) {
      html += '<span class="media-type-badge media-type-badge-live" title="Live Photo：含可播放的动态">LIVE</span>';
    }
    // 组织元数据角标（标记右下、评分左下）。插在缩略图**之前**：
    // 缩略图是绝对定位铺满的层，角标要跟它在同一层叠上下文里才压得住。
    html += orgBadges;
    if (thumbUrl) {
      var imgWH = ratioObj ? ' width="' + ratioObj.w + '" height="' + ratioObj.h + '"' : '';
      html +=
        '<div class="thumb-blur-placeholder" aria-hidden="true"></div>' +
        '<img src="' +
        thumbUrl +
        '" alt="' +
        escapeHtml(photo.file_name) +
        '" loading="lazy" class="loading grid-thumb"' + imgWH + ' />';
    } else {
      // 统一占位图（见 MEDIA_PLACEHOLDER_GLYPH）：以前的「扩展名 + 文件名」纯文本去掉了
      // —— 文件名在卡片底部的 `.photo-info` 里本来就有一份。
      html += mediaPlaceholderHtml(escapeHtml(photo.file_type || '?'));
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
    placeholder.className = 'placeholder placeholder--media';
    placeholder.innerHTML = mediaPlaceholderInnerHtml('\u7F29\u7565\u56FE\u52A0\u8F7D\u5931\u8D25');
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
          // 缩略图「文件本身缺失/损坏」时走的是这条路（`has_thumbnail` 还是 1，图 404）。
          // 图一摘掉，瀑布流卡片就失去了唯一的定高依据（见 markLoaded 里那句 aspectRatio），
          // 同样退回正方形占位，否则塌成一条。
          if (root && root.dataset && root.dataset.useMediaRatio === '1') {
            card.classList.add('photo-card--square-placeholder');
          }
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
    var mediaFilter = options.mediaFilter;
    var escapeHtml = options.escapeHtml;
    var onApplyCardSize = options.onApplyCardSize;
    if (!dom.photoGrid) return;
    if (typeof escapeHtml !== 'function' || typeof onApplyCardSize !== 'function') return;

    // 没显式给 label 的调用方（浏览页那条）按**当前媒体档位**取文案；
    // 搜图 / 目录封面那几条自己传了 label（如「正在本机搜索…」），不受影响。
    var loadingTexts = mediaFilterTexts(mediaFilter);
    var label = loadingLabel || tGrid('grid.loading' + loadingTexts.suffix, loadingTexts.loading);
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
    // 🔴 这一句必须排在下面的早退**之前**：`#randomPageBtn` 不在 `.pagination` 里
    //    （它是 `.browse-footer-actions` 的子节点），`dom.pagination.style.display = 'none'`
    //    收不起它 —— 写在早退之后就会在「只有一页」时留下一个显眼、能点、却毫无反应的按钮
    //    （`goToRandomPage()` 对 `tp <= 1` 是静默 return）。browse-grid-style-regression 钉着这条。
    if (dom.randomPageBtn) {
      dom.randomPageBtn.disabled = totalPages <= 1;
    }
    if (totalPages <= 1) {
      dom.pagination.style.display = 'none';
      return;
    }
    dom.pagination.style.display = 'flex';
    dom.pageInfo.textContent = formatNumber(result.total) + ' 张';
    dom.prevPage.disabled = result.page <= 1;
    dom.nextPage.disabled = result.page >= totalPages;

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
    // 封面行也带规格了（`db-heavy-read.js` 里三条封面查询都按主键回查了 `thumb_size`/`thumb_format`），
    // 所以封面与卡片用同一个键：重建之后封面也跟着刷新，不会再出现「卡片是新的、封面还是旧的」。
    var thumbUrl =
      !isNaN(coverId) && coverId > 0 && row.has_thumbnail
        ? 'thumb://' + coverId + '?v=' + thumbCacheVersion(row)
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
      ' \u5F20\u56FE\u7247</div>' +
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
        '<div class="desc">\u6DFB\u52A0\u5E76\u626B\u63CF\u56FE\u7247\u6587\u4EF6\u5939\u540E\u5C06\u663E\u793A\u6BCF\u4E2A\u76EE\u5F55\u7684\u5C01\u9762</div></div>';
      return;
    }

    var cn = covers.length;
    if (cn <= GRID_DOM_CHUNK_THRESHOLD) {
      var html = '<div class="grid">';
      for (var ci = 0; ci < cn; ci++) {
        html += buildFolderCoverCardHtml(
          covers[ci],
          normalizePath,
          escapeHtml,
          escapeAttr,
          formatNumber,
        );
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
        fchunk += buildFolderCoverCardHtml(
          covers[fk],
          normalizePath,
          escapeHtml,
          escapeAttr,
          formatNumber,
        );
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
