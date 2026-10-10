# 缩略图补全 / 元数据回填 契约

> 任务实现：`main.js#runThumbnailBackfill`；谓词：`database.js`（`_sqlBackfillPendingExpr` 等）
> 守护：`photo-metadata-backfill-regression`（98 项）、`thumb-backfill-progress-regression`（128 项）、
> `perceptual-hash-share-regression`、`exif-backfill-regression`、`image-decoders-regression`、
> `thumbnail-spec-regression`（规格列 + **服务端 Content-Type 派生**）
> 本文只记录**回归脚本断言不了的**：为什么这么拆、踩过的坑、哪些不对称是刻意的。

## 心智模型：一个任务，三件事，两个失败面

「缩略图补全」这一个任务实际干**三件不同的事**，读文件的方式不同，因此**失败面也不同**：

| 工作 | 怎么读文件 | 读失败记哪一列 |
| --- | --- | --- |
| 缩略图 / dHash | **解码**（sharp `toBuffer` / `computeDhash`） | `thumb_fail_mtime` |
| 原图尺寸 / 拍摄参数（EXIF） | **只读文件头**（`metadata()`） | `header_fail_mtime` |

🔴 这是**拆成两列，不是扩一列的语义**。`thumb_fail_mtime` 这个列名承诺的是「缩略图没做出来」，
但把解码失败与头读失败混在一列，会让「解码炸了但头读得出来」的行被错判 —— 它其实**还能补尺寸和 EXIF**。

自愈判据必须**两份实现合一**（`_sqlFailMarkerRetryableExpr(col)`）：两列各写一份迟早漂开，
而漂开的表现是「某一路的失败行永远回不来」—— 不报错、不写日志。

## 🔴 为什么必须拆成两趟双游标

`EXIF_SCHEMA_VERSION` 一旦升级（已从 1 升到 2 一次），**全库 166 万行全部重新进候选集**。
缩略图补全与 EXIF 回填共用同一任务、同一游标 ⇒ 缩略图被全库重读拖着走。

真库实测：游标推进 **1,402 行 / 68 秒 = 20.7 行/秒**（166 万 ÷ 20.7 ≈ **22 小时**），
而游标所在那 2 万行**全都已有 256/jpeg 缩略图** ⇒ 全走 skip 分支 ⇒ 出图数恒 0。
拆出第一趟后，`idx_photos_hasThumb` 的倒序扫**第一个命中就是 id 1,889,290** ⇒ 开局立刻开始出图。

```
pass = 'thumbnail'  → getPhotosLackingThumbnailBefore(thumbCursor, limit)   // 会出图
pass = 'metadata'   → getPhotosMissingThumbnailsBefore(metaCursor, limit)   // 本来就不出图
```

两趟**各自**从 `MAX(id) + 1` 起手、各自递减；第一趟抽干后 `continue` **换趟（不是 break）**。

- 🔴 **两趟游标必须各自独立**。共用一条 = 第一趟把游标拉到低位后，第二趟 `id < 低值`
  再也取不到高位那几万行 —— **不报错、不写日志**，只是那些行的元数据永远补不上。
- 🔴 第一趟 SELECT 列表与第二趟**逐列相同**（`processOne` 的 `needSize`/`needDhash`/`needExif`/`needHash`
  全靠这几个字段做决定，少取一列 ⇒ 对应判据永远走兜底分支）。
- 🔴 开跑前那次 `dbWriteQueue.run` 里必须**同时**调 `ensureDhashSchema()` +
  `ensureDuplicateHashSchema()`（两列都是延迟迁移出来的，少调一个 = `no such column: dhash`）。

## 🔴 失败记账的三个陷阱

```sql
thumb_fail_mtime TEXT   -- 记「失败当时」该行的 date_modified，不是当前时间
```

- 🔴 **必须记该行当前的 `date_modified`，绝不能记 `Date.now()`**：时间戳只会前进、
  永远不可能等于那一行的 `date_modified` ⇒ 这行**永远回不来**。
- 🔴 **空值写空串，不写 NULL**：写 NULL 会让 `thumb_fail_mtime IS NULL` 为真 ⇒ 被判「没失败过」
  ⇒ 白重试的坑原样留着。
- 🔴 **只在「文件读得到、做不出图」时盖章**（`recordThumbFailure` 先 `existsSync` 探一遍）。
  外接盘没插时盖章 = 把**整个图库**的补全永久挡掉，且不自愈。文件真不在的交给 `invalid-cleanup`。
  两个盖章点必须共用 `fileReachableForFailureStamp(row, sharedBuf)` —— 各写一份迟早漏一处。

