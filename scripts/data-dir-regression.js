'use strict';
// 「图库数据目录可以整份搬到别的盘」的回归。
//
// 判据都在 src/main/data-dir.js（纯逻辑，可直接在回归里跑）：
//   ① 目标位置的三种非法形状必须**在动手前**被挡掉（同目录 / 套在自己里面 / 空）；
//   ② 复制必须是字节级完整、且**只搬清单里的条目**（源目录里的 settings.json 绝不能动）；
//   ③ 副本要过 SQLite quick_check + 行数对照，否则不许改设置；
//   ④ 删旧文件只删搬走的那些，删不掉的必须把失败带回来（不能假装成功）。
// 「有没有接线到界面」另用源码契约兜底 —— main.js 一上来就 require electron，加载不了。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dataDir = require('../src/main/data-dir');

const MB = 1024 * 1024;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-datadir-' + tag + '-'));
}

function writeFile(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
}

function fakeStatfs(freeBytes) {
  return function () {
    // freeDiskBytes 用 bavail * bsize；把余量拆成 1 字节 × N 块，避开整数溢出。
    return { bavail: freeBytes, bsize: 1 };
  };
}

/**
 * 从源码里抠出一个函数并**真跑它**，用于「按分支决定说什么」这类契约。
 *
 * 🔴 为什么不用正则比对字符串：这里要测的是「哪个 scope 走哪一句话」。字符串匹配对
 *    分支顺序、条件写反、漏掉一种组合全都无感 —— 四句话原样都在，行为却是错的
 *    （这正是本项目元规则 ③「钉死代码 = 假绿」说的那种假绿）。
 * ⚠️ 只适用于**函数体里没有花括号字符串/正则**的小函数（这里是纯字符串拼接）。
 */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '源码里找不到函数 ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('大括号不配对，抠不出 ' + name);
}

function testValidateTarget() {
  const from = tmpDir('from');
  assert.equal(dataDir.validateTarget(from, '').ok, false, '空目标要挡掉');
  assert.equal(dataDir.validateTarget(from, '   ').code, 'EMPTY');
  assert.equal(dataDir.validateTarget(from, from).code, 'SAME', '目标=当前目录要挡掉');
  // Windows 路径大小写不敏感：换大小写也得认成同一个目录
  assert.equal(
    dataDir.validateTarget(from, from.toUpperCase()).code,
    'SAME',
    '大小写不同的同一路径仍是同一目录',
  );
  assert.equal(
    dataDir.validateTarget(from, path.join(from, 'nested')).code,
    'INSIDE',
    '目标在当前目录里面要挡掉（会自己复制自己）',
  );
  const to = tmpDir('to');
  assert.equal(dataDir.validateTarget(from, to).ok, true, '正常目标放行');
  // 目标是当前目录的**上级**是允许的：复制出来的是平级文件，不会套娃
  assert.equal(dataDir.validateTarget(path.join(from, 'x'), from).ok, true);
}

function testListAndPlan() {
  const from = tmpDir('plan');
  writeFile(path.join(from, 'photos.db'), 8 * MB);
  writeFile(path.join(from, 'catalog-cache.db'), 1 * MB);
  writeFile(path.join(from, 'ai-search', 'vec.bin'), 2 * MB);
  writeFile(path.join(from, 'settings.json'), 1024); // 不该被搬走
  const to = tmpDir('plan-to');

  const entries = dataDir.listEntries(from);
  const names = entries.map((e) => e.name);
  assert.deepEqual(
    names,
    ['photos.db', 'catalog-cache.db', 'ai-search'],
    '只列实际存在的条目，缺失的（face-index / -wal）跳过',
  );
  assert.equal(dataDir.totalBytes(entries), 11 * MB);
  assert.equal(
    names.indexOf('settings.json'),
    -1,
    'settings.json 绝不在迁移清单里 —— 它记着新位置，删了就回不来了',
  );

  const plan = dataDir.planMigration(from, to, fakeStatfs(12 * MB));
  assert.equal(plan.ok, true);
  assert.equal(plan.totalBytes, 11 * MB);
  assert.equal(plan.shortageBytes, 0, '目标盘够就放行（11MB × 1.02 余量）');

  const tight = dataDir.planMigration(from, to, fakeStatfs(11 * MB));
  assert.ok(tight.shortageBytes > 0, '正好等于原大小也不够：还要留余量');
  assert.equal(tight.needBytes, Math.ceil(11 * MB * 1.02));

  const unknown = dataDir.planMigration(from, to, function () {
    throw new Error('statfs-boom');
  });
  assert.equal(unknown.freeBytes, -1, '取不到余量时记为未知');
  assert.equal(unknown.shortageBytes, 0, '余量未知时不拦（交给真实写盘去报错）');
}

async function testCopyAndVerify() {
  const from = tmpDir('copy-from');
  const to = tmpDir('copy-to');
  writeFile(path.join(from, 'photos.db'), 6 * MB);
  writeFile(path.join(from, 'ai-search', 'a.bin'), 1 * MB);
  writeFile(path.join(from, 'ai-search', 'sub', 'b.bin'), 512 * 1024);
  writeFile(path.join(from, 'settings.json'), 2048);

  const entries = dataDir.listEntries(from);
  const total = dataDir.totalBytes(entries);
  const seen = [];
  const copied = await dataDir.copyDataDir({
    fromDir: from,
    toDir: to,
    entries: entries,
    totalBytes: total,
    onProgress: (p) => seen.push(p),
  });

  assert.equal(copied.copiedBytes, total, '复制字节数要等于体检量到的大小');
  assert.equal(fs.statSync(path.join(to, 'photos.db')).size, 6 * MB, '主库字节数一致');
  assert.equal(fs.statSync(path.join(to, 'ai-search', 'sub', 'b.bin')).size, 512 * 1024);
  assert.equal(fs.existsSync(path.join(to, 'settings.json')), false, 'settings.json 没被复制走');

  // 进度：单调不减、末帧 100%
  assert.ok(seen.length >= 1, '要有进度回调');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].copiedBytes >= seen[i - 1].copiedBytes, '进度不能往回走');
  }
  const last = seen[seen.length - 1];
  assert.equal(last.percent, 100, '最后一帧必须是 100%');

  // 副本校验：拿真 SQLite 库验 quick_check 与行数对照
  const sqliteDb = path.join(to, 'photos.db');
  let Sqlite;
  try {
    Sqlite = require('better-sqlite3');
  } catch (e) {
    // 回归跑在 electron node 模式下，正常应该加载得到；加载不到就跳过这一节而不是误报绿。
    console.log('[data-dir] better-sqlite3 不可用，跳过副本校验用例：', e && e.message);
    return;
  }
  const dbPath = path.join(to, 'verify.db');
  const handle = new Sqlite(dbPath);
  handle.exec('CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT)');
  handle.prepare('INSERT INTO photos (file_path) VALUES (?), (?), (?)').run('a.jpg', 'b.jpg', 'c.jpg');
  handle.close();

  const good = dataDir.verifySqliteFile(dbPath, 3);
  assert.equal(good.ok, true, '完好副本 + 行数一致要通过');
  assert.equal(good.photoCount, 3);

  const mismatch = dataDir.verifySqliteFile(dbPath, 99);
  assert.equal(mismatch.ok, false, '行数对不上必须判失败（可能少搬了提交）');
  assert.match(mismatch.error, /99/);

  const broken = dataDir.verifySqliteFile(sqliteDb, null);
  assert.equal(broken.ok, false, '不是 SQLite 文件的副本要判失败');
}

