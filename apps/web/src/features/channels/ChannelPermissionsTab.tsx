import { useMemo, useRef, useState } from 'react';
import {
  resolveMemberDisplayName,
  type ChannelPermissionOverride,
  type Role,
} from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { useNotifications } from '../../stores/notification-store';
import { useMembers, useRoles } from '../workspaces/useWorkspaces';
import { useChannelPermissions, useUpsertChannelOverride } from './useChannelPermissions';
import {
  CHANNEL_PERMISSION_CATALOG,
  applyTriState,
  bitTriState,
  nextTriState,
  parseMaskToNumber,
  type TriState,
} from './channelPermissionCatalog';

type SystemRoleLiteral = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
const SYSTEM_ROLES: SystemRoleLiteral[] = ['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER', 'GUEST'];

/**
 * S62 (FR-RM14): 채널 권한 오버라이드 섹션. 역할(ROLE 프린시펄)을 골라 각 집행 권한
 * 비트를 ALLOW(초록)/DENY(빨강)/INHERIT(회색) 3-state 로 토글한다. 저장 시 서버가
 * 캐시 DEL(≤300ms) 후 재계산하며, 목록 쿼리를 invalidate 해 최신 상태를 다시 받는다.
 *
 * 072 백로그 S-J (FR-RM14): 멤버별(USER 프린시펄) 오버라이드 편집을 추가한다. 워크스페이스
 * 멤버를 골라 같은 3-state 토글로 개별 권한을 덮어쓰고(memberMut), 기존 USER override 는
 * "오버라이드 해제"로 행을 삭제한다(deleteMut → DELETE :chid/overrides/:id). 해제 시
 * 워크스페이스 역할 권한으로 다시 상속되며, 비공개 채널이면 접근이 회수된다.
 *
 * DS qf-* + Tailwind 토큰만 사용(raw hex/px 금지). a11y(S62 fix-forward): 역할 선택은
 * WAI-ARIA tab 패턴(화살표/Home/End 키보드 이동 · 비활성 탭 tabIndex=-1 · tab↔tabpanel
 * id/aria-labelledby 연결, S61 WorkspaceSettingsPage 패턴). 3-state 토글은 aria-pressed
 * 대신 현재/다음 상태를 명시한 aria-label + 권한 설명 aria-describedby. 저장 중 status
 * live region. 멤버 선택 select 는 라벨(htmlFor) + aria-label.
 *
 * 현재 백엔드는 ROLE override 의 principal 로 시스템 역할 리터럴만 받는다(커스텀
 * Role UUID override 의 쓰기 경로는 후속). 그래서 본 UI 는 시스템 역할 5개의 채널
 * override 편집을 제공하고, 커스텀 Role 의 기존 override 는 읽기 표시만 한다.
 */
