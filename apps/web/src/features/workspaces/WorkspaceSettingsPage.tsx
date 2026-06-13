import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  WORKSPACE_CATEGORY_META,
  WS_ICON_ALLOWED_MIME,
  WS_ICON_MAX_BYTES,
  type WorkspaceCategory,
  type WorkspaceJoinMode,
  type WorkspaceVisibility,
} from '@qufox/shared-types';
import { Button, Dialog, Input, SettingsOverlay } from '../../design-system/primitives';
import {
  useDeleteWorkspace,
  useDeleteWorkspaceIcon,
  useLeaveWorkspace,
  useTransferOwnership,
  useUpdateDefaultChannel,
  useUpdateWorkspace,
  useUploadWorkspaceIcon,
} from './useWorkspaces';
import { WorkspaceEmojiManager } from '../emojis/WorkspaceEmojiManager';
// S61 (D12 / FR-RM01): 역할 관리 본문(설정 오버레이 탭으로 인라인 렌더).
import { RolesManager } from './roles/RolesModal';
// FR-RM10a (063): AutoMod 키워드 규칙 관리(ADMIN+ 탭).
import { AutoModPanel } from './automod/AutoModPanel';
// S64 (D12 / FR-RM11·12): 감사 로그 조회 + 신고 큐 패널.
import { AuditLogPanel } from './moderation/AuditLogPanel';
import { ReportQueuePanel } from './moderation/ReportQueuePanel';
// S67 (D13 / FR-W02·W17): 초대 링크 관리 패널.
import { InviteManagerPanel } from './InviteManagerPanel';
// S68 (D13 / FR-W04·W05·W18): 이메일 직접 초대 + 도메인 화이트리스트 + 보류 초대 관리.
import { EmailInvitePanel } from './EmailInvitePanel';
import { PendingInvitePanel } from './PendingInvitePanel';
import { EmailDomainsPanel } from './EmailDomainsPanel';
// S71 (D13 / FR-W07·W08·W09 · 결정 5): 온보딩(규칙/질문/웰컴) 관리자 CRUD 패널.
import { OnboardingSettingsPanel } from '../onboarding/OnboardingSettingsPanel';
// S74 (D14 / FR-PS-06): 워크스페이스별 프로필 편집 패널(전원 노출 탭).
import { WorkspaceProfilePanel } from './WorkspaceProfilePanel';
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
    // S68 (FR-W05): 현재 이메일 도메인 화이트리스트(도메인 패널 초기값). 없으면 빈 배열.
    emailDomains?: string[];
    // 072 백로그 S-C (FR-W01): 현재 아이콘(presigned GET URL · 없으면 null) + 가입 모드.
    iconUrl?: string | null;
    joinMode?: WorkspaceJoinMode;
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
  // S68 (FR-W04·W18): 이메일 직접 초대 + 보류 초대 관리는 ADMIN 이상(서버 @Roles('ADMIN')
  // 권위). 도메인 화이트리스트 편집은 OWNER 전용(EmailDomainsPanel.canEdit 가 게이트).
  const canManageEmailInvites = myRole === 'OWNER' || myRole === 'ADMIN';

  type TabKey =
    | 'general'
    // S74 (D14 / FR-PS-06): 내 워크스페이스 프로필(닉네임/아바타/About Me) — 전원 노출.
    | 'my-profile'
    | 'invites'
    | 'email-invites'
    | 'emoji'
    | 'roles'
    | 'automod'
    | 'reports'
    | 'audit-log'
    | 'onboarding';
  // S71 (결정 5): 온보딩 카탈로그 CRUD 는 ADMIN+ 만.
  const canManageOnboarding = myRole === 'OWNER' || myRole === 'ADMIN';
  // FR-RM10a (063): AutoMod 규칙 관리는 ADMIN+ 만(서버 @Roles ADMIN 게이트가 최종 권위).
  const canManageAutomod = myRole === 'OWNER' || myRole === 'ADMIN';
  const [tab, setTab] = useState<TabKey>('general');
  // E B1+S1 (SC 4.1.2/2.1.1): WAI-ARIA tab 패턴 — 노출 가능한 탭만 모아 화살표/Home/
  // End 키보드 이동을 구성한다. canManageEmoji/canManageRoles 가 false 면 그 탭은
  // tablist 에서 빠지므로 키보드 순회 대상에서도 자동 제외된다.
  const tabs = useMemo<Array<{ key: TabKey; label: string; testId: string }>>(() => {
    const list: Array<{ key: TabKey; label: string; testId: string }> = [
      { key: 'general', label: '일반', testId: 'ws-settings-tab-general' },
      // S74 (FR-PS-06): 내 프로필 탭은 모든 멤버에게 노출(권한 무관).
      { key: 'my-profile', label: '내 프로필', testId: 'ws-settings-tab-my-profile' },
    ];
    if (canManageInvites) {
      list.push({ key: 'invites', label: '초대 링크', testId: 'ws-settings-tab-invites' });
    }
    if (canManageEmailInvites) {
      list.push({
        key: 'email-invites',
        label: '이메일 초대',
        testId: 'ws-settings-tab-email-invites',
      });
    }
    if (canManageEmoji) {
      list.push({ key: 'emoji', label: '이모지 관리', testId: 'ws-settings-tab-emoji' });
    }
    if (canManageRoles) {
      list.push({ key: 'roles', label: '역할 관리', testId: 'ws-settings-tab-roles' });
    }
    if (canManageAutomod) {
      list.push({ key: 'automod', label: 'AutoMod', testId: 'ws-settings-tab-automod' });
    }
    if (canModerateReports) {
      list.push({ key: 'reports', label: '신고 큐', testId: 'ws-settings-tab-reports' });
    }
    if (canViewAuditLog) {
      list.push({ key: 'audit-log', label: '감사 로그', testId: 'ws-settings-tab-audit-log' });
    }
    if (canManageOnboarding) {
      list.push({ key: 'onboarding', label: '온보딩', testId: 'ws-settings-tab-onboarding' });
    }
    return list;
  }, [
    canManageInvites,
    canManageEmailInvites,
    canManageEmoji,
    canManageRoles,
    canManageAutomod,
    canModerateReports,
    canViewAuditLog,
    canManageOnboarding,
  ]);
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
  // 072-N5-4 (FR-W01): 워크스페이스 이름 편집. 072 백로그 S-C 에서 joinMode(가입 모드)와
  // 아이콘 업로드가 서버에 추가돼 함께 편집 가능해졌다(종전 "서버 미지원 → 이월" 해소).
  const [name, setName] = useState<string>(workspace.name);
  const [visibility, setVisibility] = useState<WorkspaceVisibility>(workspace.visibility);
  const [category, setCategory] = useState<WorkspaceCategory | ''>(workspace.category ?? '');
  const [description, setDescription] = useState<string>(workspace.description ?? '');
  // 072 백로그 S-C (FR-W01): 가입 모드(PRIVATE 초대전용 / PUBLIC 즉시가입 / APPLY 신청).
  // visibility(디스커버리 노출)와 직교한다. OWNER 전용.
  const [joinMode, setJoinMode] = useState<WorkspaceJoinMode>(workspace.joinMode ?? 'PRIVATE');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 업로드/제거(ADMIN+). 전역 아바타 흐름과
  // 동일(presign → MinIO POST → finalize). 업로드 결과 presigned URL 은 쿼리 무효화로
  // 레일/설정에 반영된다.
  const uploadIcon = useUploadWorkspaceIcon(workspace.id);
  const deleteIcon = useDeleteWorkspaceIcon(workspace.id);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [iconErr, setIconErr] = useState<string | null>(null);
  const canManageIcon = myRole === 'OWNER' || myRole === 'ADMIN';

  const onPickIcon = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    setIconErr(null);
    const file = e.target.files?.[0];
    // 같은 파일 재선택도 onChange 가 다시 발화하도록 value 를 비운다.
    e.target.value = '';
    if (!file) return;
    if (!(WS_ICON_ALLOWED_MIME as readonly string[]).includes(file.type)) {
      setIconErr('PNG · JPEG · WebP 이미지만 업로드할 수 있습니다.');
      return;
    }
    if (file.size > WS_ICON_MAX_BYTES) {
      setIconErr(`파일이 너무 큽니다 (최대 ${Math.floor(WS_ICON_MAX_BYTES / (1024 * 1024))}MB).`);
      return;
    }
    try {
      await uploadIcon.mutateAsync(file);
    } catch (err2) {
      setIconErr((err2 as Error).message);
    }
  };

  const onRemoveIcon = async (): Promise<void> => {
    setIconErr(null);
    try {
      await deleteIcon.mutateAsync();
    } catch (err2) {
      setIconErr((err2 as Error).message);
    }
  };

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

  // S72 (FR-W15): 워크스페이스 삭제 — OWNER 전용, slug 타이핑 확인 모달.
  const deleteWorkspace = useDeleteWorkspace(workspace.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  // S72 fix-forward (a11y B-1): 삭제 실패 에러는 모달 포털 *내부*에 둔 별도 state +
  // role="alert" 로 알린다. 종전엔 모달 밖(dangerErr)에 떠서 aria-modal 컨테이너에
  // 가려 AT 가 수신하지 못했다. 모달 닫힘 시 초기화한다(아래 onOpenChange/취소/성공).
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // 클라 검증: 입력값이 정확히 slug 와 일치해야 삭제 버튼이 활성화된다(서버가 최종 권위).
  const deleteConfirmMatches = deleteConfirm === workspaceSlug;
  // S72 fix-forward (a11y H-2): 입력이 비어있지 않은데 불일치할 때만 invalid 로 표시한다
  // (빈 입력은 아직 미입력이라 오류로 취급하지 않는다).
  const deleteConfirmMismatch = deleteConfirm.length > 0 && !deleteConfirmMatches;

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

  // S72 (FR-W15): slug 일치 확인 후 삭제 → 목록 제거 + 홈(/dm) 리다이렉트. 불일치 입력은
  // 버튼이 disabled 라 도달하지 않지만, 방어적으로 게이트한다(서버가 422 로 최종 거부).
  const onDelete = async (): Promise<void> => {
    // S72 fix-forward (a11y B-1): 실패 에러는 모달 내부 deleteErr 로 알린다(모달 밖 dangerErr 분리).
    setDeleteErr(null);
    if (!deleteConfirmMatches) return;
    try {
      await deleteWorkspace.mutateAsync(deleteConfirm);
      setDeleteOpen(false);
      setDeleteConfirm('');
      setDeleteErr(null);
      navigate('/dm');
    } catch (e) {
      setDeleteErr((e as Error).message);
    }
  };

  const visibilityChanged = visibility !== workspace.visibility;
  // 072-N5-4: 이름 변경(공백 trim·비어있지 않음·실제 변경) — doSave 가 변경 시에만 전송.
  const nameChanged = name.trim().length > 0 && name.trim() !== workspace.name;
  // 072-N5(리뷰 LOW): 이름은 비울 수 없다(서버 min(1) 사전 차단 + 인라인 안내).
  const nameValid = name.trim().length > 0;
  // 072-N5(리뷰 MEDIUM): PUBLIC 전환 메타데이터 게이트는 nameChanged 로 우회되면
  // 안 된다 — visibilityValid 를 항상 AND 로 요구(종전 short-circuit 회귀 수리).
  const visibilityValid =
    !visibilityChanged ||
    visibility !== 'PUBLIC' ||
    (category !== '' && description.trim().length > 0);
  const canSave = ownerEditable && nameValid && visibilityValid;

  const doSave = async (): Promise<void> => {
    setErr(null);
    setSaving(true);
    try {
      await update.mutateAsync({
        visibility,
        category: category === '' ? null : category,
        description: description.length === 0 ? null : description,
        // 변경됐을 때만 name 전송(불필요한 검증 회피).
        ...(nameChanged ? { name: name.trim() } : {}),
        // 072 백로그 S-C (FR-W01): joinMode 는 변경 시에만 전송(OWNER 게이트는 서버가 권위).
        ...(joinMode !== (workspace.joinMode ?? 'PRIVATE') ? { joinMode } : {}),
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
        {tab === 'my-profile' ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-my-profile"
            aria-labelledby="ws-settings-tab-my-profile"
            tabIndex={0}
          >
            <WorkspaceProfilePanel workspaceId={workspace.id} />
          </div>
        ) : tab === 'invites' && canManageInvites ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-invites"
            aria-labelledby="ws-settings-tab-invites"
            tabIndex={0}
          >
            <InviteManagerPanel workspaceId={workspace.id} />
          </div>
        ) : tab === 'email-invites' && canManageEmailInvites ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-email-invites"
            aria-labelledby="ws-settings-tab-email-invites"
            tabIndex={0}
            className="flex flex-col gap-[var(--s-6)]"
          >
            <EmailInvitePanel workspaceId={workspace.id} />
            <div className="border-t border-border-subtle pt-[var(--s-5)]">
              <PendingInvitePanel workspaceId={workspace.id} />
            </div>
            <div className="border-t border-border-subtle pt-[var(--s-5)]">
              <EmailDomainsPanel
                workspaceId={workspace.id}
                initialDomains={workspace.emailDomains ?? []}
                canEdit={myRole === 'OWNER'}
              />
            </div>
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
        ) : tab === 'automod' && canManageAutomod ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-automod"
            aria-labelledby="ws-settings-tab-automod"
            tabIndex={0}
          >
            <AutoModPanel workspaceId={workspace.id} canManage={canManageAutomod} />
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
        ) : tab === 'onboarding' && canManageOnboarding ? (
          <div
            role="tabpanel"
            id="ws-settings-panel-onboarding"
            aria-labelledby="ws-settings-tab-onboarding"
            tabIndex={0}
          >
            <OnboardingSettingsPanel slug={workspaceSlug} />
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

            {/* 072 백로그 S-C (FR-W01): 워크스페이스 아이콘 업로드/제거(ADMIN+). 전역
                아바타와 동일한 presign→MinIO→finalize 흐름. 미설정 시 이니셜 폴백. */}
            <div className="qf-field" data-testid="ws-icon-field">
              <span className="qf-field__label">워크스페이스 아이콘</span>
              <div className="flex items-center gap-[var(--s-4)]">
                <div
                  data-testid="ws-icon-preview"
                  aria-hidden
                  className="flex h-[var(--s-11)] w-[var(--s-11)] shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-lg)] bg-bg-subtle text-[length:var(--fs-16)] font-semibold text-text-muted"
                >
                  {workspace.iconUrl ? (
                    <img src={workspace.iconUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    workspace.name.slice(0, 2).toUpperCase()
                  )}
                </div>
                {canManageIcon ? (
                  <div className="flex flex-col gap-[var(--s-2)]">
                    <input
                      ref={iconInputRef}
                      type="file"
                      accept={WS_ICON_ALLOWED_MIME.join(',')}
                      data-testid="ws-icon-file"
                      // a11y(input-label-guard): 시각적으로 숨겨 버튼으로 트리거하지만
                      // 라벨 없는 input 은 가드 위반 — 접근명을 명시한다.
                      aria-label="워크스페이스 아이콘 이미지 선택"
                      onChange={onPickIcon}
                      className="hidden"
                    />
                    <div className="flex gap-[var(--s-2)]">
                      <Button
                        variant="secondary"
                        data-testid="ws-icon-upload"
                        onClick={() => iconInputRef.current?.click()}
                        disabled={uploadIcon.isPending || deleteIcon.isPending}
                        aria-busy={uploadIcon.isPending || undefined}
                      >
                        {uploadIcon.isPending ? '업로드 중…' : '이미지 변경'}
                      </Button>
                      {workspace.iconUrl ? (
                        <Button
                          variant="ghost"
                          data-testid="ws-icon-remove"
                          onClick={onRemoveIcon}
                          disabled={uploadIcon.isPending || deleteIcon.isPending}
                          aria-busy={deleteIcon.isPending || undefined}
                        >
                          제거
                        </Button>
                      ) : null}
                    </div>
                    <p className="qf-field__hint text-text-muted">
                      PNG · JPEG · WebP, 최대 {Math.floor(WS_ICON_MAX_BYTES / (1024 * 1024))}MB
                    </p>
                  </div>
                ) : (
                  <p className="text-[length:var(--fs-13)] text-text-muted">
                    아이콘 변경은 관리자(ADMIN) 이상만 가능합니다.
                  </p>
                )}
              </div>
              {iconErr ? (
                <p data-testid="ws-icon-error" role="alert" className="qf-field__error">
                  {iconErr}
                </p>
              ) : null}
            </div>

            {/* 072-N5-4 (FR-W01): 워크스페이스 이름 편집(OWNER 게이트). */}
            <div className="qf-field">
              <label className="qf-field__label" htmlFor="ws-settings-name">
                워크스페이스 이름
              </label>
              <input
                id="ws-settings-name"
                data-testid="ws-settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                disabled={!ownerEditable}
                aria-invalid={!nameValid || undefined}
                aria-describedby={!nameValid ? 'ws-settings-name-error' : undefined}
                className="qf-input w-full"
              />
              {!nameValid ? (
                <p
                  id="ws-settings-name-error"
                  data-testid="ws-settings-name-error"
                  role="status"
                  className="qf-field__hint text-[color:var(--danger)]"
                >
                  이름은 비울 수 없습니다.
                </p>
              ) : null}
            </div>

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

            {/* 072 백로그 S-C (FR-W01): 가입 모드(OWNER 전용). visibility 와 직교 —
                디스커버리 노출 여부와 별개로 "어떻게 들어오는가"를 정한다. */}
            <div className="qf-field">
              <label className="qf-field__label" htmlFor="ws-join-mode">
                가입 모드 <span className="text-text-muted">(OWNER 전용)</span>
              </label>
              <select
                id="ws-join-mode"
                data-testid="ws-join-mode"
                className="qf-input"
                disabled={!ownerEditable}
                value={joinMode}
                onChange={(e) => setJoinMode(e.target.value as WorkspaceJoinMode)}
              >
                <option value="PRIVATE">비공개 (PRIVATE) — 초대 전용</option>
                <option value="PUBLIC">공개 (PUBLIC) — 누구나 즉시 가입</option>
                <option value="APPLY">신청제 (APPLY) — 신청 후 승인</option>
              </select>
            </div>

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

            {/* S72 (FR-W15): 워크스페이스 삭제 — OWNER 전용. slug 타이핑 확인 모달을 거친다. */}
            {ownerEditable ? (
              <section
                data-testid="ws-delete-section"
                aria-labelledby="ws-delete-heading"
                className="flex flex-col gap-[var(--s-2)] border-t border-border-subtle pt-[var(--s-4)]"
              >
                <h3 id="ws-delete-heading" className="font-semibold text-[length:var(--fs-15)]">
                  워크스페이스 삭제
                </h3>
                <p id="ws-delete-warning" className="text-[length:var(--fs-13)] text-text-muted">
                  워크스페이스를 삭제하면 30일 후 영구적으로 사라집니다. 그 전까지는 복원할 수
                  있습니다. 모든 채널·메시지·멤버가 함께 제거됩니다.
                </p>
                <div>
                  <Button
                    variant="danger"
                    data-testid="ws-delete-open"
                    aria-describedby="ws-delete-warning"
                    // S72 fix-forward (a11y L-1): 다이얼로그를 여는 트리거임을 AT 에 알린다.
                    aria-haspopup="dialog"
                    onClick={() => {
                      setDeleteConfirm('');
                      setDangerErr(null);
                      setDeleteErr(null);
                      setDeleteOpen(true);
                    }}
                  >
                    워크스페이스 삭제
                  </Button>
                </div>
              </section>
            ) : null}

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

      {/* S72 (FR-W15): 워크스페이스 삭제 확인 모달. 파괴적·비가역적(30일 후 영구) 액션이라
          alertDialog 로 role="alertdialog" 를 노출하고, slug 를 정확히 타이핑해야 삭제
          버튼이 활성화된다(클라 검증 + 서버 422 최종 게이트). */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(o) => {
          setDeleteOpen(o);
          if (!o) {
            setDeleteConfirm('');
            // S72 fix-forward (a11y B-1): 모달 닫힘 시 내부 에러도 초기화한다.
            setDeleteErr(null);
          }
        }}
        alertDialog
        title="워크스페이스 삭제"
        description={`이 작업은 30일 후 되돌릴 수 없습니다. 확인을 위해 워크스페이스 식별자 "${workspaceSlug}" 를 그대로 입력하세요.`}
        className="w-[min(420px,92vw)]"
      >
        <div data-testid="ws-delete-confirm" className="flex flex-col gap-[var(--s-3)]">
          {/* S72 fix-forward (a11y H-2): slug 불일치를 AT 에 전달한다. 불일치+비어있지않음일
              때 aria-invalid 를 켜고, 아래 status 메시지를 aria-describedby 로 연결한다.
              autoComplete/ spellCheck 을 꺼 브라우저가 식별자 입력에 개입하지 않게 한다. */}
          <Input
            aria-label="워크스페이스 식별자 확인"
            data-testid="ws-delete-confirm-input"
            placeholder={workspaceSlug}
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            invalid={deleteConfirmMismatch}
            aria-describedby={deleteConfirmMismatch ? 'ws-delete-confirm-mismatch' : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {deleteConfirmMismatch ? (
            <p
              id="ws-delete-confirm-mismatch"
              data-testid="ws-delete-confirm-mismatch"
              role="status"
              className="qf-field__error"
            >
              식별자가 일치하지 않습니다.
            </p>
          ) : null}
          {/* S72 fix-forward (a11y B-1): 삭제 실패 에러를 모달 내부에서 role="alert" 로 알린다. */}
          {deleteErr ? (
            <p data-testid="ws-delete-error" role="alert" className="qf-field__error">
              {deleteErr}
            </p>
          ) : null}
          <div className="flex gap-[var(--s-2)] justify-end">
            <Button
              variant="ghost"
              data-testid="ws-delete-cancel"
              onClick={() => {
                setDeleteOpen(false);
                setDeleteConfirm('');
                setDeleteErr(null);
              }}
            >
              취소
            </Button>
            {/* S72 fix-forward (a11y H-2): disabled 를 유지하되 aria-disabled 를 병행해
                불활성 상태를 AT 에 명시한다. */}
            <Button
              variant="danger"
              data-testid="ws-delete-confirm-ok"
              onClick={onDelete}
              disabled={!deleteConfirmMatches || deleteWorkspace.isPending}
              aria-disabled={!deleteConfirmMatches || deleteWorkspace.isPending || undefined}
              aria-busy={deleteWorkspace.isPending || undefined}
            >
              {deleteWorkspace.isPending ? '삭제 중…' : '영구 삭제'}
            </Button>
          </div>
        </div>
      </Dialog>
    </SettingsOverlay>
  );
}
