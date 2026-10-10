'use strict';
/**
 * 中英语言包对账（`src/renderer/i18n.js`）—— **包级**不变量，不依赖谁引用了哪一条。
 *
 * 三条不变量，坏起来**全是静默的**：
 *   ① **同键**：两包键集合必须一一对应。少一条 ⇒ 切到那门语言时 `I18n.t()` 静默回落中文包
 *      （`t()` 里 `pack[key] == null` 就退到 `M['zh-CN']`）⇒ 界面上完全看不出「缺词条」，
 *      用户只会觉得「怎么突然有句中文」。反方向（英文多一条）是死词条，白占包体。
 *   ② **同占位符**：同一条词条在两包里 `{name}` 集合必须一致。英文模板漏一个 `{err}`
 *      ⇒ 提示说得出「失败」却说不出「为什么」，而中文侧一切正常 ⇒ **只在英文界面复现**。
 *   ③ **英文包里不许有中文**：漏翻译最常见的形状就是把中文原样抄进 `en`；
 *      抄进去之后 ①② 都还是绿的（键在、占位符也一样）。
 *
 * 已有覆盖到什么程度（本守护补的是缺口，不是重复）：
 *   · `background-tasks-panel-regression` ④ 会逐键数 `'key':` 出现 2 次 —— 但只覆盖
 *     **面板 + `app.js` 引用到的**键。一条谁也没引用、或只在 `scan-flow.js` / `settings.js`
 *     里引用的词条不在它的扫描面里，两包不对称照样绿。
 *   · ② 与 ③ **全工程原本没有任何地方在管**。2026-10-08 把 `app.js` 文案改走 `tUiFmt`
 *     时才撞上这件事：想验证「英文模板里到底有没有 `{err}`」只能靠行为用例逐个键临时罩住
 *     （当时只罩了「每页数量」「网格与比例」两个键）。包级对账一次覆盖全部。
 *
 * 为什么必须走 AST 而不是正则：
 *   · 词条值有 **`+` 拼接**（多行确认框是 `'第一行\n' + '第二行\n'`）⇒ 只认单个字面量的写法
 *     会把它们整段跳过，而「跳过」在断言里长得跟「通过」一模一样（静默假绿）；
 *   · 注释里出现的示例键不是词条（`acorn` 天然不含注释，正则要先剥）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const SOURCE = 'src/renderer/i18n.js';

/**
 * 英文包里**允许**出现中文的两条（其余一律视为漏翻译 —— 那是坏法，不是风格问题）：
 *   · `settings.lang.zh`：语言自称。语言选择器里「简体中文」在任何语言下都写简体中文，
 *     翻成 `Simplified Chinese` 反而让中文用户找不到自己那一条。
 *   · `help.aboutBody`：作者署名 `拂晓AI` 是专名，不译。
 */
const EN_CJK_ALLOWED = ['settings.lang.zh', 'help.aboutBody'];

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const name of Object.keys(node)) {
    const value = node[name];
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object' && typeof value.type === 'string')
      walk(value, visit);
  }
}

/** 属性名（字符串键或标识符键）。 */
function keyOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number'))
    return String(node.value);
  return null;
}

/** 折叠「字面量 + `+` 拼接」；折不动（变量 / 模板串 / 函数调用）返回 null。 */
function literalString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = literalString(node.left);
    const right = literalString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** 取出两个语言包；值是折叠后的字符串（折不动的留 null，由调用侧判红）。 */
