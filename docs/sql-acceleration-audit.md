# SQL 加速排查：还有哪些语句可加速

> 2026-10-06 晚 · **只读排查，未改动任何产品代码**。所有数字都在**真库**上现量
> （`%LOCALAPPDATA%\aurora-gallery\UserData\photos.db`，14.06 GB / photos 1,656,580 行 /
> WAL 1.4 GB / `sqlite_stat1` 不存在 ⇒ 规划器纯启发式），或在与真库同型的小夹具上验证形态。
>
> 前提：本轮上一批四条改动（读池 PRAGMA / `total` 记忆化 / 两条覆盖索引）已落地。
> 排查时两条新索引**在 16:58 前后才被延迟索引 worker 建出来**，所以第 ① 节既有「建好前」
> 也有「建好后」两组数 —— 这不是矛盾，是两个时点。

## 结论速览

| 优先级 | 语句 | 现状实测 | 改法 | 期望 | schema 变更 |
|---|---|---:|---|---:|:---:|
| **P0-1** | `mediaType` 过滤后按根浏览的 `COUNT(*)` | **71.6 s**（图片）/ **57.7 s**（视频） | 加 `INDEXED BY` 已有部分索引 | **275 ms / 10 ms** | ❌ 无 |
| **P0-2** | 搜图的 `total` 计数 | **25.8 s**（`IMG`）/ 12.2 s（`2024`） | 总数从 FTS 侧取 | **80 ms / 34 ms** | ❌ 无 |
| **P0-3** | 搜图取一页（热门词） | **32.4 s**（冷） | 命中多时 `INDEXED BY idx_photos_date` | **141 ms** | ❌ 无 |
| **P0-4** | 顶栏统计 `runGetStatsAgg` | **8.6 s**（冷）/ 0.95 s（热） | 记忆化（同 `total` 那套） | ≈ **0** | ❌ 无 |
| **P1-1** | 按根浏览 + 排序键 `file_name` / `file_size` | **40.0 s** / 同型 | 新增 `(root_id, file_name)`、`(root_id, file_size)` | ≈ **0.5 ms** | ✅ 两条索引 |
| **P1-2** | 查重收尾 + 侧栏：按 `file_hash` 分组 | **174 s**（每次调用，内部跑两遍） | 新增部分覆盖索引 | 夹具 **280→43 ms** | ✅ 一条部分索引 |
| **P1-3** | 日期视图 `GROUP BY date(date_taken)` | **3.5 s**（冷）/ 0.5 s（热） | 表达式索引（形态 C / E，见 §4） | 夹具 **91.9→18.9 ms** | ✅ 一条表达式索引 |
| **P1-4** | 「查找相似图片」`buildFolderSimilarGroups` | **140 s** | 覆盖索引免回表 | 未建（只给诊断） | ✅ 一条部分索引 |

**已量过、确认不用动**的见 §6（含一条我自己差点误报的）。

---

## 1. 本轮四条改动在真库上的实测（既有「建好前」也有「建好后」）

两条新索引在排查期间才由延迟索引 worker 建出来，所以同一批语句量到了两个时点：

| 语句 | 建索引前 | 建索引后 | 计划变化 |
|---|---:|---:|---|
| `getPhotos({rootId})` 的分页 SQL | **44,270.9 ms** | **0.9 ms** | `SEARCH … idx_photos_root` + `USE TEMP B-TREE FOR ORDER BY` → `SEARCH … idx_photos_root_date` |
| 同上的 `COUNT(*)` | — | 33.1 ms | `SEARCH … COVERING INDEX idx_photos_root` |
| `getFolderTree(root)` | >4 分钟（上轮记录） | **408.8 ms**（热 222.6 ms） | `SEARCH … COVERING INDEX idx_photos_root_folder_date` |
| `getDateGroups({rootId})` | — | 374.5 ms | `SEARCH … COVERING INDEX idx_photos_root_date` |

⚠️ **`getPhotos({rootId})` 首次调用是 846.8 ms 而不是 0.9 ms** —— 差的 800 ms 全在
`COUNT(*)`（912,222 行的覆盖索引**冷读**）。热了之后 33 ms。这不是缺陷，只是别把
「首次进某个根目录」的观感按 0.9 ms 估。

---

## 2. P0：零 schema 变更，只改写法就能提速

### P0-1 `INDEXED BY` 已经建好的部分索引：71.6 s → 275 ms

`mediaType` 的谓词与 `idx_photos_agg_root_folder_{image,video}` 的**索引谓词逐字相同**
（已逐字符比对为 `true`），但规划器**不选**它 —— 它以为 `idx_photos_root` 更快：

```
现状 A1  SEARCH photos USING INDEX idx_photos_root (root_id=?)          71,617.2 ms  → n=887,313
候选 A2  SEARCH photos USING INDEX idx_photos_agg_root_folder_image     275.5 ms      → n=887,313
现状 A3  SEARCH photos USING INDEX idx_photos_root (root_id=?)          57,651.3 ms  → n=24,909
候选 A4  SEARCH photos USING INDEX idx_photos_agg_root_folder_video     10.0 ms       → n=24,909
对照 A5  SEARCH photos USING COVERING INDEX idx_photos_root             33.1 ms       → n=912,222
```

