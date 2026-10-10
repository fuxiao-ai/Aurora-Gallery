'use strict';
/**
 * 界面用词契约回归：「照片 → 图片」反向统一（2026-10-07 用户拍板）不许衰减。
 *
 * 背景：同一个概念原先在中文端混用「照片 / 图片」（43 : 7），而**英文端这些位置本来就写
 * `Photo`**，且库的主体是图包 / 画册而不是相机照片。用户拍板**反向统一叫「图片」**，
 * 全站此后只剩 **图片 / 视频 / 文件夹 / 文件（含视频的总集）** 四个词
 * （2026-10-07 一轮覆盖 `src/` 62 文件 593 处 + PWA 描述 + Android Compose 字面量）。
 *
 * 为什么需要它：这类统一**没有守护就会自然衰减** —— 新写的文案不会遵守；而下一次
 * 全局替换又会踩到数据文件（上一轮就是这么把 `tag-vocab-regression` 踩红的）。
 * 所以本脚本同时钉**两个方向**：
 *
 *   ① **界面文案侧**：剥注释后的字符串字面量不许出现「照片」，
 *      白名单只留 Apple 专有名词「实况照片」（Live Photo）一条；
 *   ② **数据侧**：三处字面量**必须保留**「照片」—— 它们是喂给索引 / 向量的**数据**，
 *      「顺手统一」等于把已建索引的分数口径作废。
 *      其中 `ai/embedding.js#GENERIC_TEXT` **此前没有任何守护覆盖**（只靠人工分类抓），
 *      本脚本把它补上，并且是**读真实导出值**而不是文本匹配。
 *
 * ⚠️ 三个刻意的判据选择（改之前先读）：
 *
 *   1. **载体用目录遍历，不用硬编码清单**。范围与 `check-text-corruption.js` 对齐
 *      （`src/renderer` + `src/web`，排除 vendor，收 js / html / css）。
 *      硬编码清单里新增的文件不进守护 —— 那正是「衰减」的入口，本脚本存在的理由。
 *      ⇒ 反过来说：**`src/ai/` 不在扫描面里**（那里是数据不是文案），这条本身有断言。
 *
 *   2. **断言不许读注释**（元规则③）。JS 走 acorn 取 token —— 顺带解决 `\uXXXX`：
 *      本项目的中文大量以转义形式存在（如 `'\u6240\u6709\u6587\u4EF6'`），
 *      裸 `replace('照片', …)` 根本抓不到。HTML 把 `<script>` / `<style>` 整块摘掉
 *      （两端 index.html 有 31 / 8 个 script 标签，内联脚本的 JS 注释不能被当成文案），
 *      CSS 剥块注释（`content:` 里的字符串才是文案）。
 *
 *   3. **白名单按 (文件, 字面量) 精确匹配，不做文件级豁免** —— 文件级豁免会在那个
 *      文件里放过任何新写的「照片」。并且配一条**防过期**断言：豁免项必须**仍因含
 *      「照片」**才被豁免，否则它已退化成永远不命中的豁免（键改名 / 字面量被改后就会这样）。
 *
 * 反面案例（本脚本要防的具体形状，都实测过）：
 *   - `ai/embedding.js#GENERIC_TEXT` 被改成「一张图片」⇒ 全库向量基线差口径作废，
 *     **当时守护没红**（没有指纹守它）。
 *   - `ai/tag-vocabulary.js` 一个标签名被改 ⇒ `tag-vocab-regression` 红
 *     （`词表内容变了…但结构层快照没重建`）。**正确反应是还原，不是跑重建脚本。**
 *   - `home-page-regression.js` / `ai-web-views-regression.js` 里钉住旧文案的断言 ⇒ 红。改断言即可。
 *   - `perceptual-hash-share-regression.js` 的负向自证被改成恒真 ⇒ **不红**，要主动去找。
 */

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}
function section(title) {
  notes.push('');
  notes.push('  ' + title);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 把匹配到的片段抹成同长度空白（**保留换行**）—— 行号才不会错位。 */
const blank = (s) => s.replace(/[^\n]/g, ' ');
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// ---------------------------------------------------------------- 载体收集

/**
 * 界面文案载体 = `src/renderer` + `src/web` 下的 js / html / css（排除 vendor）。
 *
 * 🔴 **刻意不扫 `src/ai/`**：那里的中文是**数据**（词表 / 基线差文本），
 * 改它等于让已建索引的口径作废。`src/ai` 反过来由下面第 2 节钉住「必须保留旧词」。
 */
function collectUiFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (/vendor/.test(child)) continue;
      if (e.isDirectory()) walk(child);
      else if (/\.(js|html|css)$/.test(e.name)) out.push(child);
    }
  };
  walk('src/renderer');
  walk('src/web');
  return out.sort();
}

