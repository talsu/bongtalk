# Task 066 — FR-MN-10 키워드 알림 스캔 (S93)

## Context

FR-MN-10(P1, S48 partial): "키워드 알림: 최대 25개 키워드 등록. 메시지 저장 후 BullMQ
mention-scan 워커에서 공백 어절 정확 일치(대소문자 무관, 형태소 분석은 Phase 2) 탐지.
스레드 댓글 제외. 일치 시 mention:keyword 이벤트 + Inbox 기록. 26번째 등록 시 400."

**현재 상태(매핑 결과)**: 인프라 95% 준비됨.

- ✅ 키워드 저장: `UserSettings.keywords String[]` + `KEYWORD_MAX_COUNT=25` + 26번째 400
  (`notif-preferences.service.ts`) — **이미 done**.
- ✅ MentionRecord 모델 + 멱등(`@@unique[messageId,targetId,targetType]`), BullMQ 패턴
  (`mention-broadcast.*`), MentionGateService(block/mute/DND/thread-OFF/NotifLevel),
  ChannelAccessService.filterChannelVisibleUsers — 전부 존재(S88).
- ⚠️ 키워드 **스캔 로직 0%** — `notif-preferences.service.ts` 에 `TODO(mention-scan)` seam 만.
- ⚠️ MentionTargetType enum 에 **KEYWORD 값 없음**(USER/ROLE 뿐).
- ⚠️ **Inbox 미연결**: me-mentions/me-activity 가 `Message.mentions` JSON 만 조회 →
  MentionRecord 를 **아무도 읽지 않음**. @role 멘션조차 historical Inbox 에 미노출(live
  toast/badge/push 만). 키워드 "Inbox 기록" 을 실제로 만족시키려면 Inbox 쿼리가
  MentionRecord 를 인식해야 함.

## Scope

### IN

**BE — 스캔 파이프라인**

1. **Migration `20260630000000_frmn10_mention_keyword`**: `ALTER TYPE "MentionTargetType"
ADD VALUE 'KEYWORD'`. 추가형(forward-safe). down 은 PG enum 값 제거 난이로 no-op 문서화.
2. **새 BullMQ 큐 `mention-scan`** (mention-broadcast 패턴 미러):
   - `mention-scan-queue.constants.ts`: QUEUE/JOB 이름, CONCURRENCY=10, LIMITER 100/s,
     OPTS(attempts 3·backoff 2s·removeOnComplete/Fail 1000), `mentionScanJobId(messageId)`,
     `MentionScanJobData { messageId, channelId, workspaceId, actorId, snippet, createdAt,
syncNotifiedUserIds }`.
   - `mention-scan-queue.service.ts`: best-effort enqueue(jobId dedup·Redis 실패 흡수).
   - `mention-scan.processor.ts`: 워커.
3. **queue.module.ts**: MENTION_SCAN_QUEUE registerQueue + provider/export.
4. **messages.service.ts send()**: tx 커밋 후(mention-broadcast enqueue 옆) **루트 메시지에
   한해**(parentMessageId===null = 스레드 댓글 제외·PRD) + workspaceId!==null(DM 제외) +
   큐 주입 시 enqueue. `syncNotifiedUserIds` 전달(@user/broad/@role-sync 이미 알림된 집합).
5. **mention-scan.processor.run()** (잡당, mention-broadcast 절차 미러):
   - (0) 채널/메시지 생존 확인 + `channel.isPrivate`. 방어적으로 parentMessageId!==null 이면 skip.
   - (1) 스캔 텍스트 = `Message.contentPlain`(NOT NULL). `bounded = ' '+contentPlain
.toLowerCase().split(/\s+/).join(' ')+' '`(어절 경계 sentinel).
   - (2) 후보 watcher: `UserSettings JOIN WorkspaceMember(ws)` 에서 `array_length(keywords,1)>0`
     AND userId<>actor AND NOT IN syncNotified.
   - (3) 매칭: 각 watcher 의 각 키워드 → `kw = keyword.trim().toLowerCase()` 내부공백 단일화 →
     `bounded.includes(' '+kw+' ')`(**공백 어절 정확 일치**=whole-word·대소문자 무관·substring
     아님). 1개라도 일치 시 후보 채택.
   - (4) 가시성: filterChannelVisibleUsers(공개=1쿼리·비공개=2쿼리·비멤버 자연제외).
   - (5) 게이트: MentionGateService.filterNotifiable(kindFor=()=>'direct'·parentMessageId=null)
     — block/mute/DND/NotifLevel(키워드=개인 직접 알림 분류→MENTIONS 레벨 통과·NOTHING 제외).
   - (6) 기존-record dedup: 이 messageId 의 기존 MentionRecord.targetId(임의 type) 제외
     (@role 워커가 먼저 돈 경우 USER record 와 이중 Inbox 방지·잔여 race 문서화).
   - (7) 멱등 insert: `INSERT MentionRecord(... 'KEYWORD' ...) ON CONFLICT DO NOTHING
RETURNING targetId` → **실삽입분만** mention.received outbox(`keyword:true`) 1건/수신자.
     이후 부수효과(WS mention:new·badge·push·replay)는 기존 outbox-to-ws subscriber 가
     @user 와 동일 처리(이중경로 회피·B1).

**BE — Inbox 연결("Inbox 기록")**

