import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/AuthProvider';
import { ThemeProvider } from './design-system/theme/ThemeProvider';
import { TooltipProvider } from './design-system/primitives';
import { useRealtimeConnection } from './features/realtime/useRealtimeConnection';
import { ConnectionBanner } from './features/connection/ConnectionBanner';
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
const NotificationSettingsPage = lazy(() =>
  import('./features/settings/NotificationSettingsPage').then((m) => ({
    default: m.NotificationSettingsPage,
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

function LoadingFallback(): JSX.Element {
  return (
    <div
      data-testid="app-loading"
      className="grid h-full place-items-center text-sm text-text-muted"
    >
      loading…
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
const VERIFY_GATE_EXEMPT = new Set(['/login', '/signup', '/verify-email']);
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
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
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
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {isMobile ? <MobileFriends /> : <FriendsPage />}
    </Suspense>
  );
}

function ProtectedDmShellRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <DmShell />
    </Suspense>
  );
}

function ProtectedDiscoverRoute(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  // Desktop keeps the server rail + bottom bar chrome via DiscoverShell;
  // mobile renders the full-screen qf-m-screen variant.
  const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {isMobile ? <MobileDiscover /> : <DiscoverShell />}
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

function ProtectedSettingsRoute({ page }: { page: 'notifications' }): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingFallback />;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <Suspense fallback={<LoadingFallback />}>
      {page === 'notifications' ? <NotificationSettingsPage /> : <LoadingFallback />}
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
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{children}</div>
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
                        <Route path="/invite/:code" element={<InviteAcceptPage />} />
                        <Route path="/w/new" element={<CreateWorkspacePage />} />
                        <Route
                          path="/settings"
                          element={<Navigate to="/settings/notifications" replace />}
                        />
                        <Route
                          path="/settings/notifications"
                          element={<ProtectedSettingsRoute page="notifications" />}
                        />
                        <Route path="/activity" element={<ProtectedActivityRoute />} />
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
