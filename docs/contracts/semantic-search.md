# 语义搜图 / 关键词质量 — 契约与实测

> 从 `.workbuddy/memory/MEMORY.md` 迁出（2026-10-07）：memory 只留红线 + 指针，**实测数字与推导进这里**。
> 红线仍在 MEMORY.md（FTS 中文子串恒 0 命中 / 换模型必须全量重建索引）；候选方案与代价对比见当日日志 `2026-10-07.md`。

## 模型与索引源（这决定了质量上限）

- 模型 = **SigLIP2-base-patch16-224 q8**（768 维、**多语言**、`src/ai/embedding.js`）。
- 台架横向对比（同一 1500 张语料、27 个概念，**前 10 命中**）：SigLIP2 **49/270** ·
  JoyTag **85/270** · BLIP caption R@100 0.161 · Florence 0.127（现状 CLIP 0.499）。
  完整分档、逐概念前 10、逐张图的优胜方案见 `docs/semantic-search-model-selection.md`。
- 索引源 = **256px / quality 75 的缩略图**（`scanner.js` 的 `{size:256,quality:75}`；`semantic-worker.js` 优先喂 `photo.thumbnail`）
  ⇒ 细节（发型 / 发色 / 小物件）**在源头上就丢了**。
- 🔴 推论：**在现管线里把输入档换成 384 / 512 几乎没有收益** —— 源图只有 256px，放大不会长回信息。
  真要提分辨率必须**先改索引源**（代价 = 解原图，等于把「读缩略图」换成「读整图」）。

## 分数口径与阈值（真库实测）

- 分数口径 = **基线差**：减去 `GENERIC_TEXT` 的相似度。
- 真库（7,374 张 cosplay）实测：
  - 库里**真有**的概念 top **0.02 – 0.08**；
  - 库里**没有**的概念 **0.010 – 0.016**。
- ⇒ 默认阈值 `0.01` **落在噪声带里**（「猫」top 0.0156 也过线，而它命中的是**床单上印的猫**），
  但这**不等于该抬高**：2026-10-07 用「图包名当弱标签」做过一次全库对照测试（27 个确有内容的概念、7374 张），
  `0.02` 在精确率与召回**两个轴上都更差** —— P@set 0.107→0.081、R@set 0.341→0.181、F1 0.163→0.112、
  零返回 1/27→6/27。典型失效形态：`圣诞` 前 10 名**全部正确**（P@10 = 1.0）却**返回 0 张** ——
  排序是对的，被阈值整条杀掉，用户体感就是「搜不出来」。
- ⇒ **默认值保持 `0.01`，并且它现在只是「地板」不再是「全部门槛」**（2026-10-07 起）：
  `effective = max(threshold, α × top1)`，α = 0.3（`ADAPTIVE_ALPHA`）。定义唯一定在
  `index-store.js`（`DEFAULT_MATCH_THRESHOLD` / `ADAPTIVE_ALPHA` / `MATCH_THRESHOLD_RANGE`），
  面板那份 `MATCH_RANGE` 两处同改，`semantic-regression` 逐值比对。完整分档数据见
  `docs/semantic-search-model-selection.md` 第五节。
- ⇒ **固定阈值本身就是错的方向**：`0.01→0.02` 这一档的**边际精确率只有约 2.8%**（Δ命中/Δ返回 ≈ 20.8/741），
  抬高买不到什么。正解是让每个查询按**自己的 top1** 收尺子。
- 🔴 **M1 的收益全部来自 α，与地板取值无关**（真库 7,374 张 / 32 查询实测，
  `.workbuddy/bench/probe-adaptive-live.js`）：α=0.3 把 **14/27** 个概念的生效阈值抬到 0.01 之上，
  平均返回 **1196 → 701（−41%）**、`丝袜` 3352→1233、`空姐` 4971→2249、`制服` 3486→1942，
  而**零返回 0/27 → 0/27 不变**。用户抱怨的「一堆不相关的图」修在这里。
- 🔴 **地板 `0.002` 一度被采用又被撤回，别改回去**（这是「小语料会骗人」的活样本）：
  - 台架（`sweep-adaptive.js`，**1,500 张子集**）里 `(0.3, 0.002)` 的卖点是「零返回 1/27 → 0/27」；
    **真库上这条卖点不存在** —— 零返回 ⟺ `top1 < 地板`，而真库 27 个概念的 top1 最小值 **0.0120 > 0.01**，
    地板 0.01 就已经一个都饿不死。子集样本少 ⇒ 最大值低 ⇒ 才有那个 1/27。
    ⚠️ **规模越大 top1 只会越高**（取最大值的样本变多）⇒ 全库比真库在这件事上更安全，不是更危险。
  - 代价却是可量的：地板从 0.01 降到 0.002 后**地板绑定从 13/27 掉到 0/27**（低分查询失去兜底），
    只换来 +3.0% 召回（701 → 723），而**负对照开始漏进来**：「汽车」0 → **5 张**、「咖啡」0 → **1 张**
    （达标 0 张的负对照 4/5 → 2/5）。
  - 台架上 `(0.3, 0.01)` 的 F1 **0.160 本来就高于** `(0.3, 0.002)` 的 0.159 ⇒ 两个语料都指向 0.01。
  - ⇒ **改这个数必须跑两个**：台架二维表 **加** 真库复算探针。只跑台架就会被小语料的零返回误导。
- ⇒ `MATCH_THRESHOLD_RANGE` 上限 **0.03 → 0.15**（已放开）：「丝袜」真命中到 **0.08**，旧上限把它截掉，
  等于在设置里摆了一个**用户收不到效果**的档位（0.03 时已严到 11/27 个概念零返回、平均只返回 111 张）。
- ⚠️ **阈值 `0` 是「我全都要」**：`threshold === 0` 时自适应必须让路（`effective = 0`），
  写成无条件的 `max(0, α×top1)` 会替用户做决定 —— 由 `semantic-regression` 钉着。
- ⚠️ **已装库拿不到新默认值**：`settings.json` 是**默认值全量落盘**（活跃库 49 个默认键一个不缺）
  ⇒ 改代码默认值对已装库不生效。本次两者恰好都是 `0.01` 所以无需迁移；**换默认值时必须同时想迁移**。
- 词表 308 词在本库在 0.015 档有 **154 词 0 命中**（0.02 档 201 词）。

## 词表的两个身份（别只当它是「预选词」）

- `search-vocabulary.js` 同时是**预选词**与**零样本标签**的上限。
- 标签阈值 `photo-tags.js#TAG_THRESHOLD`（`0.015`）与检索默认阈值（`0.01`）**是同一个口径、不是同一个数**：
  两者都用基线差，但标签是「错了比没有更糟」⇒ 它有自己的实测定档，**不要把两个数合并**，
  也不要因为改了检索默认值就顺手改标签。
- 词表外的概念（角色名 / IP）**任何 CLIP 都不认** —— 只能靠文件名 / 目录名兜。

## 两套词表：为什么必须分立（2026-10-07 实测）

考虑过的一个方案是「把两套词表合并成一套：预选词直接用 `joytag-labels.txt` 的 5813 个标签，
顺便把 CLIP 的零样本标签词表也换掉」。**实测否决了后半句**，理由值得记住：

**SigLIP2 认不得 danbooru 标签。** 同一批 1500 张图、同一批 386 个标签，两个模型对打
（`adjust = dot(q,v) − generic_sim`，与线上逐字同源）：

| 标签 | JoyTag | SigLIP2 裸标签 | SigLIP2 `a photo of X` |
|---|---|---|---|
| `cosplay_photo` | **0.9888** | 0.0285 | 0.0363 |
| `underwear` | **0.9532** | 0.0262 | 0.0426 |
| `fishnets` | **0.9214** | 0.0215 | 0.0310 |
| `pantyhose` | **0.9147** | 0.0564 | 0.0693 |

差 30~50 倍。全表看更清楚：SigLIP2 裸标签有 **287/386（74%）** 的标签在整批语料上
**最高分都不到 0.015**（`photo-tags.js#TAG_THRESHOLD`）；补上 `a photo of ` 前缀也只救回一半
（205/386）。**原因不是实现，是训练形态**：SigLIP2 是图文对双编码器，文本塔吃自然语言；
JoyTag 是**闭集分类器**，5813 个输出头直接对应标签，标签就是它的原生输入。

⇒ **CLIP 词表（自然语言短语）与 tag 词表（标签）是两种知识表示，不是冗余**，
合并任一方都会静默丢掉另一半能力。

### 互补到什么程度（27 个有正样本的概念）

「答得出」= 在该概念的正样本里至少有一张过阈值（CLIP `T=0.01`、tag `T=0.55`）：

| | 个数 | 概念 |
|---|---|---|
| 只有 CLIP 能答 | 3 | 黑丝 / 白丝 / 泳装 —— 全是**颜色变体**（该模型标签表里腿部服饰**没有任何带颜色的变体**） |
| 只有 JoyTag 能答 | 7 | 旗袍 / 毛衣 / 护士 / 圣诞 / 教室 / 洗手间 / 猫 —— 全是**具体物件/场景** |
| 两路都能 | 11 | 制服 / JK制服 / 比基尼 / 女仆 / 网袜 / 吊带 / 短裙 / 内衣 / 死库水 / 绳艺 / 蛋糕 |
| 两路都不能 | 6 | 空姐 / 丝袜 / 蕾丝 / 兔子 / 浴室 / 停车场 |

**CLIP 14/27、JoyTag 18/27、并集 21/27** ⇒ 并集比更强的一路还多 3 个。
负对照（雪山/汽车/咖啡/鲜花/婴儿，语料里一张都没有）：CLIP **0 误报**，JoyTag 各 1 张
咖啡与鲜花（tag 路的误报靠绝对阈值压，见 M4 判据）。

⚠️ 这张互补表是**量级判断**不是精度评测：正样本来自图包目录名（弱标签，有噪声）。
原始报告：`.workbuddy/bench/out/label-language.txt`、`two-vocab-complement.txt`。

