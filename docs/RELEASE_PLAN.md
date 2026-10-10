# Aurora Gallery / 拂晓图库 — 版本更新计划（最小更新）

> **原则：最小更新。** 每个小版本只推进**一个主题**，包含 1–3 个可独立验收的最小闭环；不把不相关功能捆绑进同一版本，不为远期功能排死日期，不做大爆炸重构。
> 计划制定：2026-09-27
> 当前版本：`1.3.0`（`package.json`）。2026-10-05 的「界面与交互批次」（独立首页 / 可自定义快捷键 / 外观两维 / AI 内容标签 / 二维码 / 网页端设置页镜像）已随 1.3.0 记入 [`CHANGELOG.md`](../CHANGELOG.md) 正式版本段；1.2.0 的 AI 搜图 / 人脸分组 / 图片对比见同文件的历史段。
> 与 Lap 的功能对比与差距分析见 [`docs/lap-comparison.md`](lap-comparison.md)。

---

## 版本节奏

| 类型 | 周期 | 说明 |
|------|------|------|
| Patch（`1.x.y`） | 1–2 周 | 文档对齐、小修、稳定性 |
| Minor（`1.x.0`） | 按主题推进，不设固定周期 | 一个新主题，做完一个验收一个 |
| Major | — | 当前阶段不预设 |

**与旧版计划的差别**：不再预设「1.2.0 架构重构 → 1.3.0 Web + 发布」的固定编排；架构重构改为**小步并入各版本**，不再独占版本号。

---

## 当前状态（2026-10-05）

- 桌面端已完成模块化拆分（`src/renderer/*` 多文件协作）；主进程侧 `src/main/` 已收敛为「入口可达」的模块集合（不可达模块由 `module-reachability-regression` 守护）。
- 网页端与桌面端能力基本对齐（筛选、预览、字幕、随机播放、人物、对比、浏览与外观设置）。
- **已记入正式版本（`1.3.0`）**：独立首页、可自定义快捷键、面板透明度与窗口背景、路径栏与导航历史、图片 AI 内容标签、设置页二维码、内置模型随包播种、后台写库调度收口（2026-10-05）。
- **已记入正式版本（`1.2.0`）**：本地 AI 搜图、人脸识别与人物分组、图片对比（2026-09-25 / 09-27）。
- **已完成但文档未结项**：原 ROADMAP 的 P0（可观测性、数据安全、环境固化）与 P1（扫描埋点、预览缓存版本号、管理页紧凑布局）。

---

## 1.2.0 — 收尾与对齐（零新功能，最小一步）✅ 已发布 2026-10-03

**目标**：把手上的东西记录、验收、对齐，作为后续所有版本的基线。**以文档与验收为主，尽量不动功能代码**（用户要求的即时 UI 调整按需插入，见下）。

任务：

