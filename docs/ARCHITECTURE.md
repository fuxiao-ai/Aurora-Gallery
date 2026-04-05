# Architecture

本文档描述 `photo-manager` 的当前架构、核心数据流与模块边界（基于当前代码，而非历史规划）。

## 1) 总体架构

项目是 Electron + 内置 Web Server 的双端架构：

- 桌面端（Electron Renderer）
- 网页端（Browser）
- 共享数据层（SQLite）

核心组件：

- 主进程：`src/main.js`
- 预加载桥：`src/preload.js`
- 桌面渲染层：`src/renderer/*`
- Web 服务：`src/web-server.js`
- 数据层：`src/database.js`
- 扫描链路：`src/scanner.js` + `src/scan-worker.js`

## 2) 模块职责

### 2.1 主进程 `src/main.js`

- 应用生命周期（窗口、托盘、菜单、快捷键）
- IPC 注册与分发
- 后台任务调度（扫描、缩略图补全、哈希）
- Web 服务与 Tunnel 状态协调

### 2.2 预加载桥 `src/preload.js`

- 通过 `photoAPI` 暴露白名单能力给渲染层
- 屏蔽 `ipcRenderer` 细节，保持调用边界清晰

### 2.3 桌面端渲染 `src/renderer/*`

- `app.js`：状态与流程编排（入口）
- `ui-events.js`：事件绑定
- `preview-flow.js` / `ui-preview.js`：预览与幻灯片逻辑
- `ui-grid.js` / `ui-navigation.js` / `sidebar-tree.js`：列表与导航渲染
- `ui-settings.js` / `settings.js` / `ui-shell.js`：设置页与全局 UI 状态
- `ui-duplicates.js`：重复图视图

### 2.4 数据层 `src/database.js`

- SQLite 表结构与迁移
- 分页查询、筛选、搜索、收藏、重复图聚合
- 目录树、目录封面、媒体类型口径查询

### 2.5 Web 服务 `src/web-server.js`

- 提供网页静态资源与 API（`/api/*`）
- 提供图片/视频访问与 Range 支持
- 提供字幕接口（同名 `.vtt/.srt/.ass`）
- 提供 HLS 路由与会话停止接口

### 2.6 扫描与任务

- `scan-worker.js`：Worker 线程执行重扫描任务
- `scanner.js`：扫描、增量判断、批量写库
- 主进程轮询/广播任务状态给渲染层

## 3) 关键调用链

### 3.1 桌面端链路

`renderer UI -> renderer/api.js -> preload photoAPI -> main ipcMain -> database/scanner/web-server`

### 3.2 网页端链路

`web/index.html -> web-server /api -> database`

媒体播放：

`web/index.html -> /api/video-playback -> playback-strategy + hls-session-manager`

字幕：

`web/index.html <track> -> /api/video-subtitle -> vtt/srt/ass 统一输出 text/vtt`

## 4) 并发模型

- 渲染进程：UI 与交互
- 主进程：调度与资源管理
- Worker：扫描重任务
- SQLite：WAL 模式下读写并发，扫描侧采用批量事务

## 5) 当前技术约束

- 主进程仍较重（任务、IPC、平台逻辑集中在 `main.js`）
- Web 端目前为单文件内嵌脚本样式（`web/index.html`），维护成本偏高
- 大图库下仍需持续做性能基准与回归验证

## 6) 后续建议（与 ROADMAP 对齐）

- 优先补齐结构化日志与失败可观测性（P0）
- 建立性能基准（扫描/分页/预览切换）并持续跟踪（P1）
- 逐步把 Web 端内嵌逻辑拆分为模块化文件（P2）

## 7) 更新记录

- 2026-03-26：基于当前代码重写架构文档，移除历史拆分计划描述
# Architecture

本文档描述 `photo-manager` 的当前架构、核心数据流和后续拆分方向，便于开发与维护。

## 1. 总体架构

项目采用 Electron 三层结构：

- 主进程：`src/main.js`
- 预加载桥：`src/preload.js`
- 渲染进程：`src/renderer/index.html` + `src/renderer/app.js`

并包含两个并行子系统：

- 本地扫描与入库：`src/scan-worker.js` + `src/scanner.js` + `src/database.js`
- 内置 Web 访问：`src/web-server.js` + `src/web/*`

## 2. 模块职责

### 2.1 主进程（`src/main.js`）

负责应用级生命周期与中枢编排：

- 创建窗口、托盘、快捷键
- 初始化数据库连接与设置
- 注册 IPC 接口给渲染层调用
- 管理后台任务（扫描、缩略图补全、哈希去重）
- 启停内置 Web 服务与隧道状态

主进程不做复杂 UI 计算，主要做调度、状态聚合和资源管理。

### 2.2 预加载桥（`src/preload.js`）

通过 `contextBridge.exposeInMainWorld('photoAPI', ...)` 暴露白名单 API：

