# Task 070 — FR-RT-22 채널 캐시 evict 후 재진입 around 재로드 (S97)

## Context

FR-RT-22(P1, S09 partial): "클라이언트 채널 메시지 LRU 캐시(최대 N=5·env CHANNEL_CACHE_SIZE).
캐시 해제된 채널 재진입 시 **lastReadMessageId around 재로드**. GAP_FETCHING 중 채널 전환 시
해당 채널 FSM 을 DISCONNECTED 로 리셋."

**현재 상태(매핑)**: 대부분 완성, 공급원만 공백.

- ✅ around 서버 로드(`messages.service.list(around)` split before/after·REST `?around=`), LRU
  evict/cache(`channelLru.ts`·removeQueries), readStateStore(`readStateStore.ts`·setLastRead/
  getLastRead), around 소비(`resolveListFetchArgs`·consumeAround), **GAP FSM reset(channelLru
  S10/FR-RT-07·evict 시 동기화 FSM 리셋)** 전부 done.
- ⚠️ **공급원 부재(핵심)**: `channel:joined` 이벤트 스키마(`ChannelJoinedPayload`)에 `lastReadMessageId`
  optional 선언돼 있으나 **서버 realtime.gateway 가 안 싣고 클라 dispatcher 가 안 소비** → 재진입
  시 lastReadMessageId 공급 없어 around 재로드 항상 최신 폴백.
- ⚠️ **하드닝(carryover)**: HIGH-2(consumeAround 가 queryFn 내 소비 → retry 시 around 영구 상실)·
  MED-1(lastRead 미공급[race]인데 flag 소진 → around 상실). LOW-1(스키마 불일치)은 무효(둘 다 string).

## Scope

### IN (DB 마이그레이션 없음 — read-state 이미 존재)

**서버 공급**

1. **`channel:joined` 스냅샷에 lastReadMessageId 동봉**: `realtime.gateway.ts` connect 시
   eager-join 채널마다 emit 하는 `ChannelJoinedPayload` 에 `lastReadMessageId` 채운다.
   **★배치 1쿼리**(per-channel 서브쿼리 폭주 회피 — gateway 주석의 우려): `UserChannelReadState
.findMany({ where: { userId, channelId: { in: channelIds } }, select: { channelId,
lastReadMessageId } })` → Map 으로 채널별 매핑. 신규 서비스 메서드(`getLastReadMessageIds(userId,
channelIds): Map<channelId, messageId|null>`) 추가 권장(messages/realtime 적절한 서비스).

**클라 소비**

2. **dispatcher 가 `channel:joined` 소비**: `dispatcher.ts` 에 `CHANNEL_JOINED` 리스너 추가 →
   `lastReadMessageId` 있으면 `useReadState.setLastRead(channelId, lastReadMessageId)`. payload
   `safeParse(ChannelJoinedPayloadSchema)` 신뢰경계 가드(mention:new 패턴). seq 는 기존 처리 유지
   (중복 리스너 충돌 주의 — 기존 channel:joined seq 소비처 있으면 통합).

**하드닝(HIGH-2 + MED-1)**

3. **consumeAround retry-safe + lastRead-gated**(`resolveListFetchArgs`/channelLru): around 플래그를
   **queryFn 안에서 1회성 소비하지 말 것**. 대신:
   - resolveListFetchArgs 는 around 플래그를 **peek**(소비 안 함) + lastRead 존재 시에만 around 사용.
   - 플래그 clear 는 **첫 페이지 fetch 성공 시(onSuccess)** 또는 around 적용이 확정된 시점에 1회.
   - lastRead 가 null(race·미공급)이면 플래그를 소진하지 말고 before 폴백(다음 fetch[lastRead 도착 후]
     재시도에서 around 적용). retry(network 실패)에도 around 가 보존되도록(HIGH-2).
   - 정확한 구현은 useMessageHistory 의 retry/onSuccess 와 channelLru pendingAround 수명 재설계.

**TEST**

- unit: gateway snapshot 에 lastReadMessageId(배치) / dispatcher channel:joined → setLastRead /
  resolveListFetchArgs retry 시 around 보존(HIGH-2) · lastRead null 시 flag 미소진(MED-1) ·
  lastRead 도착 후 around 적용.
- int(realtime): connect 시 channel:joined 가 lastReadMessageId 동봉(ack 후 재연결 시 그 값) —
  ws int 패턴(`ws.*.int.spec`). 배치 쿼리 N+1 없음.

### OUT (후속/Non-goals)

- GAP_FETCHING reset(이미 channelLru S10 done). read-state 자체 저장(ack 경로 done).
- REST read-state 조회 엔드포인트(WS channel:joined 공급으로 충분·불요).
- around 윈도 크기 튜닝(limit 50 유지).

## Acceptance Criteria (기계 검증)

- [ ] `channel:joined` emit 이 채널별 lastReadMessageId 동봉(배치 1쿼리·N+1 없음). ack 로 lastRead
      갱신된 채널 재연결 시 그 값 수신.
- [ ] dispatcher 가 channel:joined 소비 → readStateStore.setLastRead. payload 가드(safeParse).
- [ ] 캐시 evict 채널 재진입 시 lastReadMessageId 있으면 `around=lastReadMessageId` 로드(없으면 최신 폴백).
- [ ] HIGH-2: queryFn retry(1회 실패) 후에도 around 보존(플래그 미소진 또는 onSuccess clear).
- [ ] MED-1: lastRead 미공급(race) 시 flag 미소진 → lastRead 도착 후 around 적용.
- [ ] verify green · 신규/갱신 unit green · ws int green(container standalone).

## Risks

- gateway connect hot-path: eager-join 채널 수만큼 lastReadMessageId 필요 — **배치 1쿼리**로 N+1 회피
  (per-channel 금지). 채널 수 cap(50·refreshUserChannelIds) 내라 단일 IN 쿼리 bounded.
- consumeAround 재설계: 기존 aroundReload.spec/channelLru.spec 무회귀 주의. retry/onSuccess 수명이
  react-query 동작에 의존 — 테스트로 고정.
- channel:joined 리스너 중복: 기존 seq 소비처와 충돌 없게(통합 또는 별 리스너·payload 동일).

## DoD

체크리스트 green + standalone container `pnpm verify` + 신규/갱신 unit + ws int green + 7차원 리뷰
fix-forward + fr-matrix FR-RT-22→done + handoff LIVE(**전 partial 해소·진행률 352/354·잔여 deferred 2뿐**) +
자율 배포(auto-deploy.sh·SHA 없이) + `/readyz=200` + 디스크 모니터.
