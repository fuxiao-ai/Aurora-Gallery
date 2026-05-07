const logger = require('./logger');
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSharp } = require('./utils');
const { ensureSettingsShape } = require('./settings');

// State
let mainWindow;
let tray = null;
let isQuitting = false;
/** 与可执行文件/自定义图标一致，供 macOS 再次 createWindow 使用 */
let cachedAppIcon = null;
/** The actual window creation function from main.js */
let createWindowInner = null;

function getMainWindow() {
  return mainWindow;
}

function setMainWindow(window) {
  mainWindow = window;
}

function getTray() {
  return tray;
}

function getIsQuitting() {
  return isQuitting;
}

function setIsQuitting(value) {
  isQuitting = value;
}

function getCachedAppIcon() {
  return cachedAppIcon;
}

function setCachedAppIcon(icon) {
  cachedAppIcon = icon;
}

function showMainWindow(createWindowFunc) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 静默启动时还没有创建过窗口，现在创建
    createWindowFunc(cachedAppIcon);
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function quitCompletely() {
  isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch (e) {}
  if (tray) {
    try {
      tray.destroy();
    } catch (e2) {}
    tray = null;
  }
  app.quit();
}

/** 与窗口一致：优先 src/web/app-icon-512.png，其次 src/app-icon.png，再回退 */
function resolveAppIcon() {
  var iconCandidates = [
    path.join(__dirname, '..', 'web', 'app-icon-512.png'),
    path.join(__dirname, '..', 'app-icon.png'),
  ];
  for (var ci = 0; ci < iconCandidates.length; ci++) {
    var iconPath = iconCandidates[ci];
    if (!fs.existsSync(iconPath)) continue;
    try {
      var custom = nativeImage.createFromPath(iconPath);
      if (!custom.isEmpty()) return Promise.resolve(custom);
    } catch (e) {}
  }
  function fromExeFileIcon() {
    return app.getFileIcon(app.getPath('exe'), { size: 'normal' }).then(function (img) {
      if (img && !img.isEmpty()) return img;
      return createTrayIconImage();
    });
  }
  // 打包版在部分 Windows 环境上对安装目录 exe 做 Shell 图标提取会长时间阻塞，窗口永远不出现
  if (process.platform === 'win32' && app.isPackaged) {
    return createTrayIconImage();
  }
  if (process.platform === 'win32') {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        logger.warn('[icon] getFileIcon slow, using fallback tray icon');
        createTrayIconImage().then(resolve);
      }, 3000);
      fromExeFileIcon()
        .catch(function () {
          return createTrayIconImage();
        })
        .then(function (img) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(img);
        })
        .catch(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          createTrayIconImage().then(resolve);
        });
    });
  }
  return fromExeFileIcon().catch(function () {
    return createTrayIconImage();
  });
}

function createTrayIconImageSync() {
  // 同步创建占位图标，确保托盘尽早可用
  return nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
}

function createTrayIconImage() {
  return loadSharp()({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 123, g: 140, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
    .then(function (buf) {
      return nativeImage.createFromBuffer(buf);
    })
    .catch(function () {
      return createTrayIconImageSync();
    });
}

function getNormalizedUiLocale(settings) {
  return settings && settings.uiLocale === 'en' ? 'en' : 'zh-CN';
}

function getLocalizedAppTitle(settings) {
  return getNormalizedUiLocale(settings) === 'en' ? 'Aurora Gallery' : '拂晓图库';
}

/** 窗口标题、托盘提示与托盘菜单（随 uiLocale 切换） */
function refreshTrayAndTitleLocalized(settings) {
  const main = require('../main');
  const actualSettings = settings || main.settings;
  ensureSettingsShape(actualSettings);
  var en = getNormalizedUiLocale(actualSettings) === 'en';
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setTitle(getLocalizedAppTitle(actualSettings));
    } catch (e) {}
  }
  if (tray) {
    try {
      tray.setToolTip(en ? 'Aurora Gallery (running in background)' : '拂晓图库（后台运行中）');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: en ? 'Show window' : '显示主窗口',
            click: function () {
              showMainWindow(createWindow);
            },
          },
          { type: 'separator' },
          {
            label: en ? 'Quit Aurora Gallery' : '退出拂晓图库',
            click: function () {
              quitCompletely();
            },
          },
        ]),
      );
    } catch (e2) {}
  }
}

function setupTray(icon, settings) {
  if (tray) return;
  try {
    tray = new Tray(icon);
  } catch (e) {
    const isDev = process.argv.includes('--dev');
    if (isDev) logger.warn('[tray] unavailable:', e && e.message ? e.message : String(e));
    return;
  }
  refreshTrayAndTitleLocalized(settings);
  tray.on('click', function () {
    showMainWindow(createWindow);
  });
}

function registerBackgroundShortcut() {
  try {
    globalShortcut.unregister('CommandOrControl+Shift+H');
    globalShortcut.unregister('Control+Q');
  } catch (e) {}
  var ok = globalShortcut.register('Control+Q', function () {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else showMainWindow(createWindow);
  });
  const isDev = process.argv.includes('--dev');
  if (!ok && isDev) logger.warn('[shortcut] Ctrl+Q register failed');
}

function setCreateWindowInner(fn) {
  createWindowInner = fn;
}

function createWindow(appIcon) {
  cachedAppIcon = appIcon;
  if (!createWindowInner) {
    logger.error('[tray] createWindowInner not set');
    return;
  }
  return createWindowInner(appIcon);
}

module.exports = {
  // State getters/setters
  getMainWindow,
  setMainWindow,
  getTray,
  setTray: (t) => {
    tray = t;
  },
  getIsQuitting,
  setIsQuitting,
  getCachedAppIcon,
  setCachedAppIcon,
  setCreateWindowInner,
  // Functions
  showMainWindow,
  quitCompletely,
  resolveAppIcon,
  createTrayIconImageSync,
  createTrayIconImage,
  getNormalizedUiLocale,
  getLocalizedAppTitle,
  refreshTrayAndTitleLocalized,
  setupTray,
  registerBackgroundShortcut,
  createWindow,
};
