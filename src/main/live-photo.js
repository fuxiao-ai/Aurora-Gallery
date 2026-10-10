'use strict';

/**
 * Live Photo 识别 —— 认出「配对图片」与「它的伴生视频」。
 *
 * ## 为什么判据不能是文件名
 *
 * 最直觉的判据是「同目录 + 同 basename 的 图片 + 视频」。本机真库实测
 * （2026-10-06，156 万张图片的全量扫描）：这条判据会命中 **5920 对**，
 * 而其中绝大多数是**写真集的「封面图 + 视频」形态** ——
 *
 * ```
 *   xxx  (1).mp4   22.7 MB   ↔   xxx (1).jpg     1.0 MB   比 22.2
 *   yyy  (1).mp4   1.30 GB   ↔   yyy (1).jpg     9.7 MB   比 133.9
 *   zzz  (1).mp4    776 KB   ↔   zzz (1).jpg     4.0 MB   比  0.19
 * ```
 *
 * 体积比从 0.19 到 1692 倍都有、毫无规律，路径也明摆着是「一个封面图配一个正片」。
 * 按文件名判「伴生」并隐藏 ⇒ **凭空藏掉用户几千个视频**。这条判据必须废掉。
 *
 * ## 真正的判据
 *
 * Apple 在 Live Photo 的伴生 MOV 里写入固定 key
 * `com.apple.quicktime.content.identifier`（值是 UUID，与 HEIC/JPG 侧 EXIF 里的
 * `LivePhotoPairingIdentifier` 相同）。
 *
 * **本机真库实测的交叉表**（2026-10-06，前 4000 个 `.mov`）：
 *
 * ```
 *   A  「同目录 + 同 basename 有图片」   = 1107   ← 文件名判据会命中的
 *   B  本判据（Apple identifier）        =  169
 *   A ∩ B                                =    1   ← 真正配对得上的
 *   A \ B                                = 1106   ← 🔴 按文件名隐藏就会藏掉这些视频
 * ```
 *
 * 把「照文件名隐藏」与「照 identifier 隐藏」并排放，前者要藏掉 1106 个
 * （样本全是 `  (1).MOV 154MB ↔  (1).JPG 1MB` 的写真集「封面图 + 正片」），
 * 才换来 1 个正确的 —— 判据选型就是这么定的。
 *
 * 反向的担心（明文子串会不会误命中）也量过了：**169/169 都在 `keys` 表里
 * 结构化地存在，且 169/169 都能精确读出 UUID 值**（`readMdtaValue` 全成功）。
 * 也就是说这份语料上不存在「恰好带了这串字节」的普通视频。
 *
 * 另外 169 - 1 = 168 个命中是「有 identifier 但同目录找不到同名图片」——
 * 多数来自 `  (N).mov` 这类只剩视频、静帧没被保存的下载合集。它们会被判成
 * Live Photo 伴生但配不上静帧 ⇒ 落 `live_still_id = 0` ⇒ **照常作为普通视频
 * 出现在列表里**，不会被藏掉。这是刻意的：宁可少配一对，不可凭空藏一个视频。
 *
 * ## 为什么用字符串搜索而不是完整 atom 树解析
 *
 * 真实世界里这个 key 有**三种容器布局**：
 *   ① `moov/meta` 的 `keys` + `ilst`（mdta 命名空间，Apple 相机写出的形态）
 *   ② `moov/udta/meta/ilst` 的 `©xyz` 式四字键
 *   ③ ffmpeg 重封装后写出的 `ilst/----`（里头是 `name` + `data` 两个子 atom）
 *
 * 三种布局下 key 名**都是明文**，所以判据只做 `indexOf` 即可 —— 代码少、不脆、
 * 漏报低。而 `meta` box 的 body 有两种真实写法（ISO 的 FullBox 带 4 字节
 * version+flags / QuickTime 的历史写法不带），真去解析就绕不开这个歧义；
 * 字符串判据天然免疫。
 *
 * ⚠️ 这也是**为什么不把「能精确读出 UUID」升级成必需条件**：`readMdtaValue()`
 *    只认 ①（`keys`/`ilst`）那一种布局，②③ 上会返回 null。真要求它成功，
 *    就等于把 ②③ 形态的真 Live Photo 全部漏掉 —— 用「少藏一个视频」的收益
 *    换来「漏报一整类」的风险，不划算。
 *
 * 值（UUID）走 `readMdtaValue()` 精确解析，**只在确认命中的罕见路径上才跑**，
 * 取不到也不影响判据 —— 它只用于未来的双向校验（与图片侧 pairing id 对账）。
 * `hasStillTime`（`com.apple.quicktime.still-image-time`）同理：实测在这份语料上
 * 与 identifier 完全重合（169/169），加进来不改变任何判定，所以**只记录、不参与定案**。
 */

const fs = require('fs');

// ---- 探针规模 ----

/** 头部探针。moov 写在文件头（faststart）时够用。 */
const HEAD_PROBE_BYTES = 1024 * 1024;
/** 尾部探针。ffmpeg 默认把 moov 写在文件尾（非 faststart）—— 两种都要覆盖。 */
const TAIL_PROBE_BYTES = 4 * 1024 * 1024;
/** 小于这个体积就整读。Live Photo 的伴生视频（约 3 秒）几乎都落在这一档。 */
const WHOLE_READ_BYTES = 8 * 1024 * 1024;

