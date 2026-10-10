'use strict';
/**
 * 照片信息面板回归：字段注册表的「单一真相源」契约。
 *
 * 背景（2026-10-04）：这一轮之前，「照片信息」面板在桌面端 `renderer/app.js` 与网页端
 * `web/js/app.js` **各写一份硬编码字段清单**，只有 8 个字段、两边还已经漂开（网页端
 * 「尺寸」少了 `px`、桌面端多一个「浏览」分组）。于是「加一个字段要改几处」「用户想挑
 * 显示哪些字段」两件事都做不了。
 *
 * 收敛方案：字段只写在 `src/web/js/photo-info-fields.js` 一处，三处引用它 ——
 * 桌面端 `<script>`、网页端 `<script>`、主进程 `require()`（做设置项白名单）。
 * 本脚本把这几条「只改一处」的边钉住，并守住两条最容易踩的语义：
 *
 *   1. 🔴 **空数组是合法值**。用户可以把字段全关掉，`normalizeFieldIds([])` 必须回 `[]`，
 *      不能回落默认集 —— 否则「全不选」会静默变成「全默认」，用户以为勾选框坏了。
 *   2. 🔴 **`column` 必须真的被查出来**。面板要显示什么，`getPhotoInfo()` 就得先 SELECT 出来；
 *      这条只能靠机械比对，靠人看代码一定会漏（漏了的表现是那一行永远不出现，不报错）。
 *
 * 判定口径同其它静态守护：宁可漏报不误报；跨文件的部分用「文本是否出现」而不是正则猜结构。
 */
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const REGISTRY_REL = 'src/web/js/photo-info-fields.js';
const RENDERER_HTML = 'src/renderer/index.html';
const RENDERER_APP = 'src/renderer/app.js';
const RENDERER_SETTINGS = 'src/renderer/settings.js';
const RENDERER_EVENTS = 'src/renderer/ui-events.js';
const RENDERER_I18N = 'src/renderer/i18n.js';
const RENDERER_CSS = 'src/renderer/styles.css';
const RENDERER_MAIN = 'src/main.js';
const DB = 'src/database.js';
const WEB_HTML = 'src/web/index.html';
const WEB_APP = 'src/web/js/app.js';
const AI_VIEWS = 'src/renderer/ai-views.js';
const PRELOAD = 'src/preload.js';
const WEB_SERVER = 'src/web-server.js';
const SEMANTIC_TAGS = 'src/main/semantic-tags.js';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const errors = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

const PhotoInfoFields = require(path.join(ROOT, REGISTRY_REL));
// 拍摄参数的列清单（`panel: true` 的那批 = 允许注册到面板的字段）
const EXIF_META = require(path.join(ROOT, 'src/main/exif-meta.js'));

// ---------------------------------------------------- 1. 注册表自身结构

const FIELDS = PhotoInfoFields.FIELDS;
const FIELD_IDS = PhotoInfoFields.FIELD_IDS;
const GROUP_IDS = PhotoInfoFields.GROUPS.map((g) => g.id);

check(
  '注册表至少 20 个字段（2026-10-06 起是 49 个；删字段要同步改断言）',
  FIELDS.length >= 20,
  String(FIELDS.length),
);
check(
  '🔴 拍摄参数共 58 列，其中 31 列可见（原有 10 + 本轮 21），27 列只入库不显示',
  EXIF_META.EXIF_METADATA_COLUMNS.length === 58 &&
    EXIF_META.EXIF_PANEL_KEYS.length === 31 &&
    EXIF_META.EXIF_METADATA_COLUMNS.length - EXIF_META.EXIF_PANEL_KEYS.length === 27,
  'columns=' +
    EXIF_META.EXIF_METADATA_COLUMNS.length +
    ' panel=' +
    EXIF_META.EXIF_PANEL_KEYS.length,
);
check(
  '字段 id 唯一',
  new Set(FIELD_IDS).size === FIELD_IDS.length,
  FIELD_IDS.length + ' vs ' + new Set(FIELD_IDS).size,
);
check(
  '`FIELD_IDS` 与 `FIELDS` 同序同长',
  FIELD_IDS.length === FIELDS.length && FIELD_IDS.every((id, i) => FIELDS[i].id === id),
);
check(
  '每个字段都有中文与英文标签',
  FIELDS.every((f) => f.zh && f.en),
  FIELDS.filter((f) => !f.zh || !f.en)
    .map((f) => f.id)
    .join(','),
);
check(
  '每个字段的 group 都在 GROUPS 里',
  FIELDS.every((f) => GROUP_IDS.includes(f.group)),
  FIELDS.filter((f) => !GROUP_IDS.includes(f.group))
    .map((f) => f.id)
    .join(','),
);
check(
  '每个字段的 value 都是函数',
  FIELDS.every((f) => typeof f.value === 'function'),
  FIELDS.filter((f) => typeof f.value !== 'function')
    .map((f) => f.id)
    .join(','),
);
// 设置页是「顺着 FIELDS 扫一遍，分组变了就新开一块」渲染的 —— 同组字段跳着排会被拆成
// 两个同名分组。面板侧因为按 GROUPS 外层循环反而不受影响，所以这条只守设置页。
check(
  '同组字段在 FIELDS 里连续排列（否则设置页会出现两个同名分组）',
  (() => {
    const seen = new Set();
    let prev = null;
    for (const f of FIELDS) {
      if (f.group === prev) continue;
      if (seen.has(f.group)) return false;
      seen.add(f.group);
      prev = f.group;
    }
    return true;
  })(),
);
check(
  '默认集是 id 的子集且不为空',
  PhotoInfoFields.DEFAULT_FIELD_IDS.length > 0 &&
    PhotoInfoFields.DEFAULT_FIELD_IDS.every((id) => FIELD_IDS.includes(id)),
);
check(
  '默认集里没有重复',
  new Set(PhotoInfoFields.DEFAULT_FIELD_IDS).size === PhotoInfoFields.DEFAULT_FIELD_IDS.length,
);

// ---------------------------------------------------- 2. normalizeFieldIds 语义

check(
  '未知 id 被丢掉、重复被去掉、回按注册表顺序',
  JSON.stringify(PhotoInfoFields.normalizeFieldIds(['dhash', 'nope', 'file_name', 'file_name'])) ===
    JSON.stringify(['file_name', 'dhash']),
  JSON.stringify(PhotoInfoFields.normalizeFieldIds(['dhash', 'nope', 'file_name', 'file_name'])),
);
check(
  '非数组（老 settings.json 没这个键）回落默认集',
  JSON.stringify(PhotoInfoFields.normalizeFieldIds(undefined)) ===
    JSON.stringify(PhotoInfoFields.DEFAULT_FIELD_IDS) &&
    JSON.stringify(PhotoInfoFields.normalizeFieldIds('file_name')) ===
      JSON.stringify(PhotoInfoFields.DEFAULT_FIELD_IDS),
);
check(
  '🔴 空数组原样返回（「全不选」是合法设置，不能回落默认集）',
  Array.isArray(PhotoInfoFields.normalizeFieldIds([])) &&
    PhotoInfoFields.normalizeFieldIds([]).length === 0,
  JSON.stringify(PhotoInfoFields.normalizeFieldIds([])),
);
check(
  '全选 = 全部字段，且顺序与注册表一致',
  JSON.stringify(PhotoInfoFields.normalizeFieldIds(FIELD_IDS.slice().reverse())) ===
    JSON.stringify(FIELD_IDS),
);

