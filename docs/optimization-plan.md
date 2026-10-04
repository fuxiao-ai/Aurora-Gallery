# 项目检查与优化实施记录

日期：2026-09-13。基于当前工作区实施，保留开始时已有的未提交修改。未操作用户图库，未提交或发布版本。

## 本轮方案与完成情况

| 顺序 | 问题 | 已实施措施 | 验证 |
| --- | --- | --- | --- |
| 1 | Web 子目录数量错误、空父目录没有封面 | 按实际后代照片分组计数和选封面；兼容两种路径分隔符、根目录、通配字符与 Unicode 路径 | query-regression |
| 2 | 日期上界遗漏 ISO 时间和最后一毫秒 | 使用经过日期校验的次日半开区间；数据库列表与预览范围共用日期边界函数 | query-regression |
| 3 | Worker 故障波及其他请求、请求可能永不结束 | 每个槽位独立失败与惰性重建；处理退出和序列化错误；队列最多 100 个等待任务；120 秒期限包含排队时间 | worker-pool-regression：故障隔离、重建、退出、超时、队列上限、终止清理 |
| 4 | 重读仍在主线程执行 | 桌面和 Web 的列表、目录照片、搜索走有界只读池；Web 日期列表与日期分组也迁入池；保留共用查询实现 | maintenance-regression：真实读取 Worker 和 Web handler 验证 |
| 5 | setTimeout 内的数据库维护仍阻塞主线程 | 新增维护模块和专用 Worker，复用维护 SQL；与扫描、缩略图、哈希、清理任务互斥；等待线程退出再释放维护状态；错误记录并提示 | 临时数据库重建标志、VACUUM、非法操作失败测试 |
| 6 | 原图同步读取占用主线程并整文件驻留 | 普通原图使用文件流转换为 Web ReadableStream；保留 RAW 转码路径 | 静态检查；未做原图界面交互验证 |
| 7 | Web 路径前缀查询扫描整个索引 | 延后建立 folder_path COLLATE NOCASE 索引，匹配 LIKE 的比较规则 | 查询计划及 100 万条样本；建索引前后结果一致 |
| 8 | 发布缺少检查，版本文档漂移 | 增加 npm test、PR 检查和发布前检查；修正文档版本与冒烟输出；忽略 Android 本机配置和生成目录 | lint、version-check、回归全通过 |

维护期间主连接的 busy_timeout 暂时设为 0，避免交互写入同步等待维护写锁，结束后恢复为 8000 毫秒。读取失败直接传给调用方，不再通过无界临时 Worker 绕过队列上限。

## 验证结果

- `npm test`：数据库冒烟、查询、Worker 故障、维护及 Web handler 回归共四个脚本通过。
- ESLint：0 错误，5 个既有未使用变量警告。
- version-check：通过，发布版本仍为 1.1.0。
- 本地通过 Node 直接运行脚本；原生模块测试使用 Electron 41.5.0 内置 Node 24.15.0。开发环境要求仍为 Node 22，CI 配置使用 Node 22；未把 Electron 内置 Node 与开发 Node 版本混为一谈。
- 未运行真实图库迁移或压缩；测试数据库在临时目录创建并清理。未启动实际应用验证完整窗口、视频、LAN 或移动端流程。

## 合成数据性能记录

可通过 `npm run benchmark:db` 复现，原始记录在 [performance-results.json](performance-results.json)。样本包含 10 万和 100 万条元数据，不含真实图片、缩略图 BLOB、网络与界面渲染。记录为单次测量，不是 p95 或速度保证；缓存、索引创建及硬件会影响结果。

最终校验样本的 100 万条结果：

| 操作 | 耗时 | 测量期间主线程最大定时器延迟 |
| --- | ---: | ---: |
| 日期列表 | 159 ms | 8 ms |
| 首页 | 59 ms | 9 ms |
| 最后一页（OFFSET） | 114 ms | 6 ms |
| 子目录封面，无新索引 | 326 ms | 11 ms |
| 子目录封面，增加前缀索引 | 110 ms | 10 ms |
| VACUUM（Worker） | 2840 ms | 12 ms |

