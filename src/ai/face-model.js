'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
// `similarity` 的正身在纯算法层 `face-cluster.js`（那一份零原生依赖，离线探针要能直接引）。
// 这里引回来只为保持 `face-model` 对外的导出面不变（`face-model-smoke.js` 在用）——
// 两份各写一遍就会漂移，而这正是之前踩过的坑。
const { similarity } = require('./face-cluster');

/**
 * 识别器换成 InsightFace 的 **w600k_mbf**（MobileFaceNet / WebFace600K，512 维），
 * 就是 julyx10/lap 用的那一个（buffalo_sc 包）。
 *
 * 为什么换：同一份 112×112 对齐裁剪、只换识别器，真库 3501 张脸、标准答案 = `K:\COS\<编号>`：
 *
 *   识别器          维度  同人中位  跨人中位  间隔    AUC     EER      最优F1
 *   SFace（旧）      128   0.4220   0.2673   0.1547  0.8073  0.2675   0.7742
 *   w600k_mbf（新）  512   0.3893   0.1936   0.1957  0.8801  0.1948   0.8284
 *
 * 即 AUC +0.073、EER 0.268→0.195。注意新模型的**绝对相似度更低**（同人 0.389 vs 0.422），
 * 所以阈值数字不可照搬，必须重新标定。
 *
 * 许可证：InsightFace 的**代码**是 MIT，但**预训练权重**（buffalo_l / buffalo_sc）
 * 明确限定「仅供非商业学术研究」。这是用户拍板接受的取舍（见 docs/people-groups.md），
 * 安装时会把 `InsightFace-models.txt` 一并落到模型目录。
 */
const VERSION = 'yunet2023-insightface-w600kmbf-align112-refine-v3';
/**
 * 现役方案的**对外名称**。设置界面用它回答「现在用的是哪一套」—— 用户面对「分组相似度阈值」
 * 这类数字时，有权知道自己拧的是哪个识别器、哪套聚类的刻度。
 *
 * 刻意不做 i18n：这是产品 / 模型名，两个语言下都是同一串。
 */
const VERSION_LABEL = 'YuNet + InsightFace w600k_mbf (512-d) + Chinese Whispers';
/**
 * 已知的历史 `VERSION` → 短标签。
 *
 * 只为一件事服务：把「索引里的记录是哪一代识别器建的」说成人话。**认不出来就回落到原始
 * `VERSION` 字符串**（见 `labelForVersion`）—— 宁可丑，也不要猜错一代去骗用户。
 *
 * v1 / v2 都基于 SFace：v2 只是在 v1 之上加了「局部复核 + 水平翻转 TTA」把关键点对齐
 * 做准，识别器本身没换、向量仍是 128 维 512 字节。
 */
const VERSION_LABELS = {
  'yunet2023-sface2021-align112-v1': 'OpenCV SFace (128-d)',
  'yunet2023-sface2021-align112-refine-v2': 'OpenCV SFace + refine (128-d)',
};
/** `VERSION` → 人话。认不出来就原样返回，绝不用一个猜的标签。 */
function labelForVersion(version) {
  if (version === VERSION) return VERSION_LABEL;
  return VERSION_LABELS[version] || String(version);
}
/** 识别器输出维度。w600k_mbf = 512；旧的 SFace 是 128。 */
const VECTOR_DIM = 512;
/** 落库字节数（float32）。 */
const PACK_BYTES = VECTOR_DIM * 4;
/** InsightFace 的预处理：`(x - 127.5) / 127.5`，RGB。SFace 则是 0–255 不归一化。 */
const INSIGHT_MEAN = 127.5;
const OPENCV_BASE = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/';
const INSIGHTFACE_ARCHIVE =
  'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip';
const FILES = [
  {
    name: 'yunet.onnx',
    url: OPENCV_BASE + 'face_detection_yunet/face_detection_yunet_2023mar.onnx',
    hash: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    size: 232589,
  },
  {
    name: 'w600k_mbf.onnx',
    // InsightFace 只在 GitHub Release 上发整包（buffalo_sc.zip），包内就是这两个 onnx。
    // 直链（HF / immich 镜像）要么 401 要么 404，所以只能下整包再解出需要的那个条目。
    archive: { url: INSIGHTFACE_ARCHIVE, entry: 'w600k_mbf.onnx' },
    hash: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
    size: 13616099,
  },
];
const LICENSES = ['YuNet-MIT.txt', 'InsightFace-models.txt'];
const TEMPLATE = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
/** YuNet 的导出把输入边长写死成 640，放大画布是做不到的（见 refinePoints）。 */
const DETECT_CANVAS = 640;
/** 检测前把图片压到的长边上限；对齐裁剪也取自这张中间图。 */
const DETECT_MAX = 1600;
/** 局部复核的外扩倍率。 */
const REFINE_MARGIN = 1.8;
/**
 * 采纳复核结果的距离上限（相对脸的长边）。
 * 超过它说明「离粗定位中心最近的那张脸」多半不是同一张（例如旁边站着别人），
 * 这时宁可保留粗定位的关键点，也不要把对齐锚到别人脸上。
 */
