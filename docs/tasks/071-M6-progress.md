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

| 청크 | 내용                                                                 | 상태 | 커밋            |
| ---- | -------------------------------------------------------------------- | ---- | --------------- |
| T1   | e2e 갭 커버: M5 표면(confirm/더블탭/PTR/드래그)+서버메뉴 회귀 가드   | done | 88dfb9d         |
| T2   | axe-core 모바일 스윕 e2e(5표면) — 실위반 적발→수리 포함              | done | 88dfb9d+84cbe7b |
| T3   | vr baseline 4뷰포트(+시드 cf2bb55) + 수동 체크리스트                 | done | 88dfb9d         |
| T4   | eval 모바일 시나리오 + 우패널 미스터리 — ★규명·봉인됨(아래 절)       | done | 88dfb9d+e47f42a |
| T5   | 게이트: 풀스위트 53/53 ×2(flaky 0)+verify+적대 리뷰 10건 fix-forward | done | 326a7b7         |
| T6   | 머지→main→배포→/readyz→071 전체 종결 REPORT                          | 진행 |                 |

## 우패널 미스터리 — ★규명·봉인 완료 (e47f42a)

- 정체: M5 H6 의 패널 포커스 복귀 `focus()` 가 transform 전환과 경합하면
  `overflow:hidden` 루트(.qf-m-panels)에 **scrollLeft +240 잔류** → center 가
  화면 밖으로 밀려 '우패널이 열린' 화면 + 메시지 행 좌표 음수 → 롱프레스
  엣지 양보(≤24px)가 시트 오픈을 스킵. 프로브 실측(row left=-232 ·
  panels children rect 덤프)으로 확정 — M3~M6 풀스위트 flake 의 주범.
- 수리: H6 focus 2곳 `preventScroll` + 루트 scrollLeft 0 강제 가드(이중 방어)
  - 시트 마커 onPop qfPanel 가드(지연 back 오소비 — 정상 계층 정밀화 포함,
    M6 리뷰 H-1) + dispatchLongPress ensureVisible 재시도 + retries:1.
- 결과: 풀스위트 53/53 ×2 연속, flaky 0 (종전: 매 실행 1~2건 무작위 실패).

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