「读不到」那一支两边都要 **`logger.warn`**（生产档 `info` 是静默的 ⇒ 只打 info 等于零现场）。

### 文件头那一路必须用旗标，不能用 `!header`

`readHeaderMeta()` 内部 catch 里是 `return null`（**认函数名别认行号**），**不抛**
⇒ 「头读不出」根本不会走到 `catch (eThumb)`，只能靠 `headerTried` 旗标识别。

⚠️ 它 catch 里**刻意不写日志**（「损坏文件往往是批量导入的，会把日志刷爆」）——
新增盖章点别打破这条：`recordHeaderFailure` 只在「文件不可达」时 warn，正常盖章是静默的。

同理 dHash 分支：`computeDhash*` 失败**返回 `null`、从不抛**，所以以前它是**静默漏过**的
（没有 else 支就没人盖章）。

## 🔴 `IFNULL` 两侧兜：唯一的那颗牙

把两侧 `IFNULL` 全删掉，**行为面 5 条全绿、只有静态断言红**（实测）。
因为 `thumb_fail_mtime` 为空串 + `date_modified` 为 NULL 时，裸比较 `'' <> NULL` 得 NULL（假），
与 `IFNULL` 兜成 `'' <> ''` 得假，**结果一模一样**；而 `thumb_fail_mtime` 为 NULL 的行
被同一谓词里 `IS NULL OR` 那一支救了回来。

真正会分叉的组合**只有一个**：盖章时有日期、**之后 `date_modified` 被清成 NULL**
（文件被删 / 重扫后日期清空）⇒ 裸比较得 NULL（假）**永久排除**，有 `IFNULL` 则回到候选集重试。

⚠️ 别想成「老数据 `date_modified` 为 NULL 就会出问题」——那种行的 `thumb_fail_mtime` 同样是 NULL。

这是本项目的**通用教训**：一条静态断言如果它的名字声称验证了某个实现细节，
**必须实测把它改坏一次** —— 这次就抓到「名字撒谎」的断言（声称兜住了老数据，实际咬不住）。

## 🔴 解码失败不许连累元数据

`toBuffer()` 原本在 `updatePhotoDimensions` / `updatePhotoExif` **之前** ⇒
解码一抛异常，**已经读到的尺寸与 EXIF 一起丢**，且每轮重复读、重复丢弃。

修法：缩略图分支单独包一层 `try/catch (eThumb)`，尺寸 / EXIF / dHash / SHA-256
**全部移到 catch 之后** ⇒ 解码失败也照样把 `metadata()` 已读到的东西写进库。

## 刻意取舍：副指标刻意含「已盖章失败」的行

`countPhotosLackingThumbnail()` 的副指标 **刻意包含已盖章失败的行**（covering index 换 14 ms，
多引一列就回表）⇒ 界面上「预览图 N ｜ 还缺 M」可能**永远差那几十张**。

改成实时刷新后，这个差值会随盖章**持续扩大**（实测盖章 ~4 行/分，跑完 33.2 万缺口
预计累积 ~1,500 行）。这是**预期**的：副行报的是「还需要花时间去看的行」，
已盖章的行每轮确实还要被扫到（第二趟），把它们算进「还缺」比藏起来更诚实。

🔴 **别为了让两个数相等去改谓词。**

## 一个看似矛盾、其实合理的现象

「新加的图片为什么有缩略图」：`GENERATE_THUMBNAILS_DURING_SCAN = false`（`scanner.js`）
⇒ 扫描期不出图；但补全**倒序**跑 ⇒ 最新那批在**前几轮**就补齐了。

## 验收时的三个坑（守护脚本作者会踩）

1. **夹具里 `insertPhoto()` 没有返回值**（不 `return stmt.run(...)`）：
   `const id = db.insertPhoto(...)` 拿到 `undefined` ⇒ 后面所有 `WHERE id = ?` 静默变 no-op、
   夹具行全留在候选集（**看起来像谓词坏了，其实是夹具坏了**）。必须按 `file_path` 回查 id。
2. **注入锚点必须照抄真实缩进**：写成 6 空格（实际 4）会「锚点未命中」，
   而「注入失败」与「守护没抓到」长得几乎一样 —— 驱动脚本必须把两者**分开报**（退出码 2 vs 断言失败）。
3. **静态断言别逐字拼源码里的字符串拼接**：源码写的是
   `"(dhash IS NULL OR TRIM(dhash) = '') AND " + _sqlFailMarkerRetryableExpr`，
   `includes(A + B)` 必然落空 —— 改成比**文本偏移先后顺序**，既不依赖格式又真能证明「被门住」。

