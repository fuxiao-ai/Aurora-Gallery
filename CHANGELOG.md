# Changelog

All notable changes to **Aurora Gallery / 拂晓图库** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Release versions match the root [`package.json`](package.json) `version` field.

## [Unreleased]

### Planned

详见 [`docs/RELEASE_PLAN.md`](docs/RELEASE_PLAN.md)。

- **1.1.0**（进行中）：P1 性能与体验 — 大图库性能埋点、预览体验增强、管理页紧凑布局。
- **1.2.0**（架构重构）：`main.js` / `renderer/app.js` 模块化拆分，降低维护成本。
- **1.3.0**（功能增强）：Web 侧能力补齐、发布流程标准化、数据安全工具化。

---

## [1.1.0] - 2026-05-10

### Performance

- **Scan performance telemetry**: `scanner.js` now records per-stage elapsed time (enumerate / partition / normal / raw / cleanup) via `logger.task()` and returns a `perf` summary in `scanResult`.
- **Preview cache busting**: desktop (`photo://`, `video://`, `thumb://`) and web (`/photo/`, `/preview-image/`, `/thumb/`) preview URLs now include a `?v=` cache-buster based on `file_size` + `date_modified`.
- **Web server ETag**: `/photo/` and `/video/` responses include `ETag` derived from file `mtime` + `size`, with `304 Not Modified` support.

### UI

- **Settings page compact layout**: added `@media (max-width: 960px)` breakpoint reducing padding, font sizes, and gaps.
- **Settings page horizontal grouping**: "General" settings now use `settings-general-row` and `settings-toggle-row` flex-wrap layouts for dropdowns and toggles, reducing vertical scrolling.

---

### [1.1.0] - 2026-05-10（中文摘要）

**性能**

- 扫描阶段耗时埋点：`scanner.js` 各阶段（枚举、增量比对、普通文件、RAW 文件、清理提交）通过 `logger.task()` 输出结构化耗时日志，并在 `scanResult` 中返回性能摘要。
- 预览缓存穿透：桌面端（`photo://` / `video://` / `thumb://`）与网页端（`/photo/` / `/preview-image/` / `/thumb/`）预览 URL 均附加基于 `file_size` + `date_modified` 的 `?v=` 版本号。
- Web 服务端 ETag：`/photo/` 与 `/video/` 响应增加基于文件 `mtime+size` 的 `ETag`，支持 `304 Not Modified`。

**界面**

- 管理页紧凑布局：新增 `@media (max-width: 960px)` 断点，缩小间距、字号与控件尺寸。
- 管理页横向分组：「通用设置」中的下拉框与开关改为 flex-wrap 横向排布，减少纵向滚动。

---

## [1.0.4] - 2026-05-10

### Observability

- **Structured task logging**: added `logger.task(name, phase, detail, meta)` in `src/main/logger.js` with a unified `[TASK:<name> +<elapsed>ms]` format.
- **Scan task logs**: `runFolderScanInWorker` now logs `scan.start`, `scan.heartbeat.timeout`, and `scan.done/cancelled/error`.
- **Thumbnail backfill logs**: `runThumbnailBackfill` logs `start`, `query.missingTotal`, `query.rows`, `batch.done`, `cancelled`, and `done`.
- **Duplicate hash logs**: wrapped `runDuplicateHashDetection` with `logger.task('dup-hash', ...)` for `start`, `done`, and `error`.
- **Web server logs**: `src/web-server.js` now uses the shared logger for startup, shutdown, and HLS cache prune events.
- **Scan worker logs**: `src/scan-worker.js` outputs `console.log` at `worker.init`, `db.open`, `scan.start`, and `scan.done` for development visibility.

### Data Safety

- **README**: added **Data safety & backup** section with standard backup/restore steps and when to back up.
- **Confirmation dialogs**: high-risk maintenance actions (`maintenance-cleanup-missing-files`, `maintenance-optimize-database`, `run-db-vacuum`) now show a warning dialog with a "backup first" reminder before proceeding.

### Environment Lock

- **README**: added **Environment lock** section documenting the recommended Node/Electron combination, upgrade strategy, and `ERR_DLOPEN_FAILED` troubleshooting steps.

### Version Synchronization

- **Dynamic version in UI**: `src/renderer/i18n.js` and `src/renderer/ui-shell.js` no longer hard-code the version; `help.aboutBody` uses a `%VERSION%` placeholder replaced at runtime via `api.getAppVersion()`.
- **Version check script**: added `scripts/version-check.js` to scan `src/` and `README.md` for hard-coded version drift against `package.json`.
- **npm script**: `npm run version-check` runs the drift check.

### Bug Fixes

- **README version drift**: corrected `Current release` from `1.0.2` to `1.0.3`.

---

### [1.0.4] - 2026-05-10（中文摘要）

