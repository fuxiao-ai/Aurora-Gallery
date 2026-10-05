# Aurora Gallery 相似照片检测设计方案（桌面端）

> 基于 `C:\code\image\media_dedupe.py` 的三级指纹 + 感知哈希思想，整合进 Aurora Gallery 现有重复检测体系。
>
> **设计核心原则**：缩略图生成时同步计算 dHash，复用磁盘 IO；后台任务零阻塞前端；渐进式结果；仅支持图片（视频暂不考虑）。

> ⚠️ **历史文档（2026-10-05 注记）**：本文是落地前的设计方案，其中若干路径**已不存在** —— `src/main/thumbnail-backfill.js`、`src/main/dhash-backfill.js`、`src/main/duplicate-detection.js`、`src/main/ipc-handlers.js` 属 `src/main/*.js` 孤儿链（从未被运行时 `require`），已于 2026-10-05 整链删除（`src/main/` 现仅保留入口可达的 14 个模块，由 `scripts/module-reachability-regression.js` 守护）。**这些能力当前都在 `src/main.js` 里**：缩略图补全 + 同步 dHash 在 `runRowsWithThumbConcurrency`（`processOne` 内，同一 sharp 实例先读文件头再走 resize pipeline）、重复哈希检测在 `duplicateHashTask` 一族、IPC 各通道由 `main.js` 直接 `ipcMain.handle` 注册。本文的**设计推理仍然有效**；但下方的文件清单与勾选项是**当时的计划**，不是当前的落点 —— 照着改文件不会有任何效果。见 `CHANGELOG.md` 2026-10-05 的 Changed / Fixed 两条。

---

## 1. 目标与约束

### 1.1 目标
- 在现有「精确重复」（SHA-256）基础上，增加「相似重复」检测能力。
- 检测场景：不同压缩率导出、微信转发压缩、轻微裁剪/调色、不同格式（JPG↔PNG）但视觉内容相同。
- 用户可在 UI 中切换「精确重复」与「相似重复」两种查询模式。

### 1.2 约束
- **仅桌面端**：Electron 主进程 + Renderer 进程。
- **不引入 Python**：全部用 Node.js / npm 实现。
- **复用现有基础设施**：`sharp`（已存在）、`better-sqlite3`（已存在）。
- **范围**：仅图片（JPG/PNG/WEBP/BMP/GIF/HEIC/RAW 等），**视频暂不考虑 dHash**。
- **前端零阻塞**：后台任务再耗时，不能影响浏览、预览、搜索。

---

## 2. 核心设计决策

### 2.1 感知哈希算法：dHash（水平差值哈希）

| 候选方案 | 评估 |
|---------|------|
| `blockhash` npm | 新增 native 依赖，编译风险 |
| `sharp` + 自定义 aHash | 对亮度变化敏感 |
| **`sharp` + 自定义 dHash** ✅ | 纯 JS 计算，对压缩/亮度鲁棒，无需新依赖 |

**dHash 算法**：
1. `sharp` 灰度化 + resize 到 **9×8**（`fit: 'fill'`）
2. 每行 9 个像素，相邻两两比较：左 > 右 记为 1，否则 0
3. 每行 8 bit，8 行共 **64 bit** → 16 位 hex 字符串存储

**关键特性**：同一图片的不同压缩版本（微信压缩、不同质量导出），resize 到 9×8 后梯度方向通常不变，**dHash 通常完全相同（distance = 0）**。这意味着 SQL `GROUP BY dhash` 就能捕获大部分相似重复。

### 2.2 相似度度量：汉明距离

- 64-bit dHash，汉明距离 ≤ **threshold** 认为相似。
- 阈值：严格(8) / 标准(12) / 宽松(16)
- UI 展示：`similarity = Math.round((1 - distance/64) * 100)`%

---

## 3. 数据库 Schema 扩展

### 3.1 photos 表新增列

```sql
ALTER TABLE photos ADD COLUMN dhash TEXT;
ALTER TABLE photos ADD COLUMN dhash_mtime TEXT;
ALTER TABLE photos ADD COLUMN dhash_size INTEGER;
```

### 3.2 LSH 辅助表（用于近似匹配召回）

