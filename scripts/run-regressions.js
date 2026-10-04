'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const scripts = process.argv.includes('--benchmark')
  ? ['db-benchmark.js']
  : [
      'db-smoke.js',
      'query-regression.js',
      'worker-pool-regression.js',
      'maintenance-regression.js',
      'maintenance-guard-regression.js',
      'sql-id-list-regression.js',
      'browse-regression.js',
      'compare-regression.js',
      'semantic-regression.js',
      'face-regression.js',
      'people-page-regression.js',
      'search-page-regression.js',
      'match-threshold-regression.js',
      'page-size-control-regression.js',
      'ai-web-views-regression.js',
      'navigation-regression.js',
      'sidebar-tree-regression.js',
      'sidebar-lazy-render-regression.js',
      'ai-sidebar-regression.js',
      'person-rename-api-regression.js',
      'layout-regression.js',
      'css-reference-regression.js',
      'dead-reference-regression.js',
      'check-text-corruption.js',
      'face-task-regression.js',
      'face-concurrency-regression.js',
      'ai-lifecycle-regression.js',
    ];
for (const script of scripts) {
  const result = spawnSync(electron, [path.join(__dirname, script)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error('Regression failed:', script, result.error || result.signal || result.status);
    process.exit(1);
  }
}
