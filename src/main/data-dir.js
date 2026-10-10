'use strict';

/**
 * 「图库数据放在哪个文件夹」的纯逻辑层：位置判定、迁移前的体检、带进度的复制与校验。
 *
 * 剥成独立模块的原因和 `maintenance-guard.js` 一样：main.js 一上来就要 electron 的
 * app / ipcMain，规则留在里面就只能靠「读源码文本」断言，那种断言测不出行为。
 * 这里只碰文件系统与路径计算，回归脚本可以拿临时目录真跑一遍。
 *
 * 🔴 **搬的是「整份图库数据」而不是单个 photos.db**：AI 索引（`ai-search` / `face-index`）
 *    与主库是一套（索引里的 id 就是 photos 表的主键），只搬一半会出现「索引在 C 盘、
 *    主库在 D 盘」的两处状态，将来排查必然绕。所以条目清单是固定的四条 + 它们的 WAL。
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { freeDiskBytes } = require('./maintenance-guard');

/** settings.json 里存数据目录的那个键；空串 = 用默认位置（Electron 的 userData）。 */
const SETTING_KEY = 'dataDir';

/**
 * 数据目录里属于「图库数据」的条目名（相对目录名，按迁移顺序排列）。
 *
 * `-wal` 两条是**条件条目**：库干净关闭后 WAL 会被 checkpoint 掉、文件随之消失，
 * 主库那条还在（见 `main.js` 关闭前的 `wal_checkpoint(TRUNCATE)`）。清单里照样写上，
 * 存在就搬、不存在就跳过 —— 漏了它等于可能少搬最后一次提交的内容。
 */
const DATA_ENTRY_NAMES = [
  'photos.db',
  'photos.db-wal',
  'catalog-cache.db',
  'catalog-cache.db-wal',
  'ai-search',
  'face-index',
];

/** 复制单个文件时的读写缓冲：18 GB 的主库按 8 MB 一块走，进度才跟得上。 */
const COPY_CHUNK_BYTES = 8 * 1024 * 1024;
/** 进度回调的最小间隔：复制是按块回调的，不节流会把渲染进程的 IPC 打满。 */
const PROGRESS_MIN_INTERVAL_MS = 250;
/** 目标盘至少要留出的余量系数：复制期间还会有临时文件与 WAL。 */
const SPACE_MARGIN = 1.02;

/**
 * 迁移时**在所选位置下新建的文件夹名**。
 *
 * 有这个默认名的原因：文件夹选择框是「选一个文件夹」，用户要搬到 D 盘时很自然会
 * 直接选中 `D:\` 本身 —— 那样 19 GB 的 `photos.db` / `ai-search/` / `face-index/`
 * 会**摊在盘根**，和别的目录混在一起，事后想整体搬走或备份都得逐个挑。所以默认
 * 再套一层以产品命名的文件夹，让整份图库数据自成一个可以整体搬运/删除的单位。
 *
 * 用 `AuroraGallery`（PascalCase）而不是打包名 `aurora-gallery`：后者是**程序数据目录**
 * 的键名（`%LOCALAPPDATA%\aurora-gallery\...`），没人会去翻；这个是用户会在资源管理器里
 * 一眼看到的文件夹，当成产品名写更好认。
 */
const DEFAULT_FOLDER_NAME = 'AuroraGallery';

/**
 * 把「用户选中的文件夹」变成**真正要落数据的目录**。
 *
 * 四种情况，前三种不套子文件夹：
 *   ① 选中的目录名本来就是 `AuroraGallery`（含大小写不同）—— 用户已经自己建好了；
 *   ② 选中目录里已经有 `photos.db` —— 那是在**指向一份已有的图库数据**（换盘/接回移动硬盘），
 *      再套一层就变成「在旧数据旁边新建一份空的」；
 *   ③ `<选中目录>/AuroraGallery` 里**已经有 photos.db** ⇒ **拒绝**，而不是并进去覆盖。
 *      那个文件夹里是另一份图库（另一台机器拷来的、或者以前搬过又换了设置）——
 *      默默往上写会毁掉它。拒绝时告诉用户「想用它就直接选中它」：那时走 ①，
 *      是**他明确指了那个目录**，不是我们替他决定的。
 *   ④ 其余（含磁盘根目录）⇒ `<选中目录>/AuroraGallery`。
 *
 * `deps.existsSync` 只为回归注入，产品路径走 `fs`。
 */
