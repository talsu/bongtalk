# 071-M2 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md` M2 절(A안 확정),
> 감사 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md`. 규약·검증·배포는 M0/M1 과 동일 —
> **GitHub push-only, 게이트는 로컬**(standalone `pnpm verify` + `e2e/mobile` green),
> 배포는 main 체크아웃에서 수동 `sudo DEPLOY_PUSHER=... bash scripts/deploy/auto-deploy.sh`
> (DEPLOY_SHA 없이 · `| tail` 금지 · exit code 직접). 검증 스택: `qufox-e2e` compose
> (api :43001 / web :45173 / pg :45432) — **코드 변경 후 test-web(/api) `up -d --build` 필수**.
> 브랜치: feat/071-m2-ia-rebuild (develop efca268 기점).

## 범위 (071 M2 절 — A안: OverlappingPanels + 5탭)

1. **3패널 셸**: `.qf-m-panels`(left/center/right)+`.qf-m-drawer-scrim` — DS mobile.css
   420~491 스펙 그대로(엣지 스와이프 오픈·드래그 추종 `--dragging`·스냅 `--snapping`·
   fling |vx|>500px/s·커밋 임계 `--m-swipe-threshold` 60px). 좌=`qf-m-server-header`+
   서버레일+채널 목록(`qf-m-channel` 행, 활성 `aria-selected`), 우=멤버 목록. 채팅은 중앙
   패널 라우트(`/w/:slug/:channel`) 단일 경로 — 홈 `?chat=` 오버레이·MobileDrawer 폐기.
2. **5탭 탭바**: 채팅(중앙 복귀)·인박스(Activity)·스레드(thread inbox `qf-m-thread-inbox`)·
   검색(FR-S07 풀스크린+Jump+복귀)·나(FR-IA-MOB-06 you-header+설정 드릴다운+로그아웃
   confirm+상태 변경 시트 FR-P04/P17 — 전 플랫폼 최초라 데스크톱 BottomBar 에도 연결).
   뱃지 의미 분리(violet 미읽/danger 멘션/`__pill` 활성).
3. DM 인박스: DS 'DMs Inbox' 구조 — '채팅' 탭의 워크스페이스-외 컨텍스트(서버레일 DM 슬롯).
4. 채널 브라우저 진입(FR-IA-MOB-03)+멤버수 버튼(FR-IA-MOB-02)+워크스페이스 전환 일원화
   (좌 패널 서버레일)+반응형 분기 일원화(`useIsMobile` — matchMedia 라우트 3곳 통합).
5. 기존 모바일 e2e 다수가 드로어/?chat= 모델에 결합 — 같은 슬라이스에서 스펙 전면 갱신.

감사 ref: A(1·2·26·28·29), B(12·22·23·37·40·41·42·43·48·54·56·68), H-9·10.

## 청크 상태

| 청크 | 내용                                                                                                                                                            | 상태                                                            | 커밋    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- |
| E1   | `useIsMobile` 훅 + 반응형 분기 일원화(App.tsx 등 matchMedia 3곳)                                                                                                | **done** — 훅은 기존 lib/useBreakpoint 재사용, App.tsx 4곳 교체 | edcca99 |
| E2   | MobilePanels 3패널 골격(DS .qf-m-panels) — 엣지 스와이프/드래그/스냅/fling + 스크림, 좌(서버레일+채널)/중앙(채팅)/우(멤버) 장착, MobileShell 개편               | **done**                                                        |         |
| E3   | 5탭 탭바 + 라우트: 채팅/인박스(Activity)/스레드(thread inbox 신규)/검색(풀스크린 신규)/나(you 탭 신규 — 상태 변경 시트 포함, 데스크톱 BottomBar 연결)           | **done** — BottomBar 상태 변경은 기존 존재(추가 작업 불요 확인) |         |
| E4   | 홈 ?chat= 오버레이·MobileDrawer 폐기 + DM 인박스 '채팅' 탭 통합(서버레일 DM 슬롯)                                                                               | **done**                                                        |         |
| E5   | 채널 브라우저 진입·멤버수 버튼(aria-expanded)·뱃지 의미 분리·워크스페이스 전환 일원화 잔여                                                                      | **done**                                                        |         |
| E6   | M1 이월: 슬래시 커맨드 모바일 표면(EPHEMERAL 리스트·GIPHY 슬롯·클라 액션 — 새 IA 패널 대상) + 자동완성 켜기(acSources.slashCommands 한 줄) + 답장 데드엔드 해소 | todo                                                            |         |
| E7   | 게이트: e2e 전면 갱신(드로어/?chat= 결합 스펙 재작성)+vr baseline+standalone verify+적대 리뷰 fix-forward                                                       | todo                                                            |         |
| E8   | develop --no-ff 머지(ls-remote 실측)→main 승격→수동 배포→/readyz→REPORT                                                                                         | todo                                                            |         |

## 결정 로그

- (착수) 사용자 결정 A안(2026-06-10): PRD 원안 전면 — 3패널 + 5탭. 홈 `?chat=` 쿼리
  오버레이/드로어 모델 폐기. M4 의 PRD 개정은 "5탭 카노니컬로 전 목업 통일" 방향.

## M1 이월 후속(이 슬라이스 또는 M3+ 에 배치)

- 멘션 백필: 버그 기간 저장 행 contentAst 에 평문 `@{uuid}` 잔존 — contentRaw 패턴 한정
  재파싱(reversible 1회성, api 태스크) — M3 후보.
- emoji customId Cuid2Schema → uuid|cuid2 확장(dormant 시한폭탄) — shared-types 소절.
- PRD 카노니컬 멘션 정규식 표기 갱신(uuid|cuid2) — M4 PRD 개정에 포함.
- e2e: WS 수신측 라이브 첨부·비공개 채널 첨부 커버리지 — E7 에 포함.
- send 응답 첨부 재조회 1쿼리 절약(컨트롤러가 tx lite 재사용) — 저우선.

## 세션 핸드오프 노트

- (착수) M1 종료 직후 연속 진행. 검증 스택 가동 중. 서브에이전트 브리프에는
  "읽기 전용 — git checkout/branch 전환 금지" + "머지/배포/prod 접근 금지" 명시
  (M1 D11 에서 reviewer 가 main checkout 사고).
- (세션 #2) E1 완료(edcca99) — useIsMobile 은 lib/useBreakpoint 에 이미 존재(Shell 사용
  중), App.tsx 라우트 가드 4곳(Activity/Friends/DmShell/Discover)의 matchMedia 1회
  평가를 훅으로 교체(Rules of Hooks — 조기 return 앞 호출).
- (세션 #2) E2 완료 — 신규 `shell/mobile/MobilePanels.tsx`(DS .qf-m-panels 구동:
  상태 외부 제어 open/onOpenChange, --dragging 인라인 transform 추종, --snapping 스냅
  (타이머 400ms 해제), fling |vx|>500, 커밋 임계 60px, 엣지 24px, 방향 잠금 10px,
  스크림 center 내부+진행도 opacity, 제스처 판정 전부 ref). MobileShell 의
  MobileDrawer 2개 → MobilePanels(left=MobileChannelList, right=activeChannel 시
  MobileMembers, center=qf-m-screen 골격). topbar 버튼 aria-expanded + 토글.
  ★함정 적발: back 마커 cleanup 의 무조건 history.back() 이 **채널 픽 직후 라우터
  push 를 되돌려 채널 전환이 무효**가 됐다 — history.state.qfPanel(마커 최상단)일
  때만 back 하도록 수정. 프로브(.tour/probe-m2-e2{,b}.mjs) green: 메뉴/멤버 토글·
  좌패널 x=0·우패널 폭 240·채널 픽 라우팅+닫힘·스크림 탭(가시영역 좌표 주의 —
  show-right 시 스크림 좌표계는 center 기준)·엣지 스와이프 오픈·back 패널만 닫힘.
  비고: 기존 e2e 의 drawer 결합 스펙(drawer-channels/members-drawer/drawer-back-button
  등)은 이 시점부터 red — E7 에서 패널 모델로 전면 갱신(계획된 파손).
  server-header 도입은 E5 에서(워크스페이스 전환 일원화와 함께).
- (세션 #2) E3 완료 — MobileTabBar 5탭 전면 재작성(props 제거 — 탭바가 useLocation
  으로 active 자동 판정 + 내부 라우팅; '채팅' 복귀는 sessionStorage qf:lastChatPath —
  탭바 자신이 /w/_·/dms_ 에서 기록). 신규 화면 3개: MobileThreadsTab(useMyThreads
  재사용·현재 ws 채널맵 필터·qf-m-thread-inbox 골격·탭→`?thread=` 진입),
  MobileSearchTab(useSearch 무한쿼리·300ms 디바운스·markOnlyHtml 스니펫·탭→`?msg=`
  Jump), MobileYouTab(qf-m-you-header/you-status·상태 시트 online/dnd/offline =
  usePresenceStatus·로그아웃 confirm 시트). App.tsx: /threads /search /you 라우트
  (ProtectedMobileTabRoute — 데스크톱은 '/' 폴백, lazy 3개). 사용처 7곳 탭바 호출
  단순화(<MobileTabBar />). ★MobileMessages 에 `?thread=<rootId>` 소비 추가(스레드
  패널 오픈 + URL 정리 — 종전 모바일은 파라미터 삭제만 했음). 데스크톱 BottomBar
  상태 변경은 기존 구현 존재 확인(연결 작업 불요). 프로브(.tour/probe-m2-e3.mjs)
  green: 5탭/스레드 인박스→패널 오픈/검색→Jump/나 탭 시트·dnd 반영·로그아웃
  confirm/채팅 복귀. (threadJump=false 출력은 파라미터 정리 후 측정 — 정상)
- (세션 #2) E4 완료 — MobileHome/MobileOverlay/MobileDrawer 3파일 삭제(참조 0 확인).
  '/'(slug 없음)는 lastChatPath → 첫 워크스페이스 순 리다이렉트(홈 화면 자체 폐기 —
  채팅 탭 기본 컨텍스트). MobileChannelList 서버레일 항상 렌더 + DM 슬롯
  (mobile-rail-dms → /dms). 프로브(.tour/probe-m2-e4.mjs) green: 랜딩 자동 진입/
  DM 슬롯 → /dms/'/' 재진입 시 마지막 채팅 컨텍스트(/dms) 복귀.
  주: MobileHome 결합 e2e(home-mobile-\*·tabbar-3-tabs 등)도 red — E7 갱신 목록에 포함.
- (세션 #2) E5 완료 — MobileChannelList 에 DS qf-m-server-header(서버명 + 채널
  둘러보기 + 액션 — 서버 메뉴 시트 확장은 M3), 채널 둘러보기는 데스크톱
  ChannelBrowser + SettingsOverlay(design-system/primitives) 재사용(mobile-channel-
  browser-overlay, 채널 생성 모달은 M3 — onCreateChannel 은 닫기만). topbar 멤버
  버튼에 멤버수 병기(mobile-member-count)+aria-label 인원. 멘션 뱃지는
  --badge-mention-bg(danger) 분리. 프로브(.tour/probe-m2-e5.mjs) green: 멤버수 2/
  server-header/멘션 뱃지 rgb(220,38,38)/브라우저 오버레이.
- 다음 작업: E6(M1 이월 — ①MobileMessages 에 EphemeralList·GiphyPreviewSlot 장착
  ②MobileComposer submit 에 detectSlashExecution/클라 액션(모바일 안전 부분집합:
  collapse/expand/darkmode — /search 는 /search 탭 navigate, /shortcuts 는 미지원
  토스트) ③acSources.slashCommands 켜기 ④답장 데드엔드: replyTarget 을 전송에
  연결할 서버 지원 확인(reply 필드 부재 시 스레드 답글로 라우팅하거나 액션 제거 결정)
  → E7 게이트(e2e 전면 갱신: drawer/home 결합 스펙 → 패널/5탭 모델) → E8.
