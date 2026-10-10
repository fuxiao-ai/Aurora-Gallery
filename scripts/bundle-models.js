'use strict';

/**
 * 生成随包内置模型目录 `models/`（人脸 + 搜图 + JoyTag 打标），供 `scripts/after-pack.js`
 * 复制进安装包。
 *
 * 用法：
 *   node scripts/bundle-models.js                                   # 三者都做（缺的从官方源下载）
 *   node scripts/bundle-models.js --face                            # 只做人脸
 *   node scripts/bundle-models.js --search                          # 只做搜图
 *   node scripts/bundle-models.js --joytag                          # 只做 JoyTag
 *   node scripts/bundle-models.js --face-from <目录>                # 从已有模型目录复制（不联网）
 *   node scripts/bundle-models.js --search-from <ai-search/models>  # 从已有缓存复制（不联网）
 *   node scripts/bundle-models.js --joytag-from <目录>              # 同上（见下「接受两种形状」）
 *   node scripts/bundle-models.js --force                           # 已存在也重做
 *
 * 为什么必须能「从已有目录复制」：完整搜图模型 400 MB 上下、JoyTag 权重 366 MB，
 * 走一遍官方源在很多网络下并不轻松；而开发机与用户目录里本来就有一份**已经被安装流程
 * 验证过**的缓存。复制模式的可靠性靠两道校验兜住：人脸复制完要过 `face-model.verify()`
 * （按 FILES 里的 sha256 + size），搜图复制完要**离线**把文本与视觉两套会话都载起来跑一次
 * （等价于安装流程落 `ready.json` 前做的那次验证），JoyTag 复制完要过
 * `joytag-model.verify()`（sha256 就是官方 LFS 指针里的那一个）。
 *
 * ⚠️ `--joytag-from` **接受两种形状**（先试前者，都不在就报错并把两条路径都列出来）：
 *   · `<目录>/model.onnx`            —— 模型目录本身
 *   · `<目录>/joytag/model.onnx`     —— 装模型的那一层（运行时就是 `<aiPath>/models`）
 * 这不是「魔法回退」，是这两种形状在真实机器上**都出现**（台架缓存是前者、
 * `UserData/ai-search/models` 是后者），逼用户去猜哪一层没有意义。
 *
 * 产物末尾写入 `models/manifest.json`：每个文件的 size + sha256，加上搜图那一份的 `modelKey`。
 * 运行时的播种层（`src/ai/bundled-models.js`）就靠它决定「这份随包模型是不是当前这一代」
 * 以及「复制完的文件有没有坏」——`ready.json` 不能凭白写。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'models');
const FACE_DIR = path.join(MODELS_DIR, 'face');
const SEARCH_DIR = path.join(MODELS_DIR, 'search');
const JOYTAG_DIR = path.join(MODELS_DIR, 'joytag');

const bundled = require('../src/ai/bundled-models');
// ⚠️ 运行时与这里必须用**同一份**模型身份（路径 / 尺寸 / sha256）。
//    各写一份的下场是「打好的包永远不被播种层认」—— 而两边都不报错，只是白下 366 MB。
const joytag = require('../src/ai/joytag-model');

function parseArgs() {
  const argv = process.argv.slice(2);
  const options = {
    face: false,
    search: false,
    joytag: false,
    force: false,
    faceFrom: '',
    searchFrom: '',
    joytagFrom: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--face') options.face = true;
    else if (arg === '--search') options.search = true;
    else if (arg === '--joytag') options.joytag = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--face-from' && argv[i + 1]) options.faceFrom = path.resolve(argv[++i]);
    else if (arg === '--search-from' && argv[i + 1]) options.searchFrom = path.resolve(argv[++i]);
    else if (arg === '--joytag-from' && argv[i + 1]) options.joytagFrom = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('无法识别的参数: ' + arg + '（--help 看用法）');
  }
  if (!options.face && !options.search && !options.joytag) {
    options.face = true;
    options.search = true;
    options.joytag = true;
  }
  return options;
}

function usage() {
  process.stdout.write(
    [
      '用法: node scripts/bundle-models.js [--face] [--search] [--joytag] [--force]',
      '                              [--face-from <目录>] [--search-from <目录>] [--joytag-from <目录>]',
      '',
      '不加 --face/--search/--joytag 时三者都做。--*-from 表示从已有目录复制而不是联网下载。',
      '产物: models/face、models/search、models/joytag 与 models/manifest.json',
      '      （--force 才会覆盖已完成的部分）。',
      '',
    ].join('\n'),
  );
}

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function directoryBytes(dir) {
  let total = 0;
  for (const relative of bundled.listFiles(dir)) total += bundled.sizeOf(path.join(dir, relative));
  return total;
}

function directoryReady(dir) {
  return fs.existsSync(dir) && bundled.listFiles(dir).length > 0;
}

/** 人脸：要么走官方下载（face-model.install），要么从已有目录复制，随后一律过 verify()。 */
async function buildFace(options) {
  const model = require('../src/ai/face-model');
  if (directoryReady(FACE_DIR) && !options.force) {
    process.stdout.write('[bundle-models] 人脸模型已存在，跳过（--force 可重做）\n');
    return;
  }
  fs.mkdirSync(FACE_DIR, { recursive: true });

  if (options.faceFrom) {
    const names = model.FILES.map((file) => file.name).concat(model.LICENSES);
    for (const name of names) {
      const from = path.join(options.faceFrom, name);
      if (!fs.existsSync(from)) throw new Error('源目录缺少 ' + name + ': ' + options.faceFrom);
      fs.copyFileSync(from, path.join(FACE_DIR, name));
    }
    process.stdout.write('[bundle-models] 人脸模型已从 ' + options.faceFrom + ' 复制\n');
  } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    await model.install(FACE_DIR, controller.signal, ({ file, percent }) => {
      process.stdout.write('\r[bundle-models] 下载 ' + file + ' ' + percent + '%   ');
    });
    process.stdout.write('\n');
  }

  if (!(await model.verify(FACE_DIR)))
    throw new Error('人脸模型校验失败（与 face-model.FILES 的 sha256/size 不符）: ' + FACE_DIR);
  process.stdout.write(
    '[bundle-models] 人脸模型就绪: ' + FACE_DIR + ' (' + human(directoryBytes(FACE_DIR)) + ')\n',
  );
}

