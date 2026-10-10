# 后台任务：统一设计规范

> 2026-10-08 立。起因：用户问「搜图和人脸检查是否同样有后台任务显示及进度数量」——
> 顺手一盘，发现**同一件事有三套写法**：运行判据有 3 个字段名、百分比在 5 处各算一遍、
> 元素 id 有 7 种前缀、估算分母有两种表达（`phase` 三态 vs `totalEstimated` 布尔）。
> 本文件是**新增 / 修改一个后台任务时必须逐条对照的清单**；现有任务的合规情况见 §11
> （**A / B / C / D / E / F / G / H 八项待办全部已落地**，逐项证据见 §11.1）。
>
> 与其它契约的关系：进度口径的**具体任务细节**归 `thumbnail-backfill.md` / `semantic-search.md`；
> 本文件只管**跨任务的一致性**（形状、命名、判据、文案）。两者冲突时以本文件为准。

## 0. 什么算「后台任务」

三条同时成立才算：

1. 会连续跑 **≥ 数十秒**（不是一次请求 / 响应）；
2. 有**可观测的进展**（数量或阶段，不是一个转圈）；
3. 用户**可以中断**，或者必须能说清楚为什么不能。

⇒ **反例（不要加进面板）**：搜图 / 预选词生成（一次查询，秒级）；`maintenance`（上次维护的**结果**）、
`interaction`（抢占状态）、`writeQueue`（队列快照）—— 后三个是**诊断数据**，虽与任务共用同一个
`get-background-tasks` 返回对象，但**不是任务**。

## 1. 状态对象契约（唯一形状）

主进程对每个任务报一个对象，**至少**具备下列字段。字段名不是建议、是契约：

| 字段 | 类型 | 语义 | 谁能缺 |
|---|---|---|---|
| `running` | boolean | **唯一**「正在跑」判据（见 §4） | 不可缺 |
| `phase` | string | 阶段；`'stopping'` = 已请求停止但还没停干净 | 不可缺（单阶段任务给常量） |
| `total` | number | 分母；**`0` = 未知**（不是「没有工作」） | 不可缺 |
| `totalEstimated` | boolean | 分母是否**抽样估算**（true ⇒ 界面必须写「约」） | 只有确实精确时可省 |
| `countPhase` | `'counting'\|'ready'\|'failed'\|null` | 分母**算到哪一步**（见 §3.1.4）；`null` = 该阶段的分母不经估算 | 只有确实精确时可省 |
| `done` | number | 分子（已处理量） | 不可缺 |
| `currentFile` | string | 正在处理的对象（可空） | 可缺 |
| `failed` | number | 失败数 | 可缺（缺 = 界面不画那一项） |
| `skipped` | number | 跳过数 | 可缺 |
| `etaSeconds` | number \| null | 剩余秒数；`null` = 不可估 | 可缺（见 §7） |
| `ratePerMinute` | number | 速率（无确定分母时**替代** ETA，见 §7） | 可缺 |
| `startedAt` | number | 本次起跑的起点（ETA 与「本次口径」都靠它） | 可缺 |

### 1.1 三个「唯一」

- 🔴 **「在跑」只能叫 `running`。** 曾经有 `face.busy` / `semantic.busy` / `optimizing`（布尔）
  三种写法，新代码不许再增第四种。
  ✅ 2026-10-08 已落地（待办 C）：`busy` → `running`（产品代码 11 个文件 36 处 + 桌面渲染端 +
  网页端 25 处 + worker 上报边界）；`optimizing` 那个**裸布尔**改成对象 `optimize: { running }`
  —— 它是 9 个任务里唯一没有状态对象的，所以「在跑」字段名在它身上与别处不同名，
  渲染端还得为它单写一个特例分支（特例分支正是漂移源）。改完 9 个显隐判据形状一致。
  ⚠️ **别顺手去改 `main.js#optimizeTaskRunning` 或渲染端的 `_dupHashProgressRunning`** ——
  那是**局部标志变量名**，不是状态字段（字段是 `optimize.running`）；改它们只增 churn、不动契约。
- 🔴 **分子只能叫 `done`。** 人脸 / 搜图曾经叫 `processed`（界面要写两套取值代码）。
  ✅ 2026-10-08 已落地（待办 C）：`processed` → `done`。
  ⚠️ **worker 内部**的累加器仍叫 `processed` —— 它数的是「已处理的行数」而非「产出」，
  只在**上报边界**映射成 `done: processed`（映射点显式可见，比偷偷改名安全）。
  ⚠️ `semantic-search.js` 里另有一个 `message.done`（**信封**上的布尔：worker 干完了）
  与结果里的 `done`（**数目**：本轮已处理行数）**同名两义**，两处都已在就地点明，别混。
- 🔴 **百分比不落状态？—— 前半条已被推翻，后半条才是重点。**
  规范原文写的是「百分比不落状态」，落地时发现**正确的形状恰恰相反**：项目里本来就有
  `thumbs.pct` / `thumbRebuild.pct`（补全与重建），而**扫描 / 清理 / 查重 / 人脸 / 搜图 5 个任务
  全在渲染端各算一遍**（全文件 6 个计算点，扫描自己占 2 个），且 `total = 0` 时行为不一致 ——
  清理那节画 **100%**，其余画 **0%**。
  ⇒ 定稿口径：**百分比由主进程派生、作为状态字段下发**（唯一来源 `src/main/progress-pct.js#computePct`，
  夹 `[0,100]`、未知分母一律 0），渲染端**只读不算**。
  ✅ 2026-10-08 已落地（待办 B）：4 处主进程派生 + 4 处渲染端改读，
  并由 `background-tasks-panel-regression` 用「`pct: 42` 而 `done/total = 10/100` 必须显示 42%」正面钉住。
  ⚠️ **「落不落状态」这条别再按字面抄** —— 判据要落在「**谁算**」上：算的地方唯一、读的地方随便。

## 2. 起手重置：新字段必须同时进三个地方

任务起手时的重置块在本项目是**逐字段列出来的**（不是「清空后重建」），因此新增字段要同时改：
① 状态初始化；② 起手重置块；③ 进度白名单 / IPC 透传。

🔴 **漏掉 ② 的后果是静默的**：上一轮的字段**跨任务活下来**，不报错，只是数字失去意义。
实例（2026-10-08）：AI 索引起手没重置 `total` ⇒ 上一轮那个百万级分母会被 `tag` / 搜索继续用，
界面永远显示接近 0% 的百分比。

🔴 **`total` / `totalEstimated` / `countPhase` 必须三个一起重置** —— 它们是同一件事的三个维度。
只重置 `total` 会让布尔跟着上一轮走；漏掉 `countPhase` 更隐蔽：上一轮 `index` 留下的 `'failed'`
会挂到下一轮 `tag` 上 ⇒ 界面**对着一个刚刚精确数出来的 `COUNT` 说「总数估计失败」**，而且不报错。
（这块是逐字段列的；`preserveProgress` 分支只**跳过**那一段，不写 = 继承。）

## 3. 分母：三种来源，界面必须能区分

| 来源 | 判据 | 示例 | 界面 |
|---|---|---|---|
| **精确** | 一次 `COUNT` 能在可接受时间内出结果 | `tag` 阶段（`pendingTagsCount` 纯 COUNT）、重建（全库登记数） | `done / total（pct%）` |
| **估算** | 谓词**无索引可依** + 跨库 JOIN ⇒ `COUNT` 实测几十秒 | 缩略图补全（候选集）、AI 索引候选集 | `done / **约** total（pct%）` |
| **未知** | 游标推进、规模不预先已知 | —— | 不画百分比，改说「已处理 N」 |

### 3.1 估算的四条硬规矩

1. **必须标 `totalEstimated: true`**，界面必须写「约」/`~`。把估算当精确显示，
   用户会拿它去核对行数、然后得出「进度算错了」。
2. **分母与候选集必须逐字同源**：估算的谓词与真正取批的谓词抽成**一个共享常量**
   （`index-store.js` / `face-store.js` 的 `CANDIDATE_PRED` 就是样板）。漂开 = 百分比与真实工作量脱钩，
   而且不会报错。
3. **估算必须能失败而不弄死任务**：包独立 `try/catch`，失败降级成 `total = 0`
   （界面按「未知」态画）。**一个只给用户看的分母，不该弄死要跑几十小时的任务。**
4. **估算进行中 / 失败要有专门的态**。曾经是两套表达：
   - 补全：`phase ∈ {counting, failed, ready}` + 文案（`task.thumbCountCounting` / `thumbCountNoTotal`）
   - AI：只有一个 `totalEstimated` 布尔
   ⇒ **规范取补全那套**（它区分了「还在估」与「估失败」，AI 那套区分不了）。
   ✅ 2026-10-08 已落地（待办 C）：AI 两节新增 `countPhase`（§1 表），**值域与语义与补全同一套**。
   - 🔴 **三态与 `totalEstimated` 是两个正交维度，不许合成一个字段**：前者说「分母算到哪一步」，
     后者说「这个分母是抽样估的、还是精确数的」。合成后 `totalEstimated` 在「估成功」与「估失败」
     两种情况下**取值相同**（都是 `true`）⇒ 零信息量 —— 这正是收敛前界面区分不了的原因。
   - 🔴 **必须先报 `'counting'` 再去做估算**。`estimatePendingCount()` 是 2000 次跨库点查，
     不是瞬时的；顺序反了的话估算那段时间界面读到 `done = 0 / total = 0`，还是画成「完成 0」，
     与「估失败」不可区分 ⇒ 三态白加。（补全就是这么修的：`main.js` 先置 `'counting'` 再统计。）
     ⚠️ 这条**位置关系**由 `face-task-regression` 钉着：两个 worker 里
     `countPhase = 'counting'` 必须出现在 `store.estimatePendingCount()` **之前**。
   - ⚠️ 三种态对用户的含义不同，文案必须分开：`'counting'` **会自己过去**；`'failed'`
     **永远不会好**（要明说百分比不来了）；`'ready'` + `total = 0` 是「估出来就是 0」——
     第三种**不许**说成失败。补全那边只有两态会把它误标成「估计失败」，AI 这边用三态分岔避开了。
   - ⚠️ **字段名没有统一**（这是已知的、刻意的差异）：补全叫 `phase`、AI 叫 `countPhase`。
     原因是 AI 的 `phase` 已经被**任务阶段**（`idle/install/index/indexing/downloading/stopping`）
     占用了 —— 同一对象上两个正交的「阶段」，同名会直接撞车。而把补全的 `phase` 也改成
     `countPhase` 要动 ~18 处 + 6 条钉住它的断言，且那个标识符**已经改过一次名**
     （`thumbPhase` → `pendingPhase`，守护专门钉着旧名消失）⇒ 第三次改名只增 churn 与风险，
     换不来任何行为差异。**要统一的是值域与语义，这两样已经统一了。**

