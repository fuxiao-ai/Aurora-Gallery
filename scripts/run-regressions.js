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
      'bundled-models-regression.js',
      'page-size-control-regression.js',
      'browse-grid-style-regression.js',
      'photo-info-fields-regression.js',
      'photo-tags-regression.js',
      'photo-metadata-backfill-regression.js',
      'thumbnail-spec-regression.js',
      'db-write-serialization-regression.js',
      'db-write-priority-regression.js',
      'scan-queue-regression.js',
      'media-library-refresh-regression.js',
      'interaction-preempt-regression.js',
      'ai-index-gate-regression.js',
      'startup-write-order-regression.js',
      'module-reachability-regression.js',
      'ai-web-views-regression.js',
      'navigation-regression.js',
      'sidebar-tree-regression.js',
      'sidebar-lazy-render-regression.js',
      'path-bar-regression.js',
      'nav-history-regression.js',
      'ai-sidebar-regression.js',
      'person-rename-api-regression.js',
      'layout-regression.js',
      'control-styles-regression.js',
      'theme-regression.js',
      'css-reference-regression.js',
      'dead-reference-regression.js',
      'web-asset-route-regression.js',
      'home-page-regression.js',
      'shortcut-contract-regression.js',
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
