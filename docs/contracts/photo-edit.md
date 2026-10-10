# 图片编辑契约（P0 旋转 / 翻转写回 · P1 裁剪入库 · P2 预览态编辑）

> 唯一正文。`CONTRACTS.md` 只留指针（该文件已停增新章节）。
> 守护：`scripts/photo-edit-regression.js`（**172 项**，已注册；其中行为组真跑临时库+临时目录）。
> 牙齿验证：**42 条变异全过**（每条故意改坏 → 只红预期的那几条 → sha1 逐字节还原）。
> 用户诉求原话：「做 P0、P1，需要写回，裁剪产物进表，导出不做、转 webp 不做」；
> P2 原话：「旋转需要确认才写入变化」⇒ 经确认：确认形态 = **先预览、点保存才写回**（不是弹窗二次确认），范围 = **旋转 + 翻转 + 裁剪**。
> 分工：`src/main/image-edit.js`（像素→字节，唯一实现源，两端共用）/ `src/main/photo-edit-service.js`（编排：重算派生+更新库行+清缓存，两端共用）/ `main.js` 与 `web-server.js`（只接协议）。

### 🔴 写这类断言时踩过的四种「假绿」（牙齿验证抓出来的，别重犯）

| 形态 | 坏在哪 | 正确写法 |
|---|---|---|
| `indexOf('photoEditApply') >= 0` | 被 `photoEditApplyX` **子串命中** ⇒ 名字整体改错仍全绿 | `new RegExp('\\b' + n + ':\\s*function')` |
| `/\bresume\(\)/` 当作「有调用点」 | 被**定义** `function resume()` 自己满足 ⇒ 删掉唯一调用点仍全绿 | 判**出现次数 ≥ 2**（1 定义 + 1 调用） |
| `webAppCode` 里有没有 `state.previewEditCssTail` | 那个符号在 state 声明 / `repaintPreviewEdit` 里到处都是 ⇒ 把 `updatePreviewTransform` 里的读取删掉仍全绿 | 先 `functionSource(...)` 取**函数体**再判 |
| `/onlyWhilePending/` 当作「两个键都把住了」 | 摘掉**一个**按钮的开关，函数体里还有另一个 ⇒ 仍全绿 | 判**恰好 2 处** `onlyWhilePending:\s*true` |
| `functionSource(...)` 结果不判空 | 函数被删除/改名后切出**空串**，`''.indexOf('照片') < 0` **恒真** | 先 `body.length > 0` 再判内容 |

⚠️ 另有一条**结构断言读注释**的坑：`functionSource` 切的是**原始源码**（不去注释），所以
「函数体不许出现 `previewRotateDeg`」会被一句解释性注释满足、也可能被它**恒红**（本轮前者踩到、
后者也被 `cyclePreviewRotate` 那条踩到）。凡「某符号已删 / 函数体不再出现某词」类断言，
一律喂 `code(...)` 剥过注释的那份源码（见 `previewUiCode`）。

### 🔴 七处会同时失效的链路（任何一处漏 = 静默）

① **方向代数**：`EXIF orientation(1–8) + 用户动作` 必须合成**一条** sharp 算子。
  `ORIENTATION_DECOMPOSITION` 的语义是 `正确显示的像素 = R_a ∘ Fh^p ∘ Fv^q`，**不变量：p 与 q 不同时为 1**（`Fh∘Fv=R180`，归一化成纯旋转）。
  - 🔴 **5 与 7 的旋转角与直觉相反，真写错过**：5（transpose）= `R270 ∘ Fh`、7（transverse）= `R90 ∘ Fh`。第一版按「5 在前所以 90」写成 90/270，8 档里恰好只错这两个 ⇒ 只有带方向且翻转时才歪，静默。
  - 🔴 **sharp 的执行顺序是「flip/flop 先、rotate 后」**（实测，反直觉）：`p.rotate(90).flop()` 算的是 `Fh ∘ R90`。要表达「先按 EXIF 转正、再做用户翻转」必须把角度**取反补偿**（`F∘R_a = R_{-a}∘F`）。实测 `p.rotate((360-a)%360).flop()` 与两步法**逐字节相同**（8 组全过）。
  - `.rotate(angle)` 显式给角度时 sharp **不读 EXIF**；只有 `.rotate()` 无参才按 EXIF 转。所以本模块自己解 EXIF 再合成。