### 预选词候选池（从标签表派生）

- 候选池 = `joytag-labels.txt` 5813 条**剔掉 193**（META 37 + ADULT 146）⇒ **5620**。
  实测这份表本身很干净：CONTENT 内容标签占 **96.2%**（`absurdres`/`bad_id`/`commentary`
  这类 danbooru 元标签一概不在），元数据只有 37 条。
- 两档剔除的唯一判据是 `src/ai/tag-labels.js#isSelectable()`。取舍写在那里，两条值得记住：
  - **服饰类一律保留**（`underwear` / `lingerie` / `bikini` / `pantyhose` / `panties`）——
    本库主力内容，删了是静默损失；
  - ⚠️ **`bondage` / `shibari` 刻意保留**，不是漏判：本库有 119 张绳艺图，用户在
    `probes.js` 里明确要搜「绳艺」，JoyTag 在正样本上给 `bondage` 打 **0.7738**。
    过滤的目标是**裸露与性行为**，不是「与性沾边的题材」。
- 中文名覆盖只有 **370/5620 = 6.6%**（`tag-vocabulary.js` 反查）⇒ 缺名的候选点开是
  **英文标签原文**。这是刻意选择（全量候选 + 缺名显示原文），不是尚未补全；
  缺名的词被用户点到，就是「该给它配个中文名」的信号。

### 更新机制（三层，2026-10-07 落地）

`joytag-labels.txt` 是**随包数据表**，顺序即输出下标 ⇒ 手工插一行会让全库 tag 索引的
`tag_id` 集体后移，而所有静态守护照样全绿。三层机制把它变成「不跑就红」：

1. **检测**：唯一入口 `src/ai/tag-labels.js`（`labels()` / `labelAt()` / `indexOf()` /
   `fingerprint()` / `isSelectable()`）。`fingerprint()` 返回 sha256 + 行数 ——
   **用内容哈希而不是手写版本号**：手写版本号在「改了内容忘了抬号」时完全无效，
   而那正是唯一需要检测的时刻。
2. **重建**：`node scripts/tag-vocab-rebuild.js`（秒级）重建**结构层**快照
   `scripts/tag-vocab-structure.json`（标签表指纹 / 词表指纹 / 候选池 / 字典覆盖率），
   并打印 diff 与「下一步该跑什么」。`--check` 只报告不写。
   🔴 **它绝不修改 `scripts/tag-vocab-coverage.json`** —— 那是**实测结论**（1500 张 ×
   T=0.55 的命中数）。顺手刷新它的指纹就等于在**没有重测**的情况下宣布「重测过了」：
   证据没变，但看起来是新的。要刷新它只能跑
   `run-tag-vocab-validate.js`（约 1002 s）→ `report-tag-vocab.js`（秒级，**直写**
   `scripts/tag-vocab-coverage.json`，原来那个「生成到 out/ 再人工复制」的手工环节已取消）。
3. **守护**：`scripts/tag-vocab-regression.js` 比对两个快照里的 `labelFile.sha256`
   与当前文件，不符即红并给出要跑的命令；同时断言词表指纹
   （`tag-vocabulary.js#vocabFingerprint` —— **唯一源，禁各脚本自算**：两边各算会
   出现「一个说没变、一个说变了」，而人会去改其中一个让绿，真问题被掩盖）。
   反向自测覆盖：改一行（行数不变）必须被指纹抓到、插一行必须被 `EXPECTED_LINES` 抓到。

⚠️ 两个快照的**代价差三个数量级**（结构层秒级、行为层 1002 s），所以不要把它们
混成一个「重跑」命令 —— 结果只会是要么没人愿意跑，要么伪造了「已重测」。

## tag 词表（中文查询词 → danbooru 标签）

tag 路线（「tag 提精度 + CLIP 保底」）的唯一词源是 `src/ai/tag-vocabulary.js`。
它把用户打的中文翻成**真的存在于模型标签表里**的标签；查不到的词 `lookup()` 返回 `null`
⇒ 该次查询**只走 CLIP 路**，并且界面必须说明「该词未启用标签检索」，**不许**当成 0 结果。

- **规模（2026-10-07）**：324 条 = 308 预选词表逐词对齐 + 16 个台架概念（女仆 / 护士 / 死库水 /
  网袜 / 绳艺 / 吊带 / 毛衣 / 内衣 / 洗手间 / 停车场 / JK制服 / 兔女郎 / 鲜花 / 黑丝 / 白丝 / 空姐）。
  可用 **293**，显式 unsupported **31**，平均每词 1.64 个标签。
- 🔴 **标签存在性的唯一判据 = 随包 `src/ai/joytag-labels.txt`**（5813 行，一行一个，
  **顺序即模型输出下标**；来源与许可证见 `src/ai/licenses/JoyTag-Apache-2.0.txt`）。
  写一个不在表里的标签 ⇒ 该词**恒 0 命中**，而这是**静默错**。
- 🔴 **别用「英文侧原样查表」估这条路可用性**：308 词的英文侧（去冠词 + 空格转下划线）只命中
  **138/308 = 44.8%**，且命中的一半是「海滩 / 森林 / 沙漠」这类**本库一张都没有**的风景词。
  逐词映射后 **281/308 = 91.2%**。
- **`mode` 两档**：`any`（默认）= 命中任一标签、打分取**最大分**；`all` = 全部过阈值、取**最小分**
  （用于真复合词，如「夕阳下的海滩」= `beach ∧ sunset`）。
- **模型词表的能力边界**（这决定了哪 31 个词必须留空）：JoyTag 的 5813 个标签是 danbooru 按词频截断的，
  长尾混着角色名（`ohara_mari`），而**大面积缺场景词**（`canyon` / `valley` / `volcano` / `glacier` /
  `island` / `palace` / `airport` / `railway` / `plaza` / `fountain` / `living_room` / `wig` /
  `bee` / `yoga` / `skiing` / `hot_pot`），**以及全部九个基础色名**（`red`/`blue`/…/`grey` 一个都没有，
  表达「整张图偏红」要用 `red_theme` / `red_background`）。
  ⇒ 我们只用到 **386/5813 = 6.6%** 的标签。
- 🔴 **腿部服饰没有带颜色的变体**：只有 `pantyhose` / `thighhighs` / `fishnets` / `socks` / `kneehighs`，
  **没有** `black_thighhighs` / `white_thighhighs` / `white_socks` ⇒ **「黑丝」「白丝」必须留空**。
  硬指向 `pantyhose`/`thighhighs` 的后果是「搜白丝返回黑丝图」，而且错结果还会经 RRF **污染 CLIP 的结果**。
- **代理标签要克制**（字面标签不存在、但存在视觉等价物时才用）：采用的有
  `银发 → grey_hair/white_hair`、`红色 → red_theme/red_background`、`手办 → doll/doll_joints`、
  `寺庙 → shrine`、`客厅 → couch/armchair`、`油画 → painting_(medium)`；
  **拒绝**的是 `闪光灯` —— 表里有 `flashing`，但它在 danbooru 里是「当众暴露身体」，
  用它当相机闪光灯会同时**答错**和**放出 NSFW 内容**。
- 🔴 **判「零命中」必须分两种成因**：① 标签错（映射问题）② **这个语料里根本没有那种内容**
  （库里没有圣诞照，搜不出圣诞照是对的）。按全词表卡会把②当成①，逼人为了让守护变绿去硬凑标签。
  ⇒ 只对**有 ground truth 的概念**卡（`probes.js` 用图包目录名当弱标签，28 个有正样本），
  门槛 = **正样本上最大分 ≥ 0.15**（tag 倒排的入库阈值）。门槛不能取「> 0」：实测
  「停车场 → `car`」在 11 张停车场正样本上最大分只有 **0.0346**（噪声量级，但比 0 大）；
  也不能更高：`蕾丝 → lace` 的 0.5124 已贴着操作阈值 0.55。
- ⚠️ **弱标签有噪声，别迁就它改映射**：「泳装」那个图包（`NO.030分体制服jk泳装`）里其实是内衣照
  （`underwear` 0.43~0.74 vs `swimsuit` 0.20~0.29）⇒ 5 张「正样本」上 `swimsuit` 最大 0.31。
  这是 ground truth 错，不是映射错。
- ⚠️ **待观察**：`丝袜 → pantyhose/thighhighs` 在正样本上最大只有 0.3597，怀疑与索引源是 256px JPEG 有关
  （薄丝袜的光泽在 256px 下基本没了）。全库重跑后索引源变 512/WebP，这个数要重测；在此之前**不动映射**。
- **两条由实测改出来的映射**（正样本来自图包目录名，逐张看图核过）：
  ① `猫` 在这个库里**不是真猫** —— `桃良阿宅NO.025猫猫` 里 `cat_ears` 0.54~0.58 / `tail` 0.68，
  而 `cat` 只有 0.10~0.19 ⇒ 扩成 `cat, cat_girl, cat_ears` 后正样本最大分 0.19 → 0.67（`兔子` 同理加 `rabbit_ears`）；
  ② `停车场` 是**错映射**不是弱映射（只有 `car`、没有 `parking_lot`）⇒ 降级 unsupported。

**守护**：`scripts/tag-vocab-regression.js`（已进 `run-regressions.js`）——
① 标签必须在随包标签表里 ② `missing` 必须是真缺 ③ 308 词表一个都不能漏、有证据的概念一个都不能删
④ 快照新鲜度 + 有正样本的概念不许哑；并带**反向自测**（五种改法都必须被当场抓住）。
🔴 `scripts/tag-vocab-coverage.json` 是 1500 张真语料（`K:/COS` 144 包连续段）的**冻结快照**：
改词表就必须重跑 `.workbuddy/bench/run-tag-vocab-validate.js` + `report-tag-vocab.js`。
里程碑 M0–M6 与预算见 `docs/semantic-search-tag-plan.md`。