async function testRemoveSource() {
  const from = tmpDir('rm');
  writeFile(path.join(from, 'photos.db'), 1 * MB);
  writeFile(path.join(from, 'ai-search', 'x.bin'), 1 * MB);
  writeFile(path.join(from, 'settings.json'), 512);

  const trashed = [];
  const res = await dataDir.removeSourceEntries(from, [{ name: 'photos.db' }, { name: 'ai-search' }], async (p) => {
    if (String(p).endsWith('ai-search')) throw new Error('被占用');
    trashed.push(p);
  });

  assert.deepEqual(res.removed, ['photos.db'], '删掉的带回来');
  assert.equal(res.failed.length, 1, '删不掉的**必须**带回来，不能假装成功');
  assert.match(res.failed[0].error, /被占用/);
  assert.equal(fs.existsSync(path.join(from, 'ai-search')), true, '失败的那个还在');
  assert.equal(fs.existsSync(path.join(from, 'settings.json')), true, 'settings.json 必须还在');
}

function testResolveTargetDir() {
  // 🔴 默认文件夹名必须**带应用名**：用户要在资源管理器里一眼认出这是哪个程序的数据。
  //    同时它不能等于打包名 `aurora-gallery`（那是 %LOCALAPPDATA% 里的程序数据目录键名，
  //    两个名字指同一件事会让「到底搬的是哪个」变得没法从路径上看出来）。
  assert.match(dataDir.DEFAULT_FOLDER_NAME, /aurora/i, '默认文件夹名要带应用名');
  assert.notEqual(
    dataDir.DEFAULT_FOLDER_NAME.toLowerCase(),
    'aurora-gallery',
    '默认文件夹名不要与程序数据目录名相同（会看不出搬的是哪一个）',
  );

  // ① 普通目录 ⇒ 再套一层（选中磁盘根目录时 19 GB 就不会摊在盘根）
  const plain = tmpDir('plain');
  const one = dataDir.resolveTargetDir(plain);
  assert.equal(one.ok, true);
  assert.equal(one.subfolder, true, '普通目录要套一层默认文件夹');
  assert.equal(one.dir, path.join(plain, dataDir.DEFAULT_FOLDER_NAME));
  assert.equal(dataDir.isSubPath(plain, one.dir), true, '套出来的目录必须是选中目录的子目录');

  // ② 目录名本来就是 AuroraGallery（大小写不同也算）⇒ 原样使用，别套成 X/AuroraGallery/AuroraGallery
  const named = path.join(plain, dataDir.DEFAULT_FOLDER_NAME);
  fs.mkdirSync(named, { recursive: true });
  const two = dataDir.resolveTargetDir(named);
  assert.equal(two.subfolder, false, '已经叫 AuroraGallery 就不要再套一层');
  assert.equal(two.reason, 'named');
  assert.equal(two.dir, named);
  const lower = path.join(plain, dataDir.DEFAULT_FOLDER_NAME.toLowerCase());
  fs.mkdirSync(lower, { recursive: true });
  assert.equal(dataDir.resolveTargetDir(lower).subfolder, false, '大小写不同也算同名');

  // ③ 目录里已经有 photos.db ⇒ 那是在**指向一份已有的图库数据**（换盘 / 接回移动硬盘），
  //    再套一层会变成「在旧数据旁边新建一份空的」
  const withDb = tmpDir('withdb');
  fs.writeFileSync(path.join(withDb, 'photos.db'), 'x');
  const three = dataDir.resolveTargetDir(withDb);
  assert.equal(three.subfolder, false, '已有 photos.db 的目录要原样使用');
  assert.equal(three.reason, 'existing');
  assert.equal(three.dir, withDb);
  // 用注入的 existsSync 验同一条判据（干净目录 + 假的 photos.db）
  const injected = dataDir.resolveTargetDir(plain, {
    existsSync: (p) => p.toLowerCase().endsWith('photos.db'),
  });
  assert.equal(injected.reason, 'existing', '判据看的是「里面有没有 photos.db」');

  // ③b 选中位置下的 `AuroraGallery` 里**已经有一份图库** ⇒ 拒绝，别并进去把它覆盖掉
  //     （另一台机器拷来的、或以前搬过又换了设置）。想用它就明确选中它（那时走 ①）。
  const occupied = tmpDir('occupied');
  const sub = path.join(occupied, dataDir.DEFAULT_FOLDER_NAME);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'photos.db'), 'x');
  const four = dataDir.resolveTargetDir(occupied);
  assert.equal(four.ok, false, '不能往已有的另一份图库上写');
  assert.equal(four.code, 'OCCUPIED');
  assert.equal(dataDir.resolveTargetDir(sub).ok, true, '明确选中它本身则放行（那时用户已经指了那个目录）');

  // ④ 空目标仍然要挡（这里和 validateTarget 是同一个 code）
  assert.equal(dataDir.resolveTargetDir('').ok, false);
  assert.equal(dataDir.resolveTargetDir('   ').code, 'EMPTY');

  // ⑤ 接线：选目录通道必须走 resolveTargetDir，且**体检的是最终目录** ——
  //    拿用户点中的目录去体检，会让「选中当前目录自己」因为多了一层而误判成合法。
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const pickAt = mainSrc.indexOf("ipcMain.handle('select-data-dir'");
  const pickBlock = mainSrc.slice(pickAt, pickAt + 2000);
  assert.match(pickBlock, /dataDirLib\.resolveTargetDir\(/, '选目录后要算出最终目录');
  assert.match(
    pickBlock,
    /dataDirLib\.validateTarget\(currentDataDir\(\), target\.dir\)/,
    '体检必须针对最终目录（含自动新建的那层）',
  );
  assert.match(pickBlock, /subfolder: !!target\.subfolder/, '要把「会不会新建文件夹」告诉界面');
}

/**
 * 「活跃数据目录在哪」的判据 —— **脚本 / 探针 / 诊断工具**都靠它，而它承载的是本项目
 * 最容易静默失效的一类事实。
 *
 * 🔴 为什么必须钉：数据目录**可迁移**，而迁移之后**默认位置往往还留着一份同名旧库**
 *    （本机的迁移没走「删源」，那 18 GB 的 `photos.db` 实测还在，mtime 停在迁移那一刻）。
 *    判据写错 / 被谁改回硬编码默认路径的后果 = 工具**安静地对着迁移前的快照跑**：
 *    不报错、不告警、`photos.db` 长得一模一样，整份读数作废（甚至往旧副本里写）。
 */
