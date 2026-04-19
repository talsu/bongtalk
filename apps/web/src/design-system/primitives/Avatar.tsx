import { cn } from '../../lib/cn';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const sizes: Record<AvatarSize, string> = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-6 w-6 text-xs',
  md: 'h-8 w-8 text-sm',
  lg: 'h-10 w-10 text-base',
  xl: 'h-12 w-12 text-lg',
};

/**
 * Deterministic color from the user's id/name so the same person gets the
 * same tile across sessions. No network — avatar images come later
 * (task-017 attachments/uploads).
 */
function colorFromSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const hues = [210, 260, 160, 30, 340, 90, 200, 300];
  return `hsl(${hues[Math.abs(hash) % hues.length]} 60% 50%)`;
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
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
        sizes[size],
        className,
      )}
      style={{ background: colorFromSeed(name) }}
    >
      {initials}
    </span>
  );
}