### 3.2 分母是起始快照 ⇒ 消费端要夹

扫描会持续往库里塞新图片，分子可能反超分母。**把分母抬到分子**（`denom = Math.max(total, done)`），
不要把分子压下来 —— 分子是「真的做了多少」，压它等于少报工作量。（补全 / 重建 / AI 三处都这么夹。）

## 4. 显隐判据：进面板的唯一通道

```
showPanel = showScanBlock || showThumb || showThumbRebuild || showInvalidCleanup
          || showOpt || showDupHash || showFace || showSemantic;
```

🔴 **新增一个任务，必须在这一行里加一项**，否则它单独跑时**整块面板消失**（不是那一节隐藏 —— 是连标题一起没）。

🔴 **判据要落在「这是不是一个长任务」上，不是「有没有活动」**：
- 反例（已踩）：`phase` 里有 `'loading'`，搜索 / 预选词也会经过它 ⇒ 按 `phase` 放行会把「正在搜图」显示成后台任务。
  所以搜图那节判 `operation`（`install` / `index` / `tag`），不判 `phase`。
- 反例（已踩两次）：**新加一条进度列却没有进或链 / 没有进取值域** ⇒ 缺陷要等到「只剩它自己跑」才暴露，
  而它那时往往已经跑了很久。第 27 轮（缩略图重建）、2026-10-08（`tag` 倒排）都是这个形状。

🔴 **或链的代价**：两条进度列里只要有一条在跑，另一条坏了就看不出来。⇒ 新增任务时**必须单独验一遍
「只有它在跑」**的显隐（守护要覆盖这个 case，不能只测「多任务同时跑」）。

### 4.1 副指标：**什么时候该把 `0` 画出来**（2026-10-08 修订）

副指标（「顺手产出」那一串 `原图尺寸 +N` / `拍摄信息 +N` / `视觉指纹 +N` / `查重指纹 +N`）的判据
**在两个任务里刻意不同**，因为它们的**候选集不同** —— 同一个判据在两边不是同一件事：

| 任务 | 准入谓词 | 候选行天然缺四样吗 | 判据 |
|---|---|---|---|
| 缩略图**补全** | **缺**缩略图 | 是 | `(thumbs.X \|\| 0) > 0`（0 只可能是故障） |
| 缩略图**重建** | **有**缩略图、只是规格旧 | **否** | `if (!rEnqueueing)` —— **进抽干阶段就一律画，`+0` 也画** |

🔴 **为什么重建这边必须画 `0`**（2026-10-08 用户报「重建缩微图，没有看到其他四项计数」）：

重建收的是「**有**缩略图但 `thumb_size`/`thumb_format` 与目标不符」的行，而这四样元数据是
**补全**（同样走主键倒序）先补的 ⇒ **两个反序任务在同一段高位 id 碰头**：补全先补过的高位段
（最近入库的图片），重建跟着重跑同一段时四样本来就齐。

真库实测（2026-10-08，队列 1,656,548 行，`signature=512|webp`），沿队列从队首打剖面：

| 已抽干 | id 范围 | 每 3000 行里缺四样 |
|---|---|---|
| 0 / 100k / 200k | 1.30M–1.50M | **1 ~ 14 行** |
| 300k 起 | ≤ 1.20M | **3000 行（全缺）** |
| 900k / 1100k | 0.40M–0.60M | 尺寸 12~20 · **EXIF 3000** · dHash 12~23 |

⇒ 游标停在 id ≳ 1.2M 那一段时，四项恒为 0 而按老判据**一个都不画** ⇒ 用户看到副行上什么统计都没有，
**分不清「这段无事可做」与「统计坏了」**。⇒ 改成一律画：`+0` 是「本段没得补」这个**事实**。

⚠️ **不许退回** `(thumbRebuild.X || 0) > 0`（守护有反向断言）。补全那一节保持 `> 0` 不变 ——
「显示 `+0` 比不显示更像故障」那条理由在**补全**那边成立（它的 0 只可能是故障），在重建这边恰好相反。

⚠️ **来源字段拼错在这一版更难发现**：判据是无条件画，把 `sized` 拼成 `sizd` 只让那一项永远显示
`+0`，而 `+0` 现在是**合法值** ⇒ 肉眼与「本段没得补」无从区分。⇒ 四项收在一张表（`var rFour`）里
**逐个断言绑定正确**，并且断言这张表**真的被遍历**（只定义不遍历 = 静默空白，本项目老症状）。

⚠️ **登记阶段仍不画**（`phase === 'enqueueing'`）：那时一张都还没重跑，四项的概念不适用
（与「登记阶段不给 ETA」同理 —— 那时 `done` 是 0，报出来的是假数）。

### 4.2 副行（`Detail`）只管一件事：说**产出**（2026-10-08 收敛）

每节的行职责统一成四层，**同名字段说同一件事**：

| 行 | 元素 | 说什么 | **不**说什么 |
|---|---|---|---|
| 计数 | `*Count` | 主口径的分子 / 分母（含 `pct`） | 产出明细 |
| 进度条 | `*Fill` / `*Progress` | 主口径的百分比 | 明细 |
| **副行** | `*Detail` | **产出明细**（这趟做成了什么） | 正在处理哪个 |
| 文件行 | `*File` | **正在处理哪个**（路径 / 文件名） | 产出 |
| 指纹行 | `*Hash` | 当前对象的**明文子串**（查重专用） | 产出 |

收敛前四节四种形状（本轮盘「每种任务显示什么」时摆在一起才看出来）：

- 补全 / 重建：用专用 `*Detail` ⇒ **对**，本轮不动；
- 查重：拿 `*Hash`（明文编号）当第二行、**根本没有 `Detail`** ⇒ 主进程一直在报的
  `hashed` / `reused` / `failed` **界面从来没显示过** —— 分子 `done` 只说「处理了多少行」，
  看不出其中多少是真算的、多少是复用现成指纹的（两条路径耗时完全不同）。本轮补 `*Detail`；
- 无效清理：把摘要（`· 已删除 N 条`）**拼在 `*File` 尾巴上** ⇒ 同一行背两种语义，
  且 `total = 0` 那段时间同一个数在**计数行与文件行各出现一次**。本轮把摘要移进 `*Detail`，
  计数行同时收敛成「只报已检查 N」（有分母时才报 `checked / total`）；
- AI 两节：没有副行 —— 它们的产出（`done` / `failed` / `skipped`）都并进了 `*Count`，
  这是**可接受**的差异（那两节的主口径本身就是「处理量」，拆两行反而重复）。
  ⚠️ 所以「统一」不等于「每节都要有个 `Detail`」：**职责边界**统一即可，行数不必一致。

⚠️ 判据随**候选集**走（同 §4.1）：查重的 `hashed` / `reused` 用 `> 0`（候选集里
「必须现算」与「可复用」必居其一，起步那阵子才是 0）；重建那四项**一律画**（含 `+0`）。

## 5. 命名规范

| 对象 | 规范 | 现状 |
|---|---|---|
| section id | `task<Name>Section` | ✅ 8 节全合规 |
| 元素 id | `task<Name><Part>` | ✅ 已统一（2026-10-08，52 个元素 —— 本轮补了 `taskDupHashDetail` / `taskInvalidCleanupDetail`） |
| 停止 / 暂停 / 取消 | `task<Name>Stop` / `task<Name>Pause` / `task<Name>Cancel` | ✅ 已统一 |

**`Part` 词表**（新代码从里面挑；要第 16 个时**先加进这里**再写代码，别就地发明）：
`Title` / `Count` / `Fill` / `Detail` / `Eta` / `File` / `Progress` / `Hash` / `Rate` /
`Stop` / `Pause` / `Cancel` / `Settings` / `Error` / `Text`

已废弃的 7 种前缀（**代码里不许再出现**，历史只留在 `CHANGELOG.md`）：
`thumbProgress*`、`thumbRebuildTask*`、`invalidCleanupProgress*`、`dupHashProgress*`、
`optimizeTask*`、`faceTask*`、`semanticTask*`；
外加扫描节那 7 个**裸 id**（`progressText` / `progressCount` / `progressFill` / `progressFile` /
`scanProgressEta` / `pauseResumeScanBtn` / `cancelScanBtn`）。

⚠️ **盘点方法本身就是个坑**：那 7 个裸 id 不在任何 `task*` 前缀清单里 ⇒
**靠前缀 grep 盘点是整块漏掉的**（技术债的典型藏身处）。权威清单只能**从面板区逐行取 `id="…"`**。

🔴 **前缀（`prefix`）本身也是 id 片段。** 人脸 / 搜图两节的元素不是按字面量取的，而是
`document.getElementById(aiTask.prefix + 'Title')` 拼出来的（`scan-flow.js#renderBackgroundTaskPanel`）。
统一 id 时 HTML 换成了 `taskFaceTitle`、而 `prefix` 还留着 `'faceTask'` ⇒ 拼出 `faceTaskTitle`、
取到 `null`、**那一格永远空白且不报错**。「JS 字面量 ↔ HTML」那类对账**查不到它**
（它只看字面量），`dead-reference-regression` 也解析不了拼接 —— 本轮是**行为层**断言抓到的。
⇒ 现在补了静态通道（见 §10 最后一条）。
⚠️ **`optimizeTaskRunning`（主进程变量）与 `_dupHashProgressRunning`（渲染端局部标志）不是 id**
—— 本条管不到它们，别顺手去改。

