import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    exclude: ['**/*.int.spec.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    testTimeout: 10000,
  },
});
