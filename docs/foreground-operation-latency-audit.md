# 前台操作延迟审计：后台任务跑着时，你那 6 类操作到底受不受影响

> 2026-10-06 · 只读诊断，**未改任何代码**（`src/` 六个相关文件 md5 与诊断前逐字节一致）
> 真库：`%LOCALAPPDATA%\aurora-gallery\UserData\photos.db` = **14.5 GB / 1,656,580 行 / 3 个根目录**
> 探针：`.workbuddy/tmp/contention-probe.js`、`.workbuddy/tmp/foreground-latency-probe.js`（每个数字都能自己复现）

---

## 0. 一句话结论

**你的 6 类操作全部走 worker 池，主进程不执行同步聚合 —— 所以"后台任务拖住前台"这件事在结构上已被排除；实测也证实轻查询几乎零争用（p99 = 0.12 ms）。**

**真正的瓶颈是 3 条 SQL 自己太慢**（`getFolderTree` 分钟级 / `getPhotos({rootId})` 70 秒 / 每页重算全表 `COUNT(*)` 38 ms）。**加保护救不了这个 —— 保护再完美也不能让一条 70 秒的 SQL 变快。**

---

## 1. 先纠正两个我自己的认知错误

| 我之前以为 | 实际是 |
|---|---|
| 读库分流函数叫 `runInDbWorker` | 叫 **`runDbReadWorkerOnly`**（`src/db-read-runner.js`）→ `db-read-worker-pool.js` → `workers/db-read-worker.js` |
| `photos.db-wal` 1.29 GB 是「未合并的垃圾」，列为待办 | **是水位，不是垃圾**。实测 60 秒内 WAL 变更 **426 次**（后台确在持续写），而大小 **min = max = 1,399,423,952 字节、净增 0** ⇒ PASSIVE autocheckpoint 在正常循环复用。只有 `optimizeDatabase()` 里的 `wal_checkpoint(TRUNCATE)` 会缩它（用户点「优化数据库」才跑） |

---

## 2. 你列的 6 类操作：路径与保护状态

| 操作 | IPC 入口 | 执行位置 | 保护 |
|---|---|---|---|
| 各导航标签点击 | 无独立 IPC，落到列表加载 | 渲染层 + **读池** | ❌ 无 |
| 文件树加载 | `get-root-folders` / `get-folder-tree` / `get-folder-covers` | **读池**（+ `catalogCache` 24 h） | ❌ 无 |
| 图片列表加载 | `get-photos` / `get-folder-photos` / `get-date-photos` | **读池** | ❌ 无 |
| 搜图 | `ai-search-query` | 语义 worker | ✅ `withPreempt` |
| 搜图预选词 | `ai-search-suggest` | 语义 worker | ✅ `withPreempt` |
| 人脸列表加载 | `face-action(groups/photos)` | 人脸 worker | ✅ `concurrentReads` |

### 2.1 最重要的结构性事实

`src/db-read-runner.js` 的注释原文：

> 只读大查询固定走有界 Worker 池，**主进程不执行同步聚合**。

⇒ 前台查询不占主进程 event loop，而后台的 3 个主进程任务（缩略图补全 / 查重 / 失效清理）**只在批次边界让出**。这两件事叠起来 = **主进程被谁拖住的风险在结构上已经排除**。

### 2.2 `withPreempt` 的语义澄清（我一开始也理解反了）

它**不等待**后台让路 —— 只是 `begin()` 标记「用户活跃」→ 跑查询 → `end()`。

**等待方是后台任务**：它们在批次边界调 `interactionPreempt.awaitIdle()`
（`main.js` 缩略图补全 1 处、查重 2 处）。`tailMs = 1500`（搜完仍算活跃 1.5 s，因为用户往往连着搜）、`maxHoldMs = 30000`（后台最多等 30 s，防饿死）。

⇒ **搜图是立刻执行、后台被暂停**。不存在「搜图要等后台让路所以显得慢」这回事。

---