```sql
CREATE TABLE IF NOT EXISTS photo_dhash_lsh (
  photo_id INTEGER NOT NULL,
  band INTEGER NOT NULL,    -- 0..15
  bucket INTEGER NOT NULL,  -- 0..15
  PRIMARY KEY (photo_id, band),
  FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_lsh_lookup ON photo_dhash_lsh(band, bucket);
CREATE INDEX IF NOT EXISTS idx_photos_dhash ON photos(dhash);
CREATE INDEX IF NOT EXISTS idx_photos_dhash_pending ON photos(id)
  WHERE dhash IS NULL OR TRIM(dhash) = '';
```

**数学**：16×4-bit LSH，threshold=12 时漏召回率 < 0.02%，召回率 > 99.98%。

#### ⚠️ 召回率不是全部：本参数化在大库上几乎没有精确率（2026-09-29 实测）

上面那个 99.98% 只是**召回**。同一套参数在大库上的**精确率**极差，而且它曾经把一个功能
直接打挂过 —— 用户侧报错 `查找相似照片失败：SqliteError: too many SQL variables`。

根源是 band 只有 **4 bit**：全库只有 `16 band × 16 bucket = 256` 个桶。

| 量级 | 有 dHash 的照片 | 平均每桶 | 单张照片的候选集 |
|-----|---------------|---------|----------------|
| 本机真库 | 238 936 | ≈ 14 935 | **143 579 – 179 169** |

也就是说**候选集恒等于「全库有 dHash 的照片的 60%–75%」**，索引基本不做剪枝；
最终结果只有 0–565 条，剩下 17 万条全靠 JS 里的汉明距离过滤掉。
随机抽样 40 张照片，**100% 的候选数超过 32 766**（SQLite 单条语句的宿主参数上限），
所以这不是边缘情况 —— 只要库够大，`WHERE id IN (?,?,...,?)` 那条路必挂。

两条结论：

1. **`findSimilarPhotos` 里绝不能把候选 id 展开成 `IN (?,?,...)`**：改用
   `src/main/sql-id-list.js` 的 `json_each` 单参数写法。守护脚本
   `scripts/sql-id-list-regression.js`（造 4 万张同 hash 的夹具来打爆旧写法）。
2. **想让它真正变快，得改 band 的粒度**，而不是继续在 SQL 侧抠。当前一次查询约
   **3.4 秒**（候选查询 ~1.4s + 取回 17 万行 dhash 并逐条算汉明距离 ~2s），
   其中绝大头是「把 17 万行候选搬进 JS」。注意 `findSimilarPhotosWithIndex` /
   `buildLshIndex`（内存倒排索引，注释写着「比纯 SQL 快 5-10 倍」）**目前没有任何调用方**，
   是一条建好却没接上的优化路。
   加大 band 位数（例如 8 bit × 8 band）能把桶数提到 256²，代价是阈值 12 时可能出现
   漏召回（≤12 次翻转可以打遍全部 8 个 band），需要重新算召回率再定。

### 3.3 存储开销

| 规模 | photos 表增量 | LSH 表 | 合计 |
|-----|--------------|--------|------|
| 1 万张 | ~0.3 MB | ~4 MB | ~4.5 MB |
| 10 万张 | ~3 MB | ~40 MB | ~45 MB |
| 100 万张 | ~30 MB | ~400 MB | ~430 MB |

---

## 4. 感知哈希计算引擎

### 4.1 模块：`src/main/perceptual-hash.js`