✅ **进度条已统一成 `<div>` + `.progress-fill` + `width`**（2026-10-08）。原先两种写法：
`<div style.width>`（扫描 / 补全 / 重建 / 清理 / 查重）与 `<progress value>`（人脸 / 搜图）。
取 `<div>` 的理由是可精确控制圆角与主题变量，`<progress>` 在不同平台上长得不一样。
现有 7 条（扫描 / 补全 / 重建 / 无效清理 / 查重 / 人脸 / 搜图）；「优化数据库」没有进度条，
是 §11.2 记的已知例外。

🔴 **换掉 `<progress>` 时必须把「不定态」一起搬过来。** `<progress>` 不带 `value` 时浏览器画的
是动画条纹（语义 =「在跑，但进度未知」），而 `div` 的 `0%` 会被读成「进度就是 0」——
**两者含义相反**。这个语义现在由 `styles.css#.progress-fill--indeterminate`（宽度 40% +
`margin-left` 滑动）承担，判据在渲染端（`scan-flow.js`，AI 两节那段）：
**模型下载阶段用下载字节进度 > 有确定分母时用主进程派生的 `pct` > 不定态**。

⚠️ 换的时候顺带修好一处真实的不同步：原先 AI 两节是 `else removeAttribute('value')` ——
把**索引阶段**（那时已有 `done` / `total`）也一并压成不定态，而同一节的计数行明明在显示
`done / 约 total（pct%）` ⇒ **计数有百分比、进度条却不动**。现在有确定分母就按 `pct` 走。

🔴 **不定态还必须穿过 `prefers-reduced-motion: reduce` 的全局压制**（2026-10-08 像素实测补上的，
豁免写在 `styles.css` 那个 `@media` 块里）。这一条**推理看不出来，我是靠截图核对时才发现漏的**：
`<progress>` 的条纹画在 **UA shadow tree 的伪元素**上，而压制它的是 `*` 选择器 ——
**命中不到 shadow 伪元素** ⇒ 它从来压不住原生 `<progress>`。换成我们的 `div` 之后，
同一条动画挂在**普通元素**上，正好落进压制范围。
实测（最小对照页，同一页面同一时刻，逐帧变化像素占比）：

| 元素 | `reduce = true`（本机真实设置） | `no-preference`（模拟） |
|---|---|---|
| 旧：裸 `<progress>` 不带 `value` | **7.29%**（在动） | 7.29% |
| 新：`.progress-fill--indeterminate` | **0.00%**（静止） | 3.82%（在动） |
| 对照：`<progress value="40">` | 0% | 0% |
| 对照：静态 40% 条 | 0% | 0%（只有 `progressShimmer` 流光） |

两个「必须不动」的对照两趟都是 0% ⇒ 采样可信，7.29% vs 0.00% 是真差异。
本机（Windows）`prefers-reduced-motion` **恒为 `reduce`**，所以换完元素用户看到的是
**一条静止的 40% 填充** —— 那不是「安静的降级」，是**给了一个错误的确定值**（读作「进度 40%」），
而真相是「在跑、进度未知」。`theme-polish.css` 又把面板里的 `.progress-fill` 背景改成纯色
⇒ 面板内不定态的**唯一**可见运动就是这条 `margin-left` 位移，压掉就一点动感都不剩。
⇒ 豁免（周期放慢到 2.4s、`animation-name` 收窄成**只留位移那一条**，把 `progressShimmer`
留在被压制态），理由与加载圈 / 底栏「随机」光晕同源：**重点功能的可辨识信号，不是装饰性位移动效**。
🔴 守护 `background-tasks-panel-regression` ③ 逐条核对这段（`@media` 块里命中类名 +
duration + iteration-count + animation-name），牙齿验证 6/6。

⚠️ **无障碍是独立待办**（不在本轮）：AI 两节那两条的外层有 `role="progressbar"` +
走 i18n 的 `aria-label`，但 `aria-valuenow` 没维护（缺该属性 = 不定态，恰好与它们的常态相符）；
另外 5 条进度条连 `role` / `aria-label` 都没有。要补就一起补。

## 6. 文案：一律走 i18n，禁内联三元

- 所有面板文案走 `task.*` 键：`tui(key, zhFallback)` / `tuiFmt(key, map, zhFallback)`。
- 🔴 **禁** `(en ? 'Processed ' : '完成 ')` 这种内联三元 —— 曾经 AI 两节（标题 / 计数 / 速率 / 状态）
  与「扫描队列」badge 都是这么写的，「扫描队列 · 还有 N 项等待」甚至**连 en 分支都没有**（纯中文），
  而 `task.faceTitle` / `task.semanticTitle` 这些键**早就定义好了却没被使用**。
  ✅ 2026-10-08 已落地（待办 A）：全部搬进 `i18n.js`（12 个词条 ×中英两包）。
  ⚠️ 同日 C 又新增 2 个（`task.aiCountCounting` / `task.aiCountNoTotal`，见 §3.1.4）。
- 🔴 **英文界面零 CJK**：括号、分隔符都要跟语言走（中文全角 `（42%）`、英文半角 `(42%)`）。
- 新增文案必须**中英成对**加进 `i18n.js`，并同时更新 `docs/` 里对应的键清单。

### 6.1 硬编码文案的剩留（**已知，不是遗漏**）

✅ **动作按钮的文案已全部走 i18n**（2026-10-08）。它们原先写死在**两处**：
`scan-flow.js`（`'⏸ 暂停'` / `'▶ 继续'` / `'⏹ 停止'` / `'⏳ 停止中...'`）与
`app.js#rescanFolder` / `#rescanAllFolders`（同样那两条），而 `index.html` 的静态骨架在
**同一个按钮**上本来就有 `data-i18n="task.pause"` / `"task.stop"` ⇒ 骨架一份、JS 覆盖时又写死
一份，正是 §6 点名的那个静默形状（词条改了界面不动）。现在唯一拼法在
`scan-flow.js#scanPauseLabel` / `#scanStopLabel`（已导出给 `app.js` 复用），
**图标在函数里拼、词条只放文字**（否则英文界面会依赖词条里混图标）。

✅ **扫描节的状态 / 收尾文案已全部走 i18n**（2026-10-08）—— §6 至此**零剩留**。
原记「8 条串」，实际盘出来 **16 个词条**（差在**收尾**那一批：原先只记了 `scan-flow.js` 的
状态行与 `app.js` 的 `'准备中...'`，而收尾消息写在**另外两个函数**里，盘显示项时才翻出来）：

| 组 | 词条 |
|---|---|
| 状态行 7 | `task.scanPreparing` / `task.scanRunning` / `task.scanPaused` / `task.scanDone` / `task.scanEnumerating` / `task.scanQueuedGate` / `task.scanQueuedPending` |
| 失败 2 | `task.scanFailed` / `task.unknownError`（后者中文兜底串 = `'未知错误'`，供 `scanFailed` 的 `{err}` 复用） |
| 收尾 7 | `task.scanDoneCleaned` / `task.rescanDoneMarked` / `task.rescanDoneFolders` / `task.rescanDoneFoldersMarked` / `task.scanStopped` / `task.autoScanFailed` / `task.rescanFailed` |

**改动面 = `scan-flow.js` 三个函数（11 处）+ `app.js` 四处（8 处）**：

| 位置 | 是什么 |
|---|---|
| `scan-flow.js#updateProgress` | **扫描快路径**：worker 每推一次进度就写一次 `taskScanText` / `taskScanFile`，比轮询快得多 |
| `scan-flow.js#renderBackgroundTaskPanel` 的 `if (showScanBlock)` 块 | 轮询重绘（状态行 7 条全在这里） |
| `scan-flow.js#doScanFolder` | 扫描入口：起手 `'准备中...'`、收尾 `'已清理 N 条'`、失败 `onAlert` |
| `app.js`：`registerRuntimeApiListeners`（`onScanStart`）/ `handleAddFolder` / `handleSettingsRescan` / `handleSettingsRescanAll` | 起手提示 ×2 + 四条收尾消息 + 两条失败提示 |

🔴 **只改面板那一处会半途失效**：扫描期间显示英文、下一拍轮询又退回中文（快路径比轮询快得多）——
这正是「三个文案面」要一起改的理由。

⚠️ **一处刻意的一字符改动**：`doScanFolder` 的失败提示原先是**半角**冒号（`'扫描失败: '`），
而面板状态行那条是**全角**（`'扫描失败：'`）。现在两处共用 `task.scanFailed` ⇒ 取全角
—— 中文界面这一处会从 `:` 变 `：`，是**有意**统一（同一个失败两种标点会让人以为是两件事）。

**配套守护**（`background-tasks-panel-regression`）：
- ④ 组（键必须中英成对）的扫描面从 `panelBody` 扩到
  `panelBody + updateProgress + doScanFolder + 整个 app.js`。
  ⚠️ **`doScanFolder` 不能漏**：`task.scanDoneCleaned` / `task.scanPaused` 这类键**只在那里出现**
  （`app.js` 里没有）⇒ 漏了它，这些新词条的英文包缺失**无人报警**（注入用例 T4 专测这一格）。
- 新增 **④b 组（零裸中文）**：剥注释后取字符串字面量，凡含 CJK 的必须落在 i18n 助手的实参里。
  两条断言分别覆盖 `scan-flow.js` 的扫描节三处文案面、`app.js` 那 4 个函数内
  `updateProgress(...)` / `appAlert(...)` 的**调用实参区间**。
  ⚠️ 判据取「调用实参」而**不是**「含 `task.*` 键的调用」—— 后者在**回退**时就失效了
  （回退成裸中文 ⇒ 没有 `task.*` 键 ⇒ 该处不被扫描 ⇒ 断言照样绿）。
  7 个注入 × 逐字节还原全通过（含一条**阴性对照**：裸中文插在扫描节块**之外**必须仍然绿，
  用来证明「作用域收窄」不是「判据失效」）。

🔴 **③ 的判据本身踩过三个坑**（直接决定这条断言对不对，别再踩）：
1. **助手名要显式列举**：第一版写 `/^t[A-Z]/` 想一把抓所有 `tXxx` 助手，它**匹配不到 `tui`**
   （第二个字母是小写）⇒ 恰恰漏掉最核心的那个。现用 `I18N_HELPERS` 集合显式列举。
