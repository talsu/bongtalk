# 056 · S84a — 인커밍 웹훅 / 봇 메시지 (FR-RC11)

> D16-richcontent 슬라이스 S84(FR-RC11/12/19)를 UNDERSTAND 권고대로 3분할:
> **S84a = FR-RC11(웹훅/봇 코어)**, S84b = FR-RC12(rich embed 배열), S84c = FR-RC19(링크
> 미리보기 전역 비활성화). 본 문서는 S84a.

## Context

PRD FR-RC11: 인커밍 웹훅으로 채널에 메시지를 게시하면 `authorType=BOT`으로 저장되고,
요청마다 `username`/`avatar_url`을 override할 수 있다. 토큰은 생성 시 평문 1회 반환,
DB에는 `sha256(rawToken)` hex 저장(bcrypt 아님), 검증은 `timingSafeEqual`. rotate 지원,
폐기 토큰 POST는 403. 렌더 시 'BOT' 배지(.qf-badge--accent).

기반: `AuthorType.BOT` enum 이미 존재(schema.prisma:37), `MANAGE_WEBHOOKS` 권한 비트
이미 존재(permissions.ts:27, 0x0200 "웹훅 CRUD"). 메시지 생성/실시간 전파/렌더 파이프라인
완성됨(D01). workspaces 하위 리소스 모듈 패턴(roles/invites/moderation) 확립됨.

## Scope

### IN

- **Prisma**: `IncomingWebhook` 모델(id, workspaceId, channelId, name, botDisplayName?,
  avatarUrl?, tokenHash[sha256 hex, unique], createdBy, createdAt, revokedAt?, lastUsedAt?).
  reversible 마이그레이션(up CREATE + 인덱스 + FK CASCADE / down DROP, NO CONCURRENTLY).
- **shared-types**: webhook CRUD 요청/응답 Zod 스키마 + 인커밍 게시 payload 스키마
  (content, username?, avatar_url?) + 예약어(system/qufox/admin, 대소문자무시) 검증 헬퍼.
  embeds는 S84b에서 추가(본 슬라이스는 content/username/avatar만).
- **API** `apps/api/src/workspaces/webhooks/**`:
  - `POST /workspaces/:id/webhooks` (MANAGE_WEBHOOKS) — 웹훅 생성, **rawToken 평문 1회 반환**.
  - `GET /workspaces/:id/webhooks` (MANAGE_WEBHOOKS) — 목록(토큰 평문/해시 비노출).
  - `DELETE /workspaces/:id/webhooks/:webhookId` (MANAGE_WEBHOOKS) — revoke(revokedAt 세팅).
  - `POST /workspaces/:id/webhooks/:webhookId/rotate` (MANAGE_WEBHOOKS) — 새 rawToken + sha256
    저장 + 새 평문 1회 반환(기존 토큰 무효).
  - `POST /webhooks/:webhookId` (인증=토큰, 게이트 없음) — token 검증(timingSafeEqual) →
    BOT 메시지 생성(username/avatar override, 예약어 위반 422, 폐기 토큰 403) → 실시간 전파.
  - 토큰 crypto 유틸(`sha256hex`, `timingSafeEqualHex`), rate-limit(채널/웹훅 단위).
  - 토큰 노출 감지 시 보안 알림 = **콘솔 stub**(SMTP 실발송은 인프라 준비 후 별도 — 사용자 지시).
- **web**: 메시지 렌더에 BOT 배지(.qf-badge--accent) + webhook override username/avatar 표시.
  (웹훅 관리 UI는 S84b/후속 — 본 슬라이스는 배지 렌더 최소.)
- **tests**: shared-types Zod 단위, API 토큰 해시/검증/rotate/예약어/403 단위+통합(실DB),
  web 배지 렌더 단위.

### OUT (non-goals)

- rich embed 배열(FR-RC12 → S84b), 링크프리뷰 토글(FR-RC19 → S84c).
- 웹훅 관리 풀 UI(생성/목록/rotate 화면) — 후속.
- SMTP 실발송(콘솔 stub 유지).
- 커스텀 이모지(FR-RC20), embed 이미지 프록시(FR-RC21·S60에 일부 존재).

## Acceptance Criteria (기계 검증)

- `pnpm verify`(node 20.9 컨테이너) GREEN — lint 0 error · typecheck · 단위/통합 테스트.
- 토큰: 생성/ rotate 응답에 평문 1회, DB엔 sha256 hex만(평문/ bcrypt 부재) — 통합 테스트로 단언.
- 검증: 올바른 토큰 → BOT 메시지 생성·`authorType=BOT`; 폐기/회전된 토큰 → 403; 잘못된 토큰 → 401/403.
- 예약어 username/botDisplayName(system/qufox/admin, 대소문자무시) → 422.
- 권한: 관리 엔드포인트는 MANAGE_WEBHOOKS 없으면 403.
- BOT 메시지 렌더에 'BOT' 배지 노출(web 단위 테스트).

## Non-goals / Risks

