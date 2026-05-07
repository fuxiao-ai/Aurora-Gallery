# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aurora Gallery (拂晓图库, npm `aurora-gallery`) is a local-first Electron photo library app with a built-in web server for LAN access. It handles large libraries (tens of thousands to millions of photos, including RAW) using SQLite (`better-sqlite3`, WAL mode) with worker threads for scanning and heavy DB reads.

**Version**: 1.0.3 — release version lives in `package.json`; bump before shipping and sync "About" strings.

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
```

**No test suite exists.** The only automated check is `npm run smoke:db`.

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

`src/renderer/app.js` (~5400 lines) and `src/main.js` (~3800 lines) are acknowledged technical debt. `main.js` has already been modularized into `src/main/*.js` (IPC handlers, task scheduler, settings, utilities, logging). `src/renderer/modules/*.js` was removed (orphaned dead code).

When editing these large files, prefer small, focused changes. When adding new features, use the new modular locations.

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

The web app (`src/web/`) was recently refactored from inline scripts/styles into:

- `src/web/js/app.js` — web app logic
- `src/web/css/style.css` — extracted styles

The web app shares API parity with desktop (filters, preview, slideshow, mobile touch) but is served as static assets by `web-server.js`.

## ESLint Configuration

`eslint.config.js` uses `@eslint/js` recommended rules with project-specific relaxations:

- `no-var: off` (var is allowed)
- `no-unused-vars: warn` with `^_` ignore pattern for intentionally unused args/vars
- `no-empty: allowEmptyCatch`
- Globals are split between Node/CommonJS (`src/**/*.js`, `scripts/**/*.js`) and Browser (`src/renderer/**/*.js`, `src/web/**/*.js`, `src/hls-attach.js`, `src/playback-strategy.js`)
- Additional browser globals declared: `requestIdleCallback`, `confirm`, `appAlert`, `appConfirm`, `Logger`, `RendererFacesUI`, `api`, `formatNumber`

Current status: **0 errors, 6 warnings** (all unused-variable warnings for reserved callbacks/imports).

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