2. **「是否落在 i18n 调用里」必须沿父链向上找第一个不可穿越的祖先**：
   `tuiFmt(key, {…}, '完成 ' + n + '（' + pct + '%）')` 里那串中文是**拼接表达式**，
   父链是 `BinaryExpression > … > CallExpression`。只看父/祖父节点 ⇒ 合规兜底串集体误判
   （实测假阳性 **80+ 条**，差点照着这个错读数去改产品代码）。
3. **作用域本身也会造假红，且比前两个隐蔽**：`renderBackgroundTaskPanel` **一个函数渲染 8 节**，
   拿整个函数体当作用域时，**其余 7 节的存量裸中文会替本节把断言顶红**（实测 6 条：两节标题的
   具名兜底属性 `titleZh: '人脸模型 / 索引'`；重建那四项 `['task.thumbDetailSized', n, '原图尺寸 +']`
   —— 兜底串**先存进数组、循环里才喂 `tuiFmt`**）。那时只剩两条错路：删/改松断言（拔牙），
   或给每一条假阳性打补丁（下节 i18n 化前还得再打）。
   ⇒ 正解是**把作用域收到本次改动范围**：`SCAN_TEXT_SCOPES` = `updateProgress` 体 +
   `doScanFolder` 体 + `if (showScanBlock) {…}` 的 **`BlockStatement` 区间**（AST 结构性取块，
   **不是**行号窗口法）。⚙️ 判据够不到「**跨语句的间接引用**」（兜底串先存变量、稍后才在别处喂
   `tuiFmt`，父链到 `VariableDeclarator` 就断了）—— 这类形状靠**收窄作用域**回避，
   **不要**靠放宽判据（放宽 = 间接引用也能夹带真硬编码）。

✅ **面板之外的裸中文已清零**（2026-10-08，接扫描节之后第二批）—— `app.js` **全域**现在零裸中文。
起点 **68 条**（⚠️ 口径见下面「怎么数」），分三部分：

| 类 | 条数 | 处置 |
|---|---|---|
| **真硬编码用户可见文案** | **50** | ✅ 全部走 i18n（本批） |
| 「i18n 键 → 中文兜底」具名表（`PATH_CRUMBS_ZH` / `NAV_HISTORY_ZH`） | 9 | 合规（与 `tUiFmt` 第三参同义）⇒ 判据豁免 |
| 日期格式化的**降级实现**（`formatDateLabel` / `getWeekday` 的 `\|\| function(){…}`） | 9 | 死代码（`RendererUtils` 恒存在）⇒ 判据豁免。✅ 日期本地化**已落地**（同日第四批）：`\|\|` 右侧**刻意不动** —— 它不可达，改它只会改变豁免形状、换来零用户可见收益 |

**50 条的分布**（改动面 = `app.js` 34 处 + 新词条 30 个 ×中英两包）：

| 组 | 条数 | 位置 |
|---|---|---|
| 通用弹窗（标题 / OK / 知道了 / 取消） | 5 | `bindAppDialogRequests` —— **`dialog.title` / `dialog.ok` / `dialog.cancel` 早就有词条、只是没被用** |
| 设置页确认正文（重扫单目录 / 移除目录） | 5 | `handleSettingsRescan` / `handleSettingsRemove` —— 各抽成**一个多行词条**（`\n` 拼接写法照 `settings.rescanAllConfirm`） |
| 分隔符（顿号 ×5 / 全角间隔点 ×1） | 6 | `migrateDataDir` / `dataDirPausedNote` / `describeDataDirInfo` ⇒ `common.listSep` / `common.partSep`（**契约 §6 明写「分隔符要跟语言走」**，英文用 `, ` 与 ` · `） |
| 加载态 / 失败态（含内嵌 HTML 的 title/desc） | 7 | `loadPhotos` / `viewDuplicates` / `_showSidebarListLoading` / `renderPreviewInfoPanel` ⇒ `escapeHtml(tUi(…))`（照 `:3343` 既有风格） |
| 相似图查找（4 条提示 + 1 处三段拼接 + 失败串） | 9 | `previewFindSimilar` ⇒ `preview.similarFoundFmt` 等 6 键；失败串的「未知错误」复用 `task.unknownError` |
| 设置项保存 / 应用失败提示 | 6 | `cycleUiThemePreset` / `applyHlsCacheSettings`(2) / `applyThumbSettings` / 三处浏览工具栏 ⇒ `theme.switchFailFmt` 等 |
| 全屏标签 / 预览边界 toast / 打开目录 / 收藏路径栏 | 8 | `syncFullscreenButton` / `navigatePreview` / `openDatabaseFolder` / `updateBrowsePathLabel`（后者复用既有 `path.favorites`） |

**新增守护 ④c：`app.js` 全域零裸中文（总闸）**，与既有的 ④b（扫描相关 4 个函数里的**调用实参**）
并存 —— ④b 是**精确锚**（将来 `app.js` 拆文件时按函数名仍守得住），④c 是**总闸**
（无论有人把硬编码加在哪个函数里都抓住）。

**怎么数「裸中文」**（口径必须一致，否则数字对不上）：AST 剥注释 → 取字符串字面量 →
凡含 CJK 的必须**落在 i18n 助手的实参里**、或落在那两条豁免形状里，剩下的才是裸中文。
⚠️ 助手判定必须**双轨**：显式名单 **+** 形态启发式（`t` 开头短名 + 第一实参是点号键）。
只认名单会多数出 4 条（`app.js:2272` 的局部别名 `var tR = … ? tUi : …` ⇒ `tR('preview.winRestore',
'还原窗口')` 合规却被报成硬编码）。**起点 68 = 双轨口径**；用旧名单会数出 72。
探测实现：`.workbuddy/tmp/regen-four/cjk-app-audit.js`（带「按函数分组」）。

🔴 **两个判据坑（都是本轮实测，已写进守护注释）**：
1. **光列举助手名不够，还得认别名 / 包装**（上面那条 4 条假红）。★ 与「`/^t[A-Z]/` 匹配不到
   `tui`」是同一族坑的升级版。
2. 🔴 **键对账的扫描面漏了整片命名空间**（靠**注入用例 T4 才发现**）：④ 组原先的键提取正则
   前缀写死 `(?:task|settings\.task)` ⇒ `sidebar.` / `preview.` / `path.` / `dialog.` / `common.` /
   `theme.` 以及非 task 的 `settings.` 键**全都不在扫描面里** —— 本批新加 30+ 个这样的键，
   英文包漏一条**没有任何断言会响**。现在改成**两条采集并集**：① 文本面（`task.*` 家族，
   不限位置 ⇒ 抓得到 `titleKey: 'task.faceTitle'` 这种「存起来稍后消费」的形状）；
   ② **调用面（AST）**：`app.js` 里所有 i18n 助手的第一实参若是点号键字面量就收进来（不限命名空间）。
   ⚠️ 为什么①不干脆也放开前缀：放开后 `'photo.jpg'` / `'application/json'` 这类**非 i18n 点号串**
   会大批涌入 ⇒ 假阳性。走调用面没这个问题 —— 键出现在 i18n 助手的实参位置上，本身就是证据。

**牙齿验证 6/6**（`.workbuddy/tmp/regen-four/teeth6.js`，全部 sha1 逐字节还原），其中两条是
**不靠「改坏产品代码」**的形状、价值最高：
- **豁免不越界**：往「具名兜底表」里塞一个**函数属性**、函数体写裸中文 ⇒ 必须红
  （证明 `i18nFallbackShapeOf` 的「遇函数边界就停」真的有效，否则任何对象里的函数都能夹带硬编码 = 假绿）。
- **对守护自身做变异**：把 `i18nHelperOf` 的形态启发式整段删掉 ⇒ 必须红
  （证明「认别名」承重 —— 当前 ④c 之所以绿，正是因为 `tR(…)` 被第二轨认出来了）。
其余四条：别处新加硬编码 / 已 i18n 化的提示回退 / 删英文包一条键 / 分隔符回退成顿号。

✅ **第二层：包级对账 + 两个 `vm` 夹具改「真包桩」**（2026-10-08 第三批，改名走 i18n 时被套件真红逼出来的）：
「面板 / `app.js` 里没有裸中文」只管到**源码**，管不到「**英文包里到底有没有那条**」。补两层：

1. **新增守护 `scripts/i18n-pack-regression.js`（包级，3 条不变量，不依赖调用点）**：
   ① **同键** —— 两包键集合一一对应；② **同占位符** —— 同一条词条两包 `{name}` 集合一致；
   ③ **英文包里不许有中文**。三条的失败形态**全是静默的**：① 少一条 ⇒ `t()` 回落中文包；
   ② 英文漏 `{err}` ⇒ 「失败」说不出原因；③ 把中文抄进 `en` ⇒ ①② 都还是绿的。
   - 走 **AST**，不走正则：词条值有 **`+` 拼接**（多行确认框是 `'a\n' + 'b\n'`），只认单字面量
     会把它们整段跳过，而「跳过」在断言里跟「通过」长得一样；顺带断言「折不动的值必须为 0」。
   - 白名单只有 2 条（`settings.lang.zh` 语言自称 / `help.aboutBody` 作者署名），
     并附**防过期**断言：豁免项必须**仍因含中文**才被豁免（键改名后白名单会退化成永远不命中的豁免）。
   - ⚙️ 为什么单独成守：④ 只覆盖「面板 + `app.js` 引用到的」键，其余词条没人管；②③ 原本零覆盖。
   - 实测 744 / 744 条、139 条带占位符、0 处不一致。
