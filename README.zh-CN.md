# 拂晓图库 · Aurora Gallery

**语言 / Language:** [English](README.md) · 简体中文

**拂晓图库 / Aurora Gallery** 是一款基于 Electron 的**本地优先**相册应用：媒体与索引保存在本机，适合数万到百万级图片（含常见 RAW），并可选局域网浏览器访问与远程隧道。

|                        |                                                |
| ---------------------- | ---------------------------------------------- |
| **中文名**                | 拂晓图库（界面与安装后应用名）                                |
| **英文名**                | Aurora Gallery（`package.json` 描述、安装包文件名、对外仓库名） |
| **npm 包名**             | `aurora-gallery`                               |
| **Bundle ID**（`appId`） | `com.foredawn.aurora-gallery`                  |

**当前发布版本**：`1.3.0`（与根目录 [`package.json`](package.json) 的 `version` 字段一致；发版前请 bump 版本并同步「关于」等文案。）

**版本说明**：详见 [`CHANGELOG.md`](CHANGELOG.md)（中英对照的发行条目以英文 changelog 为准；中文版 README 在此做摘要指引）。

## 关于作者

**拂晓AI** —— AI 产品经理，不是程序员。

拂晓图库不是从「做一个软件」开始的，而是从「看不下去」开始的：手里图片很多，市面上的看图工具却要么界面陈旧、要么实在谈不上好看。想法从来不是「我要写一个图库」，而是「这些图片值得一个更好看的容器，而且这个工具得好看、好用到我愿意每天打开它」。

与其说是巧合，不如说是一扇门被推开了。**2024-12-31**，那一年的最后一天，第一次接触到后来被叫做 vibe coding 的东西 —— 用大白话说出你想要什么，然后看着机器把它写出来。第二天一早，**2025-01-01**，第一个个人主页上线了。它很小，却悄悄把问题换掉了：不再是「我能不能做出来」，而是「我该做什么」。

接下来的那一年，是看着这些工具长大的过程。工具链从 **Cursor** 换到 **Claude Code**，再到 **WorkBuddy**，每换一次，天花板就抬高一点：起先是一个更聪明的补全，然后是一个能把整个文件放在心里的东西，再后来是一个会读自己的输出、并把它改对的 agent。国产大模型（Kimi、DeepSeek、通义、豆包这一代）也在同步长大，而它们的变化是质变而非量变 —— 早期它们写的代码「看着对、其实不对」，后来慢慢学会了保持上下文、遵守约束，甚至承认自己不确定。过去必须由程序员亲手完成的部分，如今更需要一份说得清楚的规格、逐条核对的耐心，以及把规格守到底的那点较真。

拂晓图库动手是 **2026 年 4 月**。六个月后，它撑起了上百万张的图库，后面接着本地 AI 搜图、人物分组和一整套编辑流程 —— 从产品定义、界面设计到工程落地，全部由一个人完成，没有团队，也没有手写的框架级代码。

这个项目想证明的不是「AI 能写代码」，而是**一个产品经理能把 AI 用到什么深度**。难的不是让模型吐出一段能跑的代码，而是把上百个模块、百万级的数据和一整套人机交互捏合成一个还能继续演进的东西 —— 界面好不好看、顺不顺手，在这里是先决条件，而不是做完之后再补的事。

- **2024-12-31** —— 第一次接触 vibe coding
- **2025-01-01** —— 第一个个人主页上线
- **2025 年** —— 工具链从 Cursor 换到 Claude Code、再到 WorkBuddy；国产大模型和 agent 工具的能力，提升到「可以试着做点真东西」
- **2026-04** —— 拂晓图库首次提交
- **2026-10** —— 图库规模上百万张；本地 AI、编辑与整理能力就位

### 这个项目展示了什么

- **从 0 定义产品，而不是执行需求。** 出发点是一句真实的不满 ——「市面上的看图工具不够好看」。22 套主题、4 档窗口背景、非破坏的编辑流程，都是产品与审美判断的产物，不是需求文档的翻译。
- **把 AI 工具用到工程深度。** 桌面端（Electron）、网页端、本地 AI 模型（ONNX Runtime）、自研图片解码器、双平台打包与 CI —— 这条链路通常需要一个团队，这里由一个人借助 AI 走通。
- **给独立项目建立工程纪律。** [`docs/contracts/`](docs/contracts/) 下 10 份契约、[`scripts/`](scripts/) 下 80 多个回归守护：凡是实测确立的行为都写下来并钉住。这通常是大团队才养成的习惯。
- **对规模的敬畏。** 百万级图片的读写路径上，缓存、有界工作池、单一写准入点各司其职 —— 性能不是事后优化，而是设计前提。
- **持续交付的耐心。** 六个月、四个阶段、37 次提交，从「能用」到「站得住」再到「会找东西」，每一步都有版本记录可查。

