# 启动页改造计划 —— 独立 Home 页（**纯导航页**）

> 状态：**v3 —— 范围收缩：Home 只做跳转入口，不在首页实现任何实际功能**
> 范围：仅桌面端（`src/renderer/**`）；网页端本次不动
> 载体：**独立页面 `#homePage`**（照 `#settingsPage` 模式）—— ~~一套 DOM 两种形态~~（见 §1.2 修正）
> 视觉参考件：`docs/home-page-preview.html`（可打开、可切深浅两档）

---

## 0. 目标与本轮决策

把「启动页」从 4 张**不可点击**的静态特性卡，升级为一个**独立、可反复进入的 Home 页**。

🔴 **v3 的范围：Home 是纯导航页 —— 全页只做「跳转」，不实现任何实际功能。**

1. **快捷跳转入口** —— 覆盖视图与设置面板，点一下就到位（§4.1 / §4.2）；
   必备：添加目录、所有照片、所有目录、搜图、人物；日期次之。
   🔴 **不求「全量入口」**：只放客户最常用的（本轮已从 13 个落点收到 10 个，§4.5）；
2. **功能介绍** —— 说清这软件能干什么，**面向客户、通俗易懂、像广告语**（§4.1.1）；
   🔴 **介绍与入口合体**：一张卡 = 一个能力域，卡内既有说明、又有该域核心入口 chips（§4.1）；
3. 🔴 **不在首页执行任何动作**：不弹目录选择器、不扫描、不建索引、不发 IPC、不读数据库、不渲染二维码；
4. **可再次进入** —— 顶栏按钮 + 快捷键，任何时候都能回来。

### 四条已拍板的决策

| 决策 | 结论 | 影响 |
|---|---|---|
| Home 的入口位置 | **顶栏按钮，照设置页模式**（不进 rail） | Home 与设置页同族 = 「页面」；`state.currentTab = 'home'`；顶栏按钮 + `nav.home` 快捷键 |
| Home 的职责 | **纯导航，零实际功能** | 「添加目录」→ 设置页 Folders 面板；「网络访问」→ 设置页 Network 面板 |
| 二维码怎么生成 | **vendor 第三方纯 JS 编码器** | 落到 `src/renderer/vendor/`，不新增 npm 运行时依赖；**只在设置页 Network 面板渲染**（§5.3） |
| 入口规模与文案 | **不求全量入口；文案面向客户、像广告语** | 4 张能力卡 / 10 个落点；删「维护与清理」整张卡；不写前置条件（§4.1.1 / §4.1.2 / §4.5） |

### 🔴 相对 v2 / 前几版砍掉了什么

| 原块 | 为什么砍 |
|---|---|
| A1 库状态摘要条（`getStats` 11 字段） | 它是「内容」不是「入口」，且要读库 ⇒ 违反「零实际功能」 |
| A2 后台任务徽标 | 同上，需读任务状态并轮询 |
| A5 网络访问**状态块**（状态徽标 / 地址 / 复制 / 首页二维码） | 收缩为**一个 chip** → 设置页 Network 面板；二维码随之移到设置页（§5.3） |
| A3 快捷键速查的**键位徽标块** | 收缩为卡 4 的一个 chip（→ Shortcuts 面板），首页不再展开键位 |
| 原 v2 的「重新扫描目录」入口 | 是实际功能（触发扫描）⇒ 砍掉，用户进设置页自行触发 |
| **「维护与清理」整张卡** + 其 chip（重复与相似 / 存储与清理） | 用户点名删除；且它讲的是维护作业，不是客户第一次打开产品想干的事（§4.5） |
| 「收藏」「索引与任务」chip | 需求从「加全部入口」改为「只放核心入口」⇒ 取最核心的（条目于侧栏/设置页照旧可达，§4.5） |

**连带的四条简化**（全是好事）：

- 首页**零 IPC、零新查询** ⇒ 原 R5（网络块双真相源）、R6（数据晚到跳字）**整体消失**；
- 首页不显示任何库内数据 ⇒ **不再需要区分「空库 / 有库」**，§2.3 的条件分支删除；
- 「添加目录」**永远是唯一主行动**（不因 `rootFolders` 是否为空而变）；
- 首屏不再被 `getStats` / 任务轮询的时机牵制 ⇒ 启动路径只多一个静态页面。

### 🔴 相对 v1 的一处地基修正（仍然有效）

v1 的前提是「`#emptyState` 一套 DOM 承载两种形态：空库引导 + 功能介绍」。**这个前提是错的**（§1.2）。
空库态早已有独立实现，静态 `#emptyState` 只服务启动欢迎页。因此 v1 里那条
「必须把容器移出 `#photoGrid`」的硬伤**整体消失** —— Home 不再住在网格里。

---

## 1. 现状（已核实到行号）

### 1.1 启动页开关与落地流程

- 开关：`settings.launchDefaultPage`，值域 `welcome | all_photos | all_folders | last_position`
  （`src/main.js:937` 注释；规范化函数 `normalizeLaunchDefaultPage`，`src/renderer/app.js:102`）
- 落地：`applyStartupLandingPage()`（`app.js:1510`），启动流程最后一步（`app.js:1579`）
  - **前置守卫**（`app.js:1518`）：仅当仍在初始落点（folders + all + 无 path / date / query）才落地。
    这条守卫**不能删** —— 大库上 `loadRootFolders` 要十几秒，用户等待期间点进设置 / 搜图是正常操作，
    无条件落地会把用户当场踢回浏览态，并留下 `settings-page-open` 孤儿 class。
  - `welcome` 分支（`app.js:1529`）：重置状态 → `state.suppressAutoLoadOnce = true`（`app.js:1536`）
    → `showTabContent('folders')`。
  - 落地后 `navHistory.reset(captureBrowseLocation())`（`app.js:1583`）重建历史栈。
- **`suppressAutoLoadOnce` 的全部出现只有 5 行**（`app.js:1536 / 2544 / 2545 / 2558 / 2559`）：
  写一次，在 `showTabContent` 的 `folders` 与 `dates` 两支里各消费一次，消费即 `false`。
  ⇒ 它就是一个**一次性**标志，**天生不支持"可再次进入"**（§2.2 整条删除）。

### 1.2 🔴 静态 `#emptyState` 的真实归属（修正）

项目里有**两个** `.empty-state`，同名不同源，此前被混为一谈：

| 节点 | 位置 | 触发条件 | 内容 |
|---|---|---|---|
| **静态** `#emptyState` | `index.html:1097`（`#photoGrid` 内） | 靠 `suppressAutoLoadOnce` 跳过首次 `loadPhotos` 而存活 | `.welcome-mark` + 2 行 desc + 4 张 `.feature-card` |
| **动态** `.empty-state` | `ui-grid.js:58-68`（`innerHTML` 写入） | `photos.length === 0 && !hasSubs` | 📭 + 「没有找到照片 / 视频 / 图片」（按 `mediaFilter` 变体） |

⇒ **空库 / 零结果态早已有独立渲染路径**（`ui-grid.js:58`），并且它自己就住在那 11 处
`photoGrid.innerHTML = ...` 之中的一处。静态 `#emptyState` 是**启动欢迎页专用**。

⚠️ 顺带确认：`app.js:5318`（AI 视图）与 `app.js:5324`（普通浏览）都会
`dom.emptyState.style.display = 'none'`（**只隐藏、不删**），但 **`app.js:5304-5314` 的 duplicates 分支在
`5313` 就 `return` 了，走不到 `5324`** —— 即：若 `#emptyState` 当时可见，切到重复页会**叠一张欢迎页**。
这是既有缺口（T0 实测确认），Home 独立成页后**自动消失**（因为 Home 不再寄生在网格里）。

