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
  const channelName = rest[0] ?? undefined;
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
  const canManage = myRole === 'OWNER' || myRole === 'ADMIN';
  const navigate = useNavigate();
  const location = useLocation();
  const [sp] = useSearchParams();

  // FR-IA-WS-01(071-M0 C11) + A-24(C5): 채널 활성 시 lastChannel 을 기억하고,
  // 채널 없는 /w/:slug 진입은 ①`?ch=<channelId>`(Activity 점프 — 채널 목록 로드 후
  // 이름으로 해석) → ②저장된 lastChannel → ③최상단 채널 순으로 자동 복원한다.
  // 종전엔 모든 워크스페이스 전환이 '채널을 선택하세요' 빈 화면에 떨어졌다(P0 미구현).
  useEffect(() => {
    if (!active) return;
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
  }, [active, activeChannel, channelName, flatChannels, sp, navigate]);

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

  const topbarTitle = activeChannel ? `# ${activeChannel.name}` : active.name;
  const topbarSubtitle = activeChannel ? active.name : '채널을 선택하세요';

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
          />
        </div>
      }
      right={
        activeChannel ? (
          <div className="qf-m-safe-top" data-testid="mobile-right-panel">
            <MobileMembers workspaceId={active.id} />
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
          {activeChannel ? (
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
            canManage={canManage}
            onCreateChannel={() => setBrowseOpen(false)}
          />
        </SettingsOverlay>
      </div>
    </MobilePanels>
  );
}
