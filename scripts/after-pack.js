'use strict';

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const projectDir = context && context.packager ? context.packager.projectDir : process.cwd();
  const appOutDir = context && context.appOutDir ? context.appOutDir : '';
  if (!projectDir || !appOutDir) return;

  try {
    const isWin = (context && context.electronPlatformName) === 'win32';
    const srcName = isWin ? 'cloudflared.exe' : 'cloudflared';
    const src = path.join(projectDir, 'bin', srcName);
    if (fs.existsSync(src)) {
      const targetDir = path.join(appOutDir, 'resources', 'bin');
      const dest = path.join(targetDir, srcName);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(src, dest);
      console.log('[afterPack] bundled cloudflared:', dest);
    } else {
      console.log('[afterPack] cloudflared not found, skip:', src);
    }
  } catch (e) {
    console.warn('[afterPack] cloudflared bundle failed:', e && e.message ? e.message : e);
  }

  try {
    const modelsSrc = path.join(projectDir, 'models');
    const modelsDest = path.join(appOutDir, 'resources', 'models');
    if (fs.existsSync(modelsSrc) && fs.statSync(modelsSrc).isDirectory()) {
      fs.mkdirSync(path.dirname(modelsDest), { recursive: true });
      fs.cpSync(modelsSrc, modelsDest, { recursive: true });
      console.log('[afterPack] bundled face models from project models/ ->', modelsDest);
    } else {
      console.log('[afterPack] project models/ missing, skip face ONNX (run: node scripts/download-face-models.js)');
    }
  } catch (e) {
    console.warn('[afterPack] face models bundle failed:', e && e.message ? e.message : e);
  }
};