路径前缀条件的查询计划由 `SCAN` 变为 `SEARCH ... (folder_path>? AND folder_path<?)`。子目录测试同时断言返回照片数量为 10,000，避免将空结果误认为性能提升。测量进程 RSS 峰值约 129 MB，包含 Worker，不代表 Electron 完整应用内存。

## 后续优化的判断标准

- 暂保留 OFFSET 和精确总数，保持现有页码契约。当前合成数据尾页 114 ms；若真实图库尾页或多用户并发持续超出交互预算，再引入游标 API 与总数缓存，并同步两个前端。
- 本轮将数据库维护独立为模块，并复用查询和日期逻辑。后续按具体功能逐步迁出大型 main/app 文件；不以行数为目的整体重写，避免干扰已有未提交功能。
- 当前基准没有覆盖扫描吞吐、RAW、HLS 与网络磁盘。下一轮使用脱敏真实图库和实际设备记录冷启动、切图与视频播放，作为这些专项优化的依据。
- 新增路径索引增加磁盘和写入成本，安排在延迟索引 Worker 中建立；发布前在代表性的真实图库副本上评估索引构建时间及空间。

## 第二轮：启动记录与浏览请求取消

- 桌面为每轮浏览分配请求序号，通过 IPC 取消上一轮读取；窗口销毁或重新加载时清理请求。Web 使用 AbortController，并在 HTTP 连接提前关闭时向 Worker 池传递取消信号。目录封面的迟到成功和失败响应均不能覆盖最新页面。
- 排队任务取消后立即移出队列；执行中任务请求终止 Worker，等待旧线程退出后才允许补建，避免快速切换造成线程数量失控。原生同步 SQL 可能需要执行结束后线程才退出，因此不保证即时中断 SQL。
- 启动后的全文索引重建迁入维护 Worker；重建与完成标记在同一事务中提交，后续启动跳过重复重建。索引尚未就绪时搜索使用普通匹配，其他维护任务忙碌时延后执行。
- 启动前 60 秒记录阶段耗时、RSS 和事件循环延迟，写入应用用户数据目录下的 `startup-performance.json`，每次启动覆盖。`renderer.first-grid-paint` 表示首次网格绘制，不代表全部缩略图解码完成。当前运行实例未重启，本轮未取得真实启动测量结果。
- 回归增加窗口重载、取消隔离、目录封面响应竞态、启动记录文件以及全文索引完成标记检查；现在共 5 个回归脚本。运行方式：`node scripts/run-regressions.js`。
- 界面真实预览曾被浏览器安全策略阻止，本轮未绕过限制，未完成截图或实际窗口的视觉验收。此前共享样式与图标修改仍需在实际设备上核对。

## 第三轮：启动期写库任务串行化（实测定位 `database is locked`）

线上日志里的一串连锁失败：`Database maintenance failed: Error: database is locked`、
`post-window-deferred.fts-worker.failed`、
`maintenance-get-duplicate-hash-groups: Error: db-read-worker timeout`。

根因是启动期三个任务**各自 setTimeout 点火、互相不认识**，而它们写的是同一个
12.9 GB / 122 万行的 `photos.db`：

| 任务 | 起跑 | 旧行为 |
| --- | --- | --- |
| `thumbnail-fix-worker` | +5 s | 每次启动都跑一遍 `UPDATE ... WHERE has_thumbnail = 1 AND thumbnail IS NULL` |
| `performMaintenance('ensureFtsIndex')` | +6 s | `busy_timeout = 8000`，只在 `maintenanceBusy()` 放行时启动 |
| `deferred-index-worker` | +8 s | 7 次 `CREATE INDEX IF NOT EXISTS` + 10 次 `ALTER TABLE` 尝试 |

`maintenanceBusy()` 认识 FTS 维护、扫描、补图、AI 索引，**唯独不认识那两个延迟 worker**，
所以 FTS 维护在它们还在跑的时候点火，等满 8 秒后失败。实测记录显示它的失败时刻是
`+21033 ms` 起跑、`+29976 ms` 失败 —— 差值 `8943 ms`，正是 8 秒 `busy_timeout` 走满。