② **写回原子性**：同目录临时文件（`TMP_SUFFIX`）+ `rename`。禁原地截断写（中途失败 = 半个文件）。
③ 🔴 **输出必须 `orientation = 1`，且必须显式设**：`encodeToFormat()` 是唯一出口，`withMetadata({ orientation: 1 })` 收在那里。
  - 不调 `withMetadata` ⇒ sharp **剥掉全部元数据**（实测 orientation 读回 `undefined`，拍摄时间/GPS/相机型号/ICC 全丢 = 图库级数据事故）；
  - 设了 1 之后像素已物理转正，若还留着原方向（如 6），`thumb-format.js#resizeThumb()` 里的 `.rotate()` 会**再转一次** ⇒ 缩略图转 180°、而原图是对的。
  - ⚠️ 任何调用点都**不许**自己写 `.jpeg()` / `.png()` —— 那是「有的路径归一化了、有的没有」的起点。
④ **派生数据四件套**：缩略图 / dHash / 尺寸 / 文件级元数据（`file_size` + `date_modified`）必须一起更新，在 `photo-edit-service#writeDerivedToRow`。
  - 🔴 `date_modified` 必须是 `scanner.js#formatMtimeFromDate` 那个格式（`YYYY-MM-DD HH:MM:SS`）：`thumb_fail_mtime` / `header_fail_mtime` / `exif_mtime` / `dhash_mtime` 四列记账都拿它做判据，**差一个字符 ⇒ 那几行被后台任务无限重试**且无任何报错。守护逐字对账两份实现。
  - 🔴 `computeDhashFromPipeline` 必须取在 `resizeThumb` **之前**（后者消费 sharp 实例）。
⑤ **指纹失效**：`transform` 必须 `updatePhotoHash(id, null)`。不清 ⇒ 「精确重复」分组里混进一张已经改过的图。
⑥ 🔴 **缓存键翻新**：界面的预览/缩略图 URL 键 = `file_size + date_modified`（`utils.js#photoCacheVersion` / `web/js/app.js#photoCacheVersion`）。
  **两端** `savePreviewEdit` 都要就地写回这两个字段并 `openPreview(state.previewIndex)`。
  - 不回给渲染端 / 只回 `size` ⇒ URL 不变（**翻转对称图、180° 旋转完全可能产出同样大小的文件**）⇒ 浏览器命中旧缓存 ⇒ 用户以为没生效、**再点一次又转 90°**。所以 `transform()` 的返回值必须带 `dateModified`，**IPC 与 HTTP 两条通道都得带**（守护按对偶钉）。
⑦ 🔴 **裁剪产物要进表成为正常行**：`insertPhoto` 是 `INSERT OR IGNORE`。
  - `loadEditableRow` 必须用 `database.js#getPhotoForEdit`（10 列：含 `id` / `root_id` / `date_taken`），**不许用 `getFullPhoto`** —— 后者只 SELECT 四列（`file_path, file_name, width, height`）⇒ `db.updatePhoto*` 全部影响 **0 行**、`insertPhoto` 因 `root_id=undefined` 撞 NOT NULL 被 OR IGNORE **静默吞掉**。真发生过一轮：库里 width/height 停在 0x0、无缩略图、dhash 为 null，而**静态断言一条都不红**（列名都在、调用都在）。只有真跑一遍才看得见 ⇒ 守护的行为组是它的一半。
  - 🔴 禁 `lastInsertRowid`（OR IGNORE 被忽略时那是**连接级上一次插入**的 rowid，可能指向别的表）⇒ 用 `getPhotoIdByFilePath`，且 `newId === 原 id` 时抛错。
  - 新行 `date_taken` **跟随原图**（不取落盘时间，否则每次裁剪都在「今天」多一张）；落 `derived_from`（0 = 原始，>0 = 派生来源 id）。
  - 相机/EXIF 列**不复制**：它们的「已读」标记是 `exif_mtime`，新行为空、后台补全自己补 —— 手工复制反而要维护一份列名映射。
  - 🔴 P2 起 **`createCropCopy(row, rect)` 是「裁剪落库」的唯一实现**，`crop()` 与 `applyEdit()` 都只调它（守护双向钉：两个函数体里都得出现 `createCropCopy`、且不许各自重写一遍插行/更新）。任一边复制一份，上面那次静默就会以「只有其中一个入口中招」的形式复现 —— 更难点。

