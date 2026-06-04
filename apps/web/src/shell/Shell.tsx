import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router-dom';
import type { WorkspaceRole } from '@qufox/shared-types';
import { qk } from '../lib/query-keys';
import { useMyWorkspaces, useWorkspace } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { WorkspaceNav } from './WorkspaceNav';
import { ChannelColumn } from './ChannelColumn';
import { MessageColumn } from './MessageColumn';
import { MemberColumn } from './MemberColumn';
import { useUI } from '../stores/ui-store';
import { SearchResultPanelContainer } from '../features/search/SearchResultPanelContainer';
import { ActivityInboxPanel } from '../features/activity/ActivityInboxPanel';
import { MemberDirectoryPanel } from '../features/workspaces/MemberDirectoryPanel';
import { BottomBar } from './BottomBar';
import { ChannelSettingsPage } from '../features/channels/ChannelSettingsPage';
import { WorkspaceSettingsPage } from '../features/workspaces/WorkspaceSettingsPage';
import { useMembers } from '../features/workspaces/useWorkspaces';
import { useAuth } from '../features/auth/AuthProvider';
import { ToastViewport } from '../design-system/primitives';
import { OnboardingHost } from '../features/onboarding/OnboardingHost';
import { CommandPalette } from '../features/shortcuts/CommandPalette';
import { ShortcutHelp } from '../features/shortcuts/ShortcutHelp';
import { FeedbackDialog } from '../features/feedback/FeedbackDialog';
import { useGlobalShortcuts } from '../features/shortcuts/useShortcut';
import { useIsMobile } from '../lib/useBreakpoint';
import { MobileShell } from './MobileShell';

/**
 * Top-level Discord-style 3-column layout (4 counting the leftmost rail).
 * Renders the same React tree for every URL under /w/* — only the leaf
 * columns read the URL params, so switching channels does not remount the
 * shell.
 */
export function Shell(): JSX.Element {
  const isMobile = useIsMobile();
  // Task-024: branch on viewport at mount time. Crossing the 768px
  // breakpoint remounts via React's key-based reconciliation below —
  // live reflow across layouts isn't required and creates subtle
  // drag-state / scroll-state leaks.
  if (isMobile) return <MobileShell key="mobile" />;
  return <DesktopShell key="desktop" />;
}