### 1.3 设置页 = 可照抄的「独立页」模板（Home 就照它做）

| 环节 | 位置 | Home 的对应做法 |
|---|---|---|
| 顶栏按钮 | `#topbarSettingsBtn`（`index.html:824`） | 新增 `#topbarHomeBtn` |
| 事件绑定 | `bindClick('topbarSettingsBtn', options.onOpenSettingsPage)`（`ui-events.js:246`） | 新增一行 |
| 打开入口 | `openSettingsPage()`（`app.js:2575`）→ 先 `syncNavigationRail('settings')` | `openHomePage()` |
| 记忆来源 tab | `state.tabBeforeSettings`，带白名单校验（`settings.js:36-49`） | `state.tabBeforeHome`（同一份白名单） |
| 切页面态 | `state.currentTab = 'settings'`（`settings.js:50`） | `state.currentTab = 'home'` |
| 换 DOM | `contentArea.display='none'` + `settingsPage.display='flex'`（`settings.js:55-56`） | 同上，换 `#homePage` |
| class 派生 | `syncPageOpenClasses(tab)`（`app.js:1635-1641`）唯一写者 | 派生第 4 个 `home-page-open` |
| rail 点击时先退出 | `ui-events.js:476-478`（`currentTab==='settings'` → `onCloseSettingsPage()`） | 同处加 `currentTab==='home'` 分支 |
| 关闭 | `closeSettingsPage()`（`app.js:2631`） | `closeHomePage()` |

**天然吻合的一点**：rail 按钮 `syncNavigationRail` 的 active 判据是
`(item.dataset.tab \|\| 'settings') === tab`（`app.js:2608`）—— `tab='home'` 时**所有 rail 按钮都不高亮**，
与设置页今天的行为完全一致，不需要为「rail 上没有 home 的高亮」发明新机制。

### 1.4 导航历史的位置契约

- `BROWSABLE_VIEWS = ['all','folder_overview','folder','date','favorites','duplicates']`（`app.js:3569`）
- `captureBrowseLocation()`（`3572`）/ `describeBrowseLocation()`（`3590`）/ `applyBrowseLocation()`（`3605`）
- 🔴 **修正 v1 的一处臆断**：去重键 `keyOf()`（`nav-history.js:43`）是
  `[view, path, date, tab].join('\u0001')`，**`view` 本来就在键里** ⇒ 加 `home` 位置**不需要**动去重键。
- 注释写明（`app.js:3568`）：「搜图 / 人物 / 设置各有独立视图态与恢复入口，**不进这条栈**」。

### 1.5 网络访问与二维码（v3 后只跟设置页有关）

- 数据源与渲染都在设置页一侧：`getWebUrl` / `webServerGetStatus`（`RendererWebAccessUI`，
  `ui-shell.js:345-407`），启动时本来就在拉（`app.js:1588-1592` 的 `setTimeout(0)`）。
- 已有能力：局域网三态（运行 / 未就绪 / 未开启）、地址、点击复制 `copyWebUrl`、隧道开关与地址、密码。
- ⚠️ `loadWebUrl()` / `refreshWebServerStatus()` 是**按 id 命令式写 DOM**
  （`#webUrlText` / `#webServerStatus`），`state` 里只存了 `state.webUrl`。
  **v3 收缩后这不再是问题** —— 因为 Home 不再显示网络状态，不需要把 `enabled` / `running` 补进 `state`
  （原 R5 随之消失，见 §5.3）。
- 🔴 **零 QR 实现**：`src/**` 与 `package.json` 依赖均无 `qr` / `canvas` / `barcode`（已实测确认）。

---

## 2. 设计：Home 是一条「页面」

### 2.1 页面态模型

完全照设置页：

```
state.currentTab = 'home'            // 位置语义：Home 是一个 tab 级页面
state.tabBeforeHome = <browseTab>    // 白名单：folders / dates / duplicates / people / search
dom.contentArea.display = 'none'     // 内容区让位
dom.homePage.display    = 'flex'     // Home 上场
html.home-page-open                  // 由 syncPageOpenClasses 派生（第 4 个类）
```

**Home 不进导航历史栈**，理由与设置页同族：它是「到站口」，不是浏览位置。
若强行塞进 `BROWSABLE_VIEWS`，需要给它造一个「前一站」条目（因为从 Home 按后退时，
`applyLocation` 得落到某个真实浏览位置），语义上会变成「后退按钮写着『后退：所有照片』，
但点下去是切换视图而不是返回」——不如不记。

⇒ 落地在 Home 时 `navHistory.reset(null)`（空栈，两个箭头禁用，直到用户进入任一浏览位置）。
这比 v1 那套「给位置值域加 home」省掉 `BROWSABLE_VIEWS` / `describeBrowseLocation` /
`applyBrowseLocation` / `updateBrowsePathLabel` 四处 switch 的改动，也不再需要改动
`canNavigate()` 闸门（`app.js:3665`，那里只挡设置页 —— Home 必须**不挡**，它是正常内容页）。

### 2.2 稳态化：`suppressAutoLoadOnce` 整条删除

原机制是「启动时跳过首次 `loadPhotos`，好让欢迎页留在网格里」。
Home 独立成页后，**Home 根本不会去调 `loadPhotos`**（它走的 `openHomePage()` 与设置页同路），
所以这个一次性标志**没有任何存在理由**：

| 改动 | 位置 |
|---|---|
| 删除写入 | `app.js:1536` |
| 删除两处消费 | `app.js:2544-2547`、`app.js:2558-2561`（连同 `return`） |

⚠️ 删掉后 `showTabContent('folders' / 'dates')` 恢复成「无条件按需加载」。
这不改变任何既有行为，因为唯一的写入点就是 `welcome` 落地分支 —— 而它现在改调 `openHomePage()`。
**守护要断言 `suppressAutoLoadOnce` 全工程零出现**（防止有人为了让欢迎页"再来一次"把它加回来）。

### 2.3 单一形态：连「空库 / 有库」的分支都不需要

§1.2 已证：空库态的渲染在 `ui-grid.js:58`，与 Home 无关。而 v3 收缩后 Home **不显示任何库内数据**，
所以连条件分支都省掉：

- Home 只有**一套内容**（全部入口 + 功能介绍），无 `rootFolders.length` 判断；
- 「添加目录」**永远是唯一的主行动按钮**；
- 库为空时点它 → 跳设置页 Folders 面板，那里早有「添加目录」按钮与空态引导（既有实现，不重复做）。

---

## 3. 必须一起改的接线点（清单）

### 3.1 让位判据与退出路径（R4 的收敛点）

- `isWelcomeHomeVisible()`（`app.js:2215`）判据 = **`#emptyState` 在 `parentNode` 内且未隐藏**。
  Home 独立成页后，这个函数**不再表达「Home 是否显示」**，需要拆成两件事：
  - `isHomePageVisible()` —— 读 `#homePage` 的 `display`（Home 是否在场）；
  - `#emptyState` 的存在判据 —— 随 §1.2 一起，它现在**只服务启动欢迎页**，
    而启动欢迎页在 §2.2 之后也不再依赖它 ⇒ 这个函数可以整体退役（T1 里逐消费者改造）。
- 消费者 1：`ui-navigation.js:70 / 76` 的 `browsingChrome`。
  **建议把「退出 Home」收敛进 `prepareBrowsingShell`（`ui-navigation.js:66-84`）** ——
  它已经在干「隐藏 `settingsPage`、显示 `contentArea`」这件事，加上「隐藏 `homePage`」即成本最低、
  且与设置页共用同一条退出路径。
  ⚠️ **T0 必须先确认**：`prepareBrowsingShell` 是不是**所有**浏览路径的必经点。
  若不是，退出路径要另择唯一收敛点（绝不能散落在各入口）。
