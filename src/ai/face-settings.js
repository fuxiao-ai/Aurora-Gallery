'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 人脸归组设置。
 *
 * ## 三种归组方式
 *
 * - `cluster`（默认）**视觉聚类**：按人脸特征向量的相似度分组。不依赖目录结构，
 *   对任意图片都能work，但它分的是「这张脸长什么样」而不是「这是谁」——
 *   本库是重度修图的 cosplay（同一人换假发 / 瞳色 / 角色，跨角色相似度能掉到 0.3 以下；
 *   不同人化同风格妆又能冲到 0.5），所以它**做不到准确分人**，只能做到"大致可用"。
 * - `folder` **按文件夹归组**：同一层目录 = 同一个人。用户自己的目录约定
 *   （`K:\COS\116` 这种编号目录 = 一个人）本身就是最准的答案，直接采信。
 *   在这类库上它接近 100% 准确，代价是要求图片本来就按人分目录，且**不比对特征**：
 *   一个文件夹里若真有两个人，它也会并成一个（而且错得看不出来）。
 * - `scoped` **按目录分域聚类**：把目录当**硬边界**（跨域绝不相干），域**内**再按特征
 *   聚类。目录是权威、特征只在目录内部细分辨认。于是：
 *     - 目录=人 时，输出与 `folder` 一致（连自动目录名都一样）；
 *     - 一个目录里有多个人时，**自动拆开**（这是 `folder` 做不到的），代价是拆出来的
 *       组没有名字（不会拿目录名去冒充），等人来命名；
 *     - 同一个人的图片散在多个目录时，用 `domainGroups` 手工把那几个目录圈成一个域。
 *
 *   ⚠️ 为什么不让 `folder` 自己去比对特征（「混合模式」）：`folder` 的价值恰恰在于
 *   **它是唯一不依赖模型精度的路**，混进特征就把它变成了「cluster 的另一种参数」，
 *   保底能力随之消失。所以扩展走新增模式，不动 `folder` 的语义。
 *
 *   ⚠️ 域内聚类用的是**同一套阈值与 CW 参数**，但连边范围被限制在域内，所以
 *   「域内脸数」比整库少很多 —— 实测本库单域 150–1394 张脸在 0.30 下每个域都收敛成
 *   一个主簇（1394 张的 116 也是 1 组），比全局聚类（6 人 → 11 组）干净得多：
 *   域边界挡住了跨目录的竞争，同一人不会再被别的目录"拽走"。
 *
 *   ⚠️ 手工圈域（`domainGroups`）按**目录名**匹配（叶子名，如 `116`），所以两个根下
 *   同名的目录会被一起圈进同一个域。域内不同的人不会被硬黏在一起（聚类照常分），
 *   域只是放宽了「谁可以和谁比」。
 *
 * ## 阈值 0.30 的来历（换识别器 + 换聚类算法之后重新标定）
 *
 * 2026-09-29 做了两件事：识别器从 OpenCV SFace（128 维）换成 **InsightFace w600k_mbf**
 * （512 维，julyx10/lap 用的那个），聚类从「边扫边贪心」换成 **Chinese Whispers**
 * （同样是 LAP 的做法）。
 *
 * ⚠️ **不能只用整库那一组数字定档。** Chinese Whispers 的连边密度随库的大小变化
 * （n 小时 Top-K 剪枝不起作用、图更密），最优阈值会漂。所以除了整库（3501 张脸）
 * 还用**线上模块本体**在 124 张脸 / 250 张脸上各复验了一遍：
 *
 *   阈值   整库 3501 张          250 张               124 张
 *   0.20   7 组 · 12 块 · 0.879  **塌成 2 组（P 0.21）**  塌成 2 组
 *   0.25   7 组 · 12 块 · 0.881  4 组（P 0.23）· 0.376   —
 *   0.30  11 组 · 12 块 · 0.883  8 组 · 13 块 · 0.704   6 组 · 9 块 · 0.817   ← 默认
 *   0.35  17 组 · 13 块 · 0.901  8 组 · 12 块 · 0.674   —
 *   0.40  28 组 · 14 块 · 0.935  13 组 · 15 块 · 0.902  14 组 · 14 块 · 0.885
 *   0.45  55 组 · 14 块 · 0.948  20 组 · 21 块 · 0.923  —
 *
 * （「块」= 每个真值人散落在多少个预测簇里，≥1% 成员才算一块；真值是 6 个人。）
 *
 * **为什么不是 F1 最高的 0.45，也不是整库最优的 0.20**：
 *   - 0.20 在整库上是 0.879，但**小库上会整库塌成 2 组** —— 阈值不能只在一种规模上
 *     成立，新用户装的库可能只有几百张脸；
 *   - 0.45 的 F1 是 0.948，代价是整库会给出约 **55 个「人物」**（真值 6 个），
 *     多出来的全是同一个人 / 边缘脸的小碎片；
 *   - **0.30 是唯一在三档规模上组数都接近真值的**（11 / 8 / 6 组，真值 6），
 *     碎片数也稳定在 9–13 块。判据不止 F1 一项 —— 「组数」是用户直接看到的数字，
 *     「一个人被切成几块」才是他抱怨的症状，两者都指向同一个人。
 *   - 配合既有的取舍原则：**并错人是一次可见、一键可拆的错误；凭空多出一个人则会
 *     自我繁殖**（每看到一个陌生人物就要判断一次，它还会继续吸走新脸）。宁可少分不乱分。
 *
 * 对照换之前（SFace + 贪心，整库同一套判据）：最优 F1 0.817 @0.22、组数 12、
 * 同一个人被切成 7/6/3/8/8/7 = **39 块**。
 *
 * ⚠️ 量纲**变过两次**，两代老数字都不可照搬：
 *   1. 旧版比「与组内**最早那张脸**的相似度」，随后改成「与组内抽样成员的**平均**」
 *      （平均天然低于单张对单张，所以 0.55 → 0.20）；
 *   2. 聚类换成 Chinese Whispers 后，阈值变成**配对级**的连边门槛（不再是组内平均），
 *      识别器换成 w600k_mbf 又让同人相似度整体更低（中位 0.389 vs SFace 0.422）。
 *      `settings.json` 的 `version` 字段就是为这几次迁移准备的。
 *
 * ## Chinese Whispers 的参数为什么不是 LAP 的原值
 *
 * LAP 的 `K_NEIGHBORS = 80` 是给他们那套数据调出来的。本库同数据 8 个种子的 F1 均值：
 *   K=80 → 0.778（种子间 0.666–0.856）；K=400 → 0.879–0.948；K=800 → 低阈值时会
 *   整库塌成 1 组（0.30 时 P 只有 0.255）。所以取 **K=400**。详见 docs/people-groups.md。
 *
 * ## 抽样用 `Math.floor(k * len / n)` 取**固定 n 个**而不是 `step` 步进（`step` 会让
 * 抽样个数随组大小抖动）：旧写法下 F1 在 0.22–0.26 之间从 0.838 掉到 0.656 又弹回
 * 0.799，用户改 0.01 结果剧变；固定个数后整段曲线平滑（见 docs/people-groups.md）。
 *
 * 注：`REPRESENTATIVE_SAMPLE` 仍然只服务 `put()` 的**增量近似**（索引过程中的临时
 * 分组）—— 最终结果由 `regroup()` 的 Chinese Whispers 给出，那次不用抽样。
 */
