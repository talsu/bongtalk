/**
 * S66 (D13 / FR-W05a·W05b) — 이메일 인증 토큰 발급→검증→usedAt→재사용 차단 +
 * emailVerified 게이트(워크스페이스 진입·메시지 전송) + emailDomains exact-match 게이트.
 *
 * 토큰 raw 값은 DB(EmailVerificationToken)에서 직접 읽는다(Console stub 은 로거로만
 * 출력하므로). 미인증 사용자는 signupAsUser(..., markVerified=false)로 만든다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser } from '../workspaces/helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

async function clearVerifyEmailIpBuckets(): Promise<void> {
  // S66 fix-forward (HIGH-2): verify-email IP rate-limit 은 같은 IP(127.0.0.1/::1/::ffff:
  // 127.0.0.1) 윈도우를 공유하므로 테스트 간 누수를 막기 위해 해당 버킷을 비운다. KEYS
  // 글로브 + 알려진 형태 직접 DEL 을 함께 써 환경별 IP 표기 차이를 모두 덮는다.
  if (!env?.redis) return;
  const ipKeys = await env.redis.keys('rl:verify-email:ip:*');
  const explicit = [
    'rl:verify-email:ip:127.0.0.1',
    'rl:verify-email:ip:::1',
    'rl:verify-email:ip:::ffff:127.0.0.1',
  ];
  const all = [...new Set([...ipKeys, ...explicit])];
  await env.redis.del(...all);
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await clearVerifyEmailIpBuckets();
});

async function latestToken(userId: string): Promise<string> {
  const row = await env.prisma.emailVerificationToken.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) throw new Error('no verification token for user');
  return row.token;
}

describe('S66 verify-email — token issue → verify → usedAt → reuse blocked', () => {
  it('signup 은 emailVerified=false + 인증 토큰 1행을 만든다', async () => {
    const u = await signupAsUser(env.baseUrl, 'evtok', false);
    const me = await request(env.baseUrl)
      .get('/auth/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.emailVerified).toBe(false);
    const token = await latestToken(u.userId);
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('GET /auth/verify-email?token= 성공 → emailVerified=true, 재사용은 400', async () => {
    const u = await signupAsUser(env.baseUrl, 'evver', false);
    const token = await latestToken(u.userId);

    const ok = await request(env.baseUrl).get('/auth/verify-email').query({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.emailVerified).toBe(true);

    // me 재조회가 즉시 true.
    const me = await request(env.baseUrl)
      .get('/auth/me')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(me.body.emailVerified).toBe(true);

    // 재사용(이미 usedAt) → 400 TOKEN_INVALID.
    const reuse = await request(env.baseUrl).get('/auth/verify-email').query({ token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.errorCode).toBe('EMAIL_VERIFICATION_TOKEN_INVALID');
  });

  it('무효 토큰은 400 TOKEN_INVALID', async () => {
    const bad = await request(env.baseUrl)
      .get('/auth/verify-email')
      .query({ token: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(400);
    expect(bad.body.errorCode).toBe('EMAIL_VERIFICATION_TOKEN_INVALID');
  });

  it('resend-verification 은 200 + 쿨다운/남은횟수, 즉시 재발송은 429', async () => {
    const u = await signupAsUser(env.baseUrl, 'evrs', false);
    const first = await request(env.baseUrl)
      .post('/auth/resend-verification')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(first.status).toBe(200);
    expect(first.body.cooldownSec).toBe(60);
    expect(first.body.remainingToday).toBeGreaterThanOrEqual(0);

    const again = await request(env.baseUrl)
      .post('/auth/resend-verification')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(again.status).toBe(429);
    expect(again.body.errorCode).toBe('EMAIL_VERIFICATION_RATE_LIMITED');
  });

  it('이미 인증된 사용자의 resend 는 200 멱등(쿨다운 0)으로 통과한다 (MEDIUM-1)', async () => {
    const u = await signupAsUser(env.baseUrl, 'evidem'); // verified by default
    const res = await request(env.baseUrl)
      .post('/auth/resend-verification')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.cooldownSec).toBe(0);
    // 멱등 호출은 쿨다운 키를 점유하지 않으므로 두 번째 호출도 429 가 아니다.
    const second = await request(env.baseUrl)
      .post('/auth/resend-verification')
      .set('Authorization', `Bearer ${u.accessToken}`);
    expect(second.status).toBe(200);
    expect(second.body.cooldownSec).toBe(0);
  });

  it('verify-email 은 IP 당 60초 20회 초과 시 429 RATE_LIMITED (HIGH-2)', async () => {
    // 같은 IP 버킷(127.0.0.1 / ::1 등 환경 차이)을 모두 비우고 21회 두드린다(무효
    // 토큰이라도 rate-limit 은 토큰 검증 전에 집행된다).
    const ipKeys = await env.redis.keys('rl:verify-email:ip:*');
    if (ipKeys.length > 0) await env.redis.del(...ipKeys);
    const bad = '00000000-0000-4000-8000-000000000000';
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const res = await request(env.baseUrl).get('/auth/verify-email').query({ token: bad });
      if (res.status === 429) {
        expect(res.body.errorCode).toBe('RATE_LIMITED');
        limited = true;
        break;
      }
      // 한도 내 호출은 무효 토큰이라 400 이어야 한다(rate-limit 통과 후 토큰 검증).
      expect(res.status).toBe(400);
    }
    expect(limited).toBe(true);
  });
});

describe('S66 emailVerified gate — invite accept / joinPublic / message send (FR-W05a)', () => {
  async function makeOwnerWs(prefix: string, emailDomains: string[] = []) {
    const owner = await signupAsUser(env.baseUrl, prefix); // verified by default
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: prefix, slug: `${prefix}-${Date.now().toString(36)}`.slice(0, 30) });
    const workspaceId = create.body.id as string;
    if (emailDomains.length > 0) {
      await env.prisma.workspace.update({ where: { id: workspaceId }, data: { emailDomains } });
    }
    return { owner, workspaceId };
  }

  it('미인증 사용자의 초대 수락은 403 EMAIL_NOT_VERIFIED', async () => {
    const { owner, workspaceId } = await makeOwnerWs('gacc');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code;

    const joiner = await signupAsUser(env.baseUrl, 'gacc2', false); // unverified
    const accept = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(accept.status).toBe(403);
    expect(accept.body.errorCode).toBe('EMAIL_NOT_VERIFIED');
  });

  it('인증 후 초대 수락은 201 로 성공한다', async () => {
    const { owner, workspaceId } = await makeOwnerWs('gacc3');
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code;

    const joiner = await signupAsUser(env.baseUrl, 'gacc4', false);
    await request(env.baseUrl)
      .get('/auth/verify-email')
      .query({ token: await latestToken(joiner.userId) })
      .expect(200);

    const accept = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(accept.status).toBe(201);
  });

  it('도메인 화이트리스트 불일치 초대 수락은 403 WORKSPACE_DOMAIN_NOT_ALLOWED', async () => {
    const { owner, workspaceId } = await makeOwnerWs('gdom', ['allowed-corp.com']);
    const inv = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/invites`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ maxUses: 5 });
    const code = inv.body.invite.code;

    // verified 이지만 도메인은 @qufox.dev → 화이트리스트와 불일치.
    const joiner = await signupAsUser(env.baseUrl, 'gdom2'); // verified, qufox.dev
    const accept = await request(env.baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(accept.status).toBe(403);
    expect(accept.body.errorCode).toBe('WORKSPACE_DOMAIN_NOT_ALLOWED');
  });

  it('미인증 사용자의 워크스페이스 생성은 403 EMAIL_NOT_VERIFIED (HIGH-3)', async () => {
    const creator = await signupAsUser(env.baseUrl, 'gcreate', false); // unverified
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${creator.accessToken}`)
      .send({ name: 'gcreate', slug: `gcreate-${Date.now().toString(36)}`.slice(0, 30) });
    expect(create.status).toBe(403);
    expect(create.body.errorCode).toBe('EMAIL_NOT_VERIFIED');
  });

  it('인증 후에는 워크스페이스를 생성할 수 있다 (HIGH-3 회귀)', async () => {
    const creator = await signupAsUser(env.baseUrl, 'gcreate2', false);
    await request(env.baseUrl)
      .get('/auth/verify-email')
      .query({ token: await latestToken(creator.userId) })
      .expect(200);
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${creator.accessToken}`)
      .send({ name: 'gcreate2', slug: `gcreate2-${Date.now().toString(36)}`.slice(0, 30) });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeTruthy();
  });

  it('joinPublic 미인증 사용자는 403 EMAIL_NOT_VERIFIED', async () => {
    const owner = await signupAsUser(env.baseUrl, 'gjp');
    const create = await request(env.baseUrl)
      .post('/workspaces')
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'gjp',
        slug: `gjp-${Date.now().toString(36)}`.slice(0, 30),
        visibility: 'PUBLIC',
        category: 'TECH',
        description: 'public joinable workspace for S66 gate test',
      });
    const workspaceId = create.body.id as string;

    const joiner = await signupAsUser(env.baseUrl, 'gjp2', false); // unverified
    const join = await request(env.baseUrl)
      .post(`/workspaces/${workspaceId}/join`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${joiner.accessToken}`);
    expect(join.status).toBe(403);
    expect(join.body.errorCode).toBe('EMAIL_NOT_VERIFIED');
  });
});
