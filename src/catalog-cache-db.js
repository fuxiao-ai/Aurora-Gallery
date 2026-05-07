const Database = require('better-sqlite3');

function normalizeMediaKey(options) {
  options = options || {};
  var m = String(options.mediaType || '').toLowerCase();
  if (m === 'image') return 'image';
  if (m === 'video') return 'video';
  return 'all';
}

class CatalogCacheDb {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 8000');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_cache (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kv_cache_expires ON kv_cache(expires_at);
    `);
  }

  gcExpired(nowMs) {
    var now = Number(nowMs) || Date.now();
    try {
      this.db.prepare('DELETE FROM kv_cache WHERE expires_at <= ?').run(now);
    } catch (e) {
      void e;
    }
  }

  getJson(key, nowMs) {
    var now = Number(nowMs) || Date.now();
    try {
      var row = this.db
        .prepare('SELECT value_json, expires_at FROM kv_cache WHERE key = ? LIMIT 1')
        .get(String(key || ''));
      if (!row) return null;
      if (Number(row.expires_at) <= now) {
        this.db.prepare('DELETE FROM kv_cache WHERE key = ?').run(String(key || ''));
        return null;
      }
      return JSON.parse(String(row.value_json || 'null'));
    } catch (e) {
      return null;
    }
  }

  setJson(key, value, ttlMs) {
    var now = Date.now();
    var ttl = Math.max(1000, Number(ttlMs) || 0);
    var expiresAt = now + ttl;
    var raw = JSON.stringify(value == null ? null : value);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO kv_cache (key, value_json, updated_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(String(key || ''), raw, now, expiresAt);
  }

  deleteByPrefix(prefix) {
    this.db
      .prepare('DELETE FROM kv_cache WHERE key LIKE ? ESCAPE "\\"')
      .run(String(prefix || '') + '%');
  }

  clearAll() {
    this.db.prepare('DELETE FROM kv_cache').run();
  }

  keyRootFolders(mediaKey) {
    return 'rootFolders|media:' + String(mediaKey || 'all');
  }

  keyFolderTree(rootId, mediaKey) {
    return (
      'folderTree|root:' + String(parseInt(rootId, 10) || 0) + '|media:' + String(mediaKey || 'all')
    );
  }

  getRootFolders(options) {
    var mediaKey = normalizeMediaKey(options || {});
    return this.getJson(this.keyRootFolders(mediaKey));
  }

  setRootFolders(rows, options, ttlMs) {
    var mediaKey = normalizeMediaKey(options || {});
    this.setJson(this.keyRootFolders(mediaKey), Array.isArray(rows) ? rows : [], ttlMs);
  }

  getFolderTree(rootId, options) {
    var mediaKey = normalizeMediaKey(options || {});
    return this.getJson(this.keyFolderTree(rootId, mediaKey));
  }

  setFolderTree(rootId, rows, options, ttlMs) {
    var mediaKey = normalizeMediaKey(options || {});
    this.setJson(this.keyFolderTree(rootId, mediaKey), Array.isArray(rows) ? rows : [], ttlMs);
  }

  invalidateAllCatalogCaches() {
    this.deleteByPrefix('rootFolders|');
    this.deleteByPrefix('folderTree|');
  }

  invalidateByRootId(rootId) {
    var rid = parseInt(rootId, 10);
    if (!isFinite(rid) || rid <= 0) {
      this.invalidateAllCatalogCaches();
      return;
    }
    var mediaKeys = ['all', 'image', 'video'];
    var i;
    // 根目录统计是“全根列表”聚合，单根变动需失效所有 media 的根列表缓存。
    for (i = 0; i < mediaKeys.length; i++) {
      this.db.prepare('DELETE FROM kv_cache WHERE key = ?').run(this.keyRootFolders(mediaKeys[i]));
    }
    // 子目录树只删该 root 的缓存。
    for (i = 0; i < mediaKeys.length; i++) {
      this.db
        .prepare('DELETE FROM kv_cache WHERE key = ?')
        .run(this.keyFolderTree(rid, mediaKeys[i]));
    }
  }
}

module.exports = { CatalogCacheDb, normalizeMediaKey };
