'use strict';
/**
 * 日期 / 星期的本地化回归 —— `i18n.js#formatDate` / `#formatWeekday`
 * 与 `utils.js#formatDateLabel` / `#getWeekday` 的转发链。
 *
 * 为什么单独守：
 *   1. 日期是**唯一不过词条表**的本地化面 —— `10月8日` → `Oct 8` 要换月名与语序，
 *      不是 `M[key]` 能表达的（当年正因如此才把它记成「独立主题」）⇒ 它走 `Intl`，
 *      于是「中英两包逐条对齐」那套守护（`i18n-pack-regression`）**完全管不到它**。
 *   2. 它有两个**静默**失效点，症状都只在英文界面、或只在别的时区才现形：
 *      · formatter 缓存 key 里漏了 `current` ⇒ 切到英文仍命中中文那份
 *        （**切回去再看又是对的**，所以极难发现）；
 *      · 没钉 `timeZone: 'UTC'` ⇒ 负时区下 `2026-10-08` 被算成前一天（`Thu` → `Wed`）。
 *   3. `utils.js` 那层转发**顺序承重**：`I18n` 判断若写在 `RendererUtils` 兜底**之后**，
 *      等于永远走中文实现，而且一句报错、一行日志都没有。
 *   4. `app.js` 的接线（`RendererUtils.formatDateLabel || …`）**行为测不到** —— `app.js`
 *      一上来就摸真实 DOM / electron，没法整体加载 ⇒ 这条只能静态钉。
 *
 * ⚠️ 三个语言面各钉一遍（缺任一个，另一面坏了没人报）：
 *      `i18n.js` 的 `Intl` 派生 → `utils.js` 的转发 → `app.js` 的接线。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

/**
 * 浏览器式沙箱：`i18n.js` 与 `utils.js` 都以 `window` 为宿主，两个都跑在**同一个** context 里，
 * 这样测的就是**真接线**（`utils.js` 里那句 `global.I18n` 能不能拿到东西）。
 * `withI18n: false` 用来验「拿不到 `I18n` 时中文兜底还在」。
 */
function makeSandbox(options) {
  const withI18n = !options || options.withI18n !== false;
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  // `applyDom()` 要摸 `document`（`querySelectorAll` + `documentElement.setAttribute`）。
  sandbox.document = {
    documentElement: { setAttribute() {} },
    querySelectorAll: () => [],
  };
  vm.createContext(sandbox);
  if (withI18n) vm.runInContext(read('src/renderer/i18n.js'), sandbox, { filename: 'i18n.js' });
  vm.runInContext(read('src/renderer/utils.js'), sandbox, { filename: 'utils.js' });
  return sandbox;
}

/** 日期格式化面：三处显示点（日期侧栏标签 + 星期、路径栏、导航历史）都走这两个函数。 */
const DATE = '2026-10-08';
const AT_MONTH_EDGE = '2026-01-05'; // 单位数月 + 单位数日（补零 / 不补零的分界）
const WITH_TIME = '2026-10-08T13:31:00'; // 库里 `date_taken` 也可能是带时间的 ISO 串