### 拒绝路径（判据是**扩展名**不是 sharp 的 format）

- 🔴 `createSharpInput()` 对 cr2/crw/cr3 会抠出**内嵌 JPEG 预览**，读出来的 `format` 是 `jpeg` ⇒ 只按 format 判会放它过去并把预览图**写回 .cr2**（毁原片）。所以 `DENIED_EXTENSIONS` + `denyReason()` 先按扩展名拦。
- `DENIED_EXTENSIONS` = 三个清单的并集，**必须同步**：`main.js#RAW_EXTENSIONS`（7 个）+ `sharp-input.js#OWN_DECODER_RAW_EXTENSIONS`（crw/cr3，main.js 那份里没有）+ 非编辑语义（gif 丢动画、svg 是文本）。守护逐项对账并集。
- 视频由 `photo-edit-service` 按注入的 `videoExtensions` 拒（`'.mp4'` 形态，带点小写）。
- 可编辑格式白名单 `EDITABLE_FORMATS = ['jpeg','png','webp','tiff','avif','heif']`（6 个，守护钉数量）。

### 并发

🔴 **编辑一律全局串行**（`photo-edit-service` 内 `queue = Promise.resolve()` 链）。理由不是性能而是正确性：「写盘 → 读回算派生 → 更新库行」**不是原子的**，两次并发编辑同一张图会互相覆盖（后一次算派生时读到的可能是前一次刚写的字节）。编辑是低频用户操作，串行零代价。

### 两端 UI 两份实现（网页端拿不到渲染端模块）

- 桌面端 `src/renderer/preview-crop.js`（`RendererPreviewCrop`）/ 网页端 `src/web/js/app.js` 里的 `webPreviewCrop`。**同参由守护逐项对账**（不靠人记得改两处）：最小边长 `24`、初始选区居中占 `0.8`、四角顺序 `['nw','ne','se','sw']`、`data-corner`、resize 即退出、Esc 取消 / 回车确认、拖四角改的是「边」不是「中心」、先退出再回调。
- 🔴 **裁剪是模态键盘态**（P2 起只在「未确认」阶段模态，见下章）：`window` **捕获阶段**监听 keydown。不吞 ⇒ 按一下方向键 = 图换了、选框还留在原地（坐标全错且不报错）。
- 🔴 **换图 / 关预览都要先收掉选区**：两端 `openPreview` 与 `closePreview` 各一条 `previewCrop.exit()`。选区层挂在 `body` 上，不随预览层消失。
- 层用 `position: fixed` + 视口坐标（`.preview-body` 链上有 transform/overflow，absolute 会错位）；`z-index: 15050`（> 预览层 1000、网页端首屏 loading 12000；< 照片对比 100050）；遮罩用 `box-shadow: 0 0 0 9999px` 一笔画（不比四块暗 div 漂移）；三分线 `pointer-events: none`。
- 进入裁剪先 `resetZoom()` **再**测量 rect（带着缩放平移换算，等于每个拖动事件重解一次逆变换）。
- 🔴 几何**唯一入口是 `viewRect(el, angle)`**（P2 新增，原因见下章「元素盒 ≠ 图片盒」）：`currentRect` / `paint` / `selFromRect` 全部用它给的比例，**不许**再出现 `naturalWidth / frame.width` 那种硬算（守护正反双向钉）。
- 编辑按钮只在静止图片上亮，**裁剪进行中只留裁剪键**（另外两个藏起来：半路换掉选区再点旋转，用户看到的图与选框对不上）。两端同名函数 `syncPreviewEditButtons`，但**显隐机制刻意不同**——不是笔误，各自受本端 CSS 约束：
  - 网页端按 `isWebVideoFileType(photo.file_type)`，用 **`hidden` 属性**，配兜底 `.preview-action-btn.preview-edit-btn[hidden] { display: none }`。那条兜底**不能删**：`.preview-action-btn { display: inline-flex }`（0,1,0）是作者样式，按层叠规则压过 UA 的 `[hidden] { display: none }`（元素级，UA 层永远输给作者层），只设属性藏不住。
  - 桌面端按 `isVideoFile(photo)`（它吃**整条照片行**，会先看 `media_type`），但**只能用行内 `style.display`**：三个按钮带 `.btn.btn-sm`，而 `.preview-controls-group > .btn.btn-sm { display: inline-flex }`（0,3,0）既压过 UA 的 `[hidden]`，**也压过任何 `.xxx[hidden]` 兜底（0,2,0）** ⇒ 补兜底在这边救不回来。同组 LIVE 按钮同理（`ui-preview.js#syncLiveButton` 也是行内值）。
  - 🔴 守护把桌面端**反着钉死**：函数体必须出现行内 `display`、且**不许出现 `setAttribute('hidden')`**；连同两条**前提断言**（按钮确实带 `.btn.btn-sm` + 那条让 `[hidden]` 失效的规则确实存在）——前提一旦被重构掉，守护转红提示「这条理由过期了」，而不是让注释悄悄说谎。
  - 回调位置：`preview-flow.js` 里**紧挨** `onSyncPreviewLiveButton(photo, isVideo)`。🔴 必须随**每一次**切图跑：只写在 `openPreview` 里覆盖不到「左右切换」。与 LIVE 按钮一样**刻意不做成必需回调**（漏传只是按钮不置灰，不该让整个预览 `return`）。