- 消费者 2：`app.js:5401-5407` 的 `warmGrid`。它的条件已含
  `state.currentTab === 'folders' || 'dates'` ⇒ `currentTab='home'` 时本就为 `false`，
  那条 `!isWelcomeHomeVisible()` 会变成**恒真的死条件**，随函数退役一起删。

### 3.2 页面态 class

`syncPageOpenClasses(tab)`（`app.js:1635-1641`）现管 3 个类，**把它扩成 4 个**：

```js
root.classList.toggle('settings-page-open', tab === 'settings');
root.classList.toggle('search-page-open',   tab === 'search');
root.classList.toggle('people-page-open',   tab === 'people');
root.classList.toggle('home-page-open',     tab === 'home');   // 新增
```

🔴 只在这里加，**不得**在 `openHomePage` / `closeHomePage` 里自己 `add/remove`
（`app.js:1626-1633` 那段注释就是被这个坑咬过：孤儿 class 会永久盖住侧栏）。
`isFolderSidebarTab()`（`app.js:1615`）只认 `'folders'` ⇒ Home 自动没有文件夹树侧栏，符合预期。

### 3.3 路径栏与侧栏高亮

- `updateBrowsePathLabel()`（`app.js:3390-3432`）的 `switch (state.currentView)`：
  **`folder_overview` 已有"非路径视图"先例**（`3410` 写「🗂️ 所有目录」）。
  Home 下的选择：**让路径栏让位**（`#pathBar` 隐藏）比写一个假位置更干净 —— 待 T1 定稿。
- `updateSidebarActive()`（`app.js:3434-3439`）的 fallthrough（`else syncDateSidebarHighlight()`）
  会在 `currentTab='home'` 时去同步日期高亮。需要显式加一支。
- `recordBrowseLocation()`（`app.js:3673`）经 `captureBrowseLocation()` 返回 `null` ⇒ 自动不记，无需改。

### 3.4 顶栏按钮与快捷键

- `index.html:824` 的 `#topbarSettingsBtn` 旁新增 `#topbarHomeBtn`（图标 + `data-i18n-title`）；
- `ui-events.js:246` 旁新增 `bindClick('topbarHomeBtn', options.onOpenHomePage)`；
- `ui-events.js:476-478` 加同形分支：`if (state.currentTab === 'home' && onCloseHomePage) onCloseHomePage();`
- **快捷键**：`ACTIONS`（`shortcuts.js:56+`，22 项）新增 `nav.home`，`group:'navigation'`，
  `def:['Alt+Home']`，`key:'shortcut.action.navHome'`。
  🔴 分发现在**写死在** `ui-events.js:1048-1066` 的 keydown 分支里，且**事件只问
  `actionFor(e,scope)`、不硬编码 `e.key`** ⇒ 新动作必须在同一处补 handler，
  并与 §4.4 的「点击与键盘调同一个函数」保持一致。
- i18n 新增：`nav.home`、`shortcut.action.navHome`（中英各一份）。

---

## 4. 首页入口（**只有跳转，没有动作**；不求全量）

🔴 v3 的唯一原则：**每个入口都是一次导航，不产生任何副作用。**
判据：Home 的渲染与事件代码里**不得出现** `handleAddFolder` / `aiViews.search` / `rescanFolder` /
`api.*` / `photoAPI.*` / `webServerGetStatus` / `getWebUrl` / `tunnelGetStatus`。
守护按此断言（§7）。

### 4.0 🔴 入口节点的形态契约（本轮补 —— 预览件暴露的缺口）

预览件最初只写了 `cursor: pointer` + hover 抬升，**没接任何事件** ⇒ 鼠标指上去完全是可点入口的样子，
点下去却毫无反应。这正是「看起来能点、实际没接」的典型，落地前必须先用契约钉住：

1. **键鼠双可达** —— 首选原生 `<button type="button">`；若因布局必须用容器元素，
   要显式 `role="button"` + `tabindex="0"`，且 **`Enter` / `Space` 与 `click` 走同一个处理函数**。
   ❌ 只绑 `click` = 键盘用户永远进不去；❌ 只绑 `keydown` = 鼠标点了没反应。
2. **每个可点节点必须有落地目标** —— 不允许存在「有 `cursor: pointer`、无目标」的节点。
   预览件用 `data-goto`，落地代码用 handler 映射表；守护按此断言（§7）。
3. **非入口节点一律不可点** —— 合并后卡片是**介绍容器**，不是入口：不给 `cursor: pointer`、
   不做 hover 抬升、不绑 click（顶栏那枚「首页」chip 同理，它是状态指示）。
   判据是双向的：**样式里写了 `cursor: pointer` 的节点，必须真的有落地目标**；
   反过来，不承担跳转的节点**不许**出现指针样式与 hover 抬升 —— 那是在假装自己是按钮。

预览件已按落地形态实现并实测（**本轮精简后**）：**10 个可点节点全部有目标**
（主按钮 1 + 卡内 chip 9），**10 个不同落点**（视图 2 + 带筛选的视图 1 + 标签页 3 + 设置面板 4 ——
逐项见 §4.2），4 张卡的计算 `cursor` 一律 `auto`（无一个是 pointer）。
⇒ 顺带产出：**预览件同时是「入口对照表」**，逐个点一遍就能核对落点，不必翻文档对函数名。

### 4.1 四张能力卡 —— 介绍与入口**合体**，面向客户、像广告语

🔴 **本条修正**：v3 原先的「三组跳转磁贴」+「4 张纯说明功能卡」是**两套并列的东西** ——
介绍归介绍、入口归入口，用户得先分辨「哪一片能点」再动手。现在合成**一套**：
**一张卡 = 一个能力域 = 卡内一句人话 + 该域的核心入口 chips**。

| # | 能力卡（标题 = 好处，不是功能名） | 卡内说明（≤30 字，1 行） | 卡内 chips |
|---|---|---|---|
| 1 | **照片再多也找得到** | 按文件夹翻、按日期翻，几万张也一目了然。 | 所有照片 / 所有目录 / 日期 |
| 2 | **一句话找到那张照片** | 说一句「海边的日落」就能找到；照片里的人会自动归类。 | 搜图 / 人物 |
| 3 | **再多也不卡** | 上百万张照片照样流畅，视频点开就看，字幕自动加载。 | 只看视频 |
| 4 | **换个样子，多台设备看** | 主题配色、快捷键都能改成顺手的；手机扫个码，家人一起看。 | 网络访问 / 外观与主题 / 快捷键 |

**三条结构规则**

- 🔴 **卡片本身不可点**（§4.0 第 3 条）：卡是介绍容器 ⇒ `cursor` 为默认值、无 hover 抬升、不绑 click。
  一张卡里有 1–3 个入口，整卡可点会让人以为「点卡片就进那个功能」，**点了到底是哪个？**
- 🔴 **chip 用原生 `<button type="button">`**，不用 `div` + `role`：
  键鼠双可达直接白拿，省掉 §4.0 第 1 条的显式补丁。
- 🔴 **说明与 chip 必须同域**：chip 只能出现在它自己的说明下方，跨域放置（例如把「网络访问」
  塞进「照片再多也找得到」）等于把说明退回成装饰。

**入口规模**（实测于预览件）

- **10 个可点节点** = 主按钮「＋ 添加目录」1 + 卡内 chip 9；
- **10 个不同落点**（一一对应，无重复落点）；
- 全页**唯一 primary** 仍是主按钮；chip 一律次级中性（`--bg-hover` 底 + `--border` 边 + `›`）。

### 4.1.1 🔴 文案规范（面向客户，本轮新增，T3/T6 的施工依据）

面向**普通用户**，不是开发者文档。硬性要求：