function readPack() {
  const source = fs.readFileSync(path.join(ROOT, SOURCE), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const packs = {};
  let concatenated = 0;
  walk(ast, (node) => {
    if (node.type !== 'Property' || !node.value || node.value.type !== 'ObjectExpression') return;
    const locale = keyOf(node.key);
    if (locale !== 'zh-CN' && locale !== 'en') return;
    const map = new Map();
    for (const entry of node.value.properties) {
      if (entry.type !== 'Property') continue;
      const key = keyOf(entry.key);
      if (key == null) continue;
      if (entry.value.type !== 'Literal') concatenated += 1;
      map.set(key, literalString(entry.value));
    }
    packs[locale] = map;
  });
  return { packs, concatenated };
}

const placeholdersOf = (text) =>
  [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');
const hasCjk = (text) => /[\u3400-\u9fff]/.test(text);

function run() {
  const { packs, concatenated } = readPack();
  const zh = packs['zh-CN'];
  const en = packs.en;
  assert.ok(zh && en, SOURCE + ' 必须同时含 zh-CN 与 en 两个包（缺一个说明解析面过期了）');

  // ---------- 夹具自证：三条断言都不许「因为集合是空的」而恒真 ----------
  assert.ok(zh.size > 500, '夹具自证：zh 包条数 ' + zh.size + '（>500 才算真解析到包）');
  assert.ok(
    concatenated >= 3,
    '夹具自证：`+` 拼接的词条确实被折进来了（实得 ' +
      concatenated +
      ' 条）—— 为 0 说明折叠分支没走到，拼接词条会被静默跳过',
  );

  // ---------- ① 同键 ----------
  const onlyZh = [...zh.keys()].filter((key) => !en.has(key));
  const onlyEn = [...en.keys()].filter((key) => !zh.has(key));
  assert.equal(
    onlyZh.length + onlyEn.length,
    0,
    '两包必须一一对应 —— 少一条就会在切语言时静默回落中文（界面看不出是缺词条）：' +
      (onlyZh.length ? '【只有中文有】' + onlyZh.join('、') : '') +
      (onlyEn.length ? '【只有英文有】' + onlyEn.join('、') : ''),
  );

  // ---------- ② 同占位符 ----------
  const unfoldable = [];
  const mismatched = [];
  let withPlaceholders = 0;
  for (const key of zh.keys()) {
    const zhText = zh.get(key);
    const enText = en.get(key);
    if (zhText === null || enText === null) {
      unfoldable.push(key + '（' + (zhText === null ? '中文' : '英文') + '侧折不动）');
      continue;
    }
    const zhPh = placeholdersOf(zhText);
    const enPh = placeholdersOf(enText);
    if (zhPh !== enPh) mismatched.push(key + '（中：{' + (zhPh || '无') + '} / 英：{' + (enPh || '无') + '}）');
    if (zhPh) withPlaceholders += 1;
  }
  assert.equal(
    unfoldable.length,
    0,
    '词条值必须是字面量或 `+` 拼接 —— 折不动就会被这条对账**静默跳过**（假绿），请改写成字面量：' +
      unfoldable.join('、'),
  );
  assert.ok(
    withPlaceholders >= 30,
    '夹具自证：真比过占位符的键只有 ' +
      withPlaceholders +
      ' 条（太少了，可能是 {name} 写法变了、判据正在空转）',
  );
  assert.equal(
    mismatched.length,
    0,
    '同一条词条在中英两包里的 {占位符} 必须一致 —— 英文模板漏一个 {err}，「失败」就说不出原因，且只在英文界面复现：' +
      mismatched.join('、'),
  );

  // ---------- ③ 英文包里不许有中文 ----------
  const leaked = [...en]
    .filter(([key, text]) => hasCjk(text) && !EN_CJK_ALLOWED.includes(key))
    .map(([key]) => key);
  assert.equal(
    leaked.length,
    0,
    '英文包里混进了中文（漏翻译最常见的形状）—— 确实该保留中文的请加进 EN_CJK_ALLOWED 并写明理由：' +
      leaked.join('、'),
  );
  // 白名单自己也要防过期：键改名 / 该条改成英文之后，白名单会退化成「永远不命中」的豁免，
  // 判据在悄悄放宽 —— 所以豁免项必须**仍然是因为含中文而被豁免**。
  const staleExemptions = EN_CJK_ALLOWED.filter((key) => !(en.has(key) && hasCjk(en.get(key))));
  assert.equal(
    staleExemptions.length,
    0,
    'EN_CJK_ALLOWED 里有失效项（键已不存在，或该条已经不含中文）—— 白名单没跟着改，正在偷偷放宽判据：' +
      staleExemptions.join('、'),
  );

  // ---------- ④ `data-i18n` 的挂载位置（2026-10-09 补）----------
  // 🔴 为什么这条必须存在：`i18n.js#applyDom()` 对被翻译的元素执行 `el.textContent = val`。
  //    若 `data-i18n` 挂在 `<button>` 上、而按钮里还有 `<svg class="btn-icon">` 和
  //    `<span class="btn-label">`，那两个子节点会被**整棵删掉** ⇒ 图标永久消失。
  //    致命之处在于它**不崩、不报错**：属性在、类名在、键也在（本守护前三条全绿），
  //    只有真渲染出来或读 DOM 才看得见 —— 实测预览浮层 18 个按钮从上线起就没有图标。
  //    挂对了的样子见 `slideshowRandomBtn`：`data-i18n` 在 `span.btn-label` 上，`#icon-shuffle` 一直正常。
  const RENDERER_HTML = 'src/renderer/index.html';
  // 🔴 先剥 HTML 注释再扫（CONTRACTS 元规则③「结构断言不许读注释」）：
  //    上面那条规矩注释本身就写着 `` `<button>` `` / `` `<svg class="btn-icon">` `` 这些字样，
  //    不剥的话正则会把**注释里的示例**当成真按钮匹配进去 —— 实测就是这样凭空多出
  //    一个「匿名按钮挂了 preview.slideshow.play」，跟产品代码一点关系都没有。
  const html = fs.readFileSync(path.join(ROOT, RENDERER_HTML), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
  assert.ok(
    buttons.length > 100,
    '夹具自证：只解析到 <button> ' +
      buttons.length +
      ' 个（>100 才算真读到渲染层标记；太少说明匹配式过期、后面的判据正在空转）',
  );
  const iconLabelButtons = []; // 形状正确：`data-i18n` 在 span.btn-label 上（这类按钮共 N 个）
  const misplaced = []; // 形状错误：`data-i18n` 挂在 button 自己身上，会连图标一起删
  // ⚠️ 判据只对**确实挂了 `data-i18n`** 的按钮生效：另有 10 个图标按钮
  //    （`#randomPageBtn` / `#previewInfoToggle` / 各关闭键…）压根不需要翻译，
  //    要求它们也挂一份会把判据放宽到「恒红」，那等于没有守卫。
  for (const b of buttons) {
    const cut = b.indexOf('>');
    const attrs = b.slice(0, cut);
    const body = b.slice(cut + 1);
    if (!/class="btn-icon"/.test(body)) continue; // 只看「图标 + 文案」这种按钮
    const idM = /\sid="([^"]+)"/.exec(attrs);
    const who = idM ? '#' + idM[1] : '(无 id 的按钮)';
    const onButton = /\sdata-i18n="([^"]+)"/.exec(attrs);
    const labelM = /<span class="btn-label"[^>]*\sdata-i18n="([^"]+)"/.exec(body);
    if (onButton) misplaced.push(who + '（键=' + onButton[1] + '，需挪到 span.btn-label）');
    if (labelM) iconLabelButtons.push({ who, key: labelM[1] });
  }
  assert.equal(
    misplaced.length,
    0,
    '🔴 `data-i18n` 挂在 <button> 上会把它自己的图标和文案一起删掉（applyDom 走 textContent）' +
      '—— 图标会永久消失，而所有静态断言仍然全绿，请挪到该按钮的 `<span class="btn-label">` 上：' +
      misplaced.join('、'),
  );
  assert.ok(
    iconLabelButtons.length >= 15,
    '夹具自证：形状正确的「图标 + label」按钮只有 ' +
      iconLabelButtons.length +
      ' 个（<15 说明这批按钮被改没了或匹配式过期，上一条判据正在空转）',
  );

  // 图案不许写进文案：图标按钮的文案一旦以符号开头（`'⛶ 全屏'` / `'📂 位置'` / `'🗑 删除'` /
  // `'✓ 选'` 都真出现过），渲染出来就是「图标 + 符号」两份图案。历史上这些符号正是为了
  // 掩盖上面那条失效才被塞进词条的，所以在根治之后必须**一起**收回。
  // 判据 = 必须以字母或数字开头（含 CJK）；`slideshowToggleBtn` 不在本判据里 ——
  // 它没有 `.btn-icon`，状态图案（`▶ 播放` / `⏸ 暂停`）本来就该由文案承载。
  const symbolPrefixed = iconLabelButtons
    .filter((b) => {
      const val = zh.get(b.key);
      return typeof val === 'string' && !/^[\p{L}\p{N}]/u.test(val);
    })
    .map((b) => b.who + '（' + b.key + ' = ' + JSON.stringify(zh.get(b.key)) + '）');
  assert.equal(
    symbolPrefixed.length,
    0,
    '图标按钮的文案以符号开头 ⇒ 界面上会出现两份图案（`<svg>` 一份 + 文字一份），' +
      '图案请只留给 `<svg class="btn-icon">`：' +
      symbolPrefixed.join('、'),
  );

  console.log(
    '[i18n-pack-regression] PASS（中英各 ' +
      zh.size +
      ' 条；带占位符 ' +
      withPlaceholders +
      ' 条；豁免 ' +
      EN_CJK_ALLOWED.length +
      ' 条；图标按钮挂载 ' +
      iconLabelButtons.length +
      ' 个）',
  );
}

/**
 * 本守护自己的登记（本仓惯例）：漏登记 = 它永远不会跑，而它自己不会报错 ——
 * 「守护没跑」和「守护通过」在套件里长得一样。
 */
function assertRegistered() {
  const runSrc = fs.readFileSync(path.join(ROOT, 'scripts/run-regressions.js'), 'utf8');
  assert.ok(runSrc.includes("'i18n-pack-regression.js'"), '本守护已登记进 scripts/run-regressions.js');
}

assertRegistered();
run();
