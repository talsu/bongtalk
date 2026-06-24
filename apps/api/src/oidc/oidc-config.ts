// task-078 (Family SSO / OIDC IdP): oidc-provider 설정 빌더.
//
// 모든 env 는 process.env 에서 직접 읽는다(이 레포 컨벤션 — @nestjs/config 미사용). 서명키는
// P0 에서 생성해 .env.prod(env_file)에 base64 1줄로 넣어둔 SSO_JWT_PRIVATE_KEY_B64(PKCS#8
// PEM RSA2048)에서 jose 로 JWK 로 변환한다. 공개키는 oidc-provider 가 JWKS 로 노출한다.
// 휘발성 저장은 Redis 어댑터, durable RP 메타는 OAuthClient 표(부팅 시 로드).
import { makeRedisAdapter } from './redis-adapter';
import { esmImport } from './esm';
import type { Redis } from 'ioredis';

const ACCESS_TTL = 900; // 15m — qufox access JWT 와 동일
const REFRESH_TTL = 7 * 24 * 60 * 60; // 7d — qufox refresh family 와 동일

export interface OidcDeps {
  redis: Redis;
  loadClients: () => Promise<any[]>;
  loadAccountClaims: (sub: string) => Promise<Record<string, any> | null>;
}

export function isOidcEnabled(): boolean {
  return Boolean((process.env.SSO_ISSUER ?? '').trim());
}