## tag 倒排索引（tag 路的存储侧，2026-10-07 M3）

- **唯一真相源 `src/ai/tag-index-store.js`**：DDL / 阈值 / 取词 / 打分全在这里。
  表：`tag_meta`（身份）/ `tag_vocab`（tag_id ↔ tag）/ `tag_photo`（**每张图的凭证**）/
  `photo_tag`（`WITHOUT ROWID`，PK `(photo_id, tag_id)`，`score` 0–100 整数）+ `idx_tag_score(tag_id, score DESC)`。
- 🔴 **`tag_id` = JoyTag 的「输出下标」**（= `ai/tag-labels.js#indexOf`），**不是自增**。
  自增依赖插入顺序，重建一次索引 id 就全漂，而「没有地方断言过 id 的含义」⇒ 漂了也全绿。
- 🔴 **凭证按「每张图」存一行（`tag_photo`），不按 (图,标签) 对存**：`source_spec` / `engine`
  的粒度和「这张图是怎么被打标的」一样粗，逐对存会把同一份字符串重复 ~88 遍。
  判废能力一点没少（`DELETE FROM photo_tag WHERE photo_id IN (SELECT photo_id FROM tag_photo WHERE source_spec <> ?)`）。
  守护断言**无孤儿**。
- 🔴 **`quantize` 必须 `floor`，不能用 `round`**：要的等价性是 `floor(p×100) ≥ t ⟺ p ≥ t/100`（t 为整数），
  这条**只有 floor 成立** —— `round(0.4999×100) = 50` 会在查询线 0.55 处**多放进一张**。
  （证明：`floor(x) ≥ t (t∈ℤ) ⟺ x ≥ t`。）守护用穷举 99×2001 组验证。
- **两条阈值，别混**：
  - **入库线 `STORE_MIN_SCORE = 0.15`**（低于它永远查不到 —— 查询线是 0.55 —— 且行数会爆）。
    实测 **87.7 个标签/张** ⇒ 全库 ≈ 2.44 GiB。⚠️ 不许把入库线抬到接近查询线：
    那样「存的时候就丢了本来能命中的行」，而失效是静默的。
  - **查询线 `TAG_ROUTE_THRESHOLD = 0.55`**，与 `scripts/tag-vocab-coverage.json#threshold`
    **同源**（`tag-index-regression` 钉着）—— 那份覆盖率快照就是在 0.55 上验证的，
    产品用别的数查就是「验证过能用、真查却是空的」。⚠️ 台架上 **F1 最优是 0.5**（0.355），
    但 0.5 起负对照开始漏（雪山/咖啡/鲜花）⇒ **0.55 取精度、0.5 取 F1**，范围 `[0.2, 0.95]` 让用户自调。
- **`mode` 与词表侧同语义**：`any` = 命中任一标签、打分取**最大分**；`all` = 每个标签都要达标、取**最小分**。
  返回的每条结果带 `tags`（因为哪几个标签上榜）——**回填的标签自己也必须达线**，
  否则会出现「分数 0.42 却挂着 0.42 的标签」这种自相矛盾。
- 🔴 **验收基准必须与产品词表同口径**：`.workbuddy/bench/probes.js`（M0 之前的草稿）的 tags 与
  `tag-vocabulary.js` 在 32 个概念里有 **20 个不一样**（`animal_ears` 0.8245 vs `cat_ears` 0.0809）。
  拿 `rank-joytag.json` 当基准会得到 7 处**假实差**；正确基准是 `joytag-vocab-validate.jsonl`。
  ⇒ **任何引用 `rank-joytag.json` 的旧读数都不是产品词表的质量。** 用 `eval-tag-vocab-quality.js` 重测的结果：
  两个口径 **F1 持平**（0.5/0.55/0.6 三档分别 0.309→0.310、0.273→0.275、0.203→0.204），
  产品口**负对照误报更少**（7→6、2→1、2→1）。
- ⚠️ **`probes.json#positives` 是全量语料上的计数**（「制服」=317），而排序常在子集（1500）上做 ⇒
  直接用会把召回系统性压低 5 倍、凭空得出「词表变差」的结论。正样本**必须先与语料求交**
  （`metrics.js#scopeProbes` 做的就是这个）。
- **口径必须与线上一致**：取图 `thumbnail || file_path` →
  `rotate().resize(512,512,inside).removeAlpha().jpeg()`（与 `semantic-worker.js` 逐字相同）；
  预处理 `contain` 到 448×448 + ImageNet 归一化；`sharp.concurrency(1)`。三者一起记进 `tag_meta.prep_spec`。

## 🔴 顶栏「后台任务」面板：AI 那两节的进度口径（2026-10-08 落地）

人脸 / 搜图各有独立一节（`taskFaceSection` / `taskSemanticSection`），共用同一段渲染
（`scan-flow.js#renderBackgroundTaskPanel` 里的 `aiTask` 循环）。三条不许动的规矩：

### ① 显隐判据是 `operation`，不是 `phase`

```js
showFace     = running && ['install','index','loading','indexing','downloading','stopping'].includes(face.phase)
showSemantic = running && ['install','index','tag'].includes(semantic.operation)
```

- ⚠️ **`'tag'` 曾经不在里面**（2026-10-08 修）：`semantic-worker.js` 有一条
  `if (operation === 'tag') return refreshTags();` —— 那是**启动后 3 秒自动跑的补 tag 倒排长任务**。
  它不在取值域里 ⇒ 那节隐藏；**若它是唯一在跑的任务，`showPanel` 整体为假 ⇒ 连面板标题一起消失**。
  实证：真 `renderBackgroundTaskPanel` 跑 `{operation:'tag', running:true}` 返回的面板是 `none`。
- 🔴 **为什么这类缺陷总是事后才被发现**：**只要有另一条进度列在跑，它就撑着面板**。
  第 27 轮的「缩略图重建不显示」被补全遮掩、这一次被缩略图重建遮掩 —— 同一个形状。
  ⇒ **新增一条进度列时，问的不只是「我把和链接上了吗」，还要问「它单独跑的时候能不能撑起面板」。**
- ⚠️ 判据**不能改成 `phase`**：`phase` 里的 `'loading'` 搜索 / 预选词也会经过 ⇒ 会把「正在搜图」
  显示成后台任务。搜索与预选词**刻意不显示**（那不是后台任务），守护钉着这一点。

### ② 分母有两个来源，必须能区分

| 阶段 | 分母 | 来源 | 界面 |
| --- | --- | --- | --- |
| `tag`（补 tag 倒排） | **精确** | `index-store.js#pendingTagsCount()`（纯 `COUNT(*)`，只数不读 BLOB） | 不写「约」 |
| `index`（建索引） | **抽样估算** | 新增 `estimatePendingCount()` | 写「约」/`~` |
| `install`（下载模型） | 无 | 走 `percent`（下载器自己报） | 进度条画 percent |

- `index` 阶段**本来就没有精确总数**：候选集靠倒序游标一批批走（`WHERE p.id < ? AND <谓词>`），
  规模不预先已知。精确 `COUNT(*)` 也走不通 —— 谓词判断列（`model`/`file_path`/`file_size`/
  `date_modified`）**一个可用索引都没有**、而且是**跨库 JOIN**（`photos LEFT JOIN semantic.embeddings`），
  只能全表扫；缩略图那边同形的 `COUNT` 在本机真库实测 **80~95 秒**。
- ⇒ `estimatePendingCount()` 用 `database.js#estimatePendingCandidateCount()` **同一套 id 轴等距抽样**
  （`step = maxId / samples`，逐个 `WHERE p.id = ?`，按 `hits / sampled × total` 放大，
  样本夹在 `[50, 20000]`）。**活库实测（165.7 万行）**：搜图 **553 ms** / 估计 1,649,649（99.6%）；
  人脸 **87 ms** / 估计 1,406,063（84.9%）。
- 🔴 **id 空洞不计入样本**（`if (!row) continue;`）：`photos.id` 有删除留下的洞
  （真库 id ∈ [324737, 1981503] 而总行数 165.7 万），算进去会**系统性拉低命中率**。
- 🔴 **`totalEstimated` 是承重字段**：把估算值当精确值显示，用户会拿它去核对行数、
  然后得出「进度算错了」。反之把精确值标成估算值同样错。

### ③ 分母与候选集必须**逐字同源**，且起手要重置

- 两个 store 的候选谓词抽成共享常量 `CANDIDATE_PRED`，`batch()`（真取批）与
  `estimatePendingCount()`（分母）都插它。**分母与候选集漂开 ⇒ 百分比与真实工作量脱钩，
  而且不会报错**，只是那个数字慢慢失去意义。守护的判据是**「谓词字面量在文件里只许出现一次」**
  （有人重新内联进 `batch()` 立刻红），不是「有没有常量」。
- **估算失败必须降级、不许抛**：独立 `try/catch`，失败时 `total = 0` ⇒ 界面按 `total > 0` 的门
  自然不画百分比。**一个只给用户看的进度分母，不该弄死一个要跑几十小时的索引任务。**
- 🔴 **任务起手必须重置 `total` / `totalEstimated`**（`semantic-search.js` 的 primary 起手块）：
  那块是**逐字段列的**、不是「清空后重建」⇒ 漏掉新字段，上一轮的 `total` 会**跨任务活下来**
  （`index` 播下一个百万级分母，接着跑 `tag`/`search` 时界面照用那个假分母，不报错，只是百分比永远接近 0%）。
- **消费端要夹 `Math.max(total, done)`**：分母是**起始快照**、扫描会持续入库 ⇒ 分子可能反超。
  修法是把**分母抬到分子**（与 `getThumbnailBackfillProgress` 同一规矩），**不是把分子压下来** ——
  分子是「真的做了多少」，压它等于对用户少报工作量。

### ④ 计数行的形状与语言