- [x] **静态接线验收**（2026-09-27）：确认三项功能端到端贯通——导航入口（`data-tab="people"`）、资源挂载（`index.html` head 内的 3 个 CSS 与 3 个 JS，已全部移入 head）；IPC 链路（`preload.js` 的 `aiSearch*` / `faceAction` → `main.js` 的 `ai-search-*` / `face-action`）与装配层（`app.js` 的 `SemanticSearchUI.mount` / `PeopleUI.mount` / `PhotoCompare.mount`）均完整。
- [x] **版本号对齐**：`package.json` / `README.md` / `README.zh-CN.md` 统一为 `1.1.0`（2026-09-27 当时），随后于 2026-10-03 随发版 bump 到 `1.2.0`；应用内「关于」用 `%VERSION%` 动态读取；`version-check` 通过。
- [x] **跑检查**：`node scripts/run-regressions.js` 全 PASS（当时 16 项，导入搜索页用例后 17 项，导入人脸并发热时序后 18 项）；`npx eslint .` 0 error / 5 warning（与基线一致）；`node scripts/version-check.js` OK。
- [x] **打包产物核验**（2026-09-27）：`electron-builder --dir` 产物已核验——`拂晓图库.exe`、`app.asar`（3057 条目，含 `src/` 与 `node_modules` 2961 条）、`resources/bin/cloudflared.exe` 均在位；内嵌 `package.json` 为 `version 1.1.0` / `main: src/main.js`；用打包后的 Electron 二进制实测 `better-sqlite3`、`sharp`、`onnxruntime-node`、`@huggingface/transformers` 四个生产依赖**全部可加载**；三项功能共 12 个文件（js / css / worker / preload / index.html）确认入包。
- [x] **修复打包图标与版本信息**（2026-09-27）：`build.win.signAndEditExecutable: false` 导致 electron-builder 跳过 rcedit，产物仅把 `electron.exe` 改名，图标与 `ProductName` / `FileDescription` / `FileVersion` 全部保持 Electron 默认值（属性显示 `Electron` / `GitHub, Inc.` / `41.5.0`）。已移除该开关，新增多尺寸 `build/icon.ico`（16/24/32/48/64/128/256）并重打包验证：7 档图标 DIB 全部写入 exe，版本资源变为「拂晓图库」/「拂晓AI」。同时恢复了被意外移除的 `package.json` 的 `scripts` / `devDependencies` / `build` 三段（保留 `@huggingface/transformers` 依赖）。
- [x] **AI 搜图入口迁至左侧导航，改为独立页面**（2026-09-27，用户要求）：新增 rail 项 `data-tab="search"`（`nav.search`），`semantic-search.js` 增加 `page` 模式（`#searchPage` / `.search-page`，section 而非 dialog），`showTabContent` 增加 `search` 分支，侧栏在搜索页让位（`:not(.settings-page-open)` 保护），`settings.js` 白名单加入 `search` 以支持原路返回。新增 `scripts/search-page-regression.js` 并接入回归；`layout-regression` / `navigation-regression` 的导航项断言同步更新。`run-regressions` 17/17 PASS，lint 0 error。
- [x] **人物页索引期间实时显示 + 文案换行修复**（2026-09-27，用户要求）：索引运行中人物页原先只显示一句「索引处理中」，现在改为实时列出已识别分组并按人数变化自动增量刷新；文案态从 `people-grid` 切到 `people-message`，修掉被 160px 网格列压成逐字换行的问题。主进程侧 `FaceService` 新增 `concurrentReads`（只读操作可并发另起 worker，不写任务状态），`face-worker` 每批上报人物总数（节流 1.5s）。新增回归 `scripts/face-concurrency-regression.js`（写事务持锁下的并发只读时序）、`scripts/face-live-index-smoke.js`（真实模型跑索引验证实时性）；`ai-lifecycle-regression` 与 `people-page-regression` 各补一组用例。三个新用例都做了负例验证（关闭并发读 / 不上报人数 / 不切文案布局，均能准确报错）。
- [ ] **真实窗口验收**（待人工）：在桌面窗口实际点一遍三项功能（AI 搜图需先下载模型、人脸需先建索引），并确认新的「搜图」页与侧栏让位、设置页往返正常；另确认人物页在索引进行中是否实时出结果、提示文案不再逐字换行。
- [x] **三项记入 `CHANGELOG.md` 正式版本段**（2026-10-03）：`[Unreleased]` 下的 Added / Changed / Fixed 已移入 `## [1.2.0] - 2026-10-03`，`[Unreleased]` 只留空的头部与 `### Planned`（并从 Planned 里摘掉已发布的 1.2.0）；同步 bump `package.json` / `package-lock.json` / `AGENTS.md` / `CLAUDE.md` / `README.md` / `README.zh-CN.md` 到 `1.2.0`。
- [x] **发版检查单落进脚本**（2026-10-03）：`version-check` 原先只扫 `src/` 与两份 README，`AGENTS.md` / `CLAUDE.md` 漂到别代也无人发现（`CLAUDE.md` 实际停在 `1.0.3`，差两代）。现已纳入扫描，并把 `**Version**:` 计入发布声明关键词，让这类漂移无法复发。

**验收**：README 与 `package.json` 版本一致（`version-check` 已覆盖两份 README / `AGENTS.md` / `CLAUDE.md`；✅ 通过）；CHANGELOG 覆盖 AI 三项（✅）；三项功能在打包版可用（待人工窗口验收）。
**回滚**：本版本无功能代码改动，风险为零。

**进展记录**