官网：<https://foredawn.vip/>

## 特点

- **本地优先，不上云。** 媒体与索引始终留在你自己的机器上 —— 没有账号、不上传、不必担心云配额。
- **面向主流看图工具放弃的规模。** 数十万到上百万张图片（含常见 RAW）依然顺畅，靠的是缓存、有界的读工作池和单一的写准入点，而不是用户的耐心。
- **AI 跑在你自己的硬件上。** 用一句话而不是关键词的语义搜图、人脸检测与人物分组、支撑可浏览标签树的零样本内容标签；所有模型都在本机运行，不向任何地方发送数据。
- **可选的外部访问。** 带访问密码的内置 Web 服务，手机 / 平板走局域网即用；需要外网时接 Cloudflare Tunnel。
- **不只是看图，还能编辑和整理。** 非破坏的旋转 / 翻转 / 裁剪，标记、评分与用户标签，一套筛选口径在列表、目录、日期、搜图、标签与预览各处保持一致。
- **契约 + 回归守护。** 凡是经实测确立的行为都写成 [`docs/contracts/`](docs/contracts/) 下的契约；每条要紧的契约都配一个回归脚本，一旦漂移就让整套测试变红 —— 目前 80 多个脚本，覆盖面从 SQL 执行计划，一直到「某个快捷键是否真的接到了处理函数」。

## 主要功能

以下为产品能力概览；细项以应用内「管理」各分页为准。

### 图库与扫描

- **多根目录**：在「相册目录」中维护多个图片根路径，统一纳入同一套索引与浏览体验。
- **增量扫描**：检测新增、变更与删除；支持**暂停 / 继续 / 取消**，进度在任务区可见，适合长时间扫大盘。
- **扫描策略**：可按需配置符号链接、目录深度、按名称跳过某些文件夹、是否索引 RAW 等（见管理页中与扫描相关的选项）。
- **元数据入库**：分辨率、拍摄/修改时间、文件大小、路径等写入 **SQLite**；覆盖常见图片与视频格式，并面向 **RAW** 等大文件场景优化。
- **格式覆盖**：在 `sharp` 原生可读的（JPEG、PNG、WebP、HEIF/AVIF、TIFF、GIF、SVG）之外，BMP、ICO、PNM、TGA、QOI 由自研解码器覆盖；RAW 容器则走其内嵌的 JPEG 预览。
- **Live Photo**：配对的图片与伴生视频被认作同一项，后者不进视频列表。仅凭文件名并不可靠，配对走文件里的内容标识，并**双向**记账。
- **缩略图**：首访或按需生成；可在后台**补全**缺失缩略图，并支持调节补全并发等参数。

### 桌面端浏览与预览

- **导航方式**：侧栏**目录树**、**按日期**聚合、**搜索**结果列表；与「所有文件 / 所有目录」等入口配合使用。
- **浏览偏好**（可持久化）：默认**排序**（按拍摄/修改时间、文件名、大小、路径等多键）、**目录范围**（仅当前文件夹 / 含子文件夹）、**每页条数**、**网格布局**（瀑布流原比例、统一高度 + 多种宽高比）、卡片大小、缩略图是否裁剪等。
- **收藏与系统联动**：收藏状态可参与筛选；支持在**系统资源管理器**中打开原文件或所在目录。
- **图片预览**：缩放、拖拽、旋转、全屏；底部可配置是否显示文件名、时间、大小等**预览信息行**。
- **图片编辑**：在预览里旋转、翻转、裁剪。操作**立即体现在预览上，但只有点保存才写入磁盘**，随时可以反悔。保存会原子替换原文件，并在同一步里刷新缩略图与 dHash；裁剪也可以选择另存为新副本，原图不动。
- **视频预览**：进度与播放控制；**幻灯片**支持顺序或随机；关闭主窗口行为可配置（见下）。
- **界面与操作**：**22 套界面风格**预设（11 深 11 浅，含**玻璃 / 渐变**两类材质档），强调色（**10 种**）、背景基调（**11 档**）、**材质纹理**（**8 种**：颗粒 / 纸纤维 / 亚麻 / 磨砂 / 细网 / 点阵 / 条纹 / 木纹）与**面板透明度**（**3 档**：轻微 / 中等 / 通透；只让界面框架半透明，图片本身始终不透明）、**窗口背景**（**4 档**：实色 + 亚克力**轻 / 中 / 强**三档程度；后三档让**整个窗口**透出桌面，选后需**重启应用**生效，系统模糊仅 Windows 11 22H2 及以上提供）可各自独立调整（设置 → 应用；顶栏下拉也能直接切，**鼠标悬浮即预览**；窗口背景只在设置页，因为它是窗口创建参数、重启前无法预览）；支持**简洁界面**（快捷键收起侧栏/顶栏等，减少干扰）；**托盘**：可最小化到后台，托盘菜单快速恢复或退出。

