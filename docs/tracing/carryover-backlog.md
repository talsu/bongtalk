# Carryover 백로그 소화 큐 (2026-06-09~ · 사용자 "모든 내용 자율로 진행해")

워크플로우 검증(wf_7bb9f0b2)으로 carryover.md 147 findings 중 코드-대조 still-open 29 + 경미 ~41 +
조용히-해소 11 확정. 이를 테마별 슬라이스로 묶어 메가루프(IMPLEMENT→7차원 리뷰→VERIFY→머지→자율배포→LIVE)로 소화.

## 큐 (우선순위순)

- [ ] **S98 — carryover 정리(docs)**: 조용히-해소 11건 RESOLVED 마킹(S00 allowMask·parse ReDoS·
      PARSE errorcode·S05 qf-text-danger·S05-v badge/threads RED·S09 FR-RT-22 x2·S11 cuid2·S11-v int·
      S12 FR-CH-03). 배포 없음.
- [x] **S99 — realtime/WS 정확성 번들** (MED/LOW): ① useChannelSync gap-fetch 재시도 setTimeout
      detach 미취소→타이머 Set cleanup(S10) ② refreshUserChannelIds cap 초과 채널 leave(S07)
      ③ MessageDeletedPayload version 필드(S05-v·낙관잠금 baseline) ④ ChannelSeqService NaN 가드(S10)
      ⑤ read_state:updated 웹 소비/useDmCreated Shell 배선(S16·S97 후 재확인).
      → DONE: ① retryTimers Map<channelId,timer> + detach/재예약 clearTimeout ② toLeave=already−fresh
      leave(RemoteSocket.leave 단건) ③ shared-types version optional(후방호환) + service softDelete 동봉
      + dispatcher version baseline 갱신 ④ 서버 parseSeq(Number.isFinite)·클라 setBaseline NaN 가드
      ⑤ read_state:updated 는 이미 dispatcher 완전 소비(스킵)·useDmCreated 미배선→DmShell+MobileDmList 배선.
      host typecheck+vitest unit green, 마이그레이션 없음. user-scope 오프라인 catch-up 갭은 별도 잔여.
      → VERIFY: standalone 컨테이너 verify green(web 220f/1771t·turbo 19/19) + int 2스펙 green
      (messages.events + ws.channel-cap). ws.channel-cap 픽스처 1건 수정(eviction 후보를 비-priority
      공개채널로 한정 — 직전 테스트의 DM override 가 priority 로 고정돼 오집계).
      → 7차원 리뷰(reviewer·security·contract·performance) 후 fix-forward:
        • MEDIUM-1(reviewer): useChannelSync detach 후 in-flight gap-fetch reject 시 scheduleRetry 가
          타이머 부활 → `detached` 플래그로 정착 콜백 무력화 + 회귀 테스트 추가.
        • NIT-2(reviewer): canStillObservePresence 의 stale "only adds, never removes" 주석 정정.
        • contract MED: MessageDeletedPayload 내부 required ↔ wire optional 은 의도된 비대칭(발행측
          강제 vs 후방호환) → message-events.ts 주석으로 명시(타입 변경 없음).
        • perf "serious"(toLeave 직렬 await) + NIT-1(leave 배열 미지원 주석) = 거짓양성: RemoteSocket.leave
          는 반환 void(fire-and-forget·Redis 왕복 블로킹 아님) + 타입상 단일 room(주석 정확). 무변경.
      → 잔여(별도 추적·프리-이그지스팅 LOW 보안): ⓐ channel.updated 로 isPrivate 공개→비공개 전환 시
        refreshChannelIdsForWorkspace 미트리거 → 비구성원 소켓이 룸에 잔존해 fanout 수신(outbox-to-ws
        onChannelEvent 에 isPrivate 변경 분기 추가 필요·S105 흡수). ⓑ message.deleted raw payload 의
        actorId/authorId 채널 룸 전파(wire 스키마엔 없음·기존 동작).
- [ ] **S100 — a11y 번들** (MED): ① gutter-time `:focus-within`(app-layer index.css·DS 4파일 금지)
      ② 메시지 행 article accessible name(aria-label) ③ 유니코드 이모지 폴백 role=img/aria-label(renderAst).
- [ ] **S101 — perf 번들** (MED/LOW): ① MessageItem React.memo + DayDivider memo + time/jumbo useMemo
      ② edit-history ring buffer 단일 DELETE + MessageEditHistory UNIQUE(마이그) ③ blocked-set Redis TTL 캐시(S17).
- [ ] **S102 — DM 갭 번들** (MED): ① DM `/history` 엔드포인트 ② DM rate-limit 3엔드포인트(S16/S19)
      ③ UserBlock 모델 + hidden-restore visibleFrom(S17) ④ DmListItem/DmParticipant shared-types 이관.
- [ ] **S103 — 모바일 편집 UI** (★HIGH): MobileMessages/MobileMessageSheet 편집 개시(useUpdateMessage 배선·FR-MSG-06 모바일).
- [ ] **S104 — 권한 스킴 수렴** (★HIGH·大·신중): shared-types 카탈로그 비트 ↔ auth/permissions 집행 enum
      2중화 제거(같은 override 컬럼·다른 의미·drift). 설계 ADR + 보안 중점 리뷰. **제품/보안 분기 발견 시 사용자 확인.**
- [ ] **S105 — 채널/misc 번들** (MED): announcement canPost 서버플래그+클라(S13)·공개채널 leave 사이드바(S14)·
      비공개 join 403→404(S14)·slowmode SET NX idem-replay 뒤로(S15)·채널 재정렬 드래그UI/WS fanout(S15)·
      channels↔messages↔attachments 순환참조 디커플(S13)·announcement fold 중앙매트릭스(S13).
- [ ] **경미(~41)**: 각 번들에 흡수 가능분 흡수, 잔여는 LOW/NIT carryover 유지.

## 배포 정책

- 작은 docs 슬라이스(S98)는 배포 없음. 코드 슬라이스는 자율 배포(auto-deploy.sh·SHA 없이) + LIVE.
- 인접 소형 번들은 가능하면 develop 에 모아 배포 1회로 묶을 수 있음(빌드 ~6분 절감) — 단 각 슬라이스 VERIFY+리뷰는 개별.

## 진행 로그

(슬라이스 완료 시 [x] + main SHA)
