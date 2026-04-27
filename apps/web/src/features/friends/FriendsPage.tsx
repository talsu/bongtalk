import { useState } from 'react';
import { Avatar, Button, Icon } from '../../design-system/primitives';
import {
  useAcceptFriend,
  useBlockUser,
  useFriendsList,
  useRejectFriend,
  useRemoveFriend,
  useRequestFriend,
  useUnblockUser,
  type FriendRow,
  type FriendsFilter,
} from './useFriends';

/**
 * task-032-C: desktop /friends — qf-tabs 4 filters + qf-m-row list +
 * 친구 추가 modal with username input + per-row actions.
 */
export function FriendsPage(): JSX.Element {
  const [filter, setFilter] = useState<FriendsFilter>('accepted');
  const { data, isLoading } = useFriendsList(filter);
  const accept = useAcceptFriend();
  const reject = useRejectFriend();
  const remove = useRemoveFriend();
  const block = useBlockUser();
  const unblock = useUnblockUser();
  const requestFriend = useRequestFriend();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const onRequest = async (): Promise<void> => {
    setErr(null);
    try {
      await requestFriend.mutateAsync({ username });
      setUsername('');
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const items = data?.items ?? [];

  return (
    <div
      data-testid="friends-page"
      className="h-screen flex flex-col"
      style={{ background: 'var(--bg-app)' }}
    >
      <header className="flex items-center gap-[var(--s-3)] px-[var(--s-6)] h-[var(--h-topbar)] border-b border-border-subtle">
        <Icon name="users" size="md" />
        <div className="font-semibold text-[length:var(--fs-16)]">친구</div>
        <div className="ml-auto">
          <Button data-testid="friends-add-btn" onClick={() => setOpen(true)}>
            친구 추가
          </Button>
        </div>
      </header>
      <nav className="qf-tabs px-[var(--s-6)]" data-testid="friends-tabs">
        {(
          [
            { id: 'accepted', label: '모든' },
            { id: 'pending_incoming', label: '대기중 (받음)' },
            { id: 'pending_outgoing', label: '대기중 (보냄)' },
            { id: 'blocked', label: '차단됨' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={`friends-tab-${t.id}`}
            aria-selected={filter === t.id}
            className="qf-tabs__item"
            onClick={() => setFilter(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="flex-1 overflow-y-auto" data-testid="friends-list">
        {isLoading ? (
          <div className="p-[var(--s-6)] text-text-muted">불러오는 중…</div>
        ) : items.length === 0 ? (
          <div className="qf-empty p-[var(--s-6)]">
            <div className="font-semibold">목록이 비어있습니다</div>
          </div>
        ) : (
          items.map((row) => (
            <FriendRowComponent
              key={row.friendshipId}
              row={row}
              onAccept={() => accept.mutate({ friendshipId: row.friendshipId })}
              onReject={() => reject.mutate({ friendshipId: row.friendshipId })}
              onRemove={() => remove.mutate({ friendshipId: row.friendshipId })}
              onBlock={() => block.mutate({ userId: row.otherUserId })}
              onUnblock={() => unblock.mutate({ userId: row.otherUserId })}
            />
          ))
        )}
      </main>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="friends-add-dialog"
          className="fixed inset-0 z-[var(--z-modal,60)] grid place-items-center"
          style={{ background: 'color-mix(in oklab, var(--bg-app) 60%, transparent)' }}
        >
          <div
            className="bg-bg-subtle rounded-[var(--r-lg)] p-[var(--s-5)] w-[min(420px,92vw)]"
            style={{ boxShadow: 'var(--elev-3)' }}
          >
            <div className="font-semibold mb-[var(--s-3)]">친구 추가</div>
            <input
              type="text"
              data-testid="friends-add-username"
              aria-label="추가할 친구의 사용자 이름"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="qf-input w-full"
              autoFocus
            />
            {err ? <p className="qf-field__error mt-[var(--s-2)]">{err}</p> : null}
            <div className="flex gap-[var(--s-2)] mt-[var(--s-4)] justify-end">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                취소
              </Button>
              <Button data-testid="friends-add-submit" onClick={onRequest} disabled={!username}>
                요청 보내기
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FriendRowComponent({
  row,
  onAccept,
  onReject,
  onRemove,
  onBlock,
  onUnblock,
}: {
  row: FriendRow;
  onAccept: () => void;
  onReject: () => void;
  onRemove: () => void;
  onBlock: () => void;
  onUnblock: () => void;
}): JSX.Element {
  return (
    <div
      data-testid={`friend-row-${row.otherUsername}`}
      data-status={row.status}
      data-direction={row.direction}
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
      <div className="flex gap-[var(--s-2)]">
        {row.status === 'PENDING' && row.direction === 'incoming' ? (
          <>
            <Button size="sm" data-testid={`friend-accept-${row.otherUsername}`} onClick={onAccept}>
              수락
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`friend-reject-${row.otherUsername}`}
              onClick={onReject}
            >
              거절
            </Button>
          </>
        ) : null}
        {row.status === 'ACCEPTED' ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`friend-remove-${row.otherUsername}`}
              onClick={onRemove}
            >
              삭제
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`friend-block-${row.otherUsername}`}
              onClick={onBlock}
            >
              차단
            </Button>
          </>
        ) : null}
        {row.status === 'BLOCKED' ? (
          <Button size="sm" data-testid={`friend-unblock-${row.otherUsername}`} onClick={onUnblock}>
            차단 해제
          </Button>
        ) : null}
      </div>
    </div>
  );
}
