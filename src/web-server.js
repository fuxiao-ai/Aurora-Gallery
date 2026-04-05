/**
 * web-server.js — 内嵌 HTTP 服务器
 * 在 Electron 主进程中启动，提供 REST API 让局域网浏览器查看相册
 * 使用 Node.js 原生 http 模块，无需额外依赖
 */

var http = require('http');
var fs = require('fs');
var zlib = require('zlib');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var childProcess = require('child_process');
var TextDecoder = require('util').TextDecoder;

var sharpModule = null;
function loadSharp() {
  if (!sharpModule) {
    sharpModule = require('sharp');
  }
  return sharpModule;
}
var playbackStrategy = require('./playback-strategy');
var HlsSessionManager = require('./hls-session-manager');
var runDbReadWorkerOnly = require('./db-read-runner').runDbReadWorkerOnly;

var RAW_EXTENSIONS = new Set(['.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raw']);

var VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.mpg',
  '.mpeg',
  '.m2ts',
  '.ts',
  '.3gp',
  '.3g2',
]);

var VIDEO_MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
};

var SUBTITLE_LANG_NAME_MAP = {
  zh: '中文',
  zho: '中文',
  chi: '中文',
  'zh-cn': '简体中文',
  'zh-hans': '简体中文',
  'zh-tw': '繁体中文',
  'zh-hant': '繁体中文',
  en: 'English',
  eng: 'English',
  ja: '日本語',
  jpn: '日本語',
  ko: '한국어',
  kor: '한국어',
  fr: 'Français',
  fre: 'Français',
  fra: 'Français',
  de: 'Deutsch',
  ger: 'Deutsch',
  deu: 'Deutsch',
  es: 'Español',
  spa: 'Español',
  ru: 'Русский',
  rus: 'Русский',
};

function fileExists(filePath) {
  return fs.promises
    .access(filePath, fs.constants.F_OK)
    .then(function () {
      return true;
    })
    .catch(function () {
      return false;
    });
}

function WebServer(db, port, opts) {
  this.db = db;
  this.port = port || 3456;
  opts = opts || {};
  /** HLS 输出根目录（网页 + 桌面走 127.0.0.1 时共用） */
  this.hlsRootDir = opts.hlsRootDir || null;
  /** ffmpeg-static 可执行路径 */
  this.ffmpegPath = opts.ffmpegPath || null;
  this.server = null;
  /** 仅在为 true 时允许非本机访问；默认关 */
  this.lanEnabled = opts.lanEnabled === true;
  this.webDir = path.join(__dirname, 'web');
  this.password = '';
  this.sessions = new Map();
  this.sessionTtlMs = 24 * 60 * 60 * 1000;

  // CORS 白名单：
  // - opts.corsAllowedOrigins: string[]，可填 origin（https://a.com）或 hostname（a.com / .a.com）
  // - 默认允许 localhost/127.0.0.1/本机局域网 IP/当前 Host
  this.corsAllowedOrigins = Array.isArray(opts.corsAllowedOrigins) ? opts.corsAllowedOrigins : [];
  /** 与桌面 settings.json 一致：目录 API 是否包含子文件夹 */
  this.getBrowseFolderIncludeSubfolders =
    typeof opts.getBrowseFolderIncludeSubfolders === 'function'
      ? opts.getBrowseFolderIncludeSubfolders
      : null;

  // /api/login 简单限流（按 IP）
  this.loginRate = {
    windowMs: opts.loginRateWindowMs != null ? Number(opts.loginRateWindowMs) : 5 * 60 * 1000,
    max: opts.loginRateMax != null ? Number(opts.loginRateMax) : 10,
  };
  this._loginRateState = new Map(); // ip -> { resetAt:number, hits:number }

  // RAW 预览：并发限制 + 缓存（避免高 CPU 与重复转码）
  this.rawPreview = {
    maxConcurrent:
      opts.rawPreviewMaxConcurrent != null ? Number(opts.rawPreviewMaxConcurrent) : 2,
    maxQueue: opts.rawPreviewMaxQueue != null ? Number(opts.rawPreviewMaxQueue) : 20,
    cacheMaxBytes:
      opts.rawPreviewCacheMaxBytes != null ? Number(opts.rawPreviewCacheMaxBytes) : 100 * 1024 * 1024,
    cacheMaxEntries:
      opts.rawPreviewCacheMaxEntries != null ? Number(opts.rawPreviewCacheMaxEntries) : 48,
    cacheTtlMs: opts.rawPreviewCacheTtlMs != null ? Number(opts.rawPreviewCacheTtlMs) : 10 * 60 * 1000,
    jpegQuality:
      opts.rawPreviewJpegQuality != null ? Number(opts.rawPreviewJpegQuality) : 88,
  };
  this._rawActive = 0;
  this._rawQueue = []; // { resolve, reject, createdAt }
  this._rawCache = new Map(); // key -> { buf, bytes, createdAt }
  this._rawCacheBytes = 0;
  /** 网页预览专用：缩小后的 JPEG 缓存（减轻大图局域网传输） */
  this._previewWebCache = new Map();
  this._previewWebCacheBytes = 0;
  /** 网页 /preview 走 sharp 转 JPEG 时的并发（与桌面 photo:// 同进程，过多并发会拖死左右切换） */
  this.previewJpegMaxConcurrent =
    opts.previewJpegMaxConcurrent != null ? Number(opts.previewJpegMaxConcurrent) : 2;
  this.previewJpegMaxQueue =
    opts.previewJpegMaxQueue != null ? Number(opts.previewJpegMaxQueue) : 48;
  this._previewJpegActive = 0;
  this._previewJpegQueue = [];
  /** 与桌面 IPC 一致：大聚合走只读 Worker，避免 /api 拖死主线程 */
  this.sqliteReadPath = typeof opts.sqliteReadPath === 'string' ? opts.sqliteReadPath : '';

  this.hlsManager =
    this.hlsRootDir && this.ffmpegPath
      ? new HlsSessionManager({
          ffmpegPath: this.ffmpegPath,
          rootDir: this.hlsRootDir,
          maxCacheBytes: opts.hlsMaxCacheBytes !== undefined ? opts.hlsMaxCacheBytes : undefined,
          maxCacheEntries:
            opts.hlsMaxCacheEntries !== undefined ? opts.hlsMaxCacheEntries : undefined,
        })
      : null;
  this._hlsPruneInterval = null;
}

// 获取本机局域网 IP（优先选择 192.168/10.x/172.16-31 段）
WebServer.prototype.getLocalIP = function () {
  var interfaces = os.networkInterfaces();
  var candidates = [];

  for (var name in interfaces) {
    for (var i = 0; i < interfaces[name].length; i++) {
      var iface = interfaces[name][i];
      if (!iface.internal && iface.family === 'IPv4') {
        var addr = iface.address;
        // 优先级：192.168 > 10.x > 172.16-31 > 其他
        var priority = 0;
        if (addr.startsWith('192.168.')) priority = 3;
        else if (addr.startsWith('10.')) priority = 2;
        else if (addr.startsWith('172.')) {
          var second = parseInt(addr.split('.')[1], 10);
          if (second >= 16 && second <= 31) priority = 2;
        }
        candidates.push({ addr: addr, priority: priority });
      }
    }
  }

  // 按优先级排序，取最高的
  candidates.sort(function (a, b) {
    return b.priority - a.priority;
  });
  return candidates.length > 0 ? candidates[0].addr : '127.0.0.1';
};

WebServer.prototype.start = function () {
  var self = this;

  this.server = http.createServer(function (req, res) {
    self.handleRequest(req, res);
  });

  return new Promise(function (resolve, reject) {
    self.server.on('error', function (err) {
      if (err.code === 'EADDRINUSE') {
        // 端口被占用，尝试下一个
        self.port++;
        self.server.close();
        self.server.listen(self.port);
      } else {
        reject(err);
      }
    });

    self.server.listen(self.port, '0.0.0.0', function () {
      if (self.hlsManager && typeof self.hlsManager.pruneHlsCacheLru === 'function') {
        self._runHlsPrune('startup');
        self._hlsPruneInterval = setInterval(
          function () {
            self._runHlsPrune('interval');
          },
          20 * 60 * 1000,
        );
      }
      resolve(self.port);
    });
  });
};

WebServer.prototype.stop = function () {
  if (this._hlsPruneInterval) {
    try {
      clearInterval(this._hlsPruneInterval);
    } catch (eI) {}
    this._hlsPruneInterval = null;
  }
  if (this.hlsManager) {
    try {
      this.hlsManager.stopAll();
    } catch (e) {}
    this._runHlsPrune('shutdown');
  }
  if (this.server) {
    this.server.close();
    this.server = null;
  }
};

