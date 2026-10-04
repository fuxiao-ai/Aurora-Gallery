'use strict';
const path = require('node:path');
const os = require('node:os');
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
  const appData =
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  if (!appData && !args.length) throw new Error('Cannot locate app data; specify --directory.');
  const directory = args.length
    ? path.resolve(args[1])
    : path.join(appData, 'aurora-gallery', 'UserData', 'face-index', 'models');
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
