/**
 * 桌面端 UI 文案：中文 / English。通过 data-i18n="key" 标记静态节点，setLocale 后统一刷新。
 */
(function (global) {
  'use strict';

  var M = {
    'zh-CN': {
      brand: '拂晓图库',
      'doc.title': '拂晓图库',
      'menu.file': '文件',
      'menu.file.addFolder': '添加文件夹',
      'menu.file.hideTray': '隐藏到托盘后台',
      'menu.file.quit': '退出拂晓图库',
      'menu.view': '查看',
      'menu.view.nextTheme': '下一套界面风格',
      'menu.view.compact': '简洁界面（侧栏与顶栏）',
      'menu.view.fullscreen': '全屏',
      'menu.view.devtools': '开发者工具',
      'menu.help': '帮助',
      'menu.help.shortcuts': '快捷键',
      'menu.help.about': '关于拂晓图库',
      'titlebar.min': '最小化',
      'titlebar.max': '最大化',
      'titlebar.closeHint': '关闭窗口（可在「管理设置 → 关闭按钮」中配置）',
      'topbar.themeAria': '快速切换界面风格',
      'topbar.themeTitle': '快速切换界面风格（与桌面端一致）',
      'topbar.manage': '管理设置',
      'topbar.localeAria': '界面语言',
      'topbar.localeTitle': '切换界面语言（与「管理设置 → 通用设置」同步）',
      'nav.folders': '文件夹',
      'nav.dates': '日期',
      'nav.duplicates': '重复',
      'nav.people': '人物',
      'nav.search': '搜图',
      'nav.settings': '设置',
      'nav.home': '首页',
      'nav.tags': '标签',
      'nav.primary': '主导航',
      'nav.allPeople': '全部人物',
      'nav.faceIndex': '识别设置与索引',
      // ===== 标签导航页（「标签」页）=====
      // 分类名与子类名用机器 id 拼键（`tagnav.cat.<id>` / `tagnav.sub.<id>`），
      // 由 `tag-nav-ui.js#nodeLabel()` 取；缺词条时它回落到模块里的中文兜底名，
      // 所以新增子类**不会**渲染出 id 字面量，但也没英文 —— 补词条才是完整做法。
      'tagnav.searchPlaceholder': '搜索标签',
      'tagnav.searchAria': '搜索标签',
      'tagnav.searchClear': '清除搜索',
      // 搜索是**提交式**的（敲字不搜，回车或点按钮才搜）⇒ 这个按钮就是那个出口，
      // 文案顺手把回车也说清楚。
      'tagnav.searchSubmit': '搜索标签（回车）',
      'tagnav.allTags': '全部标签',
      'tagnav.indexNote': '标签索引：{tags} 个标签 / {photos} 张图片',
      'tagnav.indexEmpty': '标签索引还没建好。先在右侧开始一次「语义索引」，标签导航才有内容。',
      'tagnav.tagCount': '{count} 张',
      'tagnav.catTotal': '共 {total} 个标签，已有 {indexed} 个',
      'tagnav.nodeTags': '{count} 个标签',
      'tagnav.expand': '展开',
      'tagnav.collapse': '收起',
      'tagnav.noResult': '没有匹配的标签',
      'tagnav.noTagHit': '这个节点下还没有已建立索引的标签',
      // 标签列表被展示线**滤空**时说的话（侧栏那行短、主区那行带出路）。
      // 🔴 与 `noTagHit` / `noResult` 是**两种不同的空**：那两句是「这儿本来就没有」，
      //    这两句是「有，但都低于你设的展示线」—— 混用会让用户去重建索引，而该做的是调低展示线。
      'tagnav.belowLine': '{count} 个标签都低于当前展示线',
      'tagnav.belowLineHint':
        '{count} 个标签都低于当前展示线，暂时没有可显示的图片。可在设置里调低「标签展示线」。',
      'tagnav.pickHint': '从左侧选一个分类或标签',
      'tagnav.photosOf': '「{name}」下的图片',
      'tagnav.loadFail': '标签数据读取失败，请稍后重试',
      'tagnav.searching': '正在搜索…',
      // 分类名（`tagnav.cat.<id>`）。⚠️ 与子类名**同键不同前缀**，两边都要有，
      // 否则 `tag-nav-ui.js#tNode()` 会走中文兜底名（英文环境显示中文）。
      'tagnav.cat.person': '人物与人数',
      'tagnav.cat.appearance': '外貌与发型',
      'tagnav.cat.expression': '表情与视线',
      'tagnav.cat.clothing': '服饰与穿戴',
      'tagnav.cat.pose': '动作与姿势',
      'tagnav.cat.scene': '场景与背景',
      'tagnav.cat.object': '物件与道具',
      'tagnav.cat.work': '作品与角色',
      'tagnav.cat.creator': '画师与来源',
      'tagnav.cat.composition': '构图与视角',
      'tagnav.cat.style': '画风与画质',
      'tagnav.cat.event': '主题与纪念日',
      'tagnav.cat.adult': '成人内容',
      'tagnav.cat.other': '其他',
      // 子类名（`tagnav.sub.<id>`）
      'tagnav.sub.count': '人数与合拍',
      'tagnav.sub.gender': '性别',
      'tagnav.sub.age': '年龄',
      'tagnav.sub.body': '体型与身体',
      'tagnav.sub.identity': '身份与职业',
      'tagnav.sub.skin': '肤色',
      'tagnav.sub.hair': '发型与发色',
      'tagnav.sub.eyes': '眼睛',
      'tagnav.sub.face': '面部特征',
      'tagnav.sub.animal_ear': '兽耳与尾巴',
      'tagnav.sub.wing_horn': '翅膀与角',
      'tagnav.sub.expression': '表情',
      'tagnav.sub.emoticon': '表情符号',
      'tagnav.sub.gaze': '视线与朝向',
      'tagnav.sub.mouth': '嘴部动作',
      'tagnav.sub.clothes_top': '上衣',
      'tagnav.sub.clothes_bottom': '下装',
      'tagnav.sub.clothes_full': '整身服装',
      'tagnav.sub.uniform': '制服与职业装',
      'tagnav.sub.legwear': '腿部穿戴',
      'tagnav.sub.footwear': '鞋靴',
      'tagnav.sub.headwear': '头饰',
      'tagnav.sub.handwear': '手部穿戴',
      'tagnav.sub.accessory': '饰品',
      'tagnav.sub.innerwear': '内衣',
      'tagnav.sub.swimwear': '泳装',
      'tagnav.sub.pattern': '纹样与剪裁',
      'tagnav.sub.posture': '姿态',
      'tagnav.sub.hand_action': '手与手臂动作',
      'tagnav.sub.leg_action': '腿部动作',
      'tagnav.sub.action': '行为与互动',
      'tagnav.sub.indoor': '室内',
      'tagnav.sub.outdoor': '室外与自然',
      'tagnav.sub.city': '城市与建筑',
      'tagnav.sub.sky_time': '天空与时间',
      'tagnav.sub.weather': '天气与季节',
      'tagnav.sub.background': '背景与底色',
      'tagnav.sub.element': '自然元素与特效',
      'tagnav.sub.weapon': '武器与装备',
      'tagnav.sub.food': '食物与饮品',
      'tagnav.sub.plant': '植物与花',
      'tagnav.sub.animal': '动物',
      'tagnav.sub.tool': '器物与文具',
      'tagnav.sub.furniture': '家具与家居',
      'tagnav.sub.music': '乐器与音响',
      'tagnav.sub.vehicle': '交通工具',
      'tagnav.sub.toy': '玩偶与玩具',
      'tagnav.sub.media_text': '文字与画面内的媒体',
      'tagnav.sub.series': '作品',
      'tagnav.sub.character': '角色',
      'tagnav.sub.cosplay': '角色扮演',
      'tagnav.sub.trope': '题材与设定',
      'tagnav.sub.source': '画师与来源',
      'tagnav.sub.shot': '景别',
      'tagnav.sub.angle': '视角与方位',
      'tagnav.sub.framing': '构图与画面结构',
      'tagnav.sub.medium': '媒介与技法',
      'tagnav.sub.render': '渲染风格',
      'tagnav.sub.quality': '画质与瑕疵',
      'tagnav.sub.palette': '色彩与色调',
      'tagnav.sub.day': '纪念日',
      'tagnav.sub.holiday': '节日与活动',
      'tagnav.sub.nudity': '裸露',
      'tagnav.sub.sexual': '性行为与性暗示',
      'tagnav.sub.fetish': '特殊偏好',
      'tagnav.sub.censored': '审查与修正',
      'tagnav.sub.other': '其他',
      'common.back': '返回',
      // 列表项之间的连接符 / 段落之间的分隔符 —— **必须跟语言走**（契约 §6「括号、分隔符都要跟语言走」）：
      // 中文顿号「、」与全角间隔点，英文逗号加空格（英文用顿号是排印错误）。
      'common.listSep': '、',
      'common.partSep': '　·　',
      'ai.search': '搜索',
      'ai.searchPlaceholder': '描述你想找的画面，例如：夕阳下的海滩',
      'ai.searchAria': '画面描述',
      'ai.modeAria': '搜索方式',
      'ai.modeKeyword': '关键词',
      'ai.modeSemantic': '语义',
      'ai.searchPlaceholderKeyword': '搜索文件名或文件夹名',
      'ai.searchAriaKeyword': '文件名或文件夹名',
      'ai.history': '搜索历史',
      'ai.historyClear': '清除',
      'ai.peopleSearchPlaceholder': '搜索人物名字',
      'ai.peopleSearchAria': '搜索人物',
      // ⚠️ 这两条是 AI 两节（人脸 / 搜图）的**标题**。2026-10-08 之前 `scan-flow.js` 每次渲染
      //    都拿另一份硬编码文案（「人脸模型 / 索引」）**覆盖**掉这里的词条 ⇒ 同一句话两处两份，
      //    而且只有代码那份能被改（这里改了界面也不动）。现在两处共用这一份。
      'task.faceTitle': '人脸模型 / 索引',
      'task.semanticTitle': 'AI 模型 / 索引',
      'task.title': '后台任务',
      'task.toggleExpand': '收起或展开详情',
      'task.collapse': '收起',
      'task.expand': '展开',
      'task.scanning': '正在扫描...',
      /**
       * 🔴 **扫描节的状态行 / 文件行文案**（2026-10-08 补，契约 §6.1 的最后一块）。
       * 它们从前全部**裸写在 `scan-flow.js`**（快路径 `updateProgress` + 面板重绘两处），
       * 以及 `app.js` 五处 `updateProgress(0, 1, '…')` 的第三参 —— 英文界面这几行显示中文。
       * 中文值**逐字节等于**原来的硬编码串（兜底串即原文）⇒ 中文行为零变化，
       * 这也让「改完中文产出不变」成为可断言的判据。
       * ⚠️ `{pct}` / `{n}` / `{err}` 都是**已格式化好的字符串**（数字用 `formatNumber`），
       *    词条里不要再写格式说明。
       */
      'task.scanPreparing': '准备中...',
      'task.scanRunning': '正在扫描... {pct}%',
      'task.scanPaused': '已暂停... {pct}%',
      'task.scanDone': '扫描完成',
      'task.scanEnumerating': '正在枚举文件... 已发现 {n} 个',
      'task.scanQueuedGate': '排队中，正在等前面的后台任务结束...',
      'task.scanQueuedPending': '排队中，前面还有 {n} 个任务',
      'task.scanFailed': '扫描失败：{err}',
      'task.unknownError': '未知错误',
      'task.scanDoneCleaned': '扫描完成，已清理失效记录 {n} 条',
      'task.rescanDoneMarked': '重扫完成，已标记失效记录 {n} 条',
      'task.rescanDoneFolders': '重扫完成，共 {n} 个目录',
      'task.rescanDoneFoldersMarked': '重扫完成（{n} 个目录），已标记失效记录 {m} 条',
      'task.scanStopped': '已停止：{n} 个目录未扫描完成',
      // 扫描**启动/失败**那两条弹窗提示（`app.js` 里 `appAlert(...)`）。它们与面板消息同属
      // 「扫描任务」这个面 ⇒ 归 `task.*`；而设置页那条整句（`settings.rescanAllFail`）
      // 仍是 `settings.*`（那串是设置页自己的句子，命名空间跟**消息的落点**走）。
      'task.autoScanFailed': '自动扫描失败：{err}',
      'task.rescanFailed': '重新扫描失败：{err}',
      'task.pause': '暂停',
      'task.stop': '停止',
      // 扫描节的「继续」（暂停后那个按钮）。它原来在 `scan-flow.js` 里是写死的中文 `'▶ 继续'`，
      // 而同一处的「暂停 / 停止」在 `index.html` 上**本来就有** `data-i18n="task.pause" / "task.stop"`
      // ⇒ 骨架一份、JS 覆盖时又写死一份中文，正是 §6 点名的那个静默形状（词条改了界面不动）。
      'task.resume': '继续',
      // 「已请求停止、还没停干净」时所有停止按钮的统一文案（扫描 / 补全 / 重建 / 查重四个按钮共用）。
      // 判据见 `docs/contracts/background-tasks.md` §8：`cancelled` 或 `phase === 'stopping'`。
      'task.stopping': '停止中...',
      // AI 两节（人脸 / 搜图）共用的主行 / 副行文案 —— 这两节共用一套，不再各写一份。
      // ⚠️ 原先它们在 `scan-flow.js` 里是 `(en ? 'Processed ' : '完成 ')` 这种**内联三元**：
      //    既绕过了 i18n（英文界面靠代码里的英文串撑着），又让「改文案要改两处」。
      'task.aiStopping': '正在停止 AI 任务…',
      'task.aiDone': '完成 {n}',
      // 分母两个来源**必须能区分**：估算写「约」，精确不写（与 `task.thumbCount` 同一条规矩）。
      'task.aiCount': '完成 {done} / {total}（{pct}%）',
      'task.aiCountEst': '完成 {done} / 约 {total}（{pct}%）',
      // 分母还没就绪时的两条（估算三态 `countPhase`，形状与补全 `task.thumbCountCounting` /
      // `thumbCountNoTotal` 一致 —— 前者会自己过去、后者不会，必须让用户分辨得出）。
      //   ⚠️ `'ready'` + `total = 0` **刻意不在这里**：那是「估成功且就是 0」，不是失败。
      'task.aiCountCounting': '已处理 {done}，正在估计待处理数量…',
      'task.aiCountNoTotal': '已处理 {done}（总数估计失败，暂不显示百分比与速率）',
      // 这两条是**追加片段**（不是整行）：只在 > 0 时拼到主行后面（跑起来很长一段都是 0）。
      'task.aiFailed': ' · 失败 {n}',
      'task.aiSkipped': ' · 跳过 {n}',
      /**
       * tag 倒排（第二路）的**独立计数行** —— 与主行并列、不是替换它。
       * 判据与理由见 `scan-flow.js` 里那段的注释：老库上 CLIP 索引早就建完（几秒过完），
       * 剩下的几十小时全在补打标，主行会一直停在「完成 0」、进度条不动 —— 面板看上去是死的。
       * ⚠️ 只有带「约」的那条：tag 的分母是「`photos` 行数 − `tag_photo` 行数」的**跨库估计值**
       *    （worker 上报时 `tagTotalEstimated` 恒为 true）⇒ 没有精确版可写，别照抄主行补一条。
       */
      'task.aiTagCount': '标签索引 {done} / 约 {total}（{pct}%）',
      'task.aiTagCountCounting': '标签索引 已打标 {done} 张，正在估计待打标数量…',
      'task.aiTagCountNoTotal': '标签索引 已打标 {done} 张（待打标总数估计失败，暂不显示百分比）',
      // 无确定分母时用速率代替 ETA（人脸 / 搜图没有 ETA，见 docs/contracts/background-tasks.md §7）。
      'task.aiRate': '{n} 张/分钟 · 停止后保留已完成结果',
      'task.aiPreparing': '准备中 · 可继续浏览图片',
      // 扫描队列角标。⚠️ 原先**连英文分支都没有** ⇒ 英文界面直接显示中文。
      'task.queueWaiting': '扫描队列 · 还有 {n} 项等待',
      'task.queuePending': '扫描队列 · {n} 项',
      'task.thumbTitle': '缩略图与图片信息补全',
      'task.thumbStop': '停止补全',
      // 后台任务面板（scan-flow.js）专用的主行 / 副行文案。
      // ⚠️ 与设置页那条路径（settings.task.thumbProgress*）**刻意分开**：
      //    面板的信息量更大（多出视觉指纹 / 查重指纹），强行共用一套模板只会互相牵制。
      //    但「口径」必须一致 —— 两边都是「已处理 N / 约 M（x%）」。
      'task.thumbCount': '{done} / 约 {total}（{pct}%）',
      'task.thumbCountCounting': '已处理 {done} 张，正在估计待补数量…',
      'task.thumbCountNoTotal': '已处理 {done} 张（待补总数估计失败，暂不显示百分比与剩余时间）',
      'task.thumbDetailThumbs': '预览图 {n}',
      // ⚠️ 2026-10-06 由「待补」改「还缺」：这个数从**任务起始快照**改成了**实时剩余**，
      //    语义变了文案必须跟着变 —— 否则「预览图 N」在涨、「待补 M」不动，读起来自相矛盾。
      'task.thumbDetailPending': '还缺 {n}',
      // 原图尺寸：补全与重建**两边都出**这一项（同一次读文件头顺带解出来的），
      // 所以文案只有一份 —— 一边写「尺寸」一边写「原图尺寸」会让人以为是两件事。
      'task.thumbDetailSized': '原图尺寸 +{n}',
      'task.thumbDetailExif': '拍摄信息 +{n}',
      'task.thumbDetailDhash': '视觉指纹 +{n}',
      'task.thumbDetailHash': '查重指纹 +{n}',
      'task.thumbDetailFailed': '失败 {n}',
      // 缩略图**全量重建**（顶栏面板的一块，与「补全」是两件事：补全 = 缺的补上，
      // 重建 = 已入库的按新档位 / 新编码整体重跑一遍）。主进程分成 `thumbs` / `thumbRebuild`
      // 两个字段报，面板也各画一块 —— 曾经只画了补全，重建在跑时顶栏看着像什么都没干。
      'task.thumbRebuildTitle': '重建全部缩略图',
      'task.thumbRebuildStop': '停止重建',
      'task.thumbRebuildCount': '{done} / {total}（{pct}%）',
      // 登记阶段一张都还没重生成（`done` 恒为 0），这时的唯一进展是「已扫描 N 行」
      'task.thumbRebuildEnqueueing': '已扫描 {scanned} 行、已登记 {enrolled} 张…',
      'task.thumbRebuildTarget': '目标 {spec}',
      // 重建那节的**产出 / 剩余**两项（对应补全那节的「预览图 N」「还缺 M」）。
      // ⚠️ 刻意**不复用** `task.thumbDetailPending`：补全的「还缺」= 库里还缺缩略图的行数，
      //    重建的「待重跑」= 队列里还没抽干的行数，两个数不是一回事，共用文案就是串口径。
      // 🔴 必须写「本次」：这个数**只是本次进程重出的量**（跨重启累计的那种在**主行**的 `done / total`）。
      //    2026-10-08 用户报「已完成的不是这一次跑的」—— 就是首版把它按累计量报了出去。
      'task.thumbRebuildDetailRebuilt': '本次已重出 {n}',
      'task.thumbRebuildDetailPending': '待重跑 {n}',
      // 预计剩余时间：七个面板（扫描 / 缩略图补全 / 重建 / 无效清理 / 查重 / 人脸 / 搜图）
      // 共用 scan-flow.js#formatEtaLine。⚠️ 那个「约」不是装饰：人脸 / 搜图两节的分母是
      // **抽样估计值**（`totalEstimated`）⇒ 那里的 ETA 天生只是量级，别改成「预计还需」。
      'task.etaPrefix': '预计剩余约 {parts}',
      'task.etaDays': '{n} 天',
      'task.etaHours': '{n} 小时',
      'task.etaMinutes': '{n} 分',
      'task.invalidCleanup': '清理无效文件记录',
      // 清理那节的计数 / 副行（原先两串都**写死中文**在 `scan-flow.js` 里，§6.1 漏记了它们）。
      // 分工：计数行说主口径（有分母时 `checked / total`，没分母时「已检查 N」）；
      // 副行说**产出**（删掉了几条）。从前「已删除 N 条」是拼在**文件行**尾巴上的，
      // 于是 total = 0 那段时间同一个数在计数行与文件行**各出现一次**。
      'task.invalidCleanupChecked': '已检查 {n}',
      'task.invalidCleanupDeleted': '已删除 {n} 条',
      'task.optimizeDb': '正在整理数据库',
      'task.dupTitle': '查找重复图片',
      // 查重那节的副行（产出明细）与指纹行。原先这两串**在 `scan-flow.js` 里写死中文**
      // （`'当前编号：'` / `'正在读取当前文件…'`）⇒ 英文界面显示中文，与 §6 的其它几处同一形状。
      // 产出明细用的三个数（已算 / 复用 / 失败）主进程一直在报，**界面从来没显示过**：
      // 分子 `done` 只说明「处理了多少行」，看不出其中多少是真算的、多少是复用现成指纹的。
      'task.dupDetailHashed': '已算指纹 {n}',
      'task.dupDetailReused': '复用已有 {n}',
      'task.dupHashCurrent': '当前编号：{hash}',
      'task.dupHashReading': '正在读取当前文件…',
      'stats.barFullFmt': '{photos} 张图片 | {totalSize} | 视频 {videos} 条 | {videoSize}',
      'stats.barFolderFmt': '{photos} 张图片 | 视频 {videos} 条',
      'stats.barImageFmt': '{photos} 张图片 | {totalSize}',
      'stats.barVideoFmt': '{videos} 条视频 | {videoSize}',
      'stats.barFolderImageFmt': '{photos} 张图片',
      'stats.barFolderVideoFmt': '{videos} 条视频',
      'stats.folderNoDirectPhotosFmt': '此文件夹下暂无直接图片 · {n} 个子目录（点击下方进入）',
      'stats.zeroPhotos': '0 张图片',
      'stats.folderCountFmt': '{n} 个目录',
      // `view=all` 的档位名：**含视频**，与 path.allFiles / sidebar.allFiles 同口径，
      // 所以是「所有文件」而不是「所有图片」/「所有图片」。当前无代码引用（死键），
      // 留在这里供后续接线，值必须与另两条一致。
      'toolbar.allPhotos': '所有文件',
      'path.duplicates': '重复图片（哈希）',
      'path.tag': '标签：{name}',
      'path.folderOverview': '\u{1F5C2}\uFE0F 所有目录',
      'path.allFiles': '所有文件',
      'path.crumbAria': '当前路径',
      'path.crumbRoot': '所有目录',
      'path.crumbExpand': '展开完整路径',
      'path.crumbSwitch': '切换到同级目录',
      'path.up': '返回上级',
      'path.upToFmt': '返回上级：{name}',
      'path.back': '后退',
      'path.forward': '前进',
      'path.backFmt': '后退：{name}',
      'path.forwardFmt': '前进：{name}',
      'path.favorites': '\u2B50 收藏',
      'path.favoritesSearchFmt': '\u2B50 收藏 · \u{1F50D} {q}',
      'filter.all': '全部',
      'filter.image': '仅图片',
      'filter.video': '仅视频',
      'filter.mediaAria': '媒体类型筛选',
      'filter.mediaTitle': '筛选显示：全部 / 仅图片 / 仅视频',
      'sort.dateTakenDesc': '最新拍摄',
      'sort.dateTakenAsc': '最早拍摄',
      'sort.fileNameAsc': '文件名 A-Z',
      'sort.fileNameDesc': '文件名 Z-A',
      'sort.fileSizeDesc': '文件最大',
      'sort.fileSizeAsc': '文件最小',
      // ===== 首页（Home，纯导航页）=====
      // 文案规范（面向客户，不是开发者文档）：标题写**好处**不写功能名；每条说明 ≤30 字、
      // 必须落在一行内（超一行会把同行卡片一起撑高）；不出现「索引 / 转码 / 数据库 / 阈值」
      // 这类技术词；说明里提到的能力必须在同卡的 chip 里够得着。守护按此断言。
      'home.subtitle': '图片都放在自己电脑里：原图不动、不上传，打开就能看。',
      // 库概览统计带的**标签**（值由 renderHomeStats 写，不是词条）。
      // 标签取「量词 + 名词」形式，读起来就是「12,345 张图片」。
      'home.stats.photos': '张图片',
      'home.stats.videos': '个视频',
      'home.stats.size': '总大小',
      'home.stats.folders': '个目录',
      'home.addFolder': '＋ 添加目录',
      'home.addFolderHint': '会打开设置页，在那儿添加和管理目录',
      'home.whatCanDo': '能做什么',
      'home.sectionNote': '卡片是介绍，点里面的按钮直接去',
      'home.grp.browse.title': '图片再多也找得到',
      'home.grp.browse.desc': '按文件夹翻、按日期翻，几万张也一目了然。',
      'home.grp.search.title': '一句话找到那张图片',
      'home.grp.search.desc': '说一句「海边的日落」就能搜到；图片里的人会自动归到人物里。',
      'home.grp.large.title': '再多也不卡',
      'home.grp.large.desc': '上百万张图片照样流畅，视频点开就看，字幕自动加载。',
      'home.grp.personal.title': '换个样子，多台设备看',
      'home.grp.personal.desc': '主题配色、快捷键都能改成顺手的；手机扫个码，家人一起看。',
      'home.chip.videos': '只看视频',
      'home.chip.photos': '只看图片',
      'footer.random': '随机',
      'footer.randomTitle': '随机跳转页码',
      'footer.randomAria': '随机页码',
      'footer.gridStyleLabel': '网格',
      'footer.gridStyleTitle': '网格布局与卡片比例（在「管理设置 → 浏览设置」里也能改）',
      'footer.gridStyleAria': '网格布局与卡片比例',
      'footer.pageSizeLabel': '每页',
      'footer.pageSizeTitle': '每页显示张数（在「管理设置 → 浏览设置」里也能改）',
      'footer.pageSizeAria': '每页显示张数',
      'footer.cardSizeLabel': '尺寸',
      'footer.cardSizeTitle': '缩略图格子大小（在「管理设置 → 浏览设置」里也能改）',
      'footer.cardSizeAria': '缩略图格子大小',
      'sidebar.resizerAria': '拖动调整侧栏宽度（双击复位，方向键微调）',
      'sidebar.allFiles': '所有文件',
      'sidebar.favorites': '收藏',
      'sidebar.allFolders': '所有目录',
      'sidebar.emptyNoFolders': '暂无文件夹<br>请点击「管理设置」添加',
      'sidebar.loading': '正在加载…',
      'sidebar.loadingFolders': '正在加载目录…',
      'sidebar.loadFoldersFail': '目录加载失败',
      'sidebar.duplicates': '重复图片',
      'sidebar.loadingDuplicates': '正在加载重复项...',
      'sidebar.loadingCovers': '正在加载各目录封面…',
      'sidebar.loadCoversFail': '目录封面加载失败',
      'sidebar.loadPhotosFail': '图片加载失败',
      'sidebar.retryOrSwitchView': '请稍后重试或切换左侧视图',
      'sidebar.retryLater': '请稍后重试',
      'sidebar.allDates': '所有日期',
      'sidebar.dateSortToolbarAria': '日期排序',
      'sidebar.dateSortDescTitle': '最新日期在前',
      'sidebar.dateSortAscTitle': '最早日期在前',
      'sidebar.dateSortDesc': '新→旧',
      'sidebar.dateSortAsc': '旧→新',
      'sidebar.datesEmpty': '暂无数据',
      'sidebar.loadingDates': '正在加载日期分组…',
      'sidebar.loadDatesFail': '日期列表加载失败',
      'sidebar.yearSuffix': ' 年',
      'sidebar.rescanRootTitle': '子文件夹有移动、重命名等变更时，点此重新扫描',
      'sidebar.rescanRootAria': '重新扫描此图库',
      'mobile.menuAria': '打开菜单',
      'settings.back': '返回相册',
      'settings.foldersDesc':
        '添加或移除扫描目录。如果在资源管理器里移动、重命名了子文件夹，或者大量增删了图片，请对相应目录点击「重新扫描」，让索引和磁盘保持一致（不会删除磁盘上的文件）',
      'settings.addRoot': '添加目录',
      'settings.folderPlaceholder': '正在读取目录列表…',
      'settings.closeSection': '关闭按钮',
      'settings.closeLabel': '点击标题栏 ✕ 或按 Alt+F4 时',
      'settings.closeDesc':
        '选「每次询问」时会弹出一个询问窗口，里面可以勾选「以后都这样」把选择记住。文件菜单里的「隐藏到托盘」「退出拂晓图库」不受这里影响。',
      'settings.close.ask': '每次询问我',
      'settings.close.tray': '隐藏到系统托盘（继续后台运行）',
      'settings.close.quit': '直接退出应用',
      'settings.general': '通用设置',
      'settings.uiLanguage': '界面语言',
      'settings.uiLanguageDesc': '切换后界面文字立即变化',
      'settings.lang.zh': '简体中文',
      'settings.lang.en': 'English',
      'settings.autoScan': '启动时自动扫描',
      'settings.autoScanDesc': '打开应用后自动重新扫描已添加的目录，把新增或变动的图片补进索引',
      'settings.autoThumb': '启动时自动补全缩略图、视觉指纹与拍摄信息',
      'settings.autoThumbDesc':
        '在后台为缺少预览图、视觉指纹或拍摄参数（相机 / 光圈 / 快门 / ISO / 定位）的图片补齐数据，闲下来才会跑',
      'settings.autoDup': '启动后自动查找重复图片',
      'settings.autoDupDesc':
        '在后台比对还没处理过的图片。若同时开启了自动扫描，会等扫描结束后再开始。',
      'settings.autoSemantic': '启动后自动建搜图索引',
      'settings.autoSemanticDesc':
        '把还没索引的图片交给搜图模型处理，完成后可以按画面内容搜图。首次会跑很久，期间请保持应用开着。',
      'settings.autoFace': '启动后自动建人脸索引',
      'settings.autoFaceDesc':
        '识别图片里的人脸并自动分组，完成后「人物」页才有内容。首次会跑很久，期间请保持应用开着。',
      'settings.launchPage': '启动后先看',
      'settings.launchPageDesc': '打开应用后默认停留的位置',
      'settings.launch.welcome': '欢迎页',
      'settings.launch.allFiles': '所有文件',
      'settings.launch.allFolders': '所有目录',
      'settings.launch.last': '上次位置',
      'settings.themeStyle': '界面风格',
      'settings.themeStyleDesc':
        '一整套搭配好的配色，选中后下面的强调色、背景基调会跟着变；单独调整任意一项后，这里会显示为「自定义组合」。材质纹理与面板透明度是独立维度，套用预设不会改动它们。菜单「查看」也能切换到下一套。',
      'settings.subtitleStyle': '字幕字体样式',
      'settings.thumbConc': '缩略图补全并发',
      'settings.thumbConcDesc': '同时处理张数（1–8），过大易占内存并加重磁盘随机读',
      'settings.similarThreshold': '相似图片判定',
      'settings.similarThresholdAria': '视觉相似判定严格程度',
      'settings.similarThresholdDesc':
        '越严格，找出的图片越接近「同一张」。用于预览页的「查找相似图片」和重复页的「视觉相似」。',
      'dialog.title': '提示',
      'dialog.cancel': '取消',
      'dialog.ok': '确定',
      'dialog.confirmTitle': '请确认',
      'dialog.gotIt': '知道了',
      'closeOverlay.title': '关闭拂晓图库',
      'closeOverlay.desc':
        '请选择本次操作。可在下方勾选「设为默认」，也可随时在「管理设置 → 关闭按钮」中修改',
      'closeOverlay.tray': '后台运行',
      'closeOverlay.quit': '退出程序',
      'closeOverlay.cancel': '取消',
      'closeOverlay.remember': '将本次选择的按钮设为默认关闭方式',
      'closeOverlay.hint': '提示：文件菜单中的「隐藏到托盘后台」「退出拂晓图库」不受此项影响',
      'closeOverlay.tasksRunning':
        '有 {n} 项后台任务正在运行（{list}）。点「退出程序」会先停止它们，停干净后自动退出。',
      'closeOverlay.stopTimeout':
        '后台任务未能在限时内停止，已取消本次退出。可在任务面板手动停止后再退出。',
      'task.scanNoun': '文件扫描',
      'theme.switchFailFmt': '切换界面风格失败：{err}',
      'theme.groupPresets': '快捷风格',
      'theme.groupAccent': '强调色',
      'theme.groupBg': '背景基调',
      'theme.groupTexture': '材质纹理',
      'theme.groupOpacity': '面板透明度',
      'theme.midnight_classic': '夜幕经典',
      'theme.ice_deep': '深空冰蓝',
      'theme.amber_dawn': '晨光琥珀',
      'theme.forest_shadow': '森影暮霭',
      'theme.sky_light': '晴空浅蓝',
      'theme.cherry_blossom': '樱雾粉昼',
      'theme.lavender_dusk': '暮紫微光',
      'theme.arctic_mint': '薄荷极光',
      'theme.desert_sand': '暖沙晨曦',
      'theme.paper_gray': '素纸浅灰',
      'theme.ember_night': '暗夜余烬',
      'theme.graphite_night': '石墨夜色',
      'theme.nebula_violet': '星云紫夜',
      'theme.pine_abyss': '松渊墨绿',
      'theme.mocha_night': '摩卡夜色',
      'theme.sage_morning': '鼠尾草晨雾',
      'theme.apricot_haze': '杏色薄雾',
      'theme.frost_cyan': '霜青微光',
      'theme.glass_night': '玻璃夜色',
      'theme.aurora_night': '渐变夜幕',
      'theme.glass_day': '玻璃白昼',
      'theme.aurora_dawn': '渐变晨曦',
      'theme.custom': '自定义组合',
      'settings.accent': '强调色',
      'settings.accentAria': '强调色',
      'settings.accentDesc': '按钮、选中态与焦点环的颜色，可与上面的整体风格自由组合',
      'settings.background': '背景基调',
      'settings.backgroundAria': '背景基调',
      'settings.textureAria': '材质纹理',
      'settings.opacityAria': '面板透明度',
      'settings.windowBackdrop': '窗口背景',
      'settings.windowBackdropAria': '窗口背景',
      'settings.windowBackdropRestartHint': '已改为新的窗口背景，重启应用后生效',
      'settings.windowBackdropDesc':
        '让整个窗口透出桌面，而不只是面板变淡。越往下越透，选好后需要重启应用才生效；Windows 11 22H2 及以上还会带上毛玻璃模糊。这一项管的是窗口本身透不透，面板透多少由上面的「面板透明度」决定。',
      'settings.backgroundDesc': '界面底色与卡片明暗，可与上面的整体风格自由组合',
      'accent.violet': '紫罗兰',
      'accent.cyan': '青蓝',
      'accent.teal': '青绿',
      'accent.rose': '玫红',
      'accent.amber': '琥珀',
      'accent.mono': '中性',
      'accent.coral': '珊瑚',
      'accent.indigo': '靛蓝',
      'accent.green': '翠绿',
      'accent.red': '赤红',
      'bg.default': '默认',
      'bg.ink': '墨色',
      'bg.warm': '暖调',
      'bg.cool': '冷调',
      'bg.amoled': '纯黑',
      'bg.glass': '玻璃',
      'bg.aurora': '渐变',
      'bg.paper': '纸感',
      'bg.mist': '海雾',
      'bg.forest': '深林',
      'bg.clay': '陶石',
      // 材质纹理（第三维）；names 与 index.html 四处下拉的 data-i18n 一一对应。
      // 漏一个键不会报错，界面直接显示裸键名 texture.grain —— theme-regression 的 §5b 专抓这个。
      'texture.none': '无',
      'texture.grain': '颗粒',
      'texture.paper': '纸纤维',
      'texture.linen': '亚麻',
      'texture.frost': '磨砂',
      'texture.grid': '十字网',
      'texture.dots': '点阵',
      'texture.stripe': '竖条纹',
      'texture.wood': '木纹',
      'opacity.opaque': '不透明',
      'opacity.slight': '轻微',
      'opacity.medium': '中等',
      'opacity.clear': '通透',
      // 窗口背景（窗口级开关，只有设置页一处入口；不进顶栏 → 没有顶栏后缀文案）
      'windowBackdrop.solid': '实色（不透明）',
      // ⚠️ 键名后缀必须与档位值**逐字符相同**（连字符，不是驼峰）：
      //    theme-regression §5b 按 `mainWbd.map(b => 'windowBackdrop.' + b)` 生成键名来
      //    检查双语名是否存在，驼峰写法会被判成「缺这一档的名字」。
      'windowBackdrop.acrylic-light': '亚克力 · 轻',
      'windowBackdrop.acrylic': '亚克力 · 中',
      'windowBackdrop.acrylic-strong': '亚克力 · 强',
      // 设置页 7 个面板的导航名（左栏 #settingsSidebar）；顺序与 index.html 的
      // [data-settings-panel] 一致，navigation-regression 会解析两边逐位比对。
      'settings.nav.folders': '媒体库',
      'settings.nav.browse': '浏览与显示',
      'settings.nav.shortcuts': '快捷键',
      'settings.nav.storage': '媒体与存储',
      'settings.nav.tasks': '后台任务',
      'settings.nav.ai': 'AI 与索引',
      'settings.nav.appearance': '外观与行为',
      'settings.nav.network': '网络与远程',
      'web.passwordSet': '已设置',
      'web.passwordUnset': '设置访问密码',
      'web.statusTextOn': '状态：已设置',
      'web.statusTextOff': '状态：未设置',
      'web.badgeOn': '已设置',
      'web.badgeOff': '未设置',
      'help.aboutTitle': '关于',
      'help.aboutBody':
        '拂晓图库 %VERSION%\n\n一款轻量级的本地相册应用（本地优先，索引与媒体保存在本机）\n支持百万级图片浏览与检索\n\n作者：拂晓AI\nhttps://foredawn.vip/',
      'help.shortcutsTitle': '快捷键',
      'help.shortcutsBody':
        '浏览（主界面）\n\n' +
        'Ctrl + Q — 隐藏窗口到系统托盘后台 / 再次按下恢复显示（全局快捷键；使用 Control 键，macOS 上不会占用 Cmd+Q 退出）\n' +
        '标题栏 ✕ / Alt+F4：由「管理设置 → 关闭按钮」决定：可每次询问（主题化弹窗）、直接托盘或直接退出。\n' +
        '询问弹窗内可勾选「设为默认」。文件菜单「隐藏到托盘」「退出拂晓图库」不受此项影响。\n' +
        'Ctrl + B — 简洁界面：收起或展开侧栏、顶栏与任务条（桌面端）\n' +
        '网格中收藏按钮在鼠标悬停到缩略图上时显示；触控屏上始终显示。\n\n' +
        '预览快捷键\n\n' +
        'Esc — 关闭预览\n' +
        '← / → — 上一张 / 下一张\n' +
        '空格 — 播放 / 暂停幻灯片\n' +
        'Delete — 删除到回收站\n' +
        'F — 收藏 / 取消收藏\n' +
        '0 — 重置缩放与旋转\n' +
        '+ / − — 放大 / 缩小\n' +
        'R — 顺时针旋转 90°（仅显示，不写文件）\n' +
        'Home / End — 当前列表首张 / 末张\n' +
        'O — 用系统默认程序打开当前图\n' +
        'Ctrl + 滚轮 — 缩放图片\n\n' +
        '菜单「查看」可切换到下一套界面风格。',
      'settings.closeWindowAria': '关闭主窗口时的行为',
      'settings.launchPageAria': '启动默认页',
      'settings.themeStyleAria': '界面风格',
      // 两个 AI 挂载点的 aria-label。它们在「后台任务」面板里由任务行标题
      // （搜图索引 / 人物索引）承担可见名称，这两个键给屏幕阅读器一个描述性全称。
      'settings.section.peopleAria': '人脸识别设置',
      'settings.section.semanticAria': '本地 AI 与多语言搜图设置',
      'settings.section.browse': '浏览与显示',
      'settings.section.storage': '媒体与存储',
      'settings.section.tasks': '后台任务',
      'settings.section.network': '网络与远程',
      'settings.section.folders': '媒体库',
      'settings.section.foldersDesc':
        '添加或移除要扫描的文件夹。在电脑上移动、重命名文件夹或大量增删图片后，点「重新扫描」让图库重新跟上磁盘的内容；不会删除磁盘上的任何文件。',
      'settings.section.browseDesc':
        '决定图片以什么顺序、多大、按什么比例铺在相册里。改完立即生效。',
      'settings.section.shortcuts': '快捷键',
      'settings.section.shortcutsDesc':
        '点一下右侧的键位框，然后直接按下你想用的组合键即可。改完立即生效，不需要重启。',
      'settings.section.storageDesc':
        '控制缩略图的清晰度与体积，以及视频播放时的临时文件占用。',
      'settings.section.tasksDesc':
        '这些任务都在后台慢慢跑，可以随时关掉窗口；同一时间只会进行其中一项。',
      'settings.section.ai': 'AI 与索引',
      'settings.section.aiDesc':
        '搜图与人物识别都在本机运行，图片不外传。这一页放模型、索引与识别参数。',
      'settings.section.appearance': '外观与行为',
      'settings.section.appearanceDesc':
        '选择整套配色，也可以单独微调强调色、背景、纹理与通透程度。改动立即生效并自动保存。',
      'settings.section.networkDesc':
        '让同一局域网里的手机、平板或别的电脑也能打开这个相册。',
      'settings.appearanceTitle': '界面外观',
      'settings.languageStartupTitle': '语言与启动',
      'settings.behaviorTitle': '窗口行为',
      'settings.browse.groupVideo': '视频',
      'shortcut.resetAll': '全部恢复默认',
      'shortcut.resetOne': '恢复默认',
      'shortcut.pressKeys': '请按下组合键…',
      'shortcut.unbound': '未设置',
      'shortcut.conflictOne': '与「{names}」使用了相同按键',
      'shortcut.conflictSummary':
        '有 {count} 处按键冲突：同一个按键被两个动作占用，只会有一个生效，请改成不同的组合键。',
      'shortcut.saveFailed': '保存快捷键失败：{error}',
      'shortcut.keyAria': '{name} 的按键',
      'shortcut.group.global': '全局',
      'shortcut.group.navigation': '导航',
      'shortcut.group.preview': '预览大图',
      'shortcut.action.addFolder': '添加文件夹',
      'shortcut.action.hideToTray': '隐藏到托盘后台 / 再次按下恢复',
      'shortcut.action.compactChrome': '切换简洁界面',
      'shortcut.action.fullscreen': '全屏',
      'shortcut.action.devtools': '开发者工具',
      'shortcut.action.navHome': '回到首页',
      'shortcut.action.navBack': '后退',
      'shortcut.action.navForward': '前进',
      'shortcut.action.randomPage': '随机跳转页码',
      // 组织元数据（标记 / 评分 / 用户标签）。三个维度的文案刻意保持**短**：
      // 它们都出现在冲片条 / 预览工具条的按钮上，字多了会把条挤成两行。
      // 🔴 这里**只放文字**、不放 ✓ / ✕ / ↺ —— 那些图案由按钮自己的
      //    `<svg class="btn-icon">`（`#icon-check` / `#icon-close` / `#icon-undo`）渲染。
      //    ⚠️ 历史上这三个值一度被迫写成 `'✓ 选'` 来「补」图案，原因是
      //    `data-i18n` 当时挂在 `<button>` 上、被 `applyDom()` 的 `el.textContent = val`
      //    把 `<svg>` 和 `<span class="btn-label">` 一起删了。2026-10-09 已把
      //    `data-i18n` 挪到 `.btn-label` 上根治 ⇒ 文案里**不许再加图案**（会双份）。
      'org.flag.pick': '选',
      'org.flag.pickTitle': '标记为「选」',
      'org.flag.reject': '否',
      'org.flag.rejectTitle': '标记为「否」',
      'org.flag.clear': '清除',
      'org.flag.clearTitle': '清除标记',
      'org.ratingLabel': '评分',
      'org.panel': '整理',
      'org.panelTitle': '整理：收藏 / 标记 / 评分 / 标签',
      'org.panelHeader': '整理',
      'org.sectionFlag': '标记',
      'org.sectionCompare': '对比',
      'org.tagsPanelTitle': '标签',
      'org.tagsPlaceholder': '输入标签后回车',
      'org.tagsAdd': '添加',
      'org.tagsHint': '回车添加；点标签上的 × 删除。改动立即保存。',
      'org.tagsEmpty': '还没有标签。输入后回车添加。',
      'org.tagRemove': '移除标签',
      'org.writeFailed': '操作失败',
      'org.filterRatingAria': '评分筛选',
      'org.filterAnyRating': '全部评分',
      'org.filterRating5': '5 星',
      'org.filterRating4': '4 星',
      'org.filterRating3': '3 星',
      'org.filterRating2': '2 星',
      'org.filterRating1': '1 星',
      'org.filterRatingNone': '未评分',
      'org.filterFlagAria': '标记筛选',
      'org.filterAnyFlag': '全部标记',
      'org.filterFlagNone': '未标记',
      'org.filterTagsAria': '标签筛选',
      'org.filterTags': '标签',
      'org.filterTagsHint': '选中多个标签 = 必须同时具备',
      'org.filterClear': '清除筛选',
      'org.filterTagsEmpty': '还没有任何标签',
      'shortcut.action.previewClose': '关闭预览',
      'shortcut.action.previewPrev': '上一张',
      'shortcut.action.previewNext': '下一张',
      'shortcut.action.previewFirst': '跳到第一张',
      'shortcut.action.previewLast': '跳到最后一张',
      'shortcut.action.previewSlideshow': '播放 / 暂停幻灯片',
      'shortcut.action.previewFavorite': '收藏 / 取消收藏',
      'shortcut.action.previewTrash': '删除到回收站',
      'shortcut.action.previewRotate': '顺时针旋转 90°（只改预览，保存才写回）',
      'shortcut.action.previewEditSave': '保存预览里的编辑（写回文件）',
      'shortcut.action.previewZoomIn': '放大',
      'shortcut.action.previewZoomOut': '缩小',
      'shortcut.action.previewZoomReset': '重置缩放与旋转',
      'shortcut.action.previewFindSimilar': '查找相似图片',
      'shortcut.action.previewOpenExternal': '用系统默认程序打开',
      'shortcut.action.previewFlagPick': '标记为「选」（PICK）',
      'shortcut.action.previewFlagReject': '标记为「否」（REJECT）',
      'shortcut.action.previewFlagClear': '清除标记',
      'shortcut.action.previewRating1': '评分 1 星（再按一次取消）',
      'shortcut.action.previewRating2': '评分 2 星（再按一次取消）',
      'shortcut.action.previewRating3': '评分 3 星（再按一次取消）',
      'shortcut.action.previewRating4': '评分 4 星（再按一次取消）',
      'shortcut.action.previewRating5': '评分 5 星（再按一次取消）',
      'settings.browse.defaultMode': '默认浏览方式',
      'settings.browse.defaultModeDesc':
        '以下选项在更改后会自动保存并刷新当前相册视图（若在管理页中）。',
      'settings.browse.groupSort': '排序与目录范围',
      'settings.browse.defaultSort': '默认排序',
      'settings.browse.sort.dateModifiedDesc': '最近修改',
      'settings.browse.sort.dateModifiedAsc': '最早修改',
      'settings.browse.sort.largestFile': '最大文件',
      'settings.browse.sort.smallestFile': '最小文件',
      'settings.browse.sort.pathAsc': '路径 A-Z',
      'settings.browse.sort.pathDesc': '路径 Z-A',
      'settings.browse.folderScope': '目录浏览范围',
      'settings.browse.includeSubfolders': '包含子文件夹',
      'settings.browse.currentFolderOnly': '仅当前文件夹',
      'settings.browse.folderScopeHintHtml':
        '「包含子文件夹」：侧栏选中某目录时，列出该目录及<strong>所有下级文件夹</strong>中的图片与视频。「仅当前文件夹」：只列出<strong>直接放在该目录下</strong>的媒体；子目录内容需再点进对应文件夹查看。',
      'settings.browse.groupPageGrid': '分页与网格',
      'settings.browse.pageSize': '每页显示',
      'settings.browse.pageSizeAria': '每页显示',
      'settings.browse.gridStyle': '网格与比例',
      'settings.browse.gridStyleAria': '网格布局与卡片比例',
      'settings.browse.grid.masonry': '原比例瀑布流',
      'settings.browse.grid.uniform': '统一高度',
      'settings.browse.grid.opt.masonry': '原比例瀑布流',
      'settings.browse.grid.opt.u11': '统一高度 · 1:1',
      'settings.browse.grid.opt.u34': '统一高度 · 3:4',
      'settings.browse.grid.opt.u43': '统一高度 · 4:3',
      'settings.browse.grid.opt.u916': '统一高度 · 9:16',
      'settings.browse.grid.opt.u169': '统一高度 · 16:9',
      'settings.browse.cardTier': '网格卡片',
      'settings.browse.cardTierAria': '网格卡片大小',
      'settings.browse.thumbCrop': '缩微图裁剪',
      'settings.browse.thumbCropAria': '缩微图裁剪',
      'settings.browse.thumbCropOff': '不裁剪',
      'settings.browse.thumbCropOn': '裁剪',
      'settings.videoClickBehavior': '点击视频',
      'settings.videoClickBehaviorDesc': '决定在网格里点开视频时，是用系统播放器还是在应用内播放',
      'settings.videoClickBehavior.system': '系统播放器',
      'settings.videoClickBehavior.embedded': '内嵌预览',
      'settings.infoPanel.group': '图片信息面板',
      'settings.infoPanel.hintHtml':
        '预览页点右侧「图片信息」时显示哪些字段。<br />改动立即保存并生效；<strong>全部不勾</strong>时面板会提示「无可用信息」。',
      'settings.infoPanel.selectAll': '全选',
      'settings.infoPanel.clearAll': '全不选',
      'settings.infoPanel.reset': '恢复默认',
      'settings.subtitleStyleSection': '字幕字体样式',
      'settings.subtitleStyleDesc':
        '预览视频里的字幕用什么字体、多大、多粗、什么颜色，改完立即生效并自动保存。',
      'settings.subtitle.font': '字体',
      'settings.subtitle.font.system': '系统无衬线',
      'settings.subtitle.font.serif': '衬线字体',
      'settings.subtitle.font.mono': '等宽字体',
      'settings.subtitle.size': '字号',
      'settings.subtitle.weight': '字重',
      'settings.subtitle.weight.normal': '常规',
      'settings.subtitle.weight.medium': '中等',
      'settings.subtitle.weight.bold': '加粗',
      'settings.subtitle.color': '颜色',
      'settings.subtitle.color.white': '白色（默认）',
      'settings.subtitle.color.yellow': '淡黄',
      'settings.subtitle.color.cyan': '浅青',
      'settings.subtitle.color.green': '浅绿',
      'settings.subtitle.color.orange': '橙色',
      'settings.subtitle.color.pink': '粉色',
      'settings.subtitle.sizeAria': '字幕字号',
      'settings.thumbSizeQuality': '缩略图尺寸与质量',
      'settings.thumbSizeQualityDesc':
        '尺寸越大越清晰、占用的磁盘也越多；编码固定为 WebP。改动只影响之后新生成的缩略图，已在库里的要用下方的「重建全部缩略图」转换。',
      'settings.thumbCurrentLineFmt': '当前生效：最大边长 {size} px · 画质 {quality}',
      'settings.thumbCurrentLoading': '当前生效：读取中...',
      'settings.thumbPendingHint': '已修改选项，请点击「确认应用」后才会写入配置',
      'settings.thumbMaxEdge': '最大边',
      'settings.thumbJpegQ': '画质',
      'settings.thumb.edge128': '128 px（省空间）',
      'settings.thumb.edge256': '256 px',
      'settings.thumb.edge320': '320 px',
      'settings.thumb.edge512': '512 px（默认，更清晰）',
      'settings.thumb.q55': '55（更小文件）',
      'settings.thumb.q75': '75（默认）',
      'settings.thumb.q95': '95（更高画质）',
      // 全量重建（改了档位 / 画质之后，把已入库的缩略图按新规格重跑一遍）
      'settings.thumbRebuildStart': '重建全部缩略图',
      'settings.thumbRebuildStop': '停止重建',
      'settings.thumbRebuildEnqueueing':
        '重建中：正在登记待重建清单（目标 {spec}），已扫描 {scanned} 行，已登记 {enqueued} 张…',
      'settings.thumbRebuildRunning':
        '重建中（目标 {spec}）：已处理 {done} / {total}（{pct}%），失败 {failed} 张{eta}',
      'settings.thumbRebuildStale':
        '目标规格：{spec} · 待重建清单需按新规格重新登记（点下方按钮开始，会先扫描全库）',
      'settings.thumbRebuildIdleEmpty':
        '目标规格：{spec} · 尚未重建过，点下方按钮把已入库的缩略图重跑一遍',
      'settings.thumbRebuildIdlePending':
        '目标规格：{spec} · 还有 {pending} 张待重建（共 {total} 张）{failedPart}',
      'settings.thumbRebuildIdleDone': '目标规格：{spec} · 已全部重建（共 {total} 张）{failedPart}',
      'settings.thumbRebuildFailedPart': '，失败 {failed} 张（保留原缩略图）',
      'settings.thumbRebuildReadError': '缩略图重建状态读取失败',
      'settings.thumbRebuildStartFail': '启动重建失败：{error}',
      'settings.thumbRebuildConfirmStart':
        '将扫描全库，把缩略图都按当前档位重新生成一遍。过程可能持续数小时并占用磁盘，期间可以随时停止、下次继续。',
      'settings.thumbRebuildConfirmReset':
        '目标规格已改变，将先扫描全库重新登记待重建清单，再逐张重跑缩略图。过程可能持续数小时并占用磁盘，期间可以随时停止、下次继续。',
      'settings.thumbRebuildConfirmResume':
        '还有 {pending} 张待重建，将接着上次的进度继续。期间可以随时停止、下次继续。',
      'settings.apply': '确认应用',
      'settings.hlsCache': '视频播放缓存上限',
      'settings.hlsCacheDesc':
        '边转边播视频时会生成临时切片，超出上限后自动清理最早的那些。磁盘上限填 0 表示不限制大小，只按数量清理。',
      'settings.hls.diskCap': '磁盘上限',
      'settings.hls.dirCap': '目录上限',
      'settings.hls.hint': '建议 1GB / 48 个目录。保存后从下一次播放开始生效。',
      // 「设置项写库/应用失败」与「保存成功提示」同族 —— 三处浏览工具栏的失败提示
      //（缩略图尺寸 / 每页张数 / 网格比例）+ HLS 缓存保存 + 缩略图设置应用 + 打开目录。
      'settings.hlsCacheSavedFmt': '已保存：{gb}GB / {en} 目录（新会话按新阈值生效）',
      'settings.hlsCacheSaveFailFmt': '保存 HLS 缓存设置失败：{err}',
      'settings.thumbApplyFailFmt': '应用缩略图设置失败：{err}',
      'settings.cardSizeFailFmt': '切换缩略图尺寸失败：{err}',
      'settings.pageSizeFailFmt': '切换每页显示张数失败：{err}',
      'settings.gridStyleFailFmt': '切换网格与比例失败：{err}',
      'settings.openFolderFailFmt': '无法打开目录：{err}',
      'settings.storage.dataDir': '图库数据位置',
      'settings.storage.dataDirDesc':
        '图片信息、缩略图、AI 索引和缓存都放在这个文件夹里，用久了会占很多空间。想换到空间更大的磁盘，用下面的「迁移到…」整份搬过去。',
      'settings.storage.dataDirMigrate': '迁移到…',
      'settings.storage.dataDirOpen': '打开文件夹',
      'settings.storage.dataDirOpenTitle': '在系统的文件管理器里打开这个位置',
      'settings.storage.dataDirReading': '读取中…',
      'settings.storage.dataDirCurrentFmt': '{path}　·　已占用 {size}',
      'settings.storage.dataDirCustomHint': '（默认位置是 {path}）',
      'settings.storage.dataDirFreeFmt': '所在磁盘还剩 {free}',
      'settings.storage.dataDirFallbackFmt':
        '⚠️ 你指定的位置这次打不开，本次启动临时改用了默认位置（{reason}）',
      'settings.storage.dataDirFallbackTitle': '图库数据位置打不开',
      'settings.storage.dataDirFallbackDialogFmt':
        '你指定的图库数据位置这次没能打开，本次启动已临时改用默认位置。\n\n' +
        '所以图库看起来可能是空的 —— 图片并没有丢。\n\n' +
        '如果它是移动硬盘或网络盘，接回来重启应用就能恢复；如果这个位置已经不用了，可以到「设置 → 媒体与存储」里改到新位置。\n\n' +
        '（打不开的是：{reason}）',
      'settings.storage.dataDirPickTitle': '选择图库数据的新位置',
      'settings.storage.dataDirConfirmTitle': '确认迁移图库数据',
      // 两块正文只差一句「目标磁盘还剩多少」：读不到余量时不能把「未知」塞进那句话里
      // （「目标磁盘还剩 未知」不是人话），所以分成两条键。
      'settings.storage.dataDirConfirmFmt':
        '将把图库数据（共 {size}）从\n{from}\n迁移到\n{to}\n\n' +
        '目标磁盘还剩 {free}。迁移期间请不要使用图库，完成后应用会自动重启。\n\n' +
        '原位置的数据在复制完成、检查无误之前不会被改动；中途失败也不会有任何损失。',
      'settings.storage.dataDirConfirmNoFreeFmt':
        '将把图库数据（共 {size}）从\n{from}\n迁移到\n{to}\n\n' +
        '迁移期间请不要使用图库，完成后应用会自动重启。\n\n' +
        '原位置的数据在复制完成、检查无误之前不会被改动；中途失败也不会有任何损失。',
      // 会在所选位置下新建文件夹时，先说清楚（用户点中的目录 ≠ 数据真正落地的目录）
      'settings.storage.dataDirConfirmSubdirFmt':
        '会在所选位置 {picked} 下新建文件夹 {name}，数据放进那里。\n\n',
      'settings.storage.dataDirMigratingFmt': '正在迁移…{percent}%（{current}）',
      'settings.storage.dataDirPhasePrepare': '正在准备…',
      'settings.storage.dataDirPhaseRelease': '正在暂停图库读写…',
      'settings.storage.dataDirPhaseCopy': '正在复制数据…',
      'settings.storage.dataDirPhaseVerify':
        '正在检查新位置的数据…\n大图库这一步要几分钟，请不要关闭窗口。',
      // 校验阶段要给出**已等多久**：真库实测 18 GB 要 5 分 19 秒，不给秒数的话
      // 「正在检查…」放五分钟，用户只能判定它卡死（他报的原话就是这个）。
      'settings.storage.dataDirPhaseVerifyFmt':
        '正在检查新位置的数据…（{elapsed}）\n大图库这一步要几分钟，请不要关闭窗口。',
      'settings.storage.dataDirVerifySecFmt': '已等 {seconds} 秒',
      'settings.storage.dataDirVerifyMinFmt': '已等 {minutes} 分 {seconds} 秒',
      'settings.storage.dataDirPhaseCleanup': '正在清理原位置…',
      'settings.storage.dataDirDoneFmt': '迁移完成，正在重启应用…（已搬 {size}，新位置有 {count} 张图片）',
      'settings.storage.dataDirTrashedFmt': '原位置的 {names} 已放入回收站，需要时可以从回收站恢复。',
      'settings.storage.dataDirPurgedFmt':
        '原位置的 {names} 已直接删除 —— 文件太大放不进回收站。新位置的数据是完整的，但这些旧文件无法找回。',
      'settings.storage.dataDirCleanupFailedFmt':
        '新位置已经可以正常使用，但原位置的 {names} 没能删掉。它们只是白占空间，你可以自己删除。',
      'settings.storage.dataDirDoneKeepFmt':
        '迁移完成，正在重启应用…（原位置的文件已保留，确认无误后可自行删除）',
      'settings.storage.dataDirFailFmt': '迁移没有完成。\n\n{error}\n\n图库数据没有变动，仍在原位置。',
      'settings.storage.dataDirFailRestart':
        '迁移没有完成。\n\n{error}\n\n应用即将重启，重启后继续使用原位置 —— 图库数据没有变动。',
      'settings.storage.dataDirReadFailFmt': '读取位置信息失败：{error}',
      'settings.storage.dataDirPickFailFmt': '打开文件夹选择窗口失败：{error}',
      'settings.storage.dataDirSpaceFmt':
        '目标磁盘空间不够：需要 {need}，现在只有 {free}，还差 {shortage}。\n\n请换一个空间更大的位置，或先清理一些文件。',
      'settings.storage.dataDirErrEmpty': '请先选择一个要迁移到的文件夹',
      'settings.storage.dataDirErrSame': '这就是当前的位置，请另选一个文件夹',
      'settings.storage.dataDirErrInside':
        '不能选当前文件夹里面的子文件夹（那样会把数据复制进自己），请另选一个位置',
      'settings.storage.dataDirErrOccupied':
        '这个位置下已经有一份图库数据了。想继续用那一份，请在上一层里直接选中它；想搬到这里，请另选一个位置。',
      'settings.storage.dataDirBusy': '正在迁移图库数据，请稍候',
      // 被别的后台任务占着库：这不是失败，是在等它 —— 界面自动重试，如实报出等了多久
      'settings.storage.dataDirBusyWaitFmt':
        '{reason}\n（迁移要等它结束，正在自动重试…已等 {seconds} 秒）',
      'settings.storage.dataDirBusyGiveUpFmt':
        '迁移还没能开始：{error}\n\n迁移要等这些后台任务结束才能动手。等它跑完后再点一次「迁移到…」就行 —— 图库数据没有变动。',
      // 迁移要先独占图库、把「清理失效记录」让开：这是用户看不到的副作用，必须回来说一声。
      // 按 scope 分三种口径 —— 自动那一趟每次启动都会重排，手动那一趟只能用户自己再点。
      'settings.storage.dataDirPausedFmt': '已为这次迁移暂停「{names}」，下次启动图库时会接着做。',
      'settings.storage.dataDirPausedManualFmt':
        '已为这次迁移暂停「{names}」，需要时再点一次就会接着做。',
      'settings.storage.dataDirPausedBothFmt':
        '已为这次迁移暂停「{names}」。自动的那一次会在下次启动图库时接着做，手动的那一次需要你再点一次。',
      // 认不出的 scope 走这句：不许猜「它会怎么自动恢复」，只承诺用户能自己重新开始
      'settings.storage.dataDirPausedOtherFmt': '已为这次迁移暂停「{names}」，你可以随时重新开始。',
      'settings.task.thumbBackfill': '缩略图补全',
      'settings.task.thumbBackfillDesc':
        '为还没有预览图的图片生成缩略图，同时为缺少视觉指纹的图片补上指纹，用于「视觉相似」',
      'settings.task.thumbStart': '开始补全',
      'settings.task.thumbExportFailTitle':
        '将当前或上一轮补全中失败文件的路径导出为 txt（每行一条）',
      'settings.task.thumbExportFailedPaths': '导出失败路径',
      'settings.task.thumbConcurrency': '同时处理',
      'settings.task.thumbConcurrencyAria': '缩略图补全同时处理张数',
      // ⚠️ 文案带上「实测到顶的位置」：用户会自然地认为越大越快，而 12/16 实测无增益
      //    （瓶颈是单张图内部的串行段，不是核数）；冷读场景 8 甚至比 4 慢
      //    （外接盘随机读抢寻道）。详见 `main.js#createDefaultSettings()` 的实测表。
      'settings.task.thumbConcurrencyHint':
        '越大越快；实测 4~8 之间到顶，再大只多占内存（冷门硬盘上反而更慢）',
      'settings.task.dupHash': '重复图片比对',
      'settings.task.dupHashDesc':
        '逐张比对图片内容，找出完全相同的重复项。只处理还没比对过、并且文件仍在电脑上的图片。',
      'settings.task.dupStart': '开始比对',
      'settings.task.dupStop': '停止比对',
      'settings.task.maintenance': '图库维护工具',
      'settings.task.maintenanceDesc': '清理失效记录、校正缩略图记录、整理数据库，或先备份一份再动手',
      'settings.task.cleanupInvalid': '清理失效记录',
      'settings.task.rebuildThumbFlags': '重建缩略图记录',
      'settings.task.optimizeDb': '整理数据库',
      'settings.task.openDbFolder': '打开所在文件夹',
      'settings.task.backupDb': '备份数据库',
      // AI 索引也归在这张清单里：它们与上面三项同类（长跑、可停止、可续跑），
      // 只是额外还要管模型与识别参数，那部分由各自挂载点自带的控件承担。
      'settings.task.aiSearch': '搜图索引',
      'settings.task.aiPeople': '人物索引',
      'settings.autoRunSection': '自动执行',
      'settings.autoRunHint':
        '打开应用后自动做哪些事。同一时间只会跑一项，互不打架。',
      'settings.network.title': '局域网访问',
      'settings.network.urlLabel': '访问地址',
      'settings.network.statusOn': '运行',
      'settings.network.urlDesc': '在同一局域网里的设备上打开这个地址，就能浏览相册',
      'settings.network.starting': '启动中...',
      'settings.network.copy': '点击复制',
      'settings.network.qrHint': '手机扫码打开',
      'settings.network.qrAria': '用于在手机上打开相册的二维码',
      'settings.network.passwordLabel': '访问密码',
      'settings.network.passwordUnsetBadge': '未设置',
      'settings.network.passwordDesc':
        '设置后，浏览器打开时需要先输入这个密码。留空表示不设密码。',
      'settings.network.passwordPlaceholder': '设置访问密码',
      'settings.network.tunnel': 'Cloudflare Tunnel',
      'settings.network.tunnelOff': '未开启',
      'settings.network.tunnelDesc':
        '开启后会生成一个临时公网地址，离家也能访问。为避免相册被陌生人看到，必须先设置访问密码。此开关只对本次运行有效，下次启动不会自动开启。',
      'settings.network.tunnelBinaryChecking': 'cloudflared：检测中...',
      'settings.network.tunnelLogHint': '启动日志（仅失败时显示，可复制发给我排查）',
      'settings.network.tunnelCopyLog': '复制日志',
      'settings.network.tunnelUrlPending': '未获取',
      'settings.common.unknownError': '未知错误',
      'settings.save.browsePrefsFail': '保存浏览偏好失败：{error}',
      'settings.save.generalFail': '保存通用设置失败：{error}',
      'settings.save.localeFail': '保存语言设置失败：{error}',
      'settings.save.windowCloseFail': '保存关闭按钮设置失败：{error}',
      'settings.save.infoFieldsFail': '保存图片信息字段失败：{error}',
      'settings.folderTableAria': '相册根目录列表',
      'settings.folderColPath': '路径',
      'settings.folderColActions': '操作',
      'settings.folderEmptyTitle': '暂无相册目录',
      'settings.folderEmptyDesc': '点击上方「添加目录」按钮开始管理图片',
      'settings.folderRescan': '重新扫描',
      'settings.folderRescanTitle': '子文件夹移动、重命名或大量增删图片后，请重新扫描以同步索引',
      // 单目录「重新扫描」的确认正文（与面板级 `settings.rescanAllConfirm` 同族，措辞只差「全部」那两处）。
      'settings.folderRescanConfirm':
        '将重新遍历该根目录，仅更新有变动的文件。\n' +
        '未变化记录会保留；本次未扫描到的记录会标记为失效并在界面隐藏（不会立刻删除）。\n\n' +
        '适用于：在资源管理器中调整子文件夹（移动、重命名）、大量增删图片后索引与实际不一致等情况。\n\n' +
        '提示：失效记录保留缩略图和指纹；仅在“清理失效文件记录”时才会物理删除。\n\n' +
        '确定继续？',
      'settings.folderRemove': '移除',
      'settings.folderRemoveConfirm':
        '确定要移除此目录吗？\n移除后该目录下的图片索引将被清除，图片文件不会被删除。',
      // 面板级动作：一次重扫**全部**根目录（入口在「媒体库」面板头部，与「添加目录」并排）。
      // 语义与单目录那枚「重新扫描」完全一致，只是把 N 个目录一次性排上、串行跑完。
      'settings.rescanAll': '重新扫描全部',
      'settings.rescanAllTitle': '依次重新扫描全部根目录；未变动的文件会跳过，可中途停止',
      'settings.rescanAllBusy': '正在重新扫描…',
      'settings.rescanAllPreparing': '正在准备重新扫描全部目录...',
      'settings.rescanAllConfirm':
        '将依次重新遍历全部根目录，仅更新有变动的文件。\n' +
        '未变化记录会保留；本次未扫描到的记录会标记为失效并在界面隐藏（不会立刻删除）。\n\n' +
        '逐个目录串行执行，点「停止」会连同还没开始的目录一起取消。\n\n' +
        '确定继续？',
      'settings.rescanAllEmpty': '还没有添加任何目录，先用「添加目录」选一个吧。',
      'settings.rescanAllFail': '重新扫描失败: {error}',
      'settings.rescanAllPartialFail': '{failed}/{total} 个目录重新扫描失败：{error}',
      'settings.network.statusNotReady': '未就绪',
      'settings.network.urlWhenOff': '未开启',
      'settings.network.readError': '读取失败',
      'settings.network.copied': '已复制！',
      'settings.network.tunnelRunning': '运行中',
      'settings.network.tunnelStarting': '启动中',
      'settings.network.tunnelError': '异常',
      'settings.network.tunnelPending': '待就绪',
      'settings.network.tunnelBinaryFmt': 'cloudflared：{path}',
      'settings.network.tunnelBinaryNotFound': 'cloudflared：未找到',
      'settings.network.tunnelBinaryReadError': 'cloudflared：读取失败',
      'settings.network.webToggleFail': '局域网访问开关操作失败：{error}',
      'settings.network.tunnelPwdFirst': '请先设置网页访问密码，再开启 Tunnel。',
      'settings.network.tunnelApplyPwdFirst': '请先点击「确认应用」保存访问密码，再开启 Tunnel。',
      'settings.network.tunnelToggleFail': 'Tunnel 操作失败：{error}',
      'settings.network.passwordSaved': '访问密码已设置',
      'settings.network.passwordCleared': '访问密码已清除',
      'settings.network.passwordSaveFail': '保存访问密码失败：{error}',
      'settings.network.logCopied': '已复制',
      'settings.task.hlsHintCurrentFmt':
        '当前生效：{gb}GB / {entries} 目录（磁盘上限 0GB 表示不限）',
      'settings.task.thumbEtaPrefix': '，',
      'settings.task.thumbProgressRunning':
        '补全中：已处理 {done} / 约 {total}（{pct}%），预览图 {thumbs} 张，拍摄信息 {exifFilled} 张，失败 {failed}{eta}',
      'settings.task.thumbProgressCounting': '补全中：已处理 {done} 张，正在估计待补数量…',
      'settings.task.thumbProgressNoTotal':
        '补全中：已处理 {done} 张（待补总数估计失败，暂不显示百分比与剩余时间）',
      'settings.task.thumbProgressDone':
        '{doneLabel}：已处理 {done} 张（共约 {total}），预览图 {thumbs} 张，失败 {failed}',
      'settings.task.thumbProgressDoneNoTotal':
        '{doneLabel}：已处理 {done} 张，预览图 {thumbs} 张，失败 {failed}',
      'settings.task.thumbStopped': '已停止',
      'settings.task.thumbCompleted': '已完成',
      'settings.task.thumbReadError': '补全状态读取失败',
      'settings.task.thumbExportEmpty': '暂无失败记录可导出',
      'settings.task.thumbExportFail': '导出失败：{error}',
      'settings.task.thumbExportOk': '已导出 {count} 条路径到：\n{path}',
      'settings.task.thumbStartFail': '启动补全失败: {error}',
      'settings.task.dupProgressRunning':
        '检测中 {done}/{total}（{pct}%），新算哈希 {hashed}，复用缓存 {reused}，失败 {failed}',
      'settings.task.dupProgressDone':
        '{doneLabel}：全量 {total}，新算哈希 {hashed}，复用缓存 {reused}，失败 {failed}；重复组 {groups}，重复图片 {photos}',
      'settings.task.gotoSimilar': '查看视觉相似',
      'settings.task.gotoSimilarTitle': '跳转到「重复」页面的视觉相似模式',
      'settings.task.dupIdle': '将按入库顺序对全部图片计算 SHA-256（未变化文件会复用已有指纹）',
      'settings.task.dupReadError': '重复检测状态读取失败',
      'settings.task.dupStarting': '正在启动重复检测任务...',
      'settings.task.dupStartFail': '启动失败：{error}',
      'settings.task.maintConfirmCleanup': '将检查并删除数据库中指向不存在文件的记录，是否继续？',
      'settings.task.maintCleaning': '正在清理失效文件记录...',
      'settings.task.maintCleanupFail': '清理失败：{error}',
      'settings.task.maintCleanupDone':
        '清理完成：检查 {checked} 条，删除失效文件 {deleted} 条；移除失效根目录 {removedRoots} 个（级联删除 {deletedByMissingRoots} 条），合计删除 {totalDeleted} 条',
      'settings.task.maintRebuildRunning': '正在重建缩略图标记...',
      'settings.task.maintRebuildFail': '重建失败：{error}',
      'settings.task.maintRebuildDone': '重建完成：仍缺失缩略图 {missing} 条',
      'settings.task.maintOptimizeConfirm': '将执行数据库优化（可能耗时数秒），是否继续？',
      'settings.task.maintOptimizing': '正在优化数据库...',
      'settings.task.maintOptimizeFail': '优化失败：{error}',
      'settings.task.maintOptimizeDone': '数据库优化完成',
      'settings.task.maintBackupPreparing': '准备备份…',
      'settings.task.maintBackupCancelled': '已取消备份',
      'settings.task.maintBackupCancelledAlt': '备份已取消',
      'settings.task.maintBackupFail': '备份失败：{error}',
      'settings.task.maintBackupDone': '已备份到：{path}',
      'preview.slideshow.play': '▶ 播放',
      'preview.slideshow.pause': '⏸ 暂停',
      'preview.slideshow.intervalAria': '幻灯片间隔',
      'preview.slideshow.random': '随机',
      'preview.slideshow.randomTitle': '幻灯片随机顺序',
      'preview.info': '图片信息',
      'preview.infoModuleMissing': '图片信息模块未加载',
      'preview.fullscreen': '全屏',
      'preview.enterFullscreen': '全屏',
      'preview.exitFullscreen': '退出全屏',
      'preview.atFirst': '已是第一张',
      'preview.atLast': '已是最后一张',
      'preview.rotate': '旋转',
      'preview.rotateTitle': '顺时针旋转 90° (R)（只改预览；点「保存」或 Ctrl+S 才写回）Shift 为逆时针',
      'preview.flip': '翻转',
      'preview.flipTitle': '水平翻转（只改预览；点「保存」才写回）Shift 为垂直翻转',
      'preview.crop': '裁剪',
      'preview.cropTitle': '裁剪并另存副本（只记录选区；点「保存」才写回）',
      'preview.editSave': '保存',
      'preview.editSaveTitle': '保存编辑并写回文件（Ctrl+S）',
      'preview.editDiscard': '放弃',
      'preview.editDiscardTitle': '放弃未保存的编辑（不写回文件）',
      'edit.saved': '已保存',
      'edit.failed': '编辑失败',
      'edit.discarded': '已放弃未保存的编辑',
      'edit.cropHint': '回车确认 / Esc 取消',
      'edit.cropPendingHint': '已选好裁剪区域 · 回车保存 / Esc 取消',
      'edit.cropStaged': '已选好裁剪区域，点「保存」写回',
      'edit.saveOrDiscardCrop': '请先保存或放弃已选好的裁剪区域',
      'edit.pendingTitle': '有未保存的编辑',
      'edit.pendingMessage': '离开会丢弃当前未保存的旋转 / 翻转 / 裁剪，确定要放弃吗？',
      'edit.cropSaved': '裁剪副本已保存',
      'edit.noPhoto': '没有可裁剪的图片',
      'edit.unsupported': '当前环境不支持编辑',
      'preview.subtitle.auto': '字幕: 自动',
      'preview.subtitle.off': '字幕: 关闭',
      'preview.subtitle.trackAria': '字幕来源',
      'preview.subtitle.styleBtn': '字幕样式',
      'preview.subtitle.styleTitle': '字幕样式',
      'preview.favorite': '收藏',
      'preview.favoriteTitle': '收藏 (F)',
      'preview.live': '实况',
      'preview.liveTitle': '播放这张实况照片的动态（Live Photo 的伴生视频）',
      'preview.findSimilar': '相似',
      'preview.findSimilarTitle': '查找与此图片视觉相似的图片 (S)',
      'preview.similarNoPhotoInfo': '无法获取当前图片信息',
      'preview.similarUnavailable': '查找相似图片功能暂不可用',
      'preview.similarNoneFound': '未找到与此图片视觉相似的图片',
      'preview.similarNoDetails': '未找到相似图片的详细信息',
      'preview.similarFoundFmt': '⭐ 查找相似图片 · 找到 {n} 张与「{name}」相似的图片',
      'preview.similarFailFmt': '查找相似图片失败：{err}',
      'preview.showInFolder': '位置',
      'preview.showInFolderTitle': '在资源管理器中显示',
      'preview.openExternal': '系统打开',
      'preview.openExternalTitle': '用系统默认程序打开当前图 (O)',
      'preview.trash': '删除',
      'preview.trashTitle': '移到回收站',
      'preview.winMin': '最小化窗口',
      'preview.winMax': '全屏预览',
      'preview.winRestore': '还原窗口',
      'preview.winMaximize': '最大化窗口',
      'preview.close': '关闭预览',
      'preview.videoPlay': '播放视频',
      'preview.videoPlayPauseTitle': '播放/暂停',
      'preview.prev': '上一张',
      'preview.next': '下一张',
      'preview.subtitlePanel.size': '字号',
      'preview.subtitlePanel.weight': '字重',
      'preview.subtitlePanel.color': '颜色',
      'preview.subtitlePanel.apply': '确认',
      'preview.subtitlePanel.close': '关闭',
      'preview.zoomHelpHtml':
        'Ctrl（Mac：⌘）+ 滚轮缩放<br />键盘 + / − 缩放 · 0 重置视图<br />R 顺时针旋转 90°（仅显示）<br />Home / End 首张 / 末张<br />O 系统默认程序打开 · 触摸屏双指捏合缩放',
      // 网格空态与骨架屏：**按媒体档位切换**（全部 / 仅图片 / 仅视频）。
      // 🔴 与底栏 `#mediaFilterSelect` 的三档一一对应，改档位选项必须同改这里。
      // ⚠️ 「全部」档说的是「图片与视频」而不是「文件」：这里在讲**内容**，
      //    不是在讲档位名（档位名「所有文件」另见 `path.allFiles` / `sidebar.allFiles`）。
      // ⚠️ 网页端在 `web/js/app.js#renderPhotoGrid` / `#showSkeleton` 里各有一份镜像，同改。
      'grid.emptyTitleAll': '暂无图片与视频',
      'grid.emptyTitleImage': '暂无图片',
      'grid.emptyTitleVideo': '暂无视频',
      'grid.emptyHintAll': '换个位置看看，或到「设置」里点「添加目录」加入文件夹。',
      'grid.emptyHintImage': '这里没有图片，可切到「全部」或「仅视频」看看。',
      'grid.emptyHintVideo': '这里没有视频，可切到「全部」或「仅图片」看看。',
      'grid.loadingAll': '正在加载图片与视频…',
      'grid.loadingImage': '正在加载图片…',
      'grid.loadingVideo': '正在加载视频…',
      'task.collapseBtn': '收起',
    },
    en: {
      brand: 'Aurora Gallery',
      'doc.title': 'Aurora Gallery',
      'menu.file': 'File',
      'menu.file.addFolder': 'Add folder',
      'menu.file.hideTray': 'Hide to tray',
      'menu.file.quit': 'Quit Aurora Gallery',
      'menu.view': 'View',
      'menu.view.nextTheme': 'Next theme preset',
      'menu.view.compact': 'Compact UI (sidebar & top bar)',
      'menu.view.fullscreen': 'Fullscreen',
      'menu.view.devtools': 'Developer tools',
      'menu.help': 'Help',
      'menu.help.shortcuts': 'Keyboard shortcuts',
      'menu.help.about': 'About Aurora Gallery',
      'titlebar.min': 'Minimize',
      'titlebar.max': 'Maximize',
      'titlebar.closeHint': 'Close (configure in Settings → Close button)',
      'topbar.themeAria': 'Quick theme',
      'topbar.themeTitle': 'Quick theme (same as desktop)',
      'topbar.manage': 'Settings',
      'topbar.localeAria': 'Language',
      'topbar.localeTitle': 'Interface language (synced with Settings → General)',
      'nav.folders': 'Folders',
      'nav.dates': 'Dates',
      'nav.duplicates': 'Dupes',
      'nav.people': 'People',
      'nav.search': 'Search',
      'nav.settings': 'Settings',
      'nav.home': 'Home',
      'nav.tags': 'Tags',
      'nav.primary': 'Main navigation',
      'nav.allPeople': 'All people',
      'nav.faceIndex': 'Recognition and indexing',
      // ===== Tag navigation page =====
      'tagnav.searchPlaceholder': 'Search tags',
      'tagnav.searchAria': 'Search tags',
      'tagnav.searchClear': 'Clear search',
      'tagnav.searchSubmit': 'Search tags (Enter)',
      'tagnav.allTags': 'All tags',
      'tagnav.indexNote': 'Tag index: {tags} tags / {photos} photos',
      'tagnav.indexEmpty':
        'The tag index has not been built yet. Start a semantic index run first.',
      'tagnav.tagCount': '{count}',
      'tagnav.catTotal': '{total} tags in total, {indexed} indexed',
      'tagnav.nodeTags': '{count} tags',
      'tagnav.expand': 'Expand',
      'tagnav.collapse': 'Collapse',
      'tagnav.noResult': 'No matching tags',
      'tagnav.noTagHit': 'No indexed tags under this node yet',
      'tagnav.belowLine': 'All {count} tags are below the current display threshold',
      'tagnav.belowLineHint':
        'All {count} tags are below the current display threshold, so there is nothing to show. Lower the "Tag display threshold" in Settings.',
      'tagnav.pickHint': 'Pick a category or tag on the left',
      'tagnav.photosOf': 'Photos tagged "{name}"',
      'tagnav.loadFail': 'Failed to read tag data, please retry later',
      'tagnav.searching': 'Searching…',
      // Category names (`tagnav.cat.<id>`) — see the zh-CN side for the contract note.
      'tagnav.cat.person': 'People & counts',
      'tagnav.cat.appearance': 'Appearance & hair',
      'tagnav.cat.expression': 'Expression & gaze',
      'tagnav.cat.clothing': 'Clothing & wearables',
      'tagnav.cat.pose': 'Actions & poses',
      'tagnav.cat.scene': 'Scenes & backgrounds',
      'tagnav.cat.object': 'Objects & props',
      'tagnav.cat.work': 'Series & characters',
      'tagnav.cat.creator': 'Artists & sources',
      'tagnav.cat.composition': 'Composition & angle',
      'tagnav.cat.style': 'Style & quality',
      'tagnav.cat.event': 'Themes & anniversaries',
      'tagnav.cat.adult': 'Adult content',
      'tagnav.cat.other': 'Other',
      // Sub-category names (`tagnav.sub.<id>`)
      'tagnav.sub.count': 'People & group shots',
      'tagnav.sub.gender': 'Gender',
      'tagnav.sub.age': 'Age',
      'tagnav.sub.body': 'Build & body',
      'tagnav.sub.identity': 'Roles & occupations',
      'tagnav.sub.skin': 'Skin tone',
      'tagnav.sub.hair': 'Hairstyle & hair color',
      'tagnav.sub.eyes': 'Eyes',
      'tagnav.sub.face': 'Facial features',
      'tagnav.sub.animal_ear': 'Animal ears & tails',
      'tagnav.sub.wing_horn': 'Wings & horns',
      'tagnav.sub.expression': 'Expressions',
      'tagnav.sub.emoticon': 'Emoticons',
      'tagnav.sub.gaze': 'Gaze & direction',
      'tagnav.sub.mouth': 'Mouth',
      'tagnav.sub.clothes_top': 'Tops',
      'tagnav.sub.clothes_bottom': 'Bottoms',
      'tagnav.sub.clothes_full': 'Full outfits',
      'tagnav.sub.uniform': 'Uniforms & workwear',
      'tagnav.sub.legwear': 'Legwear',
      'tagnav.sub.footwear': 'Footwear',
      'tagnav.sub.headwear': 'Headwear',
      'tagnav.sub.handwear': 'Handwear',
      'tagnav.sub.accessory': 'Accessories',
      'tagnav.sub.innerwear': 'Underwear',
      'tagnav.sub.swimwear': 'Swimwear',
      'tagnav.sub.pattern': 'Patterns & cuts',
      'tagnav.sub.posture': 'Posture',
      'tagnav.sub.hand_action': 'Hand & arm actions',
      'tagnav.sub.leg_action': 'Leg actions',
      'tagnav.sub.action': 'Actions & interaction',
      'tagnav.sub.indoor': 'Indoors',
      'tagnav.sub.outdoor': 'Outdoors & nature',
      'tagnav.sub.city': 'City & architecture',
      'tagnav.sub.sky_time': 'Sky & time',
      'tagnav.sub.weather': 'Weather & seasons',
      'tagnav.sub.background': 'Backgrounds & fills',
      'tagnav.sub.element': 'Elements & effects',
      'tagnav.sub.weapon': 'Weapons & gear',
      'tagnav.sub.food': 'Food & drink',
      'tagnav.sub.plant': 'Plants & flowers',
      'tagnav.sub.animal': 'Animals',
      'tagnav.sub.tool': 'Tools & stationery',
      'tagnav.sub.furniture': 'Furniture & home',
      'tagnav.sub.music': 'Instruments & audio',
      'tagnav.sub.vehicle': 'Vehicles',
      'tagnav.sub.toy': 'Dolls & toys',
      'tagnav.sub.media_text': 'Text & in-frame media',
      'tagnav.sub.series': 'Series',
      'tagnav.sub.character': 'Characters',
      'tagnav.sub.cosplay': 'Cosplay',
      'tagnav.sub.trope': 'Tropes & settings',
      'tagnav.sub.source': 'Artists & sources',
      'tagnav.sub.shot': 'Shot type',
      'tagnav.sub.angle': 'Angle & position',
      'tagnav.sub.framing': 'Composition & framing',
      'tagnav.sub.medium': 'Medium & technique',
      'tagnav.sub.render': 'Render style',
      'tagnav.sub.quality': 'Quality & artifacts',
      'tagnav.sub.palette': 'Color & tone',
      'tagnav.sub.day': 'Anniversaries',
      'tagnav.sub.holiday': 'Holidays & events',
      'tagnav.sub.nudity': 'Nudity',
      'tagnav.sub.sexual': 'Sexual acts & hints',
      'tagnav.sub.fetish': 'Fetishes',
      'tagnav.sub.censored': 'Censorship & edits',
      'tagnav.sub.other': 'Other',
      'common.back': 'Back',
      'common.listSep': ', ',
      'common.partSep': ' · ',
      'ai.search': 'Search',
      'ai.searchPlaceholder': 'Describe what you are looking for, e.g. a beach at sunset',
      'ai.searchAria': 'Scene description',
      'ai.modeAria': 'Search mode',
      'ai.modeKeyword': 'Keyword',
      'ai.modeSemantic': 'Semantic',
      'ai.searchPlaceholderKeyword': 'Search file or folder names',
      'ai.searchAriaKeyword': 'File or folder name',
      'ai.history': 'Search history',
      'ai.historyClear': 'Clear',
      'ai.peopleSearchPlaceholder': 'Search people by name',
      'ai.peopleSearchAria': 'Search people',
      'task.faceTitle': 'Face models / indexing',
      'task.semanticTitle': 'AI models / indexing',
      'task.title': 'Background tasks',
      'task.toggleExpand': 'Collapse or expand details',
      'task.collapse': 'Collapse',
      'task.expand': 'Expand',
      'task.scanning': 'Scanning…',
      // Scan-section status / file lines (2026-10-08; contract §6.1). `{pct}` / `{n}` / `{err}`
      // arrive already formatted — do not add format specifiers inside the entry.
      'task.scanPreparing': 'Preparing...',
      'task.scanRunning': 'Scanning... {pct}%',
      'task.scanPaused': 'Paused... {pct}%',
      'task.scanDone': 'Scan complete',
      'task.scanEnumerating': 'Enumerating files... {n} found',
      'task.scanQueuedGate': 'Queued, waiting for earlier background tasks to finish...',
      'task.scanQueuedPending': 'Queued, {n} task(s) ahead',
      'task.scanFailed': 'Scan failed: {err}',
      'task.unknownError': 'Unknown error',
      'task.scanDoneCleaned': 'Scan complete; {n} invalid record(s) marked',
      'task.rescanDoneMarked': 'Rescan complete; {n} invalid record(s) marked',
      'task.rescanDoneFolders': 'Rescan complete; {n} folder(s)',
      'task.rescanDoneFoldersMarked': 'Rescan complete ({n} folder(s)); {m} invalid record(s) marked',
      'task.scanStopped': 'Stopped: {n} folder(s) did not finish',
      'task.autoScanFailed': 'Automatic scan failed: {err}',
      'task.rescanFailed': 'Rescan failed: {err}',
      'task.pause': 'Pause',
      'task.stop': 'Stop',
      'task.resume': 'Resume',
      'task.stopping': 'Stopping...',
      'task.aiStopping': 'Stopping AI task…',
      'task.aiDone': 'Processed {n}',
      // Estimated denominators get a `~`; exact ones do not (same rule as `task.thumbCount`).
      'task.aiCount': 'Processed {done} / {total} ({pct}%)',
      'task.aiCountEst': 'Processed {done} / ~{total} ({pct}%)',
      // Same two fallbacks as the zh bundle; keep both CJK-free (incl. no full-width parens).
      'task.aiCountCounting': 'Processed {done}, estimating how many are pending…',
      'task.aiCountNoTotal': 'Processed {done} (could not estimate the total; percentage unavailable)',
      'task.aiFailed': ' · Failed {n}',
      'task.aiSkipped': ' · Skipped {n}',
      // The second index's own counter row (rationale in the zh bundle). Only the `~` variant
      // exists: the tag denominator is a cross-database estimate (`tagTotalEstimated` is always true).
      'task.aiTagCount': 'Tag index {done} / ~{total} ({pct}%)',
      'task.aiTagCountCounting': 'Tag index: {done} tagged, estimating how many are pending…',
      'task.aiTagCountNoTotal': 'Tag index: {done} tagged (could not estimate the total)',
      'task.aiRate': '{n} photos/min · Completed entries are retained when stopped',
      'task.aiPreparing': 'Preparing · You can continue browsing',
      'task.queueWaiting': 'Scan queue · {n} more waiting',
      'task.queuePending': 'Scan queue · {n}',
      'task.thumbTitle': 'Thumbnails & photo info',
      'task.thumbStop': 'Stop backfill',
      'task.thumbCount': '{done} / ~{total} ({pct}%)',
      'task.thumbCountCounting': 'Processed {done}, estimating how many are pending…',
      'task.thumbCountNoTotal':
        'Processed {done} (could not estimate the pending total, so no percentage or ETA)',
      'task.thumbDetailThumbs': 'Thumbnails {n}',
      'task.thumbDetailPending': 'Missing {n}',
      'task.thumbDetailSized': 'Dimensions +{n}',
      'task.thumbDetailExif': 'Photo info +{n}',
      'task.thumbDetailDhash': 'Visual hash +{n}',
      'task.thumbDetailHash': 'Dup hash +{n}',
      'task.thumbDetailFailed': 'Failed {n}',
      'task.thumbRebuildTitle': 'Rebuilding all thumbnails',
      'task.thumbRebuildStop': 'Stop rebuilding',
      'task.thumbRebuildCount': '{done} / {total} ({pct}%)',
      'task.thumbRebuildEnqueueing': 'Scanned {scanned} rows, enqueued {enrolled}…',
      'task.thumbRebuildTarget': 'Target {spec}',
      'task.thumbRebuildDetailRebuilt': 'Rebuilt this run {n}',
      'task.thumbRebuildDetailPending': 'Remaining {n}',
      'task.etaPrefix': 'About {parts} left',
      'task.etaDays': '{n}d',
      'task.etaHours': '{n}h',
      'task.etaMinutes': '{n}m',
      'task.invalidCleanup': 'Cleaning invalid records',
      'task.invalidCleanupChecked': 'Checked {n}',
      'task.invalidCleanupDeleted': 'Deleted {n}',
      'task.optimizeDb': 'Tidying database',
      'task.dupTitle': 'Finding duplicates',
      'task.dupDetailHashed': 'Hashed {n}',
      'task.dupDetailReused': 'Reused {n}',
      'task.dupHashCurrent': 'Current hash: {hash}',
      'task.dupHashReading': 'Reading current file…',
      'stats.barFullFmt': '{photos} photos | {totalSize} | {videos} videos | {videoSize}',
      'stats.barFolderFmt': '{photos} photos | {videos} videos',
      'stats.barImageFmt': '{photos} photos | {totalSize}',
      'stats.barVideoFmt': '{videos} videos | {videoSize}',
      'stats.barFolderImageFmt': '{photos} photos',
      'stats.barFolderVideoFmt': '{videos} videos',
      'stats.folderNoDirectPhotosFmt': 'No photos in this folder · {n} subfolders (open below)',
      'stats.zeroPhotos': '0 photos',
      'stats.folderCountFmt': '{n} folders',
      // Key name kept for compatibility; the value must stay in sync with
      // `path.allFiles` / `sidebar.allFiles` — this entry covers videos too.
      'toolbar.allPhotos': 'All files',
      'path.duplicates': 'Duplicates (hash)',
      'path.tag': 'Tag: {name}',
      'path.folderOverview': '\u{1F5C2}\uFE0F All folders',
      'path.allFiles': 'All files',
      'path.crumbAria': 'Current path',
      'path.crumbRoot': 'All folders',
      'path.crumbExpand': 'Show full path',
      'path.crumbSwitch': 'Switch to a sibling folder',
      'path.up': 'Go up one level',
      'path.upToFmt': 'Go up to: {name}',
      'path.back': 'Back',
      'path.forward': 'Forward',
      'path.backFmt': 'Back to: {name}',
      'path.forwardFmt': 'Forward to: {name}',
      'path.favorites': '\u2B50 Favorites',
      'path.favoritesSearchFmt': '\u2B50 Favorites · \u{1F50D} {q}',
      'filter.all': 'All',
      'filter.image': 'Photos only',
      'filter.video': 'Videos only',
      'filter.mediaAria': 'Media filter',
      'filter.mediaTitle': 'Filter: all / photos / videos',
      'sort.dateTakenDesc': 'Newest (taken)',
      'sort.dateTakenAsc': 'Oldest (taken)',
      'sort.fileNameAsc': 'Name A–Z',
      'sort.fileNameDesc': 'Name Z–A',
      'sort.fileSizeDesc': 'Largest',
      'sort.fileSizeAsc': 'Smallest',
      // ===== Home (a pure navigation page) =====
      'home.subtitle':
        'Your photos stay on your own computer: originals untouched, nothing uploaded.',
      // Labels of the library-at-a-glance strip (values come from renderHomeStats, not i18n).
      'home.stats.photos': 'Photos',
      'home.stats.videos': 'Videos',
      'home.stats.size': 'Total size',
      'home.stats.folders': 'Folders',
      'home.addFolder': '＋ Add folder',
      'home.addFolderHint': 'Opens Settings, where folders are added and managed',
      'home.whatCanDo': 'What you can do',
      'home.sectionNote': 'Cards explain; tap the buttons inside to go',
      'home.grp.browse.title': 'Find any photo, however many',
      'home.grp.browse.desc': 'Browse by folder or by date — tens of thousands included.',
      'home.grp.search.title': 'Find that photo in one sentence',
      'home.grp.search.desc': 'Say “sunset by the sea” to find it; people group automatically.',
      'home.grp.large.title': 'Smooth, however large',
      'home.grp.large.desc': 'A million photos stay smooth; videos play instantly.',
      'home.grp.personal.title': 'Make it yours, watch anywhere',
      'home.grp.personal.desc': 'Themes and shortcuts your way; scan a code to share.',
      'home.chip.videos': 'Videos only',
      'home.chip.photos': 'Photos only',
      'footer.random': 'Random',
      'footer.randomTitle': 'Jump to a random page',
      'footer.randomAria': 'Random page',
      'footer.gridStyleLabel': 'Grid',
      'footer.gridStyleTitle': 'Grid layout and card ratio (also in Settings → Browse)',
      'footer.gridStyleAria': 'Grid layout and card ratio',
      'footer.pageSizeLabel': 'Per page',
      'footer.pageSizeTitle': 'Photos per page (also in Settings → Browse)',
      'footer.pageSizeAria': 'Photos per page',
      'footer.cardSizeLabel': 'Size',
      'footer.cardSizeTitle': 'Thumbnail size (also in Settings → Browse)',
      'footer.cardSizeAria': 'Thumbnail size',
      'sidebar.resizerAria': 'Resize sidebar (double-click to reset, arrow keys to nudge)',
      'sidebar.allFiles': 'All files',
      'sidebar.favorites': 'Favorites',
      'sidebar.allFolders': 'All folders',
      'sidebar.emptyNoFolders': 'No folders yet.<br>Open Settings to add one.',
      'sidebar.loading': 'Loading…',
      'sidebar.loadingFolders': 'Loading folders…',
      'sidebar.loadFoldersFail': 'Failed to load folders',
      'sidebar.duplicates': 'Duplicate photos',
      'sidebar.loadingDuplicates': 'Loading duplicates…',
      'sidebar.loadingCovers': 'Loading folder covers…',
      'sidebar.loadCoversFail': 'Could not load folder covers',
      'sidebar.loadPhotosFail': 'Could not load photos',
      'sidebar.retryOrSwitchView': 'Try again later, or switch views in the sidebar',
      'sidebar.retryLater': 'Try again later.',
      'sidebar.allDates': 'All dates',
      'sidebar.dateSortToolbarAria': 'Sort by date',
      'sidebar.dateSortDescTitle': 'Newest first',
      'sidebar.dateSortAscTitle': 'Oldest first',
      'sidebar.dateSortDesc': 'New → old',
      'sidebar.dateSortAsc': 'Old → new',
      'sidebar.datesEmpty': 'No data',
      'sidebar.loadingDates': 'Loading date groups…',
      'sidebar.loadDatesFail': 'Failed to load date list',
      'sidebar.yearSuffix': '',
      'sidebar.rescanRootTitle': 'Rescan if subfolders were moved or renamed',
      'sidebar.rescanRootAria': 'Rescan this library root',
      'mobile.menuAria': 'Open menu',
      'settings.back': 'Back to gallery',
      'settings.foldersDesc':
        'Add or remove roots. If you moved or renamed subfolders in Explorer, or added a lot of files, use Rescan on that root to bring the index back in sync. Nothing on disk is ever deleted.',
      'settings.addRoot': 'Add folder',
      'settings.folderPlaceholder': 'Reading folder list…',
      'settings.closeSection': 'Close button',
      'settings.closeLabel': 'When you click ✕ or press Alt+F4',
      'settings.closeDesc':
        '“Ask every time” opens a small dialog where you can tick “always do this” to remember the choice. Hide to tray and Quit in the File menu are not affected.',
      'settings.close.ask': 'Ask me every time',
      'settings.close.tray': 'Hide to tray (keep running)',
      'settings.close.quit': 'Quit the app',
      'settings.general': 'General',
      'settings.uiLanguage': 'Language',
      'settings.uiLanguageDesc': 'Interface text changes immediately.',
      'settings.lang.zh': '简体中文',
      'settings.lang.en': 'English',
      'settings.autoScan': 'Scan on startup',
      'settings.autoScanDesc':
        'Rescan your library folders after launch and index new or changed photos.',
      'settings.autoThumb': 'Backfill thumbnails, dHash & camera info on startup',
      'settings.autoThumbDesc':
        'Generate thumbnails, visual fingerprints and camera info (make, aperture, shutter, ISO, GPS) for photos that are missing them. Runs in the background when idle.',
      'settings.autoDup': 'Find duplicates on startup',
      'settings.autoDupDesc':
        'Compare photos in the background. If “Scan on startup” is also on, this waits until scanning finishes.',
      'settings.autoSemantic': 'Build search index on startup',
      'settings.autoSemanticDesc':
        'Index photos not yet processed for content-based search. The first run takes a long time; keep the app open while it works.',
      'settings.autoFace': 'Build face index on startup',
      'settings.autoFaceDesc':
        'Detect and group faces so the People page has content. The first run takes a long time; keep the app open while it works.',
      'settings.launchPage': 'Open to',
      'settings.launchPageDesc': 'Where the app lands when you open it',
      'settings.launch.welcome': 'Welcome',
      'settings.launch.allFiles': 'All files',
      'settings.launch.allFolders': 'All folders',
      'settings.launch.last': 'Last position',
      'settings.themeStyle': 'Theme',
      'settings.themeStyleDesc':
        'A ready-made colour palette. Picking one also updates accent and background below; change any of them on their own and this switches to “Custom”. Texture and panel opacity are independent — presets never touch them. View → Next theme also cycles presets.',
      'settings.subtitleStyle': 'Subtitle font',
      'settings.thumbConc': 'Thumbnail backfill concurrency',
      'settings.thumbConcDesc': 'Parallel jobs (1–8). Higher uses more RAM and disk I/O.',
      'dialog.title': 'Notice',
      'dialog.cancel': 'Cancel',
      'dialog.ok': 'OK',
      'dialog.confirmTitle': 'Confirm',
      'dialog.gotIt': 'Got it',
      'closeOverlay.title': 'Close Aurora Gallery',
      'closeOverlay.desc':
        'Choose an action. You can save it as default below, or change it anytime in Settings → Close button.',
      'closeOverlay.tray': 'Run in background',
      'closeOverlay.quit': 'Quit',
      'closeOverlay.cancel': 'Cancel',
      'closeOverlay.remember': 'Remember this as the default close action',
      'closeOverlay.hint': 'Tray shortcuts in the File menu are not affected by this choice.',
      'closeOverlay.tasksRunning':
        '{n} background task(s) running ({list}). Quit will stop them first and wait until they finish.',
      'closeOverlay.stopTimeout':
        'Background tasks did not stop in time; quit was cancelled. Stop them from the task panel and try again.',
      'task.scanNoun': 'Folder scan',
      'theme.switchFailFmt': 'Failed to switch appearance: {err}',
      'theme.groupPresets': 'Presets',
      'theme.groupAccent': 'Accent color',
      'theme.groupBg': 'Background tone',
      'theme.groupTexture': 'Surface texture',
      'theme.groupOpacity': 'Panel opacity',
      'theme.midnight_classic': 'Midnight Classic',
      'theme.ice_deep': 'Deep Ice',
      'theme.amber_dawn': 'Amber Dawn',
      'theme.forest_shadow': 'Forest Shadow',
      'theme.sky_light': 'Sky Light',
      'theme.cherry_blossom': 'Cherry Blossom',
      'theme.lavender_dusk': 'Lavender Dusk',
      'theme.arctic_mint': 'Arctic Mint',
      'theme.desert_sand': 'Desert Sand',
      'theme.paper_gray': 'Paper Gray',
      'theme.ember_night': 'Ember Night',
      'theme.graphite_night': 'Graphite Night',
      'theme.nebula_violet': 'Nebula Violet',
      'theme.pine_abyss': 'Pine Abyss',
      'theme.mocha_night': 'Mocha Night',
      'theme.sage_morning': 'Sage Morning',
      'theme.apricot_haze': 'Apricot Haze',
      'theme.frost_cyan': 'Frost Cyan',
      'theme.glass_night': 'Glass Night',
      'theme.aurora_night': 'Gradient Night',
      'theme.glass_day': 'Glass Day',
      'theme.aurora_dawn': 'Gradient Dawn',
      'theme.custom': 'Custom',
      'settings.accent': 'Accent colour',
      'settings.accentAria': 'Accent colour',
      'settings.accentDesc': 'Colour of buttons, selection and focus rings. Combine freely with the style above.',
      'settings.background': 'Background tone',
      'settings.backgroundAria': 'Background tone',
      'settings.textureAria': 'Surface texture',
      'settings.opacityAria': 'Panel opacity',
      'settings.windowBackdrop': 'Window backdrop',
      'settings.windowBackdropAria': 'Window backdrop',
      'settings.windowBackdropRestartHint':
        'Window backdrop changed — restart the app to apply',
      'settings.windowBackdropDesc':
        'Shows the desktop through the whole window, not just a faded panel. The three Acrylic levels step up in transparency. Requires an app restart. Blur needs Windows 11 22H2 or newer; earlier systems only see through. This controls the window itself — how much the panels fade is up to Panel opacity above.',
      'settings.backgroundDesc': 'Page and card tones. Combine freely with the style above.',
      'accent.violet': 'Violet',
      'accent.cyan': 'Cyan',
      'accent.teal': 'Teal',
      'accent.rose': 'Rose',
      'accent.amber': 'Amber',
      'accent.mono': 'Mono',
      'accent.coral': 'Coral',
      'accent.indigo': 'Indigo',
      'accent.green': 'Green',
      'accent.red': 'Red',
      'bg.default': 'Default',
      'bg.ink': 'Ink',
      'bg.warm': 'Warm',
      'bg.cool': 'Cool',
      'bg.amoled': 'AMOLED',
      'bg.glass': 'Glass',
      'bg.aurora': 'Gradient',
      'bg.paper': 'Paper',
      'bg.mist': 'Mist',
      'bg.forest': 'Forest',
      'bg.clay': 'Clay',
      'texture.none': 'None',
      'texture.grain': 'Grain',
      'texture.paper': 'Paper fiber',
      'texture.linen': 'Linen',
      'texture.frost': 'Frosted',
      'texture.grid': 'Grid',
      'texture.dots': 'Dots',
      'texture.stripe': 'Stripes',
      'texture.wood': 'Wood',
      'opacity.opaque': 'Opaque',
      'opacity.slight': 'Slight',
      'opacity.medium': 'Medium',
      'opacity.clear': 'Clear',
      'windowBackdrop.solid': 'Solid',
      'windowBackdrop.acrylic-light': 'Acrylic (light)',
      'windowBackdrop.acrylic': 'Acrylic (medium)',
      'windowBackdrop.acrylic-strong': 'Acrylic (strong)',
      'settings.nav.folders': 'Library',
      'settings.nav.browse': 'Browsing & display',
      'settings.nav.shortcuts': 'Shortcuts',
      'settings.nav.storage': 'Media & storage',
      'settings.nav.tasks': 'Background tasks',
      'settings.nav.ai': 'AI & indexing',
      'settings.nav.appearance': 'Appearance & behaviour',
      'settings.nav.network': 'Network & remote',
      'web.passwordSet': 'Saved',
      'web.passwordUnset': 'Set password',
      'web.statusTextOn': 'Status: set',
      'web.statusTextOff': 'Status: not set',
      'web.badgeOn': 'Set',
      'web.badgeOff': 'Off',
      'help.aboutTitle': 'About',
      'help.aboutBody':
        'Aurora Gallery %VERSION%\n\nA lightweight, local-first photo gallery app.\nBrowse and search large libraries on your machine.\n\nAuthor: 拂晓AI\nhttps://foredawn.vip/',
      'help.shortcutsTitle': 'Shortcuts',
      'help.shortcutsBody':
        'Main window\n\n' +
        'Ctrl + Q — Hide to tray / show again (global; uses Control so Cmd+Q is free on macOS)\n' +
        'Title bar ✕ / Alt+F4 — Behavior from Settings → Close button: ask, tray, or quit.\n' +
        'You can save the choice in the dialog. File menu tray/quit shortcuts are separate.\n' +
        'Ctrl + B — Compact UI: toggle sidebar, top bar, task strip\n\n' +
        'Preview\n\n' +
        'Esc — Close preview\n' +
        '← / → — Previous / next\n' +
        'Space — Play / pause slideshow\n' +
        'Delete — Move to Recycle Bin\n' +
        'F — Favorite / unfavorite\n' +
        '0 — Reset zoom & rotation\n' +
        '+ / − — Zoom in / out\n' +
        'R — Rotate 90° clockwise (display only)\n' +
        'Home / End — First / last in list\n' +
        'O — Open with default app\n' +
        'Ctrl + wheel — Zoom image\n\n' +
        'Use View → Next theme preset to change the look.',
      'settings.closeWindowAria': 'Default action when closing the main window',
      'settings.launchPageAria': 'Start page',
      'settings.themeStyleAria': 'Theme',
      'settings.section.peopleAria': 'Face recognition settings',
      'settings.section.semanticAria': 'Local AI and multilingual search settings',
      'settings.section.browse': 'Browsing & display',
      'settings.section.storage': 'Media & storage',
      'settings.section.tasks': 'Background tasks',
      'settings.section.network': 'Network & remote',
      'settings.section.folders': 'Library',
      'settings.section.foldersDesc':
        'Add or remove the folders the gallery scans. After you move or rename folders, or add and remove a lot of photos, use Rescan so the gallery catches up with the disk. Nothing on disk is ever deleted.',
      'settings.section.browseDesc':
        'How photos are ordered, sized and laid out in the gallery. Changes apply immediately.',
      'settings.section.shortcuts': 'Shortcuts',
      'settings.section.shortcutsDesc':
        'Click a key field on the right, then press the combination you want. Applies immediately, no restart needed.',
      'settings.section.storageDesc':
        'Control thumbnail sharpness and size, and how much temporary space video playback uses.',
      'settings.section.tasksDesc':
        'These run in the background and you can close the window any time. Only one runs at a time.',
      'settings.section.ai': 'AI & indexing',
      'settings.section.aiDesc':
        'Search and face recognition run entirely on this machine — photos are never uploaded. Models, indexes and recognition thresholds live here.',
      'settings.section.appearance': 'Appearance & behaviour',
      'settings.section.appearanceDesc':
        'Pick a full colour palette, or fine-tune accent, background, texture and translucency. Changes apply and save immediately.',
      'settings.section.networkDesc':
        'Let phones, tablets and other computers on the same network open this gallery.',
      'settings.appearanceTitle': 'Appearance',
      'settings.languageStartupTitle': 'Language & startup',
      'settings.behaviorTitle': 'Window behaviour',
      'settings.browse.groupVideo': 'Video',
      'shortcut.resetAll': 'Reset all',
      'shortcut.resetOne': 'Reset',
      'shortcut.pressKeys': 'Press a key…',
      'shortcut.unbound': 'Not set',
      'shortcut.conflictOne': 'Also used by “{names}”',
      'shortcut.conflictSummary':
        '{count} conflict(s): the same key is assigned to more than one action and only one will fire. Please pick a different combination.',
      'shortcut.saveFailed': 'Could not save shortcuts: {error}',
      'shortcut.keyAria': 'Shortcut for {name}',
      'shortcut.group.global': 'Global',
      'shortcut.group.navigation': 'Navigation',
      'shortcut.group.preview': 'Preview',
      'shortcut.action.addFolder': 'Add folder',
      'shortcut.action.hideToTray': 'Hide to tray / restore',
      'shortcut.action.compactChrome': 'Toggle compact interface',
      'shortcut.action.fullscreen': 'Full screen',
      'shortcut.action.devtools': 'Developer tools',
      'shortcut.action.navHome': 'Back to Home',
      'shortcut.action.navBack': 'Back',
      'shortcut.action.navForward': 'Forward',
      'shortcut.action.randomPage': 'Jump to random page',
      'org.flag.pick': 'Pick',
      'org.flag.pickTitle': 'Flag as picked',
      'org.flag.reject': 'Reject',
      'org.flag.rejectTitle': 'Flag as rejected',
      'org.flag.clear': 'Clear',
      'org.flag.clearTitle': 'Clear flag',
      'org.ratingLabel': 'Rating',
      'org.panel': 'Organize',
      'org.panelTitle': 'Organize: favorite, flag, rating, tags',
      'org.panelHeader': 'Organize',
      'org.sectionFlag': 'Flag',
      'org.sectionCompare': 'Compare',
      'org.tagsPanelTitle': 'Tags',
      'org.tagsPlaceholder': 'Type a tag and press Enter',
      'org.tagsAdd': 'Add',
      'org.tagsHint': 'Enter to add; click × on a tag to remove. Changes save immediately.',
      'org.tagsEmpty': 'No tags yet. Type one and press Enter.',
      'org.tagRemove': 'Remove tag',
      'org.writeFailed': 'Operation failed',
      'org.filterRatingAria': 'Filter by rating',
      'org.filterAnyRating': 'Any rating',
      'org.filterRating5': '5 stars',
      'org.filterRating4': '4 stars',
      'org.filterRating3': '3 stars',
      'org.filterRating2': '2 stars',
      'org.filterRating1': '1 star',
      'org.filterRatingNone': 'Unrated',
      'org.filterFlagAria': 'Filter by flag',
      'org.filterAnyFlag': 'Any flag',
      'org.filterFlagNone': 'Unflagged',
      'org.filterTagsAria': 'Filter by tags',
      'org.filterTags': 'Tags',
      'org.filterTagsHint': 'Selecting several tags requires all of them',
      'org.filterClear': 'Clear filters',
      'org.filterTagsEmpty': 'No tags yet',
      'shortcut.action.previewClose': 'Close preview',
      'shortcut.action.previewPrev': 'Previous photo',
      'shortcut.action.previewNext': 'Next photo',
      'shortcut.action.previewFirst': 'First photo',
      'shortcut.action.previewLast': 'Last photo',
      'shortcut.action.previewSlideshow': 'Play / pause slideshow',
      'shortcut.action.previewFavorite': 'Toggle favourite',
      'shortcut.action.previewTrash': 'Move to trash',
      'shortcut.action.previewRotate': 'Rotate 90° clockwise (preview only)',
      'shortcut.action.previewEditSave': 'Save preview edits (write back to file)',
      'shortcut.action.previewZoomIn': 'Zoom in',
      'shortcut.action.previewZoomOut': 'Zoom out',
      'shortcut.action.previewZoomReset': 'Reset zoom & rotation',
      'shortcut.action.previewFindSimilar': 'Find similar photos',
      'shortcut.action.previewOpenExternal': 'Open with default app',
      'shortcut.action.previewFlagPick': 'Flag as picked',
      'shortcut.action.previewFlagReject': 'Flag as rejected',
      'shortcut.action.previewFlagClear': 'Clear flag',
      'shortcut.action.previewRating1': 'Rate 1 star (press again to clear)',
      'shortcut.action.previewRating2': 'Rate 2 stars (press again to clear)',
      'shortcut.action.previewRating3': 'Rate 3 stars (press again to clear)',
      'shortcut.action.previewRating4': 'Rate 4 stars (press again to clear)',
      'shortcut.action.previewRating5': 'Rate 5 stars (press again to clear)',
      'settings.browse.defaultMode': 'Default browsing',
      'settings.browse.defaultModeDesc':
        'Changes save automatically and refresh the gallery (when Settings is open).',
      'settings.browse.groupSort': 'Sort & folder scope',
      'settings.browse.defaultSort': 'Default sort',
      'settings.browse.sort.dateModifiedDesc': 'Newest modified',
      'settings.browse.sort.dateModifiedAsc': 'Oldest modified',
      'settings.browse.sort.largestFile': 'Largest file',
      'settings.browse.sort.smallestFile': 'Smallest file',
      'settings.browse.sort.pathAsc': 'Path A–Z',
      'settings.browse.sort.pathDesc': 'Path Z–A',
      'settings.browse.folderScope': 'Folder scope',
      'settings.browse.includeSubfolders': 'Include subfolders',
      'settings.browse.currentFolderOnly': 'This folder only',
      'settings.browse.folderScopeHintHtml':
        '<strong>Include subfolders</strong>: when a folder is selected in the sidebar, list photos and videos in that folder and <strong>all nested folders</strong>. <strong>This folder only</strong>: only direct children; open subfolders separately.',
      'settings.browse.groupPageGrid': 'Paging & grid',
      'settings.browse.pageSize': 'Page size',
      'settings.browse.pageSizeAria': 'Page size',
      'settings.browse.gridStyle': 'Grid & aspect',
      'settings.browse.gridStyleAria': 'Grid layout & card aspect',
      'settings.browse.grid.masonry': 'Masonry (original ratio)',
      'settings.browse.grid.uniform': 'Uniform height',
      'settings.browse.grid.opt.masonry': 'Masonry (original ratio)',
      'settings.browse.grid.opt.u11': 'Uniform · 1:1',
      'settings.browse.grid.opt.u34': 'Uniform · 3:4',
      'settings.browse.grid.opt.u43': 'Uniform · 4:3',
      'settings.browse.grid.opt.u916': 'Uniform · 9:16',
      'settings.browse.grid.opt.u169': 'Uniform · 16:9',
      'settings.browse.cardTier': 'Card size',
      'settings.browse.cardTierAria': 'Thumbnail card size',
      'settings.browse.thumbCrop': 'Thumbnail crop',
      'settings.browse.thumbCropAria': 'Thumbnail crop',
      'settings.browse.thumbCropOff': 'Off',
      'settings.browse.thumbCropOn': 'On',
      'settings.videoClickBehavior': 'Video click',
      'settings.videoClickBehaviorDesc': 'Default action when clicking a video from the grid',
      'settings.videoClickBehavior.system': 'System player',
      'settings.videoClickBehavior.embedded': 'Embedded preview',
      'settings.infoPanel.group': 'Photo info panel',
      'settings.infoPanel.hintHtml':
        'Choose which fields the preview "Photo info" panel shows.<br />Changes save and apply immediately; unchecking <strong>everything</strong> leaves the panel with a "No info available" note.',
      'settings.infoPanel.selectAll': 'Select all',
      'settings.infoPanel.clearAll': 'Clear all',
      'settings.infoPanel.reset': 'Reset to defaults',
      'settings.similarThreshold': 'Similar photos',
      'settings.similarThresholdAria': 'Visual similarity Hamming distance threshold',
      'settings.similarThresholdDesc':
        'How strict the match is. Used by “Find similar” in preview and “Visual similar” in duplicates.',
      'settings.subtitleStyleSection': 'Subtitle font',
      'settings.subtitleStyleDesc':
        'Font, size, weight and colour for subtitles in video preview. Applies and saves immediately.',
      'settings.subtitle.font': 'Font',
      'settings.subtitle.font.system': 'System sans',
      'settings.subtitle.font.serif': 'Serif',
      'settings.subtitle.font.mono': 'Monospace',
      'settings.subtitle.size': 'Size',
      'settings.subtitle.weight': 'Weight',
      'settings.subtitle.weight.normal': 'Regular',
      'settings.subtitle.weight.medium': 'Medium',
      'settings.subtitle.weight.bold': 'Bold',
      'settings.subtitle.color': 'Color',
      'settings.subtitle.color.white': 'White (default)',
      'settings.subtitle.color.yellow': 'Yellow',
      'settings.subtitle.color.cyan': 'Cyan',
      'settings.subtitle.color.green': 'Green',
      'settings.subtitle.color.orange': 'Orange',
      'settings.subtitle.color.pink': 'Pink',
      'settings.subtitle.sizeAria': 'Subtitle size',
      'settings.thumbSizeQuality': 'Thumbnail size & quality',
      'settings.thumbSizeQualityDesc':
        'Bigger is sharper and uses more disk; the encoding is always WebP. Changes only affect newly generated thumbnails — use “Rebuild all thumbnails” below to convert what is already in the library.',
      'settings.thumbCurrentLineFmt': 'Current: max edge {size} px · quality {quality}',
      'settings.thumbCurrentLoading': 'Current: loading…',
      'settings.thumbPendingHint': 'Pending changes — click Apply to save',
      'settings.thumbMaxEdge': 'Max edge',
      'settings.thumbJpegQ': 'Quality',
      'settings.thumb.edge128': '128 px (smaller)',
      'settings.thumb.edge256': '256 px',
      'settings.thumb.edge320': '320 px (sharper)',
      'settings.thumb.edge512': '512 px (default, sharper)',
      'settings.thumb.q55': '55 (smaller files)',
      'settings.thumb.q75': '75 (default)',
      'settings.thumb.q95': '95 (higher quality)',
      // Full rebuild (re-run every stored thumbnail at the current spec)
      'settings.thumbRebuildStart': 'Rebuild all thumbnails',
      'settings.thumbRebuildStop': 'Stop rebuilding',
      'settings.thumbRebuildEnqueueing':
        'Rebuilding: collecting the work list (target {spec}), scanned {scanned} rows, queued {enqueued}…',
      'settings.thumbRebuildRunning':
        'Rebuilding (target {spec}): {done} / {total} ({pct}%), {failed} failed{eta}',
      'settings.thumbRebuildStale':
        'Target spec: {spec} · the work list must be rebuilt for the new spec (click the button below; the whole library is scanned first)',
      'settings.thumbRebuildIdleEmpty':
        'Target spec: {spec} · never rebuilt yet — click the button below to re-run stored thumbnails',
      'settings.thumbRebuildIdlePending':
        'Target spec: {spec} · {pending} of {total} left to rebuild{failedPart}',
      'settings.thumbRebuildIdleDone':
        'Target spec: {spec} · all {total} rebuilt{failedPart}',
      'settings.thumbRebuildFailedPart': ', {failed} failed (kept the old thumbnail)',
      'settings.thumbRebuildReadError': 'Failed to read rebuild status',
      'settings.thumbRebuildStartFail': 'Could not start the rebuild: {error}',
      'settings.thumbRebuildConfirmStart':
        'The whole library will be scanned and every thumbnail regenerated at the current spec. This can take hours and keeps the disk busy; you can stop at any time and resume later.',
      'settings.thumbRebuildConfirmReset':
        'The target spec changed. The work list will be rebuilt from scratch (full library scan) and then every thumbnail regenerated. This can take hours and keeps the disk busy; you can stop at any time and resume later.',
      'settings.thumbRebuildConfirmResume':
        '{pending} thumbnails are still pending; the run resumes from where it stopped. You can stop at any time and resume later.',
      'settings.apply': 'Apply',
      'settings.hlsCache': 'Video cache limit',
      'settings.hlsCacheDesc':
        'Playing a video creates temporary segments; the oldest are cleaned up once the limit is reached. Disk 0 means no size cap — only the folder count is enforced.',
      'settings.hls.diskCap': 'Disk cap',
      'settings.hls.dirCap': 'Folder cap',
      'settings.hls.hint': 'Suggested: 1 GB / 48 folders. Applies from the next playback.',
      'settings.hlsCacheSavedFmt': 'Saved: {gb} GB / {en} folders (applies to new sessions)',
      'settings.hlsCacheSaveFailFmt': 'Failed to save HLS cache settings: {err}',
      'settings.thumbApplyFailFmt': 'Failed to apply thumbnail settings: {err}',
      'settings.cardSizeFailFmt': 'Failed to change thumbnail size: {err}',
      'settings.pageSizeFailFmt': 'Failed to change photos per page: {err}',
      'settings.gridStyleFailFmt': 'Failed to change grid & ratio: {err}',
      'settings.openFolderFailFmt': 'Could not open the folder: {err}',
      'settings.storage.dataDir': 'Library data location',
      'settings.storage.dataDirDesc':
        'Photo details, thumbnails, AI indexes and caches all live in this folder, and it grows over time. To free up space, use “Move to…” below to move the whole thing to another drive.',
      'settings.storage.dataDirMigrate': 'Move to…',
      'settings.storage.dataDirOpen': 'Open folder',
      'settings.storage.dataDirOpenTitle': 'Open this location in your file manager',
      'settings.storage.dataDirReading': 'Reading…',
      'settings.storage.dataDirCurrentFmt': '{path}　·　{size} used',
      'settings.storage.dataDirCustomHint': '(default location is {path})',
      'settings.storage.dataDirFreeFmt': '{free} left on that drive',
      'settings.storage.dataDirFallbackFmt':
        '⚠️ Your chosen location cannot be opened, so this session uses the default location ({reason})',
      'settings.storage.dataDirFallbackTitle': 'Library data location cannot be opened',
      'settings.storage.dataDirFallbackDialogFmt':
        'The library data location you chose could not be opened, so this session uses the default location instead.\n\n' +
        'That is why the library may look empty — no photos were lost.\n\n' +
        'If it is a removable or network drive, reconnect it and restart the app to get everything back. If you no longer use that location, you can point it somewhere new under Settings → Media & storage.\n\n' +
        '(Could not open: {reason})',
      'settings.storage.dataDirPickTitle': 'Choose a new location for library data',
      'settings.storage.dataDirConfirmTitle': 'Move library data',
      'settings.storage.dataDirConfirmFmt':
        'Library data ({size} in total) will be moved from\n{from}\nto\n{to}\n\n' +
        'The target drive has {free} left. Please do not use the library while it moves; the app restarts when it is done.\n\n' +
        'Nothing at the old location is touched until the copy is complete and verified, so a failure part-way loses nothing.',
      'settings.storage.dataDirConfirmNoFreeFmt':
        'Library data ({size} in total) will be moved from\n{from}\nto\n{to}\n\n' +
        'Please do not use the library while it moves; the app restarts when it is done.\n\n' +
        'Nothing at the old location is touched until the copy is complete and verified, so a failure part-way loses nothing.',
      'settings.storage.dataDirConfirmSubdirFmt':
        'A folder named {name} will be created inside {picked}, and the data goes in there.\n\n',
      'settings.storage.dataDirMigratingFmt': 'Moving… {percent}% ({current})',
      'settings.storage.dataDirPhasePrepare': 'Preparing…',
      'settings.storage.dataDirPhaseRelease': 'Pausing library access…',
      'settings.storage.dataDirPhaseCopy': 'Copying data…',
      'settings.storage.dataDirPhaseVerify':
        'Checking the new location…\nThis reads the whole copy — a large library can take several minutes. Please keep the window open.',
      'settings.storage.dataDirPhaseVerifyFmt':
        'Checking the new location… ({elapsed})\nThis reads the whole copy — a large library can take several minutes. Please keep the window open.',
      'settings.storage.dataDirVerifySecFmt': '{seconds}s elapsed',
      'settings.storage.dataDirVerifyMinFmt': '{minutes}m {seconds}s elapsed',
      'settings.storage.dataDirPhaseCleanup': 'Cleaning up the old location…',
      'settings.storage.dataDirDoneFmt':
        'Move complete — restarting the app… ({size} moved, {count} photos at the new location)',
      'settings.storage.dataDirTrashedFmt':
        'The old {names} went to the recycle bin — you can restore it from there if needed.',
      'settings.storage.dataDirPurgedFmt':
        'The old {names} was deleted outright because it was too large for the recycle bin. The new location is complete, but these files cannot be recovered.',
      'settings.storage.dataDirCleanupFailedFmt':
        'The new location is ready to use, but the old {names} could not be deleted. It is only wasting space — you can delete it yourself.',
      'settings.storage.dataDirDoneKeepFmt':
        'Move complete — restarting the app… (files at the old location were kept; delete them once you are happy)',
      'settings.storage.dataDirFailFmt':
        'The move did not finish.\n\n{error}\n\nNothing changed — the library data is still in its original location.',
      'settings.storage.dataDirFailRestart':
        'The move did not finish.\n\n{error}\n\nThe app will restart now and keep using the original location — nothing changed.',
      'settings.storage.dataDirReadFailFmt': 'Could not read the location information: {error}',
      'settings.storage.dataDirPickFailFmt': 'Could not open the folder picker: {error}',
      'settings.storage.dataDirSpaceFmt':
        'Not enough space on the target drive: {need} needed, only {free} available — {shortage} short.\n\nPick a location with more room, or free up some files first.',
      'settings.storage.dataDirErrEmpty': 'Choose a folder to move the data into first',
      'settings.storage.dataDirErrSame': 'That is the current location — pick a different folder',
      'settings.storage.dataDirErrInside':
        'A subfolder of the current location cannot be used (it would copy the data into itself) — pick somewhere else',
      'settings.storage.dataDirErrOccupied':
        'There is already a library in that location. To use it, pick it directly from the level above; to move your data here, choose another location.',
      'settings.storage.dataDirBusy': 'Library data is already being moved — please wait',
      'settings.storage.dataDirBusyWaitFmt':
        '{reason}\n(The move has to wait for it to finish — retrying automatically… {seconds}s elapsed)',
      'settings.storage.dataDirBusyGiveUpFmt':
        'The move could not start: {error}\n\nThe move has to wait for those background tasks to finish. Once they are done, click “Move to…” again — nothing has changed.',
      'settings.storage.dataDirPausedFmt':
        '“{names}” was paused for this move; it will pick up again the next time you start the app.',
      'settings.storage.dataDirPausedManualFmt':
        '“{names}” was paused for this move — click it again whenever you want it to continue.',
      'settings.storage.dataDirPausedBothFmt':
        '“{names}” was paused for this move. The automatic pass will pick up the next time you start the app; the one you started manually needs another click.',
      'settings.storage.dataDirPausedOtherFmt':
        '“{names}” was paused for this move — you can restart it whenever you like.',
      'settings.task.thumbBackfill': 'Thumbnail backfill',
      'settings.task.thumbBackfillDesc':
        'Generate thumbnails for photos that lack one, and add visual fingerprints used by “Visual similar”',
      'settings.task.thumbStart': 'Start',
      'settings.task.thumbExportFailTitle':
        'Export failed paths from the current or last run as .txt (one path per line)',
      'settings.task.thumbExportFailedPaths': 'Export failed paths',
      'settings.task.thumbConcurrency': 'Parallel jobs',
      'settings.task.thumbConcurrencyAria': 'Thumbnail backfill concurrency',
      'settings.task.thumbConcurrencyHint':
        'Higher is faster, but it levels off between 4 and 8 and only uses more RAM beyond that (slower on slow disks)',
      'settings.task.dupHash': 'Duplicate detection',
      'settings.task.dupHashDesc':
        'Compare photo contents to find exact duplicates. Only photos not compared yet and still on disk are processed.',
      'settings.task.dupStart': 'Start',
      'settings.task.dupStop': 'Stop',
      'settings.task.maintenance': 'Library maintenance',
      'settings.task.maintenanceDesc':
        'Clean up stale records, rebuild thumbnail records, tidy the database, or take a backup first',
      'settings.task.cleanupInvalid': 'Clean up stale records',
      'settings.task.rebuildThumbFlags': 'Rebuild thumbnail records',
      'settings.task.optimizeDb': 'Tidy database',
      'settings.task.openDbFolder': 'Open containing folder',
      'settings.task.backupDb': 'Back up database',
      'settings.task.aiSearch': 'Search index',
      'settings.task.aiPeople': 'People index',
      'settings.autoRunSection': 'Automatic tasks',
      'settings.autoRunHint':
        'What runs automatically after launch. Only one of them runs at a time.',
      'settings.network.title': 'LAN access',
      'settings.network.urlLabel': 'URL',
      'settings.network.statusOn': 'Running',
      'settings.network.urlDesc':
        'Open this address on any device on the same network to browse the gallery',
      'settings.network.starting': 'Starting…',
      'settings.network.copy': 'Copy',
      'settings.network.qrHint': 'Scan with your phone',
      'settings.network.qrAria': 'QR code that opens the gallery on your phone',
      'settings.network.passwordLabel': 'Password',
      'settings.network.passwordUnsetBadge': 'Not set',
      'settings.network.passwordDesc':
        'When set, browsers must enter this password first. Leave it empty for no password.',
      'settings.network.passwordPlaceholder': 'Access password',
      'settings.network.tunnel': 'Cloudflare Tunnel',
      'settings.network.tunnelOff': 'Off',
      'settings.network.tunnelDesc':
        'Creates a temporary public address so you can reach the gallery from anywhere. An access password is required first so strangers cannot open your gallery. This switch lasts for the current run only.',
      'settings.network.tunnelBinaryChecking': 'cloudflared: checking…',
      'settings.network.tunnelLogHint': 'Startup log (shown on failure; copy for support)',
      'settings.network.tunnelCopyLog': 'Copy log',
      'settings.network.tunnelUrlPending': 'Not available',
      'settings.common.unknownError': 'Unknown error',
      'settings.save.browsePrefsFail': 'Failed to save browsing preferences: {error}',
      'settings.save.generalFail': 'Failed to save general settings: {error}',
      'settings.save.localeFail': 'Failed to save language: {error}',
      'settings.save.windowCloseFail': 'Failed to save close-button behavior: {error}',
      'settings.save.infoFieldsFail': 'Failed to save photo info fields: {error}',
      'settings.folderTableAria': 'Library root folders',
      'settings.folderColPath': 'Path',
      'settings.folderColActions': 'Actions',
      'settings.folderEmptyTitle': 'No library folders yet',
      'settings.folderEmptyDesc': 'Click “Add folder” above to start managing photos',
      'settings.folderRescan': 'Rescan',
      'settings.folderRescanTitle':
        'Rescan after moving/renaming subfolders or adding/removing many photos.',
      'settings.folderRescanConfirm':
        'This root folder will be traversed again; only changed files are updated.\n' +
        'Unchanged rows are kept; rows not seen this time are marked stale and hidden from the UI (they are not deleted right away).\n\n' +
        'Use this after moving or renaming subfolders in the file manager, or when many photos were added or removed and the index no longer matches.\n\n' +
        'Note: stale rows keep their thumbnails and fingerprints; they are only physically deleted by “Clean up stale records”.\n\n' +
        'Continue?',
      'settings.folderRemove': 'Remove',
      'settings.folderRemoveConfirm':
        'Remove this folder?\nIts photo index will be cleared; the image files themselves will not be deleted.',
      'settings.rescanAll': 'Rescan all',
      'settings.rescanAllTitle':
        'Rescan every library folder in turn; unchanged files are skipped, and you can stop midway.',
      'settings.rescanAllBusy': 'Rescanning…',
      'settings.rescanAllPreparing': 'Preparing to rescan all folders...',
      'settings.rescanAllConfirm':
        'Every library folder will be walked in turn; only changed files are updated.\n' +
        'Unchanged records are kept; records not found in this pass are marked stale and hidden (not deleted).\n\n' +
        'Folders are scanned one after another — Stop cancels the folders that have not started yet.\n\n' +
        'Continue?',
      'settings.rescanAllEmpty': 'No library folders yet — add one with “Add folder” first.',
      'settings.rescanAllFail': 'Rescan failed: {error}',
      'settings.rescanAllPartialFail': '{failed}/{total} folders failed to rescan: {error}',
      'settings.network.statusNotReady': 'Not ready',
      'settings.network.urlWhenOff': 'Off',
      'settings.network.readError': 'Read failed',
      'settings.network.copied': 'Copied!',
      'settings.network.tunnelRunning': 'Running',
      'settings.network.tunnelStarting': 'Starting…',
      'settings.network.tunnelError': 'Error',
      'settings.network.tunnelPending': 'Pending',
      'settings.network.tunnelBinaryFmt': 'cloudflared: {path}',
      'settings.network.tunnelBinaryNotFound': 'cloudflared: not found',
      'settings.network.tunnelBinaryReadError': 'cloudflared: read failed',
      'settings.network.webToggleFail': 'Could not toggle LAN access: {error}',
      'settings.network.tunnelPwdFirst': 'Set a web access password before enabling Tunnel.',
      'settings.network.tunnelApplyPwdFirst':
        'Click Apply to save the password before enabling Tunnel.',
      'settings.network.tunnelToggleFail': 'Tunnel action failed: {error}',
      'settings.network.passwordSaved': 'Access password saved',
      'settings.network.passwordCleared': 'Access password cleared',
      'settings.network.passwordSaveFail': 'Failed to save password: {error}',
      'settings.network.logCopied': 'Copied',
      'settings.task.hlsHintCurrentFmt':
        'Current: {gb} GB / {entries} folders (0 GB = no disk cap)',
      'settings.task.thumbEtaPrefix': ', ',
      'settings.task.thumbProgressRunning':
        'Backfilling: {done} / ~{total} ({pct}%) processed, {thumbs} preview image(s), {exifFilled} with capture info, failed {failed}{eta}',
      'settings.task.thumbProgressCounting':
        'Backfilling: {done} processed, estimating the remaining total…',
      'settings.task.thumbProgressNoTotal':
        'Backfilling: {done} processed (could not estimate the total, so no percentage or ETA)',
      'settings.task.thumbProgressDone':
        '{doneLabel}: {done} processed (of ~{total}), {thumbs} preview image(s), failed {failed}',
      'settings.task.thumbProgressDoneNoTotal':
        '{doneLabel}: {done} processed, {thumbs} preview image(s), failed {failed}',
      'settings.task.thumbStopped': 'Stopped',
      'settings.task.thumbCompleted': 'Done',
      'settings.task.thumbReadError': 'Could not read backfill status',
      'settings.task.thumbExportEmpty': 'No failed paths to export',
      'settings.task.thumbExportFail': 'Export failed: {error}',
      'settings.task.thumbExportOk': 'Exported {count} path(s) to:\n{path}',
      'settings.task.thumbStartFail': 'Failed to start backfill: {error}',
      'settings.task.dupProgressRunning':
        'Scanning {done}/{total} ({pct}%), new hashes {hashed}, reused {reused}, failed {failed}',
      'settings.task.dupProgressDone':
        '{doneLabel}: total {total}, new hashes {hashed}, reused {reused}, failed {failed}; groups {groups}, duplicate photos {photos}',
      'settings.task.gotoSimilar': 'View visual similar',
      'settings.task.gotoSimilarTitle': 'Go to visual-similar mode in Duplicates tab',
      'settings.task.dupIdle':
        'SHA-256 all photos in import order (unchanged files reuse existing fingerprints)',
      'settings.task.dupReadError': 'Could not read duplicate-detection status',
      'settings.task.dupStarting': 'Starting duplicate detection…',
      'settings.task.dupStartFail': 'Start failed: {error}',
      'settings.task.maintConfirmCleanup':
        'Remove database rows pointing to missing files. Continue?',
      'settings.task.maintCleaning': 'Removing invalid file rows…',
      'settings.task.maintCleanupFail': 'Cleanup failed: {error}',
      'settings.task.maintCleanupDone':
        'Done: checked {checked}, removed invalid files {deleted}, missing roots {removedRoots} (cascade {deletedByMissingRoots}), total deleted {totalDeleted}',
      'settings.task.maintRebuildRunning': 'Rebuilding thumbnail flags…',
      'settings.task.maintRebuildFail': 'Rebuild failed: {error}',
      'settings.task.maintRebuildDone': 'Done: still missing thumbnails: {missing}',
      'settings.task.maintOptimizeConfirm':
        'Optimize the database (may take a few seconds). Continue?',
      'settings.task.maintOptimizing': 'Optimizing database…',
      'settings.task.maintOptimizeFail': 'Optimize failed: {error}',
      'settings.task.maintOptimizeDone': 'Database optimized',
      'settings.task.maintBackupPreparing': 'Preparing backup…',
      'settings.task.maintBackupCancelled': 'Backup cancelled',
      'settings.task.maintBackupCancelledAlt': 'Backup cancelled',
      'settings.task.maintBackupFail': 'Backup failed: {error}',
      'settings.task.maintBackupDone': 'Backed up to: {path}',
      'preview.slideshow.play': '▶ Play',
      'preview.slideshow.pause': '⏸ Pause',
      'preview.slideshow.intervalAria': 'Slideshow interval',
      'preview.slideshow.random': 'Random',
      'preview.slideshow.randomTitle': 'Random slideshow order',
      'preview.info': 'Photo info',
      'preview.infoModuleMissing': 'Photo info module not loaded',
      'preview.fullscreen': 'Full screen',
      'preview.enterFullscreen': 'Full screen',
      'preview.exitFullscreen': 'Exit full screen',
      'preview.atFirst': 'Already at the first photo',
      'preview.atLast': 'Already at the last photo',
      'preview.rotate': 'Rotate',
      'preview.rotateTitle':
        'Rotate 90° clockwise (R) (preview only — press Save or Ctrl+S to write back) — Shift for counter-clockwise',
      'preview.flip': 'Flip',
      'preview.flipTitle': 'Flip horizontally (preview only — press Save to write back) — Shift for vertical',
      'preview.crop': 'Crop',
      'preview.cropTitle': 'Crop and save a copy (records the selection only — press Save to write back)',
      'preview.editSave': 'Save',
      'preview.editSaveTitle': 'Save edits and write back to the file (Ctrl+S)',
      'preview.editDiscard': 'Discard',
      'preview.editDiscardTitle': 'Discard unsaved edits (nothing is written back)',
      'edit.saved': 'Saved',
      'edit.failed': 'Edit failed',
      'edit.discarded': 'Unsaved edits discarded',
      'edit.cropHint': 'Enter to apply / Esc to cancel',
      'edit.cropPendingHint': 'Crop area chosen · Enter to save / Esc to cancel',
      'edit.cropStaged': 'Crop area chosen — press Save to write back',
      'edit.saveOrDiscardCrop': 'Save or discard the chosen crop area first',
      'edit.pendingTitle': 'Unsaved edits',
      'edit.pendingMessage':
        'Leaving will discard the unsaved rotate / flip / crop. Discard them?',
      'edit.cropSaved': 'Crop saved as a copy',
      'edit.noPhoto': 'No image to crop',
      'edit.unsupported': 'Editing is not supported in this environment',
      'preview.subtitle.auto': 'Subs: Auto',
      'preview.subtitle.off': 'Subs: Off',
      'preview.subtitle.trackAria': 'Subtitle track',
      'preview.subtitle.styleBtn': 'Subtitle style',
      'preview.subtitle.styleTitle': 'Subtitle style',
      'preview.favorite': 'Favorite',
      'preview.favoriteTitle': 'Favorite (F)',
      'preview.live': 'Live',
      'preview.liveTitle': 'Play the motion clip of this Live Photo',
      'preview.findSimilar': 'Similar',
      'preview.findSimilarTitle': 'Find visually similar photos (S)',
      'preview.similarNoPhotoInfo': 'Could not read the current photo',
      'preview.similarUnavailable': 'Find similar is unavailable right now',
      'preview.similarNoneFound': 'No visually similar photos found',
      'preview.similarNoDetails': 'No details found for these similar photos',
      'preview.similarFoundFmt': '⭐ Find similar · {n} photo(s) similar to “{name}”',
      'preview.similarFailFmt': 'Find similar failed: {err}',
      'preview.showInFolder': 'Show',
      'preview.showInFolderTitle': 'Show in file manager',
      'preview.openExternal': 'Open',
      'preview.openExternalTitle': 'Open with default app (O)',
      'preview.trash': 'Delete',
      'preview.trashTitle': 'Move to recycle bin',
      'preview.winMin': 'Minimize window',
      'preview.winMax': 'Full-screen preview',
      'preview.winRestore': 'Restore window',
      'preview.winMaximize': 'Maximize window',
      'preview.close': 'Close preview',
      'preview.videoPlay': 'Play video',
      'preview.videoPlayPauseTitle': 'Play / pause',
      'preview.prev': 'Previous',
      'preview.next': 'Next',
      'preview.subtitlePanel.size': 'Size',
      'preview.subtitlePanel.weight': 'Weight',
      'preview.subtitlePanel.color': 'Color',
      'preview.subtitlePanel.apply': 'Apply',
      'preview.subtitlePanel.close': 'Close',
      'preview.zoomHelpHtml':
        'Ctrl (⌘ on Mac) + wheel to zoom<br />+ / − keys · 0 reset<br />R rotate 90° (display only)<br />Home / End first / last<br />O open · pinch to zoom on touch',
      // Grid empty state + skeleton label: switched by media filter (all / image / video).
      // 🔴 Keep the wording aligned with the `#mediaFilterSelect` options below; the "all"
      //    entry covers videos too, which is why it says "photos or videos", not "files".
      // ⚠️ Mirrored in `web/js/app.js#renderPhotoGrid` / `#showSkeleton` — change both.
      'grid.emptyTitleAll': 'No photos or videos yet',
      'grid.emptyTitleImage': 'No photos yet',
      'grid.emptyTitleVideo': 'No videos yet',
      'grid.emptyHintAll': 'Try another location, or add a folder from Settings.',
      'grid.emptyHintImage': 'No photos here — try “All” or “Videos only”.',
      'grid.emptyHintVideo': 'No videos here — try “All” or “Photos only”.',
      'grid.loadingAll': 'Loading photos and videos…',
      'grid.loadingImage': 'Loading photos…',
      'grid.loadingVideo': 'Loading videos…',
      'task.collapseBtn': 'Collapse',
    },
  };

  var current = 'zh-CN';
  var _appVersion = '';

  function normalizeLocale(raw) {
    var s = String(raw || '')
      .trim()
      .toLowerCase();
    if (s === 'en' || s === 'en-us' || s === 'english') return 'en';
    return 'zh-CN';
  }

  function t(key) {
    var pack = M[current] || M['zh-CN'];
    var v = pack[key];
    if (v == null || v === '') {
      v = M['zh-CN'][key];
    }
    if (v == null) return key;
    if (typeof v === 'string' && _appVersion && v.indexOf('%VERSION%') >= 0) {
      v = v.split('%VERSION%').join(_appVersion);
    }
    return v;
  }

  function applyDom(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n]') : [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var k = el.getAttribute('data-i18n');
      if (!k) continue;
      var val = t(k);
      if (el.tagName === 'TITLE') {
        el.textContent = val;
      } else if (el.tagName === 'OPTION') {
        el.textContent = val;
      } else {
        el.textContent = val;
      }
    }
    // <optgroup> 的标题是 label **属性**，不是 textContent → 单独走一条通道（data-i18n 对它无效）
    var lb = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n-label]') : [];
    for (var li = 0; li < lb.length; li++) {
      var le = lb[li];
      var lk = le.getAttribute('data-i18n-label');
      if (lk) le.setAttribute('label', t(lk));
    }
    var ph = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n-placeholder]') : [];
    for (var j = 0; j < ph.length; j++) {
      var pe = ph[j];
      var pk = pe.getAttribute('data-i18n-placeholder');
      if (pk) pe.setAttribute('placeholder', t(pk));
    }
    var tt = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n-title]') : [];
    for (var x = 0; x < tt.length; x++) {
      var te = tt[x];
      var tk = te.getAttribute('data-i18n-title');
      if (tk) te.setAttribute('title', t(tk));
    }
    var ar = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n-aria-label]') : [];
    for (var y = 0; y < ar.length; y++) {
      var ae = ar[y];
      var ak = ae.getAttribute('data-i18n-aria-label');
      if (ak) ae.setAttribute('aria-label', t(ak));
    }
    var ih = scope.querySelectorAll ? scope.querySelectorAll('[data-i18n-html]') : [];
    for (var z = 0; z < ih.length; z++) {
      var he = ih[z];
      var hk = he.getAttribute('data-i18n-html');
      if (hk) he.innerHTML = t(hk);
    }
    try {
      document.documentElement.setAttribute('lang', current === 'en' ? 'en' : 'zh-CN');
    } catch (e) {}
    try {
      if (typeof global.__applyWebPasswordI18n === 'function') global.__applyWebPasswordI18n();
    } catch (e2) {}
    try {
      global.dispatchEvent(new Event('localechange'));
    } catch (e3) {}
  }

  // ==========================================================================
  // 日期与星期：唯一**不过词条表**的本地化
  // ==========================================================================
  /**
   * `2026-10-08` → 中文 `10月8日` / 英文 `Oct 8`；`getWeekday` → `周四` / `Thu`。
   *
   * **为什么不放进 `M` 词条表**：`10月8日` → `Oct 8` 不只是换词 —— 月名与语序都要变，
   * 这是 locale 的事，不是词条置换能表达的（当年就是因为这个才把它记成「独立主题」）。
   * 所以它住在 `I18n` 里、用 `Intl` 派生，是 `I18n` 的**第 5 个能力**（`t` 之外的第一个格式化器）。
   *
   * 🔴 两条硬要求，都是实测撞出来的、缺一条就是静默错：
   *
   *   ① **必须钉 `timeZone: 'UTC'`**：日期分组里的 `YYYY-MM-DD` 表示「那一天」，不是某个时刻。
   *      不钉的话 `new Date(Date.UTC(2026, 9, 8))` 会被按本机时区解释 ——
   *      实测 `TZ=America/New_York` 时星期从 `Thu` 变成 `Wed`（差一天，而中文用户永远看不到）。
   *
   *   ② **必须缓存 formatter**：`new Intl.DateTimeFormat` 实测 **0.0725 ms/次**
   *      （2000 次 145 ms，复用只要 2 ms），而日期侧栏一次渲染几百项 —— 不缓存就是几十毫秒白烧。
   *      `setLocale` 是**唯一**改 `current` 的入口 ⇒ 把 `current` 编进 key 就够了，
   *      失效判据是**结构性的**（不靠事件、不靠额外的失效通知，也**不需要**在 `setLocale` 里清缓存
   *      —— 清缓存那段会是一段永远不承重的装饰代码）。
   *
   * 📌 **同一组 option 在两个语言下各自正确**（实测，不需要按语言分支）：
   *      `{ month: 'short', day: 'numeric' }` → zh-CN `10月8日` / en `Oct 8`
   *      `{ weekday: 'short' }`               → zh-CN `周四`   / en `Thu`
   *    `month: 'long'` 在中文里没有长短之分（也是 `10月8日`），在英文里会变成 `October 8`
   *    （侧栏挤），所以统一用 `short`。
   *
   * ⚠️ 中文侧**只有一处**与改造前的硬编码不同，而且是**有意**的：单位数月**不补零**。
   *    旧实现是 `parts[1] + '月' + parseInt(parts[2], 10) + '日'` 这种字符串拼接 ⇒ 给出
   *    `01月5日`（前导零原样带出来）；`Intl` 的中文月名本来就是 `1月` ⇒ 给出 `1月5日`。
   *    其余输出（`10月8日` / `周四` / 带时间的 ISO 串取日期部分）与旧实现**逐字节相同**。
   *    ⚠️ `utils.js` 那份「拿不到 `I18n` 时」的中文兜底刻意与之**对齐**（见该文件注释），
   *       守护 `i18n-date-locale-regression.js` 把两条路的输出串钉在一起。
   */
  /**
   * formatter 缓存。🔴 **key 必须含 `current`** —— 这是「切语言后日期标签跟着变」的**唯一**机制：
   * 少了它，切到英文之后仍会命中中文那份 formatter（症状：**英文界面显示 `10月8日`，
   * 而且切回去再看又是对的**，所以特别难发现）。
   * 📌 上界 = 语言数 × 2 条（`normalizeLocale` 只有 `en` / `zh-CN`）⇒ **不需要失效逻辑**
   *    （`setLocale` 里刻意不清：那会是一段永远不承重的装饰代码）。
   */
  var _dateFormatters = {};

  function _dateFormatter(kind) {
    var key = current + '|' + kind;
    if (Object.prototype.hasOwnProperty.call(_dateFormatters, key)) return _dateFormatters[key];
    var options = { timeZone: 'UTC' };
    if (kind === 'weekday') {
      options.weekday = 'short';
    } else {
      options.month = 'short';
      options.day = 'numeric';
    }
    var made = null;
    try {
      made = new Intl.DateTimeFormat(current, options);
    } catch (e) {
      // 没有 Intl / 认不得这个 locale ⇒ **保持 null**（并照样缓存下来，别每次调用都重试一次
      // 注定失败的构造）。下面两个函数见到假值就返回「原样 / 空」，
      // 而不是抛出去把一次侧栏渲染整个打断。
    }
    _dateFormatters[key] = made;
    return made;
  }

  /**
   * `YYYY-MM-DD`（也认带时间的 ISO 串）⇒ `Date`。**解不出返回 null**（不抛、不返回 Invalid Date）。
   * ⚠️ 回读校验：`2026-02-30` 会被 `Date` 静默滚成 3 月 2 日 —— 宁可让上层原样返回，
   *    也不静默改一个日期（那是最难发现的一类错）。
   */
  function _dateAt(dateStr) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(dateStr == null ? '' : dateStr));
    if (!m) return null;
    var y = +m[1];
    var mo = +m[2];
    var d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var at = new Date(Date.UTC(y, mo - 1, d));
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) {
      return null;
    }
    return at;
  }

  /** 日期标签。解不出时**原样返回**（显示 `2026-10-0x` 总比显示 `undefined月NaN日` 好）。 */
  function formatDate(dateStr) {
    if (!dateStr) return '';
    var at = _dateAt(dateStr);
    var fmt = _dateFormatter('monthDay');
    if (!at || !fmt) return String(dateStr);
    return fmt.format(at);
  }

  /** 星期。解不出时返回**空串**（旧实现会返回 `undefined`，界面上就显示成 "undefined"）。 */
  function formatWeekday(dateStr) {
    if (!dateStr) return '';
    var at = _dateAt(dateStr);
    var fmt = _dateFormatter('weekday');
    if (!at || !fmt) return '';
    return fmt.format(at);
  }

  function setLocale(raw, options) {
    current = normalizeLocale(raw);
    applyDom(document);
    if (options && options.skipMainSync) return;
    try {
      if (global.photoAPI && typeof global.photoAPI.syncUiLocale === 'function') {
        global.photoAPI.syncUiLocale(current);
      }
    } catch (e) {}
  }

  function getLocale() {
    return current;
  }

  function initFromSettings(s) {
    if (!s || typeof s !== 'object') {
      setLocale('zh-CN', { skipMainSync: true });
      return;
    }
    setLocale(s.uiLocale, { skipMainSync: true });
  }

  global.I18n = {
    t: t,
    setLocale: setLocale,
    getLocale: getLocale,
    applyDom: applyDom,
    initFromSettings: initFromSettings,
    normalizeLocale: normalizeLocale,
    // 日期 / 星期（走 `Intl`，不过词条表）。消费者是 `utils.js#formatDateLabel` / `#getWeekday`
    // —— 那两个是 `RendererUtils` 的真相源，拿不到 `I18n` 时走自己的中文实现（`vm` 夹具就是那种情况）。
    formatDate: formatDate,
    formatWeekday: formatWeekday,
    setVersion: function (v) {
      _appVersion = String(v || '');
    },
    getVersion: function () {
      return _appVersion;
    },
  };
})(typeof window !== 'undefined' ? window : this);