- `完成 N / 共 M（pct%）`（与缩略图那两节主行同形状）；**失败 / 跳过只在 `> 0` 时追加**。
- ⚠️ **括号跟着语言走**：中文全角 `（42%）`、英文**半角** `(42%)`。全角括号混进英文既是排印错误，
  又会**漏过「英文界面零 CJK」那类判据**（`（）` 是 CJK 标点）。这一节是就地 `en ? … : …` 拼的，
  **两套语言都要验** —— 只验一种等于只验一半。

## 🔴 模型就绪状态（`ready`）的判据与求值时机（2026-10-08 修）

**症状**：模型文件明明齐全，界面却说「本地模型尚未就绪 / 请在桌面端完成下载」，而索引跑得好好的、
搜图也出结果。用户 2026-10-08 报的就是这个（「搜图索引为什么显示模型未下载」）。

**根因不是文件缺失，是 `ready` 曾经只是个缓存值。** 它起手 `false`，只在某个任务（`install` /
`status`）跑完时按 worker 返回值的白名单写回；而 `refresh()` 只在 `phase === 'idle'` 时才去跑一次
`status` 探明它。于是有一条**不需要任何错误就能走通**的失效链：

| # | 发生的事 | 后果 |
| --- | --- | --- |
| ① | 进程起来 | `phase = 'idle'`、`ready = false`（起手值） |
| ② | 第一个 AI 动作是「建立索引」 | `run('index')` 把 `phase` 变成 `'index'` |
| ③ | 索引跑完 | `phase = 'complete'`，而 **`index` 的返回值里没有 `ready`**（只有 `install` / `status` 带）⇒ 它一直是 `false` |
| ④ | 此后 | `phase` 已不是 `'idle'` ⇒ **再没有任何代码会去探它**，直到重启 |

判据链两端都是 `!ready`：网页端 `web/js/ai-views.js#noticeFor`、桌面端 `renderer/ai-views.js`
搜图页空态。所以整个「模型没下载」的样子是**纯显示层的谎**，与磁盘无关。

### 修法：降格成「一个文件的属性」，在状态快照里按磁盘实况派生

- `ready` 的**唯一判据**是 `ready.json` 的 `model` 字段是否等于 `MODEL_KEY`，
  实现只有一份：`src/ai/bundled-models.js#isSearchReady(searchAiPath, modelKey)`
  （配套 `writeSearchReady`）。主进程 `semantic-search.js#status()` 与
  `workers/semantic-worker.js` **都 require 这一对函数**，谁也不许自己
  `path.join(root, 'ready.json')` 再 `JSON.parse` 一遍 —— 两份判据一旦漂，就是
  「界面说没就绪、索引却照跑」这种不报错的错。
- **求值时机 = 每次 `status()` 同步派生**：`out.ready = isSearchReady(this.aiPath, MODEL_KEY);`。
  一次 `readFileSync` + 比一个字符串（几十微秒），远低于「为它起一个 worker」（约 1 秒 + 开一次库）
  ⇒ 可以每次查状态都算，于是它**不再依赖任何任务的时机**。
- 🔴 **不许改回「靠某个任务探明」**，还有第二个独立理由：`status` **不在**
  `concurrentReads` / `relayReads`（那两个只有 `['search','suggest']`）⇒ 索引在跑时
  `run('status')` 必被 `AI_BUSY` 拒，网页端那条 `/api/ai-search-status` 路由直接 503。
  也就是说「等索引跑完再探」这条路在最需要它的时刻恰好是关着的。
  ⚠️ 这条说的是 `status` 作为**请求方**；它作为**占用方**不许挡只读请求，见下面
  「只读请求（搜图 / 预选词）的路由」一节（两件事别混）。
- ⚠️ **`state.ready` 留着不动**：它现在只是「最近一次任务的结果」，语义上不算错值，且与派生值
  **同源同判据** ⇒ 不会互相矛盾。派生值不许写回 `state`（`status()` 返回的是 `{...this.state}` 的副本）。
- ⚠️ `bundled-models.js` **顶层只许依赖 `fs` / `path` / `crypto`** —— 主进程 require 它是前提
  （不能把 ORT / `better-sqlite3` / `sharp` 拖进主进程）。`embedding.js` 只在函数内部
  require `onnxruntime-node`，所以主进程取它的 `MODEL_KEY` 常量是安全的。

### ⚠️ 一个被推翻的类比：`indexed` **不是**同类缺口（2026-10-08 当场纠正）

修 `ready` 时曾把 `indexed` 也判成「同形的缓存缺口」（理由：本机实测真库 `embeddings` 7374 行，
而 `GET /api/ai-search-status` 返回 `"indexed": 0`）。**这个类比是错的**，判据只有两条：

1. **`index` 的返回值里有 `indexed`** —— `semantic-worker.js` 末尾那句
   `return { indexed: store.count(), done, failed, skipped, tags }`，父进程的返回值白名单里
   也有 `'indexed'` ⇒ 任务**结束**时它一定会被刷新。（`ready` 是**永远**不刷新 —— `index`
   的返回值里根本没有它，这才是那个 bug 的本质。）
2. **那个 `0` 是「任务进行中」的自然结果，不是过期**：起手块（`run()` 的 `primary` 分支）
   逐字段重置 `file` / `currentFile` / `done` / `total` / `countPhase` / `tag*` / `clustered`，
   **刻意不含 `indexed`** —— 把它重置成 0 更糟（索引一跑起来界面就说「已索引 0 张」）。
   于是**冷启动后第一次跑索引期间**，它只能是构造函数起手值 `0`：实测索引到第 132 张时
   接口返回 `"indexed": 0`、`operation: "index"`，而库里已有 7374 行 —— 当时那个进程
   **正在跑索引**，这就是最初误判的来源。

**消费端本来就防住了**：都用 `running` 做门（`renderer/ai-views.js` 的
`stale > 0 && !current.indexed && !current.running`、`web/js/ai-views.js` 的
`!status.indexed && !status.running`）⇒ 进行中不会误报「去建索引」。代价只是索引期间
拿不到「已索引 N 张」那一句，而任务进度行另有 `done` / `total` 口径。
⇒ **不修**。真要改只有一种合理改法：让 worker 在索引循环里周期性上报 `indexed`
（走 `progress` 帧）—— 但那等于给「`Object.assign` 共享扁平字段」再加一个易串的槽，
收益只是多一句文案，**不值**。

### 守护

`scripts/model-ready-regression.js`（已注册进 `run-regressions.js`，紧随 `bundled-models-regression.js`）
五组：① `status()` 里有且只有一处从磁盘派生（走 acorn 剥注释 + **限定在方法体内**，
不吃构造函数起手值与 worker 白名单里的 `ready` 字样）；② 行为层 —— 造 `state.ready:false` +
`phase:'complete'` 的替身，磁盘写 `ready.json` 后快照必须变 `true`，且**全程 `run` 调用数为 0**；
③ worker 不许自带第二份判据（禁 `ready.json` 字面量 + 必须 require 共用函数）；
④ `bundled-models.js` 顶层不许碰重依赖（并把「require 链里有没有混进重模块」也查一遍）；
⑤ `MODEL_KEY` 全仓只有一处定义（两份定义 = 两代模型）。
每组都配反向用例；此外做过 **6 条源码级注入**（静态组 5 条 + 行为组 1 条「把共用判据改成恒真」），
全部精确红在预期断言并逐字节还原。

## 🔴 预选词的两条路：常规走只读 SQL，老契约才起 worker（2026-10-09）

**症状**（用户原话）：「为什么搜图预选词加载慢，标签没这问题」。

**根因是「把已经算过的东西又重算了一遍」**。预选词要回答的只有一句：**这个库里哪些词点下去有图**。
而这份信息**早就躺在索引库里**了 —— 建索引 / 补标签时（`src/ai/photo-tags.js`）每张图已经把
top-3 标签的**词表下标**写进 `embeddings.tags`。老实现却每次进搜图页都另起一个只读 worker 重新算：

| 老路（起 worker、载模型） | 实测 |
| --- | --- |
| `loadEncoder`（只载文本塔，textOnly ≈900 MB） | ≈2.1 s |
| 打开索引库 | ≈0.7 s |
| 308 个词 × 3000 张取样向量逐对点积 | ≈1.2 s |
| 冷启：现算 308 个词的词表向量 | +12.9 s |
| **合计** | **≈4 s（冷启 ≈17 s）** |

新路（`SemanticTags.suggestTerms`，主进程只读 SQL）：`json_each` 把 `embeddings.tags` 转置成
「词 → 命中张数」，`GROUP BY` 实测 36–45 ms，加一次分母 `COUNT(*)`（≈30 ms）⇒
**开库到出结果 48 ms，完整一次调用 70–90 ms**（本机 9406 行）。**不起 worker、不载任何模型。**

### 按入参形状分岔（不是新旧替换）

| 入参 | 谁答 | 为什么 |
| --- | --- | --- |
| `{ lang, limit }` | 主进程只读 SQL | 界面**唯一**的用法：要「这个库的池子」 |
| `['词', …]` / `{ candidates: […] }` | worker 的 `suggest` 分支 | 只有它能对**词表外**的任意词真去打分（SQL 路只能在 308 词的词表里查下标，词表外的词一律 0） |

两侧出口 —— 桌面 `main.js#ipcMain.handle('ai-search-suggest')` 与网页
`web-server.js#handleAiSearchSuggest` —— **分岔判据完全一致**，回答形状**逐字段一致**
（`{ sampled, terms: [{ text, hits }] }`）⇒ 渲染层不需要知道这次是谁答的，也一行都不用改。

### 🔴 `hits` 不是张数

`hits` = **有多少张图把该词排进了自己的 top-3 标签**，**不是**「搜它能返回多少张照片」。
两个原因，都不是实现误差：

- `TAG_MAX = 3` —— 每张图入库时最多留 3 个标签，其余概念就算分数很高也**没进库**；
- `TAG_THRESHOLD = 0.015` 与检索用的 `MATCH_THRESHOLD`（0.01）**不是同一把尺子**
  （`photo-tags.js` 里有专门注释解释「同一把尺子但不是同一个数」）。

