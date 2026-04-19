import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './features/auth/AuthProvider';
import { ThemeProvider } from './design-system/theme/ThemeProvider';
import { TooltipProvider } from './design-system/primitives';

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

export default function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <BrowserRouter>
            <AuthProvider>
              <Suspense fallback={<LoadingFallback />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/signup" element={<SignupPage />} />
                  <Route path="/invite/:code" element={<InviteAcceptPage />} />
                  <Route path="/w/new" element={<CreateWorkspacePage />} />
                  <Route path="/" element={<ProtectedShellRoute />} />
                  <Route path="/w/:slug" element={<ProtectedShellRoute />} />
                  <Route path="/w/:slug/:channelName" element={<ProtectedShellRoute />} />
                  <Route
                    path="/w/:slug/:channelName/:messageId"
                    element={<ProtectedShellRoute />}
                  />
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
