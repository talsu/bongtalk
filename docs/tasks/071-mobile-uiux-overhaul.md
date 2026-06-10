# 071 — 모바일 UI/UX 전면 정비 (PRD·DS 정합 + 사용성 복구)

> 근거 감사: `docs/audits/2026-06-10-mobile-uiux-audit.md` (핸즈온 H-1~11 + 정적 감사 A/B/C/D 섹션).
> 증거 스크린샷: `.tour/shots*/`, 재현 스택: `docker-compose.e2e-audit.yml` + `.tour/setup.mjs`.

## Context

- 모바일 셸(task-024~035 골격)은 이후 데스크톱에 들어간 폴리시(S35 스레드·S47 activity
  actorName·S76 설정 셸 등)와 DS 050 모바일 IA(OverlappingPanels·you-탭·quick tiles·jump-btn·
  unread-divider·img-grid·emoji-drawer 등)를 받지 못한 채 회귀까지 누적된 상태다.
- 핸즈온 실측으로 사용 불능 수준 BLOCKER 2건(시트/드로어 탭 차단, /w 채널 뷰 컴포저 소실),
  적대 검증을 통과한 HIGH+ 34건, MED/LOW 77건, PRD 자체 결함 59건이 확정됐다.
- 모바일 e2e가 어떤 게이트에도 없어(기존 스펙 2종 현재 red, vr-parity 영구 fixme) 회귀가
  무증상 누적됐다. fr-matrix의 done 표기 중 모바일 미구현 건이 다수(FR-S07/P04/P17/PS-05 확인).

## 진단 — 근본 원인 4가지

| #   | 원인                                                                                 | 결과                                                    |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| R1  | 모바일 검증 게이트 부재 (e2e 미강제 + vr baseline 미시드 + axe 데스크톱 한정)        | BLOCKER 2건 포함 회귀 무증상 방치                       |
| R2  | DS 050 모바일 IA가 "작성만 되고 채택 안 됨"                                          | 목업과 실앱의 구조적 괴리 (62px 패딩 누출 포함)         |
| R3  | 데스크톱-우선 슬라이스 진행에서 모바일 백포트 단계 부재                              | 읽음 ACK·검색·타이핑·리액션 표시 등 수십 건 모바일 결손 |
| R4  | PRD의 모바일 명세 공백·모순 (탭바 IA 4중 모순, hover/우클릭/드래그/단축키 전용 명세) | 구현 기준 자체가 흔들림 → "PRD와 상이하다"는 체감       |

## 선결 결정 — 모바일 내비 모델: **A안 확정 (2026-06-10 사용자 결정)**

PRD §02는 OverlappingPanels(3패널 스와이프) + 5탭(채팅·인박스·스레드·검색·나)을 명시하나,
PRD 내 목업 간에도 탭 구성이 3~5탭으로 상충한다(감사 D-1·26·34·53). 현 구현은 3탭+드로어+
홈오버레이 혼재 — 이 구조적 divergence 자체가 2차 적대 검증에서 HIGH로 확정됐다(task-033이
의도적으로 갈라놓고 PRD를 개정하지 않은 채 방치).

**사용자 결정: (A) PRD 원안 전면 채택** — `.qf-m-panels` 3겹침 패널(좌=서버레일+채널 /
중앙=채팅 / 우=멤버, 엣지 스와이프·드래그 추종·fling 스냅 — DS mobile.css 420~491 스펙 그대로)

- 셸 고정 5탭(채팅·인박스·스레드·검색·나) 재구축. 홈 `?chat=` 쿼리 오버레이 모델과 드로어
  모델은 폐기하고 중앙 패널 라우트 기반으로 단일화한다. M4의 PRD 개정은 "탭바를 5탭 카노니컬로
  전 목업 통일" 방향으로 진행한다(기각 목업: D02 3탭, D03/D14/D17 4탭 표기).

## 수정 계획 — 슬라이스

### M0 — 긴급 복구 (사용 불능 해소, 1슬라이스, 최우선)

