import { useMemo, useState } from 'react';
import type { Role } from '@qufox/shared-types';
import { serializePermissions } from '@qufox/shared-types';
import { Dialog, Button } from '../../../design-system/primitives';
import { useNotifications } from '../../../stores/notification-store';
import { cn } from '../../../lib/cn';
import { useRoles, useCreateRole, useUpdateRole2, useDeleteRole } from '../useWorkspaces';
import { PERMISSION_CATALOG, parsePermissions, isBitOn, toggleBit } from './permissionCatalog';

type Props = {
  workspaceId: string;
  /** ADMIN+ 만 생성/수정/삭제 가능. false 면 읽기 전용. */
  canManage: boolean;
  open: boolean;
  onClose: () => void;
};

/**
 * S61 (D12 / FR-RM01·02·04·15): 워크스페이스 역할 관리 모달.
 *
 * 좌측 역할 목록(color 점·시스템 뱃지·position) + 우측 편집 패널(이름·색상·position·
 * 권한 토글). 생성/삭제/저장. 권한 비트는 ADR-4 카탈로그(shared-types) 단일 출처를
 * 재사용하고 string(ADR-11)으로 송수신한다. DS qf-* + Tailwind 토큰만 사용(raw hex 금지).
 * a11y: Dialog(role=dialog) · 키보드 포커스 가능한 토글/버튼 · aria-label.
 */
export function RolesModal({ workspaceId, canManage, open, onClose }: Props): JSX.Element {
  // E S2 (SC 2.4.3): `if (!open) return null` 조기반환을 제거한다. Radix Dialog 가
  // `open` prop 으로 마운트/언마운트 + 포커스 트랩 + 포커스 복원(닫힐 때 트리거로
  // 되돌림)을 위임받게 해, 조기반환으로 인한 포커스 복원 누락을 막는다.
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="역할 관리"
      description="워크스페이스 역할과 권한을 관리합니다."
    >
      <RolesManager workspaceId={workspaceId} canManage={canManage} />
    </Dialog>
  );
}

/**
 * S61: 역할 관리 본문(2-pane). Dialog(RolesModal) 또는 설정 오버레이 탭에서 인라인으로
 * 재사용한다. 자체 Dialog 를 열지 않으므로 오버레이 안에 중첩돼도 a11y 충돌이 없다.
 */
export function RolesManager({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}): JSX.Element {
  const { data: roles } = useRoles(workspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(() => [...(roles ?? [])].sort((a, b) => b.position - a.position), [roles]);
  const selected = sorted.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex gap-[var(--s-3)]" data-testid="roles-modal">
      <RoleList
        workspaceId={workspaceId}
        roles={sorted}
        canManage={canManage}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <div className="min-w-0 flex-1">
        {selected ? (
          <RoleEditor
            key={selected.id}
            workspaceId={workspaceId}
            role={selected}
            canManage={canManage}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <p className="py-[var(--s-4)] text-[length:var(--fs-13)] text-text-muted">
            편집할 역할을 선택하세요.
          </p>
        )}
      </div>
    </div>
  );
}

// ── 좌측 역할 목록 + 생성 ──────────────────────────────────────────────────────

