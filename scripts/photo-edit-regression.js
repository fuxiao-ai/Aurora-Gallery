#!/usr/bin/env node
'use strict';

/**
 * 图片编辑契约回归（2026-10-09）。
 *
 * ## 这条契约是什么
 *
 * 「预览里旋转 / 翻转 / 裁剪一张图」看起来只有一步，实际是一条**七处会同时失效**的链：
 *
 *   ① 方向代数：`EXIF orientation(1–8) + 用户动作` 必须合成出**一条** sharp 算子。
 *      8 种方向里有 2 种（5 / 7）与直觉相反；卷积顺序又是「flip/flop 先、rotate 后」——
 *      照直觉写不会报错，只是**这张图转出来是歪的**。
 *   ② 写回原子性：同目录临时文件 + rename。原地截断写 = 中途失败就是半个文件。
 *   ③ 方向归一化：输出必须 `orientation = 1`，否则 `resizeThumb()` 里的 `.rotate()`
 *      会**再转一次**（缩略图转 180°，而原图是对的）。
 *   ④ 派生数据收敛：缩略图 / dHash / 尺寸 / 文件级元数据（`file_size` + `date_modified`）
 *      四样必须一起更新；`date_modified` 还必须是 `scanner.js` 那个格式，
 *      否则四列记账时间戳永远对不上它 ⇒ 后台任务**无限重算**。
 *   ⑤ 指纹失效：SHA-256 不清 = 「精确重复」里混进一张已经改过的图。
 *   ⑥ 缓存键翻新：界面的图 URL 键是 `file_size + date_modified`；不回给渲染端
 *      ⇒ URL 不变 ⇒ 浏览器命中旧缓存 ⇒ 用户以为没生效、**再点一次又转 90°**。
 *   ⑦ 裁剪产物要**进表成为正常行**：`root_id` / `date_taken` 缺一个就会被
 *      `INSERT OR IGNORE` 静默吞掉（症状是「裁剪副本入库失败」，而不是插入报错）。
 *
 * 其中 ⑦ 真实发生过一轮：`loadEditableRow` 当时用的是 `getFullPhoto()`，而它只 SELECT
 * 四列（**没有 id / root_id / date_taken**）⇒ `db.updatePhoto*` 全部影响 0 行、
 * `insertPhoto` 被 OR IGNORE 吞掉。**静态断言一条都不会红**（列名都在、调用都在），
 * 只有真跑一遍才看得见。所以本守护的行为组不是锦上添花，是它的一半。
 *
 * ## 钉的东西
 *
 *   · 方向分解表 + `planEdit()` 的**真调用**结果（不抄金标准：表自己就是标准；
 *     只有「5/7 与直觉相反」这两个取值是写死的 —— 它们是真错过的那两格）。
 *   · 拒绝路径：RAW（走**扩展名**判据，因为 sharp 会把 cr2 读成 jpeg，按 format 判会毁原片）、
 *     gif / svg、未知动作。
 *   · 服务层那份「编辑后要跟着改的东西」清单，逐项从函数体里找（剥注释后）。
 *   · 两端协议的**对偶**：IPC 与 HTTP 两条通道都得带上 `dateModified`。
 *   · 两端裁剪 UI 的**两份实现必须同参**（网页端拿不到渲染端模块，只能两份；
 *     同参靠这个脚本对账，而不是靠人记得改两处）。
 *   · 真实临时库 + 临时目录跑一遍 P0 / P1 全链路。
 *
 * ## 判定口径
 *
 * 宁可漏报不误报。只有「同一件事在两处必须逐字相同」才做字面量比对；
 * 其余能真调函数的就真调（本脚本运行在 electron 下，见 `run-regressions.js`）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const acorn = require('acorn');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');

const notes = [];
const errors = [];
function check(name, ok, detail) {
  if (ok) {
    notes.push('  \u2713 ' + name);
    return;
  }
  errors.push('  \u2717 ' + name + (detail ? '  [' + detail + ']' : ''));
}

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function parse(src, file) {
  try {
    return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (eScript) {
    try {
      return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (eModule) {
      throw new Error('无法解析 ' + file + '：' + eModule.message, { cause: eModule });
    }
  }
}

/**
 * 把注释替换成**等长空白**（保留换行）。
 *
 * ⚠️ 不许自己写状态机：本仓库里已有一版 `stripComments` 不认正则字面量，
 * `main.js` 里一条含引号的正则会让它从那里起错位、之后所有注释都剥不掉
 * （`dead-reference-regression.js:223` 有先例）。这里用 acorn 的 `onComment`
 * 拿真区间，解析失败返回 `null`，由调用方显式报红 —— 不静默降级。
 */
