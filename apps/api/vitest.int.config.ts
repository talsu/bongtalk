import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.spec.ts'],
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