const REFINE_MAX_DRIFT = 0.75;
/**
 * ONNX 会话的执行提供器。**默认必须是 CPU**。
 *
 * DirectML 只在「单进程连续处理很多张图片」这条长跑路上有收益（人脸索引恰好是这个形状），
 * 而零星调用换 EP 只会多担一份「这台机器没有可用 DirectML 设备」的风险。
 * ⇒ 只有**自带 CPU 回退**的调用方才该显式传 `['dml']`。
 * ⚠️ `onnxruntime-node` 在 win32 上确实随包带 `DirectML.dll`，但**建会话成功才是唯一判据**
 * （`InferenceSession.create` 抛错就是不可用，不许靠「平台是 win32」推断）。
 */
const DEFAULT_PROVIDERS = ['cpu'];
/**
 * 会话 intra-op 线程数。默认 2：人脸索引与其它 AI 任务可能同时在跑，线程开满会互相抢核心。
 * 实测提到 8 对同类任务**没有收益**（见 `docs/contracts/semantic-search.md`「EP 与计时纪律」）。
 */
const DEFAULT_THREADS = 2;

function normalize(values) {
  if (values.length !== VECTOR_DIM || !Array.from(values).every(Number.isFinite))
    throw new Error('FACE_VECTOR_INVALID');
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error('FACE_VECTOR_INVALID');
  return Float32Array.from(values, (value) => value / norm);
}
function pack(vector) {
  if (vector.length !== VECTOR_DIM) throw new Error('FACE_VECTOR_INVALID');
  const out = Buffer.alloc(PACK_BYTES);
  vector.forEach((v, i) => out.writeFloatLE(v, i * 4));
  return out;
}
/**
 * 旧库的向量是 512 字节（SFace 128 维）。维度对不上就是**上一代模型的残留**，
 * 必须当作非法值抛掉而不是硬解 —— 硬解会把 128 维读成 512 维并一路算到 NaN 相似度，
 * 那种错误在归组结果上完全看不出来。`VERSION` 一升，这些行本来也会被重扫覆盖掉。
 */
function unpack(bytes) {
  if (bytes.length !== PACK_BYTES) throw new Error('FACE_VECTOR_INVALID');
  return normalize(Float32Array.from({ length: VECTOR_DIM }, (_, i) => bytes.readFloatLE(i * 4)));
}