## 3. 实测：后台任务到底争走了什么

### 3.1 争用探针（点查，60 秒，42,424 次）

同一时段 WAL 变更 **426 次**（确认后台在持续写库）：

```
p50 = 0.008 ms    p90 = 0.013 ms    p99 = 0.120 ms    max = 86 ms
>1 ms  5 次        >10 ms  1 次       >50 ms  1 次      >100 ms  0 次
```

⇒ **后台持续写库时，前台轻查询几乎零争用**。那 1 次 86 ms 尖峰占 42,424 分之 1（0.002%）。

### 3.2 写锁也不是瓶颈

`dbWriteQueue.run(` 的 **11 处调用点全是后台任务**；前台的收藏 / 删除直接同步调 `db.*`、**根本不入队**。加上 JS 单线程 ⇒ 前台写不可能插进后台事务中间。

### 3.3 但重查询有 2~5 倍抖动

同一时段 8 次 `COUNT(*)` 全表扫描：

```
52.1 / 53.0 / 57.9 / 58.7 / 60.6 / 60.9 / 64.8 / 239.2  ms
                                      ↑ 中位        ↑ 4 倍
```

（另一时段同一查询为 **38.2 ms** ⇒ 绝对值也受负载 / 页缓存影响）

⇒ **越贵的查询，越吃 CPU 与页缓存带宽，越容易被后台放大。** 这一条直接决定了优化方向。

### 3.4 后台往读池塞查询的频率其实很低

读池参数：`POOL_SIZE = 3`、`MAX_QUEUE = 100`、`JOB_TIMEOUT_MS = 120000`（超时**含排队时间**）。

后台的读池调用：
- 缩略图补全：起手 1 次 `estimatePendingCount` + **每 30 s 1 次** `getPendingThumbCount`（覆盖索引，14 ms 级）
- 查重：**收尾**打 3 次全表聚合（罕见）

⇒ 槽位占用率 ≈ **0.016%**，**槽位争用不是主要矛盾**。

---

## 4. 真正该修的三条（按严重度）

### P0-A `getFolderTree` 冷启动分钟级 ⚠️

```sql
SELECT folder_path, COUNT(id), MIN(date_taken), MAX(date_taken)
FROM photos WHERE root_id = ? GROUP BY folder_path ORDER BY folder_path
```

`EXPLAIN` 给出：

```
SEARCH photos USING INDEX idx_photos_root_folder (root_id=?)
```

- ✅ 没有 `USE TEMP B-TREE`（`(root_id, folder_path)` 让分组免排序）
- ❌ **不是 covering** ⇒ 每一行都要**回表**取 `date_taken`（给 MIN/MAX）⇒ **91 万次回表**

**实测**：root 23（**912,222 行 / 31,730 个目录**）**跑 >4 分钟没返回**（我在它返回前停掉了探针）。

**触发点**：`loadRootFolders` → `sidebarTree.prefetchFolderTreeMap` → **对 3 个根目录各调一次**（`renderer/app.js`）。三个根目录分别是 912,222 / 431,996 / 312,362 行。

**你什么时候会撞上**：缓存是**持久化 SQLite + 24 h TTL**（`catalog-cache-db.js`），失效点**只有四处** —— 扫描结束（`processScanQueue`）、删照片、切收藏、移除目录。

⇒ 🔴 **扫描完成后第一次加载文件树 = 3 个根目录全部重算**。而你刚扫完，往往正想看目录树。
⇒ ⚠️ **缩略图补全刻意不清这个缓存**（补全只改 `has_thumbnail` / 尺寸 / EXIF，不动目录结构）—— 这是对的。

### P0-B `getPhotos({rootId})` = **70,594 ms** ⚠️

`EXPLAIN`：

```
SEARCH photos USING INDEX idx_photos_root (root_id=?)
USE TEMP B-TREE FOR ORDER BY          ← 就是它
```

⇒ 对 **91 万行**做临时 B 树排序。

