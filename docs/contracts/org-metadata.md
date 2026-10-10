# 组织元数据契约（标记 `flag` · 评分 `rating` · 用户标签 `photo_tags`）

> 唯一正文。索引层（`.workbuddy/memory/MEMORY.md`）只留指针，正文不进那儿。
> 守护：`scripts/org-metadata-regression.js`（**六组**，已注册进 `run-regressions.js`）。
> 用户诉求原话：Plan 里点名「**标记 + 评分 + 用户标签**」，并明确「**这一轮不做 XMP**」。
> 界面口径演变（「整理」抽屉那一段）：`冲片条无法点击，而且遮挡图片不美观，是否收入类似图片信息的弹窗`
> → `独立操作入口、弹窗可以不共用` → `1 暂时不做，做 2 独立抽屉`（1 = 批量删除）。
> 分工：
> · `src/main/org-meta-filter.js` —— **取值域 + 筛选谓词**，叶子模块，唯一源；
> · `src/database.js` —— 两列 / 两张表 / 三个 setter；
> · `src/renderer/org-meta-ui.js` —— 渲染端状态与界面，取值域**镜像**一份（见 §8.1）。

### 🔴 本功能的失效方式**全部是静默的**

没有任何一条会让别的守护变红，也没有一条会报错或写日志。五条主链路：

| # | 改坏了什么 | 用户看到的现象 |
|---|---|---|
| 1 | 筛选判据写成 truthy（`if (opts.rating)`） | 「筛未评分」安静地变成「不筛」＝筛选栏亮着但没生效 |
| 2 | 六处查询各写一份谓词（漏一处） | 列表筛了、翻页翻到的却是别的集合（只在页边界看得出） |
| 3 | 卡片两个 `data-org-*` 属性名有两份 | 点一次星，已有的标记角标**消失** |
| 4 | 三条通道名漂开一个 | 「点了没反应」或 404 |
| 5 | 归一在三个入口各写一份 | 「网页端能用 7 星、桌面端不能」这类分叉 |

⇒ 所以 §2 / §5 / §7 / §8 这四章的每一条都要有守护盯着，且**只钉契约不钉实现**
（不钉 SQL 全文、不钉函数体）。宁可漏报不误报。

---

## 1. 四个维度的语义分工（不许合并成一个概念）

界面上是四个独立控件，**不要因为「都是用户写的标记」就把它们并进「收藏」**：

| 维度 | 列 / 表 | 语义 | 生命周期 |
|---|---|---|---|
| 收藏 | `photos.is_favorite` | 累积：我喜欢的 | **成果**，长期不动 |
| 标记 | `photos.flag` | 工作流：这一批我要哪些、不要哪些 | **过程**，冲完就清 |
| 评分 | `photos.rating` | 质量：这张够不够好 | 质量判据 |
| 标签 | `tags` + `photo_tags` | 组织：这张归哪个项目 / 客户 / 地点 | 组织维度 |

用户对它们的期待完全不同（收藏是「留下」，标记是「过一遍」）—— 并成一个概念
的后果是**取消入口跟着一起并**，而那个入口正是 §3 那样刻意分开的。

---

## 2. 取值域与归一

**唯一实现处**：`src/main/org-meta-filter.js`。界面 / IPC / HTTP 三条入口最终都汇到
`setPhotoRating` / `setPhotoFlag` / `setPhotoTags`，归一必须发生在**最靠内**的这里 ——
在每个入口各写一遍的结果是「网页端能用 7 星、桌面端不能」，而且不报错。

```js
RATING_MIN = 0   RATING_MAX = 5
FLAG_VALUES = ['none', 'pick', 'reject']   // 'none' 是合法值，不是「没有值」
```

### 2.1 评分：**夹取**，不抛错

`normalizeRating(value)`：`parseInt` → `!isFinite(n) || n <= 0` 落 `0`；`n >= 5` 落 `5`；否则 `n`。

- 🔴 **夹取而非抛错**：评分是高频盲操作（冲片时按数字键连打），为一次越界让整个操作
  失败，用户看到的是「按了没反应」，比夹到边界更糟。
- 🔴 **非数字 / NaN 一律落 `0`**（= 取消评分），与「再按一次同一颗星即取消」同义。
  绝不落 `NULL` 或负数：筛选里的「未评分」档就是 `rating = 0`，多一个 `NULL` 会让
  那一档的判据分裂成两支，而漏掉一支的症状是「有些没评分的图筛不出来」。