- 网页端三个编辑入口函数显式挂 `window`（内联 `onclick` 需要，也顺带让 lint 看得见）。

### P2 预览态编辑：**先预览、点保存才写回**（本批）

用户原话：「旋转需要确认才写入变化」。点旋转 / 翻转 / 裁剪**只在预览里变换，不碰磁盘**；工具条出现「保存 / 放弃」，点保存才一次性写回。

**状态形状**（两端**逐字同名**，改一处必改另一处）：

| 字段 | 含义 |
|---|---|
| `state.previewEditPendingActions: []` | 按**点击顺序**攒的动作串（`rotate-right` / `rotate-left` / `flip-h` / `flip-v`） |
| `state.previewEditCssTail: ''` | 由动作串**逆序**拼出的 CSS 变换尾巴 |
| `state.previewRotateDeg: 0` | 旋转角**和**（归一化到 `[0,360)`），只用来判「是不是 90 的奇数倍」⇒ 布局要不要对调宽高 |

🔴 **基石：CSS `transform` 与 sharp 同构 —— 不写第三份数学。**
两边的求值顺序**都是「最右先作用」**：
- CSS：`transform: rotate(90deg) scaleX(-1)` ⇒ 先 `scaleX(-1)`、再 `rotate(90deg)`；
- sharp：`flip/flop` 先、`rotate` 后（反直觉，实测，见①）。

⇒ 把用户点击的动作按**逆序**原样拼进 `transform` 字符串，就与后端逐像素等价。
- 🔴 **不许在前端做代数合成**：`image-edit.js#composeAction` 是唯一实现源，前端再写一份「旋转+镜像」的合表，就有两处会漂。
- 🔴 两端 `PREVIEW_EDIT_ACTION_CSS` / `PREVIEW_EDIT_ACTION_INVERSE` 两张表必须**逐字相同**（守护按字符串全等钉）⇒ 同一串动作在两端预览必须出同一张图。
- 附带好处：**点「相反动作」即抵消**（`list[last] === INVERSE[action]` ⇒ pop，不 push）。点错一下不用「放弃全部」重来。

**保存顺序（`photo-edit-service#applyEdit`，顺序不可交换）**

1. `normalizeActions(opts.actions, /* allowEmpty */ true)` —— 保存路径允许「只裁剪、不旋转」（变换路径仍不许空）。
2. 有动作 → `imageEdit.applyTransform(row.file_path, actions)`（写盘、原子替换）→ `computeDerived` → `writeDerivedToRow` → `updatePhotoHash(id, null)`。
3. 有裁剪 → `createCropCopy(row, rect)`。
4. 最后**统一** `invalidate(root_id)`（放在两个分支之外：只在一个分支里写 = 另一条路径不动列表）。

