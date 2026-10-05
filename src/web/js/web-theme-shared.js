/**
 * 网页端主题（与桌面端 `src/renderer/styles.css` 同源）。
 *
 * 模型与桌面端一致：**外观 = 三元组 (theme, uiAccent, uiBackground)**。
 *   - 背景九件套由 `theme × uiBackground` 决定（BG_TOKENS）
 *   - 强调色由 `theme × uiAccent` 决定（ACCENT_TOKENS）
 *   - 预设只是「快捷组合」（WEB_THEME_PRESETS），凑不出预设时 themeStyle 为空串（自定义组合）
 *   - 同一背景档被多个预设共用时（浅色 warm、深色 default）再按强调色细分（APPEARANCE_OVERRIDES）
 *
 * ⚠️ 色值必须与 `src/renderer/styles.css` 的 `[data-bg]` 档 / accent 块 / 主题组合块逐项一致，
 *    `theme-regression` 会解析两边源码比对。改色值请两端一起改。
 */
(function (global) {
  /** 预设 id → 三元组；顺序与桌面端 ui-shell.js / main.js 一致 */
  var WEB_THEME_PRESETS = {
    midnight_classic: { theme: 'dark', uiAccent: 'violet', uiBackground: 'default' },
    ice_deep: { theme: 'dark', uiAccent: 'cyan', uiBackground: 'amoled' },
    amber_dawn: { theme: 'dark', uiAccent: 'amber', uiBackground: 'warm' },
    forest_shadow: { theme: 'dark', uiAccent: 'teal', uiBackground: 'cool' },
    ember_night: { theme: 'dark', uiAccent: 'rose', uiBackground: 'ink' },
    graphite_night: { theme: 'dark', uiAccent: 'mono', uiBackground: 'default' },
    nebula_violet: { theme: 'dark', uiAccent: 'violet', uiBackground: 'ink' },
    pine_abyss: { theme: 'dark', uiAccent: 'teal', uiBackground: 'default' },
    mocha_night: { theme: 'dark', uiAccent: 'amber', uiBackground: 'ink' },
    glass_night: { theme: 'dark', uiAccent: 'violet', uiBackground: 'glass' },
    aurora_night: { theme: 'dark', uiAccent: 'teal', uiBackground: 'aurora' },
    sky_light: { theme: 'light', uiAccent: 'cyan', uiBackground: 'ink' },
    cherry_blossom: { theme: 'light', uiAccent: 'rose', uiBackground: 'warm' },
    lavender_dusk: { theme: 'light', uiAccent: 'violet', uiBackground: 'warm' },
    arctic_mint: { theme: 'light', uiAccent: 'teal', uiBackground: 'cool' },
    desert_sand: { theme: 'light', uiAccent: 'amber', uiBackground: 'default' },
    paper_gray: { theme: 'light', uiAccent: 'mono', uiBackground: 'amoled' },
    sage_morning: { theme: 'light', uiAccent: 'teal', uiBackground: 'default' },
    apricot_haze: { theme: 'light', uiAccent: 'amber', uiBackground: 'ink' },
    frost_cyan: { theme: 'light', uiAccent: 'cyan', uiBackground: 'cool' },
    glass_day: { theme: 'light', uiAccent: 'cyan', uiBackground: 'glass' },
    aurora_dawn: { theme: 'light', uiAccent: 'violet', uiBackground: 'aurora' },
  };

  /* ⚠️ 这两个白名单必须与桌面端 src/main.js 的 UI_ACCENT_ALLOWED / UI_BG_ALLOWED
     逐位一致（theme-regression 拿它们做 JSON 相等比对）。后四个强调色与后四个背景档
     是 2026-10-04 补的「自定义两维」选项，**不被任何预设使用**。 */
  var WEB_ACCENT_ALLOWED = [
    'violet',
    'cyan',
    'teal',
    'rose',
    'amber',
    'mono',
    'coral',
    'indigo',
    'green',
    'red',
  ];
  var WEB_BG_ALLOWED = [
    'default',
    'ink',
    'warm',
    'cool',
    'amoled',
    'glass',
    'aurora',
    'paper',
    'mist',
    'forest',
    'clay',
  ];
  /**
   * 材质纹理（第三维）。⚠️ 与主进程 `UI_TEXTURE_ALLOWED`、渲染层 `UI_TEXTURE_ALLOWED`、
   * `renderer/index.html` 首帧 TEX 表**逐位一致**（`theme-regression` 断言）。
   * `none` 在网页端是「把 `--bg-texture` 设回 none」，不需要移除属性（网页端本来就不设
   * data-texture 属性 —— 两端约定不同：桌面端靠 html 属性选中 CSS 块，网页端靠直接写变量）。
   */
  var WEB_TEXTURE_ALLOWED = [
    'none',
    'grain',
    'paper',
    'linen',
    'frost',
    'grid',
    'dots',
    'stripe',
    'wood',
  ];
  /**
   * 面板透明度（第五维）。⚠️ 与主进程 `UI_OPACITY_ALLOWED`、渲染层 `UI_OPACITY_ALLOWED`、
   * `renderer/index.html` 首帧 OPA 表**逐位一致**（`theme-regression` 断言）。
   *
   * ⚠️ 与 `uiTexture` 的机制差别值得注意：纹理要把**图案字符串**写进变量（所以有
   * `TEXTURE_TOKENS`，还要跟 styles.css 比字符串等价）；透明度只是「一个档名 → 一个 html
   * 属性」，规则本体在**两端共用**的 `gallery-design.css`（`html[data-opacity='x']{--ui-alpha}`）
   * → 这里**不需要** token 表，也就没有「两端数值漂移」这类风险。
   * `opaque` 档在两端同协议：**移除属性**（CSS 侧一律带 `html[data-opacity]` 闸门）。
   */
  var WEB_OPACITY_ALLOWED = ['opaque', 'slight', 'medium', 'clear'];

  /** 明暗 × 背景基调 → 背景九件套 + 文字三件套（同 styles.css 的 [data-bg] 档） */
  var BG_TOKENS = {
    'dark:default': {
      bg: '#0a0a18',
      bgSidebar: '#0c0c22',
      bgCard: '#13132e',
      bgHover: '#1c1c40',
      bgActive: '#2a2a58',
      border: '#1a1a3c',
      glass: 'rgba(16, 16, 40, 0.66)',
      glassBorder: 'rgba(123, 140, 255, 0.16)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:default': {
      bg: '#f0f2fa',
      bgSidebar: '#e6e9f4',
      bgCard: '#ffffff',
      bgHover: '#e0e4f2',
      bgActive: '#d0d6ea',
      border: '#d8deef',
      glass: 'rgba(255, 255, 255, 0.9)',
      glassBorder: 'rgba(85, 104, 255, 0.16)',
      text: '#1a1d2e',
      textSecondary: '#4a5070',
      textMuted: '#7a8199',
    },
    'dark:ink': {
      bg: '#010103',
      bgSidebar: '#060914',
      bgCard: '#0e1324',
      bgHover: '#181f36',
      bgActive: '#263252',
      border: '#27345a',
      glass: 'rgba(8, 10, 20, 0.9)',
      glassBorder: 'rgba(122, 142, 238, 0.34)',
      text: '#f4f7ff',
      textSecondary: '#c6d0f5',
      textMuted: '#93a2d2',
    },
    'light:ink': {
      bg: '#cde0fd',
      bgSidebar: '#b8d3fb',
      bgCard: '#eef4ff',
      bgHover: '#a3c6f8',
      bgActive: '#8fb8f2',
      border: '#a9c9f0',
      glass: 'rgba(242, 248, 255, 0.95)',
      glassBorder: 'rgba(59, 108, 184, 0.26)',
      text: '#0f1f35',
      textSecondary: '#334a66',
      textMuted: '#667d9b',
    },
    'dark:warm': {
      bg: '#120d09',
      bgSidebar: '#1d1510',
      bgCard: '#271c15',
      bgHover: '#34271d',
      bgActive: '#4a382b',
      border: '#403126',
      glass: 'rgba(28, 20, 14, 0.84)',
      glassBorder: 'rgba(220, 139, 76, 0.2)',
      text: '#f6e8d2',
      textSecondary: '#d5bd93',
      textMuted: '#9e8360',
    },
    'light:warm': {
      bg: '#fbf1e2',
      bgSidebar: '#f2e2cb',
      bgCard: '#fff8ee',
      bgHover: '#ecd9be',
      bgActive: '#e0c9a9',
      border: '#ddc7a8',
      glass: 'rgba(255, 248, 237, 0.94)',
      glassBorder: 'rgba(191, 124, 59, 0.22)',
      text: '#3b2a18',
      textSecondary: '#6b5236',
      textMuted: '#9c8158',
    },
    'dark:cool': {
      bg: '#040b12',
      bgSidebar: '#081724',
      bgCard: '#0d2233',
      bgHover: '#153047',
      bgActive: '#1e415f',
      border: '#1a3850',
      glass: 'rgba(10, 24, 36, 0.84)',
      glassBorder: 'rgba(66, 156, 214, 0.22)',
      text: '#dceee6',
      textSecondary: '#a6c6bb',
      textMuted: '#77948b',
    },
    'light:cool': {
      bg: '#cdf0e5',
      bgSidebar: '#b8e4d7',
      bgCard: '#eefaf5',
      bgHover: '#a3dbcc',
      bgActive: '#8ecebd',
      border: '#a1d3c6',
      glass: 'rgba(240, 252, 247, 0.95)',
      glassBorder: 'rgba(45, 140, 122, 0.26)',
      text: '#0d3338',
      textSecondary: '#3a6e78',
      textMuted: '#6b939e',
    },
    'dark:amoled': {
      bg: '#000000',
      bgSidebar: '#050508',
      bgCard: '#0c0c0c',
      bgHover: '#161616',
      bgActive: '#242424',
      border: '#1f1f1f',
      glass: 'rgba(10, 10, 10, 0.9)',
      glassBorder: 'rgba(122, 122, 122, 0.22)',
      text: '#d8f4ff',
      textSecondary: '#8ecce8',
      textMuted: '#5592aa',
    },
    'light:amoled': {
      bg: '#eef1f6',
      bgSidebar: '#e4e8f0',
      bgCard: '#f8fafc',
      bgHover: '#d8dee9',
      bgActive: '#c8d0de',
      border: '#cfd6e2',
      glass: 'rgba(248, 250, 252, 0.96)',
      glassBorder: 'rgba(121, 134, 155, 0.2)',
      text: '#1a1d2e',
      textSecondary: '#4a5070',
      textMuted: '#7a8199',
    },
    /* 材质档：面板半透明，透出页面里那层 .aurora-bg —— 值必须与 styles.css 的
       html[data-theme][data-bg='glass'|'aurora'] 逐字符相同（theme-regression 比对）。 */
    'dark:glass': {
      bg: '#0b1626',
      bgSidebar: '#0f1d33',
      bgCard: 'rgba(22, 34, 58, 0.55)',
      bgHover: 'rgba(36, 52, 84, 0.62)',
      bgActive: 'rgba(54, 76, 118, 0.7)',
      border: 'rgba(140, 172, 232, 0.24)',
      glass: 'rgba(12, 22, 40, 0.5)',
      glassBorder: 'rgba(150, 180, 240, 0.3)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:glass': {
      bg: '#b9cfdf',
      bgSidebar: '#c9dbe9',
      bgCard: 'rgba(255, 255, 255, 0.6)',
      bgHover: 'rgba(226, 238, 248, 0.68)',
      bgActive: 'rgba(202, 220, 238, 0.76)',
      border: 'rgba(110, 145, 180, 0.3)',
      glass: 'rgba(250, 254, 255, 0.55)',
      glassBorder: 'rgba(80, 115, 155, 0.24)',
      text: '#0d1a28',
      textSecondary: '#33475c',
      textMuted: '#63798f',
    },
    'dark:aurora': {
      bg: '#1a0a1e',
      bgSidebar: '#230d2a',
      bgCard: 'rgba(48, 22, 58, 0.5)',
      bgHover: 'rgba(70, 34, 84, 0.58)',
      bgActive: 'rgba(98, 48, 116, 0.66)',
      border: 'rgba(206, 150, 255, 0.26)',
      glass: 'rgba(30, 12, 38, 0.44)',
      glassBorder: 'rgba(214, 160, 255, 0.32)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:aurora': {
      bg: '#c6d8d2',
      bgSidebar: '#d3e2dd',
      bgCard: 'rgba(252, 255, 254, 0.58)',
      bgHover: 'rgba(226, 240, 236, 0.66)',
      bgActive: 'rgba(202, 224, 217, 0.74)',
      border: 'rgba(110, 155, 142, 0.3)',
      glass: 'rgba(250, 255, 253, 0.54)',
      glassBorder: 'rgba(85, 135, 120, 0.24)',
      text: '#10201c',
      textSecondary: '#33504a',
      textMuted: '#627d76',
    },
    /* 后补四档（paper / mist / forest / clay）：**不透明实色档**，不是材质档 ——
       不走「面板半透明透出极光」那套，--glass 只是常规的接近不透明值。
       值必须与 styles.css 逐字符相同（theme-regression §7 会比对 bg / bg-secondary / bg-card）。
       ⚠️ 网页端 BG_TOKENS 是完整 token 集（不像 CSS 有 :root 继承），dark 档也必须显式写
       text 三件套，漏了会拿到 undefined → 文字变透明。 */
    'dark:paper': {
      bg: '#1e1c18',
      bgSidebar: '#272420',
      bgCard: '#2e2b26',
      bgHover: '#3a3631',
      bgActive: '#4d4842',
      border: '#453f38',
      glass: 'rgba(38, 35, 30, 0.86)',
      glassBorder: 'rgba(214, 196, 160, 0.22)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:paper': {
      bg: '#e9e6e0',
      bgSidebar: '#dedad3',
      bgCard: '#f7f5f1',
      bgHover: '#d3cec6',
      bgActive: '#c4beb4',
      border: '#cdc7bd',
      glass: 'rgba(250, 249, 246, 0.94)',
      glassBorder: 'rgba(120, 110, 90, 0.22)',
      text: '#26231e',
      textSecondary: '#524c42',
      textMuted: '#7d7669',
    },
    'dark:mist': {
      bg: '#0e1a1e',
      bgSidebar: '#13232a',
      bgCard: '#182c33',
      bgHover: '#1f3941',
      bgActive: '#2a4b55',
      border: '#22434c',
      glass: 'rgba(14, 30, 36, 0.84)',
      glassBorder: 'rgba(126, 190, 210, 0.22)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:mist': {
      bg: '#d5e2e6',
      bgSidebar: '#c7d8dd',
      bgCard: '#eaf2f4',
      bgHover: '#b9ced4',
      bgActive: '#a9c2c9',
      border: '#b3c9cf',
      glass: 'rgba(241, 248, 250, 0.94)',
      glassBorder: 'rgba(70, 120, 140, 0.24)',
      text: '#12232a',
      textSecondary: '#3b525c',
      textMuted: '#68808a',
    },
    'dark:forest': {
      bg: '#0a1a12',
      bgSidebar: '#0f2318',
      bgCard: '#142c1f',
      bgHover: '#1b3a29',
      bgActive: '#264d38',
      border: '#1f4531',
      glass: 'rgba(10, 26, 18, 0.84)',
      glassBorder: 'rgba(120, 200, 160, 0.22)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:forest': {
      bg: '#dde8dc',
      bgSidebar: '#cfded0',
      bgCard: '#eef6ed',
      bgHover: '#c0d5c2',
      bgActive: '#b0c9b3',
      border: '#bad0bd',
      glass: 'rgba(243, 250, 243, 0.94)',
      glassBorder: 'rgba(80, 130, 95, 0.24)',
      text: '#12261a',
      textSecondary: '#3a5746',
      textMuted: '#688574',
    },
    'dark:clay': {
      bg: '#251713',
      bgSidebar: '#2f1e19',
      bgCard: '#3a2620',
      bgHover: '#4a312a',
      bgActive: '#614137',
      border: '#573c33',
      glass: 'rgba(37, 23, 19, 0.86)',
      glassBorder: 'rgba(210, 150, 120, 0.24)',
      text: '#eaeaff',
      textSecondary: '#b0b0d0',
      textMuted: '#5c5c88',
    },
    'light:clay': {
      bg: '#e2d2c8',
      bgSidebar: '#d5c3b8',
      bgCard: '#f2e7e0',
      bgHover: '#c8b3a7',
      bgActive: '#b9a294',
      border: '#c4b0a4',
      glass: 'rgba(249, 243, 239, 0.94)',
      glassBorder: 'rgba(150, 100, 75, 0.24)',
      text: '#2c1d17',
      textSecondary: '#5a463c',
      textMuted: '#87756b',
    },
  };

  /** 明暗 × 强调色 → 强调色五件套（同 styles.css 的 accent 块） */
  var ACCENT_TOKENS = {
    'dark:violet': {
      accent: '#7b8cff',
      accentHover: '#9aa8ff',
      accentDim: 'rgba(123, 140, 255, 0.1)',
      accentGlow: 'rgba(123, 140, 255, 0.4)',
      glassBorder: 'rgba(123, 140, 255, 0.16)',
    },
    'light:violet': {
      accent: '#5568ff',
      accentHover: '#6b7cff',
      accentDim: 'rgba(85, 104, 255, 0.12)',
      accentGlow: 'rgba(85, 104, 255, 0.35)',
      glassBorder: 'rgba(85, 104, 255, 0.16)',
    },
    'dark:cyan': {
      accent: '#22d3ee',
      accentHover: '#67e8f9',
      accentDim: 'rgba(34, 211, 238, 0.2)',
      accentGlow: 'rgba(34, 211, 238, 0.56)',
      glassBorder: 'rgba(34, 211, 238, 0.24)',
    },
    'light:cyan': {
      accent: '#0284c7',
      accentHover: '#0369a1',
      accentDim: 'rgba(2, 132, 199, 0.18)',
      accentGlow: 'rgba(2, 132, 199, 0.42)',
      glassBorder: 'rgba(2, 132, 199, 0.26)',
    },
    'dark:teal': {
      accent: '#34d399',
      accentHover: '#6ee7b7',
      accentDim: 'rgba(52, 211, 153, 0.2)',
      accentGlow: 'rgba(52, 211, 153, 0.5)',
      glassBorder: 'rgba(52, 211, 153, 0.24)',
    },
    'light:teal': {
      accent: '#0f766e',
      accentHover: '#115e59',
      accentDim: 'rgba(15, 118, 110, 0.18)',
      accentGlow: 'rgba(15, 118, 110, 0.4)',
      glassBorder: 'rgba(15, 118, 110, 0.26)',
    },
    'dark:rose': {
      accent: '#fb7185',
      accentHover: '#fda4af',
      accentDim: 'rgba(251, 113, 133, 0.2)',
      accentGlow: 'rgba(251, 113, 133, 0.52)',
      glassBorder: 'rgba(251, 113, 133, 0.24)',
    },
    'light:rose': {
      accent: '#be185d',
      accentHover: '#9d174d',
      accentDim: 'rgba(190, 24, 93, 0.18)',
      accentGlow: 'rgba(190, 24, 93, 0.42)',
      glassBorder: 'rgba(190, 24, 93, 0.26)',
    },
    'dark:amber': {
      accent: '#facc15',
      accentHover: '#fde047',
      accentDim: 'rgba(250, 204, 21, 0.22)',
      accentGlow: 'rgba(250, 204, 21, 0.56)',
      glassBorder: 'rgba(250, 204, 21, 0.28)',
    },
    'light:amber': {
      accent: '#ca8a04',
      accentHover: '#a16207',
      accentDim: 'rgba(202, 138, 4, 0.2)',
      accentGlow: 'rgba(202, 138, 4, 0.44)',
      glassBorder: 'rgba(202, 138, 4, 0.28)',
    },
    'dark:mono': {
      accent: '#a1a1aa',
      accentHover: '#d4d4d8',
      accentDim: 'rgba(161, 161, 170, 0.16)',
      accentGlow: 'rgba(161, 161, 170, 0.34)',
      glassBorder: 'rgba(161, 161, 170, 0.22)',
    },
    'light:mono': {
      accent: '#52525b',
      accentHover: '#3f3f46',
      accentDim: 'rgba(82, 82, 91, 0.16)',
      accentGlow: 'rgba(82, 82, 91, 0.34)',
      glassBorder: 'rgba(82, 82, 91, 0.24)',
    },
    /* 后补四色（coral / indigo / green / red）：值必须与 styles.css 的
       html[data-theme][data-accent=...] 逐字符相同。 */
    'dark:coral': {
      accent: '#ff8a5c',
      accentHover: '#ffab8a',
      accentDim: 'rgba(255, 138, 92, 0.2)',
      accentGlow: 'rgba(255, 138, 92, 0.52)',
      glassBorder: 'rgba(255, 138, 92, 0.24)',
    },
    'light:coral': {
      accent: '#ea580c',
      accentHover: '#c2410c',
      accentDim: 'rgba(234, 88, 12, 0.18)',
      accentGlow: 'rgba(234, 88, 12, 0.42)',
      glassBorder: 'rgba(234, 88, 12, 0.26)',
    },
    'dark:indigo': {
      accent: '#7c6bff',
      accentHover: '#9d8fff',
      accentDim: 'rgba(124, 107, 255, 0.2)',
      accentGlow: 'rgba(124, 107, 255, 0.52)',
      glassBorder: 'rgba(124, 107, 255, 0.26)',
    },
    'light:indigo': {
      accent: '#4338ca',
      accentHover: '#3730a3',
      accentDim: 'rgba(67, 56, 202, 0.18)',
      accentGlow: 'rgba(67, 56, 202, 0.42)',
      glassBorder: 'rgba(67, 56, 202, 0.26)',
    },
    'dark:green': {
      accent: '#3ecf5f',
      accentHover: '#6ee08a',
      accentDim: 'rgba(62, 207, 95, 0.2)',
      accentGlow: 'rgba(62, 207, 95, 0.5)',
      glassBorder: 'rgba(62, 207, 95, 0.24)',
    },
    'light:green': {
      accent: '#15803d',
      accentHover: '#166534',
      accentDim: 'rgba(21, 128, 61, 0.18)',
      accentGlow: 'rgba(21, 128, 61, 0.4)',
      glassBorder: 'rgba(21, 128, 61, 0.26)',
    },
    'dark:red': {
      accent: '#ff5252',
      accentHover: '#ff8080',
      accentDim: 'rgba(255, 82, 82, 0.2)',
      accentGlow: 'rgba(255, 82, 82, 0.52)',
      glassBorder: 'rgba(255, 82, 82, 0.24)',
    },
    'light:red': {
      accent: '#b91c1c',
      accentHover: '#991b1b',
      accentDim: 'rgba(185, 28, 28, 0.18)',
      accentGlow: 'rgba(185, 28, 28, 0.42)',
      glassBorder: 'rgba(185, 28, 28, 0.26)',
    },
  };

  /**
   * 材质纹理 → `--bg-texture` / `--texture-size`。
   *
   * ⚠️ `image` 必须与 `src/renderer/styles.css` 的 `html[data-texture='x']` 块**等价**
   * （`theme-regression` 断言：去掉空白后逐字符相同）。两端实现方式不同是刻意的：
   *   桌面端 = html 属性选中 CSS 块；网页端**不设 data-texture 属性**（与 data-accent /
   *   data-bg 同理），直接把变量写进 root.style。
   *
   * ⚠️ `currentColor` 在两端的解析基准都是 `body`（桌面端 body 有 `color: var(--text-primary)`；
   *   网页端内联样式里有 `body { color: var(--text) }`），所以同一份字符串在两端都能自动跟主题。
   *   只有 `none` 是纯占位（写入 `none` 即关闭）。
   */
  var TEXTURE_TOKENS = {
    none: { image: 'none', size: 'auto' },
    grain: {
      image:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.214 0 0 0 0 0.214 0 0 0 0 0.214 0.11 0.11 0.11 0 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23g)'/%3E%3C/svg%3E\")",
      size: 'auto',
    },
    paper: {
      image:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='p'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.34 0.72' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.214 0 0 0 0 0.214 0 0 0 0 0.214 0.085 0.085 0.085 0 0'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23p)'/%3E%3C/svg%3E\")",
      size: 'auto',
    },
    linen: {
      image:
        'repeating-linear-gradient(45deg, color-mix(in srgb, currentColor 2.2%, transparent) 0 1px, transparent 1px 6px), repeating-linear-gradient(-45deg, color-mix(in srgb, currentColor 2.2%, transparent) 0 1px, transparent 1px 6px)',
      size: 'auto',
    },
    frost: {
      image:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='f'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.03' numOctaves='3' stitchTiles='stitch'/%3E%3CfeGaussianBlur stdDeviation='3'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.214 0 0 0 0 0.214 0 0 0 0 0.214 0.075 0.075 0.075 0 0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23f)'/%3E%3C/svg%3E\")",
      size: 'auto',
    },
    grid: {
      image:
        'repeating-linear-gradient(0deg, color-mix(in srgb, currentColor 5.5%, transparent) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, color-mix(in srgb, currentColor 5.5%, transparent) 0 1px, transparent 1px 24px)',
      size: 'auto',
    },
    dots: {
      image:
        'radial-gradient(circle, color-mix(in srgb, currentColor 8.5%, transparent) 0 1px, transparent 1.4px)',
      size: '15px 15px',
    },
    stripe: {
      image:
        'repeating-linear-gradient(90deg, color-mix(in srgb, currentColor 5.5%, transparent) 0 1px, transparent 1px 11px)',
      size: 'auto',
    },
    wood: {
      image:
        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='260' height='260'%3E%3Cfilter id='w'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.01 0.22' numOctaves='4' seed='9' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.323 0 0 0 0 0.216 0 0 0 0 0.147 0.075 0.075 0.075 0 0'/%3E%3C/filter%3E%3Crect width='260' height='260' filter='url(%23w)'/%3E%3C/svg%3E\")",
      size: 'auto',
    },
  };

  /**
   * 三元组的细化覆盖（键 = theme:bg:accent），同 styles.css 的「主题组合」块。
   * 用处：同一背景档被多个预设共用时（浅色 warm / 深色 default），按强调色把它们拆开 —— 否则
   * 樱雾粉昼与暮紫微光、夜幕经典与石墨夜色会拿到逐字节相同的背景。
   */
  var APPEARANCE_OVERRIDES = {
    'light:warm:rose': {
      bg: '#fff0f6',
      bgSidebar: '#fbdae9',
      bgCard: '#fffbfd',
      bgHover: '#f6cce0',
      bgActive: '#efb9d1',
      border: '#f0c0d5',
      glass: 'rgba(255, 247, 251, 0.94)',
      glassBorder: 'rgba(190, 24, 93, 0.22)',
    },
    'light:warm:violet': {
      bg: '#e9ddfa',
      bgSidebar: '#d5c1f2',
      bgCard: '#f6f1ff',
      bgHover: '#bfa8e8',
      bgActive: '#ad93de',
      border: '#c2ade6',
      glass: 'rgba(249, 244, 255, 0.94)',
      glassBorder: 'rgba(124, 58, 237, 0.22)',
    },
    'dark:default:mono': {
      bg: '#14141a',
      bgSidebar: '#1a1a21',
      bgCard: '#21212a',
      bgHover: '#2b2b35',
      bgActive: '#383843',
      border: '#30303b',
      glass: 'rgba(24, 24, 30, 0.72)',
      glassBorder: 'rgba(161, 161, 170, 0.22)',
    },
    'dark:ink:rose': {
      bg: '#1a040b',
      bgSidebar: '#240610',
      bgCard: '#2e0a16',
      bgHover: '#3d0e1e',
      bgActive: '#52152a',
      border: '#431126',
      glass: 'rgba(26, 6, 12, 0.86)',
      glassBorder: 'rgba(251, 113, 133, 0.24)',
    },
    'light:default:amber': {
      bg: '#fdf3e3',
      bgSidebar: '#f5e6cb',
      bgCard: '#fffaf0',
      bgHover: '#eedcbe',
      bgActive: '#e2cda8',
      border: '#ddc9a4',
      glass: 'rgba(255, 251, 244, 0.94)',
      glassBorder: 'rgba(202, 138, 4, 0.24)',
    },
    'light:amoled:mono': {
      bg: '#dfe3e9',
      bgSidebar: '#d3d8e0',
      bgCard: '#f4f6f9',
      bgHover: '#c5cbd6',
      bgActive: '#b5bdcc',
      border: '#c1c9d5',
      glass: 'rgba(247, 249, 251, 0.95)',
      glassBorder: 'rgba(82, 82, 91, 0.24)',
    },
    // 第二批 6 套：各自占用一个「未被占用的 (theme, accent, bg) 组合」，
    // 所以必须带一份覆盖 —— 否则会拿到同名基础档、与已有预设背景逐字节相同。
    // ⚠️ 逐值同步 src/renderer/styles.css 的「第二批 6 套」区块。
    'dark:ink:violet': {
      bg: '#170a26',
      bgSidebar: '#200f33',
      bgCard: '#2a1442',
      bgHover: '#381c55',
      bgActive: '#4a2770',
      border: '#3d2160',
      glass: 'rgba(23, 10, 38, 0.86)',
      glassBorder: 'rgba(167, 139, 250, 0.26)',
    },
    'dark:default:teal': {
      bg: '#07170f',
      bgSidebar: '#0c2016',
      bgCard: '#12301f',
      bgHover: '#1a4129',
      bgActive: '#245437',
      border: '#1e442c',
      glass: 'rgba(8, 24, 16, 0.86)',
      glassBorder: 'rgba(45, 212, 191, 0.24)',
    },
    'dark:ink:amber': {
      bg: '#241408',
      bgSidebar: '#311c0d',
      bgCard: '#3d2412',
      bgHover: '#4e3018',
      bgActive: '#644020',
      border: '#55381d',
      glass: 'rgba(36, 20, 8, 0.86)',
      glassBorder: 'rgba(217, 119, 6, 0.26)',
    },
    'light:default:teal': {
      bg: '#e6f2d3',
      bgSidebar: '#d6e9bd',
      bgCard: '#f6fbec',
      bgHover: '#c6dfa8',
      bgActive: '#b5d394',
      border: '#c2dba4',
      glass: 'rgba(246, 251, 236, 0.95)',
      glassBorder: 'rgba(45, 140, 122, 0.24)',
    },
    'light:ink:amber': {
      bg: '#fcdcc0',
      bgSidebar: '#f8cba6',
      bgCard: '#fff4ea',
      bgHover: '#f5bd91',
      bgActive: '#eeae7c',
      border: '#f0bd97',
      glass: 'rgba(255, 246, 238, 0.95)',
      glassBorder: 'rgba(202, 138, 4, 0.26)',
    },
    'light:cool:cyan': {
      bg: '#cbeef7',
      bgSidebar: '#b0e3f1',
      bgCard: '#eefaff',
      bgHover: '#97d9ea',
      bgActive: '#7fcee1',
      border: '#9dd6e6',
      glass: 'rgba(240, 252, 255, 0.95)',
      glassBorder: 'rgba(14, 116, 144, 0.26)',
    },
  };

  function normalizeWebThemeStyle(id) {
    return Object.prototype.hasOwnProperty.call(WEB_THEME_PRESETS, id) ? id : 'midnight_classic';
  }

  /** 预设 id → 三元组；未知 id 返回 null */
  function resolveWebThemeTriple(id) {
    var p = WEB_THEME_PRESETS[id];
    return p
      ? { theme: p.theme, uiAccent: p.uiAccent, uiBackground: p.uiBackground }
      : null;
  }

  /** 三元组 → 预设 id；凑不出返回空串（自定义组合），与桌面端同语义 */
  function inferWebThemeStyle(theme, accent, bg) {
    var t = theme === 'light' ? 'light' : 'dark';
    var ids = Object.keys(WEB_THEME_PRESETS);
    for (var i = 0; i < ids.length; i++) {
      var p = WEB_THEME_PRESETS[ids[i]];
      if (p.theme === t && p.uiAccent === accent && p.uiBackground === bg) return ids[i];
    }
    return '';
  }

  function normalizeWebAccent(a) {
    return WEB_ACCENT_ALLOWED.indexOf(a) >= 0 ? a : 'violet';
  }

  function normalizeWebBackground(b) {
    return WEB_BG_ALLOWED.indexOf(b) >= 0 ? b : 'default';
  }

  function normalizeWebTexture(t) {
    return WEB_TEXTURE_ALLOWED.indexOf(t) >= 0 ? t : 'none';
  }

  function normalizeWebOpacity(o) {
    return WEB_OPACITY_ALLOWED.indexOf(o) >= 0 ? o : 'opaque';
  }

  /** 合并三层：背景档 → 强调色 → 三元组覆盖 */
  function webThemeTokens(theme, accent, bg) {
    var base = BG_TOKENS[theme + ':' + bg] || BG_TOKENS['dark:default'];
    var acc = ACCENT_TOKENS[theme + ':' + accent] || ACCENT_TOKENS['dark:violet'];
    var ov = APPEARANCE_OVERRIDES[theme + ':' + bg + ':' + accent] || {};
    return Object.assign({}, base, acc, ov);
  }

  function hexLuminance(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length !== 6) return 0.12;
    var r = parseInt(h.slice(0, 2), 16) / 255;
    var g = parseInt(h.slice(2, 4), 16) / 255;
    var b = parseInt(h.slice(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * 把外观写进 CSS 变量。
   * @param {Element} root 一般是 document.documentElement
   * @param {string} id 预设 id（'' 或未知 → 用 override / 默认三元组）
   * @param {string} [accentOverride] 强调色（自定义组合时用）
   * @param {string} [bgOverride] 背景基调（自定义组合时用）
   * @param {string} [textureOverride] 材质纹理（第三维，与预设无关，独立于三元组）
   * @param {string} [opacityOverride] 面板透明度（第五维，与预设无关，独立于三元组）
   */
  function applyWebThemeVariables(root, id, accentOverride, bgOverride, textureOverride, opacityOverride) {
    // ⚠️ 不要先 normalize：空串是「自定义组合」的合法值，normalize 会把它拍成默认预设
    var triple = resolveWebThemeTriple(id);
    var theme = triple ? triple.theme : null;
    if (!theme) {
      // 自定义组合没有预设可依据 → 沿用当前生效的明暗，避免改强调色时把浅色扳成深色
      theme = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }
    var accent = normalizeWebAccent(accentOverride || (triple && triple.uiAccent));
    var bg = normalizeWebBackground(bgOverride || (triple && triple.uiBackground));
    var texture = normalizeWebTexture(textureOverride);
    var opacity = normalizeWebOpacity(opacityOverride);
    var t = webThemeTokens(theme, accent, bg);
    var tex = TEXTURE_TOKENS[texture] || TEXTURE_TOKENS.none;
    root.setAttribute('data-theme', theme);
    // 透明度：只负责属性这一件事（规则本体在两端共用的 gallery-design.css）。
    // `opaque` 档移除属性 —— 与桌面端同协议，也是「默认外观零变化」的判据。
    if (opacity === 'opaque') root.removeAttribute('data-opacity');
    else root.setAttribute('data-opacity', opacity);
    root.style.setProperty('--bg-primary', t.bg);
    root.style.setProperty('--bg-secondary', t.bgSidebar);
    root.style.setProperty('--text-primary', t.text);
    root.style.setProperty('--bg', t.bg);
    root.style.setProperty('--bg-sidebar', t.bgSidebar);
    root.style.setProperty('--bg-card', t.bgCard);
    root.style.setProperty('--bg-hover', t.bgHover);
    root.style.setProperty('--bg-active', t.bgActive);
    root.style.setProperty('--text', t.text);
    root.style.setProperty('--text-secondary', t.textSecondary);
    root.style.setProperty('--text-muted', t.textMuted);
    root.style.setProperty('--accent', t.accent);
    root.style.setProperty('--accent-hover', t.accentHover);
    root.style.setProperty('--accent-dim', t.accentDim);
    root.style.setProperty('--accent-glow', t.accentGlow);
    root.style.setProperty('--border', t.border);
    root.style.setProperty('--glass', t.glass);
    root.style.setProperty('--glass-border', t.glassBorder);
    root.style.setProperty('--bg-texture', tex.image);
    root.style.setProperty('--texture-size', tex.size);
    return {
      theme: theme,
      uiAccent: accent,
      uiBackground: bg,
      uiTexture: texture,
      uiOpacity: opacity,
      themeStyle: inferWebThemeStyle(theme, accent, bg),
    };
  }

  /**
   * 登录页：与相册页共用 localStorage「webThemeStyle」，并设置登录专用变量与 meta theme-color
   */
  function applyWebLoginPageTheme(id) {
    var triple = resolveWebThemeTriple(normalizeWebThemeStyle(id)) || WEB_THEME_PRESETS.midnight_classic;
    var applied = applyWebThemeVariables(document.documentElement, id);
    var root = document.documentElement;
    var t = webThemeTokens(applied.theme, applied.uiAccent, applied.uiBackground);
    root.style.setProperty('--accent-2', t.accentHover);
    var light = triple.theme === 'light' || hexLuminance(t.bg) > 0.55;
    root.style.setProperty('--danger', light ? '#dc2626' : '#fb7185');
    root.style.colorScheme = light ? 'light' : 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
  }

  global.WebTheme = {
    WEB_THEME_PRESETS: WEB_THEME_PRESETS,
    WEB_ACCENT_ALLOWED: WEB_ACCENT_ALLOWED,
    WEB_BG_ALLOWED: WEB_BG_ALLOWED,
    WEB_TEXTURE_ALLOWED: WEB_TEXTURE_ALLOWED,
    WEB_OPACITY_ALLOWED: WEB_OPACITY_ALLOWED,
    BG_TOKENS: BG_TOKENS,
    ACCENT_TOKENS: ACCENT_TOKENS,
    TEXTURE_TOKENS: TEXTURE_TOKENS,
    APPEARANCE_OVERRIDES: APPEARANCE_OVERRIDES,
    normalizeWebThemeStyle: normalizeWebThemeStyle,
    resolveWebThemeTriple: resolveWebThemeTriple,
    inferWebThemeStyle: inferWebThemeStyle,
    normalizeWebAccent: normalizeWebAccent,
    normalizeWebBackground: normalizeWebBackground,
    normalizeWebTexture: normalizeWebTexture,
    normalizeWebOpacity: normalizeWebOpacity,
    webThemeTokens: webThemeTokens,
    applyWebThemeVariables: applyWebThemeVariables,
    applyWebLoginPageTheme: applyWebLoginPageTheme,
  };
})(typeof window !== 'undefined' ? window : this);
