# 拂晓图库 · Aurora Gallery

**语言 / Language:** [English](README.md) · 简体中文

**拂晓图库 / Aurora Gallery** 是一款基于 Electron 的**本地优先**相册应用：媒体与索引保存在本机，适合数万到百万级照片（含常见 RAW），并可选局域网浏览器访问与远程隧道。

| | |
|---|---|
| **中文名** | 拂晓图库（界面与安装后应用名） |
| **英文名** | Aurora Gallery（`package.json` 描述、安装包文件名、对外仓库名） |
| **npm 包名** | `aurora-gallery` |
| **Bundle ID**（`appId`） | `com.foredawn.aurora-gallery` |

**当前发布版本**：`1.0.2`（与根目录 [`package.json`](package.json) 的 `version` 字段一致；发版前请 bump 版本并同步「关于」等文案。）

**版本说明**：详见 [`CHANGELOG.md`](CHANGELOG.md)（中英对照的发行条目以英文 changelog 为准；中文版 README 在此做摘要指引）。

## 主要功能

以下为产品能力概览；细项以应用内「管理」各分页为准。

### 图库与扫描

- **多根目录**：在「相册目录」中维护多个照片根路径，统一纳入同一套索引与浏览体验。
- **增量扫描**：检测新增、变更与删除；支持**暂停 / 继续 / 取消**，进度在任务区可见，适合长时间扫大盘。
- **扫描策略**：可按需配置符号链接、目录深度、按名称跳过某些文件夹、是否索引 RAW 等（见管理页中与扫描相关的选项）。
- **元数据入库**：分辨率、拍摄/修改时间、文件大小、路径等写入 **SQLite**；覆盖常见图片与视频格式，并面向 **RAW** 等大文件场景优化。
- **缩略图**：首访或按需生成；可在后台**补全**缺失缩略图，并支持调节补全并发等参数。

### 桌面端浏览与预览

- **导航方式**：侧栏**目录树**、**按日期**聚合、**搜索**结果列表；与「全部照片 / 全部目录」等入口配合使用。
- **浏览偏好**（可持久化）：默认**排序**（按拍摄/修改时间、文件名、大小、路径等多键）、**目录范围**（仅当前文件夹 / 含子文件夹）、**每页条数**、**网格布局**（瀑布流原比例、统一高度 + 多种宽高比）、卡片大小、缩略图是否裁剪等。
- **收藏与系统联动**：收藏状态可参与筛选；支持在**系统资源管理器**中打开原文件或所在目录。
- **图片预览**：缩放、拖拽、旋转、全屏；底部可配置是否显示文件名、时间、大小等**预览信息行**。
- **视频预览**：进度与播放控制；**幻灯片**支持顺序或随机；关闭主窗口行为可配置（见下）。
- **界面与操作**：多套**界面风格**（明暗与强调色主题）；支持**简洁界面**（快捷键收起侧栏/顶栏等，减少干扰）；**托盘**：可最小化到后台，托盘菜单快速恢复或退出。

### 启动与自动化（通用设置）

- **界面语言**（简体中文 / **English**）：在「管理设置 → 通用设置」顶部选择后立即生效，并写入 `settings.json` 的 `uiLocale`（`zh-CN` / `en`）。除主窗口标题、托盘提示与静态 `data-i18n` 文案外，**1.0.2** 起已覆盖大量动态界面：侧栏（目录/日期、收藏、加载与失败提示等）、底部**统计条**、管理页（相册目录表、局域网与 Tunnel、后台任务与维护、保存失败提示等）。顶栏主题旁可显示**语言切换**（极窄屏下隐藏，仍可在设置中切换）。完整列表见 [`CHANGELOG.md`](CHANGELOG.md) 的 **1.0.2**。
- 可选：**启动时自动扫描**、**启动后自动补全缩略图**、**启动后自动查找重复照片**（与扫描任务协调，避免同时抢资源）。
- **启动默认页**：欢迎页、所有照片、所有目录或恢复**上次位置**。
- **关闭按钮**：标题栏关闭 / Alt+F4 可设为每次询问、直接进托盘或直接退出（与托盘菜单中的退出逻辑独立说明，见应用内快捷键帮助）。

