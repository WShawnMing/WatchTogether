/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#f5f6f8',
          secondary: '#edeef1',
          card: '#ffffff'
        },
        fg: {
          DEFAULT: '#1d1d1f',
          secondary: '#86868b',
          tertiary: '#aeaeb2'
        },
        accent: {
          DEFAULT: '#0071e3',
          hover: '#0077ed',
          light: '#e8f0fe',
          subtle: '#f0f5ff'
        },
        ok: {
          DEFAULT: '#34c759',
          light: '#eefbf1'
        },
        warn: {
          DEFAULT: '#ff9f0a',
          light: '#fff7ed'
        },
        err: {
          DEFAULT: '#ff3b30',
          light: '#fff1f0'
        }
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '20px'
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.08)',
        soft: '0 2px 8px rgba(0,0,0,0.05)'
      },
      fontSize: {
        '2xs': '0.6875rem'
      }
    }
  },
  plugins: []
}
