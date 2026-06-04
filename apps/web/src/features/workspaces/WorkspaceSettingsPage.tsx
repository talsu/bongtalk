import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WORKSPACE_CATEGORY_META,
  type WorkspaceCategory,
  type WorkspaceVisibility,
} from '@qufox/shared-types';
import { Button, Dialog, Input, SettingsOverlay } from '../../design-system/primitives';
import {
  useLeaveWorkspace,
  useTransferOwnership,
  useUpdateDefaultChannel,
  useUpdateWorkspace,
} from './useWorkspaces';
import { WorkspaceEmojiManager } from '../emojis/WorkspaceEmojiManager';
// S61 (D12 / FR-RM01): 역할 관리 본문(설정 오버레이 탭으로 인라인 렌더).
import { RolesManager } from './roles/RolesModal';
// S64 (D12 / FR-RM11·12): 감사 로그 조회 + 신고 큐 패널.
import { AuditLogPanel } from './moderation/AuditLogPanel';
import { ReportQueuePanel } from './moderation/ReportQueuePanel';
// S67 (D13 / FR-W02·W17): 초대 링크 관리 패널.
import { InviteManagerPanel } from './InviteManagerPanel';
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
  // S65 (D13 / FR-W13·W19·W14): 소유권 양도 대상 후보(멤버) + 기본 채널 후보(공개
  // 채널). 호스트(Shell)가 주입한다. 비어 있으면 해당 섹션은 안내만 표시한다.
  members = [],
  channels = [],
}: {
  workspace: {
    id: string;
    name: string;
    description: string | null;
    visibility: WorkspaceVisibility;
    category: WorkspaceCategory | null;
    // S65 (FR-W19): 현재 기본 채널(셀렉트 초기값). 없으면 null.
    defaultChannelId?: string | null;
  };
  // S61: 시스템 역할 5단계 확장.
  myRole: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | 'GUEST';
  workspaceSlug: string;
  members?: Array<{ userId: string; username: string }>;
  channels?: Array<{ id: string; name: string; isPrivate: boolean }>;
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
  // S64 (FR-RM12): 감사 로그 조회는 ADMIN+ enum 게이트(★결정 B). 서버 @Roles('ADMIN') 권위.
  const canViewAuditLog = myRole === 'OWNER' || myRole === 'ADMIN';
  // S64 (FR-RM11): 신고 큐는 MODERATOR 이상. 서버 ModerationReportService 가 최종 게이트.
  const canModerateReports = myRole === 'OWNER' || myRole === 'ADMIN' || myRole === 'MODERATOR';
  // S67 (FR-W02·W17): 초대 링크 관리는 MODERATOR 이상(서버 @Roles('MODERATOR') 권위).
  // MODERATOR 는 서버가 본인 생성분만 내려준다.
  const canManageInvites = myRole === 'OWNER' || myRole === 'ADMIN' || myRole === 'MODERATOR';

  type TabKey = 'general' | 'invites' | 'emoji' | 'roles' | 'reports' | 'audit-log';
  const [tab, setTab] = useState<TabKey>('general');
  // E B1+S1 (SC 4.1.2/2.1.1): WAI-ARIA tab 패턴 — 노출 가능한 탭만 모아 화살표/Home/
  // End 키보드 이동을 구성한다. canManageEmoji/canManageRoles 가 false 면 그 탭은
  // tablist 에서 빠지므로 키보드 순회 대상에서도 자동 제외된다.
  const tabs = useMemo<Array<{ key: TabKey; label: string; testId: string }>>(() => {
    const list: Array<{ key: TabKey; label: string; testId: string }> = [
      { key: 'general', label: '일반', testId: 'ws-settings-tab-general' },
    ];
    if (canManageInvites) {
      list.push({ key: 'invites', label: '초대 링크', testId: 'ws-settings-tab-invites' });
    }
    if (canManageEmoji) {
      list.push({ key: 'emoji', label: '이모지 관리', testId: 'ws-settings-tab-emoji' });
    }
    if (canManageRoles) {
      list.push({ key: 'roles', label: '역할 관리', testId: 'ws-settings-tab-roles' });
    }
    if (canModerateReports) {
      list.push({ key: 'reports', label: '신고 큐', testId: 'ws-settings-tab-reports' });
    }
    if (canViewAuditLog) {
      list.push({ key: 'audit-log', label: '감사 로그', testId: 'ws-settings-tab-audit-log' });
    }
    return list;
  }, [canManageInvites, canManageEmoji, canManageRoles, canModerateReports, canViewAuditLog]);
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

  // S65 (FR-W13/W19/W14): 위험 구역 — 기본 채널 변경·소유권 양도·나가기.
  const transfer = useTransferOwnership(workspace.id);
  const setDefaultChannel = useUpdateDefaultChannel(workspace.id);
  const leave = useLeaveWorkspace(workspace.id);
  // FR-W19: 공개 채널만 기본 채널 후보다.
  const publicChannels = useMemo(() => channels.filter((c) => !c.isPrivate), [channels]);
  const [defaultChannelId, setDefaultChannelId] = useState<string>(
    workspace.defaultChannelId ?? '',
  );
  // FR-W13: 양도 대상 + 비밀번호 재확인.
  const transferTargets = useMemo(() => members.filter((m) => m.userId !== undefined), [members]);
  const [transferTo, setTransferTo] = useState<string>('');
  const [transferPassword, setTransferPassword] = useState<string>('');
  const [dangerErr, setDangerErr] = useState<string | null>(null);

  const closeSettings = (): void => {
    navigate(`/w/${workspaceSlug}`);
  };

  const onSaveDefaultChannel = async (): Promise<void> => {
    setDangerErr(null);
    try {
      await setDefaultChannel.mutateAsync(defaultChannelId);
    } catch (e) {
      setDangerErr((e as Error).message);
    }
  };

  const onTransfer = async (): Promise<void> => {
    setDangerErr(null);
    try {
      await transfer.mutateAsync({ toUserId: transferTo, password: transferPassword });
      setTransferPassword('');
      setTransferTo('');
      closeSettings();
    } catch (e) {
      setDangerErr((e as Error).message);
    }
  };

  const onLeave = async (): Promise<void> => {
    setDangerErr(null);
    try {
      await leave.mutateAsync();
      navigate('/dm');
    } catch (e) {
      setDangerErr((e as Error).message);
    }
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

        {/* S64 fix-forward (a11y H-01 · SC 2.1.1): 각 tabpanel 에 tabIndex={0} 로 키보드
            포커스를 부여한다(탭 전환 후 패널 콘텐츠로 포커스 이동 가능). */}
        {tab === 'invites' && canManageInvites ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-invites"
            aria-labelledby="ws-settings-tab-invites"
            tabIndex={0}
          >
            <InviteManagerPanel workspaceId={workspace.id} />
          </div>
        ) : tab === 'roles' && canManageRoles ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-roles"
            aria-labelledby="ws-settings-tab-roles"
            tabIndex={0}
          >
            <RolesManager workspaceId={workspace.id} canManage={canManageRoles} />
          </div>
        ) : tab === 'reports' && canModerateReports ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-reports"
            aria-labelledby="ws-settings-tab-reports"
            tabIndex={0}
          >
            <ReportQueuePanel workspaceId={workspace.id} />
          </div>
        ) : tab === 'audit-log' && canViewAuditLog ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-audit-log"
            aria-labelledby="ws-settings-tab-audit-log"
            tabIndex={0}
          >
            <AuditLogPanel workspaceId={workspace.id} />
          </div>
        ) : tab === 'emoji' && canManageEmoji ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-emoji"
            aria-labelledby="ws-settings-tab-emoji"
            tabIndex={0}
          >
            <WorkspaceEmojiManager workspaceId={workspace.id} />
          </div>
        ) : (
          <div
            role="tabpanel"
            id="ws-settings-panel-general"
            aria-labelledby="ws-settings-tab-general"
            tabIndex={0}
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
              // S65 fix-forward (a11y BLOCKER-3): 저장 에러는 role="alert" 로 즉시 안내.
              <p className="qf-field__error" data-testid="workspace-settings-error" role="alert">
                {err}
              </p>
            ) : null}

            <div className="flex gap-[var(--s-2)]">
              {/* S65 fix-forward (a11y MAJOR-1): 저장 진행 중 aria-busy 노출. */}
              <Button
                data-testid="workspace-settings-save"
                onClick={onSave}
                disabled={!canSave || saving}
                aria-busy={saving || undefined}
              >
                {saving ? '저장 중…' : '저장'}
              </Button>
              <Button variant="ghost" onClick={closeSettings}>
                닫기
              </Button>
            </div>

            {/* S65 (FR-W19): 기본 채널 변경 — OWNER 전용, 공개 채널만 후보. */}
            {ownerEditable ? (
              <section
                data-testid="ws-default-channel-section"
                aria-labelledby="ws-default-channel-heading"
                className="flex flex-col gap-[var(--s-2)] border-t border-border-subtle pt-[var(--s-4)]"
              >
                {/* S65 fix-forward (a11y MAJOR-5): 섹션 타이틀을 <h3> 로 격상해 문서
                    구조에 헤딩으로 노출한다(div.font-semibold → semantic heading). */}
                <h3
                  id="ws-default-channel-heading"
                  className="font-semibold text-[length:var(--fs-15)]"
                >
                  기본 채널
                </h3>
                <p className="text-[length:var(--fs-13)] text-text-muted">
                  새 멤버가 처음 도착하는 채널입니다. 공개 채널만 선택할 수 있습니다.
                </p>
                <div className="flex gap-[var(--s-2)] items-end">
                  <select
                    aria-label="기본 채널"
                    data-testid="ws-default-channel-select"
                    className="qf-input"
                    value={defaultChannelId}
                    onChange={(e) => setDefaultChannelId(e.target.value)}
                  >
                    <option value="" disabled>
                      채널 선택…
                    </option>
                    {publicChannels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {/* S65 fix-forward (a11y POLISH-1): 현재 기본 채널을 라벨에 표시. */}#
                        {c.name}
                        {c.id === (workspace.defaultChannelId ?? '') ? ' (현재 기본)' : ''}
                      </option>
                    ))}
                  </select>
                  <Button
                    data-testid="ws-default-channel-save"
                    onClick={onSaveDefaultChannel}
                    disabled={
                      defaultChannelId === '' ||
                      defaultChannelId === (workspace.defaultChannelId ?? '') ||
                      setDefaultChannel.isPending
                    }
                    aria-busy={setDefaultChannel.isPending || undefined}
                  >
                    적용
                  </Button>
                </div>
              </section>
            ) : null}

            {/* S65 (FR-W13): 소유권 양도 — OWNER 전용, 비밀번호 재확인 필수. */}
            {ownerEditable ? (
              <section
                data-testid="ws-transfer-section"
                aria-labelledby="ws-transfer-heading"
                className="flex flex-col gap-[var(--s-2)] border-t border-border-subtle pt-[var(--s-4)]"
              >
                {/* S65 fix-forward (a11y MAJOR-5): 섹션 타이틀 <h3> 격상. */}
                <h3 id="ws-transfer-heading" className="font-semibold text-[length:var(--fs-15)]">
                  소유권 양도
                </h3>
                <p id="ws-transfer-warning" className="text-[length:var(--fs-13)] text-text-muted">
                  소유권을 다른 멤버에게 넘깁니다. 본인은 관리자(ADMIN)로 강등됩니다. 되돌릴 수
                  없으므로 비밀번호로 재확인합니다.
                </p>
                <select
                  aria-label="양도 대상"
                  data-testid="ws-transfer-target"
                  className="qf-input"
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                >
                  <option value="" disabled>
                    멤버 선택…
                  </option>
                  {transferTargets.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.username}
                    </option>
                  ))}
                </select>
                {/* S65 fix-forward (a11y MAJOR-3): 비밀번호 입력에 양도 경고를 연결. */}
                <Input
                  type="password"
                  aria-label="비밀번호 확인"
                  aria-describedby="ws-transfer-warning"
                  data-testid="ws-transfer-password"
                  placeholder="비밀번호 확인"
                  value={transferPassword}
                  onChange={(e) => setTransferPassword(e.target.value)}
                />
                <div>
                  {/* S65 fix-forward (a11y HIGH-3 = ui HIGH-1): 파괴적 액션은 danger
                      variant + MAJOR-1 aria-busy. */}
                  <Button
                    variant="danger"
                    data-testid="ws-transfer-submit"
                    onClick={onTransfer}
                    disabled={
                      transferTo === '' || transferPassword.length === 0 || transfer.isPending
                    }
                    aria-busy={transfer.isPending || undefined}
                  >
                    {transfer.isPending ? '양도 중…' : '소유권 양도'}
                  </Button>
                </div>
              </section>
            ) : null}

            {/* S65 (FR-W14 · ★결정 D): 워크스페이스 나가기 — OWNER 는 비활성 + 양도 안내. */}
            <section
              data-testid="ws-leave-section"
              aria-labelledby="ws-leave-heading"
              className="flex flex-col gap-[var(--s-2)] border-t border-border-subtle pt-[var(--s-4)]"
            >
              {/* S65 fix-forward (a11y MAJOR-5): 섹션 타이틀 <h3> 격상. */}
              <h3 id="ws-leave-heading" className="font-semibold text-[length:var(--fs-15)]">
                워크스페이스 나가기
              </h3>
              {myRole === 'OWNER' ? (
                <p
                  id="ws-leave-owner-note"
                  data-testid="ws-leave-owner-note"
                  className="text-[length:var(--fs-13)] text-text-muted"
                >
                  소유자는 먼저 소유권을 양도해야 나갈 수 있습니다.
                </p>
              ) : (
                <p className="text-[length:var(--fs-13)] text-text-muted">
                  이 워크스페이스에서 나갑니다. 다시 들어오려면 초대가 필요할 수 있습니다.
                </p>
              )}
              <div>
                {/* S65 fix-forward (a11y HIGH-3 = ui HIGH-1 + HIGH-4 + MAJOR-1): 파괴적
                    액션 danger variant. OWNER 비활성 시 disabled 와 aria-disabled 를
                    병행하고 안내 텍스트를 aria-describedby 로 연결한다. */}
                <Button
                  variant="danger"
                  data-testid="ws-leave-submit"
                  onClick={onLeave}
                  disabled={myRole === 'OWNER' || leave.isPending}
                  aria-disabled={myRole === 'OWNER' || undefined}
                  aria-describedby={myRole === 'OWNER' ? 'ws-leave-owner-note' : undefined}
                  aria-busy={leave.isPending || undefined}
                >
                  {leave.isPending ? '나가는 중…' : '나가기'}
                </Button>
              </div>
            </section>

            {dangerErr ? (
              // S65 fix-forward (a11y BLOCKER-3): 위험 구역 에러는 role="alert" 로 즉시 안내.
              <p className="qf-field__error" data-testid="ws-danger-error" role="alert">
                {dangerErr}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* S65 fix-forward (a11y BLOCKER-1 + HIGH-2 = ui MINOR-1): 공개 설정 확인을 수동
          div[role=dialog](포커스 트랩·Esc·포커스 이동 없음)에서 DS Dialog primitive 의
          alertDialog 로 교체한다. Radix 가 focus trap·Esc 닫기·복귀 포커스를 처리하고,
          alertDialog=true 가 role="alertdialog" 로 노출해 파괴적 확인임을 AT 에 알린다.
          비파괴 액션이 아닌 가시성 전환이라 alertDialog 가 적절하다. */}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        alertDialog
        title="공개 설정 변경"
        description={
          visibility === 'PUBLIC'
            ? '누구나 /찾기에서 이 워크스페이스를 보고 참가할 수 있게 됩니다.'
            : '찾기에서 제외되고 초대 전용으로 전환됩니다. 기존 멤버는 유지됩니다.'
        }
        className="w-[min(420px,92vw)]"
      >
        <div
          data-testid="workspace-visibility-confirm"
          className="flex gap-[var(--s-2)] justify-end"
        >
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
            취소
          </Button>
          <Button data-testid="workspace-visibility-confirm-ok" onClick={doSave}>
            변경
          </Button>
        </div>
      </Dialog>
    </SettingsOverlay>
  );
}