```js
const sharp = require('sharp');

/**
 * 计算单张图片的 dHash
 * @param {string|Buffer} input 文件路径或 Buffer
 * @returns {Promise<string|null>} 16 位 hex
 */
async function computeDhash(input) {
  try {
    var raw = await sharp(input, { sequentialRead: true })
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    var hash = 0n;
    for (var row = 0; row < 8; row++) {
      for (var col = 0; col < 8; col++) {
        if (raw[row * 9 + col] > raw[row * 9 + col + 1]) {
          hash |= 1n << BigInt(row * 8 + col);
        }
      }
    }
    return hash.toString(16).padStart(16, '0');
  } catch (e) {
    return null;
  }
}

function getDhashBuckets(dhash) {
  if (!dhash || dhash.length !== 16) return new Array(16).fill(0);
  var buckets = new Array(16);
  for (var i = 0; i < 16; i++) buckets[i] = parseInt(dhash[i], 16);
  return buckets;
}

// 16-bit POPCOUNT 查表（64 KB）
var POPCOUNT16 = new Uint8Array(65536);
for (var i = 0; i < 65536; i++) {
  var n = i, c = 0;
  while (n) { c++; n &= n - 1; }
  POPCOUNT16[i] = c;
}

function hammingDistance(hex1, hex2) {
  return (
    POPCOUNT16[parseInt(hex1.slice(0, 4), 16) ^ parseInt(hex2.slice(0, 4), 16)] +
    POPCOUNT16[parseInt(hex1.slice(4, 8), 16) ^ parseInt(hex2.slice(4, 8), 16)] +
    POPCOUNT16[parseInt(hex1.slice(8, 12), 16) ^ parseInt(hex2.slice(8, 12), 16)] +
    POPCOUNT16[parseInt(hex1.slice(12, 16), 16) ^ parseInt(hex2.slice(12, 16), 16)]
  );
}

function hammingDistanceEarlyExit(hex1, hex2, maxDistance) {
  var d = POPCOUNT16[parseInt(hex1.slice(0, 4), 16) ^ parseInt(hex2.slice(0, 4), 16)];
  if (d > maxDistance) return d;
  d += POPCOUNT16[parseInt(hex1.slice(4, 8), 16) ^ parseInt(hex2.slice(4, 8), 16)];
  if (d > maxDistance) return d;
  d += POPCOUNT16[parseInt(hex1.slice(8, 12), 16) ^ parseInt(hex2.slice(8, 12), 16)];
  if (d > maxDistance) return d;
  return d + POPCOUNT16[parseInt(hex1.slice(12, 16), 16) ^ parseInt(hex2.slice(12, 16), 16)];
}

module.exports = { computeDhash, getDhashBuckets, hammingDistance, hammingDistanceEarlyExit };
```

---

## 5. 关键优化：缩略图同步生成 dHash

> **用户洞察：生成缩略图时，文件系统缓存还热着，此时同步计算 dHash 几乎零额外磁盘 IO 成本。**

### 5.1 现有缩略图生成流程

`src/main/thumbnail-backfill.js` 的 `processOne(row)`（⚠️ 该文件已于 2026-10-05 删除，此逻辑现在 `src/main.js#runRowsWithThumbConcurrency` 里）：
1. 用 `sharp(file_path)` 读取原图 → `rotate()` → `resize(256)` → `jpeg()` → `toBuffer()`
2. 每 15 张 `commitMiniBatch()` 写入 `photos.thumbnail`

### 5.2 同步生成方案

在 `processOne` 中，**缩略图生成后，立即对同一张图片计算 dHash**（利用操作系统文件缓存，无需重新读盘）：

```js
async function processOne(row) {
  // 1. 生成缩略图（现有逻辑不变）
  var thumb = await loadSharp()(row.file_path, { failOnError: false })
    .rotate()
    .resize(topts.size, topts.size, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: topts.quality })
    .toBuffer();

  // 2. 【新增】顺手计算 dHash（文件系统缓存大概率还热着）
  var dhash = null;
  try {
    dhash = await computeDhash(row.file_path);
  } catch (e) {
    // dHash 失败不影响缩略图，静默跳过
  }

  return { id: row.id, thumbnail: thumb, dhash: dhash };
}
```

### 5.3 为什么这样更高效？

| 方案 | 磁盘读取次数 | 百万级总读盘量 |
|-----|------------|--------------|
| **独立 dHash 任务** | 2 次/张（缩略图 1 次 + dHash 1 次） | ~2× 照片总大小 |
| **同步生成（本方案）** | **1 次/张**（缩略图读取后，文件缓存命中 dHash） | **~1× 照片总大小** |

缩略图生成已经打开文件、解码图像。操作系统 Page Cache 会保留最近读取的文件块。dHash 计算紧跟其后（毫秒级间隔），**缓存命中率 > 95%**，第二次 `sharp(file_path)` 几乎不需要真正读盘。

### 5.4 事务批量写入修改

