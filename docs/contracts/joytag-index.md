# JoyTag 标签倒排（第二路检索）— 契约与实测

> 从 `.workbuddy/memory/MEMORY.md` 迁出（2026-10-08）。memory 只留红线 + 指针，
> **原委 / 数字 / 配方 / 负例全在这里**；当天过程见 `.workbuddy/memory/2026-10-08.md`。
>
> 三份并列的真相源，别把职责挪来挪去：
>
> | 文件 | 管什么 |
> |---|---|
> | `src/ai/joytag-model.js` | **权重身份 + 图像预处理 + 批量前向** |
> | `src/ai/tag-index-store.js` | **索引 DDL / 入库线 / 查询线 / 打分口径**（阈值只在它那里定义） |
> | `src/ai/tag-fusion.js` | **两路结果怎么合**（纯函数；worker 只留薄壳） |
> | `src/ai/joytag-labels.txt`（→ `tag-labels.js`） | **词表本体**（5813 行，顺序即输出下标） |
> | `src/workers/semantic-worker.js` | 把上面几样接起来跑（取图 / 算分 / 写库 / 报进度） |

## 1. 一句话形态

**「模型随包 + 搜图（CLIP）建索引时同时建 tag 倒排」** ——
`index` 这一个操作里，CLIP 循环跑完立刻接一段 tag 趟；tag 趟有**两台发动机**，
覆盖面是两者的**并集**：

- `offer(id, bytes, fromThumbnail)` —— CLIP 循环**顺手递图**。那一份 512 内接 JPEG
  已经在手上，JoyTag 的预处理正从它出发 ⇒ 边际成本 ≈ 0（不解码、不读库）。
- `drain()` —— 跑完 CLIP 后用**自己的游标**从 `MAX(photos.id)` 往下扫。

🔴 **只有 `offer()` 是不够的**（这是整套设计的关键判据，也是端到端第二趟专门验的东西）：
**老库上 CLIP 索引早已建完**，CLIP 游标一张都捞不到 ⇒ `offer()` 一次都不会被调用。
跟着 CLIP 游标走的写法在那一趟会**一张都不建**，而界面会显示「索引已完成」。
`drain()` 存在的唯一理由就是这一趟。实测（`.workbuddy/tmp/tag-e2e.js` 第二趟）：
`CLIP 那一路本趟做了多少 = done 0`，而 `tag done = 24`、库里 24 张 / 1742 对。

## 2. 权重身份与「随包」

- 模型 = **`fancyfeast/joytag` 的 `model.onnx`**：`ViT-B/16`、输入 **448×448**、输出 **5813** 维 logits。
- 身份靠**内容哈希**，不靠版本号：
  ```
  bytes  366116154
  sha256 f85b7130e6e549b5b0822537007b7482e8c4c8e754c8d9a5bee08e27050e1097
  ```
  手写的版本号在「换了忘了抬」时完全失效；内容哈希一定抓得到。
- 三个源，**同一份文件的镜像**（国内网络实测可通）：HuggingFace 官方 → `hf-mirror.com` → ModelScope。
  校验用同一个哈希 ⇒ 镜像坏掉只会下载失败，**绝不会把另一版权重标成这一代**。
- 随包落地：`models/joytag/model.onnx` + `models/manifest.json` 的 `joytag` 节
  （`{model, version, files:[{bytes, sha256, path}]}`，总 755.7 MB）。
- 运行时播种：`bundled-models.js#seedJoytag(modelsDir, searchAiPath)` → `<aiPath>/models/joytag/`。
  **两侧对「根」的约定不同**（播种收 ai 根、`joytag.modelPath()` 收 `models` 层），这条接缝由
  `joytag-index-regression` 的 ④ 组静态 + 行为两条一起钉住 —— 错开的表现是
  「播种成功、加载说没有模型」，而界面只会说「下载模型」，用户再点一次还是同一个结果。
- 播种快路径：**已就绪时一次 `statSync` 就返回，366 MB 不走哈希**。实测第一次真拷 1 个文件
  1203 ms（含人脸 + 搜图共 11 个文件），第二次 3 ms `already-complete`。
  `hash-mismatch` 只在**真拷过**时才校验 —— 否则每次启动都要读 366 MB。

## 3. 取图口径（三处必须逐字一致）

```
原图/缩略图 ──prepareSource──▶ 512 内接 JPEG ──prep448──▶ 448×448 白底 raw RGB ──normalize──▶ CHW float32
```

- `prepareSource` = `rotate → resize(512,512,{fit:'inside',withoutEnlargement:true}) → removeAlpha → jpeg`。
- 🔴 **与 `semantic-worker.js` 里建 CLIP 索引用的 `prepare()` 必须逐字同源**
  （守护剥掉注释后逐字比对，连 `limitInputPixels: 100000000` 一起比）。
  漂了的后果：同一张图在「顺手打标」与「老库补建」两条路上算出**不同的分数**，
  于是同一个标签在一部分图上查得到、另一部分查不到 —— **两边都不报错**。
- `prep448` = `rotate → flatten(白底) → resize(448,448,{fit:'contain',background:白}) → removeAlpha → raw`。
  白底 flatten 不是装饰：JoyTag 在不透明图上训的，透明区留着会变黑边，
  而黑边会实打实推高 `black_background` 一类标签的分数。
- `normalize` 用的是 **CLIP 那一套** mean/std（JoyTag 官方实现就用它），**不是 ImageNet 那套**：
  ```
  MEAN = [0.48145466, 0.4578275, 0.40821073]
  STD  = [0.26862954, 0.26130258, 0.27577711]      # ImageNet 是 0.229/0.224/0.225
  ```
  用错**不报任何错**，表现只是「标签整体偏保守、召回塌掉」。守护 ⑤ 用「换成 ImageNet 的 std
  必须算出差 > 0.1 的值」证明那条断言有区分力，另用「通道值互异的第三个像素」钉 CHW 排列
  （只用黑白两个均匀像素的话，写成 HWC 也能全过）。
- `PREP_SPEC = '512inside-jpeg->448contain-raw'` 是这条链的**名字**，写进 `tag_meta.prep_spec`。
  它是**手写字符串**而链子是代码 ⇒ 守护 ⑥ 把它**从链子里的数字推出来对账**：
  改了 `512 → 640` 而不改它，索引里记的就是一句谎话，新旧两批分数会被当成同一口径混在一个库里查。
- 缩略图来源记在 `tag_photo.source_spec`：`thumb:<size>:<format>`（实跑取值 `thumb:512:webp`）；
  退到原图时是 `file`。

## 4. 阈值与量化（唯一源 `tag-index-store.js`）

| 项 | 值 | 说明 |
|---|---|---|
| 入库线 `STORE_MIN_SCORE` | **0.15** | 低于它的标签**不写进索引**（概率口径）。5813 个头里几乎每张图都能在几百个头上拿到 0.05~0.2 的噪声概率 |
| **展示线**（读侧） | 设置项 `aiTagDisplayThreshold`，默认 **0.35** | 标签导航页的「某标签有哪些图 / 卡片上的 N 张」与照片信息面板的「这张图有哪些标签」只显示 **≥** 它的行。**两处在运行期共用一个取值点**（分家 = 面板列着「蓝天」、去导航点「蓝天」0 张）。默认值同源 `DISPLAY_MIN_SCORE`，可调范围见 §4.2 |
| 查询线 `TAG_ROUTE_THRESHOLD` | **0.55** | 与 `scripts/tag-vocab-coverage.json#threshold` **必须一致**（`tag-index-regression` 钉 `===`） |
| 可调范围 `TAG_ROUTE_RANGE` | `{min: 0.2, max: 0.95}` | `min` 刻意不放到 0 —— 0 会把几百个噪声标签全放进来 |
| 可调范围 `TAG_DISPLAY_RANGE` | `{min: STORE_MIN_SCORE, max: TAG_ROUTE_THRESHOLD, step: 0.01, default: DISPLAY_MIN_SCORE}` | **上下界就是 §4.1 那两条硬约束本身**（不是另抄的字面量）⇒ 将来谁改了入库线/查询线而忘了改这里，守护会红 |
| `quantize` | **`Math.floor(p×100)`** | `floor(p×100) ≥ t ⟺ p ≥ t/100` **只有 floor 成立**；`round` 会把 `0.4999` 变成 50、在 `t=50` 处**多放进一张** |

- 🔴 入库线必须**明显低于**可调范围下限（守护断言 `STORE_MIN_SCORE < TAG_ROUTE_RANGE.min`），
  否则就是「存的时候丢掉了本来能命中的行」。
- 查询线 0.55 是**精度侧**取法（0.5 起负对照开始漏：雪山 1 / 咖啡 1 / 鲜花 5 张；0.6 基本干净而召回掉到 0.246）；
  F1 侧的取法是 0.5（0.355）。差的那 0.05 是「宁可少给几张、也别给错」的取舍，用户可在 `TAG_ROUTE_RANGE` 里自己挪。
