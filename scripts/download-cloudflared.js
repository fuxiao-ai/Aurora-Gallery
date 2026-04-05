'use strict';

/**
 * 从 Cloudflare 官方 GitHub Release 下载 cloudflared，写入项目 bin/，供 afterPack 打进安装包。
 *
 * 用法：
 *   node scripts/download-cloudflared.js                    # 当前系统对应二进制
 *   node scripts/download-cloudflared.js --target win32     # 始终拉 Windows x64（任意主机上打 win 包）
 *   node scripts/download-cloudflared.js --target darwin  # macOS；非 Mac 主机请配合 --arch
 *   node scripts/download-cloudflared.js --target linux
 *   node scripts/download-cloudflared.js --force            # 已存在也重新下载
 *
 * --arch arm64 | x64   仅 darwin/linux 在无法从 process.arch 推断时使用（如在 Linux CI 打 mac 包）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function parseArgs() {
  var argv = process.argv.slice(2);
  var force = argv.indexOf('--force') !== -1;
  var target = null;
  var archOpt = null;
  var i;
  for (i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) {
      target = String(argv[i + 1]).toLowerCase();
      i++;
    } else if (argv[i] === '--arch' && argv[i + 1]) {
      archOpt = String(argv[i + 1]).toLowerCase();
      i++;
    }
  }
  return { force: force, target: target, archOpt: archOpt };
}

function normalizeArch(a) {
  if (a === 'x64' || a === 'amd64') return 'amd64';
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  return a;
}

function resolveSpec(args) {
  var plat = args.target;
  if (!plat) {
    plat = process.platform;
    if (plat === 'win32') return { plat: 'win32', kind: 'exe', asset: 'cloudflared-windows-amd64.exe', dest: 'cloudflared.exe' };
    if (plat === 'darwin') {
      var da = normalizeArch(process.arch) === 'arm64' ? 'arm64' : 'amd64';
      return {
        plat: 'darwin',
        kind: 'tgz',
        asset: da === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz',
        dest: 'cloudflared',
      };
    }
    if (plat === 'linux') {
      var la = normalizeArch(process.arch) === 'arm64' ? 'arm64' : 'amd64';
      return {
        plat: 'linux',
        kind: 'bin',
        asset: la === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64',
        dest: 'cloudflared',
      };
    }
    throw new Error('不支持的平台: ' + plat + '（请使用 --target win32|darwin|linux）');
  }

  if (plat === 'win32') {
    return { plat: 'win32', kind: 'exe', asset: 'cloudflared-windows-amd64.exe', dest: 'cloudflared.exe' };
  }
  if (plat === 'darwin') {
    var darch = args.archOpt ? normalizeArch(args.archOpt) : null;
    if (!darch) {
      darch = process.platform === 'darwin' ? normalizeArch(process.arch) : 'arm64';
    }
    if (darch !== 'arm64' && darch !== 'amd64') {
      throw new Error('darwin 请指定 --arch arm64 或 x64');
    }
    return {
      plat: 'darwin',
      kind: 'tgz',
      asset: darch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz',
      dest: 'cloudflared',
    };
  }
  if (plat === 'linux') {
    var larch = args.archOpt ? normalizeArch(args.archOpt) : 'amd64';
    if (larch !== 'arm64' && larch !== 'amd64') {
      throw new Error('linux 请指定 --arch arm64 或 x64');
    }
    return {
      plat: 'linux',
      kind: 'bin',
      asset: larch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64',
      dest: 'cloudflared',
    };
  }
  throw new Error('未知 --target: ' + plat);
}

async function downloadToFile(url, destPath) {
  var res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' ' + url);
  }
  var buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

function findCloudflaredBinary(rootDir) {
  var stack = [rootDir];
  while (stack.length) {
    var dir = stack.pop();
    var names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    var j;
    for (j = 0; j < names.length; j++) {
      var n = names[j];
      var p = path.join(dir, n);
      var st;
      try {
        st = fs.statSync(p);
      } catch (e2) {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (n === 'cloudflared' || (process.platform === 'win32' && n === 'cloudflared.exe')) {
        return p;
      }
    }
  }
  return '';
}

function extractTgz(tgzPath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  var r = spawnSync('tar', ['-xzf', tgzPath, '-C', extractDir], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error('解压失败: ' + (r.stderr || r.stdout || 'tar exit ' + r.status));
  }
}

(async function main() {
  var args = parseArgs();
  var spec = resolveSpec(args);
  var destPath = path.join(BIN_DIR, spec.dest);

  if (!args.force && fs.existsSync(destPath)) {
    var st = fs.statSync(destPath);
    if (st.isFile() && st.size > 1024) {
      console.log('[download-cloudflared] 已存在，跳过（加 --force 可重新下载）:', destPath);
      return;
    }
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  var url = RELEASE_BASE + spec.asset;
  process.stdout.write('[download-cloudflared] ' + url + '\n');

  if (spec.kind === 'exe' || spec.kind === 'bin') {
    var n = await downloadToFile(url, destPath);
    if (spec.kind === 'bin' && process.platform !== 'win32') {
      try {
        fs.chmodSync(destPath, 0o755);
      } catch (e) {
        void e;
      }
    }
    console.log('[download-cloudflared] ->', destPath, '(' + Math.round(n / 1024 / 1024) + ' MB)');
    return;
  }

  if (spec.kind !== 'tgz') throw new Error('internal: unknown kind');

  var tgzPath = path.join(BIN_DIR, '.cloudflared-download.tgz');
  await downloadToFile(url, tgzPath);
  var extractDir = path.join(BIN_DIR, '.extract-cloudflared');
  try {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    extractTgz(tgzPath, extractDir);
  } finally {
    try {
      fs.unlinkSync(tgzPath);
    } catch (e3) {
      void e3;
    }
  }

  var inner = findCloudflaredBinary(extractDir);
  if (!inner) {
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch (e4) {
      void e4;
    }
    throw new Error('压缩包内未找到 cloudflared 可执行文件');
  }
  fs.copyFileSync(inner, destPath);
  try {
    fs.chmodSync(destPath, 0o755);
  } catch (e5) {
    void e5;
  }
  try {
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch (e6) {
    void e6;
  }
  console.log('[download-cloudflared] ->', destPath);
})().catch(function (e) {
  console.error('[download-cloudflared]', e && e.message ? e.message : e);
  process.exit(1);
});