### 2.2 标记：白名单**必须穷举**

`normalizeFlag(value)`：`trim()` + `toLowerCase()` 后查 `FLAG_VALUES`，白名单外一律 `'none'`。

- 🔴 IPC 与 HTTP 都是**外部输入**。写进一个白名单外的值，会让所有按 `flag` 筛选的
  查询出现无法解释的结果 —— 而那种行在界面上**根本不显示**，排查时看不见。
- 顺手做了大小写归一 ⇒ `'PICK'` 是合法的。

### 2.3 标签：**键**与**显示名**是两个函数，两个都得留

| 函数 | 用途 | 规则 |
|---|---|---|
| `normalizeTagName` | **键**（`tags.normalized_name`，UNIQUE 就建在它上面） | 折叠内部连续空白 + `trim` + `toLowerCase` |
| `normalizeTagDisplayName` | **值**（`tags.name`，原样显示） | 折叠内部连续空白 + `trim`，**保留大小写** |

- 🔴 大小写不敏感是**刻意的**：中文没有大小写，但标签里混英文是常态（人名 / 品牌 /
  项目代号），而冲片时没人计较大小写 ——「客户A」与「客户a」必须算同一个标签，
  否则用户会得到两个看起来一模一样的 chip。中文不受 `toLowerCase` 影响，对纯中文是空操作。
- 只留一个函数的两个后果：要么标签列表里全是小写，要么「客户A」和「客户a」变成两个标签。
- 🔴 `normalizeTagName` 是本键的**唯一生成处**，别在别处再写一遍 `trim` / `lower`。

### 2.4 为什么必须是**叶子模块**

`src/db-heavy-read.js` **不能** `require('./database')`：`database.js` 反过来 require 它
（`getDatePhotos` 就是委托过去的），形成循环。循环 require 在 Node 里不会当场炸，
而是取决于谁先被加载 —— 那是「有时拿得到、有时是空对象」的故障。

⇒ 一份判据要被两条查询实现共用时，它必须住在叶子模块里。同理由的既有模块：
`photo-list-columns.js` / `exif-meta.js` / `thumb-format.js`。

> 🔴「各写一份」在这个工程里有明确前科：`_pushMediaTypeCondition` 的 `join(' AND ')`
> 漏在 `getFolderPhotos` 上，症状是「视频」档把图片也列出来（夹具实测 **11 行应为 5**）。
> 它不报错、不写日志，只在有人手工数结果行数时才暴露。

---

## 3. 写入语义：**幂等设值**，不是 toggle

| 维度 | 取消入口 | 为什么 |
|---|---|---|
| 标记 | **独立按钮**（`flag = 'none'`） | 冲片时左手盲按 X，做成 toggle 会让「以为没按上、再按一次」把**上一张**的标记静默清掉，而用户正在看下一张 |
| 评分 | **再点同一颗星**（回 0） | 星是 5 个独立的点，「点第 3 颗时已经是 3 了」屏幕可见，不存在盲操作问题；且 `0` 已归 `preview.zoomReset` |
| 收藏 | toggle（`photoToggleFavorite`） | 累积语义，用户能看见状态 |

- 🔴 **`setPhotoFlag` 与 `togglePhotoFavorite` 语义不同，别照着后者写**：前者传什么就是什么。
- 判据（当前值 → 下一个值）只写在渲染端 `nextRating()` / `nextFlag()` **两个函数**里，
  界面按钮与快捷键都走它们，不许各自决定。
- 三个 setter 都返回 `null` 表示「这一行不存在」，界面据此**丢弃回包**（不更新本地状态）。
- 三个维度**不许合成一个「设置元数据」胖接口**：冲片时一次只动一个维度，合起来会让
  「按了一下」发一整包，序列化成本乘以维度数。

### 3.1 标签是**全量替换**，不是 add / remove

`setPhotoTags(photoId, names)`：

- 界面上标签是一组 chip，用户回车提交时手上就是完整集合。拆成 diff 会让两端各写一套
  增删逻辑，而那套必然在「同一个标签被快速连按两次」时分叉（第二下的 remove 打在第一下
  刚 add 出来的行上，结果取决于到达顺序）。全量替换天然没有这个问题：后到的整体覆盖先到的。
