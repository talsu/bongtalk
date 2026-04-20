import { cn } from '../../lib/cn';
import type { PresenceStatus } from '../../features/presence/presenceStatus';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_TEXT: Record<AvatarSize, string> = {
  xs: 'text-[length:var(--fs-11)]',
  sm: 'text-[length:var(--fs-11)]',
  md: 'text-[length:var(--fs-13)]',
  lg: 'text-[length:var(--fs-15)]',
  xl: 'text-[length:var(--fs-18)]',
};

const STATUS_LABEL: Record<Exclude<PresenceStatus, 'offline'>, string> = {
  online: '온라인',
  dnd: '방해 금지',
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
  /**
   * Presence status overlay. Renders `qf-avatar__status qf-avatar__status--<state>`
   * for online/dnd; offline emits no dot (the member row itself fades
   * via opacity at the caller). `undefined` means "no presence concept
   * applies" — e.g. the brand avatar in the composer.
   */
  status?: PresenceStatus;
};

export function Avatar({ name, size = 'md', className, status }: Props): JSX.Element {
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
      {status && status !== 'offline' ? (
        <span
          className={`qf-avatar__status qf-avatar__status--${status}`}
          role="img"
          aria-label={STATUS_LABEL[status]}
        />
      ) : null}
    </span>
  );
}