`commitMiniBatch` 同时写入 `thumbnail` + `dhash`：

```js
async function commitMiniBatch() {
  if (results.length === 0) return;
  db.beginTransaction();
  try {
    for (var r of results) {
      // 写入缩略图
      db.updatePhotoThumbnail(r.id, r.thumbnail);
      // 【新增】写入 dHash（如计算成功）
      if (r.dhash) {
        db.updatePhotoDhash(r.id, r.dhash, getDhashBuckets(r.dhash), r.mtime, r.size);
      }
    }
    db.commit();
  } catch (e) {
    db.rollback();
    // 单条重试...
  }
  results = [];
  await yieldForPreviewPlaybackMs(8);
}
```

### 5.5 查询字段扩展

`getPhotosMissingThumbnailsAfter` 需要增加 `file_size` 和 `date_modified`，用于 dHash 的哈希复活：

```sql
SELECT id, file_path, file_size, date_modified
FROM photos
WHERE id > ? AND (has_thumbnail = 0 OR thumbnail IS NULL)
ORDER BY id ASC
LIMIT ?
```

### 5.6 存量照片补充策略

对于**已有缩略图但缺少 dHash** 的存量照片，仍需要独立的后台任务补充：

```js
// dhash-backfill.js（轻量版，只处理"有缩略图但无 dHash"的照片）
// 按 file_path 顺序读取，每批 2000 张
// 复用 thumbnail-backfill.js 的并发控制、让出主线程、小批次提交等机制
```

但好消息是：
- 新照片扫描时，缩略图补全**自动**完成 dHash
- 存量照片只要运行一次 dHash 补充任务即可
- 百万级存量补充任务也只需读盘一次（顺序读），时间约 **1-2 小时（SSD）**

---

## 6. 相似查询引擎

### 6.1 三层分组架构

```
┌──────────────────────────────────────────────────────────────┐
│  第零层：dHash 精确匹配（SQL GROUP BY，秒级）                  │
│  └─ 捕获 ~80-90% 相似重复（同一图片不同压缩版 dHash 相同）       │
├──────────────────────────────────────────────────────────────┤
│  第一层：文件夹内近似匹配（LSH + BFS，分钟级）                  │
│  └─ 同文件夹内轻微变异（调色、裁剪）                            │
├──────────────────────────────────────────────────────────────┤
│  第二层：跨文件夹按需查询（实时 < 10 秒）                       │
│  └─ 用户右键某张照片 → 实时找跨文件夹相似照片                   │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 第零层：SQL 精确匹配

```sql
SELECT dhash, COUNT(*) as cnt
FROM photos
WHERE dhash IS NOT NULL
GROUP BY dhash HAVING COUNT(*) > 1
ORDER BY cnt DESC, dhash ASC
LIMIT ? OFFSET ?;
```

- 1 万张：< 100 ms
- 10 万张：< 1 秒
- 100 万张：< 5 秒

### 6.3 第一层：文件夹内 BFS

对 dHash 唯一的照片，按 `folder_path` 分区做 BFS。每区通常 < 1000 张，非常快。

### 6.4 第二层：按需实时查询

```js
function buildLshIndex(db) {
  var rows = db.prepare('SELECT id, dhash FROM photos WHERE dhash IS NOT NULL').all();
  var idToDhash = {};
  for (var r of rows) idToDhash[r.id] = r.dhash;

  var lshRows = db.prepare('SELECT photo_id, band, bucket FROM photo_dhash_lsh').all();
  var index = new Array(256);
  for (var i = 0; i < 256; i++) index[i] = [];
  for (var r of lshRows) {
    index[r.band * 16 + r.bucket].push(r.photo_id);
  }
  return { idToDhash, index };
}
```

内存：100 万照片约 300-400 MB。

---

## 7. UI 集成方案

### 7.1 模式切换

```html
<div class="dup-mode-switch">
  <button class="dup-mode-btn active" data-dup-mode="exact">精确重复</button>
  <button class="dup-mode-btn" data-dup-mode="similar">相似重复</button>
