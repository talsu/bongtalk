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
  - dedup(@user/@here 와 합집합) → mention.received) + 이중 rate-limit(user 5/분·role
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
- 멘션 추출: `apps/api/src/messages/mentions/mention-extractor.ts`(extractMentions·resolveMention\*).
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

---

## ▶ S88a 구현 결정 (ADR · 2026-06-07 · 사용자 B 선택 후 UNDERSTAND 확정)

> 사용자가 **B(동기 fanout 먼저)** 선택. 6개 subsystem 병렬 정독(workflow wf_1f66ad4d)
>
> - 결정적 파일 직독으로 아래를 확정. async/MentionRecord/online-offline/SLO 는 S88b/c.

### D1 — 추출 방식 = **handle (`@RoleName`) + 서버 권위 resolve** (NOT raw token)

- **근거**: composer 는 plain `<textarea>` 이고 user/channel 멘션을 **가독 handle**(`@alice`/`#general`)
  로 삽입한 뒤 **서버 `normalizeMentions` 가 `@{id}`/`<#id>` 토큰으로 정규화**한다(클라가 토큰을
  만들지 않음). 역할도 동일 패턴으로 일관성·가독성 유지. raw `<@&uuid>` 를 textarea 에 박는 건 UX 파손.
- **역할명 공백 문제**(RoleNameSchema=trim·1~64·문자제한 없음 → "Project Managers" 가능):
  자유 정규식 추출 불가 → **알려진 워크스페이스 역할명 longest-match** 로 해결. 서버가
  `role.findMany({where:{workspaceId}, select:{id,name,mentionable}})` 로 역할 목록을 로드(`@` 포함
  메시지에 한해·캐싱은 후속 perf)하고, 본문에서 `@<정확한 역할명>`(경계 anchored·case-insensitive·
  긴 이름 우선) 을 스캔해 roleId 수집 → `mentions.roles`.
- **정규화 순서**: 역할 패스(알려진 역할명 → `<@&roleId>` 토큰 치환) **먼저**, 그 다음 기존 user
  handle 패스(`@username`→`@{userId}`). 다단어 역할명을 user 패스가 갉아먹지 않게.
- **충돌(역할명 == username, 단일단어만 가능)**: **역할 우선**(exact known-name). 문서화. 워크스페이스
  관리자가 역할명을 통제하므로 수용. 예약어 `everyone`/`here`/`channel` 은 역할 매칭에서 제외.
- **신뢰 경계**: extractMentions 와 동일 — workspace-scoped, 미지의 역할명 silent drop.

### D2 — ID 포맷 = UUID, mrkdwn 토큰 정규식 TransitionalId 확장

- `Role.id`=`@db.Uuid`. `MENTION_ROLE_RE`(shared-types/mrkdwn.ts)을 **uuid|cuid2** 로 확장:
  `/<@&([0-9a-f-]{36}|[a-z0-9]{20,})>/g`(anchored·bounded·ReDoS-safe). FR-RC22 규칙 →
  **shared-types 버전 범프**.
- `MentionRoleNodeSchema` 에 `label: z.string().min(1).max(100).nullable().optional()` 추가
  (mention_user/channel 패턴). parser `mention_role` 분기에 label 주입
  (`MentionLabelResolvers.role?: (roleId)=>string|null`). `resolveMentionLabelMaps` 반환에
  `roles: Map<roleId, roleName>` 추가. renderAst 는 이미 `mention_role`(node.label ?? roleName
  resolver ?? roleId) 지원 → 런타임 roleName resolver 주입만.

### D3 — 접근제어 게이트 = 역할별 `mentionable===true OR actorHasMentionEveryone`

- 추출된 각 roleId 의 `mentionable`(추출 쿼리에서 함께 로드). `mentionable=true` 역할은 누구나 멘션 가능.
- `mentionable=false` 역할은 **actor 가 MENTION_EVERYONE 권한 보유 시에만**. `actorHasMentionEveryone`
  은 **non-mentionable 역할이 1개 이상 추출됐을 때만 lazy 계산**(`channelAccess.resolveMentionEveryone`
  재사용·controller 가 로드한 `m.role`+`memberRoleUuids` preload 전달). 흔한 경로(역할 없음/전부
  mentionable)는 override fold 회피. 게이트 탈락 역할은 `mentions.roles` 에서 제거(silent downgrade,
  gate.ts `gateRoleMention` 패턴).

### D4 — fanout = 역할 멤버 resolve → 비공개 VIEW_CHANNEL 필터 → 기존 수신자 union

- 역할 멤버 = `MemberRole.findMany({where:{workspaceId, roleId:{in:gatedRoleIds}}, select:{userId}})`.
- **공개 채널**: 역할 멤버(워크스페이스 멤버) 전원 후보. **비공개 채널**: VIEW_CHANNEL 가시성 필터
  (채널 ACL). bulk 프리미티브 부재 → 채널 override + memberRole 1회 로드 후 in-memory 계산(N+1 회피)
  또는 bounded per-member. **job-time 재검증(idempotent·retry)은 S88b**; S88a 는 send 시점 1회 필터.
- 후보를 기존 `[...mentions.users, ...broadRecipientIds]` 에 **union → Set dedup**(messages.service
  ~1483). 이후 동일 per-recipient 게이트(block/mute/DND/OFF/NotifLevel) 자동 적용.
- **NotifLevel 분류 = 'direct'**: 역할 멤버 userId 를 `directMentionSet` 에 추가 → "MENTIONS only"
  사용자도 역할 멘션 알림 수신(Discord parity·역할 멘션은 개인 멘션). @here/@everyone('broad') 와 구분.
  문서화(대규모 역할 멘션 시 noise — 역할별 mute 는 후속 FR).
- `mention.received` outbox(aggregateType='UserMention') 동일 경로 재사용 — unread mentionCount
  자동 증가. `MentionReceivedPayload` 에 `role?: boolean`(역할 멘션 유래 표시·UI 분기용) 추가.
- 저장 `Message.mentions` JSON + `MessageCreated/Updated` payload 에 `roles` 포함(스키마 자동).
- 편집(PATCH) 경로: 저장 mentions.roles 정합만 갱신, 신규 mention.received 스팸 금지(기존 편집 의미 유지).

### D5 — 이중 rate-limit (게이트 통과 roles 비어있지 않을 때, tx 전)

- `MessagesService` 에 `RateLimitService` 주입(AuthModule export·MessagesModule import 됨).
- `service.send` 에서 mentions 게이트 후·`$transaction`(~1316) **전**:
  `await this.rate.enforce([{key:`mention:user:${authorId}`, windowSec:60, max:5},
  ...gatedRoleIds.map(rid=>({key:`mention:role:${authorId}:${rid}`, windowSec:300, max:10}))])`.
  user 규칙 먼저(초과 시 count 부수효과 최소화). 초과 → `ErrorCode.RATE_LIMITED`(429·기존 재사용).
- per-user-per-role(`{authorId}:{roleId}`) — 한 사용자가 동일 역할 spam 방지(global-per-role 은 상호
  griefing 우려로 배제). 문서화.

### D6 — Role.mentionable 필드 + 관리 UI 토글

- 마이그레이션 **`20260627000000_s88a_role_mentionable`**: `ALTER TABLE "Role" ADD COLUMN
"mentionable" boolean NOT NULL DEFAULT false;`(reversible·down=DROP COLUMN). schema.prisma Role
  에 `mentionable Boolean @default(false)`(isSystem 다음).
- shared-types/roles.ts: `RoleSchema.mentionable: z.boolean()`(응답 필수) +
  `CreateRoleRequestSchema`/`UpdateRoleRequestSchema.mentionable: z.boolean().optional()`.
- roles.service.ts: `create`(`mentionable: body.mentionable ?? false`)·`update`(undefined 가드)·
  `toRoleDto`(`mentionable: row.mentionable`). **권한상승 검사 불요**(비권한 메타). **시스템 역할도
  변경 허용**(name/position/permissions 와 달리 mutable). 감사로그 details 에 mentionable 포함(선택).
- RolesModal.tsx RoleEditor: mentionable 상태 + 체크박스(권한 체크박스 패턴 재사용·`<label>` 래핑·
  accentColor var(--accent)). onSave payload 에 포함.

### D7 — MessageMentions 스키마

- message.ts `MessageMentionsSchema.roles: z.array(TransitionalIdSchema).default([])`(channel 다음·
  forward-compat). 빈 mentions 기본값(service ~443/1028) 에 `roles: []` 추가. events.ts
  MessageUpdated/Created 는 자동 상속.

### Acceptance Criteria (S88a · 기계 검증)

1. `pnpm verify` green(컨테이너 node:20.9.0) — shared-types test 포함.
2. 마이그레이션 적용 후 `Role.mentionable` 컬럼 존재(default false).
3. 실DB int (messages 멘션): `@<mentionable role>` → 역할 멤버 전원 mention.received(공개) ·
   비공개 채널 비가시 역할멤버 제외 · `mentionable=false` 역할은 MENTION_EVERYONE 권한자만 ·
   user 5/분·role 10/5분 초과 429 · @user ∪ @role dedup(중복 1건) · 'MENTIONS' notif level 에서
   역할 멘션 수신(direct).
4. Role CRUD int: mentionable create/update/응답 노출 · 시스템 역할 mentionable 토글 가능.
5. shared-types: MENTION_ROLE_RE uuid 매칭 · MessageMentionsSchema.roles forward-compat(roles 키
   없는 legacy JSON → []) · MentionRoleNode label.
6. reviewer(adversarial)+contract-validator+security+perf+a11y/ui 통과(BLOCKER/HIGH fix-forward).
7. 수동 배포 후 `/readyz=200` + prod `Role.mentionable` 컬럼 검증.

---

## ▶ S88a 리뷰 결과 (2026-06-08 · 7차원 병렬 adversarial 리뷰 wf_9645bd82)

구현 `527218e` → 7차원(correctness/contract/security/perf/ui/a11y/visual·18 에이전트) 리뷰 →
adversarial 재검증 → **fix-forward `4ac027f`**. visual=approve. 41 findings 중 confirmed
BLOCKER 2/HIGH 9 + MEDIUM 다수.

### fix-forward 적용(`4ac027f`)
- **F1(BLOCKER)** MentionRoleNodeSchema.roleId cuid2→`uuid|cuid2`(D2 정합·AST 검증 도입 시 역할 멘션 전면거부 방지).
- **F2(BLOCKER)** MentionNewPayloadSchema `role?` 누락→추가 + web dispatcher inline 타입/캐시 전파 + MentionSummary `role?`.
- **F3(HIGH·데이터무결성)** extractRoleMentions longest-match **미소비** 버그(짧은 prefix 역할 과다 fanout) → 신규 `role-mention-scanner.ts` 소비기반 단일패스를 추출/정규화가 **공유**(저장 토큰 ↔ mentions.roles 정합 보장).
- **F4(HIGH·DoS)** 메시지당 역할 멘션 수 `MAX_ROLE_MENTIONS_PER_MSG=10` 초과 422.
- **F5(HIGH·sec)** MENTION_ROLE_RE uuid 브랜치 RFC-4122 8-4-4-4-12 고정(garbage `<@&----…>` 거부).
- **F6(perf)** send/edit 멘션 추출 3직렬 RTT→`Promise.all`.
- **F7(HIGH·a11y/ui)** autocomplete `TRIGGER_KIND_LABEL.mention` '멤버'→'멤버 및 역할'(listbox aria-label·헤더·SR 공지 단일출처 3건 동시해소).
- **F8(a11y)** mentionable 체크박스 title-only 설명 → sr-only + aria-describedby.
- **F9(perf/correctness)** filterPrivateChannelVisibleUsers 가 tx 미사용(다른 스냅샷) → 선택적 tx 주입.
- **F11(test)** per-role rate-limit 규칙형태 단위검증(enforce 스파이·키/window/max).
- **F13(ui)** colorHex=null 역할 자동완성 meta-slot 정렬(placeholder dot).
- **F12 스킵(정당)**: RolesModal bg-muted 는 S61 `4fe67aa` 유래(S88a 무관) — scope 밖.

### 의도적 defer(문서화 — 후속/S88b)
- **dispatcher isMention @role 낙관배지 누락**: 역할-only 멘션 뷰어의 라이브 배지 +1 안 됨(@here/@channel 과 비대칭). 서버 mention.received→read_state 가 권위적으로 자가치유(깜빡임만). 뷰어 보유 roleId 집합 클라 plumbing 필요 → 후속.
- **다단어 역할명 수동 공백 입력 트리거**: `@Project ` 공백이 자동완성 트리거 종료. 단 **부분입력(@Pro)→리스트 선택(Enter)** 으로 다단어 역할 선택은 정상 동작(tokenForRow 가 `@전체이름` 삽입). 수동 전체타이핑만 불가 → isQueryChar 공백허용은 멤버 멘션 회귀위험으로 defer.
- **편집(PATCH) @role 재알림 비대칭**: 편집으로 @everyone 추가→재알림 O, @role 추가→X(ADR D4 의도·스팸방지). S88b async 이관 시 통일 검토.
- **총 수신자 fanout cap / rate-limit Redis 파이프라인**: 단일 大역할 동기 fanout(=기존 @everyone 과 동일 bounded·워크스페이스 크기)·enforce N직렬 RTT → **S88b BullMQ async 워커가 정위치**. 역할 **개수** cap(F4)만 동기 적용.
- **ungrounded `<@&id>` 토큰 strip**: 클라가 raw 역할 토큰 주입 시 fanout 은 없으나(gatedRoleIds 기반) 역할 pill 렌더 가능(social-eng 경미). **기존 user `@{id}` 토큰과 동일 선례**(미수정)·봇 raw-token 회귀위험 → user+role 통합 token-grounding 하드닝 후속.

### 게이트(메인루프 단독 재실행)
- 자체검증(fix-forward): shared-types 534 · api unit 169(타깃) · web 24+51(타깃) · typecheck 0 · eslint 0 error.
- 컨테이너 전체 `pnpm verify`(node20·단독) + prisma generate + int 2종 + 마이그레이션 = 메인루프.
