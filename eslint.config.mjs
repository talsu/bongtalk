import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';

// Regex for raw Tailwind palette classes. The task-010 ESLint rule
// enforces design-token usage (surface, foreground, danger, …) in
// favour of hard-coded `bg-slate-900`, `text-red-600`, etc. Error-level
// on features/auth + features/workspaces (the sweep done in task-010-C);
// warn-level elsewhere so the rest of the codebase migrates incrementally
// without blocking CI.
//
// task-015-A (task-010-follow-5 closure): Literal catches plain string
// literals; TemplateElement catches the static parts of template
// literals (`` `bg-slate-${shade}` `` — the "bg-slate-" part lives in
// TemplateElement.value.raw). Without the second selector the rule
// missed ``${'bg-red-600'}``-style interpolation builds.
const PALETTE_REGEX = '\\b(bg|text|border)-(slate|red|blue|green|yellow)-[0-9]+\\b';
const PALETTE_PATTERN_LITERAL = `Literal[value=/${PALETTE_REGEX}/]`;
const PALETTE_PATTERN_TEMPLATE = `TemplateElement[value.raw=/${PALETTE_REGEX}/]`;

const PALETTE_MESSAGE =
  'Use design-system semantic tokens (surface/foreground/text-muted/danger/accent/…) instead of raw Tailwind palette classes. See apps/web/src/index.css + tailwind.config.js for the token list.';

// task-018-A: raw-value guard. DS tokens.css + qf-* classes are the
// canonical source; raw hex, raw pixel arbitrary values, rgba(), and
// inline box-shadow literals must not appear in apps/web/src/**. The
// regex patterns are intentionally loose (whole string tested) — they
// fire on both className strings and style prop string values alike.
//
// Length tokens exist in tokens.css as --fs-* / --s-* / --r-* / --w-* /
// --h-*; a contributor who really needs a raw px must extend tokens.css
// (and document in /design-system/index.html), not bypass this rule.
const RAW_HEX = '#[0-9a-fA-F]{3,8}\\b';
const RAW_PX_ARBITRARY = '\\[[0-9]+(?:\\.[0-9]+)?px\\]';
const RAW_RGB = '\\brgba?\\(';
const RAW_BOX_SHADOW_INLINE = '(?:^|[^-])box-shadow\\s*:\\s*[0-9]';

const RAW_MESSAGE =
  'task-018: Use DS tokens (var(--fs-*) / var(--s-*) / var(--elev-*)) or a qf-* class instead of a raw hex / [Npx] / rgba() / inline box-shadow. See feedback_design_system_source_of_truth.md + /design-system/tokens.css.';

const rawPatterns = [RAW_HEX, RAW_PX_ARBITRARY, RAW_RGB, RAW_BOX_SHADOW_INLINE];
const rawSelectors = rawPatterns.flatMap((p) => [
  { selector: `Literal[value=/${p}/]`, message: RAW_MESSAGE },
  { selector: `TemplateElement[value.raw=/${p}/]`, message: RAW_MESSAGE },
]);

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
      // DS itself + brand-assets own the raw values; the rule enforces
      // that NOTHING ELSE reintroduces them.
      'apps/web/public/design-system/**',
      'apps/web/public/brand-assets/**',
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
        { selector: PALETTE_PATTERN_LITERAL, message: PALETTE_MESSAGE },
        { selector: PALETTE_PATTERN_TEMPLATE, message: PALETTE_MESSAGE },
        ...rawSelectors,
      ],
    },
  },
  // Error-level: raw-value guard (018) + palette guard (010) for the
  // trees that have already been swept. New violations here fail
  // `pnpm lint` so regressions can't land without an explicit disable.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: [
      // Unit / spec files may legitimately test raw values as fixtures.
      '**/*.spec.{ts,tsx}',
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...rawSelectors],
    },
  },
  {
    files: [
      'apps/web/src/features/auth/**/*.{ts,tsx}',
      'apps/web/src/features/workspaces/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: PALETTE_PATTERN_LITERAL, message: PALETTE_MESSAGE },
        { selector: PALETTE_PATTERN_TEMPLATE, message: PALETTE_MESSAGE },
        ...rawSelectors,
      ],
    },
  },
];
