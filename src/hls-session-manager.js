/**
 * FFmpeg HLS 边转边播（EVENT 列表，适合未整文件转完即可播放）
 */
'use strict';

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var { spawn } = require('child_process');

/** 默认：约 1GB 或最多 48 个已结束会话目录，超出则删最久未用的（不删正在转码的会话） */
var DEFAULT_HLS_MAX_BYTES = 1024 * 1024 * 1024;
var DEFAULT_HLS_MAX_ENTRIES = 48;

function HlsSessionManager(opts) {
  opts = opts || {};
  this.ffmpegPath = opts.ffmpegPath || null;
  this.rootDir = opts.rootDir || null;
  /** sessionId -> { child, photoId } */
  this.sessions = new Map();
  this.maxCacheBytes =
    opts.maxCacheBytes != null && opts.maxCacheBytes >= 0
      ? opts.maxCacheBytes
      : DEFAULT_HLS_MAX_BYTES;
  this.maxCacheEntries =
    opts.maxCacheEntries != null && opts.maxCacheEntries >= 1
      ? opts.maxCacheEntries
      : DEFAULT_HLS_MAX_ENTRIES;
  this._lastPruneAt = 0;
  /** 避免定时器与 ensure / stop 同时触发两次全量扫盘 */
  this._pruning = false;
  /** prune 执行中若再次触发，标记结束后补跑一次 */
  this._prunePending = false;
  /** 记录 prune 重入次数（用于日志统计） */
  this._prunePendingTriggers = 0;
}

HlsSessionManager.prototype._dir = function (sessionId) {
  return path.join(this.rootDir, sessionId);
};

HlsSessionManager.prototype._playlistPath = function (sessionId) {
  return path.join(this._dir(sessionId), 'stream.m3u8');
};

HlsSessionManager.prototype.stopSession = function (sessionId) {
  var sid = String(sessionId || '').trim();
  if (!/^[a-f0-9]{24}$/.test(sid)) return;
  var s = this.sessions.get(sid);
  if (!s) return;
  if (s.child) {
    try {
      s.child.kill();
    } catch (e) {}
  }
  this.sessions.delete(sid);
};

HlsSessionManager.prototype.stopAll = function () {
  var self = this;
  this.sessions.forEach(function (s, id) {
    self.stopSession(id);
  });
  this.sessions.clear();
};

HlsSessionManager.prototype._dirSizeSync = function (dir) {
  var total = 0;
  var stack = [dir];
  while (stack.length > 0) {
    var d = stack.pop();
    var list;
    try {
      list = fs.readdirSync(d);
    } catch (e) {
      continue;
    }
    for (var i = 0; i < list.length; i++) {
      var p = path.join(d, list[i]);
      var st;
      try {
        st = fs.statSync(p);
      } catch (e2) {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else {
        total += st.size;
      }
    }
  }
  return total;
};

/** 更新会话目录 mtime，供 LRU 判断「最近使用」 */
HlsSessionManager.prototype.touchSessionDir = function (sessionId) {
  var sid = String(sessionId || '').trim();
  if (!/^[a-f0-9]{24}$/.test(sid) || !this.rootDir) return;
  var d = this._dir(sid);
  if (!fs.existsSync(d)) return;
  var t = new Date();
  try {
    fs.utimesSync(d, t, t);
  } catch (e) {}
};

/**
 * 删除最久未访问的缓存目录（跳过 this.sessions 中正在跑的 FFmpeg）
 * @returns {{ removed: number, freedBytes: number }}
 */
HlsSessionManager.prototype.pruneHlsCacheLru = function () {
  if (!this.rootDir) {
    return { removed: 0, freedBytes: 0, pendingTriggers: 0, pendingReruns: 0 };
  }

  if (this._pruning) {
    this._prunePending = true;
    this._prunePendingTriggers = (this._prunePendingTriggers || 0) + 1;
    return { removed: 0, freedBytes: 0, pendingTriggers: 0, pendingReruns: 0 };
  }

  this._pruning = true;
  var removed = 0;
  var freed = 0;
  var startPendingTriggers = this._prunePendingTriggers || 0;
  var pendingReruns = 0;

  try {
    while (true) {
      var root = this.rootDir;
      var names;
      try {
        if (!fs.existsSync(root)) {
          return {
            removed: removed,
            freedBytes: freed,
            pendingTriggers: (this._prunePendingTriggers || 0) - startPendingTriggers,
            pendingReruns: pendingReruns,
          };
        }
        names = fs.readdirSync(root);
      } catch (e0) {
        return {
          removed: removed,
          freedBytes: freed,
          pendingTriggers: (this._prunePendingTriggers || 0) - startPendingTriggers,
          pendingReruns: pendingReruns,
        };
      }

      var protectedIds = this.sessions;
      var entries = [];
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if (!/^[a-f0-9]{24}$/.test(name)) continue;
        if (protectedIds.has(name)) continue;
        var d = path.join(root, name);
        try {
          var stat = fs.statSync(d);
          if (!stat.isDirectory()) continue;
          var sz = this._dirSizeSync(d);
          entries.push({ path: d, mtime: stat.mtimeMs, size: sz });
        } catch (e1) {}
      }

      entries.sort(function (a, b) {
        return a.mtime - b.mtime;
      });

      var totalBytes = 0;
      for (var j = 0; j < entries.length; j++) {
        totalBytes += entries[j].size;
      }

      var maxB = this.maxCacheBytes;
      var maxN = this.maxCacheEntries;
      var overCount = entries.length > maxN;
      var overBytes = maxB > 0 && totalBytes > maxB;

      while (overCount || overBytes) {
        if (entries.length === 0) break;
        var e = entries.shift();
        try {
          fs.rmSync(e.path, { recursive: true, force: true });
          totalBytes -= e.size;
          removed++;
          freed += e.size;
        } catch (e2) {}
        overCount = entries.length > maxN;
        overBytes = maxB > 0 && totalBytes > maxB;
      }

      var rerun = this._prunePending;
      this._prunePending = false;
      if (!rerun) break;
      pendingReruns++;
    }

    return {
      removed: removed,
      freedBytes: freed,
      pendingTriggers: (this._prunePendingTriggers || 0) - startPendingTriggers,
      pendingReruns: pendingReruns,
    };
  } finally {
    this._pruning = false;
  }
};