另外：`assert.match` 失败会把整个 haystack 打进 diff，实测刷 20 万字符根本看不出哪坏了
⇒ 断言对象要取**函数头部切片**而不是整个文件，且**别把偏移量写死成 magic number**。

## 通用教训

「计数对不对」和「任务在不在干活」是**两个问题**。后者只能用 `has_thumbnail = 1`
的**两次相减**来判（真库 90 秒只读窗口：两次都是 1,316,667 ⇒ 这 90 秒真的一张都没出），
**任务状态字段一律不可信**。

## 🔴 缩略图响应的 `Content-Type` 必须按行派生（2026-10-07 落地）

唯一真相源 = `src/main/thumb-format.js`（白名单 + 格式→MIME + `normalizeThumbFormat()` + `thumbMimeType()`）。
写入端（`updatePhotoThumbnail` / `insertPhoto`）与**两个服务端**（`main.js` 的 `thumb://`、
`web-server.js#handleThumb`，安卓端走 `/thumb/:id` 同一条）共用这一份。

**为什么值得单拎出来**：`thumb_format` 这一列**服务端从来没读过**。`database.js#getThumbnail()`
只 `SELECT thumbnail, has_thumbnail` ⇒ 格式在**取数处**就被丢掉（字段传播链上少带一个字段）
⇒ 6 处响应头只能写死 `image/jpeg`。这类失效**没有第二条线索**：字节是 WebP 而头写着 JPEG 时，
浏览器不解码、不报错、不进 console，表现成「格子空白 / 预览一片白」，排查会被带偏到
「文件损坏 / 解码器坏了」。今天库里全是 jpeg ⇒ 它在换编码器之前**永远绿**。

**三条不变量**（守护 `thumbnail-spec-regression` 第 4 组，共 44 项）：

1. 白名单每一项都必须有**显式** MIME —— 漏一项不是报错，是那一项静默回落成 `image/jpeg`。
2. 未知 / 空 / 非法一律回落 `image/jpeg`：`''` 的语义是「本列引入之前的存量行」（真库实测全是 JPEG），
   回落到别的东西 = 把那批**全部标错**，而错法与上一条同样静默。
3. 两个 thumb 处理器体内**不许出现 `image/jpeg` 字面量**，必须走 `thumbMimeType()`。
   断言取的是 acorn 解出的**真实函数体**（`protocol.handle('thumb', …)` 的回调 /
   `WebServer.prototype.handleThumb`），不是按行扫源码 —— 注释里会引用旧写法，
   文本匹配会把注释当成结构判据（本项目踩过）。

**反向验证（摘掉就红）**：把 `web-server.js` 那一处改回 `'image/jpeg'` ⇒
`FAIL: src/web-server.js handleThumb 里出现了硬编码的 image/jpeg —— 响应头必须由 thumbMimeType() 派生`。

⚠️ **仍然保持硬编码的两处不是漏改**：`main.js` 的 `photo://` RAW→JPEG 预览、
`web-server.js` 的 2560 档预览缓存 —— 它们发的是**预览图**、编码就写在上两行（恒 JPEG），
与库里的缩略图无关。已就地加注释，防止被「顺手统一」。

> 2026-10-07 补：本节当时留的最后一条尾巴（「`photoCacheVersion()` 不含 `thumb_format` ⇒
> 重编码后 `?v=` 不变，客户端继续显示老 JPEG」）**已落地修复**，见下面「浏览层的缓存键」一节。
> 同时默认档位换成 512 + WebP，并补上了把存量整体重跑一遍的机制（下一节）。

---

## 🔴 缩略图全量重跑：物化队列，不是「带规格谓词的倒序取批」（2026-10-07 落地）

### 为什么不能用「谓词 + 倒序 LIMIT」

改档位 / 换编码格式之后，要处理的是**存量行**。最直观的写法是：

```sql
SELECT … FROM photos
WHERE thumb_size <> ? OR thumb_format <> ?      -- 目标规格
ORDER BY id DESC LIMIT 50
```

它有一个致命性质：**规格目标是运行期取值**（用户随时能在设置里改），所以**烤不进部分索引的
`WHERE`** —— 部分索引的匹配是逐字的。于是这条语句成了全工程唯一一条「谓词无索引可依 +
倒序取批」的查询。它的代价**不是** ∝ 批大小，而是 **∝ 游标位置到第一个命中之间的距离**：

- 开头很便宜（命中密集）；
- 越接近尾声越贵（全库只剩几张待重跑时，每批都要从高位一直扫到底）；
- 而它是**同步** SQL，堵的是主进程 —— 用户看到的是「界面忽然卡几十秒」。

补全那边实测过一模一样的形状：**每轮白扫 75.7 万行 / 159.6 s 主线程阻塞**。
结论：这条形状在百万行库上不可用，**不是调参能救的**。

