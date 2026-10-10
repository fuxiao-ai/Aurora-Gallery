(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhotoCompare = factory();
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';

  // Store only bounded metadata; images are created only while the viewer is open.
  function createSelection() {
    var photos = [];
    return {
      list: function () {
        return photos.slice();
      },
      add: function (photo) {
        if (!photo || !Number.isSafeInteger(Number(photo.id)) || Number(photo.id) < 1)
          return 'invalid';
        if (
          photo.media_type === 'video' ||
          /\.(mp4|mov|mkv|avi|webm|m4v|ts|mts|m2ts|wmv|flv|mpg|mpeg|3gp)$/i.test(
            photo.file_name || '',
          )
        )
          return 'video';
        if (
          photos.some(function (p) {
            return p.id === Number(photo.id);
          })
        )
          return 'duplicate';
        if (photos.length >= 4) return 'full';
        photos.push({
          id: Number(photo.id),
          file_name: String(photo.file_name || photo.id),
          width: photo.width,
          height: photo.height,
        });
        return 'added';
      },
      remove: function (id) {
        photos = photos.filter(function (p) {
          return p.id !== Number(id);
        });
      },
      clear: function () {
        photos = [];
      },
    };
  }

  function mount(options) {
    /* 落点优先级（2026-10-09 起）：
       ① `#previewOrgActions` —— 「整理」抽屉（`#previewOrgPanel`）里给对比留的
          **专用空槽**。首选即专用：此前靠「锚点是否落在冲片条内」猜分组，
          而那个判据读的是**别人的排版**（冲片条被删 / 改分区都会让落点漂），
          于是改成「有槽就进槽」。
       ② 没有槽（精简页面 / 旧结构）⇒ 退回「评分之星之后」的老行为 ——
          至少不会 `appendChild` 到 body 上，变成一条没人管的裸按钮。
       用户口径（2026-10-09）：「加入对比和标记功能有点类似，可以放一起」：
       两者都是**挑图**动作（标记 = 要哪些、对比 = 挑 2–4 张并排看），
       与播放/编辑那排工具型操作不是一类。 */
    var slot = document.getElementById('previewOrgActions');
    var anchor = document.getElementById('previewRatingStars');
    if (!slot && !anchor) return;
    var selection = createSelection();
    var words = {
      en: {
        add: 'Add to comparison',
        title: 'Photo comparison',
        open: 'Compare',
        clear: 'Clear',
        close: 'Close',
        remove: 'Remove',
        zoom: 'Linked zoom',
        reset: 'Fit',
        hint: 'Add 2–4 photos from preview. Drag to inspect the same area in every pane.',
        added: 'Added to comparison',
        duplicate: 'Already added',
        full: 'Up to 4 photos. Remove one first.',
        video: 'Comparison supports still images only',
        invalid: 'No photo selected',
        error: 'Image unavailable',
        loading: 'Loading…',
        need: 'Add at least 2 photos',
        empty: 'No photos selected',
      },
      zh: {
        add: '加入对比',
        title: '图片对比',
        open: '开始对比',
        clear: '清空',
        close: '关闭',
        remove: '移除',
        zoom: '同步缩放',
        reset: '适应窗口',
        hint: '从预览中加入 2–4 张图片。拖动图片可同步查看各图相同区域。',
        added: '已加入对比',
        duplicate: '已在对比列表中',
        full: '最多对比 4 张，请先移除一张',
        video: '对比仅支持静态图片',
        invalid: '尚未选择图片',
        error: '图片无法加载',
        loading: '加载中…',
        need: '请至少加入 2 张图片',
        empty: '尚未选择图片',
      },
    };
    function t(key) {
      return words[document.documentElement.lang.indexOf('en') === 0 ? 'en' : 'zh'][key];
    }
    function element(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    function button(text, action) {
      var node = element('button', 'compare-button', text);
      node.type = 'button';
      node.addEventListener('click', action);
      return node;
    }
    var addButton = button(t('add'), function () {
      var result = selection.add(options.currentPhoto());
      renderTray();
      status.textContent = t(result);
      addStatus.textContent = t(result);
    });
    addButton.id = 'photoCompareAdd';
    // 有专用槽 ⇒ `appendChild` 进槽（槽本身就是那一行的容器）；
    // 没有槽 ⇒ 退回「插在之星之后」，与 2026-10-09 之前的落点一致。
    if (slot) slot.appendChild(addButton);
    else anchor.insertAdjacentElement('afterend', addButton);
    var addStatus = element('span', 'compare-add-status');
    addStatus.setAttribute('role', 'status');
    addButton.insertAdjacentElement('afterend', addStatus);
    var tray = element('section', 'compare-tray');
    tray.setAttribute('aria-label', t('title'));
    var items = element('div', 'compare-candidates');
    var status = element('span', 'compare-status');
    status.setAttribute('role', 'status');
    var openButton = button(t('open'), open);
    var clearButton = button(t('clear'), function () {
      selection.clear();
      renderTray();
    });
    tray.append(items, openButton, clearButton, status);
    document.body.appendChild(tray);
    var dialog = element('dialog', 'photo-compare');
    dialog.setAttribute('aria-label', t('title'));
    document.body.appendChild(dialog);
    var grid;
    var zoom = 1;
    var pan = { x: 0, y: 0 };
    var opener;
    var drag;
    function renderTray() {
      items.replaceChildren();
      var photos = selection.list();
      tray.hidden = photos.length === 0;
      openButton.disabled = photos.length < 2;
      openButton.textContent = t('open') + ' (' + photos.length + '/4)';
      clearButton.textContent = t('clear');
      addButton.textContent = t('add');
      status.textContent = photos.length < 2 ? t('need') : '';
      photos.forEach(function (photo) {
        var remove = button(photo.file_name + ' ×', function () {
          selection.remove(photo.id);
          renderTray();
        });
        remove.title = t('remove') + ': ' + photo.file_name;
        remove.setAttribute('aria-label', remove.title);
        items.appendChild(remove);
      });
    }
    function transform() {
      grid.querySelectorAll('img').forEach(function (img) {
        img.style.transform =
          'translate(' + pan.x * 100 + '%, ' + pan.y * 100 + '%) scale(' + zoom + ')';
      });
    }
    function close() {
      dialog.close();
    }
    function open() {
      if (selection.list().length < 2) return;
      opener = document.activeElement;
      if (options.beforeOpen) options.beforeOpen();
      zoom = 1;
      pan = { x: 0, y: 0 };
      dialog.replaceChildren();
      var header = element('header', 'compare-header');
      var title = element('h2', '', t('title'));
      var label = element('label', 'compare-zoom', t('zoom'));
      var range = element('input');
      range.type = 'range';
      range.min = '1';
      range.max = '4';
      range.step = '0.1';
      range.value = '1';
      var value = element('output', '', '1.0×');
      range.addEventListener('input', function () {
        zoom = Number(range.value);
        value.textContent = zoom.toFixed(1) + '×';
        transform();
      });
      label.append(range, value);
      header.append(
        title,
        label,
        button(t('reset'), function () {
          range.value = '1';
          zoom = 1;
          pan = { x: 0, y: 0 };
          value.textContent = '1.0×';
          transform();
        }),
        button(t('close') + ' · Esc', close),
      );
      grid = element('div', 'compare-grid');
      dialog.append(header, element('p', 'compare-hint', t('hint')), grid);
      selection.list().forEach(function (photo) {
        var pane = element('section', 'compare-pane');
        var stage = element('div', 'compare-stage');
        var img = element('img');
        img.alt = photo.file_name;
        img.draggable = false;
        img.decoding = 'async';
        var message = element('span', 'compare-image-status', t('loading'));
        img.onload = function () {
          message.hidden = true;
        };
        img.onerror = function () {
          message.hidden = false;
          message.textContent = t('error');
          img.hidden = true;
        };
        img.src = options.imageUrl(photo);
        stage.append(img, message);
        stage.addEventListener('pointerdown', function (event) {
          if (event.button !== 0 || zoom === 1) return;
          drag = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: pan.x,
            startY: pan.y,
          };
          stage.setPointerCapture(event.pointerId);
        });
        stage.addEventListener('pointermove', function (event) {
          if (!drag || drag.id !== event.pointerId) return;
          pan.x = Math.max(
            -zoom / 2,
            Math.min(
              zoom / 2,
              drag.startX + (event.clientX - drag.x) / Math.max(1, stage.clientWidth),
            ),
          );
          pan.y = Math.max(
            -zoom / 2,
            Math.min(
              zoom / 2,
              drag.startY + (event.clientY - drag.y) / Math.max(1, stage.clientHeight),
            ),
          );
          transform();
        });
        stage.addEventListener('lostpointercapture', function () {
          drag = null;
        });
        var caption = element('footer', 'compare-caption');
        var name = element('span', '', photo.file_name);
        name.title = photo.file_name;
        var dimensions = photo.width && photo.height ? photo.width + ' × ' + photo.height : '';
        caption.append(
          name,
          element('small', '', dimensions),
          button(t('remove'), function () {
            selection.remove(photo.id);
            pane.remove();
            renderTray();
            grid.dataset.count = String(selection.list().length);
            if (selection.list().length < 2) close();
          }),
        );
        pane.append(stage, caption);
        grid.appendChild(pane);
      });
      grid.dataset.count = String(selection.list().length);
      dialog.showModal();
    }
    // Capture before the existing preview hotkeys, including document-level listeners.
    window.addEventListener(
      'keydown',
      function (event) {
        if (!dialog.open) return;
        event.stopImmediatePropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      },
      true,
    );
    dialog.addEventListener('close', function () {
      dialog.querySelectorAll('img').forEach(function (img) {
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
      });
      dialog.replaceChildren();
      drag = null;
      if (opener && opener.isConnected) opener.focus();
    });
    new window.MutationObserver(renderTray).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang'],
    });
    renderTray();
    return { selection: selection, open: open };
  }
  return { createSelection: createSelection, mount: mount };
});
