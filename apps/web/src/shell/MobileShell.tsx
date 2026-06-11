import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useMyWorkspaces, useMembers } from '../features/workspaces/useWorkspaces';
import { useChannelList } from '../features/channels/useChannels';
// 071-M2 E5 (FR-IA-MOB-03): 채널 둘러보기 — 데스크톱 ChannelBrowser + SettingsOverlay
// 재사용(모바일에서 풀스크린 오버레이로 동작).
import { ChannelBrowser } from '../features/channels/ChannelBrowser';
import { SettingsOverlay } from '../design-system/primitives';
import { useAuth } from '../features/auth/AuthProvider';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import { Icon } from '../design-system/primitives';
import { FeedbackDialog } from '../features/feedback/FeedbackDialog';
import { MobileChannelList } from './mobile/MobileChannelList';
import { MobileMessages } from './mobile/MobileMessages';
import { MobileMembers } from './mobile/MobileMembers';
import { MobileTabBar } from './mobile/MobileTabBar';
// 071-M2 E2 (A안): 드로어 오버레이 → DS OverlappingPanels 3패널 셸.
import { MobilePanels, type PanelSide } from './mobile/MobilePanels';
// 071-M3 F1: /w/:slug/settings — 데스크톱 설정 호스트(내부 탭에 일반/신고 큐/감사
// 로그 등 내장)를 직마운트한다(최소안 — qf-m-* 드릴다운 변형은 후속).
import { WorkspaceSettingsOverlayHost } from './Shell';
// 071-M3 F2: 서버 메뉴 시트 + 진입 대상들(데스크톱 컴포넌트 재사용).
import { MobileServerMenuSheet } from './mobile/MobileServerMenuSheet';
// 071-M3 F3: 채널 핀 목록(topbar 버튼 + 풀스크린 오버레이 + ?msg= 점프).
import { MobilePinList } from './mobile/MobilePinList';
import { usePinCount } from '../features/messages/useMessages';
import { useMemo as useMemoReact } from 'react';
import { CreateChannelModal } from '../features/channels/CreateChannelModal';
import { CreateCategoryModal } from '../features/channels/CreateCategoryModal';
import { CreateInviteModal } from '../features/workspaces/CreateInviteModal';
import { InviteManagerPanel } from '../features/workspaces/InviteManagerPanel';
import { MemberDirectoryPanel } from '../features/workspaces/MemberDirectoryPanel';
import { useLeaveWorkspace } from '../features/workspaces/useWorkspaces';
import { useNotifications } from '../stores/notification-store';
// 071-M3 F8 (FR-PS-08 모바일 / 감사 B-87): 전체 프로필 — ui-store 구독 자기완결
// 패널을 모바일 풀스크린 변형으로 마운트(ProfilePopover '전체 프로필'이 연다).
import { MemberProfilePanel } from '../features/profile/MemberProfilePanel';
// ★F11 리뷰 H-2: 풀스크린 오버레이/프로필도 하드웨어 back 으로 닫혀야 한다.
import { useSheetHistoryMarker } from './mobile/useSheetHistoryMarker';
import { useUI } from '../stores/ui-store';
import { OnboardingHost } from '../features/onboarding/OnboardingHost';
import { useKeyboardDodge } from '../lib/useKeyboardDodge';
import './mobile/mobile-kb-dodge.css';
import './mobile/mobile-touch-target.css';

/**
 * Task-024 mobile shell — qf-m-screen root, qf-m-topbar header,
 * qf-m-body scrollable middle, qf-m-tabbar footer. Left drawer
 * (menu → workspaces + channels) + right drawer (users → members).
 * Desktop shell stays unchanged; Shell.tsx branches on a 768px
 * media-query via useIsMobile.
 *
 * Non-goals per task-024 scope: voice rooms, rich-text toolbar,
 * custom emoji, mobile-specific push notification settings (all
 * exist on desktop, reachable from the You tab's redirect on click).
 */
