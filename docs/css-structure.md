# 样式表结构与死规则清理

## 一、样式表必须放在 `<head>`

`src/renderer/index.html` 的 7 个样式表全部位于 `<head>`，且顺序即层叠顺序（后加载覆盖先加载）：

```
styles.css → gallery-design.css → photo-compare.css → semantic-search.css → people.css → navigation.css → theme-polish.css
```

**新增样式表请追加到该块末尾，不要放回 body。**

原因：原先 `photo-compare.css`、`semantic-search.css`、`people.css`、`navigation.css`、`theme-polish.css` 这 5 个挂在 `</body>` 之前。浏览器要解析到文档末尾才开始请求并应用它们，而首屏内容此时早已开始渲染，于是出现首帧无样式闪烁（FOUC）。

实测（探针统计「解析到该处时 DOM 中的样式表 link 数」）：

- 改动前：到达 `</head>` 时 **2** 个，到达 body 首个脚本时仍只有 **2** 个 —— 整个 body 解析期都缺这 5 个样式表。
- 改动后：到达 `</head>` 时 **7** 个，全部参与首屏渲染阻塞。

前移时严格保持了相对顺序，因此层叠结果不变：改动前后各截一张 1440×900 的图，逐像素比对**零差异**。

## 二、死规则清理

2026-09-27 一次性清理 **85 个死分支**（定义了但全项目没有任何元素/脚本引用的类名或 id）：

- `src/renderer/styles.css`：40 处
- `src/renderer/theme-polish.css`：1 处（`.progress-count`）
- `src/web/css/gallery-design.css`：2 处（`.toolbar-path`、`.topbar-settings-btn`）
- `src/web/index.html` 内联 `<style>`：42 处

删的主要是几批已重构掉的 UI 遗留：`x` 卡片尺寸控件（`.card-aspect-control`，web 端实际已改用 `header-card-aspect-select`）、工具栏筛选（`.filter-group` / `.toolbar-path` / `.toolbar-filter-btn`）、预览信息栏旧结构（`.preview-info` / `.preview-minibar`）、Toast 子结构（`.web-toast-item/-icon/-text/-close`，现在 toast 只放纯文本）、搜索历史下拉（`.search-history-*`，功能不存在）、文件夹管理旧结构（`.folder-manage-item`）、以及 `settings-checkbox-row` / `preview-setting-checkbox` 等一批设置页复选框样式。

验证方式（每一步都做）：

1. 大括号配对归零；
2. **活规则零丢失** —— 解析改动前后每个规则块，逐个比较「选择器分支 + 规则体」，确认删除的只有死分支，存活规则数量与内容完全一致（styles.css 739→739、theme-polish 88→88、gallery-design 110→110、web 内联 497→497）；
3. 两端真实渲染逐像素比对零差异。

## 三、哪些类名**不能**按「文本没出现」就删

写静态检查时最容易误伤这几类，识别它们需要额外规则：

- **helper 传参生成**：`node('button', text, 'ai-button')`、`element('div', 'compare-stage')` —— 类名是函数第二个/第三个字符串参数，不在 `classList` 或 `className` 里出现。`.ai-*`、`.compare-*`、`.people-*`、`.photo-compare` 全部属于此类。
- **三元表达式赋 id**：`dialog.id = embedded ? 'peopleSettingsPanel' : 'peoplePage'` —— `.id = '字面量'` 的采集器抓不到三元右值。
- **拼接生成 DOM**：`'<div class="folder-item' + (active ? ' active' : '') + '">'` —— 类名被字符串边界切断，需从字面量里再抠 `class="…"` 片段。
- **通用状态类**：`disabled` / `show` / `active` / `selected` / `hidden` / `expanded` 等由 JS 运行时切换，永远不做静态引用统计。

## 四、孤儿文件：`src/web/css/style.css`（已于 2026-09-27 删除）

该文件**没有任何页面加载**：`web/index.html` 只引用 `/gallery-design.css`、`/photo-compare.css`、`/semantic-search.css`、`/people.css`，`web-server.js` 也只映射这 4 个；web 端样式已全部内联进 `index.html`。

它与 `web/index.html` 的内联样式高度重复（同一批类名两处定义），是「内联化重构只做了一半」的产物。

**处置**：确认孤儿后已整体删除（3477 行），同时清掉 `css-reference-regression.js` 里为它开的 `IGNORE_FILES` 白名单、以及 `AGENTS.md` / `CLAUDE.md` / `README.md` 里的目录说明。删除前的版本仍可从 git 历史取回。该文件最后出现于提交 `6f9b7b6 release: v1.1.0 feature batch`。

## 四之二、共享样式表里不要放单端专有选择器

`src/web/css/*.css` 有 4 个文件同时被渲染端（`renderer/index.html`）和网页端（`web/index.html`）加载。这意味着**同一份选择器要在两套 DOM 上都成立**。

两种正确写法：

1. **成对写**（两套 DOM 用的是不同类名时）——`gallery-design.css` 的做法：
   ```css
   .nav-tabs, .sidebar-tabs { ... }   /* .nav-tabs 渲染端，.sidebar-tabs 网页端 */
   ```
2. **放进该端自己的样式表**——渲染端专有规则放 `renderer/navigation.css`。

**踩过的坑（2026-09-27 修）**：`people.css` 里曾有三条渲染端专有规则：

- `.people-page-open #sidebar > :not(.nav-tabs)` —— `#sidebar` 的直接子元素里根本没有 `.nav-tabs`（图标导航栏 `.app-rail` 是 `#sidebar` 的**兄弟**节点，不是子节点），这个排除项永远不命中，等价于 `#sidebar > *`。已简化。
- `.nav-tab:where(button)` —— 与 `.app-rail .rail-item` 完全重复（`:where()` 特异性为 0，整条被后者覆盖），已删除。
- `.nav-tabs button.nav-tab:focus-visible { outline-offset: -2px }` —— 特异性 (0,3,1)，高于 `navigation.css` 里 (0,3,0) 的 `.app-rail .rail-item:focus-visible`，在渲染端是**生效**的，已原样迁入 `navigation.css`（放在同特异性规则之后，胜出结果与原先一致）。

验证：改动前后渲染端 1440×900 截图逐像素比对**零差异**（`ImageChops.difference().getbbox()` 为 `None`）。

## 五、守护

`scripts/css-reference-regression.js`（已注册进 `scripts/run-regressions.js`）拦截新增死规则。

判定口径刻意保守 —— 宁可漏报不误报：引用来源取 `src` 下所有 html 的 `class`/`id` 属性 + 所有 js 的字符串字面量（含从字面量里抠出的 `class="…"` 片段）+ `'前缀-' + x` 拼接；通用状态类与孤儿文件单独排除。

若它报错但确认是动态类名，按提示处理：把状态类加进 `STATE_CLASSES`，孤儿样式表加进 `IGNORE_FILES`，或检查 JS 里该类名是否确实以字符串形式存在。

同一批静态守护（死 CSS / 失联引用 / 文案乱码）的完整说明见 **`docs/static-guards.md`**。
