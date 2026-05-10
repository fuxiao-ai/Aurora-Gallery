#!/usr/bin/env node
/**
 * Version consistency check:
 * 1. Read version from package.json
 * 2. Scan src/ for hard-coded semantic versions that don't match
 * 3. Exit with non-zero code if drift is found
 */

const fs = require('fs');
const path = require('path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const SRC_DIR = path.join(__dirname, '..', 'src');

const SEMVER_RE = /v\d+\.\d+\.\d+/g;

function readVersion() {
  const raw = fs.readFileSync(PKG_PATH, 'utf8');
  const pkg = JSON.parse(raw);
  return String(pkg.version || '').trim();
}

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'vendor' || ent.name === 'node_modules') continue;
      yield* walk(full);
    } else if (ent.isFile() && /\.(js|css|html|json|md)$/.test(ent.name)) {
      yield full;
    }
  }
}

function checkFile(filePath, expectedVersion) {
  const content = fs.readFileSync(filePath, 'utf8');
  const matches = content.match(SEMVER_RE);
  if (!matches) return [];
  const issues = [];
  for (const m of matches) {
    if (m !== 'v' + expectedVersion) {
      issues.push(m);
    }
  }
  return issues;
}

function main() {
  const version = readVersion();
  if (!version) {
    console.error('Could not read version from package.json');
    process.exit(1);
  }

  const expected = 'v' + version;
  let found = 0;

  for (const filePath of walk(SRC_DIR)) {
    const issues = checkFile(filePath, version);
    if (issues.length > 0) {
      const rel = path.relative(process.cwd(), filePath);
      console.error('DRIFT: ' + rel + ' contains ' + issues.join(', ') + ' (expected ' + expected + ')');
      found++;
    }
  }

  // Also check README
  const readmePath = path.join(__dirname, '..', 'README.md');
  if (fs.existsSync(readmePath)) {
    const readmeIssues = checkFile(readmePath, version);
    if (readmeIssues.length > 0) {
      console.error('DRIFT: README.md contains ' + readmeIssues.join(', ') + ' (expected ' + expected + ')');
      found++;
    }
  }

  if (found > 0) {
    console.error('\nFound ' + found + ' file(s) with hard-coded version drift.');
    console.error('Please sync them with package.json version (' + expected + ') or use %VERSION% placeholder.');
    process.exit(1);
  }

  console.log('OK: all hard-coded versions match ' + expected);
  process.exit(0);
}

main();
