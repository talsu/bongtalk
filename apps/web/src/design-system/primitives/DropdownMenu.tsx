import * as RDropdown from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export const DropdownRoot = RDropdown.Root;
export const DropdownTrigger = RDropdown.Trigger;

export function DropdownContent({
  children,
  align = 'end',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
}): JSX.Element {
  return (
    <RDropdown.Portal>
      <RDropdown.Content
        align={align}
        sideOffset={4}
        className={cn('qf-menu z-overlay', className)}
      >
        {children}
      </RDropdown.Content>
    </RDropdown.Portal>
  );
}

export function DropdownItem({
  children,
  onSelect,
  danger,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
}): JSX.Element {
  return (
    <RDropdown.Item
      className={cn('qf-menu__item outline-none', danger && 'qf-menu__item--danger')}
      onSelect={(e) => {
        e.preventDefault();
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
