# Task 069 — FR-RM10b AutoMod 정규식 패턴 + MENTION_SPAM/REPEAT_SPAM (S96)

## Context

FR-RM10(P1, S89a partial): "AutoMod 룰: ADMIN 이상이 워크스페이스별 3종 룰(KEYWORD·MENTION_SPAM
·REPEAT_SPAM) 생성. 위반 시 BLOCK/ALERT/TIMEOUT. ReDoS 방지: KEYWORD 패턴은 저장 전 re2 또는
100ms timeout 검증, 실패 시 400(REGEX_UNSAFE). 매칭은 Worker Thread 또는 BullMQ 로 격리, 단일
패턴 최대 10ms. 초과 시 Worker 강제 종료 + AUTOMOD_TIMEOUT AuditLog. Worker 비정상 종료 시 메인
이벤트 루프 무영향."

**현재(FR-RM10a·S89a)**: KEYWORD **리터럴**(SUBSTRING/WORD)만. AutoModRule·AutoModService.check·
BLOCK/ALERT/TIMEOUT 집행·OWNER/ADMIN 면제·CRUD·캐시(10s)·exemptRoles/Channels 완비. triggerType
enum 에 MENTION_SPAM/REPEAT_SPAM 예약(미구현). **잔여(FR-RM10b)**: 정규식 KEYWORD 패턴 + 2 spam.

## Scope

### IN — 1) 정규식 KEYWORD 패턴 (worker_threads 격리)

1. **AutoModRule.matchMode 에 `REGEX` 추가**(enum AutoModMatch: SUBSTRING|WORD|REGEX). 마이그
   `20260634000000_frrm10b_automod_regex_spam`. keywords[] 를 REGEX 모드에선 정규식 패턴으로 해석.
2. **저장 시 ReDoS 검증**(CRUD create/update): 각 정규식을 **worker_threads 안에서 병리적 입력 +
   100ms 워치독**으로 컴파일·실행 테스트 → 초과/throw 시 `REGEX_UNSAFE`(400). re2 네이티브 의존
   회피([[reference_synology_env]] kernel4.4·handoff "re2 회피"). `new RegExp` 컴파일 실패도 REGEX_UNSAFE.
3. **매칭 실행 worker_threads 격리**(`automod-regex.worker.ts` + 풀/싱글 persistent worker):
   본문(contentPlain·MAX_CONTENT_SCAN_LEN cap)을 worker 로 보내 컴파일된 정규식 매칭. **단일 패턴
   ≤10ms 워치독** — 초과 시 `worker.terminate()` + 재spawn + `AUTOMOD_TIMEOUT` AuditLog(메인 루프
   무영향). worker 비정상 종료 시 best-effort(매칭 스킵·메시지 통과·send 영향 0). check() 가 이미
   async 라 worker await 자연 통합. SUBSTRING/WORD(리터럴)는 종전대로 메인스레드(격리 불요).

### IN — 2) MENTION_SPAM (행동형·Redis sliding window)

4. AutoModRule(MENTION_SPAM): `mentionThreshold Int`(윈도 내 누적 멘션 수) + `windowSeconds Int`.
   send 경로에서 메시지의 멘션 수(mentions.users+roles+everyone/here/channel 카운트)를 작성자별
   Redis ZSET sliding window([[reference]] upload-rate-limit 패턴)에 누적 → 윈도 합이 threshold 초과
   시 액션(BLOCK/ALERT/TIMEOUT). 키 `automod:mspam:{workspaceId}:{ruleId}:{userId}`.

### IN — 3) REPEAT_SPAM (반복 메시지·Redis sliding window)

5. AutoModRule(REPEAT_SPAM): `repeatThreshold Int`(동일/유사 반복 횟수) + `windowSeconds Int`.
   작성자별 최근 메시지 contentPlain 해시(정규화 소문자·trim)를 Redis ZSET(score=now·member=hash)
   윈도 누적 → 동일 해시 반복 수 ≥ threshold 시 액션. 키 `automod:rspam:{workspaceId}:{ruleId}:{userId}`.

### IN — 공통

6. **ErrorCode**: `REGEX_UNSAFE`(400) + `AUTOMOD_TIMEOUT`(audit-only·errorCode enum + shared-types).
   AuditAction AUTOMOD_TIMEOUT(이미 있으면 재사용).
