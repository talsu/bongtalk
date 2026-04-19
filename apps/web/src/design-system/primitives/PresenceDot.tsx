import { cn } from '../../lib/cn';

export type PresenceStatus = 'online' | 'idle' | 'offline' | 'dnd';

const colorByStatus: Record<PresenceStatus, string> = {
  online: 'bg-presence-online',
  idle: 'bg-presence-idle',
  offline: 'bg-presence-offline',
  dnd: 'bg-presence-dnd',
};

const labelByStatus: Record<PresenceStatus, string> = {
  online: '온라인',
  idle: '자리비움',
  offline: '오프라인',
  dnd: '방해 금지',
};

export function PresenceDot({
  status,
  size = 'sm',
  className,
}: {
  status: PresenceStatus;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}): JSX.Element {
  const sizeCls = size === 'xs' ? 'h-1.5 w-1.5' : size === 'md' ? 'h-3 w-3' : 'h-2 w-2';
  return (
    <span
      role="img"
      aria-label={labelByStatus[status]}
      className={cn('inline-block rounded-full', sizeCls, colorByStatus[status], className)}
    />
  );
}