### 队列怎么把它变成 ∝ 批大小

把「筛选」和「取批」拆成两件事，筛出来的结果**物化**下来：

| 阶段 | SQL 形状 | 代价 |
| --- | --- | --- |
| 登记 | `INSERT OR IGNORE INTO thumb_regen_queue (id) SELECT id FROM photos WHERE id > ? AND id <= ? AND has_thumbnail = 1 AND (<规格谓词>)` | 有界 id 区间扫描，每 40,000 行一个票据 |
| 抽干 | `SELECT … FROM thumb_regen_queue q LEFT JOIN photos p ON p.id = q.id WHERE q.id <= ? ORDER BY q.id DESC LIMIT ?` | `SEARCH q USING INTEGER PRIMARY KEY`，∝ 批大小 |
| 收尾 | `DELETE FROM thumb_regen_queue WHERE <json_each(id 列表)>` | ∝ 批大小 |

登记是**有界**的：`id > ? AND id <= ?` 让它每次只扫一个 id 窗口，看不到全表。
抽干里**刻意不带任何规格谓词** —— 队列本身就是筛选结果，再筛一遍等于把「距离」这个
不可控量重新引回来。这条约定写在 `src/main/thumb-regen-queue.js` 头部，改它之前先读那段。

### 🔴 删除必须按「这一批取到的 id 列表」，不许按 id 范围

第一版写成 `DELETE FROM thumb_regen_queue WHERE id <= ?`（`?` = 本批最小 id）。
**守护自测当场抓到**：夹具里第二次登记剩 1 行，抽干后却只剩 0 行。

原因：**队列是稀疏的**。`id <= cursor` 这个范围里除了刚取走的那批，还留着**更小 id、
尚未轮到**的行 —— 它们被静默吞掉，表现为「进度条走到 100%，但库里还有一片行是新规格之外」。
现在删除走 `src/main/sql-id-list.js#idListPredicate()`（`json_each` 单参数，顺带避开
SQLITE_MAX_VARIABLES=32766 那个坑），`thumbRegenFinishBatch(ids, delta)` 收 id 数组。
守护里有一条专门的断言 + 注释记着这次翻车。

### 🔴 被删掉的 id 必须**都是做完了的**：抽干一批 = 原子批（2026-10-08 修，真库实测漏 42 行）

「按本批取到的 id 列表删」解决了**范围**问题（上一节），但留了一条**语义**口子：那份 id 列表是
**取批时**装好的，删的时候并不核对「这一批到底做完了几张」。于是只要有**任何**提前退出，
没轮到的行就被**连坐删掉**：

- `done` 照样加满（`thumbRegenFinishBatch` 按 `info.changes` 累加）；
- 那些行的规格**没换**（还是旧的 `256/jpeg` 或空规格）；
- 它们已经不在队列里 ⇒ **永远不会被重跑**。

真库实测（目标 `512|webp`，队列剩 104 万行的中途）：`done = 614,600`，而真正换过规格的只有
614,558 —— **差 42 行**，落成 **3 段连续 id**（5 / 10 / 27 行），且**全部落在已抽干区**
（`id > 队列上界 1,362,477`）。每段的上方邻居（同批已处理）与下方邻居（下一批已处理）都已是
新规格 ⇒ 形状正是「一批的尾巴被整批删掉」。**`failed` 是 0** —— 它栽在失败分支**之外**，
所以既不报错、也不写日志，界面上 `done` 与队列还彼此自洽。

**触发它的那一行曾经是**（`main.js#regenerateRowsWithConcurrency` 的 worker 开头）：

```js
while (true) {
  if (thumbnailRebuild.cancelled) return;   // ← 逐行退出，而调用方删的是整批
  var my = next++;
```

⇒ **取消只在批次边界生效**（`runThumbRegenDrainPass` 的 `while (!thumbnailRebuild.cancelled)`），
批内必须把 `rows` 抽干。这本来就是 `cancel-thumbnail-rebuild` 那条 IPC 注释声明的语义
（「任务在**批次边界**自行收尾，与补全同一条」）—— **注释是对的，实现没跟上**。

批内唯一允许放弃的是「这一行在 `photos` 里已不存在」（`!row || !row.file_path`）：那种行由调用方
按 `missing` 记账，本来就没有活可干。⚠️ 也**不要**为了省事改成「只删已处理的 id + 把游标退回去」：
游标语义与 `missing` 记账要跟着各改一处，等于把「删除判据」拆成两份 ——
本项目对「两边各写一份」的判词是**静默失效**。