2. 🔴 **两个用 `vm` 抽函数跑的守护改成「接真 i18n 包」的桩**（`page-size-control-regression.js` /
   `browse-grid-style-regression.js`）：它们原来是**逐项显式列举**的替身表，产品代码新加一个
   `tUiFmt(...)` 调用 ⇒ 失败路径一走到 `ReferenceError`（**这一跑套件就是这么红的**）。
   桩**不许**写成「返回第三参兜底串」—— 那能让中文断言继续绿，却把「键写错 / 英文漏这条 /
   模板漏 `{err}`」三个坏法整个盖住。现在 `require` 真包 + 按 locale 取词，键缺失**直接判红**。
   另各补一条 `locale = 'en'` 的用例：期望串**从真包派生**（改文案不用改守护）、
   断言 `{err}` 真插值 + **零 CJK**。⚠️ 期望串**不要**写死英文措辞 —— 牙齿的阴性对照
   （纯措辞改名）当场证明那会变成假红。

✅ **日期本地化已落地**（2026-10-08 第四批 —— 就是原记「18 条刻意不做」的那个**独立主题**）：
英文界面原先显示 `10月8日` / `周四`，正确形态是 `Oct 8` / `Thu`。**不是词条置换能解决的**
（月名与语序都要变）⇒ 走 `Intl`，住在 `I18n` 里（它因此有了 `t` 之外的**第一个格式化器**）；
也正因如此，「中英两包逐条对齐」那套包级守护（`i18n-pack-regression`）**管不到它**，必须单独成守。

链路三层，**真相源在 `i18n.js`**：

| 层 | 位置 | 职责 |
|---|---|---|
| 派生 | `i18n.js#formatDate` / `#formatWeekday`（私有 `_dateAt` / `_dateFormatter`） | `Intl.DateTimeFormat` 出串，导到 `global.I18n` |
| 转发 | `utils.js#formatDateLabel` / `#getWeekday` | **先问 `global.I18n`**（每次调用时查），取不到再走中文兜底 |
| 接线 | `app.js:7957/7965` 的 `RendererUtils.X \|\| …`，3 个显示点：日期侧栏 `:3431`、路径栏 `:3796`、导航历史 `:3980` | **零改动**（`\|\|` 形状不变 ⇒ ④c 豁免不必动） |

🔴 **两条红线，缺一条就是静默错**：

1. **必须钉 `timeZone: 'UTC'`**：日期分组里的 `YYYY-MM-DD` 表示「那一天」而不是某个时刻。
   不钉 ⇒ `TZ=America/New_York` 下 `2026-10-08` 被算成前一天（`Thu` → `Wed`），而中文用户**永远看不到**。
   ⚠️ 同一条也管 `utils.js` 那份中文兜底：旧实现是 `new Date(str)` + `getDay()`，而
   **`new Date('2026-10-08')` 是 UTC 午夜** ⇒ 负时区下会出现「日期写 `10月8日`、星期写 `周三`」的
   自相矛盾（本轮顺手修掉，改 `Date.UTC(y, m-1, d)` + `getUTCDay()`）。
2. **formatter 缓存 key 必须含 `current`**（`current + '|' + kind`）：`new Intl.DateTimeFormat` 实测
   **0.0725 ms/次**（2000 次 145 ms，复用只 2 ms）而日期侧栏一次渲染几百项 ⇒ 必须缓存；
   而 key 少 `current` ⇒ 切到英文仍命中中文那份（症状：**英文界面显示 `10月8日`，切回去再看又是对的**）。
   📌 上界 = 语言数 × 2 ⇒ **刻意不写失效逻辑**（`setLocale` 里清缓存会是一段永远不承重的装饰代码）。

📌 **同一组 option 在两个语言下各自正确**（实测，**不需要按语言分支**）：
`{ month: 'short', day: 'numeric' }` → zh-CN `10月8日` / en `Oct 8`；`{ weekday: 'short' }` → `周四` / `Thu`。
`month: 'long'` 中文无长短之分（仍 `10月8日`）、英文变 `October 8`（侧栏挤）⇒ 统一 `short`。

⚠️ **中文侧有一处可见变化，而且是**有意**的**：单位数月**不补零**。旧实现是字符串拼接
（`parts[1] + '月' + parseInt(parts[2], 10) + '日'`）⇒ 给出 `01月5日`；`Intl` 的中文月名本来就是
`1月` ⇒ 给出 `1月5日`。其余（`10月8日` / `周四` / 带时间串取日期部分）与旧实现**逐字节相同**。
⚠️ `utils.js` 的中文兜底**刻意与之对齐**（`parseInt` 吃掉前导零 + 形状不对的串原样返回），
守护把两条路的输出串**钉在一起** —— 两条路分叉时的症状**只在「`i18n.js` 没加载」时才现形**。
（⚠️ 兜底**不**重复 `I18n` 那道**回读校验**，别以为两者是全等镜像；理由写在 `utils.js` 注释里。）

📌 **`app.js:7956/7964` 那份死代码 fallback 刻意不动**：它**不可达**（`RendererUtils` 恒存在），
动它只会改变 ④c 豁免的形状、换来零用户可见收益；它保留的仍是旧串拼接口径（含前导零）。

📌 **网页端 EN 分支当前不可达（发现、本轮不做）**：`src/web/index.html` 硬编码 `lang="zh-CN"`、
`main.js:8446` 的 `sync-ui-locale` handler 只刷托盘/标题、**网页端无人派发 `localechange`**
⇒ 网页端 `formatDateLabel`（`src/web/js/app.js:4529`，仍是旧串拼接）拿不到英文。
将来若把语言推给网页端，需同步该处与 `:474` 的 `it.textContent = '日期: '`。

**配套守护 `scripts/i18n-date-locale-regression.js`**（11 组）：① 真接线 ② 中文逐字节
③ 英文零 CJK ④ 切语言往返（钉缓存 key）⑤ **时区无关** ⑥ 解不出的输入不崩不拼 `undefined月NaN日`
⑦ 拿不到 `I18n` 时中文兜底还在（与 ② 对齐）⑧ `app.js` 接线静态钉 ⑨ 换语言后日期侧栏要重画
（AST 判「在 `localechange` 监听器**体内**」，不是「文件里出现过 `loadDateGroups`」）⑩ 自登记。
⚠️ **三个语言面各钉一遍**（`i18n.js` 派生 → `utils.js` 转发 → `app.js` 接线）：缺任一个，
另一面坏了没人报。📌 `app.js` 那两条**行为测不到**（一上来就摸真实 DOM / electron，没法整体加载）⇒ 只能静态钉。

🔴 **另有 ①b 组：两处宿主的「同一个对象」必须静态钉 —— 沙箱正好把这个差异抹平。**
`i18n.js` 的 IIFE 传 `typeof window !== 'undefined' ? window : this`、`utils.js` 直传 `window`
⇒ 渲染端两边都是 `window` ⇒ `utils.js` 里那句 `global.I18n` 才拿得到东西
（`index.html:3477/3478` 也就必须**先 i18n 后 utils**，`utils.js` 的注释把这条写成前提）。
⚠️ 但**沙箱里 `window === sandbox === 上下文全局对象`** ⇒ 两个文件各写各的宿主时沙箱**照样全绿**，
生产端却静默回落中文（教科书式的「静态全绿、线上失效」）⇒ 只能静态钉。
这是「一处定名字、另一处引用同一个名字」那类契约 ⇒ **两侧各钉一次 + 加载顺序一次**；
将来要换成 `globalThis` 之类，**两侧必须同改**。

⚠️ **第 ⑤ 组必须用「新建的沙箱」**：`Intl.DateTimeFormat` 的时区是**构造时**定下的 ⇒ 复用已建缓存的
沙箱时，**就算源码根本没钉 `timeZone`**，那份 formatter 也照样给出 `Thu`（**假绿**）。
判据自身还带**夹具自证**：先断言「NY 下一个没钉 `timeZone` 的 formatter 应当给出 `Wed`」，否则这条等于没测。
⚠️ 复位**不能** `delete process.env.TZ`：实测 Node 只在**首次解析**时读它，删掉等于继续跑在被污染的时区里
（后续断言集体假红且极隐蔽）⇒ 记 `resolvedOptions().timeZone`、`finally` 显式赋回，并加「复位自证」断言。

**牙齿验证 15/15**（`.workbuddy/tmp/regen-four/teeth9.js`，逐个逐字节还原 + 核 `sha1`，末尾再做一次总漂移自证）：
去 `timeZone` / 缓存 key 塌成 `kind` / 硬编码 `'zh-CN'` / 删 `utils` 的转发分支 /
删 `localechange` 里的 `loadDateGroups()` / 断 `app.js` 的 `RendererUtils.formatDateLabel ||` /
兜底退回本机时区 / 去掉 `_dateAt` 的回读校验 / 兜底把前导零拼回来 / `day:'2-digit'` /
`utils.js` 宿主换 `globalThis` / 调换 `index.html` 两个 `<script>` 顺序，
外加 **3 条阴性对照**（改注释 / 缓存表改 `Object.create(null)` / 监听器改箭头函数）。
🔴 **与 `teeth8` 的关键差别：不只判「变红了」，还判「红在预期那条断言上」**。
只判 `exit ≠ 0` 时，「红在 A 而你以为在 B」和「A 根本没牙、是 B 替你红的」长得**一模一样**。
📌 这条在本次当场兑现：注入「删掉 `utils` 的转发分支」时，真红点是**第 2 组那条中文断言**
（`01月5日` ≠ `1月5日`），而不是我以为的英文那条 ⇒ 由此发现原注释与断言消息里
「与旧实现逐字节相同」是**句错话**，改真并把两条路对齐（见上）。

✅ **本轮顺手修掉的另两处同类硬编码**（原先都没记，盘显示项时才翻出来）：
· 查重指纹行 `'当前编号：'` / `'正在读取当前文件…'` ⇒ `task.dupHashCurrent` / `task.dupHashReading`；
· 无效清理的计数与副行 `'已检查 N，已删除 M'` / `' · 已删除 N 条'` ⇒
  `task.invalidCleanupChecked` / `task.invalidCleanupDeleted`。

## 7. ETA 与速率：二选一，不许混