WebServer.prototype._runHlsPrune = function (reason) {
  if (!this.hlsManager || typeof this.hlsManager.pruneHlsCacheLru !== 'function') return;
  var start = Date.now();
  try {
    var r = this.hlsManager.pruneHlsCacheLru() || {};
    var removed = Number(r.removed || 0);
    var freed = Number(r.freedBytes || 0);
    var pendingTriggers = Number(r.pendingTriggers || 0);
    var pendingReruns = Number(r.pendingReruns || 0);
    if (removed > 0 || freed > 0 || pendingTriggers > 0 || pendingReruns > 0) {
      var mb = (freed / (1024 * 1024)).toFixed(1);
      console.log(
        '[HLS] LRU prune (' +
          reason +
          ') removed=' +
          removed +
          ', freed=' +
          mb +
          'MB, cost=' +
          (Date.now() - start) +
          'ms' +
          ', pendingTriggers=' +
          pendingTriggers +
          ', pendingReruns=' +
          pendingReruns,
      );
    }
  } catch (e) {
    console.warn('[HLS] LRU prune failed (' + reason + '):', e && e.message ? e.message : e);
  }
};

WebServer.prototype.setPassword = function (pwd) {
  this.password = pwd || '';
  // 密码变更后让旧会话失效
  this.sessions.clear();
};

WebServer.prototype.handleRequest = function (req, res) {
  var parsedUrl = new URL(req.url, 'http://localhost');
  var pathname = parsedUrl.pathname;
  var query = Object.fromEntries(parsedUrl.searchParams.entries());

  this.applySecurityHeaders(res);

  // 局域网访问总开关：关闭时仅允许本机回环访问（桌面端与本机调试不受影响）
  if (!this.lanEnabled && !this.isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'lan_access_disabled' }));
    return;
  }

  // CORS：默认仅允许同源/本机/本机局域网 IP，避免任意网页跨站调用
  var corsOrigin = this.getAllowedCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(corsOrigin ? 204 : 403);
    res.end();
    return;
  }

  // /api/login 限流（尽量提前返回，避免被用来探测/压测）
  if (pathname === '/api/login') {
    var rl = this.checkLoginRateLimit(req);
    if (rl && rl.blocked) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
      });
      res.end(
        JSON.stringify({
          success: false,
          error: 'rate_limited',
          retryAfterMs: rl.retryAfterMs,
        }),
      );
      return;
    }
  }

  var loopbackPublic =
    this.isLoopback(req) &&
    (pathname.startsWith('/hls/') ||
      pathname === '/api/video-playback' ||
      pathname === '/api/video-subtitle' ||
      pathname === '/api/video-subtitle-streams' ||
      pathname === '/api/hls-stop');
  var pwaPublic =
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/app-icon.svg' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/app-icon-192.png' ||
    pathname === '/app-icon-512.png' ||
    pathname === '/favicon.ico';

  // 密码验证：检查 session cookie（本机回环访问 HLS / 播放 API 免密，供桌面端 Electron）
  if (
    this.password &&
    !this.isAuthenticated(req, { allowBearer: this.isLoopback(req) }) &&
    !loopbackPublic &&
    !pwaPublic
  ) {
    // 登录页面和登录 API 不需要验证
    if (pathname === '/login' || pathname === '/api/login') {
      // pass through
    } else {
      // 重定向到登录页（对 API 返回 401）
      if (pathname.startsWith('/api/')) {
        this.jsonResponse(res, { error: '需要登录' }, 401);
      } else {
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return;
    }
  }

  // 路由
  if (pathname === '/' || pathname === '/index.html') {
    this.serveStaticFile(res, 'index.html', 'text/html; charset=utf-8');
  } else if (pathname === '/login') {
    this.serveStaticFile(res, 'login.html', 'text/html; charset=utf-8');
  } else if (pathname === '/manifest.webmanifest') {
    this.serveStaticFile(
      res,
      'manifest.webmanifest',
      'application/manifest+json; charset=utf-8',
      'no-store, max-age=0',
    );
  } else if (pathname === '/sw.js') {
    this.serveStaticFile(
      res,
      'sw.js',
      'application/javascript; charset=utf-8',
      'no-store, max-age=0',
    );
  } else if (pathname === '/app-icon.svg') {
    this.serveStaticFile(
      res,
      'app-icon.svg',
      'image/svg+xml; charset=utf-8',
      'no-store, max-age=0',
    );
  } else if (pathname === '/apple-touch-icon.png') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'apple-touch-icon.png'),
      'image/png',
      'no-store, max-age=0',
    );
  } else if (pathname === '/app-icon-192.png') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'app-icon-192.png'),
      'image/png',
      'no-store, max-age=0',
    );
  } else if (pathname === '/app-icon-512.png') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'app-icon-512.png'),
      'image/png',
      'no-store, max-age=0',
    );
  } else if (pathname === '/favicon.ico') {
    // 兜底：部分浏览器/启动器仍会优先请求 favicon.ico
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'app-icon-192.png'),
      'image/png',
      'no-store, max-age=0',
    );
  } else if (pathname === '/api/login') {
    this.handleLogin(req, res);
  } else if (pathname === '/api/stats') {
    this.handleStats(req, res);
  } else if (pathname === '/api/photos') {
    this.handlePhotos(req, res, query);
  } else if (pathname === '/api/folder-photos') {
    this.handleFolderPhotos(req, res, query);
  } else if (pathname === '/api/date-groups') {
    this.handleDateGroups(req, res, query);
  } else if (pathname === '/api/date-photos') {
    this.handleDatePhotos(req, res, query);
  } else if (pathname === '/api/search') {
    this.handleSearch(req, res, query);
  } else if (pathname === '/api/preview-next') {
    this.handlePreviewNext(req, res, query);
  } else if (pathname === '/api/preview-random-batch') {
    this.handlePreviewRandomBatch(req, res, query);
  } else if (pathname === '/api/folder-tree') {
    this.handleFolderTree(req, res, query);
  } else if (pathname === '/api/folder-covers') {
    this.handleFolderCovers(req, res, query);
  } else if (pathname === '/api/immediate-subfolder-covers') {
    this.handleImmediateSubfolderCovers(req, res, query);
  } else if (pathname === '/api/root-folders') {
    this.handleRootFolders(req, res, query);
  } else if (pathname === '/thumb') {
    // 缩略图：/thumb/123
    this.handleThumb(res, '');
  } else if (pathname.startsWith('/thumb/')) {
    // 缩略图：/thumb/123
    this.handleThumb(res, pathname.substring(7));
  } else if (pathname.startsWith('/preview-image/')) {
    // 网页预览：限边长 JPEG，优先于原图整文件传输
    this.handlePreviewImage(req, res, pathname.substring(15));
  } else if (pathname === '/photo') {
    // 原图：/photo/123
    this.handlePhoto(req, res, '');
  } else if (pathname.startsWith('/photo/')) {
    // 原图：/photo/123
    this.handlePhoto(req, res, pathname.substring(7));
  } else if (pathname === '/video') {
    this.handleVideo(req, res, '');
  } else if (pathname.startsWith('/video/')) {
    // 视频流（支持 Range，供网页 <video> 拖动进度）
    this.handleVideo(req, res, pathname.substring(7));
  } else if (pathname === '/playback-strategy.js') {
    this.serveRepoFile(res, 'playback-strategy.js', 'application/javascript; charset=utf-8');
  } else if (pathname === '/hls-attach.js') {
    this.serveRepoFile(res, 'hls-attach.js', 'application/javascript; charset=utf-8');
  } else if (pathname === '/vendor/hls.min.js') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'vendor', 'hls.min.js'),
      'application/javascript; charset=utf-8',
    );
  } else if (pathname === '/js/app.js') {
    this.serveStaticFile(
      res,
      path.join('js', 'app.js'),
      'application/javascript; charset=utf-8',
      'no-store, max-age=0',
    );
  } else if (pathname === '/js/web-theme-shared.js') {
    this.serveStaticFile(
      res,
      path.join('js', 'web-theme-shared.js'),
      'application/javascript; charset=utf-8',
      'no-store, max-age=0',
    );
  } else if (pathname.startsWith('/hls/')) {
    this.handleHlsFile(req, res, pathname);
  } else if (pathname === '/api/video-playback') {
    this.handleVideoPlaybackApi(res, query);
  } else if (pathname === '/api/video-subtitle-streams') {
    this.handleVideoSubtitleStreamsApi(res, query);
  } else if (pathname === '/api/video-subtitle') {
    this.handleVideoSubtitleApi(res, query);
  } else if (pathname === '/api/hls-stop') {
    this.handleHlsStopApi(req, res, query);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
};

WebServer.prototype.setLanEnabled = function (enabled) {
  this.lanEnabled = !!enabled;
};

// === 静态文件服务 ===
WebServer.prototype.serveRepoFile = function (res, basename, contentType) {
  var filePath = path.join(__dirname, basename);
  fs.readFile(filePath, 'utf8', function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
};

WebServer.prototype.serveStaticFile = function (res, filename, contentType, cacheControl) {
  var filePath = path.join(this.webDir, filename);

  fs.readFile(filePath, 'utf8', function (err, data) {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl || 'public, max-age=60',
    });
    res.end(data);
  });
};

// === API Handlers ===

WebServer.prototype.handleStats = function (req, res) {
  var self = this;
  if (!self.sqliteReadPath) {
    self.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }
  runDbReadWorkerOnly(self.sqliteReadPath, 'getStats', {})
    .then(function (data) {
      self.jsonResponse(res, data, 200, req);
    })
    .catch(function (e2) {
      self.jsonResponse(res, { error: String(e2 && e2.message ? e2.message : e2) }, 500, req);
    });
};