- 阈值是**入库侧唯一一处**：`joytag-model.js#tag()` **不做任何阈值过滤**（sigmoid 之后原样交出去）。
  在这里再写一遍就会与 store 分叉，后果是「入库的行查不到 / 查询的行没入库」这类**静默空结果**。

### 4.1 为什么还要一条**展示线**（2026-10-09 抬线）

入库线 0.15 是照「查询线 0.55」定的：「存下来的行将来**可能**被查到」。它从没考虑过第二种用法 ——
**把这些行直接当成结论摆给用户看**。标签导航页（这个标签下有哪些图）与照片信息面板（这张图有哪些标签）
正是这种用法，于是 0.15 的「噪声概率」被当成事实显示了。

实测（活跃库 2032 张已打标 / `photo_tag` 113,280 行；探针 `.workbuddy/tmp/tag-correctness-probe2.js`）：

| 观察 | 数据 |
|---|---|
| 15..29 区间占全部倒排行 | **69,066 行（61%）** |
| 1752 个标签里「最高分 <30」（整个标签没一张有把握） | **892 个** |
| 抽 top1 肉眼核对 | `black_hair`(83) ✓黑发 / `school_uniform`(28) ~制服 / **`blue_sky`(22) ✗没有天空（浅色床单）/ `cat`(21) ✗没有猫** |

⇒ 误报**全部落在低分区**，取 **0.35**：保留 35,059 行（30.9%）、723 个标签（41.3%），
且 2032 张图**每张仍有 ≥1 个标签**（不会出现「点进去全空」）。要松/紧要改就只改这一个数
（0.30 → 39.0% 行 / 49.1% 标签；0.40 → 25.1% 行 / 34.1% 标签）。

🔴 三条不能动的约束（`tag-nav-regression` 全钉了，含牙齿用例）：
1. `DISPLAY_MIN_SCORE ≥ STORE_MIN_SCORE`（低于入库线的行根本不存在）；
2. `DISPLAY_MIN_SCORE ≤ TAG_ROUTE_THRESHOLD`（高过查询线 = 导航比搜索还严，标签页看起来像缺图）；
3. **`countsForTags`（卡片上的「N 张」）与 `rankedPhotoIds`（点进去的总数）必须同一条线** ——
   两处分家会让界面写着 A 张、点进去 B 张，而且**不报任何错**。

### 4.2 展示线可调，以及「调了怎么生效」（2026-10-09，用户诉求「设置可调，调了怎么生效」）

同一份数据里不同库的噪声水平不一样（拍得糊的库 0.35 仍会漏噪声、拍得干净的库又砍得太狠），
而 0.35 只是**一次实测**的取舍 ⇒ 这是个纯口味参数，不该由开发者替所有用户定死。所以：

**设置项**：`settings.json#aiTagDisplayThreshold`（默认 `TAG_DISPLAY_RANGE.default = 0.35`）。
入口在桌面端「设置 → AI 与索引 → 标签检索层」那一节的**第三行**「标签展示线」（与查询线并列）。
范围与夹取唯一源：`src/ai/tag-index-store.js#TAG_DISPLAY_RANGE` / `#clampDisplayMinScore()`；
`main.js#ensureSettingsShape()` 调它收口（空值/非法回落默认值，越界夹取并对齐 0.01 步长）。

🔴 **这个输入框不随「启用标签检索层」开关置灰**：展示线管的是「标签页与照片信息面板显示什么」，
与「搜图走不走 tag 路」是两件事 —— 关掉检索层之后用户照样在看标签页。
跟着置灰 = 用户以为「关了检索，标签也就不显示了」。（`tag-fusion-regression` 钉正反两面。）

**生效链路（三句话）**：

1. **落库**：面板 `change` → `updateSettings({tagDisplayThreshold})` → 主进程**当帧**写进内存的
   `settings` 对象 → `ensureSettingsShape()` 夹取 → `saveSettings()` 落盘；
2. **读侧即时**：`TagNav` / `JoyTagTags` **不缓存这个值** —— 构造时拿到的是
   `{ displayMinScore: function () { return settings.aiTagDisplayThreshold; } }`，
   每次查询现取 ⇒ **下一次取数就生效**，不重启、不重建索引（分数线只影响「读哪几行」）；
   ⚠️ 必须是这形状的**函数**：`reloadSettingsFromDiskSilently()` 是
   `settings = Object.assign(...)`（**整个对象被换掉**），所以取值器要读**模块级变量**，
   写成 `var s = settings; () => s.x` 会永远读到那个已被丢弃的旧对象（症状：改了没反应，且不报错）；
3. **界面即时**：屏幕上**已经画出来**的数字不会自己重画（标签页的 `subTags` 是渲染层进程级缓存、
   搜索结果里的张数同理）⇒ 桌面端在写成功后调 `tagNavUi.invalidateCounts()`
   （清缓存 + 记 `countsDirty`；人已回标签页则立刻重取重画，人还在设置页则由 `enter()` 进页时补齐），
   同时 `refreshOpenPreviewInfoPanel()` 让开着的照片信息面板按新线重画。
   🔴 `invalidateCounts` 里「清缓存」必须排在「判断在不在标签页」**之前** —— 反了就是
   「人在设置页改完等于什么都没做」，而界面上完全看不出来（`tag-nav-regression` 钉顺序）。

**已知取舍**：网页端没有这条设置项（网页端设置页只剩「这台设备自己的浏览偏好」），
它**照用桌面端设置**；桌面端改完后，网页端在**下次取数**（切节点 / 刷新）时跟着变，
页面上已有的数字不会自己重画。

**守护**：行为层在 `scripts/match-threshold-regression.js`（假 DOM 控制器测试：空框回落默认值、
越界夹取、部分更新只带 `tagDisplayThreshold`、拨过开关后迟到的 read 仍要回填展示线、不随开关置灰），
结构与跨端镜像在 `tag-nav-regression` + `tag-fusion-regression`（面板那份 `TAG_DISPLAY_RANGE`
逐字段比对主进程唯一源）。

### 4.3 展示线以下（命中数 0）的标签**不进列表**（2026-10-09，用户要求「标签 0 的词不需要展示出来」）

`node()` 与 `search()` 都**丢掉** `count === 0` 的标签，唯一源是 `src/main/tag-nav.js` 里两处
`.filter((t) => t.count > 0)`。之前是反的（回 0、由界面置灰），实测这个代价很大 ——
2032 张图 / 1752 个已索引标签的库，默认线 0.35 下 **1029 个标签是 0（58.7%）**；
67 个子类里 **7 个在线以上整块为空**，另有 **1 个顶层分类**整块为空。
也就是说标签页有过半的行是「看起来能点、点进去什么都没有」的灰字。

🔴 **代价：列表条数 ≠ `indexed`** —— 而界面正是靠这个差来分岔。两种「空」必须说两句不同的话：

| 判据（过滤**前**的候选数） | 真相 | 用户该做什么 |
|---|---|---|
| `indexed === 0` | 索引还没铺到这儿 | 去建索引 |
| `indexed > 0` 而列表空 | 有标签，但都低于当前展示线 | 去**调低**展示线（那里有图） |

`node()` 早就有 `indexed`；`search()` 这次补了同名同口径的 `indexed = hits.length`
（**不是** `tags.length` —— 后者还被 0 命中过滤与 `SEARCH_TAG_LIMIT` 动过，报它会把「都低于展示线」
误报成「没匹配上」）。渲染层两端各一个 `emptyTextFor(indexed, mode)`（`mode` 区分「搜不到」
与「这儿本来没有」），侧栏叶子把父行已有的 `tagIndexed` 传进 `tagLeavesHtml` 当判据
（别在叶子那层再问一次主进程）。

⚠️ **节点行（分类 / 子类）上的数字仍是「索引覆盖」口径**，与列表条数**故意**不等：
把它改成展示线口径要按子类做全表聚合（`photo_tag` 铺满时约 9000 万行）—— 正是 §16.2 拒绝的那件事。
这个落差由上面那句空态文案接管（用户看到的是「有 N 个标签，但都低于当前展示线」，不是「数字对不上」）。

⚠️ **正向的过滤不能顺手留着「0 命中就置灰」的渲染分支**：服务端不会再给出 0 命中的项，
留着它只会在过滤失效时把「0 张」伪装成「灰字一片」。节点行的 `dim: !cat.tagIndexed` 是**另一回事**
（那种 0 是真的，代表「索引还没铺到这儿」），不许一起删 —— 守护里一正一反各钉一条。

## 5. 凭证（`tag_photo` 按「每张图」一行）

