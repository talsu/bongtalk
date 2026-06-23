// task-078 (Family SSO / OIDC IdP): interaction 브리지 단위 테스트.
//
// 실제 oidc-provider/Redis/DB 없이, stub provider + stub authService 로 브리지 *배선* 을
// 검증한다: (1) login prompt → 로그인 폼 렌더, (2) 유효 자격 → verifyCredentials 호출 +
// interactionFinished({login:{accountId}}), (3) 무효 자격 → 폼 재표시(에러), (4) consent
// prompt → 자동 grant + interactionFinished({consent:{grantId}}). 전체 OIDC 왕복(코드 발급)은
// 배포 후 라이브 검증.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { buildSsoApp } from './oidc-interaction';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import type { AuthService } from '../auth/auth.service';

function makeProvider(promptName: string) {
  const finished: any[] = [];
  const grants: any[] = [];
  const provider = {
    interactionDetails: vi.fn(async () => ({
      uid: 'u1',
      prompt: {
        name: promptName,
        details:
          promptName === 'consent'
            ? { missingOIDCScope: ['openid', 'profile'], missingOIDCClaims: ['email'] }
            : {},
      },
      params: { client_id: 'skulk' },
      session: { accountId: 'user-1' },
      grantId: undefined,
    })),
    interactionFinished: vi.fn(async (_req: any, res: any, result: any) => {
      finished.push(result);
      res.status(200).json(result);
    }),
    Grant: class {
      static async find(): Promise<any> {
        return undefined;
      }
      addOIDCScope = vi.fn();
      addOIDCClaims = vi.fn();
      addResourceScope = vi.fn();
      async save(): Promise<string> {
        grants.push('saved');
        return 'grant-1';
      }
    },
    callback: () => (_req: any, res: any) => res.status(404).end('oidc-fallback'),
  };
  return { provider, finished, grants };
}

describe('oidc interaction bridge (task-078)', () => {
  it('renders the login form for a login prompt', async () => {
    const { provider } = makeProvider('login');
    const app = buildSsoApp(provider as any, {} as AuthService);
    const res = await request(app).get('/interaction/u1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('action="/interaction/u1/login"');
    expect(res.text).toContain('qufox 계정으로 로그인');
    expect(res.text).toContain('skulk');
    // ★보안 H1: helmet 우회 보완 헤더가 sso 응답에 실린다.
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('on valid credentials calls verifyCredentials + interactionFinished(login)', async () => {
    const { provider, finished } = makeProvider('login');
    const authService = {
      verifyCredentials: vi.fn(async () => ({ id: 'user-1', email: 'a@b.c' })),
    } as unknown as AuthService;
    const app = buildSsoApp(provider as any, authService);

    const res = await request(app)
      .post('/interaction/u1/login')
      .type('form')
      .send({ email: 'a@b.c', password: 'pw' });

    expect(res.status).toBe(200);
    expect((authService.verifyCredentials as any)).toHaveBeenCalledWith(
      { email: 'a@b.c', password: 'pw' },
      expect.objectContaining({ ip: expect.any(String) }),
    );
    expect(finished).toEqual([{ login: { accountId: 'user-1' } }]);
  });

  it('on invalid credentials re-renders the form with an error', async () => {
    const { provider, finished } = makeProvider('login');
    const authService = {
      verifyCredentials: vi.fn(async () => {
        throw new DomainError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'bad');
      }),
    } as unknown as AuthService;
    const app = buildSsoApp(provider as any, authService);

    const res = await request(app)
      .post('/interaction/u1/login')
      .type('form')
      .send({ email: 'a@b.c', password: 'wrong' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('올바르지 않습니다');
    expect(finished).toEqual([]); // interaction 미완료
  });

  it('auto-grants consent and finishes the interaction', async () => {
    const { provider, finished } = makeProvider('consent');
    const app = buildSsoApp(provider as any, {} as AuthService);
    const res = await request(app).get('/interaction/u1');
    expect(res.status).toBe(200);
    expect(finished).toEqual([{ consent: { grantId: 'grant-1' } }]);
  });
});