- 不存在的标签**自动创建** —— 用户打一个新标签不该先去别处建它。
- 归一后为空的项直接丢弃（用户敲了个空格又回车）。
- 按归一键去重，保留**第一次出现的原文写法**（「客户A」在前就不会被「客户a」覆盖）。
- 整体**一个事务**：半途失败留下「删了一半」比整个失败更难收拾。
- 🔴 **不清理**「已无人使用」的标签：那会让用户刚建好、还没挂图的标签凭空消失。
  回收交给显式的 `deleteTag()`，标签列表里带使用计数，用户看得到哪些是 0 张。

### 3.2 🔴 行不存在的判据，两个 setter 写法**刻意不同**

- `setPhotoRating` / `setPhotoFlag` 用 `info.changes` 判（更便宜，写入本身必然改行）。
- `setPhotoTags` 必须**显式查一次主键**（`SELECT 1 FROM photos WHERE id = ?`）：
  一张图**本来就可能没有任何标签**，`changes === 0` 是合法结果，分不出「这张图没标签」
  与「这张图不存在」。
- 🔴 **绝不能用「让外键报错」来代替这次检查**：`photo_tags.photo_id` 上的外键是**真开着**的
  （`better-sqlite3` 默认 `foreign_keys = 1`，`open()` 里又显式设了一次），往不存在的 id 上
  挂标签会抛 `FOREIGN KEY constraint failed` ⇒ 上面那两个 `if (!result)` 分支**永不可达**，
  而用户拿到一句**英文数据库错误**（评分路径同一情形给的是「图片记录不存在」）。
  2026-10-09 由守护的真库夹具抓出。

---

## 4. 数据层

### 4.1 两列

`photos.rating INTEGER DEFAULT 0` / `photos.flag TEXT DEFAULT 'none'`（`createCoreSchema()`）。

- 刻意用 `0` 而不是 `NULL` 表示「未评分」：与 `is_favorite` 的 0/1 同风格，
  排序与筛选都不必处理 `NULL` 分支。
- 两列加在表**末尾**（`thumbnail` 内联 BLOB 之后）⇒ 见 4.2 的索引约束。

### 4.2 🔴 迁移与索引**必须分开**：加列 O(1)，建索引走延迟侧

- `ensurePhotosOrgMetaColumns()` 只做 `ADD COLUMN`（O(1)），里面有断言保证**不出现任何
  `CREATE INDEX`**。
- 索引登记在 `src/main/deferred-indexes.js#PHASE5_INDEXES`：`idx_photos_rating`、`idx_photos_flag`。
- 理由：这两列 cid 排在 `thumbnail`（内联 BLOB）之后 ⇒ 建索引要整表回扫，真库
  （**1,656,580 行**）上是几十秒到几分钟量级，且会长时间独占写库闸门 ⇒ **绝不许进启动路径**。
- 🔴 形态刻意是**普通索引**而不是部分索引（`WHERE rating > 0`）：冲片工作流里
  「还剩哪些没评分」（`rating = 0`）是常查的一档，部分索引恰好把它排除在外 ⇒ **那条查询
  反而退回全表扫**。`flag` 同理（要能查 `flag = 'none'`）。
- ⚠️ 与 `PHASE5_INDEXES` 里 ③⑥⑦ 三条不同，这两条**没有**「谓词逐字一致」的约束 ——
  普通索引不涉及部分索引的 WHERE 匹配，所以不需要从 `heavy` 取谓词、也不写 `INDEXED BY` hint。

### 4.3 两张表（`ensureOrgTagSchema()`）

```sql
tags        (id PK, name, normalized_name UNIQUE, created_at)
photo_tags  (photo_id, tag_id, created_at,
             PRIMARY KEY (photo_id, tag_id),
             FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
             FOREIGN KEY (tag_id)    REFERENCES tags(id)   ON DELETE CASCADE)
CREATE INDEX idx_photo_tags_tag ON photo_tags(tag_id)
```

- ⚠️ 主键 `(photo_id, tag_id)` 是 §5.2 里 `COUNT(*)` 与 `COUNT(DISTINCT tag_id)` 恒等的**前提**，
  改表时当心。
- `ON DELETE CASCADE` ⇒ 删图/删标签的关联清理由数据库做，不靠应用层记得。

---

## 5. 筛选作用域：六处必须同一批图

### 5.1 六处 + 唯一源

`pushOrgMetaConditions(conditions, params, options)` 是唯一源，六处调用点：