```
tag_photo(photo_id PK, source_spec, engine, tagged_at)
```

- 计划草案写的是「索引内每行都带 `source_spec` / `engine`」。逐 (图,标签) 存会把同一份字符串
  重复 ~40 遍（24 张的夹具就已经 1742 对、平均每张 72.6 个标签），而这两个字段的**粒度
  与「这张图是怎么被打标的」一样粗** ⇒ 正确的载体是 `tag_photo`。
  判废能力一点没少：`DELETE FROM photo_tag WHERE photo_id IN (SELECT photo_id FROM tag_photo WHERE source_spec <> ?)`
  照样支持「缩略图换规格后重打」。
- `engine` 记的是**真的用上了什么**，不是「要了什么」：`dml` 建会话失败时回落 CPU 并返回
  `cpu*`（`joytag-cpu8`），**回落必须由调用方再 warn 一次** —— 静默回落会让人以为跑的是显卡，
  于是「换了显卡怎么没变快」永远查不出原因。
- 守护断言**没有孤儿**：不允许出现有 `photo_tag` 行、却没有 `tag_photo` 行的 `photo_id`。

## 6. 索引身份（`tag_meta`）与「绝不落水位线」

实跑一趟之后 `tag_meta` 的实测值：

```
model         joytag
engine        joytag-cpu8
prep_spec     512inside-jpeg->448contain-raw
min_score     0.15
label_lines   5813
vocab_key     tv1:1db414e0
created_at    ✓（只写一次）
updated_at    ✓（每趟刷新）
```

- 每个值的**唯一真相源**：`model ← TAG_INDEX_MODEL`、`prep_spec ← joytag.PREP_SPEC`、
  `min_score ← String(STORE_MIN_SCORE)`。守护 ⑦ 断言它们**不是字面量** ——
  写死数字就是第二份口径，改一处另一处静默不动。
- `model` 用 `TAG_INDEX_MODEL`（与 `tag_meta.model` / `tag_photo.engine` 同一族），
  **不是** `joytag.VERSION` —— 后者是**权重**的名字，前者是**索引**的名字。
- 🔴 **不落任何「已建到哪个 id」的水位线**：`K:\COS` / `G:\T` 是外置盘、会掉线，
  失败必须能被下一次任务原样重试。判重只靠**逐张 `hasPhoto()`**。
  代价：`tag_photo` 与 `photos` 住在**两个库**里，SQL 反连接做不到 ⇒ 取批只能
  「列 id → 点查筛」，这也是下面那条索引为什么关键。

## 7. 取批与性能

- 覆盖索引 **`idx_photos_id_hasThumb`（`ON photos(id, has_thumbnail)`）** 是本工程唯一一条
  **覆盖全部行**的 id 索引：走它列全库 id 是纯索引扫描，**真库 165.7 万行实测 1106 ms**。
- 带 thumbnail 的主键倒序取 64 行 = **24 ms / 854 KB**（缩略图页要读）。
- ⚠️ 这个索引**不是 `db.init()` 建的**（由缩略图修复那趟维护任务创建），老库上可能没有 ⇒
  缺了退回 `SELECT id FROM photos` 并且**必须打一条 warn**：

  ```
  [ai] 缺 idx_photos_id_hasThumb：tag 建索引的取批会走主键树（要读缩略图页，慢 1~2 个数量级）
  ```

- 🔴 **只读探针 + 惰性可写句柄**。可写打开 `TagIndexStore` 会在「还没建过索引」的机器上
  **凭空造出一个空库**（表都在、`schema_version` 也在），于是「这台机器没有 tag 索引」
  被伪装成「tag 索引是空的」—— 两者都是 0 结果，但界面该说的话完全不同。
  所以：判重走**只读**句柄（不存在就当「全都没打过」），可写句柄等**马上要写第一行**时才开。
  这条纪律在播种层有对偶：manifest 里没有 `joytag` 一节时**不许凭空造出目录**（守护 ④ 钉住）。

## 8. 一手实测（受控基准）

### 8.1 batching 决定 GPU 到底有没有用

| provider | b1 | b2 | b4 | b8 | b16 |
|---|---|---|---|---|---|
| **DML**（s/张 推理） | 0.847 | 0.300 | 0.224 | 0.197 | **0.178** |
| **CPU**（s/张 推理） | 0.582 | — | — | — | 0.598 |

- ⇒ **batch=1 时 GPU 比 CPU 慢 31%**（固定开销摊不掉）；**batch ≥ 8 才反超 3.0~3.4×**。
  端到端：DML b16 = **0.196 s/张** vs CPU b16 = **0.616 s/张**。
- ⇒ CPU **完全不吃 batch**（b1 0.582 / b16 0.598）。所以「一次一张」的实现会得出
  「GPU 没用」的错误结论。`BATCH = 16`。
- 模型**不需要重新导出**：batch 轴本来就是动态的（`[N,3,448,448] → [N,5813]`，b8/b16 都实测跑通）。
- 换 EP 不改索引内容：DML vs CPU 最大逐值差 **6.028e-5**，**0 个标签在 0.15 线上翻转**。
- `sharp.concurrency(1)` **必须**配 ONNX 的 intra-op 线程（`DEFAULT_THREADS = 8`），
  否则两者叠加成超额订阅，实测拖慢 **3~4 倍**。（设在哪：`semantic-worker.js` 顶部。）

### 8.2 内存驻留

同进程载 SigLIP2 **两塔** → RSS ≈ 720 MB；再叠 JoyTag → ≈ 1127 MB；跑批后稳定在
**1630~1870 MB**（30 轮无明显爬升）。⇒ 「两条路同进程」在内存上是成立的。

### 8.3 端到端三趟（真 worker + 真图夹具）

夹具 = 24 张（从活库取 `has_thumbnail=1` 的缩略图，规格 `thumb:512:webp`）：

| 趟 | 场景 | CLIP done | tag done | tag pairs | batches | 库里实况 |
|---|---|---|---|---|---|---|
| ① | 新装（两路都空） | 24 | **24** | **1742** | 2 | 24 张 / 1742 对 / 378 标签 / 平均 72.6 / 孤儿 0 |
| ② | **老库补建**（CLIP 建完、tag 库删空） | **0** | **24** | **1742** | 2 | 同上，逐值一致 |
| ③ | 幂等（什么都不该改） | 0 | **0** | — | **0** | 同上（`batches = 0` = 连模型都没载） |

第二趟是**整套设计的关键判据**（见 §1）；第三趟证明「一切都已建好」那一次点按
不会去载 366 MB 的权重（`drain()` 起手那句零成本早退）。

## 9. 一个硬崩过的坑：ORT 双副本 DLL 冲突

- 顶层 `onnxruntime-node@1.24.3`（带 `DirectML.dll`）vs `@huggingface/transformers` **自带的嵌套**
  `onnxruntime-node@1.21.0`。Windows 按**基名** `LoadLibrary("onnxruntime.dll")` ⇒
  **谁先加载谁的 DLL 生效**。混用时报
  `The requested API version [24] is not available, only API versions [1, 21] are supported`，
  **进程硬崩，catch 不到**。
- 二分四种次序（`.workbuddy/tmp/ort-order-probe.js`）：

  | 次序 | 结果 |
  |---|---|
  | 顶层 1.24.3 先 → transformers.js | ✅ |
  | transformers.js 先 → require 顶层 | 💥 |
  | 嵌套 1.21.0 先 → 顶层建会话 | 💥 |
  | 顶层先 → 嵌套建会话 | ✅ |

- 修法：`embedding.js#loadEncoder` 里在 `import('@huggingface/transformers')` **之前**
  抢先 `require('onnxruntime-node')`。
  ⚠️ **不能放 `semantic-worker.js` 顶部**：每个搜图 worker 都要走那条路，会白载一份顶层 ORT。

## 10. 进度口径：`tag*` 前缀，绝不碰共享字段

父进程收进度帧是 **`Object.assign(this.state, message.progress)`**
（`src/main/semantic-search.js#handleWorkerMessage`）—— 那是一套**共享**的扁平字段，
不是按阶段分开的命名空间。

⇒ `announce()` 上报的是 `tagStage / tagDone / tagFailed / tagTotal / tagTotalEstimated / tagCountPhase` 六个键，
**绝不许写 `done` / `total` / `failed` / `countPhase` / `phase`**。
两件事的分母差好几个数量级（待索引几十万 vs 待打标几千），混着写就是拿「24」盖掉「484000」，
面板的分子 / 分母 / 百分比一起变成另一件事的数字，**而且一个错都不报**。

> 这不是假想：这一版**真的这么写过**（`phase:'indexing' + stage:'tags' + done + total`），
> 是 `joytag-index-regression` 的 ② 组把它钉住的。`semantic-search.js` 里 `total` 字段
> 那段注释记的也正是同一类老毛病（上一轮留下的假分母跨任务活下来，界面照用）。
> 属于「**两套口径不许串**」那条红线（缩略图重建第一批的教训）。

