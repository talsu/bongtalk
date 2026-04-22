import { cn } from '../../lib/cn';

/**
 * Icon names match the `qf-i-*` ids in /design-system/icons.svg.
 * Adding an icon: extend the sprite + append the id to this union.
 * Everything is stroke-based currentColor — colour via the parent's
 * `color` / Tailwind text-* utility; size via the `size` prop.
 */
export type IconName =
  | 'alert'
  | 'arrow-left'
  | 'arrow-right'
  | 'attach'
  | 'badge'
  | 'bell'
  | 'bell-off'
  | 'bold'
  | 'bookmark'
  | 'calendar'
  | 'camera'
  | 'check'
  | 'check-double'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'clipboard'
  | 'clock'
  | 'code'
  | 'compass'
  | 'copy'
  | 'crown'
  | 'dnd'
  | 'download'
  | 'edit'
  | 'emoji'
  | 'external'
  | 'eye'
  | 'eye-off'
  | 'file'
  | 'file-text'
  | 'filter'
  | 'folder'
  | 'forward'
  | 'fullscreen'
  | 'gif'
  | 'globe'
  | 'grid'
  | 'hash'
  | 'headphones'
  | 'headphones-off'
  | 'help'
  | 'home'
  | 'idle'
  | 'image'
  | 'inbox'
  | 'info'
  | 'italic'
  | 'layers'
  | 'link'
  | 'live'
  | 'loading'
  | 'lock'
  | 'login'
  | 'logout'
  | 'megaphone'
  | 'mention'
  | 'message'
  | 'mic'
  | 'mic-off'
  | 'minimize'
  | 'moon'
  | 'more'
  | 'more-v'
  | 'offline'
  | 'phone'
  | 'phone-off'
  | 'pin'
  | 'plus'
  | 'plus-circle'
  | 'quote'
  | 'reaction-add'
  | 'refresh'
  | 'reply'
  | 'reply-all'
  | 'screenshare'
  | 'search'
  | 'send'
  | 'server'
  | 'settings'
  | 'shield'
  | 'shield-check'
  | 'sliders'
  | 'sort'
  | 'sparkle'
  | 'star'
  | 'sticker'
  | 'strike'
  | 'sun'
  | 'thread'
  | 'trash'
  | 'underline'
  | 'upload'
  | 'user'
  | 'user-plus'
  | 'users'
  | 'video'
  | 'video-off'
  | 'volume'
  | 'x'
  | 'x-circle';

type Size = 'sm' | 'md' | 'lg' | 'xl';

export function Icon({
  name,
  size = 'md',
  solid,
  className,
  'aria-label': ariaLabel,
  ...rest
}: {
  name: IconName;
  size?: Size;
  solid?: boolean;
  className?: string;
  'aria-label'?: string;
} & Omit<React.SVGAttributes<SVGSVGElement>, 'className'>): JSX.Element {
  const labelled = typeof ariaLabel === 'string';
  return (
    <svg
      className={cn(
        'qf-icon',
        size !== 'md' && `qf-icon--${size}`,
        solid && 'qf-icon--solid',
        className,
      )}
      aria-hidden={labelled ? undefined : true}
      aria-label={ariaLabel}
      role={labelled ? 'img' : undefined}
      {...rest}
    >
      <use href={`/design-system/icons.svg#qf-i-${name}`} />
    </svg>
  );
}
