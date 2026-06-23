# Task 078 — qufox 패밀리 SSO (qufox.com = 중앙 OIDC IdP)

> 상태: PLAN (구현 미착수). 본 문서는 3개 레포에 걸친 멀티-페이즈 프로그램의 마스터 계획서입니다.
> 페이즈별로 개별 task 문서(078a/078b/...)로 분리해 실행할 수 있습니다.

## Context

qufox 패밀리 3개 사이트가 각자 로그인을 따로 구현하고 있어 사용자가 사이트마다 다시 로그인해야 합니다.
이를 **qufox.com을 단일 신원 제공자(Identity Provider)** 로 묶어 한 번 로그인하면 패밀리 전체에 적용되도록 하고,
앞으로 패밀리 사이트가 계속 늘어나도 **N번째 사이트는 코드가 아니라 설정**으로 추가되게 합니다.

### 현재 상태 (코드 확인 결과)

| | qufox.com | skulk.qufox.com | stream.qufox.com |
|---|---|---|---|
| 경로 | `/volume2/dockers/qufox` | `/volume2/dockers/skulk` | `/volume2/dockers/qufox-streaming` |
| 스택 | NestJS + React, Postgres+Prisma+Redis | NestJS + React, Mongo | vanilla Express + Vue, Mongo |
| 토큰 | JWT(HS256, 15m) + 회전 refresh(7d, Postgres) | JWT(HS256) 셀프 쿠키 8h | 불투명 세션 토큰(Mongo), 서명 없음 |
| 쿠키 | `refresh_token` host-only **SameSite=strict** | `skulk_auth` host-only Lax | `qf_auth` host-only Lax |
| 사용자 모델 | **진짜 다중 사용자**(UUID v4·email unique·argon2id·잠금·2FA·비활성화) | 없음 — 하드코딩 admin(`talsu`) | 사실상 없음 — 단일 계정(`talsu`), email 없음 |
| 배포/네트워크 | 컨테이너, `internal` docker net | 컨테이너, `internal` net | **PM2 4워커, docker net 밖**(호스트 192.168.0.71:3000-3003) |

공유 인프라: 단일 `nginx-proxy-1` + 단일 LE SAN 인증서(셋 다 HTTPS). 공유 사용자 저장소는 **없음**
(qufox=Postgres, skulk/stream=Mongo 서버 공유하나 DB·식별자 분리).

### 확정된 설계 결정 (사용자)

1. **미래 도메인: 다른 등록 도메인도 가능** → 공유 쿠키 영구 제외, 리다이렉트 OIDC가 유일한 정답.
2. **IdP 진입점: 전용 `sso.qufox.com`** vhost (→ 당분간 qufox-api:3001 컨테이너).
3. **로컬 로그인: SSO 전용 + 비상용(break-glass)만** (env 플래그 뒤로).
4. **구현: 검증 라이브러리 panva `oidc-provider`** + Prisma/Redis 어댑터.

## 아키텍처 결정 요약

- **신원 저장소 = qufox Postgres `User` 단일** (마이그레이션 0 — skulk/stream엔 옮길 진짜 사용자가 없음).
- **토큰 = RS256 + JWKS** (HS256 공유 시크릿 금지). RP는 공개키로 오프라인 검증.
- **흐름 = OIDC authorization code + PKCE.** RP는 id_token을 JWKS로 검증 → 자기 기존 세션 쿠키를 발급하되 신원은 qufox `sub`(UUID).
- **qufox 기존 세션 불변** — `refresh_token`(host-only/strict/HS256) 그대로. OIDC는 추가 표면. IdP 자체 세션만 별도 `SameSite=Lax` 쿠키.
- **클라이언트 audience 분리**(client_id별 aud) — RP 간 토큰 replay 차단.
- **공유 `.qufox.com` 쿠키는 신뢰 메커니즘으로 쓰지 않음** (IdP 자체 세션 최적화 용도로만 허용).

왜 공유 쿠키가 아닌가: (a) qufox refresh 쿠키 SameSite=strict, (b) 세 토큰 포맷 상호 검증 불가,
(c) stream이 docker net 밖이라 백채널 introspection 구조적 불가 — 셋 다 OIDC 리다이렉트가 우회.

## Scope

