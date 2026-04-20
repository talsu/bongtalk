import { cn } from '../../lib/cn';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_TEXT: Record<AvatarSize, string> = {
  xs: 'text-[10px]',
  sm: 'text-[11px]',
  md: 'text-[13px]',
  lg: 'text-[15px]',
  xl: 'text-[18px]',
};

// Deterministic per-user color derived from the name hash. Content-data
// derived, so it's allowed to bypass semantic tokens — we just pick hues
// within the accent family so avatars stay on-brand.
function colorFromSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hues = [258, 272, 290, 240, 220, 200, 310, 270];
  return `hsl(${hues[Math.abs(hash) % hues.length]} 65% 55%)`;
}

type Props = {
  name: string;
  size?: AvatarSize;
  className?: string;
};

export function Avatar({ name, size = 'md', className }: Props): JSX.Element {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        'qf-avatar',
        `qf-avatar--${size}`,
        'inline-flex items-center justify-center font-semibold text-white',
        SIZE_TEXT[size],
        className,
      )}
      style={{ background: colorFromSeed(name) }}
    >
      {initials}
    </span>
  );
}