### 筛选、去重与检索

- **多维筛选**：媒体类型（全部 / 仅图片 / 仅视频）、尺寸、体积、时间范围、目录范围、收藏等；筛选变化时，侧栏计数与「所有目录」列表会与当前口径**保持一致**（无媒体的目录可被隐藏）。
- **重复照片**：基于文件内容**哈希**比对；支持专用视图分组浏览重复项。
- **搜索**：对已索引条目按界面提供的条件检索（具体字段与语法以界面为准）。

### 网页端与远程访问

- **内置 Web 服务**：开启后，局域网内浏览器通过 **HTTP** 访问图库，无需单独部署后端。
- **安全**：可设置**访问密码**；管理页展示 Web 服务开关、本机访问地址与密码状态。
- **与桌面一致的体验**：列表与预览能力对齐，包括**全部/仅图/仅视频**筛选、目录封面、预览过渡与随机播放等；**移动端**优化触控与滑动翻页。
- **视频与字幕**：外挂同名字幕（`.vtt` / `.srt` / `.ass`）；网页端预览可调整字幕开关、字号与位置。大文件或特殊场景下，可由服务端策略转为 **HLS** 流式播放，减轻解码与带宽压力。
- **外网访问（可选）**：通过 **Cloudflare Tunnel**（`cloudflared`）将服务暴露到公网；安装包可内置 `cloudflared`（见构建脚本），也可使用系统 PATH 中的二进制。

### 维护与数据

- **数据库**：单文件 **SQLite**（`photos.db`）；提供**清理**、**VACUUM 优化**、**备份**等维护入口（具体项见「缩略图、预览与数据」与管理页相关区块）。
- **缩略图与哈希任务**：缩略图补全、重复比对等作为**后台任务**展示进度；可配置 **HLS 转码缓存上限** 等，避免磁盘占满。
- **数据位置**：应用数据位于当前用户下的应用目录（开发时与包名等相关）；请勿将数据库提交到版本库。
- **建议**：大批量导入、迁移或实验性清理前，先**备份** `photos.db`。

## 版本说明（摘要）

各版本的详细变更请阅读 **[`CHANGELOG.md`](CHANGELOG.md)**。当前线：**1.0.2**（在 1.0.1 的网页预览、字幕、筛选与管理页等能力之上，补充**中英文界面适配**：侧栏、统计条、管理设置动态文案等；更早版本条目以 changelog 为准）。

## 环境要求

- Windows 10/11，macOS（Apple Silicon / Intel）
- Node.js `>=22.0.0 <23.0.0`
- npm 10+

> 说明：项目包含原生依赖 `better-sqlite3`、`sharp`，切换 Node/Electron 版本后需要重新编译原生模块。

## 安装与启动

```bash
npm install
npm run rebuild-native
npm start
```

开发模式：

```bash
npm run dev
```

## 常用脚本

- `npm start`：启动桌面应用
- `npm run dev`：开发模式启动
- `npm run rebuild-native`：重编译原生模块（`better-sqlite3`、`sharp`、`onnxruntime-node`）
- `npm run lint`：运行 ESLint
- `npm run format`：用 Prettier 格式化仓库
- `npm run pack`：生成未安装版目录（`electron-builder --dir`）
- `npm run dist`：按当前平台生成安装包（会先执行 `download-cloudflared`）
- `npm run dist:win`：生成 Windows 安装包（NSIS）
- `npm run dist:mac`：生成 macOS 安装包（DMG）
- `npm run download-cloudflared`：下载 cloudflared 供打包或本机 Tunnel 使用
- `npm run smoke:db`：数据库冒烟脚本（`scripts/db-smoke.js`）

## 打包可执行文件

### Windows

```bash
npm install
npm run dist:win
```

常见输出（文件名中的版本号与 `package.json` 的 `version` 一致，例如当前为 `1.0.2`）：