// ---------------------------------------------------- 3. 渲染契约

const FULL_INFO = {
  id: 42,
  file_name: 'DSC0001.JPG',
  file_path: 'K:/COS/1/DSC0001.JPG',
  folder_path: 'K:/COS/1',
  root_path: 'K:/COS',
  file_type: 'JPG',
  media_kind: 'image',
  width: 4000,
  height: 3000,
  file_size: 5 * 1024 * 1024,
  date_taken: '2024-01-02T03:04:05',
  date_modified: '2024-01-03T04:05:06',
  // 🔴 独立一列，与 date_taken 刻意不同值：面板上同时出现两条「拍摄时间」正是本意
  //    （上面那条实际是文件落盘时间）。两者若被合并成一列，这里就分不出来了。
  exif_date_taken: '2011-03-03T00:00:00',
  is_favorite: 1,
  has_thumbnail: 1,
  file_hash: 'a'.repeat(64),
  dhash: '0123456789abcdef',
  camera_make: 'SONY',
  camera_model: 'ILCE-7M3',
  lens_model: 'FE 24-70mm F2.8 GM',
  focal_length: 35,
  aperture: 2.8,
  iso_speed: 400,
  shutter_speed: '1/250',
  gps_latitude: 31.230416,
  gps_longitude: 121.473701,
  // ---- 2026-10-06 扩的 21 项 ----
  // 🔴 每一条都必须给**非空值**：面板对空值走「整行隐藏」，漏一个就会让下面
  //    「全选 + 全字段有值时，每一条都出现在面板里」那条断言少一行 —— 而那不是 bug，是夹具的问题。
  orientation: 6,
  exposure_bias: -0.7,
  exposure_program: 3,
  exposure_mode: 1,
  metering_mode: 5,
  light_source: 1,
  flash: 0,
  white_balance: 1,
  scene_capture_type: 2,
  max_aperture: 2.8,
  focal_length_35mm: 35,
  sub_sec_time: '12',
  lens_spec: '24-70mm f/2.8',
  lens_make: 'SONY',
  body_serial: 'SN1234567',
  lens_serial: 'LS7654321',
  software: 'Adobe Lightroom 13.2',
  color_space: 1,
  image_datetime: '2024-01-02T03:04:05',
  user_comment: '测试注释',
  gps_altitude: 12.5,
  // 主题标签来自搜图索引库（跨库），由主进程只读通道注入 —— 不在 getPhotoInfo() 的 SQL 里
  ai_tags: ['丝袜', '制服'],
  // 画面标签（JoyTag）来自 tag 索引库（跨库），由主进程 JoyTagTags 通道注入（中文映射在通道内做）
  joy_tags: ['单人', '黑发'],
};

const allHtml = PhotoInfoFields.buildSectionsHtml(FULL_INFO, {
  fields: FIELD_IDS,
  locale: 'zh-CN',
  position: '12 / 3400',
});
const allLabels = FIELDS.map((f) => f.zh);
const missingRows = allLabels.filter((label) => !allHtml.includes('>' + label + '<'));
check(
  '全选 + 全字段有值时，每一条都出现在面板里',
  missingRows.length === 0,
  missingRows.join(','),
);
check(
  '每条读数都渲染成「标签 + 值」两段',
  allHtml.split('class="preview-info-row"').length - 1 === FIELDS.length,
  String(allHtml.split('class="preview-info-row"').length - 1),
);

const oneHtml = PhotoInfoFields.buildSectionsHtml(FULL_INFO, {
  fields: ['dhash'],
  locale: 'zh-CN',
});
check(
  '只勾一个字段时，其它字段与其它分组都不出现',
  oneHtml.split('class="preview-info-row"').length - 1 === 1 &&
    oneHtml.includes('感知哈希') &&
    !oneHtml.includes('文件名') &&
    oneHtml.split('class="preview-info-section"').length - 1 === 1,
);
check(
  '一个字段都不勾时走占位文案，不留空分组',
  PhotoInfoFields.buildSectionsHtml(FULL_INFO, { fields: [] }).includes('preview-info-empty'),
);
check(
  '没有数据的字段整条不出现（不留空行）',
  PhotoInfoFields.buildSectionsHtml({ file_name: 'a.jpg' }, { fields: FIELD_IDS }).split(
    'class="preview-info-row"',
  ).length -
    1 ===
    1,
);
check(
  '英文语境下用英文标签与英文分组名',
  PhotoInfoFields.buildSectionsHtml(FULL_INFO, { fields: FIELD_IDS, locale: 'en' }).includes(
    'Basic',
  ) &&
    PhotoInfoFields.buildSectionsHtml(FULL_INFO, { fields: FIELD_IDS, locale: 'en' }).includes(
      'File name',
    ),
);
check(
  '取值里的尖括号被转义（文件名带 < > 不能当 HTML 打进去）',
  (() => {
    const html = PhotoInfoFields.buildSectionsHtml(
      { file_name: '<img src=x onerror=alert(1)>' },
      { fields: ['file_name'] },
    );
    return html.includes('&lt;img') && !html.includes('<img');
  })(),
);
check(
  'sectionBody 只在网页端打开（桌面端 DOM 结构与旧版逐位一致）',
  (() => {
    const web = PhotoInfoFields.buildSectionsHtml(FULL_INFO, {
      fields: ['file_name'],
      sectionBody: true,
    });
    const desktop = PhotoInfoFields.buildSectionsHtml(FULL_INFO, { fields: ['file_name'] });
    return web.includes('preview-info-section-body') && !desktop.includes('preview-info-section-body');
  })(),
);
check(
  '「已收藏 / 未收藏」两条都有读数（未收藏不能被当成空值吞掉）',
  PhotoInfoFields.buildSectionsHtml(
    { is_favorite: 0 },
    { fields: ['is_favorite'] },
  ).includes('未收藏') &&
    PhotoInfoFields.buildSectionsHtml({ is_favorite: 1 }, { fields: ['is_favorite'] }).includes(
      '已收藏',
    ),
);
check(
  '单个字段取值抛错不会带崩整块面板',
  (() => {
    const html = PhotoInfoFields.buildSectionsHtml(FULL_INFO, { fields: FIELD_IDS });
    // 传一个 value 会抛的对象：注册表内部 try/catch，应当只剩能算出来的那几条
    const html2 = PhotoInfoFields.buildSectionsHtml(
      {
        get file_name() {
          throw new Error('boom');
        },
        file_type: 'JPG',
      },
      { fields: ['file_name', 'file_type'] },
    );
    return !!html && html2.includes('JPG') && !html2.includes('文件名');
  })(),
);