function DesktopShell(): JSX.Element {
  // With the splat route `/w/:slug/*`, React Router delivers the
  // remainder under the `'*'` key. Parsing here keeps `channelName`
  // behaviour identical to the old discrete-param version without
  // remounting the Shell on a URL change.
  const params = useParams<{ slug: string; '*'?: string }>();
  const slug = params.slug;
  const rest = (params['*'] ?? '').split('/').filter(Boolean);
  // task-031-A: /w/:slug/settings opens the workspace-level settings
  // overlay. rest[0] === 'settings' (no channel segment).
  const inWorkspaceSettings = rest[0] === 'settings' && !rest[1];
  const channelName = inWorkspaceSettings ? undefined : rest[0];
  // URL shape: /w/:slug/:channel[/settings[/:section]]. Anything in rest[1]
  // named "settings" switches the middle column from MessageColumn to
  // ChannelSettingsPage while keeping the left rail + channel list intact.
  const inChannelSettings = rest[1] === 'settings';
  // S62 (FR-RM14): /w/:slug/:channel/settings/permissions 는 권한 오버라이드 섹션.
  // S64 (FR-RM09): /settings/moderation 은 메시지 일괄 삭제(bulk purge) 섹션.
  // 알 수 없는 section 은 'general' 로 폴백한다.
  const settingsSection: 'general' | 'permissions' | 'moderation' =
    rest[2] === 'permissions' ? 'permissions' : rest[2] === 'moderation' ? 'moderation' : 'general';
  // S30 (FR-S03): 검색 결과 패널이 활성이면 우측 패널(멤버 목록)을 대체한다.
  const searchPanelQuery = useUI((s) => s.searchPanelQuery);
  const activityInboxOpen = useUI((s) => s.activityInboxOpen);
  // S69 (FR-W10 · Fork C): 멤버 디렉터리 오버레이(모든 멤버 진입점).
  const memberDirectoryOpen = useUI((s) => s.memberDirectoryOpen);
  const { user } = useAuth();
  const { data: mine, isLoading } = useMyWorkspaces();
  // task-040 R3 + reviewer H1: realtime is now installed once at App
  // root via AppRealtimeHost so the ConnectionBanner survives every
  // shell early-return path. Shell only needs the side-effects of
  // the dispatcher being installed — the singleton in socket.ts is
  // already running.
  useGlobalShortcuts();
  // task-019-D: warm the notification-preferences cache so the
  // dispatcher's synchronous resolver hits immediately instead of
  // falling back to defaults for the first volley of events.
  useNotificationPreferences();

  const active = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: channels } = useChannelList(active?.id);

  // S69 (FR-W20): 워크스페이스 전환 시 새 워크스페이스의 unread-summary 를 재로드한다
  // (이전 워크스페이스 → 새 워크스페이스). 채널 룸 leave/join 은 게이트웨이가 connect 시
  // 모든 가입 워크스페이스를 auto-join 하므로 별도 emit 없이, FE 는 활성 전환 시 unread
  // 캐시를 무효화해 새 워크스페이스 사이드바 배지를 즉시 갱신한다. 비활성 워크스페이스의
  // 멘션 배지는 connection:ready/unread_count:increment(badgeStore)가 유지한다.
  const qc = useQueryClient();
  const prevWsRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const wsId = active?.id;
    if (wsId && prevWsRef.current !== wsId) {
      prevWsRef.current = wsId;
      qc.invalidateQueries({ queryKey: qk.channels.unreadSummary(wsId) });
    }
  }, [active?.id, qc]);

  const activeChannel = useMemo(() => {
    if (!channels || !channelName) return null;
    const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
    return flat.find((c) => c.name === channelName) ?? null;
  }, [channels, channelName]);

  if (isLoading) {
    return (
      <div data-testid="shell-loading" className="qf-empty h-full">
        <div className="qf-empty__body">loading…</div>
      </div>
    );
  }

  // No workspaces yet → land on /dm (messages). DM + discover are both
  // accessible to a zero-workspace account, so we no longer force the
  // user into the create-workspace page on signup. They can create one
  // voluntarily via the "+" button on the server rail.
  if ((mine?.workspaces.length ?? 0) === 0) {
    return <Navigate to="/dm" replace />;
  }

  // Workspace id in URL but doesn't exist for me → go home.
  if (slug && !active) {
    return (
      <div data-testid="shell-ws-not-found" className="qf-empty h-full">
        <div className="qf-empty__title">워크스페이스를 찾을 수 없습니다</div>
      </div>
    );
  }

  // If no slug at all, redirect to the first workspace the user is in.
  if (!slug && mine) {
    return <Navigate to={`/w/${mine.workspaces[0].slug}`} replace />;
  }

  return (
    <div data-testid="shell-root" className="flex h-full bg-background text-foreground">
      {/* Left stack: server rail + channel list share the full height with
          a bottom-bar pinned under them. Main chat + member list below
          live in their own columns and run floor-to-ceiling. */}
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <WorkspaceNav workspaces={mine?.workspaces ?? []} activeSlug={slug ?? null} />
          {active ? (
            <ChannelColumn workspace={active} activeChannelName={activeChannel?.name ?? null} />
          ) : null}
        </div>
        <BottomBar />
      </div>
      {active && activeChannel ? (
        <MessageColumn
          workspaceId={active.id}
          workspaceSlug={active.slug}
          channelId={activeChannel.id}
          channelName={activeChannel.name}
          channelTopic={activeChannel.topic ?? null}
          channelType={activeChannel.type}
        />
      ) : (
        <main className="qf-empty flex-1">
          <div className="qf-empty__title">
            {active ? '채널을 선택하세요.' : '워크스페이스를 선택하세요.'}
          </div>
          <div className="qf-empty__body">
            좌측 사이드바에서 {active ? '채널' : '워크스페이스'}을(를) 선택해 대화를 시작하세요.
          </div>
        </main>
      )}
      {/* S30 (FR-S03): 검색 패널 활성 시 우측 슬롯을 결과 패널로 대체.
          S47 (FR-MN-13): 그 다음 우선순위로 Activity Inbox 패널, 둘 다 닫혀 있으면
          멤버 목록. 우선순위 search > inbox > members. */}
      {active && activeChannel && memberDirectoryOpen ? (
        <MemberDirectoryHost workspaceId={active.id} currentUserId={user?.id ?? null} />
      ) : active && activeChannel && searchPanelQuery !== null ? (
        <SearchResultPanelContainer workspaceId={active.id} workspaceSlug={active.slug} />
      ) : active && activeChannel && activityInboxOpen ? (
        <ActivityInboxPanel />
      ) : active && activeChannel ? (
        <MemberColumn workspaceId={active.id} />
      ) : null}
      {/* Settings screens are full-viewport overlays — they sit on top
          of the shell via a portal. Reusing SettingsOverlay for every
          future settings surface (workspace, account, …) keeps the
          chrome consistent. */}
      {active && activeChannel && inChannelSettings ? (
        <ChannelSettingsPage
          workspaceId={active.id}
          workspaceSlug={active.slug}
          channel={activeChannel}
          section={settingsSection}
        />
      ) : null}
      {active && inWorkspaceSettings ? (
        <WorkspaceSettingsOverlayHost workspace={active} workspaceSlug={active.slug} />
      ) : null}
      {/* S71 (D13 / FR-W07·W08·W09): 신규 멤버 온보딩 오버레이. 규칙/질문/웰컴이 있고
          미완료일 때만 전체화면 모달로 마운트된다(OWNER·빈 카탈로그는 미표시 — Fork A-1). */}
      {active ? <OnboardingHost workspaceId={active.id} slug={active.slug} /> : null}
      <CommandPalette />
      <ShortcutHelp />
      <FeedbackDialog />
      <ToastViewport />
    </div>
  );
}

