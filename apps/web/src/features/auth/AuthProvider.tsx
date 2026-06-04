import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  login as apiLogin,
  logout as apiLogout,
  signup as apiSignup,
  fetchMe,
  onForcedLogout,
  setAccessToken,
  tryRestoreSession,
  MeResponse,
} from '../../lib/api';
import type { LoginRequest, SignupRequest } from '@qufox/shared-types';

type Status = 'loading' | 'authenticated' | 'anonymous';

export type AuthContextValue = {
  status: Status;
  user: MeResponse | null;
  signup: (input: SignupRequest) => Promise<void>;
  login: (input: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  // S66 (D13 / FR-W05b): "이미 인증했어요" → /auth/me 재조회로 emailVerified 갱신.
  // 갱신된 emailVerified 를 반환해 호출부가 즉시 진입 재시도 여부를 판단한다.
  refreshMe: () => Promise<boolean>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<MeResponse | null>(null);

  const handleForcedLogout = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    const off = onForcedLogout(handleForcedLogout);
    return () => {
      off();
    };
  }, [handleForcedLogout]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await tryRestoreSession();
      if (cancelled) return;
      if (restored) {
        setUser(restored);
        setStatus('authenticated');
      } else {
        setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signup: async (input) => {
        const res = await apiSignup(input);
        // S66 (D13 / FR-W05b): 가입 직후 emailVerified=false → 게이트로 분기됨.
        setUser({
          id: res.user.id,
          email: res.user.email,
          username: res.user.username,
          emailVerified: res.user.emailVerified,
        });
        setStatus('authenticated');
      },
      login: async (input) => {
        const res = await apiLogin(input);
        setUser({
          id: res.user.id,
          email: res.user.email,
          username: res.user.username,
          emailVerified: res.user.emailVerified,
        });
        setStatus('authenticated');
      },
      logout: async () => {
        await apiLogout();
        setUser(null);
        setStatus('anonymous');
      },
      refreshMe: async () => {
        // S66 (D13 / FR-W05b): /auth/me 재조회 → emailVerified 갱신. 실패(401 등)는
        // 현재 상태 유지하고 false 반환(진입 재시도 안 함).
        try {
          const me = await fetchMe();
          setUser(me);
          return me.emailVerified;
        } catch {
          return false;
        }
      },
    }),
    [status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