1. **标题写好处，不写功能名** —— ✅「照片再多也找得到」／❌「浏览与组织」。
   功能名（浏览 / 检索 / 维护）是内部语言，客户读不出「这对我有什么用」。
2. **每条说明 ≤30 字、必须落在一行内** —— 实测超一行会折行并**把同行卡片一起撑高**（§4.6 / R10）。
3. **不出现技术词** —— 禁：索引、转码、数据库、阈值、SQLite、指纹、分组算法。
   本次已删掉的三处旧表述：「百万级索引」「视频边转码边看」「需先建一次索引」。
4. 🔴 **说明里提到的能力，必须在卡内的 chip 里够得着** ——
   否则就是「承诺了却没给路」。本轮据此删了两处：
   卡 1 说明里的「收藏」（无对应 chip，已从说明中去掉）、
   卡 3 说「字幕自动加载」但视频没有独立视图（由「只看视频」承载，见 §4.3）。
5. **不写前置条件**（用户点名）：❌「需先建一次索引」。理由见 §4.1.2。
6. **称呼与现名一致**：入口按钮文字沿用页面现名（所有照片 / 所有目录 / 日期 / 搜图 / 人物），
   不引入第三套叫法 —— 用户在首页看到的词，跳过去必须还是同一个词。

### 4.1.2 去掉「需先建一次索引」：为什么不写也不会撞空白页（已核实）

首次使用搜图 / 人物前需要建一次 AI 索引，旧文案把它写在首页卡片里。**本轮删除**，理由是
「前置条件」属于设置与流程的信息，放在首页只会让客户在还没用上产品时先读到一条作业。

删除前已核实**目标页自带兜底**，用户点进去不会遇到无路可走的空白页：

- 搜图页输入框自带引导：`index.html:874` placeholder「描述你想找的画面，例如：夕阳下的海滩」，
  且零结果时自己有状态文案（`ai-views.js:968` 「没有达到匹配阈值的照片」）；
- 人物页自带空态：`ai-views.js:401` 「还没有识别到人物」。

⇒ 索引未建时的引导由**目标页**承担，首页只负责把用户送过去。守护断言 Home 文案不含
`索引 / 建索引` 等字样（§7）。

### 4.2 落点对照（每个 chip 落到哪 —— 共 10 个，一一对应）

**视图类 3 个**（卡 1 两个 + 卡 3 一个）

| chip | 落地 | 现成函数 | 现成 i18n 词条 |
|---|---|---|---|
| 所有照片 | `currentView = 'all'` | `viewAllPhotos()`（`app.js:3163`） | `sidebar.allPhotos` |
| 所有目录 | `currentView = 'folder_overview'` | `viewAllFolderCovers()`（`app.js:3244`） | `sidebar.allFolders` |
| 只看视频 | `currentView='all'` + `mediaFilter='video'` | `viewAllPhotos()` + 底栏筛选 | 按钮新词条；筛选值用 `filter.video` |

⚠️ **「所有照片」与「所有目录」是两个不同视图，别混**：前者 `currentView='all'`（照片流），
后者 `folder_overview`（目录封面网格）。UI 现名是「所有照片 / 所有目录」，入口文案沿用现名。

⚠️ **标签页类 3 个**（卡 1 一个 + 卡 2 两个）：日期 → `showTabContent('dates')`；
搜图 → `showTabContent('search')`；人物 → `showTabContent('people')`。
三者都走 `showTabContent`，i18n 分别为 `nav.dates` / `nav.search` / `nav.people`。

⚠️ 搜图入口**只进入搜图页**，不做「带词去检索」——
`aiViews.enter()` 会刻意清空 `state.aiSearchQuery`（`app.js:2391`），
带词检索有「先 `search` 后 `showTabContent`」的顺序契约，属**实际功能**，v3 不做。

**设置面板类 4 个**（卡 4 三个 + 页头主按钮）

**先** `openSettingsPage()`，**再** `scrollToSettingsSection(id)`，**顺序不能反**。
`scrollToSettingsSection` 是切面板 / 滚动的**唯一合法入口**，禁止自己 `scrollIntoView`。

| chip | 面板 id | 备注 |
|---|---|---|
| 添加目录（**页头主按钮**，唯一节点） | `settingsSectionFolders` | 🔴 用户点名：**跳设置页，不在首页弹目录选择器** |
| 网络访问 | `settingsSectionNetwork` | 🔴 用户点名：地址 / 复制 / **二维码**都在这里（§5.3） |
| 外观与主题 | `settingsSectionAppearance` | — |
| 快捷键 | `settingsSectionShortcuts` | 兼作「快捷键速查」入口，让那 22 个动作能被发现 |

（7 个面板 id 已逐字核实：Folders / Browse / Shortcuts / Storage / Tasks / Appearance / Network ——
`index.html` 与 `ui-settings.js:47-83` 的 `navItems` 顺序逐位一致。
**本次只作 4 个入口**：`Browse` / `Storage` / `Tasks` 三个面板不做首页入口，见 §4.5。）

⚠️ 「添加目录」**只有一个节点**（页头主按钮）。合并过程中曾把「目录与来源」放进「维护与清理」卡
（该卡本轮已整体删除，§4.5），与主按钮指向同一个 `settingsSectionFolders` —— 已删：
**同一落点在一屏出现两次会让用户以为它们是两回事**，且主按钮已是全页唯一 primary，
没必要再造一个次级入口稀释它。
（同一条规则反过来要求：**「只看视频」必须带筛选**，否则它和「所有照片」也是同一落点 —— §4.3。）

⚠️ **每个入口点击后都必须先退出 Home 态**（§3.1 的收敛路径），否则会「点了没反应」。

### 4.3 「只看视频」必须带筛选（本轮论证升级：不带走法自相矛盾）

项目里**没有「视频」视图** —— 视频是底栏的一个筛选
（`#mediaFilterSelect` + `state.mediaFilter`，i18n 词条 `filter.video`「仅视频」）。两个选择：

- **A（只跳「所有照片」，不碰筛选）**：纯导航、零 state 写入。**但它在落点上与卡 1 的
  「所有照片」完全相同** —— 这就违反了我们在同一页里刚立下的规则（§4.2：同一落点在一屏出现
  两次会让用户以为它们是两回事），也是删掉「目录与来源」的同一理由。而且点完看不到任何视频，
  卡片承诺与落点不符。
- **B（跳「所有照片」+ 写 `mediaFilter='video'` 并同步底栏下拉）**：落点与文案一致，
  且与「所有照片」是两个**行为不同**的落点。代价：这一处**写了 state**，
  须单列白名单（界限：`viewAllPhotos()` 本身也写 `currentView`，
  所以要划的不是「写不写 state」，而是「是否超出视图切换」）。

⇒ **结论：采用 B**，并在 §7 的「零副作用」断言里为它留一条**具名例外**：
只允许写 `mediaFilter`（且必须同步底栏下拉，否则出现「界面显示全部、内容只有视频」的分裂），
仍**禁止** IPC / 文件对话框 / 建索引 / 扫描。

若不接受任何 state 写入，唯一自洽的替代是**把「只看视频」这个 chip 删掉**
（卡 3 退回纯说明 —— 但那样又回到用户明确反对的「介绍与入口割裂」）。因此 B 是唯一两全解。
**未拍板前仍按 A 落地，改动量是删一行**（A → B 不会破坏任何其它契约）。

### 4.4 顶栏自检与动作分发

- `#topbarHomeBtn` 自身也是一个入口（从任意页面回到 Home），与 `nav.home` 快捷键
  调**同一个** `openHomePage()`。
- 快捷键动作表 `ACTIONS` **没有 handler 字段**；分发写在 `ui-events.js:1048-1066`。
  所以正确接法是：**点击路径与键盘路径调同一个函数**（唯一真相源），不另抄一份。