### 启动与自动化（通用设置）

- **界面语言**（简体中文 / **English**）：在「管理设置 → 通用设置」顶部选择后立即生效，并写入 `settings.json` 的 `uiLocale`（`zh-CN` / `en`）。除主窗口标题、托盘提示与静态 `data-i18n` 文案外，**1.0.2** 起已覆盖大量动态界面：侧栏（目录/日期、收藏、加载与失败提示等）、底部**统计条**、管理页（相册目录表、局域网与 Tunnel、后台任务与维护、保存失败提示等）。顶栏主题旁可显示**语言切换**（极窄屏下隐藏，仍可在设置中切换）。完整列表见 [`CHANGELOG.md`](CHANGELOG.md) 的 **1.0.2**。
- 可选：**启动时自动扫描**、**启动后自动补全缩略图**、**启动后自动查找重复图片**（与扫描任务协调，避免同时抢资源）。
- **启动默认页**：欢迎页、所有文件、所有目录或恢复**上次位置**。
- **关闭按钮**：标题栏关闭 / Alt+F4 可设为每次询问、直接进托盘或直接退出（与托盘菜单中的退出逻辑独立说明，见应用内快捷键帮助）。

### 筛选、去重与检索

- **多维筛选**：媒体类型（全部 / 仅图片 / 仅视频）、尺寸、体积、时间范围、目录范围、收藏等；筛选变化时，侧栏计数与「所有目录」列表会与当前口径**保持一致**（无媒体的目录可被隐藏）。
- **重复图片**：基于文件内容**哈希**比对；支持专用视图分组浏览重复项。
- **搜索**：对已索引条目按界面提供的条件检索（具体字段与语法以界面为准）。

### AI：语义搜图、人物与标签

只用本地模型，不外传任何数据。索引与数据库放在一起，由后台任务构建，各自有进度与准入闸门。

- **语义搜图**：用一句话描述你要找的东西，图片按与查询的相似度排序。编码器在本机运行，建索引是可续跑的后台任务。
- **人物**：人脸检测与分组，侧栏列出人物组，支持按名字过滤与就地改名。分组严格程度可调，阈值带版本号存储 —— 换模型或换算法时会做迁移，而不是静默地重新分组。
- **内容标签**：基于本地索引计算的零样本标签，支撑标签导航页（见下节「整理」）。
- **GPU 加速（可选）**：探测一次即可判定这台机器能否加速这些任务，结论会显示在设置页；不能时始终回落到 CPU。

### 整理：标记、评分与标签

- **标记、评分与用户标签**：在预览页&#x7684;**「整理」抽屉**里逐张设置。
- **一套筛选口径走遍全站**：同一组标记 / 评分 / 标签筛选同时作用于图库列表、目录视图、日期视图、搜图结果、标签导航页与预览作用域。
- **标签导航页**：三级树（分类 → 子类 → 标签）。只有**标签叶子**打开图片网格 —— 父节点主区只列子节点，且**零命中的标签不进列表**，让「这里暂时没图」与「没有匹配你的搜索」保持可区分。

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

### 数据安全与备份

数据库就是单个 SQLite 文件（`photos.db`）。备份它很简单：在应用**没有运行**时把文件复制一份即可。

**什么时候该备份**

- 首次添加一个非常大的目录之前
- 把应用升级到新版本之前
- 在设置里做实验性清理或 VACUUM 之前

**怎么备份**

1. 完全关闭应用（托盘图标 → 退出）。
2. 找到 `photos.db`：
   - **开发时**：在系统应用数据目录下（Electron `app.getPath('userData')` 对应的开发态应用名）。
   - **安装后**：在 `aurora-gallery` 对应的当前用户应用数据目录下。
3. 把 `photos.db` 复制到你的备份位置。

**怎么恢复**

1. 完全关闭应用。
2. 用备份副本覆盖当前的 `photos.db`。
3. 重启应用。

> 请**勿**把 `photos.db` 提交到 Git。

