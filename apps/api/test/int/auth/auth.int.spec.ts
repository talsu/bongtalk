/**
 * Auth integration test — boots one Testcontainers stack and runs every auth
 * flow (signup/login/refresh/logout/me) against it. All suites share the same
 * container pair to keep the run under 3 minutes.
 *
 * Required green cases per task-001 DoD:
 * - signup happy-path + email/username conflict + weak password
 * - login happy-path + wrong password + unknown email + 5-strike lockout
 * - refresh rotation + reuse detection (family revoked) + origin check + bad token
 * - logout revokes refresh + clears cookie
 * - GET /auth/me with/without Bearer
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AuthIntEnv, pickCookie, setupAuthIntEnv } from './helpers';

let env: AuthIntEnv;
const STRONG_PW = 'Quanta-Beetle-Nebula-42!';

beforeAll(async () => {
  env = await setupAuthIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}-${counter}-${Date.now()}`;
}

function signup(email: string, username: string) {
  return request(env.baseUrl)
    .post('/auth/signup')
    .set('origin', 'http://localhost:45173')
    .send({ email, username, password: STRONG_PW });
}

describe('POST /auth/signup', () => {
  it('creates a user, returns access token + refresh cookie', async () => {
    const email = `${unique('alice')}@qufox.dev`;
    const username = unique('alice');
    const res = await signup(email, username);
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toMatch(/^ey/);
    expect(res.body.user.username).toBe(username);
    const cookie = pickCookie(res.headers, 'refresh_token');
    expect(cookie).toBeTruthy();
    expect(cookie!.length).toBeGreaterThan(20);
  });

  it('rejects weak password (422 AUTH_WEAK_PASSWORD)', async () => {
    const res = await signup('weak@qufox.dev', unique('weak'));
    // Override the password to a weak one by calling directly
    // Only 2 character classes (lower + digit) — fails the reason-based rule
    // "3 of: lower/upper/digit/symbol" kept after the zxcvbn gate was removed.
    const direct = await request(env.baseUrl)
      .post('/auth/signup')
      .set('origin', 'http://localhost:45173')
      .send({ email: `${unique('w')}@qufox.dev`, username: unique('w'), password: 'abcdefgh12' });
    expect(direct.status).toBe(422);
    expect(direct.body.errorCode).toBe('AUTH_WEAK_PASSWORD');
    // Signal we used the first call too (idempotent for the test).
    expect([201, 409]).toContain(res.status);
  });

  it('rejects duplicate email', async () => {
    const email = `${unique('dupe')}@qufox.dev`;
    const first = await signup(email, unique('dupe'));
    expect(first.status).toBe(201);
    const second = await signup(email, unique('dupe'));
    expect(second.status).toBe(409);
    expect(second.body.errorCode).toBe('AUTH_EMAIL_TAKEN');
  });

  it('rejects duplicate username', async () => {
    const u = unique('shared');
    await signup(`${unique('a')}@qufox.dev`, u).expect(201);
    const res = await signup(`${unique('b')}@qufox.dev`, u);
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('AUTH_USERNAME_TAKEN');
  });
});

describe('POST /auth/login', () => {
  it('returns access + refresh cookie for correct credentials', async () => {
    const email = `${unique('l-ok')}@qufox.dev`;
    await signup(email, unique('l-ok')).expect(201);
    const res = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', 'http://localhost:45173')
      .send({ email, password: STRONG_PW });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^ey/);
  });

  it('rejects wrong password with AUTH_INVALID_CREDENTIALS', async () => {
    const email = `${unique('l-wrong')}@qufox.dev`;
    await signup(email, unique('l-wrong')).expect(201);
    const res = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', 'http://localhost:45173')
      .send({ email, password: 'not-the-one-XYZ123!' });
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('rejects unknown email with AUTH_INVALID_CREDENTIALS (no enumeration)', async () => {
    const res = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', 'http://localhost:45173')
      .send({ email: `${unique('ghost')}@qufox.dev`, password: STRONG_PW });
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('locks account after 5 failed attempts', async () => {
    const email = `${unique('lock')}@qufox.dev`;
    await signup(email, unique('lock')).expect(201);
    for (let i = 0; i < 5; i++) {
      const r = await request(env.baseUrl)
        .post('/auth/login')
        .set('origin', 'http://localhost:45173')
        .send({ email, password: 'wrong-password-XYZ123!' });
      expect(r.status).toBe(401);
    }
    const locked = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', 'http://localhost:45173')
      .send({ email, password: STRONG_PW });
    expect(locked.status).toBe(423);
    expect(locked.body.errorCode).toBe('AUTH_ACCOUNT_LOCKED');
    expect(locked.body.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('POST /auth/refresh (rotation + reuse detection)', () => {
  async function signupAndGetRefresh(): Promise<string> {
    const email = `${unique('r')}@qufox.dev`;
    const res = await signup(email, unique('r'));
    expect(res.status).toBe(201);
    const refresh = pickCookie(res.headers, 'refresh_token');
    if (!refresh) throw new Error('no refresh cookie');
    return refresh;
  }

  it('rotates and detects reuse → compromise entire family', async () => {
    const refresh = await signupAndGetRefresh();

    const rotated = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://localhost:45173')
      .set('Cookie', `refresh_token=${refresh}`)
      .expect(200);
    expect(rotated.body.accessToken).toMatch(/^ey/);
    const newRefresh = pickCookie(rotated.headers, 'refresh_token');
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(refresh);

    // === Re-use the OLD cookie → must be detected ===
    const reused = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://localhost:45173')
      .set('Cookie', `refresh_token=${refresh}`);
    expect(reused.status).toBe(401);
    expect(reused.body.errorCode).toBe('AUTH_SESSION_COMPROMISED');

    // === Even the NEW cookie (same family) must now be burned ===
    const afterBurn = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://localhost:45173')
      .set('Cookie', `refresh_token=${newRefresh}`);
    expect(afterBurn.status).toBe(401);
  });

  it('rejects without refresh cookie', async () => {
    const res = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://localhost:45173');
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('AUTH_INVALID_TOKEN');
  });

  it('rejects when Origin is not whitelisted', async () => {
    const refresh = await signupAndGetRefresh();
    const res = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://evil.example')
      .set('Cookie', `refresh_token=${refresh}`);
    expect(res.status).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://localhost:45173')
      .set('Cookie', 'refresh_token=totally-bogus-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('AUTH_INVALID_TOKEN');
  });
});

describe('POST /auth/logout', () => {
  it('revokes server-side and clears the cookie', async () => {
    const email = `${unique('out')}@qufox.dev`;
    const s = await signup(email, unique('out'));
    expect(s.status).toBe(201);
    const refresh = pickCookie(s.headers, 'refresh_token');
    expect(refresh).toBeTruthy();

    const logout = await request(env.baseUrl)
      .post('/auth/logout')
      .set('origin', 'http://localhost:45173')
      .set('Cookie', `refresh_token=${refresh}`);
    expect(logout.status).toBe(204);
    const cleared = pickCookie(logout.headers, 'refresh_token');
    expect(cleared).toBe('');

    // Refreshing with the revoked token must fail.
    const after = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', 'http://localhost:45173')
      .set('Cookie', `refresh_token=${refresh}`);
    expect(after.status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('rejects without Authorization header', async () => {
    const res = await request(env.baseUrl).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('AUTH_INVALID_TOKEN');
  });

  it('returns the current user with valid Bearer token', async () => {
    const signupRes = await signup(`${unique('me')}@qufox.dev`, unique('me'));
    expect(signupRes.status).toBe(201);
    const { accessToken, user } = signupRes.body as {
      accessToken: string;
      user: { id: string };
    };
    const res = await request(env.baseUrl)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  it('rejects a tampered Bearer token', async () => {
    const res = await request(env.baseUrl)
      .get('/auth/me')
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.TAMPERED.xxxxx');
    expect(res.status).toBe(401);
  });
});
