import { Icon } from '../../design-system/primitives';
import type { IconName } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useActivityUnread } from '../../features/activity/useActivity';

/**
 * Bottom tab bar pinned above the home indicator. qf-m-tabbar grid
 * with 4 slots. task-024 landed Home + You; task-026-F/G enables the
 * Activity tab with a qf-m-tab__badge driven by useActivityUnread.
 * DMs stays disabled until DM surface lands.
 *
 * Each tab renders the DS-defined internal structure (qf-m-tab__icon
 * / __label / __badge / __dot) so the layout exactly matches the
 * mobile-mockups.jsx TabBar component.
 */
export function MobileTabBar({
  active = 'home',
  onHome,
  onYou,
  onActivity,
}: {
  active?: 'home' | 'dms' | 'activity' | 'you';
  onHome: () => void;
  onYou: () => void;
  onActivity?: () => void;
}): JSX.Element {
  const { data: unread } = useActivityUnread();
  const activityBadge = unread?.total ?? 0;

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
      <Tab
        testId="mobile-tab-activity"
        label="활동"
        icon="bell"
        selected={active === 'activity'}
        onClick={onActivity}
        badgeCount={activityBadge}
      />
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
  badgeCount,
}: {
  testId: string;
  label: string;
  icon: IconName;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  badgeCount?: number;
}): JSX.Element {
  const showBadge = !!badgeCount && badgeCount > 9;
  const showDot = !!badgeCount && badgeCount > 0 && badgeCount <= 9;
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
        {showDot ? <span className="qf-m-tab__dot" data-testid={`${testId}-dot`} /> : null}
        {showBadge ? (
          <span className="qf-m-tab__badge" data-testid={`${testId}-badge`}>
            {badgeCount! > 99 ? '99+' : badgeCount}
          </span>
        ) : null}
      </span>
      <span className="qf-m-tab__label">{label}</span>
    </button>
  );
}