| # | 位置 | 场景 |
|---|---|---|
| 1 | `database.js#getPhotos` | 总览页 |
| 2 | `database.js#getFolderPhotos` | 目录页 |
| 3 | `database.js#_buildPreviewScopeWhere` | 预览作用域 / 邻图 |
| 4 | `database.js#searchPhotos` | 搜图页 |
| 5 | `db-heavy-read.js#runGetDatePhotos` | 日期页 |
| 6 | `main.js#fetchTagNavPhotoRows` | 标签导航页 |

`database.js` 上还挂了一个 `_pushOrgMetaConditions` 薄壳（委托到叶子模块），为的是与
`_pushMediaTypeCondition` 对称，好让 `main.js` / `db-heavy-read.js` 这些「手上只有 db 对象」
的地方能直接调 `db._pushOrgMetaConditions(...)`。

- 🔴 漂移的症状是「列表筛出来的和预览翻页翻到的不是同一批图」，**只在翻到页边界或按
  上一张/下一张时才看得出来**，且完全不报错。
- 调用点一律是「把调用方自己的 `options` **原样传进去**」，不许在调用点重建对象。

### 5.2 🔴 判据必须是 `!= null`，不能是 truthy

`rating = 0`（未评分）与 `flag = 'none'`（未标记）都是**合法筛选值**，而且是冲片工作流里
最常查的两档（「还剩哪些没标」）。写成 `if (opts.rating)` 会让「筛未评分」静默变成「不筛」。

`''` 单独排除，因为它来自 HTML `<select>` 的「未选择」空项，语义是「不限」。

### 5.3 标签：**AND 语义**（选了多个 = 必须同时具备全部）

- 取舍：OR（任一）会让勾选越多结果越多，与「逐步收窄」的直觉相反；用户选
  「客户 A」+「2024」时想要的是交集。
- 实现用一次扫描 + `HAVING COUNT(*)`，而不是 N 个 `EXISTS` 子查询 —— 后者在百万行库上是
  N 倍回表：

```sql
photos.id IN (SELECT photo_id FROM photo_tags WHERE tag_id IN (?,?,…)
              GROUP BY photo_id HAVING COUNT(*) = ?)
```

- ⚠️ 用 `COUNT(*)` 而不是 `COUNT(DISTINCT tag_id)`：`photo_tags` 是 `(photo_id, tag_id)`
  联合主键 ⇒ 同一对不可能重复，两者恒等，而 `COUNT(*)` 不必建临时去重表（前提见 §4.3）。
- ⚠️ 子查询里写的是 **`photos.id`（带表名前缀）** 而不是裸 `id`：本函数被 `getPhotos`
  （`FROM photos`）与带 JOIN 的查询共用，裸 `id` 会有歧义。
- 归一 + 去重 + 只收正整数 id（`parseInt` 后 `> 0`）后才拼占位符。

### 5.4 ⚠️ 占位符顺序必须与绑定顺序一致

绑定顺序按 SQL 里占位符出现的先后拼：

- `getFolderPhotos`：路径两条 → 收藏 → 组织元数据（`orgSql` 拼在 `mediaSql` 之后）；
- `runGetDatePhotos`：日期范围两条 → 组织元数据（`dateStr, nextDate, ...orgParams`）。

调用点都是「先攒 `conditions` / `params`、最后一次性拼」的写法，照抄即可。
**不要**把这个函数产出的片段塞进 `favoritesOnly` 那种「先拼字符串再展开参数」的表达式里
而忘了按顺序展开 `params`。

### 5.5 ⚠️ 标签导航页的**已知取舍**（沿用 mediaType 那条）

`fetchTagNavPhotoRows` 里过滤是在**取行那一步**做的，而 `total` 来自**索引侧** ⇒
筛选生效时 `photos.length` 会小于 `total`，**分页数会偏大**。

要精确就得把谓词下推到索引侧，而那会让两个库的判据耦合 —— 不值得。
（`tag-nav` 只碰 tag 索引库、绝不碰主库，是另一条独立契约，见 `joytag-index.md`。）

### 5.6 `hasOrgMetaFilter(options)`

有没有「非默认」的组织元数据筛选 —— 用来决定是否放弃为「无筛选」标定的索引快路径
（`searchPhotos` 的 `nameOnly` 分支与 `hasExtraFilter`）。