- 2026-09-27：完成静态接线验收、版本号对齐、回归 / lint / 版本检查、打包产物核验；补齐 `version-check` 漏检；修复打包图标与版本信息（`signAndEditExecutable` + 多尺寸 `.ico`）并恢复 `package.json` 丢失的三段元数据。另按用户要求把 AI 搜图入口迁到左侧导航并改为独立页面（+1 回归用例）。仅剩真实窗口人工验收与发版决策。
- 2026-09-27（重新打包）：`release/win-unpacked` 被外部句柄锁住，`npm run pack` 无法清理该目录。已按下方「已知阻碍」的绕行方案完成回填，`release/win-unpacked` 现为含「搜图导航页」与正确图标/版本信息的完整产物（167 个文件，与干净目录产物逐文件 sha1 一致）。
- 2026-09-27（人物页实时化）：按用户要求让索引进行中的已识别结果显示在人物页（不再等索引结束），并修掉提示文案的逐字换行。改动涉及主进程任务基类（`concurrentReads`）、人脸 worker（上报人物数）、人物页 UI 与 CSS。验证：真机冒烟（24 张样例图）索引中上报人物 5 次、并发只读返回 2 组；全量回归 18 项 PASS、lint 0 error。剩余人工验收项已并入上面的「真实窗口验收」。
- 2026-10-03（发布 `1.2.0`）：把 2026-09 落地的三项（AI 搜图 / 人脸分组 / 图片对比）从 `[Unreleased]` 移入 `## [1.2.0] - 2026-10-03`，并把版本号 bump 到 `1.2.0`。顺带修掉一个**持续两代的漂移**：`CLAUDE.md` 的 `**Version**` 一直停在 `1.0.3`，而 `version-check` 只扫 `src/` 与两份 README，所以从没报过 —— 现已把 `AGENTS.md` / `CLAUDE.md` 纳入扫描，并把 `**Version**:` 加进发布声明关键词。踩到的另一个坑：`当前线` 这类**发布声明行上不能出现别的版本号**，哪怕写成历史（「上一版 `1.1.0`」）也会被判漂移 —— 该行只写当前版本。文档同步 `README.md` / `README.zh-CN.md` / `AGENTS.md` / `CLAUDE.md` / 本计划；`version-check` 报 `v1.2.0` 零漂移。

**已知阻碍（下次打包前处理）**

- **`release/win-unpacked/resources/app.asar` 被外部句柄占用（已确认为真实锁，非误报）**：该文件从 2026-05-24 版本起即被某进程以「允许读写、**不允许共享删除**」的句柄持有，导致 `electron-builder` 的 `EnsureEmptyDir` 报 `The process cannot access the file` 而中止。已排除的可能：不是 app 运行实例（当时的 3 个实例从 `%TEMP%` 启动，未加载 `release/` 下模块）、不是以映像/模块方式映射（全进程模块扫描无命中）。可疑持有者为本机的网盘 / 同步 / 挂载类常驻进程（`BaiduNetdisk*`、`quark`、`clouddrive_desktop_widget`、`nas_service`、`RaiDrive.Mount.Service`、`wpscloudsvr`）——若它们把 `C:\code` 纳入备份范围即会如此。
  - 诊断口径：`fs.unlinkSync` 在本沙箱会被安全删除层拦截（错误码为 `undefined`），**不能作为锁的判据**；应改用 PowerShell 的 `[System.IO.File]::Open($p,'Open','ReadWrite','None')`（独占打开失败＝有外部句柄）。
  - 绕行方案（已验证）：① `npx electron-builder --dir -c.directories.output="<干净目录>"` 出产物；② 对旧 `app.asar` 用 `openSync('r+') → ftruncateSync(0) → writeSync` **原地覆写**（该文件允许共享写，允许删除被拒；重命名同样被拒）；③ 其余文件 `copyFileSync` 补齐。
  - 彻底解法：关闭上述网盘 / 同步客户端或把 `C:\code` 从备份范围排除，重启后再跑 `npm run pack`。
- **`build/icon.ico` 尚未入库**：`build/` 既未被 git 跟踪也不在 `.gitignore`（`git log --all -- build/` 为空），文件由 `src/web/app-icon-512.png` 现场生成（sharp 生成 16/24/32/48/64/128/256 七档）。全新 clone 打包会退化为 Electron 默认图标。建议把 `build/icon.ico` 作为源资源提交，或把生成器放进 `scripts/`。
- ~~**CI 的 `npm test` 步骤不可用**~~ **已解决（2026-10-03）**：`package.json` 现已定义 `"test": "node scripts/run-regressions.js"`，CI 的 `npm test` 步骤可用。回归入口仍是 `node scripts/run-regressions.js`（当前 30 项全 PASS，可直接用 node 运行，无需 Electron）。

---

## 1.3.0 — 界面与交互批次 ✅ 已发布 2026-10-05

**目标**：把「看得见、摸得着」的界面与交互补齐 —— 独立首页、可自定义快捷键、外观再扩两维、路径栏与导航历史、图片 AI 内容标签、设置页二维码，并把网页端设置页做成桌面端的只读镜像。**不占「组织能力基础」的号**：原 `1.3.0` 起的编排整体顺延一档（见下方 1.4.0）。

已落地（逐条细节见 [`CHANGELOG.md`](../CHANGELOG.md) 的 `## [1.3.0] - 2026-10-05`）：

