import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WORKSPACE_CATEGORY_META,
  type WorkspaceCategory,
  type WorkspaceVisibility,
} from '@qufox/shared-types';
import { Button, SettingsOverlay } from '../../design-system/primitives';
import { useUpdateWorkspace } from './useWorkspaces';
import { WorkspaceEmojiManager } from '../emojis/WorkspaceEmojiManager';
// S61 (D12 / FR-RM01): 역할 관리 본문(설정 오버레이 탭으로 인라인 렌더).
import { RolesManager } from './roles/RolesModal';
import { cn } from '../../lib/cn';

/**
 * task-031-A: workspace settings — visibility + category + description.
 * OWNER can edit; ADMIN sees the form but every field is disabled with a
 * "OWNER only" note. Matches the 030 reviewer B1 invariant: the API
 * already blocks non-OWNER visibility PATCH, and the UI mirrors the
 * constraint instead of silently failing.
 *
 * testids (ws-visibility-public / ws-category / ws-description) are
 * identical to the 030-D CreateWorkspacePage so a single E2E selector
 * works in both surfaces.
 */
export function WorkspaceSettingsPage({
  workspace,
  myRole,
  workspaceSlug,
}: {
  workspace: {
    id: string;
    name: string;
    description: string | null;
    visibility: WorkspaceVisibility;
    category: WorkspaceCategory | null;
  };
  // S61: 시스템 역할 5단계 확장.
  myRole: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
  workspaceSlug: string;
}): JSX.Element {
  const navigate = useNavigate();
  const update = useUpdateWorkspace(workspace.id);
  const ownerEditable = myRole === 'OWNER';
  // task-037-D: 이모지 관리 is OWNER/ADMIN (matches the API role gate).
  // MEMBER sees the General tab only.
  const canManageEmoji = myRole === 'OWNER' || myRole === 'ADMIN';
  // S61 (FR-RM01): 역할 관리는 ADMIN+ 만 편집(MEMBER 는 탭 미노출). 편집 가능 여부는
  // canManageRoles 로 RolesManager 에 전달하며, 서버 게이트(@Roles ADMIN)가 최종 권위.
  const canManageRoles = myRole === 'OWNER' || myRole === 'ADMIN';

  type TabKey = 'general' | 'emoji' | 'roles';
  const [tab, setTab] = useState<TabKey>('general');
  // E B1+S1 (SC 4.1.2/2.1.1): WAI-ARIA tab 패턴 — 노출 가능한 탭만 모아 화살표/Home/
  // End 키보드 이동을 구성한다. canManageEmoji/canManageRoles 가 false 면 그 탭은
  // tablist 에서 빠지므로 키보드 순회 대상에서도 자동 제외된다.
  const tabs = useMemo<Array<{ key: TabKey; label: string; testId: string }>>(() => {
    const list: Array<{ key: TabKey; label: string; testId: string }> = [
      { key: 'general', label: '일반', testId: 'ws-settings-tab-general' },
    ];
    if (canManageEmoji) {
      list.push({ key: 'emoji', label: '이모지 관리', testId: 'ws-settings-tab-emoji' });
    }
    if (canManageRoles) {
      list.push({ key: 'roles', label: '역할 관리', testId: 'ws-settings-tab-roles' });
    }
    return list;
  }, [canManageEmoji, canManageRoles]);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    const idx = tabs.findIndex((t) => t.key === tab);
    if (idx === -1) return;
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = tabs.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    const next = tabs[nextIdx];
    setTab(next.key);
    tabRefs.current[next.key]?.focus();
  };
  const [visibility, setVisibility] = useState<WorkspaceVisibility>(workspace.visibility);
  const [category, setCategory] = useState<WorkspaceCategory | ''>(workspace.category ?? '');
  const [description, setDescription] = useState<string>(workspace.description ?? '');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const closeSettings = (): void => {
    navigate(`/w/${workspaceSlug}`);
  };

  const visibilityChanged = visibility !== workspace.visibility;
  const canSave =
    ownerEditable &&
    (!visibilityChanged ||
      visibility !== 'PUBLIC' ||
      (category !== '' && description.trim().length > 0));

  const doSave = async (): Promise<void> => {
    setErr(null);
    setSaving(true);
    try {
      await update.mutateAsync({
        visibility,
        category: category === '' ? null : category,
        description: description.length === 0 ? null : description,
      });
      closeSettings();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  };

  const onSave = (): void => {
    if (visibilityChanged) setConfirmOpen(true);
    else void doSave();
  };

  return (
    <SettingsOverlay
      open
      onClose={closeSettings}
      title={`${workspace.name} 설정`}
      testId="workspace-settings-overlay"
    >
      <div
        data-testid="workspace-settings"
        className="qf-settings flex-1 p-[var(--s-6)] flex flex-col gap-[var(--s-5)]"
      >
        <div
          role="tablist"
          aria-label="워크스페이스 설정 탭"
          aria-orientation="horizontal"
          className="flex gap-[var(--s-1)] border-b border-border-subtle pb-[var(--s-2)]"
        >
          {tabs.map((t) => {
            const selected = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`ws-settings-tab-${t.key}`}
                aria-selected={selected}
                aria-controls={`ws-settings-panel-${t.key}`}
                tabIndex={selected ? 0 : -1}
                ref={(el) => {
                  tabRefs.current[t.key] = el;
                }}
                data-testid={t.testId}
                className={cn(
                  'px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-sm)] text-[length:var(--fs-13)]',
                  selected
                    ? 'bg-bg-accent text-text-strong'
                    : 'text-text-muted hover:text-foreground',
                )}
                onClick={() => setTab(t.key)}
                onKeyDown={onTabKeyDown}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'roles' && canManageRoles ? (
          <div role="tabpanel" id="ws-settings-panel-roles" aria-labelledby="ws-settings-tab-roles">
            <RolesManager workspaceId={workspace.id} canManage={canManageRoles} />
          </div>
        ) : tab === 'emoji' && canManageEmoji ? (
          <div role="tabpanel" id="ws-settings-panel-emoji" aria-labelledby="ws-settings-tab-emoji">
            <WorkspaceEmojiManager workspaceId={workspace.id} />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="ws-settings-panel-general"
            aria-labelledby="ws-settings-tab-general"
            className="flex flex-col gap-[var(--s-5)]"
          >
            {!ownerEditable ? (
              <div
                data-testid="workspace-settings-admin-note"
                className="text-[length:var(--fs-13)] text-text-muted"
              >
                OWNER만 변경 가능합니다. (현재 {myRole})
              </div>
            ) : null}

            <fieldset className="qf-field" data-testid="workspace-visibility-field">
              <legend className="qf-field__label">공개 설정</legend>
              <label className="flex items-center gap-[var(--s-2)]">
                <input
                  type="radio"
                  name="visibility"
                  value="PRIVATE"
                  data-testid="ws-visibility-private"
                  checked={visibility === 'PRIVATE'}
                  disabled={!ownerEditable}
                  onChange={() => setVisibility('PRIVATE')}
                />
                <span>비공개 (PRIVATE) — 초대 전용</span>
              </label>
              <label className="flex items-center gap-[var(--s-2)]">
                <input
                  type="radio"
                  name="visibility"
                  value="PUBLIC"
                  data-testid="ws-visibility-public"
                  checked={visibility === 'PUBLIC'}
                  disabled={!ownerEditable}
                  onChange={() => setVisibility('PUBLIC')}
                />
                <span>공개 (PUBLIC) — /찾기에 노출</span>
              </label>
            </fieldset>

            <div className="qf-field">
              <label className="qf-field__label" htmlFor="ws-category">
                카테고리 <span className="text-text-muted">(공개 시 필수)</span>
              </label>
              <select
                id="ws-category"
                data-testid="ws-category"
                className="qf-input"
                disabled={!ownerEditable}
                value={category}
                onChange={(e) => setCategory(e.target.value as WorkspaceCategory | '')}
              >
                <option value="">선택 없음</option>
                {(Object.keys(WORKSPACE_CATEGORY_META) as WorkspaceCategory[]).map((k) => (
                  <option key={k} value={k}>
                    {WORKSPACE_CATEGORY_META[k].label}
                  </option>
                ))}
              </select>
            </div>

            <div className="qf-field">
              <label className="qf-field__label" htmlFor="ws-description">
                설명{' '}
                <span className="text-text-muted">(공개 시 필수, {description.length}/500)</span>
              </label>
              <textarea
                id="ws-description"
                data-testid="ws-description"
                rows={4}
                maxLength={500}
                className="qf-input"
                disabled={!ownerEditable}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {err ? (
              <p className="qf-field__error" data-testid="workspace-settings-error">
                {err}
              </p>
            ) : null}

            <div className="flex gap-[var(--s-2)]">
              <Button
                data-testid="workspace-settings-save"
                onClick={onSave}
                disabled={!canSave || saving}
              >
                {saving ? '저장 중…' : '저장'}
              </Button>
              <Button variant="ghost" onClick={closeSettings}>
                닫기
              </Button>
            </div>

            {confirmOpen ? (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="ws-visibility-confirm-title"
                data-testid="workspace-visibility-confirm"
                className="fixed inset-0 z-[var(--z-modal,60)] grid place-items-center"
                style={{ background: 'color-mix(in oklab, var(--bg-app) 60%, transparent)' }}
              >
                <div
                  className="bg-bg-subtle rounded-[var(--r-lg)] p-[var(--s-5)] w-[min(420px,92vw)]"
                  style={{ boxShadow: 'var(--elev-3)' }}
                >
                  <div id="ws-visibility-confirm-title" className="font-semibold mb-[var(--s-2)]">
                    공개 설정 변경
                  </div>
                  <p className="text-[length:var(--fs-13)] text-text-secondary mb-[var(--s-4)]">
                    {visibility === 'PUBLIC'
                      ? '누구나 /찾기에서 이 워크스페이스를 보고 참가할 수 있게 됩니다.'
                      : '찾기에서 제외되고 초대 전용으로 전환됩니다. 기존 멤버는 유지됩니다.'}
                  </p>
                  <div className="flex gap-[var(--s-2)] justify-end">
                    <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                      취소
                    </Button>
                    <Button data-testid="workspace-visibility-confirm-ok" onClick={doSave}>
                      변경
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </SettingsOverlay>
  );
}
