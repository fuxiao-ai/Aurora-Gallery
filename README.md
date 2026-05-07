# Aurora Gallery · 拂晓图库

**Language / 语言:** [English](README.md) · [简体中文](README.zh-CN.md)

**Aurora Gallery** is an **Electron**-based, **local-first** photo library app. Media and indexes stay on your machine—suited for tens of thousands to millions of photos (including common RAW formats), with optional LAN browser access and remote tunneling.

|                         |                                                                             |
| ----------------------- | --------------------------------------------------------------------------- |
| **Chinese name**        | 拂晓图库 (UI and installed app name)                                        |
| **English name**        | Aurora Gallery (`package.json` description, installer filenames, repo name) |
| **npm package**         | `aurora-gallery`                                                            |
| **Bundle ID** (`appId`) | `com.foredawn.aurora-gallery`                                               |

**Current release:** `1.0.2` (same as [`package.json`](package.json) `version`; bump before shipping and sync “About” and similar strings).

**Release notes:** see [`CHANGELOG.md`](CHANGELOG.md).

## Features

High-level overview; details follow the in-app **Settings** pages.

### Library & scanning

- **Multiple roots**: maintain several photo root folders under **Album folders**, one unified index and browsing experience.
- **Incremental scans**: detect adds, changes, and removals; **pause / resume / cancel** with visible progress—suited for long runs on large disks.
- **Scan policies**: symlinks, depth, skip rules by folder name, whether to index RAW, etc. (see scan-related options in Settings).
- **Metadata in SQLite**: resolution, capture/modify time, size, paths; common image/video formats and **RAW**-friendly handling.
- **Thumbnails**: generated on first visit or on demand; background **backfill** for missing thumbs with tunable concurrency.

### Desktop browsing & preview

- **Navigation**: sidebar **folder tree**, **by date**, **search** results; works with “All photos / All folders” and related entry points.
- **Preferences** (persisted): default **sort** (capture/modify time, name, size, path, etc.), **scope** (folder only / include subfolders), **page size**, **grid layout** (masonry, fixed height + aspect presets), card size, thumb crop, and more.
- **Favorites & OS integration**: favorites participate in filters; open files or folders in the **system file manager**.
- **Image preview**: zoom, pan, rotate, fullscreen; optional filename/time/size **info bar**.
- **Video preview**: playback controls; **slideshow** (sequential or random); main window close behavior is configurable (see shortcuts help).
- **UI**: multiple **themes** (light/dark and accents); **minimal UI** (hotkeys to hide chrome); **tray**: minimize to background with quick restore/quit.

### Startup & automation (General settings)

- **UI language** (简体中文 / **English**): under **Settings → General**; applies immediately and saves `uiLocale` (`zh-CN` / `en`) in `settings.json`. Updates the window title, tray tooltip, **static** copy (`data-i18n`), and **dynamic** UI: sidebar (folders/dates, favorites, loading states), bottom **stats bar**, Settings management pages (library list, LAN/Tunnel, maintenance tasks, alerts), and related strings. A **top bar** language selector may appear next to the theme control (hidden on very narrow widths; language remains in Settings). Release **1.0.3** documents the full zh/EN pass in [`CHANGELOG.md`](CHANGELOG.md).
- Optional: **scan on startup**, **backfill thumbnails after startup**, **find duplicates after startup** (coordinated with scan tasks).
- **Startup page**: welcome, all photos, all folders, or **last location**.
- **Close button**: title bar / Alt+F4 can ask every time, minimize to tray, or quit (see in-app shortcut help vs tray Quit).

### Filters, duplicates & search

- **Filters**: media type (all / images / videos), dimensions, size, time range, folder scope, favorites, etc.; sidebar counts and “All folders” stay **consistent** with the active filter (empty folders can be hidden).
- **Duplicates**: **hash**-based grouping with a dedicated view.
- **Search**: indexed fields and syntax as shown in the UI.

### Web & remote

- **Built-in web server**: over **HTTP** on the LAN without a separate backend.
- **Security**: optional **access password**; Settings shows server state, local URL, and password status.
- **Parity with desktop**: list/preview alignment—including **all / images / videos**, folder covers, preview transitions, random playback; **mobile**-friendly touch and swipe.
- **Video & subtitles**: sidecar `.vtt` / `.srt` / `.ass`; web preview can toggle subtitles and adjust size/position. Large or special cases may use **HLS** streaming to reduce decode/bandwidth load.
- **Public access (optional)**: **Cloudflare Tunnel** (`cloudflared`); the build can bundle `cloudflared` (see build scripts) or use a binary on `PATH`.

### Maintenance & data

- **Database**: single-file **SQLite** (`photos.db`); **cleanup**, **VACUUM**, **backup**, and related tools (see Settings and “Thumbnails, preview & data”).
- **Background jobs**: thumbnail backfill, duplicate hashing, etc., with progress; **HLS cache** limits to avoid filling the disk.
- **Data location**: per-user app data (dev vs packaged naming differs); do **not** commit `photos.db` to Git.
- **Recommendation**: **back up** `photos.db` before large imports, migrations, or experimental cleanup.

