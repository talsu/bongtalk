import { lazy, Suspense, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/AuthProvider';
import { ThemeProvider } from './design-system/theme/ThemeProvider';
import { ToastViewport, TooltipProvider } from './design-system/primitives';
import { useRealtimeConnection } from './features/realtime/useRealtimeConnection';
// 071-M2 E1: 반응형 분기 일원화 — 라우트 가드들의 matchMedia 1회 평가(회전/리사이즈
// 미반응)를 Shell 과 동일한 구독형 훅으로 통일한다.
import { useIsMobile } from './lib/useBreakpoint';
import { ConnectionBanner } from './features/connection/ConnectionBanner';
// S76 (D14 / FR-PS-09·18 · Fork C1): Ctrl+, 설정 단축키 + 로그인 후 외관 서버값 보정.
import { useSettingsHotkey } from './features/settings/useSettingsHotkey';
import { useAppearanceSettings } from './features/settings/useAppearanceSettings';
import { useAccessibilitySettings } from './features/settings/useAccessibilitySettings';
// S76 (FR-PS-11): DND 억제 게이트가 읽는 effective preference 를 전역에서 로드해둔다.
import { useDndSchedule } from './features/presence/useDndSchedule';
// task-047 iter7 (P4): 글로벌 에러 boundary.
import { ErrorBoundary } from './components/ErrorBoundary';

// Shell and ancillary pages are code-split so the initial JS for a
// logged-out visitor (login/signup/invite) stays small. See
// `.size-limit.cjs` for the per-chunk budgets enforced in CI.
const Shell = lazy(() => import('./shell/Shell').then((m) => ({ default: m.Shell })));
const LoginPage = lazy(() =>
  import('./features/auth/LoginPage').then((m) => ({ default: m.LoginPage })),
);
const SignupPage = lazy(() =>
  import('./features/auth/SignupPage').then((m) => ({ default: m.SignupPage })),
);
const CreateWorkspacePage = lazy(() =>
  import('./features/workspaces/CreateWorkspacePage').then((m) => ({
    default: m.CreateWorkspacePage,
  })),
);
const InviteAcceptPage = lazy(() =>
  import('./features/workspaces/InviteAcceptPage').then((m) => ({
    default: m.InviteAcceptPage,
  })),
);
// S68 (D13 / FR-W04a): 이메일 직접 초대 수락 4분기 페이지.
const EmailInviteAcceptPage = lazy(() =>
  import('./features/workspaces/EmailInviteAcceptPage').then((m) => ({
    default: m.EmailInviteAcceptPage,
  })),
);
// S70 (D13 / FR-W06·W06a): APPLY 모드 가입 신청 폼 + 신청 대기 화면.
const ApplicationForm = lazy(() =>
  import('./features/workspaces/ApplicationForm').then((m) => ({
    default: m.ApplicationForm,
  })),
);
const ApplicationPendingPage = lazy(() =>
  import('./features/workspaces/ApplicationPendingPage').then((m) => ({
    default: m.ApplicationPendingPage,
  })),
);
// S66 (D13 / FR-W05b): 이메일 인증 대기 화면 + 인증 링크 랜딩 페이지.
const EmailVerificationGate = lazy(() =>
  import('./features/auth/EmailVerificationGate').then((m) => ({
    default: m.EmailVerificationGate,
  })),
);
const VerifyEmailLanding = lazy(() =>
  import('./features/auth/VerifyEmailLanding').then((m) => ({
    default: m.VerifyEmailLanding,
  })),
);
// AUTH-3 (PRD D18 §5 / FR-AUTH-40~44): 비밀번호 찾기 + 재설정(미인증/비로그인 비보호 영역).
const ForgotPasswordPage = lazy(() =>
  import('./features/auth/ForgotPasswordPage').then((m) => ({
    default: m.ForgotPasswordPage,
  })),
);
const ResetPasswordPage = lazy(() =>
  import('./features/auth/ResetPasswordPage').then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const NotificationSettingsPage = lazy(() =>
  import('./features/settings/NotificationSettingsPage').then((m) => ({
    default: m.NotificationSettingsPage,
  })),
);
// S73 (D14 / FR-PS-01·02·03): 설정 > 프로필 탭(전역 신원 + 아바타).
const ProfileSettingsPage = lazy(() =>
  import('./features/settings/ProfileSettingsPage').then((m) => ({
    default: m.ProfileSettingsPage,
  })),
);
// S75 (D14 / FR-PS-14): 설정 > 개인정보 및 안전 탭(차단 목록 + 해제).
const PrivacySafetySettingsPage = lazy(() =>
  import('./features/settings/PrivacySafetySettingsPage').then((m) => ({
    default: m.PrivacySafetySettingsPage,
  })),
);
// S76 (D14 / FR-PS-18): 설정 IA 셸(Layout Route) — 7탭 사이드바 + Outlet.
const SettingsShell = lazy(() =>
  import('./features/settings/SettingsShell').then((m) => ({ default: m.SettingsShell })),
);
// S77b (D14 / FR-PS-15·20): 설정 > 내 계정 탭(자격증명 변경 · 2FA · 세션).
const AccountSettingsPage = lazy(() =>
  import('./features/settings/AccountSettingsPage').then((m) => ({
    default: m.AccountSettingsPage,
  })),
);
// S77c (D14 / FR-PS-16·19): 설정 > 고급 탭(위험구역 — 계정 비활성화/삭제).
const AdvancedSettingsPage = lazy(() =>
  import('./features/settings/AdvancedSettingsPage').then((m) => ({
    default: m.AdvancedSettingsPage,
  })),
);
// S76 (D14 / FR-PS-09): 설정 > 외관 탭(테마/밀도/폰트/24h · 자동 저장).
const AppearanceSettingsPage = lazy(() =>
  import('./features/settings/AppearanceSettingsPage').then((m) => ({
    default: m.AppearanceSettingsPage,
  })),
);
// S77a (D14 / FR-PS-12): 설정 > 접근성 탭(모션 줄이기/고대비 · 자동 저장).
const AccessibilitySettingsPage = lazy(() =>
  import('./features/settings/AccessibilitySettingsPage').then((m) => ({
    default: m.AccessibilitySettingsPage,
  })),
);
const ActivityPage = lazy(() =>
  import('./features/activity/ActivityPage').then((m) => ({ default: m.ActivityPage })),
);
// task-047 iter4 (M3): profile page (data 만, surface 단순)
const MyProfilePage = lazy(() =>
  import('./features/users/MyProfilePage').then((m) => ({ default: m.MyProfilePage })),
);
const MobileActivity = lazy(() =>
  import('./shell/mobile/MobileActivity').then((m) => ({ default: m.MobileActivity })),
);
const MobileDmList = lazy(() =>
  import('./shell/mobile/MobileDmList').then((m) => ({ default: m.MobileDmList })),
);
const MobileDmChat = lazy(() =>
  import('./shell/mobile/MobileDmChat').then((m) => ({ default: m.MobileDmChat })),
);
const DiscoverShell = lazy(() =>
  import('./shell/DiscoverShell').then((m) => ({ default: m.DiscoverShell })),
);
const DmShell = lazy(() => import('./shell/DmShell').then((m) => ({ default: m.DmShell })));
const FriendsPage = lazy(() =>
  import('./features/friends/FriendsPage').then((m) => ({ default: m.FriendsPage })),
);
const MobileFriends = lazy(() =>
  import('./shell/mobile/MobileFriends').then((m) => ({ default: m.MobileFriends })),
);
const MobileDiscover = lazy(() =>
  import('./shell/mobile/MobileDiscover').then((m) => ({ default: m.MobileDiscover })),
);
// 071-M2 E3 (PRD §02 5탭): 모바일 전용 탭 화면.
const MobileThreadsTab = lazy(() =>
  import('./shell/mobile/MobileThreadsTab').then((m) => ({ default: m.MobileThreadsTab })),
);
const MobileSearchTab = lazy(() =>
  import('./shell/mobile/MobileSearchTab').then((m) => ({ default: m.MobileSearchTab })),
);
const MobileYouTab = lazy(() =>
  import('./shell/mobile/MobileYouTab').then((m) => ({ default: m.MobileYouTab })),
);
// 071-M3 F3: 저장함 풀스크린('나' 탭 드릴다운).
const MobileSavedScreen = lazy(() =>
  import('./shell/mobile/MobileSavedScreen').then((m) => ({ default: m.MobileSavedScreen })),
);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

function LoadingFallback(): JSX.Element {
  return (
    <div
      data-testid="app-loading"
      className="grid h-full place-items-center text-sm text-text-muted"
    >
      {/* 071-M5 H9 (감사 H-11/A-51): i18n 영문 잔재 — 기존 한국어 선례(ActivityPage 등)와 통일. */}
      불러오는 중…
    </div>
  );
}

/**
 * Shell is the common render tree for every authenticated route. It reads
 * the URL parameters via React Router hooks so changing /w/:slug/:channel
 * does NOT unmount the shell — only the message column re-subscribes to
 * the new channel's React Query.
 */
function ProtectedShellRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Shell />
    </Suspense>
  );
}

