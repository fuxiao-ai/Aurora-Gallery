# Changelog

All notable changes to **Aurora Gallery / 拂晓图库** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Release versions match the root [`package.json`](package.json) `version` field.

## [Unreleased]

### Planned

- Bump `version` in `package.json` and sync in-app "About" text before each release.

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