**根因**：**缺 `(root_id, date_taken)` 索引**。现有 `idx_photos_root_date_mod` 是 `(root_id, date_modified)` —— **与默认排序键 `date_taken` 不匹配**，所以优化器只能退到 `idx_photos_root` 再排序。

**可达性**（这条很重要，别自己吓自己）：
- **桌面端不可达** —— `renderer/app.js#fetchPhotosPage` 的 `switch` 没有 `root` 分支、不传 `rootId`
- **网页端可达** —— `web/js/app.js#viewRootFolder()` → `currentView='root'` + `_rootId`

### P1-A 每页重算全表 `COUNT(*)` = 38~60 ms

`getPhotos()` 默认参数总耗时 **42.3 ms**，拆开看：

| 组成 | 耗时 |
|---|---|
| `COUNT(*)` 全表 | **38.2 ms** |
| 真正取 100 行 | **0.3 ms** |

`EXPLAIN`：`SCAN photos USING COVERING INDEX idx_photos_hasThumb` ⇒ 扫 166 万条目。

而这个 `total` **只随数据变化**，翻页时根本不变 ⇒ **纯浪费**，而且它正是最吃 3.3 节那个抖动的那一个（38 → 239 ms）。

### P1-B 读池 worker 没设 `cache_size` / `mmap_size`

| 连接 | cache_size | mmap_size |
|---|---|---|
| 主进程（`database.js`） | **128 MB** | **1 GB** |
| 读池 worker（`workers/db-read-worker.js#openDb()`） | 没设 ⇒ SQLite 默认 **2 MB** | 没设 ⇒ **关闭** |

`openDb()` 里只有一句 `busy_timeout = 8000`。⇒ 重查询（回表多、聚合大）几乎全靠 OS page cache 兜底，而 14.5 GB 的库不可能全缓存。

### P2 读池前台 / 后台同权 FIFO

`jobQueue` 是单一队列，后台查询与前台查询**同权**。按 3.4 节实测，收益边际，可以不做。

---

## 5. 建议（按"改动小 + 收益大"排序）

| # | 改法 | 收益 | 风险 |
|---|---|---|---|
| 1 | **给读池 worker 补 `cache_size` / `mmap_size`**（照抄主进程那两个值） | 直接改善 `getFolderTree` 与所有回表多的查询 | 低（只读连接，不写库文件；每 worker 多占内存 ~128 MB × 3） |
| 2 | **缓存 `getPhotos` 的 `total`**（按筛选条件 + 数据版本号） | 列表加载 42 → **~1 ms**（省掉 38 ms 里的大头），同时消掉它对抖动的敏感性 | 中（要定义"数据版本号"，扫描/补全/删除都要 bump） |
| 3 | **建覆盖索引 `(root_id, folder_path, date_taken)`** 给 `getFolderTree` | 91 万次回表 → 0 | 中高（🔴 大表 `CREATE INDEX` 必须走 `deferred-index-worker`，**不许在启动路径建**） |
| 4 | **建 `(root_id, date_taken)`** 给 `getPhotos({rootId})` | 70 秒 → 毫秒级 | 中高（同上；且要先确认 `date_taken` 与 `date_modified` 语义取舍） |
| 5 | 读池分前台 / 后台两档优先级 | 边际 | 低 |

**如果只能做一件事**：做 #1（读池 pragma）—— 改动最小、无 schema 变更、不需要动 SQL，而且它对 #3 那类回表查询有直接帮助。

---

## 6. 诚实标注：这些我还没量

- **3 个根目录全量聚合的总时长**：只测到 root 23（91 万行）跑 >4 分钟未返回，没等它跑完（继续跑会实质拖慢你正在用的应用）。总量是推断的。
- **`getPhotos` 21 天的抖动里，多少来自后台任务、多少来自页缓存冷热**：本轮没做对照（无法在你不用的时段复现空闲基线）。
- **HLS 视频转码的实际 CPU 占用**（上一轮报告就标注了这条）。
- **网页端 `root` 视图的真实触发频率**：只确认了代码路径可达，没看实际使用。

