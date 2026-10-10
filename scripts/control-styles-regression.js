'use strict';
/**
 * 控件样式「单一来源」回归。
 *
 * 背景（2026-10-04）：按钮与下拉框的同一套视觉曾在 4 个文件里各写一遍，且**同名选择器互相覆盖**
 * —— 桌面端 8 张样式表按 `styles.css → gallery-design → photo-compare → semantic-search →
 * people → navigation → theme-polish → ai-views` 顺序加载，后加载的同特异性规则会赢。于是
 * 「读某个文件得到的结论」经常不是实际生效的那条：删掉 A 里的一条，可能刚好让 B 里一条从没被
 * 注意过的规则开始生效，而且**不会有任何报错**。
 *
 * 这一轮把每个控件的取值收敛到唯一出处，本脚本用**剥注释后的源码文本**钉住它。断言都写成
 * 「唯一来源还成立」而不是「某个具体像素值」—— 后者会随设计调整而变，前者才是这次要守的契约。
 *
 * ⚠️ 断言必须在**剥掉注释**的文本上进行：本轮特意在源码里写了长注释解释「为什么不在这里」，
 *    不剥注释会把解释当违规。
 * ⚠️ 与 `css-reference-regression.js`（拦死类名）分工不同：那个管「有没有人用」，这个管
 *    「同一个控件是不是只有一个地方说了算」。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const STYLES = 'src/renderer/styles.css';
const GALLERY = 'src/web/css/gallery-design.css';
const POLISH = 'src/renderer/theme-polish.css';
const SEMANTIC = 'src/web/css/semantic-search.css';
const COMPARE = 'src/web/css/photo-compare.css';
const COMPARE_JS = 'src/web/js/photo-compare.js';
const WEB_HTML = 'src/web/index.html';

/** 剥掉块注释，并把空白折叠成单空格 —— 断言因此不受 prettier 折行影响。 */
function normalize(rel) {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** 取某个选择器之后那个 `{ ... }` 的声明体（配平花括号）。找不到返回 null。
 *  ⚠️ header **自身含 `{` 时**就从那个 `{` 开始算（header 可以带上一两个声明做去歧义，
 *     例如 `.btn { display: inline-flex;`）—— 否则会越过它、命中后面某条规则的块
 *     （踩过：`.btn` 取到了 `.btn:hover` 的块、以及浅色主题的覆写块）。 */
function blockOf(text, header) {
  const i = text.indexOf(header);
  if (i < 0) return null;
  const braceInHeader = header.lastIndexOf('{');
  const open =
    braceInHeader >= 0 ? i + braceInHeader : text.indexOf('{', i + header.length);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, j);
    }
  }
  return null;
}

/** 统计子串出现次数。 */
const count = (text, needle) => text.split(needle).length - 1;

const failures = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) notes.push(`  ✓ ${name}`);
  else failures.push(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
}

const styles = normalize(STYLES);
const gallery = normalize(GALLERY);
const polish = normalize(POLISH);
const semantic = normalize(SEMANTIC);
const compare = normalize(COMPARE);
const compareJs = normalize(COMPARE_JS);
const webHtml = normalize(WEB_HTML);

// ---------------------------------------------------------------- 夹具自证
// 剥注释不能把文件剥空，否则下面「不存在 X」的断言全是假通过。
check(
  '夹具自证：剥注释后各文件仍有实际内容',
  gallery.includes('.header select {') &&
    styles.includes('.btn {') &&
    semantic.includes('.ai-button {') &&
    polish.length > 2000,
  `gallery=${gallery.length} styles=${styles.length} polish=${polish.length} semantic=${semantic.length}`,
);

