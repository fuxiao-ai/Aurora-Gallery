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

var playbackStrategy = require('./playback-strategy');
/** 图片信息面板的字段注册表：与渲染端、主进程共用同一份（见该文件头部说明） */
var PhotoInfoFields = require('./web/js/photo-info-fields.js');

var HlsSessionManager = require('./hls-session-manager');
var VideoProbe = require('./video-probe');
var runDbReadWorkerOnly = require('./db-read-runner').runDbReadWorkerOnly;
var logger = require('./main/logger');
/**
 * 用户交互抢占信号：与桌面端主进程共用同一份单例（同进程内嵌网页），
 * 于是网页端搜图同样会让后台长任务在批次边界停下让位。
 */
var interactionPreempt = require('./main/interaction-preempt').interactionPreempt;
// 缩略图格式 → 响应头 MIME 的唯一真相源（`database.js` 写入端、桌面端 `thumb://` 共用同一份）。
// 🔴 `/thumb/:id` 的头**必须**按「这一行实际存的格式」派生：硬编码 `image/jpeg` 时，
//    库里一旦出现 WebP 行，浏览器不报错、只是不解码。
// 同时取「生成端」那几个：编码格式、缩放+编码入口、档位归一化 —— 按需生成不许自己写 `.jpeg()`。
var thumbFormat = require('./main/thumb-format');
var thumbMimeType = thumbFormat.thumbMimeType;
var resizeThumb = thumbFormat.resizeThumb;
var normalizeThumbSize = thumbFormat.normalizeThumbSize;
var THUMB_ENCODE_FORMAT = thumbFormat.THUMB_ENCODE_FORMAT;
var THUMB_DEFAULT_QUALITY = thumbFormat.THUMB_DEFAULT_QUALITY;

/**
 * 「RAW 家族」= 走**专用预览路径**（`serveRawPreviewJpeg`：有并发队列 + 独立缓存 + 2560px 质量档）。
 *
 * ⚠️ 这份清单与 `main/sharp-input.js#OWN_DECODER_RAW_EXTENSIONS` **语义不同，不能合并**：
 *   这份 = 「按 RAW 对待（队列 / 缓存 / 大尺寸预览）」；
 *   那份 = 「libvips 读不了、要我们自己抠内嵌预览」。`dng`/`nef`/`arw` 属于前者不属于后者。
 * 🔴 但**漏项的代价是破图**：不在本表的 RAW 扩展名会落到 `handlePhoto` 的 `mimeMap`
 *    （那里没有它）⇒ 标成 `image/jpeg` 却发的是原文件 ⇒ 浏览器解不出来，**一声不吭**。
 *    实测踩到过：`.cr3` / `.crw` 原先不在这里。加新 RAW 格式时**两个清单一起看**。
 */
var RAW_EXTENSIONS = new Set([
  '.cr2',
  '.crw',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2',
  '.raw',
]);

/**
 * 「libvips 读不了的输入 → 一个 sharp 实例」的接线。**与主进程共用同一份**
 * （`src/main/sharp-input.js`）—— 两端各写一份必然漂移，而漂移的症状是
 * 「桌面端出得了图、网页端破图」（或反过来），两端都"看起来正常"，只是少了一部分图片。
 *
 * 延迟加载：只有真遇到那些格式才需要（模块本身纯 JS、体积小）。
 */
var sharpInputModule = null;
function loadSharpInput() {
  if (!sharpInputModule) {
    sharpInputModule = require('./main/sharp-input');
  }
  return sharpInputModule;
}

