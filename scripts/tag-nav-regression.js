'use strict';

/**
 * 「标签导航页」回归守护。
 *
 * ## 守什么
 *
 * 这个页面横跨三层（主进程数据服务 / 桌面渲染层 / 网页端），而它最要命的失效方式
 * 全是**静默**的：
 *   · 父节点被「顺手」加上照片网格 ⇒ 索引铺满后几十秒主线程阻塞，界面像点了没反应；
 *   · `refreshLocale` 只重画不清缓存 ⇒ 切语言后展开的子树停在旧语言；
 *   · 搜索态变化不刷新主区 ⇒ 侧栏已经换成搜索结果，主区还停在旧卡片；
 *   · `api.getTagNavPhotos` 写成 IPC 频道名 ⇒ `call()` 拿到 undefined，静默失效；
 *   · 网页端资源路由 / SW 预缓存漏一条 ⇒ 404 而所有其它守护全绿。
 *
 * ## 不守什么
 *
 * 真库的**计数**（1752 个标签之类）—— 那会随索引重建漂移。数据层用**夹具库**
 * （按 `tag-index-store` 的 DDL 现建），只断言行为与排序，不断言规模。
 *
 * @author CodeBuddy
 * @date 2026-10-09
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 结构断言用的源码视图：注释剥掉 —— 注释里写满了反面教材，读进去守护自己会红。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 前导 `:` / `'` / `"` / `\` 是保护：`https://` 这类字符串里的 `//` 不算注释起点。
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/**
 * HTML 也要剥注释，理由同 `stripComments`，而且这里真踩过：
 * `index.html` 里那条注释写着「网页端那份在 `web/css/tag-nav.css`」⇒
 * 「孤儿检查」拿 `html.indexOf('tag-nav.css')` 一搜就命中，**引用被摘掉了还判绿**。
 * 🔴 所以按**文本包含**判「有没有被引用」是不行的（注释/说明文字会替它作证）；
 *    结构断言必须用**解析出来的引用列表**（见 ⑤ 段），或先剥注释。
 */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 取 `function <name>(…)` 的函数体（到下一个顶层 `function ` 为止）。
 *
 * 🔴 不要用 `[\s\S]{0,400}` 这种**字符预算**去跨函数内的注释块：注释一长（本文件里
 * 最长的一段解释有 8 行）预算就不够，断言会以「函数里没有这句话」的形式红掉 ——
 * 那是**断言误报**，而修法很容易被误做成「放宽预算到 800」（下次再加两行注释又红）。
 */
function funcBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = src.indexOf('\nfunction ', start + 10);
  return src.slice(start, end < 0 ? src.length : end);
}

/**
 * 「标签搜索是**提交式**的」这条两端同形契约的**判据集**。
 *
 * 提到模块级是因为它要跑两遍 —— 桌面端与网页端是**两份独立实现**（网页端内联 `t(zh, en)`，
 * 不走 i18n.js），守卫各写一份必然漂：漂了以后只守得住一端，另一端「实时搜又回来了」照样全绿。
 *
 * ## 为什么拆成多条 `check()` 而不是一大条
 *
 * 一条 `check()` 里堆多个 `assert` 时**先红的会把后面的盖住**，而 `check()` 只打标题
 * ⇒ 标题只能代表第一条。牙齿验证的 `expect` 是按标题匹配的，粒度粗了就分不出
 * 「哪条契约破了」（只能看出「这一段里有东西破了」）。所以按契约面一条一条拆，
 * 每条标题自己说清楚红的是什么。
 *
 * `opts.leave`：网页端多一个「离开标签页」出口（桌面端没有），那边要多守一条 ——
 * `keyword` 清了、`lastQuery` 没清 = 两者失同步，下次进页会拿着上一轮的词自己搜起来。
 *
 * ⚠️ 传进来的 `src` 必须是**剥过注释**的（本文件的 `ui` / `mod` 都是）：这些断言里有大量
 *    反面形状（`!SEARCH_DEBOUNCE_MS`），而两边源码的注释里正写着「以前是防抖…」。
 */