HlsSessionManager.prototype._maybePrune = function () {
  var now = Date.now();
  if (now - this._lastPruneAt < 8000) return;
  this._lastPruneAt = now;
  try {
    this.pruneHlsCacheLru();
  } catch (e) {}
};

HlsSessionManager.prototype._afterSessionUse = function (sessionId) {
  this.touchSessionDir(sessionId);
  this._maybePrune();
};

/**
 * @param {object} photo — db row，含 id, file_path
 * @param {function(Error|null, { sessionId: string }?)} cb
 */
HlsSessionManager.prototype.ensureSession = function (photo, cb) {
  var self = this;
  if (!this.ffmpegPath || !this.rootDir) {
    cb(new Error('hls_unavailable'));
    return;
  }
  var srcPath = photo.file_path;
  if (!srcPath || !fs.existsSync(srcPath)) {
    cb(new Error('source_missing'));
    return;
  }

  var st;
  try {
    st = fs.statSync(srcPath);
  } catch (e) {
    cb(e);
    return;
  }

  var key = String(photo.id) + '\0' + st.mtimeMs + '\0' + st.size;
  var sessionId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  if (!/^[a-f0-9]{24}$/.test(sessionId)) {
    cb(new Error('session_id'));
    return;
  }

  var dir = this._dir(sessionId);
  var playlistPath = this._playlistPath(sessionId);
  var active = this.sessions.get(sessionId);

  if (active && active.child) {
    this._afterSessionUse(sessionId);
    cb(null, { sessionId: sessionId });
    return;
  }

  try {
    if (fs.existsSync(playlistPath)) {
      var c = fs.readFileSync(playlistPath, 'utf8');
      var hasSeg = /\.(ts|m4s)\b/i.test(c);
      var ended = c.indexOf('#EXT-X-ENDLIST') >= 0;
      if (hasSeg && (ended || (active && active.child))) {
        this._afterSessionUse(sessionId);
        cb(null, { sessionId: sessionId });
        return;
      }
    }
  } catch (e2) {}

  try {
    fs.mkdirSync(dir, { recursive: true });
    var names = fs.readdirSync(dir);
    for (var i = 0; i < names.length; i++) {
      try {
        fs.unlinkSync(path.join(dir, names[i]));
      } catch (e3) {}
    }
  } catch (e4) {
    cb(e4);
    return;
  }

  var args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-i',
    srcPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_segment_filename',
    'seg%03d.ts',
    path.join(dir, 'stream.m3u8'),
  ];

  var child;
  try {
    child = spawn(this.ffmpegPath, args, { windowsHide: true, cwd: dir });
  } catch (e5) {
    cb(e5);
    return;
  }

  var rec = { child: child, photoId: photo.id };
  this.sessions.set(sessionId, rec);

  child.on('error', function () {
    if (self.sessions.get(sessionId) === rec) self.sessions.delete(sessionId);
  });
  child.stderr.on('data', function () {});
  child.on('close', function () {
    rec.child = null;
    if (self.sessions.get(sessionId) === rec) self.sessions.delete(sessionId);
  });

  this._waitForHlsReady(playlistPath, 20000, function (err) {
    if (err) {
      try {
        child.kill();
      } catch (e6) {}
      if (self.sessions.get(sessionId) === rec) self.sessions.delete(sessionId);
      cb(err);
      return;
    }
    self._afterSessionUse(sessionId);
    cb(null, { sessionId: sessionId });
  });
};

HlsSessionManager.prototype._waitForHlsReady = function (playlistPath, timeoutMs, cb) {
  var start = Date.now();
  var t = setInterval(function () {
    try {
      if (fs.existsSync(playlistPath)) {
        var s = fs.readFileSync(playlistPath, 'utf8');
        if (/\.(ts|m4s)\b/i.test(s)) {
          clearInterval(t);
          cb(null);
          return;
        }
      }
    } catch (e) {}
    if (Date.now() - start > timeoutMs) {
      clearInterval(t);
      cb(new Error('hls_start_timeout'));
    }
  }, 150);
};

module.exports = HlsSessionManager;
