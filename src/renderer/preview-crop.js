(function (global) {
  'use strict';

  /**
   * 预览里的**裁剪选区**（编辑三步曲里的第三步）。
   *
   * 本模块只负责「让用户画出一个矩形」并把**图片像素坐标**交出去；
   * 真正落盘 + 入库在 `photo-edit-service.js`（经 app.js#savePreviewEdit 调用）。
   *
   * 几条刻意的取舍：
   *   · 遮罩用 `.preview-crop-box` 的 `box-shadow: 0 0 0 9999px` 画，而不是铺四块暗区：
   *     选区一改，暗区自动跟着变，没有「四个 div 的尺寸要同时更新」这种会漂移的状态。
   *   · 层用 `position: fixed` + 视口坐标：预览图的容器里有 transform / overflow，
   *     用 absolute 会因为定位上下文不同而算错（而算错的表现是「框和图片错位」）。
   *   · 窗口尺寸一变就**退出裁剪**（而不是跟着重算）：重算要把已画的选框换算到新的显示尺寸，
   *     收益很低；退出后用户重新点一次即可，行为可预期。
   *     ⚠️ **已确认（pending）的选区是例外**：那是用户已经决定好的东西，丢掉太贵 ⇒ 跟着重排。
   *
   * ============================ 两条实测红线（勿凭印象改）============================
   *
   * 🔴 ① **不能拿 `img.getBoundingClientRect()` 当「图片的显示盒」。**
   *    `.preview-image` 是 `width:100%; height:100%; object-fit: contain` —— 元素盒撑满
   *    整块舞台，图片在元素里**居中留白**。实测（`.workbuddy/tmp/preview-geom-probe.js`）：
   *    1178×719 的元素盒里放一张 400×300 的图，图实际只占 958×719。
   *    直接量元素盒 ⇒ 选框盖住整块舞台、`naturalWidth / 元素宽` 把缩放算小 19%（裁出来比圈的小）。
   *    所以要按 `object-fit: contain` 的规则**自己算**出图占据的那块，再按元素中心对齐。
   *    旋转 90/270 时，图的那块宽高**对调**（绕元素中心转，元素中心 == 视觉盒中心）。
   *
   * 🔴 ② **交出去的 rect 用「用户看到的图」的像素坐标系**（EXIF 已转正 + 已叠上待保存的旋转/翻转）。
   *    后端先用这条 rect 之外的一串动作把文件写回（方向归一化成 1），再 `.extract()` ——
   *    而 `.extract()` 作用在 rotate 之后，所以 `rect` 直接就是「变换后那张图」的坐标，不用换算式。
   *    换算比例 = 变换后像素尺寸 / 视觉盒尺寸；因为 `contain` 在两个轴上是同一个 s，
   *    这个比例恰好等于 `1 / s`（与旋转与否无关，见 `viewRect()`）。
   */

  var MIN_SIZE = 24; // 选区最小边长（视口像素）

  var session = null;

  function isActive() {
    return !!session;
  }

  /** 选区已确认、正等用户点「保存」/「放弃」。 */
  function isPending() {
    return !!session && !!session.committed;
  }

  /** 已确认的选区（**图片像素**坐标）；没确认过返回 `null`。 */
  function pendingRect() {
    if (!isPending()) return null;
    return { left: session.rect.left, top: session.rect.top, width: session.rect.width, height: session.rect.height };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function isQuarterTurn(angle) {
    var a = (((angle | 0) % 360) + 360) % 360;
    return a === 90 || a === 270;
  }

  /**
   * 量出「图片真正占据的视觉矩形」（视口坐标，含 contain 留白与旋转，不含 zoom 的重复计入）。
   *
   * @param {HTMLImageElement} el
   * @param {number} angle 正在预览态里叠加的旋转角（0/90/180/270）
   * @returns {{left:number, top:number, width:number, height:number, scaleX:number, scaleY:number}|null}
   *          `scaleX/scaleY` 把「视觉 px」换成「变换后图片 px」
   */
  function viewRect(el, angle) {
    if (!el) return null;
    var nw = el.naturalWidth;
    var nh = el.naturalHeight;
    var bw = el.offsetWidth;
    var bh = el.offsetHeight;
    if (!nw || !nh || !bw || !bh) return null;

    // contain 盒（元素局部坐标、未旋转）：宽高比不变，缩放进元素盒内
    var s = Math.min(bw / nw, bh / nh);
    var cw = nw * s;
    var ch = nh * s;

    var rot = isQuarterTurn(angle);
    var vw = rot ? ch : cw;
    var vh = rot ? cw : ch;

    // 元素 AABB：绕元素中心旋转/镜像都不会移动中心 ⇒ 视觉盒与元素盒同心。
    // 顺带从 AABB 反推出「有效缩放」（zoom 是 transform 的一部分，offsetWidth 看不到它）。
    var r = el.getBoundingClientRect();
    var zx = bw ? r.width / (rot ? bh : bw) : 1;
    var zy = bh ? r.height / (rot ? bw : bh) : 1;
    if (!(zx > 0)) zx = 1;
    if (!(zy > 0)) zy = 1;
    vw *= zx;
    vh *= zy;

    // 变换后的图片像素尺寸：旋转 90/270 时宽高对调
    var postW = rot ? nh : nw;
    var postH = rot ? nw : nh;

    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    return {
      left: cx - vw / 2,
      top: cy - vh / 2,
      width: vw,
      height: vh,
      scaleX: postW / vw,
      scaleY: postH / vh,
    };
  }

  function previewAngle() {
    var s = session;
    if (!s) return 0;
    var fn = s.options.getPreviewAngle;
    var a = typeof fn === 'function' ? fn() : 0;
    return a | 0;
  }

  function measure() {
    var s = session;
    if (!s) return false;
    var v = viewRect(s.img, previewAngle());
    if (!v || !(v.width > 0) || !(v.height > 0)) return false;
    s.view = v;
    var layer = s.layer;
    layer.style.left = v.left + 'px';
    layer.style.top = v.top + 'px';
    layer.style.width = v.width + 'px';
    layer.style.height = v.height + 'px';
    return true;
  }

  function paint() {
    var s = session;
    if (!s || !s.view) return;
    var sel = s.sel;
    s.box.style.left = sel.left + 'px';
    s.box.style.top = sel.top + 'px';
    s.box.style.width = sel.width + 'px';
    s.box.style.height = sel.height + 'px';

    // 提示里显示的是**图片像素**尺寸（用户关心的是裁出来多大，不是屏幕上多大）
    var tUi = s.options.tUi || function (k, f) { return f || k; };
    var pw = Math.round(sel.width * s.view.scaleX);
    var ph = Math.round(sel.height * s.view.scaleY);
    var hintKey = s.committed ? 'edit.cropPendingHint' : 'edit.cropHint';
    var hintFallback = s.committed ? '已选好裁剪区域 · 回车保存 / Esc 取消' : '回车确认 / Esc 取消';
    s.hint.textContent = pw + ' × ' + ph + '  ·  ' + tUi(hintKey, hintFallback);
  }

  /** 由**图片像素**的 rect 反推出视觉坐标的 sel（已确认态在窗口尺寸变化后重排用）。 */
  function selFromRect(rect, view) {
    return {
      left: Math.round(rect.left / view.scaleX),
      top: Math.round(rect.top / view.scaleY),
      width: Math.round(rect.width / view.scaleX),
      height: Math.round(rect.height / view.scaleY),
    };
  }

  /**
   * 进入裁剪模式。
   *
   * @param {object} options
   * @param {object} options.dom
   * @param {function} options.getPreviewAngle 返回当前预览态里叠加的旋转角（0/90/180/270）
   * @param {function} options.onCommit 选区确认（**不落盘**）：入参是像素坐标 `{left,top,width,height}`
   * @param {function} [options.tUi]
   * @param {function} [options.onStateChange] 进入/退出时回调（app.js 用来同步工具条）
   * @returns {boolean} 是否成功进入
   */
  function enter(options) {
    options = options || {};
    var dom = options.dom || {};
    var img = dom.previewImage;
    if (!img) return false;
    if (session) return true;

    var layer = document.createElement('div');
    layer.className = 'preview-crop-layer';

    var box = document.createElement('div');
    box.className = 'preview-crop-box';
    var corners = ['nw', 'ne', 'se', 'sw'];
    for (var i = 0; i < corners.length; i++) {
      var h = document.createElement('span');
      h.className = 'preview-crop-handle';
      h.setAttribute('data-corner', corners[i]);
      box.appendChild(h);
    }
    layer.appendChild(box);

    var hint = document.createElement('div');
    hint.className = 'preview-crop-hint';
    layer.appendChild(hint);

    session = {
      layer: layer,
      box: box,
      hint: hint,
      img: img,
      options: options,
      view: null,
      sel: { left: 0, top: 0, width: 0, height: 0 },
      rect: null,
      committed: false,
      drag: null,
      onMove: null,
      onUp: null,
      onKey: null,
      onResize: null,
    };

    document.body.appendChild(layer);
    if (!measure()) {
      // 图还没解码完 / 量不出尺寸 —— 别留一个空的模态层在屏上
      exit();
      return false;
    }

    // 初始选区：居中、占 80%
    var v = session.view;
    var initW = Math.max(MIN_SIZE, Math.round(v.width * 0.8));
    var initH = Math.max(MIN_SIZE, Math.round(v.height * 0.8));
    session.sel = {
      left: Math.round((v.width - initW) / 2),
      top: Math.round((v.height - initH) / 2),
      width: initW,
      height: initH,
    };

    paint();
    bind();

    if (typeof options.onStateChange === 'function') options.onStateChange(true);
    return true;
  }

  function bind() {
    var s = session;
    if (!s) return;

    s.layer.addEventListener('mousedown', function (e) {
      if (s.committed) return;
      var corner = e.target && e.target.getAttribute ? e.target.getAttribute('data-corner') : null;
      var isBox = e.target === s.box;
      if (!corner && !isBox) return;
      e.preventDefault();
      e.stopPropagation();
      s.drag = {
        mode: corner || 'move',
        startX: e.clientX,
        startY: e.clientY,
        from: {
          left: s.sel.left,
          top: s.sel.top,
          width: s.sel.width,
          height: s.sel.height,
        },
      };
      document.addEventListener('mousemove', s.onMove);
      document.addEventListener('mouseup', s.onUp);
    });

    s.onMove = function (e) {
      if (!s.drag) return;
      var d = s.drag;
      var dx = e.clientX - d.startX;
      var dy = e.clientY - d.startY;
      var f = s.view;
      var l = d.from.left;
      var t = d.from.top;
      var w = d.from.width;
      var h = d.from.height;

      if (d.mode === 'move') {
        l = clamp(d.from.left + dx, 0, Math.max(0, f.width - w));
        t = clamp(d.from.top + dy, 0, Math.max(0, f.height - h));
      } else {
        // 四角：改两条边。用「哪条边」而不是「算新中心」，边界条件才写得清。
        var right = d.from.left + d.from.width;
        var bottom = d.from.top + d.from.height;
        if (d.mode.indexOf('w') >= 0) l = clamp(d.from.left + dx, 0, right - MIN_SIZE);
        if (d.mode.indexOf('e') >= 0)
          right = clamp(d.from.left + d.from.width + dx, l + MIN_SIZE, f.width);
        if (d.mode.indexOf('n') >= 0) t = clamp(d.from.top + dy, 0, bottom - MIN_SIZE);
        if (d.mode.indexOf('s') >= 0)
          bottom = clamp(d.from.top + d.from.height + dy, t + MIN_SIZE, f.height);
        w = right - l;
        h = bottom - t;
      }
      s.sel = { left: Math.round(l), top: Math.round(t), width: Math.round(w), height: Math.round(h) };
      paint();
    };

    s.onUp = function () {
      s.drag = null;
      document.removeEventListener('mousemove', s.onMove);
      document.removeEventListener('mouseup', s.onUp);
    };

    s.onKey = null;

    s.onResize = function () {
      if (!session || session !== s) return;
      // 已确认的选区跟着重排（用户已经决定好的东西，丢掉太贵）；
      // 还在拖的选区直接退出（见文件头第 4 条）。
      if (s.committed) {
        // 🔴 重排必须**连 sel 一起按新的换算比例重算**：`sel` 是「视觉坐标」，
        //    窗口一变 visual↔像素的比例就变了，只重画 layer 不动 sel ⇒ 框与裁剪区域对不上，
        //    而且这种错位在保存之前完全看不出来（保存时用的是 rect，不是 sel）。
        if (measure()) {
          s.sel = selFromRect(s.rect, s.view);
          paint();
        }
        return;
      }
      exit();
    };
    window.addEventListener('resize', s.onResize);

    bindKeys();
  }

  function unbind() {
    var s = session;
    if (!s) return;
    if (s.onMove) document.removeEventListener('mousemove', s.onMove);
    if (s.onUp) document.removeEventListener('mouseup', s.onUp);
    if (s.onKey) window.removeEventListener('keydown', s.onKey, true);
    if (s.onResize) window.removeEventListener('resize', s.onResize);
  }

  /** 退出并清理（不提交）。 */
  function exit() {
    var s = session;
    if (!s) return;
    session = null;
    unbind();
    if (s.layer && s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
    if (typeof s.options.onStateChange === 'function') s.options.onStateChange(false);
  }

  /** 把当前选区换算成**图片像素**坐标。 */
  function currentRect() {
    var s = session;
    if (!s || !s.view) return null;
    return {
      left: Math.round(s.sel.left * s.view.scaleX),
      top: Math.round(s.sel.top * s.view.scaleY),
      width: Math.round(s.sel.width * s.view.scaleX),
      height: Math.round(s.sel.height * s.view.scaleY),
    };
  }

  /**
   * 选区确认 —— 🔴 **不落盘、不入库、不调后端**。
   *
   * 只把 rect 记下来、把这一层转成「非模态的预览态」：
   *   · `pointer-events: none` ⇒ 工具条上的「保存 / 放弃」点得到，图片也还能拖拽缩放；
   *   · 摘掉 keydown 监听 ⇒ 预览自己的按键（方向键切图、Esc 关预览）重新生效；
   *   · 遮罩与三分线保留 ⇒ 用户看到的仍然是「将要裁出来的那一块」。
   * 真正的写回在用户点「保存」时（`app.js#savePreviewEdit` → `photo-edit-service#applyEdit`）。
   */
  function commit() {
    var s = session;
    if (!s || s.committed) return;
    var rect = currentRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
    s.rect = rect;
    s.committed = true;
    s.layer.classList.add('is-pending');
    // ⚠️ **不摘 keydown**：已确认态还要靠它接 Esc（退回可调整）。它内部的非模态分支
    //    只接管 Esc，其余键放行（见 `bindKeys()`）。
    paint();
    if (typeof s.options.onCommit === 'function') s.options.onCommit(rect);
  }

  /** 从「已确认」退回「可调整」（Esc 的第一下）。 */
  function resume() {
    var s = session;
    if (!s || !s.committed) return;
    s.committed = false;
    s.rect = null;
    s.layer.classList.remove('is-pending');
    paint();
    if (typeof s.options.onStateChange === 'function') s.options.onStateChange(true);
  }

  function bindKeys() {
    var s = session;
    if (!s || s.onKey) return;
    s.onKey = function (e) {
      if (!session || session !== s) return;
      /**
       * 🔴 通用弹窗打开时必须让路。`showAppDialog` 同样把 keydown 挂在 window **捕获**阶段，
       * 而本监听注册得更早（进裁剪时挂的）⇒ 不让路的话，弹窗的 Esc / 回车会被这里先吃掉，
       * 表现是「弹窗弹出来了、按什么都没反应」——正是 `ui-overlays.js` 里那条
       * 「不许有别的模块也往 window 捕获阶段挂 keydown」警示的后果。
       * 触发场景真实存在：待保存编辑在场时按方向键切图会弹出「放弃未保存的编辑？」。
       */
      var dialog = document.getElementById('appDialogOverlay');
      if (dialog && dialog.classList.contains('show')) return;
      if (s.committed) {
        /**
         * 已确认态**刻意不是模态**：只接管 Esc（退回可调整），其余键一律放行 ——
         * 工具条上的「保存 / 放弃」、`Ctrl+S`、方向键切图都要能用。
         * 🔴 Esc 在这里的含义是「退回可调整」，不是「取消裁剪」：用户刚按下回车确认，
         *    第一下 Esc 若直接整层退出，等于是把「想微调一下」当成「不要了」。
         */
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          resume();
        }
        return;
      }
      // 未确认的裁剪是**模态**的：不让预览自己的键盘处理器（切图 / 关闭）看到任何一个键。
      // 只 stopPropagation、不改默认行为 ⇒ 浏览器/Electron 的快捷键（Ctrl+R 等）照常。
      // 🔴 不这么做的话，按一下方向键 ⇒ 图换了、选框还留在原地（坐标全错且不报错）。
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        exit();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    };
    window.addEventListener('keydown', s.onKey, true);
  }

  global.RendererPreviewCrop = Object.assign({}, global.RendererPreviewCrop || {}, {
    enter: enter,
    exit: exit,
    isActive: isActive,
    isPending: isPending,
    pendingRect: pendingRect,
    currentRect: currentRect,
    viewRect: viewRect,
  });
})(window);
