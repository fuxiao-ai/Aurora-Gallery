# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aurora Gallery (拂晓图库, npm `aurora-gallery`) is a local-first Electron photo library app with a built-in web server for LAN access. It handles large libraries (tens of thousands to millions of photos, including RAW) using SQLite (`better-sqlite3`, WAL mode) with worker threads for scanning and heavy DB reads.

**Version**: 1.3.0 — release version lives in `package.json`; bump before shipping and sync "About" strings.

## Requirements

- Node.js `>=22.0.0 <23.0.0` (`.nvmrc` pins 22)
- npm 10+
- Native deps: `better-sqlite3`, `sharp`, `onnxruntime-node`

## Common Commands

```bash
# First-time setup
npm install
npm run rebuild-native      # Required after Node/Electron version changes

# Development
npm start                   # Launch desktop app
npm run dev                 # Dev mode (`electron . --dev`)

# Code quality
npm run lint                # ESLint (`eslint .`)
npm run format              # Prettier (`prettier -w .`)
npm run smoke:db            # DB smoke test (`scripts/db-smoke.js`)

# Build / dist
npm run pack                # Unpacked dir (`electron-builder --dir`)
npm run dist                # Installer for current platform (downloads cloudflared)
npm run dist:win            # Windows NSIS installer
npm run dist:mac            # macOS DMG
npm run download-cloudflared # Fetch cloudflared binary for packaging/tunneling
npm run bundle-models       # Build bundled AI models into models/ (face + search) for packaging
```

**Automated checks**: `npm test` runs the full regression suite (`scripts/run-regressions.js`, 41 scripts) in the Electron runtime; `npm run smoke:db` runs just the database smoke. `npm run lint` must stay at **0 errors** before shipping — see `AGENTS.md` for the per-directory breakdown.

## High-Level Architecture

### Dual-Runtime Architecture

The codebase serves two runtimes from the same source:

1. **Desktop (Electron)**: Renderer UI → `preload.js` (`photoAPI`) → main process (`ipcMain`) → `database.js` / `scanner.js` / `web-server.js`
2. **Web (Browser)**: Static pages served by `web-server.js` → API routes (`/api/*`) → `database.js` directly

This means **data access paths differ by runtime**: desktop goes through IPC; web hits the HTTP API directly. Changes to `database.js` affect both; changes to IPC handlers or `photoAPI` only affect desktop.

### Concurrency Model

- **Renderer process**: UI and interaction only
- **Main process**: IPC dispatch, task scheduling, window/tray management
- **Worker threads**: `scan-worker.js` (file scanning), `db-read-worker.js` (heavy DB reads)
- **SQLite**: WAL mode with batched transactions during scanning to minimize lock contention

Task states (scan, thumbnail backfill, duplicate hashing) are maintained in the main process and polled/broadcast to the renderer.

### ❗ Critical: Main Thread Blocking Issues

Long-running CPU/SQL tasks **must not block the main event loop**:

- Long-running maintenance tasks (thumbnail backfill, duplicate detection, cleanup) **must run asynchronously** with frequent yielding
- `yieldForPreviewPlaybackMs(ms)` must be called between batches to let UI update
- `yieldForPreviewPlaybackMs` **always yield**, the `previewPlaybackActive` check was a bug that caused deadlocks
- Large SQL queries without proper indexes will block the main thread for dozens of seconds on big databases
- Always use **setTimeout + immediate return** from IPC handlers for tasks that take more than a few seconds

### Database Indexing

For performance-critical queries on large tables:

- `photos` table has indexes on common query patterns
- `idx_photos_id_hasThumb` on `(id, has_thumbnail)` accelerates thumbnail backfill
- Partial indexes exist for duplicate hash detection (only indexes photos that need hashing)
- Adding a new index for frequently queried patterns beats complex query refactoring

### Media Serving Pipeline

Video playback routing is non-trivial:

- `playback-strategy.js` decides direct file serve vs HLS transcode
- `hls-session-manager.js` manages HLS sessions and cache limits
- `web-server.js` serves `/api/video-playback`, `/api/video-subtitle` (converting `.srt`/`.ass` to VTT)