**结果值逐个相同**（887,313 / 24,909 ），所以这是纯时序问题，不涉及语义。

为什么差这么多：`photos.file_type` 在 cid 6（BLOB 之前，便宜），但 `idx_photos_root`
只含 `(root_id)` ⇒ 数 912,222 行就得回表 912,222 次去读 `file_type`。
部分索引里 `(root_id, folder_path)` 两列都在，且**谓词已经把非目标媒体档排除在索引之外**
⇒ 只数该档的行（视频档只有 24,909 行，所以 10 ms）。

**改法**：这不是新发现的手法 —— `db-heavy-read.js#countViaIndex` 在聚合路径上**早就是这么做的**
（`hasIndex()` + `INDEXED BY`）。缺的只是把同一招用到 `db.js#getPhotos` / `getFolderPhotos`
那条计数上。

⚠️ 与项目现有约定一致的做法：**索引名不要在业务代码里手抄**，走 `db-heavy-read.js` 那两个
`AGG_IMAGE_INDEX` / `AGG_VIDEO_INDEX` 常量（它们已经是唯一引用点）。
⚠️ `INDEXED BY` 的既有失败模式：索引还没建出来时直接报 `no such index` ——
所以必须配「索引存在才加 hint」的判断（`hasIndex()` 已有，且它按连接缓存）。

### P0-2 搜图 `total`：25.8 s → 80 ms（324×）

```
S1  COUNT(*) FROM photos_fts WHERE MATCH '"IMG"*'                              79.5 ms  → 544,235
S2  现状：COUNT(*) FROM photos WHERE photos.id IN (SELECT rowid FROM … MATCH)  25,759.7 ms → 544,235
S4  改写候选（从 FTS 侧驱动）                                                    66.4 ms
S1' COUNT(*) FROM photos_fts WHERE MATCH '"2024"*'                              33.6 ms → 224,491
S2' 现状                                                                        12,217.4 ms
```

**同一个数，差 324 倍。** 现状的计划是：

```
SEARCH photos USING INTEGER PRIMARY KEY (rowid=?)   ← 对 54 万个 rowid 逐个回表取行
LIST SUBQUERY 1
SCAN photos_fts VIRTUAL TABLE INDEX 0:M2
```

`photos_fts` 是 `content='photos'` 的外部内容表，FTS 索引里有全部命中的 rowid；
但写成 `photos.id IN (…)` 之后，SQLite 会把它物化成一张 54 万行的临时 list，
再**回到 `photos` 里一行一行确认** —— 54 万次回表 = 20 s 级。

**改法**：无附加筛选（没有 `favoritesOnly` / `mediaType`）时，`total` 直接问 FTS；
有附加筛选时保留现写法（或把筛选也并进 FTS 子查询）。
⚠️ **必须先确认语义等价**：`COUNT(*) FROM photos_fts WHERE MATCH` 数的是索引里的 rowid，
与 `photos` 表对得上，靠的是三个触发器（`ai` / `ad` / `au`）保持同步。真库目前
`photos_fts` 与 `photos` 行数一致（1,656,580），但**这条等价性应该写成一个断言**，
不能靠「应该同步」四个字。

### P0-3 搜图取一页：32.4 s → 141 ms（230×），但**有取舍**

```
B1 现状：IN(FTS) + ORDER BY date_taken DESC + LIMIT 100   32,428.3 ms
   计划：SEARCH photos USING INTEGER PRIMARY KEY (rowid=?) … USE TEMP B-TREE FOR ORDER BY
B2 候选：同上 + INDEXED BY idx_photos_date                 141.2 ms
   计划：SCAN photos USING INDEX idx_photos_date … CREATE BLOOM FILTER
B3 候选 + 冷门词 '"zzzz-no-such-token"*'                    3,487.6 ms
B4 现状 + 同一个冷门词                                      0.5 ms
```

现写法的代价：把 **54 万条命中全部物化再排序**（`USE TEMP B-TREE FOR ORDER BY`）才取前 100 条。
候选写法让 SQLite **按 `date_taken` 索引序走、凑满 100 条就停**（还自动建了 bloom filter），
热门词 141 ms。

🔴 **两条必须一起看的副作用**：
1. **冷门词会大幅变慢**（3.5 s vs 0.5 ms）—— 因为要沿日期索引一直走到底。所以**不能无脑替换**，
   得按命中数分流（`total` 已经从 P0-2 拿到了，> 几万才用 hint；阈值要在真库上标定）。
2. **并列排序的结果顺序会变**：B1 返回 `id=1549317`、B2 返回 `id=1549318`，两条的
   `date_taken` **都是 `2025-11-12 16:46:20`**（同秒并列）。`searchPhotos` 这条路**没有**
   `applyNaturalNameTieSort`（`getPhotos` 有），所以并列项的先后本来就未定义；
   换索引会让用户看到不同的那一条。**这需要你拍板是否接受**。

### P0-4 顶栏统计：8.6 s → ≈0

拆开量（`runGetStatsAgg` 是 8 条子查询 + faces 两条）：

