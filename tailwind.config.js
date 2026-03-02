/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#1a1a2e',
          light: '#222244',
          lighter: '#2a2a4a'
        },
        accent: {
          DEFAULT: '#6c63ff',
          hover: '#7b73ff',
          dim: '#4a44b3'
        }
      }
    }
  },
  plugins: []
}