**守护**：`scripts/thumbnail-regen-regression.js#checkDrainBatchAtomicity`，三条独立断言（走 `acorn`，剥注释）。

| # | 断言 | 掉了会怎样 |
| --- | --- | --- |
| ① | worker 循环体里没有「test 提到 `cancelled` ⇒ return / continue / break」 | 取消一次吞掉一批的尾巴，**界面上完全看不出来** |
| ② | 调用方仍按 `batchIdList`（本批取到的全部 id）删，且 `batchIds` 逐行收全 | ① 的前提没了（改按 id 范围删 = 回到上一节那次翻车） |
| ③ | 取消仍挂在**批次边界**（`while (!thumbnailRebuild.cancelled)`） | 停止按钮失灵（要等整条队列跑完） |

牙齿 4/4（含 1 条阴性对照）：M1 把 `if (cancelled) return;` 加回去 → 红在①；
M2 改成 `batchIdList.slice(0, 10)` → 红在②；M4 去掉边界取消 → 红在③；
M3 往批内塞一条**写着这句代码的注释** → **仍绿**（证明断言不读注释）。四次注入均逐字节还原。

⚠️ **代价**：「停止」最多多等一批（`THUMB_REGEN_DRAIN_BATCH = 50`，实测约 7 s）。拿它换「不漏行」是划算的。

⚠️ **已经漏掉的行不会自愈**：`isQueueReusable()` 在签名相同 + `phase='done'` 时会让登记阶段直接
返回（刻意不重扫全库），于是再点一次「重建全部缩略图」会**秒完成**而不登记任何行。要收它们回来，
只能让签名失配（换一次档位**再换回来**、或把 `thumb_regen_meta.signature` 置空）⇒ 整条队列重登记，
而登记谓词只挑「仍不符规格」的行 ⇒ 实际只有那几十行进队列、抽干是秒级。

### 进度与续跑

- 分母是**精确值**：`thumb_regen_meta`（单行，`CHECK (k = 1)`）里的 `total` 是登记阶段累计的
  `INSERT` 数，不是抽样估值。这与补全那边「分母只能是抽样估的候选集规模」不同 ——
  那里候选集是**每次现算**的，这里是我们自己写进去的。
- 因此关掉应用再打开能**续跑**（游标、已完成数、失败数都在 meta 里），不会从头登记。
- `targetSignature` = `'<档位>|<格式>'`，**刻意不含画质**：`isQueueReusable()` 拿它判「这条队列
  还是不是当前目标的」。理由是对称的 —— 用户改档位时整条队列确实作废（追的目标变了），
  而改画质不该让几十万行的登记白做（画质只影响字节，不影响「哪些行需要重跑」）。
- **不在启动时自动续跑**（有意）：小时级任务会和用户的浏览抢同一块外接机械盘。
  状态在库里，丢失的只有「自动开始」这件事。

### 🔴 两套口径不许串：`thumb_regen_meta` 是**跨重启累计**，其余进度都是**本次进程**（2026-10-08 落地）

**这条队列是全工程唯一一个「进度会跨重启累计」的地方。** 判据是「这个数存在库里还是只在内存里」：

| 读数 | 存在哪 | 口径 |
| --- | --- | --- |
| `thumb_regen_meta.done` / `failed` / `missing` | 库（meta 表，`thumbRegenFinishBatch` 按本批真正删掉的行数累加） | **跨重启累计** |
| `thumbnailRebuild.startedAt` + 五项顺手产出（`sized`/`exifChecked`/`exifFilled`/`dhashed`/`hashed`） | 内存，起手归零 | **本次进程** |
| 补全的 `thumbnailBackfill.done`；`invalidCleanup.checked`；`dupHash.d`；`folderScan.spCur` | 内存，起手归零 | **本次进程**（所以它们没有这个毛病） |

⇒ **任何「本次产出 / 本次速率」都必须先减去起手快照**。用户 2026-10-08 连报的两条
（「**预计时间不对**」→「**错了，已完成的不是这一次跑的**」）是**同一个根因**的两次暴露：

- ETA：`estimateEtaSeconds` 的速率是 `done / (now − startedAt)` ⇒ 分子累计、分母本次。
  真库实测重启续跑 21 分钟时算成 **305 张/秒**（实测 17）⇒ 界面「预计剩余约 1 小时 9 分」，
  真实 **20.7 小时**。**差 18 倍却看着合理** —— 这才是它危险的地方。
- 产出：把累计 `done` 当「已重出」报 ⇒ 本次刚起 21 分钟，界面写「已重出 387,250」，
  其中 **37 万是上一个进程做的**。

