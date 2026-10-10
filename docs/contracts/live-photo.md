# Live Photo 契约

> 判据实现：`src/main/live-photo.js`（单一真相源）
> 配对任务：`src/main/live-photo-pair.js`
> 守护：`scripts/live-photo-regression.js`（114 项，自包含，不依赖外部素材）
> 本文只记录**回归脚本断言不了的**部分：为什么这么定、哪些路已被真库证伪、哪些是刻意取舍。

## 目标形态

一条 Live Photo 在库里只占**一个**条目：图片行自己。伴生 MOV 的行不被删除，但会被
所有媒体类型档位排掉（不出现在列表、不参与「视频」计数口径的列表）。

因此「看动态」**只有预览实况按钮一个入口** —— 别处看不到伴生 MOV，没有第二个入口。

## 判据只有一个：Apple `content.identifier`

判据是 MOV 里是否存在明文子串 `com.apple.quicktime.content.identifier`。

三种容器布局下 key 名都是明文 ⇒ 只做 `indexOf`（**`latin1` 读，不能 utf8**，保字节）。
`meta` box 的 body 有两种真实写法（ISO FullBox 带 4 字节 version+flags / QuickTime 不带），
字符串判据天然免疫这个歧义。

探针读法：`≤8MB` 整读；否则头 1MB + 尾 4MB（覆盖 faststart 与 moov 在尾两种）。

### 🔴 为什么不能用「同目录同名图片」判伴生（真库实测把它废掉了）

最直觉的判据是「同目录 + 同 basename 的图片 + 视频」。前 4000 个 `.mov`（全库 4554 个）的交叉表：

- 文件名命中：**1107**
- identifier 命中（本判据）：**169**
- 两者交集（真正能配对的）：**1**
- 只命中文件名：**1106** ← 按文件名判「伴生」会**凭空藏掉**这 1106 个视频

那 1106 个样本全是写真集的「封面图 + 正片」形态（`(1).MOV 154.85MB ↔ (1).JPG 1.08MB`、
`776KB ↔ 4.0MB`……体积比 0.19 ~ 1692 倍，毫无规律）。**按文件名判 = 用藏掉 1106 个视频换 1 个正确的。**

反向担心（明文子串会不会误命中普通视频）也量过：169/169 都在 `keys` 表里结构化存在、
169/169 都能精确读出 UUID 值 —— 这份语料上不存在「恰好带了这串字节」的普通视频。

### ⚠️ 不要把 `still-image-time` / 「能读出 UUID」升级成必需条件

`readMdtaValue()` 只认 `keys`/`ilst`（ISO mdta）那一种布局；另外两种真实布局
（`moov/udta/meta/ilst` 的四字键、ffmpeg 的 `ilst/----`）上它返回 `null`。

升级 = 用「少藏一个视频」换来「漏掉一整类真 Live Photo」。实测这两项在语料上与
identifier 完全重合（169/169），**加进去不改变任何判定，只记录、不参与定案**。

### 两处 stem 计算必须逐字等价

`stemOf()`（JS 侧）与 `FIND_STILL_SQL` 里的 `substr(... - 1)`（SQL 侧）必须等价：
一侧用 `path.basename`、另一侧字符串切，会在「文件名含多个点」（`abc.1.jpg`）时分叉。

真踩过：探针自己抄 SQL 时漏了 `- 1`（算出的 stem 带点、传进去的不带点）⇒ 全部不匹配
⇒ 得出「配对 = 0」的**完全相反**结论。回归脚本有一节专测两者等价。

## 三态语义（两列）

```
live_still_id   INTEGER            -- 视频行：NULL=还没探查 / 0=查过不是伴生 / >0=图片 id
live_motion_id  INTEGER DEFAULT 0  -- 图片行：0=无 / >0=MOV 的 id
```

🔴 `live_still_id` **绝不能带 `DEFAULT 0`**（迁移只能写
`ALTER TABLE photos ADD COLUMN live_still_id INTEGER;`）。带了的话存量库的行会被一次性
填成「查过、不是伴生」，而配对任务的认领条件是 `IS NULL` ⇒ **存量库永远配不出任何
Live Photo，且零报错**。

`live_motion_id` 带 `DEFAULT 0`（图片行语义里 0 就是「没有」，没有第三态）。

## 🔴 SQL 三值逻辑（改查询前必看）

`NOT (live_still_id > 0)` 对 `live_still_id IS NULL` 的行求值为 **NULL（不是 TRUE）⇒ 不匹配**。
而全库绝大多数行（所有图片、所有 png/mp4、未探查的 mov）这一列都是 `NULL`
⇒ 「所有媒体」档会把**整批图片**吞掉、只剩视频；而「视频」档看起来完全正常（肉眼很难发现）。

