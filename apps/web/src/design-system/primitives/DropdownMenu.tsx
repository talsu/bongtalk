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
        className={cn(
          'z-overlay min-w-[160px] rounded-md border border-border-subtle bg-bg-surface p-1 text-sm shadow-md',
          className,
        )}
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
      className={cn(
        'cursor-pointer rounded px-2 py-1.5 outline-none',
        'focus:bg-bg-accent focus:text-foreground',
        danger && 'text-danger focus:text-danger',
      )}
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
  return <RDropdown.Separator className="my-1 h-px bg-border-subtle" />;
}