/**
 * S66 (D13 / FR-W05a/W05b): 전역 이메일 인증 게이트. 인증된 사용자가 emailVerified=false
 * 이면 워크스페이스 진입 대신 인증 대기 화면(EmailVerificationGate)을 렌더한다. 인증/로그아웃
 * 경로(/login·/signup·/verify-email)는 게이트를 건너뛰어 사용자가 로그아웃하거나 링크로
 * 인증을 완료할 수 있게 한다. anonymous·loading 은 통과시켜 기존 라우팅이 처리한다.
 */
const VERIFY_GATE_EXEMPT = new Set([
  '/login',
  '/signup',
  '/verify-email',
  // AUTH-3 (FR-AUTH-40~44): 비밀번호 찾기/재설정도 게이트 면제(비로그인/미인증 진입 경로).
  '/forgot-password',
  '/reset-password',
]);
// S66 fix-forward (review LOW-2): 미인증 사용자가 초대 링크(/invite/:code)를 클릭하면
// 게이트로 튕기지 않고 InviteAcceptPage 를 보게 한다(백엔드 진입 게이트 + 수락 403 사유
// 분기가 보호하므로 안전). prefix 매칭이 필요한 경로는 여기에 둔다.
const VERIFY_GATE_EXEMPT_PREFIXES = ['/invite'];