WebServer.prototype.handlePhotos = function (req, res, query) {
  var options = this.parsePageOptions(query);
  options.lite = true;
  var result = this.db.getPhotos(options);
  this.jsonResponse(res, result, 200, req);
};

WebServer.prototype.handleFolderPhotos = function (req, res, query) {
  var folderPath = query.path;
  if (!folderPath) {
    this.jsonResponse(res, { error: 'path is required' }, 400, req);
    return;
  }
  var options = this.parsePageOptions(query);
  options.lite = true;
  if (options.includeSubfolders === undefined && typeof this.getBrowseFolderIncludeSubfolders === 'function') {
    options.includeSubfolders = this.getBrowseFolderIncludeSubfolders();
  }
  var result = this.db.getFolderPhotos(folderPath, options);
  this.jsonResponse(res, result, 200, req);
};

WebServer.prototype.handleDateGroups = function (req, res, query) {
  var options = {};
  if (query.rootId) options.rootId = parseInt(query.rootId);
  if (query.sortOrder) {
    var so = String(query.sortOrder).toLowerCase();
    options.sortOrder = so === 'asc' ? 'asc' : 'desc';
  }
  this.jsonResponse(res, this.db.getDateGroups(options), 200, req);
};

WebServer.prototype.handleDatePhotos = function (req, res, query) {
  var dateStr = query.date;
  if (!dateStr) {
    this.jsonResponse(res, { error: 'date is required' }, 400, req);
    return;
  }
  var options = this.parsePageOptions(query);
  options.lite = true;
  var result = this.db.getDatePhotos(dateStr, options);
  this.jsonResponse(res, result, 200, req);
};

WebServer.prototype.handleSearch = function (req, res, query) {
  var q = query.q;
  if (!q) {
    this.jsonResponse(res, { error: 'q is required' }, 400, req);
    return;
  }
  var options = this.parsePageOptions(query);
  options.lite = true;
  var result = this.db.searchPhotos(q, options);
  this.jsonResponse(res, result, 200, req);
};

WebServer.prototype.handlePreviewNext = function (req, res, query) {
  var currentId = parseInt(query.currentId, 10);
  if (!isFinite(currentId) || currentId <= 0) {
    this.jsonResponse(res, { error: 'currentId is required' }, 400, req);
    return;
  }
  var options = {
    currentId: currentId,
    view: query.view || 'all',
    rootId: query.rootId ? parseInt(query.rootId, 10) : undefined,
    path: query.path || '',
    date: query.date || '',
    q: query.q || '',
    mediaType: query.mediaType || query.media_filter || query.media || 'all',
    sortBy: query.sortBy || 'date_taken',
    sortOrder: query.sortOrder || 'DESC',
    direction: query.direction || 'next',
    mode: query.mode || 'sequential',
    seed: query.seed ? parseInt(query.seed, 10) : undefined,
  };
  if (
    options.view === 'folder' &&
    options.includeSubfolders === undefined &&
    typeof this.getBrowseFolderIncludeSubfolders === 'function'
  ) {
    options.includeSubfolders = this.getBrowseFolderIncludeSubfolders();
  }
  var photo = this.db.getPreviewAdjacentPhoto(options);
  this.jsonResponse(res, { photo: photo || null }, 200, req);
};

WebServer.prototype.handlePreviewRandomBatch = function (req, res, query) {
  var limit = query.limit ? parseInt(query.limit, 10) : 100;
  if (!isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 500) limit = 500;
  var options = {
    limit: limit,
    view: query.view || 'all',
    rootId: query.rootId ? parseInt(query.rootId, 10) : undefined,
    path: query.path ? String(query.path) : '',
    date: query.date ? String(query.date) : '',
    q: query.q ? String(query.q) : '',
    mediaType: query.mediaType || 'image',
  };
  if (query.excludeIds) {
    options.excludeIds = String(query.excludeIds)
      .split(',')
      .map(function (x) {
        return parseInt(x, 10);
      })
      .filter(function (n) {
        return isFinite(n) && n > 0;
      });
  }
  if (
    options.view === 'folder' &&
    options.includeSubfolders === undefined &&
    typeof this.getBrowseFolderIncludeSubfolders === 'function'
  ) {
    options.includeSubfolders = this.getBrowseFolderIncludeSubfolders();
  }
  var photos = this.db.getRandomPreviewPhotoBatch(options) || [];
  this.jsonResponse(res, { photos: photos }, 200, req);
};

WebServer.prototype.handleFolderTree = function (req, res, query) {
  var self = this;
  var rootId = parseInt(query.rootId);
  if (!rootId) {
    self.jsonResponse(res, { error: 'rootId is required' }, 400, req);
    return;
  }
  if (!self.sqliteReadPath) {
    self.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }
  runDbReadWorkerOnly(self.sqliteReadPath, 'getFolderTree', { rootId: rootId })
    .then(function (data) {
      self.jsonResponse(res, data, 200, req);
    })
    .catch(function (e) {
      self.jsonResponse(res, { error: String(e && e.message ? e.message : e) }, 500, req);
    });
};

WebServer.prototype.handleFolderCovers = function (req, res, query) {
  var self = this;
  var options = self.parsePageOptions(query || {});
  if (!self.sqliteReadPath) {
    self.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }
  runDbReadWorkerOnly(self.sqliteReadPath, 'getFolderCovers', options)
    .then(function (data) {
      self.jsonResponse(res, data, 200, req);
    })
    .catch(function (e) {
      self.jsonResponse(res, { error: String(e && e.message ? e.message : e) }, 500, req);
    });
};

WebServer.prototype.handleImmediateSubfolderCovers = function (req, res, query) {
  var self = this;
  if (!self.sqliteReadPath) {
    self.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }
  var parentPath = (query.parentPath || '').trim();
  if (!parentPath) {
    self.jsonResponse(res, [], 200, req);
    return;
  }
  var mediaType = query.mediaType || query.media_filter || query.media;
  var parentPathNormalized = parentPath.replace(/\\/g, '/');

  // Find rootId first
  runDbReadWorkerOnly(self.sqliteReadPath, 'findRootIdByPath', { path: parentPathNormalized })
    .then(function (rootResult) {
      var rootId = rootResult && rootResult.rootId ? parseInt(rootResult.rootId, 10) : null;
      if (!rootId) {
        self.jsonResponse(res, [], 200, req);
        return;
      }
      // Get full folder tree for this root (same as folder-tree API)
      runDbReadWorkerOnly(self.sqliteReadPath, 'getFolderTree', rootId)
        .then(function (folderTreeResult) {
          var flatRows = Array.isArray(folderTreeResult) ? folderTreeResult : [];
          if (!Array.isArray(flatRows) || flatRows.length === 0) {
            self.jsonResponse(res, [], 200, req);
            return;
          }
          // Aggregate to get immediate child folder summaries (same as desktop)
          runDbReadWorkerOnly(self.sqliteReadPath, 'aggregateImmediateSubfolderSummaries', {
            parentPath: parentPathNormalized,
            flatRows: flatRows,
          })
            .then(function (summaries) {
              if (!Array.isArray(summaries) || summaries.length === 0) {
                self.jsonResponse(res, [], 200, req);
                return;
              }
              var childPaths = summaries.map(function (s) {
                return s.folder_path;
              });
              // Now get covers
              runDbReadWorkerOnly(self.sqliteReadPath, 'getImmediateSubfolderCovers', {
                parentPath: parentPathNormalized,
                childPaths: childPaths,
                rootId: rootId,
                mediaType: mediaType,
              })
                .then(function (covers) {
                  // Merge summary counts from summaries with covers
                  var merged = [];
                  for (var i = 0; i < summaries.length; i++) {
                    var sum = summaries[i];
                    var cover = null;
                    for (var j = 0; j < covers.length; j++) {
                      if (covers[j].folder_path === sum.folder_path) {
                        cover = covers[j];
                        break;
                      }
                    }
                    merged.push({
                      folder_path: sum.folder_path,
                      folder_photo_count: sum.folder_photo_count,
                      id: cover ? cover.id : null,
                      has_thumbnail: cover ? cover.has_thumbnail: false,
                      file_name: cover ? cover.file_name: '',
                    });
                  }
                  self.jsonResponse(res, merged, 200, req);
                })
                .catch(function (e) {
                  self.jsonResponse(res, { error: String(e && e.message ? e.message : e) }, 500, req);
                });
            })
            .catch(function (e) {
              self.jsonResponse(res, { error: String(e && e.message ? e.message : e) }, 500, req);
            });
        })
        .catch(function (e) {
          self.jsonResponse(res, { error: String(e && e.message ? e.message : e) }, 500, req);
        });
    })
    .catch(function (e) {
      self.jsonResponse(res, { error: String(e && e.message ? e.message : e) }, 500, req);
    });
};

