const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

// Task state
const tunnelTask = {
  enabled: false,
  running: false,
  url: '',
  status: 'idle',
  error: '',
};

let tunnelProcess = null;
let tunnelStartTimeoutTimer = null;
let tunnelLogTail = [];

function resolveCloudflaredPath() {
  var candidates = [];
  if (process.platform === 'win32') {
    candidates.push(path.join(process.resourcesPath || '', 'bin', 'cloudflared.exe'));
    candidates.push(path.join(process.resourcesPath || '', 'cloudflared.exe'));
    candidates.push(path.join(process.cwd(), 'bin', 'cloudflared.exe'));
  } else {
    candidates.push(path.join(process.resourcesPath || '', 'bin', 'cloudflared'));
    candidates.push(path.join(process.resourcesPath || '', 'cloudflared'));
    candidates.push(path.join(process.cwd(), 'bin', 'cloudflared'));
  }
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (e0) {}
  }
  try {
    var cmd = process.platform === 'win32' ? 'where' : 'which';
    var r = spawnSync(cmd, ['cloudflared'], { windowsHide: true, encoding: 'utf8' });
    if (r && r.status === 0) {
      var out = String(r.stdout || '')
        .split(/\r?\n/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      if (out.length > 0) return out[0];
    }
  } catch (e1) {}
  return '';
}

function getTunnelPrerequisiteState() {
  var p = resolveCloudflaredPath();
  var ok = !!p;
  return {
    ok: ok,
    path: p,
    message: ok ? '' : '未找到 cloudflared，请安装或将 cloudflared 可执行文件放到 PATH',
  };
}

function getTunnelStatus() {
  var pre = getTunnelPrerequisiteState();
  return {
    enabled: !!tunnelTask.enabled,
    running: !!tunnelTask.running,
    url: tunnelTask.url || '',
    status: tunnelTask.status || 'idle',
    error: tunnelTask.error || '',
    ready: pre.ok,
    binaryPath: pre.path || '',
    prereqMessage: pre.message || '',
    logTail: Array.isArray(tunnelLogTail) ? tunnelLogTail.join('\n') : '',
  };
}

function stopCloudflareTunnelInternal() {
  tunnelLogTail = [];
  if (tunnelStartTimeoutTimer) {
    try {
      clearTimeout(tunnelStartTimeoutTimer);
    } catch (e0) {}
    tunnelStartTimeoutTimer = null;
  }
  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch (e) {}
    tunnelProcess = null;
  }
  tunnelTask.running = false;
  tunnelTask.url = '';
  tunnelTask.status = 'stopped';
}

function startCloudflareTunnelInternal(webServerPort, settings) {
  if (tunnelProcess) return Promise.resolve(getTunnelStatus());
  var pre = getTunnelPrerequisiteState();
  if (!pre.ok) {
    throw new Error(pre.message);
  }
  if (!settings.webPassword || !String(settings.webPassword).trim()) {
    throw new Error('请先设置网页访问密码，再开启 Cloudflare Tunnel');
  }
  if (!webServerPort) {
    throw new Error('Web 服务未就绪');
  }
  tunnelTask.running = true;
  tunnelTask.status = 'starting';
  tunnelTask.error = '';
  tunnelTask.url = '';
  tunnelLogTail = [];
  var localUrl = 'http://127.0.0.1:' + webServerPort;
  var proc = spawn(pre.path, ['tunnel', '--url', localUrl, '--no-autoupdate'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tunnelProcess = proc;
  var outputCarry = '';
  function extractTunnelUrlFromText(text) {
    var raw = String(text || '');
    // 去除常见 ANSI 颜色码，避免匹配失败
    var clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
    var m = clean.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com(?:\/[^\s"']*)?/);
    return m && m[0] ? m[0] : '';
  }
  function pushTunnelLogLines(text) {
    var clean = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
    var lines = clean.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var s = String(lines[i] || '').trimEnd();
      if (!s) continue;
      tunnelLogTail.push(s);
      if (tunnelLogTail.length > 40) tunnelLogTail.shift();
    }
  }
  function handleOutput(chunk) {
    // cloudflared 输出可能被拆分成多个 chunk，需拼接缓冲后再匹配
    var raw = String(chunk || '');
    pushTunnelLogLines(raw);
    outputCarry += raw;
    if (outputCarry.length > 8192) {
      outputCarry = outputCarry.slice(-4096);
    }
    var u = extractTunnelUrlFromText(outputCarry);
    if (u) {
      tunnelTask.url = u;
      tunnelTask.status = 'running';
      tunnelTask.error = '';
      if (tunnelStartTimeoutTimer) {
        try {
          clearTimeout(tunnelStartTimeoutTimer);
        } catch (eT) {}
        tunnelStartTimeoutTimer = null;
      }
    }
  }
  if (tunnelStartTimeoutTimer) {
    try {
      clearTimeout(tunnelStartTimeoutTimer);
    } catch (eTs0) {}
    tunnelStartTimeoutTimer = null;
  }
  tunnelStartTimeoutTimer = setTimeout(function () {
    if (!tunnelProcess || tunnelProcess !== proc) return;
    if (tunnelTask.url) return;
    tunnelTask.running = false;
    tunnelTask.status = 'error';
    tunnelTask.error = 'Tunnel 启动超时（未获取到公网地址）';
    try {
      proc.kill();
    } catch (eKill) {}
  }, 25000);
  if (proc.stdout) proc.stdout.on('data', handleOutput);
  if (proc.stderr) proc.stderr.on('data', handleOutput);
  proc.on('error', function (err) {
    if (tunnelStartTimeoutTimer) {
      try {
        clearTimeout(tunnelStartTimeoutTimer);
      } catch (eT2) {}
      tunnelStartTimeoutTimer = null;
    }
    tunnelTask.running = false;
    tunnelTask.status = 'error';
    var msg = err && err.message ? err.message : 'cloudflared 启动失败';
    if (err && err.code === 'ENOENT') {
      msg = '未找到 cloudflared，请安装或将 cloudflared 可执行文件放到 PATH';
    }
    tunnelTask.error = msg;
    tunnelProcess = null;
  });
  proc.on('exit', function (code) {
    if (tunnelStartTimeoutTimer) {
      try {
        clearTimeout(tunnelStartTimeoutTimer);
      } catch (eT3) {}
      tunnelStartTimeoutTimer = null;
    }
    tunnelTask.running = false;
    if (tunnelTask.status !== 'error') {
      tunnelTask.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0) tunnelTask.error = 'cloudflared 已退出，代码 ' + code;
    }
    tunnelProcess = null;
  });
  return Promise.resolve(getTunnelStatus());
}

function setEnabled(enabled) {
  tunnelTask.enabled = enabled;
}

function getTaskState() {
  return tunnelTask;
}

function getProcess() {
  return tunnelProcess;
}

function setProcess(proc) {
  tunnelProcess = proc;
}

module.exports = {
  resolveCloudflaredPath,
  getTunnelPrerequisiteState,
  getTunnelStatus,
  getTaskState,
  stopCloudflareTunnelInternal,
  startCloudflareTunnelInternal,
  setEnabled,
};
