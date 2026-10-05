const js = require('@eslint/js');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'dist/**',
      'out/**',
      'tmp-*.js',
      '**/*.min.js',
      'src/renderer/vendor/**',
      // `.workbuddy/` 是工具工作区（记忆、契约、artifacts/ 下的临时调试脚本），不是产品代码。
      // 里面的临时脚本会污染 `npx eslint .`，让发版前的这道闸门常年为红 → 整体忽略。
      // ⚠️ 基线判据是 `npx eslint src scripts`（0 error / 6 warning），本项只为让 `npx eslint .` 也能当闸门用。
      '.workbuddy/**',
    ],
  },
  js.configs.recommended,
  {
    rules: {
      'no-var': 'off',
      'prefer-const': 'warn',
      // 降噪：大量 catch(e) 并未使用 e；同时允许用 _ 前缀显式标注“故意未用”
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
    },
  },
  // Node / CommonJS（Electron 主进程、内置服务器、打包脚本等）
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        AbortController: 'readonly',
        Headers: 'readonly',
        ReadableStream: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
      },
    },
  },
  // Browser（渲染层与 Web 页面脚本）
  {
    files: [
      'src/renderer/**/*.js',
      'src/web/**/*.js',
      'src/hls-attach.js',
      'src/playback-strategy.js',
    ],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        CSS: 'readonly',
        ResizeObserver: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        Hls: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        requestIdleCallback: 'readonly',
        cancelIdleCallback: 'readonly',
        confirm: 'readonly',
        appAlert: 'readonly',
        appConfirm: 'readonly',
        api: 'readonly',
        formatNumber: 'readonly',
        Logger: 'readonly',
        /** 相册 Web：web-theme-shared.js 先于 app.js 加载时注入 */
        WebTheme: 'readonly',
      },
    },
  },
];
