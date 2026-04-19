import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './features/auth/AuthProvider';
import { LoginPage } from './features/auth/LoginPage';
import { SignupPage } from './features/auth/SignupPage';
import { ProtectedRoute } from './features/auth/ProtectedRoute';
import { fetchHealth } from './lib/api';

type Status = { text: string; ok: boolean };

function HomePage(): JSX.Element {
  const { user, logout } = useAuth();
  const [status, setStatus] = useState<Status>({ text: 'checking…', ok: false });

  useEffect(() => {
    fetchHealth()
      .then((h) =>
        setStatus({ text: `API OK: ${h.version} (uptime ${h.uptime}s)`, ok: true }),
      )
      .catch((e) =>
        setStatus({ text: `API DOWN: ${(e as Error).message}`, ok: false }),
      );
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <section className="max-w-xl w-full rounded-2xl border border-slate-200 bg-white p-8 shadow">
        <h1 className="text-2xl font-semibold text-slate-900">qufox</h1>
        <p className="mt-1 text-sm text-slate-500">
          Logged in as <span data-testid="home-username" className="font-medium text-slate-900">{user?.username}</span>
        </p>
        <div
          data-testid="api-status"
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            status.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-amber-200 bg-amber-50 text-amber-700'
          }`}
        >
          {status.text}
        </div>
        <button
          data-testid="logout-btn"
          type="button"
          className="mt-6 inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          onClick={() => {
            logout().catch(() => undefined);
          }}
        >
          Log out
        </button>
      </section>
    </main>
  );
}

function UnauthedRedirect(): JSX.Element {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div data-testid="auth-loading" className="min-h-screen flex items-center justify-center">
        <span className="text-slate-500 text-sm">loading…</span>
      </div>
    );
  }
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <section className="max-w-md text-center">
        <p className="text-sm text-slate-500">
          <Link to="/login" className="font-medium text-slate-900 underline">
            Log in
          </Link>{' '}
          or{' '}
          <Link to="/signup" className="font-medium text-slate-900 underline">
            sign up
          </Link>
        </p>
      </section>
    </main>
  );
}

export default function App(): JSX.Element {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <HomePage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<UnauthedRedirect />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