> 🔴 **2026-10-08 当场修订**：这一节原先写的是「人脸 / 搜图没有分母 ⇒ 只报速率」，**那个前提
> 已经过期了**。两个任务后来加了**抽样估计分母**（`estimatePendingCount()` ⇒
> `totalEstimated: true`），分母**有了**、ETA 就能算 —— 但面板那两行元素一直没补，
> 9 个任务里只有这两节没有「预计剩余」行（用户当天报的「不显示预计完成时间」就是这笔欠账）。
> 所以这一节改写为「**有没有分母决定能不能报**」，并把「由速率反推」那支收进同一个模块。
>
> ⚠️ 这是一次**可以复用的教训**：判据从「有没有分母」悄悄变成「能不能算」的时候，
> **界面不会自己跟上** —— 上游加了字段，下游的格子不会自己长出来。以后每加一个
> 「让原本不可能的东西变成可能」的字段，都要回头看一眼**当初因为它缺而不做的那些界面**。

- **有分母**（精确或**抽样估计**都算）⇒ 报 `etaSeconds`，且**必须**经
  `estimateEtaSecondsSmoothed(任务key, startedAt, done, total)` 出（按 key 平滑，避免 ETA 抖动）。
  ⚠️ key 必须**唯一且稳定**，同一任务不许换 key（换 key = 平滑状态重置，ETA 会跳）。
  现有 key：`folderScan` / `thumbBackfillByProcessed` / `thumbRebuild` / `invalidCleanup` / `dupHash`。
- **分母是抽样估计值**（人脸 / 搜图）⇒ 走 `estimateEtaSecondsFromRate(done, failed, total, ratePerMinute)`
  （`src/main/eta.js`），在 `main/semantic-search.js#status()` 里派生 —— 桌面 IPC 与内嵌网页 API
  **共用**那个返回值，算在这里两边自动都有。
  ⚠️ **为什么不是 `estimateEtaSecondsSmoothed`**：那支要 `startedAt`，而这两个任务的
  `startedAt` 在 **worker 里**（模型加载 / 词表向量 / 估分母都发生在它之前），
  主进程手上只有「派发时刻」，硬喂会把那一段也算进速率 ⇒ ETA 系统性偏大。
  `ratePerMinute` 是 worker **在循环起手之后**才开始计的累计均值，口径干净。
  ⚠️ **为什么它不做平滑**：喂进来的速率本身就是**自起手以来的累计均值**（不是瞬时值），
  再平滑一层只会让它对真实变化反应更迟钝。
  ⚠️ **分子分母必须与速率逐字同口径**：速率的分子是 `done + failed` ⇒ 剩余也必须是
  `total − (done + failed)`。失败的那些**已经过了一遍**（耗掉了时间），把它们算成
  「还没做」会让 ETA 系统性偏大。⚠️ 这与面板主行显示的分子（`done`，回答「建成了多少」）
  **不是同一个量**，是**刻意的** —— ETA 回答的是「还剩多少件要过一遍」。
- **真没有分母**（既数不出也估不出）⇒ 只报 `ratePerMinute`，**并且别再补 ETA**：
  分母未知时 ETA 只能是骗子。
- ⚠️ **同屏两行的分工要说清**：人脸 / 搜图现在**速率 + ETA 两行都有**（速率是实测事实，
  还带「停止后保留已完成结果」；ETA 是基于**估算分母**的投影）。这不是「两套并存」的违例 ——
  **违例指的是同一个问题给两种互相矛盾的答案**；这里一行答「多快」、一行答「还要多久」，
  且 ETA 那行的「约」（`task.etaPrefix`）已经把「分母是估值」交代了。
- ⚠️ **喂给 ETA 的分子分母必须同口径**。真实故障（2026-10-08）：把**跨重启累计**的 `done`
  与**本次**的 `startedAt` 一起喂 ⇒ 速率被放大 18 倍（界面「1 小时 9 分」vs 真实 20.7 小时）。
  ⇒ 分子分母的「本次 / 累计」口径必须一致，且**同一行文字里不许一半累计一半本次**。
- 🔴 **ETA 的求值代码只许住在 `src/main/eta.js`**（2026-10-08 从 `main.js` 搬出）：
  「由耗时反推」「由速率反推」两支并排放，口径差别一眼能看见；在别处再长一份
  = 两份判据必然漂（`background-tasks-panel-regression` ⑤e 钉住了这条）。
- 🔴 **渲染端不自己除**（与 §1.1 的 `pct` 同一条规矩）：渲染端只做
  `formatEtaLine(state.etaSeconds)`。⚠️ 必须**无条件赋值**（`el.textContent = formatEtaLine(v)`），
  **不许**写成 `if (v) el.textContent = …` —— 后者会让「刚起手 / 空闲」的任务
  **停在上一轮那句话上**（静态断言看不出，行为断言 ⑤g 抓得到）。
- ⚠️ **`null` 与 `0` 是两个意思**：`null` = 还估不出来（没分母 / 没速率 / 样本 <3 件），
  `0` = 剩余确实为 0。两者在界面上都画成空行，但语义必须分开 —— 合成一个值，
  「刚起手」和「刚好追平」就没法区分了。

## 8. 停止能力

- **分钟级任务必须可停**，且停得掉（批次边界让位）。现状缺停止入口的：无效清理、优化数据库
  （两者都在设置页触发、时长可控，属**已知例外**，但要在面板上说明）。
- ✅ **「已请求停止」期间按钮禁用 + 给「停止中」反馈**（防重复点，且让用户知道点下去有用）。
  ⚠️ 2026-10-08 之前这一条**只落地了一半**：扫描节与人脸 / 搜图有反馈，而
  **补全 / 重建 / 查重三个按钮点完毫无变化** —— 根因不是缺数据，是 `cancelled` 一直由主进程
  在报（起手置 `false`、收到停止请求置 `true`）、**渲染端零消费**，于是用户只能靠
  「任务什么时候消失」猜有没有生效。现在四个按钮统一走 `scan-flow.js#syncStopButton`（唯一入口）。
- 🔴 **「已请求停止」的判据分两组，这是刻意的**：

  | 组 | 判据 | 为什么是这个 |
  |---|---|---|
  | 补全 / 重建 / 查重 | `running && cancelled` | 它们的 `phase` **被别的语义占着**（补全 = 分母估算三态 `counting` / `ready` / `failed`，重建 = `enqueueing` / `draining`）⇒ 塞 `'stopping'` 进去，同一个字段名就在两处表示两件**正交**的事 |
  | 人脸 / 搜图 | `phase === 'stopping'` | 它们的 `phase` **本来就是任务阶段机**（`install` / `index` / `indexing` / `downloading` / `stopping` …），`stopping` 是合法阶段值 |

  论证与 §3.1.4 的 `phase` / `countPhase` **完全同构**：要统一的是「已请求停止」这个**语义**，
  两组都已经统一了；字段名不同只因为 `phase` 在两边的**占用情况**不同。
  ⚠️ **判据必须同时看 `running`**：`cancelled` 只在任务起手时置回 `false`，单看它会让
  「上一轮被取消过」的任务一露头就顶着「停止中」+ 禁用。
- ⚠️ **判据写成「绝对」的**（看状态，不看「用户点过没」）：`syncStopButton` 只在**本节可见**时
  被调用，但因为判据绝对，整节隐藏期间**不需要任何复位逻辑** —— 下次任务起手主进程已把
  `cancelled` 重置，按钮自然回到原文案。相对判据（点击时置、靠下一次渲染复位）会碰上
  「点了之后任务立刻结束 ⇒ 整节隐藏 ⇒ 再没人复位」的死角，下次起手带着上一轮的禁用态。
- 停止后**保留已完成结果**，并在那一行**明说**（现有人脸那节的「停止后保留已完成结果」是样板）。

## 9. 呈现位置：两处，都要决定

| 位置 | 回答什么问题 | 现状 |
|---|---|---|
| 顶栏「后台任务」面板 | **正在跑什么、跑到哪了** | 8 节（scan / thumbs / thumbRebuild / invalidCleanup / optimize / dupHash / face / semantic） |
| 设置 →「后台任务」 | **能启动什么、上次结果如何、启动时自动跑什么** | 补全 / 重建 / 查重 / 维护 + 5 个自动开关 |

⇒ **新增一个长任务时，两处都要决定**：顶栏给一节？设置页给一行 + 启动按钮 + 一个「启动时自动跑」开关？
只做一处 = 用户只能等它自己开始（或永远不知道它能手动开始）。

## 10. 守护

- 每个任务一个 `*-regression`，断言**判门不判「名字出现过」**。
  反例：`/thumbs\.sized/` 对 `if (thumbs.sizd > 0)` 照样绿（push 体里还留着那个名字）。
- 🔴 **源码取法必须 AST**（`functionBodyByName` + 保偏移的 `stripCommentsByAst`），
  **禁「从函数头往后切 N 个字符」**：窗口太窄 = 假红（新代码插在前面就挤出去）、太宽 = 假绿
  （隔壁函数的同名串照样满足）。2026-10-08 全仓库审计的实测余量：

  | 位置 | 旧窗口 / 真实结构 | 覆盖 | 窗外漏掉 |
  |---|---|---|---|
  | `thumbnail-regen:692`（面板函数） | 12,000 / 23,258 | 52% | 4 个元素 id 全在窗外 |
  | `app-dialog-bridge` 清理确认 | 1,200 / 3,717 | 30% | 2,587 字符（整个后台循环 + `finally`） |
  | `app-dialog-bridge` 优化确认 | 1,800 / 1,697 | 100%（**余量只剩 103 字符 ≈ 2 行**） | 0 |
  | `app-dialog-bridge` 维护失败 | 600 / 1,416 | 39% | 859 字符（**头段**，失败路径的 catch 自检就在里面） |
  | `app-dialog-bridge` 数据目录回退 | 900 / 1,340 | 67% | 440 字符（`schedulePostWindowDeferredTasks()` 那段） |

  两种取法（都要配 `stripCommentsByAst`，`acorn` 的 `start/end` 才认）：
  · 具名处理器 / 回调 → 取 `objectPath.method('<字面量第一参数>', fn)` 的 **fn 体**
    （`a.b.c` 这种成员路径也认，别只匹配裸标识符）；
  · 只有字符串能当锚点（比如失败路径上的一句日志文案）→ 取**包含该字符串的最小外层函数体**
    （只认有块体的函数；箭头表达式体没大括号，取到也没法断言）。
  ⚠️ 反向断言（`doesNotMatch`）尤其不能留在窗口法里 —— 窗外真出现了要禁止的东西，
  窗口法**看不见**，而「看不见」正是这条守护存在的唯一理由。