export function MobileShell(): JSX.Element {
  const params = useParams<{ slug: string; '*'?: string }>();
  const slug = params.slug;
  const rest = (params['*'] ?? '').split('/').filter(Boolean);
  // 071-M3 F1 (감사 A-43/A-48): /w/:slug/settings 는 채널명이 아니라 워크스페이스
  // 설정이다 — 데스크톱 Shell 과 동일 분기. 종전 모바일은 rest[0] 을 무조건
  // 채널명으로 해석해 설정 URL 이 '채널을 선택하세요' 데드엔드였다.
  const inWorkspaceSettings = rest[0] === 'settings' && !rest[1];
  const channelName = inWorkspaceSettings ? undefined : (rest[0] ?? undefined);
  const { data: mine, isLoading } = useMyWorkspaces();
  // task-040 R3 + reviewer H1: realtime now App-level (see App.tsx
  // AppRealtimeHost). Banner survives mobile early-returns.
  useNotificationPreferences();
  // visualViewport-driven keyboard dodge — shrinks qf-m-body when the
  // software keyboard opens so the composer doesn't get covered.
  useKeyboardDodge();

  const active = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: channels } = useChannelList(active?.id);
  const flatChannels = useMemo(
    () =>
      channels
        ? [...channels.uncategorized, ...channels.categories.flatMap((c) => c.channels)]
        : null,
    [channels],
  );
  const activeChannel = useMemo(() => {
    if (!flatChannels || !channelName) return null;
    return flatChannels.find((c) => c.name === channelName) ?? null;
  }, [flatChannels, channelName]);

  // 071-M2 E2: 단일 패널 상태(center/left/right) — DS .qf-m-panels 상태 수식자와 1:1.
  const [panel, setPanel] = useState<PanelSide>('center');
  // 071-M2 E5 (FR-IA-MOB-03/02): 채널 둘러보기 오버레이 + 멤버수 표기용 데이터.
  const [browseOpen, setBrowseOpen] = useState(false);
  const { user } = useAuth();
  const { data: membersData } = useMembers(active?.id);
  const memberCount = membersData?.members.length ?? 0;
  const myRole = membersData?.members.find((m) => m.userId === user?.id)?.role ?? null;
  // 071-M3 F1 (정찰 충돌 조율): 용도별 게이트 분리 — 단일 canManage 확장 금지.
  // canManageWorkspace = 채널/카테고리 생성·워크스페이스 설정(OWNER/ADMIN),
  // canModerate = 신고 큐 등 모더레이션(MODERATOR 포함 — 데스크톱 Shell 정본).
  const canManageWorkspace = myRole === 'OWNER' || myRole === 'ADMIN';
  const canModerate = canManageWorkspace || myRole === 'MODERATOR';
  // 071-M3 F2: 서버 메뉴 시트 + 진입 대상 상태.
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [overlay, setOverlay] = useState<'invites' | 'directory' | 'pins' | null>(null);
  // ★F11 리뷰 H-2: 풀스크린 표면(초대 관리/핀 목록/디렉터리 오버레이 + 전체
  // 프로필)이 back 마커 없이 떠서 하드웨어 back 이 화면 밑 라우터를 되감았다 —
  // useSheetHistoryMarker 규약('신규 시트는 반드시 이 훅') 적용.
  useSheetHistoryMarker(overlay !== null, () => setOverlay(null));
  const profilePanelUserId = useUI((s) => s.profilePanelUserId);
  const setProfilePanelUser = useUI((s) => s.setProfilePanelUser);
  useSheetHistoryMarker(!!profilePanelUserId, () => setProfilePanelUser(null));
  // F3: 핀 카운트 배지(채널 컨텍스트에서만 — DM/설정 화면 비활성).
  const { data: pinCountData } = usePinCount(active?.id ?? null, activeChannel?.id ?? '');
  const nameByUserId = useMemoReact(() => {
    const m = new Map<string, string>();
    for (const x of membersData?.members ?? []) m.set(x.userId, x.user.username);
    return m;
  }, [membersData]);
  // ★F11 리뷰 M-6: MEMBER 는 채널의 memberCanPin 비트를 실제로 읽는다 — 종전
  // `(myRole==='MEMBER' && true)` 항등식은 비트를 무시해, 같은 채널의 롱프레스
  // 시트 게이트(MobileMessages — memberCanPin 검사)와 모순된 해제 X 를 노출했다.
  const canPinViewer =
    canManageWorkspace || (myRole === 'MEMBER' && (activeChannel?.memberCanPin ?? true));
  const leaveMut = useLeaveWorkspace(active?.id ?? '');
  const pushToast = useNotifications((st) => st.push);
  // ★F11 리뷰 M-9: 마커 소거(history.back)는 비동기 트래버설 — 고정 지연(80ms)
  // 대신 popstate 핸드셰이크로 기다린다(느린 기기에서 타이머가 트래버설을
  // 앞지르면 방금 연 시트가 즉시 닫히는 역전 봉인). 마커가 없으면 즉시 실행.
  const afterMarkerSettles = (hadMarker: boolean, fn: () => void): void => {
    if (!hadMarker) {
      fn();
      return;
    }
    let fired = false;
    const fire = (): void => {
      if (fired) return;
      fired = true;
      window.removeEventListener('popstate', fire);
      fn();
    };
    window.addEventListener('popstate', fire);
    window.setTimeout(fire, 200); // 안전망 — 마커 소거가 스킵된 경우(top 이 마커가 아님)
  };
  // F2 ★레이스 봉인: 좌패널이 열린 상태에서 시트를 동시 오픈하면 MobilePanels 의
  // back 마커 소거(history.back)가 방금 push 된 시트 마커를 pop 해 시트가 즉시
  // 닫힌다. 패널을 먼저 닫고 popstate 소화 후 시트를 연다 — 패널발 시트/오버레이
  // 오픈(F2 서버 메뉴·우패널 디렉터리 등)은 반드시 이 헬퍼를 쓴다.
  // (F5 채널 롱프레스 시트는 패널을 닫지 않고 그 위에 뜬다 — MobilePanels onPop
  // 계층 가드가 보호하므로 이 헬퍼 미사용.)
  const openSheetFromPanel = (fn: () => void): void => {
    const hadMarker = (window.history.state as { qfPanel?: string } | null)?.qfPanel !== undefined;
    setPanel('center');
    afterMarkerSettles(hadMarker, fn);
  };
  const navigate = useNavigate();
  const location = useLocation();
  const [sp, setSp] = useSearchParams();

  // FR-IA-WS-01(071-M0 C11) + A-24(C5): 채널 활성 시 lastChannel 을 기억하고,
  // 채널 없는 /w/:slug 진입은 ①`?ch=<channelId>`(Activity 점프 — 채널 목록 로드 후
  // 이름으로 해석) → ②저장된 lastChannel → ③최상단 채널 순으로 자동 복원한다.
  // 종전엔 모든 워크스페이스 전환이 '채널을 선택하세요' 빈 화면에 떨어졌다(P0 미구현).
  useEffect(() => {
    if (!active) return;
    // 071-M3 F1 ★함정 가드: 설정 화면(channelName=undefined)에서 이 자동복원이
    // 발화하면 /w/:slug/<채널> 로 강제 리다이렉트돼 설정에서 즉시 튕긴다.
    if (inWorkspaceSettings) return;
    if (activeChannel) {
      try {
        localStorage.setItem(`ws:${active.id}:lastChannel`, activeChannel.id);
      } catch {
        /* storage 불가 환경은 복원만 포기 */
      }
      return;
    }
    // 채널명이 있는데 못 찾은 경우(삭제/권한)는 리다이렉트하지 않고 현 상태 유지.
    if (channelName || !flatChannels || flatChannels.length === 0) return;
    const chParam = sp.get('ch');
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(`ws:${active.id}:lastChannel`);
    } catch {
      stored = null;
    }
    const target =
      (chParam ? flatChannels.find((c) => c.id === chParam) : undefined) ??
      (stored ? flatChannels.find((c) => c.id === stored) : undefined) ??
      flatChannels[0];
    if (!target) return;
    const qs = new URLSearchParams();
    const msg = sp.get('msg');
    const thread = sp.get('thread');
    if (msg) qs.set('msg', msg);
    if (thread) qs.set('thread', thread);
    const qsStr = qs.toString();
    navigate(`/w/${active.slug}/${target.name}${qsStr ? `?${qsStr}` : ''}`, { replace: true });
  }, [active, activeChannel, channelName, flatChannels, sp, navigate, inWorkspaceSettings]);

  // Close the side panels on route change — covers hardware back, channel
  // picks that navigate, and tab taps. Matches user intent: the panel
  // is a per-screen modal, not a persistent surface.
  useEffect(() => {
    setPanel('center');
  }, [location.pathname]);

  if (isLoading) {
    return (
      <div data-testid="mobile-shell-loading" className="qf-m-screen qf-m-screen--app">
        <div className="qf-m-empty">
          <div className="qf-m-empty__body">loading…</div>
        </div>
      </div>
    );
  }
  // No workspaces yet → land on /dm instead of forcing workspace
  // creation; DM + discover are both available to a zero-workspace
  // account. (Desktop Shell.tsx has the same redirect.)
  if ((mine?.workspaces.length ?? 0) === 0) return <Navigate to="/dm" replace />;
  // 071-M2 E4 (A안): 홈(`?chat=` 오버레이) 모델 폐기 — '/' 는 채팅 탭의 기본
  // 컨텍스트로 보낸다: 마지막 채팅 위치(sessionStorage) → 첫 워크스페이스
  // (lastChannel 복원은 /w/:slug 진입 effect 가 수행) 순. 워크스페이스 0개는
  // 위에서 이미 /dm 으로 빠졌다.
  if (!slug) {
    let last: string | null = null;
    try {
      last = sessionStorage.getItem('qf:lastChatPath');
    } catch {
      last = null;
    }
    // M2 리뷰 M-2: 탈퇴/추방으로 stale 해진 lastChatPath(/w/<없는 slug>/…)는
    // 무시하고 항목도 지운다 — 그대로 보내면 ws-not-found 함정에 떨어진다.
    // L-7③: '//host' 류는 차단(출처가 자체 pathname 뿐이라 방어적 봉인).
    if (last && last.startsWith('/') && !last.startsWith('//')) {
      const m = last.match(/^\/w\/([^/]+)\//);
      const stale = m && !mine?.workspaces.some((w) => w.slug === m[1]);
      if (!stale) return <Navigate to={last} replace />;
      try {
        sessionStorage.removeItem('qf:lastChatPath');
      } catch {
        /* noop */
      }
    }
    return <Navigate to={`/w/${mine!.workspaces[0].slug}`} replace />;
  }
  if (!active) {
    // M2 리뷰 M-2: 종전엔 topbar 만 렌더해 앱 내 탈출 수단이 없는 함정 화면이었다
    // — 탭바를 장착해 채팅/나 탭 등으로 빠져나갈 수 있게 한다. (L-4: 도달 불가
    // 분기였던 `!slug && mine` / 후행 `!active` 도 이 단일 분기로 정리.)
    return (
      <div data-testid="mobile-shell-ws-not-found" className="qf-m-screen qf-m-screen--app">
        <header className="qf-m-topbar qf-m-safe-top">
          <div className="qf-m-topbar__titleBlock">
            <div className="qf-m-topbar__title">워크스페이스를 찾을 수 없습니다</div>
          </div>
        </header>
        <main className="qf-m-body flex min-h-0 flex-col">
          <div className="qf-m-empty flex-1">
            <div className="qf-m-empty__body">초대가 만료됐거나 탈퇴한 워크스페이스예요.</div>
          </div>
        </main>
        <MobileTabBar />
      </div>
    );
  }

  const topbarTitle = inWorkspaceSettings
    ? '워크스페이스 설정'
    : activeChannel
      ? `# ${activeChannel.name}`
      : active.name;
  const topbarSubtitle = inWorkspaceSettings
    ? active.name
    : activeChannel
      ? active.name
      : '채널을 선택하세요';

  return (
    // 071-M2 E2 (A안): 드로어 오버레이 모델 폐기 — DS OverlappingPanels.
    // 좌 패널 = 워크스페이스 레일 + 채널 목록(qf-m-safe-top 으로 노치 회피),
    // 우 패널 = 멤버 목록(활성 채널일 때만 — 엣지 제스처도 함께 비활성),
    // 중앙 = topbar + 채팅 + 탭바(기존 qf-m-screen 골격 유지).
    <MobilePanels
      open={panel}
      onOpenChange={setPanel}
      left={
        <div className="qf-m-safe-top" data-testid="mobile-left-panel">
          <MobileChannelList
            workspace={active}
            workspaces={mine?.workspaces ?? []}
            activeChannelName={activeChannel?.name ?? null}
            onPick={() => setPanel('center')}
            onBrowse={() => {
              setPanel('center');
              setBrowseOpen(true);
            }}
            onMenu={() => openSheetFromPanel(() => setServerMenuOpen(true))}
          />
        </div>
      }
      right={
        activeChannel ? (
          <div className="qf-m-safe-top" data-testid="mobile-right-panel">
            <MobileMembers
              workspaceId={active.id}
              onDirectory={() => openSheetFromPanel(() => setOverlay('directory'))}
            />
          </div>
        ) : null
      }
    >
      <div data-testid="mobile-shell" className="qf-m-screen qf-m-screen--app">
        <header className="qf-m-topbar qf-m-safe-top">
          <button
            type="button"
            data-testid="mobile-topbar-menu"
            className="qf-m-topbar__back"
            aria-label="채널 목록 열기"
            aria-expanded={panel === 'left'}
            onClick={() => setPanel(panel === 'left' ? 'center' : 'left')}
          >
            <Icon name="grid" size="md" />
          </button>
          <div className="qf-m-topbar__titleBlock">
            <div className="qf-m-topbar__title">{topbarTitle}</div>
            <div className="qf-m-topbar__subtitle">{topbarSubtitle}</div>
          </div>
          <div className="qf-m-topbar__actions">
            {activeChannel ? (
              // 071-M3 F3 (FR-PS-04): 핀 목록 버튼(카운트 병기).
              <button
                type="button"
                data-testid="mobile-topbar-pin"
                className="qf-m-topbar__action"
                aria-label={`고정된 메시지 (${pinCountData?.used ?? 0}개)`}
                aria-expanded={overlay === 'pins'}
                onClick={() => setOverlay('pins')}
              >
                <Icon name="pin" size="md" />
                {(pinCountData?.used ?? 0) > 0 ? (
                  <span
                    data-testid="mobile-pin-count"
                    className="text-[length:var(--fs-11)] text-text-muted"
                  >
                    {pinCountData!.used}
                  </span>
                ) : null}
              </button>
            ) : null}
            {activeChannel ? (
              // 071-M2 E5 (FR-IA-MOB-02): 멤버 버튼에 멤버 수 병기 + aria-expanded.
              <button
                type="button"
                data-testid="mobile-topbar-members"
                className="qf-m-topbar__action"
                aria-label={`멤버 보기 (${memberCount}명)`}
                aria-expanded={panel === 'right'}
                onClick={() => setPanel(panel === 'right' ? 'center' : 'right')}
              >
                <Icon name="users" size="md" />
                {memberCount > 0 ? (
                  <span
                    data-testid="mobile-member-count"
                    className="text-[length:var(--fs-11)] text-text-muted"
                  >
                    {memberCount}
                  </span>
                ) : null}
              </button>
            ) : null}
          </div>
        </header>

        {/* H-2(071-M0 C1): qf-m-body 는 display:flex 가 아니라서 MobileMessages 의
            리스트(flex-1 min-h-0)가 무효 — 리스트가 내용 높이만큼 자라 컴포저가 화면 밖으로
            밀리고 하단 앵커/스크롤 페치가 전부 죽었다. flex-col 을 명시해 오버레이/DM 경로와
            동일한 골격(리스트 내부 스크롤 + 컴포저 고정)을 만든다. */}
        <main className="qf-m-body flex min-h-0 flex-col">
          {inWorkspaceSettings ? (
            // F1: 설정 본문 — 데스크톱 페이지 직마운트(가로 탭은 스크롤 허용).
            <div
              data-testid="mobile-ws-settings"
              className="min-h-0 flex-1 overflow-y-auto [&_[role=tablist]]:overflow-x-auto"
            >
              <WorkspaceSettingsOverlayHost
                workspace={{
                  id: active.id,
                  name: active.name,
                  description: active.description ?? null,
                  visibility: active.visibility,
                  category: (active as { category?: string | null }).category ?? null,
                  defaultChannelId:
                    (active as { defaultChannelId?: string | null }).defaultChannelId ?? null,
                  emailDomains: (active as { emailDomains?: string[] }).emailDomains ?? [],
                }}
                workspaceSlug={active.slug}
              />
            </div>
          ) : activeChannel ? (
            <MobileMessages
              workspaceId={active.id}
              workspaceSlug={active.slug}
              channelId={activeChannel.id}
              channelName={activeChannel.name}
            />
          ) : (
            <div className="qf-m-empty flex-1">
              <div className="qf-m-empty__title">채널을 선택하세요</div>
              <div className="qf-m-empty__body">좌상단 메뉴에서 채널을 고르면 대화가 시작돼요.</div>
            </div>
          )}
        </main>

        {/* 071-M2 E3: PRD 5탭 — 탭바가 내부 라우팅(채팅 복귀=lastChatPath)을 소유한다. */}
        <MobileTabBar />

        {/* S71 (D13 / FR-W07·W08·W09): 모바일 가입자도 온보딩 오버레이를 받는다 — 규칙 동의
            게이트가 서버측이라 오버레이가 없으면 메시지가 영구 차단된다(ui INFO · 기능 필수). */}
        <OnboardingHost workspaceId={active.id} slug={active.slug} />
        <FeedbackDialog />

        {/* 071-M2 E5 (FR-IA-MOB-03): 채널 둘러보기 — 데스크톱 컴포넌트 재사용.
            채널 생성 모달은 M3 도달성에서 모바일 변형 — 여기서는 닫기만. */}
        <SettingsOverlay
          open={browseOpen}
          onClose={() => setBrowseOpen(false)}
          title="채널 둘러보기"
          testId="mobile-channel-browser-overlay"
        >
          <ChannelBrowser
            workspaceId={active.id}
            workspaceSlug={active.slug}
            canManage={canManageWorkspace}
            onCreateChannel={() => {
              // M3 F2 (M2 이월 해소): 종전엔 닫기만 했음 — 생성 모달로 연결.
              setBrowseOpen(false);
              setCreateChannelOpen(true);
            }}
          />
        </SettingsOverlay>

        {/* 071-M3 F2: 서버 메뉴 시트 + 진입 대상들. */}
        {serverMenuOpen ? (
          <MobileServerMenuSheet
            workspaceName={active.name}
            onClose={() => setServerMenuOpen(false)}
            onDirectory={() => {
              setServerMenuOpen(false);
              setOverlay('directory');
            }}
            onBrowse={() => {
              setServerMenuOpen(false);
              setBrowseOpen(true);
            }}
            onCreateChannel={
              canManageWorkspace
                ? () => {
                    setServerMenuOpen(false);
                    setCreateChannelOpen(true);
                  }
                : undefined
            }
            onCreateCategory={
              canManageWorkspace
                ? () => {
                    setServerMenuOpen(false);
                    setCreateCategoryOpen(true);
                  }
                : undefined
            }
            onInvite={
              canModerate
                ? () => {
                    setServerMenuOpen(false);
                    setInviteOpen(true);
                  }
                : undefined
            }
            onManageInvites={
              canModerate
                ? () => {
                    setServerMenuOpen(false);
                    setOverlay('invites');
                  }
                : undefined
            }
            onSettings={
              canManageWorkspace
                ? () => {
                    setServerMenuOpen(false);
                    navigate(`/w/${active.slug}/settings`);
                  }
                : undefined
            }
            onLeave={
              myRole && myRole !== 'OWNER'
                ? () => {
                    setServerMenuOpen(false);
                    leaveMut.mutate(undefined, {
                      onSuccess: () => {
                        try {
                          sessionStorage.removeItem('qf:lastChatPath');
                        } catch {
                          /* noop */
                        }
                        navigate('/');
                      },
                      onError: () =>
                        pushToast({
                          variant: 'danger',
                          title: '워크스페이스를 나가지 못했습니다',
                          body: '잠시 후 다시 시도하세요.',
                          ttlMs: 4000,
                        }),
                    });
                  }
                : undefined
            }
          />
        ) : null}
        <CreateChannelModal
          workspaceId={active.id}
          categoryId={null}
          categoryLabel="채널"
          open={createChannelOpen}
          onClose={() => setCreateChannelOpen(false)}
        />
        <CreateCategoryModal
          workspaceId={active.id}
          open={createCategoryOpen}
          onClose={() => setCreateCategoryOpen(false)}
        />
        <CreateInviteModal workspaceId={active.id} open={inviteOpen} onOpenChange={setInviteOpen} />
        <SettingsOverlay
          open={overlay === 'invites'}
          onClose={() => setOverlay(null)}
          title="초대 관리"
          testId="mobile-invites-overlay"
        >
          <InviteManagerPanel workspaceId={active.id} />
        </SettingsOverlay>
        <SettingsOverlay
          open={overlay === 'pins'}
          onClose={() => setOverlay(null)}
          title="고정된 메시지"
          testId="mobile-pins-overlay"
        >
          {activeChannel ? (
            <MobilePinList
              workspaceId={active.id}
              channelId={activeChannel.id}
              nameByUserId={nameByUserId}
              canUnpin={canPinViewer}
              onJump={(messageId) => {
                // ★F11 H-2 후속: 오버레이가 back 마커를 갖게 되어, 닫힘의 마커
                // 소거(back)와 ?msg= 내비게이션이 경합하면 파라미터가 트래버설에
                // 유실된다 — 마커 소화 후 세팅한다(URL 은 fire 시점 기준 재구성).
                const hadMarker =
                  (window.history.state as { qfSheet?: boolean } | null)?.qfSheet === true;
                setOverlay(null);
                afterMarkerSettles(hadMarker, () => {
                  // 현재 채널 URL 에 ?msg= 만 세팅 — MobileMessages 의 기존 점프
                  // 소비(스크롤+2초 강조+파라미터 정리)가 처리한다.
                  const next = new URLSearchParams(window.location.search);
                  next.set('msg', messageId);
                  setSp(next, { replace: true });
                });
              }}
            />
          ) : null}
        </SettingsOverlay>
        {/* F8: 전체 프로필(풀스크린) — profilePanelUserId 가 null 이면 자체 미렌더. */}
        <MemberProfilePanel workspaceId={active.id} mobile />
        <SettingsOverlay
          open={overlay === 'directory'}
          onClose={() => setOverlay(null)}
          title="멤버 디렉터리"
          testId="mobile-directory-overlay"
        >
          <MemberDirectoryPanel
            workspaceId={active.id}
            currentUserId={user?.id ?? ''}
            canManage={canModerate}
          />
        </SettingsOverlay>
      </div>
    </MobilePanels>
  );
}
