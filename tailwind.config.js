/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./views/**/*.ejs", "./public/**/*.js"],
  theme: {
    extend: {
      colors: {
        manus: {
          bg: '#FBFBFB',
          text: '#1D1D1F',
          accent: '#0066CC'
        }
      }
    },
  },
  plugins: [],
}
