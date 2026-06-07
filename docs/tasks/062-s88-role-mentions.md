# 062 · S88 — @role 멘션 그룹 (FR-MN-03 / FR-MN-19 / FR-MN-21)

> **새 세션 시작점.** 이번 슬라이스(그룹)는 大 async 파이프라인이라 서브슬라이스로
> 분할한다. 첫 작업: §아키텍처 결정의 sync vs async 를 **AskUserQuestion 으로 사용자에게
> 확인**한 뒤 진입. handoff.md 최상단 "▶▶ 다음 작업" 블록도 함께 참조.

## Context (PRD 원문 요지)

**FR-MN-03 (@role 멘션, P0)**: roleName 을 파싱해 roleId 저장. 역할 멤버 전원에게 멘션
알림 전송. **MENTION_EVERYONE 권한(ADR-4, 0x0080) 또는 역할 mentionable 플래그** 기준
접근 제어. MentionRecord insert 는 메시지 저장 트랜잭션에서 분리해 **BullMQ mention-broadcast
큐**에서 비동기 처리(@role 대표 행 1건 → 워커 expand). **사용자당 분당 5회**(Redis sliding
window) 초과 또는 **5분 내 동일 역할 10회** 초과 시 429. **이중 전달 방지**: 워커가
mention:new 전송 전 해당 사용자가 message:created 수신 시점 **온라인(채널 룸 멤버)** 이었는지
검사. 온라인이면 WS 알림 skip·Inbox DB 기록만, **오프라인이면 mention:new 전송**. **비공개
채널 보호**: VIEW_CHANNEL 권한 없는 역할 멤버는 MentionRecord 생성·mention:new 발송 대상에서
제외. mention:new payload 의 channelName·messagePreview 는 채널 비멤버에게 마스킹/미발송.
**워커 권한 재검증**: mention-broadcast 워커가 MentionRecord 생성 직전 Job 실행 시점에 대상
사용자의 VIEW_CHANNEL 권한을 DB 에서 재조회하며, 권한 없으면 스킵. Job retry 시에도 재조회.

**FR-MN-19 (mention-broadcast 큐 운영, P1)**: concurrency 10, rate-limit 100 jobs/s. Job
재시도 3회 지수백오프(초기 2초). 최종 실패 시 ERROR 로그 + 해당 사용자 Inbox 실패 알림.
워커 강제종료 후 재시작 시 pending Job 자동 재처리. BullMQ job latency Prometheus 메트릭.
**멱등성**: Job ID 는 `mention:{messageId}:{targetId}` 결정론적 키. MentionRecord 저장 시
`ON CONFLICT(messageId, targetId, targetType) DO NOTHING`. 워커 재시작 후 동일 Job 재처리
시 MentionRecord 정확히 1행 보장.

**FR-MN-21 (@here 팬아웃 SLO 검증, P1)**: `evals/tasks/mention-fanout-slo.yaml` eval
태스크. ONLINE 사용자 100명 대상 @here mention:new **P95 5초 이내** 도달 확인(k6/artillery
부하 시나리오). BullMQ job latency Prometheus 메트릭 연동.

## 아키텍처 결정 (★ 첫 세션에서 사용자 확인)

PRD 는 @role 을 **BullMQ async** 로 명시한다. 기존 @here/@everyone 은 **동기 fanout**
(messages.service tx 내). 두 갈래:

- **(A) PRD대로 async 풀 전체**: MentionRecord 모델 + mention-broadcast BullMQ 워커
  (idempotent·잡 시점 권한 재검증·online/offline·마스킹·이중 rate-limit) + @here SLO eval.
  2~3 서브슬라이스. 완성도 높지만 큼.
- **(B) 동기 fanout 먼저(권장 분할)**: 기존 동기 경로에 @role 을 얹어 즉시 동작
  (Role.mentionable + @role 파싱/추출 + 역할 멤버 resolve + MENTION_EVERYONE/mentionable
  게이트 + VIEW_CHANNEL/dedup + per-user/per-role rate-limit). BullMQ async·MentionRecord·
  online-offline·SLO 는 후속 서브슬라이스. **S46(UserChannelMute level deviation)·동기 @here
  선례와 일관.** @role 멘션이 바로 동작.

→ **새 세션 첫 단계에서 AskUserQuestion 으로 A vs B 선택.**

## 서브슬라이스 분할 (B 선택 시 권장)