function testActiveDataDirForProbes() {
  const prog = path.join(tmpDir('prog'), 'UserData');
  fs.mkdirSync(prog, { recursive: true });
  const settingsFile = path.join(prog, 'settings.json');

  // ① 没配 dataDir（键不存在 / 空串 / 全空白 / settings.json 坏掉）⇒ 默认位置，且不算自定义。
  //    ⚠️ settings.json 读坏了**不能崩** —— 诊断工具最需要能跑起来的时刻，恰恰是配置出问题的时候。
  for (const raw of ['{}', '{"dataDir":""}', '{"dataDir":"   "}', '这不是 JSON{', 'null']) {
    fs.writeFileSync(settingsFile, raw);
    const r = dataDir.resolveActiveDataDir(prog);
    assert.equal(r.dir, prog, 'settings.json = ' + raw + ' 要当「没配」用默认位置');
    assert.equal(r.isCustom, false, '没配不算自定义');
    assert.equal(r.fellBack, false, '没配不是回退');
  }

  // ② 配了且目录在 ⇒ 就用它，并且要认出「这不是默认位置」（本机实测 = D:\AuroraGallery）
  const custom = tmpDir('custom');
  fs.writeFileSync(settingsFile, JSON.stringify({ dataDir: custom }));
  const hit = dataDir.resolveActiveDataDir(prog);
  assert.equal(hit.dir, custom, '配了 dataDir 就要用它');
  assert.equal(hit.isCustom, true);
  assert.equal(hit.fellBack, false);
  assert.equal(hit.programDir, prog, '程序数据目录（settings.json 所在）要一并带回来');
  assert.equal(hit.configured, custom, '要能回显配置值，便于日志里写清「用的是哪个」');

  // ③ 配了但打不开（盘没插）⇒ 回退到默认位置，**且必须把「回退了」报出来**（禁静默）。
  //    产品路径（main.js#resolveDataDirPath）同样回退，但会弹窗 —— 工具没有界面，
  //    所以只能靠返回值让调用方自己喊，这条断言守的就是「信息没被吞掉」。
  const ghost = path.join(os.tmpdir(), 'aurora-ghost-' + process.pid + '-' + Date.now());
  fs.writeFileSync(settingsFile, JSON.stringify({ dataDir: ghost }));
  const miss = dataDir.resolveActiveDataDir(prog);
  assert.equal(miss.dir, prog, '打不开就要回退到默认位置');
  assert.equal(miss.fellBack, true);
  assert.equal(miss.isCustom, false);
  assert.match(miss.reason, /无法访问/, '回退原因要能说清是哪个位置打不开');

  // ④ 配的就是默认位置本身 ⇒ 既不算自定义、也不算回退（否则日志会把常态报成异常）
  fs.writeFileSync(settingsFile, JSON.stringify({ dataDir: prog }));
  const same = dataDir.resolveActiveDataDir(prog);
  assert.equal(same.dir, prog);
  assert.equal(same.isCustom, false);
  assert.equal(same.fellBack, false);

  // ⑤ 接线：**定位活跃库的脚本**不许再自己拼默认路径。
  //    这两个是「会长期写库」的手工脚本（全库人脸索引 / 下模型），错一次就是几天白跑 + 写错位置。
  for (const rel of ['scripts/face-index-full.js', 'scripts/download-face-models.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(src, /resolveActiveDataDir\(/, rel + ' 必须按 settings.json#dataDir 解析活跃目录');
    assert.equal(
      src.includes('process.env.LOCALAPPDATA'),
      false,
      rel + ' 不能再拼 %LOCALAPPDATA% 默认路径（迁移后会安静地读到 / 写到旧副本）',
    );
  }
}

function testPausedCleanupContract() {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const appSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'app.js'),
    'utf8',
  );
  const i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');

  // 🔴 为什么要让路而不是「等它跑完」：失效清理要**扫完整个库** —— 启动那一趟每批 400 行、
  //    批间 450 ms（START_DELAY_MS / STEP_DELAY_MS / BATCH_SIZE），在本机 165.7 万行的真库上
  //    是几十分钟到几小时的量级，而它整段都举着 `maintenanceBusy()` 这把闸门 ⇒
  //    「等它跑完再迁移」实际上等于「今天别迁了」（用户实测报的就是这个）。
  const pauseAt = mainSrc.indexOf('function pauseInvalidCleanupForMigration()');
  assert.ok(pauseAt > 0, '要有「为迁移暂停失效清理」这一步');

  // ① 必须先让路、再看闸门。顺序反了 = 拿一把**自己刚举着**的闸门去问自己能不能进
  //    （失效清理还在 running，maintenanceBusy() 恒为真，迁移永远拿不到 BUSY 之后的路径）。
  //    ⚠️ 判据要夹在「暂停调用 → 体检」这段区间里比。光用 indexOf 从暂停处往后搜
  //    `if (maintenanceBusy())` 是**假绿**：手动静音清理的 IPC 里也有同名字的检查点，
  //    顺序真的写反时它会替那处顶包（实测过）。
  const migrateAt = mainSrc.indexOf('async function runDataDirMigration(');
  const callAt = mainSrc.indexOf('var pausedTasks = pauseInvalidCleanupForMigration();');
  const planAt = mainSrc.indexOf('var plan = dataDirLib.planMigration(', migrateAt);
  assert.ok(migrateAt > 0 && callAt > migrateAt, '暂停调用要落在 runDataDirMigration 里');
  assert.ok(planAt > migrateAt, '找不到体检那一步（结构变了要同步改守护）');
  assert.ok(callAt < planAt, '暂停调用要在体检之前');
  assert.match(
    mainSrc.slice(callAt, planAt),
    /if \(maintenanceBusy\(\)\)/,
    '先让失效清理让开，再看写库闸门',
  );

  // ② 停启动那一趟：`running = false` 是**唯一**的放闸门判据（maintenanceBusy 读它），
  //    还得把 timer 清掉 —— 它可能正停在批间 450 ms 的 setTimeout 上，不清就会有一次
  //    作废的 step 空跑（并写出一条与事实不符的 `invalid-cleanup.finish` 打点）。
  //    🔴 这里把这个函数**抽出来真跑**：考点是「它到底有没有把这两个任务从闸门上摘下来」，
  //       读源码字符串只能证明那几行写得像，证明不了它们真的被走到、真的改了状态。
  const pauseFn = extractFunction(mainSrc, 'pauseInvalidCleanupForMigration');
  const makePause = (startupTask, manualTask) => {
    const log = [];
    const cleared = [];
    const fn = new Function(
      'startupInvalidCleanupTask',
      'invalidCleanupTask',
      'clearTimeout',
      'startupStageLog',
      'logger',
      'emitBackgroundTasksChangedThrottled',
      pauseFn + '\nreturn pauseInvalidCleanupForMigration;',
    )(
      startupTask,
      manualTask,
      (t) => cleared.push(t),
      (stage, detail) => log.push(stage + '|' + detail),
      { warn: (m) => log.push('warn|' + m) },
      () => log.push('emit'),
    );
    return { run: fn, log, cleared };
  };

  // 正在跑启动那一趟（用户实测的场景）：必须停掉、清 timer、并让界面知道后台任务变了
  const startupTask = { running: true, timer: 'T-handle', beforeId: 12345 };
  const manualTask = { running: false, cancelled: false };
  let h = makePause(startupTask, manualTask);
  let paused = h.run();
  assert.equal(startupTask.running, false, '启动那一趟要从闸门上摘下来');
  assert.equal(manualTask.cancelled, false, '没在跑的那趟不该被动到');
  assert.deepEqual(h.cleared, ['T-handle'], '批间 timer 要真的被清掉（不是只置 null 留着空跑）');
  assert.equal(startupTask.timer, null, 'timer 字段也要置空');
  assert.equal(paused.length, 1, '要如实报出被暂停的任务');
  assert.deepEqual(paused[0], { label: '清理失效记录', scope: 'startup' });
  assert.ok(
    h.log.some((l) => l.startsWith('invalid-cleanup.paused|')),
    '要留一条启动打点（否则「迁移把清理停了」这件事在日志里查不到）',
  );
  assert.ok(h.log.includes('emit'), '要让界面立刻知道「正在清理失效记录」已经不在跑了');
  assert.ok(
    h.log.some((l) => l.startsWith('warn|')),
    '被迁移打断是异常路径，要 warn 级留痕',
  );

  // ③ 手动那一趟用 `cancelled` 表达（它的批间循环读的就是这个标志）
  const manualRunning = { running: true, cancelled: false };
  h = makePause({ running: false, timer: null }, manualRunning);
  paused = h.run();
  assert.equal(manualRunning.cancelled, true, '手动那一趟要置 cancelled（它同样举着闸门）');
  assert.deepEqual(paused[0], { label: '清理失效记录', scope: 'manual' });

  // 两趟都在跑：两条都要报（界面按 scope 分开说「自动的下次启动接着做 / 手动的要你再点」）
  h = makePause({ running: true, timer: 'T2' }, { running: true, cancelled: false });
  paused = h.run();
  assert.equal(paused.length, 2, '两趟都在跑就要报两条');
  assert.deepEqual(
    paused.map((p) => p.scope).sort(),
    ['manual', 'startup'],
    '两条各自的 scope 不能丢',
  );

  // 都没在跑（比如开机自检已经跑完了）：不该碰任何状态，也不该发无谓的通知
  const idle = makePause({ running: false, timer: null }, { running: false, cancelled: false });
  assert.deepEqual(idle.run(), [], '没什么可暂停的就返回空');
  assert.equal(idle.log.length, 0, '什么都没暂停就别去动界面状态（免得闪一下「后台任务变了」）');

  // 🔴 而 `cancelled` 一旦置位就必须**在下次开跑前复位**，否则第二次点「清理失效记录」
  //    会一批都不做就立刻结束 —— 界面上是「点了没反应」，日志里什么都没有。
  //    它原先只被读、从没被写过；为了给迁移让路才第一次真的会置位。
  const resetAt = mainSrc.indexOf('invalidCleanupTask.cancelled = false;');
  const readAt = mainSrc.indexOf('!invalidCleanupTask.cancelled');
  assert.ok(resetAt > 0, '手动入口要复位 cancelled（否则下一次点清理静默空转）');
  assert.ok(readAt > resetAt, '复位必须发生在批间循环读它之前');
  assert.match(
    mainSrc,
    /invalidCleanupTask = \{\s*\n\s*running: false,[\s\S]{0,600}?cancelled: false,/,
    'cancelled 要在任务对象里显式声明（原先只被读、是永远的 undefined）',
  );

  // ④ 暂停是**已经发生的副作用** ⇒ 每个出口都要把「谁被暂停了」带回界面，
  //    不只是成功那条（用户看不到自己的后台任务被悄悄改期）。
  // 先查最要害的那条，再查总数 —— 反过来的话「成功返回漏挂」会被计数断言先吃掉，
  // 失败信息只报「5 处」而不说漏的是哪一处（实测踩过）。
  assert.match(
    mainSrc,
    /return withPaused\(\{\s*\n\s*success: true,/,
    '成功返回也要带 pausedTasks —— 迁移完就重启，用户会看到清理「从零开始」',
  );
  const wrapped = (mainSrc.match(/return withPaused\(/g) || []).length;
  assert.ok(
    wrapped >= 6,
    '暂停之后的每个 return 都要带 pausedTasks（BUSY / 体检失败 / 没数据 / 空间不够 / 成功 / 异常），实际 ' +
      wrapped +
      ' 处',
  );
  assert.match(mainSrc, /function withPaused\(result\)/, '用一层包装保证新增出口时不会漏');

  // ⑤ 渲染端要按 scope 分开说：自动那一趟每次启动都会重排（「下次启动会接着做」是真话），
  //    手动那一趟没人会替他再点。两句混成一句就会对一半错一半。
  //    🔴 这里**不比对字符串，而是把这个函数抽出来真跑** —— 考点是「哪个 scope 走哪一句」，
  //       字符串在不在根本测不出来（分支顺序写反了照样全都在）。
  const noteFn = extractFunction(appSrc, 'dataDirPausedNote');
  const KEYS = {
    'settings.storage.dataDirPausedFmt': 'AUTO',
    'settings.storage.dataDirPausedManualFmt': 'MANUAL',
    'settings.storage.dataDirPausedBothFmt': 'BOTH',
    'settings.storage.dataDirPausedOtherFmt': 'OTHER',
  };
  const stubFormat = (key, vars) => (KEYS[key] || '?') + '(' + String(vars.names) + ')';
  const dataDirPausedNote = new Function(
    'tUiFmt',
    'tUi',
    'return (' + noteFn + ');',
  )(stubFormat, (key, fallback) => KEYS[key] || fallback);

  assert.equal(dataDirPausedNote(undefined), '', '没有暂停过就不该多一句话');
  assert.equal(dataDirPausedNote([]), '', '空数组同理');
  assert.equal(dataDirPausedNote([{ scope: 'startup' }]), '', '没有 label 的条目要忽略');

  // 说明要换行接在结果正文后面（不换行会被读成正文的一部分）
  const strip = (s) => (s.startsWith('\n') ? s.slice(1) : s);
  const onlyStartup = dataDirPausedNote([{ label: '清理失效记录', scope: 'startup' }]);
  assert.ok(onlyStartup.startsWith('\n'), '说明要换行接在结果后面');
  assert.equal(strip(onlyStartup), 'AUTO(清理失效记录)', '只停了自动那一趟 ⇒ 说「下次启动会接着做」');

  const onlyManual = dataDirPausedNote([{ label: '清理失效记录', scope: 'manual' }]);
  assert.equal(
    strip(onlyManual),
    'MANUAL(清理失效记录)',
    '只停了手动那一趟 ⇒ 只能说「需要时再点一次」（说「下次启动会自动继续」是假话）',
  );

  const both = dataDirPausedNote([
    { label: '清理失效记录', scope: 'startup' },
    { label: '清理失效记录', scope: 'manual' },
  ]);
  assert.equal(strip(both), 'BOTH(清理失效记录)', '两趟都停了要分别交代');
  assert.equal(
    (both.match(/清理失效记录/g) || []).length,
    1,
    '同名任务只报一次（两趟是同一件事，重复报会让人以为有两个任务）',
  );

  // 认不出的 scope 不许猜：它既不能承诺「下次启动会自动恢复」，也不能说「再点一次」
  const unknown = dataDirPausedNote([{ label: '某个新任务', scope: 'whatever' }]);
  assert.equal(
    strip(unknown),
    'OTHER(某个新任务)',
    '未知 scope 要走只承诺「你可以自己重新开始」那句',
  );
  // 跳过没有 label 的条目之后，剩下的仍要能说清楚
  assert.equal(
    strip(dataDirPausedNote([{ scope: 'startup' }, { label: '清理失效记录', scope: 'startup' }])),
    'AUTO(清理失效记录)',
    '夹在中间的空条目不该把有名字的那条带走',
  );
  // 不同类型的任务要一起报出来
  assert.equal(
    strip(
      dataDirPausedNote([
        { label: '清理失效记录', scope: 'startup' },
        { label: '补齐数据库索引', scope: 'startup' },
      ]),
    ),
    'AUTO(清理失效记录、补齐数据库索引)',
    '多条用顿号连起来',
  );

  // 接线：四类结果都要带上它
  assert.match(
    appSrc,
    /doneLine \+= dataDirPausedNote\(pausedSeen\)/,
    '成功那条也要说 —— 那是用户唯一能看到结果的时刻',
  );
  const noteUses = (appSrc.match(/dataDirPausedNote\(/g) || []).length;
  assert.ok(noteUses >= 4, '四类结果（成功 / 等满上限 / 失败 / 异常）都要带上说明，实际 ' + noteUses + ' 处');

  // 🔴 **暂停发生在某一次重试里，而界面只看得到最后那次的返回值** —— 这条是真实 change
  //    探针（`.workbuddy/tmp/data-dir-paused-cleanup-probe.js`）抓出来的真缺陷：
  //    实测「第一次 BUSY 且带 pausedTasks、第二次成功且 pausedTasks 为空」⇒
  //    暂停真的发生了、界面一个字都没说。修法是把每次尝试报过的暂停**累积**起来。
  assert.match(
    appSrc,
    /pausedSeen = mergePausedTasks\(pausedSeen, r\)/,
    '每一次尝试的返回都要过一遍累积（漏了它 = 又回到「只看最后一次」）',
  );
  assert.equal(
    /dataDirPausedNote\(\s*r\s*&&\s*r\.pausedTasks/.test(appSrc) ||
      /dataDirPausedNote\(r\.pausedTasks\)/.test(appSrc),
    false,
    '不许再直接读单次返回的 pausedTasks（那正是「暂停发生了却不说」的形状）',
  );

  // 合并 + 去重是纯函数，**真跑**它（这是探针抓到的那个缺陷的修法本身）
  const mergeFn = extractFunction(appSrc, 'mergePausedTasks');
  const mergePausedTasks = new Function('return (' + mergeFn + ');')();
  assert.deepEqual(mergePausedTasks([], { pausedTasks: [{ label: '清理失效记录', scope: 'startup' }] }), [
    { label: '清理失效记录', scope: 'startup' },
  ]);
  // 探针实测的那条链路：第一次报、第二次为空 —— 累积后必须**留住**第一条
  let seen = [];
  seen = mergePausedTasks(seen, { code: 'BUSY', pausedTasks: [{ label: '清理失效记录', scope: 'startup' }] });
  seen = mergePausedTasks(seen, { success: true });
  assert.equal(seen.length, 1, '第二次没报暂停，也要把第一次那条留住（否则界面又没话说了）');
  // 同一条重复报只留一份
  assert.equal(
    mergePausedTasks(seen, { pausedTasks: [{ label: '清理失效记录', scope: 'startup' }] }).length,
    1,
    '同 label + 同 scope 不许重复累积',
  );
  // 同名但不同 scope 是两件事（自动那趟 / 手动那趟），必须都留
  assert.equal(
    mergePausedTasks(seen, { pausedTasks: [{ label: '清理失效记录', scope: 'manual' }] }).length,
    2,
    '同名不同 scope 要分开留（界面上是「自动的会自己接着做 / 手动的要你再点」两句）',
  );
  // 没有名字的条目丢掉（说不清是什么，宁可不说）
  assert.equal(mergePausedTasks([], { pausedTasks: [{ scope: 'startup' }] }).length, 0);
  assert.equal(mergePausedTasks([], null).length, 0);
  assert.equal(mergePausedTasks([], {}).length, 0);
  assert.equal(mergePausedTasks(undefined, { pausedTasks: [] }).length, 0);
  // 不许改动传进来的数组（调用方可能会复用）
  const keep = [{ label: 'x', scope: 'startup' }];
  mergePausedTasks(keep, { pausedTasks: [{ label: 'y', scope: 'startup' }] });
  assert.equal(keep.length, 1, 'mergePausedTasks 不许改动入参');

  // ⑥ 四条文案在中英两块里各有一条（漏了英文 = 英文界面弹中文）
  for (const key of Object.keys(KEYS)) {
    const hits = i18nSrc.split("'" + key + "'").length - 1;
    assert.equal(hits, 2, key + ' 要在中英两块里各有一条（实际 ' + hits + ' 条）');
  }

  // ⑦ 「已等 N 秒」这一行是「卡死」那条报错的正面对治：校验要把新位置那份副本**整份读完**，
  //    真库 18 GB 实测 **5 分 19 秒**。只写「正在检查新位置的数据…」放五分钟，用户唯一能
  //    得出的结论就是「它死了」（他报的原话就是这个）。所以：
  //     · 秒数必须真的画得出来 ⇒ 用户会盯着它走；
  //     · 唯一有坑的地方是**秒 → 分 的进位边界**（59000 / 60000），所以这里抽出来真跑，
  //       而不是查字符串在不在（分支写反了字符串照样都在）。
  const fmtFn = extractFunction(appSrc, 'fmtElapsedMs');
  const fmtElapsedMs = new Function('tUiFmt', 'return (' + fmtFn + ');')((key, vars) => {
    if (key === 'settings.storage.dataDirVerifySecFmt') return 'SEC:' + vars.seconds;
    if (key === 'settings.storage.dataDirVerifyMinFmt') return 'MIN:' + vars.minutes + ':' + vars.seconds;
    return '?' + key;
  });
  assert.equal(fmtElapsedMs(0), 'SEC:0', '刚进校验阶段要能显示 0 秒（否则第一秒空白，还是像卡住）');
  assert.equal(fmtElapsedMs(999), 'SEC:1');
  assert.equal(fmtElapsedMs(59000), 'SEC:59', '59 秒还是秒级，不许提前进位到分');
  assert.equal(fmtElapsedMs(60000), 'MIN:1:0', '整分钟要进位');
  assert.equal(fmtElapsedMs(319000), 'MIN:5:19', '真库实测那 5 分 19 秒要如实写出来');
  assert.equal(fmtElapsedMs(undefined), 'SEC:0', '没有读数时不许写成 NaN 秒');
  assert.equal(fmtElapsedMs(NaN), 'SEC:0', 'NaN 也不许漏出去');
  assert.equal(fmtElapsedMs(-5000), 'SEC:0', '时钟回拨也不许出负数');
  // 调用点也要归一：NaN 只允许降级成「不显示秒数」，绝不能变成「已等 NaN 分 NaN 秒」
  assert.match(
    appSrc,
    /var verifyMs = Number\(p\.verifyMs\) \|\| 0;/,
    '调用点要先把 verifyMs 归一（漏了 = 一个读不到的读数就写成 NaN 秒）',
  );
  // 展示秒数的那条分支必须真的用上它（用了才算「走字」）
  assert.match(
    appSrc,
    /dataDirPhaseVerifyFmt',\s*\n\s*\{ elapsed: fmtElapsedMs\(verifyMs\) \}/,
    'verify 阶段要把「已等 N 秒」拼进那行文字里',
  );
}

/**
 * 「副本判定」这一层：`judgeCopy` 是**判据唯一源**，同步取数（`verifySqliteFile`）与
 * worker 取数（`src/workers/db-verify-worker.js`）两条路都调它 —— 所以它必须逐分支被钉死。
 */
function testJudgeCopy() {
  assert.equal(typeof dataDir.judgeCopy, 'function', 'judgeCopy 必须在导出面（两条取数路共用它）');

  // 全通过
  const ok = dataDir.judgeCopy({
    verdict: 'ok',
    photoCount: 120,
    expectPhotoCount: 120,
    fileSize: 4096 * 10,
    declaredBytes: 4096 * 10,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.photoCount, 120);

  // ① 结构坏
  const corrupt = dataDir.judgeCopy({ verdict: '*** in database main ***\nPage 3 is never used', photoCount: 1 });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.code, 'CORRUPT');

  // ② 行数不一致（结构完好但少了最后一次提交 —— 迁移最怕的静默丢数据）
  const short = dataDir.judgeCopy({ verdict: 'ok', photoCount: 119, expectPhotoCount: 120 });
  assert.equal(short.ok, false);
  assert.equal(short.code, 'COUNT_MISMATCH');
  // 不传对照值就不参与这一道（取不到源库行数时不许把它当成失败）
  assert.equal(dataDir.judgeCopy({ verdict: 'ok', photoCount: 119, expectPhotoCount: null }).ok, true);

  // ③ 文件被截断：靠**页头里声明的**应有字节数判，连库都不用打开
  const truncated = dataDir.judgeCopy({
    verdict: 'ok',
    photoCount: 120,
    expectPhotoCount: 120,
    fileSize: 4096 * 9, // 比它自己声称的少一页
    declaredBytes: 4096 * 10,
  });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.code, 'TRUNCATED', '文件比它自己声称的短 ⇒ 判截断');
  // 这一道单独也是唯一源（worker 在 open 之前就用它做预检）
  assert.equal(typeof dataDir.judgeCopySize, 'function');
  assert.equal(dataDir.judgeCopySize(4096, 8192).code, 'TRUNCATED');
  assert.equal(dataDir.judgeCopySize(8192, 8192).ok, true);
  assert.equal(dataDir.judgeCopySize(8192, null).ok, true, '声明不可信 ⇒ 跳过，不许判死');
  assert.equal(dataDir.judgeCopySize(0, 0).ok, true, '非法声明 ⇒ 跳过');
  // ⚠️ 缺 verdict（结构检查这一道没做）**不许**当通过：关键路径上「不知道」只能算没通过
  assert.equal(
    dataDir.judgeCopySize(8192, 8192).ok && dataDir.judgeCopy({ fileSize: 8192, declaredBytes: 8192 }).code,
    'CORRUPT',
    '没做结构检查时不许判通过',
  );
  // ⚠️ 只判「短」：多出来的尾巴（对齐、旧页残留）**不是**错，判成错会把好副本拦下
  assert.equal(
    dataDir.judgeCopy({
      verdict: 'ok',
      photoCount: 1,
      fileSize: 4096 * 11,
      declaredBytes: 4096 * 10,
    }).ok,
    true,
    '文件比声明的大不算错（尾巴无害）',
  );
  // 声明不可信（null）时跳过这一道，不能因此判死
  assert.equal(
    dataDir.judgeCopy({ verdict: 'ok', photoCount: 1, fileSize: 10, declaredBytes: null }).ok,
    true,
    '声明不可信时不许误判',
  );
  // 空/缺字段的调用不许抛（worker 那条路是「取到什么算什么」）
  assert.equal(dataDir.judgeCopy({}).ok, false, '没有任何结论时不许算通过');
  assert.equal(dataDir.judgeCopy(null).ok, false);
  // 🔴 自证一次「按 pragma 判截断是恒真的」：SQLite 的 `PRAGMA page_count` 是按**文件大小**
  //    推出来的，所以拿 page_count × page_size 与文件大小比永远相等 —— 那就是个恒真式。
  //    真正携带声明的是页头第 28~31 字节（见 readSqliteHeader）。这条断言把这点钉住，
  //    免得哪天有人「简化」回去。
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'data-dir.js'), 'utf8'),
    /真正携带「这个库应该有 N 页」这个\*\*声明\*\*的，是页头第 28~31 字节/,
    'readSqliteHeader 的长注释要留着（它是「为什么不能用 pragma 判截断」的唯一现场）',
  );
}

/** 页头解析本身：真文件上「声明字节数」必须等于文件大小；截断/坏魔数各有明确结论。 */
function testReadSqliteHeader() {
  assert.equal(typeof dataDir.readSqliteHeader, 'function');

  const dir = tmpDir('header');
  const dbFile = path.join(dir, 'ok.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbFile);
  db.exec('CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT)');
  db.prepare('INSERT INTO photos (id, file_path) VALUES (1, ?)').run('C:/nope/1.jpg');
  db.close();

  const h = dataDir.readSqliteHeader(dbFile);
  assert.equal(h.ok, true, '新库的页头要可读且页数可信：' + JSON.stringify(h));
  assert.equal(h.fileSize, fs.statSync(dbFile).size);
  assert.equal(
    h.declaredBytes,
    h.fileSize,
    '干净关闭的库：页头声明的字节数要正好等于文件大小（真库实测同样相等）',
  );
  assert.equal(h.pageSize, h.declaredBytes / h.pageCount);

  // 截断到一半：页头还在（它有声明），所以「文件比自己声明的短」要能被判出来
  const cut = path.join(dir, 'cut.db');
  fs.copyFileSync(dbFile, cut);
  fs.truncateSync(cut, Math.floor(h.fileSize / 2));
  const hc = dataDir.readSqliteHeader(cut);
  assert.equal(hc.ok, true, '截断后页头仍在（这就是为什么预检必须在 open 之前）');
  assert.ok(hc.declaredBytes > hc.fileSize, '声明 > 实际 ⇒ 判得出截断');
  assert.equal(
    dataDir.judgeCopy({
      verdict: null,
      photoCount: 0,
      expectPhotoCount: null,
      fileSize: hc.fileSize,
      declaredBytes: hc.declaredBytes,
    }).code,
    'TRUNCATED',
  );

  // 空文件 / 不是 SQLite：不许抛，且**不许**给出可信声明（否则会误判）
  const empty = path.join(dir, 'empty.db');
  fs.writeFileSync(empty, Buffer.alloc(10));
  const he = dataDir.readSqliteHeader(empty);
  assert.equal(he.ok, false);
  assert.equal(he.declaredBytes, null, '读不出可信声明时必须给 null（调用方据此跳过这一道）');
  assert.equal(he.reason, 'too-small');

  const notDb = path.join(dir, 'not.db');
  fs.writeFileSync(notDb, Buffer.alloc(4096, 7));
  const hn = dataDir.readSqliteHeader(notDb);
  assert.equal(hn.ok, false);
  assert.equal(hn.declaredBytes, null);
  assert.equal(hn.reason, 'bad-magic');

  const missing = dataDir.readSqliteHeader(path.join(dir, 'nope.db'));
  assert.equal(missing.ok, false);
  assert.equal(missing.declaredBytes, null, '文件不存在也要给 null，而不是抛出去');
  assert.equal(missing.fileSize, 0);
}

/**
 * 校验 worker **真跑一遍**（不是读源码）：小库通过、被截断的库在 header 阶段就判死。
 *
 * 🔴 为什么要连 worker 一起跑：它是把 `PRAGMA quick_check` 搬出主线程的那一半，
 *    而「搬出去」这个动作本身会引入新的失败面 —— 起不来、抛错、没留结果就退出。
 *    这些路径的共同要求是同一句话：**宁可说不知道，也不许返回 ok**。
 */
async function testVerifyWorker() {
  const { Worker } = require('node:worker_threads');
  const workerPath = path.join(__dirname, '..', 'src', 'workers', 'db-verify-worker.js');
  const Database = require('better-sqlite3');

  const dir = tmpDir('verify-worker');
  const dbFile = path.join(dir, 'photos.db');
  const db = new Database(dbFile);
  db.exec('CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT)');
  const ins = db.prepare('INSERT INTO photos (id, file_path) VALUES (?, ?)');
  const fill = db.transaction(() => {
    for (let i = 1; i <= 50; i++) ins.run(i, 'C:/nope/' + i + '.jpg');
  });
  fill();
  db.close();
  const fullSize = fs.statSync(dbFile).size;

  const runWorker = (dbPath, expectPhotoCount) =>
    new Promise((resolve, reject) => {
      const w = new Worker(workerPath, { workerData: { dbPath, expectPhotoCount } });
      let result = null;
      w.on('message', (m) => {
        if (m && !m.__phase) result = m;
      });
      w.on('error', reject);
      w.on('exit', () => (result ? resolve(result) : reject(new Error('worker 没留结果就退出'))));
    });

  // ① 好副本：通过，且带回行数
  const good = await runWorker(dbFile, 50);
  assert.equal(good.ok, true, '好副本要判通过：' + JSON.stringify(good));
  assert.equal(good.photoCount, 50);
  assert.equal(good.verdict, 'ok');
  assert.ok(good.quickCheckMs >= 0 && good.countMs >= 0, '要把各段耗时带回来（排查「为什么慢」的唯一现场）');

  // ② 行数对照不上一律不过
  const short = await runWorker(dbFile, 51);
  assert.equal(short.ok, false);
  assert.equal(short.code, 'COUNT_MISMATCH');

  // ③ 被截断的副本：必须在**读页头**那一步就判死 —— 别为了发现它坏再读一遍整库
  const cut = path.join(dir, 'cut.db');
  fs.copyFileSync(dbFile, cut);
  fs.truncateSync(cut, Math.floor(fullSize / 2));
  const truncated = await runWorker(cut, 50);
  assert.equal(truncated.ok, false, '截断的副本不许算通过');
  assert.equal(truncated.code, 'TRUNCATED');
  assert.equal(
    truncated.quickCheckMs,
    undefined,
    '截断要在 quick_check 之前判死（它自己那条消息里不该有 quickCheckMs）',
  );
  assert.ok(
    Number(truncated.elapsedMs) < 5000,
    '截断判定必须是毫秒级（真库上是 103 ms vs 5 分 19 秒），实际 ' + truncated.elapsedMs + ' ms',
  );

  // ④ 文件不存在 ⇒ 不许通过（这条最像会静默放行的那种）
  const missing = await runWorker(path.join(dir, 'nope.db'), 0);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'UNREADABLE');

  // ⑤ 接线：迁移必须走 worker 版，**不许**再回到主进程同步校验
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const migrateAt = mainSrc.indexOf('async function runDataDirMigration(');
  const migrateBlock = mainSrc.slice(migrateAt, migrateAt + 9000);
  assert.match(
    migrateBlock,
    /await verifyCopiedLibrary\(/,
    '迁移必须等 worker 版的校验（同步版会把主线程占住 5 分钟 = 用户报的「卡死」）',
  );
  assert.equal(
    /dataDirLib\.verifySqliteFile\(/.test(migrateBlock),
    false,
    '迁移路径里不许再出现主进程同步校验',
  );
  assert.match(
    mainSrc,
    /function verifyCopiedLibrary\(/,
    'worker 版的校验函数要在 main.js 里（起不来时退回同步版）',
  );
  // 🔴 进度字段是白名单拼装的：`verifyMs` 漏了 = 校验那 5 分钟界面一个字都不动
  assert.match(
    mainSrc,
    /verifyMs: Number\(dataDirMigration\.verifyMs\)/,
    'emitDataDirProgress 的白名单里必须有 verifyMs',
  );
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(appSrc, /function fmtElapsedMs\(/, '渲染端要把「已等多久」写出来');
  assert.match(appSrc, /dataDirPhaseVerifyFmt/, '校验阶段要用带秒数的那条文案');
  const i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  for (const key of [
    'settings.storage.dataDirPhaseVerifyFmt',
    'settings.storage.dataDirVerifySecFmt',
    'settings.storage.dataDirVerifyMinFmt',
  ]) {
    const hits = i18nSrc.split("'" + key + "'").length - 1;
    assert.equal(hits, 2, key + ' 要在中英两块里各有一条（实际 ' + hits + ' 条）');
  }
}

function testSourceContracts() {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(mainSrc, /require\('\.\/main\/data-dir'\)/, 'main.js 必须接线这个模块');
  assert.match(mainSrc, /ipcMain\.handle\('migrate-data-dir'/, '要有迁移通道');
  assert.match(mainSrc, /ipcMain\.handle\('get-data-dir-info'/, '要有读数通道');
  assert.match(mainSrc, /ipcMain\.handle\('select-data-dir'/, '要有选目录通道');
  // 「改设置」必须发生在「校验通过」之后：顺序反了会把用户指向一个坏库
  //
  // 🔴 **这里曾经钉的是 `dataDirLib.verifySqliteFile`（假绿现场，别再回去）**：
  //    校验搬进 worker 之后，那个名字在 main.js 里第一次出现的位置变成了
  //    `verifyCopiedLibrary` 内部的**退回分支**（是函数体，位置在迁移函数之前）——
  //    于是这条断言退化成「某个函数定义在写设置之前」，恒真。
  //    **把校验调用整段挪到写设置之后，它照样全绿**。改成钉迁移里那次真实调用。
  const settingsWriteAt = mainSrc.indexOf("settings[dataDirLib.SETTING_KEY] = targetDir");
  const verifyCallAt = mainSrc.indexOf('await verifyCopiedLibrary(');
  assert.ok(verifyCallAt > 0, '迁移里要有那次真实校验调用（await verifyCopiedLibrary(...)）');
  assert.ok(
    settingsWriteAt > verifyCallAt,
    '副本校验通过后才允许改设置（钉的是那次校验调用，不是同步版的函数定义）',
  );
  // 删旧文件也必须在改设置之后（先删后改 = 中间态里两边都没有完整数据）
  const removeAt = mainSrc.indexOf('removeSourceEntries');
  assert.ok(removeAt > settingsWriteAt, '先改设置、再删旧文件');
  // 🔴 复制/删除用的清单必须**关库之后重新盘点**：体检时量到的 `photos.db-wal` 会在
  //    wal_checkpoint(TRUNCATE) 之后消失，照体检清单复制会在第一条就 ENOENT。
  const releaseAt = mainSrc.indexOf('releaseRuntimeHandlesForMigration()');
  const relistAt = mainSrc.indexOf('var copyEntries = dataDirLib.listEntries');
  assert.ok(releaseAt > 0, '要有「放开数据库连接」这一步');
  assert.ok(relistAt > releaseAt, '关库之后必须重新盘点条目，不能沿用体检时的清单');
  assert.ok(
    mainSrc.indexOf('removeSourceEntries(fromDir, copyEntries') > relistAt,
    '删旧文件用的也是重新盘点后的清单',
  );
  // 🔴 「暂时被挡住」的返回值必须带可判定的 code：调用方（以及端到端探针）要据此**重试**，
  //    而判据如果钉在文案上，改一次说法就会静默失效（实测发生过：7 项断言一起红，
  //    看着像迁移坏了）。带 code 之后文案怎么改都不影响判定。
  assert.match(
    mainSrc,
    /maintenanceBusy\(\)\)\s*\n?\s*return withPaused\(\{\s*\n?\s*success: false,\s*\n?\s*code: 'BUSY'/,
    '被写库闸门挡住时返回 code: \'BUSY\'（调用方靠重试，别让它去读文案）',
  );
  assert.match(
    mainSrc,
    /dataDirMigration\.running\)\s*\n?\s*return \{ success: false, code: 'BUSY'/,
    '「已经在迁移中」也要带 BUSY code',
  );
  // 校验失败要把 validateTarget 的 code 透出来（EMPTY / SAME / INSIDE）——
  // 界面按 code 取本地化文案，主进程的 error 原文只有中文。
  assert.match(mainSrc, /if \(!check\.ok\) return \{ success: false, code: check\.code/, '校验失败要透传 code');
  // 选目录通道同样要带 code：主进程的拒绝理由只有中文，英文界面照收（真实缺陷）。
  assert.match(mainSrc, /code: check\.code \|\| ''/, 'select-data-dir 要把 check.code 带回去');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const i18nSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  for (const code of ['EMPTY', 'SAME', 'INSIDE', 'OCCUPIED'])
    assert.match(
      appSrc,
      new RegExp(code + ": 'settings\\.storage\\.dataDirErr"),
      '渲染端要按 ' + code + ' 取本地化文案，不能直接显示主进程的中文原文',
    );
  // 🔴 「被写库闸门挡住」必须是**等待 + 重试**，不是报「迁移没有完成」：
  //    启动后十几秒里几乎必然撞上一次（启动期的失效记录清理 / 索引补齐），照着失败报，
  //    用户看到的是「迁移坏了」，而其实什么都没发生（实测踩过）。
  //    判据按 `code`，不按文案 —— 文案已经改过一次，按文案写的调用方当场静默失效。
  assert.match(appSrc, /r\.code !== 'BUSY'/, '渲染端要按 code 识别「被闸门挡住」');
  assert.match(appSrc, /attempt >= BUSY_RETRY_MAX/, '自动重试要有上限（长任务不该让界面无限转）');
  assert.match(
    appSrc,
    /settings\.storage\.dataDirBusyWaitFmt/,
    '等待期间要如实报出「在等谁、等了多久」',
  );
  assert.match(
    appSrc,
    /settings\.storage\.dataDirBusyGiveUpFmt/,
    '等满上限要说清怎么继续，而不是报失败',
  );
  for (const key of [
    'settings.storage.dataDirBusyWaitFmt',
    'settings.storage.dataDirBusyGiveUpFmt',
    'settings.storage.dataDirConfirmSubdirFmt',
  ]) {
    const hits = i18nSrc.split("'" + key + "'").length - 1;
    assert.equal(hits, 2, key + ' 要在中英两块里各有一条（实际 ' + hits + ' 条）');
  }

  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const channel of ['getDataDirInfo', 'selectDataDir', 'migrateDataDir', 'onDataDirMigrateProgress']) {
    assert.match(preloadSrc, new RegExp(channel), 'preload 要暴露 ' + channel);
  }

  // 条目清单必须包含 AI 索引：只搬主库会留下「索引在旧盘、主库在新盘」的两处状态
  assert.ok(dataDir.DATA_ENTRY_NAMES.includes('ai-search'), 'AI 搜图索引要一起搬');
  assert.ok(dataDir.DATA_ENTRY_NAMES.includes('face-index'), '人脸索引要一起搬');
  assert.ok(dataDir.DATA_ENTRY_NAMES.includes('photos.db-wal'), 'WAL 是条件条目，也得在清单里');
  assert.equal(dataDir.DATA_ENTRY_NAMES.includes('settings.json'), false, 'settings.json 永不在清单里');
}

async function main() {
  testValidateTarget();
  testListAndPlan();
  await testCopyAndVerify();
  await testRemoveSource();
  testResolveTargetDir();
  testActiveDataDirForProbes();
  testReadSqliteHeader();
  testJudgeCopy();
  await testVerifyWorker();
  testPausedCleanupContract();
  testSourceContracts();
  console.log('data-dir-regression: PASS');
}

main().catch((error) => {
  console.error('data-dir-regression: FAIL');
  console.error(error);
  process.exit(1);
});