</div>
```

### 7.2 状态扩展

```js
state.duplicateMode = 'exact'; // 'exact' | 'similar'
state.similarThreshold = 12;   // 8 | 12 | 16
state.similarGroups = [];
state.similarGroupsPage = 1;
state.similarGroupsTotalPages = 1;
state.currentSimilarGroupId = '';
state.similarPhotosByGroupId = {};
```

**设置持久化**：`duplicateMode` + `similarThreshold` 保存到 `settings.json`。

### 7.3 Sidebar 展示

- **🔒 重复 ×N**：dHash 完全相同（第零层）
- **🧩 相似 ×N**：汉明距离 ≤ threshold（第一层）
- groupId：`similar_group_{minId}`

### 7.4 设置页扩展

- 「重新计算相似哈希」按钮（仅处理存量照片）
- 阈值选择：严格(8) / 标准(12) / 宽松(16)
- 进度显示（复用 `duplicateHashPolling` 机制）

---

## 8. 后台任务架构

### 8.1 任务分工

| 任务 | 触发时机 | dHash 计算 |
|-----|---------|-----------|
| **缩略图补全** | 新照片扫描 / 启动补全 | **同步计算**（本方案核心） |
| **dHash 存量补充** | 设置页手动触发 | 独立后台任务（仅处理"有缩略图但无 dHash"） |

### 8.2 不阻塞前端的机制

缩略图补全已有的机制：
- `setImmediate` 每处理完一张让出主线程
- `yieldForPreviewPlaybackMs(8)` 每 15 张让出
- 并发 1-8 可控
- 小批次事务提交（15 张/事务）

**同步 dHash 后新增注意事项**：
- dHash 计算（`sharp.resize(9,8)`）极快（< 1ms/张），不会明显增加单张处理时间
- 每 15 张事务中增加 15 条 LSH 写入（16×15 = 240 条），事务大小可控
- 如 LSH 写入导致事务变慢，可将 `miniBatchSize` 从 15 降至 10

### 8.3 渐进式结果

- 第零层（SQL GROUP BY）在缩略图+dHash 补全**全部完成后**执行一次即可
- 不需要中间推送，因为 dHash 精确匹配必须在所有照片 dHash 就绪后才完整
- 但用户可随时进入相似模式查看当前已完成的 dHash 精确组（SQL 实时查询）

---

## 9. IPC 与 API 扩展

```js
// 存量 dHash 补充
ipcMain.handle('maintenance:run-dhash-backfill', async () => { ... });
ipcMain.handle('maintenance:cancel-dhash-backfill', async () => { ... });
ipcMain.handle('maintenance:get-dhash-backfill-progress', async () => { ... });

// 相似模式查询
ipcMain.handle('maintenance:get-similar-groups', async (evt, { page, pageSize, threshold }) => { ... });
ipcMain.handle('maintenance:get-photos-by-similar-group', async (evt, { groupId }) => { ... });
ipcMain.handle('maintenance:find-similar-photos', async (evt, { photoId, threshold }) => { ... });

