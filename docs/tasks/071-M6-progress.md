# 071-M6 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획: `docs/tasks/071-mobile-uiux-overhaul.md` M6 절. 규약·검증·배포는
> M0~M5 와 동일. 브랜치: feat/071-m6-verification (develop 1529340 기점).
> 071 마지막 슬라이스 — 완료 시 071 전체 종결 REPORT.

## 범위 (071 M6 절 — 검증 인프라 상시화)

모바일 e2e 신규 커버(읽음 ACK·시트 액션·점프·검색·상태 시트 — M0~M5 가 대부분 커버,
갭만), axe-core 모바일 표면(탭바·패널·시트·풀스크린 모달 — NFR-9 M4 개정 정합),
vr baseline 4뷰포트(현 2: se/14 → +XR/태블릿), 키보드 dodge 수동 체크리스트 문서화,
eval 태스크 모바일 시나리오. + M5 이월: 우패널 미스터리 추적(1회 시도), M5 신규
표면 e2e(드래그 닫기/더블탭/PTR/confirm).

## 청크 상태

| 청크 | 내용                                                             | 상태                                     | 커밋 |
| ---- | ---------------------------------------------------------------- | ---------------------------------------- | ---- |
| T1   | e2e 갭 커버: M5 표면(confirm/더블탭/PTR/드래그)+읽음 ACK 잔여    | todo                                     |      |
| T2   | axe-core 모바일 스윕 e2e(390×844 — 탭바/패널/시트/풀스크린 모달) | todo                                     |      |
| T3   | vr baseline 4뷰포트 확장 + 키보드 dodge 수동 체크리스트 문서     | todo                                     |      |
| T4   | eval 태스크 모바일 시나리오 + 우패널 미스터리 1회 추적           | done(미커밋 — 실행검증은 오케스트레이터) |      |
| T5   | 게이트: 풀스위트+verify+적대 리뷰 fix-forward                    | todo                                     |      |
| T6   | 머지→main→배포→/readyz→071 전체 종결 REPORT                      | todo                                     |      |

## 우패널 미스터리 (T4② — 1회 추적: 정적 전수 재추적 + 가설)

증상(M5 S6 이월): 병렬 풀스위트에서만 touch-target-size / long-press-sheet 실패
스크린샷에 **스펙이 열지 않은 우패널**이 보임. 단독·스로틀 8x 재현 불가.

### setPanel('right') 도달 경로 전수 (정적 재추적)

| #   | 경로                                   | 위치                         | 이 두 스펙에서 도달 가능?                                                                                                                                                          |
| --- | -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | topbar members 버튼 onClick            | MobileShell.tsx:366          | 불가 — 스펙 클릭 대상(menu/채널/입력/전송)과 공간 분리, Playwright click 은 hit-point 재검증                                                                                       |
| 2   | 엣지 제스처 commit(onOpenChange)       | MobilePanels.tsx:139→211→124 | 불가 — touchstart x≥w−24 + touchmove(h-lock) + touchend 전부 필요. 두 스펙의 합성 터치는 dispatchLongPress 의 **touchstart 단발(행 중앙 좌표)** 뿐 — endDrag 자체가 실행될 수 없음 |
| 3   | fling commit(vx<−500)                  | MobilePanels.tsx:198~201     | 불가 — vx 는 touchmove 에서만 갱신                                                                                                                                                 |
| 4   | open==='right' 재드래그 원복           | MobilePanels.tsx:137         | 불가 — 선행 'right' 필요(순환)                                                                                                                                                     |
| 5   | popstate onPop                         | MobilePanels.tsx:258         | 'center' 만 set                                                                                                                                                                    |
| 6   | scrim/onPick/onBrowse/라우트 effect 등 | MobileShell 전반             | 전부 'center'                                                                                                                                                                      |
| 7   | H6 포커스 복귀 effect                  | MobilePanels.tsx:231~243     | setPanel 호출 없음(포커스만 이동). 이 두 스펙의 캡처/복귀 대상은 topbar menu 버튼 — 센터가 +드로어폭 이동 중에도 viewport 안(x≈302..346<375)이라 스크롤 유발도 없음                |

★결론: 이 두 스펙의 입력 시퀀스로는 **state-레벨 open==='right' 도달 경로가
정적으로 존재하지 않는다.** 스크린샷의 우패널은 state('right')가 아니라 **시각적
표류**일 가능성이 높다(failure 의 직접 원인인 시트 미출현은 기왕에 규명된
dispatch 증발 — 우패널은 같은 부하의 동시 증상일 수 있음).

### 가설 후보 (우선순위순 — 추측 수정 금지, 확증 전 코드 미수정)

