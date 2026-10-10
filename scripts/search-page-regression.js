'use strict';
// Controller lifecycle checks for the AI-search page surface (left rail「搜图」).
// This is a fake-DOM controller test; it does not test browser layout.
const assert = require('node:assert/strict');
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get childElementCount() {
    return this.children.length;
  }
  append(...items) {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  appendChild(item) {
    this.append(item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  removeAttribute(name) {
    delete this[name];
  }
  insertAdjacentElement(_where, item) {
    this.parent.append(item);
  }
  focus() {}
  // A page surface is a <section>, never a modal <dialog>: calling either of these
  // means the page mode regressed into dialog mode.
  close() {
    throw new Error('close() must not be called on the search page surface');
  }
  showModal() {
    throw new Error('showModal() must not be called on the search page surface');
  }
  find(text) {
    return this.children
      .flatMap((item) => [item, ...item.all()])
      .find((item) => item.textContent === text);
  }
  all() {
    return this.children.flatMap((item) => [item, ...item.all()]);
  }
}
const body = new Element('body'),
  container = new Element('main');
body.append(container);
global.document = {
  body,
  documentElement: { lang: 'en' },
  createElement: (tag) => new Element(tag),
  getElementById: () => null,
};
global.window = {
  addEventListener() {},
  MutationObserver: class {
    observe() {}
  },
};
require('../src/web/js/semantic-search');
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  let active = true,
    previewed = false;
  const page = global.window.SemanticSearchUI.mount({
    manage: true,
    page: true,
    container,
    isActive: () => active,
    call: async (operation) => {
      if (operation === 'status') return { ready: true, indexed: 4, running: false, phase: 'complete' };
      if (operation === 'query') return { photos: [{ id: 7, file_name: 'hit.jpg' }] };
      throw Error(operation);
    },
    thumbnail: (photo) => 'thumb://' + photo.id,
    preview: () => {
      previewed = true;
    },
  });
  try {
    page.show();
    await settle();
    const view = container.children[0];
    assert.equal(view.tag, 'section', 'page mode renders an embedded section, not a modal');
    assert.equal(view.id, 'searchPage', 'page surface keeps the #searchPage id used by CSS');
    assert.equal(
      body.children.length,
      1,
      'page mode must not inject the legacy topbar entry button',
    );
    assert.equal(
      body.children.find((item) => item.id === 'semanticSearchButton'),
      undefined,
      'no redundant #semanticSearchButton when the rail owns the entry',
    );
    assert.equal(view.hidden, false, 'show() reveals the page');

    const form = view.all().find((item) => item.tag === 'form');
    assert.ok(form, 'page mode keeps the query form');
    const input = view.all().find((item) => item.tag === 'input');
    assert.ok(input, 'page mode keeps the query input');
    // 页面上只留搜索本身：设置项与说明都应留在左栏「设置」里。
    assert.equal(
      view.find('Model and index settings'),
      undefined,
      'page mode keeps no settings entry',
    );
    assert.equal(view.find('Build / update index'), undefined, 'page mode keeps no index controls');
    assert.equal(view.find('Stop task'), undefined, 'page mode keeps no task controls');

    input.value = 'a beach at sunset';
    form.listeners.submit({ preventDefault() {} });
    await settle();
    const hit = view.find('hit.jpg');
    assert.ok(hit, 'page mode renders query results inline');
    hit.parent.listeners.click();
    assert.equal(previewed, true, 'result click opens preview');
    assert.equal(view.hidden, false, 'preview retains the underlying search page');

    active = false;
    page.hide();
    assert.equal(view.hidden, true, 'hide() hides the page when the tab is left');
  } finally {
    page.hide();
  }
  console.log('[search-page-regression] PASS');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
