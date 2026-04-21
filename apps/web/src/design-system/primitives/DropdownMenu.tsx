import * as RDropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const DropdownRoot = RDropdown.Root;
export const DropdownTrigger = RDropdown.Trigger;

export function DropdownContent({
  children,
  align = 'end',
  side = 'bottom',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  /**
   * Which side of the trigger the menu renders on. Defaults to 'bottom'
   * — the common dropdown case. The message composer uses 'top' so the
   * + menu opens upward over the chat area instead of clipping into
   * the footer.
   */
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}): JSX.Element {
  return (
    <RDropdown.Portal>
      <RDropdown.Content
        align={align}
        side={side}
        sideOffset={4}
        className={cn('qf-menu z-overlay', className)}
      >
        {children}
      </RDropdown.Content>
    </RDropdown.Portal>
  );
}

/**
 * Task-019-C (reviewer MED closure): `disabled` now forwards to
 * `RDropdown.Item`. Disabled items can't be activated with
 * mouse / keyboard and are excluded from focus traversal. `asChild`
 * lets callers render a <Link> directly inside the item when they
 * need real navigation behavior (no preventDefault).
 */
export function DropdownItem({
  children,
  onSelect,
  danger,
  disabled,
  asChild,
  preventDefault = true,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  asChild?: boolean;
  /**
   * Radix's default is to CLOSE the menu on select. Set to false when
   * the item contains a `<Link>` so the click navigates instead of
   * being intercepted.
   */
  preventDefault?: boolean;
}): JSX.Element {
  return (
    <RDropdown.Item
      asChild={asChild}
      disabled={disabled}
      className={cn(
        'qf-menu__item outline-none',
        danger && 'qf-menu__item--danger',
        disabled && 'opacity-50',
      )}
      onSelect={(e) => {
        if (preventDefault) e.preventDefault();
        onSelect?.();
      }}
    >
      {children}
    </RDropdown.Item>
  );
}

export function DropdownSeparator(): JSX.Element {
  return <RDropdown.Separator className="qf-menu__separator" />;
}
