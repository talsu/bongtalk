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
        setUser({ id: res.user.id, email: res.user.email, username: res.user.username });
        setStatus('authenticated');
      },
      login: async (input) => {
        const res = await apiLogin(input);
        setUser({ id: res.user.id, email: res.user.email, username: res.user.username });
        setStatus('authenticated');
      },
      logout: async () => {
        await apiLogout();
        setUser(null);
        setStatus('anonymous');
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