- 扫描控制：开始/暂停/继续/取消/队列
- 数据查询：统计、目录树、分页照片、搜索
- 维护任务：缩略图补全、去重哈希、数据库维护
- 应用控制：窗口行为、开发者工具、Web URL

它是渲染层和主进程之间的唯一安全边界。

### 2.3 渲染层（`src/renderer/app.js`）

负责桌面端交互与状态管理：

- 侧边栏视图切换（目录/日期/重复图）
- 照片网格、分页、筛选、排序
- 预览（切图、缩放、拖拽、轮播）
- 设置页、后台任务进度展示

当前 `app.js` 体积较大（4000+ 行），后续建议按功能域拆分。

### 2.4 数据层（`src/database.js`）

封装 SQLite 访问（`better-sqlite3`）：

- 表结构初始化、列升级
- root folder 与 photos 增删查改
- 分页查询、筛选、搜索、收藏
- 重复哈希聚合查询
- 扫描增量相关接口（existing files、batch insert、stale cleanup）

该层是主进程、扫描器、Web 服务共享的数据访问入口。

### 2.5 扫描器（`src/scanner.js` + `src/scan-worker.js`）

- `scan-worker.js` 在 Worker 线程运行扫描，避免主进程阻塞
- `scanner.js` 负责目录遍历、增量判断、并发处理、批量提交
- 通过定时 progress 消息向主进程汇报进度
- 支持 pause/resume/cancel 控制

扫描流程关键点：

1. 枚举文件（可配置深度、跳过目录、RAW 开关）
2. 加载已有路径映射做增量跳过
3. 分批写入数据库（缩短事务锁）
4. 扫描后清理已失效记录

### 2.6 Web 服务（`src/web-server.js`）

基于 Node `http` 提供局域网访问：

- 静态页面：`/`、`/login`
- REST API：`/api/photos`、`/api/search`、`/api/stats` 等
- 资源接口：`/thumb/:id`、`/photo/:id`
- 会话认证（可选密码 + cookie session）

Web API 直接调用 `database.js`，与桌面端共享同一数据源。

## 3. 核心数据流

## 3.1 启动流

1. Electron `app` ready
2. 主进程初始化设置与数据库
3. 注册 IPC 与协议处理
4. 创建主窗口并加载渲染页
5. 启动 Web 服务（如配置启用）

## 3.2 扫描流（桌面端触发）

1. 渲染层调用 `photoAPI.scanFolder()`
2. 主进程创建/调度 scan worker
3. worker 内部执行 `scanner.scanFolder()`
4. 扫描进度持续回传主进程并同步给渲染层
5. 扫描完成后主进程刷新统计与视图

## 3.3 浏览流（桌面端）

1. 渲染层根据当前 tab + filter 组装查询参数
2. 通过 `photoAPI.getPhotos/getFolderPhotos/getDatePhotos` 请求
3. 主进程转调 `database.js` 返回分页数据
4. 渲染层更新网格和分页状态

## 3.4 Web 浏览流

1. 浏览器访问 `http://<host>:<port>`
2. `web-server.js` 路由到静态页或 API
3. API 查询 `database.js` 返回 JSON
4. 前端页面渲染列表与详情

## 4. 线程与并发模型

- UI 线程（渲染进程）：仅做渲染和交互
- 主进程：负责 IPC 与任务调度，不做大规模扫描计算
- Worker 线程：执行扫描和重 I/O 处理
- SQLite（WAL）：支持读写并发，扫描采用批量事务减少锁占用

## 5. 配置与状态

配置由主进程集中维护并落盘（例如主题、扫描选项、窗口行为等），渲染层通过 IPC 拉取/更新。

后台任务状态（扫描、缩略图补全、哈希）由主进程统一维护，渲染层采用轮询 + 事件混合方式更新 UI。

## 6. 当前技术债

- `src/renderer/app.js` 与 `src/main.js` 体量偏大，边界不清晰
- IPC handler 逻辑分布较散，定位成本高
- 任务状态管理与 UI 状态耦合较重

## 7. 建议拆分路线（与 ROADMAP 对齐）

### 7.1 主进程拆分

- `src/main/ipc/*.js`：按功能域注册 IPC
- `src/main/tasks/*.js`：扫描/缩略图/哈希任务
- `src/main/platform/*.js`：窗口、托盘、快捷键

### 7.2 渲染层拆分

- `src/renderer/state/`：全局状态与更新器
- `src/renderer/features/preview/`
- `src/renderer/features/settings/`
- `src/renderer/features/duplicates/`

### 7.3 拆分原则

- 先“搬代码不改逻辑”
- 每次只拆一个功能域
- 保持对外 API（IPC 名称）稳定

## 8. 术语

- Root Folder：用户添加的根目录
- Incremental Scan：按路径与修改时间跳过未变化文件
- Thumbnail Backfill：扫描后后台补全缩略图
- Duplicate Hash：基于文件内容哈希识别重复图片

## 9. 更新记录

- 2026-03-24：创建初版架构文档
