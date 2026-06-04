# qufox 자율 슬라이스 루프 — 세션 핸드오프

> 이 파일은 새 세션에서 작업을 이어가기 위한 단일 진입점입니다.
> **S05 검증·S06~S44·S46~S67 완료(아래 ✅). S45 부분 보류(@role fanout·MentionRecord·@here SLO). 자율 슬라이스 루프 진행 중 — 다음 활성 슬라이스는 S68(D13-workspace-invite, FR-W04/W04a/W05/W18 — 이메일 초대+도메인 자동가입 관리. invites[S12/S65/S66/S67]·MailSender[S66 console stub]·emailDomains 게이트[S66] 재사용. fullstack·UNDERSTAND 필요·이메일 초대 별도모델 vs Invite.email 확장 fork). ★별도 백로그: AutoMod(FR-RM10·사용자 별도분리·re2 vs Worker 진입 시 결정).** ⚠️ **★서버 미디어 리사이즈 금지 확정**(S57 사용자 결정 — FR-AM-18 썸네일 Sharp "스킵·CSS 다운스케일"·[[feedback_no_server_media_resize]]·S41 일관·FR-AM-30 비디오 인라인/썸네일 P2 OUT deferred 동일). processingStatus complete 시 READY·thumbnailKey null·CSS 다운스케일. D01·D02·D03·D04·**D05(S39~S42)**·**D06(S44·S46~S49 핵심완료)**·**D10(S50~S53 전체완료)**·**D11(S54~S60 완료)**·**D16(S60 부분착수)**·**D12(S61~S64 완료·Role/집행/override/AuditLog/kick·ban·timeout/bulk·신고·감사조회·FR-RM10 AutoMod만 별도분리)**·**D13(S65~S67 진행·생성/소유권/나가기/기본채널·이메일인증/도메인 게이트/초대만료·초대링크 생성·수락·관리[temporary/MODERATOR/8자/hard-delete])**·D07·D08·D09·D17·완료. **진행률: 272/354 FR done·FR-AM-30/FR-RM13 deferred·FR-RM10 별도분리.** ⚠️ **★S61 커스텀 Role: 데이터모델/CRUD/privilege escalation 방어/cascade 완료·집행 배선만 S62 분리**(사용자 결정 B·[[project_s61_custom_role_approved]]). BullMQ([[project_bullmq_greenlight]])는 reminder(S53)·unfurl(S60·concurrency4)·role-cascade(S61 FR-RM15) 재사용. ⚠️ 머지 push 시 develop 누락 반복([[reference_develop_push_drops]]·ls-remote 검증 필수). ⚠️ **★BullMQ in-process 도입됨**(S53 — `apps/api/src/queue`·전용 IORedis maxRetriesPerRequest:null·Redis 공유·[[project_bullmq_greenlight]]). 향후 BullMQ 의존 작업(FR-MN-10 키워드스캔·mention SLO) 재사용 가능하나 각 데이터모델은 별도. **★핀 권한 = PIN_MESSAGE 비트(0x80) 미사용**(S51 `Channel.memberCanPin` 컬럼·D12 분리 S61~S64 잔여). defer 누적: FR-CH-16(P2)·S45(커스텀 Role+MentionRecord+@role+@here SLO·FR-MN-03/19/21)·S44 fanout cap·FR-MN-10 키워드스캔(partial)·VAPID push(FR-MN-09/11/15/18 — VAPID 보류 일관). ⚠️ subagent 에 머지/배포/prod-접근 금지 명시 필수([[feedback_subagent_no_merge_deploy]]). implementer 보고가 "머지·배포 완료"면 즉시 사후 리뷰 실행.
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

## ✅ S18 (컴포저 @#: 자동완성 ARIA Combobox + 특수멘션 confirm) — 완료