- [x] **独立首页 + 导航 rail 重构**：新增 `#homePage`（独立页面、纯导航、零副作用、10 个互异落点）；rail 定为三段（首页 ｜ 视图 4 项 ｜ 重复 / 设置），首页必须在最上。
- [x] **可自定义快捷键**：唯一真相源 `src/renderer/shortcuts.js`（动作注册表 + 绑定归一 + scope 冲突判定），设置页负责录制与落库，主进程只校验形态不认 id。
- [x] **外观扩两维**：第五维「面板透明度」、第六维「窗口背景」（实色 + 三档亚克力），与前四维正交，22 套预设一概不碰。
- [x] **路径栏与导航历史**：面包屑 `path-crumbs.js` + 前进 / 后退 `nav-history.js`；`applyLocation` 期间抑制记录。
- [x] **图片 AI 内容标签**：零样本分类（SigLIP2 图片向量 × 词表向量点积），不重编码图片；标签存词表下标、随界面语言走；点击胶囊直达搜图。
- [x] **设置页二维码**：只落 Network 面板，载荷与 `copyWebUrl` 同源、绝不含密码、编码强制 UTF-8、静区 4 模块。
- [x] **网页端设置页只读镜像**：8 面板骨架与桌面端同名同序；桌面端拥有的值以取值文本呈现、不是灰控件；下拉一律从既有 `<select>` 克隆。
      ⚠️ **2026-10-06 已回退**：用户要求「只保留浏览界面相关的、只影响网页显示的部分」，那 6 个只读镜像面板整块删除，现为 **2 面板**（浏览与显示 / 外观与行为）。契约见 `CONTRACTS.md` §网页端设置页；本行保留为历史记录。
- [x] **后台写库调度收口**：四档优先级队列、启动期唯一提交点、AI 索引准入剥成独立闸门、清掉 3121 行孤儿模块链。
- [x] **内置 AI 模型随包播种**：`models/` 经 modelKey / sha256 两道闸门播种，首次使用不必先点下载（`npm run bundle-models`）。

**验收**：`npm test`（`scripts/run-regressions.js`）exit=0、末项 `ai-lifecycle-regression` PASS；`npx eslint .` 0 error / 2 warnings（既有基线，两条在 `src/web/js/app.js`）；`npm run version-check` OK（`v1.3.0` 零漂移）。桌面端与网页端的关键交互均以无头 Electron + CDP **真实事件探针**验证过。
**回滚**：无破坏性迁移（数据库只增列 / 增表，老库启动自动补齐）；各功能均可单独停用。

**进展记录**

- 2026-10-05（发布 `1.3.0`）：本次全部改动一次性发版。发布前重跑三道闸门并修掉一个**守护自身的假红**：`version-check` 用裸 `/v\d+\.\d+\.\d+/` 扫全文件，把 `index.html` 注释里引用的**第三方图标库版本**（`lucide-static v0.544.0`）判成了应用版本漂移 —— 注释不会把版本号带给用户，不该参与校验；已让该脚本对 `.html`/`.htm` 先剥 HTML 注释再扫（HTML 注释不可嵌套，惰性匹配是精确的），注释里的来源说明因此得以保留。顺带处理**版本号编排冲突**：原计划把 `1.3.0` 留给「组织能力基础」，但先落地的是本批次，故原 `1.3.0` 起的编排整体顺延一档。

---

## 1.4.0 — 组织能力基础

**目标**：补齐组织元数据，建立可复用的筛选与索引底座，为智能相册铺路。

任务：

- [ ] 数据库迁移：`rating`（0–5）、`flag`（none / pick / reject）、`comment` 字段；`tags` 独立表 + 关联表。
- [ ] 预览页与网格：星级控件、PICK / REJECT 快捷键、标签输入与补全。
- [ ] 集合（Collections）：新建 / 重命名 / 增删成员，不移动原文件。
- [ ] 筛选协议统一：评分、标记、标签、集合纳入现有筛选，桌面与 Web 一致。
- [ ] 索引：`rating`、`flag` 建索引；标签走关联表索引。

**验收**：筛选可组合评分 / 标记 / 标签 / 集合；两端行为一致；迁移前自动备份、可回滚；`npm test` / `npm run lint` 通过。
**回滚**：迁移脚本必须提供回滚路径。

---

## 1.5.0 — 智能相册与浏览维度

**目标**：把筛选变成可保存的视图，扩展浏览维度。

任务：