- **가설 A (유력) — `.qf-m-panels` scrollLeft 표류**: `.qf-m-panels` 는
  `overflow:hidden`(mobile.css 421) — 프로그램적 스크롤은 허용되는 스크롤
  컨테이너다. 좌패널 열림 중 center 는 +드로어폭으로 이동해 컨테이너 우측 밖
  (x 375..677)에 스크롤러블 오버플로를 만들고, 닫힌 우패널(translateX(100%))의
  시각 위치도 같은 영역이다. 채널픽 직후 **close 트랜지션(300ms + NAS jank 로
  연장) 중** Playwright fill/click 의 scroll-into-view 또는 focus() 기본
  스크롤(preventScroll 미지정 — useSheetFocusTrap.ts 55/60/85/91, MobilePanels
  H6 242)이 발생하면 Chromium 이 컨테이너 scrollLeft 를 올려 이동 중인 center
  내부 요소(msg-input 은 x≈310..632 로 대부분 화면 밖)를 노출시키는데,
  **scrollLeft 는 이후 아무도 리셋하지 않는다**(트랜지션은 transform 만 되돌림).
  결과: `data-open='center'`·`--show-right` 부재인데 viewport 가 x≈300.. 영역
  (= 닫힌 우패널의 transform 위치)을 비춤 — '스펙이 안 연 우패널' 스크린샷과
  정확히 합치. **부하 의존성**: 단독에선 액션 도달 시점에 트랜지션이 이미 종료
  (+ click 의 stability 체크 정상 동작)라 윈도가 닫혀 있고, 병렬에선 rAF 정지로
  stability 체크가 이동 중 좌표를 '안정' 오판 + 트랜지션이 늘어져 윈도 확대.
  판별 신호: 실패 시점 `mobile-panels` 의 `scrollLeft > 0 && data-open==='center'`.
- **가설 B — DS stylesheet 미적용(FOUC)**: index.html 의 /design-system/\*.css
  link 4개 중 mobile.css 가 부하로 지연/실패하면 `.qf-m-panel-right` 의
  absolute/transform 이 없어져 우패널(DOM 마지막 자식)이 normal flow 로 노출.
  touch-target offender 폭증·롱프레스 셀렉터 실패와도 정합. 판별: trace 네트워크
  의 mobile.css 응답 + 스크린샷 전반의 unstyled 여부(화면이 '정상 스타일 +
  우패널만 열림' 모양이면 기각).
- **가설 C (이 두 스펙에선 기각 — 잠복 위험으로만 기록)** — 엣지판정 w=0:
  MobilePanels.tsx:133 `rootRef.current?.clientWidth ?? window.innerWidth` 는
  clientWidth **0 을 걸러내지 못한다**(0 은 nullish 아님). 레이아웃 전 0 이면
  `clientX >= w−24` 가 항상 참 → 행 중앙 합성 touchstart 도 target='right' 로
  무장. 단 commit 은 touchmove+touchend 가 필요해 이 두 스펙에선 발화 불가 —
  panels/swipe 계열 스펙에서만 의미 있는 잠복 위험.

### 재현 프로브 개선안 (1건 — `.tour/probe-right-mystery.mjs` 신설)

종전 재현 실패(단독/스로틀 8x)와의 차이: ①CDP `Emulation.setCPUThrottlingRate`
로 병렬 부하를 단독 재현 ②채널픽→fill 사이 **무대기** 시퀀스로 레이스 윈도
정조준 ③data-open 이 아니라 **scrollLeft(캡처 단계 scroll 리스너 전수 수집)·
right transform·mobile.css 적용 여부·clientWidth** 를 관측해 A/B/C 를 즉석 판별.
사용: e2e 컨테이너에서 `node /work/.tour/probe-right-mystery.mjs [cpuRate=8]
[attempts=5]` — A/B 재현 시 `.tour/shots/right-mystery-*.png` 자동 보존.

### 확증 시 수정 후보 (기록만 — 미적용)

- 가설 A 확증 시: 라우트/패널 effect 에서 `rootRef.current.scrollLeft = 0` 리셋
  가드, 또는 focus() 호출 전부 `{ preventScroll: true }` (DS 4파일 무수정 —
  앱 레이어만).
- 가설 B 확증 시: e2e 스택 정적 서버/리소스 우선순위 점검(앱 코드 무관).

## 세션 진행 노트 (M6)

- (착수) M5 종결(main dabf673 · 배포 exit 0 · readyz ok) 직후.
- T4 완료(미커밋) — ①eval 태스크 `evals/tasks/061-mobile-reachability.yaml`
  신설(run.ts tiny-parser 스키마 검증 OK — dod 는 단일 command 만 소화됨을
  주석으로 봉인) ②우패널 미스터리 1회 추적: setPanel('right') 도달 경로 7종
  전수 정적 재추적 → 이 두 스펙에선 state-레벨 도달 불가 확인, 가설 A(scrollLeft
  표류)/B(FOUC)/C(w=0 잠복) 수립 + 판별 프로브 `.tour/probe-right-mystery.mjs`
  신설(위 절). 코드 수정 없음(확증 전 — 추측 수정 금지 준수).
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
