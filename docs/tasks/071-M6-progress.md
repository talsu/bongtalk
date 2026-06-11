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

| 청크 | 내용                                                             | 상태 | 커밋 |
| ---- | ---------------------------------------------------------------- | ---- | ---- |
| T1   | e2e 갭 커버: M5 표면(confirm/더블탭/PTR/드래그)+읽음 ACK 잔여    | todo |      |
| T2   | axe-core 모바일 스윕 e2e(390×844 — 탭바/패널/시트/풀스크린 모달) | todo |      |
| T3   | vr baseline 4뷰포트 확장 + 키보드 dodge 수동 체크리스트 문서     | todo |      |
| T4   | eval 태스크 모바일 시나리오 + 우패널 미스터리 1회 추적           | todo |      |
| T5   | 게이트: 풀스위트+verify+적대 리뷰 fix-forward                    | todo |      |
| T6   | 머지→main→배포→/readyz→071 전체 종결 REPORT                      | todo |      |

## 세션 진행 노트 (M6)

- (착수) M5 종결(main dabf673 · 배포 exit 0 · readyz ok) 직후.
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
