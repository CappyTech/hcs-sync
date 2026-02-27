import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 15_000,
    // Isolate each test file so module-level singletons don't interfere
    pool: 'forks',
  },
});