function resolveTargetDir(pickedDir, deps) {
  var norm = normalizeDirPath(pickedDir);
  if (!norm) return { ok: false, code: 'EMPTY', error: '请先选择一个要迁移到的文件夹' };
  var exists = deps && typeof deps.existsSync === 'function' ? deps.existsSync : fs.existsSync;
  function hasDb(dir) {
    try {
      return !!exists(path.join(dir, 'photos.db'));
    } catch (e) {
      void e;
      return false;
    }
  }
  if (path.basename(norm).toLowerCase() === DEFAULT_FOLDER_NAME.toLowerCase()) {
    return { ok: true, dir: norm, subfolder: false, reason: 'named' };
  }
  if (hasDb(norm)) return { ok: true, dir: norm, subfolder: false, reason: 'existing' };
  var sub = path.join(norm, DEFAULT_FOLDER_NAME);
  if (hasDb(sub)) {
    return {
      ok: false,
      code: 'OCCUPIED',
      error:
        '这个位置下的 ' +
        DEFAULT_FOLDER_NAME +
        ' 文件夹里已经有一份图库数据了。想继续用那一份，请在上一层里直接选中它；想搬到这里，请换一个位置。',
    };
  }
  return { ok: true, dir: sub, subfolder: true, reason: 'new' };
}

function normalizeDirPath(value) {
  var s = String(value == null ? '' : value).trim();
  if (!s) return '';
  try {
    return path.resolve(s);
  } catch (e) {
    void e;
    return s;
  }
}

/** Windows 路径大小写不敏感，跨平台比较一律小写化。 */
function isSameDir(a, b) {
  var pa = normalizeDirPath(a);
  var pb = normalizeDirPath(b);
  if (!pa || !pb) return false;
  return pa.toLowerCase() === pb.toLowerCase();
}

