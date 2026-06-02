# S36 — 스레드 unread (D04 + D09) · reviewer / PR

브랜치: `feat/s36-thread-unread` → develop (`--no-ff`) → main
범위: FR-RS-12 + FR-TH-04 / FR-TH-11 / FR-TH-12 / FR-TH-14 / FR-TH-18 (전부 P1).
마이그레이션 슬라이스: `ThreadReadState` 신규 테이블(reversible).

## FR별 구현

- **FR-RS-12 / FR-TH-11 (스레드 unread 계산)** — `ThreadReadStateService.unreadCountFor`.
  채널 미읽과 동일한 (createdAt, id) 튜플 커서 공식(S11). `isBroadcast=false` +
  `deletedAt IS NULL` + 튜플 비교. ThreadReadState 없으면 LEFT JOIN NULL →
  전체 답글 미읽.
- **FR-TH-12 (ACK)** — `POST /messages/:id/thread/ack` (`ThreadsController.ack`).
  body `{ lastReadMessageId }`. 루트 채널 READ ACL(`resolveThreadRootForAcl`)
  통과 후 `ThreadReadStateService.ackThread` 가 monotonic (createdAt, id) 튜플
  upsert(`ON CONFLICT … WHERE stored < EXCLUDED`). 퇴행 ack no-op. 204.
- **FR-TH-04 (reply bar unread dot)** — `aggregateThreadSummaries(rootIds, viewerId)`
  가 viewer 의 ThreadReadState 를 **같은 단일 쿼리**에 배치 조인해 `hasUnread`
  boolean 을 산정(N+1 없음). `ThreadSummarySchema.hasUnread` 신규(default false).
  `MessageItem` qf-thread-chip 에 `hasUnread` 시 파란 dot(app-layer, DS 토큰만:
  `var(--accent)` / `var(--s-2)` / `var(--r-pill)` — raw hex/px 0, DS 4파일 무수정).
- **FR-TH-18 (lastRead 초기 스크롤)** — GET 응답에 `readState.lastReadMessageId`
  추가. `ThreadPanel` 이 커서 존재 시 그 다음 첫 미읽 답글로 `scrollIntoView`,
  없으면 기존 최하단(S35). `hasAnchoredRef` 충돌 방지(anchored=false 1회만).
  mount/최하단/jump 시 디바운스 ACK(`useAckThread`, 600ms, 언마운트 시 타이머 정리).
- **FR-TH-14 (broadcast 채널 unread, 중복집계 금지 + 삭제 무효화)** — broadcast 행은
  채널 메시지라 채널 unread 에 자연 포함, 스레드 unread 엔 `isBroadcast=false`
  필터로 제외(중복집계 없음). broadcast soft-delete 시(`MessagesService.softDelete`)
  tx 커밋 후 `UnreadService.invalidateChannelWorkspaceAllMembers` 동기 호출 —
  워크스페이스 멤버 전원의 `unread:{ws}:{user}` 캐시 1 pipeline 무효화.

## unread 계산 방식 / unreadCount 컬럼 결정

옵션 B(계산). ThreadReadState 에는 **튜플 커서만**(`lastReadMessageId` +
`lastReadMessageCreatedAt`) 저장. denormalized `unreadCount` 컬럼은 두지 않음 —
미읽 수/여부는 조회 시 SQL COUNT/EXISTS 로 계산(drift 원천 차단, S11 채널-unread
정합). **denormalized unreadCount 컬럼 + Threads 탭(FR-TH-09/10)은 S38 연기.**

## broadcast 무효화 모듈 배선 (순환의존 해결)

옵션 A(동기 직접). `MessagesModule` 이 이미 `forwardRef(() => ChannelsModule)` 로
import 하고 `ChannelsModule` 이 `UnreadService` 를 export → 모듈 레벨 순환은 기존에
끊겨 있음. `MessagesService` 가 `@Optional() @Inject(forwardRef(() => UnreadService))`
로 주입(`UnreadService` 는 `MessagesService` 를 역참조하지 않아 런타임 사이클 없음).
미주입 단위테스트는 무효화 생략(DB 경로만). 무효화 실패 시 캐시 TTL(2h) 자연 만료

- 다음 read-through DB 재집계가 정정(unreadCount 정본은 DB COUNT — 롤백 불요).

