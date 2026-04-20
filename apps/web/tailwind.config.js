/**
 * Tailwind reads semantic tokens via CSS custom properties written by
 * ThemeProvider at runtime. Every color class in app code MUST resolve
 * through these keys (never through primitive names like `blue-500`).
 * An ESLint rule in .eslintrc enforces this in PRs.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        'bg-subtle': 'hsl(var(--bg-subtle) / <alpha-value>)',
        'bg-muted': 'hsl(var(--bg-muted) / <alpha-value>)',
        'bg-accent': 'hsl(var(--bg-accent) / <alpha-value>)',
        'bg-primary': 'hsl(var(--bg-primary) / <alpha-value>)',
        'fg-primary': 'hsl(var(--fg-primary) / <alpha-value>)',
        'bg-surface': 'hsl(var(--bg-surface) / <alpha-value>)',
        'border-subtle': 'hsl(var(--border-subtle) / <alpha-value>)',
        'border-strong': 'hsl(var(--border-strong) / <alpha-value>)',
        'text-muted': 'hsl(var(--text-muted) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        success: 'hsl(var(--success) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        danger: 'hsl(var(--danger) / <alpha-value>)',
        'presence-online': 'hsl(var(--presence-online) / <alpha-value>)',
        'presence-idle': 'hsl(var(--presence-idle) / <alpha-value>)',
        'presence-offline': 'hsl(var(--presence-offline) / <alpha-value>)',
        'presence-dnd': 'hsl(var(--presence-dnd) / <alpha-value>)',
      },
      // Brand-aligned radii — matches tokens.css `--radius-*` scale.
      // Post-brand kit: md bumped 8→10, lg 12→14, xl 16→22 (app-icon feel).
      // `pill` is brand-new for the lozenge-shaped unread pills.
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '22px',
        pill: '9999px',
      },
      // Brand typography — the CSS vars defined in src/index.css `:root`
      // (Space Grotesk + Geist Mono with OS fallbacks) surface here as
      // `font-sans` / `font-mono` utility classes.
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '300ms',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.16, 1, 0.3, 1)',
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      zIndex: {
        sidebar: '10',
        overlay: '30',
        modal: '40',
        toast: '50',
        tooltip: '60',
        palette: '70',
      },
    },
  },
  plugins: [],
};
