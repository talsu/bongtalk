# qufox — Brand handoff

Everything you need to ship the qufox identity into the live site. This folder is the single source of truth; don't re-invent colors, fonts, or the fox in component code.

---

## TL;DR for Claude Code

1. **Mount assets** at `/brand-assets/` (or wherever your static root is) so the paths below resolve. Adjust paths if your framework uses a different public dir (Next.js `public/`, Vite `public/`, etc.).
2. **Drop the `<head>` block** (see "HTML head") into every page / root layout.
3. **Import `tokens.css`** once at the root stylesheet, or copy the `:root` block into your existing tokens.
4. **Load fonts** — Space Grotesk (display/body) + Geist Mono (code/caps labels) from Google Fonts.
5. **Use the wordmark SVG** in the header, the symbol SVG for avatars/badges, and the PNG favicons via the link tags. Never rasterize the wordmark; it scales cleanly as SVG.

---

## File inventory

```
brand-assets/
├── BRAND.md                           ← this file
├── tokens.css                         ← CSS variables (colors / fonts / radii)
├── site.webmanifest                   ← PWA manifest
├── svg/
│   ├── fox-symbol-dark.svg            ← navy rounded tile, lavender fox  (app icon look)
│   ├── fox-symbol-light.svg           ← paper rounded tile, navy fox
│   ├── fox-symbol-flat.svg            ← fox only, transparent bg, 2-color
│   ├── fox-symbol-mono.svg            ← fox only, currentColor (CSS-tintable)
│   ├── fox-wordmark-dark-on-light.svg ← "qu[fox]fox" — for light backgrounds
│   ├── fox-wordmark-light-on-dark.svg ← navy bg baked in
│   └── fox-wordmark-mono.svg          ← currentColor text + fox
└── png/
    ├── favicon-16.png                 ← browser tab
    ├── favicon-32.png                 ← browser tab (hi-dpi)
    ├── favicon-48.png                 ← Windows
    ├── apple-touch-icon.png           ← 180×180, iOS home screen
    ├── icon-192.png                   ← PWA "any"
    ├── icon-512.png                   ← PWA "any"
    ├── icon-maskable-512.png          ← PWA "maskable" (has 10% safe area)
    └── og-image.png                   ← 1200×630, social sharing
```

Prefer SVG everywhere possible. PNGs exist for platforms that can't render SVG (favicons, iOS home, OG cards).

---

## Design tokens

### Color

| Token              | Hex       | Use                                                       |
| ------------------ | --------- | --------------------------------------------------------- |
| `--qufox-night`    | `#1E1B4B` | Primary background on dark surfaces, primary ink on light |
| `--qufox-lavender` | `#E9D5FF` | Primary foreground on dark (fox fill, body text on night) |
| `--qufox-violet`   | `#8B5CF6` | Accent — inner ears, links, CTAs, focus rings             |
| `--qufox-paper`    | `#FAFAFF` | Light canvas                                              |

Guidelines:

- The fox symbol is a 2-color drawing — **lavender body + violet inner ears** on any background. Don't recolor it per theme.
- Body text on `--qufox-paper`: `--qufox-night`. Body text on `--qufox-night`: `--qufox-lavender`.
- Use `--qufox-violet` sparingly — it should feel like an accent, not a dominant color. Buttons, hovered links, tags, progress bars.
- Do not introduce secondary brand colors without asking the brand owner.

### Type

- **Display / body**: Space Grotesk, weights 400 / 500 / 600 / 700.
- **Mono / eyebrow caps**: Geist Mono, weights 400 / 500.
- Headings use 600, letter-spacing `-0.03em`. Eyebrow caps use mono, 10–11px, `letter-spacing: 2px`, uppercase, color `--qufox-violet` on light backgrounds.

Load both from Google Fonts in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

### Radii

| Token           | Value | Use                                       |
| --------------- | ----- | ----------------------------------------- |
| `--radius-sm`   | 6px   | Chips, small inputs                       |
| `--radius-md`   | 10px  | Buttons, inputs                           |
| `--radius-lg`   | 14px  | Cards                                     |
| `--radius-xl`   | 22px  | App-icon feel (22% of side, iOS-squircle) |
| `--radius-pill` | 999px | Avatars, pill buttons                     |

---

## HTML head (drop-in)

Paste this into the `<head>` of every page (or your root layout). Adjust paths if your static root isn't `/brand-assets/`.

