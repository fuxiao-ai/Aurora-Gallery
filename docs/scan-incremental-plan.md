# 启动三任务的增量合理性改造 · 实施计划

对象 = 设置页「启动后自动执行」的三项：`autoScanOnStartup` / `autoThumbBackfillOnStartup` /
`autoHashOnStartup`（本机三项全为 true）。目标一句话：**快速找出变更与缺失的文件，快速跳过不变的。**

本文只写「做什么、判据是什么、怎么证明」，不写实现细节。动手前先读
`.workbuddy/memory/CONTRACTS.md` 的 §启动期写库任务契约 / §后台任务的扫描方向 / §缩略图档位与体积。

> ⚠️ **本计划有两处判断已被 2026-10-06 下午的实测推翻**，动手前先读文末
> 「§九、实测更正 + 效率优先排序」——那里还有一条**已经落地**的效率改动（省 58%）
> 和一条**新发现的真实缺陷**（视频永久占用候选集）。
> 第一、二节的候选集与谓词数字**仍然有效**，但结论要按第九节修正。

---

## 一、实测基线（2026-10-06 08:2x，只读真库，未改一行代码）

| 项 | 值 | 备注 |
| --- | --- | --- |
| 库体积 | 12.4 GB（4096 × 3,260,504 页） | 约 **1 行/页** ⇒ 一次全表扫 = 326 万页读 |
| 根目录 | `K:\COS`(91.2万行) / `G:\T` / `G:\国模` | `MAX(id) = 1981503` |
| `has_thumbnail = 0` | **432,116** | 16 ms，走 `idx_photos_missing_thumb` |
| `dhash` 缺失 | **1,330,381** | 519 ms，走 `idx_photos_dhash_pending` |
| `file_hash` 缺失 | **457,581** | 3.4 s，走 `idx_photos_dup_hash_pending` |
| `width` 缺失 | **1,329,826（80%）** | **65.3 s** —— 无索引，全表扫 |
| 启动 | `submit`@12.35 s → `first-grid-paint`@**67.6 s** | 扫描占满整个会话 |

两条最硬的异常：

- 🔴 `has_thumbnail = 0` 与 2026-10-05 22:4x 记录的 **432,116 完全相同** ⇒ 补全任务在这个库里
  **约 10 小时零进展**。
- 🔴 同次启动 `auto-dup-hash.defer` 从 13.07 s 起**每 5 s 一条、共 42 条**（到 115.9 s 仍在 defer）
  ⇒ 扫描跑满整个会话，**另两项一次都没开始**。

采样（最新 12 行 + 中部 6 行）**`width`/`height` 全是 0** ⇒ 尺寸回填在活库上**一行没落地**。

---

## 二、已定决策（2026-10-06，用户拍板）

1. **变更捕获** = 两档扫描 + 全量校验入口。启动走目录门控的增量扫描；
   「重新扫描全部」改为逐文件 stat 的全量校验（今天两者是**同一个实现**）。
2. **②③ 与 ① 的并发** = 按磁盘档位自动切换。`scanDiskProfile === 'hdd'` 维持互斥；
   `ssd` / `auto` 允许与扫描并行（扫描是元数据 IO，补全是读文件内容，SSD 上不冲突）。
3. **变更即全清派生列**。被替换的文件把缩略图 / dHash / 查重指纹一并打回待补，
   数量只等于真正变过的文件数，并把计数上报到 `scanResult`。
4. **`width`/`height` 回填拆成独立迁移任务**，从补全谓词里拿掉。

---

## 三、P0 修「永不收敛」（独立可发布，先做）

### P0-1 变更的文件必须 UPDATE，而不是被 IGNORE

**现状**：`scanner.js:807` 走 `insertStmt.run(...)`，而 `insertStmt` 是
`INSERT OR IGNORE`（`database.js:2186`）。文件 mtime/size 变了 → 被判为待处理 → 但同路径已存在
→ `changes = 0` → 返回 `'ignored'`，`file_size` / `date_modified` / `thumbnail` / `has_thumbnail` /
`dhash` / `file_hash` **全保持旧值**。下一轮它**再次**被判定为变更 ⇒ **候选永不收敛**。
全工程**没有任何** `UPDATE photos SET file_size = ?` / `date_modified = ?`。
影响：就地替换的图片，缩略图与指纹**永远不失效**。（与 CONTRACTS 里 `width=0` 那起是同一类 bug。）