// ---- 判据 key ----

/** 🔴 主判据：Apple 为 Live Photo 伴生视频写入的固有 key */
const LIVE_ID_KEY = 'com.apple.quicktime.content.identifier';
/** 辅助判据：静帧时刻标记（有它 = 视频里标了「图片是哪一帧」）。仅作双重确认，不单独定案。 */
const STILL_TIME_KEY = 'com.apple.quicktime.still-image-time';

/**
 * 可能的「伴生视频」扩展名。
 *
 * ⚠️ 只放 `.mov`：Live Photo 的伴生视频**必然是 QuickTime 容器**（Apple 自己写的）。
 *    真库里 5920 个「图片+视频」同名对里，`.mp4` 那部分抽查全是封面图形态 ——
 *    把 `.mp4` 拉进来只会白白多读几千个 GB 级文件的头部。
 */
const LIVE_MOTION_EXTENSIONS = new Set(['.mov']);

/** 可能与伴生视频配对的图片扩展名（iPhone 出 HEIC，导出后是 JPG）。 */
const LIVE_STILL_EXTENSIONS = new Set(['.heic', '.heif', '.jpg', '.jpeg', '.png']);

// ---- atom 解析小工具 ----

function readU64BE(buf, at) {
  return buf.readUInt32BE(at) * 4294967296 + buf.readUInt32BE(at + 4);
}

/**
 * 遍历 `[start, end)` 内的同层 atom。
 * size 越界 / 小于头长即停 —— 截断文件靠这个兜住，不抛异常。
 */
function walkAtoms(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = readU64BE(buf, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ pos, type, bodyStart: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

/** 这个偏移上能不能读出一个合法的 atom（size + 可打印的 4 字节 type）。 */
function looksLikeAtom(buf, at, end) {
  if (at + 8 > end) return false;
  const size = buf.readUInt32BE(at);
  if (size < 8 || at + size > end) return false;
  return /^[\x20-\x7e]{4}$/.test(buf.toString('latin1', at + 4, at + 8));
}

/**
 * `meta` box 的 body 起点有**两种真实布局**，用一个廉价校验区分：
 *   · ISO/IEC 14496-12 的 MetaBox 是 FullBox ⇒ body 前 4 字节是 version + flags
 *   · QuickTime 里 `udta/meta` 的历史写法**不带**这 4 字节
 * 哪种解读能让紧随其后的字节构成合法 atom 头，就用哪种。
 */
function metaBodyRange(buf, atom) {
  const withFlags = { bodyStart: atom.bodyStart + 4, end: atom.end };
  if (looksLikeAtom(buf, withFlags.bodyStart, atom.end)) return withFlags;
  return { bodyStart: atom.bodyStart, end: atom.end };
}

/** 找出所有 `moov/meta` 与 `moov/udta/meta` 的 body 范围。 */
function findMetaBoxes(buf) {
  const out = [];
  for (const top of walkAtoms(buf, 0, buf.length)) {
    if (top.type !== 'moov') continue;
    for (const kid of walkAtoms(buf, top.bodyStart, top.end)) {
      if (kid.type === 'meta') {
        out.push(metaBodyRange(buf, kid));
      } else if (kid.type === 'udta') {
        for (const u of walkAtoms(buf, kid.bodyStart, kid.end)) {
          if (u.type === 'meta') out.push(metaBodyRange(buf, u));
        }
      }
    }
  }
  return out;
}

/**
 * 从 `keys` + `ilst` 布局里精确取某个 key 的值。
 *
 * 布局（ISO/IEC 14496-12 §Metadata）：
 *   keys : fullbox(4) + entry_count(4) + N × [ size(4) + namespace(4='mdta') + key 名(size-8) ]
 *   ilst : N × [ size(4) + index(4，1-based，对应 keys 里的第几个) + data atom ]
 *   data : [ size(4) + 'data'(4) + 类型指示(4) + locale(4) + 值(UTF-8) ]
 *
 * 取不到返回 null —— 值是「锦上添花」，判据不依赖它。
 */
function readMdtaValue(buf, keyName) {
  for (const meta of findMetaBoxes(buf)) {
    const kids = walkAtoms(buf, meta.bodyStart, meta.end);
    const keysAtom = kids.find((a) => a.type === 'keys');
    const ilstAtom = kids.find((a) => a.type === 'ilst');
    if (!keysAtom || !ilstAtom || keysAtom.bodyStart + 8 > keysAtom.end) continue;

    const count = buf.readUInt32BE(keysAtom.bodyStart + 4);
    let p = keysAtom.bodyStart + 8;
    let hitIndex = 0;
    for (let i = 1; i <= count && p + 8 <= keysAtom.end; i++) {
      const sz = buf.readUInt32BE(p);
      if (sz < 8 || p + sz > keysAtom.end) break;
      const ns = buf.toString('latin1', p + 4, p + 8);
      if (ns === 'mdta' && buf.toString('utf8', p + 8, p + sz) === keyName) {
        hitIndex = i;
        break;
      }
      p += sz;
    }
    if (!hitIndex) continue;

    for (const item of walkAtoms(buf, ilstAtom.bodyStart, ilstAtom.end)) {
      // ⚠️ ilst 子 atom 的 type 位置存的是**大端整数下标**，不是四字符码 ——
      //    直接当字符串比会静默匹配不上（`\x00\x00\x00\x01`）。
      if (buf.readUInt32BE(item.pos + 4) !== hitIndex) continue;
      for (const d of walkAtoms(buf, item.bodyStart, item.end)) {
        if (d.type !== 'data') continue;
        const vStart = d.bodyStart + 8; // 跳过类型指示(4) + locale(4)
        if (vStart > d.end) continue;
        return buf.toString('utf8', vStart, d.end).replace(/\0+$/, '');
      }
    }
  }
  return null;
}

// ---- 文件探针 ----

/**
 * 读「足够判定」的字节：小文件整读，大文件读头 + 尾（moov 在头或尾两种都要覆盖）。
 * 读不出来返回空 Buffer（调用方按「不是 Live Photo」处理，不抛异常）。
 */
async function readProbeBytes(filePath, fileSize) {
  let fh = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const size = Number(fileSize) || 0;

    if (size > 0 && size <= WHOLE_READ_BYTES) {
      const buf = Buffer.alloc(size);
      const r = await fh.read(buf, 0, size, 0);
      return buf.subarray(0, r.bytesRead);
    }

    const headLen = size > 0 ? Math.min(HEAD_PROBE_BYTES, size) : HEAD_PROBE_BYTES;
    const head = Buffer.alloc(headLen);
    const r1 = await fh.read(head, 0, headLen, 0);
    if (r1.bytesRead < headLen || size <= HEAD_PROBE_BYTES) {
      return head.subarray(0, r1.bytesRead);
    }

    const tailLen = Math.min(TAIL_PROBE_BYTES, size - HEAD_PROBE_BYTES);
    if (tailLen <= 0) return head;
    const tail = Buffer.alloc(tailLen);
    const r2 = await fh.read(tail, 0, tailLen, size - tailLen);
    return Buffer.concat([head, tail.subarray(0, r2.bytesRead)]);
  } catch (eRead) {
    void eRead;
    return Buffer.alloc(0);
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch (eClose) {
        void eClose;
      }
    }
  }
}

