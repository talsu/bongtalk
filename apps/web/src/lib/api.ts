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

export async function apiRequest<T>(
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
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
    const err = new Error(msg) as Error & { errorCode?: string; status?: number };
    err.errorCode = body?.errorCode;
    err.status = res.status;
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

export type MeResponse = { id: string; email: string; username: string };
export async function fetchMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/auth/me');
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