/** 见 `sharp-input.js#needsOwnRender`：浏览器原生不认、必须由我们转成 JPEG 才能显示的格式。 */
function needsOwnRender(filePathOrName) {
  return loadSharpInput().needsOwnRender(filePathOrName);
}


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
  /**
   * 图片编辑服务。🔴 **必须由 main.js 注入同一个实例**，不能在这里 new 一个：
   *    服务内部对编辑是**全局串行**的，两端各建一个 = 两条互不知情的队列，
   *    「桌面在转、手机同时在裁同一张」会互相覆盖（后写的覆盖先写的，没有任何报错）。
   * 取不到时编辑路由回 503，而不是静默降级成「什么都不做」。
   */
  this.photoEdit = opts.photoEdit || null;
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
  /** 与桌面同一份搜图匹配阈值：阈值在桌面端设置里调，网页端只是照用 */
  this.getAiSearchMatchThreshold =
    typeof opts.getAiSearchMatchThreshold === 'function' ? opts.getAiSearchMatchThreshold : null;
  /**
   * tag 检索层（M4）的两个键：`{ tagEnabled, tagThreshold }`。
   *
   * 为什么单独一个注入，不并进上面那个标量：那个标量**搜图与预选词都用**，而 tag 层只有搜图用。
   * 并进去会让「预选词也带 tag 参数」看起来像真的（它不走 tag 路）。
   * 取不到时**不补默认值**：worker 侧「缺 `tagEnabled` 键 = 开、缺 `tagThreshold` = 用它自己的
   * 默认」，与桌面端默认值同源，所以少一个注入不会把网页端静默降级成纯 CLIP。
   */
  this.getAiSearchTagOptions =
    typeof opts.getAiSearchTagOptions === 'function' ? opts.getAiSearchTagOptions : null;
  /**
   * 预选词的**常规路径**（主进程注入 → `main.js#suggestTermsFromTags` → `SemanticTags.suggestTerms`）。
   *
   * 与桌面端**同源同函数**：主进程按 `embeddings.tags` 转置统计，只读 SQL，
   * **不起 worker、不载模型**（实测 48 ms；老路要起 worker 载文本编码器 ≈ 4 s，冷启 17 s）。
   * 取不到时回 `{ sampled: 0, terms: [] }` —— 界面据此把预选词整块收起（既有取向）。
   * 与 `getPhotoAiTags` / `getTagNavPhotos` 同一形态：只交出「一个能力」，不交出活对象。
   */
  this.getAiSuggestTerms =
    typeof opts.getAiSuggestTerms === 'function' ? opts.getAiSuggestTerms : null;
  /**
   * 与桌面同一份缩略图档位 / 画质（主进程注入 → `main.js#getThumbOptions`）。
   *
   * 🔴 网页端「按需生成缩略图」那条路**必须**用同一份档位：写死的 256/400 会让库里多出一批
   *    永远不合档的行 —— 重跑任务每轮都会把这批人重新算成「待重生成」，
   *    而它们其实是网页端刚生成的。取不到就回落到默认档（见 `thumb-format.js`）。
   */
  this.getThumbOptions =
    typeof opts.getThumbOptions === 'function' ? opts.getThumbOptions : null;
  /** 与桌面同一份「图片信息面板显示哪些字段」：桌面设置页勾，网页端照用 */
  this.getInfoPanelFields =
    typeof opts.getInfoPanelFields === 'function' ? opts.getInfoPanelFields : null;
  /**
   * 图片的「主题标签」只读通道（主进程注入 → `SemanticTags.tagsFor`）。
   *
   * 标签在**搜图索引库**里、不在 `photos` 表，所以不能并进 `/api/photo-info` 的 SQL，
   * 只能单开一条 —— 与桌面端 `get-photo-ai-tags` 是同一个来源，两边读数一致。
   */
  this.getPhotoAiTags =
    typeof opts.getPhotoAiTags === 'function' ? opts.getPhotoAiTags : null;
  /**
   * 图片的「画面标签」（JoyTag）只读通道（主进程注入 → `JoyTagTags.tagsFor`）。
   *
   * 标签在 **tag 索引库**里、不在 `photos` 表，所以不能并进 `/api/photo-info` 的 SQL，
   * 只能单开一条 —— 与桌面端 `get-photo-joy-tags` 是同一个来源，两边读数一致
   * （中文映射在通道内做，两端拿到同样的文本）。
   */
  this.getPhotoJoyTags =
    typeof opts.getPhotoJoyTags === 'function' ? opts.getPhotoJoyTags : null;
  /**
   * 网页端「设置」页要展示的设置快照（主进程注入，**只读**）。
   *
   * 网页端设置页是桌面端的**只读镜像**：每一项都注明「在桌面端修改」。
   * 之所以不做双向写入 —— 与 `/api/info-fields` 同一条既有契约（网页端只读，
   * 桌面端是唯一写入口），写成可写会多出一整套「谁赢了」的冲突语义，
   * 而浏览器会话本来也拿不到桌面端那些窗口级设置。
   *
   * ⚠️ 注入方**必须**返回脱敏后的白名单快照：访问密码、隧道凭据这类字段
   * 不能出现在这里。`/api/settings` 只做转发，不认得哪些字段敏感。
   */
  this.getSettingsSnapshot =
    typeof opts.getSettingsSnapshot === 'function' ? opts.getSettingsSnapshot : null;

  // /api/login 简单限流（按 IP）
  this.loginRate = {
    windowMs: opts.loginRateWindowMs != null ? Number(opts.loginRateWindowMs) : 5 * 60 * 1000,
    max: opts.loginRateMax != null ? Number(opts.loginRateMax) : 10,
  };
  this._loginRateState = new Map(); // ip -> { resetAt:number, hits:number }

  // RAW 预览：并发限制 + 缓存（避免高 CPU 与重复转码）
  this.rawPreview = {
    maxConcurrent: opts.rawPreviewMaxConcurrent != null ? Number(opts.rawPreviewMaxConcurrent) : 2,
    maxQueue: opts.rawPreviewMaxQueue != null ? Number(opts.rawPreviewMaxQueue) : 20,
    cacheMaxBytes:
      opts.rawPreviewCacheMaxBytes != null
        ? Number(opts.rawPreviewCacheMaxBytes)
        : 100 * 1024 * 1024,
    cacheMaxEntries:
      opts.rawPreviewCacheMaxEntries != null ? Number(opts.rawPreviewCacheMaxEntries) : 48,
    cacheTtlMs:
      opts.rawPreviewCacheTtlMs != null ? Number(opts.rawPreviewCacheTtlMs) : 10 * 60 * 1000,
    jpegQuality: opts.rawPreviewJpegQuality != null ? Number(opts.rawPreviewJpegQuality) : 88,
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
  /**
   * 「组织元数据写入完成」回调（由 `main.js` 注入 `dbReadWorkerPool.invalidateReadCaches`）。
   * 见 `notifyOrgMetaWritten`。取不到只影响计数的陈旧度上界（5 秒），不影响正确性。
   */
  this.onOrgMetaWritten = typeof opts.onOrgMetaWritten === 'function' ? opts.onOrgMetaWritten : null;
  this.semanticSearch = opts.semanticSearch || null;
  this.faceService = opts.faceService || null;

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
  this.videoProbe = this.ffmpegPath ? new VideoProbe({ ffmpegPath: this.ffmpegPath }) : null;
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
      logger.info('[web-server] started on port', self.port);
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
  logger.info('[web-server] stopping');
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
      logger.info(
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
    logger.warn('[HLS] LRU prune failed (' + reason + '):', e && e.message ? e.message : e);
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
    pathname === '/favicon.ico' ||
    pathname === '/js/web-theme-shared.js';

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
  } else if (pathname === '/gallery-design.css') {
    this.serveStaticFile(res, 'css/gallery-design.css', 'text/css; charset=utf-8');
  } else if (pathname === '/app-icon.svg') {
    this.serveStaticFile(
      res,
      'app-icon.svg',
      'image/svg+xml; charset=utf-8',
      'public, max-age=604800',
    );
  } else if (pathname === '/apple-touch-icon.png') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'apple-touch-icon.png'),
      'image/png',
      'public, max-age=604800',
    );
  } else if (pathname === '/app-icon-192.png') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'app-icon-192.png'),
      'image/png',
      'public, max-age=604800',
    );
  } else if (pathname === '/app-icon-512.png') {
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'app-icon-512.png'),
      'image/png',
      'public, max-age=604800',
    );
  } else if (pathname === '/favicon.ico') {
    // 兜底：部分浏览器/启动器仍会优先请求 favicon.ico
    this.serveWebBinary(
      res,
      path.join(this.webDir, 'app-icon-192.png'),
      'image/png',
      'public, max-age=604800',
    );
  } else if (pathname === '/api/login') {
    this.handleLogin(req, res);
  } else if (pathname === '/api/photo-edit-transform') {
    this.handlePhotoEditTransform(req, res);
  } else if (pathname === '/api/photo-edit-crop') {
    this.handlePhotoEditCrop(req, res);
  } else if (pathname === '/api/photo-edit-apply') {
    this.handlePhotoEditApply(req, res);
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
  } else if (pathname === '/api/search-folders') {
    this.handleSearchFolders(req, res, query);
  } else if (pathname === '/api/person-rename') {
    this.handlePersonRename(req, res);
  } else if (
    pathname === '/api/people' ||
    pathname === '/api/person-photos' ||
    pathname === '/api/face-status'
  ) {
    if (req.method !== 'GET') {
      this.jsonResponse(res, { error: 'method_not_allowed' }, 405, req);
      return;
    }
    if (!this.faceService) {
      this.jsonResponse(res, { error: 'FACE_UNAVAILABLE' }, 503, req);
      return;
    }
    const operation = pathname === '/api/people' ? 'groups' : 'photos';
    const task =
      pathname === '/api/face-status'
        ? this.faceService.refresh()
        : this.faceService.run(operation, { after: query.after, personId: query.personId });
    task
      .then((result) => {
        if (!res.destroyed) this.jsonResponse(res, result, 200, req);
      })
      .catch((error) => {
        if (!res.destroyed) this.jsonResponse(res, { error: error.message }, 503, req);
      });
  } else if (pathname === '/api/ai-search-suggest') {
    this.handleAiSearchSuggest(req, res);
  } else if (pathname === '/api/ai-search' || pathname === '/api/ai-search-status') {
    if (req.method !== 'GET') {
      this.jsonResponse(res, { error: 'method_not_allowed' }, 405, req);
      return;
    }
    if (!this.semanticSearch) {
      this.jsonResponse(res, { error: 'AI_UNAVAILABLE' }, 503, req);
      return;
    }
    if (pathname === '/api/ai-search-status') {
      const service = this.semanticSearch;
      const refresh = service.refresh();
      refresh
        .then(() => {
          if (!res.destroyed) this.jsonResponse(res, service.status(), 200, req);
        })
        .catch((error) => {
          if (!res.destroyed) this.jsonResponse(res, { error: error.message }, 503, req);
        });
    } else {
      // 阈值与桌面共用同一份设置；取不到就交给 IndexStore 用它自己的默认值。
      const options = {};
      if (this.getAiSearchMatchThreshold) options.threshold = Number(this.getAiSearchMatchThreshold());
      // tag 检索层：开关与它自己的查询线。⚠️ 不从这里补默认值（理由见构造函数里那段）——
      // 网页端与桌面端看到同一份设置，靠的是同一个注入，不是在这里各写一份默认。
      const tagOptions = this.getAiSearchTagOptions ? this.getAiSearchTagOptions() : null;
      if (tagOptions && typeof tagOptions === 'object') {
        if (tagOptions.tagEnabled !== undefined) options.tagEnabled = tagOptions.tagEnabled !== false;
        if (tagOptions.tagThreshold !== undefined)
          options.tagThreshold = Number(tagOptions.tagThreshold);
      }
      interactionPreempt
        .withPreempt(() => this.semanticSearch.run('search', query.q, options))
        .then((data) => {
          if (!res.destroyed) this.jsonResponse(res, data, 200, req);
        })
        .catch((error) => {
          if (!res.destroyed) this.jsonResponse(res, { error: error.message }, 503, req);
        });
    }
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
  } else if (pathname === '/api/toggle-favorite') {
    this.handleToggleFavorite(req, res);
  } else if (pathname === '/api/photo-rating') {
    // 组织元数据：评分（POST 写 / 无 body 不写；读走列表行自带的 rating 列）
    this.handlePhotoRating(req, res);
  } else if (pathname === '/api/photo-flag') {
    // 组织元数据：标记（**幂等设值**，不是 toggle —— 见 `database.js#setPhotoFlag`）
    this.handlePhotoFlag(req, res);
  } else if (pathname === '/api/photo-tags') {
    // 组织元数据：某张图的用户标签。GET 读、POST **全量替换**写。
    // 两个方法共用一条路径是刻意的：它们是同一份资源的读与写，
    // 分成 `/api/photo-tags-get` / `-set` 会让「URL 名字里带动词」这件事扩散出去。
    if (req.method === 'GET') this.handlePhotoTagsGet(req, res, query);
    else this.handlePhotoTagsSet(req, res);
  } else if (pathname === '/api/tags') {
    // 标签字典（含使用计数）。筛选面板与标签管理都读它。
    this.handleTagsList(req, res);
  } else if (pathname === '/api/download') {
    this.handleDownload(req, res, query);
  } else if (pathname === '/api/info-fields') {
    // 网页端「图片信息」面板照用桌面端勾好的字段集（只读，鉴权走上面的统一入口）
    this.handleInfoFields(req, res);
  } else if (pathname === '/api/settings') {
    // 网页端「设置」页：桌面端设置的只读快照（写入口只有桌面端一处）
    this.handleSettingsSnapshot(req, res);
  } else if (pathname === '/api/photo-info') {
    this.handlePhotoInfo(req, res, query);
  } else if (pathname === '/api/photo-ai-tags') {
    // 主题标签在搜图索引库里（跨库），单独一条只读通道，见 getPhotoAiTags
    this.handlePhotoAiTags(req, res, query);
  } else if (pathname === '/api/photo-joy-tags') {
    // 画面标签（JoyTag）在 tag 索引库里（跨库），单独一条只读通道，见 getPhotoJoyTags
    this.handlePhotoJoyTags(req, res, query);
  } else if (pathname === '/api/tag-nav-status') {
    // 标签导航页：索引规模（网页端用来显示「标签索引仍在建立」）
    this.handleTagNavStatus(req, res);
  } else if (pathname === '/api/tag-nav-tree') {
    // 标签导航页：分类树（两级，不含标签）
    this.handleTagNavTree(req, res);
  } else if (pathname === '/api/tag-nav-node') {
    // 标签导航页：某个节点下的标签 + 各自命中数
    this.handleTagNavNode(req, res, query);
  } else if (pathname === '/api/tag-nav-search') {
    // 标签导航页：搜标签 / 搜节点
    this.handleTagNavSearch(req, res, query);
  } else if (pathname === '/api/tag-nav-photos') {
    // 标签导航页：某个标签下的照片（跨库：tag 库给有序 id、主库给行）
    this.handleTagNavPhotos(req, res, query);
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
  } else if (pathname === '/photo-compare.css') {
    this.serveStaticFile(res, 'css/photo-compare.css', 'text/css; charset=utf-8');
  } else if (pathname === '/js/photo-compare.js') {
    this.serveStaticFile(res, 'js/photo-compare.js', 'application/javascript; charset=utf-8');
  } else if (pathname === '/js/ai-views.js') {
    this.serveStaticFile(res, 'js/ai-views.js', 'application/javascript; charset=utf-8');
  } else if (pathname === '/js/tag-nav.js') {
    // 标签导航页的界面层（类名两端刻意不共用，见该文件头注释）。
    // ⚠️ 这条路由**必须**与 `src/web/index.html` 的引用同一次改动落下来：
    //    漏了就是 404，所有静态守护都看不出来（`web-asset-route-regression` 就是为它加的）。
    this.serveStaticFile(res, 'js/tag-nav.js', 'application/javascript; charset=utf-8');
  } else if (pathname === '/tag-nav.css') {
    this.serveStaticFile(res, 'css/tag-nav.css', 'text/css; charset=utf-8');
  } else if (pathname === '/ai-web-views.css') {
    this.serveStaticFile(res, 'css/ai-web-views.css', 'text/css; charset=utf-8');
  } else if (pathname === '/js/app.js') {
    this.serveStaticFile(res, path.join('js', 'app.js'), 'application/javascript; charset=utf-8');
  } else if (pathname === '/js/web-theme-shared.js') {
    this.serveStaticFile(
      res,
      path.join('js', 'web-theme-shared.js'),
      'application/javascript; charset=utf-8',
    );
  } else if (pathname === '/js/photo-info-fields.js') {
    // 图片信息面板的字段注册表（三端共用同一份 UMD）。
    // ⚠️ 这条路由曾经缺失：`src/web/index.html` 一直在请求它，但路由表里没有对应
    //    分支 → 落到最后的 404 分支，`window.PhotoInfoFields` 永远是 undefined，
    //    网页端「图片信息」面板固定显示「图片信息模块未加载」。静态守护看不出来
    //    （它只比对类名/引用，不认 HTTP 路由），所以单加了 `web-asset-route-regression`
    //    把「页面引用的静态资源」与「路由表」做机械比对。
    this.serveStaticFile(
      res,
      path.join('js', 'photo-info-fields.js'),
      'application/javascript; charset=utf-8',
    );
  } else if (pathname === '/settings-page.css') {
    this.serveStaticFile(res, 'css/settings-page.css', 'text/css; charset=utf-8');
  } else if (pathname === '/js/settings-page.js') {
    this.serveStaticFile(
      res,
      path.join('js', 'settings-page.js'),
      'application/javascript; charset=utf-8',
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

/** 检测请求是否支持 gzip */
function acceptsGzip(req) {
  var ae = req && req.headers && req.headers['accept-encoding'];
  return typeof ae === 'string' && ae.indexOf('gzip') !== -1;
}

/** 发送 gzip 响应（若支持且有效） */
function sendGzipped(res, data, headers, isBuffer) {
  var req = res.req;
  if (!acceptsGzip(req) || data.length <= 1024) {
    headers['Content-Length'] = isBuffer ? data.length : Buffer.byteLength(data, 'utf8');
    res.writeHead(200, headers);
    res.end(data);
    return;
  }
  zlib.gzip(data, function (err, compressed) {
    if (err || !compressed || compressed.length >= data.length) {
      headers['Content-Length'] = isBuffer ? data.length : Buffer.byteLength(data, 'utf8');
      res.writeHead(200, headers);
      res.end(data);
      return;
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = compressed.length;
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    res.end(compressed);
  });
}

WebServer.prototype.serveRepoFile = function (res, basename, contentType) {
  var filePath = path.join(__dirname, basename);
  fs.readFile(filePath, 'utf8', function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var etag = crypto.createHash('md5').update(data).digest('hex');
    if (res.req && res.req.headers && res.req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    sendGzipped(
      res,
      data,
      {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        ETag: etag,
      },
      false,
    );
  });
};

WebServer.prototype.serveStaticFile = function (res, filename, contentType, cacheControl) {
  var filePath = path.join(this.webDir, filename);
  var cc = cacheControl || 'public, max-age=86400';

  fs.readFile(filePath, 'utf8', function (err, data) {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    var etag = crypto.createHash('md5').update(data).digest('hex');
    if (res.req && res.req.headers && res.req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    sendGzipped(
      res,
      data,
      {
        'Content-Type': contentType,
        'Cache-Control': cc,
        ETag: etag,
      },
      false,
    );
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

WebServer.prototype.respondWithDbRead = function (req, res, operation, options) {
  if (!this.sqliteReadPath) {
    this.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }
  const controller = new AbortController();
  const cancel = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', cancel);
  if (res.destroyed || req.aborted) controller.abort();
  runDbReadWorkerOnly(this.sqliteReadPath, operation, options, { signal: controller.signal })
    .then((result) => {
      if (!res.destroyed) this.jsonResponse(res, result, 200, req);
    })
    .catch((error) => {
      if (!res.destroyed) this.jsonResponse(res, { error: error.message }, 503, req);
    })
    .finally(() => res.removeListener('close', cancel));
};

WebServer.prototype.handlePhotos = function (req, res, query) {
  var options = this.parsePageOptions(query);
  options.lite = true;
  this.respondWithDbRead(req, res, 'getPhotos', options);
};

WebServer.prototype.handleFolderPhotos = function (req, res, query) {
  var folderPath = query.path;
  if (!folderPath) {
    this.jsonResponse(res, { error: 'path is required' }, 400, req);
    return;
  }
  var options = this.parsePageOptions(query);
  options.lite = true;
  if (
    options.includeSubfolders === undefined &&
    typeof this.getBrowseFolderIncludeSubfolders === 'function'
  ) {
    options.includeSubfolders = this.getBrowseFolderIncludeSubfolders();
  }
  this.respondWithDbRead(req, res, 'getFolderPhotos', Object.assign(options, { folderPath }));
};

WebServer.prototype.handleDateGroups = function (req, res, query) {
  var options = {};
  if (query.rootId) options.rootId = parseInt(query.rootId);
  if (query.sortOrder) {
    var so = String(query.sortOrder).toLowerCase();
    options.sortOrder = so === 'asc' ? 'asc' : 'desc';
  }
  this.respondWithDbRead(req, res, 'getDateGroups', options);
};

WebServer.prototype.handleDatePhotos = function (req, res, query) {
  var dateStr = query.date;
  if (!dateStr) {
    this.jsonResponse(res, { error: 'date is required' }, 400, req);
    return;
  }
  var options = this.parsePageOptions(query);
  options.lite = true;
  this.respondWithDbRead(req, res, 'getDatePhotos', Object.assign(options, { dateStr }));
};

WebServer.prototype.handleSearch = function (req, res, query) {
  var q = query.q;
  if (!q) {
    this.jsonResponse(res, { error: 'q is required' }, 400, req);
    return;
  }
  var options = this.parsePageOptions(query);
  options.lite = true;
  // `nameOnly=1` ⇒ 只命中**文件名**（真子串），排除「仅所在目录名命中」的图片。
  // 搜图页「关键词」档的「文件」分组带它；浏览页搜索不带（那边要的是 FTS 分词全量命中）。
  if (query.nameOnly === '1' || query.nameOnly === 'true') options.nameOnly = true;
  this.respondWithDbRead(req, res, 'searchPhotos', Object.assign(options, { query: q }));
};

/**
 * 关键词搜**目录**（网页端搜图页「关键词」档的「文件夹」分组）。
 *
 * 与 `/api/search` 刻意**两条路由**：那边返回图片（FTS 分词命中文件名 / 目录路径），
 * 这边返回目录（按目录路径子串分组）。两者的分页、排序、代价模型都不同，合成一条
 * 只会让「只要目录」的那半边白等图片那半边。
 */
WebServer.prototype.handleSearchFolders = function (req, res, query) {
  var q = query.q;
  if (!q) {
    this.jsonResponse(res, { error: 'q is required' }, 400, req);
    return;
  }
  var limit = parseInt(query.limit, 10);
  var options = { limit: isFinite(limit) && limit > 0 ? limit : 12 };
  this.respondWithDbRead(req, res, 'searchFolders', Object.assign(options, { query: q }));
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
  // 走有界只读池，不再在主进程同步查库：这条查询在 122 万行 / 12.97 GB 的库上曾是一次
  // 3.7 秒的同步调用（详见 database.js getRandomPreviewPhotoBatch 的方法注释），
  // 期间整个桌面端主进程被冻住。
  var self = this;
  if (!self.sqliteReadPath) {
    self.jsonResponse(res, { error: 'db_read_unavailable' }, 503, req);
    return;
  }
  runDbReadWorkerOnly(self.sqliteReadPath, 'getRandomPreviewPhotoBatch', options)
    .then(function (photos) {
      if (!res.destroyed) self.jsonResponse(res, { photos: photos || [] }, 200, req);
    })
    .catch(function (eRand) {
      if (!res.destroyed) {
        self.jsonResponse(
          res,
          { error: String(eRand && eRand.message ? eRand.message : eRand) },
          503,
          req,
        );
      }
    });
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
  this.respondWithDbRead(req, res, 'getFolderCovers', this.parsePageOptions(query || {}));
};

WebServer.prototype.handleImmediateSubfolderCovers = function (req, res, query) {
  var parentPath = (query.parentPath || '').trim();
  if (!parentPath) {
    this.jsonResponse(res, [], 200, req);
    return;
  }
  this.respondWithDbRead(req, res, 'getImmediateSubfolderCovers', {
    parentPath: parentPath,
    mediaType: query.mediaType || query.media_filter || query.media,
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
  // 本函数里三处「当场生成」（视频抽帧 / RAW 预览 / 普通图片）都走 `resizeThumb()`，
  // 编码格式取同一个常量：写进库的 `thumb_format` 与响应头**同源**，
  // 换格式时只改 `thumb-format.js#THUMB_ENCODE_FORMAT` 一处。
  var generatedFormat = THUMB_ENCODE_FORMAT;
  /** 本次生成要用的档位/画质：与桌面同一份（主进程注入），取不到回落默认档。 */
  function thumbOptions() {
    var o;
    try {
      o = self.getThumbOptions ? self.getThumbOptions() : null;
    } catch (e) {
      o = null;
    }
    return {
      size: normalizeThumbSize(o && o.size),
      quality: parseInt(o && o.quality, 10) || THUMB_DEFAULT_QUALITY,
    };
  }
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
      // 🔴 按这一行**实际存的格式**派生（`getThumbnail()` 把 `thumb_format` 一起带出来了）：
      //    未知 / 空串的存量行回落 `image/jpeg`（那批实测全是 JPEG）。
      'Content-Type': thumbMimeType(photo.format),
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
          var topts = thumbOptions();
          topts.ffmpegPath = self.ffmpegPath || null;
          var jpeg = await videoFrameThumb.extractVideoFrameThumb(full.file_path, topts);
          if (!jpeg) {
            jpeg = await videoFrameThumb.buildVideoPlaceholderThumb({
              size: topts.size,
              quality: topts.quality,
            });
          }
          if (jpeg && jpeg.length) {
            try {
              self.db.updatePhotoThumbnail(photoId, jpeg, {
                size: topts.size,
                format: generatedFormat,
              });
            } catch (eUp) {}
            res.writeHead(200, {
              'Content-Type': thumbMimeType(generatedFormat),
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

    // RAW：与 serveRawPreviewJpeg 一致走 RAW 并发队列，避免与普通 JPEG 抢 preview 槽位且确保可解码
    if (RAW_EXTENSIONS.has(ext)) {
      void (async function () {
        try {
          await self._rawAcquire();
        } catch (eRawQ) {
          sendPngFallback();
          return;
        }
        try {
          // 🔴 必须走共用接线：`sharp(file_path)` 对 cr2 必然抛
          //    `Old-style JPEG compression support is not configured`，
          //    于是网页端永远只看到占位图 —— 而桌面端已经靠抠内嵌预览出图了。
          //    （`needsRawPreview` 的那族容器才会走到这里，正常格式原样返回。）
          var siRaw = await loadSharpInput().createSharpInput(full.file_path, null);
          // 档位/画质与桌面同一份（原来写死 400/75 ⇒ 网页端会往库里写一批「永远不合档」的行，
          // 重跑任务每轮都把它们当成待重生成）
          var rawOpts = thumbOptions();
          var jpegRaw = await resizeThumb(siRaw.instance, rawOpts.size, rawOpts.quality);
          try {
            self.db.updatePhotoThumbnail(photoId, jpegRaw, {
              size: rawOpts.size,
              format: generatedFormat,
            });
          } catch (eUp) {}
          res.writeHead(200, {
            'Content-Type': thumbMimeType(generatedFormat),
            'Content-Length': jpegRaw.length,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(jpegRaw);
        } catch (e) {
          sendPngFallback();
        } finally {
          self._rawRelease();
        }
      })();
      return;
    }

    // 普通图片：用 Sharp 按需生成缩略图并写回 DB（复用 previewJpeg 信号量限制并发）
    void (async function () {
      try {
        await self._previewJpegAcquire();
      } catch (eAc) {
        sendPngFallback();
        return;
      }
      try {
        // 同上一处：libvips 读不了的格式（bmp / tga / qoi / pnm …）在这里也要兜底，
        // 否则新扫进来的这些图片在网页端全是一张占位图。
        var siPlain = await loadSharpInput().createSharpInput(full.file_path, null);
        var plainOpts = thumbOptions();
        var jpeg = await resizeThumb(siPlain.instance, plainOpts.size, plainOpts.quality);
        try {
          self.db.updatePhotoThumbnail(photoId, jpeg, {
            size: plainOpts.size,
            format: generatedFormat,
          });
        } catch (eUp) {}
        res.writeHead(200, {
          'Content-Type': thumbMimeType(generatedFormat),
          'Content-Length': jpeg.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(jpeg);
      } catch (e) {
        sendPngFallback();
      } finally {
        self._previewJpegRelease();
      }
    })();
    return;
  }

  sendPngFallback();
};

/**
 * `fromPreviewFallback`：由 `handlePreviewImage` 失败回落调起时为 `true`。
 * 此时**不能再把这些格式转回预览路径** —— 两条路径会互相回弹形成死循环
 * （异步递归，进程不崩、只是无限重试，而且没有任何报错）。
 */
WebServer.prototype.handlePhoto = async function (req, res, idStr, fromPreviewFallback) {
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
      // 🔴 **浏览器也不认**的格式（tga / qoi / pbm~pam / dib …）绝不能把原文件直接发出去：
      //    mimeMap 里没有它 ⇒ 会被标成 `image/jpeg` ⇒ 浏览器解不出来 ⇒ **破图且一声不吭**。
      //    转给「生成 JPEG」那条路径（走的是与缩略图同一个解码接线）。
      //    ⚠️ 判据刻意**不是** `needsFallbackDecode`：bmp / ico / cur 虽然 libvips 读不了，
      //       但浏览器原生能显示 —— 发原文件更快更清晰。
      if (!fromPreviewFallback && needsOwnRender(photo.file_path)) {
        this.handlePreviewImage(req, res, idStr);
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
        '.ico': 'image/x-icon',
        '.cur': 'image/x-icon',
      };
      var contentType = mimeMap[ext] || 'image/jpeg';
      var st = await fs.promises.stat(photo.file_path);
      if (!st || !st.isFile()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      var etag = '"' + (st.mtime ? st.mtime.getTime() : 0) + '-' + st.size + '"';
      if (req.headers && req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      this.serveFileWithRange(
        req,
        res,
        photo.file_path,
        st.size,
        contentType,
        'public, max-age=3600',
        etag,
      );
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
  var etag = '"' + (stat.mtime ? stat.mtime.getTime() : 0) + '-' + size + '"';
  if (req.headers && req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

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
      ETag: etag,
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
    ETag: etag,
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
  var probe = null;
  if (this.videoProbe) {
    try {
      probe = await new Promise(
        function (resolve) {
          this.videoProbe.probe(photo.file_path, function (_err, info) {
            resolve(info || null);
          });
        }.bind(this),
      );
    } catch (eProbe) {
      probe = null;
    }
  }
  var r = playbackStrategy.resolveWebVideoPlayback(fileType, probe);
  logger.log('[video-playback] id=%d fileType=%s tier=%s probe=%j', id, fileType, r.tier, probe);

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
      probe: probe || undefined,
    });
    return;
  }

  if (!this.hlsManager || !this.ffmpegPath) {
    logger.warn(
      '[video-playback] HLS unavailable: hlsManager=%s ffmpegPath=%s',
      !!this.hlsManager,
      !!this.ffmpegPath,
    );
    this.jsonResponse(res, {
      tier: r.tier === 'hls_remux' ? 'hls_remux' : 'hls_transcode',
      mode: 'hls',
      ready: false,
      error: 'hls_unavailable',
      message: '未配置 HLS 目录或 FFmpeg',
    });
    return;
  }

  var self = this;
  var hlsMode = r.tier === 'hls_remux' ? 'remux' : 'transcode';

  function sendHlsResult(tier, err, result) {
    if (err) {
      self.jsonResponse(res, {
        tier: tier,
        mode: 'hls',
        ready: false,
        error: 'hls_failed',
        message: err.message || String(err),
      });
      return;
    }
    var pl = playbackStrategy.hlsPlaylistPath(result.sessionId);
    logger.log(
      '[video-playback] HLS session ready: id=%d tier=%s sessionId=%s',
      id,
      tier,
      result.sessionId,
    );
    self.jsonResponse(res, {
      tier: tier,
      mode: 'hls',
      ready: true,
      playlistUrl: pl,
      sessionId: result.sessionId,
      probe: probe || undefined,
    });
  }

  var hlsStartTime = Date.now();
  var hlsOpts = { mode: hlsMode };
  if (probe && probe.videoHeight) {
    hlsOpts.videoHeight = probe.videoHeight;
  }
  this.hlsManager.ensureSession(photo, hlsOpts, function (err, result) {
    var elapsed = Date.now() - hlsStartTime;
    if (err) {
      logger.warn(
        '[video-playback] HLS ensureSession failed: id=%d mode=%s elapsed=%dms error=%s',
        id,
        hlsMode,
        elapsed,
        err.message,
      );
      if (hlsMode === 'remux') {
        logger.log('[video-playback] Retrying with transcode mode for id=%d', id);
        self.hlsManager.ensureSession(
          photo,
          { mode: 'transcode', videoHeight: hlsOpts.videoHeight },
          function (err2, result2) {
            var elapsed2 = Date.now() - hlsStartTime;
            if (err2) {
              logger.warn(
                '[video-playback] HLS transcode also failed: id=%d elapsed=%dms error=%s',
                id,
                elapsed2,
                err2.message,
              );
            }
            sendHlsResult('hls_transcode', err2, result2);
          },
        );
        return;
      }
    } else {
      logger.log(
        '[video-playback] HLS ensureSession success: id=%d mode=%s elapsed=%dms',
        id,
        hlsMode,
        elapsed,
      );
    }
    sendHlsResult(hlsMode === 'remux' ? 'hls_remux' : 'hls_transcode', err, result);
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
        var msec = String(parseInt(ms, 10) || 0)
          .padStart(3, '0')
          .slice(0, 3);
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
        var msec = String(parseInt(ms, 10) || 0)
          .padStart(3, '0')
          .slice(0, 3);
        return hh + ':' + mm + ':' + ss + '.' + msec;
      }
      return norm(h1, m1, s1, ms1) + ' --> ' + norm(h2, m2, s2, ms2);
    },
  );
};

WebServer.prototype.assTimeToVttTime = function (t) {
  // ASS: H:MM:SS.cc -> WebVTT: HH:MM:SS.mmm
  var m = String(t || '')
    .trim()
    .match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/);
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
    else if (/-->\s*\d{2}:\d{2}:\d{2}/.test(text) || /\d{2}:\d{2}:\d{2}\s*-->/.test(text))
      score += 6;
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
      child = childProcess.spawn(
        self.ffmpegPath,
        ['-v', 'error', '-i', subtitlePath, '-f', 'webvtt', '-'],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
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
        if (
          stem.indexOf(videoStem) >= 0 ||
          (videoNorm && stemNorm && stemNorm.indexOf(videoNorm) >= 0)
        ) {
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
    res.end(
      JSON.stringify({ tracks: Array.isArray(tracks) ? tracks : [], hasExternal: hasExternal }),
    );
  });
};

WebServer.prototype.extractEmbeddedSubtitleVtt = function (
  videoPath,
  ffStreamIndex,
  streamIndex,
  cb,
) {
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
  var cc = cacheControl || 'public, max-age=86400';
  fs.readFile(absPath, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var etag = crypto.createHash('md5').update(data).digest('hex');
    if (res.req && res.req.headers && res.req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    sendGzipped(
      res,
      data,
      {
        'Content-Type': contentType,
        'Cache-Control': cc,
        ETag: etag,
      },
      true,
    );
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
    logger.warn('[HLS] Invalid path (no slash):', pathname);
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  var sessionId = rest.slice(0, slash);
  var file = rest.slice(slash + 1);
  if (!/^[a-f0-9]{24}$/.test(sessionId) || !file || file.indexOf('..') >= 0 || /[\\/]/.test(file)) {
    logger.warn('[HLS] Invalid path components: sessionId=%s file=%s', sessionId, file);
    res.writeHead(400);
    res.end('Bad path');
    return;
  }
  if (!this.hlsRootDir) {
    logger.warn('[HLS] hlsRootDir not configured');
    res.writeHead(503);
    res.end('HLS unavailable');
    return;
  }
  var base = path.resolve(this.hlsRootDir, sessionId);
  var full = path.resolve(base, file);
  var rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    logger.warn('[HLS] Path traversal attempt: sessionId=%s file=%s rel=%s', sessionId, file, rel);
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
      if (err) {
        logger.warn(
          '[HLS] File not found: sessionId=%s file=%s error=%s',
          sessionId,
          file,
          err.message,
        );
      } else {
        logger.warn('[HLS] Not a file: sessionId=%s file=%s', sessionId, file);
      }
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

/**
 * 读一个 JSON 请求体（上限 64 KB），解析成功才回调。
 *
 * 抽成一个方法而不是在每个写操作里内联：内联两遍必然有一处漏掉 Content-Type 校验
 * 或体积上限 —— 而漏掉体积上限的那一处，就是一个「谁都能把主进程内存撑爆」的入口。
 * 失败时本方法**自己回响应**，调用方只管 `cb` 里的成功分支。
 */
WebServer.prototype.readJsonBody = function (req, res, cb) {
  var self = this;
  if (req.method !== 'POST') {
    this.jsonResponse(res, { success: false, error: 'method_not_allowed' }, 405, req);
    return;
  }
  var ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.indexOf('application/json') < 0) {
    this.jsonResponse(
      res,
      { success: false, error: 'Content-Type must be application/json' },
      415,
      req,
    );
    return;
  }
  var body = '';
  var maxBody = 64 * 1024;
  var tooLarge = false;
  req.on('data', function (chunk) {
    if (tooLarge) return;
    body += chunk;
    if (body.length > maxBody) {
      tooLarge = true;
      try {
        req.destroy();
      } catch (eDestroy) {
        void eDestroy;
      }
    }
  });
  req.on('end', function () {
    if (tooLarge) return;
    var data;
    try {
      data = JSON.parse(body || '{}');
    } catch (eParse) {
      self.jsonResponse(res, { success: false, error: 'invalid_json' }, 400, req);
      return;
    }
    cb(data);
  });
};

/**
 * POST /api/photo-edit-transform
 * body: `{ id: number, actions: string[] }`（`actions` 见 `image-edit.js#TRANSFORM_ACTIONS`；
 *       也接受单个字符串 `action`，兼容旧调用）
 *
 * 旋转 / 翻转**写回原文件**。返回输出文件的真实宽高，前端据此刷新，别自己推算。
 * 🔴 `actions` 是**一串**动作：预览态编辑攒序列，保存时合成一条算子，只编码一次。
 */
WebServer.prototype.handlePhotoEditTransform = function (req, res) {
  var self = this;
  if (!this.photoEdit) {
    this.jsonResponse(res, { success: false, error: 'EDIT_UNAVAILABLE' }, 503, req);
    return;
  }
  this.readJsonBody(req, res, function (data) {
    var id = parseInt(data && data.id, 10);
    var actions = data && data.actions != null ? data.actions : data && data.action;
    if (!isFinite(id) || id <= 0) {
      self.jsonResponse(res, { success: false, error: '无效的图片 ID' }, 400, req);
      return;
    }
    self.photoEdit
      .transform(id, actions)
      .then(function (r) {
        self.jsonResponse(
          res,
          {
            success: true,
            id: r.id,
            width: r.width,
            height: r.height,
            size: r.size,
            // 网页端靠它翻新 URL 缓存键（`app.js#photoCacheVersion`），漏了会看到旧图
            dateModified: r.dateModified,
          },
          200,
          req,
        );
      })
      .catch(function (err) {
        self.jsonResponse(
          res,
          { success: false, error: err && err.message ? err.message : String(err) },
          500,
          req,
        );
      });
  });
};

/**
 * POST /api/photo-edit-crop
 * body: `{ id: number, rect: { left, top, width, height } }`
 *
 * 裁剪并**另存副本**（副本进库）。`rect` 用「用户看到的图」的坐标系（EXIF 已转正）。
 */
WebServer.prototype.handlePhotoEditCrop = function (req, res) {
  var self = this;
  if (!this.photoEdit) {
    this.jsonResponse(res, { success: false, error: 'EDIT_UNAVAILABLE' }, 503, req);
    return;
  }
  this.readJsonBody(req, res, function (data) {
    var id = parseInt(data && data.id, 10);
    if (!isFinite(id) || id <= 0) {
      self.jsonResponse(res, { success: false, error: '无效的图片 ID' }, 400, req);
      return;
    }
    self.photoEdit
      .crop(id, data && data.rect)
      .then(function (r) {
        self.jsonResponse(
          res,
          {
            success: true,
            id: r.id,
            filePath: r.filePath,
            width: r.width,
            height: r.height,
            size: r.size,
            sourceId: r.sourceId,
          },
          200,
          req,
        );
      })
      .catch(function (err) {
        self.jsonResponse(
          res,
          { success: false, error: err && err.message ? err.message : String(err) },
          500,
          req,
        );
      });
  });
};

/**
 * POST /api/photo-edit-apply
 * body: `{ id: number, actions?: string[], crop?: {left,top,width,height}|null }`
 *
 * 预览态编辑点「保存」时网页端的**唯一**入口：一次请求把「一串变换 + 一个裁剪」落盘。
 * 顺序与「rect 用变换后的坐标系」这条契约收在 `photo-edit-service.js#applyEdit` 里 ——
 * 两端各写一遍必然有一端写反（网页端与桌面端共用同一个服务实例）。
 */
WebServer.prototype.handlePhotoEditApply = function (req, res) {
  var self = this;
  if (!this.photoEdit) {
    this.jsonResponse(res, { success: false, error: 'EDIT_UNAVAILABLE' }, 503, req);
    return;
  }
  this.readJsonBody(req, res, function (data) {
    var id = parseInt(data && data.id, 10);
    if (!isFinite(id) || id <= 0) {
      self.jsonResponse(res, { success: false, error: '无效的图片 ID' }, 400, req);
      return;
    }
    self.photoEdit
      .applyEdit(id, { actions: data && data.actions, crop: data && data.crop })
      .then(function (r) {
        self.jsonResponse(
          res,
          {
            success: true,
            id: r.id,
            width: r.width,
            height: r.height,
            size: r.size,
            // 网页端靠它翻新 URL 缓存键（`app.js#photoCacheVersion`），漏了会看到旧图
            dateModified: r.dateModified,
            crop: r.crop,
          },
          200,
          req,
        );
      })
      .catch(function (err) {
        self.jsonResponse(
          res,
          { success: false, error: err && err.message ? err.message : String(err) },
          500,
          req,
        );
      });
  });
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

WebServer.prototype.serveFileWithRange = function (
  req,
  res,
  filePath,
  size,
  contentType,
  cacheControl,
  etag,
) {
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
    var headers206 = {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': cacheControl || 'public, max-age=3600',
    };
    if (etag) headers206['ETag'] = etag;
    res.writeHead(206, headers206);
    var rs = fs.createReadStream(filePath, { start: start, end: end });
    rs.on('error', function () {
      try {
        res.destroy();
      } catch (e) {}
    });
    rs.pipe(res);
    return;
  }

  var headers200 = {
    'Accept-Ranges': 'bytes',
    'Content-Length': size,
    'Content-Type': contentType,
    'Cache-Control': cacheControl || 'public, max-age=3600',
  };
  if (etag) headers200['ETag'] = etag;
  res.writeHead(200, headers200);
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
        ext === '.svg'
          ? 'image/svg+xml'
          : ext === '.gif'
            ? 'image/gif'
            : 'application/octet-stream';
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
      // ⚠️ 这里是**预览图**缓存（2560 档），编码写死在生成处（`.jpeg({quality:88})`），
      //    与库里的缩略图无关 —— 缩略图那条路在 `handleThumb`，头按行派生。
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
      var siPv = await loadSharpInput().createSharpInput(fp, null);
      var buf = await siPv.instance
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
      // 🔴 传 `true`：回落时**不能再把本格式转回预览路径**，否则两条路互相回弹成死循环。
      this.handlePhoto(req, res, cleanId, true);
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
        // 🔴 不能直接 `sharp(filePath)`：cr2 / crw 会抛
        //    `Old-style JPEG compression support is not configured`
        //    ⇒ 网页端点开 RAW 永远是 500，而桌面端已经出图了。
        return loadSharpInput()
          .createSharpInput(filePath, null)
          .then(function (si) {
            return si.instance
              .rotate()
              .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: q })
              .toBuffer();
          });
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
  var options = {
    sortBy: query.sortBy || 'date_taken',
    sortOrder: query.sortOrder || 'DESC',
    page: parseInt(query.page) || 1,
    pageSize: Math.min(parseInt(query.pageSize) || 120, 500),
    rootId: query.rootId ? parseInt(query.rootId) : undefined,
    mediaType: query.mediaType || query.media_filter || query.media || undefined,
  };
  // 组织元数据筛选（评分 / 标记 / 标签）。
  //
  // ⚠️ `''` 一律当**没给**（不放这个键）：`<select>` 的「不限」档提交的就是空串。
  //    放进一个 `rating: 0` 会让主进程的 `!= null` 判据把它当成「只看未评分」——
  //    而「全部评分」与「只看未评分」在界面上是两个不同的档，混起来是静默的错筛。
  //
  // ⚠️ `tagIds` 走**逗号分隔**而不是重复参数：本文件的 query 是
  //    `Object.fromEntries(searchParams.entries())`，重复键只会留下**最后一个** ——
  //    用 `?tagIds=1&tagIds=2` 会静默变成「只筛 2」。这是查询串解析的硬约束，别改。
  if (query.rating !== undefined && query.rating !== '') {
    options.rating = parseInt(query.rating, 10);
  }
  if (query.flag !== undefined && query.flag !== '') {
    options.flag = String(query.flag);
  }
  if (query.tagIds !== undefined && query.tagIds !== '') {
    options.tagIds = String(query.tagIds)
      .split(',')
      .map(function (s) {
        return parseInt(s, 10);
      })
      .filter(function (n) {
        return isFinite(n) && n > 0;
      });
  }
  return options;
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

WebServer.prototype.handleToggleFavorite = function (req, res) {
  var self = this;
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  var body = '';
  req.on('data', function (chunk) {
    body += chunk;
  });
  req.on('end', function () {
    try {
      var data = JSON.parse(body);
      var id = parseInt(data.id, 10);
      if (isNaN(id) || id <= 0) {
        self.jsonResponse(res, { error: 'invalid id' }, 400, req);
        return;
      }
      var result = self.db.togglePhotoFavorite(id);
      if (!result) {
        self.jsonResponse(res, { error: 'photo not found' }, 404, req);
        return;
      }
      self.jsonResponse(res, result, 200, req);
    } catch (e) {
      self.jsonResponse(res, { error: 'invalid request' }, 400, req);
    }
  });
};

/**
 * 组织元数据（评分 / 标记 / 用户标签）的三个写入口 —— 2026-10-09。
 *
 * ## 为什么走 `self.db` 直写而不经主进程的写队列
 *
 * 与 `/api/toggle-favorite` 同一取向：元数据写入是**单行 UPDATE / 一个小事务**，
 * 不是扫描或维护那类长写。走写队列会给「手机点一下星」增加一次跨进程往返，
 * 而它本来就只是几毫秒的活。
 *
 * ⚠️ 代价：**不清读池缓存**的话，「仅 5 星」那一档的 `total` 会陈旧最多 5 秒
 *    （`photos-total-cache.js#PHOTOS_TOTAL_TTL_MS` 是硬上界）。桌面端是显式清
 *    （见 `main.js` 那组 handler），两端口径要一致 —— 所以这里经
 *    `onOrgMetaWritten` 把这件事交回主进程做，而不是在这边 require 读池
 *    （读池归 main 管，本文件不知道它存在）。
 *
 * ## 归一不在这里做
 *
 * 越界值 / 非法标记由 `database.js` 的 `normalizeRating` / `normalizeFlag` 夹取或回落，
 * 本层只做「形态校验」（id 是不是正整数、names 是不是数组）。在这里再夹一遍
 * 就是第二份取值域 —— 而两份漂移的症状是「网页端能用 7 星、桌面端不能」。
 */
WebServer.prototype.handlePhotoRating = function (req, res) {
  var self = this;
  this.readJsonBody(req, res, function (data) {
    var id = parseInt(data && data.id, 10);
    if (isNaN(id) || id <= 0) {
      self.jsonResponse(res, { success: false, error: 'invalid id' }, 400, req);
      return;
    }
    try {
      var result = self.db.setPhotoRating(id, data.rating);
      if (!result) {
        self.jsonResponse(res, { success: false, error: 'photo not found' }, 404, req);
        return;
      }
      self.notifyOrgMetaWritten('photo-rating');
      self.jsonResponse(res, { success: true, id: result.id, rating: result.rating }, 200, req);
    } catch (e) {
      self.jsonResponse(res, { success: false, error: 'write failed' }, 500, req);
    }
  });
};

WebServer.prototype.handlePhotoFlag = function (req, res) {
  var self = this;
  this.readJsonBody(req, res, function (data) {
    var id = parseInt(data && data.id, 10);
    if (isNaN(id) || id <= 0) {
      self.jsonResponse(res, { success: false, error: 'invalid id' }, 400, req);
      return;
    }
    try {
      // 🔴 `setPhotoFlag` 是**幂等设值**，不是 `togglePhotoFavorite` 那种翻转。
      //    网页端手机上是盲操作（一边看图一边点），做成翻转会让重复点把标记清掉。
      var result = self.db.setPhotoFlag(id, data.flag);
      if (!result) {
        self.jsonResponse(res, { success: false, error: 'photo not found' }, 404, req);
        return;
      }
      self.notifyOrgMetaWritten('photo-flag');
      self.jsonResponse(res, { success: true, id: result.id, flag: result.flag }, 200, req);
    } catch (e) {
      self.jsonResponse(res, { success: false, error: 'write failed' }, 500, req);
    }
  });
};

/** GET /api/photo-tags?id=123 —— 读某张图的用户标签。参数非法回**空数组**，不报错。 */
WebServer.prototype.handlePhotoTagsGet = function (req, res, query) {
  var id = parseInt(query && query.id, 10);
  if (isNaN(id) || id <= 0) {
    this.jsonResponse(res, { success: true, tags: [] }, 200, req);
    return;
  }
  try {
    this.jsonResponse(res, { success: true, tags: this.db.getPhotoTags(id) }, 200, req);
  } catch (e) {
    // 与 `/api/photo-ai-tags` 同一取向：读不到一律空结构，不把预览/列表打挂。
    this.jsonResponse(res, { success: true, tags: [] }, 200, req);
  }
};

/**
 * POST /api/photo-tags body `{ id, names: string[] }` —— **全量替换**某张图的标签集合。
 *
 * 返回的 `tags` 是**最终集合**（归一 / 去重 / 自动建标签都在数据层做），
 * 客户端必须用回包重画 chip，不能用自己敲进去的原文。
 */
WebServer.prototype.handlePhotoTagsSet = function (req, res) {
  var self = this;
  this.readJsonBody(req, res, function (data) {
    var id = parseInt(data && data.id, 10);
    if (isNaN(id) || id <= 0) {
      self.jsonResponse(res, { success: false, error: 'invalid id' }, 400, req);
      return;
    }
    if (data.names !== undefined && !Array.isArray(data.names)) {
      self.jsonResponse(res, { success: false, error: 'names must be an array' }, 400, req);
      return;
    }
    try {
      var result = self.db.setPhotoTags(id, data.names || []);
      if (!result) {
        self.jsonResponse(res, { success: false, error: 'photo not found' }, 404, req);
        return;
      }
      self.notifyOrgMetaWritten('photo-tags');
      self.jsonResponse(res, { success: true, id: result.id, tags: result.tags }, 200, req);
    } catch (e) {
      self.jsonResponse(res, { success: false, error: 'write failed' }, 500, req);
    }
  });
};

/** GET /api/tags —— 标签字典 + 使用计数（按使用量降序）。 */
WebServer.prototype.handleTagsList = function (req, res) {
  try {
    this.jsonResponse(res, { success: true, tags: this.db.listTags() }, 200, req);
  } catch (e) {
    this.jsonResponse(res, { success: true, tags: [] }, 200, req);
  }
};

/**
 * 通知主进程「组织元数据变了，清一下读池缓存」。
 *
 * 🔴 做成**注入**而不是在这里 `require('./db-read-worker-pool')`：那个池归 main 管
 *    （连接、worker 生命周期、失效时机都在那边），web-server 直接拿到它等于
 *    把「谁负责缓存一致性」这件事劈成两半。取不到就静默跳过 —— 后果是
 *    「total 最多陈旧 5 秒」（TTL 兜底），不是错误结果，所以不该因此拒绝写入。
 */
WebServer.prototype.notifyOrgMetaWritten = function (reason) {
  if (typeof this.onOrgMetaWritten === 'function') {
    try {
      this.onOrgMetaWritten(reason);
    } catch (e) {
      void e;
    }
  }
};

/**
 * 预选词（POST /api/ai-search-suggest）。
 *
 * **按 body 形状分岔成两条路**（2026-10-09 起；同桌面端，不是新旧替换）：
 *   - `{ lang, limit }`：**常规路径**，网页端唯一的用法。答案（每张图 top-3 标签的词表下标）
 *     已经在索引库里 ⇒ 主进程只读 SQL 转置统计即可（注入的 `getAiSuggestTerms`，实测 48 ms），
 *     **不起 worker、不载模型**。与桌面端同源同函数，两端摆出的词一致。
 *   - `{ candidates: [...] }`：老契约，对这一组**指定的**词打分。网页端不走这条，
 *     但只有 worker 那条路能对**词表外**的任意词真去打分 —— 只读 SQL 路只能在 308 词的词表里
 *     查下标，词表外的词一律 0。
 *
 * 两条路的回答形状**逐字段一致**（`{ sampled, terms: [{ text, hits }] }`）。
 * 🔴 但 `hits` 的口径两条路本来就不一样（老路 = CLIP 采样打分过的张数；只读路 = 把该词排进
 *    top-3 标签的张数）⇒ 它**只用于排序与挡掉 0 命中，不是张数**，不许显示给用户。
 */
WebServer.prototype.handleAiSearchSuggest = function (req, res) {
  var self = this;
  if (req.method !== 'POST') {
    this.jsonResponse(res, { error: 'method_not_allowed' }, 405, req);
    return;
  }
  // 常规路径根本不用编码器 —— 所以判据是「两条路**都没有**」才算不可用，
  // 不能只因为 `semanticSearch` 缺失就把预选词整条拒掉（老写法会在那种情形下 503）。
  if (!this.semanticSearch && !this.getAiSuggestTerms) {
    this.jsonResponse(res, { error: 'AI_UNAVAILABLE' }, 503, req);
    return;
  }
  var maxBody = 64 * 1024;
  var body = '';
  req.on('data', function (chunk) {
    body += chunk;
    if (body.length > maxBody) req.destroy();
  });
  req.on('end', function () {
    var data = null;
    try {
      data = JSON.parse(body);
    } catch (e) {
      /* 坏 body 由下面的校验分支统一拒绝 */
    }
    // ---- 老契约：给一组指定的词打分（要 worker）----
    if (data && Array.isArray(data.candidates)) {
      var list = data.candidates.slice(0, 64).map(function (item) {
        return String(item == null ? '' : item);
      });
      if (!list.length) {
        self.jsonResponse(res, { error: 'AI_SUGGEST_INVALID' }, 400, req);
        return;
      }
      if (!self.semanticSearch) {
        self.jsonResponse(res, { error: 'AI_UNAVAILABLE' }, 503, req);
        return;
      }
      var scoring = { candidates: list };
      if (self.getAiSearchMatchThreshold)
        scoring.threshold = Number(self.getAiSearchMatchThreshold());
      interactionPreempt
        .withPreempt(() => self.semanticSearch.run('suggest', '', scoring))
        .then((result) => {
          if (!res.destroyed) self.jsonResponse(res, result, 200, req);
        })
        .catch((error) => {
          if (!res.destroyed) self.jsonResponse(res, { error: error.message }, 503, req);
        });
      return;
    }
    if (!data || typeof data !== 'object') {
      self.jsonResponse(res, { error: 'AI_SUGGEST_INVALID' }, 400, req);
      return;
    }
    // ---- 常规路径：主进程只读 SQL，毫秒级 ----
    var payload = { lang: data.lang ? String(data.lang) : '' };
    if (data.limit !== undefined) payload.limit = Number(data.limit);
    interactionPreempt
      .withPreempt(() =>
        Promise.resolve(
          self.getAiSuggestTerms ? self.getAiSuggestTerms(payload) : { sampled: 0, terms: [] },
        ),
      )
      .then((result) => {
        if (!res.destroyed) self.jsonResponse(res, result, 200, req);
      })
      .catch((error) => {
        if (!res.destroyed) self.jsonResponse(res, { error: error.message }, 503, req);
      });
  });
};

/**
 * 人物改名（POST /api/person-rename）。
 * 名字是唯一会写进人脸索引的用户数据，所以只收 personId + name，其余一律拒绝；
 * 空名字表示「取消命名」，人物回到「未命名人物」，与桌面端行为一致。
 */
WebServer.prototype.handlePersonRename = function (req, res) {
  var self = this;
  if (req.method !== 'POST') {
    this.jsonResponse(res, { error: 'method_not_allowed' }, 405, req);
    return;
  }
  if (!this.faceService) {
    this.jsonResponse(res, { error: 'FACE_UNAVAILABLE' }, 503, req);
    return;
  }
  var body = '';
  req.on('data', function (chunk) {
    body += chunk;
  });
  req.on('end', function () {
    var data = null;
    try {
      data = JSON.parse(body);
    } catch (e) {
      /* 坏 body 不单独回错，统一走下面的校验分支返回 FACE_NAME_INVALID */
    }
    var personId = data ? parseInt(data.personId, 10) : NaN;
    // name 必须是字符串：客户端把名字传成数字时若退化成空串，会变成一次静默的
    // 「清空名字」。空串本身是合法输入（= 取消命名），但类型不对一律拒绝。
    var name = data && typeof data.name === 'string' ? data.name.trim() : null;
    if (name === null || name.length > 80 || !Number.isSafeInteger(personId) || personId <= 0) {
      self.jsonResponse(res, { error: 'FACE_NAME_INVALID' }, 400, req);
      return;
    }
    self.faceService
      .run('rename', { personId: personId, name: name })
      .then(function (result) {
        if (!res.destroyed) self.jsonResponse(res, result || {}, 200, req);
      })
      .catch(function (error) {
        if (!res.destroyed) self.jsonResponse(res, { error: error.message }, 503, req);
      });
  });
};

WebServer.prototype.handleDownload = async function (req, res, query) {
  var id = parseInt(query.id, 10);
  if (isNaN(id) || id <= 0) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  var photo = this.db.getFullPhoto(id);
  if (!photo || !photo.file_path) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  try {
    if (!(await fileExists(photo.file_path))) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    var ext = path.extname(photo.file_path).toLowerCase();
    var mimeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
    };
    var contentType = mimeMap[ext] || 'application/octet-stream';
    var fileName = path.basename(photo.file_path);
    var st = await fs.promises.stat(photo.file_path);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(fileName) + '"',
    });
    fs.createReadStream(photo.file_path).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
};

WebServer.prototype.handlePhotoInfo = function (req, res, query) {
  var self = this;
  var id = parseInt(query.id, 10);
  if (isNaN(id) || id <= 0) {
    self.jsonResponse(res, { error: 'invalid id' }, 400, req);
    return;
  }
  try {
    var photo = self.db.getPhotoInfo(id);
    if (!photo) {
      self.jsonResponse(res, { error: 'not found' }, 404, req);
      return;
    }
    self.jsonResponse(res, photo, 200, req);
  } catch (e) {
    self.jsonResponse(res, { error: 'internal error' }, 500, req);
  }
};

/**
 * 网页端「图片信息」面板要显示哪些字段。
 * 桌面端设置页是唯一的编辑入口，这里只读；拿不到（老版本主进程没注入回调）就回落默认集，
 * 于是网页端不会因为拿不到设置而变成空面板。
 */
/**
 * 网页端「设置」页的设置快照（只读）。
 *
 * 注入方负责白名单脱敏；这里拿不到注入函数时返回 `null` 而不是 500 ——
 * 设置页应当能在「桌面端还没注入」的情况下退化为一页说明，而不是整页报错。
 */
WebServer.prototype.handleSettingsSnapshot = function (req, res) {
  var snapshot = null;
  if (typeof this.getSettingsSnapshot === 'function') {
    try {
      snapshot = this.getSettingsSnapshot();
    } catch (e) {
      snapshot = null;
    }
  }
  this.jsonResponse(res, { ok: true, readOnly: true, settings: snapshot || null }, 200, req);
};

WebServer.prototype.handleInfoFields = function (req, res) {
  var ids = null;
  if (typeof this.getInfoPanelFields === 'function') {
    try {
      ids = this.getInfoPanelFields();
    } catch (e) {
      ids = null;
    }
  }
  this.jsonResponse(res, { fields: PhotoInfoFields.normalizeFieldIds(ids) }, 200, req);
};

/**
 * 网页端「图片信息」面板的 主题标签（只读）。
 *
 * 三种情况都返回空数组 —— 从没建过索引 / 索引了但这张没标签 / 索引库此刻被索引 worker
 * 占着写锁读不到。界面据「空数组」把这一行隐藏（既定取向：空值整行隐藏），
 * 所以这里不必区分。参数非法也不报错，回空即可 —— 面板是只读展示，不该因搜图索引的
 * 可用性而失败。
 */
WebServer.prototype.handlePhotoAiTags = function (req, res, query) {
  var tags = [];
  var id = Number(query && query.id);
  if (this.getPhotoAiTags && Number.isFinite(id)) {
    try {
      tags = this.getPhotoAiTags(id, String((query && query.locale) || 'zh-CN')) || [];
    } catch (e) {
      tags = [];
    }
  }
  this.jsonResponse(res, { tags: Array.isArray(tags) ? tags : [] }, 200, req);
};

/**
 * 「画面标签」（JoyTag）—— 与 handlePhotoAiTags 同构的只读接口（tag-index.sqlite）。
 * 参数非法 / 索引读不到都回空数组：面板是只读展示，空数组让注册表整行隐藏。
 */
WebServer.prototype.handlePhotoJoyTags = function (req, res, query) {
  var tags = [];
  var id = Number(query && query.id);
  if (this.getPhotoJoyTags && Number.isFinite(id)) {
    try {
      tags = this.getPhotoJoyTags(id, String((query && query.locale) || 'zh-CN')) || [];
    } catch (e) {
      tags = [];
    }
  }
  this.jsonResponse(res, { tags: Array.isArray(tags) ? tags : [] }, 200, req);
};

/**
 * 「标签导航页」的四条只读接口（分类树 / 节点标签 / 搜索 / 某标签下的照片）。
 *
 * 与 `/api/photo-joy-tags` 同一取向：**参数非法 / 索引读不到都回空结构**，不报错 ——
 * 导航页是只读展示，tag 索引还没建好的用户应当看到「这里还没有内容」而不是一个红色错误。
 * 数据全部来自主进程注入的同一个服务（桌面端与网页端读数必然一致）。
 */
WebServer.prototype.handleTagNavStatus = function (req, res) {
  var out = { available: false, tags: 0, photos: 0 };
  if (this.getTagNavStatus) {
    try {
      out = this.getTagNavStatus() || out;
    } catch (_) {}
  }
  this.jsonResponse(res, out, 200, req);
};

WebServer.prototype.handleTagNavTree = function (req, res) {
  var tree = [];
  if (this.getTagNavTree) {
    try {
      tree = this.getTagNavTree() || [];
    } catch (_) {
      tree = [];
    }
  }
  this.jsonResponse(res, { tree: Array.isArray(tree) ? tree : [] }, 200, req);
};

WebServer.prototype.handleTagNavNode = function (req, res, query) {
  var out = { tags: [], total: 0, indexed: 0 };
  var nodeId = String((query && query.node) || '');
  if (this.getTagNavNode && nodeId) {
    try {
      out = this.getTagNavNode(nodeId, String((query && query.locale) || 'zh-CN')) || out;
    } catch (_) {}
  }
  this.jsonResponse(res, out, 200, req);
};

WebServer.prototype.handleTagNavSearch = function (req, res, query) {
  var out = { tags: [], nodes: [], indexed: 0 };
  var keyword = String((query && query.q) || '');
  if (this.getTagNavSearch && keyword) {
    try {
      out = this.getTagNavSearch(keyword, String((query && query.locale) || 'zh-CN')) || out;
    } catch (_) {}
  }
  this.jsonResponse(res, out, 200, req);
};

/**
 * 某标签下的照片。复用 `parsePageOptions` 让分页参数与 `/api/photos` **同一套解析**
 * （自己再 parse 一遍就会出现「这边 pageSize 上限 500、那边 120」这类静默不一致）。
 */
WebServer.prototype.handleTagNavPhotos = function (req, res, query) {
  var out = { photos: [], total: 0, page: 1, pageSize: 120, totalPages: 1 };
  var tag = String((query && query.tag) || '');
  if (this.getTagNavPhotos && tag) {
    var options = this.parsePageOptions(query);
    options.tag = tag;
    options.locale = String((query && query.locale) || 'zh-CN');
    try {
      out = this.getTagNavPhotos(tag, options) || out;
    } catch (_) {}
  }
  this.jsonResponse(res, out, 200, req);
};

module.exports = WebServer;
