/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Цвета берём из CSS-переменных — так переключение темы происходит без
        // перерисовки классов Tailwind, просто сменой data-theme на <html>.
        bg: {
          DEFAULT: 'rgb(var(--c-bg) / <alpha-value>)',
          panel: 'rgb(var(--c-surface) / <alpha-value>)',
          hover: 'rgb(var(--c-surface-2) / <alpha-value>)',
          elev: 'rgb(var(--c-surface-3) / <alpha-value>)',
        },
        surface: {
          DEFAULT: 'rgb(var(--c-surface) / <alpha-value>)',
          elev: 'rgb(var(--c-surface-2) / <alpha-value>)',
          high: 'rgb(var(--c-surface-3) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--c-border) / <alpha-value>)',
          strong: 'rgb(var(--c-border-strong) / <alpha-value>)',
        },
        text: {
          DEFAULT: 'rgb(var(--c-text) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
          dim: 'rgb(var(--c-text-dim) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
          fg: 'rgb(var(--c-accent-fg) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--c-danger) / <alpha-value>)',
          hover: 'rgb(var(--c-danger-hover) / <alpha-value>)',
        },
        success: { DEFAULT: 'rgb(var(--c-success) / <alpha-value>)' },
        warning: { DEFAULT: 'rgb(var(--c-warning) / <alpha-value>)' },
        info: { DEFAULT: 'rgb(var(--c-info) / <alpha-value>)' },
      },
      fontFamily: {
        sans: ['"Inter"', '"SF Pro Display"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Mono"', '"Courier New"', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.08)',
        pop: '0 4px 16px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.12)',
        elev: '0 8px 32px rgba(0,0,0,0.24)',
      },
      borderRadius: {
        xl2: '14px',
      },
      keyframes: {
        'msg-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'msg-in': 'msg-in 0.28s cubic-bezier(0.4,0,0.2,1)',
        'fade-in': 'fade-in 0.2s ease-out',
        float: 'float 3s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