WebServer.prototype.handleRootFolders = function (req, res, query) {
  var self = this;
  var q = query || {};
  var options = self.parsePageOptions(q);
  if (q.lite === '1' || q.lite === 'true') options.lite = true;

  function mergeIfFull(rows) {
    var first = rows && rows.length ? rows[0] : null;
    if (
      options.lite !== true &&
      first &&
      first.photo_count != null &&
      self.db &&
      typeof self.db.mergeRootFolderStatsCache === 'function' &&
      Array.isArray(rows) &&
      rows.length > 0
    ) {
      try {
        self.db.mergeRootFolderStatsCache(rows, options);
      } catch (eC) {
        void eC;
      }
    }
  }

  if (!self.sqliteReadPath) {
    self.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }

  runDbReadWorkerOnly(self.sqliteReadPath, 'getRootFolders', options)
    .then(function (rows) {
      mergeIfFull(rows);
      self.jsonResponse(res, rows, 200, req);
    })
    .catch(function (e2) {
      self.jsonResponse(res, { error: String(e2 && e2.message ? e2.message : e2) }, 500, req);
    });
};

WebServer.prototype.handleThumb = function (res, idStr) {
  var self = this;
  function sendPngFallback() {
    var fallback = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
      'base64',
    );
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(fallback);
  }

  var photoId = parseInt(idStr, 10);
  if (isNaN(photoId)) {
    res.writeHead(400);
    res.end('Invalid photo ID');
    return;
  }

  var photo = this.db.getThumbnail(photoId);
  if (photo && photo.thumbnail) {
    var buf = Buffer.isBuffer(photo.thumbnail) ? photo.thumbnail : Buffer.from(photo.thumbnail);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(buf);
    return;
  }

  var full = this.db.getFullPhoto(photoId);
  if (full && full.file_path) {
    var ext = path.extname(full.file_path).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) {
      var videoFrameThumb = require('./video-frame-thumb');
      void (async function () {
        try {
          var topts = { size: 256, quality: 75, ffmpegPath: self.ffmpegPath || null };
          var jpeg = await videoFrameThumb.extractVideoFrameJpeg(full.file_path, topts);
          if (!jpeg) {
            jpeg = await videoFrameThumb.buildVideoPlaceholderJpeg({
              size: topts.size,
              quality: topts.quality,
            });
          }
          if (jpeg && jpeg.length) {
            try {
              self.db.updatePhotoThumbnail(photoId, jpeg);
            } catch (eUp) {}
            res.writeHead(200, {
              'Content-Type': 'image/jpeg',
              'Content-Length': jpeg.length,
              'Cache-Control': 'public, max-age=86400',
            });
            res.end(jpeg);
            return;
          }
        } catch (e) {}
        sendPngFallback();
      })();
      return;
    }
  }

  sendPngFallback();
};

WebServer.prototype.handlePhoto = async function (req, res, idStr) {
  var photoId = parseInt(idStr, 10);
  if (isNaN(photoId)) {
    res.writeHead(400);
    res.end('Invalid photo ID');
    return;
  }

  var photo = this.db.getFullPhoto(photoId);
  if (photo && photo.file_path) {
    try {
      var ext = path.extname(photo.file_path).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        res.writeHead(302, { Location: '/video/' + photoId });
        res.end();
        return;
      }
      if (RAW_EXTENSIONS.has(ext)) {
        this.serveRawPreviewJpeg(req, res, photo.file_path);
        return;
      }
      var mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
      };
      var contentType = mimeMap[ext] || 'image/jpeg';
      var st = await fs.promises.stat(photo.file_path);
      if (!st || !st.isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      this.serveFileWithRange(req, res, photo.file_path, st.size, contentType, 'public, max-age=3600');
    } catch (e) {
      res.writeHead(500);
      res.end('Error reading file');
    }
  } else {
    var fallback = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
      'base64',
    );
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(fallback);
  }
};

WebServer.prototype.handleVideo = async function (req, res, idStr) {
  var photoId = parseInt(idStr, 10);
  if (isNaN(photoId)) {
    res.writeHead(400);
    res.end('Invalid photo ID');
    return;
  }

  var photo = this.db.getFullPhoto(photoId);
  if (!photo || !photo.file_path) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  var fp = photo.file_path;
  if (!(await fileExists(fp))) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  this.serveVideoStream(req, res, fp);
};

/** 与 Electron video:// 一致：按字节 Range 输出，便于浏览器内嵌播放与拖动进度条 */
WebServer.prototype.serveVideoStream = async function (req, res, filePath) {
  var ext = path.extname(filePath).toLowerCase();
  var contentType = VIDEO_MIME_BY_EXT[ext] || 'video/mp4';

  var stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  var size = Number(stat && stat.size) || 0;
  if (!size) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  var range = req.headers && req.headers.range ? String(req.headers.range) : null;

  if (range && /^bytes=\d*-\d*$/.test(range)) {
    var m = range.match(/^bytes=(\d*)-(\d*)$/);
    var start = m && m[1] ? parseInt(m[1], 10) : 0;
    var end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end < 0) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, {
        'Content-Range': 'bytes */' + size,
      });
      res.end();
      return;
    }
    if (end >= size) end = size - 1;

    var chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });
    var rs = fs.createReadStream(filePath, { start: start, end: end });
    rs.on('error', function () {
      try {
        res.destroy();
      } catch (e) {}
    });
    rs.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
  });
  var rs2 = fs.createReadStream(filePath);
  rs2.on('error', function () {
    try {
      res.destroy();
    } catch (e2) {}
  });
  rs2.pipe(res);
};

/** 直链 / HLS 边转边播（同一 API 供网页与桌面 127.0.0.1 调用） */
WebServer.prototype.handleVideoPlaybackApi = async function (res, query) {
  var id = parseInt(query.id, 10);
  if (isNaN(id)) {
    this.jsonResponse(res, { error: 'invalid id' }, 400);
    return;
  }
  var photo = this.db.getFullPhoto(id);
  if (!photo || !photo.file_path) {
    this.jsonResponse(res, { error: 'not_found' }, 404);
    return;
  }
  if (!(await fileExists(photo.file_path))) {
    this.jsonResponse(res, { error: 'not_found' }, 404);
    return;
  }

  var extDot = path.extname(photo.file_path).toLowerCase();
  var fileType = photo.file_type
    ? String(photo.file_type).toLowerCase()
    : extDot.replace(/^\./, '');
  var r = playbackStrategy.resolveWebVideoPlayback(fileType);

  if (r.tier === 'none') {
    this.jsonResponse(res, { error: 'not_video' }, 400);
    return;
  }
  if (r.tier === 'direct_stream') {
    this.jsonResponse(res, {
      tier: 'direct_stream',
      mode: 'progressive',
      ready: true,
      url: playbackStrategy.webDirectStreamUrl(id),
    });
    return;
  }

  if (!this.hlsManager || !this.ffmpegPath) {
    this.jsonResponse(res, {
      tier: 'hls_transcode',
      mode: 'hls',
      ready: false,
      error: 'hls_unavailable',
      message: '未配置 HLS 目录或 FFmpeg',
    });
    return;
  }

  var self = this;
  this.hlsManager.ensureSession(photo, function (err, result) {
    if (err) {
      self.jsonResponse(res, {
        tier: 'hls_transcode',
        mode: 'hls',
        ready: false,
        error: 'hls_failed',
        message: err.message || String(err),
      });
      return;
    }
    var pl = playbackStrategy.hlsPlaylistPath(result.sessionId);
    self.jsonResponse(res, {
      tier: 'hls_transcode',
      mode: 'hls',
      ready: true,
      playlistUrl: pl,
      sessionId: result.sessionId,
    });
  });
};

WebServer.prototype.srtToVtt = function (srtText) {
  var text = String(srtText || '');
  // 去掉 UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  // 兼容 SRT 常见变体：H:MM:SS,mmm / HH:MM:SS.mmm / 箭头两侧任意空白
  var body = text.replace(
    /(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})\s*[,.]\s*(\d{1,3})\s*-->\s*(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})\s*[,.]\s*(\d{1,3})/g,
    function (_m, h1, m1, s1, ms1, h2, m2, s2, ms2) {
      function norm(h, m, s, ms) {
        var hh = String(parseInt(h, 10) || 0).padStart(2, '0');
        var mm = String(parseInt(m, 10) || 0).padStart(2, '0');
        var ss = String(parseInt(s, 10) || 0).padStart(2, '0');
        var msec = String(parseInt(ms, 10) || 0).padStart(3, '0').slice(0, 3);
        return hh + ':' + mm + ':' + ss + '.' + msec;
      }
      return norm(h1, m1, s1, ms1) + ' --> ' + norm(h2, m2, s2, ms2);
    },
  );
  return 'WEBVTT\n\n' + body;
};

WebServer.prototype.normalizeVttTimeline = function (vttText) {
  var text = String(vttText || '');
  return text.replace(
    /(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})\s*[,.]\s*(\d{1,3})\s*-->\s*(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})\s*[,.]\s*(\d{1,3})/g,
    function (_m, h1, m1, s1, ms1, h2, m2, s2, ms2) {
      function norm(h, m, s, ms) {
        var hh = String(parseInt(h, 10) || 0).padStart(2, '0');
        var mm = String(parseInt(m, 10) || 0).padStart(2, '0');
        var ss = String(parseInt(s, 10) || 0).padStart(2, '0');
        var msec = String(parseInt(ms, 10) || 0).padStart(3, '0').slice(0, 3);
        return hh + ':' + mm + ':' + ss + '.' + msec;
      }
      return norm(h1, m1, s1, ms1) + ' --> ' + norm(h2, m2, s2, ms2);
    },
  );
};