### IN
- qufox-api에 OIDC Provider 표면(panva `oidc-provider`, Prisma+Redis 어댑터): `/authorize` `/token` `/userinfo` `/jwks` `/.well-known/openid-configuration` + end_session + back-channel logout.
- RS256 키쌍·JWKS·kid 회전, OAuthClient/OAuthCode 등 Prisma 모델(reversible 마이그레이션).
- IdP 자체 세션 쿠키(`sso_session`, SameSite=Lax) — 기존 로그인 파이프라인(argon2/잠금/rate-limit/2FA/비활성화) 재사용.
- 전용 `sso.qufox.com` vhost(nginx 서버블록) + SAN 인증서에 추가.
- skulk RP 전환(NestJS), stream RP 전환(vanilla Express, 4워커/off-net 고려).
- 중앙 로그아웃·비활성화 전파(Redis `revoked:sub` + back-channel).
- 공용 `@qufox/sso-rp` 드롭인 미들웨어(미래 사이트 온보딩용).
- 각 사이트 로컬 로그인 → break-glass(env 플래그)로 격하.

### OUT
- 공유 `.qufox.com` 쿠키 기반 SSO(영구 제외).
- 패밀리 사이트 간 사용자 데이터 병합/마이그레이션(병합할 진짜 사용자 없음).
- 실시간(WebRTC/voice) 관련 변경.
- qufox-web을 RP로 전환(당분간 IdP 호스트로서 native 로그인 유지; 추후 선택).
- qufox-sso 별도 컨테이너 분리(P5, 보류).

## 단계별 계획 (라이브 무중단)

- **P0 — 준비/안전망.** RS256 키쌍 생성(0600, RP에 절대 복사 금지). `.env.prod`에 `APP_ENCRYPTION_KEY` 추가(현재 부재 확인). ⚠️ **certbot 함정:** 레포 `docker-compose.certbot.yml`의 `-d` 목록이 라이브 인증서보다 적음(skulk/design/llmapi 누락) → 그대로 갱신 시 인증서가 줄어 타 사이트 TLS 파손. 라이브 `fullchain.pem`에서 전체 SAN 복원 후 `sso.qufox.com` 추가해 갱신.
- **P1 — qufox-api에 OIDC 표면(다크).** panva `oidc-provider` + Prisma/Redis 어댑터, OAuthClient/OAuthCode 모델, `sso_session`(Lax) 쿠키. `/authorize`를 기존 `AuthService.login`에 브리지. `refresh_token`(strict) 불변. 사용자 체감 0.
- **P2 — skulk RP 전환(최저 위험).** ~85줄 `auth.ts`만 교체, 백채널 토큰교환은 `internal` 네트워크로 컨테이너 직통(`http://qufox-api:3001`). `JwtAuthGuard`/`@Roles` 유지(role claim 매핑). `SKULK_AUTH_USER/PASS_HASH`는 break-glass 플래그 뒤로, `assertProdSecrets` 완화. dual-read 컷오버.
- **P3 — stream RP 전환(난관, 별도 게이트).** `openid-client`+`jose` 추가, `/auth/login`+`/auth/callback`. 토큰교환은 `https://sso.qufox.com` 경유(off-net + qufox-api 포트 미개방). state/nonce는 서명된 stateless 쿠키(4워커 무관), JWKS는 워커별 캐시. `ensureSingleActiveUser` 완화해 federated sub upsert. **out-of-repo nginx 콜백 경로 조정 필요(추적 안 됨 — 스냅샷·스모크 필수).** `QF_AUTH_USER`는 break-glass.
- **P4 — 폐기/단일 로그아웃 강화 + SDK 추출.** qufox 비활성화/비번재설정 훅 → back-channel logout + Redis `revoked:sub`. RP 세션 단명(15m + `prompt=none` silent re-auth). `@qufox/sso-rp` 퍼블리시.
- **P5 (보류) — qufox-sso 별도 컨테이너 분리.** 운영 격리(재시작/키 blast-radius/rate limit)가 정말 필요할 때만. 동일 `@qufox` 워크스페이스 패키지·동일 Postgres/Redis 재사용이라 분리는 기계적.

## Acceptance Criteria (기계 검증)