**落地形状**（`main.js`）：状态里三个 `doneAtStart` / `failedAtStart` / `missingAtStart` 快照，
**不持久化**，起手在 `isQueueReusable` 那次恢复**之后**取一次；`getThumbnailRebuildProgress` 里
算 `sessionDone` / `sessionFailed` / `sessionMissing`（各自夹 `>= 0`）⇒
`rebuiltThisRun = sessionDone − sessionFailed − sessionMissing`（`done` 里含失败与 missing 两类，
所以要减两次），并把 `doneThisRun` / `failedThisRun` / `rebuiltThisRun` 放进**进度白名单**。

**三条不许动的规矩**：

1. **快照必须在恢复之后取** —— 取在前面恒为 0，等于没修（ETA 仍按整条队列算）。
2. **快照不许从 `meta.*` 恢复** —— 那就恒等于累计量、差值恒为 0 ⇒ `done < 1` 让 ETA
   **永远为 null**、且「本次已重出」恒 0 **永远画不出来**。两种都比算错更难发现（界面上只是少点东西）。
3. **减法只许有一处** —— 渲染端只读主进程算好的 `*ThisRun`，**不许**自己拿 `done − failed − missing`
   再减一遍（两处减 = 两个口径，迟早不一致）。

**副行整条一律本次口径**（2026-10-08 用户纠正后统一）：同一条副行里一半累计、一半本次是**最难读的形状**。
累计值仍然可见，但它的正确去处只有两处 —— **主行的 `done / total`**（总账）与**空闲态设置页**
那句「已全部重建（共 N 张）」。⇒ 重启后「本次已重出 = 0 而主行 = 40 万」是**正常的**，不是数据不一致。

守护 `thumbnail-regen-regression#checkSessionScopeAndEta()` 把三条规矩 + 白名单 + ETA 的**调用实参**
全钉住；`checkMetadataMergeWiring()` 里另有一条**反向**断言（渲染端禁止出现 `thumbRebuild.done/failed/missing`）。
⚠️ **口径一改，钉旧形状的断言必须同时翻面** —— 否则守护会替被否掉的旧实现站队。

### 🔴 副行那四项为什么能长期是 0：不是没统计，是「这一段真没得补」（2026-10-08 实测）

用户原话：「重建全部缩微图，现在一直显示拍摄信息 0，计数对吗」。**答案是「对」。**
三条独立原因叠在一起，任何一条单独看都像是坏掉：

**① 视频行不进这四项。** `main.js#regenerateRowsWithConcurrency` 的四道门一律写成
`var needX = !isVideoRow && …`。而视频行的 `exif_mtime` **恒为 NULL**（没人给视频读拍摄参数），
`db.photoNeedsExif()` 对视频**恒真** ⇒ 少了 `!isVideoRow`，「拍摄信息」会涨的全是**不存在的活**
（只多不少、不报错，看起来像「补得很成功」）。
真库实测：重建游标**上方**那段（id > 1,273,419）`needExif` 共 **37 行，全部是视频，图片 0 行**
⇒ 这一段 `exifChecked` / `exifFilled` 本就该是 0。
⚠️ 判据要说准：**`needExif` = 「队列里这一行缺 EXIF」，不是「这一行不该有 EXIF」。**
`checkMetadataMergeWiring()` 已把四道门逐门钉住（`var needX = !isVideoRow &&`）。

**② 四项是「本次进程」口径**（见上一节）⇒ **重启即归零**。用户看到的 0 = 「自本次启动以来没补到」，
不是「整条队列一张都没补」。

**③ 两条倒序任务的前沿错位，而且互相堵。** 图片 EXIF 的唯一来源是**补全**，它与重建都是
**主键倒序**推进；而 `thumbnailBackfillBlockReason()` 与重建**双向互斥**
（`main.js:3740`：`if (thumbnailRebuild.running) return '缩略图重建进行中，请稍后再试'`）
⇒ **重建一跑，补全就停**，图片 EXIF 前沿当场冻住。
真库实测（20:40 / 20:42 各采样一次，间隔 80 s，五个 2 万段**全部一字未动**）：
重建游标 **1.273M**，图片 EXIF 前沿 ≈ **1.214M** ⇒ 重建是在补全**后面**追。
⇒ 只要重建还没越过补全的前沿，这一段**结构上**就不存在「缺 EXIF 的图片」，`+0` 不是故障。

**将来会涨，而且是暴涨**（同一次实测，每 2 万段抽样「图片 needExif」）：

