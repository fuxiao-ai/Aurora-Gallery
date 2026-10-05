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

// ---------------------------------------------------- 1. 注册表自身结构

const FIELDS = PhotoInfoFields.FIELDS;
const FIELD_IDS = PhotoInfoFields.FIELD_IDS;
const GROUP_IDS = PhotoInfoFields.GROUPS.map((g) => g.id);

check('注册表至少 20 个字段（这一轮是 27 个，删字段要同步改断言）', FIELDS.length >= 20, String(FIELDS.length));
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
  // AI 标签来自搜图索引库（跨库），由主进程只读通道注入 —— 不在 getPhotoInfo() 的 SQL 里
  ai_tags: ['丝袜', '制服'],
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
// 没有 `column` 的字段 = 读数不走 `getPhotoInfo()`。目前只有两个，且各有明确理由：
// `position` 来自预览页运行时状态；`ai_tags` 来自**搜图索引库**（跨库，主进程另开只读通道）。
// 新增成员必须同时解释「为什么不走 getPhotoInfo」，否则这条断言会挡下它 —— 这正是它存在的意义。
const NO_COLUMN_FIELDS = ['ai_tags', 'position'];
check(
  '只有 position 与 ai_tags 没有 column（前者是运行时状态，后者跨库）',
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

// -------------------------------------- 5c. AI 内容标签：跨库来源 + 可点跳搜图
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
    !PhotoInfoFields.buildSectionsHtml({ ai_tags: [] }, { fields: ['ai_tags'] }).includes('AI 标签'),
);
check(
  '标签跟界语言走（词表存下标，显示时才映射）',
  PhotoInfoFields.buildSectionsHtml(
    { ai_tags: ['Stockings'] },
    { fields: ['ai_tags'], locale: 'en' },
  ).includes('AI Tags'),
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
  '🔴 AI 标签走 patchInfo 合流（第三条异步；另起一条渲染路径就重现「谁后到谁赢」）',
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
