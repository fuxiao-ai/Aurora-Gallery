# 桌面三栏布局

最左侧固定图标导航：**文件、日期、搜图、人物** ｜ **重复、设置**。图标附短标签、悬停提示和键盘焦点，当前页面使用强调色及侧边标记。

两组之间的分隔线（`.app-rail .rail-divider`）是**有语义的**，不是装饰：上半是「换内容看的视图」，下半是「干活用的工具与配置」。`设置` 另有 `.rail-settings { margin-top: auto }` 钉到底部。删掉分隔线，「重复」在视觉上就会退化成第五个视图。

中间栏沿用可调整宽度的侧栏，随页面显示目录树、日期、人物入口、重复分组或设置分类。设置分类使用独立容器，避免覆盖文件目录树；可直接从图标栏离开设置。

右侧显示照片、人物及其关联照片、重复项或设置内容。模型、索引和识别参数位于「设置 → 后台任务」里的「搜图索引 / 人物索引」两行（识别参数折叠在行下方），人物页与搜图页各自提供跳转入口。顶部原有管理设置按钮已移至图标栏底部。

### 底栏（浏览页右下角）契约

内容区底部一条 `.browse-footer`：左侧是分页条（`#pagination`，单页时整条隐藏），右侧 `.browse-footer-actions` 里依次是 **随机跳页 → 每页数量 → 卡片尺寸**。

**每页数量（`#pageSizeControl`）与卡片尺寸（`#zoomControl`）共用 `.zoom-control` 药丸外形**，`--page` 修饰符只把读数加宽（`min-width: 36px` + 等宽数字），保证 `10 → 200` 时药丸宽度不变、整条底栏不左右抖。改外观时改 `.zoom-control` 一处即可，别给新控件复制一套。

两者**行为不同，别照抄**：卡片尺寸只改 CSS 变量当场重排；每页张数要重新查库，所以走设置持久化那条路（`updateSettings` → 用返回的设置整体重放 → `state.page = 1` → `loadPhotos`），失败要回滚读数并提示——否则界面会显示一个并没生效的张数。

档位表 `BROWSE_PAGE_SIZE_TIERS`（`[10, 20, 50, 80, 100, 200]`）住在 `src/renderer/utils.js`，是渲染端唯一一份。**收档必须「取最近档位」而不是判非法丢弃**：底栏是「上一档 / 下一档」，表外的值一旦流进来，`indexOf` 返回 -1，± 就再也动不了。设置页下拉的每一档都必须能由 ± 走到，否则底栏会显示一个设置页里选不中的值。

**可见性收在一个 helper 里**（`ui-navigation.js` 的 `setBrowseGridControlsVisible`，同时管 `zoomControl` 与 `pageSizeControl`）。这两个控件原先靠四五个地方各自 `getElementById(...).style.display` 维持可见性，新加一个控件时只要漏掉一处，就会出现「进了重复页还留着半截底栏控件」。智能视图（搜图 / 人物）另有一条例外：结果集固定只有一页（`previewTotalPages = 1`），每页数量跟着随机跳页一起收掉，而卡片尺寸仍然可用。

守护：`page-size-control-regression` 覆盖 ± 逐档走 / 到底到顶 / 表外值不卡死 / 写失败回滚 / 设置页改完读数同步，以及「HTML 有 id 但没人接线」那一类静态契约（事件绑定、dom 映射、`onApplyPageSize` 每个应用点都传、档位表四处同源）。

### 设置页的信息架构契约

设置页是**两栏 6 面板**：左栏 `#settingsSidebar` 是类目导航，右栏同一时刻只显示一个 `[data-settings-panel]` 面板（CSS 靠 `.is-active` 切换显隐，切换时把 `#settingsPage` 滚回顶部）。`ui-settings.js` 里 `navItems` 的顺序**必须与 `index.html` 中面板的 DOM 顺序逐位一致**——顺序错位的症状是「点左栏某一项、右栏显示的却是另一项」。navigation-regression 会把两边解析出来做逐位比对（解析而非硬编码期望值，增减面板不会假红），并校验每个面板都带 `data-settings-panel`。

