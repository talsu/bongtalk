# 모바일 UI/UX 전면 감사 (2026-06-10)

> 수행: 핸즈온 투어 3회(Playwright, 390×844 iPhone 14 에뮬레이션, 실제 계정 4개 + 실시간 상대역 API 구동)
>
> - 48-에이전트 정적 감사(PRD 218개 모바일 관련 요구 추출 → 구현 격차 매핑 → HIGH 이상 적대 검증)
> - 기존 모바일 e2e 2종 회귀 실행. 수정 계획: `docs/tasks/071-mobile-uiux-overhaul.md`.
>
> 재현 환경: `docker-compose.e2e-audit.yml`(테스트 스택, 호스트 5432 점유로 pg 포트만 45432 리매핑)
> — `sudo docker compose -p qufox-e2e -f docker-compose.e2e-audit.yml up -d` 후
> `node .tour/setup.mjs`(시드) → `.tour/tour*.mjs`(투어). 스크린샷 증거: `.tour/shots*/`.

## 0. 한 줄 결론

모바일 셸은 task-024~035 시점의 골격에서 멈춰 있고, 그 위에 **(a) 런타임 BLOCKER 2건**(모든
드로어·시트의 탭 차단, 채널 뷰 컴포저 화면 밖 + 상단 앵커), **(b) 데스크톱에만 백포트된 기능 수십
건**(읽음 ACK·검색·타이핑·리액션 표시·첨부 표시 등), **(c) DS 050 모바일 IA 전면 미채택**, **(d) PRD
자체의 모바일 명세 공백·모순 59건**이 쌓여 있다. 모바일 e2e가 어느 게이트에도 없어(vr-parity는
baseline 미시드 fixme) 전부 무증상으로 방치됐다 — 기존 모바일 e2e 2종(drawer-channels,
composer-send)을 현 빌드에서 돌리면 **실제로 실패**한다.

## 1. 핸즈온 BLOCKER (정적 분석이 못 잡는 런타임 결함 — 직접 사용으로 확정)

### H-1 [BLOCKER] 모든 모바일 드로어·바텀시트의 내부 탭이 차단됨 (백드롭 z-스택)

- **증상**: 좌 드로어에서 채널을 탭하면 내비게이션 없이 드로어만 닫힌다. 메시지 롱프레스 시트의
  답장/편집/삭제/빠른반응 어떤 항목도 탭할 수 없고, 탭하면 시트가 무동작으로 닫힌다.
  → 모바일에서 **드로어 기반 채널 이동·메시지 액션 전체가 사용 불능**.
- **원인**: `.qf-m-sheet-backdrop`(z-index `--z-modal-bg`=60)을 패널의 **형제 요소**로 두고 패널엔
  z-index가 없음 → 백드롭이 패널 위를 덮어 모든 포인터 이벤트를 가로채 `onClose`로 보냄.
  DS 목업은 패널을 백드롭의 **자식**(flex justify-end 컨테이너)으로 배치한다.
- **실측 증거** (tour3): `elementFromPoint('답장' 항목 중심)` → `DIV.qf-m-sheet-backdrop`,
  intercepted=true. 실제 터치 탭 → `sheetStillOpen:false, replyBannerShown:false`.
  드로어도 동일: topMost=`mobile-left-drawer-backdrop`, 탭 후 URL 불변.
  `e2e/mobile/drawer-channels.e2e.ts`·`long-press-sheet` 계열이 이 때문에 red.
- **대상 파일**: `apps/web/src/shell/mobile/MobileDrawer.tsx`, `MobileMessageSheet.tsx`,
  `MobileEditSheet.tsx`, `MobileDmList.tsx`(새 DM 시트), `MobileFriends.tsx`(친구 추가 시트).

### H-2 [BLOCKER] /w 경로 채널 뷰: 컴포저 화면 밖 + 최상단(가장 오래된 메시지) 앵커 + 리스트 무스크롤

- **증상**: 드로어/딥링크로 `/w/:slug/:channel` 채널에 들어가면 ① 화면이 **가장 오래된 메시지**에서
  시작하고 ② **컴포저가 보이지 않으며**(전체 히스토리를 끝까지 스크롤해야 나타남) ③ 위로 스크롤
  해도 과거 페이지가 로드되지 않고 ④ 새 메시지 수신 시 아무 표시가 없다.
- **원인**: `MobileShell`이 `MobileMessages`를 `<main class="qf-m-body">`(display:flex 아님, 자체
  스크롤 컨테이너) 안에 렌더 → 리스트의 `flex-1 min-h-0`이 무효화되어 내용 높이만큼 늘어나고,
  내부 스크롤·하단 앵커·스크롤 페치·점프 로직이 전부 죽는다. 같은 `MobileMessages`를
  `.qf-m-screen`(flex column) 직속으로 렌더하는 `MobileOverlay`(홈 ?chat= 경로)·DM 채팅은 정상
  — tour2 실측: 오버레이 진입 시 `scrollTop+clientHeight == scrollHeight`(하단 앵커), 입력창 y=792(가시).
- **대상 파일**: `apps/web/src/shell/MobileShell.tsx` L134 (`<main className="qf-m-body">`).

### H-3 [HIGH] 전 모바일 화면 상단 62px 유령 여백 (`--m-statusbar` 목업 패딩 누출)

- 모든 화면 최상단에 62px 죽은 공백. `.qf-m-screen`의 `padding-top: var(--m-statusbar)`는
  **디바이스 프레임 목업 전용**이고 실앱은 `.qf-m-screen--app`(env safe-area + 100dvh)을 써야
  하는데, 앱 어디에서도 `--app` 수식자를 쓰지 않는다. 실측: 홈 rail boundingBox y=62.
- 대상: `qf-m-screen`을 쓰는 모든 모바일 컴포넌트(MobileShell/Home/Overlay/Activity/DmList/
  DmChat/Friends/Discover/MobileMessages 경유 화면).

### H-4 [HIGH] 모바일 `/dm`이 데스크톱 3컬럼 DmShell로 렌더 — 우측 패널 세로 글자 깨짐

- 워크스페이스 보유 사용자가 `/dm`에 가면 390px에 데스크톱 DmShell이 그대로 떠서 우측 빈 패널
  문구("대화할 친구를 선택하세요")가 한 글자씩 세로로 깨져 표시된다(스크린샷 shots2/09).
  `/dms`(모바일 전용 라우트)는 존재하나 탭바·홈 어디에서도 연결되지 않는다.

### H-5 [HIGH] Discover 카테고리 칩 세로 글자 깨짐

- 9개 카테고리를 균등분할 `qf-m-segment`에 욱여넣어 "프로그래밍"이 8줄 세로 글자가 된다
  (shots/07). DS 용도는 가로 스크롤 `.qf-m-filter-bar`+`.qf-m-filter-chip`.

### H-6 [HIGH] 멤버 드로어 프레즌스 전원 오프라인 (본인 포함)

- 소켓 연결 5초 후에도 멤버 드로어가 "오프라인 — 3"으로 전원(현재 접속 중인 본인 포함)을
  오프라인 처리(shots2/08). 모바일 프레즌스 구독/반영이 끊겨 있다.

### H-7 [HIGH] 모바일 어디에도 검색이 없음 + `/search`는 홈으로 리다이렉트

- 채널 토프바·홈·탭바 어디에도 검색 진입점이 없고 `/search` 직접 진입도 홈으로 튕긴다(tour1
  step33 실측 url=/). PRD FR-S07은 모바일 Jump+복귀를 P0 AC로 명시.

### H-8 [HIGH] Activity 행이 UUID 앞 8자를 사용자명으로 표시 + 탭해도 이동 없음

- "726eb067 님이 DM을 보냄" 식 표기(shots/25). DTO에 `actorName`이 이미 있고(S47에서 데스크톱은
  "actorId.slice 노출 금지"로 고침) 모바일만 `actorId.slice(0,8)` 잔존(MobileActivity L141·145).
- DM 알림은 `if (slug)` 가드로 탭이 무동작, 채널 알림도 `/w/:slug?msg=`로 보내지만 MobileShell이
  `?msg=`를 소비하지 않아 "채널을 선택하세요" 빈 화면에 떨어진다.

### H-9 [MED] 홈 DM 목록: 미읽음 뱃지·시간·프레즌스 없음 + 프리뷰 미갱신 + 새 DM 버튼 없음

- 새 DM 수신 직후에도 행에 뱃지/시간이 없고 프리뷰가 옛 메시지로 남는다(shots3/06). 새 DM 시작
  FAB은 연결 안 된 `/dms`에만 있다. DS 'DMs Inbox' 목업(핀/미읽/시간/프레즌스/FAB)과 대조적.

### H-10 [MED] 설정: 모바일에서 다른 설정 페이지로 갈 방법이 없음

- `/settings` 진입 시 사이드바 링크 **DOM 0개**, back 후보 0개(tour3 step08 실측), 탭바도 없음.
  탭바 '설정' 목적지도 화면마다 다름(/settings vs /settings/notifications). '나' 탭(FR-IA-MOB-06,
  프로필 카드+설정 목록 드릴다운)은 미구현.

### H-11 [MED] 기타 핸즈온 관찰

- 일반 미읽음에 danger(빨강) 카운트 뱃지 사용 — PRD/DS는 일반=violet·볼드, 카운트 뱃지=멘션 전용
  의미 분리 (드로어 채널행·탭바 공통).
- 메시지 그루핑 전무: 같은 작성자 연속 메시지 전부에 아바타+이름+시간 반복(`--head/--cont` 미사용).
- 멘션 자동완성 없음: 컴포저에 '@' 입력해도 무반응(shots2/05).
- 컴포저 + (첨부) 버튼 onClick 미배선 — 죽은 컨트롤.
- 미읽음 구분선·jump-to-bottom 버튼 모바일 전무(스크롤 업 중 새 메시지 수신 시 아무 안내 없음,
  tour3 step04: jumpBtnCount=0).
- 워크스페이스 새로 만들기 모달이 데스크톱 폼(SLUG·도메인 화이트리스트 포함) 그대로 — PRD는
  모바일 `.qf-m-modal--fullscreen` 패턴.
- 가로(844×390)에서는 폰에서 데스크톱 4컬럼 셸이 뜸(767px 경계). 회전 시 비반응 분기
  (/activity·/friends·/discover는 matchMedia 1회 평가)와 결합해 셸 불일치 발생 가능.
- 채널 진입 시 읽음 ACK이 가지 않아 드로어 미읽음 카운트가 읽은 뒤에도 계속 증가(shots/17 —
  general을 읽고 있는 중에도 37 유지). ※ 정적 감사 A-항목과 교차 확정.
- 로그인/인증 부속 화면의 qufox 워드마크가 겹쳐 깨져 보임(LOW), 친구 segment 라벨 "모든"(어색,
  "전체" 권장), DM 컴포저 placeholder가 "# <사용자명>"(채널 프리픽스 오용), 영문 잔재
  ("loading…", "Activity", "All").
- 콘솔에 401 노이즈(초기 로드 토큰 race) 16건 — 기능 영향은 미관측(LOW).

## 2. 검증 게이트 공백 (왜 이 지경까지 무증상이었나)

1. 모바일 e2e(`apps/web/e2e/mobile/*`)는 push gate(pre-push는 unit만)·CI 필수 체크 어디에도
   강제되지 않는다. 현 빌드에서 `drawer-channels`·`composer-send` **2종 실측 red**.
2. `vr-parity.e2e.ts`(모바일 시각 회귀)는 baseline이 한 번도 시드되지 않아 `test.fixme`로 영구
   skip (TODO(task-049-follow-vr-parity-baseline) 방치).
3. a11y/axe CI 대상에 모바일 표면(탭바/드로어/시트) 없음 (PRD 결함 D-12와 동일 맥락).
4. fr-matrix가 모바일 미구현 FR을 done으로 오표기 (FR-S07, FR-P04, FR-P17, FR-PS-05 확인됨)
   → "all buildable FR done" 집계가 모바일 절반-구현을 가렸다.

<!-- 이하 섹션 A~D는 48-에이전트 정적 감사 결과 자동 렌더 (render-audit.mjs) -->

## A. 확정 발견 (적대 검증 통과 BLOCKER/HIGH — 1·2차 런 병합 53건)

> 2차 런(PRD 전반부 FR 매핑 재실행) 항목 일부는 1차 항목과 같은 결함을 FR 관점에서 재확인한
> 것이다(반응 칩·검색·타이핑·시트 액션 등). 2차 검증이 세션 리밋으로 끊긴 HIGH는 전부 1차 확정
> 목록이 커버함을 대조 확인했다. B 섹션(200건)은 양 런 합집합이라 주제 중복이 일부 있다.

### A-1 [BLOCKER][prd-gap] 모바일 메시지에서 첨부·OG embed 가 전혀 렌더되지 않음 — 타인이 보낸 이미지/비디오/링크 카드가 완전 비가시

- **영역**: D11/D16 — 첨부·embed 렌더 (FR-AM-07/09, FR-AM-08, FR-AM-13/16, FR-AM-19, FR-AM-25, FR-RC19·21)
- **내용**: MobileMessageRow 본문은 renderMessageContent(msg.content) 텍스트만 렌더합니다. 데스크톱 MessageItem 이 사용하는 AttachmentsList(Mosaic 그리드)·LinkPreview(OG embed)·스포일러 오버레이·처리중 skeleton 이 모바일 경로에 전무해, 이미지 모자이크(FR-AM-07/09 — 모바일 축소 그리드 명시), 비디오 다운로드 카드(FR-AM-08), embed 축약 카드(FR-AM-13/16 — 모바일 축약 명시), 스포일러 블러(FR-AM-19), 처리중 플레이스홀더(FR-AM-25), embed fallback(FR-RC21) 전부가 모바일에서 표시되지 않습니다. 첨부만 있는 메시지는 모바일에서 빈 행으로 보입니다 — 콘텐츠 무손실 원칙 위반 수준의 갭입니다.
- **근거**: apps/web/src/shell/mobile/MobileMessages.tsx:379 (본문 = renderMessageContent 만), apps/web/src/features/messages/MessageItem.tsx:24-26,800-818 (데스크톱 AttachmentsList/LinkPreview)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/attachments/AttachmentsList.tsx, apps/web/src/features/messages/LinkPreview.tsx
- **제안 수정**: MobileMessageRow 본문 아래 AttachmentsList(폭 축소 변형)·LinkPreview(compact 변형) 마운트 — 기존 컴포넌트가 DS 토큰 기반이라 재사용 가능

### A-2 [HIGH][prd-gap] 모바일 메시지 검색 기능 전체 부재 — 결과 카드·Jump·정렬·페이지네이션·입력 게이트 전부 missing

- **영역**: D07 검색 (FR-S06·S07·S08·S09·S13)
- **내용**: 메시지 검색 진입점이 데스크톱 전용입니다. SearchInput 은 MessageColumn(데스크톱 채널 헤더), SearchResultPanelContainer 는 DesktopShell 우측 슬롯에만 마운트되고, 모바일 트리(MobileShell/MobileMessages/MobileChannelList)에는 검색 UI 가 전혀 없습니다(MobileChannelList 의 qf-m-search 는 채널명 로컬 필터일 뿐). 따라서 FR-S07 의 명시적 모바일 AC(Jump 후 채널 전환 + 뒤로가기로 결과 복귀, Playwright 모바일 viewport)는 검증 대상 자체가 없으며, FR-S06 결과 카드·FR-S08/S09 정렬·더보기·FR-S13 클라이언트 게이트(searchQueryGate 는 공유 코드로 존재)도 모바일 표면이 없습니다. 데스크톱에는 있는데 모바일에 없는 표면입니다.
- **근거**: apps/web/src/shell/MessageColumn.tsx:27 (SearchInput import — 데스크톱 전용), apps/web/src/shell/Shell.tsx:14 (SearchResultPanelContainer — DesktopShell), apps/web/src/shell/mobile/MobileChannelList.tsx:76-89 (채널명 필터만), apps/web/src/shell/MobileShell.tsx:103-148 (검색 진입점 없음)
- **파일**: apps/web/src/shell/MobileShell.tsx, apps/web/src/features/search/SearchInput.tsx, apps/web/src/shell/MessageColumn.tsx
- **제안 수정**: 모바일 토프바에 검색 액션 추가 → qf-m-screen 전체화면 검색 화면(결과 카드는 데스크톱 SearchResultPanel 뷰모델 재사용) + Jump 시 MobileShell 채널 라우팅·하이라이트·back 복귀 구현

### A-3 [HIGH][prd-gap] 모바일 상태 변경/커스텀 상태 설정 UI 부재 — '내 상태 헤더(qf-m-you-\*)' 미구현, 만료 프리셋 picker 는 전 플랫폼 UI 없음

- **영역**: D08/D14 — 커스텀 상태·상태 변경 UI (FR-P04·P17, D08 FR-P17 picker, D14 §커스텀 상태, FR-PS-03·05 일부, FR-PS-17)
- **내용**: 상태 수동 변경 UI 는 데스크톱 BottomBar 드롭다운(online/dnd, invisible disabled)뿐이고 모바일 트리에는 진입점이 전혀 없습니다(탭바 '나' 탭 없음, qf-m-you-\* DS 클래스 미사용). 커스텀 상태(text+emoji+만료 프리셋 6종) 편집 UI 는 useCustomStatus 훅(preset/timezone 지원)만 존재하고 데스크톱·모바일 어디에도 편집기가 없습니다 — ProfileSettingsPage 의 '커스텀 상태' 섹션은 '만료 시 DND 활성화' 토글 단 1개입니다. FR-PS-03 의 핸들 D-N 표기는 구현돼 있으나(설정→프로필, 모바일 접근 가능) '☕ 점심 중' 상태 행 표시·편집은 없습니다.
- **근거**: apps/web/src/shell/BottomBar.tsx:31-80 (데스크톱 전용, online/dnd 만), apps/web/src/features/settings/ProfileSettingsPage.tsx:600-615 (DND 토글만), apps/web/src/features/presence/useCustomStatus.ts:7-15 (훅만 존재), apps/web/src/shell/mobile/MobileTabBar.tsx:32-53 (나/상태 진입점 없음)
- **파일**: apps/web/src/shell/BottomBar.tsx, apps/web/src/features/presence/useCustomStatus.ts, apps/web/src/features/settings/ProfileSettingsPage.tsx
- **제안 수정**: 상태 변경 바텀시트(온라인/자리비움/DND/오프라인 표시 + 커스텀 상태 text/emoji/만료 프리셋 6종)를 신설하고 모바일 설정 목록 상단에 '내 상태 헤더' 행으로 진입점 부여; 데스크톱 BottomBar 드롭다운에도 동일 편집기 연결

### A-4 [HIGH][prd-gap] 모바일 타이핑 인디케이터 양방향 부재 — 표시도 안 되고 발행도 안 함

- **영역**: D08/D17 — 타이핑 표시 (FR-P07, D08 typing:update AC, D17 [D] FR-RT-08·09)
- **내용**: TypingIndicator 는 데스크톱 MessageColumn 에만 마운트됩니다. MobileMessages 에는 타이핑 바가 없어 타인의 입력 중 상태(최대 3명/'외 N명')가 전혀 보이지 않고, MobileComposer 의 onChange 는 setDraft 만 호출해 typingEmitter(3초 스로틀 typing:start)도 배선되지 않아 모바일 사용자는 타이핑 신호를 발행하지도 않습니다. D17 모바일 mock(컴포저 위 타이핑 바)에 명시된 표면입니다.
- **근거**: apps/web/src/shell/MessageColumn.tsx:23 (TypingIndicator — 데스크톱 전용), apps/web/src/shell/mobile/MobileMessages.tsx:447-463 (onChange 에 typing emit 없음, 타이핑 바 미렌더)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/typing/TypingIndicator.tsx, apps/web/src/features/typing/typingEmitter.ts
- **제안 수정**: MobileComposer onChange 에 typingEmitter 배선 + 메시지 목록과 컴포저 사이에 TypingIndicator 재사용 마운트

### A-5 [HIGH][prd-gap] 모바일에서 읽음 ACK 를 전혀 보내지 않음 — 모바일로 읽어도 미읽/멘션 배지가 영구 잔존

- **영역**: D09/D17 — 읽음 ACK (FR-RS-01/RS-02, D17 [F] FR-RT-13·14·21)
- **내용**: 커서 ACK(AckScheduler+useAckChannelRead, 5초 디바운스/하단 즉시 발화)와 진입 markRead 는 데스크톱 MessageColumn 에만 배선돼 있습니다. 모바일 채팅 3경로(MobileShell 채널, MobileOverlay, MobileDmChat) 어디에서도 ack/read 계열 호출이 없어, 모바일에서 채널·DM 을 읽어도 서버 read state 가 갱신되지 않고 본인 채널 목록 배지·타 기기 배지가 사라지지 않습니다(역방향 read_state:updated 수신·반영은 dispatcher 공유로 동작). 스크롤 위치 기반 정책(FR-RS-01/02)도 당연히 부재합니다.
- **근거**: apps/web/src/shell/MessageColumn.tsx:268-330 (AckScheduler — 데스크톱 전용), useAckChannelRead/useMarkChannelRead 사용처 grep → MessageColumn/ChannelList/UnreadsView 만, apps/web/src/shell/mobile/MobileMessages.tsx:92-134 (스크롤 핸들러에 ack 없음)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/shell/MessageColumn.tsx, apps/web/src/features/channels/useUnread.ts, apps/web/src/features/messages/ackScheduler.ts
- **제안 수정**: MobileMessages 에 AckScheduler 재사용 배선(wasAtBottomRef 판정을 onReadCursor 로 연결, workspaceId null DM 은 데스크톱과 동일 정책으로 스킵 또는 DM ack 경로 추가)

### A-6 [HIGH][prd-gap] .qf-m-unread-divider 미사용 — 모바일에 첫 미읽 구분선·이어보기 스크롤 없음 (데스크톱은 구현)

- **영역**: D09 — NEW MESSAGES 구분선 (FR-RS-06, D17 [F] 모바일 mock)
- **내용**: 데스크톱 MessageList 는 dividerIndex 산정 + NewMessagesDivider 렌더 + read_state 재계산을 구현했지만, 모바일 MobileMessages 는 항상 최하단 anchoring 만 하고 구분선 렌더·lastReadMessageId 기준 위치 계산이 전혀 없습니다. DS 의 모바일 전용 클래스 .qf-m-unread-divider 는 앱 전체에서 0회 사용입니다(명시적 모바일 요구).
- **근거**: apps/web/src/features/messages/MessageList.tsx:1359-1375 (데스크톱 NewMessagesDivider + 'qf-m-unread-divider 만 존재' 주석), apps/web/src/shell/mobile/MobileMessages.tsx:104-123 (무조건 bottom anchor), grep 'qf-m-unread-divider' → 사용 0건
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/MessageList.tsx
- **제안 수정**: MessageList 의 divider 인덱스 산정 로직을 공유 추출해 MobileMessages 에 .qf-m-unread-divider 행 삽입 + 초기 스크롤을 divider 기준으로 변경

### A-7 [HIGH][prd-gap] 모바일 메시지 액션에 '채널에 고정'/'저장' 토글 부재 + 핀 시스템 메시지 구분 렌더·점프 없음

- **영역**: D10 — 핀/저장 토글 (FR-PS-01/02/13)
- **내용**: MobileMessageSheet 액션은 답장/스레드/복사/편집/삭제 + 퀵리액션 5종뿐 — 핀/저장(북마크) 토글이 없어 모바일에서 핀·저장 자체가 불가합니다. 또한 MobileMessageRow 는 메시지 type 분기가 없어 SYSTEM*PIN('고정된 메시지 보기' 점프 포함) 시스템 메시지가 일반 텍스트 행으로 렌더되고 점프 액션이 없습니다(데스크톱 MessageList 는 SYSTEM*\* 독립 행 + 점프 처리).
- **근거**: apps/web/src/shell/mobile/MobileMessageSheet.tsx:83-148 (핀/저장 부재), apps/web/src/shell/mobile/MobileMessages.tsx:340-381 (type 분기 없음), apps/web/src/features/messages/MessageList.tsx:1026-1067 (데스크톱 SYSTEM_PIN 처리)
- **파일**: apps/web/src/shell/mobile/MobileMessageSheet.tsx, apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: 시트에 핀/저장 토글 추가(기존 핀·저장 훅 재사용) + MobileMessageRow 에 SYSTEM\_\* 렌더 분기

