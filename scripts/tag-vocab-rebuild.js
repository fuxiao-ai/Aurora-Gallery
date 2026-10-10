'use strict';

/**
 * 一键重建「tag 词表」的**结构层**快照，并告诉你还需要重跑什么。
 *
 * ## 为什么需要这个脚本（更新机制的中间一环）
 *
 * 这条链上有两个东西会变，而它们的**代价差三个数量级**：
 *
 *   - **结构层**（标签表指纹、词表规模、预选词候选池、中文名字典覆盖率）—— 读文件就能算，**秒级**；
 *   - **行为层**（每个词在真实语料上的命中数：`n55`/`max`）—— 要对 1500 张跑 JoyTag，**实测 1002 s**。
 *
 * 把两者混成一个「重跑」命令，结果是**要么每次都付 1002 s（于是没人愿意跑），
 * 要么只更新结构层却把行为层快照一起刷新（于是伪造了「已重测」）**。两种都会让
 * 「这条词有没有内容」这个结论失去可信度。所以本脚本**只做结构层**，并且：
 *
 * ## 🔴 本脚本绝不修改 `tag-vocab-coverage.json`
 *
 * 那个文件是**实测结论**（「这个词在这个语料上命中过几次」）。如果这里顺手把它的
 * `labelFile` 指纹刷新，就等于在**没有重测**的情况下宣布「重测过了」—— 守护会立刻变绿，
 * 而数字还是旧标签表上的旧数字。这是最坏的一种假绿：**证据没变，但看起来是新的**。
 * 所以这里只**读**它、只**报告它过期了**，刷新它必须跑真正的重测：
 *
 *     ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
 *       .workbuddy/bench/run-tag-vocab-validate.js      # 1002 s，出新的逐标签分数
 *     ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
 *       .workbuddy/bench/report-tag-vocab.js            # 翻译成覆盖率快照（直写 scripts/）
 *
 * 用法: node scripts/tag-vocab-rebuild.js [--check]
 *   `--check` 只报告、不写结构快照（给「我现在该跑什么」这个提问用）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LABELS = require(path.join(ROOT, 'src', 'ai', 'tag-labels.js'));
// 指纹口径的**唯一源**：绝不在本脚本里重写一遍（两边各写一份 ⇒ 一个说「没变」一个说「变了」）
const { TERMS, vocabFingerprint } = require(path.join(ROOT, 'src', 'ai', 'tag-vocabulary.js'));
const { TERMS: QUERY_TERMS } = require(path.join(ROOT, 'src', 'ai', 'search-vocabulary.js'));

const STRUCT_FILE = path.join(__dirname, 'tag-vocab-structure.json');
const COVERAGE_FILE = path.join(__dirname, 'tag-vocab-coverage.json');
const OUT_DIR = path.join(ROOT, '.workbuddy', 'bench', 'out');
const CHECK_ONLY = process.argv.includes('--check');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------- 算当前的结构层 ----------
const labelFp = LABELS.fingerprint();
const labelSet = new Set(LABELS.labels());
const selectable = LABELS.selectableIndexes();

const keys = Object.keys(TERMS);
const supportedKeys = keys.filter((k) => (TERMS[k].tags || []).length);
const referenced = new Set();
for (const key of keys) for (const tag of TERMS[key].tags || []) referenced.add(tag);

// 词表引用了但标签表里没有的标签 —— 这些词在这条路线上恒 0 命中（守护也会抓）
const dangling = [...referenced].filter((tag) => !labelSet.has(tag));
// 词表把某个标签声明成 missing，但它其实在表里 —— 白白丢掉一个可用词
const falseMissing = [];
for (const key of keys) {
  for (const tag of TERMS[key].missing || []) if (labelSet.has(tag)) falseMissing.push(key + '→' + tag);
}
// 308 查询词表是否被全覆盖
const vocabKeys = new Set(keys);
const uncovered = QUERY_TERMS.map((p) => p[0]).filter((k) => !vocabKeys.has(k));

const pool = new Set(selectable.map((i) => LABELS.labelAt(i)));
const namedInPool = [...pool].filter((tag) => referenced.has(tag));

const struct = {
  generatedAt: new Date().toISOString(),
  labelFile: labelFp,
  vocab: {
    fingerprint: vocabFingerprint(TERMS),
    terms: keys.length,
    supported: supportedKeys.length,
    unsupported: keys.length - supportedKeys.length,
    tagsReferenced: referenced.size,
  },
  pool: {
    selectable: selectable.length,
    excluded: labelFp.lines - selectable.length,
    // 候选池里有多少能显示中文名（分母是候选池）—— 直接量化「用户点开预选词会看到多少英文」
    chineseNamed: namedInPool.length,
  },
};

// ---------- 与上一版对比 ----------
const prev = readJson(STRUCT_FILE);
const coverage = readJson(COVERAGE_FILE);

const labelChanged = Boolean(prev && prev.labelFile && prev.labelFile.sha256 !== labelFp.sha256);
const vocabChanged = Boolean(prev && prev.vocab && prev.vocab.fingerprint !== struct.vocab.fingerprint);

// 覆盖率快照（行为层）是否还对得上
const covFp = coverage && coverage.labelFile ? coverage.labelFile.sha256 : null;
const covNoFingerprint = Boolean(coverage) && !covFp;
const covLabelStale = Boolean(covFp) && covFp !== labelFp.sha256;
const covMissingTerms = coverage && coverage.terms ? keys.filter((k) => !coverage.terms[k]) : keys;
const covExtraTerms = coverage && coverage.terms ? Object.keys(coverage.terms).filter((k) => !vocabKeys.has(k)) : [];
const covMappingChanged = [];
if (coverage && coverage.terms) {
  for (const key of keys) {
    const c = coverage.terms[key];
    if (!c || !c.supported) continue;
    const before = (c.tags || []).join(',');
    const now = (TERMS[key].tags || []).join(',');
    if (before !== now) covMappingChanged.push(key + ': ' + before + ' → ' + now);
  }
}

// ---------- 报告 ----------
const L = [];
const say = (s) => L.push(s === undefined ? '' : s);

say('=== tag 词表 · 结构层重建 ===');
say('');
say('标签表        ' + labelFp.lines + ' 行 / ' + labelFp.bytes + ' B   sha256 ' + labelFp.sha256.slice(0, 16) + '…');
say('词表          ' + struct.vocab.terms + ' 词（可用 ' + struct.vocab.supported + ' / 不可用 ' +
  struct.vocab.unsupported + '）   引用标签 ' + struct.vocab.tagsReferenced + ' 个   指纹 ' + struct.vocab.fingerprint);
say('预选词候选池  ' + struct.pool.selectable + ' / ' + labelFp.lines + '（剔除 ' + struct.pool.excluded +
  ' 条元数据/成人标签）');
say('  其中能显示中文名的 ' + struct.pool.chineseNamed + ' 个 = ' +
  ((struct.pool.chineseNamed / struct.pool.selectable) * 100).toFixed(1) + '%' +
  '   ← 其余候选点开是英文标签原文');
say('');

say('--- 结构检查 ---');
say('  词表引用但标签表没有的标签 : ' + dangling.length + (dangling.length ? '  🔴 ' + dangling.slice(0, 20).join(' ') : ''));
say('  missing 误报（真标签当缺） : ' + falseMissing.length + (falseMissing.length ? '  🔴 ' + falseMissing.slice(0, 20).join(' ') : ''));
say('  308 查询词表未覆盖         : ' + uncovered.length + (uncovered.length ? '  🔴 ' + uncovered.slice(0, 20).join(' ') : ''));
say('');

say('--- 与上一版结构快照对比 ---');
if (!prev) {
  say('  （无上一版，这是第一次生成）');
} else {
  say('  标签表 : ' + (labelChanged ? '🔴 变了（旧 ' + String(prev.labelFile.sha256).slice(0, 16) + '… → 新 ' + labelFp.sha256.slice(0, 16) + '…）' : '未变'));
  say('  词表   : ' + (vocabChanged ? '🔴 变了（旧 ' + prev.vocab.fingerprint + ' → 新 ' + struct.vocab.fingerprint + '）' : '未变'));
}
say('');

say('--- 行为层（覆盖率快照）状态 ---');
if (!coverage) {
  say('  🔴 coverage 快照不存在 ⇒ 必须跑一次语料验证');
} else {
  say('  语料 ' + coverage.corpus + ' 张 @ T=' + coverage.threshold +
    '   指纹 ' + (covFp ? covFp.slice(0, 16) + '…' : '（无指纹：快照早于本次机制改造）'));
  say('  标签表一致性 : ' + (covNoFingerprint ? '🔴 快照里没有指纹，无法确认它测的是哪一版' :
    covLabelStale ? '🔴 过期（测的是另一版标签表）' : '✅ 一致'));
  say('  缺词条       : ' + covMissingTerms.length + (covMissingTerms.length ? '  🔴 ' + covMissingTerms.slice(0, 20).join(' ') : ''));
  say('  多余词条     : ' + covExtraTerms.length + (covExtraTerms.length ? '  （词表已删但快照还有） ' + covExtraTerms.slice(0, 12).join(' ') : ''));
  say('  映射变了的词 : ' + covMappingChanged.length);
  for (const line of covMappingChanged.slice(0, 12)) say('      ' + line);
}
say('');

// ---------- 下一步 ----------
const mustRerunCorpus =
  !coverage || covNoFingerprint || covLabelStale || covMissingTerms.length > 0 || covMappingChanged.length > 0;

say('--- 下一步 ---');
if (dangling.length || falseMissing.length) {
  say('  🔴 先修词表：上面「结构检查」里红掉的条目不修，跑多少次语料验证都没用。');
}
if (mustRerunCorpus) {
  say('  ① 必须重跑语料验证（约 1002 s，出新的逐标签分数）：');
  say('       ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe .workbuddy/bench/run-tag-vocab-validate.js');
  say('  ② 再翻译成覆盖率快照（秒级，会直写 scripts/tag-vocab-coverage.json）：');
  say('       ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe .workbuddy/bench/report-tag-vocab.js');
} else {
  say('  ✅ 行为层快照仍然有效，无需重跑语料。');
}
say('  ③ 最后跑守护确认：node scripts/run-regressions.js --only tag-vocab-regression');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'tag-vocab-rebuild.txt'), L.join('\n') + '\n');

if (!CHECK_ONLY) {
  fs.writeFileSync(STRUCT_FILE, JSON.stringify(struct, null, 1) + '\n');
  say('');
  say('结构快照已写 scripts/tag-vocab-structure.json');
}

console.log(L.join('\n'));
