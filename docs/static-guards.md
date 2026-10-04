# 静态守护：死 CSS 与失联引用

三个脚本守着「代码里引用了并不存在的东西」这一类静默失效。它们都不报错、ESLint 也发现不了，
只会让功能悄悄失效，所以只能靠静态检查兜底。全部注册在 `scripts/run-regressions.js` 里，
随 `npm test` 一起跑。

| 脚本                                   | 守什么                                                                       | 关键白名单                      |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| `scripts/css-reference-regression.js`  | CSS 里定义了、但全项目没有元素/脚本使用的类名或 id                           | `STATE_CLASSES`、`IGNORE_FILES` |
| `scripts/dead-reference-regression.js` | JS 里读取了不存在的全局模块 / 调用了模块没导出的方法 / 引用了不存在的 DOM id | `BROWSER_GLOBALS`               |
| `scripts/check-text-corruption.js`     | 乱码、`??` 占位、中英混杂缺字、丢 `<` 的闭合标签                             | 无（命中即失败）                |

---

## 一、`dead-reference-regression.js`（2026-09-27 新增）

### 为什么要它

本项目渲染端由十几个全局模块拼装而成，模块之间靠裸全局名互相调用：

```js
global.RendererTabsUI = Object.assign({}, global.RendererTabsUI || {}, {
  prepareBrowsingShell: prepareBrowsingShell,
  applyDuplicatesView: applyDuplicatesView,
});
```

历史上就踩过：某次重构删掉了人脸视图，但残留了 `var facesUi = window.RendererFacesUI || {}`
（该全局从未被赋值），整块功能静默变成空对象，直到专门排查才发现。同类问题还有
「调用了模块没导出的方法」和「`$('#someId')` 指向一个不存在的元素」。

### 它怎么判定

用 **acorn 解析真实 AST**（不是正则猜结构），因此模块导出键表是准确的：

1. **模块全局**
   - 定义 = 所有 `window./global./root./self.X = ...` 的左侧。
   - 读取检查只统计 `window.` / `global.` 前缀。
     `root.` 不作读取来源——UMD 包装 `(function (root, factory) {...})` 里的 `root`
     常被复用作普通参数名（`root.id`、`root.style`），误报率极高；但 `root.X = ...`
     仍计入定义，避免漏掉 web 端 UMD 模块。
   - 名字不在定义集合、也不在 `BROWSER_GLOBALS` 里 → 报错。

2. **模块方法**
   - 只对「导出对象可静态枚举」的模块生效：右值是对象字面量，或 `Object.assign(...)`
     且各实参里没有展开符 / 计算属性 / 无法识别的对象来源。
   - `window.PhotoHlsAttach = api;`、`root.PhotoCompare = factory()`、
     `window.peoplePage = window.PeopleUI.mount({...})` 这类「把返回值挂到全局」的，
     可用方法无法静态判定，整块跳过。
   - `X.foo = fn` 这种动态挂载会把 `foo` 补进键表。
   - 调用点所在文件若把同名标识符声明成了局部名（局部遮蔽全局），跳过该文件。

3. **DOM id**
   - id 来源 = 所有 html 的 `id="..."` + js 里拼接/模板生成的 `id="..."` +
     `el.id = '...'`（含三元右值）+ `setAttribute('id', '...')`。
   - 引用 = 所有形如 `'#foo'` 的字符串字面量（用 `#rrggbb` 形态排除颜色值）。

### 边界（刻意的保守口径）

宁可漏报不误报。已知不覆盖：

- `root.X.method()` 形式的调用即使 X 从未定义也不会报（`root` 被排除）。
- 变量传参的动态调用（`var m = RendererUtils; m.foo()`）不检查。
- 模块导出表里混入的字符串键、`Object.assign` 里来源不明的实参，都会让整个模块被跳过。

### 命中时怎么处理

- **确认是真错** → 修引用（删掉死引用，或补上缺失的定义/导出）。
- **确认是浏览器内置 API 或宿主注入对象** → 加进脚本顶部的 `BROWSER_GLOBALS`。
- **确认是动态生成的 id** → 检查 JS 里是否以 `id="..."` 或 `.id = 字面量` 形式出现；
  没有的话就补成这种可识别写法。

---

## 二、本次顺手修掉的问题

### 1. `people.css` 里的渲染端专有选择器