### 4.5 v3 明确不做（原 A / B / C 档的收敛）

原 v2 的 A1 库状态摘要条、A2 后台任务徽标、A3 键位徽标块、A5 网络状态块，
以及 B 档（时间线回顾 / 区块可配置 / 最近新增）与 C 档（缩略图墙 / 版本号卡片）**全部不做**。
理由统一为一条：**它们都不是「跳转入口」** —— 要么要读库、要么要发 IPC、要么纯展示。

其中两项以 **chip** 形式保留了价值，没有丢：
「快捷键速查」→ 卡 4 的「快捷键」chip；「网络访问」→ 卡 4 的「网络访问」chip（二维码在那里面，§5.3）。

🔴 **本轮精简掉的卡与入口**（用户：「不需要加上所有功能入口」「删除维护与清理」）：

| 被删 | 原因 | 需要时怎么去 |
|---|---|---|
| **「维护与清理」整张卡** | 用户点名删除。且它讲的是**维护作业**，不是客户第一次打开产品想干的事 | 侧栏「重复」标签页；设置页 Storage / Tasks 面板照旧可达 |
| 「重复与相似」chip | 随整张卡删除（`showTabContent('duplicates')` 仍由侧栏提供） | 侧栏 |
| 「存储与清理」chip | 同上（`settingsSectionStorage`） | 设置页导航 |
| 「索引与任务」chip | 与「不写前置条件」同族：把索引作业摆在首页，客户还没用上就先读到任务 | 设置页 Tasks 面板 |
| 「收藏」chip | 用户要求不做全量入口，取最核心三个 | 侧栏「收藏」 |
| 「设置」顶栏按钮（预览件里的） | 那是**真实应用本来就有的按钮**，不是 Home 新增的入口 | 原样保留 |

⚠️ **首页入口少 ≠ 功能少**：被删的入口在侧栏与设置页**照常存在**，只是不再出现在首页。
这是「首页放什么」的选择，不是「砍功能」。将来若要加回，按 §4.1.1 的文案规范与
§4.0 的形态契约补，不要各写一套跳转逻辑。

#### 🔴 贯穿全页的硬约束：Home 在启动路径上

v3 收缩后 Home 是**纯静态页面 + 零查询**，启动路径上**不新增任何数据依赖**。
将来若要加回 A1 那类数据块，必须先过这一关：这台 122 万张 / 3.1 万目录的库上，
`loadRootFolders` 本身就要十几秒，任何新增的同步查询都会直接变成首屏白屏。

### 4.6 视觉设计规范（T3 的施工图）

**视觉参考件**：`docs/home-page-preview.html`（可打开、可切深浅两档）。
它是**取色与排版的对照物，不是实现代码** —— 落地时一律走 `var()` token。

#### 现状诊断（现有欢迎页 `#emptyState`）

| 问题 | 证据 |
|---|---|
| 内容**全居中**堆叠 | `styles.css:3278-3284` `align-items/justify-content: center` |
| 虚线大框 = 像「报错空状态」而非产品首页 | `styles.css:3289` `border: 1px dashed` |
| 三级字号全挤在 12–16px，**无层次** | `.title` 16px（`3315`）/ `.desc` 14px（`3329`）/ `.feature-title` 14px（`3353`） |
| 卡片**纯文案、不可点**，无行动召唤 | `index.html:1104-1147` 四个 `.feature-card` 无 button / click |
| 「介绍」与「入口」是**两套并列**的东西，用户得先分辨哪片能点 | v3 早期设计：三组磁贴（纯入口）+ 4 张卡（纯说明），信息分家 |
| 常用入口**藏得深**：想看网络访问 / 快捷键得翻设置页 | 无任何跳转枢纽 |
| 文案是**开发者语言**，客户读不出好处 | 旧 `welcome.f3d`「SQLite 数据库高效索引」（`i18n.js:105`）—— 这是内部实现，不是卖点 |

（诊断里刻意**不含**「看不出库有多大」「扫码要进两级」两条 ——
它们指向的 A1 摘要条与首页二维码已在 v3 砍掉，见 §0。）

#### 骨架（自上而下，左对齐）

```
┌ 页头      拂晓图库 / 一句话定位（客户语言，如「照片都放在自己电脑里」）
├ 主行动    [＋ 添加目录]（全页唯一 primary）   会打开设置页…
└ 能做什么  ── 细线 ──  4 张能力卡（2 列网格 ⇒ 2+2）
              每张卡 = 图标 + 标题（写好处）+ 一句说明 + 卡内 chips
              卡本身不可点；chips 才是入口
```

**为什么这么排**：左对齐建立「首页」感（居中 = 空状态语言）；细线只在**一处**使用
（「能做什么」段头）—— 合并后全页只剩一段内容，不再需要靠细线切分多段；
**全页只有一个 primary 按钮**（「添加目录」），其余一律次级中性 ——
多主色会互相抵消，用户反而不知道点哪个。

⚠️ 合并带来的最大变化：**页面从「四段并列」压到「一段 + 一个网格」**。
原来「浏览 / 智能 / 设置」三组磁贴 +「功能」一组卡片，用户要先读四段标题、再判断哪片能点；
现在**读卡即读入口**。**本轮进一步把 5 张卡精简为 4 张**（删「维护与清理」，用户点名），
落点从 13 个收到 10 个 —— 入口少了，但客户看到的每一条都指得出去（§4.5 有完整删除清单）。
⇒ 代价与对策：原来靠**分组标题**承担的那层信息（哪些是「秒开的视角切换」、哪些要离开照片流）
移进了**卡内说明**，所以说明文案不许退化成只有标题 —— 这是 T3 的硬要求。

#### 硬性规格

| 维度 | 规格 | 理由 |
|---|---|---|
| 页容 | `padding: 26px 30px 32px` | 与 `.settings-page`（`18px 20px 20px`）同族，Home 更宽松 |
| 页头标题 | 21px / 600，`letter-spacing: -0.015em` | 拉开与正文的层次（现状 16px 太小） |
| 副标题 | 13px / `--text-secondary` | — |
| 分段标题 | 13px / 600 + 1px `--border` 横线，`margin: 26px 0 13px` | 全页**只用一处**（「能做什么」），**不得**再用虚线框 |
| 卡片网格 | `repeat(2, minmax(0, 1fr))`，`gap: 12px`，`align-items: stretch` | 4 张卡 ⇒ 2+2，末行刚好填满（实测 4 张卡高度全部 117px） |
| 卡片 | `--bg-card` + 1px `--border` + radius 12px，`padding: 16px 16px 15px` | 与设置页卡片同配方 |
| 卡片内部 | `flex-direction: column` + `gap: 14px`；chips 容器 `margin-top: auto` | 同行卡片等高时 chips 贴底对齐 ⇒ chip 数不同的卡也不会参差 |
| 图标 | 20px，`stroke-width: 1.6`，`var(--accent)` | 一屏只有卡内图标用彩色 |
| chip | **原生 `<button>`**，12.5px，`padding: 6px 10px`，radius 7px；`--bg-hover` 底 + `--border` 边 + `›` 后缀；hover 转 `--accent-dim` / `--accent` | 次级中性，不抢主按钮；🔴 `font: inherit` 必须写（原生按钮不继承字体） |
| 卡内说明 | 13px / `--text-secondary` / `line-height: 1.55`，**控制在 1 行**（约 30 字内），文案遵守 §4.1.1 | 超一行会让同行卡片高度不齐（实测：多 8 字即折行并撑高整行） |
| 卡片 hover | **无** —— 卡片不是入口（§4.0 第 3 条） | 卡一旦抬升，就等于宣布自己是按钮 |
| 主按钮 | **复用既有 `.btn-primary` 配方**，不新写 | 记忆红线：纯 `var(--accent)` 直配白字跨 22 套预设最坏 1.53 |
| 焦点环 | `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` | 键盘用户必须看得见焦点（§4.0） |
| token | 一切取色走 `var()`；**不得**写死十六进制 | 六元组（主题/强调色/背景/纹理/透明度/窗口背景）下必须全部成立 |