- 安装包：`release/AuroraGallery-Setup-<version>.exe`
- 解包目录：`release/win-unpacked/`

### macOS

```bash
npm install
npm run dist:mac
```

常见输出（同上，`<version>` 来自 `package.json`）：

- 安装包：`release/AuroraGallery-<version>.dmg`
- 解包目录：`release/mac/` 或 `release/mac-arm64/`

## 项目结构

```text
src/
  main.js                # Electron 主进程入口（窗口、IPC、后台任务）
  preload.js             # 渲染层安全桥接（photoAPI）
  web-server.js          # 内置 Web 服务（API、静态页、视频/字幕/HLS）
  database.js            # SQLite 数据访问层
  renderer/
    index.html            # 桌面端页面结构
    styles.css            # 桌面端样式
    app.js                # 桌面端入口与状态编排
    api.js                # 渲染层 API 封装
    settings.js           # 设置读写与同步
    preview-flow.js       # 预览流程（图片/视频切换）
    ui-preview.js         # 预览交互（缩放/幻灯片/收藏等）
    ui-events.js          # 事件绑定
    ui-grid.js            # 网格渲染
    ui-navigation.js      # 导航切换
    ui-settings.js        # 设置页渲染逻辑
    ui-shell.js           # 顶层 UI 状态（任务/Tunnel/提示）
    sidebar-tree.js       # 目录树构建与渲染
    ui-duplicates.js      # 重复图分组与预览
    scan-flow.js          # 扫描流程编排
  web/
    index.html            # Web 端页面（样式+脚本内嵌）
    login.html            # Web 登录页
    vendor/
      hls.min.js          # HLS 播放库
  scanner.js              # 扫描与入库流程
  scan-worker.js          # 扫描 worker
  hls-session-manager.js  # HLS 转码会话管理
  hls-attach.js           # HLS 前端挂载辅助
  playback-strategy.js    # 媒体播放策略（直播/HLS）
```

## 模块依赖关系（简图）

```text
桌面端（Electron）
renderer/* UI
  -> renderer/api.js
  -> preload.js (photoAPI)
  -> main.js (ipcMain handlers)
  -> database.js / scanner.js / web-server.js

网页端（Browser）
web/index.html
  -> web-server.js (/api/*, /photo/*, /video/*)
  -> database.js (查询)
  -> hls-session-manager.js + playback-strategy.js (视频/HLS)
```

- 桌面端所有数据操作通过 `photoAPI` 走 IPC，不直接访问数据库。
- 网页端由 `web-server.js` 统一提供 API、媒体流与字幕转换（`vtt/srt/ass`）。
- 视频播放策略由 `playback-strategy.js` 决定直连或 HLS，HLS 会话由 `hls-session-manager.js` 管理。

## 数据与配置

- 应用数据目录：开发时通常与 npm 包名对应（Electron `app.getName()` 等），数据在各自用户目录下的应用文件夹中；请勿把 `photos.db` 提交到 Git。
- 数据库：应用数据目录下 `photos.db`
- 配置：应用数据目录下设置文件（由主进程自动管理）
- 缩略图：存储在数据库 `photos.thumbnail` 字段中

> 建议在做大规模扫描/清理前备份数据库文件。

## 开发建议

- 先运行 `npm run rebuild-native` 再启动，避免原生模块 ABI 不匹配
- `src/renderer/app.js` 和 `src/main.js` 体量较大，修改时建议小步提交
- 扫描、哈希、缩略图补全属于重任务，优先关注进度状态与异常路径

## 常见问题

### 1) 启动或运行时报 `ERR_DLOPEN_FAILED`

通常是原生模块和当前 Node 版本不一致：

```bash
npm run rebuild-native
```

若仍失败：

```bash
npm install
npm run rebuild-native
```

### 2) 扫描后部分目录未显示

- 确认根目录已添加成功
- 检查扫描是否被暂停/取消
- 检查是否开启了目录跳过规则（扫描设置）

### 3) 缩略图显示不完整

- 先确认图片已入库
- 运行“缩略图补全”后台任务并等待完成

## 许可证

MIT
