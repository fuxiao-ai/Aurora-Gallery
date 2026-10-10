'use strict';

/**
 * 组织元数据（评分 / 标记 / 用户标签）的**取值域**与**筛选谓词构造**。
 *
 * ## 为什么是独立叶子模块，而不是留在 database.js 里
 *
 * 筛选条件要同时被两条查询实现用到：
 *   · `src/database.js`（主进程同步路：`getPhotos` / `getFolderPhotos` / `searchPhotos`
 *     / `_buildPreviewScopeWhere`）；
 *   · `src/db-heavy-read.js`（读 Worker 的实际执行体：`runGetDatePhotos`，以及与
 *     `database.js` 同源的那批聚合查询）。
 *
 * 而 `db-heavy-read.js` **不能** `require('./database')`：`database.js` 反过来 require 它
 * （`getDatePhotos` 就是委托过去的），形成循环。循环 require 在 Node 里不会当场炸，
 * 而是取决于谁先被加载 —— 那是一种「有时拿得到、有时是空对象」的故障。
 *
 * 所以判据与取值域放在这里（无依赖、可被两边安全 require），两边都从这里取。
 * 这与 `photo-list-columns.js` / `exif-meta.js` / `thumb-format.js` 是同一个理由：
 * **一份判据要被两条查询实现共用时，它必须住在叶子模块里。**
 *
 * 🔴 「各写一份」在这个工程里是有明确前科的：`_pushMediaTypeCondition` 的 `join(' AND ')`
 *    漏在 `getFolderPhotos` 上，症状是「视频」档把图片也列出来，实测 11 行（应为 5）。
 *    而它**不报错、不写日志**，只在有人手工数结果行数时才暴露。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 取值域
// ─────────────────────────────────────────────────────────────────────────────

/** 评分取值域：0 = 未评分，1-5 = 星级。 */
const RATING_MIN = 0;
const RATING_MAX = 5;

/**
 * 标记取值域。`'none'` 是**合法值**（= 取消标记），不是「没有值」——
 * 这与 `live_still_id` 那种「NULL 表示没探查过」的三态不同，别混。
 */
const FLAG_VALUES = ['none', 'pick', 'reject'];

// ─────────────────────────────────────────────────────────────────────────────
// 归一函数 —— 这三个是各自取值域的**唯一实现处**
//
// 界面、IPC、HTTP 三条入口最终都汇到 `setPhotoRating` / `setPhotoFlag` / `setPhotoTags`，
// 归一必须发生在**最靠内**的这里，而不是在每个入口各写一遍 —— 各写一份的结果是
// 「网页端能用 7 星、桌面端不能」这种分叉，而且不报错。
// 契约见 `docs/contracts/org-metadata.md`。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归一评分：夹取到 0-5 的整数。
 *
 * 🔴 取**夹取**而不是抛错：评分是高频盲操作（冲片时按数字键连打），为一次越界把整个
 *    操作失败掉，用户看到的是「按了没反应」，比夹到边界更糟。
 * 🔴 非数字 / NaN 一律落 0（= 取消评分），与界面「再按一次同一颗星即取消」的语义一致。
 *    绝**不**落成 NULL 或负数：筛选里的「未评分」档就是 `rating = 0`，
 *    多一个 NULL 会让那一档的判据分裂成两支（而漏掉一支的症状是「有些没评分的图筛不出来」）。
 */
function normalizeRating(value) {
  const n = parseInt(value, 10);
  if (!isFinite(n) || n <= RATING_MIN) return RATING_MIN;
  if (n >= RATING_MAX) return RATING_MAX;
  return n;
}

/**
 * 归一标记：白名单外的任何值都落 `'none'`。
 *
 * 🔴 白名单**必须**是穷举的。界面只会给三个值，但 IPC 与 HTTP 都是外部输入，
 *    写进一个奇怪的值（比如 `'true'` / `'PICK'` 之外的东西）会让所有按 flag 筛选的
 *    查询出现无法解释的结果 —— 而那种行在界面上**根本不显示**，排查时看不见。
 *    这里顺手做了大小写归一，所以 `'PICK'` 是合法的。
 */
function normalizeFlag(value) {
  const v = String(value == null ? '' : value)
    .trim()
    .toLowerCase();
  return FLAG_VALUES.indexOf(v) >= 0 ? v : 'none';
}

/**
 * 归一标签的**键**（写进 `tags.normalized_name`，UNIQUE 就建在它上面）：
 * 折叠内部连续空白 + 去首尾空白 + 转小写。
 *
 * 🔴 大小写不敏感是**刻意的**：中文没有大小写，但标签里混英文是常态
 *    （人名 / 品牌 / 项目代号），而冲片时没人会去计较大小写 ——
 *    「客户A」与「客户a」必须算同一个标签，否则用户会得到两个看起来一模一样的 chip。
 *    中文本身不受 toLowerCase 影响，所以这一步对纯中文标签是空操作。
 * 🔴 这是本键的唯一生成处，别在别处再写一遍 trim/lower。
 */