🔴 **先变换、再裁剪（顺序不可交换）**：`.extract()` 工作在 `rotate()` **之后**的坐标系 ⇒ 选框矩形就是「用户看到的那张图（已变换）」的坐标，前端**不需要**做任何逆变换。反过来写就成了「按未旋转的坐标去裁旋转后的图」——裁出来位置整体偏掉，且不报错。

**🔴 几何红线：元素盒 ≠ 图片盒（本批踩到并实测过的坑）**

`.preview-image` 是 `width:100%; height:100%; object-fit: contain` ⇒ 元素 AABB 撑满整个舞台，图片在其中**居中留白**。实测：`1178×719` 的元素盒里放一张 `400×300` 的图，图**实际只占 `958×719`**。
第一版裁剪代码直接量 `img.getBoundingClientRect()` ⇒ **选框盖住整块舞台、缩放算小 19%（裁出来比用户圈的小）**，而当时静态断言一条都不红。

`viewRect(el, angle)` 是唯一取几何的入口，四件事：
1. 按 `contain` 自算图片占据的那块（`Math.min(bw/nw, bh/nh)`）；
2. 按**元素中心**对齐（`getBoundingClientRect` 给的是元素盒中心，图片居中于它）；
3. 旋转 90/270 时**宽高对调**（`rot ? ch : cw`）；
4. 从 AABB **反推有效缩放** `z`（`offsetWidth` / `naturalWidth` 看不到 `transform`），给出 `scaleX/scaleY`。

🔴 守护带**前提断言③**：两端预览图 CSS 确实是 `object-fit: contain`。哪天换成 `cover`，`viewRect` 的算法就该跟着换 —— 前提断言转红是提示「这条理由过期了」，而不是让注释继续替代码作证。

**边界处置：离开当前图不许静默丢待保存的编辑**

- 四条用户出口全挂守卫：桌面端 `guardedClosePreview` / `guardedNavigatePreview` / `guardedOpenPreviewAt` / `guardedToggleSlideshow`（分别接进 `bindPreviewBasicControls` 与 `bindKeyboardShortcuts`）；网页端 `guardedClosePreview` + `navigatePreview` 开头 + 空格（幻灯片）。
- 🔴 **守卫刻意放在「用户意图点」，不放进 `openPreview` / `closePreview` 内部**：那两个也被**保存流程**与「查找相似」调用，在里面弹确认框会把调用方一起卡住（保存后重开当前张 ⇒ 自己弹自己的框）。
- 🔴 **唯一清空点** = 两端 `openPreview` / `closePreview` 里的 `resetPreviewPendingEdit()`。散在调用点必然漏；清在 `resetZoom` 里则更糟 —— 用户点「重置缩放」会把待保存旋转从**布局**上抹掉、CSS 变换却还在（图与留白对不上）。
- 🔴 网页端**历史回退**的 `closePreview(true)` **刻意不走守卫**：`popstate` 是用户已经按了后退键，此时再弹确认框等于「后退被吞」（浏览器地址栏已经变了）。守护反向钉住这条。
- 空着「保存 / 放弃」点一下 = 点了没反应 ⇒ 两个键都走 `onlyWhilePending`，由 `hasPendingPreviewEdit()` 统一判（动作串非空 **或** 裁剪 `isPending()`）。

**键盘 / 文案**

- `preview.rotate`（`R` / `Shift+R`）现在**只改预览**（`applyPreviewEdit` 只攒动作）。`title` 与 `preview.rotateTitle` 写「只改预览，保存才写回」。🔴 守护反向钉：`cyclePreviewRotateAction` 函数体里不许出现 `savePreviewEdit` / `photoEditApply`。
- 新增 `preview.editSave`（`Ctrl+S`，`scope: 'preview'`）。网页端在 `document` keydown 里接 `Ctrl/Cmd+S` 并 `preventDefault()`（不拦 = 浏览器弹「保存网页」）。
- `ui-preview.js#cyclePreviewRotate` **已删除**（上一批的「刻意保留」被本批回收：它当时是唯一的显示层旋转入口，现在旋转统一走 `applyPreviewEdit`）。`resetZoom` 里那行 `state.previewRotateDeg = 0` 也一并删除。守护两条**反向**钉：`ui-preview.js` 不许再出现 `cyclePreviewRotate`（读剥过注释的源码）；`resetZoom` 函数体不许出现 `previewRotateDeg`。

