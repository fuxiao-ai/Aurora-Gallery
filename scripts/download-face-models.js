'use strict';
const path = require('node:path');
const logger = require('../src/main/logger');

async function run(args) {
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: npm run download-face-models -- [--directory <model-directory>]\nDefaults to the development app face-index/models directory.\n',
    );
    return;
  }
  if (args.length && (args.length !== 2 || args[0] !== '--directory' || !args[1].trim()))
    throw new Error('Expected --directory <model-directory>; use --help for usage.');
  // 🔴 默认落点必须跟着**活跃**数据目录走（可迁移，见 src/main/data-dir.js 的说明）——
  //    写死 `%LOCALAPPDATA%\aurora-gallery\UserData` 的话，迁移之后模型会下到旧位置，
  //    应用在新位置找不到模型，表现成「模型没下过」。
  const directory = args.length
    ? path.resolve(args[1])
    : path.join(require('../src/main/data-dir').resolveActiveDataDir().dir, 'face-index', 'models');
  const model = require('../src/ai/face-model');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    await model.install(directory, controller.signal, ({ file, percent }) => {
      process.stdout.write('\r' + file + ' ' + percent + '%   ');
    });
    if (!(await model.verify(directory))) throw new Error('Model verification failed');
    process.stdout.write('\nModels verified: ' + directory + '\n');
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}
run(process.argv.slice(2)).catch((error) => {
  logger.error(error.message);
  process.exitCode = 1;
});