function normalizeTagName(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 归一标签的**显示名**：只折叠空白、**保留大小写**（用户写的原文要原样显示）。
 *
 * 与 `normalizeTagName` 的分工：那个做键（比较用），这个做值（显示用）。
 * 两个函数都保留是必要的 —— 只留一个的话，要么标签列表里全是小写，
 * 要么「客户A」和「客户a」变成两个标签。
 */
function normalizeTagDisplayName(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 筛选谓词构造
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把组织元数据（评分 / 标记 / 标签）三个筛选维度推进条件收集器。
 *
 * 抽成一个函数而不是在各查询里各写一份：桌面端浏览列表（`getPhotos`）、目录页
 * （`getFolderPhotos`）、日期页（`runGetDatePhotos`）、搜图页（`searchPhotos`）、
 * 标签导航页（`fetchTagNavPhotoRows`）、预览作用域（`_buildPreviewScopeWhere`）
 * 六处要用同一套判据 —— 各写一份必然漂移，而漂移的症状是「列表筛出来的和预览
 * 翻页翻到的不是同一批图」，只在翻到页边界或按「上一张/下一张」时才看得出来。
 * 契约见 `docs/contracts/org-metadata.md`「筛选作用域」章。
 *
 * ## 🔴 判据必须是 `!= null`，不能是 truthy
 *
 * `rating = 0`（未评分）与 `flag = 'none'`（未标记）都是**合法筛选值**，
 * 而且是冲片工作流里最常查的两档（「还剩哪些没标」）。写成 `if (opts.rating)`
 * 会让「筛未评分」静默变成「不筛」—— 界面上看起来只是「筛选没生效」，不报错。
 * `''` 单独排除是因为它来自 HTML `<select>` 的「未选择」空项，语义是「不限」。
 *
 * ## 标签：AND 语义（选了多个 = 必须同时具备全部）
 *
 * 取舍：OR（任一）会让勾选越多结果越多，与「逐步收窄」的直觉相反；
 * 用户选「客户 A」+「2024」时想要的是交集。实现用一次扫描 + `HAVING COUNT(*)`
 * 而不是 N 个 `EXISTS` 子查询 —— 后者在百万行库上是 N 倍回表。
 *
 * ⚠️ 用 `COUNT(*)` 而不是 `COUNT(DISTINCT tag_id)`：`photo_tags` 是
 *    `(photo_id, tag_id)` 联合主键 ⇒ 同一对不可能重复，两者恒等，
 *    而 `COUNT(*)` 不必建临时去重表。**前提是那个主键还在**，改表时当心。
 *
 * ⚠️ 子查询里写的是 `photos.id`（带表名前缀）而不是裸 `id`：本函数被
 *    `getPhotos`（`FROM photos`）与带 JOIN 的查询共用，裸 `id` 会有歧义。
 *
 * ⚠️ 调用方**不要**把这个函数产出的片段塞进 `favoritesOnly` 那种「先拼字符串再
 *    展开参数」的表达式里而忘了按顺序展开 `params`：占位符顺序必须与绑定顺序一致。
 *    各处调用点都是「先攒 conditions/params、最后一次性拼」的写法，照抄即可。
 *
 * @param {string[]} conditions 谓词片段收集器（不含前导 ` AND`），原地 push
 * @param {any[]} params 绑定值收集器，顺序与 conditions 里占位符出现顺序一致
 * @param {object} [options] 查询选项；认得 `rating` / `flag` / `tagIds`
 */
function pushOrgMetaConditions(conditions, params, options) {
  const opts = options || {};

  if (opts.rating != null && opts.rating !== '') {
    conditions.push('rating = ?');
    params.push(normalizeRating(opts.rating));
  }

  if (opts.flag != null && opts.flag !== '') {
    conditions.push('flag = ?');
    params.push(normalizeFlag(opts.flag));
  }

  const tagIds = Array.isArray(opts.tagIds) ? opts.tagIds : [];
  const ids = [];
  for (let i = 0; i < tagIds.length; i++) {
    const tid = parseInt(tagIds[i], 10);
    if (isFinite(tid) && tid > 0 && ids.indexOf(tid) < 0) ids.push(tid);
  }
  if (ids.length) {
    const marks = ids.map(() => '?').join(', ');
    conditions.push(
      'photos.id IN (SELECT photo_id FROM photo_tags WHERE tag_id IN (' +
        marks +
        ') GROUP BY photo_id HAVING COUNT(*) = ?)',
    );
    for (let j = 0; j < ids.length; j++) params.push(ids[j]);
    params.push(ids.length);
  }
}

/**
 * 有没有「非默认」的组织元数据筛选 —— 用来决定是否放弃为「无筛选」标定的
 * 索引快路径（见 `searchPhotos` 的 `nameOnly` 分支与 `hasExtraFilter`）。
 *
 * ⚠️ 与 `pushOrgMetaConditions` 的判据**必须同源**：这里说「有筛选」而那边没 push，
 *    或者反过来，都会得到一个只在特定参数下出现的错误结果。所以判据也只写这一份，
 *    调用方一律调本函数，不许自己写 `options.rating || options.flag` 那种。
 */
function hasOrgMetaFilter(options) {
  const opts = options || {};
  if (opts.rating != null && opts.rating !== '') return true;
  if (opts.flag != null && opts.flag !== '') return true;
  const tagIds = Array.isArray(opts.tagIds) ? opts.tagIds : [];
  for (let i = 0; i < tagIds.length; i++) {
    const tid = parseInt(tagIds[i], 10);
    if (isFinite(tid) && tid > 0) return true;
  }
  return false;
}

module.exports = {
  RATING_MIN,
  RATING_MAX,
  FLAG_VALUES,
  normalizeRating,
  normalizeFlag,
  normalizeTagName,
  normalizeTagDisplayName,
  pushOrgMetaConditions,
  hasOrgMetaFilter,
};