export function ChannelPermissionsTab({
  workspaceId,
  channelId,
}: {
  workspaceId: string;
  channelId: string;
}): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const overridesQ = useChannelPermissions(workspaceId, channelId);
  const rolesQ = useRoles(workspaceId);
  const membersQ = useMembers(workspaceId);
  const { roleMut, memberMut, deleteMut } = useUpsertChannelOverride(workspaceId, channelId);

  const [selectedRole, setSelectedRole] = useState<SystemRoleLiteral>('MEMBER');

  // S62 fix-forward (a11y B5+H3 · SC 2.1.1/4.1.2): WAI-ARIA tab 패턴 키보드 이동.
  // 화살표(←→)·Home·End 로 역할 탭을 순회하고 포커스를 옮긴다(S61 WorkspaceSettingsPage
  // 패턴 그대로). 비활성 탭은 tabIndex=-1 이라 Tab 키로는 활성 탭만 진입한다.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    const idx = SYSTEM_ROLES.indexOf(selectedRole);
    if (idx === -1) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % SYSTEM_ROLES.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + SYSTEM_ROLES.length) % SYSTEM_ROLES.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = SYSTEM_ROLES.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = SYSTEM_ROLES[nextIdx];
    setSelectedRole(next);
    tabRefs.current[next]?.focus();
  };

  // 선택 역할의 현재 저장된 (allow, deny) 마스크(없으면 0/0 = 전부 INHERIT).
  const current = useMemo(() => {
    const rows: ChannelPermissionOverride[] = overridesQ.data?.overrides ?? [];
    const row = rows.find((o) => o.principalType === 'ROLE' && o.principalId === selectedRole);
    if (!row) return { allowMask: 0, denyMask: 0 };
    return {
      allowMask: parseMaskToNumber(row.allowMask),
      denyMask: parseMaskToNumber(row.denyMask),
    };
  }, [overridesQ.data, selectedRole]);

  // 편집 중 마스크(서버 저장값으로 초기화 · 토글마다 즉시 저장).
  const [draft, setDraft] = useState<{ allowMask: number; denyMask: number } | null>(null);
  const view = draft ?? current;
  // 역할 전환 시 draft 리셋(다음 렌더의 current 를 따르도록).
  const [draftRole, setDraftRole] = useState<SystemRoleLiteral>(selectedRole);
  if (draftRole !== selectedRole) {
    setDraftRole(selectedRole);
    setDraft(null);
  }

  const onToggle = (bit: number): void => {
    const cur = bitTriState(view.allowMask, view.denyMask, bit);
    const next = nextTriState(cur);
    const updated = applyTriState(view.allowMask, view.denyMask, bit, next);
    setDraft(updated);
    roleMut.mutate(
      { role: selectedRole, allowMask: updated.allowMask, denyMask: updated.denyMask },
      {
        onError: () => {
          notify({ variant: 'danger', body: '권한 저장에 실패했어요. 다시 시도해 주세요.' });
          setDraft(null); // 실패 시 서버값으로 되돌림.
        },
      },
    );
  };

  const customRoleOverrides: { role: Role; allow: number; deny: number }[] = useMemo(() => {
    const rows: ChannelPermissionOverride[] = overridesQ.data?.overrides ?? [];
    const customRoles = (rolesQ.data ?? []).filter((r) => !r.isSystem);
    const out: { role: Role; allow: number; deny: number }[] = [];
    for (const role of customRoles) {
      const row = rows.find((o) => o.principalType === 'ROLE' && o.principalId === role.id);
      if (row) {
        out.push({
          role,
          allow: parseMaskToNumber(row.allowMask),
          deny: parseMaskToNumber(row.denyMask),
        });
      }
    }
    return out;
  }, [overridesQ.data, rolesQ.data]);

  // ===== 072 백로그 S-J (FR-RM14): 멤버별(USER) 오버라이드 =====
  // userId → 표시명 맵(override 행 라벨링용). 멤버 목록이 아직 없으면 userId 로 폴백.
  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQ.data?.members ?? []) {
      map.set(m.userId, resolveMemberDisplayName(m.user));
    }
    return map;
  }, [membersQ.data]);

  const memberOverrideRows: ChannelPermissionOverride[] = useMemo(
    () => (overridesQ.data?.overrides ?? []).filter((o) => o.principalType === 'USER'),
    [overridesQ.data],
  );

  const [selectedUserId, setSelectedUserId] = useState<string>('');
  // S-J fix-forward (review BLOCKER = SC 2.4.3 포커스 순서): 멤버 패널은 selectedUserId 가
  // 비면 언마운트되고 그 안의 "오버라이드 해제" 버튼도 사라져 키보드 포커스를 잃는다.
  // 해제 성공 후 항상 마운트돼 있는 멤버 select 로 포커스를 되돌린다.
  const memberSelectRef = useRef<HTMLSelectElement | null>(null);
  // S-J fix-forward (review HIGH = SC 4.1.3 상태 메시지): 저장/해제 진행+완료를 항상
  // 마운트된 live region 으로 알린다. 종전엔 isPending 동안만 region 을 렌더해 완료 시
  // 패널과 함께 언마운트되며 완료 안내가 SR 에 닿지 않았다(완료는 토스트로만).
  const [memberLiveMsg, setMemberLiveMsg] = useState<string>('');
  const selectedMemberOverride = useMemo(
    () => memberOverrideRows.find((o) => o.principalId === selectedUserId) ?? null,
    [memberOverrideRows, selectedUserId],
  );
  const memberCurrent = useMemo(() => {
    if (!selectedMemberOverride) return { allowMask: 0, denyMask: 0 };
    return {
      allowMask: parseMaskToNumber(selectedMemberOverride.allowMask),
      denyMask: parseMaskToNumber(selectedMemberOverride.denyMask),
    };
  }, [selectedMemberOverride]);

  const [memberDraft, setMemberDraft] = useState<{ allowMask: number; denyMask: number } | null>(
    null,
  );
  const memberView = memberDraft ?? memberCurrent;
  // 멤버 전환 시 draft 리셋(다음 렌더의 memberCurrent 를 따르도록).
  const [draftUserId, setDraftUserId] = useState<string>(selectedUserId);
  if (draftUserId !== selectedUserId) {
    setDraftUserId(selectedUserId);
    setMemberDraft(null);
  }

  const onMemberToggle = (bit: number): void => {
    if (!selectedUserId) return;
    const cur = bitTriState(memberView.allowMask, memberView.denyMask, bit);
    const next = nextTriState(cur);
    const updated = applyTriState(memberView.allowMask, memberView.denyMask, bit, next);
    setMemberDraft(updated);
    setMemberLiveMsg('저장 중…');
    memberMut.mutate(
      { userId: selectedUserId, allowMask: updated.allowMask, denyMask: updated.denyMask },
      {
        onSuccess: () => setMemberLiveMsg('멤버 권한을 저장했어요.'),
        onError: () => {
          notify({ variant: 'danger', body: '권한 저장에 실패했어요. 다시 시도해 주세요.' });
          setMemberDraft(null); // 실패 시 서버값으로 되돌림.
          setMemberLiveMsg('');
        },
      },
    );
  };

  const onRemoveMemberOverride = (): void => {
    if (!selectedMemberOverride) return;
    setMemberLiveMsg('해제 중…');
    deleteMut.mutate(selectedMemberOverride.id, {
      onSuccess: () => {
        setMemberDraft(null);
        setSelectedUserId('');
        notify({ variant: 'success', body: '멤버 오버라이드를 해제했어요.' });
        // SC 4.1.3: 완료를 항상 마운트된 live region 으로 안내(패널 언마운트와 무관).
        setMemberLiveMsg('멤버 오버라이드를 해제했어요.');
        // SC 2.4.3: 사라지는 해제 버튼 대신 안정적인 멤버 select 로 포커스 복원.
        memberSelectRef.current?.focus();
      },
      onError: () => {
        notify({ variant: 'danger', body: '오버라이드 해제에 실패했어요. 다시 시도해 주세요.' });
        setMemberLiveMsg('');
      },
    });
  };

  const selectedMemberLabel = selectedUserId
    ? (memberNameById.get(selectedUserId) ?? selectedUserId)
    : '';

  return (
    <div data-testid="channel-permissions-tab" className="flex flex-col gap-[var(--s-6)]">
      <section aria-label="역할별 오버라이드" className="flex flex-col gap-[var(--s-4)]">
        <p className="m-0 text-[length:var(--fs-13)] text-text-muted">
          역할별로 이 채널의 권한을 허용/거부로 덮어쓸 수 있어요. 설정하지 않은 항목은 워크스페이스
          역할 권한을 그대로 상속합니다.
        </p>

        {/* 역할 선택 — 시스템 역할 5개 탭(WAI-ARIA tab 패턴). */}
        <div
          role="tablist"
          aria-label="역할 선택"
          aria-orientation="horizontal"
          className="flex flex-wrap gap-[var(--s-2)]"
          data-testid="channel-perm-role-tabs"
        >
          {SYSTEM_ROLES.map((role) => {
            const active = selectedRole === role;
            return (
              <button
                key={role}
                type="button"
                role="tab"
                id={`channel-perm-tab-${role}`}
                aria-selected={active}
                aria-controls="channel-perm-panel"
                tabIndex={active ? 0 : -1}
                ref={(el) => {
                  tabRefs.current[role] = el;
                }}
                data-testid={`channel-perm-role-${role}`}
                onClick={() => setSelectedRole(role)}
                onKeyDown={onTabKeyDown}
                className={cn(
                  'rounded-md px-[var(--s-3)] py-[var(--s-1)] text-[length:var(--fs-13)]',
                  active ? 'bg-bg-accent text-foreground' : 'text-text-secondary hover:bg-bg-muted',
                )}
              >
                {role}
              </button>
            );
          })}
        </div>

        {/* S62 fix-forward (a11y M1 · SC 4.1.3): 저장 중 상태를 SR 에 알리는 live region. */}
        {roleMut.isPending ? (
          <p role="status" aria-live="polite" className="sr-only">
            저장 중…
          </p>
        ) : null}

        {/* 권한 비트 3-state 토글 — tab 에 연결된 tabpanel. */}
        <fieldset
          role="tabpanel"
          id="channel-perm-panel"
          aria-labelledby={`channel-perm-tab-${selectedRole}`}
          className="m-0 flex flex-col gap-[var(--s-1)] border-0 p-0"
        >
          <legend className="mb-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">
            {selectedRole} 역할의 채널 권한
          </legend>
          <PermissionToggleList
            allowMask={view.allowMask}
            denyMask={view.denyMask}
            disabled={roleMut.isPending || overridesQ.isLoading}
            onToggle={onToggle}
            descIdPrefix="role-perm-desc"
            toggleTestIdPrefix="channel-perm-toggle"
          />
        </fieldset>

        {/* 커스텀 Role 의 기존 override 는 읽기 표시(쓰기 경로는 후속 슬라이스). */}
        {customRoleOverrides.length > 0 ? (
          <section
            aria-label="커스텀 역할 오버라이드"
            data-testid="channel-perm-custom-roles"
            className="flex flex-col gap-[var(--s-1)]"
          >
            <h3 className="m-0 text-[length:var(--fs-12)] text-text-muted">
              커스텀 역할 오버라이드
            </h3>
            {customRoleOverrides.map(({ role, allow, deny }) => (
              <div
                key={role.id}
                className="flex items-center gap-[var(--s-2)] text-[length:var(--fs-12)] text-text-secondary"
              >
                <span
                  aria-hidden
                  className="inline-block h-[var(--s-2)] w-[var(--s-2)] rounded-full"
                  style={{ backgroundColor: role.colorHex ?? 'var(--text-muted)' }}
                />
                <span>{role.name}</span>
                <span className="text-success">+{countBits(allow)}</span>
                <span className="text-danger">-{countBits(deny)}</span>
              </div>
            ))}
          </section>
        ) : null}
      </section>

      {/* ===== 072 백로그 S-J (FR-RM14): 멤버별(USER) 오버라이드 ===== */}
      <section
        aria-label="멤버별 오버라이드"
        data-testid="channel-perm-members"
        className="flex flex-col gap-[var(--s-4)] border-t border-border-subtle pt-[var(--s-4)]"
      >
        <p className="m-0 text-[length:var(--fs-13)] text-text-muted">
          특정 멤버에게만 이 채널 권한을 덮어쓸 수 있어요. 오버라이드를 해제하면 그 멤버는 역할
          권한을 그대로 상속하며, 비공개 채널이면 접근이 회수됩니다.
        </p>

        {/* 현재 멤버 오버라이드 목록(클릭하면 편집 대상으로 선택). */}
        {memberOverrideRows.length > 0 ? (
          <ul
            aria-label="현재 멤버 오버라이드"
            data-testid="channel-perm-member-list"
            className="m-0 flex list-none flex-col gap-[var(--s-1)] p-0"
          >
            {memberOverrideRows.map((row) => {
              const allow = parseMaskToNumber(row.allowMask);
              const deny = parseMaskToNumber(row.denyMask);
              const active = row.principalId === selectedUserId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    data-testid={`channel-perm-member-row-${row.principalId}`}
                    aria-pressed={active}
                    aria-label={`${memberNameById.get(row.principalId) ?? row.principalId}, 허용 ${countBits(allow)}개, 거부 ${countBits(deny)}개${active ? ', 선택됨' : ''}`}
                    onClick={() => setSelectedUserId(row.principalId)}
                    className={cn(
                      'flex w-full items-center gap-[var(--s-2)] rounded-md px-[var(--s-2)] py-[var(--s-1)] text-left text-[length:var(--fs-13)]',
                      active
                        ? 'bg-bg-accent text-foreground'
                        : 'text-text-secondary hover:bg-bg-muted',
                    )}
                  >
                    <span className="flex-1 truncate">
                      {memberNameById.get(row.principalId) ?? row.principalId}
                    </span>
                    <span className="text-success">+{countBits(allow)}</span>
                    <span className="text-danger">-{countBits(deny)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* 멤버 선택 — 라벨(htmlFor) + aria-label. */}
        <div className="flex flex-col gap-[var(--s-1)]">
          <label
            htmlFor="ch-perm-member-select"
            className="text-[length:var(--fs-12)] text-text-muted"
          >
            멤버 선택
          </label>
          <select
            id="ch-perm-member-select"
            aria-label="오버라이드를 편집할 멤버 선택"
            data-testid="channel-perm-member-select"
            ref={memberSelectRef}
            value={selectedUserId}
            disabled={membersQ.isLoading}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="qf-input max-w-sm"
          >
            <option value="">멤버를 선택하세요…</option>
            {(membersQ.data?.members ?? []).map((m) => {
              const hasOverride = memberOverrideRows.some((o) => o.principalId === m.userId);
              const name = resolveMemberDisplayName(m.user);
              return (
                <option key={m.userId} value={m.userId}>
                  {hasOverride ? `${name} (오버라이드 있음)` : name}
                </option>
              );
            })}
          </select>
        </div>

        {/* S-J fix-forward (review HIGH · SC 4.1.3): 진행+완료 상태 live region. 항상
            마운트해 패널 언마운트(해제 성공)와 무관하게 완료 안내가 SR 에 닿게 한다. */}
        <p
          role="status"
          aria-live="polite"
          className="sr-only"
          data-testid="channel-perm-member-status"
        >
          {memberLiveMsg}
        </p>

        {/* 선택한 멤버의 권한 토글 패널. */}
        {selectedUserId ? (
          <fieldset
            data-testid="channel-perm-member-panel"
            className="m-0 flex flex-col gap-[var(--s-1)] border-0 p-0"
          >
            <legend className="mb-[var(--s-2)] flex w-full items-center justify-between gap-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">
              <span>{selectedMemberLabel} 님의 채널 권한</span>
              {selectedMemberOverride ? (
                <button
                  type="button"
                  data-testid="channel-perm-member-remove"
                  disabled={deleteMut.isPending}
                  onClick={onRemoveMemberOverride}
                  className="qf-btn qf-btn--sm qf-btn--danger"
                >
                  오버라이드 해제
                </button>
              ) : null}
            </legend>
            <PermissionToggleList
              allowMask={memberView.allowMask}
              denyMask={memberView.denyMask}
              disabled={memberMut.isPending || deleteMut.isPending || overridesQ.isLoading}
              onToggle={onMemberToggle}
              descIdPrefix="member-perm-desc"
              toggleTestIdPrefix="channel-perm-member-toggle"
            />
          </fieldset>
        ) : null}
      </section>
    </div>
  );
}

/**
 * 채널 권한 8비트 3-state 토글 목록. 역할/멤버 섹션이 공유한다. descIdPrefix/
 * toggleTestIdPrefix 로 두 섹션의 id/testid 가 충돌하지 않게 분리한다(중복 id 는
 * axe label 위반).
 */
function PermissionToggleList({
  allowMask,
  denyMask,
  disabled,
  onToggle,
  descIdPrefix,
  toggleTestIdPrefix,
}: {
  allowMask: number;
  denyMask: number;
  disabled: boolean;
  onToggle: (_bit: number) => void;
  descIdPrefix: string;
  toggleTestIdPrefix: string;
}): JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-[var(--s-1)] p-0">
      {CHANNEL_PERMISSION_CATALOG.map((p) => {
        const state = bitTriState(allowMask, denyMask, p.bit);
        const descId = `${descIdPrefix}-${p.bit}`;
        return (
          <li
            key={p.bit}
            className="flex items-center justify-between gap-[var(--s-3)] border-b border-border-subtle py-[var(--s-2)]"
          >
            <span className="flex flex-col">
              <span className="text-[length:var(--fs-14)] text-text-secondary">{p.label}</span>
              {/* S62 fix-forward (a11y M2 · SC 1.3.1): 토글이 aria-describedby 로
                  참조하는 권한 설명. id 로 프로그램적 연결. */}
              <span id={descId} className="text-[length:var(--fs-12)] text-text-muted">
                {p.description}
              </span>
            </span>
            <TriStateToggle
              label={p.label}
              state={state}
              descId={descId}
              testId={`${toggleTestIdPrefix}-${p.bit}`}
              disabled={disabled}
              onCycle={() => onToggle(p.bit)}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** TriState → 한국어 라벨. */
function triStateLabel(state: TriState): string {
  return state === 'allow' ? '허용' : state === 'deny' ? '거부' : '상속';
}

/**
 * 3-state 토글 버튼(allow/deny/inherit 순환). 상태별 색 + 테두리.
 *
 * S62 fix-forward (a11y H1 · SC 4.1.2): allow/deny 가 모두 aria-pressed=true 라
 * 의미가 손실됐던 문제를 해소한다 — aria-pressed 를 제거하고 aria-label 에 현재 상태와
 * 다음(클릭 시) 상태를 모두 명시한다. (a11y M2 · SC 1.3.1): aria-describedby(descId)로
 * 권한 설명 span 을 연결한다. (ui-designer H-01/N-02): inline 1px border 를 제거하고
 * Tailwind border + 색 클래스(success/danger/border-subtle)로 대체, py-2(28px)로
 * qf-btn--sm 높이에 맞춘다.
 */
function TriStateToggle({
  label,
  state,
  descId,
  testId,
  disabled,
  onCycle,
}: {
  label: string;
  state: TriState;
  descId: string;
  testId: string;
  disabled: boolean;
  onCycle: () => void;
}): JSX.Element {
  const stateLabel = triStateLabel(state);
  const nextStateLabel = triStateLabel(nextTriState(state));
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`${label} — 현재 ${stateLabel}, 클릭 시 ${nextStateLabel}`}
      aria-describedby={descId}
      disabled={disabled}
      onClick={onCycle}
      className={cn(
        'rounded-md border px-[var(--s-4)] py-2 text-center text-[length:var(--fs-12)] disabled:opacity-50',
        state === 'allow' && 'border-success text-success',
        state === 'deny' && 'border-danger text-danger',
        state === 'inherit' && 'border-border-subtle text-text-muted',
      )}
    >
      {stateLabel}
    </button>
  );
}

/** 마스크에 켜진 비트 수(읽기 표시용). */
function countBits(mask: number): number {
  let n = 0;
  let m = mask;
  while (m) {
    n += m & 1;
    m >>>= 1;
  }
  return n;
}