| 子查询 | 冷 | 计划 |
|---|---:|---|
| `COUNT(*)` | 341.1 ms | `SCAN … COVERING INDEX idx_photos_hasThumb` |
| `SUM(file_size)` | 1,428.9 ms | `SCAN … COVERING INDEX idx_photos_size` |
| **`COUNT(DISTINCT folder_path)`** | **4,487.8 ms** | `SCAN … COVERING INDEX idx_photos_folder` |
| 视频张数 | 1,459.7 ms | `SCAN … COVERING INDEX idx_photos_type` |
| 视频体积 | 1,875.2 ms | `SCAN … INDEX idx_photos_agg_root_folder_video`（要回表 26,609 行） |
| 收藏张数 | 1.9 ms | `SEARCH … COVERING INDEX idx_photos_favorite` |
| `MIN/MAX(date_taken)` | 0.6 / 0.5 ms | `SEARCH … COVERING INDEX idx_photos_date` |
| faces 两条 | 98.5 / 89.7 ms | 覆盖索引 |
| **整条（热）** | **948.8 ms** | 首次 8,616.3 ms |

**没有一条是「算错」，全是「沿某条索引把 165 万条目走一遍」**（size / folder / type 各一遍）。
最贵的 `COUNT(DISTINCT folder_path)` 走了 idx_photos_folder 的天然序去重，本身没有临时表，
4.5 s 纯粹是冷读 ~165 万条索引条目。

**改法**：不必加索引，**加记忆化**即可 —— 与上一轮 `src/photos-total-cache.js` 完全同型：
键 = 语句原样、TTL 5 s（最坏陈旧度上界）、跨库共用读池 worker 进程、挂在同一批
「改了行数」的复位点上。调用点有 11+ 处（启动 / 扫描收尾 / 回收站 / 维护 / 手动清理…），
每次都要 0.95 s，这是当前最划算的一处。

---

## 3. P1：需要新增索引（按红线必须走 `deferred-index-worker`，不许进启动路径）

### P1-1 按根浏览配其他排序键：40.0 s → 期望 ≈0.5 ms

真库计划（排序键与索引不匹配 ⇒ 临时排序）：

| 排序键 | 真库实测 | 计划 |
|---|---:|---|
| `date_taken`（默认） | 0.9 ms ✅ | `idx_photos_root_date`（本轮新建） |
| `date_modified` | 快 ✅ | `idx_photos_root_date_mod`（既有） |
| `folder_path` | 快 ✅ | `idx_photos_root_folder`（既有） |
| **`file_name`** | **39,990.2 ms** | `idx_photos_root` + **`USE TEMP B-TREE FOR ORDER BY`** |
| **`file_size`** | 同型 | `idx_photos_root` + **`USE TEMP B-TREE FOR ORDER BY`** |

夹具上验证两条候选索引（200,000 行）：

| | 建索引前 | 建索引后 | 计划变化 |
|---|---:|---:|---|
| `ORDER BY file_name` | 54.5 ms | **0.5 ms** | `idx_photos_root` + TEMP B-TREE → `USING INDEX idx_photos_root_name` |
| `ORDER BY file_size` | 40.7 ms | **0.6 ms** | `idx_photos_root` + TEMP B-TREE → `USING INDEX idx_photos_root_size` |

夹具不成比例地快（行小、缓存热），但**判据是「临时排序消失了」**，这点是可搬的。
算上 `(root_id, date_taken)` 与既有两条，五个排序键就齐了。

### P1-2 查重：174 s，而库里其实只有 **1** 个重复组

```
Z2  现状  174,281.2 ms  →  值 = 1
    计划：SEARCH photos USING INDEX idx_photos_file_hash (file_hash>?) + USE TEMP B-TREE FOR ORDER BY
D2  夹具加索引后  280.5 ms → 43.2 ms
    计划：SEARCH photos USING INDEX idx_photos_dup_hash_full (file_hash>?)
```

**花 174 秒算出「只有 1 组」。** 现状走的是 `idx_photos_file_hash(file_hash)`，
但查询还要 `file_size`（求和）与 `file_type`（谓词，cid 6 在 BLOB 之前）——
两列都不在那条索引里 ⇒ **165 万次回表**。而夹具实测：换一个**部分覆盖索引**就掉到 43 ms。

🔴 夹具那条只有 6.5× 是因为夹具的行小；真库每行带 7,614 字节的内联 BLOB，
回表代价高得多，**真库上的增益只多不少**（但没在真库上建，所以不写具体倍数）。

**改法**（两侧谓词都必须是确定性的，`TRIM` / `lower` / `replace` 满足）：

```sql
CREATE INDEX IF NOT EXISTS idx_photos_dup_hash_full ON photos(file_hash, file_size)
  WHERE file_hash IS NOT NULL AND TRIM(file_hash) != ''
    AND lower(replace(file_type, '.', '')) NOT IN ('mp4','mov','m4v','avi','mkv','webm','wmv','flv','mpg','mpeg','m2ts','ts','3gp','3g2');
```

⚠️ 这与既有的 `idx_photos_dup_hash_pending`（`(id)` + **互补**谓词）正好成对。
⚠️ **另外**：`getDuplicateHashGroupsBundle` 一次调用内部跑了**两遍**同一个 `GROUP BY`
（`runGetDuplicateGroupCountByHash` + `runGetDuplicateGroupsByHash`），
所以 174 s 要×2；而它在「查重任务收尾」与「侧栏翻页」各调一次 ⇒ 一晚上能烧掉十几分钟。
加索引之外，这两遍也应该合成一遍。