WebServer.prototype.assTimeToVttTime = function (t) {
  // ASS: H:MM:SS.cc -> WebVTT: HH:MM:SS.mmm
  var m = String(t || '').trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/);
  if (!m) return '';
  var hh = m[1].padStart(2, '0');
  var mm = m[2];
  var ss = m[3];
  var cs = m[4].padStart(2, '0');
  return hh + ':' + mm + ':' + ss + '.' + cs + '0';
};

WebServer.prototype.assToVtt = function (assText) {
  var text = String(assText || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  var lines = text.split(/\r?\n/);
  var out = ['WEBVTT', ''];
  var idx = 1;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!/^Dialogue:/i.test(line)) continue;
    var body = line.replace(/^Dialogue:\s*/i, '');
    var parts = body.split(',');
    if (parts.length < 10) continue;
    var start = this.assTimeToVttTime(parts[1]);
    var end = this.assTimeToVttTime(parts[2]);
    if (!start || !end) continue;
    var txt = parts.slice(9).join(',');
    txt = txt.replace(/\{[^}]*\}/g, '');
    txt = txt.replace(/\\N/gi, '\n');
    txt = txt.replace(/\\n/gi, '\n');
    txt = txt.trim();
    if (!txt) continue;
    out.push(String(idx++));
    out.push(start + ' --> ' + end);
    out.push(txt);
    out.push('');
  }
  return out.join('\n');
};

WebServer.prototype.decodeSubtitleBuffer = function (buf) {
  if (!buf) return '';
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length === 0) return '';

  // BOM 优先
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    var swapped = Buffer.allocUnsafe(buf.length - 2);
    for (var i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }

  var candidates = ['utf8', 'utf16le'];
  // 常见中文字幕编码兜底（依赖 Node ICU，失败会自动跳过）
  candidates.push('gb18030', 'gbk', 'big5');
  var best = '';
  var bestScore = -1;
  for (var j = 0; j < candidates.length; j++) {
    var text;
    try {
      if (candidates[j] === 'utf8' || candidates[j] === 'utf16le') {
        text = buf.toString(candidates[j]);
      } else {
        text = new TextDecoder(candidates[j]).decode(buf);
      }
    } catch (e0) {
      continue;
    }
    if (!text) continue;
    var timelineMatches = text.match(
      /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/g,
    );
    var timelineCount = timelineMatches ? timelineMatches.length : 0;
    var score = 0;
    if (/WEBVTT\b/i.test(text)) score += 6;
    if (timelineCount > 0) score += 18 + Math.min(60, timelineCount);
    else if (/-->\s*\d{2}:\d{2}:\d{2}/.test(text) || /\d{2}:\d{2}:\d{2}\s*-->/.test(text)) score += 6;
    if (/^Dialogue:/im.test(text)) score += 5;
    var replacementCount = (text.match(/\ufffd/g) || []).length;
    score -= Math.min(8, replacementCount);
    if (score > bestScore) {
      bestScore = score;
      best = text;
    }
  }
  return best || buf.toString('utf8');
};

WebServer.prototype.convertSubtitleFileToVttByFfmpeg = function (subtitlePath, cb) {
  cb = typeof cb === 'function' ? cb : function () {};
  if (!subtitlePath) {
    cb(new Error('subtitle_not_found'));
    return;
  }
  if (!this.ffmpegPath) {
    cb(new Error('ffmpeg_unavailable'));
    return;
  }
  var self = this;
  fileExists(subtitlePath).then(function (exists) {
    if (!exists) {
      cb(new Error('subtitle_not_found'));
      return;
    }
  var child;
  try {
    child = childProcess.spawn(self.ffmpegPath, ['-v', 'error', '-i', subtitlePath, '-f', 'webvtt', '-'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    cb(e);
    return;
  }
  var out = '';
  var err = '';
  var done = false;
  var maxBytes = 2 * 1024 * 1024;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    try {
      child.kill('SIGKILL');
    } catch (e0) {}
    cb(new Error('subtitle_convert_timeout'));
  }, 12000);
  child.stdout.on('data', function (chunk) {
    if (done) return;
    out += chunk ? chunk.toString('utf8') : '';
    if (Buffer.byteLength(out, 'utf8') > maxBytes) {
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch (e1) {}
      cb(new Error('subtitle_too_large'));
    }
  });
  child.stderr.on('data', function (chunk) {
    if (done) return;
    err += chunk ? chunk.toString('utf8') : '';
  });
  child.on('error', function (e) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(e);
  });
  child.on('close', function (code) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    var text = String(out || '').trim();
    if (code !== 0 || !text) {
      cb(new Error(err || 'subtitle_convert_failed'));
      return;
    }
    if (!/^WEBVTT\b/i.test(text)) text = 'WEBVTT\n\n' + text;
    cb(null, text + '\n');
  });
  });
};

WebServer.prototype.handleVideoSubtitleApi = async function (res, query) {
  var id = parseInt(query.id, 10);
  if (isNaN(id)) {
    this.jsonResponse(res, { error: 'invalid id' }, 400);
    return;
  }
  var photo = this.db.getFullPhoto(id);
  if (!photo || !photo.file_path || !(await fileExists(photo.file_path))) {
    this.jsonResponse(res, { error: 'not_found' }, 404);
    return;
  }
  var ext = path.extname(photo.file_path);
  var base = photo.file_path.slice(0, photo.file_path.length - ext.length);
  var subtitlePath = '';
  var subtitleDebugCandidates = [];
  var directCandidates = [base + '.vtt', base + '.srt', base + '.ass', base + '.ssa'];
  for (var i = 0; i < directCandidates.length; i++) {
    if (await fileExists(directCandidates[i])) {
      subtitlePath = directCandidates[i];
      break;
    }
  }
  if (!subtitlePath) {
    try {
      var dir = path.dirname(photo.file_path);
      var videoStem = path.basename(base).toLowerCase();
      var exts = { '.vtt': true, '.srt': true, '.ass': true, '.ssa': true };
      var entries = await fs.promises.readdir(dir);
      var preferred = '';
      function normalizeStem(s) {
        return String(s || '')
          .toLowerCase()
          .replace(/\[[^\]]*\]/g, ' ')
          .replace(/\([^)]*\)/g, ' ')
          .replace(/\{[^}]*\}/g, ' ')
          .replace(/[._-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      var videoNorm = normalizeStem(videoStem);
      for (var ei = 0; ei < entries.length; ei++) {
        var name = String(entries[ei] || '');
        if (!name) continue;
        var ext2 = path.extname(name).toLowerCase();
        if (!exts[ext2]) continue;
        subtitleDebugCandidates.push(name);
        var stem = path.basename(name, ext2).toLowerCase();
        var stemNorm = normalizeStem(stem);
        // 只要“字幕文件名包含视频文件名”就命中（含归一化兜底）
        var hit = false;
        if (stem.indexOf(videoStem) >= 0) hit = true;
        else if (videoNorm && stemNorm && stemNorm.indexOf(videoNorm) >= 0) hit = true;
        if (hit) {
          preferred = path.join(dir, name);
          break;
        }
      }
      subtitlePath = preferred || '';
    } catch (eScan) {}
  }
  var streamIndex = parseInt(query.stream, 10);
  var hasStreamIndex = !isNaN(streamIndex) && streamIndex >= 0;
  var ffStreamIndex = parseInt(query.ffStream, 10);
  var hasFfStreamIndex = !isNaN(ffStreamIndex) && ffStreamIndex >= 0;
  var self = this;
  function serveExternalSubtitle() {
    self.convertSubtitleFileToVttByFfmpeg(subtitlePath, function (_ffErr, ffVtt) {
      var subtitleSourceName = path.basename(subtitlePath || '');
      var subtitleSourceHeader = encodeURIComponent(subtitleSourceName);
      if (ffVtt) {
        ffVtt = self.normalizeVttTimeline(ffVtt);
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
          'X-Photo-Subtitle-Source': subtitleSourceHeader,
        });
        res.end(ffVtt);
        return;
      }
      fs.readFile(subtitlePath, function (err, subtitleBuf) {
        if (err) {
          self.jsonResponse(res, { error: 'subtitle_read_failed' }, 500);
          return;
        }
        var subtitleText = self.decodeSubtitleBuffer(subtitleBuf);
        var subExt = path.extname(subtitlePath).toLowerCase();
        var vtt;
        if (subExt === '.vtt') {
          vtt = String(subtitleText || '');
          if (!/^WEBVTT\b/i.test(vtt.trim())) vtt = 'WEBVTT\n\n' + vtt;
        } else if (subExt === '.ass' || subExt === '.ssa') {
          vtt = self.assToVtt(subtitleText);
        } else {
          vtt = self.srtToVtt(subtitleText);
        }
        vtt = self.normalizeVttTimeline(vtt);
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
          'X-Photo-Subtitle-Source': subtitleSourceHeader,
        });
        res.end(vtt);
      });
    });
  }
  if (!subtitlePath || hasStreamIndex || hasFfStreamIndex) {
    var self0 = this;
    this.extractEmbeddedSubtitleVtt(
      photo.file_path,
      hasFfStreamIndex ? ffStreamIndex : null,
      hasStreamIndex ? streamIndex : 0,
      function (err0, vtt0) {
      if (err0 || !vtt0) {
        self0.jsonResponse(
          res,
          {
            error: 'subtitle_not_found',
            debug: {
              matchedExternal: !!subtitlePath,
              selectedExternalName: subtitlePath ? path.basename(subtitlePath) : '',
              externalCandidates: subtitleDebugCandidates,
              requestedStream: hasStreamIndex ? streamIndex : null,
              requestedFfStream: hasFfStreamIndex ? ffStreamIndex : null,
            },
          },
          404,
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
      });
      res.end(vtt0);
      },
    );
    return;
  }
  serveExternalSubtitle();
};