**可观测性**

- 新增 `logger.task()` 结构化任务日志，统一格式 `[TASK:<name> +<elapsed>ms]`。
- 扫描、缩略图补全、重复哈希、Web 服务各阶段增加结构化日志。
- Worker 线程增加开发阶段日志。

**数据安全**

- README 新增「数据安全与备份」小节，包含标准备份/恢复流程。
- 高风险维护操作（清理无效记录、优化数据库、VACUUM）增加二次确认弹窗，提示先备份。

**环境固化**

- README 新增「环境固化」小节，明确 Node/Electron 推荐组合、升级策略、原生模块排障步骤。

**版本同步**

- 应用内「关于」文案不再硬编码版本号，改为 `%VERSION%` 占位符，运行时通过 IPC 动态读取 `package.json`。
- 新增 `scripts/version-check.js`，用于发布前检查硬编码版本漂移。
- `npm run version-check` 一键校验。

**Bug 修复**

- 修复 README `Current release` 版本号漂移（1.0.2 → 1.0.3）。

---

## [1.0.3] - 2026-05-07

### Code Quality

- **ESLint**: fixed all 70 errors (duplicate keys, undefined variables, prototype builtins, unused assignments); down to 0 errors.
- **Dead code removal**: deleted 7 orphaned `src/renderer/modules/*` files and 2 `.bak` artifacts.
- **Logging**: introduced `src/main/logger.js` and `src/renderer/logger.js` with level control (`LOG_LEVEL` env / `localStorage`), defaulting to `warn` in production.
- **Face recognition cleanup**: removed residual `getFaceService` calls and unused face-related callbacks.

### Performance & Build Size

- **Removed duplicate `hls.min.js`**: eliminated the 841 KB duplicate in `src/renderer/vendor/`, saving the same amount from the packaged ASAR.
- **On-demand HLS loading**: `hls.min.js` is now injected dynamically only when the first HLS video is played, reducing first-paint parse cost by ~841 KB.

### UI Polish

- **Photo load transition**: images now fade from `blur(10px) opacity(0.6)` to clear with a smooth 0.5 s `filter + opacity + transform` transition.
- **Scrollbars**: capsule-shaped thumbs (`border-radius: 999px`) that glow with the active accent color on hover.
- **Button micro-interaction**: `:active` states on `.btn` (`scale(0.97)`) and `.titlebar-btn` (`scale(0.92)`) for tactile feedback.
- **Empty-state float**: the empty-state icon gently bobs with a 3 s `emptyFloat` keyframe animation.
- **Stagger card entrance**: photo cards enter in a 5-column wave with 55 ms incremental delays.

### Bug Fixes

- Fixed trailing `</style>` tag in `src/web/css/style.css` that broke Prettier parsing.
- Restored Safari native HLS fallback in `hls-attach.js` after refactoring to on-demand loading.
- Added missing ESLint globals (`requestIdleCallback`, `confirm`, `Logger`, `RendererFacesUI`, `api`, `formatNumber`).

---

## [1.0.2] - 2026-04-05

### Internationalization (zh-CN / English)

- **Settings (Management)**: dynamic strings now use the same `uiLocale` as static `data-i18n` text—library folder list (empty state, columns, rescan/remove), LAN & Cloudflare Tunnel status and copy feedback, web password alerts, maintenance tasks (thumbnail backfill, duplicate hashing, DB tools), HLS hint, and save-error toasts for browse/general/locale/close-button.
- **Sidebar**: folder and date sidebars (e.g. All photos, Favorites, All folders / All dates, sort buttons, loading and error lines, root rescan `title`/`aria-label`).
- **Stats bar**: global and folder-scoped lines (photo counts, sizes, video counts, "N folders" in folder overview); updates when the interface language changes.
- **Language switch**: `localechange` listeners refresh sidebar, stats bar, and parts of Settings so English does not leave mixed Chinese labels.

---

## [1.0.1] - 2026-04-05

### Web preview

- Random playback as a dedicated control with visible on/off state.
- On mobile, hide left/right preview buttons; swipe on the preview area to change media.
- Loading indicator when switching previews to avoid showing the previous frame.
- Videos do not autoplay by default (user must start playback).

### Subtitles

- Auto-detect sidecar subtitles: `.vtt`, `.srt`, `.ass`.
- Subtitle settings: enable/disable, size, position (web preview).

### Media filter consistency

- Desktop and web support **All / Images only / Videos only**.
- With image/video-only filters, directory tree and "All folders" hide folders that contain no matching media.
- Sidebar counts for "All photos / All folders" follow the active filter.

### Management UI

- Denser layout (section spacing, line height, control heights).
- More consistent horizontal/wrapped grouping for options.
- Tunnel and password status shown as unified badges.

### Web performance

- Photo grid uses `content-visibility: auto` and `contain` for smoother scrolling on large lists.