### 关键实测：那条数据修复语句会独占写锁

用与线上同构的合成库（120 万行 / 5.3 GB，带 4 KB BLOB）复现：

- 旧语句（整表一条 `UPDATE`，零命中）耗时 832 ms，**整个扫描期间写锁一直被占住**：
  另一条连接用 `busy_timeout = 0` 采样 56 次，53 次拿到 `database is locked`。
  说明「零命中的 UPDATE 不取写锁」这个直觉是错的 —— 写语句一开始就进入写事务。
- 真库上同一条语句冷缓存实测 **76 秒**（SQLite 走 `idx_photos_hasThumb` 取 122 万行 rowid
  再逐行回表读 `thumbnail`）。只要扫描超过 8 秒，维护 worker 必然失败。

（第一次实验把 `UPDATE` 放在主线程跑，结论是「不占锁」—— 那是错的：better-sqlite3 是同步 API，
扫描期间主线程根本没法去抢锁，全部尝试都落在语句结束之后。改到 worker 里跑才复现。）

### 改法

1. **新增 `src/main/db-write-queue.js`**：一条 Promise 链把这三个任务（以及手动触发的
   重建标记 / VACUUM）排成一队，同一时刻至多一个持写锁。队列状态并进 `maintenanceBusy()`，
   界面触发的维护因此会**等**而不是撞锁，并报出在等谁（`dbWriteBusyLabel()`）。
   三个会写库的重活（`enqueueScanTask` / `runThumbnailBackfill` / `runDuplicateHashDetection`）
   的反向准入也查同一个队列 —— 闸门双向才算闸门。
2. **`thumbnail-fix-worker` 改成一次性迁移**：修过就在 `schema_migrations` 记一笔，
   之后每次启动只做一次主键查询（实测 **3 ms**）。真需要修时按 id 区间分批**只读**扫描，
   只对命中的小批开写事务，批间 `setTimeout(step, 0)` 让出。
3. **报告如实化**：旧代码那句无条件的 `[db migration] created thumbnail missing indexes`
   每次启动都打印、无论有没有建索引、花了多久。现在回报建了哪几个索引、扫了多少行 / 修了多少行、
   各花多久。`db-read-worker` 的超时也带上 op 名（同时挤在队列里时分得出是谁被拖死）。

### 验证

- 真库（只读）：分批谓词覆盖 **1,224,615 / 1,224,615 行**，不重不漏，命中 0（库是健康的），
  全程 **3.4 s**。
- 合成库（120 万行 / 5.3 GB）跑真 worker：`scanned 1200000 / fixed 3 / batches 60 / 1737 ms`；
  同时另一连接以 `busy_timeout = 8000` 每 25 ms 抢写锁，**最大等待 653 ms、零次超时**
  （653 ms 那次是首个索引构建；真库两个索引都已存在，不会走到）。
  第二次运行 `already-applied`、`scanned 0`、**3 ms**。
- 过程中真跑出一个 off-by-falsiness：`if (!lo)` 判空表，而 `MIN(id)` 可以合法为 0，
  于是 id=0 的库整次修复被静默跳过。已改为 `bounds.lo == null` 显式判空，
  并在回归里插一行 id = 0 钉住它。
- 负例验过 4 次：去掉 `dbWriteQueue.isBusy()`、去掉队列链接、去掉「已修过」早退、
  改回 `!lo` 写法 —— 对应断言全部 FAIL，还原后复跑 PASS。

### 未处理（已由第四轮处理）

- ~~`src/database.js` 的 `applyDeferredPhotoIndexes()` / `ensurePhotosRootFolderCompositeIndex()` /
  `ensurePhotosAggPartialIndexes()` / `ensurePhotosDupHashPendingIndex()` 目前**没有调用点**，
  `deferred-index-worker.js` 里另有一份同样的 SQL。同一批索引有两个真相源，改一处容易漏另一处；
  值得单独一轮合并。~~ → 见下面「第四轮」。

## 第四轮：把真库当基准，按实测耗时重排数据库瓶颈