WebServer.prototype.handleVideoSubtitleStreamsApi = async function (res, query) {
  var id = parseInt(query.id, 10);
  if (isNaN(id)) {
    this.jsonResponse(res, { error: 'invalid id' }, 400);
    return;
  }
  var photo = this.db.getFullPhoto(id);
  if (!photo || !photo.file_path || !(await fileExists(photo.file_path))) {
    this.jsonResponse(res, { error: 'not_found' }, 404);
    return;
  }
  var hasExternal = false;
  try {
    var ext = path.extname(photo.file_path);
    var base = photo.file_path.slice(0, photo.file_path.length - ext.length);
    var directCandidates = [base + '.vtt', base + '.srt', base + '.ass', base + '.ssa'];
    for (var i = 0; i < directCandidates.length; i++) {
      if (await fileExists(directCandidates[i])) {
        hasExternal = true;
        break;
      }
    }
    if (!hasExternal) {
      var dir = path.dirname(photo.file_path);
      var videoStem = path.basename(base).toLowerCase();
      var exts = { '.vtt': true, '.srt': true, '.ass': true, '.ssa': true };
      var entries = await fs.promises.readdir(dir);
      function normalizeStem(s) {
        return String(s || '')
          .toLowerCase()
          .replace(/\[[^\]]*\]/g, ' ')
          .replace(/\([^)]*\)/g, ' ')
          .replace(/\{[^}]*\}/g, ' ')
          .replace(/[._-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      var videoNorm = normalizeStem(videoStem);
      for (var ei = 0; ei < entries.length; ei++) {
        var name = String(entries[ei] || '');
        if (!name) continue;
        var ext2 = path.extname(name).toLowerCase();
        if (!exts[ext2]) continue;
        var stem = path.basename(name, ext2).toLowerCase();
        var stemNorm = normalizeStem(stem);
        if (stem.indexOf(videoStem) >= 0 || (videoNorm && stemNorm && stemNorm.indexOf(videoNorm) >= 0)) {
          hasExternal = true;
          break;
        }
      }
    }
  } catch (eScan) {
    void eScan;
  }
  this.listEmbeddedSubtitleStreams(photo.file_path, function (err, tracks) {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ tracks: [], hasExternal: hasExternal }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ tracks: Array.isArray(tracks) ? tracks : [], hasExternal: hasExternal }));
  });
};

WebServer.prototype.extractEmbeddedSubtitleVtt = function (videoPath, ffStreamIndex, streamIndex, cb) {
  cb = typeof cb === 'function' ? cb : function () {};
  if (!videoPath) {
    cb(new Error('video_not_found'));
    return;
  }
  if (!this.ffmpegPath) {
    cb(new Error('ffmpeg_unavailable'));
    return;
  }
  var self = this;
  fileExists(videoPath).then(function (exists) {
    if (!exists) {
      cb(new Error('video_not_found'));
      return;
    }
  var fsi = parseInt(ffStreamIndex, 10);
  var si = parseInt(streamIndex, 10);
  if (isNaN(si) || si < 0) si = 0;
  function runExtractWithMap(mapArg, done) {
    var args = ['-v', 'error', '-i', videoPath, '-map', mapArg, '-f', 'webvtt', '-'];
    var child;
    try {
      child = childProcess.spawn(self.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      done(e);
      return;
    }
    var out = '';
    var err = '';
    var finished = false;
    var maxBytes = 2 * 1024 * 1024;
    var timeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch (e0) {}
      done(new Error('subtitle_extract_timeout'));
    }, 12000);
    child.stdout.on('data', function (chunk) {
      if (finished) return;
      out += chunk ? chunk.toString('utf8') : '';
      if (Buffer.byteLength(out, 'utf8') > maxBytes) {
        finished = true;
        clearTimeout(timeout);
        try {
          child.kill('SIGKILL');
        } catch (e1) {}
        done(new Error('subtitle_too_large'));
      }
    });
    child.stderr.on('data', function (chunk) {
      if (finished) return;
      err += chunk ? chunk.toString('utf8') : '';
    });
    child.on('error', function (e) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      done(e);
    });
    child.on('close', function (code) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      var text = String(out || '').trim();
      if (code !== 0 || !text) {
        done(new Error(err || 'subtitle_extract_failed'));
        return;
      }
      if (!/^WEBVTT\b/i.test(text)) text = 'WEBVTT\n\n' + text;
      text = self.normalizeVttTimeline(text);
      done(null, text + '\n');
    });
  }

  var tried = [];
  var preferredMap = !isNaN(fsi) && fsi >= 0 ? '0:' + String(fsi) : '0:s:' + String(si);
  var fallbackMap = !isNaN(fsi) && fsi >= 0 ? '0:s:' + String(si) : '';
  function next(errFromPrev) {
    var mapArg = '';
    if (tried.indexOf(preferredMap) < 0) mapArg = preferredMap;
    else if (fallbackMap && tried.indexOf(fallbackMap) < 0) mapArg = fallbackMap;
    if (!mapArg) {
      cb(errFromPrev || new Error('subtitle_extract_failed'));
      return;
    }
    tried.push(mapArg);
    runExtractWithMap(mapArg, function (err, vtt) {
      if (!err && vtt) {
        cb(null, vtt);
        return;
      }
      next(err);
    });
  }
  next(null);
  });
};

WebServer.prototype.listEmbeddedSubtitleStreams = function (videoPath, cb) {
  cb = typeof cb === 'function' ? cb : function () {};
  if (!videoPath) return cb(new Error('video_not_found'));
  if (!this.ffmpegPath) return cb(new Error('ffmpeg_unavailable'));
  var self = this;
  fileExists(videoPath).then(function (exists) {
    if (!exists) {
      cb(new Error('video_not_found'));
      return;
    }
  var child;
  try {
    child = childProcess.spawn(self.ffmpegPath, ['-hide_banner', '-i', videoPath], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    cb(e);
    return;
  }
  var err = '';
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    try {
      child.kill('SIGKILL');
    } catch (e0) {}
    cb(new Error('subtitle_probe_timeout'));
  }, 8000);
  child.stderr.on('data', function (chunk) {
    if (done) return;
    err += chunk ? chunk.toString('utf8') : '';
  });
  child.on('error', function (e) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(e);
  });
  child.on('close', function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    var lines = String(err || '').split(/\r?\n/);
    var tracks = [];
    function normalizeLangCode(code) {
      var c = String(code || '')
        .trim()
        .toLowerCase();
      if (!c) return '';
      c = c.replace(/_/g, '-');
      return c;
    }
    function guessLangName(code) {
      var c = normalizeLangCode(code);
      if (!c) return '';
      if (SUBTITLE_LANG_NAME_MAP[c]) return SUBTITLE_LANG_NAME_MAP[c];
      var base = c.split('-')[0];
      return SUBTITLE_LANG_NAME_MAP[base] || c;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!/Subtitle:/i.test(line)) continue;
      var m = line.match(
        /Stream #\d+:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?:\s*Subtitle:\s*([^,\r\n]+)/i,
      );
      if (!m) continue;
      var langCode = normalizeLangCode(m[2] ? String(m[2]) : '');
      var codecName = m[3] ? String(m[3]).trim().toLowerCase() : '';
      // 仅保留可稳定转为 WebVTT 的文本字幕，避免“可选但不显示”
      var supportedCodec = {
        subrip: true,
        srt: true,
        ass: true,
        ssa: true,
        mov_text: true,
        webvtt: true,
        text: true,
        ttml: true,
      };
      if (!supportedCodec[codecName]) continue;
      var title = '';
      for (var j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/^\s*Stream #/i.test(lines[j])) break;
        var mt = lines[j].match(/^\s*title\s*:\s*(.+)\s*$/i);
        if (mt && mt[1]) {
          title = String(mt[1]).trim();
          break;
        }
      }
      tracks.push({
        streamIndex: tracks.length,
        ffIndex: parseInt(m[1], 10),
        lang: langCode,
        langName: guessLangName(langCode),
        label: title,
        codec: codecName,
      });
    }
    cb(null, tracks);
  });
  });
};