### Desktop UI (this release cycle)

- **Interface language**: choose **简体中文** or **English** under **Settings → General**; persists as `uiLocale` (`zh-CN` / `en`) in `settings.json`. Optional **top bar** language selector next to the theme control (hidden on very narrow layouts; language remains available in Settings).

---

## 中文版本说明（与上方英文条目对应）

### [1.0.3] - 2026-05-07

**代码质量**

- **ESLint**：修复全部 70 个错误（重复键、未定义变量、原型链污染、无用赋值），降至 0 错误。
- **死代码清理**：删除 7 个孤儿模块文件 `src/renderer/modules/*` 及 2 个 `.bak` 备份文件。
- **日志治理**：新增 `src/main/logger.js` 与 `src/renderer/logger.js`，支持级别控制（`LOG_LEVEL` 环境变量 / `localStorage`），生产环境默认 `warn`。
- **人脸识别残留清理**：删除残留的 `getFaceService` 调用及未使用的人脸相关回调。

**性能与构建体积**

- **删除重复 `hls.min.js`**：移除 `src/renderer/vendor/` 下的 841 KB 重复文件，构建包同等减负。
- **HLS 按需加载**：`hls.min.js` 改为首次播放 HLS 视频时动态注入，首屏解析成本降低约 841 KB。

**界面美化**

- **图片加载过渡**：照片从 `blur(10px) opacity(0.6)` 到清晰的过渡现在拥有平滑的 0.5 秒 `filter + opacity + transform` 动画。
- **滚动条精致化**：胶囊形 thumb（`border-radius: 999px`），hover 时亮起当前 accent 主题色。
- **按钮微交互**：`.btn` 按下 `scale(0.97)`、`.titlebar-btn` 按下 `scale(0.92)`，提供触觉反馈。
- **空状态浮动**：空状态图标以 3 秒 `emptyFloat` 关键帧动画轻轻浮动。
- **卡片交错入场**：照片卡片以 5 列波浪形式依次入场，每组递增 55 毫秒延迟。

**Bug 修复**

- 修复 `src/web/css/style.css` 末尾错误的 `</style>` 标签（导致 Prettier 解析失败）。
- 在 `hls-attach.js` 按需加载重构后，恢复 Safari 原生 HLS 回退逻辑。
- 补充 ESLint 缺失的全局变量声明（`requestIdleCallback`、`confirm`、`Logger`、`RendererFacesUI`、`api`、`formatNumber`）。

---

### [1.0.2] - 2026-04-05

**界面中英文适配**

- **管理设置**：动态生成的文案与静态 `data-i18n` 一致，随 `uiLocale` 切换；包括相册目录表（空状态、表头、重新扫描/移除）、局域网与 Tunnel 状态与复制提示、网页密码相关提示、后台任务与维护（缩略图补全、重复比对、数据库工具）、HLS 提示，以及浏览偏好/通用/语言/关闭按钮等保存失败提示。
- **侧栏**：目录与日期侧栏（全部照片、收藏、全部目录/全部日期、排序按钮、加载与失败文案、根目录 ↻ 的提示与无障碍标签）。
- **底部统计条**：全库与目录内统计（张数、体积、视频条数、「N 个目录」等）；切换语言后自动刷新文案。
- **语言切换**：通过 `localechange` 刷新侧栏、统计条及部分设置区，减少中英混杂。

### [1.0.1] - 2026-04-05

**网页端预览**

- 随机播放按钮化（支持随机开关状态显示）
- 移动端隐藏左右翻页按钮，支持预览区域滑动切换
- 增加预览加载动画，减少切图时上一张残留
- 视频默认不自动播放（需手动点击播放）

**字幕**

- 同名字幕自动识别：`.vtt` / `.srt` / `.ass`
- 新增字幕设置：开关、字号、位置（网页端预览）

**媒体筛选一致性**

- 桌面端与网页端都支持「全部 / 仅图片 / 仅视频」
- 在仅图片/仅视频下，目录树与「所有目录」会过滤不含对应媒体的目录
- 侧栏「所有照片/所有目录」计数按当前筛选口径显示

**管理界面**

- 整体更紧凑（区块间距、行高、输入控件高度下调）
- 选项分组改为更统一的横向/换行布局
- Tunnel 状态与密码状态统一为同位置徽标展示

**网页性能**

- 照片网格启用 `content-visibility: auto` 与 `contain`，提升大列表滚动流畅度

**桌面端界面**

- **界面语言**：在「管理设置 → 通用设置」可选择简体中文或 English，写入 `settings.json` 的 `uiLocale`。主界面顶栏主题旁可显示语言切换（极窄屏隐藏，设置中仍可切换）。

---

## Earlier versions

Older changes were not tracked in this file. Future releases should append sections here when `package.json` `version` is updated.
