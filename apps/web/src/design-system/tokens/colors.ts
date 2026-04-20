/**
 * Semantic color tokens. Components must only reference the KEY (e.g.
 * `bg-background`, `text-foreground`) — not the raw HSL values. The two
 * palettes below are written into CSS variables by `ThemeProvider` so the
 * same class names flip on light/dark switch without a re-render.
 *
 * Primitive colors (blue-500, slate-900, …) only live inside THIS file —
 * an ESLint rule rejects them in any other file so future contributors
 * can't accidentally re-introduce theme drift.
 *
 * qufox brand alignment (task-post-017):
 *   - Night    #1E1B4B  ≈ hsl(243, 47%, 20%)  — primary ink, dark-mode canvas
 *   - Lavender #E9D5FF  ≈ hsl(272, 100%, 92%) — dark-mode text, fox fill
 *   - Violet   #8B5CF6  ≈ hsl(258, 90%, 66%)  — accent / CTA / links / ring
 *   - Paper    #FAFAFF  ≈ hsl(240, 100%, 99%) — light-mode canvas
 *
 * The HSL numbers below derive from the four brand hexes with alpha /
 * lightness tweaks to keep the semantic roles (subtle, muted, accent)
 * legible. Preview the result by opening /brand-assets/preview.html
 * side-by-side with the running app.
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
    // Paper canvas — #FAFAFF, almost-white with a faint lavender cast so
    // the Violet accent doesn't vibrate against pure white.
    background: '240 100% 99%',
    // Night ink — text on Paper. Full-strength brand navy.
    foreground: '243 47% 20%',
    // Subtle bg — a hair darker than canvas, e.g. channel-list background.
    'bg-subtle': '245 80% 97%',
    // Muted bg — button-hover, row-selected. Mid-point between paper+lavender.
    'bg-muted': '270 70% 94%',
    // Accent bg — Lavender tile. Unread pill, selected message bubble.
    'bg-accent': '270 100% 92%',
    // Primary bg — Violet CTA button, active channel highlight.
    'bg-primary': '258 90% 66%',
    // Text on Primary — white for contrast on Violet.
    'fg-primary': '0 0% 100%',
    // Surface — elevated cards, modals, composers. Pure white lifts off
    // the Paper canvas via a subtle 1% shift.
    'bg-surface': '0 0% 100%',
    // Borders — Night at low opacity so they read as divider lines not
    // hard stripes. Strong is the "focused input" tier.
    'border-subtle': '243 47% 90%',
    'border-strong': '243 47% 80%',
    // Secondary text — labels, timestamps, helper text.
    'text-muted': '243 30% 50%',
    // Focus ring — Violet. Shared with bg-primary so the :focus-visible
    // outline matches the brand accent.
    ring: '258 90% 66%',
    // Status colors are semantic (success/warning/danger), not brand
    // palette — they need to be unambiguous at a glance. Held over.
    success: '142 71% 45%',
    warning: '38 92% 50%',
    danger: '0 84% 60%',
    'presence-online': '142 71% 45%',
    'presence-idle': '38 92% 50%',
    'presence-offline': '243 15% 65%',
    'presence-dnd': '0 84% 60%',
  },
  dark: {
    // Night canvas — slightly darker than the raw #1E1B4B so regular
    // UI elements (cards, buttons) can lift off it via lightness deltas
    // without washing out to pure Night.
    background: '243 47% 12%',
    // Lavender ink — text on Night, same as the fox fill on the dark
    // symbol. Full-strength #E9D5FF.
    foreground: '270 100% 92%',
    // Subtle bg — one step up from background, e.g. channel rail.
    'bg-subtle': '243 45% 18%',
    // Muted bg — row-hover on dark.
    'bg-muted': '243 40% 22%',
    // Accent bg — deep Violet for hover/selected states on dark, keeps
    // the accent readable against Lavender text.
    'bg-accent': '258 60% 28%',
    // Primary bg — Violet CTA (same hue as light, works on both).
    'bg-primary': '258 90% 66%',
    // Text on Primary — dark Night so the CTA text is high contrast
    // on the Violet button even in dark mode.
    'fg-primary': '243 47% 15%',
    // Surface — elevated cards on dark. Two steps up from background,
    // matching tokens.css's `color-mix(Night 85%, white)` approximation.
    'bg-surface': '243 45% 16%',
    // Borders — Lavender at low opacity. Flipped direction from light
    // (Night→Lavender) so the border still reads as a paler line.
    'border-subtle': '272 40% 30%',
    'border-strong': '272 40% 42%',
    // Secondary text — 70% Lavender.
    'text-muted': '272 50% 78%',
    // Ring — Violet, unchanged from light (single accent color across
    // themes is a brand constraint).
    ring: '258 90% 66%',
    // Status colors on dark — slightly brighter so they clear the
    // Night background without shouting over the Violet accent.
    success: '142 71% 55%',
    warning: '38 92% 62%',
    danger: '0 84% 68%',
    'presence-online': '142 71% 55%',
    'presence-idle': '38 92% 62%',
    'presence-offline': '272 15% 55%',
    'presence-dnd': '0 84% 68%',
  },
};

/**
 * CSS variable names for each semantic token. Kept as a map so the
 * ThemeProvider can iterate and write them, and Tailwind can reference
 * them as `hsl(var(--bg-subtle))` etc.
 */
export const cssVarFor = (token: ColorToken): string => `--${token}`;
