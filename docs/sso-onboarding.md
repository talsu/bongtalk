# qufox 패밀리 SSO — 새 사이트 온보딩 가이드

qufox.com 은 패밀리 OIDC **Identity Provider**(IdP)다(`sso.qufox.com`, panva oidc-provider,
RS256/JWKS, authorization-code + PKCE). 새 패밀리 사이트를 추가하면 그 사이트는 **RP**(Relying
Party)가 되어 "한 번 qufox 로그인 → 자동 인증"에 합류한다. task-078 참조. 기존 RP 예:
**skulk**(NestJS, TS) · **stream**(vanilla Express, JS) — 스택별로 둘 중 하나를 복사한다.

## 핵심 사실
- IdP issuer: `https://sso.qufox.com` · discovery: `/.well-known/openid-configuration` · JWKS: `/jwks`.
- 모든 RP 는 **public client + PKCE**(client_secret 없음 — first-party 안전). PKCE S256 + 정확
  redirect_uri 매칭이 보안 근거.
- RP 는 자기 기존 세션 쿠키를 유지하되, 그 안의 신원이 **qufox `sub`(User.id, UUID)** 가 된다.
- IdP 세션 쿠키 `sso_session`(SameSite=Lax) 은 qufox 의 `refresh_token`(strict)과 분리.

## 1. DNS + TLS + nginx (스택 표준)
1. Cloudflare 에 `new.qufox.com` A/CNAME.
2. `/volume2/dockers/nginx/new.sh` 의 `-d` 목록에 `new.qufox.com` 추가 → `sudo bash new.sh`
   (라이브 SAN 전부 유지된 채 재발급) → nginx recreate. (cert 런북: `nginx/docs/CERT-RUNBOOK.md`.)
3. nginx.conf 에 `new.qufox.com` 443 server 블록 추가(백엔드로 프록시).

## 2. qufox 에 OAuthClient 등록 (한 행)
qufox-api 컨테이너에서 Prisma upsert(부팅 시 로드되므로 **등록 후 qufox-api 재시작 필수**):

```js
// docker exec -i -w /app qufox-api node < register-client.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const data = {
  name: 'New Site',
  clientSecretEnc: null,                                  // public client (PKCE)
  redirectUris: ['https://new.qufox.com/auth/callback'],  // ★정확 일치(스택의 콜백 경로)
  metadata: {
    postLogoutRedirectUris: ['https://new.qufox.com/'],
    scopes: ['openid', 'profile', 'email'],
    grantTypes: ['authorization_code'],
    responseTypes: ['code'],
    tokenAuthMethod: 'none',
  },
  enabled: true,
};
p.oAuthClient.upsert({ where: { clientId: 'newsite' }, create: { clientId: 'newsite', ...data }, update: data })
  .then(() => p.$disconnect());
```
→ `sudo docker restart qufox-api` (로그에 `clients=N` 증가 확인).

## 3. RP 코드 드롭인 (스택별 복사)
검증된 무-ESM RP 패턴(jose/openid-client 불요):
- **NestJS/TS**: `skulk/apps/api/src/auth/sso.ts` + `auth.ts`(GET /auth/login·/auth/callback·/auth/logout) 복사. jsonwebtoken 추가. token/jwks 는 docker `internal` 망이면 `http://qufox-api:3001` + `Host: sso.qufox.com` 헤더(node:http).
- **vanilla Node**: `qufox-streaming-server/services/sso.js` + `controllers/auth-controller.js` 라우트 복사. docker 망 **밖**이면 token/jwks 를 `https://127.0.0.1:10443` + TLS `servername`/`Host: sso.qufox.com`(node:https)로 — nginx 헤어핀(LE SAN 으로 cert 검증).

흐름: GET /auth/login(PKCE+state+nonce 를 서명 tx 쿠키에 봉인 → IdP `/auth` 리다이렉트) →
GET /auth/callback(code 교환 + id_token RS256/JWKS 검증 → 로컬 세션 발급, 신원=qufox sub) →
GET /auth/logout(로컬 정리 + IdP `/session/end` 로 단일 로그아웃).

env(비-시크릿): `SSO_ISSUER=https://sso.qufox.com`, `SSO_CLIENT_ID=newsite`,
`SSO_REDIRECT_URI=https://new.qufox.com/auth/callback`, (+ 망 밖이면 게이트웨이 오리진).

## 4. 프론트
로그인 화면에 "qufox 계정으로 로그인" 버튼 → `/auth/login` 으로 top-level 네비게이션.
기존 로컬 로그인은 **break-glass(비상용)** 로 유지(IdP 장애 시 운영자 미잠김).

## 5. 배포 + 검증
스택 표준 배포 후 E2E(운영자 계정):
`/auth/login → IdP 폼 → (자동 동의) → /auth/callback → 세션` 이 성립하고 `/auth/me` 가 qufox
신원을 반환하는지 curl(쿠키 jar, `--resolve` 로 new.qufox.com + sso.qufox.com → 127.0.0.1:10443)
로 확인.

> 정리: 새 사이트 = **OAuthClient 한 행 + qufox-api 재시작 + RP 코드 드롭인 + 표준 배포**.
> qufox-api/skulk/stream 의 기존 코드는 건드리지 않는다.
