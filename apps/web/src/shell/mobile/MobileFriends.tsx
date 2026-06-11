import { useRef, useState } from 'react';
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
import { MobileConfirmSheet } from './MobileConfirmSheet';
import { MobileTabBar } from './MobileTabBar';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

/** 071-M5 H5: 파괴적 액션 confirm 대상(삭제=friendshipId, 차단=userId). */
type FriendConfirm =
  | { kind: 'remove'; friendshipId: string; username: string }
  | { kind: 'block'; userId: string; username: string };

/**
 * task-032-D: mobile /friends — qf-m-screen + qf-m-segment 4 + qf-m-row
 * per friend + qf-m-fab "친구 추가" sheet. Actions inline on each row.
 * 071-M5 H5 (감사 A-30 / FR-IA-A11Y-01): 삭제/차단 즉발 → MobileConfirmSheet.
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
  const [confirm, setConfirm] = useState<FriendConfirm | null>(null);

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
    <div data-testid="mobile-friends" className="qf-m-screen qf-m-screen--app">
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
              // 071-M5 H9 (감사 H-11): 단독 segment 라벨 '모든' → '전체'(데스크톱 FriendsPage 동기).
              { id: 'accepted', label: '전체' },
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
                    aria-label={`${row.otherUsername} 친구 삭제`}
                    onClick={() =>
                      // 071-M5 H5: 즉발 mutate 제거 — confirm 시트에서만 확정.
                      setConfirm({
                        kind: 'remove',
                        friendshipId: row.friendshipId,
                        username: row.otherUsername,
                      })
                    }
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
                    onClick={() =>
                      // 071-M5 H5: 즉발 mutate 제거 — confirm 시트에서만 확정.
                      setConfirm({
                        kind: 'block',
                        userId: row.otherUserId,
                        username: row.otherUsername,
                      })
                    }
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

      <MobileTabBar />

      {addOpen ? (
        <AddFriendSheet
          username={username}
          onUsernameChange={setUsername}
          err={err}
          onSubmit={() => void onRequest()}
          onClose={() => setAddOpen(false)}
        />
      ) : null}

      {/* 071-M5 H5 (FR-IA-A11Y-01): 삭제/차단 파괴적 확인 — 공용 alertdialog
          바텀시트(취소 첫 포커스 + 트랩 + back 마커). 확정 시에만 mutate. */}
      {confirm ? (
        <MobileConfirmSheet
          testId={
            confirm.kind === 'remove'
              ? 'mobile-friend-remove-confirm'
              : 'mobile-friend-block-confirm'
          }
          title={
            confirm.kind === 'remove'
              ? `${confirm.username}님을 친구에서 삭제할까요?`
              : `${confirm.username}님을 차단할까요?`
          }
          body={
            confirm.kind === 'remove'
              ? '다시 추가하려면 새 친구 요청이 필요합니다.'
              : '차단하면 친구에서 제거되고 서로 메시지를 보낼 수 없습니다. 차단 탭에서 해제할 수 있습니다.'
          }
          confirmLabel={confirm.kind === 'remove' ? '삭제' : '차단'}
          confirmIcon={confirm.kind === 'remove' ? 'trash' : 'shield'}
          onConfirm={() => {
            if (confirm.kind === 'remove') remove.mutate({ friendshipId: confirm.friendshipId });
            else block.mutate({ userId: confirm.userId });
            setConfirm(null);
          }}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 071-M5 H4 (감사 A-30): 친구 추가 시트 — 종전 인라인 JSX 는 aria-modal/autoFocus 만
 * 있고 accessible name(헤딩 미연결)·트랩·Esc·복귀·back 마커가 없었다. 트랩 훅
 * (마운트 1회)을 쓰기 위해 조건부 마운트 컴포넌트로 분리하고, '친구 추가' 헤딩을
 * aria-labelledby 로 연결하며 autoFocus 속성은 훅 initialFocus 로 일원화한다.
 */
function AddFriendSheet({
  username,
  onUsernameChange,
  err,
  onSubmit,
  onClose,
}: {
  username: string;
  onUsernameChange: (_v: string) => void;
  err: string | null;
  onSubmit: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useSheetFocusTrap(panelRef, onClose, { initialFocus: () => inputRef.current });
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-friends-add-title"
      data-testid="mobile-friends-add-sheet"
      className="fixed inset-0 z-[var(--z-modal,60)]"
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      {/* H-1(071-M0 C2): 백드롭(z=60) 아래 깔리던 시트를 --z-modal(61)로 올린다. */}
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)] p-[var(--s-4)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        <div id="mobile-friends-add-title" className="font-semibold mb-[var(--s-2)]">
          친구 추가
        </div>
        <input
          ref={inputRef}
          type="text"
          data-testid="mobile-friends-add-username"
          aria-label="추가할 친구의 사용자 이름"
          // 071-M5 H9 (감사 H-11): placeholder 영문 잔재 'username' → '사용자명'.
          placeholder="사용자명"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          className="qf-input w-full"
        />
        {err ? <p className="qf-field__error mt-[var(--s-2)]">{err}</p> : null}
        <div className="flex gap-[var(--s-2)] mt-[var(--s-3)] justify-end">
          <button type="button" className="qf-btn qf-btn--ghost" onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="qf-btn qf-btn--primary"
            data-testid="mobile-friends-add-submit"
            onClick={onSubmit}
            disabled={!username}
          >
            요청 보내기
          </button>
        </div>
      </div>
    </div>
  );
}
