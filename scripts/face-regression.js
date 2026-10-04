'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const { FaceStore, chineseWhispers, K_NEIGHBORS } = require('../src/ai/face-store');
const { FaceService } = require('../src/main/face-service');
const {
  TEMPLATE,
  VERSION,
  VERSION_LABEL,
  VECTOR_DIM,
  PACK_BYTES,
  DETECT_CANVAS,
  REFINE_MARGIN,
  alignment,
  normalize,
  pack,
  unpack,
  readZipEntry,
  scaleFace,
  refineRegion,
  nearestPoints,
} = require('../src/ai/face-model');

/**
 * `summary()` 的形状断言。
 *
 * 刻意用 `deepEqual` 比**整个对象**，而不是挑几个字段比：这个对象的每一格都是契约 ——
 * 界面的「人物页为什么是空的」完全靠 `staleScans` / `staleVersions` / `recognizer` /
 * `library` 四格才说得清。少任何一格，那一屏就会退回「0 个人物 + 一句『还没有识别到人物』」，
 * 而这正是本轮修的坑（库里 16155 条 v1 记录、3501 张脸，界面却像数据丢了）。
 * 所以**给 `summary()` 加字段必须手改这里**，不能让它悄悄漏出去。
 *
 * `staleScans` / `staleVersions` 默认 0 / 空（新夹具没有旧记录），要造旧记录就覆盖它们。
 */