**改动要点**

- `database.js#iterateExistingFiles(rootId)` 的 SELECT 补 **`id`**（现在只有
  `file_path, date_modified, file_size`，`existingMap` 里没有 id 就无法 UPDATE）。
- 新增 `updatePhotoFileFacts(id, { fileSize, dateModified, fileType })`，**同一个事务**里
  一并把派生列失效：`has_thumbnail = 0, thumbnail = NULL, thumb_size = 0, thumb_format = '',
  dhash = NULL, dhash_mtime = NULL, dhash_size = NULL, file_hash = NULL, hash_mtime = NULL,
  hash_size = NULL, width = 0, height = 0`。
- 🔴 **`is_favorite` 不许动**（用户数据，与文件内容无关）。
- `processFile` 在 `existingMap` 命中且 mtime/size 不一致时走 UPDATE 分支，返回值用新的
  `'updated'`；`scanResult` 新增 `changed` 计数（现在只有 inserted / ignored / relocated）。
- ⚠️ 只判 mtime+size 不够时说清楚：两者相同但内容变了的情况**本方案不解决**，
  那是 P1-3 全量校验的职责。

**判据 / 守护**：`scripts/scan-queue-regression.js` 增行为断言（临时库真跑：写一行 → 改文件
mtime → 重扫 → 行的 `file_size`/`date_modified` 是新值且派生列全空）；静态断言
「`processFile` 不得只有 `INSERT OR IGNORE` 一条写路径」「`insertStmt` 的 OR IGNORE 语义不得回退」。
牙齿：删掉 UPDATE 分支后该组断言必须精确变红。

### P0-2 去掉冗余 stat 与 realpath

**现状**：`enumerateFiles`（`scanner.js:622`）对**每个 entry** `fs.statSync`，结果只用来判
`isDirectory()` / `isFile()` —— 而 `readdirSync(dir, {withFileTypes: true})` 已经给了这个信息；
随后 `incremental-partition`（`scanner.js:393`）对每个文件**再 stat 一次**拿 mtime/size。
⇒ 122 万文件 = **244 万次 stat**。另有每目录一次 `fs.realpathSync`（`scanner.js:584`）。

**改动要点**：优先用 `entry.isDirectory()` / `entry.isFile()`；仅当 dirent 类型未知
（`!isFile() && !isDirectory() && !isSymbolicLink()`）或 `followSymlinks` 时才回落到 `statSync`。
`realpathSync` 只在 `followSymlinks` 时用于环检测。

**判据**：同一棵目录树，改动前后 `enumerate-files` 阶段耗时对比（`perfMark` 已有），
以及枚举结果集**逐项全等**（用临时目录树夹具断言）。⚠️ 不得改变符号链接语义。

### P0-3 让路改成「有上限」

**现状**：`main.js:2534` 的让路是**每 5 s retry、永不放弃**；`tryRunThumbnailBackfillWhenIdle`
（`main.js:2500`）是**一次性尝试**，且重触发只有「扫描**成功**结束」这一条（`main.js:1744`）。
⇒ 扫描被取消 / 未结束 ⇒ ②③ 整个会话不跑。

**改动要点**

- 有上限的 defer：最多重试 M 次（建议 M 使总等待不超过 ~10 分钟），到点**强制**抢一次机会。
- 扫描结束的重触发扩展到「取消 / 失败」两条出口，不只 `hasSuccessfulScan`。
- 42 条 `auto-dup-hash.defer` 日志压成**一条带计数的汇总**（每次状态变化打一条，不要每 5 s 打）。

**判据**：跑一次真启动，`startup-performance.json` 里 `auto-dup-hash.start` **必须出现**。

---

## 四、P1 真正的「跳过不变」（任务①的重头）

### P1-1 目录快照表

新增 `scan_dirs(root_id, dir_path, mtime_ms, entry_count, scanned_at)`，
建表走 `db.init()` 里的 `CREATE TABLE IF NOT EXISTS`（🔴 项目红线：加列/加表必须在
`db.init()` 同步，改延时 = 老库首次启动报 `no such column`）。

