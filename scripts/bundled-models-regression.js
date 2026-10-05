'use strict';

/**
 * 随包内置模型（`models/`）→ 用户目录 播种逻辑的回归。
 *
 * 这条链路的失败方式都很难看，而且都不在界面上显形，所以必须用夹具钉住：
 *   - **把上一代权重标成当前这一代**：`ready.json` 是搜图「模型可用」的**唯一标记**，
 *     写错就等于告诉 worker 一份过期/不匹配的缓存可以直接用。守：`modelKey` 不一致时
 *     `seedSearch` 必须返回 `model-mismatch` 且**一个字节都不复制、不落标记**。
 *   - **复制中断/文件坏掉也照样落标记**：播种没有「真载一遍编码器」的机会，
 *     靠 manifest 的 sha256 代替。守：哈希不符必须停在 `hash-mismatch`，不落标记。
 *   - **每次开应用重搬几百 MB**：守：已就绪时 `copied === 0` 且目标文件 mtime 不变。
 *   - **播种把状态查询搞崩**：守：`ensureBundledModels` 永不抛，坏掉的搜图一侧只落在自己的报告里，
 *     人脸一侧照常完成。
 *
 * 夹具用几 KB 的假文件代替真实的 400 MB 模型 —— 被测的是「尺寸/哈希/幂等/标记」这套判定，
 * 与内容无关；真实模型能否离线加载由 `scripts/bundle-models.js` 的 `--*-from` 路径现场验证。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bundled = require('../src/ai/bundled-models');
const { MODEL_KEY } = require('../src/ai/embedding');

const ROOT = path.join(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-bundled-models-'));

const FACE_NAMES = ['yunet.onnx', 'w600k_mbf.onnx'];
const SEARCH_FILES = [
  'onnx-community/siglip2-base-patch16-224-ONNX/ba1f3b0/config.json',
  'onnx-community/siglip2-base-patch16-224-ONNX/ba1f3b0/onnx/text_model_quantized.onnx',
];
const OTHER_MODEL_KEY = MODEL_KEY + ':stale';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function payload(seed, bytes) {
  return Buffer.alloc(bytes, seed);
}

/** 造一份「随包目录」：face/ + search/ + manifest.json。 */
function makeBundle(name, { modelKey = MODEL_KEY, search = true, face = true } = {}) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { version: bundled.MANIFEST_VERSION, generatedAt: 'fixture', face: { files: [] }, search: { modelKey, files: [] } };
  if (face) {
    FACE_NAMES.forEach((file, index) => {
      const body = payload(index + 1, 4096 + index * 512);
      write(path.join(dir, 'face', file), body);
      manifest.face.files.push({ name: file, bytes: body.length, sha256: bundled.sha256File(path.join(dir, 'face', file)) });
    });
  }
  if (search) {
    SEARCH_FILES.forEach((file, index) => {
      const body = payload(index + 11, 8192 + index * 1024);
      write(path.join(dir, 'search', file), body);
      manifest.search.files.push({ path: file, bytes: body.length, sha256: bundled.sha256File(path.join(dir, 'search', file)) });
    });
  }
  fs.writeFileSync(path.join(dir, bundled.MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return dir;
}

function fresh(name) {
  const dir = path.join(TEMP, name);
  removeTree(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 🔴 删临时树必须带退避重试。
 * Windows 上 `rmSync(recursive)` 的 `maxRetries` 默认是 **0** —— 只要目录里任何一个文件
 * 被索引器 / 杀软 / 还没退干净的 electron 子进程短暂占用，就会抛 `ENOTEMPTY` / `EBUSY`。
 * 这条不是断言失败，却会让 `run-regressions` 报 `Regression failed` 并在**清理阶段**中止
 * （2026-10-05 实际踩到：全部断言已通过，挂在收尾那行 rmSync 上，且单跑又能过）。
 * 断言的红必须来自契约，不能来自操作系统抖动。
 */
function removeTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function readReady(aiPath) {
  const file = path.join(aiPath, bundled.READY_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function assertFaceSeeded(bundleDir, target) {
  for (const file of FACE_NAMES)
    assert.ok(
      fs.readFileSync(path.join(target, 'models', file)).equals(fs.readFileSync(path.join(bundleDir, 'face', file))),
      '人脸模型要逐字节一致: ' + file,
    );
}

/** ① 空目标播种 + ② 幂等不重写 */
function testFaceSeedIsIdempotent() {
  const bundleDir = makeBundle('bundle-face');
  const aiPath = fresh('face-ai');
  const first = bundled.seedFace(bundleDir, aiPath);
  assert.equal(first.status, 'seeded');
  assert.equal(first.copied, FACE_NAMES.length);
  assertFaceSeeded(bundleDir, aiPath);

  const target = path.join(aiPath, 'models', FACE_NAMES[0]);
  const stamp = fs.statSync(target).mtimeMs;
  const before = Date.now();
  while (Date.now() - before < 20) {
    /* 让 mtime 有可分辨的间隔：这一条要抓的正是「无条件重写」 */
  }
  const second = bundled.seedFace(bundleDir, aiPath);
  assert.equal(second.status, 'already-complete');
  assert.equal(second.copied, 0, '已就绪时不许再搬文件');
  assert.equal(fs.statSync(target).mtimeMs, stamp, '已就绪时不许重写文件');
}

/** ③ 尺寸不对就地修好（上一代只装了 SFace 的目录就是这种形状） */
function testFaceRepairsTruncatedFile() {
  const bundleDir = makeBundle('bundle-face-repair');
  const aiPath = fresh('face-ai-repair');
  // 一个尺寸正确（不该被碰）、一个被截断（必须被换回来）。
  write(
    path.join(aiPath, 'models', FACE_NAMES[0]),
    fs.readFileSync(path.join(bundleDir, 'face', FACE_NAMES[0])),
  );
  write(path.join(aiPath, 'models', FACE_NAMES[1]), payload(9, 100));
  const report = bundled.seedFace(bundleDir, aiPath);
  assert.equal(report.status, 'seeded');
  assert.equal(report.copied, 1, '只有尺寸不对的那一个该被换掉');
  assertFaceSeeded(bundleDir, aiPath);
}

/** ④ 没有随包人脸目录什么都不做 */
function testFaceWithoutBundle() {
  const dir = fresh('bundle-face-missing');
  write(path.join(dir, 'search', 'x.onnx'), payload(3, 64));
  const aiPath = fresh('face-ai-nobundle');
  const report = bundled.seedFace(dir, aiPath);
  assert.equal(report.status, 'no-bundle');
  assert.equal(report.copied, 0);
  assert.equal(fs.existsSync(path.join(aiPath, 'models')), false, '没有随包模型就不该凭空造目录');
}

/** ⑤ 只有随包目录、没有 manifest（旧包/手工拷贝）时，搜图不播种 */
function testSearchWithoutManifest() {
  const dir = fresh('bundle-search-nomanifest');
  write(path.join(dir, 'search', SEARCH_FILES[0]), payload(5, 256));
  const aiPath = fresh('search-ai-nomanifest');
  const report = bundled.seedSearch(dir, aiPath, MODEL_KEY);
  assert.equal(report.status, 'no-bundle');
  assert.equal(readReady(aiPath), null);
  assert.equal(fs.existsSync(path.join(aiPath, 'models')), false);
}

/** ⑥ 版本不匹配（manifest 记的是上一代）时绝不落 ready.json —— 本回归最重要的一条 */
function testSearchRejectsStaleModelKey() {
  const bundleDir = makeBundle('bundle-search-stale', { modelKey: OTHER_MODEL_KEY });
  const aiPath = fresh('search-ai-stale');
  const report = bundled.seedSearch(bundleDir, aiPath, MODEL_KEY);
  assert.equal(report.status, 'model-mismatch');
  assert.equal(report.copied, 0, '版本对不上时一个字节都不许复制');
  assert.equal(readReady(aiPath), null, '版本对不上时绝不许写 ready.json');
  assert.equal(
    bundled.isSearchReady(aiPath, MODEL_KEY),
    false,
    'ready.json 的判定必须与 semantic-worker 同源（同字段 model）',
  );
}

/** ⑦ 内容与 manifest 哈希不符时不落标记 */
function testSearchRejectsHashMismatch() {
  const bundleDir = makeBundle('bundle-search-broken');
  const file = SEARCH_FILES[0];
  // 保持尺寸不变、只改内容：这样它不会先被「尺寸不对」这条挡掉，走的正是哈希那条闸门。
  const body = fs.readFileSync(path.join(bundleDir, 'search', file));
  body[0] = body[0] ^ 0xff;
  fs.writeFileSync(path.join(bundleDir, 'search', file), body);
  const aiPath = fresh('search-ai-broken');
  const report = bundled.seedSearch(bundleDir, aiPath, MODEL_KEY);
  assert.equal(report.status, 'hash-mismatch');
  assert.equal(report.file, file);
  assert.equal(readReady(aiPath), null, '哈希不符时绝不许写 ready.json');
}

/** ⑧ 正常播种：文件就位 + ready.json 与 worker 判定同源；再跑一次不再搬文件 */
function testSearchSeedsAndMarksReady() {
  const bundleDir = makeBundle('bundle-search-ok');
  const aiPath = fresh('search-ai-ok');
  const report = bundled.seedSearch(bundleDir, aiPath, MODEL_KEY);
  assert.equal(report.status, 'seeded');
  assert.equal(report.copied, SEARCH_FILES.length);
  for (const file of SEARCH_FILES)
    assert.ok(
      fs.readFileSync(path.join(aiPath, 'models', file)).equals(
        fs.readFileSync(path.join(bundleDir, 'search', file)),
      ),
      '搜图模型要逐字节一致: ' + file,
    );
  assert.deepEqual(readReady(aiPath), { model: MODEL_KEY }, 'ready.json 必须是 { model: <MODEL_KEY> }');
  assert.equal(bundled.isSearchReady(aiPath, MODEL_KEY), true);

  const second = bundled.seedSearch(bundleDir, aiPath, MODEL_KEY);
  assert.equal(second.status, 'already-ready');
  assert.equal(second.copied, 0, '已就绪时不许再搬文件');

  // 换一代模型（MODEL_KEY 变了）：旧 ready.json 必须被判为「不匹配」，否则 worker 会用错模型。
  assert.equal(bundled.isSearchReady(aiPath, OTHER_MODEL_KEY), false);
}

/** ⑨ 一侧坏掉不许拖垮另一侧，也不许抛 */
function testEnsureIsolatesFailures() {
  const bundleDir = makeBundle('bundle-isolation');
  const manifest = bundled.readManifest(bundleDir);
  manifest.search.files.push({ path: 'onnx-community/missing.onnx', bytes: 4096, sha256: 'x'.repeat(64) });
  fs.writeFileSync(path.join(bundleDir, bundled.MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  const faceAiPath = fresh('face-ai-isolation');
  const searchAiPath = fresh('search-ai-isolation');

  const report = bundled.ensureBundledModels({
    modelsDir: bundleDir,
    faceAiPath,
    searchAiPath,
    modelKey: MODEL_KEY,
  });
  assert.equal(report.face.status, 'seeded', '搜图一侧坏掉不该影响人脸播种');
  assert.equal(report.search.status, 'error');
  assert.match(String(report.search.message), /missing\.onnx|ENOENT/);
  assert.equal(readReady(searchAiPath), null, '出错时不许落 ready.json');
  assert.equal(bundled.reportSaysCopied(report), true, '人脸真的搬了文件，日志要打得出来');

  const missing = bundled.ensureBundledModels({
    modelsDir: path.join(TEMP, 'no-such-models-dir'),
    faceAiPath,
    searchAiPath,
    modelKey: MODEL_KEY,
  });
  assert.equal(missing.status, 'no-models-dir');
}

/** ⑩ 静态守住接线：播种层与 afterPack、.gitignore 的约定一旦被删掉要立刻发现 */
function testWiringInSource() {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\/models\/$/m, '.gitignore 必须忽略 /models/（体积大且权重限非商业）');

  const main = read('src/main.js');
  assert.match(main, /bundledModels\.ensureBundledModels\(/, 'main.js 必须调用播种层');
  assert.match(main, /faceService\.beforeRefresh = ensureBundledModels/, '人脸服务必须挂上准备钩子');
  assert.match(main, /semanticSearch\.beforeRefresh = ensureBundledModels/, '搜图服务必须挂上准备钩子');

  const service = read('src/main/semantic-search.js');
  assert.match(service, /typeof this\.beforeRefresh === 'function'/, 'refresh() 必须调用准备钩子');
  assert.match(service, /await this\.beforeRefresh\(\)/, '钩子必须是 await 的，否则状态会先于播种返回');

  const afterPack = read('scripts/after-pack.js');
  assert.match(afterPack, /'resources',\s*'models'/, 'afterPack 必须把 models/ 复制进 resources/models');

  const bundleScript = read('scripts/bundle-models.js');
  assert.match(bundleScript, /bundled\.MANIFEST_FILE/, 'bundle 脚本必须写 manifest（播种层靠它判版本）');
}

/** ⑪ 本机若已经生成过真实的 models/，顺带核对 manifest 与磁盘一致（CI 上没有则跳过） */
function testRealBundleIfPresent() {
  const modelsDir = path.join(ROOT, 'models');
  if (!fs.existsSync(modelsDir)) {
    console.log('  （跳过：仓库里没有 models/，随包目录由 npm run bundle-models 现场生成）');
    return;
  }
  const manifest = bundled.readManifest(modelsDir);
  assert.ok(manifest, 'models/manifest.json 必须存在且 version 可识别');
  assert.equal(manifest.search.modelKey, MODEL_KEY, 'manifest 的 modelKey 必须是当前这一代');
  for (const section of [
    { files: manifest.face.files, base: path.join(modelsDir, 'face'), key: 'name' },
    { files: manifest.search.files, base: path.join(modelsDir, 'search'), key: 'path' },
  ]) {
    assert.ok(section.files.length > 0, 'manifest 的一节不许是空的');
    for (const file of section.files) {
      const full = path.join(section.base, file[section.key]);
      assert.equal(bundled.sizeOf(full), file.bytes, '尺寸要与 manifest 一致: ' + file[section.key]);
      assert.equal(bundled.sha256File(full), file.sha256, '哈希要与 manifest 一致: ' + file[section.key]);
    }
  }
  assert.ok(
    fs.existsSync(path.join(modelsDir, 'face', 'w600k_mbf.onnx')),
    '随包人脸目录里必须是现役的 w600k_mbf（不是上一代 sface.onnx）',
  );
  assert.equal(
    fs.existsSync(path.join(modelsDir, 'face', 'sface.onnx')),
    false,
    '上一代的 sface.onnx 不该被打进随包目录',
  );
}

function run() {
  testFaceSeedIsIdempotent();
  testFaceRepairsTruncatedFile();
  testFaceWithoutBundle();
  testSearchWithoutManifest();
  testSearchRejectsStaleModelKey();
  testSearchRejectsHashMismatch();
  testSearchSeedsAndMarksReady();
  testEnsureIsolatesFailures();
  testWiringInSource();
  testRealBundleIfPresent();
  fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log('随包内置模型（models/ → 用户目录）播种 回归 全部通过');
}

run();
