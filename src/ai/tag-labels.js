'use strict';

/**
 * JoyTag 标签表的**唯一访问入口**。
 *
 * ## 这份文件为什么必须存在
 *
 * `joytag-labels.txt` 是 JoyTag 模型的**输出维度表**：5813 行、一行一个标签、
 * **顺序即输出下标**。这意味着它同时是三种东西的契约：
 *
 *   1. 模型输出向量第 `i` 维 → 标签名（`labels()[i]`）；
 *   2. 建 tag 倒排索引时 `tag_id = 下标`（顺序一变，全库索引静默错位）；
 *   3. 预选词候选池（界面给用户点的词）。
 *
 * 原来没有任何模块读它 —— `scripts/tag-vocab-regression.js` 直接 `fs.readFileSync`，
 * 于是「标签表是哪一版」这件事只有守护知道，产品代码一无所知。更糟的是：
 * **手工往表里插一行会让全库 tag 索引的下标集体后移，而所有静态守护照样全绿** ——
 * 这正是「静态全绿、线上失效」的教科书形态。
 *
 * 所以这里做三件事：统一入口、算得出指纹（供快照冻结 + 守护比对）、
 * 给出「这个标签能不能当界面预选词」的唯一判据。
 *
 * ## 指纹不是版本号，是内容哈希
 *
 * `fingerprint()` 返回 `joytag-labels.txt` 的 sha256 + 行数。**不要手写版本号**：
 * 手写的版本号在「改了内容忘了抬号」时完全无效，反而是内容哈希一定抓得到；
 * 而「改了内容」正是唯一需要触发的条件。快照把指纹冻住，守护每次比对，
 * 不符就要求重跑 `scripts/tag-vocab-rebuild.js` —— 更新机制由此**不依赖人的记性**。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'joytag-labels.txt');

/** JoyTag 的输出维度。改动了它说明换了一版模型，索引必须整体重建。 */
const EXPECTED_LINES = 5813;

let raw = null;
let index = null;