**裁剪交互随之变化：`commit()` 只记录**

- `commit()` 只做三件事：`s.rect = rect` / `s.committed = true` / `s.layer.classList.add('is-pending')` + 回调。**不 `exit()`、不调后端**（守护反向钉住这两条）。
- 🔴 `is-pending` 必须 `pointer-events: none`：该层用 `box-shadow: 0 0 0 9999px` 画遮罩，不吃事件的话**工具条被它盖住** ⇒ 点「保存」等于点在遮罩上（按钮看起来在、点不动）。
- 🔴 已确认的选区在窗口 resize 后**跟着重排**（`measure()` + `selFromRect(s.rect, s.view)` + `paint()`），不是整层丢掉；未确认态仍是 `exit()`。
- 🔴 键盘从「无条件模态」放宽到**两态**：`committed` 态只接管 Esc（`resume()` 回到可拖拽），且**不再** `stopPropagation()` —— 否则工具条按钮上的空格 / 回车会被裁剪层吃掉。未确认态仍是无条件 `stopPropagation()`。
- 🔴 **通用弹窗让路**：裁剪的 keydown 与 `showAppDialog` 都挂 `window` **捕获阶段**（后者注释明写「不许别的模块也往这里挂」）⇒ `onKey` 开头判 `#appDialogOverlay` 是否含 `.show`，含则 `return`。不让路 = 守卫弹窗的 Esc / 回车被裁剪层吃掉（框弹出来却按不动）。

**收尾**

- `syncPreviewEditButtons` 扩到 5 个按钮，带三个开关：`keepWhileCropping`（裁剪键自己）/ `hideWhilePendingCrop`（裁剪确认后藏起来）/ `onlyWhilePending`（两个结算键）。
- 保存成功后：写回 `photo.file_size` / `photo.date_modified` 再 `openPreview(state.previewIndex)`；**有裁剪副本**则 `loadPhotos()` 后从 `state.currentPhotos` 取新行再 `openPreviewByPhotoRecord`（自己拼行会缺字段且不报错）。
- 文案用「图片」不用「照片」（`ui-wording-regression` 有零「照片」红线）。

### 端到端

- 桌面端 IPC：`photo-edit-transform` / `photo-edit-crop` / **`photo-edit-apply`（P2 新增，预览态「保存」的唯一入口）**，**三个都有 `isFolderScanRunning()` 前置判据**（扫描期改文件 = 与扫描器抢同一行）。
- 网页端 HTTP：`POST /api/photo-edit-transform` / `POST /api/photo-edit-crop` / **`POST /api/photo-edit-apply`**，走 `readJsonBody`（Content-Type 校验 + 64 KB 上限），`photoEdit` 缺失时 503 `EDIT_UNAVAILABLE`。
- 🔴 **协议是「一串动作」不是「一个动作」**：`photo-edit-transform` 的请求体为 `{ id, actions }`（`handlePhotoEditTransform` 仍兼容旧的单串 `data.action`，避免老前端静默失效）。`photo-edit-apply` 为 `{ id, actions?, crop? }`，返回 `{ success, id, width, height, size, dateModified, crop }`。三条通道的返回值字段名必须一致（守护按对偶钉）。
- 网页端**没有新增静态文件**（选区样式与逻辑都落在既有的 `index.html` 内联 `<style>` 与 `js/app.js` 里）⇒ 不需要动 `web-server.js` 路由表；但**改了 shell 资源就要抬 SW**：本轮 `CACHE_NAME` `v58 → v59`、`/js/app.js?v=7 → v8`（三处同步：`sw.js` 清单 + `index.html` 的 preload 与 script 标签）。