function RoleList({
  workspaceId,
  roles,
  canManage,
  selectedId,
  onSelect,
}: {
  workspaceId: string;
  roles: Role[];
  canManage: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const create = useCreateRole(workspaceId);
  const notify = useNotifications((s) => s.push);
  const [newName, setNewName] = useState('');

  async function onCreate(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await create.mutateAsync({ name });
      setNewName('');
      onSelect(created.id);
    } catch (err) {
      notify({ variant: 'danger', title: '역할 생성 실패', body: (err as Error).message });
    }
  }

  return (
    <div className="w-44 shrink-0 border-r border-border-subtle pr-[var(--s-3)]">
      <ul
        data-testid="roles-list"
        aria-label="역할 목록"
        className="max-h-80 overflow-y-auto text-[length:var(--fs-13)]"
      >
        {roles.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              data-testid={`role-item-${r.name}`}
              aria-pressed={selectedId === r.id}
              onClick={() => onSelect(r.id)}
              className={cn(
                'flex w-full items-center gap-[var(--s-2)] rounded-md px-[var(--s-2)] py-[var(--s-1)] text-left text-text-secondary hover:bg-muted',
                selectedId === r.id && 'bg-muted text-text-strong',
              )}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: r.colorHex ?? 'var(--text-muted)' }}
              />
              <span className="truncate">{r.name}</span>
              {r.isSystem ? (
                <span className="ml-auto text-[length:var(--fs-11)] text-text-muted">시스템</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {canManage ? (
        <div className="mt-[var(--s-2)] flex gap-[var(--s-1)]">
          <input
            data-testid="role-new-name"
            aria-label="새 역할 이름"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onCreate();
            }}
            placeholder="새 역할"
            maxLength={64}
            className="qf-input !h-7 min-w-0 flex-1 text-[length:var(--fs-12)]"
          />
          <Button
            size="sm"
            data-testid="role-create-btn"
            disabled={create.isPending || newName.trim().length === 0}
            onClick={() => void onCreate()}
          >
            추가
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── 우측 역할 편집 패널 ───────────────────────────────────────────────────────

function RoleEditor({
  workspaceId,
  role,
  canManage,
  onDeleted,
}: {
  workspaceId: string;
  role: Role;
  canManage: boolean;
  onDeleted: () => void;
}): JSX.Element {
  const update = useUpdateRole2(workspaceId);
  const del = useDeleteRole(workspaceId);
  const notify = useNotifications((s) => s.push);

  const [name, setName] = useState(role.name);
  const [colorHex, setColorHex] = useState<string | null>(role.colorHex);
  const [position, setPosition] = useState(role.position);
  const [permissions, setPermissions] = useState<bigint>(parsePermissions(role.permissions));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const readOnly = !canManage || role.isSystem;

  async function onSave(): Promise<void> {
    try {
      await update.mutateAsync({
        roleId: role.id,
        input: {
          name: name.trim(),
          colorHex,
          position,
          permissions: serializePermissions(permissions),
        },
      });
      notify({ variant: 'success', title: '역할 저장됨' });
    } catch (err) {
      notify({ variant: 'danger', title: '역할 저장 실패', body: (err as Error).message });
    }
  }

  async function onDelete(): Promise<void> {
    try {
      await del.mutateAsync(role.id);
      notify({ variant: 'success', title: '역할 삭제됨' });
      onDeleted();
    } catch (err) {
      notify({ variant: 'danger', title: '역할 삭제 실패', body: (err as Error).message });
    }
  }

  return (
    <div data-testid="role-editor" className="flex flex-col gap-[var(--s-3)]">
      <div className="flex flex-col gap-[var(--s-1)]">
        <label htmlFor="role-name" className="text-[length:var(--fs-12)] text-text-muted">
          이름
        </label>
        <input
          id="role-name"
          data-testid="role-edit-name"
          value={name}
          // E M3 (SC 2.4.6): 읽기 전용(권한 없음 OR 시스템 역할) 전체를 disabled 로
          // 통일한다. 종전에는 시스템 역할만 막아, canManage=false(권한 없는) 사용자가
          // 이름을 입력할 수 있는 것처럼 보였다.
          disabled={readOnly}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          className="qf-input !h-8 text-[length:var(--fs-13)]"
        />
      </div>

      <div className="flex items-center gap-[var(--s-3)]">
        <div className="flex flex-col gap-[var(--s-1)]">
          <label htmlFor="role-color" className="text-[length:var(--fs-12)] text-text-muted">
            색상
          </label>
          <input
            id="role-color"
            type="color"
            data-testid="role-edit-color"
            aria-label="역할 색상"
            // 네이티브 <input type="color"> 의 value 는 리터럴 #RRGGBB 만 허용한다(CSS
            // var 불가). "색상 없음"일 때 보여줄 중립 회색 기본값으로, DS 토큰으로
            // 대체할 수 없는 플랫폼 제약이다.
            // eslint-disable-next-line no-restricted-syntax -- native color input requires a literal hex fallback
            value={colorHex ?? '#99aab5'}
            disabled={readOnly}
            onChange={(e) => setColorHex(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded-md border border-border-subtle bg-transparent"
          />
        </div>
        <button
          type="button"
          data-testid="role-color-clear"
          disabled={readOnly || colorHex === null}
          onClick={() => setColorHex(null)}
          className="self-end text-[length:var(--fs-12)] text-link disabled:text-text-muted"
        >
          색상 없음
        </button>
        <div className="ml-auto flex flex-col gap-[var(--s-1)]">
          <label htmlFor="role-position" className="text-[length:var(--fs-12)] text-text-muted">
            순서(높을수록 상위)
          </label>
          <input
            id="role-position"
            type="number"
            data-testid="role-edit-position"
            value={position}
            disabled={readOnly}
            onChange={(e) => setPosition(Number(e.target.value))}
            className="qf-input !h-8 w-20 text-[length:var(--fs-13)]"
          />
        </div>
      </div>

      {/* E M1 (SC 1.3.1): legend 가 그룹 이름을 제공하므로 fieldset aria-label 제거(중복). */}
      <fieldset className="flex flex-col gap-[var(--s-1)]">
        <legend className="text-[length:var(--fs-12)] text-text-muted">권한</legend>
        <div className="grid max-h-48 grid-cols-1 gap-[var(--s-1)] overflow-y-auto sm:grid-cols-2">
          {PERMISSION_CATALOG.map((p) => (
            <label
              key={p.flag}
              data-testid={`role-perm-${p.flag}`}
              className="flex items-center gap-[var(--s-2)] text-[length:var(--fs-12)] text-text-secondary"
            >
              <input
                type="checkbox"
                // E M2 (SC 1.3.1): wrapping label 의 텍스트가 접근 가능한 이름을
                // 제공하므로 aria-label 제거(중복). title 은 설명 보조로 유지.
                checked={isBitOn(permissions, p.bit)}
                disabled={readOnly}
                onChange={() => setPermissions((m) => toggleBit(m, p.bit))}
                // ui-designer MINOR: 체크 표시 색을 DS accent 토큰에 맞춘다.
                style={{ accentColor: 'var(--accent)' }}
              />
              <span title={p.description}>{p.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {canManage && !role.isSystem ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[var(--s-2)]">
            {confirmDelete ? (
              <>
                <span className="text-[length:var(--fs-12)] text-danger">삭제할까요?</span>
                <Button
                  size="sm"
                  variant="danger"
                  data-testid="role-delete-confirm"
                  disabled={del.isPending}
                  onClick={() => void onDelete()}
                >
                  삭제 확인
                </Button>
                <button
                  type="button"
                  aria-label="역할 삭제 취소"
                  className="text-[length:var(--fs-12)] text-text-muted"
                  onClick={() => setConfirmDelete(false)}
                >
                  취소
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="role-delete-btn"
                className="text-[length:var(--fs-12)] text-danger"
                onClick={() => setConfirmDelete(true)}
              >
                역할 삭제
              </button>
            )}
          </div>
          <Button
            size="sm"
            data-testid="role-save-btn"
            disabled={update.isPending || name.trim().length === 0}
            onClick={() => void onSave()}
          >
            저장
          </Button>
        </div>
      ) : (
        <p className="text-[length:var(--fs-12)] text-text-muted">
          {role.isSystem ? '시스템 역할은 수정/삭제할 수 없습니다.' : '읽기 전용입니다.'}
        </p>
      )}
    </div>
  );
}