- ⚠️ 与 `pushOrgMetaConditions` 的判据**必须同源**：这里说「有筛选」而那边没 push
  （或反过来）会得到一个只在特定参数下出现的错误结果。
- ⇒ 判据只写这一份，调用方一律调本函数，**不许**自己写 `options.rating || options.flag` 那种。

---

## 6. 缓存

### 6.1 🔴 `photosTotalCache` 的键是「SQL 文本 + 参数按 `\u0000` 拼接」

`rating = ?` 在**换值时 SQL 文本一模一样** ⇒ 不同的筛选值会命中**同一个 total**。

⇒ `orgParams` 必须进**每一处**参数列表 —— `searchPhotos` 里至少三处：
`countParams` / `totalCacheParams` / `fbParams`。漏一处的症状是「切筛选后总页数不变」，
静默。

### 6.2 缓存失效：**读池要清，目录缓存刻意不清**

`main.js#invalidateReadCachesForOrgMeta(reason)` → `dbReadWorkerPool.invalidateReadCaches()`，
是四个写通道的统一收口（写十遍不如一个函数）。

- 目录缓存（`invalidateCatalogCachesSafe`）**刻意不动**：元数据不影响目录结构、分区计数、
  根目录统计 —— 与 `photo-toggle-favorite` 同一取向。
- 但**标签是跨表写**（`tags` + `photo_tags`），影响面比 rating/flag 更大：标签列表本身有
  使用计数，`listTags()` 的结果也在读池里 ⇒ **标签类操作一律清缓存**。

---

## 7. 三条通道：名字必须对得上

| 语义 | IPC（`main.js`） | preload | 网页端 HTTP（`web-server.js`） |
|---|---|---|---|
| 设评分 | `photo-set-rating` | `photoSetRating` | `POST /api/photo-rating` |
| 设标记 | `photo-set-flag` | `photoSetFlag` | `POST /api/photo-flag` |
| 读标签 | `photo-get-tags` | `photoGetTags` | `GET /api/photo-tags` |
| 写标签 | `photo-set-tags` | `photoSetTags` | `POST /api/photo-tags` |
| 标签字典 | `list-tags` | `listTags` | `GET /api/tags` |
| 重命名标签 | `rename-tag` | `renameTag` | — |
| 删除标签 | `delete-tag` | `deleteTag` | — |

- 🔴 任一名字漂开，症状是「点了没反应」或 404 —— 守护按两端对偶钉。
- **`/api/photo-tags` 的 GET 与 POST 共用一条路径是刻意的**：它们是同一份资源的读与写，
  分成 `/api/photo-tags-get` / `-set` 会让「URL 名字里带动词」这件事扩散出去。
- 回包一律带 `{ success, … }`；渲染端**必须**看 `success` 再更新本地状态。
- 🔴 **写标签的回包带的是「最终集合」**（不是调用方传进来的那份）：归一、去重、自动建标签
  都发生在数据层，界面的 chip 必须以此为准，否则会显示成用户打的原样（含空格 / 大小写差异）。
- 校验：主进程 `parseInt` 后 `!id` ⇒ `{ success: false, error: '无效的图片 ID' }`；
  `result` 为 `null` ⇒ `'图片记录不存在'`；网页端对应 **404**。

---

## 8. 渲染端（`src/renderer/org-meta-ui.js`）

### 8.1 取值域**镜像**了一份，这是刻意的

权威归一在 `src/main/org-meta-filter.js`（写入时夹取 / 白名单回落）。渲染端这份**只决定
「画几颗星、有几个标记按钮」——不承担校验**。

- 所以两份漂移的后果是「少画一颗星」，不是「写进脏值」。
- 反过来，若渲染端不镜像、改成从主进程拉，就得为「拿不到取值域」设计一条降级路径，
  而那条路径在启动竞态下会画出一排空按钮。
- 归一实现（`normalizeRating` / `normalizeFlag` / `normalizeTagDisplayName`）与主进程同规则。

### 8.2 🔴 卡片属性 `data-org-flag` / `data-org-rating` 必须**同源**

两个写点：`cardOrgDataAttrs(photo)`（静态建卡，拼 HTML 字符串）与 `writeCardOrgData(card, photo)`
（增量更新，写 DOM 属性）。**必须同源**（同一个归一函数、同一对属性名）。