// ------------------------------------------------- 1. .btn 族：唯一来源 = styles.css
// ⚠️ 锚点必须细到「基础块」：`.btn {` 在文件里出现 6 次，**第一次是浅色主题里
//    `html[data-theme='light'] .settings-page .btn {`**，比基础块还靠前。
const btnBlock = blockOf(styles, '.btn { display: inline-flex;');
check(
  '夹具自证：取到的是 .btn 基础块（不是浅色覆写或某个 .xxx-btn）',
  !!btnBlock && btnBlock.includes('padding: 8px 16px') && btnBlock.includes('cursor: pointer'),
  btnBlock ? btnBlock.slice(0, 80) : 'not found',
);
check(
  `.btn 基础块带着原 gallery-design 的覆写值（border-radius: 8px）`,
  !!btnBlock && /border-radius: 8px/.test(btnBlock),
);
const btnHover = blockOf(styles, '.btn:hover { background: var(--bg-hover);');
check(
  `.btn:hover 不做位移（transform: none，原 gallery-design 的覆写）`,
  !!btnHover && /transform: none/.test(btnHover) && !/translateY\(-1px\)/.test(btnHover),
);
check(
  `gallery-design.css 不再声明 .btn 族（唯一来源在 styles.css）`,
  !/\.btn[\s,{:.]/.test(gallery) && !/\.settings-page \.btn/.test(gallery),
);
check(
  `gallery-design.css 不再声明下拉框（唯一来源在 styles.css）`,
  !gallery.includes('select.sort-select') && !gallery.includes('select.ui-select'),
);
check(`gallery-design.css 不再声明 .topbar select`, !gallery.includes('.topbar select'));
check(
  `gallery-design.css 只留 web 侧独有的 .header select 基准`,
  gallery.includes('.header select {'),
);

// ------------------------------------- 2. 主按钮：纯色（说明 gallery-design 那份已并入）
const primaryBlock = blockOf(styles, '.btn-primary {');
check(
  `.btn-primary 是纯色而非渐变（gallery-design 的三色渐变已并入此处）`,
  !!primaryBlock && /color-mix\(/.test(primaryBlock) && !/linear-gradient/.test(primaryBlock),
  primaryBlock ? primaryBlock.slice(0, 100) : 'not found',
);

// --------------------------- 3. 设置页按钮的特异性提升（去掉会让反主按钮变灰）
check(
  `styles.css 用 :where() 提特异性保住「反主按钮」不被玻璃皮肤盖住`,
  styles.includes('.settings-page .btn:where(:not(.btn-primary))'),
  '缺失时反主按钮的透明底会被 (0,2,0) 的玻璃皮肤盖成灰色',
);

// --------------------------------- 4. `.ai-button`：唯一来源 = semantic-search.css
check(
  `.ai-button 的唯一来源（semantic-search.css）带着合并后的取值`,
  (() => {
    const b = blockOf(semantic, '.ai-button {');
    return !!b && /padding: 8px 13px/.test(b) && /min-height: 36px/.test(b);
  })(),
);
check(
  `theme-polish.css 不再声明 .ai-button 的外观（只留 prefers-reduced-motion 关过渡）`,
  !/\.ai-button[^{]*\{[^}]*(padding|min-height|background|border-radius)/.test(polish),
  'theme-polish 晚于 semantic-search 加载，同特异性的声明会静默取胜',
);

// --------------------------------------- 5. 下拉框：唯一来源 = styles.css
// 2026-10-09：标签筛选按钮（#orgFilterTagsBtn，<button class="sort-select">）并入同一块 ——
// 它与两个下拉在工具条上并排，皮肤必须同源。选择器头是字面量断言：
// 有人把 button 拆出独立声明时，这里会立刻变红（那正是「唯一来源」被破坏）。
const selectBlock = blockOf(styles, 'select.sort-select, select.ui-select, button.sort-select {');
check(
  `select.sort-select / select.ui-select / button.sort-select 的唯一来源带 8px 圆角`,
  !!selectBlock && /border-radius: 8px/.test(selectBlock),
);
check(
  `styles.css 顶栏两个下拉合并为一条共用规则`,
  styles.includes('.topbar-locale-select, .topbar-theme-select {'),
);
check(
  `顶栏下拉只保留宽度修饰（min-width 各一次）`,
  count(styles, 'min-width: 100px') === 1 && count(styles, 'min-width: 140px') === 1,
);

// ----------------------------- 6. 网页端六个 .header-*-select：共用骨架 + 变体 + 宽度
check(
  `web/index.html 六个顶栏下拉共用一条骨架`,
  webHtml.includes(
    '.header-theme-select, .header-card-aspect-select, .header-sort-select, .header-media-filter-select, .header-accent-select, .header-background-select {',
  ),
);
check(
  `web/index.html 的底色走变量，两个质感各覆写一次（不是整块各抄一份）`,
  count(webHtml, '--header-select-fill: linear-gradient(') === 2,
);
check(
  `web/index.html 的宽度差异集中在六条尺寸修饰里`,
  ['132px', '110px', '120px', '90px', '104px', '96px'].every(
    (v) => count(webHtml, `min-width: ${v}`) === 1,
  ),
);

// ---------- 7. 「加入对比」在预览工具栏内与 .btn.btn-sm 共用同一条声明（唯一来源）
// 背景（2026-10-04 下午）：`.compare-button` 是 photo-compare.js 注入到 `.preview-controls-group`
// 里的，此前它自带一套 7px 平底方角皮肤，夹在一排 999px 胶囊中间 —— 观感明显不一致。
// 现在它**在工具栏内**不拥有自己的外观，而是并入下面这条共享声明；`.compare-button` 自身的
// 声明只服务对比托盘 / 对比弹窗（都不在 `.preview-controls-group` 内）。
// ⚠️ 下面这张清单是「所有需要成对出现的状态」。**新增状态（如 :disabled）时必须同步加进来**，
//    否则新状态会退回 `.compare-button` 自己的皮肤 —— 那正是这次要消灭的东西。
//    基础那条不在清单里：它在「深色基础 + 窄屏媒体查询」各出现一次（共 2 次），
//    由下面那条 `=== 2` 的断言单独覆盖。
const COMPARE_PAIRS = [
  '.preview-controls-group > .btn.btn-sm:hover, .preview-controls-group > .compare-button:hover {',
  '.preview-controls-group > .btn.btn-sm:active, .preview-controls-group > .compare-button:active {',
  '.preview-controls-group > .btn.btn-sm:focus-visible, .preview-controls-group > .compare-button:focus-visible {',
  "html[data-theme='light'] .preview-controls-group > .btn.btn-sm, html[data-theme='light'] .preview-controls-group > .compare-button {",
  "html[data-theme='light'] .preview-controls-group > .btn.btn-sm:hover, html[data-theme='light'] .preview-controls-group > .compare-button:hover {",
  "html[data-theme='light'] .preview-controls-group > .btn.btn-sm:active, html[data-theme='light'] .preview-controls-group > .compare-button:active {",
];
const compareGroupBlock = blockOf(
  styles,
  '.preview-controls-group > .btn.btn-sm, .preview-controls-group > .compare-button {',
);
check(
  '夹具自证：取到的是预览工具栏按钮的共享声明块（含 999px 胶囊圆角）',
  !!compareGroupBlock && /border-radius: 999px/.test(compareGroupBlock),
  compareGroupBlock ? compareGroupBlock.slice(0, 90) : 'not found',
);
check(
  '共享块自带布局三件套 + gap（否则 .compare-button 缺 .btn 的 flex 布局）',
  !!compareGroupBlock &&
    /display: inline-flex/.test(compareGroupBlock) &&
    /align-items: center/.test(compareGroupBlock) &&
    /justify-content: center/.test(compareGroupBlock) &&
    /gap: 6px/.test(compareGroupBlock),
);
for (const pair of COMPARE_PAIRS) {
  check(`成对声明存在且各一次：${pair.slice(0, 62)}…`, count(styles, pair) === 1);
}
// 深色 + 浅色 + 窄屏各覆盖一次 → 一共 9 处（含 ::before 图标规则）
const compareMentions = count(styles, '.compare-button');
const comparePrefixed = count(styles, 'preview-controls-group > .compare-button');
check(
  `styles.css 里 .compare-button 只以「工具栏后代」形式出现（${comparePrefixed}/${compareMentions} 处）`,
  compareMentions > 0 && compareMentions === comparePrefixed && comparePrefixed >= 8,
  '出现裸 .compare-button 就等于又开了第二个来源',
);
check(
  '窄屏媒体查询里也成对（小屏不能退回方角皮肤）',
  count(
    styles,
    '.preview-controls-group > .btn.btn-sm, .preview-controls-group > .compare-button {',
  ) === 2,
);
// 图标：CSS 遮罩画，尺寸对齐同组按钮的 .btn-icon（13px）
check(
  '「加入对比」的图标走 CSS 遮罩且 13px（与同组 .btn-icon 同尺寸）',
  (() => {
    const b = blockOf(styles, '.preview-controls-group > .compare-button::before {');
    return !!b && /13px/.test(b) && /mask:/.test(b);
  })(),
);
check(
  'photo-compare.js 不自行造 SVG（两端共用模块，必须能跑在无 createElementNS 的假 DOM 上）',
  !compareJs.includes('createElementNS') && !compareJs.includes('innerHTML'),
  '造 SVG 会让 scripts/compare-regression.js 直接抛错',
);
// 托盘 / 弹窗那份皮肤保持原样（那是另一个上下文，不该被这次收敛带走）
check(
  '托盘 / 对比弹窗的 .compare-button 仍保留自己的 7px 皮肤',
  (() => {
    const b = blockOf(compare, '.compare-button {');
    return !!b && /border-radius: 7px/.test(b) && /padding: 7px 11px/.test(b);
  })(),
);

// ---------------------------------------------------------------------- 输出
process.stdout.write('[control-styles-regression] 控件样式单一来源契约\n');
for (const line of notes) process.stdout.write(`${line}\n`);
if (failures.length) {
  process.stdout.write('\n');
  for (const line of failures) process.stdout.write(`${line}\n`);
  process.stdout.write(`\n[control-styles-regression] FAIL（${failures.length} 项）\n`);
  process.exit(1);
}
process.stdout.write(`[control-styles-regression] PASS（${notes.length} 项）\n`);
