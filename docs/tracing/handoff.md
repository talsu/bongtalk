# qufox 자율 슬라이스 루프 — 세션 핸드오프

> 이 파일은 새 세션에서 작업을 이어가기 위한 단일 진입점입니다.
> **S05 검증·S06~S17 완료(아래 ✅). 자율 슬라이스 루프 진행 중 — 다음 활성 슬라이스는 S18(멘션 자동완성/특수멘션 confirm + 컴포저 @#: ARIA Combobox).** D02(채널) 전체 완료. S16(DM 개설/목록/실시간)·S17(DM visibleFrom + 차단 send-block/마스킹 + around 정합) 완료.
> 상태 원본: `docs/tracing/{slice-backlog.md, slices.json, fr-matrix.csv, carryover.md}`.

---

## 현재 상태 (2026-05-31)

- 완료·배포: **S00~S05 + S05 검증/fix-forward**. 프로덕션 라이브.
  - 직전 배포 기준 `main = a75655b`, `develop = da2df94` (feat 브랜치 보존).
  - S05 검증 머지(SHA/배포 결과)는 이 세션 REPORT 및 git log 참조.
- S04 빌드 게이트: `.github/workflows/ci.yml`이 `pnpm verify` 뒤에 production 빌드
  3종(shared-types/web/api)을 돌려 rollup/swc 해석 실패를 배포 전 차단.

## ✅ S05 검증 완료 (2026-05-31, 이 세션)

핸드오프 0-1~0-4 를 실행하고, **실제 Postgres(testcontainers)** 로 편집/삭제/이력을 검증했습니다.
정적 스텁만으로 가려졌던 **BLOCKER 1 + HIGH 3 을 발견·fix-forward** 했습니다.

- **0-1 실DB 통합 검증**: `apps/api/test/int/messages/messages.edit-history.int.spec.ts` 신규.
  정상편집(version+1·EditHistory 1행)·stale/동시편집 409+details.current(채널격리)·ring buffer 11→10·
  history 권한(작성자·OWNER·ADMIN 200 / 비작성자 403) 전부 GREEN.
- **발견·수정한 진짜 버그(스텁이 가렸던 것)**:
  1. **BLOCKER** — DM 편집 전면 불능: `MessageAuthorGuard` 가 `:chid` 만 읽어 DM 라우트
     (`me/dms/:channelId/messages`)에서 무조건 400. `chid ?? channelId` fallback 으로 수정 + DM 편집 int 추가.
  2. **HIGH** — `softDelete` TOCTOU: `update({id})` → 동시/재시도 삭제가 중복 MESSAGE_DELETED
     - deletedAt 재기록. `updateMany({id,channelId,deletedAt:null})` + count 가드로 데이터레이어 idempotent.
  3. **HIGH** — 라이브 (수정됨) 뱃지 미전파: MESSAGE_UPDATED nested payload 에 `edited` 누락 →
     `edited:true` 추가.
  4. **HIGH** — 모바일 (edited) 뱃지 + DS 클래스: `qf-m-message*`(DS 미등록)→`qf-m-msg*` 교정 +
     `__bubble` 제거 + 뱃지 추가.
- **0-3 갭 결정**: 모바일 (edited) 뱃지·DS 클래스 = **닫음**. 모바일 편집 **개시** UI(#5, HIGH) =
  mobile parity 슬라이스로 **연기**. FR-MSG-09 REST placeholder = **S33~S38(threads)로 연기**.
- **0-4 fr-matrix**: FR-MSG-06/07/RC16 = `done`(실DB 검증). FR-MSG-09 = `partial`(WS live done,
  REST placeholder 연기).
- **비회귀 발견**: `threads.int.spec.ts` 1건 RED(message.created 의 parentMessageId=null) — 선제존재
  task-014-B 버그, int 미실행으로 가려짐. S05 무관. carryover → D04(S33~S38).

게이트: `pnpm verify`(19 tasks, api 316·web) + 빌드 3종 + int(edit-history 11·dm 6·events 4) + reviewer approve 전부 GREEN.

---

## ✅ S06 완료 (2026-05-31, 이 세션)

frontend-only(`apps/web/src/features/messages/**`). 조사 결과 그룹핑(FR-MSG-10)·
스포일러(FR-MSG-16/RC14)는 S04/renderAst 에 이미 존재 → 재구현 없이 미구현분만 구현:

- **FR-MSG-12** 정밀 타임스탬프 포맷터(`formatMessageTime.ts`): 오늘 HH:MM(24h)/오전·오후(12h)·
  어제·N일 전·이전 'YYYY년 MM월 DD일' + ISO tooltip. clock24h 12/24h 토글 store 는 D14 후속(기본 24h).
- **FR-MSG-11** 날짜 구분선 + 자정 경계 그룹 강제 분리(grouping.ts `isSameLocalDay`).
- **FR-MSG-10** continuation 행 hover gutter 시각(`qf-message__gutter-time`).
- **FR-RC15** 이모지 1~3개 본문 32px(`jumboEmoji.ts`, `--fs-32`).
- **FR-MSG-22** 빈 채널 상태 보강(채널명·생성일·타입별 카피·topic; DS `.qf-empty`).
- 구현은 `feature-implementer` 위임 → 5팀 리뷰(reviewer/ui-designer/a11y/visual/perf) →
  fix-forward: invalid-iso 가드(F1, 렌더 크래시 회귀), 날짜 구분선/빈상태 a11y(`<time>`·h2·aria-label).
- MED/LOW(키보드 hover 접근=DS 후속, React.memo perf, e2e 커버리지, 커스텀이모지 jumbo)는 carryover.
- 게이트: verify 19 + 빌드 3종 + web 단위 159 GREEN. fr-matrix S06 7개 done.

## ✅ S07 완료 (2026-05-31, 이 세션)

D17 realtime backend. 게이트웨이가 이미 성숙(CONNECTION_READY 스키마·ws-auth·eager-join·redis adapter) → 갭만 최소 변경:

- **FR-RT-20** transports:['websocket'] 전용 + pingInterval 25000/pingTimeout 20000/maxHttpBufferSize 1MB(Node 힙은 compose 후속).
- **FR-RT-02** 채널 50-cap(eager-join, newest-first; **DM/override 우선 정렬로 cap 면제 — review MAJOR-2 fix**).
- **FR-RT-16** sharded redis adapter(createShardedAdapter) + **adapter 클라 keyPrefix='' — review BLOCKER-1 fix**(qufox: prefix 가 sharded SSUBSCRIBE 채널 라우팅을 깨던 무음 드롭 해소).
- **FR-RT-01** CONNECTION_READY{userId,sessionId} emit — **실제 갭이었음**(스키마만 있고 게이트웨이 미emit) → 추가.
- **FR-RT-21** user room join + userId-scoped 라우팅 — 이미 충족(확인).
- 다팀 리뷰(reviewer/security/contract) → BLOCKER-1·MAJOR-2 fix-forward. MED/LOW(WS CORS origin:true, connection:ready 명명=S10, refresh leave 비대칭)는 carryover.
- 게이트: verify 19 + api build + realtime int(multi-node/fanout/handshake/reconnect/channel-cap 3, sharded cross-node 검증) GREEN. fr-matrix S07 5개 done.

## ✅ S08 완료 (2026-05-31, 이 세션 — 검증 슬라이스)

REST POST→fanout / 멱등 / 커서 페이지네이션은 **S02~S05 에서 이미 충족** → 코드 변경 없이 실DB 검증:

- **FR-RT-03**: WS 메시지 송신 핸들러 부재(@SubscribeMessage 는 presence/channel/typing/read 만) — 송신은 REST→send()→outbox→message.created fanout. messages.events int(4)로 확인.
- **FR-RT-04**: Redis `idem:{userId}:{key}` TTL 24h read-through + DB `@@unique([authorId,idempotencyKey])` conflict→기존행 SELECT 200. messages.idempotency int(7)로 확인.
- **FR-RT-15**: before/after/around 상호배타(refine) + hasMore/nextCursor + id DESC + limit 50(max 100). messages.pagination int(12)로 확인.
- 게이트: 실DB int 23 GREEN. fr-matrix S08 3개 done. 코드 무변경(tracking-only 커밋).

## ✅ S09 완료 (2026-05-31, 이 세션)

D17 realtime frontend. dedup 은 기존 구현 → 갭만:

- **FR-RT-05 (done)**: 전송 타임아웃 — `MESSAGE_SEND_TIMEOUT_MS`(VITE override, 기본 5000) 초과 시 낙관 행 'failed' flip + AbortController abort. 이중-flip 가드(applyTimeoutFailure) + onSettled clear + 언마운트 정리. `sendTimeout.ts`/`timeoutFlip.ts`.
- **FR-RT-22 (partial)**: 채널 LRU 캐시(N=5, `touchChannel`+`qc.removeQueries` evict, **observer 가드 — review perf fix**) 완성. **around 재로드는 seam 만**(lastReadMessageId 공급원=D09 read-state/D17 join 스냅샷 미구현 → 최신 폴백). GAP-reset 은 S10 FSM 의존. → carryover.
- **FR-RT-24 (done)**: messageId Set dedup 이미 구현(dispatcher.ts) — 확인만.
- 다팀 리뷰(reviewer/perf) → observer 가드 fix-forward. around 미활성(HIGH-1)·consumeAround retry 취약(HIGH-2)은 D09/D17 활성화 시 함께 hardening(carryover).
- 게이트: verify 19 + web build + web 단위 272(+신규 LRU/타임아웃 유닛) GREEN. fr-matrix S09: 05/24 done, 22 partial. (S08 검증 tracking 동봉 커밋.)

## ✅ S10 완료 (2026-05-31, 이 세션 — 최대 규모)

D17 realtime fullstack: 서버 seq + 클라 재연결 FSM + gap-fetch. 계약(SeqSchema/상수/channel:synced)은 S00/S01 토대, **동작은 전부 신규 구현**.

- **FR-RT-06**: ChannelSeqService(Redis INCR seq:{channelId}, -1 sentinel) → outbox-to-ws emitAndBuffer 가 channel 스코프 이벤트에 seq 1회 stamp.
- **FR-RT-07**: 채널 단위 FSM(DISCONNECTED→RECONNECTING→GAP_FETCHING→SYNCED/SYNC_FAILED) + SeqTracker hole 감지 + gapFetch(after 재귀, MAX_PAGES 10) + gapMerge(messageId dedup) + PendingEventBuffer(200) + Backoff(3). 기존 서버-push replay 와 **공존**(replay.complete→SYNCED, truncated/hole→GAP_FETCHING).
- **FR-RT-23**: GapFetchQueue(GAP_FETCH_CONCURRENCY=5 FIFO).
- 다팀 리뷰(reviewer/security/contract/perf) → **fix-forward**: **BLOCKER**(after-페이지네이션 경계 메시지 손실 — messages.service.ts, revert-test 로 손실 재현·수정 후 0 손실 검증), **MAJOR**(재연결 baseline 미부트스트랩 → 서버 channel:joined{seq} emit + 클라 setBaseline), **MAJOR**(replay.truncated channelIds 화), MED(backoff 이중호출), perf(seqTracker evict reset), contract(SHARED_CONSTANTS). 재리뷰 **approve**.
- carryover: retry 타이머 detach 미정리(MED), NaN 가드/glue 테스트(NIT), Redis INCR 파이프라이닝·gapMerge perf 등(LOW), **WS 이벤트명 단일출처(콜론/닷) 미정비**(슬라이스 제목분, 범위 외 연기). S09 GAP_FETCHING reset seam 은 FSM 도입으로 evict→channelSyncStore.reset 연결됨.
- 게이트: verify 19(shared-types 165/web 321/api 316/webhook 50) + 빌드 3종 + int(gap-fetch 3 BLOCKER + seq-emission 4 + reconnect-replay 2 무회귀 + multi-node/handshake) GREEN.

## ✅ S11 완료 (2026-06-01, 이 세션)

D17 읽음 동기화 backend. **마이그레이션 슬라이스**(reversible up/down 검증).

- **설계**: Message.id 가 랜덤 uuid(cuid2 토대 미구현)라 FR 의 `id > lastReadMessageId` 대신 **`(createdAt, id)` 튜플 비교**로 unread 구현(페이지네이션 정합). UserChannelReadState += `lastReadMessageId`(uuid?) + `lastReadMessageCreatedAt`(timestamptz?), 레거시 `lastReadEventId`(replay)·`lastReadAt`(mention-inbox) 보존.
- **FR-RT-19**: monotonic upsert(ON CONFLICT WHERE 기존튜플<새튜플) — 퇴행 ack no-op.
- **FR-RT-14**: 튜플 unread 공식(row-value `(m.createdAt,m.id) > (rs....)`, deletedAt 제외, **자기메시지 포함**) — summarize/totals/DM 일관 전환.
- **FR-RT-13**: `POST .../ack{lastReadMessageId,clientTimestamp}` 신규 + `read_state:updated{channelId,lastReadMessageId,unreadCount}` user:room emit. `/read` deprecate(ackRead 위임). WS channel:read 정합. 5s debounce 는 프론트(D09).
- 다팀 리뷰(reviewer **approve** + contract): SQL/upsert/마이그레이션/emit/ACL 정확. carryover: read_state:updated **웹 dispatcher 소비**+/ack 채택(→D09 S22/23, S09 around-reload seam 도 이때 활성), DM self-inclusion UX·DM unread 테스트(→D03), 채널 join unreadCount(보류).
- **선제존재 int 실패 3건**(@everyone hasMention/DENY-ALLOW/totals-zero) = S11 무관(reviewer byte-identical 확인, int 미실행 누적) → D09 조사 carryover. ack-read-sync 5/5 등 S11 신규는 전부 GREEN.
- 게이트: verify 19/19 + build 6/6 + int(ack-read-sync 5 + unread-summary S11 케이스) GREEN.

## ✅ S12 완료 (2026-06-01, 이 세션)

D02 채널 CRUD. 기존 구현 상당 → 갭/BLOCKER:

- **🔴 S00 allowMask BLOCKER 닫음**: `addChannelMember`(POST :chid/members) 가 raw 마스크 무검증 → ADMIN 권한상승. zod(ChannelMemberOverrideRequestSchema, userId uuid + non-negative int) + 컨트롤러 **집행 비트필드 범위검증**(auth/permissions ALL_PERMISSIONS=0xFF, `mask>0xFF` 거부; int32 wrap 회피). int 8/8.
- **FR-CH-01** done(FORUM 타입 추가 — enum 마이그레이션; 타입선택 UI 는 백엔드만 수용·UI 후속). **FR-CH-02/20** done(기존). **FR-CH-03 partial**: 삭제후 이름재사용(partial unique `WHERE deletedAt IS NULL` 마이그레이션) done, **default-channel 삭제보호(409) 미구현**(Workspace.defaultChannelId 부재 → D13).
- 마이그레이션 `20260531180000`(reversible, down.sql purge 보강): FORUM enum + 채널명 부분유니크.
- 다팀 리뷰(security/reviewer) → BLOCKER-1(잘못된 비트필드) fix-forward. **carryover 중요: 권한 스킴 2중화(shared-types PERMISSIONS bit0-12 vs 집행 Permission 0xFF — 같은 override 컬럼·다른 의미) → D12 수렴 필요**. ADMIN 위임상한·DM body zod 등 LOW.
- 게이트: verify 19 + build + channels int(channels 10 + member-override 8) GREEN.
- DEFER(→S14): S05 채널 권한 마스크(MANAGE_MESSAGES 비트) 헬퍼 배선(softDelete/history role→bit).

## ✅ S13 완료 (2026-06-01, 이 세션)

D02 아카이브/토픽/설명/공지제한. **마이그레이션 슬라이스**.

- **FR-CH-04** done: archive/unarchive(기존) + archived send 차단(409 CHANNEL_ARCHIVED, 기존 — 플랜 403 대신 일관 유지) + `SYSTEM_CHANNEL_ARCHIVED` 시스템메시지 신규. (기본채널 아카이브불가 defer→D13.)
- **FR-CH-09** done: 토픽 실제 변경 시에만 `SYSTEM_CHANNEL_TOPIC_CHANGED` emit + channel.updated 유지.
- **FR-CH-10** done: 마이그레이션 `20260601000000`(description VARCHAR(500) + GIN to_tsvector 인덱스, reversible) + CRUD + 브라우저 노출 + 설정 UI. (FTS 쿼리는 D07.)
- **FR-CH-19** done: ANNOUNCEMENT 게시제한 — 신규 `CHANNEL_POSTING_RESTRICTED`(403) + `requireAnnouncementPostingAllowed`(OWNER/ADMIN 또는 명시 WRITE_MESSAGE override; MEMBER 차단, ANNOUNCEMENT 한정) + 프론트(composer disabled/placeholder/툴팁 + megaphone 배지).
- 다팀리뷰(reviewer/security): **보안 게이트 우회 불가**(서버 최종집행). 블로커 없음. carryover: 프론트 게이트가 override 무시(MAJOR-3, override UI 미존재라 현재 무해→S14/15), forwardRef 3중 순환(이벤트 디커플 권장), 게이트 수동 fold(resolveEffective 권장), 비트랜잭션 시스템메시지/nit.
- 게이트: verify 19 + build 3 + channels int(s13 9 + channels 10 = 19) GREEN. fr-matrix S13 4개 done.

## ✅ S14 완료 (2026-06-01, 이 세션)

D02 채널 권한 오버라이드/전환/가입.

- **FR-CH-11**: **실제 버그 fix** — `PermissionMatrix.effective` 가 2단계(모든 ALLOW/DENY union 후 1회 `&~`)라 "개인 ALLOW>역할 DENY" 표현 불가였음 → **5단계 fold**(base→roleAllow→roleDeny→userAllow→userDeny, 나중 우선=FR 순서)로 교정(unit 5종). ROLE override 엔드포인트(`POST :chid/roles`, 0xFF 범위검증). 집행 8bit 스킴 기준.
- **FR-CH-05**: 비공개→공개 flip 시 `confirmName`==채널명 서버 강제(CHANNEL_CONFIRM_REQUIRED 400) + 프론트 alertdialog 모달(경고/이름재입력/모바일 fullscreen).
- **FR-CH-07**: join/leave(override 기반 opt-in/out, read-state 보존, member_added/removed). 비공개 join 403.
- 다팀리뷰(security/reviewer) → **HIGH fix-forward**: joinChannel 이 allowMask:0xFF 부여 → 새 5단계와 결합해 자유가입이 역할 DENY 우회·권한상승 → **0(순수 마커)로 수정** + int 단언. 5단계 fold 는 무회귀(DM 미적용, deny-wins 보존).
- 게이트: verify 19 + build 6 + channels int(s14 13 + permissions unit 14) GREEN. 마이그레이션 없음(ChannelPermissionOverride 재사용). fr-matrix FR-CH-05/07/11 done.
- carryover: /join 비공개 403→404 정보누수(MED), 공개 leave cosmetic(listByWorkspace 미반영, MED), 권한스킴 2중화(D12), S05 마스크 배선(S15/messages-perm), S13 MAJOR-3(per-viewer canPost), nits.

## ✅ S15 완료 (2026-06-01, 이 세션) — **마이그레이션**

D02 브라우저/카테고리/정렬/slowmode.

- **FR-CH-08** slowmode: 마이그레이션 Channel.slowmodeSeconds + SlowmodeService(Redis PTTL+429 CHANNEL_SLOWMODE_ACTIVE+retryAfterMs+SET EX NX) + BYPASS_SLOWMODE(0x100, 집행 ALL_PERMISSIONS 0xFF→0x1FF) + Redis-fail DB fallback. messages send 게이트.
- **FR-CH-12** 카테고리 soft-delete: 마이그레이션 Category.deletedAt + partial unique + same-tx categoryId=NULL + 이벤트.
- **FR-CH-13** reorder 배치: PATCH /channels|categories/positions + 항상 1000 등간격 재정규화(SELECT FOR UPDATE) + reordered 이벤트.
- **FR-CH-06** 브라우저: ChannelBrowser(검색/정렬/join/empty). 멤버수 정렬 보류(DTO 집계 부재).
- 다팀리뷰(security/reviewer) → **fix-forward**: BLOCKER 재정렬 이벤트 복수형→**단수**(channel./category.reordered, wildcard 무음드롭 해소), HIGH private-gate **READ 비트 요구**(아무비트→baseline 복원 격리누수 해소) + unit.
- carryover: MAJOR-1 slowmode-vs-idempotency replay(send 게이트 순서, MED), MAJOR-2 reorder 프론트/멤버수정렬, 2중스킴 심화(D12), nits.
- 게이트: verify 19(신규 permissions unit 포함) + build 3 + channels int(s15 7 + s14 13 + member-override 8) GREEN. unread-private-acl "DENY beats ALLOW" 1실패 = **선제존재 unread-SQL ACL 버그**(내 PermissionMatrix fix 무관, S11~ carryover). 마이그레이션 reversible. fr-matrix FR-CH-06/08/12/13 done.

## ✅ S16 (D03 DM 개설/목록/실시간) — 완료

- FR-DM-01(1:1 createOrGet, `gdm:`/`dm:` 결정적 slug + partial unique 로 중복금지, friendship ACCEPTED 매 호출 재검증), FR-DM-02(group 2-19명, 초과 422 `DM_GROUP_CAP_EXCEEDED`), FR-DM-03(목록 lastMessageAt DESC + unreadCount + preview + participants≤5, group 도 participants≤5), FR-DM-16(`dm:created` outbox `dm.**`→user room fanout + web `useDmCreated` 훅).
- **리뷰 fix-forward**(reviewer+security+contract 3팀): BLOCKER=group DM global 경로 friendship 게이트 부재(임의 userId 강제편입 harassment) → `assertCanDm(meId,otherId)` 추출, 1:1+group 공유, 비친구/차단 동일 404+중립메시지(차단여부 비노출). HIGH=group/1:1 body class-validator DTO(UUID 검증) + `dm:created` 와이어에서 내부 `recipients` 제거(participant UUID 누출) + blocked-vs-not-friend 메시지 누출 통일. MED=group participants≤5 + docstring/주석 정정(offline replay·group-dedup).
- 게이트: verify 19 + build 3종 + dms int 19/19(비친구 group 거부·비-UUID 400·group dedup created:false·1:1 중복금지·dm.created emit) GREEN. 마이그레이션 없음(스키마 무변경). 선제존재 int 실패는 DM 무관.
- carryover(MED): DM rate-limit, DmListItem→shared-types 이관(D12), group true-duplicate 의미(현재 idempotent dedup), useDmCreated Shell 미배선(dormant), uid 로깅, tx 더블캐스트.

## ✅ S17 (DM visibleFrom + 차단 send-block/마스킹 + around 정합) — 완료

- FR-DM-13(1:1 DM send/edit 시점 양방향 Friendship BLOCKED → 403 중립, `assertNotBlockedForDmSend`), FR-DM-17/TH-19(visibleFrom=ChannelPermissionOverride 신규 nullable 컬럼, list before/after/around/initial + around contextBefore + getOne + around anchor 전 경로 `createdAt>=visibleFrom`), FR-DM-18(그룹 DM 차단 author 메시지 `[차단된 사용자의 메시지]` placeholder 마스킹 — list/thread/getOne, 단일 SELECT blocked-set, mentions 도 비움), FR-DM-19(`friend.unblocked`→`user:unblocked` blocker 룸 emit + web `useUserUnblocked` dormant).
- **방침**: 별도 UserBlock 모델 미생성 → Friendship BLOCKED 재사용(S16 participantHash·권한 2중스킴과 동일 PRD↔구현 편차 처리). visibleFrom=ChannelPermissionOverride USER row.
- **리뷰 fix-forward**(reviewer+security+perf+contract 4팀): BLOCKER 2(차단 마스킹이 thread/getOne 읽기경로 우회) → 두 경로에 마스킹+visibleFrom 적용. MAJOR(편집 PATCH 가 send-block 우회) → update 게이트. perf-critical(send 시 채널 중복 SELECT) → readChannel 타입 확장+채널메타 인자화로 제거. NIT(around anchor oracle 404, mentions 잔존, type guard).
- 게이트: verify 19 + build 3종 + dm-s17 int 9/9 + getOne 3/3 GREEN. 마이그레이션 reversible(`20260601200000_s17_dm_visible_from` up/down PG16 검증).
- carryover(MED): blocked-set 캐싱, FRIEND_BLOCKED oracle 중립코드, unread visibleFrom 미인지(hidden-restore 결합), masked DTO flag, hidden-DM-restore visibleFrom 갱신, Shell 배선.

## 다음 슬라이스: S18 (멘션 자동완성/특수멘션 confirm + 컴포저 @#: ARIA Combobox)

- scope 주로 web(`apps/web/src/features/**` 컴포저/멘션), 일부 api(멘션 검색).
- FR-MSG-14/15, FR-RC03/04/05/06. 컴포저 @(유저)·#(채널)·:(이모지) 자동완성 ARIA Combobox + @everyone/@here 등 특수멘션 confirm.
- 주의: **UI 슬라이스 → ui-designer + visual-regression-scanner 리뷰 필수**(DS 4파일 무수정, qf-_/qf-m-_ 토큰만). 기존 멘션 시스템(S04 codeblock-mention-system, task-013/014) 위에 자동완성 UI. FR 정본: PRD html(FR-RC 섹션).
- **D09 read-state(S21~24) 진입 시**: S09 around-reload seam 활성 + read_state:updated 웹 dispatcher 소비 + /ack 채택(묶음 carryover).

---

## 슬라이스 루프 프로토콜 (메가루프)

1. **UNDERSTAND**: slices.json의 해당 슬라이스 + FR 정본(PRD html) + 현재 코드 델타.
2. **IMPLEMENT**: 큰 fullstack은 `feature-implementer` 서브에이전트에 정밀 스펙 위임,
   작은 건 직접. red→green→refactor. 커밋은 리뷰 후 메인 루프에서.
3. **다팀 리뷰**(병렬, read-only): `reviewer` + `security-scanner` + `contract-validator` +
   `performance-profiler` + (UI 변경 시) `ui-designer`. BLOCKER/HIGH는 fix-forward,
   MED/LOW는 `carryover.md` 기록.
4. **VERIFY**: fix 후 `pnpm verify`(19 tasks) + 빌드 3종 green.
   **fullstack/마이그레이션 슬라이스는 `test:int`로 실DB 검증까지** (S05 교훈 — 스텁만으로 done 금지).
5. **추적**: `fr-matrix.csv` FR todo→done(검증 근거와 함께), `carryover.md` 갱신.
6. **머지**: feat/sNN → develop(--no-ff) → main(--no-ff), 셋 다 push. **feat 브랜치 삭제 금지**.
7. **배포**: main push가 webhook auto-deploy 트리거. 결과 =
   `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`의 `deploy.result.exitCode` +
   /readyz·/healthz·web 200. prod 마이그레이션은 api 컨테이너 CMD `prisma migrate deploy` 자동.
   실패 시 /readyz 게이트가 `:prev`로 auto-rollback.
8. **REPORT**: 머지 SHA(develop/main) + 리뷰 요약 + verify/빌드/검증 결과 + 배포 exitCode + carryover.

## 주의사항

- `scope_allow`가 FR 요구를 못 담는 경우 있음(S01 토대 누락분 — S05가 prisma+shared-types로
  확장한 선례). 필요 시 확장하되 Safe Autonomy 범위 내, `carryover.md`에 편차 기록.
- 폴라이트 한국어(~합니다/~세요)만. DS 4파일(`apps/web/public/design-system/*`) 절대 수정 금지,
  `qf-*`/`qf-m-*` 토큰만(raw hex/px 금지). 호칭은 "MinIO"(코드만 S3).
- `.claude/settings.json`의 워킹트리 변경($schema url)은 무관 — 스테이징/커밋 금지.
- prod DB 직접 접근 / prod 시크릿 쓰기 / main force push 금지.

## carryover.md의 임박 항목 (해당 슬라이스 진입 시 함께 처리)

- **S12~S15(D02 채널 권한)**: S00 allowMask BLOCKER + S05 채널 권한 마스크(MANAGE_MESSAGES
  비트) 헬퍼 미배선(현재 role 기반 보수 게이트).
- **S33~S38(D04 threads)**: S05 FR-MSG-09 placeholder REST read-path 보강.
- **S19/S20(D03 DM)**: S05 DM `/history` 엔드포인트 미구현.
- **mobile parity 슬라이스**: S05 모바일 (edited) 뱃지 + MobileMessages `qf-m-message` 클래스 교정.