6 个面板按语义归类，不再按内容类型平铺：

- `settingsSectionFolders` 媒体库 —— 相册目录增删与重扫
- `settingsSectionBrowse` 浏览与播放 —— 浏览偏好（排序 / 分页 / 视频点击）与字幕字体样式
- `settingsSectionStorage` 媒体与存储 —— 缩略图尺寸质量与 HLS 缓存上限
- `settingsSectionTasks` 后台任务 —— 立即执行（缩略图补全 / 重复比对 / 数据库维护）、自动执行（三个启动开关 + 视觉相似阈值）、AI 索引（搜图索引 `#settingsAiSearchMount` / 人物索引 `#settingsAiPeopleMount`）
- `settingsSectionApp` 应用 —— 关闭按钮、通用设置（界面语言 / 启动默认页 / 界面风格）
- `settingsSectionNetwork` 网络 —— 局域网访问开关与地址、访问密码、Cloudflare Tunnel

后四块原本挤在同一个 `settingsSectionMedia` 里（字幕属播放、缩略图与 HLS 属存储、三个任务属后台），一个区块横跨三个语义，现已拆开归位。

**「后台任务」是「让机器干活」的归口处。** 长跑任务原先散在三处：「应用 → 通用设置」放着一排「启动时自动…」开关，「后台任务」放三个立即执行按钮，「搜图 / 人物」各有自己的建立 / 更新索引。同一个意图（把活干完）要在三个面板里翻，所以三处都收进后台任务：三个启动开关与「视觉相似阈值」（本质是查重参数，跟「重复照片比对」是一件事的两半）进「自动执行」小节，搜图 / 人物两个索引进最后一段。

**搜图 / 人物两个索引行是「行内直接可用」，不再单开类目。** 它们曾经各自成面板，理由是需要容纳模型状态（约 412MB / 39MB 的下载与校验）和识别参数（分组模式、缩略图回退阈值）。实际做法是：把面板本身嵌进这两行（`.setting-item.settings-ai-task`，挂载点 `section.settings-ai-task-body`），用 CSS grid 把状态行 / 按钮 / 进度条重排成与隔壁任务行同一套视觉（按钮靠右、说明一行 12px），识别参数收进行下方的 `<details>`（默认收起）。这样既保住了「建索引 / 换模型 / 停任务」的就地可用，又不让设置页为两个长跑任务各开一个类目。守护断言：navigation-regression 按 `data-settings-panel` 的位置切出「后台任务」面板的 DOM 区间，验证两个挂载点确实落在区间内（只数类目数量守不住——挂载点挪走、导航项加回去，两边一起漂移就不会假红）。

同样地，「自动执行」里的**三个启动开关 + 视觉相似阈值**是从「应用 → 通用设置」搬来的（`autoThumbBackfillOnStartup` 也补上了 dHash：它现在是「缩略图 + 视觉指纹」一件事）。

**但没有加「开机自动建 AI 索引」开关**（搬进来的是入口，不是自动化）：首次索引是整库级、数天级，搜图 worker 常驻内存约 900MB，与「补缩略图」这种可预期增量不是一个量级；而且 `canRun` 让两套 AI 索引彼此互斥、也与数据库维护互斥，真让它随开机跑，「优化数据库」按钮就会随机变灰。要做也得先补「扫描全部完成」的钩子，再加一个「暂停自动任务」的总闸。

**设置页导航图标一律用彩色 emoji。** ✦ / ☺ / ⟳ 这类文本符号在 Windows 上走 Segoe UI Symbol，会被渲染成单色灰字，夹在一排彩色 emoji 中间就是断层（后台任务曾用 ⟳，实测渲染成空心圆才换成 🛠️）。搜图用 🔍、人物用 👤、浏览与播放用 🎞️（原 🖼️ 与「媒体与存储」的 🗄️ 太像，且只覆盖「图」不覆盖「播放」）。换图标不参与回归断言，但换回文本符号前务必在 Windows 下看一眼实际渲染。