#### 空库态：**没有分支**

Home 不显示任何库内数据，所以 `rootFolders` 是否为空**不影响首页渲染**（§2.3），
「添加目录」永远是唯一 primary。原 v2 那套「隐藏摘要条与任务块」的差异**整体取消**。

#### 🔴 主行动必须预告去向

按钮旁固定一行 13px `--text-muted` 提示：「会打开设置页，在那儿添加和管理目录」。

理由：按钮写着「添加目录」，点下去却**不弹目录选择器**而是跳设置页 ——
若不预告，用户会认为**按钮坏了**。这是「纯跳转」方案唯一的可用性代价，必须用文案补上。
（「添加目录」**只剩主按钮这一个节点**，不再有卡内 chip 分担这个提示 ⇒ 这行预告更不可省。）

#### 🔴 段头必须写明「卡内按钮才可点」

合并后卡片**看起来仍是一整块**，用户的第一反应是「点卡片」。而卡本身刻意不可点（§4.0 第 3 条），
所以必须在段头用一行 12px `--text-muted` 小字把规则说清：

> 能做什么 —————— 卡片是介绍，点里面的按钮直接去

三个信号要一起给，缺一不可：

- **段头这行小字** —— 一次性说明全页规则；
- **chip 的 hover 态 + `›` 后缀** —— 逐卡确认「这个能点」；
- **卡片 `cursor` 保持默认、无抬升** —— 指上去就明白卡不是按钮。

⚠️ 这是「合并」换来的**唯一代价**：分家时「哪片能点」由版式天然回答（磁贴=入口、卡片=说明），
合并后版式不再回答，**必须用文案显式告知**。这条不能省，否则用户会在卡片上白点几下。

#### 🔴 明确不做（视觉层面）

- ❌ 虚线边框、居中大图标 + 浮动动画（那是**空状态**的语言，Home 是正式页面）；
- ❌ 一整屏渐变 / 光晕 / 毛玻璃叠层 —— 项目已有 9 档纹理与 4 档面板透明度，Home 再叠一层会与六元组互相干扰；
- ❌ 首页放缩略图墙（拖慢启动）；
- ❌ 为「好看」新增字体、图标库或第二个强调色（一屏只用 `--accent` 一个彩色来源）。

#### 首屏无数据依赖（原 R6 消失）

Home 不读库、不发 IPC ⇒ **不存在「数据晚到跳字」问题**，
原 R6 与「骨架占位 + 合流补写」的要求**一并取消**。
将来若加回数据块，必须重新引入这条约束（判据：补写前后对同一容器量
`getBoundingClientRect()`，宽高必须一致）。

---

## 5. 二维码

### 5.1 实现路线（已拍板：vendor 第三方纯 JS 编码器）

- **落位**：`src/renderer/vendor/qrcode.min.js`（MIT，纯 JS 无依赖，如 `qrcode-generator`）。
- **为什么这条路干净**（全部已核实）：
  - 渲染端是 `file://` 协议（`main.js:3366` `mainWindow.loadFile(...)`），
    vendor 文件用**相对路径**引入即可：`<script src="vendor/qrcode.min.js"></script>`。
    这已是既有手法 —— `index.html:2968/2981/2989` 就在用 `../web/js/photo-info-fields.js` 这类相对路径。
  - `dead-reference-regression.js:129` **显式跳过任何名为 `vendor` 的目录**
    （`if (SKIP_DIRS.has(e.name) || e.name === 'vendor') continue;`）——
    这正是 `src/web/vendor/hls.min.js`（860545 字节的第三方压缩产物）能躺在那里的原因，
    也是我们不必担心压缩代码触发误报的原因。
  - **不需要**加 `web-server.js` 路由、**不需要**动 `sw.js`：
    `vendor/hls.min.js` 至今也不在 `SHELL_ASSETS`（`sw.js:7-25`）里 —— 按需加载的资源不进 PWA 清单。
  - **不新增 npm 依赖** ⇒ 不动 `package.json`、不引入 `postinstall` 的 native rebuild 涟漪。
- **适配层**：新增 `src/renderer/qr-code.js`（IIFE + `window.RendererQrCode`，与
  `nav-history.js` / `path-crumbs.js` 同风格），对外只暴露一个函数，
  把 vendor 的具体 API 关在里面 —— 将来换实现只改这一个文件。
- **渲染方式**：用编码器的 `createDataURL(cellSize, margin)` 产出 data URI，塞进 `<img>`。
  理由：不 `innerHTML` 任何生成型字符串（避开注入面）、尺寸交给 CSS 控、天然适配 DPR。
  不建议自己用 `isDark(r,c)` 画 canvas —— 多写代码且要自己处理 DPR 与静区。

### 5.2 🔴 三条硬约束

1. **二维码内容 = `copyWebUrl` 复制的那串，逐字符相同**（唯一真相源）。
   两处必须读**同一个** `state` 字段 —— 否则会出现「扫码装不上、复制却能用」。
   落地判据：断言 QR 载荷的来源字段与 `copyWebUrl` 的**是同一个**。
2. **状态不当时不画码**：`enabled` 关 / 服务未就绪 / 地址为空 ⇒ 显示占位与原因，
   **绝不画一个空二维码或旧地址的码**（旧码会指向一个已经关掉的服务）。
3. **二维码里绝不含访问密码**（Home 与设置页任何位置都不显示密码）。

### 5.3 显示位置：**只有设置页 Network 面板一处**

原来是「Home 的 A5 块 + 设置页两处使用」，v3 收缩后**只剩设置页一处**
（`#webUrlBox` 一带，即「手机扫码」最自然的落点）。

🔴 连带效应：Home 侧**不再有任何网络状态依赖** ⇒ 原 R5（双真相源：`enabled` / `running` 只活在 DOM 里）
**整体消失** —— 因为 `loadWebUrl` / `refreshWebServerStatus` 不需要再往 `state` 里补字段了，
它们继续按 id 命令式写设置页 DOM 即可，改动面回到「只加一个二维码渲染」。

### 5.4 正确性验证（"像二维码" ≠ "扫得出来"）

QR 编码最危险的失败是**静默错误**：画出来形状对、结构对，但 RS 纠错或掩码选错 ⇒ 扫不出来。
所以必须有**独立于编码器**的验证，三选一（建议 1+3）：

1. **已知向量**：对固定短串（如 `HELLO`），断言生成的模块矩阵与**可信来源的参考矩阵**逐位相同
   （21×21 version-1 矩阵可硬编码进守护）—— 便宜、可自动化、能抓掩码/纠错回归。
2. **独立解码器**：探针里用另一套实现（如 jsQR）解码我们自己生成的位图，
   断言解出字符串 === `state.webUrl`。最强，但要多 vendor 一个**仅测试用**的文件。
3. **真机扫码**：人工最后一步，用手机相机实扫（这是唯一能证明"真的能用"的判据）。

---

