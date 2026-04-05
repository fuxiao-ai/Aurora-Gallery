# 拂晓图库

一个基于 Electron 的本地相册管理工具，面向大规模图片库（含 RAW）场景，支持扫描入库、缩略图、筛选排序、收藏、重复图识别和 Web 访问。

## 功能概览

- 根目录管理与增量扫描（支持暂停/继续/取消）
- 图片元数据入库（分辨率、时间、大小、路径等）
- 缩略图生成与后台补全
- 多维筛选：媒体类型（全部/仅图片/仅视频）、尺寸、体积、时间、目录、收藏
- 重复图片识别（基于文件哈希）
- 桌面端预览与移动端 Web 浏览
- 基础维护能力（数据库优化、缩略图状态重建等）

## 功能介绍

### 1) 桌面端相册浏览

- 支持按目录树、日期、搜索结果浏览照片
- 支持排序、分页、网格大小调整、收藏与快速定位原文件
- 图片预览支持缩放、拖拽、旋转、全屏和快捷键操作
- 视频预览支持进度拖动、手动播放、随机/顺序幻灯片切换

### 2) 网页端访问与预览

- 内置 Web 服务，可在局域网浏览器中访问
- 支持登录密码保护，适配移动端手势浏览
- 支持图片/视频筛选、目录封面浏览、预览加载动画
- 视频支持同名字幕（`.vtt` / `.srt` / `.ass`）与字幕开关、字号、位置设置

### 3) 扫描、索引与维护

- 支持根目录管理、增量扫描、暂停/继续/取消
- 支持缩略图补全、哈希计算与重复图识别
- 支持数据库清理、优化、备份和缩略图状态重建
- 支持 Tunnel 开关与状态展示（打包前执行 `npm run download-cloudflared` 可将 cloudflared 打入安装包；亦可使用本机 PATH 中的 cloudflared）

## 最近更新（界面与体验）

- 网页端预览：
  - 随机播放按钮化（支持随机开关状态显示）
  - 移动端隐藏左右翻页按钮，支持预览区域滑动切换
  - 增加预览加载动画，减少切图时上一张残留
  - 视频默认不自动播放（需手动点击播放）
- 字幕能力增强：
  - 同名字幕自动识别：`.vtt` / `.srt` / `.ass`
  - 新增字幕设置：开关、字号、位置（网页端预览）
- 媒体筛选一致性：
  - 桌面端与网页端都支持 `全部 / 仅图片 / 仅视频`
  - 在仅图片/仅视频下，目录树与“所有目录”会过滤不含对应媒体的目录
  - 侧栏“所有照片/所有目录”计数按当前筛选口径显示
- 管理界面优化：
  - 整体更紧凑（区块间距、行高、输入控件高度下调）
  - 选项分组改为更统一的横向/换行布局
  - Tunnel 状态与密码状态统一为同位置徽标展示
- 网页性能优化：
  - 照片网格启用 `content-visibility: auto` 与 `contain`，提升大列表滚动流畅度

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
- `npm run rebuild-native`：重编译原生模块
- `npm run pack`：生成未安装版目录
- `npm run dist`：按当前平台生成安装包
- `npm run dist:win`：生成 Windows 安装包（NSIS）
- `npm run dist:mac`：生成 macOS 安装包（DMG）

## 打包可执行文件

### Windows

```bash
npm install
npm run dist:win
```

常见输出：

- 安装包：`release/拂晓图库 Setup 1.0.0.exe`
- 解包目录：`release/win-unpacked/`

### macOS

```bash
npm install
npm run dist:mac
```

常见输出：

- 安装包：`release/拂晓图库-1.0.0.dmg`
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
