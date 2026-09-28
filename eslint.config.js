import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'shapes/', 'src/server/public/styles.css'],
  },

  js.configs.recommended,

  // Server-side code: Node ESM.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },

  // Browser scripts served from /static: classic scripts, not modules.
  {
    files: ['src/server/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },

  // Tests: describe blocks are long by nature, and vitest globals are enabled.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.vitest },
    },
    rules: {
      'max-lines-per-function': 'off',
    },
  },
];