### i18n

Fully bilingual (zh-CN / en) as of v1.0.3. Locale key is `uiLocale` (`zh-CN` or `en`) stored in settings. `src/renderer/i18n.js` handles both static `data-i18n` attributes and dynamic UI strings. The web app has its own i18n implementation in `src/web/js/app.js`.

## Code Organization Notes

### Refactoring in Progress

`src/renderer/app.js` (~5400 lines) and `src/main.js` (~3900 lines) are acknowledged technical debt. Part of `main.js` has been split into `src/main/*.js`, but **check actual imports before assuming a module is connected to the runtime** — a module that nothing `require`s is dead code that will silently diverge.

**2026-10-05 — the `src/main/*.js` orphan chain was removed (T6).** Nine files (`ipc-handlers.js`, `task-scheduler.js`, `thumbnail-backfill.js`, `settings.js`, `window-tray.js`, `duplicate-detection.js`, `dhash-backfill.js`, `cloudflare-tunnel.js`, `utils.js`) only required each other and were never reached from `main.js`; ~3100 lines deleted. Their logic had been duplicated inside `main.js` (e.g. `createDefaultSettings`, the thumbnail-backfill loop in `runRowsWithThumbConcurrency`) and the copies had **drifted** — most seriously, the `width`/`height` backfill contract that `database.js#_sqlBackfillPendingExpr()` depends on existed *only* in the dead `thumbnail-backfill.js`, so the live backfill never wrote dimensions and its candidate set could never converge. That logic has been ported into `main.js`; see `scripts/photo-metadata-backfill-regression.js`. `src/main/` now holds only reachable modules (`ai-index-gate`, `browse-requests`, `database-maintenance`, `db-write-queue`, `face-service`, `interaction-preempt`, `logger`, `maintenance-guard`, `perceptual-hash`, `semantic-search`, `semantic-tags`, `similar-detection`, `sql-id-list`, `startup-metrics`).

🔴 **Do not add unreachable modules under `src/main/`.** `scripts/module-reachability-regression.js` asserts every `.js` there is statically reachable from `src/main.js` / `src/preload.js`. If you split code out, wire it up in the same commit. General rule this cost us: **a regression that pins a dead file is a false green** — before asserting "this contract is implemented", confirm the file under test is actually `require`d.

`src/renderer/modules/*.js` was removed (orphaned dead code). When editing the large files, prefer small, focused changes. When adding new features, use the modular locations that are actually wired up.

### IPC Boundary

`src/preload.js` exposes `photoAPI` via `contextBridge`. This is the **only** bridge between renderer and main process. Desktop renderer code never accesses `database.js` or `scanner.js` directly — it always goes through `renderer/api.js` → `photoAPI`.

### Common IPC Patterns

For IPC handlers:

- Quick queries (settings, stats) can be handled synchronously and return directly
- Long-running background tasks must:
  1. Check if already running → reject if busy
  2. Initialize task state
  3. `setTimeout(() => { ... })` to run the actual work
  4. **Immediately return success response** to renderer
  5. Let renderer poll progress via IPC

### Web App Structure

The web app (`src/web/`) is served as static assets by `web-server.js`:

- `src/web/index.html` — page shell with the main styles inline
- `src/web/js/app.js` — web app logic
- `src/web/js/ai-views.js` — 「搜图 / 人物」adapter: the file-bar tabs own the entry and results
  are rendered into the shared `#photoGrid`, so preview / slideshow / favorite / selection are reused
- `src/web/css/` — stylesheets (`gallery-design.css`, `photo-compare.css`, `ai-web-views.css`);
  `semantic-search.css` / `people.css` are now loaded only by the desktop renderer, for its
  AI settings panels (`settingsOnly` mode)

The web app shares API parity with desktop (filters, preview, slideshow, mobile touch).

### AI Views (搜图 / 人物)

Both runtimes render these two views into the shared `#photoGrid`, so the whole browse chain
(preview paging, slideshow, favorite, selection, card size) is reused rather than re-implemented.
Only the entry point and the toolbar differ by runtime:

