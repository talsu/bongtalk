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

## 청크 상태

| 청크 | 내용                                                    | 상태 | 커밋 |
| ---- | ------------------------------------------------------- | ---- | ---- |
| H1   | (정찰) 6영역 Workflow + 비평 — 항목별 현황·채택 지점 맵 | 진행 |      |
| H2~  | (정찰 후 분해)                                          | todo |      |

## 세션 진행 노트 (M5)

- (착수) M4 종결(main fc291aa · 배포 exit 0 · readyz ok) 직후. H1 정찰 가동.
- 서브에이전트 브리프 필수 문구: "읽기 전용 — git checkout/branch 전환 금지" +
  "머지/배포/prod 접근 금지".