## 6. 分阶段任务

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| T0 | 前置确认：① `prepareBrowsingShell` 是否**所有**浏览路径的必经点；② duplicates 分支（`app.js:5304`）在欢迎页可见时是否真的叠图（实测）；③ `settingsFlow.openSettingsPage` 里 `contentArea` / `settingsPage` 的显隐是否有 Home 需要同步的副作用 | 三条都有实测结论 |
| T1 | Home 页骨架：`#homePage` 容器 + `openHomePage` / `closeHomePage` + `state.tabBeforeHome` + `syncNavigationRail('home')` + `syncPageOpenClasses` 第 4 类 | Home 可从顶栏进出，rail 切 tab 能正确退出 |
| T2 | 🔴 **稳态化**：删除 `suppressAutoLoadOnce`（5 处）+ 退役 `isWelcomeHomeVisible()` + 改造两处消费者 | 连续进出 Home 三次无残留；守护断言该标志零出现 |
| T3 | 渲染函数 `renderHomeSurface()`：页头 + 主行动 + **4 张能力卡（卡内说明 + 卡内 chips）**。**纯静态，无任何查询 / IPC** | 截图一张即可（无空库 / 有库之分）；Home 代码零 `api.*`；每张卡的说明 ≤1 行、**实测 4 张卡等高** |
| T4 | 交互接线：入口事件委托到容器（**一个** listener）；**键鼠双通道**（§4.0）；点击后走**同一个**退出函数 | 10 个可点节点逐个点通（鼠标 + 键盘各一遍）；卡片本体点不动 |
| T5 | 顶栏按钮 `#topbarHomeBtn` + `ACTIONS` 新增 `nav.home` + 分发补 handler | 按钮与 `Alt+Home` 行为一致 |
| T6 | i18n：新增 `home.grp.<id>.title` / `.desc`（**4 组**）与少数 chip 文案（`home.chip.*`）；chip 其余文案**复用既有词条**（`sidebar.allPhotos` / `sidebar.allFolders` / `nav.*` / `filter.video`）；同时清理 `welcome.f1t~f4d` 等孤儿词条 | 🔴 文案过 §4.1.1 规范（好处标题 / ≤30 字 / 无技术词 / 提到即够得着）；中英切换无 key 名外露；无孤儿 key |
| T7 | 设置页深链：确认 **4 个**面板 id 与 `scrollToSettingsSection` 的实际落点 | 每个深链都停在目标面板 |
| T8 | 二维码：vendor 落位 + 适配层 + **设置页 Network 面板**接入（Home 不接） | 见 §5.4 的三条验证 |
| T9 | 守护与验收（§7） | 全绿 + 牙齿测试变红 |
| T10 | `CONTRACTS.md` 新增「Home 页」一节（**目前完全没有这一节**）+ MEMORY 红线 | 契约可查 |

⚠️ **T3 与 T4 是本方案的绝大部分工作量** —— T1 / T2 / T5 / T6 / T7 都是既有模式的接线，
T8 只在设置页一侧，与 Home 完全解耦（可并行 / 可延后）。

---

## 7. 验收

**静态守护**（新增 `scripts/home-page-regression.js`，挂进 `run-regressions.js`）

- `#homePage` **不在** `#photoGrid` 内（Home 不寄生在网格里）；
- `suppressAutoLoadOnce` 全工程零出现；
- `home-page-open` 只由 `syncPageOpenClasses` 写（`openHomePage` / `closeHomePage` 里不得 `classList.add`）；
- `tabBeforeHome` 的赋值处带 §1.3 那份 tab 白名单；
- 每个入口都有对应 handler（防「DOM 里有按钮、代码里没接」）；
- 🔴 **每个可点节点键鼠双可达**（§4.0）：带 `cursor: pointer` / hover 规则的元素，
  要么是原生 `<button>`，要么同时有 `role="button"` + `tabindex="0"`，
  且事件的 click 与 keydown(`Enter`/`Space`) 分支调**同一个**函数
  —— 防「预览件那个坑」在落地代码里复现（有指针样式、点了没反应）；
- 🔴 **非入口节点不许有指针样式**（§4.0 第 3 条）：`.home-page` 下除 `.link-chip` / `.btn-primary`
  与顶栏按钮外，**任何选择器都不得声明 `cursor: pointer`**，卡片类不得有 hover 抬升
  —— 这条是「介绍与入口合体」能否成立的地基（卡一旦像按钮，用户就会点它）；
- 新 i18n key 中英各一份；
- 🔴 **Home 全模块零副作用调用**：`renderHomeSurface` 与其事件处理里不得出现
  `handleAddFolder` / `aiViews.search` / `rescanFolder` / `api.` / `photoAPI.` /
  `webServerGetStatus` / `getWebUrl` / `tunnelGetStatus` / `restoreStartupPositionSnapshot`；
- 🔴 Home 的 4 个设置深链**只能**经 `scrollToSettingsSection`（不得出现 `scrollIntoView`）；
- 🔴 **卡片数 = 4**，「维护与清理」不得再现；
- 🔴 **文案规范**（§4.1.1）：Home 的 i18n 值里不得出现 `索引` / `转码` / `数据库` / `阈值` /
  `建索引` / `SQLite` 等词；每条卡内说明 `length <= 30`；
  **说明里提到的能力必须在同卡 chip 的文案里出现对应的落点**（防「承诺了没给路」）；
- 🔴 Home 不出现访问密码字段或明文；
- 🔴 二维码载荷字段 === `copyWebUrl` 的字段；
- 二维码已知向量：固定串 → 矩阵与参考值逐位相同。

**回归**

- `npm test` 全绿（当前基线 55 项 PASS、无 FAIL，末项 `ai-lifecycle-regression`）；
- `npm run lint` 0 error（baseline 0 error / 2 warning，两条在 `src/web/js/app.js`，别修）。

**端到端探针**（真实事件，不吃 `element.click()` 的假绿）

- Home 页截图一张（**不再需要「有库 / 空库」两张**），并与 `docs/home-page-preview.html` 比对排版；
- 🔴 **深浅两档主题下各截一张** —— 验证取色全走 token、没有写死的十六进制；
- **反复进出 Home 3 次**后截图，断言无孤儿（工具栏恢复、`home-page-open` 已摘、网格正常）；
- §4 全部入口（**10 个可点节点 → 10 个不同落点**：视图 2 + 带筛选的视图 1 + 标签页 3 + 设置面板 4。
  主按钮「＋添加目录」占 1 个节点、4 张卡的 chip 共占 9 个；「只看视频」按 §4.3 落地 ——
  **若走 A 案则它与「所有照片」同落点，会触发重复落点断言**，这正是选择 B 的理由）
  逐个用 CDP `Input` 真实点击，并核对**落地结果**（当前 tab / `currentView` / 面板 id / 筛选值）；
- 🔴 **卡片本体点不动**：直接点卡片的说明文字区域 —— 必须**无跳转、无 hover 抬升**（§4.0 第 3 条）；
  这是预览件真踩过的坑（有指针样式、无落地目标），必须用真实鼠标事件验一次；
- 🔴 **文案排版实测**（§4.1.1 / R10）：逐卡量 `feature-desc` 高度 ÷ 行高，**必须 ≤1 行**；
  同时量**4 张卡的 `getBoundingClientRect().height`，必须完全相等**
  （预览件终稿实测：4 张卡全部 117px、说明各 1 行 —— 落地后应复现同一组读数）；
- 🔴 每个节点**额外验一遍键盘通道**（`Tab` 聚焦 → `Enter`），落点必须与鼠标点击**完全一致**（§4.0）；
- 🔴 每个节点**额外验一遍焦点可见**（`:focus-visible` 焦点环存在，不依赖鼠标才看得见）；
- 🔴 **点完后不得有任何副作用**：点「添加目录」后**不得**出现原生的目录选择对话框
  （这正是 v3 收缩的核心判据，必须实测）；
- 二维码：**手机实扫一次**，确认落地页 = 复制到的那串地址。

**牙齿测试**（改坏 → 必须变红 → 逐字节还原）

