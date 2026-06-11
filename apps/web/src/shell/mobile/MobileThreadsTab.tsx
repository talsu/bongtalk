import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMyWorkspaces } from '../../features/workspaces/useWorkspaces';
import { useMyThreads, useMarkAllThreadsRead } from '../../features/threads/useThread';
import { useNotifications } from '../../stores/notification-store';
import { useChannelList } from '../../features/channels/useChannels';
import { Icon } from '../../design-system/primitives';
import { MobileTabBar } from './MobileTabBar';

/**
 * 071-M2 E3 (FR-TH-09 모바일 / PRD §02 5탭): 스레드 탭 — 내 구독 스레드 인박스.
 *
 * 데이터는 데스크톱 ThreadsView 와 동일한 useMyThreads(GET /users/me/threads —
 * cross-workspace). 항목 탭 → 해당 채널 라우트 + `?thread=<rootId>` (MobileShell
 * 경로의 ThreadPanel 소비와 정합). 응답에 워크스페이스 식별자가 없어 현재
 * 워크스페이스(마지막 채팅 컨텍스트)의 채널 id 집합으로 필터한다 — ThreadsView 의
 * cross-workspace 필터와 동일한 정합 규칙.
 *
 * DS: qf-m-thread-inbox__item 골격 + 기존 qf-m-section/qf-badge. '모두 읽음'
 * 일괄 액션(FR-TH-10)은 M3 도달성 슬라이스에서 승격.
 */
export function MobileThreadsTab(): JSX.Element {
  const navigate = useNavigate();
  const { data: mine } = useMyWorkspaces();
  // 마지막 채팅 경로의 slug 를 컨텍스트로 삼는다(없으면 첫 워크스페이스).
  const lastSlug = useMemo(() => {
    try {
      const last = sessionStorage.getItem('qf:lastChatPath');
      const m = last?.match(/^\/w\/([^/]+)\//);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }, []);
  const ws = mine?.workspaces.find((w) => w.slug === lastSlug) ?? mine?.workspaces[0] ?? null;
  const { data, isLoading } = useMyThreads(!!ws);
  // 071-M3 F4 (FR-TH-10 모바일): 모두 읽음 — Undo 는 서버 스냅샷 부재로 데스크톱
  // parity(토스트만). cross-workspace 뮤테이션이라 카운트가 화면 항목 수보다 클 수 있다.
  const markAllMut = useMarkAllThreadsRead();
  const notify = useNotifications((st) => st.push);
  const { data: channelData } = useChannelList(ws?.id);

  const channelNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of channelData?.categories ?? []) {
      for (const c of cat.channels) map.set(c.id, c.name);
    }
    for (const c of channelData?.uncategorized ?? []) map.set(c.id, c.name);
    return map;
  }, [channelData]);

  const threads = (data?.threads ?? []).filter((t) => channelNameById.has(t.channelId));

  return (
    <div data-testid="mobile-threads-tab" className="qf-m-screen qf-m-screen--app">
      <header className="qf-m-topbar qf-m-safe-top">
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">스레드</div>
          <div className="qf-m-topbar__subtitle">{ws?.name ?? ''}</div>
        </div>
        <div className="qf-m-topbar__actions">
          <button
            type="button"
            data-testid="mobile-threads-mark-all-read"
            className="qf-m-section__action"
            disabled={markAllMut.isPending}
            aria-busy={markAllMut.isPending}
            onClick={() =>
              markAllMut.mutate(undefined, {
                onSuccess: (res) =>
                  notify({
                    variant: 'info',
                    title: '스레드를 모두 읽음 처리했어요',
                    body: `${(res as { updated?: number })?.updated ?? 0}개 스레드`,
                    ttlMs: 4000,
                  }),
              })
            }
          >
            모두 읽음
          </button>
        </div>
      </header>
      <main className="qf-m-body flex min-h-0 flex-col overflow-y-auto">
        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : threads.length === 0 ? (
          <div className="qf-m-empty flex-1">
            <div className="qf-m-empty__title">팔로우 중인 스레드가 없습니다</div>
            <div className="qf-m-empty__body">
              스레드에 답글을 달거나 팔로우하면 여기에 모입니다.
            </div>
          </div>
        ) : (
          <ul aria-label="내 스레드">
            {threads.map((t) => (
              <li key={t.parentMessageId}>
                <button
                  type="button"
                  data-testid={`mobile-thread-item-${t.parentMessageId}`}
                  className="qf-m-thread-inbox__item w-full text-left"
                  onClick={() => {
                    const channelName = channelNameById.get(t.channelId);
                    if (!ws || !channelName) return;
                    navigate(`/w/${ws.slug}/${channelName}?thread=${t.parentMessageId}`);
                  }}
                >
                  <span className="qf-m-thread-inbox__avatars" aria-hidden>
                    <Icon name="thread" size="sm" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="qf-m-row__primary block truncate">
                      #{channelNameById.get(t.channelId)} — {t.excerpt || '(본문 없음)'}
                    </span>
                    <span className="qf-m-row__secondary block">
                      {t.latestReplyAt
                        ? new Date(t.latestReplyAt).toLocaleString('ko-KR', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '답글 없음'}
                    </span>
                  </span>
                  {t.unreadCount > 0 ? (
                    <span className="qf-badge qf-badge--count" data-testid="mobile-thread-unread">
                      {t.unreadCount > 99 ? '99+' : t.unreadCount}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
      <MobileTabBar />
    </div>
  );
}