/** child 是否**严格**位于 parent 之内（自身不算）。 */
function isSubPath(parent, child) {
  var p = normalizeDirPath(parent);
  var c = normalizeDirPath(child);
  if (!p || !c || isSameDir(p, c)) return false;
  var rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 迁移目标能不能用。
 *
 * 🔴 **「目标在当前数据目录里面」必须挡掉**：那样复制会把自己套进去（边复制边变大），
 *    18 GB 的库能把目标盘写满才停，而且停下来时两边都是半成品。
 */
function validateTarget(fromDir, toDir) {
  var from = normalizeDirPath(fromDir);
  var to = normalizeDirPath(toDir);
  if (!to) return { ok: false, code: 'EMPTY', error: '请先选择一个要迁移到的文件夹' };
  if (isSameDir(from, to)) {
    return { ok: false, code: 'SAME', error: '这就是当前的位置，请另选一个文件夹' };
  }
  if (isSubPath(from, to)) {
    return {
      ok: false,
      code: 'INSIDE',
      error: '不能选当前文件夹里面的子文件夹（那样会把数据复制进自己），请另选一个位置',
    };
  }
  return { ok: true, code: 'OK', error: '', from: from, to: to };
}

function dirBytesSync(dir) {
  var total = 0;
  var stack = [dir];
  while (stack.length) {
    var current = stack.pop();
    var names;
    try {
      names = fs.readdirSync(current);
    } catch (e) {
      void e;
      continue;
    }
    for (var i = 0; i < names.length; i++) {
      var full = path.join(current, names[i]);
      try {
        var st = fs.statSync(full);
        if (st.isDirectory()) stack.push(full);
        else total += st.size;
      } catch (e2) {
        void e2;
      }
    }
  }
  return total;
}

function countFilesSync(dir) {
  var total = 0;
  var stack = [dir];
  while (stack.length) {
    var current = stack.pop();
    var names;
    try {
      names = fs.readdirSync(current);
    } catch (e) {
      void e;
      continue;
    }
    for (var i = 0; i < names.length; i++) {
      try {
        if (fs.statSync(path.join(current, names[i])).isDirectory()) stack.push(path.join(current, names[i]));
        else total += 1;
      } catch (e2) {
        void e2;
      }
    }
  }
  return total;
}

/** 盘点源目录里实际存在的条目（缺失的跳过，不算进总量）。 */
function listEntries(dir) {
  var root = normalizeDirPath(dir);
  var out = [];
  for (var i = 0; i < DATA_ENTRY_NAMES.length; i++) {
    var name = DATA_ENTRY_NAMES[i];
    var full = path.join(root, name);
    try {
      var st = fs.statSync(full);
      if (st.isDirectory()) {
        out.push({ name: name, kind: 'dir', bytes: dirBytesSync(full), files: countFilesSync(full) });
      } else {
        out.push({ name: name, kind: 'file', bytes: st.size, files: 1 });
      }
    } catch (e) {
      void e;
    }
  }
  return out;
}

function totalBytes(entries) {
  var total = 0;
  for (var i = 0; i < (entries || []).length; i++) total += Number(entries[i].bytes) || 0;
  return total;
}

/**
 * 迁移动手前的体检：搬什么、多大、目标盘够不够。
 * `shortageBytes` > 0 表示空间不足（差多少字节）；取不到剩余空间（free < 0）时不拦。
 *
 * @param {string} fromDir 当前数据目录
 * @param {string} toDir 目标目录
 * @param {Function} [statfs] 注入的 `fs.statfsSync` 替代品（回归里用它伪造目标盘余量）
 */
function planMigration(fromDir, toDir, statfs) {
  var check = validateTarget(fromDir, toDir);
  if (!check.ok) return Object.assign({ entries: [], totalBytes: 0 }, check);
  var entries = listEntries(check.from);
  var total = totalBytes(entries);
  var free = freeDiskBytes(check.to, statfs);
  var need = Math.ceil(total * SPACE_MARGIN);
  var shortage = free >= 0 && free < need ? need - free : 0;
  return {
    ok: true,
    code: 'OK',
    error: '',
    from: check.from,
    to: check.to,
    entries: entries,
    totalBytes: total,
    freeBytes: free,
    needBytes: need,
    shortageBytes: shortage,
  };
}

async function copyFileWithTick(src, dest, tick) {
  var srcStat = await fsp.stat(src);
  var rs = fs.createReadStream(src, { highWaterMark: COPY_CHUNK_BYTES });
  rs.on('data', function (chunk) {
    tick(chunk.length);
  });
  await pipeline(rs, fs.createWriteStream(dest, { highWaterMark: COPY_CHUNK_BYTES }));
  var destStat = await fsp.stat(dest);
  // 复制出来的大小对不上就是没搬全 —— 宁可现在失败，也不能拿一个半截库去覆盖设置。
  if (destStat.size !== srcStat.size) {
    throw new Error('复制后大小不一致：' + path.basename(src));
  }
}

async function copyDirWithTick(src, dest, tick) {
  await fsp.mkdir(dest, { recursive: true });
  var items = await fsp.readdir(src, { withFileTypes: true });
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var from = path.join(src, item.name);
    var to = path.join(dest, item.name);
    if (item.isDirectory()) {
      await copyDirWithTick(from, to, tick);
    } else if (item.isFile()) {
      await copyFileWithTick(from, to, tick);
    }
  }
}

/**
 * 把 `fromDir` 里的图库数据整份复制到 `toDir`。
 *
 * 进度回调是**累计字节**口径（分母 = 体检时量到的总大小）。复制过程中源目录不再有写入
 * （调用方已经先关掉全部数据库连接），所以总量不会变、百分比是单调的。
 *
 * @param {{fromDir: string, toDir: string, entries?: Array, totalBytes?: number,
 *          onProgress?: (p: {copiedBytes:number,totalBytes:number,current:string,percent:number}) => void}} options
 */