| id 段 | 图片 needExif | 占该段 |
| --- | --- | --- |
| 1,240,001 ~ 1,260,000 | 0 | 0% |
| 1,220,001 ~ 1,240,000 | 1 | ≈0% |
| 1,200,001 ~ 1,220,000 | 6,243 | 31% |
| 1,180,001 ~ 1,200,000 | 18,790 | 94% |
| 1,000,001 ~ 1,020,000 | 18,866 | 94% |
| 800,001 ~ 820,000 | 19,681 | 98% |
| 600,001 ~ 620,000 | 19,557 | 98% |
| 400,001 ~ 420,000 | 19,329 | 97% |

⇒ 游标一越过 **≈1.214M**，这一项会在几十分钟里从 0 涨到「每 2 万行近 1.9 万」，最终量级 ≈ **80 万**
（与「补全第二支 857,372 行缺 EXIF」同源 —— 那批活现在**改由重建顺手做**，所以重建跑着时补全被堵不是浪费）。
⚠️ `exifChecked ≥ exifFilled`：后者还要求 `hasAnyExifField(header.exif)`，
**本来就没有 EXIF 的图**（截图 / 部分 PNG）只涨前者。副行只画 `exifFilled`
⇒ **别拿它当「读过多少张」**（要看「读过」得把 `exifChecked` 也画出来，现在没画）。
⚠️ 速率实测 5.6~7.9 行/秒（会随盘况抖动）⇒ 越过 1.214M 约 **2~3 小时**；剩余 94.8 万行 ≈ **1.5~2 天**。

### 准入：三个长任务必须两两互相看得见

`thumbnailRebuildBlockReason()` 是**唯一**判据，IPC 入口与任务内部共用（理由同补全：各写一份
的下场是「IPC 返回 `success:true` 而任务静默 return」）。它与补全是**双向**互斥的。

🔴 本轮真的漏了一条：新闸挡住了补全与查重，但**查重那边没有对称地挡回来** ——
「先起重跑、再起查重」的窗口一开，点下去就是「什么都没发生」。
`thumb-dup-admission-parity-regression` 已从「两个闸」扩成「三个闸 + 状态矩阵」：
矩阵里任何**单向**挡住的组合都会红（新增第 4 个长任务只需要进那张表，不用再抄断言）。

---

## 🔴 浏览层的缓存键必须随缩略图规格变化（2026-10-07 落地）

### 症状与成因

重建跑完了，界面还是旧档位的图 —— 而且**看起来完全正常**（图是好的，只是旧的）。

成因是缩略图重建**不动原图**：`file_size` / `date_modified` 一个字节都没变，
所以按它拼出的 URL 在重建前后**逐字相同**。而两条客户端缓存都不会去问服务端「变了没」：

- 网页端 `/thumb/:id` → `Cache-Control: public, max-age=86400`；
- 桌面端 `thumb://<id>` → Chromium 的内存缓存（没有显式头也照样缓存）。

⇒ 只能靠 **URL 变化**来失效。于是键里必须带**这一行自己的规格**：

```
?v = <file_size><date_modified 的数字>-<thumb_size><thumb_format>
        └── 原图字段（换了原图，缩略图也该失效）  └── 规格（换档 / 转格式）  └── '' = 未知
```

三份实现（不共享代码，只能各留一份）：桌面 `src/renderer/utils.js#thumbCacheVersion`
（唯一真相源，`preview-flow` / `ui-grid` / `ui-duplicates` 都转发它）、
网页 `src/web/js/app.js#thumbCacheVersion`（`ai-views.js` 先于它加载，所以走 deps 注入）、
安卓 `android-app/.../model/Photo.kt#thumbnailUrl()`。守护第 4 组断言三者都随规格变化、
且桌面与网页**同形**。

混规格库（重建进行到一半）里这正是要的行为：**重建过的行换一个新 URL，还没轮到的行继续
命中旧缓存**。这也正是「浏览层支持混规格缩略图」这句话落到代码上的样子。

### 🔴 规格必须从列表行里带出来（15 处 SQL 字面量收敛成一处）

键要 `thumb_size` / `thumb_format`，而**列表查询一直没取这两列**（服务端那侧早就认识了，
见上一节）。这是「字段传播链少带一个字段」的又一个实例，症状同样静默。

顺手把「哪些列会发给界面」从 **15 处彼此抄写的 SQL 字面量**（`database.js` 12 /
`db-heavy-read.js` 2 / `main.js` 1）收敛成唯一真相源 `src/main/photo-list-columns.js`。
`lite`（去掉 `file_path`）与 `liveMotion: false`（去掉 `live_motion_id`）是**只减不加**的两个子集。

### 封面单独一条约定（别「顺手统一」）