6. **mention-events.ts**: `MentionReceivedPayload.keyword?: boolean` 추가(role?/everyone/here 패턴).
7. **outbox-to-ws.subscriber.ts**: mention:new wire payload 에 `keyword` 전달.
8. **me-mentions.service.ts** recent()+unreadCount(): mention WHERE 에
   `OR EXISTS(SELECT 1 FROM "MentionRecord" mr WHERE mr."messageId"=m.id AND
mr."targetId"=${userId}::uuid)` 추가 + `keyword` 플래그(=EXISTS … AND targetType='KEYWORD').
   ACL 절 불변(비가시 private 키워드 매치는 여전히 필터). MentionSummary 에 keyword 추가.
9. **me-activity.service.ts** mentions CTE(목록)+unread_mentions+counts 블록: 동일 OR EXISTS
   추가(통합 Activity 피드에도 키워드/@role 멘션 노출). **부수 효과: @role/@here historical
   Inbox 미노출 latent 갭도 함께 해소**(live 경로와 정합·의도된 동작·문서화).

**FE**

10. `useMentions.ts` MentionSummary 에 `keyword?: boolean`.
11. `dispatcher.ts`: mention:new 의 keyword 플래그를 캐시 병합(role/here 패턴).
12. `ActivityInboxPanel.tsx`(+모바일 대응 시): 키워드 멘션 레이블("키워드 알림" 등) 분기. 최소.

**TEST**

- unit: 키워드 토크나이저/매처(whole-word·대소문자무관·다어절·구두점 비일치).
- int(`messages.keyword-scan-frmn10.int.spec.ts`): 루트+watcher 키워드→MentionRecord(KEYWORD)+
  mention.received+me-mentions 노출(keyword:true) / 스레드 댓글 키워드→무생성·무이벤트 /
  본인 키워드 self→무알림 / mute·DND·block·NotifLevel=NOTHING→게이트 제외 /
  syncNotified(@user)→KEYWORD 이중생성 없음 / 비공개 채널 비멤버 watcher→무알림.

### OUT (후속/Non-goals)

- 형태소 분석(PRD Phase 2). 구두점 인접 어절(`deploy!`≠`deploy`)은 strict whitespace 정의대로 비일치.
- 매치된 키워드 **문자열** 저장/표시(MentionRecord 컬럼 추가 없이 `keyword:boolean` 플래그만).
- 정규식/그룹 DM 키워드. DM 채널 키워드 스캔(상대가 어차피 알림받음·workspaceId null 제외).
- 키워드 설정 UI(이미 S46/S48 done).

## Acceptance Criteria (기계 검증)

- [ ] `MentionTargetType` 에 KEYWORD(prisma migrate deploy green).
- [ ] 루트 메시지에 watcher 키워드 포함 → MentionRecord(targetType=KEYWORD, targetId=watcher) 1행 + mention.received(keyword=true) outbox 1건.
- [ ] 스레드 댓글(parentMessageId≠null)에 키워드 → MentionRecord 0행·outbox 0건.
- [ ] 작성자 자기 키워드 → 무생성. mute/DND/block/NotifLevel=NOTHING watcher → 무생성.
- [ ] 이미 @user 멘션된(syncNotified) watcher → KEYWORD record 미생성(1수신자 1 Inbox 항목).
- [ ] me-mentions recent()/unreadCount() 에 키워드 멘션 노출(keyword=true)·ACL 보존.
- [ ] whole-word: `deploy` 키워드는 "let's deploy now" 일치, "redeploys" 불일치(substring 아님).
- [ ] verify(lint+typecheck+unit+contract) green · 신규 int green(container standalone).

## Risks

- enum ADD VALUE: forward-safe. 워커 런타임 사용은 별 tx(같은 tx 사용 제약 무관).
- me-mentions/me-activity OR EXISTS: 추가형(행 추가만)·ACL 절 AND 보존 → 회귀 위험 낮음.
  @role record 보유 메시지가 historical Inbox 에 새로 노출(의도·정합). 기존 me-mentions/
  activity-acl 테스트는 MentionRecord 미생성이라 무영향(VERIFY 로 확정).
- 잔여 race(문서화): @role 워커가 키워드 워커 **이후** 실행되면 role∩keyword watcher 가
  USER+KEYWORD 2 record 가능(양쪽 사유 유효·드묾·bounded). 기존-record dedup 이 흔한 순서는 커버.
- enqueue-always(루트 한정): 키워드 0명 워크스페이스도 잡 1건/루트메시지 → 워커 (2) 쿼리
  early-exit. mention-broadcast 와 달리 send 시점 조건(키워드 보유자 존재)을 싸게 알 수 없어
  채택. **perf 리뷰 SERIOUS → fix-forward**: watcher (2) 쿼리가 전-멤버 스캔이던 것을 부분
  인덱스 `UserSettings_keyword_watchers_idx`(`WHERE array_length(keywords,1)>0` · 마이그레이션
  `20260631`)로 완화 — 키워드 채택률이 낮을 때 플래너가 키워드 보유자에서 출발해 멤버 수와
  무관한 plan 을 선택 가능. **잔여 후속(미구현·문서화)**: enqueue 자체를 워크스페이스
  키워드-보유 캐시로 게이트(0명 ws 는 enqueue 생략)는 race/무효화 설계 필요 → 별도 perf 슬라이스.

## DoD

체크리스트 green + standalone container `pnpm verify` + 신규 int green 로그 + 7차원 리뷰
(reviewer/contract/security/perf/ui/a11y/visual) fix-forward + fr-matrix FR-MN-10→done +
handoff LIVE + 수동 배포(승인 후) + `/readyz=200` + 디스크/서브볼륨 모니터.