- 🔴 **只跑一个任务**的显隐 case 必须有（§4 的或链遮蔽）。
- 🔴 **用 `vm` / `new Function` 抽函数跑的夹具：产品代码新增的是「调用」也要补桩**（不只是字段）。
  `page-size-control-regression` / `browse-grid-style-regression` 的替身表是**逐项显式列举**的 ——
  产品里新加一个 `tUiFmt(...)` ⇒ 那条路径一走到就 `ReferenceError`。
  ⚠️ 补桩时**接真模块 / 真包**，别抄一份实现：抄一份 = 又造一个「夹具跟产品漂开还照绿」的点
  （同族先例：`data-dir-regression` 用 `new Function('tUiFmt','tUi', …)` 注入真桩、
  `semantic-search` 那处 stub `require` 要 `require` 真模块）。
- 🔴 **`run-regressions.js` 是「首个失败即退出」**（`status !== 0` → `process.exit(1)`）⇒
  「套件报了 1 个红」**≠**「只有 1 处坏」：它停在第 29 项那次，**后面 47 个守护根本没跑**。
  排查时先把「哪些守护会受同一类改动影响」体检一遍，再报数。
  ⚠️ 判据还必须容忍**两种失败文案**：自定义 `assert` 输出 `FAIL:`，Node 内置 `assert` 抛
  `AssertionError`（**不含** `FAIL:`），还有的守护自己写「`[name] 回归失败：`」——
  `grep 'FAIL\|Regression failed'` 会同时漏掉后两种。
- 🔴 **牙齿验证只判「变红了」不够，还要判「红在预期那条断言上」**（2026-10-08 第四批新增口径）。
  只判 `exit ≠ 0` 时，「红在 A 而你以为在 B」与「A 根本没牙、是 B 替你红的」**长得一模一样**。
  正解 = 注入用例给每条期望配一个**特征子串**（那条断言的**消息原文**），输出里命中才算通过：
  `{ red: '负时区下星期不许回退一天' }`。📌 当场兑现：注入「删掉 `utils.js` 的转发分支」时，
  真红点是**另外一条**断言 ⇒ 由此翻出一句「与旧实现逐字节相同」的**错话**（详见 §6.1）。
- 🔴 **测「与环境无关」时，被缓存过的对象会让断言假绿。**
  `Intl.DateTimeFormat` 的**时区在构造时**就定下了 —— 复用同一个沙箱时，**就算源码根本没钉
  `timeZone`**，那份早先建好的 formatter 也照样给出正确结果（实测：改 `TZ` 后老沙箱静默通过）。
  ⇒ 这类「改环境（时区 / locale / 全局开关）再断言」的判据**必须在改完环境之后新建一个干净沙箱**，
  并给判据配**夹具自证**（先证明「在这个环境下，一份故意不设防的写法确实会算错」），否则那条可能恒真。
- ⚠️ **用 `process.env` 切环境时，复位不能靠 `delete`**：Node 只在**首次解析**时读 `TZ`，
  `delete process.env.TZ` 之后默认时区**不重算** —— 后续所有 `Date` / `Intl` 断言继续跑在污染时区里
  （症状：后面**无关**的断言集体假红，极隐蔽）。⇒ 记 `resolvedOptions().timeZone`，
  `finally` 里**显式赋回**一个具体时区，并加一条「复位自证」断言。
- 🔴 **沙箱会抹平「两个文件各写各的宿主」这类差异，必须静态钉。**
  `vm` 沙箱里 `window === sandbox === 上下文全局对象` ⇒ 「`i18n.js` 把 `I18n` 挂到 `window`、
  `utils.js` 从 `global` 读」在沙箱里**恒成立**，两个文件各写各的宿主也照样全绿；
  而生产端 `utils.js` 那句 `global.I18n` 会恒为 `undefined` ⇒ **静默回落中文**（「静态全绿、线上失效」）。
  ⇒ 这类「按名字找**同一个对象**」的契约（宿主 / 模块单例 / event bus / 注册表）**只能静态钉**，
  且按「一处定名字、另一处引用同一个名字 ⇒ 两侧各钉一次」办（本轮：两个 IIFE 的宿主表达式 + `index.html` 的加载顺序）。
- **口径一改，钉旧形状的断言必须同一次改动里翻面**，否则守护会替被否掉的旧实现站队。
- 🔴 **元素 id 的判据是「白名单式整体形状」，不是「不含那 7 个旧前缀」。**
  黑名单对**第 8 种新前缀**照样绿 —— 而「又造一个名字」正是本工程反复发生的形状。
  `background-tasks-panel-regression` 第 ⑤ 组钉三条：
  ① 面板区每个 id 必须命中 `task<Name><Part>` / `task<Name>Section` / 容器 三类之一；
  ② **JS 字面量 → HTML**：渲染端引用的每个 `task*` 字面量 id 必须在 `index.html` 里定义
     （`getElementById('拼错的 id')` 是**静默**的：取到 `null`、那格永远空白，不报错不写日志）；
  ③ **前缀展开 → HTML**：面板声明的每个 `prefix` 必须合 `task<Name>`，且能拼出 HTML 里存在的 id。
  ⚠️ **②③ 必须两条都有**：② 只看字面量，抓不到 `prefix + 'Part'` 那种拼接 ——
  本轮就是在这里真漏过一次（HTML 换了新 id、JS 还拼旧前缀），最后是**行为层**断言抓到的；
  `dead-reference-regression` 也解析不了拼接（它报「DOM id 400 个」却对这条无感）。
  ⚠️ 面板区的上下界锚点：`id="taskPanel"` … `id="mobileBackdrop"` **之前**。
- **改 id 的盘点清单**（漏任一项都是静默失效）：
  HTML 定义 → JS **字面量**引用 → JS **拼接 / `prefix`** 引用 → `options.dom` 的**键名**
  （`app.js` 传、`scan-flow.js` 读，两边都得改）→ 守护夹具（`node('…')` / `dom: {…}`）→ 契约文档。
- 🔴 **反向盘点（「这个 id 还有人用吗」）必须查四条通道，只看字面量会误判。** 2026-10-08 实测：
  以 `'id'` 为唯一判据时，`taskScanText` / `taskScanCount` / `taskScanFill` / `taskScanFile`
  **全部**被标成「零引用」——它们**只看不出现在字符串字面量里**。四条通道：

  | # | 通道 | 形状 | 只查字面量时的症状 |
  |---|---|---|---|
  | 1 | 字符串字面量 | `getElementById('taskThumbCount')` | — |
  | 2 | **拼接 / `prefix`** | `aiTask.prefix + 'Title'`（`prefix: 'taskFace'`） | 人脸 / 搜图两节 8 个 id 全漏 |
  | 3 | **键名 / 属性访问** | `dom.taskScanFill`、`taskScanFill: node(…)` | 扫描节 4 个 id 误判成死元素 |
  | 4 | **`$('#id')` 选择器** | `scanProgress: $('#taskPanel')` —— **带上 `#`** | `#taskPanel` 整块漏掉（它是面板显隐的总开关） |

  ⚠️ 通道 3 与 4 在 `app.js` 的 `dom` 表里是**同一行的两半**
  （键名 `taskScanText` + 值 `$('#taskScanText')`）—— 改 id 时两半都要改，所以它们算两条通道。
  ⚠️ **「零引用」不等于死 id**：`taskThumbTitle` 等 5 个 `*Title` 与 `taskOptimizeText` 确实无 JS 引用，
  但它们靠 `data-i18n` 静态渲染（**刻意**：这几节标题不会变）。`taskPanelBody` 则是**真死 id**
  （只有同名 class `.task-panel-body` 被 CSS 用，id 本身零消费者）—— 无害，但盘点时要能分清哪一类。
  ⚠️ **不要**改这三类：`CHANGELOG.md` 的历史条目（记的就是当时的名字，改了 = 篡改历史）、
  i18n **键名**（`settings.task.thumbProgress*` 是键名命名空间，不是元素 id）、
  主进程变量 `optimizeTaskRunning` / 渲染端局部标志 `_dupHashProgressRunning`（不是 id）。
- **注入式牙齿验证是交付的一部分**：新增/改动的每条断言都要「改坏 → 守护**精确**红在预期那条 →
  逐字节还原（核 `sha1`）」。本轮 C 验了 4 条、E 验了 3 条。
  ⚠️ 顺手清掉**死断言**：本轮写过一条 `assert.notEqual(zhCounting, zhEstFailed)`，
  但它被前两条 `match` / `!match` **逻辑蕴含**（一个不含「失败」、一个含「总数估计失败」，
  「失败」是后者的子串）⇒ 永远不可能红，已删。「加一条永远绿的断言」只给守护增重、不增牙。

## 11. 现有任务合规矩阵

图例：✅ 合规 / ⚠️ 可接受（有理由）/ ❌ 该统一

| 任务 | 状态函数 | 运行判据 | 分子 | 分母 | 「约」 | ETA / 速率 | 进度条元素 | 停止 |
|---|---|---|---|---|---|---|---|---|
| 文件夹扫描 | handler 内联包装 | `scan.active` ⚠️ | `current` ⚠️ | 精确 | — | ETA ✅ | `taskScanFill` 等 ✅ | 取消 + 暂停/继续 ✅ |
| 缩略图补全 | `getThumbnailBackfillProgress` | `running` ✅ | `done` ✅ | **估算** | ✅ 有 | ETA ✅ | `taskThumbFill` ✅ | ✅ |
| 缩略图重建 | `getThumbnailRebuildProgress` | `running` ✅ | `done` ✅ | 精确 | — | ETA ✅ | `taskThumbRebuildFill` ✅ | ✅ |
| 无效清理 | `getInvalidCleanupTaskProgress` | `running` ✅ | `done` ✅ | 精确 | — | ETA ✅ | `taskInvalidCleanupFill` ✅ | ❌ 无（§8 例外） |
| 查重指纹 | `getDuplicateHashTaskProgress` | `running` ✅ | `done` ✅ | 精确 | — | ETA ✅ | `taskDupHashFill` ✅ | ✅ |
| 优化数据库 | `optimize.running`（主进程变量 `optimizeTaskRunning`） | `running` ✅ | — | — | — | ❌ 都没有 | `taskOptimizeText` ⚠️ | ❌ 无（§8 例外） |
| 人脸索引 | `faceService.status()` | `running` + `phase` ✅ | `done` ✅ | **估算** | ✅ 有 | 速率 ⚠️ | `taskFaceProgress` ✅ | ✅ |
| 搜图索引 | `semanticSearch.status()` | `running` + `operation` ⚠️ | `done` ✅ | **估算** | ✅ 有 | 速率 ⚠️ | `taskSemanticProgress` ✅ | ✅ |
| 补 tag 倒排 | 同上（`operation='tag'`） | 同上 ⚠️ | 同上 | 精确 ✅ | — | 速率 ⚠️ | 同上 | 同上 |

