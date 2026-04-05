/**
 * Web 端主题预设（与 js/app.js 内历史逻辑一致；请与相册页保持同步）
 */
(function (global) {
  var WEB_THEME_PRESETS = {
    midnight_classic: {
      bg: '#0b0b1a',
      bgSidebar: '#101026',
      bgCard: '#171736',
      bgHover: '#23234a',
      bgActive: '#313164',
      text: '#f0f1ff',
      textSecondary: '#bcc0e6',
      textMuted: '#7074a1',
      accent: '#7b8cff',
      accentHover: '#9aa8ff',
      accentDim: 'rgba(123, 140, 255, 0.12)',
      accentGlow: 'rgba(123, 140, 255, 0.42)',
      border: '#23234a',
      glass: 'rgba(18, 18, 44, 0.76)',
      glassBorder: 'rgba(123, 140, 255, 0.16)',
    },
    ice_deep: {
      bg: '#000000',
      bgSidebar: '#05080d',
      bgCard: '#0d1622',
      bgHover: '#162336',
      bgActive: '#20314a',
      text: '#eaf6ff',
      textSecondary: '#b8d2e8',
      textMuted: '#6f8aa2',
      accent: '#22d3ee',
      accentHover: '#67e8f9',
      accentDim: 'rgba(34, 211, 238, 0.16)',
      accentGlow: 'rgba(34, 211, 238, 0.45)',
      border: '#1a2b3f',
      glass: 'rgba(10, 16, 24, 0.86)',
      glassBorder: 'rgba(34, 211, 238, 0.2)',
    },
    amber_dawn: {
      bg: '#0f0b05',
      bgSidebar: '#161006',
      bgCard: '#21170a',
      bgHover: '#2f220f',
      bgActive: '#443116',
      text: '#f6ecd9',
      textSecondary: '#d9c29a',
      textMuted: '#9a845f',
      accent: '#f0b429',
      accentHover: '#ffd060',
      accentDim: 'rgba(240, 180, 41, 0.14)',
      accentGlow: 'rgba(240, 180, 41, 0.38)',
      border: '#30210e',
      glass: 'rgba(20, 14, 7, 0.82)',
      glassBorder: 'rgba(240, 180, 41, 0.18)',
    },
    sky_light: {
      bg: '#eef3fb',
      bgSidebar: '#e3ebf8',
      bgCard: '#ffffff',
      bgHover: '#d4e0f3',
      bgActive: '#c2d2ea',
      text: '#0f1f35',
      textSecondary: '#334a66',
      textMuted: '#667d9b',
      accent: '#1d4ed8',
      accentHover: '#1e40af',
      accentDim: 'rgba(29, 78, 216, 0.2)',
      accentGlow: 'rgba(29, 78, 216, 0.44)',
      border: '#b9c9e0',
      glass: 'rgba(250, 252, 255, 0.92)',
      glassBorder: 'rgba(29, 78, 216, 0.26)',
    },
    cherry_blossom: {
      bg: '#fff3f8',
      bgSidebar: '#ffeaf3',
      bgCard: '#ffffff',
      bgHover: '#ffdce9',
      bgActive: '#f9cddd',
      text: '#3b1726',
      textSecondary: '#7a3f58',
      textMuted: '#a66f87',
      accent: '#be185d',
      accentHover: '#9d174d',
      accentDim: 'rgba(190, 24, 93, 0.2)',
      accentGlow: 'rgba(190, 24, 93, 0.42)',
      border: '#efc6d8',
      glass: 'rgba(255, 250, 253, 0.92)',
      glassBorder: 'rgba(190, 24, 93, 0.24)',
    },
    arctic_mint: {
      bg: '#edf6f7',
      bgSidebar: '#e1eff1',
      bgCard: '#ffffff',
      bgHover: '#d6e9ec',
      bgActive: '#c7dee2',
      text: '#14212b',
      textSecondary: '#3f5a64',
      textMuted: '#6f8791',
      accent: '#0d9488',
      accentHover: '#0f766e',
      accentDim: 'rgba(13, 148, 136, 0.13)',
      accentGlow: 'rgba(13, 148, 136, 0.3)',
      border: '#cadde1',
      glass: 'rgba(255, 255, 255, 0.9)',
      glassBorder: 'rgba(13, 148, 136, 0.18)',
    },
  };

  function normalizeWebThemeStyle(id) {
    return WEB_THEME_PRESETS[id] ? id : 'midnight_classic';
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

  function applyWebThemeVariables(root, id) {
    var themeId = normalizeWebThemeStyle(id);
    var t = WEB_THEME_PRESETS[themeId];
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
  }

  /**
   * 登录页：与相册页共用 localStorage「webThemeStyle」，并设置登录专用变量与 meta theme-color
   */
  function applyWebLoginPageTheme(id) {
    var themeId = normalizeWebThemeStyle(id);
    var t = WEB_THEME_PRESETS[themeId];
    var root = document.documentElement;
    applyWebThemeVariables(root, themeId);
    root.style.setProperty('--accent-2', t.accentHover);
    var light = hexLuminance(t.bg) > 0.55;
    root.style.setProperty('--danger', light ? '#dc2626' : '#fb7185');
    root.style.colorScheme = light ? 'light' : 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
  }

  global.WebTheme = {
    WEB_THEME_PRESETS: WEB_THEME_PRESETS,
    normalizeWebThemeStyle: normalizeWebThemeStyle,
    applyWebThemeVariables: applyWebThemeVariables,
    applyWebLoginPageTheme: applyWebLoginPageTheme,
  };
})(typeof window !== 'undefined' ? window : this);
