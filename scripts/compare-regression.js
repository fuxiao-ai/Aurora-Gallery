'use strict';
const assert = require('node:assert/strict');
const { createSelection } = require('../src/web/js/photo-compare');
const selection = createSelection();
assert.equal(selection.add(null), 'invalid');
assert.equal(selection.add({ id: 0 }), 'invalid');
assert.equal(selection.add({ id: 1, file_name: 'clip.MOV' }), 'video');
assert.equal(selection.add({ id: 1, media_type: 'video' }), 'video');
assert.equal(selection.add({ id: 1, file_name: '<b>image</b>.jpg' }), 'added');
assert.equal(selection.add({ id: '1' }), 'duplicate');
for (let id = 2; id <= 4; id++) assert.equal(selection.add({ id }), 'added');
assert.equal(selection.add({ id: 5 }), 'full');
selection.list().pop();
assert.equal(selection.list().length, 4);
selection.remove('2');
assert.equal(selection.add({ id: 5 }), 'added');
assert.deepEqual(
  selection.list().map((photo) => photo.id),
  [1, 3, 4, 5],
);
selection.clear();
assert.equal(selection.list().length, 0);
// Exercise the real UI controller against a DOM test double. This is not a visual test.
class TestNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.isConnected = true;
    this.clientWidth = 400;
    this.clientHeight = 300;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(key, value) {
    this[key] = value;
  }
  removeAttribute(key) {
    delete this[key];
  }
  addEventListener(name, callback) {
    (this.listeners[name] ||= []).push(callback);
  }
  emit(name, event = {}) {
    for (const callback of this.listeners[name] || []) callback(event);
  }
  insertAdjacentElement(_position, node) {
    this.parentNode.append(node);
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.emit('close');
  }
  focus() {
    global.document.activeElement = this;
  }
  setPointerCapture() {}
  remove() {
    this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
  }
}
const body = new TestNode('body');
const ratingStars = new TestNode('div');
const orgActions = new TestNode('div');
ratingStars.id = 'previewRatingStars';
orgActions.id = 'previewOrgActions';
/* 桩要按**真实结构**搭，而且 `getElementById` 必须**逐 id 返回不同节点**。
   2026-10-09 起「加入对比」的首选落点是「整理」抽屉（`#previewOrgPanel`）里
   给对比留的**专用空槽** `#previewOrgActions`（用户口径「加入对比和标记功能
   有点类似，可以放一起」）；槽不存在才退回「插在 `#previewRatingStars` 之后」。
   ⚠️ 旧桩对每个 id 都返回同一个节点 —— 那样「进了槽」与「插在之星之后」
   分不出来，落点断言会**恒真**（假绿）。 */
const idMap = { previewOrgActions: orgActions, previewRatingStars: ratingStars };
global.document = {
  body,
  documentElement: { lang: 'en' },
  activeElement: ratingStars,
  createElement: (tag) => new TestNode(tag),
  getElementById: (id) => idMap[id] || null,
};
global.window = new TestNode('window');
global.window.MutationObserver = class {
  observe() {}
};
let current = { id: 10, file_name: '<script>photo.jpg', width: 600, height: 400 };
let paused = 0;
const viewer = require('../src/web/js/photo-compare').mount({
  currentPhoto: () => current,
  imageUrl: (photo) => '/photo/' + photo.id,
  beforeOpen: () => paused++,
});
const add = orgActions.children.find((node) => node.id === 'photoCompareAdd');
/* 落点断言（首选路径）：`#previewOrgActions` 存在 ⇒ 按钮必须进**那个槽**，
   且槽里是「按钮 → 状态文字」的顺序。
   只测「没有槽」那条旧路径，等于新分组没人守。 */
