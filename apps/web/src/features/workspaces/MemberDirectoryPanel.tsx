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
import { ModerationActions } from './ModerationActions';
import { ROLE_LABEL, STATUS_LABEL } from './memberLabels';

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
  // S69 fix-forward (a11y B-02): 일괄 액션 결과를 Dialog 내 assertive 라이브 영역으로도
  // announce 한다(토스트만으로는 스크린리더에 즉시 전달되지 않을 수 있음).
  const [bulkResult, setBulkResult] = useState<string>('');

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

  const closeBulk = (): void => {
    setBulk(null);
    setBulkResult('');
  };

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
      const summary = `${res.affected.length}명 적용, ${res.skipped.length}명 건너뜀`;
      notify({
        variant: res.skipped.length > 0 ? 'info' : 'success',
        title: '일괄 작업 완료',
        body: summary,
      });
      setBulkResult(`일괄 작업 완료: ${summary}`);
      setSelected(new Set());
      closeBulk();
    } catch (err) {
      const message = (err as Error).message;
      notify({ variant: 'danger', title: '일괄 작업 실패', body: message });
      setBulkResult(`일괄 작업 실패: ${message}`);
    }
  };

  return (
    <section data-testid="member-directory-panel" className="flex h-full flex-col gap-[var(--s-3)]">
      {/* S69 fix-forward (a11y M-01): 패널 제목(시각적으로는 숨김 — 스크린리더 컨텍스트). */}
      <h2 className="sr-only">멤버 디렉터리</h2>
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
          <span
            aria-live="polite"
            // S69 fix-forward (a11y M-06): 카운트 전체를 한 번에 읽도록 atomic.
            aria-atomic="true"
            className="text-[length:var(--fs-12)] text-text-muted"
          >
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
      {/* S69 fix-forward (a11y N-03): 디바운스 대기(rawQuery!==debouncedQuery)·로딩 중에는
          "검색 중…" 으로, 그 외에는 결과 수를 announce 한다. */}
      <p aria-live="polite" className="sr-only">
        {rawQuery.trim() !== debouncedQuery || query.isLoading
          ? '멤버를 검색 중…'
          : `멤버 ${members.length}명`}
      </p>
      <ul
        data-testid="member-directory-list"
        aria-label="멤버 디렉터리"
        // S69 fix-forward (a11y M-02): 로딩 중 목록 busy 표시.
        aria-busy={query.isLoading}
        className="flex-1 overflow-y-auto"
      >
        {members.map((m) => {
          const checkboxId = `member-select-${m.userId}`;
          const isSelectable = m.role !== 'OWNER' && m.userId !== currentUserId;
          const statusLabel = STATUS_LABEL[m.status] ?? m.status;
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
                // S69 fix-forward (a11y H-02): Avatar 가 aria-hidden 이라 상태 도트가
                // 스크린리더에 누락된다 — 버튼 접근가능 이름에 username + 상태를 함께 싣는다.
                aria-label={`${m.user.username}, ${statusLabel}`}
                className="flex min-w-0 flex-1 items-center gap-[var(--s-2)] text-left"
              >
                <Avatar name={m.user.username} size="sm" status={m.status} />
                <span className="min-w-0 truncate text-foreground">{m.user.username}</span>
                {m.mutedUntil ? (
                  <span className="flex shrink-0 items-center gap-[var(--s-1)] text-text-strong">
                    {/* S69 fix-forward (a11y H-03): 아이콘 의미를 sr-only 텍스트로 보강. */}
                    <Icon name="bell-off" size="sm" aria-hidden="true" />
                    <span className="sr-only">타임아웃 중</span>
                  </span>
                ) : null}
              </button>
              {/* S69 fix-forward (a11y N-01): 영문 enum → 한글 역할 라벨. */}
              <span className="shrink-0 text-[length:var(--fs-12)] text-text-muted">
                {ROLE_LABEL[m.role] ?? m.role}
              </span>
            </li>
          );
        })}
        {/* S69 fix-forward (a11y M-03/ui LOW): 빈 상태(로딩 아님) 안내 행. */}
        {members.length === 0 && !query.isLoading ? (
          <li className="py-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
            일치하는 멤버가 없습니다.
          </li>
        ) : null}
      </ul>

      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={query.isFetchingNextPage}
          // S69 fix-forward (a11y M-05): 다음 페이지 로딩 중 busy 표시.
          aria-busy={query.isFetchingNextPage}
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
          {/* 071-M5 H19 (감사 B-73 잔여): Ban 진입 동선 — 데스크톱 정본은
              WorkspaceMembersModal 의 ModerationActions(음소거/퇴장/차단)인데, 해당 모달은
              ChannelColumn(데스크톱) 전용이라 모바일에서 Ban 도달 경로가 없었다. 디렉터리
              일괄 액션의 서버 enum(BULK_MEMBER_ACTIONS = kick/timeout/role)에도 ban 이
              없으므로, 프로필 다이얼로그에 정본 컴포넌트를 그대로 재사용해 멤버 단위
              모더레이션(차단 포함)을 양 플랫폼 공통으로 노출한다(권한자, OWNER/본인 제외). */}
          {canManage && profile.role !== 'OWNER' && profile.userId !== currentUserId ? (
            <div
              data-testid="directory-profile-moderation"
              className="mt-[var(--s-3)] flex justify-end"
            >
              <ModerationActions
                workspaceId={workspaceId}
                targetUserId={profile.userId}
                targetUsername={profile.user.username}
              />
            </div>
          ) : null}
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
          // S69 fix-forward (a11y H-04): kick 은 되돌릴 수 없는 위험 액션임을 명시한다.
          description={
            bulk === 'kick'
              ? `선택한 ${selected.size}명을 강제 퇴장합니다. 이 작업은 되돌릴 수 없습니다.`
              : `선택한 ${selected.size}명에게 적용합니다.`
          }
        >
          {/* S69 fix-forward (a11y B-02): 결과를 Dialog 내 assertive 라이브 영역으로 announce. */}
          <p aria-live="assertive" className="sr-only">
            {bulkResult}
          </p>
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
              // S69 fix-forward (a11y B-02): 실행 중 busy 표시.
              aria-busy={bulkMut.isPending}
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
