import {
  AuthTokensResponse,
  AuthTokensResponseSchema,
  HealthResponse,
  HealthResponseSchema,
  LoginRequest,
  RefreshResponseSchema,
  SignupRequest,
} from '@qufox/shared-types';
// 072 백로그 S-H (N6-3): 강제 로그아웃 사유 표시(LoginPage 배너 안내).
import { markSessionEnded, type SessionEndReason } from './sessionEndNotice';

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

// S77c (D14 / FR-PS-16): 서버가 session:revoked 를 emit 하면(계정 비활성화 등) 클라가 access 토큰을
// 비우고 onForcedLogout 구독자(AuthProvider)에게 강제 로그아웃을 통지한다. apiRequest 의 401 경로와
// 동일한 fireLogout 을 재사용하되, 외부(소켓 핸들러)에서 호출할 수 있도록 공개한다.
// 072 백로그 S-H (N6-3): 강제 로그아웃 사유를 표시해 LoginPage 가 배너로 안내한다(기본 'revoked'
// — 소켓 session:revoked = 다른 기기/관리자/계정 비활성화). 토큰 만료 경로는 'expired' 로 호출.
export function forceLogout(reason: SessionEndReason = 'revoked'): void {
  accessToken = null;
  markSessionEnded(reason);
  fireLogout();
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
      // 072 백로그 S-H (N6-3): 리프레시 실패 = 세션 만료 → LoginPage 안내용 사유 표시.
      markSessionEnded('expired');
      fireLogout();
      throw await bubbleError(res);
    }
    headers['authorization'] = `Bearer ${accessToken}`;
    res = await run();
    if (res.status === 401) {
      markSessionEnded('expired');
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
      retryAfterSec?: number;
      retryAfterMs?: number;
    };
    err.errorCode = body?.errorCode;
    err.status = res.status;
    // 071-M3 F1 (FR-CH-23 슬로우모드 선행): 서버 domain-exception 필터는
    // retryAfterSec/retryAfterMs 를 body **최상위**에 싣는다(details 아님) —
    // 종전엔 여기서 소실돼 클라이언트가 쿨다운 재동기화를 할 수 없었다. additive.
    if (typeof body?.retryAfterSec === 'number') err.retryAfterSec = body.retryAfterSec;
    if (typeof body?.retryAfterMs === 'number') err.retryAfterMs = body.retryAfterMs;
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

// AUTH-3 (PRD D18 §5 / FR-AUTH-40): 비밀번호 재설정 요청. 계정 존재 여부와 무관하게 항상
// 200 { ok: true } 가 돌아온다(서버 열거 방어). 공개 엔드포인트라 retryOn401 불요.
export async function forgotPassword(email: string): Promise<{ ok: true }> {
  return apiRequest('/auth/forgot-password', {
    method: 'POST',
    body: { email },
    retryOn401: false,
  });
}

// AUTH-3 (PRD D18 §5 / FR-AUTH-41·42): 비밀번호 재설정 확정. 만료 410
// (PASSWORD_RESET_TOKEN_EXPIRED) / 무효·재사용 400 (PASSWORD_RESET_TOKEN_INVALID)은
// 에러로 throw 되며 errorCode 로 분기한다. 성공 시 서버가 전 기기 세션을 revoke 한다.
export async function resetPassword(token: string, password: string): Promise<{ ok: true }> {
  return apiRequest('/auth/reset-password', {
    method: 'POST',
    body: { token, password },
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

// task-078 P2-acl: 패밀리 SSO RP 접근 승인 관리(관리자 전용 — 비관리자는 서버가 403).
export type SsoClient = {
  clientId: string;
  name: string;
  enabled: boolean;
  accessCount: number;
};
export type SsoAccessEntry = {
  userId: string;
  email: string | null;
  username: string | null;
  createdAt: string;
};

export async function listSsoClients(): Promise<{ adminEmails: string[]; clients: SsoClient[] }> {
  return apiRequest('/admin/sso/clients');
}
export async function listSsoAccess(clientId: string): Promise<{ access: SsoAccessEntry[] }> {
  return apiRequest(`/admin/sso/clients/${encodeURIComponent(clientId)}/access`);
}
export async function grantSsoAccess(
  clientId: string,
  email: string,
): Promise<{ ok: true; email: string; username: string }> {
  return apiRequest(`/admin/sso/clients/${encodeURIComponent(clientId)}/access`, {
    method: 'POST',
    body: { email },
  });
}
export async function revokeSsoAccess(clientId: string, userId: string): Promise<{ ok: true }> {
  return apiRequest(
    `/admin/sso/clients/${encodeURIComponent(clientId)}/access/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}