漂开的症状：「刚翻出来的卡片点一次星，标记角标消失」—— 因为 `updateCardBadge` 回读到的
属性名对不上、读成 `null`。

### 8.3 角标：空标记 / 0 星**一律不画**

- 位置：标记走**右上角**（左上角已被「视频 / LIVE」占了）；评分走**图片区左下角**
  （不压住「选 / 否」也不压住文件名条）。
- 🔴 这两样是**筛选维度**。若每张卡都画一个「未标记」的灰圈，网格会立刻变成一片噪点，
  而角标的全部意义就是让「标过的」从「没标过的」里一眼跳出来 —— **画满等于没画**。

### 8.4 筛选态：`null` 表示「不限」，与 `0` / `'none'` 刻意分开

```js
emptyFilter()            → { rating: null, flag: null, tagIds: [] }
ensureFilter(state)      → 缺就补，tagIds 保证是数组
hasActiveFilter(state)   → ⚠️ 判据必须与 hasOrgMetaFilter 同源
applyFilterToOptions()   → **只在真有筛选时加键**
```

- 🔴 `hasActiveFilter` 说「有」而主进程不筛（或反过来），会出现「筛选栏亮着、结果没筛」
  这种只在眼睛对着看时才能发现的错。
- `applyFilterToOptions` 只在真有筛选时加键：加一个 `rating: null` 会让主进程的 `!= null`
  判据把它当成「不限」，但那意味着多一个键要维护；不加键时「不筛」由「键不存在」表达，更稳。

### 8.5 `filterMightChangeFor(state, dimension)` —— 改完要不要重拉

判据：**当前筛选正在约束这个维度** ⇒ 改完之后这张可能不再属于当前集合（比如在「仅已选」
档点「否」），**必须重拉**。没约束 ⇒ 只更新角标，不重拉（重拉会让网格闪一下、滚动位置丢失，
而用户只是点了个星）。

- 🔴 标签维度只能**保守**判「有标签筛选就重拉」：一张图可能被加进/移出任何一个标签集合，
  前端不查库无法知道结果集变没变。保守重拉多花一次查询；不重拉则会出现
  「列表里有它、筛选说它不该在」。

### 8.6 其它导出

`nextRating` / `nextFlag`（§3 的判据唯一源）、`patchInState`、`currentPhoto` / `currentPhotoId`、
`notifyBackgroundCounts`、`syncPreviewControls`、`tagsChipsHtml`。

---

## 9. 界面：「整理」抽屉（`#previewOrgPanel`）

收藏 / 标记三连 / 评分五星 / 标签 / 加入对比**全部住进右侧独立抽屉**，与
`#previewInfoPanel` **同构**（360px 宽、`translateX(100%)` 滑出、`z-index: 20`、同一段过渡），
两者**互斥**。入口是工具条上那颗 `#previewOrgBtn`。

### 9.1 三条设计判据

1. **不是弹窗遮罩** —— 冲片时用户要一边看图一边决定，盖住大图等于逼他先想好再打开；
   抽屉只吃右侧 360px（实测遮挡 `overlapPct: 4`）。
2. **不随切图关闭** —— 翻着图一路标下去是主用法（`syncPreviewOrgMeta` 刻意**不**关抽屉）。
3. **不随点外部关闭** —— 它是「工作台」不是「提示」；信息抽屉那套「点外部 / Esc 收起」
   **刻意不抄**（所以全工程不许出现针对 `#previewOrgPanel` / `#previewOrgBtn` 的
  `closest(...)`）。

### 9.2 搬迁史（两次）与原因

顶栏工具条 15+ 控件里 → `#previewCullingBar`（贴大图下缘的浮条）→ 本节这个抽屉。
换掉浮条的两个**实测**理由：

1. 正压在看图的位置（用户口径「遮挡图片不美观」）。
2. 它是 `.preview-body`（`pointer-events: none`）的子元素 —— **指针事件是继承属性** ⇒
   必须额外补 `auto` 才点得动（就是用户报的「点不动」）。

抽屉两条一起解决：不盖图主体，且 `auto` 写在 `.preview-org-panel.open` 上、与既有的
`.preview-info-panel.open` 逐字同构。

> ⚠️ 同一条 `pointer-events: none` 的既有先例：`.preview-info-panel.open`、`.preview-nav`。
> **修法永远是给子元素补 `auto`，绝不是删掉父元素那条 `none`**（删了会打断拖拽/缩放）。