⇒ `hits` 只允许做两件事：**挡掉 0 命中**与**排序**。绝不许显示给用户，也不许拿它跟「找到 N 张照片」
对齐 —— 想显示张数要另外去问检索。⚠️ 当前界面只取 `terms[].text`（**根本不显示 hits**），
所以这个约束**在界面上看不出来**，只能靠契约与守护。守护的判据是**返回条目的键集合恰好 `{text, hits}`**：
想加一个像 `count` 的字段，就必须回来改这份契约。

### 覆盖面，以及顺带查出来的一个抽样退化

- 只覆盖**已打标**的图（`tag` 任务跑过的地方）。返回里的 `sampled` = 这次真正数了多少行，
  与「全库有多少张图」**无关**；`sampled === 0` 时界面把预选词整块收起（既有取向）。
- **老路是取样（3000 张），新路是全量转置。** 顺带实测：老抽样在本机那份索引上已经退化 ——
  `photo_id` 落在 `324737..325141` 与 `1979470..1979844` 两段上，8 个窗口的起点大量落进中间的空档，
  `photo_id >= start ORDER BY photo_id LIMIT 375` 于是反复返回**同一批** ⇒ 去重后 `sampled` 只有
  **750 / 9406 = 8%**（`CONTRACTS.md` 里「本库 7374 行 → sampled 稳定 3000」那句是 7374 行时代的结论，
  库长到现在已经不成立）。新路一条不漏，所以这个偏差对预选词不再有影响。
- 🔴 **必须按 `tags_key` 过滤**。`tags` 存的是**词表下标** ⇒ 词表一改，同一个下标指向的是**另一个概念**，
  不过滤就会把「丝袜」的位置报成别的词，**不报错、数值也像真的**。判据与
  `IndexStore.pendingTagsCount()` 完全一致 —— 那里认为「无效」的行，这里也不许统计。

### 条数上限的唯一定义处

`SUGGEST_LIMIT_DEFAULT = 24` / `SUGGEST_LIMIT_MAX = 64` 现在定义在 `src/ai/search-vocabulary.js`，
两条路都引用它。⚠️ 另写一份的后果不是报错，而是「同一个界面元素被两条路服务时条数不同」，
而界面只摆 5 个（`SUGGEST_COUNT`）⇒ 差 24 还是 64 **在界面上看不出来**。

守护：`scripts/suggest-terms-regression.js` —— 真夹具库跑行为（`tags_key` 过滤 / 同分次序 / 语言 /
条数夹取 / 降级不抛 / 只读句柄）+ 接线（两侧分岔、注入、不起 worker）+ 唯一源。
**15 条牙齿用例**（14 条改坏必须精确红 + 1 条阴性对照必须保持绿），逐字节还原。

## 🔴 只读请求（搜图 / 预选词）的路由：它不该被任何后台任务拒（2026-10-09 修）

**症状**（用户原话）：「语义搜索时提示后台任务正在运行，请稍后再试。**不应该影响搜图**」
（`AI_BUSY` → 桌面端 `renderer/ai-views.js#explain`、网页端 `web/js/ai-views.js#explain`）。

**根因不是内存，是路由**：`run()` 里「已经有 worker 占着」时只有一种出路 —— `relay` 给那个
worker，而 `relay` 的准入写的是 `this.state.operation === 'index'` ⇒ 其余操作一律 `AI_BUSY`。
于是下面这些窗口里搜图必失败，而它们**恰恰都发生在用户正在用搜图的时候**：

| 占着 worker 的操作 | 为什么正好撞上用户在搜图 |
| --- | --- |
| `suggest` | 进搜图页就自动取预选词。⚠️ **2026-10-09 起常规路径已改走主进程只读 SQL、压根不起 worker**（见上一节）；仍列在这里是因为**老契约形状**（给一组指定的词打分）还会起 worker |
| `tag` | 启动后 3 秒自动补 tag 倒排（`main.js` 的启动任务，1.8 s 纯算术），且它在**后台任务面板里可见** —— 所以「后台任务正在运行」这句话看起来成立 |
| `status` | 会话第一次查状态要起一个 worker（≈1 s） |
| `index`（尾巴） | 双 worker：CLIP 路收场后 JoyTag 路还在跑（大库上几小时），槽里留着**那具尸体**；`postMessage` 到已退出的 worker **不抛错也不回话**（实测）⇒ 每次搜索挂满 **120 s** 后报「任务超时」 |

**修法：把「跟谁要这次只读」抽成一张表**（纯函数，回归直接单测）：

`src/main/semantic-search.js#readRoute(occupying, workerExited) → 'relay' | 'spawn' | 'busy'`

| `occupying` | `workerExited` | 路由 | 理由 |
| --- | --- | --- | --- |
| `index` / `search` / `suggest` | false | `relay` | 这三种操作跑起来后手里**握着编码器 + 库连接**（`semantic-worker.js#execute` 里只有它们会走到 `activeEncoder = encoder`），托给它就不会有第二份 SigLIP2（内存红线） |
| 同上 | **true** | `spawn` | 对端已经没了 —— 投过去只会挂满超时 |
| `status` / `tag` | — | `spawn` | 它们**压根没载编码器**（两个都在 `execute` 里提前 `return`），自己起一个只读 worker（textOnly ≈900 MB）才是正解；此时进程里也不存在「第二份 SigLIP2」的风险 |
| `install` | — | `busy` | 模型文件正在写，另起 worker 只会得到 `AI_MODEL_MISSING`，还会和下载器抢同一批文件 ⇒ 保持拒绝（**唯一的例外**） |

配套三条，缺一那句「不该影响搜图」就守不住：

1. **索引起手那几秒是「等我一下」不是「别搜」**：索引 worker 要 `loadEncoder`（≈2.1 s）之后才
   设 `activeEncoder`，这期间 relay 会被回 `AI_BUSY`。所以 `relayWithRetry()` 要**退避重试**
   （`RELAY_READY_ATTEMPTS` × `RELAY_READY_DELAY_MS`）。🔴 每轮重试**必须重看一次路由**：
   对端可能在等待期间收场，那时再投就是往尸体上投；路由一变就立刻改走 `spawn`。
2. **`relay()` 自带同一道门**（不许只信调用方）：对端已退出时立刻拒。
3. 🔴 **只有主任务能占 `this.worker` 这个槽**：`spawn()` 里那行赋值必须带 `primary` 门。
   并发只读的收场走的是「不写状态、不碰槽」那一条，若它也占槽，槽就永远指着一具尸体
   ⇒ **此后再也起不来索引**（`start()` / `run('index')` 一律 `AI_BUSY`，直到重启）。
   ⚠️ 这条与「不写任务状态」是**同一件事的两面**，改动时一起想。

**守护**：`scripts/semantic-regression.js`（路由表逐项、`status`/`tag`/已退出对端走 `spawn`、
`install` 仍拒、重试把「还没就位」变成成功、重试中途对端收场 ⇒ 只投一次并改走 `spawn`、
预算有界）+ `scripts/ai-lifecycle-regression.js`（真 `spawn` + 替身 worker：并发只读不得占槽、
槽清干净后仍能再起索引）。做过 4 条源码级注入（槽退回旧写法 / `readRoute` 退回「只有 index」
/ 去掉重试 / 去掉 `relay` 的已退出门），全部精确红在预期断言并逐字节还原。

⚠️ 别把它和下面那条混起来：`status` 作为**请求方**仍然串行（`concurrentReads` 里没有它），
所以索引进行中 `run('status')` 照样被拒 —— 那是**文档化的刻意行为**（见上一节「模型就绪状态」），
今天不打算改。这里改的是「`status` / `tag` 作为**占用方**时不许挡只读」。

## EP（执行提供器）与计时纪律

- **DirectML 随包可用**（`node_modules/onnxruntime-node/bin/napi-v6/win32/x64/DirectML.dll`），
  JoyTag 实测 **86 ms/张 vs CPU 811 ms/张 = 9.4×**；与 CPU **逐值一致**（余弦 1.000000、
  最大单标签差 0.00011、**入库线 0.15 与查询线 0.55 的跨线翻转都是 0**）。
- 🔴 **计时必须在「单 EP 进程」里做**：同进程先跑 CPU 再跑 dml 得到的是假的（差 5 倍）——
  ① dml 首次 `run()` 触发图编译，样本少就被放大；② 两个 ONNX 会话抢核心。
  ⇒ 探针分模式：`both` 只做一致性对比，`cpu` / `dml` 单 EP 才允许横比。
- ⚠️ 建 dml 会话会打 ORT 警告「Some nodes were not assigned to the preferred EP」——**正常**。
  ⚠️ **回退必须打 warn**：「dml 不可用」与「dml 可用但只快 N 倍」是两种结果，静默回落会让人以为跑的是 GPU。
  （产品侧那条回落的唯一落点是 `src/main/gpu-probe.js` —— 见下面「启动期 GPU 能力探测」。）
- 三条独立路径，**别混写法**：SigLIP2/CLIP 走 `@huggingface/transformers` 的 `device`（`embedding.js`）；
  人脸与 JoyTag 走直连 onnxruntime 的 `executionProviders`（`face-model.js` / tag 建索引器）。

### CLIP 那一半的实测结论（2026-10-07，探针 `.workbuddy/bench/probe-clip-ep.js`）
- **能建会话、能提速，但只有 1.99×**：全链 222 → 112 ms/张（40 张，含 sharp 预处理）。
  ⇒ 全库 1,656,548 张：CPU ≈4.3 天 → dml ≈2.1 天。**收益不足以改变结论**。
- 🔴 **数值不再逐值一致**（与 JoyTag 相反）：图像向量余弦 **0.9916**、单维最大差 **0.0264**、
  调整后分数最大 |Δ| **0.0092**（与地板 0.01 同量级）、top-20 集合重合 **17.1/20**。
  成因是 **q8 量化**：JoyTag 走 fp32（余弦 1.000000），CLIP 是 int8（`dtype:'q8'`），
  int8 GEMM 的累加顺序与 CPU 不同 ⇒ 误差 ~1e-2 且**不可忽略**。
