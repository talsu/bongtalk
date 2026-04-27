import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/AuthProvider';
import { ThemeProvider } from './design-system/theme/ThemeProvider';
import { TooltipProvider } from './design-system/primitives';
import { useRealtimeConnection } from './features/realtime/useRealtimeConnection';
import { ConnectionBanner } from './features/connection/ConnectionBanner';

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
const NotificationSettingsPage = lazy(() =>
  import('./features/settings/NotificationSettingsPage').then((m) => ({
    default: m.NotificationSettingsPage,
  })),
);
const ActivityPage = lazy(() =>
  import('./features/activity/ActivityPage').then((m) => ({ default: m.ActivityPage })),
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

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <BrowserRouter>
            <AuthProvider>
              <AppRealtimeHost />
              <Suspense fallback={<LoadingFallback />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/signup" element={<SignupPage />} />
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
                  {/* Single splat route so React Router does NOT remount
                      the Shell when the URL changes between /w/:slug and
                      /w/:slug/:channelName. Shell reads the rest of the
                      path from useParams()['*']. Reviewer flagged the
                      earlier 3-route version as likely to remount. */}
                  <Route path="/w/:slug/*" element={<ProtectedShellRoute />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
