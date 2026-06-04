import {
  AuthTokensResponse,
  AuthTokensResponseSchema,
  HealthResponse,
  HealthResponseSchema,
  LoginRequest,
  RefreshResponseSchema,
  SignupRequest,
} from '@qufox/shared-types';

const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '/api';

let accessToken: string | null = null;
const logoutListeners = new Set<() => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onForcedLogout(fn: () => void): () => void {
  logoutListeners.add(fn);
  return () => logoutListeners.delete(fn);
}

function fireLogout(): void {
  for (const fn of logoutListeners) fn();
}

async function refreshOnce(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) return false;
  const json = await res.json();
  const parsed = RefreshResponseSchema.safeParse(json);
  if (!parsed.success) return false;
  accessToken = parsed.data.accessToken;
  return true;
}

export type RequestOpts = {
  method?: string;
  body?: unknown;
  json?: boolean;
  retryOn401?: boolean;
};

export async function apiRequest<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined && opts.json !== false) {
    headers['content-type'] = 'application/json';
  }
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;

  const run = async () =>
    fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'include',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await run();
  if (res.status === 401 && opts.retryOn401 !== false) {
    const ok = await refreshOnce();
    if (!ok) {
      fireLogout();
      throw await bubbleError(res);
    }
    headers['authorization'] = `Bearer ${accessToken}`;
    res = await run();
    if (res.status === 401) {
      fireLogout();
      throw await bubbleError(res);
    }
  }
  if (!res.ok) throw await bubbleError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function bubbleError(res: Response): Promise<Error> {
  try {
    const body = await res.json();
    const msg = typeof body?.message === 'string' ? body.message : `http ${res.status}`;
    const err = new Error(msg) as Error & {
      errorCode?: string;
      status?: number;
      details?: unknown;
    };
    err.errorCode = body?.errorCode;
    err.status = res.status;
    // S05 (FR-MSG-06): 낙관적 잠금 충돌(MESSAGE_VERSION_CONFLICT) 응답은
    // body.details.current 에 서버 최신 MessageDto 를 싣는다. 편집창 롤백에
    // 쓰도록 에러에 그대로 전달한다(다른 에러는 details 미포함이라 무해).
    err.details = body?.details;
    return err;
  } catch {
    return new Error(`http ${res.status}`);
  }
}

// Endpoints ------------------------------------------------------------------

export async function fetchHealth(): Promise<HealthResponse> {
  const json = await apiRequest<unknown>('/healthz', { retryOn401: false });
  return HealthResponseSchema.parse(json);
}

export async function signup(input: SignupRequest): Promise<AuthTokensResponse> {
  const json = await apiRequest<unknown>('/auth/signup', {
    method: 'POST',
    body: input,
    retryOn401: false,
  });
  const parsed = AuthTokensResponseSchema.parse(json);
  accessToken = parsed.accessToken;
  return parsed;
}

export async function login(input: LoginRequest): Promise<AuthTokensResponse> {
  const json = await apiRequest<unknown>('/auth/login', {
    method: 'POST',
    body: input,
    retryOn401: false,
  });
  const parsed = AuthTokensResponseSchema.parse(json);
  accessToken = parsed.accessToken;
  return parsed;
}

export async function logout(): Promise<void> {
  try {
    await apiRequest<void>('/auth/logout', { method: 'POST', retryOn401: false });
  } finally {
    accessToken = null;
  }
}

// S66 (D13 / FR-W05b): emailVerified 를 추가해 인증 대기 화면 분기에 쓴다.
export type MeResponse = {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
};
export async function fetchMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/auth/me');
}

// S66 (D13 / FR-W05b): 인증 메일 재발송. 429 시 errorCode/ retryAfterSec 가 에러에 실린다.
export async function resendVerificationEmail(): Promise<{
  cooldownSec: number;
  remainingToday: number;
}> {
  return apiRequest('/auth/resend-verification', { method: 'POST', retryOn401: false });
}

// S66 (D13 / FR-W05b): 이메일 인증 링크 처리(GET /auth/verify-email?token=). 만료 410
// (EMAIL_VERIFICATION_TOKEN_EXPIRED) / 무효 400 (EMAIL_VERIFICATION_TOKEN_INVALID)는
// 에러로 throw 되며 errorCode 로 분기한다. 공개 엔드포인트라 retryOn401 불요.
export async function verifyEmailToken(token: string): Promise<{ emailVerified: true }> {
  return apiRequest(`/auth/verify-email?token=${encodeURIComponent(token)}`, {
    retryOn401: false,
  });
}

export async function tryRestoreSession(): Promise<MeResponse | null> {
  const ok = await refreshOnce();
  if (!ok) return null;
  try {
    return await fetchMe();
  } catch {
    accessToken = null;
    return null;
  }
}
