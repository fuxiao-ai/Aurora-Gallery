'use strict';
const Database = require('better-sqlite3');
const { VERSION, VERSION_LABEL, labelForVersion, pack, unpack } = require('./face-model');
const {
  THRESHOLD_DEFAULT,
  DEPTH_DEFAULT,
  GROUPINGS,
  clampThreshold,
  clampDepth,
  normalizeDomainGroups,
  parseDomainGroups,
} = require('./face-settings');
const VALID = `JOIN faceindex.scans s ON s.photo_id = f.photo_id
  JOIN photos p ON p.id = s.photo_id AND p.file_path = s.file_path
  AND p.file_size = s.file_size AND COALESCE(p.date_modified, '') = s.date_modified AND s.version = ?`;
function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('FACE_ID_INVALID');
  return n;
}

/**
 * 归组参数归一化。三种入参形状都要能吃：
 *   - `undefined`            → 全默认（视觉聚类 + 默认阈值）
 *   - `0.55`（数字 / 数字串） → 视觉聚类 + 该阈值。**旧签名兼容**：`put(..., 0.6)` 这种
 *                              老式调用如果被当成对象解析，阈值会静默变成 NaN→默认值，
 *                              那是最难查的一类错，所以宁可显式接住它。
 *   - `{ grouping, matchThreshold, groupingDepth, domainGroups }`
 */