- 在 `openHomePage` 里手动 `classList.add('home-page-open')`；
- 把 `suppressAutoLoadOnce` 加回来一行；
- 删一条 i18n key；
- 删一个入口的 handler；
- 摘掉某个入口的 `keydown` 分支（只留 `click`）—— 必须触发「键鼠双可达」断言；
- 把某个入口换成裸 `<div>`（去掉 `role` / `tabindex`）—— 同上；
- 把「添加目录」的 handler 换回 `handleAddFolder`（应触发「零副作用」断言）；
- 给卡片容器加一条 `cursor: pointer` / hover 抬升 —— 必须触发「非入口不许有指针样式」断言；
- 删掉段头那行「卡片是介绍，点里面的按钮直接去」提示 —— 必须变红（R9）；
- 把某张卡的说明加长到 32 字（触发折行）—— 必须变红（R10 的「≤30 字 / 1 行」断言）；
- 在卡内说明里加回「需先建一次索引」—— 必须触发「文案不得含技术词」断言（§4.1.1 第 5 条）；
- 把「维护与清理」卡加回来 —— 必须触发「卡片数 = 4」断言；
- 把二维码载荷改成拼接密码的字符串。

**启动回归**

- `launchDefaultPage` 四档各自仍按预期落点（`welcome` ⇒ 现在落在 Home 页）；
- 用户等待期点走界面后，落地**不抢焦点**（`app.js:1518` 守卫不能被破坏）。

---

## 8. 风险

| 编号 | 风险 | 缓解 |
|---|---|---|
| R1 | 删 `suppressAutoLoadOnce` 改变了 `showTabContent('folders'/'dates')` 的加载时机 | 唯一写入点已随 Home 落地改路；T2 后跑浏览 / 导航 / 布局三条回归 + 启动四档实测 |
| R2 | 退出 Home 的路径不唯一 ⇒ 某个入口点完留在 Home（"点了没反应"） | T0 先确认 `prepareBrowsingShell` 的覆盖面；退出收敛到一个函数，守护断言所有入口都走它 |
| R3 | `warmGrid`（`app.js:5401`）缓存命中路径变化，启动首屏变慢 | 实测首次进入耗时，与改前基线对比 |
| R4 | Home 页顶栏按钮与 rail 高亮语义重叠（rail 全不高亮） | 与设置页现状一致，属既有约定；T1 截图确认视觉可接受 |
| R5 | 🔴 **「添加目录」点了不弹目录选择器，用户以为按钮坏了** | §4.6 强制按钮旁预告去向文案（「会打开设置页，在那儿添加和管理目录」）；探针实测点完无原生对话框 |
| R6 | 设置深链「先 `openSettingsPage` 后 `scrollToSettingsSection`」顺序写反 ⇒ 面板不滚 | T7 逐个实测落点；守护断言不使用 `scrollIntoView` |
| R7 | 二维码静默错误（扫不出来）或指向已关闭的服务 | §5.4 三条验证；状态不当时不画码 |
| R8 | vendor 文件不进打包产物 | `src/**` 整体进 asar（`src/web/vendor/hls.min.js` 已是既证）；T9 用 `npm run pack` 后实测一次 |
| R9 | 🔴 **「介绍与入口合体」后用户不知道卡内按钮能点** —— 卡看起来是一整块，用户先在卡上白点几下 | §4.6 的三信号：段头小字「卡片是介绍，点里面的按钮直接去」+ chip 的 hover 与 `›` 后缀 + 卡 `cursor` 保持默认；守护断言段头提示词条存在，牙齿测试删掉即变红 |
| R10 | 卡内说明写太长（>1 行）⇒ 同行卡片高度参差、4 张卡参差不齐 | §4.1.1 第 2 条 + §4.6 规格限定 ≤30 字 / 1 行；T3 出口判据含「实测 4 张卡等高」，折行即改文案 |
| R11 | 🔴 **文案「像广告语」用力过猛 ⇒ 承诺了卡里没有的能力**（例如说明提到「收藏」却没有对应 chip） | §4.1.1 第 4 条：说明里提到的能力必须在同卡 chip 里够得着；守护做「说明 ↔ chip」关键词比对，牙齿测试反证 |
| R12 | 🔴 **首页入口精简后，客户找不到被删的功能**（重复清理 / 存储 / 索引任务） | 这些入口在**侧栏与设置页照常存在**（§4.5 有完整对照表）；本次是「首页放什么」的选择，不是砍功能；若实测发现客户确实找不到，按同一套契约把 chip 加回即可（不新增机制） |

（原 R5 网络块双真相源、R6 数据晚到跳字 —— **随 v3 收缩整体消失**，见 §0 与 §5.3。）

---

## 9. 明确不做（本次）

**A. 因为「纯导航」而砍掉的实际功能**（v3 收缩的直接结果，见 §0）

- 「添加目录」**不**在首页弹原生目录选择器、**不**触发扫描 ⇒ 跳设置页 Folders 面板；
- 「网络访问」**不**在首页显示状态 / 地址 / 复制按钮 / 二维码 ⇒ 跳设置页 Network 面板；
- 首页**不**显示库状态数字、后台任务进度、键位徽标；
- 「重新扫描目录」「继续上次浏览」两个动作入口不设（前者触发扫描，后者要读 localStorage 快照并应用位置）。

**A2. 因为「不求全量入口」而删掉的卡与 chip**（详见 §4.5）

- 「维护与清理」整张卡（用户点名）及其 chip「重复与相似」「存储与清理」；
- 「索引与任务」chip（与「不写前置条件」同族，§4.1.2）；
- 「收藏」chip；
- 🔴 以上条目**功能一个都没砍** —— 它们在侧栏与设置页照常可达，只是不再出现在首页。

**B. 与本次范围无关**

- 网页端镜像（`src/web/**` 与 `sw.js`）：本次只做桌面端 Home；
- 「打开数据目录」类外部动作；
- 把 Home 做成**浏览器后退能回的去向**（进 `BROWSABLE_VIEWS`）——
  注意这**不等于**「Home 不可再次进入」：Home 可反复进入，但入口是**顶栏按钮 + 快捷键**（与设置页同族），
  而不是后退键；理由是要给位置值域造合成条目，建议单独立项；
- 改动 `launchDefaultPage` 的取值域与设置页那一处下拉（`welcome` 档含义不变，
  只是落点从「网格里的欢迎页」变成「Home 页」）；
- Home 区块可配置、最近新增、缩略图墙。

**C. 若将来要加回数据块**（A1 那类），必须先过 §4.5 的启动路径硬约束。

---

## 实现后的修订（2026-10-05，经用户确认）

落地后有两处偏离本文档原案，**以代码与 `CONTRACTS.md` 为准**：

1. **入口位置**：原 §T5 写「`#topbarSettingsBtn` 旁新增 `#topbarHomeBtn`」。
   实测这样放会踩到 `.rail-settings{margin-top:auto}` —— 它独吞 rail 剩余空间、只把自己顶到底，
   于是首页落在「重复」下方、悬在半空（实测首页 `top=388`、设置 `top=721`，中间 272px 空档）。
   已改为 **rail 最上**（`folders` 之前），并在它与视图组之间**再加一条 `.rail-divider`**，
   rail 因此是**三段**：首页 ｜ 视图 4 项 ｜ 工具与配置（重复 / 设置）。
   ⇒ 「与设置同族」只说明**类别**（都不带 `.nav-tab`、都不是视图），不决定位置。
2. **设置图标**：换成 `lucide-static@0.544.0` 的 `settings`（ISC）。
   原先是手写 path，16 个顶点半径 4.12~9.49 全不相等、按中心对位差最大 3.14（左鼓右瘪）。

守护已同步：`navigation-regression`（新增「元素序列」逐位断言 + 两条图标断言）、
`ai-sidebar-regression`、`layout-regression`（另加「恰有 2 条分组线」）。