// ---------------------------------------------------- 4. 🔴 column ↔ getPhotoInfo SQL

const dbSrc = read(DB);
const sqlStart = dbSrc.indexOf('getPhotoInfo(photoId) {');
const sqlEnd = dbSrc.indexOf('deletePhotoById', sqlStart);
check(
  '夹具自证：拿到了 getPhotoInfo 的函数体',
  sqlStart > 0 && sqlEnd > sqlStart,
  String(sqlStart) + '..' + String(sqlEnd),
);
const sql = sqlStart > 0 && sqlEnd > sqlStart ? dbSrc.slice(sqlStart, sqlEnd) : '';
check(
  '🔴 每个字段声明的来源列都出现在 getPhotoInfo 的 SQL 里（面板能画的必须先查得出来）',
  FIELDS.every((f) => {
    if (!f.column) return true;
    const cols = Array.isArray(f.column) ? f.column : [f.column];
    return cols.every((c) => new RegExp('\\b' + c + '\\b').test(sql));
  }),
  FIELDS.filter((f) => {
    if (!f.column) return false;
    const cols = Array.isArray(f.column) ? f.column : [f.column];
    return !cols.every((c) => new RegExp('\\b' + c + '\\b').test(sql));
  })
    .map((f) => f.id + '→' + f.column)
    .join(','),
);

// 🔴 反向边界：58 个拍摄参数列里只有 31 列该进面板，剩下 27 列**只入库**。
//    它们出现在 SQL 里不算「错」，但每打开一张照片就要多传一次界面用不上的 IPC 载荷 ——
//    更要紧的是：一旦它们在 SQL 里，下一个人很容易顺手注册成面板字段，
//    于是「同一件事两个读数」（`ShutterSpeedValue` 与 `ExposureTime`）就上了线。
const exifOnlyCols = EXIF_META.EXIF_METADATA_COLUMNS.filter(
  (col) => !EXIF_META.EXIF_PANEL_KEYS.some((k) => EXIF_META.EXIF_FIELD_COLUMNS[k] === col),
);
check(
  '夹具自证：确实有 27 个只入库不显示的拍摄参数列',
  exifOnlyCols.length === 27,
  String(exifOnlyCols.length),
);
const leakedCols = exifOnlyCols.filter((c) => new RegExp('\\b' + c + '\\b').test(sql));
check(
  '🔴 只入库的 27 列不得出现在 getPhotoInfo 的 SQL 里（面板一个字节都用不上）',
  leakedCols.length === 0,
  leakedCols.join(','),
);
const fieldCols = new Set();
for (const f of FIELDS) {
  if (!f.column) continue;
  (Array.isArray(f.column) ? f.column : [f.column]).forEach((c) => fieldCols.add(c));
}
const notRegistered = EXIF_META.EXIF_PANEL_KEYS.map((k) => EXIF_META.EXIF_FIELD_COLUMNS[k]).filter(
  (c) => !fieldCols.has(c),
);
check(
  '🔴 注册表里 panel:true 的每个拍摄参数列都真的注册成了面板字段（漏一个 = 采了也永远看不到）',
  notRegistered.length === 0,
  notRegistered.join(','),
);
// 没有 `column` 的字段 = 读数不走 `getPhotoInfo()`。目前只有三个，且各有明确理由：
// `position` 来自预览页运行时状态；`ai_tags` / `joy_tags` 各来自**搜图索引库 / tag 索引库**
// （都跨库，主进程各开只读通道）。
// 新增成员必须同时解释「为什么不走 getPhotoInfo」，否则这条断言会挡下它 —— 这正是它存在的意义。
const NO_COLUMN_FIELDS = ['ai_tags', 'joy_tags', 'position'];
check(
  '只有 ai_tags / joy_tags / position 没有 column（前两者跨库各走只读通道，最后者是运行时状态）',
  FIELDS.filter((f) => !f.column)
    .map((f) => f.id)
    .join(',') === NO_COLUMN_FIELDS.join(','),
  FIELDS.filter((f) => !f.column)
    .map((f) => f.id)
    .join(','),
);
check(
  '媒体类型不在 JS 侧维护第二份视频扩展名清单（复用 DB 的判定表达式）',
  sql.includes('_sqlFileTypeIsVideoExpr()') && !/mp4'\s*,\s*'mov/.test(sql),
);

// ---------------------------------------------------- 5. 三处引用同一份注册表

check(
  '桌面端 index.html 引入共享注册表',
  read(RENDERER_HTML).includes('../web/js/photo-info-fields.js'),
);
check('网页端 index.html 引入共享注册表', read(WEB_HTML).includes('/js/photo-info-fields.js'));
check(
  '主进程 require 同一份注册表（设置项白名单取自它，不另抄 id 列表）',
  read(RENDERER_MAIN).includes("require('./web/js/photo-info-fields.js')"),
);
check(
  '主进程用注册表校验 infoPanelFields，并保留空数组',
  read(RENDERER_MAIN).includes(
    'settings.infoPanelFields = PHOTO_INFO_FIELDS.normalizeFieldIds(settings.infoPanelFields)',
  ),
);

// 两端面板都改成走注册表：旧硬编码清单的标志性片段必须不再出现
check(
  '桌面端面板不再硬编码字段清单（addToSection 那套已删除）',
  !read(RENDERER_APP).includes("addToSection(\u0027\u6587\u4ef6\u540d\u0027"),
);
check(
  '网页端面板不再硬编码字段清单',
  !read(WEB_APP).includes("addToSection(\u0027\u6587\u4ef6\u540d\u0027"),
);
check(
  '桌面端面板调用注册表渲染',
  read(RENDERER_APP).includes('PhotoInfoFields') &&
    read(RENDERER_APP).includes('buildSectionsHtml('),
);
check(
  '网页端面板调用注册表渲染',
  read(WEB_APP).includes('PhotoInfoFields') && read(WEB_APP).includes('buildSectionsHtml('),
);
check(
  '网页端字段集来自桌面端设置（/api/info-fields），拿不到就用默认集',
  read(WEB_APP).includes('/api/info-fields') && read('src/web-server.js').includes('getInfoPanelFields'),
);

