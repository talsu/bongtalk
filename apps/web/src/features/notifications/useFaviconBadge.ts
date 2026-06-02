import { useEffect } from 'react';
import { useBadgeStore } from './badgeStore';
import { documentTitleText, faviconBadgeMode, renderFavicon } from './faviconBadge';

/**
 * S47 (FR-MN-14): badgeStore 의 글로벌 멘션/미읽 합계를 구독해 favicon 오버레이와
 * document.title 배지를 동기화한다. Shell 루트에서 1회 마운트한다.
 *
 *   favicon — mentionCount>0 → 숫자 배지 / unreadCount>0 → dot / 둘 다 0 → 원복.
 *   title   — 글로벌 미읽+멘션 합계가 있으면 `(N) qufox`, 0 이면 `qufox`.
 *
 * 글로벌 합계는 워크스페이스별 카운트의 합이며, isMuted 채널/서버는 서버가 이미
 * 배지 집계에서 제외했으므로(MeNotificationBadgesService) 여기서 다시 거를 필요가
 * 없다(낙관적 bump 도 호출부가 isMuted 확인 후에만 호출).
 */
export function useFaviconBadge(): void {
  // byWorkspace 변경 시 합계를 재계산해 favicon/title 을 갱신.
  const byWorkspace = useBadgeStore((s) => s.byWorkspace);

  useEffect(() => {
    const entries = Object.values(byWorkspace);
    const mentionTotal = entries.reduce((acc, e) => acc + e.mentionCount, 0);
    const unreadTotal = entries.reduce((acc, e) => acc + e.unreadCount, 0);

    // favicon: 멘션 우선(숫자) → 미읽(dot) → 원복.
    void renderFavicon(faviconBadgeMode(mentionTotal, unreadTotal), mentionTotal);

    // title: 글로벌 미읽 합계(멘션은 미읽의 부분집합이라 unreadTotal 이 상한).
    if (typeof document !== 'undefined') {
      document.title = documentTitleText(unreadTotal);
    }
  }, [byWorkspace]);
}
