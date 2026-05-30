# Task 053 — PRD 다팀 리뷰 사이클 (최대 5회)

## Context

실리콘밸리 메시징 앱 회사를 가정, 여러 팀이 PRD(`/prd/`)를 리뷰 → 피드백 →
수정 → 버전업 → 재리뷰를 **피드백 소진 시 또는 최대 5회** 반복. 사이클마다 운영 반영.

## 리뷰 패널 (7팀)

PM(제품/기획) · UX 디자인 · 프론트엔드 · 백엔드 · 실시간/인프라 · 보안/프라이버시 · QA.

## 사이클 구조 (iteration 당 1 워크플로)

1. **Review (병렬 7)**: 각 팀이 현 PRD 섹션 텍스트(`/tmp/prdtxt/*.txt`)를 자기 렌즈로
   리뷰 → findings(severity blocker/high/med/low · section · type gap/error/inconsistency/improvement/risk).
2. **Synthesize (1, opus)**: 종합·중복제거·우선순위 → 이번 버전 change-set(섹션별 지시) +
   changelog + converged 판정 + 카운트.
3. **Apply (병렬, 영향 섹션)**: 각 섹션을 지시대로 재집필(현 HTML + DS vocab 준수) → 갱신 HTML.
4. (메인) 조립 → 버전 bump + Changelog 갱신 → 검증(구조/토큰/아이콘) → 스냅샷 → 커밋 → **배포**.
5. 수렴(blocker/high 0 & 실질 개선 없음) 또는 5회 → 종료.

## 산출물

- 사이클마다 `prd/index.html` 버전업(v1, v2, …) + Changelog 페이지 누적.
- 각 사이클 운영 반영(main 머지 → webhook 배포, /prd/ 라이브).

## DoD

- [ ] 최대 5 iteration, 각 사이클 배포 + /prd/ 200
- [ ] Changelog에 사이클별 반영 내역
- [ ] 수렴 또는 5회 도달 시 종료 사유 기록

## Note

리뷰 입력은 매 사이클 현 PRD에서 재추출(누적 반영 반영). overview 페이지는 vision이라
리뷰 비중 낮음. 관련: [[reference_prd_page]].