// -------------------------------------- 5b. 预览面板渲染链路：两条异步来源必须合流
// 🔴 曾出现「完整行渲染 merged、尺寸回补渲染 baseInfo」→ 谁后到谁赢，必然丢一部分读数：
//    尺寸后到吞掉「媒体类型 / 所属图库」，完整行后到吞掉「尺寸 / 宽高比 / 总像素」。
//    本机真实库 99.99% 的照片尺寸存的是 0（不是 NULL），全靠 sharp 实时回补，所以这条是必现 bug 的守门人。

const loadBody = (function () {
  const src = read(RENDERER_APP);
  const start = src.indexOf('function loadPreviewInfoPanel(');
  if (start < 0) return '';
  const rest = src.slice(start + 10);
  const nextTop = rest.search(/\nfunction /);
  return nextTop < 0 ? rest : rest.slice(0, nextTop);
})();
const renderArgs = [...loadBody.matchAll(/renderPreviewInfoPanel\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map(
  (m) => m[1],
);

check('夹具自证：定位到 loadPreviewInfoPanel 函数体', loadBody.length > 200, String(loadBody.length));
check(
  '🔴 面板只认一个对象：所有 renderPreviewInfoPanel(...) 实参必须同名（防「谁后到谁赢」回退）',
  renderArgs.length >= 2 && new Set(renderArgs).size === 1,
  renderArgs.join(' | '),
);
check(
  '🔴 尺寸不降级：库里存 0 时不许覆盖 sharp 实时读到的真实值',
  loadBody.includes("k === 'width'") && loadBody.includes('!(v > 0)'),
);
check(
  'sharp 回补的触发条件是「尚未拿到尺寸」而非「字段为 null」（库里存的是 0）',
  loadBody.includes('!(merged.width > 0 && merged.height > 0)'),
);
check(
  '不再出现「尺寸回补单独渲染 baseInfo」的旧写法',
  !loadBody.includes('renderPreviewInfoPanel(baseInfo)'),
);

// -------------------------------------- 5c. 主题标签：跨库来源 + 可点跳搜图
// 标签是本轮唯一一条**不走主库**的读数（它在搜图索引库 `embeddings.tags` 里），所以链路最长：
// 索引 worker 算 → 主进程只读通道读 → IPC / HTTP → 注册表渲染成胶囊 → 点了跳搜图。
// 每一段断开都是**静默**的（那块读数直接不出现，不报错），所以逐段钉住。

const tagsField = PhotoInfoFields.fieldById('ai_tags');
check('存在 ai_tags 字段，且落在 ai 分组里', !!tagsField && tagsField.group === 'ai');
check(
  '🔴 ai_tags 不声明 column（读数来自搜图索引库，getPhotoInfo 查的是主库，跨不了库）',
  !!tagsField && !tagsField.column,
);
check(
  'ai_tags 声明 render: "tags" 并提供 tags() 返回数组',
  !!tagsField && tagsField.render === 'tags' && typeof tagsField.tags === 'function',
  tagsField ? String(tagsField.render) + '/' + typeof tagsField.tags : 'no field',
);
check(
  '🔴 ai_tags 同时有 value()（每个字段都必须有，守护第 1 节强制）且返回字符串',
  !!tagsField &&
    typeof tagsField.value === 'function' &&
    typeof tagsField.value({ ai_tags: ['丝袜'] }, { locale: 'zh-CN' }) === 'string',
);

const tagDesktop = PhotoInfoFields.buildSectionsHtml(
  { ai_tags: ['丝袜', '制服'] },
  { fields: ['ai_tags'], tagClickable: true },
);
const tagWeb = PhotoInfoFields.buildSectionsHtml(
  { ai_tags: ['丝袜', '制服'] },
  { fields: ['ai_tags'] },
);
check(
  '桌面端（tagClickable）标签渲染成可点 <button data-ai-tag>',
  tagDesktop.includes('<button type="button" class="preview-info-tag" data-ai-tag="丝袜">') &&
    tagDesktop.includes('data-ai-tag="制服"'),
  tagDesktop.slice(0, 160),
);
check(
  '🔴 网页端（没有搜图页）标签渲染成不可点的 <span>，而不是摆了没反应的按钮',
  tagWeb.includes('preview-info-tag-static') && !tagWeb.includes('<button'),
  tagWeb.slice(0, 160),
);
check(
  '🔴 搜的词就是看到的词：data-ai-tag 与胶囊文本一致（否则中英混排时点「丝袜」搜的是别的词）',
  (() => {
    const pairs = [
      ...tagDesktop.matchAll(/data-ai-tag="([^"]*)"[^>]*>([^<]*)</g),
    ].map((m) => [m[1], m[2]]);
    return pairs.length === 2 && pairs.every((p) => p[0] === p[1]);
  })(),
  tagDesktop,
);
check(
  '标签值经 HTML 转义（胶囊文本与属性两处都要）',
  (() => {
    const html = PhotoInfoFields.buildSectionsHtml(
      { ai_tags: ['a"b<c>'] },
      { fields: ['ai_tags'], tagClickable: true },
    );
    return !html.includes('<c>') && !html.includes('data-ai-tag="a"b');
  })(),
);
check(
  '没有标签（空数组 / 缺失）时整行隐藏，不留空分组',
  PhotoInfoFields.buildSectionsHtml({ ai_tags: [] }, { fields: ['ai_tags'] }).includes(
    'preview-info-empty',
  ) &&
    PhotoInfoFields.buildSectionsHtml({}, { fields: ['ai_tags'] }).includes('preview-info-empty') &&
    !PhotoInfoFields.buildSectionsHtml({ ai_tags: [] }, { fields: ['ai_tags'] }).includes('主题标签'),
);
check(
  '标签跟界语言走（词表存下标，显示时才映射）',
  PhotoInfoFields.buildSectionsHtml(
    { ai_tags: ['Stockings'] },
    { fields: ['ai_tags'], locale: 'en' },
  ).includes('Theme tags'),
);
check(
  '值区带上 preview-info-value-tags 容器类（CSS 靠它把胶囊排成一行）',
  tagDesktop.includes('class="preview-info-value preview-info-value-tags"'),
);

// 渲染 → 点击 → 搜图：三段接线
const rendererApp = read(RENDERER_APP);
check(
  '🔴 桌面端把 tagClickable: true 传给注册表（漏了 = 胶囊退化成纯文本，点了没反应）',
  /buildSectionsHtml\([\s\S]{0,400}tagClickable:\s*true/.test(rendererApp),
);
check(
  '🔴 桌面端在渲染后重挂点击（innerHTML 会丢监听器，只挂一次 = 只有首次打开能点）',
  rendererApp.includes('bindPreviewInfoTagClicks(contentEl)') &&
    rendererApp.includes(".preview-info-tag[data-ai-tag]") &&
    rendererApp.includes('openSemanticSearch('),
);
check(
  '🔴 主题标签走 patchInfo 合流（第三条异步；另起一条渲染路径就重现「谁后到谁赢」）',
  loadBody.includes('getPhotoAiTags') && loadBody.includes('patchInfo({ ai_tags: tags })'),
);
check(
  '🔴 openSemanticSearch 里必须先 search 再切页（enter() 会清空 aiSearchQuery，反了就停在引导页）',
  (() => {
    const start = rendererApp.indexOf('function openSemanticSearch(');
    if (start < 0) return false;
    const body = rendererApp.slice(start, start + 900);
    const iSearch = body.indexOf('aiViews.search(');
    const iTab = body.indexOf("showTabContent('search')");
    return iSearch > 0 && iTab > iSearch;
  })(),
);
check(
  '🔴 切页判据必须是 state.currentView，不能是 state.currentTab',
  (() => {
    const start = rendererApp.indexOf('function openSemanticSearch(');
    if (start < 0) return false;
    // 只取函数体（跳过函数上方的文档注释 —— 那段注释**故意**反复提到 currentTab）
    const brace = rendererApp.indexOf('{', start);
    const body = rendererApp.slice(brace, brace + 700);
    return body.includes("state.currentView !== 'ai_search'") && !body.includes('state.currentTab');
  })(),
);
check(
  '🔴 跳搜图前先关预览（预览是上层遮罩，不关 = 搜图结果渲染在它背后，看着像没反应）',
  (() => {
    const start = rendererApp.indexOf('function openSemanticSearch(');
    return start > 0 && rendererApp.slice(start, start + 900).includes('closePreview()');
  })(),
);
check(
  'ai-views 导出 search()，且「不在搜图页」时把词暂存给 enter() 消费',
  (() => {
    const src = read(AI_VIEWS);
    return (
      /search:\s*function/.test(src) && src.includes('pendingQuery') && src.includes('if (pendingQuery)')
    );
  })(),
);
check(
  '主进程注册 get-photo-ai-tags 且 preload 暴露 getPhotoAiTags',
  rendererApp.length > 0 &&
    read(RENDERER_MAIN).includes("ipcMain.handle('get-photo-ai-tags'") &&
    read(PRELOAD).includes('getPhotoAiTags'),
);
check(
  '网页端有只读接口 /api/photo-ai-tags（标签跨库，不能并进 /api/photo-info）',
  read(WEB_SERVER).includes("'/api/photo-ai-tags'") &&
    read(WEB_SERVER).includes('handlePhotoAiTags'),
);
check(
  '🔴 网页端不传 tagClickable（那边没有搜图页）',
  !read(WEB_APP).includes('tagClickable'),
);
check(
  '网页端把标签并进同一份 info 再重画（不用第二条渲染路径）',
  read(WEB_APP).includes('/api/photo-ai-tags') && read(WEB_APP).includes('lastInfo.ai_tags'),
);
check(
  '胶囊样式在两张样式表里都有（桌面 styles.css / 网页 web/index.html 内联）',
  read(RENDERER_CSS).includes('.preview-info-tag') &&
    read(WEB_HTML).includes('.preview-info-tag'),
);

// -------------------------------------- 5e. 画面标签（JoyTag）：第二个跨库字段
// 与 5c 同构：tag 库（tag-index.sqlite）→ 主进程 JoyTagTags 只读通道（含中文映射）→
// IPC / HTTP → 注册表胶囊。每段断开都是静默的（整行不出现），所以逐段钉住。
// 中文映射（ai/tag-zh.js）是**显示层**的：只查不改库，缺失回落英文原文 —— 这条回落是
// 契约不是缺陷（瞎编的中文在 tag 路检索不到），守护钉住「查不到必须返回 null」。
// 覆盖口径（2026-10-09 用户要求「5813 都要」）：**全量**覆盖随包标签表的 5813 个标签，
// 与 `ai/tag-labels.js#labels()` 一一对应 —— 回落从此只对"换词表后的新标签"生效。
// 没有通行中文译名的小众角色 / 画师名 / 表情符号保留原文（键值同文），这是刻意的。

const joyField = PhotoInfoFields.fieldById('joy_tags');
check('存在 joy_tags 字段，且落在 ai 分组里（与 ai_tags 同组连续）', !!joyField && joyField.group === 'ai');
check(
  '🔴 joy_tags 不声明 column（读数来自 tag 索引库，getPhotoInfo 查的是主库，跨不了库）',
  !!joyField && !joyField.column,
);
check(
  'joy_tags 声明 render: "tags" 并提供 tags() 与 value()',
  !!joyField &&
    joyField.render === 'tags' &&
    typeof joyField.tags === 'function' &&
    typeof joyField.value({ joy_tags: ['单人'] }, { locale: 'zh-CN' }) === 'string',
);
check(
  'joy_tags 默认显示（用户明确要求看到它）',
  PhotoInfoFields.DEFAULT_FIELD_IDS.includes('joy_tags'),
);
const joyDesktop = PhotoInfoFields.buildSectionsHtml(
  { joy_tags: ['单人', '黑发'] },
  { fields: ['joy_tags'], tagClickable: true },
);
check(
  'joy_tags 胶囊渲染与 ai_tags 同一套（可点 button / 网页端静态 span）',
  joyDesktop.includes('data-ai-tag="单人"') &&
    PhotoInfoFields.buildSectionsHtml({ joy_tags: ['单人'] }, { fields: ['joy_tags'] }).includes(
      'preview-info-tag-static',
    ),
);
check(
  '没有画面标签时整行隐藏',
  !PhotoInfoFields.buildSectionsHtml({}, { fields: ['joy_tags'] }).includes('画面标签'),
);

// ------------------------- 5f. 点击目的地**分岔**（2026-10-09）：画面标签跳标签页，主题标签搜图
//
// 起因（用户诉求）：面板上点「盘腿坐」，落到了搜图 —— 而搜图走查询线 0.55 + tag 融合，
// 标签导航页走展示线 0.35 全量，**两边本来就不是同一批图**；用户想看的是「还有哪些张」。
// 分岔的根据不是「哪个字段」，而是「导航页里有没有这个节点」：
//   · `joy_tags` = JoyTag 的 5813 个标签 ⇒ 有节点，且条目带英文原名与归属 ⇒ 跳得准；
//   · `ai_tags`  = 308 条词表短语（「海滩」/`a beach`）⇒ 导航页里没有这个节点，只能搜图。
// 四段都可能静默断开（跳错目的地 / 跳过去 0 张 / 点了没反应），所以逐段钉。
const joyEntries = [
  { tag: 'indian_style', name: '盘腿坐', node: 'posture', category: 'pose' },
  { tag: 'pantyhose', name: '连裤袜', node: 'legwear', category: 'clothing' },
];
const joyStructured = PhotoInfoFields.buildSectionsHtml(
  { joy_tags: joyEntries },
  { fields: ['joy_tags'], tagClickable: true },
);
check(
  '🔴 结构化画面标签渲染成 data-joy-tag，并带上英文原名与归属（node / category）',
  joyStructured.includes('data-joy-tag="indian_style"') &&
    joyStructured.includes('data-tag-node="posture"') &&
    joyStructured.includes('data-tag-category="pose"'),
  joyStructured.slice(joyStructured.indexOf('preview-info-value-tags'), 420),
);
check(
  '🔴 胶囊**显示**的是中文名，`data-joy-tag` 是英文原名（两者刻意不同 —— 名字是给人看的，id 是给导航页的）',
  joyStructured.includes('>盘腿坐</button>') && !joyStructured.includes('>indian_style</button>'),
);
check(
  '🔴 tagTarget 分岔声明：joy_tags=tagnav、ai_tags=search（缺一个 = 静默走错目的地）',
  !!joyField && joyField.tagTarget === 'tagnav' && !!tagsField && tagsField.tagTarget === 'search',
  String(joyField && joyField.tagTarget) + '/' + String(tagsField && tagsField.tagTarget),
);
check(
  '🔴 没有英文原名的条目**退回** data-ai-tag（拿中文显示名去当节点 id，跳过去只会是 0 张）',
  joyDesktop.includes('data-ai-tag="单人"') && !joyDesktop.includes('data-joy-tag'),
);
check(
  '🔴 网页端（无 tagClickable）结构化条目也渲染成不可点 span，不摆按钮',
  (() => {
    const html = PhotoInfoFields.buildSectionsHtml(
      { joy_tags: joyEntries },
      { fields: ['joy_tags'] },
    );
    return html.includes('preview-info-tag-static') && !html.includes('<button');
  })(),
);
check(
  '结构化条目三处（data-joy-tag / node / category）都要 HTML 转义',
  (() => {
    const html = PhotoInfoFields.buildSectionsHtml(
      { joy_tags: [{ tag: 'a"b', name: 'x<y', node: 'n"1', category: 'c<2' }] },
      { fields: ['joy_tags'], tagClickable: true },
    );
    return !html.includes('x<y') && !html.includes('data-joy-tag="a"b') && !html.includes('c<2');
  })(),
);
check(
  '🔴 value() 兜底对对象条目取显示名（直接 join 会拼出 [object Object] 摆进读数区）',
  (() => {
    const out = joyField.value({ joy_tags: [joyEntries[0], 'legacy'] });
    return out === '盘腿坐、legacy' && !out.includes('object');
  })(),
);
check(
  '🔴 主进程通道已经把结构化条目喂过来：require 了分类表、逐条带上 tag/name/node/category',
  (() => {
    const src = read(SEMANTIC_TAGS);
    return (
      src.includes("require('../ai/tag-categories')") &&
      src.includes('cats.subOf(tag)') &&
      src.includes('SUB_TO_CATEGORY.get(node)') &&
      /tag,\s*[\s\S]{0,200}?name:\s*english/.test(src)
    );
  })(),
);
check(
  '🔴 点击分岔：两组 selectAll 各一套（漏掉 data-joy-tag = 画面标签点了没反应）',
  rendererApp.includes(".preview-info-tag[data-joy-tag]") &&
    rendererApp.includes(".preview-info-tag[data-ai-tag]") &&
    rendererApp.includes('openTagNavTag('),
);
check(
  '🔴 openTagNavTag：**先切页再设 state**（showTabContent 会按 tabMemory 清掉先设的 currentTag）',
  (() => {
    const start = rendererApp.indexOf('function openTagNavTag(');
    if (start < 0) return false;
    const brace = rendererApp.indexOf('{', start);
    const body = rendererApp.slice(brace, brace + 1100);
    const iTab = body.indexOf("showTabContent('tags')");
    const iTag = body.indexOf('state.currentTag = id');
    return iTab > 0 && iTag > iTab;
  })(),
);
check(
  '🔴 openTagNavTag 把 node/category 一起交给 selectTag（不带 = 侧栏不展开也不高亮）',
  (() => {
    const start = rendererApp.indexOf('function openTagNavTag(');
    if (start < 0) return false;
    const brace = rendererApp.indexOf('{', start);
    return /selectTag\(\s*id\s*,\s*String\(node/.test(rendererApp.slice(brace, brace + 1100));
  })(),
);
check(
  '🔴 openTagNavTag 先关预览（预览是上层遮罩，不关 = 标签页渲染在它背后，看着像没反应）',
  (() => {
    const start = rendererApp.indexOf('function openTagNavTag(');
    return start > 0 && rendererApp.slice(start, start + 1100).includes('closePreview()');
  })(),
);

// 中文映射模块契约
const tagZh = require(path.join(ROOT, 'src/ai/tag-zh.js'));
check(
  '🔴 tag-zh：命中返回中文、查不到返回 null（回落英文是调用方的职责，不许这里编词）',
  tagZh.toZh('1girl') === '1个女孩' && tagZh.toZh('definitely_not_a_tag_zz') === null,
);
check(
  '🔴 tag-zh 文本字面量与标签表逐条对齐（键=库内原文、无 null 占位残留）',
  tagZh.ZH_COUNT === Object.keys(tagZh.ZH).length && tagZh.ZH_COUNT > 0,
  String(tagZh.ZH_COUNT),
);

// 🔴 全量覆盖（2026-10-09 起）：映射表与随包标签表**一一对应**。
//   只钉「条数够多」会放过两种真回归：
//     ① 标签表换版/加了行而映射没跟上 ⇒ 新标签在面板上回落英文（看着像"没翻译完"，其实是契约破了）；
//     ② 映射里塞了标签表没有的键（脏键）⇒ 永远查不到，白占体积，还让"条数"看起来更多。
//   所以三个方向都要钉：正向覆盖、反向合法、数量相等。
const tagLabels = require(path.join(ROOT, 'src/ai/tag-labels.js'));
const tagTableLabels = tagLabels.labels();
const labelSet = new Set(tagTableLabels);
const zhMissing = tagTableLabels.filter((t) => !tagZh.hasZh(t));
const zhDirty = Object.keys(tagZh.ZH).filter((k) => !labelSet.has(k));
check(
  '🔴 tag-zh 覆盖随包标签表的每一个标签（缺一个 = 面板上这个标签回落英文）',
  tagTableLabels.length > 0 && zhMissing.length === 0,
  `labels=${tagTableLabels.length} missing=${zhMissing.length}${
    zhMissing.length ? ' 首个缺失=' + zhMissing[0] : ''
  }`,
);
check(
  '🔴 tag-zh 的键必须都是标签表里的合法标签（脏键永远查不到，白占体积）',
  zhDirty.length === 0,
  `dirty=${zhDirty.length}${zhDirty.length ? ' 首个=' + zhDirty[0] : ''}`,
);
check(
  'tag-zh 条目数与标签表条目数相等（一一对应，既无遗漏也无多余）',
  tagZh.ZH_COUNT === tagTableLabels.length,
  `zh=${tagZh.ZH_COUNT} labels=${tagTableLabels.length}`,
);
check(
  'tag-zh 没有空值（空字符串会渲染成空气泡，比回落英文更糟）',
  Object.values(tagZh.ZH).every((v) => typeof v === 'string' && v.trim().length > 0),
);

// 通道接线：主进程 → preload → 渲染端 / web-server
check(
  '🔴 主进程注册 get-photo-joy-tags、preload 暴露 getPhotoJoyTags、main.js 组装 JoyTagTags',
  read(RENDERER_MAIN).includes("ipcMain.handle('get-photo-joy-tags'") &&
    read(PRELOAD).includes('getPhotoJoyTags') &&
    read(RENDERER_MAIN).includes('.JoyTagTags'),
);
check(
  '🔴 JoyTagTags 是只读连接（tag 库唯一写入者是 tag worker，两个写入者会互拿 SQLITE_BUSY）',
  read('src/main/semantic-tags.js').includes('readonly: true'),
);
check(
  '🔴 桌面端画面标签走 patchInfo 合流（第四条异步；另起渲染路径就重现「谁后到谁赢」）',
  loadBody.includes('getPhotoJoyTags') && loadBody.includes('patchInfo({ joy_tags: tags })'),
);
check(
  '网页端有只读接口 /api/photo-joy-tags（跨库，不能并进 /api/photo-info）',
  read(WEB_SERVER).includes("'/api/photo-joy-tags'") &&
    read(WEB_SERVER).includes('handlePhotoJoyTags') &&
    read(WEB_SERVER).includes('getPhotoJoyTags'),
);
check(
  '网页端把画面标签并进同一份 info 再重画（不用第二条渲染路径）',
  read(WEB_APP).includes('/api/photo-joy-tags') && read(WEB_APP).includes('lastInfo.joy_tags'),
);

// ------------------------------- 5d. 切图必须刷新「照片信息」面板（两端同口径）
// 🔴 面板内容原先只在四处刷新：打开面板 / 改字段 / 切语言 / 主题标签补写完成 —— **切图不在其中**。
//    ⇒ 键盘 ←/→ 与幻灯片切图时面板一直显示上一张的读数。鼠标点两侧箭头看不出问题，只是因为
//    那一下会命中 `_closePreviewInfoPanelOnOutside` 把面板顺手关掉（等于绕开了 bug）；
//    网页端一直有这一步，桌面端漏了。
//
// 这条契约有两个半边，缺一即「看着好了其实没好」：
//   ① **要刷**：切图出口（两端都叫 openPreview）必须重画开着的面板；
//   ② **别刷错**：切图是同步的、读数是异步的 ⇒ 连切时上一张的回包必须被丢弃，
//      否则面板会「显示 B 的照片、配 A 的读数」，而且不报错。
// 用 acorn 定位函数体而不是文本切片：注释里反复提到这些函数名（本段注释就是），
// 文本匹配会命中注释（元规则③）。

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) walkAst(child, visit);
    } else if (val && typeof val.type === 'string') {
      walkAst(val, visit);
    }
  }
}