/** acorn 取字符串 / 模板字面量（**cooked 值**）—— 天然不读注释，且认得 `\uXXXX`。 */
function jsLiterals(rel) {
  const src = read(rel);
  const parse = (sourceType) => {
    const tokens = [];
    acorn.parse(src, {
      ecmaVersion: 'latest',
      sourceType,
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      onToken: tokens,
    });
    return tokens;
  };
  let tokens;
  try {
    tokens = parse('script');
  } catch (_) {
    tokens = parse('module');
  }
  const out = [];
  for (const t of tokens) {
    const label = t.type && t.type.label;
    if ((label === 'string' || label === 'template') && typeof t.value === 'string') {
      out.push({ value: t.value, line: lineOf(src, t.start) });
    }
  }
  return out;
}

/** HTML 文案面 = 摘掉 `<script>` / `<style>` 整块与 HTML 注释之后剩下的文本与属性值。 */
function htmlCopyOnly(rel) {
  return read(rel)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** CSS 文案面 = 剥块注释（`content:` 里的字符串才是文案）。 */
function cssCopyOnly(rel) {
  return read(rel).replace(/\/\*[\s\S]*?\*\//g, blank);
}

function findAll(src, needle) {
  const hits = [];
  let i = src.indexOf(needle);
  while (i >= 0) {
    hits.push(lineOf(src, i));
    i = src.indexOf(needle, i + needle.length);
  }
  return hits;
}

// ============================================================ 1. 界面文案侧

section('1. 界面文案：剥注释后的文案面零「照片」');

const UI_FILES = collectUiFiles();
check('夹具自证：取到了界面文案载体', UI_FILES.length >= 20, `实际 ${UI_FILES.length} 个`);
check(
  '🔴 扫描面不许放大到 src/ai（那里是数据不是文案，放大 = 一改就误报）',
  UI_FILES.every((f) => !f.startsWith('src/ai/')),
);

/**
 * 白名单：界面文案里**允许**出现「照片」的少数几处。
 * ⚠️ 按 (文件, 字面量) 精确匹配 —— **不做文件级豁免**（那会在该文件里放过任何新写的「照片」）。
 */
const ALLOWED_LITERALS = [
  {
    file: 'src/renderer/i18n.js',
    literal: '播放这张实况照片的动态（Live Photo 的伴生视频）',
    why: 'Apple 专有名词「实况照片」= Live Photo，指苹果的动图格式，不是「静态图片」的同义词',
  },
];

const offenders = [];
const parseFailures = [];
const seenAllowed = new Set();
const MAX_DETAIL = 6;

for (const file of UI_FILES) {
  try {
    if (file.endsWith('.js')) {
      for (const lit of jsLiterals(file)) {
        if (!lit.value.includes('照片')) continue;
        const allow = ALLOWED_LITERALS.find((a) => a.file === file && a.literal === lit.value);
        if (allow) {
          seenAllowed.add(`${file}\u0000${lit.value}`);
          continue;
        }
        offenders.push(`${file}:${lit.line} 字面量「${lit.value.slice(0, 48)}」`);
      }
    } else if (file.endsWith('.html')) {
      for (const line of findAll(htmlCopyOnly(file), '照片')) {
        offenders.push(`${file}:${line} HTML 文案`);
      }
    } else {
      for (const line of findAll(cssCopyOnly(file), '照片')) {
        offenders.push(`${file}:${line} CSS 文案`);
      }
    }
  } catch (error) {
    parseFailures.push(`${file}: ${error && error.message}`);
  }
}

check(
  '夹具自证：每个载体都解析成功（解析失败会被吞成「零命中」= 假绿）',
  parseFailures.length === 0,
  parseFailures.slice(0, MAX_DETAIL).join(' | '),
);
check(
  '🔴 界面文案零「照片」（前端混用会让用户以为「图片」与「照片」是两种东西）',
  offenders.length === 0,
  offenders.slice(0, MAX_DETAIL).join(' | ') + (offenders.length > MAX_DETAIL ? ` …共 ${offenders.length} 处` : ''),
);

// 防过期：豁免项必须**仍因含「照片」**才被豁免。
for (const a of ALLOWED_LITERALS) {
  check(
    `白名单不许过期：${path.basename(a.file)} 里仍有那条「实况照片」（${a.why}）`,
    seenAllowed.has(`${a.file}\u0000${a.literal}`),
    '没命中任何字面量 ⇒ 这条豁免已退化成永远不命中的豁免，必须删掉或更新',
  );
}

// ============================================================ 2. 数据侧（必须保留旧词）

section('2. 数据侧：三处必须**保留**「照片」（顺手统一 = 已建索引的分数口径作废）');

const embedding = require(path.join(ROOT, 'src/ai/embedding.js'));
check(
  '🔴 ai/embedding.js#GENERIC_TEXT 仍是「一张照片 a photo」（数据不是文案；此前**无任何守护**）',
  embedding.GENERIC_TEXT === '一张照片 a photo',
  `实际 ${JSON.stringify(embedding.GENERIC_TEXT)}`,
);

const clipVocab = require(path.join(ROOT, 'src/ai/search-vocabulary.js'));
check(
  "🔴 CLIP 词表 search-vocabulary.js#TERMS 仍含 '黑白照片'（zh 是用户点的那一下、en 直接进模型前向）",
  Array.isArray(clipVocab.TERMS) && clipVocab.TERMS.some((p) => p && p[0] === '黑白照片'),
);

const tagVocab = require(path.join(ROOT, 'src/ai/tag-vocabulary.js'));
check(
  '🔴 tag 词表 tag-vocabulary.js 仍含标签「黑白照片」（唯一词源，下标与随包标签表对齐）',
  !!tagVocab.TERMS && Object.prototype.hasOwnProperty.call(tagVocab.TERMS, '黑白照片'),
);

// ============================================================ 3. 具体取值契约

section('3. 三个取值契约（2026-10-07 用户逐条拍板的具体取值）');

{
  const i18n = read('src/renderer/i18n.js');
  check(
    'nav.folders 中文 =「文件夹」（英文 Folders）—— 别退回「文件」，那会与「所有文件」撞词',
    /'nav\.folders'\s*:\s*'文件夹'/.test(i18n) && /'nav\.folders'\s*:\s*'Folders'/.test(i18n),
  );

  const webLits = jsLiterals('src/web/js/app.js').map((x) => x.value);
  check(
    '网页端 view=all 档位标签 =「所有文件」（该落点**不筛媒体类型**，叫「所有图片」会误导）',
    webLits.some((v) => v.includes('所有文件')),
  );

  const manifest = JSON.parse(read('src/web/manifest.webmanifest'));
  check(
    'PWA 描述走新词（含「图片」、不含「照片」）',
    typeof manifest.description === 'string' &&
      !manifest.description.includes('照片') &&
      manifest.description.includes('图片'),
    String(manifest.description),
  );

  const KT = 'android-app/app/src/main/kotlin/com/foredawn/aurora/ui/screens/BrowseScreen.kt';
  check(
    'Android Compose 字面量零「照片」（**连注释也不许** —— 注释与界面不一致会让人照着注释写回旧词）',
    !read(KT).includes('照片'),
  );
}

// ============================================================ 收尾

process.stdout.write('[ui-wording-regression] 界面用词契约（照片 → 图片，双向）\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[ui-wording-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write(
  '\n[ui-wording-regression] PASS（' + notes.filter((n) => n.includes('\u2713')).length + ' 项）\n',
);
