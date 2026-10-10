(function (global) {
  'use strict';

  /**
   * 组织元数据（标记 / 评分 / 用户标签）的**渲染端状态与界面**。
   *
   * ## 三个维度与「收藏」的分工
   *
   *   收藏（`is_favorite`）      累积语义：我喜欢的，长期不动，是**成果**。
   *   标记（`flag`）              工作流语义：这一批我要哪些、不要哪些，是**过程**。
   *   评分（`rating`）            质量语义：这张够不够好。
   *   标签（`photo_tags`）        组织语义：这张归哪个项目 / 客户 / 地点。
   *
   * 不要在界面上把任何一个并进「收藏」—— 用户对它们的期待完全不同
   * （收藏是「留下」，标记是「过一遍」）。契约见 `docs/contracts/org-metadata.md`。
   *
   * ## 取值域在这里**镜像**了一份，这是刻意的
   *
   * 权威归一在 `src/main/org-meta-filter.js`（写入时夹取 / 白名单回落）。渲染端这份
   * 只决定「画几颗星、有几个标记按钮」——**不承担校验**。所以两份漂移的后果是
   * 「少画一颗星」，不是「写进脏值」。反过来，如果渲染端不镜像、改成从主进程拉，
   * 就得为「拿不到取值域」设计一条降级路径，而那条路径在启动竞态下会画出一排空按钮。
   *
   * ## 🔴 标记是**幂等设值**，评分是**点同一颗取消**
   *
   * 两者看着像「都是点一下设个值」，但取消的入口刻意不同：
   *   · 标记取消是一个**独立按钮**（`flag = 'none'`）—— 因为冲片时左手盲按 X，
   *     做成 toggle 会让「以为没按上、再按一次」把上一张的标记静默清掉；
   *   · 评分取消是**再点同一颗星**（回到 0）—— 因为星本来就是 5 个独立的点，
   *     「点第 3 颗时已经是 3 了」这件事在屏幕上是可见的，不存在盲操作问题。
   *     而且 `0` 这个键位已经被 `preview.zoomReset` 占了。
   *
   * 判据（当前值 → 下一个值）只写在 `nextRating()` / `nextFlag()` 两个函数里，
   * 界面按钮与快捷键都走它们，不许各自决定。
   */

  // ─────────────────────────────────────────────────────────────────────────
  // 取值域（镜像；权威在 `src/main/org-meta-filter.js`）
  // ─────────────────────────────────────────────────────────────────────────

  var RATING_MIN = 0;
  var RATING_MAX = 5;
  /** 顺序即按钮顺序：先「选」后「否」，清除独立放最后。 */
  var FLAG_VALUES = ['none', 'pick', 'reject'];

  function normalizeRating(value) {
    var n = parseInt(value, 10);
    if (!isFinite(n) || n <= RATING_MIN) return RATING_MIN;
    if (n >= RATING_MAX) return RATING_MAX;
    return n;
  }

  function normalizeFlag(value) {
    var v = String(value == null ? '' : value)
      .trim()
      .toLowerCase();
    return FLAG_VALUES.indexOf(v) >= 0 ? v : 'none';
  }

  /** 用户标签名归一（与主进程同规则：折叠空白 + trim；显示名保留大小写）。 */
  function normalizeTagDisplayName(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 评分按钮点下去应当变成的值：**点同一颗 = 取消**（回 0）。
   * 快捷键（`preview.rating1..5`）与星标按钮共用。
   */
  function nextRating(current, clicked) {
    var c = normalizeRating(current);
    var n = normalizeRating(clicked);
    return c === n ? RATING_MIN : n;
  }

  function t(key, zhFallback) {
    if (global.I18n && typeof global.I18n.t === 'function') {
      var s = global.I18n.t(key);
      if (s) return s;
    }
    return zhFallback;
  }

  function escapeHtml(str) {
    if (global.RendererUtils && typeof global.RendererUtils.escapeHtml === 'function') {
      return global.RendererUtils.escapeHtml(str == null ? '' : String(str));
    }
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 网格角标
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 把组织元数据写成卡片上的 data 属性（字符串形态，供静态建卡用）。
   *
   * 🔴 与 `writeCardOrgData` **必须同源**（同一个归一函数、同一对属性名）：
   *    一个在建卡时写、一个在增量更新时写，两边漂开就会出现
   *    「刚翻出来的卡片点一次星，标记角标消失」—— 因为回读到的属性名对不上。
   */
  function cardOrgDataAttrs(photo) {
    if (!photo) return '';
    return (
      ' data-org-flag="' +
      escapeHtml(normalizeFlag(photo.flag)) +
      '" data-org-rating="' +
      String(normalizeRating(photo.rating)) +
      '"'
    );
  }

  /**
   * 卡片上的组织元数据角标（标记 + 评分）。
   *
   * 位置：标记走**右上角**（左上角已被「视频 / LIVE」占了，见 `ui-grid.js`）；
   * 评分走**图片区左下角**（不压住「选 / 否」也不压住文件名条）。
   *
   * 🔴 空标记 / 0 星**一律不画**。这两样是**筛选维度**，如果每张卡都画一个
   *    「未标记」的灰圈，网格会立刻变成一片噪点，而角标的全部意义就是让「标过的」
   *    从「没标过的」里一眼跳出来 —— 画满等于没画。
   */
  function cardBadgeHtml(photo) {
    if (!photo) return '';
    var html = '';
    var flag = normalizeFlag(photo.flag);
    if (flag === 'pick') {
      html +=
        '<span class="photo-card-flag photo-card-flag--pick" title="' +
        escapeHtml(t('org.flag.pick', '已选')) +
        '" aria-label="' +
        escapeHtml(t('org.flag.pick', '已选')) +
        '"><svg class="badge-icon" aria-hidden="true"><use href="#icon-check"/></svg></span>';
    } else if (flag === 'reject') {
      html +=
        '<span class="photo-card-flag photo-card-flag--reject" title="' +
        escapeHtml(t('org.flag.reject', '已否')) +
        '" aria-label="' +
        escapeHtml(t('org.flag.reject', '已否')) +
        '"><svg class="badge-icon" aria-hidden="true"><use href="#icon-close"/></svg></span>';
    }
    var rating = normalizeRating(photo.rating);
    if (rating > 0) {
      // 星标用「实心星 × N」而不是「N 个实心 + 5-N 个空心」：卡片只有几十像素宽，
      // 5 颗星在 180px 卡上单颗不到 8px —— 空心星在这个尺寸下只是一团灰。
      // 数字本身才是可读的那个信息（与「筛选栏选 4 星」对得上）。
      html +=
        '<span class="photo-card-rating" title="' +
        escapeHtml(t('org.ratingLabel', '评分') + ' ' + rating) +
        '" aria-label="' +
        escapeHtml(t('org.ratingLabel', '评分') + ' ' + rating) +
        '"><svg class="badge-icon" aria-hidden="true"><use href="#icon-star-filled"/></svg>' +
        '<em>' +
        rating +
        '</em></span>';
    }
    return html;
  }

  /**
   * 只重画某一张卡片的角标（不重建整个网格）。
   *
   * 为什么不 `loadPhotos()` 重拉：改一个标记会重排整页 —— 在「已标记」筛选下
   * 那一张本来就该消失，重拉是对的动作；但在**无筛选**下重拉会让网格闪一下、
   * 滚动位置变化，而用户只是点了个星。
   *
   * 判据与「要不要重拉」分开：是否重拉由 `filterMightChangeFor(patch)` 决定
   * （见 `setFlag` / `setRating` 的调用方）。
   */
  function updateCardBadge(photoId, patch) {
    var card = document.querySelector('.photo-card[data-photo-id="' + photoId + '"]');
    if (!card) return;
    var oldFlags = card.querySelectorAll('.photo-card-flag, .photo-card-rating');
    for (var i = 0; i < oldFlags.length; i++) {
      oldFlags[i].parentNode.removeChild(oldFlags[i]);
    }
    var merged = { id: photoId };
    // 只带 patch 里有的键：另一个维度要沿用**卡片上现在这个值**，
    // 所以先从卡片的 data 属性回读（渲染时写过，见 `writeCardOrgData`）。
    merged.flag = patch && Object.prototype.hasOwnProperty.call(patch, 'flag')
      ? patch.flag
      : card.getAttribute('data-org-flag');
    merged.rating = patch && Object.prototype.hasOwnProperty.call(patch, 'rating')
      ? patch.rating
      : card.getAttribute('data-org-rating');
    writeCardOrgData(card, merged);
    var html = cardBadgeHtml(merged);
    if (!html) return;
    // 插到缩略图之后、`.photo-info` 之前 —— 与渲染期完全同一位置，
    // 否则「新点的角标」和「重拉出来的角标」会停在不同地方（一个在图上、一个在图下）。
    var info = card.querySelector('.photo-info');
    if (info) info.insertAdjacentHTML('beforebegin', html);
    else card.insertAdjacentHTML('beforeend', html);
  }

  /**
   * 把组织元数据写到卡片的 data 属性上。
   *
   * 🔴 这不是「顺手缓存」，而是 `updateCardBadge` 的**唯一回读来源**：
   *    改一个维度时另一个维度必须沿用当前值，而那个值只可能在 DOM 上
   *    （`state.currentPhotos` 在翻页后可能已经不含这张）。
   *    不写这两个属性 ⇒ 点一次星会把已有的标记角标擦掉，而且不报错。
   */
  function writeCardOrgData(card, photo) {
    if (!card || !photo) return;
    card.setAttribute('data-org-flag', normalizeFlag(photo.flag));
    card.setAttribute('data-org-rating', String(normalizeRating(photo.rating)));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 状态补丁
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 把一次写入的结果同步进内存态（`state.currentPhotos` + `state.previewPhotos`）。
   *
   * ⚠️ 两处都要改：只改 `previewPhotos` ⇒ 关掉预览后网格上还是旧角标；
   *    只改 `currentPhotos` ⇒ 预览工具条上的星标不动。两者都是**静默**的。
   *    `previewPhotos` 与 `currentPhotos` 是**不同对象**（预览会跨页加载），
   *    所以不能靠「改一个、另一个跟着」。
   */
  function patchInState(state, photoId, patch) {
    if (!state || !patch) return;
    var id = Number(photoId);
    function apply(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        if (Number(list[i] && list[i].id) !== id) continue;
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) list[i][k] = patch[k];
        }
      }
    }
    apply(state.currentPhotos);
    apply(state.previewPhotos);
    if (Array.isArray(state.slideshowRandomPool)) apply(state.slideshowRandomPool);
  }

  /** 当前预览的那张（取不到返回 null）。 */
  function currentPhoto(state) {
    if (!state || !Array.isArray(state.previewPhotos)) return null;
    return state.previewPhotos[state.previewIndex] || null;
  }

  function currentPhotoId(state) {
    var photo = currentPhoto(state);
    return photo && photo.id ? Number(photo.id) : 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 筛选
  // ─────────────────────────────────────────────────────────────────────────

  /** 空的筛选态。`null` 表示「不限」—— 与 `0` / `'none'`（合法的具体值）刻意分开。 */
  function emptyFilter() {
    return { rating: null, flag: null, tagIds: [] };
  }

  function ensureFilter(state) {
    if (!state.orgFilter) state.orgFilter = emptyFilter();
    if (!Array.isArray(state.orgFilter.tagIds)) state.orgFilter.tagIds = [];
    return state.orgFilter;
  }

  /**
   * 有没有生效中的组织元数据筛选。
   *
   * ⚠️ 判据必须与 `src/main/org-meta-filter.js#hasOrgMetaFilter` **同源**：
   *    这里说「有」而主进程不筛（或反过来），就会出现「筛选栏亮着、结果没筛」
   *    这种只在眼睛对着看时才能发现的错。
   */
  function hasActiveFilter(state) {
    var f = state && state.orgFilter;
    if (!f) return false;
    if (f.rating != null) return true;
    if (f.flag != null) return true;
    return Array.isArray(f.tagIds) && f.tagIds.length > 0;
  }

  /**
   * 把当前筛选并进请求参数。**只在真有筛选时加键** ——
   * 加一个 `rating: null` 会让主进程的 `!= null` 判据把它当成「不限」，
   * 但那意味着多一个键要维护；不加键时「不筛」这件事由「键不存在」表达，更稳。
   */
  function applyFilterToOptions(options, state) {
    var out = options || {};
    var f = state && state.orgFilter;
    if (!f) return out;
    if (f.rating != null) out.rating = f.rating;
    if (f.flag != null) out.flag = f.flag;
    if (Array.isArray(f.tagIds) && f.tagIds.length) out.tagIds = f.tagIds.slice();
    return out;
  }

  /**
   * 改了组织元数据之后，当前这一屏需不需要重新拉。
   *
   * 判据：**当前筛选正在约束这个维度** ⇒ 改完之后这张可能不再属于当前集合
   * （比如在「仅已选」档点「否」），必须重拉。没约束 ⇒ 只更新角标，不重拉
   * （重拉会让网格闪一下、滚动位置丢失，而用户只是点了个星）。
   *
   * 🔴 标签维度只能保守判「有标签筛选就重拉」：一张图可能被加进/移出任何
   *    一个标签集合，前端不查库无法知道结果集变没变。保守重拉多花一次查询，
   *    不重拉则会出现「列表里有它、筛选说它不该在」。
   */
  function filterMightChangeFor(state, dimension) {
    var f = state && state.orgFilter;
    if (!f) return false;
    if (dimension === 'rating') return f.rating != null;
    if (dimension === 'flag') return f.flag != null;
    if (dimension === 'tags') return Array.isArray(f.tagIds) && f.tagIds.length > 0;
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 写入（三条通道：标记 / 评分 / 标签）
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 写标记。`flag` 是**目标值**（`'none'` 也是合法目标值），不是「切换」。
   *
   * 返回 `true` 表示写成功。调用方据此决定要不要重拉列表
   * （见 `filterMightChangeFor`）。
   */
  async function setFlag(opts) {
    var state = opts.state;
    var api = opts.api;
    var onLoadPhotos = opts.onLoadPhotos;
    if (!state || !api || typeof api.photoSetFlag !== 'function') return false;
    var photo = currentPhoto(state);
    if (!photo || !photo.id) return false;
    var target = normalizeFlag(opts.flag);
    var previous = normalizeFlag(photo.flag);
    // 已经就是这个态 ⇒ 什么都不做。**不报错也不闪烁**：冲片时盲按，重复按同一个键
    // 是常态，弹一个「已经是这个状态了」的提示等于在惩罚正确操作。
    if (previous === target) return true;

    var r = await api.photoSetFlag(photo.id, target);
    if (!r || !r.success) {
      if (typeof opts.appAlert === 'function') {
        opts.appAlert(t('org.writeFailed', '操作失败') + '：' + ((r && r.error) || '未知错误'));
      }
      return false;
    }
    var value = normalizeFlag(r.flag != null ? r.flag : target);
    patchInState(state, photo.id, { flag: value });
    updateCardBadge(photo.id, { flag: value });
    syncPreviewControls(opts);
    if (filterMightChangeFor(state, 'flag') && typeof onLoadPhotos === 'function') {
      await onLoadPhotos();
    }
    notifyBackgroundCounts(opts);
    return true;
  }

  /**
   * 写评分。`rating` 是**点击的那一颗**（1-5），点同一颗 = 取消。
   * 传 `0` 直接取消（给「清除评分」这类显式入口留的）。
   */
  async function setRating(opts) {
    var state = opts.state;
    var api = opts.api;
    var onLoadPhotos = opts.onLoadPhotos;
    if (!state || !api || typeof api.photoSetRating !== 'function') return false;
    var photo = currentPhoto(state);
    if (!photo || !photo.id) return false;
    var target =
      Number(opts.rating) === 0
        ? RATING_MIN
        : nextRating(photo.rating, opts.rating);
    var previous = normalizeRating(photo.rating);
    if (previous === target) return true;

    var r = await api.photoSetRating(photo.id, target);
    if (!r || !r.success) {
      if (typeof opts.appAlert === 'function') {
        opts.appAlert(t('org.writeFailed', '操作失败') + '：' + ((r && r.error) || '未知错误'));
      }
      return false;
    }
    var value = normalizeRating(r.rating != null ? r.rating : target);
    patchInState(state, photo.id, { rating: value });
    updateCardBadge(photo.id, { rating: value });
    syncPreviewControls(opts);
    if (filterMightChangeFor(state, 'rating') && typeof onLoadPhotos === 'function') {
      await onLoadPhotos();
    }
    notifyBackgroundCounts(opts);
    return true;
  }

  /**
   * 写标签（**全量替换**）。`names` 是完整的最终集合，不是增量。
   *
   * 🔴 回包里的 `tags` 才是真相：主进程会做归一、去重、自动建标签。
   *    界面必须用回包重画，不能用用户敲进去的原文 —— 否则「客户a」与「客户A」
   *    会显示成两个 chip，而下一次进这张图它们又合成一个。
   */
  async function setTags(opts) {
    var state = opts.state;
    var api = opts.api;
    var onLoadPhotos = opts.onLoadPhotos;
    if (!state || !api || typeof api.photoSetTags !== 'function') return false;
    var photo = currentPhoto(state);
    if (!photo || !photo.id) return false;
    var names = (Array.isArray(opts.names) ? opts.names : [])
      .map(normalizeTagDisplayName)
      .filter(function (n) {
        return !!n;
      });

    var r = await api.photoSetTags(photo.id, names);
    if (!r || !r.success) {
      if (typeof opts.appAlert === 'function') {
        opts.appAlert(t('org.writeFailed', '操作失败') + '：' + ((r && r.error) || '未知错误'));
      }
      return false;
    }
    state.previewTags = Array.isArray(r.tags) ? r.tags : [];
    state.previewTagsPhotoId = photo.id;
    if (typeof opts.onSyncTagsPanel === 'function') opts.onSyncTagsPanel();
    if (filterMightChangeFor(state, 'tags') && typeof onLoadPhotos === 'function') {
      await onLoadPhotos();
    }
    if (typeof opts.onTagsChanged === 'function') opts.onTagsChanged();
    return true;
  }

  /**
   * 写入成功后通知「与元数据有关的派生数字」刷新。
   *
   * ⚠️ 刻意**不刷全局统计**（`loadStats`）与侧栏收藏数：那三个数不吃评分 / 标记 / 标签
   *    （统计口径里照片数与媒体档、目录结构有关，见 `docs/contracts/background-tasks.md`）。
   *    顺手刷一遍的代价是：每按一次 X 都重跑一次几秒级的多子查询聚合 ——
   *    而冲片时用户一秒钟按好几下，那会把主进程压死。
   *    这个函数目前只在「筛选栏的标签下拉需要重算」时做轻量刷新，别的什么都不做。
   */
  function notifyBackgroundCounts(opts) {
    void opts;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 预览工具条
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 把当前图片的组织元数据画到预览工具条上（标记按钮激活态 + 星标 + 标签计数）。
   *
   * 🔴 每次切图都要调（由 `previewFlow.openPreview` 同一条路径回调），
   *    与 LIVE 按钮 / 编辑按钮同一规律：只写在「打开预览」那一条路上会覆盖不到「左右切换」，
   *    症状是「翻到下一张，星标还停在上一张」。
   */
  function syncPreviewControls(opts) {
    var state = opts && opts.state;
    var dom = (opts && opts.dom) || {};
    var photo = currentPhoto(state);
    var flag = normalizeFlag(photo && photo.flag);
    var rating = normalizeRating(photo && photo.rating);

    var flagBtns = [
      ['previewFlagPickBtn', 'pick'],
      ['previewFlagRejectBtn', 'reject'],
      ['previewFlagClearBtn', 'none'],
    ];
    for (var i = 0; i < flagBtns.length; i++) {
      var btn = dom[flagBtns[i][0]];
      if (!btn) continue;
      // 「清除」按钮在本来就是 none 的时候**不高亮** —— 高亮它等于说「这张被清除了」，
      // 而它只是「没有标记」。另外两个按钮才表达「现在的状态」。
      var active = flag === flagBtns[i][1] && !(flagBtns[i][1] === 'none' && flag === 'none');
      if (flagBtns[i][1] === 'none') active = false;
      btn.classList.toggle('active', active);
    }

    var stars = dom.previewRatingStars;
    if (stars) {
      var list = stars.querySelectorAll('.preview-rating-star');
      for (var j = 0; j < list.length; j++) {
        var v = Number(list[j].getAttribute('data-rating')) || 0;
        list[j].classList.toggle('active', v <= rating && rating > 0);
      }
      stars.setAttribute('aria-label', t('org.ratingLabel', '评分') + ' ' + rating + ' / 5');
    }

    var tagsBtn = dom.previewOrgBtn;
    if (tagsBtn) {
      var count = Array.isArray(state && state.previewTags) ? state.previewTags.length : 0;
      // 角标只数**标签**（不是「整理」抽屉里那四组东西的总数）：标签是唯一
      // 「有 / 没有」需要提示的一维 —— 标记和星标在图上看不见，收藏有实心心形，
      // 而「这张图有没有打过标签」在图上是完全不可见的。数字的含义写在
      // 抽屉的标签分区里，按钮本身只给「有几条」。
      var badge = tagsBtn.querySelector('.preview-tags-count');
      if (badge) badge.textContent = count ? String(count) : '';
      tagsBtn.classList.toggle('has-tags', count > 0);
    }
  }

  /**
   * 拉当前这张图的用户标签。
   *
   * ⚠️ 必须**带 photoId 校验回包**：用户可能在这条请求在途时已经翻了三张，
   *    回包回来后如果直接写 `state.previewTags`，就会把 A 的标签画到 C 上 ——
   *    而这在屏幕上看起来完全正常（标签本来就可能长得很像）。
   *    与图片信息面板的 `previewInfoLoadSeq` 是同一类保护。
   */
  async function loadTagsForPreview(opts) {
    var state = opts.state;
    var api = opts.api;
    if (!state || !api || typeof api.photoGetTags !== 'function') return;
    var id = currentPhotoId(state);
    if (!id) return;
    var seq = (state.previewTagsLoadSeq || 0) + 1;
    state.previewTagsLoadSeq = seq;
    var r;
    try {
      r = await api.photoGetTags(id);
    } catch (e) {
      // 🔴 读取一律降级。调用点 `app.js#syncPreviewOrgMeta` 是**点了就不管**的写法
      //    （既不 `await` 也不 `.catch`），所以这里抛出去就是一个 unhandled rejection；
      //    而它在调用前已经把面板清空了 ⇒ 症状是「标签面板永远是空的」，
      //    除了控制台里一行红字之外没有任何提示。
      //    与 `database.js#getPhotoTags` 的 try/catch → `[]`、网页端 `/api/photo-tags`
      //    的「读不到一律空结构」是同一条取向（面板是只读展示，读不到就画空）。
      r = null;
    }
    if (state.previewTagsLoadSeq !== seq) return; // 已被更新的请求取代
    if (currentPhotoId(state) !== id) return; // 切图了
    state.previewTags = r && r.success && Array.isArray(r.tags) ? r.tags : [];
    state.previewTagsPhotoId = id;
    syncPreviewControls(opts);
    if (typeof opts.onSyncTagsPanel === 'function') opts.onSyncTagsPanel();
  }

  /**
   * 标签面板里的 chip 列表（含删除叉）。
   *
   * 用 `data-tag-name` 而不是下标：删除时按下标取，用户连点两下就会因为
   * 第一下已经缩短了数组而删掉错的另一个。
   */
  function tagsChipsHtml(names) {
    var list = Array.isArray(names) ? names : [];
    if (!list.length) {
      return (
        '<div class="preview-org-tags-empty">' +
        escapeHtml(t('org.tagsEmpty', '还没有标签。输入后回车添加。')) +
        '</div>'
      );
    }
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var name = normalizeTagDisplayName(list[i]);
      if (!name) continue;
      html +=
        '<span class="preview-org-tag">' +
        escapeHtml(name) +
        '<button type="button" class="preview-org-tag-remove" data-tag-name="' +
        escapeHtml(name) +
        '" aria-label="' +
        escapeHtml(t('org.tagRemove', '移除标签')) +
        '">×</button></span>';
    }
    return html;
  }

  global.RendererOrgMetaUI = Object.assign({}, global.RendererOrgMetaUI || {}, {
    RATING_MIN: RATING_MIN,
    RATING_MAX: RATING_MAX,
    FLAG_VALUES: FLAG_VALUES,
    normalizeRating: normalizeRating,
    normalizeFlag: normalizeFlag,
    normalizeTagDisplayName: normalizeTagDisplayName,
    nextRating: nextRating,
    cardBadgeHtml: cardBadgeHtml,
    cardOrgDataAttrs: cardOrgDataAttrs,
    updateCardBadge: updateCardBadge,
    writeCardOrgData: writeCardOrgData,
    patchInState: patchInState,
    currentPhoto: currentPhoto,
    currentPhotoId: currentPhotoId,
    emptyFilter: emptyFilter,
    ensureFilter: ensureFilter,
    hasActiveFilter: hasActiveFilter,
    applyFilterToOptions: applyFilterToOptions,
    filterMightChangeFor: filterMightChangeFor,
    setFlag: setFlag,
    setRating: setRating,
    setTags: setTags,
    syncPreviewControls: syncPreviewControls,
    loadTagsForPreview: loadTagsForPreview,
    tagsChipsHtml: tagsChipsHtml,
  });
})(window);