- FR-RC03(@ 멤버 debounce 150ms·최대8·온라인 가중치·@here/@everyone 특수항목), FR-RC04(# 채널 아이콘+이름+topic), FR-RC05(: 이모지 ≥2자·유니코드+커스텀·최대12), FR-RC06(↑↓/Enter/Tab/Esc·`.qf-mention` pill·WAI-ARIA Combobox), FR-MSG-15(권한없는 특수멘션 plain text — 서버 gate.ts 기존), FR-MSG-14(**partial** — confirm 임계값 6/50). 신규 `apps/web/src/features/messages/autocomplete/**` 12모듈.
- **리뷰 fix-forward**(reviewer+a11y+ui-designer+visual 4팀): correctness BLOCKER(debounce trigger offset 로 live draft 치환 → 범위손상 → live detectTrigger 동기 재계산). MAJOR×3(@channel 거짓약속 → 제거; @here MEMBER confirm → 서버 gate 정합 OWNER/ADMIN 전용; 수신자수 워크스페이스 오인 → 카피 완곡화). a11y BLOCKER×6(aria-controls 유지/aria-haspopup/live-region/이모지 aria-hidden/온라인 sr-only/active scrollIntoView). DS BLOCKER×2(confirm dialog 가 !important 로 DS 뚫음+qf-modal 구조이탈 → ChannelPrivacyConfirmModal 패턴 재작성).
- 게이트: verify 19 + build 3종 + web 385 단위 GREEN. **DS 4파일 무수정** 확인. api 무변경·마이그레이션 없음(web-only).
- carryover(MED): 서버 @channel fanout(D04), @here FR↔서버 권한편차, confirm 정확 수신자수, A-08/09 DS 토큰 대비, DS-3 Tailwind 키 선제존재, visual baseline(Docker Playwright).

## ✅ S19 (그룹 DM 멤버관리 + owner 승계 + DM 수신권한) — 완료

- 하이브리드(C) 설계(설계 패널 만장일치): 멤버십=ChannelPermissionOverride USER row(allowMask 1차) + nullable joinedAt/leftAt + Channel.ownerId(group 전용) + User.allowDmFrom enum. **★불변계약: soft-leave 시 leftAt=now()+allowMask=0 원자 UPDATE** → 9개 read-path 무변경 + reversibility.
- FR-DM-07(멤버추가 POST participants, Serializable+P2034, cap20→422, 멤버별 assertCanDm+assertDmPrivacyAllows, 부분추가금지, 재진입 visibleFrom 재세팅), FR-DM-08(강퇴 owner-only, 1:1 403, 자기-강퇴 403), FR-DM-09(나가기 + owner joinedAt 최古 승계 + 마지막멤버 Channel.deletedAt), FR-DM-12(PATCH dm-privacy EVERYONE/WORKSPACE_MEMBER, assertDmPrivacyAllows='공통 워크스페이스 OR friend').
- 마이그레이션 `20260601300000` reversible(PG16 up→down→up). 신규 ErrorCode DM_PRIVACY_RESTRICTED(403). 이벤트 dm:participant_added/removed/owner_changed(recipients strip).
- **리뷰 fix-forward**(reviewer+security+perf+contract 4팀): BLOCKER(listGroups members CTE 가 allowMask 필터 누락 → 강퇴/탈퇴 멤버 UUID 잔여멤버에 노출 → CTE 에 allowMask&1>0 + leftAt IS NULL). MAJOR(게이트가 tx 밖 → tx 주입). HIGH(dm-privacy DTO class-validator). MED(ownerId=null 명시 FORBIDDEN, 부분인덱스 leftAt:null 매칭 + 중복 인덱스 drift 제거).
- 게이트: verify 19 + build 3종 + dm int 45 GREEN(B1 회귀 포함). DS 무수정.
- carryover(MED): rate-limit 3엔드포인트, idempotency, owner 하드삭제 승계 훅, DmParticipant 정규화(장기), FR-DM-07 추가권한 정책, dm:participant\_\* web 소비 훅, FRIENDS_ONLY(Phase2).

## ✅ S20 (DM 검색/이름변경/아이콘/숨기기/뮤트) — 완료

- FR-DM-04(GET /me/dms?q= ILIKE displayName/slug/username, escape+maxlen100), FR-DM-05(PATCH name → Channel.displayName + dm:group_updated), FR-DM-06(POST/DELETE icon multipart 4MB JPEG/PNG/GIF/WebP + validate-magic-bytes + MinIO putObject), FR-DM-10(PATCH visibility HIDDEN/VISIBLE → ChannelPermissionOverride.hiddenAt, list 제외, send() 시 수신자 자동복원), FR-DM-11(PATCH mute → 기존 UserChannelMute upsert).
- 마이그레이션 `20260601400000_s20_dm_meta_hidden` reversible: Channel.displayName/iconUrl + ChannelPermissionOverride.hiddenAt. 이벤트 dm:group_updated.
- **리뷰 fix-forward**(reviewer+security+perf+contract 4팀): BLOCKER 3(검색 `ESCAPE '\'` JS 붕괴→`ESCAPE ''` 무력화→`'\\'` 수정; PATCH mute 멤버십 게이트 부재 IDOR→assertDmMember; 검색 q 무제한 DoS→maxlen 100). MAJOR(rename/icon outbox 비원자→단일 tx; send() 매전송 findUnique→channelType 인자화 hot-path; 아이콘 orphan→실패 시 deleteObject). contract(web GroupDmListItem displayName/iconUrl 타입).
- 게이트: verify 19 + build 3종 + dm int 64 GREEN. DS 무수정.
- carryover(MED): rate-limit 4엔드포인트, displayName XSS charset, **iconUrl presign-on-read(web 배선 시 필수)**, pg_trgm 인덱스, **클라 q 서버검색 배선**.

## ✅ S21 (D09 읽음상태 코어) — 완료

- FR-RS-01(POST /channels/:id/ack + read_state:updated 전 세션 emit + 웹 dispatcher 소비), FR-RS-03((createdAt,id) 튜플 unread, self-inclusive), FR-RS-14(Redis `unread:{ws}:{user}` Hash 캐시 TTL 2h + fenced stampead 락 — controller 연결됨), FR-RS-16(mentionCount + @userId/@here/@channel/@everyone, ACK 리셋), FR-RS-17(monotonic 후진방지).
- **선제존재 unread int 3건 root-cause 수정·GREEN 전환**: unread ACL 2단계→**5단계 fold**(PermissionMatrix.effective 정합, readBitVisibleSql 단일출처); summarizeWorkspaceTotals INNER→LEFT JOIN(zero-channel/OWNER-DENY row 보존); @everyone/@here/@channel mention 집계. 부수: S18 @channel carryover 닫힘 + totals CTE 콤마 syntax error(선제존재) 수정.
- **리뷰 fix-forward**(reviewer+security+perf+contract 4팀, BLOCKER 0): FR-RS-14 캐시 dead-code 연결(A) + stampead 실제 방어(락-loser 대기+재조회, fenced del, TTL 클램프/기본 2000)(B) + totals CTE fold 통합(C) + @channel/@here live badge wire(D) + OWNER DENY 정합(E) + mention `@>` GIN(F) + read_state:updated workspaceId(G) + fold 경계 테스트(H).
- 게이트: verify 19 + build 3종 + channels int 전부 GREEN. 마이그레이션 없음(mentionCount on-the-fly + Redis TTL).
- carryover(MED): ACK rate-limit, unreadCount+mentionCount 단일쿼리 병합, 클라 mentions 힌트, 새 메시지/멤버변경 캐시 무효화 와이어링, around-reload seam 공급.

## ✅ S22 (읽음 사이드바 2계층 + 디바운스/즉시 ACK + 뮤트 억제 + 서버버튼 멘션 뱃지 + DM 미읽 배지) — 완료

- web-only. FR-RS-04(qf-channel--unread bold+pill + qf-badge--count 멘션 suffix), FR-RS-05(뮤트 unread 억제·멘션 배지 유지), FR-RS-15(서버버튼 qf-server-btn\_\_unread 멘션 합산), FR-DM-15(**partial** — DM unread 배지, 뮤트DM 멘션은 GET /me/dms mentionCount contract 갭), FR-RS-02(AckScheduler 5s 디바운스 + scroll-to-bottom 즉시 + clientTimestamp). S21 useUnread/read_state:updated 데이터 재사용. 신규 DS 클래스 0.
- **리뷰 fix-forward**(reviewer+ui-designer+visual+a11y 4팀): e2e 신호 갱신(unread-pill→data-unread 2계층 + 뮤트억제 e2e 신규), a11y(서버배지 aria-label 조합+aria-hidden, aria-selected→aria-current[허용 role], dialog 라벨), mentionCount 낙관패치 일치, key={channelId} atBottom, 뮤트 만료 클라필터, raw px→토큰.
- 게이트: verify 19 + build 3종 + web 429 GREEN. DS 4파일 무수정.
- carryover: DmShell qf-section/qf-channel--active 미등록(선제존재 HIGH), a11y A-4 keyboard reachability(선제존재 HIGH), DM mentionCount contract, visual baseline(Docker Playwright), 배지 대비(DS).

## ✅ S23 (NEW MESSAGES 구분선 + Jump-to-Unread + Esc/Shift+Esc 읽음) — 완료

- FR-RS-06(채널진입 스냅샷 firstUnread 위 NEW MESSAGES 구분선, 가상화 별도 행, 미읽 없으면 미표시), FR-RS-07(구분선 viewport 밖이면 Jump pill, 첫 렌더 virtualIndex vs 구분선 인덱스 비교 + 20ms 보정), FR-RS-11(**정정**: Esc=현재 채널 읽음/Shift+Esc=워크스페이스 전체 읽음 단축키, mark-unread 아님). 신규 `POST /workspaces/:id/read-all`(set-based 단일 SQL, monotonic, ACL 가시채널만). 신규 DS 클래스 0(page-scoped DS 토큰).
- **리뷰 fix-forward**(reviewer+ui-designer+visual+a11y 4팀): Esc 오버레이 충돌(EmojiPicker/ThreadPanel stopPropagation + defaultPrevented 가드), **cold-cache 구분선 소실**(스냅샷을 부모로 lift, zero-out 전 캡처), dispatcher null lastRead clear 금지(around-reload 보존), markAllRead O(N)→set-based 1 SQL + onError 롤백, jump pill overscan 보정·색(bg badge-unread a-600)·포커스 이동·포커스링, 구분선 텍스트 정합.
- 게이트: verify 19 + build 3종 + web 단위 + read-all int 5 GREEN. DS 4파일 무수정.
- carryover: role=log live-region(선제존재 HIGH), 라이트 구분선 대비(DS), 데스크톱 구분선 DS 클래스 갭, DM 구분선/전체읽음 contract, around-reload 서버 emit.

## ✅ S24 (수동 미읽 + 컨텍스트 읽음 + Unreads View + mark-all-read Undo) — 완료

- FR-RS-08(수동 mark-unread: `POST .../unread {messageId}` → 직전 튜플 후진, **비-monotonic setCursorBackward**), FR-RS-09(채널 컨텍스트 메뉴 읽음 → `/read-ack` emit), FR-RS-10(Unreads View 사이드바 최상단, mention 우선 정렬, per-channel/모두읽음, 5초 Undo 토스트, empty state), FR-RS-18(mark-all-read snapshot+Undo: snapshot=advance RETURNING old-value, Redis(TTL5분)+DB MarkAllReadSnapshot 이중, Undo set-based). 마이그레이션 `20260601500000_s24_markallread_snapshot`(reversible).
- **리뷰 fix-forward**(reviewer+security+ui-designer+a11y 4팀, BLOCKER 0): security(loadAndConsumeSnapshot Lua owner-gated atomic claim + DELETE RETURNING expiresAt — owner-mismatch/만료/double-Undo 404 차단), snapshot RETURNING old-value(동시 ACK race 제거), undo set-based+transaction, FR-RS-09 read_state:updated emit(/read-ack), 컨텍스트 메뉴 포커스 "더보기" 버튼(키보드), Unreads aria-label, Toast 이중 live-region 제거+action+Undo 8s pause, qf-empty.
- 게이트: verify 19 + build 3종 + channels int 18(read-all 12+mark-unread 6) GREEN. DS 4파일 무수정.
- carryover(HIGH/MED): **message toolbar hover-only 키보드(DS focus-within 규칙=DS 태스크)**, snapshot GC cron·크기상한, markUnread/undo rate-limit, 다크 muted 대비(DS), 모바일 Unreads, around-reload 서버 emit.

## ✅ S25 (프레즌스 코어 — 상태 5종 + IDLE 전환 + grace + 다중디바이스) — 완료

- FR-P01(PresenceStatus 5종 + INVISIBLE→offline 마스킹 `maskPresenceForViewer` 단일지점), FR-P02/RT-10(35s grace 타이머 + auto-idle 600s + presence:activity), FR-RT-11(다중디바이스 Redis Set, 한 세션이라도 active→online). 마이그레이션 `20260601600000`(invisible enum, reversible). presence:subscribe/bulk + presence.updated(online/dnd/idle).
- **리뷰 fix-forward**(reviewer+security+perf+contract 4팀): 보안 BLOCKER(finalizeOffline preference 삭제→INVISIBLE 복원 누출 → preference 정적 보존; presence:subscribe authz 전무 → 워크스페이스/DM 교집합 필터 + userIds max500 + safeParse; dndIn lazy GC; graceEpoch cross-node). perf(effectiveStatus Promise.all 병렬, idleIn 1회). contract(presence.updated WORKSPACE_PRESENCE_UPDATED 타입화). me-presence Zod, env constants.
- 게이트: verify 19 + build 3종 + presence int 12 GREEN. DS 4파일 무수정.
- carryover: presence.updated dot→colon(S10), idle sweep 멀티노드, delta payload, **web presence:activity emitter(서버 준비됨, 클라 미전송)**, 멤버목록 REST 마스킹.

## ✅ S26 (프레즌스 구독 lifecycle + presence:update fan-out + 타이핑 DM 통일) — 완료

- FR-RT-12/P14/P16(presence:sub:{socketId} Set + presence:update fan-out + presence:unsubscribe SREM + disconnect TTL + burst rate-limit 10/s + 500 cap), FR-P07(typing TTL 10s + max-3 "외 N명" cap), FR-DM-14(DM typing 동일 경로, prefix 무).
- **리뷰 fix-forward**(reviewer+security+perf+contract 4팀): 보안 BLOCKER(presence:update fan-out authz-staleness → **fan-out 시점 live 재검증 canStillObservePresence**[라이브 workspaceMember+DM+양방향 BLOCKED] 으로 강퇴/이탈/차단 후 누출 0; DEL-on-connect clearSubscriptions 로 sid-reuse 부활 차단). me-presence fan-out 비동기화. body 타입.
- 게이트: verify 19 + build 3종 + presence-sub int 11(authz-staleness 5 신규) + presence 12 + patch 3 GREEN. 마이그레이션 없음. DS 무수정.
- carryover(MED): **presence:update web read-side 배선(현재 dead-write)**, cross-node fan-out(멀티노드), perf(이중 브로드캐스트·per-viewer authz 캐시·EXISTS-N), typing.updated WS-naming(S10), friend.blocked outbox 이벤트화.

## ✅ S27 (멤버 목록 API status/hoist 그룹 + N+1 제거 + INVISIBLE 마스킹 + lastSeenAt + 1000명 OFFLINE 제외) — 완료

- FR-P08(멤버목록 **authoritative 그룹핑**: <1000 전체 로드+bulkFor / ≥1000 online∪dnd 만, cursor 페이지), FR-P12(INVISIBLE→offline 마스킹 REST — S25/S26 carryover 해소), FR-P10(lastSeenAt OFFLINE/DND 갱신·INVISIBLE 미갱신·일단위 둔감화), FR-P11(1000명 OFFLINE 제외), FR-P15(viewport IntersectionObserver presence:subscribe + presence:update 소비 — S26 dead-write 해소), FR-P09(**partial** hoist=OWNER/ADMIN staff baseline). 마이그레이션 `20260601700000`(User.lastSeenAt + 복합 인덱스).
- **리뷰 fix-forward**(reviewer+security+perf+ui 4팀): correctness BLOCKER(per-page 그룹핑 50명초과 incoherent → authoritative 전체 그룹핑). security BLOCKER(DND→INVISIBLE lastSeenAt 누출 → bulkFor real/masked 플래그 + invisible-masked→null + WS wire projection 누출 방지). regression(useMembers 50cap → listAllMembers 완전화). contract(query-key qk 정합 → dispatcher invalidate 작동). cursor UUID/길이 검증, lastSeenAt 둔감화, 복합 인덱스, autoPipelining.
- 게이트: verify 19 + build 3종 + members-grouped int 13 GREEN. DS 무수정. 마이그레이션 PG16 up→down→up.
- carryover: email PII(선제존재), 커스텀 역할 hoist, MobileMembers parity, off-viewport stale dot, canStillObserve 캐시.

## ✅ S28 (커스텀 상태 만료/프리셋 + DND 수동/스케줄 + 알림 차단) — 완료

- FR-P04(구조화 커스텀 상태 emoji/text/expiresAt + timezone 프리셋 UTC 계산, 마이그레이션 `20260601800000`), FR-P17(lazy 만료 + 노출 경로 마스킹), FR-P05(DND 수동 + **알림 차단** dnd-gate at mention.received + thread.replied), FR-P06(DND 스케줄 auto-toggle + snapshot/restore + 자정걸침 carry).
- **리뷰 fix-forward**(reviewer+security+contract 3팀): BLOCKER(DND overnight 다음날 carry 누락 → (day+6)%7), security HIGH(preset 에러 입력반영 → 고정; 만료 customStatus 멤버목록/DM/broadcast 노출 → maskExpiredStatus + charset strip), MAJOR(수동 presence 변경 시 snapshot 클리어; thread.replied DND 게이트), contract(S28 타입 shared-types 이관 + MemberWithPresence emoji/expiresAt), GET dnd-schedule rate-limit, useDndSchedule refetchInterval.
- 게이트: verify 19(api 358·web 500) + build 3종 + status-dnd int 16 GREEN. DS 무수정. 마이그레이션 PG16.
- carryover: DST 프리셋 ±1h, DND timezone UI 변환(FR-P06 UTC분=정본, UI 변환 책임), D14 알림 전체, custom status/DND UI 배선(훅 dormant).

## ✅ S29 (검색 코어 — 권한필터 오라클방지 + 수식어 파서 + deleted 제외 + 정렬) — 완료

- FR-S04(권한필터 visibleChannelIds + 오라클방지 in:#private 비멤버→silent 0 + **per-result ACL 재검증** race-close), FR-S05(수식어 파서 from/in/has/before/after/during/is:pinned 복합 AND), FR-S08(ts_rank_cd 관련도/recent 토글), FR-S15(deletedAt IS NULL). 비정규화 hasLink/hasImage/hasFile 컬럼(마이그레이션 `20260601900000` + backfill). is:pinned=pinnedAt 재사용. DM 구조적 제외.
- **리뷰 fix-forward**(reviewer approve + security+perf+contract): security BLOCKER(per-result ACL 재검증 미구현 → rows.filter(visibleSet) race-close), MEDIUM(workspaceId/channelId/senderId/cursor UUID 검증 → 500 누출 차단, q 길이 500/modifier 64 DoS), hasAttachment deletedAt→finalizedAt 교정+테스트.
- 게이트: verify 19(api 395) + build 3종 + search int 21 GREEN. DS 무수정. 마이그레이션 PG16(비정규화 컬럼).
- carryover: perf(FTS OR ILIKE GIN 폴백·visibleChannelIds 캐시·ANY plan-cache·username lower() 인덱스·backfill 배치), web 검색 필터 UI(task-046 iter3), pin advisory-lock 500(별도).

## ✅ S30 (검색 결과 패널/카드/컨텍스트 + Jump + 페이지네이션 + 스레드답글 권한필터) — 완료 (2026-06-02, 이 세션)

- FR-S03(슬라이드인 결과 패널 `qf-search-overlay`, 우측 슬롯 MemberColumn 대체, 0건 `data-state=empty`+힌트), FR-S06(카드+전후 컨텍스트 회색줄 + **클릭→`?msg=` 점프**: MessageList/useMessages 에 `?msg=` 소비자 추가 — `resolveListFetchArgs(jumpMessageId)` around anchor 우선 + scrollToIndex + ~2s 하이라이트 펄스), FR-S07(컨텍스트 표시 + index-update 배너 `qufox.search.activity` + Redis `search:recent:{userId}` 최근검색), FR-S09(infinite 페이지네이션 20/100), FR-S10(스레드답글 In Thread 레이블 + 루트 excerpt, 루트 채널 가시성 검증).
- **4팀 적대적 리뷰**(reviewer/security/ui-designer/a11y) → fix-forward(`feature-implementer`):
  - **BLOCKER 보안 A1**: `neighborMessage` masked 분기가 messageId/createdAt 메타 누출 → 가시성 검사를 쿼리 **이전**으로 이동, 불가시 채널은 쿼리 없이 전 필드 null placeholder.
  - **HIGH 보안 A2**: `threadRootExcerpt` 루트 채널 가시성 미검증(시한폭탄) → `visibleIds` 인자 + `root.channelId` 검사, 불가시면 excerpt null.
  - **BLOCKER 기능 M2**: `?msg=` Jump 소비자 부재(헤드라인 무동작) → MessageColumn/MessageList around+scroll+highlight 소비자 신설.
  - **MAJOR M3**: index-update 배너 자기메시지 노이즈 → dispatcher 가 `authorId !== viewer` 일 때만 발화.
  - **a11y**: 카드 `aria-label`(접근명), 패널 열림 포커스, Esc 닫기, results `aria-live` + sr-only status, 최근검색 `<button>`, `<time dateTime>`/장식 aria-hidden/In Thread·masked aria-label.
  - **DS**: `qf-search-overlay` 70vh 클리핑 → `max-h-none rounded-none shadow-none` 오버라이드(DS 미수정). inert broken selector(`text-channel-ref`/`text-mention-strong`) 제거.
- shared-types `SearchContextMessage.messageId/createdAt` nullable(masked placeholder). 마이그레이션 없음(Redis-only recent).
- 게이트: `pnpm verify` 19 tasks GREEN(api 403·web 516) + 빌드 3종 + 신규 단위 9(masking 4·dispatcher 2·aroundReload jump 3). DS 무수정 확인.
- carryover: SearchInput 선존 broken Tailwind(`bg-bg-hover`/`bg-bg-elevated`/`bg-bg-panel`/`text-text`)·combobox ARIA → a11y/DS-cleanup. DS contrast(mark/accent/text-muted, tokens.css 필요) → DS-owner. 모바일 검색 패널 → mobile parity. recent 워크스페이스 scope(F-05)·search() visibleIds 이중계산(F-03)·pushRecent 성공후이동(F-04)·redis multi 파이프라인(L2) → perf/minor. 동일채널 out-of-window 점프 재로드 누락 → carryover. M1(채널전환 패널유지)=by-design(Discord식, Esc/닫기로 종료).

## ✅ S31 (검색 필터/수식어 자동완성/최근검색 서버삭제/치트시트/combobox/Ctrl+F) — 완료 (2026-06-02, 이 세션) — **D07-search 도메인 완료**

- FR-S01(치트시트 카드 — 0건 시 from:@alice/in:#general/has:image 칩 `qf-search-overlay__filters/__chip/__chip-key`), FR-S02(타이핑 수식어 감지 `suggestToken` → `GET /search/suggest` 인라인 자동완성 + has: 정적옵션, combobox ARIA 전면), FR-S11(서버+local recents 병합·상한 10 통일·개별/전체 삭제 `DELETE /search/recent?q=` 신규 Redis LREM/DEL + 낙관적 롤백), FR-S13(`searchQueryGate` — 수식어 유효성 기반 짧은쿼리 차단, 서버파서 정합), FR-S14(빈결과 힌트 예시 1줄), FR-S12(Ctrl/Cmd+F → 텍스트채널만 `in:#채널` 프리필, `!openModal` 가드, `searchPrefill`).
- 신규 순수모듈: `searchQueryGate.ts`/`suggestToken.ts`/`comboboxNav.ts`/`searchPrefill.ts`. 공유 hook `useRecentSearches`. shared-types `SearchSuggestResponseSchema`. BE `DELETE /search/recent`(JwtAuthGuard·@CurrentUser IDOR차단·길이상한 200·srecent rate-limit).
- **6팀 적대적 리뷰**(reviewer/security/contract/ui-designer/a11y/visual-regression) → fix-forward:
  - **보안 DoS**: `DELETE ?q=` 길이상한 없음 → LREM O(N·M) 남용 → 컨트롤러+서비스 200자 가드.
  - **a11y BLOCKER B-1**: `aria-controls` 가 실제 `role=listbox` 안 가리킴 → id 를 `<ul role=listbox>` 로 이동 + listbox 없는 분기 `aria-expanded=false`/controls 생략(dangling 제거).
  - **a11y BLOCKER B-2**: "더 보기" `<li+button>` 이 listbox content model 위반 → `<ul>` 바깥 이동.
  - **reviewer MAJOR1**: 게이트가 무효 수식어(`is:foo`/`has:video`/`before:nope`/`from:@`)를 modifier 오인 → FR-S13 무력화 → 서버파서 유효성과 일치(`isValidModifier`).
  - **reviewer MAJOR3**: 낙관적 개별삭제 롤백 없음 → 캐시+localStorage 스냅샷 복원.
  - a11y SHOULD: 드롭다운 aria-live status, 삭제후 refocus, 전체삭제 aria-label, 치트칩 aria-label, highlight 비색단서, In Thread 이중읽힘 제거, Esc 비-blur. DS: `z-dropdown`→`z-[var(--z-dropdown)]`, `text-xs`→토큰. contract: suggest limit 기본 6 통일.
- 게이트: `pnpm verify` 19 GREEN(api 409·web 583·shared-types 175·webhook 50) + 빌드 3종 + 신규 테스트(게이트 무효수식어 8·삭제 롤백·DELETE 과길이·combobox aria-controls→listbox·load-more 위치·searchPrefill). DS 4파일 무수정. 마이그레이션 없음.
- carryover: **MAJOR2 caret-aware 중간토큰 자동완성**(현재 마지막토큰 한정, 주석 정정) → 후속. a11y B-3(`qf-input:focus outline:none` = DS 전역의도)·M-4 contrast(text-muted on bg-hover 라이트 4.48:1) → **DS-owner**(불변). DS: qf-autocomplete\_\_item 재사용·qf-row-iconbtn·w-96/mt-0.5 → DS-cleanup. class-validator DTO 마이그레이션 → 후속. visual baseline(검색 드롭다운 스냅샷 부재) → task-048. NIT clamp-vs-wrap → 선택.

## ✅ S32 (D17 타이핑 인디케이터 — 송신/수신/Redis ZSET) — 완료 (2026-06-02, 이 세션)

- (핸드오프 추측은 "재연결/sync"였으나 PRD 정본상 **타이핑 인디케이터**였음 — UNDERSTAND 단계서 정정.) 기존 타이핑 인프라(S07~) 위 갭만 구현.
- **FR-RT-08**(서버): typing 이벤트 dot→colon 수렴(`typing:start/stop/update/batch`, 구 클라용 `client.on` dot forward), `TypingFanout`(node-local 타이머, ≥3명 시 2s `typing:batch` full-snapshot·<3 즉시 `typing:update`·0명 clear), 채널 fanout ≤10/s, **TypingService SET→ZSET**(member=userId·score=만료 epoch ms·now=redis TIME) per-user 독립 만료(종전 SET 전체키 TTL 리셋 stale 버그 수정). **FR-RT-09**(클라): dispatcher `typing:update`/`typing:batch` 구독, useTypingStore per-userId 10s TTL 타이머, formatTypingLabel(1명 "{n} 님이 입력 중…"·2명·≥3 "여러 명이 입력 중…"), MessageComposer TypingEmitter(첫입력·3s throttle·10s idle stop). **FR-RT-17**(P2): ZSET per-user TTL(PRD 문자열 per-key 대신 ZSET score — 동등 의미·KEYS 스캔 회피).
- **5팀 적대적 리뷰**(reviewer/security/contract/perf/a11y) → fix-forward:
  - **contract CRITICAL(4팀 합의)**: `TypingUpdatePayloadSchema` 가 실제 emit(`{channelId,typingUserIds}`)과 완전 불일치(`{userId,displayName,action}`) → 스키마 정렬 + update/batch 필드명 **`typingUserIds` 통일**(.max(3)) + events.spec 가드.
  - **perf R-1**: ping/stop hot-path 4→3 round-trip(validMembers 를 ping multi 에 병합, 중복 GC 제거).
  - **a11y A-01/02**: TypingIndicator `role=status aria-live=polite aria-atomic`(기존 WCAG 4.1.3 갭).
  - contract: TYPING_THROTTLE import(하드코딩 3 제거)·batch `.max(3)`·constants.spec 가드. reviewer: fanoutWindow 빈 항목 정리. security: typing 핸들러 safeParse(presence 패턴 일치). perf: MessageComposer 중복 emitter 제거.
- 게이트: `pnpm verify` 19 GREEN(api 428·web 603·shared-types 178·webhook 50) + 빌드 3종 + realtime int 9(typingUserIds·batch cap·per-user 만료·dot alias·disconnect·DM). DS 무수정. 마이그레이션 없음(Redis ZSET/Zod만).
- carryover: **security #1 stale `state.channelIds`**(refreshUserChannelIds add-only — kick/delete 후 미제거, workspaceIds 와 동일 선존 패턴) → **realtime state-sync 번들**(channel.member_removed/deleted 구독 정리). security #3 per-user 다채널 typing cap → hardening. perf R-2(redis TIME RTT→Lua/Date.now)·R-3(batch 경계 debounce)·R-6(부하측정 인프라). a11y A-03(말줄임표 SR)·A-04(typing bar 높이예약 CLS). reviewer C(batch 중 신규 typer 2s 지연=by-design). 멀티노드 batch 조정·presence.\* dot→colon rename(S10 WS-naming 번들).

## ✅ S33 (D04 스레드 코어 — 답글카운트 비정규화 + 삭제 placeholder) — 완료 (2026-06-02, 이 세션) — **마이그레이션**

- **FR-TH-01**(루트만 'Reply in thread' — `canStartThread` 순수함수, 답글/tmp-/삭제 차단), **FR-TH-02**(1-level depth 400 — 기존; RED 원인은 테스트의 이벤트 오선택이라 테스트 수정으로 GREEN), **FR-TH-15**(답글 커서 페이지네이션 — 기존 + **삭제 답글 placeholder**(deletedAt 필터 제거·content null)), **FR-TH-16**(채널 목록 threadMeta `replyCount`/`latestReplyAt` **비정규화 컬럼 직접 반환**, GROUP BY 집계 제거 + replyParticipants ≤5 bounded LATERAL).
- **마이그레이션** `20260602000000_s33_thread_reply_counters`: `Message.replyCount`(INT default 0)/`latestReplyAt`(timestamptz?) additive + backfill(비삭제 답글 COUNT/MAX `AT TIME ZONE 'UTC'`) + down.sql(DROP). **PG16 up→down→up 검증**(데이터 손실 0). write-path: 답글 send tx 루트 `replyCount+1`+`latestReplyAt=GREATEST(...)`, soft-delete `GREATEST(0,replyCount-1)`.
- **S05/FR-MSG-09 carryover 소진**: 답글보유 deleted thread-root 가 REST 목록에 placeholder(`("deletedAt" IS NULL OR "replyCount">0)`)로 유지(chip 노출). threads.int RED→GREEN.
- **5팀 적대적 리뷰**(reviewer/security/db-migrator/perf/contract) → fix-forward:
  - **보안 BLOCKER**: `toDto` 삭제 메시지가 `mentions`(+`editedAt`/`edited`) 미마스킹 → @멘션 대상 userId 누출(삭제 노출로 표면화) → 빈 값 마스킹. **authorId 는 유지**(Discord 일관·web 미렌더·채널ACL — 결정 문서화).
  - **MAJOR-1**: `latestReplyAt` last-writer-wins(동시 답글 과거값 덮어쓰기) → `GREATEST(COALESCE(...,-infinity), createdAt)` raw UPDATE.
  - **MAJOR-2**: 삭제 thread-root chip 클릭 404(deleted 미게이트) → chip·canStartThread `!deleted`.
  - **MAJOR-3+perf**: EXPLAIN 테스트가 실제 술어(`OR replyCount>0`)와 불일치(false-green) → 실제 쿼리로 갱신 + LATERAL 플랜 추가. **EXPLAIN ANALYZE 실측**(OR-filter·LATERAL 모두 Index Scan·sub-ms·Seq Scan 없음) → **인덱스 미추가(측정 기반)**.
  - db-migrator LOW(backfill `AT TIME ZONE 'UTC'` TZ 독립 + 9h drift 재현 입증)·contract(latestReplyAt→lastRepliedAt 매핑 주석).
- 게이트: `pnpm verify` 19 GREEN(api 428·web 613·shared-types 178·webhook 50) + 빌드 3종(6 tasks) + 마이그레이션 PG16 up→down→up + int(mentions 마스킹·GREATEST 동시성·chip 게이트·EXPLAIN 실제술어·placeholder). DS 무수정.
- carryover: **replyCount drift 재집계 job**·**FR-TH-17 DELETE 원자성/broadcast**·**FR-TH-03 아바타 렌더** → S34. hot-row lock 경합(비정규화 본질·sharded counter 후속)·recentReplyUserIds 삭제루트 노출(ACL 보호·수용)·listThreadReplies hasMore 과집계·TOCTOU orphan(막 삭제된 루트 답글). **pre-existing**: `messages.events.int.spec.ts` "archive guard" 1건 RED(채널 archive 의 SYSTEM_CHANNEL_ARCHIVED message.created 를 테스트가 0으로 가정 — S33 무관·verify 미포함) → archive 시스템메시지 반영해 단언 갱신 follow-up.

## ✅ S34 (D04 스레드 — 답글 tx 원자성 + reply bar + 자동구독) — 완료 (2026-06-02, 이 세션)

- **FR-TH-17**(POST/DELETE 단일 `$transaction` 원자성 + **재집계 Cron** `ThreadReplyCountReconciler` `@Cron(EVERY_HOUR)` drift-only(`replyCount<>actual`) + `@nestjs/schedule` 추가·`ScheduleModule.forRoot`), **FR-TH-03**(reply bar — Avatar primitive ≤5 스택 + replyCount + 상대시각 `formatMessageTime`), **FR-TH-07**(자동구독 — 스레드시작자·답글작성자·**@멘션 대상** ThreadSubscription upsert).
- **6팀 적대적 리뷰**(reviewer/security/perf/ui-designer/a11y/visual-regression) → fix-forward:
  - **BLOCKER tx-poisoning**: `subscribe` 가 findUnique+create(ON CONFLICT 아님) → 동시 답글 시 23505 → Postgres tx 전체 abort → `.catch` 가 JS 만 삼켜 commit 25P02 self-DoS. → raw `INSERT ON CONFLICT (userId,threadParentId) DO NOTHING` throw-free화(@멘션·authorId follow 양쪽 해소).
  - **perf CRITICAL**: orphan `SELECT FOR UPDATE` 가 루트 행 잠금 commit 까지 보유→인기 스레드 직렬화. orphan 무해(삭제루트 답글=비가시·카운트 `WHERE deletedAt IS NULL` 무영향) → **비잠금 findUnique 재검증**으로 교체(잠금 제거, narrow-race orphan 은 reconcile 정합).
  - **a11y BLOCKER**: chip aria-label 에 마지막 답글 시각 포함 + `lastRepliedAt` `<span>`→`<time dateTime title>`.
  - **DS HIGH**: MessageItem 중복 `colorFromSeed`+raw hsl 인라인 제거 → Avatar primitive 단일화.
  - reviewer reconcile heartbeat(drift 0 debug 로그)·security 차단유저 @멘션 자동구독 제외(양방향 BLOCKED).
- 게이트: `pnpm verify` 19 GREEN(api 435·web 620·shared-types 178·webhook 50) + 빌드 3종 + int 22(tx-poisoning 동시구독 정상·orphan findUnique 거부·차단유저 제외·DELETE가드·reconcile). **마이그레이션 없음**(S33 컬럼 재사용; @nestjs/schedule 는 dep 추가). DS 무수정.
- carryover: perf(@멘션 N-subscribe 배치·reconcile 대량 GROUP BY windowing·extraNames 렌더). a11y(**Avatar seed-color 팔레트 대비** hue 240/258/200 — app-wide Avatar 별도 pass·`.qf-thread-chip__count` `--accent` 대비 3.79~3.97:1 → **DS-owner**). visual(**DS baseline MD5 drift** `.task-040-ds-baseline.txt` 선존 → task-040 갱신·thread-chip visual baseline → task-048). security(subscribe ACL tx-外 TOCTOU + **N2 dispatcher 발송 전 READ 재게이트**·reconcile 멀티노드 분산락).

## ✅ S35 (D04 스레드 — Thread Panel 모바일 + isBroadcast + 스크롤/실시간 동기) — 완료 (2026-06-02, 이 세션) — **마이그레이션**

- **FR-TH-05**(모바일 ThreadPanel 전체화면 — app-layer 재사용, DS 무수정), **FR-TH-06**(isBroadcast "채널에도 공유" — **C-1 별도 SYSTEM_THREAD_BROADCAST 행** PRD 정본, 채널 타임라인 동시게시+excerpt 50자+레이블, `message.thread.broadcast` dot 이벤트), **FR-TH-18**(mount→최하단 스크롤 + jump btn; lastRead 초기스크롤은 S36 ThreadReadState 의존), **FR-TH-20**(thread reply→채널 threadMeta 즉시반영·message.deleted 양쪽 동기 changed-ref 2회렌더 방지·태블릿 독립스크롤).
- **마이그레이션** `20260602100000_s35_thread_broadcast`: `Message.isBroadcast Boolean @default(false)` additive + **partial index `Message_channel_broadcast_idx WHERE isBroadcast=true`**(rawList OR 가지 BitmapOr — EXPLAIN로 load-bearing 입증) + down.sql. PG16 up→down→up 검증.
- **8팀 적대적 리뷰**(reviewer/security/db-migrator/perf/contract/ui-designer/a11y/visual) → fix-forward:
  - **BLOCKER 체계적 누출**: C-1 broadcast 행(parentMessageId=root·비삭제)이 모든 "답글 의미" 쿼리에 누출 → **5경로**(reconciler 카운트·검색 중복히트·me-activity phantom·softDelete 카운터·aggregateThreadSummaries 참여자)에 `isBroadcast=false` 가드(audit가 reviewer 3 + 추가 2 발견).
  - **perf CRITICAL**: rawList OR partial index 무력화 → broadcast partial index 추가.
  - **보안**: aggregateBroadcastExcerpts/send 루트 excerpt를 channelId 스코프(cross-channel 누출 방어).
  - **a11y BLOCKER**: 모바일 ThreadPanel role=dialog/aria-modal·mount 포커스·닫힘 복귀·트랩·jump aria-live·jump focus-ring. broadcast aria-label/role. DS 토큰화(ease-out/120ms/qf-text-danger). 사소 a11y(back 레이블·이모지 aria-label·"개의 답글").
- 게이트: `pnpm verify` 19 GREEN(api 444·web 633·shared-types 183·webhook 50) + 빌드 3종 + 마이그레이션 PG16 up→down→up + int(broadcast 누출 3+2경로·channelId 스코프·threads 30·search 30). DS 무수정.
- carryover: **prod populated 테이블 인덱스 = `CREATE INDEX CONCURRENTLY` deploy-hook 필요**(현재 plain, 소규모 무해 — 운영 follow-up). security F-02(dispatcher parentExcerpt 검증)·F-05·F-07(차단작성자 excerpt 마스킹). nit-2(broadcast 본문 AST 렌더). `qf-message--system` 미정의 수식자·jump calc·composer auto-grow px·A-11 close 28px(DS-owner)·**MobileMessageSheet 전체 focus-trap**(선존). 모바일 safe-area composer(다음). `.env.prod.bak.*`=gitignored 해소.

## ✅ S36 (D04 스레드 unread + D09 — ThreadReadState/스레드 미읽/broadcast unread) — 완료 (2026-06-02, 이 세션) — **마이그레이션** + **사후리뷰 fix-forward**

- **FR-TH-11/RS-12**(스레드 unread **계산**(S11 튜플 패턴, isBroadcast=false·deletedAt 제외), denormalized unreadCount 컬럼은 S38), **FR-TH-12**(`POST /messages/:id/thread/ack` monotonic upsert + ThreadPanel ACK 디바운스), **FR-TH-04**(reply bar 미읽 dot — aggregateThreadSummaries 배치조인 hasUnread), **FR-TH-14**(broadcast 채널 unread +1·스레드 중복집계 금지·삭제 캐시 무효화), **FR-TH-18**(lastRead 초기 스크롤 — S35 seam 완성).
- **마이그레이션** `20260602200000_s36_thread_read_state`: ThreadReadState 테이블(userId,parentMessageId,lastReadMessageId?,lastReadMessageCreatedAt?,updatedAt; unique(userId,parentMessageId); FK CASCADE) + down.sql. PG16 up→down→up 검증.
- **⚠️ 프로세스 이탈**: 첫 implementer 가 **리뷰 단계 건너뛰고 머지+배포+prod DB 조회**까지 자체 수행(브리프 위반·[[feedback_subagent_no_merge_deploy]]). → main 2c6c77f 이미 배포된 상태에서 **사후 6팀 적대적 리뷰 실행 → fix-forward** 로 복구.
- **사후 리뷰 BLOCKER fix-forward**(`fix/s36-fix-forward` 083d121):
  - **BLOCKER-1(prod 라이브 버그)**: 채널 unread COUNT 5경로(summarize·workspaceTotals·unreadCountFor·mentionCountFor·advanceAllVisible)가 **스레드 답글까지 산입** → roots-only 술어(`parentMessageId IS NULL OR isBroadcast=true`) 추가. 답글마다 채널 배지 +N(유령 unread)·broadcast +2 → +1 교정. int 테스트 `toBe(2)→toBe(1)` 정정 + 음성테스트(답글/멘션 채널 불산입).
  - 보안: archived 채널 thread ack/get → CHANNEL_ARCHIVED 거부. DELETE 메시지 rate-limit.
  - perf: broadcast 무효화 fire-and-forget(softDelete hot-path 분리). UI: dot 4px→8px.
- 게이트: `pnpm verify` 19 GREEN(api 444·web 635·shared-types 188·webhook 50) + 빌드 3종 + int(채널 unread roots-only·답글/멘션 불산입·broadcast +1·archived 거부·S11 무회귀 14). DS 4파일 무수정.
- carryover: a11y(lastRead 후 첫미읽 focus·실시간 unread aria-live·dot dual-encoding=낮음). perf(EXISTS heap-fetch·BitmapOr·ack IP rate 선존). DS-owner(opacity/border-width 토큰·`qf-thread-chip__dot`/`qf-thread-jump-btn` 정식클래스·ThreadPanel toLocaleTimeString→formatMessageTime). **denormalized unreadCount + Threads 탭(FR-TH-09/10) + notificationLevel/lock(FR-TH-08/13) → S38.**

## ✅ S37 (D01 메시징 — 편집이력 팝오버 + 복사/permalink) — 완료 (2026-06-02, 이 세션)

- **FR-MSG-08**(편집이력 팝오버 — 서버 기존 + 프런트 `getEditHistory`/`useEditHistory`/`EditHistoryPopover`, (수정됨) 뱃지 트리거, qf-menu 재사용·신규 DS 0), **FR-MSG-17**(복사 "메시지 복사"·**contentPlain 평문**·permalink 링크), **FR-MSG-18**(permalink `?msg=` 점프 — S30 인프라 + 삭제/없음 toast). **마이그레이션 없음**.
- **6팀 적대적 리뷰(머지 전)** → fix-forward(`fix/s37-fix-forward` 6422b36):
  - **BLOCKER-1**: `?msg=` 점프가 존재하는 window-밖 메시지(같은채널/캐시채널)에 **거짓 not-found toast + 점프 무동작**(query key 가 jumpMessageId 미포함) → **one-shot `useJumpAround` 쿼리**(별도 캐시·gcTime0) 분리 + 4분기(존재→스크롤·로딩→대기·around성공→seed후스크롤·진짜404/삭제→toast 1회).
  - **BLOCKER-2**: `copyText` 가 읽는 `contentPlain` 이 DTO/WS payload 부재 → 항상 content(markdown) 폴백(평문 미충족) → **MessageDtoSchema + toDto + MessageCreated/UpdatedPayload 에 contentPlain 추가**(contentPlainV2 ?? contentPlain·삭제 마스킹·마이그레이션 불요).
  - a11y(팝오버 role=region·tabIndex=-1·focus-ring·role=status·time aria-label·aria-haspopup 중복제거·divider --border-strong), 보안(편집이력 staleTime 5s/gcTime0/key+wsId·message.updated 무효화), DS(sideOffset 상수).
- 게이트: `pnpm verify` 19 GREEN(api 449·web 658·shared-types 191·webhook 50) + 빌드 3종 + 신규테스트(useJumpAround·toDto contentPlain 실DTO·편집이력 캐시·팝오버 a11y). DS 4파일 무수정.
- **D01 메시징 도메인 완료.** carryover: opacity/gap-0.5/text-xs 매직넘버·모바일 touch target·qf-message\_\_body font override → DS-cleanup. visual baseline(task-040/048). permalink PRD 형식(옵션 A deviation). MANAGE_MESSAGES(D12). continuation 메시지 (edited) 뱃지 부재(선존). MessageThreadBroadcastPayload contentPlain 미추가(broadcast copy 비노출·content 폴백 무해).

## ✅ S38 (D04 스레드 마무리 — Threads 탭/구독레벨/lock) — 완료 (2026-06-02, 이 세션) — **마이그레이션** — **D04 도메인 완료**

- **FR-TH-08**(벨 드롭다운 ALL/MENTIONS/OFF — `ThreadSubscription.notificationLevel` enum 마이그레이션 + `PATCH /users/me/threads/:id/subscription` upsert + fanout OFF/MENTIONS 필터), **FR-TH-09**(사이드바 Threads 탭 `GET /users/me/threads` 단일쿼리·cross-workspace ACL fold·미읽우선·excerpt 80), **FR-TH-10**(`POST /users/me/threads/read-all` DISTINCT ON bulk monotonic), **FR-TH-13**(`PATCH /messages/:id/thread/lock` OWNER/ADMIN + reply 403 THREAD_LOCKED + `Message.threadLocked` 마이그레이션 + thread:lock:changed 실시간).
- **마이그레이션** `20260602300000_s38_thread_notif_level_lock`: `enum ThreadNotificationLevel` + `ThreadSubscription.notificationLevel`(default ALL·인덱스) + `Message.threadLocked`(default false). IF NOT EXISTS 가드. PG16 up→down→up(enum DROP 순서 역증명).
- **8팀 적대적 리뷰(머지 전)** → fix-forward(`feat/s38-d04-threads-final` 04f0c97). **★최고위험 cross-workspace Threads ACL = NO LEAK**(readBitVisibleSql 5단계 fold cross-workspace 정확 재현, 강퇴/비공개/DM 제외 — S29 오라클 수준 확인):
  - reviewer MAJOR: OFF 가 @멘션 미억제(OFF==MENTIONS) → mention.received OFF 게이트. 벨 항상 ALL(미하이드레이션) → thread GET 에 viewerNotificationLevel + 벨 seed.
  - security MEDIUM: markAllRead ACL 필터 누락 → visible CTE. contract HIGH: thread:lock actorId 스키마 누락 → 추가.
  - a11y 5 BLOCKER: 벨 menuitemradio/aria-checked·트리거 aria-haspopup/현재레벨·lock:changed aria-live·mark-all aria-busy·잠긴 composer aria-disabled+readOnly. 보안 LOW(archived)·migration 가드·DS(py-1.5/text-text/헤더 버튼그룹)·a11y 사소.
- 게이트: `pnpm verify` 19 GREEN(api 449·web 658·shared-types 195·webhook 50) + 빌드 3종 + 마이그레이션 PG16 up→down→up + int 22(OFF 멘션·벨 hydration·markAllRead ACL·archived·actorId). public DS 4파일 무수정.
- carryover: **perf**(listMine LATERAL unread COUNT ×N·markAllRead DISTINCT ON Sort → **denormalized unreadCount 컬럼 또는 구독 cap 후속**·fanout Promise.all minor). **manual ALL 구독자 fanout source 아님**(recipients=author+repliers, listFollowers 미사용 — task-014-B fanout-source 확장 후속). DS-owner(`qf-menu__item[data-highlighted]` focus·`__close` focus-visible·excerpt text-muted 대비 3.8:1). visual baseline(task-040 drift + S38 신규 UI 스냅샷 → task-048).

## ✅ S39 (D05 반응 코어 — toggle/20한도/reaction:updated/GET) — 완료 (2026-06-02, 이 세션)

- **FR-RE01**(POST **toggle**·낙관+롤백·**`reaction:updated` full-replace**·debounce 300ms), **FR-RE02**(20종 한도 — 부모 Message `FOR NO KEY UPDATE` 직렬화 + COUNT(DISTINCT) + 409 `REACTION_LIMIT_REACHED`), **FR-RE03**(added/removed → **단일 `message.reaction.updated`** + outbox-to-ws subscriber 가 `aggregateReactionDetails`+users[5] enrichment), **FR-RE04**(`GET /messages/:id/reactions` users[5]), **FR-RE06**(삭제 메시지 404). **마이그레이션 없음**(MessageReaction 기존).
- **5팀 적대적 리뷰(머지 전)** → fix-forward(9fa75d3). ★20종 동시성(FOR NO KEY UPDATE) SOUND·이벤트 rename COMPLETE:
  - **MAJOR per-viewer me sticky-ghost**: `byMe=inUsers||prevByMe` latch → 신규 `reaction-intent.ts`(뷰어 의도맵 TTL 10s) + dispatcher `intent!==null?intent:inUsers`(latch 제거). debounce **net-intent**(burst 净의도만 POST·짝수=no-op 미전송) + **burst-start 1회 롤백 스냅샷**.
  - security MEDIUM: archived 채널 반응 → CHANNEL_ARCHIVED. contract: ReactionSummary(byMe)↔ReactionUpdatedReaction(users) 주석·GET 계약테스트·`reaction:updated` seq 옵셔널(라이브 와이어 미포함). a11y ReactionBar(aria-pressed 상태라벨·aria-haspopup·count aria-live).
- 게이트: `pnpm verify` 19 GREEN(api 449·web 668·shared-types 198·webhook 50) + 빌드 3종 + int 11(toggle·20한도·archived 409·GET users[5]·삭제404). DS 무수정.
- carryover: **EmojiPicker 구조적 a11y**(role=menu→dialog·tab roles·focus trap·포커스이동 — **선존 컴포넌트** → 전용 picker a11y 태스크). perf(enrichment 재조회 dedup·`(messageId,emoji,createdAt)` 인덱스·FOR NO KEY UPDATE 경합 → measure-first). DS-owner(qf-reaction--me 색단독+대비·터치타깃 22px). security LOW(차단유저 reactor username·stale WS room). visual baseline.

## ✅ S40 (D05 반응 확장 — 반응자 목록/REACT 권한/타인제거/일괄삭제) — 완료 (2026-06-02, 이 세션)

- **FR-RE05**(`GET /messages/:id/reactions/:emoji/users` cursor 페이지 — `(date_trunc('ms',createdAt), Reaction.id)` 튜플 키셋·limit 50/max 100·reactor 모달 무한스크롤), **FR-RE07**(반응 추가 시 override **ADD_REACTIONS(카탈로그 0x20) DENY → 403** — API enum 미수정, **ADR-4 fold** base→roleAllow→roleDeny→userAllow→userDeny 로 userAllow>roleDeny), **FR-RE08**(`DELETE …/:emoji/users/:userId` OWNER/ADMIN 타인제거·자기허용·MEMBER 타인 403), **FR-RE09**(`DELETE …/reactions` body-less OWNER/ADMIN 일괄삭제 + `reaction:cleared` fanout). **마이그레이션 없음**.
- **6팀 적대적 리뷰(머지 전)** → fix-forward(cfd67e0). 2 BLOCKER + a11y/DS/perf:
  - **★FR-RE07 ADR-4 fold 버그(security HIGH·메인루프 검증)**: 1차 구현이 `denyMask` 만 OR-fold(allowMask 무시) → (ROLE deny + USER allow) 오차단. `PermissionMatrix.fold` 권위 우선순위로 정정(allowMask 분리·userAllow>roleDeny) + int 4케이스(USER deny 403·ROLE deny 403·**ROLE deny+USER allow 허용**·override 무 허용).
  - **★FR-RE05 cursor id-space 버그(범위확장 fix-forward)**: 1차 구현이 cursor 에 User.id 인코딩·정렬/비교는 Reaction.id → 동일 ms 충돌 시 중복(flaky 통과). tie-breaker 를 **Reaction.id** 로 통일(응답 users[].id 는 User.id 분리). opaque cursor 라 contract 무드리프트.
  - **★DS BLOCKER**: `text-text-primary`(tailwind 색키 부재·런타임 색 소실) → `text-foreground`. a11y: 무한스크롤 `role=status`/`aria-live`·`aria-busy`→`<ul>`·`<ul> aria-label`·username null 폴백·공유 Dialog `aria-modal="true"`·⋯버튼 opacity→색토큰(대비)·aria-label 이모지중복 제거. dispatcher reactor-users 캐시 무효화(reaction:updated invalidate·cleared removeQueries). FR-RE05 GET rate-limit 120/min.
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 449·web 673·shared-types 203·webhook 50) + 빌드 3종 + reactions int **18**(FR-RE07 a/b/c/d·FR-RE08·FR-RE05·FR-RE09). DS 4파일·settings.json 무수정.
- carryover: **FR-RE08/09 모더레이터 UI 배선**(reactor 모달 제거버튼·메시지 메뉴 일괄삭제 — 백엔드/contract 완료·client api fn 존재). listEmojiUsers **표현식 인덱스**`(messageId,emoji,date_trunc('ms',createdAt),id)`(perf 마이그레이션). canAddReaction↔resolveEffective **중복 override 조회**(D12 권한수렴 묶음). **API enum↔카탈로그 0x20**(MANAGE_CHANNEL vs ADD_REACTIONS) 정합(D12). Dialog 명시 닫기버튼(SRS-1). focus-ring 대비(MOD-1 DS토큰). qf-reaction 터치타깃 24px(MIN-2 DS). 모바일 qf-m-sheet 변형. EmojiPicker 구조적 a11y overhaul(S39 이월).

## ✅ S41 (D05 커스텀 이모지 업로드/관리 + 커스텀이모지 반응) — 완료 (2026-06-02, 이 세션)

- emojis 모듈이 이미 상당부분 존재(presign/finalize/list/delete + web manager/Context/Picker prop). S41 갭 해소: **FR-EM01/RC20**(presign+finalize 업로드·**webp 추가**·**서버 리사이즈 없음**·256KB HEAD+**매직바이트 재검증**), **FR-EM02**(cap 100·Workspace 행 `FOR NO KEY UPDATE`+`ON CONFLICT DO NOTHING`·**409 `EMOJI_WORKSPACE_LIMIT`**), **FR-EM03**(목록 `{...,aliases:[],url}`), **FR-EM04**(삭제 본인/OWNER/ADMIN·MinIO hard delete·`emoji:deleted`), **FR-EM06**(마이그레이션 `MessageReaction.customEmojiId` FK **SetNull** + 커스텀이모지 반응(validateEmoji 워크스페이스 스코프 분기)+ ReactionBar img/`[삭제된 이모지]` placeholder). `emoji:created/deleted` outbox→workspace room fanout. ErrorCode 정비(`INVALID_FILE` 422).
- **사용자 결정**: 이미지 **서버 리사이즈 없음**(256KB HEAD가 가드·GIF 애니 보존·네이티브 의존 0·PRD sharp 128×128 이탈=carryover). 버킷 **공유 `qufox-attachments`/`emojis/`** 유지(전용 qufox-emoji=인프라 carryover).
- **7팀 리뷰**(reviewer/db-migrator/contract 완료 + **security/perf/ui/a11y 는 Anthropic 529 과부하 지속으로 메인루프가 직접 검증**) → fix-forward(메인루프 직접). reviewer ★finalize 매직바이트 재검증(getObjectRange 16B+matchesMagic+불일치 삭제+PUT ContentType 고정) **방어**·cap-100 **건전**·aggregateReactions S39/S40 **바이트 shape 무회귀**·validateEmoji **워크스페이스 스코프** 확인. db-migrator throwaway up→down→up+SetNull 실데이터 **PASS**.
  - **fix-forward(메인루프)**: ★**낙관 깜빡임 HIGH** — 자기 토글이 payload url 부재로 살아있는 커스텀이모지를 "[삭제된 이모지]"로 깜빡임 → ReactionBar 가 `customEmojis` 팩에서 `:name:`→url 직접 해석(`customUrlByToken`)·진짜 삭제만 placeholder + 테스트 2건. contract drift: web `CustomEmoji.aliases?` 추가.
  - 직접검증: rate-limit(presign/delete enforce·finalize는 presign 키 의존)·시크릿(diff의 `POSTGRES_PASSWORD:'qufox'`는 Testcontainers throwaway·prod 아님)·DS(qf-emoji-custom dead class+inline px=선존 패턴·DS-owner carryover)·a11y(img alt·칩 aria-label·placeholder 텍스트대안 OK)·perf(presign 종류당≤20/메시지·요청간 동일이모지 재서명→캐시불가=carryover).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 455·web 675·shared-types 203·webhook 50) + 빌드 3종 + emoji int 9 + reaction int(S39/40 회귀 포함). **마이그레이션 customEmojiId(reversible·SetNull)**. DS 4파일·settings.json 무수정.
- carryover: **reviewer MAJOR**(삭제→동명 재업로드→재토글 시 stale NULL 행이 re-point 안 됨·`ON CONFLICT DO UPDATE` 또는 테스트 — narrow edge). emoji.created/deleted **비-tx outbox**(at-most-once·self-heal)·S3 delete 실패 시 객체 orphan(orphan-gc). presign **캐시불가**(공개 url/전용 버킷 연계)·canMemberUpload 토글·**WorkspaceEmojiConfig**·**CustomEmojiAlias 별칭 CRUD(FR-EM05→S42)**·quickReactions·UserEmojiPreference·sharp 128×128·GIF 50프레임·qf-emoji-custom DS 정의·EmojiPicker 구조적 a11y. **S41 security/perf/ui/a11y subagent 재실행**(529 회복 후 보강 가능·핵심은 직접 커버됨).

## ✅ S42 (D05 이모지 별칭 + 사용자/워크스페이스 선호·퀵리액션) — 완료 (2026-06-02, 이 세션) — **마이그레이션(3모델)** — **D05 도메인 완료**

- **FR-EM05**(별칭 CRUD — `POST/DELETE /workspaces/:wsId/emojis/:id/aliases`·OWNER/ADMIN 생성·생성자/관리자 삭제·이모지당 10개·name+alias 양쪽 충돌검사 409 `ALIAS_LIMIT`/`ALIAS_CONFLICT`·CustomEmoji 행 FOR NO KEY UPDATE+ON CONFLICT 직렬화·`emoji:alias_updated` fanout), **FR-EM07**(파서/자동완성 별칭 연동 — CustomEmojiContext byName 에 alias 등록·canonical 보호·parseContent 무수정), **FR-PK01**(`GET /emoji-picker-data` 통합·GET 멱등), **FR-PK02**(자동완성 `:` 3+ 유니코드+커스텀+별칭 혼합·최대 10), **FR-PK03**(`PUT /me/emoji-preferences` UserEmojiPreference upsert·skinTone1-6/quick≤3/recent≤36), **FR-PK04**(`PATCH /workspaces/:wsId/emoji-config` OWNER/ADMIN·**canMemberUpload 배선**(default false·S41 ADMIN-only 보존·true 시 MEMBER presign/finalize 허용)).
- **마이그레이션 3모델**(reversible·db-migrator throwaway up→down→up+Cascade PASS): `CustomEmojiAlias`(@@unique[ws,alias]·FK Cascade)·`UserEmojiPreference`(userId unique)·`WorkspaceEmojiConfig`(workspaceId unique·canMemberUpload default false).
- **7팀 적대적 리뷰(머지 전)** → fix-forward(6cdf209). 2 시정 BLOCKER/HIGH:
  - **★BLOCKER finalize 게이트 비대칭**(reviewer+security): presign 만 assertCanUpload·**finalize 미게이트** → finalize 도 `assertCanUpload(role)` 호출(MEMBER·canMemberUpload=false→403 int).
  - **★HIGH EmojiPicker curatedIndex 크래시**: 피커 열린 채 specialTabs 변동 시 `EMOJI_CATEGORIES[curatedIndex]` 범위초과 `undefined.emojis` throw → clamp+tab reset+회귀테스트.
  - MED/LOW: DELETE alias 형식검증·DTO 빈문자 차단(`@MinLength(1,{each})`). a11y 신규UI: 별칭+버튼/삭제버튼 aria-label·alias 에러 aria-invalid+describedby+role=status·퀵반응 role=group/aria-label·최근그리드 aria-label.
  - 검증된 SOUND: cap-100 concurrency·me prefs IDOR(userId from JWT)·picker-data ACL·마이그레이션·canMemberUpload presign 게이트. contract "list aliases 미조회"=**위양성**(line293 include 확인).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(web 692·emoji unit 33) + 빌드 3종 + int(finalize 게이트 403/200·별칭·prefs·config·Cascade). DS 4파일·settings.json 무수정.
- carryover: **reviewer MAJOR** 별칭↔이모지 name TOCTOU(동시 생성 시 공존·클라 canonical-wins 완화·교차테이블 락 필요). **EmojiPicker 구조적 a11y overhaul**(role=menu→tablist·탭 role=tab/aria-selected·focus-visible — A-3/B-2·S39 이월). DS-owner(라이트 danger-400 대비·× 터치타깃·**qf-emoji-custom DS 정의**+inline px 48/40/160 제거). **perf**(picker-data↔custom-emojis 이중 fetch·picker 오픈마다 presign N≤100·**recentEmojis 컴포저 자동완성 미연결**=기능갭). cap-race 테스트·중복 React key.

## ✅ S43 (D02 채널 마무리 — 카테고리 접기/즐겨찾기/채널 뮤트 UI) — 완료 (2026-06-02, 이 세션) — **마이그레이션(UserChannelFavorite)** — **CH-16 defer**

- **FR-CH-14**(카테고리 접기/펼치기·localStorage `{wsId}:category:{catId}:collapsed`·기본 펼침·chevron 회전), **FR-CH-15**(즐겨찾기 — `UserChannelFavorite` 마이그레이션·`POST/DELETE/PATCH position /workspaces/:wsId/channels/:chId/favorite`·`GET /me/favorites`·ChannelAccessGuard·calcBetween fractional·FavoritesSection 사이드바 최상단·옵션B refetchOnWindowFocus), **FR-CH-17**(채널 뮤트 UI — **백엔드(MutesService/Controller·useMutes·sidebarRowState) 이미 완비**·컨텍스트 메뉴 duration 15m/1h/3h/8h/24h/무기한+해제·useSetChannelMute·뮤트 회색 text-muted+bell-off·멘션 배지 유지). **FR-CH-16(개인 사이드바 섹션·P2) defer**(별도 슬라이스·2모델·복잡 DnD).
- **마이그레이션 UserChannelFavorite**(userId/channelId FK Cascade·@@unique·@@index[userId,position]·reversible·db-migrator throwaway up→down→up+Cascade PASS).
- **6팀 적대적 리뷰(머지 전)** → fix-forward(9bb9353). MAJOR+MED+a11y:
  - **★MAJOR addFavorite P2002 미캐치 → 500**(멱등 위반·sibling ChannelsService.create 는 캐치): catch P2002 → 기존 행 반환(멱등)+병렬 int. **MED moveFavorite anchor 미존재 silent append → FAVORITE_NOT_FOUND 404**. self-ref anchor 400. MeFavoritesController 명시 가드. a11y 신규UI: 뮤트 duration 그룹레이블(aria-label "뮤트 N"+opacity-50→토큰)·FavoritesSection/카테고리 section aria-label·카테고리 aria-controls·CollapseArrow 버튼내부·DefaultSection ▾→chevron 아이콘.
  - 검증 SOUND: 즐겨찾기 IDOR(JWT userId·ChannelAccessGuard CHANNEL_NOT_VISIBLE 403·cross-ws·move 본인만)·마이그레이션·DS(아이콘 실재·토큰).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 475·web 711·shared-types 203) + 빌드 6/6 + int favorites 5(병렬 멱등·anchor 404·CHANNEL_NOT_VISIBLE). DS 4파일·settings.json 무수정.
