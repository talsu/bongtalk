import { useMemo, useState } from 'react';
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
 * DS qf-* + Tailwind 토큰만 사용(raw hex/px 금지). a11y: fieldset/legend, 3-state
 * 버튼 aria-pressed + aria-label, 역할 선택 aria-selected.
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

      {/* 역할 선택 — 시스템 역할 5개 탭. */}
      <div
        role="tablist"
        aria-label="역할 선택"
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
              aria-selected={active}
              data-testid={`channel-perm-role-${role}`}
              onClick={() => setSelectedRole(role)}
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

      {/* 권한 비트 3-state 토글. */}
      <fieldset className="m-0 flex flex-col gap-[var(--s-1)] border-0 p-0">
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
                  <span className="text-[length:var(--fs-12)] text-text-muted">
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

/** 3-state 토글 버튼(allow/deny/inherit 순환). aria-pressed + 상태별 색. */
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
  const stateLabel = state === 'allow' ? '허용' : state === 'deny' ? '거부' : '상속';
  return (
    <button
      type="button"
      data-testid={`channel-perm-toggle-${bit}`}
      aria-pressed={state !== 'inherit'}
      aria-label={`${label}: ${stateLabel} (눌러서 변경)`}
      disabled={disabled}
      onClick={onCycle}
      className={cn(
        'rounded-md px-[var(--s-4)] py-[var(--s-1)] text-center text-[length:var(--fs-12)] disabled:opacity-50',
        state === 'allow' && 'text-success',
        state === 'deny' && 'text-danger',
        state === 'inherit' && 'text-text-muted',
      )}
      style={{
        border:
          state === 'allow'
            ? '1px solid var(--ok-400)'
            : state === 'deny'
              ? '1px solid var(--danger-400)'
              : '1px solid var(--divider)',
      }}
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