function expectSummary(store, expected) {
  const summary = store.summary();
  assert.deepEqual(summary, {
    recognizer: VERSION_LABEL,
    version: VERSION,
    staleScans: 0,
    staleVersions: [],
    ...expected,
  });
  return summary;
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-face-test-'));
  let source, store, service;
  try {
    const dbPath = path.join(directory, 'photos.db'),
      indexPath = path.join(directory, 'faces.sqlite');
    source = new Database(dbPath);
    source.pragma('journal_mode = WAL');
    source.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT, file_type TEXT,
      file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER, has_thumbnail INTEGER, is_favorite INTEGER)`);
    function photo(n) {
      return {
        id: n,
        file_name: n + '.jpg',
        file_path: '/fixtures/' + n + '.jpg',
        file_size: 10,
        date_modified: '2026-09-27',
      };
    }
    for (let i = 1; i <= 30; i++)
      source
        .prepare('INSERT INTO photos VALUES (?, ?, ?, ?, 10, ?, NULL, 100, 100, 0, 0)')
        .run(i, photo(i).file_path, photo(i).file_name, 'jpg', photo(i).date_modified);
    function face(axis) {
      const v = new Float32Array(VECTOR_DIM);
      v[axis] = 1;
      return { vector: normalize(v), thumbnail: Buffer.from('fixture'), box: [0, 0, 1, 1] };
    }
    const transform = alignment(TEMPLATE.map(([x, y]) => [x * 2 + 10, y * 2 + 20]));
    assert.ok(Math.abs(transform.a - 2) < 1e-6 && Math.abs(transform.b) < 1e-6);
    assert.ok(Math.abs(transform.x - 10) < 1e-6 && Math.abs(transform.y - 20) < 1e-6);
    // 维度是 512（InsightFace w600k_mbf）。旧的 SFace 是 128 —— 那批向量仍在磁盘上，
    // 归一化与解包都必须**拒绝**它们，而不是把 128 个数硬当成 512 维读下去
    // （那样相似度会一路算成 NaN，在归组结果上完全看不出来）。
    assert.equal(VECTOR_DIM, 512);
    assert.equal(PACK_BYTES, 2048);
    assert.throws(() => normalize(new Float32Array(128)), /INVALID/);
    assert.throws(() => unpack(Buffer.alloc(512)), /INVALID/, '旧 SFace 的 512 字节向量必须被拒');
    const roundTrip = normalize(Float32Array.from({ length: VECTOR_DIM }, (_, i) => i % 7));
    assert.ok(Math.abs(roundTrip[3] - unpack(pack(roundTrip))[3]) < 1e-6, 'pack/unpack 必须能往返');
    assert.equal(pack(roundTrip).length, PACK_BYTES);
    assert.throws(() => pack(new Float32Array(128)), /INVALID/);
    // ZIP 解包（InsightFace 只在 GitHub Release 上发整包，没有单文件直链）。
    // 夹具自己造一个 store + deflate 两种方法的包 —— 偏移量写错会静默读出垃圾字节。
    {
      const build = (entries) => {
        const parts = [];
        const central = [];
        let offset = 0;
        for (const { name, data, method } of entries) {
          const body = method === 8 ? zlib.deflateRawSync(data) : data;
          const label = Buffer.from(name, 'utf8');
          const local = Buffer.alloc(30 + label.length);
          local.writeUInt32LE(0x04034b50, 0);
          local.writeUInt16LE(20, 4);
          local.writeUInt16LE(method, 8);
          local.writeUInt32LE(body.length, 18);
          local.writeUInt32LE(data.length, 22);
          local.writeUInt16LE(label.length, 26);
          label.copy(local, 30);
          parts.push(local, body);
          const head = Buffer.alloc(46 + label.length);
          head.writeUInt32LE(0x02014b50, 0);
          head.writeUInt16LE(20, 4);
          head.writeUInt16LE(20, 6);
          head.writeUInt16LE(method, 10);
          head.writeUInt32LE(body.length, 20);
          head.writeUInt32LE(data.length, 24);
          head.writeUInt16LE(label.length, 28);
          head.writeUInt32LE(offset, 42);
          label.copy(head, 46);
          central.push(head);
          offset += local.length + body.length;
        }
        const directory = Buffer.concat(central);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(entries.length, 8);
        end.writeUInt16LE(entries.length, 10);
        end.writeUInt32LE(directory.length, 12);
        end.writeUInt32LE(offset, 16);
        return Buffer.concat([...parts, directory, end]);
      };
      const stored = Buffer.from('det_500m 的内容');
      const deflated = Buffer.from('w600k_mbf 的内容'.repeat(20));
      const archive = build([
        { name: 'det_500m.onnx', data: stored, method: 0 },
        { name: 'w600k_mbf.onnx', data: deflated, method: 8 },
      ]);
      assert.ok(readZipEntry(archive, 'det_500m.onnx').equals(stored), 'store 条目要能原样取出');
      assert.ok(readZipEntry(archive, 'w600k_mbf.onnx').equals(deflated), 'deflate 条目要能解开');
      assert.throws(() => readZipEntry(archive, 'nope.onnx'), /ARCHIVE_ENTRY/);
      assert.throws(() => readZipEntry(Buffer.alloc(64), 'w600k_mbf.onnx'), /ARCHIVE_INVALID/);
    }
    // 局部复核（coarse → refine）的几何。这里守着两个已经踩过的坑：
    //   ① 漏映 x / y（只映 w / h 与关键点）→ 复核区域裁到别处，实测损失大半张脸；
    //   ② 用一个比例换算横纵 → 关键点整体被拉偏（区域是按自身长宽比字母框的，横纵比例不等）。
    // 复核本身把配对级 AUC 从 0.788/0.806 抬到 0.875/0.902（真库实测，见 docs/people-groups.md），
    // 但它靠的就是这套坐标换算，换算错了会**静默**退化成"关键点乱指"，所以必须钉死。
    assert.equal(DETECT_CANVAS, 640, 'decode() 假定画布边长就是 DETECT_CANVAS');
    // 画布 → 中间图：整张脸都要映，横纵各用各的比例。
    assert.deepEqual(scaleFace({ x: 10, y: 20, w: 30, h: 40, points: [[1, 2]] }, 2, 3), {
      x: 20,
      y: 60,
      w: 60,
      h: 120,
      points: [[2, 6]],
    });
    const region = refineRegion({ x: 100, y: 100, w: 40, h: 50 }, 1000, 1000);
    assert.deepEqual(region, { left: 84, top: 80, width: 72, height: 90 });
    assert.equal(region.width, 40 * REFINE_MARGIN, '复核区域按 REFINE_MARGIN 外扩');
    assert.equal(region.height, 50 * REFINE_MARGIN);
    assert.deepEqual(
      refineRegion({ x: 0, y: 0, w: 40, h: 50 }, 1000, 1000),
      { left: 0, top: 0, width: 56, height: 70 },
      '贴边的脸要夹到图内',
    );
    const subject = { x: 100, y: 100, w: 40, h: 50 };
    const refineCandidate = (x, y) => ({
      x: x - 5,
      y: y - 5,
      w: 10,
      h: 10,
      points: Array.from({ length: 5 }, () => [x, y]),
    });
    const ratioX = region.width / DETECT_CANVAS;
    const ratioY = region.height / DETECT_CANVAS;
    // 画布中心 (320,320) 恰好映回脸中心 (120,125)；用一个比例算 y 会得到 116。
    assert.deepEqual(
      nearestPoints(subject, [refineCandidate(320, 320)], region, ratioX, ratioY),
      Array.from({ length: 5 }, () => [120, 125]),
    );
    // 离得太远的候选不采纳：宁可保留粗定位关键点，也不要把对齐锚到别人脸上。
    assert.equal(nearestPoints(subject, [refineCandidate(640, 640)], region, ratioX, ratioY), null);
    assert.equal(nearestPoints(subject, [], region, ratioX, ratioY), null);
    store = new FaceStore(dbPath, indexPath);
    const reps = store.representatives();
    store.put(photo(1), [face(0)], reps);
    store.put(photo(2), [face(0)], reps);
    store.put(photo(3), [face(1)], reps);
    store.put(photo(4), [], reps);
    // library 是覆盖率的**分母**（全库照片数），所以它跟着 photos 表走而不是跟着索引走。
    expectSummary(store, { faces: 3, people: 2, indexed: 4, library: 30 });
    // 索引进度用的轻量计数：scanned / faces / people 三个数字要跟同一批数据对得上，
    // 人物页的实时条就是靠它显示「已扫描 N 张 · 检出 M 张脸 · K 人」。
    assert.deepEqual(store.counts(), { scanned: 4, faces: 3, people: 2 });
    assert.equal(store.batch(0)[0].id, 5, 'no-face photos are also incrementally skipped');
    const groups = store.groups().items;
    const first = groups[0].id,
      second = groups[1].id;
    store.rename(first, ' 家人 <test> ');
    assert.equal(store.groups().items[0].name, '家人 <test>');
    assert.throws(() => store.rename(first, 'x'.repeat(81)), /INVALID/);
    const faceId = store.photos(first).items[0].faceId;
    const detached = store.move(faceId, null).personId;
    assert.notEqual(detached, first);
    assert.equal(store.photos(detached).items.length, 1);
    store.merge(detached, first);
    assert.equal(store.photos(first).items.length, 2);
    assert.throws(() => store.merge(first, first), /SAME/);
    assert.throws(() => store.move(faceId, 999), /MISSING/);
    store.close();
    store = new FaceStore(dbPath, indexPath);
    assert.equal(store.groups().items[0].name, '家人 <test>', 'manual edits survive reopen');
    source.prepare('DELETE FROM photos WHERE id = 1').run();
    source.prepare('UPDATE photos SET file_size = 11 WHERE id = 2').run();
    assert.equal(store.photos(first).items.length, 0, 'deleted and modified photos hidden');
    assert.deepEqual(
      store.groups().items.map((g) => g.id),
      [second],
    );
    // 轻量计数只查索引库自身、不做与 photos 的指纹校验，所以照片没了它仍然偏大；
    // 索引收尾由 summary() 的校验结果兜正（人物页结束后取的是后者，不是这个）。
    assert.deepEqual(store.counts(), { scanned: 4, faces: 3, people: 2 });
    assert.equal(store.summary().faces, 1, 'summary 仍以能对上 photos 的指纹为准');
    // 覆盖率的分母是**当前**全库照片数（上面刚删掉一张），所以要跟着 photos 表走；
    // 沿用上一轮的值会让「已索引 / 全库」永远停在旧分母上，看不出索引铺了多大一片。
    assert.equal(store.summary().library, 29, '覆盖率分母跟随 photos 表变化');

    // ---- 旧识别器的残留：界面靠这两格才能说清「人物页为什么是空的」 ----
    // 换识别器（VERSION 一变）之后，库里那一代记录会被 VALID 的 `s.version = ?` 全部挡掉，
    // 于是 faces / people / indexed 一起归零 —— 与「从没建过索引」在数字上**完全一样**。
    // 实测踩过：16155 条 v1（SFace）记录 + 3501 张脸躺在 faces.sqlite 里，界面只报
    // 「0 个人物」，用户能得出的唯一结论是「数据丢了」。所以这几条断言必须有牙齿。
    // 直接 new 而不是走下面的 `isolated()`：那个工厂定义在后面（`const` 有 TDZ），
    // 而这一组断言要贴着上面「照片被删 / 被改」的上下文放，才看得出分母在跟着变。
    const staleStore = new FaceStore(dbPath, path.join(directory, 'stale-faces.sqlite'));
    // 指纹三项（file_path / file_size / date_modified）**故意造得完全正确** —— 这样它落选
    // 就只可能是因为 version 对不上，而不是被别的条件顺带挡掉（那样断言会假通过）。
    const insertScan = (photoId, version) =>
      staleStore.db
        .prepare(
          'INSERT INTO scans(photo_id, file_path, file_size, date_modified, version) VALUES (?, ?, ?, ?, ?)',
        )
        .run(photoId, photo(photoId).file_path, 10, photo(photoId).date_modified, version);
    insertScan(20, 'yunet2023-sface2021-align112-v1');
    insertScan(21, 'plain-unknown-version-v9');
    const stale = staleStore.summary();
    assert.equal(stale.indexed, 0, '旧版本的 scans 一条都不算「已索引」');
    assert.equal(stale.faces, 0, '旧版本的记录不会变成人脸数');
    assert.equal(stale.staleScans, 2, '旧版本的记录必须被单独数出来');
    assert.equal(stale.library, 29, '分母仍是全库照片数，与旧记录无关');
    // 认得出的版本给人话标签；认不出的**回落到版本原文**，绝不猜一代去骗用户。
    assert.deepEqual(
      Object.fromEntries(stale.staleVersions.map((item) => [item.version, item.label])),
      {
        'yunet2023-sface2021-align112-v1': 'OpenCV SFace (128-d)',
        'plain-unknown-version-v9': 'plain-unknown-version-v9',
      },
      'staleVersions 要带人话标签，认不出的回落原文',
    );
    // 索引一开始 purgeStale() 会把它们清掉（faces 由外键 CASCADE 带走），清完这一格归零 ——
    // 界面据此把「需要重建」那条告警收起来。
    assert.equal(staleStore.purgeStale(), 2, 'purgeStale 清掉全部非当前版本的行');
    assert.equal(staleStore.summary().staleScans, 0, 'purgeStale 之后不再有旧记录');
    // 实时读数里的「人物」必须只数**还有当前版本人脸**的人。
    // `purgeStale()` 清不掉 `people` —— 它只删 `scans`（faces 靠外键 CASCADE 走），
    // 「人脸已经没了」的空组要等收尾 `regroup()` 才被清，而全库规模下收尾聚类会被
    // `AUTO_REGROUP_LIMIT`(8000) 跳过。不这么数的话，跑三天的索引里那条读教会一直挂着
    // 上一代识别器的组数（本机实测 2273，而当时真实人物只有 11），用户看不出人物在增长。
    const orphanPerson = staleStore.db
      .prepare("INSERT INTO people(name, name_source, folder_key) VALUES ('orphan', '', '')")
      .run().lastInsertRowid;
    insertScan(22, VERSION);
    const livePerson = staleStore.db
      .prepare("INSERT INTO people(name, name_source, folder_key) VALUES ('', '', '')")
      .run().lastInsertRowid;
    staleStore.db
      .prepare(
        'INSERT INTO faces(photo_id, person_id, vector, thumbnail, box) VALUES (?, ?, ?, ?, ?)',
      )
      .run(22, livePerson, Buffer.alloc(2048), Buffer.alloc(0), '[]');
    assert.notEqual(orphanPerson, livePerson, '夹具：空组与有效组是两行');
    assert.equal(
      staleStore.db.prepare('SELECT COUNT(*) n FROM people').get().n,
      2,
      '夹具：people 里是一个空组 + 一个有效组',
    );
    const liveCounts = staleStore.counts();
    assert.equal(liveCounts.people, 1, 'counts().people 不得把没有当前版本人脸的组算进去');
    assert.equal(liveCounts.faces, 1, 'counts().faces 仍是 faces 表全部');
    assert.equal(liveCounts.scanned, 1, 'counts().scanned 仍是 scans 表全部');
    staleStore.close();
    const current = store.representatives();
    for (let i = 5; i <= 30; i++) store.put(photo(i), [face(i)], current);
    const page1 = store.groups();
    const page2 = store.groups(page1.next);
    assert.equal(page1.items.length, 24);
    assert.equal(page2.items.length, 3);
    assert.equal(page2.next, null);
    assert.equal(new Set([...page1.items, ...page2.items].map((g) => g.id)).size, 27);
    assert.throws(() => store.photos('invalid'), /INVALID/);
    const candidate = face(120);
    candidate.vector[120] = 0.3;
    candidate.vector[121] = Math.sqrt(1 - 0.3 ** 2);
    // 每次传一份**独立**的代表表：`put()` 现在会把新脸并入抽样池（旧实现只在新建组时
    // 记代表，所以组代表恒等于「最早那张脸」）。共用一份表的话第二次 put 会看到
    // 「候选脸已经在组里」，平均相似度被自己拉高到 0.825，两个阈值都会合并。
    // 候选脸与组员的相似度是 0.30，两个阈值骑在它两侧（域是 [0.10, 0.40]）。
    const isolatedReference = () => new Map([[second, [face(120).vector]]]);
    store.put(photo(4), [candidate], isolatedReference(), 0.25);
    const standard = store.photos(second).items.find((p) => p.id === 4);
    assert.ok(standard, 'standard threshold groups the similar face');
    store.put(photo(4), [candidate], isolatedReference(), 0.35);
    assert.ok(
      !store.photos(second).items.some((p) => p.id === 4),
      'strict threshold keeps it separate',
    );
    store.close();
    store = null;
    service = new FaceService(dbPath, path.join(directory, 'service'));
    assert.equal((await service.refresh()).ready, false);
    /** 当前版本的出厂设置。改这里必须同时想清楚磁盘上老文件的迁移路径（见下）。 */
    const DEFAULT_SETTINGS = {
      version: 3,
      grouping: 'cluster',
      matchThreshold: 0.3,
      groupingDepth: 1,
      domainGroups: '',
      thumbnailFallback: true,
    };
    assert.deepEqual(await service.run('settings'), DEFAULT_SETTINGS);
    // 旧形状迁移：磁盘上还是 `{ grouping: 'strict' }` 的老设置不能被判成非法。
    // 两个旧预设（balanced / strict）都落到**新默认阈值**而不是当年的 0.6 / 0.7：
    // 那两档属于旧量纲（与组内第一张脸比），照搬到新量纲（与组内抽样成员的**平均**比）
    // 大约等于「几乎不合并」，正是本版要修的症状。
    await service.run('saveSettings', { grouping: 'strict', thumbnailFallback: false });
    assert.deepEqual(await service.run('settings'), {
      ...DEFAULT_SETTINGS,
      thumbnailFallback: false,
    });
    await service.run('saveSettings', { grouping: 'balanced', thumbnailFallback: true });
    assert.deepEqual(await service.run('settings'), DEFAULT_SETTINGS);
    // 归组方式只认 cluster / folder / scoped，其余值**归一为 cluster 而不是报错** ——
    // 报错会让老设置的 'balanced' / 'strict' 把用户卡在设置页。
    for (const grouping of ['invalid', 'balanced', 'strict', undefined]) {
      await service.run('saveSettings', { grouping, thumbnailFallback: true });
      assert.equal(
        (await service.run('settings')).grouping,
        'cluster',
        '非法归组方式 ' + JSON.stringify(grouping) + ' 应归一为 cluster',
      );
    }
    for (const grouping of ['folder', 'scoped']) {
      await service.run('saveSettings', { grouping, thumbnailFallback: true });
      assert.equal((await service.run('settings')).grouping, grouping);
    }
    // 域分组：原样保留（含大小写与顺序），只去掉空行与行首尾空白 —— 这一份要回显给用户编辑，
    // 擅自排序/去重会让人以为自己打的字被吃掉了。
    for (const [input, expected] of [
      ['116, 117', '116, 117'],
      ['  116, 117  \n\n  D:\\B  \n', '116, 117\nD:\\B'],
      ['\n\n', ''],
      ['', ''],
      [undefined, ''],
      [null, ''],
      [123, '123'],
    ]) {
      await service.run('saveSettings', {
        grouping: 'scoped',
        domainGroups: input,
        thumbnailFallback: true,
      });
      assert.equal(
        (await service.run('settings')).domainGroups,
        expected,
        '域分组 ' + JSON.stringify(input) + ' 应规范化为 ' + JSON.stringify(expected),
      );
    }
    // thumbnailFallback 缺席仍然是硬错：它是布尔开关，没有「合理默认」可言。
    await assert.rejects(
      service.run('saveSettings', { grouping: 'cluster' }),
      /SETTINGS_INVALID/,
    );
    // 越界夹紧：阈值域 [0.10, 0.50]、步长 0.01。域的下沿从 0.15 降到 0.10、上沿从
    // 0.90 收到 0.50，因为聚类换成 Chinese Whispers 后阈值是**配对级**的连边门槛，
    // 0.50 以上只会把每个人拆成一堆碎片，留着那一截等于给用户一个死区。
    for (const [input, expected] of [
      [5, 0.5],
      [-1, 0.1],
      [0.34, 0.34],
      [0.176, 0.18],
      [0.123, 0.12],
      [0.095, 0.1],
      ['', 0.3],
      ['abc', 0.3],
    ]) {
      await service.run('saveSettings', { matchThreshold: input, thumbnailFallback: true });
      assert.equal(
        (await service.run('settings')).matchThreshold,
        expected,
        '阈值 ' + JSON.stringify(input) + ' 应归一为 ' + expected,
      );
    }
    // 文件夹层级域 [1, 4]，取整；空/非法回落 1。
    for (const [input, expected] of [
      [0, 1],
      [-3, 1],
      [9, 4],
      [2, 2],
      ['2.6', 3],
      ['', 1],
      ['abc', 1],
    ]) {
      await service.run('saveSettings', {
        grouping: 'folder',
        groupingDepth: input,
        thumbnailFallback: true,
      });
      assert.equal(
        (await service.run('settings')).groupingDepth,
        expected,
        '层级 ' + JSON.stringify(input) + ' 应归一为 ' + expected,
      );
    }
    // 最关键的一条迁移：**旧磁盘文件里的 0.55 不得被照搬**。量纲变了，照搬等于
    // 「几乎不合并」，用户升级后看上去像根本没修 —— 这正是本版最容易悄悄退化的地方。
    const settingsPath = path.join(directory, 'service', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ matchThreshold: 0.55, thumbnailFallback: false }),
    );
    assert.deepEqual(
      await service.run('settings'),
      { ...DEFAULT_SETTINGS, thumbnailFallback: false },
      '没有 version 字段的旧设置必须整体迁移到新量纲的新默认值',
    );
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ grouping: 'strict', thumbnailFallback: true }),
    );
    assert.equal(
      (await service.run('settings')).matchThreshold,
      0.3,
      '旧预设也要落到新默认阈值',
    );
    await service.run('saveSettings', DEFAULT_SETTINGS);
    assert.deepEqual(await service.run('settings'), DEFAULT_SETTINGS);
    assert.equal((await service.run('groups', {})).items.length, 0);
    service.canRun = () => false;
    assert.throws(() => service.start('index'), /BUSY/);
    await assert.rejects(service.run('index'), /BUSY/);
    service.canRun = () => true;
    await assert.rejects(service.run('index'), /MODEL_MISSING/);

    // ------------------------------------------------------------------
    // 分组规则的「有牙齿」断言（用独立索引库，不扰动上面的分页 / 过滤状态）。
    // 背景：线上 1268 张真实人脸被拆成 783 个人物（70% 只有一张脸），实测根因是
    // put() 里那条 `best - second < 0.05` —— 它让最佳分 0.9x 的匹配也被判成新人物。
    // ------------------------------------------------------------------
    /** 只由若干 (轴, 系数) 构成的归一化向量：用来精确构造「相似度 = 指定值」。 */
    function mix(parts) {
      const vector = new Float32Array(VECTOR_DIM);
      for (const [axis, value] of parts) vector[axis] = value;
      return normalize(vector);
    }
    const detection = (vector) => ({
      vector,
      thumbnail: Buffer.from('fixture'),
      box: [0, 0, 1, 1],
    });
    const unit = (axis) => mix([[axis, 1]]);
    /** 新开一个只含 30 张照片的索引库（与 dbPath 同一份 photos 表，避免重复造数据）。 */
    const isolated = (label) => new FaceStore(dbPath, path.join(directory, label + '-faces.sqlite'));
    /**
     * 分组的「签名」：把每个组的成员 face.id 排序后拼起来，再整体排序。
     * 用它比较两次归组的**分组本身**是否一致——比人数更严：人数相同但成员换了组也能抓到。
     * 不能用返回的 regrouped 做这件事：它数的是「person_id 变了的张数」，
     * 把所有未命名组重建成新 id 时每张脸都算变过，即使分组结果一模一样。
     */
    const groupSignature = (store) => {
      const byPerson = new Map();
      for (const row of store.db.prepare('SELECT id, person_id FROM faces ORDER BY id').all()) {
        if (!byPerson.has(row.person_id)) byPerson.set(row.person_id, []);
        byPerson.get(row.person_id).push(row.id);
      }
      return [...byPerson.values()].map((ids) => ids.join(',')).sort().join('|');
    };

    let isolatedStore = null;
    let folderStore = null;
    let scopedStore = null;
    let scopedSource = null;
    try {
      // ① 歧义不得凭空新建人物。
      isolatedStore = isolated('ambiguous');
      // c 对 e0 相似度 0.35、对 e1 相似度 0.34：差 0.01 < 0.05，但两者都 ≥ 阈值 0.30。
      // 旧规则会把这张脸单拎成一个新人物；新规则必须把它并进相似度更高的那一组。
      const c = mix([
        [0, 0.35],
        [1, 0.34],
        [2, Math.sqrt(1 - 0.35 ** 2 - 0.34 ** 2)],
      ]);
      let reps = isolatedStore.representatives();
      isolatedStore.put(photo(5), [detection(unit(0))], reps, 0.3);
      isolatedStore.put(photo(6), [detection(unit(1))], reps, 0.3);
      isolatedStore.put(photo(7), [detection(c)], reps, 0.3);
      assert.equal(
        isolatedStore.counts().people,
        2,
        '最佳与次佳相差 0.01（但均 ≥ 阈值）时不得新建人物',
      );
      expectSummary(isolatedStore, { faces: 3, people: 2, indexed: 3, library: 29 });
      const joined = isolatedStore.groups().items.find((group) => group.faceCount === 2);
      assert.ok(joined, '第三张脸应并进某一组，而不是自成一组');
      assert.deepEqual(
        isolatedStore.photos(joined.id).items.map((item) => item.id),
        [5, 7],
        '应并进相似度最高（0.70）的那一组',
      );

      // ② 明显不同的人仍要新建人物：相似度 0 远低于阈值。
      isolatedStore.put(photo(8), [detection(unit(9))], reps, 0.3);
      assert.equal(isolatedStore.counts().people, 3, '低于阈值仍必须新建人物');

      // ③ 同一张照片里的多个检测不互相归并（该约束在删掉 margin 后依然成立）。
      isolatedStore.put(photo(9), [detection(unit(0)), detection(unit(0))], reps, 0.3);
      assert.equal(isolatedStore.counts().people, 4, '同一张照片的第二张脸不得占用同一组');
      assert.equal(isolatedStore.counts().faces, 6);
      isolatedStore.close();
      isolatedStore = null;

      // ④ 重新归组：同阈值幂等；放宽阈值后同一人合并。
      isolatedStore = isolated('regroup');
      // b 对 a 相似度 0.25：阈值 0.30 下分家，阈值 0.20 下是同一人。
      const a = unit(0);
      const b = mix([
        [0, 0.25],
        [1, Math.sqrt(1 - 0.25 ** 2)],
      ]);
      reps = isolatedStore.representatives();
      isolatedStore.put(photo(11), [detection(a)], reps, 0.3);
      isolatedStore.put(photo(12), [detection(b)], reps, 0.3);
      assert.equal(isolatedStore.counts().people, 2);
      const signatureBefore = groupSignature(isolatedStore);
      const idempotent = isolatedStore.regroup(0.3);
      assert.equal(idempotent.people, 2, '同阈值重跑不得改变分组数');
      assert.equal(
        groupSignature(isolatedStore),
        signatureBefore,
        '同阈值重跑必须幂等：分组本身不能变（人数相同但成员换组也算变）',
      );
      const relaxed = isolatedStore.regroup(0.2);
      assert.equal(relaxed.people, 1, '阈值放宽后同一人必须合并');
      assert.equal(relaxed.faces, 2);
      assert.equal(groupSignature(isolatedStore), '1,2', '两张脸必须落到同一个组里');
      assert.equal(relaxed.created, 1, '合并成的一组是新建的');
      assert.equal(relaxed.dissolved, 2, '原来两个未命名空组要被清掉');
      isolatedStore.close();
      isolatedStore = null;

      // ⑤ 已命名的人物是锚点：极端放宽阈值也不能把它并掉或拆散。
      isolatedStore = isolated('anchor');
      reps = isolatedStore.representatives();
      isolatedStore.put(photo(13), [detection(a)], reps, 0.3);
      isolatedStore.put(photo(14), [detection(b)], reps, 0.3);
      const peopleIds = isolatedStore.groups().items.map((item) => item.id);
      assert.equal(peopleIds.length, 2);
      isolatedStore.rename(peopleIds[0], '甲');
      isolatedStore.rename(peopleIds[1], '乙');
      const signatureAnchored = groupSignature(isolatedStore);
      const anchored = isolatedStore.regroup(0.1);
      assert.equal(anchored.people, 2, '命名过的人物不得被重新归组吞并');
      assert.equal(anchored.regrouped, 0, '命名组的成员应原地保留');
      assert.equal(
        groupSignature(isolatedStore),
        signatureAnchored,
        '锚点保护：命名组的成员归属一个都不许动',
      );
      assert.deepEqual(
        isolatedStore
          .groups()
          .items.map((item) => item.name)
          .sort(),
        ['乙', '甲'],
        '命名必须原样保留',
      );
      // 反向对照：把名字去掉之后，同样的重跑就会把它们并成一个。
      const stripped = isolatedStore.groups().items;
      isolatedStore.rename(stripped[0].id, '');
      isolatedStore.rename(stripped[1].id, '');
      assert.equal(isolatedStore.regroup(0.1).people, 1, '未命名时阈值放宽应当合并');
      isolatedStore.close();
      isolatedStore = null;

      // ⑥ 空库上重跑不该炸，也不该凭空造出人物。
      isolatedStore = isolated('empty');
      assert.deepEqual(isolatedStore.regroup(0.3), {
        people: 0,
        faces: 0,
        regrouped: 0,
        created: 0,
        dissolved: 0,
      });
      isolatedStore.close();
      isolatedStore = null;

      // ⑥′ Chinese Whispers 本体。这是「换聚类算法」新增的全部逻辑，四条都要有牙齿。
      {
        const axis = (index, value) => {
          const v = new Float32Array(VECTOR_DIM);
          v[index] = value;
          return normalize(v);
        };
        // ① **同一张照片的两张脸绝不连边**：向量完全一样（相似度 1.0）也不许并成一组，
        //    否则合照里的两个人会被并成一个人。这是 LAP 带过来的那条业务约束。
        const same = chineseWhispers([1, 1, 2], [axis(0, 1), axis(0, 1), axis(9, 1)], 0.5, new Map());
        assert.notEqual(same[0], same[1], '同一张照片的两张脸不得并成一组');
        assert.notEqual(same[2], same[0], '与谁都连不上的脸自成一组');
        // ② 固定种子：同一份输入同一阈值必须**逐位相同** —— 这是「同设置重跑必须幂等」
        //    的地基。Chinese Whispers 天然是随机顺序投票，不固定种子结果每次都不一样
        //    （实测 K=80 时 F1 在 0.666–0.856 之间抖）。
        assert.deepEqual(
          chineseWhispers([1, 1, 2], [axis(0, 1), axis(0, 1), axis(9, 1)], 0.5, new Map()),
          same,
        );
        // ③ 锚点（用户手工命名过的组）：标签固定成 `-(person_id + 1)` 不许改，
        //    但对邻居照常投票，于是像磁铁一样把够相似的自由脸吸过去。
        const near = new Float32Array(VECTOR_DIM);
        near[0] = 0.9;
        near[1] = Math.sqrt(1 - 0.81);
        const anchored = chineseWhispers(
          [1, 2, 3],
          [axis(0, 1), normalize(near), axis(9, 1)],
          0.5,
          new Map([[0, 7]]),
        );
        assert.equal(anchored[0], -8, '锚点标签必须固定为 -(person_id + 1)');
        assert.equal(anchored[1], -8, '够相似的自由脸应被锚点吸进该组');
        assert.equal(anchored[2], 2, '跟锚点不像的脸不受影响');
        // ④ 阈值收紧只会让组变多，不会变少（否则「阈值」这个旋钮的方向就是反的）。
        const spread = [axis(0, 1), axis(9, 1), axis(8, 1)];
        const loose = new Set(chineseWhispers([1, 2, 3], spread, 0.1, new Map())).size;
        const tight = new Set(chineseWhispers([1, 2, 3], spread, 0.99, new Map())).size;
        assert.ok(tight >= loose, '阈值收紧后组数不得减少');
        // K_NEIGHBORS 不能退回 LAP 的 80：本库实测 K=80 的种子均值 F1 只有 0.778，
        // K=400 是 0.879–0.948，而 K=800 会在低阈值时把整库塌成一组。
        assert.ok(K_NEIGHBORS >= 200 && K_NEIGHBORS <= 600, 'K_NEIGHBORS 应停在本库实测过的区间');
      }
      // ⑧ 组内「固定抽样平均」必须比「队首那张脸」更抗离群锚点 —— 这是本版换掉代表脸
      //    策略的全部理由，所以要有牙齿：同样的数据，旧策略会在这里多分出一组。
      isolatedStore = isolated('average');
      // m1 是偏离锚点：与目标脸只像 0.30（低于阈值 0.35），但与 m2 像 0.96（够同组）。
      const m1 = mix([
        [0, 0.3],
        [1, Math.sqrt(1 - 0.3 ** 2)],
      ]);
      const m2 = mix([
        [0, 0.55],
        [1, Math.sqrt(1 - 0.55 ** 2)],
      ]);
      reps = isolatedStore.representatives();
      isolatedStore.put(photo(15), [detection(m1)], reps, 0.35); // 建组，队首是 m1
      for (let i = 16; i <= 23; i++) isolatedStore.put(photo(i), [detection(m2)], reps, 0.35);
      assert.equal(isolatedStore.counts().people, 1, '八张同样的脸必须并进同一组');
      isolatedStore.put(photo(24), [detection(unit(0))], reps, 0.35);
      assert.equal(
        isolatedStore.counts().people,
        1,
        '目标脸对队首 m1 只有 0.30（低于阈值）却对组内均值约 0.52：旧锚点策略会在这里多分一组',
      );
      assert.equal(isolatedStore.counts().faces, 10);
      // 反向：组内成员**没有一个**像它时仍必须新建 —— 平均不能退化成「什么都并」。
      isolatedStore.put(photo(25), [detection(unit(9))], reps, 0.35);
      assert.equal(isolatedStore.counts().people, 2, '组里没有一个像它，必须另起一组');
      isolatedStore.close();
      isolatedStore = null;

      // ⑨ 按文件夹归组：用户的目录约定本身就是标准答案，这个模式只认目录、不比特征。
      //    用独立的 photos 库，因为要带 `root_folders` 表与多目录路径。
      const folderDbPath = path.join(directory, 'folder-photos.db');
      const folderSource = new Database(folderDbPath);
      folderSource.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT,
        file_type TEXT, file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER,
        has_thumbnail INTEGER, is_favorite INTEGER);
        CREATE TABLE root_folders (id INTEGER PRIMARY KEY, path TEXT, name TEXT, added_at TEXT);
        INSERT INTO root_folders VALUES (1, 'K:\\COS', 'COS', '2026-01-01');`);
      const layout = [
        'K:\\COS\\116\\a.jpg',
        'K:\\COS\\116\\一个图包\\b.jpg',
        'K:\\COS\\116\\另一个图包\\c.jpg',
        'K:\\COS\\117\\d.jpg',
        'K:\\COS\\117\\某包\\e.jpg',
        'D:\\别处\\f.jpg',
      ];
      layout.forEach((filePath, index) => {
        folderSource
          .prepare('INSERT INTO photos VALUES (?, ?, ?, ?, 10, ?, NULL, 100, 100, 0, 0)')
          .run(index + 1, filePath, filePath.split('\\').pop(), 'jpg', '2026-09-27');
      });
      folderStore = new FaceStore(folderDbPath, path.join(directory, 'folder-faces.sqlite'));
      // 每张脸故意用**互不相同**的向量：这个模式的判断依据只有目录，特征完全不参与。
      for (let n = 1; n <= layout.length; n++)
        folderStore.put(
          { id: n, file_name: layout[n - 1].split('\\').pop(), file_path: layout[n - 1], file_size: 10, date_modified: '2026-09-27' },
          [detection(unit(n))],
          new Map(),
          { grouping: 'folder', groupingDepth: 1 },
        );
      const folderNames = () =>
        folderStore
          .groups()
          .items.map((item) => item.name)
          .sort();
      assert.deepEqual(
        folderNames(),
        ['116', '117', '别处'],
        '层级 1 = 根下第一层子目录；不在任何根下的照片退化为「照片所在目录」',
      );
      assert.equal(
        folderStore.groups().items.find((item) => item.name === '116').faceCount,
        3,
        '同一目录下不同深度的照片（a.jpg 与 一个图包/b.jpg）必须归到一起',
      );
      // 层级 2：细到图包一层，旧目录组要被清掉而不是堆着（按名字删不掉的那种空组）。
      assert.equal(
        folderStore.regroup({ grouping: 'folder', groupingDepth: 2 }).people,
        6,
        '层级 2：K:\\COS\\116 拆成 116 / 一个图包 / 另一个图包，且上一轮的旧组不残留',
      );
      // ⑩ 手工命名要被继承到对应的目录组；自动起的目录名不算用户劳动。
      const group116 = folderStore.groups().items.find((item) => item.name === '116');
      folderStore.rename(group116.id, '甲');
      folderStore.regroup({ grouping: 'folder', groupingDepth: 1 });
      assert.deepEqual(
        folderNames(),
        ['117', '别处', '甲'],
        '手工命名「甲」要跟着它的成员落到对应目录组上，其余仍按目录自动命名',
      );
      // ⑪ 切回视觉聚类：自动目录名必须清掉，否则上千个自动名会被当成锚点锁死，
      //    视觉聚类等于完全没跑（只有手工命名的「甲」该留下）。
      folderStore.regroup({ grouping: 'cluster', matchThreshold: 0.2 });
      assert.deepEqual(
        folderStore
          .groups()
          .items.filter((item) => item.name && item.name !== '甲'),
        [],
        '按文件夹自动起的名字在切回视觉聚类后必须清空',
      );
      folderStore.close();
      folderStore = null;
      folderSource.close();

      // ⑫ 按目录分域聚类：目录只当**边界**，域内照旧比对特征。三条契约各一条断言：
      //    「目录里两个人要拆开」「跨域绝不合并」「单目录单簇才沿用目录名」。
      const scopedPath = path.join(directory, 'scoped-photos.db');
      scopedSource = new Database(scopedPath);
      scopedSource.exec(`CREATE TABLE photos (id INTEGER PRIMARY KEY, file_path TEXT, file_name TEXT,
        file_type TEXT, file_size INTEGER, date_modified TEXT, thumbnail BLOB, width INTEGER, height INTEGER,
        has_thumbnail INTEGER, is_favorite INTEGER);
        CREATE TABLE root_folders (id INTEGER PRIMARY KEY, path TEXT, name TEXT, added_at TEXT);
        INSERT INTO root_folders VALUES (1, 'K:\\COS', 'COS', '2026-01-01');`);
      // A 里两个人（甲：unit(1)×2、乙：unit(2)×1）；B 里也是两个人（丙 unit(3)×2、丁 unit(4)×2）；
      // C / D 是**同一个人**（戊）的两批照片，放在两个目录；E 是单目录单人。
      const scopedLayout = [
        ['K:\\COS\\A\\p1.jpg', 1],
        ['K:\\COS\\A\\p2.jpg', 1],
        ['K:\\COS\\A\\p3.jpg', 2],
        ['K:\\COS\\B\\q1.jpg', 3],
        ['K:\\COS\\B\\q2.jpg', 3],
        ['K:\\COS\\B\\q3.jpg', 4],
        ['K:\\COS\\B\\q4.jpg', 4],
        ['K:\\COS\\C\\r1.jpg', 5],
        ['K:\\COS\\C\\r2.jpg', 5],
        ['K:\\COS\\D\\s1.jpg', 5],
        ['K:\\COS\\D\\s2.jpg', 5],
        ['K:\\COS\\E\\t1.jpg', 7],
        ['K:\\COS\\E\\t2.jpg', 7],
      ];
      scopedLayout.forEach(([filePath], index) => {
        scopedSource
          .prepare('INSERT INTO photos VALUES (?, ?, ?, ?, 10, ?, NULL, 100, 100, 0, 0)')
          .run(index + 1, filePath, filePath.split('\\').pop(), 'jpg', '2026-09-27');
      });
      scopedStore = new FaceStore(scopedPath, path.join(directory, 'scoped-faces.sqlite'));
      const scoped = { grouping: 'scoped', groupingDepth: 1, matchThreshold: 0.3 };
      const signature = () =>
        scopedStore
          .groups()
          .items.map((item) => item.name + ':' + item.faceCount)
          .sort()
          .join('|');
      const sizes = () =>
        scopedStore
          .groups()
          .items.map((item) => item.faceCount)
          .sort()
          .join(',');
      // 代表表只建一份、所有 `put()` 共用 —— 与索引 worker 的真实用法一致
      // （`face-worker.js` 在循环外取一次 `store.representatives()`）。
      const scopedReps = scopedStore.representatives();
      for (let n = 1; n <= scopedLayout.length; n++)
        scopedStore.put(
          {
            id: n,
            file_name: scopedLayout[n - 1][0].split('\\').pop(),
            file_path: scopedLayout[n - 1][0],
            file_size: 10,
            date_modified: '2026-09-27',
          },
          [detection(unit(scopedLayout[n - 1][1]))],
          scopedReps,
          scoped,
        );
      // 增量阶段（`put()`）就必须守域：C 与 D 是同一个人的同一批向量，若这里不按域过滤，
      // D 的第一张脸会立刻并进 C 的组，收尾重算虽然能纠正，但索引过程中的人物页会显示错的人数。
      assert.equal(
        scopedStore.counts().people,
        7,
        '增量归组也不得跨域合并（否则索引中途的人物数就是错的）',
      );
      assert.equal(
        scopedStore.regroup(scoped).people,
        7,
        '分域聚类：A 拆成 2 个人、B 拆成 2 个人、C 与 D 各 1 个（未被圈进同一域）、E 1 个',
      );
      assert.deepEqual(
        sizes(),
        '1,2,2,2,2,2,2',
        'A 的两个人（2+1）与 B 的两个人（2+2）必须拆开，而不是并成 A=3 / B=4',
      );
      assert.deepEqual(
        scopedStore
          .groups()
          .items.filter((item) => item.name)
          .map((item) => item.name)
          .sort(),
        ['C', 'D', 'E'],
        '只有「单目录 + 只聚出一个簇」才沿用目录名；A / B 各聚出两个人，**不得**拿目录名冒充',
      );
      // 幂等：同设置重跑，成员构成必须逐组一致。
      const before = signature();
      scopedStore.regroup(scoped);
      assert.equal(signature(), before, '同设置重跑两次，分组构成必须一致');
      // 圈域：把 C、D 写进同一行 → 同一个人散在两处的照片并进同一个域，聚成一组。
      assert.equal(
        scopedStore.regroup({ ...scoped, domainGroups: 'C, D' }).people,
        6,
        '手工圈域后 C 与 D 的照片进同一个域，聚成一个人（7 → 6）',
      );
      assert.deepEqual(
        sizes(),
        '1,2,2,2,2,4',
        '圈域只放宽「谁可以和谁比」，域内不同的人照旧分开',
      );
      assert.deepEqual(
        scopedStore
          .groups()
          .items.filter((item) => item.name)
          .map((item) => item.name)
          .sort(),
        ['E'],
        '合并域不是「一个目录」，**不得**拿某个目录名当组名（C / D 的名字要消失）',
      );
      // 锚点优先于域边界：给圈出来的那个人起名后再去掉域分组重算，他仍是一个人，
      // 而且这个名字是用户劳动，不得被 clearFolderNames 清掉。
      const merged = scopedStore.groups().items.find((item) => item.faceCount === 4);
      scopedStore.rename(merged.id, '戊');
      scopedStore.regroup(scoped);
      assert.deepEqual(
        scopedStore
          .groups()
          .items.filter((item) => item.name === '戊')
          .map((item) => item.faceCount),
        [4],
        '手工命名过的组是锚点：去掉域分组后依然不被拆开，名字也保留',
      );
      scopedStore.close();
      scopedStore = null;
      scopedSource.close();
      scopedSource = null;
    } finally {
      if (isolatedStore) isolatedStore.close();
      if (folderStore) folderStore.close();
      if (scopedStore) scopedStore.close();
      if (scopedSource) scopedSource.close();
    }

    // ⑦ 阈值的取值域只有一处定义（src/ai/face-settings.js），浏览器侧那份是镜像；
    //    两边数字各写一份、容易改一处漏一处，这里直接解析比对。
    const mainSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ai', 'face-settings.js'),
      'utf8',
    );
    const webSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'web', 'js', 'people.js'),
      'utf8',
    );
    const readNumber = (source, name) => {
      const match = new RegExp(name + '\\s*[:=]\\s*([0-9.]+)').exec(source);
      assert.ok(match, name + ' 必须能在源码里解析到');
      return Number(match[1]);
    };
    // 两处取值域都是「主进程一份 + 浏览器镜像一份」，改一处漏一处会静默跑偏，
    // 所以逐项解析比对，而不是人眼核对。
    for (const [rangeName, entries] of [
      [
        'THRESHOLD_RANGE',
        { min: 'THRESHOLD_MIN', max: 'THRESHOLD_MAX', step: 'THRESHOLD_STEP', default: 'THRESHOLD_DEFAULT' },
      ],
      ['DEPTH_RANGE', { min: 'DEPTH_MIN', max: 'DEPTH_MAX', default: 'DEPTH_DEFAULT' }],
    ]) {
      const webRange = new RegExp(rangeName + ' = \\{([^}]*)\\}').exec(webSource);
      assert.ok(webRange, 'people.js 里必须有镜像的 ' + rangeName);
      for (const [webKey, mainName] of Object.entries(entries)) {
        const webValue = readNumber(webRange[1], webKey);
        const mainValue = readNumber(mainSource, mainName);
        assert.equal(
          webValue,
          mainValue,
          rangeName + ' 左右不一致：' + webKey + '=' + webValue + ' vs ' + mainName + '=' + mainValue,
        );
      }
    }
    // 归组方式的取值也必须两边一致：主进程只认 'folder'，UI 的下拉里不能写成别的词。
    assert.ok(
      /GROUPINGS = \['cluster', 'folder', 'scoped'\]/.test(mainSource),
      'face-settings.js 的 GROUPINGS 必须是 [cluster, folder, scoped]',
    );
    assert.ok(
      webSource.includes("value: 'folder'") &&
        webSource.includes("value: 'cluster'") &&
        webSource.includes("value: 'scoped'"),
      'people.js 的归组方式下拉必须提供 cluster、scoped 与 folder 三个取值',
    );
    // 静态防线：put() 里那条「最佳与次佳太接近就新建一组」的规则不得复活。
    // 注释里**必须**留着它的名字（解释为什么删），所以先剥掉注释再查代码。
    const stripComments = (source) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.ok(
      !/\bsecond\b/.test(
        stripComments(
          fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'face-store.js'), 'utf8'),
        ),
      ),
      'put() 里那条 margin 规则不得复活（它是同一人被拆开的主因）',
    );

    console.log('[face-regression] PASS');
  } finally {
    if (service) service.dispose();
    if (store) store.close();
    if (source) source.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
