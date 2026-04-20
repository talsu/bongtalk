import { cn } from '../../lib/cn';

type Props = {
  /** `wordmark` (default) is the full "qufox" lockup; `symbol` is the rounded-tile
   *  fox badge used for avatars / PWA icons. */
  variant?: 'wordmark' | 'symbol';
  /** Tone — `dark` for light surfaces, `light` for navy surfaces, `mono` when
   *  you want CSS `color` to tint the mark (inlined only). */
  tone?: 'dark' | 'light';
  /** Height in px. Wordmark min 20; symbol min 16 per BRAND.md. */
  size?: number;
  className?: string;
  /** When the mark is purely decorative (e.g. next to visible "qufox" text),
   *  pass `decorative` to hide from assistive tech. */
  decorative?: boolean;
};

/**
 * Brand-assets lockup. Serves from /brand-assets/svg/*.svg (Vite public dir),
 * no rasterization. Use `variant="wordmark"` for the navbar/login header and
 * `variant="symbol"` for the 40px square avatar slot.
 */
export function BrandMark({
  variant = 'wordmark',
  tone = 'dark',
  size,
  className,
  decorative = false,
}: Props): JSX.Element {
  const src =
    variant === 'wordmark'
      ? tone === 'dark'
        ? '/brand-assets/svg/fox-wordmark-dark-on-light.svg'
        : '/brand-assets/svg/fox-wordmark-light-on-dark.svg'
      : tone === 'dark'
        ? '/brand-assets/svg/fox-symbol-dark.svg'
        : '/brand-assets/svg/fox-symbol-light.svg';

  const defaultHeight = variant === 'wordmark' ? 32 : 40;
  return (
    <img
      src={src}
      alt={decorative ? '' : 'qufox'}
      aria-hidden={decorative}
      height={size ?? defaultHeight}
      // Width auto-derives from SVG aspect; keep a min so we never drop
      // below the brand-guide floor (20px wordmark / 16px symbol).
      style={{
        height: size ?? defaultHeight,
        minWidth: variant === 'wordmark' ? 20 : 16,
        width: 'auto',
      }}
      className={cn('select-none', className)}
    />
  );
}