- **보안 민감**(토큰): timingSafeEqual 동일 길이 비교(hex 64) 보장, 평문 미저장·미로그.
- 마이그레이션 reversible 필수(down.sql), NO CONCURRENTLY(트랜잭션 안전).
- 인커밍 POST는 인증 게이트(WorkspaceMemberGuard) 적용 안 함(토큰 자체가 인증) — 별도 라우트로 분리해 멤버 가드와 충돌 방지.
- rate-limit으로 토큰 무차별 대입·폭주 방지.

## DoD

- 체크리스트 green + `pnpm verify` 통과 로그 첨부 + reviewer(adversarial) 통과.
- fr-matrix FR-RC11 = done, 핸드오프/슬라이스 추적 갱신.
- 수동 배포(webhook 자동배포 OFF) — build-and-push + rollout, /readyz 확인.

---

## RESUME STATE (2026-06-07) — 다음 세션 이어받기

> S84a 는 **기초까지 완료·검증**, 남은 백엔드/렌더/테스트는 미착수. 아래 그대로 이어가면 됨.
> 검증은 전부 **node:20.9.0-bookworm-slim 컨테이너**(호스트 node 22)로 수행 — 명령은 §검증 참고.

### ✅ 완료 + 검증됨

- **PLAN**: 본 문서.
- **Prisma 스키마**(`apps/api/prisma/schema.prisma`): `IncomingWebhook` 모델 신규 + `Message`
  additive 컬럼 `webhookId`/`botUsername`/`botAvatarUrl` + 관계(Message.webhook SetNull;
  역관계 User."IncomingWebhookCreator"/Workspace/Channel). `prisma validate` 통과.
- **마이그레이션** `apps/api/prisma/migrations/20260621000000_s84a_incoming_webhook/`
  (migration.sql + down.sql). throwaway PG16 에 **전체 체인 deploy 성공**(테이블+3컬럼 확인).
  ⚠️ 타임스탬프는 기존 최신(20260620)보다 뒤여야 함. ⚠️ down→up 재적용은 미검증(상대경로
  실수로 미실행) — s60 패턴 대칭 미러라 저위험, 새 세션에서 재확인 권장.
- **shared-types** `packages/shared-types/src/webhook.ts` (+ index.ts export, ErrorCodeSchema
  에 WEBHOOK_NOT_FOUND/REVOKED/INVALID_TOKEN/NAME_RESERVED 추가). spec 13 tests green.
- **API 토큰 crypto** `apps/api/src/workspaces/webhooks/webhook-token.util.ts`
  (`generateRawToken`/`hashToken`(sha256 64hex)/`safeTokenEquals`(timingSafeEqual)). spec 6 tests green.
- **ErrorCode(API)** `apps/api/src/common/errors/error-code.enum.ts`: 동일 4코드 +
  HTTP 매핑(NOT_FOUND→404, REVOKED→403, INVALID_TOKEN→403, NAME_RESERVED→422).

### ⬜ 남은 작업 (순서)

1. **`webhooks.service.ts`** (`apps/api/src/workspaces/webhooks/`):
   - 관리: `create`(channelId 가 workspace 소속인지 검증, name/botDisplayName 예약어→
     `DomainError(WEBHOOK_NAME_RESERVED)`, `generateRawToken`→`hashToken` 저장, 평문 1회 반환),
     `list`(요약, 토큰/해시 비노출), `rotate`(새 raw+hash, rotatedAt 갱신, 평문 1회),
     `revoke`(revokedAt 세팅 — 행 보존).
   - 인커밍: `verifyAndPost(webhookId, rawToken, payload)` — 웹훅 조회→`safeTokenEquals`
     불일치/`revokedAt!=null`→`WEBHOOK_REVOKED`/`INVALID_TOKEN`(403), username 예약어→422,
     `MessagesService.createBotMessage(...)` 호출, `lastUsedAt` 갱신.
   - rate-limit: `RateLimitService.enforce`(roles.controller 패턴 — 채널/웹훅 키).
2. **`MessagesService.createBotMessage`** (`apps/api/src/messages/messages.service.ts`):
   `createSystemMessage`(2058~) 를 템플릿으로. authorType='BOT', type='DEFAULT', authorId=
   webhook.createdBy, content=processMrkdwn(payload.content), webhookId/botUsername/botAvatarUrl
   세팅, `outbox.record(MESSAGE_CREATED, payload)` 로 브로드캐스트. ⚠️ 내부 outbox payload 와
   **WS 브로드캐스트 스키마(`events.ts` MessageCreatedPayloadSchema: message.{authorName,
   authorAvatarUrl,...})는 다른 레이어** — 디스패처가 authorName/Avatar 를 채움. BOT override
   가 WS 의 authorName/authorAvatarUrl 로 흐르도록 디스패처 경로 확인 필요.
3. **DTO/payload 에 bot 필드**: `MessageDto`(messages.service.ts:179) + WS payload + read-path
   에 `authorType`/`botUsername`/`botAvatarUrl` 추가(렌더가 BOT 판정·override 표시하도록).
   events.ts MessageCreatedPayloadSchema.message 에 authorType 추가(additive optional).
