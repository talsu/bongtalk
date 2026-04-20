/**
 * Semantic color tokens. Components must only reference the KEY (e.g.
 * `bg-background`, `text-foreground`) — not the raw HSL values. The two
 * palettes below are written into CSS variables by `ThemeProvider` so the
 * same class names flip on light/dark switch without a re-render.
 *
 * Primitive colors (blue-500, slate-900, …) only live inside THIS file —
 * an ESLint rule rejects them in any other file so future contributors
 * can't accidentally re-introduce theme drift.
 */
export type ColorToken =
  | 'background'
  | 'foreground'
  | 'bg-subtle'
  | 'bg-muted'
  | 'bg-accent'
  | 'bg-primary'
  | 'fg-primary'
  | 'bg-surface' // elevated card / column background
  | 'border-subtle'
  | 'border-strong'
  | 'text-muted'
  | 'ring'
  | 'success'
  | 'warning'
  | 'danger'
  | 'presence-online'
  | 'presence-idle'
  | 'presence-offline'
  | 'presence-dnd';

export const colors: { light: Record<ColorToken, string>; dark: Record<ColorToken, string> } = {
  light: {
    background: '0 0% 100%',
    foreground: '222 47% 11%',
    'bg-subtle': '210 40% 96%',
    'bg-muted': '210 40% 93%',
    'bg-accent': '210 40% 94%',
    'bg-primary': '221 83% 53%',
    'fg-primary': '0 0% 100%',
    'bg-surface': '0 0% 100%',
    'border-subtle': '214 32% 91%',
    'border-strong': '214 32% 82%',
    'text-muted': '215 16% 47%',
    ring: '221 83% 53%',
    success: '142 71% 45%',
    warning: '38 92% 50%',
    danger: '0 84% 60%',
    'presence-online': '142 71% 45%',
    'presence-idle': '38 92% 50%',
    'presence-offline': '215 16% 62%',
    'presence-dnd': '0 84% 60%',
  },
  dark: {
    background: '222 47% 11%',
    foreground: '210 40% 98%',
    'bg-subtle': '217 33% 17%',
    'bg-muted': '215 28% 21%',
    'bg-accent': '217 33% 19%',
    'bg-primary': '217 91% 60%',
    'fg-primary': '222 47% 11%',
    'bg-surface': '222 41% 14%',
    'border-subtle': '217 33% 24%',
    'border-strong': '217 33% 32%',
    'text-muted': '217 11% 65%',
    ring: '217 91% 60%',
    success: '142 71% 45%',
    warning: '38 92% 50%',
    danger: '0 84% 60%',
    'presence-online': '142 71% 45%',
    'presence-idle': '38 92% 50%',
    'presence-offline': '217 11% 45%',
    'presence-dnd': '0 84% 60%',
  },
};

/**
 * CSS variable names for each semantic token. Kept as a map so the
 * ThemeProvider can iterate and write them, and Tailwind can reference
 * them as `hsl(var(--bg-subtle))` etc.
 */
export const cssVarFor = (token: ColorToken): string => `--${token}`;