- carryover: **★사이드바 키보드 a11y(pre-existing·HIGH)** — 채널행 Link tabIndex=-1 키보드네비 불가·dnd-kit role=button 중첩·KeyboardSensor 부재+aria-roledescription 허위(DnD 슬라이스부터·FavoritesSection 복제) → 전용 사이드바 키보드/DnD a11y 태스크(전역 dnd-kit/Link 재작업·회귀위험). DS-owner(muted hover 라이트 4.48:1<4.5·qf-row-iconbtn 18px<24 WCAG2.2). **FR-CH-16**(개인 사이드바 섹션·P2 별도). mutes shared Zod 스키마(pre-existing). favorites position normalize escape·다기기 실시간(옵션A).

## ✅ S44 (D06 멘션·알림 — MENTION_EVERYONE override 게이트/@here online/mention:new) — 완료 (2026-06-02, 이 세션) — 마이그레이션 0

- **FR-MN-01**(@username→Message.mentions[].userId·WS **`mention:new`** 정렬·here 필드), **FR-MN-02 + FR-MN-16**(@everyone/@here **MENTION_EVERYONE override 집행** — `resolveMentionEveryone` ADR-4 5단계 fold·카탈로그 0x80·MEMBER override-allow→허용·OWNER override-deny→차단·S40 FR-RE07 패턴), **FR-MN-02 @here online/idle 필터**(presence·INVISIBLE 제외), **FR-MN-04**(자동완성 멤버+@everyone/@here — S18·@role은 S45 defer). 마이그레이션 0(MentionRecord 미도입 — Activity Inbox S46).
- **4팀 적대적 리뷰(머지 전)** → fix-forward(5b5abb5). BLOCKER+MAJOR×2+contract+MINOR:
  - **★BLOCKER edit broad fanout 누락**: update 가 게이트만·`resolveBroadMentionRecipients` 없어 편집 @everyone 추가 시 fanout 0 → update 도 broad fanout(**before.mentions 스냅샷 diff 로 신규 추가분만 알림**·중복방지). **★MAJOR @here graceful-degrade 역전**(Redis 전역 장애 시 전원 누락) → `Promise.allSettled` 전역실패 시 full-set over-notify. **★MAJOR/perf resolveMentionEveryone 무조건 실행** → `hasBroadMentionSignal` 로 broad 신호 있을 때만(멘션 없는 send +1 RTT 제거). **contract** mention:new `here` 필드(dispatcher 타입+캐시+safeParse+REST me-mentions). **MINOR** 토스트 copy 완화(override-allow 멤버 전송됨). **0x80 dead-bit 문서화**(PIN_MESSAGE 집행 미사용 grep 확인·MENTION_EVERYONE 재사용 안전·오라벨 테스트 0x02→실제 0x80 정정).
  - 검증 SOUND: ADR-4 fold·gate boolean 리팩터·INVISIBLE presence 제외·mention:new room 격리.
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 490·web 717) + 빌드 3종 + int mention-gate 9(override fanout·edit broad·dedup·@here 장애 fallback) + fold 12. 마이그레이션 0. DS 4파일·settings.json 무수정.
- carryover: **0x80 D12 수렴**(MENTION_EVERYONE 카탈로그 vs PIN_MESSAGE enum 분리 — 현재 PIN 집행 미사용이라 무해). **perf**: override findMany 3중 중복(D12)·@everyone workspaceMember **200명 cap 부재**(S45)·@here 3N Redis bulk pipeline(S45)·broad fanout 50명 cap 부재(S45). **unread @here offline 카운트**(JSONB 모델·전원 카운트 vs online-only push 불일치·MentionRecord S46 정합). **@role 자동완성+ROLE fanout·@channel fanout**(S45). MentionRecord/Activity Inbox(S46). snippet replay TTL(LOW). 사이드바 키보드 a11y(S43).