**已收敛的五处**（2026-10-08）：① 元素 id 前缀 7 种 → 1 种（E）；② 百分比在渲染端 5–6 处各算一遍、
且 `total=0` 行为不一致 → 主进程唯一来源（B）；③ AI 两节文案不走 i18n → 全走词条（A）；
④ **形状收敛**（本轮；起因是用户「排查其他后台任务，列出每种任务的显示项」）：
进度条 `<progress>` ×2 → `div` ×7（§5）、停止按钮的「停止中」反馈补齐（§8，四个按钮统一走
`syncStopButton`）、副行职责四节四种形状 → 一种（§4.2）、动作按钮与查重 / 清理那几串文案走 i18n（§6.1）。
外加「在跑」字段名 3 种 → `running`、分子名 2 种 → `done`（C）。
⚠️ ④ 里那个换元素**当场埋了一个回退**，是收尾用截图核观感时才发现的（改写、跑守护、看契约
全都看不出）：`<progress>` 的条纹在 **UA shadow 伪元素**上、逃得过全局 `prefers-reduced-motion`
的 `*` 压制，换成 `div` 之后正好被压死 ⇒ 界面只剩一条**静止的 40%**。当日补了豁免，
实测与判据见 §5 那张表。📌 可搬走的教训：**「语义靠浏览器白拿」的写法，换成自绘元素时必须
逐条把语义补回来并各配一条断言** —— 这次补对了「不定态」这个名字，但漏了「它在 reduce 下也得动」。

### 11.2 仍未落地的偏离（**已知，不是遗漏** —— 都不在 A–H 八项里）

| 偏离 | 位置 | 为什么没顺手做 |
|---|---|---|
| **扫描节用 legacy 形状**：`status` 而非 `phase`、`current` 而非 `done`、没有 `running` | `main.js:7601-7610` + `scan-flow.js:284-295 / 510-545` | 这不是**改名**而是**形状迁移**：`status` 的取值域（`idle/scanning/…/paused/done/cancelled/error`）**承重** —— `showScanBlock` 的判据是「不在 `idle/done/cancelled/error` 里」。改成 §1 形状要同时定 `running` 与 `phase` 的语义边界，属独立一轮 |
| **面板进度条都没有 `aria-valuenow`**（AI 两节有 `role`/`aria-label`，另 5 条连 `role` 都没有） | §5 | 本轮换 div 时**没降级**（`<progress>` 原有的 `aria-label` 搬到了外层容器上），但要补全得连 5 条一起补，属独立一轮 |
| **估态字段名不统一**：补全 `phase` vs AI `countPhase` | §3.1.4 | AI 的 `phase` 已被任务阶段占用、同名会撞车；改补全那个要动 ~18 处 + 6 条断言，且它**已经改过一次名**（`thumbPhase` → `pendingPhase`）⇒ 第三改只增风险 |
| **优化数据库没有 `phase` / `total` / `done`、无停止入口** | §8 | 设置页触发、时长可控，属刻意记录在案的例外。⚠️ 但它现在**至少有了 `running`**（裸布尔 → `optimize: { running }`） |

### 11.1 待办（按性价比排序）

| # | 事项 | 面 | 风险 | 状态 |
|---|---|---|---|---|
| A | AI 两节文案搬进 `i18n.js`（`task.face*` / `task.semantic*`），消掉内联三元；顺手修「扫描队列」badge 的纯中文 | 渲染端 | 低 | ✅ 落地（12 个词条 ×中英两包；`face-task-regression` 加「词条必须中英各一条」+「不许内联三元」+「不许 `titleEn`」） |
| B | 百分比唯一来源：主进程统一派生 `pct`（夹 `[0,100]`），并定死 `total=0` 时画 0%（现在清理画 100%） | 主进程 + 渲染端 | 低 | ✅ 落地（`src/main/progress-pct.js#computePct`；4 处派生 + 4 处改读；新增 `background-tasks-panel-regression.js`：或链逐任务单独跑 + 百分比读 `pct` + `total=0` 一律 0%） |
| C | 状态对象统一：`running` / `done` 两个改名 + 估算三态收敛 | 主进程 + 渲染端 + 3 个守护 | 中（要同时翻面断言） | ✅ 落地（`busy`→`running`（产品 11 文件 36 处 + 网页端 25 处 + worker 上报边界）；`optimizing` **裸布尔** → `optimize: { running }`；`processed`→`done`；AI 两节新增 `countPhase` 三态 + **必须先报 `counting` 再去做估算**；起手重置补 `countPhase: null`。`face-task-regression` 加 4 条静/动断言；注入验证 4 条全有牙） |
| D | `maintenance` / `interaction` / `writeQueue` 从 `get-background-tasks` 拆出去（或明确标注「非任务」） | 主进程 | 低 | ✅ 落地（新建 `get-diagnostics`，三个字段渲染端零引用；`interaction-preempt-regression` 那条「不管位置」的断言同一次改动里翻面成「新位置必须有 + 旧位置必须没有」） |
| E | 元素 id 前缀统一（7 → 1）：`task<Name><Part>` | 渲染端 + 3 个守护 + `dead-reference` 类断言 | 中（改 id 要同步 html / js / 守护三处） | ✅ 落地（**50 个元素 / 9 个文件 / 176 处**一次改完；`background-tasks-panel-regression` 新增第 ⑤ 组三条判据 —— **整体形状 + 字面量对账 + 前缀展开对账**；注入验证 3 条全有牙。⚠️ 中途真漏过「`prefix` 本身也是 id 片段」，靠**行为层**断言抓到 —— 见 §5） |
| F | `app-dialog-bridge:55` 那处窗口法改成 AST 取法（覆盖 32%） | 守护 | 低 | ✅ 落地（4 处窗口法全改；实测覆盖 30% / 100%（余量 103 字符）/ 39% / 67%） |
| G | 扫描节状态 / 收尾文案走 i18n（原记「8 条串」，实际 **16 个词条** ×中英两包） | 渲染端 + 守护 | 低 | ✅ 落地（`scan-flow.js` 11 处 + `app.js` 8 处；④ 组扫描面扩到 `panelBody + updateProgress + **doScanFolder** + 整个 app.js`；新增 **④b 组「零裸中文」**两条断言 —— 注入 7 个全有牙，含 1 条**阴性对照**。⚠️ 作用域**必须**收在扫描节块内：拿整个 `renderBackgroundTaskPanel` 当作用域会被其余 7 节的存量裸中文顶红 ⇒ 只能拔牙 —— 见 §6.1） |
| H | **`app.js` 全域文案走 i18n**（面板之外那 50 条硬编码：弹窗 / 确认正文 / 加载失败态 / 相似图 / 分隔符 / 设置项失败提示） | 渲染端 + 守护 | 低 | ✅ 落地（`app.js` 34 处 + **30 个新词条** ×中英两包；新增 **④c 组「全域零裸中文」总闸** + 两条豁免形状；**键对账的采集方式补了「调用面（AST）」** —— 原先正则前缀写死 `task|settings.task`，整片命名空间（`sidebar.`/`preview.`/`path.`/`dialog.`/`common.`/`theme.`）无人守，靠**注入 T4** 才发现；牙齿 6/6，含「豁免不越界」与「对守护自身变异」两条。✅ 同批遗留的**日期本地化 18 条已落地**（同日第四批，见 §6.1））<br>🔴 **收尾（同日）**：该批落地那一跑全量套件**真红** —— 两个 `vm` 夹具（`page-size-control-regression` / `browse-grid-style-regression`）的替身表是新加 `tUiFmt(...)` 调用的盲区，且 `run-regressions` **首个失败即退出**把第 30 项之后的 **47 个守护一起挡住**（都没跑）。收尾三件：两个夹具改**真 i18n 包桩** + 各补一条英文用例、新增**包级守护** `scripts/i18n-pack-regression.js`（同键 / 同占位符 / 英文零中文）；牙齿再 **+14**。详见 §6.1「第二层」与 §10 两条新坑 |

**八项的验证方式**：每项都做了注入式牙齿验证（改坏 → 守护**精确**红在预期那条断言上 → 逐字节还原，
核 `sha1`）—— A 3 个注入、B 4 个、C 4 个、E 3 个、F 5 个（4 个「假绿」方向 + 1 个「假红」方向）、
G 7 个（6 个「回退会红」方向 + 1 个**阴性对照**「块外裸中文必须仍绿」）、
H 6 个（含 1 个**豁免不越界**、1 个**对守护自身变异**）+ **H 收尾 14 个**
（新包级守护 7 + 两个夹具 7，各含**阴性对照**「纯措辞改名不许红」）+ **日期本地化 15 个**
（12 个改名 / 回退方向 + 3 个**阴性对照**；⚠️ 这一批还额外判「红在**哪条**断言上」，见 §6.1）。
最终验收：eslint **0 error / 2 warning**（基线未动）；全量套件 `exit=0`、严格失败 `0`、
末项 `ai-lifecycle-regression` PASS（元规则⑥：回归起跑晚于最后一次改码）。
⚠️ **H 那次「全量套件 `exit=0`」的说法当时是错的**（只跑完前 28 项就红了）——
现记为**收尾之后重跑**的结果；「套件报 1 个红」≠「只有 1 处坏」，见 §10。
