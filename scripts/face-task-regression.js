'use strict';
const assert = require('node:assert/strict');
const nodes = new Map();
function node(id) {
  if (!nodes.has(id))
    nodes.set(id, {
      style: {},
      textContent: '',
      removeAttribute(key) {
        delete this[key];
      },
    });
  return nodes.get(id);
}
global.window = {};
global.document = { documentElement: { lang: 'en' }, getElementById: node };
require('../src/renderer/scan-flow');
const panel = node('panel');
function render(face, rest = {}) {
  return global.window.RendererScanFlow.renderBackgroundTaskPanel({
    state: {},
    dom: { scanProgress: panel },
    tasks: { face, ...rest },
  });
}
assert.equal(
  render({
    busy: true,
    phase: 'indexing',
    processed: 120,
    failed: 2,
    skipped: 3,
    ratePerMinute: 60,
    currentFile: '<photo>.jpg',
  }),
  true,
);
assert.equal(panel.style.display, 'block');
assert.equal(node('taskFaceSection').style.display, 'block');
assert.match(node('faceTaskCount').textContent, /120.*2.*3/);
assert.equal(node('faceTaskFile').textContent, '<photo>.jpg');
assert.match(node('faceTaskRate').textContent, /60 photos/);
assert.equal(node('faceTaskProgress').value, undefined);
render({ busy: true, phase: 'downloading', file: 'yunet.onnx', percent: 45 });
assert.equal(node('faceTaskProgress').value, 45);
render({ busy: true, phase: 'stopping' });
assert.equal(node('faceTaskStop').disabled, true);
assert.equal(render({ busy: false, phase: 'complete' }), false);
assert.equal(node('taskFaceSection').style.display, 'none');
assert.equal(render({ busy: true, phase: 'groups' }), false, 'browsing is not an index task');
assert.equal(
  render({ busy: false }, { thumbs: { running: true } }),
  true,
  'other tasks remain visible',
);
console.log('[face-task-regression] PASS');
assert.equal(
  render(
    {},
    {
      semantic: {
        busy: true,
        operation: 'index',
        phase: 'indexing',
        processed: 12,
        ratePerMinute: 30,
      },
    },
  ),
  true,
);
assert.equal(node('taskSemanticSection').style.display, 'block');
assert.match(node('semanticTaskCount').textContent, /12/);
assert.equal(
  render({}, { semantic: { busy: true, operation: 'search', phase: 'loading' } }),
  false,
  'query model loading is not index work',
);
render(
  {},
  {
    semantic: {
      busy: true,
      operation: 'install',
      phase: 'downloading',
      file: 'model.onnx',
      percent: 32,
    },
  },
);
assert.equal(node('semanticTaskProgress').value, 32);
