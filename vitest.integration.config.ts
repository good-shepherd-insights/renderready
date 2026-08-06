import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // A real Chromium launch plus page loads is far slower than the unit suite.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One browser at a time keeps the suite deterministic on CI runners.
    fileParallelism: false,
  },
});