## ⏸ S45 (D06 fanout SLO/ROLE/@channel — FR-MN-03/19/21) — **사용자 결정으로 전체 보류** (2026-06-02)

- UNDERSTAND 결과 S45 는 **BullMQ 비동기 워커 도입 + 커스텀 Role 엔티티 신설**(ChannelPermissionOverride.principalId 권한 스킴 파급·D12) + MentionRecord 테이블을 요구하는 대형 인프라/도메인 확장. `project_direction_pivot`(검증/안정성 선회·parity 추격 중단)과 상충해 **사용자에게 분기 제시 → "건너뛰기" 선택**. FR-MN-03/19/21 = todo 유지.
- **재방문 시**: BullMQ in-process 워커(A-1·docker-compose 무변경·기존 Redis 공유) + Role 테이블(mentionable) + MentionRecord + @role 파싱/fanout + rate-limit(분당5·버스트10) + VIEW_CHANNEL 재검증 + @here 200 cap/bulk presence pipeline + `evals/tasks/mention-fanout-slo.yaml`. 3청크(인프라/파싱·fanout/SLO·eval) 분할 권장. 상세 스펙은 이 세션 S45 UNDERSTAND 산출물 참조.
- **S44 carryover 미해소(열린 채)**: @everyone/@here 무제한 fanout(200 cap 부재)·@here per-send 3N Redis. 사용자가 "나중에 재방문" 수용.

## ✅ S46 (D06 알림 설정/레벨 — NotifLevel 3계층/뮤트/cron) — 완료 (2026-06-02, 이 세션) — **마이그레이션(NotifLevel enum+UserSettings+ServerNotificationPref+UserChannelMute.level/isMuted+인덱스2)**

- **FR-MN-05**(글로벌 NotifLevel ALL/MENTIONS/NOTHING — UserSettings·`GET/PATCH /me/settings/notifications`·기본 MENTIONS), **FR-MN-06**(서버 오버라이드 ServerNotificationPref·뮤트기간 15분~영구·suppressEveryone/RoleMentions), **FR-MN-07**(채널 오버라이드 UserChannelMute.level·카테고리 일괄·null=상속), **FR-MN-08**(뮤트 — isMuted 축·배지/미읽 숨김·muteUntil cron 만료). 3계층 fold(채널>서버>글로벌)·fanout 게이트 연동(send+edit·batch N+1 방지).
- **7팀 적대적 리뷰(머지 전)** → fix-forward(aab37ba). **5 BLOCKER + HIGH/MED**:
  - **★shouldNotifyMention 시맨틱**(메인루프 브리프 오지시 정정): MENTIONS 에서 broad(@everyone/@here) **기본 알림·suppressEveryone opt-out**(Discord 정합·종전 무조건 skip+suppress dead 였음) → suppress 게이트 연동.
  - **★카테고리 일괄 IDOR**(security): putCategoryChannels workspaceId 미필터 → 타 ws categoryId 채널ID 열거 → workspaceId 스코프 + N+1 배치.
  - **★level-only→영구뮤트**(security): mutedUntil=null 이 영구뮤트/레벨전용 양의 → `{level:ALL}` 채널 영구차단 → **UserChannelMute.isMuted 컬럼 신설**(backfill·S43 mute 소비처(filterMutedRecipients·useMutes·sidebarRowState) isMuted=true 동기화).
  - **★DS 미등록 클래스**: bg-bg-elevated→bg-bg-surface·bg-bg-panel→bg-bg-subtle·text-text→text-foreground(런타임 색 소실).
  - **a11y**: tablist aria-controls/tabpanel·MuteToggle 접근명/live·section/radio describedby·선택카드 시각화. + getChannel now 주입·dndSchedule.days .max(28)·cron 부분인덱스·unmute level 보존.
  - db-migrator PASS(enum DROP 순서·throwaway up→down→up). contract: NotifLevel 3자 정합.
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 516·web 721·shared-types 203) + 빌드 3종 + int(notif-levels 18·mention-gate 9·dm/notif-pref 24). 마이그레이션 throwaway+backfill 검증. DS 4파일·settings.json 무수정.
- carryover: **a11y B-02 라디오카드 border 대비**(border-subtle=divider·다크 3:1 토큰 부재 — **DS-owner 새 경계토큰**)·tab Arrow/select focus/time 마크업(a11y polish). **suppressRoleMentions 실연동**(@role=S45). `notification:prefs_updated` 미배선(TODO 가시화)·DS 네이티브 checkbox→qf-switch/설정 모바일 qf-m-\*(polish)·멀티노드 cron 락·JwtAuthGuard 일관성·keywords 스캔(S45). 기존 UserNotificationPreference(TOAST/BROWSER) 역할 정리(후속).