| #   | 항목                                                                                                                         | 대상                                                                                   | 감사 ref             |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| 1   | 시트/드로어 백드롭 z-스택 수정 — 패널을 백드롭 자식으로(DS 의도) 또는 패널에 `z-[var(--z-modal)]`; 패널 클릭 stopPropagation | MobileDrawer·MobileMessageSheet·MobileEditSheet·MobileDmList(시트)·MobileFriends(시트) | H-1                  |
| 2   | /w 채널 뷰 레이아웃 — `qf-m-body`에 flex-col 부여(또는 오버레이와 동일 구조로 정렬), 하단 앵커·스크롤 페치 복구              | MobileShell L134                                                                       | H-2                  |
| 3   | `.qf-m-screen--app` 일괄 적용 (62px 유령 패딩 제거, 100dvh)                                                                  | qf-m-screen 사용 전 컴포넌트                                                           | H-3, A(19·33)        |
| 4   | 모바일 읽음 ACK 발송 (데스크톱 read-ack 로직 배선)                                                                           | MobileMessages                                                                         | A-4, H-11            |
| 5   | /dm 모바일 분기 (DmShell → 모바일 표면) + /dms 진입점 연결                                                                   | App.tsx 라우트                                                                         | H-4                  |
| 6   | Discover 카테고리 `qf-m-filter-bar/chip` 교체                                                                                | MobileDiscover                                                                         | H-5                  |
| 7   | Activity actorName 표기 + 행 탭 점프(DM·채널 모두, `?msg=` 소비 포함)                                                        | MobileActivity·MobileShell                                                             | H-8, A(23·24·25)     |
| 8   | ToastViewport 모바일 전 화면 가용(App 레벨 마운트)                                                                           | App.tsx                                                                                | A-18                 |
| 9   | 탭바 '설정' 목적지 통일 + 설정 셸 모바일 내비(드릴다운 목록+back)                                                            | MobileTabBar·SettingsShell                                                             | H-10, A-26           |
| 10  | 멤버 드로어 프레즌스 구독 복구                                                                                               | MobileMembers/usePresence                                                              | H-6                  |
| 11  | FR-IA-WS-01(P0) lastChannel 저장/복원 + 기본 채널 폴백 — `/w/:slug` 빈 상태 데드엔드 해소                                    | MobileShell·Shell(데스크톱 동일 부재)                                                  | A(run2: lastChannel) |

**같은 슬라이스에 게이트 동시 도입(R1 차단)**: `e2e/mobile/*`를 CI 필수 체크로 승격 + 현재 red
스펙 수리 + vr-parity baseline 시드·fixme 해제. 이후 슬라이스는 모두 이 게이트 위에서 진행.

### M1 — 채팅 코어 parity (메시지 화면을 데스크톱/PRD 수준으로)

그루핑(`--head/--cont`)+날짜 디바이더, 리액션 칩 행 렌더+탭 토글(`qf-m-react-row/chip` 44px),
첨부 렌더(`qf-m-img-grid`)+라이트박스(터치)+OG embed 축약 카드, 첨부 업로드(+버튼 배선,
데스크톱 presign 훅 재사용), sendState(전송중/실패+재시도), 미읽음 구분선(`qf-m-unread-divider`)
+jump-btn+`?msg=` 점프, 타이핑 인디케이터 양방향, 컴포저 textarea 전환(멀티라인 max 120px·4000자
카운터·enterKeyHint), @/#/:/슬래시 자동완성 시트, 멘션 하이라이트·시스템 메시지·BOT 뱃지·스레드
chip, 시트 액션 확장(핀·저장·리마인더·신고·미읽 표시·전체 이모지 피커 `qf-m-emoji-drawer`),
mrkdwn 신 렌더러 통일(스포일러/헤딩/점보 이모지 + 정규화 멘션 `@{id}` 원문 노출 수정), 모바일
presence 신호(touch activity)·idle 표시.

2차 런 추가 확정분: 오프라인 시 컴포저 비활성(FR-IA-STATE-05a P0), 대량 멘션 확인 다이얼로그
배선(FR-MSG-14·15 — 현재 409 데드엔드), 공지(ANNOUNCEMENT) 채널 컴포저 disabled 게이팅
(FR-CH-19), 메시지 삭제 alertdialog confirm + 시트 포커스 트랩(FR-IA-A11Y-01~02 P0).

감사 ref: A(3·5·6·9·10·11·13·15·16·17·21·22 + run2 6·7·8·9·10·11·13·14·15), B(7·8·10·11·16·24·28·30·31·32·34·36·44·45·46·47·50).

### M2 — IA 재구축 (A안: OverlappingPanels + 5탭)

- **3패널 셸**: MobileDrawer/MobileHome 레일+오버레이 구조를 `.qf-m-panels`(left/center/right) +`.qf-m-drawer-scrim`으로 교체. 엣지 스와이프 오픈, 드래그 추종(`--dragging`), 스냅
  (`--snapping`), fling(|vx|>500px/s), 커밋 임계 `--m-swipe-threshold`(60px) — DS 스펙 그대로.
  좌 패널 = `qf-m-server-header`+서버레일+채널 목록(`qf-m-channel` 행, 활성 `aria-selected`),
  우 패널 = 멤버 목록. 채팅은 중앙 패널 라우트(`/w/:slug/:channel`) 단일 경로 — 홈 `?chat=`
  오버레이·MobileDrawer 폐기.
