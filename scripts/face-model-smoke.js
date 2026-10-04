'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const sharp = require('sharp');
const model = require('../src/ai/face-model');
async function run() {
  if (!process.argv[2] || !process.argv[3])
    throw new Error(
      'Usage: node scripts/face-model-smoke.js <model-directory> <face-photo> [--download]',
    );
  const directory = path.resolve(process.argv[2]);
  if (process.argv.includes('--download'))
    await model.install(directory, new AbortController().signal, () => {});
  const encoder = await model.load(directory);
  try {
    const first = await encoder.detect(path.resolve(process.argv[3]));
    assert.ok(first.length > 0, 'detect a face in the public fixture');
    const variation = await sharp(path.resolve(process.argv[3]))
      .resize(400)
      .modulate({ brightness: 1.05 })
      .jpeg()
      .toBuffer();
    const second = await encoder.detect(variation);
    assert.ok(second.length > 0);
    const match = model.similarity(first[0].vector, second[0].vector);
    assert.ok(match >= 0.6, 'same face matches after resizing/brightness change');
    const blank = await sharp({
      create: { width: 320, height: 320, channels: 3, background: '#888888' },
    })
      .png()
      .toBuffer();
    assert.equal((await encoder.detect(blank)).length, 0);
    const otherArg = process.argv.indexOf('--other');
    if (otherArg >= 0) {
      const other = await encoder.detect(path.resolve(process.argv[otherArg + 1]));
      assert.ok(other.length > 0, 'detect the second fixture face');
      assert.ok(
        other.every((face) => model.similarity(first[0].vector, face.vector) < 0.6),
        'different fixture faces remain separate',
      );
    }
    console.log('[face-model-smoke] PASS', { faces: first.length, sameFaceSimilarity: match });
  } finally {
    await encoder.dispose();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