- 每个目录只做 **1 次 `statSync`** 拿 `mtime_ms`（3.1 万次，替代今天的 122 万 × 2）。
- 🔴 **首次运行没有基线**：升级后的第一轮扫描**仍必须全量**，只是顺带把快照写下来；
  从第二轮起才有门控。**不许**把「表是空的」当作「都没变」。
- 🔴 **网络盘 / FAT 的目录 mtime 可能不可靠**（SMB 挂载、mtime 恒 0）。要有降级：
  `mtime_ms` 为 0 或异常时按「已变更」处理。`K:\COS` 是哪种盘要先确认。
- ⚠️ **目录 mtime 只反映"这一层目录条目增删改名"，不反映文件内容就地替换** —— 这是本方案
  唯一的语义缺口，由 P1-3 兜。

### P1-2 目录级对账，替代三份全量副本

**现状**：一次扫描要维护 **3 份全量路径列表** —— `existingMap`（Map，91 万条）、
`scannedPathSet`（Set，122 万条）、`cleanupStalePhotosForRoot`（`database.js:2233`）
的 `SELECT id, file_path WHERE root_id = ?`（91 万行数组）。

**改动要点**

- 目录 mtime 未变 ⇒ **整目录跳过**，不 readdir、不 stat 文件，直接沿用库里的行。
- 目录 mtime 变 ⇒ 只 `readdir` **这一个目录**，然后按 `folder_path` 取库里该目录的行
  （走现成的 `idx_photos_root_folder`），做三路对账：新增插入 / 变更 UPDATE（P0-1）/ 消失删除。
- 目录本身不存在 ⇒ 按 `folder_path` 前缀删掉该目录下所有行。
- 于是 `existingMap` / `scannedPathSet` / 全局集合求差**全部删掉**。

**收益**：稳态启动从「3.1 万目录 + 122 万 stat + 3 份全量副本」降到「3.1 万次目录 stat」。

### P1-3 两档扫描语义

- **增量扫描**（`source: 'auto'` / 手动点某个目录）＝ 目录门控 + 目录级对账。
- **全量校验**（`rescan-all-folders`，`main.js:5178`）＝ 今天的行为：逐文件 stat 比对，
  能捕获「就地替换了内容但目录 mtime 没变」。
- 🔴 今天这两者走的是**同一个** `enqueueScanTask`，没有档位参数 ⇒ 必须显式加，并在
  `getScanQueueStatus()` / 进度文案里区分，否则用户看不出自己在跑哪一档。
- ⚠️ 既有守护 `scripts/settings-rescan-all-regression.js`（**必须带看门狗**）要同步更新，
  它现在钉的是「三处全 0 入参」，「全量校验」档位参数会动到这条契约。

**判据 / 守护**：新增 `scripts/scan-dir-snapshot-regression.js`，并在
`scripts/run-regressions.js`（唯一入口）注册。必须覆盖：
① 目录 mtime 未变 ⇒ 该目录下的文件**一个都没 stat**（行为面，不要只断言"跳过了"）；
② 新增 / 删除 / 改名 / 二级子目录新增，四种情况对账结果正确；
③ 快照表为空时**必须全量**（不许把空表当"都没变"）；
④ `mtime_ms = 0` 时按已变更处理；
⑤ 变更文件走 UPDATE 且派生列被清（与 P0-1 联动）。
牙齿：把门控改成恒真（永远跳过）后，②必须变红。

---

## 五、P2 谓词与索引

### P2-1 把 `width` 从补全谓词里拿掉

**现状**：`database.js:186` 的 `_sqlBackfillPendingExpr()` =
`(has_thumbnail = 0 OR dhash IS NULL OR TRIM(dhash) = '' OR width IS NULL OR width = 0)`。
现成三个分部索引（`idx_photos_missing_thumb` / `idx_photos_dhash_pending` /
`idx_photos_dup_hash_pending`）**各只覆盖其中单支** ⇒ 整个 OR 命中不了任何索引，
`EXPLAIN` 退回 `SEARCH photos USING INTEGER PRIMARY KEY` = 每轮全表扫 12.4 GB。

**改动要点**

