'use strict';
// 内存实测：搜图只载文本编码器（textOnly）到底比「文本 + 视觉」少占多少常驻内存。
// 两段加载是**串行**的（先 textOnly、量完、dispose，再载两份）——并发载入两份 SigLIP2 正是
// 会把进程搞死的那条路；串行也刚好和真实使用一致：每次操作结束就释放模型，下次重新载。
// 顺带断言 textOnly 的行为：文本能用、视觉会明确报错（而不是返回一个错的向量）。
// 用法：electron scripts/semantic-encoder-memory-smoke.js <搜图模型目录>
const assert = require('node:assert/strict');
const path = require('node:path');
const sharp = require('sharp');
const { loadEncoder, DIMENSIONS } = require('../src/ai/embedding');

const MB = 1024 * 1024;
const rss = () => process.memoryUsage().rss;
const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

async function run() {
  const models = process.argv[2];
  if (!models)
    throw new Error('Usage: electron scripts/semantic-encoder-memory-smoke.js <models-directory>');
  const cacheDir = path.resolve(models);
  const bytes = await sharp({
    create: { width: 224, height: 224, channels: 3, background: '#888888' },
  })
    .png()
    .toBuffer();

  await settle();
  const baseline = rss();

  const textOnly = await loadEncoder(cacheDir, { textOnly: true });
  let textRss;
  try {
    assert.equal(textOnly.textOnly, true, 'textOnly 开关要被如实反映在编码器上');
    assert.equal((await textOnly.text('a cat')).length, DIMENSIONS, '文本仍然产出 768 维向量');
    await assert.rejects(textOnly.image(bytes), /AI_VISION_UNAVAILABLE/, 'textOnly 不能编码图片');
    await settle();
    textRss = rss();
  } finally {
    await textOnly.dispose();
  }

  const full = await loadEncoder(cacheDir, {});
  let fullRss;
  try {
    assert.equal(full.textOnly, false, '默认要带视觉编码器');
    assert.equal((await full.text('a cat')).length, DIMENSIONS);
    // 视觉会话要真正跑一次，权重才算落地，RSS 才有可比性。
    assert.equal((await full.image(bytes)).length, DIMENSIONS);
    await settle();
    fullRss = rss();
  } finally {
    await full.dispose();
  }

  const saved = (fullRss - textRss) / MB;
  assert.ok(
    fullRss - textRss >= 40 * MB,
    'textOnly 至少要省下 40 MB 常驻内存，实测 ' + Math.round(saved) + ' MB',
  );
  console.log(
    '[semantic-encoder-memory-smoke] PASS: 基线 ' +
      Math.round(baseline / MB) +
      ' MB → 只载文本 ' +
      Math.round(textRss / MB) +
      ' MB → 文本+视觉 ' +
      Math.round(fullRss / MB) +
      ' MB（textOnly 省 ' +
      Math.round(saved) +
      ' MB）',
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