// S68 (FR-W04a): 이메일 직접 초대 수락 경로(/w/:slug/email-invite[/:token])도 게이트
// 면제한다 — 미인증/신규 사용자가 초대 수락 흐름(가입 리다이렉트 포함)을 탈 수 있어야 하며,
// 백엔드 진입 게이트 + 수락 403/410 분기가 보호하므로 안전하다.
const EMAIL_INVITE_PATH_RE = /^\/w\/[^/]+\/email-invite(\/|$|\?)/;

function isVerifyGateExempt(pathname: string): boolean {
  if (VERIFY_GATE_EXEMPT.has(pathname)) return true;
  if (EMAIL_INVITE_PATH_RE.test(pathname)) return true;
  return VERIFY_GATE_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function VerificationGate({ children }: { children: ReactNode }): JSX.Element {
  const { status, user } = useAuth();
  const location = useLocation();
  if (
    status === 'authenticated' &&
    user &&
    !user.emailVerified &&
    !isVerifyGateExempt(location.pathname)
  ) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <EmailVerificationGate />
      </Suspense>
    );
  }
  return <>{children}</>;
}

/**
 * Task-019-D: settings routes share the auth gate with the shell but
 * render a different tree (user-scoped, not workspace-scoped).
 */
function ProtectedActivityRoute(): JSX.Element {
  const { status } = useAuth();
  // 071-M2 E1: 훅은 조기 return 보다 먼저(Rules of Hooks).
  const isMobile = useIsMobile();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {isMobile ? <MobileActivity /> : <ActivityPage />}
    </Suspense>
  );
}

// task-047 iter4 (M3): /me/profile route. 데스크톱 + 모바일 동일
// 컴포넌트 (responsive layout via DS tokens).
function ProtectedMyProfileRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <MyProfilePage />
    </Suspense>
  );
}

// 071-M2 E3 (PRD §02 5탭): 모바일 전용 탭 라우트 가드 — 스레드/검색/나.
// 데스크톱 동등 surface 는 셸 내부에 있으므로 비모바일은 '/' 로 폴백한다.
function ProtectedMobileTabRoute({
  tab,
}: {
  tab: 'threads' | 'search' | 'you' | 'saved';
}): JSX.Element {
  const { status } = useAuth();
  const isMobile = useIsMobile();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (!isMobile) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {tab === 'threads' ? (
        <MobileThreadsTab />
      ) : tab === 'search' ? (
        <MobileSearchTab />
      ) : tab === 'saved' ? (
        <MobileSavedScreen />
      ) : (
        <MobileYouTab />
      )}
    </Suspense>
  );
}

function ProtectedDmListRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <MobileDmList />
    </Suspense>
  );
}

function ProtectedDmChatRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <MobileDmChat />
    </Suspense>
  );
}

function ProtectedFriendsRoute(): JSX.Element {
  const { status } = useAuth();
  const isMobile = useIsMobile();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {isMobile ? <MobileFriends /> : <FriendsPage />}
    </Suspense>
  );
}

