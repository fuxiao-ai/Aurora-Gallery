'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { labelsAtIndexes, parseTags } = require('../ai/photo-tags');

/**
 * 「AI 内容标签」的**只读**通道（给照片信息面板用）。
 *
 * ## 为什么主进程要单独开一个连接
 *
 * 标签存在**搜图索引库**（`ai-search/semantic-index.sqlite` 的 `embeddings.tags`）里，
 * 不在 `photos` 表 —— 它是索引的派生物，随索引一起重建。而 `getPhotoInfo()` 走的是主库连接，
 * 跨不了库；把一个可能不存在的库 ATTACH 到**可写**的主库连接上风险更大（ATTACH/DETACH
 * 在写事务里会失败，而主库连接正是写闸门服务的对象）。所以这里照 `get-photo-dimensions`
 * 的先例另开一条独立的只读路径。
 *
 * ## 为什么不复用 IndexStore
 *
 * `IndexStore` 构造时会 ATTACH 主库（worker 需要 join photos 拿缩略图）。主进程已经有
 * 主库连接了，再挂一次既浪费又绕；面板只需要按主键取一行的 `tags`，轻量只读连接足够。
 *
 * ## 失败一律降级，绝不抛
 *
 * 索引库可能不存在（从没建过索引）、可能正被索引 worker 占着写锁、也可能刚重建过。
 * 这些都不是「错误」，只是「此刻读不到」→ 返回空数组，界面据此不显示这一行
 * （与「空值整行隐藏」的既定取向一致）。面板是只读展示，不该因为搜图索引的可用性而失败。
 */
class SemanticTags {
  constructor(aiPath) {
    this.aiPath = aiPath;
    this.connection = null;
    /** 已确认读不到（索引库不存在 / 打不开）→ 不再反复 stat，免得每张照片都白试一次。 */
    this.unavailable = false;
  }

  indexFile() {
    return path.join(this.aiPath, 'semantic-index.sqlite');
  }

  /**
   * 惰性建连接并复用。
   *
   * `readonly: true` 是硬要求：主进程这一侧**只读**，绝不写索引库（写是 worker 的唯一职责，
   * 两个写入者会互相拿到 `SQLITE_BUSY`）。`busy_timeout` 兜住 checkpoint 瞬间的锁。
   */
  conn() {
    if (this.connection) return this.connection;
    if (this.unavailable) return null;
    try {
      const file = this.indexFile();
      if (!fs.existsSync(file)) {
        this.unavailable = true;
        return null;
      }
      this.connection = new Database(file, { readonly: true, fileMustExist: true });
      this.connection.pragma('busy_timeout = 2000');
      return this.connection;
    } catch (_) {
      this.unavailable = true;
      return null;
    }
  }

  /**
   * 某张照片的标签文本（跟随 `locale`）。
   *
   * @returns {string[]} 空数组 = 「没索引 / 索引了但没标签 / 索引库此刻读不到」三者之一。
   *   三者都让面板隐藏这一行，所以不再细分成不同返回值 —— 需要区分时（比如将来做
   *   「搜图索引状态」字段）再扩展。
   */
  tagsFor(photoId, locale) {
    const id = Number(photoId);
    if (!Number.isFinite(id)) return [];
    const conn = this.conn();
    if (!conn) return [];
    try {
      const row = conn.prepare('SELECT tags FROM embeddings WHERE photo_id = ?').get(id);
      if (!row) return [];
      // 库里存的是**词表下标**（见 photo-tags.js），这里才映射成当前语言的文本。
      return labelsAtIndexes(parseTags(row.tags), locale);
    } catch (_) {
      // 查询本身失败（库被换掉 / 磁盘出错）：丢掉这个连接，下次重开，本次降级成空。
      this.close();
      return [];
    }
  }

  close() {
    if (this.connection) {
      try {
        this.connection.close();
      } catch (_) {}
      this.connection = null;
    }
  }
}

module.exports = { SemanticTags };