三条封面查询的主体是 `ROW_NUMBER() OVER (PARTITION BY folder_path)`，它会把**整棵子树**的行
物化一遍（真库单根 90 万行、实测数分钟）。把基线列清单整个塞进去 = 物化宽度 +8%，
白等十几秒；而封面只有**每目录一行**。所以封面走 `thumbSpecColumnsPrefixed()`：
**最终 SELECT 上按主键回查**那两列（计划里是 `SEARCH p USING INTEGER PRIMARY KEY`，
几千次 PK 探针 = 微秒级）。守护第 3 组钉住「封面 SQL 里出现 `photoListColumns()` 就红」。

另外「封面行」是**手写白名单对象**（`folderCoverRow()`），SQL 里取了、白名单里没写就一样到不了
界面 ⇒ `FOLDER_COVER_FIELDS` 与白名单的键被逐位比对（守护第 2 组）。

### 缩略图与原图用两个键（反向也要守）

`photo://` / `/photo/` / `/preview-image/` **继续**用原图键。若跟着改成缩略图键，
「重建缩略图」会把**原图预览**的缓存也一起作废 —— 一次本不该发生的全量重拉。
守护第 4 组有反向断言。

### ⚠️ 残留（有意保留）

单独调**画质**（档位与格式都不变）再重建时，这两列不变 ⇒ 键不变 ⇒ 客户端可能继续显示
旧画质，直到缓存自然过期（网页端 ≤24h、桌面端到下次重载）。

把「当前设置里的画质」也并进键能修掉它，代价是给浏览层加一条**设置依赖**：首帧还没拿到设置时
URL 会「先无后有一套」，白拉一遍。判定为不划算，所以留着并写在这里 —— 免得下次被当成 bug 查。

### 反向验证（摘掉就红）

- 把卡片 URL 改回 `'thumb://' + photo.id`（不带键）⇒
  `FAIL: src/renderer/ui-grid.js 里有一处 … 没带 ?v= 缓存键`；
- 从 `PHOTO_LIST_FIELDS` 里删掉 `thumb_size` / `thumb_format` ⇒
  `FAIL: getPhotos 的行缺 thumb_size —— 客户端拼不出会随重建变化的缓存键`；
- 把封面改成整份基线清单 ⇒ `FAIL: 三条封面查询…都必须用 thumbSpecColumnsPrefixed()`。

### 🧠 记忆层红线（2026-10-09 从 `MEMORY.md` 迁入）

🔴 **迁移判据是 `thumb_format <> 'webp'`**（不是「有没有缩略图」）：`thumb_format` 走**白名单归一化**
（`thumb-format.js#THUMB_FORMAT_WHITELIST = ['jpeg', 'webp']`），写进去一个 `'webP'` / `'WEBP'` 会让那一行
**永远命中迁移谓词** ⇒ 同一张图被无限重做（而它的缩略图其实早就是 webp 了）。

存量行的 `thumb_size = 0` / `thumb_format = ''` **天然命中**该谓词（`0 <> 512`、`'' <> 'webp'`）——
这是**有意**的（它们是「从未生成过」的行），别当 bug「修」掉。

🔴 **已知取舍：自研解码格式（`sharp-input.js#OWN_DECODER_RAW_EXTENSIONS`）也走第二趟取批。**
第二趟是 `getPhotosMissingThumbnailsBefore`（全工程唯一「谓词无索引 + 倒序 LIMIT」的路径），
这批格式由 `src/main/image-decoders/` 自研路解码、单张更慢，但**刻意不为它们加排除谓词** ——
那会让「谁该补缩略图」出现**第二份口径**，而口径分叉比慢更贵（见「候选谓词与处理判据必须同源」）。

🔴 **长任务准入判据只允许一份，且任何拒绝都必须 `logger.warn`。**

- 判据的唯一源 = `main.js#thumbnailBackfillBlockReason()` / `#duplicateHashBlockReason()`，
  **IPC 入口与任务内部共用同一处**。两个入口各写一份的下场是：IPC 返回 `{ success: true }`，
  任务却在 `setTimeout` 里静默 `return` —— 界面刷新后显示「未运行」，**两边谁都不报错**。
- 拒绝**必须 warn 级**：生产档 `logger` 就是 `warn`（见「冷区红线」），用 `info` 等于零现场，
  而用户只会说「点了没反应」。源码里三处拒绝点都写着 `logger.warn('[...] skipped: ' + blockReason)`
  （`runThumbnailBackfill` / `runThumbnailRebuild` / `runDuplicateHashDetection`）、
  IPC 侧那条是 `'[start-thumbnail-backfill] rejected: '` —— 改级别等于把这条线索抹掉。
- 守护 `thumb-dup-admission-parity-regression`（已从「两个闸」扩成「三个闸 + 状态矩阵」）
  与 `maintenance-guard-regression`。