async function copyDataDir(options) {
  var opts = options || {};
  var from = normalizeDirPath(opts.fromDir);
  var to = normalizeDirPath(opts.toDir);
  var entries = opts.entries && opts.entries.length ? opts.entries : listEntries(from);
  var total = Number(opts.totalBytes) || totalBytes(entries);
  var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  var copied = 0;
  var lastEmit = 0;
  var currentName = '';
  function tick(n) {
    copied += Number(n) || 0;
    if (!onProgress) return;
    var now = Date.now();
    if (now - lastEmit < PROGRESS_MIN_INTERVAL_MS && copied < total) return;
    lastEmit = now;
    onProgress({
      copiedBytes: copied,
      totalBytes: total,
      current: currentName,
      percent: total > 0 ? Math.min(100, Math.round((copied / total) * 100)) : 0,
    });
  }

  await fsp.mkdir(to, { recursive: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    currentName = entry.name;
    var src = path.join(from, entry.name);
    var dest = path.join(to, entry.name);
    if (String(entry.kind) === 'dir') await copyDirWithTick(src, dest, tick);
    else await copyFileWithTick(src, dest, tick);
  }
  currentName = '';
  if (onProgress) {
    onProgress({ copiedBytes: copied, totalBytes: total, current: '', percent: 100 });
  }
  return { copiedBytes: copied, totalBytes: total };
}

/**
 * 直接读 SQLite 那 100 字节页头 —— 比 `new Database()` 更早、更便宜。
 *
 * 🔴 **为什么非要有它：`PRAGMA page_count` 抓不到「复制被截断」**。那个 pragma 返回的是
 *    SQLite **按文件实际大小**算出来的页数（`pPager->dbSize` 由文件长度推导），
 *    所以「page_count × page_size」与文件大小**恒等**，拿它去判截断等于判了个恒真式。
 *    真正携带「这个库应该有 N 页」这个**声明**的，是页头第 28~31 字节。
 *
 * 而截断恰恰是最可能的那种坏（复制中断、目标盘写满），且**不需要打开库就能判**：
 * 真库实测读页头 **103 ms**，而 `PRAGMA quick_check` 是 **318,948 ms（5 分 19 秒）**。
 * 更关键的是：被截断的库往往连 `new Database()` 都开不了 ⇒ 只靠 open 的话报出来的是
 * 「文件打不开」（用户看不出是没拷完），而小截断还可能开得起来、白读一遍整库才发现。
 *
 * ⚠️ 页头里的页数**只在一种情况下可信**：第 92~95 字节（version-valid-for）等于
 *    第 24~27 字节（file change counter）。这两个数**不是** `SQLITE_VERSION_NUMBER` ——
 *    本机真库实测 92~95 = **180**、96~99 = **3,053,000**（SQLite 3.53.0）：
 *    拿后者去比会**恒不成立**，于是这道预检在真库上永远不生效（第一版就是这么写的，
 *    在真文件上一读才发现）。
 *
 * @param {string} file
 * @returns {{ok: boolean, fileSize: number, pageSize: number|null, pageCount: number|null,
 *            declaredBytes: number|null, reason?: string}}
 *   `ok` 只表示「这 100 字节是像样的 SQLite 页头、且里面的页数可信」；
 *   `declaredBytes` 为 null = 没有可信声明，调用方**跳过**截断判定（不许因此判死）。
 */
function readSqliteHeader(file) {
  var out = {
    ok: false,
    fileSize: 0,
    pageSize: null,
    pageCount: null,
    declaredBytes: null,
  };
  var fd = null;
  try {
    out.fileSize = fs.statSync(file).size;
    if (out.fileSize < 100) {
      out.reason = 'too-small';
      return out;
    }
    fd = fs.openSync(file, 'r');
    var buf = Buffer.alloc(100);
    // 只读前 100 字节：宁可多一次 open/read，也不要把整页搬进内存
    var read = fs.readSync(fd, buf, 0, 100, 0);
    if (read < 100 || buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      out.reason = 'bad-magic';
      return out;
    }
    var encPageSize = buf.readUInt16BE(16);
    // 页大小编码：1 表示 65536，其余必须是 512~65536 之间的 2 的幂
    var pageSize = encPageSize === 1 ? 65536 : encPageSize;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      out.reason = 'bad-page-size';
      return out;
    }
    // 🔴 可信条件：version-valid-for（92~95）=== file change counter（24~27）
    if (buf.readUInt32BE(92) !== buf.readUInt32BE(24)) {
      out.reason = 'size-not-valid';
      return out;
    }
    var pageCount = buf.readUInt32BE(28);
    if (!pageCount) {
      out.reason = 'no-page-count';
      return out;
    }
    out.pageSize = pageSize;
    out.pageCount = pageCount;
    out.declaredBytes = pageSize * pageCount;
    out.ok = true;
    return out;
  } catch (e) {
    out.reason = 'read-failed:' + (e && e.message ? e.message : e);
    return out;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (e2) {
        void e2;
      }
    }
  }
}

