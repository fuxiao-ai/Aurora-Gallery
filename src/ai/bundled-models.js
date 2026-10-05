'use strict';

/**
 * 随包内置模型（`models/`）→ 用户目录的播种层。
 *
 * 原来两套模型都靠用户目录里的 `aiPath` 承载，第一次用要在界面上点一次「下载模型」。
 * `scripts/after-pack.js` 其实早就把仓库里的 `models/` 复制进 `resources/models`，
 * 但**没有任何代码读它** —— 那份文件一直是死重。这里补上消费端：
 *
 *   - 人脸：`models/face/*` → `<faceAiPath>/models/`。**这里不做哈希判定** —— 判定权归 face
 *     worker 的 `verify()`（它按 `face-model.js` 的 `FILES` 哈希说话）。播种只负责把
 *     缺失的、尺寸不对的文件补齐，于是「上一代只装了 SFace 的目录」也能就地升到 w600k_mbf。
 *   - 搜图：`models/search/*` → `<searchAiPath>/models/`，并写入 `ready.json`。这里多一道
 *     manifest 哈希校验，因为 `ready.json` 是「模型可用」的**唯一标记**（`semantic-worker`
 *     的 status / 只读检索都只认它），而安装流程写这个标记前会真的把两套编码器载起来跑一遍。
 *     播种没有那个机会（在主进程里载 SigLIP2 代价与风险都不可接受），
 *     于是改用「打包时算好的哈希」代替那次实测。
 *
 * ⚠️ `ready.json` 里的 `model` 必须与 `MODEL_KEY`（含 revision 与量化档）**逐字符相同**，
 * 否则搜图 worker 会把这份缓存当空气、直接报 `AI_MODEL_MISSING`。这正是 manifest 要记
 * `modelKey` 的原因：**版本对不上就什么都不做**，交回界面上的下载流程；
 * 绝不能把上一代权重标成当前这一代。
 *
 * 幂等 + 只报不抛：已就绪时一次 `statSync` 就返回，不重复搬几百 MB；播种失败也只是报告，
 * 因为内置模型的意义是「省一次下载」，不该变成新的一处启动故障点。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 1;
const READY_FILE = 'ready.json';

/** 读取随包 manifest。形状不认识 / 版本对不上都当作「没有随包模型」。 */
function readManifest(modelsDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(modelsDir, MANIFEST_FILE), 'utf8'));
    if (!manifest || manifest.version !== MANIFEST_VERSION) return null;
    return manifest;
  } catch (_) {
    return null;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return -1;
  }
}

/** 目录下所有文件的相对路径（统一 `/` 分隔，manifest 与跨平台复制都用它当键）。 */
function listFiles(root, base = root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * 先写临时名再 `rename` 就位。
 *
 * 目的不是防并发（播种只在主进程里跑一次），而是**避免留下半截文件**：用户目录里的模型
 * 可能正被 worker 打开，直接覆盖一旦中断就会留下一个尺寸不对的文件，而尺寸不对的文件
 * 会让 `verify()` / manifest 校验长期为假、看起来像「模型坏了」。rename 失败（目标被占用）
 * 时退回直接复制，并把异常交给调用方按普通错误处理。
 */
function copyAtomic(from, to) {
  const temp = to + '.seeding';
  try {
    fs.copyFileSync(from, temp);
    fs.renameSync(temp, to);
  } catch (_) {
    try {
      fs.rmSync(temp, { force: true });
    } catch (_) {
      // 临时文件清不掉就留着：.seeding 后缀不会参与任何校验，下次播种会重新覆盖它。
    }
    fs.copyFileSync(from, to);
  }
}

/** `ready.json` 是否就是「当前这一代搜图模型已就绪」。与 worker 的判定同源、同字段。 */
function isSearchReady(searchAiPath, modelKey) {
  try {
    return JSON.parse(fs.readFileSync(path.join(searchAiPath, READY_FILE), 'utf8')).model === modelKey;
  } catch (_) {
    return false;
  }
}

function writeSearchReady(searchAiPath, modelKey) {
  const file = path.join(searchAiPath, READY_FILE);
  fs.mkdirSync(searchAiPath, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ model: modelKey }));
  fs.renameSync(file + '.tmp', file);
}