- **Desktop**: the left icon rail carries 「搜图 / 人物」 next to 「重复」. Entering one swaps the
  toolbar to the AI search box / back button / status slot (`src/renderer/ai-views.js` +
  `ai-views.css`, wired from `app.js` via `showTabContent`).
- **Web**: the folder-bar tabs carry them (`src/web/js/ai-views.js` + `css/ai-web-views.css`).

The sidebar is deliberately **not** blanked out: the folder tree stays visible so the user can
keep switching directories, and the person view additionally keeps its two sidebar shortcuts.
Both adapters collapse the preview window to a single page (`previewTotalPages = 1`) so paging
only slices the result set instead of re-querying the browse list. Leaving the view via the
sidebar (folder / date) must go through `leaveAiViewForBrowse` (desktop) /
`leaveWebAiViewForBrowse` (web) — those paths bypass `showTabContent` / `switchTab`.

## ESLint Configuration

`eslint.config.js` uses `@eslint/js` recommended rules with project-specific relaxations:

- `no-var: off` (var is allowed)
- `no-unused-vars: warn` with `^_` ignore pattern for intentionally unused args/vars
- `no-empty: allowEmptyCatch`
- Globals are split between Node/CommonJS (`src/**/*.js`, `scripts/**/*.js`) and Browser (`src/renderer/**/*.js`, `src/web/**/*.js`, `src/hls-attach.js`, `src/playback-strategy.js`)
- Additional browser globals declared: `requestIdleCallback`, `confirm`, `appAlert`, `appConfirm`, `Logger`, `RendererFacesUI`, `api`, `formatNumber`
- Ignored: `.workbuddy/**` (tool workspace — memory/docs plus throwaway debug scripts under `.workbuddy/artifacts/`; they are not product code and used to turn `npm run lint` permanently red)

Current status: **0 errors, 2 warnings** (both in `src/web/js/app.js`: `changeWebOpacity` / `changeWebTexture` are invoked from HTML `onchange` so static analysis cannot see the use — do not "fix" them). The baseline dropped from 7 to 2 when T6 deleted the orphan chain. `npm run lint` (`eslint .`) and `npx eslint src scripts` report the identical result.

## Logging

Both main process and renderer have structured loggers with level control:

- **Main process**: `src/main/logger.js`
  - Default level: `warn` in production, `log` in dev
  - Override: `LOG_LEVEL=debug npm start`
  - Usage: `const logger = require('./main/logger'); logger.error(...); logger.warn(...); logger.info(...); logger.log(...); logger.debug(...)`

- **Renderer**: `src/renderer/logger.js` (loaded via `<script src="logger.js">` before other scripts)
  - Default level: `warn` in production, `log` in dev
  - Override: `localStorage.setItem('photoManager.logLevel', 'debug')`
  - Usage: `Logger.error(...); Logger.warn(...); Logger.info(...); Logger.log(...); Logger.debug(...)`

Replace raw `console.log/error/warn` with `logger.*` / `Logger.*` in new code.

## Data & Config

- **DB file**: `photos.db` in user app data directory (dev vs packaged naming differs)
- **Thumbnails**: stored in `photos.thumbnail` table
- **Settings**: managed by main process, persisted to settings file
- **Do not commit `photos.db`**
- **Back up `photos.db`** before large imports, migrations, or experimental cleanup

## Common Gotchas & Debugging

1. **UI freezes after clicking button** → the IPC handler is waiting for the entire task to complete before returning. Fix: make it async with `setTimeout` and return immediately.

2. **First query of a batch takes 10+ seconds** → missing index. Check the query `WHERE` clause and add an appropriate composite index.

3. **Yielding doesn't unblock UI** → `yieldForPreviewPlaybackMs` wasn't actually yielding because it only yields when `previewPlaybackActive` is true. Fix: always yield.

4. **Thumbnail backfill counting takes a minute** → `getMissingThumbnailCount()` requires a full table scan. Fix: stream instead of pre-counting, let total accumulate incrementally.
