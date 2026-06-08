# 063 · FR-RM10 — AutoMod 키워드 모더레이션

> UNDERSTAND wf_05cb1e53 후 ADR. 별백로그(handoff)·PRD(prd/index.html AutoMod 섹션). @role 그룹 종료 후 진입.

## Context (PRD 요지)
PRD FR-RM10: 3 trigger(KEYWORD/MENTION_SPAM/REPEAT_SPAM) × 3 action(BLOCK_MESSAGE/SEND_ALERT/AUTO_TIMEOUT)
+ exemptRoles/exemptChannels + 정규식 "re2 또는 100ms timeout" + Worker/BullMQ 실행 + AUTOMOD_BLOCK/TIMEOUT 감사.

## 기존 인프라(재사용)
- `common/audit/audit.service.ts` — append-only·`AuditAction` **const object(마이그레이션 없이 확장)** → AUTOMOD_* 추가.
- `workspaces/moderation/moderation.service.ts` — kick/ban/**timeout**(AUTO_TIMEOUT 재사용)·AuditService 연동.
- `workspaces/roles/roles.controller.ts` — 워크스페이스 하위 리소스 CRUD 패턴(@Roles('ADMIN')·rate-limit·Zod).
- `messages/messages.service.ts send()` — 본문 확정(contentPlain) 후·tx 전 hook 지점. 편집(PATCH) 동일.
- BullMQ(`queue/*`·[[project_bullmq_greenlight]]) — AUTO_TIMEOUT/ALERT async 필요 시.
- 권한: 신규 비트 불요 — ADMIN enum 게이트(roles 패턴).

## ★ 스코프 결정 (ADR · 2026-06-08 · 자율)

### E1 — FR-RM10a = **KEYWORD 리터럴 매칭만** (정규식·spam trigger 후속)
- **근거(★중요)**: JS 정규식은 동기 실행 → catastrophic backtracking 을 in-process timeout 으로 중단 불가
  (이벤트루프 블록). 진짜 ReDoS 안전은 Worker Thread(메시지당 spawn 비용 큼) 또는 re2(네이티브·kernel4.4 금지)
  뿐. **FR-RM10 은 "키워드" 모더레이션** → **리터럴 키워드/구문 매칭(정규식 아님)으로 스코프하면 정규식 엔진이
  hot-path 에 없어 ReDoS 자체가 소멸**. Worker/re2/REGEX_UNSAFE 불요·가장 안전·named-priority 일치.
- **FR-RM10a(이 슬라이스)**: trigger=KEYWORD(리터럴), action=BLOCK/ALERT/TIMEOUT, exemptRoles/Channels, CRUD, 감사.
- **FR-RM10b(후속)**: 정규식 패턴(Worker Thread 격리·100ms 검증·10ms 매칭), MENTION_SPAM/REPEAT_SPAM(행동형 spam·
  sliding-window 카운터). 별 슬라이스.

### E2 — AutoModRule 모델 (migration `20260629000000`)
`model AutoModRule { id(uuid)·workspaceId(uuid)·name(VarChar)·triggerType(enum AutoModTrigger{KEYWORD; MENTION_SPAM·
REPEAT_SPAM 예약})·keywords(String[] @db 또는 Json·리터럴 구문·소문자 정규화·≤50개·각 ≤256자)·matchMode(enum
AutoModMatch{SUBSTRING|WORD})·action(enum AutoModAction{BLOCK|ALERT|TIMEOUT})·timeoutSeconds(Int?·TIMEOUT 용)·
exemptRoleIds(Uuid[])·exemptChannelIds(Uuid[])·enabled(Boolean @default true)·createdBy(uuid)·createdAt·updatedAt }`.
`@@index([workspaceId, enabled])`·FK workspace CASCADE. reversible.

### E3 — 매칭 서비스 + send hook
- `AutoModService`: 워크스페이스 enabled KEYWORD 룰 로드(**캐시** — Redis `automod:rules:{wsId}` TTL 또는 in-memory
  LRU·**CRUD 시 무효화**). `check({workspaceId, channelId, authorId, actorRoleIds, contentPlain})` →
  각 룰: exemptChannel/exemptRole skip → **리터럴 매칭**(contentPlain 소문자 vs keywords·SUBSTRING=includes·WORD=경계).
  bounded(키워드수×길이·둘 다 cap). 첫 매칭 action 반환.
- **messages.service.send()** tx 전(contentPlain 확정 후): check 결과 →
  - **BLOCK** → `throw DomainError(ErrorCode.AUTOMOD_BLOCKED, 422)`(메시지 미저장) + 감사 AUTOMOD_BLOCK.
  - **ALERT** → 메시지 저장 + 감사 AUTOMOD_ALERT(+ 선택 모드 알림 outbox·best-effort).
  - **TIMEOUT** → 메시지 BLOCK(미저장) + tx 후 `ModerationService.timeout(author, timeoutSeconds, reason='AutoMod: {rule}')`
    enqueue/호출 + 감사 AUTOMOD_TIMEOUT. (메시지도 막을지/저장할지 PRD 확인 — 기본 BLOCK+timeout.)
  - 편집(PATCH) 경로도 동일 check(우회 방지).
- self/시스템(BOT?) 예외·DM(workspaceId=null) skip.

### E4 — 감사/액션 재사용
`AuditAction` 에 `AUTOMOD_BLOCK`·`AUTOMOD_TIMEOUT`·`AUTOMOD_ALERT`·`AUTOMOD_RULE_CREATE/UPDATE/DELETE` 추가.
details 에 ruleId·matched keyword·action. ModerationService.timeout 재사용.

### E5 — CRUD + 웹 UI
- `apps/api/src/workspaces/automod/` 신규 모듈: `automod.controller.ts`(`/workspaces/:id/automod-rules`·GET 목록(ADMIN)·
  POST/PATCH/DELETE ADMIN·rate-limit `automod:mutate:ws:{wsId}`)·`automod.service.ts`(CRUD + check + 캐시).
- shared-types `moderation.ts`(또는 신규 automod.ts): AutoModRuleSchema·Create/Update/List Zod(keywords ≤50·≤256·
  action/trigger enum·exempt UUID[]).
- 에러코드: `AUTOMOD_BLOCKED`(422) shared-types + error-code.enum.
- 웹 ADMIN 관리 모달(RolesModal 패턴·DS 클래스): 룰 목록 + 생성/수정(키워드 칩·action·exempt·enabled).

### E6 — 제약/검증/배포
- **정규식 없음** → Worker/re2/REGEX_UNSAFE 불요. 캐시 CRUD 무효화. cap: ≤50 키워드/룰·≤256자·룰 수/ws cap·매칭 bounded.
- verify(node20 단독)+int(실DB·룰 CRUD·BLOCK 422·ALERT 저장+감사·TIMEOUT+timeout·exempt·편집 우회) + 7차원 리뷰 +
  수동배포(승인·migration 20260629). [[reference_container_verify_concurrency]].

### Acceptance (FR-RM10a)
FR-RM10=partial→(a 완료 시 done 또는 partial·b 잔여) · verify green + int + reviewer + 수동배포 LIVE(prod AutoModRule 테이블).