/**
 * 只判「文件是不是被截断」—— **这一条的判据唯一源**。
 *
 * ⚠️ 单独成一个函数不是洁癖：校验 worker 要在**打开库之前**先用它（截断是最可能的坏，
 *    而截断的库往往连 open 都过不去，见 `readSqliteHeader`），那时还没有 `verdict`；
 *    如果硬用 `judgeCopy` 去做这道预检，就必须给它一个假的 `verdict`，
 *    而 `judgeCopy` 见到「不是 ok」的 verdict 会判 `CORRUPT` —— 预检于是变成了恒红的假结论。
 *
 * 只判「文件比它**自己声明**的短」：多出来的尾巴（对齐、旧页残留）无害，不算错。
 * `declaredBytes` 为 null / 非法 = 声明不可信 ⇒ **跳过**，不许因此判死。
 *
 * @param {number|null|undefined} fileSize 文件实际字节数
 * @param {number|null|undefined} declaredBytes 页头声明的应有字节数
 * @returns {{ok: boolean, code?: string, error?: string}}
 */
function judgeCopySize(fileSize, declaredBytes) {
  var actual = Number(fileSize);
  var declared = Number(declaredBytes);
  if (isFinite(actual) && isFinite(declared) && declared > 0 && actual < declared) {
    return {
      ok: false,
      code: 'TRUNCATED',
      error:
        '新位置的数据不完整：文件没写完（实际 ' +
        actual +
        ' 字节，而数据库自己记着应该有 ' +
        declared +
        ' 字节）。这次没有切换过去。',
    };
  }
  return { ok: true };
}

/**
 * 副本能不能当主库用 —— **判据唯一源**（不碰文件系统，纯函数）。
 *
 * 🔴 为什么判据要单独抽出来：取数有**两处**（主进程里同步取 / 校验 worker 里异步取，
 *    见 `src/workers/db-verify-worker.js`），而「什么算通过」只许有一份 ——
 *    两处各写一遍必然漂移，漂移的方向是「一边把坏库放了进去、另一边不认」，
 *    而这两条路都在迁移的关键路径上。抽出来之后两处都调它，回归也能直接喂假数据逐值断言。
 *
 * 三道，按「便宜 → 贵」的顺序装（越早判死越省时间，而最可能的那种坏正是最便宜那道抓的）：
 *   ① **文件被截断**（复制中断 / 目标盘写满）：见 `judgeCopySize`。读 100 字节页头，真库实测 103 ms。
 *   ② `PRAGMA quick_check`：b-tree 结构有没有坏页。这是**唯一**能查结构的一道，
 *      代价是读完整个库，所以它必须跑在 worker 里（否则窗口 5 分钟无响应）。
 *      ⚠️ 缺 `verdict`（这一道没做）**不许**当通过 —— 迁移的关键路径上「不知道」只能算没通过。
 *   ③ `photos` 行数与源库**一致** —— 只查结构的话，一个「结构完好但少了最后一次提交」
 *      的副本也会通过，而那正是迁移最怕的静默丢数据。
 *
 * @param {{verdict?: string, photoCount?: number, expectPhotoCount?: number|null,
 *          fileSize?: number|null, declaredBytes?: number|null}} input
 * @returns {{ok: boolean, code?: string, error?: string, photoCount?: number}}
 */
function judgeCopy(input) {
  var src = input || {};
  var sizeVerdict = judgeCopySize(src.fileSize, src.declaredBytes);
  if (!sizeVerdict.ok) return sizeVerdict;
  var verdict = src.verdict == null ? '' : String(src.verdict);
  if (verdict !== 'ok') {
    return {
      ok: false,
      code: 'CORRUPT',
      error: '新位置的数据检查没通过：' + (verdict || '未知'),
    };
  }
  var count = Number(src.photoCount) || 0;
  var expect = src.expectPhotoCount;
  if (expect != null && count !== Number(expect)) {
    return {
      ok: false,
      code: 'COUNT_MISMATCH',
      error: '新位置的数据不完整：新位置 ' + count + ' 张，原来 ' + expect + ' 张',
    };
  }
  return { ok: true, photoCount: count };
}