## 마이그레이션 (테이블 / down / up-down-up)

`20260602200000_s36_thread_read_state` — `ThreadReadState`:
`id`(uuid pk), `userId`(uuid, FK User CASCADE), `parentMessageId`(uuid, FK Message
CASCADE), `lastReadMessageId`(uuid?), `lastReadMessageCreatedAt`(timestamptz?),
`updatedAt`. UNIQUE `(userId, parentMessageId)`, INDEX `(parentMessageId)`,
INDEX `(userId, updatedAt DESC)`. additive, backfill 불필요.
down.sql: `DROP TABLE IF EXISTS "ThreadReadState" CASCADE;` (reversible).

PG16.13 throwaway up→down→up 검증 로그:

```
UP    : All migrations have been successfully applied. (52 migrations)
        \d ThreadReadState → 6 cols, 4 indexes(pkey + 3), 2 FK(both CASCADE)
DOWN  : DROP TABLE → "Did not find any relation named ThreadReadState"
UP    : CREATE TABLE + CREATE INDEX×3 → table+indexes+FK 복원 확인
```

uuid PK + 튜플-커서-only 채택 이유: 본 프로젝트 Message/UserChannelReadState 가
모두 uuid PK + 튜플 커서라 코드 정합 단일화(PRD 카드의 cuid2 PK + unreadCount
컬럼 표기는 ADR-2 이전 표기로, 실제 스키마와 상이 — schema.prisma 주석에 명시).

## dot 배치쿼리 N+1 여부

N+1 없음. `aggregateThreadSummaries(rootIds, viewerId)` 가 루트 집합 단일 `$queryRaw`
안에서 `hasUnread` EXISTS 를 산정(루트마다 추가 쿼리 발사 X). int 테스트가 루트
5개에 대해 단일 호출로 5개 전부 hasUnread 산정을 확인.

## 추가 테스트

- 계약(shared-types): `ThreadSummary.hasUnread` default/true, `ListThreadRepliesResponse
.readState` default/cursor, `ThreadAckRequestSchema` uuid 검증.
- 단위(web): qf-thread-chip unread dot 렌더/미렌더(`MessageItem.threadChip.spec`),
  dispatcher `message.thread.replied` → `hasUnread`(viewer≠replier) 반영.
- 통합(api, 실DB+Redis, `thread-read-state.int.spec` 10/10):
  unread 계산(전체/ACK후/isBroadcast 제외/deleted 제외)·ACK monotonic(퇴행 no-op·
  IDOR 404)·dot 배치(per-viewer·N+1 없음)·broadcast 채널 −1+캐시 무효화·중복집계 없음.

## 게이트 (원문 숫자)

1. `pnpm verify` 전체 GREEN — 19/19 tasks. (api 444 / web 635 / shared-types 188 tests)
2. 빌드 3종 GREEN — shared-types(tsup) → api(swc 179 files) → web(vite, 11.73s).
3. 마이그레이션 PG16.13 up→down→up GREEN (위 로그).
4. 테스트 GREEN — int 10/10(실DB), 계약/단위 추가분 포함 verify 통과.

## 발견 이슈 / 정정

- 채널 unread COUNT 는 답글 행도 포함(기존 S11 정책 — roots-only 필터 없음).
  broadcast 답글 send 는 채널에 2행(원본 답글 + broadcast 행) 추가 → 채널 unread +2.
  FR-TH-14 "정확히 1 감소" 는 broadcast **행 삭제**의 델타로 검증(2→1).

## 미해결 / carryover

- denormalized `ThreadReadState.unreadCount` 컬럼 + Threads 탭(FR-TH-09/10),
  notificationLevel / lock → **S38**.
- 스레드 read-state 전용 WS 이벤트(멀티디바이스 즉시 동기) → S38 Threads 탭에서
  도입 검토. 현재는 채널 목록 refetch 시 `threadMeta.hasUnread` 가 서버 기준 재수렴.
- DS 정식 `qf-thread-chip__dot` / `qf-thread-jump-btn` 클래스 추가는 DS-owner
  follow-up(현재 app-layer DS 토큰 합성).

## DS 4파일 무수정 확인

`apps/web/public/design-system/{tokens,components,mobile,index}.{css,html}` diff 0.
`.claude/settings.json` 스테이징 안 함(작업 시작 시 revert, clean).