上一轮修完启动期写锁串行化之后，剩下的问题只能靠**真库实测**找，不能再凭直觉挑。
本轮先把真库（`%LOCALAPPDATA%\aurora-gallery\UserData\photos.db`，1,224,615 行 / 12.97 GB /
3,166,874 页）只读体检一遍，再把耗时排名前十的查询逐条量出来，最后只动真正慢的那两条。

### 真库体检结论

| 项 | 值 | 说明 |
| --- | --- | --- |
| `page_size` / `page_count` | 4096 / 3,166,874 | 12.97 GB，与文件大小对得上 |
| `freelist_count` | 426 页（约 1.7 MB） | 再次确认 VACUUM 几乎腾不出空间，收益只有 `ANALYZE` |
| 列顺序 | `thumbnail` 在第 12 列、`is_favorite` 在其**之后** | 见下面「为什么这里每次全表扫描都是 4 秒」 |
| 索引 | 25 个（含 4 个部分索引） | 覆盖面已经很全，本轮**没有新增任何索引** |

### 为什么这里每次全表扫描都是 4 秒

`photos` 把缩略图 BLOB 直接内联在行中间（见 `createCoreSchema`）。4 KB 以上的值走溢出页，
于是 1,224,615 行摊成 12.97 GB；而 `is_favorite` 这类列在 BLOB 之后，**读它就必须穿过整条溢出页链**。
只读体检里几个「看起来无害」的聚合因此都是 4 秒级：

| 查询 | 实测 | 执行计划 |
| --- | ---: | --- |
| `ORDER BY RANDOM() LIMIT 100`（12 列） | 3742 ms | `SCAN photos` + `TEMP B-TREE` |
| 同一句只取 `id` | 100 ms | 索引内排序，不回表 |
| `getStatsAgg` | 5803 ms | `SCAN photos` + `TEMP B-TREE FOR count(DISTINCT)` |
| 子目录封面 / 浏览首页 / 单目录 / 单日期 | 0.1 – 30 ms | 全部命中已有索引 |

**先量后改的一个反例**：一开始怀疑浏览列表慢，自己写了一条
`ORDER BY date_taken, file_name, id` 测得 3.77 秒 —— 但 `getPhotos` 实际用的是
`ORDER BY date_taken ASC NULLS LAST LIMIT ? OFFSET ?`，走 `idx_photos_date`，实测 **0.4 ms**。
差点为一个不存在的问题去加复合索引。

### 改法两条（都不动 schema）

1. **随机幻灯批次改两段式**（`src/database.js` `getRandomPreviewPhotoBatch`）：先在子查询里
   `SELECT id ... ORDER BY RANDOM() LIMIT n`，外层再 `WHERE id IN (...)` 按主键回表。
   随机性是同一份（内层仍是均匀无放回），调用方本来就只关心集合（web 端取回后自己洗牌）。

   | 场景 | 一趟式 | 两段式 | 倍数 |
   | --- | ---: | ---: | ---: |
   | 全部 `LIMIT 100` | 3742 ms | 100 ms | 37× |
   | 全部 `LIMIT 500` | 3694 ms | 122 ms | 30× |
   | 排除 80 个 id | 3807 ms | 254 ms | 15× |
   | 仅图片 | 629 ms | 166 ms | 3.8× |
   | 单目录 | 3.1 ms | 1.6 ms | 2× |

   计划相应从 `SCAN photos + TEMP B-TREE` 变成「内层覆盖索引排序 + 外层主键回表」。