/** 关闭预览 / 切走时终止对应 FFmpeg，释放 CPU */
WebServer.prototype.handleHlsStopApi = function (req, res, query) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  var sid = query.sessionId ? String(query.sessionId).trim() : '';
  if (!/^[a-f0-9]{24}$/.test(sid)) {
    this.jsonResponse(res, { error: 'invalid session' }, 400);
    return;
  }
  if (this.hlsManager) {
    this.hlsManager.stopSession(sid);
  }
  this.jsonResponse(res, { ok: true });
};

WebServer.prototype.isLoopback = function (req) {
  var a = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

WebServer.prototype.serveWebBinary = function (res, absPath, contentType, cacheControl) {
  fs.readFile(absPath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': cacheControl || 'public, max-age=86400',
    });
    res.end(data);
  });
};

/**
 * GET /hls/:sessionId/:file — m3u8 / ts 分片
 */
WebServer.prototype.handleHlsFile = function (req, res, pathname) {
  var self = this;
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  var prefix = '/hls/';
  var rest = pathname.slice(prefix.length);
  var slash = rest.indexOf('/');
  if (slash < 0) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  var sessionId = rest.slice(0, slash);
  var file = rest.slice(slash + 1);
  if (!/^[a-f0-9]{24}$/.test(sessionId) || !file || file.indexOf('..') >= 0 || /[\\/]/.test(file)) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }
  if (!this.hlsRootDir) {
    res.writeHead(503);
    res.end('HLS unavailable');
    return;
  }
  var base = path.resolve(this.hlsRootDir, sessionId);
  var full = path.resolve(base, file);
  var rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }

  var ext = path.extname(file).toLowerCase();
  var mime =
    ext === '.m3u8'
      ? 'application/vnd.apple.mpegurl; charset=utf-8'
      : ext === '.ts'
        ? 'video/mp2t'
        : ext === '.m4s' || ext === '.mp4'
          ? 'video/mp4'
          : 'application/octet-stream';

  fs.stat(full, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (self.hlsManager && typeof self.hlsManager.touchSessionDir === 'function') {
      try {
        self.hlsManager.touchSessionDir(sessionId);
      } catch (eTouch) {}
    }
    var corsOrigin = self.getAllowedCorsOrigin(req);
    if (corsOrigin) {
      try {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Vary', 'Origin');
      } catch (eCors) {}
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    var rs = fs.createReadStream(full);
    rs.on('error', function () {
      try {
        res.destroy();
      } catch (e) {}
    });
    rs.pipe(res);
  });
};

// === Helpers ===

WebServer.prototype.isAuthenticated = function (req, opts) {
  if (!this.password) return true;
  opts = opts || {};
  this.pruneExpiredSessions();
  // 检查 Cookie 中的 session token
  var cookie = req.headers.cookie || '';
  var match = cookie.match(/photo_session=([^;]+)/);
  if (match) {
    var token = match[1];
    var expiresAt = this.sessions.get(token);
    if (expiresAt && expiresAt > Date.now()) {
      return true;
    }
    if (expiresAt) this.sessions.delete(token);
  }
  // Authorization（仅允许本机回环使用；避免把“密码”当作全网 API Key）
  if (opts.allowBearer) {
    var auth = req.headers.authorization;
    if (auth === 'Bearer ' + this.password) return true;
  }
  return false;
};

WebServer.prototype.handleLogin = function (req, res) {
  var self = this;
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  var ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('application/json') < 0) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Content-Type must be application/json' }));
    return;
  }
  var body = '';
  var maxBody = 64 * 1024;
  req.on('data', function (chunk) {
    body += chunk;
    if (body.length > maxBody) {
      try {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '请求体过大' }));
      } catch (e) {}
      try {
        req.destroy();
      } catch (e2) {}
    }
  });
  req.on('end', function () {
    try {
      var data = JSON.parse(body);
      var provided = data && data.password !== undefined ? String(data.password) : '';
      var expected = String(self.password || '');
      var ok = false;
      if (expected) {
        var a = crypto.createHash('sha256').update(provided, 'utf8').digest();
        var b = crypto.createHash('sha256').update(expected, 'utf8').digest();
        ok = crypto.timingSafeEqual(a, b);
      }
      if (ok) {
        self.pruneExpiredSessions();
        var sessionToken = crypto.randomBytes(32).toString('hex');
        var expiresAt = Date.now() + self.sessionTtlMs;
        self.sessions.set(sessionToken, expiresAt);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie':
            'photo_session=' + sessionToken + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400',
        });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '密码错误' }));
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '无效请求' }));
    }
  });
};

WebServer.prototype.getAllowedCorsOrigin = function (req) {
  var origin = req && req.headers ? req.headers.origin : '';
  if (!origin) return '';
  try {
    var u = new URL(String(origin));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    var host = (req.headers && req.headers.host ? String(req.headers.host) : '').split(':')[0];
    var allowed = new Set(['localhost', '127.0.0.1', this.getLocalIP()]);
    if (host) allowed.add(host);
    // 默认：同机/同网允许
    if (allowed.has(u.hostname)) return u.origin;

    // 可配置白名单：支持 origin 或 hostname / .suffix
    var wl = this.corsAllowedOrigins || [];
    for (var i = 0; i < wl.length; i++) {
      var rule = String(wl[i] || '').trim();
      if (!rule) continue;
      if (rule.indexOf('://') >= 0) {
        if (rule === u.origin) return u.origin;
        continue;
      }
      if (rule[0] === '.') {
        // .example.com 允许子域与根域
        var suf = rule.slice(1);
        if (u.hostname === suf || u.hostname.endsWith(rule)) return u.origin;
        continue;
      }
      if (u.hostname === rule) return u.origin;
    }
  } catch (e) {}
  return '';
};

WebServer.prototype.applySecurityHeaders = function (res) {
  // 基础安全响应头（尽量不影响现有功能）
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  } catch (e) {}
};

WebServer.prototype.getClientIp = function (req) {
  var a = req && req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : '';
  if (!a) return '';
  if (a.startsWith('::ffff:')) return a.slice('::ffff:'.length);
  if (a === '::1') return '127.0.0.1';
  return a;
};

WebServer.prototype.checkLoginRateLimit = function (req) {
  var ip = this.getClientIp(req) || 'unknown';
  var now = Date.now();
  var w = Number(this.loginRate && this.loginRate.windowMs) || 5 * 60 * 1000;
  var max = Number(this.loginRate && this.loginRate.max) || 10;
  if (w <= 0 || max <= 0) return { blocked: false };

  var st = this._loginRateState.get(ip);
  if (!st || !st.resetAt || st.resetAt <= now) {
    st = { resetAt: now + w, hits: 0 };
    this._loginRateState.set(ip, st);
  }
  st.hits++;
  if (st.hits > max) {
    return { blocked: true, retryAfterMs: Math.max(0, st.resetAt - now) };
  }
  return { blocked: false };
};

WebServer.prototype.serveFileWithRange = function (req, res, filePath, size, contentType, cacheControl) {
  var range = req && req.headers && req.headers.range ? String(req.headers.range) : null;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    var m = range.match(/^bytes=(\d*)-(\d*)$/);
    var start = m && m[1] ? parseInt(m[1], 10) : 0;
    var end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end < 0) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size });
      res.end();
      return;
    }
    if (end >= size) end = size - 1;
    var chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': cacheControl || 'public, max-age=3600',
    });
    var rs = fs.createReadStream(filePath, { start: start, end: end });
    rs.on('error', function () {
      try {
        res.destroy();
      } catch (e) {}
    });
    rs.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
    'Content-Type': contentType,
    'Cache-Control': cacheControl || 'public, max-age=3600',
  });
  var rs2 = fs.createReadStream(filePath);
  rs2.on('error', function () {
    try {
      res.destroy();
    } catch (e2) {}
  });
  rs2.pipe(res);
};

WebServer.prototype._rawCacheGet = function (key) {
  var e = this._rawCache.get(key);
  if (!e) return null;
  var ttl = Number(this.rawPreview && this.rawPreview.cacheTtlMs) || 0;
  if (ttl > 0 && e.createdAt + ttl < Date.now()) {
    this._rawCacheDelete(key);
    return null;
  }
  // LRU：刷新顺序
  this._rawCache.delete(key);
  this._rawCache.set(key, e);
  return e;
};

WebServer.prototype._rawCacheDelete = function (key) {
  var e = this._rawCache.get(key);
  if (!e) return;
  this._rawCache.delete(key);
  this._rawCacheBytes -= Number(e.bytes || 0);
  if (this._rawCacheBytes < 0) this._rawCacheBytes = 0;
};

WebServer.prototype._rawCachePut = function (key, buf) {
  if (!buf || !Buffer.isBuffer(buf)) return;
  var maxBytes = Number(this.rawPreview && this.rawPreview.cacheMaxBytes) || 0;
  var maxEntries = Number(this.rawPreview && this.rawPreview.cacheMaxEntries) || 0;
  if (maxBytes <= 0 || maxEntries <= 0) return;
  var bytes = buf.length;
  if (bytes > maxBytes) return;

  if (this._rawCache.has(key)) this._rawCacheDelete(key);
  this._rawCache.set(key, { buf: buf, bytes: bytes, createdAt: Date.now() });
  this._rawCacheBytes += bytes;

  // LRU 裁剪
  while (this._rawCache.size > maxEntries) {
    var firstKey = this._rawCache.keys().next().value;
    if (!firstKey) break;
    this._rawCacheDelete(firstKey);
  }
  while (this._rawCacheBytes > maxBytes) {
    var firstKey2 = this._rawCache.keys().next().value;
    if (!firstKey2) break;
    this._rawCacheDelete(firstKey2);
  }
};