function ProtectedDmShellRoute(): JSX.Element {
  const { status } = useAuth();
  const params = useParams<{ userId?: string }>();
  const [dmSearch] = useSearchParams();
  // 071-M2 E1: 구독형 훅으로 통일(조기 return 보다 먼저 — Rules of Hooks).
  const isMobile = useIsMobile();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  // H-4(071-M0 C8): 종전엔 모바일 390px 에서도 데스크톱 3컬럼 DmShell 이 그대로 렌더돼
  // 우측 빈 패널이 한 글자씩 세로로 깨졌다. 모바일은 전용 표면으로 분기한다:
  //  - /dm?new=<userId> (홈 친구 행 진입) → /dms/:userId (MobileDmChat 이 createOrGet)
  //  - /dm/:userId → /dms/:userId, /dm → /dms (MobileDmList)
  if (isMobile) {
    const newUserId = dmSearch.get('new');
    if (newUserId) return <Navigate to={`/dms/${encodeURIComponent(newUserId)}`} replace />;
    if (params.userId) return <Navigate to={`/dms/${encodeURIComponent(params.userId)}`} replace />;
    return <Navigate to="/dms" replace />;
  }
  return (
    <Suspense fallback={<LoadingFallback />}>
      <DmShell />
    </Suspense>
  );
}

function ProtectedDiscoverRoute(): JSX.Element {
  const { status } = useAuth();
  // Desktop keeps the server rail + bottom bar chrome via DiscoverShell;
  // mobile renders the full-screen qf-m-screen variant.
  const isMobile = useIsMobile();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {isMobile ? <MobileDiscover /> : <DiscoverShell />}
    </Suspense>
  );
}

/**
 * S70 (D13 / FR-W06): APPLY 모드 가입 신청 폼 라우트(`/w/:slug/apply`). slug 는 URL 에서
 * 읽어 폼에 넘긴다. 신청자는 아직 멤버가 아니므로 ProtectedShellRoute(멤버 셸)가 아니라
 * 인증만 가드한 전용 라우트로 둔다(InviteAcceptPage 선례). 미인증은 /login 으로.
 */
function ProtectedApplicationFormRoute(): JSX.Element {
  const { status } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ApplicationForm slug={slug ?? ''} />
    </Suspense>
  );
}

/**
 * S70 (D13 / FR-W06a): 가입 신청 대기 화면 라우트(`/w/:slug/pending`). WS 연결 상태
 * (wsConnected)를 상위 useRealtimeConnection 에서 읽어 주입한다 — 끊김이면 대기 화면이
 * 30초 polling fallback 으로 전환한다(WS 이벤트가 진실값일 때는 폴링 비활성).
 */
function ProtectedApplicationPendingRoute(): JSX.Element {
  const { status } = useAuth();
  const { slug } = useParams<{ slug: string }>();
  const { status: realtimeStatus } = useRealtimeConnection();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ApplicationPendingPage slug={slug ?? ''} wsConnected={realtimeStatus === 'connected'} />
    </Suspense>
  );
}

/**
 * Fold the legacy workspace-scoped `/w/:slug/dm/:userId` URL into the
 * workspace-free `/dm/:userId`. Kept as a Route element (not a plain
 * Navigate) so the dynamic :userId segment carries through.
 */
function LegacyDmChatRedirect(): JSX.Element {
  const { userId } = useParams<{ userId: string }>();
  return <Navigate to={userId ? `/dm/${userId}` : '/dm'} replace />;
}

/**
 * S76 (D14 / FR-PS-18 · Fork A1): 설정 Layout Route 가드. SettingsShell(사이드바 +
 * Outlet)을 인증 게이트로 감싼다. 각 탭 페이지는 이 라우트의 자식으로 중첩되어
 * Outlet 에 렌더된다(딥링크 유지). 인증 미충족 시 /login 으로.
 */
function ProtectedSettingsShellRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <SettingsShell />
    </Suspense>
  );
}

/**
 * task-040 R3 + reviewer H1: install the realtime socket once at the
 * top of the auth-protected tree so the ConnectionBanner survives
 * every shell early-return path (loading / 0-workspaces / not-found
 * states). Previously each Shell rendered its own `<ConnectionBanner>`
 * inside the FINAL return, missing all early-returns. Hoisting also
 * deduplicates the per-shell `useRealtimeConnection()` call (which
 * was a singleton anyway thanks to socket.ts but cost a needless
 * reconnect on shell remount).
 *
 * Lives inside AuthProvider because the hook needs the viewer id for
 * dispatcher install. Above Routes so the banner renders on every
 * authenticated route — including the bootstrap blank page.
 */