function blankComments(raw) {
  const ranges = [];
  try {
    acorn.parse(raw, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      onComment: ranges,
    });
  } catch (eParse) {
    return null;
  }
  const out = raw.split('');
  for (const c of ranges) {
    for (let i = c.start; i < c.end; i++) if (out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/** 剥注释（解析失败时返回原文，由「夹具自证」那条断言把降级显式暴露出来）。 */
function code(raw, file) {
  const blanked = blankComments(raw);
  check('夹具自证：' + file + ' 能被 acorn 解析（注释可剥）', blanked !== null);
  return blanked === null ? raw : blanked;
}

/**
 * 取 `function <name>(...) { ... }` 的**源码片段**（含函数名），找不到返回 ''。
 *
 * ⚠️ 两种形态都要认（本仓库两种都大量在用）：
 *   · 函数声明            `function loadEditableRow(a) { … }`
 *   · 成员赋值 + 函数表达式 `WebServer.prototype.handlePhotoEditX = function (req, res) { … }`
 *   只认前者的话，`web-server.js` 那侧会静默切出空串 —— 断言跟着变成「找不到就报红」，
 *   看起来像源码坏了，其实是夹具没取到（第一版就踩了这条）。
 */
function functionSource(src, file, name) {
  const ast = parse(src, file);
  let found = '';
  const stack = [ast];
  while (stack.length && !found) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node.start === 'number' && node.end > node.start && nodeName(node) === name) {
      found = src.slice(node.start, node.end);
      break;
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const child = node[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return found;
}

/** 节点若是「具名函数」或「给某个名字赋一个函数」，返回那个名字；否则返回 null。 */
function nodeName(node) {
  if (
    (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
    node.id &&
    node.id.name
  ) {
    return node.id.name;
  }
  if (node.type === 'AssignmentExpression') {
    const right = node.right;
    if (!right || (right.type !== 'FunctionExpression' && right.type !== 'ArrowFunctionExpression')) {
      return null;
    }
    const left = node.left;
    if (left.type === 'MemberExpression' && !left.computed && left.property) {
      return left.property.name || null;
    }
    if (left.type === 'Identifier') return left.name;
  }
  return null;
}

/** 取两个标记之间的片段（含首标记）；找不到返回 ''。 */
function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) return '';
  if (!to) return src.slice(a);
  const b = src.indexOf(to, a + from.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

// ════════════════════════════════════════════════════════ 0. 载入被测模块

const imageEdit = require('../src/main/image-edit');
const { createPhotoEditService } = require('../src/main/photo-edit-service');
const { computeDhash } = require('../src/main/perceptual-hash');
const thumbFormat = require('../src/main/thumb-format');
const PhotoDatabase = require('../src/database');

const SRC_IMAGE_EDIT = 'src/main/image-edit.js';
const SRC_SERVICE = 'src/main/photo-edit-service.js';

// ════════════════════════════════════════════════════════ 1. 方向代数

const ORI = imageEdit.ORIENTATION_DECOMPOSITION;
check('方向分解表 8 档齐全', [1, 2, 3, 4, 5, 6, 7, 8].every((n) => ORI[n]));

const oriShapeOk = [1, 2, 3, 4, 5, 6, 7, 8].every((n) => {
  const e = ORI[n];
  return (
    [0, 90, 180, 270].indexOf(e.a) >= 0 &&
    (e.p === 0 || e.p === 1) &&
    (e.q === 0 || e.q === 1) &&
    // 🔴 不变量：p 与 q 不同时为 1（`Fh ∘ Fv = R180`，归一化成纯旋转）。
    //    破了它 `planEdit` 的翻转分支就会走进「两处都翻」的未定义态。
    !(e.p === 1 && e.q === 1)
  );
});
check('每档角度 ∈ {0,90,180,270}、镜像位 ∈ {0,1}、且 p/q 不同时为 1（归一化不变量）', oriShapeOk);

// 🔴 这两格与直觉相反，是第一版真写错的地方（实测 8 档里恰好只错这两个）。
//    5 = transpose（沿主对角线）⇒ R270 ∘ Fh；7 = transverse（沿副对角线）⇒ R90 ∘ Fh。
check('orientation 5 = R270 ∘ Fh（transpose，曾经误写成 90）', ORI[5].a === 270 && ORI[5].p === 1);
check('orientation 7 = R90 ∘ Fh（transverse，曾经误写成 270）', ORI[7].a === 90 && ORI[7].p === 1);
check('orientation 3 = 纯 R180、6 = 纯 R90、8 = 纯 R270（这三档无镜像）',
  ORI[3].a === 180 && !ORI[3].p && !ORI[3].q &&
  ORI[6].a === 90 && !ORI[6].p && !ORI[6].q &&
  ORI[8].a === 270 && !ORI[8].p && !ORI[8].q);

// planEdit 真调用（旋转）
check('planEdit(1, rotate-right) → 角度 90、无镜像', (() => {
  const r = imageEdit.planEdit(1, 'rotate-right');
  return r.angle === 90 && !r.flop && !r.flip;
})());
check('planEdit(1, rotate-left) → 角度 270', imageEdit.planEdit(1, 'rotate-left').angle === 270);
check('planEdit(6, rotate-right) → 90+90=180（带方向的图不能只加动作角）',
  imageEdit.planEdit(6, 'rotate-right').angle === 180);
check('planEdit(8, rotate-right) → 270+90 归一化成 0', imageEdit.planEdit(8, 'rotate-right').angle === 0);

// planEdit 真调用（翻转补偿：`F ∘ R_a = R_{-a} ∘ F`）
check('planEdit(6, flip-h) → 角度取反补偿 (360-90)=270 且 flop=true', (() => {
  const r = imageEdit.planEdit(6, 'flip-h');
  return r.angle === 270 && r.flop === true && r.flip === false;
})());
check('planEdit(1, flip-v) → 角度不变、flip=true', (() => {
  const r = imageEdit.planEdit(1, 'flip-v');
  return r.angle === 0 && r.flop === false && r.flip === true;
})());
check('planEdit(3, flip-h) → 180 取反仍是 180（自反档不吃补偿）',
  imageEdit.planEdit(3, 'flip-h').angle === 180);
check('planEdit 对「两处都翻」做归一化（orientation 2 + flip-v ⇒ 纯 R180）', (() => {
  const r = imageEdit.planEdit(2, 'flip-v');
  return !r.flop && !r.flip && r.angle === 180;
})());

// 全域穷举：8 档 × 4 动作的结果必须都合法（角度是 90 的倍数、镜像位不共存）
const allActions = imageEdit.TRANSFORM_ACTIONS;
let exhaustiveOk = allActions.length === 4;
for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
  for (const act of allActions) {
    const r = imageEdit.planEdit(o, act);
    if (!(r.angle % 90 === 0 && r.angle >= 0 && r.angle < 360)) exhaustiveOk = false;
    if (typeof r.flop !== 'boolean' || typeof r.flip !== 'boolean') exhaustiveOk = false;
    if (r.flop && r.flip) exhaustiveOk = false;
  }
}
check('8 档 × 4 动作全穷举：结果都合法（角度是 90 的倍数、镜像位不共存）', exhaustiveOk);
check('未知动作被 planEdit 拒绝', (() => {
  try {
    imageEdit.planEdit(1, 'explode');
    return false;
  } catch (e) {
    return /未知的编辑动作/.test(e.message);
  }
})());

// ════════════════════════════════════════════════════════ 2. 格式与拒绝路径

check('可编辑格式白名单 = jpeg/png/webp/tiff/avif/heif',
  ['jpeg', 'png', 'webp', 'tiff', 'avif', 'heif'].every(
    (f) => imageEdit.EDITABLE_FORMATS.indexOf(f) >= 0,
  ) && imageEdit.EDITABLE_FORMATS.length === 6);

// 🔴 RAW 走**扩展名**判据：`createSharpInput()` 对 cr2 会抠出内嵌 JPEG 预览，
//    读出来的 format 是 jpeg —— 只按 format 判就会把预览图写回 .cr2，等于毁原片。
check('RAW 全部拒绝（cr2/nef/arw/dng/orf/rw2/raw）',
  ['.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raw'].every((e) =>
    /RAW/.test(imageEdit.denyReason('x' + e) || ''),
  ));
check('crw / cr3 也拒绝（main.js#RAW_EXTENSIONS 里没有它们，漏了就是漏网）',
  ['.crw', '.cr3'].every((e) => /RAW/.test(imageEdit.denyReason('x' + e) || '')));
check('gif / svg 拒绝，理由是格式而非 RAW',
  ['.gif', '.svg'].every((e) => {
    const r = imageEdit.denyReason('x' + e) || '';
    return !!r && !/RAW/.test(r);
  }));
check('普通图片放行（jpg/png/webp/tiff/avif/heif 全 null）',
  ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heif', '.heic'].every(
    (e) => imageEdit.denyReason('x' + e) === null,
  ));
check('无扩展名拒绝', imageEdit.denyReason('noext') === '无法识别文件类型');

// 与另两份 RAW 清单对齐（三处并集 —— 任何一处单独漂移都会漏掉某类 RAW）
const rawMain = readSource('src/main.js').match(/var RAW_EXTENSIONS = new Set\(\[([^\]]+)\]\)/);
const ownRaw = readSource('src/main/sharp-input.js').match(
  /const OWN_DECODER_RAW_EXTENSIONS = new Set\(\[([^\]]+)\]\)/,
);
check('main.js#RAW_EXTENSIONS 可解析', !!rawMain);
check('sharp-input.js#OWN_DECODER_RAW_EXTENSIONS 可解析', !!ownRaw);
const unionRaw = new Set([
  ...(rawMain ? rawMain[1].match(/'([^']+)'/g) || [] : []).map((s) => s.replace(/'/g, '')),
  ...(ownRaw ? ownRaw[1].match(/'([^']+)'/g) || [] : []).map((s) => s.replace(/'/g, '')),
]);
const missingDenied = [...unionRaw].filter((e) => !imageEdit.DENIED_EXTENSIONS.has(e));
check('另两份 RAW 清单的并集全部落在 DENIED_EXTENSIONS 里（三处不许漂移）',
  unionRaw.size >= 9 && missingDenied.length === 0, missingDenied.join(','));

// ════════════════════════════════════════════════════════ 3. 写盘原子性与时间格式

const imageEditCode = code(readSource(SRC_IMAGE_EDIT), SRC_IMAGE_EDIT);
check('写回走同目录临时文件 + rename（禁原地截断写）', (() => {
  const body = imageEditCode.slice(imageEditCode.indexOf('async function writeAtomic'));
  return body.indexOf('rename(') >= 0 && body.indexOf('TMP_SUFFIX') >= 0;
})());
check('写路径里没有 truncate / createWriteStream（那两个都不是原子替换）',
  imageEditCode.indexOf('truncate') < 0 && imageEditCode.indexOf('createWriteStream') < 0);