## 版本说明（摘要）

各版本的详细变更请阅读 **[`CHANGELOG.md`](CHANGELOG.md)**。当前线：**1.3.0**（界面与交互批次：独立首页、可自定义快捷键、面板透明度与窗口背景两个外观维度、路径栏与导航历史、图片 AI 内容标签、设置页二维码、网页端设置页只读镜像；其余版本条目以 changelog 为准）。

## 历程

从首次提交（2026-04-05）到现在，约六个月，四个阶段。

- **2026-04 · 先能用。** Web 预览支持移动端滑动、切图有加载态、字幕可用（`1.0.1`）；随后做了一轮完整的中英双语，覆盖的是**动态界面**（侧栏、统计条、设置页）而不只是静态文案（`1.0.2`）。
- **2026-05 · 再站得住。** ESLint 70 个错误清零、删掉孤儿模块、日志分级落地（`1.0.3`）；扫描 / 缩略图补全 / 查重 / HLS 接入结构化任务日志（`1.0.4`）；扫描分阶段耗时遥测、预览缓存击穿、Web 服务提供 `ETag` 与 `304`（`1.1.0`）。
- **2026-09 → 10 · 会找东西。** 基于 SigLIP 2 的语义搜图（约 412 MB）、YuNet + InsightFace 检测识别与 Chinese Whispers 聚类的人物分组（约 13 MB）、图片对比；记为 `1.2.0`，对已有图库**无破坏性迁移**。
- **2026-10 → 现在 · 变成你自己的。** 独立首页、可自定义快捷键、面板透明度与窗口背景两个新外观维度、路径栏与导航历史、AI 内容标签与标签树（`1.3.0`）；其后是标记 / 评分 / 用户标签、非破坏的旋转 / 翻转 / 裁剪、Live Photo 配对、为 libvips 读不了的格式自研解码器，以及 GPU 能力探测。

逐版本细节见 [`CHANGELOG.md`](CHANGELOG.md)。

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
- `npm run bundle-models`：把随包内置 AI 模型（人脸检测 + 识别、搜图编码器）生成到 `models/` 供打包；`--face-from` / `--search-from` 可从已有缓存复制而不联网
- `npm run smoke:db`：数据库冒烟脚本（`scripts/db-smoke.js`）

## 打包可执行文件

### Windows

```bash
npm install
npm run dist:win
```