- ⇒ **索引侧与查询侧的 EP 必须一致**。混搭（索引 dml + 检索 cpu）等于把两套数值口径缝在一起。
- ⚠️ 「命中数零变化 ✅」在这个探针里是**假绿**：40 张样本里所有查询的 top1 都低于地板 0.01，
  谁都没跨线 ⇒ 这一条**不构成证据**，别拿它当验收。
- 🔴 **「2 线程压低了 CPU 基线」这个假设被实测否定**：把 `intraOpNumThreads` 从 2 提到 8
  反而更慢（**249 vs 222 ms/张**）⇒ dml 那 2× 是真的，不是基线被人为压低。
  （所以 `DEFAULT_THREADS = 2` 不必为建索引单独放大。）

### 🔴 2026-10-08 复核：合趟之后「CLIP 换 dml」被稀释到 1.23×，M5 不立项

上表是 **CLIP-only** 探针（40 张，含 sharp，不含 JoyTag、不含写库）—— 它预测全库 CPU ≈4.3 天。
**2026-10-08 真库实测推翻了这个预测**：索引进行中接口自报 102 张/分钟、库 60 秒增量 106 张
（两条独立口径一致）⇒ **588 ms/张**，全库 164.2 万张 ≈ **11.2 天**，是预测的 **2.65×**。

差额就是合趟带来的（M3/M4 之后每张图要多做这些）。

🔴 **2026-10-08 深夜当场修正了下面这张表**（原表把 JoyTag 记成 178、把剩余 188 记成「写库」，
**两处都错**）。用 `.workbuddy/bench/probe-parallel.js` 逐路单量，两路之和**恰好复现**产品的 588：

| 成分 | ms/张（本次实量） | 依据 |
| --- | --- | --- |
| CLIP 一路：sharp 预处理 + 前向（cpu） | **191** | `probe-parallel.js a 24`（预处理仅 15） |
| JoyTag 一路：**自己从库里取图** + prep448 + 归一化 + 前向（**已是 dml**） | **396** | `probe-parallel.js b 24`（四段见下） |
| 写库 + 其余 | **≈1** | 差额。**不是 188** —— 原表把 JoyTag 的低估额错记到了这一格 |

JoyTag 那 396 的四段分解（`probe-parallel.js b3 24`，全部用产品自己的函数）：
`prepareSource 7` + `prep448 5` + `normalize 2` + **前向 ≈380** ms/张
⇒ **预处理合计只有 14 ms/张，96% 是 DML 前向**。所以「优化 JoyTag」只能动前向，
动取图/预处理是白费。⚠️ 而前向这个数**今天不可复现地漂**（见下），别当常数用。

⇒ **换 dml 只能省 110 ms/张**：588 → 478 = **1.23×**，整趟 11.2 → **9.1 天**。
而代价不变且不小：q8 数值口径变（余弦 0.9916）⇒ **整库重建** + **设备锁定 M5**
（索引与查询必须同 EP，混搭 = 两套数值口径缝在一起）。
**收益 1.23× 不足以付这笔代价 ⇒ 不做。**（「趁早换轨便宜」的论点只在收益够大时成立；
只有 8 千行时丢弃成本确实 ≈0，但换来的还是 9 天，等于白付一次重建。）

**真想压时长的方向（都属单独一轮）**：
① **两条路并行**（CLIP 在 CPU、JoyTag 在 dml）—— **2026-10-08 已实量、并已落地**，见下一节与
   「并行落地后的结构」一节。
② 查**写库**里有没有不必要的 fsync / 逐张 commit（WAL + `synchronous` 档位值得量一次）
   —— ⚠️ 注意上面已修正：写库**不是** 188 ms/张 那个大头，别按旧表去找。
③ 接受 11 天（进度逐张落库，重启后手动再点即可接着跑，不会白跑）。

### 🔴 2026-10-08：「CLIP(cpu) ∥ JoyTag(dml) 两条路并行」实测 —— 能并行，1.41×

探针 `.workbuddy/bench/probe-parallel.js`（`par` 模式；两个 `worker_threads`，各自建会话、
各自预热，**报到后再同时开跑**）。

**结论**：完全可以并行（重叠率 **100%**），每张成本从**串行 587** 降到 **并行的 416 ms/张**
（并行的临界路径 = JoyTag 那一路）⇒ **1.41×**，全库 11.2 → **8.0 天**。

⚠️ **但要付两笔账，所以收益没有「max(191,396)=396 ⇒ 1.48×」那么漂亮**：
- **CLIP 侧被拖慢 59%**（191 → 304）。本机 GPU 是 `AMD Radeon(TM) Graphics`（**核显**，
  `nvidia-smi` 连不上驱动，另挂 `GameViewer Virtual Display Adapter`）⇒ 核显与 CPU **抢同一份
  内存带宽**。「并行拿 max(a,b)」只在两条路用**不同资源**时成立。
- **`offer()` 的顺手红利没了**：tag 挪到另一个线程之后，CLIP 循环手上那份 512 内接 JPEG
  递不过去（跨线程要么拷贝要么重解码），tag 必须**自己从库里取图** = 上面那 396 已经是自取图口径
  （多付 7 ms/张，可忽略）。

**🔴 三条必须一起记下来的坑（前两条是我自己踩的）**：
1. **第一版探针量出的是「重叠率 12%、并行反而慢 22%」，那个结论是错的。** 真因是
   **DML 的图编译发生在首次 `run()`，实测 8.2 s**，它落在 JoyTag 侧「预热完」与「循环开始」之间，
   把计时窗口整体后推 ⇒ 两段窗口时间上错开，**看上去就像没并行**。
   修法 = 两侧预热完先报到、主线程等到齐再同时发令（`waitGo` 屏障）。**加了屏障重叠率就是 100%。**
   ⇒ 通用纪律：**跨线程计时窗口里只许有要比较的那一段**；会话创建 / 图编译 / GC / 消息往来
   都会把起跑点推开。任何「起跑点由被测代码自己决定」的计时都要怀疑。
2. **同进程摆两个 ONNX 会话，只有 `cpu + dml` 这一种组合能跑**：
   `CLIP ∥ CLIP` **直接失败**（`An error occurred during model execution: "Error: An exception is
   pending"`，`[1,3,224,224]`）；`JoyTag-DML ∥ JoyTag-DML` 能并发但**双双崩塌**
   （单次 b16 前向 ~0.3 s → **~24 s，30×**）；纯 JS ∥ 纯 JS、`sharp` ∥ `sharp` 都完全并行。
   ⇒ 别假设「线程分开就互不影响」。
3. 🔴 **本机的 DML 绝对读数不可复现**：同一天、同脚本、同批图，`batch` 逐档位**跨趟摆动 ±50%**
   （b1 227→346、b2 245→452、b16 414→363，连「最优档位」都从 b1 跳到 b4）。
   而 `bench/out/` 里存的旧读数（JoyTag **86 ms/张**、受控基准 b1 847 / b16 178）**一条都复现不出来**，
   **方向还是反的**（旧基准说 b16 比 b1 快 4.8×，今天 b16 一致更慢）。
   ⇒ **引用任何 ms/「X 倍」都必须带「何时、哪块 GPU、单 EP 单进程、有无屏障」四个前提**；
   做决定前在当前时刻重量一遍。核显尤其如此。

### 🔴 2026-10-08（深夜）：并行**已落地** —— 双 worker 结构与它的契约

**落地形态**（当晚实现，比评估时的预估还简单，因为「两路并行」让 `offer()` 整体退役）：

| 文件 | 角色 |
| --- | --- |
| `src/workers/semantic-worker.js` | CLIP(cpu) 主路：取批 → `prepare()` → `encoder.image()` → `store.put()`（**含 CLIP 词表标签**，纯点积）。**不再载 joytag、不再有 tag 跟踪代码**。仍是 relay 搜图的服务对象（文本编码器在它手里）。 |
| `src/workers/semantic-tag-worker.js`（新） | JoyTag(dml) 并行路：**自己的游标扫全库**（原 `drain()` 那台发动机），`hasPhoto()` 精确判重，进度只报 `tag*`。**不 require `../ai/embedding`** —— 本进程只有 joytag 一份 ORT。 |
| `src/main/semantic-search.js` | `spawn()` 在 `operation==='index' && primary` 时**同时起两个 worker**；两路收场用 `mergeIndexOutcomes`（纯函数，已导出）结算；`run()`/`start()`/`cancel()`/`dispose()` 把 `this.tagWorker` 当占用人看。 |

**为什么不再需要 `offer()` ∪ `drain()` 的并集**：那个并集是为「drain 排在 CLIP **之后**跑」服务的
（老库那趟 CLIP done=0，光靠 offer 会漏全库）。并行结构里 tag worker **从起跑就自己扫全库**，
覆盖面天然 = 全库，判重靠 `hasPhoto()` 精确去重 ⇒ CLIP 循环里的 offer/flush 调用点整体删除。
代价 = 「新库首建」每张图多解一次码（实测已计入 396/416 那两个数，7 ms/张）。

**写库不冲突**：CLIP 路只写 `semantic-index.sqlite`，tag 路只写 `tag-index.sqlite`（两个文件、
各自 WAL）；两边都只读 `photos`。relay 搜图不受影响（仍托给 CLIP worker）。

**结算规则（`mergeIndexOutcomes`，守护 ⑪ 喂 8 例）**：
① 双取消（或取消传播中一边先收场）= `AI_CANCELLED`；② **非取消的真错误优先于取消**——
一边真崩、另一边被联动取消时必须报真错，否则故障被「已取消」吞掉；③ **没发 done 信封就没了
= `AI_WORKER_EXIT`**（不许静默少一半）；④ 结果以 CLIP 路为主体、`tags` 只从 tag 路取。
一边失败（非取消）时**联动取消另一边**（`stopSibling`）—— 不然失败方要等另一边跑完几天才结算，
界面挂着冻结的进度条、错误不显示。

