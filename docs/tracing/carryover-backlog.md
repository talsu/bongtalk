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
- [x] **S100 — a11y 번들** (MED): ① gutter-time `:focus-within`(app-layer index.css·DS 4파일 금지)
      ② 메시지 행 article accessible name(aria-label) ③ 유니코드 이모지 폴백 role=img/aria-label(renderAst).
      → 진단 결과 ②③은 이미 해소: ② MessageItem.tsx:554-558 `role="article"`+`aria-roledescription="메시지"`+
      `aria-label=rowAriaLabel`(head=작성자+시각·continuation=작성자+gutterTime) = S83b 구현. ③ renderAst
      `case 'emoji'` 커스텀이모지는 `<img alt=":name:">`(암묵 role=img + accessible name)로 적절·미해결
      `:name:`은 리터럴 텍스트가 정답(role=img 오용 회피). → 진짜 잔여=①뿐: DS components.css 의
      `.qf-message__gutter-time`(opacity:0·:hover 에서만 1)에 focus-within 규칙 없어 시각 키보드 사용자가
      roving 포커스로 continuation 행을 짚어도 시점이 안 보임(시점은 aria-label 로 SR 엔 전달). → app-layer
      index.css 에 `.qf-message:focus-within .qf-message__gutter-time{opacity:1}`(line 120 toolbar 규칙 미러·
      DS 4파일 무수정). VERIFY green(19/19·web 1772). 배포는 S101 과 묶음(develop 누적).
- [x] **S101 — perf 번들** (MED/LOW): ① MessageItem React.memo + DayDivider memo + time/jumbo useMemo
      ② edit-history ring buffer 단일 DELETE + MessageEditHistory UNIQUE(마이그) ③ blocked-set Redis TTL 캐시(S17).
      → **진단 후 안전·고가치만 구현, 나머지는 measure-first defer**([[project_direction_pivot]] 안정성>perf):
        • **구현**: `DayDivider`→`React.memo`(단일 원시 prop iso·텍스트북-안전·부모 가시행 map 재실행 시 동일 iso
          행 내부 DOM 재렌더 skip). 시각 라벨(headTimeLabel/gutterTime)은 `new Date()` 상대시각이라 memo 시
          stale("2분 전" 고정)→**의도적 미적용**.
        • **defer(문서화)**: ★MessageItem React.memo = 부모 MessageList 가 per-row 인라인 클로저
          (onRowFocus={()=>setFocusedMsgId(m.id)} 등) 다수 전달 → memo 무력화. 효과 내려면 전 prop 참조안정
          대규모 리팩터(critical surface·최다 테스트·고위험) 필요 + **리스트 이미 가상화**(가시 ~25행만 렌더)로
          이득 제한 + 프로파일링 근거 없음. renderAst 본문 useMemo 도 deps(customEmojis.byName·mentions prop)
          참조안정 불확실(stale 멘션/이모지 위험). ② edit-history = **이미 ring-buffer cap(10) enforce**
          (count→findMany→deleteMany·tx·edit cold path)·단일 DELETE 는 Prisma raw 필요·UNIQUE 마이그는
          중복위험 낮아 가치<위험. ③ loadBlockedUserIds = **이미 단일 인덱스 SELECT**(N+1 없음)·Redis TTL
          캐시는 차단/해제 무효화 복잡 + **stale=프라이버시 오마스킹** 위험. → 진짜 병목 측정되면 재개.
- [ ] **S102 — DM 갭 번들** (MED): ① DM `/history` 엔드포인트 ② DM rate-limit 3엔드포인트(S16/S19)
      ③ UserBlock 모델 + hidden-restore visibleFrom(S17) ④ DmListItem/DmParticipant shared-types 이관.
- [x] **S103 — 모바일 편집 UI** (★HIGH): MobileMessages/MobileMessageSheet 편집 개시(useUpdateMessage 배선·FR-MSG-06 모바일).
      → 진짜 갭 확인(`MobileMessages.tsx void updMut` dormant·시트에 편집 액션 없음). 구현: 신규
      `MobileEditSheet`(편집 바텀시트·textarea+저장/취소·trim·빈/변경없음/전송중 비활성·reject 시 유지) +
      MobileMessageSheet "메시지 편집"(isMine·!tmp-·!deleted 게이트) + MobileMessages 배선
      (onSave→`updMut.mutateAsync({msgId,content,expectedVersion})`). 신규 spec 2(MobileEditSheet 7 +
      MobileMessageSheet 2). VERIFY green(web 222f/1781t·typecheck·lint 0err). 마이그 없음.
      → 3차원 리뷰(reviewer·ui-designer·a11y) fix-forward:
        • reviewer HIGH-1(편집 중 409 후 stale expectedVersion 재시도 데드엔드)→onSave 가 시트-오픈
          스냅샷 대신 **현재 캐시(messages memo) 최신 version** 재도출(데스크톱 onEdit Save 동일).
        • ui HIGH/MED(qf-m-composer__send 원형·qf-m-sheet__item 좌정렬 재활용 오용)→저장/취소를
          page-scoped Tailwind+DS 토큰으로 재작성(터치타깃 min-h=44px·raw hex/px 없음).
        • a11y M-1(disabled+aria-disabled 중복)→native disabled 단독·M-2(aria-label+헤딩 중복낭독)→
          aria-labelledby·M-3(저장 중 SR 무알림)→"저장 중…" 텍스트+aria-busy. reviewer NIT-1(stale
          void delMut/reactMut) 제거.
        • **거짓양성 기각**: ui-designer LOW `active:bg-bg-muted` = tailwind.config `'bg-muted':var(--bg-hover)`
          매핑 존재로 **유효**([[reference_tailwind_double_prefix]]·기존 코드 무변경).
      → **잔여(별도 추적)**: ⓐ reviewer MED-1 모바일 편집 시 대규모 멘션(@everyone/@here/@channel) 추가
        409(BULK_MENTION_CONFIRM_REQUIRED) 미배선 → 일반 토스트(데스크톱 SpecialMentionConfirmDialog 미러
        필요·드문 엣지). ⓑ a11y H-1/H-2 모바일 바텀시트 focus 복귀+focus trap = MobileMessageSheet 와
        **공유하는 사전존재 패턴**(전 모바일 시트 일괄 focus-management 유틸 슬라이스·ThreadPanel trap 재사용).
        ⓒ accent 버튼 대비 4.23:1(DS-owner·--accent 토큰·전앱 공통). ⓓ MobileMessages onSave 재도출 통합
        테스트 갭(heavy 하니스).
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