**搜图与人物合并进「后台任务」，不再是两个类目。** 两者确实是两套独立能力（各有模型、索引文件与 IPC：`faceAction` 对 `aiSearchStatus` / `Install` / `Index` / `Cancel`，**不共享任何开关**），但「独立能力」不等于「独立类目」：它们与补缩略图 / 查重 / 数据库维护一样都是「点一下让机器干很久」的长跑任务，各自单独成类时设置页要为用户很少进出的两个入口各留一栏，而同屏的隔壁栏就是同一类活。合并后左栏的搜图 / 人物入口只存在于图标栏（`nav.search` / `nav.people`），设置页里对应的是 `settings.task.aiSearch` / `settings.task.aiPeople` —— 名称同义但**不再强制同名**（`navigation-regression` 已删掉那条同名比对，它守的是「合并」本身：两个挂载点必须落在后台任务面板的 DOM 区间内）。

### 页面态 class 契约（残留导航那个 bug 的根）

`document.documentElement` 上三个 class —— `settings-page-open` / `search-page-open` / `people-page-open` —— 决定「中间侧栏归谁」。**三者必须互斥，且只能由当前 tab 派生**：唯一写者是 `app.js` 的 `syncPageOpenClasses(tab)`，由 `syncNavigationRail(tab)` 调用，而 `syncNavigationRail` 是所有切页路径的必经点（`showTabContent` / `openSettingsPage` / `leaveAiViewForBrowse`）。

为什么必须是派生：`settings-page-open` 原先只在 `openSettingsPage` 里 `add`、`closeSettingsPage` 里 `remove`。只要有一条路径改了 `state.currentTab` 而没走 `closeSettingsPage`（后台任务回调、启动落地、AI 视图退出、任何延迟回调），这个类就成了**孤儿**。而 `navigation.css` 里 `html.settings-page-open #sidebar > #settingsSidebar { display: block !important }` 的优先级高于 `#settingsSidebar[hidden] { display: none !important }`（两条都是 `!important`，比特异性），于是设置导航会永久盖在搜图 / 人物侧栏上、且再也摘不掉 —— 用户看到的就是「点搜图，残留设置分栏导航」。

两个配套约束：

- `prepareBrowsingShell`（`ui-navigation.js`）会把 `#settingsPage` 隐藏，但它**只被 `showTabContent` 调用**，而 `showTabContent` 现在必定先对齐 class —— 所以「隐藏了页面却留下页面态 class」这条路已经关上。它自己不得再维护任何 page-open 类（navigation-regression 静态守护）。
- CSS 侧另有一道兜底：设置页接管侧栏的规则带 `:not(.search-page-open):not(.people-page-open)`。正常态恒为真，只是万一 class 再变孤儿，保证搜图 / 人物侧栏仍然赢。
- `openSettingsPage` 的 `await` 之后要按 `state.currentTab` 重新对齐一次；若发现页面已被切走，连 `#settingsPage` 一起收起来 —— 只摘 class 会留下「右栏还是设置页、左栏已经是别的侧栏」的半截界面。

**网络独立成一类，不与「应用」合并。** 它管的是「别人怎么访问我的相册」（局域网地址 / 访问密码 / 公网隧道），与「应用」里的界面语言、启动页、关闭行为不是一回事；之前被并进「应用与网络」，用户找局域网地址要在一堆偏好设置里翻。拆开后 `settings.nav.app` / `settings.section.app` 只叫「应用」，网络另有 `settings.nav.network` / `settings.section.network`。

**`settingsSection*` id 只挂在这 6 个面板容器上**：面板内部的子块（AI 的两个挂载点、网络里的三个分节）不再带该前缀，否则 navigation-regression 的正则会把它们也当成类目。

