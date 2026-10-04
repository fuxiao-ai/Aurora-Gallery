'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const requests = require('../src/main/browse-requests');
const { createStartupMetrics } = require('../src/main/startup-metrics');

function extractFunction(source, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

async function run() {
  const sender = new EventEmitter();
  sender.id = 1;
  const other = new EventEmitter();
  other.id = 2;
  requests.begin(sender, 1);
  requests.begin(other, 1);
  const old = requests.control(sender, { browseRequestId: 1 });
  requests.begin(sender, 2);
  assert.equal(old.signal.aborted, true);
  assert.equal(requests.control(other, { browseRequestId: 1 }).signal.aborted, false);
  assert.throws(() => requests.control(sender, { browseRequestId: 1 }), /cancelled/);
  sender.emit('did-start-navigation', {}, 'file://fixture', false, true);
  requests.begin(sender, 1);
  assert.equal(requests.control(sender, { browseRequestId: 1 }).signal.aborted, false);
  const closed = requests.control(sender, { browseRequestId: 1 });
  sender.emit('destroyed');
  other.emit('destroyed');
  assert.equal(closed.signal.aborted, true);

  // Exercise production loading functions with delayed responses, without opening a browser.
  const source = fs.readFileSync(path.join(__dirname, '../src/web/js/app.js'), 'utf8');
  const pending = [];
  let rendered;
  const context = {
    AbortController,
    encodeURIComponent,
    console,
    activePhotoRequest: null,
    state: { photosRequestSeq: 0, page: 1, pageSize: 100, mediaFilter: 'all' },
    showSkeleton() {},
    renderPagination() {},
    setDisplay() {},
    renderFolderCoverGrid(covers) {
      rendered = covers;
    },
    $() {
      return { innerHTML: '' };
    },
    apiGet(url, signal) {
      return new Promise((resolve, reject) => pending.push({ url, signal, resolve, reject }));
    },
  };
  vm.createContext(context);
  for (const name of ['beginPhotoRequest', 'loadFolderCovers']) {
    vm.runInContext(extractFunction(source, name), context);
  }
  const first = context.loadFolderCovers();
  const latest = context.loadFolderCovers();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ covers: [{ id: 2 }], page: 1, total: 1, totalPages: 1 });
  await latest;
  pending[0].resolve({ covers: [{ id: 1 }], page: 1, total: 1, totalPages: 1 });
  await first;
  assert.equal(rendered[0].id, 2, 'late response cannot overwrite latest folders');
  const failedOld = context.loadFolderCovers();
  const next = context.loadFolderCovers();
  pending[3].resolve({ covers: [{ id: 4 }], page: 1, total: 1, totalPages: 1 });
  await next;
  pending[2].reject(new Error('late failure'));
  await failedOld;
  assert.equal(context.state.folderCovers[0].id, 4);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-metrics-test-'));
  const metrics = createStartupMetrics();
  try {
    const output = path.join(directory, 'startup.json');
    metrics.setOutput(output);
    metrics.mark('first-stage');
    metrics.mark('second-stage');
    await metrics.stop();
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.stages.length, 2);
    assert.ok(report.stages[1].elapsedMs >= report.stages[0].elapsedMs);
    assert.ok(report.stages[1].rssMb > 0);
  } finally {
    await metrics.stop();
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
  console.log('[browse-regression] PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