assert.ok(
  add,
  '「加入对比」必须落进 #previewOrgActions（抽屉里给对比留的专用空槽）',
);
assert.equal(add.parentNode, orgActions, '落点的父节点必须就是那个槽，不是槽的兄弟');
assert.equal(add.className, 'compare-button', '槽里那份按钮带的是抽屉内那套皮肤');
assert.deepEqual(
  orgActions.children.map((node) => node.id || node.className),
  ['photoCompareAdd', 'compare-add-status'],
  '槽里应当依次是「加入对比」与它的状态文字 —— 顺序错了会把状态显示到按钮前面',
);
assert.equal(
  orgActions.children[1].role,
  'status',
  '状态文字要带 role=status（读屏才播报）',
);
add.emit('click');
viewer.open();
assert.equal(paused, 0, 'cannot open a one-photo comparison');
current = { id: 11, file_name: 'second.jpg' };
add.emit('click');
viewer.open();
const dialog = body.children.find((node) => node.tagName === 'dialog');
assert.equal(dialog.open, true);
assert.equal(paused, 1);
const images = dialog.querySelectorAll('img');
assert.equal(images.length, 2);
assert.equal(images[0].alt, '<script>photo.jpg', 'filenames stay text');
assert.equal(images[1].src, '/photo/11');
const range = dialog.querySelectorAll('input')[0];
range.value = '2';
range.emit('input');
assert.ok(images.every((img) => img.style.transform.includes('scale(2)')));
const stage = images[0].parentNode;
stage.emit('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
stage.emit('pointermove', { pointerId: 1, clientX: 40, clientY: 30 });
assert.equal(images[0].style.transform, images[1].style.transform);
assert.ok(images[0].style.transform.includes('10%, 10%'));
images[0].onerror();
assert.equal(images[0].hidden, true);
assert.equal(stage.children[1].textContent, 'Image unavailable');
let prevented = false;
global.window.emit('keydown', {
  key: 'Escape',
  stopImmediatePropagation() {},
  preventDefault() {
    prevented = true;
  },
});
assert.equal(prevented, true);
assert.equal(dialog.open, false);
assert.equal(dialog.children.length, 0);
assert.ok(
  images.every((img) => !img.src),
  'closing releases image sources',
);
assert.equal(viewer.selection.list().length, 2, 'closing retains candidates');
/* ---------- 落点用例 B：**没有**专用槽时，退回「插在 #previewRatingStars 之后」 ----------
   这一条钉的是「降级路径不许静默不挂」：`mount()` 里的 `if (!slot && !anchor) return;`
   万一将来被写错（比如只看槽、不认之星），按钮会在精简页面里彻底消失，
   而主用例全绿 —— 那正是最难发现的一种失效。
   用一份**独立**的 DOM 桩跑，绝不污染上面主用例的 `body`。 */
{
  const savedDoc = global.document;
  const savedWin = global.window;
  const fallbackBody = new TestNode('body');
  const fallbackStars = new TestNode('div');
  fallbackStars.id = 'previewRatingStars';
  fallbackBody.append(fallbackStars);
  global.document = {
    body: fallbackBody,
    documentElement: { lang: 'en' },
    activeElement: fallbackStars,
    createElement: (tag) => new TestNode(tag),
    // 只认之星：`#previewOrgActions` 返回 null ⇒ 走降级路径
    getElementById: (id) => (id === 'previewRatingStars' ? fallbackStars : null),
  };
  global.window = new TestNode('window');
  global.window.MutationObserver = class {
    observe() {}
  };
  // `require` 有缓存 ⇒ 拿到的就是主用例那个同一份模块对象。
  require('../src/web/js/photo-compare').mount({
    currentPhoto: () => ({ id: 21, file_name: 'fallback.jpg' }),
    imageUrl: (photo) => '/photo/' + photo.id,
    beforeOpen: () => {},
  });
  // 桩的 `insertAdjacentElement` 把新节点 append 到 `this.parentNode` 上，
  // 而 `fallbackStars.parentNode` 就是 fallbackBody ⇒ 前三个的顺序可断言
  //（后面两个是托盘 / 对比弹窗，由 `document.body.appendChild` 挂上来的）。
  assert.deepEqual(
    fallbackBody.children.slice(0, 3).map((node) => node.id || node.className),
    ['previewRatingStars', 'photoCompareAdd', 'compare-add-status'],
    '没有专用槽时必须退回「插在 #previewRatingStars 之后」，不许静默不挂',
  );
  assert.ok(
    fallbackBody.children.length > 3,
    '降级路径也要把托盘 / 对比弹窗挂上 —— 只挂上按钮说明 mount 中途退出了',
  );
  global.document = savedDoc;
  global.window = savedWin;
}

delete global.document;
delete global.window;
console.log('[compare-regression] PASS');