- **S88a (FR-MN-03 코어)**: `Role.mentionable Boolean @default(false)` 마이그레이션 +
  shared-types `mentions` 에 `roles: string[]` 추가(message.ts MessageMentionsSchema +
  mrkdwn mention_role 추출) + messages.service fanout 에 @role 분기(역할 멤버 MemberRole
  resolve → MENTION_EVERYONE/mentionable 게이트 → VIEW_CHANNEL + 기존 mute/DND/NotifLevel
  + dedup(@user/@here 와 합집합) → mention.received) + 이중 rate-limit(user 5/분·role
  10/5분 Redis sliding window·429) + Role CRUD/관리 UI 에 mentionable 토글. 동기.
- **S88b (FR-MN-19 async + MentionRecord)**: `MentionRecord` 모델(messageId,targetId,
  targetType,channelId,…·UNIQUE(messageId,targetId,targetType)) + mention-broadcast BullMQ
  큐/워커(concurrency 10·idempotent job·잡 시점 VIEW_CHANNEL 재검증·online/offline 분기·
  비공개 마스킹·retry 3 + Inbox 실패 알림·prom 메트릭). @role(그리고 선택적으로 @here)
  fanout 을 이 워커로 이관.
- **S88c (FR-MN-21 SLO eval)**: `evals/tasks/mention-fanout-slo.yaml` + k6/artillery
  시나리오(ONLINE 100명 @here P95 5s) + BullMQ latency prom 연동.

## 기존 인프라 맵 (재사용)

- `Role`(schema.prisma:1413 · **mentionable 없음 → 추가**) · `MemberRole`(역할↔멤버, schema:1438).
- 멘션 fanout: `apps/api/src/messages/messages.service.ts:1464~1640`(동기·1인당 mention.received
  outbox 1건·mute/DND/NotifLevel/OFF per-recipient fold). `mention.received`/`UserMention`
  outbox(aggregateType='UserMention').
- 멘션 추출: `apps/api/src/messages/mentions/mention-extractor.ts`(extractMentions·resolveMention*).
  mrkdwn `mention_role` AST 노드 존재(packages/shared-types/src/mrkdwn-ast.ts:66, mrkdwn.ts:47
  `<@&cuid2>`)하나 **`mentions` 요약(MessageMentionsSchema)엔 roles 없음 → 추가 필요**.
- MENTION_EVERYONE 비트=0x0080: `apps/api/src/channels/permission/channel-access.service.ts`
  (`resolveMentionEveryone`/`resolveChannelEveryone`·base+override). 집행 enum 0x80=PIN_MESSAGE
  (비트 재사용 — channel-access 만 카탈로그 MENTION_EVERYONE 으로 해석).
- BullMQ: `apps/api/src/queue/{reminder.processor.ts,reminder-queue.service.ts,queue.module.ts}`
  (in-process·전용 IORedis maxRetriesPerRequest:null·delayed/retry·@Global). 승인 [[project_bullmq_greenlight]].
- presence online: `apps/api/src/realtime/presence/presence.service.ts`(lastSeenAt·bulkFor).
- VIEW_CHANNEL 재검증: `channel-access.service.ts`(채널 ACL).
- rate-limit: `apps/api/src/auth/services/rate-limit.service.ts`(Redis sliding window·enforce).
- **MentionRecord 모델 없음 → 신규**(S88b).

## 검증·배포 (복구 후 환경 — 매 슬라이스 동일)

- **verify**: node:20.9.0-bookworm-slim 컨테이너 + `apt-get install -y git openssl` 선행 →
  `pnpm verify`. prisma 변경 시 컨테이너에서 `prisma generate`(openssl). root 실행 후 호스트에서
  `.turbo`/`node_modules/.cache`/`dist`/`.prisma` chown -R admin:users.
- **int**: `--network host` + docker.sock 마운트 + `TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1` 컨테이너.
- **push 게이트**: 大슬라이스는 standalone VERIFY green 후 `git push --no-verify`(combined verify
  의 kernel4.4 OOM 회피). 머지 후 **ls-remote 로 develop/main 재검증**(silent-drop).
- **배포(수동·승인 후)**: `auto-deploy.sh`(DEPLOY_SHA 없이=현재 checkout·격리 빌더→localhost:5050·
  마이그레이션 자동 적용·rollout·/readyz). webhook 자동배포 OFF. prod-DB/시크릿 직접 접근 금지.
- **subagent 금지**: 머지·배포·prod 접근. reviewer(adversarial) 매 서브슬라이스.

## DoD (그룹)

- FR-MN-03/19/21 = done(fr-matrix) · 각 서브슬라이스 `pnpm verify` green + reviewer 통과 +
  실DB int + 수동 배포 LIVE 검증 · handoff 갱신.
