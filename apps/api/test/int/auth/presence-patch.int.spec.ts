import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setupAuthIntEnv, type AuthIntEnv } from './helpers';

const ORIGIN = 'http://localhost:45173';
const PW = 'Quanta-Beetle-Nebula-42!';

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` } as const;
}

async function signup(
  baseUrl: string,
  prefix: string,
): Promise<{ userId: string; accessToken: string }> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const res = await request(baseUrl)
    .post('/auth/signup')
    .set('origin', ORIGIN)
    .send({ email: `${prefix}-${stamp}@qufox.dev`, username: `${prefix}${stamp}`, password: PW });
  if (res.status !== 201) throw new Error(`signup: ${res.status} ${res.text}`);
  return { userId: res.body.user.id, accessToken: res.body.accessToken };
}

let env: AuthIntEnv;

beforeAll(async () => {
  env = await setupAuthIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

/**
 * Task-019-C: PATCH /me/presence.
 *
 * - Persists the new preference to User.presencePreference.
 * - Rejects invalid bodies with VALIDATION_FAILED.
 * - Rate-limited at 20/min/user (21st call returns 429).
 */
describe('PATCH /me/presence (task-019-C)', () => {
  it('rejects invalid status', async () => {
    const user = await signup(env.baseUrl, 'pre1');
    const res = await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(user.accessToken))
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('flips User.presencePreference to dnd and back', async () => {
    const user = await signup(env.baseUrl, 'pre2');
    const res1 = await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(user.accessToken))
      .send({ status: 'dnd' });
    expect(res1.status).toBe(200);
    expect(res1.body.preference).toBe('dnd');
    expect(res1.body.effective).toBe('dnd');

    const row1 = await env.prisma.user.findUnique({ where: { id: user.userId } });
    expect(row1?.presencePreference).toBe('dnd');

    const res2 = await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(user.accessToken))
      .send({ status: 'online' });
    expect(res2.status).toBe(200);
    expect(res2.body.preference).toBe('auto');
    expect(res2.body.effective).toBe('online');

    const row2 = await env.prisma.user.findUnique({ where: { id: user.userId } });
    expect(row2?.presencePreference).toBe('auto');
  });

  it('rate limits to 20/min/user', async () => {
    const user = await signup(env.baseUrl, 'pre3');
    for (let i = 0; i < 20; i += 1) {
      const res = await request(env.baseUrl)
        .patch('/me/presence')
        .set('origin', ORIGIN)
        .set(bearer(user.accessToken))
        .send({ status: i % 2 === 0 ? 'dnd' : 'online' });
      expect(res.status).toBe(200);
    }
    const res21 = await request(env.baseUrl)
      .patch('/me/presence')
      .set('origin', ORIGIN)
      .set(bearer(user.accessToken))
      .send({ status: 'dnd' });
    expect(res21.status).toBe(429);
    expect(res21.body.errorCode).toBe('RATE_LIMITED');
  });
});
