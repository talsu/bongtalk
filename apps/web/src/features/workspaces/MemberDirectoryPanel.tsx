import { useEffect, useMemo, useState } from 'react';
import {
  BULK_MEMBER_ACTION_MAX,
  TIMEOUT_DURATION_PRESETS,
  type BulkMemberAction,
  type MemberDirectoryRow,
  type MemberDirectorySort,
  type WorkspaceRole,
} from '@qufox/shared-types';
import { Avatar, Button, Dialog, Icon } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useBulkMemberAction, useMembersDirectory } from './useWorkspaces';
import { MemberProfilePanel } from './MemberProfilePanel';

type Props = {
  workspaceId: string;
  /** 현재 사용자 id — 일괄 선택에서 자기 자신을 제외하는 데 쓴다. */
  currentUserId: string | null;
  /** FR-W11 관리 액션(역할변경/kick/timeout) 노출 여부(ADMIN+/MODERATOR). 일반 멤버는 false. */
  canManage: boolean;
};

const ROLE_FILTERS: Array<{ value: WorkspaceRole | ''; label: string }> = [
  { value: '', label: '전체 역할' },
  { value: 'OWNER', label: '소유자' },
  { value: 'ADMIN', label: '관리자' },
  { value: 'MODERATOR', label: '모더레이터' },
  { value: 'MEMBER', label: '멤버' },
  { value: 'GUEST', label: '게스트' },
];

const SORT_OPTIONS: Array<{ value: MemberDirectorySort; label: string }> = [
  { value: 'joined_desc', label: '최근 가입순' },
  { value: 'joined_asc', label: '오래된 가입순' },
];

type BulkKind = BulkMemberAction | null;

/**
 * S69 (D13 / FR-W10·W11): 멤버 디렉터리 패널.
 *  - 검색(디바운스) · 역할 필터 · 가입일 정렬 · 커서 페이지네이션(서버 API 직접 — Fork D).
 *  - 모든 멤버 열람(Fork C). 관리 액션(역할변경/kick/timeout)은 canManage 일 때만 노출.
 *  - 체크박스 다중 선택 + 일괄 액션(최대 100명). 위험 액션은 alertDialog 확인.
 *  - 멤버 클릭 → 프로필 패널(역할/상태/가입일/초대자).
 */