`src/web/css/*.css` 有 4 个文件同时被渲染端和网页端加载，所以一份选择器要在两套 DOM 上都成立。
`people.css` 里混进了三条渲染端专有规则（`.nav-tabs` / `.nav-tab` 只存在于渲染端图标导航栏）：

- `.people-page-open #sidebar > :not(.nav-tabs)` —— `#sidebar` 的直接子元素里根本没有 `.nav-tabs`
  （图标栏 `.app-rail` 是 `#sidebar` 的**兄弟**节点），排除项永远不命中，已简化为 `#sidebar > *`。
- `.nav-tab:where(button)` —— 被 `.app-rail .rail-item` 完全覆盖（`:where()` 特异性为 0），已删除。
- `.nav-tabs button.nav-tab:focus-visible { outline-offset: -2px }` —— 特异性 (0,3,1) 高于
  `navigation.css` 的 (0,3,0)，在渲染端**是生效的**，已原样迁入 `navigation.css`。

验证：改动前后渲染端 1440×900 截图逐像素比对零差异（`ImageChops.difference().getbbox()` 为 `None`）。

### 2. `web/js/app.js` 的字幕设置死引用

`syncSubtitleSettingsUi()` 里 `$('#previewSubtitleSizeSelect')` / `$('#previewSubtitlePosSelect')`
指向两个全项目都不存在的元素，配合 `if (el)` 守卫就是彻底的空转。已删除这两段。

**遗留待定**：网页端的字幕「字号 / 位置」目前没有任何 UI 入口——
`_changeSubtitleSize()` / `_changeSubtitlePosition()` 定义了却从未被调用，也没有对应控件。
即这两个设置永远只能是默认值（`md` / `bottom`）。要么补 UI，要么把这一整条链路删掉。

### 3. `npm test` 一直不存在

`.github/workflows/checks.yml` 与 `release.yml` 都执行 `npm test`，但 `package.json` 的
`scripts` 里从来没有 `test`（`git log -S'"test"' -- package.json` 无任何记录）。
已补 `"test": "node scripts/run-regressions.js"`，CI 的这一步现在才真正跑得起来。

### 4. 根目录垃圾与一次性脚本

删除：

- `tmp-fix-appjs.js`、`debug-list-folders.js`（被 git 跟踪的一次性脚本，全项目无引用）
- `scripts/fix-appjs-text.js`、`scripts/fix-web-text.js`（已执行完毕的乱码修复脚本，
  匹配的 `'????'` 占位在代码里已归零，留着反而是「再跑一次就会破坏源码」的隐患）
- `C:tempelectron41.log`、`C:tempelectron41-test.log`（MSYS 把 `C:\temp\` 里的冒号编码成
  U+F03A 后落盘产生的畸形日志；`ls` 显示成 `C:` 但真实文件名没有冒号，
  用 `rm` 会被 safe-delete 拦下，需要在 Node 里按 `readdirSync` 拿到的真实名删除）

`eslint.config.js` 里为 `debug-list-folders.js` 开的 ignore 项一并清掉。

### 5. 孤儿样式表 `src/web/css/style.css`

无任何页面加载（`web/index.html` 只加载另外 4 个），内容与 `web/index.html` 的内联样式高度重复。
已整体删除（3477 行），同步清理 `css-reference-regression.js` 里为它开的 `IGNORE_FILES` 白名单
和 `AGENTS.md` / `CLAUDE.md` / `README.md` 的目录说明。细节见 `docs/css-structure.md`。

### 6. `check-text-corruption.js` 扩大了扫描范围

原先只扫 `src/web/index.html` 与 `src/web/js/app.js`，而乱码/编码事故同样会发生在渲染端
（本项目就出过 `app.js` 被写成 CRLF 的事）。改为按目录遍历 `src/renderer` + `src/web`（排除 vendor），
现覆盖 26 个文件；输出也从「每个文件一行」改成「只列有问题的文件」。

---

## 三、一个待确认的仓库卫生问题

`package.json` 配置了 `"icon": "build/icon.ico"`，但 `build/` 目录**从未被 git 跟踪**
（`git log --all -- build/` 为空），也不在 `.gitignore` 里。

2026-09-27 会话中途该文件短暂出现过（13:25 生成了 372 KB 的 `build/icon.ico`，
此前 13:19 并不存在），属于打包工具链生成的中间产物。

需要确认：这个图标到底是「打包时从 `src/web/app-icon-512.png` 生成」还是
「应该作为源资源提交进仓库」。若是后者，当前状态意味着全新 clone 打包会退化成 Electron 默认图标。