## ✅ S47 (D06 Activity Inbox — badge resync/favicon/Inbox 패널) — 완료 (2026-06-02, 이 세션) — 마이그레이션 0

- **FR-MN-13**(Activity Inbox 패널 — role=complementary·tablist All/Mentions/Threads/DMs·탭별 empty·qf-skel 200ms·클릭 fallback·무한스크롤·기존 /me/activity 재사용·**MentionRecord 미도입**), **FR-MN-14**(배지 — favicon canvas dot/숫자·document.title·서버아이콘 mute-aware), **FR-MN-20**(`GET /me/notification-badges`·`notification:badge_update` WS·visibilitychange/reconnect resync·ACK 우선 stale-ignore). MentionRecord 는 S45 묶음·S47 은 /me/activity UNION 경로로 우회.
- **6팀 적대적 리뷰(머지 전)** → fix-forward(6789a5e). **9 BLOCKER/HIGH**:
  - **★패널 도달불가**(toggle 미배선·死코드) → MessageColumn 벨버튼 toggleActivityInbox 배선. **★ACK 교차시계 버그**(클라 Date.now vs 서버 timestamp) → read_state:updated 에 serverTimestamp 추가·동일 서버시계 비교. **★me-activity `OR TRUE`**(private ACL 가드 사문화·선존) 제거. **★badges ACL 2-step→canonical 5-step fold**(readBitVisibleSql 공유헬퍼 `common/acl/read-visibility.sql.ts` 추출·unread.service 6곳 재사용). **★badgeFor 단일ws 쿼리**(멘션마다 전-ws 집계 N회 제거). **markRead IDOR**(activityKey 소유권 검증)+cursor Invalid Date. **DM 탭 네비**(dm-open)+**mark-read inbox 낙관**. **DS qf-skeleton→qf-skel**. **a11y**(roving tablist·actorName 접근명·skeleton aria-busy·tabpanel tabIndex).
  - MAJOR-2(WorkspaceNav 배지): 이미 mute-aware+mute-agnostic 폴백 — FR-MN-14 부합·무수정.
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(web 761·api 517·shared-types 203) + 빌드 3종 + int 신규 7(OR TRUE/badges ACL/markRead IDOR/badgeFor)+badges 3+unread-acl 7. 마이그레이션 0(actorName=join·serverTimestamp=payload). DS 4파일·settings.json 무수정.
- carryover: perf polish(badges correlated subquery·useFaviconBadge selector·resync debounce). a11y C-1/2(카운트배지 aria-hidden·모두읽음 describedby)·**C-3 qf-tabs\_\_item 터치타깃 44px(DS-owner)**. markAll>50(서버 선존). MentionRecord/@role(S45). ActivityPage(전체화면·선존) qf-btn--subtle/bg-bg-app(선존·S47 미변경).

## ✅ S48 (D06 DND Snooze/timezone/키워드 설정/suppress UI — 사용자 결정 partial) — 완료 (2026-06-02, 이 세션) — 마이그레이션 0

- 사용자 결정으로 **인프라 불필요 자체해소 범위만**(키워드 스캔=MentionRecord/S45·VAPID push 는 defer). **FR-MN-11**(DND Snooze — `isDndSuppressed` dndUntil WS 게이트+Snooze UI 30분/1h/2h/내일/Custom·query-time 만료·7일 max), **FR-MN-12**(dndSchedule timezone — built-in Intl·DST·UTC fallback), **FR-MN-09**(suppress 토글 UI·게이트 S46 완료), **FR-MN-10 partial**(keywords max25 검증+태그 UI·**스캔 보류**=MentionRecord/S45). 마이그레이션 0(컬럼 S46 존재).
- **6팀 리뷰** → fix-forward(44385a3). reviewer/security/contract/ui **APPROVE/0 BLOCKER**(dndUntil 3사이트·timezone DST·keywords·DS 클래스 전부 SOUND). **accessibility 5 BLOCKER+6 SERIOUS**(신규 컨트롤) → 시정: DndSnoozeControl radiogroup/aria-live 고정/aria-expanded·KeywordsInput aria-live 에러+aria-invalid·ServerNotifSettings C-01 label-mismatch(aria-label 제거→labelledby)+group·NotificationSettingsPage tabpanel focus/th scope. + security(keywords Zod 형태상한 복원·dndUntil 7일 max)·perf(Intl.DateTimeFormat module 캐시)·Korean 에러.
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 541·web 796·shared-types 203) + 빌드 3종 + int(dndUntil 억제·keywords·7일max). 마이그레이션 0. DS 4파일·settings.json 무수정.
- carryover: **DS-owner**(qf-btn/checkbox `:focus-visible`·text-muted on bg-surface 대비 4.2:1·키워드삭제 터치 28px). **tablist Arrow roving(E-02 — S46/S47/S48 반복·전용 tab-a11y 태스크)**. 네이티브 checkbox→qf-switch(C-02)·qf-banner/badge 재사용·radiogroup 이중라벨(D-01)·atLimit disabled. **FR-MN-10 키워드 스캔(MentionRecord/BullMQ·S45)·VAPID push(S45 인프라 묶음).**

## ✅ S49 (D06 마무리 — 뮤트 목록 UI) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-MN-17**(뮤트 목록 UI — `GET /me/mutes` channelName/workspaceName join+삭제채널 제외·`GET /me/server-mutes` 신규·MuteListSection 채널/서버 카드·남은시간·개별 해제·기존 DELETE 재사용). **FR-MN-15(VAPID push)·FR-MN-18(desktop/mobile 레벨) defer**(VAPID 인프라·S48 사용자 결정 일관·desktop/mobile 은 push 에서만 의미). 마이그레이션 0(UserChannelMute·ServerNotificationPref 재사용).
- **5팀 리뷰** → fix-forward(58879dc). reviewer/security/contract/a11y. **ui-designer "3 BLOCKER"(bg-bg-surface/bg-bg-subtle/border-border-subtle 미등록)=전부 FALSE POSITIVE**(config 에 `'bg-subtle'`/`'bg-surface'`/`'border-subtle'` 키 prefix 포함 등록·유효·메인루프 tailwind config 로 직접 판정·무수정). 시정: **reviewer MAJOR**(1:1 DM 뮤트가 raw `dm:` 슬러그 노출 → 상대 username/fallback)·**contract HIGH**('3h' MuteDurationKey drift → shared-types enum 추가)·**a11y BLK**(unmute aria 컨텍스트·announce 재공지 rAF+aria-atomic·빈상태 통지·`<time>` 무기한·`#` aria-hidden/DM 미표시).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 549·web 821·shared-types 203) + 빌드 3종 + int 8(1:1 DM displayName null). 마이그레이션 0. DS 4파일·settings.json 무수정.
- carryover: **security low(선존)** — 권한 회수 후 private 채널명 잔존(resolveEffective 크로스체크)·setMute ChannelAccessGuard 부재·iconUrl presign(앱 전역)·뮤트목록 페이지네이션 부재. a11y(per-item isPending·badge aria·touch). reviewer NIT(server 카드 level/iconUrl 미표시·now 갱신 타이머). VAPID push(FR-MN-15/18). **D06 핵심 완료** — 잔여(FR-MN-03/19/21 S45·10스캔 S45·15/18 VAPID)는 전부 인프라 의존.

## ✅ S50 (신규 도메인 D10 — 메시지 핀) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-PS-01**(시스템 메시지 핀 불가 + **멤버 허용** 권한 — pin/unpin 이 isAdminOrOwner 게이트 제거·WorkspaceMemberGuard+ChannelAccessGuard(READ) 로 READ 통과 멤버 전체 허용·**PIN_MESSAGE 0x80 비트 미사용**=role/READ 게이트라 MENTION_EVERYONE 무충돌)·**FR-PS-02**(핀 시 SYSTEM_PIN 시스템메시지 같은 tx 자동삽입 + `channel:pin_added`/`channel:pin_removed` wire 이벤트)·**FR-PS-03**(PinPanel 슬라이드인 + 채널헤더 핀 카운트 배지 + `GET .../messages/pins/count`)·**FR-PS-04**(HARD_PIN_CAP=55→HTTP 423·soft 50 toast·advisory lock 직렬화)·**FR-PS-06**(소프트삭제 cascade — 핀된 메시지 삭제 시 같은 tx 핀 자동해제 + pin_removed)·**FR-PS-14**(idempotent 재핀/재해제). 마이그레이션 0(Message.pinnedAt/By·SYSTEM_PIN 기존). ChannelPin 독립모델·라우트 리네임(/channels/:id/pins)·FR-PS-05/07/15 = S51 이후.
- **6팀 리뷰**(reviewer/security/contract/performance/ui-designer/accessibility) → fix-forward(이 커밋 동봉). **reviewer APPROVE·contract 0 drift·performance 0 critical**(전 발견 저빈도 nit). **검증 후 기각**: 보안 HIGH-1(OWNER 비-DM private 핀=task-027 escape hatch 의도설계·DM 만 격리·S50 신규 아님)·MEDIUM-2(insertPinSystemMessage authorId=actorId=createSystemMessage:1874 포함 전 시스템메시지 공통 관례)·DS BLOCKER-2(`qf-message--system` main 기존). **시정**: 보안 HIGH-2(pin/unpin `update` WHERE 에 channelId 동봉·심층방어·Prisma5 extended-where)·DS BLOCKER-1(PinPanel `text-text`→`text-foreground`·런타임 색 손실 실위반)·**a11y**(핀 버튼 aria-pressed→aria-expanded+aria-controls+조건부 (0) 라벨·배지 aria-hidden·Esc 닫기·닫힘 시 트리거 포커스 복귀·점프/해제 버튼 aria-label 작성자+발췌 컨텍스트·로딩 sr-only·`고정 시각:` sr-only·빈목록 aria-live·해제버튼 대비 text-muted→text-secondary).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(web 829) + **pins-s50 int 9/9 GREEN**(실DB·channelId-on-update 검증·38.8s — 단독 필터 실행. ⚠️ 전체 `test:int` 는 invites-rate-limit 의 ephemeral 포트 Redis ECONNREFUSED 로 hang=환경성·S50 무관). 마이그레이션 0. DS 4파일·settings.json 무수정.
- carryover: **D12(0x80 분리)=S51 선결**(pin moderator-restrict 토글이 PIN_MESSAGE 비트 집행 시). **DS-owner**(light-mode text-muted 4.25:1·28px 터치·qf-message--system 정식화). **cross-cutting**(SYSTEM_PIN unread +1·검색 노출=전 시스템메시지 공통). **a11y polish**(시스템메시지 이력 role=status·SYSTEM_PIN 발췌). perf nit(username 조회·listPins select·lock_timeout). DM 핀 서버 미차단(프론트만 숨김).

## ✅ S51 (D10 — 핀 권한 채널 토글 + 개인 저장함) — 완료 (2026-06-03, 이 세션) — 마이그레이션 1(reversible)

- **FR-PS-05**(핀 권한 채널 토글 — `Channel.memberCanPin` Boolean·**PIN_MESSAGE 0x80 비트 미사용**=컬럼 직접검사·MENTION_EVERYONE 무충돌·S40/S44 선례. MessagesController.assertCanPin: memberCanPin=false & !ADMIN/OWNER → 403. 토글은 ADMIN+ 채널 PATCH)·**FR-PS-07**(개인 저장함 SavedMessage — `/me/saved` POST 저장(idempotent·READ ACL·500 한도 422)·DELETE·GET 커서목록 요약조인·count·3탭 뷰·사이드바 진입점·툴바 북마크 토글)·**FR-PS-15**(SYSTEM_PIN 채널 멤버 삭제·원본 핀 유지). 마이그레이션 1: `Channel.memberCanPin`+`SaveStatus` enum+`SavedMessage` 테이블(reversible up/down, PG16 up→down→up 검증). reminder/PATCH 상태이동=S52/S53 defer.
- **6팀 리뷰** → fix-forward(이 커밋 동봉). **★BLOCKER(reviewer+security 일치)**: `saved.service.assertMessageVisible` ACL 이 (a) `c.isPrivate=false` 단락의 워크스페이스 멤버십 미검사 → 비멤버가 타 워크스페이스 공개채널 메시지 저장/열람(크로스워크스페이스 IDOR), (b) `OR wm.role='OWNER'` 가 DM 에도 적용 → 비참여 OWNER 가 DM 저장. **통합 ACL 로 교체**(워크스페이스 채널=멤버십 필수, DM=USER override만, OWNER 단락 비-DIRECT만 — ChannelAccessGuard 정합) + **회귀 int 테스트 추가**(12/12). **검증 후 기각**: `qf-message--system`(main 기존). **시정**: security MED(list `c.deletedAt IS NULL` 삭제채널 누출 차단)·DS BLOCKER(`text-text`→`text-foreground` SavedItem·SystemMessage)·contract HIGH(MessageItem 핀 게이트 `OWNER||ADMIN||(MEMBER&&memberCanPin)` — S50 멤버 핀 UI 미노출 갭 해소)·a11y(SavedView 탭 roving tabindex+화살표+aria-controls+tabpanel id+빈탭 aria-live·SavedItem/SYSTEM_PIN 삭제 aria-label 컨텍스트·SavedEntry 배지 aria-hidden+버튼 label·핀 토글 aria-describedby).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(web 836) + **s51 int 12/12 GREEN**(실DB·ACL 통합·신규 크로스워크스페이스 IDOR 회귀 포함). 마이그레이션 PG16 up→down→up. DS 4파일·settings.json 무수정.
- carryover: **DM 핀 서버 미차단**(프론트만 숨김·S50 1c)·**list 권한회수 후 재검사 부재**(S49 FINDING-1 계열·크로스컷팅)·a11y polish(ChannelSettingsPage privacy 토글 role=switch 미적용 선존·설정 nav aria-selected→aria-current·저장 토글 성공 SR announce M-05·N-01/02/03)·perf nit(assertMessageVisible correlated subquery·soft-delete updateMany 항상 실행·커서 id 인덱스 미포함)·GET 무율제한(LOW)·`qf-message--system` DS 정식화(DS-owner). **D12 0x80 분리(S61~S64) 여전히 잔여**(이번엔 컬럼으로 회피).

## ✅ S52 (D10 — 저장 메시지 마무리: 탭 이동 + 북마크 초기화) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-PS-08**(저장 항목 탭 이동/완료/영구삭제 — `PATCH /me/saved/:savedMessageId {status}` 임의전이·본인스코프 404·500한도 미적용·삭제원본 허용. 영구삭제=기존 DELETE 재사용. FE SavedItem 인라인 완료체크 + "⋯" 드롭다운(탭별 가용액션)·useUpdateSavedStatus 낙관적 이동)·**FR-PS-12**(삭제원본 잔존 — S51 messageDeletedAt 마스킹 위에 액션 UI 가 삭제항목에도 렌더)·**FR-PS-13**(툴바 북마크 채움 초기화 — `POST /me/saved/status-bulk {messageIds}` → 저장된 messageId 집합·어느 status 든·useInitSavedStatus 가 MessageList 에서 배치 seed). 마이그레이션 0(SaveStatus·status 컬럼 S51 존재). **★PATCH=savedMessageId·DELETE=messageId 의도된 비대칭.**
- **6팀 리뷰** → fix-forward(이 커밋 동봉). **reviewer APPROVE·contract 0 drift·ui-designer 0 위반.** **★perf SERIOUS 시정**: useInitSavedStatus 가 key=전체 messageIds 라 **WS 메시지 수신마다 전체 배치 재 POST**(활성채널 50~100 id 반복) → **미seed id 만 증분 조회**(신규 1개 → POST 1개·신규 없음 → 무호출). **security/perf MED**: status-bulk read-tier rate-limit(120/60s·유일 방어선). **security/contract LOW**: updateStatus 채널-soft-delete fallback 이 `messageDeletedAt=now()`(메시지삭제 아님·계약위반)·`channelId=messageId`(오염) → 실제값/null·실제 channelId 로 시정(msg 부재 시 404). **a11y BLOCKER**: B-01/B-02(완료체크·"⋯" aria-label 에 채널명+발췌 컨텍스트)·B-04(이동 성공 토스트=SR 피드백)·N-02(탭 카운트 aria-label).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(web 849) + **s52 int 13/13 GREEN**(실DB·전이/IDOR404/bulk 본인스코프/한도미적용/비UUID400). 마이그레이션 0. DS 4파일·settings.json 무수정.
- carryover: **DS-owner**(a11y M-01 `.qf-menu__item:focus-visible` 배경·M-02 `.qf-tabs__item:focus-visible` 인디케이터 — components.css 필요). **a11y polish**(M-03 저장해제 SR 피드백·N-01 완료/⋯ 버튼 간격·B-03 aria-pressed 는 액션버튼이라 미적용). **reviewer nit**(MessageList `'tmp-'` 리터럴→OPTIMISTIC_PREFIX 상수·enforce-after-validate 순서). DM 핀 정책·list 권한회수 재검사(S49 계열)·S53 리마인더=BullMQ.

## ✅ S53 (D10 — 저장 리마인더 + BullMQ in-process) — 완료 (2026-06-03, 이 세션) — 마이그레이션 1(reversible)