### P1-3 日期视图：表达式索引的形态要选对

真库：`getDateGroups()` 全库 **3,086.9 ms**（热 512.4 ms），计划是
`SEARCH … COVERING INDEX idx_photos_date` + **`USE TEMP B-TREE FOR GROUP BY`**
（因为 `GROUP BY date(date_taken)` 是表达式，索引序对不上）。

夹具上逐个试形态（300,000 行 / 每行 7,600 字节 BLOB，复刻真库的溢出页链）：

| 形态 | 全库日期分组 | 单根日期分组 | 计划 |
|---|---:|---:|---|
| 基线（只有 `idx_photos_date`） | 91.9 ms | 2,311.1 ms | 都有 `TEMP B-TREE FOR GROUP BY` |
| A `date(date_taken)` | 1,355.0 ms ❌ | 465.3 ms | 无临时分组，但**要回表**（`IS NOT NULL` 不在索引里） |
| B `date(date_taken) WHERE date_taken IS NOT NULL` | **26.7 ms** | 476.0 ms | 无临时分组 |
| **C `(date(date_taken), date_taken)`** | **18.9 ms** ✅ | 475.6 ms | 无临时分组，`USING COVERING INDEX` |
| D `(root_id, date(date_taken))` | （被 ix_c 抢先） | 542.6 ms | 无临时分组 |
| **E `(root_id, date(date_taken)) WHERE date_taken IS NOT NULL`** | （被 ix_c 抢先） | **26.5 ms** ✅ | 无临时分组 |

🔴 **形态 A 是个陷阱**：不加 `date_taken` 列 / 不加 `WHERE date_taken IS NOT NULL`，
`WHERE date_taken IS NOT NULL` 就没有索引可依 ⇒ 每行回表，反而**从 91.9 ms 涨到 1,355 ms**。

⇒ 全库视图要 **C**，单根视图要 **E**，两条形态不同、不能互相顶替。
若只想要一条：优先 **E**（单根 2,311→26.5 ms），全库继续用现在那条（也可改走记忆化）。

### P1-4 「查找相似图片」：140 s

```
F3  SELECT id, folder_path, dhash FROM photos
    WHERE dhash IS NOT NULL AND TRIM(dhash) != ''
      AND dhash NOT IN (SELECT dhash … GROUP BY dhash HAVING COUNT(*)>1)
    ORDER BY folder_path ASC, id ASC
    实测 139,862.4 ms  行数 = 507,757
```

**诊断（未建索引验证）**：SELECT 列表里有 `folder_path`，而 `idx_photos_dhash(dhash)`
不含它 ⇒ 50.7 万次回表；`ORDER BY folder_path, id` 又没有可用的序。
候选：部分覆盖索引 `(folder_path, dhash) WHERE dhash IS NOT NULL AND TRIM(dhash) != ''`
—— 既覆盖 SELECT 列、又给出 `folder_path` 序。
⚠️ 列在 BLOB **之后**（`dhash` 是 cid 29，BLOB 是 cid 11），所以这条的回表尤其贵。

---

## 4. 一条差点被误报的「缺陷」（记下来当教训）

排查中途我查到：

```
16:49  索引总数 25，没有 idx_photos_root_folder_date
16:57  索引总数 26，有 idx_photos_root_folder_date，**没有** idx_photos_root_date
16:58  同上（仍然没有）
```

`deferred-index-worker.js` 的 Phase 4 把两条 `CREATE INDEX` 放在**同一个 `try`** 里，
一旦第二条失败只会写进 `startup-performance.json` 的 `deferred-index.worker.done`，
而 `logger` 在打包版是 `warn` 级、且**根本不落文件**（`src/main/logger.js` 只写 console）。
所以当时看起来完全像「只建出来一条、且没有任何现场」的真实缺陷。

**但 16:59 再查，两条都在了** —— 延迟索引 worker 当时正在建第二条，`A10` 那 60.7 s
就是在「一边建索引一边查」的污染状态下量的。

**教训**：在**活的**库上量索引相关的东西，必须**量前量后各查一次** `sqlite_master`，
否则会把「worker 正在建」的中间态当成缺陷报给用户。本文件里凡是引用「建索引后」的数字，
都已核对过索引确实存在。

顺带两条**别踩**的：
- `SELECT COUNT(*) FROM photos_fts`（**不带 MATCH**）在外部内容表上会退化成
  **对 14 GB 的 `photos` 整表扫描** —— 我第一版盘点探针在这行上卡了 4 分 44 秒。
  产品代码里没有这行（全工程 `photos_fts` 只有 `MATCH` 子查询与 `rebuild`），但别再写进去。
- `dbstat`（`WHERE aggregate=1` 也一样）在 14 GB 库上要把每一页走一遍，
  同样 4 分 44 秒没跑完。估索引体积用「行数 × 宽度外推」就够，别跑它。

---

## 5. 写路径 / 存储（顺带量到，与上一份 `scan-incremental-plan.md` 的 P2-3 同源）