**🔴 面板语义（用户可见的变化，要有预期）**：
- 主行（进度条/ETA）= **CLIP 路**口径（done/total/速率）；tag 计数行 = JoyTag 路口径。
  两行**同时推进**（这正是并行的意义）。**临界路径在 JoyTag 那边** ⇒ 主行先到 100% 而任务
  仍在跑（tag 还没完），phase 仍是 indexing —— 这是「两套口径不许串」的正确呈现，不是 bug。
- 主行 ETA 按 CLIP 速率反推 ⇒ 在 CLIP 快于 JoyTag 的机器上**会偏乐观**；tag 行有自己的
  `tagDone/tagTotal` 供对账。要不要给 tag 路也配 ETA，等真出现「主行 100% 干等」的观感再议。

**🔴 取消/重启的安全性（落地前专门查过）**：
- `cancel()` 两路都发；`check()` 在两路各自的循环里抛 `AI_CANCELLED`。
- **已建向量/标签不丢**：`batch()` 候选谓词 `e.photo_id IS NULL OR e.model != ? OR …` 天然跳过
  已建行，tag 路靠 `hasPhoto()` 同理 ⇒ **重启后手动再点 = 从断点接着跑**。
- 重启的代价 = 按 id 倒序把「已建区间」重走一遍（每行一次点查）—— 当前 527 行是零头；
  越晚重启越贵（90% 时约 140 万次点查，分钟级），可接受。

**旧读数引用规矩不变**：上面 1.41× / 588 / 416 那些数字仍带四前提（何时 / 哪块 GPU / 单 EP
单进程 / 有无屏障）；核显机器上换一天重测可能不一样，**架构结论（能并行、offer 可退役）不依赖
绝对读数**。


### 人脸（第三条路径）的实测结论（2026-10-07，探针 `.workbuddy/bench/probe-face-ep.js`）
- **数值上完全等价、但一丁点收益都没有** ⇒ **不换**。
  - 等价性（fp32，与 JoyTag 同类）：逐脸 embedding 余弦 **最小 1.000000**、单分量最大差 0.000122、
    置信度最大差 0.00000、**逐张图片脸数 0/64 不同**、**同人/不同人判定 0/2016 对翻转**、
    配对 AUC 两边都是 **0.9999**（同人通过 99.6% / 不同人误判 2.0%）。
  - 速度：整链 **602 → 634 ms/张 = 0.95×（dml 反而慢 5%）**。全库 1,630,813 张图片 ≈11.4 天，
    换 EP 换不来任何东西。
- 🔴 **原因用微基准钉死了（`micro` 模式）**：纯前向 ——
  **YuNet 640：cpu 8.8 ms vs dml 18.1 ms（dml 慢 2 倍）**；w600k 112：cpu 10.0 ms vs dml **3.0 ms**。
  按每张图片（1 次粗检 + 1 次局部复核 + 1 次识别）算，前向合计 **27.6 → 39.2 ms**，
  而整链是 602 ms ⇒ **模型前向只占 4.6%**，其余 95% 是 sharp 算子与 JS 对齐：
  `detect()` 里有 **4 处 sharp**（解码压 1600 / 画布 letterbox / 区域 extract / 脸缩略图 jpeg）
  + 一次纯 JS 双线性 warp，其中「解码 + 压到 1600」一项就 173 ms（29%）。
  ⇒ **小模型（YuNet）换 DML 是负收益**：每节点设备往返的开销盖过算力收益。
- ⚠️ **取样坑（比结论更值钱）**：第一版拿 `.workbuddy/bench/rows.json` 取样，18 张里检出 **0 张脸**
  （那批图包多是不露脸题材）——对比毫无意义。改用产品自己的 `face-index/faces.sqlite`
  （`scans` 246,040 / `faces` 81,043）取候选，并**优先取「恰好 1 张脸」的图片**：
  第一版优先取脸多的图片，同目录里常是多人合影 ⇒ 「同目录 = 同人」的 ground truth 被弄脏，
  直接得到同人通过率 17.9% / AUC 0.544（同一模型在干净样本上是 99.6% / 0.9999）。
  **那不是模型差，是标签被取样弄脏了。**
- ⚠️ 样本里 4/64 张因 **`Input image exceeds pixel limit`**（>1 亿像素）被 sharp 拒掉 ——
  产品侧有同一个 `limitInputPixels: 100000000`，走的是「回落缩略图」那条路（见 `face-worker.js`）。
- ⇒ 人脸索引要提速，该动的是**反复对 1600 中间图的 sharp 往返**，不是 EP。

### 🔴 通用规律：GPU 的收益只在「单进程连跑很多次」时拿得到
换 EP / 换解码器都要**初始化设备上下文**，这笔钱是**每进程一次**的固定开销。凡是我们
「每张图 / 每个视频起一个进程」的地方，GPU 都会被它吃光：
- 实测 **每次 spawn `ffmpeg.exe` 的固定开销 ≈349 ms**（空跑 `-version`，5 次平均）——
  这一条就注定了「逐张起 ffmpeg」的管线必输。
- JoyTag（单进程连跑 1,500 张）**9.4×** ✓；CLIP（单进程，但被预处理摊薄）**2×** △；
  缩略图（逐张 spawn）**0.06–0.10×** ✗；视频首帧（逐个 spawn）**0.66×** ✗。
- 🔴 **第二条同样重要：还要看「模型前向占整链的比例」** —— 两条是**相乘**的。
  人脸明明是单进程连跑，却只有 **0.95×**，因为**前向只占整链 4.6%**；
  就算把前向优化到 0，整链也只快 4.6%。反过来说：比例低的任务，**别在 EP 上花时间**。
- 🔴 **小模型换 DML 可能是负收益**：YuNet 640 在 dml 上 **18.1 ms vs cpu 8.8 ms（慢 2 倍）**，
  每节点的设备往返开销盖过算力收益（w600k 112 则快 3.3×）。
  ⇒ 判断顺序固定为：**① 前向占整链比例 → ② 是不是单进程连跑 → ③ 模型够不够大**。

### 缩略图能不能吃 GPU（2026-10-07，探针 `.workbuddy/bench/probe-thumb-gpu.js`）
- **静态图：入口根本不存在**。随包 `@img/sharp-win32-x64/lib/libvips-42.dll` **不导入
  `OpenCL.dll`**（`clGetPlatformIDs` / `clCreateContext` / `clEnqueueNDRangeKernel` 命中数
  全为 0，导入表里也没有 `OpenCL.dll`）⇒ sharp/libvips 没有 GPU 后端，**没有开关可拨**。
- 想上 GPU 只能换栈（ffmpeg `mjpeg_cuvid` + `scale_cuda` + `libwebp`），实测结果：
  **libvips 41.6 ms/张 vs ffmpeg 全 CPU 420.3 ms/张 vs GPU 解码 747.3 ms/张** ⇒
  **比现状慢 10–18 倍**。原因是「编码那一段没有 GPU 版本」（ffmpeg 里没有 nvJPEG）+
  逐张 spawn 的 349 ms 固定开销。
- 🔴 **即使不换栈也得看产物**：同一张 1440×1831，`scale_cuda` 路给 **402×512**、
  `scale` 路给 **403×512** ⇒ **连尺寸都可能差 1 像素**；24 张里有 5–7 张尺寸不同，
  同尺寸的像素平均绝对差 2.1–2.3/255。**换引擎 = 用户看得见的画幅变化**。
- 🔴 缩略图缓存键只含 `photoCacheVersion + thumb_size + thumb_format`（**不含引擎**）⇒
  真要换引擎必须**升 `photoCacheVersion` 并走 `thumb_regen_queue` 全量重跑**，否则新旧混存。
- **视频首帧：入口存在但没收益**。随包 ffmpeg 确实带 `cuda / dxva2 / qsv / d3d11va`、
  `*_cuvid`、`scale_cuda` / `thumbnail_cuda`、`libwebp`，但实测 `-hwaccel cuda` **986 ms/个**
  **慢于**现状 CPU 的 651 ms/个（`h264_cuvid` 更是只成功 1/6）⇒ 每个视频一次 CUDA 上下文
  初始化的钱收不回来。要动它得先改成**一个进程批量处理**，那是架构改动，不是加参数。
- ⇒ **结论：缩略图这条线不动**。若要提速，先解决真正的瓶颈 —— 源盘冷读（见下）。

### ⚠️ 缩略图真正的瓶颈是 IO，不是算力（同一天实测）
素材在 `K:\COS`（13 TB、99% 已满的本地大盘）：**冷读 0.4 MB 要 ≈72 ms**（≈6 MB/s），
同一条路径再读只要 **0.20 ms**。而 sharp 的「解码 + 缩放 + webp」**只要 36–42 ms/张**
（预热缓存后）。⇒ 第一版探针量出的「libvips 1287 ms/张」是**冷 IO 被摊进单张**的假读数。
换句话说：**缩略图优化该往「缓存 / 预读 / 别重复读盘」走，而不是往 GPU 走。**

### `loadEncoder` 的两个出口（默认值都没变）
- `device`（默认 `DEFAULT_DEVICE = 'cpu'`）：`'dml'` 直通 `@huggingface/transformers`。
  ⚠️ **win32 上 transformers.js 无条件把 `dml` 列进 supportedDevices**（`deviceToExecutionProviders`），
  所以「参数通过校验」不代表这台机器能跑 —— **建会话成功才是唯一判据**，失败必须 warn + 回落 cpu。
- `threads`（默认 `DEFAULT_THREADS = 2`）：只为「索引在跑时还要 relay 服务搜索」而定，
  **不属于顺手调参**。实测提到 8 对 CLIP 无收益（见上）。
