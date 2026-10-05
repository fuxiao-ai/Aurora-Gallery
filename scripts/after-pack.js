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
    // 随包内置模型：`models/face`（YuNet + w600k_mbf）与 `models/search`（SigLIP2 文本 + 视觉），
    // 连同 `models/manifest.json` 一起进 resources。运行时由 `src/ai/bundled-models.js` 播种到
    // 用户目录，用户就不必先点一次「下载模型」。目录不存在只是少了这层便利，不阻塞打包。
    const modelsSrc = path.join(projectDir, 'models');
    const modelsDest = path.join(appOutDir, 'resources', 'models');
    if (fs.existsSync(modelsSrc) && fs.statSync(modelsSrc).isDirectory()) {
      fs.mkdirSync(path.dirname(modelsDest), { recursive: true });
      fs.cpSync(modelsSrc, modelsDest, { recursive: true });
      console.log('[afterPack] bundled ai models (face + search) ->', modelsDest);
    } else {
      console.log(
        '[afterPack] optional project models/ missing; users will be asked to download the AI models in app settings',
      );
    }
  } catch (e) {
    console.warn('[afterPack] ai models bundle failed:', e && e.message ? e.message : e);
  }
};