/**
 * 副本能不能当主库用（**主进程里同步取数** + `judgeCopy` 判定）。
 *
 * ⚠️ 迁移路径上**不用**这个函数（它会阻塞主线程，真库实测 5 分 19 秒，用户看到的是
 *    「卡死」）—— 迁移走 `main.js#verifyCopiedLibrary()`，那是在 worker 里取数、同一个
 *    `judgeCopy` 判定。留在这里是因为**回归夹具能真跑它**（临时小库毫秒级），
 *    而且它是「取数 → 判定」这条链路的参考实现。
 */
function verifySqliteFile(file, expectPhotoCount) {
  var Sqlite;
  try {
    Sqlite = require('better-sqlite3');
  } catch (e) {
    return {
      ok: false,
      code: 'NO_SQLITE',
      error: '无法检查新位置的数据（数据库组件不可用）：' + (e && e.message ? e.message : e),
    };
  }
  var handle = null;
  try {
    // 页头先读一遍（103 ms 级）：截断这种坏不该等到 open 失败、更不该等到读完整库才发现
    var header = readSqliteHeader(file);
    handle = new Sqlite(file, { readonly: true, fileMustExist: true });
    var row = handle.pragma('quick_check');
    var verdict = row && row[0] ? String(row[0].quick_check) : '';
    var countRow = handle.prepare('SELECT COUNT(*) AS n FROM photos').get();
    return judgeCopy({
      verdict: verdict,
      photoCount: Number(countRow && countRow.n) || 0,
      expectPhotoCount: expectPhotoCount,
      fileSize: header.fileSize,
      declaredBytes: header.declaredBytes,
    });
  } catch (e) {
    return {
      ok: false,
      code: 'UNREADABLE',
      error: '新位置的数据文件打不开：' + (e && e.message ? e.message : e),
    };
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch (e2) {
        void e2;
      }
    }
  }
}

/** 主库当前的行数（迁移前在主库上取一次，给副本当对照）。null 表示取不到（不参与校验）。 */
function photoCountOf(file) {
  var Sqlite;
  try {
    Sqlite = require('better-sqlite3');
  } catch (e) {
    void e;
    return null;
  }
  var handle = null;
  try {
    handle = new Sqlite(file, { readonly: true, fileMustExist: true });
    var row = handle.prepare('SELECT COUNT(*) AS n FROM photos').get();
    return Number(row && row.n) || 0;
  } catch (e2) {
    void e2;
    return null;
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch (e3) {
        void e3;
      }
    }
  }
}

/**
 * 删掉源目录里已经搬走的条目。**只删清单里的名字**，绝不删整个目录 ——
 * 源目录通常就是 userData，里面还有 settings.json（迁移后靠它记住新位置）。
 *
 * @param {string} dir 源数据目录
 * @param {Array<{name:string}>} entries 已复制的条目
 * @param {(fullPath: string) => Promise<void>} [trashItem] 走系统回收站的删除器（Electron 的 shell.trashItem）
 */
async function removeSourceEntries(dir, entries, trashItem) {
  var root = normalizeDirPath(dir);
  var removed = [];
  var failed = [];
  for (var i = 0; i < (entries || []).length; i++) {
    var full = path.join(root, entries[i].name);
    try {
      if (!fs.existsSync(full)) continue;
      if (typeof trashItem === 'function') await trashItem(full);
      else await fsp.rm(full, { recursive: true, force: true });
      removed.push(entries[i].name);
    } catch (e) {
      failed.push({ name: entries[i].name, error: e && e.message ? e.message : String(e) });
    }
  }
  return { removed: removed, failed: failed };
}

/**
 * ───────────────────────────────────────────────────────────────────────────
 * 「活跃数据目录在哪」—— 给**脚本 / 探针 / 诊断工具**用的只读解析。
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 🔴 为什么必须走函数、不能写成常量：数据目录**可迁移**。迁移之后**默认位置往往还留着
 *    一份同名旧库**（本机的迁移没走「删源」那一步，`%LOCALAPPDATA%\aurora-gallery\
 *    UserData\photos.db` 18 GB 那份**还在**，mtime 停在迁移那一刻），而它长得和活跃库
 *    一模一样 ⇒ 任何硬编码默认路径的工具都会**安静地读到迁移前的快照**：不报错、不告警，
 *    整份读数静默作废（甚至更糟：往旧副本里写）。
 *
 * 与产品路径的**故意差别**：`main.js#resolveDataDirPath` 会 `mkdir -p` + 写 `.writetest`
 * 探可写性，并带「回退 + 弹窗」副作用 —— 那是**启动路径**该做的事。诊断工具是只读的，
 * 不该往用户盘里写探针文件、也不该建目录，所以判据退一档：**配置的目录存在 ⇒ 就用它**；
 * 不存在才回退到默认位置，并**把「回退了」这件事返回出去**让调用方自己喊出来（禁静默）。
 */