4. **모듈 와이어링**: `apps/api/src/workspaces/webhooks/webhooks.module.ts` (또는 workspaces.module
   에 컨트롤러/프로바이더 추가). WorkspacesModule 은 **이미 MessagesModule(MessagesService) import** 함.
   - `webhooks.controller.ts`: `@Controller('workspaces/:id/webhooks')`, `@UseGuards(
WorkspaceMemberGuard, WorkspaceRoleGuard)`, `@Roles('ADMIN')`(=MANAGE_WEBHOOKS 보유자;
     커스텀롤 워크스페이스 권한 집행은 S62 TODO — 주석 명시). create/list/rotate/revoke.
   - `incoming-webhook.controller.ts`: `@Controller('webhooks')`, **멤버 가드 없음**(토큰이 인증).
     `POST /:webhookId` body=IncomingWebhookPayloadSchema, 토큰은 `Authorization: Bearer` 또는
     `?token=`(생성 응답 postUrl 과 정합되게 택1·문서화).
5. **prisma client 재생성**: 새 필드/모델 사용 전 `pnpm --filter @qufox/api exec prisma generate`
   (컨테이너에서 OpenSSL 필요 — `apt-get install -y openssl` 선행).
6. **web** BOT 배지(`.qf-badge--accent`) — `apps/web/src/features/messages/MessageItem.tsx`
   에서 authorType==='BOT' 시 배지 + botUsername/botAvatarUrl override 표시.
7. **테스트**: webhooks.service 단위 + 통합(실DB testcontainers — 토큰 해시/검증/rotate/예약어
   422/폐기 403/BOT 메시지 authorType), web 배지 단위.
8. **VERIFY**: `pnpm verify`(node20 컨테이너) GREEN → reviewer(adversarial) → fr-matrix
   FR-RC11=done → 수동 배포(build-and-push + rollout, /readyz). **SMTP 보안알림은 콘솔 stub 유지**
   (사용자 지시 — 실발송 인프라 별도).

### ✅ 완료 기록 (2026-06-07 세션 — 잔여 전부 구현)

- **webhooks.service.ts**: create/list/rotate/revoke + verifyAndPost(토큰 검증·예약어·
  rate-limit·BOT 메시지). 토큰 평문 1회 반환, DB 엔 sha256 만. revoke=revokedAt 표식.
- **incoming-webhook.controller.ts**: `@Public POST /webhooks/:webhookId`(전역 JwtAuthGuard
  우회·토큰이 인증). Bearer 헤더 또는 `?token=` 택1. **webhooks.controller.ts**: 관리 REST
  (`@Roles('ADMIN')` 게이트 = MANAGE_WEBHOOKS 보유자, 커스텀롤 집행은 S62 TODO).
- **MessagesService.createBotMessage**: authorType=BOT·type=DEFAULT, webhookId/botUsername/
  botAvatarUrl 세팅, mrkdwn 파싱, outbox MESSAGE_CREATED(message subset 에 봇필드 실음).
- **DTO/WS 봇 필드**: shared-types MessageDtoSchema(authorType/botUsername/botAvatarUrl
  **optional** — 기존 리터럴 무회귀), events.ts payload(optional), api MessageRow/MessageDto/
  toDto + rawList·thread-replies raw SELECT 에 컬럼 추가.
- **모듈 와이어링**: WorkspacesModule 에 두 컨트롤러 + WebhooksService 등록(MessagesService
  forwardRef 이미 import).
- **prisma generate**: node20 컨테이너 + openssl 로 성공(client v5.22.0).
- **web**: MessageItem 에 isBot 분기 — 'BOT' 배지(.qf-badge--accent) + botUsername override
  표시 + BOT 은 ProfilePopover 미적용(웹훅 소유자 프로필 노출 회피). botAvatarUrl 이미지
  렌더는 DS Avatar 이미지 슬롯 도입 시 후속.
- **테스트**: `webhooks-s84a.int.spec.ts`(생성/토큰해시/INVALID/REVOKED/rotate/예약어422/
  비-ADMIN 403/BOT authorType), `MessageItem.bot.spec.tsx`(3 tests).
- **VERIFY**: `pnpm verify`(node20 컨테이너) GREEN — 19/19 tasks(web 1678 tests 포함).

### 검증 명령 (node 20.9 컨테이너)

⚠️ 컨테이너에 **git + openssl 둘 다 필요**: 일부 contract 테스트가 `git rev-parse
--show-toplevel`로 repo root 를 찾고(git 없으면 6건 FAIL), prisma migrate/generate 는
openssl 필요. slim 이미지엔 둘 다 없으니 선설치 + safe.directory 설정.

```
sudo docker run --rm -v /volume2/dockers/qufox:/repo -w /repo -e CI=1 \
  node:20.9.0-bookworm-slim bash -lc \
  "apt-get update -qq && apt-get install -y -qq git openssl && \
   git config --global --add safe.directory /repo && \
   corepack enable && corepack prepare pnpm@10.33.0 --activate && pnpm verify"
# root 컨테이너 실행 후 호스트에서: chown -R admin:users .turbo node_modules/.cache
#   apps/*/node_modules/.cache packages/*/dist (소유권 정리 — 안 하면 admin git/turbo 충돌).
```
