# 刻意维持现状清单

> 本文记录**看起来像 bug / 像遗漏、但实际上是刻意决定的**事项，以及**已经试过并被证伪的路**。
> 收录判据：回归脚本断言不了 —— 脚本能钉住"代码长什么样"，钉不住"为什么不做"和"哪条路已经死过"。
> 改动其中任何一条之前，请先读完对应条目。

## A. 已证伪的路（别重试）

### 主窗口不做圆角 —— 三条路全部量过并回退

- **两条"渲染层圆角"路径**（HTML/CSS 层做圆角 + 窗口层配置）：结果是「四角更淡的方窗口」。
  实测四角像素 `rgb(162,190,239)`，反推露的就是亚克力底本身 —— **比不改还难看**。
- **第三条 `win.setShape()`（`SetWindowRgn` 窗口区域裁剪）**：这是**唯一能把圆角真画出来的**
  （其余两条连形状都没有），但**不解决问题**。实测（4K/150%，Electron 41，真实应用 + 隔离库 + 亚克力档）：
  窗口左上角沿对角线 `d=0..5` 是 `rgb(207,220,233)`、`d≥6` 才进窗口内容，而窗外桌面是 `rgb(248,253,255)`。
  那条 `rgb(207,220,233)` 是**均匀的纯亚克力底**（不是渐变 ⇒ 可排除「窗口阴影」）
  ⇒ **`setShape` 只裁掉了渲染层，DWM 的亚克力在自己的合成层上铺满整个窗口矩形、不跟随窗口区域**。
  用户看到的就是「圆角上镶了一条灰蓝脏边」。
- 因此**「延迟/重设 region」没有意义**（不是时序问题）。唯一能真圆角的前提是**放弃亚克力**
  （`transparent` 但不带 `backgroundMaterial` ⇒ 四角露桌面、但没有毛玻璃，等于废掉窗口背景这一维），
  或者「窗口保持矩形 + 把圆角做到渲染层的内容卡片上」—— 两者都不是「窗口四角圆角」，**故不做**。

### 底栏「随机」的扩散环 —— 实测后删除，**禁加回**

它是常驻重绘源（不是点击时才有）。已删。看到「随机按钮缺个点击反馈」别顺手补回来。

### `prettier --check` 本来就是红的 —— **别跑 `prettier -w`**

全仓库格式化会大面积重写源码，且与既有风格冲突。lint 用 `npm run lint`，不要用 prettier 兜底。

## B. 刻意不在清单里 / 刻意不排

- **`.home-page`** 已进**面板透明度**与**窗口背景**两张清单，**纹理清单刻意不加**。
- **「统一高度」卡片档**刻意不挂 `photo-card--square-placeholder`（其余四路都挂，因为它有 CSS 死高度）。
- **`all` 档与统计谓词里刻意不排伴生视频**：两处原因不同，见 `docs/contracts/live-photo.md`
  「刻意取舍」一节。摘要：`db-heavy-read` 的统计谓词与部分索引
  `idx_photos_agg_root_folder_{image,video}` **逐字绑定**，为保索引可用而刻意不排；
  `searchPhotos` 的 `all` 档排了会打开 `hasExtraFilter`、让两条优化同时失效。
- **Live Photo 配对任务：读盘失败直接写 `0`（终态），刻意不做重试账** ——
  否则失败行会被反复认领，任务永不收敛。
- **配对查询刻意不加 `ORDER BY`**：加了规划器会放弃 `SEARCH ... USING COVERING INDEX idx_photos_type`
  退回 `SCAN`。同理 `file_type IN ('mov','MOV')` 不许写成 `lower(replace(file_type,'.',''))='mov'`
  （实测后者扫全部 156 万条索引项）。

## C. 看着像 bug，其实不是 —— 别顺手修

- **`notifyBrowseUiReady` 零调用**，启动永远走 12 秒兜底。**别顺手接上**：
  接上会改变首屏时序，而首帧问题（`≈58` 秒）**未修**、根因另在别处。
- **lint 基线 2 warning**（`src/web/js/app.js` 的 `changeWebOpacity` / `changeWebTexture`）：
  它们从 HTML `onchange` 调用，静态分析看不见。**别"修"**。
- **`.web-qr[hidden]` 这个 CSS 选择器别删**：二维码只在设置页 Network 面板且状态合适时才画，
  删了会导致不该出现时出现在别的面板。
- **网页端 `/api/settings` 仍保留但不再消费**：不是死接口，别按"没人用"删掉。

## D. 验证这类问题时的可用手段（2026-10-05 打通）

- 截屏看 DWM 级问题：**`ffmpeg -hide_banner -f gdigrab -framerate 1 -i desktop -frames:v 1 -y x.png`**
  从命令行直接可用。「四角露的是桌面还是亚克力底」这类问题第一次能自动看见（此前判过「只能肉眼确认」）。
- **窗口精确坐标**：给应用加 `--remote-debugging-port`，用 CDP 读
  `screenX/screenY/outerWidth/outerHeight/devicePixelRatio`（本机 dpr 1.5），别再猜坐标。
  `window.moveTo(x, y)` 经 CDP 调**是生效的** —— 验证窗口角时用它把窗口挪到屏幕角落、避开其它窗口。
- 🔴 `Browser.getWindowForTarget` / `Browser.setWindowBounds` 在 Electron 里**返回 undefined，不可用**。
- 🔴 清理自己的实例用 `taskkill /F /T /PID`，只按 `MainWindowTitle` 或调试端口过滤，
  **别用「全部 electron」**（会误杀用户自己 `electron . --dev` 的那扇窗口）。
  判定自己的实例看 `Win32_Process.CommandLine` 里的 `--user-data-dir`。