/** 最小的仓库内 PNG，只用来让视觉会话真的跑一次前向（验证 processor + vision session）。 */
function probeImage() {
  const candidates = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.png$/i.test(entry.name)) candidates.push(full);
    }
  };
  walk(path.join(ROOT, 'docs'));
  walk(path.join(ROOT, 'src'));
  candidates.sort((a, b) => bundled.sizeOf(a) - bundled.sizeOf(b));
  return candidates[0] || '';
}

/** 离线把两套编码器载起来并各跑一次前向：这是「复制完的缓存可以直接用」的证明。 */
async function verifySearchOffline(directory) {
  const { loadEncoder, GENERIC_TEXT, DIMENSIONS, MODEL_KEY } = require('../src/ai/embedding');
  const encoder = await loadEncoder(directory, { download: false });
  try {
    const text = await encoder.text(GENERIC_TEXT);
    if (!text || text.length !== DIMENSIONS) throw new Error('文本编码器输出维度异常');
    const image = probeImage();
    if (!image) throw new Error('找不到用于校验的示例 PNG（docs/ 或 src/ 下）');
    const vector = await encoder.image(fs.readFileSync(image));
    if (!vector || vector.length !== DIMENSIONS) throw new Error('视觉编码器输出维度异常');
    process.stdout.write('[bundle-models] 离线校验通过（文本 + 视觉，' + path.basename(image) + '）\n');
  } finally {
    await encoder.dispose();
  }
  return MODEL_KEY;
}

async function buildSearch(options) {
  if (directoryReady(SEARCH_DIR) && !options.force) {
    process.stdout.write('[bundle-models] 搜图模型已存在，跳过（--force 可重做）\n');
    return;
  }

  if (options.searchFrom) {
    const files = bundled.listFiles(options.searchFrom);
    if (!files.length) throw new Error('源缓存目录为空: ' + options.searchFrom);
    for (const relative of files) {
      const to = path.join(SEARCH_DIR, relative);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(options.searchFrom, relative), to);
    }
    process.stdout.write('[bundle-models] 搜图模型已从 ' + options.searchFrom + ' 复制\n');
  } else {
    const { loadEncoder } = require('../src/ai/embedding');
    const encoder = await loadEncoder(SEARCH_DIR, {
      download: true,
      progress: (item) => {
        if (item && item.file)
          process.stdout.write('\r[bundle-models] 下载 ' + item.file + ' ' + (item.progress || 0) + '%   ');
      },
    });
    // 下载模式的会话本来就是新建的，先放掉再走一次离线校验：那条路才是运行时真正走的路。
    await encoder.dispose();
    process.stdout.write('\n');
  }

  await verifySearchOffline(SEARCH_DIR);
  process.stdout.write(
    '[bundle-models] 搜图模型就绪: ' + SEARCH_DIR + ' (' + human(directoryBytes(SEARCH_DIR)) + ')\n',
  );
}

/**
 * JoyTag：要么走官方源下载（`joytag-model.install`），要么从已有目录复制，随后一律过
 * `joytag-model.verify()`。
 *
 * ⚠️ **失败必须硬报错，不许静默跳过**。「模型随包」这个承诺一旦被悄悄违反，症状是
 * 装机版里 tag 倒排索引**永远建不出来**，而界面上只说「没建索引」—— 打包时的一声报错
 * 是这条链上唯一能提前发现它的地方。
 */