const SETTINGS_VERSION = 3;
const GROUPINGS = ['cluster', 'folder', 'scoped'];
const GROUPING_DEFAULT = 'cluster';
/** 抽样个数上限：再多也只影响耗时（实测 16 个 ≈ 135ms / 3501 张脸），不影响收益。 */
const REPRESENTATIVE_SAMPLE = 16;

const THRESHOLD_MIN = 0.1;
const THRESHOLD_MAX = 0.5;
const THRESHOLD_STEP = 0.01;
const THRESHOLD_DEFAULT = 0.3;
/** 按文件夹归组时取「根目录下第几层子目录」。1 = `K:\COS\116` 这一层。 */
const DEPTH_MIN = 1;
const DEPTH_MAX = 4;
const DEPTH_DEFAULT = 1;
/** 手工圈域的原文长度上限。纯防御：这是个文本框，不该让用户把整个磁盘树贴进来。 */
const DOMAIN_GROUPS_MAX = 4000;

const defaults = {
  version: SETTINGS_VERSION,
  grouping: GROUPING_DEFAULT,
  matchThreshold: THRESHOLD_DEFAULT,
  groupingDepth: DEPTH_DEFAULT,
  domainGroups: '',
  thumbnailFallback: true,
};

/**
 * 手工圈域原文 → 规范化。
 *
 * 格式：**一行一个域**，域内用逗号（或空白）分隔目录名：
 *
 * ```
 * 116, 117
 * 023木棉棉
 * ```
 *
 * 上面第一行表示「116 与 117 这两个目录同属一个域」（它们的图片在同一个池子里比对），
 * 第二行只写了一个名字 —— 等价于不写（单目录本来就是自成一域），留着它无害，
 * 用户想临时拆开时把同行的名字删掉即可。
 *
 * 规范化只做两件事：去掉空行与每行两端的空白。**保留原大小写与原文**，
 * 因为这一份要原样回显给用户编辑，改写成别的样子（比如排序、去重）会让用户
 * 以为自己打的字被吃掉了。
 */