- `idx_photos_hash(file_hash)` 与 `idx_photos_file_hash(file_hash)` **定义完全重复**，
  且 `idx_photos_hash` 在全工程**零引用**（已 grep 确认：只有 `idx_photos_file_hash` 被创建）。
  真库 25 条 photos 索引里这是纯浪费 —— 每次 INSERT/UPDATE 多维护一份。
- `file_exists` 列 + `idx_photos_exists` 同样零引用。
- 这两条 `DROP INDEX` 在大库上要单独排期（持写锁），**先 grep 确认没有守护在钉**。

---

## 6. 已经量过、确认**不**需要动的（省得下次再查一遍）

| 语句 | 实测 | 结论 |
|---|---:|---|
| 切目录：目录内计数 / 视频计数 / 首屏页 | 11.7 / 133.9 / 5.0 ms | 已用 `MULTI-INDEX OR`，够快 |
| 不含子目录的目录页 | 4.1 ms | 够快 |
| 目录内按 `date_taken` 排 | 2.2 ms | 够快 |
| 全库列表各排序（`file_name`/`file_size`/`folder_path`/`date_modified`） | 6.7 / 7.2 / 8.8 / 1.3 ms | 各有索引 |
| 某一天的图片 | 0.3 ms（范围写法） | 够快 |
| `getPhotoInfo(id)` | 0.4 ms | 够快 |
| 缺缩略图计数 | 10.0 ms | 够快 |
| 缺 `file_hash` 计数 | 133.0 ms（热 6.6） | 够快 |
| **人脸 / 语义「待处理」批取（跨库 LEFT JOIN）** | **1.2 / 0.4 / 0.5 / 3.6 ms** | ⚠️ 见下 |
| `runGetFolderCovers({rootId})` **无分页**那支 | 68,900.0 ms | **不可达**，见下 |
| dHash 重复组计数 | 686.8 ms（热 93.0） | 低频，够快 |

**「人脸 / 语义批取很慢」这个怀疑被数据否掉了。** 我原以为
`p.id < ? AND (跨库 LEFT JOIN 判定) ORDER BY p.id DESC LIMIT n` 在任务尾部会退化成
每批扫全表。实测不是：`faceindex.scans.photo_id` 与 `semantic.embeddings.photo_id`
都是**主键（rowid）**，逐行查找是 O(1)，计划是
`SEARCH p USING INTEGER PRIMARY KEY (rowid<?)` + `SEARCH s USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN`
⇒ `LIMIT n` 凑满即停，1.2 ms。**不需要动。**
（旁证：`faceindex.scans` 24.6 万行、`semantic.embeddings` 7,374 行，两张表都没有二级索引，
但因为查找走的是主键，不影响。）

**`runGetFolderCovers` 那 69 秒的分支是死路**：它只在调用方**没有**传 `page` / `pageSize`
时才走（`hasPaging` 为假的旧路径）。而桌面端 `app.js` 恒传 `{page, pageSize, …}`、
网页端 `web-server.js#parsePageOptions` 也恒给两者 ⇒ **两端都到不了**。
留着它是个陷阱（哪天有人用 `getFolderCovers({})` 就会踩 69 秒），建议要么删、要么在函数头
写明「只有分页支是活路」。真在用的分页支实测 348.9 ms（热 92.7 ms）。

---

## 7. 复现方式

全部只读、单线程、不建索引、不写用户库。跑法统一是：

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe .workbuddy/tmp/<脚本>
```

🔴 **两条纪律（都是本轮实测踩出来的）**：

- **慢探针必须后台跑**。`inventory` 本机要 **~100 s**，超过 shell 的 2 分钟默认超时就会被 SIGTERM 打断；
  而被打断时 `console.log` 的**块缓冲**内容会整个丢掉，看起来「一个字都没输出」——**其实日志文件里已经写了**。
  ⇒ **永远看日志文件，不要看管道后的 stdout。**
- **日志末尾必须有 `[完成] 用时 N s`**，没有就是**这次没跑完，别当结论用**。
  本轮 `inventory` 就被打断过两次，日志只写到第 7 列。
- ⚠️ `inventory` 的耗时**不在 SQL 写法上**：把 16 趟扫描合并成一趟后总时长**没有质变**（100.1 s），
  因为主导成本是**本轮第一次冷全扫要真读 14 GB 的盘**（那一趟自己就 **98.5 s**，此时应用的后台补全还在抢盘）。
  它的「列非 NULL / 空串率」一节**默认只扫 BLOB 之前那批列**；要扫 BLOB 之后的加 `AURORA_CARD_FULL=1`。

| 脚本 | 作用 | 产物 |
|---|---|---|
| `.workbuddy/tmp/sql-audit-inventory.js` | 索引清单 / 行数 / 列序 / 非 NULL 与空串率 | `sql-audit-inventory.log` |
| `.workbuddy/tmp/sql-audit-measure.js` | A~G + Z 共 40 余条语句的计划与耗时 | `sql-audit-measure.log` |
| `.workbuddy/tmp/sql-audit-focus.js` | 索引干净复测 / 搜图拆解 / 统计拆解 | `sql-audit-focus.log` |
| `.workbuddy/tmp/sql-audit-plans.js` | 只取计划（不测耗时，代价极小） | stdout |
| `.workbuddy/tmp/sql-audit-candidates.js` | 真库 `INDEXED BY` 对照 + 夹具候选索引 + 12 条反向对照 | `sql-audit-candidates.log` |
| `.workbuddy/tmp/sql-audit-dateidx.js` | 日期索引五个形态的选型 | `sql-audit-dateidx.log` |
| `.workbuddy/tmp/index-state-check.js` | 两条新索引在不在（读 `sqlite_master`，**活库上量前后各跑一次**） | stdout |
| `.workbuddy/tmp/col-cid-check.js` | 关键列 cid（判断回表要不要穿溢出页链） | stdout |

⚠️ 上表这 8 份是**本轮运行时的存档副本**（正文与 skill 那份逐字一致，只有头部引模块的方式不同）；
**以后要改探测逻辑，以 skill 那份为准**，改完同步回来 —— 见下一节。

六条候选索引都**没有**在真库上创建 —— 那要占住用户正在用的写锁与磁盘。
P1 那四条只做到「夹具上计划确实翻转 + 真库上现状确实慢」，
真库上的建索引耗时与最终增益**仍未量**。

### 换用 skill 里的那一份（推荐）

同一套探针已收进技能 `~/.workbuddy/skills/aurora-sql-plan-audit/`，下次复量直接用那边，
不必回去翻 `.workbuddy/tmp/`：

```bash
S=~/.workbuddy/skills/aurora-sql-plan-audit/scripts
cd <仓库根>
AURORA_REPO=<仓库根> ELECTRON_RUN_AS_NODE=1 \
  ./node_modules/electron/dist/electron.exe $S/sql-audit-plans.js
