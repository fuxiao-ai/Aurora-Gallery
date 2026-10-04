'use strict';
// Explicit opt-in: downloads the pinned model to the supplied cache, never reads the user's library.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const { loadEncoder, DIMENSIONS, pack, score } = require('../src/ai/embedding');

async function run() {
  if (!process.argv[2])
    throw new Error('Usage: node scripts/semantic-model-smoke.js <cache-directory> [--offline]');
  const encoder = await loadEncoder(path.resolve(process.argv[2]), {
    download: !process.argv.includes('--offline'),
    progress(event) {
      if (event.status === 'done') console.log('[model]', event.file, 'ready');
    },
  });
  try {
    const chinese = await encoder.text('一只猫');
    const english = await encoder.text('a cat');
    const unrelated = await encoder.text('a snow-covered mountain');
    assert.equal(chinese.length, DIMENSIONS);
    assert.ok(
      score(chinese, pack(english)) > score(chinese, pack(unrelated)),
      'Chinese/English cat descriptions align',
    );
    // 批量编码（预选词要一次编几百个词）。**不与单条逐位相同** —— 本项目实测
    // 最大逐位差约 0.008，来自 q8 量化在不同 batch 形状下的数值差异；预选词每次都走批量、
    // 口径自洽，所以这里钉的是「量级一致」而不是「完全相同」。
    // 真正不能碰的是 padding 长度：改成动态 padding 会把差拉到 0.38，见 ai/embedding.js。
    const batch = await encoder.texts(['一只猫', 'a cat', 'a snow-covered mountain']);
    assert.equal(batch.length, 3, '批量编码的条数要对得上');
    for (const [index, single] of [chinese, english, unrelated].entries()) {
      let max = 0;
      for (let i = 0; i < DIMENSIONS; i += 1) max = Math.max(max, Math.abs(batch[index][i] - single[i]));
      assert.ok(max < 0.05, 'texts() 与 text() 必须量级一致，第 ' + index + ' 条最大逐位差 ' + max);
      assert.ok(
        score(batch[index], pack(batch[index])) > 0.999,
        '批量出来的也必须是归一化向量',
      );
    }
    assert.equal((await encoder.texts([])).length, 0, '空数组直接返回空');
    // 跨批次（批大小 16）：21 条要原样返回 21 条
    assert.equal(
      (await encoder.texts(Array.from({ length: 21 }, (_, i) => 'sample ' + i))).length,
      21,
      '跨批次的条数不能丢',
    );
    const images = [];
    for (const color of ['#ff0000', '#0000ff']) {
      const bytes = await sharp({
        create: { width: 224, height: 224, channels: 3, background: color },
      })
        .png()
        .toBuffer();
      images.push(await encoder.image(bytes));
    }
    const red = await encoder.text('红色的图片');
    console.log('[color diagnostic]', {
      red: score(red, pack(images[0])),
      blue: score(red, pack(images[1])),
    });
    const fixtureArg = process.argv.indexOf('--fixtures');
    if (fixtureArg < 0 || !process.argv[fixtureArg + 1])
      throw new Error(
        'Pass --fixtures <directory containing cat.jpg and football.jpg> to test real image retrieval',
      );
    const directory = path.resolve(process.argv[fixtureArg + 1]);
    const cat = await encoder.image(fs.readFileSync(path.join(directory, 'cat.jpg')));
    const football = await encoder.image(fs.readFileSync(path.join(directory, 'football.jpg')));
    for (const query of ['一只猫', 'a cat', '一场足球比赛', 'a football match']) {
      const vector = await encoder.text(query);
      const scores = [score(vector, pack(cat)), score(vector, pack(football))];
      console.log('[retrieval]', query, scores);
      assert.ok(
        query.includes('猫') || query.includes('cat')
          ? scores[0] > scores[1]
          : scores[1] > scores[0],
        query,
      );
    }
    console.log('[semantic-model-smoke] PASS: multilingual text and real image retrieval');
  } finally {
    await encoder.dispose();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
