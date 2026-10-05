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

// Release-declaration lines, e.g. README "Current release: 1.2.0" / "当前发布版本：`1.2.0`"
// / AGENTS.md & CLAUDE.md "**Version**: 1.2.0".
// SEMVER_RE requires a `v` prefix, so bare version numbers in prose slipped through.
// Match the line by keyword, then validate every bare semver on that line.
//
// NOTE: a declaration line may only carry the *current* version. Mentioning a past
// release on the same line (e.g. "当前线：1.2.0（上一版 1.1.0 …）") is reported as drift
// by design -- keep history out of these lines.
const RELEASE_KEYWORD_RE =
  /current release|current version|当前发布版本|当前版本|当前线|当前为|\*\*Version\*\*/i;
const BARE_SEMVER_RE = /\d+\.\d+\.\d+/g;

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

/**
 * Strip HTML comments before scanning.
 *
 * The scan is a bare `/v\d+\.\d+\.\d+/` over the whole file, so a comment that
 * legitimately cites a *third-party* version (e.g. "图标取自 lucide-static
 * v0.544.0 的 settings") was reported as application-version drift. Comments
 * never ship a version to the user, so they must not participate in the check:
 * a guard that reads comments reports phantom drift, and the only way to
 * silence it would be deleting the provenance note.
 *
 * HTML comments do not nest, so the lazy match is exact here.
 */
function stripComments(filePath, content) {
  if (/\.html?$/.test(filePath)) {
    return content.replace(/<!--[\s\S]*?-->/g, '');
  }
  return content;
}

function checkFile(filePath, expectedVersion) {
  const content = stripComments(filePath, fs.readFileSync(filePath, 'utf8'));
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

/**
 * Check release-declaration lines (bare versions without a `v` prefix).
 * Returns [{ line, version, text }] for every declaration that disagrees
 * with the package.json version.
 */
function checkReleaseStatements(filePath, expectedVersion) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const issues = [];
  lines.forEach(function (line, idx) {
    if (!RELEASE_KEYWORD_RE.test(line)) return;
    const found = line.match(BARE_SEMVER_RE);
    if (!found) return;
    for (const m of found) {
      if (m !== expectedVersion) {
        issues.push({ line: idx + 1, version: m, text: line.trim() });
      }
    }
  });
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
      console.error(
        'DRIFT: ' + rel + ' contains ' + issues.join(', ') + ' (expected ' + expected + ')',
      );
      found++;
    }
  }

  // Also check README
  const readmePath = path.join(__dirname, '..', 'README.md');
  if (fs.existsSync(readmePath)) {
    const readmeIssues = checkFile(readmePath, version);
    if (readmeIssues.length > 0) {
      console.error(
        'DRIFT: README.md contains ' + readmeIssues.join(', ') + ' (expected ' + expected + ')',
      );
      found++;
    }
  }

  // Check release declarations (bare version numbers without `v`) in every file that
  // states the shipped version.
  //
  // AGENTS.md / CLAUDE.md are included because CLAUDE.md silently drifted two
  // generations behind (stuck at 1.0.3 while package.json said 1.1.0) and nothing
  // scanned it, so nothing could report it.
  //
  // Deliberately NOT run through checkFile(): both files legitimately contain
  // historical `vX.Y.Z` prose (e.g. "bilingual as of v1.0.3"), which would be
  // reported as drift. Only keyword-marked declaration lines are validated.
  const declarationFiles = ['README.md', 'README.zh-CN.md', 'AGENTS.md', 'CLAUDE.md'];
  for (const name of declarationFiles) {
    const p = path.join(__dirname, '..', name);
    if (!fs.existsSync(p)) continue;
    for (const it of checkReleaseStatements(p, version)) {
      console.error(
        'DRIFT: ' +
          name +
          ':' +
          it.line +
          ' declares ' +
          it.version +
          ' (expected ' +
          expected +
          '): ' +
          it.text,
      );
      found++;
    }
  }

  if (found > 0) {
    console.error('\nFound ' + found + ' file(s) with hard-coded version drift.');
    console.error(
      'Please sync them with package.json version (' + expected + ') or use %VERSION% placeholder.',
    );
    process.exit(1);
  }

  console.log('OK: all hard-coded versions match ' + expected);
  process.exit(0);
}

main();