/**
 * 这个视频文件是不是 Live Photo 的**伴生视频**。
 *
 * @param {string} filePath
 * @param {number} [fileSize] 已知体积（省一次 stat）
 * @returns {Promise<{isLivePhoto:boolean, hasStillTime:boolean, liveId:string|null,
 *                    probeBytes:number, probeMs:number}>}
 */
async function inspectLiveMotion(filePath, fileSize) {
  const t0 = Date.now();
  const buf = await readProbeBytes(filePath, fileSize);
  const probeBytes = buf.length;
  if (!probeBytes) {
    return { isLivePhoto: false, hasStillTime: false, liveId: null, probeBytes: 0, probeMs: Date.now() - t0 };
  }
  // latin1 保字节 —— 容器里混着二进制，用 utf8 会因非法序列被替换成 U+FFFD 而错位。
  const text = buf.toString('latin1');
  const hasId = text.includes(LIVE_ID_KEY);
  return {
    isLivePhoto: hasId,
    hasStillTime: text.includes(STILL_TIME_KEY),
    liveId: hasId ? readMdtaValue(buf, LIVE_ID_KEY) : null,
    probeBytes,
    probeMs: Date.now() - t0,
  };
}

/** 扩展名（带点、小写）。 */
function extOf(filePath) {
  const s = String(filePath || '');
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i).toLowerCase();
}

/**
 * 「同目录同 basename」的 stem（不含路径、不含扩展名、小写）。
 * 🔴 配对时**两侧必须用同一个函数**取 stem：一边用 `path.basename`、另一边自己
 *    字符串切，会在「文件名里含多个点」（`abc.1.jpg`）时分叉。
 */
function stemOf(filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return (i <= 0 ? base : base.slice(0, i)).toLowerCase();
}

/** 候选伴生视频：扩展名是 QuickTime 容器。 */
function couldBeLiveMotion(filePath) {
  return LIVE_MOTION_EXTENSIONS.has(extOf(filePath));
}

/** 候选静态图：扩展名是 iPhone 会出的图片格式。 */
function couldBeLiveStill(filePath) {
  return LIVE_STILL_EXTENSIONS.has(extOf(filePath));
}

module.exports = {
  LIVE_ID_KEY,
  STILL_TIME_KEY,
  HEAD_PROBE_BYTES,
  TAIL_PROBE_BYTES,
  WHOLE_READ_BYTES,
  LIVE_MOTION_EXTENSIONS,
  LIVE_STILL_EXTENSIONS,
  inspectLiveMotion,
  readProbeBytes,
  readMdtaValue,
  walkAtoms,
  extOf,
  stemOf,
  couldBeLiveMotion,
  couldBeLiveStill,
};