/** 名字 → 该名字的**所有**函数（含函数声明与函数表达式），用来先证明「查的是哪一个」 */
function namedFunctions(ast) {
  const out = new Map();
  walkAst(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name) {
      if (!out.has(n.id.name)) out.set(n.id.name, []);
      out.get(n.id.name).push(n);
    }
  });
  return out;
}

function oneFn(map, name) {
  const list = map.get(name) || [];
  return list.length === 1 ? list[0] : null;
}
function fnCount(map, name) {
  return (map.get(name) || []).length;
}

function parseScript(rel) {
  const src = read(rel);
  try {
    return { src, ast: acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' }), err: null };
  } catch (err) {
    return { src, ast: null, err: err && err.message ? err.message : String(err) };
  }
}

const DESKTOP_AST = parseScript(RENDERER_APP);
const WEB_AST = parseScript(WEB_APP);
check(
  '夹具自证：src/renderer/app.js 可解析',
  !!DESKTOP_AST.ast,
  DESKTOP_AST.err || '',
);
check('夹具自证：src/web/js/app.js 可解析', !!WEB_AST.ast, WEB_AST.err || '');

if (DESKTOP_AST.ast && WEB_AST.ast) {
  const dFns = namedFunctions(DESKTOP_AST.ast);
  const wFns = namedFunctions(WEB_AST.ast);

  // 重名会让「查的是哪个函数」失去确定性 —— 先自证唯一，否则下面全是在猜。
  for (const name of ['openPreview', 'loadPreviewInfoPanel', 'refreshOpenPreviewInfoPanel']) {
    check(
      '夹具自证：桌面端 ' + name + ' 定义唯一',
      fnCount(dFns, name) === 1,
      '找到 ' + fnCount(dFns, name) + ' 个',
    );
  }
  for (const name of ['openPreview', 'loadPreviewInfoPanel']) {
    check(
      '夹具自证：网页端 ' + name + ' 定义唯一',
      fnCount(wFns, name) === 1,
      '找到 ' + fnCount(wFns, name) + ' 个',
    );
  }

  // ---------- ① 桌面端：切图出口刷面板 ----------
  const dOpen = oneFn(dFns, 'openPreview');
  const dOpenCalls = dOpen ? callNodesOf(dOpen, 'refreshOpenPreviewInfoPanel') : [];
  check(
    '🔴 桌面端 openPreview 里重画开着的照片信息面板（漏了 = 键盘 ←/→ 切图后读数停在上一张）',
    dOpenCalls.length === 1,
    dOpen ? '调用 ' + dOpenCalls.length + ' 处' : '解析不到 openPreview',
  );
  check(
    '🔴 刷新时显式传入当前张的照片（不靠 state.previewIndex 的赋值时序）',
    dOpenCalls.length === 1 &&
      dOpenCalls[0].arguments.length >= 1 &&
      /previewPhotos\s*\[/.test(
        DESKTOP_AST.src.slice(dOpenCalls[0].arguments[0].start, dOpenCalls[0].arguments[0].end),
      ),
    dOpenCalls.length
      ? DESKTOP_AST.src.slice(dOpenCalls[0].start, dOpenCalls[0].end)
      : '没有调用可看',
  );
  // 「面板没开就返回」的守卫在函数里，调用方（切图／设置页／切语言／标签通知）不用各写一遍
  const dRefresh = oneFn(dFns, 'refreshOpenPreviewInfoPanel');
  check(
    '面板刷新自带「没开就返回」守卫（四个调用点共用同一份判断）',
    !!dRefresh &&
      DESKTOP_AST.src
        .slice(dRefresh.body.start, dRefresh.body.end)
        .includes("classList.contains('open')"),
    '函数体里没有 open 判断',
  );

  // ---------- ② 桌面端：慢回包不许覆盖新照片 ----------
  const dLoad = oneFn(dFns, 'loadPreviewInfoPanel');
  const dLoadSrc = dLoad ? DESKTOP_AST.src.slice(dLoad.body.start, dLoad.body.end) : '';
  check(
    '🔴 桌面端面板加载自增代号（切图比 IPC 回包快）',
    !!dLoad &&
      /(?:\+\+\s*previewInfoLoadSeq|previewInfoLoadSeq\s*\+\+|previewInfoLoadSeq\s*\+=\s*1)/.test(
        dLoadSrc,
      ),
    '函数体里没有代号自增',
  );
  const innerPatch = (() => {
    if (!dLoad) return null;
    const found = [];
    walkAst(dLoad.body, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'patchInfo') found.push(n);
    });
    return found.length === 1 ? found[0] : null;
  })();
  check('夹具自证：patchInfo 是面板异步读数的唯一写入口', !!innerPatch, '找不到唯一的 patchInfo');
  check(
    '🔴 patchInfo 丢掉过期回包（连切时不许「显示 B、读数是 A」）',
    !!innerPatch &&
      /seq\s*!==\s*previewInfoLoadSeq/.test(
        DESKTOP_AST.src.slice(innerPatch.body.start, innerPatch.body.end),
      ),
    'patchInfo 里没有 seq !== previewInfoLoadSeq',
  );

  // ---------- ③ 网页端：同一份契约，别只修一端 ----------
  const wOpen = oneFn(wFns, 'openPreview');
  const wOpenSrc = wOpen ? WEB_AST.src.slice(wOpen.body.start, wOpen.body.end) : '';
  check(
    '🔴 网页端切图同样重画开着的面板（两端同口径）',
    /classList\.contains\('open'\)[\s\S]{0,160}loadPreviewInfoPanel\(/.test(wOpenSrc),
    '网页端 openPreview 里没有「面板开着就刷新」',
  );
  const wLoad = oneFn(wFns, 'loadPreviewInfoPanel');
  const wRender = (() => {
    if (!wLoad) return null;
    const found = [];
    walkAst(wLoad.body, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'render') found.push(n);
    });
    return found.length === 1 ? found[0] : null;
  })();
  check('夹具自证：网页端 render 是面板唯一上屏点', !!wRender, '找不到唯一的 render');
  check(
    '🔴 网页端 render 丢掉过期回包（它是 async，两次调用会交错）',
    !!wRender &&
      /seq\s*!==\s*previewInfoLoadSeq/.test(WEB_AST.src.slice(wRender.body.start, wRender.body.end)),
    wRender ? 'render 里没有 seq !== previewInfoLoadSeq' : '没有 render 可看',
  );
  // 负例自证：两个文件里的代号必须是**各自的**模块级变量（不是从别处借来的名字）
  check(
    '两端各自声明面板加载代号',
    /var\s+previewInfoLoadSeq\s*=/.test(DESKTOP_AST.src) &&
      /var\s+previewInfoLoadSeq\s*=/.test(WEB_AST.src),
  );
}

