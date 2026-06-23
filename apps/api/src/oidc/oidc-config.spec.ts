// task-078 (Family SSO / OIDC IdP): OIDC 설정/어댑터 단위 테스트.
//
// DB/Redis/sso host 없이도 검증되는 것: (1) SSO_ISSUER 토글, (2) PEM→JWKS 변환(RS256·kid·
// use:sig·개인성분), (3) Redis 어댑터 키 네임스페이스, (4) ★우리 configuration 으로
// oidc-provider 가 실제로 생성되는지(설정 키 유효성 — provider 가 잘못된 키에 throw 하므로
// 이 테스트가 config 정합성 게이트 역할).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildConfiguration,
  buildJwks,
  getIssuer,
  isOidcEnabled,
} from './oidc-config';
import { makeRedisAdapter } from './redis-adapter';
import { esmImport } from './esm';

const ISSUER = 'https://sso.test.local';

describe('oidc-config (task-078)', () => {
  let savedKey: string | undefined;
  let savedIssuer: string | undefined;
  let savedKid: string | undefined;

  beforeAll(async () => {
    savedKey = process.env.SSO_JWT_PRIVATE_KEY_B64;
    savedIssuer = process.env.SSO_ISSUER;
    savedKid = process.env.SSO_JWT_KID;
    // 테스트용 1회성 RS256 키를 생성해 base64 PKCS#8 로 주입(프로덕션과 동일 경로).
    const jose = await esmImport('jose');
    const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const pem: string = await jose.exportPKCS8(privateKey);
    process.env.SSO_JWT_PRIVATE_KEY_B64 = Buffer.from(pem, 'utf8').toString('base64');
    process.env.SSO_JWT_ALG = 'RS256';
    process.env.SSO_JWT_KID = 'sso-test';
    process.env.SSO_ISSUER = ISSUER;
  });

  afterAll(() => {
    const restore = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('SSO_JWT_PRIVATE_KEY_B64', savedKey);
    restore('SSO_ISSUER', savedIssuer);
    restore('SSO_JWT_KID', savedKid);
  });

  it('isOidcEnabled / getIssuer reflect SSO_ISSUER', () => {
    expect(isOidcEnabled()).toBe(true);
    expect(getIssuer()).toBe(ISSUER);
  });

  it('buildJwks derives an RS256 signing JWK with kid + private component', async () => {
    const jwks = await buildJwks();
    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key.kty).toBe('RSA');
    expect(key.alg).toBe('RS256');
    expect(key.use).toBe('sig');
    expect(key.kid).toBe('sso-test');
    expect(typeof key.d).toBe('string'); // 개인 성분(서명용)
  });

  it('redis adapter namespaces keys under oidc:<Model>:', () => {
    const Adapter = makeRedisAdapter({} as never);
    const instance = new Adapter('Session') as { key(id: string): string };
    expect(instance.key('abc')).toBe('oidc:Session:abc');
  });

  it('constructs an oidc-provider instance from our configuration (config validity gate)', async () => {
    const mod = await esmImport('oidc-provider');
    const Provider = mod.default ?? mod;
    const configuration = await buildConfiguration({
      redis: {} as never,
      loadClients: async () => [],
      loadAccountClaims: async () => null,
    });
    const provider = new Provider(ISSUER, configuration);
    expect(provider.issuer).toBe(ISSUER);
    expect(typeof provider.callback).toBe('function');
    expect(typeof provider.callback()).toBe('function');
  });
});