2. **全库统计拆成 8 条标量子查询**（`src/db-heavy-read.js` `runGetStatsAgg` / 新导出的
   `statsAggSql`）：一条 `SELECT COUNT(*), SUM(file_size), COUNT(DISTINCT folder_path), ... FROM photos`
   的 SELECT 列表要 file_size / file_type / is_favorite / date_taken / folder_path 五列，
   没有索引能同时覆盖，只能整表扫；拆开之后每条各自命中一条**已有的**覆盖索引。

   | 指标 | 执行计划 | 耗时 |
   | --- | --- | ---: |
   | `COUNT(*)` | COVERING INDEX `idx_photos_hasThumb` | 0.5 ms |
   | `SUM(file_size)` | COVERING INDEX `idx_photos_size` | 80.7 ms |
   | `COUNT(DISTINCT folder_path)` | COVERING INDEX `idx_photos_folder` | 188.3 ms |
   | 视频张数 | COVERING INDEX `idx_photos_type` | 353.1 ms |
   | 视频体积 | INDEX `idx_photos_agg_root_folder_video`（只回表 25,585 行视频） | 116.3 ms |
   | 收藏张数 | COVERING INDEX `idx_photos_favorite` | 0.0 ms |
   | `MIN/MAX(date_taken)` | COVERING INDEX `idx_photos_date` | 0.0 ms |

   合计 **5803 ms → 748 ms（7.5×）**，8 个字段逐值一致。**不需要新增索引**。
   唯一会退化的情形是「视频占比很高的库」：`SUM(file_size) WHERE 视频` 需要 file_type 与
   file_size 两列，现有索引都不覆盖。本机库视频只占 2%（25,585 张）所以 116 ms 就够；
   真遇到视频为主的库，再补一个表达式索引
   `(lower(replace(file_type,'.','')), file_size)` 即可（合成库 25 万行上实测整条从 157 ms → 27.7 ms，
   索引仅 3.8 MB / 25 万行，推算 122 万行约 20 MB）。**本轮刻意不加**，不为少数库付索引写入成本。

顺带把随机批次挪出主进程：`/api/preview-random-batch` 原先在主进程里**同步**跑那条 3.7 秒的查询，
网页端一开随机幻灯，整个桌面端就冻住 3.7 秒。现在它和 `getStats` / `getFolderTree` 一样走
`runDbReadWorkerOnly`，`db-read-worker` 新增 `getRandomPreviewPhotoBatch` 这个 op。

### 上一轮遗留：延迟索引的两个真相源已合并

`src/database.js` 里那组零调用的主线程同步版（`applyDeferredPhotoIndexes()` +
`ensurePhotosRootFolderCompositeIndex()` / `ensurePhotosAggPartialIndexes()` /
`ensurePhotosDupHashPendingIndex()`）**已删除**，并留注释指向唯一真相源
`src/workers/deferred-index-worker.js`。同时给 `maintenance-regression` 加了两条静态契约：
① `src/database.js` 不许再出现这四个方法定义（按「方法定义」而非「出现过名字」判定，
   因为 database.js 里留着一段说明它们为何被删的注释）；
② 四个延迟索引的 `CREATE INDEX IF NOT EXISTS` 语句在 `src/` 下只许出现在那个 worker 里。

**顺带量了「要不要给它加一次性迁移标记」**：拿 5000 行小库跑真 worker，
首次（真要建 7 个索引 + 加 13 列）286 ms，第二次（全部已存在）108 ms —— 差值约 180 ms，
而 108 ms 里几乎全是 Node worker 启动 + `better-sqlite3` 加载的开销。
**结论是不加**：为省 180 ms 引入一个需要人工维护的 schema 版本号不划算。
（注意 `startup-performance.json` 里 `deferred-index.schedule → worker.done` 那 3066 ms 是**排队等待**，
不是 worker 自己的耗时，别拿它当依据。）

### 验证

- 真库只读：统计 5803 → 748 ms，逐字段一致；随机批次五个场景全部实测（见上表）。
- 端到端走真读池：`getRandomPreviewPhotoBatch` 取 100 / 500 张、排除 id 生效、12 列齐全；
  `getStats` 经 worker 602 ms 且数值与原实现一致。
- `query-regression` 新增「拆开后数值与原实现逐字段一致」「统计的执行计划必须命中 6 条覆盖索引
  且不许出现 `TEMP B-TREE`」「随机批次必须两段式（行为 + 静态形状）」，并用 2 万行合成库 +
  `EXPLAIN QUERY PLAN` 做判定 —— 塌回一条全表聚合**不会算错任何一个数**，只比对数值抓不住，
  必须看计划。
