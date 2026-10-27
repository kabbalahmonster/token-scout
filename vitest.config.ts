import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
    testTimeout: 15_000
  }
});