- **5탭 탭바**: 채팅(중앙 패널 복귀)·인박스(Activity)·스레드(thread inbox —
  `qf-m-thread-inbox`, M3에서 승격)·검색(FR-S07 풀스크린 검색+Jump+복귀)·나(FR-IA-MOB-06
  you-header+설정 드릴다운+로그아웃 confirm+상태 변경 시트 FR-P04/P17 — 전 플랫폼 최초
  구현이므로 데스크톱 BottomBar에도 연결). 뱃지 의미 분리(violet 미읽/danger 멘션/`__pill`
  활성 표시).
- DM 목록: DS 'DMs Inbox' 구조(미읽 뱃지·시간·프레즌스·FAB·검색 + 그룹 DM 표시 FR-DM-03) —
  5탭 체계에서 DM 인박스는 '채팅' 탭의 워크스페이스-외 컨텍스트(서버레일 DM 슬롯)로 배치.
- 채널 브라우저 진입(FR-IA-MOB-03)+멤버수 버튼(FR-IA-MOB-02 aria-expanded), 워크스페이스 전환
  단일화(좌 패널 서버레일로 일원화), 반응형 분기 일원화(matchMedia 1회 평가 라우트 3곳 →
  useIsMobile).
- 기존 모바일 e2e 다수가 드로어/?chat= 모델에 결합 — 같은 슬라이스에서 스펙 전면 갱신.

감사 ref: A(1·2·26·28·29), B(12·22·23·37·40·41·42·43·48·54·56·68), H-9·10.

### M3 — 도달성 (모바일에서 막힌 기능 진입점 일괄)

저장함·스레드 인박스·핀 목록 화면, 초대 생성/관리·멤버 디렉터리, 신고 큐/감사 로그(`/w/:slug/
settings`가 채널명으로 오해석되는 라우팅 충돌 해소), 모더레이션 액션(프로필 시트), 채널 알림
설정/뮤트(채널 롱프레스 시트), 편집 이력 보기, 슬로우모드 쿨다운 표시, 전체 프로필 시트
(MemberProfilePanel 모바일 변형), 빈 채널 CTA·권한 없음·410 상태 화면, '모두 읽음'+Undo,
멤버 목록 hoist 그룹/페이지네이션, 워크스페이스 생성 모달 풀스크린화.

감사 ref: A(6·7·8·12·13·14·15), B(1·3·4·5·9·14·15·18·19·20·21·26·27·29·35·39), H-11.

### M4 — PRD 개정 (D-1~59 — "PRD 자체가 UX에 악영향" 항목)

1. **탭바 카노니컬 정의 1개로 통일**(현재 §02=5탭, D02=3탭, D03/D14/D17=4탭 상충) — A안 확정에
   따라 §02의 5탭(채팅·인박스·스레드·검색·나)을 카노니컬로 명문화하고 D02/D03/D06/D07/D09/
   D11/D12/D14/D17 목업의 탭바 표기를 일괄 정정.
2. **모바일 대체 인터랙션 표준 문구 신설**: hover 툴바/툴팁→롱프레스 시트, 우클릭 메뉴→롱프레스
   시트, 드래그 재정렬→순서 편집 모드, 키보드 단축키(Cmd+K/Ctrl+F/Esc/↑)→화면 내 진입점.
   해당 FR 전수에 모바일 절 추가(D-2·15·16·17·18·19·31·32·33·50·52).
3. **모바일 Enter 의미 명문화**: 소프트 키보드 Enter=줄바꿈, 전송=버튼(enterKeyHint="send"는
   옵션) (D-3·56).
4. **iOS Web Push 전제 수정**: PWA 설치 요건 명시 또는 '모바일 푸시' 토글 동작 조건 문서화
   (D-21·40·55).
5. 768px 경계 1px 정정(≤767 모바일), 모바일 AC 뷰포트 390×844 표준화(현 320/360/375 혼재),
   과명세 완화(FR-IA-MOB-04a z-index/translateY 공식, FR-RS-07 20ms 보정 등), 커스텀 상태
   프리셋 목록 단일화(D08 vs D14), FR-IA-WS-02(채널 전환 시 무조건 최하단)와 미읽 따라잡기
   모델의 긴장 해소 — '첫 미읽 앵커 우선'으로 통일 권장 (D-5·6·9·14·38·41).