**面板内不重复标题**：AI 子面板自带的 `.ai-header` 是「整页 / 弹窗」模式的主标题，embedded 挂载时**不再渲染**（`people.js` / `semantic-search.js` 的挂载分支跳过它，CSS 另有一道 `display:none` 兜底），命名只由类目标题承担。留着会出现「搜图 > 本地 AI / 多语言搜图」这种同义重复，并且字号层级倒挂——`people.css` 为人物整页模式定的 `.people-page .ai-header h2 { font-size: 20px }` 特异性高于 `theme-polish.css` 给设置页的 16px，导致子标题比类目标题还大。

**localStorage 兼容**：老用户 `photoManager.settingsLastSection.v1` 里可能存着任一代的旧 id，`app.js` 的 `SETTINGS_SECTION_ID_ALIAS` 负责映射到当前面板（语义 / 智能索引 / **`settingsSectionSearch` / `settingsSectionPeople`** → 各自的新类目，关闭 / 通用 → `settingsSectionApp`，媒体 → `settingsSectionStorage`，网络旧代别名已删——它现在有独立面板），写回时统一存新 id。**改面板划分时必须同步改这张表**，否则老用户会被丢回默认位置。反面案例：`settingsSectionNetwork` 曾是 6 面板时代留下的别名（指向 `settingsSectionApp`），网络拆成独立面板后如果不删掉这条，`normalizeSettingsSectionId()` 会把新面板的 id 又映射回「应用」，症状是「点导航里的网络、右栏却显示应用」；同理搜图 / 人物并进后台任务后，`settingsSectionSearch` / `settingsSectionPeople` 两个旧 id 必须映射到 `settingsSectionTasks`，否则老用户停留在设置页时会被丢回默认类目。

用户可见的类目名在 `settings.nav.*`，面板主标题在 `settings.section.*`，两处同名。AI 两行是这条规则的例外：它们不是面板而是后台任务里的行，名称在 `settings.task.aiSearch` / `settings.task.aiPeople`。

窄屏（600px 及以下）保留 60px 图标栏，中间分类改为抽屉；使用原有侧栏菜单按钮展开。专注浏览模式沿用隐藏导航的行为。

验证：navigation-regression 检查设置往返、导航退出设置、图标入口的 `data-tab` 序列、设置页导航 / 面板顺序一致性、每个面板是否都带 `data-settings-panel`、两个 AI 挂载点是否落在后台任务面板区间内，以及**页面态 class 是否单向派生**（`syncPageOpenClasses` 存在、`syncNavigationRail` 负责对齐、`settings.js` 与 `ui-navigation.js` 不得自己增删 page-open 类、CSS 兜底 `:not()` 必须在）；sidebar-tree-regression 与 ai-sidebar-regression 分别守住侧栏让位行为与设置页接管侧栏的优先级；people-page-regression 检查人物详情和预览返回；layout-regression 解析 index.html 校验三栏骨架（图标栏 → 侧栏 → 拖拽条 → 内容区）、侧栏内部容器归属，并拦截侧栏提前闭合与残留旧版导航标签。真实窗口截图见 `assets/` 与 `docs/main-layout.md` 的说明；交互链路的视觉验收仍靠无头 Electron + CDP 手动跑（配方见项目记忆）。

已知修复：导航从侧栏 tab 迁到左侧图标栏时，旧 `.nav-tabs` 容器只删了开头、留下了闭合标签，导致 `#sidebar` 提前闭合，`#sidebarContent` 等被挤到 `.main-layout` 同级形成第四栏。已删除残留标签与多余闭合标签，并由 layout-regression 长期守护。

修复前：侧栏被三个残留导航标签撑满，目录树与工具栏被挤到侧栏之外。

![修复前](assets/main-layout-broken.png)

修复后：图标栏（文件/日期/搜图/人物 ｜ 重复 + 底部设置）/ 侧栏 / 内容区三栏归位。

![修复后](assets/main-layout-fixed.png)