## Requirements

- Windows 10/11, macOS (Apple Silicon / Intel)
- Node.js `>=22.0.0 <23.0.0`
- npm 10+

> Native deps include `better-sqlite3` and `sharp`; rebuild after changing Node/Electron versions.

## Install & run

```bash
npm install
npm run rebuild-native
npm start
```

Development:

```bash
npm run dev
```

## Scripts

- `npm start` — launch desktop app
- `npm run dev` — dev mode
- `npm run rebuild-native` — rebuild native modules (`better-sqlite3`, `sharp`, `onnxruntime-node`)
- `npm run lint` — ESLint
- `npm run format` — Prettier
- `npm run pack` — unpacked dir (`electron-builder --dir`)
- `npm run dist` — installer for current platform (runs `download-cloudflared`)
- `npm run dist:win` — Windows installer (NSIS)
- `npm run dist:mac` — macOS DMG
- `npm run download-cloudflared` — fetch `cloudflared` for packaging or local tunnel
- `npm run smoke:db` — DB smoke test (`scripts/db-smoke.js`)

## Build artifacts

### Windows

```bash
npm install
npm run dist:win
```

Typical outputs (version matches `package.json`, e.g. `1.0.3`):

- Installer: `release/AuroraGallery-Setup-<version>.exe`
- Unpacked: `release/win-unpacked/`

### macOS

```bash
npm install
npm run dist:mac
```

Typical outputs:

- DMG: `release/AuroraGallery-<version>.dmg`
- Unpacked: `release/mac/` or `release/mac-arm64/`

## CI / Automated builds

Push a tag matching `v*` to trigger the GitHub Actions workflow (`.github/workflows/release.yml`). It builds **Windows** (`windows-latest`) and **macOS** (`macos-latest`) in parallel and uploads artifacts to a GitHub Release.

```bash
git tag v1.0.3
git push origin v1.0.3
```

The workflow automatically downloads the correct `cloudflared` binary per platform, rebuilds native modules, runs `electron-builder`, and publishes the installers to the release page.

## Project layout

```text
src/
  main.js                # Electron main entry (orchestrates modules below)
  main/
    ipc-handlers.js      # IPC handlers
    task-scheduler.js    # Background task scheduling
    settings.js          # Settings management
    utils.js             # Main-process utilities
    thumbnail-backfill.js
    duplicate-detection.js
    window-tray.js
    cloudflare-tunnel.js
    logger.js            # Structured logging with level control
  preload.js             # Secure bridge (photoAPI)
  web-server.js          # Built-in web (API, static, video/subtitles/HLS)
  database.js            # SQLite access
  renderer/
    index.html            # Desktop shell
    styles.css
    app.js                # Desktop orchestration
    logger.js             # Renderer-side logging
    api.js
    settings.js
    preview-flow.js
    ui-preview.js
    ui-events.js
    ui-grid.js
    ui-navigation.js
    ui-settings.js
    ui-shell.js
    sidebar-tree.js
    ui-duplicates.js
    scan-flow.js
  web/
    index.html            # Web app shell
    css/style.css         # Extracted web styles
    js/app.js             # Web app logic
    login.html
    vendor/hls.min.js
  scanner.js
  scan-worker.js
  hls-session-manager.js
  hls-attach.js
  playback-strategy.js
```

## Module overview

```text
Desktop (Electron)
renderer/* UI
  -> renderer/api.js
  -> preload.js (photoAPI)
  -> main.js (ipcMain)
  -> database.js / scanner.js / web-server.js

Web (browser)
web/index.html
  -> web-server.js (/api/*, /photo/*, /video/*)
  -> database.js
  -> hls-session-manager.js + playback-strategy.js
```

- Desktop data paths go through `photoAPI` / IPC, not direct DB access from the renderer.
- Web traffic is served by `web-server.js` (API, media, subtitle conversion).
- Playback path (direct vs HLS) is decided in `playback-strategy.js`; HLS sessions in `hls-session-manager.js`.

## Data & config

- App data lives under the current user; do not commit `photos.db`.
- DB file: `photos.db` in the app data directory.
- Settings: managed by the main process.
- Thumbnails: stored in `photos.thumbnail` in the database.

## Development notes

- Run `npm run rebuild-native` before first start to avoid native ABI mismatches.
- `src/renderer/app.js` and `src/main.js` are large—prefer small, focused commits.
- Scanning, hashing, and thumbnail jobs are heavy—watch progress and error paths.

## FAQ

### `ERR_DLOPEN_FAILED`

Usually a native module / Node ABI mismatch:

```bash
npm run rebuild-native
```

If it persists:

```bash
npm install
npm run rebuild-native
```

### Some folders missing after scan

- Confirm roots were added successfully.
- Check whether the scan was paused or cancelled.
- Review skip rules in scan settings.

### Incomplete thumbnails

- Ensure files are indexed.
- Run thumbnail backfill and wait for completion.

## License

MIT