```

⚠️ skill 那份与 `.workbuddy/tmp/` 这份的**唯一差别**是它多一个 `_shared.js`，
各脚本通过 `require('./_shared.js')` 拿 `ROOT` / `Database` / `DB_PATH`。
原因是脚本一旦搬出仓库，裸写 `require('better-sqlite3')` 就会从脚本所在目录向上
命中 `C:\Users\<用户>\node_modules\…` 那份**全局副本**，而它按另一个 ABI 编译：

```
ERR_DLOPEN_FAILED: ... was compiled against a different Node.js version using
NODE_MODULE_VERSION 127.  This version of Node.js requires NODE_MODULE_VERSION 145.
```

🔴 这个错**看起来像「electron 跑法错了」，其实是模块解析路径错了**，与 cwd 无关
（cwd 不影响以 `__dirname` 为起点的解析），靠「记得先 cd」修不掉。
只有 `createRequire(path.join(ROOT, 'package.json'))` 才能把解析起点钉在仓库根。

⇒ 要改探测逻辑时**以 skill 那份为准**，改完再同步回 `.workbuddy/tmp/`，别两边各改一版。

另外两点：

- 日志一律**写回仓库** `<repo>/.workbuddy/tmp/*.log`（走 `_shared.js#outPath()`），
  即使从 skill 目录跑也不往 skill 里撒日志；`AURORA_OUT_DIR` 可覆盖。
- 可用的开关：`AURORA_DB`（换库）、`ROOT_ID`、`ROWS` / `BLOB_BYTES`（夹具规模）、
  `SLOW_BUDGET_MS`、`ROUNDS`、`AURORA_CARD_FULL=1`（真库上再扫 BLOB 之后的列）、`AURORA_DISTINCT=1`。

---

## 8. 落地记录（2026-10-06 本轮实施）

§2 的四条 P0 与 §3 的 P1-1/2/3 索引**本轮已全部落地**；P1-4 刻意未做（理由见 8.6）。
本节只记「实际改了什么、量到了什么」，决策依据仍在 §2 / §3。

### 8.1 真库实测（改动后，只读探针 `.workbuddy/tmp/p0-verify-live.js`）

探针用**只读连接 + 原型借用**（`Object.create(PhotoDatabase.prototype)`），
与读池 worker 跑的是同一条路；全程不写库、不建索引。

| 项 | 改前 | 改后 | 值校验 |
|---|---:|---:|---|
| P0-1 图片档计数（root 23） | 71,617 ms | **52.3 ms** | ✅ 887,313 逐个相同 |
| P0-1 视频档计数 | 57,651 ms | **1.6 ms** | ✅ 24,909 逐个相同 |
| P0-2 + P0-3 搜 `IMG`（整条） | ~58,000 ms | **116.7 ms** | ✅ 544,235 逐个相同 |
| 搜 `DSC`（51,298 命中，低于阈值） | 42.6 ms | 未变 | ✅ 分流决策正确 |
| 搜 `qqqzzz`（0 命中） | 0.3 ms | 未变 | ✅ 未被索引序拖慢 |
| P0-4 统计第 1 次（冷） | 8,616 ms | 7,876 ms | — |
| P0-4 统计第 2 / 3 次 | 949 ms | **0.1 / 0.0 ms** | ✅ 三次结果一致、且返回**不同对象引用**（浅拷贝保护生效） |

`IMG` 的数值校验是这一轮最要紧的一条：**544,235 与标定时的旧写法实测值逐个相同**
（§8.3 的表里 9 个词都核过）。

### 8.2 P0-3 的阈值：真库标定 —— 而且实测**推翻**了原判断

`.workbuddy/tmp/sql-search-tuning.log`（9 个词，从 544,235 命中铺到 0 命中）：

| 命中数 | FTS 驱动 | 索引序 | 赢家 |
|---:|---:|---:|---|
| 544,235（`IMG`） | 29,379 ms | **151 ms** | 索引序 195× |
| 224,491（`2024`） | 6,059 ms | **63 ms** | 索引序 97× |
| 203,934（`2025`） | 1,280 ms | **58 ms** | 索引序 22× |
| 51,298（`DSC`） | **56 ms** | 89 ms | FTS 驱动 1.6× |
| 16,590（`DSC0`） | **22 ms** | 65 ms | FTS 驱动 2.9× |
| 0（不存在的词） | **0.3 ms** | 135 ms | FTS 驱动 450× |

🔴 **原判断错了**：§2 里写的是「冷门词会从 0.5 ms 变成 3,487 ms，所以宁可走旧写法」。
标定出来的冷门词代价只有 **134~184 ms**（热读；3,487 ms 那次是冷读索引的极端值）。
真正的形态是「**两侧极度不对称**」：

- FTS 驱动的耗时随命中数**超线性**涨：51k→204k 只多了 4 倍命中，耗时涨了 **23 倍**（56 → 1,280 ms）；
- 索引序近似**恒定**：58~89 ms，冷读最坏 184 ms。

⇒ 阈值取错，一边的代价是几十毫秒、另一边是**几十秒**。
⇒ 最终取 **`SEARCH_INDEX_ORDER_MIN_HITS = 100000`**：比实测交叉点（51,298 ~ 203,934 之间）
略高，宁可让中等命中数多花 30~300 ms，也绝不让大命中数掉进秒级。
搜「IMG」这类相机通用前缀（本机 544,235 命中）是最常见的搜法，它必须走索引序。

**并列序副作用已确认**：9 个词里只有 2 个（`IMG` / `2025`，都是含同秒并列的词）首行 id 变了。
`searchPhotos` 这条路本来就没有 `applyNaturalNameTieSort`（`getPhotos` 有），
所以并列项的先后在此之前就是未定义的。

### 8.3 P0-2 的等价性：9 个词逐个相同

```
IMG        命中=  544235  新 85.0 ms   旧  29398.3 ms  ✅ 相等
DSC        命中=   51298  新 14.2 ms   旧   2081.8 ms  ✅ 相等
2024       命中=  224491  新 33.3 ms   旧  14474.2 ms  ✅ 相等
2025       命中=  203934  新 51.9 ms   旧  14880.5 ms  ✅ 相等
DSC0       命中=   16590  新  6.8 ms   旧    465.6 ms  ✅ 相等
P1050/0 命中/ MVI/80 / qwertyuiop/zzzzzz/0 命中        ✅ 各条都相等
```

这条等价性的依据是三个触发器（`photos_fts_ai/ad/au`）让外部内容表与 `photos` 保持同步 ——
**不能靠「应该同步」四个字**，所以它被写成了回归里的一条机械断言（见 8.5）。

### 8.4 索引清单的唯一真相源：`src/main/deferred-indexes.js`（新建）

Phase 5 的五条索引 DDL 抽到了独立模块，**worker 与回归共用同一份字符串**。

为什么值得单独抽：`scripts/read-latency-regression.js` 要在夹具上照着 DDL 建索引、
断言执行计划真的翻转；而部分索引的 DDL 是**拼接**出来的（视频档谓词嵌在 `WHERE` 里），
回归没法用正则从 worker 源码里把 `WHERE` 整段提出来。提不到就只能手抄一份等价 DDL ——
而 SQLite 的部分索引匹配是**逐字**的，抄错一个字符索引就静默失效、回归照样绿。

顺带消掉了一处重复：视频档后缀清单过去在 `deferred-index-worker.js` 里**另抄了一份**
（`imgPred` / `vidPred`），现在统一从 `db-heavy-read.js` 取。
三处（`db-heavy-read#IMAGE_TYPE_PRED`、`deferred-indexes`、`database#_sqlFileTypeIsImageExpr`）
已程序化比对为**逐字相同**。

### 8.5 回归守护（`scripts/read-latency-regression.js` 新增三节）

| 函数 | 守什么 |
|---|---|
| `checkPhase5IndexPlans` | 五条索引：DDL 形态（必须含 `IF NOT EXISTS` / 两条必须是部分索引）＋ **建索引前先钉住「旧计划是慢形状」** ＋ 建后计划翻转（临时排序 / 临时分组消失） |
| `checkMediaCountIndexHint` | 索引**不存在时不许加 hint**（`INDEXED BY` 指向不存在的索引是 `no query solution`，直接抛）＋ 形状不对（无 rootId / `all`）不加 ＋ **加 hint 后值逐个相同且计划真的换索引** ＋ `hasIndex` 的 TTL 必须有界 |
| `checkSearchIndexOrder` | P0-2 两种 total 写法逐个相同 ＋ **换索引序后 WHERE 仍生效**（逐行核对取到的 id 都在 FTS 命中集里）＋ 分流常量存在且挂在 `totalCount` / `!hasExtraFilter` 上 |

**每颗新牙都做了反向验证**（`破坏 → 跑 → 看红 → 还原`），三条实际跑过：

- 把 `idx_photos_root_name` 的列改成 `(root_id, date_taken)` ⇒ 红，报
  「按文件名排序必须走 (root_id, file_name)…SEARCH … USE TEMP B-TREE FOR ORDER BY」；
- 去掉 `mediaCountIndexHint` 的 `hasIndex` 闸门 ⇒ 红，报「索引还不存在时不许加 hint」；
- 去掉 `indexOrderUsable` 的 `!hasExtraFilter` ⇒ 红，报「有附加筛选时不许走索引序」。

另外夹具上补了一条数据（`UPDATE photos SET file_type = 'mp4' WHERE id % 20 = 0`）：
夹具 seed 的 `file_type` 全是 `'jpg'` ⇒ 视频档 0 行，而「加 hint 后值相同」那条断言
在 0 == 0 上不具区分度 —— 这是断言里的哨兵自己报出来的。

### 8.6 刻意没做的三件事

1. **P1-4「查找相似图片」的 `(folder_path, dhash)` 部分索引**：`dhash` 是 cid 29、
   排在 7.6 KB 的内联 BLOB **之后**，回表要穿整条溢出页链 —— 收益与代价都**还没在真库上量过**。
   不拿没量过的东西上生产。它那条 139,862 ms 先留在「待量化」里。
2. **P1-2 提到的「`getDuplicateHashGroupsBundle` 内部跑两遍同一个 GROUP BY」合并**：
   属重构、要动查重链路，且加索引之后单遍已经会从 174 秒掉到秒级 ⇒ 先看加索引后的真实数字再决定。
3. **`sharp.concurrency(1)`**：缩略图并发实测里，`sharp.conc=1 × JS=8` 是 **68.6 张/秒**，
   比默认的 `sharp.conc=16 × JS=8`（58.6）再快 **17%** —— 因为 libvips 内部线程对
   「读头 + 9×8 dHash + 256 px 缩略图」这类小图操作几乎无效（`sharp.conc=16 × JS=1` 只有
   18.0 张/秒，与单线程一样）。但它会同时影响人脸 / 语义 / 网页端共 7 个模块的 sharp 用法，
   **收益（17%）与影响面不对等** ⇒ 本轮不动，记在这里待评估。

### 8.7 ✅ 五条新索引已在真库上建成（2026-10-06 18:46）

由 `deferred-index-worker` Phase 5 在本次启动、窗口画完之后自动建：启动 **+12.724 s** 入队，
约 18:46 建完，历时 **6~10 分钟**。只读探针实证（`sqlite_master`）：

- 真库 `photos` 上现有 **42 个索引**，Phase 5 的五条全部在位 ——
  `idx_photos_root_name` / `idx_photos_root_size` / `idx_photos_dup_hash_full` /
  `idx_photos_date_day` / `idx_photos_root_date_day`（Phase 4 两条也在）。
- 建索引期间 `photos.db` 从 **15,446,745,088**（17:55）涨到 **15,764,000,000+**（18:48）
  ⇒ 约 **+317 MB**（§3 外推 250 MB，同量级）；中途有数分钟**完全无 IO**（排序阶段），
  看起来像卡死 —— **不是**，随后又继续长。
- 下次启动这五条是 `IF NOT EXISTS` ⇒ 秒过，不再占写闸门。

⚠️ **两条被实测纠正的说法（上一版写错了）**：

1. 🔴 **不要靠 `startup-performance.json` 核对建索引结果。** `stages` 有 **120 s 采集截止**
   （`startup-metrics.js#deadline`），耗时超过 2 分钟的 `deferred-index.worker.done`
   **落在窗口外被静默丢弃** ⇒ JSON 里会出现「只有 `db-write.start`、没有配对 `done`」的假象。
   **我上一轮据此误判成「写闸门仍被占」**，真因是采集窗口，不是任务没结束。
   核对索引是否建成，唯一可靠手段 = **只读探针查 `sqlite_master`**（见 §8.8）。
2. ⚠️ 建索引完成后 **`sqlite_stat1` 仍然不存在** ⇒ 规划器依旧纯启发式，**没有跑 `ANALYZE`**。
   索引对「唯一明显候选」的查询有效（§4 已逐个证实计划翻转），但复杂查询仍可能选错。
   待评估：Phase 5 之后补一次 `ANALYZE`（它本身也要扫全部索引，代价不小）。

### 8.8 可复用的真库只读探针（WAL 库也能读，本轮最大教训）

应用正在运行时该库是 WAL 且 `-shm` 已在，因此

```
sqlite3.connect('file:<photos.db>?mode=ro', uri=True)
```

**可以成功只读打开**。⚠️ **禁用 `immutable=1`** —— 它会忽略 WAL、读到旧快照，结论会反向。

用它可以直接数 `has_thumbnail = 1` 的增量（走 `idx_photos_id_hasThumb` 覆盖索引）来
**量后台任务的真实速率**，不必再从 JSON 反推：

```
18:48:23  有缩略图 = 1,432,427
18:48:44  有缩略图 = 1,432,953   (+526 / 20.1 s = 26.2 张/秒)
```

并发设 8（用户 settings 值）时真库实测 **26.2 张/秒** —— 介于 §7 夹具的冷读 C=8（15.8）
与热读（58.6）之间，因为真库同时在与写库竞争。还缺约 **22.4 万张** ⇒ 按此速率约 **2.4 小时**。
