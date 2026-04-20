import { cn } from '../../lib/cn';
// Vite's `?raw` import brings the SVG in as a string at build time so
// the mono variants can be inlined; that lets `currentColor` inside
// the SVG bind to the component's CSS color. `<img>` would isolate
// the SVG in its own color context, which defeats the mono tone's
// whole point.
import monoSymbolRaw from './fox-symbol-mono.svg?raw';
import monoWordmarkRaw from './fox-wordmark-mono.svg?raw';

type Props = {
  /** `wordmark` (default) is the full "qufox" lockup; `symbol` is the rounded-tile
   *  fox badge used for avatars / PWA icons. */
  variant?: 'wordmark' | 'symbol';
  /**
   * Tone:
   *   `dark` — fox fill on light tile (navy), use on light surfaces.
   *   `light` — fox fill on dark tile (paper), use on dark surfaces.
   *   `mono` — single-color via CSS `currentColor`; pass `color` or let
   *             the ambient CSS `color` cascade. Inlined SVG required.
   */
  tone?: 'dark' | 'light' | 'mono';
  /** Height in px. Wordmark min 20; symbol min 16 per BRAND.md. */
  size?: number;
  /**
   * Only meaningful for `tone="mono"`. Sets the CSS color that the
   * inlined SVG's `currentColor` references. Omit to inherit the
   * ambient text color.
   */
  color?: string;
  className?: string;
  /** When the mark is purely decorative (e.g. next to visible "qufox" text),
   *  pass `decorative` to hide from assistive tech. */
  decorative?: boolean;
};

/**
 * Brand lockup. `dark` / `light` tones serve the baked SVGs straight
 * from /brand-assets/svg/; `mono` inlines the file so CSS `color`
 * tints the fox. BRAND.md specifies min sizes (wordmark 20px, symbol
 * 16px) — enforced via `minHeight` here.
 */
export function BrandMark({
  variant = 'wordmark',
  tone = 'dark',
  size,
  color,
  className,
  decorative = false,
}: Props): JSX.Element {
  const defaultHeight = variant === 'wordmark' ? 32 : 40;
  const h = size ?? defaultHeight;
  const minH = variant === 'wordmark' ? 20 : 16;

  if (tone === 'mono') {
    const raw = variant === 'wordmark' ? monoWordmarkRaw : monoSymbolRaw;
    // Nudge the inline <svg> to fill the wrapper's height so the
    // intrinsic aspect ratio flows to width: auto. Injecting into the
    // opening tag keeps the rest of the SVG unchanged.
    const sized = raw.replace(
      /<svg([^>]*?)>/,
      `<svg$1 style="height:100%;width:auto;display:block;">`,
    );
    return (
      <span
        role={decorative ? 'presentation' : 'img'}
        aria-label={decorative ? undefined : 'qufox'}
        aria-hidden={decorative ? true : undefined}
        className={cn('inline-block select-none align-middle', className)}
        style={{
          color,
          height: h,
          minHeight: minH,
          lineHeight: 0,
        }}
        dangerouslySetInnerHTML={{ __html: sized }}
      />
    );
  }

  const src =
    variant === 'wordmark'
      ? tone === 'dark'
        ? '/brand-assets/svg/fox-wordmark-dark-on-light.svg'
        : '/brand-assets/svg/fox-wordmark-light-on-dark.svg'
      : tone === 'dark'
        ? '/brand-assets/svg/fox-symbol-dark.svg'
        : '/brand-assets/svg/fox-symbol-light.svg';

  return (
    <img
      src={src}
      alt={decorative ? '' : 'qufox'}
      aria-hidden={decorative}
      height={h}
      style={{
        height: h,
        minWidth: minH,
        width: 'auto',
      }}
      className={cn('select-none', className)}
    />
  );
}