function AppRealtimeHost(): JSX.Element {
  const { status: realtimeStatus, replaying } = useRealtimeConnection();
  return <ConnectionBanner realtimeStatus={realtimeStatus} replaying={replaying} />;
}

/**
 * S76 (D14 / FR-PS-09·18 · Fork C1): 전역 설정 호스트. Ctrl+,(Cmd+,) 단축키를 항상
 * 등록하고(로그아웃 상태에서도 /settings 진입 시 /login 으로 가드됨), 인증된 사용자에
 * 한해 GET /me/settings/appearance 로 서버 외관값을 DOM/스토어에 보정한다(서버 단일
 * 출처 — localStorage 즉시값을 덮어 다기기 정합). 렌더 출력은 없다(부수효과 전용).
 */
function SettingsHost(): JSX.Element | null {
  const { status } = useAuth();
  useSettingsHotkey();
  const authed = status === 'authenticated';
  useAppearanceSettings(authed);
  // S77a (FR-PS-12): 인증 시 접근성 서버값을 로드해 documentElement 의 data-reduce-motion/
  // data-high-contrast 를 보정한다(reduceMotion 이 app CSS 로 실제 동작 — 죽은 컨트롤 아님).
  useAccessibilitySettings(authed);
  // 인증된 동안에만 DND 스케줄을 전역 로드해 FR-PS-11 억제 게이트가 effective
  // preference 를 항상 갖게 한다(useDndSchedule 은 자체 enabled 가 없으므로 마운트 분기).
  return authed ? <AuthedSettingsHost /> : null;
}

function AuthedSettingsHost(): null {
  useDndSchedule();
  return null;
}

/**
 * task-041 A-1 (review M1 follow): wrap the banner + Routes in a
 * single flex column so the banner pushes content down via normal
 * flow instead of overlaying it. With #root sized to 100% by
 * index.css, this column inherits the full viewport; banner takes
 * its natural height, Routes fills the remainder with min-height: 0
 * so inner overflow targets (message list, etc.) still scroll.
 */
function AppLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <AppRealtimeHost />
      <SettingsHost />
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{children}</div>
      {/* A-18(071-M0 C6): 종전엔 4개 셸(Shell/DmShell/DiscoverShell/MobileShell)에만
          ToastViewport 가 있어 홈·DM 채팅·활동·친구·찾기·설정 등 모바일 화면 대부분에서
          모든 토스트가 무음이었다 — App 레벨 단일 마운트로 승격(셸 측 마운트는 제거). */}
      <ToastViewport />
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <BrowserRouter>
            <AuthProvider>
              <AppLayout>
                <ErrorBoundary>
                  <Suspense fallback={<LoadingFallback />}>
                    <VerificationGate>
                      <Routes>
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/signup" element={<SignupPage />} />
                        {/* S66 (FR-W05b): 메일 인증 링크 랜딩(공개 — 미인증 토큰 처리). */}
                        <Route path="/verify-email" element={<VerifyEmailLanding />} />
                        {/* AUTH-3 (FR-AUTH-40~44): 비밀번호 찾기/재설정(비로그인 공개 영역). */}
                        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                        <Route path="/reset-password" element={<ResetPasswordPage />} />
                        <Route path="/invite/:code" element={<InviteAcceptPage />} />
                        <Route path="/w/new" element={<CreateWorkspacePage />} />
                        {/* S76 (FR-PS-18 · Fork A1): Layout Route — SettingsShell + <Outlet/>.
                            각 탭은 자식 라우트로 중첩되어 콘텐츠 영역에 렌더된다(딥링크 유지).
                            H-10(071-M0 C7): 종전의 독립 /settings → appearance 리다이렉트가
                            모바일 드릴다운 목록(active===null 분기)을 영원히 가렸다 — index
                            라우트로 옮겨 데스크톱만 리다이렉트한다(모바일 셸은 active===null
                            에서 Outlet 을 렌더하지 않으므로 목록이 노출된다). */}
                        <Route path="/settings" element={<ProtectedSettingsShellRoute />}>
                          <Route index element={<Navigate to="/settings/appearance" replace />} />
                          {/* S77b (D14 / FR-PS-15·20): 내 계정(자격증명 변경 · 2FA · 세션). */}
                          <Route path="account" element={<AccountSettingsPage />} />
                          {/* S76 (D14 / FR-PS-09): 외관(신규 · 자동 저장). */}
                          <Route path="appearance" element={<AppearanceSettingsPage />} />
                          {/* S77a (D14 / FR-PS-12): 접근성(모션 줄이기/고대비 · 자동 저장). */}
                          <Route path="accessibility" element={<AccessibilitySettingsPage />} />
                          {/* S46: 알림(NotifLevel + DND + 키워드 + 데스크톱/모바일 토글). */}
                          <Route path="notifications" element={<NotificationSettingsPage />} />
                          {/* S73 (D14 / FR-PS-01·02·03): 프로필(명시적 저장). */}
                          <Route path="profile" element={<ProfileSettingsPage />} />
                          {/* S75 (D14 / FR-PS-14): 개인정보 및 안전(차단 목록). */}
                          <Route path="privacy" element={<PrivacySafetySettingsPage />} />
                          {/* S77c (D14 / FR-PS-16·19): 고급(위험구역 — 계정 비활성화/삭제). */}
                          <Route path="advanced" element={<AdvancedSettingsPage />} />
                        </Route>
                        <Route path="/activity" element={<ProtectedActivityRoute />} />
                        {/* 071-M2 E3 (PRD §02 5탭): 모바일 전용 탭 화면 — 스레드/검색/나.
                            데스크톱은 동등 surface 가 셸 내부(사이드바 Threads/검색 패널/
                            BottomBar)에 있으므로 '/' 로 돌려보낸다. */}
                        <Route
                          path="/threads"
                          element={<ProtectedMobileTabRoute tab="threads" />}
                        />
                        <Route path="/search" element={<ProtectedMobileTabRoute tab="search" />} />
                        <Route path="/you" element={<ProtectedMobileTabRoute tab="you" />} />
                        <Route path="/saved" element={<ProtectedMobileTabRoute tab="saved" />} />
                        {/* task-047 iter4 (M3): profile page */}
                        <Route path="/me/profile" element={<ProtectedMyProfileRoute />} />
                        <Route path="/dm" element={<ProtectedDmShellRoute />} />
                        <Route path="/dm/:userId" element={<ProtectedDmShellRoute />} />
                        <Route path="/discover" element={<ProtectedDiscoverRoute />} />
                        <Route path="/friends" element={<ProtectedFriendsRoute />} />
                        <Route path="/dms" element={<ProtectedDmListRoute />} />
                        <Route path="/dms/:userId" element={<ProtectedDmChatRoute />} />
                        {/* Legacy workspace-scoped DM routes — fold into /dm so
                      bookmarks + existing deep-links keep working. */}
                        <Route path="/w/:slug/dm" element={<Navigate to="/dm" replace />} />
                        <Route path="/w/:slug/dm/:userId" element={<LegacyDmChatRedirect />} />
                        <Route path="/" element={<ProtectedShellRoute />} />
                        {/* S68 (FR-W04a): 이메일 직접 초대 수락. rawToken 은 URL fragment
                            (#token=…)로, opaque 자동수락은 쿼리(?opaque=…)로 들어온다. fragment
                            는 서버/nginx 로 전송되지 않아 access 로그에 평문이 남지 않는다
                            (security MEDIUM-1). path token segment 는 제거했다. /w/:slug/* 보다
                            구체적이라 먼저 매칭된다(VerificationGate 면제 — 신규 사용자 랜딩). */}
                        <Route path="/w/:slug/email-invite" element={<EmailInviteAcceptPage />} />
                        {/* S70 (FR-W06·W06a): APPLY 모드 가입 신청 폼 + 대기 화면. 신청자는
                            아직 멤버가 아니라 셸(/w/:slug/*)이 아닌 전용 라우트로 두며,
                            /w/:slug/* 보다 구체적이라 먼저 매칭된다. */}
                        <Route path="/w/:slug/apply" element={<ProtectedApplicationFormRoute />} />
                        <Route
                          path="/w/:slug/pending"
                          element={<ProtectedApplicationPendingRoute />}
                        />
                        {/* Single splat route so React Router does NOT remount
                      the Shell when the URL changes between /w/:slug and
                      /w/:slug/:channelName. Shell reads the rest of the
                      path from useParams()['*']. Reviewer flagged the
                      earlier 3-route version as likely to remount. */}
                        <Route path="/w/:slug/*" element={<ProtectedShellRoute />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </VerificationGate>
                  </Suspense>
                </ErrorBoundary>
              </AppLayout>
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