- [ ] `https://sso.qufox.com/.well-known/openid-configuration` 200, JWKS에 RS256 공개키(kid) 노출.
- [ ] skulk/stream 미로그인 접근 시 `sso.qufox.com/authorize`로 302, code+PKCE 교환 후 로그인 성립.
- [ ] qufox 로그인 상태에서 두 번째 사이트 진입 시 **비밀번호 재입력 없이** 로그인(SSO 성립).
- [ ] RP는 id_token을 **JWKS 오프라인 검증**(qufox HS256 시크릿 미공유) — 코드/설정에 공유 시크릿 부재.
- [ ] client_id별 `aud` 분리(skulk용 토큰을 stream에서 거부).
- [ ] redirect_uri는 **정확 일치 화이트리스트**(suffix 매칭 금지), code 1회성·60s TTL, state/nonce 검증.
- [ ] qufox `refresh_token` 쿠키 속성(host-only/SameSite=strict/HS256) **변경 없음**(diff로 확인).
- [ ] qufox 계정 비활성화 시 모든 RP 세션이 한 갱신 주기 내(또는 back-channel 즉시) 폐기.
- [ ] 각 사이트 break-glass 로컬 로그인이 플래그로 동작(IdP 장애 시 운영자 미잠김).
- [ ] 미래 사이트 온보딩 = OAuthClient 1행 + SDK 드롭인 + env 4개(코드 변경 0) 문서화.
- [ ] `pnpm verify` green(qufox), 각 RP 빌드/테스트 green, 3사이트 E2E SSO/로그아웃 스모크 통과.

## Non-goals

- 사용자 계정 병합·마이그레이션(불필요), `.qufox.com` 공유 쿠키, qufox-web RP 전환(추후), qufox-sso 분리(P5 보류).

## Risks (요약 — 상세는 워크플로 종합 참조)

- **certbot 인증서 축소**(타 사이트 TLS 파손) — 갱신 전 라이브 SAN 전수 복원.
- **stream off docker-net** — 백채널은 컨테이너 DNS 가정 금지, `https://sso.qufox.com` 경유.
- **RS256 키 유출/분실** = IdP 전체 침해 — 0600·OP에만 보관·overlapping kid 회전.
- **SameSite/리다이렉트 불일치**로 SSO 무음 파손 — IdP 세션은 별도 Lax 쿠키, strict 쿠키 불변, 크로스브라우저 E2E.
- **open-redirect / code replay** — 정확 일치 redirect_uri + PKCE S256 + 1회성 code.
- **로그아웃 지연**(local-verify) — RP 세션 단명 + `revoked:sub` + back-channel.
- **stream 4워커 PM2** — state/nonce는 stateless 서명 쿠키.
- **out-of-repo stream nginx** — 변경 스냅샷·스모크 후 컷오버.
- **단일 NAS SPOF** — /healthz·/readyz 게이트 + auto-rollback + break-glass 유지.
- **kernel 4.4 OOM** — standalone VERIFY green 후 `--no-verify` push, 동시 무거운 컨테이너 금지.
- **시크릿 위생** — `APP_ENCRYPTION_KEY` 부재, CORS가 env_file+inline 두 곳(inline 우선) — RP origin은 OIDC 라우트로만 한정.

## DoD

각 페이즈: AC 체크리스트 green + 해당 레포 `pnpm verify`(또는 빌드/테스트) 통과 로그 첨부 +
3사이트 E2E SSO·단일 로그아웃·비활성화 전파 스모크 통과. reviewer 적대적 재독(특히 P1 IdP, P3 stream) 후 컷오버.

## 진행 로그

### 2026-06-24 — P0 (인프라/인증서) 부분 완료
- **certbot "함정" 재조사 결과: 허위 경보.** 정본은 `/volume2/dockers/nginx/new.sh`의 `-d` 목록이며 라이브 SAN과 정확히 일치(12개). 내가 플래그했던 `docker-compose.certbot.yml`(9개)은 nginx/CLAUDE.md에 "현재 미사용, new.sh가 정식"으로 명시된 미사용 파일이라 실제 워크플로와 무관. `renew.sh`는 `renew --cert-name talsu.net`이라 SAN 보존.
- **sso.qufox.com 인증서 추가 발급 완료.** `new.sh -d`에 `sso.qufox.com` 추가 후 `sudo bash new.sh` 실행 → SAN 13개로 재발급(만료 2026-09-21). HTTP-01 webroot challenge는 :80 기본(localhost) 서버가 미등록 Host도 서빙함을 pre-flight로 확인.
- **nginx 변경(무중단).** ① 80 redirect `server_name`에 sso.qufox.com 추가 ② sso.qufox.com 443 server 블록 추가(현재 **503 placeholder** — IdP 미구축, 백엔드 미노출; P1에서 qufox-api OIDC 라우팅으로 교체). 단일파일 마운트라 `--force-recreate proxy`로 적용. 백업: `nginx.conf.bak.20260623T145700Z`.
- **검증.** sso.qufox.com → HTTP 503 + 유효 인증서(SNI 매칭); qufox.com/skulk/stream/design 모두 HTTP 200 + 정상 인증서(회귀 없음).
- **문서 동기화.** nginx `CLAUDE.md`(도메인 13개·§6 목록), `docs/CERT-RUNBOOK.md`(SAN 13개·llmapi 누락 보정), `docs/ROUTING.md`(sso 행 추가·skulk 행 현행화·폐기된 /hooks/github 행 제거), 미사용 `docker-compose.certbot.yml` -d 목록을 new.sh와 동기화(footgun 제거).

