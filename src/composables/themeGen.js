// ============================================================
//  Custom Theme Generator —— 由用户选的「主色」自动生成整套浅色主题
//  输入单个 hex，输出与内置主题同结构的 CSS 变量对象。
//  自定义主题一律为浅色底（白/浅底 + 深字），不提供深浅切换。
// ============================================================

// #rgb / #rrggbb / 可带 #；返回 { r, g, b }（0-255）或 null
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('')
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function rgbToHex({ r, g, b }) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

// 向白色混合 ratio（0-1）：ratio 越大越白
function mixWithWhite(hex, ratio) {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const m = (c) => c + (255 - c) * ratio
  return rgbToHex({ r: m(rgb.r), g: m(rgb.g), b: m(rgb.b) })
}

// 把 hex 转为 rgba(...) 字符串（透明度 a）
function hexToRgba(hex, a) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}

// 主色加深（×0.9）作为 hover 色
function darken(hex, factor = 0.9) {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return rgbToHex({ r: rgb.r * factor, g: rgb.g * factor, b: rgb.b * factor })
}

// 生成自定义浅色主题的全部 CSS 变量。
// 非法 hex 返回 null（调用方据此跳过，不写入、不崩溃）。
export function generateCustomTheme(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const accent = rgbToHex(rgb)
  return {
    '--bg-primary': '#f7f8fa',
    '--bg-secondary': '#ffffff',
    '--bg-tertiary': mixWithWhite(accent, 0.88),
    '--bg-surface': '#ffffff',
    '--bg-input': mixWithWhite(accent, 0.88),
    '--text-primary': '#1f2937',
    '--text-secondary': '#475569',
    '--text-muted': '#94a3b8',
    '--accent': accent,
    '--accent-hover': darken(accent, 0.9),
    '--accent-glow': hexToRgba(accent, 0.2),
    '--border': mixWithWhite(accent, 0.80),
    '--user-bubble': mixWithWhite(accent, 0.90),
    '--assistant-bubble': '#ffffff',
    '--danger': '#ef4444',
    '--success': '#22c55e',
    '--warning': '#f59e0b',
    '--shadow': '0 4px 24px rgba(0, 0, 0, 0.1)',
    '--radius': '12px',
    '--radius-sm': '8px',
    '--radius-xs': '4px',
  }
}

export { hexToRgb, hexToRgba }
