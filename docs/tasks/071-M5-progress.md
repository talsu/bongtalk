# 071-M5 진행 상황 (세션 핸드오프 문서)

> 단일 진실원. 계획 전문: `docs/tasks/071-mobile-uiux-overhaul.md` M5 절,
> 감사 근거: `docs/audits/2026-06-10-mobile-uiux-audit.md` A(20·30·34)/B(40·44·45·51~77)/H-11.
> 규약·검증·배포는 M0~M4 와 동일 — GitHub push-only, 게이트는 로컬(전체 모바일 e2e +
> standalone verify + 적대 리뷰 fix-forward), 배포는 main 체크아웃에서 수동 auto-deploy.sh.
> 브랜치: feat/071-m5-ds-polish (develop 6350680 기점).
> ★DS 4파일(apps/web/public/design-system) 절대 수정 금지 — 전부 앱 레이어 채택.

## 범위 (071 M5 절 — DS 채택 마무리 + 폴리시)

시트 등장 모션 토큰(--m-sheet-ease/dur)+grab 드래그 닫기, 스와이프 답장 임계 60px+
qf-m-swipe 힌트, 더블탭 quick-react 토스트(qf-m-react-toast), 당겨서 새로고침(qf-m-ptr),
홈 퀵타일(qf-m-tile-row — ★M2 에서 홈 폐기됨: 재해석 필요), compact 밀도, 24시간제·
폰트 크기 설정 반영, i18n 잔재 정리("loading…"/"Activity"/"All"/"모든"→"전체"),
시트 포커스 트랩+자동 포커스(a11y), raw 값 정리(드로어 360px·--n-5 직참조·50vh 등),
가로 모드 정책 결정, 친구 삭제 confirm, 워드마크 겹침 수정.

## 청크 상태 (H1 정찰: 미해소 44·부분 22·재해석 10·기해소 31 — 기해소 재등재 금지)

| 청크 | 내용                                                                                                                                                                       | 상태 | 커밋 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| H1   | (정찰) 6영역 Workflow + 비평 — 21청크 분해·결정 2건·제외 목록                                                                                                              | done | 정찰 |
| S1   | a11y 묶음: H3 useSheetFocusTrap 추출+spec → H4 트랩 7표면+marker 6곳 → H5 친구 삭제/차단 confirm(양 플랫폼) → H6 MobilePanels 포커스                                       | todo |      |
| S2   | MobileMessages 묶음: H2 스와이프 60px+qf-m-swipe 힌트 → H10 DM placeholder(양 플랫폼) → H12 clock24h → H16 첫 미읽 pill → H17a thread chip dot → H20 더블탭 👍+react-toast | todo |      |
| S3   | 시트 폴리시: H7 등장 모션(앱 CSS·enter-only) → H8 grab 드래그 닫기(useSheetDragDismiss) → H11 raw 값 3건 → H13 compact 모바일 CSS                                          | todo |      |
| S4   | 분산 소항목: H9 i18n 일괄 → H14 워드마크(진단 선행) → H17b 타임아웃 라벨 → H18 레일/DM 뱃지 → H21 PTR(인박스 한정)                                                         | todo |      |
| S5   | H15 생성 모달 모바일 풀스크린 + H19 Ban 진입(재실측 선행) + H22 가로 모드 A안 문서화                                                                                       | todo |      |
| S6   | 게이트: 전체 모바일 e2e(+신규 단언)+standalone verify+적대 리뷰 fix-forward                                                                                                | todo |      |
| S7   | develop 머지(ls-remote)→main 승격→수동 배포→/readyz→REPORT                                                                                                                 | todo |      |

★확정 결정: H20 더블탭 기본 이모지=👍 고정(DS mock) · H22 가로 모드=A안(유지+문서화).
★제외(별도 슬라이스/백로그 — 정찰 excluded 절): 검색 보강(S01/02/06/08/11/12)·커스텀
상태(P04/P17/PS-05)·탭바 배지(B-45+PRD 동기 개정)·알림 레벨 UI(B-44 — 서버/훅 기존재,
'서버 필요' 오판 주의)·읽음 ACK 정밀화(RS-02+B-64)·lastSeen 소슬라이스(★스키마 기존재 —
'Prisma 부재' 주장은 오판)·저장 점프/스레드 Undo(서버 필요)·chatFontSize(DS frozen 보류)·
홈 퀵타일(공식 폐기 — 5탭 분산 기해소)·401 race(M6)·리마인더 시트 변형(여력 시 S 동승).
★순서 고정: 시트 파일 공유 → S1(H4) 후 S3(H7→H11), MobileMessages 터치 블록 → S2 내
H2 선행 후 H20.

## 세션 진행 노트 (M5)

- (착수) M4 종결(main fc291aa · 배포 exit 0 · readyz ok) 직후. H1 정찰 가동.
- S1~S5 완료(67ab495) — m5-implement Workflow(순차 5스테이지, 1차 실행은 세션
  리밋 중단 → 부분 적용 재개): 트랩/마커/confirm/모션/드래그/더블탭/PTR/i18n/
  풀스크린 모달/뱃지/정책 21청크. lint 신규 위반 5건 에이전트 자가 수정.
- S6 완료(27363c9·fb4ab59·4804ad5) — ①e2e 가 시트→드로어 마커 레이스 실회귀
  적발 → transitionSheetMarker 핸드셰이크 신설+3곳(MobileMessages) ②적대 리뷰
  (7각도, 27건 통과·기각 0, 상위 12 CONFIRMED) fix-forward: grab 44px 히트영역
  (4px 스트립 — 실기기 기능 사장), 서버 메뉴→오버레이/설정/둘러보기/새 DM 마커
  레이스 4+1곳, browseOpen 마커 누락, 트랩 Esc IME 가드, fling stale 100ms,
  더블탭 자식 버블 제외, 데스크톱 차단 confirm, confirm 등장 300ms 가드,
  스와이프 수직 동결 리셋 ③retries 1 도입(M6 선취 — NAS 풀스위트 부하 flake
  게이트 안정화, 단독·직렬 항상 green 실측). 최종 풀스위트 45/45.
  ★우패널 미스터리: 병렬 실패 스크린샷에 스펙이 안 연 우패널 — 단독/스로틀
  8x 재현 불가, M6 입력(trace 기반 정밀 추적 과제).
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