export function MemberDirectoryPanel({
  workspaceId,
  currentUserId,
  canManage,
}: Props): JSX.Element {
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [role, setRole] = useState<WorkspaceRole | ''>('');
  const [sortBy, setSortBy] = useState<MemberDirectorySort>('joined_desc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profile, setProfile] = useState<MemberDirectoryRow | null>(null);
  const [bulk, setBulk] = useState<BulkKind>(null);
  const [bulkRole, setBulkRole] = useState<'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST'>('MEMBER');
  const [bulkDuration, setBulkDuration] = useState<number>(
    TIMEOUT_DURATION_PRESETS[3]?.seconds ?? 3600,
  );

  const notify = useNotifications((s) => s.push);
  const bulkMut = useBulkMemberAction(workspaceId);

  // 검색 디바운스(300ms) — 빠른 타이핑 중 쿼리 키가 안정적이게 유지한다.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(rawQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [rawQuery]);

  const query = useMembersDirectory(workspaceId, {
    q: debouncedQuery || undefined,
    role: role || undefined,
    sortBy,
  });

  const members = useMemo<MemberDirectoryRow[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.members),
    [query.data],
  );

  // 필터/검색 변경 시 선택 초기화(목록이 바뀌면 선택 무효).
  useEffect(() => {
    setSelected(new Set());
  }, [debouncedQuery, role, sortBy]);

  const toggleSelect = (userId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else if (next.size < BULK_MEMBER_ACTION_MAX) next.add(userId);
      return next;
    });
  };

  // 일괄 선택 대상은 자기 자신/OWNER 를 제외(서버도 skipped 처리하지만 UX 상 미리 제외).
  const selectableIds = useMemo(
    () =>
      members.filter((m) => m.role !== 'OWNER' && m.userId !== currentUserId).map((m) => m.userId),
    [members, currentUserId],
  );

  const closeBulk = (): void => setBulk(null);

  const runBulk = async (): Promise<void> => {
    if (!bulk) return;
    const userIds = [...selected];
    try {
      const res = await bulkMut.mutateAsync({
        action: bulk,
        userIds,
        durationSeconds: bulk === 'timeout' ? bulkDuration : undefined,
        role: bulk === 'role' ? bulkRole : undefined,
      });
      notify({
        variant: res.skipped.length > 0 ? 'info' : 'success',
        title: '일괄 작업 완료',
        body: `${res.affected.length}명 적용, ${res.skipped.length}명 건너뜀`,
      });
      setSelected(new Set());
      closeBulk();
    } catch (err) {
      notify({ variant: 'danger', title: '일괄 작업 실패', body: (err as Error).message });
    }
  };

  return (
    <section data-testid="member-directory-panel" className="flex h-full flex-col gap-[var(--s-3)]">
      {/* 검색 + 필터 + 정렬 */}
      <div className="flex flex-wrap items-center gap-[var(--s-2)]">
        <label className="sr-only" htmlFor="member-directory-search">
          멤버 검색
        </label>
        <div className="relative min-w-0 flex-1">
          <Icon
            name="search"
            size="sm"
            className="pointer-events-none absolute left-[var(--s-2)] top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            id="member-directory-search"
            type="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="이름 또는 이메일로 검색"
            className="qf-input w-full pl-[var(--s-7)]"
          />
        </div>
        <label className="sr-only" htmlFor="member-directory-role">
          역할 필터
        </label>
        <select
          id="member-directory-role"
          aria-label="역할 필터"
          value={role}
          onChange={(e) => setRole(e.target.value as WorkspaceRole | '')}
          className="qf-input h-9 w-auto px-[var(--s-2)] text-[length:var(--fs-13)]"
        >
          {ROLE_FILTERS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="member-directory-sort">
          가입일 정렬
        </label>
        <select
          id="member-directory-sort"
          aria-label="가입일 정렬"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as MemberDirectorySort)}
          className="qf-input h-9 w-auto px-[var(--s-2)] text-[length:var(--fs-13)]"
        >
          {SORT_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* 일괄 액션 바(관리자 + 선택 있을 때) */}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-[var(--s-2)]" data-testid="bulk-action-bar">
          <span aria-live="polite" className="text-[length:var(--fs-12)] text-text-muted">
            {selected.size > 0 ? `${selected.size}명 선택됨` : '선택된 멤버 없음'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectableIds.length === 0}
            onClick={() =>
              setSelected((prev) =>
                prev.size === selectableIds.length ? new Set() : new Set(selectableIds),
              )
            }
          >
            {selected.size === selectableIds.length && selectableIds.length > 0
              ? '전체 해제'
              : '전체 선택'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setBulk('role')}
          >
            역할 변경
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setBulk('timeout')}
          >
            타임아웃
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setBulk('kick')}
          >
            강제 퇴장
          </Button>
        </div>
      ) : null}

      {/* 결과 라이브 영역 + 목록 */}
      <p aria-live="polite" className="sr-only">
        {query.isLoading ? '멤버를 불러오는 중' : `멤버 ${members.length}명`}
      </p>
      <ul
        data-testid="member-directory-list"
        aria-label="멤버 디렉터리"
        className="flex-1 overflow-y-auto"
      >
        {members.map((m) => {
          const checkboxId = `member-select-${m.userId}`;
          const isSelectable = m.role !== 'OWNER' && m.userId !== currentUserId;
          return (
            <li
              key={m.userId}
              data-testid={`directory-row-${m.user.username}`}
              className="flex items-center gap-[var(--s-2)] py-[var(--s-2)]"
            >
              {canManage && isSelectable ? (
                <input
                  id={checkboxId}
                  type="checkbox"
                  aria-label={`${m.user.username} 선택`}
                  checked={selected.has(m.userId)}
                  onChange={() => toggleSelect(m.userId)}
                />
              ) : (
                <span className="w-[var(--s-4)]" aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() => setProfile(m)}
                className="flex min-w-0 flex-1 items-center gap-[var(--s-2)] text-left"
              >
                <Avatar name={m.user.username} size="sm" status={m.status} />
                <span className="min-w-0 truncate text-foreground">{m.user.username}</span>
                {m.mutedUntil ? (
                  <span className="flex shrink-0 items-center gap-[var(--s-1)] text-text-strong">
                    <Icon name="bell-off" size="sm" />
                  </span>
                ) : null}
              </button>
              <span className="shrink-0 text-[length:var(--fs-12)] text-text-muted">{m.role}</span>
            </li>
          );
        })}
      </ul>

      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '불러오는 중…' : '더 보기'}
        </Button>
      ) : null}

      {/* 프로필 패널(클릭 시) */}
      {profile ? (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) setProfile(null);
          }}
          title="멤버 프로필"
        >
          <MemberProfilePanel member={profile} onClose={() => setProfile(null)} />
        </Dialog>
      ) : null}

      {/* 일괄 액션 확인(위험 액션은 alertDialog) */}
      {bulk ? (
        <Dialog
          open
          onOpenChange={(v) => {
            if (!v) closeBulk();
          }}
          alertDialog={bulk === 'kick'}
          title={
            bulk === 'kick'
              ? '멤버 일괄 퇴장'
              : bulk === 'timeout'
                ? '멤버 일괄 타임아웃'
                : '역할 일괄 변경'
          }
          description={`선택한 ${selected.size}명에게 적용합니다.`}
        >
          {bulk === 'role' ? (
            <div className="mb-[var(--s-3)]">
              <label className="sr-only" htmlFor="bulk-role-select">
                변경할 역할
              </label>
              <select
                id="bulk-role-select"
                value={bulkRole}
                onChange={(e) =>
                  setBulkRole(e.target.value as 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST')
                }
                className="qf-input w-full"
              >
                <option value="ADMIN">관리자</option>
                <option value="MODERATOR">모더레이터</option>
                <option value="MEMBER">멤버</option>
                <option value="GUEST">게스트</option>
              </select>
            </div>
          ) : null}
          {bulk === 'timeout' ? (
            <div className="mb-[var(--s-3)]">
              <label className="sr-only" htmlFor="bulk-timeout-select">
                타임아웃 기간
              </label>
              <select
                id="bulk-timeout-select"
                value={bulkDuration}
                onChange={(e) => setBulkDuration(Number(e.target.value))}
                className="qf-input w-full"
              >
                {TIMEOUT_DURATION_PRESETS.map((p) => (
                  <option key={p.seconds} value={p.seconds}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex justify-end gap-[var(--s-2)]">
            <Button type="button" variant="ghost" onClick={closeBulk}>
              취소
            </Button>
            <Button
              type="button"
              variant={bulk === 'kick' ? 'danger' : 'primary'}
              disabled={bulkMut.isPending}
              onClick={runBulk}
            >
              확인
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
