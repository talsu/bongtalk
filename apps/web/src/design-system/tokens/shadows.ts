/**
 * Elevation shadows. HSL so dark mode can override the lightness component
 * without redefining each rule. Opacity stays the same.
 */
export const shadows = {
  e1: '0 1px 2px hsl(var(--foreground) / 0.04)',
  e2: '0 2px 4px hsl(var(--foreground) / 0.06)',
  e3: '0 4px 8px hsl(var(--foreground) / 0.08)',
  e4: '0 8px 16px hsl(var(--foreground) / 0.12)',
  e5: '0 16px 32px hsl(var(--foreground) / 0.16)',
} as const;