- 这两个出口目前**只有探针在用**；产品侧调用点（`semantic-worker.js`）传的还是默认值 ⇒ **行为零变更**。

### 启动期 GPU 能力探测（2026-10-07 落地到产品侧）

落点两个文件：`src/main/gpu-probe.js`（判据 + **唯一记录处**）、
`src/workers/gpu-probe-worker.js`（真跑的那一半）。

🔴 **判据只有一条**：建一个 `executionProviders: ['dml']` 的会话，**并且跑出正确数值**。
三条更省事的路都是假的：

- `process.platform === 'win32'` —— 无 DX12 设备 / 驱动太老 / 虚拟机里照样是 win32；
- `onnxruntime-node#listSupportedBackends()` —— 它返回的是**编译进包**的 EP 列表
  （来自原生绑定的 `GetAvailableProviders()`），答不了「本机能不能创建设备」：
  本机实测它连 `webgpu` 都列出来，而工程里没有任何代码路径用 webgpu、也从未验证它可用；
- `DirectML.dll` 在不在包里 —— 在也不代表能创建设备。

**探测模型** `src/ai/ep-probe.onnx`（168 B、单 `Conv` 节点、`float32[1,1,8,8] ⊛ [1,1,3,3]`）：

- 挑 `Conv` 是因为它是 DML **必然实现**的算子。换成 `Identity` 这类，一个 DML 不支持的图
  也会**建会话成功**然后把节点静默回退 CPU ⇒ 探测变成假阳性。
- 生成器 `scripts/ep-probe-model.js`（手写 protobuf，零依赖，Node 可直接跑；`--check` 只比对不写盘）。
  🔴 **守护每次都重新生成一遍并与磁盘文件逐字节比对** —— 模型不是「一个碰巧在包里的二进制」：
  改了生成器忘重新生成、或有人手工替换 `.onnx`，都当场变红（手工替换没有任何别的守护抓得到）。
  （生成器刻意放 `scripts/` 而**不是** `.workbuddy/bench/`：后者不进版本库，放那里等于丢掉可复算性。）
  ⚠️ 字段号以 `onnx.proto` 为准：`ModelProto.opset_import = 8`（**不是** 2）、
  `TensorProto.name = 8`（**不是** 5）。写错时 ORT 报的是「Missing opset in the model」
  这种**指向别处**的错，很费时间。
- 必须**读成 Buffer 再喂 ORT**：文件会被打进 asar，而 ORT 的 C++ 层用 `std::ifstream` 读路径，
  看不见 asar 虚拟文件系统（Electron 只给 Node 的 `fs` 打了补丁）。
- 建完会话还要 `run()` 一次 —— DML 的图编译发生在**首次 `run()`**，不是建会话时。
  喂常数输入（全 0.5）+ 全 1 卷积核 ⇒ 每个输出分量必须正好 **4.5**；`verified === false`
  一票否决「可用」。

🔴 **必须离开主线程**：`onnxruntime-node/dist/backend.js#createInferenceSessionHandler` 把
`new OnnxruntimeSessionHandler(...)` 放在 **`setImmediate`** 里 —— `setImmediate` 是
**本线程的下一个 tick**，不是线程池，所以 `loadModel`（含 D3D12 设备初始化）**同步阻塞主线程**。
实测本机用 dml 建这个小模型要 **约 2.0 s**（cpu 只要 153 ms；第二次 1.3–2.2 s 之间波动）
⇒ 放主进程就是开机白冻 2 秒（本工程拿 `eventLoop.maxDelayMs` 盯这个）。
**「async 的 API」不等于「不占主线程」**，这一条对 ORT 的所有 `create` / `run` 都成立。

⚠️ 失败**不需要**等超时：EP 不存在时 ORT **1 ms 内**就抛
`no available backend found. ERR: [dml] backend not found.`（本机实测，cuda / tensorrt 同样）。
60 s 的超时只对付「驱动把设备创建挂死」这一种情形。

**接线与时机**：`schedulePostWindowDeferredTasks()` 里 **+6 s** 点火。
不放进首屏（没有任何界面元素等它，早跑只会和扫库 / 缩略图 / 目录树抢 CPU 与磁盘），
也不推迟到「用户点建索引」那一刻（它是**准入信息**，不该摊进任务启动耗时里）。

🔴 **点火块里只有「null 守卫 + `ensure()`」两条语句，不许有「AI 忙就跳过」**。
本版最初写的是「AI 任务在跑则整轮跳过并打日志」，但那样这一轮**没有结论**：
首次启动时设置页那一行会永远停在「检测中…」（用户会一直等），非首次启动则拿着上次的落盘值
补一句「本次正在重测」（**而本次根本没探**）。**界面是这功能存在的唯一理由**（生产档 logger 是
`warn`、用户不会翻日志），所以不能说假话 —— 而这 2.4 s 省下的也不值得：探测在**独立 worker**
里跑一个 168 B 卷积，且当前**所有 AI 任务都跑 CPU**（换 EP 属 M5），并不存在「两个 DML 设备抢」这件事。
⚠️ 将来若真有任务用上 dml 且实测这 2 s 会打扰它，**也不许**改回静默跳过 ——
要么挪时机，要么给「本次未探测」一个独立的、界面显示得出来的状态。
这条形状由守护按 **AST 的语句条数**钉住（正则匹配不到「多了一个 `if`」；见 `gpu-probe-regression` 第 5 条）。

**结论的去处**：`<userData>/ai-search/gpu.json`（跨进程读得到的唯一一份），
并挂在 `SemanticSearch#status()` 的 `gpu` 字段上 ⇒ 桌面端 IPC 与内嵌网页 API
**一次挂上、两处一致**，不必各自再读一遍文件（读两次迟早漂）。
界面在「设置 → AI 与索引 → 搜图索引」多一行「硬件加速：…」。三种取值必须可区分：
`gpu == null` = **还没探完**（显示「检测中…」）、`stale: true` = **上次启动的结论**（本次正在重测）、
否则是本次实测。失败原因（ORT 英文原文）只挂 `title`，正文保持一句中文。

⚠️ **这一版刻意只做「探测 + 可见」，不改任何任务的 EP**：CLIP 的 dml 数值不一致
（余弦 0.9916，见上），换 EP 等于换一套数值口径；而库里已有 7,374 行是 CPU 编码的 ——
**混编会按行随机偏置分数**，而阈值标定到 0.01、top-20 只有 17.1/20 重合。
⇒ 「让索引真的用上 dml」必须与**索引清单里的设备锁定**一起做：设备在清单创建时定死、
索引与检索读同一份、要改就得整体重建。那属于 M5 全库那一趟的事。

守护 `scripts/gpu-probe-regression.js`（39 项）：回落必须 warn（且不许用 `log` 冒充）、
`provider` 取值域白名单（脏值 `'cuda'` 必须被归一成 `cpu`）、`verified === false` 一票否决、
`ok === false` 一票否决、**成功态不许 warn**、只探一次（失败路径也只探一次）、落盘 / 读回带 `stale`、
坏 JSON 与缺文件都回 `null`、**点火块的语句条数**、**结论真的到得了 `status()`**（见下），
以及「不许用 platform / `listSupportedBackends` 推断」「主进程不许 `require('onnxruntime-node')`」
「worker 必须 `executionProviders: ['dml']` + 必须 `.run(`」「模型必须 `readFileSync` 成 Buffer」
「worker 里不许再写一份 `gpu.json`」「两处期望数值同源」等结构断言（一律走 acorn 剥注释后匹配）。

🔴 「结论真的到得了 `status()`」这一组（钩子给了要带出来、钩子炸了要吞掉、没钩子不许凭空造字段）
**必须有**，因为这一处**真的烂过**：`main.js` 里同时写了 `semanticSearch.gpuInfo = gpuInfo;` 与
`faceService.gpuInfo = gpuInfo;`，而 `face-service.js#status()` 从不读 `this.gpuInfo` —— 那是
**无人消费的死接线**（读源码的人会以为人脸那条状态里带着 GPU 结论）。这类「后端算了、界面永远看不到」
穿过 `status()` → IPC / 内嵌 API → 渲染层四层，中间任何一层漏字段都被静默丢掉，不报错、不写日志，
静态断言全绿。所以现在：人脸服务**不挂**（人脸面板没有这一行；哪天要有，挂上和渲染一起加），
守护按 `!faceService.gpuInfo =` 钉住；而搜图那条用**真类**造替身（`Object.create(prototype)`，
不碰库不碰 worker）验三态传播。

🔴 两条**行为**断言是这轮加固出来的，别当形式主义：
① **`spawn` 抛错必须被 `ensure()` 收口**（调用端是 `void gpuProbe.ensure()`，一个 reject 只会换来
一条没人看的 unhandledRejection，而结论却是「没有结论」⇒ 探测失败必须落成一条「回落 + warn」）；
② **模型与生成器逐字节一致**（每次重新生成 `scripts/ep-probe-model.js` 再与磁盘上的 `.onnx` 比对）。
第二条同时挡住「有人手工替换了 `.onnx`」—— 那种改动没有任何其它守护抓得到，
而模型一旦不是「由仓内脚本生成」，它就退化成一个碰巧躺在包里的二进制。

## FTS 中文（🔴 已迁回 MEMORY.md 作红线，此处留判据细节）

- `photos_fts` 用 `tokenize='unicode61'` ⇒ **中文子串恒 0 命中**。
  实测：`"比基尼"*` → 0、`"蛋糕"*` → 0；token 实际是 `093dva比基尼`。
- `database.js#_buildFtsQuery` 造的就是 `"词"*` 这种**前缀查询** ⇒ 与 token 粒度不匹配。
- `searchFolders` 与 `nameOnly` 走 **LIKE** ⇒ 不受影响
  （所以「搜图页关键词档中文正常、浏览 / 搜索页那条 FTS 路是坏的」—— 坏的不是一处）。
- trigram 能救多数情况，但 **<3 字词仍然失效**（「蛋糕」2 字仍 0）。