- [ ] 智能相册：保存规则（筛选组合 + 分组 + 排序），桌面 / Web 共用查询规则与持久化协议。
- [ ] 浏览维度：从 EXIF 提取并索引相机、镜头、GPS，新增对应筛选。
- [ ] 缩略图尺寸档位：新增 512 / 768 / 1024，配合缓存与后台补全。
- [ ] 重复页增强：可回收空间汇总 + 批量删除（二次确认）。
- [ ] 浏览「全量随机」排序选项（默认仍为当前结果集）。
- [ ] ANN 索引预研：先在隔离副本做分规模基准，再决定方案（未做基准前不上 ANN）。

**验收**：智能相册规则跨重启保存并在 Web 生效；相机 / 镜头筛选准确；10 万+ 库网格滚动不卡顿。

---

## 1.6.0 — 地图视图

**目标**：把带 GPS 的图片按筛选聚类浏览。

任务：

- [ ] 承接 1.5.0 的 GPS 索引，实现地图聚类视图与预览联动。
- [ ] **地图图源合规**：使用合规地图服务（如高德 / 天地图）；实现前先做地图数据合规校验（国界线、境外边界、地名表达）。

**验收**：聚类与筛选联动正确；地图数据合规审查通过。

---

## 1.7.0 — 导入与文件操作闭环（最高风险）

**目标**：从「只读扫描」升级到「可安全整理文件」。

任务：

- [ ] 拖拽导入 / 剪贴板粘贴导入。
- [ ] 按日期组织导入：日 / 月 / 年 / 单目录布局，保留原文件名，重复跳过。
- [ ] 安全移动 / 复制 / 删除；文件系统同步入口。

**验收**：破坏性操作可回滚或有备份；每批后一致性校验通过；失败立即停止。
**风险控制**：必须遵循「先警告 + 列清单 + 二次确认 + 先备份 + 小批量」；删除优先走系统回收站。

---

## 1.8.0 — 复合资源

**目标**：把成组媒体当一个对象处理。

任务：

- [ ] RAW + JPEG/HEIC 配对显示为一体，文件操作时保持成组。
- [ ] Apple Live Photo / Google Motion Photo：识别配对、动态播放、统一筛选。
- [ ] RAW 缩略图 / 预览渲染选项（RAW 渲染 vs 相机内嵌预览）。

**验收**：配对资源在浏览、筛选、文件操作中保持一体；动态图片可播放。

---

## 1.9.0 — 内置编辑

**目标**：轻量编辑闭环。

任务：

- [ ] 裁剪、旋转、翻转、缩放与基础调整。
- [ ] 写回策略：默认导出副本；写回原图需显式确认并备份。

**验收**：编辑可预览、可撤销；写回有备份与确认。

---

## 并行原则（贯穿所有版本）

- **架构重构小步并入**：`src/main.js` 拆 `ipc/` / `tasks/` / `platform/`，`src/renderer/app.js` 拆 `state/` / `features/*`；新功能一律落到新模块，不继续往大文件堆，但不单独占版本号。
- **可观测性延续**：新任务（标签索引、ANN、导入、文件操作）全部接入统一后台任务面板 + `logger.task()`。
- **桌面 / Web 双端一致**：默认要求一致；Web 仅「只读或受限」的例外要显式标注。
- **文档与版本同步**：每次发版跑发布检查单（版本号 / CHANGELOG / README / tag）。

---

## 明确不做

- 不为远期功能排死日期。
- 不在一个版本里捆绑多个不相关主题。
- 不做大爆炸重构（结构迁移与功能改动分开）。
- 不引入未验证的依赖或索引方案（如未做基准前不上 ANN）。

---

## 变更记录

- 2026-10-05：发布 `1.3.0`（界面与交互批次）。**编号整体顺延一档** —— 原计划把 `1.3.0` 留给「组织能力基础」，实际先落地的是首页 / 快捷键 / 外观两维 / AI 标签 / 二维码 / 网页端设置页镜像这一批，故自 `1.3.0` 起各版本 +1（原 1.3.0 → 1.4.0 … 原 1.8.0 → 1.9.0），`CHANGELOG.md` 与 `docs/lap-comparison.md` 已同步。同日修掉 `version-check` 的一个假红（裸 semver 正则扫到了 HTML 注释里引用的第三方图标库版本）。
- 2026-09-27：按「最小更新」原则重写。原 1.2.0「架构重构」、1.3.0「Web 侧 + 发布流程」并入本计划的并行原则与 1.2.0 收尾；新计划以 Lap 对比结果（`docs/lap-comparison.md`）为排期依据。
- 2026-05-10：上一版（1.0.4 / 1.1.0 / 1.2.0 / 1.3.0 编排）。
