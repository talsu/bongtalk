import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';

// Regex for raw Tailwind palette classes. The task-010 ESLint rule
// enforces design-token usage (surface, foreground, danger, …) in
// favour of hard-coded `bg-slate-900`, `text-red-600`, etc. Error-level
// on features/auth + features/workspaces (the sweep done in task-010-C);
// warn-level elsewhere so the rest of the codebase migrates incrementally
// without blocking CI.
const PALETTE_PATTERN =
  "Literal[value=/\\b(bg|text|border)-(slate|red|blue|green|yellow)-[0-9]+\\b/]";

const PALETTE_MESSAGE =
  'Use design-system semantic tokens (surface/foreground/text-muted/danger/accent/…) instead of raw Tailwind palette classes. See apps/web/src/index.css + tailwind.config.js for the token list.';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.debug/**',
      'apps/api/prisma/migrations/**',
      'apps/web/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'off',
    },
  },
  // TS / TSX files need the typescript-eslint parser so JSX + type
  // annotations don't trip espree. Not type-aware (no `project` option)
  // — we only need parsing, not semantic rules.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
  },
  // Warn-level: any frontend file with a raw palette class gets a nudge.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        { selector: PALETTE_PATTERN, message: PALETTE_MESSAGE },
      ],
    },
  },
  // Error-level: the two trees that task-010-C already cleaned up. New
  // violations here fail `pnpm lint` so regressions can't land without
  // an explicit ESLint disable (and a reviewer comment).
  {
    files: [
      'apps/web/src/features/auth/**/*.{ts,tsx}',
      'apps/web/src/features/workspaces/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: PALETTE_PATTERN, message: PALETTE_MESSAGE },
      ],
    },
  },
];
