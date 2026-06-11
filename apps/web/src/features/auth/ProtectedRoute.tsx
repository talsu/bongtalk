import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export function ProtectedRoute({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div data-testid="auth-loading" className="min-h-full flex items-center justify-center">
        {/* 071-M5 H9 (감사 H-11/A-51): i18n — EmailInviteAcceptPage '…확인하는 중' 톤 정렬. */}
        <span className="text-text-muted text-sm">세션 확인 중…</span>
      </div>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}
