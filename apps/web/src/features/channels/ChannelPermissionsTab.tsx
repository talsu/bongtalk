import { useMemo, useRef, useState } from 'react';
import type { ChannelPermissionOverride, Role } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { useNotifications } from '../../stores/notification-store';
import { useRoles } from '../workspaces/useWorkspaces';
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
 * DS qf-* + Tailwind 토큰만 사용(raw hex/px 금지). a11y(S62 fix-forward): 역할 선택은
 * WAI-ARIA tab 패턴(화살표/Home/End 키보드 이동 · 비활성 탭 tabIndex=-1 · tab↔tabpanel
 * id/aria-labelledby 연결, S61 WorkspaceSettingsPage 패턴). 3-state 토글은 aria-pressed
 * 대신 현재/다음 상태를 명시한 aria-label + 권한 설명 aria-describedby. 저장 중 status
 * live region.
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
  const { roleMut } = useUpsertChannelOverride(workspaceId, channelId);

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

  return (
    <div data-testid="channel-permissions-tab" className="flex flex-col gap-[var(--s-4)]">
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
        <ul className="m-0 flex list-none flex-col gap-[var(--s-1)] p-0">
          {CHANNEL_PERMISSION_CATALOG.map((p) => {
            const state = bitTriState(view.allowMask, view.denyMask, p.bit);
            return (
              <li
                key={p.bit}
                className="flex items-center justify-between gap-[var(--s-3)] border-b border-border-subtle py-[var(--s-2)]"
              >
                <span className="flex flex-col">
                  <span className="text-[length:var(--fs-14)] text-text-secondary">{p.label}</span>
                  {/* S62 fix-forward (a11y M2 · SC 1.3.1): 토글이 aria-describedby 로
                      참조하는 권한 설명. id 로 프로그램적 연결. */}
                  <span
                    id={`perm-desc-${p.bit}`}
                    className="text-[length:var(--fs-12)] text-text-muted"
                  >
                    {p.description}
                  </span>
                </span>
                <TriStateToggle
                  bit={p.bit}
                  label={p.label}
                  state={state}
                  disabled={roleMut.isPending || overridesQ.isLoading}
                  onCycle={() => onToggle(p.bit)}
                />
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* 커스텀 Role 의 기존 override 는 읽기 표시(쓰기 경로는 후속 슬라이스). */}
      {customRoleOverrides.length > 0 ? (
        <section
          aria-label="커스텀 역할 오버라이드"
          data-testid="channel-perm-custom-roles"
          className="flex flex-col gap-[var(--s-1)]"
        >
          <h3 className="m-0 text-[length:var(--fs-12)] text-text-muted">커스텀 역할 오버라이드</h3>
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
    </div>
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
 * 다음(클릭 시) 상태를 모두 명시한다. (a11y M2 · SC 1.3.1): aria-describedby 로 권한
 * 설명 span 을 연결한다. (ui-designer H-01/N-02): inline 1px border 를 제거하고
 * Tailwind border + 색 클래스(success/danger/border-subtle)로 대체, py-2(28px)로
 * qf-btn--sm 높이에 맞춘다.
 */
function TriStateToggle({
  bit,
  label,
  state,
  disabled,
  onCycle,
}: {
  bit: number;
  label: string;
  state: TriState;
  disabled: boolean;
  onCycle: () => void;
}): JSX.Element {
  const stateLabel = triStateLabel(state);
  const nextStateLabel = triStateLabel(nextTriState(state));
  return (
    <button
      type="button"
      data-testid={`channel-perm-toggle-${bit}`}
      aria-label={`${label} — 현재 ${stateLabel}, 클릭 시 ${nextStateLabel}`}
      aria-describedby={`perm-desc-${bit}`}
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