### 9.3 🔴 `#previewNext` 与 `#previewZoomBox` 必须让位

两者分别是 `right: 16px; z-index: 6` 与 `right: 12px; bottom: 12px; z-index: 12`，
而抽屉是 `right: 0; width: 360px; z-index: 20` ⇒ 抽屉一开就把右箭头**整个**盖住：
点它没反应、也不报错。

- 修法：在 **`#previewOverlay`** 上挂 `has-right-drawer`，CSS 把两者左移一个抽屉宽：
  `min(376px, calc(85vw + 16px))` / `min(372px, calc(85vw + 12px))` —— 与抽屉自己的
  `width` / `max-width` 逐字对应，**改抽屉宽度要一起改**。
- 🔴 **类只能挂 `#previewOverlay`**：`.preview-body` 是 `z-index: 2` 的**层叠上下文**，
  抽屉那个 `z-index: 20` 在里面压不住 `.preview-zoom-box`（它是 `#previewOverlay` 的
  直接子元素）—— 挂 `.preview-body` 就够不着缩放胶囊，而那个恰好在截图里最显眼
  （实测「250%」胶囊正压着抽屉的「标签」分区下缘）。
- 唯一写点：桌面端 `_syncPreviewRightDrawerClass()` / 网页端 `_syncWebPreviewRightDrawerClass()`，
  由四个开合函数（两个 close / 两个 toggle）各自调用。

### 9.4 唯一入口与 id 策略

- 🔴 这四组控件**只有这一个入口**。标签原来是「悬浮小面板」（`#previewOrgTagsPanel` /
  `togglePreviewTagsPanel`），本轮**整套删除**、变成抽屉里的一个分区 —— 入口只剩一个，
  再留一层「点开面板」就是抽屉套抽屉。改动仍**立即保存**（没有「确定」按钮）。
- `previewFavoriteBtn` / `previewFlagPickBtn` / `previewFlagRejectBtn` / `previewFlagClearBtn` /
  `previewRatingStars` / `previewOrgTagsChips` / `previewOrgTagsInput` / `previewOrgTagsAddBtn`
  **全部不变**（只搬位置）⇒ `org-meta-ui.js` 与网页端基本零改动。
- **只有入口按钮改名**：`previewTagsBtn → previewOrgBtn`（网页端计数 `previewTagsCount → previewOrgCount`）
  —— 它开的是整个抽屉，旧名会让下一个读代码的人以为它只管标签。

### 9.5 「加入对比」的落点 = 专用槽 `#previewOrgActions`

`photo-compare.js#mount()` 优先找 `#previewOrgActions`（抽屉「对比」分区里那个空槽），
**找不到才退回**「插在 `#previewRatingStars` 之后」。

- 旧判据是「锚点是否落在冲片条内」（`bar.contains(anchor)`）—— 那读的是**别人的排版**，
  冲片条一删就失效；专用槽是「有就进、没有就退」。
- 随之删掉 `.preview-culling-divider`（抽屉用分区隔，条内那条竖分隔线没有意义了）。
- ⚠️ `scripts/compare-regression.js` 的 `TestNode` 桩已升级为「**逐 id 返回不同节点**」：
  旧桩对任何 id 都返回同一个节点 ⇒「进了槽」与「插在之星之后」分不出来，落点断言**恒真**
  （典型假绿）。另有一条**降级路径**用例（没有槽时不许静默不挂）。

### 9.6 键位只在 `title` 里

绑定：**Z = 选 / X = 否 / C = 清除 / 1–5 = 评分**（`shortcuts.js`，`preview.flagPick` /
`preview.flagReject` / `preview.flagClear` / `preview.rating1..5`），都在**左手区**（右手握鼠标）。

- 🔴 用户要求「按钮上不要显示快捷键」⇒ 键位只进 `title`，不进按钮文案。
- 同一批把顶栏那排按钮的文案从 `'R 旋转'` / `'F 收藏'` / `'S 相似'` / `'O 系统打开'` 改回
  `'旋转'` / `'收藏'` / `'相似'` / `'系统打开'`，键位回填各自的 `title` ——
  只搬位置、不丢可发现性。