/**
 * 人脸：按「缺了才补、尺寸不对才换」搬文件，不做哈希判定（判定权在 face worker 的 verify）。
 */
function seedFace(modelsDir, faceAiPath) {
  const source = path.join(modelsDir, 'face');
  if (!fs.existsSync(source)) return { status: 'no-bundle', copied: 0, checked: 0 };
  const files = listFiles(source);
  if (!files.length) return { status: 'empty-bundle', copied: 0, checked: 0 };
  const target = path.join(faceAiPath, 'models');
  let copied = 0;
  for (const relative of files) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    if (sizeOf(to) === sizeOf(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyAtomic(from, to);
    copied++;
  }
  return { status: copied ? 'seeded' : 'already-complete', copied, checked: files.length };
}

/**
 * 搜图：按 manifest 复制 + 全量哈希核对，最后才落 `ready.json`。
 *
 * 三种「什么都不做」都要能说出理由（`status`），因为调用方要把它们记进日志：
 * 没有随包目录 / manifest 里没这一节 / `modelKey` 不是当前这一代。
 */
function seedSearch(modelsDir, searchAiPath, modelKey) {
  const manifest = readManifest(modelsDir);
  const section = manifest && manifest.search;
  const checked = section && Array.isArray(section.files) ? section.files.length : 0;
  if (!section || !Array.isArray(section.files) || !section.files.length)
    return { status: 'no-bundle', copied: 0, checked: 0 };
  if (!modelKey || section.modelKey !== modelKey)
    return { status: 'model-mismatch', copied: 0, checked };
  if (isSearchReady(searchAiPath, modelKey)) return { status: 'already-ready', copied: 0, checked };

  const root = path.join(searchAiPath, 'models');
  let copied = 0;
  for (const file of section.files) {
    const from = path.join(modelsDir, 'search', file.path);
    const to = path.join(root, file.path);
    if (sizeOf(to) === file.bytes) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyAtomic(from, to);
    copied++;
  }
  // 代替「安装时真载一遍编码器」的那道闸门：哈希对不上就绝不落 ready.json，
  // 让界面继续显示「未就绪」，用户点下载仍然能自救。
  for (const file of section.files) {
    const to = path.join(root, file.path);
    if (sizeOf(to) !== file.bytes || sha256File(to) !== file.sha256)
      return { status: 'hash-mismatch', copied, checked, file: file.path };
  }
  writeSearchReady(searchAiPath, modelKey);
  return { status: copied ? 'seeded' : 'repaired', copied, checked };
}

/**
 * 入口。任何一个环节出错都只落在该环节的报告里，永远不抛——调用方按返回值打日志即可。
 */
function ensureBundledModels(options) {
  const settings = options || {};
  const modelsDir = settings.modelsDir;
  if (!modelsDir || !fs.existsSync(modelsDir)) return { status: 'no-models-dir', modelsDir };
  const report = { status: 'ok', modelsDir, face: null, search: null };
  try {
    report.face = seedFace(modelsDir, settings.faceAiPath);
  } catch (error) {
    report.face = { status: 'error', message: error && error.message ? error.message : String(error) };
  }
  try {
    report.search = seedSearch(modelsDir, settings.searchAiPath, settings.modelKey);
  } catch (error) {
    report.search = { status: 'error', message: error && error.message ? error.message : String(error) };
  }
  return report;
}

/** 播种是否真的动过文件（决定要不要打日志）。 */
function reportSaysCopied(report) {
  if (!report || !report.face || !report.search) return false;
  return report.face.copied > 0 || report.search.copied > 0;
}

module.exports = {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  READY_FILE,
  readManifest,
  sha256File,
  sizeOf,
  listFiles,
  copyAtomic,
  isSearchReady,
  writeSearchReady,
  seedFace,
  seedSearch,
  ensureBundledModels,
  reportSaysCopied,
};