常见输出（文件名中的版本号与 `package.json` 的 `version` 一致，例如当前为 `1.3.0`）：

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
  main.js                  # Electron 主进程入口（窗口、IPC、后台任务）
  preload.js               # 渲染层安全桥接（photoAPI）
  web-server.js            # 内置 Web 服务（API、静态页、视频/字幕/HLS）
  database.js              # SQLite 数据访问层
  scanner.js               # 扫描与入库流程
  scan-worker.js           # 扫描 worker
  playback-strategy.js     # 媒体播放策略（直连 / HLS）
  hls-session-manager.js   # HLS 转码会话管理
  hls-attach.js            # HLS 前端挂载辅助
  video-probe.js           # ffmpeg 视频探测（时长 / 编码），带记忆化
  video-frame-thumb.js     # 视频首帧缩略图与无帧占位图
  db-heavy-read.js         # 重量级读取 SQL（与读工作池共用）
  db-read-runner.js        # 把重量级读取派进工作池
  db-read-worker-pool.js   # 读工作池（3 个 worker，队列上限 100）
  catalog-cache-db.js      # 浏览计数背后的独立 SQLite 缓存库
  photos-total-cache.js    # `getPhotos` total 的记忆化
  stats-agg-cache.js       # `getStats()` 聚合结果的记忆化

  main/                    # 此目录下每个文件在运行时都由 main.js 触达
    db-write-queue.js       # 唯一的写锁准入点，4 个优先级
    data-dir.js             # 图库数据放哪：位置判定 / 迁移 / 校验
    deferred-indexes.js     # 延迟（Phase 5）索引 DDL —— 唯一真相源
    exif-meta.js            # EXIF 解析 —— 唯一入口
    file-hash.js            # 查重指纹；两条入口共用同一个 SHA-256
    perceptual-hash.js      # dHash 计算
    thumb-format.js         # 缩略图编码格式 —— 唯一真相源
    thumb-regen-queue.js    # 缩略图全量重跑的物化队列
    sharp-input.js          # 「libvips 读不了」→ 能喂给 sharp 的输入
    image-decoders/         # libvips 读不了的格式，自研解码器
      index.js               #   BMP / ICO / PNM / TGA / QOI（永远先让 sharp 试）
    raw-preview.js          # 从 RAW 容器里取出内嵌 JPEG 与 EXIF
    image-edit.js            # 图像层编辑算子（桌面 IPC 与网页 API 共用）
    photo-edit-service.js   # 写盘后的收敛：缩略图 / dHash / 库行 / 缓存
    live-photo.js           # 识别配对图片与其伴生视频
    live-photo-pair.js      # 配对任务；双向记账
    org-meta-filter.js      # 组织元数据的取值域与筛选谓词
    photo-list-columns.js   # 图片列表行携带的列清单
    progress-pct.js         # 任务进度百分比 —— 唯一来源
    eta.js                  # 任务剩余时间（ETA）—— 唯一来源
    ai-index-gate.js        # AI 索引任务能否启动（仅 VACUUM / 重建时）
    face-service.js         # 人脸检测 / 分组 worker
    semantic-search.js      # 语义搜图（文本 → 图片）worker
    semantic-tags.js        # 零样本内容标签（只读索引连接）
    similar-detection.js    # 视觉相似分组
    tag-nav.js              # 标签导航页只读数据服务（分类树 / 标签 / 图片）
    gpu-probe.js            # 这台机器有没有可用的 GPU 加速
    browse-requests.js      # 浏览请求合并
    interaction-preempt.js  # 用户交互抢占后台任务
    maintenance-guard.js    # 维护任务的忙判定
    database-maintenance.js
    sql-id-list.js          # 安全的 `IN (...)` 构造（宿主参数上限）
    startup-metrics.js      # 启动阶段耗时打点
    logger.js               # 分级结构化日志

  renderer/
    index.html              # 桌面端页面结构
    styles.css              # 桌面端样式
    theme-polish.css        # 主题层（叠在 styles.css 之上）
    navigation.css          # 侧栏 / 目录树 / 路径栏样式
    app.js                  # 桌面端入口与状态编排
    api.js                  # 渲染层 API 封装
    settings.js             # 设置读写与同步
    logger.js               # 渲染端日志
    i18n.js                 # 中 / 英文案（data-i18n）
    utils.js                # 共用取值域（卡片尺寸 / 每页条数 / 网格比例）
    shortcuts.js            # 快捷键注册表 —— 唯一真相源
    shortcut-settings.js    # 「快捷键」设置面板
    nav-history.js          # 后退 / 前进栈与按钮态
    path-crumbs.js          # 路径栏分段、超长折叠与同级下拉
    sidebar-tree.js         # 目录树构建与渲染
    ui-shell.js             # 顶层 UI 状态（任务/Tunnel/提示）
    ui-events.js            # 事件绑定
    ui-navigation.js        # 导航切换
    ui-grid.js              # 网格渲染
    ui-preview.js           # 预览交互（缩放/幻灯片/收藏等）
    ui-overlays.js          # 弹窗与遮罩层
    ui-settings.js          # 设置页渲染逻辑
    ui-duplicates.js        # 重复图分组与预览
    preview-flow.js         # 预览流程（图片/视频切换）
    preview-crop.js         # 预览内的裁剪选区
    org-meta-ui.js          # 标记 / 评分 / 用户标签界面
    ai-views.js             # 搜图与人物视图（结果落进主图片网格）
    ai-views.css
    tag-nav-ui.js           # 标签导航页界面（侧栏三级树 + 主区）
    tag-nav.css
    qr-code.js              # 二维码渲染适配层（包住 vendor 编码器）
    scan-flow.js            # 扫描流程编排

  web/
    index.html              # Web 端页面（样式+脚本内嵌）
    login.html              # Web 登录页
    vendor/
      hls.min.js            # HLS 播放库
    css/                    # 与桌面端共用的样式表
      gallery-design.css
      people.css
      photo-compare.css
      semantic-search.css
      settings-page.css
      tag-nav.css
      ai-web-views.css
    js/
      app.js                # 网页端逻辑
      ai-views.js           # 搜图与人物视图（侧栏独占）
      people.js             # 人脸分组阈值（镜像 ai/face-settings.js）
      photo-compare.js      # 对比选择集与查看器
      photo-info-fields.js  # 图片信息面板可选字段 —— 唯一真相源
      semantic-search.js    # 匹配阈值范围（镜像 ai/index-store.js）
      settings-page.js      # 本机浏览偏好
      tag-nav.js            # 标签导航页
      web-theme-shared.js   # 网页端主题模型（与桌面端 token 同源）
```


````

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
````

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

MIT —— 完整文本见 [`LICENSE`](LICENSE)。