- 键位与 `shortcuts.js` 默认绑定同源，**改键要两处同步**。
- 网页端**没有**这组快捷键，故不放键位提示。
- ⚠️ 去前缀时**别连图案一起削**：标记三连的 `✓ / ✕ / ↺` 不是快捷键，必须由按钮自己的
  `<svg class="btn-icon">` 渲染，词条只剩 `'选'` / `'否'` / `'清除'`。若以后看到文案里
  又出现图案符号，那是绕路又回来了。

### 9.7 ⚠️ 网页端抽屉里的按钮**不能用 `.preview-action-btn`**

那个类是给「压在图片上的浮条」用的（32×32、`color: rgba(255,255,255,.7)` 的白图标），
搬进跟随主题变色的抽屉后**浅色主题下白图标直接看不见**。

⇒ 改走新类 `.preview-org-btn`（带文字的药丸，与桌面端 `.btn.btn-sm` 同观感），收藏的激活态
自己带（`#previewFavoriteBtn.active`）。

### 9.8 发布

`web/index.html` 在 `sw.js#SHELL_ASSETS` 里 ⇒ 改它必须升 `sw.js#CACHE_NAME`
（本轮 `v65 → v66`）。cache-first 的 Service Worker 不升版本 ⇒ 已安装的 PWA 永远拿不到新壳。

---

## 10. 守护覆盖（`scripts/org-metadata-regression.js`）

六组，**只钉契约**：

| § | 组 | 钉什么 |
|---|---|---|
| 1 | 取值域与归一 | 真叶子模块的夹取/白名单/两套标签归一 |
| 2 | 筛选谓词 | `!= null` 判据、`rating = 0` / `flag = 'none'` **真的进筛选**、`hasOrgMetaFilter` 与 `pushOrgMetaConditions` **逐输入同源**、标签 AND 语义与占位符顺序 |
| 3 | 真库行为 | 写入语义（幂等）+ 六处查询**端到端取同一批图** + 排序白名单含 `rating` |
| 4 | 三条通道 | IPC / HTTP / 渲染端 api 名字对得上 |
| 5 | 渲染端真模块 | `vm` 加载 `org-meta-ui.js`：两端镜像逐输入等价、卡片 `data-org-*` 回读、抽屉内控件状态、标签回包校验 `photoId` |
| 6 | 「整理」抽屉 | 可点性（`auto` 只在打开态、`.preview-body` 保留 `none`）/ 结构 / 唯一入口 / 让位规则 |

- ⚠️ **必须用 Electron 运行时跑**（`npm test`）：本脚本 `require` 了 `better-sqlite3` 造真库，
  系统 node 的 ABI 对不上 ⇒ 用 node 直接跑会抛一个**看起来像代码坏了、其实只是运行时装错**
  的异常。
- ⚠️ **剥注释**：本文件自己的注释里引用了被断言的字面量，不剥会把注释当代码判（元规则③）。
- 🔴 排序白名单那条的牙：`rating` 不在白名单时会**静默退回 `date_taken`**，不报错。

### 10.1 本轮攒下的「假绿」陷阱（别重犯）

| 形态 | 坏在哪 | 正确写法 |
|---|---|---|
| DOM 桩对**任何 id 返回同一个节点** | 「进了专用槽」与「插在之星之后」分不出来，落点断言**恒真** | 桩按 `idMap` 逐 id 返回不同节点 |
| 自证切片的上界取错 | 把「控件在抽屉里」判成了「控件在这个文件里」 | 切片后先判**切片本身完整**（头尾两个标记） |
| 自证复用了切片**起点之前**的字符串 | 为错误的理由变红（假红） | 自证只看切片内 |
| 在整文件里搜一个符号 | 函数自己的**名字**就满足它 | 先 `functionBody(src, name)` 取**函数体**再判 |

---

## 11. 本轮**不做** / 已知取舍

- **XMP 读写**：用户明确「这一轮不做 XMP」⇒ 元数据只在库内，不写进图片文件。
  （⚠️ 与 `photo-edit` 的 `withMetadata({ orientation: 1 })` 不冲突：那一条保证的是
  **编辑时别把已有元数据剥掉**，不是「把我们的标记写进去」。）
- **标记的批量删除按钮**：用户「1 暂时不做，做 2 独立抽屉」⇒ 不做。
- **标签的全库聚合 / 父节点计数**：见 §5.5 与 `joytag-index.md`（命中数按节点懒算，
  绝不做全表 `GROUP BY`）。
- **标签 GC**：不自动回收 0 张的标签，交给显式 `deleteTag()`（§3.1）。