check('方向归一化收在唯一出口 encodeToFormat（任何写回路径都不可能漏）', (() => {
  const body = functionSource(imageEditCode, SRC_IMAGE_EDIT, 'encodeToFormat');
  return /withMetadata\(\s*\{\s*orientation:\s*1\s*\}\s*\)/.test(body);
})());
check('applyTransform / cropToCopy 都不自己调 .jpeg()/.png()（只走 encodeToFormat）', (() => {
  const t = functionSource(imageEditCode, SRC_IMAGE_EDIT, 'applyTransform');
  const c = functionSource(imageEditCode, SRC_IMAGE_EDIT, 'cropToCopy');
  return t.indexOf('encodeToFormat(') >= 0 && c.indexOf('encodeToFormat(') >= 0 &&
    !/\.jpeg\(|\.png\(|\.webp\(/.test(t) && !/\.jpeg\(|\.png\(|\.webp\(/.test(c);
})());

// `date_modified` 的格式必须与扫描器逐字一致（差一个字符 ⇒ 四列记账永久对不上）
const scannerCode = code(readSource('src/scanner.js'), 'src/scanner.js');
const scannerFmt = sliceBetween(scannerCode, 'function formatMtimeFromDate', '\n}');
const editFmt = functionSource(imageEditCode, SRC_IMAGE_EDIT, 'formatDbMtime');
const fmtBody = (s) => (s.match(/toISOString\(\)[\s\S]*?substring\(0,\s*19\)/) || [''])[0];
check('formatDbMtime 与 scanner.js#formatMtimeFromDate 逐字一致（YYYY-MM-DD HH:MM:SS）',
  !!fmtBody(scannerFmt) && fmtBody(scannerFmt) === fmtBody(editFmt),
  'scanner=' + fmtBody(scannerFmt) + ' edit=' + fmtBody(editFmt));
check('formatDbMtime 真输出形状正确', (() => {
  const s = imageEdit.formatDbMtime(new Date('2026-10-09T08:14:25.123Z'));
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s);
})());
check('formatDbMtime 对空值返回空串（不是 "Invalid Date"）',
  imageEdit.formatDbMtime(null) === '' && imageEdit.formatDbMtime(undefined) === '');

// 裁剪路径永不覆盖
check('uniqueCropPath 带 _crop 后缀且不会撞已有文件', (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cropname-'));
  try {
    const base = path.join(dir, 'a.jpg');
    fs.writeFileSync(base, 'x');
    fs.writeFileSync(path.join(dir, 'a_crop.jpg'), 'x');
    const p = imageEdit.uniqueCropPath(base);
    return path.basename(p) === 'a_crop2.jpg';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})());

// ════════════════════════════════════════════════════════ 4. 服务层：编辑后要跟着改的东西

const serviceCode = code(readSource(SRC_SERVICE), SRC_SERVICE);

check('loadEditableRow 用 getPhotoForEdit（不是 getFullPhoto —— 后者只 SELECT 四列）', (() => {
  const body = functionSource(serviceCode, SRC_SERVICE, 'loadEditableRow');
  return body.indexOf('getPhotoForEdit(') >= 0 && body.indexOf('getFullPhoto') < 0;
})());

check('computeDerived 里 dHash 取在 resizeThumb 之前（后者会消费 sharp 实例）', (() => {
  const body = functionSource(serviceCode, SRC_SERVICE, 'computeDerived');
  const iDhash = body.indexOf('computeDhashFromPipeline');
  const iThumb = body.indexOf('resizeThumb');
  return iDhash >= 0 && iThumb >= 0 && iDhash < iThumb;
})());

check('writeDerivedToRow 四项齐全（缩略图 / dHash / 尺寸 / 文件级元数据）', (() => {
  const body = functionSource(serviceCode, SRC_SERVICE, 'writeDerivedToRow');
  return ['updatePhotoThumbnail(', 'updatePhotoDhash(', 'updatePhotoDimensions(', 'updatePhotoFileMeta(']
    .every((s) => body.indexOf(s) >= 0);
})());

check('transform 清 SHA-256 指纹（不清 = 精确重复里混进改过的图）', (() => {
  const body = functionSource(serviceCode, SRC_SERVICE, 'transform');
  return /updatePhotoHash\(\s*\w+\.\w+\s*,\s*null\s*\)/.test(body);
})());

check('transform 返回值带 dateModified（渲染端靠它翻新 URL 缓存键）', (() => {
  const body = functionSource(serviceCode, SRC_SERVICE, 'transform');
  return /dateModified\s*:/.test(body);
})());

// 「裁剪副本落库」那一段（`insertPhoto` 凑列 / 禁 lastInsertRowid / dateTaken 跟随原图）
// 自 2026-10-09 起收在 `createCropCopy()` 里，由 `crop()` 与 `applyEdit()` 共用 ——
// 两份实现 = 这三条一定有一份漂移。所以这里**先钉住委派**，再钉住不变量本身。
const cropCopyBody = functionSource(serviceCode, SRC_SERVICE, 'createCropCopy');
check('夹具自证：能切出 createCropCopy 函数体', cropCopyBody.length > 400, String(cropCopyBody.length));
check('crop 与 applyEdit 都走同一个 createCropCopy（两份落库实现必然漂移）',
  /createCropCopy\(/.test(functionSource(serviceCode, SRC_SERVICE, 'crop')) &&
  /createCropCopy\(/.test(functionSource(serviceCode, SRC_SERVICE, 'applyEdit')));
check('crop 禁 lastInsertRowid、改用 getPhotoIdByFilePath', (() => {
  const body = cropCopyBody;
  return body.indexOf('lastInsertRowid') < 0 && body.indexOf('getPhotoIdByFilePath(') >= 0;
})());
check('crop 落 derived_from（副本要能追到原图）', (() => {
  const body = cropCopyBody;
  return body.indexOf('markPhotoDerived(') >= 0;
})());
check('crop 的 dateTaken 跟随原图（否则每次裁剪都在「今天」多一张）', (() => {
  const body = cropCopyBody;
  return /dateTaken\s*:\s*[\w.]*date_taken\s*\|\|/.test(body);
})());
check('crop 里 newId 与原件 id 相等时抛错（撞行不能装作成功）', (() => {
  const body = cropCopyBody;
  return /newId\s*===\s*[\w.]*\.id/.test(body);
})());
check('编辑全局串行（写盘→读回算派生→更新库行 不是原子的）', (() => {
  const src = code(readSource(SRC_SERVICE), SRC_SERVICE);
  return src.indexOf('enqueue(') >= 0 && /var\s+queue\s*=\s*Promise\.resolve\(\)/.test(src);
})());

// ════════════════════════════════════════════════════════ 5. 两端协议对偶

const mainCode = code(readSource('src/main.js'), 'src/main.js');
const webCode = code(readSource('src/web-server.js'), 'src/web-server.js');

// 🔴 三条通道都要钉。`photo-edit-apply` 是 P2 新增的「保存」唯一入口 ——
//    漏钉的话它整条消失（渲染端点了保存没反应、无报错）也不会有人发现。
const IPC_CHANNELS = ['photo-edit-transform', 'photo-edit-crop', 'photo-edit-apply'];
const HTTP_ROUTES = ['/api/photo-edit-transform', '/api/photo-edit-crop', '/api/photo-edit-apply'];
check('IPC 通道 ' + IPC_CHANNELS.join(' / ') + ' 都已注册',
  IPC_CHANNELS.every((c) => mainCode.indexOf("ipcMain.handle('" + c + "'") >= 0));
/** 取 mainCode 里第 i 个 IPC handler 的函数体（到下一条 handler 之前）。 */
function ipcHandlerBody(i) {
  const start = mainCode.indexOf("ipcMain.handle('" + IPC_CHANNELS[i] + "'");
  if (start < 0) return '';
  const nextCh = IPC_CHANNELS[i + 1];
  const next = nextCh ? mainCode.indexOf("ipcMain.handle('" + nextCh + "'") : -1;
  const end = next > start ? next : mainCode.indexOf('ipcMain.handle(', start + 10);
  return mainCode.slice(start, end > start ? end : start + 2000);
}
check('三个 IPC 都有「扫描中拒绝」前置判据',
  IPC_CHANNELS.every((c, i) => {
    const body = ipcHandlerBody(i);
    return body.length > 100 && /isFolderScanRunning\(\)/.test(body);
  }),
  IPC_CHANNELS.filter((c, i) => !/isFolderScanRunning\(\)/.test(ipcHandlerBody(i))).join(','));
check('IPC transform 响应带 dateModified', (() => {
  const t = sliceBetween(mainCode, "ipcMain.handle('photo-edit-transform'", "ipcMain.handle('photo-edit-crop'");
  return /dateModified\s*:/.test(t);
})());
check('IPC apply 响应也带 dateModified（保存后界面靠它翻新缓存键）', (() => {
  const a = sliceBetween(mainCode, "ipcMain.handle('photo-edit-apply'", 'ipcMain.handle(');
  return /dateModified\s*:/.test(a) && /width\s*:/.test(a) && /height\s*:/.test(a);
})());
check('HTTP 路由 ' + HTTP_ROUTES.join(' / ') + ' 都在',
  HTTP_ROUTES.every((r) => webCode.indexOf("'" + r + "'") >= 0));
check('HTTP transform 响应也带 dateModified（两端不许一头有一头没有）', (() => {
  const body = functionSource(webCode, 'src/web-server.js', 'handlePhotoEditTransform');
  return body.length > 0 && /dateModified\s*:/.test(body);
})());
check('HTTP apply 响应字段与 IPC 对偶（width/height/size/dateModified/crop 五项齐）', (() => {
  const body = functionSource(webCode, 'src/web-server.js', 'handlePhotoEditApply');
  return body.length > 0 &&
    ['width', 'height', 'size', 'dateModified', 'crop'].every((f) => body.indexOf(f + ':') >= 0);
})());
check('HTTP transform 兼容旧的单串 action（老前端不发 actions 时不许静默失效）',
  /data\.action/.test(functionSource(webCode, 'src/web-server.js', 'handlePhotoEditTransform')));

const preloadCode = code(readSource('src/preload.js'), 'src/preload.js');
check('preload 导出 photoEditTransform / photoEditCrop / photoEditApply',
  ['photoEditTransform', 'photoEditCrop', 'photoEditApply'].every((n) => preloadCode.indexOf(n) >= 0));
check('preload 三个方法各自 invoke 到同名通道（拼错通道名 = 点了没反应）',
  IPC_CHANNELS.every((c) => preloadCode.indexOf("invoke('" + c + "'") >= 0));

const rendererApiCode = code(readSource('src/renderer/api.js'), 'src/renderer/api.js');
// 🔴 用 `\b名字:` 而不是 `indexOf(名字)`：后者会被 `photoEditApplyX` 满足（子串命中），
//    牙齿验证实测 —— 把名字整体改错仍然全绿。
check('renderer/api.js 转发三个方法（拼错名字会让 has() 恒 false、按钮静默无效）',
  ['photoEditTransform', 'photoEditCrop', 'photoEditApply'].every(
    (n) => new RegExp('\\b' + n + ':\\s*function').test(rendererApiCode)));
// `has()` 本身是通用实现（按名字查 preload），所以「支持与否」的真正判据在**调用端**：
// 渲染端保存前必须问 `api.has('photoEditApply')`，漏了就会去调一个不存在的后端。
// （这条依赖 `rendererAppCode`，故放在下面「预览态编辑」一节里。）

// ════════════════════════════════════════════════════════ 6. 两端裁剪 UI 同参对账

const rendererCrop = readSource('src/renderer/preview-crop.js');
const webAppRaw = readSource('src/web/js/app.js');
const webCrop = sliceBetween(webAppRaw, 'var webPreviewCrop = (function', 'function pickWebNextRandomSlideshowIndex');

check('夹具自证：能切出网页端的 cropped 段（不是空串）', webCrop.length > 1500, String(webCrop.length));

const CROP_PAIRS = [
  ['选区最小边长 24', 'var MIN_SIZE = 24;'],
  ['初始选区居中占 80%', '* 0.8'],
  ['四角 handle 顺序 nw/ne/se/sw', "['nw', 'ne', 'se', 'sw']"],
  ['handle 用 data-corner 标注', "setAttribute('data-corner'"],
  ['resize 有监听（未确认态退出 / 已确认态重排，见下）', "addEventListener('resize'"],
  ['Esc 取消', "'Escape'"],
  ['回车确认', "'Enter'"],
  ['拖四角改的是「边」而不是「中心」', "indexOf('w')"],
];
for (const [label, needle] of CROP_PAIRS) {
  check('两端裁剪同参：' + label,
    rendererCrop.indexOf(needle) >= 0 && webCrop.indexOf(needle) >= 0,
    'renderer=' + (rendererCrop.indexOf(needle) >= 0) + ' web=' + (webCrop.indexOf(needle) >= 0));
}

// 模态：**未确认**的裁剪吞掉所有按键的传播（不然按方向键 ⇒ 图换了、选框还在原地）。
check('两端「未确认」的裁剪仍是模态键盘态（那条无条件 stopPropagation 还在）',
  /e\.stopPropagation\(\);\s*\n\s*if \(e\.key === 'Escape'\)/.test(rendererCrop) &&
  /e\.stopPropagation\(\);\s*\n\s*if \(e\.key === 'Escape'\)/.test(webCrop));
// 🔴 反向：**已确认**态必须不是模态 —— 它得先用 `if (s.committed) { … return; }` 整段让开，
//    再落到那条无条件的 `stopPropagation()`。让不开 ⇒ 工具条的「保存 / 放弃」按空格/回车没反应、
//    Ctrl+S 被吃掉（最讽刺的是「保存」键按不动，而用户唯一的出口就是它）。
check('两端「已确认」态的键盘刻意不是模态（只接管 Esc，其余放行给工具条 / Ctrl+S / 切图）',
  [['src/renderer/preview-crop.js', rendererCrop], ['src/web/js/app.js#webCrop', webCrop]]
    .every(([file, src]) => {
      const body = functionSource(src, file, 'onKey');
      if (body.length === 0) return false;
      // 未确认分支的特征串：无条件 stop + 紧跟 Escape（已确认分支里这两句不相邻）
      const iModal = body.indexOf("e.stopPropagation();\n      if (e.key === 'Escape')");
      const iCommit = body.indexOf('s.committed');
      if (iCommit < 0 || iModal < 0 || iModal < iCommit) return false;
      const commitBlock = body.slice(iCommit, iModal);
      // committed 分支：必须整段 return 让开；其中 `stopPropagation` **有且仅有一处**，
      // 且落在 Escape 判据之内、接 `resume()`。
      // 🔴 「仅一处」是关键：只判 `return;` 存在 + Escape 里有一处 stopPropagation，
      //    对「committed 分支里**又**加了一句无条件 stopPropagation」是瞎的
      //    （牙齿验证实测：那样改仍然全绿）。多一句就多吞一个键 ⇒ 工具条的「保存」按不动。
      const stops = commitBlock.match(/e\.stopPropagation\(\)/g) || [];
      return commitBlock.indexOf('return;') >= 0 &&
        stops.length === 1 &&
        /if \(e\.key === 'Escape'\) \{[\s\S]{0,160}?e\.stopPropagation\(\);[\s\S]{0,160}?resume\(\)/
          .test(commitBlock);
    }, '两端 onKey 的 committed 分支要么取不到、要么仍在无条件吞键'));
check('两端都用 window 捕获阶段监听 keydown（抢在预览自己的处理器之前）',
  /window\.addEventListener\('keydown',\s*[\w.$]+,\s*true\)/.test(rendererCrop) &&
  /window\.addEventListener\('keydown',\s*[\w.$]+,\s*true\)/.test(webCrop));
// ⚠️ 「确认即写回」这条**在 2026-10-09 被用户明确改掉了**：旋转 / 翻转 / 裁剪都改成
//    「先预览、点保存才写回」。所以这里**反向**钉住：`commit()` 里不许出现 exit()、
//    不许出现任何后端调用 —— 写回统一在 `savePreviewEdit()`。
check('两端裁剪确认都**只记录、不落盘**（commit 里既不许 exit、也不许调后端）', (() => {
  const commitBody = (src) => {
    const i = src.indexOf('function commit()');
    return i < 0 ? '' : src.slice(i, i + 900);
  };
  const rc = commitBody(rendererCrop);
  const wc = commitBody(webCrop);
  if (!rc.length || !wc.length) return false;
  const clean = (body) =>
    body.indexOf('exit()') < 0 &&
    body.indexOf('webPostJson') < 0 &&
    body.indexOf('api.photoEdit') < 0;
  return clean(rc) && clean(wc);
})());
check('两端裁剪确认都把层转成「已确认」态（加 is-pending ⇒ 不再吃事件，工具条点得到）',
  /is-pending/.test(rendererCrop) && /is-pending/.test(webCrop) &&
  /classList\.add\('is-pending'\)/.test(rendererCrop) &&
  /classList\.add\('is-pending'\)/.test(webCrop));
// 🔴 「有调用点」不能靠 `/resume\(\)/` —— 那个 regex 会被 **定义** `function resume()` 自己满足
//    （牙齿验证实测：把唯一的调用点删掉仍然全绿）。所以判**出现次数 ≥ 2**（1 定义 + 1 调用）。
check('两端都留了「退回可调整」的出口（Esc 第一下不该把已确认的选区整个丢掉）',
  [rendererCrop, webCrop].every((src) =>
    /function resume\(\)/.test(src) && (src.match(/resume\(\)/g) || []).length >= 2));

// 两端 CSS：层位置与遮罩画法
const cssDesktop = readSource('src/renderer/styles.css');
const cssWeb = readSource('src/web/index.html');
for (const [label, needle] of [
  ['position: fixed（不能用 absolute：定位上下文会变）', 'position: fixed'],
  ['z-index: 15050（高于预览层、低于照片对比）', 'z-index: 15050'],
  ['遮罩用 box-shadow 一笔画（不比四块暗 div 漂移）', 'box-shadow: 0 0 0 9999px'],
  ['三分线不吃鼠标事件', 'pointer-events: none'],
]) {
  check('两端裁剪样式同参：' + label,
    cssDesktop.indexOf(needle) >= 0 && cssWeb.indexOf(needle) >= 0);
}
check('两端都有 .preview-crop-layer / .preview-crop-box / .preview-crop-handle 三个类',
  ['.preview-crop-layer', '.preview-crop-box', '.preview-crop-handle'].every(
    (c) => cssDesktop.indexOf(c) >= 0 && cssWeb.indexOf(c) >= 0,
  ));

// 换图 / 关预览都要收掉选区（否则选框留在屏上却对应了另一张图）
const rendererAppCode = code(readSource('src/renderer/app.js'), 'src/renderer/app.js');
const webAppCode = code(webAppRaw, 'src/web/js/app.js');
// 🔴 `ui-preview.js` 一律用**剥过注释**的这份：本文件里对它的断言有两类都怕注释 ——
//    ① 「某符号已删」（`cyclePreviewRotate`）会被一句「已删除 X」的注释满足；
//    ② 「函数体不再出现某词」（`resetZoom` 不再清 `previewRotateDeg`）会被解释性注释满足。
//    第一版就踩了 ②：注释里写了 `previewRotateDeg`，断言恒红。
const previewUiCode = code(readSource('src/renderer/ui-preview.js'), 'src/renderer/ui-preview.js');

// `renderer/api.js` 的 `has()` 是通用实现（按名字查 preload），所以「环境支不支持」的真正判据
// 在**调用端**：渲染端保存前必须问 `api.has('photoEditApply')`，漏了就会去调不存在的后端。
check("渲染端保存前问 api.has('photoEditApply')（漏了 = 直接调不存在的后端方法）",
  /api\.has\(\s*'photoEditApply'\s*\)/.test(rendererAppCode));
// ⚠️ 保存路径**刻意不再拦视频**：能进到这里的动作都是 `applyPreviewEdit` 攒的，而它已经
//    对视频直接 return + toast（见「视频上不许攒编辑动作」那条）。在保存里再拦一次是重复判据，
//    且会给「测试里改了两处之一」留下漂移空间。
check('视频不许攒编辑动作（拦在攒动作那一层，不在保存层）',
  [['src/renderer/app.js', rendererAppCode, 'isVideoFile(photo)'],
    ['src/web/js/app.js', webAppCode, 'isWebVideoFileType(photo.file_type)']]
    .every(([file, src, needle]) => {
      const body = functionSource(src, file, 'applyPreviewEdit');
      return body.length > 0 && body.indexOf(needle) >= 0;
    }));
check('两端 openPreview 都先收掉裁剪选区',
  /if \(previewCrop\.isActive && previewCrop\.isActive\(\)\) previewCrop\.exit\(\)/.test(rendererAppCode) &&
  /if \(webPreviewCrop && webPreviewCrop\.isActive && webPreviewCrop\.isActive\(\)\)\s*webPreviewCrop\.exit\(\)/.test(webAppCode));
check('两端 closePreview 都先收掉裁剪选区',
  /function closePreview\(\)\s*\{[\s\S]{0,300}?previewCrop\.exit\(\)/.test(rendererAppCode) &&
  /function closePreview\(fromHistory\)\s*\{[\s\S]{0,300}?webPreviewCrop\.exit\(\)/.test(webAppCode));

// 缓存键翻新：两端都必须写回 file_size 与 date_modified 两个字段。
// ⚠️ 2026-10-09 起这件事发生在 `savePreviewEdit()`（点「保存」那一刻），不再是点按钮那一刻。
const rendererEdit = functionSource(rendererAppCode, 'src/renderer/app.js', 'savePreviewEdit');
const webEdit = functionSource(webAppCode, 'src/web/js/app.js', 'savePreviewEdit');
check('夹具自证：能切出两端的 savePreviewEdit 函数体',
  rendererEdit.length > 400 && webEdit.length > 400,
  'renderer=' + rendererEdit.length + ' web=' + webEdit.length);
for (const field of ['file_size', 'date_modified']) {
  check('两端 savePreviewEdit 都翻新 ' + field + '（缓存键的两半缺一即失效）',
    rendererEdit.indexOf('photo.' + field + ' =') >= 0 && webEdit.indexOf('photo.' + field + ' =') >= 0);
}
check('两端保存后都重开当前张（缓存键变了才真的重新取图）',
  /openPreview\(state\.previewIndex\)/.test(rendererEdit) && /openPreview\(state\.previewIndex\)/.test(webEdit));
check('两端裁剪副本都从列表里取新行（自己拼行会缺字段且不报错）',
  rendererEdit.indexOf('state.currentPhotos') >= 0 && webEdit.indexOf('state.currentPhotos') >= 0);

// 下面这一批要用到「编辑按钮显隐」两段函数体与桌面端 HTML，提前切出来
// （原先它们和各自的显隐断言放在一起，位置靠后 ⇒ 这里用会踩 TDZ）。
const rendererSyncEdit = functionSource(rendererAppCode, 'src/renderer/app.js', 'syncPreviewEditButtons');
const webSyncEdit = functionSource(webAppCode, 'src/web/js/app.js', 'syncPreviewEditButtons');
const rendererHtml = readSource('src/renderer/index.html');

// ── 预览态编辑：攒动作、保存才写回（2026-10-09 用户要求）
check('两端都只攒「动作串」、不做前端代数合成（后端 `composeAction` 是唯一实现源）',
  /previewEditPendingActions/.test(rendererAppCode) && /previewEditPendingActions/.test(webAppCode) &&
  rendererAppCode.indexOf('previewEditCssTail') >= 0 && webAppCode.indexOf('previewEditCssTail') >= 0);

// 两端的「动作 → CSS 函数」表与「逆动作」表必须逐字相同（否则同一串动作在两端预览出不同结果）。
// 依赖 CSS 求值顺序（最右先作用 = 先镜像后旋转）与 sharp 同构 ⇒ 原样拼接即等价，不需要代数。
const actionCssRe = /var PREVIEW_EDIT_ACTION_CSS = \{[\s\S]*?\n\};/;
const actionInvRe = /var PREVIEW_EDIT_ACTION_INVERSE = \{[\s\S]*?\n\};/;
for (const [label, re] of [
  ['动作 → CSS 函数表', actionCssRe],
  ['动作 → 逆动作表', actionInvRe],
]) {
  const a = (rendererAppCode.match(re) || [''])[0];
  const b = (webAppCode.match(re) || [''])[0];
  check('两端 ' + label + ' 逐字相同（同一串动作两端预览必须一致）', !!a && a === b,
    'len=' + a.length + '/' + b.length);
}
check('CSS 表里四个动作都在、且是 rotate/scaleX/scaleY 的原样函数',
  /'rotate-right':\s*'rotate\(90deg\)'/.test(rendererAppCode) &&
  /'rotate-left':\s*'rotate\(-90deg\)'/.test(rendererAppCode) &&
  /'flip-h':\s*'scaleX\(-1\)'/.test(rendererAppCode) &&
  /'flip-v':\s*'scaleY\(-1\)'/.test(rendererAppCode));
check('两端 CSS 尾巴都是**逆序**拼（后点的动作写在最前面才等于「后作用于显示」）',
  /for \(var i = list\.length - 1; i >= 0; i--\)/.test(rendererAppCode) &&
  /for \(var i = list\.length - 1; i >= 0; i--\)/.test(webAppCode));
check('两端点「相反动作」即抵消（点错一下不用「放弃全部」重来）',
  /PREVIEW_EDIT_ACTION_INVERSE\[action\]/.test(rendererAppCode) &&
  /PREVIEW_EDIT_ACTION_INVERSE\[action\]/.test(webAppCode));

// 🔴 旋转变换必须真的进到 `<img>` 的 style.transform 里 —— 只存 state 不画 = 用户看不见任何变化。
check('桌面端 updatePreviewTransform 接上 CSS 尾巴', (() => {
  const body = functionSource(previewUiCode, 'src/renderer/ui-preview.js', 'updatePreviewTransform');
  return body.length > 0 && /state\.previewEditCssTail/.test(body);
})());
//    🔴 断言必须落在**函数体里**：只判 `webAppCode` 里有没有 `state.previewEditCssTail`
//    是瞎的 —— 那个符号在 state 声明、`repaintPreviewEdit`、`resetPreviewPendingEdit` 里
//    到处都是，把 `updatePreviewTransform` 里的读取删掉仍然全绿（牙齿验证实测）。
check('网页端 updatePreviewTransform 接上 CSS 尾巴', (() => {
  const body = functionSource(webAppCode, 'src/web/js/app.js', 'updatePreviewTransform');
  return body.length > 0 && /state\.previewEditCssTail/.test(body);
})());
check('桌面端不再有「只转显示、不写文件」的旧路径（cyclePreviewRotate 已删）',
  previewUiCode.indexOf('cyclePreviewRotate') < 0);
check('桌面端 resetZoom 不再清 previewRotateDeg（它现在属于待保存编辑，清了会「图与留白对不上」）',
  (() => {
    const body = functionSource(previewUiCode, 'src/renderer/ui-preview.js', 'resetZoom');
    return body.length > 0 && body.indexOf('previewRotateDeg') < 0;
  })());

// ── 保存/放弃两个结算键
check('桌面端两个结算键进了 dom 表且工具条里真的有（缺一个 ⇒ 待保存的编辑没有出口）',
  ['previewEditSaveBtn', 'previewEditDiscardBtn'].every(
    (k) => rendererAppCode.indexOf(k + ": $('#" + k + "')") >= 0) &&
  ['previewEditSaveBtn', 'previewEditDiscardBtn'].every(
    (k) => rendererHtml.indexOf('id="' + k + '"') >= 0));
check('网页端两个结算键也在（默认 hidden，由 syncPreviewEditButtons 放行）',
  ['previewEditSaveBtn', 'previewEditDiscardBtn'].every(
    (k) => cssWeb.indexOf('id="' + k + '"') >= 0));
check('桌面端两个结算键也用行内 display 显隐（`.btn.btn-sm` 压过 UA 的 [hidden]）',
  /dom\.previewEditSaveBtn/.test(rendererSyncEdit) &&
  /dom\.previewEditDiscardBtn/.test(rendererSyncEdit) &&
  /onlyWhilePending/.test(rendererSyncEdit));
// 🔴 判据是「**两个**结算键各自被待保存状态把住」，不是「函数体里出现过这个词」：
//    后者在把一个按钮的开关摘掉时仍然为真（牙齿验证实测）。两端机制不同（桌面端逐项开关、
//    网页端按 id 判），所以各钉各的形态 —— 不硬凑成同一个 regex。
check('两端「保存 / 放弃」都只在有待保存内容时才亮（空着点一下等于点了没反应）',
  /hasPendingPreviewEdit\(\)/.test(rendererAppCode) && /hasPendingPreviewEdit\(\)/.test(webAppCode) &&
  // 桌面端：两个结算键各自带 onlyWhilePending: true ⇒ 恰好两处
  (rendererSyncEdit.match(/onlyWhilePending:\s*true/g) || []).length === 2 &&
  // 网页端：两个 id 都落在「且 !pending」的那个判据里
  /ids\[i\] === 'previewEditSaveBtn'\s*\|\|\s*ids\[i\] === 'previewEditDiscardBtn'[\s\S]{0,200}?!pending/
    .test(webSyncEdit));

// ── 离开当前图时不许静默丢待保存的编辑
check('桌面端 openPreview / closePreview 都清空待保存编辑（唯一清空点，散在调用点必然漏）',
  /function openPreview\(index\)[\s\S]{0,400}?resetPreviewPendingEdit\(\)/.test(rendererAppCode) &&
  /function closePreview\(\)[\s\S]{0,400}?resetPreviewPendingEdit\(\)/.test(rendererAppCode));
check('网页端同上',
  /function openPreview\(index\)[\s\S]{0,500}?resetPreviewPendingEdit\(\)/.test(webAppCode) &&
  /function closePreview\(fromHistory\)[\s\S]{0,500}?resetPreviewPendingEdit\(\)/.test(webAppCode));
check('桌面端切图 / 关预览 / 开幻灯片 / 首尾张四条入口都挂了守卫',
  /function guardedClosePreview\(\)/.test(rendererAppCode) &&
  /function guardedNavigatePreview\(dir\)/.test(rendererAppCode) &&
  /function guardedOpenPreviewAt\(index\)/.test(rendererAppCode) &&
  /function guardedToggleSlideshow\(\)/.test(rendererAppCode) &&
  /onClosePreview: guardedClosePreview/.test(rendererAppCode) &&
  /onNavigatePreview: guardedNavigatePreview/.test(rendererAppCode) &&
  /onOpenPreview: guardedOpenPreviewAt/.test(rendererAppCode) &&
  /onToggleSlideshow: guardedToggleSlideshow/.test(rendererAppCode));
check('网页端切图 / 关预览也挂了守卫（历史回退那一条**刻意不走**守卫）',
  /function guardedClosePreview\(\)/.test(webAppCode) &&
  /hasPendingPreviewEdit\(\)[\s\S]{0,200}?guardPendingPreviewEdit\(function \(\) \{\n {6}navigatePreview\(dir, null\)/.test(webAppCode) &&
  /closePreview\(true\)/.test(webAppCode) && !/guardPendingPreviewEdit\([\s\S]{0,80}closePreview\(true\)/.test(webAppCode));
check('桌面端 Ctrl+S 已注册（待保存的编辑必须有一个键盘出口）',
  /id: 'preview\.editSave'[\s\S]{0,260}?scope: 'preview'/.test(readSource('src/renderer/shortcuts.js')) &&
  /case 'preview\.editSave':[\s\S]{0,220}?onPreviewEditSave\(\)/.test(
    readSource('src/renderer/ui-events.js')));
// 🔴 `preventDefault` 必须**在 regex 里**：光判「Ctrl+S 走到了 savePreviewEdit」是瞎的 ——
//    不拦默认行为时浏览器仍会弹「保存网页」，app 的保存被顶掉（牙齿验证实测）。
check('网页端 Ctrl/Cmd+S 也接上（且 preventDefault，否则浏览器会弹「保存网页」）',
  /e\.ctrlKey \|\| e\.metaKey[\s\S]{0,200}?e\.preventDefault\(\)[\s\S]{0,200}?savePreviewEdit\(\)/
    .test(webAppCode));

// ── 裁剪几何：**不许**再把元素盒当图片盒（实测过的坑，见下）
check('两端裁剪都用 viewRect 按 contain 规则自己算图片占据的那块',
  /function viewRect\(/.test(rendererCrop) && /function viewRect\(/.test(webCrop));
check('前提断言③：两端预览图的 CSS 确实让元素盒 ≠ 图片盒（contain 留白）',
  /\.preview-image\s*\{[\s\S]{0,300}?object-fit:\s*contain/.test(cssDesktop) &&
  /\.preview-img\s*\{[\s\S]{0,300}?object-fit:\s*contain/.test(cssWeb));
check('两端 viewRect 都在旋转 90/270 时把视觉盒宽高对调',
  /rot \? ch : cw/.test(rendererCrop) && /rot \? cw : ch/.test(rendererCrop) &&
  /rot \? ch : cw/.test(webCrop) && /rot \? cw : ch/.test(webCrop));
check('两端 currentRect / paint 都改用 viewRect 的换算比例（不再拿 natural/frame 硬算）',
  /view\.scaleX/.test(rendererCrop) && /view\.scaleY/.test(rendererCrop) &&
  /view\.scaleX/.test(webCrop) && /view\.scaleY/.test(webCrop) &&
  rendererCrop.indexOf('naturalWidth / session.frame.width') < 0 &&
  webCrop.indexOf('naturalWidth / s.frame.width') < 0);
check('两端已确认的选区在窗口 resize 后跟着重排（不是整层丢掉）',
  /if \(s\.committed\) \{[\s\S]{0,300}?selFromRect\(s\.rect, s\.view\)/.test(rendererCrop) &&
  /if \(s\.committed\) \{[\s\S]{0,300}?selFromRect\(s\.rect, s\.view\)/.test(webCrop));
check('两端 `is-pending` 样式都在（不吃事件，否则工具条被 9999px 外阴影挡住 ⇒ 点「保存」无效）',
  /\.preview-crop-layer\.is-pending\s*\{[^}]*pointer-events:\s*none/.test(cssDesktop) &&
  /\.preview-crop-layer\.is-pending\s*\{[^}]*pointer-events:\s*none/.test(cssWeb));
check('两端裁剪键盘在通用弹窗打开时让路（同为 window 捕获，不让路会把弹窗的 Esc 吃掉）',
  /appDialogOverlay[\s\S]{0,200}?classList\.contains\('show'\)/.test(rendererCrop) &&
  /appDialogOverlay[\s\S]{0,200}?classList\.contains\('show'\)/.test(webCrop));

// 裁剪 rect 的坐标系契约：先用变换写回、再 extract，所以 rect 就是「变换后那张图」的坐标
check('两端传给后端的裁剪 rect 都取 webPreviewCrop/previewCrop 的已确认值（不是自己重算）',
  /previewCrop\.pendingRect\(\)/.test(rendererEdit) && /webPreviewCrop\.pendingRect\(\)/.test(webEdit));

// 网页端：编辑按钮的显隐随图片/视频走
// （`webSyncEdit` 的声明已提到前面「预览态编辑」一节之前，那里也要用）
check('网页端预览按「是不是视频」决定编辑按钮显隐',
  webAppCode.indexOf('syncPreviewEditButtons(') >= 0 &&
  /isWebVideoFileType\(photo\.file_type\)/.test(webSyncEdit));

// ── 桌面端同一条显隐契约。两端机制**刻意不同**，不是笔误：
//    网页端用 `hidden` 属性（兜底规则特异性够），桌面端只能用行内 `style.display`。
//    理由在下面两条里被钉成可验证的事实，而不是只写在注释里。
//    （`rendererSyncEdit` / `rendererHtml` 的声明同样已提前）
const previewFlowCode = readSource('src/renderer/preview-flow.js');

check('夹具自证：能切出桌面端 syncPreviewEditButtons 函数体',
  rendererSyncEdit.length > 200, String(rendererSyncEdit.length));
check('桌面端编辑按钮也按「是不是视频」决定显隐',
  /isVideoFile\(photo\)/.test(rendererSyncEdit));

// 🔴 桌面端不能退回 `hidden` 属性：三个按钮带 `.btn.btn-sm`，桌面端有一条
//    `.preview-controls-group > .btn.btn-sm { display: inline-flex }`（特异性 0,3,0）
//    是作者样式，按层叠规则永远压过 UA 的 `[hidden] { display: none }`（元素级）；
//    补 `.xxx[hidden]` 兜底（0,2,0）也仍然输给那条子选择器 ⇒ 属性设了等于没设。
//    所以这里**反向**钉住：函数体必须出现行内 display、且不许出现 setAttribute('hidden')。
check('桌面端编辑按钮用行内 display 显隐（只有 hidden 属性 ⇒ 视频也亮着编辑键）',
  /style\.display\s*=/.test(rendererSyncEdit) &&
  rendererSyncEdit.indexOf("setAttribute('hidden'") < 0);
check('前提断言①：桌面端编辑三连确实带 .btn.btn-sm（上一条约束的由来）', (() => {
  const start = rendererHtml.indexOf('id="previewRotateBtn"');
  if (start < 0) return false;
  const end = rendererHtml.indexOf('id="previewCropBtn"');
  if (end < 0) return false;
  return rendererHtml.slice(start - 260, end + 260).indexOf('class="btn btn-sm"') >= 0;
})());
check('前提断言②：桌面端确实存在给 .preview-controls-group > .btn.btn-sm 设 display 的规则',
  /\.preview-controls-group > \.btn\.btn-sm[\s\S]{0,300}?display:\s*inline-flex/.test(cssDesktop));

check('网页端保留 .preview-edit-btn[hidden] 兜底（删掉即静默失效：属性藏不住）',
  /\.preview-action-btn\.preview-edit-btn\[hidden\]\s*\{[^}]*display:\s*none/.test(cssWeb));
check('两端都把「裁剪进行中」并进隐藏判据、且各留一个豁免键',
  /cropping/.test(rendererSyncEdit) && /keepWhileCropping:\s*true/.test(rendererSyncEdit) &&
  /cropping/.test(webSyncEdit) && /!==\s*'previewCropBtn'/.test(webSyncEdit));

check('桌面端切图路径回调编辑按钮同步（与 LIVE 按钮同一位置：只写在 openPreview 里覆盖不到左右切换）',
  /onSyncPreviewLiveButton\(photo, isVideo\)[\s\S]{0,400}?onSyncPreviewEditButtons\(photo, isVideo\)/
    .test(previewFlowCode));
check('桌面端 bindEvents 把 syncPreviewEditButtons 传进 preview-flow（漏了 = 视频也亮着编辑键）',
  /onSyncPreviewEditButtons:\s*syncPreviewEditButtons/.test(rendererAppCode));
check('桌面端编辑按钮三项进了 dom 表（缺一个 ⇒ 那个按钮永不熄灭）',
  ['previewRotateBtn', 'previewFlipBtn', 'previewCropBtn'].every(
    (k) => rendererAppCode.indexOf(k + ": $('#" + k + "')") >= 0));
// 网页端没有 preview-flow 那一层，所以判据直接落在 `openPreview` 函数体里：
// 所有切图路径（方向键 / 幻灯片 / 翻页 / 打开单张）都汇到它 ⇒ 写在这里才覆盖得到左右切换。
// （唯一不到的路径是函数开头 `if (!img) return;` —— 那时预览本身已经坏了，不算漏。）
check('网页端 openPreview 里也随每一次切图同步编辑按钮（只写在 openPreviewByPhotoRecord 里覆盖不到左右切换）',
  (() => {
    const body = functionSource(webAppCode, 'src/web/js/app.js', 'openPreview');
    return body.length > 0 && /syncPreviewEditButtons\(photo\)/.test(body);
  })());

// ── R 键：**既有**快捷键（`shortcuts.js` 的 `preview.rotate`，v1.3.0 起就在）。
//    它的三段历史：① 原走 `previewInteraction.cyclePreviewRotate`（只改 `state.previewRotateDeg`，
//    纯显示层、关掉预览即消失、不碰文件）；② 上一批短暂接到写回；③ **本批定为「只改预览、
//    保存才写回」** —— 与用户诉求「旋转需要确认才写入变化」一致。
//    🔴 于是这里钉的判据是「R **只攒动作**、绝不自己落盘」：谁把 R 直接接到 `savePreviewEdit`
//    或 IPC，用户按一下就改文件、预览里的确认环节被绕过（这正是用户要去掉的行为）。
const shortcutsCode = readSource('src/renderer/shortcuts.js');
const uiEventsCode = readSource('src/renderer/ui-events.js');
check('R 键（preview.rotate）限定在 preview 作用域（脱掉 scope ⇒ 不在预览里按 R 也会动图）',
  /id: 'preview\.rotate'[\s\S]{0,260}?scope: 'preview'/.test(shortcutsCode));
check('ui-events 仍把 preview.rotate 转发给 onCyclePreviewRotate',
  /case 'preview\.rotate':[\s\S]{0,220}?onCyclePreviewRotate\(\)/.test(uiEventsCode));
check('cyclePreviewRotateAction 只攒动作（applyPreviewEdit），不直接落盘',
  (() => {
    const body = functionSource(rendererAppCode, 'src/renderer/app.js', 'cyclePreviewRotateAction');
    return body.length > 0 &&
      /applyPreviewEdit\(e && e\.shiftKey \? 'rotate-left' : 'rotate-right'\)/.test(body) &&
      body.indexOf('savePreviewEdit') < 0 && body.indexOf('photoEditApply') < 0;
  })());
check('翻转同构：Shift 交换方向（两端按钮点击与键盘共用同一个 shiftKey 判据）', (() => {
  const body = functionSource(rendererAppCode, 'src/renderer/app.js', 'previewEditFlipAction');
  return body.length > 0 && /applyPreviewEdit\(e && e\.shiftKey \? 'flip-v' : 'flip-h'\)/.test(body);
})());
check('桌面端「R 键」与「旋转按钮」走的是同一个 applyPreviewEdit（两条入口不许分叉）',
  functionSource(rendererAppCode, 'src/renderer/app.js', 'cyclePreviewRotateAction').indexOf('applyPreviewEdit') >= 0);

// ════════════════════════════════════════════════════════ 7. 文案（零「照片」）

const i18nCode = readSource('src/renderer/i18n.js');
const editKeys = ['preview.flip', 'preview.flipTitle', 'preview.crop', 'preview.cropTitle',
  'preview.rotateTitle',
  'edit.saved', 'edit.failed', 'edit.cropHint', 'edit.cropSaved', 'edit.noPhoto', 'edit.unsupported',
  // 本批新增（预览态编辑）：两个结算键 + 四条过程提示 + 守卫弹窗标题正文。
  'preview.editSave', 'preview.editSaveTitle', 'preview.editDiscard', 'preview.editDiscardTitle',
  'edit.discarded', 'edit.cropPendingHint', 'edit.cropStaged', 'edit.saveOrDiscardCrop',
  'edit.pendingTitle', 'edit.pendingMessage'];
check('编辑类 i18n 词条齐 ' + editKeys.length + ' 条、且中英各一份（只加中文 ⇒ 英文界面露出中文兜底）',
  editKeys.every((k) => {
    const hits = i18nCode.split("'" + k + "'").length - 1;
    return hits >= 2;
  }),
  editKeys.filter((k) => i18nCode.split("'" + k + "'").length - 1 < 2).join(','));
check('网页端编辑按钮区文案零「照片」（用「图片」）', (() => {
  const html = readSource('src/web/index.html');
  const start = html.indexOf('id="previewRotateBtn"');
  const block = html.slice(start, html.indexOf('id="previewCropBtn"') + 400);
  return start >= 0 && block.indexOf('照片') < 0;
})());
check('网页端编辑相关函数的 toast 文案零「照片」', (() => {
  // 🔴 这里必须同时要求「函数体取得到」：`commitPreviewCrop` 已被 `savePreviewEdit` 取代，
  //    单判 `indexOf('照片') < 0` 时，一个**已删除**的函数会切出空串、恒过（假绿）。
  const fns = ['savePreviewEdit', 'previewCropAction', 'syncPreviewEditButtons'];
  return fns.every((n) => {
    const body = functionSource(webAppCode, 'src/web/js/app.js', n);
    return body.length > 0 && body.indexOf('照片') < 0;
  });
})());

// ════════════════════════════════════════════════════════ 8. 行为：临时库 + 临时目录跑全链

function makeRaw(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      buf[i] = 10 + ((x * 6) % 240);
      buf[i + 1] = 20 + ((y * 11) % 240);
      buf[i + 2] = 30 + ((x + y) % 200);
    }
  }
  return buf;
}

async function behavioural() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-edit-reg-'));
  const db = new PhotoDatabase(path.join(dir, 'test.db'));
  try {
    const rootId = db.addRootFolder(dir);
    const thumbSize = thumbFormat.THUMB_SIZE_CHOICES[0];
    const service = createPhotoEditService({
      db,
      getThumbOptions: () => ({ size: thumbSize, quality: thumbFormat.THUMB_DEFAULT_QUALITY }),
      videoExtensions: new Set(['.mp4', '.mov']),
      invalidateForRoot: () => {},
      invalidateDerivedGroups: () => {},
      logWarn: () => {},
    });

    const rowOf = (id) => db.db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    const dbMtime = (st) => st.mtime.toISOString().replace('T', ' ').substring(0, 19);

    const insert = (filePath, fileType) => {
      const st = fs.statSync(filePath);
      db.insertPhoto({
        rootId,
        folderPath: dir,
        fileName: path.basename(filePath),
        filePath,
        fileSize: st.size,
        fileType,
        width: 0,
        height: 0,
        dateTaken: dbMtime(st),
        dateModified: dbMtime(st),
        thumbnail: null,
        hasThumbnail: false,
      });
      return db.getPhotoIdByFilePath(filePath);
    };

    // —— 素材 ——
    const W = 40;
    const H = 20;
    const jPath = path.join(dir, 'plain.jpg');
    await sharp(makeRaw(W, H), { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 92 })
      .toFile(jPath);
    const jId = insert(jPath, 'jpg');

    const exPath = path.join(dir, 'exif6.jpg');
    await sharp(makeRaw(W, H), { raw: { width: W, height: H, channels: 3 } })
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'RegCam' } } })
      .jpeg({ quality: 92 })
      .toFile(exPath);
    const exId = insert(exPath, 'jpg');

    const rawPath = path.join(dir, 'fake.cr2');
    fs.writeFileSync(rawPath, Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2, 3, 4]));
    const rawId = insert(rawPath, 'cr2');

    const vidPath = path.join(dir, 'fake.mp4');
    fs.writeFileSync(vidPath, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    const vidId = insert(vidPath, 'mp4');

    const pngPath = path.join(dir, 'pic.png');
    await sharp(makeRaw(30, 30), { raw: { width: 30, height: 30, channels: 3 } })
      .png()
      .toFile(pngPath);
    const pngId = insert(pngPath, 'png');

    // —— P0：写回 ——
    const r1 = await service.transform(jId, 'rotate-right');
    check('行为 P0：90° 旋转后宽高对调（40x20 → 20x40）',
      r1.width === 20 && r1.height === 40, r1.width + 'x' + r1.height);
    check('行为 P0：返回值带 dateModified（界面的缓存键靠它）',
      typeof r1.dateModified === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r1.dateModified),
      String(r1.dateModified));

    const meta1 = await sharp(jPath).metadata();
    check('行为 P0：输出文件 orientation 归一化为 1',
      meta1.orientation === 1 || meta1.orientation === undefined, String(meta1.orientation));

    const st1 = fs.statSync(jPath);
    const row1 = rowOf(jId);
    check('行为 P0：库里 width/height 跟着文件走（列缺 id 时这里会安静地停在 0x0）',
      row1.width === meta1.width && row1.height === meta1.height,
      row1.width + 'x' + row1.height + ' / 文件 ' + meta1.width + 'x' + meta1.height);
    check('行为 P0：库里 file_size 跟着文件走', Number(row1.file_size) === st1.size,
      row1.file_size + ' / ' + st1.size);
    check('行为 P0：库里 date_modified 与 mtime 逐字一致（记账列的判据）',
      row1.date_modified === dbMtime(st1), row1.date_modified + ' / ' + dbMtime(st1));
    check('行为 P0：缩略图已重算', row1.has_thumbnail === 1 && !!row1.thumbnail);
    const expectDhash = await computeDhash(jPath);
    check('行为 P0：dHash 与文件重算结果一致', row1.dhash === expectDhash,
      row1.dhash + ' / ' + expectDhash);
    check('行为 P0：SHA-256 指纹已清空', row1.file_hash === null || row1.file_hash === undefined,
      String(row1.file_hash));
    check('行为 P0：无临时文件残留（原子替换没留尾巴）', !fs.existsSync(jPath + imageEdit.TMP_SUFFIX));

    // —— P0：带 EXIF 方向 ——
    const r2 = await service.transform(exId, 'rotate-right');
    const afterEx = await sharp(exPath).metadata();
    check('行为 P0：带 EXIF(6) 的图先转正再叠动作（存储 40x20 ⇒ 用户看见 20x40 ⇒ 顺转 90 = 40x20）',
      r2.width === 40 && r2.height === 20, r2.width + 'x' + r2.height);
    check('行为 P0：带方向的图输出 orientation 仍是 1（否则缩略图会再转 180°）',
      afterEx.orientation === 1 || afterEx.orientation === undefined, String(afterEx.orientation));

    // —— P0：翻转不改尺寸 ——
    const r3 = await service.transform(pngId, 'flip-h');
    check('行为 P0：水平翻转尺寸不变（30x30）', r3.width === 30 && r3.height === 30,
      r3.width + 'x' + r3.height);

    // —— 拒绝路径：文件一个字节都不许动 ——
    const rawBefore = fs.readFileSync(rawPath);
    let rawErr = '';
    try {
      await service.transform(rawId, 'rotate-right');
    } catch (e) {
      rawErr = e.message;
    }
    check('行为：RAW 被拒绝且原文件未被改动',
      /RAW/.test(rawErr) && Buffer.compare(rawBefore, fs.readFileSync(rawPath)) === 0, rawErr);

    let vidErr = '';
    try {
      await service.transform(vidId, 'rotate-right');
    } catch (e) {
      vidErr = e.message;
    }
    check('行为：视频被拒绝', /视频/.test(vidErr), vidErr);

    let badErr = '';
    try {
      await service.transform(jId, 'explode');
    } catch (e) {
      badErr = e.message;
    }
    check('行为：未知动作被拒绝', /未知的编辑动作/.test(badErr), badErr);

    // —— P1：裁剪另存 + 入库 ——
    const c1 = await service.crop(jId, { left: 1, top: 1, width: 10, height: 8 });
    check('行为 P1：产物文件存在且带 _crop 后缀',
      fs.existsSync(c1.filePath) && /_crop(\d+)?\.[a-z]+$/.test(c1.filePath),
      path.basename(c1.filePath));
    const c1meta = await sharp(c1.filePath).metadata();
    check('行为 P1：产物像素尺寸 = 选区（extract 吃的是用户看到的坐标系）',
      c1meta.width === 10 && c1meta.height === 8, c1meta.width + 'x' + c1meta.height);
    check('行为 P1：产物 orientation=1', c1meta.orientation === 1 || c1meta.orientation === undefined,
      String(c1meta.orientation));

    const c1row = rowOf(c1.id);
    check('行为 P1：副本已成一条正常行（从这里起它和用户自己导入的图没有区别）', !!c1row);
    check('行为 P1：副本 derived_from 指向原图',
      !!c1row && Number(c1row.derived_from) === Number(jId),
      c1row ? String(c1row.derived_from) + ' / 原图 ' + jId : 'missing');
    check('行为 P1：副本 id 与原件不同（撞行会被显式抛错）', !!c1row && c1row.id !== jId);
    check('行为 P1：副本缩略图 / dHash 都已生成',
      !!c1row && c1row.has_thumbnail === 1 && !!c1row.thumbnail && /^[0-9a-f]{16}$/.test(c1row.dhash || ''));
    const c1st = fs.statSync(c1.filePath);
    check('行为 P1：副本 file_size 与文件一致',
      !!c1row && Number(c1row.file_size) === c1st.size, c1row ? String(c1row.file_size) : '');
    check('行为 P1：副本 date_taken 跟随原图（不取落盘时间）',
      !!c1row && c1row.date_taken === rowOf(jId).date_taken, c1row ? String(c1row.date_taken) : '');

    const c2 = await service.crop(jId, { left: 2, top: 2, width: 6, height: 6 });
    check('行为 P1：二次裁剪不覆盖已有副本',
      c2.filePath !== c1.filePath && fs.existsSync(c1.filePath),
      path.basename(c1.filePath) + ' / ' + path.basename(c2.filePath));

    let rangeErr = '';
    try {
      await service.crop(jId, { left: 999, top: 999, width: 10, height: 10 });
    } catch (e) {
      rangeErr = e.message;
    }
    check('行为 P1：越界选区被拒绝', /超出图片范围/.test(rangeErr), rangeErr);
  } finally {
    try {
      db.close && db.close();
    } catch (eClose) {
      void eClose;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (eRm) {
      void eRm;
    }
  }
}

// ════════════════════════════════════════════════════════ 9. 登记进全量回归

const runSrc = readSource('scripts/run-regressions.js');
check('本守护已登记进 scripts/run-regressions.js',
  runSrc.includes("'photo-edit-regression.js'"));
check('登记位置在末项 ai-lifecycle-regression 之前（末项约定不能破）', (() => {
  const i = runSrc.indexOf("'photo-edit-regression.js'");
  const j = runSrc.indexOf("'ai-lifecycle-regression.js'");
  return i >= 0 && j >= 0 && i < j;
})());

// ---------------------------------------------------------------------- 输出

(async function main() {
  try {
    await behavioural();
  } catch (eBehaviour) {
    check('行为组能完整跑完（临时库 + 临时目录）', false,
      (eBehaviour && eBehaviour.message) || String(eBehaviour));
  }

  process.stdout.write('[photo-edit-regression] 图片编辑（P0 旋转/翻转写回 · P1 裁剪入库）\n');
  for (const line of notes) process.stdout.write(line + '\n');
  if (errors.length) {
    process.stdout.write('\n');
    for (const line of errors) process.stdout.write(line + '\n');
    process.stdout.write('\n[photo-edit-regression] FAIL（' + errors.length + ' 项）\n');
    process.exit(1);
  }
  process.stdout.write('\n[photo-edit-regression] PASS（' + notes.length + ' 项）\n');
})();
