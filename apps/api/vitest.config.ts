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
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    exclude: ['**/*.int.spec.ts', 'node_modules/**', 'dist/**'],
    environment: 'node',
    globals: false,
    testTimeout: 10000,
  },
});