7. **CRUD/스키마**: shared-types automod.ts `CreateAutoModRuleRequestSchema` 의 `triggerType:
z.literal('KEYWORD')` → `z.enum(['KEYWORD','MENTION_SPAM','REPEAT_SPAM'])` discriminated union.
   KEYWORD: keywords + matchMode(REGEX 허용). MENTION_SPAM/REPEAT_SPAM: threshold + windowSeconds
   (keywords 불요). AutoModMatch REGEX. 검증(threshold 범위·window 범위·정규식 ReDoS).
8. **AutoModService.check**: triggerType 분기 — KEYWORD(리터럴 메인/REGEX worker) · MENTION_SPAM
   (멘션 수 인자 필요 — check 시그니처에 mentionCount 추가) · REPEAT_SPAM(contentPlain 해시). 기존
   exempt(OWNER/ADMIN·exemptRoles/Channels)·액션 집행·캐시 그대로.
9. **messages.service enforceAutoMod**: check 에 mentionCount(메시지 멘션 수) 전달. send+edit 양쪽.

### OUT (후속/Non-goals)

- 유사도(fuzzy) 반복 감지(정확 해시 일치만·Phase 2). 정규식 캡처그룹/치환(매칭 여부만).
- worker 풀 정밀 스케일링(단일 또는 소형 풀·후속 perf). re2(네이티브·회피).
- AutoMod 룰 UI 의 정규식/spam 편집 폼 대규모 개편(기존 폼 확장 최소).

## Acceptance Criteria (기계 검증)

- [ ] AutoModMatch.REGEX + 정규식 KEYWORD 룰 생성. 위험 정규식(`(a+)+$` 등 catastrophic) 저장 시도
      → 400 REGEX_UNSAFE(worker 100ms 워치독 초과 또는 컴파일 실패).
- [ ] 정규식 매칭이 worker_threads 격리 — 본문 매칭 ≤10ms·초과 시 terminate+AUTOMOD_TIMEOUT audit·
      메인 send 루프 무영향(메시지 통과). 안전 정규식 매칭 → 액션 정상.
- [ ] MENTION_SPAM: 윈도 내 멘션 누적 ≥ threshold → 액션. 미만 → 통과.
- [ ] REPEAT_SPAM: 윈도 내 동일 content 반복 ≥ threshold → 액션. 미만 → 통과.
- [ ] OWNER/ADMIN 면제·exemptRoles/Channels 가 3 트리거 전부에 적용. BLOCK 422·ALERT 통과·TIMEOUT mute.
- [ ] CRUD: 3 triggerType 생성/수정. KEYWORD 만 keywords·spam 은 threshold/window.
- [ ] verify green · 신규 int green(container standalone). worker_threads 가 verify/int 환경에서 동작.

## Risks

- **worker_threads 신규 도입**: 코드베이스 첫 사용. 순수 V8 isolate(kernel4.4 무관·BullMQ 와 별개).
  worker 파일 빌드(tsc → dist 경로 또는 ts-node·런타임 resolve) — NestJS 빌드 산출물에서 worker
  엔트리 경로 확보 주의(dist/.../automod-regex.worker.js). 테스트(vitest)에서 worker 경로 resolve.
- **send hot-path 비용**: 정규식 룰 있을 때만 worker 왕복. 리터럴/무규칙은 메인스레드 즉시(비용 0).
  spam 트리거는 룰 있을 때만 Redis ZSET 1-2 op. best-effort(throw 안 함·메시지 통과 우선).
- **ReDoS 검증 worker 타임아웃**: 저장 시 100ms·매칭 시 10ms 워치독. terminate 후 respawn 비용
  (드묾). worker 비정상 종료 시 매칭 스킵(fail-open — 모더레이션은 best-effort).
- **spam false positive**: threshold/window 기본값 보수적. exempt 로 완화 가능.
- DM(workspaceId=null) 제외 기존 정책 유지.

## DoD

체크리스트 green + standalone container `pnpm verify` + 신규 int green + 7차원 리뷰(security 중점=
ReDoS/worker 격리) fix-forward + fr-matrix FR-RM10→done + handoff LIVE + 자율 배포(auto-deploy.sh·
SHA 없이) + `/readyz=200` + 디스크 모니터. **이 슬라이스로 잔여 partial = FR-RT-22 하나만 남음.**