**消费者（2026-10-08 已落地）**：渲染端 AI 两节那段
（`scan-flow.js#renderBackgroundTaskPanel` 里 `document.getElementById(aiTask.prefix + 'TagCount')`
⇒ `#taskSemanticTagCount`）—— 与主行**并列**的第二条计数行，显示门 = `tagStage` 有值。
百分比不在这六个字段里：它由 `status()` 用 `computePct(out.tagDone, out.tagTotal)` 派生成
`tagPct`（**不许复用 `out.pct`**，那是 CLIP 的分母 —— 同一条「两套口径不许串」在派生层的翻版，
`joytag-index-regression` ②b 钉住）。人脸节**刻意没有**这一格（`taskFaceTagCount` 必须保持不存在）。

补这一行时兑现过的判断：两个分母**顺序**发生（CLIP 全跑完才轮到 tag），所以是「并列两行、各自切换」
而不是同时混用 —— 主行始终显示 CLIP 的读数，tag 行只显示 tag 的。
老库补建那一趟（CLIP 无事可做、只剩 JoyTag 在跑）此前**面板上什么都看不到**（主行停在「完成 0」、
进度条不动、文件与速率全空），tag 行就是为它加的。

⚠️ 由此留下一条**已知取舍**：`offer()`（CLIP 循环顺手打标）**不上报** —— `announce()` 只在
`drain()` 里调，因为分母 `estimatePending()` 要跨库数行（`photos` 行数 − `tag_photo` 行数），
在 CLIP 循环里每批算一次太贵。⇒ 新装那趟的前半段（CLIP 循环几十小时）tag 行**不显示**；
那段时间主行本身在动，不存在「面板是死的」的观感问题。若将来要补，得先给分母找一个便宜口径。

## 11. `flush(force)` 的语义 = 清空队列

`force = true` 是「把队列**清空**」，不是「强行跑一批」。

一次只 `splice(0, model.batch)` 会错两件事（**实测过**）：

1. **`result.tags` 比库里实况少一个尾巴**。`stats()` 在 `finish()` **之前**就被取走了
   （取完就 `return`），没冲完的要等 `finish()` 才落库。实测老库补建那趟报
   `done:16 / pairs:896`，而同一时刻库里是 **24 张 / 1742 对**。
   丢多少 = `TAG_SCAN_WINDOW`(64) − `batch`(16)。
2. **`drain()` 开头那句 `flush(true)` 的保证只有半截**。它存在的理由是「先把 CLIP 留下的半批落库，
   否则 `hasPhoto()` 还是假、同一张图会被收第二遍」。CLIP 循环每次 `flush(false)` 后残留 < 16，
   所以今天恰好没炸；一旦 `offer()` 的调用节奏变了就会变成**真的双计**。

> 那个「真的双计」也出现过一次：早期版本没有 `drain()` 起手那次 flush，实测第一趟
> 报 `done:32 / pairs:2588`，而库里只有 24 张 —— 界面报「打标 32 张」，**这种错没人查得动**。

## 12. 夹具纪律：**永不在夹具里用 junction 指真实资产**

🔴 **2026-10-08 真事故**：早先的端到端探针用
`fs.symlinkSync(target, linkPath, 'junction')` 把 `models/search/onnx-community` 与 `models/joytag`
挂进临时目录，收尾那句 `fs.rmSync(WORK, {recursive:true})` **顺着 junction 把真实目标一起删了**
—— 400 MB 搜图模型 + 366 MB JoyTag 当场消失。

- 现在夹具**复制**模型（755 MB 几秒），并在**删除前**递归 `lstatSync` 查一遍链接：
  发现链接就**拒绝清理并报出来**（留着垃圾好过再删一次资产）。这两个函数都在
  `.workbuddy/tmp/tag-e2e.js` 顶部，注释里记着这次事故。
- 事故当天靠两处副本恢复（`$TEMP/aurora-bench/models/joytag/` 与
  `$LOCALAPPDATA/aurora-gallery/UserData/ai-search/models/`），
  `scripts/bundle-models.js --search-from … --joytag-from …` 重建 manifest，
  sha256 对账 **11/11 通过**。恢复**必须用独立的源**核对（拿刚写出来的 manifest 校刚写进去的文件是**循环论证**）。

## 13. 守护与探针

| 守护 | 钉什么 |
|---|---|
| `tag-index-regression.js` | 存储侧：DDL 形状（`WITHOUT ROWID` / PK 顺序 / `(tag_id, score DESC)`）、`tag_id` = 输出下标、凭证、幂等、量化等价性、两处阈值不漂 |
| **`joytag-index-regression.js`** | 建索引侧 ⑦ 类：①取图口径逐字同源 ②进度口径不串 ③`flush(force)` 清空队列 ④播种落点 === 读取落点 ⑤归一化常数 ⑥`PREP_SPEC` 与链子数字对账 ⑦索引身份不许写字面量 ⑧manifest 与代码身份 ⑨`verify()` 有牙 ⑩仓库内权重能过校验 |
| `tag-fusion-regression.js` | 融合层（M4）：只截断 tag 路 / tag 无候选时 `matched` 原样透传 / tag 独有条目 `similarity = null` / `describeTag` 优先级 |
| `background-tasks-panel-regression.js` | 面板层（2026-10-08 扩）：tag 计数行读**主进程派生的 `tagPct`**（喂一个与分子分母不符的值才有牙）/ `tagStage` 为空时不许画残留读数 / 分母没出来时不许出现百分比 / `#taskSemanticTagCount` 在 HTML 与渲染端**两头都在**（拼接 id ⇒ 字面量对账有盲区） |
| `scripts/gpu-note-probe.js` 同族的**观感探针** `.workbuddy/tmp/tag-panel-shot.js` | **手工**：electron 无头加载真 `index.html`、驱动真 `renderBackgroundTaskPanel` 出 5 组截图（纯 CLIP / 老库补建 / counting / 失败 / 英文包）——修「面板看不出在动」必须亲眼看 |
| `bundled-models-regression.js` | 播种层整体（含 `joytag` 字段进 `reportSaysCopied` 的判据） |
| `.workbuddy/tmp/tag-e2e.js` | **手工探针**：真 worker + 真图三趟（需要 366 MB 权重 + 活库） |
| `.workbuddy/tmp/joytag-guard-teeth.js` | 手工探针：上面那个守护的**注入式牙齿验证**（改坏 → 必须精确红在预期那条 → 逐字节还原 + 核 sha1） |

⚠️ 牙齿验证有一条**环境坑**：从 node 里 `spawnSync(electron)` 在这台机器上是 **EBUSY**，
而 `EBUSY` 会让 `status = null` —— 看起来就像「守护没红」。⇒ 注入器必须
**由 bash 拉起 electron**（`ELECTRON_RUN_AS_NODE=1`），或对 `EBUSY` 退避重试，
绝不许把「没跑起来」当成「真回归」。

## 14. 已知缺口（**记录在案，不是遗漏**）

| 缺口 | 位置 | 为什么先不做 |
|---|---|---|
| ~~面板看不到 tag 阶段进度~~ → **已落地**（2026-10-08，见 §10） | — | — |
| CLIP 循环期间 tag 行不显示（`offer()` 不上报） | §10 | 分母要跨库数行，CLIP 循环里每批算一次太贵；那段时间主行在动，观感没有「死」的问题 |
| 标签导航页 | 讨论过，**暂时不做** | 用户 2026-10-08 的决定 |
| NSFW 过滤 | 标签展示层 | 用户明确要求**不过滤**、**全量平铺** |
| `tag-labels.js#isSelectable` 无人调用 | `src/ai/tag-labels.js` | 预选词那套走的是 CLIP 的 308 条词表（`search-vocabulary.js#TERMS`），**不是**全量 tag。两套词表**必须分立**（SigLIP2 认不得 danbooru 标签，合并 = CLIP 标签全消失），所以这里不接 |
| tag 词表覆盖率的「未重跑 = 守护红」 | `scripts/tag-vocab-rebuild.js` | 随包 `ai/joytag-labels.txt` 的顺序即下标，**缺标签 = 静默 0 命中** |

## 15. 显示层：信息面板「画面标签」字段 + 中文映射（2026-10-09 落地）

用户诉求「需要中文映射，图片信息加字段显示」的落点。**检索与库零改动** —— 全部是显示层的追加。

### 结构（四层，逐段静默断开就是「面板少一行」）