### A-8 [HIGH][prd-gap] 모바일 저장함 진입점 전무 — SavedEntry/SavedView 가 데스크톱 ChannelColumn 사이드바 전용

- **영역**: D10 — 개인 저장함 (FR-PS-07/08/11/12)
- **내용**: '저장됨' 진입점(SavedEntry, IN_PROGRESS 카운트 뱃지)과 3탭 SavedView(보관/완료/삭제, [삭제된 메시지] 렌더, 500개 한도 안내)는 데스크톱 사이드바에만 마운트됩니다. 모바일 어디에도 저장함 화면·진입점이 없어 D10 의 모든 저장함 FR 이 모바일에서 도달 불가입니다.
- **근거**: apps/web/src/shell/ChannelColumn.tsx:160-161 (SavedEntry — 데스크톱), 모바일 트리 grep 'Saved' → 0건
- **파일**: apps/web/src/features/saved/SavedView.tsx, apps/web/src/shell/ChannelColumn.tsx
- **제안 수정**: 모바일 저장함 화면 신설(SavedView 훅 재사용) + 홈/설정 또는 채널 드로어에 진입 행

### A-9 [HIGH][prd-gap] 모바일 리마인더 설정 바텀시트 미구현 — ReminderModal 은 데스크톱 모달 단일형, 저장함 부재로 진입 자체 불가

- **영역**: D10 — 리마인더 (FR-PS-09/10 + Mock 4 모바일 시트)
- **내용**: PRD Mock 4 는 모바일 바텀시트(핸들+2×2 프리셋+datetime-local+풀폭 설정 버튼)를 명시하지만 ReminderModal 은 단일(데스크톱) 모달이며 qf-m-sheet 변형이 없습니다. 더구나 모바일에는 저장함 표면이 없어 리마인더 설정 진입로 자체가 없습니다. 발화 토스트('지금 보기'/'10분 후 다시')도 ToastViewport 미마운트 화면(별도 finding)에서는 보이지 않습니다.
- **근거**: apps/web/src/features/saved/ReminderModal.tsx:10 (단일 모달, qf-m-sheet 미사용), grep 'qf-m-sheet' in features/saved → 0건
- **파일**: apps/web/src/features/saved/ReminderModal.tsx
- **제안 수정**: 모바일 저장함 신설 시 ReminderModal 에 mobile 변형(qf-m-sheet) 추가

### A-10 [HIGH][prd-gap] 모바일 첨부 업로드 전 경로 부재 — + 버튼이 onClick 미배선 죽은 컨트롤 (명시적 모바일 요구)

- **영역**: D11 — 업로드 경로 (FR-AM-01, FR-AM-02/22/28, FR-AM-24, D11 Edge MinIO)
- **내용**: D11 '모바일 UX 핵심' 콜아웃이 '+ 버튼 탭→시스템 파일 피커'를 명시하지만 mobile-composer-plus 버튼에는 onClick/file input 이 없습니다. 따라서 Preview Tray·진행률·실패 재시도·FAILED 복원(FR-AM-02/22/28), READY 전 전송 비활성·낙관 ObjectURL(FR-AM-24), MinIO 503 비활성+토스트(D11 Edge)까지 모바일에서 전부 도달 불가입니다. 데스크톱 MessageComposer 는 useAttachmentUpload/AttachmentTray 로 전체 구현돼 있습니다.
- **근거**: apps/web/src/shell/mobile/MobileMessages.tsx:439-445 (onClick 없는 plus 버튼), apps/web/src/features/attachments/AttachmentTray.tsx (데스크톱 트레이), apps/web/src/shell/MessageColumn.tsx:120-127 (데스크톱 onFiles 배선)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/attachments/useAttachmentUpload.ts
- **제안 수정**: plus 버튼에 hidden <input type=file multiple> 연결 + useAttachmentUpload/AttachmentTray 를 모바일 컴포저 위에 마운트, send 게이트에 READY 검사 추가

### A-11 [HIGH][prd-gap] 모바일 라이트박스 슬라이드쇼 부재 — 그리드 셀 탭 진입 명시 요구 미충족 (그리드 자체도 없음)

- **영역**: D11 — 라이트박스 (FR-AM-10/11/12/25 + 접근성 체크리스트)
- **내용**: ImageLightbox(전체화면, N/M 카운터, 다운로드/닫기, SVG 다운로드 전용, READY 필터, dialog focus-trap)는 데스크톱 AttachmentsList 경유로만 열립니다. 모바일은 첨부 렌더 자체가 없어 콜아웃의 '그리드 셀 탭→전체화면 슬라이드쇼'가 성립하지 않고, D11 접근성 체크리스트(라이트박스 dialog 패턴 등)도 모바일에서 검증 불가입니다.
- **근거**: apps/web/src/features/attachments/ImageLightbox.tsx (존재하나 모바일 경로 미연결), apps/web/src/shell/mobile/MobileMessages.tsx:379 (첨부 미렌더)
- **파일**: apps/web/src/features/attachments/ImageLightbox.tsx, apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: 첨부 렌더 도입 시 ImageLightbox 재사용(이미 dialog/focus-trap 구현) — 모바일 스와이프 탐색만 보강

### A-12 [HIGH][prd-gap] 모바일 메시지 '신고' 진입점 부재 — ReportModal 은 데스크톱 MessageItem 메뉴 전용

- **영역**: D12 — 신고 제출 (FR-RM11)
- **내용**: 모든 멤버의 신고 제출(카테고리+설명, 중복 409) UI 인 ReportModal 은 데스크톱 MessageItem/MessageList 에만 배선돼 있습니다. MobileMessageSheet 에 '신고' 항목이 없어 모바일 사용자는 어떤 메시지도 신고할 수 없습니다.
- **근거**: ReportModal 사용처 grep → features/messages/MessageItem.tsx·MessageList.tsx·moderation/ReportQueuePanel.tsx 만, apps/web/src/shell/mobile/MobileMessageSheet.tsx:83-148 (신고 항목 없음)
- **파일**: apps/web/src/shell/mobile/MobileMessageSheet.tsx, apps/web/src/features/messages/ReportModal.tsx
- **제안 수정**: 시트에 '신고' 항목 추가 → ReportModal 재사용(또는 qf-m-sheet 변형)

### A-13 [HIGH][prd-gap] 모바일 슬래시 커맨드 전무 — '/' 자동완성 시트 없음, /status·/dnd·/remind 모바일 사용 불가

- **영역**: D15 — 슬래시 커맨드 (FR-SC-01~03, FR-SC-05·06, FR-A11Y-01)
- **내용**: composerSlash(300ms 자동완성·퍼지 필터·ARIA listbox)는 데스크톱 MessageComposer 전용입니다. 모바일 컴포저는 plain input 이라 '/' 입력 시 아무 팝업이 없고(Edge cases 의 '모바일에서도 동작' 명시 위반), ephemeral 응답·/remind 설정도 모바일에서 불가합니다. 자동완성 부재로 FR-A11Y-01 공용 announcer 도 모바일에서 적용 대상이 없습니다. reminder:fire 글로벌 토스트는 dispatcher 공유지만 ToastViewport 미마운트 화면(별도 finding)에서는 보이지 않습니다.
- **근거**: apps/web/src/features/messages/composerSlash.ts (데스크톱 컴포저 전용), apps/web/src/shell/mobile/MobileMessages.tsx:447-463 (plain input, 자동완성 없음)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/composerSlash.ts
- **제안 수정**: 모바일 컴포저에 composerSlash 상태 재사용 + qf-m-sheet\_\_item 목록형 자동완성(.qf-m-autocomplete 포지셔닝) 추가

### A-14 [HIGH][prd-gap] @/#/: 자동완성이 모바일 컴포저에 전무 — .qf-m-autocomplete·visualViewport maxHeight 로직 0건