- 사용자 **BullMQ 전체 구현 greenlight**([[project_bullmq_greenlight]]). **FR-PS-09**(리마인더 설정/발화 — PATCH reminderAt → BullMQ delayed job·Processor 발화 시 `user:reminder_fire`+`user:saved_updated` emit·토스트+Notification)·**FR-PS-10**(스누즈 10분 PATCH /snooze·취소 배선 4곳 unsave/COMPLETE/null/softDelete cascade)·**FR-PS-11**(놓친 리마인더 `GET ?overdueReminder=true` 배너). 마이그레이션 1: SavedMessage += reminderAt/reminderFiredAt/snoozedUntil/note + partial index(CONCURRENTLY 미사용·PG16 up→down→up). `@nestjs/bullmq@10.2.3`+`bullmq@5.34.10`.
- **BullMQ 구조**: `apps/api/src/queue`(@Global QueueModule·전용 IORedis maxRetriesPerRequest:null·Redis 공유·jobId=savedMessageId 멱등·reminderFiredAt dedup·WorkerHost graceful shutdown·DND bypass). 순환 회피(@Global 주입·QueueModule→RealtimeModule 단방향).
- **6팀 리뷰** → fix-forward(이 커밋 동봉). **reviewer/security/contract/perf/ui/a11y — 머지 차단 BLOCKER 없음.** ★BullMQ connection 분리·jobId 멱등·발화 userId DB-출처·cancel 배선 4곳 전부 정확 확인. 시정: **reviewer M1**(overdue 캐시 `['saved','overdue']` 미무효화 → 발화/스누즈/saved_updated 3곳 invalidate — FR-PS-11 회귀)·**security FINDING-3**(reminderAt 미래+1년상한 검증 — 즉시발화 폭주 차단)·**FINDING-1/2**(발화·snooze update WHERE userId)·**channelId null**(messageId 위장 제거·payload nullable)·**ui**(토스트 info→warning·overdue 배너 qf-banner\_\_icon)·**a11y**(bell 배지 role=img+발화후 stale 제거·radiogroup aria-labelledby·radio accent-color·datetime aria-invalid·배너 aria-live 중복 제거).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(web 864) + **saved-reminder int 9/9 GREEN**(실DB+실Redis·enqueue/발화+WS/dedup/snooze/cancel/skip/오프라인). 마이그레이션 PG16 up→down→up. DS 4파일·settings.json 무수정.
- carryover: **DS/primitive a11y**(Dialog X버튼·포커스복귀·plain-action toast live-region[Toast S24]·light-mode info-400/warn-400 대비[tokens.css·DS-owner]·터치타깃·SettingsOverlay 닫기 aria-label). **perf**(overdue 쿼리 partial-index 불일치 — per-user≤500 bounded·SAVED_LIMIT 상향 시 인덱스 추가). **SavedUpdatedPayload snoozedUntil/note 미동봉**(dispatcher refetch 라 무해). User.timezone /me/profile 미노출(브라우저 tz 폴백·S28 후속). 토스트 단일 action 슬롯(완료/무시는 저장함). VAPID push 보류 일관.

## ✅ S54 (D11-attachments 핵심 — presigned 세션/rate-limit/검증 강화) — 완료 (2026-06-03, 이 세션) — 마이그레이션 1(reversible·3변경)

- **FR-AM-03**(채널 nested `upload-url`/`complete` 3단계 + AttachmentUploadSession + presignPost Policy Conditions·기존 /attachments/\* deprecated 유지)·**FR-AM-04**(100MB·메시지당 10개)·**FR-AM-05**(확장자 블랙리스트 + zip↔jar/apk 교차검증)·**FR-AM-06**(MIME 화이트리스트 확장·SVG 차단·magic-byte 8192B + PDF/MP4/audio)·**FR-AM-27**(rate-limit 3종 — 15m60/1m10/동시20)·**FR-RS-13**(`PATCH /users/me/settings` markAsReadMode + deprecated alias)·**FR-P13**(S48 dndUntil 위에 dndSnoozeMinutes 1개 추가·중복 없음). 마이그레이션 1(Attachment 11컬럼 확장·AttachmentUploadSession·markAsReadMode + 2 enum·additive·PG16 up→down→up). `@aws-sdk/s3-presigned-post@3.1032` 추가.
- **4팀 리뷰**(reviewer/security/contract/perf — backend라 ui/a11y 불요). **★보안 슬라이스 — fix-forward**: **C-01(CRITICAL TOCTOU)** complete 인터랙티브 tx + `updateMany(completed=false)` 원자 가드(동시 complete 첨부 이중생성 차단)·**H2(rate-limit sticky lockout)** check-then-add(거부 요청 미카운트·self-DoS 제거)·**H-01** 이중확장자 모든 세그먼트 검사(malware.exe.txt)·**H1/M-01/M-02** 첨부 다운로드 `Content-Disposition: attachment`(인라인 stored-XSS 차단·emoji/avatar inline 보존). **검증 후 처리**: L-01(dndSnooze 10080 경계 reject는 implementer 의도·테스트가 고정 → clamp 되돌림·carryover).
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 597·web 864) + **s54 int 16/16 GREEN**(실PG16+실Redis·S3 스텁·rate-limit 429·TOCTOU·magic·dndSnooze cap). 마이그레이션 PG16 up→down→up. DS 4파일·settings.json·웹 무수정.
- carryover: **security**(H-02 presignPut 폴백 서버측 크기 미강제 — MinIO bucket quota·S55·primary 는 presignPost / H-03 AV스캔 부재 READY 즉시 — 스캐너 도입 S55+·PENDING-forever 면 다운로드 불가라 현 설계 유지 / H-04 storageKey 응답 노출 — client 가 이미 보유한 컴포넌트라 무해). **soft cap**(동시세션 20 TOCTOU·1m10 이 bound). **perf**(complete N(≤10) 직렬 왕복·premature opt). **contract**(web AttachmentLite 7신규필드 미정렬 — forward-compat 안전·S55 사용 시 정렬). **L-01**(dndSnooze 실효 최대 10079분). orphan GC·WorkspaceSetting·Channel.fileUploadEnabled = S55.

## ✅ S55 (D11-attachments — orphan GC·업로드 정책·다운로드 프록시) — 완료 (2026-06-03, 이 세션) — 마이그레이션 1(reversible)

- **FR-AM-29**(orphan GC — BullMQ repeatable `attachment-gc` 일일 cron·`linkedAt IS NULL AND createdAt<24h` + 만료 세션 정리·배치 500·실패격리·무진행 가드·magic 재검증 BLOCKED 마킹 후 객체+행 삭제)·**FR-AM-17**(download/thumbnail 프록시 — 매 요청 isPrivate DB 재조회+READ 재검증·public 302(60s)·private `node:stream` pipeline 스트리밍·위험 MIME attachment+nosniff)·**FR-AM-20+FR-CH-18**(WorkspaceSetting.maxFileSizeBytes/blockedExtensions·Channel.fileUploadEnabled/maxFileSizeBytes·정책 병합 channel→ws→전역 하드캡·admin PATCH /workspaces/:id/settings + Channel PATCH)·**FR-AM-23/26**(S54 기구현 확인·GC BLOCKED 마킹 신규). 마이그레이션 1(WorkspaceSetting·Channel 컬럼·partial index 3종·additive·PG16 up→down→up). linkedAt 정합(pre-link null·send 시 now). 신규 의존성 0.
- **4팀 리뷰**(reviewer/security/contract/perf — backend라 ui/a11y 불요). **★fix-forward**: **GC-1(BLOCKER·reviewer+security 일치)** orphan selector `{messageId:null}` 가 grace 없어 방금 complete 한 pre-link 첨부를 즉시 삭제(데이터 파괴) → `linkedAt IS NULL AND createdAt<24h` 단일 조건 + 회귀테스트 실제 shape 교정·**스트리밍 CRITICAL(perf)** `pipe`→`node:stream/promises` pipeline(client abort 시 MinIO 소켓 누수 차단)·**마이그레이션 MAJOR** WorkspaceSetting TIMESTAMP(3)+updatedAt 무default(migrate diff 드리프트 제거)·**contract** WorkspaceSettingResponse/ChannelSchema maxFileSizeBytes positive/상한.
- 게이트(메인루프 독립 재실행): `pnpm verify` **19/19 GREEN**(api 609·web 864) + **s55 int 18/18 GREEN**(실PG16+실Redis·GC aged/fresh·프록시 public/private/비멤버403·정책·세션정리). 마이그레이션 PG16 up→down→up + TIMESTAMP(3) 검증. DS·settings·웹·handoff 무수정.
- carryover: **perf**(프록시 download 매요청 4-RTT — Attachment+Channel include 합치기 opt·private 스트리밍 hot-path 시·GC orphan partial-index 가 가변 cutoff 미포함 heap recheck·complete magic N 직렬). **security**(public 302→MinIO 응답 nosniff 부재=init-minio.sh 인프라·text/\* inline 정책·S54 H-02 quota/H-03 AV 잔존). int teardown SIGSEGV flake(결과 무관). emoji GC 셸 보존·web AttachmentLite 정렬=S56(FE).

