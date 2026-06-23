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
  const cookieKey = (process.env.APP_ENCRYPTION_KEY ?? '').trim() || 'qufox-sso-dev-cookie-key';
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
    scopes: ['openid', 'offline_access', 'profile', 'email'],
    features: {
      devInteractions: { enabled: false }, // 자체 interaction(P1b) 사용 — 데모 UI 비활성
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true },
      rpInitiatedLogout: { enabled: true },
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