| 层 | 文件 | 职责 |
|---|---|---|
| 映射 | `src/ai/tag-zh.js` | danbooru 标签 → 中文显示名。**全量覆盖随包标签表的 5813 个**（2026-10-09：先按真库已出现的 1752 个频次逐一译，再把余下 4061 个补齐 ⇒ `ZH_COUNT === ai/tag-labels.js#labels().length`）；`toZh()` 查不到返回 `null`，调用方回落英文原文。🔴 **不许在这里编词**：面板上的词要能反查回 tag 路检索，编出来的中文在词表里不存在 |
| 通道 | `src/main/semantic-tags.js#JoyTagTags` | 与 `SemanticTags` 同构的惰性只读连接（`tag-index.sqlite`，`readonly + fileMustExist`，库不存在 = `unavailable` 不再重试）。`tagsFor(photoId, locale)`：`photo_tag` JOIN `tag_vocab`，**先按展示线（设置项 `aiTagDisplayThreshold`，默认 0.35）过滤**（与标签导航页**同一个取值点** `displayMinScore()` → `quantize()`，见 §4.2），再按 `score DESC` 取前 `JOYTAG_PANEL_LIMIT = 24` 个；**中文映射做在这一层**（`locale: 'en'` 直出英文），桌面/网页两端自动同源。失败一律降级空数组，绝不抛 |
| 接线 | `main.js`（实例化 + `get-photo-joy-tags` IPC + web 注入）/ `preload.js` / `web-server.js`（`/api/photo-joy-tags` + `handlePhotoJoyTags`） | 照 `ai_tags` 的既有四段结构逐段对偶 |
| 字段 | `photo-info-fields.js` 加 `joy_tags`（`group: 'ai'`、`def: true`、`render: 'tags'`、无 `column`） | 值 = 通道注入的显示文本数组；空数组整行隐藏。桌面端胶囊可点（点中文 → 自由词走 CLIP 路，行为合理）、网页端静态 span |

### 🔴 契约与取舍

1. **面板是摘要不是清单**：`JOYTAG_PANEL_LIMIT = 24`（真库均值 ~56 标签/张 @0.15 线；抬到展示线 0.35 后每张更少，全塞会把读数变成数据表）。检索走完整倒排，两者不冲突。
2. **映射是显示层的**：库不重建、检索仍用英文原文；换/删映射表只影响显示。回落只对「换词表后冒出的新标签」生效 —— 当前 5813/5813 全覆盖，正常情况下 `toZh()` 查不到就说明标签表换了版（守护会先红）。
   - **没有通行中文译名的小众角色 / 画师名 / 表情符号保留原文**（键值同文，当前 113 条）。硬译一个不存在的中文名只会更不可读，也不影响检索（检索本来就吃英文原文）。
   - 打分口径：覆盖断言**双向**（每个标签都要有映射 + 映射键必须是合法标签），只钉「条数够多」会同时放过「表换版了没跟上」和「塞了脏键」两种真回归。
3. **`joy_tags` 与 `ai_tags` 是两套词**：`ai_tags` = CLIP 词表（308 条，多语言），`joy_tags` = danbooru 全量标签（中文映射显示）。两行同在「AI 内容」分组，刻意并存。
4. **无 `column` 白名单从两个变三个**（`ai_tags` / `joy_tags` / `position`）：`photo-info-fields-regression` 的 `NO_COLUMN_FIELDS` 钉死，新增跨库字段必须同时改守护并解释理由。
5. **守护**：`photo-info-fields-regression` 新增 **5e 节**（字段形态 / 默认显示 / 胶囊复用 / tag-zh 命中+回落 / **全量覆盖三连**：正向无缺失 + 反向无脏键 + 条数相等 + 无空值 / 通道四段接线 / 网页端合流，共 **127 项**；**2026-10-09 再加 5f 节 12 项（共 139 项）**：结构化 `joy_tags` 渲染出 `data-joy-tag` + `data-tag-node` + `data-tag-category`、显示名与 id 刻意不同、`tagTarget` 分岔声明、「没有英文原名就退回 `data-ai-tag`」、网页端仍静态 span、三处转义、`value()` 兜底不拼 `[object Object]`、主进程通道结构化、点击分岔两组 `selectAll`、`openTagNavTag` 三条（**先切页后设 state** / 带 `node`+`category` / 先关预览））；真机探针 `.workbuddy/tmp/joy-panel-probe.js`（只读，`ELECTRON_RUN_AS_NODE=1 electron.exe` 跑）。2026-10-09 实测：photo 1979470 → 17 个标签中文直出（照片（介质）/1个女孩/单人/连裤袜/校服…）、en 直出英文、24 截断生效、不存在 id 返空。
6. **牙齿验证（2026-10-09，`.workbuddy/tmp/teeth-zh.sh`）**：三条覆盖断言各做一次变异 —— 删一条映射 ⇒ 正向断言 + 条数断言红；插脏键 ⇒ 反向断言 + 条数断言红；值改空串 ⇒ 空值断言红。三轮全部精确变红，还原逐字节一致（`src/ai/tag-zh.js` sha1 `3575ca91…`）。


### 🧠 记忆层红线（2026-10-09 从 `MEMORY.md` 迁入）

- `TAG_LANG = 'zh'`（`src/ai/photo-tags.js`）：标签侧**中文映射的语言档**。它与 CLIP 的 `TERMS` 词表
  **不是一回事**（两套词表禁合并，见 §「两套词表：为什么必须分立」）—— 改它会连带改 `ai/tag-zh.js`
  的映射方向，而不是换 CLIP 的检索词。
- `FREE_TEXT`（`src/ai/tag-fusion.js` 的 `reason`）：查询词**不在 tag 词表里**时的结论，语义是
  「这条查询走不了 tag 路」—— 它是**关于查询词**的判断，与索引状态无关。
  ⚠️ **两端 `ai-views.js` 都刻意不为 `FREE_TEXT` 提示**：随手打一句话只走语义路是**正常形态**，
  提示它等于把正常路径渲染成异常（`tagNote` 三份镜面里它必须缺席）。


---

## 16. 标签导航页：分类 → 子类 → 标签 三级树 + 照片网格（2026-10-09 落地）

用户诉求「做标签导航页，布局参照文件夹，支持搜索」＋「tag 加分类层级」。守护 `scripts/tag-nav-regression.js`。

### 16.1 四层结构

| 层 | 文件 | 职责 |
|---|---|---|
| 分类体系 | `src/ai/tag-categories.js` | 5813 个扁平标签 → **14 分类 / 69 子类 / 全覆盖**。导出 `CATEGORIES` / `SUBS` / `SUB_TO_CATEGORY` / `SUB_IDS`（Set）/ `RULES` / `OVERRIDES` / `subOf` / `classifyWith` / `phrasesOf` / `categoryOf` / `tagsOf` / `tagsOfCategory` / `tree` / `stats` |
| 只读数据服务 | `src/main/tag-nav.js#TagNav` | `status()` / `tree()` / `node(nodeId, locale)` / `search(keyword, locale)` / `rankedPhotoIds(tag, page, pageSize)`。**只碰 tag 索引库**，只回 `photo_id` |
| 取行 | `src/main.js` | 用 `photoListColumns()` + `idListPredicate()` 回**主库**取行（职责切开：两种故障独立降级） |
| 渲染 | 桌面 `src/renderer/tag-nav-ui.js` + `tag-nav.css`；网页 `src/web/js/tag-nav.js` + `css/tag-nav.css` | 侧栏树 + 主区卡片/照片网格 + 搜索 |

### 16.2 🔴 核心取舍：**父节点不给照片网格**

分类与子类节点只出**标签卡片下钻**，只有**标签叶子**走照片网格。判据是规模不是美观：

- 父节点要 `WHERE tag_id IN (…) GROUP BY photo_id` —— 那是**整个节点行数**的聚合。当前 `photo_tag` 11 万行（2032 张图）它只要 8 ms，**照这个读数设计就是错的**：索引铺满全库（165 万张 × ~56 标签 ≈ **9000 万行**）时是几十秒的**主线程阻塞**，界面上与「点了没反应」无法区分。
- 标签叶子只需 `WHERE tag_id = ? AND score >= ?`，走 `idx_tag_score` 的区间扫描，代价与该标签的命中行数成正比。
  ⚠️ 这里的 `score >= ?` 是**展示线**（设置项 `aiTagDisplayThreshold`，默认 0.35 —— 每次调用现取，见 §4.2），不是入库线；理由与实测见 §4.1；
  且 `countsForTags`（卡片上的「N 张」）必须用同一个数，否则卡片与网格口径分家（守护钉了「同口径」断言）。
- **树的计数与规模无关**：树只给「这个节点有多少标签 / 其中多少已进索引」，两者都从 `tag_vocab` 现算；命中数只在**打开某个节点时**对该节点的标签算一次。

守护 ① 段**反向**钉两条：`tag-nav.js` 里不许出现 `GROUP BY photo_id`；`TagNav.prototype` 上不许有匹配 `photosForNode|photosForSub|photosForCategory|nodePhotos` 的方法名。

