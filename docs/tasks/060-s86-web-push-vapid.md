# 060 · S86 — Web Push (VAPID) (FR-MN-15)

## Context

PRD FR-MN-15: PushSubscription 등록 후 알림 이벤트 시 web-push 로 전송. DND·뮤트 스킵.
데스크톱 세션 활성(lastSeen < 5분) 시 60초 지연. 권한 요청 UX: 페이지 첫 진입 즉시 요청
금지 — 설정 "알림" 탭 또는 Inbox 배너 버튼 클릭 시에만 requestPermission(). denied 시
안내 카피 + 도움말. userAgent 분기 없이 동일 카피.

기반: VAPID 키 3개 `.env.prod` 보관 완료(사용자). 멘션 fanout 은 `outbox-to-ws.subscriber.
onMentionEvent`(mention.received → user 룸 emit + 배지). NotifLevel/DND/mute 게이트 존재.
BullMQ 승인·도입됨(reminder/unfurl processor 선례·delayed job 지원). presence `bulkFor`/
lastSeenAt 로 online 판정. notifDesktop/notifMobile 컬럼 존재(전송 미구현 — 본 슬라이스가 채움).

## 아키텍처 결정

- **공개키 런타임 노출**(빌드 build-arg 배관 회피): `GET /push/vapid-public-key` 가 .env.prod
  의 VAPID_PUBLIC_KEY 를 내려준다(비밀 아님). 프론트가 구독 직전 fetch. → 프론트 env/build-arg
  불필요·키 교체 시 web 재빌드 불필요·단일 출처(.env.prod).
- **푸시 전송 = BullMQ 지연 잡**(reminder.processor 선례): 멘션 도착 시 push-send 잡을
  enqueue. 데스크톱 세션 활성(presence lastSeen < 5분)이면 **delay 60초** 후 실행, 비활성이면
  즉시. 잡 실행 시점에 (a) DND/mute/NotifLevel 재게이트 (b) 그 사이 사용자가 읽었으면 skip
  (c) 유효 구독 전부에 web-push 전송, 410/404 응답 구독은 정리(stale endpoint GC). retry 3회.
- **PushSubscription 모델**: (userId, endpoint unique) + p256dh/auth/ua?/createdAt/lastUsedAt.
  onDelete Cascade(user). 마이그레이션 `20260625000000`.
- web-push 전송은 `web-push` 라이브러리(서버). 키는 env 에서 1회 setVapidDetails.

## Scope

### IN

- **deps**: `web-push` 추가(apps/api). `.env.example` + `.env.prod`(이미 사용자 설정)에
  VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT 3키 — bootstrap 누락 검증에 선언.
- **Prisma**: `PushSubscription` 모델 + 마이그레이션(additive·reversible).
- **shared-types**: 구독 등록 요청(endpoint/keys{p256dh,auth}) + VAPID 공개키 응답 Zod.
- **API** `apps/api/src/me/push/**` 또는 `apps/api/src/push/**`:
  - `GET /push/vapid-public-key`(인증 불요 또는 JwtAuthGuard — 비밀 아님) → { publicKey }.
  - `POST /me/push/subscriptions`(JwtAuthGuard) — 구독 등록(upsert by endpoint).
  - `DELETE /me/push/subscriptions`(body endpoint) — 해제.
  - PushService: `sendToUser(userId, payload)` — 유효 구독 조회 → web-push 전송 → 410/404
    구독 GC. setVapidDetails(env). VAPID env 부재 시 no-op + 1회 warn(graceful — 키 없는 dev).
  - BullMQ `push-send` 큐/프로세서(reminder 선례): enqueue(userId, mentionPayload, delayMs) →
    실행 시 NotifLevel/DND/mute 재게이트 + read-check + sendToUser. queue.module 등록.
  - 멘션 훅: `outbox-to-ws.subscriber.onMentionEvent` 가 WS emit 후 push enqueue(presence
    online 이면 delay 60s·offline 이면 0). DND/mute 1차 게이트는 enqueue 전 또는 잡에서.
- **web**:
  - Service Worker `apps/web/public/sw.js`(또는 vite) — `push` 이벤트 → `showNotification`,
    `notificationclick` → 해당 채널/메시지로 focus/open(clients.matchAll + openWindow).
  - 구독 등록 헬퍼: navigator.serviceWorker.register + PushManager.subscribe(공개키 fetch) +
    POST. 권한 상태(default/granted/denied) 순수 판정 함수(테스트 가능).
  - 권한 요청 UX: **첫 진입 즉시 요청 금지**. 설정 "알림" 탭 또는 Inbox 상단 배너 "브라우저
    알림 허용하기" 버튼 클릭 시에만 requestPermission(). denied 시 안내 카피("브라우저 알림이
    차단되어 있습니다. 사이트 권한 설정에서 알림을 허용한 후 새로고침해 주세요.") + "알림 설정
    방법 보기" 링크. DS qf-\* + 토큰만(raw hex/px 금지).
- **tests**: shared-types Zod · API 단위(PushService 게이트·stale GC·VAPID no-op) + 통합
  (구독 등록/해제 왕복·실DB) · web 단위(권한 상태 판정·구독 등록 분기·배너 카피·denied 분기).
  web-push HTTP 전송은 vi.fn() mock. SW/실전송은 e2e/수동(OUT of unit gate).

### OUT (non-goals)

- 채널별 데스크톱/모바일 독립 설정(FR-MN-18 → S87).
- iOS Safari PWA 푸시 특수 처리(표준 Web Push 만 · userAgent 분기 없음 — PRD 일관).
- 이메일/SMS 알림. 푸시 페이로드 암호화 커스텀(web-push 라이브러리 기본 사용).

## Acceptance Criteria (기계 검증)

- `pnpm verify`(node20 컨테이너) GREEN.
- GET /push/vapid-public-key → .env 공개키 반환(통합).
- 구독 등록 upsert·해제 왕복(통합·실DB).
- PushService 게이트: DND/mute/OFF 면 미전송, 410/404 구독 GC(단위, web-push mock).
- 권한 UX: 첫 진입 자동 요청 안 함 · 버튼 클릭 시에만 requestPermission · denied 카피(단위).

## Non-goals / Risks

- **보안**: 구독 endpoint/keys 는 사용자 본인 것만(userId 스코프). 공개키만 노출(개인키 서버 전용).
- VAPID env 부재 dev/test 는 전송 no-op(graceful) — 키 없이도 앱 동작.
- 데스크톱 활성 시 60초 지연 + read-check 로 중복/불필요 푸시 억제(PRD).
- 마이그레이션 reversible(additive 테이블 · down DROP).

## DoD

- 체크리스트 green + `pnpm verify` + reviewer(adversarial) 통과.
- fr-matrix FR-MN-15 = done · 핸드오프 갱신. 수동 배포(승인 후 — VAPID env 이미 설정됨).
