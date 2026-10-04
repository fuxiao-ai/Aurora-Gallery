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
const anchor = new TestNode('button');
body.append(anchor);
global.document = {
  body,
  documentElement: { lang: 'en' },
  activeElement: anchor,
  createElement: (tag) => new TestNode(tag),
  getElementById: () => anchor,
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
const add = body.children.find((node) => node.id === 'photoCompareAdd');
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
delete global.document;
delete global.window;
console.log('[compare-regression] PASS');
