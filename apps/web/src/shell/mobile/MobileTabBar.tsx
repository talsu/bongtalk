import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../../design-system/primitives';
import type { IconName } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useActivityUnread } from '../../features/activity/useActivity';

/**
 * 071-M2 E3 (A안 / PRD §02 / FR-IA-MOB-01): 고정 5탭 — 채팅·인박스·스레드·검색·나.
 *
 * task-033 의 3탭(홈/활동/설정) 모델을 폐기하고 PRD 카노니컬로 통일한다(M4 가
 * PRD 목업들의 3~4탭 표기를 5탭으로 개정). 라우팅은 탭바가 내부에서 수행해
 * 모든 모바일 표면이 props 없이 동일 탭바를 장착한다(active 자동 판정).
 *
 *  - 채팅: 마지막 채팅 위치(sessionStorage qf:lastChatPath — 이 컴포넌트가
 *    /w/* · /dms* 에 있을 때 스스로 기록)로 복귀. 없으면 '/'.
 *  - 인박스: /activity (Activity 화면 — 멘션/반응/스레드 알림).
 *  - 스레드: /threads (qf-m-thread-inbox — 내 구독 스레드).
 *  - 검색: /search (풀스크린 검색 + Jump).
 *  - 나: /you (you-header + 상태 변경 + 설정/프로필/로그아웃).
 *
 * 뱃지 의미 분리(감사 B-43): 수량 뱃지(qf-m-tab__badge)는 9 초과, 단순 존재는
 * dot. 활성 표시는 DS 가 aria-selected 로 처리(__pill 은 DS 장식).
 */
export type MobileTabKey = 'chat' | 'inbox' | 'threads' | 'search' | 'you';

const LAST_CHAT_KEY = 'qf:lastChatPath';

function isChatPath(pathname: string): boolean {
  return pathname.startsWith('/w/') || pathname.startsWith('/dms') || pathname === '/';
}

export function activeTabFor(pathname: string): MobileTabKey | null {
  if (pathname.startsWith('/activity')) return 'inbox';
  if (pathname.startsWith('/threads')) return 'threads';
  if (pathname.startsWith('/search')) return 'search';
  if (pathname.startsWith('/you')) return 'you';
  // 071-M3 F3: 저장함은 '나' 탭의 드릴다운 화면 — 활성 탭 유지.
  if (pathname.startsWith('/saved')) return 'you';
  if (isChatPath(pathname)) return 'chat';
  return null;
}

export function MobileTabBar(): JSX.Element {
  const { data: unread } = useActivityUnread();
  const navigate = useNavigate();
  const location = useLocation();
  const active = activeTabFor(location.pathname);
  const inboxBadge = unread?.total ?? 0;

  // 채팅 표면에 있는 동안 마지막 채팅 경로를 기록 — '채팅' 탭 복귀 목적지.
  useEffect(() => {
    if (!isChatPath(location.pathname) || location.pathname === '/') return;
    try {
      sessionStorage.setItem(LAST_CHAT_KEY, location.pathname + location.search);
    } catch {
      /* storage 불가 환경은 복귀만 '/' 폴백 */
    }
  }, [location.pathname, location.search]);

  const goChat = (): void => {
    let last: string | null = null;
    try {
      last = sessionStorage.getItem(LAST_CHAT_KEY);
    } catch {
      last = null;
    }
    navigate(last ?? '/');
  };

  return (
    <nav
      data-testid="mobile-tabbar"
      className="qf-m-tabbar qf-m-safe-bottom"
      aria-label="기본 탐색"
      // M6 T5: 탭 버튼의 role=tab 합법화 짝(axe aria-required-parent).
      role="tablist"
    >
      <Tab
        testId="mobile-tab-chat"
        label="채팅"
        icon="message"
        selected={active === 'chat'}
        onClick={goChat}
      />
      <Tab
        testId="mobile-tab-inbox"
        label="인박스"
        icon="bell"
        selected={active === 'inbox'}
        onClick={() => navigate('/activity')}
        badgeCount={inboxBadge}
      />
      <Tab
        testId="mobile-tab-threads"
        label="스레드"
        icon="thread"
        selected={active === 'threads'}
        onClick={() => navigate('/threads')}
      />
      <Tab
        testId="mobile-tab-search"
        label="검색"
        icon="search"
        selected={active === 'search'}
        onClick={() => navigate('/search')}
      />
      <Tab
        testId="mobile-tab-you"
        label="나"
        icon="user"
        selected={active === 'you'}
        onClick={() => navigate('/you')}
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
      // M6 T5 (axe aria-allowed-attr critical): aria-selected 는 role 이 있어야
      // 합법 — DS 가 [aria-selected] 셀렉터로 활성 스타일을 그리므로(mobile.css
      // L112~, DS 4파일 frozen) 속성을 유지하고 tab role 을 부여한다(컨테이너
      // nav 는 tablist — 하단 내비의 ARIA tabs 패턴 절충, Ionic 동례).
      role="tab"
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