function submitSearchChecks(src, who, opts) {
  opts = opts || {};
  const at = (name, fn) => check(who + '：' + name, fn);
  let ok = true;

  ok = at('搜索只由显式提交发起（防抖必须干净退场，input 事件里不许有 runSearch）', () => {
    // 防抖那套（`input` ⇒ 定时器 ⇒ `runSearch`）在「非实时」下是**错的实现**：
    // 它仍然是「边打边搜」，只是把频率压低了。
    assert.ok(!/SEARCH_DEBOUNCE_MS/.test(src), '还留着搜索防抖常量');
    assert.ok(!/searchTimer/.test(src), '还留着搜索定时器');
    assert.ok(
      !/setTimeout\([\s\S]{0,200}runSearch/.test(src),
      '搜索路径里还有 setTimeout ⇒ 还是「停一会儿自己搜」，不是提交式',
    );
    const bind = /function bindSidebarEvents\(\) \{([\s\S]*?)\n {4}\}/.exec(src);
    assert.ok(bind, 'bindSidebarEvents 不见了');
    const onInput = /addEventListener\('input'[\s\S]{0,160}?\}\)/.exec(bind[1]);
    assert.ok(onInput, '找不到 input 事件监听');
    assert.ok(!/runSearch/.test(onInput[0]), 'input 事件里还在发搜索 ⇒ 实时搜又回来了');
    // 而它**必须**更新输入态：`keyword` 与清除叉的显隐都靠这里（提交时要拿 `keyword` 去搜）。
    assert.ok(/onKeywordInput\(input\.value\)/.test(onInput[0]), 'input 事件没更新 keyword');
  }) && ok;

  ok = at('提交必须有两条入口：回车 + 一个看得见的搜索按钮', () => {
    const bind = /function bindSidebarEvents\(\) \{([\s\S]*?)\n {4}\}/.exec(src);
    assert.ok(bind, 'bindSidebarEvents 不见了');
    assert.ok(/e\.key === 'Enter'[\s\S]{0,200}?submitSearch\(\)/.test(bind[1]), '没接回车提交');
    assert.ok(
      /#tagNavSearchSubmit[\s\S]{0,240}?addEventListener\('click'[\s\S]{0,120}?submitSearch\(\)/.test(bind[1]),
      '搜索按钮没绑提交（敲字没反应、又没出口 = 用户以为搜索坏了）',
    );
    assert.ok(/id="tagNavSearchSubmit"/.test(src), '没有搜索按钮的 DOM —— 提交式搜索必须有一个看得见的出口');
    // 按钮与输入框两侧各钉一次（铁律 14：一处定义名字、另一处引用 ⇒ 两侧各钉一次）。
    // 样式侧由 `tag-nav-css` 那条分开守（桌面 / 网页各一份 CSS）。
    assert.ok(/tag-nav-submit/.test(src), '搜索按钮的类名不见了（样式会静默不命中）');
    const sub = /function submitSearch\(\) \{([\s\S]*?)\n {4}\}/.exec(src);
    assert.ok(sub, 'submitSearch 不见了');
    assert.ok(/exitSearch\(\)/.test(sub[1]), '空提交没走 exitSearch（另写一份清空逻辑必然漂）');
    assert.ok(/runSearch\(/.test(sub[1]), 'submitSearch 里没发搜索');
  }) && ok;

  ok = at('退出搜索必须作废在途代次（searchToken++），否则清空后被回包贴回来', () => {
    const exit = /function exitSearch\(\) \{([\s\S]*?)\n {4}\}/.exec(src);
    assert.ok(exit, 'exitSearch 不见了');
    assert.ok(
      /searchToken\+\+/.test(exit[1]),
      'exitSearch 没 `searchToken++` ⇒ 清空后在途回包把搜索结果贴回来，看起来「清不掉」',
    );
    assert.ok(/lastQuery = ''/.test(exit[1]), 'exitSearch 没清 lastQuery');
    assert.ok(/searchResult = null/.test(exit[1]), 'exitSearch 没清 searchResult');
    assert.ok(/refreshMainForSearch\(\)/.test(exit[1]), '清空 / 退出搜索没刷主区');
  }) && ok;

  ok = at('输入框删到空要立刻退出搜索态（不许等提交），且不许直接改 searchResult', () => {
    const onKw = /function onKeywordInput\(value\) \{([\s\S]*?)\n {4}\}/.exec(src);
    assert.ok(onKw, 'onKeywordInput 不见了');
    assert.ok(/keyword = String\(/.test(onKw[1]), 'onKeywordInput 没记下输入内容');
    assert.ok(/exitSearch\(\)/.test(onKw[1]), '清空输入框没退出搜索态');
    assert.ok(
      !/searchResult = /.test(onKw[1]),
      'onKeywordInput 直接改了 searchResult ⇒ 输入态与搜索态又搅在一起了',
    );
  }) && ok;

  ok = at('回包判据只看代次（不许拿 keyword 比），`lastQuery` 是唯一赋值点', () => {
    assert.ok(
      !/keyword\.trim\(\) !== q\.trim\(\)/.test(src),
      '回包判据还在拿 `keyword` 比 —— 提交式搜索下它会把**该显示的那份**回包丢掉 ⇒ 「按了回车没反应」',
    );
    assert.ok(
      /function runSearch\(q\) \{[\s\S]{0,200}?lastQuery = String\(q/.test(src),
      'runSearch 里没有 lastQuery 的唯一赋值 ⇒ 重搜点判据悬空',
    );
  }) && ok;

  ok = at('重搜点（切语言 / 改展示线）的判据必须是已提交的 lastQuery', () => {
    // 拿 `keyword` 判的话，「用户只是敲了几个字还没提交」也会被替他搜一次 —— 搜索态自己就开了。
    assert.ok(/if \(lastQuery\) void runSearch\(lastQuery\);/.test(src), '重搜点没改成判 lastQuery');
    assert.ok(
      !/if \(keyword\.trim\(\)\) void runSearch\(keyword\);/.test(src),
      '还有拿 keyword 当重搜判据的地方',
    );
  }) && ok;

  ok = at('重画后必须把焦点还给搜索框（否则回车搜一次之后输不进字）', () => {
    // 提交式搜索下按回车就要重画，而 `innerHTML` 一换焦点就被丢掉：
    // 想改关键词再搜一次的人第二下敲不进任何字 —— 界面看着没坏，只是没反应。
    assert.ok(/document\.activeElement === prevInput/.test(src), '重画前没记下搜索框有没有焦点');
    assert.ok(/nextInput\.focus\(\)/.test(src), '重画后没把焦点还给搜索框');
  }) && ok;

  if (opts.leave) {
    ok = at('离开标签页要同时清 keyword 与 lastQuery（只清一半 = 下次进页自己搜起来）', () => {
      const leave = /function leave\(\) \{([\s\S]*?)\n {4}\}/.exec(src);
      assert.ok(leave, 'leave 不见了');
      assert.ok(
        /keyword = ''[\s\S]{0,160}lastQuery = ''/.test(leave[1]),
        'leave 只清了 keyword、没清 lastQuery ⇒ 下次进页按旧词自己搜',
      );
      assert.ok(/searchToken\+\+/.test(leave[1]), 'leave 没作废在途搜索代次');
    }) && ok;
  }

  return ok;
}

/**
 * 取**一条** CSS 规则的声明体。
 *
 * 🔴 必须按括号配平取，别用 `/[^{]*\{([^}]*)\}/` 那种非贪婪正则：`@media` 这类容器里
 *    有多条子规则，非贪婪会在**第一条子规则的 `}`** 处截断；而直接拿整个文件去 match
 *    更糟 —— 兄弟规则会替被测那条满足判据（判据恒真，删掉被测的真规则照样绿）。
 *    按选择器取到**那一条自己的声明体**，作用域才正好。
 */
function cssRuleBody(css, selectorRe) {
  const m = new RegExp(selectorRe.source + '\\s*\\{').exec(css);
  if (!m) return '';
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  return '';
}

/**
 * 「搜索框那一行」的两侧类名对齐：JS 里用的类名，CSS 里必须**真的有那条规则**。
 *
 * 铁律 14：一处定义名字、另一处引用同一个名字 ⇒ 两侧各钉一次。只钉 JS 侧的话，
 * CSS 里把 `.tag-nav-submit` 写成 `.tag-nav-submit-x`（或整条规则漏掉）**两侧都绿**，
 * 而地上面只是一颗没样式的原生按钮 —— 没有任何报错、没有任何断言会红。
 *
 * `prefix`：桌面端 `tag-nav` / 网页端 `web-tag-nav`（两端的类名刻意不共用）。
 */
function submitSearchCssChecks(cssRel, prefix, who) {
  let ok = true;
  ok =
    check(who + ' CSS：搜索框那一行的布局规则真的存在（按钮/输入框的类名两侧对齐）', () => {
      const css = stripComments(read(cssRel));
      assert.match(
        css,
        new RegExp('\\.' + prefix + '-submit(?![-\\w])'),
        'CSS 里没有提交按钮的规则 ⇒ 按钮裸成系统默认样式（JS 侧断言照样绿）',
      );
      assert.match(
        css,
        new RegExp('\\.' + prefix + '-search-field(?![-\\w])'),
        'CSS 里没有输入框那一层的锚点规则 ⇒ 内嵌的清空叉会相对外层定位、飘到提交按钮上',
      );
      const search = cssRuleBody(css, new RegExp('\\.' + prefix + '-search(?![-\\w])'));
      assert.ok(search, '取不到搜索框那一行的声明体');
      assert.match(
        search,
        /display:\s*flex/,
        '搜索框那一行不是 flex ⇒ 提交按钮不会排在输入框右边（会掉到下一行或压在输入框上）',
      );
    }) && ok;
  // 提交按钮必须与输入框**等高**，否则那一行会被撑高、或按钮比输入框矮一截。
  ok =
    check(who + ' CSS：提交按钮与输入框等高（不同高会把那一行撑歪）', () => {
      const css = stripComments(read(cssRel));
      const inputH = /height:\s*(\d+)px/.exec(cssRuleBody(css, new RegExp('\\.' + prefix + '-input(?![-\\w])')));
      const btnH = /height:\s*(\d+)px/.exec(cssRuleBody(css, new RegExp('\\.' + prefix + '-submit(?![-\\w])')));
      assert.ok(inputH && btnH, '取不到输入框 / 提交按钮的高度');
      assert.equal(btnH[1], inputH[1], '提交按钮高度(' + btnH[1] + ')与输入框(' + inputH[1] + ')不一致');
    }) && ok;
  return ok;
}

function check(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    return true;
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + String((e && e.message) || e).split('\n')[0]);
    return false;
  }
}

// ====================================================================
// ① 数据层：夹具库（真 DDL、真 tagIdOf），断言**行为**而不是规模
// ====================================================================
function buildFixture(aiDir) {
  fs.mkdirSync(aiDir, { recursive: true });
  const db = new Database(path.join(aiDir, 'tag-index.sqlite'));
  db.exec(`
    CREATE TABLE tag_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tag_vocab (tag_id INTEGER PRIMARY KEY, tag TEXT UNIQUE NOT NULL);
    CREATE TABLE tag_photo (photo_id INTEGER PRIMARY KEY, source_spec TEXT NOT NULL, engine TEXT NOT NULL, tagged_at INTEGER NOT NULL);
    CREATE TABLE photo_tag (photo_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, score INTEGER NOT NULL, PRIMARY KEY (photo_id, tag_id)) WITHOUT ROWID;
    CREATE INDEX idx_tag_score ON photo_tag(tag_id, score DESC);
  `);
  const { tagIdOf } = require(path.join(ROOT, 'src/ai/tag-index-store.js'));
  const { labels } = require(path.join(ROOT, 'src/ai/tag-labels.js'));
  const insVocab = db.prepare('INSERT INTO tag_vocab (tag_id, tag) VALUES (?, ?)');
  const insPT = db.prepare('INSERT INTO photo_tag (photo_id, tag_id, score) VALUES (?, ?, ?)');
  // 夹具内容：black_hair / long_hair 各 3 张（score 递减，用来钉排序），
  // skirt 1 张，miko 0 张（在词表里但没进索引 ⇒ 导航页**不**显示它）。
  // blue_hair **只有展示线以下的行**（score 20 < 35）—— 它进了索引（在 `tag_vocab` 里），
  // 但点进去什么都没有 ⇒ 导航页与搜索都**不许**把它列出来（钉「0 命中的标签不进列表」）。
  // 复用 photo 1：一张图可以同时有一个高分标签和一个低分标签，这正是真实的分布。
  const plan = [
    ['black_hair', [[1, 900], [2, 800]]],
    ['long_hair', [[2, 950], [4, 850], [5, 100]]],
    ['skirt', [[6, 600]]],
    ['blue_hair', [[1, 20]]],
  ];
  for (const [tag, rows] of plan) {
    const id = tagIdOf(tag);
    assert.ok(id !== null && id !== undefined, '夹具标签 ' + tag + ' 必须在标签表里');
    insVocab.run(id, tag);
    for (const [photoId, score] of rows) insPT.run(photoId, id, score);
  }
  // tag_photo 是「已打标的照片」清单（status().photos = COUNT(*)），与 photo_tag 分开
  const insTP = db.prepare('INSERT INTO tag_photo (photo_id, source_spec, engine, tagged_at) VALUES (?, ?, ?, ?)');
  for (const pid of [1, 2, 4, 5, 6]) insTP.run(pid, 'probe', 'joytag', 0);
  // miko：词表里有、索引里没有 —— 导航页的唯一判据是 tag_vocab（见 tag-nav.js#indexedTags）
  assert.ok(typeof labels()[tagIdOf('miko')] === 'string', 'miko 应在标签表里');
  db.close();
}

function dataLayer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-nav-reg-'));
  let ok = true;
  try {
    buildFixture(path.join(tmp, 'ai-search'));
    const { TagNav } = require(path.join(ROOT, 'src/main/tag-nav.js'));
    const nav = new TagNav(path.join(tmp, 'ai-search'));

    ok = check('status() 读得到夹具库', () => {
      const s = nav.status();
      assert.equal(s.available, true, 'available 必须为 true（读不到会静默降级成 false）');
      assert.equal(
        s.tags,
        4,
        'tag_vocab 行数 = 已进索引的标签数（blue_hair 也在里面 —— 它只是**低于展示线**，不是没进索引）',
      );
      assert.equal(s.photos, 5, 'tag_photo 行数 = 打过标的照片数');
    }) && ok;

    ok = check('tree() 带兜底名 + 两档计数（tagTotal / tagIndexed）', () => {
      const tree = nav.tree();
      assert.ok(Array.isArray(tree) && tree.length >= 10, '顶层分类数不对');
      for (const c of tree) {
        assert.ok(c.id && typeof c.label === 'string' && c.label.length, '分类 ' + c.id + ' 缺兜底名（缺了界面会渲染机器 id）');
        assert.ok(Array.isArray(c.subs) && c.subs.length, '分类 ' + c.id + ' 没有子类');
        for (const s of c.subs) {
          assert.ok(typeof s.label === 'string' && s.label.length, '子类 ' + s.id + ' 缺兜底名');
          assert.equal(typeof s.tagTotal, 'number', '子类 ' + s.id + ' 缺 tagTotal');
          assert.equal(typeof s.tagIndexed, 'number', '子类 ' + s.id + ' 缺 tagIndexed');
          assert.ok(s.tagIndexed <= s.tagTotal, '子类 ' + s.id + ' 的 indexed 大于 total');
        }
      }
      const hair = tree.flatMap((c) => c.subs).find((s) => s.id === 'hair');
      assert.ok(hair, 'hair 子类不存在');
      assert.equal(hair.tagIndexed, 3, 'hair 下有 3 个标签进了索引（black_hair / long_hair / blue_hair）');
      // ⚠️ `tagIndexed` 是**索引覆盖**口径（与展示线无关），所以它会**大于**展开后看到的行数 ——
      //    那是设计如此：界面正是靠这个差来区分「没索引」与「都低于展示线」。
    }) && ok;

    ok = check('node() 只回已索引的标签、按命中数降序、name 按 locale', () => {
      const zh = nav.node('hair', 'zh-CN');
      assert.equal(zh.tags.length, 2, 'hair 应只有 2 个已索引标签');
      assert.deepEqual(
        zh.tags.map((t) => t.tag),
        ['long_hair', 'black_hair'],
        '必须按命中数降序（950 > 900）',
      );
      assert.equal(zh.tags[1].count, 2, '命中数来自倒排聚合');
      const en = nav.node('hair', 'en');
      assert.equal(en.tags[0].name, 'long_hair', 'locale=en 时 name 必须是英文原文');
      // 中文名来自 tag-zh 映射表；夹具不给它兜底成机器 id 就行
      assert.ok(zh.tags[0].name && zh.tags[0].name !== 'long_hair', 'locale=zh 时 name 不该回英文原文');
    }) && ok;

    ok = check('node() 对未知节点返回空结构，绝不抛', () => {
      const out = nav.node('不存在的节点', 'zh-CN');
      assert.deepEqual(out, { tags: [], total: 0, indexed: 0 });
    }) && ok;

    ok = check('🔴 展示线以下（0 命中）的标签不进列表 —— 且必须能靠调低展示线把它调回来', () => {
      /**
       * 这条钉的是「标签 0 的词不需要展示出来」（2026-10-09 用户要求）。
       *
       * 🔴 **必须有反向那一半**：只断言「blue_hair 不在列表里」是**假绿温床** ——
       *    把 `node()` 的过滤删掉、改成「不在 `tag_vocab` 里就跳过」、甚至把夹具标签名
       *    打错一个字母，这条断言全都照样绿。反向那半（把线调到入库线，它必须回来）
       *    才证明「看不见」的原因是**展示线**而不是「它压根不在候选里」。
       */
      const zh = nav.node('hair', 'zh-CN');
      assert.equal(zh.indexed, 3, 'hair 的候选里有 3 个进了索引 —— 这个数不受展示线影响');
      assert.deepEqual(
        zh.tags.map((t) => t.tag),
        ['long_hair', 'black_hair'],
        'blue_hair 只有 score=20 的行（< 展示线 35）⇒ 不许出现在列表里；剩下两个按命中数降序',
      );
      assert.ok(
        zh.tags.every((t) => t.count > 0),
        '列表里任何一项的命中数都必须 > 0（界面上「点进去什么都没有」的死节点就是这么来的）',
      );
      // 反向：把展示线调到入库线（0.15）—— blue_hair 必须回来。这一半才是「线在管事」的证据。
      const { STORE_MIN_SCORE } = require(path.join(ROOT, 'src/ai/tag-index-store.js'));
      const navLow = new TagNav(path.join(tmp, 'ai-search'), {
        displayMinScore: () => STORE_MIN_SCORE,
      });
      const low = navLow.node('hair', 'zh-CN');
      assert.deepEqual(
        low.tags.map((t) => t.tag).sort(),
        ['black_hair', 'blue_hair', 'long_hair'],
        '线降到入库线后 blue_hair 必须回来 ⇒ 它被滤掉的原因是展示线，不是「不在候选里」',
      );
      assert.equal(
        low.tags.find((t) => t.tag === 'blue_hair').count,
        1,
        '调低线之后命中数要如实（1 张）—— 顺带证明这条路真的读到了那些低分行',
      );
    }) && ok;

    ok = check('🔴 搜索同样不吐 0 命中的标签，但 `indexed` 要如实报「匹配到几个」', () => {
      // 与 node() 同一条过滤，反过来也必须能调回来（理由同上）。
      const hit = nav.search('blue_hair', 'zh-CN');
      assert.deepEqual(hit.tags, [], 'blue_hair 只在展示线下 ⇒ 搜索结果里不许出现（否则点开是空网格）');
      assert.equal(
        hit.indexed,
        1,
        '`indexed` 必须是**过滤前**的命中数：界面靠它区分「没搜到」与「搜到了但都低于展示线」——' +
          '报 0 会让这句提示退化成「没有匹配的标签」，用户就会去改关键词而不是改展示线',
      );
      const { STORE_MIN_SCORE } = require(path.join(ROOT, 'src/ai/tag-index-store.js'));
      const navLow = new TagNav(path.join(tmp, 'ai-search'), {
        displayMinScore: () => STORE_MIN_SCORE,
      });
      const low = navLow.search('blue_hair', 'zh-CN');
      assert.equal(low.tags.length, 1, '线降到入库线后必须搜得到 blue_hair');
      assert.equal(low.tags[0].count, 1, '命中数要如实');
      // 形状：空白关键词那条早退也要带 `indexed`（渲染层读的就是它，缺键会渲染出 undefined 个标签）
      assert.deepEqual(
        nav.search('   ', 'zh-CN'),
        { tags: [], nodes: [], indexed: 0 },
        '空白关键词必须回空（含 indexed）',
      );
      assert.deepEqual(nav.search('', 'zh-CN'), { tags: [], nodes: [], indexed: 0 }, '空串同上');
    }) && ok;

    ok = check('search() 回带 node/category 的标签（渲染层没有分类表，全靠这两个字段）', () => {
      const res = nav.search('hair', 'zh-CN');
      const hit = res.tags.find((t) => t.tag === 'black_hair');
      assert.ok(hit, 'search("hair") 必须命中 black_hair');
      assert.equal(hit.node, 'hair', 'node 字段缺失 ⇒ 点击后无法把树展开到它');
      assert.equal(hit.category, 'appearance', 'category 字段缺失 ⇒ 无法展开顶层');
      assert.ok(res.nodes.some((n) => n.kind === 'sub' && n.id === 'hair'), '节点命中缺失');
      assert.ok(
        typeof res.indexed === 'number',
        'search() 必须回 `indexed`（过滤前的命中数）—— 渲染层的空态文案靠它分岔',
      );
    }) && ok;

    ok = check('rankedPhotoIds() 按 score 降序 + 分页 + 用展示线（不是入库线、不是查询线）', () => {
      const p1 = nav.rankedPhotoIds('long_hair', 1, 2);
      assert.equal(p1.total, 3, 'total 是展示线口径的总数');
      assert.equal(p1.ids.length, 2, 'pageSize 生效');
      const p2 = nav.rankedPhotoIds('long_hair', 2, 2);
      assert.deepEqual(p2.ids, [5], '第二页只剩 score=100 那张（顺序必须稳定）');
      const db = new Database(path.join(tmp, 'ai-search', 'tag-index.sqlite'));
      const { tagIdOf, DISPLAY_MIN_SCORE, STORE_MIN_SCORE } = require(
        path.join(ROOT, 'src/ai/tag-index-store.js'),
      );
      const line = Math.round(DISPLAY_MIN_SCORE * 100);
      // 正向：**刚过展示线**的行必须计入（夹具里其余行都是 600+，钉不出这条线在哪）。
      db.prepare('INSERT INTO photo_tag (photo_id, tag_id, score) VALUES (?, ?, ?)').run(
        9,
        tagIdOf('long_hair'),
        line + 5,
      );
      // 反向：线**以下**的行必须排除 —— 这才是「抬线」真正生效的那一半。
      // 只钉「刚过线的还在」是不够的：把 minScore 改回入库线 15，那条断言照样绿
      // （旧口径本来就会算它）⇒ 必须有线下的用例，否则抬没抬线守护看不出来。
      db.prepare('INSERT INTO photo_tag (photo_id, tag_id, score) VALUES (?, ?, ?)').run(
        7,
        tagIdOf('long_hair'),
        line - 5,
      );
      db.close();
      const after = nav.rankedPhotoIds('long_hair', 2, 2);
      assert.equal(after.total, 4, 'score=' + (line + 5) + '（刚过展示线）必须计入 total');
      assert.ok(after.ids.includes(9), 'score=' + (line + 5) + ' 的行必须在结果里（改用查询线 55 就漏了）');
      const below = nav.rankedPhotoIds('long_hair', 1, 50);
      assert.ok(
        !below.ids.includes(7),
        'score=' + (line - 5) + ' 在线下必须被排除 —— 改回入库线就会漏出来，那正是实测占 61% 的噪声行' +
          '（抽到的误报 `blue_sky` 0.22 / `cat` 0.21 全在这一段）',
      );
      assert.equal(below.total, 4, '线下的行不能进 total');
      // 🔴 两处**同口径**：卡片上的「N 张」必须 === 点进去的总数。
      // 这两个数分别由 `countsForTags` / `rankedPhotoIds` 给出；分数线一旦分家，
      // 界面会写着 A 张、点进去 B 张，而且**不报任何错**。
      const cardCount = nav.countsForTags(['long_hair']).get('long_hair');
      assert.equal(
        cardCount,
        below.total,
        'countsForTags 与 rankedPhotoIds 必须同口径（卡片写几张 ↔ 点进去有几张）',
      );
      assert.ok(DISPLAY_MIN_SCORE >= STORE_MIN_SCORE, '展示线必须 ≥ 入库线（低于入库线的行根本不存在）');
      // 上界：展示线不许高过查询线（0.55）。高过它就出现「导航点进去的图比搜得到的还少」——
      // 用户会以为标签页缺图，而这是配置出来的，不是数据如此。
      const { TAG_ROUTE_THRESHOLD } = require(path.join(ROOT, 'src/ai/tag-index-store.js'));
      assert.ok(
        DISPLAY_MIN_SCORE <= TAG_ROUTE_THRESHOLD,
        '展示线 ' + DISPLAY_MIN_SCORE + ' 高过了查询线 ' + TAG_ROUTE_THRESHOLD + '：导航会比搜索还严格，标签页看起来像缺图',
      );
    }) && ok;

    ok = check('🔴 展示线可调且**免重启生效**：换掉 getter 的返回值，同一个 nav 实例下一次查询就换口径', () => {
      /**
       * 这条是「设置可调，调了怎么生效」的**行为**牙齿 —— 结构断言（下面那条）只能证明
       * 「代码里有个 getter」，证明不了「每次查询都重新读它」。两种典型写错法都只会被这条抓住：
       *   · 构造函数里把 `displayMinScore()` 的结果存成字段（缓存）⇒ 设置改了要重启；
       *   · 只在某一处现取（比如 `rankedPhotoIds`），另一处（`countsForTags`）用了缓存值
       *     ⇒ 卡片写 1 张、点进去 2 张，而界面不报错。
       */
      const { TagNav } = require(path.join(ROOT, 'src/main/tag-nav.js'));
      const { tagIdOf, quantize, DISPLAY_MIN_SCORE } = require(
        path.join(ROOT, 'src/ai/tag-index-store.js'),
      );
      // 夹具里 skirt = photo 6 / score 600。再插一张**卡在 0.35 与 0.25 之间**的：
      // 30 分 → 默认线 0.35 下被排除、调到 0.25 时进来。两个方向都能动，才叫「生效」。
      const db = new Database(path.join(tmp, 'ai-search', 'tag-index.sqlite'));
      db.prepare('INSERT INTO photo_tag (photo_id, tag_id, score) VALUES (?, ?, ?)').run(
        11,
        tagIdOf('skirt'),
        30,
      );
      db.close();
      const knob = { value: 0.35 };
      const nav2 = new TagNav(path.join(tmp, 'ai-search'), {
        displayMinScore: () => knob.value,
      });
      const totalNow = () => nav2.rankedPhotoIds('skirt', 1, 50).total;
      const cardNow = () => nav2.countsForTags(['skirt']).get('skirt');
      assert.equal(totalNow(), 1, '默认 0.35 下 score=30 的行必须被排除（夹具里只剩 600 那张）');
      knob.value = 0.25; // 用户把设置调松了 —— **不重建实例**
      assert.equal(
        totalNow(),
        2,
        '调松到 0.25 后 score=30 的行必须立刻进来：拿不到就说明值被缓存成字段了（改了要重启）',
      );
      assert.equal(cardNow(), 2, '卡片上的「N 张」必须同时换口径（两处一处缓存 = 数字对不上）');
      knob.value = 0.4; // 再调紧
      assert.equal(totalNow(), 1, '调紧回 0.40 后又要立刻排除');
      assert.equal(cardNow(), 1, '卡片同步回调');
      // getter 拿不到（守护/探针直接 new）时回落默认值 —— 默认值必须就是那条约定的展示线。
      const navDefault = new TagNav(path.join(tmp, 'ai-search'));
      assert.equal(
        navDefault.displayMinScore(),
        DISPLAY_MIN_SCORE,
        '没注入 getter 时必须回落 TAG_DISPLAY_RANGE.default（= DISPLAY_MIN_SCORE）',
      );
      assert.equal(navDefault.displayMinScoreInt(), quantize(DISPLAY_MIN_SCORE), '整数线必须走 quantize()');
    }) && ok;

    ok = check('🔴 展示线是唯一源 + 可调：导航页与照片信息面板共用同一个取值口径（不许任一处写死数字）', () => {
      const { TAG_DISPLAY_RANGE, STORE_MIN_SCORE, TAG_ROUTE_THRESHOLD } = require(
        path.join(ROOT, 'src/ai/tag-index-store.js'),
      );
      const navSrc = stripComments(read('src/main/tag-nav.js'));
      const panelSrc = stripComments(read('src/main/semantic-tags.js'));
      const mainSrc = read('src/main.js');
      // ① 导航页不许再拿入库线当展示线（0.15 会把 61% 的噪声行当结论摆出来）。
      assert.ok(!/STORE_MIN_SCORE/.test(navSrc), 'tag-nav.js 里不该再出现 STORE_MIN_SCORE（那是入库线）');
      // ② 分数线必须来自「每次现取」的那一个取值点，而不是某个常量/字段。
      const intCalls = (navSrc.match(/this\.displayMinScoreInt\(\)/g) || []).length;
      assert.ok(
        intCalls >= 2,
        'tag-nav.js 里 displayMinScoreInt() 只出现 ' + intCalls + ' 次，必须「countsForTags + rankedPhotoIds」各一次' +
          ' —— 只改一处就是卡片与网格口径分家',
      );
      assert.ok(
        /typeof read === 'function' \? Number\(read\(\)\) : NaN/.test(navSrc),
        'tag-nav.js 的 displayMinScore() 必须**当场调用 getter**：写成读字段（`this.options.displayMinScore` 直接 Number）' +
          '就等于把「设置」当成构造期常量，改完要重启才生效',
      );
      assert.ok(
        /if \(value === undefined \|\| value === null \|\| String\(value\)\.trim\(\) === ''\)/.test(
          read('src/ai/tag-index-store.js'),
        ),
        'clampDisplayMinScore 的空值分支不见了（空框应回落默认值而不是最低档）',
      );
      assert.ok(/score >= \?/.test(navSrc), 'countsForTags 的 SQL 必须带 `score >= ?`（否则卡片照旧按入库线算）');
      // ③ 照片信息面板必须用同一口径，否则「面板列着蓝天、导航点蓝天 0 张」。
      assert.ok(/TAG_DISPLAY_RANGE/.test(panelSrc), 'semantic-tags.js 必须从 TAG_DISPLAY_RANGE 取默认值');
      assert.ok(
        /quantize\(this\.displayMinScore\(\)\)/.test(panelSrc),
        '面板的分数必须走 quantize(displayMinScore())（与导航页同一个换算与同一个取值点）',
      );
      assert.ok(/pt\.score >= \?/.test(panelSrc), 'tagsFor 的 SQL 必须带 `pt.score >= ?`');
      // ④ **两处必须挂在同一个设置键上**：这是「同口径」的最终保证。一处读错键 ⇒
      //    面板与导航页按两条线算，而界面只表现为「数字对不上」。
      const injections = (
        mainSrc.match(
          /displayMinScore:\s*function\s*\(\)\s*\{\s*return\s+settings\.aiTagDisplayThreshold;/g,
        ) || []
      ).length;
      assert.equal(
        injections,
        2,
        'main.js 里必须**两处**（tagNav / joyTagTags）都注入 settings.aiTagDisplayThreshold，实际找到 ' + injections + ' 处' +
          ' —— 少一处就是两条线，且只在数字上看得出来',
      );
      // ⑤ 三条硬约束：可调范围的两端就是它们，改窄/改宽都要在这里说明。
      assert.equal(
        TAG_DISPLAY_RANGE.min,
        STORE_MIN_SCORE,
        'TAG_DISPLAY_RANGE.min 必须 === 入库线（低于入库线的行库里根本不存在，滑杆再往下是骗人的）',
      );
      assert.equal(
        TAG_DISPLAY_RANGE.max,
        TAG_ROUTE_THRESHOLD,
        'TAG_DISPLAY_RANGE.max 必须 === 查询线（高过查询线 = 导航比搜索还严，标签页看起来像缺图）',
      );
      assert.ok(
        TAG_DISPLAY_RANGE.default >= TAG_DISPLAY_RANGE.min &&
          TAG_DISPLAY_RANGE.default <= TAG_DISPLAY_RANGE.max,
        '默认展示线必须落在可调范围内',
      );
    }) && ok;

    ok = check('🔴 TagNav 没有「按节点聚合照片」的能力（父节点不给照片网格）', () => {
      const src = stripComments(read('src/main/tag-nav.js'));
      assert.ok(
        !/GROUP BY\s+photo_id/i.test(src),
        'tag-nav.js 出现 GROUP BY photo_id ⇒ 有人把「节点下全部照片」的聚合加回来了：' +
          '索引铺满 165 万张时那是全节点行数的聚合（约 9000 万行），几十秒主线程阻塞，' +
          '界面上与「点了没反应」无法区分。父节点只做下钻，照片只按单标签取。',
      );
      // ⚠️ 必须用 `getOwnPropertyNames` 而不是 `Object.keys`：class 语法定义的方法
      //    **不可枚举**，`Object.keys(TagNav.prototype)` 恒为 `[]` ⇒ 整个循环空转、
      //    这条断言变成恒真的假绿（2026-10-09 牙齿验证抓到的第 3 处假绿）。
      const protoKeys = Object.getOwnPropertyNames(TagNav.prototype);
      // 阳性对照：先证明「确实枚举到了方法」，否则上面那条断言又会在提取失败时空转。
      for (const must of ['status', 'tree', 'node', 'search', 'rankedPhotoIds']) {
        assert.ok(protoKeys.indexOf(must) >= 0, '原型上没枚举到 ' + must + '() ⇒ 枚举方式又坏了，下面的命名断言会变成空转的假绿');
      }
      for (const key of protoKeys) {
        assert.ok(
          !/photos?For(Node|Sub|Category)|nodePhotos/i.test(key),
          'TagNav.' + key + ' 的命名说明它在按节点取照片 —— 同上，不许加。',
        );
      }
    }) && ok;
  } finally {
    process.chdir(ROOT);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* 含 junction 的临时目录在 Windows 上可能删不掉，留着由系统清理 */
    }
  }
  return ok;
}

// ====================================================================
// ② 桌面渲染层：接线 + 本轮探针抓出的三处静默缺陷的钉子
// ====================================================================
function desktopLayer() {
  const htmlRaw = read('src/renderer/index.html');
  const appRaw = read('src/renderer/app.js');
  const uiRaw = read('src/renderer/tag-nav-ui.js');
  const api = read('src/renderer/api.js');
  const preload = read('src/preload.js');
  // 🔴 结构断言一律读**剥注释后**的视图（元规则 ③）。这一轮牙齿验证抓到两处真假绿：
  //    `loadPhotos` 卡片分支的注释里恰好写着 `previewFlow.initPreviewState()` 与
  //    `updateBrowsePathLabel()`，把**真实调用**整行删掉后断言照样命中注释 ⇒ 恒绿。
  const html = stripHtmlComments(htmlRaw);
  const app = stripComments(appRaw);
  const ui = stripComments(uiRaw);
  let ok = true;

  ok = check('index.html：rail 位置（人物之后 / 重复项之前）+ 样式表 + 脚本先于 app.js', () => {
    // 断言顺序而不是「存在」：标签页插到 rail 末尾（或塞到「首页」之前）在功能上都能跑，
    // 但侧栏是**固定心智顺序**（首页 → 浏览 → 工具），乱插一处没人会再看第二眼。
    const order = [];
    const re = /class="rail-item[^"]*"[\s\S]{0,120}?data-tab="([a-z_]+)"/g;
    let m;
    while ((m = re.exec(html))) order.push(m[1]);
    // ⚠️ 「设置」那颗**刻意不带 `data-tab`**（靠 `syncNavigationRail` 的 `|| 'settings'` 兜底），
    //    所以量到的项数 = 7 而不是 8。别把 8 写死：那会把一条正确的 index.html 判红。
    assert.ok(order.length >= 7, 'rail 项数异常（量到 ' + order.length + ' 项）：解析规则可能已与 index.html 脱节');
    assert.ok(order.indexOf('people') >= 0, '没量到「人物」＝解析规则已脱节，下面两条顺序断言会变成恒真的假绿');
    assert.ok(order.indexOf('tags') > order.indexOf('people'), '「标签」必须排在「人物」之后（当前顺序：' + order.join(' → ') + '）');
    assert.ok(order.indexOf('tags') < order.indexOf('duplicates'), '「标签」必须排在「重复项」之前（当前顺序：' + order.join(' → ') + '）');
    assert.ok(/href="tag-nav\.css"/.test(html), 'tag-nav.css 没被引用（桌面端无路由表，引用即可达）');
    const uiAt = html.indexOf('<script src="tag-nav-ui.js">');
    const appAt = html.indexOf('<script src="app.js">');
    assert.ok(uiAt >= 0, 'tag-nav-ui.js 没被 index.html 引用');
    assert.ok(appAt > uiAt, 'tag-nav-ui.js 必须先于 app.js 加载（挂载时它必须已在 window 上）');
  }) && ok;

  ok = check('api.js 用的是 **preload 方法名**，不是 IPC 频道名', () => {
    for (const m of ['getTagNavStatus', 'getTagNavTree', 'getTagNavNode', 'getTagNavSearch', 'getTagNavPhotos']) {
      assert.ok(new RegExp("call\\('" + m + "'[,)]").test(api), 'api.js 缺 call(\'' + m + '\')');
      assert.ok(new RegExp(m + ':\\s*function|' + m + ':\\s*\\(').test(preload), 'preload.js 缺 ' + m);
    }
    assert.ok(!/call\('get-tag-nav-/.test(api), 'api.js 里出现了 IPC 频道名（get-tag-nav-*）：call() 是 photoAPI[name] 直接索引，写频道名 = 拿到 undefined = has() 恒 false');
  }) && ok;

  ok = check('loadPhotos 卡片分支：清空 currentPhotos + 重置预览态 + 刷路径栏', () => {
    const m = /if \(state\.currentView === 'tag' && !state\.currentTag\) \{([\s\S]*?)\n {2}\}/.exec(app);
    assert.ok(m, 'loadPhotos 的标签卡片分支不见了');
    const body = m[1];
    assert.ok(/state\.currentPhotos = \[\];/.test(body), '不清空 currentPhotos ⇒ 在卡片上按空格会预览上一页的照片');
    assert.ok(/initPreviewState\(/.test(body), '不重置 previewFlow ⇒ previewTotalPhotos 停在旧值');
    assert.ok(/updateBrowsePathLabel\(\)/.test(body), '不刷路径栏 ⇒ 路径栏停在上一页的文字（case \'tag\' 分支明明写好了）');
    assert.ok(/renderBrowseCards\(\)/.test(body), '卡片绘制调用缺失');
  }) && ok;

  ok = check('导航三张白名单 + 启动快照排除（漏一条 = 后退记不住 / 启动落到必被拒的记录）', () => {
    assert.ok(/'tag'/.test(/\bBROWSABLE_VIEWS\s*=\s*\[[^\]]*\]/.exec(app)[0]), 'BROWSABLE_VIEWS 缺 tag');
    assert.ok(/case 'tag':/.test(app), 'applyBrowseLocation 缺 case \'tag\'');
    assert.ok(
      /currentTab === 'tags'[\s\S]{0,80}?return;/.test(funcBody(app, 'persistStartupPositionSnapshot')),
      'persistStartupPositionSnapshot 必须对 tags 早退（标签页的 currentView 不在启动白名单里 ⇒ 写进去会用一个必然被拒的记录顶掉上一个可恢复的位置）',
    );
    const capLoc = funcBody(app, 'captureBrowseLocation');
    assert.ok(capLoc.length > 200, 'captureBrowseLocation 不见了（取不到函数体 ⇒ 下面两条断言会以「内容缺失」的形式假红）');
    assert.ok(/return null;/.test(capLoc), 'captureBrowseLocation 必须能返回 null');
    assert.ok(
      /view === 'tag'[\s\S]{0,300}?if \(!state\.currentTag\) return null;/.test(capLoc),
      'captureBrowseLocation 必须在 currentTag 为空时返回 null（否则同一个键反复入栈，后退像卡住）',
    );
  }) && ok;

  ok = check('tag-nav-ui.js：展开态双写契约（.expanded 类 + 行内 display）', () => {
    const start = ui.indexOf('function childrenAttrs');
    assert.ok(start >= 0, 'childrenAttrs 不见了');
    const body = ui.slice(start, ui.indexOf('\n    function ', start + 10));
    assert.ok(/expanded' : ''/.test(body) || /\(isOpen \? ' expanded'/.test(body), '缺 .expanded 类 ⇒ 会被 gallery-design.css 的 .tree-children:not(.expanded) 再藏回去');
    assert.ok(/display:'\s*\+/.test(body) && /isOpen \? 'block' : 'none'/.test(body), '缺行内 display（双写的另一半）');
    assert.ok(/--tree-guide-x/.test(body), '缺层级导线变量（与目录树同一口径）');
  }) && ok;

  ok = check('tag-nav-ui.js：代次判据必须是 !==（> 恒假）且缓存三态分立', () => {
    // 🔴 代次的**每一处**都算：`ensureSubTags` 的成功路径与 catch 路径各有一道
    //    `subToken[subId]` 判据 ⇒ 只断言「至少有一处」会有假绿（改掉一处仍是绿，
    //    2026-10-09 牙齿验证抓到）。所以按**次数**钉 + 反面形状一起钉。
    const cnt = (re) => (ui.match(re) || []).length;
    assert.ok(
      cnt(/subToken\[subId\] !== myToken/g) >= 2,
      '子类请求的代次判据不足两处（成功路径 + catch 路径各一道）：只留一处时改坏另一处不会被发现',
    );
    assert.ok(cnt(/myToken !== cardsSeq/g) >= 1, '主区卡片的代次判据缺失');
    assert.ok(cnt(/searchToken !== myToken/g) >= 1, '搜索的代次判据缺失');
    // 反面形状：注释已被剥掉，所以这里读不到「注释里的反面教材」，可以安全地搜。
    for (const bad of [/subToken\[subId\]\s*>\s*myToken/, /myToken\s*<\s*cardsSeq/, /searchToken\s*<\s*myToken/]) {
      assert.ok(
        !bad.test(ui),
        '代次判据写成了大小比较（' + bad.source + '）：seq 只增不减 ⇒ 判据恒假 ⇒ 过期回包照样回写，' +
          '而代码看起来「已经防了」。必须是 !==。',
      );
    }
    assert.ok(/subTags\[subId\] = null;/.test(ui), '失败态必须存 null（与 [] 分开），否则一次读库失败被显示成「这个分类是空的」');
    assert.ok(
      /function refreshLocale[\s\S]{0,600}subTags = Object\.create\(null\)/.test(ui),
      'refreshLocale 必须失效 subTags 缓存：name 是服务端按 locale 给的，只重画 ⇒ 已展开的子树停在上一种语言',
    );
  }) && ok;

  ok = check('tag-nav-ui.js：搜索态变化必须刷新主区，且只在卡片态刷新', () => {
    assert.ok(/function refreshMainForSearch[\s\S]{0,400}if \(state\.currentTag\) return;/.test(ui),
      'refreshMainForSearch 必须先判 currentTag：正在看照片时把人拽回卡片属于「界面乱跳」');
    assert.ok(/runSearch[\s\S]{0,600}refreshMainForSearch\(\)/.test(ui), 'runSearch 成功路径没刷主区');
    // 清空搜索的刷主区改由 `exitSearch()` 承担（提交式搜索下「清空」是一个独立动作，见下一条）。
    const ex = /function exitSearch\(\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(ex, 'exitSearch 不见了');
    assert.ok(/refreshMainForSearch\(\)/.test(ex[1]), '清空 / 退出搜索没刷主区');
  }) && ok;

  // 🔴 标签搜索是**提交式**的（敲字不发请求）：判据集在模块级，网页端那一半在 ③ 段跑**同一份**。
  //    两端各写一份必然漂 —— 漂了以后只守得住一端。
  ok = submitSearchChecks(ui, '桌面端', {}) && ok;
  ok = submitSearchCssChecks('src/renderer/tag-nav.css', 'tag-nav', '桌面端') && ok;

  ok = check('tag-nav-ui.js：切语言后的回调必须共用一份（pending 合并会吞掉第二个 callback）', () => {
    const m = /function refreshLocale\(\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(m, 'refreshLocale 不见了');
    assert.ok(!/ensureSubTags\(id, function \(\) \{[\s\S]{0,120}onChromeRefresh/.test(m[1]),
      'refreshLocale 里给 ensureSubTags 传了各自的回调：同一子类的并发请求会被 pending 合并，' +
        '后进来的 callback 根本不会被调 ⇒ 路径栏停在旧语言名字。回调必须共用一个函数。');
    assert.ok(/function afterSubLoad\(\)/.test(m[1]), 'refreshLocale 里没有共用的 afterSubLoad');
  }) && ok;

  ok = check('进入标签页时主区不能赌「树先到」：数据落地后要补一次卡片', () => {
    const m = /function enter\(\) \{[\s\S]{0,1400}\n {4}\}/.exec(ui);
    assert.ok(m, 'enter() 不见了');
    assert.ok(/!state\.currentTag && typeof onRenderCards === 'function'/.test(m[0]),
      'enter() 的回包处理里没有补画卡片 ⇒ loadPhotos 先跑完时 categoryCards() 还是空的，主区白屏');
  }) && ok;

  ok = check('🔴 改展示线后必须让渲染层缓存失效（否则「设置改了数字不变」且无任何报错）', () => {
    // ① UI 模块要暴露失效入口，且失效要**先清缓存**：`refreshLocale` 那种「先判在不在标签页」
    //    的写法放到这里就是**静默空操作** —— 改设置时人在设置页，第一行就 return 了。
    assert.ok(
      /invalidateCounts:\s*invalidateCounts/.test(ui),
      'tag-nav-ui 没把 invalidateCounts 暴露出去 ⇒ app.js 调不到（而 typeof 判断会让它静默跳过）',
    );
    const m = /function invalidateCounts\(\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(m, 'invalidateCounts 不见了');
    const cacheIdx = m[1].indexOf('subTags = Object.create(null)');
    const pageIdx = m[1].indexOf('if (onTagPage())');
    assert.ok(cacheIdx >= 0, 'invalidateCounts 必须清 subTags 缓存（那是「标签 → 张数」的进程级缓存）');
    assert.ok(
      pageIdx < 0 || cacheIdx < pageIdx,
      'invalidateCounts 里「清缓存」必须排在「判断在不在标签页」**之前**：反了的话，人在设置页改完设置' +
        '就等于什么都没做（第一行 return），而界面上完全看不出来',
    );
    assert.ok(/searchResult = null/.test(m[1]), '搜索结果里的张数也按旧线算过，必须一起失效');
    assert.ok(
      /countsDirty = true/.test(m[1]),
      '必须记脏标记：清完缓存人还没回标签页时，展开着的子类没有数据（renderSidebar 自己不发请求）',
    );
    // ② 进页时要把脏标记认掉，并**主动重取**（否则展开的行永远停在「正在搜索…」）。
    const enter = /function enter\(\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(enter, 'enter() 不见了');
    assert.ok(
      /if \(countsDirty\)[\s\S]{0,200}?repaintCounts\(\)/.test(enter[1]),
      'enter() 没认脏标记 ⇒ 改完展示线回到标签页，展开着的子类停在「正在搜索…」且数据是旧的',
    );
    const repaint = /function repaintCounts\(\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(repaint, 'repaintCounts 不见了');
    assert.ok(
      /ensureSubTags\(id, afterSubLoad\)/.test(repaint[1]),
      'repaintCounts 必须主动 ensureSubTags：renderSidebar 自己不发请求，只画「正在搜索…」',
    );
    // ③ app.js 的接线：读回三个键、写成功后失效。⚠️ 用「三键都读」而不是「读了一个就算」——
    //    少了 tagDisplayThreshold，输入框永远显示占位默认值（用户会以为设置没保存）。
    assert.ok(
      /tagDisplayThreshold:\s*all\.aiTagDisplayThreshold/.test(app),
      'tagLayer.read 没把 aiTagDisplayThreshold 带回来 ⇒ 面板永远显示默认值（看起来像「设置没保存」）',
    );
    // ⚠️ 缩进一律写 ` {4}` 而不是 4 个裸空格：后者会被 `no-regex-spaces` 判为 error（lint 基线是 0 error）。
    const write = /tagLayer:\s*\{[\s\S]*?write:\s*function \(patch\) \{([\s\S]*?)\n {4}\},/.exec(app);
    assert.ok(write, 'app.js#tagLayer.write 不见了');
    assert.ok(
      /patch\.tagDisplayThreshold\s*!==\s*undefined/.test(write[1]),
      'write 必须只在这一条键被改时才刷新（判据是键在不在 patch 里，不是「值变没变」）',
    );
    assert.ok(
      /invalidateCounts\(\)/.test(write[1]),
      'write 成功后没让缓存失效 ⇒ 标签页的数字停在旧线上的那一刻，没有任何报错',
    );
    assert.ok(
      /typeof tagNavUi\.invalidateCounts === 'function'/.test(write[1]),
      '调 invalidateCounts 前要判存在（老版本 UI 模块 / 探针替身里没有它，直接调会抛）',
    );
    assert.ok(
      /refreshOpenPreviewInfoPanel\(\)/.test(write[1]),
      '照片信息面板也要按新线重画（开着一张照片时改线，否则停在旧标签上）',
    );
  }) && ok;

  ok = check('🔴 空态必须区分「这儿没索引」与「都低于展示线」（两种空给用户的下一步完全不同）', () => {
    /**
     * 服务端过滤掉 0 命中的标签之后（`main/tag-nav.js#node`），**列表变空有了两种原因**：
     *   · `indexed === 0` —— 索引还没铺到这儿（用户该去建索引）；
     *   · `indexed > 0`  —— 有标签，但都低于当前展示线（用户该去**调低展示线**）。
     * 把两者说成同一句话，用户就会朝错误的方向使劲，而界面上完全看不出哪里不对。
     */
    // 侧栏叶子：父行已有的 `tagIndexed` 必须传下去当判据。
    assert.ok(
      /tagLeavesHtml\(sub\.id, 2, sub\.tagIndexed\)/.test(ui),
      '调用 tagLeavesHtml 时没把 `sub.tagIndexed` 传下去 ⇒ 空态恒说「还没有已建立索引的标签」，' +
        '而那个子类其实有标签、只是都被展示线滤掉了',
    );
    assert.ok(
      !/tagLeavesHtml\(sub\.id, 2\)/.test(ui),
      '还有一个不传第三参的调用点 —— 那条路径上「都低于展示线」会被说成「还没建立索引」',
    );
    const leaves = /function tagLeavesHtml\(subId, depth, indexed\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(leaves, 'tagLeavesHtml 的签名或缩进变了（断言已与模块脱节，下面两条会变成空转）');
    assert.ok(
      /Number\(indexed\) > 0[\s\S]{0,240}?tagnav\.belowLine/.test(leaves[1]),
      '空态里没有「`indexed > 0` ⇒ 低于展示线」这一支',
    );
    assert.ok(
      /tagnav\.noTagHit/.test(leaves[1]),
      '另一支（`indexed === 0`）必须仍是「这个节点下还没有已建立索引的标签」—— 合成一句就是要修的病',
    );
    // 主区：`emptyTextFor` 是空态文案的**唯一**来源，卡片列表要收下它，不许自己猜。
    const empty = /function emptyTextFor\(indexed, mode\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(empty, 'emptyTextFor 不见了');
    assert.ok(/tagnav\.belowLineHint/.test(empty[1]), '主区那句空态必须带出路（可在设置里调低展示线）');
    assert.ok(
      /mode === 'search'/.test(empty[1]),
      '两种「一个都没有」必须分开：搜不到 vs 这儿本来就没有（文案不同、下一步也不同）',
    );
    assert.ok(
      /function renderCardList\(grid, items, myToken, emptyText\)/.test(ui),
      'renderCardList 没收下 emptyText ⇒ 空态只能按旧规则猜',
    );
    const cards = /function renderCardList\(grid, items, myToken, emptyText\) \{([\s\S]*?)\n {4}\}/.exec(ui);
    assert.ok(cards, 'renderCardList 的形状变了（断言已脱节）');
    assert.ok(/esc\(emptyText \|\|/.test(cards[1]), 'renderCardList 的空态没真的用 emptyText');
    // 三个调用点各自把判据给对。
    assert.ok(
      /emptyTextFor\(searchResult\.indexed, 'search'\)/.test(ui),
      '搜索态的卡片空态没接 `searchResult.indexed`',
    );
    assert.ok(/emptyTextFor\(res && res\.indexed, 'node'\)/.test(ui), '节点态的卡片空态没接回包的 `indexed`');
    // 🔴 服务端已保证列表里不会有 0 命中项 ⇒「0 就置灰」那一档必须清掉：
    //    留着它，删掉服务端过滤时界面只是「灰一片」而不是「0 张」——过滤失效就被掩盖了。
    assert.ok(
      !/dim: !tag\.count/.test(ui),
      '还留着「命中数为 0 就置灰」的渲染分支：服务端不会再给出 0 命中的项，它只剩掩盖过滤失效这一个作用',
    );
    // 阳性对照：**节点**（分类 / 子类）的置灰是另一回事（`tagIndexed` 真的会是 0），不许一起删。
    assert.ok(
      /dim: !cat\.tagIndexed/.test(ui) && /dim: !sub\.tagIndexed/.test(ui),
      '分类 / 子类行的置灰被顺手删了 —— 那是「索引还没铺到这儿」的信号，与标签 0 命中不是一回事',
    );
  }) && ok;

  return ok;
}

// ====================================================================
// ③ 网页端：路由 / SW 预缓存 / 接线 / 类名不共用
// ====================================================================
function webLayer() {
  // 同上：结构断言读剥注释后的视图。
  const html = stripHtmlComments(read('src/web/index.html'));
  const app = stripComments(read('src/web/js/app.js'));
  const mod = stripComments(read('src/web/js/tag-nav.js'));
  const server = read('src/web-server.js');
  const sw = read('src/web/sw.js');
  const desktopUi = stripComments(read('src/renderer/tag-nav-ui.js'));
  let ok = true;

  ok = check('index.html：页签 + 资源引用 + 加载顺序', () => {
    assert.ok(/data-tab="tags"/.test(html), '侧栏页签缺「标签」');
    assert.ok(/href="\/tag-nav\.css\?v=\d+"/.test(html), 'tag-nav.css 没被引用');
    const modAt = html.indexOf('<script src="/js/tag-nav.js');
    const appAt = html.indexOf('<script src="/js/app.js');
    assert.ok(modAt >= 0 && appAt > modAt, 'tag-nav.js 必须先于 app.js 加载');
  }) && ok;

  ok = check('web-server.js 两条路由都在（漏一条 = 404 而所有静态守护全绿）', () => {
    assert.ok(/pathname === '\/js\/tag-nav\.js'/.test(server), '缺 /js/tag-nav.js 路由');
    assert.ok(/pathname === '\/tag-nav\.css'/.test(server), '缺 /tag-nav.css 路由');
    for (const p of ['tag-nav-status', 'tag-nav-tree', 'tag-nav-node', 'tag-nav-search', 'tag-nav-photos']) {
      assert.ok(new RegExp("pathname === '/api/" + p + "'").test(server), '缺 /api/' + p + ' 路由');
    }
  }) && ok;

  ok = check('sw.js：新资源进预缓存 + CACHE_NAME 抬过 v53', () => {
    const m = /var CACHE_NAME = 'aurora-gallery-shell-v(\d+)'/.exec(sw);
    assert.ok(m, 'CACHE_NAME 形状不对');
    assert.ok(Number(m[1]) >= 54, 'CACHE_NAME 必须抬到 v54 以上（改了清单里的资源不抬 = cache-first 客户端永远拿旧字节）');
    const list = /var SHELL_ASSETS = \[([\s\S]*?)\];/.exec(sw)[1];
    assert.ok(/'\/js\/tag-nav\.js\?v=\d+'/.test(list), 'tag-nav.js 没进 SHELL_ASSETS');
    assert.ok(/'\/tag-nav\.css\?v=\d+'/.test(list), 'tag-nav.css 没进 SHELL_ASSETS');
  }) && ok;

  ok = check('web app.js：tag 视图接线 + 预览翻页同源', () => {
    assert.ok(/function isTagView\(\)/.test(app), '缺 isTagView()');
    assert.ok(/switch \(state\.currentView\) \{[\s\S]{0,300}case 'tag':[\s\S]{0,400}\/api\/tag-nav-photos/.test(app), 'loadPhotos 缺 case \'tag\'（tag-nav-photos）');
    assert.ok(/loadPreviewAdjacentPage[\s\S]{0,900}case 'tag':[\s\S]{0,300}\/api\/tag-nav-photos/.test(app), 'loadPreviewAdjacentPage 缺 case \'tag\' ⇒ 预览翻到页边界就停');
    const m = /if \(isTagView\(\) && !state\.currentTag\) \{([\s\S]*?)\n {2}\}/.exec(app);
    assert.ok(m, '网页端 loadPhotos 的标签卡片分支不见了');
    assert.ok(/state\.currentPhotos = \[\];/.test(m[1]), '网页端卡片分支不清 currentPhotos ⇒ 预览打开上一页的照片');
    assert.ok(/exitWebAiViewChrome[\s\S]{0,400}webTagNav\.leave\(\)/.test(app), 'exitWebAiViewChrome 不收标签页 ⇒ 从标签页点进目录，侧栏还停在标签树');
  }) && ok;

  ok = check('类名两端刻意不共用（共用 = 改一端动两端）', () => {
    // 🔴 **按形状扫全部 token**，不写死几个类名，也不假设「类名紧跟在引号/点后面」。
    //    这里连续踩过两次假绿（2026-10-09 牙齿验证）：
    //    ① 写死四个类名 —— 网页端实际有 16 个 `web-tag-nav-*`，把 `children` 那个摘掉前缀，断言一条都不碰；
    //    ② 换成 `['"`.]+tag-nav-*` 的形状扫描 —— 类名是拼进 `class="tree-children ..."` 里的，
    //       前面是**空格**而不是引号 ⇒ 照样漏。
    //    正确判据 = 找出所有 `tag-nav-*` token，看它的**前缀**是不是白名单之一。
    // ⚠️ 前缀要取 **5 个**字符：`data-` 是 5 个（`web-` 是 4 个）—— 取 4 会把
    //    `data-tag-nav-kind` 的前缀看成 `ata-`，于是把 9 处合法属性判成违规。
    const ALLOWED_PREFIX = /(web-|data-|api\/)$/;
    const bare = [];
    const reTok = /tag-nav-[a-z-]+/g;
    let tk;
    while ((tk = reTok.exec(mod))) {
      const before = mod.slice(Math.max(0, tk.index - 5), tk.index);
      if (!ALLOWED_PREFIX.test(before)) bare.push(before + '|' + tk[0]);
    }
    assert.deepEqual(
      bare,
      [],
      '网页端出现了不带 web- 前缀的类名（前缀只许 web- / data- / api/）：' + bare.join(', '),
    );
    // 阳性对照：证明扫描确实读到了模块（否则上面可能因为「一个都没扫到」而恒绿）。
    const webCls = new Set(mod.match(/web-tag-nav-[a-z-]+/g) || []);
    assert.ok(webCls.size >= 12, '网页端量到的 web-tag-nav-* 只有 ' + webCls.size + ' 个 ⇒ 扫描已与模块脱节，上面的断言变成空转');
    // 反向：桌面端不许出现 `web-` 前缀类名（它是网页端专属的）。
    assert.ok(
      !/web-tag-nav-[a-z-]+/.test(desktopUi),
      '桌面端出现了 web- 前缀类名 ⇒ 类名前缀是两端的分界，串了就等于「改一端动两端」',
    );
  }) && ok;

  ok = check('网页端只有标签叶子走照片网格（模块内不许有节点级聚合请求）', () => {
    assert.ok(!/GROUP BY\s+photo_id/i.test(stripComments(mod)), '网页端 tag-nav.js 出现节点级照片聚合 —— 同桌面端红线');
  }) && ok;

  ok = check('🔴 网页端同一条空态契约：两种空分开 + 文案带出路（两端不许漂）', () => {
    // 网页端是**另一份实现**（内联 `t(zh, en)`，不走 i18n.js），所以桌面端的断言一条都盖不到它。
    // 如果它只跟着改一半，用户在局域网上打开就是「0 命中的标签照样列出来」或「空了一片却没有解释」。
    assert.ok(
      /tagLeavesHtml\(sub\.id, 2, sub\.tagIndexed\)/.test(mod),
      '网页端调用 tagLeavesHtml 时没传 `sub.tagIndexed` ⇒ 空态分不了岔',
    );
    const leaves = /function tagLeavesHtml\(subId, depth, indexed\) \{([\s\S]*?)\n {4}\}/.exec(mod);
    assert.ok(leaves, '网页端 tagLeavesHtml 的签名或缩进变了（断言已脱节）');
    assert.ok(
      /Number\(indexed\) > 0[\s\S]{0,280}?低于当前展示线/.test(leaves[1]),
      '网页端空态没按 `indexed` 分岔',
    );
    const empty = /function emptyTextFor\(indexed, mode\) \{([\s\S]*?)\n {4}\}/.exec(mod);
    assert.ok(empty, '网页端 emptyTextFor 不见了');
    assert.ok(
      /标签展示线/.test(empty[1]),
      '网页端主区空态没告诉用户去哪儿调 —— 两端的出路文案会漂（一处说设置里，一处干瞪眼）',
    );
    assert.ok(/mode === 'search'/.test(empty[1]), '网页端两种「一个都没有」没分开');
    assert.ok(
      /function renderCardList\(grid, items, myToken, emptyText\)/.test(mod) &&
        /esc\(emptyText \|\|/.test(mod),
      '网页端 renderCardList 没收下 / 没用 emptyText',
    );
    assert.ok(
      /emptyTextFor\(searchResult\.indexed, 'search'\)/.test(mod) &&
        /emptyTextFor\(res && res\.indexed, 'node'\)/.test(mod),
      '网页端两个卡片空态的判据没接 indexed（侧栏与主区会说出两句不同的话）',
    );
    assert.ok(!/dim: !tag\.count/.test(mod), '网页端还留着「0 命中就置灰」的分支');
    assert.ok(/dim: !cat\.tagIndexed/.test(mod), '网页端分类行的置灰被顺手删了（那是另一种空，见桌面端）');
  }) && ok;

  // 🔴 网页端跑的是与 ② 段**同一份**判据集。它是另一份实现（内联 `t(zh, en)`），
  //    桌面端的断言一条都盖不到它 —— 只跟着改一半的话，用户在局域网上打开就是「边打边搜」。
  ok = submitSearchChecks(mod, '网页端', { leave: true }) && ok;
  ok = submitSearchCssChecks('src/web/css/tag-nav.css', 'web-tag-nav', '网页端') && ok;

  return ok;
}

// ====================================================================
// ④ i18n：两端词条齐全（缺词条只会显示兜底名，静默）
// ====================================================================
function i18nLayer() {
  const src = read('src/renderer/i18n.js');
  let ok = true;
  ok = check('i18n：tagnav.* / nav.tags / path.tag 双侧齐全', () => {
    const zhAt = src.indexOf("'zh-CN': {");
    const enAt = src.search(/\n\s{2,6}en: \{/);
    assert.ok(zhAt >= 0 && enAt > zhAt, 'i18n.js 的双语包结构变了（找不到 zh-CN / en 两段）');
    const packs = [
      ['zh-CN', src.slice(zhAt, enAt)],
      ['en', src.slice(enAt)],
    ];
    for (const [lang, seg] of packs) {
      assert.ok(seg.indexOf("'nav.tags'") >= 0, lang + ' 缺 nav.tags');
      assert.ok(seg.indexOf("'path.tag'") >= 0, lang + ' 缺 path.tag');
      const n = (seg.match(/'tagnav\./g) || []).length;
      assert.ok(n >= 98, lang + ' 的 tagnav.* 词条只有 ' + n + ' 条（14 分类 + 67 子类 + 通用，应 ≥ 98）—— 新增子类忘了补词条？');
      // 空态那两条必须**两侧都在**：只补一侧时 `t()` 会回落到代码里的兜底串，
      // 界面看起来完全正常，只有换到这个语言才发现文案是另一种语言的。
      for (const key of ['tagnav.belowLine', 'tagnav.belowLineHint']) {
        assert.ok(
          seg.indexOf("'" + key + "'") >= 0,
          lang + ' 缺 ' + key + '（缺了会静默回落到代码兜底串，另一侧的语言看不到问题）',
        );
      }
    }
  }) && ok;
  return ok;
}

// ====================================================================
// ⑤ 渲染层资源可达性：index.html 引用的每个本地资源都必须存在
//    （这一轮发现的真空白 —— 桌面端此前没有任何守护查这件事）
// ====================================================================
function rendererAssetReachability() {
  const html = read('src/renderer/index.html');
  const refs = [];
  const re = /(?:<script src="|<link rel="stylesheet" href=")([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) refs.push(m[1]);
  let ok = true;
  ok = check(
    'renderer/index.html 引用的本地资源全部存在（' + refs.length + ' 条）',
    () => {
      assert.ok(refs.length >= 20, '引用数异常地少（' + refs.length + '），正则可能没吃全');
      const missing = [];
      for (const ref of refs) {
        const clean = ref.split('?')[0];
        if (/^(https?:)?\/\//.test(clean)) continue;
        const file = path.join(ROOT, 'src/renderer', clean);
        if (!fs.existsSync(file)) missing.push(ref);
      }
      assert.deepEqual(missing, [], 'index.html 引用了不存在的文件（桌面端没有路由表，404 = 白屏或脚本静默缺失）');
    },
  ) && ok;
  ok = check('反向：src/renderer 下的 js/css 不能是孤儿（不被引用 = 死代码）', () => {
    // 🔴 判据必须是**解析出来的引用清单**，不能用 `html.indexOf(f) < 0`。
    //    用文本包含会有假绿（2026-10-09 牙齿验证抓到）：index.html 里那句注释
    //    「网页端那份在 web/css/tag-nav.css」含有 `tag-nav.css` ⇒ 把真实 `<link>` 整行
    //    摘掉之后，孤儿检查照样认为「被引用了」。
    const refNames = new Set(
      refs.map((r) => r.split('?')[0].split('/').pop()),
    );
    assert.ok(refNames.size >= 15, '解析出的引用只有 ' + refNames.size + ' 条 ⇒ 正则已与 index.html 脱节，下面的孤儿判定会变成空转');
    const dir = path.join(ROOT, 'src/renderer');
    const orphans = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(js|css)$/.test(f)) continue;
      if (f === 'preload.js') continue; // preload 由 BrowserWindow 加载，不走 index.html
      if (!refNames.has(f)) orphans.push(f);
    }
    assert.deepEqual(orphans, [], 'src/renderer 下有未被 index.html 引用的 js/css（要么删掉，要么是忘了接）');
  }) && ok;
  return ok;
}

// ====================================================================
let failed = false;
console.log('[tag-nav-regression]');
console.log('① 数据层（夹具库）');
failed = !dataLayer() || failed;
console.log('② 桌面渲染层');
failed = !desktopLayer() || failed;
console.log('③ 网页端');
failed = !webLayer() || failed;
console.log('④ i18n');
failed = !i18nLayer() || failed;
console.log('⑤ 渲染层资源可达性');
failed = !rendererAssetReachability() || failed;

if (failed) {
  console.error('[tag-nav-regression] FAIL');
  process.exit(1);
}
console.log('[tag-nav-regression] PASS');