**取反必须用 `COALESCE(live_still_id, 0) = 0`**，且独立成方法
（`_sqlNotLiveStillIsMotionExpr()`），不许在别处拼 `'NOT (' + ... + ')'`。

⚠️ 但 `all` 档**不能无条件加这句谓词**：它会导致整表回表，478ms → 105,954ms
（真库 1,656,580 行实测）。`all` 档排伴生视频必须走**自适应**写法，见 `query-regression`
与存量归档 CONTRACTS §T6「查询性能 / SQL / 媒体档过滤」。

## 过滤落点 / 字段传播 / UI

- `_pushMediaTypeCondition`：`image` 档早退；其余（含 **all**）都 push 取反谓词；
  `video` 档再 push 视频扩展名谓词。⚠️「只排 video 档」是最容易犯的错（伴生 MOV 会在「所有媒体」里露出来）。
- `live_motion_id` 必须出现在**每一处**图片列清单里（12 处，真来源是 `getPhotos` /
  `getFolderPhotos` / `searchPhotos` 的 SELECT）。漏一处 ⇒ 桌面端或网页端角标永远是 0
  ⇒ 有角标但按不出播放、或反过来。
- 判据只有一份：`src/renderer/utils.js#isLivePhotoStill`（网格角标与预览播放按钮共用），
  `ui-grid.js` / `ui-preview.js` 都**转发**过去。网页端同理：
  `src/web/js/app.js#isWebLivePhotoStill` 是全文件**唯一**那份裸判据。
  两处各写一份 ⇒ 「有角标但按不出播放」。
- 预览内播放伴生视频：
  - 叠加层 `#previewLiveVideo` 是**独立元素、绝对定位**、不参与流。内层容器是 flex row，
    `.preview-img`/`.preview-video` 都是 `width:100%`，第三个参与流的子元素会把画面挤成两半。
    `pointer-events:none` 是刻意的：底下那张图还要能拖拽/缩放。
  - 切图同步点落在**图片/视频分支之前**，且**必须无条件先停**：「上一张是 Live、下一张也是 Live」
    时若只在「新图片不是 Live」才停，上一段会盖在新图上播完。
  - 取流用的 id 是**伴生视频的 id**（`photo.live_motion_id`），不是图片 id；
    且**必须先查 `/api/video-playback?id=`** —— iPhone 的伴生视频自 iPhone 8 起是 HEVC，
    Chromium 解不了，直链会**静默黑屏**。
  - 网页端按钮显隐走**内联 `style.display`**。🔴 不许写 `.preview-live-btn { display: none }`：
    JS 显示时用的是 `style.display = ''`（清内联值后回落），写了就永远出不来。
  - 网页端激活色必须用 **id 选择器** `#previewLiveBtn.active`：`.preview-action-btn.active`
    是收藏的粉色、特异性相同，靠书写顺序压不住。

## 刻意取舍（**不**排伴生视频的地方）

`src/db-heavy-read.js` 的统计谓词（`video_count` / `videoPhotos`）与部分索引
`idx_photos_agg_root_folder_{image,video}` **逐字绑定** —— 为保索引可用的谓词形状，
**刻意不在这里排伴生视频** ⇒ 伴生 MOV **仍会被算进视频计数**。`getFolderCovers` 同理。

这是已知取舍，不是漏改。⚠️ 改之前先量执行计划：谓词一变，那两个部分索引就用不上了。

## 配对任务的两条性能约束

- 候选查询**刻意不加 `ORDER BY`**：加了规划器会放弃
  `SEARCH ... USING COVERING INDEX idx_photos_type` 退回 `SCAN`。
  所以 `file_type IN ('mov','MOV')` 走精确匹配，**不许**写成
  `lower(replace(file_type,'.',''))='mov'`（实测后者扫全部 156 万条索引项）。
  ⚠️ `file_type` 列存的是**不带点的小写**扩展名（`jpg`/`mp4`/`mov`）。
- **先廉价预筛再读盘**：同目录没有同名图片的 MOV 直接落 `0`，连盘都不读。
  读盘失败也写 `0`（终态），**刻意不做重试账** —— 否则失败行会被反复认领、任务永不收敛。

## 验收时的一个陷阱

反向验证（删掉某行看脚本变不变红）时踩到过**脚本自身的洞**：
`indexOf('syncWebLivePreview(photo, isVideo)')` 会匹配到**函数定义**那一行
⇒「删掉调用点」不变红。**锚点必须带上缩进/前缀，只认调用点。**