/** 某个函数体里所有「以 name 为被调」的调用表达式 */
function callNodesOf(fn, name) {
  const hits = [];
  walkAst(fn.body, (n) => {
    if (n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' && n.callee.name === name) {
      hits.push(n);
    }
  });
  return hits;
}

// ---------------------------------------------------- 6. 设置页控件

const html = read(RENDERER_HTML);
const events = read(RENDERER_EVENTS);
const settingsSrc = read(RENDERER_SETTINGS);
const css = read(RENDERER_CSS);

for (const id of [
  'settingsInfoFields',
  'settingsInfoFieldsSelectAllBtn',
  'settingsInfoFieldsClearAllBtn',
  'settingsInfoFieldsResetBtn',
]) {
  check(`设置页存在 #${id}`, html.includes('id="' + id + '"'));
  if (id !== 'settingsInfoFields') check(`#${id} 有绑定`, events.includes("'" + id + "'"));
}
check(
  '勾选框靠 data-info-field 认领（字段清单是生成的，不可能逐个写 id）',
  settingsSrc.includes('data-info-field=') && events.includes("getAttribute('data-info-field')"),
);
check(
  '🔴 勾选框是渲染时生成的文案 → 切语言时必须重画',
  read(RENDERER_APP).includes('settingsSync.renderInfoPanelFieldsForm({ state: state })'),
);
check(
  '保存成功后立即重画开着的面板（否则要重开预览才生效）',
  read(RENDERER_APP).includes('onRerender: refreshOpenPreviewInfoPanel'),
);
check(
  '勾选框尺寸不在 styles.css 二次声明（唯一来源是 theme-polish.css 的 .settings-page input）',
  !/\.settings-info-field input\[type='checkbox'\]\s*\{[^}]*(width|height|accent-color)/.test(css),
);
check(
  '设置页分组标题与提示走 data-i18n',
  html.includes('data-i18n="settings.infoPanel.group"') &&
    html.includes('data-i18n-html="settings.infoPanel.hintHtml"'),
);