function normalizeDomainGroups(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .slice(0, DOMAIN_GROUPS_MAX)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}
/**
 * 手工圈域原文 → `Map<目录名（小写）, 域号>`。`face-store` 用它把目录键折算成域。
 *
 * 三个约定都是刻意的：
 *   - 按**叶子目录名**匹配（`116`），不是全路径 —— 用户在界面上看到的人物名就是
 *     目录名，让他去写 `K:\COS\116` 既啰嗦又会因为盘符大小写出岔子。代价是两个根下
 *     同名的目录会被圈进同一个域，这一点写在设置说明里。
 *   - 同一个名字出现在多行时**先出现的赢**，结果与书写顺序有关但**可复现** ——
 *     「同一设置重算两次结果一致」这条契约比「报错让用户改」更重要。
 *   - 只出现一次的名字也照收：它自成一域，与不写等价，这样用户删掉同行的伙伴
 *     就等于拆开了域，不需要再去别处改。
 */
function parseDomainGroups(value) {
  const map = new Map();
  normalizeDomainGroups(value)
    .split('\n')
    .forEach((line, group) => {
      for (const name of line.split(/[,，\s]+/).filter(Boolean)) {
        const key = name.toLowerCase();
        if (!map.has(key)) map.set(key, group);
      }
    });
  return map;
}

/**
 * 夹到 [MIN, MAX] 并对齐到 STEP；空值与非法值回落默认值。
 * 空值回落默认而不是最低档：清空输入框的意思通常是「我不想管它」，而 0.15 是
 * 「见到就并」的极端档，绝不是用户清空输入时想要的。
 */
function clampThreshold(value) {
  if (value === undefined || value === null || String(value).trim() === '')
    return THRESHOLD_DEFAULT;
  const number = Number(value);
  if (!Number.isFinite(number)) return THRESHOLD_DEFAULT;
  const stepped = Math.round(number / THRESHOLD_STEP) * THRESHOLD_STEP;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, Number(stepped.toFixed(2))));
}
function clampDepth(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEPTH_DEFAULT;
  const number = Number(value);
  if (!Number.isFinite(number)) return DEPTH_DEFAULT;
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, Math.round(number)));
}
function normalizeGrouping(value) {
  return GROUPINGS.includes(value) ? value : GROUPING_DEFAULT;
}
/**
 * 把**磁盘上读到的**老设置迁移到当前量纲。
 *
 * 只用于 `read()`，**绝不能塞进 `validate()`**：UI 保存时提交的对象本来就不带
 * `version`，如果校验阶段也做迁移，用户刚填进输入框的阈值会被当成"旧量纲值"丢弃、
 * 静默换回默认 —— 一个「改了没反应、还找不到原因」的坑（实测踩过）。
 *
 * 没有 `version`（或版本偏低）即旧量纲，`matchThreshold` 直接换新默认。已经有过两次
 * 量纲变化，两次都**必须**迁移而不是照搬：
 *   - v1 → v2：从「与组内最早那张脸比」改成「与组内抽样成员的**平均**比」，
 *     旧的 0.55 搬到新量纲约等于「几乎不合并」；
 *   - v2 → v3：识别器从 SFace 换成 w600k_mbf，同人相似度整体更低（中位 0.389 vs
 *     0.422），旧的 0.20 搬到新量纲会过度合并。
 * 两次的用户症状都是「升级后看上去根本没修」，所以宁可重置成新默认值。
 * `grouping` 上的 `'balanced'` / `'strict'` 由 `normalizeGrouping` 收成 `'cluster'`。
 */
function migrate(value) {
  if (!value || typeof value !== 'object') return value;
  const version = Number(value.version);
  if (Number.isFinite(version) && version >= SETTINGS_VERSION) return value;
  return { ...value, version: SETTINGS_VERSION, matchThreshold: THRESHOLD_DEFAULT };
}
function validate(value) {
  if (!value || typeof value !== 'object' || typeof value.thumbnailFallback !== 'boolean')
    throw new Error('FACE_SETTINGS_INVALID');
  return {
    version: SETTINGS_VERSION,
    grouping: normalizeGrouping(value.grouping),
    matchThreshold: clampThreshold(value.matchThreshold),
    groupingDepth: clampDepth(value.groupingDepth),
    domainGroups: normalizeDomainGroups(value.domainGroups),
    thumbnailFallback: value.thumbnailFallback,
  };
}
function read(root) {
  try {
    return validate(
      migrate(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return { ...defaults };
    throw error;
  }
}
function save(root, value) {
  const settings = validate(value);
  const target = path.join(root, 'settings.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(settings, null, 2));
  fs.renameSync(target + '.tmp', target);
  return settings;
}
module.exports = {
  read,
  save,
  validate,
  clampThreshold,
  clampDepth,
  normalizeGrouping,
  normalizeDomainGroups,
  parseDomainGroups,
  SETTINGS_VERSION,
  GROUPINGS,
  GROUPING_DEFAULT,
  REPRESENTATIVE_SAMPLE,
  THRESHOLD_MIN,
  THRESHOLD_MAX,
  THRESHOLD_STEP,
  THRESHOLD_DEFAULT,
  DEPTH_MIN,
  DEPTH_MAX,
  DEPTH_DEFAULT,
  DOMAIN_GROUPS_MAX,
};
