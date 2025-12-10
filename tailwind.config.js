/* eslint-disable */
const forms = require('@tailwindcss/forms');
const typography = require('@tailwindcss/typography');
const flowbitePlugin = require('@flowbite/plugin');

const staticSafelist = [];
const generatedSafelist = [];

module.exports = {
  darkMode: 'class',
  content: [
    './src/server/views/**/*.ejs',
    './src/server/public/js/**/*.js',
    './src/**/*.js',
    './node_modules/flowbite/**/*.js',
  ],
  safelist: Array.from(new Set([...(staticSafelist || []), ...(generatedSafelist || [])])),
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#047857',
          light: '#10b981',
          dark: '#065f46',
        },
      },
    },
  },
  plugins: [forms, typography, flowbitePlugin],
};