// ---------------------------------------------------- 7. i18n 两个语言包都要有键

const i18n = read(RENDERER_I18N);
const zhStart = i18n.indexOf("'zh-CN': {");
const enStart = i18n.indexOf('en: {');
check('夹具自证：两个语言包都定位到了', zhStart > 0 && enStart > zhStart);
const zhPack = i18n.slice(zhStart, enStart);
const enPack = i18n.slice(enStart);
for (const key of [
  'settings.infoPanel.group',
  'settings.infoPanel.hintHtml',
  'settings.infoPanel.selectAll',
  'settings.infoPanel.clearAll',
  'settings.infoPanel.reset',
  'settings.save.infoFieldsFail',
]) {
  check(`zh-CN 有 ${key}`, zhPack.includes("'" + key + "'"));
  check(`en 有 ${key}`, enPack.includes("'" + key + "'"));
}

// ---------------------------------------------------------------------- 输出

process.stdout.write('[photo-info-fields-regression] 照片信息面板字段注册表契约\n');
for (const line of notes) process.stdout.write(line + '\n');
if (errors.length) {
  process.stdout.write('\n');
  for (const line of errors) process.stdout.write(line + '\n');
  process.stdout.write('\n[photo-info-fields-regression] FAIL（' + errors.length + ' 项）\n');
  process.exit(1);
}
process.stdout.write(
  '\n[photo-info-fields-regression] PASS（' +
    notes.length +
    ' 项；字段 ' +
    FIELD_IDS.length +
    ' 个、默认显示 ' +
    PhotoInfoFields.DEFAULT_FIELD_IDS.length +
    ' 个）\n',
);