```html
<!-- Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>

<!-- Favicons -->
<link rel="icon" href="/brand-assets/png/favicon-32.png" sizes="32x32" type="image/png" />
<link rel="icon" href="/brand-assets/png/favicon-16.png" sizes="16x16" type="image/png" />
<link rel="icon" href="/brand-assets/svg/fox-symbol-dark.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/brand-assets/png/apple-touch-icon.png" />

<!-- PWA -->
<link rel="manifest" href="/brand-assets/site.webmanifest" />
<meta name="theme-color" content="#1E1B4B" />

<!-- Open Graph / social -->
<meta property="og:title" content="qufox" />
<meta property="og:description" content="Developer & creator community" />
<meta property="og:image" content="https://qufox.com/brand-assets/png/og-image.png" />
<meta property="og:url" content="https://qufox.com" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://qufox.com/brand-assets/png/og-image.png" />
```

---

## Usage recipes

### Site header — wordmark

```html
<a href="/" class="brand">
  <img src="/brand-assets/svg/fox-wordmark-dark-on-light.svg" alt="qufox" height="32" />
</a>
```

```css
.brand img {
  display: block;
  height: 32px;
  width: auto;
}
```

Swap to `fox-wordmark-light-on-dark.svg` when the header sits on a `--qufox-night` background, or use `fox-wordmark-mono.svg` with `color: var(--ink)` via CSS (since the mono variant uses `currentColor`).

### Standalone symbol (avatar, nav item, loading state)

```html
<img src="/brand-assets/svg/fox-symbol-dark.svg" alt="" width="40" height="40" class="avatar" />
```

For a CSS-colorable version (dark mode, hover states), use the **mono** SVG inline and set `color`:

```html
<span class="fox-icon" aria-hidden="true">
  <!-- paste fox-symbol-mono.svg contents here, or load with your framework's SVG import -->
</span>
```

```css
.fox-icon {
  display: inline-block;
  width: 24px;
  height: 24px;
  color: var(--qufox-lavender);
}
.fox-icon svg {
  width: 100%;
  height: 100%;
}
```

### React — inline SVG via your bundler

Most bundlers (Next.js, Vite, CRA, Remix) support importing SVGs as components. If you're in Next.js:

```tsx
import FoxSymbol from '@/public/brand-assets/svg/fox-symbol-mono.svg';
// …with a plugin like @svgr/webpack — or just use <Image> with the SVG path.

export function Avatar() {
  return <FoxSymbol width={40} height={40} style={{ color: 'var(--qufox-lavender)' }} />;
}
```

If you don't have an SVG-as-component plugin, just use `<img>`:

```tsx
<img src="/brand-assets/svg/fox-symbol-dark.svg" alt="qufox" width={40} height={40} />
```

### Button / CTA

```html
<button class="cta">Sign up</button>
```

```css
.cta {
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 12px 20px;
  border-radius: var(--radius-md);
  font: 500 15px var(--font-sans);
  letter-spacing: -0.01em;
  cursor: pointer;
}
.cta:hover {
  background: color-mix(in oklab, var(--accent) 88%, black);
}
.cta:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

### Eyebrow caps (section labels)

```html
<div class="eyebrow">Developer community</div>
```

```css
.eyebrow {
  font: 500 11px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--accent);
}
```

---

## Minimum sizes & safe space

- **Wordmark**: never render below 20px height — the inline fox becomes unreadable.
- **Symbol (rounded tile)**: clean down to 16px. At ≤16px favor the PNG favicons over SVG; the crisp-edges rendering is baked in.
- **Safe area around wordmark**: clear space equal to the height of the "f" in "fox" on all sides.
- **Safe area around symbol**: 12.5% of tile side (equivalent to 1 grid cell of the 16×16 internal grid).

## Don'ts

- Don't stretch, skew, or rotate the fox.
- Don't add strokes, outer glows, or gradient fills to the fox.
- Don't re-color the fox's eyes or nose — they must match the background color of whatever the fox sits on (the provided SVG variants already do this correctly).
- Don't place the fox on a busy photograph without a solid tile behind it — use `fox-symbol-dark.svg` or `fox-symbol-light.svg` which come with their own background.
- Don't use emojis in place of the fox.
- Don't introduce additional fox variants (we already explored and dropped others).

---

## Regenerating assets

All assets live in the Claude design project at `/qufox Brand Identity.html` (design source) and are regenerated via scripts in that project. If a spec changes (palette, new size, new variant), update the design file first and re-run the asset generation there — do not hand-edit PNGs or SVGs in this folder.
