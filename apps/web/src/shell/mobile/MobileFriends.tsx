import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Icon } from '../../design-system/primitives';
import {
  useAcceptFriend,
  useBlockUser,
  useFriendsList,
  useRejectFriend,
  useRemoveFriend,
  useRequestFriend,
  useUnblockUser,
  type FriendsFilter,
} from '../../features/friends/useFriends';
import { MobileTabBar } from './MobileTabBar';

/**
 * task-032-D: mobile /friends — qf-m-screen + qf-m-segment 4 + qf-m-row
 * per friend + qf-m-fab "친구 추가" sheet. Actions inline on each row.
 */
export function MobileFriends(): JSX.Element {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FriendsFilter>('accepted');
  const { data, isLoading } = useFriendsList(filter);
  const accept = useAcceptFriend();
  const reject = useRejectFriend();
  const remove = useRemoveFriend();
  const block = useBlockUser();
  const unblock = useUnblockUser();
  const requestFriend = useRequestFriend();
  const [addOpen, setAddOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const onRequest = async (): Promise<void> => {
    setErr(null);
    try {
      await requestFriend.mutateAsync({ username });
      setUsername('');
      setAddOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const items = data?.items ?? [];

  return (
    <div data-testid="mobile-friends" className="qf-m-screen">
      <header className="qf-m-topbar qf-m-safe-top">
        <button
          type="button"
          aria-label="뒤로"
          className="qf-m-topbar__back"
          onClick={() => navigate(-1)}
          data-testid="mobile-friends-back"
        >
          <Icon name="chevron-left" size="md" />
        </button>
        <div className="qf-m-topbar__titleBlock">
          <div className="qf-m-topbar__title">친구</div>
          <div className="qf-m-topbar__subtitle">
            {items.length}
            {filter === 'accepted' ? '명' : ''}
          </div>
        </div>
        <div />
      </header>

      <main className="qf-m-body">
        <div
          className="qf-m-segment"
          data-testid="mobile-friends-segment"
          style={{ overflowX: 'auto' }}
        >
          {(
            [
              { id: 'accepted', label: '모든' },
              { id: 'pending_incoming', label: '받음' },
              { id: 'pending_outgoing', label: '보냄' },
              { id: 'blocked', label: '차단' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              className="qf-m-segment__btn"
              aria-selected={filter === t.id}
              data-testid={`mobile-friends-tab-${t.id}`}
              onClick={() => setFilter(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : items.length === 0 ? (
          <div className="qf-m-empty" data-testid="mobile-friends-empty">
            <div className="qf-m-empty__title">목록이 비어있습니다</div>
          </div>
        ) : (
          items.map((row) => (
            <div
              key={row.friendshipId}
              data-testid={`mobile-friend-row-${row.otherUsername}`}
              data-status={row.status}
              className="qf-m-row"
            >
              <Avatar name={row.otherUsername} size="md" />
              <div className="min-w-0 flex-1">
                <div className="qf-m-row__primary">{row.otherUsername}</div>
                <div className="qf-m-row__secondary">
                  {row.status === 'ACCEPTED'
                    ? '친구'
                    : row.status === 'PENDING' && row.direction === 'incoming'
                      ? '요청 받음'
                      : row.status === 'PENDING'
                        ? '요청 보냄'
                        : '차단됨'}
                </div>
              </div>
              <div className="qf-m-row__aside flex flex-row gap-[var(--s-2)]">
                {row.status === 'PENDING' && row.direction === 'incoming' ? (
                  <>
                    <button
                      type="button"
                      data-testid={`mobile-friend-accept-${row.otherUsername}`}
                      onClick={() => accept.mutate({ friendshipId: row.friendshipId })}
                      className="qf-btn qf-btn--sm"
                    >
                      수락
                    </button>
                    <button
                      type="button"
                      data-testid={`mobile-friend-reject-${row.otherUsername}`}
                      onClick={() => reject.mutate({ friendshipId: row.friendshipId })}
                      className="qf-btn qf-btn--sm qf-btn--ghost"
                    >
                      거절
                    </button>
                  </>
                ) : null}
                {row.status === 'ACCEPTED' ? (
                  <button
                    type="button"
                    data-testid={`mobile-friend-remove-${row.otherUsername}`}
                    onClick={() => remove.mutate({ friendshipId: row.friendshipId })}
                    className="qf-btn qf-btn--sm qf-btn--ghost"
                  >
                    <Icon name="trash" size="sm" />
                  </button>
                ) : null}
                {row.status === 'BLOCKED' ? (
                  <button
                    type="button"
                    data-testid={`mobile-friend-unblock-${row.otherUsername}`}
                    onClick={() => unblock.mutate({ userId: row.otherUserId })}
                    className="qf-btn qf-btn--sm"
                  >
                    해제
                  </button>
                ) : null}
                {row.status === 'ACCEPTED' ? (
                  <button
                    type="button"
                    data-testid={`mobile-friend-block-${row.otherUsername}`}
                    onClick={() => block.mutate({ userId: row.otherUserId })}
                    className="qf-btn qf-btn--sm qf-btn--ghost"
                  >
                    차단
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </main>

      <button
        type="button"
        className="qf-m-fab"
        aria-label="친구 추가"
        data-testid="mobile-friends-fab"
        onClick={() => setAddOpen(true)}
      >
        <Icon name="user-plus" size="md" />
      </button>

      <MobileTabBar
        onHome={() => navigate('/')}
        onSettings={() => navigate('/settings/notifications')}
        onActivity={() => navigate('/activity')}
      />

      {addOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="mobile-friends-add-sheet"
          className="fixed inset-0 z-[var(--z-modal,60)]"
        >
          <div className="qf-m-sheet-backdrop absolute inset-0" onClick={() => setAddOpen(false)} />
          <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0 p-[var(--s-4)]">
            <div className="qf-m-sheet__grab" aria-hidden />
            <div className="font-semibold mb-[var(--s-2)]">친구 추가</div>
            <input
              type="text"
              data-testid="mobile-friends-add-username"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="qf-input w-full"
              autoFocus
            />
            {err ? <p className="qf-field__error mt-[var(--s-2)]">{err}</p> : null}
            <div className="flex gap-[var(--s-2)] mt-[var(--s-3)] justify-end">
              <button
                type="button"
                className="qf-btn qf-btn--ghost"
                onClick={() => setAddOpen(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="qf-btn qf-btn--primary"
                data-testid="mobile-friends-add-submit"
                onClick={onRequest}
                disabled={!username}
              >
                요청 보내기
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