- **영역**: D16 — 자동완성 (FR-RC03~05, FR-RC06 + AC)
- **내용**: 멘션(@, @here/@channel 포함)·채널(#)·이모지(:) 자동완성과 대량 멘션 확인 모달은 데스크톱 컴포저 전용입니다. 모바일 input 에는 세 트리거 모두 동작하지 않고, DS .qf-m-autocomplete 클래스는 앱 전체 0회 사용이며 명시 AC(가상 키보드 위 배치 + visualViewport maxHeight 재계산, Combobox ARIA)가 미구현입니다. useVisualViewport 류 공통 훅도 자동완성용으로는 없습니다(useKeyboardDodge 는 컴포저 위치만 보정).
- **근거**: grep 'qf-m-autocomplete' → 0건, apps/web/src/features/messages/autocomplete/ (데스크톱 전용 디렉터리), apps/web/src/shell/mobile/MobileMessages.tsx:447-463
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/autocomplete
- **제안 수정**: 자동완성 상태 훅을 공유 추출해 모바일 컴포저 위 .qf-m-autocomplete 리스트 렌더 + visualViewport 리스너로 maxHeight 산출

### A-15 [HIGH][prd-gap] 모바일 행이 sendState 를 무시 — '전송 중' 표시도 '전송 실패+재시도'도 없어 실패 메시지를 복구할 수 없음

- **영역**: D17 — 낙관적 전송 상태 (FR-RT-05)
- **내용**: useSendMessage 는 캐시에 sendState('pending'/'failed')와 clientNonce 재시도 경로를 제공하고 데스크톱 MessageItem 은 pending dim + msg-send-failed/msg-retry 를 렌더합니다. MobileMessageRow 는 sendState 분기가 전혀 없어 전송 중 시각 피드백(모바일 mock 명시)이 없고, 실패 시에도 정상 메시지처럼 보이며 재시도 수단이 없어 사용자는 실패를 인지하지 못합니다.
- **근거**: apps/web/src/features/messages/useMessages.ts:321-413 (sendState 캐시), apps/web/src/features/messages/MessageItem.tsx:203-205,775-790 (데스크톱 retry UI), apps/web/src/shell/mobile/MobileMessages.tsx:340-381 (분기 없음)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: MobileMessageRow 에 sendState==='pending' dim+시계 아이콘, 'failed' 시 '전송 실패·재시도' 버튼(동일 clientNonce 재전송) 추가

### A-16 [HIGH][prd-gap] ToastViewport 가 MobileShell(slug 분기)에만 마운트 — 홈/오버레이 채팅/DM/활동/친구/찾기/설정 모바일 화면에서 모든 토스트가 무음

- **영역**: 횡단 — 토스트 표면 (FR-RS-18 Undo, FR-RT-23, FR-SC-06, D10 리마인더 토스트 등)
- **내용**: ToastViewport 마운트 지점은 Shell(데스크톱)/DmShell/DiscoverShell/MobileShell 의 slug 분기 return 뿐입니다. MobileShell 이 slug 없이 MobileHome 으로 위임하는 경로와 MobileActivity·MobileDmList·MobileDmChat·MobileFriends·MobileDiscover·SettingsShell(모바일) 트리에는 토스트 뷰포트가 없습니다. 따라서 mark-all-read Undo(5초), 재연결 SYNC_FAILED/truncated 안내, 리마인더 발화(지금 보기/10분 후 다시), 편집 충돌 안내 등 토스트 의존 UX 가 모바일 대부분의 화면에서 표시되지 않습니다.
- **근거**: ToastViewport 사용처 grep → shell/Shell.tsx, DmShell.tsx, DiscoverShell.tsx, MobileShell.tsx 만; apps/web/src/shell/MobileShell.tsx:81-83 (MobileHome 위임 — 뷰포트 미포함 경로), apps/web/src/shell/mobile/MobileHome.tsx (ToastViewport 없음)
- **파일**: apps/web/src/shell/mobile/MobileHome.tsx, apps/web/src/shell/mobile/MobileDmChat.tsx, apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/App.tsx
- **제안 수정**: ToastViewport 를 App 루트(ConnectionBanner 옆)로 1회 마운트하고 셸별 중복 마운트 제거

### A-17 [HIGH][ds-deviation] 프로덕션 화면 전부가 bare .qf-m-screen 사용 — 목업 전용 62px 상태바 패딩 상속, .qf-m-screen--app 미적용

- **영역**: 모바일 셸 전역 (모든 qf-m-screen 화면)
- **내용**: DS .qf-m-screen 은 padding-top: var(--m-statusbar)=62px 를 기본 포함하며 주석으로 '디바이스 프레임 목업 전용' 임을 명시합니다. 프로덕션은 .qf-m-screen--app(padding-top: env(safe-area-inset-top) + @supports height:100dvh 키보드 셸 축소)을 적용해야 합니다. 그러나 구현 11개 화면(MobileShell/Home/Activity/DmList/DmChat/Friends/Discover/Overlay/SettingsShell 모바일 분기) 전부 bare qf-m-screen 이고, src 전체에서 --app/--bare 사용이 0건이며 index.html 이 mobile.css 를 직링크하므로 모든 모바일 화면 상단에 62px 죽은 패딩이 실제 적용됩니다. 동시에 topbar 의 qf-m-safe-top 과 중복되고, 100dvh 키보드 축소도 미적용(useKeyboardDodge 가 컴포저만 보정).
- **근거**: design-system/mobile.css:15 (--m-statusbar 'device-frame mockups only'), :43-46 (.qf-m-screen padding-top), :1014-1023 (--app 프로덕션 변형 + 100dvh); MobileShell.tsx:104, MobileHome.tsx:78, MobileActivity.tsx:60, MobileDmList.tsx:51, MobileDmChat.tsx:50, MobileFriends.tsx:48, MobileDiscover.tsx:61, MobileOverlay.tsx:100, SettingsShell.tsx:78·87 모두 bare; grep 'qf-m-screen--app|--bare' in src = 0건; apps/web/index.html:23 mobile.css 링크
- **파일**: apps/web/public/design-system/mobile.css, apps/web/src/shell/MobileShell.tsx, apps/web/src/shell/mobile/MobileHome.tsx, apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/shell/mobile/MobileDmList.tsx, apps/web/src/shell/mobile/MobileDmChat.tsx, apps/web/src/shell/mobile/MobileFriends.tsx, apps/web/src/shell/mobile/MobileDiscover.tsx, apps/web/src/shell/mobile/MobileOverlay.tsx, apps/web/src/features/settings/SettingsShell.tsx
- **제안 수정**: 모든 모바일 화면 루트를 `qf-m-screen qf-m-screen--app` 으로 교체(DS 무수정·클래스 추가만). topbar 의 qf-m-safe-top 중복 여부를 화면별로 정리하고, 100dvh 적용 후 useKeyboardDodge 와의 이중 보정을 검증합니다.

### A-18 [HIGH][ds-deviation] DS OverlappingPanels(qf-m-panels) 3패널 패턴 전면 미구현 — MobileDrawer 는 무애니메이션 정적 오버레이

- **영역**: 워크스페이스 채널 — 좌/우 드로어
- **내용**: DS 는 qf-m-panels/--show-left/--show-right/--dragging/--snapping + qf-m-panel-left(--w-drawer-left)/center/right(--w-memberlist) + qf-m-drawer-scrim(var(--scrim))으로 드래그 추종·60px 커밋·|vx|>500px/s fling·center 평행이동·--m-panel-dur(slow)/--m-panel-ease 모션을 규정합니다. 구현 MobileDrawer 는 (1) 해당 클래스 전부 미사용(grep 0건), (2) 패널 폭 width:'86%', maxWidth:'360px' 하드코딩(--w-drawer-left/--w-memberlist 토큰 비매핑), (3) 스크림으로 qf-m-drawer-scrim 대신 바텀시트용 qf-m-sheet-backdrop(rgba(10,8,30,.6), flex-end 컬럼) 오용, (4) open=false 시 return null 이라 슬라이드 전환 자체가 없음, (5) 엣지 드래그/fling 으로 드로어를 열 수 없음(토프바 버튼 탭만), (6) z-[var(--z-modal,60)] 로 DS z-drawer(15)/z-tabbar(40) 적층 규약과 다른 층 사용. 패널 배경도 DS bg-panel 대신 bg-bg-subtle.
- **근거**: MobileDrawer.tsx:32 (if !open return null), :37 (z-modal), :43 (qf-m-sheet-backdrop), :48-52 (width 86%/360px, bg-bg-subtle); mobile.css:412-491 (qf-m-panels·scrim 스펙), tokens.css:123·126 (z-drawer 15 < z-tabbar 40); src 전체 grep qf-m-panels/qf-m-drawer-scrim = 0건
- **파일**: apps/web/src/shell/mobile/MobileDrawer.tsx, apps/web/public/design-system/mobile.css
- **제안 수정**: 최소 수정: 패널 폭을 var(--w-drawer-left)/var(--w-memberlist)로, 스크림을 qf-m-drawer-scrim(var(--scrim))으로, 열림/닫힘에 transform 전환(--m-panel-dur/--m-panel-ease)을 부여. 완전 정합: qf-m-panels 3패널 구조 + 포인터 드래그(--dragging/--snapping, 60px 커밋, fling) 도입.

### A-19 [HIGH][ds-deviation] 모바일 메시지 행에 리액션 칩 미렌더 — 타인 반응이 모바일에서 보이지 않음

- **영역**: 채널/DM 채팅 — 메시지 행
- **내용**: DS Channel 목업은 qf-m-msg\_\_body 안에 qf-reactions/qf-reaction(--me 변형 포함) 칩을 명시하고, DS 는 모바일용 qf-m-react-row/qf-m-react-chip 도 제공합니다. 구현 MobileMessageRow 는 avatar/meta/body 만 렌더하고 msg.reactions 는 시트의 byMe 토글 판정에만 사용됩니다. 결과적으로 데스크톱에서 단 반응이 모바일에서 전혀 표시되지 않고, 모바일에서 퀵리액션을 보내도 시각 피드백이 없습니다(qf-m-react-toast 더블탭 토스트도 미구현, grep 0건).
- **근거**: MobileMessages.tsx:340-381 (MobileMessageRow — reactions 렌더 없음), :185 (reactions 는 byMe 판정만); mobile-mockups.jsx:145-148 (모바일 메시지 내 qf-reactions 칩); mobile.css:324-337 (react-row/chip), :582-601 (react-toast); grep qf-m-react-row/chip/toast = 0건
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/public/design-system/mobile-mockups.jsx
- **제안 수정**: MobileMessageRow 의 \_\_body 아래에 데스크톱과 동일한 qf-reactions 칩 렌더(탭=토글)를 추가합니다. 더블탭 quick-react + qf-m-react-toast 는 후속으로.

### A-20 [HIGH][ds-deviation] 모바일에서 첨부 이미지 미표시(qf-m-img-grid 미사용) + 컴포저 + 버튼 onClick 미배선

- **영역**: 채널/DM 채팅 — 첨부
- **내용**: DS 는 메시지 내 이미지 첨부용 qf-m-img-grid(--1/--3/--4, **more '+N')를 규정하지만 모바일 메시지 행은 renderMessageContent(텍스트/멘션)만 렌더하고 attachments 를 전혀 참조하지 않습니다(데스크톱 AttachmentsList 는 모바일 미사용). 또한 qf-m-composer**plus(첨부 진입점)는 type=button 에 onClick 이 없는 죽은 컨트롤입니다. 결과: 모바일 사용자는 첨부를 보지도, 보내지도 못합니다. DS qf-m-composer\_\_accessory(카메라 등 액세서리 바)도 미구현(grep 0건).
- **근거**: MobileMessages.tsx:379 (body 는 renderMessageContent 만), :439-446 (mobile-composer-plus — onClick 없음); shell/mobile 전체 grep 'attachments' = 0건(렌더 없음); mobile.css:603-628 (img-grid), :630-647 (composer accessory); features/messages/AttachmentsList.tsx 는 데스크톱 전용
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/AttachmentsList.tsx, apps/web/public/design-system/mobile.css
- **제안 수정**: 메시지 행에 qf-m-img-grid 로 이미지 첨부 렌더(4+ 는 **more), 비이미지는 파일 행. **plus 버튼에 파일 선택(input[type=file]) 배선 후 기존 업로드 플로우(upload-url/complete) 재사용.

### A-21 [HIGH][ux] Activity에서 DM 알림 탭 시 메시지로 이동 불가 (무응답)

- **영역**: Activity → 메시지 이동 (시나리오 d)
- **내용**: MobileActivity.open()은 kind에 관계없이 `navigate('/w/:slug?msg=:messageId')` 단일 경로만 사용합니다. kind='direct'인 DM 알림은 workspaceId가 비어 있거나 null이라 slugById.get()이 undefined를 반환하고, 이 경우 navigate 자체가 실행되지 않습니다. 사용자가 DM 알림을 탭해도 아무 반응이 없어 목적지를 알 수 없습니다. 데스크톱 ActivityInboxPanel은 activityClick.ts의 dm-open 분기로 이를 처리하지만 모바일 MobileActivity는 이 로직을 재사용하지 않습니다.
- **근거**: apps/web/src/shell/mobile/MobileActivity.tsx:53-56 (open 함수가 kind 분기 없이 slug만 사용), apps/web/src/features/activity/activityClick.ts:43-45 (데스크톱은 kind=direct → dm-open으로 분기)
- **파일**: apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/features/activity/activityClick.ts
- **제안 수정**: MobileActivity.open()에 `resolveActivityClick` 헬퍼(activityClick.ts)를 재사용해 kind='direct'이면 navigate('/dms/:actorId')로, 나머지는 기존 /w/:slug?msg= 경로로 분기하세요.

### A-22 [HIGH][ux] Activity에서 워크스페이스 채널 알림 탭 시 채널이 열리지 않음 — ?msg= 파라미터를 MobileShell이 소비하지 않음

- **영역**: Activity → 메시지 이동 (시나리오 d)
- **내용**: MobileActivity는 `/w/:slug?msg=:messageId`로 navigate하지만, MobileShell은 useSearchParams로 `msg`를 읽거나 MobileMessages에 jumpTarget을 전달하는 코드가 전혀 없습니다. 결과적으로 채널 목록이 없는 기본 화면(채널을 선택하세요)으로 착지하거나, 채널이 선택된 상태여도 해당 메시지로 스크롤·하이라이트가 전혀 동작하지 않습니다. 데스크톱 MessageColumn(145~166줄)의 around-load + scrollIntoView 메커니즘과 완전히 단절되어 있습니다.
- **근거**: apps/web/src/shell/mobile/MobileActivity.tsx:56 (msg= 파라미터 생성), apps/web/src/shell/MobileShell.tsx:30-188 (msg= 파라미터 소비 코드 없음), apps/web/src/shell/MessageColumn.tsx:140-160 (데스크톱만 around-load 구현)
- **파일**: apps/web/src/shell/MobileShell.tsx, apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: MobileShell에서 useSearchParams로 `msg` 파라미터를 읽어 MobileMessages에 initialTargetMessageId prop으로 전달하고, MobileMessages 마운트 시 해당 메시지가 뷰포트에 들어오도록 scrollIntoView를 수행한 뒤 파라미터를 replace로 제거하세요.

### A-23 [HIGH][ds-deviation] Activity 목록의 actor 표시명이 actorId 앞 8자리 UUID로 표시됨

- **영역**: Activity (시나리오 d) — 알림 표시
- **내용**: MobileActivity에서 알림 행의 발신자 이름으로 `row.actorId.slice(0, 8)` 을 사용합니다. API에는 actorName 필드가 존재하며 데스크톱 ActivityInboxPanel은 actorName을 사용합니다. 처음 사용하는 한국어 사용자는 UUID 조각('a3f9b1c2')이 누구인지 전혀 인식하지 못합니다. Nielsen H2(시스템과 실제 세계의 일치) 위반.
- **근거**: apps/web/src/shell/mobile/MobileActivity.tsx:145 (`row.actorId.slice(0, 8)` 표시), apps/web/src/features/activity/useActivity.ts:36 (actorName 필드 존재), apps/web/src/features/activity/ActivityInboxPanel.tsx:319-320 (displayName 함수로 actorName 사용)
- **파일**: apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/features/activity/ActivityInboxPanel.tsx
- **제안 수정**: 145줄의 `row.actorId.slice(0, 8)`를 `row.actorName?.trim() || '알 수 없는 사용자'`로 교체하세요 (데스크톱 displayName 함수 패턴과 동일).

### A-24 [HIGH][ux] 설정 탭이 항상 알림 설정 페이지로 직행하여 다른 설정(프로필·보안·테마 등)에 접근 불가

- **영역**: 탭바 — 설정 탭 (시나리오 g)
- **내용**: MobileTabBar의 '설정' 탭은 `navigate('/settings/notifications')`로 하드코딩되어 있습니다. 사용자가 프로필·계정·개인정보·고급 설정에 접근하려면 알림 설정 페이지에 진입한 후 다른 방법을 찾아야 합니다. 설정 탭은 관용적으로 설정 메뉴 목록 루트('설정' 목록 화면)로 이동해야 합니다. Nielsen H4(일관성과 표준) 위반이며 기대와 실제 동작의 불일치(H2)입니다.
- **근거**: apps/web/src/shell/mobile/MobileHome.tsx:190 (`navigate('/settings/notifications')`), apps/web/src/shell/mobile/MobileTabBar.tsx:49-53 (설정 탭 onClick=onSettings)
- **파일**: apps/web/src/shell/mobile/MobileTabBar.tsx, apps/web/src/shell/mobile/MobileHome.tsx
- **제안 수정**: onSettings의 destination을 `/settings`(설정 루트 목록)로 변경하세요. 설정 루트 페이지에서 알림 설정·프로필·계정 등 하위 항목을 선택할 수 있게 하세요.

### A-25 [HIGH][prd-gap] 글로벌 메시지 검색 기능이 모바일에 없음

- **영역**: 검색 (시나리오 e)
- **내용**: 데스크톱 Shell의 SearchInput(메시지 전체 검색)이 모바일 셸에서 완전히 누락되어 있습니다. MobileChannelList에는 채널 이름 필터, MobileDmList에는 DM 사용자 이름 필터가 있으나, 이는 로컬 리스트 필터일 뿐 메시지 본문 검색(FR-S\* 관련)을 하지 않습니다. MobileDmList topbar에 검색 아이콘 버튼이 있으나 `onClick`이 없어 사실상 비활성 상태입니다. 사용자가 특정 메시지 내용으로 검색하는 방법이 없습니다.
- **근거**: apps/web/src/shell/mobile/MobileDmList.tsx:57-60 (검색 아이콘 버튼, onClick 없음), apps/web/src/shell/mobile/MobileChannelList.tsx:75-88 (채널 이름 필터만), MobileShell.tsx 전체에 SearchInput 부재
- **파일**: apps/web/src/shell/mobile/MobileDmList.tsx, apps/web/src/shell/MobileShell.tsx
- **제안 수정**: MobileDmList의 topbar 검색 버튼에 onClick을 연결하고, 메시지 검색 기능을 모바일용으로 구현하거나 최소한 버튼을 숨기거나 '준비 중' 상태로 표시하세요.

### A-26 [HIGH][ds-deviation] 모든 화면에서 qf-m-screen--app 수식자 누락 — 62px 하드코딩 상단 여백

- **영역**: 전체 모바일 화면 (qf-m-screen)
- **내용**: qf-m-screen 단독 사용 시 padding-top: var(--m-statusbar) = 62px (디바이스 프레임 목업 전용)가 적용됩니다. DS mobile.css 주석에 "real PWA uses .qf-m-screen--app" 이라고 명시되어 있으며 --app 수식자는 env(safe-area-inset-top)과 100dvh를 사용합니다. 실 앱에서 62px 고정 패딩이 적용되면 노치/다이나믹 아일랜드 기기에서 상단 공백이 과도하게 커지고, 키보드 열림 시 dvh가 없어 스크롤 영역이 잘립니다. MobileShell, MobileHome, MobileDmList, MobileDmChat, MobileActivity, MobileFriends, MobileDiscover 7개 화면 전체가 해당됩니다.
- **근거**: mobile.css:46(.qf-m-screen--bare), mobile.css:1018(.qf-m-screen--app); MobileShell.tsx:66,86,104, MobileHome.tsx:78, MobileDmList.tsx:51, MobileDmChat.tsx:50, MobileActivity.tsx:60, MobileFriends.tsx:48, MobileDiscover.tsx:61, MobileOverlay.tsx:100
- **파일**: apps/web/src/shell/MobileShell.tsx, apps/web/src/shell/mobile/MobileHome.tsx, apps/web/src/shell/mobile/MobileDmList.tsx, apps/web/src/shell/mobile/MobileDmChat.tsx, apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/shell/mobile/MobileFriends.tsx, apps/web/src/shell/mobile/MobileDiscover.tsx, apps/web/src/shell/mobile/MobileOverlay.tsx
- **제안 수정**: 각 화면의 최상위 div className에 qf-m-screen--app을 추가하세요 (예: className="qf-m-screen qf-m-screen--app"). DS 4파일 수정 없이 수식자 클래스만 적용하면 됩니다.

### A-27 [HIGH][prd-gap] §00·§02: OverlappingPanels 3겹침 패널 + 5탭 탭바 모델이 드로어 + 3탭으로 대체됨 (divergent)

- **영역**: §00 비전 / §02 IA 모바일 내비 모델
- **내용**: PRD는 .qf-m-panels 3겹침 패널(좌 채널/중앙 채팅/우 멤버, 엣지 스와이프로 --show-left/--show-right + scrim)과 셸 고정 5탭(채팅·인박스·스레드·검색·나)을 요구. 구현은 버튼 트리거 좌/우 MobileDrawer + 3탭(홈/활동/설정)이며, 채널 화면에서 엣지 스와이프로 패널을 여는 제스처가 없음(스와이프는 MobileOverlay 닫기와 메시지 답장에만 존재). .qf-m-unread-divider(새 메시지 경계)와 .qf-m-jump-btn(하단 점프)도 모바일 채널 뷰에 전혀 없음. DS mobile.css 의 qf-m-panels/qf-m-drawer-scrim/qf-m-thread-inbox/qf-m-you-\* 표면이 전부 미사용.
- **근거**: MobileTabBar.tsx:26-54 (3탭), MobileShell.tsx:104-179 (드로어 모델·스와이프 없음), MobileMessages.tsx:127-152 (unread-divider/jump-btn 부재), MobileDrawer.tsx:1-58
- **파일**: apps/web/src/shell/mobile/MobileTabBar.tsx, apps/web/src/shell/MobileShell.tsx, apps/web/src/shell/mobile/MobileDrawer.tsx
- **제안 수정**: 의도적 divergence 라면 PRD §02 를 드로어+3탭 모델로 개정하고, 아니라면 최소한 미읽 구분선·점프 버튼·엣지 스와이프 오픈을 추가

### A-28 [HIGH][prd-gap] FR-IA-WS-01 (P0): lastChannel 저장/복원 미구현 (missing)

- **영역**: 워크스페이스 전환
- **내용**: ws:{workspaceId}:lastChannel localStorage 저장·복원 코드가 코드베이스 전체에 없음(grep 0건). 모바일 /w/:slug 진입 시 채널 자동 활성화 없이 '채널을 선택하세요' 빈 상태가 뜨며 기본 채널 폴백도 없음. 데스크톱도 동일하게 부재.
- **근거**: grep -rn lastChannel apps/web/src → 0건; MobileShell.tsx:142-147 (채널 미선택 빈 상태)
- **파일**: apps/web/src/shell/MobileShell.tsx
- **제안 수정**: 채널 진입 시 localStorage 기록 + MobileShell 의 !activeChannel 분기에서 복원/기본 채널 리다이렉트

### A-29 [HIGH][prd-gap] FR-IA-MOB-05: 시트에 신고·핀·저장·리마인더 액션 부재 + 삭제 확인 없음 (partial)

- **영역**: 메시지 액션 시트
- **내용**: 롱프레스 시트는 답장/스레드/복사/편집(본인)/삭제(본인)/퀵리액션 5종만 제공. PRD 공통 액션인 핀·저장·리마인더와 타인 메시지 '신고' 가 없음(데스크톱은 PinPanel/SavedEntry/ReminderModal/ReportModal 존재 — 모바일 표면만 부재). role 도 PRD 의 'menu' 가 아닌 dialog. '메시지 삭제' 는 확인 없이 즉시 delMut.mutate 실행.
- **근거**: MobileMessageSheet.tsx:83-148 (액션 목록), MobileMessages.tsx:164-167 (즉시 삭제), features/messages/PinPanel.tsx·ReportModal.tsx·features/saved/ReminderModal.tsx (데스크톱 전용)
- **파일**: apps/web/src/shell/mobile/MobileMessageSheet.tsx, apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: 시트에 핀/저장/리마인더/신고 행 추가 + 삭제 전 alertdialog 확인

### A-30 [HIGH][prd-gap] FR-IA-A11Y-01~02 (P0): 모바일 파괴적 액션에 alertdialog 확인 부재 + 시트 포커스 트랩 없음 (partial)

- **영역**: Confirm Dialog 패턴
- **내용**: 모바일 메시지 삭제가 확인 다이얼로그 없이 즉시 실행됨(role=alertdialog·취소 첫 포커스·focus-trap·포커스 복원 모두 없음). MobileMessageSheet/MobileEditSheet/새 DM 시트는 role=dialog aria-modal 이지만 포커스 트랩과 닫힘 시 트리거 포커스 복원이 없음(ThreadPanel mobile 만 자체 트랩 구현).
- **근거**: MobileMessages.tsx:164-167, MobileMessageSheet.tsx:57-65 (트랩 없음), MobileEditSheet.tsx:64-75, MobileDmList.tsx:154-163
- **파일**: apps/web/src/shell/mobile/MobileMessageSheet.tsx, apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/shell/mobile/MobileEditSheet.tsx
- **제안 수정**: 공용 alertdialog Confirm 컴포넌트 도입 + 시트들에 focus-trap/복원 적용

### A-31 [HIGH][prd-gap] FR-IA-STATE-05a (P0): 오프라인 시 모바일 컴포저/전송 비활성화 미구현 (missing)

- **영역**: 전역 UI 상태 — 오프라인 컴포저
- **내용**: 모바일 컴포저는 연결 상태를 전혀 읽지 않아 오프라인에도 전송 버튼이 활성(draft 비어있을 때만 disabled). 첨부 + 버튼 disabled·사유 툴팁 없음(버튼 자체가 미배선). draft 는 메모리 전용이라 오프라인 중 새로고침 시 소실. 실패 메시지 '다시 시도' 버튼도 모바일 행에 없음(별도 finding).
- **근거**: MobileMessages.tsx:439-472 (연결 상태 미참조·disabled={draft.trim().length===0} 만)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: realtimeStatus/navigator.onLine 구독해 전송·첨부 disabled + 사유 노출

### A-32 [HIGH][prd-gap] FR-MSG-04·05 (P0): 모바일 행에 pending/실패 상태·'다시 시도' UI 미렌더 (partial)

- **영역**: D01 Optimistic UI
- **내용**: useSendMessage 가 sendState('pending'/'failed')와 retry() 를 제공하지만 MobileMessageRow 는 sendState 를 전혀 읽지 않아 pending 회색+시계, '전송 실패' 라벨, '다시 시도' 버튼이 모바일에 없음 — 실패 메시지가 정상 메시지처럼 보이고 재시도 수단이 없음. 데스크톱 MessageItem 은 보유.
- **근거**: MobileMessages.tsx:340-381 (sendState 미사용), MobileMessages.tsx:52 ({ send } 만 구조분해, retry 미사용), useMessages.ts:326-329·463-486
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/useMessages.ts
- **제안 수정**: 행에 sendState 분기(opacity+시계 / danger 라벨+재시도 버튼) 추가, retry 배선

### A-33 [HIGH][prd-gap] FR-MSG-10·11·12 (P0): 모바일에 그루핑·날짜 구분선·로케일 타임스탬프 전부 없음 (missing)

- **영역**: D01 메시지 그루핑/타임스탬프
- **내용**: 모바일 모든 행이 아바타+이름+HH:MM 풀헤더로 렌더 — 5분 grouped(.qf-m-msg--cont) 처리 없음, 자정 날짜 구분선('오늘' 등) 없음, 타임스탬프 규칙(오늘 HH:MM/어제/N일 전, clock24h 설정 반영)도 toLocaleTimeString 고정. 데스크톱 grouping.ts/formatMessageTime.ts 는 존재하나 모바일 미사용. D01 모바일 mock 의 head/cont 구조와도 불일치.
- **근거**: MobileMessages.tsx:340-381 (행 단일 형태·toLocaleTimeString), features/messages/grouping.ts·formatMessageTime.ts (데스크톱 전용, MessageList.tsx 만 사용)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/grouping.ts
- **제안 수정**: grouping/formatMessageTime 모듈을 모바일 목록에 배선, qf-m-msg--cont + 날짜 구분선 렌더

### A-34 [HIGH][prd-gap] FR-MSG-13 / FR-MN-01 (P0): 모바일 멘션 — 자동완성 부재 + 정규화 멘션이 @cuid 원문 노출 + 본인 멘션 하이라이트 없음 (partial)

- **영역**: D01 멘션
- **내용**: (1) 모바일 컴포저에 @ 자동완성 팝오버 없음. (2) 서버는 멘션을 @{cuid2} 로 정규화 저장하는데(MessageItem.tsx:96 주석) 모바일은 legacy 정규식 렌더에 멘션 lookup 없이 @토큰을 그대로 출력 → 신규 멘션이 '@h3x9k2…' 식 원시 id 로 보임. (3) 나를 멘션한 메시지의 행 하이라이트(accent 보더/배경) 없음. 데스크톱은 renderAst+MentionLookup 으로 해석.
- **근거**: MobileMessages.tsx:379·384-476, parseContent.tsx:205-213 (raw @token 출력), MessageItem.tsx:96·768-770
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/parseContent.tsx
- **제안 수정**: 모바일도 renderAst + mentions lookup 사용, 컴포저 자동완성 배선, mentionsMe 행 변형 추가

### A-35 [HIGH][prd-gap] FR-MSG-14·15 / FR-MN-02: 모바일 대량 멘션 확인 다이얼로그 미배선 — 409 가 데드엔드 (missing)

- **영역**: D01 특수 멘션
- **내용**: useSendMessage 의 onBulkMentionConfirmRequired 콜백을 모바일이 전달하지 않아, 임계값 초과 @everyone/@here 전송 시 서버 409(BULK_MENTION_CONFIRM_REQUIRED)가 확인 다이얼로그 없이 일반 실패로 떨어짐. 모바일 행은 failed 상태도 렌더하지 않아 사용자는 확인·재전송 수단이 전무. 데스크톱은 SpecialMentionConfirmDialog 배선됨.
- **근거**: MobileMessages.tsx:52 (콜백 미전달), useMessages.ts:229-247·391-400, MessageList.tsx:1251 (데스크톱 다이얼로그)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/useMessages.ts
- **제안 수정**: 모바일 컴포저에 확인 시트 + send(content, undefined, true, clientNonce) 재전송 배선

### A-36 [HIGH][prd-gap] FR-CH-19: 모바일 공지 채널 컴포저 disabled 게이팅 전무 (missing)

- **영역**: D02 공지 채널
- **내용**: 데스크톱 MessageComposer 는 ANNOUNCEMENT 에서 disabled+placeholder+툴팁을 적용하지만 모바일 MobileComposer 는 채널 타입을 모름 → MEMBER 가 공지 채널에 입력·전송 가능하고 서버 403 이 떨어져도 모바일 행은 failed 표시조차 없음. 헤더 '공지 채널' 배지도 모바일 토프바에 없음.
- **근거**: MobileMessages.tsx:384-476 (채널 타입 미전달), MessageComposer.tsx:842-862 (데스크톱 게이팅)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/shell/MobileShell.tsx
- **제안 수정**: activeChannel.type 을 MobileMessages 에 내려 disabled+placeholder 적용

### A-37 [HIGH][prd-gap] FR-TH-03·04: 모바일 메시지 행에 reply bar(N replies) 미렌더 (missing)

- **영역**: D04 스레드 Reply Bar
- **내용**: 모바일 행이 threadMeta(thread.replyCount 등)를 전혀 렌더하지 않아 답글 수·답글자 아바타·미읽 dot 이 보이지 않고, 스레드 존재 자체를 타임라인에서 인지할 수 없음(진입은 롱프레스 시트뿐). 데스크톱은 MessageItem threadChip 보유.
- **근거**: MobileMessages.tsx:340-381 (thread 미사용), features/messages/MessageItem.threadChip.spec.tsx (데스크톱)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: 행 하단에 replyCount 칩 렌더 → 탭 시 ThreadPanel(mobile) 오픈

### A-38 [HIGH][prd-gap] FR-RE01·RE02 + FR-RE03: 모바일 메시지 행에 반응 칩 미렌더 — 타인 반응 불가시·칩 토글 불가 (partial)

- **영역**: D05 반응 표시/토글
- **내용**: 모바일 행이 msg.reactions 를 렌더하지 않아(.qf-m-react-row/chip 미사용) 타인이 남긴 반응이 모바일에서 전혀 보이지 않고, 칩 탭 토글·내 반응 강조·reaction:updated 실시간 갱신(FR-RE03)의 표시 표면이 없음. 추가는 시트 퀵리액션 5종만 가능(제거는 같은 이모지 재탭 시 byMe 기반 토글로만). 데스크톱 ReactionBar 는 정상.
- **근거**: MobileMessages.tsx:340-381 (reactions 미렌더), MobileMessageSheet.tsx:11·68-81 (5종 프리셋), features/reactions/ReactionBar.tsx (데스크톱)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/reactions/ReactionBar.tsx
- **제안 수정**: 행 하단에 qf-m-react-row/chip 렌더 + toggle 배선

### A-39 [HIGH][prd-gap] FR-MN-04: 모바일 '@' 자동완성 드롭다운 없음 (missing)

- **영역**: D06 멘션 자동완성
- **내용**: 멤버/역할/@everyone/@here 후보 자동완성이 모바일 컴포저에 전무 — 모바일에서 멘션을 쓰려면 정확한 username 을 수타이핑해야 하며, 정규화(@cuid2 변환) 선택 경로가 없어 서버 멘션 추출에 의존. 데스크톱 autocomplete 모듈 존재.
- **근거**: MobileMessages.tsx:384-476, features/messages/autocomplete/ (데스크톱)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: 키보드 위 후보 리스트(listbox) 배선

### A-40 [HIGH][prd-gap] FR-S01·S11: 모바일 검색 진입점 전무 (missing)

- **영역**: D07 검색
- **내용**: 검색 도메인 전체가 모바일에 없음 — 탭바에 '검색' 탭이 없고(3탭 모델) 토프바 돋보기·Cmd+K 대응도 없어 최근 검색·치트시트 카드를 포함한 어떤 검색 표면에도 도달 불가. 데스크톱은 MessageColumn 에 SearchInput 마운트.
- **근거**: MobileTabBar.tsx:26-54, MobileShell.tsx:104-132 (검색 액션 없음), MessageColumn.tsx:392 (데스크톱)
- **파일**: apps/web/src/shell/mobile/MobileTabBar.tsx, apps/web/src/features/search/SearchInput.tsx
- **제안 수정**: 토프바 검색 액션 → 풀스크린 검색 오버레이 신설

### A-41 [HIGH][prd-gap] FR-S07: 모바일 검색 Jump 플로우 전체 부재 (missing)

- **영역**: D07 검색 — Jump (모바일)
- **내용**: 메시지 검색 자체가 모바일에 없어 Jump→채널 전환→2초 하이라이트→뒤로가기 복귀 플로우(모바일 Playwright AC 명시)가 전부 부재. SearchInput/SearchResultPanel 은 데스크톱 MessageColumn 에만 마운트되고, 모바일 화면 어디에도 메시지 검색 진입점이 없음. 데스크톱에는 있는 표면이 모바일에 없는 사례.
- **근거**: shell/MessageColumn.tsx:27,392 (SearchInput 데스크톱 전용); shell/mobile/\* 전체에 search 기능 import 없음(MobileChannelList 의 qf-m-search 는 채널명 필터일 뿐)
- **파일**: apps/web/src/shell/MessageColumn.tsx, apps/web/src/features/search/SearchInput.tsx
- **제안 수정**: 모바일 검색 화면(토프바 검색 진입 + 결과 리스트 + Jump 시 MobileOverlay/채널 전환 + 하이라이트) 신설

### A-42 [HIGH][prd-gap] FR-P07 + D08 §typing:update + D17 [D] FR-RT-08·09: 모바일 타이핑 emit/표시 모두 부재 (missing)

- **영역**: D08/D17 — 타이핑 인디케이터
- **내용**: TypingEmitter(3초 스로틀/10초 stop)는 데스크톱 MessageComposer, TypingIndicator 표시는 데스크톱 MessageColumn 에만 배선. 모바일 컴포저는 typing:start 를 보내지 않고, 모바일 채팅 화면(MobileMessages 3개 임베드 경로 전부)에 인디케이터가 없음. D17 모바일 mock 에 타이핑 바가 명시된 explicit 요구.
- **근거**: features/messages/MessageComposer.tsx:171-281 (emit 데스크톱 전용); shell/MessageColumn.tsx:23,478 (표시 데스크톱 전용); shell/mobile/MobileMessages.tsx 에 typing import 없음
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/typing/TypingIndicator.tsx, apps/web/src/features/messages/MessageComposer.tsx
- **제안 수정**: MobileComposer 에 TypingEmitter 연결 + 컴포저 위 TypingIndicator 렌더(reduceMotion 점 애니메이션 게이트 포함)

### A-43 [MED][prd-gap] 모바일에서 신고 큐·감사 로그 도달 불가 — /w/:slug/settings 가 MobileShell 에서 채널명으로 오해석되는 라우팅 데드엔드

- **영역**: D12 — 신고 큐·감사 로그 (FR-RM11 큐 + FR-RM12, 모바일 목업)
- **내용**: ReportQueuePanel/AuditLogPanel 은 WorkspaceSettingsPage(데스크톱 /w/:slug/settings 오버레이) 내부입니다. 모바일에서는 같은 URL 이 MobileShell 로 들어가 rest[0]='settings' 를 채널명으로 해석 → activeChannel null → '채널을 선택하세요' 빈 화면이 됩니다. PRD 의 모바일 전용 신고 큐/감사 로그 카드 화면(목업)도 미구현입니다. 워크스페이스 설정 전체(역할·밴 목록·automod 포함)가 모바일에서 차단되는 구조적 갭입니다.
- **근거**: apps/web/src/shell/MobileShell.tsx:31-49,134-147 (rest[0] 를 채널명으로 해석), apps/web/src/shell/Shell.tsx:58-70 (데스크톱만 settings 분기), apps/web/src/features/workspaces/moderation/ReportQueuePanel.tsx, AuditLogPanel.tsx (WorkspaceSettingsPage 전용)
- **파일**: apps/web/src/shell/MobileShell.tsx, apps/web/src/features/workspaces/moderation/ReportQueuePanel.tsx, apps/web/src/features/workspaces/moderation/AuditLogPanel.tsx
- **제안 수정**: MobileShell 에서 rest[0]==='settings' 분기를 추가해 워크스페이스 설정(모바일 드릴다운 변형)으로 라우팅 — 신고 큐/감사 로그는 qf-m-\* 카드 목업 기반 화면으로

### A-44 [MED][ux] DM 신규 생성이 '친구' 관계로만 제한되어 있고 이를 시트 안에서만 안내함

- **영역**: DM 시작 (시나리오 c) — 새 DM 시트
- **내용**: MobileDmList의 새 DM FAB 시트에서 친구가 없으면 '친구가 없습니다. 먼저 /friends 에서 친구 요청을 보내주세요.' 문구가 표시됩니다. 그러나 /friends는 딥링크 경로로, 처음 사용자는 텍스트에 'Link'가 없는 이상 이를 탭해도 이동하지 않고 그냥 텍스트로 인식합니다. 또한 같은 워크스페이스 멤버에게 DM을 보내는 경로가 '채널 목록 → 멤버 오른쪽 드로어 → 프로필 팝오버'로만 가능하여 발견성이 매우 낮습니다. Nielsen H10(도움말과 문서) + H6(인식 우선) 위반.
- **근거**: apps/web/src/shell/mobile/MobileDmList.tsx:183-189 (친구 없음 빈 상태, /friends 텍스트만 표시), apps/web/src/shell/mobile/MobileDmList.tsx:181-207 (friendCandidates만 대상)
- **파일**: apps/web/src/shell/mobile/MobileDmList.tsx
- **제안 수정**: 빈 상태의 '/friends' 문구를 `<Link to='/friends'>친구 목록 바로가기</Link>`로 탭 가능하게 만들고, 워크스페이스 멤버에게도 DM을 시작할 수 있도록 별도 탭/섹션을 추가 검토하세요.

### A-45 [MED][ds-deviation] DS 드로어 패널 클래스(qf-m-panel-left/right, qf-m-drawer-scrim) 미사용 — qf-m-sheet-backdrop 오용

- **영역**: MobileDrawer (드로어 패널)
- **내용**: DS mobile.css는 qf-m-panels / qf-m-panel-left / qf-m-panel-right / qf-m-drawer-scrim을 모바일 드로어 전용으로 정의합니다. MobileDrawer는 이 클래스 대신 qf-m-sheet-backdrop(바텀 시트 backdrop 전용 컴포넌트)을 드로어 오버레이로 사용하고, aside 패널에는 아무 DS 클래스 없이 raw Tailwind(absolute top-0 bottom-0 bg-bg-subtle overflow-y-auto)를 사용합니다. qf-m-sheet-backdrop은 rgba(10,8,30,0.6) 불투명도로 정의되어 있어 드로어 scrim(var(--scrim) = rgba(10,8,30,0.5))보다 더 어둡게 렌더됩니다.
- **근거**: mobile.css:479(qf-m-drawer-scrim), mobile.css:277(qf-m-sheet-backdrop), mobile.css:434(qf-m-panel-left), mobile.css:446(qf-m-panel-right); MobileDrawer.tsx:43-53
- **파일**: apps/web/src/shell/mobile/MobileDrawer.tsx
- **제안 수정**: backdrop div의 클래스를 qf-m-sheet-backdrop 대신 qf-m-drawer-scrim으로 교체하세요. aside 패널에는 side에 따라 qf-m-panel-left 또는 qf-m-panel-right를 적용하고 raw bg-bg-subtle 클래스를 제거하세요. 단, 현재 MobileDrawer는 qf-m-panels 루트 없이 사용되므로 DS 패널 시스템과의 구조 정합을 검토해야 합니다.

### A-46 [MED][prd-gap] FR-IA-MOB-03 + FR-CH-06: 모바일에 채널 브라우저 진입점·화면이 전무 (missing)

- **영역**: 모바일 채널 브라우저
- **내용**: 데스크톱은 features/channels/ChannelBrowser.tsx 가 ChannelColumn 에서 열리지만, 모바일 좌 드로어(MobileChannelList)에는 '+ 채널 탐색' 버튼도 .qf-m-modal--fullscreen 브라우저도 없음 → 모바일 사용자는 비가입 공개 채널을 발견/가입할 수 없음(검색·정렬·empty state 2종·ADMIN CTA 모두 미노출). 데스크톱에는 있고 모바일에만 없는 표면.
- **근거**: MobileChannelList.tsx:39-137 (탐색 진입점 없음), features/channels/ChannelBrowser.tsx (데스크톱 전용), shell/ChannelColumn.tsx
- **파일**: apps/web/src/shell/mobile/MobileChannelList.tsx, apps/web/src/features/channels/ChannelBrowser.tsx
- **제안 수정**: 좌 드로어에 '+ 채널 탐색' 행 추가 → ChannelBrowser 를 전체화면 오버레이로 재사용

### A-47 [MED][prd-gap] FR-DM-03 (explicitMobile): 모바일 DM 목록에 그룹 DM 미표시 + 홈 DM 목록은 배지/시각도 없음 (partial)

- **영역**: D03 DM 목록
- **내용**: (1) /dms 목록이 useDmList(1:1)만 조회 — useDmGroups(GET /me/dms/groups, 데스크톱 DmShell 사용)를 모바일이 안 써서 그룹 DM 이 목록에 전혀 안 보임(겹침 아바타·그룹명 포함). (2) MobileHome 의 DM 콘텐츠는 미읽 배지·시각조차 없이 이름+미리보기만 렌더. 1:1 행의 배지/미리보기/시각/정렬은 /dms 화면에서 충족.
- **근거**: MobileDmList.tsx:22 (useDmList 만), features/dms/useDms.ts:23-28·55-59 (그룹 API 존재), MobileHome.tsx:318-334 (배지/시각 없음)
- **파일**: apps/web/src/shell/mobile/MobileDmList.tsx, apps/web/src/shell/mobile/MobileHome.tsx
- **제안 수정**: useDmGroups 병합 렌더(겹침 아바타 ≤5) + 홈 DM 행에 badge/time 추가

### A-48 [LOW][prd-gap] 멤버 디렉터리와 초대링크 생성/관리가 모바일에서 전부 도달 불가

- **영역**: D13 — 멤버 디렉터리·초대링크 관리 (FR-W10/W11, FR-W02/W17)
- **내용**: MemberDirectoryPanel(검색·역할 필터·커서 50·행 액션)은 DesktopShell 오버레이 전용이고, CreateInviteModal(만료/횟수/임시 멤버십/복사)·초대 관리 목록은 WorkspaceSettingsPage 내부인데 /w/:slug/settings 가 모바일에서 라우팅 데드엔드입니다(앞선 finding). 결과적으로 모바일에서는 멤버 검색/필터/액션도, 초대링크 생성·비활성화도 전혀 불가합니다.
- **근거**: apps/web/src/shell/Shell.tsx:16,206-207 (MemberDirectoryPanel/WorkspaceSettings — 데스크톱), apps/web/src/features/workspaces/CreateInviteModal.tsx:6-8, apps/web/src/shell/MobileShell.tsx:33-48 (settings 세그먼트 미분기)
- **파일**: apps/web/src/features/workspaces/MemberDirectoryPanel.tsx, apps/web/src/features/workspaces/CreateInviteModal.tsx, apps/web/src/shell/MobileShell.tsx
- **제안 수정**: MobileShell settings 분기 신설(앞선 finding)과 함께 멤버 디렉터리·초대 관리의 qf-m-\* 화면 변형 제공; 최소한 CreateInviteModal 은 시트형으로 좌 드로어에서 진입 가능하게

### A-49 [LOW][ux] 두 가지 워크스페이스 전환 경로가 혼재하여 멘탈 모델이 분열됨

- **영역**: 워크스페이스 전환 (시나리오 f)
- **내용**: MobileHome에는 좌측 rail(워크스페이스 아바타 탭 → 채널 목록 표시)로 전환하는 경로가 있고, MobileShell에는 좌측 드로어 내 MobileChannelList의 상단 워크스페이스 rail(Link to /w/:slug)이 있습니다. 두 경로는 동작 방식이 다릅니다. MobileHome은 URL을 ?ws=로 유지하고, MobileShell/MobileChannelList는 /w/:slug 전체 navigation으로 전환합니다. 워크스페이스가 1개이면 MobileChannelList의 rail이 아예 숨겨집니다(47줄). 또한 MobileHome에서 워크스페이스 채널을 열면 MobileOverlay로, MobileShell에서는 인라인으로 열려 UI 맥락이 다릅니다. Nielsen H4(일관성과 표준) + H1(시스템 상태 가시성) 위반.
- **근거**: apps/web/src/shell/mobile/MobileHome.tsx:49-61 (rail 선택 → ?ws= URL 방식), apps/web/src/shell/mobile/MobileChannelList.tsx:47-73 (>1개일 때만 rail 노출, Link to /w/:slug 방식)
- **파일**: apps/web/src/shell/mobile/MobileHome.tsx, apps/web/src/shell/mobile/MobileChannelList.tsx
- **제안 수정**: 워크스페이스 전환은 하나의 경로로 통일하세요. MobileHome의 rail 방식과 MobileShell의 드로어 방식 중 하나를 주요 진입점으로 선정하고, 반대쪽은 보조 수단임을 명확히 구조화하세요.

### A-50 [LOW][ux] 스와이프-답장 제스처가 시각적 힌트 없이 존재하여 발견성이 없음

- **영역**: 메시지 답장/스레드 (시나리오 b)
- **내용**: MobileMessages의 swipe-right-to-reply는 터치 중 translateX로 메시지가 밀리는 시각 효과는 있으나, 사용자가 이 제스처를 미리 인식할 단서(아이콘, 힌트 레이블, 온보딩 안내 등)가 전혀 없습니다. 처음 사용자는 long-press 시트의 '답장' 버튼으로만 답장할 수 있고 스와이프는 우연히 발견해야 합니다. SWIPE_THRESHOLD_PX=80도 꽤 크며, 메시지 목록 자체가 세로 스크롤 컨테이너라 의도치 않은 가로 슬라이드 오작동 가능성이 있습니다. Nielsen H6(인식 우선, 기억 의존 최소화) 위반.
- **근거**: apps/web/src/shell/mobile/MobileMessages.tsx:288-321 (swipe 구현, 힌트 없음), apps/web/src/shell/mobile/MobileMessages.tsx:289 (LONG_PRESS_MS=500, SWIPE_THRESHOLD_PX=80)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx
- **제안 수정**: 메시지 행에 스와이프 방향 화살표 아이콘 힌트(드래그 시작 시 나타나는 reply 아이콘 등)를 추가하거나, 첫 방문 시 '→ 스와이프하면 답장' 툴팁/스낵바를 일회성으로 표시하세요.

### A-51 [LOW][ux] 초기 로딩 중 'loading…' 영문 텍스트가 한국어 인터페이스와 불일치

- **영역**: MobileShell 로딩 상태
- **내용**: MobileShell의 isLoading 상태에서 `loading…` 영문 텍스트가 그대로 표시됩니다. 앱 전체가 한국어 UI인데 이 문자열만 영문이어서 일관성이 없고, 처음 사용자에게 '로드 중인지 오류인지' 구분하기 어렵습니다. 또한 로딩 스피너나 스켈레톤 등 시각적 피드백이 없습니다. Nielsen H1(시스템 상태 가시성) + H4(일관성) 위반.
- **근거**: apps/web/src/shell/MobileShell.tsx:69 (`loading…` 텍스트), apps/web/src/shell/mobile/MobileDmChat.tsx:80 (`불러오는 중…` 한국어 대조)
- **파일**: apps/web/src/shell/MobileShell.tsx
- **제안 수정**: `loading…`을 `불러오는 중…`으로 교체하고, qf-m-empty 대신 스켈레톤 또는 스피너 컴포넌트를 사용하세요.

### A-52 [LOW][ux] Activity 화면에서 탭바 onActivity(Activity 탭 자기 자신) 핸들러가 전달되지 않음

- **영역**: MobileActivity 탭바
- **내용**: MobileActivity는 MobileTabBar에 `onActivity` prop을 전달하지 않아 Activity 탭이 undefined로 렌더링됩니다. Tab 컴포넌트 안에서 `onClick={disabled ? undefined : onClick}`이므로 onClick이 undefined면 클릭해도 아무 동작이 없습니다. Activity 탭에 active='activity'는 올바르게 전달하지만 탭 자체를 탭해도 새로고침/최상단 이동 같은 관용적 동작이 없습니다. Nielsen H1(상태 가시성) 부분 위반.
- **근거**: apps/web/src/shell/mobile/MobileActivity.tsx:168-172 (onActivity 미전달), apps/web/src/shell/mobile/MobileTabBar.tsx:21 (onActivity?: () => void — 옵셔널이나 동작 없음)
- **파일**: apps/web/src/shell/mobile/MobileActivity.tsx, apps/web/src/shell/mobile/MobileTabBar.tsx
- **제안 수정**: MobileActivity에서 `onActivity={() => window.scrollTo(0,0)}` 또는 리스트 최상단 스크롤을 수행하는 핸들러를 전달하세요. iOS/Android 모두 현재 탭 재탭 시 최상단 스크롤이 관용적 동작입니다.

### A-53 [LOW][prd-gap] FR-DM-18 (explicitMobile): 차단 사용자 메시지 placeholder/롱프레스 토스트 미구현 — 전역 부재 (missing)

- **영역**: D03 차단 메시지 마스킹
- **내용**: '[차단된 사용자의 메시지]' placeholder, 모바일 롱프레스 시 시트 대신 3초 토스트, 최초 진입 일회성 시스템 메시지가 모바일은 물론 데스크톱 MessageItem/MessageList 에도 없음(grep 상 차단 마스킹 코드 0건). 모바일 시트는 차단 작성자 메시지에도 그대로 열림.
- **근거**: grep '차단된 사용자' features → 0건, MobileMessages.tsx:142 (무조건 시트 오픈), MessageItem.tsx (마스킹 분기 없음)
- **파일**: apps/web/src/shell/mobile/MobileMessages.tsx, apps/web/src/features/messages/MessageItem.tsx
- **제안 수정**: 차단 목록 기반 행 마스킹 + 모바일 롱프레스 토스트 분기 구현

## B. MED/LOW 발견 (검증 1단계 — 구현 시 재확인)

| #     | 심각도 | 유형         | 제목                                                                                                                                          | 파일                                             | 제안                                                                                                                                                                                                                  |
| ----- | ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------------------- | ------------------------------------ | ----------------------------------------------------------- |
| B-1   | MED    | prd-gap      | FR-IA-WS-02: 채널 전환 시 최하단 스크롤 초기화가 조건부로만 동작 (partial)                                                                    | MobileMessages.tsx, MobileShell.tsx              | MobileMessages 에 key={channelId} 부여 또는 channelId 변경 시 anchor ref 리셋                                                                                                                                         |
| B-2   | MED    | prd-gap      | FR-IA-WS-03: draft 가 메모리 전용 — localStorage draft:{channelId} 미사용 (partial)                                                           | compose-store.ts                                 | zustand persist 미들웨어로 draft:{channelId} 키 localStorage 동기화                                                                                                                                                   |
| B-3   | MED    | prd-gap      | FR-IA-MOB-01 (P0): 온보딩 완료 후 defaultChannelId 자동 오픈 없음 (partial)                                                                   | MobileShell.tsx, OnboardingOverlay.tsx           | welcome 완료 콜백에서 기본 채널로 navigate                                                                                                                                                                            |
| B-4   | MED    | prd-gap      | FR-IA-MOB-02: 멤버 버튼 aria-expanded·멤버 수 없음 + 역할 그룹 미적용 (partial)                                                               | MobileShell.tsx, MobileMembers.tsx               | 버튼에 aria-expanded={rightOpen} + 멤버 수, 목록에 관리자 그룹 추가                                                                                                                                                   |
| B-5   | MED    | prd-gap      | FR-IA-MOB-04a (P0): 스레드/편집시트 컴포저가 --m-kb-inset 키보드 회피 미적용 (partial)                                                        | mobile-kb-dodge.css, ThreadPanel.tsx             | kb-dodge 규칙을 모바일 스레드 컴포저·바텀시트에도 확장                                                                                                                                                                |
| B-6   | MED    | prd-gap      | FR-IA-MOB-06: 모바일 설정 화면 부재 — 데스크톱 SettingsShell 직렌더 + 탭 목적지 비일관 (divergent)                                            | MobileShell.tsx, MobileTabBar.tsx                | qf-m-you-\* 기반 모바일 설정 목록 화면 신설, 탭 목적지 통일                                                                                                                                                           |
| B-7   | MED    | prd-gap      | FR-IA-A11Y-03~05: 모바일에 자동완성 표면 자체가 없어 aria 패턴 미적용 (missing)                                                               | MobileMessages.tsx                               | 모바일 컴포저에 자동완성 listbox 배선 시 동일 aria 패턴 적용                                                                                                                                                          |
| B-8   | MED    | prd-gap      | FR-IA-STATE-01·06: 모바일 메시지 스트림 skeleton 미구현 (missing)                                                                             | MobileMessages.tsx                               | history.isLoading 시 200ms 지연 skeleton 5행 + 250ms 최소 유지                                                                                                                                                        |
| B-9   | MED    | prd-gap      | FR-IA-STATE-02 / FR-MSG-22: 모바일 0건 채널 empty state 부재 (missing)                                                                        | MobileMessages.tsx                               | qf-m-empty 로 채널 empty state + CTA 추가                                                                                                                                                                             |
| B-10  | MED    | prd-gap      | FR-IA-STATE-03·04: 모바일 메시지 영역 네트워크 에러/403 상태 미처리 (missing)                                                                 | MobileMessages.tsx                               | isError 분기에 재시도 버튼(refetch) + 403 코드 분기 잠금 안내                                                                                                                                                         |
| B-11  | MED    | prd-gap      | FR-IA-STATE-05: 배너 시퀀스 부분 구현 — 3초 지연·'다시 연결되었습니다' 2초 표시·갭 skeleton 없음 (partial)                                    | computeConnectionBanner.ts, MobileMessages.tsx   | 배너 FSM 에 recovered(2s) 상태 + 표시 3s 유예 추가                                                                                                                                                                    |
| B-12  | MED    | prd-gap      | §03 ADR-6: 모바일 채널 배지가 NotifLevel/뮤트 표를 무시 (partial)                                                                             | MobileChannelList.tsx                            | MobileChannelList 에 useMutedChannelIds + 레벨 오버라이드 적용                                                                                                                                                        |
| B-13  | MED    | prd-gap      | NFR-9: 시트 퀵리액션 버튼 터치 타깃 44px 미만 (partial)                                                                                       | MobileMessageSheet.tsx                           | 퀵리액션 버튼에 min-w/min-h var(--m-touch) 부여                                                                                                                                                                       |
| B-14  | MED    | prd-gap      | FR-MSG-01: 모바일 컴포저 단일행 input — 줄바꿈 불가 + 렌더는 legacy 서브셋 (partial)                                                          | MobileMessages.tsx, parseContent.tsx             | textarea 전환 + contentAst 존재 시 renderAst 사용                                                                                                                                                                     |
| B-15  | MED    | prd-gap      | FR-MSG-02: 모바일 코드블록에 하이라이팅·복사 버튼 없음 (partial)                                                                              | MobileMessages.tsx, CodeBlock.tsx                | 모바일도 renderAst/CodeBlock 경로 사용                                                                                                                                                                                |
| B-16  | MED    | prd-gap      | FR-MSG-03 (P0): 모바일 4000자 카운터/초과 차단 없음 (missing)                                                                                 | MobileMessages.tsx                               | composerCounter 재사용해 카운터+disabled 게이트 추가                                                                                                                                                                  |
| B-17  | MED    | prd-gap      | FR-MSG-08: 편집 이력 팝오버 모바일 부재 (partial)                                                                                             | MobileMessages.tsx, EditHistoryPopover.tsx       | 시트에 '편집 이력' 행 추가 → 바텀시트로 이력 표시                                                                                                                                                                     |
| B-18  | MED    | prd-gap      | FR-MSG-16: 모바일 스포일러 미지원 —                                                                                                           |                                                  | 텍스트                                                                                                                                                                                                                |     | 가 평문 노출 (missing) | parseContent.tsx, MobileMessages.tsx | 모바일 renderAst 전환(스포일러 콘텐츠 노출이므로 우선 처리) |
| B-19  | MED    | prd-gap      | FR-MSG-17·18: 모바일 '링크 복사' 액션 없음 + permalink(?msg=) 모바일 미소비 (partial)                                                         | MobileMessageSheet.tsx, MobileShell.tsx          | 시트에 링크 복사 행 + MobileShell 에 ?msg= 점프/하이라이트 처리                                                                                                                                                       |
| B-20  | MED    | prd-gap      | FR-MSG-19: 모바일 시스템 메시지가 일반 행으로 렌더 (partial)                                                                                  | MobileMessages.tsx, SystemMessage.tsx            | 모바일 목록에 SystemMessage 분기 추가 + 시트 진입 차단                                                                                                                                                                |
| B-21  | MED    | prd-gap      | D01 Spec 타이핑: 모바일에서 emit·표시 모두 없음 (missing)                                                                                     | MobileMessages.tsx, TypingIndicator.tsx          | MobileComposer 에 TypingEmitter, 목록 하단에 TypingIndicator 배선                                                                                                                                                     |
| B-22  | MED    | prd-gap      | FR-CH-05 (P0): 모바일에서 채널 설정 화면 자체가 미도달 — 전환 confirm 모달 검증 불가 (missing)                                                | MobileShell.tsx, ChannelSettingsPage.tsx         | 모바일 채널 설정 진입(토프바 메뉴) + 전환 confirm 을 qf-m-modal--fullscreen 으로                                                                                                                                      |
| B-23  | MED    | prd-gap      | FR-CH-09: 모바일 토프바에 토픽 노출 슬롯 없음 (missing)                                                                                       | MobileShell.tsx                                  | 토프바 타이틀 탭 → 채널 정보 시트에 토픽 표시                                                                                                                                                                         |
| B-24  | MED    | prd-gap      | FR-CH-14: 모바일 카테고리 접기/펼치기 없음 (missing)                                                                                          | MobileChannelList.tsx                            | 헤더를 버튼화하고 데스크톱과 동일 localStorage 키 공유                                                                                                                                                                |
| B-25  | MED    | prd-gap      | FR-CH-15: 모바일 채널 목록에 Favorites 섹션 없음 (missing)                                                                                    | MobileChannelList.tsx, FavoritesSection.tsx      | 드로어 목록 최상단에 FavoritesSection 데이터 재사용                                                                                                                                                                   |
| B-26  | MED    | prd-gap      | FR-CH-17: 모바일 뮤트 채널 시각 처리·배지 억제·뮤트 설정 진입 전부 없음 (missing)                                                             | MobileChannelList.tsx                            | useMutedChannelIds 배선 + 행 롱프레스 시트에 뮤트 메뉴                                                                                                                                                                |
| B-27  | MED    | prd-gap      | FR-CH-20 + §02: 모바일 채널 행 아이콘/배지 의미 불일치 (partial)                                                                              | MobileChannelList.tsx                            | channel.type/isPrivate 별 아이콘 + 배지를 mentionCount 기준으로 변경                                                                                                                                                  |
| B-28  | MED    | prd-gap      | FR-DM-01: 모바일 DM 개설 403(DM_PRIVACY_RESTRICTED) 안내 미표시 (partial)                                                                     | MobileDmChat.tsx, MobileDmList.tsx               | 403 에러코드 분기로 제한 안내 토스트/빈 상태 표시                                                                                                                                                                     |
| B-29  | MED    | prd-gap      | FR-DM-02: 모바일 새 DM 시트는 1:1 단일 선택만 — 그룹 생성 불가 (missing)                                                                      | MobileDmList.tsx                                 | 칩 멀티 선택 + POST /me/dms/groups 배선                                                                                                                                                                               |
| B-30  | MED    | prd-gap      | FR-DM-05 + FR-DM-07~09: 그룹명 표시·이름변경·멤버 추가/강퇴/나가기 UI 모바일 전무 (missing)                                                   | MobileDmList.tsx, MobileDmChat.tsx               | 그룹 행/그룹 채팅 헤더 + 멤버 관리 시트 신설                                                                                                                                                                          |
| B-31  | MED    | prd-gap      | FR-DM-10: DM 숨기기 UI·visibility_restored 처리 미발견 (missing)                                                                              | useDms.ts, MobileDmList.tsx                      | 행 롱프레스 시트에 숨기기 + dispatcher 에 복원 이벤트 처리                                                                                                                                                            |
| B-32  | MED    | prd-gap      | FR-DM-11: 모바일 뮤트 배지 억제는 구현, 뮤트 설정 메뉴는 없음 (partial)                                                                       | MobileDmList.tsx                                 | DM 행 롱프레스 시트에 뮤트 기간 메뉴 추가                                                                                                                                                                             |
| B-33  | MED    | prd-gap      | FR-DM-16: dm:created 소비가 /dms 화면에만 — 홈 DM 목록은 미갱신 (partial)                                                                     | MobileHome.tsx                                   | MobileHome 에도 useDmCreated 마운트(또는 App 레벨로 승격)                                                                                                                                                             |
| B-34  | MED    | prd-gap      | FR-DM-19: user:unblocked 핸들러 dormant — 어떤 셸에도 미배선 (missing)                                                                        | useUserUnblocked.ts                              | AppRealtimeHost 에 useUserUnblocked 마운트                                                                                                                                                                            |
| B-35  | MED    | prd-gap      | FR-TH-09·10: 모바일에서 구독 스레드 목록(ThreadsView) 미도달 (missing)                                                                        | ThreadsView.tsx, MobileChannelList.tsx           | 좌 드로어 또는 활동 화면에 스레드 목록 진입 추가                                                                                                                                                                      |
| B-36  | MED    | prd-gap      | FR-TH-20: 768~1024px 오버레이 패널·뷰포트 전환 scrollTop 보존 미구현 (partial)                                                                | ThreadPanel.tsx, Shell.tsx                       | 태블릿 분기 추가는 후순위, 최소 scrollTop 보존 검토                                                                                                                                                                   |
| B-37  | MED    | prd-gap      | FR-RE04·RE05: 모바일에서 반응 사용자 확인 표면 없음 (missing)                                                                                 | ReactionUsersModal.tsx                           | 칩 롱프레스 → 사용자 목록 바텀시트                                                                                                                                                                                    |
| B-38  | MED    | prd-gap      | D05 §피커: 모바일 이모지 드로어(.qf-m-emoji-drawer) 미구현 (missing)                                                                          | MobileMessageSheet.tsx, EmojiPicker.tsx          | 시트에 '다른 반응…' 행 → EmojiPicker 를 qf-m-emoji-drawer 로 래핑                                                                                                                                                     |
| B-39  | MED    | prd-gap      | D05 AC L7308: 모바일 반응 버튼 44×44 — 칩 부재 + 퀵리액션 미달 (partial)                                                                      | MobileMessageSheet.tsx                           | min-w/min-h var(--m-touch) 적용                                                                                                                                                                                       |
| B-40  | MED    | prd-gap      | FR-PK02: 모바일 ':' 이모지 자동완성 없음 (missing)                                                                                            | MobileMessages.tsx                               | 모바일 컴포저에 자동완성 공유 로직 배선                                                                                                                                                                               |
| B-41  | MED    | prd-gap      | FR-PK03·PK04: 모바일 퀵리액션이 서버 prefs 무시한 하드코딩 5종 (divergent)                                                                    | MobileMessageSheet.tsx                           | 퀵리액션 행을 서버 quickReactions+recent 로 치환                                                                                                                                                                      |
| B-42  | MED    | prd-gap      | FR-EM06·EM07: 모바일 본문 커스텀 이모지가 텍스트로 남음 (missing)                                                                             | MobileMessages.tsx                               | useCustomEmojis 조회 후 맵 전달(워크스페이스 채널 한정)                                                                                                                                                               |
| B-43  | MED    | prd-gap      | FR-MN-05~07: 채널 단위 알림 설정 UI 모바일 미도달 (partial)                                                                                   | MobileChannelList.tsx, ChannelNotifSettings.tsx  | 채널 행 롱프레스 시트에 알림 설정 진입 추가                                                                                                                                                                           |
| B-44  | MED    | prd-gap      | FR-MN-08: 모바일 채널 리스트가 MUTE/NOTHING 구분 자체를 미구현 (missing)                                                                      | MobileChannelList.tsx                            | mutes+overrides 조회 후 표 규칙 적용                                                                                                                                                                                  |
| B-45  | MED    | prd-gap      | FR-MN-14: 탭바 배지가 멘션/일반 신호 구분 없는 카운트 임계 로직 (partial)                                                                     | MobileTabBar.tsx                                 | unread 응답의 mention 분리 카운트로 dot/badge/--mention 매핑                                                                                                                                                          |
| B-46  | MED    | prd-gap      | FR-S02: 모바일 수식어 자동완성 — 검색 표면 부재로 미구현 (missing)                                                                            | suggestToken.ts                                  | FR-S01 모바일 표면 신설 시 공유 로직 재사용                                                                                                                                                                           |
| B-47  | MED    | prd-gap      | FR-S03·S14: 모바일 풀스크린 검색 결과 오버레이 미구현 (missing)                                                                               | SearchResultPanel.tsx                            | 결과 패널을 모바일 풀스크린 변형으로 래핑                                                                                                                                                                             |
| B-48  | MED    | prd-gap      | NFR §스토리지: storage_warning 토스트 미구현 + 모바일 첨부 진입점 자체가 죽은 버튼 (missing)                                                  | MobileMessages.tsx                               | plus 버튼에 파일 선택 배선(attachments 기능 재사용) + dispatcher 에 storage_warning 토스트                                                                                                                            |
| B-49  | MED    | prd-gap      | D01 Mock: 모바일 채널 뷰가 mock parity 부분 충족 (partial)                                                                                    | MobileMessages.tsx, MobileMessageSheet.tsx       | 그루핑/날짜 구분선/링크 복사 findings 해소 시 자동 충족                                                                                                                                                               |
| B-50  | MED    | prd-gap      | FR-S06: 모바일 결과 카드 부재 (missing)                                                                                                       | SearchResultPanel.tsx                            |                                                                                                                                                                                                                       |
| B-51  | MED    | prd-gap      | FR-S08·S09: 모바일 정렬 토글/더 보기 부재 (missing)                                                                                           | SearchResultPanel.tsx                            |                                                                                                                                                                                                                       |
| B-52  | MED    | prd-gap      | FR-P01: 모바일 멤버 목록에 IDLE 상태 미렌더 (partial)                                                                                         | MobileMembers.tsx, usePresence.ts                | status() 에 idleUserIds 분기 추가 + qf-avatar\_\_status--idle 렌더                                                                                                                                                    |
| B-53  | MED    | prd-gap      | FR-P02: 터치 이벤트가 activity 로 집계되지 않음 (divergent)                                                                                   | usePresenceActivity.ts                           | touchstart(passive)·pointerdown 을 동일 30초 스로틀로 추가                                                                                                                                                            |
| B-54  | MED    | prd-gap      | FR-P05·P06·P13: 모바일 수동 DND ON/OFF 진입점 부재 (partial)                                                                                  | DndSnoozeControl.tsx, BottomBar.tsx              |                                                                                                                                                                                                                       |
| B-55  | MED    | prd-gap      | FR-P08·P09: 모바일 멤버 목록 그룹/페이지네이션 미흡 (partial)                                                                                 | MobileMembers.tsx, useWorkspaces.ts              |                                                                                                                                                                                                                       |
| B-56  | MED    | prd-gap      | FR-P10: lastSeen '오늘/어제/N일 전' 표기 부재 (missing)                                                                                       | ProfilePopover.tsx, MemberProfilePanel.tsx       |                                                                                                                                                                                                                       |
| B-57  | MED    | prd-gap      | FR-P14·P15 + D08 §presence:subscribe: 모바일 목록 뷰포트 구독 미배선 (partial)                                                                | useViewportPresence.ts, MobileMembers.tsx        |                                                                                                                                                                                                                       |
| B-58  | MED    | prd-gap      | FR-RS-04/05: 모바일 채널 행 멘션/뮤트 구분 미구현 (partial)                                                                                   | MobileChannelList.tsx                            |                                                                                                                                                                                                                       |
| B-59  | MED    | prd-gap      | FR-RS-07: 모바일 Jump to First Unread/Jump to Unread 부재 (missing)                                                                           | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-60  | MED    | prd-gap      | FR-RS-18: 모바일 채널 mark-all-read + Undo 토스트 진입점 부재 (missing)                                                                       | useUnread.ts                                     |                                                                                                                                                                                                                       |
| B-61  | MED    | prd-gap      | FR-RS-08: 모바일 액션 시트에 '미읽으로 표시' 없음 (missing)                                                                                   | MobileMessageSheet.tsx                           |                                                                                                                                                                                                                       |
| B-62  | MED    | prd-gap      | FR-RS-12: 모바일 타임라인에 thread chip/스레드 멘션 뱃지 부재 (partial)                                                                       | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-63  | MED    | prd-gap      | FR-RS-15 + FR-W20/23: 모바일 워크스페이스 레일에 멘션/미읽 뱃지 없음 (partial)                                                                | MobileHome.tsx, MobileChannelList.tsx            |                                                                                                                                                                                                                       |
| B-64  | MED    | prd-gap      | FR-RS-13/16: markAsReadMode 3종 설정 클라이언트 미구현 (missing)                                                                              | attachment.ts                                    |                                                                                                                                                                                                                       |
| B-65  | MED    | prd-gap      | FR-PS-03/04: 모바일 채널 헤더에 핀 아이콘/핀 목록 진입 없음 (missing)                                                                         | MobileShell.tsx, PinPanel.tsx                    |                                                                                                                                                                                                                       |
| B-66  | MED    | prd-gap      | FR-PS-07/08/11/12: 모바일 저장함 진입점·3탭 뷰 부재 (missing)                                                                                 | SavedView.tsx, ChannelColumn.tsx                 |                                                                                                                                                                                                                       |
| B-67  | MED    | prd-gap      | FR-AM-02/22/28: 모바일 업로드 트레이/진행률/재시도/세션 복원 부재 (missing)                                                                   | AttachmentTray.tsx, MobileMessages.tsx           |                                                                                                                                                                                                                       |
| B-68  | MED    | prd-gap      | FR-AM-08: 모바일 비디오 다운로드 카드 부재 (missing)                                                                                          | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-69  | MED    | prd-gap      | FR-AM-19: 모바일 스포일러 첨부 토글 부재 (missing)                                                                                            | AttachmentSpoilerOverlay.tsx                     |                                                                                                                                                                                                                       |
| B-70  | MED    | prd-gap      | FR-AM-25(처리중 skeleton): 모바일 비율 skeleton/READY 교체 부재 (missing)                                                                     | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-71  | MED    | prd-gap      | FR-AM-24: 모바일 첨부 전송 FSM 부재 (missing)                                                                                                 | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-72  | MED    | prd-gap      | D11 Mock 접근성: 모바일에서 라이트박스/progressbar/스포일러 ARIA 적용 대상 표면 자체 부재 (missing)                                           | ImageLightbox.tsx                                |                                                                                                                                                                                                                       |
| B-73  | MED    | prd-gap      | FR-RM05/06/07: Kick/Ban/Timeout 확인 다이얼로그 모바일 진입 불가 (missing)                                                                    | ModerationActions.tsx, MobileMembers.tsx         |                                                                                                                                                                                                                       |
| B-74  | MED    | prd-gap      | FR-RM08: 모바일 컴포저 슬로우모드 쿨다운 피드백 부재 (partial)                                                                                | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-75  | MED    | prd-gap      | FR-RM13: 모바일 작성자명 역할 색상 미적용 (missing)                                                                                           | MobileMessages.tsx, MemberColumn.tsx             |                                                                                                                                                                                                                       |
| B-76  | MED    | prd-gap      | FR-RM07 Edge: 모바일 [타임아웃] 라벨·차단 인지 UI 부재 (partial)                                                                              | MobileMembers.tsx                                |                                                                                                                                                                                                                       |
| B-77  | MED    | prd-gap      | FR-RM11(제출): 모바일 메시지 '신고' 액션 부재 (missing)                                                                                       | MobileMessageSheet.tsx, ReportModal.tsx          |                                                                                                                                                                                                                       |
| B-78  | MED    | prd-gap      | FR-W03: 초대 수락 화면에 아이콘/멤버수/만료/임시 멤버십 표시 누락 (partial)                                                                   | InviteAcceptPage.tsx                             |                                                                                                                                                                                                                       |
| B-79  | MED    | prd-gap      | FR-W07/W08/W09: MobileHome ?chat= 경로에 온보딩 오버레이 미마운트 (partial)                                                                   | MobileHome.tsx, OnboardingHost.tsx               |                                                                                                                                                                                                                       |
| B-80  | MED    | prd-gap      | FR-W09a: 모바일 빈 채널 empty state + 초대 CTA 부재 (missing)                                                                                 | MobileMessages.tsx, CreatorEmptyStateCta.tsx     |                                                                                                                                                                                                                       |
| B-81  | MED    | prd-gap      | FR-W10/W11: 멤버 디렉터리 모바일 진입 불가 (missing)                                                                                          | MemberDirectoryPanel.tsx, MobileShell.tsx        |                                                                                                                                                                                                                       |
| B-82  | MED    | prd-gap      | FR-W02/W17: 모바일 초대링크 생성·관리 진입점 부재 (missing)                                                                                   | CreateInviteModal.tsx, InviteManagerPanel.tsx    |                                                                                                                                                                                                                       |
| B-83  | MED    | prd-gap      | D14 §IA + FR-PS-18: 모바일 드릴다운은 구현됐으나 back 버튼·'나' 탭 동선 불일치 (partial)                                                      | SettingsShell.tsx, MobileHome.tsx                |                                                                                                                                                                                                                       |
| B-84  | MED    | prd-gap      | D14 §외관 + FR-PS-09: chatFontSize 시각 미적용·clock24h 모바일 미반영 (partial)                                                               | applyAppearanceToDOM.ts, MobileMessages.tsx      |                                                                                                                                                                                                                       |
| B-85  | MED    | prd-gap      | D14 §알림&DND + FR-PS-10·11: '모바일 푸시' 토글이 disabled '준비 중' (partial)                                                                | NotificationSettingsPage.tsx                     |                                                                                                                                                                                                                       |
| B-86  | MED    | prd-gap      | FR-PS-07: 메시지 아바타/이름 탭 진입 미배선 + DM CTA 가 데스크톱 라우트로 이동 (partial)                                                      | MobileMessages.tsx, ProfilePopover.tsx           |                                                                                                                                                                                                                       |
| B-87  | MED    | prd-gap      | FR-PS-08: 모바일에서 '전체 프로필' 버튼이 dead control (missing)                                                                              | ProfilePopover.tsx, MemberProfilePanel.tsx       | 모바일에서는 전체화면 시트/스크린으로 MemberProfilePanel 변형 렌더                                                                                                                                                    |
| B-88  | MED    | prd-gap      | D14 모바일 mock(프로필 설정 화면): qf-m-you-\* 헤더 구조 미구현 (divergent)                                                                   | SettingsShell.tsx                                |                                                                                                                                                                                                                       |
| B-89  | MED    | prd-gap      | FR-KS-01~03·KS-11: 모바일 퀵스위처 기능 부재 (missing)                                                                                        | QuickSwitcher.tsx                                |                                                                                                                                                                                                                       |
| B-90  | MED    | prd-gap      | FR-SC-05/06: 모바일에서 슬래시 커맨드가 일반 텍스트로 오발송됨 (partial/divergent)                                                            | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-91  | MED    | prd-gap      | FR-RC03~05: 모바일 @·#·: 트리거 전부 미동작 (missing)                                                                                         | MobileMessages.tsx, Autocomplete.tsx             |                                                                                                                                                                                                                       |
| B-92  | MED    | prd-gap      | FR-RC17: 모바일 컴포저 카운터/4,000자 게이트 부재 (missing)                                                                                   | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-93  | MED    | prd-gap      | FR-RC16: (수정됨) 은 구현, 편집 이력 진입은 모바일 부재 (partial)                                                                             | MobileMessageSheet.tsx                           |                                                                                                                                                                                                                       |
| B-94  | MED    | prd-gap      | FR-RT-15/22: 모바일 around 점프·skeleton·딥링크 anchor 부재 (partial)                                                                         | MobileActivity.tsx, MobileShell.tsx              |                                                                                                                                                                                                                       |
| B-95  | MED    | prd-gap      | FR-RT-02: 모바일 '권한 없음' 상태 화면 부재 (missing)                                                                                         | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-96  | MED    | prd-gap      | D17 모바일 mock: 토프바 '온라인 N명' 부재 + 탭바 3탭 구조 (divergent)                                                                         | MobileShell.tsx, MobileTabBar.tsx                |                                                                                                                                                                                                                       |
| B-97  | MED    | ds-deviation | qf-m-msg --head/--cont 그룹핑 미적용 + 아바타 24px(sm)로 DS 40px 그리드와 불일치                                                              | MobileMessages.tsx                               | 직전 메시지와 작성자/시간창이 같으면 --cont, 아니면 --head 부여(데스크톱 grouping 로직 재사용). 아바타는 md(40px)로 교체.                                                                                             |
| B-98  | MED    | ds-deviation | 컴포저 입력이 단일행 <input> — DS 는 멀티라인 textarea(min 44/max 120px) 스펙                                                                 | MobileMessages.tsx                               | auto-resize textarea 로 교체(Enter 전송/IME 가드는 유지, Shift+Enter 줄바꿈), 액세서리 바는 이모지 드로어 구현과 함께 후속.                                                                                           |
| B-99  | MED    | ds-deviation | 활성 탭 \_\_pill 미렌더(050-3 이중 인코딩 누락) + 배지 의미 체계 전도 + 설정 탭 목적지 비일관                                                 | MobileTabBar.tsx, MobileShell.tsx                | Tab 에 <span class="qf-m-tab__pill"/> 추가, dot/badge 를 **icon 밖 탭 직계로 이동, 멘션 포함 시 **badge--mention 사용·일반 미읽은 카운트 배지로 통일, onSettings 목적지 단일화. 3탭 IA 는 DS 측 목업/패턴 갱신        |
| B-100 | MED    | ds-deviation | DS OverlappingPanels/드로어 패턴 미채택 — 스크림·슬라이드 모션·드래그/플링 전무, 폭 하드코딩, server-header·qf-m-channel 미사용               | MobileDrawer.tsx, MobileChannelList.tsx          | 1단계: 스크림을 qf-m-drawer-scrim 토큰으로 교체 + transform 슬라이드 트랜지션(--m-panel-dur/ease) + 폭 토큰 적용 + 채널 행 qf-m-channel 전환 + server-header 도입. 2단계(별도 슬라이스): qf-m-panels 드래그           |
| B-101 | MED    | ds-deviation | 스와이프 커밋 임계 80px(DS 60px)·qf-m-swipe 힌트 아이콘 미표시·더블탭 quick-react/토스트 미구현                                               | MobileMessages.tsx                               | 임계값을 getComputedStyle 로 --m-swipe-threshold 에서 읽거나 60px 로 정합, 행 컨테이너에 qf-m-swipe 아이콘 렌더 + 드러남 처리, 더블탭 quick-react 는 후속 슬라이스로.                                                 |
| B-102 | MED    | ds-deviation | qf-m-unread-divider(NEW MESSAGES)·qf-m-jump-btn(최신 점프)·날짜 구분선·타이핑 인디케이터가 모바일 채팅에 전무                                 | MobileMessages.tsx, TypingIndicator.tsx          | 데스크톱의 unread/day-divider·typing 데이터 소스를 재사용해 qf-m-unread-divider·qf-m-jump-btn·qf-typing 를 모바일 리스트에 렌더(점프 버튼 bottom 은 DS 적층 공식 준수).                                               |
| B-103 | MED    | ds-deviation | 050 모바일 IA 컴포넌트 8종 전면 미구현: 홈 퀵타일·filter-bar·You 탭·스레드 인박스·채널 브라우저·이모지 드로어·당겨서 새로고침·compact 밀도    | MobileFriends.tsx, MobileDiscover.tsx            | 우선순위 제안: (1) Friends/Discover 필터를 qf-m-filter-bar 로 교체(즉효·저위험), (2) 이모지 드로어로 리액션 프리셋 한계 해소, (3) You 탭 헤더를 SettingsShell 모바일 목록 상단에 qf-m-you-header/card 로 도입. 나머   |
| B-104 | MED    | ds-deviation | 알림 행 actor 가 actorId 8자 슬라이스로 노출 — 목업의 username 표기와 불일치                                                                  | MobileActivity.tsx                               | activity API 응답에 actorUsername 을 포함하거나 워크스페이스 멤버 캐시/유저 조회로 ID→이름 해석 후 표기.                                                                                                              |
| B-105 | MED    | ds-deviation | qf-m-composer\_\_plus(첨부)와 MobileDmList 토프바 검색 버튼이 onClick 미배선 — 표시만 되는 죽은 컨트롤                                        | MobileMessages.tsx, MobileDmList.tsx             | + 버튼은 파일 picker(input type=file) 연결로 첨부 업로드 배선, DM 검색 버튼은 본문 검색 입력 포커스로 연결하거나 제거.                                                                                                |
| B-106 | MED    | ds-deviation | MobileDrawer가 CSS 슬라이드 진입 애니메이션 없이 즉시 나타남                                                                                  | MobileDrawer.tsx, MobileOverlay.tsx              | MobileDrawer에 mounted 상태(useEffect + rAF)를 추가하고 `transform: translateX(-100%)` → `translateX(0)` CSS transition(--dur-fast, --ease-standard)을 적용하세요. MobileOverl                                        |
| B-107 | MED    | ux           | MobileDrawer에 포커스 트랩이 없어 스크린리더/키보드 사용자가 배경 콘텐츠에 접근 가능                                                          | MobileDrawer.tsx                                 | MobileDrawer가 열릴 때 useEffect 내에서 드로어 내 첫 번째 포커스 가능 요소로 focus()를 이동하고, 닫힐 때 triggerRef(열기 버튼)로 포커스를 복귀하세요. MobileMessages의 previousFocusRef 패턴을 재사용할 수 있습니다.  |
| B-108 | MED    | ux           | MobileMessageSheet에 마운트 시 자동 포커스 및 포커스 트랩이 없음                                                                              | MobileMessageSheet.tsx                           | MobileMessageSheet에 `aria-label='메시지 작업'`을 추가하고, useEffect에서 시트 내 첫 번째 버튼(이모지 또는 답장)으로 자동 포커스하세요.                                                                               |
| B-109 | MED    | ux           | 멤버 목록에서 역할이 영문 enum 원문('OWNER', 'MEMBER' 등)으로 표시됨                                                                          | MobileMembers.tsx                                | 역할 enum을 한국어로 매핑하는 함수(`OWNER→'소유자', ADMIN→'관리자', MEMBER→'멤버'`)를 추가하고 표시에 사용하세요.                                                                                                     |
| B-110 | MED    | ux           | DM 목록 섹션 헤더가 영문 'All'로 표시됨                                                                                                       | MobileDmList.tsx                                 | 'All'을 '전체'로 교체하세요.                                                                                                                                                                                          |
| B-111 | MED    | ux           | Activity 화면 제목이 영문 'Activity'로 고정                                                                                                   | MobileActivity.tsx, MobileTabBar.tsx             | 73줄의 'Activity'를 '활동'으로 교체하세요.                                                                                                                                                                            |
| B-112 | MED    | ux           | MobileOverlay의 엣지 스와이프 닫기 threshold가 너무 낮아 의도치 않게 닫힐 수 있음                                                             | MobileOverlay.tsx, MobileMessages.tsx            | 엣지 시작 영역을 20px → 24px, threshold를 40px → 64px로 올리고, 드래그 속도(velocity)를 함께 고려하는 로직을 추가하세요. MobileMessages의 SWIPE_THRESHOLD_PX와 동일한 80px를 기준선으로 맞추는 것을 검토하세요.       |
| B-113 | MED    | ux           | MobileHome DM 섹션 헤더가 스타일 없는 div로 렌더링되어 시각 위계가 불명확                                                                     | MobileHome.tsx                                   | DS 토큰 표준 섹션 헤더 구조를 확인하고, 내부 텍스트 div에 올바른 DS 클래스를 적용하세요.                                                                                                                              |
| B-114 | MED    | ux           | 친구 제거 버튼이 확인 없이 즉시 실행되어 실수 복구 불가                                                                                       | MobileFriends.tsx                                | 제거·차단 버튼 탭 시 확인 bottom sheet 또는 토스트+Undo 패턴(5초 내 취소 가능)을 추가하세요.                                                                                                                          |
| B-115 | MED    | ux           | MobileHome에서 채널 탭 후 MobileOverlay 타이틀이 채널 이름만 표시하여 컨텍스트 손실                                                           | MobileOverlay.tsx, MobileHome.tsx                | MobileOverlay에 subtitle prop을 추가하고, MobileHome에서 openChat 호출 시 채널 이름에 `# ` 접두사를, subtitle에 워크스페이스 이름을 전달하세요.                                                                       |
| B-116 | MED    | ds-deviation | 메시지 목록 스크롤 영역에 qf-m-body 미사용 — overscroll-behavior 누락                                                                         | MobileMessages.tsx                               | scrollRef div의 className을 qf-m-body로 교체하세요. 추가 패딩(px/py)이 필요하면 DS 토큰 기반 page-scoped CSS나 inline style로 보완하세요.                                                                             |
| B-117 | MED    | ds-deviation | disabled 상태에 raw 스케일 토큰 --n-5 직접 참조                                                                                               | MobileEditSheet.tsx                              | disabled:bg-[var(--n-5)]를 disabled:bg-[var(--bg-selected)]로 교체하세요. Tailwind config에 등록된 키(bg-accent)를 쓰면 disabled:bg-accent로도 표현 가능합니다.                                                       |
| B-118 | MED    | ds-deviation | 미등록 토큰 --bg-serverlist 참조                                                                                                              | MobileHome.tsx                                   | --bg-serverlist 참조를 var(--bg-panel)로 직접 교체하거나, 서버레일 배경이 패널과 다른 의미라면 page-scoped CSS에서 로컬 변수로 정의하세요(DS 4파일 수정 금지).                                                        |
| B-119 | MED    | prd-gap      | 모바일 멤버 목록이 IDLE 상태를 버림 — idle 사용자가 오프라인으로 렌더, 메시지 아바타엔 status dot 자체가 없음                                 | MobileMembers.tsx, usePresence.ts                | MobileMembers 에 idleUserIds 추가 구독 → status 4값 매핑(qf-avatar\_\_status--idle), idle 은 온라인 그룹에 포함                                                                                                       |
| B-120 | MED    | prd-gap      | presence:activity 가 mousemove/keydown 만 감지 — 모바일 터치 사용 중에도 10분 후 IDLE 전환                                                    | usePresenceActivity.ts                           | touchstart·pointerdown 를 passive 리스너로 추가(기존 30초 스로틀 공유)                                                                                                                                                |
| B-121 | MED    | prd-gap      | 모바일 수동 DND ON/OFF 진입점 부재 — 표시·스케줄·스누즈는 동작하나 즉시 토글은 데스크톱 BottomBar 전용                                        | BottomBar.tsx, NotificationSettingsPage.tsx      | 위 상태 변경 바텀시트 신설 시 DND 토글·스누즈 포함                                                                                                                                                                    |
| B-122 | MED    | prd-gap      | 모바일 멤버 목록에 hoist 역할 그룹·cursor 50 페이지네이션·가상화 없음 — 온라인/오프라인 2그룹 전량 렌더                                       | MobileMembers.tsx, MemberColumn.tsx              | MemberColumn 의 그룹핑 셀렉터를 공유 모듈로 추출해 MobileMembers 에 적용, 스크롤 기반 50명 추가 로드                                                                                                                  |
| B-123 | MED    | prd-gap      | '오늘/어제/N일 전' 마지막 접속 표기 UI 가 전 플랫폼에 없음 (모바일 프로필 포함)                                                               | ProfilePopover.tsx, api.ts                       | ProfilePopover/MemberProfilePanel 의 오프라인 상태 행에 lastSeenAt 둔감화 포맷터 추가                                                                                                                                 |
| B-124 | MED    | prd-gap      | 모바일은 뷰포트 presence:subscribe 미적용 — useViewportPresence 가 데스크톱 MemberColumn 전용                                                 | useViewportPresence.ts, MobileMembers.tsx        | MobileMembers 행에 useViewportPresence observer 연결(드로어 스크롤 컨테이너 기준)                                                                                                                                     |
| B-125 | MED    | prd-gap      | 모바일 채널 행: 미읽/멘션 시각 구분 없음(둘 다 동일 count 배지) + 뮤트 채널 억제 미구현                                                       | MobileChannelList.tsx                            | unread.mention 일 때만 숫자 배지(danger), 비멘션 미읽은 qf-m-row--unread 강조만; useMutedChannelIds 로 뮤트 억제 추가                                                                                                 |
| B-126 | MED    | prd-gap      | 모바일 상/하단 'Jump to First Unread' 버튼 부재 — DS qf-m-jump-btn 미사용                                                                     | MobileMessages.tsx                               | divider 구현과 함께 qf-m-jump-btn 상/하단 조건부 렌더 추가                                                                                                                                                            |
| B-127 | MED    | prd-gap      | 모바일 채널 '모두 읽음' 진입점 부재 — Undo 토스트 UX 도달 불가                                                                                | MobileChannelList.tsx, MobileActivity.tsx        | 모바일 미읽 화면(위 finding) 탑바에 '모두 읽음' 액션 + Undo 토스트 연결                                                                                                                                               |
| B-128 | MED    | prd-gap      | 모바일 롱프레스 시트에 '미읽으로 표시' 액션 없음 — useMarkUnread 는 데스크톱 메뉴 전용                                                        | MobileMessageSheet.tsx                           | 시트에 '미읽으로 표시' 항목 추가(useMarkUnread 재사용, 워크스페이스 채널 한정)                                                                                                                                        |
| B-129 | MED    | prd-gap      | 모바일 메시지 행에 스레드 chip 부재 — 스레드 존재·스레드 멘션 뱃지가 타임라인에서 비가시                                                      | MobileMessages.tsx, ThreadPanel.tsx              | MobileMessageRow 본문 아래 thread chip(답글 N · 멘션 뱃지) 렌더 + 탭 시 ThreadPanel(mobile) 오픈                                                                                                                      |
| B-130 | MED    | prd-gap      | 모바일 워크스페이스 레일/미니레일에 멘션 합산 뱃지 없음 (데스크톱 WorkspaceNav 는 구현)                                                       | MobileHome.tsx, MobileChannelList.tsx            | badgeStore/serverButtonBadge 셀렉터를 RailAvatar·미니레일에 재사용                                                                                                                                                    |
| B-131 | MED    | prd-gap      | markAsReadMode 3종 설정·동작이 전 플랫폼 미구현 (모바일 포함)                                                                                 | NotificationSettingsPage.tsx, MobileMessages.tsx | UserSettings 에 모드 추가 + 설정 UI + useMessageHistory 초기 커서/ACK 정책 분기 (별도 슬라이스)                                                                                                                       |
| B-132 | MED    | prd-gap      | 모바일 핀 목록 진입 불가 — PinPanel·핀 카운트 아이콘이 데스크톱 MessageColumn 헤더 전용                                                       | PinPanel.tsx, MobileShell.tsx                    | 모바일 토프바에 핀 아이콘(카운트) 추가 → 전체화면/시트형 핀 목록(PinPanel 데이터 훅 재사용)                                                                                                                           |
| B-133 | MED    | prd-gap      | Kick/Ban/Timeout 확인 다이얼로그 모바일 진입 불가 — ModerationActions 가 데스크톱 패널 전용, ProfilePopover 엔 모더레이션 액션 없음           | ModerationActions.tsx, ProfilePopover.tsx        | 권한 보유 시 ProfilePopover(또는 모바일 멤버 행 롱프레스 시트)에 모더레이션 액션 노출 → 기존 ModerationActions 다이얼로그 재사용                                                                                      |
| B-134 | MED    | prd-gap      | 슬로우모드 쿨다운 컴포저 피드백이 전 플랫폼 부재 (모바일 포함) — 429/Retry-After 사용자 안내 없음                                             | MobileMessages.tsx, MessageComposer.tsx          | send 실패 429 시 Retry-After 를 읽어 컴포저에 카운트다운 배너 + 버튼 disable (공유 훅으로 양 플랫폼 적용)                                                                                                             |
| B-135 | MED    | prd-gap      | 작성자 이름 역할 색(colorHex) 적용이 전 플랫폼 부재 — 모바일 qf-m-msg\_\_author 무색, 데스크톱도 역할 점만                                    | MessageItem.tsx, MobileMessages.tsx              | 멤버→최상위 역할 colorHex 셀렉터 공유 구현 후 양 플랫폼 작성자명 span 에 style 적용                                                                                                                                   |
| B-136 | MED    | prd-gap      | 모바일에 [타임아웃] 라벨·입력 차단 인지 UI 부재                                                                                               | MobileMembers.tsx, MobileMessages.tsx            | MobileMembers 행에 mutedUntil 라벨, 컴포저에 member:timeout_applied 수신 시 disabled+안내 배너                                                                                                                        |
| B-137 | MED    | prd-gap      | 410 오류 화면이 지정 카피·워크스페이스명 박스·'홈으로 이동' 버튼 미구현 — Playwright 텍스트 AC 불충족                                         | InviteAcceptPage.tsx                             | 지정 카피로 교체 + preview.workspace.name 가용 시 박스 렌더 + '홈으로 이동' qf-btn--primary 풀폭 버튼 추가                                                                                                            |
| B-138 | MED    | prd-gap      | OnboardingHost 가 /w/:slug 경로(MobileShell)에만 마운트 — 홈 ?chat= 오버레이로 워크스페이스 채널 진입 시 규칙 동의 UI 없음                    | MobileHome.tsx, OnboardingHost.tsx               | MobileHome 에서 active workspace 선택 시 OnboardingHost(workspaceId) 마운트(오버레이 z-index 가 chat 오버레이 위가 되도록)                                                                                            |
| B-139 | MED    | prd-gap      | 모바일 빈 채널 empty state('채널이 조용하네요…')+초대 CTA 부재 — CreatorEmptyStateCta 가 데스크톱 전용                                        | CreatorEmptyStateCta.tsx, MobileMessages.tsx     | messages.length===0 && !isLoading 시 qf-m-empty + CreatorEmptyStateCta(모바일 변형) 렌더                                                                                                                              |
| B-140 | MED    | prd-gap      | 모바일 설정 드릴다운은 구현됐으나 자식 화면에 back/저장 액션 토프바 부재 + mock '나' 탭 구조와 상이 + 탭바 목적지 비일관                      | SettingsShell.tsx, MobileShell.tsx               | 모바일 분기에서 자식 라우트에 공통 qf-m-topbar(back→/settings) 래퍼 제공, 탭바 onSettings 목적지를 /settings 로 통일                                                                                                  |
| B-141 | MED    | prd-gap      | 모바일 메시지 시각이 24시간 시계 설정 미적용(하드코딩 locale 포맷) + 밀도 미적용, 폰트 크기는 전 플랫폼 미적용                                | MobileMessages.tsx, applyAppearanceToDOM.ts      | MobileMessageRow 시각을 formatClockPart(useClock24h) 로 교체; 밀도는 qf-m-msg 변형 또는 spacing 토큰 분기                                                                                                             |
| B-142 | MED    | prd-gap      | '모바일 푸시' 토글이 disabled '준비 중' — 알림 푸시 전송 인프라 부재로 DND 푸시 스킵도 모바일에서 검증 불가                                   | NotificationSettingsPage.tsx, webPush.ts         | 기존 VAPID 구독 경로(webPush.ts)를 알림 채널 설정과 연결해 토글 활성화, 서버 발송 시 DND 검사 경유                                                                                                                    |
| B-143 | MED    | prd-gap      | 모바일 팝오버 진입이 멤버 드로어 행 탭뿐 — 메시지 아바타/이름 탭 미배선 (데스크톱은 배선됨)                                                   | MobileMessages.tsx, ProfilePopover.tsx           | MobileMessageRow 아바타를 ProfilePopover 트리거로 래핑(롱프레스 제스처와 탭 분리 — 탭=팝오버, 롱프레스=시트)                                                                                                          |
| B-144 | MED    | prd-gap      | 모바일에서 '전체 프로필' 버튼이 죽은 컨트롤 — MemberProfilePanel 이 DesktopShell 에만 마운트                                                  | MemberProfilePanel.tsx, MobileShell.tsx          | 모바일에서는 profilePanelUserId 세팅 시 전체화면 dialog(ThreadPanel mobile 패턴)로 MemberProfilePanel 렌더, 또는 팝오버에서 링크 숨김 전까지 임시 비노출                                                              |
| B-145 | MED    | prd-gap      | 롱프레스 시트에 핀/북마크/리마인더/신고/미읽표시/전체 이모지 피커 부재 — PRD 요구 액션의 절반만 제공                                          | MobileMessageSheet.tsx, MobileMessages.tsx       | 시트에 핀/저장/신고/미읽표시 추가 + '+' 버튼으로 qf-m-emoji-drawer 풀 피커, MobileMessageRow 에 ReactionBar(모바일 변형) 렌더                                                                                         |
| B-146 | MED    | prd-gap      | 퀵스위처 기능 모바일 부재 — QuickSwitcher 가 DesktopShell 전용, 대체 진입점 없음                                                              | QuickSwitcher.tsx, MobileShell.tsx               | 모바일 토프바/홈 검색 진입점에서 QuickSwitcher 데이터 훅 재사용한 전체화면 점프 화면 제공(빈 상태 힌트는 터치 카피로 대체)                                                                                            |
| B-147 | MED    | prd-gap      | 모바일 컴포저가 plain <input> — WYSIWYG-lite(인라인 렌더·멘션 pill) 미지원, IME Enter 억제만 충족                                             | MobileMessages.tsx, MessageComposer.tsx          | 데스크톱 컴포저 코어를 모바일 변형으로 재사용(visualViewport 대응 포함)하거나, 최소 멘션 pill 토크나이즈를 input 위 오버레이로 제공                                                                                   |
| B-148 | MED    | prd-gap      | 모바일 컴포저에 4,000자 카운터·초과 전송 차단 없음 — 빈 입력만 disabled                                                                       | MobileMessages.tsx                               | composerCounter 재사용 — 3,800자+ 시 카운터 노출, 4,000 초과 시 send disabled                                                                                                                                         |
| B-149 | MED    | prd-gap      | 모바일에서 시스템 메시지 아이콘+이탤릭, BOT 배지+embed 카드, 멘션 행 배경 강조 전부 미구현                                                    | MobileMessages.tsx                               | MobileMessageRow 에 type==='SYSTEM\_\*'/authorType==='BOT'/mentionsMe 분기 추가(데스크톱 판정 로직 재사용)                                                                                                            |
| B-150 | MED    | prd-gap      | 모바일은 legacy 텍스트 렌더러만 사용 — 스포일러·헤딩 미렌더, 점보 이모지(32px) 미적용, 커스텀 이모지 맵 미전달                                | MobileMessages.tsx, renderAst.tsx                | MobileMessageRow 를 contentAst 우선 renderAst 경로로 전환(+customEmojis 맵, jumbo 클래스)                                                                                                                             |
| B-151 | MED    | prd-gap      | 권한 없는 채널 진입 시 모바일은 무음 빈 목록 — '권한 없음' 상태 화면 부재                                                                     | MobileMessages.tsx                               | history.isError && 403 시 qf-m-empty '이 채널을 볼 권한이 없습니다' 상태 렌더                                                                                                                                         |
| B-152 | MED    | prd-gap      | 모바일은 before 무한스크롤만 — around 3-segment 점프·방향별 skeleton row 부재                                                                 | MobileMessages.tsx, MobileShell.tsx              | MobileShell 에서 ?msg= 를 jumpMessageId 로 전달 + around 로딩 중 skeleton row 렌더                                                                                                                                    |
| B-153 | MED    | prd-gap      | mock 대비 divergent: 토프바 '온라인 N명' 부재, 탭바 4탭→3탭, 채널 탭 멘션 배지(qf-m-tab\_\_badge--mention) 없음                               | MobileShell.tsx, MobileTabBar.tsx                | 토프바 subtitle 에 usePresence 온라인 수 표기 추가; 탭바 구조는 PRD mock 갱신 또는 구현 정합 중 택1 결정 필요(prd-issue 성격 병존)                                                                                    |
| B-154 | MED    | prd-gap      | 모바일 토프바 '온라인 N명' 부재 + 상태 수동 변경 UI 모바일 미접근 (표시 닷 자체는 부분 동작)                                                  | MobileShell.tsx, BottomBar.tsx                   | 커스텀 상태 finding 의 상태 변경 바텀시트와 토프바 온라인 수 표기를 함께 도입                                                                                                                                         |
| B-155 | MED    | ds-deviation | 활성 탭 qf-m-tab\_\_pill 요소 미렌더 — 색+모양 이중 인코딩(decision 050-3) 상실                                                               | MobileTabBar.tsx, mobile.css                     | Tab 버튼 마지막 자식으로 <span className="qf-m-tab__pill" aria-hidden /> 추가(CSS 가 aria-selected 로 표시 제어).                                                                                                     |
| B-156 | MED    | ds-deviation | 탭 배지 의미 체계 역전: 1–9 미읽음을 dot 으로 강등, \_\_badge--mention(danger) 미사용                                                         | MobileTabBar.tsx                                 | 카운트>0 이면 항상 **badge 로 숫자 표시(99+ 캡 유지), 멘션 포함 시 **badge--mention 으로 승격, dot 은 카운트 없는 활동 신호에만 사용.                                                                                 |
| B-157 | MED    | ds-deviation | 탭바 IA 3탭(설정) vs DS 4탭(You) — qf-m-you-\* 프로필 화면 미구현, 설정 목적지 비일관, 설정 화면서 탭바 소실                                  | MobileTabBar.tsx, SettingsShell.tsx              | 설정 목적지를 한 곳(/settings)으로 통일하고 SettingsShell 모바일 목록 화면에 MobileTabBar(active='settings')+qf-m-safe-top 추가. 목록 상단에 qf-m-you-header/qf-m-you-status·qf-m-you-card 적용                       |
| B-158 | MED    | ds-deviation | 채널 행이 qf-m-channel 대신 qf-m-row 사용 — 활성 채널 선택 표시가 시각적으로 부재, qf-m-server-header 미사용                                  | MobileChannelList.tsx, mobile.css                | ChannelRow 를 qf-m-channel(+--unread, aria-selected) 로 교체하고 미읽 카운트는 \_\_suffix 슬롯에 배치. 드로어 최상단을 qf-m-server-header 로 교체.                                                                    |
| B-159 | MED    | ds-deviation | 스와이프 커밋 임계 80px(DS --m-swipe-threshold=60px 무시) + qf-m-swipe 힌트 아이콘 미렌더                                                     | MobileMessages.tsx, mobile.css                   | 임계값을 getComputedStyle 로 --m-swipe-threshold 에서 읽거나 60px 로 정렬하고, 행 내부에 qf-m-swipe 요소를 두어 swipeOffset>0 일 때 opacity 를 올립니다. LONG_PRESS_MS 는 --dur-longpress(500ms)                      |
| B-160 | MED    | ds-deviation | 퀵리액션 버튼이 qf-m-react-chip(44×44) 대신 ~26–34px 임의 버튼 — 44px 터치 플로어 위반, 이모지 드로어 부재                                    | MobileMessageSheet.tsx, mobile.css               | 퀵리액션 행을 qf-m-react-row + qf-m-react-chip 으로 교체(자동 44×44 확보), 끝에 --more 칩을 두고 qf-m-emoji-drawer 기반 전체 픽커를 연결.                                                                             |
| B-161 | MED    | ds-deviation | 컴포저 입력이 단일행 <input> — DS qf-m-composer\_\_input 은 textarea(min 44/max 120px 멀티라인) 규격                                          | MobileMessages.tsx                               | input 을 자동 성장 textarea(rows=1, scrollHeight 기반 120px 캡)로 교체하고 Enter=전송/Shift+Enter=줄바꿈 정책 결정. 래퍼의 qf-m-safe-bottom 은 제거해 safe-area 이중 합산 해소.                                       |
| B-162 | MED    | ds-deviation | qf-m-unread-divider(NEW MESSAGES)·qf-m-jump-btn(최신으로 점프) 모바일 미구현                                                                  | MobileMessages.tsx, mobile.css                   | lastReadAt 경계에 qf-m-unread-divider 삽입, wasAtBottom=false 중 신규 메시지 도착 시 qf-m-jump-btn(+\_\_badge 카운트) 표시 → 탭 시 바닥 스크롤.                                                                       |
| B-163 | MED    | ds-deviation | 기본 랜딩인 Home 의 DM 목록이 DS 'DMs Inbox' 구조 대비 대폭 축소(검색·FAB·미읽 배지·시간·프레즌스 전무) + /dms 토프바 검색 버튼 죽은 컨트롤   | MobileHome.tsx, MobileDmList.tsx                 | DmContent 에 MobileDmList 의 행 구성(상태점·\_\_time·badge·--unread)과 qf-m-search·qf-m-fab 을 이식하거나, Home DM 패널을 MobileDmList 컴포넌트 재사용으로 통합. 죽은 검색 버튼은 본문 검색 포커스로 배선하거나 제거. |
| B-164 | MED    | ds-deviation | 알림 행 actor 가 actorId 8자 슬라이스로 표시 — DS 목업의 사용자명(\_\_actor) 구조 미충족                                                      | MobileActivity.tsx                               | 활동 API 응답에 actorUsername 포함(또는 워크스페이스 멤버 캐시 userId→username 해석)으로 \_\_actor·Avatar 에 실명 표시.                                                                                               |
| B-165 | MED    | ds-deviation | Channel 목업 구성 요소 누락: 타이핑 인디케이터(qf-typing)·날짜 디바이더·topbar 멤버수 subtitle                                                | MobileShell.tsx, MobileMessages.tsx              | MobileMessages 하단에 기존 TypingIndicator 재사용 마운트, createdAt 날짜 경계에 디바이더 행 삽입, MobileShell subtitle 을 `${active.name} · ${members.length} members` 로.                                            |
| B-166 | LOW    | prd-gap      | §02: 768px 경계 불일치 + 보조 라우트 비반응형 분기 (partial)                                                                                  | Shell.tsx, App.tsx                               | 보조 라우트도 useIsMobile 훅으로 통일                                                                                                                                                                                 |
| B-167 | LOW    | prd-gap      | FR-IA-MOB-01a: 스텝 Back 버튼 부재 (partial)                                                                                                  | OnboardingOverlay.tsx, StepInterests.tsx         | 각 Step 푸터에 Back 추가(Step1 은 disabled), 선택 상태를 오버레이 레벨로 끌어올려 보존                                                                                                                                |
| B-168 | LOW    | prd-gap      | §01 i18n: i18n 키 체계 부재 + 모바일에 영어 하드코딩 잔존 (partial)                                                                           | MobileActivity.tsx, MobileDmList.tsx             | 최소한 영어 카피 4곳 ko-KR 교체, 장기로 i18n 키 도입                                                                                                                                                                  |
| B-169 | LOW    | prd-gap      | FR-CH-16 (P2): 개인 사이드바 섹션 — 전역 미구현 (missing)                                                                                     | channels                                         | P2 백로그 유지 또는 PRD 에서 deferred 명시                                                                                                                                                                            |
| B-170 | LOW    | prd-gap      | FR-CH-18 (P2): FORUM 채널 — 전역 미구현 (missing)                                                                                             | channels                                         | P2 백로그 유지                                                                                                                                                                                                        |
| B-171 | LOW    | prd-gap      | FR-DM-04: 모바일 DM 검색이 1:1 username 클라 필터만 (partial)                                                                                 | MobileDmList.tsx                                 | 죽은 버튼 제거 또는 본문 검색 포커스로 배선, 그룹 포함 필터                                                                                                                                                           |
| B-172 | LOW    | prd-gap      | FR-DM-06 (P2): 그룹 아이콘 표시 — 모바일 그룹 표면 부재로 함께 미구현 (missing)                                                               | MobileDmList.tsx                                 | 그룹 표면 도입 시 함께                                                                                                                                                                                                |
| B-173 | LOW    | prd-gap      | FR-DM-15: 행 배지는 구현, 탭바 DM 미읽 카운트는 표면 제거로 부재 (partial)                                                                    | MobileTabBar.tsx                                 | 홈 탭에 DM 미읽 합산 dot/배지 노출 또는 PRD 개정                                                                                                                                                                      |
| B-174 | LOW    | prd-gap      | FR-MN-16: 모바일은 권한 무관 @everyone 을 항상 멘션 스타일로 렌더 (divergent)                                                                 | parseContent.tsx                                 | 모바일 renderAst 전환으로 자동 해소                                                                                                                                                                                   |
| B-175 | LOW    | prd-gap      | FR-MN-18 (P2): desktopLevel/mobileLevel 분리 설정 — 전역 미구현 (missing)                                                                     | notifications                                    | P2 백로그 유지                                                                                                                                                                                                        |
| B-176 | LOW    | prd-gap      | FR-S13: 클라이언트 게이트는 공유 유틸로 존재하나 모바일 적용 표면 없음 (missing)                                                              | searchQueryGate.ts                               |                                                                                                                                                                                                                       |
| B-177 | LOW    | prd-gap      | D11 Edge [MinIO 503]: 모바일 + 버튼 disabled/토스트/자동 재시도 미배선 (missing)                                                              | MobileMessages.tsx                               |                                                                                                                                                                                                                       |
| B-178 | LOW    | prd-gap      | D18 AC(터치 타겟 ≥44px): 보조 버튼이 36px/28px (partial)                                                                                      | LoginPage.tsx                                    |                                                                                                                                                                                                                       |
| B-179 | LOW    | prd-gap      | D18 UX C-5: .qf-otp-input 6칸 패턴 대신 단일 입력 (divergent)                                                                                 | TotpSetupWizard.tsx                              |                                                                                                                                                                                                                       |
| B-180 | LOW    | ds-deviation | 시트에 \_\_title 미사용 + 목업의 'Pin message'/'Copy link' 액션 부재                                                                          | MobileMessageSheet.tsx                           | qf-m-sheet\_\_title 추가, 핀 고정/해제 액션(권한 게이트 데스크톱과 동일) 및 메시지 링크 복사 항목 추가.                                                                                                               |
| B-181 | LOW    | ds-deviation | 홈이 목업 'DMs·Inbox' 구조와 다른 자체 레일+분할 합성 — 검색·Pinned·시간/미읽/프레즌스·FAB 부재, 토큰 외 raw 스타일 잔존                      | MobileHome.tsx                                   | DM 행에 lastMessageAt/\_\_time·unread 배지·프레즌스 점을 MobileDmList 와 동일하게 추가, 레일 선택 링은 DS 토큰화(또는 DS 에 레일 클래스 신설). 레일 IA 유지 시 mobile-mockups 갱신으로 정본 동기화.                   |
| B-182 | LOW    | ds-deviation | /activity·/friends·/discover 의 matchMedia 1회 평가 비반응 분기 + MobileOverlay 가 패널 모션 토큰(--m-panel-dur/ease) 대신 --dur-fast 사용    | App.tsx, MobileOverlay.tsx                       | 세 라우트를 Shell 과 동일한 useIsMobile 훅으로 전환, MobileOverlay 트랜지션을 --m-panel-dur/--m-panel-ease 로 교체하고 커밋 임계를 --m-swipe-threshold 와 정합.                                                       |
| B-183 | LOW    | ds-deviation | MobileEditSheet 저장 버튼 disabled 색이 tier-1 원시 토큰(--n-5) 직참조                                                                        | MobileEditSheet.tsx, MobileDmList.tsx            | DS 에 --bg-disabled 류 시맨틱 토큰을 추가하는 별도 DS 과제로 묶어 일괄 치환(앱 단독 수정 불요).                                                                                                                       |
| B-184 | LOW    | ux           | Tab 버튼에 role='tab' 없이 aria-selected만 사용하여 시맨틱 불완전                                                                             | MobileTabBar.tsx                                 | nav > button 구조를 유지한다면 `aria-selected` 대신 `aria-current='page'`를 사용하거나, role='tablist'를 nav에 추가하고 버튼에 role='tab'을 추가하세요.                                                               |
| B-185 | LOW    | ux           | 워크스페이스 rail 아바타 버튼에 unread 배지가 없어 알림 상태 인식 불가                                                                        | MobileHome.tsx                                   | RailAvatar에 badgeCount/hasMention prop을 추가하고, unread가 있는 워크스페이스 아바타에 qf-m-tab\_\_dot 또는 qf-badge--count를 오버레이하세요.                                                                        |
| B-186 | LOW    | ux           | 채널이 채널명 기반 URL(/w/:slug/:name)로 라우팅되어 이름 변경 시 링크가 깨질 수 있음                                                          | MobileChannelList.tsx                            | 채널 ID를 URL에 포함하는 라우트 구조(예: /w/:slug/c/:channelId)로 마이그레이션을 장기적으로 검토하세요.                                                                                                               |
| B-187 | LOW    | ux           | MobileHome 친구 섹션에서 온라인 상태 점(dot)이 미표시                                                                                         | MobileHome.tsx                                   | MobileHome에서도 useDmPresence 훅을 연결하고 친구 아바타에 status prop을 전달하세요.                                                                                                                                  |
| B-188 | LOW    | ds-deviation | qf-m-sheet에 p-[var(--s-4)] 추가 → DS 컴포넌트 내부 패딩 오버라이드                                                                           | MobileFriends.tsx                                | p-[var(--s-4)] 전체 패딩 대신 시트 내부 콘텐츠(입력·버튼 영역) 래퍼에 DS 토큰 기반 px/py를 개별 적용하세요. qf-m-sheet 자체에는 추가 패딩을 붙이지 마세요.                                                            |
| B-189 | LOW    | ds-deviation | qf-m-composer\_\_plus/send 터치 타깃 오버라이드 — DS 원본 44px에 min-\* 중복 적용                                                             | mobile-touch-target.css                          | 주석을 실제 DS 스펙(44px = var(--m-touch) 이미 적용됨)으로 수정하고 중복 min-width/min-height 규칙 삭제를 검토하세요.                                                                                                 |
| B-190 | LOW    | ds-deviation | qf-m-topbar\_\_titleBlock BEM 요소에 구조 수식 Tailwind 클래스 혼용                                                                           | MobileDmChat.tsx                                 | flex/items-center/gap 클래스를 qf-m-topbar**titleBlock에서 제거하고, Avatar + 텍스트 묶음을 위한 별도 wrapper div를 만들어 flex 레이아웃을 적용하세요. qf-m-topbar**titleBlock 자체의 column 구조는 DS 정             |
| B-191 | LOW    | ux           | qf-m-segment에 5개 탭 — 좁은 화면에서 레이블 클리핑 위험                                                                                      | MobileActivity.tsx                               | 세그먼트 부모에 overflowX: auto를 추가(MobileFriends/MobileDiscover처럼)하거나, qf-m-filter-bar + qf-m-filter-chip 클래스로 교체해 가로 스크롤 필터 바로 구현하세요.                                                  |
| B-192 | LOW    | prd-gap      | 초대 수락 화면에 멤버 수·만료 정보·임시 멤버십 표시 박스 미구현 (모바일 목업 항목, 전 플랫폼 공통)                                            | InviteAcceptPage.tsx                             | GET /invite/{code} 응답의 memberCount/expiresAt/temporary 필드를 카드에 추가 렌더                                                                                                                                     |
| B-193 | LOW    | prd-gap      | (수정됨) 레이블은 구현 — '편집 이력 보기' 모바일 진입점만 부재                                                                                | MobileMessageSheet.tsx                           | edited 메시지에 한해 시트에 '편집 이력 보기' 항목 추가(EditHistoryPopover 콘텐츠를 시트로)                                                                                                                            |
| B-194 | LOW    | prd-gap      | 갭 동기화 자체는 공유로 동작 — truncated/SYNC_FAILED 토스트가 토스트 뷰포트 부재 화면에서 미표시, 모바일 갭 머지 스크롤 보정은 prepend 경로만 | MobileMessages.tsx, useChannelSync.ts            | ToastViewport 루트 마운트(횡단 finding)로 토스트 해결; 갭 머지 시 scrollHeight 델타 보정을 fetch 출처 무관하게 적용                                                                                                   |
| B-195 | LOW    | ds-deviation | 시트 등장 모션(--m-sheet-ease/--m-sheet-dur) 미적용 — 4개 시트 모두 즉시 출현, grab 핸들은 장식                                               | MobileMessageSheet.tsx, MobileEditSheet.tsx      | 공용 MobileSheet 래퍼를 만들어 mount 시 translateY(100%)→0 전환(transform var(--m-sheet-dur) var(--m-sheet-ease)) + grab 드래그 다운 dismiss 를 일괄 적용.                                                            |
| B-196 | LOW    | ds-deviation | qf-m-search 이중 인셋 — 자체 margin 16px 위에 래퍼 padding 16px 가산(총 32px, DS 거터의 2배)                                                  | MobileChannelList.tsx, MobileDmList.tsx          | 래퍼 px 패딩 제거(상하 여백만 필요하면 py 만 유지)하고 qf-m-search 내장 마진에 위임.                                                                                                                                  |
| B-197 | LOW    | ds-deviation | 토큰 비매핑 raw 값 모음: 드로어 360px, 선택 링 임의 shadow, 50vh, --n-5 직참조, transition 폴백 raw, segment 인라인 overflow                  | MobileDrawer.tsx, MobileHome.tsx                 | 드로어 폭→--w-drawer-left/--w-memberlist, 선택 링→focus-ring 류 공용 토큰 신설 검토, 50vh→qf-m-sheet max-height 80% 위임, 오버레이 임계→--m-swipe-threshold 정렬, segment 가로 스크롤 필요 시 qf-m                    |
| B-198 | LOW    | ds-deviation | 5개 필터를 균등 컬럼 qf-m-segment 에 수용 — DS 가로 스크롤 칩(qf-m-filter-bar) 용도 구분 미준수                                               | MobileActivity.tsx, MobileFriends.tsx            | 필터 4개 초과 화면(Activity 5종, Discover 카테고리 가변)은 qf-m-filter-bar/chip 으로 전환, segment 는 ≤4 고정 세트에만 유지.                                                                                          |
| B-199 | LOW    | ds-deviation | DS 050 모바일 IA 블록 미구현 일괄: 홈 퀵타일·스레드 인박스·채널 브라우저·당겨서 새로고침·compact 밀도                                         | mobile.css                                       | 우선순위 제안: ① qf-m-thread-inbox(데스크톱 스레드 parity), ② qf-m-channel-browser(모바일 채널 가입 동선), ③ ptr·tile-row·compact 는 백로그.                                                                          |
| B-200 | LOW    | ux           | 모바일 분기 matchMedia 1회 평가(비반응형) — 회전/리사이즈로 767px 경계 횡단 시 데스크톱·모바일 트리 불일치                                    | App.tsx                                          | 세 라우트 가드도 Shell 과 동일한 useIsMobile 훅으로 교체해 브레이크포인트 횡단 시 자동 리마운트.                                                                                                                      |

## C. 기각된 발견 (적대 검증에서 허위로 판정)

- C-1 ~~모바일 '미읽' 탭/Unreads View 부재 — UnreadsView 는 데스크톱 ChannelColumn 전용, 탭바는 3탭~~ — The finding's raw facts check out — UnreadsView mounts only in desktop ChannelColumn.tsx:156-157, MobileTabBar has 3 tabs, and Mock C does depict a mobile '미읽' screen — but the finding misclassifies an illustrative, internally inconsistent, and design-superseded PRD mock as a requirement. The PRD's
- C-2 ~~워크스페이스 진입 후 채널 미선택 상태에서 메시지 작성 불가임을 사용자가 인지하기 어려움~~ — The finding is refuted by the very lines it cites. (1) Its core claim — "빈 상태 문구만으로는 채널 선택 트리거를 안내하기에 부족" — is false: the empty state body at MobileShell.tsx:145 already says "좌상단 메뉴에서 채널을 고르면 대화가 시작돼요.", which is essentially the suggestedFix ("좌상단 아이콘을 탭하세요" 류 트리거 위치 안내 문구) already implemented. The
- C-3 ~~qf-m-sheet + qf-m-safe-bottom 병용 → safe-area-inset-bottom 이중 적용~~ — The finding rests on a false premise about CSS: padding-bottom from two classes on the same element does not accumulate. Both .qf-m-sheet (mobile.css:285, padding-bottom: calc(8px + env(safe-area-inset-bottom))) and .qf-m-safe-bottom (mobile.css:34, padding-bottom: env(safe-area-inset-bottom)) set t

## D. PRD 자체 결함 (모바일 UX 악영향 — PRD 개정 대상)

| #    | PRD 위치                                                       | 문제                                                                                                                                                                                                                                                                                                                                          | 개정 제안                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | §02 IA 탭바 vs D02 Mock 5                                      | 모바일 탭바 구성이 문서 내에서 상충함: §02 IA와 온보딩 mock은 5탭(채팅·인박스·스레드·검색·나)을 규정하는데, D02 모바일 채널 목록 mock은 3탭(채널·받은편지함·나, 아이콘도 hash/bell/user로 상이)을 보여줌. 구현 시 어느 쪽이 권위인지 불명확.                                                                                                  | §02 IA의 5탭(채팅·인박스·스레드·검색·나)을 카노니컬로 명시하고 D02 mock을 폐기 표기하거나 갱신. 탭 라벨·아이콘·배지 규칙을 단일 표로 고정.                                                         |
| D-2  | FR-MSG-07·10·12 / FR-CH-19                                     | hover 의존 어포던스가 다수(편집 시각 tooltip, grouped 메시지의 hover 시 HH:MM, ISO tooltip, disabled composer 툴팁)인데 모바일에는 hover가 없고 PRD가 모바일 대안을 정의하지 않음. 검증 가능한 모바일 AC가 부재.                                                                                                                              | 모바일 대안 명시: grouped 타임스탬프·편집 시각은 롱프레스 액션 시트 또는 메시지 상세에서 노출, disabled composer는 탭 시 토스트/인라인 안내로 대체하는 규칙을 cross-cutting으로 추가.              |
| D-3  | FR-MSG-01                                                      | 'Enter 전송 / Shift+Enter 줄바꿈'은 물리 키보드 가정. 모바일 소프트 키보드에서 Enter의 의미(줄바꿈 vs 전송)와 enterKeyHint 설정이 미정의 — 모바일에서 의도치 않은 전송 또는 줄바꿈 불가 UX가 생길 수 있음.                                                                                                                                    | 모바일에서는 Enter=줄바꿈, 전송은 send 버튼 전용(enterKeyHint='enter' 또는 'send' 정책 명시)으로 분기 규칙을 FR에 추가.                                                                            |
| D-4  | FR-IA-MOB-05 vs FR-MSG-17 vs D01 모바일 mock                   | 모바일 메시지 액션 시트 구성이 3곳에서 불일치: FR-IA-MOB-05는 편집·삭제·반응·스레드·핀·저장·리마인더·신고(복사류 없음), FR-MSG-17은 '메시지 복사'·'링크 복사' 요구, D01 모바일 mock은 복사/링크 복사/편집/삭제만 표시. 액션 시트의 전체 항목·순서가 미확정.                                                                                   | 액션 시트 항목의 카노니컬 목록(순서·본인/타인 분기·복사류 포함 여부)을 FR-IA-MOB-05에 단일 정의하고 FR-MSG-17과 D01 mock이 이를 참조하도록 정리.                                                   |
| D-5  | FR-IA-MOB-04a                                                  | PRD가 구현 세부(translateY 공식, display:none/flex, visualViewport resize 구독, z-index 200/100, inset 표기법)까지 과도 명세. iPhone 14·iOS 17 특정 AC는 취약하고, 온보딩 오버레이의 z-index 9999 인라인 값과 z-index 스케일도 상충(100/200 vs 9999). dvh·interactive-widget 등 더 견고한 대안 구현을 막을 수 있음.                           | 요구를 '키보드 표시 시 composer가 키보드 위에 붙고 탭바와 겹치지 않으며 blur 시 복원된다' 수준의 관찰 가능한 동작으로 낮추고, z-index는 DS 토큰 스케일로 일원화.                                   |
| D-6  | FR-IA-WS-02                                                    | 채널 전환 시 무조건 최하단 스크롤 초기화는 '첫 미읽 메시지로 이동'(chat.jumpToFirstUnread 키)·미읽 구분선 기반 catch-up 모델과 긴장 관계. 모바일에서 히스토리 읽던 위치가 매 전환마다 소실되어 미읽 따라잡기 UX를 해칠 수 있음.                                                                                                               | 미읽이 있는 채널 진입 시 첫 미읽 위치/구분선 기준 앵커링을 우선하고, 미읽 없을 때만 최하단 초기화하도록 예외를 명시(D09와 교차 정합 필요).                                                         |
| D-7  | FR-CH-09                                                       | 채널 토픽을 '헤더에 항상 노출'로 규정했지만 모바일 topbar(.qf-m-topbar)는 뒤로가기·제목·멤버 버튼 3슬롯 구조로 토픽 슬롯이 없음. 모바일에서 토픽을 어디서 어떻게 보는지 미정의.                                                                                                                                                               | 모바일은 채널명 탭 시 채널 정보 시트/화면에서 토픽 노출하는 등 모바일 표면을 FR-CH-09에 추가 명시.                                                                                                 |
| D-8  | §02 IA 횡단 뷰 / D04·D07·D10 연계                              | 데스크톱은 스레드·핀·검색을 우측 패널 토글로, 채널 리스트 상단에 검색·인박스·스레드·저장됨 고정 항목을 두지만, 모바일 매핑은 스레드(FR-IA-MOB-04)와 멤버(FR-IA-MOB-02)만 정의됨. 채널 핀 목록·저장됨·채널 내 검색의 모바일 진입점이 이 구간에서 미정의이고 탭바에 '저장됨' 슬롯도 없음.                                                       | 핀 목록·저장됨·채널 내 검색의 모바일 진입점(예: topbar 오버플로 메뉴 또는 '나'/검색 탭 하위)을 IA 섹션에 추가 정의.                                                                                |
| D-9  | §02 IA 768px 경계                                              | PRD는 '768px 이하에서 모바일 셸 전환'(≤768 포함)이라 표기했으나 실제 분기는 matchMedia (max-width:767px)(≤767). 정확히 768px 뷰포트(세로 iPad mini 등)에서 어느 셸인지 모호하고 PRD 표기와 구현이 1px 어긋남.                                                                                                                                 | 경계값을 '767px 이하 = 모바일'로 통일 표기하거나 구현을 768px 포함으로 변경해 단일 기준 확정.                                                                                                      |
| D-10 | FR-IA-A11Y-03                                                  | 자동완성 열림 발표 카피 '위아래 화살표로 선택하세요'와 aria-activedescendant 키보드 패턴이 데스크톱 전제. 터치 스크린리더(VoiceOver/TalkBack) 환경의 발표·탐색 방식이 미정의라 모바일 접근성 AC가 비어 있음.                                                                                                                                  | 모바일에서는 발표 카피를 입력 방식 중립('{n}개의 결과가 있습니다')으로 하고 터치 탐색 시나리오 AC를 별도 추가.                                                                                     |
| D-11 | FR-CH-13·15                                                    | 채널·카테고리·즐겨찾기 순서 변경이 '드래그'로만 규정됨. 모바일에서 드래그는 OverlappingPanels 가장자리 스와이프·스크롤과 제스처 충돌하며 롱프레스 드래그 등 모바일 인터랙션 정의가 없음 — 모바일에서 기능 누락 또는 오동작 위험.                                                                                                              | 모바일 재정렬은 P2로 분리하거나 롱프레스-드래그/편집 모드 진입 방식을 명시하고 스와이프 제스처와의 우선순위를 정의.                                                                                |
| D-12 | NFR-9 axe-core 대상                                            | 접근성 CI 대상 라우트(/login, /workspaces/:id, /channels/:id, /dm, /threads, Activity Inbox)가 데스크톱 뷰 기준이며 모바일 에뮬레이션·모바일 전용 표면(탭바, 드로어, 액션 시트, 전체화면 모달)이 채점 대상에 없음 — 모바일 a11y 회귀가 게이트를 통과할 수 있음.                                                                               | 동일 라우트의 375px 모바일 에뮬레이션 axe 검사 + 탭바/액션시트/드로어 열림 상태 검사를 nfr-accessibility.yaml DoD에 추가.                                                                          |
| D-13 | FR-CH-06 vs FR-IA-MOB-03                                       | 채널 브라우저 데스크톱 mock은 정렬 셀렉트 + 푸터 '이전/다음' 페이지네이션을 보여주지만 모바일 전체화면 모달에서의 정렬 UI·페이지네이션 방식(버튼 vs 무한 스크롤)이 미정의.                                                                                                                                                                    | 모바일 채널 브라우저는 무한 스크롤 + 정렬 시트 방식 등 모바일 패턴을 FR-IA-MOB-03에 보충 명시.                                                                                                     |
| D-14 | §02/§D01/§D02 phone mock 규격                                  | 모바일 mock 뷰포트가 360×720(.phone), 320×580(D01), AC는 375px로 혼재되어 검증 기준 뷰포트가 불명확.                                                                                                                                                                                                                                          | 모바일 AC 기준 뷰포트(375×667 등) 하나를 카노니컬로 선언하고 mock 치수는 참고용임을 명시.                                                                                                          |
| D-15 | D04 Spec L5658 (FR-TH-01)                                      | 스레드 시작 액션이 '메시지 호버 시 툴바 노출'로만 정의되어 있어 호버가 없는 터치 환경에서 진입점이 미정의입니다. 모바일 목업은 결과 화면만 보여주고 시작 동선이 없습니다.                                                                                                                                                                     | 모바일 롱프레스 메시지 액션시트(.qf-m-message-action-sheet)에 'Reply in thread' 항목 포함을 FR 레벨로 명시 (FR-DM-18이 이미 동일 시트 패턴을 참조하므로 일관성 확보 용이).                         |
| D-16 | D05 §이모지 피커 UX L6509 · FR-RE04·RE05                       | 퀵 반응 3개는 '메시지 hover 시 노출', 반응 참여자 확인은 '버블 hover 툴팁'으로 정의 — 모바일 대체 제스처와 전체 반응자 목록(FR-RE05) UI 표면이 모두 미정의입니다.                                                                                                                                                                             | 모바일: 메시지 롱프레스 시트 상단에 퀵 반응 행 배치, 반응 칩 롱프레스 시 반응자 목록 바텀시트(FR-RE05 페이지네이션 소비처) 정의.                                                                   |
| D-17 | D03 Mock L5375 · D06 user story L7801/FR-MN-07                 | DM 항목 메뉴(뮤트/숨기기/나가기)와 채널 알림 설정 진입이 '우클릭 컨텍스트 메뉴'로 명세되어 있어 모바일에서 동작 불가. 모바일 대체 진입이 정의되지 않았습니다.                                                                                                                                                                                 | 모바일은 항목 롱프레스 → 액션시트로 동일 메뉴를 제공한다고 FR/AC에 명시.                                                                                                                           |
| D-18 | FR-CH-13 · FR-CH-15 · FR-CH-16                                 | 채널/카테고리/즐겨찾기/개인 섹션 재정렬이 전부 '드래그'로만 정의 — 터치 드래그는 스크롤 제스처와 충돌하며 모바일 상호작용 정의가 없습니다.                                                                                                                                                                                                    | 모바일은 '편집 모드 + 드래그 핸들' 패턴을 정의하거나, 재정렬을 데스크톱 전용으로 명시(모바일은 결과 순서만 반영).                                                                                  |
| D-19 | FR-S01 · FR-S12 · FR-MN-11                                     | 검색 진입(Cmd+K), 채널 내 검색(Ctrl+F), /dnd 슬래시 명령 등 키보드 전제 진입점이 다수. 모바일 진입은 목업 탭바에만 암시되고 FR에는 없습니다.                                                                                                                                                                                                  | FR에 모바일 진입점을 병기: 탭바 '검색' 탭, 채널 헤더 검색 아이콘(in: 자동 설정), DND는 상태 변경 시트 내 토글.                                                                                     |
| D-20 | FR-MN-14                                                       | 배지 동기화 규칙이 브라우저 탭 favicon/title 중심으로 명세됨 — 모바일에서는 favicon/title 배지 표면이 사실상 없고, 모바일 탭바 배지(.qf-m-tab\_\_badge--mention)는 목업에만 존재해 FR/AC 검증 대상이 아닙니다.                                                                                                                                | 모바일 탭바 배지 규칙(멘션 카운트/미읽 dot/0일 때 제거)을 favicon 규칙과 동급의 FR·AC로 승격.                                                                                                      |
| D-21 | D06 개요 L7318 · FR-MN-15                                      | 'Web Push API로 모바일까지 커버' 전제와 denied 안내 카피('주소창 자물쇠/정보 아이콘') + 'userAgent 분기 없이 동일 카피' 강제가 iOS Safari 현실과 충돌 — iOS는 홈 화면 PWA 설치 시에만 Web Push 가능하고 자물쇠 UI도 없어 모바일 사용자에게 오안내가 됩니다.                                                                                   | iOS/모바일 브라우저 한계를 PRD에 명시하고, denied/미지원 상태의 모바일용 안내 카피 분기(또는 최소한 '기기별 방법은 도움말 참조' 중립 카피)를 허용.                                                 |
| D-22 | FR-MN-18                                                       | desktopLevel/mobileLevel 독립 설정을 정의했지만 단일 웹앱에서 '모바일 기기' 판별 기준(뷰포트 폭? UA? PushSubscription.userAgent?)이 미정의 — 같은 계정이 767px 창으로 줄이면 모바일 취급인지 모호합니다.                                                                                                                                      | push 라우팅 기준을 PushSubscription.userAgent 기반 기기 분류로 정의하고, 뷰포트 분기(MobileShell)와 무관함을 명시.                                                                                 |
| D-23 | FR-MN-13                                                       | Activity Inbox의 FR/AC는 데스크톱 패널(role=complementary, 우측 패널) 기준이고 모바일 하단 시트는 목업에만 존재. 항목 탭 점프 시 시트 닫힘/복귀 동작, 작은 화면에서의 필터 칩+탭 동시 표시가 미정의입니다.                                                                                                                                    | 모바일 Inbox 동작(점프 시 시트 닫고 채널 전환, 뒤로가기로 Inbox 복귀 — FR-S07 모바일 패턴과 동일)을 FR로 명시.                                                                                     |
| D-24 | FR-S03                                                         | 검색 결과 패널이 '우측 슬라이드-인으로 기존 우측 패널 대체'라는 데스크톱 가정으로만 명세됨. 모바일 풀스크린 오버레이는 목업뿐이고, 태블릿(768~1024px) 동작은 스레드 패널(FR-TH-20)과 달리 정의가 없습니다.                                                                                                                                    | FR-TH-05/20과 동일한 반응형 규칙(≥768 패널 / <768 풀스크린 / 768~1024 오버레이+독립 스크롤)을 검색 패널에도 명시.                                                                                  |
| D-25 | FR-CH-19 · D05 Edge L7275                                      | 'disabled composer 클릭/탭 시 툴팁', '삭제된 이모지 placeholder 툴팁' 등 터치에서 어색한 툴팁 패턴이 산재 — FR-DM-18은 모바일을 토스트로 올바르게 분기해 도메인 간 패턴이 비일관합니다.                                                                                                                                                       | 터치 환경의 보조 안내는 FR-DM-18 패턴(인라인 bottom toast 3초)으로 전 도메인 통일 명시.                                                                                                            |
| D-26 | D03 L5394 · D06 L7777 · D07 L8735 (모바일 목업 탭바)           | 모바일 하단 탭바 구성이 목업마다 다름: D03 '채널/DM/알림/나', D07 '채널/검색/알림/나', D06 '채널/알림/나'(3개+배지). 합치면 5개 탭(채널/DM/검색/알림/나)이 필요하지만 단일 정의가 없어 구현 시 충돌합니다.                                                                                                                                    | 전역 모바일 탭바 구성을 한 곳에서 확정(5탭 또는 검색을 헤더로 이동한 4탭)하고 각 도메인 목업을 그 기준에 종속시킨다.                                                                               |
| D-27 | FR-P08~P10 · D08 Mock                                          | 멤버 목록 그룹핑과 프로필 hovercard(마지막 접속·커스텀 상태 노출)가 데스크톱 표면으로만 정의됨 — 모바일 목업은 '내 상태 헤더'만 있고, 멤버 목록 진입 동선과 호버카드의 터치 대체(프로필 시트)가 미정의입니다.                                                                                                                                 | 모바일 멤버 목록 화면(채널 헤더 인원수 탭 진입)과 아바타 탭 → 프로필 바텀시트(hovercard 동등 정보)를 정의.                                                                                         |
| D-28 | FR-P02 (D08 §자동 Idle L9100)                                  | presence:activity 트리거가 'mousemove/keydown'으로만 정의되어 터치 전용 기기에서는 활발히 사용 중에도 activity가 갱신되지 않아 10분 후 IDLE로 오전환될 수 있습니다.                                                                                                                                                                           | activity 트리거에 touchstart/scroll/visibilitychange(visible)를 포함하도록 명시.                                                                                                                   |
| D-29 | FR-MN-02                                                       | @everyone/@here 확인 다이얼로그의 모바일 제시 형식이 미정의이고 관련 AC(E2E)가 데스크톱 Playwright만 가정합니다.                                                                                                                                                                                                                              | 모바일은 confirm 바텀시트 또는 .qf-m-modal 사용을 명시하고 모바일 viewport AC를 추가.                                                                                                              |
| D-30 | FR-CH-05 (D02 Edge L5186)                                      | 비공개→공개 전환의 '채널 이름 타이핑 재확인'은 모바일 가상 키보드(자동완성/자동수정)에서 마찰이 크고 자동수정으로 인한 불일치 실패가 잦을 수 있습니다(풀스크린 모달 자체는 정의됨).                                                                                                                                                           | 확인 입력 필드에 autocomplete/autocorrect/autocapitalize off 속성을 명세하거나, 모바일 한정 대체 확인(이름 표시 + 홀드 투 컨펌) 검토.                                                              |
| D-31 | FR-RS-08, FR-PS-01/13, D10 §채널 핀(hover 툴바), FR-AM-02      | 핵심 메시지 액션(미읽으로 표시, 핀, 저장, 더보기)이 전부 'hover toolbar' 기준으로만 명세됨. 터치 기기에는 hover가 없는데 이 구간 PRD는 모바일 대체 제스처(롱프레스 액션 시트 등)와 액션 매핑을 정의하지 않음.                                                                                                                                 | 데스크톱 hover toolbar 액션 전체를 모바일 메시지 롱프레스 바텀시트에 1:1 매핑하는 공통 규칙을 FR로 명시(반응/답장/스레드/핀/저장/미읽으로 표시/신고/더보기 순서 포함).                             |
| D-32 | FR-RS-09                                                       | '채널 우클릭 컨텍스트 메뉴'로만 정의된 '읽음으로 표시'는 모바일에서 진입 경로가 없음.                                                                                                                                                                                                                                                         | 채널 행 롱프레스 메뉴(읽음으로 표시/뮤트 등)를 모바일 표준 패턴으로 정의.                                                                                                                          |
| D-33 | FR-RS-11, FR-AM-10/11, D14 §설정 진입 단축키                   | Esc/Shift+Esc 읽음 처리, 라이트박스 ←→/Esc/휠 줌, Ctrl+, 설정 토글 등 키보드·마우스 전용 인터랙션이 다수. 모바일 대체 수단이 부분적으로만 존재(Unreads View '모두 읽음', 설정 드릴다운)하고 라이트박스 터치 제스처는 미정의.                                                                                                                  | 키보드 단축키마다 '모바일 동등 경로' 컬럼을 추가하고, 라이트박스에 핀치 줌(0.5~3.0배)·스와이프 이전/다음·아래로 스와이프 닫기를 명시.                                                              |
| D-34 | D09 Mock C vs D11 모바일 목업 vs D12 모바일 목업 (하단 탭바)   | 모바일 하단 탭바 구성이 목업마다 다름 — D09 [채널/미읽/스레드/나], D11 [채널/미디어/알림], D12 [채널/모더레이션/설정]. 카노니컬 탭 구성, 권한(모더레이터) 의존 탭의 노출 조건, 탭 수 상한이 정의되어 있지 않아 구현 시 상호 모순.                                                                                                             | 전역 모바일 탭바를 단일 정의(예: 채널/미읽/스레드/나 4탭 고정)하고 미디어·알림·모더레이션은 상위 화면 내 진입점으로 격하, 권한 의존 항목의 노출 규칙을 명시.                                       |
| D-35 | FR-RS-10                                                       | Unreads View를 '사이드바 최상단 상시 노출'로 명세했으나 모바일 목업에서는 하단 탭으로 배치 — 데스크톱 전제 문구와 모바일 배치가 FR 수준에서 정합되지 않음.                                                                                                                                                                                    | FR-RS-10에 '데스크톱=사이드바 최상단 / 모바일=하단 탭바 미읽 탭' 매핑을 명시적으로 추가.                                                                                                           |
| D-36 | FR-RS-06 vs D09 Edge(구분선 클래스)                            | 모바일 전용 구분선 클래스 .qf-m-unread-divider가 엣지 케이스 항목에만 등장하고 FR-RS-06 본문에는 데스크톱 클래스만 있어, FR 기준 구현 시 모바일 클래스 분리가 누락될 위험.                                                                                                                                                                    | .qf-m-unread-divider 요구를 FR-RS-06(또는 별도 FR)로 승격하고 DS에 해당 클래스 존재 여부를 검증.                                                                                                   |
| D-37 | FR-RS-02 / D09 Edge(스크롤 가상화)                             | scroll-to-bottom 판정(50px)이 고정 viewport를 전제함. 모바일에서는 소프트 키보드 개폐·브라우저 주소창 수축으로 clientHeight가 수시로 변해 의도치 않은 즉시 ACK(읽음 처리)나 ACK 누락이 발생할 수 있는데 예외 처리가 없음.                                                                                                                     | 모바일 viewport resize(visualViewport 변화) 직후 일정 시간 ACK 판정을 유예하는 가드 조건을 추가.                                                                                                   |
| D-38 | FR-RS-07                                                       | Jump 구현을 scrollToIndex({align:'start'})+20ms 미세 보정으로 과도하게 구현 종속적으로 명세. 모바일 모멘텀 스크롤·동적 이미지 높이 환경에서 20ms 보정은 부족할 수 있고 특정 가상화 라이브러리를 전제함.                                                                                                                                       | 구현 디테일 대신 결과 기준 AC('점프 후 구분선이 뷰포트 상단 ±Npx')만 남기고 보정 타이밍은 구현 재량으로 완화.                                                                                      |
| D-39 | FR-PS-03, FR-RM14, FR-W01, D12 역할 관리 모달                  | 핀 목록 '우측 슬라이드인 패널', 역할 관리 2-pane 모달, 채널 권한 Override 편집기(ALLOW/DENY/INHERIT 3버튼 행), 워크스페이스 생성 모달 등 데스크톱 고정 레이아웃만 명세되고 모바일 표현(풀스크린 시트/드릴다운)이 전무.                                                                                                                        | 각 패널·모달에 '모바일=풀스크린 시트' 변환 규칙을 공통 정의하고, 권한 3상태 토글은 모바일에서 세그먼트 컨트롤로 명시.                                                                              |
| D-40 | FR-PS-09 / D10 §리마인더                                       | 리마인더 발화 통지가 '토스트 + 브라우저 Notification API' 전제. iOS Safari/모바일 웹은 Notification API 제약이 크고 백그라운드·앱 미실행 상태 수신이 불가한데 모바일 푸시 폴백이 정의되지 않음(D14에는 '모바일 푸시' 토글이 존재해 상호 정합 필요).                                                                                           | 리마인더를 D14 알림 파이프라인(모바일 푸시)과 통합하고, Notification 미지원 환경에서는 재접속 시 미전달 알림 폴링(이미 명세된 overdueReminder 쿼리)을 모바일 기본 경로로 승격.                     |
| D-41 | D08 FR-P17/AC vs D14 §커스텀 상태                              | 커스텀 상태 만료 프리셋이 상호 모순 — D08은 '30분/1시간/4시간/오늘 자정/이번 주 월요일 자정/무기한', D14는 '30분/1시간/4시간/오늘 자정/금요일 자정/직접 입력'. 모바일 상태 시트 구현 시 어느 목록이 정인지 불명.                                                                                                                              | 프리셋 목록을 한 곳(D08 또는 D14)에서 단일 정의하고 다른 쪽은 참조로 변경.                                                                                                                         |
| D-42 | D11 '모바일 UX 핵심' 콜아웃 vs 모바일 목업(OG embed)           | 콜아웃은 모바일 OG embed를 '사이트명+제목만' 축약으로 명세했으나 같은 섹션의 모바일 목업에는 설명 2줄 클램프까지 포함되어 표시 범위가 모순됨.                                                                                                                                                                                                 | 모바일 embed 표시 필드를 한 가지로 확정(권장: 사이트명+제목+설명 1줄)하고 목업과 콜아웃을 일치시킴.                                                                                                |
| D-43 | FR-AM-02 (Preview Tray 재정렬)                                 | 파일 순서 재정렬이 '드래그 핸들'로만 명세됨. 모바일 가로 스크롤 트레이에서 터치 드래그는 스크롤 제스처와 충돌하며 대체 UX(길게 눌러 이동, 순서 편집 모드)가 정의되지 않음.                                                                                                                                                                    | 모바일에서는 롱프레스 후 드래그 또는 별도 '순서 편집' 모드를 명시하고, 재정렬을 P1 모바일 옵션으로 분리.                                                                                           |
| D-44 | FR-RM08                                                        | Slowmode는 서버 429+Retry-After만 정의되고 컴포저 측 쿨다운 표시(남은 초 카운트다운, 전송 버튼 상태)가 미정의. hover 툴팁이 없는 모바일에서는 사용자가 차단 사유를 인지할 방법이 없음.                                                                                                                                                        | 컴포저에 슬로우모드 잔여 시간 표시(카운트다운)와 전송 버튼 비활성 규칙을 FR로 추가.                                                                                                                |
| D-45 | D10 §개인 저장함(사이드바 진입점)                              | 저장함 진입점이 '좌측 사이드바 저장됨 항목'으로만 정의됨 — 모바일 셸에는 해당 사이드바가 없어 진입 경로(예: '나' 탭 하위)가 미정의.                                                                                                                                                                                                           | 모바일에서 저장함을 '나' 탭 내 항목(뱃지 포함)으로 배치하는 매핑을 명시.                                                                                                                           |
| D-46 | FR-W20/FR-W23                                                  | 크로스 워크스페이스 알림 표면을 '서버 아이콘 배지'로만 정의 — 상시 서버 레일이 없는 모바일 셸에서는 다른 워크스페이스의 멘션을 인지할 표면이 미정의.                                                                                                                                                                                          | 모바일 워크스페이스 스위처(시트/드로어) 트리거 버튼에 합산 뱃지를 표시하는 규칙을 추가.                                                                                                            |
| D-47 | D12 모바일 신고 큐 목업(액션 축소)                             | 데스크톱 신고 카드는 무시/메시지 삭제/타임아웃 3개 액션인데 모바일 목업은 무시/타임아웃 2개만 노출('메시지 삭제' 누락). 의도적 축소인지 누락인지 불명확.                                                                                                                                                                                      | 모바일 신고 카드의 액션 세트를 명시(권장: 3개 유지 또는 '더보기'로 수납).                                                                                                                          |
| D-48 | D10 Mock 4(리마인더 직접 입력)                                 | 리마인더 직접 입력이 datetime-local 단일 입력으로 명세되어 있으나 모바일 OS별 네이티브 피커 동작 차이·최소값(과거 시각) 검증 UI가 정의되지 않음(D08 커스텀 상태는 과거 expiresAt 400 명세가 있으나 리마인더에는 없음).                                                                                                                        | 리마인더에도 과거 시각 거부(최소 now+1분) 검증과 오류 카피를 명시해 D08과 정합시킴.                                                                                                                |
| D-49 | D14 FR-PS-17 · D17 [E]                                         | presence:activity의 활동 감지 소스가 mousemove/keydown으로만 명세되어 있어 터치 전용 모바일에서는 활동 신호가 전혀 발생하지 않는다. 모바일 사용자가 활발히 스크롤·탭 중이어도 10분 후 IDLE로 오전이될 수 있다.                                                                                                                                | activity 소스에 touchstart/scroll/visibilitychange(또는 pointer 이벤트 통합)를 포함하도록 FR-PS-17/D17 [E]를 보강하고, 백그라운드 탭 전환 시 동작도 정의.                                          |
| D-50 | D14 FR-PS-18 · D15 FR-KS-01~04,06,09,11 · 내비게이션 단축키 표 | 퀵스위처(Ctrl+K), 설정 토글(Ctrl+,), 미읽 채널 이동(Alt+Shift+↑↓), 채널 읽음(Esc/Shift+Esc), 마지막 메시지 편집(↑), 치트시트(Ctrl+/), 새 DM(Ctrl+N) 등 키보드 전용 기능의 모바일 대체 진입점이 전혀 정의되지 않았다. 메시지 액션(FR-KS-08)만 롱프레스 시트 대체가 명세됨. 퀵스위처 빈 상태의 'Ctrl+N으로 새 DM' 힌트는 모바일에서 무의미하다. | 기능별 모바일 동등 수단(검색 진입, 채널 목록 당겨서 읽음, 메시지 롱프레스→편집, 탭바 경유 새 DM 등)을 표로 명세하고, 키보드 힌트 텍스트(kbd)는 모바일에서 숨기거나 대체 카피로 교체하는 규칙 추가. |
| D-51 | D14 FR-PS-08                                                   | 전체 프로필 패널이 '채팅 우측 280px 슬라이드'라는 데스크톱 레이아웃으로만 명세되어 모바일 표현(풀스크린/바텀시트)이 미정의다. FR-PS-07 팝오버도 200px 고정 너비 등 픽셀 단위 과명세로 모바일 시트 패턴 채택 여지를 좁힌다.                                                                                                                    | 모바일에서는 전체 프로필을 풀스크린 페이지 또는 바텀시트로 표시하는 변형을 명시하고, 팝오버 너비는 데스크톱 한정 수치임을 주석으로 한정.                                                           |
| D-52 | D16 FR-RC16                                                    | 편집 이력 조회 진입이 '우클릭 메뉴'로만 명세되어 우클릭이 없는 모바일에서는 해당 기능에 도달할 수 없다.                                                                                                                                                                                                                                       | FR-KS-08의 모바일 롱프레스 액션 시트에 '편집 이력 보기' 항목을 포함하도록 cross-ref 추가.                                                                                                          |
| D-53 | D14 모바일 mock vs D17 모바일 mock (하단 탭바)                 | 하단 탭바 구성이 mock 간 상충한다 — D14는 채널/DM(send 아이콘)/알림/나, D17은 채널/메시지(inbox 아이콘)/알림/나. 두 번째 탭의 레이블·아이콘이 달라 모바일 IA 구현이 갈릴 수 있다.                                                                                                                                                             | 탭바 4탭의 레이블·아이콘·배지 규칙을 IA 섹션 단일 정의로 고정하고 각 도메인 mock은 이를 참조만 하도록 정리.                                                                                        |
| D-54 | D15 FR-SC-06 (/remind 발송 동작)                               | 리마인더 토스트 위치를 '우하단 글로벌 토스트(8초)'로 고정 명세했는데, 모바일에서는 우하단이 컴포저·탭바와 겹치고 화면 폭상 우하단 개념이 어색하다. 모바일 토스트 위치/형태가 미정의.                                                                                                                                                          | 토스트 위치를 '데스크톱 우하단 / 모바일 상단 또는 탭바 위 전폭 배너'처럼 뷰포트별로 분기 명세.                                                                                                     |
| D-55 | D14 FR-PS-10 (모바일 푸시) · D15 FR-SC-06 (FR-MN-15 VAPID)     | '모바일 푸시'가 VAPID Web Push 전제인데, iOS Safari는 홈 화면 PWA 설치 상태에서만 Web Push를 지원한다. PRD에 PWA manifest/설치 요건이 없어 iOS 모바일 사용자는 푸시 토글이 사실상 무동작이 될 수 있다.                                                                                                                                        | PWA 설치 가능성(manifest·service worker) 요건을 명세하거나, iOS 미설치 환경에서 푸시 토글에 제한 안내를 표시하는 동작을 정의.                                                                      |
| D-56 | D15 FR-KS-07 · FR-KS-10 · Edge cases(모바일 항목)              | Shift+Enter 줄바꿈은 모바일 소프트 키보드에 존재하지 않고, 모바일에서 Enter(return) 키가 전송인지 줄바꿈인지 미정의다. 또한 '포맷팅 툴바는 모바일에서도 동작'이라고만 명시되어 텍스트 선택 시 표시되는 인라인 포맷 툴바가 iOS/Android 네이티브 선택 메뉴와 어떻게 공존하는지 정의가 없다.                                                     | 모바일은 'Enter=줄바꿈, 전송은 send 버튼 전용'(또는 반대) 정책을 명시하고, 인라인 포맷 툴바의 모바일 표시 위치/네이티브 선택 메뉴 충돌 회피 규칙을 추가.                                           |
| D-57 | D17 Infra Configuration (transports:['websocket'])             | HTTP long-polling을 비활성화해 WebSocket이 차단되는 일부 모바일 망/사내 프록시에서는 연결 자체가 불가능하며, 이 경우의 사용자 안내(연결 불가 상태 화면)가 정의되지 않았다.                                                                                                                                                                    | WS 연결 반복 실패 시 모바일 오프라인/연결 불가 배너와 재시도 UX를 명세하거나 polling 폴백 허용 여부를 재검토.                                                                                      |
| D-58 | D14 FR-PS-12 (pending spinner 비활성)                          | reduceMotion 활성 시 'pending spinner'까지 비활성화하도록 명세되어, 저속 모바일 네트워크에서 로딩/전송 중임을 알릴 시각 피드백이 사라져 상태 불명확 위험이 있다.                                                                                                                                                                              | 스피너는 회전 애니메이션만 정지하고 정적 인디케이터(텍스트 '전송 중...' 등)로 대체함을 명시.                                                                                                       |
| D-59 | D15 FR-KS-01 vs API(GET /quick-switcher)                       | 퀵스위처 검색이 본문에서는 '클라이언트사이드 퍼지 매칭(Socket.IO 초기 페이로드 캐시 기반)'으로, API 표에서는 서버 GET /quick-switcher 검색으로 이중 정의되어 있다. 저사양 모바일에서 어느 경로를 쓰는지에 따라 성능·오프라인 동작이 달라진다.                                                                                                 | 검색 경로(클라이언트 캐시 우선 + 서버 폴백 등)를 단일화하고 모바일 캐시 메모리 영향도 함께 명시.                                                                                                   |
