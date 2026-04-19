import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export function ProtectedRoute({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div data-testid="auth-loading" className="min-h-screen flex items-center justify-center">
        <span className="text-slate-500 text-sm">loading session…</span>
      </div>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