- **负例验过 4 次**：① 统计塌回一条 `SELECT ... FROM photos` → 计划断言 FAIL
  （实测捕获到 `USE TEMP B-TREE FOR count(DISTINCT) | SCAN photos`）；
  ② 随机批次退回一趟式 → 静态断言 FAIL；③ 在 `src/main.js` 里再写一份
  `CREATE INDEX IF NOT EXISTS idx_photos_folder_nocase` → 单一定义断言 FAIL；
  ④ 在 `database.js` 里塞回 `ensurePhotosAggPartialIndexes()` 方法定义 → FAIL。还原后全部复 PASS。
- 全量 `npm test` 26 项 PASS、`npm run lint` 0 error（5 个既有 warning）。

### 仍然没做

- 视频为主的库缺那条表达式索引（上面已给方案与体积）。
- 统计仍是每次调用重算。它在只读 worker 里，不冻界面，748 ms 可以接受；
  真要再快就得做成 `root_folder_stats_cache` 那样的可失效缓存（难点在失效点：
  扫描 / 收藏 / 清理都会改统计），单独一轮再做。

## 第五轮：跑真应用验收，并补上最后一个绕过写库队列的写事务

前三 / 四轮的验证都是「真库只读探针 + 合成库跑真 worker」，**没有跑过真应用**。
可上一轮修的就是启动期，所以这一轮做了件更直接的事：把真应用真起来一次，读它的启动打点。

### 修复前 vs 修复后的启动记录（同一台机、同一个 12.9 GB 真库）

修复前（`2026-09-29T00:56:58Z`，改动落地之前的那次）：

| 阶段 | 时刻 | 说明 |
| --- | ---: | --- |
| `post-window-deferred.thumbnail-fix.start` | +13738 | 开跑 |
| `post-window-deferred.fts-worker.start` | +21033 | 起跑 |
| `post-window-deferred.fts-worker.failed` | +29976 | **差值 8943 ms ≈ 走满 `busy_timeout`** |

`thumbnail-fix.start` 之后**整份记录里再没有它的 done 标记** —— 说明它一直在跑那条
76 秒的全表 `UPDATE photos SET has_thumbnail = 0 ...`，独自占着写锁；FTS 维护起跑后
等满 8 秒仍抢不到，于是 `failed`。这就是「写锁串行化」这个改动的直接来源。

修复后（`2026-09-29T05:1x`，队列上线之后）：

```
+11377 db-write.start | task=thumbnail-fix
+11438 db-write.done  | task=thumbnail-fix     ← 3 ms（见下）
+13086 db-write.start | task=invalid-cleanup
+13167 db-write.done  | task=invalid-cleanup
+13633 db-write.start | task=invalid-cleanup
+13712 db-write.done  | task=invalid-cleanup
+15157 db-write.start | task=deferred-index
+15203 db-write.done  | task=deferred-index
+17398 db-write.start | task=fts-index
+17451 db-write.done  | task=fts-index
+17451 post-window-deferred.fts-worker.complete   ← 不再是 failed
```

队列每次 `run()` 都会打一对 `db-write.start` / `db-write.done`（带任务名），
所以「谁在持锁、串了多久」现在从日志上一眼可见，不用再猜。

**顺带验了上一轮只有合成库证据的那件事**：修完之后第一次真跑写下了迁移标记，
第二次真跑是
`{"marker":"already-applied","scanned":0,"fixed":0,"batches":0,"elapsedMs":3}` ——
**12.9 GB / 122 万行的真库上，3 ms 一次主键查询就退出**。
之前「真库冷缓存 76 秒」那条路径彻底不会再走到。全日志零 `database is locked`。

### 这一轮新发现的缺口：`invalid-cleanup` 绕过写库队列

上面那张表里有个刺眼的地方：`invalid-cleanup` 的批次（+13086 → +13712）和队列里第一个任务
（`thumbnail-fix`，+11377 → +11438）**时间窗完全重叠**。去查代码，果然：

`cleanupMissingFilesYielding()` 名字像只读巡检，其实每批都是

```sql
DELETE FROM photos WHERE id = ?   -- prepare
BEGIN TRANSACTION … COMMIT
```

