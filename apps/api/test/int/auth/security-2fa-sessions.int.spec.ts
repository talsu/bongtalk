/**
 * S77b (D14 / FR-PS-15·20) — 보안: 자격증명 변경 + TOTP 2FA + 세션 관리.
 *
 *   - TOTP setup(no-store 헤더 · Redis 단일키 재발급) → verify(백업코드 10개) → disable
 *     (비번 + 코드 · 코드 누락 시 403 TOTP_CODE_REQUIRED).
 *   - change-password(2FA 활성 시 타 세션 revoke) · change-email(인증메일 발송).
 *   - sessions(목록 · isCurrent · 개별/전체 revoke · SESSION_NOT_FOUND).
 *   - 키 미설정 시 ENCRYPTION_UNAVAILABLE(503).
 *
 * signupAsUser 는 emailVerified=true 패턴(기존 int 무회귀). STRONG_PW 는 현재 비번 재확인에 쓴다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { WsIntEnv, setupWsIntEnv, signupAsUser, STRONG_PW } from '../workspaces/helpers';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// 새 로그인 → 새 세션(familyId) 1개. accessToken + refresh 쿠키를 돌려준다.
async function loginAgain(
  email: string,
  userAgent: string,
): Promise<{ token: string; cookie: string }> {
  const res = await request(env.baseUrl)
    .post('/auth/login')
    .set('origin', ORIGIN)
    .set('User-Agent', userAgent)
    .send({ email, password: STRONG_PW })
    .expect(200);
  const setCookie = res.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie =
    list.map((c: string) => c.split(';')[0]).find((c: string) => c.startsWith('refresh_token=')) ??
    '';
  return { token: res.body.accessToken, cookie };
}

describe('S77b TOTP 2FA — setup → verify → disable (FR-PS-15·20)', () => {
  it('setup 은 200 + Cache-Control no-store + otpauth/secret/qr + Redis 단일키 TTL', async () => {
    const u = await signupAsUser(env.baseUrl, 'totpsetup');
    const res = await request(env.baseUrl).post('/me/2fa/totp/setup').set(auth(u.accessToken));
    expect(res.status).toBe(200);
    // FR-PS-20: no-store 헤더 필수.
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.otpauthUri).toContain('otpauth://totp/');
    expect(res.body.secret).toBeTruthy();
    expect(res.body.qrDataUri).toMatch(/^data:image\/png;base64,/);

    // Redis 단일키(totp:setup:{userId}) 가 존재하고 TTL 이 (0, 600] 범위.
    const ttl = await env.redis.ttl(`totp:setup:${u.userId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    const stored1 = await env.redis.get(`totp:setup:${u.userId}`);
    expect(stored1).toBe(res.body.secret);

    // 재호출 시 기존 키 DEL 후 재발급(단일키 — 마지막 setup 시크릿만 유효).
    const res2 = await request(env.baseUrl).post('/me/2fa/totp/setup').set(auth(u.accessToken));
    expect(res2.status).toBe(200);
    expect(res2.body.secret).not.toBe(res.body.secret);
    const stored2 = await env.redis.get(`totp:setup:${u.userId}`);
    expect(stored2).toBe(res2.body.secret);
  });

  it('verify 성공 → totpEnabled=true + 백업코드 10개(평문 1회) + status 반영', async () => {
    const u = await signupAsUser(env.baseUrl, 'totpverify');
    const setup = await request(env.baseUrl)
      .post('/me/2fa/totp/setup')
      .set(auth(u.accessToken))
      .expect(200);
    const code = authenticator.generate(setup.body.secret);

    const res = await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code });
    expect(res.status).toBe(200);
    expect(res.body.totpEnabled).toBe(true);
    expect(res.body.backupCodes).toHaveLength(10);
    expect(new Set(res.body.backupCodes).size).toBe(10);

    // DB 에 백업코드 10행 + totpEnabled=true.
    const count = await env.prisma.backupCode.count({ where: { userId: u.userId } });
    expect(count).toBe(10);
    const status = await request(env.baseUrl).get('/me/2fa').set(auth(u.accessToken)).expect(200);
    expect(status.body.totpEnabled).toBe(true);

    // setup Redis 키는 소진(verify 후 정리).
    expect(await env.redis.get(`totp:setup:${u.userId}`)).toBeNull();
  });

  it('verify 잘못된 코드는 403 TOTP_INVALID', async () => {
    const u = await signupAsUser(env.baseUrl, 'totpbad');
    await request(env.baseUrl).post('/me/2fa/totp/setup').set(auth(u.accessToken)).expect(200);
    const res = await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code: '000000' });
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe('TOTP_INVALID');
  });

  it('disable: 코드 누락은 403 TOTP_CODE_REQUIRED, 비번+코드면 해제', async () => {
    const u = await signupAsUser(env.baseUrl, 'totpdisable');
    const setup = await request(env.baseUrl)
      .post('/me/2fa/totp/setup')
      .set(auth(u.accessToken))
      .expect(200);
    await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    // 비번만(코드 누락) → 403 TOTP_CODE_REQUIRED.
    const noCode = await request(env.baseUrl)
      .delete('/me/2fa/totp')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW });
    expect(noCode.status).toBe(403);
    expect(noCode.body.errorCode).toBe('TOTP_CODE_REQUIRED');

    // 비번 틀림 + 코드 → 403 PASSWORD_INCORRECT.
    const badPw = await request(env.baseUrl)
      .delete('/me/2fa/totp')
      .set(auth(u.accessToken))
      .send({
        currentPassword: 'wrong-password-1',
        totpCode: authenticator.generate(setup.body.secret),
      });
    expect(badPw.status).toBe(403);
    expect(badPw.body.errorCode).toBe('PASSWORD_INCORRECT');

    // SF1: verify 가 totp:last 에 사용 코드를 기록했으므로, 같은 step 코드를 disable 에 재사용하면
    // replay 로 거부된다. 30초 진행해 다른 step 코드를 쓴다.
    vi.setSystemTime(new Date('2025-01-01T00:00:31Z'));
    // 비번 + 유효 코드 → 204 해제.
    const ok = await request(env.baseUrl)
      .delete('/me/2fa/totp')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW, totpCode: authenticator.generate(setup.body.secret) });
    expect(ok.status).toBe(204);

    const status = await request(env.baseUrl).get('/me/2fa').set(auth(u.accessToken)).expect(200);
    expect(status.body.totpEnabled).toBe(false);
    expect(await env.prisma.backupCode.count({ where: { userId: u.userId } })).toBe(0);
  });

  it('키 미설정 시 setup 은 503 ENCRYPTION_UNAVAILABLE (크래시 금지)', async () => {
    const u = await signupAsUser(env.baseUrl, 'totpnokey');
    const prev = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    try {
      const res = await request(env.baseUrl).post('/me/2fa/totp/setup').set(auth(u.accessToken));
      expect(res.status).toBe(503);
      expect(res.body.errorCode).toBe('ENCRYPTION_UNAVAILABLE');
    } finally {
      process.env.APP_ENCRYPTION_KEY = prev;
    }
  });
});

describe('S77b 자격증명 변경 (FR-PS-15)', () => {
  it('change-password: 현재 비번 재확인 + 2FA 활성 시 타 세션 revoke', async () => {
    const u = await signupAsUser(env.baseUrl, 'chpw');

    // 2FA 활성화(타 세션 revoke 트리거 조건).
    const setup = await request(env.baseUrl)
      .post('/me/2fa/totp/setup')
      .set(auth(u.accessToken))
      .expect(200);
    await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    // 다른 디바이스 로그인 → 추가 세션(familyId) 생성.
    const other = await loginAgain(u.email, 'OtherDevice/1.0');
    let sessions = await request(env.baseUrl)
      .get('/me/sessions')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .expect(200);
    expect(sessions.body.sessions.length).toBeGreaterThanOrEqual(2);

    // 비번 틀림 → 403 PASSWORD_INCORRECT.
    const bad = await request(env.baseUrl)
      .post('/users/me/change-password')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .send({ currentPassword: 'nope-nope-1', newPassword: 'Quanta-New-Pass-99!' });
    expect(bad.status).toBe(403);
    expect(bad.body.errorCode).toBe('PASSWORD_INCORRECT');

    // SF3: 2FA 활성이라 totpCode 가 필수. 새 step 코드(replay 회피)로 정상 변경 → 204. 2FA
    // 활성 + 쿠키 동반(familyId 해석)이라 타 세션이 revoke 된다.
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    const ok = await request(env.baseUrl)
      .post('/users/me/change-password')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .send({
        currentPassword: STRONG_PW,
        newPassword: 'Quanta-New-Pass-99!',
        totpCode: authenticator.generate(setup.body.secret),
      });
    expect(ok.status).toBe(204);

    // 현재 세션은 남고 타 세션(other)은 revoke 됐다 — 다른 쿠키로 refresh 시 401.
    sessions = await request(env.baseUrl)
      .get('/me/sessions')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .expect(200);
    expect(sessions.body.sessions).toHaveLength(1);
    expect(sessions.body.sessions[0].isCurrent).toBe(true);

    const refreshOther = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', ORIGIN)
      .set('Cookie', other.cookie);
    expect(refreshOther.status).toBe(401);
  });

  it('change-email: 비번 재확인 후 신규 이메일로 인증메일(토큰 행) 발송', async () => {
    const u = await signupAsUser(env.baseUrl, 'chemail');
    const newEmail = `chemail-new-${Date.now()}@qufox.dev`;
    const res = await request(env.baseUrl)
      .post('/users/me/change-email')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW, newEmail });
    expect(res.status).toBe(200);
    expect(res.body.pendingEmail).toBe(newEmail);

    // 인증 토큰 행이 발급됐다(발송까지만 — 확인 콜백은 OUT/S77c).
    const token = await env.prisma.emailVerificationToken.findFirst({
      where: { userId: u.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(token).toBeTruthy();

    // 비번 틀림 → 403.
    const bad = await request(env.baseUrl)
      .post('/users/me/change-email')
      .set(auth(u.accessToken))
      .send({ currentPassword: 'wrong-1', newEmail });
    expect(bad.status).toBe(403);
    expect(bad.body.errorCode).toBe('PASSWORD_INCORRECT');
  });

  // SF2·SF3 (security HIGH-2·3) fix-forward: 2FA 활성 사용자는 비번/이메일 변경 시 TOTP 코드를
  // 필수로 재확인한다(누락 403 TOTP_CODE_REQUIRED · 불일치 403 TOTP_INVALID · 유효코드면 변경).
  // 비번 단독으로 자격증명을 바꾸는 2FA 우회를 막는다.
  it('SF3 change-password: 2FA 활성 시 totpCode 누락은 403 TOTP_CODE_REQUIRED, 유효코드면 변경', async () => {
    const u = await signupAsUser(env.baseUrl, 'sf3pw');
    const setup = await request(env.baseUrl)
      .post('/me/2fa/totp/setup')
      .set(auth(u.accessToken))
      .expect(200);
    await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    // 코드 누락 → 403 TOTP_CODE_REQUIRED (비번이 맞아도 거부 — 2FA 우회 차단).
    const noCode = await request(env.baseUrl)
      .post('/users/me/change-password')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .send({ currentPassword: STRONG_PW, newPassword: 'Quanta-New-Sf3-99!' });
    expect(noCode.status).toBe(403);
    expect(noCode.body.errorCode).toBe('TOTP_CODE_REQUIRED');

    // 잘못된 코드 → 403 TOTP_INVALID.
    const badCode = await request(env.baseUrl)
      .post('/users/me/change-password')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .send({ currentPassword: STRONG_PW, newPassword: 'Quanta-New-Sf3-99!', totpCode: '000000' });
    expect(badCode.status).toBe(403);
    expect(badCode.body.errorCode).toBe('TOTP_INVALID');

    // 새 step 코드(replay 회피 — setup/verify 와 다른 step)로 정상 변경 → 204.
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    const ok = await request(env.baseUrl)
      .post('/users/me/change-password')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .send({
        currentPassword: STRONG_PW,
        newPassword: 'Quanta-New-Sf3-99!',
        totpCode: authenticator.generate(setup.body.secret),
      });
    expect(ok.status).toBe(204);
  });

  it('SF2 change-email: 2FA 활성 시 totpCode 누락은 403 TOTP_CODE_REQUIRED, 유효코드면 발송', async () => {
    const u = await signupAsUser(env.baseUrl, 'sf2email');
    const setup = await request(env.baseUrl)
      .post('/me/2fa/totp/setup')
      .set(auth(u.accessToken))
      .expect(200);
    await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    const newEmail = `sf2-new-${Date.now()}@qufox.dev`;
    // 코드 누락 → 403 TOTP_CODE_REQUIRED.
    const noCode = await request(env.baseUrl)
      .post('/users/me/change-email')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW, newEmail });
    expect(noCode.status).toBe(403);
    expect(noCode.body.errorCode).toBe('TOTP_CODE_REQUIRED');

    // 새 step 코드로 정상 발송 → 200.
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    const ok = await request(env.baseUrl)
      .post('/users/me/change-email')
      .set(auth(u.accessToken))
      .send({
        currentPassword: STRONG_PW,
        newEmail,
        totpCode: authenticator.generate(setup.body.secret),
      });
    expect(ok.status).toBe(200);
    expect(ok.body.pendingEmail).toBe(newEmail);
  });

  // RF2 (reviewer M2) fail-open: 현재 familyId 를 해석할 쿠키가 없으면(쿠키 미동반) "현재 제외
  // revoke" 가 현재 세션까지 끊을 위험이 있어 revoke 를 생략한다(현재 세션 보존 보장). 따라서
  // 다른 디바이스 세션이 그대로 살아 있어야 한다(전체가 끊기지 않음).
  it('RF2 change-password (2FA · 쿠키 부재): familyId=null 이면 타 세션을 보존(전체 revoke 안 함)', async () => {
    const u = await signupAsUser(env.baseUrl, 'rf2');
    const setup = await request(env.baseUrl)
      .post('/me/2fa/totp/setup')
      .set(auth(u.accessToken))
      .expect(200);
    await request(env.baseUrl)
      .post('/me/2fa/totp/verify')
      .set(auth(u.accessToken))
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    // 다른 디바이스 로그인 → 추가 세션.
    const other = await loginAgain(u.email, 'Rf2Other/1.0');

    // 쿠키를 동반하지 않고(familyId 해석 불가) 비번 변경 → 새 step 코드.
    vi.setSystemTime(new Date('2025-01-01T00:01:00Z'));
    const ok = await request(env.baseUrl)
      .post('/users/me/change-password')
      .set(auth(u.accessToken))
      // ★ Cookie 미설정 — currentFamilyId=null 분기.
      .send({
        currentPassword: STRONG_PW,
        newPassword: 'Quanta-New-Rf2-99!',
        totpCode: authenticator.generate(setup.body.secret),
      });
    expect(ok.status).toBe(204);

    // fail-open: 타 세션(other)이 revoke 되지 않고 살아 있어 refresh 가 성공한다.
    const refreshOther = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', ORIGIN)
      .set('Cookie', other.cookie);
    expect(refreshOther.status).toBe(200);
  });
});

describe('S77b 세션 관리 (FR-PS-15)', () => {
  it('목록은 isCurrent 매핑 + 개별 로그아웃 + SESSION_NOT_FOUND', async () => {
    const u = await signupAsUser(env.baseUrl, 'sess');
    const other = await loginAgain(u.email, 'SessOther/1.0');

    const list = await request(env.baseUrl)
      .get('/me/sessions')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .expect(200);
    const sessions = list.body.sessions as Array<{ id: string; isCurrent: boolean }>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const current = sessions.filter((s) => s.isCurrent);
    expect(current).toHaveLength(1);
    const otherSession = sessions.find((s) => !s.isCurrent);
    expect(otherSession).toBeTruthy();

    // 존재하지 않는 세션 → 404 SESSION_NOT_FOUND.
    const notFound = await request(env.baseUrl)
      .delete('/me/sessions/00000000-0000-4000-8000-000000000000')
      .set(auth(u.accessToken));
    expect(notFound.status).toBe(404);
    expect(notFound.body.errorCode).toBe('SESSION_NOT_FOUND');

    // 개별 로그아웃 → 204, 그 세션 쿠키로 refresh 시 401.
    const del = await request(env.baseUrl)
      .delete(`/me/sessions/${otherSession!.id}`)
      .set(auth(u.accessToken));
    expect(del.status).toBe(204);
    const refreshOther = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', ORIGIN)
      .set('Cookie', other.cookie);
    expect(refreshOther.status).toBe(401);
  });

  it('타인 세션 로그아웃은 SESSION_NOT_FOUND(소유 검증)', async () => {
    const a = await signupAsUser(env.baseUrl, 'sessa');
    const b = await signupAsUser(env.baseUrl, 'sessb');
    // a 의 세션 id 를 얻는다.
    const list = await request(env.baseUrl)
      .get('/me/sessions')
      .set(auth(a.accessToken))
      .set('Cookie', a.cookie)
      .expect(200);
    const aSessionId = list.body.sessions[0].id as string;
    // b 가 a 의 세션 id 로 삭제 시도 → 404(소유 아님).
    const res = await request(env.baseUrl)
      .delete(`/me/sessions/${aSessionId}`)
      .set(auth(b.accessToken));
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe('SESSION_NOT_FOUND');
  });

  it('전체 로그아웃은 현재 세션만 남긴다', async () => {
    const u = await signupAsUser(env.baseUrl, 'sessall');
    await loginAgain(u.email, 'AllOther1/1.0');
    await loginAgain(u.email, 'AllOther2/1.0');

    let list = await request(env.baseUrl)
      .get('/me/sessions')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .expect(200);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(3);

    const del = await request(env.baseUrl)
      .delete('/me/sessions')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie);
    expect(del.status).toBe(204);

    list = await request(env.baseUrl)
      .get('/me/sessions')
      .set(auth(u.accessToken))
      .set('Cookie', u.cookie)
      .expect(200);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].isCurrent).toBe(true);
  });
});
