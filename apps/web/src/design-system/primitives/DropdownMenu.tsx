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

/**
 * S38 fix-forward (a11y B-01/B-02): single-select 메뉴(예: 스레드 알림 레벨
 * ALL/MENTIONS/OFF)용 radio 그룹. Radix RadioGroup/RadioItem 을 감싸 각 항목에
 * `role="menuitemradio"` + `aria-checked` 를 자동 부여해 현재 선택을 스크린리더에
 * 노출한다(종전 일반 DropdownItem 은 선택 상태를 SR 로 전하지 못했다). 시각 표기는
 * 기존 qf-menu__item 클래스를 그대로 재사용해 DS 무수정.
 */
export function DropdownRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (next: string) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <RDropdown.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </RDropdown.RadioGroup>
  );
}

export function DropdownRadioItem({
  value,
  children,
  onSelect,
  preventDefault = false,
}: {
  value: string;
  children: ReactNode;
  onSelect?: () => void;
  /**
   * RadioGroup 항목은 기본적으로 select 시 메뉴를 닫는다(레벨 선택 후 닫힘이
   * 자연스럽다). preventDefault=true 면 메뉴를 열어둔다.
   */
  preventDefault?: boolean;
}): JSX.Element {
  return (
    <RDropdown.RadioItem
      value={value}
      className={cn('qf-menu__item outline-none')}
      onSelect={(e) => {
        if (preventDefault) e.preventDefault();
        onSelect?.();
      }}
    >
      {children}
    </RDropdown.RadioItem>
  );
}