### 16.3 分类体系的三条硬约束

1. **全量覆盖**：`labels()` 的每个标签都必须落到**恰好一个**子类。漏一个 = 导航页里那个标签**永远搜不到也点不开**，且不报错（静默丢失）。
2. 🔴 **规则按「下划线边界短语」匹配，不按裸子串**：标签用 `_` 分段，规则 token 必须落在段边界上（可跨段、不可跨边界）。裸子串的坑：`hololive` 被 `loli` 命中、`lolita_fashion` 被误杀。反向的坑：要求「恰好一整段」⇒ 多段 token 全部失效，`other` 积到 **42%**。引擎见 `phrasesOf`。
3. 🔴 **顺序即优先级，首个命中生效**：规则表**有序**，越具体越靠前（`school_uniform` 必须落「制服」而不是「学校场景」）⇒ 别把通配规则插到前面。

`other` **有预算**：`scripts/tag-categories-regression.js` 把上限钉在 **1300**，且 **`OTHER_CEILING` 必须有下界**（`|CEILING − other| < 500`）—— 否则把上限抬成 99999 就成恒真假牙。真值 **1215**，几乎全是还没在库里出现过的冷门角色/画师人名。守护还用「抽掉整条「服饰」规则 ⇒ `other` 必须暴涨」证明上限判据有牙。

分类名**两个来源**：数据层给稳定机器 id + 中文兜底名 `label`（自解释，报告/守护里直接可读）；界面显示名**优先取 i18n**（`tagnav.cat.<id>`，两端同名）。⚠️ 与 `tUi(key, zhFallback)` 同一取向 ⇒ 改 `label` **不会**改界面（工程有「零裸中文」守护）。

**定点修正（2026-10-09）：`indian_style` 从 `style/medium` 挪到 `pose/posture`。** 它后缀是 `_style`、
看着像画风，实际是**盘腿坐** —— Danbooru 上 `implicates sitting`、Tag group = Posture
（别名 `agura`／胡坐，官方译文就是「盘腿坐」⇒ `ai/tag-zh.js` 的译名**没错**，错的是分类）。
- 挪动前后 **`other` 恒为 1215**（它本来就不在 `other` 里），三条硬约束与定点关系不受影响；
  副作用只有 `pose +1 / style −1`（全量）与可见集合 `pose 53 标签/1743 行 · style 21/3083`。
- ⚠️ **位置承重**：`posture` 那条规则排在 `medium` 之前，所以「从 `medium` 挪出去但没加进 `posture`」
  会让它**静默掉进 `other`**。改前诊断：`phrasesOf('indian_style')` = `{indian, style, indian_style}`，
  而 `indian` / `style` **不在任何规则的 token 里** ⇒ 它只被那一条规则命中，挪动不会连带影响别的标签。

规模（2026-10-09，`stats()`）：`clothing 1220 · other 1215 · work 774 · object 605 · person 487 · appearance 462 · scene 265 · adult 245 · pose 164 · expression 159 · style 107 · composition 59 · event 29 · creator 22`，合计 5813。

### 16.4 连接方式（为什么不能进读工作池）

标签在 tag 索引库而不在 `photos` 表。而**读工作池只挂一个库** —— `db-read-worker-pool` 一旦换 `dbPath` 就把整个池 terminate 重建 ⇒ 「查 tag 库」这一步只能像 `SemanticTags` / `JoyTagTags` 一样在**主进程自开连接**。

- **只读**：tag 库的唯一写入者是 tag worker（两个写入者会互拿 `SQLITE_BUSY`）。
- **失败一律降级，绝不抛**：库不存在 / 从没建过索引 / 正被占写锁 / 刚重建过 ⇒ 返回空结构，界面显示「标签索引还没建好」而不是报错。
- 已确认读不到就置 `unavailable`，**不再反复 stat**。
- 上限两枚常量：`TAG_PHOTOS_MAX_PAGE_SIZE = 200`（兜内存）、`SEARCH_TAG_LIMIT = 120`（避免「a」这种查询把 5813 条全吐出去）。
- `search()` 的结果**必须带 `node` / `category`** —— 渲染层没有分类表，全靠这两个字段。

### 16.5 桌面端子契约（`src/renderer/tag-nav-ui.js`）

1. **照片网格走全工程唯一通路** `loadPhotos()` → `fetchPhotosPage()` → `paintBrowsePhotoGridShell()` ⇒ 预览 / 信息面板 / 分页**白拿**（`startPreview(index)` 只读 `state.currentPhotos.slice()`）。**不要**为标签页另写一条取图+画图路径。
2. 🔴 **卡片早退分支的三件事**：`state.currentView === 'tag' && !state.currentTag` 时除画卡片外必须
   - `state.currentPhotos = []` —— 不清 ⇒ 在卡片上按空格/方向键会打开**上一页、上一个目录**的照片（`startPreview()` 只读这个数组）；
   - `previewFlow.initPreviewState(…)` —— 不重置 ⇒ `previewTotalPhotos` 停在旧值；
   - `updateBrowsePathLabel()` —— 不调 ⇒ 路径栏停在上一页（实测停在「所有文件」），而 `case 'tag'` 明明写好了。

   三件与 `folder_overview` 那支**逐条对齐**，缺任何一条都不报错，只在别处显形。
3. 🔴 **展开态是双写契约**：`.expanded` 类 **＋** 行内 `display:block|none` 必须同写。`gallery-design.css` 有一条 `.tree-children:not(.expanded){display:none}`（两端同源）⇒ 只去行内 display 会被它再藏回去：**箭头转了、点击有反馈、内容不出来**，而 DOM 里一切正常。
4. **缩进口径唯一来源是行内 `padding-left`**，`.tree-children` 保持 0；层级导线用 `--tree-guide-x`（与目录树同一口径）。实测：`root 38 / category 12 / sub 26 / tag leaf 66`，`guideX` = `21px`(depth0) / `35px`(depth1)。
5. 🔴 **代次判据必须是 `!==`**：写 `mySeq > seq` 时 `seq` 只增不减 ⇒ **恒假** ⇒ 过期回包照样回写，而代码看起来「已经防了」。三处：`subToken[subId]`、`cardsSeq`、`searchToken`。
6. 🔴 **缓存三态**：`undefined` = 要过；`[]` = 确实没有；`null` = **要过但失败了**。`[]` 与 `null` 必须分开存，否则一次读库失败会被显示成「这个分类是空的」。
7. 🔴 **搜索态变化必须刷主区**：`refreshMainForSearch()` 的判据只能是 `state.currentTag`，**不能**是 `state.currentView === 'tag'`（后者只说明「在标签页里」，说明不了主区现在是网格还是卡片）。`currentTag` 有值 = 主区是照片网格 ⇒ **刻意不把用户从照片上拽回卡片**；侧栏搜索结果照常更新，用户点了其中一条（`onSelectTag`）才切过去。
8. 🔴 **切语言的回调必须共用一份**：`refreshLocale()` 清 `subTags` / `pending` 后按新 locale 重取。两条路径（已展开的节点 + 当前标签所在节点）可能指向**同一个**子类，而 `ensureSubTags` 的 `pending` 合并会**吞掉后进来的 callback** ⇒ 路径栏停在旧语言。所以两条路径必须传**同一个** `afterSubLoad`。
9. **`enter()` 回包后补画一次卡片**：不许赌「树先到」—— 树比 `loadPhotos` 慢时主区会白屏。
10. **`selectTag(tag, node, category)` 在函数内沿路展开树**：导航历史 / 启动恢复直接进来时没有点击点，靠 `tagPath` 映射（`rememberPath` / `rememberPaths` / `categoryOfSub`）还原。
11. 🔴 `api.js#call(name)` 是 `photoAPI[name]` **直接索引** ⇒ 必须写 **preload 方法名**（`getTagNavStatus`/`Tree`/`Node`/`Search`/`Photos`），**不是** IPC 频道名（`get-tag-nav-*`）。写错则 `has()` 恒 false、静默失效。守护**双向**钉（api.js ↔ preload.js 对账 + 明令禁止频道名形状）。
12. 🔴 **搜索是提交式的**（2026-10-09，用户要求「标签搜索不要做成实时搜」）—— 见 §16.10。

### 16.10 搜索是**提交式**的（2026-10-09，用户要求「标签搜索不要做成实时搜」）

🔴 **敲字不发请求**。搜索只有一条发起路径 `submitSearch()`，两条显式入口：输入框里按
**回车**、点输入框右侧那个**可见的放大镜按钮**（`#tagNavSearchSubmit`）。`input` 事件**只**
更新输入框自己的状态（`keyword` + 清除叉显隐）。