/**
 * S69 (D13 / FR-W10 · Fork C): 멤버 디렉터리 호스트. 열람은 모든 멤버지만, 관리 액션
 * (역할변경/kick/timeout)은 myRole(ADMIN+/MODERATOR)로 게이트한다. myRole 은
 * getWorkspace(WorkspaceWithMyRole) 캐시에서 읽어 추가 멤버 전체로드를 피한다.
 */
function MemberDirectoryHost({
  workspaceId,
  currentUserId,
}: {
  workspaceId: string;
  currentUserId: string | null;
}): JSX.Element {
  const { data } = useWorkspace(workspaceId);
  const myRole = data?.myRole ?? 'MEMBER';
  const canManage = myRole === 'OWNER' || myRole === 'ADMIN' || myRole === 'MODERATOR';
  return (
    <aside
      // S69 fix-forward (a11y H-01): MessageColumn 디렉터리 버튼의 aria-controls 대상.
      id="member-directory-panel"
      aria-label="멤버 디렉터리"
      // S69 fix-forward (ui LOW): qf-memberlist 가 이미 패딩을 제공하므로 Tailwind p-*
      // 재정의를 제거한다(DS 기본 패딩과의 충돌 해소).
      className="qf-memberlist flex min-w-0 flex-col"
    >
      <MemberDirectoryPanel
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        canManage={canManage}
      />
    </aside>
  );
}

function WorkspaceSettingsOverlayHost({
  workspace,
  workspaceSlug,
}: {
  workspace: {
    id: string;
    name: string;
    description: string | null;
    visibility: 'PUBLIC' | 'PRIVATE';
    category: string | null;
    // S65 (FR-W19): 현재 기본 채널(셀렉트 초기값).
    defaultChannelId?: string | null;
    // S68 (FR-W05): 이메일 도메인 화이트리스트(도메인 패널 초기값).
    emailDomains?: string[];
  };
  workspaceSlug: string;
}): JSX.Element | null {
  const { user } = useAuth();
  const { data: members } = useMembers(workspace.id);
  // S65 (FR-W13/W19): 소유권 양도 대상 + 기본 채널 후보를 설정 페이지로 넘긴다.
  const { data: channels } = useChannelList(workspace.id);
  // S65 fix-forward (ui MAJOR-3 = perf MINOR — 실제 버그): 시스템 역할 5단계 전체로
  // cast 한다. 종전 'OWNER'|'ADMIN'|'MEMBER' 3단계 truncation 은 MODERATOR/GUEST 를
  // 폴백 'MEMBER' 로 떨어뜨려, 실제 MODERATOR 가 설정 오버레이에서 신고 큐 탭을
  // 못 보는 버그를 만들었다(canModerateReports = myRole === 'MODERATOR' 가 항상 false).
  const myRole = (members?.members.find((m) => m.userId === user?.id)?.role ??
    'MEMBER') as WorkspaceRole;
  const memberOptions = useMemo(
    () =>
      (members?.members ?? [])
        // 본인은 양도 대상에서 제외(서버도 자기 자신 양도를 거부).
        .filter((m) => m.userId !== user?.id)
        .map((m) => ({ userId: m.userId, username: m.user.username })),
    [members, user?.id],
  );
  const channelOptions = useMemo(() => {
    if (!channels) return [];
    const flat = [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)];
    return flat.map((c) => ({ id: c.id, name: c.name, isPrivate: c.isPrivate }));
  }, [channels]);
  return (
    <WorkspaceSettingsPage
      workspace={{
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        visibility: workspace.visibility,
        category: workspace.category as never,
        defaultChannelId: workspace.defaultChannelId ?? null,
        // S68 (FR-W05): 이메일 도메인 패널 초기값. 응답에 없으면 빈 배열.
        emailDomains: workspace.emailDomains ?? [],
      }}
      myRole={myRole}
      workspaceSlug={workspaceSlug}
      members={memberOptions}
      channels={channelOptions}
    />
  );
}
