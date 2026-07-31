/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './apps/web/index.html',
    './apps/web/src/**/*.{ts,tsx}',
    './apps/desktop/src/renderer/**/*.{ts,tsx}',
    './packages/app-ui/src/**/*.{ts,tsx}',
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'monospace'],
      },
      colors: {
        ink: {
          950: '#071016',
          900: '#0b151c',
          850: '#101c24',
          800: '#14212a',
          700: '#26343e',
        },
        mint: {
          300: '#74f1bf',
          400: '#4adeaa',
          500: '#24c991',
        },
      },
      boxShadow: {
        panel: '0 12px 40px rgba(0, 0, 0, 0.22)',
      },
    },
  },
  plugins: [],
};