**为什么防抖不对**：原来 `SEARCH_DEBOUNCE_MS = 180` 的防抖只是把「敲 7 个字母发 7 次」压成
「停顿后发 1 次」，**边打边扫的代价一点没省**（打字过程必然夹着停顿，主进程每轮要遍历 5813 条
标签名）；而且「打一半的词也在搜」本身就是错的 —— 用户看到的是 `yel` 的结果，不是他要的 `yellow`。

#### 状态分两份：`keyword`（输入框里的字）≠ `lastQuery`（已提交并生效的词）

这是整个改动的**核心**。`keyword` 非空 ≠ 在搜索态 —— **搜索态的唯一判据仍是 `searchResult`**。
`lastQuery` 承担三件事：

| 用途 | 为什么必须用 `lastQuery`、不能用 `keyword` |
|---|---|
| 重搜点（`refreshLocale` / `repaintCounts`） | 切语言 / 改展示线时用户可能刚敲了半截话还没提交，拿 `keyword` 判就会**替他**把搜索开起来（侧栏从树变成搜索结果、主区跟着跳） |
| 网页端 `leave()` 清理 | `keyword` 清了、`lastQuery` 没清 = 两者失同步 ⇒ 下次进页拿着上一轮的词自己搜起来 |
| `runSearch` 唯一赋值点 | 「在途请求对应哪个词」只有这一个来源 |

🔴 **回包判据必须删掉 `keyword.trim() !== q.trim()`**（实时搜时代它是对的，提交式下它是**错的**）：
`keyword` 可以合法地不等于最后一次提交的词（按了回车、又在回包到达前敲了几个字）——
那时那份回包**才是该显示的**，丢掉它就成了「按了回车没反应」（侧栏停在树上、主区停在上一次的
卡片列表）。过期回包**只看代次**。

🔴 **`exitSearch()` 必须 `searchToken++`**：清空（删到空 / Esc / 清除叉 / 空提交）是显式动作、
**立刻**退出搜索态回树；不作废代次的话，在途那份回包回来会把刚清掉的结果又贴回来 ——
看起来「清不掉、自己弹回来了」。`leave()` 同理。

🔴 **重画必须把焦点还给搜索框**：`renderSidebar()` 用 `innerHTML` 整块重建，旧 input 连同焦点
一起被丢掉。实时搜时代也丢，但回包由敲字触发、人早停手了所以不显眼；提交式下**按回车就要重画**，
焦点掉了 = 「想改一下关键词再搜一次」的人第二下敲不进任何字 —— 界面看着没坏，只是没反应。
做法：重画前记 `document.activeElement === prevInput` 与 `selectionStart`，重建后 `focus()` +
`setSelectionRange()`。

#### UI 与 CSS

- 搜索框结构 = `.tag-nav-search`（flex 行）＞ `.tag-nav-search-field`（**定位锚点**，包输入框与内嵌
  清除叉）＋ `.tag-nav-submit`（**独立**盒子）。提交按钮**不能**跟清除叉共用一个绝对定位锚点 ——
  那样输入框得为两个按钮白留 50+px 右内边距。类名两端刻意不共用（`tag-nav-*` / `web-tag-nav-*`），
  但**契约**逐条同形；提交按钮必须与输入框**等高**。
- 防抖那套（`SEARCH_DEBOUNCE_MS` / `searchTimer`）**干净退场**，不许留半套。
- i18n：`tagnav.searchSubmit`（中「搜索标签（回车）」/ 英「Search tags (Enter)」）。文案顺手把
  「按回车也行」说清楚 —— 这个按钮是搜索非实时之后**必须有的可见出口**，没有它用户只会认为
  「搜索坏了」。

### 16.11 守护与牙齿（提交式搜索这一轮，§16.9 同一份守护 32 → **51 项**）

- 判据集抽成模块级 `submitSearchChecks(src, who, opts)`，**两端各跑一遍**（桌面 7 条 + 网页 8 条，
  网页端多一条 `leave()`）。拆成多条 `check()` 是刻意的：一条 `check()` 堆多个 `assert` 时
  **先红的把后面的盖住**，标题只能代表第一条 —— 牙齿验证按标题匹配，粒度粗了就分不出
  「哪条契约破了」。CSS 侧另有 `submitSearchCssChecks()`：**一处定义类名、另一处引用 ⇒ 两侧各钉**
  （`indexOf` 是前缀命中，`.x-submit-y` 这种写歪一位的变体会照样绿），并钉「提交按钮与输入框等高」。
- **牙齿验证**（`.workbuddy/tmp/tag-submit-teeth/`，`make-cases.js` → `cases.json` → 技能自带
  `drive.sh`）：**18/18 精确命中、0 跳过**（桌面 12 + 网页 6，含「回包判据加回 keyword 比较」
  「重搜点改回拿 keyword 判」「CSS 锚点类名写歪一位」「按钮高度不等」）；**阴性对照 4/4 保持绿**
  （改 hover 底色 / 改 i18n 文案 / 改 placeholder / 改图标描边粗细 ⇒ 证明文案与外观没被钉死）；
  独立快照逐字节 sha1 还原。
- **行为探针**（`.workbuddy/tmp/aurora-tagnav-search/`，真模块 + 真样式表 + 真事件，5 用例）：
  键入 3 字母 **0 请求**；回车 **1 请求** 且**焦点仍在输入框**；再敲字（未提交）**仍 1 请求**；
  点按钮 → 2 请求；清除 → 回树；**在途清空**（桩延迟 900ms 的请求 + 立刻清除）→ 那份回包
  **不许**把结果贴回来（这条是 `searchToken++` 的行为级证明，静态断言钉不住）。几何读数：
  行 `display:flex`、按钮与输入框**等高**、间距 6px、清除叉在输入框内**且不与按钮重叠**、
  240 / 190 两档宽度都无横向溢出；网页端 **EN** 档 placeholder / 按钮 title 走 `t()`（抓硬编码中文）。


### 16.6 导航历史 / 启动定位：**刻意不含**标签页

`BROWSABLE_VIEWS` 与 `applyBrowseLocation` 都认 `'tag'`（三处齐备：白名单 + `case 'tag'` + `applyBrowseLocation` 内），但：

- `captureBrowseLocation()`：`view === 'tag'` 时 **`currentTag` 为空必须返回 `null`** —— 停在分类总览 / 节点卡片不算一个「位置」，否则「标签页」会以**同一个键反复入栈**，后退按钮看起来卡住不动。
- `persistStartupPositionSnapshot()`：对 `currentTab === 'tags'` **早退** —— `tag` 不在启动白名单里 ⇒ 照写只会用一条**必然被拒**的记录顶掉上一个**可恢复**的位置（「文件」停在某个目录），用户下次启动落默认页，**症状看着像「启动定位坏了」，实际是被这里顶掉的**。想让它参与启动定位是另一件事（把 `tag` 塞进白名单并一并还原 `currentTag`），本次刻意不做 —— 宁可少记，也不要记一条读不回来的。

### 16.7 网页端子契约

- 🔴 **类名两端刻意不共用**：桌面端 `tag-nav-*` 挂在 `#sidebarContent`；网页端一律 **`web-tag-nav-*`**（父级布局与 CSS 变量不同，共用等于改一端动两端）。**共用的是契约不是类名**：`data-tag-nav-*` 属性与 `/api/tag-nav-*` 路径**刻意同名**（三端契约）。
- 网页端 `index.html` 侧栏页签顺序：`folders → dates → ai_search → people → tags`；桌面端 rail：`home → folders → dates → search → people → tags → duplicates → (settings)`（⚠️「设置」那颗**刻意不带 `data-tab`**，靠 `syncNavigationRail` 的 `|| 'settings'` 兜底 ⇒ 量到 7 项而不是 8 项）。
- 静态资源是**逐个文件白名单路由**（`src/web-server.js`）⇒ 新增 js/css 必须在**同一次改动**里加路由 + `sw.js#SHELL_ASSETS`（逐字相同，含 `?v=`），并抬 `CACHE_NAME`（cache-first 客户端否则永远拿旧字节）。本次 `v53 → v54`。
- **两处** `switch (state.currentView)` 都要有 `case 'tag'`：`loadPhotos`（否则标签页永远空白）与 `loadPreviewAdjacentPage`（否则预览翻到页边界就停）。
- `enter()` 回包后同样补一次 `onPhotosChanged()`。
- 语言走 `document.documentElement.lang`；分类/子类名用服务端 `label` 兜底（网页端暂无 i18n 词表）。

### 16.8 探针