// 设置持久化
ipcMain.handle('settings:saveDuplicateMode', async (evt, { mode, threshold }) => { ... });
ipcMain.handle('settings:loadDuplicateMode', async () => { ... });
```

### 9.1 数据库方法扩展

```js
ensureDhashSchema()                    // dhash 列 + LSH 表 + 索引
updatePhotoDhash(id, dhash, buckets, mtime, size)  // 更新 photos + LSH（同一事务）
getDuplicateDhashGroups(limit, offset) // 第零层 SQL GROUP BY
getPhotosByDhash(dhash)                // 相同 dhash 的照片
getDhashBackfillPhotosAfter(afterId, batchSize)    // 按路径排序拉取"有缩略图但无 dHash"
getDhashBackfillPhotoCount()           // 存量待补充数量
```

---

## 10. 性能估算

### 10.1 缩略图同步 dHash 的开销

| 指标 | 新增开销 |
|-----|---------|
| 单张 dHash 计算 | **< 1 ms**（9×8 resize 极快） |
| 单张 LSH 写入 | 16 条记录/事务，批量插入几乎零额外耗时 |
| 每 15 张 miniBatch 事务增加时间 | **< 5 ms** |
| **结论**：同步 dHash **不显著增加**缩略图补全总耗时 |

### 10.2 全量级指标

| 规模 | 缩略图+dHash 同步（SSD） | 第零层分组 | 第一层分组 | 磁盘增量 |
|-----|------------------------|-----------|-----------|---------|
| 1 万张 | ~2 分钟 | < 100 ms | < 1 秒 | ~4.5 MB |
| 10 万张 | ~15 分钟 | < 1 秒 | < 10 秒 | ~45 MB |
| 100 万张 | **~2-3 小时** | **< 5 秒** | **< 3 分钟** | **~430 MB** |

### 10.3 存量补充（仅"有缩略图但无 dHash"）

- 首次运行时，已有缩略图的照片需要补充 dHash
- 顺序读盘，复用 `thumbnail-backfill.js` 的任务模型
- 百万级约 **1-2 小时（SSD）**，后台运行，前端无感知

---

## 11. 实施步骤

### Step 1：基础设施
- [ ] `src/main/perceptual-hash.js`（dHash + 查表法 + 提前退出）
- [ ] `database.js`：`ensureDhashSchema`、`updatePhotoDhash`

### Step 2：缩略图同步 dHash（核心）
- [ ] 修改 `thumbnail-backfill.js`（⚠️ 2026-10-05 起是 `src/main.js#runRowsWithThumbConcurrency`，且 `commitMiniBatch` 的写法已被「按批进 `dbWriteQueue`」取代）：
  - `getPhotosMissingThumbnailsAfter` 增加 `file_size, date_modified`
  - `processOne` 缩略图生成后同步调用 `computeDhash`
  - `commitMiniBatch` 同时写入 `thumbnail` + `dhash`
  - dHash 失败不影响缩略图
- [ ] 单元测试：同图一致性、压缩鲁棒性、查表法正确性

### Step 3：存量补充任务
- [ ] `src/main/dhash-backfill.js`（轻量版，仅处理"有缩略图但无 dHash"）
- [ ] 按 `file_path` 顺序读盘，复用 `thumbnail-backfill.js` 的任务模型
- [ ] IPC 接入

### Step 4：相似查询引擎
- [ ] 第零层：`getDuplicateDhashGroups` SQL GROUP BY
- [ ] 第一层：文件夹内 BFS
- [ ] 第二层：按需实时查询（内存 LSH 索引）

### Step 5：UI 集成
- [ ] 精确/相似模式切换
- [ ] Sidebar 分组展示（🔒 精确 / 🧩 相似）
- [ ] 组内照片相似度标签
- [ ] 设置页：阈值 + 手动触发存量补充 + 进度

### Step 6：测试
- [ ] 1 万张：缩略图+dHash 同步 < 3 分钟，分组 < 3 秒，前端无卡顿
- [ ] 10 万张：同步 < 20 分钟，分组 < 30 秒
- [ ] 百万级：同步 < 3 小时，第零层 < 5 秒，前端帧率 > 30fps

---

## 12. 风险与应对

| 风险 | 应对 |
|-----|------|
| 缩略图+dHash 同步导致单张处理变慢 | dHash < 1ms/张，实测几乎无感知；如变慢 > 10% 可降级为异步 |
| LSH 写入导致事务变大 | miniBatchSize 从 15 降至 10；实测 16×15 = 240 条 SQLite 无压力 |
| 百万级存量补充耗时 | 后台运行，顺序读盘，断点续传；首次一次，后续无需再跑 |
| LSH 漏召回 | threshold≤12 时漏召回率 < 0.02%（数学验证） |
| 误报 | 用户可调 threshold；UI 显示相似度百分比 |
| 缩略图与 dHash 任务竞争 sharp | 复用现有并发控制；dHash resize(9,8) 极轻量 |

---

## 附录：设计演进日志

| 版本 | 关键变化 |
|-----|---------|
| v1 | 初稿：4×16-bit 分桶（数学错误） |
| v2 | 修正为 16×4-bit LSH + 查表法汉明距离 |
| v3 | 三层分组架构 + 百万级顺序读盘优化 |
| v4 | 后台任务零阻塞（让出主线程、渐进式结果） |
| **v5** | **缩略图同步生成 dHash（核心重构）：复用磁盘 IO，消除独立 dHash 后台任务；仅支持图片，视频暂不考虑** |