## ✅ S56 (D11-attachments 프런트엔드 — 업로드 UI/미리보기) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-AM-01/21**(3 진입점: +버튼 input·드래그앤드롭 오버레이·붙여넣기·`qufox.composer.addFiles` 채널게이트 이벤트)·**FR-AM-02/22**(Preview Tray — 썸네일/파일카드·alt입력·spoiler·제거·재시도·진행률바)·**렌더**(skel/img+spoiler blur/audio/file card·다운로드는 S55 프록시 `/attachments/:id/download`). **★web↔S54 신규 API 연결**(useAttachmentUpload 3단계 upload-url→XHR presignPost/PUT 진행률→complete·기존 deprecated /presign-upload 제거). AttachmentLite 로컬 인터페이스→shared-types 캐논 import. 다운로드/미리보기는 S55 프록시 Bearer 필요 → 인증 fetch→Blob objectURL 경유. 마이그레이션 0.
- **6팀 리뷰**(ui-designer+a11y 포함) → fix-forward(eb1a7d6). **★ui-designer BLOCKER 10건 전부 FALSE POSITIVE**(`bg-bg-surface`/`border-border-subtle`/`text-text-muted` — config 가 `'bg-surface'`/`'border-subtle'`/`'text-muted'` prefix 키 등록·기존 51파일 사용·무수정·DS-designer 반복 FP). **시정**: **reviewer MAJOR-1**(부분실패 전송 시 failed 첨부 silent 유실 → failedCount 전송게이트 + ready 만 제거·failed 보존)·**MAJOR-2**(width/height 미populate→CLS inert → addFiles 이미지 디코드)·**perf CRITICAL**(objectURL 채널 재진입 재fetch → 모듈 LRU 캐시 100 + in-flight dedup)·perf(진행률 throttle·TrayCard memo)·**a11y BLOCKER**(터치 18→qf-btn--icon 28·진행률/드래그 aria-live·spoiler aria-pressed 제거+포커스이동+미공개 aria-hidden·tray ul label·file input sr-only)·contract(ATTACHMENT_MIME_REJECTED 토스트)·security(다운로드 경로구분자 제거).
- 게이트(메인루프 독립 재실행): `pnpm verify` GREEN — 전 패키지 개별 통과(web **927**·api 609·shared 203·webhook 50). **(NAS OOM-killer 가 bulk verify 의 api+web 동시 실행서 web 프로세스를 죽이는 아티팩트 발생 — web 단독 재실행으로 927 GREEN 확인.)** 마이그레이션 0. DS 4파일·settings·handoff 무수정.
- carryover: **DS-owner**(a11y B-06/B-07 라이트테마 `--danger-400` #F87171 2.77:1·`--accent` 4.23:1 흰배경<4.5:1 — tokens.css 대비 조정). a11y polish(M-02/03/05·N-01/03). perf(onFiles useCallback benign·React.memo 추가분). **★NAS OOM**: bulk `pnpm verify` 가 api+web 테스트 동시 실행 시 메모리 초과로 web 프로세스 killed 빈발 → 패키지 단독 재실행으로 검증(인프라 메모).

## ✅ S57 (D11-attachments — 전송 상태기계 + 세션복구 + 썸네일 skip) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-AM-24**(전송 상태기계 — ready→SENDING(낙관적 objectURL)→CONFIRMED(프록시 URL·revoke)/FAILED·complete 지수백오프 3회/30s·expiresAt<10s on-demand refresh·objectURL revoke CONFIRMED+FAILED 양쪽)·**FR-AM-28**(sessionStorage 세션복구 — presign 등록·complete/remove 해제·mount leftover 토스트)·**FR-AM-18**(★사용자 결정 "스킵 — 원본 CSS 다운스케일" — Sharp/서버썸네일/워커 **미도입**·[[feedback_no_server_media_resize]]·complete READY 즉시·thumbnailKey null·CSS max-width 다운스케일). 마이그레이션 0.
- **4팀 리뷰**(reviewer/contract/ui-designer/a11y) → fix-forward(0382e96). **★ui-designer 0 위반**(FP 전부 올바르게 기각 — S56 교정 효과). **시정**: **reviewer MAJOR-2**(더블전송 re-entrancy → completeAndCollect 동기 in-flight 래치)·**MAJOR-1**(백오프 중 채널전환 stale complete+타이머 누수 → generation 카운터 bail + trackedSleep cleanup)·**MAJOR-3**(reset sessionStorage 미정리 false 토스트 → reset 정리)·**HIGH-1**(confirmed previewUrl 401 → null)·**HIGH-2/3**(refresh stale now + 부분실패 sessionStorage 누수 → item별 fresh now + 새 세션 collector 정리)·**a11y 4 BLOCKER**(aria-atomic·sending/confirmed div aria-hidden·locked 버튼 DOM제거→disabled+포커스보존·aria-busy·aria-valuetext).
- 게이트(메인루프 독립 재실행): web 단독 **950 GREEN**·typecheck exit 0·빌드 GREEN(FE 전용·api/shared/webhook 무변경). 마이그레이션 0. DS·settings·handoff 무수정.
- carryover: **DS-owner**(S56 B-06/07 라이트테마 `--danger-400`/`--accent` 대비 — tokens.css). a11y polish(A-04 렌더지연 이론적·A-09 말줄임표). **FR-AM-18 Sharp 서버썸네일 영구 보류**(사용자 결정·CSS 다운스케일로 대체·대역폭 이슈 시 재논의). NAS OOM(verify 단독실행).

## ✅ S58 (D11-attachments 프런트엔드 — 이미지 모자이크 그리드) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-AM-07**(단일 이미지 인라인 max-width **550px** — 기존 400px 수정)·**FR-AM-08**(비디오 다운로드 카드 — S54 FileCard 기구현·무변경 확인)·**FR-AM-09**(동일 메시지 2장+ → 모자이크 그리드 1/2/3/4/5+·`ImageMosaicGrid.tsx`·Tailwind grid·6장+ 5번째 셀 "+N" 오버레이)·**FR-AM-25**(PENDING/PROCESSING `qf-skel` + `attachment:processing_done` WS 핸들러). 마이그레이션 0.
- **★라이트박스는 S59**(FR-AM-10/11/12/19/30) — S58 은 인라인 그리드·표시까지만. 그리드 셀에 `onImageOpen?(index)` optional prop 만 마련(S59 연결점·현재 미연결 clickable=false).
- **★`attachment:processing_done` WS = forward-compat only**: 백엔드 emit **미추가**(Sharp 서버썸네일 영구보류·[[feedback_no_server_media_resize]]·complete 시 즉시 READY). `packages/shared-types/src/events.ts` 에 `WS_EVENTS.ATTACHMENT_PROCESSING_DONE` + `AttachmentProcessingDonePayloadSchema`(status READY|BLOCKED·thumbnailKey nullable) 추가, dispatcher 핸들러가 `['messages',*,chId]` 캐시에 attachmentId 있으면 processingStatus/thumbnailKey patch·없으면 no-op(safeParse 가드). 서버가 후처리 파이프라인 도입 시 emit 만 켜면 됨.
- **4팀 리뷰**(reviewer/contract/ui-designer/accessibility) → fix-forward(8651be4). **contract 0 위반**(WS 계약·status enum 단일출처·forward-compat 전부 PASS). **ui-designer 0 위반·FP 0**(`bg-bg-surface` 류 유효 재확인). **reviewer approve**. **시정**: reviewer **M1**(BLOCKED/FAILED 이미지가 정상 셀 경로로 fetch 시도 → fetch 회피 + "차단된 파일"/"처리 실패" 전용 표시·단일은 `ReadyImageAttachment` 분리로 Hooks 규칙 준수)·a11y **B-03**(+N 오버레이 font-semibold→**bold** large-text 대비)·**B-04/B-05**(이미지 로드실패 `role="alert"`)·**H-01**(빈 altText `?.trim()||originalName` 폴백)·**H-02**(+N 가린 이미지 `aria-hidden`+alt="")·**M-02**(그리드 `role="group"` aria-label)·**M-03**(스켈레톤 `aria-busy`)·**M-01**(루트 `<li>`→`<div role=group>`·호출부 li 래핑)·**P-03**(ul aria-label)·**m1/MINOR-1**(그리드 `w-full`·spoiler 셀 채움).
- 게이트(메인루프 독립 재실행): shared-types build+204·**web 단독 986 GREEN**·typecheck exit 0·빌드 GREEN(FE+shared-types·api/webhook 무변경). 마이그레이션 0. DS·settings·handoff 무수정.
- carryover: **DS-owner B-01**(`--danger-400` 라이트 흰배경 2.77:1·오류텍스트·기존 ImageAttachment 동일 전역패턴·tokens.css·= S56 B-06 이월)·**B-02 = FALSE POSITIVE 기각**(`bg-bg-surface`=tailwind.config 매핑 유효). **S59 이월**: **H-03/M-04**(clickable img 키보드 role — 라이트박스 연결 시 button 래퍼). a11y polish(P-01 alt 품질·P-02 스켈레톤 라벨 세분). reviewer m2(PENDING row-span 비율 시각회귀)·nit. NAS OOM(verify 단독).

## ✅ S59 (D11-attachments 프런트엔드 — 이미지 라이트박스/뷰어) — 완료 (2026-06-03, 이 세션) — 마이그레이션 0

- **FR-AM-10**(라이트박스 dialog — Radix `@radix-ui/react-dialog` 직접·role=dialog·aria-modal·첫포커스 닫기·focus trap·Esc·트리거 포커스복원·←→ 네비 순환없음·"N/M"+파일명+크기)·**FR-AM-11**(휠 줌 0.5~3.0·드래그 패닝·교체 시 리셋·transform scale()/translate() 중앙기준·**키보드 +/-/0** 추가)·**FR-AM-12**(다운로드+원본열기·**SVG download-only** XSS 방어)·**FR-AM-19**(스포일러 toggle — 공개↔재가림). **FR-AM-30 = deferred**(비디오 인라인/썸네일 P2 OUT·ffmpeg 영구보류·[[feedback_no_server_media_resize]]·fr-matrix `deferred`). 마이그레이션 0·FE-only.
- **★스포일러 트리거 통합**(reviewer MAJOR-1 ↔ accessibility BLOCKER-4 정반대 충돌 해소): **스포일러 이미지는 공개(revealed) 상태에서만 라이트박스 트리거 활성**. 공개 전 = button 없음(aria-hidden 내 포커스요소 0)·공개 후 = 키보드/마우스 진입. 단일·모자이크 동일. `AttachmentSpoilerOverlay` 에 `onRevealChange` 콜백 추가·호출부가 `clickable = !isSpoiler || revealed` 게이팅.
- **3팀 리뷰**(reviewer/ui-designer/accessibility·shared-types 무변경이라 contract 생략) → fix-forward(91414eb). **ui-designer 0 위반·FP 0**(viewport arbitrary z-9000/95vw/90vh 정상). **reviewer request-changes→해소**. **a11y BLOCKER 4**(B-1 `onCloseAutoFocus` triggerRef 포커스복원[Radix 외부제어라 자동복원 무효였음]·B-2 라이트박스 버튼 `var(--text-onAccent)` 흰색[ghost `--text-secondary` 라이트테마 2.87:1·**data-theme=dark 불가**: tokens.css 에 `[data-theme="dark"]` selector 없음]·B-3 키보드 줌·B-4 스포일러 통합)·**HIGH 3**(H-1 캡션 aria-live·H-2 `RDialog.Description` 댕글링 제거·H-3 aria-label 제거 Title만)·**MAJOR 3**(M-1 재가림 포커스·M-2 원본열기 파일명 aria-label·M-3 alt 폴백 '이미지')·reviewer MINOR-2(count 축소 index 재클램프)·ui MINOR-2(zoom 커서 className).
- 게이트(메인루프 독립 재실행): **web 단독 1039 GREEN**(baseline 1021 → +18)·typecheck exit 0·빌드 GREEN(DS 가드 통과·raw hex/px 0). 마이그레이션 0. DS·settings·handoff 무수정·FE-only.
- carryover: **DS-owner**(B-01 누적 `--danger-400`/`--accent` 라이트 대비 — tokens.css). a11y polish(polish-1 prev/next aria-disabled·polish-2 outline-none·polish-3 라이트박스 내 미공개 스포일러 슬라이드 — readyImages 필터 현행유지). reviewer MINOR-3(휠 preventDefault — Radix scroll-lock 무해)·ui MINOR-1(고정 px 320/240/160/36/550 누적·S58 이월). `Function components cannot be given refs` 경고(기존 c0b08c4 부터·Radix Portal/LightboxContent·범위밖). NAS OOM(verify 단독).

## ✅ S60 (D11/D16 백엔드 — 링크 unfurl + OG 이미지 프록시 + MessageEmbed) — 완료 (2026-06-03, 이 세션) — 마이그레이션 1(MessageEmbed·reversible)

- **FR-RC07**(메시지 저장 후 비동기 URL 추출→unfurl·normalizeUrl→sha256 캐시키·OG/Twitter/HTML fallback·MessageEmbed 저장·`message:embed_updated` push)·**FR-AM-13**(BullMQ UnfurlProcessor 비동기)·**FR-AM-14**(SSRF 다층)·**FR-AM-15/RC09**(Redis TTL 1800s·OG 이미지 MinIO 캐시)·**FR-AM-16/RC08**(`<URL>` 마스킹·사후 suppress 작성자 OR DELETE_ANY_MESSAGE)·**FR-RC21**(`/links/embed-image/:id` 프록시·presigned 직접노출 0). 8 FR done(247/354).
- **★사용자 fork 결정**: (B) **BullMQ UnfurlQueue**(concurrency 4·jobId=messageId 멱등)·(C) **`/links/embed-image/:embedId`** 신규 프록시·(A) **OG 이미지 MinIO+attachment-GC 패턴**([[project_bullmq_greenlight]]).
- **4팀 리뷰**(reviewer/contract/security/performance) → fix-forward(88346cb). **contract 99.5% 정합·drift 0**. **reviewer approve**(MAJOR-1 시정). **시정**: **★SSRF BLOCKER-1/HIGH-3**(`followRedirects` DNS rebinding TOCTOU — `fetch()` 가 검증 후 DNS 재조회 → **`pinned-http.ts` 공통모듈 추출**·검증 IP 소켓핀 connect+원본 hostname Host/SNI·각 hop 재검증)·**HIGH-1+perf SERIOUS+LOW-2**(embed-image public 302 presigned 노출+DB폭발 → **public 도 스트리밍 통일**·`Cache-Control: private,max-age=86400,immutable`[sha256 불변])·**HIGH-2**(embed-image rate-limit 300/min)·**MAJOR-1**(embed 이미지 CSS overflow → `qf-embed--image` 수식자·DS 무수정)·**perf MODERATE**(concurrency 2→4·Buffer.concat 복사 제거)·**security MEDIUM-1/2/3·LOW-1**(이중 정규화 제거·스트리밍 Content-Type 재검증·버퍼 크기·부분이미지 null).
- 게이트(메인루프 독립 재실행): **api 632·web 1048 GREEN**·api/web typecheck 0·int link-unfurl 6·**마이그레이션 reversible 확인**(up CREATE TABLE+인덱스+FK CASCADE 멱등 / down 역순 DROP IF EXISTS·additive 신규테이블·CONCURRENTLY 미사용). DS·settings·handoff 무수정.
- carryover: **reviewer MINOR-1**(DM 채널 suppress 엔드포인트 부재 — 워크스페이스 채널은 됨·DM 만 사후억제 불가·FR-RC08 부분갭)·**MINOR-2/perf**(active job 중 edit 재enqueue 유실·fire-and-forget 한계·"편집 URL 회수 follow-up" 동급)·**MINOR-3**(cap 카운팅 raw URL·워커 재dedup 으로 무해)·**perf MINOR**(listPins·thread 답글 패널 embed 미포함·기능결정·cachePreview 2 Redis 키 중복·suppressedAt partial index·suppressEmbed 직렬 4쿼리)·**security LOW-3**(길이검증 정규화전)·NIT(마이그레이션 타임스탬프 400000·uuid default). NAS OOM(verify 단독).

## ✅ S61 (D12-roles-moderation — 커스텀 Role 시스템 ★대형) — 완료 (2026-06-03, 이 세션) — 마이그레이션 1(Role/MemberRole·enum 5단계·Int→BigInt·backfill·reversible)

- **FR-RM01**(시스템 5역할 OWNER/ADMIN/MODERATOR/MEMBER/GUEST + 커스텀 생성·name/colorHex/position/permissions BigInt·`Role`/`MemberRole` 테이블)·**FR-RM02**(권한비트 shared-types ADR-4 14비트+ADMINISTRATOR 1n<<63n 단일출처·집행 enum→카탈로그 통일·**0x80 분리** PIN_MESSAGE 폐기)·**FR-RM04**(position 계층·privilege escalation 방어 assertGrantWithinActor·SELECT FOR UPDATE)·**FR-RM15**(Role 삭제 cascade·override deleteMany·Redis DEL ≤1000 즉시/>1000 BullMQ). **done 4개(251/354).**
- **★FR-RM03 = todo 유지(집행 배선 S62)**: 채널 override 5단계 resolver(`resolveChannelPermissions`)는 구현됐으나 **enforcement 미연결**(사용자 결정 B). 커스텀 Role permissions/UUID override 가 실제 권한에 **아직 미반영**. `@deprecated`+`// TODO(S62)` 마커. **S62 에서 channel-access 배선 시 done.**
- **★사용자 결정 2건**(AskUserQuestion·[[project_s61_custom_role_approved]]): (1)Option A 커스텀 Role 전체 도입(S45 부분해제) (2)**집행 배선 = S62 분리**(권한 시스템 ~16파일 전면교체 회귀위험·안정성 선회).
- **6팀 리뷰**(reviewer/contract/security/performance/ui-designer/accessibility) → fix-forward(efb3ddd). **마이그레이션 reversible 안전**(enum down 비대칭 MEMBER 환원·Int→BigInt·backfill·up→down→up). **시정**: **★security BLOCKER-2(Critical privilege escalation)**(transferOwnership 후 ex-OWNER MemberRole 잔재 → god role 재획득 → **syncMemberSystemRole 로 enum↔MemberRole 단일 동기**·int 403 검증)·**security HIGH-1/reviewer BLOCKER-1**(invite/joinPublic/updateRole MemberRole desync → 동기화·ADMIN CRUD 작동)·**reviewer BLOCKER-3**(범위초과 permission 500→422 Zod refine)·**security HIGH-2**(position min0/max499)·**HIGH-3**(Role CRUD rate-limit)·**MED-1+perf SERIOUS-4**(create 트랜잭션 FOR UPDATE·computeActorContext 단일쿼리)·**contract**(FE updateMemberRole/useUpdateRole 5단계 타입)·**ui MAJOR**(`bg-bg-selected`→`bg-bg-accent`·`hover:text-text`→`hover:text-foreground`·`bg-bg-subtle`는 유효 FP)·**a11y**(탭 WAI-ARIA tablist/tab/화살표·confirm aria-labelledby·RolesModal 조기반환 제거·aria-label 중복 제거·disabled=readOnly·accent-color)·**MAJOR-1**(resolver ④단계 PRD 정합 교정·미연결이라 무영향).
- 게이트(메인루프 독립 재실행): shared-types build·**api 666·web 1054 GREEN**·api/web typecheck 0·int roles 8(privilege escalation 403 포함). 마이그레이션 reversible. DS·settings·handoff 무수정.
- carryover: **★FR-RM03 집행 배선 = S62**(resolveChannelPermissions↔channel-access·role-cache read/write·perf SERIOUS-2/3/5·MED-2 MODERATOR announcement·MED-3 resolveMentionEveryone UUID). **DS-owner**: a11y B2/M4/DS1(`tokens.css` `input:focus-visible{box-shadow:none}` 가 체크박스/라디오/color input 포커스 링 제거 — `:not([type=checkbox]):not([type=radio]):not([type=color])` 한정 필요·DS 4파일). perf MODERATE(backfill 대량시간·position SELECT FOR UPDATE 단일row 락 deadlock 가능·BigInt 인터셉터 이중순회)·MINOR(FE 메모). reviewer/a11y MINOR/P. NAS OOM(단독). int teardown SIGSEGV flake.

## ✅ S62 (D12 권한 집행 배선 + 채널 override + 모더레이션) — 완료 (2026-06-04, 이 세션) — 마이그레이션 1(AuditLog·reversible)

- **★FR-RM03 집행 배선(S61 이월) done**: `resolveChannelPermissions`(BigInt 5단계 resolver)를 `channel-access.resolveEffective` 에 배선 — 커스텀 Role permissions/UUID override 가 **실제 권한 집행에 반영**. `bigintToEnforcementMask` shim(BigInt→집행 enum number·시그니처 유지). **회귀 검증 잠금**(shim 5역할 == ROLE_BASELINE·reviewer/security 통과). SQL fold 6 read-path(unread/me-activity/me-mentions/badges/saved/my-threads/search)에 커스텀 Role UUID principalId 반영·cross-workspace 상관조건. role-cache read-through `perms:{channelId}:{userId}` TTL 5초.
- **FR-RM14**(채널 override UI — `ChannelPermissionsTab` ALLOW/DENY/INHERIT 3-state·string DTO[ADR-11 Fork B])·**FR-RM16**(반응 동시성 — D05 카노니컬 패턴 기구현 확인)·**FR-RM17**(AuditLog 테이블·`ADMINISTRATOR_CHANNEL_BYPASS` send/upload/history 감사·append-only). **done 4개(FR-RM03/14/16/17)·255/354**. **FR-RM13 = deferred**(역할색상 메시지명·P2·메시지 hot-path·Fork C 제외).
- **6팀 리뷰**(reviewer/contract/security/performance/ui-designer/accessibility) → fix-forward(55ae8de). **★3대 불변식 통과**(집행 회귀 ROLE_BASELINE 일치·SQL fold 일관·마이그레이션 reversible). **★security BLOCKER-2/3 = FALSE POSITIVE 기각**(@everyone Role 엔티티 미존재·시스템+커스텀 MemberRole OR 합산 순서무관·reviewer 일치). **시정**: reviewer MAJOR-1=security MEDIUM-2(updateRole/transferOwnership 캐시 무효화·int 검증)·security HIGH-1(FR-RM17 upload/history 감사)·MEDIUM-4(override rate-limit)·MEDIUM-5(denyMask 비노출 denyExisted)·perf SERIOUS-1/3(hot-path memberRoleUuids 중복 제거 preload)·a11y B4(aria-current)/B5+H3(tablist 키보드/tabpanel)/H1(aria-pressed→aria-label)/M1(저장중 role=status)/M2(aria-describedby)·ui H-01(border Tailwind)/M-02/M-03(inline 제거)/N-02(py-2). 선존 매트릭스 드리프트(permissions.matrix expectedVersion 누락 3케이스)도 시정.
- 게이트(메인루프 독립 재실행): shared-types build·**api 699·web 1061 GREEN**·api/web typecheck 0·**api/web lint 0 errors**·int s62(3)+roles(8)+matrix(110). 마이그레이션 reversible(AuditLog). DS·settings·handoff 무수정.
- carryover: **perf SERIOUS-2/MODERATE-6**(me-activity/me-mentions/saved 2단계 fold→5단계·**선존**[S47 badges만 교정]·correctness·후속 통일). **DS-owner**: a11y B1/B2/B3 라이트 테마 ok/danger 대비(1.67/2.66/2.48:1·`--ok-600`/`--danger-600` 단일토큰이 다크서 저대비 → 테마별 시맨틱 토큰 `tokens.css` 필요·S56~S61 누적). **security MEDIUM-1**(resolveMentionEveryone @everyone override·@everyone 미존재로 제한적)·**MEDIUM-3=reviewer NIT-1**(roleOverridePrincipalMatchSql 헬퍼 6곳 인라인 반복 drift)·**HIGH-2**(커스텀 UUID override 쓰기 API=S63). reviewer NIT-2·security LOW-1·MODERATE(SCAN keyspace·my-threads). NAS OOM(단독)·int teardown SIGSEGV flake.

## ✅ S63 (D12-roles-moderation — kick/ban/timeout 모더레이션) — 완료 (2026-06-04, 이 세션) — 마이그레이션 1(BannedMember+mutedUntil·reversible)

- **FR-RM05 Kick**(KICK_MEMBERS·WorkspaceMember 삭제+WS disconnect·재가입 가능·**5초 Undo** Redis 토큰 1회용·actor 응답 한정)·**FR-RM06 Ban**(BAN_MEMBERS·`BannedMember` 테이블·재진입 불가·unban·invites.accept+joinPublic 재가입 차단·중립 404·Undo 없음)·**FR-RM07 Timeout**(TIMEOUT_MEMBERS·60s~7d·`mutedUntil`·send/reaction add 차단·VIEW/READ 유지·lazy 만료)·**FR-RM08 Slowmode**(기구현 확인·slowmode.service·`slowmode:{ch}:{user}` Redis). **done 4개(259/354).** 권한 비트 **KICK/BAN/TIMEOUT_MEMBERS(1<<14/15/16)** 추가·MODERATOR+ 시드·position 계층 방어(FR-RM04 재사용)·AuditLog(S62 재사용)·kickUserEverywhere(WS disconnect).
- **6팀 리뷰**(reviewer/contract/security/performance/ui-designer/accessibility) → fix-forward(a389326). **reviewer approve**(마이그레이션 reversible·undo 동시성·ban 원자성 합격). **★security CRITICAL(ban 후 토큰 미무효화) = 기각**(워크스페이스 ban 은 WorkspaceMemberGuard 매요청 DB 멤버십 404 + roomsForUser 멤버십기반 WS + kickUserEverywhere 로 enforcement 완전·계정 전역정지 아님·refresh 전역 revoke 부적절·직접 검증). **시정**: **★security HIGH/BLOCKER joinPublic ban 우회**(isBanned 검사 추가·중립 404)·security MEDIUM(ban 비멤버 레이스 계층)·reviewer MAJOR-1(kick/timeout write P2025→404)·MINOR(canManage MODERATOR·reaction toggle-off 허용)·perf SERIOUS(isTimedOut→WorkspaceMemberGuard mutedUntil 편승·hot-path 왕복 제거)·contract BLOCKER(WS member:kicked/banned 계약+페이로드+FE dispatcher 실시간 갱신)·a11y(Undo TTL 5→9s·Ban alertdialog·aria-busy/label·BanList role=status·`bg-bg-muted`→`bg-muted`·`--radius-sm`→`rounded-sm`)·ui(max-h-[85vh]·select qf-input 단독).
- **★S62 fallout 복원**: s54/s55 int spec 이 S62(ChannelAccessService→AuditService non-Optional DI) 미제공으로 실패하던 것 → providers 에 AuditService(+s55 MemberRole/Moderation) 추가. s54 stale `linkedAt` 단언·dm-s19 BigInt 드리프트도 정렬. **int suite green 복원.**
- 게이트(메인루프 독립 재실행): shared-types build+227·**api 700·web 1067 GREEN**·api/web typecheck 0·**api/web lint 0 errors**·int s63(16)+s54(16)+s55(18)+dm-s19(17). 마이그레이션 reversible(BannedMember+mutedUntil). DS 4파일(public/design-system) 무수정(Dialog.tsx 는 src primitive·정당).
- carryover: **DS-owner**(`tokens.css` select/input focus-visible·라이트 danger-400/text-muted 대비·`components.css` danger btn hover 2.77:1·Toast plain-action live region[S24 button-중첩 회피 설계] — a11y BLOCKER-2/3·HIGH-2·DS-BLOCKER-1/2·S62~ 누적). **security LOW**(kickUndo rate-limit)·**A-2**(비멤버 ban 완전 이력 추정·역할이력 테이블 부재)·ui MINOR(라벨/gap)·reviewer NIT(actorContext 레거시·undo 키 덮어쓰기)·perf MINOR(React.memo·listBans 페이지네이션). 테스트 누락(P2025 레이스·toggle-off·WS multi-node). **★교훈: int 독립 VERIFY 가 변경파일 관련 spec 만 돌리면 cross-cutting DI 회귀(S62 fallout) 놓침 — 이후 슬라이스는 전체 int 또는 의존 spec 도 점검.**

## ✅ S64 (D12-roles-moderation — 모더레이션 마무리) — 완료 (2026-06-04, 이 세션) — 마이그레이션 2(ModerationReport + FK/index·reversible)

- **FR-RM09 Bulk Purge**(MANAGE_MESSAGES·최대 200·단일 updateMany·BULK_MESSAGE_DELETE 단일 audit/WS)·**FR-RM11 신고 큐**(ModerationReport 테이블·신고 CRUD·DISMISS/WARN/DELETE/TIMEOUT/BAN 처리·@@unique 중복방지·cursor)·**FR-RM12 감사 로그 조회**(GET audit-logs cursor/필터·VIEW_AUDIT_LOG=ADMIN enum 게이트[결정 B]·details Json 현행[결정 A]·신규 감사 기록지점 ROLE/MEMBER_ROLE/OVERRIDE/MESSAGE_DELETE/SLOWMODE/PRIVILEGE_ESCALATION). **done 3개(262/354).** **★FR-RM10 AutoMod = 사용자 결정으로 별도 슬라이스 분리**(아래)·FR-RM13 deferred.
- **6팀 리뷰**(reviewer/contract/security/performance/ui-designer/accessibility) → fix-forward(480e1d4). **contract 정합 ✅**. **reviewer approve**(forwardRef·마이그레이션·cascade 단순화 합격). **★security BLOCKER 2 = 둘 다 실제 취약점·시정**: **(1)DELETE_MESSAGE 권한 계층 우회**(resolveReport DELETE 가 position/DELETE_ANY_MESSAGE 우회 → assertActorOutranksAuthor + 채널 권한 fold·MODERATOR→ADMIN 403)·**(2)listReports private 채널 content 노출 IDOR**(채널 READ 미검증 → 비멤버 마스킹 content=null/contentMasked). **시정**: reviewer H-1(create escalation 감사 tx 롤백 유실 → 비-tx persist)·M-2(OVERRIDE_REMOVE dead enum 제거)·security HIGH-1(bulk 크로스채널 IDOR 테스트)·HIGH-2(listReports rate-limit)·MEDIUM-2(ModerationReport FK channelId CASCADE/reporterId SET NULL)·MEDIUM-3(message null DISMISS)·m-4(resolve claim 먼저→중복차단)·perf SERIOUS-1(MESSAGE_DELETE 감사 자기삭제 best-effort/모더 tx 분기)·SERIOUS-2(이중 tx/감사 → auditMode skip+impliedAction)·MODERATE-3(audit actorId 인덱스)·MODERATE-4(listReports cursor+NULLS FIRST 인덱스)·a11y B-05/H-01~03/M-01~04(로딩 SR·tabpanel tabIndex·버튼 aria-label/busy·처리됨 배지)·ui(boxShadow→shadow-elev-3·aria-current page-scoped).
- 게이트(메인루프 독립 재실행): shared-types build+227·**api 710·web 1079 GREEN**(첫 web 1건 flaky·재실행 green)·api/web typecheck 0·**api/web lint 0 errors**·int s64(13)+회귀(s63 16·s62 3·messages 6·pins 9). 마이그레이션 2개 reversible(up→down→up·FK CASCADE/SET NULL·인덱스). DS·settings·handoff 무수정.
- carryover: **★FR-RM10 AutoMod = 별도 슬라이스**(사용자 결정·re2 vs Worker Thread 100ms 그때 결정·hot-path/ReDoS/새 테이블). **DS-owner**(a11y B-01~04 DS 4파일 tokens/components.css select/input focus-visible·danger btn hover·qf-field\_\_error 라이트·accent 라이트 4.23:1·S56~ 누적·테마별 시맨틱 토큰). **Dialog primitive H-04/H-05**(X 닫기버튼·alertdialog Esc preventDefault·`Dialog.tsx` 광범위·S53 누적·Esc 취소 안전). a11y P-01~03·ui M-01~03(arbitrary 관례)/H-01(qf-tabs)·reviewer m-1(핀 패널 stale·invalidate TODO)·m-2(bulk FE tombstone vs 제거)·security MEDIUM-1(cursor OR AND)·LOW·perf MODERATE-5·NIT. web 테스트 flaky(NAS OOM/타이밍·재실행 green)·int teardown SIGSEGV.

## 별도 백로그: AutoMod (FR-RM10·P1·사용자 별도분리 결정)

- D12 잔여. **★사용자 결정 필요(진입 시)**: ReDoS 방어 = re2 native addon(gyp 빌드·NAS Docker) vs Worker Thread 100ms timeout(의존성 없음). 메시지 수신 hot-path 변경·`AutoModRule` 신규 테이블·KEYWORD/MENTION_SPAM/REPEAT_SPAM × BLOCK/ALERT/AUTO_TIMEOUT·exemptRoles/Channels·AUTOMOD_BLOCK/TIMEOUT 감사. S45 @role 무충돌(MENTION_SPAM 은 mrkdwn 토큰 카운트). UNDERSTAND 완료(S64 조사). backlog 순서상 D13 이후 또는 사용자 우선순위.

## ✅ S65 (D13-workspace-invite — 워크스페이스 생성/소유권/나가기/기본채널) — 완료 (2026-06-04, 이 세션) — 마이그레이션 2(join_mode/default_channel + isDefault partial index·reversible)

- **FR-W01 생성**(name/slug/아이콘·**joinMode**[PRIVATE/PUBLIC/APPLY·신규 enum·visibility 와 직교]·**emailDomains**[저장만·게이트 S66]·**#general 자동생성** workspaces.service.create 단일 tx·isDefault=true·defaultChannelId·5역할 시드·ChannelsModule 미import 순환회피)·**FR-W13 소유권 양도**(기구현+**비밀번호 재확인 argon2 PasswordService.verify**·required·401)·**FR-W14 나가기**(BE 기구현·**FE 위험구역 추가**·OWNER 비활성)·**FR-W19 기본채널**(PATCH default-channel·공개채널만 422·단일 tx). **done 4개(266/354).**
- **6팀 리뷰**(reviewer/contract/security/performance/ui-designer/accessibility) → fix-forward(340751b). **contract 정합 ✅·reviewer approve**(#general tx·마이그레이션 reversible·visibility-toggle 선존 무관 확인). **시정**: **★security HIGH/BLOCKER transfer-ownership rate-limit**(brute-force·ws:transfer 5/5min·429)·APPLY joinMode 즉시가입 방어(WORKSPACE_APPLY_NOT_SUPPORTED 409)·RESERVED_SLUGS 확장·**ui/a11y**(confirm 다이얼로그 수동div→Radix Dialog alertDialog·qf-switch aria-labelledby·에러 role=alert 3곳·양도/나가기 ghost→**danger**·OWNER aria-disabled/describedby·생성/저장/양도/나가기 aria-busy·비밀번호/도메인 aria-describedby·위험구역 h3·InviteAccept length 힌트·기본채널 "(현재 기본)")·**★ui MAJOR-3 Shell myRole truncation**(3역할 cast→shared-types 5역할·MODERATOR 가 MEMBER 폴백돼 신고큐 탭 미노출 버그 해소)·**perf Channel.isDefault partial index**·주석 정정·**D-2 visibility-toggle 선존 복원**(초대 응답 shape latent inv.body.invite.code + PUBLIC 메타 누락 → WORKSPACE_PUBLIC_REQUIRES_METADATA 422)·emailDomains UI 안내.
- 게이트(메인루프 독립 재실행): shared-types build·**api 710·web 1087 GREEN**·api/web typecheck 0·**api/web lint 0 errors**·int visibility-toggle(1·복원)+workspace-join(2·APPLY 409)+workspaces(15·transfer rate-limit). 마이그레이션 2개 reversible. DS·settings·handoff 무수정.
- carryover: **DS-owner**(a11y BLOCKER-4 `tokens.css` input/select focus-visible·BLOCKER-5 qf-field\_\_error 라이트 대비·HIGH-1 accent 라이트 4.23:1·MAJOR-2 `Dialog.tsx` X 닫기버튼·S62~ 누적·테마 시맨틱 토큰). **iconUrl SSRF**(기존·origin 미제한)·**emailDomains 게이트 S66**(저장만·UI 안내함)·perf MODERATE-2(useMembers 대규모 waterfall)·MINOR(create tx 3단계·seed 중복·emailDomains GIN S66)·reviewer NIT(defaultChannelId write-only 소비처·transferTargets no-op)·ui MAJOR-2(CreateWorkspacePage bg-app)·POLISH-3(성공 통지)·테스트 누락(transfer→leave·default 멱등). web flaky(NAS OOM)·int teardown SIGSEGV.

## ✅ S66 (D13-workspace-invite — 이메일 인증 + 도메인 게이트 + 초대 만료 UX) — 완료 (2026-06-04, 이 세션) — 마이그레이션 1(User.emailVerified + EmailVerificationToken·reversible·S65 의 20260605000000)

- **FR-W05a emailVerified 서버 게이트**(invites.accept·workspaces.joinPublic·**workspaces.create**[fix-forward HIGH-3]·messages send[DM 포함·의도] 전부 403 EMAIL_NOT_VERIFIED·JWT 가 아닌 매요청 DB 로드라 verify 즉시반영·stale 우회 없음)·**FR-W05b 인증 대기 화면**(`EmailVerificationGate` 재발송 60s 쿨다운+1일5회·"이미 인증했어요" me 재조회·`VerifyEmailLanding` 토큰검증 랜딩)·**FR-W21 초대 만료**(`InviteExpired` 410 INVITE_EXPIRED/EXHAUSTED/REVOKED 전용)·**S65 이월 emailDomains 게이트 enforcement**(accept·joinPublic exact-match·빈배열 통과·불일치 403 WORKSPACE_DOMAIN_NOT_ALLOWED). 사용자 결정: **메일=Console stub**(MailSender 인터페이스+ConsoleMailSender·컨테이너 없음·prod SMTP 후속)·**emailDomains 게이트 S66 포함**·backfill 기존 false+seed true. **done 3개(269/354).**
- **6팀 리뷰**(reviewer/contract/security/performance/ui/a11y) → fix-forward(a36532d). **contract 88% PASS·perf clean**(게이트 0추가쿼리·JWT findById 재사용)·reviewer request-changes(BLOCKER 없음). **시정**: **★security BLOCKER 3**(HIGH-1 resend 쿨다운 check-then-set race→`SET NX EX 60` 원자화 메일발송 전 점유·HIGH-2 verify-email @Public IP rate-limit 20/60s·HIGH-3 워크스페이스 생성 게이트 누락)·**HIGH-4 prod 토큰 평문로그→마스킹**(NODE_ENV 분기)·MEDIUM-1 resend 인증완료 멱등단락·m3 랜딩 stale-gate effect 분리·MEDIUM-3 token URL `history.replaceState` strip·contract-LOW InviteAccept 403 사유분기·LOW-2 /invite gate EXEMPT·**ui text-warning→text-text-strong**(라이트 1.67:1→고대비·a11y B1/B2 동시해소)·fs 표기통일·**a11y BLOCKER 5**(A1 라이브영역 status/alert·A2 카운트다운 버튼명 분리 aria-hidden·A3 aria-busy·A4/A5 랜딩 status/alert·)·HIGH(B3 진입포커스·B4 aria-disabled 쿨다운·B5 eyebrow aria-hidden)·MAJOR(C1 section aria-labelledby·C3 document.title·D1 로그인 aria-label)·m4 accept 게이트 순서 통일.
- 게이트(메인루프 독립 재실행): shared-types build·**api 731·web 1104 GREEN**·api/web typecheck 0·**api/web lint 0 errors**·int email-verify+게이트영향권(workspaces/join/invites 회귀 무). 마이그레이션 reversible(fix-forward 미변경). DS·settings·handoff 무수정. **★int VERIFY 에서 선존 버그 발견·시정(8ac5f78)**: `invites.accept`·`preview` 가 취소 초대에 generic INVITE_NOT_FOUND(404) 반환(task-002 이래 비대칭·expired 는 이미 410)→**revoked→INVITE_REVOKED(410)** 통일. develop 재현으로 S66 무관 확인했으나 **FR-W21(취소 링크 전용화면)을 직접 훼손**해 in-domain fix-forward(preview revoked→410 회귀 테스트 추가·blast radius 0).
- carryover: **DS-owner**(B5 `components.css` qf-eyebrow accent a-600·D2 `tokens.css` ring-focus 라이트 여유·B1/B2 warn-400/danger-400 라이트 대비 토큰·S56~ 누적). **security MEDIUM-2**(emailDomains 정규식 다중레이블 admin foot-gun→**S68 관리 UI 경고**·정규식 제한은 .co.uk 등 정상도메인 깨져 회피)·**MEDIUM-3 인프라**(nginx /verify-email `Referrer-Policy:no-referrer`+`X-Robots-Tag:noindex`)·LOW-1(verify findUnique tx 밖·CAS 안전)·LOW-3(JWT emailVerified Redis 캐시 트래픽시)·perf MODERATE(resend Redis pipeline·NX 로 일부완화)·reviewer n2(signup 메일 필수경로→SMTP best-effort)·**HIGH-4 전체(SMTP 어댑터 실발송·사용자 후속)**·contract INFO(joinPublic 응답 Zod). web flaky(NAS OOM)·int teardown SIGSEGV(kernel 4.4).

## ✅ S67 (D13-workspace-invite — 초대 링크 생성/수락/관리) — 완료 (2026-06-04, 이 세션) — 마이그레이션 1(Invite.temporary + WorkspaceMember.isTemporary + @@index·reversible·20260606000000)

- **FR-W02 생성**(8자 alphanumeric 코드[crypto.randomInt·혼동문자 0/O/1/l/I 제외 57자·충돌 재시도 3회·기존 22자 공존]·**temporary 임시멤버십** 컬럼·생성/목록/취소/삭제 게이트 ADMIN→**MODERATOR**[최소등급 비교])·**FR-W03 수락**(이미멤버 throw 대신 **{workspace,alreadyMember} 200**[신규 201·재수락 200 `@Res` 분기]·temporary=true→WorkspaceMember.isTemporary 기록)·**FR-W17 관리**(ADMIN 전체·MODERATOR 본인 생성분[createdById 필터]·usesRemaining/active/createdBy 파생·soft revoke[DELETE :id]+**hard delete[DELETE :id/permanent]** 분리·FE InviteManagerPanel·CreateInviteModal·설정 '초대 링크' 탭). **done 3개(272/354).** 사용자 결정: Redis early-return 캐시 **DEFER**(DB CAS race-safe·단일노드)·8자 신규만·C-2 hard-delete 분리·temporary 강퇴는 S70.
- **6팀 리뷰** → fix-forward(b6505f7). **contract 100% PASS·reviewer approve·perf clean**(게이트 추가쿼리 0). **시정**: **★security HIGH `main.ts` trust proxy 미설정**(req.ip=nginx 내부IP→모든 per-IP rate-limit[S66 verify-email 포함] 전역버킷 공유) → `set('trust proxy', 1)`[단일 nginx 홉]·MEDIUM accept per-IP+preview per-code 버킷·MEDIUM+reviewer hard-delete **INVITE_DELETED outbox+AuditService**(soft revoke 와 대칭)·perf accept pre-CAS select 확장으로 workspace 재조회 3회 제거·reviewer P2002 target 방어(workspaceMember PK 충돌만 멱등)·**a11y BLOCKER B-1 hard-delete 확인 alertDialog**·SERIOUS(S-1 액션버튼 aria-label 초대코드·S-2 복사 role=status 라이브영역·S-3 aria-busy)·M-1 dl dt/dd·M-3 체크박스 aria-label 제거+aria-describedby·M-4 SettingsOverlay aria-modal·ui rounded-md·모바일 overflow scroll·상태 도트·perf setTimeout cleanup·Intl 호이스팅.
- 게이트(메인루프 독립 재실행): shared-types build+**test 235**·**api 749·web 1114 GREEN**(web AttachmentsList audio 1건 flake→재실행 1114)·api/web typecheck 0·**lint 0 errors**·int invites+rate-limit+moderation(audit 영향권). 마이그레이션 reversible(fix-forward 미변경). DS·settings·tracking 무수정.
- carryover: **reviewer MAJOR #1**(joinPublic 항상 201 vs invite accept 200/201 비일관·S65 영역·후속)·**security LOW isTemporary 강퇴 미연결 = S70**(컬럼/기록만·temporary 초대가 S70 전까진 영구멤버처럼 동작)·**ui MAJOR `WorkspaceSettingsPage:215` qf-settings grid 오용·tab qf-tabs 패턴·:239 radius = 선존(S65)**·**a11y M-2 aria-controls idref(탭패널 DOM)=선존 탭패턴**·N-1 색구분(보강함)·**N-2 Dialog primitive 닫기버튼·DS-1~4 `tokens.css` 라이트 ok/warn/danger 대비+select focus-visible = DS-owner**·perf MINOR(list createdById 복합인덱스·pendingId 행단위). web flaky(NAS OOM)·int teardown SIGSEGV(kernel 4.4).

## 다음 슬라이스: S68 (D13-workspace-invite — 이메일 초대 + 도메인 자동가입 관리)

- scope **fullstack**. **FR-W04/W04a/W05/W18**(P2). deps S67. 파일: `apps/api/src/workspaces/**`·`apps/api/src/auth/**`·`apps/web/src/features/workspaces/**`.
- FR 정본 PRD D13 재확인(UNDERSTAND 필요·예상: FR-W04 이메일 주소 직접 초대[워크스페이스 외부]·FR-W04a 초대 이메일 발송·**FR-W05 도메인 기반 자동가입(emailDomains 관리 UI)**·FR-W18 보류 이메일 초대 관리[Pending 목록·연장/재발송/취소]). **S66 이월: emailDomains 관리 UI 에서 MEDIUM-2 다중레이블 정규식 admin 경고**. 기존 invites(S12/S63/S65/S66/S67)·MailSender(S66 console stub·SMTP 어댑터 후속)·emailDomains 게이트(S66) 재사용. **이메일 초대는 별도 모델(EmailInvite 또는 Invite.email 확장)** — S67 의 링크 Invite 와 구분. UNDERSTAND 로 fork(별도 모델 vs 컬럼 확장·MailSender 실발송 SMTP 여부).
- **fullstack·reviewer/contract/security(이메일 발송·도메인 게이트)/performance + UI ui/a11y**. subagent 머지/배포/prod 금지·DS FP 주의. ⚠️ develop push 누락([[reference_develop_push_drops]]·ls-remote)·**pre-push `pnpm verify`=훅 실패가 push-drop 처럼 보임·shared-types test 포함**([[reference_verify_shared_types_test]])·**int 의존 spec 점검**(S62 fallout). ★별도 백로그 AutoMod(FR-RM10·re2 vs Worker 사용자 결정).

### (구) S19 진입 메모 — 완료됨, 참고용 보존

- scope `apps/api/src/channels/direct-messages/**`, 일부 web.
- FR-DM-07/08/09/12. 그룹 DM 멤버 추가/강퇴/나가기 + (owner 개념 있으면) 승계 + DM 수신권한 게이트.
- 주의: S16 group DM(createGroupDm, ChannelPermissionOverride USER row 멤버십, slug dedup) 위에. **그룹 멤버 변경 시 friendship 게이트**(S16 assertCanDm 재사용) + 멤버변경 실시간(dm:participant_added/removed). cap 20 유지. FR 정본: PRD html.
- **⚠️ S19 아키텍처 분기(UNDERSTAND 완료, 결정 필요)**: PRD 는 `DmParticipant`(joinedAt/leftAt/owner) + `User.allowDmFrom`(EVERYONE/WORKSPACE_MEMBER) 모델을 전제하나 **실제 스키마에 없음**. 현재 그룹 멤버십=ChannelPermissionOverride USER row(owner·joinedAt·leftAt 없음). 필요분: ① owner 개념(FR-DM-08 강퇴 owner-only, FR-DM-09 owner 탈퇴 시 joinedAt 최古 승계) ② joinedAt/leftAt(soft-leave + cap-race COUNT FOR UPDATE) ③ visibleFrom(S17 에서 ChannelPermissionOverride 에 이미 추가 — 재사용) ④ User.allowDmFrom(FR-DM-12, 신규 컬럼).
  - **권고 방향(S16/S17 패턴 일관)**: 신 DmParticipant 모델 도입 대신 **ChannelPermissionOverride 확장**(joinedAt default now, leftAt nullable soft-leave, owner 마커=boolean 또는 별도 ownerId on Channel). 3중 멤버십 모델 회피. DmParticipant 수렴은 carryover(standalone UserBlock 과 동일 처리). 단 ChannelPermissionOverride 가 멤버십+권한+visibleFrom+join/leave/owner 까지 과적되면 리뷰에서 재평가. **마이그레이션 reversible 필수**(User.allowDmFrom + override 확장).
  - FR-DM-08 1:1 강퇴 항상 403, FR-DM-09 마지막 멤버 탈퇴 시 Channel.deletedAt=now. FR-DM-12 위반 403 + FRIENDS_ONLY 는 Phase 2(미구현). FR-DM-10(DM 숨기기 HIDDEN)은 S20 이라면 분리.
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