/** 读一次，之后走缓存（5813 行 < 80 KB，常驻不值得心疼）。 */
function read() {
  if (raw) return raw;
  const buffer = fs.readFileSync(FILE);
  const lines = buffer
    .toString('utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  // 原文件的最后一行**没有换行符**（`wc -l` 会报 5812），所以只去掉空尾项
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  raw = { buffer, lines };
  return raw;
}

/** 全部标签，顺序即下标。返回副本：调用方改它不该影响别人。 */
function labels() {
  return read().lines.slice();
}

/** 下标 → 标签。越界返回 `null`（不抛：脏索引数据不该打挂调用方）。 */
function labelAt(i) {
  const n = Number(i);
  if (!Number.isInteger(n) || n < 0 || n >= read().lines.length) return null;
  return read().lines[n];
}

/** 标签 → 下标。标签表里没有则 `-1`。 */
function indexOf(tag) {
  if (!index) {
    index = new Map();
    read().lines.forEach((label, i) => index.set(label, i));
  }
  return index.has(tag) ? index.get(tag) : -1;
}

/** 标签表指纹。快照冻结它、守护比对它 —— 这是「更新机制」的检测端。 */
function fingerprint() {
  const { buffer, lines } = read();
  return {
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    lines: lines.length,
    bytes: buffer.length,
  };
}

/**
 * 元数据 / 媒介 / 画质 / 纯色背景 —— 当界面预选词没有任何意义。
 *
 * 这份清单是**显式枚举**而不是正则：它只有 37 条，来自对全表的逐条过目
 * （`.workbuddy/bench/tag-label-classify.js`），显式清单可审计、可 diff；
 * 正则在这里只会带来「以为过滤了其实漏了」的错觉。
 *
 * ⚠️ 这份表**只增不减**是错的 —— 换标签表时要重新过一遍（rebuild 脚本会打印
 * 「新增的标签里有哪些落进了 META 之外的档」，供人复核）。
 */
const META = new Set([
  'simple_background', 'white_background', 'grey_background', 'blue_background', 'pink_background',
  'black_background', 'brown_background', 'green_background', 'red_background', 'yellow_background',
  'purple_background', 'orange_background', 'gradient_background', 'two-tone_background',
  'checkered_background', 'polka_dot_background', 'striped_background', 'photo_background',
  'photoshop_(medium)', 'photo_(medium)', 'marker_(medium)', 'watercolor_(medium)',
  'traditional_media', 'artist_name', 'twitter_username', 'web_address', 'english_text',
  'sketch', 'comic', 'monochrome', 'greyscale', 'spot_color', 'original', 'chibi', 'realistic',
  '3d', 'pixel_art',
]);

/**
 * 成人内容 —— **摆到界面上是产品问题**，所以不进预选词候选池。
 *
 * 两条刻意的取舍：
 *
 *   - **服饰类一律保留**：`underwear` / `lingerie` / `bikini` / `panties` / `pantyhose` /
 *     `bra` 都是「画面里看得见的东西」，本库（cosplay 图包）里是主力内容，
 *     删了是静默损失。
 *   - **`bondage` / `shibari` 保留**：这不是漏判 —— 实测本库有 119 张绳艺图，
 *     用户在 `probes.js` 里明确要搜「绳艺」，JoyTag 在正样本上给 `bondage` 打 **0.7738**。
 *     把它按「成人」过滤掉，等于把用户真实想要的能力砍掉。过滤的目标是**裸露与性行为**，
 *     不是「与性沾边的题材」。
 *
 * 词边界用 `(^|_)…(_|$)`：`loli` 是成人标签，但 `lolita_fashion` / `gothic_lolita`
 * 是**服装风格**（能搜、该留）。用裸子串匹配会把后者一起误杀 —— 这正是第一版
 * 分类脚本踩过的坑（`hololive` 被 `loli` 命中）。
 */
const ADULT = /(^|_)(nipples?|puffy_nipples|inverted_nipples|covered_nipples|areola[es]?|areola_slip|large_areolae|nude|naked|completely_nude|clothed_female_nude_male|clothed_sex|pussy|spread_pussy|pussy_juice|penis|veiny_penis|multiple_penises|sex|sexual|sexually_suggestive|penetration|vagina|anus|pubic_hair|female_pubic_hair|male_pubic_hair|crotch|crotch_seam|covering_crotch|cum|cum_in_pussy|semen|ejaculation|orgasm|masturbation|female_masturbation|fellatio|paizuri|handjob|footjob|anal|tentacles?|rape|guro|snuff|topless|topless_male|bottomless|undressing|no_bra|no_panties|underboob|sideboob|downblouse|upskirt|wardrobe_malfunction|lactation|bulge|futanari|futa|dickgirl|shemale|explicit|hentai|lewd|nsfw|sex_toy|group_sex|after_sex|wet_clothes|thigh_gap|blood|blood_on_face|gore|loli|shota)(_|$)/;

/**
 * 这个标签能不能作为界面预选词。
 *
 * 判据是**保守**的：只剔除「当按钮摆出去明显不合适」的两档，
 * 剩下的一律留着 —— 反正候选池最终由**本库真实命中数**排序，没内容的词自然沉底。
 * 反过来「多剔一个」是静默损失，「少剔一个」只是排序里多一个条目。
 */
function isSelectable(tag) {
  const t = String(tag == null ? '' : tag).trim();
  if (!t) return false;
  if (META.has(t)) return false;
  if (ADULT.test(t)) return false;
  return true;
}

/** 预选词候选池（保序）。返回标签名不是下标 —— 候选池是给人看的。 */
function selectableLabels() {
  return read().lines.filter(isSelectable);
}

/** 候选池的下标集合。建索引/排序时用下标比用字符串便宜。 */
function selectableIndexes() {
  const out = [];
  read().lines.forEach((label, i) => {
    if (isSelectable(label)) out.push(i);
  });
  return out;
}

module.exports = {
  FILE,
  EXPECTED_LINES,
  labels,
  labelAt,
  indexOf,
  fingerprint,
  isSelectable,
  selectableLabels,
  selectableIndexes,
  META,
};
