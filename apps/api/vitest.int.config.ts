import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        target: 'es2022',
        transform: {
          decoratorMetadata: true,
          legacyDecorator: true,
        },
      },
    }),
  ],
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