// task-078 P2-acl: SSO 관리자(=RP 접근 승인 권한 + 모든 RP 항상 허용). SSO_ADMIN_EMAILS(쉼표
// 구분, 대소문자 무시). 운영자 잠김 방지 + 승인 게이트 관리 주체.
export function ssoAdminEmails(): string[] {
  return (process.env.SSO_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isSsoAdminEmail(email: string | null | undefined): boolean {
  if (!email) {
    return false;
  }
  return ssoAdminEmails().includes(email.trim().toLowerCase());
}

export function getIssuer(): string {
  const issuer = (process.env.SSO_ISSUER ?? '').trim();
  if (!issuer) {
    throw new Error('SSO_ISSUER is not set');
  }
  return issuer;
}

/** SSO_JWT_PRIVATE_KEY_B64(base64 PKCS#8 PEM) → JWKS(서명용 단일 키). */
export async function buildJwks(): Promise<{ keys: any[] }> {
  const b64 = (process.env.SSO_JWT_PRIVATE_KEY_B64 ?? '').trim();
  if (!b64) {
    throw new Error('SSO_JWT_PRIVATE_KEY_B64 is not set');
  }
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  const alg = (process.env.SSO_JWT_ALG ?? 'RS256').trim();
  const kid = (process.env.SSO_JWT_KID ?? '').trim();
  const jose = await esmImport('jose');
  // extractable: true 가 있어야 exportJWK 가 개인키를 JWK 로 뽑을 수 있다(WebCrypto 기본은
  // non-extractable). oidc-provider 의 jwks 는 서명용 *개인* JWK 를 요구한다.
  const key = await jose.importPKCS8(pem, alg, { extractable: true });
  const jwk = await jose.exportJWK(key);
  jwk.use = 'sig';
  jwk.alg = alg;
  if (kid) {
    jwk.kid = kid;
  }
  return { keys: [jwk] };
}

export async function buildConfiguration(deps: OidcDeps): Promise<Record<string, any>> {
  const jwks = await buildJwks();
  const clients = await deps.loadClients();
  // 쿠키 서명(keygrip)용 시크릿 — APP_ENCRYPTION_KEY 재사용(HMAC 용도라 별도 키 불요).
  // ★보안(reviewer/scanner H2): prod 에서 키가 없으면 하드코딩 폴백으로 *조용히* 떨어지면
  // 안 된다(예측 가능한 키 → sso_session/interaction 쿠키 위조). prod+SSO 활성인데 키가
  // 없으면 throw 한다 — onModuleInit 의 try/catch 가 잡아 provider 를 dark 로 둔다(fail-safe).
  const appKey = (process.env.APP_ENCRYPTION_KEY ?? '').trim();
  if (!appKey && process.env.NODE_ENV === 'production') {
    throw new Error(
      'OIDC enabled in production but APP_ENCRYPTION_KEY is unset — refusing predictable cookie-signing key',
    );
  }
  const cookieKey = appKey || 'qufox-sso-dev-cookie-key';
  const secureCookies = process.env.NODE_ENV === 'production';

  return {
    adapter: makeRedisAdapter(deps.redis),
    clients,
    jwks,
    // IdP 자체 세션 쿠키는 sso_session(SameSite=Lax) — qufox 의 refresh_token(host-only,
    // SameSite=strict)과 완전히 분리된다(P1 불변 규칙).
    cookies: {
      keys: [cookieKey],
      names: {
        session: 'sso_session',
        interaction: 'sso_interaction',
        resume: 'sso_resume',
        state: 'sso_state',
      },
      long: { signed: true, httpOnly: true, sameSite: 'lax', secure: secureCookies },
      short: { signed: true, httpOnly: true, sameSite: 'lax', secure: secureCookies },
    },
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'preferred_username', 'picture', 'updated_at'],
    },
    // first-party 패밀리 RP 편의를 위해 요청 scope 의 클레임을 id_token 에 직접 싣는다
    // (기본 true 면 sub 만 들어가고 나머지는 /userinfo 로만 — RP 가 별도 호출 필요). false 로
    // RP 가 userinfo 왕복 없이 email/preferred_username 등으로 신원을 구성한다.
    conformIdTokenClaims: false,
    scopes: ['openid', 'offline_access', 'profile', 'email'],
    features: {
      devInteractions: { enabled: false }, // 자체 interaction(P1b) 사용 — 데모 UI 비활성
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        // 로그아웃 확인 페이지를 자동 제출해 seamless 하게 — RP 가 /session/end 로 보내면
        // 사용자 클릭 없이 IdP 세션을 끝내고 post_logout_redirect_uri 로 복귀한다. framing 은
        // buildSsoApp 의 X-Frame-Options:DENY 로 차단됨; CSP 만 미설정(인라인 자동제출 스크립트
        // 호환 위해 deferred — task-078 H1 백로그). form 은 oidc-provider 가 xsrf 포함 제공한다.
        async logoutSource(ctx: any, form: string): Promise<void> {
          // oidc-provider 가 주는 form 에는 xsrf 만 있고 `logout` 필드가 없다 — JS .submit() 은
          // 버튼 값을 안 보내므로 logout=yes 를 명시 주입해야 confirm 이 실제로 세션을 끝낸다.
          // JS 비활성 폴백으로 noscript 제출 버튼도 둔다(가용성). 고정 id 'op.logoutForm' 우선.
          const withFields = form.replace(
            '</form>',
            '<input type="hidden" name="logout" value="yes"/>' +
              '<noscript><button type="submit">로그아웃</button></noscript></form>',
          );
          ctx.body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>로그아웃</title></head><body>${withFields}<script>(document.getElementById('op.logoutForm')||document.forms[0]).submit()</script></body></html>`;
        },
        // 로그아웃 성공 화면. 보통은 post_logout_redirect_uri 로 리다이렉트돼 안 보이지만, 그
        // URI 가 없는 호출 대비 DS 로 스타일(기본 oidc 페이지가 무스타일이라 어색했던 것 보완).
        async postLogoutSuccessSource(ctx: any): Promise<void> {
          ctx.body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>로그아웃됨 — qufox 패밀리</title><link rel="stylesheet" href="https://design.qufox.com/tokens.css"><link rel="stylesheet" href="https://design.qufox.com/components.css"><style>body{margin:0;min-height:100vh;background:var(--bg-app);display:flex;align-items:center;justify-content:center;padding:var(--s-6)}</style></head><body><main class="qf-card" style="width:100%;max-width:380px;box-shadow:var(--elev-2)"><div class="qf-card__body" style="padding:var(--s-8);text-align:center"><img src="https://design.qufox.com/brand-assets/svg/fox-symbol-dark.svg" alt="" width="48" height="48" style="margin-bottom:var(--s-4)"><h1 style="margin:0;font-size:var(--fs-20);font-weight:600;color:var(--text-strong)">로그아웃되었습니다</h1><p style="margin:var(--s-2) 0 0;font-size:var(--fs-13);color:var(--text-muted)">qufox 패밀리에서 로그아웃했습니다.</p></div></main></body></html>`;
        },
      },
      backchannelLogout: { enabled: true },
    },
    ttl: {
      AccessToken: ACCESS_TTL,
      IdToken: ACCESS_TTL,
      RefreshToken: REFRESH_TTL,
      Session: REFRESH_TTL,
      Grant: REFRESH_TTL,
      Interaction: 600,
      AuthorizationCode: 60,
    },
    // /authorize 시 로그인/동의 UI 로 보낼 URL(P1b 에서 interaction 컨트롤러가 처리).
    interactions: {
      url(_ctx: any, interaction: any): string {
        return `/interaction/${interaction.uid}`;
      },
    },
    // sub → id_token/userinfo 클레임. 비활성 계정/미존재는 undefined → 계정 없음 처리.
    async findAccount(_ctx: any, sub: string): Promise<any> {
      const claims = await deps.loadAccountClaims(sub);
      if (!claims) {
        return undefined;
      }
      return {
        accountId: sub,
        async claims(): Promise<Record<string, any>> {
          return { sub, ...claims };
        },
      };
    },
    pkce: { required: (): boolean => true },
  };
}
