/* eslint-disable */
const forms = require('@tailwindcss/forms');
const typography = require('@tailwindcss/typography');
const flowbitePlugin = require('flowbite/plugin');

const staticSafelist = [
  // Progress bar color variants
  'bg-blue-600',
  'bg-green-600',
  'bg-purple-600',
  'bg-amber-600',
  'bg-sky-600',
  'bg-pink-600',
  'bg-indigo-600',
  'text-white',
  'text-blue-100',
  // Toast color variants
  'text-green-500', 'bg-green-100', 'dark:bg-gray-800', 'dark:text-green-400',
  'text-red-500', 'bg-red-100', 'dark:text-red-400',
  'text-blue-500', 'bg-blue-100', 'dark:text-blue-400',
  // Dedup button / banner variants
  'bg-amber-50', 'bg-amber-700', 'text-amber-800', 'text-amber-400',
  'focus:ring-amber-300', 'dark:bg-amber-500', 'dark:hover:bg-amber-600',
  'dark:focus:ring-amber-800', 'dark:text-amber-400',
];
const generatedSafelist = [];

module.exports = {
  darkMode: 'class',
  content: [
    './src/server/views/**/*.ejs',
    './src/server/public/**/*.js',
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
