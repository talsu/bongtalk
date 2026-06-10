import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useDmList, useCreateOrGetDm } from '../../features/dms/useDms';
import { useMutedChannelIds } from '../../features/channels/useMutes';
import { deriveDmBadgeCount, dmBadgeText } from '../../features/dms/dmRowBadge';
import { useFriendsList } from '../../features/friends/useFriends';
import { useDmPresence } from '../../features/realtime/useDmPresence';
import { useDmCreated } from '../../features/dms/useDmCreated';
import { MobileTabBar } from './MobileTabBar';

/**
 * task-027-D: mobile /dms — ScreenDMs mockup parity. qf-m-screen +
 * qf-m-topbar__titleBlock + qf-m-search + qf-m-section "All" +
 * qf-m-row list + qf-m-fab "New DM" + qf-m-tabbar.
 */
export function MobileDmList(): JSX.Element {
  const navigate = useNavigate();
  // Global DM — workspace-agnostic. /me/dms ignores the wsId arg, the
  // friends list is the candidate source for "새 DM".
  const { data: dms, isLoading } = useDmList(undefined);
  // S22 (FR-DM-15): 뮤트 DM 은 unread 배지/강조 억제(멘션만). 데스크톱 DmShell 과
  // 동일 정책 — GET /me/mutes 의 channelId 집합 공유.
  const mutedChannelIds = useMutedChannelIds();
  const { data: friends } = useFriendsList('accepted');
  const createDm = useCreateOrGetDm(undefined);
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  // task-041 A-3: aggregated workspace presence for the DM peer dot.
  const { getStatus } = useDmPresence();
  // S99 (S16 carryover · MED): 데스크톱 DmShell 과 동일하게 dm:created 를 소비해
  // 새 DM·그룹 DM 개설 시 모바일 DM 목록을 즉시 갱신한다(dormant 훅 배선).
  useDmCreated();

  const norm = query.trim().toLowerCase();
  const rows = (dms?.items ?? []).filter(
    (d) => !norm || d.otherUsername.toLowerCase().includes(norm),
  );
  const friendCandidates = (friends?.items ?? []).filter(
    (f) => !norm || f.otherUsername.toLowerCase().includes(norm),
  );

  const startDm = async (otherUserId: string): Promise<void> => {
    const res = await createDm.mutateAsync({ userId: otherUserId });
    setNewOpen(false);
    navigate(`/dms/${otherUserId}?c=${res.channelId}`);
  };

  return (
    <div data-testid="mobile-dm-list" className="qf-m-screen qf-m-screen--app">
      <header className="qf-m-topbar qf-m-safe-top">
        <div />
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">다이렉트 메시지</div>
        </div>
        <div className="qf-m-topbar__actions">
          <button type="button" className="qf-m-topbar__action" aria-label="검색">
            <Icon name="search" size="md" />
          </button>
        </div>
      </header>

      <main className="qf-m-body">
        <div className="px-[var(--s-4)] pt-[var(--s-2)]">
          <div className="qf-m-search" data-testid="mobile-dm-search">
            <Icon name="search" size="sm" />
            <input
              type="search"
              className="qf-m-search__input"
              aria-label="다이렉트 메시지 검색"
              placeholder="DM 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="mobile-dm-search-input"
            />
          </div>
        </div>

        <div className="qf-m-section">
          <div>All</div>
        </div>

        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="qf-m-empty" data-testid="mobile-dm-empty">
            <div className="qf-m-empty__title">DM이 아직 없습니다</div>
            <div className="qf-m-empty__body">우측 하단 버튼으로 멤버와 대화를 시작하세요.</div>
          </div>
        ) : (
          rows.map((d) => {
            const muted = mutedChannelIds.has(d.channelId);
            const badge = deriveDmBadgeCount({
              unreadCount: d.unreadCount,
              muted,
              // FR-DM-15: 뮤트 DM 은 @멘션 건수만 배지로(서버 점진 롤아웃 대비 `?? 0`).
              mentionCount: d.mentionCount ?? 0,
            });
            return (
              <button
                key={d.channelId}
                type="button"
                data-testid={`mobile-dm-row-${d.otherUsername}`}
                onClick={() => navigate(`/dms/${d.otherUserId}?c=${d.channelId}`)}
                className={cn('w-full text-left qf-m-row', badge > 0 && 'qf-m-row--unread')}
              >
                <Avatar name={d.otherUsername} size="md" status={getStatus(d.otherUserId)} />
                <div className="min-w-0 flex-1">
                  <div className="qf-m-row__primary">{d.otherUsername}</div>
                  <div className="qf-m-row__secondary">
                    {d.lastMessagePreview ?? '대화를 시작하세요'}
                  </div>
                </div>
                <div className="qf-m-row__aside">
                  {d.lastMessageAt ? (
                    <span className="qf-m-row__time">{relTime(d.lastMessageAt)}</span>
                  ) : null}
                  {badge > 0 ? (
                    <span
                      data-testid={`mobile-dm-badge-${d.otherUsername}`}
                      aria-label={muted ? `멘션 ${badge}개` : `읽지 않음 ${badge}개`}
                      className="qf-badge qf-badge--count"
                    >
                      {dmBadgeText(badge)}
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </main>

      <button
        type="button"
        className="qf-m-fab"
        aria-label="새 DM"
        data-testid="mobile-dm-fab-new"
        onClick={() => setNewOpen(true)}
      >
        <Icon name="edit" size="md" />
      </button>

      <MobileTabBar
        active="home"
        onHome={() => navigate('/')}
        onSettings={() => navigate('/settings')}
        onActivity={() => navigate('/activity')}
      />

      {newOpen ? (
        <div
          data-testid="mobile-dm-new-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="새 다이렉트 메시지"
          className="fixed inset-0 z-[var(--z-modal,60)]"
        >
          <div className="qf-m-sheet-backdrop absolute inset-0" onClick={() => setNewOpen(false)} />
          {/* H-1(071-M0 C2): 백드롭(z=60) 아래 깔리던 시트를 --z-modal(61)로 올린다. */}
          <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]">
            <div className="qf-m-sheet__grab" aria-hidden />
            <div className="px-[var(--s-4)] pb-[var(--s-2)]">
              <div className="qf-m-search">
                <Icon name="search" size="sm" />
                <input
                  type="search"
                  className="qf-m-search__input"
                  aria-label="새 다이렉트 메시지 멤버 검색"
                  placeholder="멤버 검색"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                  data-testid="mobile-dm-new-search-input"
                />
              </div>
            </div>
            <ul role="list" className="max-h-[50vh] overflow-y-auto">
              {friendCandidates.length === 0 ? (
                <li>
                  <div className="qf-m-empty">
                    <div className="qf-m-empty__title">친구가 없습니다</div>
                    <div className="qf-m-empty__body">
                      먼저 /friends 에서 친구 요청을 보내주세요.
                    </div>
                  </div>
                </li>
              ) : (
                friendCandidates.map((f) => (
                  <li key={f.otherUserId}>
                    <button
                      type="button"
                      data-testid={`mobile-dm-new-candidate-${f.otherUsername}`}
                      className="w-full text-left qf-m-row"
                      onClick={() => startDm(f.otherUserId)}
                    >
                      <Avatar name={f.otherUsername} size="sm" status={getStatus(f.otherUserId)} />
                      <div className="min-w-0 flex-1">
                        <div className="qf-m-row__primary">{f.otherUsername}</div>
                        <div className="qf-m-row__secondary">친구</div>
                      </div>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간`;
  const days = Math.floor(hours / 24);
  return `${days}일`;
}
