import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

/**
 * Bottom tab bar pinned above the home indicator. qf-m-tabbar grid
 * with 4 slots — only Home + You are wired in MVP. DMs and Activity
 * are rendered disabled (aria-disabled) so the visual layout is
 * final and we can flip them on without shifting icons later.
 */
export function MobileTabBar({
  active = 'home',
  onHome,
  onYou,
}: {
  active?: 'home' | 'dms' | 'activity' | 'you';
  onHome: () => void;
  onYou: () => void;
}): JSX.Element {
  return (
    <nav
      data-testid="mobile-tabbar"
      className="qf-m-tabbar qf-m-safe-bottom"
      aria-label="기본 탐색"
    >
      <Tab
        testId="mobile-tab-home"
        label="홈"
        icon="home"
        selected={active === 'home'}
        onClick={onHome}
      />
      <Tab testId="mobile-tab-dms" label="DM" icon="message" disabled />
      <Tab testId="mobile-tab-activity" label="활동" icon="inbox" disabled />
      <Tab
        testId="mobile-tab-you"
        label="내 정보"
        icon="user"
        selected={active === 'you'}
        onClick={onYou}
      />
    </nav>
  );
}

function Tab({
  testId,
  label,
  icon,
  selected,
  disabled,
  onClick,
}: {
  testId: string;
  label: string;
  icon: 'home' | 'message' | 'inbox' | 'user';
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      className={cn('qf-m-tab', disabled && 'opacity-40 cursor-not-allowed')}
      aria-selected={selected ? 'true' : 'false'}
      aria-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      <span className="qf-m-tab__icon" aria-hidden>
        <Icon name={icon} size="md" />
      </span>
      <span className="qf-m-tab__label">{label}</span>
    </button>
  );
}