一段**独占写锁的写事务**。但它在 `main.js` 的两个调用点（启动期顺带清理、用户手动清理）
都直接调用，准入判断只有
`isFolderScanRunning() || thumbnailBackfill.running || duplicateHashTask.running || previewPlaybackActive`
—— **不认识写库队列**。所以「批量 DELETE」和「启动期迁移」是能同时开枪的。

这次没炸完全是运气：那两批恰好 `deleted = 0`（库里没有失效记录），
`runDeletes()` 在 `removeIds.length === 0` 时直接 resolve，**根本没开事务**。
换个真有失效记录的库，「DELETE 批次」与「延迟索引的 CREATE INDEX」就会正面撞上。

**改法**：加一个助手把单批包进队列，两个调用点都改走它。

```js
function runInvalidCleanupBatch(options) {
  return dbWriteQueue.run('invalid-cleanup', function () {
    return db.cleanupMissingFilesYielding(options);
  });
}
```

包**单批**而不是整个清理循环：批次之间队列会空出来，扫描 / 其他维护能插队，
不会被一个长清理长期霸占。另外：
- 用户手动清理的准入改成 `maintenanceBusy()`（一次性判断、不重试，所以不会有饥饿问题）；
- `dbWriteBusyLabel()` 加上 `invalid-cleanup → 清理失效文件记录`，否则界面上会显示英文任务名。

改完后的真跑日志里，清理批次果然变成队列中的一员：

```
+13086 db-write.start | task=invalid-cleanup
+13167 db-write.done  | task=invalid-cleanup
```

### 验证

- **真应用端到端**（本项目第一次做）：修复前后各跑一次真应用读 `startup-performance.json`，
  见上表 —— `fts-worker.failed` → `fts-worker.complete`，零锁错误；
  `thumbnail-fix` 第二次真跑 `already-applied` + 3 ms。
- `maintenance-guard-regression` 新增 `testInvalidCleanupWiring()`：
  ① 前提断言 —— `database.js` 的 `cleanupMissingFilesYielding` 确实是
     `DELETE … BEGIN TRANSACTION … COMMIT` 写事务（哪天它真变成只读了，这条契约的
     「为什么」就过期了，应该连着一起改，而不是让注释撒谎）；
  ② 助手必须把批次包在 `dbWriteQueue.run('invalid-cleanup', …)` 里；
  ③ **全 `main.js` 只许有 1 次真实调用 `db.cleanupMissingFilesYielding(`**
     （其余一律走助手）——这条是有牙齿的那条；
  ④ 两个调用点都要走助手（`runInvalidCleanupBatch(` 出现 3 次 = 定义 1 + 调用 2）；
  ⑤ 忙碌文案要认 `invalid-cleanup`；⑥ 手动清理要先查 `maintenanceBusy()`。
- **负例 3 次全部有牙齿**：① 启动期清理退回直接 `db.cleanupMissingFilesYielding(` →
  「只许 1 次真实调用」FAIL（实测报「实际 2 次」）；② 助手改成不入队 →
  「必须包在写库队列里」FAIL；③ 手动清理退回 `if (optimizeTaskRunning)` →
  「要先查 maintenanceBusy()」FAIL。还原后全部复跑 PASS。
- 全量 `npm test` / `npm run lint` 见下。

### 踩到的坑（跑真应用）

- **环境里 `ELECTRON_RUN_AS_NODE=1`**：直接
  `./node_modules/electron/dist/electron.exe . --dev` 会以 **Node 模式**跑，
  报 `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`
  然后退出。必须 `env -u ELECTRON_RUN_AS_NODE`。
- **GUI 模式起不来**：GPU 进程连崩 6 次后 `FATAL: GPU process isn't usable. Goodbye.`
  所以要用无头开关：
  `--disable-gpu --disable-gpu-compositing --disable-software-rasterizer --no-sandbox`。
- **不要加 `--remote-debugging-port`**：它会把 `did-finish-load` 从 ~6.6 s 抬到更久，
  污染启动数据。这一轮只需要 `startup-performance.json`，不需要调试端口。
- `startup-performance.json` 每 250 ms 落盘一次，且 `startup-metrics` 有 60 秒硬截止，
  所以跑满 60 秒再读就是完整记录。