- **桌面**：`.workbuddy/tmp/tagnav-probe/`（`stub-preload.js` + `shot.js` + `probe2.js`，手工，**留项目外**）。真 `TagNav` + 真主库出数据，驱动真实 rail 点击 / 树展开 / 子类下钻 / 卡片进网格 / 搜索 / 中英切换，拿**几何读数**（`padLeft` / `nameX` / `computedDisplay` / `guideX`）而不是「没报错」当判据，17 张截图。
  - 实测：14 分类；`clothing 480/1220`（已索引/词表）；叶子 88 个 `pad=66 dot=true toggle=false`；`getTagNavNode` 调用次数 `1→1`（缓存命中）；切回中文后路径栏 `🏷️ 黑发`；**中文叶子残留 0**；页内零产品报错。
  - 🔴 **探针替身必须认 locale**：第一版 `stub-preload.js` 的 `getTagNavNode` 无视 locale 恒回中文 ⇒ 差点把「没修好」误判成产品问题。**夹具失真 ≠ 产品坏**。
- **网页**：同进程起极小 HTTP 服务器（静态文件从 `src/web/` 读，`/api/tag-nav-*` 用真 `TagNav`，其余 `/api/*` 给最小空 JSON），9 步驱动。⚠️ 服务器必须把根级 `/xxx.css` 映射到 `css/xxx.css`，否则 CSS 404、卡片退化成行内文字（**探针 bug，不是产品 bug**）。

本次探针抓出：桌面 3 个真 bug（§16.5 的 2/7/8）、网页端 1 处类名漏改（4 条死 CSS 规则，被 `css-reference-regression` 拿到）、1 个 emoji 写错（`🍿` U+1F37F 而非 `🏷️` U+1F3F7）。

### 16.9 守护与牙齿验证

`scripts/tag-nav-regression.js`（**51 项**（2026-10-09 起见 §16.11），五段）：① 数据层 **夹具库**（按 `tag-index-store` 的 DDL 现建 —— 只断言行为与排序，**不断言规模**，避免随索引重建漂移）；`rankedPhotoIds()` 用**展示线**（**双向**钉：插一张刚过线的行必须计入、插一张线下的行必须排除 —— 只钉前者时把阈值改回入库线照样绿）；**展示线可调 + 免重启生效**（`new TagNav(dir, { displayMinScore: () => knob.value })` 换掉 getter 返回值：同一个实例下一次查询就要换口径，且 `countsForTags` 同步 —— 这条抓「把值缓存成字段」与「只现取一处」两种写错法）；另钉「展示线是唯一源」（导航页与 `JoyTagTags` 共用同一个取值点、不许写死数字、两处必须挂在**同一个设置键**上、下界 = 入库线 / 上界 = 查询线、`countsForTags` 与 `rankedPhotoIds` 同口径）；渲染层还钉「改展示线必须让缓存失效」（含「清缓存要排在判断在不在标签页之前」）。② 桌面渲染层。③ 网页端。④ i18n 两包。⑤ **渲染层资源可达性** —— 此前**没有任何守护**检查 `src/renderer/*.js|css` 是否被 `index.html` 引用 ⇒ 双向补上（引用的都存在 + 存在的都被引用）。

**§4.3 那两条过滤（2026-10-09 新增 4 项）**：
- 数据层夹具新增 `blue_hair`（只有 `score=20` 一行 ⇒ **进了索引但在展示线下**），钉
  「0 命中的标签不进列表」。🔴 断言**双向**：只钉「它不在列表里」是假绿温床（把过滤删掉、
  改成「不在 `tag_vocab` 里就跳过」、甚至夹具标签名打错一个字母，全都照样绿）；反向那半
  （把线降到入库线，它必须带着 `count=1` 回来）才证明「看不见」的原因是**展示线**；
  搜索同理，另钉 `indexed` 必须报**过滤前**的命中数、以及空白关键词早退的形状也带 `indexed`。
- 渲染层（桌面 + 网页各一条）：`tagLeavesHtml` 必须收到 `sub.tagIndexed`（含「不传第三参」的反面）、
  空态必须两支分开、`renderCardList` 必须真的用 `emptyText`、搜索态与节点态各自把判据接对、
  i18n 两包都必须有 `tagnav.belowLine` / `tagnav.belowLineHint`。
  ⚠️ 反向断言**「不许再出现 `dim: !tag.count`」**旁边配了一条**阳性对照**
  （`dim: !cat.tagIndexed` / `!sub.tagIndexed` 必须还在）—— 否则「顺手把节点行的置灰也删掉」
  会被当成修好了。

⚠️ **写结构断言的三条教训（全部由本轮牙齿验证用「假绿」逼出来）**：
1. **不许用字符预算跨注释块**：`[\s\S]{0,400}` 遇到 8 行注释就不够（`'tags'` 距函数首行 **494 字符**）⇒ 断言以「函数里没有这句话」的形式红掉，而修法很容易被误做成「放宽到 800」。用 `funcBody(src, name)` 切片取函数体。
2. 🔴 **先 `stripComments()` / `stripHtmlComments()` 再断言** —— 否则注释会替代码作证。本轮抓到的两处**真假绿**：卡片分支的注释里恰好写着 `previewFlow.initPreviewState()` 与 `updateBrowsePathLabel()`，把**真实调用整行删掉**后断言照样命中注释；`index.html` 里那句注释写着「网页端那份在 `web/css/tag-nav.css`」，把真实 `<link>` 整行摘掉后孤儿检查照样认为「被引用了」。
   - 推论：**元规则 ③（结构断言不许读注释）的正确落法是「剥掉再读」，而不是「只断言正确形状」**。剥掉之后，搜**反面形状**（`subToken[subId] > myToken`）反而成了更直接的钉子 —— 注释里的反面教材已经不在视野里了。
3. **枚举式的断言必须带阳性对照**：本轮抓到的另两处真假绿都是「断言空转」——
   - `Object.keys(TagNav.prototype)` 对 **class 语法的方法恒为 `[]`**（class 方法不可枚举）⇒ 循环体一次都没跑；必须 `Object.getOwnPropertyNames`，并先断言「确实枚举到了 `status`/`tree`/`node`/`search`/`rankedPhotoIds`」。
   - 网页端类名检查**写死四个类名**，而实际有 16 个 `web-tag-nav-*` ⇒ 摘掉 `children` 那个的前缀，断言一条都不碰。改成「扫所有 `tag-nav-*` token，看前缀是否在白名单 `web-` / `data-` / `api/` 里」+ 断言「量到的 `web-tag-nav-*` ≥ 12」。
   - ⚠️ 前缀要取 **5** 个字符：`data-` 是 5 个（`web-` 是 4 个），取 4 会把 `data-tag-nav-kind` 的前缀看成 `ata-`，于是把 9 处合法属性判成违规。
4. **同一判据出现多处时按次数钉**：`subToken[subId]` 在成功路径与 catch 路径各有一道，只断言「至少有一处」时改掉一处仍是绿。

**牙齿验证**（`.workbuddy/tmp/teeth-tag-nav.sh` + `teeth-nav-cases.json` + `teeth-nav-mutate.py`）：从「父节点加回聚合」到「rail 顺序被改」「SW 漏一条」「i18n 缺 `nav.tags`」逐条改坏，每条都要求**精确命中预期那条断言**（不是「红了就行」），含 1 条**阴性对照**（插注释必须仍绿 ⇒ 证明比对器不是恒返回 false），被改动文件逐字节 sha1 还原。

🔴 **牙齿脚本自身的五条纪律**（2026-10-09 真事故，源码被留在改坏状态约 40 分钟）：
1. **变异没生效 = 失败**。锚点找不到时绝不许「跳过并算过」。
2. **必须打印失败原因**，并对账红的到底是不是预期那条。
3. **备份不成立必须在第一次变异之前退出**。「备份失败」是**开跑前的准入门槛**，不是可以警告一下继续的事 —— 事故就是这样来的：备份路径被 CRLF 污染（`xxx.js\r`）⇒ `cp` 全失败，脚本却继续逐个改坏源码，而 `restore_all` 从不存在的位置拷回来。
4. **判退出码不许拿管道末端的 `$?`**：`OUT=$(cmd | tr -d '\r'); rc=$?` 取到的是 `tr` 的退出码（恒 0）⇒ 所有失败都被读成成功。
   另：Windows 上 `print` **与 `sys.stdout.write` 都会**把 `\n` 翻成 `\r\n`（`print` 就是 `write` + 换行），`$( )` 去掉行尾 `\n` 后留下**裸 `\r`** ⇒ bash 里取 python 输出一律用 `sys.stdout.buffer.write(...)`，并加 `tr -d '\r'` 兜底。⚠️ 写成 `sys.stdout.write` 是**错的**（同样会翻）。
5. **中途从外部 `kill` 之后，必须单独确认「发起变异的那个 bash 循环」也停了** —— 用 `wc -c` 盯日志是否还在增长。「进程已杀掉」≠「循环已停」；事故里 `kill` 掉 electron 后 bash 循环又继续改坏了约 2 分钟，「已恢复」是假的。
