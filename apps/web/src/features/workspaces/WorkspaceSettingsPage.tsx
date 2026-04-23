import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WORKSPACE_CATEGORY_META,
  type WorkspaceCategory,
  type WorkspaceVisibility,
} from '@qufox/shared-types';
import { Button, SettingsOverlay } from '../../design-system/primitives';
import { useUpdateWorkspace } from './useWorkspaces';
import { WorkspaceEmojiManager } from '../emojis/WorkspaceEmojiManager';
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
  myRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  workspaceSlug: string;
}): JSX.Element {
  const navigate = useNavigate();
  const update = useUpdateWorkspace(workspace.id);
  const ownerEditable = myRole === 'OWNER';
  // task-037-D: 이모지 관리 is OWNER/ADMIN (matches the API role gate).
  // MEMBER sees the General tab only.
  const canManageEmoji = myRole === 'OWNER' || myRole === 'ADMIN';

  const [tab, setTab] = useState<'general' | 'emoji'>('general');
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
        <div className="flex gap-[var(--s-1)] border-b border-border-subtle pb-[var(--s-2)]">
          <button
            type="button"
            data-testid="ws-settings-tab-general"
            className={cn(
              'px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-sm)] text-[length:var(--fs-13)]',
              tab === 'general'
                ? 'bg-bg-selected text-text-strong'
                : 'text-text-muted hover:text-text',
            )}
            onClick={() => setTab('general')}
          >
            일반
          </button>
          {canManageEmoji ? (
            <button
              type="button"
              data-testid="ws-settings-tab-emoji"
              className={cn(
                'px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-sm)] text-[length:var(--fs-13)]',
                tab === 'emoji'
                  ? 'bg-bg-selected text-text-strong'
                  : 'text-text-muted hover:text-text',
              )}
              onClick={() => setTab('emoji')}
            >
              이모지 관리
            </button>
          ) : null}
        </div>

        {tab === 'emoji' && canManageEmoji ? (
          <WorkspaceEmojiManager workspaceId={workspace.id} />
        ) : (
          <>
            {!ownerEditable ? (
              <div
                data-testid="workspace-settings-admin-note"
                className="qf-field__error"
                style={{ color: 'var(--text-muted)' }}
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
                data-testid="workspace-visibility-confirm"
                className="fixed inset-0 z-[var(--z-modal,60)] grid place-items-center"
                style={{ background: 'color-mix(in oklab, var(--bg-app) 60%, transparent)' }}
              >
                <div
                  className="bg-bg-subtle rounded-[var(--r-lg)] p-[var(--s-5)] w-[min(420px,92vw)]"
                  style={{ boxShadow: 'var(--elev-3)' }}
                >
                  <div className="font-semibold mb-[var(--s-2)]">공개 설정 변경</div>
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
          </>
        )}
      </div>
    </SettingsOverlay>
  );
}