function groupingOptions(value) {
  if (value === undefined || value === null)
    return {
      grouping: 'cluster',
      matchThreshold: THRESHOLD_DEFAULT,
      groupingDepth: DEPTH_DEFAULT,
      domainGroups: '',
      domainMap: new Map(),
    };
  if (typeof value === 'number' || typeof value === 'string')
    return {
      grouping: 'cluster',
      matchThreshold: clampThreshold(value),
      groupingDepth: DEPTH_DEFAULT,
      domainGroups: '',
      domainMap: new Map(),
    };
  const domainGroups = normalizeDomainGroups(value.domainGroups);
  return {
    // `GROUPINGS` 是唯一真相源（`cluster` / `folder` / `scoped`），未知值一律回落默认 ——
    // 报错会把带着旧值（`balanced` / `strict`）的老设置卡死。
    grouping: GROUPINGS.includes(value.grouping) ? value.grouping : 'cluster',
    matchThreshold: clampThreshold(value.matchThreshold),
    groupingDepth: clampDepth(value.groupingDepth),
    domainGroups,
    domainMap: parseDomainGroups(domainGroups),
  };
}
/** 取路径的父目录。用字符串处理而不是 `path.dirname`，免得被平台分隔符差异影响。 */
function parentDirectory(filePath) {
  const normalized = String(filePath).replace(/\//g, '\\');
  const index = normalized.lastIndexOf('\\');
  return index <= 0 ? normalized : normalized.slice(0, index);
}
function segments(value) {
  return String(value)
    .replace(/\//g, '\\')
    .split('\\')
    .filter(Boolean);
}
/**
 * 按文件夹归组的键：**根目录下第 `depth` 层子目录**。
 *
 * 之所以按「根下第 N 层」而不是「照片所在目录」，是因为照片的存放深度不一：
 * 真库里 `K:\COS\116\a.jpg` 与 `K:\COS\116\某图包\b.jpg` 同时存在，用户的意思
 * 都是「`K:\COS\116` 这一个人」。取根下第 1 层两种深度都会正确落到 `K:\COS\116`。
 *
 * 照片不在任何已登记根目录下时，退化为「照片所在目录」（最保守：不会把无关目录
 * 合到一起）。根目录列表读不到（例如测试夹具没有 `root_folders` 表）时同样走这条路。
 */
function folderGroupKey(filePath, roots, depth) {
  const directory = segments(parentDirectory(filePath));
  let base = null;
  for (const root of roots) {
    const parts = segments(root);
    if (!parts.length || parts.length > directory.length) continue;
    if (!parts.every((part, index) => directory[index].toLowerCase() === part.toLowerCase()))
      continue;
    if (!base || parts.length > base.length) base = parts;
  }
  if (!base) return directory.join('\\');
  const relative = directory.slice(base.length);
  return base.concat(relative.slice(0, Math.min(depth, relative.length))).join('\\');
}
/** 组名：归组键的最后一段（`K:\COS\116` → `116`）。 */
function folderGroupName(key) {
  const parts = segments(key);
  return parts.length ? parts[parts.length - 1] : String(key);
}
/**
 * 域 = 「这些脸可以和谁比」的池子。`scoped` 模式下**跨域绝不连边**。
 *
 * 默认每个目录键自成一域（域标识就是键本身）；用户在设置里把若干目录名写在同一行时，
 * 这些目录折算成同一个域（标识 `@0` / `@1` …）。
 *
 * 为什么域标识用「带 `@` 前缀的字符串」而不是数字：它要能同时容纳「没被圈定的目录的
 * 原始键」与「圈定的域号」，这样调用方一个字符串就能比较，不必分成两套判断。目录名里
 * 不可能出现 `@`，所以不会有歧义。
 *
 * `roots` 传空数组时退化为「照片所在目录」，与 `folderGroupKey` 的保守行为一致 ——
 * 测试夹具没有 `root_folders` 表时也照样能跑。
 */
function domainKeyOf(filePath, roots, options) {
  const key = folderGroupKey(filePath, roots, options.groupingDepth);
  const group = options.domainMap.get(folderGroupName(key).toLowerCase());
  return group === undefined ? key : '@' + group;
}
// `groupScore`（增量近似的代表集打分）与 `chineseWhispers`（全局聚类）连同其参数常量
// 都搬到了 `./face-cluster` —— 那份是**纯算法、零原生依赖**（不 require better-sqlite3 /
// sharp / onnxruntime），所以离线探针 `scripts/face-threshold-probe.js` 能直接引它复算
// 线上行为，而不是自己再复刻一遍。复刻的代价是漂移：算法改了探针没改，标出来的阈值
// 就不再是线上阈值。下面从那里引入并原样 re-export，对外接口没有变。
const {
  groupScore,
  chineseWhispers,
  K_NEIGHBORS,
  MAX_ITERATIONS,
  CW_SEED,
  AUTO_REGROUP_LIMIT,
} = require('./face-cluster');

class FaceStore {
  constructor(sourcePath, indexPath) {
    this.db = new Database(indexPath);
    // 索引 worker 运行期间，人物页会以第二个连接并发只读查询（FaceService 的
    // concurrentReads）。这里把 busy_timeout 放在最前，是让第二个连接在建连阶段
    // 万一与写入事务争锁时等待而不是立即抛 SQLITE_BUSY。
    // 注：实测（scripts/face-concurrency-regression.js）在写事务持锁期间，WAL 库
    // 重复设 journal_mode 与「建表 IF NOT EXISTS」本身并不取写锁，所以这个顺序是
    // 防御性的，并不是并发只读能否工作的前提。
    this.db.pragma('busy_timeout = 3000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '',
        name_source TEXT NOT NULL DEFAULT '', folder_key TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS scans (photo_id INTEGER PRIMARY KEY, file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL, date_modified TEXT NOT NULL, version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS faces (id INTEGER PRIMARY KEY AUTOINCREMENT, photo_id INTEGER NOT NULL REFERENCES scans(photo_id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES people(id), vector BLOB NOT NULL, thumbnail BLOB NOT NULL, box TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);
      CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);`);
    // 旧库的 people 表没有这两列。`name_source` 区分「按文件夹自动起的名字」与
    // 「用户手打的」——只有后者才是重算时不许动的锚点，否则切换归组方式会把
    // 上千个自动名的组全当成锚点锁死。
    for (const [column, declaration] of [
      ['name_source', "TEXT NOT NULL DEFAULT ''"],
      ['folder_key', "TEXT NOT NULL DEFAULT ''"],
    ]) {
      try {
        this.db.exec(`ALTER TABLE people ADD COLUMN ${column} ${declaration}`);
      } catch (error) {
        if (!/duplicate column/i.test(error.message)) throw error;
      }
    }
    /** folder 模式的「归组键 → person_id」缓存，随本轮写入增量更新。 */
    this.folderCache = null;
    /** `scoped` 模式的「person_id → 所属域」缓存，同样增量维护。 */
    this.domainCache = null;
    try {
      this.source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      this.source.prepare('ATTACH DATABASE ? AS faceindex').run(indexPath);
    } catch (error) {
      if (this.source) this.source.close();
      this.db.close();
      throw error;
    }
  }
  batch(after) {
    return this.source
      .prepare(
        `SELECT p.id, p.file_name, p.file_path, p.file_size, COALESCE(p.date_modified, '') date_modified,
      p.thumbnail FROM photos p LEFT JOIN faceindex.scans s ON p.id = s.photo_id
      WHERE p.id > ? AND (s.photo_id IS NULL OR s.version != ? OR s.file_path != p.file_path
      OR s.file_size != p.file_size OR s.date_modified != COALESCE(p.date_modified, '')) ORDER BY p.id LIMIT 8`,
      )
      .all(after, VERSION);
  }
  /**
   * 每个已有组的**全部成员向量**，按 `faces.id` 升序（= 当初插入的顺序）。
   * 返回 `Map<person_id, Float32Array[]>`；`groupScore` 自己决定从中抽哪几个。
   * 旧版只取每组最早一张，那正是「锚点靠运气」的来源。
   */
  representatives() {
    const rows = this.source
      .prepare(`SELECT f.person_id, f.vector FROM faceindex.faces f ${VALID} ORDER BY f.id`)
      .all(VERSION);
    const map = new Map();
    for (const row of rows) {
      let list = map.get(row.person_id);
      if (!list) map.set(row.person_id, (list = []));
      list.push(unpack(row.vector));
    }
    return map;
  }
  /** 已登记的根目录路径。表不存在（测试夹具）时返回空数组，让归组退化到「照片所在目录」。 */
  rootPaths() {
    try {
      return this.source
        .prepare('SELECT path FROM root_folders')
        .all()
        .map((row) => row.path);
    } catch (error) {
      return [];
    }
  }
  /** folder 模式的「归组键 → person_id」映射，懒加载一次后随写入增量维护。 */
  folderIndex(depth) {
    if (this.folderCache && this.folderCache.depth === depth) return this.folderCache.map;
    const map = new Map(
      this.db
        .prepare("SELECT id, folder_key FROM people WHERE folder_key <> ''")
        .all()
        .map((row) => [row.folder_key, row.id]),
    );
    this.folderCache = { depth, map };
    return map;
  }
  /**
   * `scoped` 模式的「`person_id` → 所属域」，懒加载一次后随新建组增量维护。
   *
   * 一个人理论上可能横跨多个域（切换过归组方式、或锚点跨域），这时取**成员最多的那个域**
   * 当归属。增量阶段只是「索引过程中的临时分组」，收尾的 `regroup()` 会按域重算，
   * 所以这里不必求全，只要别把两个域的人硬凑到一起就够。
   */
  domainIndex(options) {
    if (this.domainCache) return this.domainCache;
    const roots = this.rootPaths();
    const counts = new Map();
    for (const row of this.source
      .prepare(`SELECT f.person_id, s.file_path FROM faceindex.faces f ${VALID}`)
      .all(VERSION)) {
      const domain = domainKeyOf(row.file_path, roots, options);
      let bucket = counts.get(row.person_id);
      if (!bucket) counts.set(row.person_id, (bucket = new Map()));
      bucket.set(domain, (bucket.get(domain) || 0) + 1);
    }
    const map = new Map();
    for (const [person, bucket] of counts) {
      let best = '';
      let bestCount = -1;
      for (const [domain, n] of bucket)
        if (n > bestCount) {
          bestCount = n;
          best = domain;
        }
      map.set(person, best);
    }
    this.domainCache = map;
    return map;
  }
  /**
   * 把一张照片的检测结果并入人物分组。
   *
   * ## 为什么只按阈值判定，不再有「最佳与次佳太接近就新建一组」
   *
   * 旧实现在 `best < threshold` 之外还加了一条 `best - second < 0.05`：只要最佳候选
   * 与次佳候选差距小于 0.05，就算最佳分高达 0.9x 也照样新建一组。这条规则**与阈值自相矛盾**——
   * 它让算法拒绝采纳自己刚判定为「同一个人」的匹配。
   *
   * 实测（1268 张真实人脸，同一份数据离线重放，方法与数字见 docs/people-groups.md）：
   *   - 线上现状（阈值 0.60 + margin）= 783 个人物，其中 548 个只有 1 张脸（70%）；
   *   - 只删掉 margin、阈值不动          = 362 个人物（同一人被拆开的组数直接少了一半以上）；
   *   - 再配合默认阈值 0.55              = 229 个人物。
   * 被这条规则拆出来的组，正是相似度最高的那一批：如 #400(4 脸) ↔ #403(4 脸) 质心相似度
   * 0.938、#703 ↔ #706 为 0.915 —— 肉眼核对全部是同一个人换了角度 / 表情。
   *
   * 取舍：候选分 ≥ 阈值时「并错人」是一次可见、一键可拆的合并错误；而「凭空多出一个人」
   * 是不可见、会自我繁殖的（下一张脸又多一个新候选去分票）。所以歧义时归给最佳候选，
   * 把纠正交给人物的「合并 / 纠正分组」，而不是静默新建人物。
   */
  put(photo, detections, representatives, preferences) {
    const options = groupingOptions(preferences);
    const byFolder = options.grouping === 'folder';
    // `scoped`：候选只在**同一个域**里找。域边界是硬的 —— 跨域的脸连比较都不做，
    // 所以「一个目录里两个人」不会因为另一个人恰好更像就被并走。
    const scoped = options.grouping === 'scoped';
    const domain = scoped ? domainKeyOf(photo.file_path, this.rootPaths(), options) : '';
    const domains = scoped ? this.domainIndex(options) : null;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM scans WHERE photo_id = ?').run(photo.id);
      this.db
        .prepare('INSERT INTO scans VALUES (?, ?, ?, ?, ?)')
        .run(photo.id, photo.file_path, photo.file_size, photo.date_modified, VERSION);
      if (!detections.length) return;
      // 按文件夹归组：同一目录的所有脸都是同一个人，所以一张照片里的多张脸
      // 直接归同一组，「同一张照片的两张脸不得同组」这条约束在此模式下**不适用**
      // （那条约束是为了防止把合照里的人并成一个人，而目录约定本身就是这么定的）。
      // `scoped` 相反：域内可能有两个人，所以这条约束照旧生效（上面 `used` 那层拦着）。
      let folderPersonId = -1;
      if (byFolder) {
        const key = folderGroupKey(photo.file_path, this.rootPaths(), options.groupingDepth);
        const index = this.folderIndex(options.groupingDepth);
        folderPersonId = index.get(key) ?? -1;
        if (folderPersonId < 0) {
          folderPersonId = Number(
            this.db
              .prepare("INSERT INTO people(name, name_source, folder_key) VALUES (?, 'folder', ?)")
              .run(folderGroupName(key), key).lastInsertRowid,
          );
          index.set(key, folderPersonId);
        }
      }
      const used = new Set();
      for (const face of detections) {
        let personId = folderPersonId;
        if (!byFolder) {
          let best = -1;
          personId = -1;
          for (const [person, members] of representatives) {
            if (used.has(person)) continue;
            if (scoped && domains.get(person) !== domain) continue;
            const score = groupScore(members, face.vector);
            if (score > best) {
              best = score;
              personId = person;
            }
          }
          if (best < options.matchThreshold) {
            personId = Number(
              this.db.prepare('INSERT INTO people DEFAULT VALUES').run().lastInsertRowid,
            );
            representatives.set(personId, []);
            if (scoped) domains.set(personId, domain);
          }
        }
        used.add(personId);
        this.db
          .prepare(
            'INSERT INTO faces(photo_id, person_id, vector, thumbnail, box) VALUES (?, ?, ?, ?, ?)',
          )
          .run(photo.id, personId, pack(face.vector), face.thumbnail, JSON.stringify(face.box));
        if (!byFolder) {
          const members = representatives.get(personId);
          if (members) members.push(face.vector);
          else representatives.set(personId, [face.vector]);
        }
      }
    })();
  }
  /**
   * 用已落库的人脸特征重跑一遍分组，**不重跑检测 / 识别模型**（秒级，而不是重新索引整库）。
   *
   * 用途：改了阈值、换了归组方式之后，让**已有索引**立刻受益。否则用户只能删掉
   * faces.sqlite 重新跑一遍 CNN。
   *
   * 顺序沿用 `faces.id` 升序（= 当初插入的顺序），因此「用同一阈值重新归组」的结果
   * 与「删库重建索引」一致，只是省掉了模型推理。
   *
   * 返回：`people` 重跑后的人物总数，`faces` 参与重跑的人脸数，`regrouped` 归属变了的
   * 张数（未命名组会被重建成新 id，所以同阈值重跑这个数也可能不为 0 —— 判断「分组本身
   * 有没有变」要看成员构成，不要看它），`created` 新建的人物组数，`dissolved` 清掉的
   * 空组数。
   */
  regroup(preferences) {
    const options = groupingOptions(preferences);
    if (options.grouping === 'folder') return this.regroupByFolder(options);
    if (options.grouping === 'scoped') return this.regroupByDomain(options);
    return this.regroupByCluster(options);
  }
  /**
   * 视觉聚类重跑 —— **Chinese Whispers**（见 `chineseWhispers`）。
   *
   * 为什么不是「边扫边贪心并入最像的一组」（`put()` 用的那套）：
   * 贪心是**顺序相关**的，而且阈值曲线很陡（本库 3501 张脸实测：0.16 → F1 0.880，
   * 0.18 → 0.757）。Chinese Whispers 是全局的图划分，同数据同样 8 个种子实测
   * 组数 11，F1 均值 0.883，而且**同一个人被切成的碎片数从 23 降到 12**。
   *
   * 已命名的人物是「锚点」：整组标签固定、不参与投票，但对邻居照常投票，
   * 所以用户的命名与手工整理不会被重算冲掉。注意锚点判据里排除了
   * `name_source = 'folder'`：那是「按文件夹归组」自动起的名字（`116` 这种），
   * 不是用户的手工劳动 —— 不排除的话上千个自动名的组会被当成锚点锁死。
   */
  regroupByCluster(options) {
    // 只取属于当前 VERSION 的行：换识别器后旧行的向量维度不同（512 vs 2048 字节），
    // 硬解会一路算到 NaN 相似度，在归组结果上完全看不出来。
    const rows = this.db
      .prepare(
        `SELECT f.id, f.photo_id, f.person_id, f.vector FROM faces f
      JOIN scans s ON s.photo_id = f.photo_id AND s.version = ? ORDER BY f.id`,
      )
      .all(VERSION);
    if (!rows.length) return { people: 0, faces: 0, regrouped: 0, created: 0, dissolved: 0 };
    const anchorPeople = new Set(
      this.db
        .prepare(
          "SELECT id FROM people WHERE TRIM(COALESCE(name, '')) <> '' AND name_source <> 'folder'",
        )
        .all()
        .map((row) => row.id),
    );
    const photoIds = rows.map((row) => row.photo_id);
    const vectors = rows.map((row) => unpack(row.vector));
    const anchors = new Map();
    for (let i = 0; i < rows.length; i++)
      if (anchorPeople.has(rows[i].person_id)) anchors.set(i, rows[i].person_id);
    const labels = chineseWhispers(photoIds, vectors, options.matchThreshold, anchors);

    let regrouped = 0;
    let dissolved = 0;
    /** 本轮新建的簇数 —— `created` 要报「新建了几个组」，而不是「几张脸落了新组」。 */
    let created = 0;
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
      const insertPerson = this.db.prepare('INSERT INTO people DEFAULT VALUES');
      const resolved = new Map();
      // 写入顺序仍按 `faces.id` 升序（= 当初插入的顺序），所以「同阈值重跑」的结果
      // 与「删库重建索引」一致，只是省掉了模型推理。
      for (let i = 0; i < rows.length; i++) {
        const label = labels[i];
        let target;
        if (label < 0) target = -label - 1; // 锚点组：`-label - 1` 就是 person_id
        else {
          if (!resolved.has(label))
            resolved.set(label, Number(insertPerson.run().lastInsertRowid));
          target = resolved.get(label);
        }
        if (target !== rows[i].person_id) regrouped++;
        update.run(target, rows[i].id);
      }
      created = resolved.size;
      this.clearFolderNames();
      dissolved = this.db
        .prepare(
          `DELETE FROM people WHERE TRIM(COALESCE(name, '')) = ''
        AND id NOT IN (SELECT person_id FROM faces)`,
        )
        .run().changes;
    })();
    this.folderCache = null;
    this.domainCache = null;
    return {
      people: this.peopleCount(),
      faces: rows.length,
      regrouped,
      created,
      dissolved,
    };
  }
  /**
   * 按文件夹重跑：每个「根下第 `depth` 层子目录」= 一个人，组名取该目录名。
   *
   * 这是「用户的目录约定就是标准答案」那条路：在按人分目录的图库里它接近 100% 准确，
   * 而视觉聚类在同一批数据上受限于模型本身（同一人换假发 / 瞳色会把相似度压到
   * 不同人的水平），F1 只能到 0.79。
   *
   * 命名保护：用户手工命名过的人物（`name_source <> 'folder'`）如果**超过一半成员**
   * 落进同一个新组，这个名字会被继承过去。自动名（`name_source = 'folder'`）不作数，
   * 否则切一次模式就会把上一次的目录名当成手工劳动继承。
   */
  regroupByFolder(options) {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.photo_id, f.person_id, s.file_path FROM faces f
      JOIN scans s ON s.photo_id = f.photo_id AND s.version = ? ORDER BY f.id`,
      )
      .all(VERSION);
    if (!rows.length) return { people: 0, faces: 0, regrouped: 0, created: 0, dissolved: 0 };
    const roots = this.rootPaths();
    const keyOf = new Map();
    const groups = new Map();
    const previous = new Map();
    for (const row of rows) {
      const key = folderGroupKey(row.file_path, roots, options.groupingDepth);
      keyOf.set(row.id, key);
      previous.set(row.id, row.person_id);
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(row.id);
    }
    const existing = new Map(
      this.db
        .prepare("SELECT id, folder_key FROM people WHERE folder_key <> ''")
        .all()
        .map((row) => [row.folder_key, row.id]),
    );
    const existingNames = new Map(
      this.db
        .prepare("SELECT id, name FROM people WHERE TRIM(COALESCE(name, '')) <> ''")
        .all()
        .map((row) => [row.id, row.name]),
    );
    // 手工命名组的成员去向：某组 > 50% 的成员落进同一个新组时，名字继承过去。
    const manual = new Map();
    for (const row of this.db
      .prepare(
        "SELECT id FROM people WHERE TRIM(COALESCE(name, '')) <> '' AND name_source <> 'folder'",
      )
      .all())
      manual.set(row.id, new Map());
    for (const row of rows) {
      const bucket = manual.get(row.person_id);
      if (!bucket) continue;
      const key = keyOf.get(row.id);
      bucket.set(key, (bucket.get(key) || 0) + 1);
    }
    const inherited = new Map();
    for (const [personId, bucket] of manual) {
      let total = 0;
      for (const count of bucket.values()) total += count;
      const top = [...bucket].sort((a, b) => b[1] - a[1])[0];
      if (top && total && top[1] / total > 0.5) inherited.set(top[0], existingNames.get(personId));
    }
    // 复用的 id：优先沿用上一次按文件夹归组时用过的组（保持 id 稳定），否则新建。
    const plan = [];
    let regrouped = 0;
    const created = [];
    for (const [key, faceIds] of groups) {
      let personId = existing.get(key) ?? -1;
      if (personId < 0) {
        personId = Number(
          this.db.prepare('INSERT INTO people DEFAULT VALUES').run().lastInsertRowid,
        );
        created.push([personId, key]);
      }
      for (const faceId of faceIds) {
        if (previous.get(faceId) !== personId) regrouped++;
        plan.push([faceId, personId]);
      }
    }
    let dissolved = 0;
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
      for (const [faceId, personId] of plan) update.run(personId, faceId);
      const rename = this.db.prepare(
        "UPDATE people SET name = ?, name_source = 'folder', folder_key = ? WHERE id = ?",
      );
      for (const [personId, key] of created)
        rename.run(inherited.get(key) || folderGroupName(key), key, personId);
      for (const [key, personId] of existing) {
        if (!groups.has(key)) continue;
        rename.run(
          inherited.get(key) || folderGroupName(key),
          key,
          personId,
        );
      }
      // 清空组时要连**自动命名的空组**一起清：它们有名字（`116`），通用的
      // 「无名且无脸」判据删不掉，于是切换层级后旧目录组会一直堆着，
      // 人物数从 3 涨到 9。手工命名的空组仍然保留（那是用户劳动）。
      dissolved = this.db
        .prepare(
          `DELETE FROM people WHERE id NOT IN (SELECT person_id FROM faces)
        AND (name_source = 'folder' OR TRIM(COALESCE(name, '')) = '')`,
        )
        .run().changes;
    })();
    this.folderCache = null;
    this.domainCache = null;
    return {
      people: this.peopleCount(),
      faces: rows.length,
      regrouped,
      created: created.length,
      dissolved,
    };
  }
  /**
   * 按目录分域聚类：**域内**跑 Chinese Whispers，**跨域绝不连边**。
   *
   * 这是 `folder` 与 `cluster` 之间的第三条路 —— 目录提供**边界**（谁的照可以互相比较），
   * 特征提供**判定**（同一个域里到底是几个人）。于是：
   *   - 目录=人（本库的 `K:\COS\<编号>`）：每个域收敛成一个主簇，输出与 `folder` 一致，
   *     连自动目录名都一样；
   *   - 一个目录里有多个人：**自动拆开**（`folder` 做不到），代价是拆出来的组没有名字 ——
   *     刻意**不拿目录名去冒充**，因为那时目录名已经不能代表单一身份了；
   *   - 同一个人的照片散在多个目录：用户在设置里把那几个目录名写进同一行（`domainGroups`），
   *     它们就并进同一个域一起聚类。
   *
   * ## 为什么域内聚类反而比全局更准
   *
   * 实测（本库 3501 张脸 / 6 个单人目录）：全局 CW @0.30 → 11 组、12 块碎片（真值 6 人）；
   * 分域后每个域都收敛成**一个主簇**（1394 张的 116 也是 1 组），碎片只剩 1 张脸级别的零星。
   * 原因是域边界挡住了跨目录的竞争：全局图里 116 的脸有机会被 117 的簇投票吸走，
   * 而域内不存在别的目录来"抢"。
   *
   * ⚠️ 代价说清楚：**同一个人的照片被放在两个目录里就会被拆成两个人**（域边界是硬的）。
   * 这不是 bug 而是这个模式的取舍 —— 要合并就在 `domainGroups` 里把它们圈成一个域，
   * 或者事后用「合并」手工并一次（合并后命名即成为锚点，重算不会再拆开）。
   *
   * ## 锚点是跨域的例外
   *
   * 用户**手工命名过**的组（`name <> '' AND name_source <> 'folder'`）在 CW 里是锚点，
   * 标签固定、不参与投票。若这种组横跨了两个域，它的脸**保持同一个人**（不按域拆）——
   * 用户的劳动优先于域边界。所以域边界只约束**新一轮聚类**，不拆已命名的人。
   */
  regroupByDomain(options) {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.photo_id, f.person_id, f.vector, s.file_path FROM faces f
      JOIN scans s ON s.photo_id = f.photo_id AND s.version = ? ORDER BY f.id`,
      )
      .all(VERSION);
    if (!rows.length) return { people: 0, faces: 0, regrouped: 0, created: 0, dissolved: 0 };
    const roots = this.rootPaths();
    const domains = new Map();
    const domainOfRow = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const domain = domainKeyOf(rows[i].file_path, roots, options);
      domainOfRow[i] = domain;
      let list = domains.get(domain);
      if (!list) domains.set(domain, (list = []));
      list.push(i);
    }
    const anchorPeople = new Set(
      this.db
        .prepare(
          "SELECT id FROM people WHERE TRIM(COALESCE(name, '')) <> '' AND name_source <> 'folder'",
        )
        .all()
        .map((row) => row.id),
    );
    // `target[i]` = 第 i 行该去哪个 person。锚点直接定死，其余按「域 + 簇号」分配。
    const target = new Array(rows.length).fill(-1);
    /** 每个域聚出了几个簇 —— 只是「要不要命名」的输入，判定收敛在下面的 `naming` 里。 */
    const clustersOfDomain = new Map();
    for (const [domain, indexes] of domains) {
      const anchors = new Map();
      const local = new Map();
      for (let k = 0; k < indexes.length; k++) {
        local.set(indexes[k], k);
        if (anchorPeople.has(rows[indexes[k]].person_id))
          anchors.set(k, rows[indexes[k]].person_id);
      }
      const labels = chineseWhispers(
        indexes.map((i) => rows[i].photo_id),
        indexes.map((i) => unpack(rows[i].vector)),
        options.matchThreshold,
        anchors,
      );
      const clusters = new Set();
      for (let k = 0; k < indexes.length; k++) {
        const label = labels[k];
        if (label < 0) {
          target[indexes[k]] = { anchor: -label - 1 };
          continue;
        }
        clusters.add(label);
        target[indexes[k]] = { cluster: label };
      }
      clustersOfDomain.set(domain, clusters);
    }
    // 「单目录 + 只聚出一个簇」才沿用目录名。**合并域（`@N`）永远不命名** —— 那时目录名
    // 已经不能代表单一身份，拿它当组名会让用户以为分组是对的。这条判定只算一次，
    // 分配与命名两处都读它：两处各写一遍条件的话，写得不一致时症状是「名字落在错误的组上」，
    // 界面上完全看不出来（负例验证时正是这么踩进一次假通过）。
    const naming = new Map();
    for (const [domain, indexes] of domains)
      naming.set(
        domain,
        !domain.startsWith('@') && indexes.length > 0 && clustersOfDomain.get(domain).size === 1,
      );
    // 单目录单簇 → 沿用该目录上一次用过的组（id 稳定），组名取目录名。
    const existing = new Map(
      this.db
        .prepare("SELECT id, folder_key FROM people WHERE folder_key <> ''")
        .all()
        .map((row) => [row.folder_key, row.id]),
    );
    const plan = [];
    const created = [];
    let regrouped = 0;
    const resolved = new Map();
    for (let i = 0; i < rows.length; i++) {
      const slot = target[i];
      let personId;
      if (slot.anchor !== undefined) {
        personId = slot.anchor;
      } else {
        const domain = domainOfRow[i];
        const single = naming.get(domain);
        const key = single ? domain : domain + '#' + slot.cluster;
        personId = resolved.get(key);
        if (personId === undefined) {
          personId = single ? (existing.get(domain) ?? -1) : -1;
          if (personId < 0) {
            personId = Number(
              this.db.prepare('INSERT INTO people DEFAULT VALUES').run().lastInsertRowid,
            );
            created.push([personId, single ? domain : '']);
          }
          resolved.set(key, personId);
        }
      }
      if (personId !== rows[i].person_id) regrouped++;
      plan.push([rows[i].id, personId]);
    }
    let dissolved = 0;
    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
      for (const [faceId, personId] of plan) update.run(personId, faceId);
      // 先清掉上一轮的自动目录名，再按本轮结果重新命名 —— 不清的话，某个目录这一轮
      // 被拆成多个组时，目录名会留在其中任意一个上冒充分组结果。
      this.clearFolderNames();
      const rename = this.db.prepare(
        "UPDATE people SET name = ?, name_source = 'folder', folder_key = ? WHERE id = ?",
      );
      for (const [personId, key] of created) if (key) rename.run(folderGroupName(key), key, personId);
      for (const [domain, single] of naming) {
        const personId = resolved.get(domain);
        if (single && personId !== undefined)
          rename.run(folderGroupName(domain), domain, personId);
      }
      dissolved = this.db
        .prepare(
          `DELETE FROM people WHERE id NOT IN (SELECT person_id FROM faces)
        AND (name_source = 'folder' OR TRIM(COALESCE(name, '')) = '')`,
        )
        .run().changes;
    })();
    this.folderCache = null;
    this.domainCache = null;
    return {
      people: this.peopleCount(),
      faces: rows.length,
      regrouped,
      created: created.length,
      dissolved,
    };
  }
  /**
   * 清掉不属于当前 `VERSION` 的扫描记录（`faces` 由外键 ON DELETE CASCADE 一起走）。
   *
   * 换识别器会让 `VERSION` 变化，而**旧向量的字节数也不同**（SFace 128 维 = 512 字节，
   * w600k_mbf 512 维 = 2048 字节）。这些行已经不可能被任何读路径采纳（`VALID` 会按
   * `VERSION` 过滤），留着会让「已扫描 / 检出人脸」的实时读数虚高，用户重跑索引时看到的
   * 是上一代模型的数字。
   *
   * ⚠️ 它**清不掉 `people`**：这里只删 `scans`，`people` 里那些「人脸已经没了」的空组要等
   * 收尾的 `regroup()` 才会清（`DELETE FROM people WHERE id NOT IN (SELECT person_id FROM faces)`）。
   * 而全库规模下收尾聚类会被 `AUTO_REGROUP_LIMIT` 跳过 —— 所以实时读数里的「人物」必须由
   * `counts()` 自己按 `version` 过滤，不能指望这一步（详见 `counts()`）。
   *
   * 只在**索引开始前**调用（此时没有别的写者）；不要放进构造函数 —— 人物页的
   * `groups` / `photos` 会在索引进行中并发建连，那时删表会和索引 worker 抢写锁。
   */
  purgeStale() {
    if (!this.db.prepare('SELECT 1 FROM scans WHERE version <> ? LIMIT 1').get(VERSION)) return 0;
    return this.db.prepare('DELETE FROM scans WHERE version <> ?').run(VERSION).changes;
  }
  /** 切回视觉聚类前，把「按文件夹自动起的名字」清掉，让这些组重新参与计算。 */
  clearFolderNames() {
    this.db
      .prepare(
        "UPDATE people SET name = '', folder_key = '' WHERE name_source = 'folder' AND TRIM(COALESCE(name, '')) <> ''",
      )
      .run();
  }

  /**
   * 索引的**对外状态**：能被读路径采纳的数字 + 「为什么空」的归因。
   *
   * ## 为什么必须带上 `staleScans` / `recognizer` / `library`
   *
   * `faces` / `people` / `indexed` 三个数都过了 `VALID` 的 `s.version = ?` 过滤。换识别器
   * （`VERSION` 一变）之后，**库里那一代记录全部落选**，这三个数一起归零 —— 于是
   * 「索引是上一代识别器建的」与「从来没建过索引」在界面上**完全一样**，都是「0 个人物」。
   * 实测踩过：16155 条 v1（SFace）记录、3501 张脸躺在 `faces.sqlite` 里，界面报
   * `{faces:0, people:0, indexed:0}`，人物页显示「还没有识别到人物」，用户看到的像
   * 数据凭空蒸发 —— 而真正该说的那句是「索引与当前识别器不匹配，请重建」。
   *
   * `library` 是覆盖率的分母（已索引 / 全库）。三个数都很便宜（旧版本计数约 5 ms、
   * 全库计数热态 0.1–0.5 ms），而 `status` 是 3 秒一次的轮询，所以不必缓存。
   */
  summary() {
    const row = this.source
      .prepare(
        `SELECT COUNT(*) faces, COUNT(DISTINCT f.person_id) people FROM faceindex.faces f ${VALID}`,
      )
      .get(VERSION);
    const indexed = this.source
      .prepare(
        `SELECT COUNT(*) n FROM faceindex.scans s JOIN photos p ON p.id = s.photo_id
      AND p.file_path = s.file_path AND p.file_size = s.file_size AND COALESCE(p.date_modified, '') = s.date_modified WHERE s.version = ?`,
      )
      .get(VERSION).n;
    // 上一代识别器留下的行：物理还在库里，但所有读路径都不采纳（`VALID` 挡住）。
    // 索引一开始 `purgeStale()` 会把它们清掉；在那之前，界面靠这一项才能说清「为什么是空的」。
    const stale = this.source
      .prepare(
        `SELECT version, COUNT(*) scans FROM faceindex.scans WHERE version <> ?
      GROUP BY version ORDER BY scans DESC`,
      )
      .all(VERSION);
    return {
      ...row,
      indexed,
      /** 现役方案名（设置界面直接显示「现在用的是哪一套」）。 */
      recognizer: VERSION_LABEL,
      /** 现役 `VERSION` 原文 —— 诊断用，界面放在 `title` 里而不是正文。 */
      version: VERSION,
      /** 读路径不采纳的旧记录条数；> 0 就是「人物页为什么是空的」的直接答案。 */
      staleScans: stale.reduce((sum, item) => sum + item.scans, 0),
      /** 旧记录按版本分组，带上人话标签（认得出来才有标签，认不出来就是版本原文）。 */
      staleVersions: stale.map((item) => ({
        version: item.version,
        label: labelForVersion(item.version),
        scans: item.scans,
      })),
      /** 全库照片总数：覆盖率的**分母**。`indexed / library` 就是索引铺开的比例。 */
      library: this.source.prepare('SELECT COUNT(*) n FROM photos').get().n,
    };
  }
  /** 人物总数。索引进度上报用它做「人数变化」信号，驱动人物页增量刷新。 */
  peopleCount() {
    return this.source.prepare('SELECT COUNT(*) n FROM faceindex.people').get().n;
  }
  /**
   * 索引进行中的轻量计数：只查索引库自身，不做与 photos 的指纹校验，
   * 1.5 秒上报一次也没有明显开销。scanned 是「本轮已扫过的照片数」，
   * faces / people 是已检出的人脸与人物数——人物页据 people 变化增量刷新。
   * 索引收尾时 summary() 仍以校验后的数字为准，所以这里不必求全。
   */
  /**
   * 索引期间的实时读数（`scanned` / `faces` / `people`），每 1.5 秒上报一次。
   *
   * `people` **不能**直接 `COUNT(*) FROM people`：`purgeStale()` 只清 `scans`（`faces` 由外键
   * CASCADE 跟着走），而「人脸已经没了」的空组会一直留在 `people` 里，直到收尾的 `regroup()`
   * 用 `DELETE FROM people WHERE id NOT IN (SELECT person_id FROM faces)` 清掉。全库规模下
   * 收尾聚类会被 `AUTO_REGROUP_LIMIT` 跳过，于是那条读数会挂着上一代识别器的组数**全程不动**
   * （本机实测 2273，而当时真实人物只有 11），用户盯着看三天也看不出人物在增长。
   *
   * 所以这里只数**还有当前版本人脸**的人。刻意只按 `version` 过滤、不回 `photos` 校验指纹：
   * 这条路每 1.5 秒跑一次，`VALID` 那套三表 join 在大库上是几十到几百毫秒，塞进心跳会跟索引
   * worker 抢锁。指纹漂移的照片本来就会被 `batch()` 重扫，不差这一会儿。权威数字仍以
   * `summary()`（走完整 `VALID`）为准。
   */
  counts() {
    return {
      scanned: this.db.prepare('SELECT COUNT(*) n FROM scans').get().n,
      faces: this.db.prepare('SELECT COUNT(*) n FROM faces').get().n,
      people: this.db
        .prepare(
          `SELECT COUNT(DISTINCT f.person_id) n FROM faces f
      JOIN scans s ON s.photo_id = f.photo_id WHERE s.version = ?`,
        )
        .get(VERSION).n,
    };
  }
  groups(after = 0) {
    const cursor = Number(after) || 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('FACE_ID_INVALID');
    const rows = this.source
      .prepare(
        `SELECT f.person_id id, g.name, COUNT(*) faceCount, COUNT(DISTINCT f.photo_id) photoCount, MIN(f.id) coverId
      FROM faceindex.faces f ${VALID} JOIN faceindex.people g ON g.id = f.person_id
      WHERE f.person_id > ? GROUP BY f.person_id ORDER BY f.person_id LIMIT 25`,
      )
      .all(VERSION, cursor);
    const more = rows.length > 24;
    const items = rows
      .slice(0, 24)
      .map((row) => ({ ...row, thumbnail: this.thumbnail(row.coverId) }));
    return { items, next: more ? items[items.length - 1].id : null };
  }
  thumbnail(faceId) {
    return (
      'data:image/jpeg;base64,' +
      this.db
        .prepare('SELECT thumbnail FROM faces WHERE id = ?')
        .get(faceId)
        .thumbnail.toString('base64')
    );
  }
  photos(personId, after = 0) {
    const cursor = Number(after) || 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('FACE_ID_INVALID');
    const rows = this.source
      .prepare(
        `SELECT f.id faceId, p.id, p.file_name, p.file_type, p.width, p.height, p.file_size, p.date_modified, p.has_thumbnail, p.is_favorite, f.box
      FROM faceindex.faces f ${VALID} WHERE f.person_id = ? AND f.id > ? ORDER BY f.id LIMIT 49`,
      )
      .all(VERSION, id(personId), cursor);
    const more = rows.length > 48;
    const items = rows
      .slice(0, 48)
      .map((row) => ({ ...row, box: JSON.parse(row.box), thumbnail: this.thumbnail(row.faceId) }));
    return { items, next: more ? items[items.length - 1].faceId : null };
  }
  rename(personId, name) {
    if (typeof name !== 'string' || name.trim().length > 80) throw new Error('FACE_NAME_INVALID');
    // 用户亲手改过名字 = 这个组从此是「手工命名」的锚点，不再随归组方式切换被重命名。
    if (
      !this.db
        .prepare("UPDATE people SET name = ?, name_source = '' WHERE id = ?")
        .run(name.trim(), id(personId)).changes
    )
      throw new Error('FACE_PERSON_MISSING');
    return {};
  }
  merge(from, to) {
    from = id(from);
    to = id(to);
    if (from === to) throw new Error('FACE_SAME_PERSON');
    this.db.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) n FROM people WHERE id IN (?, ?)').get(from, to).n !== 2)
        throw new Error('FACE_PERSON_MISSING');
      this.db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(to, from);
      this.db.prepare('DELETE FROM people WHERE id = ?').run(from);
    })();
    return {};
  }
  move(faceId, target) {
    let personId = target ? id(target) : null;
    this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM faces WHERE id = ?').get(id(faceId)))
        throw new Error('FACE_MISSING');
      if (personId && !this.db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId))
        throw new Error('FACE_PERSON_MISSING');
      if (!personId)
        personId = Number(
          this.db.prepare('INSERT INTO people DEFAULT VALUES').run().lastInsertRowid,
        );
      this.db.prepare('UPDATE faces SET person_id = ? WHERE id = ?').run(personId, id(faceId));
    })();
    return { personId };
  }
  close() {
    this.source.close();
    this.db.close();
  }
}
module.exports = {
  FaceStore,
  id,
  folderGroupKey,
  folderGroupName,
  groupingOptions,
  groupScore,
  chineseWhispers,
  K_NEIGHBORS,
  MAX_ITERATIONS,
  CW_SEED,
  AUTO_REGROUP_LIMIT,
};