function run() {
  // ---------------------------------------------------------------------------
  // 1. 真接线：`utils.js` 必须把本地化交给 `I18n`（而不是自己硬编码中文）
  // ---------------------------------------------------------------------------
  const box = makeSandbox();
  const I18n = box.I18n;
  const utils = box.RendererUtils;
  /** 没有 `I18n` 的沙箱：验「中文兜底还在」（`vm` 夹具走的就是这条）。 */
  const bare = makeSandbox({ withI18n: false });
  assert.ok(I18n, '夹具自证：沙箱里要能拿到 I18n（拿不到说明 i18n.js 没加载成功）');
  assert.ok(utils, '夹具自证：沙箱里要能拿到 RendererUtils');
  for (const name of ['formatDate', 'formatWeekday']) {
    assert.equal(typeof I18n[name], 'function', 'I18n 要导出 ' + name);
  }
  for (const name of ['formatDateLabel', 'getWeekday']) {
    assert.equal(typeof utils[name], 'function', 'RendererUtils 要导出 ' + name);
  }

  // ---------------------------------------------------------------------------
  // 1b. 「真接线」还有半条沙箱**测不到**：两个文件的宿主必须归到**同一个对象**。
  //    `i18n.js` 的 IIFE 传 `typeof window !== 'undefined' ? window : this`、`utils.js` 传 `window`
  //    ⇒ 渲染端两边都是 `window` ⇒ `utils.js` 里那句 `global.I18n` 才拿得到东西。
  //    ⚠️ 沙箱把 `window === sandbox === 上下文全局对象` 抹平了 ⇒ 两个文件各写各的宿主时
  //       沙箱**照样全绿**，而生产端会静默回落中文（典型的「静态全绿、线上失效」）。
  //    ⚠️ 这是「一处定名字、另一处引用同一个名字」那类契约 ⇒ **两侧各钉一次**（宿主 + 加载顺序）。
  //       将来要换成 `globalThis` 之类，**两处必须同改**，别只改一侧。
  // ---------------------------------------------------------------------------
  // 判据收在**文件收尾那一句**上（不是「文件里出现过」）：`i18n.js` 用带 `typeof` 的写法、
  // `utils.js` 直传 `window`，两种在浏览器里都归到 `window` ⇒ 都算合规。
  // ⚠️ 别把这句写成「以 `})(window);` 开头」的正则（`^` 配 `[\s\S]*$` 方向是反的）——
  //    第一版就是这么写的，基线当场红；用 `trimEnd().endsWith(...)` 最不容易写反。
  const HOST_FORMS = ['})(window);', "})(typeof window !== 'undefined' ? window : this);"];
  const hostOf = (src) => HOST_FORMS.find((form) => src.trimEnd().endsWith(form)) || null;
  assert.ok(
    hostOf(read('src/renderer/i18n.js')),
    'i18n.js 的 IIFE 宿主必须是 window（或等价的 window 判定），且出现在文件收尾 —— ' +
      '它导出的 `I18n` 就挂在这个宿主上',
  );
  assert.ok(
    hostOf(read('src/renderer/utils.js')),
    'utils.js 的 IIFE 宿主必须与 i18n.js 是**同一个对象**（`window`）—— ' +
      '否则那句 `global.I18n` 在生产端恒为 undefined，而沙箱里看不出来（沙箱中 window === 全局对象）',
  );
  const rendererHtml = read('src/renderer/index.html');
  const i18nTagAt = rendererHtml.indexOf('<script src="i18n.js">');
  const utilsTagAt = rendererHtml.indexOf('<script src="utils.js">');
  assert.ok(
    i18nTagAt >= 0 && utilsTagAt >= 0 && i18nTagAt < utilsTagAt,
    'index.html 里 i18n.js 必须**早于** utils.js 加载（`utils.js` 的注释把它写成前提；' +
      '反序时首帧那段 `global.I18n` 拿不到东西 ⇒ 静默回落中文）',
  );

  // ---------------------------------------------------------------------------
  // 2. 中文侧：必须与改造前的硬编码**逐字节相同**（中文界面零视觉变化）
  // ---------------------------------------------------------------------------
  I18n.setLocale('zh-CN');
  assert.equal(utils.formatDateLabel(DATE), '10月8日', '中文日期标签');
  assert.equal(utils.getWeekday(DATE), '周四', '中文星期');
  // 🔴 这一条**不是**「与旧实现一致」——旧实现是 `parts[1] + '月' + parseInt(parts[2], 10) + '日'`
  //    这种字符串拼接，单位数月会把前导零原样带出来 ⇒ 旧输出 `01月5日`。
  //    `Intl` 的中文月名本来就是 `1月` ⇒ 新输出 `1月5日`。这是本批**唯一**一处中文可见变化，
  //    而且是**有意**的（`01月5日` 谁看都别扭）⇒ 所以在这里**显式钉住**：
  //    将来有人「顺手」把补零加回来，这条要红，而不是让口径悄悄漂回去。
  assert.equal(
    utils.formatDateLabel(AT_MONTH_EDGE),
    '1月5日',
    '中文单位数月不补零（旧实现是 01月5日，这是有意改掉的）',
  );
  assert.equal(utils.getWeekday(AT_MONTH_EDGE), '周一');
  assert.equal(utils.formatDateLabel(WITH_TIME), '10月8日', '带时间的 ISO 串取日期部分');

  // ---------------------------------------------------------------------------
  // 3. 英文侧：出英文，且**零 CJK**（这就是本轮的用户可见目标）
  // ---------------------------------------------------------------------------
  I18n.setLocale('en');
  assert.equal(utils.formatDateLabel(DATE), 'Oct 8', '英文日期标签');
  assert.equal(utils.getWeekday(DATE), 'Thu', '英文星期');
  assert.equal(utils.formatDateLabel(AT_MONTH_EDGE), 'Jan 5');
  assert.equal(utils.getWeekday(AT_MONTH_EDGE), 'Mon');
  for (const [name, value] of [
    ['日期标签', utils.formatDateLabel(DATE)],
    ['星期', utils.getWeekday(DATE)],
  ]) {
    assert.ok(
      !/[\u3400-\u9fff]/.test(value),
      '英文界面的' + name + '不许出现中文，实际：' + value,
    );
  }

  // ---------------------------------------------------------------------------
  // 4. 切语言往返 —— 钉「formatter 缓存 key 含 `current`」
  //    漏了它：切到英文仍命中中文那份（切回去又正常），是**最难发现**的一类。
  // ---------------------------------------------------------------------------
  I18n.setLocale('zh-CN');
  assert.equal(utils.formatDateLabel(DATE), '10月8日', '切回中文要归位');
  assert.equal(utils.getWeekday(DATE), '周四', '切回中文星期要归位');
  I18n.setLocale('en');
  assert.equal(utils.formatDateLabel(DATE), 'Oct 8', '再切英文要归位');
  assert.equal(utils.getWeekday(DATE), 'Thu', '再切英文星期要归位');

  // ---------------------------------------------------------------------------
  // 5. 时区无关（🔴 含判据自身的夹具自证 —— 不证明「本进程真能测出时区差异」，
  //    下面那两条就可能是恒真的）
  // ---------------------------------------------------------------------------
  const savedTzRaw = process.env.TZ;
  // ⚠️ 复位**不能用 `delete process.env.TZ`**：实测删掉之后 Node **不会**重新解析默认时区，
  //    后续所有 `Date` / `Intl` 仍在被污染的时区里跑（本守护第一版就是这么假红了一条）。
  //    必须显式赋回一个具体时区，这里取进入前的那个。
  const savedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    process.env.TZ = 'America/New_York'; // UTC-4：`Date.UTC(2026,9,8)` 会落到 10-07
    const naive = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(
      new Date(Date.UTC(2026, 9, 8)),
    );
    assert.equal(
      naive,
      'Wed',
      '夹具自证：NY 下一个**没钉** timeZone 的 formatter 应当给出前一天（实得 ' +
        naive +
        '）—— 若这里是 Thu，说明本进程的 Intl 不读 TZ，下面那条时区断言等于没测',
    );
    // 🔴 **必须用新建的沙箱**：`Intl.DateTimeFormat` 的时区是**构造时**定下的，
    //    上面那个沙箱里的 formatter 早就在原时区下建好了 ⇒ 它「在 NY 下也对」是**白拿的**
    //    （就算源码里根本没钉 `timeZone`，缓存那份照样给出 Thu = 假绿）。
    //    新建沙箱 ⇒ 缓存是空的 ⇒ formatter 在 NY 下构造 ⇒ 没钉 UTC 就会算出前一天。
    const fresh = makeSandbox();
    assert.equal(fresh.I18n.getLocale(), 'zh-CN', '夹具自证：新沙箱默认中文');
    fresh.I18n.setLocale('en');
    assert.equal(fresh.RendererUtils.getWeekday(DATE), 'Thu', '负时区下星期不许回退一天（要钉 timeZone: UTC）');
    assert.equal(fresh.RendererUtils.formatDateLabel(DATE), 'Oct 8', '负时区下日期不许回退一天');
    fresh.I18n.setLocale('zh-CN');
    assert.equal(fresh.RendererUtils.getWeekday(DATE), '周四', '中文侧同样时区无关');
    assert.equal(fresh.RendererUtils.formatDateLabel(DATE), '10月8日');
    // 兜底那份中文实现（没有 I18n 时）也一样：旧实现用 `new Date(str)` + `getDay()`，
    // 在负时区会把 10-08 算成周三 —— 那就出现「日期写 10月8日、星期写 周三」的自相矛盾。
    assert.equal(
      bare.RendererUtils.getWeekday(DATE),
      '周四',
      '中文兜底也要时区无关（旧实现在这里是 周三）',
    );
    assert.equal(bare.RendererUtils.formatDateLabel(DATE), '10月8日');
  } finally {
    process.env.TZ = savedTzRaw === undefined ? savedZone : savedTzRaw;
  }
  assert.equal(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    savedZone,
    '复位自证：默认时区要还原成 ' + savedZone + '（否则后面所有 Date / Intl 断言都在污染下跑）',
  );

  // ---------------------------------------------------------------------------
  // 6. 解不出的输入：不许崩、不许输出 `undefined月NaN日` / `undefined`
  //    （旧实现在这两处是坏的，本批顺手修掉 —— 所以这里钉住新口径）
  // ---------------------------------------------------------------------------
  assert.equal(utils.formatDateLabel(''), '', '空值仍返回空串');
  assert.equal(utils.getWeekday(''), '', '空值的星期返回空串（旧实现会给出 undefined）');
  I18n.setLocale('en');
  assert.equal(utils.formatDateLabel(''), '', '英文侧空值同样返回空串');
  assert.equal(utils.getWeekday(''), '');
  assert.equal(utils.formatDateLabel('abc'), 'abc', '解不出的串**原样返回**，不拼出 NaN 日期');
  assert.equal(utils.getWeekday('abc'), '', '解不出的串星期给空串');
  assert.equal(
    utils.formatDateLabel('2026-02-30'),
    '2026-02-30',
    '不存在的日期原样返回 —— `Date` 会把它静默滚成 3 月 2 日，宁可显示原始值也不改日期',
  );
  assert.equal(utils.getWeekday('2026-02-30'), '', '不存在的日期不给星期，而不是给 3 月 2 日的星期');
  I18n.setLocale('zh-CN');

  // ---------------------------------------------------------------------------
  // 7. `utils.js` 自己的中文兜底必须还在（拿不到 `I18n` 时唯一的退路）
  //    `vm` 夹具、以及「i18n.js 万一没加载」都走这条路。
  // ---------------------------------------------------------------------------
  assert.equal(bare.I18n, undefined, '夹具自证：这个沙箱里确实没有 I18n');
  assert.equal(bare.RendererUtils.formatDateLabel(DATE), '10月8日', '没有 I18n 时回落到中文实现');
  assert.equal(bare.RendererUtils.getWeekday(DATE), '周四', '没有 I18n 时星期也回落中文');
  // ⚠️ 兜底与 `I18n` 那条路**必须给出同一串**：两条路分叉时的症状只在「`i18n.js` 没加载」
  //    时才现形（生产路径永远走 `I18n`）⇒ 分叉会一直埋伏着。所以这里逐条对齐 ·
  //    「单位数月不补零」正是本批改掉的那一处（旧兜底给 `01月5日`）。
  assert.equal(
    bare.RendererUtils.formatDateLabel(AT_MONTH_EDGE),
    '1月5日',
    '兜底也要不补零 —— 与 I18n 那条路给出同一串（旧兜底是 01月5日）',
  );
  assert.equal(bare.RendererUtils.formatDateLabel(WITH_TIME), '10月8日', '兜底同样要认带时间的 ISO 串');
  assert.equal(
    bare.RendererUtils.formatDateLabel('abc'),
    'abc',
    '兜底对解不出的串也原样返回（旧兜底会拼出 undefined月NaN日）',
  );
  assert.equal(bare.RendererUtils.formatDateLabel(''), '', '兜底实现同样要处理空值');

  // ---------------------------------------------------------------------------
  // 8. `app.js` 的接线（行为测不到 ⇒ 静态钉）
  //    `formatDateLabel` 只出现在日期侧栏 / 路径栏 / 导航历史三处，全都要经 utils 的转发。
  // ---------------------------------------------------------------------------
  const appSrc = read('src/renderer/app.js');
  for (const name of ['formatDateLabel', 'getWeekday']) {
    assert.match(
      appSrc,
      new RegExp('RendererUtils\\.' + name + '\\s*\\|\\|'),
      'app.js 的 ' + name + ' 必须仍转发到 RendererUtils（那是本地化的真相源）',
    );
  }

  // ---------------------------------------------------------------------------
  // 9. 换语言后日期侧栏要**重画**（结构判据：判「在 localechange 监听器体内」，
  //    不是「文件里出现过 loadDateGroups」）
  // ---------------------------------------------------------------------------
  const appAst = acorn.parse(appSrc, { ecmaVersion: 'latest', sourceType: 'script' });
  const listenerBodies = [];
  walk(appAst, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    let method = null;
    if (callee && callee.type === 'MemberExpression' && callee.property)
      method = callee.property.name;
    else if (callee && callee.type === 'Identifier') method = callee.name;
    if (method !== 'addEventListener') return;
    const first = node.arguments[0];
    if (!first || first.type !== 'Literal' || first.value !== 'localechange') return;
    const handler = node.arguments[1];
    if (!handler || !handler.body) return;
    listenerBodies.push(handler.body);
  });
  assert.ok(
    listenerBodies.length >= 1,
    '夹具自证：app.js 里要能收到 localechange 的**函数体形式**监听器（实得 ' +
      listenerBodies.length +
      '）。⚠️ 计数不是「文件里 addEventListener("localechange") 的条数」——' +
      '`window.addEventListener(\'localechange\', syncQuickThemeTrigger)` 那种传**标识符**的' +
      '收不到函数体，这里刻意只收能取到体的那些',
  );
  const redrawsDates = listenerBodies.some((body) => {
    let found = false;
    walk(body, (node) => {
      if (found || node.type !== 'CallExpression') return;
      const callee = node.callee;
      if (callee && callee.type === 'Identifier' && callee.name === 'loadDateGroups') found = true;
    });
    return found;
  });
  assert.ok(
    redrawsDates,
    '换语言后日期侧栏必须重画：某个 localechange 监听器的**函数体内**要调 loadDateGroups() ' +
      '—— 日期标签是渲染时拼出来的（`applyDom` 只管 data-i18n 静态节点），漏了这条' +
      '就要等用户切走再切回「日期」才跟着变',
  );

  // ---------------------------------------------------------------------------
  // 10. 本守护自己的登记（漏登记 = 永远不会跑，而它自己不会报错）
  // ---------------------------------------------------------------------------
  assert.ok(
    read('scripts/run-regressions.js').includes("'i18n-date-locale-regression.js'"),
    '本守护已登记进 scripts/run-regressions.js',
  );

  console.log('[i18n-date-locale-regression] PASS');
}

run();