function programDataDir(env) {
  var e = env || process.env;
  var base = e.LOCALAPPDATA;
  if (!base) {
    var os = require('os');
    base =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.platform === 'win32'
          ? e.APPDATA
          : e.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  return base ? path.join(base, 'aurora-gallery', 'UserData') : '';
}

/** 只读 `settings.json` 里的 `dataDir`；文件不在 / 不是 JSON 一律当「没配」。 */
function readDataDirSetting(programDir) {
  try {
    var raw = fs.readFileSync(path.join(normalizeDirPath(programDir), 'settings.json'), 'utf8');
    var obj = JSON.parse(raw);
    return normalizeDirPath(obj ? obj[SETTING_KEY] : '');
  } catch (e) {
    void e;
    return '';
  }
}

/**
 * 解析出**现在真正在用**的数据目录。返回值：
 *   `dir`        活跃数据目录（绝对路径）
 *   `programDir` 程序数据目录（`settings.json` / `hls-sessions` 这些**程序级**文件仍在这里，
 *                迁走的是图库数据，不是它）
 *   `configured` settings.json 里配的值（空串 = 没配）
 *   `isCustom`   是否与 `programDir` 不同
 *   `fellBack`   配了但用不上、已回退到 `programDir`
 *   `reason`     回退原因（给日志用；空串 = 没回退）
 */
function resolveActiveDataDir(programDir, deps) {
  var prog = normalizeDirPath(programDir || programDataDir());
  if (!prog) {
    throw new Error(
      '无法定位程序数据目录（%LOCALAPPDATA% 为空）⇒ 请显式传入 programDir，' +
        '或设 %LOCALAPPDATA%\\aurora-gallery\\UserData 指哪。',
    );
  }
  var configured = readDataDirSetting(prog);
  var exists = deps && typeof deps.existsSync === 'function' ? deps.existsSync : fs.existsSync;
  function usable(dir) {
    try {
      return exists(dir);
    } catch (e) {
      void e;
      return false;
    }
  }
  if (!configured) {
    return { dir: prog, programDir: prog, configured: '', isCustom: false, fellBack: false, reason: '' };
  }
  if (isSameDir(configured, prog)) {
    // 配的就是默认位置本身：不算自定义，但也不是回退。
    return { dir: prog, programDir: prog, configured: configured, isCustom: false, fellBack: false, reason: '' };
  }
  if (usable(configured)) {
    return {
      dir: configured,
      programDir: prog,
      configured: configured,
      isCustom: true,
      fellBack: false,
      reason: '',
    };
  }
  return {
    dir: prog,
    programDir: prog,
    configured: configured,
    isCustom: false,
    fellBack: true,
    reason: '无法访问 ' + configured,
  };
}

module.exports = {
  SETTING_KEY: SETTING_KEY,
  DEFAULT_FOLDER_NAME: DEFAULT_FOLDER_NAME,
  programDataDir: programDataDir,
  readDataDirSetting: readDataDirSetting,
  resolveActiveDataDir: resolveActiveDataDir,
  DATA_ENTRY_NAMES: DATA_ENTRY_NAMES,
  normalizeDirPath: normalizeDirPath,
  isSameDir: isSameDir,
  isSubPath: isSubPath,
  resolveTargetDir: resolveTargetDir,
  validateTarget: validateTarget,
  listEntries: listEntries,
  totalBytes: totalBytes,
  planMigration: planMigration,
  copyDataDir: copyDataDir,
  verifySqliteFile: verifySqliteFile,
  judgeCopy: judgeCopy,
  judgeCopySize: judgeCopySize,
  readSqliteHeader: readSqliteHeader,
  photoCountOf: photoCountOf,
  removeSourceEntries: removeSourceEntries,
};