async function buildJoytag(options) {
  if (directoryReady(JOYTAG_DIR) && !options.force) {
    process.stdout.write('[bundle-models] JoyTag 模型已存在，跳过（--force 可重做）\n');
    return;
  }
  fs.mkdirSync(JOYTAG_DIR, { recursive: true });

  if (options.joytagFrom) {
    const candidates = [
      path.join(options.joytagFrom, joytag.MODEL.name),
      path.join(options.joytagFrom, 'joytag', joytag.MODEL.name),
    ];
    const from = candidates.find((file) => fs.existsSync(file));
    if (!from)
      throw new Error(
        '源目录里找不到 ' + joytag.MODEL.name + '，试过:\n  ' + candidates.join('\n  '),
      );
    fs.copyFileSync(from, path.join(JOYTAG_DIR, joytag.MODEL.name));
    process.stdout.write('[bundle-models] JoyTag 模型已从 ' + from + ' 复制\n');
  } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    await joytag.install(MODELS_DIR, controller.signal, ({ percent, url }) => {
      process.stdout.write('\r[bundle-models] 下载 ' + joytag.MODEL.name + ' ' + percent + '%   ');
      if (percent === 0 && url) process.stdout.write('\n[bundle-models] 源: ' + url + '\n');
    });
    process.stdout.write('\n');
  }

  if (!joytag.verify(MODELS_DIR))
    throw new Error(
      'JoyTag 权重校验失败（sha256 应为 ' +
        joytag.MODEL.sha256.slice(0, 16) +
        '…、' +
        joytag.MODEL.bytes +
        ' B）: ' +
        JOYTAG_DIR,
    );
  process.stdout.write(
    '[bundle-models] JoyTag 模型就绪: ' + JOYTAG_DIR + ' (' + human(directoryBytes(JOYTAG_DIR)) + ')\n',
  );
}

function scan(dir, key) {
  return bundled.listFiles(dir).map((relative) => {
    const item = { bytes: bundled.sizeOf(path.join(dir, relative)), sha256: bundled.sha256File(path.join(dir, relative)) };
    item[key] = relative;
    return item;
  });
}

/**
 * `--face` / `--search` / `--joytag` 只补做一侧时，另一侧必须沿用磁盘上已有的 manifest 条目
 * ——否则会把「这次没重建的那一半」记成一节空文件，运行时播种层据此判定没有随包模型。
 */
function writeManifest(options, previous) {
  const { MODEL_KEY, MODEL } = require('../src/ai/embedding');
  const model = require('../src/ai/face-model');
  const keepFace = !options.face && previous.face && Array.isArray(previous.face.files);
  const keepSearch = !options.search && previous.search && Array.isArray(previous.search.files);
  const keepJoytag = !options.joytag && previous.joytag && Array.isArray(previous.joytag.files);
  const manifest = {
    version: bundled.MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    face: {
      // 只作参考：人脸是否可用由 face worker 的 verify() 说了算，播种层不看这个字段。
      version: model.VERSION,
      files: keepFace ? previous.face.files : scan(FACE_DIR, 'name'),
    },
    search: {
      model: MODEL,
      // 与 semantic-worker 的 ready.json 同一个键：对不上就绝不播种。
      modelKey: MODEL_KEY,
      files: keepSearch ? previous.search.files : scan(SEARCH_DIR, 'path'),
    },
    joytag: {
      // 与 `tag-index-store` 的 `TAG_INDEX_MODEL` / `tag_meta.model` 同一串：
      // 一致才说明「这份随包权重就是索引里那些分数算出来的那一版」。
      model: require('../src/ai/tag-index-store').TAG_INDEX_MODEL,
      version: joytag.VERSION,
      // 播种层按它做 size + sha256 校验，`copied > 0` 时才付一次哈希的钱。
      files: keepJoytag ? previous.joytag.files : scan(JOYTAG_DIR, 'path'),
    },
  };
  fs.writeFileSync(
    path.join(MODELS_DIR, bundled.MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  process.stdout.write(
    '[bundle-models] manifest 写好: ' +
      path.join(MODELS_DIR, bundled.MANIFEST_FILE) +
      ' (总 ' +
      human(directoryBytes(MODELS_DIR)) +
      ')\n',
  );
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    usage();
    return;
  }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const previous = bundled.readManifest(MODELS_DIR) || {};
  if (options.face) await buildFace(options);
  if (options.search) await buildSearch(options);
  if (options.joytag) await buildJoytag(options);
  writeManifest(options, previous);
  process.stdout.write('[bundle-models] 完成。models/ 记得不要提交进版本库（.gitignore 已忽略）。\n');
}

main().catch((error) => {
  process.stderr.write('[bundle-models] ' + (error && error.message ? error.message : error) + '\n');
  process.exitCode = 1;
});