WebServer.prototype._previewWebCacheGet = function (key) {
  var e = this._previewWebCache.get(key);
  if (!e || !e.buf) return null;
  this._previewWebCache.delete(key);
  this._previewWebCache.set(key, e);
  return e.buf;
};

WebServer.prototype._previewWebCacheDelete = function (key) {
  var e = this._previewWebCache.get(key);
  if (!e) return;
  this._previewWebCache.delete(key);
  this._previewWebCacheBytes -= Number(e.bytes || 0);
  if (this._previewWebCacheBytes < 0) this._previewWebCacheBytes = 0;
};

WebServer.prototype._previewWebCachePut = function (key, buf) {
  if (!buf || !Buffer.isBuffer(buf)) return;
  var maxBytes = 120 * 1024 * 1024;
  var maxEntries = 64;
  var bytes = buf.length;
  if (bytes > maxBytes) return;
  if (this._previewWebCache.has(key)) this._previewWebCacheDelete(key);
  this._previewWebCache.set(key, { buf: buf, bytes: bytes, createdAt: Date.now() });
  this._previewWebCacheBytes += bytes;
  while (this._previewWebCache.size > maxEntries) {
    var firstKey = this._previewWebCache.keys().next().value;
    if (!firstKey) break;
    this._previewWebCacheDelete(firstKey);
  }
  while (this._previewWebCacheBytes > maxBytes) {
    var firstKey2 = this._previewWebCache.keys().next().value;
    if (!firstKey2) break;
    this._previewWebCacheDelete(firstKey2);
  }
};

WebServer.prototype.handlePreviewImage = async function (req, res, idStr) {
  var cleanId = String(idStr || '').split('?')[0];
  var photoId = parseInt(cleanId, 10);
  if (isNaN(photoId)) {
    res.writeHead(400);
    res.end('Invalid photo ID');
    return;
  }
  var photo = this.db.getFullPhoto(photoId);
  if (!photo || !photo.file_path) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  var fp = photo.file_path;
  var ext = path.extname(fp).toLowerCase();

  if (VIDEO_EXTENSIONS.has(ext)) {
    res.writeHead(302, { Location: '/video/' + photoId });
    res.end();
    return;
  }
  if (RAW_EXTENSIONS.has(ext)) {
    this.serveRawPreviewJpeg(req, res, fp);
    return;
  }
  if (ext === '.gif' || ext === '.svg') {
    try {
      var stGif = await fs.promises.stat(fp);
      if (!stGif || !stGif.isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      var mimeGif =
        ext === '.svg' ? 'image/svg+xml' : ext === '.gif' ? 'image/gif' : 'application/octet-stream';
      this.serveFileWithRange(req, res, fp, stGif.size, mimeGif, 'public, max-age=3600');
    } catch (eG) {
      res.writeHead(500);
      res.end('Error');
    }
    return;
  }

  try {
    var st = await fs.promises.stat(fp);
    if (!st || !st.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var cacheKey = 'pvw|' + photoId + '|' + String(st.mtimeMs) + '|' + String(st.size);
    var cached = this._previewWebCacheGet(cacheKey);
    if (cached && cached.length) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': cached.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(cached);
      return;
    }
    try {
      await this._previewJpegAcquire();
    } catch (eAc) {
      if (eAc && eAc.message === 'preview_jpeg_queue_full') {
        res.writeHead(503, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': '2',
          'Cache-Control': 'no-store',
        });
        res.end('preview busy');
        return;
      }
      throw eAc;
    }
    try {
      var buf = await loadSharp()(fp)
        .rotate()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 88, progressive: true, mozjpeg: true })
        .toBuffer();
      this._previewWebCachePut(cacheKey, buf);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
    } finally {
      this._previewJpegRelease();
    }
  } catch (ePv) {
    try {
      this.handlePhoto(req, res, cleanId);
    } catch (e2) {
      res.writeHead(500);
      res.end('Error');
    }
  }
};

WebServer.prototype._previewJpegAcquire = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var max = Number(self.previewJpegMaxConcurrent) || 2;
    if (self._previewJpegActive < max) {
      self._previewJpegActive++;
      resolve();
      return;
    }
    var maxQ = Number(self.previewJpegMaxQueue) || 0;
    if (maxQ > 0 && self._previewJpegQueue.length >= maxQ) {
      reject(new Error('preview_jpeg_queue_full'));
      return;
    }
    self._previewJpegQueue.push(resolve);
  });
};

WebServer.prototype._previewJpegRelease = function () {
  if (this._previewJpegActive > 0) this._previewJpegActive--;
  if (this._previewJpegQueue.length > 0) {
    var next = this._previewJpegQueue.shift();
    this._previewJpegActive++;
    try {
      next();
    } catch (e) {}
  }
};

WebServer.prototype._rawAcquire = function () {
  var self = this;
  return new Promise(function (resolve, reject) {
    var max = Number(self.rawPreview && self.rawPreview.maxConcurrent) || 1;
    if (self._rawActive < max) {
      self._rawActive++;
      resolve();
      return;
    }
    var maxQueue = Number(self.rawPreview && self.rawPreview.maxQueue) || 0;
    if (maxQueue > 0 && self._rawQueue.length >= maxQueue) {
      reject(new Error('raw_queue_full'));
      return;
    }
    self._rawQueue.push({ resolve: resolve, reject: reject, createdAt: Date.now() });
  });
};

WebServer.prototype._rawRelease = function () {
  if (this._rawActive > 0) this._rawActive--;
  if (this._rawQueue.length > 0) {
    var next = this._rawQueue.shift();
    this._rawActive++;
    try {
      next.resolve();
    } catch (e) {}
  }
};

WebServer.prototype._serveBufferWithRange = function (req, res, buf, contentType, cacheControl) {
  var size = buf.length;
  var range = req && req.headers && req.headers.range ? String(req.headers.range) : null;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    var m = range.match(/^bytes=(\d*)-(\d*)$/);
    var start = m && m[1] ? parseInt(m[1], 10) : 0;
    var end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end < 0) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + size });
      res.end();
      return;
    }
    if (end >= size) end = size - 1;
    var chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': cacheControl || 'public, max-age=3600',
    });
    res.end(buf.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
    'Content-Type': contentType,
    'Cache-Control': cacheControl || 'public, max-age=3600',
  });
  res.end(buf);
};

WebServer.prototype.serveRawPreviewJpeg = function (req, res, filePath) {
  var self = this;
  fs.stat(filePath, function (statErr, st) {
    if (statErr) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (!st || !st.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var key = filePath + '|' + String(st.mtimeMs) + '|' + String(st.size);
    var cached = self._rawCacheGet(key);
    if (cached && cached.buf) {
      self._serveBufferWithRange(req, res, cached.buf, 'image/jpeg', 'public, max-age=3600');
      return;
    }

    var acquired = false;
    self
      ._rawAcquire()
      .then(function () {
        acquired = true;
        var q = Number(self.rawPreview && self.rawPreview.jpegQuality) || 88;
        return loadSharp()(filePath)
          .rotate()
          .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: q })
          .toBuffer();
      })
      .then(function (buf) {
        self._rawCachePut(key, buf);
        self._serveBufferWithRange(req, res, buf, 'image/jpeg', 'public, max-age=3600');
      })
      .catch(function (err) {
        if (err && err.message === 'raw_queue_full') {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('RAW preview busy');
          return;
        }
        res.writeHead(500);
        res.end('Error decoding RAW file');
      })
      .finally(function () {
        if (acquired) self._rawRelease();
      });
  });
};

WebServer.prototype.pruneExpiredSessions = function () {
  var now = Date.now();
  for (var token of this.sessions.keys()) {
    var expiresAt = this.sessions.get(token);
    if (!expiresAt || expiresAt <= now) {
      this.sessions.delete(token);
    }
  }
};

WebServer.prototype.parsePageOptions = function (query) {
  return {
    sortBy: query.sortBy || 'date_taken',
    sortOrder: query.sortOrder || 'DESC',
    page: parseInt(query.page) || 1,
    pageSize: Math.min(parseInt(query.pageSize) || 120, 500),
    rootId: query.rootId ? parseInt(query.rootId) : undefined,
    mediaType: query.mediaType || query.media_filter || query.media || undefined,
  };
};

WebServer.prototype.jsonResponse = function (res, data, statusCode, req) {
  var status = statusCode || 200;
  var json = JSON.stringify(data);
  var buf = Buffer.from(json, 'utf8');
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (req && buf.length >= 512) {
    var ae = req.headers && req.headers['accept-encoding'];
    if (ae && String(ae).indexOf('gzip') !== -1) {
      try {
        buf = zlib.gzipSync(buf);
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
      } catch (eGz) {}
    }
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
};

module.exports = WebServer;