### 2026-06-24 — P0 (시크릿) 완료 (운영자 승인 B)
`.env.prod`(env_file, 0600)에 다음 추가. **env_file 멀티라인 불가 → PEM은 base64 1줄**로 저장(qufox-api가 `env_file: [.env.prod]`로 적재; VAPID 키와 동일 패턴). **값은 다음 `sudo deploy.sh` 때 반영**(지금은 런타임 영향 없음).
- `APP_ENCRYPTION_KEY` = base64(32바이트) — AES-256-GCM, 2FA TOTP secret-at-rest(`crypto.service.ts`). 그동안 부재로 2FA가 503이었음 → 다음 배포부터 2FA 활성. (`.env.example`엔 이미 dev placeholder 존재.)
- `SSO_ISSUER=https://sso.qufox.com`
- `SSO_JWT_ALG=RS256`
- `SSO_JWT_KID=sso-XXXX` (JWKS kid; 회전 시 overlapping kid)
- `SSO_JWT_PRIVATE_KEY_B64` = base64(PKCS#8 PEM, RSA 2048) — **공개키는 P1에서 런타임 파생**(`crypto.createPublicKey`)해 JWKS로 노출. 개인키는 OP에만, RP에 절대 복사 금지.

검증: APP_ENCRYPTION_KEY 32바이트 디코드 OK, SSO 개인키 유효 PEM·RSA 2048 파싱 OK, 권한 0600 유지(시크릿 값 미출력).

**P1 소비 계약**: 위 env 키 이름을 P1 OIDC 모듈이 그대로 읽는다. P1 진입 시 `.env.example`에도 `SSO_*` 키를 placeholder로 추가(dev bootstrap 누락검증 대비 — 코드가 소비하기 전까진 미추가).

> ✅ **P0 전체 완료.** 다음 단계 = P1(qufox-api에 OIDC 표면 다크 구축).

### 2026-06-24 — P1a (OIDC 표면 다크 구축) 완료 · 로컬 검증 그린
qufox-api에 panva `oidc-provider`(ESM) 기반 OIDC Provider 표면을 추가. **SSO_ISSUER 미설정
시 완전 비활성**이라 dev/test 무영향(다크). 아직 **prod 미배포·nginx는 503 placeholder 유지**
— 실제 라이브는 배포 + nginx 플립(아래 잔여) 후.

추가/변경:
- deps: `oidc-provider@^9.8.5`, `jose@^6.2.3` (apps/api).
- Prisma: `OAuthClient` 모델 + reversible 마이그레이션 `20260637000000_task078_oauth_client`(up/down) + `prisma generate`. RP 레지스트리(부팅 시 enabled=true 로드). client_secret 은 AES-256-GCM 암호화(clientSecretEnc) — oidc-provider 가 client_secret_basic 검증에 평문이 필요하므로 hash 아님. redirectUris/metadata 는 JSONB.
- `src/oidc/`: `esm.ts`(ESM 로더), `redis-adapter.ts`(휘발성 자산 Redis 어댑터·prefix `qufox:oidc:`), `oidc-config.ts`(JWKS via jose·config·findAccount·clients), `oidc-provider.service.ts`(onModuleInit 동적 import·provider·callback), `oidc.module.ts`, `oidc-config.spec.ts`.
- `app.module.ts`: `OidcModule` 등록. `main.ts`: sso host(=`new URL(SSO_ISSUER).host`) 요청을 **helmet/cookieParser/cors/Nest-router 앞** raw Express 미들웨어로 `provider.callback()`에 라우팅(콜백은 listen 후 지연 주입). `.env.example`: SSO 섹션.
- config: TTL(Access/Id 15m·Refresh/Session/Grant 7d·Code 60s), features(revocation/introspection/userinfo/rpInitiatedLogout/backchannelLogout, devInteractions off), PKCE 필수, claims(openid/email/profile), IdP 세션 쿠키 `sso_session`(SameSite=Lax) — qufox `refresh_token`(strict) 불변.

★ **ESM/CJS 함정(실측으로 발견·해결)**: `oidc-provider@9`/`jose@6` 은 ESM 전용. recon 은 "SWC 가 import() 보존"이라 했으나 **dist 실검사 결과 SWC(commonjs)가 `import(spec)`→`require()` 로 변환**(런타임 ERR_REQUIRE_ESM). 테스트는 vitest(swc `module:es6`)라 통과해 false-positive. 해결: `.swcrc` 에 `module.ignoreDynamic: true`(이 앱 유일 런타임 동적 import 가 esm.ts 뿐이라 전역 영향 0). 검증: 빌드 dist 가 `import(specifier)` 보존 + **빌드된 CJS 에서 ESM 로드 런타임 스모크 OK** + vitest 4/4.

검증 로그: 전체 swc build 385파일 OK · 전체 unit `Test Files 130 / Tests 1413 passed` · `tsc --noEmit` exit 0 · eslint 0 errors(기존 패턴 경고만) · 런타임 스모크 OK. (커널4.4 OOM 회피로 combined turbo 대신 api standalone 검증.)

### 2026-06-24 — P1b (interaction 브리지) 완료 · 로컬 검증 그린
- `AuthService.verifyCredentials()` 추출: login()에서 자격검증 코어(rate-limit·lockout·argon2·deactivation·updateLoginSuccess)만 분리. login()은 이를 호출 후 토큰 발급(동작 불변·기존 테스트 통과). OIDC IdP 로그인은 verifyCredentials만 호출 → **phantom refresh 세션 미생성**(활성 세션 목록 오염 방지)하면서 qufox 보호 전부 재사용.
- `src/oidc/oidc-interaction.ts`: express Router 로 `/interaction/:uid`(GET=로그인 폼 or consent 자동 grant), `/interaction/:uid/login`(POST=verifyCredentials→`interactionFinished({login:{accountId}})`, 실패 시 폼 재표시). `buildSsoApp(provider, authService)` = interaction 라우터 + `provider.callback()` 합성 express 앱(trust proxy 설정). 로그인 폼은 자체 렌더(최소 HTML, 정중한 한국어, XSS escape). CSRF는 oidc-provider interaction 쿠키로 보호. first-party 신뢰 클라이언트라 동의 자동 grant.
- `OidcProviderService`: AuthService 주입, onModuleInit에서 `buildSsoApp` 합성 → `getSsoHandler()`. `main.ts`: vhost가 `getSsoHandler()` 사용.
- deps: `express@4.21.2`(직접 의존성 — pnpm strict 격리 대응, NestJS와 동일 사본).
- 테스트: `oidc-interaction.spec.ts`(stub provider/authService로 브리지 배선 4종: 폼 렌더·유효자격→finished(login)·무효자격→폼재표시·consent 자동 grant).
- 검증: build 387 · **unit 131파일/1417 pass**(+4) · tsc 0 · eslint 0err.

### 잔여 P1 (배포 — 운영자 승인 위임)
- **배포** `sudo deploy.sh`(migrate deploy로 OAuthClient 테이블 생성 + OIDC 코드 라이브 + APP_ENCRYPTION_KEY로 2FA 활성). /readyz 게이트 + auto-rollback.
- **nginx 플립**: sso.qufox.com 503 placeholder → `qufox-api:3001` 라우팅.
- **라이브 E2E 검증**: `/.well-known/openid-configuration`·`/jwks` 응답 + (P2 클라이언트 등록 후) authorize→login→code 왕복.
- `.env.prod.example` APP_ENCRYPTION_KEY/SSO_* 섹션(가드로 미수정 — 후속).
- (그 후 P2: skulk OAuthClient 등록 + RP 전환 → P3 stream → P4 중앙 로그아웃/SDK.)