- 缩略图谓词回归两支：`(has_thumbnail = 0 OR dhash IS NULL OR TRIM(dhash) = '')`。
  拆开后要实测 `EXPLAIN` 确实能命中索引，**不能只看写了索引名**。
- `width` 缺失走**独立的一次性迁移任务**。🔴 **动手前先查清它在活库上为什么一行没落地**
  （实测 1,329,826 行仍是 0）——可能是被扫描压住从未跑过，也可能是 `readOriginalSize` 失败。
  先跑一次真实批次观察写入，再决定要不要动谓词。

### P2-2 「过期」只在一处判定

`dhash_mtime` / `dhash_size` / `hash_mtime` / `hash_size` 现在**只在
`updatePhotoDhashBatch` / `updatePhotoHash` 里写，谓词里从不出现**（连
`idx_photos_hash_mtime_size` 都建了，全废）。本次**不**把过期判定塞进谓词 —— 由 P0-1 在发现
文件变更时直接把派生列置空，「过期」这件事只有**一个**判定点，谓词保持简单。
⚠️ 这条与 P1 是耦合的：取 P1-1 目录门控后就**必须**依赖 P0-1 + P1-3，因为门控会漏掉就地替换。

### P2-3 顺手清死重量

- `photos.file_exists` 列 + `idx_photos_exists` 索引：全工程 `file_exists` **零引用**。
- `idx_photos_hash` 与 `idx_photos_file_hash` 定义**完全重复**。
- ⚠️ `DROP INDEX` 在大库上要单独排期（会持写锁），且**先 grep 确认没有守护在钉** ——
  钉住死代码的回归是假绿，但删掉被守护引用的索引会让回归假红。

---

## 六、P3 可见性

- 三项任务在后台任务面板显示「本轮待办量 / 已完成 / 是否正在让路」——
  现在只有 `.running`，用户看不到「它在等扫描」，这正是本机 10 小时零进展却无人察觉的原因。
- 页面端同步（网页端设置页只保留本设备的浏览与外观偏好，见 CONTRACTS §网页端设置页）。

---

## 七、验收

**离线**：`npm run lint`（基线 0 error / 2 warning，两条在 `src/web/js/app.js`，别修）+
`npm test`（`scripts/run-regressions.js` 是唯一入口，判「跑完没」看 `exit=0` +
末项 `ai-lifecycle-regression`）。

**线上（终极判据，只读真库量）**：跑完一轮后这四条计数**必须下降**——
`has_thumbnail = 0`（432,116）、`dhash` 缺失（1,330,381）、`file_hash` 缺失（457,581）、
`width` 缺失（1,329,826）。**它们已经 10 小时没动，这本身就是现成的基线。**
另看 `startup-performance.json`：`first-grid-paint` 应明显早于现在的 67.6 s，
且 `auto-dup-hash.start` / 补全的 start 必须出现。

⚠️ 量这些计数要**只读**打开真库，不要在主进程同步跑（`width IS NULL OR width = 0` 的 COUNT
实测 65 秒）。⚠️ 重跑 regroup / 重建快照会改写线上库 —— 要动就先备份副本。

---

## 八、红线（照抄自 CONTRACTS，动手前再读一遍）

- 🔴 **回归必须钉活代码**，且行为面断言要**真跑临时库**；`better-sqlite3` 脚本必须用
  electron 跑（纯 node 会 `NODE_MODULE_VERSION` 假红），**跑不起来按失败处理**。
- 🔴 后台任务扫描方向统一 **主键倒序**（`id < ? ORDER BY id DESC`，游标起手取域内最大 id + 1）。
  **只改查询不改调用端 = 恒空、秒完成却零补且不报错。**
- 🔴 写库闸门 `dbWriteQueue` 是唯一准入点，新增任务必须**显式传 `priority`**
  （漏标不报错、只静默落默认档，是最难发现的调度错误）。
- 🔴 长任务按批入队；不许在启动路径上加回任何「错开用」的 `setTimeout`（顺序只由优先级表达）。
- 🔴 加表/加列必须在 `db.init()` 同步；改 `VERSION` ⇒ 索引前 `purgeStale()`。
- 🔴 「静态全绿、线上失效」只有真实 change 探针抓得到 —— 每条断言都要能变红。