6. **fr-matrix 재감사**: 모바일 표면 미구현인데 done 표기된 FR 전수 재분류(최소 FR-S07·P04·
   P17·PS-05) — "done=양 플랫폼 AC 충족"으로 정의 강화.

### M5 — DS 채택 마무리 + 폴리시

(OverlappingPanels는 A안 확정으로 M2에 승격) 시트 등장 모션 토큰(`--m-sheet-ease/dur`)+grab
드래그 닫기, 스와이프 답장 임계 60px+`qf-m-swipe` 힌트 아이콘, 더블탭 quick-react 토스트
(`qf-m-react-toast`), 당겨서 새로고침(`qf-m-ptr`), 홈 퀵타일(`qf-m-tile-row` — Catch Up/
Threads/Mentions/Saved), compact 밀도, 24시간제·폰트 크기 설정 반영, i18n 잔재 정리
("loading…"/"Activity"/"All"/"모든"→"전체"), 시트 포커스 트랩+자동 포커스(a11y), raw 값 정리
(드로어 360px·`--n-5` 직참조·50vh 등), 가로 모드 정책 결정(폰 landscape에서 데스크톱 셸 노출
유지 여부), 친구 삭제 confirm, 워드마크 겹침 수정.

감사 ref: A(20·30·34), B(40·44·45·51~77), H-11.

### M6 — 검증 인프라 상시화

모바일 e2e 신규 커버(읽음 ACK·시트 액션·점프·검색·상태 시트), axe 모바일 표면 추가(탭바·드로어·
시트·풀스크린 모달), vr baseline 4뷰포트 유지, 모바일 폴리시 e2e(키보드 dodge 실기 검증은
Playwright 한계 — 수동 체크리스트), eval 태스크에 모바일 시나리오 추가.

## Scope

- **IN**: apps/web 모바일 셸/화면 전부, App.tsx 라우트 분기, PRD 문서 개정(M4), CI/e2e 게이트,
  fr-matrix 재분류. 서버 변경은 원칙적으로 없음(읽음 ACK·검색·타이핑 모두 기존 API 재사용).
- **OUT (Non-goals)**: 음성/영상(qf-m-voice는 DS에만 존재 — 구현 금지, 방향 피벗 메모리 준수),
  네이티브 앱/푸시 인프라 신설(Web Push 토글은 M4에서 문서화만), DS 4파일 수정(전부 앱 레이어
  에서 해결 — 단 H-1 백드롭 구조는 DS '의도'를 따르는 앱 측 수정), 데스크톱 UI 변경(상태 시트
  연결 등 모바일 작업의 자연 부산물 제외).

## Acceptance Criteria (기계 검증)

1. `e2e/mobile/*` 전부 green + CI 필수 체크 등록 (M0 이후 상시).
2. tour3 진단 재실행 시: 시트/드로어 hit-test intercepted=false, 실제 탭으로 답장 배너 표시,
   채널 진입 `scrollTop+clientHeight==scrollHeight`, 컴포저 boundingBox가 뷰포트 내, rail y<20,
   `/dm`·`/discover`·Activity에 세로 글자/UUID 표기 없음.
3. 모바일에서 채널 열람 후 해당 채널 미읽음 카운트 0 (e2e).
4. vr-parity baseline 시드 + `--project=chromium` green.
5. M4 후: PRD 내 탭바 정의 단일화(목업 포함), fr-matrix에서 모바일 미충족 done 0건.
6. 각 슬라이스 `pnpm verify` green (standalone, shared-types test 포함).

## Risks

- **표면이 큼**: M1~M3는 각각 다시 2~4개 PR로 쪼개 진행(한 번에 한 모듈 원칙). M0만 단일 PR.
- **M0의 z-스택 수정**이 데스크톱 공유 컴포넌트(ToastViewport 위치 등)와 간섭할 수 있음 —
  visual-regression-scanner 필수 호출.
- **내비 모델 변경(M2)**은 기존 모바일 e2e 다수를 함께 갱신해야 함(테스트가 ?chat= 쿼리 모델에
  결합) — 스펙 갱신을 같은 PR에 포함.
- NAS 자원: e2e 스택+verify 컨테이너 동시 구동 금지(기존 메모리 준수), 슬라이스당 순차 실행.
- PRD 개정(M4)은 구현(M2)과 순서 의존 — 탭바 결정이 선행되어야 양쪽이 같은 기준을 갖는다.

## DoD

체크리스트 green + `pnpm verify` 로그 + e2e mobile green 로그 + 감사 문서의 H/A 항목별 해소
체크 표를 각 슬라이스 PR.md에 첨부.