---

## 7. 探针纪律（本轮踩到的，写下来免得重犯）

1. 🔴 **重查询对每个只跑一次**。我第一个探针里 `time(..., rounds=2)` 让 `getFolderTree` 跑两遍、那条 70 秒的也跑两遍 ⇒ 白占 **4 分 37 秒**，而且和你的应用**读同一个库、跑同一条慢 SQL、用同一块 C: 盘**。跑之前该问一句「用户此刻在用这台机器吗」。
2. 🔴 **探针里禁用忙等对齐节拍**（`while (hrtime < sleep) {}`）—— 那会占满 1 核。要等就用 `Atomics.wait` 或 `setTimeout`。
3. ⚠️ **`console.log` 重定向到文件是块缓冲**，进程退出才 flush ⇒ **「日志不动」≠「查询卡住」**（我差点据此误判）。要实时看进度必须 `fs.writeSync(1, ...)`。

---

# 8. 已实施（2026-10-06 晚）· 四条全做

上面第 5 节的建议 1~4 全部落地。这一节是**实施记录**，实测证据都能自己复现。

## 8.1 改动点

| # | 改法 | 落点 | 关键点 |
|---|---|---|---|
| 1 | 读池 worker 补 `cache_size` / `mmap_size` | `src/workers/db-read-worker.js#openDb()` 改调 `PhotoDatabase.applyReadConnectionPragmas()`；两个值提到 `src/database.js` 的 `DB_CACHE_SIZE_KB` / `DB_MMAP_SIZE_BYTES` | **同源**：worker 里不许再出现数字字面量，值只在 database.js 改一次 |
| 2 | `getPhotos` 的 `total` 记忆化 | 新模块 `src/photos-total-cache.js` + `database.js#getPhotos` 用「未命中才算 COUNT」的分支 | 键 = `whereClause` + `params` **原样**；TTL 5 s；显式复位经 `dbReadWorkerPool.invalidateReadCaches()` |
| 3 | 覆盖索引 `(root_id, folder_path, date_taken)` | `src/workers/deferred-index-worker.js` Phase 4 | 走延迟索引 worker，**不进启动路径** |
| 4 | 排序索引 `(root_id, date_taken)` | 同上 Phase 4 | 名字与既有 `idx_photos_root_date_mod` 成对 |

**为什么 #2 住在 worker 里**：`getPhotos` 只在读池 worker 里执行（桌面端 IPC 与网页端 `web-server.js` 都经 `runDbReadWorkerOnly`），所以一份缓存**同时覆盖两端**，且不需要动 IPC 与信任边界。

**键取 SQL 本身**是这次唯一重要的设计决定：手搓字段键（`rootId|favoritesOnly|mediaType`）漏一个字段就会**静默返回别人的计数**；取 SQL 则「同一条 SQL + 同一组参数 ⇒ 同一个数」恒成立，将来加筛选项自动带上。

**失效两条腿**：① TTL 5 s（有界，是**上界**而不只是兜底 —— 所以没有采用「数据版本号」方案：写路径分散，漏 bump 一处就得靠 TTL 兜，版本号并不真的省掉 TTL，只是多了一份「可能忘」的清单）；② 显式复位挂在 7 个改行数的动作上：扫描收尾 / 移入回收站 / 删除记录 / 移除根目录（经既有两个 `invalidateCatalog*Safe` 入口一并覆盖）、收藏切换、启动期失效清理（**仅在这批真的删了行时**，它 450ms 一批、大多批 `deleted = 0`）、手动失效清理（整轮收尾一次）。

## 8.2 实测：两条 SQL 的执行计划真的换了

夹具探针 `.workbuddy/tmp/index-plan-probe.js`（不碰真库；列顺序复刻真库 `PRAGMA table_info` —— `root_id` 1 / `folder_path` 2 / `date_taken` 9 / `thumbnail` **11**，三个索引列全部排在那个 7,723 字节的内联 BLOB **之前**，所以建索引只读每行前段、不穿溢出页链）：