async function verify(directory) {
  try {
    for (const file of FILES) {
      const bytes = await fs.promises.readFile(path.join(directory, file.name));
      if (
        bytes.length !== file.size ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== file.hash
      )
        return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 从 ZIP 缓冲里取出一个条目。
 *
 * 故意不引第三方解压库：整个包只有两个 onnx，为它加一个依赖不划算。只支持 store（0）
 * 与 deflate（8）两种方法，InsightFace 的发布包就是这两种。
 */
function readZipEntry(buffer, name) {
  const END_OF_CENTRAL = 0x06054b50;
  let end = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i--)
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('FACE_ARCHIVE_INVALID');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('FACE_ARCHIVE_INVALID');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const entry = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (entry === name) {
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('FACE_ARCHIVE_INVALID');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('FACE_ARCHIVE_METHOD');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('FACE_ARCHIVE_ENTRY');
}

async function downloadBuffer(url, expected, signal, progress, name) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error('FACE_DOWNLOAD_FAILED: ' + response.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    if (signal.aborted) throw new Error('AI_CANCELLED');
    size += chunk.length;
    if (size > expected) throw new Error('FACE_MODEL_CHECKSUM');
    chunks.push(chunk);
    progress({ file: name, percent: Math.round((size / expected) * 100) });
  }
  return Buffer.concat(chunks);
}

async function install(directory, signal, progress) {
  await fs.promises.mkdir(directory, { recursive: true });
  for (const license of LICENSES) {
    await fs.promises.copyFile(
      path.join(__dirname, 'licenses', license),
      path.join(directory, license),
    );
  }
  for (const file of FILES) {
    const destination = path.join(directory, file.name);
    try {
      const bytes = await fs.promises.readFile(destination);
      if (crypto.createHash('sha256').update(bytes).digest('hex') === file.hash) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let bytes;
    if (file.archive) {
      const archive = await downloadBuffer(
        file.archive.url,
        Number.MAX_SAFE_INTEGER,
        signal,
        () => {},
        path.basename(file.archive.url),
      );
      bytes = readZipEntry(archive, file.archive.entry);
    } else {
      bytes = await downloadBuffer(file.url, file.size, signal, progress, file.name);
    }
    if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.hash)
      throw new Error('FACE_MODEL_CHECKSUM');
    const partial = destination + '.part';
    await fs.promises.writeFile(partial, bytes);
    await fs.promises.rename(partial, destination);
  }
}

function overlap(a, b) {
  const area =
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return area / (a.w * a.h + b.w * b.h - area);
}
function decode(outputs) {
  const candidates = [];
  for (const stride of [8, 16, 32]) {
    const cls = outputs['cls_' + stride].data;
    const obj = outputs['obj_' + stride].data;
    const boxes = outputs['bbox_' + stride].data;
    const points = outputs['kps_' + stride].data;
    const cols = DETECT_CANVAS / stride;
    for (let i = 0; i < cls.length; i++) {
      const confidence = Math.sqrt(
        Math.max(0, Math.min(1, cls[i])) * Math.max(0, Math.min(1, obj[i])),
      );
      if (confidence < 0.9) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const w = Math.exp(boxes[i * 4 + 2]) * stride;
      const h = Math.exp(boxes[i * 4 + 3]) * stride;
      const face = {
        x: (col + boxes[i * 4]) * stride - w / 2,
        y: (row + boxes[i * 4 + 1]) * stride - h / 2,
        w,
        h,
        confidence,
        points: Array.from({ length: 5 }, (_, n) => [
          (col + points[i * 10 + n * 2]) * stride,
          (row + points[i * 10 + n * 2 + 1]) * stride,
        ]),
      };
      if ([face.x, face.y, w, h].every(Number.isFinite) && w >= 16 && h >= 16)
        candidates.push(face);
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const face of candidates.slice(0, 500)) {
    if (kept.every((other) => overlap(face, other) < 0.3)) kept.push(face);
    if (kept.length === 50) break;
  }
  return kept;
}

// Fit a least-squares similarity transform from the aligned template into the source.
function alignment(points) {
  const average = (values, axis) => values.reduce((sum, p) => sum + p[axis], 0) / values.length;
  const tx = average(TEMPLATE, 0),
    ty = average(TEMPLATE, 1);
  const px = average(points, 0),
    py = average(points, 1);
  let denom = 0,
    real = 0,
    imaginary = 0;
  for (let i = 0; i < 5; i++) {
    const x = TEMPLATE[i][0] - tx,
      y = TEMPLATE[i][1] - ty;
    const u = points[i][0] - px,
      v = points[i][1] - py;
    denom += x * x + y * y;
    real += x * u + y * v;
    imaginary += x * v - y * u;
  }
  const a = real / denom,
    b = imaginary / denom;
  if (!Number.isFinite(a + b) || a * a + b * b < 1e-8) throw new Error('FACE_ALIGNMENT_INVALID');
  return { a, b, x: px - a * tx + b * ty, y: py - b * tx - a * ty };
}
function align(rgb, width, height, points) {
  const m = alignment(points);
  const out = new Uint8Array(112 * 112 * 3);
  const pixel = (x, y, c) =>
    x < 0 || x >= width || y < 0 || y >= height ? 0 : rgb[(y * width + x) * 3 + c];
  for (let y = 0; y < 112; y++)
    for (let x = 0; x < 112; x++) {
      const u = m.a * x - m.b * y + m.x,
        v = m.b * x + m.a * y + m.y;
      const ix = Math.floor(u),
        iy = Math.floor(v),
        dx = u - ix,
        dy = v - iy;
      for (let c = 0; c < 3; c++)
        out[(y * 112 + x) * 3 + c] = Math.round(
          pixel(ix, iy, c) * (1 - dx) * (1 - dy) +
            pixel(ix + 1, iy, c) * dx * (1 - dy) +
            pixel(ix, iy + 1, c) * (1 - dx) * dy +
            pixel(ix + 1, iy + 1, c) * dx * dy,
        );
    }
  return out;
}
/**
 * 模型输入张量。`bgr` = 通道顺序；`mean` / `std` = 预处理归一化。
 *
 * - SFace（旧）：OpenCV `blobFromImage(scale=1, swapRB=true)` → 0–255 的 RGB、无均值。
 * - w600k_mbf（新）：`(x - 127.5) / 127.5`、RGB。
 */
function tensor(rgb, width, height, bgr = false, mean = 0, std = 1) {
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 3; c++)
      data[c * width * height + i] = (rgb[i * 3 + (bgr ? 2 - c : c)] - mean) / std;
  return new ort.Tensor('float32', data, [1, 3, height, width]);
}

/**
 * 粗定位给的画布坐标 → 中间图像素坐标。
 *
 * 整张脸都要映（`x` / `y` / `w` / `h` / 5 个关键点），横纵各用各的比例 ——
 * 画布是按中间图长宽比字母框出来的，两者比例一般不相等。
 * 只映一半（例如漏了 x / y）会让局部复核的区域裁到别处，实测一次丢掉 76/84 张脸。
 */
function scaleFace(face, ratioX, ratioY) {
  return {
    x: face.x * ratioX,
    y: face.y * ratioY,
    w: face.w * ratioX,
    h: face.h * ratioY,
    points: face.points.map(([x, y]) => [x * ratioX, y * ratioY]),
  };
}
/**
 * 局部复核要用的区域（中间图像素坐标）：脸周按 `REFINE_MARGIN` 外扩，并夹到图内。
 * 坐标一律用中间图（≤1600 那张）的像素，因为对齐裁剪也取自它。
 */
function refineRegion(face, width, height) {
  const grow = (REFINE_MARGIN - 1) / 2;
  const left = Math.max(0, Math.floor(face.x - face.w * grow));
  const top = Math.max(0, Math.floor(face.y - face.h * grow));
  const right = Math.min(width, Math.ceil(face.x + face.w * (1 + grow)));
  const bottom = Math.min(height, Math.ceil(face.y + face.h * (1 + grow)));
  return { left, top, width: right - left, height: bottom - top };
}
/**
 * 在复核结果里挑「中心离粗定位中心最近」的那张脸，把它的 5 个关键点映回中间图坐标。
 *
 * `ratioX` / `ratioY` = 区域像素 ÷ 复核画布像素（复核画布是按区域等比字母框出来的，
 * 所以横纵比例可能不等 —— 只用一个比例会把关键点整体拉偏，实测踩过）。
 * 返回 `null` 表示不采纳（离得太远，或区域太小没法复核），由调用方保留粗定位关键点。
 */
function nearestPoints(face, candidates, region, ratioX, ratioY) {
  if (!candidates.length || region.width < 8 || region.height < 8) return null;
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const x = region.left + (candidate.x + candidate.w / 2) * ratioX;
    const y = region.top + (candidate.y + candidate.h / 2) * ratioY;
    const distance = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = candidate.points.map(([px, py]) => [region.left + px * ratioX, region.top + py * ratioY]);
  }
  const limit = Math.max(face.w, face.h) * REFINE_MAX_DRIFT;
  return bestDistance > limit * limit ? null : best;
}
/** 把中间图（或它的一块区域）等比字母框塞进 `size` 画布，跑一次检测。 */
async function detectCanvas(detector, rgb, info, size) {
  const scale = Math.min(size / info.width, size / info.height);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const staged = await sharp(rgb, { raw: info })
    .resize(width, height)
    .extend({ bottom: size - height, right: size - width, top: 0, left: 0, background: '#000' })
    .raw()
    .toBuffer();
  const outputs = await detector.run({ [detector.inputNames[0]]: tensor(staged, size, size, true) });
  return {
    width,
    height,
    faces: decode(outputs).filter((face) => face.x + face.w / 2 <= width && face.y + face.h / 2 <= height),
  };
}
/**
 * 局部复核：把「脸周 1.8× 的那块区域」单独裁出来再塞进 640 画布跑一次 YuNet，换取更准的 5 点。
 *
 * 为什么需要它：YuNet 的导出把输入边长写死成 640，而图片是先压到 ≤1600（中间图）再字母框
 * 塞进这个画布的 —— 一张只占画布 15% 宽的脸，在模型眼里只有 96px，5 个关键点必然带误差。
 * 而 5 点相似变换对误差极敏感：关键点偏一点，整张 112×112 就跟着偏，embedding 立刻变味。
 *
 * 实测（真库 6 个编号目录 = 6 个人，两批互不重叠的抽样，见 docs/people-groups.md）：
 *   - 整帧关键点与复核关键点平均相差 4.9% / 5.2% 脸宽（P90 7.7% / 8.3%）；
 *   - 配对级 AUC 0.788 → 0.875（第一批 83 张脸）、0.806 → 0.902（第二批 112 张脸）；
 *   - 最优 F1 0.746 → 0.800、0.764 → 0.838。
 * 也就是说「同一人不同造型被判成两个人」的主因不是模型看发色，而是**对齐没对准**。
 *
 * 代价：每张脸多一次 640 画布推理。单张图片的脸数通常很少，相对解码整图的成本可忽略。
 */
async function refinePoints(detector, rgb, info, face) {
  const region = refineRegion(face, info.width, info.height);
  if (region.width < 8 || region.height < 8) return face.points;
  const patch = await sharp(rgb, { raw: info })
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .raw()
    .toBuffer();
  const canvas = await detectCanvas(
    detector,
    patch,
    { width: region.width, height: region.height, channels: 3 },
    DETECT_CANVAS,
  );
  return (
    nearestPoints(face, canvas.faces, region, region.width / canvas.width, region.height / canvas.height) ||
    face.points
  );
}

async function load(directory, { providers = DEFAULT_PROVIDERS, threads = DEFAULT_THREADS } = {}) {
  if (!(await verify(directory))) throw new Error('AI_MODEL_MISSING');
  const options = {
    executionProviders: providers,
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
  };
  const detector = await ort.InferenceSession.create(path.join(directory, 'yunet.onnx'), options);
  let recognizer;
  try {
    recognizer = await ort.InferenceSession.create(
      path.join(directory, 'w600k_mbf.onnx'),
      options,
    );
  } catch (error) {
    await detector.release();
    throw error;
  }
  if (recognizer.outputNames.length !== 1) {
    await detector.release();
    await recognizer.release();
    throw new Error('AI_MODEL_MISSING');
  }
  return {
    async detect(input, cancelled = () => false) {
      const { data, info } = await sharp(input, { limitInputPixels: 100000000 })
        .rotate()
        .resize(DETECT_MAX, DETECT_MAX, { fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb')
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const coarse = await detectCanvas(detector, data, info, DETECT_CANVAS);
      const faces = [];
      for (const face of coarse.faces) {
        if (cancelled()) throw new Error('AI_CANCELLED');
        // 粗定位给的是画布坐标，先整张映回中间图坐标 —— 对齐裁剪与局部复核都用这套坐标。
        const detected = scaleFace(face, info.width / coarse.width, info.height / coarse.height);
        const points = await refinePoints(detector, data, info, detected);
        if (cancelled()) throw new Error('AI_CANCELLED');
        const crop = align(data, info.width, info.height, points);
        const result = await recognizer.run({
          [recognizer.inputNames[0]]: tensor(crop, 112, 112, false, INSIGHT_MEAN, INSIGHT_MEAN),
        });
        const vector = normalize(result[recognizer.outputNames[0]].data);
        const thumbnail = await sharp(crop, { raw: { width: 112, height: 112, channels: 3 } })
          .jpeg({ quality: 85 })
          .toBuffer();
        faces.push({
          vector,
          thumbnail,
          box: [
            face.x / coarse.width,
            face.y / coarse.height,
            face.w / coarse.width,
            face.h / coarse.height,
          ],
          confidence: face.confidence,
        });
      }
      return faces;
    },
    async dispose() {
      await detector.release();
      await recognizer.release();
    },
  };
}
module.exports = {
  VERSION,
  VERSION_LABEL,
  VERSION_LABELS,
  labelForVersion,
  FILES,
  LICENSES,
  TEMPLATE,
  VECTOR_DIM,
  PACK_BYTES,
  DETECT_CANVAS,
  DETECT_MAX,
  DEFAULT_PROVIDERS,
  DEFAULT_THREADS,
  REFINE_MARGIN,
  REFINE_MAX_DRIFT,
  normalize,
  similarity,
  pack,
  unpack,
  readZipEntry,
  install,
  verify,
  load,
  decode,
  alignment,
  scaleFace,
  refineRegion,
  nearestPoints,
};