45,000 行 / 每根 300 目录：

| 查询 | 建索引前 | 建索引后 |
|---|---|---|
| `getFolderTree` | `USING INDEX idx_photos_root_folder` + 91 万次回表 · **113.8 ms** | `USING COVERING INDEX idx_photos_root_folder_date` · **5.8 ms** |
| `getPhotos({rootId})` | `idx_photos_root_folder` + `USE TEMP B-TREE FOR ORDER BY` · **112.2 ms** | `USING INDEX idx_photos_root_date`，无临时排序 · **1.5 ms** |

`ORDER BY date_taken DESC NULLS LAST` 的 `NULLS LAST` **不挡索引**（SQLite 里 NULL 最小 ⇒ DESC 时天然排最后；真库实测 `date_taken IS NULL` 共 **0 行**）。

## 8.3 反向验证：没有把别的查询带偏

项目里**没有 `sqlite_stat1`**（真库实测无统计表），规划器全靠启发式 —— 多一条索引就可能挑错。所以夹具上把全工程 16 条查询逐条对照过：

- 唯二变化的另有哪些：`日期分组 + rootId` 从 `USING INDEX idx_photos_root_folder`（非 covering）变成 `USING COVERING INDEX idx_photos_root_date` —— **顺带变好**。
- 其余 14 条**逐字不变**：全库计数（`idx_photos_hasThumb`）、单根计数（`idx_photos_root`）、根内目录数（`idx_photos_root_folder`）、日期区间、`MIN(date_taken)`、`COUNT(DISTINCT folder_path)`、无过滤分页排序（`idx_photos_date`）、目录内计数、失效清理分批、缩略图补全倒序…
- 刻意**不用 `INDEXED BY` 钉住**（聚合计数那套是钉的）：这两条是规划器自己就会发现更优的形态（covering / 免排序）；钉住反而引入「索引还没建出来时 `no such index` 直接报错」和「读池 worker 长期持有 `hasIndex` 缓存造成假阴性」两个新失败模式。

这些结论已固化成断言（含「建索引**前**必须是慢形状」的哨兵，证明断言有区分度）：`scripts/read-latency-regression.js`。

## 8.4 索引的代价与生效时机（诚实标注）

- **体积**：按夹具 `dbstat` 外推真库 165 万行 —— `idx_photos_root_folder_date` ≈ **87 MB**、`idx_photos_root_date` ≈ **47 MB**（真库 `folder_path` 平均 23.1 字符）。
- **首次构建**：两条都是「整表读一遍 + 排序」，由 `deferred-index-worker` 在首窗后、经写库队列串行执行（**不是**启动路径）。**真库上没量** —— 那会实质占住用户正在用的写锁与磁盘。
- **生效时机**：worker 是独立的写连接，提交 `CREATE INDEX` 之后 schema cookie 变化 ⇒ 读池连接下一次执行语句时 SQLite 自动重编译 ⇒ **不必重启应用**即可吃到新计划。本次更新后**第一次启动**期间（索引还没建完）仍走旧计划。
- **刻意没做**：`deferred-index-worker` 自己的连接仍然没设 `cache_size` / `mmap_size`（本轮只按用户列的四件事做）。它是顺序读一遍表再外部排序，OS page cache 能覆盖大部分，收益远小于读池那条；若将来实测建索引明显拖慢，再补同样两行即可。

## 8.5 数字汇总

- `getPhotos` 的 COUNT：38.2 ms → **命中时 ~0（不进 SQLite）**；未命中仍是 38 ms 级。
- 最坏陈旧度：**5 s**（删一张照片后页面数最多旧 5 s）。缓存**不参与任何正确性判定**，只喂「共 N 张」与 `totalPages`。
- 读池只读连接：`cache_size` 2 MB（默认）→ **128 MB**；`mmap_size` 0（关闭）→ **1 GB**。

